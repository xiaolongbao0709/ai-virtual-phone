import { callQaAgent, formatQaErrorMessage } from "./qa-agent-engine";
import { QA_TOOLS, type QaProposedCommit } from "./qa-agent-tools";
import { loadQaGithubConfig } from "./qa-github";
import { commitQaFiles, revertQaCommit, type QaCommitResult } from "./qa-github-write";

// ── 答疑 App 会话存储 ─────────────────────────────────
// 模式与 mascot-chat-store 一致：裸 IndexedDB + 模块级单例 + subscribe/snapshot。
// 独立 DB，多会话。

const QA_DB_NAME = "AiPhoneQaDB";
const QA_DB_VERSION = 1;
const QA_STORE = "qa";
const QA_STATE_KEY = "state";
const MAX_SESSIONS = 30;
const MAX_MESSAGES_PER_SESSION = 200;

export type QaToolStatus = { name: string; running: boolean; success?: boolean };

export type QaPendingCommit = {
    proposal: QaProposedCommit;
    status: "pending" | "applying" | "applied" | "reverting" | "reverted" | "canceled";
    result?: QaCommitResult;
    error?: string;
};

export type QaMsg = {
    id: string;
    role: "user" | "assistant";
    content: string;
    reasoning?: string;
    error?: string;
    aborted?: boolean;
    tools?: QaToolStatus[];
    pendingCommit?: QaPendingCommit;
    ts: number;
};

export type QaSession = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: QaMsg[];
};

export type QaChatSnapshot = {
    sessions: QaSession[];
    activeSessionId: string | null;
    hydrated: boolean;
    isGenerating: boolean;
};

type PersistedState = { sessions: QaSession[]; activeSessionId: string | null };

const listeners = new Set<() => void>();
let sessions: QaSession[] = [];
let activeSessionId: string | null = null;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let isGenerating = false;
let abortController: AbortController | null = null;
let snapshot: QaChatSnapshot = { sessions, activeSessionId, hydrated, isGenerating };

function makeId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function openQaDb(): IDBOpenDBRequest {
    const request = indexedDB.open(QA_DB_NAME, QA_DB_VERSION);
    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(QA_STORE)) {
            request.result.createObjectStore(QA_STORE);
        }
    };
    return request;
}

function emit() {
    snapshot = { sessions, activeSessionId, hydrated, isGenerating };
    for (const listener of listeners) listener();
}

function persistState() {
    if (typeof indexedDB === "undefined") return;
    try {
        const request = openQaDb();
        request.onsuccess = () => {
            try {
                const db = request.result;
                const tx = db.transaction(QA_STORE, "readwrite");
                const state: PersistedState = { sessions, activeSessionId };
                tx.objectStore(QA_STORE).put(state, QA_STATE_KEY);
                tx.oncomplete = () => db.close();
                tx.onerror = () => db.close();
            } catch {
                // 忽略持久化失败，内存态仍可用。
            }
        };
    } catch {
        // ignore
    }
}

function publish(options?: { persist?: boolean }) {
    if (options?.persist !== false) persistState();
    emit();
}

