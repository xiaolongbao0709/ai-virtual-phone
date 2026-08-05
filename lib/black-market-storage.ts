import { BLACK_MARKET_BUILTIN_THEATERS } from "./black-market-builtins";
import { kvGet, kvKeysWithPrefix, kvSet, registerDynamicPrefix, registerKvMigration } from "./kv-db";
import { formatChatTimestamp } from "./llm-prompt-assembler";
import type {
  ActiveBlackMarketTheater,
  BlackMarketCheckinResult,
  BlackMarketOwnedTheater,
  BlackMarketPurchaseResult,
  BlackMarketRenderRule,
  BlackMarketSceneMessage,
  BlackMarketSceneSession,
  BlackMarketState,
  BlackMarketTheaterProjectionEntry,
  BlackMarketTheaterRarity,
  BlackMarketTheaterSource,
  BlackMarketTheaterStatus,
  BlackMarketTheaterTemplate,
  BlackMarketTransaction,
  BlackMarketTransactionType,
  BlackMarketWalletState,
} from "./black-market-types";

const BLACK_MARKET_STATE_KEY = "ai_phone_black_market_state_v1";
const BLACK_MARKET_USER_ID_KEY = "ai_phone_black_market_user_id_v1";
const BLACK_MARKET_SCENE_SESSIONS_KEY = "ai_phone_black_market_scene_sessions_v1";
const BLACK_MARKET_THEATER_EVENT_PREFIX = "ai_phone_black_market_theater_events_";
const MAX_BLACK_MARKET_SCENE_SESSIONS = 80;
const MAX_BLACK_MARKET_PROJECTION_EVENTS = 120;

export const BLACK_MARKET_UPDATED_EVENT = "ai-phone:black-market-updated";
export const BLACK_MARKET_INITIAL_CREDITS = 1000;
export const BLACK_MARKET_DAILY_CHECKIN_CREDITS = 200;
export const BLACK_MARKET_MAX_PRICE = 500;

