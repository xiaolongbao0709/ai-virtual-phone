"use client";

import type { CustomAppPermission, CustomAppPromptProfile, InstalledCustomApp } from "./custom-app-types";
import {
  appendCustomAppTimelineEntry,
  deleteCustomAppTimelineEntries,
  loadInstalledCustomApps,
  readCustomAppCollection,
  writeCustomAppCollection,
} from "./custom-app-storage";
import { buildCustomAppChatTags } from "./custom-app-tags";
import { hydrateKvDb } from "./kv-db";
import { loadCharacters } from "./character-storage";
import {
  addChatContact,
  createOrGetSession,
  CHAT_REQUEST_REPLY_EVENT,
  getLatestCharacterStateValues,
  hydrateChatStorage,
  loadChatContacts,
  loadChatMessages,
  loadChatSessions,
  pushChatMessage,
  saveChatSessions,
  updateChatMessage,
  type ChatMessage,
  type ChatSession,
  type NativeToolCallRecord,
  type NativeToolResultRecord,
  type StateValue,
} from "./chat-storage";
import { flattenCompletionResult, generateChatCompletion } from "./chat-engine";
import { generateGroupRawCompletion } from "./group-chat-engine";
import {
  deleteCalendarScheduleItem,
  loadCalendarWeekPlan,
  loadOwnerCalendarPlans,
  replaceCalendarWeekItems,
  upsertCalendarScheduleItem,
} from "./calendar-storage";
import type { CalendarOwnerType, CalendarScheduleItem } from "./calendar-types";
import { formatIsoDate, getWeekStartIso, normalizeTime } from "./calendar-utils";
import { simpleLLMCall } from "./api-helpers";
import { generateEmbedding } from "./memory-embedding";
import { loadMemoryConfig, loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import type { MemoryEntry } from "./memory-types";
import { prepareShortTermContext } from "./short-term-assembler";
import {
  createWorldBook,
  loadApiConfigs,
  loadBindingConfig,
  loadUserIdentities,
  loadVoiceConfigs,
  loadWorldBooks,
  resolveAuxiliaryApiConfig,
  resolveBinding,
  resolveUserIdentity,
  ensureSettingsStorageHydrated,
  saveVoiceConfigs,
  saveWorldBooks,
} from "./settings-storage";
import type { ApiConfig, VoiceApiConfig, WorldBookConfig, WorldBookEntry } from "./settings-types";
import { createSTTSession } from "./stt-service";
import { generateImageFromConfiguredApi } from "./image-generation-service";
import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "./theme-storage";
import type { ThemeAssetType } from "./theme-types";
import { synthesizeSpeech } from "./tts-service";
import {
  formatWalletAmount,
  getWalletBalance,
  getWalletTotalBalance,
  loadWalletState,
  payWithWalletAccount,
  WALLET_BALANCE_ACCOUNT_ID,
} from "./wallet-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import {
  appendBridgeOutbox,
  bridgeConnection,
  readAllBridgeStateSnapshots,
  readBridgeStateSnapshot,
  sanitizeBridgeDataKey,
} from "./reality-bridge/storage";

const CUSTOM_APP_NOTIFICATIONS_KEY = "ai_phone_custom_app_notifications_v1";
const CUSTOM_APP_BADGES_KEY = "ai_phone_custom_app_badges_v1";
const CUSTOM_APP_TASKS_KEY = "ai_phone_custom_app_tasks_v1";
const CUSTOM_APP_WORLD_ACTIVATIONS_KEY = "ai_phone_custom_app_world_activations_v1";
const CUSTOM_APP_SUGGESTIONS_KEY = "ai_phone_custom_app_suggestions_v1";

export const CUSTOM_APP_HOST_STATE_UPDATED_EVENT = "ai-phone-custom-app-host-state-updated";

registerKvMigration(CUSTOM_APP_NOTIFICATIONS_KEY);
registerKvMigration(CUSTOM_APP_BADGES_KEY);
registerKvMigration(CUSTOM_APP_TASKS_KEY);
registerKvMigration(CUSTOM_APP_WORLD_ACTIVATIONS_KEY);
registerKvMigration(CUSTOM_APP_SUGGESTIONS_KEY);

export type CustomAppNotification = {
  id: string;
  appId: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  createdAt: string;
  readAt?: string;
};

export type CustomAppHostAction = {
  type: string;
  payload?: Record<string, unknown>;
} & Record<string, unknown>;

export type CustomAppScheduledTask = {
  id: string;
  appId: string;
  runAt: string;
  status: "pending" | "running" | "done" | "failed" | "canceled";
  action: CustomAppHostAction | CustomAppHostAction[];
  onSuccess?: CustomAppHostAction | CustomAppHostAction[];
  onFailure?: CustomAppHostAction | CustomAppHostAction[];
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

export type CustomAppWorldActivation = {
  id: string;
  appId: string;
  worldBookIds: string[];
  context?: string;
  activateAll: boolean;
  expiresAt?: string;
  createdAt: string;
};

export type CustomAppSuggestion = {
  id: string;
  appId: string;
  appName: string;
  kind: "memory";
  status: "pending";
  characterId?: string;
  targetId?: string;
  content?: string;
  patch?: Record<string, unknown>;
  reason?: string;
  createdAt: string;
};

type HostNotice = (message: string) => void;

const HOST_ACTION_PERMISSIONS: Record<string, CustomAppPermission[]> = {
  notification: ["notifications.write", "ui.notification"],
  "ui.notification": ["notifications.write", "ui.notification"],
  badge: ["notifications.write"],
  "notifications.badge": ["notifications.write"],
  "db.update": ["app.data.write"],
  "app.data.update": ["app.data.write"],
  "chat.card": ["chat.sendCard"],
  "chat.history": ["chat.write", "chat.sendMessage"],
  "chat.message": ["chat.write", "chat.sendMessage"],
  "chat.sendMessage": ["chat.write", "chat.sendMessage"],
  "chat.reply": ["chat.requestReply"],
  "chat.updateCard": ["chat.write", "chat.sendCard"],
  "memory.add": ["memory.write"],
  "memory.timeline": ["memory.write"],
  "memory.addTimeline": ["memory.write"],
  "memory.deleteTimeline": ["memory.write"],
  "memory.removeTimeline": ["memory.write"],
  "memory.suggest": ["memory.suggest"],
  "wallet.pay": ["wallet.pay"],
  "chat.contact": ["chat.contacts.write"],
  "calendar.write": ["calendar.write"],
  "world.write": ["world.write"],
  "world.activate": ["world.activate"],
  "bridge.send": ["bridge.send"],
};

function emitHostStateUpdated(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CUSTOM_APP_HOST_STATE_UPDATED_EVENT));
  }
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanUnboundedText(value: unknown): string {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function cleanId(value: unknown, fallbackPrefix = "id"): string {
  const text = cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || `${fallbackPrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function collectionName(value: unknown): string {
  const text = cleanText(value, 80).replace(/[^\w.-]+/g, "_");
  if (!text) throw new Error("collection 不能为空。");
  return text;
}

function recordId(value: unknown): string {
  const text = cleanText(value, 120);
  if (!text) throw new Error("id 不能为空。");
  return text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanStringArray(value: unknown, maxLength = 120, limit = 80): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, maxLength)).filter(Boolean).slice(0, limit);
  const text = cleanText(value, maxLength);
  return text ? [text] : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function writeJsonArray<T>(key: string, items: T[]): void {
  if (typeof window === "undefined") return;
  kvSet(key, JSON.stringify(items));
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    const plain = /^data:([^;,]+)?,(.*)$/i.exec(dataUrl);
    if (!plain) throw new Error("无效的 dataUrl。");
    return new Blob([decodeURIComponent(plain[2])], { type: plain[1] || "application/octet-stream" });
  }
  const mimeType = match[1] || "application/octet-stream";
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function resolveCustomAppApiConfig(app: InstalledCustomApp, record: Record<string, unknown>): ApiConfig | null {
  const apiConfigs = loadApiConfigs();
  const explicitId = cleanText(record.apiConfigId ?? record.configId, 160);
  if (explicitId) return apiConfigs.find(config => config.id === explicitId) ?? null;
  const characterId = cleanText(record.characterId, 160);
  const bindings = loadBindingConfig();
  if (characterId) {
    const appSlot = resolveBinding(bindings, characterId, `custom_app:${app.id}`);
    if (appSlot.apiConfigId) {
      const found = apiConfigs.find(config => config.id === appSlot.apiConfigId);
      if (found) return found;
    }
    const chatSlot = resolveBinding(bindings, characterId, "chat");
    if (chatSlot.apiConfigId) {
      const found = apiConfigs.find(config => config.id === chatSlot.apiConfigId);
      if (found) return found;
    }
  }
  if (bindings.globalDefaults.apiConfigId) {
    const found = apiConfigs.find(config => config.id === bindings.globalDefaults.apiConfigId);
    if (found) return found;
  }
  return apiConfigs[0] ?? null;
}

function resolveCustomAppVoiceConfig(app: InstalledCustomApp, record: Record<string, unknown>): VoiceApiConfig | null {
  const configs = loadVoiceConfigs();
  const explicitId = cleanText(record.voiceConfigId ?? record.configId, 160);
  if (explicitId) return configs.find(config => config.id === explicitId) ?? null;
  const characterId = cleanText(record.characterId, 160);
  const bindings = loadBindingConfig();
  if (characterId) {
    const appSlot = resolveBinding(bindings, characterId, `custom_app:${app.id}`);
    if (appSlot.voiceConfigId) {
      const found = configs.find(config => config.id === appSlot.voiceConfigId);
      if (found) return found;
    }
    const chatSlot = resolveBinding(bindings, characterId, "chat");
    if (chatSlot.voiceConfigId) {
      const found = configs.find(config => config.id === chatSlot.voiceConfigId);
      if (found) return found;
    }
  }
  if (bindings.globalDefaults.voiceConfigId) {
    const found = configs.find(config => config.id === bindings.globalDefaults.voiceConfigId);
    if (found) return found;
  }
  return configs.find(config => config.enableTTS || config.enableSTT) ?? configs[0] ?? null;
}

function serializeVoiceConfig(config: VoiceApiConfig): Record<string, unknown> {
  return {
    id: config.id,
    name: config.name,
    provider: config.provider,
    model: config.model,
    sttModel: config.sttModel,
    defaultVoice: config.defaultVoice,
    languageBoost: config.languageBoost,
    enableTTS: config.enableTTS,
    enableSTT: config.enableSTT,
    customVoices: (config.customVoices ?? []).map(voice => ({
      id: voice.id,
      name: voice.name,
      createdAt: voice.createdAt,
    })),
  };
}

function resolveCalendarOwner(record: Record<string, unknown>): { ownerType: CalendarOwnerType; ownerId: string } {
  const rawOwnerType = cleanText(record.ownerType ?? record.type, 40);
  const ownerType: CalendarOwnerType = rawOwnerType === "character" || record.characterId ? "character" : "user";
  const ownerId = ownerType === "character"
    ? cleanText(record.ownerId ?? record.characterId, 160)
    : cleanText(record.ownerId ?? record.userId, 160) || resolveUserIdentity()?.id || "default_user";
  if (!ownerId) throw new Error("calendar 缺少 ownerId 或 characterId。");
  return { ownerType, ownerId };
}

function normalizeWeekStart(record: Record<string, unknown>): string {
  const explicit = cleanText(record.weekStart, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const dateText = cleanText(record.date, 40);
  const date = dateText ? new Date(`${dateText}T00:00:00`) : new Date();
  return getWeekStartIso(Number.isNaN(date.getTime()) ? new Date() : date);
}

function normalizeCalendarItem(record: Record<string, unknown>, index = 0): Omit<CalendarScheduleItem, "id" | "weekday" | "colorKey" | "createdAt" | "updatedAt"> & Partial<CalendarScheduleItem> {
  const date = cleanText(record.date, 40) || formatIsoDate(new Date());
  const startTime = normalizeTime(cleanText(record.startTime ?? record.start, 20)) ?? "";
  const endTime = normalizeTime(cleanText(record.endTime ?? record.end, 20)) ?? "";
  const title = cleanText(record.title ?? record.name, 120);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("calendar item date 必须是 YYYY-MM-DD。");
  if (!startTime || !endTime) throw new Error("calendar item 需要 startTime/endTime。");
  if (!title) throw new Error("calendar item 需要 title。");
  return {
    id: cleanText(record.id, 120) || `calendar_item_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    date,
    startTime,
    endTime,
    location: cleanText(record.location, 120),
    title,
    source: record.source === "generated" ? "generated" : "manual",
  };
}

