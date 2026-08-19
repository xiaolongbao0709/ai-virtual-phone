import type { LLMContentPart, LLMMessage } from "./llm-prompt-assembler";
import type { ApiConfig, PresetConfig } from "./settings-types";
import {
    buildChatCompletionsUrl,
    buildRequestHeaders,
    determineBaseUrl,
    isNativeAnthropicApi,
    isNativeGoogleApi,
    stripHallucinatedTimestamps,
} from "./api-helpers";

export type LlmProviderKind = "openai-compatible" | "anthropic" | "gemini";
export type NativeToolProtocol = "openai-compatible" | "anthropic" | "gemini";

export type LlmToolDefinition = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
};

export type LlmToolCall = {
    id: string;
    name: string;
    args: Record<string, unknown>;
    /** Gemini 2.5+ multi-turn function calling 需要回传这个签名才能保持上下文一致性 */
    thoughtSignature?: string;
};

export type LlmRequestMessage =
    | { role: "system"; content: string | LLMContentPart[]; marker?: string }
    | { role: "user"; content: string | LLMContentPart[]; marker?: string }
    | { role: "assistant"; content: string; marker?: string; reasoning?: string; openRouterReasoningDetails?: unknown[]; toolCalls?: LlmToolCall[] }
    | { role: "tool"; content: string; name: string; toolCallId: string; marker?: string };

export type LlmRequestPayload = {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    providerKind: LlmProviderKind;
    messagesForLog: { role: string; content: string | LLMContentPart[]; marker?: string }[];
};

export type LlmParsedResponse = {
    content: string;
    reasoning?: string;
    openRouterReasoningDetails?: unknown[];
    toolCalls: LlmToolCall[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    raw: unknown;
};

export type LlmStreamDelta = {
    content: string;
    reasoning: string;
    toolCallDeltas?: LlmToolCallDelta[];
};

export type LlmToolCallDelta = {
    index: number;
    id?: string;
    name?: string;
    argsText?: string;
    args?: Record<string, unknown>;
    thoughtSignature?: string;
};

type ProviderRequestOptions = {
    stream?: boolean;
    tools?: LlmToolDefinition[];
    /** 单次最大输出 token：按调用覆盖预设值（工坊输出护栏用）。不填则沿用预设/各家默认 */
    maxTokens?: number;
};

const ANTHROPIC_AUTO_MAX_TOKENS = 8192;

export type LlmDebugMessage = {
    role: string;
    content: string | LLMContentPart[];
    marker?: string;
};

export function nativeToolProtocolForConfig(config: ApiConfig): NativeToolProtocol | null {
    if (config.enableNativeTools === false) return null;
    if (isNativeAnthropicApi(config)) return "anthropic";
    if (isNativeGoogleApi(config)) return "gemini";
    return "openai-compatible";
}

export function providerKindForConfig(config: ApiConfig, options?: { nativeToolProtocol?: NativeToolProtocol | null }): LlmProviderKind {
    if (options?.nativeToolProtocol) return options.nativeToolProtocol;
    if (isNativeAnthropicApi(config)) return "anthropic";
    if (isNativeGoogleApi(config)) return "gemini";
    return "openai-compatible";
}

export function toLlmRequestMessages(messages: LLMMessage[]): LlmRequestMessage[] {
    return messages.map((message) => {
        if (message.role === "tool") {
            return {
                role: "tool",
                content: typeof message.content === "string" ? message.content : textFromContent(message.content),
                name: message.name || "",
                toolCallId: message.toolCallId || "",
                marker: message._debugMeta?.marker,
            };
        }
        const role = message.role;
        if (role === "assistant") {
            return {
                role,
                content: typeof message.content === "string" ? message.content : textFromContent(message.content),
                marker: message._debugMeta?.marker,
                reasoning: message.reasoning,
                openRouterReasoningDetails: message.openRouterReasoningDetails,
                toolCalls: message.toolCalls,
            };
        }
        return {
            role,
            content: message.content,
            marker: message._debugMeta?.marker,
        } as LlmRequestMessage;
    });
}

// The OpenAI tool protocol (DeepSeek enforces it strictly) requires that an
// assistant message carrying tool_calls is IMMEDIATELY followed by tool
// messages answering every tool_call_id. Histories rebuilt from chat storage
// can interleave other messages between a call and its result — e.g. global
// event-stream entries written while the tool was running sort in between —
// which fails the next request with 400 "insufficient tool messages". Restore
// adjacency at request-build time: hoist each call's results to sit right
// behind it (displaced messages keep their relative order after the tool
// block), synthesize a stub result when one is gone (truncated history), and
// flatten orphaned tool results whose call no longer exists.
function normalizeNativeToolMessageAdjacency(messages: LlmRequestMessage[]): LlmRequestMessage[] {
    const hasNativeTools = messages.some((message) =>
        (message.role === "assistant" && message.toolCalls?.length) || message.role === "tool");
    if (!hasNativeTools) return messages;

    const consumed = new Set<number>();
    const result: LlmRequestMessage[] = [];
    for (let i = 0; i < messages.length; i += 1) {
        if (consumed.has(i)) continue;
        const message = messages[i];
        if (message.role === "assistant" && message.toolCalls?.length) {
            result.push(message);
            for (const call of message.toolCalls) {
                let found = -1;
                for (let j = i + 1; j < messages.length; j += 1) {
                    if (consumed.has(j)) continue;
                    const candidate = messages[j];
                    if (candidate.role === "tool" && candidate.toolCallId === call.id) { found = j; break; }
                }
                if (found >= 0) {
                    consumed.add(found);
                    result.push(messages[found]);
                } else {
                    result.push({
                        role: "tool",
                        content: "[工具结果不可用：历史中缺失]",
                        name: call.name,
                        toolCallId: call.id,
                        marker: "protocol:synthesized-tool-result",
                    });
                }
            }
            continue;
        }
        if (message.role === "tool") {
            // Result whose call message no longer exists — flatten to text so the
            // provider doesn't reject a tool message without preceding tool_calls.
            result.push({
                role: "user",
                content: `[tool_result name="${message.name}"]\n${message.content}`,
                marker: message.marker ? `${message.marker} | protocol:orphan-tool-result` : "protocol:orphan-tool-result",
            });
            continue;
        }
        result.push(message);
    }
    return result;
}

function ensureProviderHasUserMessage(messages: LlmRequestMessage[]): LlmRequestMessage[] {
    if (messages.some((message) => message.role === "user")) return messages;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "system") continue;
        const converted: LlmRequestMessage = {
            role: "user",
            content: message.content,
            marker: message.marker ? `${message.marker} | protocol:user-from-system` : "protocol:user-from-system",
        };
        return messages.map((item, itemIndex) => itemIndex === index ? converted : item);
    }

    return messages;
}

