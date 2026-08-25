import type { ChatMessage, ChatSession } from "./chat-storage";
import {
  createOrGetSession,
  CHAT_MESSAGES_DELETED_EVENT,
  CHAT_MESSAGE_PUSHED_EVENT,
  CHAT_RESPONSE_BATCH_REPLACED_EVENT,
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
import { applyEditRegex, assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { MacroEngine } from "./macro-engine";
import {
  appendEmptyGenerateGuardMessage,
  applyVisionImagePromptLimit,
  buildChatBilingualInstruction,
  buildMusicCloudMacro,
  buildMusicLocalMacro,
  buildOfflineBilingualInstruction,
} from "./chat-engine";
import { nativeToolProtocolForConfig } from "./llm-provider-adapter";
import { stripHallucinatedTimestamps } from "./api-helpers";
import { getEnabledTools } from "./tool-storage";
import { getCustomStickerExample, getCustomStickerNames, resolveCustomStickerMap } from "./custom-sticker-storage";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { buildCharacterTimeContext } from "./character-time";
import { isNeteaseConfigured } from "./music-service";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { getWeixinCloudDeployedAt } from "./cloud-deploy-status";
import {
  isCloudBackupConfigured,
  loadCloudBackupConfig,
  normalizeBackupUrl,
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
/** v2 深度哨兵：__AI_PHONE_WX_SLOT_D<d>__ 标记「距离历史底部 d 条」的位置 */
const WEIXIN_CLOUD_DEPTH_SLOT_PREFIX = "__AI_PHONE_WX_SLOT_D";
/** 历史起点哨兵：把「同步时已烘焙的历史」从结构块里切出来，深度注入才能插回它内部 */
const WEIXIN_CLOUD_HISTORY_HEAD_TOKEN = "__AI_PHONE_WX_SLOT_HEAD__";
/** 哨兵条数上限：深度再大也没有实际意义，且每个哨兵都会占一条历史位 */
const WEIXIN_CLOUD_MAX_DEPTH_SLOTS = 48;
const WEIXIN_CLOUD_CHAT_APP_TAGS = ["chat", "text"];
const DEFAULT_MESSAGE_LIMIT = 80;
const REALTIME_PULL_INTERVAL_MS = 8000;
const LOCAL_UPLOAD_FLUSH_DELAY_MS = 500;
const RUNTIME_CONFIG_SYNC_DEBOUNCE_MS = 3000;
const RUNTIME_AUTO_SYNC_THROTTLE_MS = 60 * 60 * 1000;

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
  /** 云端助手是否发送媒体回复（生图/表情包/语音卡）；核心模块按此开关执行 */
  mediaReply?: boolean;
  timeAware: boolean;
  /**
   * 用户设备时区（IANA）。云函数跑在 UTC，不下发这个字段的话它给微信消息打的
   * 时间戳会比运行包里烘焙的小手机历史时间戳整整差几个时区，同一段提示词里出现
   * 两套钟——既让模型看到时间跳变，也更容易照着编时间戳。
   */
  promptTimeZone?: string;
  /** 与小手机 getPromptTimestampOptionsForTimeContext 对齐：角色时区与系统时区有差异时才带时区名 */
  promptTimestampIncludeZone?: boolean;
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

/**
 * 轻量提示词模板：助手拿它 + 新微信消息拼出完整提示词，不需要在云端跑一遍组装器。
 *
 * v1 只有 before/after 两段，切分点是历史末尾的单个 slot——深度注入（世界书
 * position=4、预设 injection_position≠0）在同步那一刻就被算好位置钉进 beforeMessages，
 * 之后微信每来一条消息，这些条目距离底部就远一条，越聊越飘。
 *
 * v2 在历史末尾插 maxDepth+1 个哨兵 slot，把「距离底部 d 条」这个位置切出来，
 * 助手按当前的新消息条数重新定位。beforeMessages / afterMessages 仍按 v1 语义填好，
 * 老助手（未更新的本地包）读到 v2 模板也能照常工作，只是恢复成 v1 的漂移行为。
 */
export type WeixinCloudPromptTemplate = {
  version: 1 | 2;
  slotToken: string;
  beforeMessages: LLMMessage[];
  afterMessages: LLMMessage[];
  baseHistoryLength: number;
  createdAt: string;
  /** v2：历史之上的固定部分（角色卡、预设前置块等） */
  structuralMessages?: LLMMessage[];
  /**
   * v2：同步那一刻已经烘焙好的历史消息，单独成段。
   * 助手把它和新微信消息接成一条完整历史再算深度——否则新消息条数少于 depth 时，
   * 注入块没法插回旧历史内部，只能贴在它下面（与小手机不一致）。
   */
  bakedHistoryMessages?: LLMMessage[];
  /** v2：depth 段，助手把 messages 放到「完整历史倒数第 depth 条」之前 */
  depthSegments?: Array<{ depth: number; messages: LLMMessage[] }>;
  /** v2：本次烘焙覆盖到的最大深度，超过它的注入仍留在 structuralMessages 里 */
  maxDepth?: number;
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
  /** 微信收到的图片（已解密）在备份桶里的存储路径与类型，由助手写入 */
  imagePath?: string;
  imageMime?: string;
  raw?: unknown;
  needsReply?: boolean;
  repliedAt?: string;
  /** 离线兜底改送微信时，本轮回复所对应的本地触发消息。 */
  replyAfterLocalMessageId?: string;
  replyAfterCreatedAt?: string;
  /** 同一次主动发送被拆成多段时的稳定顺序（从 0 开始）。 */
  replySequence?: number;
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
    // “微信本地助手”入口被精简后，旧的消息同步开关不再有 UI；但它的
    // 默认 false 仍会让已部署云助手的设备完全跳过云消息拉取。部署标记
    // 或已同步运行包都代表这条同步链路应当启用，并兼容此前留下的 false。
    if (!raw) return { enabled: Boolean(getWeixinCloudDeployedAt()) };
    const parsed = JSON.parse(raw) as Partial<WeixinCloudSyncConfig>;
    const hasSyncedRuntime = typeof parsed.lastRuntimePackagePath === "string"
      && parsed.lastRuntimePackagePath.length > 0;
    return {
      enabled: parsed.enabled === true || hasSyncedRuntime || Boolean(getWeixinCloudDeployedAt()),
      lastSyncedAt: typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : undefined,
      lastRuntimePackagePath: typeof parsed.lastRuntimePackagePath === "string" ? parsed.lastRuntimePackagePath : undefined,
    };
  } catch {
    return { enabled: Boolean(getWeixinCloudDeployedAt()) };
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

// ---- 微信云端助手（Supabase Edge Function 托管自动回复） ----

const WEIXIN_CLOUD_CRON_SECRET_PATH = `${WEIXIN_CLOUD_PREFIX}/cron-secret.json`;
const WEIXIN_CLOUD_ASSISTANT_STATE_PATH = `${WEIXIN_CLOUD_PREFIX}/state/cloud-assistant.json`;

/** 用户在 Supabase 控制台创建云函数时必须使用的名字（决定函数 URL）。 */
export const WEIXIN_CLOUD_FUNCTION_SLUG = "weixin-assistant";
export const WEIXIN_CLOUD_CRON_JOB_NAME = "ai-phone-weixin-assistant";

export type WeixinCloudAssistantHeartbeat = {
  lastRunAt?: string;
  lastError?: string;
  polled?: number;
  received?: number;
  stored?: number;
  sent?: number;
  elapsedMs?: number;
  /** bucket = 正在使用小手机同步的最新核心；bundled = 使用函数内置版本 */
  codeSource?: string;
};

function requireCloudBackupConfig(): CloudBackupConfig {
  const config = loadCloudBackupConfig();
  if (!isCloudBackupConfigured(config)) {
    throw new Error("请先在数据管理里配置 Supabase 云端备份。");
  }
  return config;
}

export function buildWeixinCloudAssistantFunctionUrl(config: CloudBackupConfig = loadCloudBackupConfig()): string {
  const base = normalizeBackupUrl(config.url);
  if (!base) throw new Error("请先在数据管理里配置 Supabase 云端备份。");
  return `${base}/functions/v1/${WEIXIN_CLOUD_FUNCTION_SLUG}`;
}

/**
 * 定时任务调用云函数用的共享密钥。云函数没有独立配置入口，密钥直接存在用户
 * 自己的备份桶里（云函数用 service_role 读同一对象做比对），小手机负责首次生成。
 */
export async function ensureWeixinCloudCronSecret(): Promise<string> {
  const config = requireCloudBackupConfig();
  await ensureBucket(config);

  const existing = await getObject(config, WEIXIN_CLOUD_CRON_SECRET_PATH);
  if (existing) {
    try {
      const parsed = JSON.parse(await existing.text()) as { token?: unknown };
      if (typeof parsed.token === "string" && parsed.token.trim().length >= 16) return parsed.token.trim();
    } catch {
      // 内容损坏则重新生成覆盖
    }
  }

  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  await putObject(config, WEIXIN_CLOUD_CRON_SECRET_PATH, JSON.stringify({
    format: "ai-phone-weixin-cloud-cron-secret",
    version: 1,
    token,
    createdAt: new Date().toISOString(),
  }, null, 2), "application/json");
  return token;
}

/** 生成已填好用户项目 URL 和密钥的定时任务 SQL，粘贴到 Supabase SQL Editor 即可。 */
export function buildWeixinCloudAssistantCronSql(token: string, config: CloudBackupConfig = loadCloudBackupConfig()): string {
  const functionUrl = buildWeixinCloudAssistantFunctionUrl(config);
  return `-- AI Phone 微信云端助手定时任务：每分钟触发一次，云函数内部每 ~12 秒子轮询微信消息并自动回复。
-- 回复速度与旧的 10 秒定时基本一致，但 Edge Function 调用次数降到 1/6（约 4.3 万次/月）。
-- 在 Supabase Dashboard → SQL Editor 里整段执行；重复执行会覆盖同名任务，可安全重跑。
-- 前提：已在 Edge Functions 里部署名为 ${WEIXIN_CLOUD_FUNCTION_SLUG} 的云函数，并关闭其 JWT 校验。

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('${WEIXIN_CLOUD_CRON_JOB_NAME}', '* * * * *', $CRON$
  select net.http_post(
    url     := '${functionUrl}',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('token', '${token}', 'bucket', '${CLOUD_BACKUP_BUCKET}', 'mode', 'loop'),
    timeout_milliseconds := 8000
  );
$CRON$);

-- pg_cron 每次运行都会往 cron.job_run_details 记一行，长期不清会蚕食数据库容量；
-- 挂一个每天清理的任务，只保留最近 3 天。
select cron.schedule('${WEIXIN_CLOUD_CRON_JOB_NAME}-cleanup', '0 3 * * *', $CRON$
  delete from cron.job_run_details where end_time < now() - interval '3 days';
$CRON$);

-- 停用云端助手时执行：
-- select cron.unschedule('${WEIXIN_CLOUD_CRON_JOB_NAME}');
-- select cron.unschedule('${WEIXIN_CLOUD_CRON_JOB_NAME}-cleanup');
`;
}

/** 读取云函数每次运行后写回的心跳状态；null 表示云函数从未成功运行过。 */
export async function fetchWeixinCloudAssistantHeartbeat(): Promise<WeixinCloudAssistantHeartbeat | null> {
  const config = requireCloudBackupConfig();
  const blob = await getObject(config, WEIXIN_CLOUD_ASSISTANT_STATE_PATH);
  if (!blob) return null;
  try {
    const parsed = JSON.parse(await blob.text()) as WeixinCloudAssistantHeartbeat & { format?: string };
    if (parsed?.format !== "ai-phone-weixin-cloud-assistant-state") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 通过 Supabase 管理 API 一键部署云函数（等价于 supabase functions deploy --use-api）。
 * 需要用户提供账号 Access Token（supabase.com/dashboard/account/tokens 生成）；
 * token 只在本次请求中使用，不做任何持久化。部署时直接指定 verify_jwt=false，
 * 用户无需再去函数设置里关 JWT 开关。
 */
export async function deployWeixinCloudFunction(accessToken: string): Promise<void> {
  const config = requireCloudBackupConfig();
  const token = accessToken.trim();
  if (!token) throw new Error("请先粘贴 Supabase Access Token。");

  const base = normalizeBackupUrl(config.url);
  const ref = (() => {
    try {
      return new URL(base).hostname.split(".")[0] || "";
    } catch {
      return "";
    }
  })();
  if (!ref) throw new Error("无法从云端备份地址解析项目标识，请检查数据管理里的 Supabase URL。");

  const codeRes = await fetch("/weixin-local-assistant/cloud-function.mjs", { cache: "no-store" });
  if (!codeRes.ok) throw new Error("获取云函数代码失败，请刷新页面重试。");
  const code = await codeRes.text();

  // 经站点服务端代理转发（/api/weixin/deploy-function）：api.supabase.com
  // 不对第三方站点来源返回 CORS 放行头，浏览器直连会被拦截，与 iLink
  // 走 /api/weixin 代理是同一类问题。token 仅透传，服务端不存储不记录。
  let res: Response;
  try {
    res = await fetch("/api/weixin/deploy-function", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, token, code }),
    });
  } catch {
    throw new Error("无法访问站点部署接口，请检查网络后重试；也可改用下方「手动部署方式」。");
  }
  if (res.status === 502) {
    throw new Error("服务器暂时连不上 Supabase 管理接口，请稍后重试；也可改用下方「手动部署方式」。");
  }

  if (res.status === 401) {
    throw new Error("Access Token 无效或已过期，请到 supabase.com → Account → Access Tokens 重新生成。");
  }
  if (res.status === 403) {
    throw new Error("这个 Access Token 没有该项目的权限，请确认它来自和云端备份同一个 Supabase 账号。");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`部署失败（HTTP ${res.status}）：${text.slice(0, 200) || "未知错误"}`);
  }
}

/** 在线开启/停用云端定时轮询：由云函数直连数据库执行 cron.schedule / cron.unschedule。 */
export async function setWeixinCloudAssistantScheduled(enabled: boolean): Promise<{ scheduled: boolean }> {
  const config = requireCloudBackupConfig();
  const token = await ensureWeixinCloudCronSecret();
  const url = buildWeixinCloudAssistantFunctionUrl(config);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, bucket: CLOUD_BACKUP_BUCKET, action: enabled ? "enable" : "disable" }),
    });
  } catch {
    throw new Error("无法访问云函数。请先完成①②两步（部署 weixin-assistant 函数并关闭 JWT 校验）。");
  }

  const data = await res.json().catch(() => null) as { ok?: boolean; scheduled?: boolean; error?: string } | null;
  if (res.status === 401) {
    throw new Error(data?.error === "invalid_token"
      ? "云函数密钥不匹配，请重新部署最新的云函数代码后重试。"
      : "云函数拒绝访问（401）。请在函数的 Settings 里关掉「Verify JWT with legacy secret」（部分版本叫 Enforce JWT verification）并保存后重试。");
  }
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `云函数返回 HTTP ${res.status}`);
  }
  if (typeof data.scheduled !== "boolean") {
    throw new Error("云函数版本较旧，不支持在线开关。请点「复制云函数代码」，到函数的 Code 标签替换为最新代码重新部署；或使用「复制定时 SQL」手动操作。");
  }
  return { scheduled: data.scheduled };
}