function serializeWorldBook(book: WorldBookConfig, includeEntries = true): Record<string, unknown> {
  return {
    id: book.id,
    name: book.name,
    description: book.description,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    entries: includeEntries ? book.entries : undefined,
    entryCount: book.entries.length,
  };
}

function normalizeWorldBookEntry(record: Record<string, unknown>, index = 0): WorldBookEntry {
  return {
    uid: cleanText(record.uid ?? record.id, 120) || `entry_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
    key: cleanText(record.key ?? record.keys, 1000),
    content: cleanText(record.content ?? record.text, 20000),
    comment: cleanText(record.comment ?? record.name ?? record.title, 300),
    use_regex: record.use_regex === true || record.useRegex === true,
    disable: record.disable === true || record.disabled === true,
    constant: record.constant === true,
    position: typeof record.position === "number" ? record.position : (cleanText(record.position, 40) as WorldBookEntry["position"]) || "before_char",
    depth: typeof record.depth === "number" ? record.depth : undefined,
    probability: typeof record.probability === "number" ? Math.max(0, Math.min(100, record.probability)) : undefined,
    useProbability: record.useProbability === true,
    role: typeof record.role === "number" ? record.role : undefined,
    insertion_order: typeof record.insertion_order === "number" ? record.insertion_order : typeof record.order === "number" ? record.order : index,
  };
}

function readWorldActivations(appId?: string): CustomAppWorldActivation[] {
  const now = Date.now();
  const items = parseJsonArray<CustomAppWorldActivation>(CUSTOM_APP_WORLD_ACTIVATIONS_KEY)
    .filter(item => !item.expiresAt || new Date(item.expiresAt).getTime() > now);
  writeJsonArray(CUSTOM_APP_WORLD_ACTIVATIONS_KEY, items);
  return appId ? items.filter(item => item.appId === appId) : items;
}

function saveWorldActivations(items: CustomAppWorldActivation[]): void {
  writeJsonArray(CUSTOM_APP_WORLD_ACTIVATIONS_KEY, items);
}

function activeCustomAppWorldBookIds(app: InstalledCustomApp, record: Record<string, unknown>): string[] {
  const activationId = cleanText(record.activationId, 120);
  const active = readWorldActivations(app.id)
    .filter(item => !activationId || item.id === activationId)
    .flatMap(item => item.worldBookIds);
  return uniqueStrings([
    ...cleanStringArray(record.worldBookIds ?? record.worldBookId, 160, 30),
    ...active,
  ]);
}

function appendSuggestion(app: InstalledCustomApp, suggestion: Omit<CustomAppSuggestion, "id" | "appId" | "appName" | "status" | "createdAt">): CustomAppSuggestion {
  const item: CustomAppSuggestion = {
    id: `custom_app_suggestion_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    appId: app.id,
    appName: app.name,
    status: "pending",
    createdAt: nowIso(),
    ...suggestion,
  };
  const items = parseJsonArray<CustomAppSuggestion>(CUSTOM_APP_SUGGESTIONS_KEY);
  writeJsonArray(CUSTOM_APP_SUGGESTIONS_KEY, [item, ...items].slice(0, 500));
  return item;
}

function hasPermission(app: InstalledCustomApp, permission: CustomAppPermission): boolean {
  return app.permissions.includes(permission);
}

function serializeMemoryEntry(entry: MemoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    type: entry.type,
    content: entry.content,
    importance: entry.importance,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    metadata: entry.metadata ?? {},
  };
}

function serializeChatMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: cleanUnboundedText(message.content),
    createdAt: message.createdAt,
    status: message.status,
    senderName: message.senderName,
    mediaType: message.mediaType,
    mediaData: asRecord(message.mediaData),
    isRetracted: message.isRetracted === true,
  };
}

function normalizeHistoryRole(value: unknown): ChatMessage["role"] {
  const role = cleanText(value, 40);
  if (role === "system" || role === "assistant" || role === "user") return role;
  return "user";
}

function normalizeOptionalHistoryRole(value: unknown): ChatMessage["role"] | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return normalizeHistoryRole(value);
}

function normalizeCustomAppMessageOrigin(value: unknown): ChatMessage["origin"] | undefined {
  const origin = cleanText(value, 80);
  if (origin === "custom_app_background") return "custom_app_background";
  if (origin === "custom_app") return "custom_app";
  return undefined;
}

function normalizeCustomAppGenerateTimestamp(value: unknown, fallbackIndex: number, total: number): string {
  const text = cleanText(value, 80);
  const parsed = text ? Date.parse(text) : NaN;
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const offset = Math.max(0, total - fallbackIndex) * 1000;
  return new Date(Date.now() - offset).toISOString();
}

function normalizeCustomAppGenerateRole(value: unknown, hasNativeToolResult: boolean): ChatMessage["role"] {
  if (hasNativeToolResult) return "tool";
  const role = cleanText(value, 40);
  if (role === "tool") return "tool";
  return normalizeHistoryRole(role);
}

function normalizeCustomAppNativeToolCalls(value: unknown): NativeToolCallRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.map((item): NativeToolCallRecord | null => {
    const entry = asRecord(item);
    const id = cleanText(entry.id ?? entry.toolCallId, 160);
    const name = cleanText(entry.name ?? entry.toolName, 160);
    if (!id || !name) return null;
    const args = asRecord(entry.args ?? entry.arguments);
    const thoughtSignature = cleanUnboundedText(entry.thoughtSignature);
    return {
      id,
      name,
      args,
      ...(thoughtSignature ? { thoughtSignature } : {}),
    };
  }).filter(Boolean) as NativeToolCallRecord[];
  return calls.length > 0 ? calls : undefined;
}

function normalizeCustomAppNativeToolResult(value: unknown): NativeToolResultRecord | undefined {
  const record = asRecord(value);
  const toolCallId = cleanText(record.toolCallId ?? record.id, 160);
  const name = cleanText(record.name ?? record.toolName, 160);
  const content = cleanUnboundedText(record.content ?? record.text ?? record.result);
  if (!toolCallId || !name || !content) return undefined;
  return { toolCallId, name, content };
}

function normalizeCustomAppGenerateMessages(record: Record<string, unknown>, sessionId: string): ChatMessage[] | null {
  const raw = Array.isArray(record.appMessages)
    ? record.appMessages
    : Array.isArray(record.messages)
      ? record.messages
      : null;
  if (!raw) return null;
  // APP 可在消息上带 image（data:image dataURL）走视觉通道；限量限大小防上下文爆炸。
  // 用户模型不支持/关闭图像识别时，下游 provider-adapter 会自动降级为 [图片] 文本。
  let imageCount = 0;
  const MAX_IMAGES_PER_CALL = 4;
  const MAX_IMAGE_DATAURL_LENGTH = 2_000_000;
  return raw.map((item, index): ChatMessage | null => {
    const entry = asRecord(item);
    const nativeToolCalls = normalizeCustomAppNativeToolCalls(entry.nativeToolCalls ?? entry.toolCalls);
    const nativeToolResult = normalizeCustomAppNativeToolResult(entry.nativeToolResult ?? entry.toolResult);
    const content = cleanUnboundedText(entry.content ?? entry.text ?? entry.message);
    const rawResponseText = cleanUnboundedText(entry.rawResponseText ?? entry.rawContent);
    const rawImage = entry.image ?? entry.imageDataUrl;
    let imageUrl: string | undefined;
    if (
      typeof rawImage === "string"
      && /^data:image\//.test(rawImage)
      && rawImage.length <= MAX_IMAGE_DATAURL_LENGTH
      && imageCount < MAX_IMAGES_PER_CALL
    ) {
      imageUrl = rawImage;
      imageCount++;
    }
    if (!content && !imageUrl && !rawResponseText && !nativeToolCalls?.length && !nativeToolResult) return null;
    const mediaType = cleanText(entry.mediaType ?? entry.type, 80) === "tool_result" || nativeToolResult
      ? "tool_result" as const
      : imageUrl
        ? "image" as const
        : undefined;
    return {
      mediaUrl: imageUrl,
      id: cleanText(entry.id, 160) || `custom-app-history-${Date.now()}-${index}`,
      sessionId: cleanText(entry.sessionId, 160) || sessionId,
      role: normalizeCustomAppGenerateRole(entry.role, Boolean(nativeToolResult)),
      content,
      status: "sent",
      createdAt: normalizeCustomAppGenerateTimestamp(entry.createdAt ?? entry.timestamp ?? entry.at, index, raw.length),
      senderName: cleanText(entry.senderName ?? entry.name, 80) || undefined,
      origin: "custom_app",
      mediaType,
      rawResponseText: rawResponseText || undefined,
      nativeToolCalls,
      nativeToolResult,
      nativeToolReasoning: cleanUnboundedText(entry.nativeToolReasoning ?? entry.reasoning) || undefined,
      nativeToolOpenRouterReasoningDetails: Array.isArray(entry.nativeToolOpenRouterReasoningDetails ?? entry.openRouterReasoningDetails)
        ? (entry.nativeToolOpenRouterReasoningDetails ?? entry.openRouterReasoningDetails) as unknown[]
        : undefined,
    };
  }).filter(Boolean) as ChatMessage[];
}

function createCustomAppGeneratedContextMessage(
  sessionId: string,
  index: number,
  patch: Partial<ChatMessage> & Pick<ChatMessage, "role">,
): ChatMessage {
  return {
    id: `custom-app-generated-${Date.now()}-${index}`,
    sessionId,
    content: "",
    status: "sent",
    createdAt: new Date().toISOString(),
    origin: "custom_app",
    ...patch,
  };
}

function serializeCustomAppContextMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    senderName: message.senderName,
    mediaType: message.mediaType,
    rawResponseText: message.rawResponseText,
    nativeToolCalls: message.nativeToolCalls,
    nativeToolResult: message.nativeToolResult,
    nativeToolReasoning: message.nativeToolReasoning,
    nativeToolOpenRouterReasoningDetails: message.nativeToolOpenRouterReasoningDetails,
  };
}

function resolveCustomAppUserIdentity(app: InstalledCustomApp, record: Record<string, unknown>) {
  const characterId = cleanText(record.characterId, 160) || undefined;
  return resolveUserIdentity(characterId, `custom_app:${app.id}`) ?? resolveUserIdentity(characterId);
}

function serializeUserProfile(identity: NonNullable<ReturnType<typeof resolveUserIdentity>>): Record<string, unknown> {
  return {
    id: identity.id,
    name: identity.name,
    avatarUrl: identity.avatarUrl,
    gender: identity.gender,
    age: identity.age,
    occupation: identity.occupation,
  };
}

function formatUserPersona(identity: NonNullable<ReturnType<typeof resolveUserIdentity>>): string {
  return [
    identity.name ? `姓名：${identity.name}` : "",
    identity.gender ? `性别：${identity.gender}` : "",
    identity.age ? `年龄：${identity.age}` : "",
    identity.occupation ? `职业：${identity.occupation}` : "",
    identity.bio ? `简介：${identity.bio}` : "",
    identity.customSettings ? `补充设定：${identity.customSettings}` : "",
  ].filter(Boolean).join("\n");
}

