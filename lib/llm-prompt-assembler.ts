// lib/llm-prompt-assembler.ts

import { Character } from "./character-types";
import { ChatMessage } from "./chat-storage";
import type { StateValue } from "./chat-storage";
import { PresetConfig, Prompt, PromptOrderEntry, WorldBookConfig, RegexConfig, WorldBookEntry } from "./settings-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import { MacroEngine, postProcessTrim } from "./macro-engine";
import type { RecentBlock, UnifiedRecentItem } from "./short-term-assembler";
import { readDwellingLayoutCache } from "./dwelling-storage";
import { formatDwellingContext } from "./dwelling-engine";
import { matchesActiveTags } from "./content-tag-utils";
import { formatXiaohongshuShareForPrompt } from "./chat-share";
import { stripStateAndInnerForPrompt } from "./prompt-sanitizer";
import { formatPromptTimestamp, getPromptTimestampOptionsForTimeContext, resolvePromptTimeAware, type PromptTimestampOptions } from "./prompt-time";
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
import { buildCharacterTimeContext, buildGroupTimeContext, type CharacterTimeContext } from "./character-time";
import { formatShoppingPaymentRequestHistory } from "./shopping-payment-request";
import { buildGroupAdminBracketText } from "./group-admin";

export type LLMMessageRole = "system" | "user" | "assistant" | "tool";
export type LLMToolCallPayload = { id: string; name: string; args: Record<string, unknown>; thoughtSignature?: string };

export type LLMContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type LLMMessage = {
    role: LLMMessageRole;
    content: string | LLMContentPart[];
    reasoning?: string;
    openRouterReasoningDetails?: unknown[];
    toolCalls?: LLMToolCallPayload[];
    toolCallId?: string;
    name?: string;
    _debugMeta?: {
        marker?: string;
        depth?: number;
        order?: number;
        _fromHistory?: boolean;
    };
};

export interface AssemblerInput {
    character: Character;
    history: ChatMessage[];
    preset: PresetConfig | null;
    worldBooks: WorldBookConfig[];
    regexes: RegexConfig[];
    userIdentity?: UserIdentity | null;
    userName?: string;
    appId?: string;
    /** Multi-tag filtering: entry is included only when ALL its tags ⊆ appTags. Overrides appId for tag matching. */
    appTags?: string[];
    featureFilterEnabled?: boolean;
    nativeToolHistory?: boolean;
    initialStateValues?: StateValue[];
    followUpCount?: number;
    followUpDelay?: number;
    timedWakeElapsedMinutes?: number;
    timedWakeIntent?: string;
    periodCareContext?: string;
    scheduleSummary?: string;
    currentSchedule?: string;
    longTermMemories?: string;
    coreMemories?: string;
    worldBookActivationContext?: string;  // override history-based keyword activation context
    activateAllWorldBooks?: boolean;      // true = skip keyword matching, activate all non-disabled entries
    recentBlocks?: RecentBlock[];          // per-feature recent data blocks; last block wraps history
    unifiedRecentItems?: UnifiedRecentItem[]; // chronological short-term timeline mixing events and surviving history
    customStickerNames?: string;           // comma-separated custom sticker names for {{customStickers}} macro
    customStickerExample?: string;         // e.g. [表情包:小猫疑惑] for {{stickerExample}} macro
    musicLocal?: string;                   // local music titles for {{musicLocal}} macro
    musicCloud?: string;                   // netease playlist summary for {{musicCloud}} macro
    musicOnlineHint?: string;              // online search hint for {{musicOnlineHint}} macro
    timeContext?: CharacterTimeContext;     // precomputed system/character local time context
    promptTimestampOptions?: PromptTimestampOptions; // chat-history timestamp display options
    timeAware?: boolean;                   // when true, inject timestamps into chat history
    enableVision?: boolean;                // when true, image/sticker messages can send actual image data to LLM
    vnScenes?: string;                     // comma-separated VN scene names for {{vnScenes}} macro
    vnSprites?: string;                    // comma-separated VN sprite keys for {{vnSprites}} macro
    vnBeats?: string;                      // formatted beats outline for {{vnBeats}} macro
    vnCurrentBeat?: string;                // current beat title+description for {{vnCurrentBeat}} macro
    affinity?: string;                     // character's affinity toward user (0-100) for {{affinity}} macro
    tools?: string;                          // formatted tool definitions for {{tools}} macro
    cocreateWriteActions?: string;           // full co-create action set for {{cocreateWriteActions}} macro (write mode)
    cocreateReadActions?: string;            // read-only co-create action set for {{cocreateReadActions}} macro (discuss mode)
    groupTools?: string;                     // formatted tool definitions for {{groupTools}} macro (group chat)
    customAppRichMediaDirectives?: string;   // formatted custom app rich-media directives
    chatBilingualInstruction?: string;       // session-specific bilingual output rule for {{chatBilingualInstruction}}
    offlineBilingualInstruction?: string;    // offline-mode bilingual output rule for {{offlineBilingualInstruction}}
    offlineSummaryTag?: string;              // XML tag used for offline-mode summary output
    checkPhoneBilingualInstruction?: string; // checkphone bilingual output rule for {{checkPhoneBilingualInstruction}}
    xiaohongshuBilingualInstruction?: string; // independent Xiaohongshu bilingual output rule for {{xiaohongshuBilingualInstruction}}
    phoneAppId?: string;
    phoneAppLabel?: string;
    phoneSnapshotSummary?: string;
    phoneLastRefreshAt?: string;
    characterRelations?: string;          // formatted world-group relationship marker
    dwellingContext?: string;               // formatted dwelling layout snapshot for cross-app reference
    dwellingRoom?: string;
    dwellingFurniture?: string;
    dwellingItem?: string;
    dwellingItemPreview?: string;
    bookTitle?: string;
    chapterTitle?: string;
    chapterContent?: string;
    annotationHistory?: string;
    noteWallContext?: string;
    diaryEntryContext?: string;
    xiaohongshuFeedContext?: string;
    xiaohongshuUserPostContext?: string;
    xiaohongshuCommentContext?: string;
    xiaohongshuMentionContext?: string;
    interviewTheme?: string;
    interviewHostName?: string;
    interviewGuests?: string;
    interviewGuestCount?: string;
    interviewCurrentGuest?: string;
    interviewOtherGuests?: string;
    interviewQuestion?: string;
    interviewTranscript?: string;
    interviewPhase?: string;
    interviewRound?: string;
    interviewUserAnswer?: string;
    interviewCharacterAnswerHistory?: string;
    cocreateProjectContext?: string;
    cocreateCurrentMode?: string;
    cocreateCurrentChapter?: string;
    cocreateChapterIndex?: string;
    cocreateArchivedChapterContext?: string;
    cocreateWriterNotebook?: string;
}

type PromptBlock = {
    text: string;
    role: LLMMessageRole;
    depth: number;
    order: number;
    marker: string;
    fromHistory?: boolean;
    imageUrl?: string;      // vision: image URL/data URL attached to this prompt block
    reasoning?: string;
    openRouterReasoningDetails?: unknown[];
    toolCalls?: LLMToolCallPayload[];
    toolCallId?: string;
    toolName?: string;
};

function resolveHistoryPromptRole(msg: ChatMessage): Exclude<LLMMessageRole, "tool"> {
    const appHistoryRole = msg.mediaType === "app_card" ? msg.mediaData?.appHistoryRole : undefined;
    if (appHistoryRole === "system" || appHistoryRole === "assistant" || appHistoryRole === "user") {
        return appHistoryRole;
    }
    if (msg.role === "system" || msg.role === "assistant" || msg.role === "user") return msg.role;
    return "user";
}

function isImageGenerationMediaMessage(msg: ChatMessage): boolean {
    return msg.mediaType === "media_file"
        && msg.mediaData?.fileType === "image"
        && Boolean(msg.mediaData?.imageGenerationPrompt);
}

function formatPhotoDirective(msg: ChatMessage, prefix = ""): string {
    const description = msg.mediaData?.label?.trim() || "图片";
    const mode = msg.mediaData?.useReferenceImage === true ? "使用参考图" : "不使用参考图";
    return `${prefix}[照片:${mode}:${description}]`;
}

function formatImageGenerationDirective(msg: ChatMessage, prefix = ""): string {
    return formatPhotoDirective(msg, prefix);
}

function getPromptVisionImageUrl(msg: ChatMessage): string | undefined {
    if (((msg.mediaType === "image") || (msg.mediaType === "media_file" && msg.mediaData?.fileType === "image")) && msg.mediaUrl) {
        return msg.mediaUrl;
    }
    if (msg.role === "user" && msg.mediaType === "sticker") {
        const stickerUrl = msg.mediaData?.stickerUrl?.trim();
        return stickerUrl || undefined;
    }
    return undefined;
}

function formatDirectVisionBody(msg: ChatMessage, userName: string, charName: string): string {
    if (msg.mediaType === "sticker") return formatRichMediaForHistory(msg, userName, charName);
    return isImageGenerationMediaMessage(msg)
        ? formatImageGenerationDirective(msg)
        : formatPhotoDirective(msg);
}

function getAnnotatedSenderPrefix(body: string, msg: ChatMessage): string {
    const prefixMatch = body.match(/^\[.+?\]:\s*/);
    return prefixMatch ? prefixMatch[0] : (msg.senderName ? `[${msg.senderName}]: ` : "");
}

function formatAnnotatedVisionBody(msg: ChatMessage, body: string): string {
    const prefix = getAnnotatedSenderPrefix(body, msg);
    if (msg.mediaType === "sticker") {
        return `${prefix}${formatRichMediaForHistory(msg, "", "", true)}`;
    }
    return isImageGenerationMediaMessage(msg)
        ? formatImageGenerationDirective(msg, prefix)
        : prefix;
}

function formatAssistantImageHistoryText(msg: ChatMessage, body: string, showTs: boolean, ts: string): string {
    if (isImageGenerationMediaMessage(msg)) {
        const originalOutput = body.trim() || formatImageGenerationDirective(msg);
        const text = `系统记录：这是你上一轮发送给用户的图片。\n原始输出：${originalOutput}`;
        return showTs ? `${ts}\n${text}` : text;
    }
    return "系统记录：这是你上一轮发送给用户的图片，请作为历史图片参考。";
}

function getValidNativeToolCalls(msg: ChatMessage, nativeResultIds: Set<string>): LLMToolCallPayload[] {
    return (msg.nativeToolCalls || [])
        .filter(call => nativeResultIds.has(call.id))
        .map(call => ({
            id: call.id,
            name: call.name,
            args: call.args,
            ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        }));
}

function isNativeToolResultMessage(msg: ChatMessage): boolean {
    return msg.mediaType === "tool_result" && !!msg.nativeToolResult;
}

function pushNativeToolHistoryBlock(params: {
    blocks: PromptBlock[];
    msg: ChatMessage;
    nativeResultIds: Set<string>;
    includedToolCallIds: Set<string>;
    depth: number;
    order: number;
    marker: string;
    text?: string;
}): boolean {
    const { blocks, msg, nativeResultIds, includedToolCallIds, depth, order, marker } = params;
    if (msg.nativeToolResult) {
        if (!includedToolCallIds.has(msg.nativeToolResult.toolCallId)) return true;
        blocks.push({
            text: msg.nativeToolResult.content || msg.content,
            role: "tool",
            depth,
            order,
            marker,
            fromHistory: true,
            toolCallId: msg.nativeToolResult.toolCallId,
            toolName: msg.nativeToolResult.name,
        });
        return true;
    }

    const toolCalls = getValidNativeToolCalls(msg, nativeResultIds);
    if (toolCalls.length === 0) return false;
    for (const call of toolCalls) includedToolCallIds.add(call.id);
    blocks.push({
        text: params.text ?? stripStateAndInnerForPrompt(msg.content || ""),
        role: "assistant",
        depth,
        order,
        marker,
        fromHistory: true,
        reasoning: msg.nativeToolReasoning,
        openRouterReasoningDetails: msg.nativeToolOpenRouterReasoningDetails,
        toolCalls,
    });
    return true;
}

function mergeMarkerText(base?: string, next?: string): string | undefined {
    const parts = [base, next]
        .flatMap(value => (value ? value.split(" + ") : []))
        .map(part => part.trim())
        .filter(Boolean);
    if (parts.length === 0) return undefined;
    return Array.from(new Set(parts)).join(" + ");
}

function resolveTimeAware(value?: boolean): boolean {
    return resolvePromptTimeAware(value);
}

function applyTimeContextToMacroEngine(engine: MacroEngine, timeContext: CharacterTimeContext): void {
    engine.timeContext = timeContext.timeContext;
    engine.systemTimeZone = timeContext.systemTimeZone;
    engine.characterTime = timeContext.characterTime;
    engine.characterTimeZone = timeContext.characterTimeZone;
    engine.characterWeekday = timeContext.characterWeekday;
}

