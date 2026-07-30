// lib/action-parser.ts
// Global action tag parser + dispatcher.
// Extracts structured action tags from LLM output and dispatches them
// to the appropriate subsystem (moments, chat, etc.).

import {
    addMomentPost,
    addMomentComment,
    addPendingReaction,
    findRecentDuplicateMomentPost,
    getVisibleComments,
    getVisiblePosts,
    loadMomentsConfig,
} from "./moments-storage";
import { loadChatContacts, loadChatSessions, loadChatMessages, createOrGetSession, addChatContact } from "./chat-storage";
import { parseAndSaveResponse } from "./follow-up-service";
import { loadCharacters } from "./character-storage";
import { clearRequestsForCharacter, dispatchFriendRequestUpdated } from "./friend-request-storage";
import { sendBrowserNotification } from "./browser-notification";
import type { MomentPost, MomentComment } from "./moments-types";
import { attachMomentPhotoInBackground, parseMomentPostResponse } from "./moments-engine";
import { isAbortError, throwIfAborted } from "./abort-utils";

// ── Types ──

export type ActionTag = {
    type: string;      // "朋友圈" | "评论" | "回复" | "消息" | "私信" | "群消息"
    actor?: string;    // character name performing the action (group chat multi-role)
    target?: string;   // quoted keyword (for content matching / group name)
    content: string;   // action body
    rawText?: string;  // original matched action block from the model output
};

export type ActionContext = {
    characterId: string;
    sessionId?: string;
    sourceEngine: "chat" | "moments" | "group_chat" | "followup";
    signal?: AbortSignal;
};

// ── Parser ──

const ACTION_TAGS = ["朋友圈", "群消息", "评论", "回复", "消息", "私信"] as const;

function normalizeActionQuotes(text: string): string {
    return text.replace(/[\u201C\u201D\u2018\u2019\u300C\u300D]/g, "\"");
}

function unwrapActionTarget(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function parseActionHeader(header: string): { actor?: string; type: string; target?: string } | null {
    let rest = normalizeActionQuotes(header).trim();
    let actor: string | undefined;

    const actorMatch = /^"([^"]+)"\s*([\s\S]*)$/.exec(rest);
    if (actorMatch) {
        const actorRest = actorMatch[2].trim();
        if (ACTION_TAGS.some(tag => actorRest.startsWith(tag))) {
            actor = actorMatch[1].trim();
            rest = actorRest;
        }
    }

    const type = ACTION_TAGS.find(tag => rest.startsWith(tag));
    if (!type) return null;

    const targetText = rest.slice(type.length).trim();
    const target = targetText ? unwrapActionTarget(targetText) : undefined;
    return { actor: actor || undefined, type, target };
}

function removeActionRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
    if (ranges.length === 0) return text;

    let result = "";
    let cursor = 0;
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
        result += text.slice(cursor, range.start);
        cursor = range.end;
    }
    result += text.slice(cursor);
    return result;
}

function collectActionBlocks(text: string, requireClosingTag: boolean): {
    actions: ActionTag[];
    ranges: Array<{ start: number; end: number }>;
} {
    const actions: ActionTag[] = [];
    const ranges: Array<{ start: number; end: number }> = [];
    const openTagPattern = /\[([^\]\n]+)\]/g;

    let match: RegExpExecArray | null;
    while ((match = openTagPattern.exec(text)) !== null) {
        const parsed = parseActionHeader(match[1]);
        if (!parsed) continue;

        const contentStart = openTagPattern.lastIndex;
        const closingTag = `[/${parsed.type}]`;
        const closingStart = text.indexOf(closingTag, contentStart);

        if (closingStart < 0) {
            if (requireClosingTag) continue;

            const content = text.slice(contentStart).trim();
            if (!content) continue;

            actions.push({ ...parsed, content, rawText: text.slice(match.index) });
            ranges.push({ start: match.index, end: text.length });
            break;
        }

        const end = closingStart + closingTag.length;
        const content = text.slice(contentStart, closingStart).trim();
        actions.push({ ...parsed, content, rawText: text.slice(match.index, end) });
        ranges.push({ start: match.index, end });
        openTagPattern.lastIndex = end;
    }

    return { actions, ranges };
}