export function subscribeQaChat(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getQaChatSnapshot(): QaChatSnapshot {
    return snapshot;
}

export async function hydrateQaChat(): Promise<void> {
    if (hydrated) return;
    if (hydratePromise) return hydratePromise;
    hydratePromise = new Promise<void>((resolve) => {
        if (typeof indexedDB === "undefined") {
            hydrated = true;
            emit();
            resolve();
            return;
        }
        try {
            const request = openQaDb();
            request.onsuccess = () => {
                try {
                    const db = request.result;
                    const tx = db.transaction(QA_STORE, "readonly");
                    const get = tx.objectStore(QA_STORE).get(QA_STATE_KEY);
                    get.onsuccess = () => {
                        const state = get.result as PersistedState | undefined;
                        if (state && Array.isArray(state.sessions)) {
                            sessions = state.sessions.slice(0, MAX_SESSIONS);
                            activeSessionId =
                                state.activeSessionId && sessions.some((s) => s.id === state.activeSessionId)
                                    ? state.activeSessionId
                                    : (sessions[0]?.id ?? null);
                        }
                        hydrated = true;
                        emit();
                        db.close();
                        resolve();
                    };
                    get.onerror = () => {
                        hydrated = true;
                        emit();
                        db.close();
                        resolve();
                    };
                } catch {
                    hydrated = true;
                    emit();
                    resolve();
                }
            };
            request.onerror = () => {
                hydrated = true;
                emit();
                resolve();
            };
        } catch {
            hydrated = true;
            emit();
            resolve();
        }
    });
    return hydratePromise;
}

function getActiveSession(): QaSession | null {
    return sessions.find((s) => s.id === activeSessionId) ?? null;
}

export function createQaSession(): string {
    const session: QaSession = {
        id: makeId(),
        title: "新对话",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
    };
    sessions = [session, ...sessions].slice(0, MAX_SESSIONS);
    activeSessionId = session.id;
    publish();
    return session.id;
}

export function switchQaSession(sessionId: string) {
    if (!sessions.some((s) => s.id === sessionId)) return;
    activeSessionId = sessionId;
    publish();
}

export function deleteQaSession(sessionId: string) {
    sessions = sessions.filter((s) => s.id !== sessionId);
    if (activeSessionId === sessionId) {
        activeSessionId = sessions[0]?.id ?? null;
    }
    publish();
}

function updateSession(sessionId: string, updater: (session: QaSession) => QaSession, options?: { persist?: boolean }) {
    sessions = sessions
        .map((s) => (s.id === sessionId ? updater(s) : s))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    publish(options);
}

export function stopQaGeneration() {
    abortController?.abort();
}

function autoTitle(text: string): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > 18 ? `${compact.slice(0, 18)}…` : compact || "新对话";
}

export async function sendQaMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || isGenerating) return;

    let session = getActiveSession();
    if (!session) {
        createQaSession();
        session = getActiveSession();
        if (!session) return;
    }
    const sessionId = session.id;

    const userMsg: QaMsg = { id: makeId(), role: "user", content: trimmed, ts: Date.now() };
    const assistantMsg: QaMsg = { id: makeId(), role: "assistant", content: "", ts: Date.now() };

    updateSession(sessionId, (s) => ({
        ...s,
        title: s.messages.length === 0 ? autoTitle(trimmed) : s.title,
        updatedAt: Date.now(),
        messages: [...s.messages, userMsg, assistantMsg].slice(-MAX_MESSAGES_PER_SESSION),
    }));

    isGenerating = true;
    const controller = new AbortController();
    abortController = controller;
    emit();

    let streamedContent = "";
    let streamedReasoning = "";
    let toolStatuses: QaToolStatus[] = [];
    let stagedCommit: QaPendingCommit | undefined;
    let lastPaintAt = 0;
    let lastPaintLength = 0;

    const paintAssistant = (patch: Partial<QaMsg>, options?: { persist?: boolean; force?: boolean }) => {
        const now = Date.now();
        if (!options?.force && streamedContent.length - lastPaintLength < 12 && now - lastPaintAt < 50) return;
        lastPaintAt = now;
        lastPaintLength = streamedContent.length;
        updateSession(
            sessionId,
            (s) => ({
                ...s,
                updatedAt: Date.now(),
                messages: s.messages.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m)),
            }),
            { persist: options?.persist !== false },
        );
    };

    const toolLabel = (name: string): string => QA_TOOLS.find((t) => t.name === name)?.name ?? name;

    try {
        const history = (getActiveSession()?.messages ?? [])
            .filter((m) => m.id !== assistantMsg.id && !m.error)
            .map((m) => ({ role: m.role, content: m.content }));

        const autoCommit = loadQaGithubConfig()?.writeMode === "auto";
        await callQaAgent(history, {
            signal: controller.signal,
            autoCommit,
            callbacks: {
                onDelta: (delta) => {
                    streamedContent += delta;
                    paintAssistant({ content: streamedContent, reasoning: streamedReasoning }, { persist: false });
                },
                onReasoningDelta: (delta) => {
                    streamedReasoning += delta;
                    paintAssistant({ reasoning: streamedReasoning }, { persist: false });
                },
                onToolStart: (name) => {
                    toolStatuses = [...toolStatuses, { name: toolLabel(name), running: true }];
                    paintAssistant({ tools: toolStatuses }, { force: true, persist: false });
                },
                onToolDone: (name, success) => {
                    let patched = false;
                    toolStatuses = toolStatuses.map((t) =>
                        !patched && t.running && t.name === toolLabel(name)
                            ? ((patched = true), { ...t, running: false, success })
                            : t,
                    );
                    paintAssistant({ tools: toolStatuses }, { force: true, persist: false });
                },
                onStageCommit: (proposal) => {
                    stagedCommit = { proposal, status: "pending" };
                    paintAssistant({ pendingCommit: stagedCommit }, { force: true, persist: false });
                },
            },
        });
        paintAssistant(
            {
                content: streamedContent,
                reasoning: streamedReasoning || undefined,
                tools: toolStatuses.length ? toolStatuses : undefined,
                pendingCommit: stagedCommit,
            },
            { force: true },
        );
        // 全自动模式：直接提交暂存的提案（用户仍可事后一键撤销）
        if (autoCommit && stagedCommit?.status === "pending") {
            await applyQaCommit(assistantMsg.id);
        }
    } catch (error) {
        const finalTools = toolStatuses.length ? toolStatuses.map((t) => (t.running ? { ...t, running: false } : t)) : undefined;
        if (controller.signal.aborted) {
            paintAssistant(
                { content: streamedContent, reasoning: streamedReasoning || undefined, tools: finalTools, aborted: true },
                { force: true },
            );
        } else {
            paintAssistant(
                { content: streamedContent, reasoning: streamedReasoning || undefined, tools: finalTools, error: formatQaErrorMessage(error) },
                { force: true },
            );
        }
    } finally {
        isGenerating = false;
        if (abortController === controller) abortController = null;
        emit();
    }
}

