// lib/chat-engine.ts

import { createSseJsonParser } from "./sse-json";
import { loadCharacters } from "./character-storage";
import { buildScreenEffectPromptHint } from "./chat-screen-effects";
import { emitChatPluginEvent, runChatPluginTransform } from "./chat-plugin-hooks";
import { buildChatPluginPromptFragments } from "./chat-plugin-storage";
import type { LlmRequestPayload } from "./chat-plugin-types";
import type { Character } from "./character-types";
import {
    ChatSession,
    ChatMessage,
    loadFollowUpSchedule,
    loadChatAppSettings,
    getMaxToolRounds,
    loadChatSessions,
    saveChatSessions,
    getLatestCharacterStateValues,
    normalizeVisionImagePromptLimit,
    createResponseBatchId,
    createToolExecutionId,
} from "./chat-storage";
import { extractTextToolDirectiveText, stripTextToolDirectives } from "./text-tool-protocol";
import type { ApiConfig, PresetConfig, Prompt, PromptOrderEntry, RegexConfig } from "./settings-types";
import type { CustomAppPromptProfile } from "./custom-app-types";
import {
    resolveBinding,
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload, applyOutputRegex, type LLMMessage, type LLMContentPart } from "./llm-prompt-assembler";
import { MacroEngine, postProcessTrim } from "./macro-engine";
import { getStatusRegionConfig, resolveStatusRegionSection, resolveStatusRegionExampleLine, resolveStatusRegionComposition, resolveStatusRegionFullExample } from "./chat-status-region";
import {
    buildProviderDebugMessages,
    buildProviderRequest,
    debugMessagesFromRequest,
    nativeToolProtocolForConfig,
    parseProviderResponse,
    parseProviderStreamDelta,
    stripHallucinatedTimestamps,
    toLlmRequestMessages,
    type LlmProviderKind,
    type LlmRequestMessage,
    type LlmToolCall,
    type LlmToolCallDelta,
    type LlmToolDefinition,
} from "./llm-provider-adapter";
import { setDebugPromptSnapshot, type DebugPromptSnapshot } from "./debug-store";
import { extractFinishReason } from "./api-helpers";
import { loadMemoryConfig, incrementEventCounter } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { maybeRunSummarization } from "./memory-summarizer";
import { prepareShortTermContext } from "./short-term-assembler";
import { parseActionTags, dispatchActions } from "./action-parser";
import { findEnabledToolForSchema, getEnabledTools, type EnabledTool } from "./tool-storage";
import { formatToolsForPrompt, formatToolSchema } from "./tool-prompt";
import { parseToolCalls, parseToolFetches, executeToolCalls, formatToolResults } from "./tool-executor";
import type { ToolCall, ToolResult } from "./tool-executor";
import { getCustomStickerNames, getCustomStickerExample } from "./custom-sticker-storage";
import { formatCustomAppChatDirectivesForPrompt } from "./custom-app-chat-directives";
import { loadAllTracks } from "./music-storage";
import { getActiveAppTags } from "./content-tag-utils";
import { isNeteaseConfigured, getUserPlaylists, getPlaylistTracks, checkLoginStatus, loadMusicApiConfig } from "./music-service";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { buildCharacterTimeContext } from "./character-time";
import { getPromptTimestampOptionsForTimeContext } from "./prompt-time";
import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";
import { stripStateAndInnerForPrompt } from "./prompt-sanitizer";
import { getInternalCapability, getInternalCapabilitySubToolDefinitions } from "./internal-capability-storage";
import { isMediaStoreRef, loadMediaBlob } from "./media-cache-storage";
import {
    DEFAULT_CHAT_BILINGUAL_PROMPT,
    DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT,
    DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT,
    DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT,
    resolveBilingualPrompt,
} from "./bilingual-prompt-defaults";
import { parseOfflineResponse, type ParsedOfflineResponse } from "./chat-offline-storage";
import { throwIfAborted } from "./abort-utils";
import { armShortcutContinuation, type ShortcutContinuationHandle, type ShortcutContinuationStyle } from "./shortcut-continuation-client";



export class ChatEngineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ChatEngineError";
    }
}

const LLM_IMAGE_MAX_SIDE = 512;
const LLM_IMAGE_JPEG_QUALITY = 0.72;

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(blob);
    });
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("图片解码失败"));
        };
        image.src = url;
    });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob | null> {
    return new Promise((resolve) => {
        canvas.toBlob(resolve, mimeType, quality);
    });
}

function dataUrlToBlob(dataUrl: string): Blob | null {
    const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/);
    if (!match) return null;
    const mimeType = match[1] || "application/octet-stream";
    const isBase64 = Boolean(match[2]);
    try {
        const raw = isBase64 ? atob(match[3]) : decodeURIComponent(match[3]);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        return new Blob([bytes], { type: mimeType });
    } catch {
        return null;
    }
}

export async function readCompressedImageDataUrl(blob: Blob): Promise<string> {
    return (await rasterizeImageBlobToJpegDataUrl(blob)) ?? blobToDataUrl(blob);
}

async function rasterizeImageBlobToJpegDataUrl(blob: Blob): Promise<string | null> {
    if (typeof document === "undefined" || typeof Image === "undefined") {
        return null;
    }

    try {
        const image = await loadImageFromBlob(blob);
        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        if (!sourceWidth || !sourceHeight) return null;

        const scale = Math.min(1, LLM_IMAGE_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;

        context.fillStyle = "#fff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);

        const compressed = await canvasToBlob(canvas, "image/jpeg", LLM_IMAGE_JPEG_QUALITY);
        return compressed ? blobToDataUrl(compressed) : null;
    } catch {
        return null;
    }
}

function getImageRefMimeType(imageRef: string): string {
    const match = imageRef.match(/^data:([^;,]+)/i);
    return match?.[1]?.toLowerCase() ?? "";
}

function isGifMimeType(mimeType: string | undefined): boolean {
    return (mimeType || "").toLowerCase().includes("image/gif");
}

function isLikelyGifImageRef(imageRef: string): boolean {
    if (/^data:image\/gif[;,]/i.test(imageRef)) return true;
    try {
        const parsed = new URL(imageRef);
        return parsed.pathname.toLowerCase().endsWith(".gif");
    } catch {
        return /\.gif(?:$|[?#])/i.test(imageRef);
    }
}

async function fetchRemoteImageBlob(url: string): Promise<Blob | null> {
    if (typeof fetch === "undefined") return null;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return response.blob();
    } catch {
        return null;
    }
}

export async function resolveCompressedImageDataUrl(imageRef: string): Promise<string | null> {
    if (isMediaStoreRef(imageRef)) {
        const result = await loadMediaBlob(imageRef);
        return result ? readCompressedImageDataUrl(result.blob) : null;
    }
    if (imageRef.startsWith("data:image/")) {
        const blob = dataUrlToBlob(imageRef);
        return blob ? readCompressedImageDataUrl(blob) : imageRef;
    }
    return imageRef;
}

type VisionImageResolveResult =
    | { url: string }
    | { drop: true }
    | { keep: true };

async function resolveVisionImageRefForApi(imageRef: string): Promise<VisionImageResolveResult> {
    if (isMediaStoreRef(imageRef)) {
        const result = await loadMediaBlob(imageRef);
        if (!result) return { keep: true };
        if (isGifMimeType(result.mimeType) || isGifMimeType(result.blob.type)) {
            const staticDataUrl = await rasterizeImageBlobToJpegDataUrl(result.blob);
            return staticDataUrl ? { url: staticDataUrl } : { drop: true };
        }
        return { url: await readCompressedImageDataUrl(result.blob) };
    }

    if (imageRef.startsWith("data:image/")) {
        const blob = dataUrlToBlob(imageRef);
        if (!blob) return { keep: true };
        if (isGifMimeType(getImageRefMimeType(imageRef)) || isGifMimeType(blob.type)) {
            const staticDataUrl = await rasterizeImageBlobToJpegDataUrl(blob);
            return staticDataUrl ? { url: staticDataUrl } : { drop: true };
        }
        return { url: await readCompressedImageDataUrl(blob) };
    }

    try {
        const parsed = new URL(imageRef);
        const isLegacyShortcutMedia = parsed.pathname === "/api/push/shortcut-commands/media";
        const isShortcutResultMedia = parsed.pathname.endsWith("/functions/v1/push-shortcut-result")
            && parsed.searchParams.get("download") === "1";
        if (isLegacyShortcutMedia || isShortcutResultMedia) return { drop: true };
    } catch {
        // 非 URL 引用继续交给下方的常规判断。
    }

    if (isLikelyGifImageRef(imageRef)) {
        const blob = await fetchRemoteImageBlob(imageRef);
        if (!blob) return { drop: true };
        const staticDataUrl = await rasterizeImageBlobToJpegDataUrl(blob);
        return staticDataUrl ? { url: staticDataUrl } : { drop: true };
    }

    return { url: imageRef };
}

export async function prepareVisionPromptImageMessage(msg: ChatMessage): Promise<void> {
    if (msg.mediaType === "sticker") {
        if (msg.role !== "user") return;
        const stickerUrl = msg.mediaData?.stickerUrl?.trim();
        if (!stickerUrl) return;
        const result = await resolveVisionImageRefForApi(stickerUrl);
        if ("url" in result) {
            msg.mediaData = { ...(msg.mediaData ?? {}), stickerUrl: result.url };
        } else if ("drop" in result) {
            msg.mediaData = { ...(msg.mediaData ?? {}), stickerUrl: undefined };
        }
        return;
    }

    if (!isVisionPromptImageMessage(msg) || !msg.mediaUrl) return;
    const result = await resolveVisionImageRefForApi(msg.mediaUrl);
    if ("url" in result) {
        msg.mediaUrl = result.url;
    } else if ("drop" in result) {
        msg.mediaUrl = undefined;
    }
}

function isVisionPromptImageMessage(msg: ChatMessage): boolean {
    return msg.mediaType === "image"
        || (msg.role === "user" && msg.mediaType === "sticker" && Boolean(msg.mediaData?.stickerUrl))
        || (msg.mediaType === "media_file" && msg.mediaData?.fileType === "image");
}

function hasVisionPromptImageData(msg: ChatMessage): boolean {
    return msg.mediaType === "sticker"
        ? Boolean(msg.mediaData?.stickerUrl)
        : Boolean(msg.mediaUrl);
}

function stripVisionPromptImageData(msg: ChatMessage): ChatMessage {
    if (msg.mediaType === "sticker") {
        return {
            ...msg,
            mediaData: {
                ...(msg.mediaData ?? {}),
                stickerUrl: undefined,
            },
        };
    }
    return { ...msg, mediaUrl: undefined };
}

export function applyVisionImagePromptLimit(history: ChatMessage[], limitValue: unknown): ChatMessage[] {
    const limit = normalizeVisionImagePromptLimit(limitValue);
    let remaining = limit;

    for (let index = history.length - 1; index >= 0; index -= 1) {
        const msg = history[index];
        if (!isVisionPromptImageMessage(msg) || !hasVisionPromptImageData(msg)) continue;
        if (remaining > 0) {
            remaining -= 1;
            continue;
        }
        history[index] = stripVisionPromptImageData(msg);
    }

    return history;
}

// API Log store — captures recent request/response history for inspection
export type DebugInfo = {
    id: string;
    characterName?: string;
    model?: string;
    messages: { role: string; content: string; marker?: string }[];
    rawResponse: string;
    timestamp: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};
const MAX_API_LOGS = 50;
const API_LOGS_KEY = "ai_phone_api_logs_v1";
registerKvMigration(API_LOGS_KEY);

function _loadLogs(): DebugInfo[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(API_LOGS_KEY) : null;
        return raw ? JSON.parse(raw) as DebugInfo[] : [];
    } catch { return []; }
}
function _saveLogs(logs: DebugInfo[]): void {
    try { kvSet(API_LOGS_KEY, JSON.stringify(logs)); } catch { /* quota exceeded — ignore */ }
}

export function getApiLogs(): DebugInfo[] { return _loadLogs(); }
export function clearApiLogs(): void { try { kvRemove(API_LOGS_KEY); } catch { } }

export type DebugPromptRequestOptions = {
    appId?: string;
    appTags?: string[];
    debugSessionId?: string;
};

type ChatPromptBuildOptions = {
    followUpCount?: number;
    followUpDelay?: number;
    timedWakeElapsedMinutes?: number;
    timedWakeIntent?: string;
    periodCareContext?: string;
    appId?: string;
    appTags?: string[];
    attachedImages?: string[];
    excludeOfflineSessionId?: string;
    promptProfile?: CustomAppPromptProfile;
    extraWorldBookIds?: string[];
    worldBookActivationContext?: string;
    activateAllWorldBooks?: boolean;
    toolsAllowed?: boolean;
    forceEnableTools?: boolean;
};

function matchesPromptProfileRef(prompt: { identifier: string; name?: string }, refs: Set<string>): boolean {
    return refs.has(prompt.identifier) || Boolean(prompt.name && refs.has(prompt.name));
}

export function applyCustomPromptProfileToPreset(preset: PresetConfig, profile: CustomAppPromptProfile): PresetConfig {
    const include = new Set((profile.include ?? []).map(item => item.trim()).filter(Boolean));
    const exclude = new Set((profile.exclude ?? []).map(item => item.trim()).filter(Boolean));
    const includeEnabled = include.size > 0;
    const allowedPrompts = preset.prompts.filter(prompt => {
        if (prompt.forbid_overrides) return true;
        if (exclude.size > 0 && matchesPromptProfileRef(prompt, exclude)) return false;
        if (includeEnabled && !matchesPromptProfileRef(prompt, include)) return false;
        return true;
    });
    const allowedIdentifiers = new Set(allowedPrompts.map(prompt => prompt.identifier));
    const promptOrder = preset.prompt_order
        ?.filter(entry => {
            if (exclude.has(entry.identifier)) return false;
            if (includeEnabled) return include.has(entry.identifier) || allowedIdentifiers.has(entry.identifier);
            return allowedIdentifiers.has(entry.identifier) || !preset.prompts.some(prompt => prompt.identifier === entry.identifier);
        })
        .map(entry => ({ ...entry }));
    return {
        ...preset,
        prompts: allowedPrompts.map(prompt => ({ ...prompt })),
        prompt_order: promptOrder,
    };
}

function mergeAppTags(base: string[] | undefined, extra: string[] | undefined, fallbackAppId: string): string[] | undefined {
    const baseTags = (base ?? []).map(tag => tag.trim()).filter(Boolean);
    const extraTags = (extra ?? []).map(tag => tag.trim()).filter(Boolean);
    const hasExplicitBase = Array.isArray(base);
    const isCustomApp = fallbackAppId.startsWith("custom_app:");
    if (baseTags.length === 0 && extraTags.length === 0) {
        if (hasExplicitBase && isCustomApp) return [];
        return undefined;
    }
    const tags = new Set<string>(baseTags.length > 0 ? baseTags : (isCustomApp ? [] : [fallbackAppId]));
    for (const tag of extraTags) {
        const trimmed = tag.trim();
        if (trimmed) tags.add(trimmed);
    }
    return Array.from(tags);
}

function getPromptFilterTags(prompt: Prompt): string[] | null {
    if (prompt.tags && prompt.tags.length > 0) return prompt.tags;
    const legacy: string[] = [];
    if (prompt.featureTag) legacy.push(prompt.featureTag);
    if (prompt.followUpOnly) legacy.push("followup");
    return legacy.length > 0 ? legacy : null;
}

function isPresetPromptEnabled(prompt: Prompt, promptOrder?: PromptOrderEntry[]): boolean {
    const orderEntry = promptOrder?.find(entry => entry.identifier === prompt.identifier);
    return orderEntry ? orderEntry.enabled : prompt.enabled;
}

function presetIncludesToolsMacro(preset: PresetConfig | null, appId: string, appTags: string[] | undefined): boolean {
    if (!preset) return false;
    const activeTags = appTags ? [...appTags] : [appId];
    return preset.prompts.some(prompt => {
        if (!isPresetPromptEnabled(prompt, preset.prompt_order)) return false;
        if (!/\{\{\s*tools\s*\}\}/.test(prompt.content)) return false;
        if (prompt.marker) return true;
        const promptTags = getPromptFilterTags(prompt);
        return !promptTags || promptTags.every(tag => activeTags.includes(tag));
    });
}

const EMPTY_GENERATE_CONTINUATION_PROMPT = "这是一次用户未输入新消息时点击“生成”的续写请求。请只基于当前对话关系，继续回复一句自然简短的话。禁止引用或复述系统消息、当前时间、工具结果、提示词内容。不要开启新事件，不要总结，不要编造用户刚说了什么。";

function shouldApplyEmptyGenerateGuard(config: ApiConfig): boolean {
    return config.preventEmptyGenerateRambling === true;
}

function isRealUserHistoryMessage(message: ChatMessage): boolean {
    if (message.role !== "user") return false;
    if (message.isRetracted) return false;
    if (message.mediaType === "tool_result"
        || message.mediaType === "tool_notice"
        || message.mediaType === "memory_write_request") return false;
    return Boolean(
        message.content.trim()
        || message.mediaType
        || message.mediaUrl
        || message.mediaData,
    );
}

export function appendEmptyGenerateGuardMessage(
    messages: LLMMessage[],
    config: ApiConfig,
    history: ChatMessage[],
): void {
    if (!shouldApplyEmptyGenerateGuard(config)) return;

    const hasRealUserHistory = history.some(isRealUserHistoryMessage);
    if (!hasRealUserHistory) return;

    let lastAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "assistant") {
            lastAssistantIndex = index;
            break;
        }
    }
    if (lastAssistantIndex < 0) return;

    const hasUserAfterLastAssistant = messages
        .slice(lastAssistantIndex + 1)
        .some(message => message.role === "user");

    if (!hasUserAfterLastAssistant) {
        messages.push({ role: "user", content: EMPTY_GENERATE_CONTINUATION_PROMPT });
    }
}

