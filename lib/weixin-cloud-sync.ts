import type { ChatMessage, ChatSession } from "./chat-storage";
import {
  createOrGetSession,
  CHAT_MESSAGES_DELETED_EVENT,
  CHAT_MESSAGE_PUSHED_EVENT,
  getLatestCharacterStateValues,
  hydrateChatStorage,
  loadChatAppSettings,
  loadChatContacts,
  loadChatMessages,
  loadChatSessions,
  reindexSessionMessageOrdersByTime,
  upsertImportedChatMessage,
} from "./chat-storage";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import {
  loadApiConfigs,
  loadBindingConfig,
  loadImageGenerationSettings,
  loadPresets,
  loadRegexes,
  loadVoiceConfigs,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
  ensureSettingsStorageHydrated,
} from "./settings-storage";
import type {
  ApiConfig,
  BindingSlot,
  PresetConfig,
  RegexConfig,
  VoiceApiConfig,
  WorldBookConfig,
} from "./settings-types";
import { loadMemoryConfig, loadMemoryEntries } from "./memory-storage";
import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext, type RecentBlock, type UnifiedRecentItem } from "./short-term-assembler";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import {
  appendEmptyGenerateGuardMessage,
  applyVisionImagePromptLimit,
  buildChatBilingualInstruction,
  buildMusicCloudMacro,
  buildMusicLocalMacro,
  buildOfflineBilingualInstruction,
} from "./chat-engine";
import { nativeToolProtocolForConfig } from "./llm-provider-adapter";
import { getEnabledTools } from "./tool-storage";
import { formatToolsForPrompt } from "./tool-prompt";
import { getCustomStickerExample, getCustomStickerNames, resolveCustomStickerMap } from "./custom-sticker-storage";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { isNeteaseConfigured } from "./music-service";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import {
  isCloudBackupConfigured,
  loadCloudBackupConfig,
  CLOUD_BACKUP_BUCKET,
  type CloudBackupConfig,
} from "./cloud-backup/config";
import { ensureBucket, getObject, listObjects, putObject, removeObject } from "./cloud-backup/storage-client";
import type { WeixinBotConfig } from "./weixin-storage";
import { loadWeixinBots } from "./weixin-storage";
import { parseAIResponse } from "./rich-message-parser";

const WEIXIN_CLOUD_CONFIG_KEY = "weixin_cloud_sync_config_v1";
const WEIXIN_CLOUD_PREFIX = "weixin-cloud";
const WEIXIN_CLOUD_INDEX_PATH = `${WEIXIN_CLOUD_PREFIX}/index.json`;
const WEIXIN_CLOUD_HISTORY_SLOT_TOKEN = "__AI_PHONE_WEIXIN_CLOUD_HISTORY_SLOT_V1__";
const WEIXIN_CLOUD_CHAT_APP_TAGS = ["chat", "text"];
const DEFAULT_MESSAGE_LIMIT = 80;
const REALTIME_PULL_INTERVAL_MS = 8000;
const LOCAL_UPLOAD_FLUSH_DELAY_MS = 500;

registerKvMigration(WEIXIN_CLOUD_CONFIG_KEY);

export type WeixinCloudSyncConfig = {
  enabled: boolean;
  lastSyncedAt?: string;
  lastRuntimePackagePath?: string;
};

export type WeixinCloudRuntimeSnapshot = {
  format: "ai-phone-weixin-runtime";
  version: 1;
  promptEngineVersion: 2;
  createdAt: string;
  source: {
    app: "ai-phone";
    appId: "chat";
    appTags: string[];
    promptBuilder: "buildChatPromptMessages";
    note: string;
  };
  bot: WeixinBotConfig;
  character: Character;
  session: ChatSession;
  messages: ChatMessage[];
  bindingSlot: BindingSlot;
  apiConfig: ApiConfig;
  voiceConfig: VoiceApiConfig | null;
  preset: PresetConfig | null;
  worldBooks: WorldBookConfig[];
  regexes: RegexConfig[];
  userIdentity: ReturnType<typeof resolveUserIdentity>;
  memoryConfig: MemoryConfig;
  memories: MemoryEntry[];
  chatAppSettings: ReturnType<typeof loadChatAppSettings>;
  promptContext: WeixinCloudPromptContext;
  stats: {
    messageCount: number;
    memoryCount: number;
    worldBookCount: number;
    regexGroupCount: number;
  };
};

export type WeixinCloudPromptContext = {
  appId: "chat";
  appTags?: string[];
  promptHistory: ChatMessage[];
  llmMessages: LLMMessage[];
  promptTemplate?: WeixinCloudPromptTemplate;
  recentBlocks: RecentBlock[];
  unifiedRecentItems: UnifiedRecentItem[];
  worldBookActivationContext: string;
  initialStateValues: ReturnType<typeof getLatestCharacterStateValues>;
  longTermMemories: string;
  coreMemories: string;
  scheduleSummary: string;
  currentSchedule: string;
  customStickerNames: string;
  customStickerExample: string;
  customStickerMap?: Record<string, string>;
  imageGeneration?: WeixinCloudImageGenerationContext;
  musicLocal: string;
  musicCloud: string;
  musicOnlineHint: string;
  tools: string;
  chatBilingualInstruction: string;
  offlineBilingualInstruction: string;
  offlineSummaryTag: string;
  enableVision: boolean;
  timeAware: boolean;
  nativeToolHistory: boolean;
};

export type WeixinCloudImageGenerationContext = {
  enabled: boolean;
  requestMode: "direct" | "server";
  apiKey: string;
  baseUrl: string;
  model: string;
  size: string;
  quality: string;
  extraPrompt: string;
  referenceImageDataUrl?: string;
  referenceUpdatedAt?: number;
};

export type WeixinCloudPromptTemplate = {
  version: 1;
  slotToken: string;
  beforeMessages: LLMMessage[];
  afterMessages: LLMMessage[];
  baseHistoryLength: number;
  createdAt: string;
};