function resolvePromptProfile(app: InstalledCustomApp, record: Record<string, unknown>): CustomAppPromptProfile | null {
  const manifestProfiles = [
    ...(app.manifest.promptProfiles ?? []),
    ...(app.manifest.extensions?.prompt?.profiles ?? []),
  ];
  const profileRef = record.profileId ?? record.promptProfileId ?? record.profile;
  if (typeof profileRef === "string") {
    const id = cleanId(profileRef);
    return manifestProfiles.find(profile => cleanId(profile.id) === id) ?? null;
  }
  const rawProfile = asRecord(record.promptProfile ?? record.profile);
  const label = cleanText(rawProfile.label ?? rawProfile.name ?? rawProfile.id, 80);
  const id = cleanId(rawProfile.id ?? label);
  if (!id || !label) return null;
  const history = cleanText(rawProfile.history, 40);
  const output = cleanText(rawProfile.output, 40);
  return {
    id,
    label,
    description: cleanText(rawProfile.description ?? rawProfile.desc, 500) || undefined,
    include: cleanStringArray(rawProfile.include ?? rawProfile.includes, 80),
    exclude: cleanStringArray(rawProfile.exclude ?? rawProfile.excludes, 80),
    history: history === "default" || history === "none" || history === "current_session" || history === "recent" ? history : undefined,
    output: output === "chat" || output === "plain_text" || output === "json" ? output : undefined,
    appTags: cleanStringArray(rawProfile.appTags ?? rawProfile.tags, 80, 30),
    enableWorldBooks: typeof rawProfile.enableWorldBooks === "boolean" ? rawProfile.enableWorldBooks : undefined,
    enableRegexes: typeof rawProfile.enableRegexes === "boolean" ? rawProfile.enableRegexes : undefined,
  };
}

function requireHostActionPermission(app: InstalledCustomApp, actionType: string): void {
  const permissions = HOST_ACTION_PERMISSIONS[actionType];
  if (!permissions?.length) return;
  if (permissions.some(permission => hasPermission(app, permission))) return;
  throw new Error(`应用未声明权限：${permissions.join(" 或 ")}`);
}

function numberAmount(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").replace(/[¥￥元,\s]/g, ""));
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0;
}

const NETWORK_FETCH_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const CUSTOM_APP_OPTIONAL_TIMEOUT_MAX_MS = 30 * 60_000;
const CUSTOM_APP_PROXY_TIMEOUT_MAX_MS = 120_000;
const FORBIDDEN_NETWORK_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "host",
  "origin",
  "referer",
  "content-length",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "transfer-encoding",
]);
const NETWORK_BODY_LIMIT = 128 * 1024;

function parseAllowedDomain(value: unknown): { host: string; port?: string; wildcard: boolean } | null {
  let text = cleanText(value, 160).toLowerCase();
  if (!text) return null;
  text = text.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  const wildcard = text.startsWith("*.");
  if (wildcard) text = text.slice(2);
  const lastColon = text.lastIndexOf(":");
  const host = (lastColon > 0 ? text.slice(0, lastColon) : text).replace(/^\[|\]$/g, "");
  const port = lastColon > 0 ? text.slice(lastColon + 1) : undefined;
  if (!host || host.includes("*")) return null;
  if (!/^[a-z0-9.-]+$/.test(host) && !/^[0-9a-f:]+$/i.test(host)) return null;
  return { host, port: port && /^\d+$/.test(port) ? port : undefined, wildcard };
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function isBlockedNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isIpv6Literal = host.includes(":");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || (isIpv6Literal && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")))
    || isPrivateIpv4(host);
}

function getNetworkUrlPort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

function isAllowedNetworkUrl(url: URL, allowedDomains: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = getNetworkUrlPort(url);
  return allowedDomains.some(rawDomain => {
    const domain = parseAllowedDomain(rawDomain);
    if (!domain) return false;
    if (domain.port && domain.port !== port) return false;
    if (host === domain.host) return true;
    return domain.wildcard && host.endsWith(`.${domain.host}`);
  });
}

function sanitizeNetworkHeaders(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(asRecord(value))) {
    const name = cleanText(rawName, 80);
    const lowerName = name.toLowerCase();
    if (!name || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/i.test(name)) continue;
    if (FORBIDDEN_NETWORK_HEADERS.has(lowerName) || lowerName.startsWith("sec-") || lowerName.startsWith("proxy-")) {
      throw new Error(`network.fetch 不允许设置请求头：${name}`);
    }
    if (rawValue === undefined || rawValue === null) continue;
    result[name] = cleanText(rawValue, 2000);
  }
  return result;
}

function normalizeNetworkBody(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  if (body.length > NETWORK_BODY_LIMIT) {
    throw new Error(`network.fetch 请求体不能超过 ${NETWORK_BODY_LIMIT} 字符。`);
  }
  return body;
}

function optionalCustomAppTimeoutMs(value: unknown, maxMs = CUSTOM_APP_OPTIONAL_TIMEOUT_MAX_MS): number | undefined {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.max(1, Math.min(timeoutMs, maxMs));
}

