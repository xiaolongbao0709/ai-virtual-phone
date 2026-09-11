// lib/chat-session-merge.ts
// 重复会话检测与合并：同一角色的单聊、同一批成员的群聊算重复。
// 合并 = 线上消息 + 线下记录全部并入最近活跃的那个会话，其余会话走一站式删除。
// 用户可以按组选择合并或保留；选了「不合并」的组记签名，成员不变就不再提醒。

import { loadCharacters } from "./character-storage";
import { getLastChatOfflineTurn, loadChatOfflineTurns, saveChatOfflineTurns } from "./chat-offline-storage";
import { removeChatSessionCompletely } from "./chat-session-remove";
import {
    getLastVisibleSessionMessage,
    loadChatSessions,
    reassignChatSessionMessages,
    saveChatSessions,
    type ChatSession,
} from "./chat-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const MERGE_DISMISSED_KEY = "ai_phone_session_merge_dismissed_v1";
registerKvMigration(MERGE_DISMISSED_KEY);

/** 合并完成后广播：外层据此卸载被删会话的聊天室缓存 */
export const CHAT_SESSIONS_MERGED_EVENT = "ai-chat-sessions-merged";

export type ChatSessionsMergedDetail = {
    targetSessionId: string;
    removedSessionIds: string[];
};

export type DuplicateSessionGroup = {
    /** 去重键：单聊按 contactId，群聊按成员集合（围观群单算） */
    key: string;
    /** 键 + 具体会话 id 列表：「暂不合并」按签名记账，再出现新的重复会话会重新提醒 */
    signature: string;
    isGroup: boolean;
    /** 单聊显示角色名/备注，群聊显示涉及的群名 */
    label: string;
    memberNames: string[];
    /** 按活跃时间从新到旧排序，第一个是合并时保留的目标 */
    sessions: ChatSession[];
};

function parseIso(value?: string | null): number {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? 0 : time;
}

function sessionActivityTime(session: ChatSession): number {
    return Math.max(
        parseIso(getLastVisibleSessionMessage(session.id)?.createdAt),
        parseIso(getLastChatOfflineTurn(session.id)?.createdAt),
        parseIso(session.updatedAt),
    );
}

function duplicateKey(session: ChatSession): string | null {
    if (!session.isGroup) return `direct:${session.contactId}`;
    const members = [...(session.participantIds || [])].sort();
    if (members.length === 0) return null;
    return `group:${session.isSpectator ? "1" : "0"}:${members.join(",")}`;
}

export function findDuplicateSessionGroups(): DuplicateSessionGroup[] {
    const sessions = loadChatSessions();
    const chars = loadCharacters();
    const nameOf = (id: string) => chars.find(c => c.id === id)?.name || `角色_${id.slice(-4)}`;

    const buckets = new Map<string, ChatSession[]>();
    for (const session of sessions) {
        const key = duplicateKey(session);
        if (!key) continue;
        const list = buckets.get(key);
        if (list) list.push(session);
        else buckets.set(key, [session]);
    }

    const groups: DuplicateSessionGroup[] = [];
    for (const [key, list] of buckets) {
        if (list.length < 2) continue;
        const sorted = [...list].sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a));
        const head = sorted[0];
        const isGroup = Boolean(head.isGroup);
        const memberNames = isGroup
            ? (head.participantIds || []).map(nameOf)
            : [nameOf(head.contactId)];
        const label = isGroup
            ? [...new Set(sorted.map(s => s.groupName?.trim() || "群聊"))].map(name => `「${name}」`).join("")
            : (head.alias?.trim() || nameOf(head.contactId));
        groups.push({
            key,
            signature: `${key}|${sorted.map(s => s.id).sort().join("+")}`,
            isGroup,
            label,
            memberNames,
            sessions: sorted,
        });
    }
    // 群聊在前（用户场景以重复群为主），组内已按活跃排序
    return groups.sort((a, b) => Number(b.isGroup) - Number(a.isGroup));
}

function loadDismissedSignatures(): Set<string> {
    try {
        const parsed = JSON.parse(kvGet(MERGE_DISMISSED_KEY) || "[]") as unknown;
        return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
    } catch {
        return new Set();
    }
}

export function dismissMergeSignatures(signatures: string[]): void {
    if (signatures.length === 0) return;
    const merged = loadDismissedSignatures();
    for (const signature of signatures) merged.add(signature);
    kvSet(MERGE_DISMISSED_KEY, JSON.stringify([...merged]));
}

/** 只返回还没被用户「暂不合并」过的重复组（弹窗数据源） */
export function findPromptableDuplicateSessionGroups(): DuplicateSessionGroup[] {
    const dismissed = loadDismissedSignatures();
    return findDuplicateSessionGroups().filter(group => !dismissed.has(group.signature));
}

export function mergeDuplicateSessionGroup(group: DuplicateSessionGroup): void {
    const [target, ...rest] = group.sessions;
    if (!target || rest.length === 0) return;

    for (const source of rest) {
        // 线上消息挪过去（目标会话按时间重排序号）
        reassignChatSessionMessages(source.id, target.id);
        // 线下记录并入（saveChatOfflineTurns 会按 createdAt 排序）
        const sourceTurns = loadChatOfflineTurns(source.id);
        if (sourceTurns.length > 0) {
            saveChatOfflineTurns(target.id, [
                ...loadChatOfflineTurns(target.id),
                ...sourceTurns.map(turn => ({ ...turn, sessionId: target.id })),
            ]);
        }
        // 剩下的空壳连同散装状态一并清掉
        removeChatSessionCompletely(source.id);
    }

    // 任一来源置过顶就保留置顶
    if (!target.isPinned && rest.some(s => s.isPinned)) {
        const sessions = loadChatSessions();
        const idx = sessions.findIndex(s => s.id === target.id);
        if (idx !== -1) {
            sessions[idx] = { ...sessions[idx], isPinned: true };
            saveChatSessions(sessions);
        }
    }

    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent<ChatSessionsMergedDetail>(CHAT_SESSIONS_MERGED_EVENT, {
            detail: { targetSessionId: target.id, removedSessionIds: rest.map(s => s.id) },
        }));
    }
}
