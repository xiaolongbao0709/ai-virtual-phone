import Dexie from "dexie";

// ── Types ──────────────────────────────────────

export type DwellingPosition =
    | "top-left" | "top-center" | "top-right"
    | "center-left" | "center" | "center-right"
    | "bottom-left" | "bottom-center" | "bottom-right";

export type DwellingFurnitureItem = {
    id: string;
    name: string;
    preview: string;
};

export type DwellingMarker = { x: number; y: number };

export type DwellingFurniture = {
    id: string;
    icon: string;
    label: string;
    /** 英文名（大写，标注幽灵字），旧数据可能没有 */
    en?: string;
    position: DwellingPosition;
    /** 归一化标注点坐标 0~1，旧数据没有时按 position 兜底 */
    marker?: DwellingMarker;
    items: DwellingFurnitureItem[];
};

export type DwellingRoom = {
    id: string;
    name: string;
    /** 英文名（大写，页签副标），旧数据可能没有 */
    en?: string;
    description: string;
    /** 生图构图描述（与家具布局同源） */
    imagePrompt?: string;
    /** 已生成房间图的媒体引用 */
    imageAssetId?: string;
    furniture: DwellingFurniture[];
};

export type DwellingLayout = {
    rooms: DwellingRoom[];
};

// ── IndexedDB (Dexie) ─────────────────────────

type DwellingLayoutRow = {
    characterId: string;
    data: DwellingLayout;
    updatedAt: string;
};

type DwellingItemHtmlRow = {
    id: string;           // `${characterId}_${roomId}_${itemId}`
    characterId: string;
    html: string;
};

class DwellingDatabase extends Dexie {
    layouts!: Dexie.Table<DwellingLayoutRow, string>;
    itemHtml!: Dexie.Table<DwellingItemHtmlRow, string>;

    constructor() {
        super("AiPhoneDwellingDB");
        this.version(3).stores({
            layouts: "characterId",
            itemHtml: "id, characterId",
        });
    }
}

const db = new DwellingDatabase();

// ── In-memory cache ───────────────────────────

type CachedLayout = { layout: DwellingLayout; updatedAt: string };
const _layoutCache: Map<string, CachedLayout> = new Map();
const _itemHtmlCache: Map<string, string> = new Map(); // key: `${charId}_${roomId}_${itemId}`

// ── Hydrate on app start ──────────────────────

let _hydrated = false;

export async function hydrateDwellingStorage(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return;
    _hydrated = true;
    try {
        const [allLayouts, allHtml] = await Promise.all([
            db.layouts.toArray(),
            db.itemHtml.toArray(),
        ]);
        for (const row of allLayouts) _layoutCache.set(row.characterId, { layout: row.data, updatedAt: row.updatedAt });
        for (const row of allHtml) _itemHtmlCache.set(row.id, row.html);
    } catch (e) {
        console.warn("[DwellingStorage] hydrate error:", e);
    }
}

// ── Sync cache read (for prompt injection) ────

export function readDwellingLayoutCache(characterId: string): CachedLayout | null {
    return _layoutCache.get(characterId) ?? null;
}

// ── Layout CRUD ───────────────────────────────

export async function loadDwellingLayout(characterId: string): Promise<CachedLayout | null> {
    const cached = _layoutCache.get(characterId);
    if (cached) return cached;

    try {
        const row = await db.layouts.get(characterId);
        if (row) {
            const entry = { layout: row.data, updatedAt: row.updatedAt };
            _layoutCache.set(characterId, entry);
            return entry;
        }
    } catch (e) {
        console.warn("[DwellingStorage] loadLayout error:", e);
    }
    return null;
}

export async function saveDwellingLayout(characterId: string, layout: DwellingLayout): Promise<void> {
    const updatedAt = new Date().toISOString();
    _layoutCache.set(characterId, { layout, updatedAt });
    try {
        await db.layouts.put({
            characterId,
            data: layout,
            updatedAt,
        });
    } catch (e) {
        console.warn("[DwellingStorage] saveLayout error:", e);
    }
}

// ── Clear data for a character ────────────────

export async function clearDwellingData(characterId: string): Promise<void> {
    _layoutCache.delete(characterId);
    // Clear item HTML cache for this character
    for (const key of _itemHtmlCache.keys()) {
        if (key.startsWith(characterId + "_")) _itemHtmlCache.delete(key);
    }
    try {
        await Promise.all([
            db.layouts.delete(characterId),
            db.itemHtml.where("characterId").equals(characterId).delete(),
        ]);
    } catch (e) {
        console.warn("[DwellingStorage] clearData error:", e);
    }
}

// ── Item HTML CRUD ────────────────────────────

function htmlKey(characterId: string, roomId: string, itemId: string) {
    return `${characterId}_${roomId}_${itemId}`;
}

export function readItemHtmlCache(characterId: string, roomId: string, itemId: string): string | null {
    return _itemHtmlCache.get(htmlKey(characterId, roomId, itemId)) ?? null;
}

export async function saveItemHtml(characterId: string, roomId: string, itemId: string, html: string): Promise<void> {
    const key = htmlKey(characterId, roomId, itemId);
    _itemHtmlCache.set(key, html);
    try {
        await db.itemHtml.put({ id: key, characterId, html });
    } catch (e) {
        console.warn("[DwellingStorage] saveItemHtml error:", e);
    }
}

/** Load all item HTML for a character into a map keyed by `${roomId}_${itemId}` */
export function loadAllItemHtmlForChar(characterId: string): Record<string, string> {
    const result: Record<string, string> = {};
    const prefix = characterId + "_";
    for (const [key, html] of _itemHtmlCache.entries()) {
        if (key.startsWith(prefix)) {
            // key is `${charId}_${roomId}_${itemId}`, strip charId prefix
            result[key.slice(prefix.length)] = html;
        }
    }
    return result;
}

// ── Dwelling image generation toggle ──────────

const DWELLING_IMAGE_TOGGLE_KEY = "dwelling_image_gen_enabled";

export function loadDwellingImageEnabled(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return localStorage.getItem(DWELLING_IMAGE_TOGGLE_KEY) !== "0";
    } catch {
        return true;
    }
}

export function saveDwellingImageEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(DWELLING_IMAGE_TOGGLE_KEY, enabled ? "1" : "0");
    } catch { /* ignore */ }
}

/** Collect all room image media refs in a layout (for cleanup before delete/rebuild) */
export function collectRoomImageRefs(layout: DwellingLayout | null | undefined): string[] {
    if (!layout) return [];
    return layout.rooms.map(r => r.imageAssetId).filter((v): v is string => Boolean(v));
}
