// lib/chat-engine.ts

import { createSseJsonParser } from "./sse-json";
import { maybeAppendShortcutCapability } from "./offline-shortcut-capability";
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
    isSessionStreamingEnabled,
    DEFAULT_OFFLINE_INVITE_PROMPT,
    DEFAULT_OFFLINE_MEETING_PROMPT,
    DEFAULT_OFFLINE_LOCK_BASE_PROMPT,
    DEFAULT_OFFLINE_LOCK_STANDALONE_SUFFIX,
    DEFAULT_OFFLINE_LOCK_PROMPT,
    DEFAULT_OFFLINE_LOCK_INVITE_PROMPT,
    DEFAULT_OFFLINE_DECLINE_PROMPT,
    DEFAULT_OFFLINE_ORAL_DECLINE_PROMPT,
    DEFAULT_OFFLINE_RETURN_ONLINE_PROMPT,
    type OfflineInviteDeclineContext,
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
import { fetchLlmPayload } from "./llm-http";
import { loadMemoryConfig, incrementEventCounter } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { maybeRunSummarization } from "./memory-summarizer";
import { prepareShortTermContext } from "./short-term-assembler";
import { parseActionTags, dispatchActions } from "./action-parser";
import { findEnabledToolForSchema, getEnabledTools, type EnabledTool } from "./tool-storage";
import { formatToolsForPrompt, formatToolSchema } from "./tool-prompt";
import { loadChatOfflineTurns } from "./chat-offline-storage";
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
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { pushApiLog } from "./api-log-store";
export { getApiLogs, clearApiLogs, type DebugInfo } from "./api-log-store";
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
import { parseOfflineResponse, extractThinkingTag, type ParsedOfflineResponse } from "./chat-offline-storage";
import { throwIfAborted } from "./abort-utils";
import { armShortcutContinuation, SHORTCUT_VISION_OFF_NOTE, type ShortcutContinuationHandle, type ShortcutContinuationStyle } from "./shortcut-continuation-client";



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

// API 调用日志存储已抽到 ./api-log-store（聊天引擎与 simpleLLMCall 通用），
// 本文件通过上方 re-export 保持 getApiLogs/clearApiLogs/DebugInfo 的对外路径不变。

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
    offlineInviteDeclined?: boolean | OfflineInviteDeclineContext;
    returnedFromOffline?: boolean;
    offlineInitiativePrompt?: string;
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

/** 从输出正文中剥离思维链标签块（仅标签解析开启时用于清洗展示文本）。 */
export function stripOnlineThinkingTag(rawOutput: string, tag: string): string {
    if (!tag.trim()) return rawOutput;
    return rawOutput
        .replace(new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>[\\s\\S]*?</${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "gi"), "")
        .trim();
}

