// lib/group-chat-engine.ts
// Group chat engine: single API call for all characters.

import { ChatSession, ChatMessage, loadChatAppSettings, createResponseBatchId, createResponseRoundId, createToolExecutionId, loadChatSessions, getLatestCharacterStateValues, isSessionStreamingEnabled } from "./chat-storage";
import { extractTextToolDirectiveText } from "./text-tool-protocol";
import type { ApiConfig, PresetConfig, RegexConfig } from "./settings-types";
import { loadCharacters } from "./character-storage";
import { buildScreenEffectPromptHint } from "./chat-screen-effects";
import { runChatPluginTransform } from "./chat-plugin-hooks";
import { buildChatPluginPromptFragments } from "./chat-plugin-storage";
import {
    sendLLMRequest,
    sendLLMStreamRequest,
    sendLLMToolRequest,
    sendLLMToolStreamRequest,
    ChatEngineError,
    buildMusicLocalMacro,
    buildMusicCloudMacro,
    buildChatBilingualInstruction,
    buildOfflineBilingualInstruction,
    previewMessagesForApi,
    applyVisionImagePromptLimit,
    resolveCompressedImageDataUrl,
    prepareVisionPromptImageMessage,
    buildNativeChatTools,
    formatNativeChatToolResult,
    formatNativeLoaderToolResult,
    isNativeSingleTool,
    nativeToolSourceKey,
    normalizeNativeExpandedToolSourceIds,
    persistNativeExpandedToolSourceIds,
    publishDebugPromptSnapshot,
    touchNativeExpandedToolSource,
    appendEmptyGenerateGuardMessage,
    applyCustomPromptProfileToPreset,
    stripOnlineThinkingTag,
    stripPresetTexts,
    type ChatCompletionCallbacks,
    type NativeChatToolBundle,
} from "./chat-engine";
import type { CustomAppPromptProfile } from "./custom-app-types";
import { isNeteaseConfigured } from "./music-service";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import {
    resolveBinding,
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    resolveUserIdentity,
} from "./settings-storage";
import {
    assembleGroupPromptPayload,
    formatRichMediaForHistory,
    type LLMMessage,
    type GroupMemberData,
} from "./llm-prompt-assembler";
import {
    getStatusRegionConfig,
    resolveStatusRegionSection,
    resolveStatusRegionExampleLine,
    resolveStatusRegionComposition,
    resolveStatusRegionFullExample,
} from "./chat-status-region";
import { loadMemoryConfig, incrementEventCounter } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { maybeRunSummarization } from "./memory-summarizer";
import { prepareShortTermContext, prepareGroupShortTermContext } from "./short-term-assembler";
import { parseActionTags, dispatchActions } from "./action-parser";
import { getCustomStickerExample, loadCustomStickers } from "./custom-sticker-storage";
import { formatCustomAppChatDirectivesForPrompt } from "./custom-app-chat-directives";
import { findEnabledToolForSchema, getEnabledTools } from "./tool-storage";
import { formatToolsForPrompt, formatGroupToolsForPrompt, formatToolSchema } from "./tool-prompt";
import { parseToolCalls, parseToolFetches, executeToolCalls, formatToolResults, type ToolCall } from "./tool-executor";
import { stripStateAndInnerForPrompt } from "./prompt-sanitizer";
import { buildGroupRosterMacro } from "./group-admin";
import { parseOfflineResponse, extractThinkingTag, type ParsedOfflineResponse } from "./chat-offline-storage";
import { buildProviderRequest, nativeToolProtocolForConfig, toLlmRequestMessages, type LlmRequestMessage, type LlmToolCall } from "./llm-provider-adapter";
import type { DebugPromptSnapshot } from "./debug-store";
import { throwIfAborted } from "./abort-utils";
import { buildCharacterTimeContext, buildGroupTimeContext } from "./character-time";
import { getPromptTimestampOptionsForTimeContext } from "./prompt-time";

function stripGroupFinancialActionsForMetadataRepair(text: string): string {
    return stripStateAndInnerForPrompt(text)
        .replace(/\[[^\]\n]+领取了[^\]\n]+的红包\]/g, "")
        .replace(/\[[^\]\n]+退回了[^\]\n]+的红包\]/g, "")
        .replace(/\[[^\]\n]+(?:接受|领取)了[^\]\n]+的转账\]/g, "")
        .replace(/\[[^\]\n]+(?:拒收|退回)了[^\]\n]+的转账\]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Annotate chat history messages with sender name prefixes for group context.
 * Transforms message content so each message is prefixed with "[SenderName]: ".
 */
export function annotateGroupHistory(
    messages: ChatMessage[],
    participantIds: string[],
    userName: string,
): ChatMessage[] {
    const chars = loadCharacters();
    const charMap = new Map(chars.map(c => [c.id, c.name]));

    return messages.map(msg => {
        if (msg.role === "system") return msg;

        let senderName: string;
        if (msg.role === "user") {
            senderName = userName;
        } else {
            // assistant message — use senderName or look up from senderCharacterId
            senderName = msg.senderName || charMap.get(msg.senderCharacterId || "") || "未知";
        }

        // For rich-media messages, resolve content from mediaType/mediaData
        // charName = the "other party": for user msgs use recipient or "群聊", for AI msgs use the character's own name
        let content = msg.content;
        if (msg.mediaType) {
            const charName = msg.role === "user"
                ? (msg.mediaData?.recipientName || "群聊")
                : senderName;
            content = formatRichMediaForHistory(msg, userName, charName, true);
        }

        return {
            ...msg,
            content: `[${senderName}]: ${content}`,
        };
    });
}

/**
 * Parse the LLM output in [角色名]: format into per-character results.
 * Falls back: if no known name prefix found, assigns entire output to the first member.
 */
