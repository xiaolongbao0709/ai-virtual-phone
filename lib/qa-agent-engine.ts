import {
    buildProviderRequest,
    parseProviderResponse,
    parseProviderStreamDelta,
    stripHallucinatedTimestamps,
    type LlmRequestMessage,
    type LlmRequestPayload,
} from "./llm-provider-adapter";
import { loadApiConfigs, loadBindingConfig } from "./settings-storage";
import type { ApiConfig } from "./settings-types";
import { buildQaSystemPrompt } from "./qa-knowledge";
import { parseToolCalls } from "./tool-executor";
import { buildQaToolsPrompt, runQaToolCall, type QaProposedCommit } from "./qa-agent-tools";

// ── 答疑引擎（P0：知识问答，无工具）──────────────────
// 流式 + 失败降级非流式的双路径，模式与小卷（mascot-engine）一致。

export type QaEngineMessage = {
    role: "user" | "assistant";
    content: string;
};

export type QaStreamCallbacks = {
    onDelta?: (text: string) => void | Promise<void>;
    onReasoningDelta?: (text: string) => void | Promise<void>;
    onStreamFallback?: (reason: string) => void | Promise<void>;
};

export function resolveQaApiConfig(): ApiConfig | null {
    const binding = loadBindingConfig();
    const apiConfigs = loadApiConfigs();
    const globalId = binding.globalDefaults.apiConfigId;
    if (globalId) {
        const found = apiConfigs.find((c) => c.id === globalId);
        if (found) return found;
    }
    return apiConfigs[0] ?? null;
}

function requireQaApiConfig(): ApiConfig {
    const config = resolveQaApiConfig();
    if (!config) {
        throw new Error("还没有可用的 API 配置。请先到「设置 → API 设置」添加 LLM API（Base URL + API Key），再回来提问。");
    }
    return config;
}

export function formatQaErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function parseSseEvents(buffer: string): { events: string[]; rest: string } {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n\n");
    return {
        events: parts.slice(0, -1),
        rest: parts[parts.length - 1] || "",
    };
}

async function streamQaProviderRequest(
    request: LlmRequestPayload,
    options?: { signal?: AbortSignal },
    callbacks?: QaStreamCallbacks,
): Promise<{ content: string; reasoning: string }> {
    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const abortHandler = () => llmAbort.abort();
    if (options?.signal) {
        if (options.signal.aborted) llmAbort.abort();
        else options.signal.addEventListener("abort", abortHandler);
    }

    let content = "";
    let reasoning = "";

    try {
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: llmAbort.signal,
        });
        if (!response.ok) throw new Error(`API Stream ${response.status}: ${await response.text()}`);
        if (!response.body) throw new Error("流式响应没有 body。");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handleEvent = async (eventText: string) => {
            const dataLines = eventText
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim());
            for (const dataLine of dataLines) {
                if (!dataLine || dataLine === "[DONE]") continue;
                try {
                    const parsed = JSON.parse(dataLine) as unknown;
                    const delta = parseProviderStreamDelta(request.providerKind, parsed);
                    if (delta.reasoning) {
                        reasoning += delta.reasoning;
                        await callbacks?.onReasoningDelta?.(delta.reasoning);
                    }
                    if (delta.content) {
                        content += delta.content;
                        const visibleDelta = stripHallucinatedTimestamps(delta.content);
                        if (visibleDelta) await callbacks?.onDelta?.(visibleDelta);
                    }
                } catch {
                    // Ignore relay keepalive / non-JSON chunks.
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseEvents(buffer);
            buffer = parsed.rest;
            for (const eventText of parsed.events) {
                await handleEvent(eventText);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) await handleEvent(buffer);

        return { content: stripHallucinatedTimestamps(content), reasoning };
    } finally {
        clearTimeout(llmTimeout);
        if (options?.signal) options.signal.removeEventListener("abort", abortHandler);
    }
}

function historyToRequestMessages(history: QaEngineMessage[]): LlmRequestMessage[] {
    return history.map((msg) =>
        msg.role === "user"
            ? { role: "user" as const, content: msg.content }
            : { role: "assistant" as const, content: msg.content },
    );
}

