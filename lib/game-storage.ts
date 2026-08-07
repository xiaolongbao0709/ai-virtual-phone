import { GAME_BUILTIN_TEMPLATES } from "./game-builtins";
import { GAME_SINGLE_FILE_EXAMPLE_HTML } from "./game-creator-guide";
import type {
  GameCollectionFolder,
  GameHallDraft,
  GameInstallResult,
  GameInstalledItem,
  GameProjectionEntry,
  GameRoleAssignment,
  GameRoleSlot,
  GameSaveRecord,
  GameState,
  GameTemplate,
  GameTemplateDraft,
  GameTemplateSource,
} from "./game-types";
import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";

const GAME_STATE_KEY = "ai_phone_game_state_v1";
const GAME_DRAFTS_KEY = "ai_phone_game_hall_drafts_v1";
const MAX_GAME_PROJECTION_EVENTS = 500;
export const GAME_UPDATED_EVENT = "ai-phone-game-updated";

registerKvMigration(GAME_STATE_KEY);
registerKvMigration(GAME_DRAFTS_KEY);

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanHtml(value: unknown): string {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return fallback;
  return Math.min(max, Math.max(min, Math.round(amount)));
}

function normalizeSource(value: unknown): GameTemplateSource {
  return value === "community" || value === "local" || value === "builtin" ? value : "community";
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, 24)).filter(Boolean).slice(0, 8);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return normalizeTags(parsed);
    } catch {
      return value.split(/[,\s，、]+/).map(item => cleanText(item, 24)).filter(Boolean).slice(0, 8);
    }
  }
  return [];
}

export function normalizeGameRoleSlot(value: unknown): GameRoleSlot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 64).replace(/[^\w-]/g, "_");
  const label = cleanText(record.label, 40);
  if (!id || !label) return null;
  const min = clampNumber(record.min, 0, 12, record.required === false ? 0 : 1);
  const max = Math.max(min, clampNumber(record.max, 1, 12, Math.max(1, min)));
  return {
    id,
    label,
    description: cleanText(record.description, 240),
    required: record.required !== false,
    min,
    max,
  };
}

export function normalizeGameTemplate(value: unknown): GameTemplate | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const title = cleanText(record.title, 80);
  const pickerHtml = cleanHtml(record.pickerHtml ?? record.picker_html);
  const gameHtml = cleanHtml(record.gameHtml ?? record.game_html);
  if (!id || !title || !pickerHtml || !gameHtml) return null;
  const rawRoleSlots = record.roleSlots ?? record.role_slots;
  const roleSlots = Array.isArray(rawRoleSlots)
    ? rawRoleSlots.map(normalizeGameRoleSlot).filter(Boolean) as GameRoleSlot[]
    : [];
  return {
    id,
    title,
    codeName: cleanText(record.codeName ?? record.code_name, 80) || id.toUpperCase(),
    subtitle: cleanText(record.subtitle, 160),
    synopsis: cleanText(record.synopsis, 600),
    playNote: cleanText(record.playNote ?? record.play_note, 3000),
    coverImage: cleanText(record.coverImage ?? record.cover_image, 300000),
    tags: normalizeTags(record.tags),
    authorId: cleanText(record.authorId ?? record.author_id, 160) || "anonymous",
    authorName: cleanText(record.authorName ?? record.author_name, 80) || "匿名",
    authorAvatar: cleanText(record.authorAvatar ?? record.author_avatar, 120000),
    source: normalizeSource(record.source),
    version: clampNumber(record.version, 1, 9999, 1),
    roleSlots: roleSlots.slice(0, 12),
    pickerHtml,
    gameHtml,
    allowExternalControl: record.allowExternalControl === true || record.allow_external_control === true,
    purchaseCount: clampNumber(record.purchaseCount ?? record.purchase_count, 0, Number.MAX_SAFE_INTEGER, 0),
    rating: Math.min(5, Math.max(0, Number(record.rating) || 0)),
    likeCount: clampNumber(record.likeCount ?? record.like_count, 0, Number.MAX_SAFE_INTEGER, 0),
    favoriteCount: clampNumber(record.favoriteCount ?? record.favorite_count, 0, Number.MAX_SAFE_INTEGER, 0),
    commentCount: clampNumber(record.commentCount ?? record.comment_count, 0, Number.MAX_SAFE_INTEGER, 0),
    likedByMe: record.likedByMe === true || record.liked_by_me === true,
    createdAt: cleanText(record.createdAt ?? record.created_at, 80) || new Date().toISOString(),
    updatedAt: cleanText(record.updatedAt ?? record.updated_at, 80) || new Date().toISOString(),
  };
}