/** 从浏览器直接调用一次云函数，验证部署是否成功。 */
export async function testWeixinCloudAssistantOnce(): Promise<{ ok: boolean; sent: number; error?: string }> {
  const config = requireCloudBackupConfig();
  const token = await ensureWeixinCloudCronSecret();
  const url = buildWeixinCloudAssistantFunctionUrl(config);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // debug 同时强制全量扫描一次：手动验证不吃「待回复标志」的空闲短路，
      // 保证「拉消息 → 生成 → 回复」全链路真实跑一遍。
      body: JSON.stringify({ token, bucket: CLOUD_BACKUP_BUCKET, debug: true }),
    });
  } catch {
    throw new Error("无法访问云函数。请确认已部署名为 weixin-assistant 的 Edge Function，并已关闭该函数的 JWT 校验。");
  }

  const data = await res.json().catch(() => null) as { ok?: boolean; sent?: number; error?: string } | null;
  if (res.status === 401) {
    throw new Error(data?.error === "invalid_token"
      ? "云函数密钥不匹配，请重新复制定时 SQL 并在 SQL Editor 里重新执行。"
      : "云函数拒绝访问（401）。请在函数的 Settings 里关掉「Verify JWT with legacy secret」（部分版本叫 Enforce JWT verification）并保存后重试。");
  }
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `云函数返回 HTTP ${res.status}`);
  }
  return { ok: true, sent: Number(data.sent) || 0, error: data.error };
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

