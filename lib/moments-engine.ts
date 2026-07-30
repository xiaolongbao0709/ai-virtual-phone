// lib/moments-engine.ts
// AI generation engine + background service for Moments (朋友圈).
// Handles: AI posting (scheduled), AI commenting, AI liking, memory integration.
// Prompts are assembled through the shared assemblePromptPayload() pipeline,
// ensuring full character settings, world books, long-term memory, and user persona.

import { loadCharacters } from "./character-storage";
import { loadChatContacts } from "./chat-storage";
import type { Character } from "./character-types";
import {
    addMomentPost,
    addMomentComment,
    findRecentDuplicateMomentPost,
    toggleMomentLike,
    loadMomentPosts,
    saveMomentPosts,
    loadMomentComments,
    getOrCreateSchedule,
    updateScheduleAfterPost,
    loadAIMomentSchedule,
    saveAIMomentSchedule,
    loadPendingReactions,
    addPendingReaction,
    removePendingReaction,
    loadMomentsConfig,
    updateMomentPost,
} from "./moments-storage";
import type { MomentPost, MomentComment, PendingReaction } from "./moments-types";
import {
    resolveBinding,
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    resolveUserIdentity,
} from "./settings-storage";
import type { PresetConfig, ApiConfig } from "./settings-types";
import { loadMemoryConfig, incrementEventCounter } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { maybeRunSummarization } from "./memory-summarizer";
import { assemblePromptPayload, type LLMMessage, type AssemblerInput } from "./llm-prompt-assembler";
import type { RegexConfig } from "./settings-types";
import { prepareShortTermContext } from "./short-term-assembler";
import { parseActionTags, dispatchActions } from "./action-parser";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { getCustomStickerNames, getCustomStickerExample } from "./custom-sticker-storage";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { bgSetInterval } from "./bg-timer";
import { sendBrowserNotification } from "./browser-notification";
import { buildTwoLevelMomentThreads } from "./moments-comment-threading";
import { DEFAULT_MOMENTS_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";
import { generateImageFromConfiguredApi } from "./image-generation-service";
import { isAbortError, throwIfAborted } from "./abort-utils";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "./chat-asset-storage";
import {
    getVisibleMomentCommentsForCharacter,
    getVisibleMomentLikesForCharacter,
    isMomentCommentVisibleToCharacter,
    isMomentRealCharacterAllowedForPost,
    isMomentRealCharacterAllowedForViewer,
} from "./character-world-storage";

// ── Constants ──


// ── Module state ──

let started = false;
let isGenerating = false;
let cancelReactionPoll: (() => void) | null = null;
const firingSet = new Set<string>();

// ── Public API ──

export function startMomentsService() {
    if (started) return;
    started = true;
    staggerOverduePosts();
    startReactionPoll(); // unified poll handles both reactions AND scheduled posts
}

export function stopMomentsService() {
    stopReactionPoll();
    started = false;
}

// ── Scheduling ──

/** On cold start, stagger overdue posts so they don't all fire at once. */
function staggerOverduePosts() {
    const contacts = loadChatContacts();
    if (contacts.length === 0) return;

    const now = Date.now();
    const allSchedules = loadAIMomentSchedule();
    // Ensure all contacts have a schedule
    for (const c of contacts) getOrCreateSchedule(c.characterId);

    const overdue = allSchedules.filter(s => s.nextPostAfter <= now);
    if (overdue.length > 1) {
        for (let i = 0; i < overdue.length; i++) {
            overdue[i].nextPostAfter = now + (3 + i * 8 + Math.random() * 10) * 60 * 1000;
        }
        saveAIMomentSchedule(allSchedules);
    }
}

/** Called by pollPendingReactions every 5s — check if any post is due. */
function pollScheduledPosts() {
    if (isGenerating) return;
    const now = Date.now();
    const contacts = loadChatContacts();
    // 用户关掉自动发帖的角色：跳过调度（评论/点赞/手动立即发帖不受此开关影响）
    const disabledIds = new Set(loadMomentsConfig().autoPostDisabledCharacterIds);
    for (const contact of contacts) {
        if (disabledIds.has(contact.characterId)) continue;
        const schedule = getOrCreateSchedule(contact.characterId);
        if (schedule.nextPostAfter <= now) {
            isGenerating = true;
            triggerAIPost(contact.characterId)
                .catch(err => console.error("[Moments] AI post error:", err))
                .finally(() => { isGenerating = false; });
            return; // one at a time
        }
    }
}

/** Queue of character IDs waiting for immediate post. Processed by the engine independently of UI. */
const immediatePostQueue: string[] = [];
let immediatePostRunning = false;

async function processImmediatePostQueue() {
    if (immediatePostRunning) return;
    immediatePostRunning = true;
    while (immediatePostQueue.length > 0) {
        const id = immediatePostQueue.shift()!;
        isGenerating = true;
        try {
            await triggerAIPost(id);
        } catch (err) {
            console.error("[Moments] Immediate post error:", err);
        } finally {
            isGenerating = false;
        }
    }
    immediatePostRunning = false;
    // Notify UI globally
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("moments-immediate-post-done"));
        window.dispatchEvent(new CustomEvent("global-notice", { detail: "朋友圈发帖完成" }));
    }
}

/** Trigger immediate posts for one or more characters. Runs in background, survives UI unmount. */
export function triggerImmediatePost(characterIds: string | string[]): void {
    const ids = Array.isArray(characterIds) ? characterIds : [characterIds];
    immediatePostQueue.push(...ids);
    processImmediatePostQueue();
}

// ── Assembler Input Resolution ──

type AssemblerResult = {
    input: AssemblerInput;
    apiConfig: ApiConfig | null;
    preset: PresetConfig | null;
    character: Character;
};

function buildMomentsBilingualInstruction(enabled: boolean, customPrompt?: string): string {
    return resolveBilingualPrompt(enabled, customPrompt, DEFAULT_MOMENTS_BILINGUAL_PROMPT);
}

/**
 * Resolve all inputs needed for assemblePromptPayload(), following the same
 * Binding follows the "chat" slot directly — moments shares chat's config.
 */
