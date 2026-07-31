// lib/mascot-engine.ts
// 小卷 LLM 引擎：双协议（原生工具 + 文本协议），agent 循环由 UI 层驱动。

import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { getMascotPersonaPrompt } from "./mascot-settings";
import type { MascotPageContext } from "./mascot-context";
import {
    buildMascotToolsListPrompt,
    buildMascotPackageSchemaPrompt,
    getMascotNativeToolDefinitions,
    buildMascotNativeNameMap,
    findPackageByLabel,
    MASCOT_TOOL_PACKAGES,
} from "./mascot-tools";
import { parseToolFetches, parseToolCalls, findToolCallEnd, type ToolCall, type ToolFetch } from "./tool-executor";
import {
    nativeToolProtocolForConfig,
    buildProviderRequest,
    parseProviderResponse,
    parseProviderStreamDelta,
    stripHallucinatedTimestamps,
    type LlmRequestMessage,
    type LlmRequestPayload,
    type LlmToolCall,
} from "./llm-provider-adapter";
import { sendLLMToolStreamRequest, type LLMToolRequestResult } from "./chat-engine";

function requireMascotApiConfig() {
    const apiConfig = resolveAuxiliaryApiConfig("mascotApiConfigId");
    if (!apiConfig) throw new Error("请先在设置 → 绑定配置 → 全局配置中设置 API，或在辅助 API 中设置小卷助手 API");
    return apiConfig;
}

// ── 类型 ─────────────────────────────────────────────

export type MascotMsg = {
    role: "user" | "mascot" | "tool";
    text: string;
    createdAt?: string;
    hidden?: boolean;
    displayText?: string;
    /** 用户附带的图片，base64 data URL 数组（仅原生协议会真正发给 LLM，文本协议会忽略） */
    images?: string[];
    // 当 role=mascot 且使用原生协议时，存 LLM 返回的 toolCalls（用于下一轮请求重建上下文）
    toolCalls?: LlmToolCall[];
    // 当 role=mascot 时，存 LLM 返回的 reasoning 文本（Gemini 多轮工具调用需要把这段 thought 也回传，否则上下文会被丢）
    reasoning?: string;
    // OpenRouter Gemini 工具调用需要把 reasoning_details 原样回传
    openRouterReasoningDetails?: unknown[];
    // 当 role=tool 时，存 tool result 元信息
    toolCallId?: string;
    /** 协议层用的工具名：原生协议下是稳定英文 native name（必须和 functionCall.name 一致才能正确回传）*/
    toolName?: string;
    /** UI 展示用的工具名（中文，如"读取CSS"）。无值时回退到 toolName */
    toolDisplayName?: string;
    toolSuccess?: boolean;
};

export type MascotToolResponse = {
    /** 显示给用户的回复（剥离工具标签后） */
    reply: string[];
    /** 原始 assistant 文本（含工具标签，用于下一轮历史） */
    rawAssistant: string;
    /** 文本协议：要展开的套件名（label） */
    toolFetches: ToolFetch[];
    /** 要执行的工具调用 */
    toolCalls: ToolCall[];
    /** 原生协议下，原始的 LlmToolCall（包含 id，用于回传） */
    nativeToolCalls?: LlmToolCall[];
    /** LLM 返回的 reasoning 文本（Gemini 多轮工具调用需要把这段也存到历史） */
    reasoning?: string;
    /** OpenRouter provider-private reasoning state，用于多轮工具调用回传 */
    openRouterReasoningDetails?: unknown[];
    /** 当前使用的协议 */
    protocol: "native" | "text";
};

export type MascotChatStreamCallbacks = {
    onAssistantDelta?: (text: string) => void | Promise<void>;
    onReasoningDelta?: (text: string) => void | Promise<void>;
    onToolCallStart?: (info: { id: string; name: string; index: number; protocol: "native" | "text" }) => void | Promise<void>;
    onStreamFallback?: (reason: string) => void | Promise<void>;
};

const MAX_TOOL_CONTEXT_IMAGES = 4;

// ── 消息构造 ──────────────────────────────────────────

type TextHistoryMessage = { role: string; content: string; images?: string[] };

/** 历史里是否含图片 */
function historyHasImages(history: MascotMsg[]): boolean {
    return history.some((m) => m.images && m.images.length > 0);
}