/**
 * Anthropic/Gemini 的消息数组不接受 system 角色：开头连续的 system 提取为顶层
 * system / systemInstruction；插在历史中间的 system（@Depth 注入、系统指令等）
 * 原位转为 user 角色，保留位置语义，避免被整体挪到最前面。
 */
function splitLeadingSystemMessages(messages: LlmRequestMessage[]): { systemText: string; rest: LlmRequestMessage[] } {
    let leading = 0;
    while (leading < messages.length && messages[leading].role === "system") leading += 1;
    const systemText = messages.slice(0, leading)
        .map((message) => textFromContent(message.content))
        .filter(Boolean)
        .join("\n\n");
    const rest = messages.slice(leading).map((message) => message.role === "system"
        ? {
            role: "user" as const,
            content: message.content,
            marker: message.marker ? `${message.marker} | protocol:user-from-system` : "protocol:user-from-system",
        }
        : message);
    return { systemText, rest };
}

/** 把 multipart content 里的图片 part 压平成文本占位（图像识别未启用时使用）。 */
function stripVisionParts(messages: LlmRequestMessage[]): LlmRequestMessage[] {
    return messages.map((message) => {
        if (!Array.isArray(message.content)) return message;
        const text = message.content
            .map((part) => part.type === "text" ? part.text : "[图片]")
            .filter(Boolean)
            .join("\n");
        return { ...message, content: text };
    });
}