async function resolveAssemblerInput(
    characterId: string,
    task: "post" | "comment" | "npc" | "npc_reply" | "reply"
): Promise<AssemblerResult | null> {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === characterId);
    if (!character) return null;

    // 1. Resolve binding: use moments slot (falls back to global defaults if no override)
    const bindings = loadBindingConfig();
    const activeSlot = resolveBinding(bindings, characterId, "moments");

    // 2. Load API config
    let apiConfig: ApiConfig | null = null;
    if (activeSlot.apiConfigId) {
        const apiConfigs = loadApiConfigs();
        apiConfig = apiConfigs.find(c => c.id === activeSlot.apiConfigId) ?? null;
    }

    // 3. Load preset (fallback to built-in)
    const presets = loadPresets();
    let preset = activeSlot.presetId ? presets.find(p => p.id === activeSlot.presetId) ?? null : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? null;

    // 4. Load world books
    const allWorldBooks = loadWorldBooks();
    const worldBooks = (activeSlot.worldBookIds || [])
        .map(id => allWorldBooks.find(w => w.id === id))
        .filter(Boolean) as typeof allWorldBooks;

    // 5. Load regexes
    const allRegexes = loadRegexes();
    const regexes = (activeSlot.regexIds || [])
        .map(id => allRegexes.find(r => r.id === id))
        .filter(Boolean) as typeof allRegexes;

    // 6. Resolve user identity via binding cascade
    const userIdentity = resolveUserIdentity(characterId, "chat");

    // 7. Load long-term memories (NPC doesn't share the character's memory)
    let coreMemories = "";
    let longTermMemories = "";
    const memConfig = loadMemoryConfig();
    if (task !== "npc") {
        try {
            const coreResultsPromise = retrieveCoreMemoriesForPrompt(characterId, memConfig);
            // Use native timeline as retrieval context (same cross-app data as short-term memory)
            const { wbActivationContext: recentCtx } = prepareShortTermContext(characterId, "moments");
            const [coreResults, results] = await Promise.all([
                coreResultsPromise,
                recentCtx.trim()
                    ? retrieveMemoriesForPrompt(characterId, recentCtx, memConfig)
                    : Promise.resolve([]),
            ]);
                coreMemories = formatCoreMemories(coreResults);
            longTermMemories = formatLongTermMemories(results);
        } catch (err) {
            console.warn("[Moments] Memory retrieval failed:", err);
        }
    }

    // 8. Determine appTags based on task type (tag-based filtering replaces prompt_order cloning)
    const taskTagMap: Record<string, string[]> = {
        post: ["moments", "post"],
        comment: ["moments", "comment"],
        reply: ["moments", "reply"],
        npc: ["moments", "npc"],
        npc_reply: ["moments", "npc_reply"],
    };
    const appTags = taskTagMap[task] ?? ["moments"];
    const momentsConfig = loadMomentsConfig();
    const chatBilingualInstruction = buildMomentsBilingualInstruction(
        momentsConfig.bilingualTranslationEnabled === true,
        momentsConfig.bilingualTranslationPrompt,
    );

    // 9. Build AssemblerInput — unified short-term context
    const isNPC = task === "npc" || task === "npc_reply";
    const { recentBlocks, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "moments");

    // Calendar schedule (NPC doesn't get character's schedule)
    const scheduleSummary = isNPC ? undefined : buildCalendarScheduleMarker("character", characterId, getWeekStartIso(new Date()));

    const input: AssemblerInput = {
        character,
        history: [],
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "moments",
        appTags,
        coreMemories,
        longTermMemories,
        scheduleSummary,
        worldBookActivationContext: wbActivationContext,
        activateAllWorldBooks: false,
        chatBilingualInstruction,
        recentBlocks,
        unifiedRecentItems,
        customStickerNames: getCustomStickerNames(characterId),
        customStickerExample: getCustomStickerExample(characterId),
    };

    return { input, apiConfig, preset, character };
}

// ── AI Post Generation ──

async function triggerAIPost(characterId: string): Promise<void> {
    isGenerating = true;
    // Always update schedule first to prevent retry storms on failure
    updateScheduleAfterPost(characterId);
    try {
        const resolved = await resolveAssemblerInput(characterId, "post");
        if (!resolved) return;

        const { input, apiConfig, preset, character } = resolved;
        if (!apiConfig) {
            console.warn("[Moments] No API config for", character.name);
            return;
        }

        // Assemble prompt via shared pipeline
        const llmMessages = assemblePromptPayload(input);

        // Append trigger instruction
        llmMessages.push({
            role: "user",
            content: "请发一条朋友圈。",
            _debugMeta: { marker: "moments_trigger" },
        });

        const responseText = await callLLM(
            apiConfig,
            preset,
            llmMessages,
            character.name,
            input.regexes,
            input.appTags,
            input.userIdentity?.name,
        );
        if (!responseText) return;

        // Extract cross-engine actions before moments-specific parsing
        const { cleanText: postText, actions } = parseActionTags(responseText);
        if (actions.length > 0) {
            dispatchActions(actions, { characterId, sourceEngine: "moments" })
                .catch(err => console.warn("[Moments] Action dispatch failed:", err));
        }

        const parsed = parseMomentPostResponse(postText);
        if (!parsed) return;

        // 内容去重：生图前先判重，命中直接丢弃（防止同一内容经多路径重复入库）
        if (findRecentDuplicateMomentPost({
            authorType: "character",
            authorId: characterId,
            content: parsed.content,
            photoDescription: parsed.photoDescription,
        })) {
            console.warn(`[Moments] SKIP duplicate AI post from ${character.name}`);
            return;
        }

        const contacts = loadChatContacts();
        const visibility = contacts.map(c => c.characterId);

        // 先入库再生图：帖子立即可见，生图慢/超时/页面被杀都不会丢帖
        const post = addMomentPost({
            authorType: "character",
            authorId: characterId,
            content: parsed.content,
            photoDescription: parsed.photoDescription,
            photoUseReferenceImage: parsed.photoUseReferenceImage === true,
            photoGenerationStatus: parsed.photoDescription ? "pending" : undefined,
            visibility,
        });
        if (!post) {
            console.warn(`[Moments] SKIP duplicate AI post from ${character.name}`);
            return;
        }

        if (parsed.photoDescription) {
            attachMomentPhotoInBackground(post.id, parsed.photoDescription, characterId, parsed.photoUseReferenceImage === true);
        }

        // Increment event counter for auto-summarization (native data read at summarization time)
        incrementEventCounter(characterId);
        maybeRunSummarization(characterId, character.name)
            .catch(err => console.warn("[Moments] Summarization check failed:", err));

        dispatchMomentsUpdated();
        // Character's post → NPC reactions (not other main characters)
        generateNPCReactions(post, character);

    } finally {
        isGenerating = false;
    }
}

/** Called when user publishes a post — trigger AI reactions. */
export function onUserPost(post: MomentPost): void {
    triggerAIReactionsForPost(post, "user");
}

// ── NPC Reactions (for character posts) ──

function generateNPCReactions(
    post: MomentPost,
    _character: Character,
): void {
    // Persist task to localStorage — survives refresh.
    const cfg = loadMomentsConfig();
    const delay = (cfg.npcReactionDelayMin + Math.random() * cfg.npcReactionDelayMin) * 60 * 1000;
    addPendingReaction({
        type: "npc_reaction",
        postId: post.id,
        characterId: _character.id,
        fireAt: Date.now() + delay,
    });
}