export type WeixinCloudRuntimeIndexItem = {
  botId: string;
  characterId: string;
  characterName: string;
  sessionId: string;
  path: string;
  updatedAt: string;
  messageCount: number;
  memoryCount: number;
  bytes: number;
};

export type WeixinCloudRuntimeIndex = {
  format: "ai-phone-weixin-cloud-index";
  version: 1;
  updatedAt: string;
  packages: WeixinCloudRuntimeIndexItem[];
};

export type WeixinCloudSyncResult = {
  path: string;
  bytes: number;
  snapshot: WeixinCloudRuntimeSnapshot;
};

export type WeixinCloudStoredMessage = {
  format: "ai-phone-weixin-cloud-message";
  version: 1;
  direction: "inbound" | "outbound" | "local";
  botId: string;
  characterId: string;
  sessionId: string;
  externalId: string;
  localMessageId?: string;
  receivedAt?: string;
  createdAt?: string;
  role: "user" | "assistant" | "system";
  content: string;
  raw?: unknown;
  needsReply?: boolean;
  repliedAt?: string;
};

export type WeixinCloudMessagePullResult = {
  added: number;
  skipped: number;
  errors: string[];
  sessionIds: string[];
};

export type WeixinLocalAssistantConfig = {
  format: "ai-phone-weixin-local-assistant-config";
  version: 1;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseBucket: string;
  pollIntervalSeconds: number;
};

export function loadWeixinCloudSyncConfig(): WeixinCloudSyncConfig {
  if (typeof window === "undefined") return getDefaultWeixinCloudSyncConfig();
  try {
    const raw = kvGet(WEIXIN_CLOUD_CONFIG_KEY);
    if (!raw) return getDefaultWeixinCloudSyncConfig();
    const parsed = JSON.parse(raw) as Partial<WeixinCloudSyncConfig>;
    return {
      enabled: parsed.enabled === true,
      lastSyncedAt: typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : undefined,
      lastRuntimePackagePath: typeof parsed.lastRuntimePackagePath === "string" ? parsed.lastRuntimePackagePath : undefined,
    };
  } catch {
    return getDefaultWeixinCloudSyncConfig();
  }
}

export function saveWeixinCloudSyncConfig(config: WeixinCloudSyncConfig): void {
  if (typeof window === "undefined") return;
  kvSet(WEIXIN_CLOUD_CONFIG_KEY, JSON.stringify({
    enabled: config.enabled === true,
    lastSyncedAt: config.lastSyncedAt,
    lastRuntimePackagePath: config.lastRuntimePackagePath,
  }));
}

export function isWeixinCloudSupabaseReady(config: CloudBackupConfig = loadCloudBackupConfig()): boolean {
  return isCloudBackupConfigured(config);
}

export function buildWeixinLocalAssistantConfigCode(
  options?: { pollIntervalSeconds?: number },
): string {
  const cloudConfig = loadCloudBackupConfig();
  if (!isCloudBackupConfigured(cloudConfig)) {
    throw new Error("请先在数据管理里配置 Supabase 云端备份。");
  }
  const payload: WeixinLocalAssistantConfig = {
    format: "ai-phone-weixin-local-assistant-config",
    version: 1,
    supabaseUrl: cloudConfig.url,
    supabaseServiceRoleKey: cloudConfig.key,
    supabaseBucket: CLOUD_BACKUP_BUCKET,
    pollIntervalSeconds: clampLocalAssistantPollInterval(options?.pollIntervalSeconds),
  };
  return encodeConfigCode(JSON.stringify(payload));
}

export async function buildWeixinCloudRuntimeSnapshot(
  botId: string,
  options?: { messageLimit?: number },
): Promise<WeixinCloudRuntimeSnapshot> {
  await Promise.all([hydrateChatStorage(), ensureSettingsStorageHydrated()]);

  const bot = loadWeixinBots().find(item => item.id === botId);
  if (!bot) throw new Error("未找到微信 Bot 配置。");
  if (!bot.botToken?.trim()) throw new Error("该微信 Bot 缺少登录 token，请重新扫码。");

  const character = loadCharacters().find(item => item.id === bot.characterId);
  if (!character) throw new Error("该微信 Bot 绑定的角色不存在。");

  const session = createOrGetSession(character.id);
  const messageLimit = Math.max(10, Math.min(300, Math.floor(options?.messageLimit ?? DEFAULT_MESSAGE_LIMIT)));
  const messages = loadChatMessages(session.id, messageLimit).map(cloneMessageForCloud);

  const bindings = loadBindingConfig();
  const bindingSlot = resolveBinding(bindings, character.id, "chat");

  const apiConfig = bindingSlot.apiConfigId
    ? loadApiConfigs().find(item => item.id === bindingSlot.apiConfigId)
    : undefined;
  if (!apiConfig) throw new Error(`角色「${character.name}」没有绑定可用于聊天的 API 配置。`);

  const voiceConfig = bindingSlot.voiceConfigId
    ? loadVoiceConfigs().find(item => item.id === bindingSlot.voiceConfigId) ?? null
    : null;

  const presets = loadPresets();
  const preset = bindingSlot.presetId
    ? presets.find(item => item.id === bindingSlot.presetId) ?? presets.find(item => item.builtIn) ?? null
    : presets.find(item => item.builtIn) ?? null;

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (bindingSlot.worldBookIds || [])
    .map(id => allWorldBooks.find(item => item.id === id))
    .filter((item): item is WorldBookConfig => Boolean(item));

  const allRegexes = loadRegexes();
  const regexes = (bindingSlot.regexIds || [])
    .map(id => allRegexes.find(item => item.id === id))
    .filter((item): item is RegexConfig => Boolean(item));

  const memoryConfig = loadMemoryConfig();
  const memories = await loadMemoryEntries(character.id);
  const chatAppSettings = loadChatAppSettings();
  const promptContext = await buildWeixinCloudPromptContext({
    character,
    session,
    messages,
    apiConfig,
    preset,
    worldBooks,
    regexes,
    userIdentity: resolveUserIdentity(character.id, "chat"),
    memoryConfig,
    chatAppSettings,
  });

  return {
    format: "ai-phone-weixin-runtime",
    version: 1,
    promptEngineVersion: 2,
    createdAt: new Date().toISOString(),
    source: {
      app: "ai-phone",
      appId: "chat",
      appTags: ["chat", "text"],
      promptBuilder: "buildChatPromptMessages",
      note: "Cloud worker must reuse the same prompt assembly contract as the in-phone chat engine; this snapshot is only the data boundary.",
    },
    bot,
    character,
    session,
    messages,
    bindingSlot,
    apiConfig,
    voiceConfig,
    preset,
    worldBooks,
    regexes,
    userIdentity: resolveUserIdentity(character.id, "chat"),
    memoryConfig,
    memories,
    chatAppSettings,
    promptContext,
    stats: {
      messageCount: messages.length,
      memoryCount: memories.length,
      worldBookCount: worldBooks.length,
      regexGroupCount: regexes.length,
    },
  };
}

