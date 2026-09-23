import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";
import {
  DEFAULT_DIARY_ENTRY_TIMER_SETTINGS,
  DEFAULT_DIARY_REPLY_RULES,
  type DiaryEntry,
  type DiaryEntryAuthorType,
  type DiaryEntryBlock,
  type DiaryEntryInput,
  type DiaryEntryPatch,
  type DiaryEntryTimerSettings,
  type DiaryEntryTodoItem,
  type DiaryEntryTrigger,
  type DiaryReplyMode,
  type DiaryReplyRules,
} from "./diary-entry-types";

const ENTRIES_KEY = "ai_phone_diary_entries_v1";
const TIMER_KEY = "ai_phone_diary_entry_timer_settings_v1";
const REPLY_RULES_KEY = "ai_phone_diary_reply_rules_v1";
// "character" 字体沿用日记还没分裂成两本之前就有的老 key，老用户设置过的字体不会丢；
// "user" 字体是新加的独立一份，跟角色那份互不影响。
export const DIARY_ENTRY_FONT_ASSET_KEY = "ai_phone_diary_entry_font_asset_v1";
export const DIARY_ENTRY_FONT_SCALE_KEY = "ai_phone_diary_entry_font_scale_v1";
export const DIARY_ENTRY_USER_FONT_ASSET_KEY = "ai_phone_diary_entry_user_font_asset_v1";
export const DIARY_ENTRY_USER_FONT_SCALE_KEY = "ai_phone_diary_entry_user_font_scale_v1";

registerKvMigration(ENTRIES_KEY);
registerKvMigration(TIMER_KEY);
registerKvMigration(REPLY_RULES_KEY);
registerKvMigration(DIARY_ENTRY_FONT_ASSET_KEY);
registerKvMigration(DIARY_ENTRY_FONT_SCALE_KEY);
registerKvMigration(DIARY_ENTRY_USER_FONT_ASSET_KEY);
registerKvMigration(DIARY_ENTRY_USER_FONT_SCALE_KEY);

function fontAssetKey(kind: DiaryEntryAuthorType): string {
  return kind === "user" ? DIARY_ENTRY_USER_FONT_ASSET_KEY : DIARY_ENTRY_FONT_ASSET_KEY;
}

function fontScaleKey(kind: DiaryEntryAuthorType): string {
  return kind === "user" ? DIARY_ENTRY_USER_FONT_SCALE_KEY : DIARY_ENTRY_FONT_SCALE_KEY;
}

const DIARY_REPLY_MODES: DiaryReplyMode[] = ["none", "immediate", "delay", "merge"];

function normalizeAuthorType(value: unknown): DiaryEntryAuthorType {
  return value === "user" ? "user" : "character";
}

function normalizeReplyMode(value: unknown, fallback: DiaryReplyMode = "none"): DiaryReplyMode {
  return DIARY_REPLY_MODES.includes(value as DiaryReplyMode) ? (value as DiaryReplyMode) : fallback;
}

function generateId(prefix: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanMultilineText(value: unknown, maxLength: number): string {
  return cleanText(value, maxLength)
    .replace(/\r\n?/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、\s]+/)
      : [];
  return Array.from(new Set(raw.map(item => cleanText(item, 16)).filter(Boolean))).slice(0, 5);
}

function normalizeTodoItems(value: unknown): DiaryEntryTodoItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): DiaryEntryTodoItem | null => {
      if (typeof item === "string") {
        const text = cleanText(item, 120);
        return text ? { text, done: false } : null;
      }
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const text = cleanText(record.text ?? record.content ?? record.title, 120);
      if (!text) return null;
      return { text, done: Boolean(record.done ?? record.completed ?? record.checked) };
    })
    .filter((item): item is DiaryEntryTodoItem => Boolean(item))
    .slice(0, 10);
}