/** Build the LLM messages for NPC reactions using full prompt assembly pipeline. */
async function buildNPCReactionMessages(
    post: MomentPost,
    character: Character,
): Promise<{ messages: LLMMessage[]; apiConfig: ApiConfig | null; preset: PresetConfig | null; regexes: RegexConfig[]; appTags?: string[]; userName?: string } | null> {
    const resolved = await resolveAssemblerInput(character.id, "npc");
    if (!resolved) return null;

    const { input, apiConfig, preset } = resolved;

    // Assemble via shared pipeline (full world book + character context)
    const llmMessages = assemblePromptPayload(input);

    llmMessages.push(await buildMomentSnapshotMessage(post, character.id, apiConfig, "npc_reaction_post"));

    return {
        messages: llmMessages,
        apiConfig,
        preset,
        regexes: input.regexes,
        appTags: input.appTags,
        userName: input.userIdentity?.name,
    };
}

async function callLLM(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
    characterName: string,
    regexes?: RegexConfig[],
    appTags?: string[],
    userName?: string,
): Promise<string | null> {
    try {
        return await sendLLMRequest(
            config,
            preset,
            messages,
            regexes ?? [],
            { characterName, userName },
            { appId: "moments", appTags },
        );
    } catch (err) {
        console.warn(`[Moments] LLM call failed for ${characterName}:`, err);
        return null;
    }
}