export function buildWeixinCloudPromptMessages(
  snapshot: WeixinCloudRuntimeSnapshot,
  options?: { history?: ChatMessage[]; skipEmptyGenerateGuard?: boolean },
): LLMMessage[] {
  const context = snapshot.promptContext;
  if (!context) {
    throw new Error("运行包缺少 promptContext，请先在小手机内重新同步运行包。");
  }
  const history = options?.history ?? context.promptHistory;
  const unifiedRecentItems = buildWeixinCloudUnifiedRecentItems(context, history);
  const messages = assemblePromptPayload({
    character: snapshot.character,
    history,
    preset: snapshot.preset,
    worldBooks: snapshot.worldBooks,
    regexes: snapshot.regexes,
    userIdentity: snapshot.userIdentity,
    appId: context.appId,
    appTags: context.appTags?.length ? context.appTags : snapshot.source?.appTags ?? WEIXIN_CLOUD_CHAT_APP_TAGS,
    initialStateValues: context.initialStateValues,
    scheduleSummary: context.scheduleSummary,
    currentSchedule: context.currentSchedule,
    coreMemories: context.coreMemories,
    longTermMemories: context.longTermMemories,
    worldBookActivationContext: buildWeixinCloudWorldBookActivationContext(context, history),
    recentBlocks: context.recentBlocks,
    unifiedRecentItems,
    customStickerNames: context.customStickerNames,
    customStickerExample: context.customStickerExample,
    musicLocal: context.musicLocal,
    musicCloud: context.musicCloud,
    musicOnlineHint: context.musicOnlineHint,
    enableVision: context.enableVision,
    timeAware: context.timeAware,
    tools: context.tools,
    chatBilingualInstruction: context.chatBilingualInstruction,
    offlineBilingualInstruction: context.offlineBilingualInstruction,
    offlineSummaryTag: context.offlineSummaryTag,
    nativeToolHistory: context.nativeToolHistory,
  });
  if (!options?.skipEmptyGenerateGuard) {
    appendEmptyGenerateGuardMessage(messages, snapshot.apiConfig, history);
  }
  return messages;
}

function buildWeixinCloudPromptTemplate(snapshot: WeixinCloudRuntimeSnapshot): WeixinCloudPromptTemplate {
  const context = snapshot.promptContext;
  const slotMessage: ChatMessage = {
    id: "weixin-cloud-history-slot",
    sessionId: snapshot.session.id,
    role: "system",
    content: WEIXIN_CLOUD_HISTORY_SLOT_TOKEN,
    status: "sent",
    createdAt: snapshot.createdAt,
  };
  const templateMessages = buildWeixinCloudPromptMessages(snapshot, {
    history: [...context.promptHistory, slotMessage],
    skipEmptyGenerateGuard: true,
  });
  const split = splitPromptMessagesAtHistorySlot(templateMessages);
  return {
    version: 1,
    slotToken: WEIXIN_CLOUD_HISTORY_SLOT_TOKEN,
    beforeMessages: split.beforeMessages,
    afterMessages: split.afterMessages,
    baseHistoryLength: context.promptHistory.length,
    createdAt: snapshot.createdAt,
  };
}

function splitPromptMessagesAtHistorySlot(messages: LLMMessage[]): { beforeMessages: LLMMessage[]; afterMessages: LLMMessage[] } {
  const beforeMessages: LLMMessage[] = [];
  const afterMessages: LLMMessage[] = [];
  let found = false;

  for (const message of messages) {
    if (found) {
      afterMessages.push(stripPromptMessageForCloud(message));
      continue;
    }

    if (typeof message.content !== "string" || !message.content.includes(WEIXIN_CLOUD_HISTORY_SLOT_TOKEN)) {
      beforeMessages.push(stripPromptMessageForCloud(message));
      continue;
    }

    const [beforeText, afterText] = splitTextAtFirstToken(message.content, WEIXIN_CLOUD_HISTORY_SLOT_TOKEN);
    if (beforeText.trim()) {
      beforeMessages.push(stripPromptMessageForCloud({ ...message, content: beforeText }));
    }
    if (afterText.trim()) {
      afterMessages.push(stripPromptMessageForCloud({ ...message, content: afterText }));
    }
    found = true;
  }

  if (!found) {
    throw new Error("生成微信本地助手运行包失败：未找到微信消息插入点。");
  }
  return { beforeMessages, afterMessages };
}

function splitTextAtFirstToken(text: string, token: string): [string, string] {
  const index = text.indexOf(token);
  if (index < 0) return [text, ""];
  return [text.slice(0, index), text.slice(index + token.length)];
}

function stripPromptMessageForCloud(message: LLMMessage): LLMMessage {
  const next: LLMMessage = {
    role: message.role,
    content: clonePromptContent(message.content),
  };
  if (message.reasoning) next.reasoning = message.reasoning;
  if (message.openRouterReasoningDetails) next.openRouterReasoningDetails = message.openRouterReasoningDetails;
  if (message.toolCalls?.length) next.toolCalls = message.toolCalls.map(call => ({
    id: call.id,
    name: call.name,
    args: { ...call.args },
    thoughtSignature: call.thoughtSignature,
  }));
  if (message.toolCallId) next.toolCallId = message.toolCallId;
  if (message.name) next.name = message.name;
  return next;
}

