import {
    buildProviderRequest,
    nativeToolProtocolForConfig,
    parseProviderResponse,
    parseProviderStreamDelta,
    stripHallucinatedTimestamps,
    type LlmRequestMessage,
    type LlmRequestPayload,
    type LlmToolCall,
} from "./llm-provider-adapter";
import { sendLLMToolStreamRequest, type LLMToolRequestResult } from "./chat-engine";
import type { LLMContentPart } from "./llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig } from "./settings-storage";
import type { ApiConfig } from "./settings-types";
import { buildQaSystemPrompt } from "./qa-knowledge";
import { getQaMaxRounds } from "./qa-prefs";
import { parseToolCalls } from "./tool-executor";
import {
    buildQaNativeNameMap,
    buildQaToolsPrompt,
    getQaNativeToolDefinitions,
    runQaToolCall,
    type QaCreatedContent,
    type QaProposedCommit,
} from "./qa-agent-tools";

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
    // 优先级：配置绑定「工坊 API」→ 全局默认 → 列表第一个
    const qaId = binding.qaApiConfigId;
    if (qaId) {
        const found = apiConfigs.find((c) => c.id === qaId);
        if (found) return found;
    }
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

// 流式空闲看门狗：超过该时长没有收到任何字节就中断流式、转非流式重试。
// 常见诱因是中转站/代理开了响应缓冲——流式表现为"停住几分钟后一口气全出"。
// 可用 localStorage 键 ai_phone_qa_stream_idle_ms 覆盖（调参/测试用）。
function qaStreamIdleMs(): number {
    try {
        const raw = Number(localStorage.getItem("ai_phone_qa_stream_idle_ms"));
        if (Number.isFinite(raw) && raw >= 1_000 && raw <= 600_000) return Math.floor(raw);
    } catch {
        // ignore
    }
    return 90_000;
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
    const idleMs = qaStreamIdleMs();
    let lastByteAt = Date.now();
    let idleAborted = false;
    const idleTimer = setInterval(() => {
        if (Date.now() - lastByteAt > idleMs) {
            idleAborted = true;
            llmAbort.abort();
        }
    }, 2_000);

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
            lastByteAt = Date.now();
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
    } catch (error) {
        if (idleAborted && !options?.signal?.aborted) {
            throw new Error(`流式响应停滞超过 ${Math.round(idleMs / 1000)} 秒（常见于中转站开了响应缓冲），已中断并改用非流式重取`);
        }
        throw error;
    } finally {
        clearInterval(idleTimer);
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

function createQaStreamFilter(sink: QaVisibleSink, onHolding?: (holding: boolean) => void | Promise<void>) {
    let buffer = "";
    let holding = false;

    const setHolding = async (next: boolean) => {
        if (holding === next) return;
        holding = next;
        await onHolding?.(next);
    };

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
                // 正在缓冲一段未收尾的指令（如大段安装调用）：告知 UI 显示"编写工具调用中"，
                // 否则长时间无可见增量会被误认为卡住
                await setHolding(!final && buffer.length > 60);
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
        await setHolding(false);
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
    onToolStart?: (name: string, args?: Record<string, unknown>) => void | Promise<void>;
    onToolDone?: (name: string, success: boolean, result?: string) => void | Promise<void>;
    /** 确认模式下写工具生成提案时回调（由 store 存到消息上供 UI 确认）。 */
    onStageCommit?: (proposal: QaProposedCommit) => void;
    /** 全自动模式下由 store 立即执行提交，保证同轮后续工具看到已落地的提交。 */
    commitNow?: (proposal: QaProposedCommit) => Promise<{ ok: boolean; htmlUrl?: string; error?: string }>;
    /** 内容工具安装/更新本机内容后回调（store 记到会话上，供工坊内预览）。 */
    onContentCreated?: (item: QaCreatedContent) => void;
    /** 流过滤器正在缓冲一段长指令（无可见增量）：UI 据此显示"编写工具调用中" */
    onToolDrafting?: (drafting: boolean) => void | Promise<void>;
};

// 单轮工具调用上限：默认 8，可在工坊配置里调节（qa-prefs）

// 轮数用尽/输出截断时给用户的可见提示——否则未执行的指令被流过滤器隐藏，
// 表现为"话说到一半突然断了"
const QA_ROUNDS_EXHAUSTED_NOTICE = "\n\n（这轮的工具调用次数用完了，还有操作没执行——回复「继续」我会接着完成。）";
const QA_TRUNCATED_NOTICE = "\n\n（回复被模型的输出长度上限截断，最后一个操作没能完整生成——回复「继续」我会重试；经常出现的话，建议在预设里调大最大输出 token。）";

/** 正文末尾残留未闭合的 [执行动作: 指令：输出被 max_tokens 截断的典型特征 */
function hasTruncatedDirective(content: string): boolean {
    const text = stripThinkBlocks(content);
    let start = -1;
    let from = 0;
    for (;;) {
        const match = QA_DIRECTIVE_START.exec(text.slice(from));
        if (!match) break;
        start = from + match.index;
        from = start + 1;
    }
    if (start === -1) return false;
    return !/[)）]\s*\]/.test(text.slice(start));
}

