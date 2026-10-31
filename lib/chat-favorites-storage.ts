// lib/chat-favorites-storage.ts
import { kvGet, kvSet } from "./kv-db";
import type { ChatMessageRole } from "./chat-storage";

const CHAT_FAVORITES_KV_KEY = "ai_phone_chat_favorites_v1";
export const CHAT_FAVORITES_UPDATED_EVENT = "ai-chat-favorites-updated";

export type ChatFavoriteItem = {
    id: string; // 收藏记录ID (通常以 fav- 开头)
    messageId: string;
    sessionId: string;
    role: ChatMessageRole;
    content: string;
    mediaType?: string;
    mediaData?: Record<string, unknown>;
    characterId?: string;
    senderName: string;
    createdAt: string; // 消息原产生时间
    favoritedAt: string; // 收藏时间
};

export function loadChatFavorites(): ChatFavoriteItem[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(CHAT_FAVORITES_KV_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error("[Favorites] Failed to load favorites:", e);
        return [];
    }
}

export function saveChatFavorites(favorites: ChatFavoriteItem[]): void {
    if (typeof window === "undefined") return;
    try {
        kvSet(CHAT_FAVORITES_KV_KEY, JSON.stringify(favorites));
        window.dispatchEvent(new CustomEvent(CHAT_FAVORITES_UPDATED_EVENT));
    } catch (e) {
        console.error("[Favorites] Failed to save favorites:", e);
    }
}

export function addChatFavorite(item: Omit<ChatFavoriteItem, "id" | "favoritedAt">): boolean {
    const current = loadChatFavorites();
    if (current.some(f => f.messageId === item.messageId)) {
        return false;
    }
    const newItem: ChatFavoriteItem = {
        ...item,
        id: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        favoritedAt: new Date().toISOString(),
    };
    saveChatFavorites([newItem, ...current]);
    return true;
}

export function removeChatFavorite(favoriteIdOrMessageId: string): void {
    const current = loadChatFavorites();
    const filtered = current.filter(f => f.id !== favoriteIdOrMessageId && f.messageId !== favoriteIdOrMessageId);
    if (filtered.length !== current.length) {
        saveChatFavorites(filtered);
    }
}

export function isChatMessageFavorited(messageId: string): boolean {
    const current = loadChatFavorites();
    return current.some(f => f.messageId === messageId);
}