// ── Helper: normalize role string → LLMMessageRole ──
function normalizeRole(role: string): LLMMessageRole {
    if (role === "user" || role === "assistant" || role === "system") return role;
    return "system";
}

// ── Helper: replace {{char}}/{{user}} in character fields ──
function substituteCharUser(text: string, charName: string, userName: string): string {
    return text
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{user\}\}/gi, userName);
}

// ── Helper: build user persona text ──
export function buildUserPersonaText(userIdentity: UserIdentity | null | undefined, resolvedUserName: string): string {
    const parts: string[] = [];
    if (userIdentity) {
        parts.push(`The user's name is ${userIdentity.name}.`);
        if (userIdentity.gender && userIdentity.gender !== "保密") parts.push(`Gender: ${userIdentity.gender}`);
        if (userIdentity.age) parts.push(`Age: ${userIdentity.age}`);
        if (userIdentity.occupation) parts.push(`Occupation: ${userIdentity.occupation}`);
        if (userIdentity.bio) parts.push(`Bio: ${userIdentity.bio}`);
        if (userIdentity.customSettings) parts.push(`${userIdentity.customSettings}`);
    } else {
        parts.push(`The user's name is ${resolvedUserName}.`);
    }
    return parts.join("\n");
}

// ── Helper: determine processing order from prompt_order ──
function buildProcessingOrder(preset: PresetConfig): Prompt[] {
    if (!preset.prompt_order?.length) return preset.prompts;

    const map = new Map(preset.prompts.map(p => [p.identifier, p]));
    const ordered: Prompt[] = [];
    const seen = new Set<string>();

    for (const entry of preset.prompt_order) {
        if (seen.has(entry.identifier)) continue;
        seen.add(entry.identifier);
        const prompt = map.get(entry.identifier);
        if (prompt) {
            ordered.push(prompt);
        } else {
            // Marker entry not in prompts array — create synthetic marker
            ordered.push({
                identifier: entry.identifier,
                name: entry.identifier,
                role: "system",
                content: "",
                injection_depth: 0,
                enabled: true,
                marker: true,
            });
        }
    }

    for (const p of preset.prompts) {
        if (!seen.has(p.identifier)) {
            ordered.push(p);
            seen.add(p.identifier);
        }
    }

    return ordered;
}

// ── Helper: resolve effective tags for a prompt (new tags field > legacy featureTag + followUpOnly) ──
function getPromptTags(p: Prompt): string[] | null {
    if (p.tags && p.tags.length > 0) return p.tags;
    // Backward compat: convert legacy fields
    const legacy: string[] = [];
    if (p.featureTag) legacy.push(p.featureTag);
    if (p.followUpOnly) legacy.push("followup");
    return legacy.length > 0 ? legacy : null;
}

// ── Helper: check if prompt is enabled (prompt_order overrides prompt.enabled) ──
function isPromptEnabled(prompt: Prompt, promptOrder?: PromptOrderEntry[]): boolean {
    if (promptOrder) {
        const entry = promptOrder.find(e => e.identifier === prompt.identifier);
        if (entry) return entry.enabled;
    }
    return prompt.enabled;
}


// ── Helper: sanitize identifier into valid XML tag name ──
function toXmlTag(identifier: string): string {
    // Replace non-alphanumeric (except _ and -) with underscore, ensure starts with letter
    let tag = identifier.replace(/[^a-zA-Z0-9_\-]/g, "_");
    if (!/^[a-zA-Z]/.test(tag)) tag = "x_" + tag;
    return tag;
}

function wrapXml(tag: string, content: string): string {
    return `<${tag}>\n${content}\n</${tag}>`;
}

// ── Helper: get content for a marker entry ──
function applyWorldInfoRegex(text: string, regexGroups: RegexConfig[], ctx?: RegexContext): string {
    return applyRegex(text, regexGroups, 5, { isPrompt: true, ...ctx });
}

function getMarkerContent(
    identifier: string,
    character: Character,
    userPersonaText: string,
    wbBeforeEntries: WorldBookEntry[],
    wbAfterEntries: WorldBookEntry[],
    scheduleSummary?: string,
    coreMemories?: string,
    longTermMemories?: string,
    regexGroups?: RegexConfig[],
    regexCtx?: RegexContext,
    characterRelations?: string,
    dwellingContext?: string,
): string | null {
    switch (identifier) {
        case "charDescription":
            return `You are ${character.name}.\n${character.persona}`;
        case "charPersonality":
            return character.personality?.trim() || null;
        case "personaDescription":
            return userPersonaText;
        case "worldInfoBefore": {
            if (wbBeforeEntries.length === 0) return null;
            const sorted = [...wbBeforeEntries].sort((a, b) => (a.insertion_order ?? 50) - (b.insertion_order ?? 50));
            return sorted.map(e => regexGroups ? applyWorldInfoRegex(e.content, regexGroups, regexCtx) : e.content).join("\n\n");
        }
        case "worldInfoAfter": {
            if (wbAfterEntries.length === 0) return null;
            const sorted = [...wbAfterEntries].sort((a, b) => (a.insertion_order ?? 50) - (b.insertion_order ?? 50));
            return sorted.map(e => regexGroups ? applyWorldInfoRegex(e.content, regexGroups, regexCtx) : e.content).join("\n\n");
        }
        case "calendarSchedule":
            return scheduleSummary?.trim() || null;
        case "memoryCore":
            return coreMemories?.trim() || null;
        case "memoryLongTerm":
            return longTermMemories?.trim() || null;
        case "characterRelations": {
            const relations = characterRelations?.trim() || formatCharacterRelationsForPrompt(character.id).trim();
            return relations || null;
        }
        case "dwellingContext": {
            if (dwellingContext?.trim()) return dwellingContext;
            // Auto-load from in-memory cache if not explicitly provided
            const cached = readDwellingLayoutCache(character.id);
            return cached ? formatDwellingContext(cached.layout, cached.updatedAt) : null;
        }
        case "chatHistory":     // backward compat
        case "shortTermMemory":
            return null; // handled separately — chat history injected via depth-based blocks
        default:
            return null;
    }
}

function pushChronologicalShortTermBlocks(params: {
    blocks: PromptBlock[];
    items: UnifiedRecentItem[];
    history: ChatMessage[];
    resolvedUserName: string;
    characterName: string;
    timeAware: boolean;
    timestampOptions?: PromptTimestampOptions;
    visionEnabled: boolean;
    nativeToolHistory?: boolean;
}) {
    const {
        blocks,
        items,
        history,
        resolvedUserName,
        characterName,
        timeAware,
        timestampOptions,
        visionEnabled,
    } = params;

    const totalItems = items.length;
    const wrapperOpenDepth = totalItems + 1;
    blocks.push({
        text: "<shortTermMemory>",
        role: "system",
        depth: wrapperOpenDepth,
        order: 999,
        marker: "shortTermMemory-open",
    });

    let prevTs = "";
    let prevRole = "";
    let prevWasHistory = false;
    const nativeResultIds = new Set(history
        .map(msg => msg.nativeToolResult?.toolCallId)
        .filter((id): id is string => Boolean(id)));
    const includedToolCallIds = new Set<string>();

    items.forEach((item, idx) => {
        const depth = totalItems - idx;
        if (item.kind === "event") {
            prevWasHistory = false;
            blocks.push({
                text: item.text,
                role: "system",
                depth,
                order: 999,
                marker: `ShortTerm Event [${item.sourceTag}]`,
            });
            return;
        }

        const msg = history[item.historyIndex];
        if (!msg) return;
        if (params.nativeToolHistory && pushNativeToolHistoryBlock({
            blocks,
            msg,
            nativeResultIds,
            includedToolCallIds,
            depth,
            order: 999,
            marker: `History [${item.historyIndex}]`,
        })) {
            prevWasHistory = true;
            prevRole = msg.role;
            prevTs = (timeAware && msg.createdAt) ? formatChatTimestamp(msg.createdAt, timestampOptions) : "";
            return;
        }
        if (msg.mediaType === "music_notify"
            || msg.mediaType === "tool_notice"
            || isNativeToolResultMessage(msg)
            || msg.mediaType === "memory_write_request") return;

        const promptRole = resolveHistoryPromptRole(msg);
        const ts = (timeAware && msg.createdAt) ? formatChatTimestamp(msg.createdAt, timestampOptions) : "";
        const showTs = ts && prevWasHistory && ts === prevTs && promptRole === prevRole ? false : Boolean(ts);
        prevTs = ts;
        prevRole = promptRole;
        prevWasHistory = true;

        let body = stripStateAndInnerForPrompt(msg.content);
        let imageUrl: string | undefined;

        if (msg.mediaType) {
            const visionImageUrl = visionEnabled ? getPromptVisionImageUrl(msg) : undefined;
            if (visionImageUrl) {
                body = formatDirectVisionBody(msg, resolvedUserName, characterName);
                imageUrl = visionImageUrl;
            } else {
                body = formatRichMediaForHistory(msg, resolvedUserName, characterName);
            }
        }

        if (!body.trim() && !imageUrl) return;

        const isAssistantImage = imageUrl && msg.role === "assistant" && msg.mediaType === "media_file";
        const text = isAssistantImage
            ? formatAssistantImageHistoryText(msg, body, Boolean(showTs), ts)
            : (showTs ? `${ts}\n${body}` : body);
        blocks.push({
            text,
            role: isAssistantImage ? "user" : promptRole,
            depth,
            order: 999,
            marker: `History [${item.historyIndex}]`,
            fromHistory: true,
            imageUrl,
        });

        if (msg.isRetracted) {
            const who = msg.role === "user" ? resolvedUserName : (msg.role === "assistant" ? characterName : "");
            const notice = who ? `${who}撤回了上面这条消息` : "上面这条消息已被撤回";
            blocks.push({
                text: notice,
                role: "system",
                depth,
                order: 1000,
                marker: `History [${item.historyIndex}] (retracted)`,
                fromHistory: true,
            });
        }
    });

    blocks.push({
        text: "</shortTermMemory>",
        role: "system",
        depth: 1,
        order: Number.MAX_SAFE_INTEGER,
        marker: "shortTermMemory-close",
    });
}

function resolveBeforeHistoryDepth(historyLength: number, chronologicalItemLength?: number): number {
    return Math.max(996, historyLength + 2, (chronologicalItemLength ?? 0) + 2);
}

// ── Helper: classify world book entry position ──
function isWBBeforePosition(entry: WorldBookEntry): boolean {
    return entry.position === 0 || entry.position === "before_char";
}

function isWBAtDepthPosition(entry: WorldBookEntry): boolean {
    return entry.position === 4;
}

/**
 * Core Engine: Assembles the final LLM payload array using Depth and Order injection rules.
 * When a preset has prompt_order, uses macro expansion, prompt_order
 * sorting, RELATIVE/ABSOLUTE injection_position classification, and marker-based placement.
 * Otherwise falls back to the legacy hardcoded assembly path.
 */