export function buildWeixinCloudPromptTemplate(snapshot: WeixinCloudRuntimeSnapshot): WeixinCloudPromptTemplate {
  const context = snapshot.promptContext;
  // maxDepth + 1 个哨兵：depth=d 的注入块（order < 历史块的 999）会落在 slot_{d+1}
  // 和 slot_d 之间，多插一个才能把最大深度那一档也单独切出来。
  const maxDepth = resolveWeixinCloudMaxInjectionDepth(snapshot);
  const slotCount = Math.min(WEIXIN_CLOUD_MAX_DEPTH_SLOTS, Math.max(2, maxDepth + 1));
  // 由深到浅追加，最后一条哨兵位于历史最底部（depth 1）
  const slotDepths = Array.from({ length: slotCount }, (_, i) => slotCount - i);
  const slotMessage = (id: string, content: string, createdAt: string): ChatMessage => ({
    id,
    sessionId: snapshot.session.id,
    role: "system",
    content,
    status: "sent",
    createdAt,
  });
  // 短期时间线是按时间戳排序的，哨兵的时间必须压过整条线的两端，否则一条时间戳比
  // 同步时刻还晚的历史消息（时钟偏差、导入的旧数据）就能把哨兵挤到历史中间，
  // 切出来的段全错。ISO 字符串按字典序即时间序；并列时按加入顺序决胜，
  // 头哨兵排在最前、深度哨兵追加在最后，所以取闭区间端点就够。
  const timeline = [
    ...context.promptHistory.map(message => message.createdAt),
    ...context.unifiedRecentItems.map(item => item.timestamp),
    snapshot.createdAt,
  ].filter(Boolean).sort();
  const headCreatedAt = timeline[0] ?? snapshot.createdAt;
  const slotCreatedAt = timeline[timeline.length - 1] ?? snapshot.createdAt;

  const slotMessages = slotDepths.map(depth =>
    slotMessage(`weixin-cloud-history-slot-d${depth}`, depthSlotToken(depth), slotCreatedAt));

  // 历史起点哨兵插在最前：它上面是结构块，下面到第一个深度哨兵之间就是已烘焙的历史。
  const headMessage = slotMessage("weixin-cloud-history-head", WEIXIN_CLOUD_HISTORY_HEAD_TOKEN, headCreatedAt);

  // 前插会把 unifiedRecentItems 里的 historyIndex 全体错位一位，必须同步右移，
  // 否则历史项会指向错误的消息，烘焙出来的历史顺序整个乱掉。
  const headHistory = [headMessage, ...context.promptHistory];
  const headSnapshot: WeixinCloudRuntimeSnapshot = {
    ...snapshot,
    promptContext: {
      ...context,
      promptHistory: headHistory,
      unifiedRecentItems: [
        { kind: "history", timestamp: headCreatedAt, historyIndex: 0 },
        ...context.unifiedRecentItems.map(item =>
          item.kind === "history" ? { ...item, historyIndex: item.historyIndex + 1 } : { ...item }),
      ],
    },
  };

  const templateMessages = buildWeixinCloudPromptMessages(headSnapshot, {
    history: [...headHistory, ...slotMessages],
    skipEmptyGenerateGuard: true,
  });

  const segments = splitPromptMessagesByTokens(
    templateMessages,
    [WEIXIN_CLOUD_HISTORY_HEAD_TOKEN, ...slotDepths.map(depthSlotToken)],
  );
  const structuralMessages = segments[0];
  const bakedHistoryMessages = segments[1];
  const afterMessages = segments[segments.length - 1];
  // segments[j]（2 ≤ j ≤ slotCount）= 位于 slot_{slotCount-j+2} 与 slot_{slotCount-j+1}
  // 之间的内容，也就是 depth = slotCount - j + 1 的注入块。
  const depthSegments = segments
    .slice(2, segments.length - 1)
    .map((messages, index) => ({ depth: slotCount - index - 1, messages }))
    .filter(segment => segment.messages.length > 0);

  return {
    version: 2,
    slotToken: WEIXIN_CLOUD_HISTORY_SLOT_TOKEN,
    // v1 语义 = 深度注入按「零条新消息」时的位置嵌进已烘焙历史，正是老模板的排布，
    // 未更新的老助手读到它得到与改动前一致的提示词。
    beforeMessages: [...structuralMessages, ...interleaveDepthSegments(depthSegments, bakedHistoryMessages)],
    afterMessages,
    baseHistoryLength: context.promptHistory.length,
    createdAt: snapshot.createdAt,
    structuralMessages,
    bakedHistoryMessages,
    depthSegments,
    maxDepth: slotCount - 1,
  };
}

