import Dexie from "dexie";

// ── Database ─────────────────────────────────────

interface MediaCacheEntry {
    id: string;
    blob: Blob;
    mimeType: string;
    mediaCategory: "audio" | "image" | "video" | "file";
    createdAt: number;
}

class MediaCacheDatabase extends Dexie {
    entries!: Dexie.Table<MediaCacheEntry, string>;

    constructor() {
        super("AiPhoneMediaCacheDB");
        this.version(1).stores({
            entries: "id, createdAt",
        });
    }
}

let db: MediaCacheDatabase | null = null;

function getDb(): MediaCacheDatabase {
    if (!db) db = new MediaCacheDatabase();
    return db;
}

// ── MIME Sniffing ────────────────────────────────

const MAGIC_SIGNATURES: Array<{ prefix: string; mime: string; category: MediaCacheEntry["mediaCategory"] }> = [
    // Images
    { prefix: "iVBORw0KGgo", mime: "image/png", category: "image" },
    { prefix: "/9j/", mime: "image/jpeg", category: "image" },
    { prefix: "R0lGOD", mime: "image/gif", category: "image" },
    { prefix: "UklGRg", mime: "image/webp", category: "image" },
    // Audio
    { prefix: "SUQz", mime: "audio/mpeg", category: "audio" },
    { prefix: "//u", mime: "audio/mpeg", category: "audio" },
    { prefix: "T2dnUw", mime: "audio/ogg", category: "audio" },
    { prefix: "ZkxhQw", mime: "audio/flac", category: "audio" },
    // Video
    { prefix: "AAAAIG", mime: "video/mp4", category: "video" },
    { prefix: "AAAAHG", mime: "video/mp4", category: "video" },
    { prefix: "GkXfo", mime: "video/webm", category: "video" },
    // Documents
    { prefix: "JVBERi", mime: "application/pdf", category: "file" },
];

function sniffBase64(b64: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } {
    for (const sig of MAGIC_SIGNATURES) {
        if (b64.startsWith(sig.prefix)) return { mime: sig.mime, category: sig.category };
    }
    return { mime: "application/octet-stream", category: "file" };
}

// WAV shares UklGR prefix with WebP — disambiguate by checking bytes 8-11 for "WAVE"
function refineWavOrWebp(b64: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } | null {
    if (!b64.startsWith("UklGR")) return null;
    try {
        const raw = atob(b64.slice(0, 24));
        if (raw.length >= 12 && raw.slice(8, 12) === "WAVE") {
            return { mime: "audio/wav", category: "audio" };
        }
    } catch { /* ignore */ }
    return null;
}

export function detectMediaType(b64: string, declaredMime?: string): { mime: string; category: MediaCacheEntry["mediaCategory"] } {
    if (declaredMime && declaredMime !== "application/octet-stream") {
        const category: MediaCacheEntry["mediaCategory"] =
            declaredMime.startsWith("image/") ? "image" :
            declaredMime.startsWith("audio/") ? "audio" :
            declaredMime.startsWith("video/") ? "video" : "file";
        return { mime: declaredMime, category };
    }
    const wavCheck = refineWavOrWebp(b64);
    if (wavCheck) return wavCheck;
    return sniffBase64(b64);
}

// ── Store & Retrieve ─────────────────────────────

export const MEDIA_STORE_PROTOCOL = "media-store://";

function generateId(): string {
    return `mc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function storeMediaBlob(blob: Blob, mimeType: string, category: MediaCacheEntry["mediaCategory"]): Promise<string> {
    const id = generateId();
    await getDb().entries.put({ id, blob, mimeType, mediaCategory: category, createdAt: Date.now() });
    return `${MEDIA_STORE_PROTOCOL}${id}`;
}

export async function storeMediaBase64(b64: string, declaredMime?: string): Promise<{ ref: string; category: MediaCacheEntry["mediaCategory"]; mime: string }> {
    const { mime, category } = detectMediaType(b64, declaredMime);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const ref = await storeMediaBlob(blob, mime, category);
    return { ref, category, mime };
}

export async function loadMediaBlob(ref: string): Promise<{ blob: Blob; mimeType: string; category: MediaCacheEntry["mediaCategory"] } | null> {
    const id = ref.startsWith(MEDIA_STORE_PROTOCOL) ? ref.slice(MEDIA_STORE_PROTOCOL.length) : ref;
    const entry = await getDb().entries.get(id);
    if (!entry) return null;
    return { blob: entry.blob, mimeType: entry.mimeType, category: entry.mediaCategory };
}

export async function deleteMediaRef(ref: string | undefined): Promise<void> {
    if (!ref || !ref.startsWith(MEDIA_STORE_PROTOCOL)) return;
    const id = ref.slice(MEDIA_STORE_PROTOCOL.length);
    await getDb().entries.delete(id);
}

export async function loadMediaObjectUrl(ref: string): Promise<string | null> {
    const result = await loadMediaBlob(ref);
    if (!result) return null;
    return URL.createObjectURL(result.blob);
}

export function isMediaStoreRef(url: string): boolean {
    return url.startsWith(MEDIA_STORE_PROTOCOL);
}

export type MediaCacheSummary = {
    id: string;
    bytes: number;
    category: MediaCacheEntry["mediaCategory"];
    createdAt: number;
};

/** 逐条流式读取 id/大小/类别——blob.size 只读元数据，不会把媒体内容载入内存。 */
export async function listMediaCacheSummaries(): Promise<MediaCacheSummary[]> {
    const out: MediaCacheSummary[] = [];
    await getDb().entries.each((entry) => {
        out.push({
            id: entry.id,
            bytes: entry.blob?.size ?? 0,
            category: entry.mediaCategory,
            createdAt: entry.createdAt,
        });
    });
    return out;
}

// ── Bulk detection in JSON text ──────────────────

const B64_BLOCK_RE = /(?:data:([^;]+);base64,)?([A-Za-z0-9+/]{200,}={0,2})/g;

export function extractBase64Blocks(text: string): Array<{ fullMatch: string; declaredMime?: string; b64: string; start: number }> {
    const results: Array<{ fullMatch: string; declaredMime?: string; b64: string; start: number }> = [];
    let match: RegExpExecArray | null;
    B64_BLOCK_RE.lastIndex = 0;
    while ((match = B64_BLOCK_RE.exec(text)) !== null) {
        results.push({
            fullMatch: match[0],
            declaredMime: match[1] || undefined,
            b64: match[2],
            start: match.index,
        });
    }
    return results;
}