function clonePromptContent(content: LLMMessage["content"]): LLMMessage["content"] {
  if (typeof content === "string") return content;
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    return { type: "image_url", image_url: { ...part.image_url } };
  });
}

function buildWeixinCloudUnifiedRecentItems(
  context: WeixinCloudPromptContext,
  history: ChatMessage[],
): UnifiedRecentItem[] {
  const baseItems = Array.isArray(context.unifiedRecentItems) ? context.unifiedRecentItems : [];
  if (baseItems.length === 0) return [];

  const baseHistoryLength = Array.isArray(context.promptHistory) ? context.promptHistory.length : 0;
  if (history.length <= baseHistoryLength) return baseItems.map(item => ({ ...item }));

  const items = baseItems.map((item, index) => ({ item: { ...item }, index }));
  for (let historyIndex = baseHistoryLength; historyIndex < history.length; historyIndex += 1) {
    const msg = history[historyIndex];
    items.push({
      item: {
        kind: "history",
        timestamp: msg.createdAt || new Date().toISOString(),
        historyIndex,
      },
      index: items.length,
    });
  }

  return items
    .sort((a, b) => {
      const at = a.item.timestamp || "";
      const bt = b.item.timestamp || "";
      if (at !== bt) return at.localeCompare(bt);
      return a.index - b.index;
    })
    .map(entry => entry.item);
}

function buildWeixinCloudWorldBookActivationContext(
  context: WeixinCloudPromptContext,
  history: ChatMessage[],
): string {
  const recentHistory = history
    .slice(-10)
    .map(message => message.content)
    .filter(Boolean)
    .join("\n");
  if (!recentHistory.trim()) return context.worldBookActivationContext;
  return [context.worldBookActivationContext, recentHistory]
    .filter(value => value?.trim())
    .join("\n");
}

export async function syncWeixinBotRuntimeToCloud(
  botId: string,
  options?: { cloudConfig?: CloudBackupConfig; messageLimit?: number },
): Promise<WeixinCloudSyncResult> {
  const cloudConfig = options?.cloudConfig ?? loadCloudBackupConfig();
  if (!isCloudBackupConfigured(cloudConfig)) {
    throw new Error("请先在数据管理里配置 Supabase 云端备份。");
  }

  const snapshot = await buildWeixinCloudRuntimeSnapshot(botId, { messageLimit: options?.messageLimit });
  const path = runtimeSnapshotPath(snapshot.bot.id);
  const json = JSON.stringify(snapshot, null, 2);
  const bytes = new TextEncoder().encode(json).byteLength;

  await ensureBucket(cloudConfig);
  await putObject(cloudConfig, path, json, "application/json");
  await updateRuntimeIndex(cloudConfig, {
    botId: snapshot.bot.id,
    characterId: snapshot.character.id,
    characterName: snapshot.character.name,
    sessionId: snapshot.session.id,
    path,
    updatedAt: snapshot.createdAt,
    messageCount: snapshot.stats.messageCount,
    memoryCount: snapshot.stats.memoryCount,
    bytes,
  });

  const localConfig = loadWeixinCloudSyncConfig();
  saveWeixinCloudSyncConfig({
    ...localConfig,
    lastSyncedAt: snapshot.createdAt,
    lastRuntimePackagePath: path,
  });

  return { path, bytes, snapshot };
}

