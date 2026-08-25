"use client";

import { chatDb } from "./chat-db";
import { updateChatMessage, type ChatMessage } from "./chat-storage";
import { DATA_MODULES } from "./data-management/modules";
import { estimateValueBytes } from "./data-management/serializers";
import { openIndexedDbAtLeast } from "./idb-open";
import { hydrateKvDb, isKvHydrated, kvEntries, kvGet, kvSet, registerKvMigration } from "./kv-db";
import { deleteMediaRef, isMediaStoreRef, loadMediaBlob, storeMediaBlob } from "./media-cache-storage";
import { getAudioBlob, deleteTrack, loadAllTracks } from "./music-storage";
import { momentsDb } from "./moments-db";
import { hydrateMomentsStorage, updateMomentPost } from "./moments-storage";
import {
  collectThemeAssetIds,
  deleteThemeAsset,
  readThemeAssetRecords,
  readThemeProfile,
  saveThemeAssetFromBlob,
  writeThemeAssetRecords,
  type ThemeAssetRecord,
} from "./theme-storage";
import { loadXiaohongshuState, saveXiaohongshuState } from "./xiaohongshu-storage";
import type { XiaohongshuNote, XiaohongshuState } from "./xiaohongshu-types";

export type MediaMaintenanceConfig = {
  enabled: boolean;
};

export type OrphanThemeCleanupResult = {
  deletedAssets: number;
  freedBytes: number;
};

export type MediaMaintenanceResult = OrphanThemeCleanupResult & {
  startedAt: string;
  finishedAt: string;
  chatImagesCompressed: number;
  chatImagesCleaned: number;
  momentImagesCompressed: number;
  momentImagesCleaned: number;
  xiaohongshuImagesCompressed: number;
  xiaohongshuImagesCleaned: number;
  musicTracksCleaned: number;
};

export type MediaMaintenanceState = {
  lastRunAt?: string;
  lastAutoRunAt?: string;
  lastResult?: MediaMaintenanceResult;
  lastError?: string;
};

const CONFIG_KEY = "ai_phone_media_maintenance_config_v1";
const STATE_KEY = "ai_phone_media_maintenance_state_v1";
const COMPRESS_AFTER_MS = 4 * 24 * 60 * 60 * 1000;
const CLEAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;
const IMAGE_MAX_SIDE = 1280;
const IMAGE_QUALITY = 0.82;
const THEME_DB_NAME = "ai_phone_theme_db_v1";
const THEME_DB_VERSION = 2;
const THEME_ASSET_STORE = "assets";

export const DEFAULT_MEDIA_MAINTENANCE_CONFIG: MediaMaintenanceConfig = {
  enabled: false,
};

registerKvMigration(CONFIG_KEY);
registerKvMigration(STATE_KEY);

let activeRun: Promise<MediaMaintenanceResult> | null = null;

function hasBrowserApi(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function parseJsonObject<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as T : null;
  } catch {
    return null;
  }
}

export function loadMediaMaintenanceConfig(): MediaMaintenanceConfig {
  const parsed = parseJsonObject<Partial<MediaMaintenanceConfig>>(kvGet(CONFIG_KEY));
  return {
    enabled: parsed?.enabled === true,
  };
}

export function saveMediaMaintenanceConfig(config: MediaMaintenanceConfig): MediaMaintenanceConfig {
  const next = { enabled: config.enabled === true };
  kvSet(CONFIG_KEY, JSON.stringify(next));
  return next;
}

export function loadMediaMaintenanceState(): MediaMaintenanceState {
  return parseJsonObject<MediaMaintenanceState>(kvGet(STATE_KEY)) ?? {};
}

function saveMediaMaintenanceState(state: MediaMaintenanceState): MediaMaintenanceState {
  kvSet(STATE_KEY, JSON.stringify(state));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("media-maintenance-updated", { detail: state }));
  }
  return state;
}

function isOlderThan(value: string | undefined, thresholdMs: number, nowMs: number): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && nowMs - time >= thresholdMs;
}

function isDataImageUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^data:image\//i.test(value);
}