async function withOptionalCustomAppTimeout<T>(
  timeoutMs: number | undefined,
  label: string,
  task: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!timeoutMs) return task();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await task(controller.signal);
    if (controller.signal.aborted) {
      throw new Error(`${label} 超时（超过 ${Math.ceil(timeoutMs / 1000)} 秒）`);
    }
    return result;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} 超时（超过 ${Math.ceil(timeoutMs / 1000)} 秒）`);
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function shouldProxyCustomAppNetworkFetch(app: InstalledCustomApp, record: Record<string, unknown>): boolean {
  if (record.proxy === true) return true;
  if (record.proxy === false) return false;
  const mode = cleanText(record.mode ?? record.transport, 20).toLowerCase();
  if (mode === "proxy") return true;
  if (mode === "direct") return false;
  return app.manifest.network?.mode === "proxy";
}

async function serializeNetworkResponse(response: Response): Promise<Record<string, unknown>> {
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (json && typeof json === "object" && (json as Record<string, unknown>)._binary === true) {
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      binary: true,
      contentType: cleanText((json as Record<string, unknown>).contentType, 120),
      data: cleanText((json as Record<string, unknown>).data, 2_000_000),
    };
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    text,
    json,
  };
}

function parseRunAt(value: unknown, delayMs?: unknown): string {
  if (typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0) {
    return new Date(Date.now() + Math.min(delayMs, 1000 * 60 * 60 * 24 * 30)).toISOString();
  }
  const delayNumber = Number(delayMs);
  if (Number.isFinite(delayNumber) && delayNumber > 0) {
    return new Date(Date.now() + Math.min(delayNumber, 1000 * 60 * 60 * 24 * 30)).toISOString();
  }
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function loadJsonArray<T>(key: string): T[] {
  try {
    const parsed = JSON.parse(kvGet(key) || "[]") as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function saveNotifications(items: CustomAppNotification[]): CustomAppNotification[] {
  const next = items.slice(0, 300);
  kvSet(CUSTOM_APP_NOTIFICATIONS_KEY, JSON.stringify(next));
  emitHostStateUpdated();
  return next;
}

function loadBadgeMap(): Record<string, number> {
  try {
    const parsed = JSON.parse(kvGet(CUSTOM_APP_BADGES_KEY) || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const count = Math.max(0, Math.min(999, Math.floor(Number(value) || 0)));
      if (count > 0) result[key] = count;
    }
    return result;
  } catch {
    return {};
  }
}

function saveBadgeMap(map: Record<string, number>): Record<string, number> {
  kvSet(CUSTOM_APP_BADGES_KEY, JSON.stringify(map));
  emitHostStateUpdated();
  return map;
}

function saveTasks(items: CustomAppScheduledTask[]): CustomAppScheduledTask[] {
  const next = items.slice(-500);
  kvSet(CUSTOM_APP_TASKS_KEY, JSON.stringify(next));
  emitHostStateUpdated();
  return next;
}

export function loadCustomAppNotifications(appId?: string): CustomAppNotification[] {
  const items = loadJsonArray<CustomAppNotification>(CUSTOM_APP_NOTIFICATIONS_KEY);
  return appId ? items.filter(item => item.appId === appId) : items;
}

export function createCustomAppNotification(
  app: InstalledCustomApp,
  input: Record<string, unknown>,
  onNotice?: HostNotice,
): CustomAppNotification {
  const title = cleanText(input.title, 80) || app.name;
  const body = cleanText(input.body ?? input.message, 300) || undefined;
  const id = cleanId(input.id, "notice");
  const notification: CustomAppNotification = {
    id,
    appId: app.id,
    title,
    body,
    data: asRecord(input.data),
    createdAt: new Date().toISOString(),
  };
  saveNotifications([notification, ...loadCustomAppNotifications()]);
  const badgeDelta = input.badgeDelta === undefined && input.badge === undefined
    ? 1
    : Number(input.badgeDelta ?? 0) || 0;
  if (input.badge !== undefined) setCustomAppBadge(app.id, Number(input.badge) || 0);
  else if (badgeDelta) incrementCustomAppBadge(app.id, badgeDelta);
  onNotice?.(body ? `${title}：${body}` : title);
  return notification;
}

export function markCustomAppNotificationsRead(appId: string, id?: string): CustomAppNotification[] {
  const now = new Date().toISOString();
  const next = loadCustomAppNotifications().map(item => {
    if (item.appId !== appId) return item;
    if (id && item.id !== id) return item;
    return item.readAt ? item : { ...item, readAt: now };
  });
  return saveNotifications(next);
}

export function getCustomAppBadge(appId: string): number {
  return loadBadgeMap()[appId] ?? 0;
}

export function loadCustomAppBadges(): Record<string, number> {
  return loadBadgeMap();
}

export function setCustomAppBadge(appId: string, count: number): number {
  const map = loadBadgeMap();
  const nextCount = Math.max(0, Math.min(999, Math.floor(Number(count) || 0)));
  if (nextCount > 0) map[appId] = nextCount;
  else delete map[appId];
  saveBadgeMap(map);
  return nextCount;
}

export function incrementCustomAppBadge(appId: string, delta = 1): number {
  return setCustomAppBadge(appId, getCustomAppBadge(appId) + delta);
}

export function readCustomAppUserProfile(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> | null {
  const identity = resolveCustomAppUserIdentity(app, record);
  return identity ? serializeUserProfile(identity) : null;
}

export function readCustomAppUserPersona(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> | null {
  const identity = resolveCustomAppUserIdentity(app, record);
  if (!identity) return null;
  return {
    ...serializeUserProfile(identity),
    bio: identity.bio,
    customSettings: identity.customSettings,
    text: formatUserPersona(identity),
  };
}

export function readCustomAppUserPreferences(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> | null {
  const identity = resolveCustomAppUserIdentity(app, record);
  if (!identity) return null;
  return {
    id: identity.id,
    customSettings: identity.customSettings,
    text: identity.customSettings || "",
  };
}

export function readCustomAppVoiceProfiles(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> {
  const characterId = cleanText(record.characterId, 160);
  const selected = resolveCustomAppVoiceConfig(app, record);
  return {
    selected: selected ? serializeVoiceConfig(selected) : null,
    profiles: loadVoiceConfigs().map(serializeVoiceConfig),
    characterId: characterId || undefined,
  };
}

export async function synthesizeCustomAppSpeech(app: InstalledCustomApp, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const text = cleanText(record.text ?? record.input, 5000);
  if (!text) throw new Error("voice.tts 需要 text。");
  const config = resolveCustomAppVoiceConfig(app, record);
  if (!config) throw new Error("未找到可用语音配置。");
  if (config.enableTTS === false) throw new Error("当前语音配置未启用 TTS。");
  const overrideVoice = cleanText(record.voiceId ?? record.voice, 160);
  const voiceConfig = overrideVoice ? { ...config, defaultVoice: overrideVoice } : config;
  const emotion = cleanText(record.emotion, 30) || undefined;
  const blob = await synthesizeSpeech(text, voiceConfig, { emotion });
  if (!blob) throw new Error("语音合成未返回音频。");
  return {
    ok: true,
    configId: config.id,
    provider: config.provider,
    voiceId: voiceConfig.defaultVoice,
    mimeType: blob.type || "audio/mpeg",
    size: blob.size,
    dataUrl: await blobToDataUrl(blob),
  };
}

export function recognizeCustomAppSpeech(app: InstalledCustomApp, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = resolveCustomAppVoiceConfig(app, record);
  if (config && config.enableSTT === false) throw new Error("当前语音配置未启用 STT。");
  const lang = cleanText(record.lang ?? record.language, 20) || "zh-CN";
  const timeoutMs = Math.max(1000, Math.min(60_000, Number(record.timeoutMs ?? 15_000) || 15_000));
  return new Promise((resolve, reject) => {
    let settled = false;
    let interimText = "";
    let session: ReturnType<typeof createSTTSession> | null = null;
    const finish = (result: Record<string, unknown>, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try { session?.abort(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(result);
    };
    const timer = window.setTimeout(() => {
      finish({ ok: false, text: interimText, reason: "timeout" });
    }, timeoutMs);
    session = createSTTSession({
      onInterim: text => { interimText = text; },
      onFinal: text => finish({ ok: true, text, interim: interimText }),
      onError: error => finish({}, new Error(error)),
      onEnd: () => finish({ ok: false, text: interimText, reason: "ended" }),
      onNoSpeech: () => finish({ ok: false, text: "", reason: "no-speech" }),
    }, lang);
    if (!session.isSupported) {
      finish({}, new Error("浏览器不支持语音识别。"));
      return;
    }
    session.start();
  });
}

/**
 * voice.record —— 在宿主页录一段麦克风音频,回传 dataUrl。
 *
 * 为什么不在 APP 的 iframe 里直接 getUserMedia:那个 iframe 是
 * sandbox="allow-scripts"(空源)且 allow 里没有 microphone,权限策略会直接拒绝。
 * 宿主页本来就持有麦克风权限(STT 走的就是这条路),所以录音也放在这里。
 *
 * 与 voice.stt 互不影响:两者可以并行——识别拿文字给 AI 读,录音拿音频给别人听。
 */
let activeCustomAppRecorder: { stop: () => void } | null = null;

export function recordCustomAppSpeech(record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const maxMs = Math.max(1000, Math.min(60_000, Number(record.maxMs ?? 20_000) || 20_000));
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      reject(new Error("当前环境不支持录音。"));
      return;
    }
    if (activeCustomAppRecorder) {
      reject(new Error("已有录音在进行中。"));
      return;
    }
    let settled = false;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let timer = 0;
    const startedAt = Date.now();
    const cleanup = () => {
      window.clearTimeout(timer);
      activeCustomAppRecorder = null;
      try { stream?.getTracks().forEach(track => track.stop()); } catch { /* ignore */ }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    navigator.mediaDevices.getUserMedia({ audio: true }).then(got => {
      stream = got;
      // 优先 opus:同样时长体积最小,分片传输时省带宽
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
      recorder = mime ? new MediaRecorder(got, { mimeType: mime, audioBitsPerSecond: 24_000 })
                      : new MediaRecorder(got);
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data && event.data.size) chunks.push(event.data); };
      recorder.onerror = () => fail(new Error("录音失败。"));
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
        if (!blob.size) { reject(new Error("没有录到声音。")); return; }
        blobToDataUrl(blob).then(dataUrl => resolve({
          ok: true,
          dataUrl,
          mimeType: blob.type,
          size: blob.size,
          ms: Date.now() - startedAt,
        })).catch(() => reject(new Error("录音编码失败。")));
      };
      activeCustomAppRecorder = { stop: () => { try { recorder?.stop(); } catch { /* ignore */ } } };
      recorder.start();
      timer = window.setTimeout(() => { try { recorder?.stop(); } catch { /* ignore */ } }, maxMs);
    }).catch(() => fail(new Error("麦克风权限被拒绝或不可用。")));
  });
}

export function stopCustomAppRecording(): Record<string, unknown> {
  if (!activeCustomAppRecorder) return { ok: false, reason: "no-active-recording" };
  activeCustomAppRecorder.stop();
  return { ok: true };
}

export async function cloneCustomAppVoice(app: InstalledCustomApp, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = resolveCustomAppVoiceConfig(app, record);
  if (!config) throw new Error("未找到可用语音配置。");
  if (config.provider !== "Minimax") throw new Error("voice.clone 当前仅支持 Minimax 语音配置。");
  if (!config.apiKey) throw new Error("Minimax API Key 未配置。");
  const voiceId = cleanText(record.voiceId, 64);
  if (!voiceId || !/^[A-Za-z0-9_-]{4,64}$/.test(voiceId)) throw new Error("voice.clone 需要合法 voiceId。");
  const dataUrl = cleanText(record.audioDataUrl ?? record.dataUrl, 25_000_000);
  if (!dataUrl) throw new Error("voice.clone 需要 audioDataUrl。");
  const blob = dataUrlToBlob(dataUrl);
  const form = new FormData();
  form.set("apiKey", config.apiKey);
  form.set("baseUrl", config.baseUrl ?? "");
  form.set("voiceId", voiceId);
  form.set("audio", blob, cleanText(record.filename, 120) || "voice-sample.mp3");
  const response = await fetch("/api/voice/minimax-clone", { method: "POST", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(cleanText(data?.message ?? data?.error, 500) || `voice.clone 失败 (${response.status})`);
  }
  const clonedVoice = {
    id: voiceId,
    name: cleanText(record.name ?? record.label, 80) || voiceId,
    createdAt: Date.now(),
  };
  const configs = loadVoiceConfigs();
  const nextConfigs = configs.map(item => item.id === config.id
    ? {
      ...item,
      customVoices: [
        clonedVoice,
        ...(item.customVoices ?? []).filter(voice => voice.id !== voiceId),
      ],
      defaultVoice: record.setDefault === true ? voiceId : item.defaultVoice,
    }
    : item);
  saveVoiceConfigs(nextConfigs);
  return { ok: true, configId: config.id, voiceId, fileId: data?.fileId, voice: clonedVoice };
}

export function readCustomAppCalendar(record: Record<string, unknown>): Record<string, unknown> {
  const { ownerType, ownerId } = resolveCalendarOwner(record);
  const weekStart = normalizeWeekStart(record);
  const plan = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  return {
    ownerType,
    ownerId,
    weekStart,
    plan,
    plans: record.includeAll === true ? loadOwnerCalendarPlans(ownerType, ownerId) : undefined,
  };
}

export function writeCustomAppCalendar(record: Record<string, unknown>): Record<string, unknown> {
  const operation = cleanText(record.operation ?? record.action, 40) || (record.items ? "replace" : "upsert");
  const { ownerType, ownerId } = resolveCalendarOwner(record);
  const weekStart = normalizeWeekStart(record);
  if (operation === "delete") {
    const itemId = cleanText(record.itemId ?? record.id, 120);
    if (!itemId) throw new Error("calendar.delete 需要 itemId。");
    return { ok: true, plan: deleteCalendarScheduleItem(ownerType, ownerId, weekStart, itemId) };
  }
  if (operation === "replace") {
    const rawItems = Array.isArray(record.items) ? record.items : [];
    const items = rawItems.map((item, index) => normalizeCalendarItem(asRecord(item), index));
    return { ok: true, plan: replaceCalendarWeekItems(ownerType, ownerId, weekStart, items as CalendarScheduleItem[]) };
  }
  const itemRecord = asRecord(record.item);
  const item = normalizeCalendarItem(Object.keys(itemRecord).length > 0 ? itemRecord : record);
  return { ok: true, plan: upsertCalendarScheduleItem(ownerType, ownerId, weekStart, item) };
}

export function readCustomAppWorld(record: Record<string, unknown>): Record<string, unknown> {
  const books = loadWorldBooks();
  const id = cleanText(record.id ?? record.worldBookId, 160);
  if (id) {
    const book = books.find(item => item.id === id || item.name === id);
    return { book: book ? serializeWorldBook(book, record.includeEntries !== false) : null };
  }
  const query = cleanText(record.query, 120).toLowerCase();
  const includeEntries = record.includeEntries === true;
  const result = query
    ? books.filter(book => book.name.toLowerCase().includes(query) || (book.description ?? "").toLowerCase().includes(query))
    : books;
  return { books: result.map(book => serializeWorldBook(book, includeEntries)) };
}

export function writeCustomAppWorld(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> {
  const operation = cleanText(record.operation ?? record.action, 40) || "upsert";
  const books = loadWorldBooks();
  if (operation === "delete") {
    const id = cleanText(record.id ?? record.worldBookId, 160);
    if (!id) throw new Error("world.delete 需要 id。");
    const next = books.filter(book => book.id !== id);
    saveWorldBooks(next);
    window.dispatchEvent(new CustomEvent("settings-worldbooks-updated"));
    return { ok: true, deleted: next.length !== books.length };
  }
  const id = cleanText(record.id ?? record.worldBookId, 160);
  const existing = id ? books.find(book => book.id === id || book.name === id) : null;
  const book = existing ? { ...existing } : createWorldBook(cleanText(record.name, 120) || `${app.name} 世界书`);
  book.name = cleanText(record.name, 120) || book.name;
  book.description = cleanText(record.description, 1000) || book.description;
  if (Array.isArray(record.entries)) {
    book.entries = record.entries.map((entry, index) => normalizeWorldBookEntry(asRecord(entry), index));
  } else if (record.entry && typeof record.entry === "object") {
    const entry = normalizeWorldBookEntry(asRecord(record.entry), book.entries.length);
    book.entries = [...book.entries.filter(item => item.uid !== entry.uid), entry];
  } else if (operation === "deleteEntry") {
    const uid = cleanText(record.uid ?? record.entryId, 120);
    if (!uid) throw new Error("world.deleteEntry 需要 uid。");
    book.entries = book.entries.filter(entry => entry.uid !== uid);
  }
  book.updatedAt = Date.now();
  const next = existing ? books.map(item => item.id === existing.id ? book : item) : [book, ...books];
  saveWorldBooks(next);
  window.dispatchEvent(new CustomEvent("settings-worldbooks-updated"));
  return { ok: true, book: serializeWorldBook(book) };
}

export function activateCustomAppWorld(app: InstalledCustomApp, record: Record<string, unknown>): CustomAppWorldActivation {
  const ids = uniqueStrings(cleanStringArray(record.worldBookIds ?? record.worldBookId ?? record.ids, 160, 30));
  if (ids.length === 0) throw new Error("world.activate 需要 worldBookIds。");
  const books = loadWorldBooks();
  const validIds = ids
    .map(id => books.find(book => book.id === id || book.name === id)?.id)
    .filter(Boolean) as string[];
  if (validIds.length === 0) throw new Error("world.activate 未找到可用世界书。");
  const ttlMs = Math.max(0, Math.min(1000 * 60 * 60 * 24, Number(record.ttlMs ?? 1000 * 60 * 30) || 0));
  const activation: CustomAppWorldActivation = {
    id: cleanText(record.activationId ?? record.id, 120) || `world_activation_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    appId: app.id,
    worldBookIds: validIds,
    context: cleanUnboundedText(record.context) || undefined,
    activateAll: record.activateAll !== false,
    expiresAt: ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : undefined,
    createdAt: nowIso(),
  };
  const existing = readWorldActivations().filter(item => !(item.appId === app.id && item.id === activation.id));
  saveWorldActivations([activation, ...existing].slice(0, 200));
  return activation;
}