async function buildWeixinCloudPromptContext(params: {
  character: Character;
  session: ChatSession;
  messages: ChatMessage[];
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  worldBooks: WorldBookConfig[];
  regexes: RegexConfig[];
  userIdentity: ReturnType<typeof resolveUserIdentity>;
  memoryConfig: MemoryConfig;
  chatAppSettings: ReturnType<typeof loadChatAppSettings>;
}): Promise<WeixinCloudPromptContext> {
  const appId = "chat" as const;
  const enabledTools = getEnabledTools(appId);
  const usesNativeActions = Boolean(nativeToolProtocolForConfig(params.apiConfig) && enabledTools.length > 0);
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(
    params.character.id,
    appId,
    {
      history: params.messages,
      includeNativeToolHistory: usesNativeActions,
      timeAware: params.chatAppSettings.timeAware,
    },
  );
  const promptHistory = applyVisionImagePromptLimit(
    truncatedHistory.map(msg => cloneMessageForCloud(msg)),
    params.session.visionImagePromptLimit,
  );

  const [memResults, coreResults, musicLocal, musicCloud, customStickerMap, imageGeneration] = await Promise.all([
    retrieveMemoriesForPrompt(params.character.id, wbActivationContext, params.memoryConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(params.character.id, params.memoryConfig).catch(() => null),
    buildMusicLocalMacro(),
    buildMusicCloudMacro(),
    resolveCustomStickerMap(params.character.id).catch(() => ({} as Record<string, string>)),
    buildWeixinCloudImageGenerationContext(params.character.id).catch(() => undefined),
  ]);

  const now = new Date();
  const toolsPrompt = usesNativeActions
    ? "<available_actions>\n需要动作时，可展开对应类别的动作说明；已有具体动作说明时，直接调用具体动作。\n</available_actions>"
    : formatToolsForPrompt(enabledTools);

  const promptContext: WeixinCloudPromptContext = {
    appId,
    appTags: WEIXIN_CLOUD_CHAT_APP_TAGS,
    promptHistory,
    llmMessages: [],
    recentBlocks,
    unifiedRecentItems,
    worldBookActivationContext: wbActivationContext,
    initialStateValues: getLatestCharacterStateValues(params.character.id),
    longTermMemories: memResults ? formatLongTermMemories(memResults) : "",
    coreMemories: coreResults ? formatCoreMemories(coreResults) : "",
    scheduleSummary: buildCalendarScheduleMarker("character", params.character.id, getWeekStartIso(now)),
    currentSchedule: getCurrentCalendarScheduleForPrompt("character", params.character.id, now),
    customStickerNames: getCustomStickerNames(params.character.id),
    customStickerExample: getCustomStickerExample(params.character.id),
    customStickerMap,
    imageGeneration,
    musicLocal,
    musicCloud,
    musicOnlineHint: isNeteaseConfigured()
      ? "- 你可以推荐任何歌曲，系统会在线搜索并播放。不局限于用户本地音乐库。\n"
      : "\n",
    tools: toolsPrompt,
    chatBilingualInstruction: params.session.isGroup
      ? ""
      : buildChatBilingualInstruction(
        params.session.bilingualTranslationEnabled !== false,
        "single",
        params.session.bilingualTranslationPrompt,
      ),
    offlineBilingualInstruction: params.session.isGroup
      ? ""
      : buildOfflineBilingualInstruction(
        params.session.bilingualTranslationEnabled !== false,
        "single",
        params.session.offlineBilingualTranslationPrompt,
      ),
    offlineSummaryTag: params.preset?.story_summary_tag?.trim() || "summary",
    enableVision: params.apiConfig.enableImageRecognition === true,
    timeAware: params.chatAppSettings.timeAware !== false,
    nativeToolHistory: usesNativeActions,
  };
  const shellCreatedAt = new Date().toISOString();
  const shellSnapshot: WeixinCloudRuntimeSnapshot = {
    format: "ai-phone-weixin-runtime",
    version: 1,
    promptEngineVersion: 2,
    createdAt: shellCreatedAt,
    source: {
      app: "ai-phone",
      appId: "chat",
      appTags: ["chat", "text"],
      promptBuilder: "buildChatPromptMessages",
      note: "temporary prompt context build shell",
    },
    bot: {} as WeixinBotConfig,
    character: params.character,
    session: params.session,
    messages: params.messages,
    bindingSlot: {} as BindingSlot,
    apiConfig: params.apiConfig,
    voiceConfig: null,
    preset: params.preset,
    worldBooks: params.worldBooks,
    regexes: params.regexes,
    userIdentity: params.userIdentity,
    memoryConfig: params.memoryConfig,
    memories: [],
    chatAppSettings: params.chatAppSettings,
    promptContext,
    stats: { messageCount: params.messages.length, memoryCount: 0, worldBookCount: 0, regexGroupCount: 0 },
  };
  promptContext.llmMessages = buildWeixinCloudPromptMessages(shellSnapshot);
  promptContext.promptTemplate = buildWeixinCloudPromptTemplate(shellSnapshot);
  return promptContext;
}

async function buildWeixinCloudImageGenerationContext(characterId: string): Promise<WeixinCloudImageGenerationContext> {
  const settings = loadImageGenerationSettings();
  const reference = settings.characterReferences?.[characterId];
  const referenceImageDataUrl = reference?.assetId
    ? await getChatImageFromIndexedDB(reference.assetId).catch(() => null)
    : null;
  const normalizedReferenceImageDataUrl = referenceImageDataUrl
    ? await normalizeWeixinCloudReferenceImageForEdit(referenceImageDataUrl)
    : null;

  return {
    enabled: settings.enabled === true,
    requestMode: settings.requestMode,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    size: settings.size,
    quality: settings.quality,
    extraPrompt: settings.extraPrompt,
    ...(normalizedReferenceImageDataUrl ? { referenceImageDataUrl: normalizedReferenceImageDataUrl } : {}),
    ...(reference?.updatedAt ? { referenceUpdatedAt: reference.updatedAt } : {}),
  };
}

async function normalizeWeixinCloudReferenceImageForEdit(dataUrl: string): Promise<string> {
  if (/^data:image\/png[;,]/i.test(dataUrl)) return dataUrl;
  if (typeof document === "undefined" || typeof Image === "undefined") return dataUrl;

  try {
    const image = await loadWeixinCloudDataUrlImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return dataUrl;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}

function loadWeixinCloudDataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("参考图解码失败"));
    image.src = dataUrl;
  });
}

export async function syncAllWeixinBotRuntimesToCloud(
  options?: { cloudConfig?: CloudBackupConfig; messageLimit?: number },
): Promise<WeixinCloudSyncResult[]> {
  const bots = getActiveWeixinCloudBots();
  if (bots.length === 0) return [];
  const results: WeixinCloudSyncResult[] = [];
  for (const bot of bots) {
    results.push(await syncWeixinBotRuntimeToCloud(bot.id, options));
  }
  return results;
}

