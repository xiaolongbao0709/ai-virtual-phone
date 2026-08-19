// lib/custom-sticker-storage.ts
// Custom sticker pack system.
// Data model: StickerPack[] + assignments (packId → characterId[]).
// Metadata in localStorage, images in IndexedDB (ThemeAssetType "sticker").

import {
    saveThemeAssetFromBlob,
    deleteThemeAsset,
    getThemeAssetDataUrl,
    getThemeAssetMap,
    isAnimatedImageBlob,
    checkAnimatedAssetSize,
} from "./theme-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const PACKS_KEY = "ai_phone_sticker_packs_v1";
const ASSIGN_KEY = "ai_phone_sticker_assign_v1";
registerKvMigration(PACKS_KEY);
registerKvMigration(ASSIGN_KEY);
const STICKER_MAX_SIZE = 200; // px

// ── Types ──

export interface StickerItem {
    id: string;
    name: string;       // name used in [表情包:name]
    assetId: string;    // IndexedDB asset ID (empty when using externalUrl)
    externalUrl?: string; // external image URL (when provided, assetId is unused)
}

export interface StickerPack {
    id: string;
    name: string;
    /** Optional note for the whole pack. Missing on legacy data. */
    note?: string;
    stickers: StickerItem[];
    createdAt: string;
}

/** packId → characterId[] */
type AssignmentMap = Record<string, string[]>;

// ── localStorage helpers ──