/**
 * 把 depth 段插回历史：depth = d 表示「距离底部第 d 条」，即插在下标 total - d 之前。
 * 与助手侧 assistant-core.mjs 的同名函数是同一套规则，改一处要一起改。
 */
function interleaveDepthSegments(
  segments: Array<{ depth: number; messages: LLMMessage[] }>,
  history: LLMMessage[],
): LLMMessage[] {
  const total = history.length;
  const buckets = new Map<number, LLMMessage[]>();
  const ordered = [...segments]
    .filter(segment => segment.messages.length > 0)
    .sort((a, b) => b.depth - a.depth);

  for (const segment of ordered) {
    const index = segment.depth <= 0 ? total : (segment.depth >= total ? 0 : total - segment.depth);
    buckets.set(index, [...(buckets.get(index) ?? []), ...segment.messages]);
  }

  const out: LLMMessage[] = [];
  for (let i = 0; i <= total; i += 1) {
    const bucket = buckets.get(i);
    if (bucket) out.push(...bucket);
    if (i < total) out.push(history[i]);
  }
  return out;
}

/** 预设 ABSOLUTE 条目（injection_position ≠ 0）与世界书 position=4 条目里的最大注入深度 */
function resolveWeixinCloudMaxInjectionDepth(snapshot: WeixinCloudRuntimeSnapshot): number {
  let maxDepth = 0;
  for (const prompt of snapshot.preset?.prompts ?? []) {
    if ((prompt.injection_position ?? 0) === 0) continue;
    maxDepth = Math.max(maxDepth, Math.floor(prompt.injection_depth ?? 0));
  }
  for (const worldBook of snapshot.worldBooks) {
    for (const entry of worldBook.entries ?? []) {
      if (entry.disable) continue;
      if (entry.position !== 4) continue;
      maxDepth = Math.max(maxDepth, Math.floor(entry.depth ?? 4));
    }
  }
  return Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 0;
}

