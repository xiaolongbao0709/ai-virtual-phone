// lib/character-album-store.ts
// 每个角色(C)的独立相册存储。按 characterId 隔离。
// 图片二进制复用 theme-storage 的 asset 机制（saveChatImageToIndexedDB -> assetId）。

import { saveChatImageToIndexedDB, getChatImageFromIndexedDB } from "./chat-asset-storage";

export type AlbumPhotoType = "shared" | "life"; // shared=两人回忆 / life=生活圈

export type AlbumPhoto = {
    id: string;
    characterId: string;        // 相册归属（哪个 C）
    type: AlbumPhotoType;
    caption: string;            // C 的随想（第一视角）
    prompt: string;             // 生图 prompt
    negativePrompt?: string;
    provider?: string;
    assetId: string;            // 图片二进制索引（theme-storage）
    participants?: string[];    // 照片里有谁（characterId + "user"）
    createdAt: number;
    favorite?: boolean;
};

const ALBUM_DB_NAME = "ai_phone_album_db_v1";
const ALBUM_DB_VERSION = 1;
const ALBUM_STORE = "album_photos";

function hasBrowserApi(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function runTransactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

function makeId(): string {
    try {
        if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    } catch { /* ignore */ }
    return `album_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function openAlbumDb(): Promise<IDBDatabase | null> {
    if (!hasBrowserApi()) return Promise.resolve(null);
    return new Promise((resolve) => {
        const req = indexedDB.open(ALBUM_DB_NAME, ALBUM_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(ALBUM_STORE)) {
                const store = db.createObjectStore(ALBUM_STORE, { keyPath: "id" });
                store.createIndex("characterId", "characterId", { unique: false });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };
        req.onerror = () => resolve(null);
    });
}

/** 保存图片二进制，返回 assetId（供 AlbumPhoto.assetId 引用） */
export async function saveAlbumPhotoImage(blob: Blob): Promise<string> {
    return saveChatImageToIndexedDB(blob);
}

/** 读取图片 dataURL（用于 UI 展示） */
export async function getAlbumPhotoImage(assetId: string): Promise<string | null> {
    return getChatImageFromIndexedDB(assetId);
}

export async function addAlbumPhoto(photo: Omit<AlbumPhoto, "id" | "createdAt"> & Partial<Pick<AlbumPhoto, "id" | "createdAt">>): Promise<AlbumPhoto> {
    const full: AlbumPhoto = {
        ...photo,
        id: photo.id ?? makeId(),
        createdAt: photo.createdAt ?? Date.now(),
    } as AlbumPhoto;
    const db = await openAlbumDb();
    if (!db) return full;
    const tx = db.transaction(ALBUM_STORE, "readwrite");
    tx.objectStore(ALBUM_STORE).put(full);
    await runTransactionDone(tx);
    db.close();
    return full;
}

export async function listAlbumByCharacter(characterId: string): Promise<AlbumPhoto[]> {
    const db = await openAlbumDb();
    if (!db) return [];
    const tx = db.transaction(ALBUM_STORE, "readonly");
    const index = tx.objectStore(ALBUM_STORE).index("characterId");
    const result = await runRequest(index.getAll(characterId));
    db.close();
    return (result as AlbumPhoto[]).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAlbumPhoto(id: string): Promise<AlbumPhoto | null> {
    const db = await openAlbumDb();
    if (!db) return null;
    const tx = db.transaction(ALBUM_STORE, "readonly");
    const result = await runRequest(tx.objectStore(ALBUM_STORE).get(id));
    db.close();
    return (result as AlbumPhoto) || null;
}

export async function removeAlbumPhoto(id: string): Promise<void> {
    const db = await openAlbumDb();
    if (!db) return;
    const tx = db.transaction(ALBUM_STORE, "readwrite");
    tx.objectStore(ALBUM_STORE).delete(id);
    await runTransactionDone(tx);
    db.close();
}

export async function updateAlbumPhoto(id: string, patch: Partial<AlbumPhoto>): Promise<void> {
    const db = await openAlbumDb();
    if (!db) return;
    const tx = db.transaction(ALBUM_STORE, "readwrite");
    const store = tx.objectStore(ALBUM_STORE);
    const existing = await runRequest(store.get(id)) as AlbumPhoto | undefined;
    if (existing) store.put({ ...existing, ...patch, id });
    await runTransactionDone(tx);
    db.close();
}

export async function toggleAlbumFavorite(id: string): Promise<void> {
    const db = await openAlbumDb();
    if (!db) return;
    const tx = db.transaction(ALBUM_STORE, "readwrite");
    const store = tx.objectStore(ALBUM_STORE);
    const existing = await runRequest(store.get(id)) as AlbumPhoto | undefined;
    if (existing) store.put({ ...existing, favorite: !existing.favorite });
    await runTransactionDone(tx);
    db.close();
}