export function parseGroupChatResponse(
    text: string,
    nameToId: Map<string, string>,
): { characterId: string; characterName: string; responseText: string }[] {
    const names = [...nameToId.keys()];
    // 通用切分：任何 [名字]: 行都开启新段落——包括被踢成员、冒用的用户名或
    // 幻觉名字。未知名字的段落随后被 nameToId 校验整段丢弃，防止其内容以
    // 字面文本粘进上一个合法角色的气泡（或经兜底逻辑错挂到第一个成员头上）。
    const pattern = /^\[([^\]\n]{1,32})\]:\s*/;

    const segments: { name: string; lines: string[] }[] = [];
    let currentName: string | null = null;

    for (const line of text.split("\n")) {
        const match = line.match(pattern);
        if (match) {
            const name = match[1].trim();
            const rest = line.slice(match[0].length);
            currentName = name;
            segments.push({ name, lines: [rest] });
        } else if (currentName && segments.length > 0) {
            segments[segments.length - 1].lines.push(line);
        }
    }

    if (segments.length === 0) {
        // Fallback: no [Name]: prefix found — assign to first member
        const firstName = names[0];
        if (!firstName) return [];
        const charId = nameToId.get(firstName)!;
        return [{ characterId: charId, characterName: firstName, responseText: text.trim() }];
    }

    const rawResults: { characterId: string; characterName: string; responseText: string }[] = [];
    for (const seg of segments) {
        const content = seg.lines.join("\n").trim();
        if (!content) continue;
        const charId = nameToId.get(seg.name);
        if (!charId) continue;
        rawResults.push({ characterId: charId, characterName: seg.name, responseText: content });
    }

    // Preserve original segment order, but repair a common format slip:
    // [Name]: [state][inner] followed by another [Name]: actual message.
    // The first block may include a handled financial action like [A领取了B的红包].
    // Without this, the metadata block becomes a separate silent heart row.
    const results: { characterId: string; characterName: string; responseText: string }[] = [];
    for (let i = 0; i < rawResults.length; i += 1) {
        const current = rawResults[i];
        const next = rawResults[i + 1];
        if (
            next &&
            current.characterId === next.characterId &&
            stripGroupFinancialActionsForMetadataRepair(current.responseText) === ""
        ) {
            rawResults[i + 1] = {
                ...next,
                responseText: `${current.responseText}\n${next.responseText}`.trim(),
            };
            continue;
        }
        results.push(current);
    }

    return results;
}

function stripToolTags(text: string): string {
    return text
        .replace(/\[[^\]]*?(?:获取指令|获取工具)[:：][^\]]*\]/g, "")
        .replace(/\[[^\]]*?(?:执行动作|工具调用)[:：][^\]]*?[（(][\s\S]*?[)）]\]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function resolveGroupToolActor(
    actor: string | undefined,
    nameToId: Map<string, string>,
): { actorName: string; characterId: string } | { actorName: string; error: string } {
    const actorName = actor?.trim() || "";
    if (!actorName) {
        return { actorName, error: "群聊动作必须标注执行角色，请使用当前群成员名。" };
    }
    const characterId = nameToId.get(actorName);
    if (!characterId) {
        return { actorName, error: `群聊成员「${actorName}」不存在，请从当前群成员中选择。` };
    }
    return { actorName, characterId };
}

function attachGroupToolActor<T extends Awaited<ReturnType<typeof executeToolCalls>>[number]>(
    result: T,
    actor: { actorName: string; characterId: string },
): T {
    return {
        ...result,
        actorName: actor.actorName,
        actorCharacterId: actor.characterId,
    };
}

export function buildEditableGroupRoundText(
    results: { characterName: string; responseText: string }[],
): string {
    return results
        .map((result) => {
            const { cleanText } = parseActionTags(result.responseText);
            const cleaned = stripToolTags(cleanText).trim();
            return cleaned ? `[${result.characterName}]: ${cleaned}` : "";
        })
        .filter(Boolean)
        .join("\n\n");
}

function scheduleGroupMemorySummarization(
    participantIds: string[],
    chars: ReturnType<typeof loadCharacters>,
    history: ChatMessage[],
    replyCount: number,
): void {
    const lastMessage = history[history.length - 1];
    const userEventCount = lastMessage?.role === "user" ? 1 : 0;
    const totalNewEvents = userEventCount + replyCount;
    if (totalNewEvents <= 0) return;

    const uniqueParticipantIds = [...new Set(participantIds)];
    for (const characterId of uniqueParticipantIds) {
        const character = chars.find(c => c.id === characterId);
        if (!character) continue;

        for (let i = 0; i < totalNewEvents; i++) {
            incrementEventCounter(characterId);
        }

        maybeRunSummarization(characterId, character.name)
            .catch(err => console.warn("[GroupChat] Memory counter/summarization failed:", err));
    }
}

/**
 * Shared prompt builder for group chat — used by both generate and preview.
 */
export type GroupChatPromptBuildOptions = {
    appTags?: string[];
    excludeOfflineSessionId?: string;
    disableTools?: boolean;
    promptProfile?: CustomAppPromptProfile | null;
    apiConfigId?: string;
};