registerKvMigration(BLACK_MARKET_STATE_KEY);
registerKvMigration(BLACK_MARKET_USER_ID_KEY);
registerKvMigration(BLACK_MARKET_SCENE_SESSIONS_KEY);
registerDynamicPrefix(BLACK_MARKET_THEATER_EVENT_PREFIX);

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function normalizeArray<T>(value: unknown, guard: (item: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(guard).filter((item): item is T => Boolean(item)) : [];
}

function createId(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}_${random}`;
}

function getLocalBlackMarketUserId(): string {
  if (typeof window === "undefined") return "local_user";
  const existing = cleanText(kvGet(BLACK_MARKET_USER_ID_KEY), 160);
  if (existing) return existing;
  const next = createId("bm_user");
  kvSet(BLACK_MARKET_USER_ID_KEY, next);
  return next;
}

function clampCredits(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.min(max, Math.max(0, Math.round(amount)));
}

function normalizePrice(value: unknown): number {
  return clampCredits(value, BLACK_MARKET_MAX_PRICE);
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeRarity(value: unknown): BlackMarketTheaterRarity {
  return value === "rare" || value === "legend" || value === "encrypted" ? value : "common";
}

function normalizeSource(value: unknown): BlackMarketTheaterSource {
  return value === "community" || value === "local" ? value : "builtin";
}

function normalizeStatus(value: unknown): BlackMarketTheaterStatus {
  return value === "active" || value === "used" ? value : "unused";
}

function normalizeTransactionType(value: unknown): BlackMarketTransactionType {
  if (
    value === "daily_checkin"
    || value === "purchase"
    || value === "creator_income"
    || value === "manual_adjust"
  ) {
    return value;
  }
  return "initial_grant";
}

function normalizeRenderRule(value: unknown): BlackMarketRenderRule | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 80);
  const pattern = cleanText(record.pattern, 1000);
  if (!id || !pattern) return null;
  return {
    id,
    name: cleanText(record.name, 80) || "渲染规则",
    pattern,
    flags: cleanText(record.flags, 12) || "g",
    className: cleanText(record.className, 120) || "bm-render-rule",
    template: cleanText(record.template, 2000) || "<span>$&</span>",
  };
}

export function normalizeBlackMarketTheaterTemplate(value: unknown): BlackMarketTheaterTemplate | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const title = cleanText(record.title, 80);
  const aiInstruction = cleanText(record.aiInstruction, 30000);
  const openingHtml = cleanText(record.openingHtml, 60000);
  if (!id || !title || !aiInstruction || !openingHtml) return null;
  return {
    id,
    title,
    codeName: cleanText(record.codeName, 80) || id.toUpperCase(),
    fileNumber: cleanText(record.fileNumber, 80),
    subtitle: cleanText(record.subtitle, 160),
    synopsis: cleanText(record.synopsis, 600),
    storyText: cleanText(record.storyText, 2000),
    tags: normalizeArray(record.tags, item => cleanText(item, 24) || null).slice(0, 8),
    rarity: normalizeRarity(record.rarity),
    glyph: cleanText(record.glyph, 8) || "◆",
    price: normalizePrice(record.price),
    authorId: cleanText(record.authorId, 160) || "anonymous",
    authorName: cleanText(record.authorName, 80) || "匿名卖家",
    source: normalizeSource(record.source),
    version: Math.max(1, clampCredits(record.version, 9999) || 1),
    durationTurns: Math.min(30, Math.max(1, clampCredits(record.durationTurns, 30) || 8)),
    allowExternalControl: record.allowExternalControl === true,
    openingHtml,
    aiInstruction,
    outputContract: cleanText(record.outputContract, 12000),
    renderRules: normalizeArray(record.renderRules, normalizeRenderRule).slice(0, 20),
    renderCss: cleanText(record.renderCss, 20000),
    memorySummaryPrompt: cleanText(record.memorySummaryPrompt, 12000),
    purchaseCount: clampCredits(record.purchaseCount),
    rating: Math.min(5, Math.max(0, Number(record.rating) || 0)),
    createdAt: cleanText(record.createdAt, 80) || new Date().toISOString(),
    updatedAt: cleanText(record.updatedAt, 80) || new Date().toISOString(),
  };
}

function normalizeOwnedTheater(value: unknown): BlackMarketOwnedTheater | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const templateSnapshot = normalizeBlackMarketTheaterTemplate(record.templateSnapshot);
  const localId = cleanText(record.localId, 160);
  const remoteTemplateId = cleanText(record.remoteTemplateId, 160) || templateSnapshot?.id || "";
  if (!localId || !remoteTemplateId || !templateSnapshot) return null;
  return {
    localId,
    remoteTemplateId,
    purchasedAt: cleanText(record.purchasedAt, 80) || new Date().toISOString(),
    templateSnapshot,
    status: normalizeStatus(record.status),
    useCount: clampCredits(record.useCount, 9999),
    lastActivatedAt: cleanText(record.lastActivatedAt, 80) || undefined,
    lastUsedAt: cleanText(record.lastUsedAt, 80) || undefined,
  };
}

function normalizeSceneMessage(value: unknown): BlackMarketSceneMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const content = cleanText(record.content, 30000);
  if (!id || !content) return null;
  return {
    id,
    role: record.role === "assistant" ? "assistant" : "user",
    content,
    createdAt: cleanText(record.createdAt, 80) || new Date().toISOString(),
  };
}

function normalizeSceneSession(value: unknown): BlackMarketSceneSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const localTheaterId = cleanText(record.localTheaterId, 160);
  const templateId = cleanText(record.templateId, 160);
  const title = cleanText(record.title, 80);
  const characterId = cleanText(record.characterId, 160);
  const characterName = cleanText(record.characterName, 80);
  const userName = cleanText(record.userName, 80) || "用户";
  if (!id || !localTheaterId || !templateId || !title || !characterId || !characterName) return null;
  return {
    id,
    localTheaterId,
    templateId,
    title,
    characterId,
    characterName,
    userName,
    startedAt: cleanText(record.startedAt, 80) || new Date().toISOString(),
    updatedAt: cleanText(record.updatedAt, 80) || new Date().toISOString(),
    endedAt: cleanText(record.endedAt, 80) || undefined,
    status: record.status === "ended" ? "ended" : "active",
    messages: normalizeArray(record.messages, normalizeSceneMessage).slice(0, 80),
    summary: cleanText(record.summary, 3000) || undefined,
    summaryWrittenAt: cleanText(record.summaryWrittenAt, 80) || undefined,
  };
}

function normalizeActiveTheater(value: unknown): ActiveBlackMarketTheater | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const instanceId = cleanText(record.instanceId, 160);
  const localTheaterId = cleanText(record.localTheaterId, 160);
  const templateId = cleanText(record.templateId, 160);
  const title = cleanText(record.title, 80);
  const chatId = cleanText(record.chatId, 180);
  if (!instanceId || !localTheaterId || !templateId || !title || !chatId) return null;
  return {
    instanceId,
    localTheaterId,
    templateId,
    title,
    targetCharacterId: cleanText(record.targetCharacterId, 160) || undefined,
    targetCharacterName: cleanText(record.targetCharacterName, 80) || undefined,
    chatId,
    startedAtMessageId: cleanText(record.startedAtMessageId, 160) || undefined,
    startedAt: cleanText(record.startedAt, 80) || new Date().toISOString(),
    aiInstruction: cleanText(record.aiInstruction, 30000),
    outputContract: cleanText(record.outputContract, 12000),
    renderRules: normalizeArray(record.renderRules, normalizeRenderRule).slice(0, 20),
    renderCss: cleanText(record.renderCss, 20000),
    memorySummaryPrompt: cleanText(record.memorySummaryPrompt, 12000),
    remainingTurns: Math.min(30, Math.max(0, clampCredits(record.remainingTurns, 30))),
    status: record.status === "ending" ? "ending" : "active",
  };
}

function normalizeTransaction(value: unknown): BlackMarketTransaction | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  if (!id) return null;
  const amount = Number(record.amount);
  return {
    id,
    type: normalizeTransactionType(record.type),
    amount: Number.isFinite(amount) ? Math.round(amount) : 0,
    title: cleanText(record.title, 80) || "暗影信用点流水",
    detail: cleanText(record.detail, 300),
    theaterId: cleanText(record.theaterId, 160) || undefined,
    theaterTitle: cleanText(record.theaterTitle, 80) || undefined,
    counterpartyId: cleanText(record.counterpartyId, 160) || undefined,
    counterpartyName: cleanText(record.counterpartyName, 80) || undefined,
    balanceAfter: clampCredits(record.balanceAfter),
    createdAt: cleanText(record.createdAt, 80) || new Date().toISOString(),
  };
}

function normalizeWallet(value: unknown): BlackMarketWalletState {
  if (!value || typeof value !== "object") return createDefaultWalletState();
  const record = value as Record<string, unknown>;
  const rawUserId = cleanText(record.userId, 160);
  return {
    userId: rawUserId && rawUserId !== "local_user" ? rawUserId : getLocalBlackMarketUserId(),
    displayName: cleanText(record.displayName, 80) || "本地玩家",
    balance: clampCredits(record.balance),
    lastCheckinDate: cleanText(record.lastCheckinDate, 20) || undefined,
    transactions: normalizeArray(record.transactions, normalizeTransaction).slice(0, 200),
    updatedAt: cleanText(record.updatedAt, 80) || new Date().toISOString(),
  };
}

function createTransaction(input: Omit<BlackMarketTransaction, "id" | "createdAt">): BlackMarketTransaction {
  return {
    ...input,
    id: createId("sc_tx"),
    createdAt: new Date().toISOString(),
  };
}

function createDefaultWalletState(): BlackMarketWalletState {
  const initial = createTransaction({
    type: "initial_grant",
    amount: BLACK_MARKET_INITIAL_CREDITS,
    title: "初始额度",
    detail: "黑市终端首次初始化。",
    balanceAfter: BLACK_MARKET_INITIAL_CREDITS,
  });
  return {
    userId: getLocalBlackMarketUserId(),
    displayName: "本地玩家",
    balance: BLACK_MARKET_INITIAL_CREDITS,
    transactions: [initial],
    updatedAt: new Date().toISOString(),
  };
}

export function createDefaultBlackMarketState(): BlackMarketState {
  return {
    wallet: createDefaultWalletState(),
    ownedTheaters: [],
    activeTheaters: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadBlackMarketState(): BlackMarketState {
  if (typeof window === "undefined") return createDefaultBlackMarketState();
  try {
    const raw = kvGet(BLACK_MARKET_STATE_KEY);
    if (!raw) return createDefaultBlackMarketState();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      wallet: normalizeWallet(parsed.wallet),
      ownedTheaters: normalizeArray(parsed.ownedTheaters, normalizeOwnedTheater).slice(0, 200),
      activeTheaters: normalizeArray(parsed.activeTheaters, normalizeActiveTheater).slice(0, 20),
      updatedAt: cleanText(parsed.updatedAt, 80) || new Date().toISOString(),
    };
  } catch {
    return createDefaultBlackMarketState();
  }
}

export function saveBlackMarketState(state: BlackMarketState): BlackMarketState {
  const next: BlackMarketState = {
    ...state,
    wallet: {
      ...state.wallet,
      balance: clampCredits(state.wallet.balance),
      transactions: state.wallet.transactions.slice(0, 200),
      updatedAt: new Date().toISOString(),
    },
    ownedTheaters: state.ownedTheaters.slice(0, 200),
    activeTheaters: state.activeTheaters.slice(0, 20),
    updatedAt: new Date().toISOString(),
  };
  kvSet(BLACK_MARKET_STATE_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BLACK_MARKET_UPDATED_EVENT, { detail: next }));
  }
  return next;
}

export function syncBlackMarketWallet(wallet: BlackMarketWalletState): BlackMarketState {
  const state = loadBlackMarketState();
  return saveBlackMarketState({
    ...state,
    wallet,
  });
}

export function formatShadowCredits(amount: number): string {
  const safeAmount = clampCredits(amount);
  return `¤ ${safeAmount.toLocaleString("zh-CN")}`;
}

export function getBlackMarketCatalog(): BlackMarketTheaterTemplate[] {
  return BLACK_MARKET_BUILTIN_THEATERS;
}

export function getOwnedBlackMarketTheaters(state = loadBlackMarketState()): BlackMarketOwnedTheater[] {
  return state.ownedTheaters;
}

export function getActiveBlackMarketTheaterForChat(chatId: string, state = loadBlackMarketState()): ActiveBlackMarketTheater | undefined {
  return state.activeTheaters.find(item => item.chatId === chatId && item.status === "active");
}

export function deleteBlackMarketOwnedTheater(localTheaterId: string): {
  ok: boolean;
  state: BlackMarketState;
  deletedTheater?: BlackMarketOwnedTheater;
  error?: string;
} {
  const state = loadBlackMarketState();
  const deletedTheater = state.ownedTheaters.find(item => item.localId === localTheaterId);
  if (!deletedTheater) return { ok: false, state, error: "暗柜中没有找到这份夜间档案。" };

  saveBlackMarketSceneSessions(loadBlackMarketSceneSessions().filter(session => session.localTheaterId !== localTheaterId));

  const next = saveBlackMarketState({
    ...state,
    ownedTheaters: state.ownedTheaters.filter(item => item.localId !== localTheaterId),
    activeTheaters: state.activeTheaters.filter(item => item.localTheaterId !== localTheaterId),
  });

  return { ok: true, state: next, deletedTheater };
}

export function loadBlackMarketSceneSessions(): BlackMarketSceneSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(BLACK_MARKET_SCENE_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeArray(parsed, normalizeSceneSession)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_BLACK_MARKET_SCENE_SESSIONS);
  } catch {
    return [];
  }
}

function saveBlackMarketSceneSessions(sessions: BlackMarketSceneSession[]): BlackMarketSceneSession[] {
  const compacted = [...sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_BLACK_MARKET_SCENE_SESSIONS);
  kvSet(BLACK_MARKET_SCENE_SESSIONS_KEY, JSON.stringify(compacted));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BLACK_MARKET_UPDATED_EVENT, { detail: loadBlackMarketState() }));
  }
  return compacted;
}

export function getBlackMarketSceneSession(sessionId: string): BlackMarketSceneSession | undefined {
  return loadBlackMarketSceneSessions().find(item => item.id === sessionId);
}

export function startBlackMarketSceneSession(input: {
  localTheaterId: string;
  characterId: string;
  characterName: string;
  userName: string;
}): { ok: boolean; state: BlackMarketState; session?: BlackMarketSceneSession; error?: string } {
  const state = loadBlackMarketState();
  const owned = state.ownedTheaters.find(item => item.localId === input.localTheaterId);
  if (!owned) return { ok: false, state, error: "暗柜中没有找到这份夜间档案。" };
  const template = owned.templateSnapshot;
  const now = new Date().toISOString();
  const session: BlackMarketSceneSession = {
    id: createId("bm_scene"),
    localTheaterId: owned.localId,
    templateId: template.id,
    title: template.title,
    characterId: input.characterId,
    characterName: input.characterName,
    userName: input.userName || "用户",
    startedAt: now,
    updatedAt: now,
    status: "active",
    messages: [],
  };
  saveBlackMarketSceneSessions([session, ...loadBlackMarketSceneSessions()]);
  const next = saveBlackMarketState({
    ...state,
    ownedTheaters: state.ownedTheaters.map(item => item.localId === owned.localId
      ? { ...item, status: "active", useCount: item.useCount + 1, lastActivatedAt: now }
      : item),
  });
  return { ok: true, state: next, session };
}

export function appendBlackMarketSceneMessage(sessionId: string, role: BlackMarketSceneMessage["role"], content: string): BlackMarketSceneSession | undefined {
  const text = cleanText(content, 30000);
  if (!text) return getBlackMarketSceneSession(sessionId);
  const sessions = loadBlackMarketSceneSessions();
  const now = new Date().toISOString();
  let updated: BlackMarketSceneSession | undefined;
  const next = sessions.map(session => {
    if (session.id !== sessionId) return session;
    updated = {
      ...session,
      updatedAt: now,
      messages: [
        ...session.messages,
        {
          id: createId("bm_msg"),
          role,
          content: text,
          createdAt: now,
        },
      ].slice(-80),
    };
    return updated;
  });
  saveBlackMarketSceneSessions(next);
  return updated;
}

export function updateBlackMarketSceneMessageAndTrimAfter(sessionId: string, messageId: string, content: string): BlackMarketSceneSession | undefined {
  const text = cleanText(content, 30000);
  if (!text) return getBlackMarketSceneSession(sessionId);
  const sessions = loadBlackMarketSceneSessions();
  const now = new Date().toISOString();
  let updated: BlackMarketSceneSession | undefined;
  const next = sessions.map(session => {
    if (session.id !== sessionId) return session;
    const targetIndex = session.messages.findIndex(message => message.id === messageId);
    if (targetIndex < 0) return session;
    updated = {
      ...session,
      updatedAt: now,
      messages: session.messages.slice(0, targetIndex + 1).map((message, index) => (
        index === targetIndex ? { ...message, content: text } : message
      )),
    };
    return updated;
  });
  saveBlackMarketSceneSessions(next);
  return updated;
}

export function trimBlackMarketSceneMessagesFrom(sessionId: string, messageId: string): BlackMarketSceneSession | undefined {
  const sessions = loadBlackMarketSceneSessions();
  const now = new Date().toISOString();
  let updated: BlackMarketSceneSession | undefined;
  const next = sessions.map(session => {
    if (session.id !== sessionId) return session;
    const targetIndex = session.messages.findIndex(message => message.id === messageId);
    if (targetIndex < 0) return session;
    updated = {
      ...session,
      updatedAt: now,
      messages: session.messages.slice(0, targetIndex),
    };
    return updated;
  });
  saveBlackMarketSceneSessions(next);
  return updated;
}

export function endBlackMarketSceneSession(sessionId: string, summary?: string): BlackMarketSceneSession | undefined {
  const sessions = loadBlackMarketSceneSessions();
  const now = new Date().toISOString();
  let updated: BlackMarketSceneSession | undefined;
  const next = sessions.map(session => {
    if (session.id !== sessionId) return session;
    updated = {
      ...session,
      status: "ended",
      endedAt: now,
      updatedAt: now,
      summary: cleanText(summary, 3000) || session.summary,
      summaryWrittenAt: summary ? now : session.summaryWrittenAt,
    };
    return updated;
  });
  saveBlackMarketSceneSessions(next);

  if (updated) {
    const state = loadBlackMarketState();
    saveBlackMarketState({
      ...state,
      ownedTheaters: state.ownedTheaters.map(item => item.localId === updated!.localTheaterId
        ? { ...item, status: "used", lastUsedAt: now }
        : item),
    });
  }

  return updated;
}

export function discardBlackMarketSceneSession(sessionId: string): { state: BlackMarketState; session?: BlackMarketSceneSession } {
  const sessions = loadBlackMarketSceneSessions();
  const session = sessions.find(item => item.id === sessionId);
  if (!session) return { state: loadBlackMarketState() };

  const remaining = sessions.filter(item => item.id !== sessionId);
  saveBlackMarketSceneSessions(remaining);

  const state = loadBlackMarketState();
  const hasActiveSession = remaining.some(item => item.localTheaterId === session.localTheaterId && item.status === "active");
  const next = saveBlackMarketState({
    ...state,
    ownedTheaters: state.ownedTheaters.map(item => {
      if (item.localId !== session.localTheaterId) return item;
      if (hasActiveSession) return { ...item, status: "active" };
      if (item.lastUsedAt) return { ...item, status: "used" };
      return { ...item, status: "unused" };
    }),
  });

  return { state: next, session };
}

function projectionStorageKey(characterId: string): string {
  return `${BLACK_MARKET_THEATER_EVENT_PREFIX}${characterId}`;
}

function normalizeProjectionEntry(value: unknown): BlackMarketTheaterProjectionEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const sessionId = cleanText(record.sessionId, 160);
  const characterId = cleanText(record.characterId, 160);
  const timestamp = cleanText(record.timestamp, 80);
  const content = cleanText(record.content, 3000);
  const theaterTitle = cleanText(record.theaterTitle, 80);
  if (!id || !sessionId || !characterId || !timestamp || !content) return null;
  return { id, sessionId, characterId, timestamp, content, theaterTitle };
}

function loadProjectionEventsByKey(key: string): BlackMarketTheaterProjectionEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeArray(parsed, normalizeProjectionEntry).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

function saveProjectionEventsByKey(key: string, entries: BlackMarketTheaterProjectionEntry[]): void {
  if (typeof window === "undefined") return;
  const compacted = [...entries]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-MAX_BLACK_MARKET_PROJECTION_EVENTS);
  kvSet(key, JSON.stringify(compacted));
  window.dispatchEvent(new CustomEvent(BLACK_MARKET_UPDATED_EVENT, { detail: loadBlackMarketState() }));
}

export function recordBlackMarketTheaterProjectionEvent(input: {
  sessionId: string;
  characterId: string;
  characterName: string;
  userName: string;
  theaterTitle: string;
  summary: string;
  timestamp?: string;
}): BlackMarketTheaterProjectionEntry | null {
  const summary = cleanText(input.summary, 2400);
  if (!summary) return null;
  const timestamp = input.timestamp || new Date().toISOString();
  const time = formatChatTimestamp(timestamp);
  const characterName = cleanText(input.characterName, 80) || "角色";
  const userName = cleanText(input.userName, 80) || "用户";
  const theaterTitle = cleanText(input.theaterTitle, 80) || "未命名小剧场";
  const entry: BlackMarketTheaterProjectionEntry = {
    id: `black_market_theater_${input.sessionId}`,
    sessionId: input.sessionId,
    characterId: input.characterId,
    timestamp,
    theaterTitle,
    content: `[小剧场 ${time}] ${characterName}和${userName}经历了一段《${theaterTitle}》相关事件：${summary}`,
  };
  const key = projectionStorageKey(input.characterId);
  const current = loadProjectionEventsByKey(key);
  saveProjectionEventsByKey(key, [entry, ...current.filter(item => item.id !== entry.id)]);
  return entry;
}

export function loadBlackMarketTheaterProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string },
): BlackMarketTheaterProjectionEntry[] {
  const entries = loadProjectionEventsByKey(projectionStorageKey(characterId));
  if (!options?.afterTimestamp) return entries;
  return entries.filter(entry => entry.timestamp > options.afterTimestamp!);
}

export function loadAllBlackMarketTheaterProjectionEntries(): BlackMarketTheaterProjectionEntry[] {
  if (typeof window === "undefined") return [];
  const byId = new Map<string, BlackMarketTheaterProjectionEntry>();
  for (const key of kvKeysWithPrefix(BLACK_MARKET_THEATER_EVENT_PREFIX)) {
    for (const entry of loadProjectionEventsByKey(key)) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function deleteBlackMarketTheaterProjectionEvent(eventId: string): { ok: boolean; error?: string } {
  const id = cleanText(eventId, 160);
  if (!id || typeof window === "undefined") return { ok: false, error: "小剧场记录 ID 无效。" };
  for (const key of kvKeysWithPrefix(BLACK_MARKET_THEATER_EVENT_PREFIX)) {
    const events = loadProjectionEventsByKey(key);
    const next = events.filter(entry => entry.id !== id);
    if (next.length !== events.length) {
      saveProjectionEventsByKey(key, next);
      return { ok: true };
    }
  }
  return { ok: false, error: "没有找到这条小剧场记录。" };
}

export function clearBlackMarketTheaterProjectionEventsForSession(sessionId: string): void {
  if (!sessionId || typeof window === "undefined") return;
  for (const key of kvKeysWithPrefix(BLACK_MARKET_THEATER_EVENT_PREFIX)) {
    const events = loadProjectionEventsByKey(key);
    const next = events.filter(entry => entry.sessionId !== sessionId && entry.id !== `black_market_theater_${sessionId}`);
    if (next.length !== events.length) saveProjectionEventsByKey(key, next);
  }
}

export function checkInBlackMarket(): BlackMarketCheckinResult {
  const state = loadBlackMarketState();
  const today = localDateKey();
  if (state.wallet.lastCheckinDate === today) {
    return { ok: false, state, error: "今天已经签到过了。" };
  }
  const nextBalance = state.wallet.balance + BLACK_MARKET_DAILY_CHECKIN_CREDITS;
  const transaction = createTransaction({
    type: "daily_checkin",
    amount: BLACK_MARKET_DAILY_CHECKIN_CREDITS,
    title: "每日签到",
    detail: "黑市终端发放今日暗影信用点。",
    balanceAfter: nextBalance,
  });
  const next = saveBlackMarketState({
    ...state,
    wallet: {
      ...state.wallet,
      balance: nextBalance,
      lastCheckinDate: today,
      transactions: [transaction, ...state.wallet.transactions],
    },
  });
  return { ok: true, state: next, transaction };
}

export function purchaseBlackMarketTheater(template: BlackMarketTheaterTemplate): BlackMarketPurchaseResult {
  const normalized = normalizeBlackMarketTheaterTemplate(template);
  const state = loadBlackMarketState();
  if (!normalized) return { ok: false, state, error: "夜间档案无效。" };

  const existing = state.ownedTheaters.find(item => item.remoteTemplateId === normalized.id);
  if (existing) {
    return { ok: false, state, ownedTheater: existing, error: "已经收入暗柜。" };
  }

  const price = normalizePrice(normalized.price);
  if (state.wallet.balance < price) {
    return { ok: false, state, error: "暗影信用点不足。" };
  }

  const nextBalance = state.wallet.balance - price;
  const ownedTheater: BlackMarketOwnedTheater = {
    localId: createId("owned_theater"),
    remoteTemplateId: normalized.id,
    purchasedAt: new Date().toISOString(),
    templateSnapshot: normalized,
    status: "unused",
    useCount: 0,
  };
  const transaction = createTransaction({
    type: "purchase",
    amount: -price,
    title: "购买夜间档案",
    detail: `复制夜间档案指令：${normalized.title}`,
    theaterId: normalized.id,
    theaterTitle: normalized.title,
    counterpartyId: normalized.authorId,
    counterpartyName: normalized.authorName,
    balanceAfter: nextBalance,
  });
  const next = saveBlackMarketState({
    ...state,
    wallet: {
      ...state.wallet,
      balance: nextBalance,
      transactions: [transaction, ...state.wallet.transactions],
    },
    ownedTheaters: [ownedTheater, ...state.ownedTheaters],
  });
  return { ok: true, state: next, ownedTheater, transaction };
}

export function copyBlackMarketTheaterToVault(template: BlackMarketTheaterTemplate): BlackMarketPurchaseResult {
  const normalized = normalizeBlackMarketTheaterTemplate(template);
  const state = loadBlackMarketState();
  if (!normalized) return { ok: false, state, error: "夜间档案无效。" };

  const existing = state.ownedTheaters.find(item => item.remoteTemplateId === normalized.id);
  if (existing) {
    return { ok: true, state, ownedTheater: existing };
  }

  const ownedTheater: BlackMarketOwnedTheater = {
    localId: createId("owned_theater"),
    remoteTemplateId: normalized.id,
    purchasedAt: new Date().toISOString(),
    templateSnapshot: normalized,
    status: "unused",
    useCount: 0,
  };
  const next = saveBlackMarketState({
    ...state,
    ownedTheaters: [ownedTheater, ...state.ownedTheaters],
  });
  return { ok: true, state: next, ownedTheater };
}

// ── 本机测试剧场 ─────────────────────────────────────
// 从草稿本地上架、不发布市场、不扣钱。与购买的剧场一样走完整 scene 运行时
// （写记忆、进回传记录），区别只是 localId 前缀，用于在工作室单独归类。
export const BLACK_MARKET_LOCAL_TEST_PREFIX = "localtest_theater_";

export function isLocalTestTheaterId(localId: string): boolean {
  return localId.startsWith(BLACK_MARKET_LOCAL_TEST_PREFIX);
}

/** 从草稿创建/更新一个本机测试剧场（按 draftId 幂等，重复测试更新 snapshot 而非重复上架）。 */
export function upsertLocalTestTheater(
  draftId: string,
  template: BlackMarketTheaterTemplate,
): BlackMarketPurchaseResult {
  const normalized = normalizeBlackMarketTheaterTemplate(template);
  const state = loadBlackMarketState();
  if (!normalized) return { ok: false, state, error: "夜间档案无效。" };
  const localId = `${BLACK_MARKET_LOCAL_TEST_PREFIX}${draftId}`;
  const existing = state.ownedTheaters.find(item => item.localId === localId);
  const ownedTheater: BlackMarketOwnedTheater = existing
    ? { ...existing, remoteTemplateId: normalized.id, templateSnapshot: normalized }
    : {
        localId,
        remoteTemplateId: normalized.id,
        purchasedAt: new Date().toISOString(),
        templateSnapshot: normalized,
        status: "unused",
        useCount: 0,
      };
  const next = saveBlackMarketState({
    ...state,
    ownedTheaters: [ownedTheater, ...state.ownedTheaters.filter(item => item.localId !== localId)],
  });
  return { ok: true, state: next, ownedTheater };
}

export function copyOwnBlackMarketTheater(template: BlackMarketTheaterTemplate): BlackMarketPurchaseResult {
  const normalized = normalizeBlackMarketTheaterTemplate(template);
  const state = loadBlackMarketState();
  if (!normalized) return { ok: false, state, error: "夜间档案无效。" };
  if (normalized.authorId !== state.wallet.userId && normalized.authorId !== "local_user") {
    return { ok: false, state, error: "只能直接启封自己发布的夜间档案。" };
  }

  return copyBlackMarketTheaterToVault(normalized);
}

export function syncOwnedBlackMarketTheaterSnapshot(template: BlackMarketTheaterTemplate): {
  ok: boolean;
  state: BlackMarketState;
  updatedCount: number;
  ownedTheaters: BlackMarketOwnedTheater[];
  error?: string;
} {
  const normalized = normalizeBlackMarketTheaterTemplate(template);
  const state = loadBlackMarketState();
  if (!normalized) {
    return { ok: false, state, updatedCount: 0, ownedTheaters: [], error: "夜间档案无效。" };
  }

  const updatedOwnedTheaters: BlackMarketOwnedTheater[] = [];
  const ownedTheaters = state.ownedTheaters.map(item => {
    if (item.remoteTemplateId !== normalized.id) return item;
    const updated: BlackMarketOwnedTheater = {
      ...item,
      templateSnapshot: normalized,
    };
    updatedOwnedTheaters.push(updated);
    return updated;
  });

  if (updatedOwnedTheaters.length === 0) {
    return { ok: true, state, updatedCount: 0, ownedTheaters: [] };
  }

  const next = saveBlackMarketState({
    ...state,
    ownedTheaters,
  });
  return {
    ok: true,
    state: next,
    updatedCount: updatedOwnedTheaters.length,
    ownedTheaters: updatedOwnedTheaters,
  };
}

export function adjustBlackMarketCredits(amount: number, detail = "手动调整暗影信用点。"): BlackMarketState {
  const state = loadBlackMarketState();
  const delta = Math.round(Number.isFinite(amount) ? amount : 0);
  const nextBalance = Math.max(0, state.wallet.balance + delta);
  const transaction = createTransaction({
    type: "manual_adjust",
    amount: nextBalance - state.wallet.balance,
    title: "额度调整",
    detail,
    balanceAfter: nextBalance,
  });
  return saveBlackMarketState({
    ...state,
    wallet: {
      ...state.wallet,
      balance: nextBalance,
      transactions: [transaction, ...state.wallet.transactions],
    },
  });
}

export function activateBlackMarketTheater(input: {
  localTheaterId: string;
  chatId: string;
  targetCharacterId?: string;
  targetCharacterName?: string;
  startedAtMessageId?: string;
}): { ok: boolean; state: BlackMarketState; activeTheater?: ActiveBlackMarketTheater; error?: string } {
  const state = loadBlackMarketState();
  const owned = state.ownedTheaters.find(item => item.localId === input.localTheaterId);
  if (!owned) return { ok: false, state, error: "暗柜中没有找到这份夜间档案。" };
  const template = owned.templateSnapshot;
  const activeTheater: ActiveBlackMarketTheater = {
    instanceId: createId("theater_run"),
    localTheaterId: owned.localId,
    templateId: template.id,
    title: template.title,
    targetCharacterId: input.targetCharacterId,
    targetCharacterName: input.targetCharacterName,
    chatId: input.chatId,
    startedAtMessageId: input.startedAtMessageId,
    startedAt: new Date().toISOString(),
    aiInstruction: template.aiInstruction,
    outputContract: template.outputContract,
    renderRules: template.renderRules,
    renderCss: template.renderCss,
    memorySummaryPrompt: template.memorySummaryPrompt,
    remainingTurns: template.durationTurns,
    status: "active",
  };
  const next = saveBlackMarketState({
    ...state,
    ownedTheaters: state.ownedTheaters.map(item => item.localId === owned.localId
      ? { ...item, status: "active", useCount: item.useCount + 1, lastActivatedAt: activeTheater.startedAt }
      : item),
    activeTheaters: [activeTheater, ...state.activeTheaters.filter(item => item.chatId !== input.chatId)],
  });
  return { ok: true, state: next, activeTheater };
}

export function endBlackMarketTheater(instanceId: string): BlackMarketState {
  const state = loadBlackMarketState();
  const ending = state.activeTheaters.find(item => item.instanceId === instanceId);
  const now = new Date().toISOString();
  return saveBlackMarketState({
    ...state,
    activeTheaters: state.activeTheaters.filter(item => item.instanceId !== instanceId),
    ownedTheaters: ending
      ? state.ownedTheaters.map(item => item.localId === ending.localTheaterId
        ? { ...item, status: "used", lastUsedAt: now }
        : item)
      : state.ownedTheaters,
  });
}