export function assemblePromptPayload(input: AssemblerInput): LLMMessage[] {
    const { character, history, preset, worldBooks, regexes, userIdentity, userName = "User",
        longTermMemories, coreMemories, scheduleSummary } = input;
    const appId = input.appId ?? "chat";
    const filterEnabled = input.featureFilterEnabled !== false;
    const followUpCount = input.followUpCount ?? 0;
    // Compute active tags: appTags if provided, else derive from appId + followUpCount
    const activeTags: string[] = input.appTags
        ? [...input.appTags]
        : [appId, ...(followUpCount > 0 ? ["followup"] : [])];
    const followUpDelay = input.followUpDelay ?? 0;
    const timedWakeElapsedMinutes = input.timedWakeElapsedMinutes ?? 0;
    const timedWakeIntent = input.timedWakeIntent ?? "";
    const periodCareContext = input.periodCareContext ?? "";
    const resolvedUserName = userIdentity?.name || userName;
    const blocks: PromptBlock[] = [];
    const hasPromptOrder = !!(preset?.prompt_order && preset.prompt_order.length > 0);
    const timeAware = resolveTimeAware(input.timeAware);
    const promptTimeContext = input.timeContext ?? buildCharacterTimeContext(character.timeZone);
    const promptTimestampOptions = input.promptTimestampOptions
        ?? getPromptTimestampOptionsForTimeContext(promptTimeContext);

    // --- HIGH-LEVEL ROLEPLAY CONTEXT (legacy path only) ---
    // In prompt_order mode, the preset itself defines the opening prompt structure.
    if (!hasPromptOrder) {
        blocks.push({
            text: `# [System: Roleplay Context]`,
            role: "system",
            depth: 999,
            order: 0,
            marker: "Section: Roleplay Context"
        });
    }

    // --- World Book keyword activation (shared by both paths) ---
    const recentHistoryStr = input.worldBookActivationContext
        ?? history.slice(-10).map(m => m.content).join("\n");
    const activatedWBEntries: WorldBookEntry[] = [];
    worldBooks.forEach(wb => {
        (wb.entries || []).forEach(entry => {
            if (entry.disable) return;
            if (input.activateAllWorldBooks || isWorldBookEntryActivated(entry, recentHistoryStr)) {
                activatedWBEntries.push(entry);
            }
        });
    });

    // {{state}} is the explicit state update input; keep it separate from chat history/short-term memory.
    const latestStateValues = input.initialStateValues ?? findLatestStateValues(history);
    const stateStr = formatStateValuesForPrompt(latestStateValues);

    if (hasPromptOrder) {
        // ════════════════════════════════════════════════════════
        // PROMPT_ORDER DRIVEN PATH
        // ════════════════════════════════════════════════════════

        const engine = new MacroEngine(character.name, resolvedUserName);
        applyTimeContextToMacroEngine(engine, promptTimeContext);
        engine.lastUserMessage = history.filter(m => m.role === "user").pop()?.content ?? "";
        engine.lastCharMessage = history.filter(m => m.role === "assistant").pop()?.content ?? "";
        engine.lastMessage = history.length > 0 ? history[history.length - 1].content : "";
        engine.description = character.persona ?? "";
        engine.personality = character.personality ?? "";
        engine.persona = userIdentity?.bio ?? "";
        engine.stateStr = stateStr;
        engine.followUpCount = followUpCount;
        engine.followUpDelay = followUpDelay;
        engine.timedWakeElapsedMinutes = String(timedWakeElapsedMinutes);
        engine.timedWakeIntent = timedWakeIntent;
        engine.periodCareContext = periodCareContext;
        engine.customStickerNames = input.customStickerNames ?? "";
        engine.customStickerExample = input.customStickerExample ?? "";
        engine.musicLocal = input.musicLocal ?? "";
        engine.musicCloud = input.musicCloud ?? "";
        engine.musicOnlineHint = input.musicOnlineHint ?? "";
        engine.currentSchedule = input.currentSchedule ?? "";
        engine.vnScenes = input.vnScenes ?? "";
        engine.vnSprites = input.vnSprites ?? "";
        engine.vnBeats = input.vnBeats ?? "";
        engine.vnCurrentBeat = input.vnCurrentBeat ?? "";
        engine.affinity = input.affinity ?? "";
        engine.tools = input.tools ?? "";
        engine.cocreateWriteActions = input.cocreateWriteActions ?? "";
        engine.cocreateReadActions = input.cocreateReadActions ?? "";
        engine.groupTools = input.groupTools ?? "";
        engine.customAppRichMediaDirectives = input.customAppRichMediaDirectives ?? "";
        engine.chatBilingualInstruction = input.chatBilingualInstruction ?? "";
        engine.offlineBilingualInstruction = input.offlineBilingualInstruction ?? "";
        engine.offlineSummaryTag = input.offlineSummaryTag ?? "summary";
        engine.checkPhoneBilingualInstruction = input.checkPhoneBilingualInstruction ?? "";
        engine.xiaohongshuBilingualInstruction = input.xiaohongshuBilingualInstruction ?? "";
        engine.phoneAppId = input.phoneAppId ?? "";
        engine.phoneAppLabel = input.phoneAppLabel ?? "";
        engine.phoneSnapshotSummary = input.phoneSnapshotSummary ?? "";
        engine.phoneLastRefreshAt = input.phoneLastRefreshAt ?? "";
        engine.dwellingRoom = input.dwellingRoom ?? "";
        engine.dwellingFurniture = input.dwellingFurniture ?? "";
        engine.dwellingItem = input.dwellingItem ?? "";
        engine.dwellingItemPreview = input.dwellingItemPreview ?? "";
        engine.bookTitle = input.bookTitle ?? "";
        engine.chapterTitle = input.chapterTitle ?? "";
        engine.chapterContent = input.chapterContent ?? "";
        engine.annotationHistory = input.annotationHistory ?? "";
        engine.noteWallContext = input.noteWallContext ?? "";
        engine.diaryEntryContext = input.diaryEntryContext ?? "";
        engine.xiaohongshuFeedContext = input.xiaohongshuFeedContext ?? "";
        engine.xiaohongshuUserPostContext = input.xiaohongshuUserPostContext ?? "";
        engine.xiaohongshuCommentContext = input.xiaohongshuCommentContext ?? "";
        engine.xiaohongshuMentionContext = input.xiaohongshuMentionContext ?? "";
        engine.interviewTheme = input.interviewTheme ?? "";
        engine.interviewHostName = input.interviewHostName ?? "";
        engine.interviewGuests = input.interviewGuests ?? "";
        engine.interviewGuestCount = input.interviewGuestCount ?? "";
        engine.interviewCurrentGuest = input.interviewCurrentGuest ?? "";
        engine.interviewOtherGuests = input.interviewOtherGuests ?? "";
        engine.interviewQuestion = input.interviewQuestion ?? "";
        engine.interviewTranscript = input.interviewTranscript ?? "";
        engine.interviewPhase = input.interviewPhase ?? "";
        engine.interviewRound = input.interviewRound ?? "";
        engine.interviewUserAnswer = input.interviewUserAnswer ?? "";
        engine.interviewCharacterAnswerHistory = input.interviewCharacterAnswerHistory ?? "";
        engine.cocreateProjectContext = input.cocreateProjectContext ?? "";
        engine.cocreateCurrentMode = input.cocreateCurrentMode ?? "";
        engine.cocreateCurrentChapter = input.cocreateCurrentChapter ?? "";
        engine.cocreateChapterIndex = input.cocreateChapterIndex ?? "";
        engine.cocreateArchivedChapterContext = input.cocreateArchivedChapterContext ?? "";
        engine.cocreateWriterNotebook = input.cocreateWriterNotebook ?? "";

        const userPersonaText = buildUserPersonaText(userIdentity, resolvedUserName);
        const processingOrder = buildProcessingOrder(preset!);

        // Classify WB entries for marker placement
        const wbBeforeEntries = activatedWBEntries.filter(e => isWBBeforePosition(e));
        const wbAfterEntries = activatedWBEntries.filter(e => !isWBBeforePosition(e) && !isWBAtDepthPosition(e));
        const wbAtDepthEntries = activatedWBEntries.filter(e => isWBAtDepthPosition(e));

        let orderIdx = 0;
        let afterChatHistory = false;
        let afterOrderIdx = 0;
        const beforeHistoryDepth = resolveBeforeHistoryDepth(history.length, input.unifiedRecentItems?.length);
        const absoluteEntries: { prompt: Prompt; content: string; promptIndex: number }[] = [];

        for (let promptIndex = 0; promptIndex < processingOrder.length; promptIndex += 1) {
            const p = processingOrder[promptIndex];

            // shortTermMemory (or legacy chatHistory) marker: entries after this go to depth 0.
            // 分界作用不受开关影响（关掉也不改变其余条目的排序）；开关只控制历史/短期记忆是否注入，见 CHAT HISTORY 段。
            if (p.marker && (p.identifier === "shortTermMemory" || p.identifier === "chatHistory")) {
                afterChatHistory = true;
                continue;
            }

            if (!isPromptEnabled(p, preset!.prompt_order)) continue;

            // Tag-based filtering: entry's tags must ALL be present in activeTags
            if (filterEnabled && !p.marker) {
                const entryTags = getPromptTags(p);
                if (entryTags && !entryTags.every(t => activeTags.includes(t))) continue;
            }

            if (p.marker) {

                let markerContent = getMarkerContent(
                    p.identifier, character, userPersonaText,
                    wbBeforeEntries, wbAfterEntries,
                    scheduleSummary,
                    coreMemories,
                    longTermMemories,
                    regexes, { macroEngine: engine, activeTags },
                    input.characterRelations,
                    input.dwellingContext,
                );
                if (markerContent) {
                    // Expand macros in marker content ({{char}}/{{user}} in char descriptions etc.)
                    markerContent = engine.expand(markerContent);
                    markerContent = postProcessTrim(markerContent).trim();
                    if (markerContent) {
                        const xmlText = wrapXml(toXmlTag(p.identifier), markerContent);
                        if (afterChatHistory) {
                            blocks.push({
                                text: xmlText,
                                role: "system",
                                depth: 0,
                                order: 10 + afterOrderIdx++,
                                marker: p.identifier,
                            });
                        } else {
                            blocks.push({
                                text: xmlText,
                                role: "system",
                                depth: beforeHistoryDepth,
                                order: orderIdx++,
                                marker: p.identifier,
                            });
                        }
                    }
                }
                continue;
            }

            // Expand macros in prompt content
            let content = engine.expand(p.content);
            content = postProcessTrim(content).trim();
            if (!content) continue;

            const role = normalizeRole(p.role);

            if ((p.injection_position ?? 0) === 0) {
                // RELATIVE entry
                if (afterChatHistory) {
                    // After chatHistory marker → inject after chat history (depth 0)
                    blocks.push({
                        text: content,
                        role,
                        depth: 0,
                        order: 10 + afterOrderIdx++,
                        marker: p.name || p.identifier,
                    });
                } else {
                    // Before chatHistory marker -> system prompt area above the current history range.
                    blocks.push({
                        text: content,
                        role,
                        depth: beforeHistoryDepth,
                        order: orderIdx++,
                        marker: p.name || p.identifier,
                    });
                }
            } else {
                // ABSOLUTE: will be injected at specific chat depth
                absoluteEntries.push({ prompt: p, content, promptIndex });
            }
        }

        // Sort and inject ABSOLUTE entries
        const rolePriority: Record<string, number> = { system: 0, user: 1, assistant: 2 };
        absoluteEntries.sort((a, b) => {
            const da = a.prompt.injection_depth ?? 0;
            const db = b.prompt.injection_depth ?? 0;
            if (da !== db) return da - db;
            if (a.promptIndex !== b.promptIndex) return a.promptIndex - b.promptIndex;
            return (rolePriority[normalizeRole(a.prompt.role)] ?? 9) - (rolePriority[normalizeRole(b.prompt.role)] ?? 9);
        });

        let prevAbsDepth = -1;
        let absDepthOrder = 0;
        absoluteEntries.forEach(entry => {
            const d = entry.prompt.injection_depth ?? 0;
            if (d !== prevAbsDepth) { absDepthOrder = 0; prevAbsDepth = d; }
            blocks.push({
                text: entry.content,
                role: normalizeRole(entry.prompt.role),
                depth: d,
                order: absDepthOrder++, // lower than history's 999 → appears before history at same depth
                marker: entry.prompt.name || entry.prompt.identifier,
            });
        });

        // World book at-depth entries (position=4) — injected at specific chat depth
        wbAtDepthEntries.forEach(entry => {
            let content = engine.expand(entry.content);
            content = postProcessTrim(content).trim();
            if (!content) return;
            content = applyWorldInfoRegex(content, regexes, { macroEngine: engine, activeTags });
            blocks.push({
                text: content,
                role: entry.role === 1 ? "user" : (entry.role === 2 ? "assistant" : "system"),
                depth: entry.depth ?? 4,
                order: entry.insertion_order ?? 50,
                marker: `WB: ${entry.key}`,
            });
        });

    } else {
        // ════════════════════════════════════════════════════════
        // LEGACY HARDCODED PATH (no prompt_order)
        // ════════════════════════════════════════════════════════

        // 1. Character Persona (substitute {{char}}/{{user}} in character fields)
        const sub = (t: string) => substituteCharUser(t, character.name, resolvedUserName);
        blocks.push({
            text: `## [Character Persona]\nYou are ${character.name}.\n${sub(character.persona)}`,
            role: "system",
            depth: 998,
            order: 10,
            marker: "Character Persona"
        });

        if (character.personality?.trim()) {
            blocks.push({
                text: `## [Character Personality]\n${sub(character.personality)}`,
                role: "system",
                depth: 998,
                order: 11,
                marker: "Character Personality"
            });
        }

        // 3. User Identity (before worldbook-before and character data)
        {
            const userPersonaText = buildUserPersonaText(userIdentity, resolvedUserName);
            blocks.push({
                text: `## [User Persona]\n${userPersonaText}`,
                role: "system",
                depth: 999,
                order: 5,
                marker: "User Persona"
            });
        }

        // 4. Preset Prompts (with macro expansion for {{char}}/{{user}} etc.)
        let hasPresets = false;
        if (preset && preset.prompts) {
            const engine = new MacroEngine(character.name, resolvedUserName);
            applyTimeContextToMacroEngine(engine, promptTimeContext);
            engine.lastUserMessage = history.filter(m => m.role === "user").pop()?.content ?? "";
            engine.lastCharMessage = history.filter(m => m.role === "assistant").pop()?.content ?? "";
            engine.lastMessage = history.length > 0 ? history[history.length - 1].content : "";
            engine.description = character.persona ?? "";
            engine.personality = character.personality ?? "";
            engine.persona = userIdentity?.bio ?? "";
            engine.stateStr = stateStr;
            engine.followUpCount = followUpCount;
            engine.followUpDelay = followUpDelay;
            engine.timedWakeElapsedMinutes = String(timedWakeElapsedMinutes);
            engine.timedWakeIntent = timedWakeIntent;
            engine.periodCareContext = periodCareContext;
            engine.customStickerNames = input.customStickerNames ?? "";
        engine.customStickerExample = input.customStickerExample ?? "";
        engine.musicLocal = input.musicLocal ?? "";
        engine.musicCloud = input.musicCloud ?? "";
        engine.musicOnlineHint = input.musicOnlineHint ?? "";
        engine.currentSchedule = input.currentSchedule ?? "";
        engine.tools = input.tools ?? "";
        engine.cocreateWriteActions = input.cocreateWriteActions ?? "";
        engine.cocreateReadActions = input.cocreateReadActions ?? "";
        engine.groupTools = input.groupTools ?? "";
        engine.customAppRichMediaDirectives = input.customAppRichMediaDirectives ?? "";
        engine.chatBilingualInstruction = input.chatBilingualInstruction ?? "";
        engine.offlineBilingualInstruction = input.offlineBilingualInstruction ?? "";
        engine.offlineSummaryTag = input.offlineSummaryTag ?? "summary";
        engine.checkPhoneBilingualInstruction = input.checkPhoneBilingualInstruction ?? "";
        engine.xiaohongshuBilingualInstruction = input.xiaohongshuBilingualInstruction ?? "";
        engine.phoneAppId = input.phoneAppId ?? "";
        engine.phoneAppLabel = input.phoneAppLabel ?? "";
        engine.phoneSnapshotSummary = input.phoneSnapshotSummary ?? "";
        engine.phoneLastRefreshAt = input.phoneLastRefreshAt ?? "";
        engine.dwellingRoom = input.dwellingRoom ?? "";
        engine.dwellingFurniture = input.dwellingFurniture ?? "";
        engine.dwellingItem = input.dwellingItem ?? "";
        engine.dwellingItemPreview = input.dwellingItemPreview ?? "";
        engine.noteWallContext = input.noteWallContext ?? "";
        engine.diaryEntryContext = input.diaryEntryContext ?? "";
        engine.xiaohongshuFeedContext = input.xiaohongshuFeedContext ?? "";
        engine.xiaohongshuUserPostContext = input.xiaohongshuUserPostContext ?? "";
        engine.xiaohongshuCommentContext = input.xiaohongshuCommentContext ?? "";
        engine.xiaohongshuMentionContext = input.xiaohongshuMentionContext ?? "";
            engine.interviewTheme = input.interviewTheme ?? "";
            engine.interviewHostName = input.interviewHostName ?? "";
            engine.interviewGuests = input.interviewGuests ?? "";
            engine.interviewGuestCount = input.interviewGuestCount ?? "";
            engine.interviewCurrentGuest = input.interviewCurrentGuest ?? "";
            engine.interviewOtherGuests = input.interviewOtherGuests ?? "";
            engine.interviewQuestion = input.interviewQuestion ?? "";
        engine.interviewTranscript = input.interviewTranscript ?? "";
        engine.interviewPhase = input.interviewPhase ?? "";
        engine.interviewRound = input.interviewRound ?? "";
        engine.interviewUserAnswer = input.interviewUserAnswer ?? "";
        engine.interviewCharacterAnswerHistory = input.interviewCharacterAnswerHistory ?? "";
        engine.cocreateProjectContext = input.cocreateProjectContext ?? "";
        engine.cocreateCurrentMode = input.cocreateCurrentMode ?? "";
        engine.cocreateCurrentChapter = input.cocreateCurrentChapter ?? "";
        engine.cocreateChapterIndex = input.cocreateChapterIndex ?? "";
        engine.cocreateArchivedChapterContext = input.cocreateArchivedChapterContext ?? "";

            preset.prompts.forEach((p, idx) => {
                if (p.enabled && !p.marker) {
                    let content = engine.expand(p.content);
                    content = postProcessTrim(content).trim();
                    if (!content) return;
                    hasPresets = true;
                    blocks.push({
                        text: content,
                        role: normalizeRole(p.role),
                        depth: p.injection_depth ?? 996,
                        order: 50 + idx,
                        marker: p.name || `Preset Prompt ${idx}`
                    });
                }
            });
        }

        if (hasPresets) {
            blocks.push({
                text: `## [Scenario & Presets]`,
                role: "system",
                depth: 996,
                order: 40,
                marker: "Section: Presets"
            });
        }

        // 5. World Book entries (apply placement=5 regex to each entry)
        let hasWorldBooks = false;
        activatedWBEntries.forEach(entry => {
            hasWorldBooks = true;
            const resolvedDepth = resolveWorldBookDepth(entry);
            blocks.push({
                text: applyWorldInfoRegex(sub(entry.content), regexes),
                role: entry.role === 1 ? "user" : (entry.role === 2 ? "assistant" : "system"),
                depth: resolvedDepth,
                order: entry.insertion_order ?? 50,
                marker: `WB: ${entry.key}`
            });
        });

        if (hasWorldBooks) {
            blocks.push({
                text: `## [World Lore & Events]`,
                role: "system",
                depth: 995,
                order: 40,
                marker: "Section: World Lore"
            });
        }

        // 5b. Long-term memories (before chat history, depth 997)
        if (scheduleSummary?.trim()) {
            blocks.push({
                text: scheduleSummary,
                role: "system",
                depth: 997,
                order: 54,
                marker: "calendarSchedule"
            });
        }

        if (coreMemories?.trim()) {
            blocks.push({
                text: coreMemories,
                role: "system",
                depth: 997,
                order: 55,
                marker: "memoryCore"
            });
        }

        if (longTermMemories?.trim()) {
            blocks.push({
                text: longTermMemories,
                role: "system",
                depth: 997,
                order: 60,
                marker: "memoryLongTerm"
            });
        }
    }

    // --- CHAT HISTORY / SHORT-TERM MEMORY ---
    // shortTermMemory/chatHistory 标记条目被关闭时，跳过聊天历史与短期记忆注入
    // （标记的分界作用不受开关影响，见 prompt_order 循环）
    const historyMarkerPrompt = preset
        ? preset.prompts.find(p => p.marker && (p.identifier === "shortTermMemory" || p.identifier === "chatHistory"))
        : undefined;
    // 条目存在且开启才注入；条目被关闭或预设中没有该条目都不注入（没有就没有）。
    // 仅在完全未选择预设时保持注入兜底。
    const historyInjectionEnabled = !preset
        || (historyMarkerPrompt ? isPromptEnabled(historyMarkerPrompt, preset.prompt_order) : false);
    const useChronologicalShortTerm = Boolean(input.unifiedRecentItems && input.unifiedRecentItems.length > 0);
    if (!hasPromptOrder) {
        blocks.push({
            text: `# [System: Chat History]`,
            role: "system",
            depth: (useChronologicalShortTerm ? input.unifiedRecentItems!.length : history.length) + 2,
            order: 999,
            marker: "Section: Chat History"
        });
    }

    if (!historyInjectionEnabled) {
        // 历史注入被关闭：不输出 <shortTermMemory>、近期动态与聊天记录
    } else if (useChronologicalShortTerm) {
        pushChronologicalShortTermBlocks({
            blocks,
            items: input.unifiedRecentItems!,
            history,
            resolvedUserName,
            characterName: character.name,
            timeAware,
            timestampOptions: promptTimestampOptions,
            visionEnabled: input.enableVision === true,
            nativeToolHistory: input.nativeToolHistory === true,
        });
    } else if (hasPromptOrder) {
        // Wrap chat history section in XML tags with per-feature recent blocks
        const rb = input.recentBlocks ?? [];
        const lastBlock = rb.length > 0 ? rb[rb.length - 1] : null;
        // The last block wraps history (if it has empty content); others are complete blocks
        const historyWrapperTag = lastBlock && !lastBlock.content ? lastBlock.tag : null;

        blocks.push({
            text: "<shortTermMemory>",
            role: "system",
            depth: history.length + 1,
            order: 999,
            marker: "shortTermMemory-open",
        });

        // Emit non-current-feature blocks as complete XML blocks (above history)
        let blockOrder = 1001;
        for (const b of rb) {
            if (b === lastBlock && historyWrapperTag) continue; // skip — will wrap history
            if (!b.content) continue;
            blocks.push({
                text: `<${b.tag}>\n${b.content}\n</${b.tag}>`,
                role: "system",
                depth: history.length + 1,
                order: blockOrder++,
                marker: b.tag,
            });
        }

        // Current feature wraps history OR is emitted as a complete block
        if (historyWrapperTag && history.length > 0) {
            blocks.push({
                text: `<${historyWrapperTag}>`,
                role: "system",
                depth: history.length + 1,
                order: blockOrder++,
                marker: `${historyWrapperTag}-open`,
            });
            blocks.push({
                text: `</${historyWrapperTag}>`,
                role: "system",
                depth: 1,
                order: 1000,
                marker: `${historyWrapperTag}-close`,
            });
        }

        blocks.push({
            text: "</shortTermMemory>",
            role: "system",
            depth: 1,
            order: Number.MAX_SAFE_INTEGER,
            marker: "shortTermMemory-close",
        });
    }

    // --- History Messages ---
    if (historyInjectionEnabled && !useChronologicalShortTerm) {
        const historyLen = history.length;
        const visionEnabled = input.enableVision === true;
        const nativeResultIds = new Set(history
            .map(msg => msg.nativeToolResult?.toolCallId)
            .filter((id): id is string => Boolean(id)));
        const includedToolCallIds = new Set<string>();

        let prevTs = "";
        let prevRole = "";
        history.forEach((msg, idx) => {
            const distFromBottom = historyLen - idx;
            if (input.nativeToolHistory && pushNativeToolHistoryBlock({
                blocks,
                msg,
                nativeResultIds,
                includedToolCallIds,
                depth: distFromBottom,
                order: 999,
                marker: `History [${distFromBottom}]`,
            })) {
                prevTs = (timeAware && msg.createdAt) ? formatChatTimestamp(msg.createdAt, promptTimestampOptions) : "";
                prevRole = msg.role;
                return;
            }

            // UI-only notification — skip from prompt
            if (msg.mediaType === "music_notify"
                || msg.mediaType === "tool_notice"
                || isNativeToolResultMessage(msg)
                || msg.mediaType === "memory_write_request") return;

            const promptRole = resolveHistoryPromptRole(msg);
            const ts = (timeAware && msg.createdAt) ? formatChatTimestamp(msg.createdAt, promptTimestampOptions) : "";
            const showTs = ts && !(ts === prevTs && promptRole === prevRole);
            prevTs = ts;
            prevRole = promptRole;
            let body = stripStateAndInnerForPrompt(msg.content);
            let imageUrl: string | undefined;

            // Format rich-media messages as bracket markers so the AI sees them in context
            if (msg.mediaType) {
                const visionImageUrl = visionEnabled ? getPromptVisionImageUrl(msg) : undefined;
                if (visionImageUrl) {
                    body = formatDirectVisionBody(msg, resolvedUserName, character?.name || "对方");
                    imageUrl = visionImageUrl;
                } else {
                    body = formatRichMediaForHistory(msg, resolvedUserName, character?.name || "对方");
                }
            }

            if (!body.trim() && !imageUrl) return;
            const isAssistantImage = imageUrl && msg.role === "assistant" && msg.mediaType === "media_file";
            const text = isAssistantImage
                ? formatAssistantImageHistoryText(msg, body, Boolean(showTs), ts)
                : (showTs ? `${ts}\n${body}` : body);
            blocks.push({
                text,
                role: isAssistantImage ? "user" : promptRole,
                depth: distFromBottom,
                order: 999,
                marker: `History [${distFromBottom}]`,
                fromHistory: true,
                imageUrl,
            });

            // Retracted: keep the original message above, then append a system notice
            if (msg.isRetracted) {
                const who = msg.role === "user" ? resolvedUserName : (msg.role === "assistant" ? character.name : "");
                const notice = who ? `${who}撤回了上面这条消息` : "上面这条消息已被撤回";
                blocks.push({
                    text: notice,
                    role: "system",
                    depth: distFromBottom,
                    order: 1000,
                    marker: `History [${distFromBottom}] (retracted)`,
                    fromHistory: true,
                });
            }
        });
    }

    // --- Sort: depth descending, then order ascending ---
    blocks.sort((a, b) => {
        if (b.depth !== a.depth) return b.depth - a.depth;
        return a.order - b.order;
    });

    // --- Aggregate into final LLM messages ---
    // When using prompt_order, only merge adjacent history messages.
    // Preset entries intentionally use role alternation and should not be merged.
    const finalPayload: LLMMessage[] = [];
    blocks.forEach(b => {
        const inputCtx: RegexContext = b.fromHistory
            ? { depth: b.depth, activeTags }
            : { activeTags };
        const processedText = b.role === "tool" ? b.text : applyInputRegex(b.text, regexes, inputCtx);
        const carriesNativeToolData = b.role === "tool" || Boolean(b.toolCalls?.length);

        const canMerge = hasPromptOrder
            ? (b.fromHistory && finalPayload.length > 0 &&
               finalPayload[finalPayload.length - 1].role === b.role &&
               finalPayload[finalPayload.length - 1]._debugMeta?._fromHistory === true &&
               !carriesNativeToolData &&
               !finalPayload[finalPayload.length - 1].toolCalls?.length &&
               finalPayload[finalPayload.length - 1].role !== "tool")
            : (finalPayload.length > 0 &&
               finalPayload[finalPayload.length - 1].role === b.role &&
               !carriesNativeToolData &&
               !finalPayload[finalPayload.length - 1].toolCalls?.length &&
               finalPayload[finalPayload.length - 1].role !== "tool");

        if (b.imageUrl) {
            // Vision message: build multi-part content with image (never merged)
            const parts: LLMContentPart[] = [];
            if (processedText) parts.push({ type: "text", text: processedText });
            parts.push({ type: "image_url", image_url: { url: b.imageUrl, detail: "low" } });
            finalPayload.push({
                role: b.role,
                content: parts,
                reasoning: b.reasoning,
                openRouterReasoningDetails: b.openRouterReasoningDetails,
                toolCalls: b.toolCalls,
                toolCallId: b.toolCallId,
                name: b.toolName,
                _debugMeta: { marker: b.marker, depth: b.depth, order: b.order, _fromHistory: b.fromHistory },
            });
        } else if (canMerge && typeof finalPayload[finalPayload.length - 1].content === "string") {
            (finalPayload[finalPayload.length - 1].content as string) += "\n\n" + processedText;
            finalPayload[finalPayload.length - 1]._debugMeta = {
                ...finalPayload[finalPayload.length - 1]._debugMeta,
                marker: mergeMarkerText(finalPayload[finalPayload.length - 1]._debugMeta?.marker, b.marker),
            };
        } else {
            finalPayload.push({
                role: b.role,
                content: processedText,
                reasoning: b.reasoning,
                openRouterReasoningDetails: b.openRouterReasoningDetails,
                toolCalls: b.toolCalls,
                toolCallId: b.toolCallId,
                name: b.toolName,
                _debugMeta: { marker: b.marker, depth: b.depth, order: b.order, _fromHistory: b.fromHistory },
            });
        }
    });

    // --- Post-process: merge any remaining consecutive same-role messages ---
    // This catches cases where preset entries (non-history) end up adjacent to
    // history messages with the same role, which can cause API errors.
    for (let i = finalPayload.length - 1; i > 0; i--) {
        const cur = finalPayload[i];
        const prev = finalPayload[i - 1];
        const canMerge = cur.role === prev.role
            && cur.role !== "tool"
            && !cur.toolCalls?.length
            && !prev.toolCalls?.length
            && typeof cur.content === "string"
            && typeof prev.content === "string";
        if (canMerge) {
            prev.content = prev.content + "\n\n" + cur.content;
            prev._debugMeta = {
                ...prev._debugMeta,
                marker: mergeMarkerText(prev._debugMeta?.marker, cur._debugMeta?.marker),
            };
            finalPayload.splice(i, 1);
        }
    }

    return finalPayload;
}