/**
 * Extract action tags from LLM output text.
 * Returns the clean text (with all action tags stripped) and an array of parsed actions.
 *
 * Supported formats:
 *   [朋友圈]内容[/朋友圈]                     — single-person
 *   ["角色名"朋友圈]内容[/朋友圈]              — group (actor)
 *   [评论 "关键词"]内容[/评论]                  — single-person
 *   ["角色名"评论 "关键词"]内容[/评论]          — group (actor + target)
 *   [回复 "关键词"]内容[/回复]                  — single-person
 *   ["角色名"回复 "关键词"]内容[/回复]          — group (actor + target)
 *   [消息]内容[/消息]                          — single-person
 *   ["角色名"私信]内容[/私信]                  — group (actor)
 *   [群消息 "群名"]内容[/群消息]                — cross-context
 */
export function parseActionTags(text: string): {
    cleanText: string;
    actions: ActionTag[];
} {
    let cleanText = text;

    // Normalize smart/curly quotes to ASCII quotes for reliable matching.
    const normalized = normalizeActionQuotes(text);
    let { actions, ranges } = collectActionBlocks(normalized, true);

    if (actions.length > 0) {
        cleanText = removeActionRanges(normalized, ranges).trim();
    }

    // Fallback: open tag without closing tag (AI omitted [/TAG]) — take content to end of text
    if (actions.length === 0) {
        ({ actions, ranges } = collectActionBlocks(normalized, false));
        if (actions.length > 0) {
            cleanText = removeActionRanges(normalized, ranges).trim();
        }
    }

    // Strip action shells (AI hallucination cleanup)
    cleanText = stripEmptyActionShells(cleanText);

    return { cleanText, actions };
}


// ── Empty shell filter ──

/**
 * Tag names to filter when they appear as empty shells.
 * Add new action tag names here as features are added.
 */
const KNOWN_ACTION_TAGS = [
    // 中文方括号格式
    "朋友圈", "评论", "回复", "消息", "群消息", "私信",
    // XML 格式 (AI 偶尔幻觉输出)
    "action_chat_message", "action_moments_post",
    "action_comment", "action_reply",
    "optional_actions",
    // 群聊 XML 格式幻觉
    "group_chat_context", "group_chat_format",
    "group_chat_rich_actions", "action_group_chat_message",
    // 合并前旧标签名
    "chat_context", "chat_format", "chat_rich_actions", "chat_output_format",
    // 加好友
    "add_friend_prompt", "添加好友",
];

/**
 * Remove action tag shells from text.
 * - Empty bracket shells: [tag][/tag] or ["actor"tag][/tag]
 * - XML shells: <tag>...</tag> — stripped entirely (AI hallucination cleanup)
 */
export { stripEmptyActionShells as stripActionShells };

