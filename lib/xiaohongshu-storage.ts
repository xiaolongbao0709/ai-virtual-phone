import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { resolveUserIdentity } from "./settings-storage";
import {
  DEFAULT_XIAOHONGSHU_PROFILE,
  DEFAULT_XIAOHONGSHU_SETTINGS,
  type XiaohongshuAccount,
  type XiaohongshuComment,
  type XiaohongshuNotification,
  type XiaohongshuNote,
  type XiaohongshuSettings,
  type XiaohongshuSocialGraph,
  type XiaohongshuState,
  type XiaohongshuUserInteractions,
  type XiaohongshuUserPostInput,
  type XiaohongshuUserProfile,
} from "./xiaohongshu-types";

const XHS_STATE_KEY = "ai_phone_xiaohongshu_state_v1";
const LEGACY_DEFAULT_NICKNAME = "我";
const LEGACY_DEFAULT_GENDER = "未设置";

registerKvMigration(XHS_STATE_KEY);

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function makeXiaohongshuNpcId(name: string): string {
  const normalized = cleanText(name, 60) || "小红书用户";
  return `npc_${hashString(normalized)}`;
}

function cleanMultiline(value: unknown, maxLength: number): string {
  return cleanText(value, maxLength)
    .replace(/\r\n?/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
  const normalized = String(value ?? "")
    .trim()
    .replace(/[,，\s]/g, "");
  if (!normalized) return fallback;
  const tenThousandMatch = /^(-?\d+(?:\.\d+)?)[wW万](?:(\d+(?:\.\d+)?)(?:[kK千])?)?$/.exec(normalized);
  if (tenThousandMatch) {
    const main = Number(tenThousandMatch[1]);
    const tail = tenThousandMatch[2] ? Number(tenThousandMatch[2]) : 0;
    if (Number.isFinite(main) && Number.isFinite(tail)) {
      return Math.max(0, Math.round(main * 10000 + tail * 1000));
    }
  }
  const thousandMatch = /^(-?\d+(?:\.\d+)?)[kK千](?:(\d+(?:\.\d+)?)(?:百)?)?$/.exec(normalized);
  if (thousandMatch) {
    const main = Number(thousandMatch[1]);
    const tail = thousandMatch[2] ? Number(thousandMatch[2]) : 0;
    if (Number.isFinite(main) && Number.isFinite(tail)) {
      return Math.max(0, Math.round(main * 1000 + tail * 100));
    }
  }
  const parsed = Number(normalized.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed)) return fallback;
  if (/[wW万]/.test(normalized)) return Math.max(0, Math.round(parsed * 10000));
  if (/[kK千]/.test(normalized)) return Math.max(0, Math.round(parsed * 1000));
  return Math.max(0, Math.round(parsed));
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const parsed = numberOr(value, 0);
  return parsed > 0 ? parsed : undefined;
}

function normalizeTags(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、#\s]+/)
      : [];
  return Array.from(new Set(items.map(item => cleanText(item, 18)).filter(Boolean))).slice(0, 6);
}

function normalizeNameList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、\n]+/)
      : [];
  return Array.from(new Set(items.map(item => cleanText(item, 24)).filter(Boolean))).slice(0, 2);
}

function normalizeIdList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、\n]+/)
      : [];
  return Array.from(new Set(items.map(item => cleanText(item, 180)).filter(Boolean)));
}

function parseNotificationCountFromText(text: string): number {
  const match = text.match(/等\s*([0-9][\d.,，]*(?:\.\d+)?\s*(?:[kKwW万千])?)\s*人/);
  return match ? numberOr(match[1], 1) : 1;
}

function getDefaultXiaohongshuProfile(): XiaohongshuUserProfile {
  const identity = resolveUserIdentity(undefined, "xiaohongshu") ?? resolveUserIdentity();
  return {
    ...DEFAULT_XIAOHONGSHU_PROFILE,
    nickname: cleanText(identity?.name, 40) || DEFAULT_XIAOHONGSHU_PROFILE.nickname,
    gender: DEFAULT_XIAOHONGSHU_PROFILE.gender,
  };
}