export function buildProviderRequest(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LlmRequestMessage[],
    options: ProviderRequestOptions = {},
): LlmRequestPayload {
    const baseUrl = determineBaseUrl(config);
    if (!baseUrl) throw new Error(`API 地址无效：provider=${config.provider}`);
    if (!config.apiKey) throw new Error(`API Key 为空：provider=${config.provider}`);

    const nativeToolProtocol = options.tools && options.tools.length > 0 ? nativeToolProtocolForConfig(config) : null;
    const providerKind = providerKindForConfig(config, { nativeToolProtocol });

    if (options.tools && options.tools.length > 0 && !nativeToolProtocol) {
        throw new Error("当前 API 配置未启用原生工具调用。");
    }

    // 图像识别关闭时的总闸：无论哪条路径塞入了 image_url part，一律降级为
    // "[图片]" 文本，避免不支持视觉的模型（如 DeepSeek）收到 multipart 返回 400。
    const guardedMessages = config.enableImageRecognition === true ? messages : stripVisionParts(messages);
    const providerMessages = ensureProviderHasUserMessage(normalizeNativeToolMessageAdjacency(guardedMessages));

    if (providerKind === "anthropic") {
        return buildAnthropicRequest(config, preset, baseUrl, providerMessages, options);
    }
    if (providerKind === "gemini") {
        return buildGeminiRequest(config, preset, baseUrl, providerMessages, options);
    }
    return buildOpenAICompatibleRequest(config, preset, baseUrl, providerMessages, options);
}

// 剥离逻辑收敛到 api-helpers（更底层，微信助手运行时也照抄同一份正则）；
// 这里保留同名再导出，调用方无需改动。
export { stripHallucinatedTimestamps };

export function buildProviderDebugMessages(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
): LlmDebugMessage[] {
    const request = buildProviderRequest(config, preset, toLlmRequestMessages(messages));
    return debugMessagesFromRequest(request);
}

export function parseProviderResponse(providerKind: LlmProviderKind, data: unknown): LlmParsedResponse {
    const result = providerKind === "anthropic" ? parseAnthropicResponse(data)
        : providerKind === "gemini" ? parseGeminiResponse(data)
        : parseOpenAICompatibleResponse(data);
    result.content = stripHallucinatedTimestamps(result.content);
    return result;
}

export function parseProviderStreamDelta(providerKind: LlmProviderKind, data: unknown): LlmStreamDelta {
    if (providerKind === "anthropic") return parseAnthropicStreamDelta(data);
    if (providerKind === "gemini") return parseGeminiStreamDelta(data);
    return parseOpenAICompatibleStreamDelta(data);
}

function buildSamplingBody(preset: PresetConfig | null): Record<string, unknown> {
    const body: Record<string, unknown> = {
        temperature: preset?.temperature ?? 0.8,
        top_p: preset?.top_p ?? 1.0,
        frequency_penalty: preset?.frequency_penalty ?? 0,
        presence_penalty: preset?.presence_penalty ?? 0,
    };
    if (preset?.openai_max_tokens && preset.openai_max_tokens > 0) body.max_tokens = preset.openai_max_tokens;
    if (preset?.repetition_penalty !== undefined && preset.repetition_penalty !== 1) {
        body.repetition_penalty = preset.repetition_penalty;
    }
    if (preset?.top_k && preset.top_k > 0) body.top_k = preset.top_k;
    if (preset?.min_p && preset.min_p > 0) body.min_p = preset.min_p;
    if (preset?.top_a && preset.top_a > 0) body.top_a = preset.top_a;
    return body;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function shouldStringifyToolSchemaEnums(config: ApiConfig, baseUrl: string): boolean {
    const model = config.defaultModel.toLowerCase();
    const url = baseUrl.toLowerCase();
    return isNativeGoogleApi(config)
        || model.includes("gemini")
        || url.includes("generativelanguage.googleapis.com");
}

function stringifyToolSchemaEnums(value: unknown): Record<string, unknown> {
    const converted = stringifyEnumValues(value);
    return converted && typeof converted === "object" && !Array.isArray(converted)
        ? converted as Record<string, unknown>
        : {};
}

function stringifyEnumValues(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stringifyEnumValues);
    if (!value || typeof value !== "object") return value;

    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
        next[key] = key === "enum" && Array.isArray(item)
            ? item.map((entry) => String(entry))
            : stringifyEnumValues(item);
    }
    return next;
}

