import { callQaAgent, compactQaContext, formatQaErrorMessage, type QaContextEntry } from "./qa-agent-engine";
import { QA_TOOLS, formatQaToolSubtitle, type QaCreatedContent, type QaProposedCommit } from "./qa-agent-tools";
import { loadQaGithubConfig } from "./qa-github";
import { commitQaFiles, revertQaCommit, type QaCommitResult } from "./qa-github-write";

// ── 答疑 App 会话存储 ─────────────────────────────────
// 模式与 mascot-chat-store 一致：裸 IndexedDB + 模块级单例 + subscribe/snapshot。
// 独立 DB，多会话。

const QA_DB_NAME = "AiPhoneQaDB";
// A restore into a fresh browser creates the missing store in DB version 2.
// Keep the owner at least that high so reopening the restored DB cannot fail
// with VersionError (opening a lower version than the one on disk).
const QA_DB_VERSION = 2;
const QA_STORE = "qa";
const QA_STATE_KEY = "state";
const MAX_SESSIONS = 30;
const MAX_MESSAGES_PER_SESSION = 200;

export type QaToolStatus = { name: string; running: boolean; success?: boolean; detail?: string; result?: string; subtitle?: string };

export type QaTextAttachment = { name: string; content: string };

export const QA_TEXT_ATTACHMENT_MAX_BYTES = 1024 * 1024;
export const QA_TEXT_ATTACHMENTS_MAX_COUNT = 6;
export const QA_TEXT_ATTACHMENTS_MAX_CHARS = 200_000;

export function validateQaTextAttachments(files?: QaTextAttachment[]): string | null {
    if (!files?.length) return null;
    if (files.length > QA_TEXT_ATTACHMENTS_MAX_COUNT) return `最多添加 ${QA_TEXT_ATTACHMENTS_MAX_COUNT} 个附件。`;
    if (new Set(files.map((file) => file.name)).size !== files.length) return "不能添加同名附件。";
    const chars = files.reduce((sum, file) => sum + file.name.length + file.content.length, 0);
    if (chars > QA_TEXT_ATTACHMENTS_MAX_CHARS) {
        return `附件文本合计不能超过 ${Math.floor(QA_TEXT_ATTACHMENTS_MAX_CHARS / 1000)}K 字符。`;
    }
    return null;
}

/** 消息内的时序分段：文字与工具行按实际发生顺序交错展示 */
export type QaSegment =
    | { kind: "text"; text: string }
    | { kind: "tool"; tool: QaToolStatus };

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
    /** user：随消息发送的图片（dataURL），点击可查看 */
    images?: string[];
    /** user：随消息发送的纯文本或代码附件 */
    files?: QaTextAttachment[];
    reasoning?: string;
    error?: string;
    aborted?: boolean;
    tools?: QaToolStatus[];
    /** 时序分段（文字/工具交错）；无此字段的旧消息回退「工具在顶、文字在下」布局 */
    segments?: QaSegment[];
    pendingCommit?: QaPendingCommit;
    /** 流过滤器正在缓冲长工具指令：显示"编写工具调用中"占位（瞬态，不持久） */
    toolDrafting?: boolean;
    /** 流式中断降级为非流式时的说明（解释"停几分钟后一口气全出"） */
    streamNote?: string;
    ts: number;
};

export type QaSession = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: QaMsg[];
    /** 抽屉里置顶显示；只影响排序，不动 updatedAt */
    isPinned?: boolean;
    /** 模型侧完整上下文（含工具调用与结果），跨轮保留；触顶时压缩为摘要 */
    context?: QaContextEntry[];
    /** 本会话中 agent 创建/更新过的本机内容（APP/游戏/剧场），供工坊内预览直接打开 */
    createdContent?: QaCreatedContent[];
};

export type QaChatSnapshot = {
    sessions: QaSession[];
    activeSessionId: string | null;
    hydrated: boolean;
    isGenerating: boolean;
    /** 当前会话上下文用量（0-1+，达到 1 触发压缩） */
    contextUsage: number;
    isCompacting: boolean;
};

// ── 上下文预算与压缩 ──
// 预算按字符估算（中文 ≈1 字符/角标 token 量级）。可用 localStorage
// 键 ai_phone_qa_context_budget_chars 覆盖（调参/测试用）。
const DEFAULT_CONTEXT_BUDGET_CHARS = 1_000_000;