function normalizeAssignment(value: unknown): GameRoleAssignment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const slotId = cleanText(record.slotId, 64);
  const characterIds = Array.isArray(record.characterIds)
    ? record.characterIds.map(id => cleanText(id, 160)).filter(Boolean).slice(0, 12)
    : [];
  if (!slotId) return null;
  return { slotId, characterIds };
}

function normalizeInstalledGame(value: unknown): GameInstalledItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const templateSnapshot = normalizeGameTemplate(record.templateSnapshot);
  const localId = cleanText(record.localId, 160);
  const remoteTemplateId = cleanText(record.remoteTemplateId, 160) || templateSnapshot?.id || "";
  if (!localId || !remoteTemplateId || !templateSnapshot) return null;
  return {
    localId,
    remoteTemplateId,
    installedAt: cleanText(record.installedAt, 80) || new Date().toISOString(),
    templateSnapshot,
    roleAssignments: Array.isArray(record.roleAssignments)
      ? record.roleAssignments.map(normalizeAssignment).filter(Boolean) as GameRoleAssignment[]
      : [],
    status: record.status === "archived" ? "archived" : "installed",
    playCount: clampNumber(record.playCount, 0, Number.MAX_SAFE_INTEGER, 0),
    lastPlayedAt: cleanText(record.lastPlayedAt, 80) || undefined,
  };
}

function normalizeCollectionFolder(value: unknown): GameCollectionFolder | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const name = cleanText(record.name, 40);
  if (!id || !name) return null;
  return {
    id,
    name,
    description: cleanText(record.description, 120),
    colorA: cleanText(record.colorA, 24) || "#a78bfa",
    colorB: cleanText(record.colorB, 24) || "#fb7185",
    gameIds: Array.isArray(record.gameIds)
      ? [...new Set(record.gameIds.map(item => cleanText(item, 160)).filter(Boolean))].slice(0, 200)
      : [],
    createdAt: cleanText(record.createdAt, 80) || new Date().toISOString(),
    updatedAt: cleanText(record.updatedAt, 80) || new Date().toISOString(),
  };
}

function normalizeSave(value: unknown): GameSaveRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const localGameId = cleanText(record.localGameId, 160);
  if (!id || !localGameId) return null;
  return {
    id,
    localGameId,
    updatedAt: cleanText(record.updatedAt, 80) || new Date().toISOString(),
    data: record.data ?? null,
  };
}

function normalizeDraft(value: unknown): GameTemplateDraft | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const playNote = cleanText(record.playNote, 3000) || cleanText(record.synopsis, 3000);
  return {
    title: cleanText(record.title, 80) || "自定义游戏",
    codeName: "✦",
    subtitle: "",
    synopsis: "",
    playNote,
    coverImage: cleanText(record.coverImage, 300000),
    tagsText: cleanText(record.tagsText, 300) || "互动",
    authorName: cleanText(record.authorName, 80),
    roleSlotsText: cleanText(record.roleSlotsText, 12000) || "[]",
    pickerHtml: cleanHtml(record.pickerHtml),
    gameHtml: cleanHtml(record.gameHtml),
    allowExternalControl: record.allowExternalControl !== false,
  };
}

function normalizeGameProjectionEntry(value: unknown): GameProjectionEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const localGameId = cleanText(record.localGameId, 160);
  const remoteTemplateId = cleanText(record.remoteTemplateId, 160);
  const templateTitle = cleanText(record.templateTitle, 80);
  const characterId = cleanText(record.characterId, 160);
  const characterName = cleanText(record.characterName, 80);
  const playerName = cleanText(record.playerName, 80);
  const summary = cleanText(record.summary, Infinity);
  if (!id || !localGameId || !remoteTemplateId || !templateTitle || !characterId || !characterName || !summary) {
    return null;
  }
  return {
    id,
    localGameId,
    remoteTemplateId,
    templateTitle,
    characterId,
    characterName,
    playerName: playerName || "玩家",
    summary,
    timestamp: cleanText(record.timestamp, 80) || new Date().toISOString(),
  };
}