function isWeixinCloudDepthSlotMessage(message: ChatMessage): boolean {
  return typeof message.content === "string"
    && (message.content.includes(WEIXIN_CLOUD_DEPTH_SLOT_PREFIX)
      || message.content.includes(WEIXIN_CLOUD_HISTORY_HEAD_TOKEN)
      || message.content.includes(WEIXIN_CLOUD_HISTORY_SLOT_TOKEN));
}

function depthSlotToken(depth: number): string {
  return `${WEIXIN_CLOUD_DEPTH_SLOT_PREFIX}${depth}__`;
}

/** 组装后的历史块可能把时间戳和哨兵合进同一条消息，切分时把这行时间戳一起丢掉 */
const WEIXIN_CLOUD_TIMESTAMP_ONLY_LINE = /^\s*[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*$/;

/**
 * 按哨兵 token 逐行切分组装结果，返回 tokens.length + 1 段。
 * 逐行而非按下标切：组装器会把相邻同 role 的块合并成一条消息，一条消息里可能
 * 同时含多个哨兵，而且开了时间感知时哨兵上面还会多一行时间戳。
 */
function splitPromptMessagesByTokens(messages: LLMMessage[], tokens: string[]): LLMMessage[][] {
  const segments: LLMMessage[][] = [[]];
  let tokenIndex = 0;

  for (const message of messages) {
    const current = () => segments[segments.length - 1];
    if (typeof message.content !== "string") {
      current().push(stripPromptMessageForCloud(message));
      continue;
    }

    let buffer: string[] = [];
    const flush = () => {
      const text = buffer.join("\n").trim();
      buffer = [];
      if (text) current().push(stripPromptMessageForCloud({ ...message, content: text }));
    };

    for (const line of message.content.split("\n")) {
      if (tokenIndex < tokens.length && line.includes(tokens[tokenIndex])) {
        while (buffer.length > 0 && (!buffer[buffer.length - 1].trim() || WEIXIN_CLOUD_TIMESTAMP_ONLY_LINE.test(buffer[buffer.length - 1]))) {
          buffer.pop();
        }
        flush();
        segments.push([]);
        tokenIndex += 1;
        continue;
      }
      buffer.push(line);
    }
    flush();
  }

  if (tokenIndex !== tokens.length) {
    throw new Error("生成微信本地助手运行包失败：未找到微信消息插入点。");
  }
  return segments;
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
    // 烘焙模板时历史末尾挂着一串深度哨兵，不能让它们顶掉真正的近期对话，
    // 否则世界书关键词激活会在最关键的最近 10 条上什么都匹配不到。
    .filter(message => !isWeixinCloudDepthSlotMessage(message))
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
    enabled: true,
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
  const promptTimeContext = buildCharacterTimeContext(params.character.timeZone, now);
  // 微信链路不执行原生 tool_calls；个人云助手会在运行时另行读取并注入
  // iPhone 快捷动作目录，所以这里仅禁用原生工具，不与快捷动作能力冲突。
  const toolsPrompt = "<tool_availability>当前对话正通过微信进行：原生工具调用不可用。不要输出「获取指令」「执行动作」或其他原生工具调用格式，也不要模仿历史消息中的原生工具调用记录；如运行时另有明确的 iPhone 快捷动作能力说明，可按该说明使用。</tool_availability>";

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
    mediaReply: true,
    timeAware: params.chatAppSettings.timeAware !== false,
    promptTimeZone: promptTimeContext.systemTimeZone,
    promptTimestampIncludeZone: promptTimeContext.hasDifference,
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
  // 顺带把最新核心逻辑传到桶里：云函数的自更新加载器会优先使用它，
  // 这样函数部署一次之后，逻辑更新随同步自动生效。失败不阻塞运行包同步。
  await syncWeixinCloudFunctionCore(options?.cloudConfig).catch(() => {});
  return results;
}

const WEIXIN_CLOUD_CORE_CODE_PATH = `${WEIXIN_CLOUD_PREFIX}/function-core.mjs`;

/** 把站点携带的 assistant-core.mjs 上传到备份桶，供云函数运行时动态加载。 */
export async function syncWeixinCloudFunctionCore(cloudConfig?: CloudBackupConfig): Promise<void> {
  if (typeof window === "undefined") return;
  const config = cloudConfig ?? loadCloudBackupConfig();
  if (!isCloudBackupConfigured(config)) return;
  const res = await fetch("/weixin-local-assistant/assistant-core.mjs", { cache: "no-store" });
  if (!res.ok) return;
  const code = await res.text();
  if (!code.includes("export async function pollOnce")) return;
  await putObject(config, WEIXIN_CLOUD_CORE_CODE_PATH, code, "text/javascript");
}

export async function pullWeixinCloudMessagesFromCloud(
  options?: { cloudConfig?: CloudBackupConfig; botId?: string; limitPerBot?: number },
): Promise<WeixinCloudMessagePullResult> {
  await Promise.all([hydrateChatStorage(), ensureSettingsStorageHydrated()]);
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

    storedMessages.sort((a, b) => cloudStoredMessageTime(a).localeCompare(cloudStoredMessageTime(b)));
    for (const stored of storedMessages) {
      const imported = await importCloudStoredMessage(cloudConfig, stored);
      if (imported.inserted) {
        result.added += 1;
        touchedSessionIds.add(imported.sessionId);
      } else {
        result.skipped += 1;
      }
    }
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

  const onResponseBatchReplaced = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      { messages?: ChatMessage[]; rawResponseText?: string } | undefined;
    if (!Array.isArray(detail?.messages) || typeof detail?.rawResponseText !== "string") return;
    if (!shouldRun()) return;
    if (!findWeixinCloudOutboundAnchor(detail.messages)) return;

    // 编辑后的分段沿用原 cloudSync，拉取侧的去重照旧命中；这里把编辑结果回写云端，
    // 否则助手下一轮从云消息目录读到的仍是编辑前的原文。
    void syncEditedWeixinCloudMessageToCloud(detail.messages, detail.rawResponseText).catch((err) => {
      console.warn("[WeixinCloudSync] edited reply write-back failed:", err);
    });

    // 只回写云消息还不够：这条回复若已经烘焙进当前运行包，助手会因为它的时间戳
    // 早于运行包生成时刻而在历史过滤阶段把云对象排除，只看到模板里的旧版本。
    // 重新同步一次运行包才能真正让编辑生效——顺带也是回写失败时的兜底，
    // 因为本地消息已经是编辑后的内容，重新烘焙同样会带上。
    scheduleRuntimeSync();
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

  // ── 运行包自动同步 ──
  // Bot 配置变化（添加/删除/启停/重扫码）后 3 秒内自动同步运行包，
  // 否则云端/本地助手会一直拿着旧 token 和旧配置轮询；
  // 回到前台和启动时按 1 小时节流做兜底刷新（顺带覆盖 API/预设等变更）。
  let runtimeSyncInFlight = false;
  let lastRuntimeSyncAt = 0;
  let runtimeSyncTimer: number | null = null;

  const syncRuntimesNow = async (force = false) => {
    if (stopped || runtimeSyncInFlight || !shouldRun()) return;
    if (!force && Date.now() - lastRuntimeSyncAt < RUNTIME_AUTO_SYNC_THROTTLE_MS) return;
    runtimeSyncInFlight = true;
    try {
      await syncAllWeixinBotRuntimesToCloud();
      lastRuntimeSyncAt = Date.now();
    } catch (err) {
      console.warn("[WeixinCloudSync] runtime auto sync failed:", err);
    } finally {
      runtimeSyncInFlight = false;
    }
  };

  const scheduleRuntimeSync = () => {
    if (runtimeSyncTimer) window.clearTimeout(runtimeSyncTimer);
    runtimeSyncTimer = window.setTimeout(() => {
      runtimeSyncTimer = null;
      void syncRuntimesNow(true);
    }, RUNTIME_CONFIG_SYNC_DEBOUNCE_MS);
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      void pullNow(true);
      void syncRuntimesNow(false);
    }
  };

  const onFocus = () => {
    void pullNow(true);
  };

  const onConfigChanged = () => {
    if (!shouldRun()) return;
    void pullNow(true);
    scheduleRuntimeSync();
  };

  window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, onMessagePushed);
  window.addEventListener(CHAT_RESPONSE_BATCH_REPLACED_EVENT, onResponseBatchReplaced);
  window.addEventListener(CHAT_MESSAGES_DELETED_EVENT, onMessagesDeleted);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("weixin-config-changed", onConfigChanged);

  const interval = window.setInterval(() => {
    void pullNow(false);
  }, REALTIME_PULL_INTERVAL_MS);
  void pullNow(true);
  void syncRuntimesNow(false);

  return () => {
    stopped = true;
    window.clearInterval(interval);
    if (uploadFlushTimer) window.clearTimeout(uploadFlushTimer);
    if (runtimeSyncTimer) window.clearTimeout(runtimeSyncTimer);
    window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, onMessagePushed);
    window.removeEventListener(CHAT_RESPONSE_BATCH_REPLACED_EVENT, onResponseBatchReplaced);
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