// ── Rich Media History Formatting ──────────────────────────

/** Format a rich-media message as bracket text for LLM context. */
export function formatRichMediaForHistory(msg: ChatMessage, userName: string, charName: string, isGroup?: boolean): string {
    const d = msg.mediaData;
    switch (msg.mediaType) {
        case "red_packet": {
            const cnt = d?.count;
            return isGroup && cnt && cnt > 1
                ? `[红包:${d?.amount ?? 0}:${cnt}:${d?.label ?? "恭喜发财"}]`
                : `[红包:${d?.amount ?? 0}:${d?.label ?? "恭喜发财"}]`;
        }
        case "transfer": {
            const sn = d?.senderName;
            const rn = d?.recipientName;
            return isGroup && sn && rn
                ? `[转账:${d?.amount ?? 0}:${d?.label ?? "转账"}:${sn}:${rn}]`
                : `[转账:${d?.amount ?? 0}:${d?.label ?? "转账"}]`;
        }
        case "gift": {
            const giftName = d?.giftName || d?.label || "礼物";
            return isGroup && d?.recipientName
                ? `[礼物:${giftName}:${d.recipientName}]`
                : `[礼物:${giftName}]`;
        }
        case "payment_request":
            return formatShoppingPaymentRequestHistory({
                amount: d?.amount,
                amountLabel: d?.paymentRequestAmountLabel,
                items: d?.paymentRequestItems,
                itemsText: d?.paymentRequestItemsText,
            });
        case "contact_card":
            return `[名片:${d?.contactCardName || d?.label || "联系人"}]`;
        case "app_card": {
            const historyText = d?.appHistoryText?.trim();
            if (historyText) return historyText;
            const appName = d?.appName || "APP";
            const title = d?.appCardTitle || d?.label || "应用卡片";
            const body = d?.appCardBody || d?.appCardSummary || msg.content;
            return body ? `[${appName}卡片:${title}]${body}` : `[${appName}卡片:${title}]`;
        }
        case "image":
            return formatPhotoDirective(msg);
        case "media_file":
            if (d?.fileType === "image" && isImageGenerationMediaMessage(msg)) {
                return formatImageGenerationDirective(msg);
            }
            return msg.content;
        case "audio":
            return `[语音条:${d?.label ?? "语音消息"}]`;
        case "location":
            return `[位置:${d?.label ?? "位置"}]`;
        case "group_admin_notice":
            return d?.adminAction
                ? buildGroupAdminBracketText(d.adminAction, d.adminActorName || charName, d.adminTargetName || "", d.adminMuteMinutes)
                : msg.content;
        case "poke": {
            if (isGroup) {
                return `[${d?.pokeSender || charName}拍了拍${d?.pokeTarget || userName}]`;
            }
            const pokeTarget = d?.pokeTarget || (msg.role === "assistant" ? userName : charName);
            return `[我拍了拍${pokeTarget}]`;
        }
        case "sticker":
            return `[表情包:${d?.label ?? "表情"}]`;
        case "quote":
            return `[引用:${d?.quotePreview ?? ""}]${msg.content}`;
        case "music": {
            const artist = d?.musicArtist ? `-${d.musicArtist}` : "";
            return `[音乐:${d?.musicTitle ?? d?.label ?? "未知歌曲"}${artist}]`;
        }
        case "music_share": {
            const mTitle = d?.musicTitle || "未知歌曲";
            return `[音乐分享:${mTitle}]`;
        }
        case "xiaohongshu_note_share":
            return formatXiaohongshuShareForPrompt({
                author: d?.xiaohongshuAuthor,
                title: d?.xiaohongshuTitle,
                body: d?.xiaohongshuBody,
                description: d?.xiaohongshuDescription,
            });
        case "accept_red_packet":
            if (isGroup && d?.claimer && d?.owner) return `[${d.claimer}领取了${d.owner}的红包]`;
            return "[领取红包]";
        case "decline_red_packet":
            if (isGroup && d?.claimer && d?.owner) return `[${d.claimer}退回了${d.owner}的红包]`;
            return "[拒收红包]";
        case "accept_transfer":
            if (isGroup && d?.claimer && d?.owner) return `[${d.claimer}领取了${d.owner}的转账]`;
            return "[领取转账]";
        case "decline_transfer":
            if (isGroup && d?.claimer && d?.owner) return `[${d.claimer}退回了${d.owner}的转账]`;
            return "[拒收转账]";
        case "accept_payment_request":
            if (isGroup && d?.claimer && d?.owner) return `[${d.claimer}接受了${d.owner}的代付]`;
            return "[接受代付]";
        case "decline_payment_request":
            if (isGroup && d?.claimer && d?.owner) return `[${d.claimer}拒绝了${d.owner}的代付]`;
            return "[拒绝代付]";
        default:
            return msg.content;
    }
}