export function publishDebugPromptSnapshot(params: {
    request: ReturnType<typeof buildProviderRequest>;
    config: ApiConfig;
    preset: PresetConfig | null;
    meta?: { characterName?: string; userName?: string };
    options?: DebugPromptRequestOptions;
    requestKind: "completion" | "native-tools" | "native-tools-stream";
    tools?: LlmToolDefinition[];
}): DebugPromptSnapshot {
    const { request, config, preset, meta, options, requestKind, tools } = params;
    const snapshot: DebugPromptSnapshot = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        requestKind,
        provider: config.provider,
        providerKind: request.providerKind,
        model: config.defaultModel,
        appId: options?.appId ?? "chat",
        appTags: options?.appTags,
        sessionId: options?.debugSessionId,
        characterName: meta?.characterName,
        presetName: preset?.name || "默认预设",
        messages: debugMessagesFromRequest(request),
        tools: tools?.map(tool => ({ name: tool.name, description: tool.description })),
    };
    if (typeof window !== "undefined") setDebugPromptSnapshot(snapshot);
    return snapshot;
}

// Re-export for backward compatibility — canonical source is api-helpers.ts
export { determineBaseUrl } from "./api-helpers";

type PreparedApiMessage = {
    role: string;
    content: string | LLMContentPart[];
    marker?: string;
};

/**
 * 聊天插件 llm.request 织入：让插件在请求发出前改写 messages / 采样参数。
 * 四个 sendLLM*Request 入口统一走这里；无插件时零开销直通。
 */
async function applyChatPluginLlmRequest<T extends { role: string }>(
    preset: PresetConfig | null,
    messages: T[],
    purpose: string,
    sessionId?: string,
): Promise<{ messages: T[]; preset: PresetConfig | null }> {
    if (typeof window === "undefined") return { messages, preset };
    const payload = await runChatPluginTransform("llm.request", {
        messages: messages as unknown as LlmRequestPayload["messages"],
        purpose,
        sessionId,
    });
    let nextPreset = preset;
    if (preset && (payload.temperature !== undefined || payload.maxTokens !== undefined)) {
        nextPreset = { ...preset };
        if (payload.temperature !== undefined) nextPreset.temperature = payload.temperature;
        if (payload.maxTokens !== undefined) nextPreset.openai_max_tokens = payload.maxTokens;
    }
    const nextMessages = Array.isArray(payload.messages)
        ? payload.messages as unknown as T[]
        : messages;
    return { messages: nextMessages, preset: nextPreset };
}

/** 聊天插件 llm.response 织入：模型原始回复在内置正则处理前交给插件改写 */
async function applyChatPluginLlmResponse(text: string, purpose: string, sessionId?: string): Promise<string> {
    if (typeof window === "undefined") return text;
    const payload = await runChatPluginTransform("llm.response", { text, sessionId, purpose });
    return typeof payload.text === "string" ? payload.text : text;
}

export function prepareMessagesForApi(
    provider: string,
    messages: LLMMessage[],
): {
    apiMessages: PreparedApiMessage[];
    extractedSystemPrompt?: string;
} {
    void provider;
    const apiMessages: PreparedApiMessage[] = [];
    for (const message of toLlmRequestMessages(messages)) {
        if (message.role === "tool") {
            apiMessages.push({
                role: "tool",
                content: `[tool_result name="${message.name}" tool_call_id="${message.toolCallId}"]\n${message.content}`,
                marker: message.marker,
            });
            continue;
        }
        if (message.role === "assistant" && message.toolCalls?.length) {
            const toolCallText = message.toolCalls
                .map(call => `[tool_call id="${call.id}" name="${call.name}"] ${JSON.stringify(call.args)}`)
                .join("\n");
            apiMessages.push({
                role: "assistant",
                content: [message.content, toolCallText].filter(Boolean).join("\n"),
                marker: message.marker,
            });
            continue;
        }
        apiMessages.push({
            role: message.role,
            content: message.content,
            marker: message.marker,
        });
    }
    return { apiMessages };
}

export function previewMessagesForApi(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
): LLMMessage[] {
    return buildProviderDebugMessages(config, preset, messages).map(message => ({
        role: message.role as LLMMessage["role"],
        content: message.content,
        _debugMeta: { marker: message.marker },
    }));
}

export type ChatCompletionStreamResult = {
    content: string;
    rawResponse: string;
    providerKind: LlmProviderKind;
};

export type ChatCompletionStreamCallbacks = {
    onDelta?: (text: string) => void | Promise<void>;
    onReasoningDelta?: (text: string) => void | Promise<void>;
    onToolCallStart?: (info: { id: string; name: string; index: number }) => void | Promise<void>;
};

function attachExternalAbort(internal: AbortController, external?: AbortSignal): () => void {
    if (!external) return () => {};
    if (external.aborted) {
        internal.abort();
        return () => {};
    }
    const handler = () => internal.abort();
    external.addEventListener("abort", handler);
    return () => external.removeEventListener("abort", handler);
}

function parseSseEvents(buffer: string): { events: string[]; rest: string } {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n\n");
    return {
        events: parts.slice(0, -1),
        rest: parts[parts.length - 1] || "",
    };
}

function createStreamingTimestampStripper() {
    const tailLength = 64;
    let pending = "";
    return {
        push(text: string): string {
            pending += text;
            if (pending.length <= tailLength) return "";
            let emitEnd = pending.length - tailLength;
            const nearbyParen = pending.lastIndexOf("(", emitEnd);
            if (nearbyParen >= Math.max(0, emitEnd - tailLength)) {
                emitEnd = nearbyParen;
            }
            if (emitEnd <= 0) return "";
            const emit = pending.slice(0, emitEnd);
            pending = pending.slice(emitEnd);
            return stripHallucinatedTimestamps(emit);
        },
        flush(): string {
            const emit = stripHallucinatedTimestamps(pending);
            pending = "";
            return emit;
        },
    };
}

function emptyResponseDetails(data: unknown): {
    finishReason?: string;
    blockReason?: string;
    safetyRatings?: unknown;
    message: string;
} {
    const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const finishReason = extractFinishReason(d);
    const candidates = Array.isArray(d.candidates) ? d.candidates : [];
    const firstCandidate = candidates[0] && typeof candidates[0] === "object" ? candidates[0] as Record<string, unknown> : {};
    const promptFeedback = d.promptFeedback && typeof d.promptFeedback === "object" ? d.promptFeedback as Record<string, unknown> : {};
    const blockReason = typeof promptFeedback.blockReason === "string" ? promptFeedback.blockReason : undefined;
    const safetyRatings = firstCandidate.safetyRatings;
    const message = `LLM returned empty content${finishReason ? ` (finishReason: ${finishReason})` : ""}${blockReason ? ` (blockReason: ${blockReason})` : ""}.`;
    return { finishReason, blockReason, safetyRatings, message };
}

