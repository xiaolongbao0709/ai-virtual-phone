"use client";

import { chatDb } from "./chat-db";
import { updateChatMessage, type ChatMessage } from "./chat-storage";
import { estimateValueBytes } from "./data-management/serializers";
import { collectRoomImageRefs, listDwellingLayouts, saveDwellingLayout } from "./dwelling-storage";
import {
  cleanChatImage,
  cleanChatXiaohongshuShareImage,
  cleanupOrphanThemeAssets,
  isChatImageMessage,
  isChatXiaohongshuShareImage,
  listThemeAssetSummaries,
  scanAllStorageStrings,
  scannableSlice,
} from "./media-maintenance";
import {
  deleteMediaRef,
  isMediaStoreRef,
  listMediaCacheSummaries,
  loadMediaBlob,
  MEDIA_STORE_PROTOCOL,
} from "./media-cache-storage";
import { momentsDb } from "./moments-db";
import { hydrateMomentsStorage, updateMomentPost } from "./moments-storage";
import { deleteTrack, getAudioBlob, loadAllTracks } from "./music-storage";
import { deleteRawFile, hydrateReadingStorage, listRawFileSummaries, loadBooks } from "./reading-storage";
import { loadXiaohongshuState, saveXiaohongshuState } from "./xiaohongshu-storage";

/**
 * 「存储空间」引擎：把本机占用按用户能看懂的内容类别统计出来，并支持
 * 逐类清理（聊天类可按时间保留最近 N 天）。
 *
 * 边界（产品约定）：
 * - 只统计/清理用户自己产生的数据。任何清了之后要从站点重新下载的内容
 *   （内置 3D 世界模型、内置素材等）一律不出现在这里——重新拉取烧的是
 *   站点的流量额度。
 * - 清理动作全部走各业务模块自己的写路径（同步内存缓存），清完不需要
 *   重启应用。
 */

export type StorageCategoryId =
  | "chat_images"
  | "chat_voice"
  | "chat_media_files"
  | "moments_images"
  | "xiaohongshu_images"
  | "local_music"
  | "dwelling_images"
  | "theme_assets"
  | "reading_raw_files"
  | "orphan_media";

export type StorageCategoryStat = {
  id: StorageCategoryId;
  label: string;
  description: string;
  bytes: number;
  count: number;
  /** 支持「保留最近 N 天」粒度（按内容创建/最近使用时间） */
  supportsKeepDays: boolean;
};

export type StorageClearResult = {
  cleared: number;
  freedBytes: number;
};

const MEDIA_CACHE_DB = "AiPhoneMediaCacheDB";
// 刚写入还没被引用方保存的媒体（如生成中的图片）不能当孤儿删掉。
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

const CATEGORY_META: Record<StorageCategoryId, { label: string; description: string; supportsKeepDays: boolean }> = {
  chat_images: {
    label: "聊天图片",
    description: "聊天里收发和 AI 生成的图片。清理后聊天文字保留，图片显示为已清理。",
    supportsKeepDays: true,
  },
  chat_voice: {
    label: "语音消息",
    description: "聊天里的语音条和音频文件。清理后气泡保留但无法再播放。",
    supportsKeepDays: true,
  },
  chat_media_files: {
    label: "聊天视频与文件",
    description: "聊天里收发的视频和其他文件。清理后无法再打开。",
    supportsKeepDays: true,
  },
  moments_images: {
    label: "朋友圈图片",
    description: "朋友圈帖子里的真实图片。清理后帖子和文字保留。",
    supportsKeepDays: true,
  },
  xiaohongshu_images: {
    label: "小红书图片",
    description: "小红书笔记里的真实图片。清理后笔记文字保留。",
    supportsKeepDays: true,
  },
  local_music: {
    label: "本地音乐",
    description: "导入的本地音乐文件（不含在线音乐）。清理后需重新导入。",
    supportsKeepDays: true,
  },
  dwelling_images: {
    label: "栖所房间图",
    description: "栖所生成的房间效果图。清理后可以在栖所里重新生成。",
    supportsKeepDays: false,
  },
  theme_assets: {
    label: "主题素材",
    description: "壁纸、字体、图标等素材总占用。清理只删除确定无引用的旧素材，正在使用的不受影响。",
    supportsKeepDays: false,
  },
  reading_raw_files: {
    label: "阅读原始文件",
    description: "TXT/EPUB 导入后的原始文件（章节已单独入库，删除不影响阅读）。PDF 需要原文才能阅读，会自动保留。",
    supportsKeepDays: false,
  },
  orphan_media: {
    label: "残留媒体",
    description: "没有任何内容引用的遗留媒体文件，可以放心清理。",
    supportsKeepDays: false,
  },
};