function readPacks(): StickerPack[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(PACKS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

function writePacks(packs: StickerPack[]): void {
    if (typeof window === "undefined") return;
    kvSet(PACKS_KEY, JSON.stringify(packs));
}

function readAssignments(): AssignmentMap {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(ASSIGN_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function writeAssignments(map: AssignmentMap): void {
    if (typeof window === "undefined") return;
    kvSet(ASSIGN_KEY, JSON.stringify(map));
}

// ── Pack CRUD ──

export function loadStickerPacks(): StickerPack[] {
    return readPacks();
}

/** 图集名称/备注的长度上限：两者都会随备份与云同步走，不设限的话一次粘贴就能把整份索引撑大。 */
export const STICKER_PACK_NAME_MAX = 40;
export const STICKER_PACK_NOTE_MAX = 500;

function cleanPackName(value: string): string {
    return value.trim().slice(0, STICKER_PACK_NAME_MAX);
}

function cleanPackNote(value: string): string {
    return value.trim().slice(0, STICKER_PACK_NOTE_MAX);
}

export function createStickerPack(name: string, note = ""): StickerPack {
    const cleanedNote = cleanPackNote(note);
    const pack: StickerPack = {
        id: `pack_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: cleanPackName(name),
        // 空备注不落字段，保持与 note?: string 的可选语义一致
        ...(cleanedNote ? { note: cleanedNote } : {}),
        stickers: [],
        createdAt: new Date().toISOString(),
    };
    const packs = readPacks();
    packs.push(pack);
    writePacks(packs);
    return pack;
}

export async function deleteStickerPack(packId: string): Promise<void> {
    const packs = readPacks();
    const idx = packs.findIndex(p => p.id === packId);
    if (idx === -1) return;
    const [removed] = packs.splice(idx, 1);
    writePacks(packs);
    // Remove all sticker assets
    for (const s of removed.stickers) {
        await deleteThemeAsset(s.assetId);
    }
    // Remove assignments
    const assignments = readAssignments();
    delete assignments[packId];
    writeAssignments(assignments);
}

export function renameStickerPack(packId: string, newName: string): void {
    updateStickerPackInfo(packId, { name: newName });
}

/** 一次写完名称与备注：分两次读改写会在中途失败时留下「名字改了、备注没改」的半更新状态。 */
export function updateStickerPackInfo(packId: string, info: { name?: string; note?: string }): void {
    const packs = readPacks();
    const pack = packs.find(p => p.id === packId);
    if (!pack) return;
    if (typeof info.name === "string") {
        const name = cleanPackName(info.name);
        if (!name) return; // 空名字不接受，避免把图集改成无名
        pack.name = name;
    }
    if (typeof info.note === "string") {
        const note = cleanPackNote(info.note);
        if (note) pack.note = note;
        else delete pack.note;
    }
    writePacks(packs);
}

// ── Sticker items within a pack ──

/** GIF 原样保留(不经 canvas 重编码,避免动图变静帧);其余图片走压缩。 */
export async function addStickerToPack(packId: string, name: string, imageBlob: Blob): Promise<StickerItem | null> {
    const packs = readPacks();
    const pack = packs.find(p => p.id === packId);
    if (!pack) return null;
    const prepared = isAnimatedImageBlob(imageBlob) ? imageBlob : await compressStickerImage(imageBlob);
    const assetId = await saveThemeAssetFromBlob(prepared, "sticker");
    const item: StickerItem = {
        id: `stk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        assetId,
    };
    pack.stickers.push(item);
    writePacks(packs);
    return item;
}

/**
 * 批量添加表情：一次性写入(只触发一次保存),按张回调进度。
 * GIF 原样保留(不经 canvas 重编码,避免动图变静帧);其余图片走压缩。
 * 单张失败只跳过该张,不影响其余。
 */
export async function addStickersToPack(
    packId: string,
    items: { name: string; blob: Blob }[],
    onProgress?: (done: number, total: number) => void,
): Promise<{ added: number; failed: number }> {
    const packs = readPacks();
    const pack = packs.find(p => p.id === packId);
    if (!pack) return { added: 0, failed: items.length };
    let added = 0;
    let failed = 0;
    for (let i = 0; i < items.length; i++) {
        try {
            const src = items[i].blob;
            const prepared = isAnimatedImageBlob(src) ? src : await compressStickerImage(src);
            const assetId = await saveThemeAssetFromBlob(prepared, "sticker");
            pack.stickers.push({
                id: `stk_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
                name: items[i].name,
                assetId,
            });
            added++;
        } catch {
            failed++;
        }
        onProgress?.(i + 1, items.length);
    }
    writePacks(packs);
    return { added, failed };
}

/** 上传前预检：通过返回 null，否则返回给用户看的错误文案（目前只有动图体积限制）。 */
export function checkStickerBlob(blob: Blob): string | null {
    return checkAnimatedAssetSize(blob);
}

export function addStickerByUrlToPack(packId: string, name: string, url: string): StickerItem | null {
    const packs = readPacks();
    const pack = packs.find(p => p.id === packId);
    if (!pack) return null;
    const item: StickerItem = {
        id: `stk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        assetId: "",
        externalUrl: url,
    };
    pack.stickers.push(item);
    writePacks(packs);
    return item;
}

export function renameStickerInPack(packId: string, stickerId: string, newName: string): void {
    const packs = readPacks();
    const pack = packs.find(p => p.id === packId);
    if (!pack) return;
    const sticker = pack.stickers.find(s => s.id === stickerId);
    if (!sticker) return;
    sticker.name = newName;
    writePacks(packs);
}

export async function removeStickerFromPack(packId: string, stickerId: string): Promise<void> {
    const packs = readPacks();
    const pack = packs.find(p => p.id === packId);
    if (!pack) return;
    const idx = pack.stickers.findIndex(s => s.id === stickerId);
    if (idx === -1) return;
    const [removed] = pack.stickers.splice(idx, 1);
    writePacks(packs);
    if (removed.assetId) await deleteThemeAsset(removed.assetId);
}

// ── Pack ↔ Character assignments ──

export function getPackAssignments(packId: string): string[] {
    return readAssignments()[packId] ?? [];
}

export function togglePackAssignment(packId: string, characterId: string): void {
    const map = readAssignments();
    const list = map[packId] ?? [];
    const idx = list.indexOf(characterId);
    if (idx === -1) {
        list.push(characterId);
    } else {
        list.splice(idx, 1);
    }
    map[packId] = list;
    writeAssignments(map);
}

/** Get all pack IDs assigned to a character. */
export function getCharacterPackIds(characterId: string): string[] {
    const map = readAssignments();
    const result: string[] = [];
    for (const [packId, charIds] of Object.entries(map)) {
        if (charIds.includes(characterId)) result.push(packId);
    }
    return result;
}

/** Get sticker packs assigned to any of these characters, preserving the user's pack order. */
export function loadStickerPacksForCharacters(characterIds: string[]): StickerPack[] {
    const ids = new Set(characterIds.filter(Boolean));
    if (ids.size === 0) return [];
    const assignments = readAssignments();
    return readPacks().filter(pack => {
        const assignedIds = assignments[pack.id] ?? [];
        return assignedIds.some(id => ids.has(id));
    });
}

// ── Character-facing API (used by engines, renderer, emoji panel) ──

/** Aggregate all stickers from packs assigned to this character. */
export function loadCustomStickers(characterId: string): StickerItem[] {
    const packIds = getCharacterPackIds(characterId);
    if (packIds.length === 0) return [];
    const packs = readPacks();
    const result: StickerItem[] = [];
    for (const pid of packIds) {
        const pack = packs.find(p => p.id === pid);
        if (pack) result.push(...pack.stickers);
    }
    return result;
}

/** Get sticker names for prompt injection. */
export function getCustomStickerNames(characterId: string): string {
    const stickers = loadCustomStickers(characterId);
    if (stickers.length === 0) return "无可用表情包，该功能不可用";
    return stickers.map(s => s.name).join("，");
}

/** Get first sticker formatted as [表情包:name], or empty string. */
export function getCustomStickerExample(characterId: string): string {
    const stickers = loadCustomStickers(characterId);
    if (stickers.length === 0) return "";
    return `[表情包:${stickers[0].name}]`;
}

/** Find a custom sticker by name for a given character. */
export function findCustomStickerByName(characterId: string, name: string): StickerItem | undefined {
    return loadCustomStickers(characterId).find(s => s.name === name);
}

/** Resolve a single sticker's image URL from IndexedDB. */
export async function resolveCustomStickerUrl(assetId: string): Promise<string | null> {
    return getThemeAssetDataUrl(assetId);
}

/** Resolve all custom sticker URLs for a character → { name: dataUrl }. */
export async function resolveCustomStickerMap(characterId: string): Promise<Record<string, string>> {
    const stickers = loadCustomStickers(characterId);
    if (stickers.length === 0) return {};
    const assetIds = stickers.filter(s => s.assetId).map(s => s.assetId);
    const assetMap = assetIds.length > 0 ? await getThemeAssetMap(assetIds) : {};
    const result: Record<string, string> = {};
    for (const s of stickers) {
        if (s.externalUrl) {
            result[s.name] = s.externalUrl;
        } else if (assetMap[s.assetId]) {
            result[s.name] = assetMap[s.assetId];
        }
    }
    return result;
}

/** Resolve all sticker URLs for a pack → { name: dataUrl }. */
export async function resolvePackStickerMap(pack: StickerPack): Promise<Record<string, string>> {
    if (pack.stickers.length === 0) return {};
    const assetIds = pack.stickers.filter(s => s.assetId).map(s => s.assetId);
    const assetMap = assetIds.length > 0 ? await getThemeAssetMap(assetIds) : {};
    const result: Record<string, string> = {};
    for (const s of pack.stickers) {
        if (s.externalUrl) {
            result[s.name] = s.externalUrl;
        } else if (assetMap[s.assetId]) {
            result[s.name] = assetMap[s.assetId];
        }
    }
    return result;
}

// ── Image compression ──

async function compressStickerImage(blob: Blob): Promise<Blob> {
    if (typeof window === "undefined" || typeof createImageBitmap === "undefined") return blob;
    try {
        const bmp = await createImageBitmap(blob);
        const { width, height } = bmp;
        let w = width, h = height;
        if (w > STICKER_MAX_SIZE || h > STICKER_MAX_SIZE) {
            const scale = STICKER_MAX_SIZE / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
        }
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (!ctx) return blob;
        ctx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        return await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
    } catch {
        return blob;
    }
}
