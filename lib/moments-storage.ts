// lib/moments-storage.ts
// KV-DB persistence for Moments (朋友圈) feature.

import type { MomentPost, MomentComment, AIMomentSchedule, PendingReaction } from "./moments-types";
import { loadCharacters } from "./character-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { DEFAULT_MOMENTS_BILINGUAL_PROMPT } from "./bilingual-prompt-defaults";
import { canCharacterSeeMomentPost, getVisibleMomentCommentsForCharacter } from "./character-world-storage";
import {
    initMomentsDb,
    dbPutPost,
    dbDeletePost,
    dbReplacePosts,
    dbPutComment,
    dbDeleteComment,
    dbDeleteCommentsByPost,
} from "./moments-db";

const AI_SCHEDULE_KEY = "ai_phone_moments_ai_schedule_v1";
const PENDING_REACTIONS_KEY = "ai_phone_moments_pending_reactions_v1";

registerKvMigration(AI_SCHEDULE_KEY);
registerKvMigration(PENDING_REACTIONS_KEY);

// ── In-memory cache (source of truth for sync reads; mirrored to AiPhoneMomentsDB) ──
// Posts & comments live in IndexedDB as individual rows (no more monolithic kv
// JSON blob). The caches are hydrated once at startup via hydrateMomentsStorage();
// reads before hydration return empty (services/UI start after hydration).
let _postsCache: MomentPost[] | null = null;
let _commentsCache: MomentComment[] | null = null;
let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;

export function hydrateMomentsStorage(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return Promise.resolve();
    if (_hydratePromise) return _hydratePromise;
    _hydratePromise = initMomentsDb().then(data => {
        _postsCache = data.posts;
        _commentsCache = data.comments;
        _hydrated = true;
    }).catch(err => {
        console.warn("[MomentsStorage] hydration failed, will retry on next call:", err);
        _hydratePromise = null;
    });
    return _hydratePromise;
}

// ── Helpers ──

function isBrowser(): boolean {
    return typeof window !== "undefined";
}

function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Posts CRUD ──

export function loadMomentPosts(): MomentPost[] {
    return _postsCache ?? [];
}

export function saveMomentPosts(posts: MomentPost[]): void {
    if (!isBrowser()) return;
    _postsCache = posts;
    dbReplacePosts(posts);
}

// ── 朋友圈内容去重 ──
// 同一条 AI 回复里的 [朋友圈] 块可能被多条路径重复派发（工具多轮循环复读、
// 评论/回复/NPC 反应生成时回显原帖、离线推送后重放等），这里按
// "作者 + 归一化文本 + 图片描述" 在时间窗口内判重，兜住所有入库来源。
// 用户手动发帖（authorType === "user"）不做去重。
const DUPLICATE_POST_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeMomentText(value: string | undefined): string {
    return (value ?? "").replace(/\s+/g, "");
}

export function findRecentDuplicateMomentPost(
    candidate: Pick<MomentPost, "authorType" | "authorId" | "content"> & { photoDescription?: string },
): MomentPost | null {
    if (candidate.authorType !== "character") return null;
    const content = normalizeMomentText(candidate.content);
    const photoDescription = normalizeMomentText(candidate.photoDescription);
    if (!content && !photoDescription) return null;
    const cutoff = Date.now() - DUPLICATE_POST_WINDOW_MS;
    for (const existing of loadMomentPosts()) { // newest first
        const createdAt = Date.parse(existing.createdAt);
        if (Number.isFinite(createdAt) && createdAt < cutoff) break;
        if (existing.authorType !== "character" || existing.authorId !== candidate.authorId) continue;
        if (normalizeMomentText(existing.content) === content
            && normalizeMomentText(existing.photoDescription) === photoDescription) {
            return existing;
        }
    }
    return null;
}