/** Single LLM call to generate both NPC comments and NPC likes for a character's post. */
async function generateNPCReactionsViaLLM(
    post: MomentPost,
    character: Character,
): Promise<void> {
    const result = await buildNPCReactionMessages(post, character);
    if (!result) return;

    const { messages, apiConfig, preset, regexes, appTags, userName } = result;
    if (!apiConfig) return;

    const responseText = await callLLM(apiConfig, preset, messages, `NPC-for-${character.name}`, regexes, appTags, userName);
    if (!responseText) return;

    const chars = loadCharacters();
    const userDisplayName = getUserName(character.id);
    const findCharacterByName = (name: string) => {
        const normalized = normalizeIdentityName(name);
        if (!normalized) return undefined;
        return chars.find(c => normalizeIdentityName(c.name) === normalized);
    };
    const resolveGeneratedMomentActor = (name: string, npcIdPrefix: string) => {
        const matchedCharacter = findCharacterByName(name);
        if (matchedCharacter) {
            return {
                actor: {
                    authorType: "character" as const,
                    authorId: matchedCharacter.id,
                },
                displayName: matchedCharacter.name,
            };
        }
        return {
            actor: {
                authorType: "npc" as const,
                authorId: `${npcIdPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                authorName: name,
            },
            displayName: name,
        };
    };
    const hasSameLike = (likes: MomentPost["likes"], actor: ReturnType<typeof resolveGeneratedMomentActor>["actor"]): boolean => (
        likes.some(like => {
            if (actor.authorType === "character") {
                return like.authorType === "character" && like.authorId === actor.authorId;
            }
            return like.authorType === "npc"
                && normalizeIdentityName(like.authorName || "") === normalizeIdentityName(actor.authorName);
        })
    );
    const isGeneratedActorAllowed = (actor: ReturnType<typeof resolveGeneratedMomentActor>["actor"]): boolean => {
        if (actor.authorType !== "character") return true;
        if (post.authorType === "character" && actor.authorId === post.authorId) {
            console.warn("[Moments] Skipping NPC-generated reaction by the post author character.");
            return false;
        }
        return isMomentRealCharacterAllowedForPost(post, actor.authorId, character.id);
    };

    // Parse NPC likes
    const likeMatch = responseText.match(/\[NPC点赞\]\s*([\s\S]*?)\s*\[\/NPC点赞\]/);
    if (likeMatch) {
        const likeNames = likeMatch[1].split(/[,，]/).map(n => n.trim()).filter(Boolean);
        const posts = loadMomentPosts();
        const p = posts.find(pp => pp.id === post.id);
        if (p) {
            for (const name of likeNames) {
                const { actor } = resolveGeneratedMomentActor(name, "npc_like");
                if (!isGeneratedActorAllowed(actor)) continue;
                if (hasSameLike(p.likes, actor)) continue;
                p.likes.push({
                    ...actor,
                    createdAt: new Date().toISOString(),
                });
            }
            saveMomentPosts(posts);
        }
    }

    // Parse NPC comments (supports "昵称: 内容" and "昵称 回复 被回复者: 内容")
    const commentMatch = responseText.match(/\[NPC评论\]\s*([\s\S]*?)\s*\[\/NPC评论\]/);
    const commentBlock = commentMatch ? commentMatch[1] : "";

    const npcCommentsCreated: MomentComment[] = [];

    if (commentBlock) {
        // Collect all NPC comment IDs created in this batch for cross-referencing replies
        const npcNameToCommentId = new Map<string, string>();
        const characterReplyTargetNames = new Set<string>();
        // Also map existing comment authors for reply resolution
        const existingComments = getVisibleMomentCommentsForCharacter(post, character.id, loadMomentComments(post.id));
        for (const ec of existingComments) {
            const ecName = ec.authorType === "user"
                ? userDisplayName
                : ec.authorType === "npc"
                    ? (ec.authorName || "")
                    : (chars.find(ch => ch.id === ec.authorId)?.name ?? "");
            if (ecName && !(ec.authorType === "npc" && normalizeIdentityName(ecName) === normalizeIdentityName(userDisplayName))) {
                npcNameToCommentId.set(ecName, ec.id);
            }
            if (ec.authorType === "character" && ecName) characterReplyTargetNames.add(ecName);
        }
        // Also map the post author's character name
        const postCharName = chars.find(c => c.id === post.authorId)?.name;
        if (postCharName) {
            if (!npcNameToCommentId.has(postCharName)) npcNameToCommentId.set(postCharName, "");
            characterReplyTargetNames.add(postCharName);
        }
        const resolveNpcReplyTarget = (replyToName: string): {
            replyToCommentId?: string;
            replyToAuthorId: string;
            replyToAuthorType: "user" | "character" | "npc";
            replyToAuthorName: string;
        } | null => {
            const targetName = replyToName.trim();
            if (!targetName) return null;
            const replyToCommentId = npcNameToCommentId.get(targetName) || undefined;
            if (normalizeIdentityName(targetName) === normalizeIdentityName(userDisplayName)) {
                if (!replyToCommentId) {
                    console.warn(`[Moments] Skipping NPC reply to user without existing target: "${targetName}"`);
                    return null;
                }
                return {
                    replyToCommentId,
                    replyToAuthorId: "user",
                    replyToAuthorType: "user",
                    replyToAuthorName: targetName,
                };
            }
            const replyChar = findCharacterByName(targetName);
            if (replyChar) {
                if (post.authorType === "character" && replyChar.id === post.authorId) {
                    console.warn(`[Moments] Skipping NPC reply to post author character: "${targetName}"`);
                    return null;
                }
                if (!isMomentRealCharacterAllowedForPost(post, replyChar.id, character.id)) {
                    console.warn(`[Moments] Pruned NPC reply to cross-world character: "${targetName}"`);
                    return null;
                }
                if (!characterReplyTargetNames.has(targetName)) {
                    console.warn(`[Moments] Skipping NPC reply to real character without existing target: "${targetName}"`);
                    return null;
                }
                return {
                    replyToCommentId,
                    replyToAuthorId: replyChar.id,
                    replyToAuthorType: "character",
                    replyToAuthorName: targetName,
                };
            }
            if (!replyToCommentId) {
                console.warn(`[Moments] Skipping NPC reply to non-existent commenter: "${targetName}"`);
                return null;
            }
            return {
                replyToCommentId,
                replyToAuthorId: targetName,
                replyToAuthorType: "npc",
                replyToAuthorName: targetName,
            };
        };

        const lines = commentBlock.split("\n").map(l => l.trim()).filter(Boolean);
        const npcCommentBatchStart = Date.now();
        let npcCommentBatchOffset = 0;
        const nextNpcCommentCreatedAt = () => new Date(npcCommentBatchStart + npcCommentBatchOffset++).toISOString();
        for (const line of lines) {
            // Try "昵称 回复 被回复者: 内容" format first
            const replyMatch = line.match(/^(.+?)\s+回复\s+(.+?)\s*[:：]\s*(.+)$/);
            if (replyMatch) {
                const name = replyMatch[1].trim();
                const replyToName = replyMatch[2].trim();
                const content = replyMatch[3].trim();
                if (!name || !content) continue;
                const { actor, displayName } = resolveGeneratedMomentActor(name, "npc");
                if (!isGeneratedActorAllowed(actor)) continue;

                const replyTarget = resolveNpcReplyTarget(replyToName);
                if (!replyTarget) continue;

                const newComment = addMomentComment({
                    postId: post.id,
                    ...actor,
                    content,
                    createdAt: nextNpcCommentCreatedAt(),
                    ...replyTarget,
                });
                npcCommentsCreated.push(newComment);
                npcNameToCommentId.set(name, newComment.id);
                npcNameToCommentId.set(displayName, newComment.id);
                if (actor.authorType === "character") characterReplyTargetNames.add(displayName);
                continue;
            }

            // Standard "昵称: 内容" format
            const colonIdx = line.indexOf(":");
            const colonIdx2 = line.indexOf("：");
            const idx = colonIdx >= 0 && colonIdx2 >= 0
                ? Math.min(colonIdx, colonIdx2)
                : Math.max(colonIdx, colonIdx2);

            if (idx <= 0) continue;

            const name = line.slice(0, idx).trim();
            let content = line.slice(idx + 1).trim();
            if (!name || !content) continue;
            const { actor, displayName } = resolveGeneratedMomentActor(name, "npc");
            if (!isGeneratedActorAllowed(actor)) continue;

            // Check for inline [回复 xxx] tag
            let inlineReplyName: string | undefined;
            const inlineMatch = content.match(/\[回复\s+(.+?)\]\s*/);
            if (inlineMatch) {
                inlineReplyName = inlineMatch[1].trim();
                content = content.replace(inlineMatch[0], "").replace(/\[\/回复[）)\]]*\]?/g, "").trim();
            }

            // Build reply fields if [回复 xxx] was found
            const replyFields: Record<string, unknown> = {};
            if (inlineReplyName) {
                const replyTarget = resolveNpcReplyTarget(inlineReplyName);
                if (!replyTarget) continue;
                Object.assign(replyFields, replyTarget);
            }

            const newComment = addMomentComment({
                postId: post.id,
                ...actor,
                content,
                createdAt: nextNpcCommentCreatedAt(),
                ...replyFields,
            } as Parameters<typeof addMomentComment>[0]);
            npcCommentsCreated.push(newComment);
            npcNameToCommentId.set(name, newComment.id);
            npcNameToCommentId.set(displayName, newComment.id);
            if (actor.authorType === "character") characterReplyTargetNames.add(displayName);
        }
    }

    dispatchMomentsUpdated();

    // Trigger character reply if NPC comments were added
    if (npcCommentsCreated.length > 0) {
        triggerCharacterReplyIfNeeded(post, npcCommentsCreated);
    }
}

// ── AI Reactions (for user posts) ──

function triggerAIReactionsForPost(post: MomentPost, excludeAuthorId: string): void {
    const chars = loadCharacters();
    const contacts = loadChatContacts();

    const visibleChars = contacts
        .filter(c => post.visibility.includes(c.characterId) && c.characterId !== excludeAuthorId)
        .map(c => ({
            contact: c,
            char: chars.find(ch => ch.id === c.characterId),
        }))
        .filter(c => c.char) as { contact: typeof contacts[0]; char: Character }[];

    // Collect who will comment
    const cfg = loadMomentsConfig();
    const commenters: Character[] = [];
    for (const { char } of visibleChars) {
        if (Math.random() < cfg.commentProb) {
            commenters.push(char);
        }
    }

    // Persist tasks to localStorage — survives refresh.
    if (commenters.length > 0) {
        let fireAt = Date.now() + (cfg.firstCommentDelaySec + Math.random() * cfg.firstCommentDelaySec) * 1000;
        for (const char of commenters) {
            addPendingReaction({
                type: "ai_comment",
                postId: post.id,
                characterId: char.id,
                fireAt,
            });
            fireAt += (cfg.commentGapSec + Math.random() * cfg.commentGapSec * 2) * 1000;
        }
    }
}

async function generateAIComment(post: MomentPost, character: Character): Promise<boolean> {
    const resolved = await resolveAssemblerInput(character.id, "comment");
    if (!resolved) return false;

    const { input, apiConfig, preset } = resolved;
    if (!apiConfig) return false;

    // Assemble prompt via shared pipeline
    const llmMessages = assemblePromptPayload(input);

    llmMessages.push(await buildMomentSnapshotMessage(post, character.id, apiConfig, "moments_post_data"));

    const responseText = await callLLM(
        apiConfig,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return false;

    // Extract cross-engine actions before comment-specific parsing
    const { cleanText: commentText, actions } = parseActionTags(responseText);
    if (actions.length > 0) {
        dispatchActions(actions, { characterId: character.id, sourceEngine: "moments" })
            .catch(err => console.warn("[Moments] Action dispatch failed:", err));
    }

    const cleaned = commentText
        .replace(/\[评论\]|\[\/评论\]/g, "")
        .replace(/^["\s]+|["\s]+$/g, "")
        .trim();

    if (!cleaned) return false;

    const userName = getUserName(character.id);
    const chars = loadCharacters();
    const existingComments = getVisibleMomentCommentsForCharacter(post, character.id, loadMomentComments(post.id));

    // Check if the AI wants to reply to a specific commenter: [回复 昵称] 内容
    const replyMatch = /^\[回复\s*(.+?)\]\s*(.+)/s.exec(cleaned);
    if (replyMatch) {
        const replyToName = replyMatch[1].trim();
        const replyContent = replyMatch[2].replace(/\[\/回复[）)\]]*\]?/g, "").trim();
        if (replyContent) {
            let replyToAuthorType: "user" | "character" | "npc" = "npc";
            let replyToAuthorId = replyToName;
            let replyToCommentId: string | undefined;

            if (replyToName === userName) {
                replyToAuthorType = "user";
                replyToAuthorId = "user";
            } else {
                const replyChar = chars.find(c => c.name === replyToName);
                if (replyChar) {
                    if (!isMomentRealCharacterAllowedForViewer(character.id, replyChar.id)) {
                        console.warn(`[Moments] Skipping AI comment reply to cross-world character: "${replyToName}"`);
                        return false;
                    }
                    replyToAuthorType = "character";
                    replyToAuthorId = replyChar.id;
                }
            }

            // Find the latest comment by this person
            const latestByTarget = existingComments
                .slice()
                .reverse()
                .find(c => {
                    const cName = c.authorType === "user"
                        ? userName
                        : c.authorType === "npc"
                            ? c.authorName!
                            : (chars.find(ch => ch.id === c.authorId)?.name ?? "");
                    return cName === replyToName;
                });
            if (latestByTarget) {
                replyToCommentId = latestByTarget.id;
            }

            addMomentComment({
                postId: post.id,
                authorType: "character",
                authorId: character.id,
                content: replyContent,
                replyToCommentId,
                replyToAuthorId,
                replyToAuthorType,
                replyToAuthorName: replyToName,
            });
        } else {
            return false;
        }
    } else {
        addMomentComment({
            postId: post.id,
            authorType: "character",
            authorId: character.id,
            content: cleaned,
        });
    }

    // Increment event counter for auto-summarization (native data read at summarization time)
    incrementEventCounter(character.id);
    maybeRunSummarization(character.id, character.name)
        .catch(err => console.warn("[Moments] Summarization check failed:", err));

    dispatchMomentsUpdated();
    return true;
}

async function generateTargetedNPCReply(
    post: MomentPost,
    character: Character,
    triggeringComment: MomentComment,
    targetNpcName: string,
): Promise<boolean> {
    const resolved = await resolveAssemblerInput(character.id, "npc_reply");
    if (!resolved) return false;

    const { input, apiConfig, preset } = resolved;
    if (!apiConfig) return false;

    const llmMessages = assemblePromptPayload(input);
    llmMessages.push(await buildMomentSnapshotMessage(post, character.id, apiConfig, "moments_npc_reply_data", {
        triggeringCommentIds: [triggeringComment.id],
        prefixLines: [
            `当前扮演的NPC：${targetNpcName}`,
            "以下是这条朋友圈当前在界面上的完整样子。你只需要判断这个NPC是否要回复“本次新互动”里直接回复自己的那条内容。",
            "",
        ],
    }));

    const responseText = await callLLM(
        apiConfig,
        preset,
        llmMessages,
        `NPCReply-${targetNpcName}`,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return false;

    const { cleanText, actions } = parseActionTags(responseText);
    if (actions.length > 0) {
        dispatchActions(actions, { characterId: character.id, sourceEngine: "moments" })
            .catch(err => console.warn("[Moments] NPC reply action dispatch failed:", err));
    }

    const cleaned = cleanText
        .replace(/^["\s]+|["\s]+$/g, "")
        .trim();

    if (!cleaned || cleaned.includes("[不回复]")) return false;

    const userName = getUserName(character.id);
    addMomentComment({
        postId: post.id,
        authorType: "npc",
        authorId: `npc_reply_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        authorName: targetNpcName,
        content: cleaned,
        replyToCommentId: triggeringComment.id,
        replyToAuthorId: "user",
        replyToAuthorType: "user",
        replyToAuthorName: userName,
    });

    dispatchMomentsUpdated();
    return true;
}

// ── Character Reply Logic ──

const MAX_CHARACTER_REPLIES_PER_POST = 5;

/**
 * Core function: generate a character reply to new comments on a post.
 * Called when the character's post or comment receives a new comment from user/NPC.
 */
async function triggerCharacterReply(
    post: MomentPost,
    characterId: string,
    newComments: MomentComment[],
): Promise<boolean> {
    const visibleNewComments = getVisibleMomentCommentsForCharacter(post, characterId, newComments);
    if (visibleNewComments.length === 0) return false;

    // Check reply cap
    const existingComments = loadMomentComments(post.id);
    const visibleExistingComments = getVisibleMomentCommentsForCharacter(post, characterId, existingComments);
    const charReplyCount = existingComments.filter(
        c => c.authorType === "character" && c.authorId === characterId && c.replyToCommentId
    ).length;
    if (charReplyCount >= MAX_CHARACTER_REPLIES_PER_POST) {
        return false;
    }

    const resolved = await resolveAssemblerInput(characterId, "reply");
    if (!resolved) return false;

    const { input, apiConfig, preset, character } = resolved;
    if (!apiConfig) return false;

    // Assemble prompt via shared pipeline
    const llmMessages = assemblePromptPayload(input);

    llmMessages.push(await buildMomentSnapshotMessage(post, characterId, apiConfig, "moments_reply_data", {
        triggeringCommentIds: visibleNewComments.map(c => c.id),
    }));

    const responseText = await callLLM(
        apiConfig,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return false;

    // Extract cross-engine actions before reply-specific parsing
    const { cleanText: replyText, actions } = parseActionTags(responseText);
    if (actions.length > 0) {
        dispatchActions(actions, { characterId, sourceEngine: "moments" })
            .catch(err => console.warn("[Moments] Action dispatch failed:", err));
    }

    // Parse response
    if (replyText.includes("[不回复]")) {
        return false;
    }

    // Match [回复 "原文"] 内容 or [回复 昵称] 内容
    const replyPattern = /\[回复\s+(.+?)\]\s*(.+?)(?=\[\/回复|\[回复|$)/g;
    let match: RegExpExecArray | null;
    let repliedAny = false;
    let repliedToUser = false;

    while ((match = replyPattern.exec(replyText)) !== null) {
        const replyToName = match[1].trim();
        const content = match[2].replace(/\[\/回复[）)\]]*\]?/g, "").trim();
        if (!content) continue;

        // Resolve replyTo fields
        let replyToAuthorType: "user" | "character" | "npc" = "npc";
        let replyToAuthorId = replyToName;
        let replyToCommentId: string | undefined;

        const userName = getUserName(characterId);
        const chars = loadCharacters();

        if (normalizeIdentityName(replyToName) === normalizeIdentityName(userName)) {
            replyToAuthorType = "user";
            replyToAuthorId = "user";
        } else {
            const replyChar = chars.find(c => c.name === replyToName);
            if (replyChar) {
                if (!isMomentRealCharacterAllowedForViewer(characterId, replyChar.id)) {
                    console.warn(`[Moments] Skipping character reply to cross-world character: "${replyToName}"`);
                    continue;
                }
                replyToAuthorType = "character";
                replyToAuthorId = replyChar.id;
            }
        }

        // Find the latest comment by this person to get replyToCommentId
        const latestByTarget = [...visibleExistingComments, ...visibleNewComments]
            .reverse()
            .find(c => {
                const cName = c.authorType === "user"
                    ? userName
                    : c.authorType === "npc"
                        ? c.authorName!
                        : (chars.find(ch => ch.id === c.authorId)?.name ?? "");
                return cName === replyToName;
            });
        if (latestByTarget) {
            if (replyToAuthorType === "user" && latestByTarget.authorType !== "user") {
                console.warn(`[Moments] Skipping character reply to fake user target: "${replyToName}"`);
                continue;
            }
            replyToCommentId = latestByTarget.id;
        } else if (replyToAuthorType === "user") {
            console.warn(`[Moments] Skipping character reply to user without existing target: "${replyToName}"`);
            continue;
        }

        addMomentComment({
            postId: post.id,
            authorType: "character",
            authorId: characterId,
            content,
            replyToCommentId,
            replyToAuthorId,
            replyToAuthorType,
            replyToAuthorName: replyToName,
        });
        repliedAny = true;
        if (replyToAuthorType === "user") repliedToUser = true;
    }

    if (repliedAny) {
        dispatchMomentsUpdated();

        // Increment event counter for auto-summarization
        incrementEventCounter(characterId);
        maybeRunSummarization(characterId, character.name)
            .catch(err => console.warn("[Moments] Summarization check failed:", err));
    }
    return repliedToUser;
}

/**
 * Determine whether to trigger character reply based on new comments.
 * Only triggers for user/NPC comments (not character, to prevent loops).
 */
function triggerCharacterReplyIfNeeded(
    post: MomentPost,
    newComments: MomentComment[],
): void {
    // Filter: only user/NPC comments trigger replies (character comments don't, to prevent loops)
    const triggeringComments = newComments.filter(c => c.authorType === "user" || c.authorType === "npc");
    if (triggeringComments.length === 0) return;

    const chars = loadCharacters();
    const characterIdsToNotify = new Set<string>();

    // Post author is a character → notify
    if (post.authorType === "character") {
        characterIdsToNotify.add(post.authorId);
    }

    // New comments reply to a character → notify that character
    for (const c of triggeringComments) {
        if (c.replyToAuthorType === "character" && c.replyToAuthorId) {
            characterIdsToNotify.add(c.replyToAuthorId);
        }
    }

    // Persist tasks to localStorage — survives refresh.
    for (const charId of characterIdsToNotify) {
        if (!chars.find(c => c.id === charId)) continue;
        const visibleTriggeringComments = triggeringComments.filter(comment =>
            isMomentCommentVisibleToCharacter(post, comment, charId)
        );
        if (visibleTriggeringComments.length === 0) continue;

        addPendingReaction({
            type: "character_reply",
            postId: post.id,
            characterId: charId,
            fireAt: Date.now() + (loadMomentsConfig().replyDelaySec + Math.random() * loadMomentsConfig().replyDelaySec * 2) * 1000,
            triggeringCommentIds: visibleTriggeringComments.map(c => c.id),
        });
    }
}

function triggerNpcReplyIfNeeded(
    post: MomentPost,
    newComment: MomentComment,
): void {
    if (newComment.authorType !== "user") return;
    if (newComment.replyToAuthorType !== "npc") return;
    if (post.authorType !== "character") return;

    const allComments = loadMomentComments(post.id);
    const parentComment = newComment.replyToCommentId
        ? allComments.find(comment => comment.id === newComment.replyToCommentId)
        : undefined;
    const targetNpcName = parentComment?.authorType === "npc"
        ? parentComment.authorName
        : newComment.replyToAuthorName;
    if (!targetNpcName) return;

    addPendingReaction({
        type: "npc_reply",
        postId: post.id,
        characterId: post.authorId,
        fireAt: Date.now() + (loadMomentsConfig().replyDelaySec + Math.random() * loadMomentsConfig().replyDelaySec * 2) * 1000,
        triggeringCommentIds: [newComment.id],
        targetNpcName,
    });
}

/** Called after user submits a comment — trigger character reply if applicable. */
export function onUserComment(postId: string): void {
    const posts = loadMomentPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return;

    const comments = loadMomentComments(postId);
    const latestComment = comments[comments.length - 1];
    if (!latestComment) return;

    if (latestComment.authorType === "user" && latestComment.replyToAuthorType === "npc") {
        triggerNpcReplyIfNeeded(post, latestComment);
        return;
    }

    triggerCharacterReplyIfNeeded(post, [latestComment]);
}

// ── Response Parser ──

export function parseMomentPostResponse(rawText: string): {
    content: string;
    photoDescription?: string;
    photoUseReferenceImage?: boolean;
} | null {
    const blockMatch = rawText.match(/\[朋友圈\]\s*([\s\S]*?)\s*\[\/朋友圈\]/);
    const text = blockMatch ? blockMatch[1] : rawText;

    const explicitPhotoMatch = text.match(/\[照片[:：]\s*(使用参考图|不使用参考图)\s*[:：]\s*([\s\S]*?)\]/);
    const legacyPhotoMatch = explicitPhotoMatch ? null : text.match(/\[照片[:：]\s*([\s\S]*?)\]/);
    const photoDescription = explicitPhotoMatch
        ? explicitPhotoMatch[2].trim()
        : legacyPhotoMatch ? legacyPhotoMatch[1].trim() : undefined;
    const photoUseReferenceImage = explicitPhotoMatch ? explicitPhotoMatch[1] === "使用参考图" : false;

    const content = text
        .replace(/\[照片[:：]\s*(?:使用参考图|不使用参考图)\s*[:：]\s*[\s\S]*?\]/g, "")
        .replace(/\[照片[:：]\s*[\s\S]*?\]/g, "")
        .replace(/\[朋友圈\]|\[\/朋友圈\]/g, "")
        .trim();

    if (!content) return null;

    return { content, photoDescription, photoUseReferenceImage };
}

// ── Helpers ──

/**
 * 生图后台任务：帖子已先入库（photoGenerationStatus: "pending"），图片生成完再补挂。
 * 失败/超时/中断只把状态标为 failed（卡片上可手动重试），绝不影响帖子本身。
 */
export function attachMomentPhotoInBackground(
    postId: string,
    description: string,
    characterId: string,
    useReferenceImage: boolean,
    signal?: AbortSignal,
): void {
    void (async () => {
        let photoUrl: string | undefined;
        let errorMessage: string | undefined;
        try {
            photoUrl = await generateMomentPhotoUrl(description, characterId, useReferenceImage, signal);
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error);
        }
        updateMomentPost(postId, photoUrl
            ? { photoUrl, photoGenerationStatus: "generated", photoGenerationError: undefined }
            : { photoGenerationStatus: "failed", photoGenerationError: errorMessage || "生图配置未启用或生成失败" });
        dispatchMomentsUpdated();
    })();
}

export async function generateMomentPhotoUrl(
    description: string,
    characterId: string,
    useReferenceImage: boolean,
    signal?: AbortSignal,
): Promise<string | undefined> {
    try {
        throwIfAborted(signal);
        const generated = await generateImageFromConfiguredApi({
            description,
            characterId,
            useReferenceImage,
            signal,
        });
        throwIfAborted(signal);
        if (!generated) return undefined;
        const assetId = await saveChatImageToIndexedDB(generated.blob);
        throwIfAborted(signal);
        return `asset://${assetId}`;
    } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn("[Moments] Image generation failed:", error);
        return undefined;
    }
}