function textFromContent(content: string | LLMContentPart[]): string {
    if (typeof content === "string") return content;
    return content.map((part) => part.type === "text" ? part.text : "[vision content omitted]").join("\n");
}

function debugTextFromUnknownContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            const item = asRecord(part);
            if (typeof item.text === "string") return item.text;
            if (item.type === "text" && typeof item.text === "string") return item.text;
            if (item.type === "image_url" || item.image_url) return "[图片]";
            if (item.type === "image" || item.inlineData || item.inline_data) return "[图片]";
            if (item.type === "tool_result") return `[tool_result]\n${String(item.content ?? "")}`;
            if (item.type === "tool_use") return `[tool_use name="${String(item.name ?? "")}"] ${JSON.stringify(item.input ?? {})}`;
            if (item.functionCall) {
                const call = asRecord(item.functionCall);
                return `[function_call name="${String(call.name ?? "")}"] ${JSON.stringify(call.args ?? {})}`;
            }
            if (item.functionResponse) {
                const response = asRecord(item.functionResponse);
                return `[function_response name="${String(response.name ?? "")}"] ${JSON.stringify(response.response ?? {})}`;
            }
            return JSON.stringify(part);
        }).filter(Boolean).join("\n");
    }
    if (content == null) return "";
    return String(content);
}

function debugOpenAIMessageContent(message: Record<string, unknown>): string {
    const parts: string[] = [];
    const content = debugTextFromUnknownContent(message.content);
    if (content) parts.push(content);
    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            const item = asRecord(call);
            const fn = asRecord(item.function);
            parts.push(`[tool_call id="${String(item.id ?? "")}" name="${String(fn.name ?? "")}"] ${String(fn.arguments ?? "{}")}`);
        }
    }
    return parts.join("\n");
}

function debugPartsFromGeminiSystemInstruction(value: unknown): string {
    const item = asRecord(value);
    return debugTextFromUnknownContent(item.parts);
}

export function debugMessagesFromRequest(request: LlmRequestPayload): LlmDebugMessage[] {
    const body = request.body;
    if (request.providerKind === "anthropic") {
        const messages: LlmDebugMessage[] = [];
        if (typeof body.system === "string" && body.system.trim()) {
            messages.push({ role: "system", content: body.system });
        }
        const bodyMessages = Array.isArray(body.messages) ? body.messages : [];
        for (const message of bodyMessages) {
            const item = asRecord(message);
            messages.push({
                role: String(item.role ?? ""),
                content: debugTextFromUnknownContent(item.content),
            });
        }
        return messages;
    }
    if (request.providerKind === "gemini") {
        const messages: LlmDebugMessage[] = [];
        const systemText = debugPartsFromGeminiSystemInstruction(body.systemInstruction);
        if (systemText.trim()) messages.push({ role: "system", content: systemText });
        const contents = Array.isArray(body.contents) ? body.contents : [];
        for (const message of contents) {
            const item = asRecord(message);
            const role = item.role === "model" ? "assistant" : String(item.role ?? "user");
            messages.push({
                role,
                content: debugTextFromUnknownContent(item.parts),
            });
        }
        return messages;
    }
    const bodyMessages = Array.isArray(body.messages) ? body.messages : [];
    return bodyMessages.map((message, index) => {
        const item = asRecord(message);
        return {
            role: String(item.role ?? ""),
            content: debugOpenAIMessageContent(item),
            marker: request.messagesForLog[index]?.marker,
        };
    });
}

function openAIContent(content: string | LLMContentPart[]): string | LLMContentPart[] {
    return content;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
}

function anthropicContentFromParts(content: string | LLMContentPart[]): unknown[] {
    if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
    return content.flatMap<unknown>((part) => {
        if (part.type === "text") return part.text ? [{ type: "text", text: part.text }] : [];
        const parsed = parseDataUrl(part.image_url.url);
        if (!parsed) return [{ type: "text", text: "[image omitted: unsupported image URL]" }];
        return [{
            type: "image",
            source: {
                type: "base64",
                media_type: parsed.mimeType,
                data: parsed.data,
            },
        }];
    });
}