/** 新增一条朋友圈；角色帖命中内容去重时丢弃并返回 null。 */
export function addMomentPost(post: Omit<MomentPost, "id" | "likes" | "createdAt">): MomentPost | null {
    const duplicate = findRecentDuplicateMomentPost(post);
    if (duplicate) {
        console.warn(`[MomentsStorage] SKIP duplicate moment post from ${post.authorId} (existing ${duplicate.id})`);
        return null;
    }
    const newPost: MomentPost = {
        ...post,
        id: generateId("moment"),
        likes: [],
        createdAt: new Date().toISOString(),
    };
    _postsCache = [newPost, ...loadMomentPosts()]; // newest first
    dbPutPost(newPost);
    return newPost;
}

export function updateMomentPost(postId: string, patch: Partial<MomentPost>): MomentPost | null {
    const posts = loadMomentPosts();
    const idx = posts.findIndex(p => p.id === postId);
    if (idx === -1) return null;

    const updated: MomentPost = { ...posts[idx], ...patch, id: posts[idx].id };
    _postsCache = [...posts];
    _postsCache[idx] = updated;
    dbPutPost(updated);
    return updated;
}

export function deleteMomentPost(postId: string): void {
    _postsCache = loadMomentPosts().filter(p => p.id !== postId);
    dbDeletePost(postId);
    // Also delete all comments for this post
    _commentsCache = loadAllMomentComments().filter(c => c.postId !== postId);
    dbDeleteCommentsByPost(postId);
}

// ── Comments CRUD ──

export function loadAllMomentComments(): MomentComment[] {
    return _commentsCache ?? [];
}