function makeStat(id: StorageCategoryId, bytes: number, count: number): StorageCategoryStat {
  return { id, ...CATEGORY_META[id], bytes, count };
}

// ── 聊天媒体归类 ──

type ChatMediaClass = "image" | "voice" | "file";

function chatMediaClass(message: ChatMessage): ChatMediaClass | null {
  if (isChatXiaohongshuShareImage(message)) return "image";
  if (isChatImageMessage(message)) {
    return message.mediaUrl || message.mediaData?.imageGenerationMediaRef ? "image" : null;
  }
  if (!message.mediaUrl) return null;
  const fileType = message.mediaData?.fileType;
  if (message.mediaType === "audio" || (message.mediaType === "media_file" && fileType === "audio")) return "voice";
  if (message.mediaType === "video" || (message.mediaType === "media_file" && (fileType === "video" || fileType === "file"))) return "file";
  return null;
}

/** 同步版媒体尺寸：media-store 引用查摘要表（不加载 blob），dataURL 按字符串估算。
 *  统计路径必须保持"游标逐条 + 零 blob 加载"，否则重度用户（消息表里带
 *  语音 dataURL 音频）会在进入数据管理时整页 OOM 闪退。 */
function mediaRefBytes(ref: string | undefined, seen: Set<string>, mediaBytesById: Map<string, number>): number {
  if (!ref || seen.has(ref)) return 0;
  seen.add(ref);
  if (isMediaStoreRef(ref)) {
    return mediaBytesById.get(ref.slice(MEDIA_STORE_PROTOCOL.length)) ?? 0;
  }
  if (ref.startsWith("data:")) return estimateValueBytes(ref);
  return 0;
}

function chatMessageMediaBytes(
  message: ChatMessage,
  themeBytesById: Map<string, number>,
  mediaBytesById: Map<string, number>,
): number {
  const seen = new Set<string>();
  let bytes = 0;
  bytes += mediaRefBytes(message.mediaUrl, seen, mediaBytesById);
  bytes += mediaRefBytes(message.mediaData?.imageGenerationMediaRef, seen, mediaBytesById);
  const assetId = message.mediaData?.xiaohongshuImageAssetId;
  if (assetId) bytes += themeBytesById.get(assetId) ?? 0;
  return bytes;
}

// ── 孤儿媒体判定（全存储引用扫描，安全性与「清理未引用主题素材」同构） ──

const MEDIA_ID_RE = /mc_\d+_[a-z0-9]+/g;

async function collectOrphanMedia(): Promise<Array<{ id: string; bytes: number }>> {
  const summaries = await listMediaCacheSummaries();
  if (summaries.length === 0) return [];
  const known = new Set(summaries.map((item) => item.id));
  const referenced = new Set<string>();
  await scanAllStorageStrings((raw) => {
    if (!raw.includes("mc_")) return;
    const value = scannableSlice(raw);
    MEDIA_ID_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MEDIA_ID_RE.exec(value)) !== null) {
      if (known.has(match[0])) referenced.add(match[0]);
    }
  }, [MEDIA_CACHE_DB]);
  const now = Date.now();
  return summaries
    .filter((item) => !referenced.has(item.id) && now - item.createdAt >= ORPHAN_GRACE_MS)
    .map((item) => ({ id: item.id, bytes: item.bytes }));
}

// ── 扫描 ──