function stripEmptyActionShells(text: string): string {
    const names = KNOWN_ACTION_TAGS.join("|");
    // [tag][/tag] or ["actor"tag][/tag] — empty bracket shells
    const bracketPattern = new RegExp(`\\[(?:"[^"]*")?(${names})(?:\\s+"[^"]*")?\\]\\s*\\[\\/\\1\\]`, "g");
    // <tag>...</tag> — strip XML shells regardless of content (AI hallucination cleanup)
    const xmlPattern = new RegExp(`<(${names})>[\\s\\S]*?<\\/\\1>`, "g");
    return text
        .replace(bracketPattern, "")
        .replace(xmlPattern, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ── Dispatcher ──

/**
 * Dispatch parsed action tags to the appropriate subsystem.
 * Fire-and-forget — errors are logged but don't propagate.
 */
export async function dispatchActions(
    actions: ActionTag[],
    context: ActionContext,
): Promise<void> {
    for (const action of actions) {
        try {
            throwIfAborted(context.signal);
            const effectiveCtx = resolveActorContext(action, context);
            if (!effectiveCtx) { console.log("[ActionParser]", `SKIP: actor "${action.actor}" not found`); continue; }
            console.log("[ActionParser]", `dispatching: type=${action.type} charId=${effectiveCtx.characterId}`);
            switch (action.type) {
                case "朋友圈":
                    await dispatchMomentsPost(action, effectiveCtx);
                    break;
                case "评论":
                    dispatchMomentsComment(action, effectiveCtx);
                    break;
                case "回复":
                    dispatchMomentsReply(action, effectiveCtx);
                    break;
                case "消息":
                    await dispatchChatMessage(action, effectiveCtx);
                    break;
                case "私信":
                    await dispatchPrivateMessage(action, effectiveCtx);
                    break;
                case "群消息":
                    await dispatchGroupChatMessage(action, effectiveCtx);
                    break;
            }
        } catch (err) {
            if (isAbortError(err)) return;
            console.warn(`[ActionParser] Failed to dispatch action "${action.type}":`, err);
        }
    }
}

/**
 * If the action has an actor name (group multi-role), resolve the character ID.
 * Returns null to skip the action if actor not found.
 */
function resolveActorContext(action: ActionTag, context: ActionContext): ActionContext | null {
    if (!action.actor) return context;
    const chars = loadCharacters();
    const found = chars.find(c => c.name === action.actor);
    if (!found) {
        console.warn(`[ActionParser] Actor "${action.actor}" not found, skipping action`);
        return null;
    }
    return { ...context, characterId: found.id };
}

// ── Action Handlers ──

function ensureCharacterChatContact(characterId: string): void {
    const exists = loadChatContacts().some(contact => contact.characterId === characterId);
    if (exists) return;
    const characterExists = loadCharacters().some(character => character.id === characterId);
    if (!characterExists) return;
    addChatContact(characterId);
    clearRequestsForCharacter(characterId);
    dispatchFriendRequestUpdated();
}

function resolveActionCharacterName(action: ActionTag, context: ActionContext): string {
    return loadCharacters().find(c => c.id === context.characterId)?.name || action.actor || "角色";
}

async function dispatchMomentsPost(action: ActionTag, context: ActionContext): Promise<void> {
    // Re-wrap content in [朋友圈]...[/朋友圈] so parseMomentPostResponse can parse it
    const wrapped = `[朋友圈]${action.content}[/朋友圈]`;
    const parsed = parseMomentPostResponse(wrapped);
    if (!parsed) {
        console.warn("[ActionParser] Failed to parse moments post content");
        return;
    }

    // 内容去重：生图前先判重，命中直接丢弃（同一 [朋友圈] 块被多路径重复派发时兜底）
    if (findRecentDuplicateMomentPost({
        authorType: "character",
        authorId: context.characterId,
        content: parsed.content,
        photoDescription: parsed.photoDescription,
    })) {
        console.warn(`[ActionParser] SKIP duplicate moments post from ${context.sourceEngine} engine`);
        return;
    }

    const contacts = loadChatContacts();
    const visibility = contacts.map(c => c.characterId);

    // 先入库再生图：帖子立即可见，生图慢/超时/页面被杀都不会丢帖
    const post = addMomentPost({
        authorType: "character",
        authorId: context.characterId,
        content: parsed.content,
        photoDescription: parsed.photoDescription,
        photoUseReferenceImage: parsed.photoUseReferenceImage === true,
        photoGenerationStatus: parsed.photoDescription ? "pending" : undefined,
        visibility,
    });
    if (!post) {
        console.warn(`[ActionParser] SKIP duplicate moments post from ${context.sourceEngine} engine`);
        return;
    }

    if (parsed.photoDescription) {
        attachMomentPhotoInBackground(post.id, parsed.photoDescription, context.characterId, parsed.photoUseReferenceImage === true, context.signal);
    }

    console.log(`[ActionParser] Created moments post from ${context.sourceEngine} engine`);
    dispatchMomentsUpdated();

    // Trigger NPC reactions (same as moments-engine flow)
    const cfg = loadMomentsConfig();
    const delay = (cfg.npcReactionDelayMin + Math.random() * cfg.npcReactionDelayMin) * 60 * 1000;
    addPendingReaction({
        type: "npc_reaction",
        postId: post.id,
        characterId: context.characterId,
        fireAt: Date.now() + delay,
    });
}

function dispatchMomentsComment(action: ActionTag, context: ActionContext): void {
    if (!action.target) {
        console.warn("[ActionParser] 评论 action missing target keyword");
        return;
    }

    const post = findPostByContent(action.target, context.characterId);
    if (!post) {
        console.warn(`[ActionParser] No post found matching keyword: "${action.target}"`);
        return;
    }

    addMomentComment({
        postId: post.id,
        authorType: "character",
        authorId: context.characterId,
        content: action.content,
    });

    console.log(`[ActionParser] Created comment on post "${post.content.slice(0, 20)}..." from ${context.sourceEngine}`);
    dispatchMomentsUpdated();
    if (post.authorType === "user") {
        sendBrowserNotification("朋友圈", { body: `${resolveActionCharacterName(action, context)} 评论了你的动态` });
    }
}

function dispatchMomentsReply(action: ActionTag, context: ActionContext): void {
    if (!action.target) {
        console.warn("[ActionParser] 回复 action missing target keyword");
        return;
    }

    const found = findCommentByContent(action.target, context.characterId);
    if (!found) {
        console.warn(`[ActionParser] No comment found matching keyword: "${action.target}"`);
        return;
    }

    const { post, comment } = found;

    addMomentComment({
        postId: post.id,
        authorType: "character",
        authorId: context.characterId,
        content: action.content,
        replyToCommentId: comment.id,
        replyToAuthorId: comment.authorId,
        replyToAuthorType: comment.authorType,
        replyToAuthorName: comment.authorName,
    });

    console.log(`[ActionParser] Created reply to comment "${comment.content.slice(0, 20)}..." from ${context.sourceEngine}`);
    dispatchMomentsUpdated();
    if (comment.authorType === "user") {
        sendBrowserNotification("朋友圈", { body: `${resolveActionCharacterName(action, context)} 回复了你的评论` });
    }
}

async function dispatchChatMessage(action: ActionTag, context: ActionContext): Promise<void> {
    if (!action.content) return;

    ensureCharacterChatContact(context.characterId);
    const session = createOrGetSession(context.characterId);
    // 统一后台保存流程：分条、拍一拍、状态栏、生图、横幅+系统弹窗全与聊天一致
    await parseAndSaveResponse(action.content, session.id, 0, undefined, loadChatMessages(session.id));

    console.log(`[ActionParser] Sent chat message from ${context.sourceEngine} engine`);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    }
}

async function dispatchPrivateMessage(action: ActionTag, context: ActionContext): Promise<void> {
    if (!action.content) return;

    ensureCharacterChatContact(context.characterId);
    const session = createOrGetSession(context.characterId);
    await parseAndSaveResponse(action.content, session.id, 0, undefined, loadChatMessages(session.id));

    console.log(`[ActionParser] Sent private message from "${action.actor}" via ${context.sourceEngine} engine`);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    }
}