function getUserName(characterId?: string): string {
    try {
        const identity = resolveUserIdentity(characterId, "chat");
        return identity?.name || "我";
    } catch {
        return "我";
    }
}

function normalizeIdentityName(name: string): string {
    return name
        .normalize("NFKC")
        .replace(/\s+/g, "")
        .toLowerCase();
}

function resolveMomentAuthorName(
    authorType: "user" | "character" | "npc",
    authorId: string,
    userName: string,
    chars: Character[],
    authorName?: string,
): string {
    if (authorType === "user") return userName;
    if (authorType === "npc") return authorName || "某人";
    return chars.find(c => c.id === authorId)?.name ?? "某人";
}

function formatMomentCommentLine(
    comment: MomentComment,
    userName: string,
    chars: Character[],
): string {
    const authorName = resolveMomentAuthorName(comment.authorType, comment.authorId, userName, chars, comment.authorName);
    if (!comment.replyToAuthorId) {
        return `${authorName}：${comment.content}`;
    }
    const replyTargetName = comment.replyToAuthorType
        ? resolveMomentAuthorName(
            comment.replyToAuthorType,
            comment.replyToAuthorId,
            userName,
            chars,
            comment.replyToAuthorName,
        )
        : (comment.replyToAuthorName || "某人");
    return `${authorName} 回复 ${replyTargetName}：${comment.content}`;
}