function limitedImageRefs(refs: string[], limit = MAX_TOOL_CONTEXT_IMAGES): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        out.push(ref);
        if (out.length >= limit) break;
    }
    return out;
}

function collectToolImageRefs(messages: MascotMsg[]): string[] {
    const refs: string[] = [];
    for (const m of messages) refs.push(...(m.images || []));
    return limitedImageRefs(refs);
}

/** 将小卷的历史消息转为 LLM 请求消息（文本协议）。
 * tool 消息以 user 形式回传，连续的 tool 消息会合并成一个 <action_result> 集合，
 * 末尾附加引导文本（和 chat-engine 的 formatToolResults 风格一致） */
function historyToTextMessages(history: MascotMsg[]): TextHistoryMessage[] {
    const recent = history.slice(-40);
    const out: TextHistoryMessage[] = [];
    let toolBuffer: MascotMsg[] = [];

    const flushTools = () => {
        if (toolBuffer.length === 0) return;
        const images = collectToolImageRefs(toolBuffer);
        const items = toolBuffer.map((m) => {
            const name = m.toolName || "未知";
            if (m.toolSuccess === false) {
                return `<action_result name="${name}" error="${(m.text || "未知错误").replace(/"/g, "&quot;")}"></action_result>`;
            }
            return `<action_result name="${name}">${m.text}</action_result>`;
        }).join("\n");
        out.push({
            role: "user",
            content: `以下是系统处理结果：\n${items}\n请基于以上结果继续回复用户，不要重复你之前说过的内容，不要再次执行相同的动作。`,
            images: images.length > 0 ? images : undefined,
        });
        toolBuffer = [];
    };

    for (const m of recent) {
        if (m.role === "tool") {
            toolBuffer.push(m);
            continue;
        }
        flushTools();
        if (m.role === "user") out.push({ role: "user", content: m.text });
        else out.push({ role: "assistant", content: m.text });
    }
    flushTools();
    return out;
}

async function buildImageContextMessage(text: string, imageRefs: string[]): Promise<LlmRequestMessage> {
    const dataUrls = await resolveImageRefs(limitedImageRefs(imageRefs));
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }> = [];
    if (text) parts.push({ type: "text", text });
    for (const url of dataUrls) parts.push({ type: "image_url", image_url: { url, detail: "low" } });
    return { role: "user", content: parts.length > 0 ? parts : text };
}

function historyToTextRequestMessages(history: MascotMsg[]): LlmRequestMessage[] {
    return historyToTextMessages(history).map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
    }));
}

/** 把 media-store:// ref 加载成 data URL（image_url part 用） */
async function refToDataUrl(ref: string): Promise<string | null> {
    try {
        const { loadMediaBlob } = await import("./media-cache-storage");
        const media = await loadMediaBlob(ref);
        if (!media) return null;
        return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(media.blob);
        });
    } catch { return null; }
}

async function resolveImageRefs(refs: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const ref of refs) {
        // 兼容已经是 data URL 的情况（防御性）
        if (ref.startsWith("data:")) { out.push(ref); continue; }
        const url = await refToDataUrl(ref);
        if (url) out.push(url);
    }
    return out;
}

/** 文本协议带图版：把 historyToTextMessages 的字符串结果转成 LlmRequestMessage[]，
 * 对应位置的 user 消息如果有图片，会把 content 升级成 multipart text+image_url 数组 */