/**
 * 长按编辑一条从微信拉回来的回复后，把编辑结果就地覆盖回同一条云消息。
 *
 * 不能走 syncLocalWeixinCloudMessageToCloud：那条路会新建 `local_<msgId>` 对象，
 * 云端就同时存在原文与编辑版，助手组提示词时两份都读得到。这里只改 content，
 * 保留 externalId / raw / needsReply 等字段，云端对象数量不变。
 */
export function findWeixinCloudOutboundAnchor(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find(message =>
    message.cloudSync?.source === "weixin-cloud"
    && message.cloudSync.direction === "outbound"
    && Boolean(message.cloudSync.botId)
    && Boolean(message.cloudSync.externalId),
  );
}

export async function syncEditedWeixinCloudMessageToCloud(
  messages: ChatMessage[],
  rawResponseText: string,
): Promise<boolean> {
  const anchor = findWeixinCloudOutboundAnchor(messages);
  if (!anchor?.cloudSync?.botId || !anchor.cloudSync.externalId) return false;
  if (loadWeixinCloudSyncConfig().enabled !== true) return false;

  const cloudConfig = loadCloudBackupConfig();
  if (!isCloudBackupConfigured(cloudConfig)) return false;

  const content = rawResponseText.trim();
  if (!content) return false;

  const path = weixinCloudMessagePath(anchor.cloudSync.botId, anchor.cloudSync.externalId);
  const blob = await getObject(cloudConfig, path);
  // 云端原件已被删掉（或还没落盘）就不补建：凭空造一条会让助手把它当新消息处理。
  if (!blob) return false;

  let stored: WeixinCloudStoredMessage;
  try {
    stored = JSON.parse(await blob.text()) as WeixinCloudStoredMessage;
  } catch {
    return false;
  }
  if (!isCloudStoredMessage(stored)) return false;
  if (stored.content === content) return true;

  await putObject(
    cloudConfig,
    path,
    JSON.stringify({ ...stored, content, editedAt: new Date().toISOString() }, null, 2),
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

async function importCloudStoredMessage(
  cloudConfig: CloudBackupConfig,
  stored: WeixinCloudStoredMessage,
): Promise<{ inserted: boolean; sessionId: string }> {
  if (!isCloudStoredMessage(stored)) return { inserted: false, sessionId: "" };
  if (isLocalUploadedCloudMessage(stored)) return { inserted: false, sessionId: "" };
  const session = createOrGetSession(stored.characterId);
  if (stored.localMessageId && loadChatMessages(session.id).some(message => message.id === stored.localMessageId)) {
    return { inserted: false, sessionId: session.id };
  }
  const createdAt = resolveCloudImportedMessageCreatedAt(stored, session);
  if (stored.role === "assistant" && stored.direction === "outbound") {
    return importCloudAssistantMessage(stored, session, createdAt);
  }
  const id = cloudMessageId(stored);
  if (loadChatMessages(session.id).some(message => message.id === id)) {
    return { inserted: false, sessionId: session.id };
  }
  // 微信收到的图片：去重之后才下载，转成 data URL 以图片气泡展示
  const imageDataUrl = stored.imagePath
    ? await loadCloudStoredMessageImage(cloudConfig, stored).catch(() => undefined)
    : undefined;
  const msg: ChatMessage = {
    id,
    sessionId: session.id,
    role: stored.role,
    content: imageDataUrl ? "" : stored.content,
    ...(imageDataUrl ? { mediaType: "image" as const, mediaUrl: imageDataUrl } : {}),
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

/**
 * 云端主动回复与触发它的本地输入分别使用服务器、手机时钟。若两边相差几百
 * 毫秒，纯 createdAt 排序会把回复放到输入前面。带因果锚点的新消息只在必要
 * 时向后校正；旧消息/普通微信消息保持原时间，避免改变既有会话排序。
 */
export function resolveCloudImportedMessageCreatedAt(
  stored: WeixinCloudStoredMessage,
  session: Pick<ChatSession, "id">,
): string {
  const sourceTime = stored.receivedAt || stored.createdAt || new Date().toISOString();
  if (stored.role !== "assistant" || stored.direction !== "outbound") return sourceTime;

  const anchorId = typeof stored.replyAfterLocalMessageId === "string"
    ? stored.replyAfterLocalMessageId.trim()
    : "";
  const localAnchor = anchorId
    ? loadChatMessages(session.id).find(message => message.id === anchorId)
    : undefined;
  const anchorTime = localAnchor?.createdAt || stored.replyAfterCreatedAt || "";
  const sourceMs = Date.parse(sourceTime);
  const anchorMs = Date.parse(anchorTime);
  if (!Number.isFinite(sourceMs) || !Number.isFinite(anchorMs)) return sourceTime;

  const rawSequence = Number(stored.replySequence);
  const sequence = Number.isInteger(rawSequence) && rawSequence >= 0
    ? Math.min(rawSequence, 1000)
    : 0;
  const minimumReplyMs = anchorMs + sequence + 1;
  return sourceMs >= minimumReplyMs ? sourceTime : new Date(minimumReplyMs).toISOString();
}

async function loadCloudStoredMessageImage(
  cloudConfig: CloudBackupConfig,
  stored: WeixinCloudStoredMessage,
): Promise<string | undefined> {
  if (!stored.imagePath || !stored.imagePath.startsWith("weixin-cloud/media/")) return undefined;
  const blob = await getObject(cloudConfig, stored.imagePath);
  if (!blob) return undefined;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0) return undefined;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const mime = stored.imageMime || blob.type || "image/jpeg";
  return `data:${mime};base64,${btoa(binary)}`;
}

/** 导入前按角色绑定的正则脚本整形（编辑类、placement=2），与聊天室生成/编辑路径同一套处理。 */
function normalizeCloudAssistantContentForImport(
  stored: Pick<WeixinCloudStoredMessage, "content" | "characterId">,
  characterName: string,
): string {
  const content = stored.content;
  try {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, stored.characterId, "chat");
    const allRegexes = loadRegexes();
    const regexes = (slot.regexIds || [])
      .map(id => allRegexes.find(item => item.id === id))
      .filter((item): item is RegexConfig => Boolean(item));
    if (regexes.length === 0) return content;
    const macroEngine = new MacroEngine(characterName, resolveUserIdentity(stored.characterId)?.name || "你");
    return applyEditRegex(content, regexes, 2, { macroEngine, activeTags: ["chat", "text"] });
  } catch {
    return content;
  }
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
  // 兜底再剥一次幻觉时间戳：助手侧已经剥过，但旧运行包/旧云函数按老正则清洗，
  // 桶里存量消息仍可能残留 (2026-08-19 13:54 Asia/Shanghai) 这类尾巴。
  // 放在正则整形之前，长按编辑时看到的原文（rawResponseText）也是干净的。
  const strippedContent = stripHallucinatedTimestamps(stored.content);
  // 与聊天室编辑/生成路径保持一致：先跑角色绑定的编辑类正则整形，再解析。
  // 否则状态栏等内容与正则美化脚本期望的格式对不上（导入的消息会显示成纯文本）。
  const normalizedContent = normalizeCloudAssistantContentForImport(
    { content: strippedContent, characterId: stored.characterId },
    characterName,
  );
  const parsed = parseAIResponse(normalizedContent, getLatestCharacterStateValues(stored.characterId));
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
      }, strippedContent));
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
    }, strippedContent));
  });

  if (messages.length === 0 && (parsed.statusPanel || parsed.innerMonologue || parsed.stateValues.length > 0)) {
    messages.push(makeCloudImportedMessage(stored, session.id, createdAt, 0, {
      role: "assistant",
      content: "",
      statusPanel: parsed.statusPanel || undefined,
      innerMonologue: parsed.innerMonologue || undefined,
      stateValues: parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
      freshStateValues: parsed.freshStateValues,
    }, strippedContent));
  }
  if (messages.length === 0) {
    messages.push(makeCloudImportedMessage(stored, session.id, createdAt, 0, {
      role: "assistant",
      content: normalizedContent,
    }, strippedContent));
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
  rawResponseText: string = stored.content,
): ChatMessage {
  const baseTime = new Date(createdAt).getTime();
  const safeTime = Number.isFinite(baseTime) ? baseTime : Date.now();
  return {
    id: `${cloudMessageId(stored)}_${index}`,
    sessionId,
    status: "sent",
    createdAt: new Date(safeTime + index).toISOString(),
    // 同一条云端回复的所有分段共享批次：长按编辑时可以像普通消息一样
    // 编辑整个批次的原始输出（含状态栏），保存后重新分段。
    responseBatchId: `wxcloud_batch_${cloudMessageId(stored)}`,
    rawResponseText,
    ...patch,
    cloudSync: {
      source: "weixin-cloud",
      botId: stored.botId,
      externalId: stored.externalId,
      direction: stored.direction,
      syncedAt: new Date().toISOString(),
      ...(stored.replyAfterLocalMessageId
        ? { replyAfterLocalMessageId: stored.replyAfterLocalMessageId }
        : {}),
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