function buildMomentUiSnapshot(
    post: MomentPost,
    characterId?: string,
    options?: {
        triggeringCommentIds?: string[];
        snapshotTitle?: string;
    },
): string {
    const userName = getUserName(characterId);
    const chars = loadCharacters();
    const authorName = post.authorType === "user"
        ? userName
        : (chars.find(c => c.id === post.authorId)?.name ?? "某人");
    const allComments = loadMomentComments(post.id);
    const comments = characterId
        ? getVisibleMomentCommentsForCharacter(post, characterId, allComments)
        : allComments;
    const commentThreads = buildTwoLevelMomentThreads(comments);
    const commentIndexMap = new Map<string, string>();
    comments
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .forEach((comment, index) => {
            commentIndexMap.set(comment.id, `c${index + 1}`);
        });

    const parts: string[] = [];
    parts.push(options?.snapshotTitle || "<朋友圈界面快照>");
    parts.push(`发帖人：${authorName}`);
    parts.push(`正文：${post.content}`);
    if (post.location) parts.push(`地点：${post.location}`);
    if (post.photoUrl) parts.push("配图：见附图");
    else if (post.photoDescription) parts.push(`配图：${post.photoDescription}`);
    const likes = characterId
        ? getVisibleMomentLikesForCharacter(post, characterId, post.likes)
        : post.likes;
    if (likes.length > 0) {
        const likeNames = likes.map((like) =>
            resolveMomentAuthorName(like.authorType, like.authorId, userName, chars, like.authorName)
        );
        parts.push(`点赞：${likeNames.join("，")}`);
    }

    parts.push("");
    parts.push("评论区：");
    if (commentThreads.length === 0) {
        parts.push("- 暂无评论");
    } else {
        for (const { root, replies } of commentThreads) {
            const rootLabel = commentIndexMap.get(root.id) || root.id;
            parts.push(`- [${rootLabel}] ${formatMomentCommentLine(root, userName, chars)}`);
            for (const reply of replies) {
                const replyLabel = commentIndexMap.get(reply.id) || reply.id;
                parts.push(`  - [${replyLabel}] ${formatMomentCommentLine(reply, userName, chars)}`);
            }
        }
    }

    if (options?.triggeringCommentIds && options.triggeringCommentIds.length > 0) {
        const triggeringSet = new Set(options.triggeringCommentIds);
        const triggeringComments = comments.filter(comment => triggeringSet.has(comment.id));
        if (triggeringComments.length > 0) {
            parts.push("");
            parts.push("本次新互动：");
            for (const comment of triggeringComments) {
                const label = commentIndexMap.get(comment.id) || comment.id;
                parts.push(`- [${label}] ${formatMomentCommentLine(comment, userName, chars)}`);
            }
        }
    }

    parts.push("</朋友圈界面快照>");
    return parts.join("\n");
}