export async function scanStorageSpace(onProgress?: (detail: string) => void): Promise<StorageCategoryStat[]> {
  const stats: StorageCategoryStat[] = [];

  onProgress?.("统计主题素材…");
  const themeSummaries = await listThemeAssetSummaries().catch(() => []);
  const themeBytesById = new Map(themeSummaries.map((item) => [item.id, item.bytes] as const));
  stats.push(makeStat("theme_assets", themeSummaries.reduce((sum, item) => sum + item.bytes, 0), themeSummaries.length));

  onProgress?.("统计聊天媒体…");
  const mediaSummaries = await listMediaCacheSummaries().catch(() => []);
  const mediaBytesById = new Map(mediaSummaries.map((item) => [item.id, item.bytes] as const));
  const chatTotals: Record<ChatMediaClass, { bytes: number; count: number }> = {
    image: { bytes: 0, count: 0 },
    voice: { bytes: 0, count: 0 },
    file: { bytes: 0, count: 0 },
  };
  // 游标逐条：不再 toArray() 把整张消息表二次搬进内存（启动水合已有一份全量缓存，
  // 语音条的 dataURL 音频动辄数 MB，重度用户曾因此进数据管理页即 OOM 闪退）
  await chatDb.messages.each((message) => {
    const kind = chatMediaClass(message);
    if (!kind) return;
    const bytes = chatMessageMediaBytes(message, themeBytesById, mediaBytesById);
    if (bytes <= 0) return;
    chatTotals[kind].bytes += bytes;
    chatTotals[kind].count += 1;
  }).catch(() => undefined);
  stats.push(makeStat("chat_images", chatTotals.image.bytes, chatTotals.image.count));
  stats.push(makeStat("chat_voice", chatTotals.voice.bytes, chatTotals.voice.count));
  stats.push(makeStat("chat_media_files", chatTotals.file.bytes, chatTotals.file.count));

  onProgress?.("统计朋友圈图片…");
  await hydrateMomentsStorage().catch(() => undefined);
  let momentsBytes = 0;
  let momentsCount = 0;
  // 同聊天：游标逐条，避免整表二次进内存
  await momentsDb.posts.each((post) => {
    if (!post.photoUrl) return;
    const assetId = themeAssetIdFromUrl(post.photoUrl);
    const bytes = assetId
      ? themeBytesById.get(assetId) ?? 0
      : mediaRefBytes(post.photoUrl, new Set(), mediaBytesById);
    if (bytes <= 0) return;
    momentsBytes += bytes;
    momentsCount += 1;
  }).catch(() => undefined);
  stats.push(makeStat("moments_images", momentsBytes, momentsCount));

  onProgress?.("统计小红书图片…");
  const xhsState = loadXiaohongshuState();
  let xhsBytes = 0;
  let xhsCount = 0;
  for (const note of xhsState.notes) {
    if (!note.imageAssetId) continue;
    const bytes = themeBytesById.get(note.imageAssetId) ?? 0;
    if (bytes <= 0) continue;
    xhsBytes += bytes;
    xhsCount += 1;
  }
  stats.push(makeStat("xiaohongshu_images", xhsBytes, xhsCount));

  onProgress?.("统计本地音乐…");
  const tracks = await loadAllTracks().catch(() => []);
  let musicBytes = 0;
  let musicCount = 0;
  for (const track of tracks) {
    if (track.id.startsWith("netease_")) continue;
    const blob = await getAudioBlob(track.id).catch(() => null);
    if (!blob) continue;
    musicBytes += blob.size;
    musicCount += 1;
  }
  stats.push(makeStat("local_music", musicBytes, musicCount));

  onProgress?.("统计栖所房间图…");
  const layouts = await listDwellingLayouts();
  let dwellingBytes = 0;
  let dwellingCount = 0;
  for (const { layout } of layouts) {
    for (const ref of collectRoomImageRefs(layout)) {
      const stored = await loadMediaBlob(ref).catch(() => null);
      if (!stored) continue;
      dwellingBytes += stored.blob.size;
      dwellingCount += 1;
    }
  }
  stats.push(makeStat("dwelling_images", dwellingBytes, dwellingCount));

  onProgress?.("统计阅读原始文件…");
  const deletableRawFiles = await listDeletableRawFiles();
  stats.push(makeStat(
    "reading_raw_files",
    deletableRawFiles.reduce((sum, item) => sum + item.bytes, 0),
    deletableRawFiles.length,
  ));

  onProgress?.("扫描残留媒体（全库引用检查，需要一点时间）…");
  const orphans = await collectOrphanMedia().catch(() => []);
  stats.push(makeStat("orphan_media", orphans.reduce((sum, item) => sum + item.bytes, 0), orphans.length));

  return stats.sort((a, b) => b.bytes - a.bytes);
}

function themeAssetIdFromUrl(value: string | undefined): string | null {
  if (!value?.startsWith("asset://")) return null;
  return value.slice("asset://".length).trim() || null;
}

// ── 清理 ──

function cutoffMs(keepDays?: number): number {
  if (!keepDays || keepDays <= 0) return Number.POSITIVE_INFINITY; // 全部清理
  return Date.now() - keepDays * 24 * 60 * 60 * 1000;
}

function isBeforeCutoff(iso: string | undefined, cutoff: number): boolean {
  if (cutoff === Number.POSITIVE_INFINITY) return true;
  if (!iso) return true; // 没有时间戳的按最旧算
  const parsed = Date.parse(iso);
  return !Number.isFinite(parsed) || parsed < cutoff;
}