// ── 流式显示过滤：隐藏 [执行动作:…] 指令与 <think> 块 ──

type QaVisibleSink = (text: string) => void | Promise<void>;

const QA_DIRECTIVE_START = /\[[^\[\]\n]{0,60}?(?:执行动作|工具调用|获取指令)/;
const QA_THINK_START = /<\s*(?:think|thinking)\b/i;
const QA_THINK_END = /<\/\s*(?:think|thinking)\s*>/i;

function createQaStreamFilter(sink: QaVisibleSink) {
    let buffer = "";

    const findStart = (text: string): number => {
        const directive = QA_DIRECTIVE_START.exec(text);
        const think = QA_THINK_START.exec(text);
        const indexes = [directive?.index, think?.index].filter((v): v is number => typeof v === "number");
        return indexes.length ? Math.min(...indexes) : -1;
    };

    const findEnd = (text: string, start: number): number | null => {
        if (QA_THINK_START.test(text.slice(start, start + 12))) {
            const match = QA_THINK_END.exec(text.slice(start));
            return match ? start + match.index + match[0].length : null;
        }
        const rest = text.slice(start);
        const match = /[)）]\s*\]/.exec(rest);
        if (match) return start + match.index + match[0].length;
        return rest.length > 4000 ? start + rest.length : null; // 超长放弃等待，整段按指令丢弃
    };

    // 尾部可能是尚未流完的指令/标签前缀，暂扣不显示
    const tailHoldIndex = (text: string): number => {
        const bracket = text.lastIndexOf("[");
        if (bracket !== -1 && !text.slice(bracket).includes("]") && text.length - bracket < 120) return bracket;
        const angle = text.lastIndexOf("<");
        if (angle !== -1 && !text.slice(angle).includes(">") && text.length - angle < 15) return angle;
        return text.length;
    };

    const drain = async (final: boolean) => {
        let out = "";
        let work = buffer;
        for (;;) {
            const start = findStart(work);
            if (start === -1) break;
            const end = findEnd(work, start);
            if (end == null) {
                out += work.slice(0, start);
                buffer = final ? "" : work.slice(start);
                if (out) await sink(out);
                return;
            }
            out += work.slice(0, start);
            work = work.slice(end);
        }
        if (final) {
            out += work;
            buffer = "";
        } else {
            const hold = tailHoldIndex(work);
            out += work.slice(0, hold);
            buffer = work.slice(hold);
        }
        if (out) await sink(out);
    };

    return {
        async push(text: string) {
            buffer += text;
            await drain(false);
        },
        async flush() {
            await drain(true);
        },
    };
}

function stripThinkBlocks(text: string): string {
    return text.replace(/<\s*(?:think|thinking)\b[\s\S]*?<\/\s*(?:think|thinking)\s*>/gi, "").trim();
}

/** 单次补全：流式优先，流式失败（非用户中断）自动降级为非流式重试。 */
async function requestQaCompletion(
    apiConfig: ApiConfig,
    messages: LlmRequestMessage[],
    options?: { signal?: AbortSignal; callbacks?: QaStreamCallbacks },
): Promise<{ content: string; reasoning: string }> {
    try {
        const streamRequest = buildProviderRequest(apiConfig, null, messages, { stream: true });
        const result = await streamQaProviderRequest(streamRequest, { signal: options?.signal }, options?.callbacks);
        if (!result.content.trim()) throw new Error("LLM 返回了空内容");
        return result;
    } catch (streamError) {
        if (options?.signal?.aborted) throw streamError;
        await options?.callbacks?.onStreamFallback?.(formatQaErrorMessage(streamError));
        const request = buildProviderRequest(apiConfig, null, messages);
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: options?.signal,
        });
        if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
        const parsed = parseProviderResponse(request.providerKind, await response.json());
        const content = stripHallucinatedTimestamps(parsed.content || "").trim();
        if (!content) throw new Error("LLM 返回了空内容");
        const visible = stripThinkBlocks(content);
        if (visible) await options?.callbacks?.onDelta?.(visible);
        return { content, reasoning: parsed.reasoning || "" };
    }
}

