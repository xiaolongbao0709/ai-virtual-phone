import {
    hydrateChatStorage,
    loadChatSessions,
    removeChatContact,
    saveChatSessions,
    type ChatSession,
} from "./chat-storage";
import { removeChatSessionCompletely } from "./chat-session-remove";

function omitRecordKey<T>(record: Record<string, T> | undefined, key: string): Record<string, T> | undefined {
    if (!record || !(key in record)) return record;
    const next = { ...record };
    delete next[key];
    return next;
}

/**
 * Remove a deleted character from a group without deleting the group or its history.
 * Regular groups return ownership to the user; spectator groups pass it to the next
 * remaining character when possible.
 */
export function removeCharacterFromGroupSession(session: ChatSession, characterId: string): ChatSession {
    if (!session.isGroup) return session;

    const participantIds = (session.participantIds || []).filter(id => id !== characterId);
    const groupAdminIds = session.groupAdminIds?.filter(id => id !== characterId);
    const groupMutes = omitRecordKey(session.groupMutes, characterId);
    const groupVideoBackgrounds = omitRecordKey(session.groupVideoBackgrounds, characterId);
    const groupOwnerId = session.groupOwnerId === characterId
        ? (session.isSpectator ? participantIds[0] : "self")
        : session.groupOwnerId;

    const changed = participantIds.length !== (session.participantIds || []).length
        || groupAdminIds?.length !== session.groupAdminIds?.length
        || groupMutes !== session.groupMutes
        || groupVideoBackgrounds !== session.groupVideoBackgrounds
        || groupOwnerId !== session.groupOwnerId;

    if (!changed) return session;
    return {
        ...session,
        participantIds,
        groupAdminIds,
        groupMutes,
        groupVideoBackgrounds,
        groupOwnerId,
    };
}

/**
 * Clear chat-side references before a character record is removed.
 * Private sessions are deleted completely; group sessions and their history remain.
 */
export async function removeCharacterChatReferences(characterId: string): Promise<void> {
    if (!characterId) return;
    await hydrateChatStorage();

    const sessions = loadChatSessions();
    const privateSessionIds = sessions
        .filter(session => !session.isGroup && session.contactId === characterId)
        .map(session => session.id);
    const nextSessions = sessions.map(session => removeCharacterFromGroupSession(session, characterId));

    if (nextSessions.some((session, index) => session !== sessions[index])) {
        saveChatSessions(nextSessions);
    }

    removeChatContact(characterId);
    privateSessionIds.forEach(removeChatSessionCompletely);
}