/** 语音/视频/文件消息：删掉媒体本体，保留气泡（时长、文件名等元信息不动）。 */
async function cleanChatGenericMedia(message: ChatMessage, nowIso: string): Promise<number> {
  const seen = new Set<string>();
  let freedBytes = 0;
  const ref = message.mediaUrl;
  if (ref && isMediaStoreRef(ref)) {
    const stored = await loadMediaBlob(ref).catch(() => null);
    freedBytes += stored?.blob.size ?? 0;
    await deleteMediaRef(ref).catch(() => undefined);
    seen.add(ref);
  } else if (ref) {
    freedBytes += estimateValueBytes(ref);
  }
  const nextMediaData: ChatMessage["mediaData"] = {
    ...message.mediaData,
    mediaCleanedAt: nowIso,
  };
  const cached = updateChatMessage(message.id, { mediaUrl: undefined, mediaData: nextMediaData });
  await chatDb.messages.put(cached ?? { ...message, mediaUrl: undefined, mediaData: nextMediaData });
  return freedBytes;
}

async function clearChatCategory(kind: ChatMediaClass, keepDays?: number): Promise<StorageClearResult> {
  const cutoff = cutoffMs(keepDays);
  const nowIso = new Date().toISOString();
  const messages = await chatDb.messages.toArray().catch(() => [] as ChatMessage[]);
  let cleared = 0;
  let freedBytes = 0;
  let strippedThemeAssetRefs = false;
  for (const message of messages) {
    if (chatMediaClass(message) !== kind) continue;
    if (!isBeforeCutoff(message.createdAt, cutoff)) continue;
    if (kind === "image") {
      if (isChatXiaohongshuShareImage(message)) {
        freedBytes += await cleanChatXiaohongshuShareImage(message, nowIso).catch(() => 0);
        strippedThemeAssetRefs = true;
      } else {
        freedBytes += await cleanChatImage(message, nowIso).catch(() => 0);
      }
    } else {
      freedBytes += await cleanChatGenericMedia(message, nowIso).catch(() => 0);
    }
    cleared += 1;
  }
  // 小红书分享图存在主题素材库里，剥掉引用后立刻回收孤儿素材，让释放真实发生。
  if (strippedThemeAssetRefs) {
    const orphan = await cleanupOrphanThemeAssets().catch(() => ({ deletedAssets: 0, freedBytes: 0 }));
    freedBytes += orphan.freedBytes;
  }
  return { cleared, freedBytes };
}

async function clearMomentsImages(keepDays?: number): Promise<StorageClearResult> {
  const cutoff = cutoffMs(keepDays);
  const nowIso = new Date().toISOString();
  await hydrateMomentsStorage().catch(() => undefined);
  const posts = await momentsDb.posts.toArray().catch(() => []);
  let cleared = 0;
  let freedBytes = 0;
  let strippedThemeAssetRefs = false;
  for (const post of posts) {
    if (!post.photoUrl) continue;
    if (!isBeforeCutoff(post.createdAt, cutoff)) continue;
    if (themeAssetIdFromUrl(post.photoUrl)) strippedThemeAssetRefs = true;
    else freedBytes += estimateValueBytes(post.photoUrl);
    const updated = updateMomentPost(post.id, { photoUrl: undefined, photoCleanedAt: nowIso });
    if (updated) await momentsDb.posts.put(updated);
    cleared += 1;
  }
  if (strippedThemeAssetRefs) {
    const orphan = await cleanupOrphanThemeAssets().catch(() => ({ deletedAssets: 0, freedBytes: 0 }));
    freedBytes += orphan.freedBytes;
  }
  if (cleared > 0 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("moments-updated"));
  }
  return { cleared, freedBytes };
}

async function clearXiaohongshuImages(keepDays?: number): Promise<StorageClearResult> {
  const cutoff = cutoffMs(keepDays);
  const nowIso = new Date().toISOString();
  let state = loadXiaohongshuState();
  let cleared = 0;
  for (const note of state.notes) {
    if (!note.imageAssetId) continue;
    if (!isBeforeCutoff(note.createdAt, cutoff)) continue;
    state = {
      ...state,
      notes: state.notes.map((item) => (item.id === note.id
        ? { ...item, imageAssetId: undefined, imageCleanedAt: nowIso, updatedAt: nowIso }
        : item)),
    };
    cleared += 1;
  }
  let freedBytes = 0;
  if (cleared > 0) {
    saveXiaohongshuState(state);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("xiaohongshu-updated"));
    const orphan = await cleanupOrphanThemeAssets().catch(() => ({ deletedAssets: 0, freedBytes: 0 }));
    freedBytes = orphan.freedBytes;
  }
  return { cleared, freedBytes };
}