function getContextBudget(): number {
    try {
        const raw = Number(localStorage.getItem("ai_phone_qa_context_budget_chars"));
        if (Number.isFinite(raw) && raw >= 2_000 && raw <= 2_000_000) return Math.floor(raw);
    } catch {
        // ignore
    }
    return DEFAULT_CONTEXT_BUDGET_CHARS;
}

function entryChars(entry: QaContextEntry): number {
    let total = entry.content.length;
    for (const file of entry.files ?? []) total += file.name.length + file.content.length;
    for (const call of entry.toolCalls ?? []) {
        total += call.name.length + JSON.stringify(call.args ?? {}).length;
    }
    return total;
}

/** 旧会话没有 context 字段：用可见消息引导出初始上下文 */
function sessionContext(session: QaSession): QaContextEntry[] {
    if (session.context?.length) return session.context;
    const entries: QaContextEntry[] = [];
    for (let index = 0; index < session.messages.length; index += 1) {
        const message = session.messages[index];
        if (message.error || (!message.content.trim() && !message.images?.length && !message.files?.length)) continue;
        if (message.role === "user") {
            const turn = session.messages.slice(index + 1).find((candidate) => candidate.role === "assistant")?.id;
            entries.push({
                role: "user",
                content: message.content,
                images: message.images,
                files: message.files,
                turn,
            });
        } else {
            entries.push({ role: "assistant", content: message.content, turn: message.id });
        }
    }
    return entries;
}

function contextUsageOf(session: QaSession | null): number {
    if (!session) return 0;
    const total = sessionContext(session).reduce((sum, entry) => sum + entryChars(entry), 0);
    return total / getContextBudget();
}

let isCompacting = false;

export const QA_DEFAULT_CONTEXT_BUDGET_CHARS = DEFAULT_CONTEXT_BUDGET_CHARS;
export const QA_CONTEXT_BUDGET_MIN = 2_000;
export const QA_CONTEXT_BUDGET_MAX = 2_000_000;

export function getQaContextBudgetChars(): number {
    return getContextBudget();
}

/** 设置上下文预算（null = 恢复默认）；立即刷新进度条 */
export function setQaContextBudgetChars(chars: number | null): void {
    try {
        if (chars == null) localStorage.removeItem("ai_phone_qa_context_budget_chars");
        else {
            const clamped = Math.min(QA_CONTEXT_BUDGET_MAX, Math.max(QA_CONTEXT_BUDGET_MIN, Math.floor(chars)));
            localStorage.setItem("ai_phone_qa_context_budget_chars", String(clamped));
        }
    } catch {
        // ignore
    }
    emit();
}

/** 当前会话已用的上下文字符数 */
export function getQaActiveContextChars(): number {
    const session = getActiveSession();
    return session ? sessionContext(session).reduce((sum, entry) => sum + entryChars(entry), 0) : 0;
}

/** 是否存在可清理的工具调用历史（tool 条目或带原生 toolCalls 的条目） */
export function hasQaToolHistory(): boolean {
    const session = getActiveSession();
    if (!session) return false;
    return sessionContext(session).some((entry) => entry.role === "tool" || (entry.toolCalls?.length ?? 0) > 0);
}

/** 清理原生工具历史（防报错）：移除 tool 条目、剥离原生调用元数据；普通对话内容保留 */
export function clearQaToolHistory(): { removed: number; cleaned: number } | null {
    const session = getActiveSession();
    if (!session || isGenerating) return null;
    let removed = 0;
    let cleaned = 0;
    const next: QaContextEntry[] = [];
    for (const entry of sessionContext(session)) {
        if (entry.role === "tool") {
            removed += 1;
            continue;
        }
        if (entry.toolCalls?.length) {
            cleaned += 1;
            const { toolCalls: _toolCalls, ...rest } = entry;
            next.push(rest);
        } else {
            next.push(entry);
        }
    }
    updateSession(session.id, (s) => ({ ...s, context: next }));
    return { removed, cleaned };
}