function createDefaultGameState(): GameState {
  return {
    userId: `game_user_${Math.random().toString(36).slice(2, 10)}`,
    displayName: "本机玩家",
    avatarUrl: "",
    likedGameIds: [],
    installedGames: [],
    collectionFolders: [],
    hiddenDefaultCollectionIds: [],
    saves: [],
    gameEvents: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadGameState(): GameState {
  const raw = typeof window !== "undefined" ? kvGet(GAME_STATE_KEY) : null;
  if (!raw) return createDefaultGameState();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      userId: cleanText(parsed.userId, 160) || createDefaultGameState().userId,
      displayName: cleanText(parsed.displayName, 80) || "本机玩家",
      avatarUrl: cleanText(parsed.avatarUrl, 120000),
      likedGameIds: Array.isArray(parsed.likedGameIds)
        ? parsed.likedGameIds.map(id => cleanText(id, 160)).filter(Boolean).slice(0, 2000)
        : [],
      installedGames: Array.isArray(parsed.installedGames)
        ? parsed.installedGames.map(normalizeInstalledGame).filter(Boolean).slice(0, 200) as GameInstalledItem[]
        : [],
      collectionFolders: Array.isArray(parsed.collectionFolders)
        ? parsed.collectionFolders.map(normalizeCollectionFolder).filter(Boolean).slice(0, 80) as GameCollectionFolder[]
        : [],
      hiddenDefaultCollectionIds: Array.isArray(parsed.hiddenDefaultCollectionIds)
        ? [...new Set(parsed.hiddenDefaultCollectionIds.map(id => cleanText(id, 160)).filter(Boolean))].slice(0, 20)
        : [],
      saves: Array.isArray(parsed.saves)
        ? parsed.saves.map(normalizeSave).filter(Boolean).slice(0, 500) as GameSaveRecord[]
        : [],
      gameEvents: Array.isArray(parsed.gameEvents)
        ? parsed.gameEvents.map(normalizeGameProjectionEntry).filter(Boolean).slice(-MAX_GAME_PROJECTION_EVENTS) as GameProjectionEntry[]
        : [],
      updatedAt: cleanText(parsed.updatedAt, 80) || new Date().toISOString(),
    };
  } catch {
    return createDefaultGameState();
  }
}

export function saveGameState(state: GameState): GameState {
  const next: GameState = {
    ...state,
    displayName: cleanText(state.displayName, 80) || "本机玩家",
    avatarUrl: cleanText(state.avatarUrl, 120000),
    likedGameIds: [...new Set((state.likedGameIds ?? []).map(id => cleanText(id, 160)).filter(Boolean))].slice(0, 2000),
    installedGames: state.installedGames.slice(0, 200),
    collectionFolders: (state.collectionFolders ?? [])
      .map(normalizeCollectionFolder)
      .filter(Boolean)
      .slice(0, 80) as GameCollectionFolder[],
    hiddenDefaultCollectionIds: [...new Set((state.hiddenDefaultCollectionIds ?? []).map(id => cleanText(id, 160)).filter(Boolean))].slice(0, 20),
    saves: state.saves.slice(0, 500),
    gameEvents: [...(state.gameEvents ?? [])]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-MAX_GAME_PROJECTION_EVENTS),
    updatedAt: new Date().toISOString(),
  };
  kvSet(GAME_STATE_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(GAME_UPDATED_EVENT));
  return next;
}

export function getGameCatalog(): GameTemplate[] {
  return GAME_BUILTIN_TEMPLATES;
}

export function installGameTemplate(template: GameTemplate): GameInstallResult {
  const normalized = normalizeGameTemplate(template);
  const state = loadGameState();
  if (!normalized) return { ok: false, state, error: "游戏包无效。" };
  const existing = state.installedGames.find(item => item.remoteTemplateId === normalized.id);
  if (existing) return { ok: false, state, installedGame: existing, error: "已经安装过这个游戏。" };
  const installedGame: GameInstalledItem = {
    localId: createId("installed_game"),
    remoteTemplateId: normalized.id,
    installedAt: new Date().toISOString(),
    templateSnapshot: normalized,
    roleAssignments: [],
    status: "installed",
    playCount: 0,
  };
  const next = saveGameState({
    ...state,
    installedGames: [installedGame, ...state.installedGames],
  });
  return { ok: true, state: next, installedGame };
}