async function clearLocalMusic(keepDays?: number): Promise<StorageClearResult> {
  const cutoff = cutoffMs(keepDays);
  const tracks = await loadAllTracks().catch(() => []);
  let cleared = 0;
  let freedBytes = 0;
  for (const track of tracks) {
    if (track.id.startsWith("netease_")) continue;
    if (!isBeforeCutoff(track.lastPlayedAt || track.addedAt, cutoff)) continue;
    const blob = await getAudioBlob(track.id).catch(() => null);
    await deleteTrack(track.id).catch(() => undefined);
    cleared += 1;
    freedBytes += blob?.size ?? 0;
  }
  if (cleared > 0 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("music-library-updated"));
  }
  return { cleared, freedBytes };
}

async function clearDwellingImages(): Promise<StorageClearResult> {
  const layouts = await listDwellingLayouts();
  let cleared = 0;
  let freedBytes = 0;
  for (const { characterId, layout } of layouts) {
    const refs = collectRoomImageRefs(layout);
    if (refs.length === 0) continue;
    for (const ref of refs) {
      const stored = await loadMediaBlob(ref).catch(() => null);
      freedBytes += stored?.blob.size ?? 0;
      await deleteMediaRef(ref).catch(() => undefined);
      cleared += 1;
    }
    const nextLayout = {
      ...layout,
      rooms: layout.rooms.map((room) => (room.imageAssetId ? { ...room, imageAssetId: undefined } : room)),
    };
    await saveDwellingLayout(characterId, nextLayout);
  }
  return { cleared, freedBytes };
}

/** 可删除的原始文件 = 非 PDF 书的原件（TXT/EPUB 章节已入库）+ 书已删除的孤儿原件。
 *  PDF 的正文渲染和章节懒解析都要现读原文件，删了书就打不开了，必须保留。 */
async function listDeletableRawFiles(): Promise<Array<{ bookId: string; bytes: number }>> {
  const [summaries] = await Promise.all([
    listRawFileSummaries(),
    hydrateReadingStorage().catch(() => undefined),
  ]);
  if (summaries.length === 0) return [];
  const pdfBookIds = new Set(loadBooks().filter((book) => book.format === "pdf").map((book) => book.id));
  return summaries.filter((item) => !pdfBookIds.has(item.bookId));
}

async function clearReadingRawFiles(): Promise<StorageClearResult> {
  const deletable = await listDeletableRawFiles();
  let cleared = 0;
  let freedBytes = 0;
  for (const item of deletable) {
    try {
      await deleteRawFile(item.bookId);
    } catch {
      continue;
    }
    cleared += 1;
    freedBytes += item.bytes;
  }
  return { cleared, freedBytes };
}

async function clearOrphanMedia(): Promise<StorageClearResult> {
  const orphans = await collectOrphanMedia();
  let cleared = 0;
  let freedBytes = 0;
  for (const orphan of orphans) {
    // 单个删除失败不中断整批，下次扫描还会看到它。
    try {
      await deleteMediaRef(`media-store://${orphan.id}`);
    } catch {
      continue;
    }
    cleared += 1;
    freedBytes += orphan.bytes;
  }
  return { cleared, freedBytes };
}

export async function clearStorageCategory(
  id: StorageCategoryId,
  options: { keepDays?: number } = {},
): Promise<StorageClearResult> {
  switch (id) {
    case "chat_images": return clearChatCategory("image", options.keepDays);
    case "chat_voice": return clearChatCategory("voice", options.keepDays);
    case "chat_media_files": return clearChatCategory("file", options.keepDays);
    case "moments_images": return clearMomentsImages(options.keepDays);
    case "xiaohongshu_images": return clearXiaohongshuImages(options.keepDays);
    case "local_music": return clearLocalMusic(options.keepDays);
    case "dwelling_images": return clearDwellingImages();
    case "theme_assets": {
      const result = await cleanupOrphanThemeAssets();
      return { cleared: result.deletedAssets, freedBytes: result.freedBytes };
    }
    case "reading_raw_files": return clearReadingRawFiles();
    case "orphan_media": return clearOrphanMedia();
  }
}