/** 压缩：整段上下文 → 备忘录摘要，失败时保留原上下文下轮再试 */
async function compactSessionContext(sessionId: string): Promise<void> {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || isCompacting) return;
    const entries = sessionContext(session);
    if (entries.length === 0) return;
    isCompacting = true;
    emit();
    try {
        const summary = await compactQaContext(entries);
        if (!summary) throw new Error("空摘要");
        updateSession(sessionId, (s) => ({
            ...s,
            context: [{
                role: "user",
                content: `[之前对话的压缩摘要，供你延续上下文；具体内容可用工具重新读取]\n${summary}`,
            }],
        }));
    } catch {
        // 压缩失败不阻塞对话：保留原上下文，下次触顶再试
    } finally {
        isCompacting = false;
        emit();
    }
}

type PersistedState = { sessions: QaSession[]; activeSessionId: string | null };

const listeners = new Set<() => void>();
let sessions: QaSession[] = [];
let activeSessionId: string | null = null;
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let isGenerating = false;
let abortController: AbortController | null = null;
let snapshot: QaChatSnapshot = { sessions, activeSessionId, hydrated, isGenerating, contextUsage: 0, isCompacting: false };

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
    snapshot = {
        sessions,
        activeSessionId,
        hydrated,
        isGenerating,
        contextUsage: contextUsageOf(sessions.find((s) => s.id === activeSessionId) ?? null),
        isCompacting,
    };
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

/** 重命名对话：只改标题，不碰 updatedAt——改个名字不该把会话顶到时间序最前 */
export function renameQaSession(id: string, title: string): void {
    const trimmed = title.trim().slice(0, 80);
    if (!trimmed) return;
    updateSession(id, (s) => ({ ...s, title: trimmed }));
}