function geminiContentFromParts(content: string | LLMContentPart[]): unknown[] {
    if (typeof content === "string") return content ? [{ text: content }] : [];
    return content.flatMap<unknown>((part) => {
        if (part.type === "text") return part.text ? [{ text: part.text }] : [];
        const parsed = parseDataUrl(part.image_url.url);
        if (!parsed) return [{ text: "[image omitted: unsupported image URL]" }];
        return [{
            inlineData: {
                mimeType: parsed.mimeType,
                data: parsed.data,
            },
        }];
    });
}

function buildOpenAICompatibleRequest(
    config: ApiConfig,
    preset: PresetConfig | null,
    baseUrl: string,
    messages: LlmRequestMessage[],
    options: ProviderRequestOptions,
): LlmRequestPayload {
    const sanitizeToolSchemaEnums = shouldStringifyToolSchemaEnums(config, baseUrl);
    const body: Record<string, unknown> = {
        model: config.defaultModel,
        messages: messages.map((message) => {
            if (message.role === "tool") {
                return {
                    role: "tool",
                    tool_call_id: message.toolCallId,
                    content: message.content,
                };
            }
            if (message.role === "assistant" && message.toolCalls?.length) {
                const assistantMessage: Record<string, unknown> = {
                    role: "assistant",
                    content: message.content || null,
                    tool_calls: message.toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: {
                            name: call.name,
                            arguments: JSON.stringify(call.args),
                        },
                    })),
                };
                if (message.reasoning && shouldEchoReasoningContent(config)) {
                    assistantMessage.reasoning_content = message.reasoning;
                }
                if (config.provider === "OpenRouter" && message.openRouterReasoningDetails?.length) {
                    assistantMessage.reasoning_details = message.openRouterReasoningDetails;
                }
                return assistantMessage;
            }
            return { role: message.role, content: openAIContent(message.content) };
        }),
        ...buildSamplingBody(preset),
    };
    if (options.maxTokens && options.maxTokens > 0) body.max_tokens = Math.floor(options.maxTokens);
    if (options.stream) body.stream = true;
    if (options.tools?.length) {
        body.tools = options.tools.map((tool) => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: sanitizeToolSchemaEnums ? stringifyToolSchemaEnums(tool.parameters) : tool.parameters,
            },
        }));
    }
    return {
        url: buildChatCompletionsUrl(baseUrl),
        headers: buildRequestHeaders(config, baseUrl),
        body,
        providerKind: "openai-compatible",
        messagesForLog: messages.map(messageForLog),
    };
}

function shouldEchoReasoningContent(config: ApiConfig): boolean {
    const provider = config.provider.toLowerCase();
    const model = config.defaultModel.toLowerCase();
    const baseUrl = (config.baseUrl || "").toLowerCase();
    return provider === "deepseek"
        || baseUrl.includes("deepseek")
        || model.includes("deepseek-reasoner")
        || model.includes("deepseek-r1");
}

function buildAnthropicRequest(
    config: ApiConfig,
    preset: PresetConfig | null,
    baseUrl: string,
    messages: LlmRequestMessage[],
    options: ProviderRequestOptions,
): LlmRequestPayload {
    const { systemText: system, rest } = splitLeadingSystemMessages(messages);
    const bodyMessages = compactAnthropicMessages(rest);
    const body: Record<string, unknown> = {
        model: config.defaultModel,
        messages: bodyMessages,
        temperature: preset?.temperature ?? 0.8,
        max_tokens: options.maxTokens && options.maxTokens > 0
            ? Math.floor(options.maxTokens)
            : preset?.openai_max_tokens && preset.openai_max_tokens > 0 ? preset.openai_max_tokens : ANTHROPIC_AUTO_MAX_TOKENS,
    };
    if (preset?.top_p !== undefined) body.top_p = preset.top_p;
    if (preset?.top_k && preset.top_k > 0) body.top_k = preset.top_k;
    if (system) body.system = system;
    if (options.stream) body.stream = true;
    if (options.tools?.length) {
        body.tools = options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
        }));
    }
    return {
        url: `${baseUrl.replace(/\/$/, "")}/messages`,
        headers: buildRequestHeaders(config, baseUrl),
        body,
        providerKind: "anthropic",
        messagesForLog: messages.map(messageForLog),
    };
}