async function dispatchGroupChatMessage(action: ActionTag, context: ActionContext): Promise<void> {
    console.log("[ActionParser]", `群消息: target="${action.target}" content="${action.content.slice(0, 60)}"`);
    if (!action.content) { console.log("[ActionParser]", "SKIP: empty content"); return; }
    if (!action.target) { console.log("[ActionParser]", "SKIP: no target group name"); return; }

    const sessions = loadChatSessions();
    const allGroups = sessions.filter(s => s.isGroup);
    console.log("[ActionParser]", `groups found: ${allGroups.map(s => s.groupName || "unnamed").join(", ")}`);
    // Exact match first, then fallback to contains
    const groupSession = allGroups.find(s => s.groupName === action.target)
        || allGroups.find(s => s.groupName && s.groupName.includes(action.target!));
    if (!groupSession) {
        console.log("[ActionParser]", `FAIL: no group matching "${action.target}"`);
        return;
    }

    console.log("[ActionParser]", `MATCH: "${groupSession.groupName}" id=${groupSession.id}`);
    await parseAndSaveResponse(action.content, groupSession.id, 0, undefined, loadChatMessages(groupSession.id), {
        senderCharacterId: context.characterId,
        senderName: loadCharacters().find(c => c.id === context.characterId)?.name,
    });

    console.log("[ActionParser]", `OK: message saved to "${groupSession.groupName}"`);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: groupSession.id } }));
    }
}

// ── Content Matching Helpers ──

function findPostByContent(keyword: string, viewerCharacterId: string): MomentPost | null {
    const posts = getVisiblePosts(viewerCharacterId);
    // Search most recent posts first (already sorted newest-first)
    for (const post of posts.slice(0, 50)) {
        if (contentMatchesActionKeyword(post.content, keyword)) return post;
    }
    return null;
}

function contentMatchesActionKeyword(content: string, keyword: string): boolean {
    return content.includes(keyword) || normalizeActionQuotes(content).includes(normalizeActionQuotes(keyword));
}

function findCommentByContent(keyword: string, viewerCharacterId: string): { post: MomentPost; comment: MomentComment } | null {
    const posts = getVisiblePosts(viewerCharacterId);
    const postById = new Map(posts.map(post => [post.id, post]));
    const comments = posts.flatMap(post => getVisibleComments(post.id, viewerCharacterId));

    // Search newest comments first
    const sorted = [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const comment of sorted.slice(0, 100)) {
        if (contentMatchesActionKeyword(comment.content, keyword)) {
            const post = postById.get(comment.postId);
            if (post) return { post, comment };
        }
    }
    return null;
}

// ── Helpers ──

function dispatchMomentsUpdated(): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("moments-updated"));
    }
}