function dataUrlMimeType(dataUrl: string): string {
  return /^data:([^;]+);/i.exec(dataUrl)?.[1] ?? "image/png";
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
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
      reject(new Error("Failed to decode image"));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode image"));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

async function compressImageBlob(blob: Blob): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const sourceMime = (blob.type || "").toLowerCase();
  if (!sourceMime.startsWith("image/")) return null;
  if (sourceMime === "image/gif" || sourceMime === "image/svg+xml") return null;

  const image = await loadImageFromBlob(blob);
  const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = largestSide > IMAGE_MAX_SIDE ? IMAGE_MAX_SIDE / largestSide : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);

  const outputMime = sourceMime === "image/png"
    ? "image/png"
    : sourceMime === "image/webp"
      ? "image/webp"
      : "image/jpeg";
  const quality = outputMime === "image/png" ? undefined : IMAGE_QUALITY;
  const encoded = await canvasToBlob(canvas, outputMime, quality);
  return encoded.size < blob.size * 0.95 ? encoded : null;
}

async function deleteMediaRefWithSize(ref: string | undefined, seen: Set<string>): Promise<number> {
  if (!ref || !isMediaStoreRef(ref) || seen.has(ref)) return 0;
  seen.add(ref);
  const existing = await loadMediaBlob(ref).catch(() => null);
  await deleteMediaRef(ref).catch(() => undefined);
  return existing?.blob.size ?? 0;
}

export function isChatImageMessage(message: ChatMessage): boolean {
  return message.mediaType === "image"
    || (message.mediaType === "media_file" && message.mediaData?.fileType === "image");
}

export function isChatXiaohongshuShareImage(message: ChatMessage): boolean {
  return message.mediaType === "xiaohongshu_note_share" && Boolean(message.mediaData?.xiaohongshuImageAssetId);
}

async function persistChatMediaPatch(
  message: ChatMessage,
  patch: Partial<Pick<ChatMessage, "content" | "mediaType" | "mediaUrl" | "mediaData">>,
): Promise<void> {
  const nextMessage: ChatMessage = { ...message, ...patch };
  const cached = updateChatMessage(message.id, patch);
  await chatDb.messages.put(cached ?? nextMessage);
}

async function compactChatImage(message: ChatMessage, nowIso: string): Promise<{ changed: boolean; freedBytes: number }> {
  const mediaUrl = message.mediaUrl;
  const mediaRef = message.mediaData?.imageGenerationMediaRef;
  let sourceBlob: Blob | null = null;
  let sourceMime = "image/jpeg";
  let sourceRef: string | null = null;
  let oldBytes = 0;
  const refsToDelete = new Set<string>();

  if (mediaRef && isMediaStoreRef(mediaRef)) {
    const stored = await loadMediaBlob(mediaRef).catch(() => null);
    if (stored?.category === "image") {
      sourceBlob = stored.blob;
      sourceMime = stored.mimeType || stored.blob.type || sourceMime;
      sourceRef = mediaRef;
      oldBytes += stored.blob.size;
      refsToDelete.add(mediaRef);
    }
  }

  if (mediaUrl && isMediaStoreRef(mediaUrl)) {
    const stored = await loadMediaBlob(mediaUrl).catch(() => null);
    if (stored?.category === "image") {
      if (!sourceBlob) {
        sourceBlob = stored.blob;
        sourceRef = mediaUrl;
      }
      sourceMime = stored.mimeType || stored.blob.type || sourceMime;
      if (!refsToDelete.has(mediaUrl)) oldBytes += stored.blob.size;
      refsToDelete.add(mediaUrl);
    }
  } else if (isDataImageUrl(mediaUrl)) {
    const dataBlob = await dataUrlToBlob(mediaUrl);
    sourceBlob ??= dataBlob;
    sourceMime = dataBlob.type || dataUrlMimeType(mediaUrl);
    oldBytes += estimateValueBytes(mediaUrl);
  }

  if (!sourceBlob) return { changed: false, freedBytes: 0 };

  const compressed = await compressImageBlob(sourceBlob).catch(() => null);
  const nextBlob = compressed ?? sourceBlob;
  const nextMime = nextBlob.type || sourceMime;
  const nextRef = compressed || !sourceRef ? await storeMediaBlob(nextBlob, nextMime, "image") : sourceRef;
  if (sourceRef && nextRef === sourceRef) refsToDelete.delete(sourceRef);
  const deletedSeen = new Set<string>();
  for (const ref of refsToDelete) {
    await deleteMediaRefWithSize(ref, deletedSeen);
  }
  const nextMediaData: ChatMessage["mediaData"] = {
    ...message.mediaData,
    fileType: "image",
    mediaCompressedAt: nowIso,
  };
  if (message.mediaData?.imageGenerationMediaRef) {
    nextMediaData.imageGenerationMediaRef = nextRef;
  }
  const nextMessage: ChatMessage = {
    ...message,
    mediaUrl: nextRef,
    mediaData: nextMediaData,
  };
  const cached = updateChatMessage(message.id, {
    mediaUrl: nextMessage.mediaUrl,
    mediaData: nextMessage.mediaData,
  });
  await chatDb.messages.put(cached ?? nextMessage);
  const beforeBytes = oldBytes || sourceBlob.size;
  return { changed: compressed !== null || mediaUrl !== nextRef, freedBytes: Math.max(0, beforeBytes - nextBlob.size) };
}