export function saveGameHallProfile(input: { displayName: string; avatarUrl: string }): GameState {
  const state = loadGameState();
  return saveGameState({
    ...state,
    displayName: cleanText(input.displayName, 80) || "本机玩家",
    avatarUrl: cleanText(input.avatarUrl, 120000),
  });
}

export function saveLikedGameIds(likedGameIds: string[]): GameState {
  const state = loadGameState();
  return saveGameState({
    ...state,
    likedGameIds,
  });
}

export function saveGameCollectionFolders(collectionFolders: GameCollectionFolder[]): GameState {
  const state = loadGameState();
  return saveGameState({
    ...state,
    collectionFolders,
  });
}

// ── 本机测试游戏 ─────────────────────────────────────
// 从草稿本地安装、但不发布到市场。与市场安装的游戏一样走完整运行时
// （写记忆、进回传记录），区别只是 localId 前缀，用于在创作工坊单独归类。
export const GAME_LOCAL_TEST_PREFIX = "localtest_game_";

export function isLocalTestGameId(localId: string): boolean {
  return localId.startsWith(GAME_LOCAL_TEST_PREFIX);
}

/** 从草稿创建/更新一个本机测试游戏（按 draftId 幂等，重复测试更新而非重复安装）。 */
export function upsertLocalTestGame(
  draftId: string,
  template: GameTemplate,
): { ok: boolean; state: GameState; installedGame?: GameInstalledItem; error?: string } {
  const normalized = normalizeGameTemplate(template);
  const state = loadGameState();
  if (!normalized) return { ok: false, state, error: "游戏包无效。" };
  const localId = `${GAME_LOCAL_TEST_PREFIX}${draftId}`;
  const existing = state.installedGames.find(item => item.localId === localId);
  const installedGame: GameInstalledItem = existing
    ? { ...existing, remoteTemplateId: normalized.id, templateSnapshot: normalized }
    : {
        localId,
        remoteTemplateId: normalized.id,
        installedAt: new Date().toISOString(),
        templateSnapshot: normalized,
        roleAssignments: [],
        status: "installed",
        playCount: 0,
      };
  const next = saveGameState({
    ...state,
    installedGames: [installedGame, ...state.installedGames.filter(item => item.localId !== localId)],
  });
  return { ok: true, state: next, installedGame };
}

export function deleteInstalledGame(localId: string): { ok: boolean; state: GameState; error?: string } {
  const state = loadGameState();
  const existing = state.installedGames.find(item => item.localId === localId);
  if (!existing) return { ok: false, state, error: "没有找到本地游戏。" };
  return {
    ok: true,
    state: saveGameState({
      ...state,
      installedGames: state.installedGames.filter(item => item.localId !== localId),
      collectionFolders: state.collectionFolders.map(folder => ({
        ...folder,
        gameIds: folder.gameIds.filter(id => id !== existing.remoteTemplateId),
        updatedAt: folder.gameIds.includes(existing.remoteTemplateId) ? new Date().toISOString() : folder.updatedAt,
      })),
      saves: state.saves.filter(item => item.localGameId !== localId),
      gameEvents: state.gameEvents.filter(item => item.localGameId !== localId),
    }),
  };
}

export function saveGameRoleAssignments(localId: string, roleAssignments: GameRoleAssignment[]): GameState {
  const state = loadGameState();
  return saveGameState({
    ...state,
    installedGames: state.installedGames.map(item => item.localId === localId
      ? { ...item, roleAssignments }
      : item),
  });
}

export function markGamePlayed(localId: string): GameState {
  const state = loadGameState();
  const now = new Date().toISOString();
  return saveGameState({
    ...state,
    installedGames: state.installedGames.map(item => item.localId === localId
      ? { ...item, playCount: item.playCount + 1, lastPlayedAt: now }
      : item),
  });
}

export function loadGameSave(localId: string): unknown {
  return loadGameState().saves.find(item => item.localGameId === localId)?.data ?? null;
}

export function saveGameSave(localId: string, data: unknown): GameState {
  const state = loadGameState();
  const now = new Date().toISOString();
  const existing = state.saves.find(item => item.localGameId === localId);
  const save: GameSaveRecord = {
    id: existing?.id || createId("game_save"),
    localGameId: localId,
    updatedAt: now,
    data,
  };
  return saveGameState({
    ...state,
    saves: [save, ...state.saves.filter(item => item.localGameId !== localId)],
  });
}