async function buildGroupChatPromptMessages(
    session: ChatSession,
    history: ChatMessage[],
    options?: GroupChatPromptBuildOptions,
): Promise<{ llmMessages: LLMMessage[]; config: ApiConfig; preset: PresetConfig | null; regexes: RegexConfig[]; nameToId: Map<string, string>; memberNames: string[]; enabledTools: import("./tool-storage").EnabledTool[]; userName: string; appTags: string[] }> {
    const chars = loadCharacters();
    const charMap = new Map(chars.map(c => [c.id, c]));
    const participantIds = session.participantIds || [];

    const bindings = loadBindingConfig();
    const activeSlot = resolveBinding(bindings, undefined, "group_chat");

    const apiConfigs = loadApiConfigs();
    const boundConfigId = options?.apiConfigId || activeSlot.apiConfigId;
    if (!boundConfigId) throw new ChatEngineError("No API Configuration bound for group chat.");
    const config = apiConfigs.find(c => c.id === boundConfigId);
    if (!config) throw new ChatEngineError("API Configuration not found for group chat.");

    const presets = loadPresets();
    let preset = activeSlot.presetId ? presets.find(p => p.id === activeSlot.presetId) || null : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? null;
    const promptProfile = options?.promptProfile ?? undefined;
    if (preset && promptProfile) {
        preset = applyCustomPromptProfileToPreset(preset, promptProfile);
    }

    const allRegexes = loadRegexes();
    const regexes = promptProfile?.enableRegexes === false
        ? []
        : (activeSlot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as typeof allRegexes;

    const userIdentity = resolveUserIdentity(undefined, "group_chat");
    const userName = userIdentity?.name ?? "用户";
    const baseAppTags = options?.appTags ?? ["group_chat", "text"];
    // 围观群：追加 spectator tag 激活围观语境条目（tags 子集过滤，老条目不受影响）。
    // 只在宿主群聊链路追加——自定义 APP 的纯 appTags 生成（generateGroupRawCompletion）不掺宿主场景 tag。
    const activeAppTags = session.isSpectator && baseAppTags.includes("group_chat") && !baseAppTags.includes("spectator")
        ? [...baseAppTags, "spectator"]
        : baseAppTags;
    const isOfflineMode = activeAppTags.includes("offline");

    const memConfig = loadMemoryConfig();
    const allWorldBooks = loadWorldBooks();

    const now = new Date();
    const memberTimeContexts: Record<string, ReturnType<typeof buildCharacterTimeContext>> = {};
    const memberDataPromises = participantIds.map(async (charId): Promise<GroupMemberData | null> => {
        const character = charMap.get(charId);
        if (!character) return null;
        const memberTimeContext = buildCharacterTimeContext(character.timeZone, now);
        memberTimeContexts[charId] = memberTimeContext;
        const scheduleSummary = buildCalendarScheduleMarker("character", charId, getWeekStartIso(now));
        const currentSchedule = getCurrentCalendarScheduleForPrompt("character", charId, now);
        const charSlot = resolveBinding(bindings, charId, "group_chat");
        const worldBooks = promptProfile?.enableWorldBooks === false
            ? []
            : (charSlot.worldBookIds || []).map(id => allWorldBooks.find(w => w.id === id)).filter(Boolean) as typeof allWorldBooks;
        const { wbActivationContext } = prepareShortTermContext(charId, "group_chat", {
            userName,
            excludeGroupSessionId: isOfflineMode ? undefined : session.id,
            excludeOfflineSessionId: options?.excludeOfflineSessionId,
            promptTimestampOptions: getPromptTimestampOptionsForTimeContext(memberTimeContext),
        });
        let coreMemories = "", longTermMemories = "";
        try {
            const [coreResults, results] = await Promise.all([
                retrieveCoreMemoriesForPrompt(charId, memConfig),
                retrieveMemoriesForPrompt(charId, wbActivationContext, memConfig),
            ]);
            coreMemories = formatCoreMemories(coreResults);
            longTermMemories = formatLongTermMemories(results);
        } catch { /* ignore */ }
        return {
            character,
            worldBooks,
            scheduleSummary,
            currentSchedule,
            coreMemories,
            longTermMemories,
            currentStateValues: getLatestCharacterStateValues(charId),
        };
    });

    const memberResults = await Promise.all(memberDataPromises);
    const members = memberResults.filter(Boolean) as GroupMemberData[];
    if (members.length === 0) throw new ChatEngineError("No valid group members found.");

    const nameToId = new Map<string, string>();
    const memberNames: string[] = [];
    for (const m of members) { nameToId.set(m.character.name, m.character.id); memberNames.push(m.character.name); }
    const groupTimeContext = buildGroupTimeContext(
        members.map(m => ({ name: m.character.name, timeZone: m.character.timeZone })),
        now,
    );
    const groupPromptTimestampOptions = getPromptTimestampOptionsForTimeContext(groupTimeContext);

    const enabledTools = options?.disableTools ? [] : getEnabledTools("group_chat");
    const usesNativeActions = Boolean(nativeToolProtocolForConfig(config) && enabledTools.length > 0);
    const annotatedHistory = annotateGroupHistory(history, participantIds, userName);
    const {
        truncatedHistory: truncatedAnnotatedHistory,
        wbActivationContext,
        unifiedRecentItems,
    } = prepareGroupShortTermContext(participantIds, annotatedHistory, {
        userName,
        excludeGroupSessionId: isOfflineMode ? undefined : session.id,
        excludeOfflineSessionId: options?.excludeOfflineSessionId,
        includeNativeToolHistory: usesNativeActions,
        promptTimestampOptions: groupPromptTimestampOptions,
    });
    const promptHistory = applyVisionImagePromptLimit(
        truncatedAnnotatedHistory.map(msg => ({ ...msg })),
        session.visionImagePromptLimit,
    );
    if (config.enableImageRecognition) {
        for (const msg of promptHistory) {
            await prepareVisionPromptImageMessage(msg);
        }
    }

    const stickerRows = members.map(m => {
        const names = loadCustomStickers(m.character.id).map(sticker => sticker.name).filter(Boolean);
        return `${m.character.name}：${names.length > 0 ? names.join("，") : "无"}`;
    });
    const hasAnySticker = stickerRows.some(row => !row.endsWith("：无"));
    const allStickerNames = hasAnySticker
        ? `每个角色只能使用自己名下的表情包：\n${stickerRows.join("\n")}`
        : "无可用表情包，该功能不可用";
    const firstExample = members.map(m => getCustomStickerExample(m.character.id)).find(Boolean) || "";
    const [musicLocal, musicCloud] = await Promise.all([buildMusicLocalMacro(), buildMusicCloudMacro()]);
    const activeMemberSchedules = members
        .map(m => ({ name: m.character.name, schedule: m.currentSchedule?.trim() || "" }))
        .filter(item => item.schedule && item.schedule !== "无");
    const currentSchedule = activeMemberSchedules.length > 0
        ? activeMemberSchedules.map(item => `${item.name}：${item.schedule}`).join("；")
        : "无";
    const musicOnlineHint = isNeteaseConfigured() ? "- 你可以推荐任何歌曲，系统会在线搜索并播放。不局限于用户本地音乐库。\n" : "\n";
    const pluginPrompt = await runChatPluginTransform("prompt.system", {
        sessionId: session.id,
        isGroup: true,
        hint: buildChatPluginPromptFragments(session.id),
    });
    const pluginPromptHint = pluginPrompt.hint?.trim() ? `\n\n### 扩展插件\n${pluginPrompt.hint.trim()}\n` : "";
    const customAppRichMediaDirectives = formatCustomAppChatDirectivesForPrompt({ group: true }) + buildScreenEffectPromptHint() + pluginPromptHint;
    const toolsPrompt = usesNativeActions
        ? "需要动作时使用可用动作接口。"
        : formatToolsForPrompt(enabledTools);
    const groupToolsPrompt = usesNativeActions
        ? `需要动作时使用可用动作接口，并填写执行成员 actorName。可选成员：${memberNames.join("、")}`
        : formatGroupToolsForPrompt(enabledTools);
    // 状态区（自定义状态栏）：群聊与单聊同一套配置，按会话存；群聊变体的 native 原文
    // 与单聊不同，custom 挡还会补一条"每个发言角色各出一份"的群规则。
    const statusRegionCfg = getStatusRegionConfig(session.id);
    const chatBilingualInstruction = buildChatBilingualInstruction(
        session.bilingualTranslationEnabled !== false,
        "group",
        session.bilingualTranslationPrompt,
    );
    const offlineBilingualInstruction = buildOfflineBilingualInstruction(
        session.bilingualTranslationEnabled !== false,
        "group",
        session.offlineBilingualTranslationPrompt,
    );
    const groupRoster = buildGroupRosterMacro(
        session,
        members.map(m => ({ id: m.character.id, name: m.character.name })),
        userName,
    );

    const llmMessages = assembleGroupPromptPayload({
        members,
        history: promptHistory,
        preset,
        regexes,
        appTags: activeAppTags,
        userIdentity,
        userName,
        groupName: session.groupName,
        memberNames: memberNames.join("、"),
        worldBookActivationContext: wbActivationContext,
        unifiedRecentItems,
        customStickerNames: allStickerNames,
        customStickerExample: firstExample,
        musicLocal,
        musicCloud,
        currentSchedule,
        musicOnlineHint,
        timeContext: groupTimeContext,
        memberTimeContexts,
        promptTimestampOptions: groupPromptTimestampOptions,
        enableVision: config.enableImageRecognition,
        timeAware: loadChatAppSettings().timeAware,
        tools: toolsPrompt,
        groupTools: groupToolsPrompt,
        groupRoster,
        customAppRichMediaDirectives,
        chatBilingualInstruction,
        statusRegionSection: resolveStatusRegionSection(statusRegionCfg, "group"),
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
            content: "本次自定义 APP AI 任务只输出纯文本结果。每个角色的发言以 [角色名]: 开头，除此之外不要输出聊天富媒体指令、状态面板、内心想法、XML 包裹或 Markdown 代码块。",
        });
    } else if (promptProfile?.output === "json") {
        llmMessages.push({
            role: "system",
            content: "本次自定义 APP AI 任务只输出严格 JSON。不要输出 Markdown 代码块、解释文字或聊天富媒体指令。",
        });
    }
    appendEmptyGenerateGuardMessage(llmMessages, config, history);

    return { llmMessages, config, preset, regexes, nameToId, memberNames, enabledTools, userName, appTags: activeAppTags };
}