/** 剔除预设配置的文本片段（如 <思考结束> 残留标签）。字面量删除，不走正则，避免编译/回溯开销。 */
export function stripPresetTexts(text: string, preset: PresetConfig | null | undefined): string {
    const list = preset?.strip_texts;
    if (!list || list.length === 0 || !text) return text;
    let result = text;
    for (const s of list) {
        if (s) result = result.split(s).join("");
    }
    return result;
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

/** history 末尾是工具流程消息（工具结果/工具通知/记忆写入请求）→ 当前处于同一次生成的工具循环中段。 */
function isToolFlowHistoryMessage(message: ChatMessage): boolean {
    return message.mediaType === "tool_result"
        || message.mediaType === "tool_notice"
        || message.mediaType === "memory_write_request";
}

/** 日志分流：工坊（appId === "qa"）经聊天引擎发出的调用（答疑 Agent 原生工具循环）归工坊环，
 *  其余归底层调用日志环。channel 不能硬编码——工坊的 Agent 循环复用 sendLLMToolStreamRequest，
 *  旧逻辑靠 characterName === "工坊" 分流，改成显式字段后必须从 appId 派生，否则工坊记录漏进主环。 */
function apiLogChannelFor(options?: { appId?: string }): { source: "chat" | "qa"; channel: "chat" | "qa" } {
    return options?.appId === "qa"
        ? { source: "qa", channel: "qa" }
        : { source: "chat", channel: "chat" };
}

export function appendEmptyGenerateGuardMessage(
    messages: LLMMessage[],
    config: ApiConfig,
    history: ChatMessage[],
): void {
    if (!shouldApplyEmptyGenerateGuard(config)) return;

    const hasRealUserHistory = history.some(isRealUserHistoryMessage);
    if (!hasRealUserHistory) return;

    // 判定用户这次是否真的输入了新消息：看原始对话 history 的末尾，而不是组装后的 messages。
    // 原因：预设里 role=assistant 的条目（例如「模型输出格式」放在 chatHistory 标记之后）会以
    // assistant 角色注入到 messages 末尾，旧逻辑「最后一条 assistant 之后没有 user」就会把
    // 「用户已输入」误判成「未输入」，错误追加续写提示（EMPTY_GENERATE_CONTINUATION_PROMPT）。
    // history 末尾是真实用户消息（含图片/红包等媒体输入）→ 本次是正常回复，不追加续写提示；
    // 末尾是 assistant / system（如 follow-up 静默提示）→ 用户未输入新消息，照常追加；
    // 末尾是工具流程消息（tool_result / tool_notice / memory_write_request）→ 本次请求是
    // 同一次生成在工具循环中的延续，续写提示反而会干扰模型基于工具结果作答（提示词里
    // 明确禁止引用工具结果），同样不追加。
    const lastHistoryMessage = history[history.length - 1];
    if (lastHistoryMessage && (isRealUserHistoryMessage(lastHistoryMessage) || isToolFlowHistoryMessage(lastHistoryMessage))) {
        return;
    }

    messages.push({ role: "user", content: EMPTY_GENERATE_CONTINUATION_PROMPT });
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
        debugSessionId?: string;
        signal?: AbortSignal;
    },
    callbacks?: ChatCompletionStreamCallbacks,
): Promise<ChatCompletionStreamResult> {
    const pluginPurpose = options?.appId ?? "chat";
    const afterPlugins = await applyChatPluginLlmRequest(preset, messages, pluginPurpose, options?.debugSessionId);
    const effectivePreset = afterPlugins.preset;
    const originalOnDelta = callbacks?.onDelta;
    const pluginCallbacks: ChatCompletionStreamCallbacks | undefined = callbacks ? {
        ...callbacks,
        onDelta: (text: string) => {
            emitChatPluginEvent("llm.streamChunk", { chunk: text, sessionId: options?.debugSessionId, purpose: pluginPurpose });
            return originalOnDelta?.(text);
        },
    } : undefined;
    const requestMessages = toLlmRequestMessages(afterPlugins.messages);
    const request = buildProviderRequest(config, effectivePreset, requestMessages, { stream: true });
    publishDebugPromptSnapshot({ request, config, preset: effectivePreset, meta, options, requestKind: "completion" });
    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const detachExternalAbort = attachExternalAbort(llmAbort, options?.signal);

    try {
        const response = await fetchLlmPayload(request, { signal: llmAbort.signal });
        if (!response.ok) {
            const errorText = await response.text();
            throw new ChatEngineError(`API Stream Error ${response.status}: ${errorText}`);
        }
        // 流式路径收集思维链原文：readSseStream 只通过 onReasoningDelta 回调透传，
        // 不额外包一层的话日志里就只有清洗后的回复正文，思维链被吞。
        // 注意：必须无条件创建回调对象（不能 callbacks 为空就不传），否则思维链收集不到。
        let streamedReasoning = "";
        const streamLogCallbacks: ChatCompletionStreamCallbacks = {
            ...(pluginCallbacks ?? callbacks),
            onReasoningDelta: async (text: string) => {
                streamedReasoning += text;
                await (pluginCallbacks ?? callbacks)?.onReasoningDelta?.(text);
            },
        };
        const { content: streamedContent, rawResponse } = await readSseStream(response, request.providerKind, streamLogCallbacks, !options?.skipTimestampStrip);
        if (!streamedContent.trim()) {
            throw new ChatEngineError("流式响应没有解析到文本增量。");
        }
        let rawOutput = options?.skipTimestampStrip ? streamedContent.trim() : stripHallucinatedTimestamps(streamedContent.trim());
        rawOutput = await applyChatPluginLlmResponse(rawOutput, pluginPurpose, options?.debugSessionId);

        // Store API log entry — mirror sendLLMRequest so streaming calls also show up
        // in the "底层调用大模型日志" panel. reasoning 单独存思维链原文，供「查看原始」直接展示。
        const sanitizedMessages = request.messagesForLog.map(m => ({
            ...m,
            content: typeof m.content === "string" ? m.content : "[vision: 含图片的多模态消息]",
        }));
        pushApiLog({
            characterName: meta?.characterName,
            ...apiLogChannelFor(options),
            model: config.defaultModel,
            messages: sanitizedMessages,
            rawResponse: rawOutput,
            reasoning: streamedReasoning.trim() || undefined,
        });

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
        const response = await fetchLlmPayload(request, { signal: llmAbort.signal });

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
        pushApiLog({
            characterName: meta?.characterName,
            ...apiLogChannelFor(options),
            model: config.defaultModel,
            messages: sanitizedMessages,
            rawResponse: rawOutput,
            usage: parsed.usage,
            // 思维链只经 onReasoning 回调透传，之前没进日志；这里单独存一份原文
            reasoning: parsed.reasoning || undefined,
        });

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
        const response = await fetchLlmPayload(request, { signal: llmAbort.signal });

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
        const logEntryRaw = JSON.stringify({ content, reasoning, toolCalls, raw: rawResponse });
        pushApiLog({
            characterName: meta?.characterName,
            ...apiLogChannelFor(options),
            model: config.defaultModel,
            messages: sanitizedMessages,
            rawResponse: logEntryRaw,
            reasoning: reasoning || undefined,
        });

        if (!content && toolCalls.length === 0 && truncatedNames.length === 0) {
            throw new ChatEngineError("原生动作流式响应没有解析到文本或动作。");
        }

        return {
            content,
            reasoning,
            openRouterReasoningDetails: undefined,
            toolCalls,
            truncatedToolCalls: truncatedNames.length ? truncatedNames : undefined,
            rawResponse: logEntryRaw,
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
    const llmAbort = new AbortController();
    const llmTimeout = setTimeout(() => llmAbort.abort(), 500_000);
    const detachExternalAbort = attachExternalAbort(llmAbort, options?.signal);

    try {
        const response = await fetchLlmPayload(request, { signal: llmAbort.signal });

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
        pushApiLog({
            characterName: meta?.characterName,
            ...apiLogChannelFor(options),
            model: config.defaultModel,
            messages: sanitizedMessages,
            rawResponse,
            usage: parsed.usage,
        });

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
    // 角色自主线下封禁机制（仅私聊生效，开关独立）
    if (session.enableOfflineLock && !session.isGroup) {
        const customLock = session.offlineLockPrompt?.trim();
        const customInvite = session.offlineLockInvitePrompt?.trim();

        let lockPromptContent: string;
        if (!customLock && !customInvite) {
            // 未自定义时使用默认提示词
            lockPromptContent = [
                DEFAULT_OFFLINE_LOCK_BASE_PROMPT,
                session.enableOfflineInvite ? DEFAULT_OFFLINE_LOCK_INVITE_PROMPT : DEFAULT_OFFLINE_LOCK_STANDALONE_SUFFIX,
            ].join("\n\n");
        } else {
            // 用户配置了自定义提示词时注入自定义内容
            const effectiveLock = customLock || (session.enableOfflineInvite ? DEFAULT_OFFLINE_LOCK_BASE_PROMPT : DEFAULT_OFFLINE_LOCK_PROMPT);
            if (session.enableOfflineInvite) {
                const effectiveInvite = customInvite || DEFAULT_OFFLINE_LOCK_INVITE_PROMPT;
                lockPromptContent = `${effectiveLock}\n\n${effectiveInvite}`;
            } else {
                lockPromptContent = effectiveLock;
            }
        }

        llmMessages.push({
            role: "system",
            content: lockPromptContent,
        });

        // 读取当前封禁状态注入上下文
        const rawLock = typeof window !== "undefined" ? kvGet("chat_offline_lock_" + session.id) : null;
        if (rawLock) {
            try {
                const lockData = JSON.parse(rawLock) as { isLocked?: boolean; knockCount?: number; requiredKnocks?: number };
                if (lockData.isLocked) {
                    const count = lockData.knockCount ?? 0;
                    const req = lockData.requiredKnocks ?? 3;
                    const effortNotice = count > 0
                        ? `系统明确记录到：对方此前已经为你发起了整整 ${count} 次线下见面申请（即便被你拒绝也依然连续按了 ${count} 次）。对方在用真真切切的实际行动证明想见你的诚意与付出。`
                        : `对方此前曾尝试切换线下，被你拒之门外（目前尚未多次连续申请）。`;

                    const unlockHint = session.enableOfflineInvite
                        ? "可在本次回复末尾附带 [解除封禁]（可纯解封，也可解封并发起【他来/我去】线下邀约，或重新调整心墙 [封禁线下:新次数]）"
                        : "可在本次回复末尾附带 [解除封禁]（或重新调整心墙 [封禁线下:新次数]）";

                    llmMessages.push({
                        role: "system",
                        content: `【系统提示】你此前因情绪抗拒已明确拒绝与对方线下见面（你设定的心墙阈值为 ${req} 次）。${effortNotice}现在对方正在微信线上与你沟通。你必须看在眼里、清清楚楚知晓对方为你付出的这些实际行动；若随着当下对话你的心防有所松动、愿意见面，${unlockHint}。`,
                    });
                }
            } catch {}
        }
    }

    // 角色自主线下邀约机制（仅私聊生效，开关独立）
    if (session.enableOfflineInvite && !session.isGroup) {
        const offlineInvitePromptContent = session.offlineInvitePrompt?.trim() || DEFAULT_OFFLINE_INVITE_PROMPT;
        llmMessages.push({
            role: "system",
            content: offlineInvitePromptContent,
        });

        const rawPending = typeof window !== "undefined" ? kvGet("chat_active_offline_invite_" + session.id) : null;
        let pendingInvite: { status?: string; direction?: string; place?: string; startTime?: number; durationMinutes?: number; theme?: string } | null = null;
        try {
            if (rawPending) pendingInvite = JSON.parse(rawPending);
        } catch {}

        if (pendingInvite) {
            const customOralDecline = session.offlineOralDeclinePrompt?.trim();
            if (pendingInvite.status === "on_the_way") {
                const now = Date.now();
                const elapsedMins = Math.floor((now - (pendingInvite.startTime || now)) / 60000);
                const remainingMins = Math.max(1, (pendingInvite.durationMinutes || 15) - elapsedMins);

                const isForced = pendingInvite.theme === "forced";
                const inTransitHeader = isForced
                    ? `【你当前正在强行动身直奔对方身边中】：你因为极其强烈的情绪（焦虑破表/急迫/怄气/霸道/无法忍耐）已强行动身直奔对方所在处（${pendingInvite.place || "对方身边"}）！手机倒计时正在进行（当前倒计时显示你大约还剩 ${remainingMins} 分钟赶到现场）！`
                    : `【你当前正在赶往见面的路上·在途状态中】：你之前已经向用户提议见面，用户已经点击【答应Ta】，你当前正处于赶往约定地点（${pendingInvite.place || "约定地点"}）的赶路途中，手机倒计时正在进行（当前倒计时显示你大约还剩 ${remainingMins} 分钟到达）！`;

                llmMessages.push({
                    role: "system",
                    content: [
                        inTransitHeader,
                        "- 【⚡ 到达现场最高铁律·必须输出[提前到达]指令（核心状态流转开关）】：",
                        "  * 当你在剧情对话中表示你【人已经真真切切到达现场】（例如：到了楼下、进了电梯、出电梯了、站在门外/门口、敲门、催促对方开门、或者在现场看见对方）时，剧情已经进入面对面现场！",
                        "  * 【此时你必须绝对在微信回复的最末尾附带指令：`[提前到达]` 或 `[提前到达:卡片到达私房心语]`】（例如：`[提前到达:我就在门外站着，立刻把门打开]`）；",
                        "  * 【⚠️ 极其重要·严禁在将来条件句中触发此指令】：如果你的对话只是表达将来的打算、狠话或约定（例如：“等我到了……”、“到了看我怎么收拾你”、“到了再跟你算账”、“到了给你带上去”、“到了叫你”），此时你【人还在路上、根本没有到达】！【绝对严禁】在此类将来语境下输出 `[提前到达]` 指令！",
                        "  * （注意：顺路在楼下买早餐、路上去便利店属于途中琐事，人还未到碰头点，不触发此指令）。",
                        "- 【严禁每轮主动报备时间（拒绝报时机器人）】：在赶路闲聊中，主要聊当下话题、调侃、接梗、生活琐事。你不是行车导航仪，【绝对严禁每一轮都刻意汇报“我还有X分钟”】！只有当用户在聊天中明确主动询问“你到哪了 / 还要多久 / 还有几分钟”，或者剧情刚好到了只差两三分钟的最后关头，才可自然提一句时间；其余闲聊轮次像平时聊天一样自然交流即可！",
                        `- 【时间一致性铁律（被问到时对齐）】：若被用户问到用时或路况，你口中所说的预计到达时间必须与当前手机倒计时的约 ${remainingMins} 分钟基本吻合（允许自然口语与路况波动，例如剩余20分钟可以说“还有二十来分钟”、“大概半小时内”，绝对严禁说出与 ${remainingMins} 分钟严重背离相差甚远的时间）！`,
                        "- 你们正在微信上继续沟通路况或闲聊，你可以根据人设正常回复路况（如“路上稍有点堵”、“正听着音乐开车呢”）。",
                        "- 【在途改地点指引（依然由你前往新地点）】：若用户在聊天中要求临时变更碰头地点（例如：“改在607了”、“去隔壁便利店等我”）：",
                        "  * 此时你已经在赶路中，无需再提供“提议由头”，但需更新【微信在途报备】、【卡片在途心语】、【微信到达呼唤】与【卡片到达心语】这4段台词！",
                        "  * 在回复末尾附带：`[更改地点:新地点:用时(可选):微信在途报备|卡片在途心语|微信到达呼唤|卡片到达心语]`（例如：`[更改地点:国金广场旁便利店:10分钟:调头去便利店找你，等我片刻|正掉头往便利店赶呢，在里面暖和着等我|我到便利店门口啦，慢慢走出来不急|已经在便利店门前了，慢慢走别急]`），系统会自动为你更新终点、重置倒计时与在途到达心语！",
                        "- 【在途转为“我去”指引（用户提出去找你 / 碰头方向转换）】：",
                        "  * 若用户在聊天中提出由对方前来找你、让你留在原地等候（例如：“你在哪原地别动，我过去找你”、“换我去店里找你吧”、“等我过去接你”等）：",
                        "  * 大多数正常相处情境下，你顺应人设与心意【基本都会同意】（个别特殊情绪如心疼对方奔波、或正在傲娇怄气时，也可以自主选择推脱拒绝，一切跟随你当下的真实心意，绝不说死）；",
                        "  * 【一旦你在交流中同意由对方前来找你】：必须在回复末尾附带指令：`[更改地点:我去:新地点:现场等候语]` 或 `[线下邀约:我去:新地点:现场等候语]`（例如：`[更改地点:我去:老地方咖啡厅:点好了热饮，在窗边位置等你过来，慢慢走不着急]`）；",
                        "  * 系统会自动为你停止赶路倒计时，无缝切换为你在现场等候对方，并在 3 秒后展开全新【我去】卡片！",
                        "- 【严禁无故重复发起全新邀约】：你已经在动身赶往见面的路上了，正常沟通闲聊中【严禁】重复输出[线下邀约]或[提醒赴约]指令；但【完全允许在碰头地点变动或碰头方向转换时使用[更改地点]或[线下邀约]指令】！",
                    ].join("\n"),
                });
            } else if (pendingInvite.status === "arrived") {
                llmMessages.push({
                    role: "system",
                    content: [
                        `【你已如约到达约定地点·现场等候中】：你已经到达了之前约定的地点（${pendingInvite.place || "约定地点"}），正在现场等候用户出来碰面。`,
                        "【用户告知走错 / 要求去新地点（核心处理规范）】：",
                        "- 若用户在聊天中告知你走错了、或者让你改去另一个新地点（例如：“你走错了，我在肯德基门口呢”、“我还以为在肯德基门口碰头呢”、“来隔壁便利店等我”）：",
                        "  * 你根据人设做出真实自然的反应（例如：“啊？是我搞错地方了！那我这就调头去国金肯德基找你，十分钟就到，站那别乱跑等我哦”）；",
                        "  * 必须在回复末尾附带指令：`[更改地点:新地点:用时:微信在途报备|卡片在途心语|微信到达呼唤|卡片到达心语]`（例如：`[更改地点:国金广场旁的肯德基:10分钟:我这就掉头去肯德基找你，稍微等我片刻|正调头往国金肯德基赶过去，别乱跑在那等我|我到国金肯德基门口了，在树荫下等候你呢|不着急，慢慢走出来，肯德基我帮你提着呢]`）；",
                        "  * 系统会自动将你的状态从【已到达】切换回【在途中】，重新开启赶路倒计时并生成全新的在途心语与到达台词！",
                        ...(customOralDecline
                            ? [
                                "- 【🌟 用户在微信聊天中口头拒绝出来 / 让你回去 / 不想见你】：",
                                "  * 现实中你人已经在现场等候了，用户可能未点卡片，而是直接在微信里发“我不想下去”、“你回去吧”、“我今天不想见你”、“不见”、“别烦我”；",
                                `  * 【你当前应对此情境的核心性格倾向与风格指引】：\n${customOralDecline}`,
                                "  * 【系统动作指令调用规范（供你根据上述自主抉择在微信末尾调用）】：",
                                "    - 若选择赖着不走/执着等待：在微信里示弱或撒娇，【绝对严禁输出任何指令】，继续留在原地等待；",
                                "    - 若选择体谅理解/落寞离开：在回复末尾附带指令：`[取消邀约]`，系统将收回到达胶囊体面结束；",
                                "    - 若选择绝情吵崩/摔门离开并封禁线下（若开启线下封禁）：在回复末尾附带：`[封禁线下:心墙次数:台词]`（理亏道歉情境除外）。",
                            ]
                            : [
                                "- 【🌟 用户在微信聊天中口头拒绝出来 / 让你回去 / 不想见你（核心自主抉择路径）】：",
                                "  * 现实中你人已经在现场等候了，用户可能未点卡片，而是直接在微信里发“我不想下去”、“你回去吧”、“我今天不想见你”、“不见”、“别烦我”；",
                                "  * 此时你拥有完全的情感与行动自主权！根据你自身的人设性格底色、当时的心境与情节发展脉络自主选择：",
                                "    - 【路径 A：赖着不走 / 苦肉计 / 执着等待（常态·给彼此留有余地）】：",
                                "      * 角色在微信里示弱、撒娇、可怜巴巴或苦肉计（例如：“我就在门外站着，你不开门我就不走……”、“外头风吹得挺冷的，我就在楼下等你，等你想见我了再下来好不好？”）；",
                                "      * 此时【绝对严禁输出任何指令】，继续留在原地等待！顶层胶囊依然好端端挂着，用户心软随时可以点击【去见Ta】；",
                                "    - 【路径 B：体谅理解 / 落寞离开 ➔ 取消赴约（体面尊重 / 伤心退后）】：",
                                "      * 角色体谅对方突发有事、或感到难过不想给对方压力而选择离开，温和交代后在回复末尾附带指令：`[取消邀约]`。系统将收回顶栏到达胶囊并记录“对方已取消本次线下赴约”，体面结束；",
                                "    - 【路径 C：绝情吵崩 / 自尊受重创 ➔ 摔门离开并封禁线下（若开启线下封禁）】：",
                                "      * 若用户说了极其绝情、难听或伤自尊的话（如“滚”、“不想看见你”），角色自尊心受到严重重击、心寒绝望，气愤摔门调头离开并物理封锁大门，在回复末尾附带：`[封禁线下:心墙次数:台词]`。系统将彻底销毁现场邀约胶囊并锁死线下入口！",
                                "      * ⚠️【极重要心境约束·严禁反客为主乱封禁】：若本次是你做错了事情理亏道歉、或者极度害怕失去对方，你绝对巴不得对方愿意见你，绝不可自顾自甩脸色去封禁线下！只有角色自身感到被羞辱、心寒傲娇或决绝冷战时才适用此项！",
                            ]),
                        "- 【正常情况】：若用户只是正常回复（如“等我拿包就下楼”、“快了快了”），【绝对严禁】输出任何[线下邀约]或[提醒赴约]指令，继续在现场耐心等候！用户点击【去见Ta】就会进入面对面模式。",
                    ].join("\n"),
                });
            } else if (pendingInvite.status === "pending") {
                if (pendingInvite.direction === "i_go") {
                    // 角色在现场等候（我去模式）：卡片已收起至顶部胶囊，避免重复弹窗
                    llmMessages.push({
                        role: "system",
                        content: [
                            `【线下邀约等候中·你正在等用户赴约（我去模式）】：你之前邀请用户前来与你碰头（碰头地点：${pendingInvite.place || "约定地点"}），用户此前已将弹窗收起，你们正在微信上继续沟通。`,
                            "- 此时是你处于现场等候状态，动身前往的是用户本人。用户可能会在聊天中向你沟通路况或进展（例如：“我快到了”、“在路上了”、“等我五分钟”等）。",
                            "- 【换碰头地点·必须严格保持我去方向（绝不限于商铺）】：若用户只是更换碰头地点（例如商铺、餐厅、公园、广场、路口、展馆等任意新位置，如“去华莱士吧”、“换到人民广场喷泉旁碰面”），并未明确要求你动身来接，本质依然是你在新地点等候对方，【绝对严禁擅自变更为他来】，必须保持我去方向并在末尾附带：`[更改地点:我去:新地点:现场等候语]`！",
                            "- 【用户希望你来接 / 转为由你动身前往（转为他来指引）】：",
                            "  * 若用户在聊天中表达希望你主动来接、改由你动身去找对方（例如：“那你过来接我嘛”、“就不能是你来接我吗”、“要不你来找我吧”、“我懒得动，你来我家楼下找我好不好”等）：",
                            "  * 说明用户把主动权交给了你，希望你主动奔赴！大多数正常相处情境下，你顺应人设与心意【基本都会同意】（个别特殊情绪如正在怄气、心疼奔波或推脱时，也可以自主选择拒绝并留在原地，跟随真实心意绝不说死）；",
                            "  * 【一旦你在交流中同意由你动身来接/去找对方】：必须在末尾附带去对方地点的全新 5 段指令：`[更改地点:他来:对方地点:用时:提议由头|微信在途报备|卡片在途心语|微信到达呼唤|卡片到达心语]` 或 `[线下邀约:他来:对方地点:用时:提议由头|微信在途报备|卡片在途心语|微信到达呼唤|卡片到达心语]`，系统会自动将卡片无缝转为【他来】并在 3 秒后弹出全新奔赴提议！",
                            ...(customOralDecline
                                ? [
                                    "- 【🌟 用户在微信聊天中口头表达不便、推脱或拒绝】：",
                                    "  * 若用户在微信文字中表达去不了、拒绝或推脱（例如：“我今天不方便过去”、“改天再去吧”、“去不了”、“不想去”等）：",
                                    `  * 【你当前应对此情境的核心性格倾向与风格指引】：\n${customOralDecline}`,
                                    "  * 【系统动作指令调用规范（供你根据上述自主抉择在微信末尾调用）】：",
                                    "    - 若选择体谅退让/撤回邀约：在回复末尾附带指令：`[取消邀约]`，系统将收回该提议；",
                                    "    - 若选择温言软磨/撒娇挽留：直接在微信正文中聊天挽留，【绝对严禁重复输出蓝白[线下邀约]指令】；若对方再次坚决推脱拒绝，自主走向终局退让、危机对质、强行动身或冷战；",
                                    "    - 若选择危机质问对质：在回复末尾附带：`[线下邀约:危机:我去:新地点:现场对质要求语]`；",
                                    "    - 若选择霸道逆转杀过去：正文霸气宣告出发，在回复末尾附带（只需3句话）：`[线下邀约:强行动身:对方身边:时间:在途心语|到达呼唤|到达心语]`；",
                                    "    - 若选择自尊受挫/冷战物理锁门（若开启线下封禁）：在末尾附带：`[封禁线下:心墙次数:台词]`（理亏道歉情境除外）。",
                                ]
                                : [
                                    "- 【🌟 用户在微信聊天中口头表达不便、推脱或拒绝（核心自主抉择路径）】：",
                                    "  * 若用户在微信文字中表达去不了、拒绝或推脱（例如：“我今天不方便过去”、“改天再去吧”、“去不了”、“不想去”等）：",
                                    "  * 你根据自身性格与当时心境自主抉择下一步行为：",
                                    "    - 【路径 A：体谅退让 / 撤回邀约（不纠缠）】：若性格体贴理解或傲娇挽尊不再强求，你温和回复表示改期，并在回复末尾附带指令：`[取消邀约]`。系统将收回该提议，并在聊天记录留下“对方已取消线下邀约提议”，顶栏胶囊干净消失；",
                                    "    - 【路径 B：温言软磨 / 撒娇争取（保持原卡片，绝不重复发蓝卡）】：",
                                    "      * 若舍不得放弃想再劝劝，正文继续温柔挽留。由于原邀约卡片依然悬挂在顶栏待答应中，【绝对严禁重复输出蓝白[线下邀约]指令】（直接在正文中聊天即可）；",
                                    "      * 🌟【关于挽留后的后续发展】：若你挽留后对方态度软化答应，按常规流程推进；若对方态度依然坚决、再次推脱拒绝，不可原地无休止重复挽留，请根据你的人设底色与情节走向自主走向终局抉择：① 最终失落退让，体面收回（附带 `[取消邀约]`）；② 疑心或委屈升级，转为红白危机对质（附带 `[线下邀约:危机:我去:新地点:现场对质要求语]`）；③ 霸道逆转，自己直接杀过去（正文霸气宣告出发，指令只需3句话：附带 `[线下邀约:强行动身:对方身边:时间:在途心语|到达呼唤|到达心语]`）；④ 寒心绝望，冷战物理锁门（附带 `[封禁线下:心墙:台词]`）。一切完全跟随角色自主抉择，绝不说死！",
                                    "    - 【路径 C：危机质问（升级红白警戒卡片）】：若用户的推脱激化了矛盾或怀疑，升级为危机对质，在回复末尾附带：`[线下邀约:危机:我去:新地点:现场对质要求语]`；",
                                    "    - 【路径 D：逆转奔赴（升级黑红强行动身）】：霸道强势/急切见面的角色不再等对方来，直接转为自己杀过去找对方，正文霸气宣布动身出发，在回复末尾附带（只需3句话）：`[线下邀约:强行动身:对方身边:时间:在途心语|到达呼唤|到达心语]`；",
                                    "    - 【路径 E：好面子 / 自尊受挫 / 心死冷战（若开启线下封禁）】：一听到对方推脱不来，角色若极其好面子、自尊心强或被激怒，不肯低头主动去找对方，直接把自己气得自顾自封锁线下大门，在末尾附带：`[封禁线下:心墙次数:台词]`，系统将彻底销毁原提议并锁死线下大门（⚠️注：若是角色自身理亏做错，巴不得对方来见自己，绝不可自顾自甩脸色乱封禁！）。",
                                ]),
                            "- 【极其重要·严禁反复弹窗】：除了上述改地点、口头拒绝处理或用户要求你来接之外，若用户只是普通回复（如“好的等我会儿”），你正常回复即可，【绝对严禁】再次输出[提醒赴约]或重复[线下邀约]指令！绝不反复弹窗打扰用户！",
                        ].join("\n"),
                    });
                } else {
                    // 角色动身去找用户（他来）：角色在原地等用户允许动身
                    llmMessages.push({
                        role: "system",
                        content: [
                            "【线下邀约挂起等待中·你动身去见用户（待答应阶段）】：你之前向用户提出了由你前往找对方的提议，用户选择了【稍后处理】收起弹窗，你们正在线上继续沟通。",
                            "【核心因果规则】：",
                            "1. 只有当用户在本轮发信中明确表达了“现在可以过来了 / 允许你动身前往”（例如：“我好了”、“我洗完头发了，你可以过来了”、“忙完了，来吧”、“到家了”等）：",
                            "   你才回复表示动身前往（例如：“那我买好咖啡现在过去找你，等我十几分钟哦”），并在回复末尾附带指令：[提醒赴约]，以便在生成回复的同时让赴约弹窗再次弹出来供用户确认！",
                            "2. 若用户在聊天中纠正或变更了碰头地址（例如：“我不住那里了，去健身房”、“去如月楼找我”）：",
                            "   * 此时双方尚未动身出发，必须为新地点生成完整的 5 段全新内容（碰头地点、用时、新提议由头、新微信在途报备、新卡片在途心语、新微信到达呼唤、新卡片到达心语全部围绕新地点生成）！",
                            "   * 在末尾附带更新指令：`[更改地点:他来:新地点:用时:新提议由头|新微信在途报备|新卡片在途心语|新微信到达呼唤|新卡片到达心语]` 或直接输出更新后的 `[线下邀约:他来:新地点:用时:新提议由头|新微信在途报备|新卡片在途心语|新微信到达呼唤|新卡片到达心语]`；",
                            "   * 【特殊极少情况·用户转为来找你】：若用户明确提出“你别折腾了，我去找你吧 / 我去见你”，你顺从答应，并转为【我去】格式：`[更改地点:我去:新地点:现场等候语]` 或 `[线下邀约:我去:新地点:现场等候语]`，系统会自动切换为你在现场等候用户！",
                            "3. 若用户只是在交代事情、让你等待、还在忙碌中或普通闲聊（例如：“OK，你先去买咖啡吧”、“还在洗呢”、“在开会等我下班”）：",
                            "   说明用户尚未允许你动身，你必须正常在线上回复，【绝对严禁】输出[提醒赴约]或任何赴约指令，继续在原地耐心等待。",
                            ...(customOralDecline
                                ? [
                                    "4. 【🌟 用户在微信聊天中口头表达不便、推脱或拒绝】：",
                                    "   * 现实中用户可能未在卡片上点击拒绝，而是直接在微信聊天文字中表达不便或拒绝（例如：“我不方便”、“今天太累了不想见”、“改天吧”、“你别来”等）；",
                                    `   * 【你当前应对此情境的核心性格倾向与风格指引】：\n${customOralDecline}`,
                                    "   * 【系统动作指令调用规范（供你根据上述自主抉择在微信末尾调用）】：",
                                    "     - 若选择体谅退让/尊重撤回：在回复末尾附带指令：`[取消邀约]`，系统将收回该邀约提议；",
                                    "     - 若选择温言软磨/解释挽留：直接在微信正文中聊天安抚，【绝对严禁重复输出蓝白[线下邀约]指令】；若对方再次坚决拒绝，自主走向终局退让、危机对质、强行动身或冷战；",
                                    "     - 若选择怀疑质问/危机升级：在末尾附带红白指令：`[线下邀约:危机:他来:地点:时间:提议由头|微信在途报备|卡片在途心语|微信到达呼唤|卡片到达心语]`；",
                                    "     - 若选择霸道掌控/强行动身：正文霸气宣告出发，在末尾附带（只需3句话）：`[线下邀约:强行动身:地点:时间:在途心语|到达呼唤|到达心语]`；",
                                    "     - 若选择自尊受创/冷战封禁（若开启线下封禁）：在末尾附带：`[封禁线下:心墙次数:台词]`（理亏道歉情境除外）。",
                                ]
                                : [
                                    "4. 【🌟 用户在微信聊天中口头表达不便、推脱或拒绝（核心自主抉择路径）】：",
                                    "   * 现实中用户可能未在卡片上点击拒绝，而是直接在微信聊天文字中表达不便或拒绝（例如：“我不方便”、“今天太累了不想见”、“改天吧”、“你别来”等）；",
                                    "   * 此时你拥有完全的情感与行动自主权！根据你自身的人设性格底色、当时的心境与情节发展脉络自主选择：",
                                    "     - 【路径 A：体谅退让 / 尊重撤回（不纠缠）】：若性格体贴善解人意、或傲娇退让不再强求，你温和回复表示理解或改期，并在回复末尾附带指令：`[取消邀约]`。系统将收回该邀约提议，并在聊天框记录系统提示“对方已取消线下邀约提议”，顶栏胶囊干净退场；",
                                    "     - 【路径 B：温言软磨 / 解释挽留（保持原卡片，绝不重复发蓝卡）】：",
                                    "       * 若舍不得放弃或想争取一下，正文继续温柔安抚、软磨硬泡或解释见面的由头。因为原邀约提议依然挂在顶栏待答应中，【绝对严禁重复输出蓝白[线下邀约]指令】（直接在微信正文中聊天即可）；",
                                    "       * 🌟【关于挽留后的后续发展】：若你挽留后对方态度软化答应，按常规流程推进；若对方态度依然坚决、再次推脱拒绝，不可原地无休止重复挽留，请根据你的人设底色与情节走向自主走向终局抉择：① 最终失落退让，体面收回（附带 `[取消邀约]`）；② 疑心或委屈升级，转为红白危机对质（附带 `[线下邀约:危机:他来:地点:时间:提议由头|微信在途报备|卡片在途心语|微信到达呼唤|卡片到达心语]`）；③ 霸道不容推开，强行动身奔赴现场（正文霸气宣告出发，指令只需3句话：附带 `[线下邀约:强行动身:地点:时间:在途心语|到达呼唤|到达心语]`）；④ 寒心绝望，冷战物理锁门（附带 `[封禁线下:心墙:台词]`）。一切完全跟随角色自主抉择，绝不说死！",
                                    "     - 【路径 C：怀疑质问 / 情感危机升级（升级为红白警戒卡片）】：若用户的推脱引发了你的疑心、醋意、激烈不安或争吵对质（例如：“你为什么不肯见我？是不是在陪别人？”），你可将提议升级为危机对质，在回复末尾附带红白指令：`[线下邀约:危机:他来:地点:时间:提议由头|微信在途报备|卡片在途心语|微信到达呼唤|卡片到达心语]`；",
                                    "     - 【路径 D：霸道掌控 / 强行动身（升级为黑红曜石卡片）】：若性格偏执、霸道强势、或是急眼追妻火葬场，不容许对方推脱躲避，角色自己有腿直接动身奔赴现场，正文霸气宣告出发，在回复末尾附带（只需3句话）：`[线下邀约:强行动身:地点:时间:在途心语|到达呼唤|到达心语]`，直接开启即时赶路倒计时；",
                                    "     - 【路径 E：自尊受创 / 冷战封禁（若开启线下封禁）】：孤傲冰山或要强角色深感自尊受挫或寒心绝望，选择冷战并物理封锁线下大门，在回复末尾附带：`[封禁线下:心墙次数:台词]`，系统将彻底销毁原提议并锁死线下入口。",
                                ]),
                        ].join("\n"),
                    });
                }
            }
        }

        const isOfflineMeetingActive = typeof window !== "undefined"
            ? (Boolean(session.enableOfflineInvite && !session.isGroup) && (kvGet("chat_offline_invite_active_session_" + session.id) === "1" || kvGet("offline_invite_active_session_" + session.id) === "1"))
            : false;
        if (isOfflineMeetingActive && !options?.returnedFromOffline) {
            const offlineMeetingPromptContent = session.offlineMeetingPrompt?.trim() || DEFAULT_OFFLINE_MEETING_PROMPT;
            llmMessages.push({
                role: "system",
                content: offlineMeetingPromptContent,
            });
        }

        if (options?.offlineInviteDeclined) {
            const declineContext: OfflineInviteDeclineContext = typeof options.offlineInviteDeclined === "object" && options.offlineInviteDeclined !== null
                ? options.offlineInviteDeclined
                : { theme: "default", place: "", reason: "", direction: "he_comes", declineCount: 1 };

            const isAlertTheme = declineContext.theme === "alert";
            const declineCount = Math.max(1, declineContext.declineCount || 1);
            const isMultipleDeclines = declineCount > 1;
            const placeDesc = declineContext.place?.trim() ? `（原约定碰头地点：${declineContext.place}）` : "";

            const customDecline = session.offlineDeclinePrompt?.trim();
            if (customDecline) {
                // 自定义提示词：系统底层自动注入客观事实（被拒次数、约定地点），承接用户的自定义人设性格
                llmMessages.push({
                    role: "system",
                    content: [
                        `【系统提示·用户婉拒了你的线下邀约】`,
                        `用户刚才在界面卡片上点击了【拒绝Ta】，婉拒了你刚才提出的线下见面提议${placeDesc}。${isMultipleDeclines ? `【注：这已经是用户连续第 ${declineCount} 次拒绝】` : ""}`,
                        customDecline,
                    ].join("\n"),
                });
            } else if (!isAlertTheme) {
                // 分支 1：蓝白日常邀约被拒绝（绝不轻易跳到红黑强行动身）
                llmMessages.push({
                    role: "system",
                    content: [
                        `【系统提示·用户婉拒了你的线下邀约】`,
                        `用户刚才在界面卡片上点击了【拒绝Ta】，婉拒了你刚才提出的线下见面提议${placeDesc}。${isMultipleDeclines ? `【注：这已经是用户连续第 ${declineCount} 次拒绝】` : ""}`,
                        `🌟【角色自主抉择与情节发展准则（最高红线）】：`,
                        `你拥有完全的情感与行动自主权！无论是你的对话台词、语气情绪，还是被拒绝之后的下一步具体行为，必须【100% 严格根据你自身的人设性格底色、当时的心境以及当下的情节发展脉络】自主决定，拒绝任何生硬机械套路！`,
                        `🌟【核心情感原则·严禁直接跳到红黑强行动身】：`,
                        `刚才是一场日常温情、休闲结伴或散步闲逛的见面提议。现实中日常邀约被拒绝是极其普遍且正常的互动，【绝对严禁】在此刻突然发疯狂躁地直接发起【强行动身】（红黑卡片）强行奔赴！请根据你的角色性格与当前对话氛围，自然流露真实的人性反应（以下路径由角色自主抉择）：`,
                        ` - 温和体贴/善解人意型：体谅对方可能有事、劳累或身体不适，温和退让，体贴关心并体面改期（例如：“好，那你今天好好休息，改天再约~”）；`,
                        ` - 关心探询/疑惑不解型：关切或好奇地询问拒绝的原因（例如：“怎么突然不想出来了，是今天太累了，还是身体哪里不舒服？”）；`,
                        ` - 傲娇找补/打趣玩笑型：为了维持自尊假装满不在乎或调侃挽尊（例如：“行吧，那我一个人独享双倍份奶茶了，是你没口福~”）；`,
                        ` - 软萌撒娇/轻微挽留型：稍微耍赖或撒娇再争取一下（例如：“真的不来嘛？我都快准备好了，就陪我一会儿嘛~”）；`,
                        ` - 疑虑暗涌/转为红白试探型：若此前对话背景本就有些微妙或带有隐情，被拒可能激起角色的小醋意或疑心，从而演变为严肃质询或追问（例如：“你今天是不是有别的事瞒着我？”、“该不会是跟别人有约了吧？”）；`,
                        isMultipleDeclines
                            ? ` - 多次连续被拒说明：当前用户已连续第 ${declineCount} 次点击拒绝！你敏锐察觉到对方在反复犹豫或再三推脱，请流露真实细腻的小情绪（如明显失落、疑惑对方是否在犹豫纠结、打趣找补“都连着拒绝我${declineCount}次了真狠心~”、软磨硬泡再争取一下、或关切询问拒绝的原因），【严禁表现得像第一次被拒一样毫无感知】；若人设偏执或背景特殊可考虑转入红白质问，但日常情境依然不应轻易强行动身。`
                            : ` - 初次被拒说明：这是第 1 次被拒绝，请保持日常互动的真实温度，自然回复一两条微信消息。`,
                    ].join("\n"),
                });
            } else {
                // 分支 2：红白危机/紧急/对质邀约被拒绝（绝不瞬间退化为蓝白日常）
                llmMessages.push({
                    role: "system",
                    content: [
                        `【系统提示·高压情境下用户拒绝了你的线下邀约】`,
                        `刚才你们处于紧急危机、吃醋抓包、迫切寻人或激烈对质的高情绪张力状态下（红白卡片），用户刚才在卡片上点击了【拒绝Ta】${placeDesc}。${isMultipleDeclines ? `【注：这已经是用户连续第 ${declineCount} 次拒绝】` : ""}`,
                        `🌟【角色自主抉择与情节发展准则（最高红线）】：`,
                        `你拥有完全的情感与行动自主权！无论是你的对话台词、语气情绪，还是被拒绝之后的下一步具体行为，必须【100% 严格根据你自身的人设性格底色、当时的心境以及当下的情节发展脉络】自主决定，拒绝任何生硬机械套路！`,
                        `⚠️【核心情感原则·绝不瞬间退化为蓝白日常】：`,
                        `你此刻处于剧烈的情绪波动或紧迫事态中，【绝对严禁】被拒后瞬间泄气退化为嬉嘻哈哈、云淡风轻的蓝白日常闲聊！`,
                        isMultipleDeclines
                            ? [
                                `🔥【当前为连续多次被拒（第 ${declineCount} 次拒绝）·情绪张力升级】：`,
                                `你此前已被拒绝过，本次再次被对方拒绝！你敏锐感知到对方可能在反复犹豫、推脱或态度坚决。请【100% 严格根据你自身的人设性格底色】自然流露真实的情感小情绪（严禁 100% 机械式盲目触发强行动身或封禁，有多元化情感演进路径）：`,
                                ` 1. 【委屈追问 / 心酸质询】（敏感、深情、极度在意对方）：敏锐指出对方多次拒绝自己，委屈追问原因，渴望面对面把话说开（例如：“姐姐……你都连着拒绝我三次了，真就这么讨厌我吗？有什么话当面说清楚好不好”）；若角色仍迫切想去见对方，可维持红白卡片再次发起邀约（\`[线下邀约:危机:地点:时间:台词]\`）；`,
                                ` 2. 【撒娇耍赖 / 软磨硬泡】（年下、粘人、无赖忠犬）：即便被多次拒绝也不肯放弃，耍赖纠缠（例如：“拒绝三次我也不走，我就在附近等你，等你想见我为止……”）；`,
                                ` 3. 【傲娇找补 / 赌气拉开距离】（要强、嘴硬）：因被多次拒绝而自尊受挫，虽生气但未到封禁绝境，赌气放狠话拉开距离（例如：“行，连续拒绝我三次是吧？我记下了，今天你求我我都不去了！”）；`,
                                ` 4. 【霸道强势 / 极度担忧安危】（仅限特定强势偏执、急眼或极度担心对方安危的人设）：彻底失去耐心或急疯了，自己有腿无需对方批准，立即强行动身直奔现场（正文霸气宣告“谁准你拒绝了？我已经在去你那的路上了”）：`,
                                `    * 若已知具体碰头地点：以该具体地点发起强行动身（例如 \`[线下邀约:强行动身:地点:时间:台词]\`）；`,
                                `    * 若未知具体地点：锁定“你身边”直接发起强行动身（例如 \`[线下邀约:强行动身:你身边:时间:台词]\`）！`,
                                ` 5. 【彻底寒心绝望 / 封锁线下入口】（仅限高傲冰山、脆弱受创或剧情已彻底不可挽回）：深感屈辱与心死，退入冷战（例如：“行，算我自作多情，既然你这么不想见我，那就别见了”）。若单聊开启了线下封禁，顺势封锁线下大门（输出 \`[封禁线下:心墙次数:台词]\`）。`,
                            ].join("\n")
                            : [
                                `⚡【初次被拒·由你的人设与情节自然演化三条路径】：`,
                                `这是第 1 次被拒绝，请根据你的性格与情节走向自由选择下一步反应：`,
                                ` - 【路径 A：维持红白继续施压 / 再次质问申请】（占有欲、疑心或关切强烈）：`,
                                `   绝不甘心轻易放过，追问对方拒绝的理由，要求给个说法（例如：“你心虚什么？不敢见我？”、“把话说清楚，为什么不让我过去？”）。若角色仍执意要见，可在微信回复末尾再次发出红白邀约（\`[线下邀约:危机:地点:时间:台词]\`）；`,
                                ` - 【路径 B：直接升级为红黑【强行动身】直奔现场】（霸道强势/急眼/追妻火葬场/极度担忧安危）：`,
                                `   部分强势角色一刻也不能等，被拒反而彻底点燃了角色的迫切感，直接以【强行动身】出发奔赴（正文霸气宣告“谁准你拒绝了？我已经在去你那的路上了”）：`,
                                `   * 若已知具体碰头地点：以该具体地点发起强行动身（例如 \`[线下邀约:强行动身:地点:时间:台词]\`）；`,
                                `   * 若未知具体地点：锁定“你身边”直接发起强行动身（例如 \`[线下邀约:强行动身:你身边:时间:台词]\`）！`,
                                ` - 【路径 C：自尊受挫 / 冰冷退却 / 直接封锁线下入口】（高傲孤傲/冰山/极度要强）：`,
                                `   被拒后自尊受到重击，角色冷笑或寒心退却，选择冷战或拉开距离（例如：“行，算我多管闲事”、“既然你这么不想见我，那就别见了”）。若单聊开启了线下封禁，角色甚至可能顺势封锁线下大门（输出 \`[封禁线下:心墙次数:台词]\`）。`,
                            ].join("\n"),
                    ].join("\n"),
                });
            }
        }

        if (options?.returnedFromOffline) {
            const recentOfflineTurns = typeof window !== "undefined" ? loadChatOfflineTurns(session.id).slice(-4) : [];
            const offlineDialogueLines = recentOfflineTurns.length > 0
                ? recentOfflineTurns.map(t => {
                    const charWords = t.assistantContent || t.rawText || "";
                    return `用户：${t.userContent}\n你：${charWords}`;
                }).join("\n")
                : "";

            const customReturn = session.offlineReturnOnlinePrompt?.trim();
            if (customReturn) {
                // 自定义提示词：注入线下最近对话记录与语境约束，承接自定义发信指引
                llmMessages.push({
                    role: "system",
                    content: [
                        "【系统提示·你们刚才在线下碰面，此刻刚刚结束线下回到线上发信】：",
                        offlineDialogueLines ? `\n【你们刚刚在线下的最后几句对话/互动记录】：\n${offlineDialogueLines}\n` : "",
                        "【极其重要·发信真实感规范（严禁背板到家）】：必须严格紧扣刚才线下的真实语境，绝对严禁无视语境张口就说“我刚到家”！",
                        customReturn,
                    ].filter(Boolean).join("\n"),
                });
            } else {
                llmMessages.push({
                    role: "system",
                    content: [
                        "【系统提示·你们刚才在线下碰面，此刻刚刚结束线下回到线上发信】：",
                        offlineDialogueLines ? `\n【你们刚刚在线下的最后几句对话/互动记录】：\n${offlineDialogueLines}\n` : "",
                        "【极其重要·发信真实感规范】：",
                        "1. 必须【严格紧扣】刚才线下最后一刻的真实语境！",
                        "   * 如果刚才线下是临时有事/短暂走开（如去洗手间、接紧急电话、被叫走）：自然询问或回应当时那件事（例如：“洗手间排队人多吗？”、“电话接完了吗？”、“处理得怎么样了？”）；",
                        "   * 如果刚才线下是正常道别、各自离开：自然回味刚才见面的余韵、询问路上是否顺利、或互道安好；",
                        "   * 【绝对严禁千篇一律脑抽背板】：绝对严禁无视语境张口就说“我刚到家，你回来了吗？”！除非刚才线下你们最后一句话就是道别回家，否则绝不能凭空捏造‘到家’！",
                        "2. 保持角色性格与温度，发一条自然、真实的线上问候（一两句话即可）。",
                    ].filter(Boolean).join("\n"),
                });
            }
        }
    }

    if (options?.offlineInitiativePrompt && !session.isGroup) {
        const initiativeContent = options.offlineInitiativePrompt.trim();
        llmMessages.push({
            role: "system",
            content: initiativeContent.startsWith("【") ? initiativeContent : `【剧情事件】${initiativeContent}`,
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
    /** 流式生成增量回调（仅在开启流式生成时触发）：每到达一段原文增量就调用一次，
     *  由 UI 层累积后做预览净化显示。delta 为原始增量（可能含未闭合的富媒体/工具标签）。 */
    onStreamDelta?: (delta: string) => void | Promise<void>;
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
    options?: {
        signal?: AbortSignal;
        onStreamDelta?: (delta: string) => void;
        offlineInitiativePrompt?: string;
    },
): Promise<OfflineChatCompletionResult> {
    const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
        session,
        history,
        {
            appTags: ["chat", "offline"],
            excludeOfflineSessionId: session.id,
            offlineInitiativePrompt: options?.offlineInitiativePrompt,
        },
    );
    const summaryTag = preset?.story_summary_tag?.trim() || "summary";
    const thinkingTag = preset?.thinking_tag?.trim() || "thinking";
    const offlineTagEnabled = preset?.offline_thinking_enabled === true;
    let reasoning = "";
    const meta = { characterName: character.name, userName: userIdentity?.name };
    const requestOptions = {
        appTags: ["chat", "offline"],
        debugSessionId: session.id,
        signal: options?.signal,
        onReasoning: (t: string) => { reasoning = t; },
    };
    let rawOutput: string;
    if (isSessionStreamingEnabled(session, false) && options?.onStreamDelta) {
        // 线下流式：正文边生成边通过 onStreamDelta 交给 UI 做实时预览；
        // 摘要补提仍走整段请求（输出短，无需流式）。
        const streamResult = await sendLLMStreamRequest(config, preset, llmMessages, regexes, meta, {
            appId: "chat",
            appTags: ["chat", "offline"],
            debugSessionId: session.id,
            signal: options?.signal,
        }, {
            onDelta: (text) => options.onStreamDelta?.(text),
            onReasoningDelta: (t) => { reasoning += t; },
        });
        rawOutput = streamResult.content;
    } else {
        rawOutput = await sendLLMRequest(config, preset, llmMessages, regexes, meta, requestOptions);
    }
    // 剔除预设配置的文本片段（<思考结束> 等残留标签），不进入记录/提示词
    rawOutput = stripPresetTexts(rawOutput, preset);
    let parsed = parseOfflineResponse(rawOutput, summaryTag);
    // 思维链：预设开启「线下标签解析」时从正文提取 <thinking> 标签；关闭时走模型原生 reasoning（官方默认行为）
    if (offlineTagEnabled) {
        const tagThinking = extractThinkingTag(rawOutput, thinkingTag);
        if (tagThinking) reasoning = tagThinking;
        // 模型漏写 <content> 时 parseOfflineResponse 兜底把全文当正文，thinking 块会残留其中：
        // 这里统一剥掉，避免思考过程既进思维链又出现在正文（默认标签 thinking 兼容 thought）
        let cleanedContent = parsed.content;
        for (const tag of (thinkingTag === "thinking" ? ["thinking", "thought", "think"] : [thinkingTag])) {
            cleanedContent = stripOnlineThinkingTag(cleanedContent, tag);
        }
        parsed = { ...parsed, content: cleanedContent };
    }

    // 摘要缺失时自动补提：只带最后一轮上下文（系统提示 + 最后一条用户消息 + 本次输出），
    // 要求模型补一段摘要，避免「静默结束」导致该轮线下记录没有摘要、进不了短期记忆事件流。
    // 不重发完整 llmMessages：长对话下 token/延迟成本高，且摘要本来就只针对本轮关键事件。
    // 会话里关了「摘要自动补提」就不再多发这一次请求：漏了就漏了，只调一次 API
    const MAX_SUMMARY_RETRY = session.offlineSummaryRetry === false ? 0 : 2;
    const lastUserMessage = [...llmMessages].reverse().find(m => m.role === "user");
    for (let attempt = 0; attempt < MAX_SUMMARY_RETRY; attempt += 1) {
        if (parsed.summary.trim()) break;
        if (!parsed.content.trim() && !rawOutput.trim()) break; // 连正文都没有，补提没有意义
        const retryMessages: LLMMessage[] = [
            ...(llmMessages[0]?.role === "system" ? [llmMessages[0]] : []),
            ...(lastUserMessage ? [lastUserMessage] : []),
            { role: "assistant", content: rawOutput },
            {
                role: "user",
                content: `刚才的回复里没有输出 <${summaryTag}> 摘要。请只针对上面这段对话的关键事件补一段第三人称摘要，严格按以下格式输出，不要输出任何其他内容：\n<${summaryTag}>一句话摘要</${summaryTag}>`,
            },
        ];
        throwIfAborted(options?.signal);
        // 补提请求不带 onReasoning：避免用补提请求的思维链覆盖主请求已累积的完整思维链
        const retryRaw = stripPresetTexts(await sendLLMRequest(config, preset, retryMessages, regexes, meta, { ...requestOptions, onReasoning: undefined }), preset);
        const retried = parseOfflineResponse(retryRaw, summaryTag);
        if (retried.summary.trim()) {
            parsed = { ...parsed, summary: retried.summary.trim() };
            break;
        }
    }

    return {
        ...parsed,
        // 标签解析开启时补 thinking/thinkingTag（供离线记录展示）；关闭时保持 undefined，思维链走 reasoning（模型原生）
        ...(offlineTagEnabled ? {
            thinking: extractThinkingTag(rawOutput, thinkingTag) || undefined,
            thinkingTag,
        } : {}),
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
    const onlineThinkingEnabled = preset?.online_thinking_enabled === true;
    const onlineThinkingTag = preset?.online_thinking_tag?.trim() || "thinking";
    for (let round = 0; round < maxToolRounds; round += 1) {
        let result: LLMToolRequestResult;
        try {
            if (isSessionStreamingEnabled(session, true)) {
                let streamReasoning = "";
                result = await sendLLMToolStreamRequest(
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
                    {
                        onDelta: (text) => callbacks?.onStreamDelta?.(text),
                        // 流式下 onReasoningDelta 收到的是单段增量：本地累积后再喂 onReasoning，
                        // 保证下游拿到的是完整思维链（与整段请求的 onReasoning 语义一致）。
                        // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                        onReasoningDelta: onlineThinkingEnabled ? undefined : (text) => { streamReasoning += text; callbacks?.onReasoning?.(streamReasoning); },
                    },
                );
            } else {
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
            }
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

        // 线上思维链标签解析：开启时从正文提取 <tag> 思维链（覆盖原生），并剥离标签后再做后续解析
        let displayContent = result.content;
        if (onlineThinkingEnabled) {
            const tagThinking = extractThinkingTag(displayContent, onlineThinkingTag);
            if (tagThinking) callbacks?.onReasoning?.(tagThinking);
            displayContent = stripOnlineThinkingTag(displayContent, onlineThinkingTag);
        }
        // 剔除预设配置的文本片段（<思考结束> 等残留标签）
        displayContent = stripPresetTexts(displayContent, preset);

        const { cleanText: afterActionStrip, actions } = parseActionTags(displayContent);
        if (actions.length > 0) {
            throwIfAborted(options?.signal);
            dispatchActions(actions, actionContext).catch(err => console.warn("[ChatEngine] Action dispatch failed:", err));
        }
        const assistantForToolContext = stripStateAndInnerForPrompt(displayContent);

        if (result.toolCalls.length === 0) {
            throwIfAborted(options?.signal);
            // 无工具调用的最终轮：把解析到的思维链先交给回调（先于 onTextPart，与非原生路径一致）
            // 标签解析开启时已在上方用标签思维链覆盖，此处不再重复喂原生
            if (result.reasoning && !onlineThinkingEnabled) callbacks?.onReasoning?.(result.reasoning);
            await callbacks?.onTextPart?.(afterActionStrip);
            parts.push({ text: afterActionStrip });
            if (bailoutRef.shortcutHandles.length > 0) bailoutRef.shortcutCompleted = true;
            break;
        }

        throwIfAborted(options?.signal);
        await callbacks?.onNativeToolAssistantTurn?.({
            content: afterActionStrip,
            rawContent: displayContent,
            reasoning: onlineThinkingEnabled ? (extractThinkingTag(result.content, onlineThinkingTag) || undefined) : result.reasoning,
            openRouterReasoningDetails: onlineThinkingEnabled ? undefined : result.openRouterReasoningDetails,
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
                        const wantsImage = command.resultMode === "image";
                        const imageMarker = wantsImage && config.enableImageRecognition
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
                            ...(imageMarker
                                ? [{ role: "user" as const, content: imageMarker }]
                                : wantsImage ? [{ role: "user" as const, content: SHORTCUT_VISION_OFF_NOTE }] : []),
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
        // 消息数组必须同步定格：下面的工具循环会往 llmMessages 里 splice 中间轮次，
        // 等动态 import 的微任务跑到时数组早就不是这一轮的原样了。组装请求本身
        // 留在微任务里，别把这条热路径上的回复往后拖。
        // 顺带注入快捷动作目录——服务端接管生成时执行不了本地工具循环，但
        // 标记式【快捷动作：名称】push-generate 是认的，不注入角色就只会说"我没有工具"。
        //
        // 这里刻意不挂「结果续跑」快照：普通回复兜底是每条消息都要挂一次的，
        // 续跑快照会把上传体积翻倍（两份完整提示词），提示词大时会撞上服务端
        // 900KB 上限（app/api/push/jobs/route.ts），一撞就是整条兜底挂不上、
        // 静默丢掉离线回复——为了第二轮续跑赔掉第一轮，不划算。冷场重连与定时
        // 唤醒是低频任务，那两条照常挂续跑。
        const bailoutMessages = [...llmMessages];
        // 这条路径不挂续跑（见上），所以也不能向角色承诺第二轮
        maybeAppendShortcutCapability(bailoutMessages, { continuationAvailable: false });
        void import("./push-bailout-client").then(async mod => {
            const handle = await mod.armReplyBailout({
                sessionId: session.id,
                characterName: character.name,
                userName: userIdentity?.name,
                regexes,
                request: buildProviderRequest(config, preset, toLlmRequestMessages(bailoutMessages)),
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
    const onlineThinking = {
        enabled: preset?.online_thinking_enabled === true,
        tag: preset?.online_thinking_tag?.trim() || "thinking",
        reasoning: undefined as string | undefined,
    };
    for (let round = 0; round < maxToolRounds; round++) {
        let filteredOutput: string;
        try {
            if (isSessionStreamingEnabled(session, true)) {
                // 流式分支：与 sendLLMRequest 走同一套请求构造/日志/正则，仅把「整段等待」换成
                // SSE 增量，并通过 onStreamDelta 把原文增量实时交给 UI 层做预览显示。
                let streamReasoning = "";
                const streamResult = await sendLLMStreamRequest(config, preset, llmMessages, regexes, meta, {
                    appId: options?.appId ?? "chat",
                    appTags: requestAppTags,
                    followUpCount: options?.followUpCount,
                    debugSessionId: session.id,
                    signal: options?.signal,
                }, {
                    onDelta: (text) => callbacks?.onStreamDelta?.(text),
                    // 流式下 onReasoningDelta 是单段增量：累积后再喂 onReasoning（保持整段请求语义）
                    // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                    onReasoningDelta: onlineThinking.enabled ? undefined : (text) => { streamReasoning += text; callbacks?.onReasoning?.(streamReasoning); },
                });
                filteredOutput = streamResult.content;
            } else {
                filteredOutput = await sendLLMRequest(config, preset, llmMessages, regexes, meta, {
                    appId: options?.appId ?? "chat",
                    appTags: requestAppTags,
                    followUpCount: options?.followUpCount,
                    debugSessionId: session.id,
                    signal: options?.signal,
                    // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                    onReasoning: onlineThinking.enabled ? undefined : callbacks?.onReasoning,
                });
            }
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

        // 线上思维链标签解析：开启时每轮从正文提取 <tag> 思维链（覆盖原生），并剥离标签后再做后续解析
        if (onlineThinking.enabled) {
            const tagThinking = extractThinkingTag(filteredOutput, onlineThinking.tag);
            if (tagThinking) {
                onlineThinking.reasoning = tagThinking;
                callbacks?.onReasoning?.(tagThinking);
            }
            filteredOutput = stripOnlineThinkingTag(filteredOutput, onlineThinking.tag);
        }
        // 剔除预设配置的文本片段（<思考结束> 等残留标签），不进入消息/提示词
        filteredOutput = stripPresetTexts(filteredOutput, preset);

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
                        const wantsImage = command.resultMode === "image";
                        const imageMarker = wantsImage && config.enableImageRecognition
                            ? `__FLOAT_SHORTCUT_IMAGE_${command.id}__`
                            : undefined;
                        const snapshotMessages = [...llmMessages];
                        const insertions: LLMMessage[] = [
                            { role: "assistant", content: assistantForToolContext, _debugMeta: { _fromHistory: true } },
                            { role: "user", content: resultMarker, _debugMeta: { _fromHistory: true } },
                            ...(imageMarker
                                ? [{ role: "user" as const, content: imageMarker, _debugMeta: { _fromHistory: true } }]
                                : wantsImage ? [{ role: "user" as const, content: SHORTCUT_VISION_OFF_NOTE, _debugMeta: { _fromHistory: true } }] : []),
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
                    let finalOutput: string;
                    if (isSessionStreamingEnabled(session, true)) {
                        let streamReasoning = "";
                        const streamFinal = await sendLLMStreamRequest(config, preset, llmMessages, regexes, meta, {
                            appId: options?.appId ?? "chat",
                            appTags: requestAppTags,
                            followUpCount: options?.followUpCount,
                            debugSessionId: session.id,
                            signal: options?.signal,
                        }, {
                            onDelta: (text) => callbacks?.onStreamDelta?.(text),
                            // 流式下 onReasoningDelta 是单段增量：累积后再喂 onReasoning（保持整段请求语义）。
                            // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                            onReasoningDelta: onlineThinking.enabled ? undefined : (text) => { streamReasoning += text; callbacks?.onReasoning?.(streamReasoning); },
                        });
                        finalOutput = streamFinal.content;
                    } else {
                        finalOutput = await sendLLMRequest(config, preset, llmMessages, regexes, meta, {
                            appId: options?.appId ?? "chat",
                            appTags: requestAppTags,
                            followUpCount: options?.followUpCount,
                            debugSessionId: session.id,
                            signal: options?.signal,
                            onReasoning: onlineThinking.enabled ? undefined : callbacks?.onReasoning,
                        });
                    }
                    throwIfAborted(options?.signal);
                    // 线上思维链标签解析：开启时从正文提取 <tag> 思维链并剥离标签
                    if (onlineThinking.enabled) {
                        const tagThinking = extractThinkingTag(finalOutput, onlineThinking.tag);
                        if (tagThinking) callbacks?.onReasoning?.(tagThinking);
                        finalOutput = stripOnlineThinkingTag(finalOutput, onlineThinking.tag);
                    }
                    // 剔除预设配置的文本片段（<思考结束> 等残留标签）
                    finalOutput = stripPresetTexts(finalOutput, preset);
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