function compactAnthropicMessages(messages: LlmRequestMessage[]): Array<{ role: "user" | "assistant"; content: unknown[] }> {
    const compacted: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
    for (const message of messages) {
        const role = message.role === "assistant" ? "assistant" : "user";
        const content = anthropicContentBlocks(message);
        const last = compacted[compacted.length - 1];
        if (last && last.role === role) last.content.push(...content);
        else compacted.push({ role, content });
    }
    return compacted;
}

function anthropicContentBlocks(message: LlmRequestMessage): unknown[] {
    if (message.role === "tool") {
        return [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }];
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
        return [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: call.args,
            })),
        ];
    }
    return anthropicContentFromParts(message.content);
}

function buildGeminiRequest(
    config: ApiConfig,
    preset: PresetConfig | null,
    baseUrl: string,
    messages: LlmRequestMessage[],
    options: ProviderRequestOptions,
): LlmRequestPayload {
    const { systemText, rest } = splitLeadingSystemMessages(messages);
    const headers = buildRequestHeaders(config, baseUrl);
    delete headers.Authorization;
    const body: Record<string, unknown> = {
        contents: compactGeminiContents(rest),
        generationConfig: {
            temperature: preset?.temperature ?? 0.8,
            topP: preset?.top_p ?? 1,
            ...(preset?.top_k && preset.top_k > 0 ? { topK: preset.top_k } : {}),
            ...(options.maxTokens && options.maxTokens > 0
                ? { maxOutputTokens: Math.floor(options.maxTokens) }
                : preset?.openai_max_tokens && preset.openai_max_tokens > 0 ? { maxOutputTokens: preset.openai_max_tokens } : {}),
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    if (options.tools?.length) {
        body.tools = [{
            functionDeclarations: options.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: stringifyToolSchemaEnums(tool.parameters),
            })),
        }];
    }
    const method = options.stream
        ? `streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`
        : `generateContent?key=${encodeURIComponent(config.apiKey)}`;
    return {
        url: `${baseUrl.replace(/\/$/, "")}/models/${config.defaultModel}:${method}`,
        headers,
        body,
        providerKind: "gemini",
        messagesForLog: messages.map(messageForLog),
    };
}

function compactGeminiContents(messages: LlmRequestMessage[]): Array<{ role: "user" | "model" | "tool"; parts: unknown[] }> {
    const compacted: Array<{ role: "user" | "model" | "tool"; parts: unknown[] }> = [];
    for (const message of messages) {
        const role = message.role === "assistant" ? "model" : message.role === "tool" ? "tool" : "user";
        const parts = geminiParts(message);
        const last = compacted[compacted.length - 1];
        if (last && last.role === role) last.parts.push(...parts);
        else compacted.push({ role, parts });
    }
    return compacted;
}

function geminiParts(message: LlmRequestMessage): unknown[] {
    if (message.role === "tool") {
        return [{
            functionResponse: {
                name: message.name,
                response: { result: message.content },
            },
        }];
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
        // Gemini 2.5+ 多轮工具调用要求把模型原始的 turn 结构完整还原回去：
        //   1. thought 部分（reasoning 文本，thought:true）
        //   2. 普通正文（content）
        //   3. functionCall 部分（同 part 上挂 thoughtSignature）
        // 缺一个上下文都会被 Gemini 当作不完整的 turn 丢弃，导致下一轮看不到任何历史。
        return [
            ...(message.reasoning ? [{ thought: true, text: message.reasoning }] : []),
            ...(message.content ? [{ text: message.content }] : []),
            ...message.toolCalls.map((call) => {
                const hasArgs = call.args && typeof call.args === "object" && Object.keys(call.args).length > 0;
                const part: Record<string, unknown> = {
                    functionCall: {
                        name: call.name,
                        args: hasArgs ? call.args : { noop: "1" },
                    },
                };
                if (call.thoughtSignature) part.thoughtSignature = call.thoughtSignature;
                return part;
            }),
        ];
    }
    return geminiContentFromParts(message.content);
}