async function historyToTextMessagesMultipart(history: MascotMsg[]): Promise<LlmRequestMessage[]> {
    const textMessages = historyToTextMessages(history);
    // 找出对应的原始 user 消息里有图片的 → 升级 content 为 multipart
    // 注意：historyToTextMessages 会合并连续 tool 消息为单条 user，所以索引不一一对应；
    // 这里用顺序匹配 — 取最近 40 条非 tool 的 user 消息的 images
    const recent = history.slice(-40);
    const userImagesQueue: string[][] = [];
    for (const m of recent) {
        if (m.role === "user") userImagesQueue.push(m.images && m.images.length > 0 ? m.images : []);
    }
    let userIdx = 0;
    const out: LlmRequestMessage[] = [];
    for (const m of textMessages) {
        if (m.role !== "user") {
            out.push({ role: m.role as "system" | "assistant", content: m.content } as LlmRequestMessage);
            continue;
        }
        const isToolResultSynth = m.content.startsWith("以下是系统处理结果：");
        if (isToolResultSynth) {
            if (m.images && m.images.length > 0) {
                out.push(await buildImageContextMessage(
                    `${m.content}\n\n系统记录：上面的工具结果包含图片预览，请结合图片判断后续是否需要继续处理。`,
                    m.images,
                ));
            } else {
                out.push({ role: "user", content: m.content });
            }
            continue;
        }
        const images = userImagesQueue[userIdx++] || [];
        if (images.length === 0) { out.push({ role: "user", content: m.content }); continue; }
        const dataUrls = await resolveImageRefs(images);
        const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }> = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        for (const url of dataUrls) parts.push({ type: "image_url", image_url: { url, detail: "low" } });
        out.push({ role: "user", content: parts });
    }
    return out;
}

/** 将小卷的历史消息转为 LlmRequestMessage（原生协议，含 tool call/result 还原） */
async function historyToNativeMessages(history: MascotMsg[]): Promise<LlmRequestMessage[]> {
    const out: LlmRequestMessage[] = [];
    const recent = history.slice(-40);
    for (const m of recent) {
        if (m.role === "user") {
            // 用户消息：含图片时构造多模态 content 数组（text + image_url parts）
            if (m.images && m.images.length > 0) {
                const dataUrls = await resolveImageRefs(m.images);
                const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }> = [];
                if (m.text) parts.push({ type: "text", text: m.text });
                for (const url of dataUrls) parts.push({ type: "image_url", image_url: { url, detail: "low" } });
                out.push({ role: "user", content: parts });
            } else {
                out.push({ role: "user", content: m.text });
            }
        } else if (m.role === "tool") {
            out.push({
                role: "tool",
                content: m.text,
                name: m.toolName || "",
                toolCallId: m.toolCallId || "",
            });
            if (m.images && m.images.length > 0) {
                out.push(await buildImageContextMessage(
                    `系统记录：这是工具「${m.toolDisplayName || m.toolName || "工具"}」刚才返回的图片。请结合图片判断后续是否需要继续裁切、去底、转换、上传或写 CSS。`,
                    m.images,
                ));
            }
        } else {
            // mascot 消息
            const msg: LlmRequestMessage = m.toolCalls && m.toolCalls.length > 0
                ? { role: "assistant", content: m.text, toolCalls: m.toolCalls, reasoning: m.reasoning, openRouterReasoningDetails: m.openRouterReasoningDetails }
                : { role: "assistant", content: m.text, reasoning: m.reasoning, openRouterReasoningDetails: m.openRouterReasoningDetails };
            out.push(msg);
        }
    }
    return out;
}

function formatErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseSseEvents(buffer: string): { events: string[]; rest: string } {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n\n");
    return {
        events: parts.slice(0, -1),
        rest: parts[parts.length - 1] || "",
    };
}