// ── Chat Timestamp Formatting ──────────────────────────────

export function formatChatTimestamp(isoStr: string, options?: PromptTimestampOptions): string {
    return formatPromptTimestamp(isoStr, options);
}

// ── State Value Lookup ──────────────────────────────

/** Scan history in reverse to find the most recent message with stateValues. */
function findLatestStateValues(history: ChatMessage[]): StateValue[] | null {
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].stateValues && history[i].stateValues!.length > 0) {
            return history[i].stateValues!;
        }
    }
    return null;
}

function formatStateValuesForPrompt(stateValues: StateValue[] | null | undefined): string {
    return stateValues && stateValues.length > 0
        ? stateValues.map(sv => `[${sv.name}:${sv.value}]`).join("")
        : "无（首次对话）";
}

// ── World Book Logic ──────────────────────────────

/**
 * Resolve the assembly depth for a world book entry based on its `position` field.
 *
 * Numeric world book position mapping:
 *   0 (before)    → before character definition
 *   1 (after)     → after character definition
 *   2 (ANTop)     → top of Author's Note    → mapped to after char (no AN in our system)
 *   3 (ANBottom)  → bottom of Author's Note  → mapped to lore section
 *   4 (atDepth)   → insert at entry.depth within chat history
 *   5 (EMTop)     → top of example messages  → mapped to after char (no EM in our system)
 *   6 (EMBottom)  → bottom of example messages → mapped to lore section
 *   7 (outlet)    → named outlet (not auto-injected) → treat as lore section
 *
 * Only position 4 (atDepth) uses entry.depth for chat-history insertion.
 * All other positions map to fixed structural depths.
 */
function resolveWorldBookDepth(entry: WorldBookEntry): number {
    const pos = entry.position;
    // String-based positions (legacy internal format)
    if (pos === "before_char") return 999;
    if (pos === "after_char") return 997;
    if (pos === "before_an") return 997;
    if (pos === "after_an") return 995;
    if (pos === "before_em") return 997;
    if (pos === "after_em") return 995;
    // Numeric positions
    if (pos === 0) return 999; // before char
    if (pos === 1) return 997; // after char
    if (pos === 2) return 997; // AN top → after char area
    if (pos === 3) return 995; // AN bottom → lore section
    if (pos === 4) return entry.depth ?? 4; // @D: use entry.depth for chat insertion
    if (pos === 5) return 997; // EM top → after char area
    if (pos === 6) return 995; // EM bottom → lore section
    if (pos === 7) return 995; // outlet → lore section (no outlet support)
    // Fallback: lore section
    return 995;
}

export function isWorldBookEntryActivated(entry: WorldBookEntry, contextText: string): boolean {
    if (entry.constant) return true;

    // Key string is usually comma separated
    const keys = entry.key.split(",").map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) return false;

    let keyMatch = false;
    if (entry.use_regex) {
        keyMatch = keys.some(k => {
            try {
                const regex = new RegExp(k, "i");
                return regex.test(contextText);
            } catch {
                return false;
            }
        });
    } else {
        const lowerCtx = contextText.toLowerCase();
        keyMatch = keys.some(k => lowerCtx.includes(k.toLowerCase()));
    }

    if (!keyMatch) return false;

    // Probability gate: if useProbability is enabled, roll a random check
    if (entry.useProbability && typeof entry.probability === "number" && entry.probability < 100) {
        if (entry.probability <= 0) return false;
        if (Math.random() * 100 >= entry.probability) return false;
    }

    return true;
}

// ── Regex Processing ─────────────────

/** Context passed to the regex engine to control which rules fire. */
export type RegexContext = {
    isMarkdown?: boolean;    // true when rendering for display
    isPrompt?: boolean;      // true when assembling prompt
    isEdit?: boolean;        // true when user is editing a message
    depth?: number;          // message depth (0 = latest)
    activeTags?: string[];   // current app tags used for tag-scoped rule filtering
    macroEngine?: MacroEngine;  // for {{char}} etc. in findRegex & replaceString
};

/**
 * Parse a regex string like `/pattern/flags` into a RegExp.
 * Returns null if invalid. Does NOT force any flags — uses exactly what the user wrote.
 */
function regexFromString(input: string): RegExp | null {
    try {
        const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
        if (!m) return null;
        if (m[3] && !/^(?!.*?(.).*?\1)[dgimsuyv]+$/.test(m[3])) {
            return new RegExp(input);
        }
        return new RegExp(m[2], m[3]);
    } catch {
        return null;
    }
}

/** Escape special regex chars in a macro value so it can be embedded in a findRegex pattern. */
function sanitizeRegexMacro(x: string): string {
    if (!x || typeof x !== "string") return x;
    return x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (s) => {
        switch (s) {
            case "\n": return "\\n";
            case "\r": return "\\r";
            case "\t": return "\\t";
            case "\v": return "\\v";
            case "\f": return "\\f";
            case "\0": return "\\0";
            default:   return "\\" + s;
        }
    });
}