export async function saveCustomAppMedia(record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dataUrl = cleanText(record.dataUrl, 25_000_000);
  if (!dataUrl) throw new Error("media.save 需要 dataUrl。");
  const blob = dataUrlToBlob(dataUrl);
  const type = cleanText(record.type, 80) || "custom_app_media";
  const assetId = await saveThemeAssetFromBlob(blob, type as ThemeAssetType, cleanText(record.id, 160) || undefined);
  return {
    ok: true,
    assetId,
    mimeType: blob.type || "application/octet-stream",
    size: blob.size,
    dataUrl: record.returnDataUrl === true ? await getThemeAssetDataUrl(assetId) : undefined,
  };
}

export async function runCustomAppAiChat(app: InstalledCustomApp, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = resolveCustomAppApiConfig(app, record);
  if (!config) throw new Error("未找到可用 API 配置。");
  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  const messages = rawMessages.length > 0
    ? rawMessages.map(item => {
      const entry = asRecord(item);
      const role = cleanText(entry.role, 20);
      return {
        role: role === "system" || role === "assistant" || role === "user" ? role : "user",
        content: String(entry.content ?? entry.text ?? ""),
      };
    }).filter(item => item.content.trim())
    : [
      String(record.system ?? "").trim() ? { role: "system", content: String(record.system ?? "") } : null,
      { role: "user", content: String(record.prompt ?? record.input ?? record.content ?? "").trim() || "请继续。" },
    ].filter(Boolean) as { role: string; content: string }[];
  const timeoutMs = optionalCustomAppTimeoutMs(record.timeoutMs);
  const result = await withOptionalCustomAppTimeout(timeoutMs, "ai.chat", signal => (
    simpleLLMCall(config, messages, {
      temperature: typeof record.temperature === "number" ? record.temperature : undefined,
      max_tokens: typeof record.maxTokens === "number" ? record.maxTokens : typeof record.max_tokens === "number" ? record.max_tokens : undefined,
      signal,
    })
  ));
  if (result.error) throw new Error(result.error);
  return { text: result.content ?? "", finishReason: result.finishReason, wasTruncated: result.wasTruncated };
}

export async function runCustomAppAiEmbed(app: InstalledCustomApp, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const text = cleanUnboundedText(record.text ?? record.input);
  if (!text) throw new Error("ai.embed 需要 text。");
  const config = cleanText(record.apiConfigId ?? record.configId, 160)
    ? resolveCustomAppApiConfig(app, record)
    : resolveAuxiliaryApiConfig("embeddingApiConfigId") ?? resolveCustomAppApiConfig(app, record);
  if (!config) throw new Error("未找到可用 embedding API 配置。");
  const embedding = await generateEmbedding(text, config);
  if (!embedding) throw new Error("当前 API 配置不支持 embedding 或请求失败。");
  return { embedding, dimensions: embedding.length, provider: config.provider };
}

export async function runCustomAppAiClassify(app: InstalledCustomApp, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const text = cleanUnboundedText(record.text ?? record.input);
  const labels = cleanStringArray(record.labels ?? record.categories, 80, 50);
  if (!text || labels.length === 0) throw new Error("ai.classify 需要 text 和 labels。");
  const result = await runCustomAppAiChat(app, {
    ...record,
    temperature: typeof record.temperature === "number" ? record.temperature : 0,
    messages: [
      { role: "system", content: `你是分类器。只能从以下标签中选择一个并输出标签原文：${labels.join(" / ")}` },
      { role: "user", content: text },
    ],
  });
  const raw = cleanText(result.text, 500);
  const label = labels.find(item => raw.includes(item)) ?? raw.split(/\s+/)[0] ?? labels[0];
  return { label, raw };
}

export async function generateCustomAppImage(app: InstalledCustomApp, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const description = cleanText(record.prompt ?? record.description, 4000);
  if (!description) throw new Error("ai.generateImage 需要 prompt。");
  const characterId = cleanText(record.characterId, 160) || undefined;
  const useReferenceImage = record.useReferenceImage === true;
  const timeoutMs = optionalCustomAppTimeoutMs(record.timeoutMs);
  const result = await withOptionalCustomAppTimeout(timeoutMs, "ai.generateImage", signal => (
    generateImageFromConfiguredApi({ description, characterId, useReferenceImage, signal })
  ));
  if (!result) throw new Error("生图功能未配置或未启用，请先在小手机设置里配置生图 API。");
  return {
    ok: true,
    dataUrl: result.dataUrl,
    mimeType: result.mimeType,
    prompt: result.prompt,
    revisedPrompt: result.revisedPrompt,
    usedReferenceImage: result.usedReferenceImage,
  };
}

export function readCustomAppCharacterState(record: Record<string, unknown>): Record<string, unknown> {
  const characterId = cleanText(record.characterId ?? record.id, 160);
  if (!characterId) throw new Error("characters.state.read 需要 characterId。");
  const character = loadCharacters().find(item => item.id === characterId) ?? null;
  return {
    characterId,
    character: character ? {
      id: character.id,
      name: character.name,
      avatar: character.avatar,
      tags: character.tags ?? [],
    } : null,
    stateValues: getLatestCharacterStateValues(characterId),
  };
}