function findMascotProtocolStart(text: string, fromIndex: number): number {
    const toolPattern = /\[[^\[\]]{0,160}?(?:获取指令|获取工具|执行动作|工具调用)/g;
    toolPattern.lastIndex = fromIndex;
    const toolMatch = toolPattern.exec(text);

    const thinkPattern = /<\s*(?:think|thinking)\b/gi;
    thinkPattern.lastIndex = fromIndex;
    const thinkMatch = thinkPattern.exec(text);

    const starts = [toolMatch?.index, thinkMatch?.index].filter((value): value is number => typeof value === "number");
    return starts.length > 0 ? Math.min(...starts) : -1;
}

function getMascotProtocolEnd(text: string, startIndex: number): number | null {
    const rest = text.slice(startIndex);
    const thinkOpen = /^<\s*(think|thinking)\b[^>]*>/i.exec(rest);
    if (thinkOpen) {
        const tagName = thinkOpen[1];
        const closePattern = new RegExp(`</\\s*${tagName}\\s*>`, "i");
        const closeMatch = closePattern.exec(rest.slice(thinkOpen[0].length));
        return closeMatch ? startIndex + thinkOpen[0].length + closeMatch.index + closeMatch[0].length : null;
    }

    const toolCallEnd = findToolCallEnd(text, startIndex);
    if (toolCallEnd != null) return toolCallEnd;

    const closeBracket = text.indexOf("]", startIndex);
    return closeBracket >= 0 ? closeBracket + 1 : null;
}

function peekMascotProtocolToolName(text: string, startIndex: number): string | null {
    const slice = text.slice(startIndex);
    const match = /^\[[""\u201C]?([^""\u201D\]]*?)[""\u201D]?\s*(获取指令|获取工具|执行动作|工具调用)\s*[:：]\s*([^(（\]\n]+)/.exec(slice);
    if (!match) return null;
    const kind = match[2];
    const name = match[3].trim();
    if (!name) return null;
    return kind === "获取指令" || kind === "获取工具" ? `展开${name}` : name;
}

function createMascotTextDisplayFilter(
    emit?: (text: string) => void | Promise<void>,
    onToolCallStart?: (info: { id: string; name: string; index: number; protocol: "text" }) => void | Promise<void>,
) {
    let buffer = "";
    let processedIndex = 0;
    const firedToolStarts = new Set<number>();

    const emitText = async (text: string) => {
        if (!text) return;
        await emit?.(text.replace(/\r\n?/g, "\n"));
    };

    const processAvailable = async (final = false) => {
        while (processedIndex < buffer.length) {
            const specialStart = findMascotProtocolStart(buffer, processedIndex);
            if (specialStart < 0) {
                if (final) {
                    await emitText(buffer.slice(processedIndex));
                    processedIndex = buffer.length;
                } else {
                    const lastPotentialStart = Math.max(buffer.lastIndexOf("["), buffer.lastIndexOf("<"));
                    const shouldHoldTail = lastPotentialStart >= processedIndex
                        && !/[\]>]/.test(buffer.slice(lastPotentialStart));
                    const safeEnd = shouldHoldTail ? lastPotentialStart : buffer.length;
                    if (safeEnd > processedIndex) {
                        await emitText(buffer.slice(processedIndex, safeEnd));
                        processedIndex = safeEnd;
                    }
                }
                return;
            }

            if (specialStart > processedIndex) {
                await emitText(buffer.slice(processedIndex, specialStart));
                processedIndex = specialStart;
            }

            if (!firedToolStarts.has(specialStart)) {
                const toolName = peekMascotProtocolToolName(buffer, specialStart);
                if (toolName) {
                    firedToolStarts.add(specialStart);
                    await onToolCallStart?.({
                        id: `text_${Date.now()}_${specialStart}`,
                        name: toolName,
                        index: firedToolStarts.size - 1,
                        protocol: "text",
                    });
                }
            }

            const specialEnd = getMascotProtocolEnd(buffer, specialStart);
            if (specialEnd == null) {
                if (final) processedIndex = buffer.length;
                return;
            }
            processedIndex = specialEnd;
        }
    };

    return {
        async push(text: string) {
            buffer += text;
            await processAvailable(false);
        },
        async flush() {
            await processAvailable(true);
        },
    };
}

async function streamMascotProviderRequest(
    request: LlmRequestPayload,
    options?: { signal?: AbortSignal },
    callbacks?: {
        onDelta?: (text: string) => void | Promise<void>;
        onReasoningDelta?: (text: string) => void | Promise<void>;
    },
): Promise<{ content: string; reasoning: string; rawResponse: string }> {
    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const abortHandler = () => llmAbort.abort();
    if (options?.signal) {
        if (options.signal.aborted) llmAbort.abort();
        else options.signal.addEventListener("abort", abortHandler);
    }

    let rawResponse = "";
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
                rawResponse += `${dataLine}\n`;
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

        return { content: stripHallucinatedTimestamps(content), reasoning, rawResponse };
    } finally {
        clearTimeout(llmTimeout);
        if (options?.signal) options.signal.removeEventListener("abort", abortHandler);
    }
}

function buildMascotTextResponse(raw: string): Pick<MascotToolResponse, "reply" | "rawAssistant" | "toolFetches" | "toolCalls" | "protocol"> {
    const toolFetches = parseToolFetches(raw);
    const { cleanText, toolCalls } = parseToolCalls(raw);
    let displayText = cleanText;
    displayText = displayText.replace(/\[获取指令:[^\]]+\]/g, "").trim();
    displayText = displayText.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "").trim();
    const reply = displayText ? displayText.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean) : [];
    return {
        reply,
        rawAssistant: raw,
        toolFetches,
        toolCalls,
        protocol: "text",
    };
}