function normalizeBlocks(value: unknown, fallbackBody = ""): DiaryEntryBlock[] {
  const raw = Array.isArray(value) ? value : [];
  const blocks = raw
    .map((block): DiaryEntryBlock | null => {
      if (typeof block === "string") {
        const text = cleanMultilineText(block, 900);
        return text ? { type: "paragraph", text } : null;
      }
      if (!block || typeof block !== "object") return null;
      const record = block as Record<string, unknown>;
      const type = cleanText(record.type, 32);
      if (type === "todo" || type === "todos" || type === "list") {
        const items = normalizeTodoItems(record.items ?? record.todos ?? record.list);
        if (items.length === 0) return null;
        return {
          type: "todo",
          title: cleanText(record.title ?? record.heading, 40),
          items,
        };
      }
      if (type === "correction" || type === "strike" || type === "redaction") {
        const text = cleanText(record.text ?? record.from ?? record.old, 220);
        const replacement = cleanText(record.replacement ?? record.to ?? record.new, 220);
        if (!text && !replacement) return null;
        return {
          type: "correction",
          text: text || replacement,
          replacement: replacement || undefined,
        };
      }
      if (type === "image" || type === "picture" || type === "photo") {
        const description = cleanMultilineText(record.description ?? record.prompt ?? record.text ?? record.alt, 420);
        if (!description) return null;
        return {
          type: "image",
          caption: cleanText(record.caption ?? record.title, 80),
          description,
        };
      }
      if (type === "quote") {
        const text = cleanMultilineText(record.text ?? record.content ?? record.body, 500);
        return text ? { type: "quote", text } : null;
      }
      const text = cleanMultilineText(record.text ?? record.content ?? record.body, 900);
      return text ? { type: "paragraph", text } : null;
    })
    .filter((block): block is DiaryEntryBlock => Boolean(block))
    .slice(0, 18);

  if (blocks.length > 0) return blocks;

  const paragraphs = cleanMultilineText(fallbackBody, 3000)
    .split(/\n{2,}|\n/)
    .map(text => text.trim())
    .filter(Boolean)
    .slice(0, 10);
  return paragraphs.map(text => ({ type: "paragraph", text }));
}

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeTrigger(value: unknown): DiaryEntryTrigger {
  return value === "timer" ? "timer" : "manual";
}

export function loadDiaryEntryFontAssetId(kind: DiaryEntryAuthorType = "character"): string | null {
  const raw = kvGet(fontAssetKey(kind));
  const id = typeof raw === "string" ? raw.trim() : "";
  return id || null;
}

export function saveDiaryEntryFontAssetId(assetId: string | null, kind: DiaryEntryAuthorType = "character"): void {
  const id = typeof assetId === "string" ? assetId.trim() : "";
  const key = fontAssetKey(kind);
  if (id) {
    kvSet(key, id);
  } else {
    kvRemove(key);
  }
}

export function loadDiaryEntryFontScale(kind: DiaryEntryAuthorType = "character"): number {
  const raw = Number(kvGet(fontScaleKey(kind)));
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1.25, Math.max(0.85, Number(raw.toFixed(2))));
}

export function saveDiaryEntryFontScale(scale: number, kind: DiaryEntryAuthorType = "character"): void {
  const normalized = Math.min(1.25, Math.max(0.85, Number(scale.toFixed(2))));
  const key = fontScaleKey(kind);
  if (Math.abs(normalized - 1) < 0.001) {
    kvRemove(key);
    return;
  }
  kvSet(key, String(normalized));
}