/** 单轮问答（无工具），保留给简单场景。 */
export async function callQaChat(
    history: QaEngineMessage[],
    options?: { signal?: AbortSignal; callbacks?: QaStreamCallbacks },
): Promise<{ content: string; reasoning: string }> {
    const apiConfig = requireQaApiConfig();
    const latestUser = [...history].reverse().find((m) => m.role === "user");
    const messages: LlmRequestMessage[] = [
        { role: "system", content: buildQaSystemPrompt(latestUser?.content ?? "") },
        ...historyToRequestMessages(history),
    ];
    return requestQaCompletion(apiConfig, messages, options);
}

// ── Agent 循环（P1：诊断工具）─────────────────────────

export type QaAgentCallbacks = {
    /** 过滤后的可见文本增量（工具指令与思考块已隐藏） */
    onDelta?: (text: string) => void | Promise<void>;
    onReasoningDelta?: (text: string) => void | Promise<void>;
    onStreamFallback?: (reason: string) => void | Promise<void>;
    onToolStart?: (name: string) => void | Promise<void>;
    onToolDone?: (name: string, success: boolean) => void | Promise<void>;
    /** 确认模式下写工具生成提案时回调（由 store 存到消息上供 UI 确认）。 */
    onStageCommit?: (proposal: QaProposedCommit) => void;
};

const QA_MAX_ROUNDS = 5;

/**
 * 工坊 agent 主循环：模型可通过 [执行动作:工具名({…})] 调用诊断工具，
 * 工具结果回填后继续下一轮，直到无工具调用或轮数用尽。
 */
export async function callQaAgent(
    history: QaEngineMessage[],
    options?: { signal?: AbortSignal; callbacks?: QaAgentCallbacks; autoCommit?: boolean },
): Promise<void> {
    const apiConfig = requireQaApiConfig();
    const callbacks = options?.callbacks;
    const latestUser = [...history].reverse().find((m) => m.role === "user");
    const systemPrompt = `${buildQaSystemPrompt(latestUser?.content ?? "")}\n\n${buildQaToolsPrompt()}`;
    const working: LlmRequestMessage[] = historyToRequestMessages(history);

    let emittedAny = false;
    for (let round = 0; round < QA_MAX_ROUNDS; round++) {
        let pendingBreak = emittedAny;
        const filter = createQaStreamFilter(async (text) => {
            if (pendingBreak && text.trim()) {
                pendingBreak = false;
                await callbacks?.onDelta?.("\n\n");
            }
            if (text.trim()) emittedAny = true;
            await callbacks?.onDelta?.(text);
        });

        const messages: LlmRequestMessage[] = [{ role: "system", content: systemPrompt }, ...working];
        const result = await requestQaCompletion(apiConfig, messages, {
            signal: options?.signal,
            callbacks: {
                onDelta: (delta) => filter.push(delta),
                onReasoningDelta: callbacks?.onReasoningDelta,
                onStreamFallback: callbacks?.onStreamFallback,
            },
        });
        await filter.flush();

        const { toolCalls } = parseToolCalls(stripThinkBlocks(result.content));
        if (toolCalls.length === 0) return;
        if (round === QA_MAX_ROUNDS - 1) return; // 轮数用尽，不再执行工具

        working.push({ role: "assistant", content: result.content });
        const resultBlocks: string[] = [];
        for (const call of toolCalls) {
            if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
            await callbacks?.onToolStart?.(call.name);
            const toolResult = await runQaToolCall(call, {
                signal: options?.signal,
                autoCommit: options?.autoCommit,
                onStageCommit: callbacks?.onStageCommit,
            });
            await callbacks?.onToolDone?.(call.name, toolResult.success);
            resultBlocks.push(`【${toolResult.name}】${toolResult.success ? "" : "（失败）"}\n${toolResult.resultForModel}`);
        }
        working.push({
            role: "user",
            content: `[系统工具结果，用户不可见]\n${resultBlocks.join("\n\n")}\n\n请基于以上结果继续回答用户的问题。`,
        });
    }
}