export async function pullWeixinCloudMessagesFromCloud(
  options?: { cloudConfig?: CloudBackupConfig; botId?: string; limitPerBot?: number },
): Promise<WeixinCloudMessagePullResult> {
  await hydrateChatStorage();
  const cloudConfig = options?.cloudConfig ?? loadCloudBackupConfig();
  if (!isCloudBackupConfigured(cloudConfig)) {
    throw new Error("请先在数据管理里配置 Supabase 云端备份。");
  }

  const index = await loadRuntimeIndex(cloudConfig);
  const targets = options?.botId
    ? index.packages.filter(item => item.botId === options.botId)
    : index.packages;

  const result: WeixinCloudMessagePullResult = { added: 0, skipped: 0, errors: [], sessionIds: [] };
  const touchedSessionIds = new Set<string>();
  const limit = Math.max(1, Math.min(500, Math.floor(options?.limitPerBot ?? 100)));

  for (const target of targets) {
    const prefix = `${WEIXIN_CLOUD_PREFIX}/messages/${sanitizePathPart(target.botId)}/`;
    let objects;
    try {
      objects = await listObjects(cloudConfig, prefix, limit);
    } catch (err) {
      result.errors.push(`${target.characterName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const storedMessages: WeixinCloudStoredMessage[] = [];
    for (const object of objects) {
      if (!object.name || object.name.endsWith("/")) continue;
      const path = `${prefix}${object.name}`;
      try {
        const blob = await getObject(cloudConfig, path);
        if (!blob) {
          result.skipped += 1;
          continue;
        }
        const stored = JSON.parse(await blob.text()) as WeixinCloudStoredMessage;
        if (
          isCloudStoredMessage(stored)
          && stored.botId === target.botId
          && stored.characterId === target.characterId
        ) {
          if (isLocalUploadedCloudMessage(stored)) {
            result.skipped += 1;
            continue;
          }
          storedMessages.push(stored);
        } else {
          result.skipped += 1;
        }
      } catch (err) {
        result.errors.push(`${object.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    storedMessages
      .sort((a, b) => cloudStoredMessageTime(a).localeCompare(cloudStoredMessageTime(b)))
      .forEach((stored) => {
        const imported = importCloudStoredMessage(stored);
        if (imported.inserted) {
          result.added += 1;
          touchedSessionIds.add(imported.sessionId);
        } else {
          result.skipped += 1;
        }
      });
  }

  for (const sessionId of touchedSessionIds) {
    reindexSessionMessageOrdersByTime(sessionId);
  }
  result.sessionIds = Array.from(touchedSessionIds);
  return result;
}

export function startWeixinCloudRealtimeSync(): () => void {
  if (typeof window === "undefined") return () => {};

  let stopped = false;
  let pullInFlight = false;
  let uploadInFlight = false;
  let lastPullAt = 0;
  let uploadFlushTimer: number | null = null;
  const uploadQueue = new Map<string, ChatMessage>();
  const deletedLocalMessageIds = new Set<string>();

  const shouldRun = () => {
    const config = loadWeixinCloudSyncConfig();
    return config.enabled === true && isWeixinCloudSupabaseReady();
  };

  const dispatchPulledSessions = (sessionIds: string[]) => {
    for (const sessionId of sessionIds) {
      window.dispatchEvent(new CustomEvent("weixin-messages-updated", { detail: { sessionId } }));
      window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
    }
    if (sessionIds.length > 0) {
      window.dispatchEvent(new CustomEvent("weixin-cloud-messages-pulled", { detail: { sessionIds } }));
    }
  };

  const pullNow = async (force = false) => {
    if (stopped || pullInFlight || !shouldRun()) return;
    if (!force && document.visibilityState !== "visible") return;
    const now = Date.now();
    if (!force && now - lastPullAt < REALTIME_PULL_INTERVAL_MS - 500) return;
    pullInFlight = true;
    lastPullAt = now;
    try {
      const result = await pullWeixinCloudMessagesFromCloud({ limitPerBot: 200 });
      if (result.added > 0) dispatchPulledSessions(result.sessionIds);
      if (result.errors.length > 0) {
        console.warn("[WeixinCloudSync] pull errors:", result.errors);
      }
    } catch (err) {
      console.warn("[WeixinCloudSync] auto pull failed:", err);
    } finally {
      pullInFlight = false;
    }
  };

  const flushUploads = async () => {
    if (stopped || uploadInFlight || uploadQueue.size === 0) return;
    if (!shouldRun()) {
      uploadQueue.clear();
      return;
    }
    uploadInFlight = true;
    const items = Array.from(uploadQueue.values());
    uploadQueue.clear();
    try {
      for (const message of items) {
        if (deletedLocalMessageIds.has(message.id)) continue;
        await syncLocalWeixinCloudMessageToCloud(message);
      }
    } catch (err) {
      console.warn("[WeixinCloudSync] local upload failed:", err);
    } finally {
      uploadInFlight = false;
      if (uploadQueue.size > 0) scheduleUploadFlush();
    }
  };

  const scheduleUploadFlush = () => {
    if (uploadFlushTimer) return;
    uploadFlushTimer = window.setTimeout(() => {
      uploadFlushTimer = null;
      void flushUploads();
    }, LOCAL_UPLOAD_FLUSH_DELAY_MS);
  };

  const onMessagePushed = (event: Event) => {
    const message = (event as CustomEvent).detail?.message as ChatMessage | undefined;
    if (!message || !shouldUploadLocalWeixinMessage(message)) return;
    uploadQueue.set(message.id, message);
    scheduleUploadFlush();
  };

  const onMessagesDeleted = (event: Event) => {
    const messages = (event as CustomEvent).detail?.messages as ChatMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) return;
    for (const message of messages) {
      uploadQueue.delete(message.id);
      deletedLocalMessageIds.add(message.id);
    }
    void deleteWeixinCloudMessagesFromCloud(messages).catch((err) => {
      console.warn("[WeixinCloudSync] cloud delete failed:", err);
    });
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") void pullNow(true);
  };

  const onFocus = () => {
    void pullNow(true);
  };

  const onConfigChanged = () => {
    if (shouldRun()) void pullNow(true);
  };

  window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, onMessagePushed);
  window.addEventListener(CHAT_MESSAGES_DELETED_EVENT, onMessagesDeleted);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("weixin-config-changed", onConfigChanged);

  const interval = window.setInterval(() => {
    void pullNow(false);
  }, REALTIME_PULL_INTERVAL_MS);
  void pullNow(true);

  return () => {
    stopped = true;
    window.clearInterval(interval);
    if (uploadFlushTimer) window.clearTimeout(uploadFlushTimer);
    window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, onMessagePushed);
    window.removeEventListener(CHAT_MESSAGES_DELETED_EVENT, onMessagesDeleted);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("weixin-config-changed", onConfigChanged);
    uploadQueue.clear();
  };
}

export async function syncLocalWeixinCloudMessageToCloud(message: ChatMessage): Promise<boolean> {
  if (!shouldUploadLocalWeixinMessage(message)) return false;
  const localConfig = loadWeixinCloudSyncConfig();
  if (localConfig.enabled !== true) return false;
  const cloudConfig = loadCloudBackupConfig();
  if (!isCloudBackupConfigured(cloudConfig)) return false;

  const target = resolveWeixinCloudMessageTarget(message);
  if (!target) return false;

  const content = message.content.trim();
  if (!content) return false;

  const externalId = `local_${message.id}`;
  const payload: WeixinCloudStoredMessage = {
    format: "ai-phone-weixin-cloud-message",
    version: 1,
    direction: message.role === "assistant" ? "outbound" : "local",
    botId: target.bot.id,
    characterId: target.characterId,
    sessionId: target.session.id,
    externalId,
    localMessageId: message.id,
    createdAt: message.createdAt,
    role: message.role === "assistant" ? "assistant" : "user",
    content,
    needsReply: false,
  };

  await putObject(
    cloudConfig,
    weixinCloudMessagePath(target.bot.id, externalId),
    JSON.stringify(payload, null, 2),
    "application/json",
  );
  return true;
}