export function normalizeDiaryEntry(raw: unknown): DiaryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const characterId = cleanText(record.characterId ?? record.character_id, 120);
  if (!id || !characterId) return null;

  const createdAt = typeof record.createdAt === "string"
    ? record.createdAt
    : typeof record.created_at === "string"
      ? record.created_at
      : new Date().toISOString();
  const body = cleanMultilineText(record.body ?? record.content ?? record.text, 6000);
  const blocks = normalizeBlocks(record.blocks, body);
  const title = cleanText(record.title, 80) || body.slice(0, 20) || "未命名日记";

  return {
    id,
    characterId,
    characterName: cleanText(record.characterName ?? record.character_name, 80) || "角色",
    // 老数据没有这个字段：一律当成角色自己写的日记，跟以前行为一致。
    authorType: normalizeAuthorType(record.authorType ?? record.author_type),
    title,
    dateLabel: cleanText(record.dateLabel ?? record.date_label, 40) || formatDateLabel(createdAt),
    mood: cleanText(record.mood, 60),
    weather: cleanText(record.weather, 60),
    tags: normalizeTags(record.tags ?? record.labels),
    signature: cleanText(record.signature, 80),
    body: body || blocks.map(block => block.type === "paragraph" || block.type === "quote" ? block.text : "").filter(Boolean).join("\n\n"),
    blocks,
    trigger: normalizeTrigger(record.trigger),
    createdAt,
    updatedAt: typeof record.updatedAt === "string"
      ? record.updatedAt
      : typeof record.updated_at === "string"
        ? record.updated_at
        : createdAt,
  };
}

export function loadDiaryEntries(): DiaryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(ENTRIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeDiaryEntry)
      .filter((entry): entry is DiaryEntry => Boolean(entry))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function saveDiaryEntries(entries: DiaryEntry[]): void {
  if (typeof window === "undefined") return;
  const normalized = entries
    .map(normalizeDiaryEntry)
    .filter((entry): entry is DiaryEntry => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 500);
  kvSet(ENTRIES_KEY, JSON.stringify(normalized));
}

export function createDiaryEntry(input: DiaryEntryInput): DiaryEntry {
  const now = new Date().toISOString();
  const body = cleanMultilineText(input.body, 6000);
  const entry: DiaryEntry = {
    id: generateId("diary_entry"),
    characterId: cleanText(input.characterId, 120),
    characterName: cleanText(input.characterName, 80) || "角色",
    authorType: normalizeAuthorType(input.authorType),
    title: cleanText(input.title, 80) || body.slice(0, 20) || "未命名日记",
    dateLabel: cleanText(input.dateLabel, 40) || formatDateLabel(now),
    mood: cleanText(input.mood, 60),
    weather: cleanText(input.weather, 60),
    tags: normalizeTags(input.tags),
    signature: cleanText(input.signature, 80),
    body,
    blocks: normalizeBlocks(input.blocks, body),
    trigger: input.trigger ?? "manual",
    createdAt: now,
    updatedAt: now,
  };
  saveDiaryEntries([entry, ...loadDiaryEntries()]);
  return entry;
}

/** 编辑一篇已存在的日记（角色日记订正、用户日记改稿都走这个）；找不到时返回 null。*/
export function updateDiaryEntry(id: string, patch: DiaryEntryPatch): DiaryEntry | null {
  if (!id) return null;
  const entries = loadDiaryEntries();
  const index = entries.findIndex(entry => entry.id === id);
  if (index < 0) return null;
  const current = entries[index];
  const now = new Date().toISOString();
  const body = patch.body !== undefined ? cleanMultilineText(patch.body, 6000) : current.body;
  const blocks = patch.blocks !== undefined ? normalizeBlocks(patch.blocks, body) : current.blocks;
  const updated: DiaryEntry = {
    ...current,
    title: patch.title !== undefined ? (cleanText(patch.title, 80) || body.slice(0, 20) || "未命名日记") : current.title,
    dateLabel: patch.dateLabel !== undefined ? cleanText(patch.dateLabel, 40) || current.dateLabel : current.dateLabel,
    mood: patch.mood !== undefined ? cleanText(patch.mood, 60) : current.mood,
    weather: patch.weather !== undefined ? cleanText(patch.weather, 60) : current.weather,
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags,
    signature: patch.signature !== undefined ? cleanText(patch.signature, 80) : current.signature,
    body,
    blocks,
    trigger: patch.trigger ?? current.trigger,
    updatedAt: now,
  };
  entries[index] = updated;
  saveDiaryEntries(entries);
  return updated;
}