async function readSseStream(
    response: Response,
    providerKind: ChatCompletionStreamResult["providerKind"],
    callbacks?: ChatCompletionStreamCallbacks,
    stripTimestamps = true,
): Promise<{ content: string; rawResponse: string }> {
    if (!response.body) throw new ChatEngineError("流式响应没有 body。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let rawResponse = "";
    // 时间戳剥离器会一直扣住流尾巴的 64 个字符等括号闭合，流结束才吐出来。
    // 要求"所见即模型所写"的调用方（独家特调）把它整个关掉：增量来一个字出一个字，
    // 否则模型在末尾写机括标记行（〔记〕这类）时，整行都压在扣留窗里，看起来像卡死。
    const contentStripper = stripTimestamps
        ? createStreamingTimestampStripper()
        : { push: (text: string) => text, flush: () => "" };

    // 容错解析：中转把长 JSON 行切开时做碎片重组，不再静默丢增量（见 sse-json.ts）
    const sseParser = createSseJsonParser();
    const handleParsed = async (parsed: unknown) => {
        const parts = parseProviderStreamDelta(providerKind, parsed);
        if (parts.reasoning) {
            await callbacks?.onReasoningDelta?.(parts.reasoning);
        }
        if (parts.content) {
            const cleanDelta = contentStripper.push(parts.content);
            if (cleanDelta) {
                content += cleanDelta;
                await callbacks?.onDelta?.(cleanDelta);
            }
        }
    };
    const handleEvent = async (eventText: string) => {
        // 原始流只为调试快照保留头部：长输出整条累积会把低内存设备的 WebView 顶爆
        if (rawResponse.length < 65_536) rawResponse += `${eventText}\n`;
        for (const parsed of sseParser.pushEvent(eventText)) {
            await handleParsed(parsed);
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
    if (buffer.trim()) {
        await handleEvent(buffer);
    }
    for (const parsed of sseParser.flush()) {
        await handleParsed(parsed);
    }
    const finalContent = contentStripper.flush();
    if (finalContent) {
        content += finalContent;
        await callbacks?.onDelta?.(finalContent);
    }
    return { content, rawResponse };
}

export async function sendLLMStreamRequest(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
    regexes: RegexConfig[],
    meta?: { characterName?: string; userName?: string },
    options?: {
        skipOutputRegex?: boolean;
        /** 不剥幻觉时间戳：流式增量原样直出（不扣尾巴），落库文本与流出的一字不差 */
        skipTimestampStrip?: boolean;
        includeReasoning?: boolean;
        appId?: string;
        appTags?: string[];
        followUpCount?: number;
        signal?: AbortSignal;
    },
    callbacks?: ChatCompletionStreamCallbacks,
): Promise<ChatCompletionStreamResult> {
    const pluginPurpose = options?.appId ?? "chat";
    const afterPlugins = await applyChatPluginLlmRequest(preset, messages, pluginPurpose);
    const effectivePreset = afterPlugins.preset;
    const originalOnDelta = callbacks?.onDelta;
    const pluginCallbacks: ChatCompletionStreamCallbacks | undefined = callbacks ? {
        ...callbacks,
        onDelta: (text: string) => {
            emitChatPluginEvent("llm.streamChunk", { chunk: text, purpose: pluginPurpose });
            return originalOnDelta?.(text);
        },
    } : undefined;
    const requestMessages = toLlmRequestMessages(afterPlugins.messages);
    const request = buildProviderRequest(config, effectivePreset, requestMessages, { stream: true });
    const requestBodyJson = JSON.stringify(request.body);
    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const detachExternalAbort = attachExternalAbort(llmAbort, options?.signal);

    try {
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: requestBodyJson,
            signal: llmAbort.signal,
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new ChatEngineError(`API Stream Error ${response.status}: ${errorText}`);
        }
        const { content: streamedContent, rawResponse } = await readSseStream(response, request.providerKind, pluginCallbacks ?? callbacks, !options?.skipTimestampStrip);
        if (!streamedContent.trim()) {
            throw new ChatEngineError("流式响应没有解析到文本增量。");
        }
        let rawOutput = options?.skipTimestampStrip ? streamedContent.trim() : stripHallucinatedTimestamps(streamedContent.trim());
        rawOutput = await applyChatPluginLlmResponse(rawOutput, pluginPurpose);

        // Store API log entry — mirror sendLLMRequest so streaming calls also show up
        // in the "底层调用大模型日志" panel.
        const sanitizedMessages = request.messagesForLog.map(m => ({
            ...m,
            content: typeof m.content === "string" ? m.content : "[vision: 含图片的多模态消息]",
        }));
        const logEntry: DebugInfo = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            characterName: meta?.characterName,
            model: config.defaultModel,
            messages: sanitizedMessages,
            rawResponse: rawOutput,
            timestamp: new Date().toISOString(),
        };
        const logs = _loadLogs();
        logs.push(logEntry);
        while (logs.length > MAX_API_LOGS) logs.shift();
        _saveLogs(logs);

        if (!options?.skipOutputRegex) {
            const macroEngine = new MacroEngine(meta?.characterName ?? "", meta?.userName ?? "用户");
            const activeTags = getActiveAppTags(options?.appId ?? "chat", {
                appTags: options?.appTags,
                followUpCount: options?.followUpCount,
            });
            rawOutput = applyOutputRegex(rawOutput, regexes, { macroEngine, activeTags });
        }
        return { content: rawOutput, rawResponse, providerKind: request.providerKind };
    } catch (error: unknown) {
        if (error instanceof DOMException && (error as DOMException).name === "AbortError") {
            if (options?.signal?.aborted) throw error;
            throw new ChatEngineError("AI 流式回复超时（500秒），请重试。");
        }
        if (error instanceof ChatEngineError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new ChatEngineError(`Stream Network Error connecting to AI Provider: ${detail}`);
    } finally {
        clearTimeout(llmTimeout);
        detachExternalAbort();
    }
}

/**
 * Shared LLM HTTP request: provider normalization → consecutive same-role merge → API call → log → output regex.
 * Used by both generateChatCompletion (1:1 chat) and generateGroupChatCompletion (group chat).
 */
export async function sendLLMRequest(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
    regexes: RegexConfig[],
    meta?: { characterName?: string; userName?: string },
    options?: {
        skipOutputRegex?: boolean;
        includeReasoning?: boolean;
        /** 供调用方捕获模型思维链（reasoning）内容，不影响返回文本 */
        onReasoning?: (text: string) => void;
        appId?: string;
        appTags?: string[];
        followUpCount?: number;
        debugSessionId?: string;
        signal?: AbortSignal;
    },
): Promise<string> {
    const pluginPurpose = options?.appId ?? "chat";
    const afterPlugins = await applyChatPluginLlmRequest(preset, messages, pluginPurpose, options?.debugSessionId);
    const effectivePreset = afterPlugins.preset;
    const requestMessages = toLlmRequestMessages(afterPlugins.messages);
    const request = buildProviderRequest(config, effectivePreset, requestMessages);
    publishDebugPromptSnapshot({ request, config, preset: effectivePreset, meta, options, requestKind: "completion" });
    const requestBodyJson = JSON.stringify(request.body);
    const requestBodySize = requestBodyJson.length;
    const requestTokenEstimate = Math.ceil(requestBodySize / 3);
    const messageSizes = request.messagesForLog.map((message) => (
        typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length
    ));
    const largestMessage = messageSizes.reduce(
        (largest, size, index) => (size > largest.size ? { index, size, role: request.messagesForLog[index]?.role ?? "" } : largest),
        { index: -1, size: 0, role: "" },
    );
    const requestDebugInfo = {
        provider: config.provider,
        model: config.defaultModel,
        appId: options?.appId ?? "chat",
        messageCount: request.messagesForLog.length,
        bodySize: requestBodySize,
        bodyTokenEstimate: requestTokenEstimate,
        largestMessageIndex: largestMessage.index,
        largestMessageRole: largestMessage.role,
        largestMessageSize: largestMessage.size,
    };

    console.log("[ChatEngine] Message roles:", request.messagesForLog.map((m, i) => `${i}:${m.role}`).join(" → "));
    console.log("[ChatEngine] Request:", requestDebugInfo);

    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const detachExternalAbort = attachExternalAbort(llmAbort, options?.signal);

    try {
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: requestBodyJson,
            signal: llmAbort.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new ChatEngineError(`API Error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const parsed = parseProviderResponse(request.providerKind, data);
        let rawOutput = parsed.content || "";

        if (parsed.reasoning) {
            try { options?.onReasoning?.(parsed.reasoning); } catch { /* 捕获回调异常，不影响主流程 */ }
        }

        // Prepend reasoning content as <think> block (only when caller requests it, e.g. story mode)
        if (options?.includeReasoning) {
            const reasoning = parsed.reasoning || "";
            if (reasoning) {
                rawOutput = `<think>\n${reasoning}\n</think>\n\n${rawOutput}`;
            }
        }

        rawOutput = await applyChatPluginLlmResponse(rawOutput, pluginPurpose, options?.debugSessionId);

        if (!rawOutput && parsed.toolCalls.length === 0) {
            const emptyDetails = emptyResponseDetails(parsed.raw);
            console.warn("[ChatEngine] Empty response from API!", {
                provider: config.provider,
                model: config.defaultModel,
                finishReason: emptyDetails.finishReason,
                blockReason: emptyDetails.blockReason,
                safetyRatings: emptyDetails.safetyRatings,
                fullData: JSON.stringify(data).slice(0, 1000),
            });
            throw new ChatEngineError(emptyDetails.message);
        }

        // Store API log entry (strip base64 image data to avoid bloating localStorage)
        const sanitizedMessages = request.messagesForLog.map(m => ({
            ...m,
            content: typeof m.content === "string" ? m.content : "[vision: 含图片的多模态消息]",
        }));
        const logEntry: DebugInfo = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            characterName: meta?.characterName,
            model: config.defaultModel,
            messages: sanitizedMessages,
            rawResponse: rawOutput,
            timestamp: new Date().toISOString(),
            usage: parsed.usage,
        };
        const logs = _loadLogs();
        logs.push(logEntry);
        while (logs.length > MAX_API_LOGS) logs.shift();
        _saveLogs(logs);

        if (options?.skipOutputRegex) {
            return rawOutput;
        }
        // Apply Output Regex Filters
        const macroEngine = new MacroEngine(meta?.characterName ?? "", meta?.userName ?? "用户");
        const activeTags = getActiveAppTags(options?.appId ?? "chat", {
            appTags: options?.appTags,
            followUpCount: options?.followUpCount,
        });
        return applyOutputRegex(rawOutput, regexes, { macroEngine, activeTags });
    } catch (error: unknown) {
        if (error instanceof DOMException && (error as DOMException).name === "AbortError") {
            throw new ChatEngineError("AI 回复超时（500秒），请重试。");
        }
        if (error instanceof ChatEngineError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new ChatEngineError(
            `Network Error connecting to AI Provider: ${detail}\n请求诊断：provider=${requestDebugInfo.provider}, model=${requestDebugInfo.model}, app=${requestDebugInfo.appId}, messages=${requestDebugInfo.messageCount}, bodySize=${requestDebugInfo.bodySize}, estimatedTokens=${requestDebugInfo.bodyTokenEstimate}, largestMessage=${requestDebugInfo.largestMessageSize}, largestRole=${requestDebugInfo.largestMessageRole}, largestIndex=${requestDebugInfo.largestMessageIndex}`,
        );
    } finally {
        clearTimeout(llmTimeout);
        detachExternalAbort();
    }
}

export type LLMToolRequestResult = {
    content: string;
    reasoning?: string;
    openRouterReasoningDetails?: unknown[];
    toolCalls: LlmToolCall[];
    /** 参数 JSON 被截断（输出上限/连接中断）而丢弃的调用名——调用方据此提示重试/分段 */
    truncatedToolCalls?: string[];
    rawResponse: string;
    providerKind: LlmProviderKind;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type StreamToolCallDraft = {
    id?: string;
    name?: string;
    argsText: string;
    args?: Record<string, unknown>;
    thoughtSignature?: string;
};

function mergeToolCallDelta(drafts: Map<number, StreamToolCallDraft>, delta: LlmToolCallDelta): void {
    const current = drafts.get(delta.index) || { argsText: "" };
    drafts.set(delta.index, {
        id: delta.id ?? current.id,
        name: delta.name ?? current.name,
        argsText: current.argsText + (delta.argsText ?? ""),
        args: delta.args ?? (delta.argsText ? undefined : current.args),
        thoughtSignature: delta.thoughtSignature ?? current.thoughtSignature,
    });
}

function finalizeStreamToolCalls(drafts: Map<number, StreamToolCallDraft>): { calls: LlmToolCall[]; truncatedNames: string[] } {
    const calls: LlmToolCall[] = [];
    const truncatedNames: string[] = [];
    for (const [index, draft] of [...drafts.entries()].sort(([a], [b]) => a - b)) {
        if (!draft.name) continue;
        let args: unknown = draft.args;
        if (args == null) {
            try {
                args = JSON.parse(draft.argsText || "{}") as unknown;
            } catch {
                // 参数 JSON 残缺：模型被输出上限/连接中断掐断在调用中途。
                // 不再抛错杀掉整轮（症状：Unterminated string）——丢弃该调用并记录，交调用方提示重试/分段
                truncatedNames.push(draft.name);
                continue;
            }
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) {
            truncatedNames.push(draft.name);
            continue;
        }
        const call: LlmToolCall = {
            id: draft.id || `tool_${Date.now()}_${index}`,
            name: draft.name,
            args: args as Record<string, unknown>,
        };
        if (draft.thoughtSignature) call.thoughtSignature = draft.thoughtSignature;
        calls.push(call);
    }
    return { calls, truncatedNames };
}

export async function sendLLMToolStreamRequest(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LlmRequestMessage[],
    tools: LlmToolDefinition[],
    regexes: RegexConfig[],
    meta?: { characterName?: string; userName?: string },
    options?: {
        appId?: string;
        appTags?: string[];
        followUpCount?: number;
        debugSessionId?: string;
        signal?: AbortSignal;
        /** 单次最大输出 token：按调用覆盖预设值（工坊输出护栏用） */
        maxTokens?: number;
    },
    callbacks?: ChatCompletionStreamCallbacks,
): Promise<LLMToolRequestResult> {
    void regexes;
    const pluginPurpose = options?.appId ?? "chat";
    const afterPlugins = await applyChatPluginLlmRequest(preset, messages, pluginPurpose, options?.debugSessionId);
    const effectivePreset = afterPlugins.preset;
    const request = buildProviderRequest(config, effectivePreset, afterPlugins.messages, { tools, stream: true, maxTokens: options?.maxTokens });
    publishDebugPromptSnapshot({ request, config, preset: effectivePreset, meta, options, requestKind: "native-tools-stream", tools });
    const requestBodyJson = JSON.stringify(request.body);
    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const detachExternalAbort = attachExternalAbort(llmAbort, options?.signal);
    let rawResponse = "";
    let content = "";
    let reasoning = "";
    const contentStripper = createStreamingTimestampStripper();
    const toolDrafts = new Map<number, StreamToolCallDraft>();
    const firedToolCallStarts = new Set<number>();

    try {
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: requestBodyJson,
            signal: llmAbort.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new ChatEngineError(`API Tool Stream Error ${response.status}: ${errorText}`);
        }
        if (!response.body) throw new ChatEngineError("原生动作流式响应没有 body。");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // 容错解析：中转把超长工具参数 JSON 行切开时做碎片重组，
        // 不再因单行 JSON Parse error 杀掉整条流（写 APP 大参数时高发）
        const sseParser = createSseJsonParser();
        const handleParsedDelta = async (data: unknown) => {
            {
                    const delta = parseProviderStreamDelta(request.providerKind, data);
                    if (delta.reasoning) {
                        reasoning += delta.reasoning;
                        await callbacks?.onReasoningDelta?.(delta.reasoning);
                    }
                    if (delta.content) {
                        const cleanDelta = contentStripper.push(delta.content);
                        if (cleanDelta) {
                            content += cleanDelta;
                            emitChatPluginEvent("llm.streamChunk", { chunk: cleanDelta, sessionId: options?.debugSessionId, purpose: pluginPurpose });
                            await callbacks?.onDelta?.(cleanDelta);
                        }
                    }
                    for (const toolDelta of delta.toolCallDeltas || []) {
                        mergeToolCallDelta(toolDrafts, toolDelta);
                        if (!firedToolCallStarts.has(toolDelta.index)) {
                            const draft = toolDrafts.get(toolDelta.index);
                            if (draft?.name) {
                                firedToolCallStarts.add(toolDelta.index);
                                if (!draft.id) {
                                    draft.id = `tool_${Date.now()}_${toolDelta.index}`;
                                    toolDrafts.set(toolDelta.index, draft);
                                }
                                await callbacks?.onToolCallStart?.({
                                    id: draft.id,
                                    name: draft.name,
                                    index: toolDelta.index,
                                });
                            }
                        }
                    }
            }
        };
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseSseEvents(buffer);
            buffer = parsed.rest;
            for (const event of parsed.events) {
                if (rawResponse.length < 65_536) rawResponse += `${event}\n`;
                for (const data of sseParser.pushEvent(event)) {
                    await handleParsedDelta(data);
                }
            }
        }

        if (buffer.trim()) {
            if (rawResponse.length < 65_536) rawResponse += buffer.trim();
            for (const data of sseParser.pushEvent(buffer)) {
                await handleParsedDelta(data);
            }
        }
        for (const data of sseParser.flush()) {
            await handleParsedDelta(data);
        }
        const finalContent = contentStripper.flush();
        if (finalContent) {
            content += finalContent;
            await callbacks?.onDelta?.(finalContent);
        }
        content = await applyChatPluginLlmResponse(content, pluginPurpose, options?.debugSessionId);

        const sanitizedMessages = request.messagesForLog.map(m => ({
            ...m,
            content: typeof m.content === "string" ? m.content : "[vision: 含图片的多模态消息]",
        }));
        const { calls: toolCalls, truncatedNames } = finalizeStreamToolCalls(toolDrafts);
        const logEntry: DebugInfo = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            characterName: meta?.characterName,
            model: config.defaultModel,
            messages: sanitizedMessages,
            rawResponse: JSON.stringify({ content, reasoning, toolCalls, raw: rawResponse }),
            timestamp: new Date().toISOString(),
        };
        const logs = _loadLogs();
        logs.push(logEntry);
        while (logs.length > MAX_API_LOGS) logs.shift();
        _saveLogs(logs);

        if (!content && toolCalls.length === 0 && truncatedNames.length === 0) {
            throw new ChatEngineError("原生动作流式响应没有解析到文本或动作。");
        }

        return {
            content,
            reasoning,
            openRouterReasoningDetails: undefined,
            toolCalls,
            truncatedToolCalls: truncatedNames.length ? truncatedNames : undefined,
            rawResponse: logEntry.rawResponse,
            providerKind: request.providerKind,
        };
    } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
            if (options?.signal?.aborted) throw error;
            throw new ChatEngineError("AI 原生动作流式回复超时（500秒），请重试。");
        }
        if (error instanceof ChatEngineError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new ChatEngineError(`Tool Stream Network Error connecting to AI Provider: ${detail}`);
    } finally {
        clearTimeout(llmTimeout);
        detachExternalAbort();
    }
}

export async function sendLLMToolRequest(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LlmRequestMessage[],
    tools: LlmToolDefinition[],
    regexes: RegexConfig[],
    meta?: { characterName?: string; userName?: string },
    options?: {
        skipOutputRegex?: boolean;
        includeReasoning?: boolean;
        appId?: string;
        appTags?: string[];
        followUpCount?: number;
        debugSessionId?: string;
        signal?: AbortSignal;
    },
): Promise<LLMToolRequestResult> {
    const pluginPurpose = options?.appId ?? "chat";
    const afterPlugins = await applyChatPluginLlmRequest(preset, messages, pluginPurpose, options?.debugSessionId);
    const effectivePreset = afterPlugins.preset;
    const request = buildProviderRequest(config, effectivePreset, afterPlugins.messages, { tools });
    publishDebugPromptSnapshot({ request, config, preset: effectivePreset, meta, options, requestKind: "native-tools", tools });
    const requestBodyJson = JSON.stringify(request.body);
    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const detachExternalAbort = attachExternalAbort(llmAbort, options?.signal);

    try {
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: requestBodyJson,
            signal: llmAbort.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new ChatEngineError(`API Tool Error ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const parsed = parseProviderResponse(request.providerKind, data);
        let rawOutput = parsed.content || "";
        if (options?.includeReasoning && parsed.reasoning) {
            rawOutput = `<think>\n${parsed.reasoning}\n</think>\n\n${rawOutput}`;
        }
        rawOutput = await applyChatPluginLlmResponse(rawOutput, pluginPurpose, options?.debugSessionId);

        rawOutput = await applyChatPluginLlmResponse(rawOutput, pluginPurpose, options?.debugSessionId);

        if (!rawOutput && parsed.toolCalls.length === 0) {
            const emptyDetails = emptyResponseDetails(parsed.raw);
            console.warn("[ChatEngine] Empty native tool response from API!", {
                provider: config.provider,
                model: config.defaultModel,
                finishReason: emptyDetails.finishReason,
                blockReason: emptyDetails.blockReason,
                safetyRatings: emptyDetails.safetyRatings,
                fullData: JSON.stringify(data).slice(0, 1000),
            });
            throw new ChatEngineError(emptyDetails.message);
        }

        const sanitizedMessages = request.messagesForLog.map(m => ({
            ...m,
            content: typeof m.content === "string" ? m.content : "[vision: 含图片的多模态消息]",
        }));
        const rawResponse = JSON.stringify({
            content: parsed.content,
            reasoning: parsed.reasoning,
            openRouterReasoningDetails: parsed.openRouterReasoningDetails,
            toolCalls: parsed.toolCalls,
            raw: parsed.raw,
        });
        const logEntry: DebugInfo = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            characterName: meta?.characterName,
            model: config.defaultModel,
            messages: sanitizedMessages,
            rawResponse,
            timestamp: new Date().toISOString(),
            usage: parsed.usage,
        };
        const logs = _loadLogs();
        logs.push(logEntry);
        while (logs.length > MAX_API_LOGS) logs.shift();
        _saveLogs(logs);

        if (!options?.skipOutputRegex && rawOutput) {
            const macroEngine = new MacroEngine(meta?.characterName ?? "", meta?.userName ?? "用户");
            const activeTags = getActiveAppTags(options?.appId ?? "chat", {
                appTags: options?.appTags,
                followUpCount: options?.followUpCount,
            });
            rawOutput = applyOutputRegex(rawOutput, regexes, { macroEngine, activeTags });
        }

        return {
            content: rawOutput,
            reasoning: parsed.reasoning,
            openRouterReasoningDetails: parsed.openRouterReasoningDetails,
            toolCalls: parsed.toolCalls,
            rawResponse,
            providerKind: request.providerKind,
            usage: parsed.usage,
        };
    } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
            if (options?.signal?.aborted) throw error;
            throw new ChatEngineError("AI 原生动作回复超时（500秒），请重试。");
        }
        if (error instanceof ChatEngineError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new ChatEngineError(`Tool Network Error connecting to AI Provider: ${detail}`);
    } finally {
        clearTimeout(llmTimeout);
        detachExternalAbort();
    }
}

// ── Persisted music sync data (localStorage, updated by user via sync button) ──
const MUSIC_SYNC_KEY = "ai_phone_music_sync_v1";
registerKvMigration(MUSIC_SYNC_KEY);

type MusicSyncData = {
    loggedIn: boolean;
    playlistSummary: string;
    localSummary: string;
    syncedAt: string; // ISO date
};

function loadMusicSyncData(): MusicSyncData | null {
    try {
        const raw = typeof window !== "undefined" ? kvGet(MUSIC_SYNC_KEY) : null;
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveMusicSyncData(data: MusicSyncData): void {
    try { kvSet(MUSIC_SYNC_KEY, JSON.stringify(data)); } catch { }
}

export function clearMusicCloudSyncData(): void {
    const prev = loadMusicSyncData();
    saveMusicSyncData({
        loggedIn: false,
        playlistSummary: "",
        localSummary: prev?.localSummary ?? "",
        syncedAt: new Date().toISOString(),
    });
}

/** Read-only: check persisted login status (no network) */
export async function isNeteaseLoggedIn(): Promise<boolean> {
    if (!isNeteaseConfigured()) return false;
    return loadMusicSyncData()?.loggedIn ?? false;
}

/** Read-only: build local music list from persisted sync data (no network/IndexedDB) */
export async function buildMusicLocalMacro(): Promise<string> {
    return loadMusicSyncData()?.localSummary ?? "";
}

/** Read-only: build netease playlist summary from persisted sync data (no network) */
export async function buildMusicCloudMacro(): Promise<string> {
    return loadMusicSyncData()?.playlistSummary ?? "";
}

/**
 * Sync music data from all sources (local IndexedDB + Netease API).
 * Called by user via sync button. Persists results to localStorage.
 */
export async function syncMusicData(): Promise<MusicSyncData> {
    // 1. Check login status
    let loggedIn = false;
    if (isNeteaseConfigured()) {
        try {
            const cfg = loadMusicApiConfig();
            const status = await checkLoginStatus(cfg.baseUrl);
            loggedIn = status.loggedIn;
        } catch { }
    }

    // 2. Build playlist summary (only if logged in)
    let playlistSummary = "";
    if (loggedIn) {
        try {
            const playlists = await getUserPlaylists();
            const lines: string[] = [];
            const top = playlists.slice(0, 2);
            const trackResults = await Promise.all(top.map(pl => getPlaylistTracks(pl.id)));
            for (let i = 0; i < top.length; i++) {
                const songs = trackResults[i];
                if (songs.length > 0) {
                    lines.push(`歌单「${top[i].name}」：${songs.slice(0, 10).map(s => s.name).join("、")}`);
                }
            }
            playlistSummary = lines.join("\n");
        } catch { }
    }

    // 3. Build local music summary
    let localSummary = "";
    try {
        const tracks = await loadAllTracks();
        if (tracks.length > 0) {
            localSummary = tracks.slice(0, 30).map(t => t.title).join("、");
        }
    } catch { }

    const data: MusicSyncData = {
        loggedIn,
        playlistSummary,
        localSummary,
        syncedAt: new Date().toISOString(),
    };
    saveMusicSyncData(data);
    return data;
}

export type ChatCompletionPart = {
    text: string;
    toolNotice?: string;
};

export type ChatCompletionResult = {
    parts: ChatCompletionPart[];
};

/** Extract combined clean text from a ChatCompletionResult (for callers that need a plain string). */
export function flattenCompletionResult(result: ChatCompletionResult): string {
    return result.parts.map(p => stripTextToolDirectives(p.text)).filter(Boolean).join("\n\n");
}

// 单条消息工具循环轮数上限：设置项（聊天工具箱），默认 5
const MAX_NATIVE_EXPANDED_TOOL_PACKAGES = 2;

export function buildChatBilingualInstruction(
    enabled: boolean | undefined,
    mode: "single" | "group" = "single",
    customPrompt?: string,
): string {
    return resolveBilingualPrompt(
        enabled === true,
        customPrompt,
        mode === "group" ? DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT : DEFAULT_CHAT_BILINGUAL_PROMPT,
    );
}

export function buildOfflineBilingualInstruction(
    enabled: boolean | undefined,
    mode: "single" | "group" = "single",
    customPrompt?: string,
): string {
    return resolveBilingualPrompt(
        enabled === true,
        customPrompt,
        mode === "group" ? DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT : DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT,
    );
}

export type NativeChatToolBundle = {
    definitions: LlmToolDefinition[];
    nameMap: Map<string, string>;
    displayNameMap: Map<string, string>;
    loaderMap: Map<string, { sourceKey: string; label: string }>;
    realToolSourceMap: Map<string, string>;
};

type NativeChatToolBuildOptions = {
    actorNames?: string[];
    characterName?: string;
    userName?: string;
};

function stableToolHash(value: string): string {
    let hash = 0;
    for (const char of value) {
        hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    }
    return hash.toString(36).slice(0, 6);
}

function makeNativeToolName(displayName: string, used: Set<string>): string {
    const base = displayName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
    const prefix = base && /^[a-zA-Z_]/.test(base) ? base : "action";
    let name = `${prefix}_${stableToolHash(displayName)}`.slice(0, 64);
    let index = 2;
    while (used.has(name)) {
        name = `${prefix}_${stableToolHash(displayName)}_${index}`.slice(0, 64);
        index += 1;
    }
    used.add(name);
    return name;
}

export function nativeToolSourceKey(tool: EnabledTool): string {
    return `${tool.source}:${tool.sourceId}`;
}

export function isNativeSingleTool(tool: EnabledTool): boolean {
    if (tool.source === "rest") return true;
    if (tool.source === "composite") return true;
    if (tool.source === "custom_app") return true;
    if (tool.source === "internal") {
        const capability = getInternalCapability(tool.sourceId);
        const subTools = capability ? getInternalCapabilitySubToolDefinitions(capability) : [];
        return subTools.length === 0;
    }
    return false;
}

export function normalizeNativeExpandedToolSourceIds(sourceIds: string[] | undefined, enabledTools: EnabledTool[]): string[] {
    const allowed = new Set(enabledTools.filter(tool => !isNativeSingleTool(tool)).map(nativeToolSourceKey));
    const normalized: string[] = [];
    for (const sourceId of sourceIds || []) {
        if (!allowed.has(sourceId) || normalized.includes(sourceId)) continue;
        normalized.push(sourceId);
    }
    return normalized.slice(-MAX_NATIVE_EXPANDED_TOOL_PACKAGES);
}

export function touchNativeExpandedToolSource(sourceIds: string[], sourceId: string): string[] {
    const next = sourceIds.filter(id => id !== sourceId);
    next.push(sourceId);
    return next.slice(-MAX_NATIVE_EXPANDED_TOOL_PACKAGES);
}

export function persistNativeExpandedToolSourceIds(sessionId: string, sourceIds: string[]): void {
    const sessions = loadChatSessions();
    const index = sessions.findIndex(session => session.id === sessionId);
    if (index < 0) return;
    const next = [...sessions];
    next[index] = { ...next[index], nativeExpandedToolSourceIds: sourceIds };
    saveChatSessions(next);
}

function parseNativeToolSchema(displayName: string, schemaSource: unknown): Record<string, unknown> {
    const parsed = typeof schemaSource === "string"
        ? JSON.parse(schemaSource || "{}") as unknown
        : schemaSource;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ChatEngineError(`动作「${displayName}」的参数 schema 必须是 JSON object。`);
    }
    const schema = parsed as Record<string, unknown>;
    return schema.type ? schema : { type: "object", ...schema };
}

function formatNativeUsageGuide(usageGuide?: string): string {
    if (!usageGuide) return "";
    const withoutHeader = usageGuide.replace(/^以下是你获取指令的返回结果：\s*/u, "").trim();
    const exampleStart = withoutHeader.search(/\n(?:正确)?示例：/u);
    const core = exampleStart >= 0 ? withoutHeader.slice(0, exampleStart).trim() : withoutHeader;
    return core
        .replace(/获取指令/g, "动作说明")
        .replace(/执行动作指令/g, "调用当前动作");
}

function formatNativeToolDescription(displayName: string, description: string, usageGuide?: string): string {
    const nativeUsageGuide = formatNativeUsageGuide(usageGuide);
    return [
        `动作：${displayName}`,
        description,
        nativeUsageGuide ? `使用规则：\n${nativeUsageGuide}` : "",
    ].filter(Boolean).join("\n\n");
}

function expandNativeToolText(text: string, options?: NativeChatToolBuildOptions): string {
    if (!text.includes("{{")) return text;
    const engine = new MacroEngine(options?.characterName || "", options?.userName || "用户");
    return postProcessTrim(engine.expand(text));
}

function wrapNativeGroupToolParameters(parameters: Record<string, unknown>, actorNames: string[], includeArgs: boolean): Record<string, unknown> {
    const actorField: Record<string, unknown> = {
        type: "string",
        description: actorNames.length > 0
            ? `执行该动作的群成员名，必须是以下之一：${actorNames.join("、")}`
            : "执行该动作的群成员名",
    };
    if (actorNames.length > 0) actorField.enum = actorNames;
    if (!includeArgs) {
        return {
            type: "object",
            additionalProperties: false,
            properties: { actorName: actorField },
            required: ["actorName"],
        };
    }
    return {
        type: "object",
        additionalProperties: false,
        properties: {
            actorName: actorField,
            args: parameters,
        },
        required: ["actorName", "args"],
    };
}

export function buildNativeChatTools(enabledTools: EnabledTool[], expandedSourceIds: string[] = [], options?: NativeChatToolBuildOptions): NativeChatToolBundle {
    const definitions: LlmToolDefinition[] = [];
    const nameMap = new Map<string, string>();
    const displayNameMap = new Map<string, string>();
    const loaderMap = new Map<string, { sourceKey: string; label: string }>();
    const realToolSourceMap = new Map<string, string>();
    const usedNames = new Set<string>();
    const expanded = new Set(expandedSourceIds);

    const registerLoader = (tool: EnabledTool) => {
        const sourceKey = nativeToolSourceKey(tool);
        const displayName = expandNativeToolText(tool.name, options);
        const displayDescription = expandNativeToolText(tool.description, options);
        const nativeName = makeNativeToolName(`load_${sourceKey}_${displayName}_tools`, usedNames);
        definitions.push({
            name: nativeName,
            description: [`展开「${displayName}」动作说明。`, displayDescription].filter(Boolean).join(""),
            parameters: options?.actorNames
                ? wrapNativeGroupToolParameters({ type: "object", additionalProperties: false, properties: {} }, options.actorNames, false)
                : {
                type: "object",
                additionalProperties: false,
                properties: {},
            },
        });
        nameMap.set(nativeName, `展开「${tool.name}」动作说明`);
        displayNameMap.set(nativeName, `展开「${displayName}」动作说明`);
        loaderMap.set(nativeName, { sourceKey, label: displayName });
    };

    const registerTool = (displayName: string, description: string, schemaSource: unknown, sourceKey: string, usageGuide?: string) => {
        const expandedDisplayName = expandNativeToolText(displayName, options);
        const expandedDescription = expandNativeToolText(description, options);
        const expandedUsageGuide = usageGuide ? expandNativeToolText(usageGuide, options) : usageGuide;
        const nativeName = makeNativeToolName(expandedDisplayName, usedNames);
        definitions.push({
            name: nativeName,
            description: formatNativeToolDescription(expandedDisplayName, expandedDescription, expandedUsageGuide),
            parameters: options?.actorNames
                ? wrapNativeGroupToolParameters(parseNativeToolSchema(displayName, schemaSource || "{}"), options.actorNames, true)
                : parseNativeToolSchema(displayName, schemaSource || "{}"),
        });
        nameMap.set(nativeName, displayName);
        displayNameMap.set(nativeName, expandedDisplayName);
        realToolSourceMap.set(nativeName, sourceKey);
    };

    for (const tool of enabledTools) {
        if (isNativeSingleTool(tool)) {
            const sourceKey = nativeToolSourceKey(tool);
            registerTool(tool.name, tool.description, tool.parameterSchema || "{}", sourceKey, tool.usageGuide);
        } else {
            registerLoader(tool);
        }
    }

    for (const tool of enabledTools) {
        const sourceKey = nativeToolSourceKey(tool);
        if (isNativeSingleTool(tool) || !expanded.has(sourceKey)) continue;

        if (tool.source === "rest_package") {
            for (const restTool of tool.restTools || []) {
                registerTool(restTool.name, restTool.description || tool.description, restTool.parameterSchema || "{}", sourceKey);
            }
            continue;
        }

        if (tool.source === "composite_package") {
            for (const compositeTool of tool.compositeTools || []) {
                registerTool(compositeTool.name, compositeTool.description || tool.description, compositeTool.parameterSchema || "{}", sourceKey);
            }
            continue;
        }

        if (tool.source === "mcp_server") {
            for (const mcpTool of tool.mcpTools || []) {
                registerTool(mcpTool.name, mcpTool.description || tool.description, mcpTool.inputSchema || {}, sourceKey);
            }
            continue;
        }

        if (tool.source === "custom_app_package") {
            for (const customAppTool of tool.customAppTools || []) {
                registerTool(
                    customAppTool.name,
                    customAppTool.description || `来自「${customAppTool.appName}」的自定义 APP 工具`,
                    JSON.stringify(customAppTool.parameterSchema || { type: "object", properties: {} }),
                    sourceKey,
                    customAppTool.usageGuide,
                );
            }
            continue;
        }

        if (tool.source === "internal") {
            const capability = getInternalCapability(tool.sourceId);
            const subTools = capability ? getInternalCapabilitySubToolDefinitions(capability) : [];
            if (subTools.length > 0) {
                for (const subTool of subTools) {
                    registerTool(subTool.name, subTool.description, subTool.parameterSchema, sourceKey);
                }
            }
        }
    }

    return { definitions, nameMap, displayNameMap, loaderMap, realToolSourceMap };
}

export function formatNativeChatToolResult(result: ToolResult): string {
    return [
        `<action_result name="${result.name}" success="${result.success ? "true" : "false"}">`,
        result.success ? result.data || result.userNotice || "执行成功。" : result.error || result.userNotice || "执行失败。",
        "</action_result>",
        "工具结果已经返回给你，不要重复你之前已经说过的内容，不要再次执行相同的动作。",
    ].join("\n");
}

export function formatNativeLoaderToolResult(label: string): string {
    return `已展开「${label}」动作说明。`;
}

export function nativeChatToolCallToTextCall(call: LlmToolCall, bundle: NativeChatToolBundle): ToolCall {
    return {
        name: bundle.nameMap.get(call.name) || call.name,
        args: call.args,
    };
}

/**
 * Executes a single AI generation turn for a chat session.
 * Supports multi-round tool calling loop.
 */
/**
 * Shared prompt builder — used by both generateChatCompletion and previewPromptPayload.
 * Single source of truth for chat prompt assembly.
 */
export async function buildChatPromptMessages(
    session: ChatSession,
    history: ChatMessage[],
    options?: ChatPromptBuildOptions,
): Promise<{
    llmMessages: LLMMessage[];
    character: Character;
    config: ApiConfig;
    preset: PresetConfig | null;
    regexes: RegexConfig[];
    userIdentity: ReturnType<typeof resolveUserIdentity>;
    toolsEnabled: boolean;
}> {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === session.contactId);
    if (!character) throw new ChatEngineError(`Character not found: ${session.contactId}`);

    const resolvedAppId = options?.appId ?? "chat";
    const bindings = loadBindingConfig();
    const activeSlot = resolveBinding(bindings, character.id, resolvedAppId);

    if (!activeSlot.apiConfigId) {
        throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> Chat to assign one.`);
    }

    const apiConfigs = loadApiConfigs();
    const config = apiConfigs.find(c => c.id === activeSlot.apiConfigId);
    if (!config) throw new ChatEngineError(`API Configuration not found for ${character.name}.`);

    const presets = loadPresets();
    let preset = activeSlot.presetId ? presets.find(p => p.id === activeSlot.presetId) || null : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? null;
    const promptProfile = options?.promptProfile;
    if (preset && promptProfile) {
        preset = applyCustomPromptProfileToPreset(preset, promptProfile);
    }

    const allWorldBooks = loadWorldBooks();
    const extraWorldBookIds = options?.extraWorldBookIds ?? [];
    const worldBookIds = [...new Set([...(activeSlot.worldBookIds || []), ...extraWorldBookIds])];
    const worldBooks = promptProfile?.enableWorldBooks === false
        ? []
        : worldBookIds.map(id => allWorldBooks.find(w => w.id === id)).filter(Boolean) as typeof allWorldBooks;

    const allRegexes = loadRegexes();
    const regexes = promptProfile?.enableRegexes === false
        ? []
        : (activeSlot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as typeof allRegexes;

    const userIdentity = resolveUserIdentity(character.id, resolvedAppId);
    const attachedImages = config.enableImageRecognition === true ? options?.attachedImages : undefined;
    const historyForPrompt: ChatMessage[] = attachedImages?.length
        ? [
            ...history,
            ...attachedImages.map((imageUrl, index): ChatMessage => ({
                id: `video-frame-${Date.now()}-${index}`,
                sessionId: session.id,
                role: "user",
                content: "",
                status: "sent",
                createdAt: new Date().toISOString(),
                mediaType: "image",
                mediaUrl: imageUrl,
                mediaData: { label: "视频通话当前画面" },
            })),
        ]
        : history;

    const now = new Date();
    const promptTimeContext = buildCharacterTimeContext(character.timeZone, now);
    const promptTimestampOptions = getPromptTimestampOptionsForTimeContext(promptTimeContext);
    const memConfig = loadMemoryConfig();
    const isOfflineMode = options?.appTags?.includes("offline") === true;
    const effectiveAppTags = mergeAppTags(options?.appTags, promptProfile?.appTags, resolvedAppId);
    const toolsAllowed = options?.toolsAllowed !== false && !isOfflineMode;
    const enabledTools = toolsAllowed ? getEnabledTools(resolvedAppId) : [];
    const toolsEnabled = enabledTools.length > 0
        && (options?.forceEnableTools === true || presetIncludesToolsMacro(preset, resolvedAppId, effectiveAppTags));
    const usesNativeActions = Boolean(toolsEnabled && nativeToolProtocolForConfig(config));
    const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(character.id, resolvedAppId, {
        history: historyForPrompt,
        includeDirectChatEntries: isOfflineMode,
        includeNativeToolHistory: usesNativeActions,
        excludeOfflineSessionId: options?.excludeOfflineSessionId,
        promptTimestampOptions,
    });
    const promptHistory = applyVisionImagePromptLimit(
        truncatedHistory.map(msg => ({ ...msg })),
        session.visionImagePromptLimit,
    );

    if (config.enableImageRecognition) {
        for (const msg of promptHistory) {
            await prepareVisionPromptImageMessage(msg);
        }
    }

    const [memResults, coreResults, musicLocal, musicCloud] = await Promise.all([
        retrieveMemoriesForPrompt(character.id, wbActivationContext, memConfig).catch(() => null),
        retrieveCoreMemoriesForPrompt(character.id, memConfig).catch(() => null),
        buildMusicLocalMacro(),
        buildMusicCloudMacro(),
    ]);

    const longTermMemories = memResults ? formatLongTermMemories(memResults) : "";
    const coreMemories = coreResults ? formatCoreMemories(coreResults) : "";
    const scheduleSummary = buildCalendarScheduleMarker("character", character.id, getWeekStartIso(now));
    const currentSchedule = getCurrentCalendarScheduleForPrompt("character", character.id, now);
    const musicOnlineHint = isNeteaseConfigured() ? "- 你可以推荐任何歌曲，系统会在线搜索并播放。不局限于用户本地音乐库。\n" : "\n";
    const pluginPrompt = await runChatPluginTransform("prompt.system", {
        sessionId: session.id,
        isGroup: !!session.isGroup,
        characterId: character.id,
        hint: buildChatPluginPromptFragments(session.id),
    });
    const pluginPromptHint = pluginPrompt.hint?.trim() ? `\n\n### 扩展插件\n${pluginPrompt.hint.trim()}\n` : "";
    const customAppRichMediaDirectives = formatCustomAppChatDirectivesForPrompt() + buildScreenEffectPromptHint() + pluginPromptHint;
    const toolsPrompt = toolsEnabled && !usesNativeActions ? formatToolsForPrompt(enabledTools) : "";
    const chatBilingualInstruction = !session.isGroup
        ? buildChatBilingualInstruction(session.bilingualTranslationEnabled !== false, "single", session.bilingualTranslationPrompt)
        : "";
    // 状态区宏：按会话配置解析（native=原文/off=空/custom=契约）；群聊条目不含宏，不受影响
    const statusRegionCfg = getStatusRegionConfig(session.id);
    const offlineBilingualInstruction = !session.isGroup
        ? buildOfflineBilingualInstruction(
            session.bilingualTranslationEnabled !== false,
            "single",
            session.offlineBilingualTranslationPrompt,
        )
        : "";

    const llmMessages = assemblePromptPayload({
        character,
        history: promptHistory,
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: resolvedAppId,
        appTags: effectiveAppTags,
        initialStateValues: getLatestCharacterStateValues(character.id),
        followUpCount: options?.followUpCount,
        followUpDelay: options?.followUpDelay,
        timedWakeElapsedMinutes: options?.timedWakeElapsedMinutes,
        timedWakeIntent: options?.timedWakeIntent,
        periodCareContext: options?.periodCareContext,
        scheduleSummary,
        currentSchedule,
        coreMemories,
        longTermMemories,
        worldBookActivationContext: options?.worldBookActivationContext || wbActivationContext,
        activateAllWorldBooks: options?.activateAllWorldBooks,
        recentBlocks,
        unifiedRecentItems,
        customStickerNames: getCustomStickerNames(character.id),
        customStickerExample: getCustomStickerExample(character.id),
        musicLocal,
        musicCloud,
        musicOnlineHint,
        timeContext: promptTimeContext,
        promptTimestampOptions,
        enableVision: config.enableImageRecognition,
        timeAware: loadChatAppSettings().timeAware,
        tools: toolsPrompt,
        customAppRichMediaDirectives,
        chatBilingualInstruction,
        statusRegionSection: resolveStatusRegionSection(statusRegionCfg),
        statusRegionExampleLine: resolveStatusRegionExampleLine(statusRegionCfg),
        statusRegionComposition: resolveStatusRegionComposition(statusRegionCfg),
        statusRegionFullExample: resolveStatusRegionFullExample(statusRegionCfg),
        offlineBilingualInstruction,
        offlineSummaryTag: preset?.story_summary_tag?.trim() || "summary",
        nativeToolHistory: usesNativeActions,
    });
    if (promptProfile?.output === "plain_text") {
        llmMessages.push({
            role: "system",
            content: "本次自定义 APP AI 任务只输出纯文本结果。不要输出聊天富媒体指令、状态面板、内心想法、XML 包裹或 Markdown 代码块。",
        });
    } else if (promptProfile?.output === "json") {
        llmMessages.push({
            role: "system",
            content: "本次自定义 APP AI 任务只输出严格 JSON。不要输出 Markdown 代码块、解释文字或聊天富媒体指令。",
        });
    }
    appendEmptyGenerateGuardMessage(llmMessages, config, historyForPrompt);

    return { llmMessages, character, config, preset, regexes, userIdentity, toolsEnabled };
}

export type ChatCompletionCallbacks = {
    onTextPart?: (text: string, senderInfo?: {
        characterId: string;
        characterName: string;
        responseRoundId?: string;
        editableResponseText?: string;
    }, options?: {
        responseBatchId?: string;
        rawResponseText?: string;
    }) => void | Promise<void>;
    onToolNotice?: (notice: string) => void;
    onToolResult?: (content: string, options?: { toolExecutionId?: string }) => void;
    /** 每轮 LLM 调用解析出思维链（reasoning）时触发，先于该轮 onTextPart */
    onReasoning?: (text: string) => void;
    onToolAssistantTurn?: (content: string, options?: {
        responseBatchId?: string;
        responseRoundId?: string;
        senderCharacterId?: string;
        senderName?: string;
    }) => void;
    onToolExecution?: (results: ToolResult[], historyContent?: string, options?: { toolExecutionId?: string }) => void;
    onNativeToolAssistantTurn?: (turn: {
        content: string;
        rawContent: string;
        reasoning?: string;
        openRouterReasoningDetails?: unknown[];
        toolCalls: LlmToolCall[];
    }) => void | Promise<void>;
    onNativeToolResult?: (entry: {
        toolCallId: string;
        name: string;
        content: string;
        toolExecutionId?: string;
    }) => void;
};

export type OfflineChatCompletionResult = ParsedOfflineResponse & {
    model: string;
    presetName: string;
    /** 模型思维链（reasoning）内容，供线下记录展示 */
    reasoning?: string;
};

export async function generateOfflineChatCompletion(
    session: ChatSession,
    history: ChatMessage[],
    options?: { signal?: AbortSignal },
): Promise<OfflineChatCompletionResult> {
    const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
        session,
        history,
        {
            appTags: ["chat", "offline"],
            excludeOfflineSessionId: session.id,
        },
    );
    const summaryTag = preset?.story_summary_tag?.trim() || "summary";
    let reasoning = "";
    const rawOutput = await sendLLMRequest(config, preset, llmMessages, regexes, {
        characterName: character.name,
        userName: userIdentity?.name,
    }, {
        appTags: ["chat", "offline"],
        debugSessionId: session.id,
        signal: options?.signal,
        onReasoning: (t) => { reasoning = t; },
    });
    return {
        ...parseOfflineResponse(rawOutput, summaryTag),
        model: config.defaultModel,
        presetName: preset?.name || "默认预设",
        reasoning: reasoning || undefined,
    };
}

async function generateNativeChatCompletion(
    params: {
        session: ChatSession;
        llmMessages: LLMMessage[];
        character: Character;
        config: ApiConfig;
        preset: PresetConfig | null;
        regexes: RegexConfig[];
        userIdentity: ReturnType<typeof resolveUserIdentity>;
        options?: ChatPromptBuildOptions & { signal?: AbortSignal };
        callbacks?: ChatCompletionCallbacks;
        bailoutRef: ReplyBailoutRef;
    },
): Promise<ChatCompletionResult> {
    const { session, llmMessages, character, config, preset, regexes, userIdentity, options, callbacks, bailoutRef } = params;
    const enabledTools = getEnabledTools(options?.appId ?? "chat");
    const requestAppTags = mergeAppTags(options?.appTags, options?.promptProfile?.appTags, options?.appId ?? "chat");
    const persistedSession = loadChatSessions().find(item => item.id === session.id);
    let expandedSourceIds = normalizeNativeExpandedToolSourceIds(
        persistedSession?.nativeExpandedToolSourceIds || session.nativeExpandedToolSourceIds,
        enabledTools,
    );
    const nativeToolBuildOptions = {
        characterName: character.name,
        userName: userIdentity?.name ?? "用户",
    };
    let nativeBundle = buildNativeChatTools(enabledTools, expandedSourceIds, nativeToolBuildOptions);
    const requestMessages: LlmRequestMessage[] = toLlmRequestMessages(llmMessages);
    const parts: ChatCompletionPart[] = [];
    const meta = { characterName: character.name, userName: userIdentity?.name };
    const actionContext = { characterId: session.contactId, sessionId: session.id, sourceEngine: "chat" as const, signal: options?.signal };
    const expandableSourceKeys = new Set(enabledTools.filter(tool => !isNativeSingleTool(tool)).map(nativeToolSourceKey));

    const maxToolRounds = getMaxToolRounds();
    for (let round = 0; round < maxToolRounds; round += 1) {
        let result: LLMToolRequestResult;
        try {
            result = await sendLLMToolRequest(
                config,
                preset,
                requestMessages,
                nativeBundle.definitions,
                regexes,
                meta,
                {
                    appId: options?.appId ?? "chat",
                    appTags: requestAppTags,
                    followUpCount: options?.followUpCount,
                    debugSessionId: session.id,
                    signal: options?.signal,
                },
            );
        } catch (err) {
            const errMsg = `⚠️ 回复生成失败: ${err instanceof Error ? err.message : String(err)}`;
            if (parts.length > 0) {
                throwIfAborted(options?.signal);
                callbacks?.onToolNotice?.(errMsg);
                parts.push({ text: "", toolNotice: errMsg });
                break;
            }
            throw err;
        }
        throwIfAborted(options?.signal);

        const { cleanText: afterActionStrip, actions } = parseActionTags(result.content);
        if (actions.length > 0) {
            throwIfAborted(options?.signal);
            dispatchActions(actions, actionContext).catch(err => console.warn("[ChatEngine] Action dispatch failed:", err));
        }
        const assistantForToolContext = stripStateAndInnerForPrompt(result.content);

        if (result.toolCalls.length === 0) {
            throwIfAborted(options?.signal);
            // 无工具调用的最终轮：把解析到的思维链先交给回调（先于 onTextPart，与非原生路径一致）
            if (result.reasoning) callbacks?.onReasoning?.(result.reasoning);
            await callbacks?.onTextPart?.(afterActionStrip);
            parts.push({ text: afterActionStrip });
            if (bailoutRef.shortcutHandles.length > 0) bailoutRef.shortcutCompleted = true;
            break;
        }

        throwIfAborted(options?.signal);
        await callbacks?.onNativeToolAssistantTurn?.({
            content: afterActionStrip,
            rawContent: result.content,
            reasoning: result.reasoning,
            openRouterReasoningDetails: result.openRouterReasoningDetails,
            toolCalls: result.toolCalls,
        });
        if (afterActionStrip) {
            parts.push({ text: afterActionStrip });
        }

        const loaderCalls = result.toolCalls
            .map(call => ({ call, loader: nativeBundle.loaderMap.get(call.name) }))
            .filter((item): item is { call: LlmToolCall; loader: { sourceKey: string; label: string } } => Boolean(item.loader));
        const realNativeCalls = result.toolCalls.filter(call => !nativeBundle.loaderMap.has(call.name));
        const textCalls = realNativeCalls.map((call) => nativeChatToolCallToTextCall(call, nativeBundle));
        const displayedActionNames = [
            ...loaderCalls.map(item => `展开「${item.loader.label}」动作说明`),
            ...realNativeCalls.map(call => nativeBundle.displayNameMap.get(call.name) || nativeBundle.nameMap.get(call.name) || call.name),
        ];
        const actorName = character.name;
        callbacks?.onToolNotice?.(`${actorName}正在${displayedActionNames.join("、")}...`);

        let realResults: Awaited<ReturnType<typeof executeToolCalls>> = [];
        try {
            if (textCalls.length > 0) {
                const onlyNativeCall = result.toolCalls.length === 1 && textCalls.length === 1
                    ? result.toolCalls[0]
                    : undefined;
                realResults = await executeToolCalls(textCalls, {
                    appId: options?.appId ?? "chat",
                    sessionId: session.id,
                    characterId: session.contactId,
                    sourceEngine: "chat",
                    signal: options?.signal,
                    onShortcutCommandCreated: onlyNativeCall ? async command => {
                        const resultMarker = `__FLOAT_SHORTCUT_RESULT_${command.id}__`;
                        const imageMarker = command.resultMode === "image" && config.enableImageRecognition
                            ? `__FLOAT_SHORTCUT_IMAGE_${command.id}__`
                            : undefined;
                        const snapshotMessages: LlmRequestMessage[] = [
                            ...requestMessages,
                            {
                                role: "assistant",
                                content: assistantForToolContext,
                                reasoning: result.reasoning,
                                openRouterReasoningDetails: result.openRouterReasoningDetails,
                                toolCalls: result.toolCalls,
                            },
                            {
                                role: "tool",
                                name: onlyNativeCall.name,
                                toolCallId: onlyNativeCall.id,
                                content: resultMarker,
                            },
                            ...(imageMarker ? [{ role: "user" as const, content: imageMarker }] : []),
                        ];
                        return registerShortcutContinuation(bailoutRef, {
                            command,
                            style: "native",
                            resultMarker,
                            imageMarker,
                            request: buildProviderRequest(config, preset, snapshotMessages),
                            session,
                            character,
                            userName: userIdentity?.name,
                            regexes,
                            appId: options?.appId,
                            appTags: requestAppTags,
                        });
                    } : undefined,
                });
            }
            throwIfAborted(options?.signal);
        } catch (err) {
            throwIfAborted(options?.signal);
            const errMsg = `⚠️ 动作执行失败: ${err instanceof Error ? err.message : String(err)}`;
            callbacks?.onToolNotice?.(errMsg);
            parts.push({ text: "", toolNotice: errMsg });
            break;
        }

        const outcomes: Array<{
            nativeCall: LlmToolCall;
            result: ToolResult;
            formattedContent: string;
            realResult?: ToolResult;
        }> = [];
        let realResultIndex = 0;
        let expandedChanged = false;

        for (const nativeCall of result.toolCalls) {
            const loader = nativeBundle.loaderMap.get(nativeCall.name);
            if (loader) {
                expandedSourceIds = touchNativeExpandedToolSource(expandedSourceIds, loader.sourceKey);
                expandedChanged = true;
                const content = formatNativeLoaderToolResult(loader.label);
                outcomes.push({
                    nativeCall,
                    result: {
                        name: loader.label,
                        success: true,
                        data: content,
                        userNotice: content,
                        continueConversation: true,
                    },
                    formattedContent: content,
                });
                continue;
            }

            const realResult = realResults[realResultIndex] || {
                name: nativeBundle.nameMap.get(nativeCall.name) || nativeCall.name,
                success: false,
                error: "动作结果缺失。",
                userNotice: `✗ ${nativeBundle.nameMap.get(nativeCall.name) || nativeCall.name}: 动作结果缺失。`,
            };
            realResultIndex += 1;
            const sourceKey = nativeBundle.realToolSourceMap.get(nativeCall.name);
            if (sourceKey && expandableSourceKeys.has(sourceKey)) {
                expandedSourceIds = touchNativeExpandedToolSource(expandedSourceIds, sourceKey);
                expandedChanged = true;
            }
            outcomes.push({
                nativeCall,
                result: realResult,
                realResult,
                formattedContent: formatNativeChatToolResult(realResult),
            });
        }

        if (expandedChanged) {
            expandedSourceIds = normalizeNativeExpandedToolSourceIds(expandedSourceIds, enabledTools);
            persistNativeExpandedToolSourceIds(session.id, expandedSourceIds);
            nativeBundle = buildNativeChatTools(enabledTools, expandedSourceIds, nativeToolBuildOptions);
        }

        const notices = outcomes.map(item => (
            item.result.userNotice || (item.result.success ? `✓ ${item.result.name} 执行成功` : `✗ ${item.result.name}: ${item.result.error}`)
        )).filter(Boolean).join("；");
        throwIfAborted(options?.signal);
        if (notices) callbacks?.onToolNotice?.(notices);

        throwIfAborted(options?.signal);
        requestMessages.push({
            role: "assistant",
            content: assistantForToolContext,
            reasoning: result.reasoning,
            openRouterReasoningDetails: result.openRouterReasoningDetails,
            toolCalls: result.toolCalls,
        });
        const toolExecutionId = createToolExecutionId();
        for (const outcome of outcomes) {
            throwIfAborted(options?.signal);
            const nativeCall = outcome.nativeCall;
            callbacks?.onNativeToolResult?.({
                toolCallId: nativeCall.id,
                name: nativeCall.name,
                content: outcome.formattedContent,
                toolExecutionId,
            });
            requestMessages.push({
                role: "tool",
                name: nativeCall.name,
                toolCallId: nativeCall.id,
                content: outcome.formattedContent,
            });
        }

        const resultsForHistory = realResults.filter(r => r.persistToHistory !== false);
        const toolResultContent = resultsForHistory.length > 0 ? formatToolResults(resultsForHistory) : "";
        throwIfAborted(options?.signal);
        if (realResults.length > 0) {
            callbacks?.onToolExecution?.(realResults, toolResultContent || undefined, { toolExecutionId });
        }

        for (const r of realResults) {
            for (const att of r.mediaAttachments || []) {
                throwIfAborted(options?.signal);
                if (config.enableImageRecognition && att.type === "image" && att.url) {
                    const ref = att.url;
                    try {
                        const dataUrl = await resolveCompressedImageDataUrl(ref);
                        if (dataUrl) {
                            if (dataUrl.startsWith("data:image/")) {
                                requestMessages.push({
                                    role: "user",
                                    content: [
                                        { type: "text", text: "系统记录：这是你刚才生成的图片。" },
                                        { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
                                    ],
                                });
                            }
                        }
                    } catch { /* skip if resolution fails */ }
                }
            }
        }

        if (outcomes.filter(item => item.result.continueConversation !== false).length === 0) {
            break;
        }
    }

    return { parts };
}

type ReplyBailoutRef = {
    current: { settle: () => void } | null;
    closed: boolean;
    superseded: boolean;
    shortcutHandles: ShortcutContinuationHandle[];
    shortcutCompleted: boolean;
    shortcutCancelled: boolean;
};

async function registerShortcutContinuation(
    bailoutRef: ReplyBailoutRef,
    input: {
        command: { id: string; actionName: string; resultMode: "none" | "text" | "image" };
        style: ShortcutContinuationStyle;
        resultMarker: string;
        imageMarker?: string;
        request: ReturnType<typeof buildProviderRequest>;
        session: ChatSession;
        character: Character;
        userName?: string;
        regexes: RegexConfig[];
        appId?: string;
        appTags?: string[];
    },
): Promise<boolean> {
    const handle = await armShortcutContinuation({
        commandId: input.command.id,
        actionName: input.command.actionName,
        resultMode: input.command.resultMode,
        resultMarker: input.resultMarker,
        imageMarker: input.imageMarker,
        style: input.style,
        request: input.request,
        sessionId: input.session.id,
        characterName: input.character.name,
        userName: input.userName,
        regexes: input.regexes,
        appId: input.appId,
        appTags: input.appTags,
    });
    if (!handle) return false;

    bailoutRef.superseded = true;
    bailoutRef.current?.settle();
    bailoutRef.current = null;
    bailoutRef.shortcutHandles.push(handle);
    return true;
}

export async function generateChatCompletion(
    session: ChatSession,
    history: ChatMessage[],
    options?: ChatPromptBuildOptions & { signal?: AbortSignal },
    callbacks?: ChatCompletionCallbacks,
): Promise<ChatCompletionResult> {
    // 发送兜底（离线推送）：生成期间在服务端挂一张带心跳租约的保险单，
    // 本地完成即撤销；App 被杀则心跳停跳，服务端接管生成并推送。
    const bailoutRef: ReplyBailoutRef = {
        current: null,
        closed: false,
        superseded: false,
        shortcutHandles: [],
        shortcutCompleted: false,
        shortcutCancelled: false,
    };
    try {
        return await generateChatCompletionCore(session, history, options, callbacks, bailoutRef);
    } catch (err) {
        if (options?.signal?.aborted) bailoutRef.shortcutCancelled = true;
        throw err;
    } finally {
        bailoutRef.closed = true;
        bailoutRef.current?.settle();
        for (const handle of bailoutRef.shortcutHandles) {
            if (bailoutRef.shortcutCompleted || bailoutRef.shortcutCancelled) handle.settle();
            else handle.release();
        }
    }
}

async function generateChatCompletionCore(
    session: ChatSession,
    history: ChatMessage[],
    options: (ChatPromptBuildOptions & { signal?: AbortSignal }) | undefined,
    callbacks: ChatCompletionCallbacks | undefined,
    bailoutRef: ReplyBailoutRef,
): Promise<ChatCompletionResult> {
    const { llmMessages, character, config, preset, regexes, userIdentity, toolsEnabled } = await buildChatPromptMessages(session, history, options);
    const requestAppTags = mergeAppTags(options?.appTags, options?.promptProfile?.appTags, options?.appId ?? "chat");

    // 追问有自己的排期时兜底（followup:key），这里只为普通回复生成挂单。
    // 不 await：挂单失败或慢都不拖累本地生成；生成先结束则通过 closed 标记补撤销。
    if (!session.isGroup && (options?.appId ?? "chat") === "chat" && !(requestAppTags ?? []).includes("followup")) {
        // 云端兜底可能在另一台机器上生成并经真实微信发送。把本轮最后一条
        // 用户输入/系统指令作为因果锚点带过去，避免回复拉回本地后因手机与
        // 云服务器存在亚秒级时钟偏差，被按 createdAt 重排到触发消息前面。
        const replyAfterMessage = [...history].reverse().find(message =>
            message.sessionId === session.id
            && (message.role === "user" || message.mediaType === "system_instruction")
            && Boolean(message.id)
            && Boolean(message.createdAt),
        );
        void import("./push-bailout-client").then(async mod => {
            const handle = await mod.armReplyBailout({
                sessionId: session.id,
                characterName: character.name,
                userName: userIdentity?.name,
                regexes,
                request: buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages)),
                replyAfter: replyAfterMessage
                    ? { localMessageId: replyAfterMessage.id, createdAt: replyAfterMessage.createdAt }
                    : undefined,
                signal: options?.signal,
            });
            if (!handle) return;
            if (bailoutRef.closed || bailoutRef.superseded) handle.settle();
            else bailoutRef.current = handle;
        }).catch(() => undefined);
    }

    if (toolsEnabled && nativeToolProtocolForConfig(config) && getEnabledTools(options?.appId ?? "chat").length > 0) {
        return generateNativeChatCompletion({
            session,
            llmMessages,
            character,
            config,
            preset,
            regexes,
            userIdentity,
            options,
            callbacks,
            bailoutRef,
        });
    }

    // ── Tool calling loop with real-time callbacks ──
    const parts: ChatCompletionPart[] = [];
    const meta = { characterName: character.name, userName: userIdentity?.name };
    const actionContext = { characterId: session.contactId, sessionId: session.id, sourceEngine: "chat" as const, signal: options?.signal };

    const maxToolRounds = getMaxToolRounds();
    for (let round = 0; round < maxToolRounds; round++) {
        let filteredOutput: string;
        try {
            filteredOutput = await sendLLMRequest(config, preset, llmMessages, regexes, meta, {
                appId: options?.appId ?? "chat",
                appTags: requestAppTags,
                followUpCount: options?.followUpCount,
                debugSessionId: session.id,
                signal: options?.signal,
                onReasoning: callbacks?.onReasoning,
            });
        } catch (err) {
            const errMsg = `⚠️ 回复生成失败: ${err instanceof Error ? err.message : String(err)}`;
            if (parts.length > 0) {
                throwIfAborted(options?.signal);
                callbacks?.onToolNotice?.(errMsg);
                parts.push({ text: "", toolNotice: errMsg });
                break;
            }
            throw err;
        }
        throwIfAborted(options?.signal);

        // Parse actions (朋友圈 etc) — strip from display text but keep tool tags
        const { cleanText: afterActionStrip, actions } = parseActionTags(filteredOutput);
        if (actions.length > 0) {
            throwIfAborted(options?.signal);
            dispatchActions(actions, actionContext).catch(err => console.warn("[ChatEngine] Action dispatch failed:", err));
        }

        // Check for [获取指令:xxx] and [执行动作:xxx({...})]
        const toolFetches = toolsEnabled ? parseToolFetches(afterActionStrip) : [];
        const { toolCalls } = toolsEnabled ? parseToolCalls(afterActionStrip) : { toolCalls: [] };
        const assistantForToolContext = stripStateAndInnerForPrompt(filteredOutput);

        // No tool activity — final round
        if (toolFetches.length === 0 && toolCalls.length === 0) {
            throwIfAborted(options?.signal);
            await callbacks?.onTextPart?.(afterActionStrip);
            parts.push({ text: afterActionStrip });
            if (bailoutRef.shortcutHandles.length > 0) bailoutRef.shortcutCompleted = true;
            break;
        }

        // Store ordinary prose as normal assistant messages. The directive itself is a
        // separate hidden tool_call record in the same response batch.
        throwIfAborted(options?.signal);
        const responseBatchId = createResponseBatchId();
        const toolDirectiveText = extractTextToolDirectiveText(afterActionStrip);
        await callbacks?.onTextPart?.(afterActionStrip, undefined, {
            responseBatchId,
            rawResponseText: afterActionStrip,
        });
        if (toolDirectiveText) {
            callbacks?.onToolAssistantTurn?.(toolDirectiveText, { responseBatchId });
        }
        parts.push({ text: filteredOutput });

        // Helper: find insert index for injecting after history
        const findInsertIdx = () => {
            for (let i = llmMessages.length - 1; i >= 0; i--) {
                if (llmMessages[i]._debugMeta?._fromHistory) return i + 1;
            }
            return llmMessages.length;
        };

        // Handle [获取指令:xxx] — local parameter schema lookup
        if (toolFetches.length > 0) {
            for (const fetch of toolFetches) {
                throwIfAborted(options?.signal);
                const actorName = fetch.actor || character.name;
                const toolNotice = `${actorName}正在获取「${fetch.name}」指令...`;
                callbacks?.onToolNotice?.(toolNotice);

                const tool = findEnabledToolForSchema(fetch.name, options?.appId ?? "chat", {
                    characterName: character.name,
                    userName: userIdentity?.name ?? "用户",
                });
                const schemaContent = tool
                    ? formatToolSchema(tool, {
                        characterName: character.name,
                        userName: userIdentity?.name ?? "用户",
                    })
                    : `以下是你获取指令的返回结果：\n动作类别「${fetch.name}」未找到，请检查名称。`;

                // Persist to history + inject into messages
                throwIfAborted(options?.signal);
                callbacks?.onToolResult?.(schemaContent);
                const idx = findInsertIdx();
                llmMessages.splice(idx, 0,
                    { role: "assistant", content: assistantForToolContext, _debugMeta: { _fromHistory: true } },
                    { role: "user", content: schemaContent, _debugMeta: { _fromHistory: true } },
                );
            }
            continue; // Next round — LLM will now call the tool with params
        }

        // Handle [执行动作:xxx({...})] — execute calls
        if (toolCalls.length > 0) {
            const actorName = toolCalls[0]?.actor || character.name;
            const toolNotice = `${actorName}正在${toolCalls.map(t => t.name).join("、")}...`;
            callbacks?.onToolNotice?.(toolNotice);

            let results: Awaited<ReturnType<typeof executeToolCalls>>;
            try {
                const onlyToolCall = toolCalls.length === 1 ? toolCalls[0] : undefined;
                results = await executeToolCalls(toolCalls, {
                    appId: options?.appId ?? "chat",
                    sessionId: session.id,
                    characterId: session.contactId,
                    sourceEngine: "chat",
                    signal: options?.signal,
                    onShortcutCommandCreated: onlyToolCall ? async command => {
                        const resultMarker = `__FLOAT_SHORTCUT_RESULT_${command.id}__`;
                        const imageMarker = command.resultMode === "image" && config.enableImageRecognition
                            ? `__FLOAT_SHORTCUT_IMAGE_${command.id}__`
                            : undefined;
                        const snapshotMessages = [...llmMessages];
                        const insertions: LLMMessage[] = [
                            { role: "assistant", content: assistantForToolContext, _debugMeta: { _fromHistory: true } },
                            { role: "user", content: resultMarker, _debugMeta: { _fromHistory: true } },
                            ...(imageMarker ? [{ role: "user" as const, content: imageMarker, _debugMeta: { _fromHistory: true } }] : []),
                        ];
                        snapshotMessages.splice(findInsertIdx(), 0, ...insertions);
                        return registerShortcutContinuation(bailoutRef, {
                            command,
                            style: "text",
                            resultMarker,
                            imageMarker,
                            request: buildProviderRequest(config, preset, toLlmRequestMessages(snapshotMessages)),
                            session,
                            character,
                            userName: userIdentity?.name,
                            regexes,
                            appId: options?.appId,
                            appTags: requestAppTags,
                        });
                    } : undefined,
                });
                throwIfAborted(options?.signal);
                const resultNotices = results.map(r => r.userNotice || (r.success ? `✓ ${r.name} 执行成功` : `✗ ${r.name}: ${r.error}`)).join("；");
                callbacks?.onToolNotice?.(resultNotices);
            } catch (err) {
                throwIfAborted(options?.signal);
                const errMsg = `⚠️ 动作执行失败: ${err instanceof Error ? err.message : String(err)}`;
                callbacks?.onToolNotice?.(errMsg);
                parts.push({ text: "", toolNotice: errMsg });
                break;
            }

            const resultsForHistory = results.filter(r => r.persistToHistory !== false);
            const resultsForContinuation = results.filter(r => r.continueConversation !== false);
            const toolResultContent = resultsForHistory.length > 0 ? formatToolResults(resultsForHistory) : "";
            throwIfAborted(options?.signal);
            const toolExecutionId = createToolExecutionId();
            callbacks?.onToolExecution?.(results, toolResultContent || undefined, { toolExecutionId });

            if (toolResultContent && resultsForContinuation.length > 0) {
                throwIfAborted(options?.signal);
                callbacks?.onToolResult?.(toolResultContent, { toolExecutionId });
                const idx = findInsertIdx();
                const insertions: LLMMessage[] = [
                    { role: "assistant", content: assistantForToolContext, _debugMeta: { _fromHistory: true } },
                    { role: "user", content: toolResultContent, _debugMeta: { _fromHistory: true } },
                ];
                if (config.enableImageRecognition) {
                    for (const r of results) {
                        for (const att of r.mediaAttachments || []) {
                            throwIfAborted(options?.signal);
                            if (att.type !== "image" || !att.url) continue;
                            try {
                                const dataUrl = await resolveCompressedImageDataUrl(att.url);
                                if (!dataUrl) continue;
                                if (dataUrl.startsWith("data:image/")) {
                                    insertions.push({
                                        role: "user",
                                        content: [
                                            { type: "text", text: "系统记录：这是你刚才生成的图片。" },
                                            { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
                                        ],
                                    });
                                }
                            } catch { /* skip */ }
                        }
                    }
                }
                llmMessages.splice(idx, 0, ...insertions);
            }

            if (resultsForContinuation.length === 0) {
                break;
            }

            // Last round — one final call
            if (round === maxToolRounds - 1) {
                try {
                    const finalOutput = await sendLLMRequest(config, preset, llmMessages, regexes, meta, {
                        appId: options?.appId ?? "chat",
                        appTags: requestAppTags,
                        followUpCount: options?.followUpCount,
                        debugSessionId: session.id,
                        signal: options?.signal,
                        onReasoning: callbacks?.onReasoning,
                    });
                    throwIfAborted(options?.signal);
                    await callbacks?.onTextPart?.(finalOutput);
                    parts.push({ text: finalOutput });
                    if (bailoutRef.shortcutHandles.length > 0) bailoutRef.shortcutCompleted = true;
                } catch (err) {
                    throwIfAborted(options?.signal);
                    const errMsg = `⚠️ 回复生成失败: ${err instanceof Error ? err.message : String(err)}`;
                    callbacks?.onToolNotice?.(errMsg);
                    parts.push({ text: "", toolNotice: errMsg });
                }
            }
        }
    }

    // Memory: increment event counter + check if summarization needed (non-blocking)
    (async () => {
        try {
            incrementEventCounter(character.id); // user message
            incrementEventCounter(character.id); // AI reply
            await maybeRunSummarization(character.id, character.name);
        } catch (err) {
            console.warn("[ChatEngine] Memory counter/summarization failed:", err);
        }
    })();

    return { parts };
}

/**
 * Preview-only: assembles the full prompt payload without sending an API request.
 * Reuses the same binding resolution logic as generateChatCompletion.
 */
export async function previewPromptPayload(
    session: ChatSession,
    history: ChatMessage[],
    options?: ChatPromptBuildOptions & { followUpAuto?: boolean }
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    // Auto-resolve follow-up count/delay from current schedule
    if (options?.followUpAuto) {
        const sched = loadFollowUpSchedule(session.id);
        options = {
            ...options,
            followUpCount: (sched?.count ?? 0) + 1,
            followUpDelay: sched?.delaySec ?? 60,
        };
    }

    // Inject follow-up silence markers so preview matches actual API call
    let effectiveHistory = history;
    if (options?.followUpCount && options.followUpCount > 0) {
        const lastUserMsg = [...history].reverse().find(m => m.role === "user");
        const lastUserTime = lastUserMsg ? new Date(lastUserMsg.createdAt).getTime() : Date.now();
        const annotated: ChatMessage[] = [];
        let currentRound = 0;
        for (const msg of history) {
            if (msg.role === "assistant" && msg.followUpIndex && msg.followUpIndex > currentRound) {
                currentRound = msg.followUpIndex;
                const markerTime = new Date(msg.createdAt).getTime();
                const silenceSec = Math.round((markerTime - lastUserTime) / 1000);
                annotated.push({
                    id: `_marker_${currentRound}_${Date.now()}`,
                    sessionId: session.id,
                    role: "user",
                    content: `[对方没有回复你的消息，距上次回复已过约${silenceSec}秒]`,
                    status: "sent",
                    createdAt: msg.createdAt,
                });
            }
            annotated.push(msg);
        }
        const nowMs = Date.now();
        const finalSilenceSec = Math.round((nowMs - lastUserTime) / 1000);
        annotated.push({
            id: `_silence_${nowMs}`,
            sessionId: session.id,
            role: "system",
            content: `[对方没有回复你的消息，距上次回复已过约${finalSilenceSec}秒]`,
            status: "sent",
            createdAt: new Date().toISOString(),
        });
        effectiveHistory = annotated;
    }

    // Use the SAME shared builder as generateChatCompletion
    const { llmMessages, character, config, preset } = await buildChatPromptMessages(session, effectiveHistory, options);

    const apiMessages = previewMessagesForApi(config, preset, llmMessages);

    return {
        messages: apiMessages,
        characterName: character.name,
        model: config.defaultModel,
        presetName: preset?.name ?? "(无预设)",
    };
}

export async function previewPromptRequestSnapshot(
    session: ChatSession,
    history: ChatMessage[],
    options?: ChatPromptBuildOptions & { followUpAuto?: boolean },
): Promise<DebugPromptSnapshot> {
    if (options?.followUpAuto) {
        const sched = loadFollowUpSchedule(session.id);
        options = {
            ...options,
            followUpCount: (sched?.count ?? 0) + 1,
            followUpDelay: sched?.delaySec ?? 60,
        };
    }

    let effectiveHistory = history;
    if (options?.followUpCount && options.followUpCount > 0) {
        const lastUserMsg = [...history].reverse().find(m => m.role === "user");
        const lastUserTime = lastUserMsg ? new Date(lastUserMsg.createdAt).getTime() : Date.now();
        const annotated: ChatMessage[] = [];
        let currentRound = 0;
        for (const msg of history) {
            if (msg.role === "assistant" && msg.followUpIndex && msg.followUpIndex > currentRound) {
                currentRound = msg.followUpIndex;
                const markerTime = new Date(msg.createdAt).getTime();
                const silenceSec = Math.round((markerTime - lastUserTime) / 1000);
                annotated.push({
                    id: `_marker_${currentRound}_${Date.now()}`,
                    sessionId: session.id,
                    role: "user",
                    content: `[对方没有回复你的消息，距上次回复已过约${silenceSec}秒]`,
                    status: "sent",
                    createdAt: msg.createdAt,
                });
            }
            annotated.push(msg);
        }
        const nowMs = Date.now();
        const finalSilenceSec = Math.round((nowMs - lastUserTime) / 1000);
        annotated.push({
            id: `_silence_${nowMs}`,
            sessionId: session.id,
            role: "system",
            content: `[对方没有回复你的消息，距上次回复已过约${finalSilenceSec}秒]`,
            status: "sent",
            createdAt: new Date().toISOString(),
        });
        effectiveHistory = annotated;
    }

    const { llmMessages, character, config, preset, userIdentity, toolsEnabled } = await buildChatPromptMessages(session, effectiveHistory, options);
    const requestMessages = toLlmRequestMessages(llmMessages);
    const enabledTools = toolsEnabled ? getEnabledTools(options?.appId ?? "chat") : [];
    const meta = { characterName: character.name, userName: userIdentity?.name };

    if (nativeToolProtocolForConfig(config) && enabledTools.length > 0) {
        const persistedSession = loadChatSessions().find(item => item.id === session.id);
        const expandedSourceIds = normalizeNativeExpandedToolSourceIds(
            persistedSession?.nativeExpandedToolSourceIds || session.nativeExpandedToolSourceIds,
            enabledTools,
        );
        const nativeBundle = buildNativeChatTools(enabledTools, expandedSourceIds, {
            characterName: character.name,
            userName: userIdentity?.name ?? "用户",
        });
        const request = buildProviderRequest(config, preset, requestMessages, { tools: nativeBundle.definitions });
        return publishDebugPromptSnapshot({
            request,
            config,
            preset,
            meta,
            options: {
                appId: options?.appId ?? "chat",
                appTags: options?.appTags,
                debugSessionId: session.id,
            },
            requestKind: "native-tools",
            tools: nativeBundle.definitions,
        });
    }

    const request = buildProviderRequest(config, preset, requestMessages);
    return publishDebugPromptSnapshot({
        request,
        config,
        preset,
        meta,
        options: {
            appId: options?.appId ?? "chat",
            appTags: options?.appTags,
            debugSessionId: session.id,
        },
        requestKind: "completion",
    });
}