export async function deleteWeixinCloudMessagesFromCloud(messages: ChatMessage[]): Promise<number> {
  const cloudConfig = loadCloudBackupConfig();
  if (!isCloudBackupConfigured(cloudConfig)) return 0;

  const paths = new Set<string>();
  for (const message of messages) {
    const sync = message.cloudSync;
    if (sync?.source === "weixin-cloud" && sync.botId && sync.externalId) {
      paths.add(weixinCloudMessagePath(sync.botId, sync.externalId));
      continue;
    }
    if (!shouldUploadLocalWeixinMessage(message)) continue;
    const target = resolveWeixinCloudMessageTarget(message);
    if (!target) continue;
    paths.add(weixinCloudMessagePath(target.bot.id, `local_${message.id}`));
  }

  let deleted = 0;
  for (const path of paths) {
    await removeObject(cloudConfig, path);
    deleted += 1;
  }
  return deleted;
}

function shouldUploadLocalWeixinMessage(message: ChatMessage): boolean {
  if (message.cloudSync?.source === "weixin-cloud") return false;
  if (message.status === "failed" || message.status === "sending") return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (message.origin && message.origin !== "chat") return false;
  if (!message.content.trim()) return false;
  if (message.mediaType === "tool_notice" || message.mediaType === "tool_call" || message.mediaType === "tool_result" || message.mediaType === "memory_write_request") return false;
  if (message.nativeToolCalls?.length || message.nativeToolResult) return false;
  return Boolean(resolveWeixinCloudMessageTarget(message));
}

function resolveWeixinCloudMessageTarget(message: ChatMessage): { bot: WeixinBotConfig; session: ChatSession; characterId: string } | null {
  const session = loadChatSessions().find(item => item.id === message.sessionId);
  if (!session || session.isGroup) return null;

  const contact = loadChatContacts().find(item => item.id === session.contactId);
  const characterId = contact?.characterId || session.contactId;
  const bot = loadWeixinBots().find(item => item.enabled && item.botToken.trim() && item.characterId === characterId);
  if (!bot) return null;
  return { bot, session, characterId };
}

function weixinCloudMessagePath(botId: string, externalId: string): string {
  return `${WEIXIN_CLOUD_PREFIX}/messages/${sanitizePathPart(botId)}/${sanitizePathPart(externalId)}.json`;
}

function getDefaultWeixinCloudSyncConfig(): WeixinCloudSyncConfig {
  return { enabled: false };
}

function clampLocalAssistantPollInterval(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 5;
  return Math.min(60, Math.max(3, n));
}

function encodeConfigCode(json: string): string {
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf8").toString("base64url");
  }
  throw new Error("当前环境不支持生成配置码。");
}

