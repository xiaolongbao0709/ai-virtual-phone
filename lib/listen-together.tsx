"use client";

import { useSyncExternalStore } from "react";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { resolveUserIdentity } from "./settings-storage";

export type ListenTogetherStatus = "idle" | "inviting" | "active" | "pending_char";
export type ListenTogetherSource = "user" | "char" | "none";

export type ListenTogetherState = {
  status: ListenTogetherStatus;
  characterId: string;
  characterName: string;
  trackId: string | null;
  trackTitle: string;
  trackArtist: string;
  startedAt?: string;
  updatedAt?: string;
  inviter?: ListenTogetherSource;
};

export type ListenTogetherTrackLike = {
  id?: string;
  title?: string;
  artist?: string;
};

const LISTEN_TOGETHER_KEY = "ai_phone_listen_together_v1";
registerKvMigration(LISTEN_TOGETHER_KEY);

const EMPTY_STATE: ListenTogetherState = {
  status: "idle",
  characterId: "",
  characterName: "",
  trackId: null,
  trackTitle: "",
  trackArtist: "",
};

function readState(): ListenTogetherState {
  if (typeof window === "undefined") return EMPTY_STATE;
  try {
    const raw = kvGet(LISTEN_TOGETHER_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<ListenTogetherState>;
    return {
      ...EMPTY_STATE,
      ...parsed,
      trackId: parsed.trackId || null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

let currentState: ListenTogetherState = readState();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function write(next: ListenTogetherState) {
  currentState = next;
  try {
    kvSet(LISTEN_TOGETHER_KEY, JSON.stringify(next));
  } catch {
    // persistence is best-effort
  }
  notify();
}

function currentUserLabel(characterId?: string): string {
  try {
    return resolveUserIdentity(characterId)?.name || "我";
  } catch {
    return "我";
  }
}

export function getListenTogetherState(): ListenTogetherState {
  return currentState;
}

export function refreshListenTogetherStateFromStorage(): void {
  const next = readState();
  if (JSON.stringify(next) !== JSON.stringify(currentState)) {
    currentState = next;
    notify();
  }
}

export function subscribeListenTogether(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useListenTogetherState(): ListenTogetherState {
  return useSyncExternalStore(subscribeListenTogether, getListenTogetherState, getListenTogetherState);
}

function patchState(patch: Partial<ListenTogetherState>) {
  write({
    ...currentState,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

export async function startListenTogether(options: {
  characterId: string;
  characterName: string;
  track?: ListenTogetherTrackLike | null;
  inviter?: ListenTogetherSource;
}): Promise<void> {
  const characterId = options.characterId;
  if (!characterId) return;
  patchState({
    status: "active",
    characterId,
    characterName: options.characterName || "TA",
    trackId: options.track?.id || currentState.trackId,
    trackTitle: options.track?.title || currentState.trackTitle,
    trackArtist: options.track?.artist || currentState.trackArtist,
    startedAt: new Date().toISOString(),
    inviter: options.inviter || "user",
  });
  const userLabel = currentUserLabel(characterId);
  const charName = options.characterName || "TA";
  const song = options.track?.title
    ? `《${options.track.title}》${options.track.artist ? ` - ${options.track.artist}` : ""}`
    : "音乐";
  void notifyChatHistory(
    characterId,
    options.inviter === "char"
      ? `[一起听] ${charName}邀请${userLabel}一起听${song}，${userLabel}已接受并开始一起听。`
      : `[一起听] ${userLabel}邀请${charName}一起听${song}，现在开始一起听。`,
  );
}

export async function endListenTogether(options?: { silent?: boolean }): Promise<void> {
  const previous = currentState;
  patchState({ ...EMPTY_STATE });
  if (previous.status === "active" && !options?.silent && previous.characterId) {
    void notifyChatHistory(previous.characterId, `[一起听] ${currentUserLabel(previous.characterId)}结束了和${previous.characterName}的一起听。`);
  }
}

export function setPendingCharInvite(options: {
  characterId: string;
  characterName: string;
  track?: ListenTogetherTrackLike | null;
}): void {
  if (!options.characterId) return;
  patchState({
    status: "pending_char",
    characterId: options.characterId,
    characterName: options.characterName || "TA",
    trackId: options.track?.id || null,
    trackTitle: options.track?.title || "",
    trackArtist: options.track?.artist || "",
    inviter: "char",
  });
}

export function syncListenTogetherTrack(track: ListenTogetherTrackLike | null, source: ListenTogetherSource): void {
  const state = currentState;
  if (state.status !== "active" || !state.characterId) return;
  const nextId = track?.id || null;
  if (nextId && nextId === state.trackId && track?.title === state.trackTitle) return;
  const next: ListenTogetherState = {
    ...state,
    trackId: nextId,
    trackTitle: track?.title || state.trackTitle,
    trackArtist: track?.artist || state.trackArtist,
    updatedAt: new Date().toISOString(),
  };
  write(next);
  if (source === "user" && next.trackTitle && next.characterId) {
    void notifyChatHistory(
      next.characterId,
      `[一起听] ${currentUserLabel(next.characterId)}把一起听的歌换成了《${next.trackTitle}》${next.trackArtist ? ` - ${next.trackArtist}` : ""}。`,
    );
  }
}

async function notifyChatHistory(characterId: string, content: string) {
  try {
    const chat = await import("./chat-storage");
    await chat.hydrateChatStorage();
    const session = chat.createOrGetSession(characterId);
    chat.pushChatMessage({
      sessionId: session.id,
      role: "system",
      content,
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    }
  } catch (err) {
    console.warn("[ListenTogether] notify chat failed", err);
  }
}