export function recordGameProjectionEvent(input: {
  localGameId: string;
  remoteTemplateId: string;
  templateTitle: string;
  characterId: string;
  characterName: string;
  playerName: string;
  summary: string;
  timestamp?: string;
  eventId?: string;
}): { entry: GameProjectionEntry | null; state: GameState } {
  const state = loadGameState();
  const summary = cleanText(input.summary, Infinity);
  if (!summary) return { entry: null, state };
  const timestamp = input.timestamp || new Date().toISOString();
  const localGameId = cleanText(input.localGameId, 160);
  const remoteTemplateId = cleanText(input.remoteTemplateId, 160);
  const characterId = cleanText(input.characterId, 160);
  if (!localGameId || !remoteTemplateId || !characterId) return { entry: null, state };
  const entry: GameProjectionEntry = {
    id: cleanText(input.eventId, 160) || createId("game_event"),
    localGameId,
    remoteTemplateId,
    templateTitle: cleanText(input.templateTitle, 80) || "未命名游戏",
    characterId,
    characterName: cleanText(input.characterName, 80) || "角色",
    playerName: cleanText(input.playerName, 80) || "玩家",
    summary,
    timestamp,
  };
  const next = saveGameState({
    ...state,
    gameEvents: [entry, ...(state.gameEvents ?? []).filter(item => item.id !== entry.id)],
  });
  return { entry, state: next };
}

export function deleteGameProjectionEvent(eventId: string): { ok: boolean; state: GameState; error?: string } {
  const state = loadGameState();
  const id = cleanText(eventId, 160);
  if (!id) return { ok: false, state, error: "游戏记录 ID 无效。" };
  const existing = state.gameEvents.find(item => item.id === id);
  if (!existing) return { ok: false, state, error: "没有找到这条游戏记录。" };
  return {
    ok: true,
    state: saveGameState({
      ...state,
      gameEvents: state.gameEvents.filter(item => item.id !== id),
    }),
  };
}

export function loadGameProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string },
): GameProjectionEntry[] {
  const id = cleanText(characterId, 160);
  if (!id) return [];
  const entries = loadGameState().gameEvents
    .filter(entry => entry.characterId === id)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!options?.afterTimestamp) return entries;
  return entries.filter(entry => entry.timestamp > options.afterTimestamp!);
}

export function parseGameRoleSlots(text: string): GameRoleSlot[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeGameRoleSlot).filter(Boolean) as GameRoleSlot[];
  } catch {
    return [];
  }
}

export function createDefaultGameDraft(): GameTemplateDraft {
  return {
    title: "自定义游戏",
    codeName: "✦",
    subtitle: "",
    synopsis: "",
    playNote: "写给玩家看的玩法说明、推荐体验方式和注意事项。",
    coverImage: "",
    tagsText: "互动",
    authorName: "匿名",
    roleSlotsText: "[]",
    pickerHtml: GAME_BUILTIN_TEMPLATES[0]?.pickerHtml || "",
    gameHtml: GAME_SINGLE_FILE_EXAMPLE_HTML,
    allowExternalControl: true,
  };
}

export function loadGameDrafts(): GameHallDraft[] {
  const raw = typeof window !== "undefined" ? kvGet(GAME_DRAFTS_KEY) : null;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const draft = normalizeDraft(record.draft);
      const id = cleanText(record.id, 160);
      if (!id || !draft) return null;
      return {
        id,
        title: cleanText(record.title, 80) || draft.title || "未命名游戏",
        draft,
        publishedTemplateId: cleanText(record.publishedTemplateId, 160) || undefined,
        hasUnpublishedChanges: record.hasUnpublishedChanges === true ? true : undefined,
        createdAt: cleanText(record.createdAt, 80) || new Date().toISOString(),
        updatedAt: cleanText(record.updatedAt, 80) || new Date().toISOString(),
      } satisfies GameHallDraft;
    }).filter(Boolean) as GameHallDraft[];
  } catch {
    return [];
  }
}

export function saveGameDrafts(drafts: GameHallDraft[]): GameHallDraft[] {
  const next = drafts.slice(0, 80);
  kvSet(GAME_DRAFTS_KEY, JSON.stringify(next));
  return next;
}

export function deleteAllGameData(): void {
  kvRemove(GAME_STATE_KEY);
  kvRemove(GAME_DRAFTS_KEY);
}