async function compactChatXiaohongshuShareImage(message: ChatMessage, nowIso: string): Promise<{ changed: boolean; freedBytes: number }> {
  const assetId = message.mediaData?.xiaohongshuImageAssetId;
  if (!assetId) return { changed: false, freedBytes: 0 };
  const compressed = await compressThemeAssetById(assetId).catch(() => ({ changed: false, freedBytes: 0 }));
  await persistChatMediaPatch(message, {
    mediaData: {
      ...message.mediaData,
      mediaCompressedAt: nowIso,
    },
  });
  return compressed;
}

export async function cleanChatImage(message: ChatMessage, nowIso: string): Promise<number> {
  const seen = new Set<string>();
  let freedBytes = 0;
  freedBytes += await deleteMediaRefWithSize(message.mediaUrl, seen);
  freedBytes += await deleteMediaRefWithSize(message.mediaData?.imageGenerationMediaRef, seen);
  const nextMediaData: ChatMessage["mediaData"] = {
    ...message.mediaData,
    mediaCleanedAt: nowIso,
  };
  delete nextMediaData.imageGenerationMediaRef;
  const nextMessage: ChatMessage = {
    ...message,
    mediaUrl: undefined,
    mediaData: nextMediaData,
  };
  const cached = updateChatMessage(message.id, {
    mediaUrl: undefined,
    mediaData: nextMessage.mediaData,
  });
  await chatDb.messages.put(cached ?? nextMessage);
  return freedBytes + estimateValueBytes(message.mediaUrl);
}

export async function cleanChatXiaohongshuShareImage(message: ChatMessage, nowIso: string): Promise<number> {
  const assetId = message.mediaData?.xiaohongshuImageAssetId;
  const nextMediaData: ChatMessage["mediaData"] = {
    ...message.mediaData,
    mediaCleanedAt: nowIso,
  };
  delete nextMediaData.xiaohongshuImageAssetId;
  await persistChatMediaPatch(message, { mediaData: nextMediaData });
  return estimateValueBytes(assetId);
}

async function runChatImageMaintenance(result: MediaMaintenanceResult, nowMs: number, nowIso: string): Promise<void> {
  const messages = await chatDb.messages.toArray().catch(() => []);
  for (const message of messages) {
    const isRegularImage = isChatImageMessage(message);
    const isXiaohongshuShareImage = isChatXiaohongshuShareImage(message);
    if (!isRegularImage && !isXiaohongshuShareImage) continue;
    if (isRegularImage && !message.mediaUrl && !message.mediaData?.imageGenerationMediaRef) continue;
    if (isOlderThan(message.createdAt, CLEAN_AFTER_MS, nowMs)) {
      result.freedBytes += isXiaohongshuShareImage
        ? await cleanChatXiaohongshuShareImage(message, nowIso).catch(() => 0)
        : await cleanChatImage(message, nowIso).catch(() => 0);
      result.chatImagesCleaned += 1;
      continue;
    }
    if (!message.mediaData?.mediaCompressedAt && isOlderThan(message.createdAt, COMPRESS_AFTER_MS, nowMs)) {
      const compacted = isXiaohongshuShareImage
        ? await compactChatXiaohongshuShareImage(message, nowIso).catch(() => ({ changed: false, freedBytes: 0 }))
        : await compactChatImage(message, nowIso).catch(() => ({ changed: false, freedBytes: 0 }));
      result.freedBytes += compacted.freedBytes;
      if (compacted.changed) result.chatImagesCompressed += 1;
    }
  }
}

function themeAssetIdFromUrl(value: string | undefined): string | null {
  if (!value?.startsWith("asset://")) return null;
  return value.slice("asset://".length).trim() || null;
}