async function resolveMomentPhotoForVision(post: MomentPost): Promise<string | null> {
    const photoUrl = post.photoUrl?.trim();
    if (!photoUrl) return null;
    if (!photoUrl.startsWith("asset://")) return photoUrl;

    try {
        return await getChatImageFromIndexedDB(photoUrl.slice(8));
    } catch {
        return null;
    }
}

async function buildMomentSnapshotMessage(
    post: MomentPost,
    characterId: string | undefined,
    apiConfig: ApiConfig | null,
    marker: string,
    options?: {
        triggeringCommentIds?: string[];
        snapshotTitle?: string;
        prefixLines?: string[];
    },
): Promise<LLMMessage> {
    const snapshot = buildMomentUiSnapshot(post, characterId, options);
    const text = options?.prefixLines?.length
        ? [...options.prefixLines, snapshot].join("\n")
        : snapshot;
    const imageUrl = apiConfig?.enableImageRecognition
        ? await resolveMomentPhotoForVision(post)
        : null;

    if (!imageUrl) {
        return {
            role: "user",
            content: text,
            _debugMeta: { marker },
        };
    }

    return {
        role: "user",
        content: [
            { type: "text", text },
            { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
        ],
        _debugMeta: { marker },
    };
}

function dispatchMomentsUpdated(): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("moments-updated"));
    }
}

// ── Reaction Poll ──

function startReactionPoll() {
    if (cancelReactionPoll) return;
    pollPendingReactions();                                   // fire immediately on start
    cancelReactionPoll = bgSetInterval(pollPendingReactions, 30000);
}

function stopReactionPoll() {
    if (cancelReactionPoll) { cancelReactionPoll(); cancelReactionPoll = null; }
}