/**
 * Remove trimStrings from a string (applied to each capture-group match).
 * macroEngine is used to expand macros inside each trimString before removal.
 */
function filterString(raw: string, trimStrings: string[] | undefined, macroEngine?: MacroEngine): string {
    if (!trimStrings || trimStrings.length === 0) return raw;
    let result = raw;
    for (const ts of trimStrings) {
        const expanded = macroEngine ? macroEngine.expand(ts) : ts;
        result = result.replaceAll(expanded, "");
    }
    return result;
}

/**
 * Run a single regex rule against a string.
 * Supports: {{match}}, $0-$N, $<name>, trimStrings, macro expansion in result.
 */
function runRegexRule(rule: import("./settings-types").RegexRule, text: string, macroEngine?: MacroEngine): string {
    if (!rule.findRegex || !text) return text;

    // --- optionally substitute macros inside the findRegex pattern ---
    let regexString = rule.findRegex;
    if (rule.substituteRegex && macroEngine) {
        if (rule.substituteRegex === 2) {
            // ESCAPED: expand each macro individually, then escape regex-special chars in the resolved value
            regexString = rule.findRegex.replace(/\{\{([^{}]*?)\}\}/gs, (_m, body: string) => {
                const wrapped = `{{${body}}}`;
                const resolved = macroEngine.expand(wrapped);
                if (resolved === wrapped) return resolved; // unresolved macro, leave as-is
                return sanitizeRegexMacro(resolved);
            });
        } else {
            // RAW: just expand macros directly
            regexString = macroEngine.expand(regexString);
        }
    }

    const findRegex = regexFromString(regexString);
    if (!findRegex) return text;

    // Reset lastIndex for global/sticky regexes
    if (findRegex.global || findRegex.sticky) {
        findRegex.lastIndex = 0;
    }

    const newString = text.replace(findRegex, function (...args: unknown[]) {
        // Bridge {{match}} → $0
        const replaceStr = (rule.replaceString || "").replace(/\{\{match\}\}/gi, "$0");

        // Custom group replacement: handle $0, $1...$N, $<name> with trimStrings
        const replaced = replaceStr.replace(
            /\$(\d+)|\$<([^>]+)>/g,
            (_: string, num?: string, groupName?: string) => {
                let match: string | undefined;
                if (num !== undefined) {
                    match = args[Number(num)] as string | undefined;
                } else if (groupName) {
                    // Named group: last argument is the groups object
                    const groups = args[args.length - 1] as Record<string, string> | undefined;
                    match = groups && typeof groups === "object" ? groups[groupName] : undefined;
                }
                if (!match) return "";
                return filterString(match, rule.trimStrings, macroEngine);
            },
        );

        // Final macro substitution on the whole replacement result
        return macroEngine ? macroEngine.expand(replaced) : replaced;
    });

    return newString;
}

/**
 * Determine whether a rule should fire given the current context.
 * Applies rule filtering for display, prompt, edit, depth, and tag contexts.
 */
function shouldRunRule(
    rule: import("./settings-types").RegexRule,
    placement: number,
    ctx: RegexContext,
): boolean {
    if (rule.disabled) return false;
    if (!rule.placement?.includes(placement)) return false;
    if (!matchesActiveTags(rule.tags, ctx.activeTags ?? [])) return false;

    // markdownOnly / promptOnly / default filtering
    const { isMarkdown = false, isPrompt = false, isEdit = false, depth } = ctx;
    const md = rule.markdownOnly === true;
    const po = rule.promptOnly === true;
    const fires =
        (md && isMarkdown) ||
        (po && isPrompt) ||
        (!md && !po && !isMarkdown && !isPrompt);
    if (!fires) return false;

    // runOnEdit gate
    if (isEdit && !rule.runOnEdit) return false;

    // depth filtering
    if (typeof depth === "number") {
        if (rule.minDepth != null && rule.minDepth >= -1 && depth < rule.minDepth) return false;
        if (rule.maxDepth != null && rule.maxDepth >= 0 && depth > rule.maxDepth) return false;
    }

    return true;
}

/** Apply regex rules that match a given placement + context. */
function applyRegex(text: string, regexGroups: RegexConfig[], placement: number, ctx: RegexContext = {}): string {
    let result = text;
    for (const group of regexGroups) {
        for (const rule of group.rules) {
            if (!shouldRunRule(rule, placement, ctx)) continue;
            try {
                result = runRegexRule(rule, result, ctx.macroEngine);
            } catch {
                // Ignore bad regex rules safely
            }
        }
    }
    return result;
}

function applyInputRegex(text: string, regexGroups: RegexConfig[], ctx?: RegexContext): string {
    return applyRegex(text, regexGroups, 1, { isPrompt: true, ...ctx });
}

/**
 * Test a single regex rule against input text (for the UI test panel).
 * Uses the same production engine so behaviour matches exactly.
 * Creates a dummy MacroEngine with placeholder names to test macro expansion.
 */
export function testRegexRule(
    rule: import("./settings-types").RegexRule,
    input: string,
): { output: string; matchCount: number; error?: string } {
    if (!rule.findRegex?.trim() || !input) return { output: input, matchCount: 0 };
    try {
        // Create a test MacroEngine so substituteRegex and macro replacement work in preview
        const testMacro = new MacroEngine("角色名", "用户名");

        // Resolve findRegex with macro substitution if enabled
        let resolvedFindRegex = rule.findRegex;
        if (rule.substituteRegex && rule.substituteRegex > 0) {
            if (rule.substituteRegex === 2) {
                resolvedFindRegex = rule.findRegex.replace(/\{\{([^{}]*?)\}\}/gs, (_m, body: string) => {
                    const wrapped = `{{${body}}}`;
                    const resolved = testMacro.expand(wrapped);
                    if (resolved === wrapped) return resolved;
                    return sanitizeRegexMacro(resolved);
                });
            } else {
                resolvedFindRegex = testMacro.expand(rule.findRegex);
            }
        }

        const findRegex = regexFromString(resolvedFindRegex);
        if (!findRegex) {
            return { output: input, matchCount: 0, error: "无法解析正则表达式" };
        }
        // Count matches first (need a global copy for matchAll)
        const globalCopy = new RegExp(findRegex.source, findRegex.flags.includes("g") ? findRegex.flags : findRegex.flags + "g");
        const matchCount = [...input.matchAll(globalCopy)].length;
        // Run the actual replacement through the production engine with macro support
        const output = runRegexRule(rule, input, testMacro);
        return { output, matchCount };
    } catch (e) {
        return { output: input, matchCount: 0, error: `正则语法错误：${(e as Error).message}` };
    }
}

// ── Group Chat Prompt Assembly ──────────────────────────────

export interface GroupMemberData {
    character: Character;
    worldBooks: WorldBookConfig[];
    scheduleSummary?: string;
    currentSchedule?: string;
    coreMemories?: string;
    longTermMemories?: string;
    currentStateValues?: StateValue[];
    characterRelations?: string;
}

export interface GroupAssemblerInput {
    members: GroupMemberData[];
    history: ChatMessage[];
    preset: PresetConfig | null;
    regexes: RegexConfig[];
    appTags?: string[];
    userIdentity?: UserIdentity | null;
    userName?: string;
    groupName?: string;
    memberNames?: string;
    worldBookActivationContext?: string;
    recentBlocks?: RecentBlock[];
    unifiedRecentItems?: UnifiedRecentItem[];
    customStickerNames?: string;
    customStickerExample?: string;
    musicLocal?: string;
    musicCloud?: string;
    musicOnlineHint?: string;
    currentSchedule?: string;
    enableVision?: boolean;
    timeContext?: CharacterTimeContext;
    memberTimeContexts?: Record<string, CharacterTimeContext>;
    promptTimestampOptions?: PromptTimestampOptions;
    timeAware?: boolean;
    tools?: string;
    cocreateWriteActions?: string;
    cocreateReadActions?: string;
    groupTools?: string;
    groupRoster?: string;
    customAppRichMediaDirectives?: string;
    chatBilingualInstruction?: string;
    offlineBilingualInstruction?: string;
    offlineSummaryTag?: string;
    checkPhoneBilingualInstruction?: string;
    xiaohongshuBilingualInstruction?: string;
    nativeToolHistory?: boolean;
}

function pushGroupChronologicalShortTermBlocks(params: {
    blocks: PromptBlock[];
    items: UnifiedRecentItem[];
    history: ChatMessage[];
    timeAware: boolean;
    timestampOptions?: PromptTimestampOptions;
    visionEnabled: boolean;
    nativeToolHistory: boolean;
}) {
    const {
        blocks,
        items,
        history,
        timeAware,
        timestampOptions,
        visionEnabled,
        nativeToolHistory,
    } = params;

    const totalItems = items.length;
    const wrapperOpenDepth = totalItems + 1;
    blocks.push({
        text: "<shortTermMemory>",
        role: "system",
        depth: wrapperOpenDepth,
        order: 999,
        marker: "shortTermMemory-open",
    });

    const nativeResultIds = new Set(history
        .map(msg => msg.nativeToolResult?.toolCallId)
        .filter((id): id is string => Boolean(id)));
    const includedToolCallIds = new Set<string>();
    let prevTs = "";
    let prevRole = "";
    let prevWasHistory = false;

    items.forEach((item, idx) => {
        const depth = totalItems - idx;
        if (item.kind === "event") {
            prevWasHistory = false;
            blocks.push({
                text: item.text,
                role: "system",
                depth,
                order: 999,
                marker: `ShortTerm Event [${item.sourceTag}]`,
            });
            return;
        }

        const msg = history[item.historyIndex];
        if (!msg) return;
        if (nativeToolHistory && pushNativeToolHistoryBlock({
            blocks,
            msg,
            nativeResultIds,
            includedToolCallIds,
            depth,
            order: 999,
            marker: `History [${item.historyIndex}]`,
        })) {
            prevTs = (timeAware && msg.createdAt) ? formatChatTimestamp(msg.createdAt, timestampOptions) : "";
            prevRole = msg.role;
            prevWasHistory = true;
            return;
        }
        if (msg.mediaType === "tool_notice"
            || isNativeToolResultMessage(msg)) return;

        const promptRole = resolveHistoryPromptRole(msg);
        const ts = (timeAware && msg.createdAt) ? formatChatTimestamp(msg.createdAt, timestampOptions) : "";
        const showTs = ts && prevWasHistory && ts === prevTs && promptRole === prevRole ? false : Boolean(ts);
        prevTs = ts;
        prevRole = promptRole;
        prevWasHistory = true;

        let body = msg.content;
        let imageUrl: string | undefined;

        const visionImageUrl = visionEnabled ? getPromptVisionImageUrl(msg) : undefined;
        if (visionImageUrl) {
            body = formatAnnotatedVisionBody(msg, body);
            imageUrl = visionImageUrl;
        }

        const isAssistantImage = imageUrl && msg.role === "assistant" && msg.mediaType === "media_file";
        const text = isAssistantImage
            ? formatAssistantImageHistoryText(msg, body, Boolean(showTs), ts)
            : (showTs ? `${ts}\n${body}` : body);
        blocks.push({
            text,
            role: isAssistantImage ? "user" : promptRole,
            depth,
            order: 999,
            marker: `History [${item.historyIndex}]`,
            fromHistory: true,
            imageUrl,
        });
    });

    blocks.push({
        text: "</shortTermMemory>",
        role: "system",
        depth: 1,
        order: Number.MAX_SAFE_INTEGER,
        marker: "shortTermMemory-close",
    });
}

/**
 * Assembles a single unified prompt payload for group chat.
 * All members' character data is included in <member> blocks,
 * and the AI is asked to respond as all characters simultaneously.
 */