// ── 持久化上下文 ──────────────────────────────────
// 与 Claude Code / Codex 一致：工具调用与结果作为普通消息跨轮保留，
// 由 store 持久化并在接近预算时压缩。协议无关的存储形态，两种协议互相可回放。

export type QaContextEntry = {
    role: "user" | "assistant" | "tool";
    content: string;
    /** user：随消息附带的图片（dataURL）；识图未开启时适配层会自动降级为占位文本 */
    images?: string[];
    /** assistant：原生协议的工具调用（文本协议轮次不填，指令已在 content 里） */
    toolCalls?: LlmToolCall[];
    /** tool：来源调用 id（原生轮次才有）与工具名 */
    toolCallId?: string;
    name?: string;
    /** 归属的 UI 轮次 id（store 填写，用于重试时裁剪对应条目） */
    turn?: string;
};

/** user 条目内容：带图片时转多模态 parts（识图未开启由适配层降级为占位） */
function userEntryContent(entry: QaContextEntry): string | LLMContentPart[] {
    if (!entry.images?.length) return entry.content;
    return [
        { type: "text", text: entry.content },
        ...entry.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ];
}

/** 文本协议回放：tool 条目转系统结果块；原生 assistant 条目补写指令文本 */
function contextToTextMessages(entries: QaContextEntry[]): LlmRequestMessage[] {
    const nativeToZh = new Map<string, string>();
    for (const [nat, zh] of buildQaNativeNameMap()) nativeToZh.set(nat, zh);
    const out: LlmRequestMessage[] = [];
    for (const entry of entries) {
        if (entry.role === "user") {
            out.push({ role: "user", content: userEntryContent(entry) });
        } else if (entry.role === "assistant") {
            let content = entry.content;
            if (entry.toolCalls?.length) {
                const directives = entry.toolCalls
                    .map((call) => `[执行动作:${nativeToZh.get(call.name) ?? call.name}(${JSON.stringify(call.args ?? {})})]`)
                    .join("\n");
                content = content ? `${content}\n${directives}` : directives;
            }
            out.push({ role: "assistant", content });
        } else {
            out.push({
                role: "user",
                content: `[系统工具结果，用户不可见]\n【${entry.name ?? "工具"}】\n${entry.content}\n\n请基于以上结果继续回答用户的问题。`,
            });
        }
    }
    return out;
}

/** 原生协议回放：带 callId 的 tool 条目走 tool 消息；文本轮次的结果退化为 user 块 */
function contextToNativeMessages(entries: QaContextEntry[]): LlmRequestMessage[] {
    const out: LlmRequestMessage[] = [];
    for (const entry of entries) {
        if (entry.role === "user") {
            out.push({ role: "user", content: userEntryContent(entry) });
        } else if (entry.role === "assistant") {
            out.push({ role: "assistant", content: entry.content, toolCalls: entry.toolCalls?.length ? entry.toolCalls : undefined });
        } else if (entry.toolCallId) {
            out.push({ role: "tool", content: entry.content, name: entry.name ?? "", toolCallId: entry.toolCallId });
        } else {
            out.push({
                role: "user",
                content: `[系统工具结果，用户不可见]\n【${entry.name ?? "工具"}】\n${entry.content}\n\n请基于以上结果继续回答用户的问题。`,
            });
        }
    }
    return out;
}