/** 重试：删除指定的失败 assistant 消息及其后内容，重发它前面的最后一条用户消息。 */
export async function retryQaMessage(assistantMsgId: string): Promise<void> {
    const session = getActiveSession();
    if (!session || isGenerating) return;
    const index = session.messages.findIndex((m) => m.id === assistantMsgId);
    if (index < 0) return;
    const userMsg = [...session.messages.slice(0, index)].reverse().find((m) => m.role === "user");
    if (!userMsg) return;
    updateSession(session.id, (s) => ({
        ...s,
        messages: s.messages.filter((m) => m.id !== assistantMsgId && m.id !== userMsg.id),
    }));
    await sendQaMessage(userMsg.content);
}

// ── 提交提案的确认 / 应用 / 撤销 ────────────────────

function patchPendingCommit(sessionId: string, msgId: string, patch: Partial<QaPendingCommit>) {
    updateSession(sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
            m.id === msgId && m.pendingCommit ? { ...m, pendingCommit: { ...m.pendingCommit, ...patch } } : m,
        ),
    }));
}

function findMsgWithPending(msgId: string): { sessionId: string; pending: QaPendingCommit } | null {
    for (const session of sessions) {
        const msg = session.messages.find((m) => m.id === msgId);
        if (msg?.pendingCommit) return { sessionId: session.id, pending: msg.pendingCommit };
    }
    return null;
}

/** 用户点「应用」：真正提交提案到 GitHub。 */
export async function applyQaCommit(msgId: string): Promise<void> {
    const found = findMsgWithPending(msgId);
    if (!found || found.pending.status !== "pending") return;
    const config = loadQaGithubConfig();
    if (!config) {
        patchPendingCommit(found.sessionId, msgId, { status: "canceled", error: "仓库配置已丢失。" });
        return;
    }
    patchPendingCommit(found.sessionId, msgId, { status: "applying" });
    try {
        const result = await commitQaFiles(config, found.pending.proposal);
        patchPendingCommit(found.sessionId, msgId, { status: "applied", result });
    } catch (error) {
        patchPendingCommit(found.sessionId, msgId, { status: "pending", error: formatQaErrorMessage(error) });
    }
}

/** 用户点「取消」：丢弃提案，不提交。 */
export function cancelQaCommit(msgId: string): void {
    const found = findMsgWithPending(msgId);
    if (!found || found.pending.status !== "pending") return;
    patchPendingCommit(found.sessionId, msgId, { status: "canceled" });
}

/** 用户点「撤销」：回退已应用的提交。 */
export async function revertQaAppliedCommit(msgId: string): Promise<void> {
    const found = findMsgWithPending(msgId);
    if (!found || found.pending.status !== "applied" || !found.pending.result) return;
    const config = loadQaGithubConfig();
    if (!config) return;
    patchPendingCommit(found.sessionId, msgId, { status: "reverting" });
    try {
        await revertQaCommit(config, found.pending.result);
        patchPendingCommit(found.sessionId, msgId, { status: "reverted" });
    } catch (error) {
        patchPendingCommit(found.sessionId, msgId, { status: "applied", error: formatQaErrorMessage(error) });
    }
}