function parseOpenAICompatibleResponse(data: unknown): LlmParsedResponse {
    const d = data as {
        choices?: Array<{ message?: { content?: unknown; reasoning_content?: string; reasoning?: string; thinking?: string; reasoning_details?: unknown; reasoningDetails?: unknown; tool_calls?: unknown[] }; text?: string }>;
        output?: { text?: string };
        response?: string;
        usage?: LlmParsedResponse["usage"];
    };
    const message = d.choices?.[0]?.message;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.map(parseOpenAIToolCall) : [];
    const openRouterReasoningDetails = Array.isArray(message?.reasoning_details)
        ? message.reasoning_details
        : Array.isArray(message?.reasoningDetails)
            ? message.reasoningDetails
            : undefined;
    return {
        content: extractOpenAICompatibleText(d),
        reasoning: String(message?.reasoning_content ?? message?.reasoning ?? message?.thinking ?? ""),
        openRouterReasoningDetails,
        toolCalls,
        usage: d.usage,
        raw: data,
    };
}

function extractOpenAICompatibleText(data: {
    choices?: Array<{ message?: { content?: unknown }; text?: string }>;
    output?: { text?: string };
    response?: string;
}): string {
    const messageContent = data.choices?.[0]?.message?.content;
    const messageText = debugTextFromUnknownContent(messageContent).trim();
    if (messageText) return messageText;
    const legacyText = data.choices?.[0]?.text;
    if (typeof legacyText === "string" && legacyText.trim()) return legacyText.trim();
    const outputText = data.output?.text;
    if (typeof outputText === "string" && outputText.trim()) return outputText.trim();
    const responseText = data.response;
    if (typeof responseText === "string" && responseText.trim()) return responseText.trim();
    return "";
}

