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
import { fetchLlmPayload } from "./llm-http";
import { pushApiLog } from "./api-log-store";
import type { LLMContentPart } from "./llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig } from "./settings-storage";
import type { ApiConfig } from "./settings-types";
import { buildQaSystemPrompt } from "./qa-knowledge";
import { createSseJsonParser } from "./sse-json";
import { getQaMaxOutputTokens, getQaMaxRounds } from "./qa-prefs";
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
        const response = await fetchLlmPayload(request, { signal: llmAbort.signal });
        if (!response.ok) throw new Error(`API Stream ${response.status}: ${await response.text()}`);
        if (!response.body) throw new Error("流式响应没有 body。");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // 容错解析：中转把长 JSON 行切开时做碎片重组，不再静默丢增量（见 sse-json.ts）
        const sseParser = createSseJsonParser();
        const handleParsed = async (parsed: unknown) => {
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
        };
        const handleEvent = async (eventText: string) => {
            for (const parsed of sseParser.pushEvent(eventText)) {
                await handleParsed(parsed);
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
        for (const parsed of sseParser.flush()) {
            await handleParsed(parsed);
        }

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

// ── 分段续写协议（CONTINUE 尾标）──────────────────────
// 大内容分多轮写时，模型在正文末尾标 <!--CONTINUE--> 表示"没写完，让我继续"，
// 引擎自动喂系统提示接力，无需用户回复「继续」。<!--DONE--> 不参与判定
// （正常收尾即视为完成），但同样从可见文本里隐藏，防止弱模型照猫画虎写出来。

const QA_SEGMENT_MARKER_RE = /<!--\s*(?:CONTINUE|DONE)\s*-->/gi;
const QA_CONTINUE_TAIL_RE = /<!--\s*CONTINUE\s*-->\s*$/i;

/** 正文（去思考块后）以 CONTINUE 尾标结束：模型主动请求续写 */
function hasContinueMarker(content: string): boolean {
    return QA_CONTINUE_TAIL_RE.test(stripThinkBlocks(content));
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

    // 指令收尾：对参数括号做字符串感知的配平扫描。
    // 不能用「第一个 )]」判断——代码里 arr[fn()] 这类序列会提前骗停；
    // 也不能设长度上限放弃——放弃后指令尾部会当正文泄漏（见 e2e/test-leak-repro）。
    const findDirectiveEnd = (text: string, start: number): number | null => {
        const half = text.indexOf("(", start);
        const full = text.indexOf("（", start);
        let i = half === -1 ? full : full === -1 ? half : Math.min(half, full);
        if (i === -1) return null; // 参数括号还没流到
        let depth = 0;
        let inString = false;
        for (; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (ch === "\\") i++;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === "(" || ch === "（" || ch === "{" || ch === "[") depth++;
            else if (ch === ")" || ch === "）" || ch === "}" || ch === "]") {
                depth--;
                if (depth <= 0) {
                    const rest = text.slice(i + 1);
                    const closer = /^\s*\]/.exec(rest);
                    if (closer) return i + 1 + closer[0].length;
                    if (!rest.trim()) return null; // 收尾的 ] 还没流到
                    return i + 1; // 括号配平后没跟 ]：按指令结束，避免吞掉后文
                }
            }
        }
        return null;
    };

    const findEnd = (text: string, start: number): number | null => {
        if (QA_THINK_START.test(text.slice(start, start + 12))) {
            const match = QA_THINK_END.exec(text.slice(start));
            return match ? start + match.index + match[0].length : null;
        }
        return findDirectiveEnd(text, start);
    };

    // 尾部可能是尚未流完的指令/标签前缀，暂扣不显示。
    // 角括号阈值取 24：需覆盖分段续写标记 <!--CONTINUE--> 的未完前缀（最长 16 字符）
    const tailHoldIndex = (text: string): number => {
        const bracket = text.lastIndexOf("[");
        if (bracket !== -1 && !text.slice(bracket).includes("]") && text.length - bracket < 120) return bracket;
        const angle = text.lastIndexOf("<");
        if (angle !== -1 && !text.slice(angle).includes(">") && text.length - angle < 24) return angle;
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
                out = out.replace(QA_SEGMENT_MARKER_RE, "");
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
        // 分段续写标记只给引擎看，不展示给用户（未流完的前缀由 tailHoldIndex 暂扣）
        out = out.replace(QA_SEGMENT_MARKER_RE, "");
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
    // 输出护栏：配置了「单次最大输出 token」时每次请求带 max_tokens，
    // 写超被服务端安全截断（agent 循环里会自动续接），而不是拖垮整轮
    const maxTokens = getQaMaxOutputTokens() ?? undefined;
    // 工坊调用记录：与角色聊天/记忆等底层日志隔离，只进工坊右上角「调用记录」
    const logQaCall = (entry: { model: string; messages: { role: string; content: string | LLMContentPart[]; marker?: string }[]; rawResponse: string; reasoning?: string }) => {
        pushApiLog({
            characterName: "工坊",
            source: "qa",
            channel: "qa",
            model: entry.model,
            messages: entry.messages.map(m => ({
                role: m.role,
                content: typeof m.content === "string" ? m.content : "[vision: 含图片的多模态消息]",
            })),
            rawResponse: entry.rawResponse,
            reasoning: entry.reasoning?.trim() || undefined,
        });
    };
    try {
        const streamRequest = buildProviderRequest(apiConfig, null, messages, { stream: true, maxTokens });
        const result = await streamQaProviderRequest(streamRequest, { signal: options?.signal }, options?.callbacks);
        if (!result.content.trim()) throw new Error("LLM 返回了空内容");
        logQaCall({ model: apiConfig.defaultModel, messages: streamRequest.messagesForLog, rawResponse: result.content, reasoning: result.reasoning });
        return result;
    } catch (streamError) {
        if (options?.signal?.aborted) throw streamError;
        await options?.callbacks?.onStreamFallback?.(formatQaErrorMessage(streamError));
        const request = buildProviderRequest(apiConfig, null, messages, { maxTokens });
        const response = await fetchLlmPayload(request, { signal: options?.signal });
        if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
        const parsed = parseProviderResponse(request.providerKind, await response.json());
        const content = stripHallucinatedTimestamps(parsed.content || "").trim();
        if (!content) throw new Error("LLM 返回了空内容");
        const visible = stripThinkBlocks(content);
        if (visible) await options?.callbacks?.onDelta?.(visible);
        logQaCall({ model: apiConfig.defaultModel, messages: request.messagesForLog, rawResponse: content, reasoning: parsed.reasoning });
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
    /** 引擎自动续接（截断/CONTINUE 尾标）：UI 据此显示一行提示，用户不再莫名其妙 */
    onAutoContinue?: (reason: "truncated" | "marked") => void | Promise<void>;
};

// 单轮工具调用上限：默认 20，可在工坊配置里调节（qa-prefs）

// 轮数用尽/输出截断时给用户的可见提示——否则未执行的指令被流过滤器隐藏，
// 表现为"话说到一半突然断了"。截断本身会自动续接，提示只在轮数预算也用完时出现。
const QA_ROUNDS_EXHAUSTED_NOTICE = "\n\n（这轮的工具调用次数用完了，还有操作没执行——回复「继续」我会接着完成。）";
const QA_TRUNCATED_NOTICE = "\n\n（回复被输出长度上限截断，且本轮的自动续写次数也用完了——回复「继续」我会接着写；经常出现的话，建议在工坊配置里调大「单轮工具调用上限」。）";

// 截断/CONTINUE 尾标后的自动接力提示（作为用户不可见的系统消息喂回给模型）
const QA_AUTO_CONTINUE_TRUNCATED =
    "你上一条输出到达单次输出上限被截断，残缺的工具调用已被安全丢弃（之前已完整生成的调用照常执行了）。请从中断处继续，不要重写已完成的部分：先根据最近一次成功的工具结果确认写到了哪（需要核实内容时用「读取」——应用暂存文件 type=app 带 path、仓库暂存 type=repo 带 path、草稿字段 type=game/theater 带 name，page 翻到最后一页看结尾），然后用「写入」append=true 接着追加。注意：中间段在语句边界断开即可，绝不要提前写 </script>、</body>、</html> 等收尾标签——收尾只属于最后一段，各段拼接后必须恰好是一份完整文件。";
const QA_AUTO_CONTINUE_MARKED =
    "收到你的 CONTINUE 标记，请从上次停下的地方继续写；全部完成后正常收尾（不要再输出 CONTINUE）。";
const QA_CONTINUE_FALLBACK_PROMPT = "请基于以上结果继续回答用户的问题。";

// ── 输出预算提示：告诉模型 max_tokens 护栏与分段写入节奏 ──
function buildQaOutputBudgetPrompt(): string {
    const lines: string[] = ["===== 输出预算与分段写入 ====="];
    const budget = getQaMaxOutputTokens();
    if (budget) {
        lines.push(
            `本会话你单次回复的输出上限被设置为 ${budget.toLocaleString()} token（约 ${Math.round(budget * 0.75).toLocaleString()}–${budget.toLocaleString()} 个汉字），写超会被服务端安全截断，截断后系统会自动让你续写，不会报废已完成的部分。`,
        );
    } else {
        lines.push("模型单次回复有输出长度上限（max_tokens），一次写太长会被截断。");
    }
    lines.push("写入策略按优先级：");
    lines.push("① 改已有内容一律「编辑」（find/replace）——只输出改动片段，绝不整体重写大文件；");
    lines.push("② 新写内容正常一次写完即可，多数文件都在预算内，不必刻意分段；APP 的图片/字体/CSS 等资源拆成包内独立文件（「写入」type=app 按 path 多文件暂存），别 base64 塞进 index.html；");
    lines.push("③ 只有单个文件/字段可能超出输出预算时（大游戏 gameHtml、超长剧场开场等），才用「写入」append=true 分段：首轮写开头、后续轮接着写，全部写完后「发布」；");
    lines.push("④ 预算判断不准也没关系：写超被截断的残缺调用会被安全丢弃并自动让你续写，已完成的部分不会丢。");
    lines.push(
        "分段的本质是把同一份文件切成几刀、原样拼回：每段在语句/子元素的边界断开即可，中间段绝不要写 </script>、</body>、</html> 这类收尾标签，也不要为了段落\"完整\"强行闭合还没写完的函数或标签——收尾只出现在最后一段，各段按顺序拼接后必须恰好是一份结构完整的文件（此前有 APP 因第一段提前写了 </html>，后面几万字全被浏览器当纯文本、按钮全部失灵）。",
    );
    lines.push(
        "内容没写完、这条回复又不打算调用工具时，在正文末尾单独一行写 <!--CONTINUE-->，系统会自动让你继续；全部完成后正常收尾即可，不要输出 <!--CONTINUE-->。",
    );
    return lines.join("\n");
}

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
    /** user：随消息附带的纯文本或代码附件 */
    files?: { name: string; content: string }[];
    /** assistant：原生协议的工具调用（文本协议轮次不填，指令已在 content 里） */
    toolCalls?: LlmToolCall[];
    /** tool：来源调用 id（原生轮次才有）与工具名 */
    toolCallId?: string;
    name?: string;
    /** 归属的 UI 轮次 id（store 填写，用于重试时裁剪对应条目） */
    turn?: string;
};

/** user 条目内容：先拼接文本附件；带图片时再转多模态 parts。 */
function userEntryContent(entry: QaContextEntry): string | LLMContentPart[] {
    const fileBlocks = (entry.files ?? []).map((file) => `\n\n[附件：${file.name}]\n${file.content}`).join("");
    const textContent = `${entry.content}${fileBlocks}`;
    if (!entry.images?.length) return textContent;
    return [
        { type: "text", text: textContent },
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
        const files = entry.files?.length
            ? `\n${entry.files.map((file) => {
                const content = file.content.length > 4000 ? `${file.content.slice(0, 4000)}…（截断）` : file.content;
                return `[附件：${file.name}]\n${content}`;
            }).join("\n")}`
            : "";
        const calls = entry.toolCalls?.length
            ? `\n[调用工具] ${entry.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args ?? {}).slice(0, 400)})`).join("；")}`
            : "";
        return `【${head}】${body}${files}${calls}`;
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
    const systemPrompt = `${buildQaSystemPrompt(latestUser?.content ?? "")}\n\n${buildQaToolsPrompt()}\n\n${buildQaOutputBudgetPrompt()}`;
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
        // 截断（残缺指令）与 CONTINUE 尾标都不再终止本轮：已完整的调用照常执行，
        // 然后喂系统提示自动接力，直到模型正常收尾或轮数用尽
        const truncated = hasTruncatedDirective(result.content);
        const wantsContinue = hasContinueMarker(result.content);
        if (!truncated && !wantsContinue && toolCalls.length === 0) {
            options?.onContext?.({ role: "assistant", content: result.content });
            return;
        }
        if (round === maxRounds - 1) {
            const notice = truncated ? QA_TRUNCATED_NOTICE : QA_ROUNDS_EXHAUSTED_NOTICE;
            await callbacks?.onDelta?.(notice);
            options?.onContext?.({ role: "assistant", content: stripThinkBlocks(result.content) + notice });
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
        if (truncated || wantsContinue) await callbacks?.onAutoContinue?.(truncated ? "truncated" : "marked");
        const followUp = truncated ? QA_AUTO_CONTINUE_TRUNCATED : wantsContinue ? QA_AUTO_CONTINUE_MARKED : QA_CONTINUE_FALLBACK_PROMPT;
        working.push({
            role: "user",
            content: resultBlocks.length
                ? `[系统工具结果，用户不可见]\n${resultBlocks.join("\n\n")}\n\n${followUp}`
                : `[系统提示，用户不可见]\n${followUp}`,
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
        "你有原生工具可以调用（见请求中的 tools 定义）。排查问题先分诊再选工具，不要凭空猜测、也不要把工具挨个跑一遍：某个 APP/游戏/剧场自身行为不对是它的代码问题，「读取」源码定位；环境问题（API 连不上/存储满/页面崩溃/设备兼容）才用「环境体检」；产品用法问题查「答疑文档」。收到工具结果后用人话向用户解释结论和建议。",
        buildQaOutputBudgetPrompt(),
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
                { appId: "qa", signal: options?.signal, maxTokens: getQaMaxOutputTokens() ?? undefined },
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
            const fallbackRequest = buildProviderRequest(apiConfig, null, messages, { tools, maxTokens: getQaMaxOutputTokens() ?? undefined });
            const response = await fetchLlmPayload(fallbackRequest, { signal: options?.signal });
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
            // 流式失败转非流式成功的这一跳也要进工坊「调用记录」：主路径（sendLLMToolStreamRequest）
            // 由聊天引擎按 appId 分流落日志，这条 fallback 是本文件自己发的请求，不补就漏一条，
            // 而恰恰是刚出过流式故障、最需要排障记录的场景。
            pushApiLog({
                characterName: "工坊",
                source: "qa",
                channel: "qa",
                model: apiConfig.defaultModel,
                messages: fallbackRequest.messagesForLog.map(m => ({
                    role: m.role,
                    content: typeof m.content === "string" ? m.content : "[vision: 含图片的多模态消息]",
                })),
                rawResponse: JSON.stringify({ content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls }),
                reasoning: parsed.reasoning?.trim() || undefined,
                usage: parsed.usage,
            });
        }
        await filter.flush();

        // 原生调用为主；同时兜底解析正文里的文本协议指令（弱模型混写时也能执行）
        const nativeCalls = result.toolCalls || [];
        const textParsed = parseToolCalls(stripThinkBlocks(result.content || ""));
        // 截断（原生参数残缺已在下层丢弃 / 文本指令未闭合）与 CONTINUE 尾标都不再终止
        // 本轮：已完整的调用照常执行，然后喂系统提示自动接力
        const truncated = Boolean(result.truncatedToolCalls?.length) || hasTruncatedDirective(result.content || "");
        const wantsContinue = hasContinueMarker(result.content || "");
        if (nativeCalls.length === 0 && textParsed.toolCalls.length === 0 && !truncated && !wantsContinue) {
            options?.onContext?.({ role: "assistant", content: result.content || "" });
            return;
        }
        if (round === maxRounds - 1) {
            const notice = truncated ? QA_TRUNCATED_NOTICE : QA_ROUNDS_EXHAUSTED_NOTICE;
            await callbacks?.onDelta?.(notice);
            options?.onContext?.({ role: "assistant", content: stripThinkBlocks(result.content || "") + notice });
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

        // 文本协议兜底调用：结果以 user 消息块回传；截断/CONTINUE 时把接力提示并入同一条
        if (truncated || wantsContinue) await callbacks?.onAutoContinue?.(truncated ? "truncated" : "marked");
        const followUp = truncated ? QA_AUTO_CONTINUE_TRUNCATED : wantsContinue ? QA_AUTO_CONTINUE_MARKED : QA_CONTINUE_FALLBACK_PROMPT;
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
                content: `[系统工具结果，用户不可见]\n${resultBlocks.join("\n\n")}\n\n${followUp}`,
            });
        } else if (truncated || wantsContinue) {
            // 没有任何可执行调用（纯截断或纯 CONTINUE 尾标）：单独喂接力提示
            working.push({ role: "user", content: `[系统提示，用户不可见]\n${followUp}` });
        }
    }
}