/** 把整段上下文压缩成延续工作的备忘录（供 store 在预算触顶时调用） */
export async function compactQaContext(entries: QaContextEntry[], options?: { signal?: AbortSignal }): Promise<string> {
    const apiConfig = requireQaApiConfig();
    const lines = entries.map((entry) => {
        const head = entry.role === "user" ? "用户" : entry.role === "assistant" ? "助手" : `工具结果(${entry.name ?? "工具"})`;
        const body = entry.content.length > 4000 ? `${entry.content.slice(0, 4000)}…（截断）` : entry.content;
        const calls = entry.toolCalls?.length
            ? `\n[调用工具] ${entry.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args ?? {}).slice(0, 400)})`).join("；")}`
            : "";
        return `【${head}】${body}${calls}`;
    });
    let transcript = lines.join("\n\n");
    if (transcript.length > 150_000) transcript = transcript.slice(-150_000);
    const result = await requestQaCompletion(apiConfig, [
        {
            role: "system",
            content: "你是对话上下文压缩器。把下面这段人机协作对话（含工具调用与结果）压缩成延续工作所需的中文备忘录，保留：用户的目标与偏好、已完成的操作与关键结论、涉及的文件/内容名称与关键参数、未完成事项与下一步计划。直接输出备忘录正文，不要评论。",
        },
        { role: "user", content: transcript },
    ], { signal: options?.signal });
    return stripThinkBlocks(result.content).trim();
}

type QaAgentOptions = {
    signal?: AbortSignal;
    callbacks?: QaAgentCallbacks;
    autoCommit?: boolean;
    /** 持久化上下文：提供时作为模型侧完整历史（替代 history），本轮新增条目经 onContext 回报 */
    context?: QaContextEntry[];
    onContext?: (entry: QaContextEntry) => void;
};

function buildQaToolContext(options?: QaAgentOptions) {
    return {
        signal: options?.signal,
        autoCommit: options?.autoCommit,
        onStageCommit: options?.callbacks?.onStageCommit,
        commitNow: options?.callbacks?.commitNow,
        onContentCreated: options?.callbacks?.onContentCreated,
    };
}

/**
 * 工坊 agent 主循环。与小卷同模式：API 配置开启「启用原生工具」时走
 * function calling（工具经请求体 tools 声明），否则走文本协议
 * [执行动作:工具名({…})]。两条路径都循环回填工具结果，直到无调用或轮数用尽。
 */
export async function callQaAgent(history: QaEngineMessage[], options?: QaAgentOptions): Promise<void> {
    const apiConfig = requireQaApiConfig();
    const useNative = !!nativeToolProtocolForConfig(apiConfig);
    if (useNative) return callQaAgentNative(apiConfig, history, options);
    return callQaAgentText(apiConfig, history, options);
}

// ── 文本协议路径 ──

async function callQaAgentText(apiConfig: ApiConfig, history: QaEngineMessage[], options?: QaAgentOptions): Promise<void> {
    const callbacks = options?.callbacks;
    const latestUser = options?.context
        ? [...options.context].reverse().find((m) => m.role === "user")
        : [...history].reverse().find((m) => m.role === "user");
    const systemPrompt = `${buildQaSystemPrompt(latestUser?.content ?? "")}\n\n${buildQaToolsPrompt()}`;
    const working: LlmRequestMessage[] = options?.context
        ? contextToTextMessages(options.context)
        : historyToRequestMessages(history);

    const maxRounds = getQaMaxRounds();
    let emittedAny = false;
    for (let round = 0; round < maxRounds; round++) {
        let pendingBreak = emittedAny;
        const filter = createQaStreamFilter(async (text) => {
            if (pendingBreak && text.trim()) {
                pendingBreak = false;
                await callbacks?.onDelta?.("\n\n");
            }
            if (text.trim()) emittedAny = true;
            await callbacks?.onDelta?.(text);
        }, (holding) => callbacks?.onToolDrafting?.(holding));

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
        if (hasTruncatedDirective(result.content)) {
            await callbacks?.onDelta?.(QA_TRUNCATED_NOTICE);
            options?.onContext?.({ role: "assistant", content: stripThinkBlocks(result.content) + QA_TRUNCATED_NOTICE });
            return;
        }
        if (toolCalls.length === 0) {
            options?.onContext?.({ role: "assistant", content: result.content });
            return;
        }
        if (round === maxRounds - 1) {
            await callbacks?.onDelta?.(QA_ROUNDS_EXHAUSTED_NOTICE);
            options?.onContext?.({ role: "assistant", content: result.content + QA_ROUNDS_EXHAUSTED_NOTICE });
            return;
        }

        working.push({ role: "assistant", content: result.content });
        options?.onContext?.({ role: "assistant", content: result.content });
        const resultBlocks: string[] = [];
        for (const call of toolCalls) {
            if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
            await callbacks?.onToolStart?.(call.name, call.args);
            const toolResult = await runQaToolCall(call, buildQaToolContext(options));
            await callbacks?.onToolDone?.(call.name, toolResult.success, toolResult.resultForModel);
            const block = `${toolResult.success ? "" : "（失败）"}${toolResult.resultForModel}`;
            options?.onContext?.({ role: "tool", name: toolResult.name, content: block });
            resultBlocks.push(`【${toolResult.name}】${toolResult.success ? "" : "（失败）"}\n${toolResult.resultForModel}`);
        }
        working.push({
            role: "user",
            content: `[系统工具结果，用户不可见]\n${resultBlocks.join("\n\n")}\n\n请基于以上结果继续回答用户的问题。`,
        });
    }
}

// ── 原生工具协议路径 ──

async function callQaAgentNative(apiConfig: ApiConfig, history: QaEngineMessage[], options?: QaAgentOptions): Promise<void> {
    const callbacks = options?.callbacks;
    const latestUser = options?.context
        ? [...options.context].reverse().find((m) => m.role === "user")
        : [...history].reverse().find((m) => m.role === "user");
    // 原生协议下工具经请求体声明，系统提示词只保留身份与行为规则
    const systemPrompt = [
        buildQaSystemPrompt(latestUser?.content ?? ""),
        "你有原生工具可以调用（见请求中的 tools 定义）。排查问题优先实际调用工具检测，不要凭空猜测；收到工具结果后用人话向用户解释结论和建议。",
    ].join("\n\n");
    const working: LlmRequestMessage[] = options?.context
        ? contextToNativeMessages(options.context)
        : historyToRequestMessages(history);
    const nameMap = buildQaNativeNameMap();

    const maxRounds = getQaMaxRounds();
    let emittedAny = false;
    for (let round = 0; round < maxRounds; round++) {
        const tools = getQaNativeToolDefinitions();
        let pendingBreak = emittedAny;
        // 仍套用文本过滤器：弱模型可能在正文里混写文本协议指令，隐藏之
        const filter = createQaStreamFilter(async (text) => {
            if (pendingBreak && text.trim()) {
                pendingBreak = false;
                await callbacks?.onDelta?.("\n\n");
            }
            if (text.trim()) emittedAny = true;
            await callbacks?.onDelta?.(text);
        }, (holding) => callbacks?.onToolDrafting?.(holding));

        const messages: LlmRequestMessage[] = [{ role: "system", content: systemPrompt }, ...working];
        let result: LLMToolRequestResult;
        try {
            result = await sendLLMToolStreamRequest(
                apiConfig,
                null,
                messages,
                tools,
                [],
                { characterName: "工坊", userName: "用户" },
                { appId: "qa", signal: options?.signal },
                {
                    async onDelta(delta) {
                        await filter.push(delta);
                    },
                    async onReasoningDelta(delta) {
                        await callbacks?.onReasoningDelta?.(delta);
                    },
                },
            );
        } catch (streamError) {
            if (options?.signal?.aborted) throw streamError;
            await callbacks?.onStreamFallback?.(formatQaErrorMessage(streamError));
            const fallbackRequest = buildProviderRequest(apiConfig, null, messages, { tools });
            const response = await fetch(fallbackRequest.url, {
                method: "POST",
                headers: fallbackRequest.headers,
                body: JSON.stringify(fallbackRequest.body),
                signal: options?.signal,
            });
            if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
            const parsed = parseProviderResponse(fallbackRequest.providerKind, await response.json());
            if (parsed.content) await filter.push(parsed.content);
            result = {
                content: parsed.content || "",
                reasoning: parsed.reasoning,
                openRouterReasoningDetails: parsed.openRouterReasoningDetails,
                toolCalls: parsed.toolCalls || [],
                rawResponse: "",
                providerKind: fallbackRequest.providerKind,
            };
        }
        await filter.flush();

        // 原生调用为主；同时兜底解析正文里的文本协议指令（弱模型混写时也能执行）
        const nativeCalls = result.toolCalls || [];
        const textParsed = parseToolCalls(stripThinkBlocks(result.content || ""));
        if (nativeCalls.length === 0 && textParsed.toolCalls.length === 0) {
            if (hasTruncatedDirective(result.content || "")) {
                await callbacks?.onDelta?.(QA_TRUNCATED_NOTICE);
                options?.onContext?.({ role: "assistant", content: stripThinkBlocks(result.content || "") + QA_TRUNCATED_NOTICE });
            } else {
                options?.onContext?.({ role: "assistant", content: result.content || "" });
            }
            return;
        }
        if (round === maxRounds - 1) {
            await callbacks?.onDelta?.(QA_ROUNDS_EXHAUSTED_NOTICE);
            options?.onContext?.({ role: "assistant", content: (result.content || "") + QA_ROUNDS_EXHAUSTED_NOTICE });
            return;
        }

        working.push({
            role: "assistant",
            content: result.content || "",
            toolCalls: nativeCalls.length > 0 ? nativeCalls : undefined,
            reasoning: result.reasoning,
            openRouterReasoningDetails: result.openRouterReasoningDetails,
        });
        options?.onContext?.({
            role: "assistant",
            content: result.content || "",
            toolCalls: nativeCalls.length > 0 ? nativeCalls : undefined,
        });

        // 原生调用：结果以 tool 消息回传（带 toolCallId）
        for (const nc of nativeCalls) {
            if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
            const displayName = nameMap.get(nc.name) || nc.name;
            await callbacks?.onToolStart?.(displayName, nc.args);
            const toolResult = await runQaToolCall({ name: displayName, args: nc.args }, buildQaToolContext(options));
            await callbacks?.onToolDone?.(displayName, toolResult.success, toolResult.resultForModel);
            const content = toolResult.success ? toolResult.resultForModel : `（失败）${toolResult.resultForModel}`;
            working.push({ role: "tool", content, name: nc.name, toolCallId: nc.id });
            options?.onContext?.({ role: "tool", content, name: nc.name, toolCallId: nc.id });
        }

        // 文本协议兜底调用：结果以 user 消息块回传
        if (textParsed.toolCalls.length > 0) {
            const resultBlocks: string[] = [];
            for (const call of textParsed.toolCalls) {
                if (options?.signal?.aborted) throw new DOMException("aborted", "AbortError");
                await callbacks?.onToolStart?.(call.name, call.args);
                const toolResult = await runQaToolCall(call, buildQaToolContext(options));
                await callbacks?.onToolDone?.(call.name, toolResult.success, toolResult.resultForModel);
                const block = `${toolResult.success ? "" : "（失败）"}${toolResult.resultForModel}`;
                options?.onContext?.({ role: "tool", name: toolResult.name, content: block });
                resultBlocks.push(`【${toolResult.name}】${toolResult.success ? "" : "（失败）"}\n${toolResult.resultForModel}`);
            }
            working.push({
                role: "user",
                content: `[系统工具结果，用户不可见]\n${resultBlocks.join("\n\n")}\n\n请基于以上结果继续回答用户的问题。`,
            });
        }
    }
}