export function normalizeXiaohongshuProfile(raw: unknown): XiaohongshuUserProfile {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const defaults = getDefaultXiaohongshuProfile();
  const nickname = cleanText(record.nickname, 40);
  const gender = cleanText(record.gender, 20);
  return {
    nickname: !nickname || nickname === LEGACY_DEFAULT_NICKNAME ? defaults.nickname : nickname,
    handle: cleanText(record.handle, 40) || defaults.handle,
    ipLocation: cleanText(record.ipLocation ?? record.ip_location, 40) || defaults.ipLocation,
    signature: cleanMultiline(record.signature ?? record.bio, 160) || defaults.signature,
    gender: !gender || gender === LEGACY_DEFAULT_GENDER ? defaults.gender : gender,
    followingCount: numberOr(record.followingCount ?? record.following_count, defaults.followingCount),
    followerCount: numberOr(record.followerCount ?? record.follower_count, defaults.followerCount),
    likedAndSavedCount: numberOr(record.likedAndSavedCount ?? record.liked_and_saved_count, defaults.likedAndSavedCount),
    coverImageAssetId: cleanText(record.coverImageAssetId ?? record.cover_image_asset_id, 160) || defaults.coverImageAssetId,
  };
}

export function normalizeXiaohongshuSettings(raw: unknown): XiaohongshuSettings {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const participantCharacterIds = Array.isArray(record.participantCharacterIds)
    ? record.participantCharacterIds.map(id => cleanText(id, 120)).filter(Boolean)
    : [];
  const probability = numberOr(record.sendToCharacterProbability, DEFAULT_XIAOHONGSHU_SETTINGS.sendToCharacterProbability);
  const npcFeedPrompt = cleanMultiline(record.npcFeedPrompt, 8000);
  return {
    bilingualTranslationEnabled: record.bilingualTranslationEnabled !== false,
    collapseBilingualTranslation: record.collapseBilingualTranslation !== false,
    bilingualTranslationPrompt: cleanMultiline(record.bilingualTranslationPrompt, 8000) || DEFAULT_XIAOHONGSHU_SETTINGS.bilingualTranslationPrompt,
    npcIdentityGuardPrompt: cleanMultiline(record.npcIdentityGuardPrompt, 8000) || DEFAULT_XIAOHONGSHU_SETTINGS.npcIdentityGuardPrompt,
    npcFeedPrompt: npcFeedPrompt && npcFeedPrompt.includes("#附近笔记") ? npcFeedPrompt : DEFAULT_XIAOHONGSHU_SETTINGS.npcFeedPrompt,
    npcUserPostReactionPrompt: cleanMultiline(record.npcUserPostReactionPrompt, 8000) || DEFAULT_XIAOHONGSHU_SETTINGS.npcUserPostReactionPrompt,
    npcCommentReplyPrompt: cleanMultiline(record.npcCommentReplyPrompt, 8000) || DEFAULT_XIAOHONGSHU_SETTINGS.npcCommentReplyPrompt,
    npcMoreCommentsPrompt: cleanMultiline(record.npcMoreCommentsPrompt, 8000) || DEFAULT_XIAOHONGSHU_SETTINGS.npcMoreCommentsPrompt,
    npcDmReplyPrompt: cleanMultiline(record.npcDmReplyPrompt, 8000) || DEFAULT_XIAOHONGSHU_SETTINGS.npcDmReplyPrompt,
    participantCharacterIds: Array.from(new Set(participantCharacterIds)),
    sendToCharacterProbability: Math.max(0, Math.min(100, probability)),
  };
}

export function normalizeXiaohongshuUserInteractions(raw: unknown): XiaohongshuUserInteractions {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    likedNoteIds: normalizeIdList(record.likedNoteIds ?? record.liked_note_ids),
    savedNoteIds: normalizeIdList(record.savedNoteIds ?? record.saved_note_ids),
    commentedNoteIds: normalizeIdList(record.commentedNoteIds ?? record.commented_note_ids),
  };
}