export function assembleGroupPromptPayload(input: GroupAssemblerInput): LLMMessage[] {
    const {
        members, history, preset, regexes, userIdentity,
        userName = "User", groupName, memberNames,
        recentBlocks, unifiedRecentItems,
    } = input;
    const activeTags = input.appTags ? [...input.appTags] : ["group_chat"];
    const resolvedUserName = userIdentity?.name || userName;
    const blocks: PromptBlock[] = [];
    const hasPromptOrder = !!(preset?.prompt_order && preset.prompt_order.length > 0);
    const timeAware = resolveTimeAware(input.timeAware);
    const groupTimeContext = input.timeContext
        ?? buildGroupTimeContext(members.map(member => ({
            name: member.character.name,
            timeZone: member.character.timeZone,
        })));
    const groupPromptTimestampOptions = input.promptTimestampOptions
        ?? getPromptTimestampOptionsForTimeContext(groupTimeContext);
    const beforeHistoryDepth = resolveBeforeHistoryDepth(history.length, unifiedRecentItems?.length);

    // Build shared activation context for world books
    const activationContext = input.worldBookActivationContext
        ?? history.slice(-10).map(m => m.content).join("\n");

    let orderIdx = 0;

    // Markers to skip inside <member> blocks (injected at group level instead)
    const SKIP_IN_MEMBER = new Set(["personaDescription"]);

    // 1. User persona block before members and chat history.
    const userPersonaText = buildUserPersonaText(userIdentity, resolvedUserName);
    blocks.push({
        text: wrapXml("personaDescription", userPersonaText),
        role: "system",
        depth: beforeHistoryDepth,
        order: orderIdx++,
        marker: "personaDescription",
    });

    // 1.5 跨成员世界书去重(多人资料包全局规则):
    //  - 独享书(仅 1 个成员绑定):维持现状——前/后条目进该成员的 <member> 块,
    //    at-depth 条目按深度插入聊天历史({{char}}=该成员)。
    //  - 共享书(≥2 个成员绑定):只注入一份——"角色设定前"在全部成员块之前、
    //    "角色设定后"在全部成员块之后、at-depth 按深度插入;
    //    {{char}}=绑定了这本书的成员名单(不是全员名单)。
    //  - at-depth 条目此前在群组装里被静默丢弃(只在单聊生效),本次一并修复:
    //    插入位置与成员无关,独享/共享的区别只是去重。
    // 绑定计数按角色 id(同名角色不合并,同一成员重复绑定只算一次);名字仅用于 {{char}} 展示
    const bookBinderIds = new Map<string, Set<string>>();
    const bookBinderNames = new Map<string, string[]>();
    for (const m of members) {
        for (const wb of m.worldBooks) {
            const ids = bookBinderIds.get(wb.id) ?? new Set<string>();
            if (!ids.has(m.character.id)) {
                ids.add(m.character.id);
                const names = bookBinderNames.get(wb.id) ?? [];
                if (!names.includes(m.character.name)) names.push(m.character.name);
                bookBinderNames.set(wb.id, names);
            }
            bookBinderIds.set(wb.id, ids);
        }
    }
    const isSharedBook = (id: string): boolean => (bookBinderIds.get(id)?.size ?? 0) >= 2;
    const atDepthInjections: { entry: WorldBookEntry; engine: MacroEngine }[] = [];
    const sharedAfterBlocks: { text: string; marker: string }[] = [];

    const seenSharedBooks = new Set<string>();
    for (const m of members) {
        for (const wb of m.worldBooks) {
            if (!isSharedBook(wb.id) || seenSharedBooks.has(wb.id)) continue;
            seenSharedBooks.add(wb.id);
            const bookEngine = new MacroEngine((bookBinderNames.get(wb.id) ?? []).join("、"), resolvedUserName);
            applyTimeContextToMacroEngine(bookEngine, groupTimeContext);
            const activated = (wb.entries || []).filter(entry =>
                !entry.disable && isWorldBookEntryActivated(entry, activationContext));
            activated.filter(e => isWBAtDepthPosition(e)).forEach(entry => {
                atDepthInjections.push({ entry, engine: bookEngine });
            });
            const renderJoined = (entries: WorldBookEntry[]): string => {
                const sorted = [...entries].sort((a, b) => (a.insertion_order ?? 50) - (b.insertion_order ?? 50));
                return postProcessTrim(bookEngine.expand(
                    sorted.map(e => applyWorldInfoRegex(e.content, regexes, { macroEngine: bookEngine, activeTags })).join("\n\n"),
                )).trim();
            };
            const beforeText = renderJoined(activated.filter(e => isWBBeforePosition(e)));
            if (beforeText) {
                blocks.push({
                    text: beforeText,
                    role: "system",
                    depth: beforeHistoryDepth,
                    order: orderIdx++,
                    marker: `sharedWorldInfo(before): ${wb.name || wb.id}`,
                });
            }
            const afterText = renderJoined(activated.filter(e => !isWBBeforePosition(e) && !isWBAtDepthPosition(e)));
            if (afterText) {
                sharedAfterBlocks.push({ text: afterText, marker: `sharedWorldInfo(after): ${wb.name || wb.id}` });
            }
        }
    }

    // 2. Per-member <member> blocks — preset-driven marker iteration
    const processingOrder = hasPromptOrder ? buildProcessingOrder(preset!) : [];

    for (const m of members) {
        const char = m.character;
        const engine = new MacroEngine(char.name, resolvedUserName);
        applyTimeContextToMacroEngine(
            engine,
            input.memberTimeContexts?.[char.id] ?? buildCharacterTimeContext(char.timeZone),
        );
        engine.description = char.persona ?? "";
        engine.personality = char.personality ?? "";
        engine.persona = userIdentity?.bio ?? "";
        engine.stateStr = formatStateValuesForPrompt(m.currentStateValues);
        engine.lastUserMessage = history.filter(msg => resolveHistoryPromptRole(msg) === "user").pop()?.content ?? "";
        engine.lastCharMessage = history.filter(msg => resolveHistoryPromptRole(msg) === "assistant").pop()?.content ?? "";
        engine.lastMessage = history.length > 0 ? history[history.length - 1].content : "";
        engine.customStickerNames = input.customStickerNames ?? "";
        engine.customStickerExample = input.customStickerExample ?? "";
        engine.musicLocal = input.musicLocal ?? "";
        engine.musicCloud = input.musicCloud ?? "";
        engine.musicOnlineHint = input.musicOnlineHint ?? "";
        engine.currentSchedule = m.currentSchedule ?? "";
        engine.tools = input.tools ?? "";
        engine.cocreateWriteActions = input.cocreateWriteActions ?? "";
        engine.cocreateReadActions = input.cocreateReadActions ?? "";
        engine.groupTools = input.groupTools ?? "";
        engine.groupRoster = input.groupRoster ?? "";
        engine.chatBilingualInstruction = input.chatBilingualInstruction ?? "";
        engine.offlineBilingualInstruction = input.offlineBilingualInstruction ?? "";
        engine.offlineSummaryTag = input.offlineSummaryTag ?? "summary";
        engine.checkPhoneBilingualInstruction = input.checkPhoneBilingualInstruction ?? "";
        engine.xiaohongshuBilingualInstruction = input.xiaohongshuBilingualInstruction ?? "";

        // Activate world book entries for this member(共享书已提升到组级注入,这里只处理独享书)
        const activatedEntries: WorldBookEntry[] = [];
        m.worldBooks.forEach(wb => {
            if (isSharedBook(wb.id)) return;
            (wb.entries || []).forEach(entry => {
                if (entry.disable) return;
                if (isWorldBookEntryActivated(entry, activationContext)) {
                    activatedEntries.push(entry);
                }
            });
        });
        // 独享书的 at-depth 条目:按深度插入聊天历史({{char}}=该成员),不进成员块
        activatedEntries.filter(e => isWBAtDepthPosition(e)).forEach(entry => {
            atDepthInjections.push({ entry, engine });
        });
        const wbBeforeEntries = activatedEntries.filter(e => isWBBeforePosition(e));
        const wbAfterEntries = activatedEntries.filter(e => !isWBBeforePosition(e) && !isWBAtDepthPosition(e));

        // Build member content by iterating preset markers in order
        const sections: string[] = [];

        if (hasPromptOrder) {
            for (const p of processingOrder) {
                if (!isPromptEnabled(p, preset!.prompt_order)) continue;
                if (!p.marker) continue; // only process markers inside member blocks

                // Skip markers handled at group level
                if (SKIP_IN_MEMBER.has(p.identifier)) continue;

                // shortTermMemory marker: append per-member short-term blocks, then stop
                if (p.identifier === "shortTermMemory" || p.identifier === "chatHistory") {
                    break; // markers after divider are feature prompts, not member data
                }

                // Get content for this marker using per-member data
                let markerContent = getMarkerContent(
                    p.identifier, char, "",
                    wbBeforeEntries, wbAfterEntries,
                    m.scheduleSummary,
                    m.coreMemories,
                    m.longTermMemories,
                    regexes, { macroEngine: engine, activeTags },
                    m.characterRelations,
                );
                if (markerContent) {
                    markerContent = engine.expand(markerContent);
                    markerContent = postProcessTrim(markerContent).trim();
                    if (markerContent) {
                        sections.push(markerContent);
                    }
                }
            }
        } else {
            // Legacy fallback: hardcoded order
            if (wbBeforeEntries.length > 0) {
                const sorted = [...wbBeforeEntries].sort((a, b) => (a.insertion_order ?? 50) - (b.insertion_order ?? 50));
                sections.push(engine.expand(sorted.map(e => applyWorldInfoRegex(e.content, regexes, { macroEngine: engine, activeTags })).join("\n\n")));
            }
            sections.push(engine.expand(`You are ${char.name}.\n${char.persona}`));
            if (char.personality?.trim()) sections.push(engine.expand(char.personality));
            if (wbAfterEntries.length > 0) {
                const sorted = [...wbAfterEntries].sort((a, b) => (a.insertion_order ?? 50) - (b.insertion_order ?? 50));
                sections.push(engine.expand(sorted.map(e => applyWorldInfoRegex(e.content, regexes, { macroEngine: engine, activeTags })).join("\n\n")));
            }
            if (m.scheduleSummary?.trim()) sections.push(m.scheduleSummary);
            if (m.coreMemories?.trim()) sections.push(m.coreMemories);
            if (m.longTermMemories?.trim()) sections.push(m.longTermMemories);
        }

        const stateSection = [
            "<current_state>",
            `当前该角色状态值：${formatStateValuesForPrompt(m.currentStateValues)}`,
            "</current_state>",
        ].join("\n");
        const memberContent = postProcessTrim([stateSection, ...sections].filter(Boolean).join("\n\n")).trim();
        if (memberContent) {
            blocks.push({
                text: `<member name="${char.name}">\n${memberContent}\n</member>`,
                role: "system",
                depth: beforeHistoryDepth,
                order: orderIdx++,
                marker: `member:${char.name}`,
            });
        }
    }

    // 2.5 共享书"角色设定后"条目:全部成员块之后,每本书一份
    for (const b of sharedAfterBlocks) {
        blocks.push({
            text: b.text,
            role: "system",
            depth: beforeHistoryDepth,
            order: orderIdx++,
            marker: b.marker,
        });
    }
    // 2.6 at-depth 世界书条目(独享+共享,均已去重):照单聊规则插入聊天历史对应深度
    for (const inj of atDepthInjections) {
        let content = inj.engine.expand(inj.entry.content);
        content = postProcessTrim(content).trim();
        if (!content) continue;
        content = applyWorldInfoRegex(content, regexes, { macroEngine: inj.engine, activeTags });
        blocks.push({
            text: content,
            role: inj.entry.role === 1 ? "user" : (inj.entry.role === 2 ? "assistant" : "system"),
            depth: inj.entry.depth ?? 4,
            order: inj.entry.insertion_order ?? 50,
            marker: `WB: ${inj.entry.key}`,
        });
    }

    // 3. Feature-tagged prompts from preset
    if (hasPromptOrder) {
        const memberNameStr = memberNames || members.map(m => m.character.name).join("、");

        // Create a macro engine for group-level prompts ({{char}} = all member names)
        const groupEngine = new MacroEngine(memberNameStr, resolvedUserName);
        applyTimeContextToMacroEngine(groupEngine, groupTimeContext);
        groupEngine.group = groupName || "";
        groupEngine.lastUserMessage = history.filter(msg => resolveHistoryPromptRole(msg) === "user").pop()?.content ?? "";
        groupEngine.lastCharMessage = history.filter(msg => resolveHistoryPromptRole(msg) === "assistant").pop()?.content ?? "";
        groupEngine.lastMessage = history.length > 0 ? history[history.length - 1].content : "";
        groupEngine.customStickerNames = input.customStickerNames ?? "";
        groupEngine.customStickerExample = input.customStickerExample ?? "";
        groupEngine.musicLocal = input.musicLocal ?? "";
        groupEngine.musicCloud = input.musicCloud ?? "";
        groupEngine.musicOnlineHint = input.musicOnlineHint ?? "";
        groupEngine.currentSchedule = input.currentSchedule ?? "";
        groupEngine.stateStr = members
            .map(m => `${m.character.name}: ${formatStateValuesForPrompt(m.currentStateValues)}`)
            .join("\n");
        groupEngine.tools = input.tools ?? "";
        groupEngine.cocreateWriteActions = input.cocreateWriteActions ?? "";
        groupEngine.cocreateReadActions = input.cocreateReadActions ?? "";
        groupEngine.groupTools = input.groupTools ?? "";
        groupEngine.groupRoster = input.groupRoster ?? "";
        groupEngine.customAppRichMediaDirectives = input.customAppRichMediaDirectives ?? "";
        groupEngine.chatBilingualInstruction = input.chatBilingualInstruction ?? "";
        groupEngine.offlineBilingualInstruction = input.offlineBilingualInstruction ?? "";
        groupEngine.offlineSummaryTag = input.offlineSummaryTag ?? "summary";

        let afterChatHistory = false;
        let afterOrderIdx = 0;

        for (let promptIndex = 0; promptIndex < processingOrder.length; promptIndex += 1) {
            const p = processingOrder[promptIndex];

            // 分界作用不受开关影响；开关只控制历史/短期记忆是否注入，见下方 Short-term memory 段
            if (p.marker && (p.identifier === "shortTermMemory" || p.identifier === "chatHistory")) {
                afterChatHistory = true;
                continue;
            }

            if (!isPromptEnabled(p, preset!.prompt_order)) continue;

            const gcTags = getPromptTags(p);
            if (gcTags && !gcTags.every(t => activeTags.includes(t))) continue;

            if (p.marker) {
                // Skip markers (handled in <member> blocks or at group level)
                continue;
            }

            let content = groupEngine.expand(p.content);
            content = postProcessTrim(content).trim();
            if (!content) continue;

            const role = normalizeRole(p.role);

            if ((p.injection_position ?? 0) === 0) {
                if (afterChatHistory) {
                    blocks.push({
                        text: content,
                        role,
                        depth: 0,
                        order: 10 + afterOrderIdx++,
                        marker: p.name || p.identifier,
                    });
                } else {
                    blocks.push({
                        text: content,
                        role,
                        depth: beforeHistoryDepth,
                        order: orderIdx++,
                        marker: p.name || p.identifier,
                    });
                }
            } else {
                // ABSOLUTE: inject at specific chat depth
                blocks.push({
                    text: content,
                    role,
                    depth: p.injection_depth ?? 0,
                    order: promptIndex,
                    marker: p.name || p.identifier,
                });
            }
        }
    }

    const useChronologicalShortTerm = Boolean(unifiedRecentItems && unifiedRecentItems.length > 0);
    // shortTermMemory/chatHistory 标记条目被关闭时，跳过聊天历史与短期记忆注入
    const groupHistoryMarkerPrompt = preset
        ? preset.prompts.find(p => p.marker && (p.identifier === "shortTermMemory" || p.identifier === "chatHistory"))
        : undefined;
    // 条目存在且开启才注入；条目被关闭或预设中没有该条目都不注入（没有就没有）。
    // 仅在完全未选择预设时保持注入兜底。
    const historyInjectionEnabled = !preset
        || (groupHistoryMarkerPrompt ? isPromptEnabled(groupHistoryMarkerPrompt, preset.prompt_order) : false);

    // 4. Short-term memory / chat history
    if (!historyInjectionEnabled) {
        // 历史注入被关闭：不输出 <shortTermMemory>、近期动态与聊天记录
    } else if (useChronologicalShortTerm) {
        pushGroupChronologicalShortTermBlocks({
            blocks,
            items: unifiedRecentItems!,
            history,
            timeAware,
            timestampOptions: groupPromptTimestampOptions,
            visionEnabled: input.enableVision === true,
            nativeToolHistory: input.nativeToolHistory === true,
        });
    } else {
        const rb = recentBlocks ?? [];
        const lastBlock = rb.length > 0 ? rb[rb.length - 1] : null;
        const historyWrapperTag = lastBlock && !lastBlock.content ? lastBlock.tag : null;

        blocks.push({
            text: "<shortTermMemory>",
            role: "system",
            depth: history.length + 1,
            order: 999,
            marker: "shortTermMemory-open",
        });

        let blockOrder = 1001;
        for (const b of rb) {
            if (b === lastBlock && historyWrapperTag) continue;
            if (!b.content) continue;
            blocks.push({
                text: `<${b.tag}>\n${b.content}\n</${b.tag}>`,
                role: "system",
                depth: history.length + 1,
                order: blockOrder++,
                marker: b.tag,
            });
        }

        if (historyWrapperTag && history.length > 0) {
            blocks.push({
                text: `<${historyWrapperTag}>`,
                role: "system",
                depth: history.length + 1,
                order: blockOrder++,
                marker: `${historyWrapperTag}-open`,
            });
            blocks.push({
                text: `</${historyWrapperTag}>`,
                role: "system",
                depth: 1,
                order: 1000,
                marker: `${historyWrapperTag}-close`,
            });
        } else if (lastBlock && lastBlock.content) {
            blocks.push({
                text: `<${lastBlock.tag}>\n${lastBlock.content}\n</${lastBlock.tag}>`,
                role: "system",
                depth: history.length + 1,
                order: blockOrder++,
                marker: lastBlock.tag,
            });
        }

        blocks.push({
            text: "</shortTermMemory>",
            role: "system",
            depth: 1,
            order: Number.MAX_SAFE_INTEGER,
            marker: "shortTermMemory-close",
        });

        // 6. Chat history (with [SenderName]: prefix already applied)
        const historyLen = history.length;
        const groupVisionEnabled = input.enableVision === true;
        const nativeResultIds = new Set(history
            .map(msg => msg.nativeToolResult?.toolCallId)
            .filter((id): id is string => Boolean(id)));
        const includedToolCallIds = new Set<string>();
        let prevTs = "";
        let prevRole = "";
        history.forEach((msg, idx) => {
            const distFromBottom = historyLen - idx;
            if (input.nativeToolHistory && pushNativeToolHistoryBlock({
                blocks,
                msg,
                nativeResultIds,
                includedToolCallIds,
                depth: distFromBottom,
                order: 999,
                marker: `History [${distFromBottom}]`,
            })) {
                prevTs = (timeAware && msg.createdAt) ? formatChatTimestamp(msg.createdAt, groupPromptTimestampOptions) : "";
                prevRole = msg.role;
                return;
            }
            if (msg.mediaType === "tool_notice"
                || isNativeToolResultMessage(msg)) return;
            const promptRole = resolveHistoryPromptRole(msg);
            const ts = (timeAware && msg.createdAt) ? formatChatTimestamp(msg.createdAt, groupPromptTimestampOptions) : "";
            const showTs = ts && !(ts === prevTs && promptRole === prevRole);
            prevTs = ts;
            prevRole = promptRole;
            let body = msg.content; // Already annotated with [SenderName]: prefix
            let imageUrl: string | undefined;

            const visionImageUrl = groupVisionEnabled ? getPromptVisionImageUrl(msg) : undefined;
            if (visionImageUrl) {
                body = formatAnnotatedVisionBody(msg, body);
                imageUrl = visionImageUrl;
            }

            const isAssistantImage = imageUrl && msg.role === "assistant" && msg.mediaType === "media_file";
            const text = isAssistantImage
                ? formatAssistantImageHistoryText(msg, body, Boolean(showTs), ts)
                : (showTs ? `${ts}\n${body}` : body);

            blocks.push({
                text,
                role: isAssistantImage ? "user" : promptRole,
                depth: distFromBottom,
                order: 999,
                marker: `History [${distFromBottom}]`,
                fromHistory: true,
                imageUrl,
            });
        });
    }

    // Sort: depth descending, then order ascending
    blocks.sort((a, b) => {
        if (b.depth !== a.depth) return b.depth - a.depth;
        return a.order - b.order;
    });

    // Aggregate into final LLM messages
    const finalPayload: LLMMessage[] = [];
    blocks.forEach(b => {
        const inputCtx: RegexContext = b.fromHistory
            ? { depth: b.depth, activeTags }
            : { activeTags };
        const processedText = b.role === "tool" ? b.text : applyInputRegex(b.text, regexes, inputCtx);
        const carriesNativeToolData = b.role === "tool" || Boolean(b.toolCalls?.length);

        const canMerge = b.fromHistory && finalPayload.length > 0 &&
            finalPayload[finalPayload.length - 1].role === b.role &&
            finalPayload[finalPayload.length - 1]._debugMeta?._fromHistory === true &&
            !carriesNativeToolData &&
            !finalPayload[finalPayload.length - 1].toolCalls?.length &&
            finalPayload[finalPayload.length - 1].role !== "tool";

        if (b.imageUrl) {
            // Vision message: build multi-part content with image (never merged)
            const parts: LLMContentPart[] = [];
            if (processedText) parts.push({ type: "text", text: processedText });
            parts.push({ type: "image_url", image_url: { url: b.imageUrl, detail: "low" } });
            finalPayload.push({
                role: b.role,
                content: parts,
                reasoning: b.reasoning,
                openRouterReasoningDetails: b.openRouterReasoningDetails,
                toolCalls: b.toolCalls,
                toolCallId: b.toolCallId,
                name: b.toolName,
                _debugMeta: { marker: b.marker, depth: b.depth, order: b.order, _fromHistory: b.fromHistory },
            });
        } else if (canMerge && typeof finalPayload[finalPayload.length - 1].content === "string") {
            (finalPayload[finalPayload.length - 1].content as string) += "\n\n" + processedText;
            finalPayload[finalPayload.length - 1]._debugMeta = {
                ...finalPayload[finalPayload.length - 1]._debugMeta,
                marker: mergeMarkerText(finalPayload[finalPayload.length - 1]._debugMeta?.marker, b.marker),
            };
        } else {
            finalPayload.push({
                role: b.role,
                content: processedText,
                reasoning: b.reasoning,
                openRouterReasoningDetails: b.openRouterReasoningDetails,
                toolCalls: b.toolCalls,
                toolCallId: b.toolCallId,
                name: b.toolName,
                _debugMeta: { marker: b.marker, depth: b.depth, order: b.order, _fromHistory: b.fromHistory },
            });
        }
    });

    // --- Post-process: merge any remaining consecutive same-role messages ---
    for (let i = finalPayload.length - 1; i > 0; i--) {
        const cur = finalPayload[i];
        const prev = finalPayload[i - 1];
        const canMerge = cur.role === prev.role
            && cur.role !== "tool"
            && !cur.toolCalls?.length
            && !prev.toolCalls?.length
            && typeof cur.content === "string"
            && typeof prev.content === "string";
        if (canMerge) {
            prev.content = prev.content + "\n\n" + cur.content;
            prev._debugMeta = {
                ...prev._debugMeta,
                marker: mergeMarkerText(prev._debugMeta?.marker, cur._debugMeta?.marker),
            };
            finalPayload.splice(i, 1);
        }
    }

    return finalPayload;
}