function mapMascotNativeCalls(
    nativeCalls: LlmToolCall[],
    nameMap: Map<string, string>,
): { toolFetches: ToolFetch[]; toolCalls: ToolCall[] } {
    const toolFetches: ToolFetch[] = [];
    const toolCalls: ToolCall[] = [];
    for (const nc of nativeCalls) {
        const displayName = nameMap.get(nc.name) || nc.name;
        if (displayName.startsWith("_loader:")) {
            const pkgId = displayName.slice("_loader:".length);
            const pkg = MASCOT_TOOL_PACKAGES.find((p) => p.id === pkgId);
            if (pkg) toolFetches.push({ name: pkg.label });
        } else {
            toolCalls.push({ name: displayName, args: nc.args });
        }
    }
    return { toolFetches, toolCalls };
}

// ── 文本协议：发送请求 ────────────────────────────────

async function callMascotText(
    context: MascotPageContext,
    history: MascotMsg[],
    options?: { signal?: AbortSignal; callbacks?: MascotChatStreamCallbacks },
): Promise<MascotToolResponse> {
    const apiConfig = requireMascotApiConfig();

    // 构造系统提示词。
    // 套件详细说明（usageGuide）不在这里注入：当 LLM 调用 [获取指令:套件名] 时
    // 由 agent loop 作为 tool 消息加入到 history，自然驻留在上下文里。
    const systemPrompt = [
        getMascotPersonaPrompt(),
        `当前页面：${context.label}（${context.mode}）`,
        buildMascotToolsListPrompt(),
    ].join("\n\n");

    // 仅在该 API 配置开启"图像识别"时才构造 multipart 图片消息；
    // 关闭时走纯文本（适配器另有总闸兜底，双保险）。
    const hasImages = apiConfig.enableImageRecognition === true && historyHasImages(history);
    const messages: LlmRequestMessage[] = [
        { role: "system", content: systemPrompt },
        ...(hasImages ? await historyToTextMessagesMultipart(history) : historyToTextRequestMessages(history)),
    ];

    let raw = "";
    const displayFilter = createMascotTextDisplayFilter(
        options?.callbacks?.onAssistantDelta,
        options?.callbacks?.onToolCallStart,
    );
    try {
        const streamRequest = buildProviderRequest(apiConfig, null, messages, { stream: true });
        const streamResult = await streamMascotProviderRequest(
            streamRequest,
            { signal: options?.signal },
            {
                async onDelta(delta) {
                    await displayFilter.push(delta);
                },
                async onReasoningDelta(delta) {
                    await options?.callbacks?.onReasoningDelta?.(delta);
                },
            },
        );
        await displayFilter.flush();
        raw = streamResult.content.trim();
    } catch (streamError) {
        if (options?.signal?.aborted) throw streamError;
        await options?.callbacks?.onStreamFallback?.(formatErrorMessage(streamError));

        const request = buildProviderRequest(apiConfig, null, messages);
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: options?.signal,
        });
        if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
        const data = await response.json();
        const parsed = parseProviderResponse(request.providerKind, data);
        raw = parsed.content || "";
    }

    if (!raw) {
        throw new Error("LLM 返回了空内容");
    }

    const parsedText = buildMascotTextResponse(raw);

    return parsedText;
}

// ── 原生协议：发送请求 ────────────────────────────────

