// lib/diary-reply-service.ts
// 用户在手记 App「我的日记」写完一篇给角色的日记后，角色按回应规则做出反应：
// 不回应 / 立即回应 / 延时回应 / 和下次互动合并。
//
// 立即/延时最终都走 requestBackgroundChatReply —— 跟正常聊天生成同一条路径，
// 预设/世界书/正则/长短期记忆/状态栏一样不缺，不是另起一条简化通道。
// 合并不主动发起新请求：挂在 chat-plugin 系统的 llm.request/llm.response 织入点上
// （跟插件用的是同一条总线，复用它已有的超时与错误隔离；这里传一个内部专用的
// pluginId，不会出现在插件管理页里，也不会被当成真的插件对待），等用户下一次
// 真的开口聊天时，把这篇日记顺带塞进那次请求，不产生额外一次 API 调用。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadChatMessages, loadChatSessions, type ChatMessage, type ChatSession } from "./chat-storage";
import { requestBackgroundChatReply } from "./follow-up-service";
import { getChatPluginHookBus } from "./chat-plugin-hooks";
import type { LlmRequestPayload, LlmResponsePayload } from "./chat-plugin-types";
import {
  loadDiaryEntries,
  loadDiaryReplyRules,
  resolveDiaryReplyRule,
} from "./diary-entry-storage";
import type { DiaryEntry } from "./diary-entry-types";
import { bgSetInterval, bgSetTimeout } from "./bg-timer";

const PENDING_KEY = "ai_phone_diary_reply_pending_v1";
const MERGE_QUEUE_KEY = "ai_phone_diary_reply_merge_queue_v1";
registerKvMigration(PENDING_KEY);
registerKvMigration(MERGE_QUEUE_KEY);

/** 挂在插件 hook 总线上用的内部标识：不是真插件，只是复用同一套织入机制。*/
const NATIVE_DIARY_REPLY_ID = "__native_diary_reply__";
const MERGE_MARKER = "[NATIVE_DIARY_REPLY_MERGE_V1]";
const CHECK_INTERVAL_MS = 60_000;

type PendingReplyTask = {
  id: string;
  userEntryId: string;
  characterId: string;
  dueAt: string;
  attempts: number;
};

type MergeQueueRecord = {
  id: string;
  userEntryId: string;
  characterId: string;
  sessionId: string;
  baselineFingerprint: string;
  interactionFingerprint: string;
  interactionUserMessageCount: number;
  responseSeen: boolean;
  queuedAtMs: number;
};

type ActiveReplyContext = {
  directive: string;
  expiresAt: number;
};