export function applyOutputRegex(text: string, regexGroups: RegexConfig[], ctx?: RegexContext): string {
    return applyRegex(text, regexGroups, 2, ctx);
}

export function applyDisplayRegex(text: string, regexGroups: RegexConfig[], placement: 1 | 2 | 5 | 6 = 2, ctx?: RegexContext): string {
    return applyRegex(text, regexGroups, placement, { ...ctx, isMarkdown: true });
}

/**
 * Apply ALL output regex rules (both normal + markdownOnly).
 * Used by story mode which always re-renders from raw content and needs every output rule to fire.
 * Only skips promptOnly and disabled rules.
 */
export function applyAllOutputRegex(text: string, regexGroups: RegexConfig[], ctx?: RegexContext): string {
    let result = text;
    for (const group of regexGroups) {
        for (const rule of group.rules) {
            if (rule.disabled) continue;
            if (!rule.placement?.includes(2)) continue;
            if (rule.promptOnly) continue;
            if (!matchesActiveTags(rule.tags, ctx?.activeTags ?? [])) continue;
            try {
                result = runRegexRule(rule, result, ctx?.macroEngine);
            } catch {
                // Ignore bad regex rules safely
            }
        }
    }
    return result;
}

/** Apply placement=6 (Reasoning/Think) regex rules. */
export function applyReasoningRegex(text: string, regexGroups: RegexConfig[], ctx?: RegexContext): string {
    return applyRegex(text, regexGroups, 6, ctx);
}

/**
 * Apply ALL placement=6 (Reasoning) regex rules, bypassing markdownOnly/promptOnly filters.
 * Used by story mode which re-renders from raw and needs every reasoning rule to fire.
 */
export function applyAllReasoningRegex(text: string, regexGroups: RegexConfig[], ctx?: RegexContext): string {
    let result = text;
    for (const group of regexGroups) {
        for (const rule of group.rules) {
            if (rule.disabled) continue;
            if (!rule.placement?.includes(6)) continue;
            if (rule.promptOnly) continue;
            if (!matchesActiveTags(rule.tags, ctx?.activeTags ?? [])) continue;
            try {
                result = runRegexRule(rule, result, ctx?.macroEngine);
            } catch {
                // Ignore bad regex rules safely
            }
        }
    }
    return result;
}

/**
 * Apply output regex with isEdit=true context.
 * Only runOnEdit=true rules fire when a user edits a message.
 * The result replaces the stored rawContent.
 */
export function applyEditOutputRegex(text: string, regexGroups: RegexConfig[], ctx?: RegexContext): string {
    return applyEditRegex(text, regexGroups, 2, ctx);
}

export function applyEditRegex(text: string, regexGroups: RegexConfig[], placement: 1 | 2 | 5 | 6 = 2, ctx?: RegexContext): string {
    return applyRegex(text, regexGroups, placement, { ...ctx, isEdit: true });
}