export function loadMomentComments(postId: string): MomentComment[] {
    return loadAllMomentComments()
        .filter(c => c.postId === postId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function addMomentComment(comment: Omit<MomentComment, "id" | "createdAt"> & { createdAt?: string }): MomentComment {
    const newComment: MomentComment = {
        ...comment,
        id: generateId("mc"),
        createdAt: comment.createdAt ?? new Date().toISOString(),
    };
    _commentsCache = [...loadAllMomentComments(), newComment];
    dbPutComment(newComment);
    return newComment;
}

export function updateMomentComment(commentId: string, patch: Partial<MomentComment>): MomentComment | null {
    const comments = loadAllMomentComments();
    const idx = comments.findIndex(c => c.id === commentId);
    if (idx === -1) return null;

    const original = comments[idx];
    const updated: MomentComment = {
        ...original,
        ...patch,
        id: original.id,
        postId: original.postId,
        createdAt: original.createdAt,
    };
    _commentsCache = [...comments];
    _commentsCache[idx] = updated;
    dbPutComment(updated);
    return updated;
}

export function deleteMomentComment(commentId: string): void {
    _commentsCache = loadAllMomentComments().filter(c => c.id !== commentId);
    dbDeleteComment(commentId);
}

export function deleteMomentCommentThread(commentId: string): string[] {
    const comments = loadAllMomentComments();
    const deleteIds = new Set<string>([commentId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const comment of comments) {
            if (comment.replyToCommentId && deleteIds.has(comment.replyToCommentId) && !deleteIds.has(comment.id)) {
                deleteIds.add(comment.id);
                changed = true;
            }
        }
    }

    _commentsCache = comments.filter(c => !deleteIds.has(c.id));
    deleteIds.forEach(id => dbDeleteComment(id));
    return Array.from(deleteIds);
}

// ── Likes ──

export function toggleMomentLike(
    postId: string,
    authorType: "user" | "character",
    authorId: string,
): boolean {
    const posts = loadMomentPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return false;

    const existingIdx = post.likes.findIndex(
        l => l.authorType === authorType && l.authorId === authorId
    );

    if (existingIdx >= 0) {
        post.likes.splice(existingIdx, 1);
        dbPutPost(post); // post is a live ref into the cache; persist just this row
        return false; // unliked
    } else {
        post.likes.push({
            authorType,
            authorId,
            createdAt: new Date().toISOString(),
        });
        dbPutPost(post);
        return true; // liked
    }
}

// ── Visibility Queries ──

/** Get posts visible to a specific character. */
export function getVisiblePosts(characterId: string): MomentPost[] {
    return loadMomentPosts().filter(post => canCharacterSeeMomentPost(post, characterId));
}

/** Get all posts (user sees everything). */
export function getAllPosts(): MomentPost[] {
    return loadMomentPosts();
}

/**
 * Get comments visible to a specific character for a given post.
 * A comment is visible if:
 * - The viewer is the post author, OR
 * - The viewer is the comment author, OR
 * - Both the commenter and viewer are in the post's visibility list (or one is the post author)
 */
export function getVisibleComments(postId: string, viewerCharId: string): MomentComment[] {
    const posts = loadMomentPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return [];

    return getVisibleMomentCommentsForCharacter(post, viewerCharId, loadMomentComments(postId));
}

// ── AI Schedule ──

export function loadAIMomentSchedule(): AIMomentSchedule[] {
    if (!isBrowser()) return [];
    try {
        const raw = kvGet(AI_SCHEDULE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function saveAIMomentSchedule(schedules: AIMomentSchedule[]): void {
    if (!isBrowser()) return;
    kvSet(AI_SCHEDULE_KEY, JSON.stringify(schedules));
}

export function getOrCreateSchedule(characterId: string): AIMomentSchedule {
    const schedules = loadAIMomentSchedule();
    let entry = schedules.find(s => s.characterId === characterId);
    if (!entry) {
        // First time: set nextPostAfter to a random time based on config
        const cfg = loadMomentsConfig();
        const delayMs = (cfg.postIntervalMinHours * 0.02 + Math.random() * cfg.postIntervalMinHours * 0.08) * 60 * 60 * 1000;
        entry = {
            characterId,
            lastPostTime: 0,
            nextPostAfter: Date.now() + delayMs,
        };
        schedules.push(entry);
        saveAIMomentSchedule(schedules);
    }
    return entry;
}

export function updateScheduleAfterPost(characterId: string): void {
    const schedules = loadAIMomentSchedule();
    const entry = schedules.find(s => s.characterId === characterId);
    if (entry) {
        const cfg = loadMomentsConfig();
        entry.lastPostTime = Date.now();
        const range = cfg.postIntervalMaxHours - cfg.postIntervalMinHours;
        const delayMs = (cfg.postIntervalMinHours + Math.random() * range) * 60 * 60 * 1000;
        entry.nextPostAfter = Date.now() + delayMs;
        saveAIMomentSchedule(schedules);
    }
}

// ── Pending Reactions ──

export function loadPendingReactions(): PendingReaction[] {
    if (!isBrowser()) return [];
    try {
        const raw = kvGet(PENDING_REACTIONS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function savePendingReactions(tasks: PendingReaction[]): void {
    if (!isBrowser()) return;
    kvSet(PENDING_REACTIONS_KEY, JSON.stringify(tasks));
}

export function addPendingReaction(task: Omit<PendingReaction, "id">): void {
    const tasks = loadPendingReactions();
    tasks.push({ ...task, id: generateId("pr") });
    savePendingReactions(tasks);
}

export function removePendingReaction(taskId: string): void {
    const tasks = loadPendingReactions().filter(t => t.id !== taskId);
    savePendingReactions(tasks);
}

// ── Moments Interaction Config ──────────

const MOMENTS_CONFIG_KEY = "ai_phone_moments_config_v1";
registerKvMigration(MOMENTS_CONFIG_KEY);

export type MomentsInteractionConfig = {
    postIntervalMinHours: number;   // 发帖间隔最小（小时）
    postIntervalMaxHours: number;   // 发帖间隔最大（小时）
    firstCommentDelaySec: number;   // 首条评论延迟（秒）
    commentGapSec: number;          // 后续评论间隔（秒）
    npcReactionDelayMin: number;    // NPC互动延迟（分钟）
    replyDelaySec: number;          // 回复评论延迟（秒）
    commentProb: number;            // 评论概率 0-1
    likeProb: number;               // 点赞概率 0-1
    bilingualTranslationEnabled: boolean;   // 朋友圈外语正文自动附简中译文
    collapseBilingualTranslation: boolean;  // 默认折叠中文译文
    bilingualTranslationPrompt: string;
    // 禁止自动发帖的角色（只关调度发帖；评论/点赞/手动立即发帖不受影响）
    autoPostDisabledCharacterIds: string[];
};

export const DEFAULT_MOMENTS_CONFIG: MomentsInteractionConfig = {
    postIntervalMinHours: 24,
    postIntervalMaxHours: 48,
    firstCommentDelaySec: 120,
    commentGapSec: 60,
    npcReactionDelayMin: 20,
    replyDelaySec: 3,
    commentProb: 0.5,
    likeProb: 0.75,
    bilingualTranslationEnabled: true,
    collapseBilingualTranslation: true,
    bilingualTranslationPrompt: DEFAULT_MOMENTS_BILINGUAL_PROMPT,
    autoPostDisabledCharacterIds: [],
};

export function loadMomentsConfig(): MomentsInteractionConfig {
    if (typeof window === "undefined") return DEFAULT_MOMENTS_CONFIG;
    try {
        const raw = kvGet(MOMENTS_CONFIG_KEY);
        if (!raw) return DEFAULT_MOMENTS_CONFIG;
        const merged = { ...DEFAULT_MOMENTS_CONFIG, ...JSON.parse(raw) };
        if (!Array.isArray(merged.autoPostDisabledCharacterIds)) merged.autoPostDisabledCharacterIds = [];
        return merged;
    } catch { return DEFAULT_MOMENTS_CONFIG; }
}

export function saveMomentsConfig(config: MomentsInteractionConfig): void {
    if (typeof window === "undefined") return;
    kvSet(MOMENTS_CONFIG_KEY, JSON.stringify(config));
}

// ── Moments Notification (unread comments/replies) ──────────

const MOMENTS_LAST_SEEN_KEY = "ai_phone_moments_last_seen_v1";
registerKvMigration(MOMENTS_LAST_SEEN_KEY);

export function loadMomentsLastSeen(): number {
    if (typeof window === "undefined") return Date.now();
    return Number(kvGet(MOMENTS_LAST_SEEN_KEY)) || 0;
}

export function saveMomentsLastSeen(): void {
    if (typeof window === "undefined") return;
    kvSet(MOMENTS_LAST_SEEN_KEY, String(Date.now()));
}

/** Get all comments/replies targeting the user that are newer than lastSeen. */
export function getUnreadMomentsNotifications(): { authorName: string; content: string; type: "comment" | "reply" | "like"; createdAt: string }[] {
    const lastSeen = loadMomentsLastSeen();
    const posts = loadMomentPosts();
    const userPostIds = new Set(posts.filter(p => p.authorType === "user").map(p => p.id));
    const results: { authorName: string; content: string; type: "comment" | "reply" | "like"; createdAt: string }[] = [];

    const chars = loadCharacters();
    const resolveAuthorName = (c: { authorType: string; authorId: string; authorName?: string }) => {
        if (c.authorName) return c.authorName;
        if (c.authorType === "character") return chars.find(ch => ch.id === c.authorId)?.name || c.authorId;
        return c.authorId;
    };

    for (const post of posts) {
        // Likes on user's posts
        if (userPostIds.has(post.id)) {
            for (const like of post.likes) {
                if (like.authorType === "user") continue;
                const ts = new Date(like.createdAt).getTime();
                if (ts <= lastSeen) continue;
                results.push({ authorName: resolveAuthorName(like), content: "", type: "like", createdAt: like.createdAt });
            }
        }

        // Comments and replies
        const comments = loadMomentComments(post.id);
        for (const c of comments) {
            if (c.authorType === "user") continue;
            const ts = new Date(c.createdAt).getTime();
            if (ts <= lastSeen) continue;

            const name = resolveAuthorName(c);

            // Comment on user's post
            if (userPostIds.has(post.id) && !c.replyToAuthorId) {
                results.push({ authorName: name, content: c.content, type: "comment", createdAt: c.createdAt });
            }
            // Reply to user's comment
            if (c.replyToAuthorType === "user") {
                results.push({ authorName: name, content: c.content, type: "reply", createdAt: c.createdAt });
            }
        }
    }

    return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