function generateId(prefix: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clip(value: string, max = 130): string {
  const s = value.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── 待处理队列（立即/延时）──────────────────────────────

function loadPending(): PendingReplyTask[] {
  try {
    const raw = kvGet(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => item && item.id && item.userEntryId && item.characterId) : [];
  } catch {
    return [];
  }
}

function savePending(items: PendingReplyTask[]): void {
  kvSet(PENDING_KEY, JSON.stringify(items.slice(0, 500)));
}

// ── 合并队列 ──────────────────────────────────────────

function loadMergeQueue(): MergeQueueRecord[] {
  try {
    const raw = kvGet(MERGE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - 120 * 24 * 60 * 60 * 1000;
    return parsed.filter(item => item && item.id && item.userEntryId && item.characterId && (!Number(item.queuedAtMs) || Number(item.queuedAtMs) >= cutoff));
  } catch {
    return [];
  }
}

function saveMergeQueue(items: MergeQueueRecord[]): void {
  kvSet(MERGE_QUEUE_KEY, JSON.stringify(items.slice(0, 300)));
}

// ── 指纹工具：判断某次 llm.request 是不是排队时那次请求的重试，
//    还是用户真的开口了新的一轮。──────────────────────────

function stableContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(stableContentText).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value as object).sort().map(key => `${key}:${stableContentText((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return String(value);
}

function shortStableHash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function requestFingerprint(purpose: string, sessionId: string, messages: { role: string; content: unknown }[]): string {
  const users = messages.filter(message => message.role === "user").map(message => stableContentText(message.content)).filter(Boolean);
  return `${purpose || "chat"}:${sessionId || ""}:${users.length}:${shortStableHash(users.join("␞"))}`;
}

function requestUserMessageCount(messages: { role: string }[]): number {
  return messages.filter(message => message.role === "user").length;
}

function lastConversationRole(messages: { role: string }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === "user" || role === "assistant" || role === "tool") return role;
  }
  return "";
}

function injectMarkedSystemMessage<T extends { role: string; content: unknown }>(messages: T[], content: string, marker: string): void {
  const existingIndex = messages.findIndex(message => typeof message.content === "string" && message.content.includes(marker));
  const injected = { role: "system", content } as unknown as T;
  if (existingIndex >= 0) {
    messages[existingIndex] = { ...messages[existingIndex], ...injected };
    return;
  }
  let index = 0;
  while (index < messages.length && messages[index]?.role === "system") index += 1;
  messages.splice(index, 0, injected);
}

// ── 会话解析 ──────────────────────────────────────────

function resolveDirectSession(characterId: string): ChatSession | null {
  const sessions = loadChatSessions().filter(session => !session.isGroup);
  return sessions.find(session => session.contactId === characterId) ?? null;
}

function baselineFingerprintFor(characterId: string): { sessionId: string; fingerprint: string } {
  const session = resolveDirectSession(characterId);
  if (!session) return { sessionId: "", fingerprint: "" };
  const messages = loadChatMessages(session.id) as ChatMessage[];
  return { sessionId: session.id, fingerprint: requestFingerprint("chat", session.id, messages) };
}

function diaryReplyDirective(entry: DiaryEntry): string {
  return [
    `[NATIVE_DIARY_REPLY:${entry.id}]`,
    "以下是用户写给你、还没有被回应过的私人日记。请在正常回应用户这一轮内容的同时，自然带出对这篇日记的回应，让用户能看出你确实读过；不要逐条复述、不要写成新日记、不要输出 JSON，也不要提到「提醒」「日记合并」这类字眼，就像你自己想起这件事一样自然融进这轮回复。",
    `日记标题：${entry.title}`,
    `日期：${entry.dateLabel || entry.createdAt}`,
    entry.mood ? `心情：${entry.mood}` : "",
    entry.weather ? `天气：${entry.weather}` : "",
    entry.signature ? `署名：${entry.signature}` : "",
    "日记正文：",
    clip(entry.body, 2600),
  ].filter(Boolean).join("\n");
}

// ── 立即/延时：主动发起一次后台聊天回复 ──────────────────

const activeReplyContexts = new Map<string, ActiveReplyContext>();

async function fireImmediateReply(entry: DiaryEntry, session: ChatSession): Promise<boolean> {
  activeReplyContexts.set(session.id, { directive: diaryReplyDirective(entry), expiresAt: Date.now() + 12 * 60_000 });
  try {
    const result = await requestBackgroundChatReply(session.id);
    return result.ok;
  } finally {
    bgSetTimeout(() => activeReplyContexts.delete(session.id), 12 * 60_000);
  }
}

let pendingBusy = false;

async function checkPendingReplies(): Promise<void> {
  if (pendingBusy || typeof window === "undefined") return;
  pendingBusy = true;
  try {
    let pending = loadPending();
    const dueCharacters = new Set<string>();
    const due = pending
      .filter(item => new Date(item.dueAt).getTime() <= Date.now())
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .filter(item => {
        if (dueCharacters.has(item.characterId)) return false;
        dueCharacters.add(item.characterId);
        return true;
      })
      .slice(0, 3);
    if (due.length === 0) return;

    const entries = loadDiaryEntries();
    for (const task of due) {
      const entry = entries.find(item => item.id === task.userEntryId && item.authorType === "user");
      if (!entry) {
        pending = pending.filter(item => item.id !== task.id);
        savePending(pending);
        continue;
      }
      const session = resolveDirectSession(task.characterId);
      if (!session) {
        const attempts = task.attempts + 1;
        pending = pending.map(item => item.id === task.id ? { ...item, attempts, dueAt: new Date(Date.now() + 5 * 60_000).toISOString() } : item);
        savePending(pending);
        continue;
      }
      pending = pending.filter(item => item.id !== task.id);
      savePending(pending);
      void fireImmediateReply(entry, session);
    }
  } finally {
    pendingBusy = false;
  }
}

// ── 对外：日记创建后调用这个，按规则决定要不要安排回应 ────

export function scheduleDiaryReply(entry: DiaryEntry): void {
  if (entry.authorType !== "user" || typeof window === "undefined") return;
  const rules = loadDiaryReplyRules();
  const rule = resolveDiaryReplyRule(rules, entry.characterId);
  if (rule.mode === "none") return;

  if (rule.mode === "merge") {
    const baseline = baselineFingerprintFor(entry.characterId);
    const queue = loadMergeQueue().filter(item => item.userEntryId !== entry.id);
    queue.push({
      id: generateId("diary_reply_merge"),
      userEntryId: entry.id,
      characterId: entry.characterId,
      sessionId: baseline.sessionId,
      baselineFingerprint: baseline.fingerprint,
      interactionFingerprint: "",
      interactionUserMessageCount: 0,
      responseSeen: false,
      queuedAtMs: Date.now(),
    });
    saveMergeQueue(queue);
    return;
  }

  const delayMs = rule.mode === "immediate" ? 0 : rule.delayHours * 3_600_000;
  const next = loadPending().filter(item => item.userEntryId !== entry.id);
  next.push({
    id: generateId("diary_reply"),
    userEntryId: entry.id,
    characterId: entry.characterId,
    dueAt: new Date(Date.now() + delayMs).toISOString(),
    attempts: 0,
  });
  savePending(next);
  if (rule.mode === "immediate") void checkPendingReplies();
}

/** 日记被删除时，把还没触发的排队/合并记录一并清掉。*/
export function cancelDiaryReply(userEntryId: string): void {
  saveMergeQueue(loadMergeQueue().filter(item => item.userEntryId !== userEntryId));
  savePending(loadPending().filter(item => item.userEntryId !== userEntryId));
}

// ── hook 总线织入：合并模式 + 立即/延时的兜底注入 ─────────

function handleLlmRequest(payload: LlmRequestPayload): LlmRequestPayload {
  if (!payload || payload.purpose !== "chat" || !payload.sessionId) return payload;
  const messages = Array.isArray(payload.messages) ? payload.messages.map(message => ({ ...message })) : [];
  let changed = false;

  const active = activeReplyContexts.get(payload.sessionId);
  if (active && active.expiresAt > Date.now()) {
    injectMarkedSystemMessage(messages, [
      "<active_diary_reply>",
      "以下日记是触发本次主动消息的当前事件，优先级高于一般寒暄。回复必须具体回应日记中的内容或情绪；不要写新日记，只发送角色会在聊天里发出的普通消息。",
      active.directive,
      "</active_diary_reply>",
    ].join("\n"), "[NATIVE_DIARY_ACTIVE_REPLY]");
    changed = true;
  }

  if (injectMergeIfDue(payload, messages)) changed = true;

  return changed ? { ...payload, messages } : payload;
}

function injectMergeIfDue(payload: LlmRequestPayload, messages: { role: string; content: unknown }[]): boolean {
  const queue = loadMergeQueue();
  if (queue.length === 0) return false;
  const session = loadChatSessions().find(item => item.id === payload.sessionId);
  if (!session || session.isGroup) return false;
  const characterId = session.contactId;

  const fingerprint = requestFingerprint(payload.purpose, payload.sessionId ?? "", payload.messages as { role: string; content: unknown }[]);
  const userMessageCount = requestUserMessageCount(payload.messages as { role: string }[]);
  const lastRole = lastConversationRole(payload.messages as { role: string }[]);

  const kept: MergeQueueRecord[] = [];
  const due: MergeQueueRecord[] = [];
  for (const record of queue) {
    if (record.characterId !== characterId || (record.sessionId && record.sessionId !== payload.sessionId)) {
      kept.push(record);
      continue;
    }
    if (!record.interactionFingerprint && record.baselineFingerprint && record.baselineFingerprint === fingerprint) {
      kept.push(record);
      continue;
    }
    if (record.interactionFingerprint && record.interactionFingerprint !== fingerprint && record.responseSeen) {
      if (userMessageCount > record.interactionUserMessageCount) continue;
      record.responseSeen = false;
    }
    if (!record.interactionFingerprint || record.interactionFingerprint !== fingerprint) {
      record.interactionFingerprint = fingerprint;
      record.interactionUserMessageCount = userMessageCount;
      record.responseSeen = false;
    }
    const retryableTurn = lastRole === "user" || lastRole === "tool" || !record.responseSeen;
    if (retryableTurn) due.push(record);
    kept.push(record);
  }
  saveMergeQueue(kept);
  if (due.length === 0) return false;

  const entries = loadDiaryEntries();
  const blocks = due
    .map(record => entries.find(entry => entry.id === record.userEntryId && entry.authorType === "user"))
    .filter((entry): entry is DiaryEntry => Boolean(entry))
    .map(diaryReplyDirective);
  if (blocks.length === 0) return false;

  injectMarkedSystemMessage(messages, [
    MERGE_MARKER,
    "以下是用户之前写给你、还没有被回应过的私人日记。请在正常回应用户这一轮内容的同时，自然带出对这些日记的回应（挑最相关的一条回应即可，不必逐条罗列）：",
    ...blocks,
    "不要把这段提示当成系统消息、提醒或队列来复述；就像你自己想起这件事一样自然地融进这轮回复。",
  ].join("\n\n"), MERGE_MARKER);

  activeMergeAttempts.push({ sessionId: payload.sessionId ?? "", fingerprint, recordIds: due.map(record => record.id), createdAt: Date.now() });
  while (activeMergeAttempts.length > 40) activeMergeAttempts.shift();
  return true;
}

type MergeAttempt = { sessionId: string; fingerprint: string; recordIds: string[]; createdAt: number };
const activeMergeAttempts: MergeAttempt[] = [];

function handleLlmResponse(payload: LlmResponsePayload): LlmResponsePayload {
  if (payload && payload.purpose === "chat" && payload.sessionId && activeReplyContexts.has(payload.sessionId) && String(payload.text || "").trim()) {
    activeReplyContexts.delete(payload.sessionId);
  }
  markMergeDelivered(payload);
  return payload;
}

function markMergeDelivered(payload: LlmResponsePayload): void {
  if (!payload || payload.purpose !== "chat" || !String(payload.text || "").trim()) return;
  const sessionId = payload.sessionId ?? "";
  const now = Date.now();
  for (let index = activeMergeAttempts.length - 1; index >= 0; index -= 1) {
    const attempt = activeMergeAttempts[index];
    if (now - attempt.createdAt > 30 * 60_000) {
      activeMergeAttempts.splice(index, 1);
      continue;
    }
    if (attempt.sessionId !== sessionId) continue;
    activeMergeAttempts.splice(index, 1);
    const ids = new Set(attempt.recordIds);
    const queue = loadMergeQueue();
    let changed = false;
    for (const record of queue) {
      if (!ids.has(record.id) || record.interactionFingerprint !== attempt.fingerprint) continue;
      record.responseSeen = true;
      changed = true;
    }
    if (changed) saveMergeQueue(queue);
    return;
  }
}

// ── 服务生命周期 ──────────────────────────────────────

let stopInterval: (() => void) | null = null;
let stopInitial: (() => void) | null = null;
let disposeRequestHook: (() => void) | null = null;
let disposeResponseHook: (() => void) | null = null;

export function startDiaryReplyService(): void {
  if (typeof window === "undefined" || stopInterval) return;
  const bus = getChatPluginHookBus();
  disposeRequestHook = bus.registerTransform(NATIVE_DIARY_REPLY_ID, "llm.request", handleLlmRequest as (payload: unknown) => unknown, 500);
  disposeResponseHook = bus.registerTransform(NATIVE_DIARY_REPLY_ID, "llm.response", handleLlmResponse as (payload: unknown) => unknown, 500);
  stopInterval = bgSetInterval(() => { void checkPendingReplies(); }, CHECK_INTERVAL_MS);
  stopInitial = bgSetTimeout(() => { void checkPendingReplies(); }, 1_500);
}

export function stopDiaryReplyService(): void {
  if (stopInterval) { stopInterval(); stopInterval = null; }
  if (stopInitial) { stopInitial(); stopInitial = null; }
  if (disposeRequestHook) { disposeRequestHook(); disposeRequestHook = null; }
  if (disposeResponseHook) { disposeResponseHook(); disposeResponseHook = null; }
  activeReplyContexts.clear();
}