function nativeGroupToolCallToTextCall(call: LlmToolCall, bundle: NativeChatToolBundle): ToolCall {
    const actorName = typeof call.args.actorName === "string" ? call.args.actorName.trim() : "";
    const rawArgs = call.args.args;
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? rawArgs as Record<string, unknown>
        : {};
    return {
        name: bundle.nameMap.get(call.name) || call.name,
        args,
        actor: actorName,
    };
}

function getNativeGroupActorName(call: LlmToolCall): string {
    return typeof call.args.actorName === "string" ? call.args.actorName.trim() : "";
}

async function appendNativeMediaContext(
    requestMessages: LlmRequestMessage[],
    results: Awaited<ReturnType<typeof executeToolCalls>>,
    enableVision: boolean | undefined,
    signal?: AbortSignal,
): Promise<void> {
    throwIfAborted(signal);
    if (!enableVision) return;
    for (const result of results) {
        for (const att of result.mediaAttachments || []) {
            throwIfAborted(signal);
            if (att.type !== "image" || !att.url) continue;
            const dataUrl = await resolveCompressedImageDataUrl(att.url);
            throwIfAborted(signal);
            if (!dataUrl) continue;
            if (!dataUrl.startsWith("data:image/")) continue;
            requestMessages.push({
                role: "user",
                content: [
                    { type: "text", text: "系统记录：这是你刚才生成的图片。" },
                    { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
                ],
            });
        }
    }
}

async function runNativeGroupToolLoop(params: {
    session: ChatSession;
    llmMessages: LLMMessage[];
    config: ApiConfig;
    preset: PresetConfig | null;
    regexes: RegexConfig[];
    nameToId: Map<string, string>;
    memberNames: string[];
    enabledTools: ReturnType<typeof getEnabledTools>;
    userName: string;
    appTags: string[];
    signal?: AbortSignal;
    callbacks?: ChatCompletionCallbacks;
}): Promise<string> {
    const { session, llmMessages, config, preset, regexes, nameToId, memberNames, enabledTools, appTags, signal, callbacks } = params;
    const MAX_TOOL_ROUNDS = 5;
    const onlineThinkingEnabled = preset?.online_thinking_enabled === true;
    const onlineThinkingTag = preset?.online_thinking_tag?.trim() || "thinking";
    const persistedSession = loadChatSessions().find(item => item.id === session.id);
    let expandedSourceIds = normalizeNativeExpandedToolSourceIds(
        persistedSession?.nativeExpandedToolSourceIds || session.nativeExpandedToolSourceIds,
        enabledTools,
    );
    const nativeToolBuildOptions = {
        actorNames: memberNames,
        characterName: `群聊:${session.groupName || "群聊"}`,
        userName: params.userName,
    };
    let nativeBundle = buildNativeChatTools(enabledTools, expandedSourceIds, nativeToolBuildOptions);
    const requestMessages: LlmRequestMessage[] = toLlmRequestMessages(llmMessages);
    const meta = { characterName: `群聊:${session.groupName || "群聊"}`, userName: params.userName };
    const expandableSourceKeys = new Set(enabledTools.filter(tool => !isNativeSingleTool(tool)).map(nativeToolSourceKey));
    let finalRawOutput = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        let result: Awaited<ReturnType<typeof sendLLMToolRequest>>;
        try {
            if (isSessionStreamingEnabled(session, true)) {
                let streamReasoning = "";
                result = await sendLLMToolStreamRequest(config, preset, requestMessages, nativeBundle.definitions, regexes, meta, {
                    appId: "group_chat",
                    appTags,
                    debugSessionId: session.id,
                    signal,
                }, {
                    onDelta: (text) => callbacks?.onStreamDelta?.(text),
                    // 流式下 onReasoningDelta 是单段增量：累积后再喂 onReasoning（保持整段请求语义）
                    // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                    onReasoningDelta: onlineThinkingEnabled ? undefined : (text) => { streamReasoning += text; callbacks?.onReasoning?.(streamReasoning); },
                });
            } else {
                result = await sendLLMToolRequest(config, preset, requestMessages, nativeBundle.definitions, regexes, meta, {
                    appId: "group_chat",
                    appTags,
                    debugSessionId: session.id,
                    signal,
                });
            }
        } catch (err) {
            if (finalRawOutput) {
                throwIfAborted(signal);
                callbacks?.onToolNotice?.(`⚠️ 回复生成失败: ${err instanceof Error ? err.message : String(err)}`);
                break;
            }
            throw err;
        }
        throwIfAborted(signal);

        // 线上思维链标签解析：开启时每轮从正文提取 <tag> 思维链（覆盖原生），并剥离标签后再做后续解析
        let displayContent = result.content;
        if (onlineThinkingEnabled) {
            const tagThinking = extractThinkingTag(displayContent, onlineThinkingTag);
            if (tagThinking) callbacks?.onReasoning?.(tagThinking);
            displayContent = stripOnlineThinkingTag(displayContent, onlineThinkingTag);
        }
        // 剔除预设配置的文本片段（<思考结束> 等残留标签）
        displayContent = stripPresetTexts(displayContent, preset);
        const assistantForToolContext = stripStateAndInnerForPrompt(displayContent);
        if (result.toolCalls.length === 0) {
            throwIfAborted(signal);
            // 无工具调用的最终轮：把解析到的思维链交给回调（随后由 processGroupParts 挂到本轮首条气泡）
            // 标签解析开启时已用标签思维链覆盖，此处不再重复喂原生
            if (result.reasoning && !onlineThinkingEnabled) callbacks?.onReasoning?.(result.reasoning);
            finalRawOutput = displayContent;
            break;
        }

        throwIfAborted(signal);
        await callbacks?.onNativeToolAssistantTurn?.({
            content: displayContent,
            rawContent: displayContent,
            reasoning: onlineThinkingEnabled ? (extractThinkingTag(result.content, onlineThinkingTag) || undefined) : result.reasoning,
            openRouterReasoningDetails: onlineThinkingEnabled ? undefined : result.openRouterReasoningDetails,
            toolCalls: result.toolCalls,
        });

        const loaderCalls = result.toolCalls
            .map(call => ({ call, loader: nativeBundle.loaderMap.get(call.name) }))
            .filter((item): item is { call: LlmToolCall; loader: { sourceKey: string; label: string } } => Boolean(item.loader));
        const realNativeCalls = result.toolCalls.filter(call => !nativeBundle.loaderMap.has(call.name));
        const textCalls = realNativeCalls.map(call => nativeGroupToolCallToTextCall(call, nativeBundle));
        const actorNames = [...new Set([
            ...loaderCalls.map(item => getNativeGroupActorName(item.call)),
            ...textCalls.map(call => call.actor),
        ].map(name => name?.trim()).filter(Boolean))].join("、") || "未标注角色";
        const displayedActionNames = [
            ...loaderCalls.map(item => `展开「${item.loader.label}」动作说明`),
            ...realNativeCalls.map(call => nativeBundle.displayNameMap.get(call.name) || nativeBundle.nameMap.get(call.name) || call.name),
        ];
        if (displayedActionNames.length > 0) callbacks?.onToolNotice?.(`${actorNames}正在${displayedActionNames.join("、")}...`);

        let realResults: Awaited<ReturnType<typeof executeToolCalls>> = [];
        try {
            realResults = await Promise.all(textCalls.map(async (call) => {
                throwIfAborted(signal);
                const actor = resolveGroupToolActor(call.actor, nameToId);
                if ("error" in actor) {
                    return { name: call.name, success: false, error: actor.error, actorName: actor.actorName };
                }
                const [toolResult] = await executeToolCalls([call], {
                    appId: "group_chat",
                    sessionId: session.id,
                    characterId: actor.characterId,
                    sourceEngine: "group_chat",
                    signal,
                });
                throwIfAborted(signal);
                return attachGroupToolActor(toolResult!, actor);
            }));
        } catch (err) {
            throwIfAborted(signal);
            callbacks?.onToolNotice?.(`⚠️ 动作执行失败: ${err instanceof Error ? err.message : String(err)}`);
            break;
        }

        const outcomes: Array<{
            nativeCall: LlmToolCall;
            result: Awaited<ReturnType<typeof executeToolCalls>>[number];
            formattedContent: string;
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
        throwIfAborted(signal);
        if (notices) callbacks?.onToolNotice?.(notices);

        throwIfAborted(signal);
        requestMessages.push({
            role: "assistant",
            content: assistantForToolContext,
            reasoning: onlineThinkingEnabled ? (extractThinkingTag(result.content, onlineThinkingTag) || undefined) : result.reasoning,
            openRouterReasoningDetails: onlineThinkingEnabled ? undefined : result.openRouterReasoningDetails,
            toolCalls: result.toolCalls,
        });
        const toolExecutionId = createToolExecutionId();
        for (const outcome of outcomes) {
            throwIfAborted(signal);
            callbacks?.onNativeToolResult?.({
                toolCallId: outcome.nativeCall.id,
                name: outcome.nativeCall.name,
                content: outcome.formattedContent,
                toolExecutionId,
            });
            requestMessages.push({
                role: "tool",
                name: outcome.nativeCall.name,
                toolCallId: outcome.nativeCall.id,
                content: outcome.formattedContent,
            });
        }

        const resultsForHistory = realResults.filter(result => result.persistToHistory !== false);
        const toolResultContent = resultsForHistory.length > 0 ? formatToolResults(resultsForHistory) : "";
        throwIfAborted(signal);
        if (realResults.length > 0) {
            callbacks?.onToolExecution?.(realResults, toolResultContent || undefined, { toolExecutionId });
        }

        await appendNativeMediaContext(requestMessages, realResults, config.enableImageRecognition, signal);

        if (outcomes.filter(item => item.result.continueConversation !== false).length === 0) {
            break;
        }
    }

    return finalRawOutput;
}

/**
 * Single API call group chat generation.
 * All characters' data is assembled into one prompt, AI responds as all characters.
 */
export async function generateGroupChatCompletion(
    session: ChatSession,
    history: ChatMessage[],
    callbacks?: ChatCompletionCallbacks,
    options?: GroupChatPromptBuildOptions & { signal?: AbortSignal; skipMemorySummarization?: boolean },
): Promise<{ characterId: string; characterName: string; responseText: string }[]> {
    const { llmMessages, config, preset, regexes, nameToId, memberNames, enabledTools, userName, appTags } = await buildGroupChatPromptMessages(session, history, {
        appTags: options?.appTags,
        disableTools: options?.disableTools,
        promptProfile: options?.promptProfile,
        apiConfigId: options?.apiConfigId,
    });
    const chars = loadCharacters();
    const participantIds = session.participantIds || [];

    const MAX_TOOL_ROUNDS = 5;
    const meta = { characterName: `群聊:${session.groupName || "群聊"}` };
    let finalRawOutput = "";
    // 线上思维链标签解析：预设开启时从正文提取 <tag> 思维链（覆盖原生），并剥离标签后再做后续解析
    const onlineThinkingEnabled = preset?.online_thinking_enabled === true;
    const onlineThinkingTag = preset?.online_thinking_tag?.trim() || "thinking";

    if (nativeToolProtocolForConfig(config) && enabledTools.length > 0) {
        finalRawOutput = await runNativeGroupToolLoop({
            session,
            llmMessages,
            config,
            preset,
            regexes,
            nameToId,
            memberNames,
            enabledTools,
            userName,
            appTags,
            signal: options?.signal,
            callbacks,
        });
    } else {

    const findInsertIdx = () => {
        for (let i = llmMessages.length - 1; i >= 0; i--) {
            if (llmMessages[i]._debugMeta?._fromHistory) return i + 1;
        }
        return llmMessages.length;
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let filteredOutput: string;
        try {
            if (isSessionStreamingEnabled(session, true)) {
                let streamReasoning = "";
                const streamResult = await sendLLMStreamRequest(config, preset, llmMessages, regexes, meta, {
                    appId: "group_chat",
                    appTags,
                    debugSessionId: session.id,
                    signal: options?.signal,
                }, {
                    onDelta: (text) => callbacks?.onStreamDelta?.(text),
                    // 流式下 onReasoningDelta 是单段增量：累积后再喂 onReasoning（保持整段请求语义）
                    // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                    onReasoningDelta: onlineThinkingEnabled ? undefined : (text) => { streamReasoning += text; callbacks?.onReasoning?.(streamReasoning); },
                });
                filteredOutput = streamResult.content;
            } else {
                filteredOutput = await sendLLMRequest(config, preset, llmMessages, regexes, meta, {
                    appId: "group_chat",
                    appTags,
                    debugSessionId: session.id,
                    signal: options?.signal,
                    // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                    onReasoning: onlineThinkingEnabled ? undefined : callbacks?.onReasoning,
                });
            }
        } catch (err) {
            if (finalRawOutput) {
                throwIfAborted(options?.signal);
                callbacks?.onToolNotice?.(`⚠️ 回复生成失败: ${err instanceof Error ? err.message : String(err)}`);
                break;
            }
            throw err;
        }
        throwIfAborted(options?.signal);

        // 线上思维链标签解析：开启时每轮从正文提取 <tag> 思维链（覆盖原生），并剥离标签后再做后续解析
        if (onlineThinkingEnabled) {
            const tagThinking = extractThinkingTag(filteredOutput, onlineThinkingTag);
            if (tagThinking) callbacks?.onReasoning?.(tagThinking);
            filteredOutput = stripOnlineThinkingTag(filteredOutput, onlineThinkingTag);
        }
        // 剔除预设配置的文本片段（<思考结束> 等残留标签），不进入消息/提示词
        filteredOutput = stripPresetTexts(filteredOutput, preset);

        const toolFetches = parseToolFetches(filteredOutput);
        const { toolCalls } = parseToolCalls(filteredOutput);
        const assistantForToolContext = stripStateAndInnerForPrompt(filteredOutput);

        if (toolFetches.length === 0 && toolCalls.length === 0) {
            throwIfAborted(options?.signal);
            finalRawOutput = filteredOutput;
            break;
        }

        // Push text to UI immediately before tool execution (parse per-character for proper avatar/name)
        if (callbacks?.onTextPart) {
            throwIfAborted(options?.signal);
            const intermediateResults = parseGroupChatResponse(filteredOutput, nameToId);
            const responseRoundId = createResponseRoundId();
            const editableResponseText = buildEditableGroupRoundText(intermediateResults);
            for (const r of intermediateResults) {
                throwIfAborted(options?.signal);
                if (r.responseText.trim()) {
                    const responseBatchId = createResponseBatchId();
                    await callbacks.onTextPart(r.responseText, {
                        characterId: r.characterId,
                        characterName: r.characterName,
                        responseRoundId,
                        editableResponseText,
                    }, {
                        responseBatchId,
                        rawResponseText: r.responseText,
                    });
                    const directiveText = extractTextToolDirectiveText(r.responseText);
                    if (directiveText) {
                        callbacks.onToolAssistantTurn?.(directiveText, {
                            responseBatchId,
                            responseRoundId,
                            senderCharacterId: r.characterId,
                            senderName: r.characterName,
                        });
                    }
                }
            }
        }

        // Handle [获取指令:xxx]
        if (toolFetches.length > 0) {
            for (const fetch of toolFetches) {
                throwIfAborted(options?.signal);
                const actor = resolveGroupToolActor(fetch.actor, nameToId);
                const actorName = actor.actorName || "未标注角色";
                callbacks?.onToolNotice?.(`${actorName}正在获取「${fetch.name}」指令...`);

                let schemaContent: string;
                if ("error" in actor) {
                    schemaContent = `以下是你获取指令的返回结果：\n${actor.error}`;
                } else {
                    const tool = findEnabledToolForSchema(fetch.name, "group_chat", {
                        characterName: actorName,
                        userName,
                    });
                    schemaContent = tool
                        ? formatToolSchema(tool, {
                            characterName: actorName,
                            userName,
                        })
                        : `以下是你获取指令的返回结果：\n动作类别「${fetch.name}」未找到。`;
                }

                throwIfAborted(options?.signal);
                callbacks?.onToolResult?.(schemaContent);
                const idx = findInsertIdx();
                llmMessages.splice(idx, 0,
                    { role: "assistant", content: assistantForToolContext, _debugMeta: { _fromHistory: true } },
                    { role: "user", content: schemaContent, _debugMeta: { _fromHistory: true } },
                );
            }
            continue;
        }

        // Handle [执行动作:xxx({...})]
        if (toolCalls.length > 0) {
            const actorNames = [...new Set(toolCalls.map(t => t.actor?.trim()).filter(Boolean))].join("、") || "未标注角色";
            callbacks?.onToolNotice?.(`${actorNames}正在${toolCalls.map(t => t.name).join("、")}...`);

            let results: Awaited<ReturnType<typeof executeToolCalls>>;
            try {
                results = await Promise.all(toolCalls.map(async (call) => {
                    throwIfAborted(options?.signal);
                    const actor = resolveGroupToolActor(call.actor, nameToId);
                    if ("error" in actor) {
                        return { name: call.name, success: false, error: actor.error, actorName: actor.actorName };
                    }
                    const [result] = await executeToolCalls([call], {
                        appId: "group_chat",
                        sessionId: session.id,
                        characterId: actor.characterId,
                        sourceEngine: "group_chat",
                        signal: options?.signal,
                    });
                    throwIfAborted(options?.signal);
                    return attachGroupToolActor(result!, actor);
                }));
                throwIfAborted(options?.signal);
                const notices = results.map(r => r.userNotice || (r.success ? `✓ ${r.name} 执行成功` : `✗ ${r.name}: ${r.error}`)).join("；");
                callbacks?.onToolNotice?.(notices);
            } catch (err) {
                throwIfAborted(options?.signal);
                callbacks?.onToolNotice?.(`⚠️ 动作执行失败: ${err instanceof Error ? err.message : String(err)}`);
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
                llmMessages.splice(idx, 0,
                    { role: "assistant", content: assistantForToolContext, _debugMeta: { _fromHistory: true } },
                    { role: "user", content: toolResultContent, _debugMeta: { _fromHistory: true } },
                );
            }

            if (resultsForContinuation.length === 0) {
                break;
            }

            if (round === MAX_TOOL_ROUNDS - 1) {
                try {
                    if (isSessionStreamingEnabled(session, true)) {
                        let streamReasoning = "";
                        const streamFinal = await sendLLMStreamRequest(config, preset, llmMessages, regexes, meta, {
                            appId: "group_chat",
                            appTags,
                            debugSessionId: session.id,
                            signal: options?.signal,
                        }, {
                            onDelta: (text) => callbacks?.onStreamDelta?.(text),
                            // 流式下 onReasoningDelta 是单段增量：累积后再喂 onReasoning（保持整段请求语义）
                            // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                            onReasoningDelta: onlineThinkingEnabled ? undefined : (text) => { streamReasoning += text; callbacks?.onReasoning?.(streamReasoning); },
                        });
                        finalRawOutput = streamFinal.content;
                    } else {
                        finalRawOutput = await sendLLMRequest(config, preset, llmMessages, regexes, meta, {
                            appId: "group_chat",
                            appTags,
                            debugSessionId: session.id,
                            signal: options?.signal,
                            // 预设开启「线上标签解析」时不透传原生思维链（改由下方标签提取）
                            onReasoning: onlineThinkingEnabled ? undefined : callbacks?.onReasoning,
                        });
                    }
                    throwIfAborted(options?.signal);
                    // 线上思维链标签解析：开启时从正文提取 <tag> 思维链并剥离标签
                    if (onlineThinkingEnabled) {
                        const tagThinking = extractThinkingTag(finalRawOutput, onlineThinkingTag);
                        if (tagThinking) callbacks?.onReasoning?.(tagThinking);
                        finalRawOutput = stripOnlineThinkingTag(finalRawOutput, onlineThinkingTag);
                    }
                    // 剔除预设配置的文本片段（<思考结束> 等残留标签）
                    finalRawOutput = stripPresetTexts(finalRawOutput, preset);
                } catch {
                    throwIfAborted(options?.signal);
                    /* use last output */
                }
            }
        }
    }
    }

    // Parse final output into per-character results
    throwIfAborted(options?.signal);
    const parsed = parseGroupChatResponse(finalRawOutput, nameToId);

    const finalResults: typeof parsed = [];
    for (const r of parsed) {
        const { cleanText, actions } = parseActionTags(r.responseText);
        if (actions.length > 0) {
            throwIfAborted(options?.signal);
            dispatchActions(actions, {
                characterId: r.characterId,
                sessionId: session.id,
                sourceEngine: "group_chat",
                signal: options?.signal,
            }).catch(err => console.warn("[GroupChat] Action dispatch failed:", err));
        }
        if (cleanText.trim()) {
            finalResults.push({ ...r, responseText: cleanText });
        }
    }

    if (!options?.skipMemorySummarization) {
        scheduleGroupMemorySummarization(participantIds, chars, history, finalResults.length);
    }

    return finalResults;
}

/**
 * 自定义 APP 的多角色"通用条目"补全：共用群聊的多人资料包组装（<member> 人设块、
 * 用户身份、记忆等结构化内容），但内容条目只按调用方给的 appTags 命中——不强塞
 * "text"/"offline" 等宿主内置场景 tag，APP 拿不到内置 APP 的格式条目。
 * 输出格式由 APP 自己的预设条目约定，返回原始文本，不经过群聊线上解析器
 * （parseGroupChatResponse）与动作标签剥离，由 APP 自行解析。
 */
export async function generateGroupRawCompletion(
    session: ChatSession,
    history: ChatMessage[],
    options?: GroupChatPromptBuildOptions & { signal?: AbortSignal; appId?: string },
): Promise<{ text: string; model: string; presetName: string }> {
    const { llmMessages, config, preset, regexes } = await buildGroupChatPromptMessages(
        session,
        history,
        {
            appTags: options?.appTags ?? [],
            disableTools: true,
            promptProfile: options?.promptProfile,
            apiConfigId: options?.apiConfigId,
        },
    );
    const rawOutput = await sendLLMRequest(config, preset, llmMessages, regexes, {
        characterName: `群聊:${session.groupName || "群聊"}`,
    }, {
        appId: options?.appId ?? "group_chat",
        appTags: options?.appTags ?? [],
        debugSessionId: session.id,
        signal: options?.signal,
    });
    return {
        text: rawOutput,
        model: config.defaultModel,
        presetName: preset?.name || "默认预设",
    };
}

export type GroupOfflineChatCompletionResult = ParsedOfflineResponse & {
    /** 模型思维链（reasoning）内容，供线下记录展示 */
    reasoning?: string;
    model: string;
    presetName: string;
};

export async function generateGroupOfflineChatCompletion(
    session: ChatSession,
    history: ChatMessage[],
    options?: { signal?: AbortSignal; onStreamDelta?: (delta: string) => void },
): Promise<GroupOfflineChatCompletionResult> {
    const { llmMessages, config, preset, regexes } = await buildGroupChatPromptMessages(
        session,
        history,
        {
            appTags: ["group_chat", "offline"],
            excludeOfflineSessionId: session.id,
            disableTools: true,
        },
    );
    const summaryTag = preset?.story_summary_tag?.trim() || "summary";
    const thinkingTag = preset?.thinking_tag?.trim() || "thinking";
    const offlineTagEnabled = preset?.offline_thinking_enabled === true;
    let reasoning = "";
    const meta = { characterName: `群聊:${session.groupName || "群聊"}` };
    const requestOptions = {
        appId: "group_chat",
        appTags: ["group_chat", "offline"],
        debugSessionId: session.id,
        signal: options?.signal,
        onReasoning: (t: string) => { reasoning = t; },
    };
    let rawOutput: string;
    if (isSessionStreamingEnabled(session, false) && options?.onStreamDelta) {
        const streamResult = await sendLLMStreamRequest(config, preset, llmMessages, regexes, meta, {
            appId: "group_chat",
            appTags: ["group_chat", "offline"],
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

/**
 * Preview-only: assembles the full group prompt payload without sending an API request.
 */
export async function previewGroupPromptPayload(
    session: ChatSession,
    history: ChatMessage[],
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    // Use the SAME shared builder as generateGroupChatCompletion
    const { llmMessages, config, preset } = await buildGroupChatPromptMessages(session, history);

    const apiMessages = previewMessagesForApi(config, preset, llmMessages);

    return {
        messages: apiMessages,
        characterName: `群聊:${session.groupName || "群聊"}`,
        model: config.defaultModel,
        presetName: preset?.name ?? "(无预设)",
    };
}

export async function previewGroupPromptRequestSnapshot(
    session: ChatSession,
    history: ChatMessage[],
    options?: GroupChatPromptBuildOptions,
): Promise<DebugPromptSnapshot> {
    const { llmMessages, config, preset, memberNames, enabledTools, userName, appTags } = await buildGroupChatPromptMessages(session, history, { ...options });
    const requestMessages = toLlmRequestMessages(llmMessages);
    const meta = { characterName: `群聊:${session.groupName || "群聊"}`, userName };

    if (nativeToolProtocolForConfig(config) && enabledTools.length > 0) {
        const persistedSession = loadChatSessions().find(item => item.id === session.id);
        const expandedSourceIds = normalizeNativeExpandedToolSourceIds(
            persistedSession?.nativeExpandedToolSourceIds || session.nativeExpandedToolSourceIds,
            enabledTools,
        );
        const nativeBundle = buildNativeChatTools(enabledTools, expandedSourceIds, {
            actorNames: memberNames,
            characterName: `群聊:${session.groupName || "群聊"}`,
            userName,
        });
        const request = buildProviderRequest(config, preset, requestMessages, { tools: nativeBundle.definitions });
        return publishDebugPromptSnapshot({
            request,
            config,
            preset,
            meta,
            options: {
                appId: "group_chat",
                appTags,
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
            appId: "group_chat",
            appTags,
            debugSessionId: session.id,
        },
        requestKind: "completion",
    });
}