async function callMascotNative(
    context: MascotPageContext,
    history: MascotMsg[],
    expandedPackageIds: string[],
    options?: { signal?: AbortSignal; callbacks?: MascotChatStreamCallbacks },
): Promise<MascotToolResponse> {
    const apiConfig = requireMascotApiConfig();

    const tools = getMascotNativeToolDefinitions(expandedPackageIds);
    const nameMap = buildMascotNativeNameMap();

    const systemPrompt = [
        getMascotPersonaPrompt(),
        `当前页面：${context.label}（${context.mode}）`,
        "你有工具可调。每个套件需要先展开才能看到详细动作；导航工具直接可用。同时最多展开 2 个套件。",
        "重要：调用工具时，回复文本里**不要复述**工具参数的内容（比如不要把 persona 完整文本再写一遍）。回复文本只用一两句话简短说明你在做什么即可，详细内容通过工具参数传递。",
    ].join("\n\n");

    const messages: LlmRequestMessage[] = [
        { role: "system", content: systemPrompt },
        ...(await historyToNativeMessages(history)),
    ];

    try {
        let result: LLMToolRequestResult;
        try {
            result = await sendLLMToolStreamRequest(
                apiConfig,
                null,
                messages,
                tools,
                [],
                { characterName: "小卷", userName: "用户" },
                { appId: "mascot", signal: options?.signal },
                {
                    async onDelta(delta) {
                        await options?.callbacks?.onAssistantDelta?.(delta);
                    },
                    async onReasoningDelta(delta) {
                        await options?.callbacks?.onReasoningDelta?.(delta);
                    },
                    async onToolCallStart(info) {
                        const mappedName = nameMap.get(info.name) || info.name;
                        const shownName = mappedName.startsWith("_loader:")
                            ? `展开${MASCOT_TOOL_PACKAGES.find((pkg) => pkg.id === mappedName.slice("_loader:".length))?.label || "工具集"}`
                            : mappedName;
                        await options?.callbacks?.onToolCallStart?.({
                            id: info.id,
                            name: shownName,
                            index: info.index,
                            protocol: "native",
                        });
                    },
                },
            );
        } catch (streamError) {
            if (options?.signal?.aborted) throw streamError;
            await options?.callbacks?.onStreamFallback?.(formatErrorMessage(streamError));

            const fallbackRequest = buildProviderRequest(apiConfig, null, messages, { tools });
            const response = await fetch(fallbackRequest.url, {
                method: "POST",
                headers: fallbackRequest.headers,
                body: JSON.stringify(fallbackRequest.body),
                signal: options?.signal,
            });
            if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
            const data = await response.json();
            const parsed = parseProviderResponse(fallbackRequest.providerKind, data);
            result = {
                content: parsed.content,
                reasoning: parsed.reasoning,
                openRouterReasoningDetails: parsed.openRouterReasoningDetails,
                toolCalls: parsed.toolCalls,
                rawResponse: JSON.stringify({ content: parsed.content, toolCalls: parsed.toolCalls, raw: parsed.raw }),
                providerKind: fallbackRequest.providerKind,
                usage: parsed.usage,
            };
        }

        const { toolFetches: nativeToolFetches, toolCalls: nativeToolCalls } = mapMascotNativeCalls(result.toolCalls, nameMap);
        const parsedText = buildMascotTextResponse(result.content || "");
        const hasTextProtocolCalls = parsedText.toolFetches.length > 0 || parsedText.toolCalls.length > 0;
        const reply = hasTextProtocolCalls
            ? parsedText.reply
            : (result.content || "").trim().split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
        return {
            reply,
            rawAssistant: result.content || "",
            toolFetches: [...nativeToolFetches, ...parsedText.toolFetches],
            toolCalls: [...nativeToolCalls, ...parsedText.toolCalls],
            nativeToolCalls: result.toolCalls,
            reasoning: result.reasoning,
            openRouterReasoningDetails: result.openRouterReasoningDetails,
            protocol: "native",
        };
    } catch (err) {
        throw err;
    }
}

// ── 主入口 ────────────────────────────────────────────

/**
 * 小卷一次 LLM 调用，agent 循环由 UI 层驱动。
 * 根据 API 配置自动选择原生工具协议或文本协议。
 *
 * 所有上下文（用户消息、assistant 回复、tool 结果）都通过 history 传递，
 * 调用方负责把每一轮的事件按顺序追加到 history。
 */
export async function mascotChatWithTools(
    context: MascotPageContext,
    history: MascotMsg[],
    expandedPackageIds: string[],
    options?: { signal?: AbortSignal; callbacks?: MascotChatStreamCallbacks },
): Promise<MascotToolResponse> {
    const apiConfig = requireMascotApiConfig();

    const useNative = !!nativeToolProtocolForConfig(apiConfig);
    if (useNative) {
        return await callMascotNative(context, history, expandedPackageIds, { signal: options?.signal, callbacks: options?.callbacks });
    }
    return await callMascotText(context, history, { signal: options?.signal, callbacks: options?.callbacks });
}