/** 置顶开关：排序在抽屉渲染层做（置顶在前，其余按时间），存储顺序保持时间序 */
export function toggleQaSessionPin(id: string): void {
    updateSession(id, (s) => ({ ...s, isPinned: !s.isPinned }));
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

export type QaMessageEditResult = { ok: true } | { ok: false; reason: string };

function userMessageTurnId(session: QaSession, messageIndex: number): string | undefined {
    return session.messages.slice(messageIndex + 1).find((message) => message.role === "assistant")?.id;
}

function resendTurnIds(session: QaSession, messageIndex: number): Set<string> {
    return new Set(
        session.messages
            .slice(messageIndex + 1)
            .filter((message) => message.role === "assistant")
            .map((message) => message.id),
    );
}

/** 返回无法安全重新生成的原因；null 表示这是一段无工具副作用的用户对话。 */
export function getQaEditAndResendBlockReason(sessionId: string, msgId: string): string | null {
    if (isGenerating || isCompacting) return "小坊正在执行或整理上下文，请等待当前任务完成。";
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return "会话已不存在。";
    const messageIndex = session.messages.findIndex((message) => message.id === msgId);
    if (messageIndex < 0) return "消息已不存在。";
    const message = session.messages[messageIndex];
    if (message.role !== "user") return "只有用户消息可以修改后重新发送。";
    if (!userMessageTurnId(session, messageIndex)) return "这条消息缺少完整的回复轮次，无法安全重新发送。";

    const turnIds = resendTurnIds(session, messageIndex);
    const visibleSideEffects = session.messages.slice(messageIndex + 1).some((candidate) =>
        candidate.role === "assistant" && (Boolean(candidate.tools?.length) || Boolean(candidate.pendingCommit)),
    );
    const contextSideEffects = sessionContext(session).some((entry) =>
        Boolean(entry.turn && turnIds.has(entry.turn) && (entry.role === "tool" || entry.toolCalls?.length)),
    );
    if (visibleSideEffects || contextSideEffects) {
        return "后续回复已经调用工具或产生实际操作，不能安全回滚；你仍可以保存文字修改。";
    }
    return null;
}

/** 修改已发送消息，并同步模型侧上下文。 */
export function updateQaMessageContent(
    sessionId: string,
    msgId: string,
    content: string,
    images?: string[],
    files?: QaTextAttachment[],
): QaMessageEditResult {
    if (isGenerating || isCompacting) return { ok: false, reason: "小坊正在执行或整理上下文，请稍后再修改。" };
    if (!content.trim() && !images?.length && !files?.length) return { ok: false, reason: "消息内容不能为空。" };
    const filesError = validateQaTextAttachments(files);
    if (filesError) return { ok: false, reason: filesError };

    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return { ok: false, reason: "会话已不存在。" };
    const messageIndex = session.messages.findIndex((message) => message.id === msgId);
    if (messageIndex < 0) return { ok: false, reason: "消息已不存在。" };
    const message = session.messages[messageIndex];
    let nextContext = session.context;

    if (nextContext?.length) {
        if (message.role === "user") {
            const turn = userMessageTurnId(session, messageIndex);
            if (!turn || !nextContext.some((entry) => entry.role === "user" && entry.turn === turn)) {
                return { ok: false, reason: "这条旧消息缺少上下文索引，无法安全修改。" };
            }
            nextContext = nextContext.map((entry) =>
                entry.role === "user" && entry.turn === turn
                    ? { ...entry, content, images: images?.length ? images : undefined, files: files?.length ? files : undefined }
                    : entry,
            );
        } else {
            const assistantIndexes = nextContext
                .map((entry, index) => (entry.role === "assistant" && entry.turn === message.id ? index : -1))
                .filter((index) => index >= 0);
            const lastAssistantIndex = assistantIndexes.at(-1);
            if (lastAssistantIndex == null) return { ok: false, reason: "这条旧消息缺少上下文索引，无法安全修改。" };
            nextContext = nextContext.map((entry, index) =>
                entry.role === "assistant" && entry.turn === message.id
                    ? { ...entry, content: index === lastAssistantIndex ? content : "" }
                    : entry,
            );
        }
    }

    updateSession(sessionId, (current) => ({
        ...current,
        updatedAt: Date.now(),
        context: nextContext,
        messages: current.messages.map((candidate) =>
            candidate.id === msgId
                ? { ...candidate, content, images: images?.length ? images : undefined, files: files?.length ? files : undefined, segments: undefined }
                : candidate,
        ),
    }));
    return { ok: true };
}

/** 修改用户消息并重新生成。只允许截断没有工具副作用的纯对话。 */
export function editAndResendQaMessage(
    sessionId: string,
    msgId: string,
    content: string,
    images?: string[],
    files?: QaTextAttachment[],
): QaMessageEditResult {
    if (!content.trim() && !images?.length && !files?.length) return { ok: false, reason: "消息内容不能为空。" };
    const filesError = validateQaTextAttachments(files);
    if (filesError) return { ok: false, reason: filesError };
    const blocked = getQaEditAndResendBlockReason(sessionId, msgId);
    if (blocked) return { ok: false, reason: blocked };

    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session || activeSessionId !== sessionId) return { ok: false, reason: "当前会话已经切换，请重新操作。" };
    const messageIndex = session.messages.findIndex((message) => message.id === msgId);
    if (messageIndex < 0) return { ok: false, reason: "消息已不存在。" };
    const removedTurns = resendTurnIds(session, messageIndex);
    const prefixContext = session.context?.filter((entry) => !entry.turn || !removedTurns.has(entry.turn));

    updateSession(sessionId, (current) => ({
        ...current,
        messages: current.messages.slice(0, messageIndex),
        context: prefixContext,
        updatedAt: Date.now(),
    }));
    void sendQaMessage(content, images, files);
    return { ok: true };
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

export async function sendQaMessage(
    text: string,
    images?: string[],
    files?: QaTextAttachment[],
    options?: { /** true=不显示用户气泡，只把指令写入上下文（重试续接等内部续发用） */ silentUser?: boolean },
): Promise<void> {
    const trimmed = text.trim();
    if ((!trimmed && !images?.length && !files?.length) || isGenerating || isCompacting || validateQaTextAttachments(files)) return;

    let session = getActiveSession();
    if (!session) {
        createQaSession();
        session = getActiveSession();
        if (!session) return;
    }
    const sessionId = session.id;

    const nextEntry: QaContextEntry = {
        role: "user",
        content: trimmed || "（用户发来图片或附件）",
        images: images?.length ? images : undefined,
        files: files?.length ? files : undefined,
    };
    // 当前内容加上新消息将触顶时，先压缩再开新轮。
    const nextUsage = contextUsageOf(session) + entryChars(nextEntry) / getContextBudget();
    if (nextUsage >= 1) {
        await compactSessionContext(sessionId);
    }

    const userMsg: QaMsg = {
        id: makeId(),
        role: "user",
        content: trimmed,
        images: images?.length ? images : undefined,
        files: files?.length ? files : undefined,
        ts: Date.now(),
    };
    const assistantMsg: QaMsg = { id: makeId(), role: "assistant", content: "", ts: Date.now() };

    updateSession(sessionId, (s) => ({
        ...s,
        title: s.messages.length === 0 ? autoTitle(trimmed || "（图片/附件）") : s.title,
        updatedAt: Date.now(),
        messages: [...s.messages, ...(options?.silentUser ? [] : [userMsg]), assistantMsg].slice(-MAX_MESSAGES_PER_SESSION),
        context: [...sessionContext(s), { ...nextEntry, turn: assistantMsg.id }],
    }));

    isGenerating = true;
    const controller = new AbortController();
    abortController = controller;
    emit();

    let streamedContent = "";
    let streamedReasoning = "";
    let toolStatuses: QaToolStatus[] = [];
    let segments: QaSegment[] = [];
    let stagedCommit: QaPendingCommit | undefined;
    let lastPaintAt = 0;
    let lastPaintLength = 0;

    const paintAssistant = (patch: Partial<QaMsg>, options?: { persist?: boolean; force?: boolean }) => {
        const now = Date.now();
        if (!options?.force && streamedContent.length - lastPaintLength < 64 && now - lastPaintAt < 150) return;
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

    // 工具行的参数/结果只存 UI 需要的头部：完整内容只属于模型上下文，
    // 90k 级的读取结果整条进渲染与持久层会把低端机拖垮
    const clipForUi = (text: string | undefined): string | undefined => {
        if (text == null) return undefined;
        return text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断，完整内容共 ${text.length.toLocaleString()} 字符）` : text;
    };

    try {
        const history = (getActiveSession()?.messages ?? [])
            .filter((m) => m.id !== assistantMsg.id && !m.error)
            .map((m) => ({ role: m.role, content: m.content }));
        const contextForTurn = sessionContext(sessions.find((s) => s.id === sessionId) ?? session);

        const autoCommit = loadQaGithubConfig()?.writeMode === "auto";
        await callQaAgent(history, {
            signal: controller.signal,
            autoCommit,
            context: contextForTurn,
            onContext: (entry) => {
                updateSession(
                    sessionId,
                    (s) => ({ ...s, context: [...sessionContext(s), { ...entry, turn: assistantMsg.id }] }),
                    { persist: false },
                );
            },
            callbacks: {
                onDelta: (delta) => {
                    streamedContent += delta;
                    const last = segments[segments.length - 1];
                    if (last?.kind === "text") {
                        segments = [...segments.slice(0, -1), { kind: "text", text: last.text + delta }];
                    } else {
                        segments = [...segments, { kind: "text", text: delta }];
                    }
                    paintAssistant({ content: streamedContent, reasoning: streamedReasoning, segments }, { persist: false });
                },
                onReasoningDelta: (delta) => {
                    streamedReasoning += delta;
                    paintAssistant({ reasoning: streamedReasoning }, { persist: false });
                },
                onToolStart: (name, args) => {
                    const detail = args && Object.keys(args).length > 0 ? clipForUi(JSON.stringify(args, null, 2)) : undefined;
                    const subtitle = formatQaToolSubtitle(name, args) || undefined;
                    const status: QaToolStatus = { name: toolLabel(name), running: true, detail, subtitle };
                    toolStatuses = [...toolStatuses, status];
                    segments = [...segments, { kind: "tool", tool: status }];
                    paintAssistant({ tools: toolStatuses, segments }, { force: true, persist: false });
                },
                // 引擎静默续接时给用户一行可见说明——否则模型突然谈"被截断"显得没头没脑
                onAutoContinue: (reason) => {
                    const status: QaToolStatus = {
                        name: "自动续写",
                        running: false,
                        success: true,
                        subtitle: reason === "truncated" ? "输出到达单次上限被截断，已自动接力" : "分段未完，自动继续",
                    };
                    toolStatuses = [...toolStatuses, status];
                    segments = [...segments, { kind: "tool", tool: status }];
                    paintAssistant({ tools: toolStatuses, segments }, { force: true, persist: false });
                },
                onToolDone: (name, success, result) => {
                    let patched = false;
                    const done: QaToolStatus[] = [];
                    toolStatuses = toolStatuses.map((t) =>
                        !patched && t.running && t.name === toolLabel(name)
                            ? ((patched = true), done[0] = { ...t, running: false, success, result: clipForUi(result) }, done[0])
                            : t,
                    );
                    if (done[0]) {
                        let segPatched = false;
                        segments = segments.map((seg) =>
                            !segPatched && seg.kind === "tool" && seg.tool.running && seg.tool.name === toolLabel(name)
                                ? ((segPatched = true), { kind: "tool" as const, tool: done[0] })
                                : seg,
                        );
                    }
                    paintAssistant({ tools: toolStatuses, segments }, { force: true, persist: false });
                },
                onStageCommit: (proposal) => {
                    stagedCommit = { proposal, status: "pending" };
                    paintAssistant({ pendingCommit: stagedCommit }, { force: true, persist: false });
                },
                // 全自动模式：工具内当场提交，保证同一轮里「创建PR」等后续工具看到已落地的提交
                commitNow: async (proposal) => {
                    const config = loadQaGithubConfig();
                    if (!config) {
                        stagedCommit = { proposal, status: "canceled", error: "仓库配置已丢失。" };
                        paintAssistant({ pendingCommit: stagedCommit }, { force: true, persist: false });
                        return { ok: false, error: "仓库配置已丢失。" };
                    }
                    stagedCommit = { proposal, status: "applying" };
                    paintAssistant({ pendingCommit: stagedCommit }, { force: true, persist: false });
                    try {
                        const result = await commitQaFiles(config, proposal, controller.signal);
                        stagedCommit = { proposal, status: "applied", result };
                        paintAssistant({ pendingCommit: stagedCommit }, { force: true, persist: false });
                        return { ok: true, htmlUrl: result.htmlUrl };
                    } catch (error) {
                        const message = formatQaErrorMessage(error);
                        stagedCommit = { proposal, status: "pending", error: message };
                        paintAssistant({ pendingCommit: stagedCommit }, { force: true, persist: false });
                        return { ok: false, error: message };
                    }
                },
                onToolDrafting: (drafting) => {
                    paintAssistant({ toolDrafting: drafting || undefined }, { force: true, persist: false });
                },
                onStreamFallback: (reason) => {
                    paintAssistant(
                        { streamNote: `流式传输中断，已切换为整段获取——需等完整生成后一次性显示，请稍候。原因：${reason}` },
                        { force: true, persist: false },
                    );
                },
                onContentCreated: (item) => {
                    updateSession(
                        sessionId,
                        (s) => {
                            const rest = (s.createdContent ?? []).filter(
                                (c) => !(c.type === item.type && c.refId === item.refId),
                            );
                            return { ...s, createdContent: [...rest, item] };
                        },
                        { persist: true },
                    );
                },
            },
        });
        paintAssistant(
            {
                content: streamedContent,
                reasoning: streamedReasoning || undefined,
                tools: toolStatuses.length ? toolStatuses : undefined,
                segments: segments.length ? segments : undefined,
                pendingCommit: stagedCommit,
                toolDrafting: undefined,
            },
            { force: true },
        );
        // 全自动模式下提交已在工具内完成（commitNow）；这里只兜底处理提交失败留下的待办提案
        if (autoCommit && stagedCommit?.status === "pending" && !stagedCommit.error) {
            await applyQaCommit(assistantMsg.id);
        }
        // 本轮结束后触顶：立即压缩（进度条回到低位）
        if (contextUsageOf(sessions.find((s) => s.id === sessionId) ?? null) >= 1) {
            await compactSessionContext(sessionId);
        }
    } catch (error) {
        const finalTools = toolStatuses.length ? toolStatuses.map((t) => (t.running ? { ...t, running: false } : t)) : undefined;
        const finalSegments = segments.length
            ? segments.map((seg) => (seg.kind === "tool" && seg.tool.running ? { kind: "tool" as const, tool: { ...seg.tool, running: false } } : seg))
            : undefined;
        if (controller.signal.aborted) {
            // 中断续接：已执行的工具调用/结果已在上下文里；这里补齐悬空的原生调用结果、
            // 记录已流出的可见文本，下一轮「继续」能接上，原生协议也不会因缺 tool 结果报错
            updateSession(sessionId, (s) => {
                const entries = sessionContext(s);
                const turnEntries = entries.filter((entry) => entry.turn === assistantMsg.id);
                const answered = new Set(turnEntries.filter((entry) => entry.role === "tool" && entry.toolCallId).map((entry) => entry.toolCallId));
                const patches: QaContextEntry[] = [];
                for (const entry of turnEntries) {
                    if (entry.role !== "assistant") continue;
                    for (const call of entry.toolCalls ?? []) {
                        if (call.id && !answered.has(call.id)) {
                            patches.push({ role: "tool", toolCallId: call.id, name: call.name, content: "（用户中断，本次调用未完成）", turn: assistantMsg.id });
                        }
                    }
                }
                if (streamedContent.trim() || patches.length > 0) {
                    patches.push({
                        role: "assistant",
                        content: `${streamedContent.trim()}\n（本轮被用户中断，回复「继续」可接着做）`.trim(),
                        turn: assistantMsg.id,
                    });
                }
                return patches.length > 0 ? { ...s, context: [...entries, ...patches] } : s;
            });
            paintAssistant(
                { content: streamedContent, reasoning: streamedReasoning || undefined, tools: finalTools, segments: finalSegments, aborted: true, toolDrafting: undefined },
                { force: true },
            );
        } else {
            // 报错续接：与中断同构——已执行的工具结果保留在上下文，补齐悬空原生调用，
            // 记录已流出的文本；「重试」据此从中断处继续，而不是整轮作废重来
            const reason = formatQaErrorMessage(error);
            updateSession(sessionId, (s) => {
                const entries = sessionContext(s);
                const turnEntries = entries.filter((entry) => entry.turn === assistantMsg.id);
                const answered = new Set(turnEntries.filter((entry) => entry.role === "tool" && entry.toolCallId).map((entry) => entry.toolCallId));
                const patches: QaContextEntry[] = [];
                for (const entry of turnEntries) {
                    if (entry.role !== "assistant") continue;
                    for (const call of entry.toolCalls ?? []) {
                        if (call.id && !answered.has(call.id)) {
                            patches.push({ role: "tool", toolCallId: call.id, name: call.name, content: "（本次调用因报错未完成）", turn: assistantMsg.id });
                        }
                    }
                }
                if (streamedContent.trim() || patches.length > 0) {
                    patches.push({
                        role: "assistant",
                        content: `${streamedContent.trim()}\n（本轮执行到一半因报错中断：${reason.slice(0, 200)}）`.trim(),
                        turn: assistantMsg.id,
                    });
                }
                return patches.length > 0 ? { ...s, context: [...entries, ...patches] } : s;
            });
            paintAssistant(
                { content: streamedContent, reasoning: streamedReasoning || undefined, tools: finalTools, segments: finalSegments, error: reason, toolDrafting: undefined },
                { force: true },
            );
        }
    } finally {
        isGenerating = false;
        if (abortController === controller) abortController = null;
        emit();
    }
}

/** 重试 = 续接：保留本轮已产出的文字与工具结果（已在上下文里），从中断处继续，
 *  而不是把半途成果整轮作废重来。失败消息本身保留（去掉报错态），下方接续新回复。 */
export async function retryQaMessage(assistantMsgId: string): Promise<void> {
    const session = getActiveSession();
    if (!session || isGenerating) return;
    const failed = session.messages.find((m) => m.id === assistantMsgId);
    if (!failed) return;
    const hadProgress = Boolean(failed.content.trim() || failed.tools?.length);
    // 失败消息转为普通历史：撤下报错条与重试按钮；若毫无产出则直接移除避免留空壳
    updateSession(session.id, (s) => ({
        ...s,
        messages: hadProgress
            ? s.messages.map((m) => (m.id === assistantMsgId ? { ...m, error: undefined } : m))
            : s.messages.filter((m) => m.id !== assistantMsgId),
    }));
    await sendQaMessage(
        "上一轮执行中途失败。请从中断的地方继续完成剩余部分，已经完成的操作和说过的内容不要重复。",
        undefined,
        undefined,
        { silentUser: true },
    );
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
