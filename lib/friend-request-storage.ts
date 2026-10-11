import { loadCharacters } from "./character-storage";
import { loadChatContacts } from "./chat-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
// lib/friend-request-storage.ts
// Friend request storage — manages pending/accepted/rejected friend requests
// from AI characters after user deletes them.

export type FriendRequest = {
    id: string;
    characterId: string;
    message: string;         // AI's friend request message
    status: "pending" | "accepted" | "rejected" | "abandoned";
    round: number;           // attempt number (1, 2, 3)
    createdAt: string;       // ISO date
};

const STORAGE_KEY = "ai_phone_friend_requests_v1";
registerKvMigration(STORAGE_KEY);

export function loadFriendRequests(): FriendRequest[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveFriendRequests(requests: FriendRequest[]): void {
    if (typeof window === "undefined") return;
    kvSet(STORAGE_KEY, JSON.stringify(requests));
}

export function addFriendRequest(characterId: string, message: string, round: number): FriendRequest {
    const all = loadFriendRequests();
    const req: FriendRequest = {
        id: `freq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        characterId,
        message,
        status: "pending",
        round,
        createdAt: new Date().toISOString(),
    };
    all.push(req);
    saveFriendRequests(all);
    return req;
}

export function updateFriendRequestStatus(
    requestId: string,
    status: FriendRequest["status"],
): void {
    const all = loadFriendRequests();
    const idx = all.findIndex(r => r.id === requestId);
    if (idx !== -1) {
        all[idx].status = status;
        saveFriendRequests(all);
    }
}

/** Get all pending requests (for UI display). */
export function getPendingFriendRequests(): FriendRequest[] {
    const all = loadFriendRequests();
    if (all.length === 0) return [];

    const characterIds = new Set(loadCharacters().map(c => c.id));
    const contactCharacterIds = new Set(loadChatContacts().map(c => c.characterId));
    let changed = false;

    const activeRequests = all.filter(r => {
        if (r.status !== "pending") return true;
        const stale = !characterIds.has(r.characterId) || contactCharacterIds.has(r.characterId);
        if (stale) {
            changed = true;
            return false;
        }
        return true;
    });

    if (changed) saveFriendRequests(activeRequests);
    return activeRequests.filter(r => r.status === "pending");
}

/** Get the latest request for a character (any status). */
export function getLatestRequestForCharacter(characterId: string): FriendRequest | null {
    const all = loadFriendRequests().filter(r => r.characterId === characterId);
    if (all.length === 0) return null;
    return all[all.length - 1];
}

/** Clean up all requests for a character (e.g., after accepting). */
export function clearRequestsForCharacter(characterId: string): void {
    const all = loadFriendRequests();
    saveFriendRequests(all.filter(r => r.characterId !== characterId));
}

// ── 自动通过设置：好友申请超过 N 天没处理，自动转为联系人（0 = 关闭）──
const AUTO_ACCEPT_DAYS_KEY = "ai_phone_friend_request_auto_accept_days_v1";
export const DEFAULT_AUTO_ACCEPT_DAYS = 3;

export function getAutoAcceptDays(): number {
    if (typeof window === "undefined") return 0;
    const raw = kvGet(AUTO_ACCEPT_DAYS_KEY);
    if (raw === null || raw === undefined || raw === "") return DEFAULT_AUTO_ACCEPT_DAYS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AUTO_ACCEPT_DAYS;
}

export function setAutoAcceptDays(days: number): void {
    if (typeof window === "undefined") return;
    kvSet(AUTO_ACCEPT_DAYS_KEY, String(Math.max(0, Math.floor(days))));
}

/** Dispatch event for UI refresh. */
export function dispatchFriendRequestUpdated(): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("friend-requests-updated"));
    }
}