async function compressThemeAssetById(assetId: string): Promise<{ changed: boolean; freedBytes: number }> {
  const [record] = await readThemeAssetRecords([assetId]);
  if (!record || !isDataImageUrl(record.dataUrl)) return { changed: false, freedBytes: 0 };
  const sourceBlob = await dataUrlToBlob(record.dataUrl);
  const compressed = await compressImageBlob(sourceBlob).catch(() => null);
  if (!compressed) return { changed: false, freedBytes: 0 };
  const nextDataUrl = await blobToDataUrl(compressed);
  await writeThemeAssetRecords([{
    ...record,
    dataUrl: nextDataUrl,
    mimeType: compressed.type || record.mimeType,
    updatedAt: new Date().toISOString(),
  }]);
  return {
    changed: true,
    freedBytes: Math.max(0, estimateValueBytes(record.dataUrl) - estimateValueBytes(nextDataUrl)),
  };
}

async function compactDataUrlToThemeAsset(dataUrl: string): Promise<{ ref: string; freedBytes: number } | null> {
  if (!isDataImageUrl(dataUrl)) return null;
  const sourceBlob = await dataUrlToBlob(dataUrl);
  const compressed = await compressImageBlob(sourceBlob).catch(() => null);
  const nextBlob = compressed ?? sourceBlob;
  const assetId = await saveThemeAssetFromBlob(nextBlob, "chat_bg");
  return {
    ref: `asset://${assetId}`,
    freedBytes: Math.max(0, estimateValueBytes(dataUrl) - nextBlob.size),
  };
}

async function runMomentImageMaintenance(result: MediaMaintenanceResult, nowMs: number, nowIso: string): Promise<void> {
  await hydrateMomentsStorage().catch(() => undefined);
  const posts = await momentsDb.posts.toArray().catch(() => []);
  for (const post of posts) {
    if (!post.photoUrl) continue;
    if (isOlderThan(post.createdAt, CLEAN_AFTER_MS, nowMs)) {
      const updated = updateMomentPost(post.id, { photoUrl: undefined, photoCleanedAt: nowIso });
      if (updated) await momentsDb.posts.put(updated);
      result.freedBytes += estimateValueBytes(post.photoUrl);
      result.momentImagesCleaned += 1;
      continue;
    }
    if (post.photoCompressedAt || !isOlderThan(post.createdAt, COMPRESS_AFTER_MS, nowMs)) continue;
    const assetId = themeAssetIdFromUrl(post.photoUrl);
    if (assetId) {
      const compressed = await compressThemeAssetById(assetId).catch(() => ({ changed: false, freedBytes: 0 }));
      const updated = updateMomentPost(post.id, { photoCompressedAt: nowIso });
      if (updated) await momentsDb.posts.put(updated);
      result.freedBytes += compressed.freedBytes;
      if (compressed.changed) result.momentImagesCompressed += 1;
      continue;
    }
    if (isDataImageUrl(post.photoUrl)) {
      const compacted = await compactDataUrlToThemeAsset(post.photoUrl).catch(() => null);
      if (compacted) {
        const updated = updateMomentPost(post.id, { photoUrl: compacted.ref, photoCompressedAt: nowIso });
        if (updated) await momentsDb.posts.put(updated);
        result.freedBytes += compacted.freedBytes;
        result.momentImagesCompressed += 1;
      }
    }
  }
  if (result.momentImagesCleaned > 0 || result.momentImagesCompressed > 0) {
    window.dispatchEvent(new CustomEvent("moments-updated"));
  }
}

function updateXiaohongshuStateNotes(
  state: XiaohongshuState,
  updater: (note: XiaohongshuNote) => XiaohongshuNote,
): XiaohongshuState {
  return {
    ...state,
    notes: state.notes.map(updater),
  };
}