function pollPendingReactions() {
    // Check scheduled posts
    pollScheduledPosts();

    // Check pending reaction tasks
    const now = Date.now();
    const tasks = loadPendingReactions();
    for (const task of tasks) {
        if (task.fireAt > now || firingSet.has(task.id)) continue;
        firingSet.add(task.id);
        executeReactionTask(task)
            .then(() => removePendingReaction(task.id))       // remove only on success
            .catch(err => console.error("[Moments] Reaction task error, will retry:", err))
            .finally(() => firingSet.delete(task.id));
    }
}

async function executeReactionTask(task: PendingReaction) {
    const chars = loadCharacters();
    const posts = loadMomentPosts();
    const post = posts.find(p => p.id === task.postId);
    if (!post) return;

    const isUserPost = post.authorType === "user";

    switch (task.type) {
        case "npc_reaction": {
            const character = chars.find(c => c.id === task.characterId);
            if (!character) return;
            await generateNPCReactionsViaLLM(post, character);
            if (isUserPost) sendBrowserNotification("朋友圈", { body: "有新的NPC互动" });
            break;
        }
        case "ai_comment": {
            const character = chars.find(c => c.id === task.characterId);
            if (!character) return;
            const likeProb = loadMomentsConfig().likeProb;
            let didLike = false;
            if (Math.random() < likeProb) {
                didLike = toggleMomentLike(post.id, "character", character.id);
            }
            const didComment = await generateAIComment(post, character);
            if (isUserPost && didComment) {
                sendBrowserNotification("朋友圈", { body: `${character.name} 评论了你的动态` });
            } else if (isUserPost && didLike) {
                sendBrowserNotification("朋友圈", { body: `${character.name} 赞了你的朋友圈` });
            }
            break;
        }
        case "character_reply": {
            const allComments = loadMomentComments(post.id);
            const triggeringComments = task.triggeringCommentIds
                ? allComments.filter(c => task.triggeringCommentIds!.includes(c.id))
                : [];
            const visibleTriggeringComments = getVisibleMomentCommentsForCharacter(post, task.characterId, triggeringComments);
            if (visibleTriggeringComments.length === 0) return;
            const replyChar = chars.find(c => c.id === task.characterId);
            const didReply = await triggerCharacterReply(post, task.characterId, visibleTriggeringComments);
            if (didReply) sendBrowserNotification("朋友圈", { body: `${replyChar?.name || "角色"} 回复了你的评论` });
            break;
        }
        case "npc_reply": {
            const ownerChar = chars.find(c => c.id === task.characterId);
            if (!ownerChar || !task.targetNpcName) return;
            const allComments = loadMomentComments(post.id);
            const triggeringComment = task.triggeringCommentIds?.[0]
                ? allComments.find(c => c.id === task.triggeringCommentIds![0])
                : undefined;
            if (!triggeringComment) return;
            const didReply = await generateTargetedNPCReply(post, ownerChar, triggeringComment, task.targetNpcName);
            if (didReply) sendBrowserNotification("朋友圈", { body: `${task.targetNpcName} 回复了你的评论` });
            break;
        }
    }
}

// ── Preview Functions (for Debug Panel) ──

export type MomentsPreviewResult = {
    messages: LLMMessage[];
    characterName: string;
    model: string;
    presetName: string;
};

/**
 * Preview the prompt that would be sent for AI posting.
 * Uses the same assemblePromptPayload() pipeline as the actual generation.
 */
export async function previewMomentsPostPrompt(characterId: string): Promise<MomentsPreviewResult | null> {
    const resolved = await resolveAssemblerInput(characterId, "post");
    if (!resolved) return null;

    const { input, apiConfig, preset, character } = resolved;

    // Assemble via shared pipeline
    const llmMessages = assemblePromptPayload(input);

    // Append trigger instruction
    llmMessages.push({
        role: "user",
        content: "请发一条朋友圈。",
        _debugMeta: { marker: "moments_trigger" },
    });

    return {
        messages: apiConfig ? previewMessagesForApi(apiConfig, preset, llmMessages) : llmMessages,
        characterName: character.name,
        model: apiConfig?.defaultModel ?? "(未绑定)",
        presetName: preset?.name ?? "(无预设)",
    };
}

/**
 * Preview the prompt that would be sent for AI commenting on a specific post.
 * Uses the same assemblePromptPayload() pipeline as the actual generation.
 */
export async function previewMomentsCommentPrompt(characterId: string, postId: string): Promise<MomentsPreviewResult | null> {
    const resolved = await resolveAssemblerInput(characterId, "comment");
    if (!resolved) return null;

    const { input, apiConfig, preset, character } = resolved;

    const posts = loadMomentPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return null;

    // Assemble via shared pipeline
    const llmMessages = assemblePromptPayload(input);

    llmMessages.push(await buildMomentSnapshotMessage(post, characterId, apiConfig, "moments_post_data"));

    return {
        messages: apiConfig ? previewMessagesForApi(apiConfig, preset, llmMessages) : llmMessages,
        characterName: character.name,
        model: apiConfig?.defaultModel ?? "(未绑定)",
        presetName: preset?.name ?? "(无预设)",
    };
}

/**
 * Preview the prompt that would be sent for NPC reactions on a character's post.
 */
export async function previewMomentsNPCPrompt(characterId: string, postId: string): Promise<MomentsPreviewResult | null> {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === characterId);
    if (!character) return null;

    const posts = loadMomentPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return null;

    const result = await buildNPCReactionMessages(post, character);
    if (!result) return null;

    return {
        messages: result.apiConfig ? previewMessagesForApi(result.apiConfig, result.preset, result.messages) : result.messages,
        characterName: character.name,
        model: result.apiConfig?.defaultModel ?? "(未绑定)",
        presetName: result.preset?.name ?? "(无预设)",
    };
}

/**
 * Preview the prompt that would be sent for character reply on a specific post.
 */
export async function previewMomentsReplyPrompt(characterId: string, postId: string): Promise<MomentsPreviewResult | null> {
    const resolved = await resolveAssemblerInput(characterId, "reply");
    if (!resolved) return null;

    const { input, apiConfig, preset, character } = resolved;

    const posts = loadMomentPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return null;

    const llmMessages = assemblePromptPayload(input);

    const existingComments = loadMomentComments(post.id);

    // For preview: simulate new comments = all non-character comments (NPC + user)
    const simulatedNewComments = existingComments.filter(c => c.authorType !== "character");

    llmMessages.push(await buildMomentSnapshotMessage(post, characterId, apiConfig, "moments_reply_data", {
        triggeringCommentIds: simulatedNewComments.slice(-5).map(c => c.id),
    }));

    return {
        messages: apiConfig ? previewMessagesForApi(apiConfig, preset, llmMessages) : llmMessages,
        characterName: character.name,
        model: apiConfig?.defaultModel ?? "(未绑定)",
        presetName: preset?.name ?? "(无预设)",
    };
}