export function writeCustomAppCharacterState(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> {
  const characterId = cleanText(record.characterId ?? record.id, 160);
  if (!characterId) throw new Error("characters.state.write 需要 characterId。");
  const values = Array.isArray(record.stateValues)
    ? record.stateValues
    : Object.entries(asRecord(record.state ?? record.values)).map(([name, value]) => ({ name, value }));
  const stateValues: StateValue[] = values.map(item => {
    const entry = asRecord(item);
    return {
      name: cleanText(entry.name ?? entry.key, 80),
      value: Math.max(0, Math.min(100, Number(entry.value) || 0)),
    };
  }).filter(item => item.name);
  if (stateValues.length === 0) throw new Error("characters.state.write 需要 stateValues。");
  const session = ensureCharacterSession(characterId);
  const message = pushChatMessage({
    sessionId: session.id,
    role: "system",
    content: cleanText(record.content, 500) || `[${app.name}] 更新角色状态`,
    stateValues,
  });
  window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
  return { ok: true, messageId: message.id, stateValues };
}

export function readCustomAppCharacterRelations(record: Record<string, unknown>): Record<string, unknown> {
  const characterId = cleanText(record.characterId ?? record.id, 160);
  const characters = loadCharacters();
  const selected = characterId ? characters.find(item => item.id === characterId) ?? null : null;
  const identities = loadUserIdentities();
  const userIdentity = resolveUserIdentity(characterId) ?? identities[0] ?? null;
  if (selected) {
    return {
      character: {
        id: selected.id,
        name: selected.name,
        persona: selected.persona,
        personality: selected.personality,
        tags: selected.tags ?? [],
      },
      user: userIdentity ? serializeUserProfile(userIdentity) : null,
      stateValues: getLatestCharacterStateValues(selected.id),
      relationText: [selected.persona, selected.personality].filter(Boolean).join("\n"),
    };
  }
  return {
    characters: characters.map(character => ({
      id: character.id,
      name: character.name,
      tags: character.tags ?? [],
      stateValues: getLatestCharacterStateValues(character.id),
    })),
  };
}

export function suggestCustomAppMemory(app: InstalledCustomApp, record: Record<string, unknown>): CustomAppSuggestion {
  const characterId = cleanText(record.characterId, 160);
  const content = cleanText(record.content ?? record.text ?? record.suggestion, 3000);
  if (!characterId || !content) throw new Error("memory.suggest 需要 characterId 和 content。");
  return appendSuggestion(app, {
    kind: "memory",
    characterId,
    content,
    patch: {
      type: record.type === "core" ? "core" : "long_term",
      importance: Math.max(0, Math.min(1, Number(record.importance ?? 0.6) || 0.6)),
    },
    reason: cleanText(record.reason, 500) || undefined,
  });
}

export async function fetchCustomAppNetwork(app: InstalledCustomApp, record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rawUrl = cleanText(record.url ?? record.href, 2000);
  if (!rawUrl) throw new Error("network.fetch 缺少 url。");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("network.fetch 只允许 http/https URL。");
  }
  if (isBlockedNetworkHost(url.hostname)) {
    throw new Error("network.fetch 不允许访问本机或内网地址。");
  }
  const allowedDomains = app.manifest.network?.allowedDomains ?? [];
  if (!allowedDomains.length || !isAllowedNetworkUrl(url, allowedDomains)) {
    throw new Error(`network.fetch 未在 manifest.network.allowedDomains 声明域名：${url.hostname}`);
  }

  for (const [key, value] of Object.entries(asRecord(record.query ?? record.params))) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const method = cleanText(record.method, 12).toUpperCase() || "GET";
  if (!NETWORK_FETCH_METHODS.has(method)) {
    throw new Error(`network.fetch 不支持请求方法：${method}`);
  }
  const headers = sanitizeNetworkHeaders(record.headers);
  const rawBody = record.body ?? record.data;
  const body = method === "GET" || method === "HEAD" ? undefined : normalizeNetworkBody(rawBody);
  if (body !== undefined && rawBody && typeof rawBody === "object" && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  const useProxy = shouldProxyCustomAppNetworkFetch(app, record);
  const timeoutMs = optionalCustomAppTimeoutMs(
    record.timeoutMs,
    useProxy ? CUSTOM_APP_PROXY_TIMEOUT_MAX_MS : CUSTOM_APP_OPTIONAL_TIMEOUT_MAX_MS,
  );

  if (!useProxy) {
    return await withOptionalCustomAppTimeout(timeoutMs, "network.fetch", async signal => {
      try {
        const response = await fetch(url.toString(), {
          method,
          headers,
          body,
          credentials: "omit",
          signal,
        });
        return await serializeNetworkResponse(response);
      } catch (err) {
        throw new Error(
          `network.fetch 直连失败，可能是目标接口未开放 CORS 或被浏览器拦截。确实需要服务端代理时请传 proxy: true。原始错误：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  return await withOptionalCustomAppTimeout(timeoutMs, "network.fetch", async signal => {
    const response = await fetch("/api/tool-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        url: url.toString(),
        method,
        headers,
        body,
        timeoutMs,
      }),
    });
    return await serializeNetworkResponse(response);
  });
}

export function loadCustomAppTasks(appId?: string): CustomAppScheduledTask[] {
  const items = loadJsonArray<CustomAppScheduledTask>(CUSTOM_APP_TASKS_KEY);
  return appId ? items.filter(item => item.appId === appId) : items;
}

function normalizeHostActions(value: unknown, fieldName: string, required: true): CustomAppHostAction | CustomAppHostAction[];
function normalizeHostActions(value: unknown, fieldName: string, required?: false): CustomAppHostAction | CustomAppHostAction[] | undefined;
function normalizeHostActions(value: unknown, fieldName: string, required = false): CustomAppHostAction | CustomAppHostAction[] | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`tasks.schedule 缺少 ${fieldName}.type。`);
    return undefined;
  }
  const action = Array.isArray(value)
    ? value.map(item => ({ ...asRecord(item), type: cleanText(asRecord(item).type, 80) }))
    : { ...asRecord(value), type: cleanText(asRecord(value).type, 80) };
  const isEmpty = Array.isArray(action)
    ? action.length === 0 || action.some(item => !item.type)
    : !action.type;
  if (isEmpty) {
    if (required) throw new Error(`tasks.schedule 缺少 ${fieldName}.type。`);
    throw new Error(`tasks.schedule 的 ${fieldName} 缺少 type。`);
  }
  return action as CustomAppHostAction | CustomAppHostAction[];
}

function taskActionList(actions: CustomAppHostAction | CustomAppHostAction[] | undefined): CustomAppHostAction[] {
  if (!actions) return [];
  return Array.isArray(actions) ? actions : [actions];
}

export function scheduleCustomAppTask(app: InstalledCustomApp, input: Record<string, unknown>): CustomAppScheduledTask {
  const now = new Date().toISOString();
  const rawAction = input.action ?? input.actions ?? (input.type ? input : undefined);
  const action = normalizeHostActions(rawAction, "action", true);
  const onSuccess = normalizeHostActions(input.onSuccess ?? input.successActions, "onSuccess");
  const onFailure = normalizeHostActions(input.onFailure ?? input.failureActions ?? input.onError, "onFailure");
  const task: CustomAppScheduledTask = {
    id: cleanId(input.id, "task"),
    appId: app.id,
    runAt: parseRunAt(input.runAt, input.delayMs),
    status: "pending",
    action: action as CustomAppHostAction | CustomAppHostAction[],
    ...(onSuccess ? { onSuccess } : {}),
    ...(onFailure ? { onFailure } : {}),
    createdAt: now,
    updatedAt: now,
  };
  saveTasks([task, ...loadCustomAppTasks().filter(item => !(item.appId === task.appId && item.id === task.id))]);
  return task;
}

export function cancelCustomAppTask(appId: string, taskId: string): boolean {
  let changed = false;
  const now = new Date().toISOString();
  const next = loadCustomAppTasks().map(task => {
    if (task.appId !== appId || task.id !== taskId || task.status !== "pending") return task;
    changed = true;
    return { ...task, status: "canceled" as const, updatedAt: now };
  });
  if (changed) saveTasks(next);
  return changed;
}

function ensureCharacterSession(characterId: string) {
  const contacts = loadChatContacts();
  if (!contacts.some(contact => contact.characterId === characterId)) addChatContact(characterId);
  return createOrGetSession(characterId);
}

export function normalizeCustomAppCardData(app: InstalledCustomApp, record: Record<string, unknown>): NonNullable<ChatMessage["mediaData"]> {
  const card = asRecord(record.card ?? record.layout);
  const title = cleanText(record.title ?? card.title ?? app.name, 100);
  const body = cleanText(record.body ?? card.body ?? record.text, 2000);
  const summary = cleanText(record.summary ?? card.summary ?? body ?? title, 2000);
  const historyText = cleanUnboundedText(
    record.historyText
      ?? record.historyContent
      ?? record.promptText
      ?? record.content
      ?? record.message
      ?? summary,
  );
  const layout = Object.keys(card).length > 0 ? card : asRecord(record.layout);
  const appHistoryRole = normalizeOptionalHistoryRole(record.historyRole ?? record.appHistoryRole ?? record.promptRole);
  return {
    appId: app.id,
    appName: app.name,
    appCardTitle: title,
    appCardBody: body,
    appCardSummary: summary,
    appCardTone: cleanText(record.tone ?? card.tone, 40),
    appCardLayout: layout,
    appSceneId: cleanText(record.sceneId ?? record.scene, 80) || undefined,
    appSceneTag: cleanText(record.sceneTag, 120) || undefined,
    appTags: cleanStringArray(record.appTags ?? record.tags, 120, 30),
    appHistoryText: historyText || undefined,
    appHistoryRole,
  } as NonNullable<ChatMessage["mediaData"]>;
}

export function sendCustomAppCard(app: InstalledCustomApp, record: Record<string, unknown>): {
  sessionId: string;
  messageId: string;
  summary: string;
} {
  const characterId = cleanText(record.characterId, 160);
  if (!characterId) throw new Error("chat.sendCard 缺少 characterId。");
  const session = ensureCharacterSession(characterId);
  const mediaData = normalizeCustomAppCardData(app, record);
  const summary = cleanText(mediaData.appCardSummary ?? record.summary ?? record.body ?? record.title, 2000);
  const historyText = cleanUnboundedText(mediaData.appHistoryText ?? record.historyText ?? record.content ?? summary);
  const message = pushChatMessage({
    sessionId: session.id,
    role: normalizeHistoryRole(record.displayRole ?? record.role),
    content: historyText || summary,
    origin: normalizeCustomAppMessageOrigin(record.origin),
    mediaType: "app_card",
    mediaData,
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
  }
  return { sessionId: session.id, messageId: message.id, summary };
}

function findChatMessageByRecord(record: Record<string, unknown>): ChatMessage | null {
  const messageId = cleanText(record.messageId, 180);
  if (!messageId) return null;
  const sessionId = cleanText(record.sessionId, 180);
  if (sessionId) {
    return loadChatMessages(sessionId).find(message => message.id === messageId) ?? null;
  }
  for (const session of loadChatSessions()) {
    const message = loadChatMessages(session.id).find(item => item.id === messageId);
    if (message) return message;
  }
  return null;
}

function ownProp(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cleanCardActions(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.map(item => {
    const action = asRecord(item);
    const label = cleanText(action.label ?? action.text, 40);
    if (!label) return null;
    return {
      label,
      style: cleanText(action.style, 30),
      disabled: action.disabled === true || action.enabled === false,
    };
  }).filter(Boolean).slice(0, 3) as Array<Record<string, unknown>>;
  return actions;
}

export function updateCustomAppCard(app: InstalledCustomApp, record: Record<string, unknown>): {
  sessionId: string;
  messageId: string;
} {
  const message = findChatMessageByRecord(record);
  if (!message) throw new Error("chat.updateCard 找不到要更新的卡片。");
  if (message.mediaType !== "app_card" || message.mediaData?.appId !== app.id) {
    throw new Error("chat.updateCard 只能更新本 APP 的聊天卡片。");
  }

  const cardPatch = asRecord(record.card ?? record.layout);
  const currentLayout = asRecord(message.mediaData.appCardLayout);
  const nextLayout: Record<string, unknown> = { ...currentLayout, ...cardPatch };
  const directKeys = [
    "appLabel",
    "title",
    "subtitle",
    "body",
    "text",
    "html",
    "height",
    "cardHeight",
    "status",
    "image",
    "imageUrl",
    "accentColor",
    "background",
    "openDisabled",
    "clickDisabled",
    "clickable",
    "disabled",
    "sections",
    "rows",
    "rowsTitle",
  ];
  for (const key of directKeys) {
    if (ownProp(record, key)) nextLayout[key] = record[key];
  }
  const actions = cleanCardActions(cardPatch.actions ?? record.actions);
  if (actions) nextLayout.actions = actions;

  const title = ownProp(record, "title") ? cleanText(record.title, 100) : cleanText(cardPatch.title, 100);
  const body = ownProp(record, "body") || ownProp(record, "text")
    ? cleanText(record.body ?? record.text, 2000)
    : cleanText(cardPatch.body ?? cardPatch.text, 2000);
  const summary = ownProp(record, "summary") ? cleanText(record.summary, 2000) : cleanText(cardPatch.summary, 2000);
  const historyText = ownProp(record, "historyText") || ownProp(record, "historyContent") || ownProp(record, "promptText")
    ? cleanUnboundedText(record.historyText ?? record.historyContent ?? record.promptText)
    : "";

  const nextMediaData: NonNullable<ChatMessage["mediaData"]> = {
    ...message.mediaData,
    appCardLayout: nextLayout,
  };
  if (title) nextMediaData.appCardTitle = title;
  if (body) nextMediaData.appCardBody = body;
  if (summary) nextMediaData.appCardSummary = summary;
  if (historyText) nextMediaData.appHistoryText = historyText;

  const patch: Partial<Pick<ChatMessage, "content" | "mediaData">> = { mediaData: nextMediaData };
  if (historyText) patch.content = historyText;
  const updated = updateChatMessage(message.id, patch);
  if (!updated) throw new Error("chat.updateCard 更新失败。");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", {
      detail: { sessionId: message.sessionId, messageId: message.id },
    }));
  }
  return { sessionId: message.sessionId, messageId: message.id };
}

export function sendCustomAppTextMessage(app: InstalledCustomApp, record: Record<string, unknown>): {
  sessionId: string;
  messageId: string;
} {
  const characterId = cleanText(record.characterId, 160);
  const content = cleanUnboundedText(record.content ?? record.text ?? record.message);
  if (!characterId || !content) throw new Error("chat.sendMessage 需要 characterId 和 content。");
  const session = ensureCharacterSession(characterId);
  const message = pushChatMessage({
    sessionId: session.id,
    role: normalizeHistoryRole(record.role),
    content,
    origin: normalizeCustomAppMessageOrigin(record.origin),
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
  }
  return { sessionId: session.id, messageId: message.id };
}

export function writeCustomAppHistoryMessage(app: InstalledCustomApp, record: Record<string, unknown>): {
  sessionId: string;
  messageId: string;
  role: ChatMessage["role"];
  content: string;
} {
  const characterId = cleanText(record.characterId, 160);
  const content = cleanUnboundedText(record.content ?? record.historyText ?? record.text ?? record.message ?? record.summary);
  if (!characterId || !content) throw new Error("chat.history 需要 characterId 和 content。");
  const session = ensureCharacterSession(characterId);
  const role = normalizeHistoryRole(record.role);
  const message = pushChatMessage({
    sessionId: session.id,
    role,
    content,
    origin: normalizeCustomAppMessageOrigin(record.origin),
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
  }
  return { sessionId: session.id, messageId: message.id, role, content };
}

function findReadableSession(record: Record<string, unknown>): ChatSession | null {
  const sessionId = cleanText(record.sessionId, 160);
  const characterId = cleanText(record.characterId, 160);
  const sessions = loadChatSessions();
  if (sessionId) return sessions.find(session => session.id === sessionId) ?? null;
  if (characterId) return sessions.find(session => session.contactId === characterId && !session.isGroup) ?? null;
  return null;
}

export function readCustomAppChatHistory(record: Record<string, unknown>): {
  sessionId: string;
  characterId: string;
  isGroup: boolean;
  messages: Record<string, unknown>[];
} {
  const session = findReadableSession(record);
  if (!session) throw new Error("chat.readHistory 找不到会话。");
  const limit = Math.max(1, Math.min(200, Number(record.limit ?? 50) || 50));
  const before = cleanText(record.before, 80);
  let messages = loadChatMessages(session.id);
  if (before) {
    const index = messages.findIndex(message => message.id === before);
    if (index >= 0) messages = messages.slice(0, index);
  }
  return {
    sessionId: session.id,
    characterId: session.contactId,
    isGroup: session.isGroup === true,
    messages: messages.slice(-limit).map(serializeChatMessage),
  };
}

export async function requestCustomAppReply(app: InstalledCustomApp, record: Record<string, unknown>): Promise<{
  sessionId: string;
  messageIds: string[];
  text: string;
  requested: boolean;
  handled: boolean;
}> {
  const characterId = cleanText(record.characterId, 160);
  if (!characterId) throw new Error("chat.requestReply 缺少 characterId。");
  const session = ensureCharacterSession(characterId);
  const context = cleanUnboundedText(record.context ?? record.summary);
  if (context) {
    pushChatMessage({
      sessionId: session.id,
      role: "user",
      content: `[${app.name}] ${context}`,
      origin: normalizeCustomAppMessageOrigin(record.origin),
      status: "sent",
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    }
  }
  const detail: {
    source: "custom_app";
    appId: string;
    appName: string;
    sessionId: string;
    characterId: string;
    handled: boolean;
  } = {
    source: "custom_app",
    appId: app.id,
    appName: app.name,
    sessionId: session.id,
    characterId,
    handled: false,
  };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHAT_REQUEST_REPLY_EVENT, { detail }));
  }
  return { sessionId: session.id, messageIds: [], text: "", requested: true, handled: detail.handled };
}

export async function generateCustomAppText(app: InstalledCustomApp, record: Record<string, unknown>): Promise<{
  text: string;
  appendMessages: Record<string, unknown>[];
  messages: Record<string, unknown>[];
}> {
  const characterId = cleanText(record.characterId, 160);
  if (!characterId) throw new Error("ai.generate 缺少 characterId。");
  const enableTools = record.tools === true || record.enableTools === true;
  if (enableTools && !hasPermission(app, "chat.tools")) {
    throw new Error("应用未声明权限：chat.tools");
  }
  const toolsAllowed = hasPermission(app, "chat.tools");
  const session = ensureCharacterSession(characterId);
  const profile = resolvePromptProfile(app, record);
  const instruction = [
    cleanUnboundedText(record.instruction ?? record.context) || "请根据当前 APP 任务生成回复。",
    record.input && typeof record.input === "object" ? `\n\n输入：${JSON.stringify(record.input, null, 2)}` : "",
  ].join("").trim();
  const taskMessage: ChatMessage = {
    id: `custom-app-task-${Date.now()}`,
    sessionId: session.id,
    role: "user",
    content: `[${app.name}] ${instruction}`,
    status: "sent",
    createdAt: new Date().toISOString(),
  };
  const appProvidedHistory = normalizeCustomAppGenerateMessages(record, session.id);
  const existingHistory = appProvidedHistory ?? [];
  const recentLimit = Math.max(1, Math.min(50, Number(record.historyLimit ?? 12) || 12));
  const extraWorldBookIds = activeCustomAppWorldBookIds(app, record);
  const activeWorlds = readWorldActivations(app.id);
  const worldActivationContext = cleanUnboundedText(record.worldBookActivationContext ?? record.worldContext)
    || activeWorlds.map(item => item.context).filter(Boolean).join("\n");
  const activateAllWorldBooks = record.activateAllWorldBooks === true
    || record.activateWorldBooks === true
    || activeWorlds.some(item => item.activateAll);
  const history = [
    ...(profile?.history === "none"
      ? []
      : profile?.history === "recent"
        ? existingHistory.slice(-recentLimit)
        : existingHistory),
    taskMessage,
  ];
  const appTags = buildCustomAppChatTags(app, record);
  const appendMessages: ChatMessage[] = [];
  const pushContextMessage = (patch: Partial<ChatMessage> & Pick<ChatMessage, "role">): void => {
    appendMessages.push(createCustomAppGeneratedContextMessage(session.id, appendMessages.length, patch));
  };
  const completion = await generateChatCompletion(session, history, {
    appId: `custom_app:${app.id}`,
    appTags,
    promptProfile: profile ?? undefined,
    extraWorldBookIds,
    worldBookActivationContext: worldActivationContext || undefined,
    activateAllWorldBooks,
    toolsAllowed,
    forceEnableTools: enableTools,
  }, {
    onTextPart: (text, _senderInfo, options) => {
      const content = cleanUnboundedText(text);
      if (!content) return;
      pushContextMessage({
        role: "assistant",
        content,
        responseBatchId: options?.responseBatchId,
        rawResponseText: options?.rawResponseText,
      });
    },
    onToolAssistantTurn: (content, options) => {
      const text = cleanUnboundedText(content);
      if (!text) return;
      pushContextMessage({ role: "assistant", content: text, mediaType: "tool_call", responseBatchId: options?.responseBatchId });
    },
    onToolResult: (content) => {
      const text = cleanUnboundedText(content);
      if (!text) return;
      pushContextMessage({ role: "tool", content: text, mediaType: "tool_result" });
    },
    onNativeToolAssistantTurn: ({ content, rawContent, reasoning, openRouterReasoningDetails, toolCalls }) => {
      const visibleText = cleanUnboundedText(content);
      if (visibleText) {
        pushContextMessage({ role: "assistant", content: visibleText });
      }
      pushContextMessage({
        role: "assistant",
        content: "",
        rawResponseText: cleanUnboundedText(rawContent) || undefined,
        nativeToolCalls: toolCalls.map(call => ({
          id: call.id,
          name: call.name,
          args: asRecord(call.args),
          ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        })),
        nativeToolReasoning: reasoning,
        nativeToolOpenRouterReasoningDetails: openRouterReasoningDetails,
      });
    },
    onNativeToolResult: ({ toolCallId, name, content }) => {
      const text = cleanUnboundedText(content);
      if (!text) return;
      pushContextMessage({
        role: "tool",
        content: text,
        mediaType: "tool_result",
        nativeToolResult: { toolCallId, name, content: text },
      });
    },
  });
  const serializedMessages = appendMessages.map(serializeCustomAppContextMessage);
  return {
    text: flattenCompletionResult(completion),
    appendMessages: serializedMessages,
    messages: serializedMessages,
  };
}

export function isCustomAppGroupGenerateRecord(record: Record<string, unknown>): boolean {
  if (cleanStringArray(record.characterIds ?? record.participantIds, 160, 30).length > 0) return true;
  const sessionId = cleanText(record.sessionId ?? record.groupSessionId, 160);
  if (!sessionId) return false;
  return loadChatSessions().some(session => session.id === sessionId && session.isGroup === true);
}

// 多角色生成:和单聊 ai.generate 完全同构——宿主组装"多人资料包"(全部参演
// 角色的 <member> 人设块、用户身份、记忆等通用条目),内容条目只按 APP 自己的
// appTags 命中(不塞 "text"/"offline" 等宿主内置场景 tag,APP 拿不到内置 APP
// 的格式条目),单次补全返回原始文本,输出格式由 APP 的预设条目约定、APP 自行解析。
export async function generateCustomAppGroupText(app: InstalledCustomApp, record: Record<string, unknown>): Promise<{
  text: string;
  appendMessages: Record<string, unknown>[];
  messages: Record<string, unknown>[];
}> {
  if (record.tools === true || record.enableTools === true) {
    throw new Error("ai.generate 多角色模式暂不支持工具调用。");
  }
  const sessionId = cleanText(record.sessionId ?? record.groupSessionId, 160);
  const groupSession = sessionId
    ? loadChatSessions().find(item => item.id === sessionId && item.isGroup === true)
    : undefined;
  let session: ChatSession;
  let isPersistedGroup = false;
  if (groupSession) {
    session = groupSession;
    isPersistedGroup = true;
  } else {
    const characterIds = uniqueStrings(cleanStringArray(record.characterIds ?? record.participantIds, 160, 30));
    const chars = loadCharacters();
    const validIds = characterIds.filter(id => chars.some(char => char.id === id));
    if (validIds.length === 0) throw new Error("ai.generate 多角色模式需要有效的 characterIds 或群聊 sessionId。");
    session = {
      id: `custom_app_group_${app.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      contactId: `group_custom_app_${app.id}`,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
      isPinned: false,
      bilingualTranslationEnabled: false,
      isGroup: true,
      groupName: cleanText(record.groupName, 80) || app.name,
      participantIds: validIds,
    };
  }
  const profile = resolvePromptProfile(app, record);
  const instruction = [
    cleanUnboundedText(record.instruction ?? record.context) || "请根据当前 APP 任务生成回复。",
    record.input && typeof record.input === "object" ? `\n\n输入：${JSON.stringify(record.input, null, 2)}` : "",
  ].join("").trim();
  const taskMessage: ChatMessage = {
    id: `custom-app-task-${Date.now()}`,
    sessionId: session.id,
    role: "user",
    content: `[${app.name}] ${instruction}`,
    status: "sent",
    createdAt: new Date().toISOString(),
  };
  const recentLimit = Math.max(1, Math.min(50, Number(record.historyLimit ?? 12) || 12));
  const appProvidedHistory = normalizeCustomAppGenerateMessages(record, session.id);
  const existingHistory = appProvidedHistory ?? (isPersistedGroup ? loadChatMessages(session.id).slice(-recentLimit) : []);
  const history = [
    ...(profile?.history === "none"
      ? []
      : profile?.history === "recent"
        ? existingHistory.slice(-recentLimit)
        : existingHistory),
    taskMessage,
  ];
  // 纯 APP tags(与单聊路径一致):资料包结构化组装照进,宿主内置条目不命中
  const appTags = buildCustomAppChatTags(app, record);
  const completion = await generateGroupRawCompletion(session, history, {
    appTags,
    promptProfile: profile ?? undefined,
    apiConfigId: cleanText(record.apiConfigId ?? record.configId, 160) || undefined,
    appId: `custom_app:${app.id}`,
  });
  const text = cleanUnboundedText(completion.text);
  const serializedMessages = text
    ? [serializeCustomAppContextMessage(createCustomAppGeneratedContextMessage(session.id, 0, {
        role: "assistant",
        content: text,
      }))]
    : [];
  return {
    text,
    appendMessages: serializedMessages,
    messages: serializedMessages,
  };
}

export async function readCustomAppCoreMemory(record: Record<string, unknown>): Promise<{
  text: string;
  entries: Record<string, unknown>[];
}> {
  const characterId = cleanText(record.characterId, 160);
  if (!characterId) throw new Error("memory.readCore 缺少 characterId。");
  const entries = await retrieveCoreMemoriesForPrompt(characterId, loadMemoryConfig());
  return {
    text: formatCoreMemories(entries),
    entries: entries.map(serializeMemoryEntry),
  };
}

export async function readCustomAppLongTermMemory(record: Record<string, unknown>): Promise<{
  text: string;
  entries: Record<string, unknown>[];
}> {
  const characterId = cleanText(record.characterId, 160);
  if (!characterId) throw new Error("memory.readLongTerm 缺少 characterId。");
  const query = cleanText(record.query ?? record.context, 2000);
  const limit = Math.max(1, Math.min(200, Number(record.limit ?? 50) || 50));
  const entries = query
    ? await retrieveMemoriesForPrompt(characterId, query, loadMemoryConfig())
    : (await loadMemoryEntriesByType(characterId, "long_term"))
      .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))
      .slice(0, limit);
  return {
    text: formatLongTermMemories(entries),
    entries: entries.map(serializeMemoryEntry),
  };
}

export function readCustomAppShortTermMemory(app: InstalledCustomApp, record: Record<string, unknown>): {
  text: string;
  blocks: Record<string, unknown>[];
  items: Record<string, unknown>[];
} {
  const characterId = cleanText(record.characterId, 160);
  if (!characterId) throw new Error("memory.readShortTerm 缺少 characterId。");
  const limit = Math.max(1, Math.min(200, Number(record.limit ?? 50) || 50));
  const session = findReadableSession(record);
  const history = session ? loadChatMessages(session.id).slice(-limit) : [];
  const context = prepareShortTermContext(characterId, `custom_app:${app.id}`, { history });
  const items = context.unifiedRecentItems.slice(-limit).map(item => ({
    kind: item.kind,
    timestamp: item.timestamp,
    ...(item.kind === "event"
      ? { sourceApp: item.sourceApp, sourceTag: item.sourceTag, content: item.text }
      : { historyIndex: item.historyIndex }),
  }));
  return {
    text: context.recentBlocks.map(block => block.content).filter(Boolean).join("\n\n"),
    blocks: context.recentBlocks.map(block => ({ tag: block.tag, content: block.content })),
    items,
  };
}

export async function searchCustomAppMemory(record: Record<string, unknown>): Promise<{
  entries: Record<string, unknown>[];
}> {
  const characterId = cleanText(record.characterId, 160);
  const query = cleanText(record.query, 300);
  if (!characterId || !query) throw new Error("memory.search 需要 characterId 和 query。");
  const [core, longTerm] = await Promise.all([
    loadMemoryEntriesByType(characterId, "core"),
    loadMemoryEntriesByType(characterId, "long_term"),
  ]);
  const lower = query.toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(record.limit ?? 30) || 30));
  const entries = [...core, ...longTerm]
    .filter(entry => entry.content.toLowerCase().includes(lower))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))
    .slice(0, limit);
  return { entries: entries.map(serializeMemoryEntry) };
}