async function runXiaohongshuImageMaintenance(result: MediaMaintenanceResult, nowMs: number, nowIso: string): Promise<void> {
  let state = loadXiaohongshuState();
  let changed = false;

  for (const note of state.notes) {
    if (!note.imageAssetId) continue;
    if (isOlderThan(note.createdAt, CLEAN_AFTER_MS, nowMs)) {
      state = updateXiaohongshuStateNotes(state, item =>
        item.id === note.id ? { ...item, imageAssetId: undefined, imageCleanedAt: nowIso, updatedAt: nowIso } : item
      );
      result.xiaohongshuImagesCleaned += 1;
      changed = true;
      continue;
    }
    if (note.imageCompressedAt || !isOlderThan(note.createdAt, COMPRESS_AFTER_MS, nowMs)) continue;
    const compressed = await compressThemeAssetById(note.imageAssetId).catch(() => ({ changed: false, freedBytes: 0 }));
    state = updateXiaohongshuStateNotes(state, item =>
      item.id === note.id ? { ...item, imageCompressedAt: nowIso, updatedAt: nowIso } : item
    );
    result.freedBytes += compressed.freedBytes;
    if (compressed.changed) result.xiaohongshuImagesCompressed += 1;
    changed = true;
  }

  if (changed) {
    saveXiaohongshuState(state);
    window.dispatchEvent(new CustomEvent("xiaohongshu-updated"));
  }
}