export function deleteDiaryEntry(id: string): void {
  if (!id) return;
  saveDiaryEntries(loadDiaryEntries().filter(entry => entry.id !== id));
}

export function loadDiaryReplyRules(): DiaryReplyRules {
  if (typeof window === "undefined") return DEFAULT_DIARY_REPLY_RULES;
  try {
    const raw = kvGet(REPLY_RULES_KEY);
    if (!raw) return DEFAULT_DIARY_REPLY_RULES;
    const parsed = JSON.parse(raw) as Partial<DiaryReplyRules>;
    const defaultRule = parsed.default && typeof parsed.default === "object" ? parsed.default : DEFAULT_DIARY_REPLY_RULES.default;
    const characters: DiaryReplyRules["characters"] = {};
    if (parsed.characters && typeof parsed.characters === "object") {
      for (const [characterId, rule] of Object.entries(parsed.characters)) {
        if (!rule || typeof rule !== "object") continue;
        const mode = normalizeReplyMode((rule as Record<string, unknown>).mode, "none");
        const isInherit = (rule as Record<string, unknown>).mode === "inherit";
        characters[characterId] = {
          mode: isInherit ? "inherit" : mode,
          delayHours: Math.max(0.05, Math.min(720, Number((rule as Record<string, unknown>).delayHours) || 24)),
        };
      }
    }
    return {
      default: {
        mode: normalizeReplyMode(defaultRule.mode, "none"),
        delayHours: Math.max(0.05, Math.min(720, Number(defaultRule.delayHours) || 24)),
      },
      characters,
    };
  } catch {
    return DEFAULT_DIARY_REPLY_RULES;
  }
}

export function saveDiaryReplyRules(rules: DiaryReplyRules): void {
  if (typeof window === "undefined") return;
  kvSet(REPLY_RULES_KEY, JSON.stringify(rules));
}

/** 按"跟随默认 → 角色自己设置"解析出某个角色实际生效的回应规则。*/
export function resolveDiaryReplyRule(rules: DiaryReplyRules, characterId: string): { mode: DiaryReplyMode; delayHours: number } {
  const own = rules.characters[characterId];
  if (!own || own.mode === "inherit") return rules.default;
  return {
    mode: normalizeReplyMode(own.mode, rules.default.mode),
    delayHours: Math.max(0.05, Math.min(720, Number(own.delayHours) || rules.default.delayHours)),
  };
}

export function loadDiaryEntryTimerSettings(): DiaryEntryTimerSettings {
  if (typeof window === "undefined") return DEFAULT_DIARY_ENTRY_TIMER_SETTINGS;
  try {
    const raw = kvGet(TIMER_KEY);
    if (!raw) return DEFAULT_DIARY_ENTRY_TIMER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<DiaryEntryTimerSettings>;
    const lastRunAtByCharacter = parsed.lastRunAtByCharacter && typeof parsed.lastRunAtByCharacter === "object"
      ? Object.fromEntries(Object.entries(parsed.lastRunAtByCharacter).map(([key, value]) => [key, String(value)]))
      : {};
    return {
      enabled: Boolean(parsed.enabled),
      intervalHours: Math.max(1, Math.min(720, Number(parsed.intervalHours) || 24)),
      characterIds: Array.isArray(parsed.characterIds) ? parsed.characterIds.map(String).filter(Boolean) : [],
      lastRunAtByCharacter,
    };
  } catch {
    return DEFAULT_DIARY_ENTRY_TIMER_SETTINGS;
  }
}

export function saveDiaryEntryTimerSettings(settings: DiaryEntryTimerSettings): void {
  if (typeof window === "undefined") return;
  kvSet(TIMER_KEY, JSON.stringify({
    enabled: Boolean(settings.enabled),
    intervalHours: Math.max(1, Math.min(720, Number(settings.intervalHours) || 24)),
    characterIds: settings.characterIds,
    lastRunAtByCharacter: settings.lastRunAtByCharacter,
  }));
}