function parseOpenAIToolCall(value: unknown): LlmToolCall {
    const call = value as { id?: string; function?: { name?: string; arguments?: string } };
    const name = String(call.function?.name ?? "");
    const argsText = String(call.function?.arguments ?? "{}");
    return {
        id: String(call.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        name,
        args: parseStrictArgs(argsText),
    };
}

function parseAnthropicResponse(data: unknown): LlmParsedResponse {
    const d = data as { content?: unknown[]; usage?: { input_tokens?: number; output_tokens?: number } };
    const blocks = Array.isArray(d.content) ? d.content : [];
    let content = "";
    let reasoning = "";
    const toolCalls: LlmToolCall[] = [];
    for (const block of blocks) {
        const item = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string };
        if (item.type === "text") content += item.text ?? "";
        if (item.type === "thinking") reasoning += item.thinking ?? "";
        if (item.type === "tool_use") {
            toolCalls.push({
                id: String(item.id ?? `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
                name: String(item.name ?? ""),
                args: objectArgs(item.input),
            });
        }
    }
    return {
        content,
        reasoning,
        toolCalls,
        usage: d.usage ? {
            prompt_tokens: d.usage.input_tokens,
            completion_tokens: d.usage.output_tokens,
            total_tokens: (d.usage.input_tokens ?? 0) + (d.usage.output_tokens ?? 0),
        } : undefined,
        raw: data,
    };
}

function parseGeminiResponse(data: unknown): LlmParsedResponse {
    const d = data as { candidates?: Array<{ content?: { parts?: unknown[] } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
    const parts = d.candidates?.[0]?.content?.parts || [];
    let content = "";
    let reasoning = "";
    const toolCalls: LlmToolCall[] = [];
    for (const part of parts) {
        const item = part as { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: unknown } };
        if (item.functionCall) {
            const call: LlmToolCall = {
                id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: String(item.functionCall.name ?? ""),
                args: objectArgs(item.functionCall.args),
            };
            // Gemini 2.5+ 把 thoughtSignature 放在和 functionCall 同一个 part 里，必须保留，下一轮请求时回传
            if (item.thoughtSignature) call.thoughtSignature = item.thoughtSignature;
            toolCalls.push(call);
            continue;
        }
        if (item.thought) reasoning += item.text ?? "";
        else content += item.text ?? "";
    }
    return {
        content,
        reasoning,
        toolCalls,
        usage: d.usageMetadata ? {
            prompt_tokens: d.usageMetadata.promptTokenCount,
            completion_tokens: d.usageMetadata.candidatesTokenCount,
            total_tokens: d.usageMetadata.totalTokenCount,
        } : undefined,
        raw: data,
    };
}

function parseOpenAICompatibleStreamDelta(data: unknown): LlmStreamDelta {
    const d = data as {
        choices?: Array<{
            delta?: {
                content?: string;
                reasoning_content?: string;
                reasoning?: string;
                thinking?: string;
                tool_calls?: unknown[];
            };
            text?: string;
        }>;
    };
    const delta = d.choices?.[0]?.delta;
    const toolCallDeltas = Array.isArray(delta?.tool_calls)
        ? delta.tool_calls.map((value, fallbackIndex) => {
            const item = value as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
            return {
                index: typeof item.index === "number" ? item.index : fallbackIndex,
                id: item.id,
                name: item.function?.name,
                argsText: item.function?.arguments,
            };
        })
        : undefined;
    return {
        content: String(delta?.content ?? d.choices?.[0]?.text ?? ""),
        reasoning: String(delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking ?? ""),
        toolCallDeltas,
    };
}

function parseAnthropicStreamDelta(data: unknown): LlmStreamDelta {
    const d = data as {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
    };
    if (d.type === "content_block_start" && d.content_block?.type === "tool_use") {
        return {
            content: "",
            reasoning: "",
            toolCallDeltas: [{
                index: typeof d.index === "number" ? d.index : 0,
                id: d.content_block.id,
                name: d.content_block.name,
                args: objectArgs(d.content_block.input ?? {}),
            }],
        };
    }
    if (d.type !== "content_block_delta") return { content: "", reasoning: "" };
    if (d.delta?.type === "input_json_delta") {
        return {
            content: "",
            reasoning: "",
            toolCallDeltas: [{
                index: typeof d.index === "number" ? d.index : 0,
                argsText: d.delta.partial_json ?? "",
            }],
        };
    }
    if (d.delta?.type === "thinking_delta" || typeof d.delta?.thinking === "string") {
        return { content: "", reasoning: String(d.delta?.thinking ?? "") };
    }
    return { content: String(d.delta?.text ?? ""), reasoning: "" };
}

function parseGeminiStreamDelta(data: unknown): LlmStreamDelta {
    const d = data as { candidates?: Array<{ content?: { parts?: unknown[] } }> };
    const parts = d.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return { content: "", reasoning: "" };
    let content = "";
    let reasoning = "";
    const toolCallDeltas: LlmToolCallDelta[] = [];
    for (const part of parts) {
        const item = part as { text?: string; thought?: boolean; thoughtSignature?: string; type?: string; functionCall?: { name?: string; args?: unknown } };
        if (item.functionCall) {
            const delta: LlmToolCallDelta = {
                index: toolCallDeltas.length,
                id: `gemini_${Date.now()}_${toolCallDeltas.length}`,
                name: String(item.functionCall.name ?? ""),
                args: objectArgs(item.functionCall.args),
            };
            if (item.thoughtSignature) delta.thoughtSignature = item.thoughtSignature;
            toolCallDeltas.push(delta);
            continue;
        }
        if (item.thought || item.type === "thinking" || item.type === "thought") reasoning += item.text ?? "";
        else content += item.text ?? "";
    }
    return { content, reasoning, toolCallDeltas: toolCallDeltas.length > 0 ? toolCallDeltas : undefined };
}

function parseStrictArgs(value: string): Record<string, unknown> {
    if (!value.trim()) return {};
    const parsed = JSON.parse(value) as unknown;
    return objectArgs(parsed);
}

function objectArgs(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    throw new Error("工具参数必须是 JSON object。");
}

function messageForLog(message: LlmRequestMessage): { role: string; content: string | LLMContentPart[]; marker?: string } {
    if (message.role === "tool") {
        return {
            role: "tool",
            content: `[${message.name} result tool_call_id="${message.toolCallId}"]\n${message.content}`,
        };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
        const content = debugTextFromUnknownContent(message.content);
        const toolCallText = message.toolCalls
            .map(call => `[tool_call id="${call.id}" name="${call.name}"] ${JSON.stringify(call.args)}`)
            .join("\n");
        return {
            role: message.role,
            content: [content, toolCallText].filter(Boolean).join("\n"),
            marker: message.marker,
        };
    }
    return {
        role: message.role,
        content: message.content,
        marker: message.marker,
    };
}