async function runMusicMaintenance(result: MediaMaintenanceResult, nowMs: number): Promise<void> {
  const tracks = await loadAllTracks();
  for (const track of tracks) {
    if (track.id.startsWith("netease_")) continue;
    const basis = track.lastPlayedAt || track.addedAt;
    if (!isOlderThan(basis, CLEAN_AFTER_MS, nowMs)) continue;
    const blob = await getAudioBlob(track.id).catch(() => null);
    await deleteTrack(track.id).catch(() => undefined);
    result.musicTracksCleaned += 1;
    result.freedBytes += blob?.size ?? 0;
  }
  if (result.musicTracksCleaned > 0) {
    window.dispatchEvent(new CustomEvent("music-library-updated"));
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function openExistingDb(name: string): Promise<IDBDatabase | null> {
  if (!hasBrowserApi()) return null;
  return new Promise((resolve) => {
    let created = false;
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      const db = request.result;
      if (created) {
        db.close();
        resolve(null);
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export type ThemeAssetSummary = { id: string; bytes: number };

/** 用游标逐条读取，只保留 id 和字节数——getAll() 会把所有素材的完整
 *  dataUrl（壁纸/VN 场景可达数百 MB）一次性载入内存，手机上会 OOM 假死。 */
export async function listThemeAssetSummaries(): Promise<ThemeAssetSummary[]> {
  if (!hasBrowserApi()) return [];
  const db = await openIndexedDbAtLeast(THEME_DB_NAME, THEME_DB_VERSION, (database) => {
    if (!database.objectStoreNames.contains(THEME_ASSET_STORE)) {
      database.createObjectStore(THEME_ASSET_STORE, { keyPath: "id" });
    }
  }).catch(() => null);
  if (!db || !db.objectStoreNames.contains(THEME_ASSET_STORE)) return [];
  try {
    const tx = db.transaction(THEME_ASSET_STORE, "readonly");
    const request = tx.objectStore(THEME_ASSET_STORE).openCursor();
    const summaries: ThemeAssetSummary[] = [];
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value as Partial<ThemeAssetRecord> | undefined;
        if (record?.id) {
          summaries.push({ id: record.id, bytes: estimateValueBytes(record.dataUrl) });
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await transactionDone(tx);
    return summaries;
  } finally {
    db.close();
  }
}

const THEME_ASSET_ID_RE = /(?:wallpaper|icon_skin|dock_skin|font|bg|chat_bg|sticker|vn_scene|vn_sprite)_[A-Za-z0-9_-]+/g;
const ASSET_URL_RE = /asset:\/\/([A-Za-z0-9_-]+)/g;

/** base64 载荷（字符集 A-Za-z0-9+/=）不可能含 "_" 或 ":"，上面两个正则永远
 *  不会在其中命中。聊天/素材里的 data URL 动辄数 MB，跳过载荷只扫头部，
 *  是「清理未引用素材」从分钟级假死降到秒级的关键。 */
export function scannableSlice(value: string): string {
  if (!value.startsWith("data:")) return value;
  const marker = value.indexOf(";base64,");
  return marker !== -1 && marker < 256 ? value.slice(0, marker) : value;
}

function scanStringForAssetIds(rawValue: string, knownIds: Set<string>, referenced: Set<string>): void {
  if (knownIds.has(rawValue)) referenced.add(rawValue);
  const value = scannableSlice(rawValue);

  ASSET_URL_RE.lastIndex = 0;
  let assetMatch: RegExpExecArray | null;
  while ((assetMatch = ASSET_URL_RE.exec(value)) !== null) {
    const id = assetMatch[1];
    if (knownIds.has(id)) referenced.add(id);
  }

  THEME_ASSET_ID_RE.lastIndex = 0;
  let idMatch: RegExpExecArray | null;
  while ((idMatch = THEME_ASSET_ID_RE.exec(value)) !== null) {
    const id = idMatch[0];
    if (knownIds.has(id)) referenced.add(id);
  }
}

/** 深扫任意结构里的每个字符串叶子。scan 回调自己决定匹配什么 id。 */
export type StorageStringScanner = (value: string) => void;

function scanValueWithScanner(value: unknown, scan: StorageStringScanner, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    scan(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => scanValueWithScanner(item, scan, seen));
    return;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    scanValueWithScanner(nested, scan, seen);
  }
}

async function scanIndexedDbSourceWithScanner(dbName: string, scan: StorageStringScanner): Promise<void> {
  const db = await openExistingDb(dbName);
  if (!db) return;
  try {
    for (const storeName of Array.from(db.objectStoreNames)) {
      // 每个 store 之间让出事件循环：游标回调里的扫描是同步的，
      // 连续跑多个大 store 会长时间冻结 UI，看起来像按钮卡死。
      await new Promise(resolve => setTimeout(resolve, 0));
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const request = store.openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          scanValueWithScanner(cursor.primaryKey, scan);
          scanValueWithScanner(cursor.value, scan);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
      await transactionDone(tx);
    }
  } finally {
    db.close();
  }
}

/** 扫描整个应用存储（kv、localStorage、所有已注册模块的 IndexedDB）里的
 *  每个字符串，供「谁还引用这个资源」类的孤儿判定使用。孤儿清理的安全性
 *  完全依赖这里覆盖到所有可能藏引用的地方——新增存储位置时必须登记进
 *  data-management/modules.ts（本函数按那份契约遍历）。 */
export async function scanAllStorageStrings(scan: StorageStringScanner, excludeDbNames: string[] = []): Promise<void> {
  for (const { key, value } of kvEntries()) {
    scan(key);
    // JSON 值走结构化深扫（每个字符串叶子都会被扫到），不再对原始 JSON 串
    // 整体重扫一遍——大值双重扫描是清理假死的帮凶之一。
    try {
      scanValueWithScanner(JSON.parse(value), scan);
    } catch {
      scan(value);
    }
  }

  if (typeof localStorage !== "undefined") {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      scan(key);
      scan(localStorage.getItem(key) ?? "");
    }
  }

  const excluded = new Set(excludeDbNames);
  const indexedDbNames = new Set<string>();
  for (const dataModule of DATA_MODULES) {
    for (const source of dataModule.sources) {
      if (source.type === "indexeddb" && !excluded.has(source.dbName)) {
        indexedDbNames.add(source.dbName);
      }
    }
  }
  for (const dbName of indexedDbNames) {
    await scanIndexedDbSourceWithScanner(dbName, scan).catch(() => undefined);
  }
}

async function collectReferencedThemeAssetIds(knownIds: Set<string>): Promise<Set<string>> {
  const referenced = new Set<string>();

  for (const id of collectThemeAssetIds(readThemeProfile())) {
    if (knownIds.has(id)) referenced.add(id);
  }

  await scanAllStorageStrings((value) => scanStringForAssetIds(value, knownIds, referenced), [THEME_DB_NAME]);

  return referenced;
}

export async function cleanupOrphanThemeAssets(): Promise<OrphanThemeCleanupResult> {
  if (!hasBrowserApi()) return { deletedAssets: 0, freedBytes: 0 };

  // 孤儿判定的安全性完全依赖"扫到了所有引用"。表情包/壁纸/字体等的引用都记在
  // kv 里，而 kvEntries() 读的是内存缓存——自动维护在启动 45 秒后就会跑，慢设备
  // 上 kv 可能还没水合完，此时扫描是空的，全部素材都会被误判成孤儿一波删光
  // （用户实报：133 个表情包名字都在、图全没了）。未水合宁可跳过本次清理。
  await hydrateKvDb().catch(() => {});
  if (!isKvHydrated()) return { deletedAssets: 0, freedBytes: 0 };

  const summaries = await listThemeAssetSummaries();
  if (summaries.length === 0) return { deletedAssets: 0, freedBytes: 0 };
  const knownIds = new Set(summaries.map(summary => summary.id));
  const referenced = await collectReferencedThemeAssetIds(knownIds);

  // 理智检查：素材库非空但一条引用都没扫到，几乎必然是扫描侧出了问题
  // （存储读取异常、缓存为空等），而不是用户真把所有主题内容都删了。
  // 误删不可恢复，这种情况放弃本次清理。
  if (referenced.size === 0) return { deletedAssets: 0, freedBytes: 0 };

  let deletedAssets = 0;
  let freedBytes = 0;

  for (const summary of summaries) {
    if (referenced.has(summary.id)) continue;
    // 单个删除失败不中断整批，跳过即可（下次清理还会再见到它）
    try {
      await deleteThemeAsset(summary.id);
    } catch {
      continue;
    }
    deletedAssets += 1;
    freedBytes += summary.bytes;
  }

  return { deletedAssets, freedBytes };
}

function createEmptyResult(startedAt: string): MediaMaintenanceResult {
  return {
    startedAt,
    finishedAt: startedAt,
    chatImagesCompressed: 0,
    chatImagesCleaned: 0,
    momentImagesCompressed: 0,
    momentImagesCleaned: 0,
    xiaohongshuImagesCompressed: 0,
    xiaohongshuImagesCleaned: 0,
    musicTracksCleaned: 0,
    deletedAssets: 0,
    freedBytes: 0,
  };
}

function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatMediaMaintenanceResult(result: MediaMaintenanceResult): string {
  const dynamicChanged = result.chatImagesCompressed
    + result.chatImagesCleaned
    + result.momentImagesCompressed
    + result.momentImagesCleaned
    + result.xiaohongshuImagesCompressed
    + result.xiaohongshuImagesCleaned
    + result.musicTracksCleaned
    + result.deletedAssets;
  if (dynamicChanged === 0) return "没有发现需要清理的过期媒体或孤儿主题素材。";
  return [
    `聊天图片：压缩 ${result.chatImagesCompressed}，清理 ${result.chatImagesCleaned}`,
    `朋友圈图片：压缩 ${result.momentImagesCompressed}，清理 ${result.momentImagesCleaned}`,
    `小红书图片：压缩 ${result.xiaohongshuImagesCompressed}，清理 ${result.xiaohongshuImagesCleaned}`,
    `本地音乐：清理 ${result.musicTracksCleaned}`,
    `孤儿主题素材：删除 ${result.deletedAssets}`,
    `预计释放 ${formatStorageBytes(result.freedBytes)}`,
  ].join("；");
}

export async function runMediaMaintenance(options: { force?: boolean; auto?: boolean } = {}): Promise<MediaMaintenanceResult> {
  if (!hasBrowserApi()) return createEmptyResult(new Date().toISOString());
  if (activeRun) return activeRun;

  activeRun = (async () => {
    const startedAt = new Date().toISOString();
    const nowMs = Date.now();
    const result = createEmptyResult(startedAt);
    try {
      await runChatImageMaintenance(result, nowMs, startedAt);
      await runMomentImageMaintenance(result, nowMs, startedAt);
      await runXiaohongshuImageMaintenance(result, nowMs, startedAt);
      await runMusicMaintenance(result, nowMs);
      const orphan = await cleanupOrphanThemeAssets();
      result.deletedAssets = orphan.deletedAssets;
      result.freedBytes += orphan.freedBytes;
      result.finishedAt = new Date().toISOString();

      const previous = loadMediaMaintenanceState();
      saveMediaMaintenanceState({
        ...previous,
        lastRunAt: result.finishedAt,
        ...(options.auto ? { lastAutoRunAt: result.finishedAt } : {}),
        lastResult: result,
        lastError: undefined,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const previous = loadMediaMaintenanceState();
      saveMediaMaintenanceState({
        ...previous,
        lastRunAt: new Date().toISOString(),
        ...(options.auto ? { lastAutoRunAt: new Date().toISOString() } : {}),
        lastError: message,
      });
      throw error;
    } finally {
      activeRun = null;
    }
  })();

  return activeRun;
}

export async function runScheduledMediaMaintenance(): Promise<MediaMaintenanceResult | null> {
  if (!hasBrowserApi()) return null;
  if (!loadMediaMaintenanceConfig().enabled) return null;
  const state = loadMediaMaintenanceState();
  const lastAuto = state.lastAutoRunAt ? Date.parse(state.lastAutoRunAt) : 0;
  if (Number.isFinite(lastAuto) && Date.now() - lastAuto < AUTO_INTERVAL_MS) return null;
  return runMediaMaintenance({ auto: true });
}