function runtimeSnapshotPath(botId: string): string {
  return `${WEIXIN_CLOUD_PREFIX}/runtime/${sanitizePathPart(botId)}.json`;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function importCloudStoredMessage(stored: WeixinCloudStoredMessage): { inserted: boolean; sessionId: string } {
  if (!isCloudStoredMessage(stored)) return { inserted: false, sessionId: "" };
  if (isLocalUploadedCloudMessage(stored)) return { inserted: false, sessionId: "" };
  const session = createOrGetSession(stored.characterId);
  if (stored.localMessageId && loadChatMessages(session.id).some(message => message.id === stored.localMessageId)) {
    return { inserted: false, sessionId: session.id };
  }
  const createdAt = stored.receivedAt || stored.createdAt || new Date().toISOString();
  if (stored.role === "assistant" && stored.direction === "outbound") {
    return importCloudAssistantMessage(stored, session, createdAt);
  }
  const id = cloudMessageId(stored);
  const msg: ChatMessage = {
    id,
    sessionId: session.id,
    role: stored.role,
    content: stored.content,
    status: "sent",
    createdAt,
    cloudSync: {
      source: "weixin-cloud",
      botId: stored.botId,
      externalId: stored.externalId,
      direction: stored.direction,
      syncedAt: new Date().toISOString(),
    },
  };
  return { inserted: upsertImportedChatMessage(msg).inserted, sessionId: session.id };
}

function importCloudAssistantMessage(
  stored: WeixinCloudStoredMessage,
  session: ChatSession,
  createdAt: string,
): { inserted: boolean; sessionId: string } {
  const existing = loadChatMessages(session.id).some(message =>
    message.cloudSync?.source === "weixin-cloud"
    && message.cloudSync.botId === stored.botId
    && message.cloudSync.externalId === stored.externalId
  );
  if (existing) return { inserted: false, sessionId: session.id };

  const characterName = loadCharacters().find(item => item.id === stored.characterId)?.name || "对方";
  const parsed = parseAIResponse(stored.content, getLatestCharacterStateValues(stored.characterId));
  const visibleParts = parsed.parts.filter(part =>
    part.mediaType !== "voice_call"
    && part.mediaType !== "video_call"
    && part.mediaType !== "accept_red_packet"
    && part.mediaType !== "decline_red_packet"
    && part.mediaType !== "accept_transfer"
    && part.mediaType !== "decline_transfer"
    && part.mediaType !== "accept_payment_request"
    && part.mediaType !== "decline_payment_request"
  );

  const messages: ChatMessage[] = [];
  visibleParts.forEach((part, index) => {
    if (part.mediaType === "poke") {
      const pokeSender = (part.mediaData?.pokeSender === "我" ? characterName : part.mediaData?.pokeSender) || characterName;
      const pokeTarget = part.mediaData?.pokeTarget || "你";
      messages.push(makeCloudImportedMessage(stored, session.id, createdAt, index, {
        role: "system",
        content: `${pokeSender} 拍了拍 ${pokeTarget}`,
        mediaType: "poke",
        mediaData: { pokeSender, pokeTarget },
      }));
      return;
    }
    messages.push(makeCloudImportedMessage(stored, session.id, createdAt, index, {
      role: "assistant",
      content: part.content,
      mediaType: part.mediaType,
      mediaData: part.mediaData,
      statusPanel: index === 0 && parsed.statusPanel ? parsed.statusPanel : undefined,
      innerMonologue: index === 0 && parsed.innerMonologue ? parsed.innerMonologue : undefined,
      stateValues: index === 0 && parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
      freshStateValues: index === 0 ? parsed.freshStateValues : undefined,
    }));
  });

  if (messages.length === 0 && (parsed.statusPanel || parsed.innerMonologue || parsed.stateValues.length > 0)) {
    messages.push(makeCloudImportedMessage(stored, session.id, createdAt, 0, {
      role: "assistant",
      content: "",
      statusPanel: parsed.statusPanel || undefined,
      innerMonologue: parsed.innerMonologue || undefined,
      stateValues: parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
      freshStateValues: parsed.freshStateValues,
    }));
  }
  if (messages.length === 0) {
    messages.push(makeCloudImportedMessage(stored, session.id, createdAt, 0, {
      role: "assistant",
      content: stored.content,
    }));
  }

  let inserted = false;
  for (const message of messages) {
    if (upsertImportedChatMessage(message).inserted) inserted = true;
  }
  return { inserted, sessionId: session.id };
}

function makeCloudImportedMessage(
  stored: WeixinCloudStoredMessage,
  sessionId: string,
  createdAt: string,
  index: number,
  patch: Partial<ChatMessage> & Pick<ChatMessage, "role" | "content">,
): ChatMessage {
  const baseTime = new Date(createdAt).getTime();
  const safeTime = Number.isFinite(baseTime) ? baseTime : Date.now();
  return {
    id: `${cloudMessageId(stored)}_${index}`,
    sessionId,
    status: "sent",
    createdAt: new Date(safeTime + index).toISOString(),
    ...patch,
    cloudSync: {
      source: "weixin-cloud",
      botId: stored.botId,
      externalId: stored.externalId,
      direction: stored.direction,
      syncedAt: new Date().toISOString(),
    },
  };
}

function cloudMessageId(stored: WeixinCloudStoredMessage): string {
  return `wxcloud_${sanitizePathPart(stored.botId)}_${sanitizePathPart(stored.externalId)}`;
}

function cloudStoredMessageTime(stored: WeixinCloudStoredMessage): string {
  return stored.receivedAt || stored.createdAt || "";
}

function isCloudStoredMessage(value: unknown): value is WeixinCloudStoredMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WeixinCloudStoredMessage>;
  return Boolean(
    item.format === "ai-phone-weixin-cloud-message"
    && item.version === 1
    && (item.direction === "inbound" || item.direction === "outbound" || item.direction === "local")
    && typeof item.botId === "string"
    && typeof item.characterId === "string"
    && typeof item.sessionId === "string"
    && typeof item.externalId === "string"
    && (item.role === "user" || item.role === "assistant" || item.role === "system")
    && typeof item.content === "string"
  );
}

function isLocalUploadedCloudMessage(stored: WeixinCloudStoredMessage): boolean {
  return stored.direction === "local"
    || Boolean(stored.localMessageId)
    || stored.externalId.startsWith("local_");
}

function cloneMessageForCloud(message: ChatMessage): ChatMessage {
  const cloned: ChatMessage = JSON.parse(JSON.stringify(message)) as ChatMessage;
  if (typeof cloned.mediaUrl === "string" && cloned.mediaUrl.startsWith("data:")) {
    cloned.mediaUrl = undefined;
    cloned.mediaData = {
      ...(cloned.mediaData || {}),
      label: cloned.mediaData?.label || "本地媒体未上传到云端",
    };
  }
  return cloned;
}

async function loadRuntimeIndex(config: CloudBackupConfig): Promise<WeixinCloudRuntimeIndex> {
  const fallback: WeixinCloudRuntimeIndex = {
    format: "ai-phone-weixin-cloud-index",
    version: 1,
    updatedAt: new Date(0).toISOString(),
    packages: [],
  };
  const blob = await getObject(config, WEIXIN_CLOUD_INDEX_PATH).catch(() => null);
  if (!blob) return fallback;
  try {
    const parsed = JSON.parse(await blob.text()) as Partial<WeixinCloudRuntimeIndex>;
    if (parsed.format !== "ai-phone-weixin-cloud-index" || !Array.isArray(parsed.packages)) return fallback;
    return {
      format: "ai-phone-weixin-cloud-index",
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
      packages: parsed.packages.filter(isRuntimeIndexItem),
    };
  } catch {
    return fallback;
  }
}

async function updateRuntimeIndex(config: CloudBackupConfig, item: WeixinCloudRuntimeIndexItem): Promise<void> {
  const next: WeixinCloudRuntimeIndex = {
    format: "ai-phone-weixin-cloud-index",
    version: 1,
    updatedAt: item.updatedAt,
    packages: [item],
  };
  await putObject(config, WEIXIN_CLOUD_INDEX_PATH, JSON.stringify(next, null, 2), "application/json");
}

function getActiveWeixinCloudBots(): WeixinBotConfig[] {
  const bots = loadWeixinBots().filter(bot => bot.enabled && bot.botToken.trim());
  if (bots.length <= 1) return bots;
  return [...bots].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 1);
}

function isRuntimeIndexItem(value: unknown): value is WeixinCloudRuntimeIndexItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WeixinCloudRuntimeIndexItem>;
  return Boolean(
    typeof item.botId === "string"
    && typeof item.characterId === "string"
    && typeof item.characterName === "string"
    && typeof item.sessionId === "string"
    && typeof item.path === "string"
    && typeof item.updatedAt === "string"
  );
}