function normalizeXiaohongshuAccount(raw: unknown): XiaohongshuAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const type = record.type === "user" || record.type === "character" || record.type === "npc" ? record.type : "npc";
  const name = cleanText(record.name ?? record.authorName ?? record.nickname, 60);
  if (!name) return null;
  const id = cleanText(record.id ?? record.authorId ?? record.author_id, 120) || (type === "npc" ? makeXiaohongshuNpcId(name) : type);
  return {
    type,
    id,
    name,
    avatar: cleanText(record.avatar, 500) || undefined,
    followedAt: typeof record.followedAt === "string" ? record.followedAt : new Date().toISOString(),
  };
}

function dedupeAccounts(accounts: XiaohongshuAccount[]): XiaohongshuAccount[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    const key = `${account.type}:${account.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeXiaohongshuSocialGraph(raw: unknown): XiaohongshuSocialGraph {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const following = Array.isArray(record.following)
    ? record.following.map(normalizeXiaohongshuAccount).filter((account): account is XiaohongshuAccount => Boolean(account))
    : [];
  const followers = Array.isArray(record.followers)
    ? record.followers.map(normalizeXiaohongshuAccount).filter((account): account is XiaohongshuAccount => Boolean(account))
    : [];
  return {
    following: dedupeAccounts(following),
    followers: dedupeAccounts(followers),
  };
}

export function normalizeXiaohongshuComment(raw: unknown, fallbackNoteId = ""): XiaohongshuComment | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const noteId = cleanText(record.noteId ?? record.note_id, 160) || fallbackNoteId;
  const text = cleanMultiline(record.text ?? record.content ?? record.body, 600);
  const authorName = cleanText(record.authorName ?? record.author_name, 60);
  if (!noteId || !text || !authorName) return null;
  const id = cleanText(record.id, 180) || makeId("xhs_comment");
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString();
  return {
    id,
    noteId,
    authorType: record.authorType === "user" || record.authorType === "character" ? record.authorType : "npc",
    authorId: cleanText(record.authorId ?? record.author_id, 120) || makeXiaohongshuNpcId(authorName),
    authorName,
    text,
    replyTo: cleanText(record.replyTo ?? record.reply_to, 80) || undefined,
    replyToCommentId: cleanText(record.replyToCommentId ?? record.reply_to_comment_id, 180) || undefined,
    likeCount: numberOr(record.likeCount ?? record.like_count, 0),
    dislikeCount: numberOr(record.dislikeCount ?? record.dislike_count, 0),
    liked: record.liked === true,
    disliked: record.disliked === true,
    createdAt,
    unread: record.unread === true,
  };
}

export function normalizeXiaohongshuNote(raw: unknown): XiaohongshuNote | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanText(record.id, 160) || makeId("xhs_note");
  const title = cleanText(record.title, 80);
  const body = cleanMultiline(record.body ?? record.content ?? record.text, 3000);
  const authorName = cleanText(record.authorName ?? record.author_name, 60);
  if (!title && !body) return null;
  const comments = Array.isArray(record.comments)
    ? record.comments.map(comment => normalizeXiaohongshuComment(comment, id)).filter((comment): comment is XiaohongshuComment => Boolean(comment))
    : [];
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString();
  return {
    id,
    type: record.type === "video" ? "video" : "post",
    feedScope: record.feedScope === "nearby" || record.feed_scope === "nearby" ? "nearby" : "discover",
    source: record.source === "user" || record.source === "character" ? record.source : "npc",
    authorId: cleanText(record.authorId ?? record.author_id, 120) || makeXiaohongshuNpcId(authorName || "小红书用户"),
    authorName: authorName || "小红书用户",
    title: title || body.slice(0, 18) || "未命名笔记",
    body,
    videoDescription: cleanMultiline(record.videoDescription ?? record.video_description, 500) || undefined,
    coverIcon: cleanText(record.coverIcon ?? record.cover_icon, 8) || "✦",
    tone: record.tone === "mist" || record.tone === "blush" || record.tone === "graphite" ? record.tone : "ivory",
    tags: normalizeTags(record.tags),
    likeCount: numberOr(record.likeCount ?? record.like_count, 0),
    saveCount: numberOr(record.saveCount ?? record.save_count, 0),
    commentCount: numberOr(record.commentCount ?? record.comment_count, comments.length),
    liked: record.liked === true,
    saved: record.saved === true,
    recentLikeNames: normalizeNameList(record.recentLikeNames ?? record.recent_like_names),
    recentSaveNames: normalizeNameList(record.recentSaveNames ?? record.recent_save_names),
    comments,
    imageAssetId: cleanText(record.imageAssetId ?? record.image_asset_id, 160) || undefined,
    imageAssetIds: Array.isArray(record.imageAssetIds ?? record.image_asset_ids)
      ? (record.imageAssetIds ?? record.image_asset_ids as unknown[]).map(id => cleanText(id, 160)).filter(Boolean)
      : undefined,
    imageDescription: cleanMultiline(record.imageDescription ?? record.image_description, 500) || undefined,
    imageWidth: optionalPositiveNumber(record.imageWidth ?? record.image_width),
    imageHeight: optionalPositiveNumber(record.imageHeight ?? record.image_height),
    imageCompressedAt: typeof record.imageCompressedAt === "string" ? record.imageCompressedAt : undefined,
    imageCleanedAt: typeof record.imageCleanedAt === "string" ? record.imageCleanedAt : undefined,
    createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
  };
}

function normalizeNotification(raw: unknown): XiaohongshuNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const text = cleanMultiline(record.text, 600);
  const actorName = cleanText(record.actorName ?? record.actor_name, 60);
  if (!text || !actorName) return null;
  const type = record.type === "save" || record.type === "comment" || record.type === "dm" || record.type === "follow"
    ? record.type
    : "like";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString();
  const parsedCount = numberOr(
    record.count ?? record.actorCount ?? record.actor_count,
    type === "like" || type === "save" ? parseNotificationCountFromText(text) : 1,
  );
  return {
    id: cleanText(record.id, 160) || makeId("xhs_notice"),
    type,
    noteId: cleanText(record.noteId ?? record.note_id, 160) || undefined,
    actorName,
    text,
    count: type === "like" || type === "save" ? Math.max(1, Math.round(parsedCount)) : undefined,
    thumbnailText: cleanText(record.thumbnailText ?? record.thumbnail_text, 80) || undefined,
    direction: record.direction === "outgoing" ? "outgoing" : record.direction === "incoming" ? "incoming" : undefined,
    threadId: cleanText(record.threadId ?? record.thread_id, 180) || undefined,
    threadName: cleanText(record.threadName ?? record.thread_name, 60) || undefined,
    unread: record.unread !== false,
    createdAt,
  };
}

export function createDefaultXiaohongshuState(): XiaohongshuState {
  return {
    profile: getDefaultXiaohongshuProfile(),
    settings: { ...DEFAULT_XIAOHONGSHU_SETTINGS, participantCharacterIds: [] },
    notes: [],
    feedHiddenNoteIds: [],
    notifications: [],
    userInteractions: normalizeXiaohongshuUserInteractions(null),
    socialGraph: normalizeXiaohongshuSocialGraph(null),
    updatedAt: new Date().toISOString(),
  };
}

export function loadXiaohongshuState(): XiaohongshuState {
  if (typeof window === "undefined") return createDefaultXiaohongshuState();
  try {
    const raw = kvGet(XHS_STATE_KEY);
    if (!raw) return createDefaultXiaohongshuState();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.map(normalizeXiaohongshuNote).filter((note): note is XiaohongshuNote => Boolean(note))
      : [];
    const noteSourceById = new Map(notes.map(note => [note.id, note.source]));
    const notifications = Array.isArray(parsed.notifications)
      ? parsed.notifications
        .map(normalizeNotification)
        .filter((notice): notice is XiaohongshuNotification => Boolean(notice))
        .filter((notice) => {
          if (!notice.noteId) return true;
          const source = noteSourceById.get(notice.noteId);
          return !source || source === "user";
        })
      : [];
    const rawInteractions = parsed.userInteractions ?? parsed.user_interactions;
    const userInteractions = normalizeXiaohongshuUserInteractions(rawInteractions);
    if (!rawInteractions) {
      userInteractions.likedNoteIds = notes.filter(note => note.liked).map(note => note.id);
      userInteractions.savedNoteIds = notes.filter(note => note.saved).map(note => note.id);
      userInteractions.commentedNoteIds = notes.filter(note => note.comments.some(comment => comment.authorType === "user")).map(note => note.id);
    }
    return {
      profile: normalizeXiaohongshuProfile(parsed.profile),
      settings: normalizeXiaohongshuSettings(parsed.settings),
      notes,
      feedHiddenNoteIds: normalizeIdList(parsed.feedHiddenNoteIds ?? parsed.feed_hidden_note_ids),
      notifications,
      userInteractions,
      socialGraph: normalizeXiaohongshuSocialGraph(parsed.socialGraph ?? parsed.social_graph),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return createDefaultXiaohongshuState();
  }
}

export function saveXiaohongshuState(state: XiaohongshuState): XiaohongshuState {
  const next = { ...state, updatedAt: new Date().toISOString() };
  kvSet(XHS_STATE_KEY, JSON.stringify(next));
  return next;
}

export function createUserXiaohongshuNote(input: XiaohongshuUserPostInput, profile: XiaohongshuUserProfile): XiaohongshuNote {
  const now = new Date().toISOString();
  const imageAssetIds = (input.images && input.images.length > 0)
    ? input.images.map(img => img.assetId).filter((id): id is string => Boolean(id))
    : (input.image?.assetId ? [input.image.assetId] : undefined);
  const primaryImage = input.images?.[0] || input.image;
  return {
    id: makeId("xhs_user_note"),
    type: "post",
    source: "user",
    authorId: "user",
    authorName: profile.nickname || "我",
    title: cleanText(input.title, 80) || cleanMultiline(input.body, 120).slice(0, 24) || "新的笔记",
    body: cleanMultiline(input.body, 3000),
    coverIcon: (imageAssetIds && imageAssetIds.length > 0) || input.image?.assetId ? "▧" : "✎",
    tone: "ivory",
    tags: normalizeTags(input.tags),
    likeCount: 0,
    saveCount: 0,
    commentCount: 0,
    liked: false,
    saved: false,
    recentLikeNames: [],
    recentSaveNames: [],
    comments: [],
    imageAssetId: primaryImage?.assetId,
    imageAssetIds: imageAssetIds && imageAssetIds.length > 0 ? imageAssetIds : undefined,
    imageDescription: cleanMultiline(primaryImage?.description, 500) || undefined,
    imageWidth: optionalPositiveNumber(primaryImage?.width),
    imageHeight: optionalPositiveNumber(primaryImage?.height),
    createdAt: now,
    updatedAt: now,
  };
}

export function makeXiaohongshuComment(input: {
  noteId: string;
  authorType: "user" | "npc" | "character";
  authorId: string;
  authorName: string;
  text: string;
  replyTo?: string;
  replyToCommentId?: string;
  unread?: boolean;
}): XiaohongshuComment {
  return {
    id: makeId("xhs_comment"),
    noteId: input.noteId,
    authorType: input.authorType,
    authorId: input.authorId || (input.authorType === "npc" ? makeXiaohongshuNpcId(input.authorName) : input.authorType),
    authorName: cleanText(input.authorName, 60) || "小红书用户",
    text: cleanMultiline(input.text, 600),
    replyTo: cleanText(input.replyTo, 80) || undefined,
    replyToCommentId: cleanText(input.replyToCommentId, 180) || undefined,
    likeCount: 0,
    dislikeCount: 0,
    liked: false,
    disliked: false,
    createdAt: new Date().toISOString(),
    unread: input.unread === true,
  };
}

export function makeXiaohongshuNotification(input: Omit<XiaohongshuNotification, "id" | "createdAt">): XiaohongshuNotification {
  return {
    ...input,
    id: makeId("xhs_notice"),
    createdAt: new Date().toISOString(),
  };
}

export function addNames(existing: string[], names: string[]): string[] {
  return Array.from(new Set([...names, ...existing].map(name => cleanText(name, 24)).filter(Boolean))).slice(0, 2);
}