export async function addCustomAppMemory(app: InstalledCustomApp, record: Record<string, unknown>): Promise<boolean> {
  const characterId = cleanText(record.characterId, 160);
  const content = cleanText(record.content, 3000);
  if (!characterId || !content) throw new Error("memory.add 需要 characterId 和 content。");
  const now = new Date().toISOString();
  const importance = Math.max(0, Math.min(1, Number(record.importance ?? 0.6) || 0.6));
  await saveMemoryEntry({
    id: `custom_app_${app.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    characterId,
    sourceApp: "chat",
    type: record.type === "core" ? "core" : "long_term",
    content,
    importance,
    createdAt: now,
    updatedAt: now,
    metadata: {
      origin: "custom_app",
      appId: app.id,
      appName: app.name,
      reason: cleanText(record.reason, 300) || undefined,
    },
  });
  return true;
}

export function addCustomAppTimelineEvent(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> {
  const characterId = cleanText(record.characterId, 160);
  const summary = cleanText(record.summary ?? record.content ?? record.text, 2000);
  if (!characterId || !summary) throw new Error("memory.addTimeline 需要 characterId 和 summary。");
  const data = asRecord(record.data);
  const appEventId = cleanText(record.appEventId ?? record.eventId ?? record.relatedEventId ?? record.orderId ?? data.appEventId ?? data.eventId ?? data.relatedEventId ?? data.orderId, 160);
  if (appEventId) data.appEventId = appEventId;
  const entry = appendCustomAppTimelineEntry(app, {
    characterId,
    summary,
    detail: cleanText(record.detail ?? record.type, 120) || undefined,
    appLabel: cleanText(record.appLabel ?? record.label, 80) || undefined,
    createdAt: cleanText(record.createdAt ?? record.timestamp, 80) || undefined,
    data,
    appEventId,
  });
  return { ok: true, entry };
}

export function deleteCustomAppTimelineEvent(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> {
  return deleteCustomAppTimelineEntries(app.id, record);
}

export function setCustomAppChatContactState(record: Record<string, unknown>): { sessionId: string; isBlacklisted?: boolean; isMuted?: boolean } {
  const characterId = cleanText(record.characterId, 160);
  if (!characterId) throw new Error("chat.setContactState 缺少 characterId。");
  const session = ensureCharacterSession(characterId);
  const sessions = loadChatSessions();
  const next = sessions.map(item => item.id === session.id ? {
    ...item,
    ...(record.isBlacklisted !== undefined || record.blocked !== undefined ? { isBlacklisted: record.isBlacklisted === true || record.blocked === true } : {}),
    ...(record.isMuted !== undefined || record.muted !== undefined ? { isMuted: record.isMuted === true || record.muted === true } : {}),
  } : item);
  saveChatSessions(next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
  }
  const updated = next.find(item => item.id === session.id) ?? session;
  return { sessionId: session.id, isBlacklisted: updated.isBlacklisted, isMuted: updated.isMuted };
}

export function getWalletSnapshot(): Record<string, unknown> {
  const state = loadWalletState();
  return {
    balance: getWalletBalance(state),
    balanceLabel: formatWalletAmount(getWalletBalance(state)),
    totalBalance: getWalletTotalBalance(state),
    totalBalanceLabel: formatWalletAmount(getWalletTotalBalance(state)),
    defaultAccountId: state.defaultCardId || WALLET_BALANCE_ACCOUNT_ID,
    accounts: [
      { id: WALLET_BALANCE_ACCOUNT_ID, type: "balance", title: "余额", balance: state.balance, balanceLabel: formatWalletAmount(state.balance) },
      ...state.cards.map(card => ({
        id: card.id,
        type: "card",
        title: card.title,
        bankLabel: card.bankLabel,
        balance: card.balance,
        balanceLabel: formatWalletAmount(card.balance),
        isDefault: card.isDefault,
      })),
    ],
  };
}

export function payCustomAppWallet(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> {
  const amount = numberAmount(record.amount);
  const result = payWithWalletAccount({
    accountId: cleanText(record.accountId ?? record.cardId, 120) || WALLET_BALANCE_ACCOUNT_ID,
    amount,
    title: cleanText(record.title, 120) || app.name,
    detail: cleanText(record.detail ?? record.description, 400) || `来自「${app.name}」的付款`,
    category: cleanText(record.category, 80) || app.name,
    relatedOrderId: cleanText(record.relatedOrderId ?? record.orderId, 120) || undefined,
  });
  if (!result.ok) return { ok: false, error: result.error, wallet: getWalletSnapshot() };
  return {
    ok: true,
    transaction: result.transaction,
    wallet: getWalletSnapshot(),
  };
}

export function updateCustomAppDataRecord(app: InstalledCustomApp, record: Record<string, unknown>): Record<string, unknown> | null {
  const collection = collectionName(record.collection);
  const id = recordId(record.id);
  const patch = asRecord(record.patch ?? record.data);
  const rows = readCustomAppCollection(app.id, collection);
  let updated: Record<string, unknown> | null = null;
  writeCustomAppCollection(app.id, collection, rows.map(row => {
    if (String(row.id) !== id) return row;
    updated = { ...row, ...patch, id, updatedAt: nowIso() };
    return updated;
  }));
  return updated;
}

/* ---------- 现实桥（自定义 APP 出站通道） ---------- */

/** APP 向现实桥发件箱回传数据：iPhone 快捷指令的「检查回传」会取走并按信号名执行 */
export async function sendCustomAppBridgeOutbox(
  record: Record<string, unknown>,
): Promise<{ ok: true; id: string; type: string }> {
  const type = cleanText(record.type, 60);
  if (!type) throw new Error("bridge.send 缺少 type（信号名）。");
  const rawPayload = record.payload ?? record.text ?? record.data ?? "";
  const payload = typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload);
  const { config, ready } = bridgeConnection();
  if (!ready) throw new Error("现实桥云端存储未配置，无法回传。请先在现实桥 APP 里完成配置。");
  const entry = await appendBridgeOutbox(config, {
    type,
    payload: payload.replace(/\u0000/g, "").slice(0, 2000),
    source: "app",
  });
  return { ok: true, id: entry.id, type: entry.type };
}

/** APP 读取现实桥手机状态快照（bridge-state/<key>.json，由快捷指令自动化覆盖写入） */
export async function readCustomAppBridgeState(record: Record<string, unknown>): Promise<unknown> {
  const { config, ready } = bridgeConnection();
  if (!ready) throw new Error("现实桥云端存储未配置，无法读取。请先在现实桥 APP 里完成配置。");
  const key = sanitizeBridgeDataKey(cleanText(record.key, 40));
  if (key) {
    const snapshot = await readBridgeStateSnapshot(config, key);
    return snapshot ? { key, ...snapshot } : null;
  }
  const limit = Math.max(1, Math.min(12, Number(record.limit) || 12));
  return readAllBridgeStateSnapshots(config, limit);
}

export async function executeCustomAppHostAction(
  app: InstalledCustomApp,
  rawAction: CustomAppHostAction,
  onNotice?: HostNotice,
): Promise<unknown> {
  const action = { ...rawAction, payload: asRecord(rawAction.payload) };
  const actionType = cleanText(action.type, 80);
  requireHostActionPermission(app, actionType);
  await hydrateKvDb();
  if (customAppHostActionNeedsSettingsStorage(actionType)) {
    await ensureSettingsStorageHydrated();
  }
  if (customAppHostActionNeedsChatStorage(actionType)) {
    await hydrateChatStorage();
  }
  const payload = { ...action.payload, ...Object.fromEntries(Object.entries(action).filter(([key]) => key !== "payload" && key !== "type")) };
  switch (actionType) {
    case "notification":
    case "ui.notification":
      return createCustomAppNotification(app, payload, onNotice);
    case "db.update":
    case "app.data.update":
      return updateCustomAppDataRecord(app, payload);
    case "badge":
    case "notifications.badge":
      if (payload.delta !== undefined) return incrementCustomAppBadge(app.id, Number(payload.delta) || 0);
      return setCustomAppBadge(app.id, Number(payload.count ?? payload.badge) || 0);
    case "chat.card":
      return sendCustomAppCard(app, payload);
    case "chat.updateCard":
      return updateCustomAppCard(app, payload);
    case "chat.history":
    case "chat.message":
    case "chat.sendMessage":
      return writeCustomAppHistoryMessage(app, payload);
    case "chat.reply":
      return requestCustomAppReply(app, payload);
    case "memory.add":
      return addCustomAppMemory(app, payload);
    case "memory.timeline":
    case "memory.addTimeline":
      return addCustomAppTimelineEvent(app, payload);
    case "memory.deleteTimeline":
    case "memory.removeTimeline":
      return deleteCustomAppTimelineEvent(app, payload);
    case "memory.suggest":
      return suggestCustomAppMemory(app, payload);
    case "wallet.pay":
      return payCustomAppWallet(app, payload);
    case "chat.contact":
      return setCustomAppChatContactState(payload);
    case "calendar.write":
      return writeCustomAppCalendar(payload);
    case "world.write":
      return writeCustomAppWorld(app, payload);
    case "world.activate":
      return activateCustomAppWorld(app, payload);
    case "bridge.send":
      return sendCustomAppBridgeOutbox(payload);
    default:
      throw new Error(`未知后台动作：${actionType}`);
  }
}

function customAppHostActionNeedsChatStorage(actionType: string): boolean {
  return actionType === "chat.card"
    || actionType === "chat.updateCard"
    || actionType === "chat.history"
    || actionType === "chat.message"
    || actionType === "chat.sendMessage"
    || actionType === "chat.reply"
    || actionType === "chat.contact";
}

function customAppHostActionNeedsSettingsStorage(actionType: string): boolean {
  return actionType === "ai.generate"
    || actionType === "world.write"
    || actionType === "world.activate";
}

export async function runDueCustomAppTasks(onNotice?: HostNotice): Promise<number> {
  await hydrateKvDb();
  const now = Date.now();
  const apps = new Map(loadInstalledCustomApps().map(app => [app.id, app]));
  let tasks = loadCustomAppTasks();
  const due = tasks.filter(task => task.status === "pending" && new Date(task.runAt).getTime() <= now);
  if (due.length === 0) return 0;

  let executed = 0;
  for (const task of due) {
    const app = apps.get(task.appId);
    const startedAt = new Date().toISOString();
    tasks = tasks.map(item => item.id === task.id && item.appId === task.appId
      ? { ...item, status: "running" as const, updatedAt: startedAt }
      : item);
    saveTasks(tasks);
    try {
      if (!app) throw new Error("应用已卸载。");
      for (const action of taskActionList(task.action)) {
        await executeCustomAppHostAction(app, action, onNotice);
      }
      for (const action of taskActionList(task.onSuccess)) {
        await executeCustomAppHostAction(app, action, onNotice);
      }
      const finishedAt = new Date().toISOString();
      tasks = loadCustomAppTasks().map(item => item.id === task.id && item.appId === task.appId
        ? { ...item, status: "done" as const, updatedAt: finishedAt, lastError: undefined }
        : item);
      executed += 1;
    } catch (err) {
      const failedAt = new Date().toISOString();
      let message = err instanceof Error ? err.message : String(err);
      if (app) {
        try {
          for (const action of taskActionList(task.onFailure)) {
            await executeCustomAppHostAction(app, action, onNotice);
          }
        } catch (callbackErr) {
          const callbackMessage = callbackErr instanceof Error ? callbackErr.message : String(callbackErr);
          message = `${message}；失败回调也失败：${callbackMessage}`;
        }
      }
      tasks = loadCustomAppTasks().map(item => item.id === task.id && item.appId === task.appId
        ? { ...item, status: "failed" as const, updatedAt: failedAt, lastError: message }
        : item);
    }
    saveTasks(tasks);
  }
  return executed;
}
