// @ts-nocheck -- 本文件由核心 JS 模块拼接生成，不做 TS 标注
// AI Phone 微信云端助手（Supabase Edge Function，单文件版）
// 本文件由 scripts/build-weixin-assistant-dist.mjs 自动拼接生成，请勿手工编辑；
// 源文件：tools/weixin-local-assistant/assistant-core.mjs + cloud-function-wrapper.mjs。
//
// 部署方法（在你自己的 Supabase 项目里）：
// 1. Dashboard → Edge Functions → Deploy a new function → Via Editor，
//    先把函数名改成 weixin-assistant（部署后改名无效），再粘贴本文件全部内容并 Deploy；
// 2. 进入该函数的 Settings 标签，关掉「Verify JWT with legacy secret」开关
//    （部分版本叫 Enforce JWT verification）并 Save changes——本函数用小手机
//    生成的定时任务密钥做校验，与离线推送函数同一套做法；
// 3. 回到小手机「微信设置」点「开启云端轮询」（函数会自己创建定时任务；
//    如失败可用「手动方式：复制定时 SQL」到 SQL Editor 执行）。
//
// 本函数只需部署一次：运行时会优先动态加载备份桶里由小手机同步的最新核心
// 逻辑（weixin-cloud/function-core.mjs），失败才回退到本文件内置版本。

// 微信助手核心逻辑：本地助手（assistant.mjs）与云端助手（Supabase Edge Function）
// 共用这一份代码。这里只依赖 fetch 与 node:crypto/node:buffer（Node 20+ 与 Deno 均支持），
// 不要在本文件里引入 fs、path 等只有本地才有意义的模块。

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

// 云函数动态核心协议版本。wrapper 只加载版本一致的桶内核心，避免站点更新后
// 继续执行旧桶里不认识微信快捷动作续跑的代码。
export const WEIXIN_CORE_PROTOCOL_VERSION = 3;
export const DEFAULT_BUCKET = "ai-phone-backup";
export const DEFAULT_INTERVAL_SECONDS = 5;
const INDEX_PATH = "weixin-cloud/index.json";
const STATE_PREFIX = "weixin-cloud/state";
const MESSAGE_PREFIX = "weixin-cloud/messages";
const INCOMING_MEDIA_PREFIX = "weixin-cloud/media";
const INCOMING_IMAGE_MAX_BYTES = 6_000_000;
const LOCK_PREFIX = "weixin-cloud/locks";
const PENDING_FLAG_PREFIX = "weixin-cloud/pending";
const WEIXIN_SHORTCUT_RESULT_MARKER = "__FLOAT_WEIXIN_SHORTCUT_RESULT__";
const WEIXIN_SHORTCUT_IMAGE_MARKER = "__FLOAT_WEIXIN_SHORTCUT_IMAGE__";
const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const BASE_INFO = { channel_version: "1.0.2" };
// 锁 TTL 必须远小于「函数被平台掐掉后到下次可重试」的可接受等待：
// 云函数被墙钟杀掉时 finally 不会执行、锁无法主动释放，只能等 TTL 过期。
const AUTO_REPLY_LOCK_TTL_MS = 3 * 60 * 1000;

// 待回复标志与真实状态可能脱钩（函数中途被墙钟掐掉、标志写入失败等），
// 空闲时每隔这么久做一次全量扫描自愈；期间新消息仍由入库路径实时置位标志。
// 全量扫描一次要 list + 最多 200 个对象逐个 GET，是空闲期 Storage 流量大头，
// 30 分钟一次足够兜底（标志丢失的最坏后果是回复晚一个扫描周期）。
const PENDING_RECONCILE_INTERVAL_MS = 30 * 60 * 1000;

// 运行包体积可达 MB 级（含提示词模板、贴纸与参考图 base64），不能每轮全量
// 下载。索引条目的 updatedAt 随小手机每次同步更新，作为缓存失效依据；TTL 兜底。
const RUNTIME_PACKAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const runtimePackageCache = new Map();

// 单轮回复的截止时间（云端由 pollOnce options.deadlineAt 下发；本地 CLI 无限制）。
// 用于给 LLM/生图/TTS 分配剩余预算，保证整轮在云函数墙钟内完成。
let replyDeadlineAt = 0;

function remainingReplyBudgetMs() {
  if (!replyDeadlineAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, replyDeadlineAt - Date.now());
}

const assistantInstanceId = randomUUID();

export async function pollOnce(env, targetBotId, options = {}) {
  const deadlineAt = Number(options?.deadlineAt) || 0;
  replyDeadlineAt = deadlineAt;
  let skippedForDeadline = 0;
  const index = await loadRuntimeIndex(env);
  const targets = targetBotId
    ? index.packages.filter(item => item.botId === targetBotId)
    : getLatestRuntimeTargets(index.packages);

  const results = [];
  for (const item of targets) {
    if (deadlineAt && Date.now() >= deadlineAt) {
      skippedForDeadline += 1;
      continue;
    }
    const runtime = await loadRuntimePackage(env, item);
    const state = await loadBotState(env, item.botId);
    const polledAt = new Date().toISOString();

    const data = await callIlinkJson(
      "/ilink/bot/getupdates",
      runtime.bot?.botToken,
      { get_updates_buf: state.getUpdatesBuf || "", base_info: BASE_INFO },
      "POST",
    );

    const messages = Array.isArray(data.msgs) ? data.msgs : [];
    const ilinkErrorCode = typeof data.error_code === "number" && data.error_code !== 0 ? data.error_code : undefined;
    if (ilinkErrorCode !== undefined) {
      console.warn(`[weixin-assistant] getupdates error_code=${ilinkErrorCode} bot=${item.botId} 响应字段=${Object.keys(data).join(",")}`);
    }
    if (options?.debug) {
      console.log(`[weixin-assistant][debug] getupdates bot=${item.botId} 原始响应：${JSON.stringify(data).slice(0, 800)}`);
    }
    if (data.get_updates_buf) state.getUpdatesBuf = data.get_updates_buf;
    state.lastPolledAt = polledAt;
    state.lastError = data.error_code === -14
      ? "Token 已过期，请重新扫码"
      : ilinkErrorCode !== undefined ? `iLink error_code ${ilinkErrorCode}` : undefined;
    await saveBotState(env, item.botId, state);

    let storedMessages = 0;
    let lastStoredExternalId = "";
    for (const message of messages) {
      const storedId = await storeIncomingMessage(env, runtime, message, polledAt);
      if (storedId) {
        storedMessages += 1;
        lastStoredExternalId = storedId;
      }
    }
    if (storedMessages > 0) {
      await savePendingFlag(env, item.botId, {
        pending: true,
        lastInboundExternalId: lastStoredExternalId,
        pendingMarkedAt: polledAt,
      });
    }

    const autoReply = await autoReplyPendingMessages(env, runtime, { force: options?.debug === true }).catch(async (err) => {
      const message = errorMessage(err);
      state.lastAutoReplyError = message;
      await saveBotState(env, item.botId, state);
      return { status: "failed", pending: 0, sent: 0, error: message };
    });
    if (autoReply.status !== "failed") {
      state.lastAutoReplyAt = autoReply.sent > 0 ? new Date().toISOString() : state.lastAutoReplyAt;
      state.lastAutoReplyError = undefined;
      await saveBotState(env, item.botId, state);
    }

    results.push({
      botId: item.botId,
      characterId: item.characterId,
      polledAt,
      received: messages.length,
      stored: storedMessages,
      tokenExpired: data.error_code === -14,
      ilinkErrorCode,
      autoReply,
    });
  }

  return {
    polled: results.length,
    skippedForDeadline,
    results,
    note: "助手使用小手机同源提示词组装结构，并合并微信消息自动回复。",
  };
}

async function storeIncomingMessage(env, runtime, raw, receivedAt) {
  const text = extractText(raw);
  const mediaItem = extractIncomingMediaItem(raw);
  if (!text && !mediaItem) return false;

  const externalId = raw.message_id ? String(raw.message_id) : await sha256Hex(JSON.stringify(raw));
  const path = `${MESSAGE_PREFIX}/${runtime.bot.id}/${sanitizePathPart(externalId)}.json`;
  const existing = await getObjectJson(env, path).catch(() => null);
  if (existing?.format === "ai-phone-weixin-cloud-message") return false;

  let content = text;
  let imagePath;
  let imageMime;
  if (mediaItem?.kind === "image") {
    const image = await downloadIncomingWeixinImage(mediaItem).catch((err) => {
      // 打出 image_item 的结构（截断）便于排查微信收图协议差异
      console.warn(
        `[weixin-assistant] 收图下载失败 bot=${runtime.bot.id}: ${errorMessage(err)}；`
        + `image_item=${safeJsonPreview(mediaItem.imageItem, 600)}`,
      );
      return null;
    });
    if (image) {
      imageMime = image.mimeType;
      imagePath = `${INCOMING_MEDIA_PREFIX}/${sanitizePathPart(runtime.bot.id)}/${sanitizePathPart(externalId)}`;
      await putObject(env, imagePath, image.bytes, image.mimeType);
      content = content || "[图片]";
    } else {
      content = content || "[对方发来一张图片，但未能下载查看]";
    }
  } else if (mediaItem?.kind === "voice") {
    content = content || "[对方发来一条语音，暂时听不了]";
  } else if (mediaItem?.kind === "file") {
    content = content || `[对方发来一个文件${mediaItem.name ? `：${mediaItem.name}` : ""}]`;
  }

  await putObject(env, path, JSON.stringify({
    format: "ai-phone-weixin-cloud-message",
    version: 1,
    direction: "inbound",
    botId: runtime.bot.id,
    characterId: runtime.character.id,
    sessionId: runtime.session.id,
    externalId,
    receivedAt,
    role: "user",
    content,
    ...(imagePath ? { imagePath, imageMime } : {}),
    raw,
    needsReply: true,
  }, null, 2), "application/json");
  return externalId;
}

function extractIncomingMediaItem(raw) {
  const items = Array.isArray(raw?.item_list) ? raw.item_list : [];
  for (const item of items) {
    if (item?.type === 2 && item.image_item) {
      return { kind: "image", imageItem: item.image_item, media: item.image_item.media };
    }
    if (item?.type === 3) return { kind: "voice" };
    if (item?.type === 4 && item.file_item) {
      const name = typeof item.file_item.file_name === "string" ? item.file_item.file_name : "";
      const ext = String(item.file_item.file_ext || name.split(".").pop() || "").toLowerCase();
      if (["mp3", "silk", "amr", "wav", "m4a"].includes(ext)) return { kind: "voice" };
      return { kind: "file", name };
    }
  }
  return null;
}

// 下载并解密收到的微信图片：与上传路径互逆（CDN + AES-128-ECB）。
async function downloadIncomingWeixinImage(mediaItem) {
  const param = mediaItem?.media?.encrypt_query_param;
  const aesKeyEncoded = mediaItem?.media?.aes_key;
  if (!param || !aesKeyEncoded) throw new Error("missing_incoming_image_params");

  const key = decodeIncomingAesKey(aesKeyEncoded);
  if (!key) throw new Error("invalid_incoming_image_key");

  const res = await fetchWithTimeout(
    `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(String(param))}`,
    {},
    60_000,
  );
  if (!res.ok) throw new Error(`incoming_image_http_${res.status}`);
  const cipherBytes = Buffer.from(await res.arrayBuffer());
  if (cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) throw new Error("incoming_image_bad_cipher");
  if (cipherBytes.length > INCOMING_IMAGE_MAX_BYTES) throw new Error("incoming_image_too_large");

  // Supabase edge-runtime 的 node:crypto 兼容层不接受 iv=null / Buffer 子类，
  // 统一传纯 Uint8Array + 零长度 IV（Node 与 Deno 均兼容）。
  const decipher = createDecipheriv("aes-128-ecb", new Uint8Array(key), new Uint8Array(0));
  const bytes = Buffer.concat([
    Buffer.from(decipher.update(new Uint8Array(cipherBytes))),
    Buffer.from(decipher.final()),
  ]);
  const mimeType = sniffImageMimeType(bytes);
  if (!mimeType) throw new Error("incoming_image_not_image");
  return { bytes, mimeType };
}

// 兼容三种可能的 aes_key 编码：base64(hex 字符串)（发送路径用的格式）、
// 裸 hex 字符串、base64(原始 16 字节)。
function decodeIncomingAesKey(encoded) {
  const s = String(encoded || "").trim();
  if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, "hex");
  try {
    const decoded = Buffer.from(s, "base64");
    if (decoded.length === 16) return decoded;
    const hex = decoded.toString("utf8").trim();
    if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch {
    // fall through
  }
  return null;
}

// 序列化对象用于日志排查：长字符串字段只保留长度，整体截断。
function safeJsonPreview(value, maxLength = 600) {
  try {
    const compact = JSON.stringify(value, (jsonKey, jsonValue) => {
      if (typeof jsonValue === "string" && jsonValue.length > 60) return `<${jsonValue.length} chars>`;
      return jsonValue;
    });
    return String(compact).slice(0, maxLength);
  } catch {
    return "(unserializable)";
  }
}

function sniffImageMimeType(bytes) {
  if (bytes.length < 12) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.slice(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (bytes.slice(0, 4).toString("latin1") === "RIFF" && bytes.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";
}

async function autoReplyPendingMessages(env, runtime, options = {}) {
  if (String(env.WEIXIN_AUTO_REPLY || "").trim().toLowerCase() === "false") {
    return { status: "disabled", pending: 0, sent: 0 };
  }

  // 空闲轮询只读几百字节的待回复标志，不再每轮全量下载消息目录
  // （那会随消息积压滚雪球，实测能烧掉 30G+/天的 Cached Egress）。
  // 标志缺失（老部署首轮）或超过兜底间隔时仍做全量扫描。
  if (options.force !== true) {
    const flag = await loadPendingFlag(env, runtime.bot.id);
    if (flag && flag.pending !== true && !reconcileScanDue(flag)) {
      return { status: "idle", pending: 0, sent: 0 };
    }
  }

  const lock = await acquireAutoReplyLock(env, runtime.bot.id);
  if (!lock) return { status: "locked", pending: 0, sent: 0 };
  try {
  const cloudMessages = await loadCloudMessagesForBot(env, runtime.bot.id, 200);
  const pending = cloudMessages
    .filter(item => item.message.direction === "inbound" && item.message.needsReply === true && !item.message.repliedAt)
    .sort((a, b) => messageTime(a.message).localeCompare(messageTime(b.message)));

  if (pending.length === 0) {
    await savePendingFlag(env, runtime.bot.id, { pending: false, lastScanAt: new Date().toISOString() });
    return { status: "skipped", pending: 0, sent: 0 };
  }

  const latest = pending[pending.length - 1].message;
  const stopTyping = await startIlinkTyping(runtime.bot?.botToken, latest.raw);
  try {
    const generation = await generateReply(env, runtime, cloudMessages, pending.map(item => item.message));
    const shortcutRequest = extractWeixinShortcutRequest(generation.text, generation.shortcutActions);
    const replyText = shortcutRequest.text;
    const replyItems = await buildLocalReplyOutbox(replyText, runtime);
    if (replyItems.length === 0) return { status: "skipped_empty_reply", pending: pending.length, sent: 0 };

    let deferredShortcut = null;
    if (shortcutRequest.action) {
      try {
        // 先创建命令并（如需结果）挂稳续跑，但暂不发运行通知。首条微信
        // 回复真正送达并写入云消息后，下面才会调用 shortcut-deliver。
        deferredShortcut = await prepareWeixinShortcut(
          env,
          runtime,
          shortcutRequest.action,
          generation.messages,
          replyText,
        );
      } catch (err) {
        console.warn(`[weixin-assistant] 快捷动作准备失败 bot=${runtime.bot.id}: ${errorMessage(err)}`);
      }
    } else if (shortcutRequest.requestedName) {
      console.warn(`[weixin-assistant] 快捷动作不存在 bot=${runtime.bot.id}: ${shortcutRequest.requestedName}`);
    }

    const replyExternalId = `reply_${Date.now()}_raw_${Math.random().toString(36).slice(2)}`;
    // 首条送达后立刻把待回复消息标记为已回复：媒体回复耗时长，若函数在
    // 中途被平台掐断，下一轮不会把整段回复重新生成再发一遍（宁可丢
    // 后续分段，也不重复轰炸对方）。
    let markedReplied = false;
    const markPendingReplied = async () => {
      if (markedReplied) return;
      markedReplied = true;
      const repliedAt = new Date().toISOString();
      for (const item of pending) {
        await putObject(env, item.path, JSON.stringify({
          ...item.message,
          repliedAt,
          replyExternalId,
          replyExternalIds: [replyExternalId],
        }, null, 2), "application/json");
      }
    };

    const sendResults = [];
    const sendErrors = [];
    for (let i = 0; i < replyItems.length; i += 1) {
      if (i > 0) await sleep(600);
      try {
        const item = replyItems[i];
        const sendResult = await sendLocalReplyItem(runtime.bot?.botToken, latest.raw, item);
        sendResults.push(sendResult);
        if (sendResults.length === 1) await markPendingReplied();
      } catch (err) {
        sendErrors.push(`第${i + 1}条发送失败: ${errorMessage(err)}`);
      }
    }

    if (sendResults.length === 0) throw new Error(sendErrors[0] || "send_weixin_reply_failed");

    await storeOutgoingMessage(env, runtime, replyExternalId, replyText, {
      sentCount: sendResults.length,
      failedCount: sendErrors.length,
      sendResults,
      ...(deferredShortcut ? { shortcutCommandId: deferredShortcut.commandId } : {}),
    });
    if (deferredShortcut) {
      const delivered = await deliverWeixinShortcut(env, deferredShortcut.commandId).catch(err => ({
        ok: false,
        error: errorMessage(err),
      }));
      if (!delivered.ok) sendErrors.push(`快捷动作通知失败: ${delivered.error || "unknown"}`);
    }
    await clearPendingFlagIfCovered(env, runtime.bot.id, pending);

    return {
      status: sendErrors.length ? "partial_sent" : "sent",
      pending: pending.length,
      sent: sendResults.length,
      failed: sendErrors.length,
      error: sendErrors[0],
    };
  } finally {
    await stopTyping();
  }
  } finally {
    await releaseAutoReplyLock(env, lock);
  }
}

async function acquireAutoReplyLock(env, botId) {
  const path = `${LOCK_PREFIX}/${sanitizePathPart(botId)}.json`;
  const owner = `${assistantInstanceId}-${Date.now()}`;
  const now = Date.now();
  const existing = await getObjectJson(env, path).catch(() => null);
  const existingExpiresAt = Date.parse(existing?.expiresAt || "");
  if (
    existing?.owner
    && existing.owner !== owner
    && Number.isFinite(existingExpiresAt)
    && existingExpiresAt > now
  ) {
    return null;
  }

  const lock = {
    format: "ai-phone-weixin-auto-reply-lock",
    version: 1,
    botId,
    owner,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AUTO_REPLY_LOCK_TTL_MS).toISOString(),
  };
  await putObject(env, path, JSON.stringify(lock, null, 2), "application/json");
  await sleep(300);

  const verify = await getObjectJson(env, path).catch(() => null);
  if (verify?.owner !== owner) return null;
  return { path, owner, botId };
}

async function releaseAutoReplyLock(env, lock) {
  const current = await getObjectJson(env, lock.path).catch(() => null);
  if (current?.owner !== lock.owner) return;
  await putObject(env, lock.path, JSON.stringify({
    ...current,
    releasedAt: new Date().toISOString(),
    expiresAt: new Date(0).toISOString(),
  }, null, 2), "application/json").catch(() => {});
}

async function generateReply(env, runtime, cloudMessages, pendingMessages) {
  const apiConfig = runtime.apiConfig || {};
  const preset = runtime.preset || null;

  const runtimeCreatedAt = Date.parse(runtime.createdAt || "") || 0;
  const cloudHistory = cloudMessages
    .map(item => item.message)
    .filter(message => {
      const ts = Date.parse(messageTime(message));
      return Number.isFinite(ts) && ts > runtimeCreatedAt;
    })
    .sort((a, b) => messageTime(a).localeCompare(messageTime(b)));

  const imageAttachments = await loadVisionImageAttachments(env, runtime, [...cloudHistory, ...pendingMessages]);
  // 小手机组装完会合并相邻同 role 的块（llm-prompt-assembler 收尾那一步），于是
  // 「一轮」= user 一条 + assistant 一条。不合并的话微信每条消息都是独立的一条
  // LLM 消息，模型看到的轮次粒度就从「轮」退化成「条」。
  const messages = mergeAdjacentSameRoleMessages(
    normalizeLlmMessages(buildRuntimePromptMessages(runtime, cloudHistory, pendingMessages, imageAttachments)),
  );
  const shortcutActions = await loadWeixinShortcutActions(env);
  appendWeixinShortcutCapability(messages, shortcutActions);

  const request = buildChatCompletionRequest(apiConfig, preset, messages);
  // LLM 调用必须有超时：预留 ~30s 给后续的媒体生成与发送。
  // 超时会抛错并正常释放锁（好过被平台掐掉后锁滞留）。
  const budget = remainingReplyBudgetMs();
  const llmTimeoutMs = Number.isFinite(budget)
    ? Math.min(120_000, Math.max(20_000, budget - 30_000))
    : 150_000;
  const res = await fetchWithTimeout(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  }, llmTimeoutMs);
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`LLM returned non-json: ${text.slice(0, 200)}`);
  }
  return {
    text: cleanReplyText(extractOpenAiCompatibleText(data)),
    messages,
    shortcutActions,
  };
}

async function supabaseRest(env, path, init = {}) {
  const base = normalizeRequiredUrl(env.SUPABASE_URL, "SUPABASE_URL");
  return fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...supabaseHeaders(env),
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
}

async function loadWeixinShortcutActions(env) {
  try {
    const response = await supabaseRest(
      env,
      "push_bridge_config?user_id=eq.owner&select=shortcut_actions&limit=1",
    );
    if (!response.ok) return [];
    const rows = await response.json().catch(() => []);
    const raw = Array.isArray(rows?.[0]?.shortcut_actions) ? rows[0].shortcut_actions : [];
    return raw.map(action => {
      const resultMode = ["none", "text", "image"].includes(String(action?.resultMode))
        ? String(action.resultMode)
        : "none";
      return {
        actionId: String(action?.actionId || "").trim(),
        name: String(action?.name || "").trim(),
        shortcutName: String(action?.shortcutName || "").trim(),
        description: String(action?.description || "").trim(),
        resultMode,
        expiresInSeconds: Math.max(30, Math.min(900, Number(action?.expiresInSeconds) || 120)),
      };
    }).filter(action => action.actionId && action.name && action.shortcutName).slice(0, 20);
  } catch {
    return [];
  }
}

function appendWeixinShortcutCapability(messages, actions) {
  if (!Array.isArray(actions) || actions.length === 0) return;
  // 老运行包会声明“微信里所有工具都不可用”。这里把它收窄为“原生工具
  // 不可用”，随后下发当前个人云中实际登记的 iPhone 快捷动作目录。
  for (const message of messages) {
    if (message?.role !== "system" || typeof message.content !== "string") continue;
    if (!message.content.includes("<tool_availability>")) continue;
    message.content = message.content.replace(
      /<tool_availability>[\s\S]*?<\/tool_availability>/g,
      "<tool_availability>当前对话正通过微信进行：原生工具调用不可用；但下方明确列出的 iPhone 快捷动作可以使用。不要输出其他工具调用格式。</tool_availability>",
    );
  }
  const menu = actions.map(action => action.description
    ? `「${action.name}」（${action.description.slice(0, 40)}）`
    : `「${action.name}」`).join("、");
  messages.push({
    role: "system",
    content: "（可选能力：你可以请求在对方的 iPhone 上执行这些快捷动作：" + menu
      + "。确有需要时，在回复中单独一行输出【快捷动作：动作名】，动作名必须与上面完全一致；"
      + "系统会先把你本轮的其他话发到微信，再提示对方运行。会回传结果的动作，结果之后会自动交给你继续回复。"
      + "不需要就不要输出，也不要解释本条说明。）",
  });
}

export function extractWeixinShortcutRequest(text, actions = []) {
  const raw = String(text || "");
  const match = raw.match(/【快捷动作[：:]\s*([^】\n]{1,60})】/);
  if (!match) return { text: raw.trim(), requestedName: "", action: null };
  const requestedName = match[1].trim();
  const cleaned = raw
    .replace(/【快捷动作[：:][^】\n]{1,60}】/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim() || "……";
  const action = actions.find(item => String(item?.name || "") === requestedName) || null;
  return { text: cleaned, requestedName, action };
}

function compactContinuationMessages(messages) {
  return messages.map(message => {
    if (!Array.isArray(message?.content)) return { ...message };
    const content = message.content.map(part => {
      if (part?.type === "image_url") {
        return { type: "text", text: "（上一轮微信图片已由角色看过，此处不重复携带原图。）" };
      }
      return part;
    });
    return { ...message, content };
  });
}

export function encryptWeixinPushJobPayload(plain, secret) {
  const key = createHash("sha256").update(`${secret}:push-job-v1`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: encrypted.toString("base64"),
  };
}

async function loadPushPayloadKey(env) {
  const response = await supabaseRest(env, "push_server_config?id=eq.main&select=payload_key&limit=1");
  if (!response.ok) throw new Error(`push_config_http_${response.status}`);
  const rows = await response.json().catch(() => []);
  const key = String(rows?.[0]?.payload_key || "");
  if (!key) throw new Error("push_payload_key_missing");
  return key;
}

async function callPersonalPushGateway(env, action, body) {
  const base = normalizeRequiredUrl(env.SUPABASE_URL, "SUPABASE_URL");
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const configResponse = await supabaseRest(env, "push_server_config?id=eq.main&select=site_origin&limit=1");
  const configRows = configResponse.ok ? await configResponse.json().catch(() => []) : [];
  const siteOrigin = String(configRows?.[0]?.site_origin || "").trim();
  const response = await fetch(`${base}/functions/v1/ai-phone-push?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-phone-service-key": serviceKey,
      "x-ai-phone-origin": siteOrigin,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok !== true) {
    throw new Error(String(data?.error || `push_gateway_http_${response.status}`));
  }
  return data;
}

async function prepareWeixinShortcut(env, runtime, action, firstMessages, firstReply) {
  const created = await callPersonalPushGateway(env, "shortcut-create", {
    actionId: action.actionId,
    actionName: action.name,
    shortcutName: action.shortcutName,
    arguments: {},
    resultMode: action.resultMode,
    expiresInSeconds: action.expiresInSeconds,
    deferDelivery: true,
  });
  const commandId = String(created?.command?.id || "");
  if (!commandId) throw new Error("shortcut_command_id_missing");

  if (action.resultMode !== "none") {
    try {
    const messages = [
      ...compactContinuationMessages(firstMessages),
      { role: "assistant", content: firstReply },
      { role: "user", content: WEIXIN_SHORTCUT_RESULT_MARKER },
      ...(action.resultMode === "image"
        ? [{ role: "user", content: WEIXIN_SHORTCUT_IMAGE_MARKER }]
        : []),
    ];
    const request = buildChatCompletionRequest(runtime.apiConfig || {}, runtime.preset || null, messages);
    const payload = {
      request: { ...request, providerKind: "openai-compatible" },
      shortcut: {
        commandId,
        actionName: action.name,
        resultMode: action.resultMode,
        resultMarker: WEIXIN_SHORTCUT_RESULT_MARKER,
        ...(action.resultMode === "image" ? { imageMarker: WEIXIN_SHORTCUT_IMAGE_MARKER } : {}),
        style: "text",
      },
      notify: { title: runtime.character?.name || "小手机", url: "/" },
      weixin: { botId: runtime.bot?.id || "", force: true },
      merge: {
        sessionId: runtime.session?.id || null,
        regexes: Array.isArray(runtime.regexes) ? runtime.regexes : [],
        characterName: runtime.character?.name || "小手机",
        userName: runtime.userIdentity?.name || "用户",
        appId: "chat",
        appTags: ["chat", "text"],
        shortcutCommandId: commandId,
        weixinShortcut: true,
      },
    };
    // 第一轮正文直接固化在加密快照内，续跑时不再依赖微信消息文件是否仍存在。
    const payloadText = JSON.stringify(payload);
    const payloadKey = await loadPushPayloadKey(env);
    const triggerKey = `shortcut:${commandId}`;
    await supabaseRest(
      env,
      `push_jobs?user_id=eq.owner&trigger_key=eq.${encodeURIComponent(triggerKey)}`,
      { method: "DELETE" },
    ).catch(() => undefined);
    const armed = await supabaseRest(env, "push_jobs", {
      method: "POST",
      body: JSON.stringify([{
        id: `job_${randomUUID()}`,
        user_id: "owner",
        trigger_key: triggerKey,
        kind: "shortcut_resume",
        execute_at: new Date(Date.now() + (action.expiresInSeconds + 90) * 1000).toISOString(),
        status: "pending",
        result_note: "cloud_shortcut_resume",
        payload: encryptWeixinPushJobPayload(payloadText, payloadKey),
      }]),
    });
    if (!armed.ok) throw new Error(`shortcut_resume_arm_http_${armed.status}`);
    } catch (err) {
      // 续跑没挂稳就绝不通知手机执行，并把不可见的命令取消，避免它占住
      // pending 配额直到自然过期。
      await supabaseRest(
        env,
        `push_shortcut_commands?id=eq.${encodeURIComponent(commandId)}&status=eq.pending`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "cancelled",
            error: `微信结果续跑挂载失败：${errorMessage(err).slice(0, 120)}`,
            updated_at: new Date().toISOString(),
          }),
        },
      ).catch(() => undefined);
      throw err;
    }
  }

  return { commandId, actionName: action.name };
}

async function deliverWeixinShortcut(env, commandId) {
  try {
    const data = await callPersonalPushGateway(env, "shortcut-deliver", { commandId });
    return data?.delivered === true
      ? { ok: true }
      : { ok: false, error: "shortcut_notification_not_delivered" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

// 视觉附件：遵循 API 设置的图像识别开关（runtime.promptContext.enableVision）
// 与聊天信息页的传入图片数（runtime.session.visionImagePromptLimit，默认 1）。
// 只给最近的 N 条带图消息加载图片，其余按占位文本处理。
async function loadVisionImageAttachments(env, runtime, mergedMessages) {
  const attachments = new Map();
  if (runtime.promptContext?.enableVision !== true) return attachments;
  const limit = clampVisionImagePromptLimit(runtime.session?.visionImagePromptLimit);
  if (limit <= 0) return attachments;

  const seen = new Set();
  const candidates = [];
  for (const message of mergedMessages) {
    if (!message?.imagePath || !message.externalId || seen.has(message.externalId)) continue;
    seen.add(message.externalId);
    candidates.push(message);
  }
  candidates.sort((a, b) => messageTime(a).localeCompare(messageTime(b)));

  for (const message of candidates.slice(-limit)) {
    try {
      const res = await fetch(storageObjectUrl(env, message.imagePath), {
        headers: supabaseHeaders(env),
        cache: "no-store",
      });
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) continue;
      const mime = message.imageMime || "image/jpeg";
      attachments.set(message.externalId, `data:${mime};base64,${bytes.toString("base64")}`);
    } catch {
      // 单张图加载失败不影响整体回复
    }
  }
  return attachments;
}

function clampVisionImagePromptLimit(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(10, n);
}

export function buildRuntimePromptMessages(runtime, cloudHistory, pendingMessages, imageAttachments = new Map()) {
  const template = runtime.promptContext?.promptTemplate;
  if (!template || !Array.isArray(template.beforeMessages) || !Array.isArray(template.afterMessages)) {
    throw new Error("runtime_missing_prompt_template: 运行包缺少轻量提示词模板，请先在小手机内重新同步运行包。");
  }

  const collected = [];
  const seenExternalIds = new Set();
  for (const message of [...cloudHistory, ...pendingMessages]) {
    if (!message?.externalId || seenExternalIds.has(message.externalId)) continue;
    seenExternalIds.add(message.externalId);
    const promptMessage = cloudStoredMessageToPromptMessage(runtime, message, imageAttachments);
    if (promptMessage) collected.push(promptMessage);
  }

  collected.sort((a, b) => {
    const at = a._createdAt || "";
    const bt = b._createdAt || "";
    if (at !== bt) return at.localeCompare(bt);
    return String(a._externalId || "").localeCompare(String(b._externalId || ""));
  });

  const historyMessages = renderHistoryPromptMessages(collected);

  // v2 运行包：深度注入（世界书 position=4 / 预设 injection_position≠0）不再钉死在
  // 模板顶部，而是按「已烘焙历史 + 新微信消息」这条完整历史重新定位到「倒数第 depth
  // 条」之前——与小手机每次生成都重算深度的行为一致。
  // 必须把 bakedHistoryMessages 一起算进去：只拿新消息定位的话，新消息条数少于 depth
  // 时注入块插不回旧历史内部，只能贴在它下面。
  // 老运行包（v1，以及没有 bakedHistoryMessages 的过渡版本）自动退回旧拼接。
  const usesDepthTemplate = Array.isArray(template.structuralMessages)
    && Array.isArray(template.bakedHistoryMessages)
    && Array.isArray(template.depthSegments);
  if (!usesDepthTemplate) {
    return [...template.beforeMessages, ...historyMessages, ...template.afterMessages];
  }
  const fullHistory = [...template.bakedHistoryMessages, ...historyMessages];
  return [
    ...template.structuralMessages,
    ...interleaveDepthSegments(template.depthSegments, fullHistory),
    ...template.afterMessages,
  ];
}

/**
 * 把 depth 段插回历史：depth = d 表示「距离底部第 d 条」，即插在下标 total - d 之前。
 * d 超过历史长度时贴到历史最上方（能给到的最接近位置）。
 * 与小手机 lib/weixin-cloud-sync.ts 的同名函数是同一套规则，改一处要一起改。
 */
export function interleaveDepthSegments(segments, history) {
  const total = history.length;
  const buckets = new Map();
  const ordered = (Array.isArray(segments) ? segments : [])
    .filter(segment => Array.isArray(segment?.messages) && segment.messages.length > 0)
    .sort((a, b) => (Number(b.depth) || 0) - (Number(a.depth) || 0));

  for (const segment of ordered) {
    const depth = Number(segment.depth) || 0;
    const index = depth <= 0 ? total : (depth >= total ? 0 : total - depth);
    const bucket = buckets.get(index) || [];
    bucket.push(...segment.messages);
    buckets.set(index, bucket);
  }

  const out = [];
  for (let i = 0; i <= total; i += 1) {
    const bucket = buckets.get(i);
    if (bucket) out.push(...bucket);
    if (i < total) out.push(history[i]);
  }
  return out;
}

/** 与小手机 llm-prompt-assembler 收尾的合并规则对齐：相邻同 role 的纯文本消息并成一条 */
export function mergeAdjacentSameRoleMessages(messages) {
  const out = [];
  for (const message of messages) {
    const prev = out[out.length - 1];
    if (
      prev
      && prev.role === message.role
      && prev.role !== "tool"
      && typeof prev.content === "string"
      && typeof message.content === "string"
      && !prev.toolCalls?.length
      && !message.toolCalls?.length
    ) {
      const merged = [prev.content, message.content].map(part => part.trim()).filter(Boolean).join("\n\n");
      out[out.length - 1] = { ...prev, content: merged };
      continue;
    }
    out.push(message);
  }
  return out;
}

/**
 * 渲染历史消息：时间戳挂在正文前面，但相邻同 role 且时间戳相同的不再重复标注
 * （对齐小手机 pushChronologicalShortTermBlocks 的 showTs 规则）——不然合并之后
 * 一段里会连着出现好几行一模一样的时间。
 */
export function renderHistoryPromptMessages(collected) {
  const out = [];
  let prevTimestamp = "";
  let prevRole = "";
  for (const item of collected) {
    const showTimestamp = Boolean(item._timestamp) && !(item._timestamp === prevTimestamp && item.role === prevRole);
    prevTimestamp = item._timestamp;
    prevRole = item.role;

    const text = showTimestamp && item._text ? `${item._timestamp}\n${item._text}`
      : showTimestamp ? item._timestamp
      : item._text;
    if (!text.trim() && !item._imageDataUrl) continue;

    out.push({
      role: item.role,
      content: item._imageDataUrl
        ? [
          ...(text.trim() ? [{ type: "text", text }] : []),
          { type: "image_url", image_url: { url: item._imageDataUrl, detail: "low" } },
        ]
        : text,
    });
  }
  return out;
}

function cloudStoredMessageToPromptMessage(runtime, message, imageAttachments = new Map()) {
  const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
  const text = String(message.content || "");
  const imageDataUrl = message.externalId ? imageAttachments.get(message.externalId) : undefined;
  if (!text.trim() && !imageDataUrl) return null;
  return {
    role,
    _text: text,
    _timestamp: runtime.promptContext?.timeAware === true
      ? formatPromptTimestamp(messageTime(message), runtime.promptContext)
      : "",
    _imageDataUrl: imageDataUrl,
    _createdAt: messageTime(message) || new Date().toISOString(),
    _externalId: message.externalId || "",
  };
}

// 与小手机 lib/prompt-time.ts · formatPromptTimestamp 对齐。
// 云函数跑在 UTC，必须按运行包下发的 promptTimeZone（用户设备时区）格式化，
// 否则新微信消息的时间戳会和运行包里烘焙的历史时间戳差几个时区。
// 老运行包没有该字段时退回运行环境本地时区，行为与改动前一致。
export function formatPromptTimestamp(value, promptContext) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  const timeZone = typeof promptContext?.promptTimeZone === "string" ? promptContext.promptTimeZone.trim() : "";
  const zoneSuffix = timeZone && promptContext?.promptTimestampIncludeZone === true ? ` ${timeZone}` : "";
  const parts = zonedDateParts(date, timeZone);
  if (!parts) return "";
  return `(${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${zoneSuffix})`;
}

function zonedDateParts(date, timeZone) {
  const pad = n => n < 10 ? `0${n}` : `${n}`;
  if (timeZone) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      });
      const out = {};
      for (const part of formatter.formatToParts(date)) {
        if (["year", "month", "day", "hour", "minute"].includes(part.type)) out[part.type] = part.value;
      }
      if (out.year && out.month && out.day && out.hour && out.minute) return out;
    } catch {
      // 时区名无效（老数据/手输）→ 落回运行环境本地时区
    }
  }
  return {
    year: `${date.getFullYear()}`,
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    hour: pad(date.getHours()),
    minute: pad(date.getMinutes()),
  };
}

function buildChatCompletionRequest(apiConfig, preset, messages) {
  const baseUrl = determineBaseUrl(apiConfig);
  const apiKey = String(apiConfig.apiKey || "").trim();
  const model = String(apiConfig.defaultModel || "").trim();
  if (!baseUrl || !apiKey || !model) throw new Error("runtime_missing_api_config: 请检查角色绑定的 API 配置并重新同步运行包");
  if (apiConfig.provider === "Anthropic" && !apiConfig.baseUrl) {
    throw new Error("local_auto_reply_provider_not_supported: 暂不支持直连 Anthropic，请使用 OpenAI 兼容中转或自定义 API");
  }
  if (apiConfig.provider === "Google" && !apiConfig.baseUrl) {
    throw new Error("local_auto_reply_provider_not_supported: 暂不支持直连 Google Gemini，请使用 OpenAI 兼容中转或自定义 API");
  }

  const body = {
    model,
    messages,
    temperature: numberOrDefault(preset?.temperature, 0.8),
    top_p: numberOrDefault(preset?.top_p, 1),
    frequency_penalty: numberOrDefault(preset?.frequency_penalty, 0),
    presence_penalty: numberOrDefault(preset?.presence_penalty, 0),
  };
  if (Number(preset?.openai_max_tokens) > 0) body.max_tokens = Number(preset.openai_max_tokens);
  if (Number.isFinite(Number(preset?.repetition_penalty)) && Number(preset.repetition_penalty) !== 1) {
    body.repetition_penalty = Number(preset.repetition_penalty);
  }
  if (Number(preset?.top_k) > 0) body.top_k = Number(preset.top_k);
  if (Number(preset?.min_p) > 0) body.min_p = Number(preset.min_p);
  if (Number(preset?.top_a) > 0) body.top_a = Number(preset.top_a);

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  if (baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://aivirtualphone.local";
    headers["X-Title"] = "AI Virtual Phone";
  }

  return { url: buildChatCompletionsUrl(baseUrl), headers, body };
}

function determineBaseUrl(apiConfig) {
  const explicit = String(apiConfig.baseUrl || "").trim();
  if (explicit) return normalizeRequiredUrl(explicit, "API_BASE_URL");
  switch (apiConfig.provider) {
    case "OpenAI": return "https://api.openai.com/v1";
    case "DeepSeek": return "https://api.deepseek.com/v1";
    case "Groq": return "https://api.groq.com/openai/v1";
    case "OpenRouter": return "https://openrouter.ai/api/v1";
    case "Moonshot": return "https://api.moonshot.cn/v1";
    case "Zhipu": return "https://open.bigmodel.cn/api/paas/v4";
    case "SiliconFlow": return "https://api.siliconflow.cn/v1";
    case "TogetherAI": return "https://api.together.xyz/v1";
    case "Anthropic": return "https://api.anthropic.com/v1";
    case "Google": return "https://generativelanguage.googleapis.com/v1beta";
    default: return "";
  }
}

function buildChatCompletionsUrl(baseUrl) {
  return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function normalizeLlmMessages(messages) {
  return messages
    .map(message => {
      const role = message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user";
      const content = normalizeMessageContent(message?.content);
      const hasContent = typeof content === "string" ? Boolean(content) : content.length > 0;
      return hasContent ? { role, content } : null;
    })
    .filter(Boolean);
}

// 字符串原样返回；数组内容保留 text 与 image_url 两类合法分段
// （多模态视觉消息），若数组里没有图片则压平成纯文本以兼容更多模型。
function normalizeMessageContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = content
    .map(part => {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return { type: "text", text: part.text };
      }
      if (part?.type === "image_url" && typeof part.image_url?.url === "string" && part.image_url.url) {
        return { type: "image_url", image_url: part.image_url };
      }
      return null;
    })
    .filter(Boolean);
  if (parts.some(part => part.type === "image_url")) return parts;
  return parts
    .map(part => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractOpenAiCompatibleText(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
  }
  return "";
}

// 时间戳剥离必须与小手机同款（lib/api-helpers.ts · stripHallucinatedTimestamps）：
// 括号内以完整日期时间开头的一律剥掉，兼容带秒、带时区/星期尾巴与全角括号。
// 旧版只认半角、不带尾巴的 (YYYY-MM-DD HH:MM)，而运行包烘焙的历史时间戳在
// 角色时区与系统时区不同时带时区名，模型照抄后一条都拦不住。
export function cleanReplyText(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*/g, "")
    .replace(/\(system\s*time\s*[:：][^)]*\)\s*/gi, "")
    .trim();
}

async function buildLocalReplyOutbox(text, runtime) {
  const out = [];
  const cleaned = cleanWeixinDisplayText(text);
  if (!cleaned) return out;

  const paragraphs = splitLocalReplyText(cleaned);
  for (const paragraph of paragraphs) {
    const items = await buildLocalReplyItemsFromSegment(paragraph, runtime);
    out.push(...items);
  }
  return out.filter(item => item.kind !== "text" || item.text);
}

async function buildLocalReplyItemsFromSegment(segment, runtime) {
  const value = cleanWeixinDisplayText(segment);
  if (!value) return [];

  const media = findFirstLocalMediaProtocol(value);
  if (!media) return [{ kind: "text", text: value }];

  // 媒体开关：本地 CLI 用 setMediaReplyEnabled（默认开）；云端由运行包
  // promptContext.mediaReply 下发（随小手机同步自动生效，无需改函数）。
  const mediaAllowed = mediaReplyEnabled || runtime?.promptContext?.mediaReply === true;
  if (!mediaAllowed) {
    const out = [];
    const before = value.slice(0, media.index).trim();
    const after = value.slice(media.index + media.raw.length).trim();
    if (before) out.push(...await buildLocalReplyItemsFromSegment(before, runtime));
    const degraded = media.kind === "voice" ? cleanVoiceTranscript(media.label) : media.raw;
    if (degraded) out.push({ kind: "text", text: degraded });
    if (after) out.push(...await buildLocalReplyItemsFromSegment(after, runtime));
    return out;
  }

  const out = [];
  const before = value.slice(0, media.index).trim();
  const after = value.slice(media.index + media.raw.length).trim();
  if (before) out.push(...await buildLocalReplyItemsFromSegment(before, runtime));
  out.push(await buildLocalMediaReplyItem(media, runtime));
  if (after) out.push(...await buildLocalReplyItemsFromSegment(after, runtime));
  return out;
}

function splitLocalReplyText(text) {
  const cleaned = cleanWeixinDisplayText(text);
  if (!cleaned) return [];

  const paragraphParts = cleaned.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  if (paragraphParts.length > 1) return paragraphParts;

  const lineParts = cleaned.split(/\n+/).map(part => part.trim()).filter(Boolean);
  if (lineParts.length > 1 && lineParts.every(part => part.length <= 160)) return lineParts;
  return [cleaned];
}

let mediaReplyEnabled = true;

// 关闭后媒体协议不再生成图片/语音（云端 Deno 环境未验证媒体路径前先降级为文字）。
export function setMediaReplyEnabled(enabled) {
  mediaReplyEnabled = enabled !== false;
}

const LOCAL_MEDIA_PROTOCOLS = [
  { kind: "red_packet", regex: /\[红包\s*[：:]\s*\d+(?:\.\d+)?(?:\s*[：:]\s*\d+)?\s*[：:][^\]]*\]/ },
  { kind: "transfer", regex: /\[转账\s*[：:]\s*\d+(?:\.\d+)?\s*[：:][^\]]*\]/ },
  { kind: "location", regex: /\[位置\s*[：:]\s*([^\]]+)\]/ },
  { kind: "music", regex: /\[音乐(?:分享)?\s*[：:]\s*([^\]]+)\]/ },
  { kind: "voice", regex: /\[语音条\s*[：:]\s*([^\]]+)\]/ },
  { kind: "sticker", regex: /\[表情包\s*[：:]\s*([^\]]+)\]/ },
  { kind: "photo", regex: /\[照片\s*[：:]\s*(?:(使用参考图|不使用参考图)\s*[：:]\s*)?([^\]]+)\]/ },
];

function findFirstLocalMediaProtocol(text) {
  let best = null;
  for (const entry of LOCAL_MEDIA_PROTOCOLS) {
    const match = String(text || "").match(entry.regex);
    if (!match || match.index === undefined) continue;
    if (!best || match.index < best.index) {
      const label = entry.kind === "photo"
        ? String(match[2] || match[1] || match[0]).trim()
        : String(match[1] || match[0]).trim();
      best = {
        kind: entry.kind,
        raw: match[0],
        label,
        index: match.index,
        useReferenceImage: entry.kind === "photo" ? match[1] === "使用参考图" : undefined,
      };
    }
  }
  return best;
}

async function buildLocalMediaReplyItem(media, runtime) {
  if (media.kind === "sticker") {
    const stickerImage = resolveRuntimeStickerImage(runtime, media.label);
    if (stickerImage) {
      return { kind: "image", imageDataUrl: stickerImage, label: media.raw };
    }
  }
  if (media.kind === "photo") {
    const generatedImage = await generateLocalImageReplyDataUrl(media, runtime).catch((err) => {
      console.warn(`[${time()}] 生图失败，改用照片占位图：${errorMessage(err)}`);
      return "";
    });
    if (generatedImage) {
      return { kind: "image", imageDataUrl: generatedImage, label: media.raw };
    }
  }
  if (media.kind === "voice") {
    const transcript = cleanVoiceTranscript(media.label);
    const duration = estimateVoiceDuration(transcript);
    const fallbackImageDataUrl = getTemplateImageDataUrl("voice");
    const audioDataUrl = await synthesizeVoiceDataUrl(transcript, runtime?.voiceConfig).catch(() => "");
    if (audioDataUrl) {
      return { kind: "voice", audioDataUrl, transcript, duration, fallbackImageDataUrl };
    }
    return { kind: "image", imageDataUrl: fallbackImageDataUrl, label: media.raw };
  }
  return {
    kind: "image",
    imageDataUrl: getTemplateImageDataUrl(media.kind),
    label: media.raw,
  };
}

async function generateLocalImageReplyDataUrl(media, runtime) {
  const config = getRuntimeImageGenerationConfig(runtime);
  const description = String(media?.label || "").trim();
  if (!config || !description) return "";

  // 剩余预算不足以完成一次生图时直接跳过（外层会降级为照片模板卡），
  // 保证整轮回复在云函数墙钟内完成、锁能正常释放。
  const budget = remainingReplyBudgetMs();
  if (budget < 50_000) {
    console.warn(`[weixin-assistant] 剩余预算不足（${Math.round(budget / 1000)}s），本轮跳过真实生图，改用照片模板卡`);
    return "";
  }
  const timeoutMs = Number.isFinite(budget)
    ? Math.min(IMAGE_GENERATION_TIMEOUT_MS, Math.max(20_000, budget - 20_000))
    : IMAGE_GENERATION_TIMEOUT_MS;

  const prompt = mergeImagePrompt(description, config.extraPrompt);
  const referenceImageDataUrl = media.useReferenceImage === true
    ? String(config.referenceImageDataUrl || "").trim()
    : "";
  return generateImageDataUrlDirect({ config, prompt, referenceImageDataUrl, timeoutMs });
}

function getRuntimeImageGenerationConfig(runtime) {
  const raw = runtime?.promptContext?.imageGeneration || runtime?.imageGeneration;
  if (!raw || raw.enabled !== true) return null;
  const apiKey = String(raw.apiKey || "").trim();
  const baseUrl = String(raw.baseUrl || "").trim();
  const model = String(raw.model || "").trim();
  if (!apiKey || !baseUrl || !model) return null;
  return {
    apiKey,
    baseUrl,
    model,
    size: String(raw.size || "1024x1024").trim(),
    quality: String(raw.quality || "auto").trim(),
    extraPrompt: String(raw.extraPrompt || "").trim(),
    referenceImageDataUrl: String(raw.referenceImageDataUrl || "").trim(),
  };
}

function mergeImagePrompt(description, extraPrompt) {
  const main = String(description || "").trim();
  const extra = String(extraPrompt || "").trim();
  return extra ? `${main}\n\n${extra}` : main;
}

async function generateImageDataUrlDirect({ config, prompt, referenceImageDataUrl, timeoutMs = IMAGE_GENERATION_TIMEOUT_MS }) {
  const hasReference = Boolean(referenceImageDataUrl);
  const url = buildImageGenerationUrl(config.baseUrl, hasReference ? "edits" : "generations");
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  let body;

  if (hasReference) {
    const converted = dataUrlToImageBlob(referenceImageDataUrl);
    if (!converted) throw new Error("参考图格式无效");
    const form = new FormData();
    form.set("model", config.model);
    form.set("prompt", prompt);
    if (config.size && config.size !== "auto") form.set("size", config.size);
    if (config.quality && config.quality !== "auto") form.set("quality", config.quality);
    form.append("image", converted.blob, `reference.${imageExtension(converted.mimeType)}`);
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: config.model,
      prompt,
      ...(config.size && config.size !== "auto" ? { size: config.size } : {}),
      ...(config.quality && config.quality !== "auto" ? { quality: config.quality } : {}),
    });
  }

  const response = await fetchWithTimeout(url, { method: "POST", headers, body }, timeoutMs);
  return parseImageGenerationResponseDataUrl(response);
}

function normalizeImageBaseUrl(baseUrl) {
  return String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/images\/(?:generations|edits)$/i, "")
    .replace(/\/images$/i, "");
}

function buildImageGenerationUrl(baseUrl, mode) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/images\/(?:generations|edits)$/i.test(trimmed)) {
    return trimmed.replace(/\/images\/(?:generations|edits)$/i, `/images/${mode}`);
  }
  if (/\/images$/i.test(trimmed)) return `${trimmed}/${mode}`;
  return `${normalizeImageBaseUrl(trimmed)}/images/${mode}`;
}

function dataUrlToImageBlob(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  const mimeType = match[1] || "image/png";
  return {
    blob: new Blob([Buffer.from(match[2], "base64")], { type: mimeType }),
    mimeType,
  };
}

async function parseImageGenerationResponseDataUrl(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`生图 API 错误 ${response.status}: ${text.slice(0, 600)}`);
  }
  if (contentType.startsWith("image/")) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return `data:${contentType.split(";")[0] || "image/png"};base64,${bytes.toString("base64")}`;
  }

  const json = await response.json();
  const extracted = extractImageFromObject(json);
  if (!extracted) {
    throw new Error(`生图 API 返回中没有找到图片字段：${JSON.stringify(Object.keys(json || {})).slice(0, 200)}`);
  }
  if (extracted.kind === "url") return fetchRemoteImageAsDataUrl(extracted.url);
  return `data:${extracted.mimeType || "image/png"};base64,${extracted.b64}`;
}

async function fetchRemoteImageAsDataUrl(url) {
  const response = await fetchWithTimeout(url, {}, IMAGE_GENERATION_TIMEOUT_MS);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`图片 URL 下载失败 ${response.status}: ${text.slice(0, 160)}`);
  }
  const contentType = String(response.headers.get("content-type") || "image/png").split(";")[0] || "image/png";
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

function extractImageFromObject(data) {
  if (!data || typeof data !== "object") return null;
  const record = data;

  for (const key of ["b64_json", "base64", "b64", "image", "result"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      if (/^https?:\/\//i.test(value.trim())) return { kind: "url", url: value.trim() };
      const cleaned = cleanImageBase64(value);
      return { kind: "b64", ...cleaned };
    }
  }

  for (const key of ["url", "image_url"]) {
    const value = record[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      return { kind: "url", url: value.trim() };
    }
    if (value && typeof value === "object" && typeof value.url === "string" && /^https?:\/\//i.test(value.url.trim())) {
      return { kind: "url", url: value.url.trim() };
    }
  }

  for (const key of ["data", "images", "output", "content"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        if (/^https?:\/\//i.test(item.trim())) return { kind: "url", url: item.trim() };
        const cleaned = cleanImageBase64(item);
        return { kind: "b64", ...cleaned };
      }
      const nested = extractImageFromObject(item);
      if (nested) return nested;
    }
  }

  return null;
}

function cleanImageBase64(value) {
  const match = String(value || "").trim().match(/^data:([^;]+);base64,([\s\S]+)$/i);
  if (match) return { mimeType: match[1], b64: match[2] };
  return { b64: String(value || "").trim() };
}

function imageExtension(mimeType) {
  const subtype = String(mimeType || "image/png").split("/")[1] || "png";
  return subtype.replace("jpeg", "jpg");
}

function resolveRuntimeStickerImage(runtime, name) {
  const label = String(name || "").trim();
  if (!label) return "";
  const map = runtime?.promptContext?.customStickerMap || runtime?.customStickerMap || {};
  if (typeof map[label] === "string" && map[label].trim()) return map[label].trim();
  const foundKey = Object.keys(map).find(key => key.trim() === label);
  return foundKey && typeof map[foundKey] === "string" ? map[foundKey].trim() : "";
}

function cleanVoiceTranscript(text) {
  return String(text || "")
    .split(/\n+/)
    .map(line => {
      const bar = line.indexOf("|");
      return (bar >= 0 ? line.slice(0, bar) : line).trim();
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function estimateVoiceDuration(text) {
  return Math.max(2, Math.ceil(String(text || "").length / 4));
}

// 云函数免费档墙钟上限 150s、单轮预算 120s，媒体生成超时必须压在预算内；
// 本地助手同用此值（常见生图/TTS 服务 90s 内足够返回）。
const TTS_TIMEOUT_MS = 60_000;
const IMAGE_GENERATION_TIMEOUT_MS = 90_000;

async function synthesizeVoiceDataUrl(text, voiceConfig) {
  const cleanText = String(text || "").trim();
  if (!cleanText || !voiceConfig || voiceConfig.enableTTS !== true) return "";
  // 预算不足时跳过 TTS（外层降级为语音模板卡），保证整轮在墙钟内完成；
  // 实际请求超时同样按剩余预算收紧（预留 15s 给上传发送），避免擦到墙钟。
  const budget = remainingReplyBudgetMs();
  if (budget < 30_000) return "";
  const timeoutMs = Number.isFinite(budget)
    ? Math.min(TTS_TIMEOUT_MS, Math.max(10_000, budget - 15_000))
    : TTS_TIMEOUT_MS;
  const provider = String(voiceConfig.provider || "").trim();
  if (provider === "Minimax") return synthesizeMinimaxVoiceDataUrl(cleanText, voiceConfig, timeoutMs);
  if (provider === "OpenAI") return synthesizeOpenAIVoiceDataUrl(cleanText, voiceConfig, timeoutMs);
  return "";
}

async function synthesizeMinimaxVoiceDataUrl(text, config, timeoutMs = TTS_TIMEOUT_MS) {
  const apiKey = String(config.apiKey || "").trim();
  if (!apiKey) return "";
  const baseUrl = String(config.baseUrl || "https://api.minimaxi.com/v1").replace(/\/+$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/t2a_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model || "speech-01-turbo",
      text,
      stream: false,
      ...(config.languageBoost ? { language_boost: config.languageBoost } : {}),
      voice_setting: {
        voice_id: config.defaultVoice || "male-qn-qingse",
        speed: 1.0,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  }, timeoutMs);
  if (!response.ok) return "";
  const data = await response.json().catch(() => null);
  const hex = typeof data?.data?.audio === "string" ? data.data.audio : "";
  if (!hex || hex.length % 2 !== 0) return "";
  const audio = Buffer.alloc(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    audio[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  if (audio.length === 0) return "";
  return `data:audio/mpeg;base64,${audio.toString("base64")}`;
}

async function synthesizeOpenAIVoiceDataUrl(text, config, timeoutMs = TTS_TIMEOUT_MS) {
  const apiKey = String(config.apiKey || "").trim();
  if (!apiKey) return "";
  const baseUrl = String(config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model || "tts-1",
      input: text,
      voice: config.defaultVoice || "alloy",
      response_format: "mp3",
    }),
  }, timeoutMs);
  if (!response.ok) return "";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) return "";
  return `data:audio/mpeg;base64,${bytes.toString("base64")}`;
}

async function fetchWithTimeout(url, init, timeoutMs = TTS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cleanWeixinDisplayText(text) {
  let cleaned = cleanReplyText(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\[状态栏\][\s\S]*?\[\/状态栏\]/g, "")
    .replace(/\[内心\][\s\S]*?\[\/内心\]/g, "")
    .replace(/<summary>[\s\S]*?<\/summary>/gi, "")
    .replace(/\[[^\[\]:：\]\n]+[：:]\d+(?:\.\d+)?\]/g, (match) => {
      const name = match.slice(1).split(/[：:]/)[0]?.trim() || "";
      if (!name || /^\d+$/.test(name)) return match;
      if (["红包", "转账", "照片", "位置", "表情包", "引用", "语音", "音乐"].includes(name)) return match;
      return "";
    })
    .replace(/\[[^\]]*?(?:获取指令|获取工具)[：:][^\]]*\]/g, "")
    .replace(/\[[^\]]*?(?:执行动作|工具调用)[：:][^\]]*?[（(][\s\S]*?[)）]\]/g, "")
    .replace(/^\s*\[[^\]\n]*(?:好感度|占有欲|焦虑值|状态|心情|信任|羁绊|亲密|理智|压力|欲望)[^\]\n]*\]\s*$/gm, "");

  return cleaned
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !/^[)）]+$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendLocalReplyItem(botToken, raw, item) {
  if (item.kind === "image" && item.imageDataUrl) {
    return sendIlinkImageMessage(botToken, raw, item.imageDataUrl);
  }
  if (item.kind === "voice" && item.audioDataUrl) {
    return sendIlinkVoiceMessage(botToken, raw, item.audioDataUrl, item.duration);
  }
  if (item.kind === "voice" && item.fallbackImageDataUrl) {
    return sendIlinkImageMessage(botToken, raw, item.fallbackImageDataUrl);
  }
  if (item.kind === "file" && item.fileDataUrl) {
    return sendIlinkFileMessage(botToken, raw, item.fileDataUrl, item.fileName || "file.bin");
  }
  return sendIlinkTextMessage(botToken, raw, item.text || "");
}

async function startIlinkTyping(botToken, raw) {
  const toUserId = raw?.from_user_id;
  const contextToken = raw?.context_token;
  if (!botToken || !toUserId || !contextToken) return async () => {};

  let typingTicket = "";
  try {
    const cfg = await callIlinkJson("/ilink/bot/getconfig", botToken, {
      ilink_user_id: toUserId,
      context_token: contextToken,
      base_info: BASE_INFO,
    });
    typingTicket = typeof cfg?.typing_ticket === "string" ? cfg.typing_ticket : "";
  } catch {
    return async () => {};
  }

  if (!typingTicket) return async () => {};

  const sendTyping = (status) => callIlinkJson("/ilink/bot/sendtyping", botToken, {
    ilink_user_id: toUserId,
    typing_ticket: typingTicket,
    status,
    base_info: BASE_INFO,
  }).catch(() => {});

  await sendTyping(1);
  const timer = setInterval(() => {
    sendTyping(1);
  }, 5000);
  if (typeof timer.unref === "function") timer.unref();

  return async () => {
    clearInterval(timer);
    await sendTyping(2);
  };
}

async function sendIlinkTextMessage(botToken, raw, text) {
  const toUserId = raw?.from_user_id;
  const contextToken = raw?.context_token;
  if (!toUserId || !contextToken) throw new Error("missing_weixin_reply_target");
  return callIlinkJson(
    "/ilink/bot/sendmessage",
    botToken,
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: BASE_INFO,
    },
    "POST",
  );
}

async function sendIlinkImageMessage(botToken, raw, imageDataUrl) {
  const toUserId = raw?.from_user_id;
  const contextToken = raw?.context_token;
  if (!toUserId || !contextToken) throw new Error("missing_weixin_reply_target");
  const upload = await uploadImageToCdn(botToken, toUserId, await imageRefToBuffer(imageDataUrl));
  return callIlinkJson("/ilink/bot/sendmessage", botToken, {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{
        type: 2,
        image_item: {
          media: { encrypt_query_param: upload.downloadParam, aes_key: encodeMessageAesKey(upload.aeskey), encrypt_type: 1 },
          mid_size: upload.filesize,
        },
      }],
    },
    base_info: BASE_INFO,
  }, "POST");
}

async function sendIlinkVoiceMessage(botToken, raw, audioDataUrl, duration) {
  const toUserId = raw?.from_user_id;
  const contextToken = raw?.context_token;
  if (!toUserId || !contextToken) throw new Error("missing_weixin_reply_target");
  const { audio } = audioDataUrlToBuffer(audioDataUrl);
  const upload = await uploadMediaToCdn(botToken, toUserId, audio, 3);
  return callIlinkJson("/ilink/bot/sendmessage", botToken, {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{
        type: 4,
        file_item: {
          media: { encrypt_query_param: upload.downloadParam, aes_key: encodeMessageAesKey(upload.aeskey), encrypt_type: 1 },
          file_name: "voice.mp3",
          file_size: audio.length,
          file_ext: "mp3",
          duration: Number(duration) || undefined,
        },
      }],
    },
    base_info: BASE_INFO,
  }, "POST");
}

async function sendIlinkFileMessage(botToken, raw, fileDataUrl, fileName) {
  const toUserId = raw?.from_user_id;
  const contextToken = raw?.context_token;
  if (!toUserId || !contextToken) throw new Error("missing_weixin_reply_target");
  const fileBuffer = genericDataUrlToBuffer(fileDataUrl);
  const upload = await uploadMediaToCdn(botToken, toUserId, fileBuffer, 3);
  const rawExt = fileName.split(".").pop() || "";
  const ext = /^[a-zA-Z0-9]{2,5}$/.test(rawExt) ? rawExt : "bin";
  return callIlinkJson("/ilink/bot/sendmessage", botToken, {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{
        type: 4,
        file_item: {
          media: { encrypt_query_param: upload.downloadParam, aes_key: encodeMessageAesKey(upload.aeskey), encrypt_type: 1 },
          file_name: fileName,
          file_size: fileBuffer.length,
          file_ext: ext,
        },
      }],
    },
    base_info: BASE_INFO,
  }, "POST");
}

async function uploadMediaToCdn(botToken, toUserId, media, mediaType, options = {}) {
  const rawsize = media.length;
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);
  const uploadData = await callIlinkJson("/ilink/bot/getuploadurl", botToken, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5: md5(media),
    filesize,
    aeskey: aeskey.toString("hex"),
    ...(options.noNeedThumb ? { no_need_thumb: true } : {}),
    base_info: BASE_INFO,
  });
  if (!uploadData.upload_param) throw new Error("missing_upload_param");

  const ciphertext = encryptAesEcb(media, aeskey);
  const cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadData.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  const cdnResp = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  const body = await cdnResp.text();
  if (!cdnResp.ok) throw new Error(`CDN HTTP ${cdnResp.status}: ${body.slice(0, 300)}`);
  const downloadParam = cdnResp.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("missing_cdn_download_param");
  return { filesize, aeskey, downloadParam };
}

async function uploadImageToCdn(botToken, toUserId, image) {
  return uploadMediaToCdn(botToken, toUserId, image, 1, { noNeedThumb: true });
}

async function callIlinkJson(path, botToken, body, method = "POST") {
  if (!path || typeof path !== "string") throw new Error("missing_ilink_path");
  const fetchMethod = method === "GET" ? "GET" : "POST";
  const res = await fetch(`${ILINK_BASE}${path}`, {
    method: fetchMethod,
    headers: makeIlinkHeaders(botToken),
    body: fetchMethod === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`iLink HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`iLink returned non-json: ${text.slice(0, 120)}`);
  }
}

function makeIlinkHeaders(botToken) {
  const headers = { "Content-Type": "application/json", "iLink-App-ClientVersion": "1" };
  if (botToken) {
    headers.Authorization = `Bearer ${botToken}`;
    headers.AuthorizationType = "ilink_bot_token";
    headers["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
  }
  return headers;
}

async function storeOutgoingMessage(env, runtime, externalId, content, raw, replyAnchor) {
  const createdAt = new Date().toISOString();
  const path = `${MESSAGE_PREFIX}/${runtime.bot.id}/${sanitizePathPart(externalId)}.json`;
  await putObject(env, path, JSON.stringify({
    format: "ai-phone-weixin-cloud-message",
    version: 1,
    direction: "outbound",
    botId: runtime.bot.id,
    characterId: runtime.character.id,
    sessionId: runtime.session.id,
    externalId,
    createdAt,
    role: "assistant",
    content,
    raw,
    ...(replyAnchor?.localMessageId ? {
      replyAfterLocalMessageId: replyAnchor.localMessageId,
      replyAfterCreatedAt: replyAnchor.createdAt,
      replySequence: replyAnchor.sequence,
    } : {}),
  }, null, 2), "application/json");
}

// 离线主动发送：借该 bot 最近一条入站消息的回复上下文（context_token）发文本。
// iLink 协议只能"回复"，不能凭空向任意用户发起会话；用户太久没发过微信
// 消息时令牌可能失效，调用方（push-generate / push-bridge）需准备回退渠道。
export async function sendProactiveText(env, botId, text, replyAnchor) {
  const index = await loadRuntimeIndex(env);
  const item = index.packages.find(entry => entry.botId === botId);
  if (!item) throw new Error("bot_not_found: 云端没有该微信的运行包，请在小手机同步一次");
  const runtime = await loadRuntimePackage(env, item);
  const botToken = runtime.bot?.botToken;
  if (!botToken) throw new Error("missing_bot_token");
  const rows = await loadCloudMessagesForBot(env, botId, 60);
  const target = [...rows].reverse().find(row =>
    row.message?.direction === "inbound"
    && row.message?.raw?.context_token
    && row.message?.raw?.from_user_id);
  if (!target) throw new Error("no_reply_context: 该微信最近没有入站消息，无法主动发送");
  const raw = target.message.raw;
  const segments = String(text).split(/\n{2,}/).map(part => part.trim()).filter(Boolean).slice(0, 4);
  const parts = segments.length > 0 ? segments : [String(text).trim()];
  const localMessageId = typeof replyAnchor?.localMessageId === "string"
    ? replyAnchor.localMessageId.trim().slice(0, 240)
    : "";
  const anchorCreatedAt = typeof replyAnchor?.createdAt === "string" && Number.isFinite(Date.parse(replyAnchor.createdAt))
    ? new Date(replyAnchor.createdAt).toISOString()
    : "";
  let sent = 0;
  for (const part of parts) {
    const data = await sendIlinkTextMessage(botToken, raw, part);
    const errorCode = typeof data?.error_code === "number" && data.error_code !== 0 ? data.error_code : undefined;
    if (errorCode !== undefined) {
      if (sent === 0) throw new Error(`ilink error_code ${errorCode}`);
      break;
    }
    await storeOutgoingMessage(env, runtime, `proactive-${Date.now()}-${sent}`, part, raw,
      localMessageId && anchorCreatedAt
        ? { localMessageId, createdAt: anchorCreatedAt, sequence: sent }
        : undefined);
    sent += 1;
    if (sent < parts.length) await new Promise(resolve => setTimeout(resolve, 800));
  }
  return { sent };
}

async function loadCloudMessagesForBot(env, botId, limit = 200) {
  const prefix = `${MESSAGE_PREFIX}/${sanitizePathPart(botId)}/`;
  // 按创建时间倒序取最新 limit 条：按名字升序在目录超过 limit 后取到的是
  // 最旧的一批，新消息进不了处理窗口，自动回复会静默失效。
  const objects = await listObjects(env, prefix, limit, { column: "created_at", order: "desc" });
  const rows = [];
  for (const object of objects) {
    if (!object.name || object.name.endsWith("/")) continue;
    const path = `${prefix}${object.name}`;
    try {
      const message = await getObjectJson(env, path);
      if (message?.format === "ai-phone-weixin-cloud-message" && typeof message.content === "string") {
        rows.push({ path, message });
      }
    } catch (err) {
      console.warn("load cloud message failed", path, err);
    }
  }
  return rows.sort((a, b) => messageTime(a.message).localeCompare(messageTime(b.message)));
}

async function loadRuntimeIndex(env) {
  const fallback = { format: "ai-phone-weixin-cloud-index", version: 1, updatedAt: new Date(0).toISOString(), packages: [] };
  const index = await getObjectJson(env, INDEX_PATH).catch(() => fallback);
  if (!Array.isArray(index.packages)) return fallback;
  return index;
}

async function loadBotState(env, botId) {
  const path = `${STATE_PREFIX}/${sanitizePathPart(botId)}.json`;
  return await getObjectJson(env, path).catch(() => ({ botId, getUpdatesBuf: "" }));
}

async function loadRuntimePackage(env, item) {
  const key = `${env.SUPABASE_URL || ""}/${env.SUPABASE_BUCKET || DEFAULT_BUCKET}/${item.path}`;
  const updatedAt = String(item.updatedAt || "");
  const cached = runtimePackageCache.get(key);
  if (cached && cached.updatedAt === updatedAt && Date.now() - cached.cachedAtMs < RUNTIME_PACKAGE_CACHE_TTL_MS) {
    return cached.runtime;
  }
  const runtime = await getObjectJson(env, item.path);
  if (runtimePackageCache.size >= 8) {
    runtimePackageCache.delete(runtimePackageCache.keys().next().value);
  }
  runtimePackageCache.set(key, { runtime, updatedAt, cachedAtMs: Date.now() });
  return runtime;
}

function pendingFlagPath(botId) {
  return `${PENDING_FLAG_PREFIX}/${sanitizePathPart(botId)}.json`;
}

async function loadPendingFlag(env, botId) {
  return await getObjectJson(env, pendingFlagPath(botId)).catch(() => null);
}

// 标志写失败不致命：最坏情况回复延迟一个兜底扫描周期，由全量扫描自愈。
async function savePendingFlag(env, botId, flag) {
  await putObject(env, pendingFlagPath(botId), JSON.stringify({
    format: "ai-phone-weixin-pending-flag",
    version: 1,
    botId,
    updatedAt: new Date().toISOString(),
    ...flag,
  }, null, 2), "application/json").catch(() => {});
}

function reconcileScanDue(flag) {
  const lastScanAt = Date.parse(flag?.lastScanAt || "");
  if (!Number.isFinite(lastScanAt)) return true;
  return Date.now() - lastScanAt >= PENDING_RECONCILE_INTERVAL_MS;
}

// 回复完成后清标志；若生成期间又有新消息入库（标志指向的 externalId
// 不在本轮已回复集合里），保留标志让下一轮继续处理，避免消息被漏掉。
async function clearPendingFlagIfCovered(env, botId, repliedItems) {
  const repliedIds = new Set(repliedItems.map(item => String(item.message.externalId || "")));
  const current = await loadPendingFlag(env, botId);
  if (current?.pending === true && current.lastInboundExternalId && !repliedIds.has(String(current.lastInboundExternalId))) {
    return;
  }
  await savePendingFlag(env, botId, { pending: false, lastScanAt: new Date().toISOString() });
}

async function saveBotState(env, botId, state) {
  const path = `${STATE_PREFIX}/${sanitizePathPart(botId)}.json`;
  await putObject(env, path, JSON.stringify({ ...state, botId }, null, 2), "application/json");
}

async function getObjectJson(env, path) {
  const res = await fetch(storageObjectUrl(env, path), { headers: supabaseHeaders(env), cache: "no-store" });
  if (res.status === 404) throw new Error(`object_not_found:${path}`);
  if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function putObject(env, path, body, contentType) {
  const res = await fetch(storageObjectUrl(env, path), {
    method: "POST",
    headers: { ...supabaseHeaders(env), "Content-Type": contentType || "application/octet-stream", "x-upsert": "true" },
    body,
  });
  if (!res.ok) throw new Error(`Supabase PUT ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function listObjects(env, prefix = "", limit = 100, sortBy = { column: "name", order: "asc" }) {
  const bucket = env.SUPABASE_BUCKET || DEFAULT_BUCKET;
  const res = await fetch(`${normalizeRequiredUrl(env.SUPABASE_URL, "SUPABASE_URL")}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: { ...supabaseHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      prefix,
      limit: Math.max(1, Math.min(1000, Math.floor(limit))),
      offset: 0,
      sortBy,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase LIST ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.map(row => ({ name: String(row?.name || ""), metadata: row?.metadata || null })).filter(row => row.name) : [];
}

function storageObjectUrl(env, path) {
  const supabaseUrl = normalizeRequiredUrl(env.SUPABASE_URL, "SUPABASE_URL");
  const bucket = env.SUPABASE_BUCKET || DEFAULT_BUCKET;
  return `${supabaseUrl}/storage/v1/object/${bucket}/${path.replace(/^\/+/, "")}`;
}

function supabaseHeaders(env) {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!key) throw new Error("missing_SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function getLatestRuntimeTargets(packages) {
  if (!Array.isArray(packages) || packages.length === 0) return [];
  return [...packages].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 1);
}

function messageTime(message) {
  return String(message.receivedAt || message.createdAt || "");
}

function extractText(raw) {
  const items = Array.isArray(raw?.item_list) ? raw.item_list : [];
  for (const item of items) {
    if (item?.type === 1 && typeof item.text_item?.text === "string") {
      const text = item.text_item.text.trim();
      if (text) return text;
    }
  }
  return "";
}

function imageDataUrlToBuffer(dataUrl) {
  const match = dataUrl.match(/^data:image\/(?:png|jpe?g|webp|gif);base64,([\s\S]+)$/i);
  if (!match) throw new Error("invalid_image_data_url");
  return Buffer.from(match[1], "base64");
}

async function imageRefToBuffer(imageRef) {
  const ref = String(imageRef || "").trim();
  if (/^data:image\//i.test(ref)) return imageDataUrlToBuffer(ref);
  if (/^https?:\/\//i.test(ref)) {
    const response = await fetch(ref);
    if (!response.ok) throw new Error(`sticker_image_http_${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!/^image\//i.test(contentType)) throw new Error("sticker_image_not_image");
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("invalid_image_ref");
}

function audioDataUrlToBuffer(dataUrl) {
  const match = dataUrl.match(/^data:(?:audio\/(?:mpeg|mp3)|application\/octet-stream);base64,([\s\S]+)$/i);
  if (!match) throw new Error("invalid_audio_data_url");
  return { audio: Buffer.from(match[1], "base64"), encodeType: 7 };
}

function genericDataUrlToBuffer(dataUrl) {
  const match = dataUrl.match(/^data:[^;]+;base64,([\s\S]+)$/i);
  if (!match) throw new Error("invalid_data_url");
  return Buffer.from(match[1], "base64");
}

const templateImageCache = new Map();
const TEMPLATE_IMAGE_FILES = {
  red_packet: "generic-red-packet-card-v1.png",
  transfer: "generic-transfer-card-v1.png",
  music: "generic-music-card-v1.png",
  photo: "generic-photo-card-v1.png",
};

const TEMPLATE_IMAGE_WEBP_BASE64 = {
  red_packet: "UklGRrQFAABXRUJQVlA4IKgFAADQLgCdASpoAbQAPqFQn0ymKKKipXXIiRAUCWVu3V6DU1oR663Ldvj5k/Nv07Lej8gOixmQ8JAx3PqCH1BD6gh9QQ7CTYRJsIk2ESbCIokXSCyGgiDVSu1fqjSco80ANumYGiI4D3PF/RPgek6KVT3hGZxl3napyDiwdGxBgy/jxIzPIkTybefjOi/Q8Z5uDlffuraDETr/XSVc7VRbDekinhmcXJgAMze0WNvQG85dKXBPQAdaP7B6divEEOXANYtjxR2NwmFtJxgzKrHPtiOU/ZB6XBXY74feqhwGyvtu9sfEqqx9rhp70yqUDLPUl8NiJCOI0ZWjBIKQ2Ahn8i865lRK6b4avBm4LKjOUbex+oD9DyKTGLcMoPxLjGtwdLzxDi0v4mB8oDW7Ghrg/qGxQ/UOS0J/oLnKHX6qKFBUk/9jRi/Js8/6gcWq6C0yeHditTkd8vVg6YVwB0Eo5jrOzSkCfM64WGIbQlg269OneocG3Xp04pECdESbCJNaAAD++Vu4JsnrzgAAAAAY73AAAAA3CL93xwmnTnwa88U6iuRqjDRw9jMbU++FEHiRPfNBAdqvHR4aZp8RIk+oNkLsmk+Sl3y0+o8KdDuqWJGs8VTuAb3iU9c+REdMgPCWVCfD6eAxx3B/bp0CWcXLv0sxH5nvoyETymgjlacganplP+lyxuSmZzo5qRDCLqI8eNjMbUIDkiquvBylkT0QDYayZBg+RBmqYI+7JbDPUNqmHPMBkwCCUZM3NayCuexpAMP+qJwVdvAg3k0Ff4CcGQvyVE/OWk/ad6VFYQr23ViDyS6Ed1noENNvHPNi9699F+cQLsZsRsbZI8owth44wSKXFZ2WIZqPdROtzZ1BTbUUOH67SmhNy1RMPKsB4b4ZJ8+wI+w3akevLJseW0BW2HSbKGzamJ8G56pSPt2S3mQesVf0FTzwIr6SgBsUwkXBP8dMwJBZOnmgeYJLQB00+1tRr2HLLK8VYZajGHsWmzQyY2GCEMAbJ9Lj09K1/5KRqZVfFh3MP9GIV7oKeMaxTiL08cFEDU+iUGsU6ELI8QYVeAReQTjxSySeVwo0Z6NYxe9Eo39wIWMkNHgfG4WZNRVbmnnJPDfD641HdswrJ15arGiG83QiwylNHGnhDB/VX7uXFzQ/2k7Lhz1tBHHjn0PG9gvgaZGzB2q/iL50rwnwzUODo3uKlmUBM/XKrfBIjgmRB4qZxpPclOXq8ujSWHUOwNkE054+qzm+sPxzS4InG+ZX2UXKzg4ofMHc0vZ8BgPWsMq0c5OEUbzAPP7xNVrrH5d5Y3cgXK34r9jsCzm4y+kmn/Ea7CZnrPxWdjm3TaXk6r5A0tKOd8ws0yOR8H/oLqsmF8WYpdxgciRyf7Q08/oY2/CJSB3b2mXYxoMOBCFd+HPocKExv5yH2aSwIfws7eh8utChWh6NYpzMwsrIPSXav+n421XbTlkDqRFzvlOs6FG9zMLrwN/oJfHojz2CFPDX7UaMYGsGHpRgGYpDsL0yEG13NDx/HMvP9cXZEnUld5vEocUKRu9ixOukxQSkTJmwEF05711Pua8yXoOluh/tUX8ftjKauUy1f5IlYzLAYOdeOEjONFMHRDfL0C5ygmrfG0tdiAFBu3XK2ekwtTdR2svPldFOykrlCTaWxt6OPZhBSEygHxaMiYCD8ys4kLMXxPz0/+Lkzfy0Gab4KhSHSXehCtCppvHasGfiT2VlVV5CVwAqWSEdNmFRab5vL+wV1leSy+ASsQraoAgiSwexLY0onPfoD3thfW8ZipSgtpvq3L33LkmbkwiHied4O5un9FdkGg8FJ1eN5AKK0wmOLrTrUQWdzt4AKAi4sZfrejKB+SkPMIDRU3YTy6J43NKRu6AdjkFDnJbEbaUyDjYrAhe+wUMsyXjPIAAAAAAAAAAAAAAAAA==",
  transfer: "UklGRsQFAABXRUJQVlA4ILgFAAAQLwCdASpoAbQAPqFQn0ymJSMiplY4gMAUCWNu3V4z2hpz7umwP/RqtuN5nfONaBscGNJ5PvnY/fOx++dj9hd3zsfvnY/fOx+74sOdXTRaMIX68ZaHV8cb/mJnUUOQrR1JLy0pzpnvLhTBFuDDhFidU4OoktaQUPxZTmnkXqu5SjpxqH8y5+nT/totNMf5JAE6hzzj9tXCmpH5dAz8HdRiUfxFEmiPJlvP5tj6dsd4Q23lv//dzdaLmCypbY5kRnc+SoQ0zI5ZiFy1Gwgl7d8Ei8dQy5d9R22Y5OjnXAKI2rAsc9m8fL4gfGydvFMzJVXvPkS0Ah3uSxle66RSCjnWWsLOARlvCdPgzyCCefnsfzPBT0PisIoLGGDvJA2BcViNwjQdbDzaZsVNiyDD2MfroIURwvz1dcaBSfcpm98ZCB/RvtwclbMYtybP+yUnp4OXTC2IYcdpO8G0RyL6CtNuseHCYRHWC5GZBOUD4MoH0eZu5nBlA+DKB8GUD4MoHwKAAP75cz7cRXaCEVbA+4BAAAAAqcgpNMyBAAAAAbH8Kc9Ooq8EgYhneCuV1mFTSiUk7BZ7JejVgs9hEuayEOlTsM1XyvUZtiPWxsncD7c9wnXpxC2MoNOdOYZsKuWoyv0WAZ2glxGWgVDK4uJT2QH34j7Wgs5zG6ox7ELNwBbyuCNUiVCgxvdrSvUbTdvDIK2Yi3icwCSU8c3Pxe8L2wI4ZJIqn/s/zPNGveaxv2ffn3gF1TXAvunbuk7AmcojkEPdbGqIVc+yVeMxwIBxgAAAABN7kSUtgq9qaTrPyHs+S3lwIVnACGHm/vtr/No/1oN75Hw1Gdy/etPIbygoeoCWbG4bPv7y7z4DYi0GqcbV23hM9pfuKNBrAj1pQRGIzVt+hPHQ0f3c1KyuAk6pA1zL6xYj77Qz+Bjo8EUgCDs5+1VaWDp/eyECibE739paAVFNPiWTVL/ngY2X4PAOE4UBZWEjfbPVH7+NCb8yi27kjTfgY361m/5arOdQCS4yGMbPXQoepbMH2saTb2hPXSe5ifrlzu/rIewXI/tALDf5nEXO1yYt7/a+2aR5B9iYfMAsEdL9IG1CfTaGzqFUVhRYaYWw/maETMMp8mv3QZKSdmPocfdNohkKNuoTXSWouTWRFHAbtKi0f/vReHZRQU/pdHyJbSwCBG/cdOCNJt4tEQgdSCuc/Tqm57LkE2Wy3ndCuEhzXzJ/FiSjF74/1vfTf/16qh1CWpQt6ziI4zEMjlLY+ZYe4shOI8LNmuABKBYQB+hH92VOh5TtH4nOdu9rzrhb4rbsnGOlHbPKhjdjmKz1y4TosJs9s2wBh4/fLE5pLXBSNijtYhBN0VrGJfVuYqmQ5cgCtWkiWrAseBBglY4pOxLXe7eh+IFWWx+aQu3QTis3AY98kwOTsFR45le/GO5g4kdTi7/+xjALx/aw633BcXneScmS+1/+fg+DS2EJ0g45hONLmv6pFENyy1GQqwsBcczut/V4s8Y5/L5oH9ZlX6nfMYuoKv8AN5jRmPsTXwsS4n4GjS30iYq+oCLQepQFvvowjCcBQ+xp7CAmEfWujS5moSMVlkJJeRZdPwad//Gb7trDb2IPNstpkGeG4HxG4umcXRu+Lq7I20ejB39F3dgmED6mO/oiua9HrcXASNGmLGmmjSVVOqBLqGGWFIs7IHe+6O6IJNasubWh8Jhc3otFQAjaewLfGsSsIm4G3dbxClb6JaxKbeLD9GrX92Hhn0v4ibChsFPh0vKBD4ZmOW9eMNl0kg9b/l3h3ocJO7KLyqzuR0rJV8MXtvfBNIpJozu26bqMVWK0g9qjpDuaVghNg8HKi7cSpfFFrqMNvYI2cz7qBDTlz+5+ed7qCdcgUKL+Kls8NePuAIDZ1NN0tn7yVS7cjwTi+c0N843yZvR+HLIaP/fsLsgAAAAAAAAAAAAAAAA=",
  location: "UklGRrgFAABXRUJQVlA4IKwFAADQLwCdASpoAbQAPqFQpU0mKKOlo9J40RAUCWdu7mBzmcF7tDBxMdvnu/4ZYdSsEtEpMkFRbMAd0/YfQVFswB3T9h9BUWy5Djx/MWQ1fSJVUhy+Q5fIcYp4Wy7D/Ns6f/4mTrOhfxA0rlxOls85/IIec2o1sZaTOgf2G0o1A1WmyDs5b419annTHFHWi5oNwDYZ5ZMU63Q7BFHbloFSbKNDoeQS0spfkg4Eid4Wo6D0J7euERQh/UzvfQbu/z7TlTvaJ2QQkCl946xJWkCfKs0wyBu3h3QcUaowOo/RkZRd+knhKruPZNkNKO94tvmuEYYFn0FjDhC8q9zDWngHA1hbyjy0sK4St0R/q0iwbe+G55tcQq9W5rZYw01iU7/yM1BO7ZAeIh0W49iXAb5yCqwnMtzNnBsQD1hG2q2q9Dy7JQK2+bJMoiLSkLQTS1o0+1PiArDK5CMWmDnfgTvCD6/3lm6oBp74I5iT/EGAfWjkIB5zafsZBM6Y/ccSZIKi2YA7p+w+gmgAAP78mKIyHTFHDwgAAE+IAAAlh//rNMIqFDEDDv008TWOzz8XoAR7wHexOqcNsWarPRf+V013qkIpC3ns8HNO3D6cIC6SUiInwJhw44bSxD+uhqISvFYtHIv4TmKOnq8pLkAyFVsFxReaT5py036FT/QsGEilmVw8oY0bdKfVxkJiQi5cDu6VE07TyqPoem8Dr3V5NK0MPPVls2IrllHXv1JVAwUWQovPZ90lkABMjQhsXeIbYp1/UskSO1H6XZFBs2CXvxfdqDxBsfvifqLT7IjrYnyxX+kQ2hj0JgCRvy8djw/ULXVXLI2Xl/v6PnQGA3ZEMZ1FNtqva6ruTotNLVeVZi8uCeOXUNti3xnSWd48XYTQT9AK8pjjRMKUyzOFKBzNj3wRjAQdSD699Hd1NAYyVTIdkG4qzkRTfy5TkBNbrIv1xEsqqdwlUe7pQnVOz4Pv0EMeHaIBDuQuXIaVwJLcaOrMikEmPzIVK7JlzeSoU+qW/GXQreQto+N9yXRBIErTJWMdQrio+86qnwv1LIIoAb67v9NzkWyGnJdJtC3S9dlFOl5eATzFHVOqD+zILEyM0VcaKzH10NA7t1yLaUbJh/WWPfvGc+/SE7yfr3sxtL/xXe9pSCzgLNogMUUG1wTBt4MpRkLQOc7XkVJso0EN+ZYncrvD6sZ2q8IX+tin6frx2yXuMGb8/3OLJv7DBnoC/9b5g+VwWtTPHnetdEAMaLCw24nd4kS523zyoEN8vHOkKnfR83LCwYWlzfQC5VQyjPWk0BbHJtwPnfVq3MzGIRG+0/L61BLhEsDr2LBM10h+bJNgqL/ZupdRzD8AF3BjwcRFy1i48hjWlDOzHi0buNNwtoN+QnAJ53I7cmvuyXfYvHWXBkdsZ2pf694kn30fBPlPvZ7kSM4Pl0aSxGlweP8E1wHT7uqeq0ylGdUucwEmk1Kz91Z/Ljo8xsitheM0U8JsqSU6G6PM8eya8+16VmEltlFNgHHLc4jMKEIsjVGRgO/ZdxEPCKvGZEO/AzdzioXfv5AmcTkYXlQqmAsqz3lifbb1mdcEv2sjlHhny6bxtwSpHBuqRJb0c6TbC+JJ7DWUSevVoUYNWQT4uILE/Q8s8mBOvupsld5zuBIP56fqbJRq6xGJPsoOxajh73hYVqbsUafNfQbcdjQDDl3mQXiWvr0wbKvOWV0FvrlTuvRgah4d6OGib6Eybz4OumlhjVCuPaQ0IpYSVTG7lVWp/2z1uS/QYm9DRAill93n3kDj2gS/k87XgVDQBN41OmiiqwbxCkSsiDldyVieb+gVaYsKo8YbxG3klqz9EqRbHJyHMiDhasObch2DhAkbEjLIB1YMeaarRtBRX6OZt2LiZidXd4ry/hKLhyp3y70OK2q4OxgKfO08AAAAAAAAAAAAAAA=",
  music: "UklGRmQGAABXRUJQVlA4IFgGAACQLgCdASpoAbQAPqFQpU0mJSOlpXN4SMAUCWVu4CmCwGIzO5l9w6e3rcQn3nMkYTaX1pMS5ja8bXja8bXja8bXja8bXja8bXja8eurKqwis8A3lHZBvC97HW0P5rYfgDqNQWL/7ZCIzwfl6YvM1hHUpnotuG7PDHq6NIb7vXI5tbIAfsszTuwCUPYHn8Bk/6dgfIwi+9zXObhnk4nE4nHJ06/9G5zqaOruRCq8BNrqqpkEAzdb9+vnMsvU8J9vkYc8HNjoQYgrIUqq64iCRVt74xHT8AlDL/VQK834hI1jNwJxT89/TiIgmT6wbZVOiBUw4V1gU14H27rPPDkVls+vw1rNDZ1egpebnxrIzrPhaRTOuS9q9Y73n2I6BzLhnAqQNR/6nIhbLJh2AMI1iZgaZgmF6Hlz/YU4boq65VVVq7n2hPJg6RKXnOewLBg+zyw0GYp6jNBy8RPfjmHK3Dwjsypd0sJ2z7AfYD7AfYXoHS3uMdxjuMdxjuMdxaAA/vbSlN+ZL1U5x44/cWTjxx+4snHjj9xZN3EAAAAAEISPGwCd3sLSP5JPxr5wymIjaFbXLaBanijjLnreag5ataW4Wr6Wvfetv2nXxRiHDKTwXkaBKuzr7Kiiaes3ztHUk0o1n6jU45jB00giMhaHyiMYe+nuu4psIKP8xq+rf1syFxFu2YxDJWzXIOU0LTwzWt9N4xmzo1ISOZTkEu+7HxuhJgJJNBHhc640/7tDFMWiZna2B2ZYOkHRQpIZsVZIr58T7Yi2HOT82De+roZPIfwmOn8yCxid4xrwRc6deZs6sGH1yKZKF0n9Vit9EXRj8hQqNMrhlgxm/bCzEVt/Fw1ARYs+5JugwrUiHfrD9dlqwnk8kQz7s1t+eVY6+kUoN2A+N03QMVl3N2IGbfXdLp4sOTHP00z06cZTd1xVky/IxXjDuaRK48+B7GOzi9QT79lwgPfDfCLCCsRJ9dgb7ZHk5+WDUWQw8swTS4fqhRY70e5tqX9Z4k58e/TchuGj95dBtqV0nMJvZlRhesOuMhkPLHIRaBz+TXX4l5U49GUKg+5Ml7IKICaw5UOV2qCvlb5O8TxcIY0CJD0lcd+GxDgsQrPvhV64JERvgsOow/U+skVTu26YjawwuS1qPhbLTC0UiCN2PZ7I1mHpiw8168gSVsp5ZdVe9ltd16VKjIYv8T2h0Yfi5/PayUB/Vb8WXyOLXcRmEf0f24dWE36TqX7VCFhNBGLbCKYNrdpd09C87ZeOMrt4Yr3ukmAPy24cJ0ZJVTdmXoZ+jOBLKTPVWtiNWwGD+dKcre7KiDOra0IiGm9Wenen/BvazkS7uekn3inAAGgEck/wxQFBQgJA5zMSmUxiDiMNbw4fbMQh6rlMrDmeEeHgpjcVyCbfkvOt2sFRks28Y7fNN7w+aQicettUTdZJ5hrIZrbIY6pvhyLcOoyHiDvK3XDnGd7cBvl64zcx70sCrtfeevvU3K+t/9lZcDEC/9gJKTXY6e4LXgytfAMUYn+BJvwX13LHHtvFmgQ9XehS1KNEphp6lJn9dZeSVvQ1wEdITdPaRDw8rxU12sEBFAEeq0WtregAbjBK9onzikgdP4qkPgkOFtQAmuQObVP61UJPXPHJCiXnBe0d1BZGrAP1D1sKHy6i1xmxaFrZCokoMqustHRlpXCQ2/8IG9splOsi0JUxqpROWUxJgz2CANeXAnUym9t1Uk77pzRgd+4poRg2WbhBZUORl1pdzurEvW0rQnkqtHCiqVaAh6CQm0fFQpB3fZcc1rfgsmZZKRRiOitp3BAzXloSsNhEMzJz2W3vQI8d1zCkOatlO8+GjqgRoJCPL4zUOTh1uepcd8qDVYR+GbGCtnIf17iF3kOqtSXS0ltGYzJZiRnxPH3T4h8h+IvdKJDf4bJmZnGS/jUifHO9ZWTgXOGoxkRUeucELoXt68zIaCtFEEwV9jDOH3bvfBJFzWz5Qa8CLRYTxmepk+la29MKf7zzipIkXoO+tpiNNDOst28eBB7JSGlS7krgRht8gnW0Z6BDsf3jZ0ozdfAMPgyKx/lUHopO2itqDTQNdY9XzmAmb8GiSR6Kw7fRRTUMnVOc3DLa+NMw/mV4CQoH0wV8RnXue3cTV3AEcm5nls/7m7EIAAAAAAAAAAAAAAAA",
  photo: "UklGRugEAABXRUJQVlA4INwEAADQLACdASpoAbQAPqFMoE2mJCamJRBpENAUCWlu3V9FqO+w5iXA/SuM6i+vuHZn0KYB3m/uHZn0KYB3m/uHZn0KYJE78bvN9X61W1GfRW8pxQC4X3F99ooZm9CkNClM+mmi15bzUqnqySfAJ/C9a9EDZHIM7JDol9eKPqTQai67GzNzqtHGl2Xu2q+Kh00TWf81MxZ8ymbkasQdqlI0EcGIBdEx0a014zRQgrKsQ1TnIrlrC6U6BCBtHiKtivw95fLG+hW3FmdGMsj8+rBiKvg1mkzt1xV9nXh3bipNUxntLdd2KB2/SjmIXYCN5IoLn08vL2QB6/Y+uBFsVRO4Z6P+QICwXH44+jRXF/vDamVKA6k+9YO0DKlFKMsoY8l8U6x5bNnF63YYA2GtVEplQxZlaFT25f7nTpnIFihOZJHz98EUukFAMFoROdOzBfFtYmgT3qDsqeq6FC3MA7zf3Dsz6FMA7zf3Dsz6FMA7zbAAAP75EZ5ryQAAAAAAASYSPocUY5XOVlkiCzjeQNXhCpiXZPbBQEErymBgP9adYFdjsOA54s+ew2JRIfkpGQN+dRNtncm49DFDfQCNCfHRg2nRNptZ5MLpH4lhVUicozOyZPWs0bth8PkZyuU41hOnRXEeWGgJVpsOQM/IyZLTLWGawx7iLzCJWIyNnK5Pz2eMGmHNmurZr2JWBaciNmqmLJlTFDag4O0YjNoI0bjkBecCEcki7JLqVgx4+FOTzMATXx2GtAbfOyWCvML3E5zHRhu9oGlqC1ZkCl2AEqwV3PbwBcBckN5z6mks0QTaIaErepjPlSDT6S5CZqbu3qU27sRI5I5zDamwBw6yU0kHh5M39pf21S4DMl6kZ8/a1QXltJqpwE/wGllox09dKAORrggRE0rwB7ShS7SzHa748jDovnEb4k91w4gcSJneepcmZsOooQTsfMq4b2NHYRj5RZq7JPMwd+U5EJykzGUY7WzxFsh+ftrhUOMKeuBKmFFs7m7oBk1kxRw+271wAduWoTfq3IjXLbTBo1QnZb+QnDrApFJ0R6cyII/Slf7bw4eYDOpG+Zgy3PwQJKArGe3T9TanKheJ9AeH6UyujdWGoH0LDP6UHILM+eAhMv3r4+Jh+DKeadQ2TqyBMnLRdeur1WwLODG98/ishBCjK+KzzZjFNynblOIaTWIlb87rtRzUh7ekpSELVO9Td6sbf0bOs2h2DFj4keRvkHHrI9CUUrC4iyrZWAUpxmz+CgjAekz7meMU/ls9yUVYAI/ozW8R3Fu9f6mwuNnqWmU84s4TTKQzEI1C6PhbGsp7hVGHQAZFEGrx+NO0zX90++OWI3pFzBvPf8ugUBNmXoFca3sNl3EA7p7uE3iKSspKsq+lXwpr5w3kXNZ37hN67mxkjhukB1BBLXGpw/DVVerok1pSBJcFNP8KIeSDxa2929zHyg07FONhEkcaOF9h0NEbP0j9M96463dLQkQEsSu3TKZV7Yxxi8JG2boxCleI8P1QY6fCEksKUpAOl8F1f1+Z1Ohwst7ZNj3h7O6hutJeaNEVocUQ53Vn2yUiurqqw+0NiN667AQKOxfNQLpIJIpBkgbSXeygHeQgG2hpbnpj/ay1jIOCJmeadPIu06Lep+m7IAAAB3bYAAAAAAAAAAAAAA==",
  voice: "UklGRgYFAABXRUJQVlA4IPoEAAAwLACdASpoAbQAPqFQoUymJSOtpZVY4bAUCWdu4Wbgvvtz4UcvcOOILHN2N4ASQpCS0LZVZaFsqstC2VWWhbKrLQtbMZfRTBf6u1W8voH2dhv5ksOIqkDJGriwM8imj1P+hW2wlPZRUhOIhb5BWOqkWvyHNrh+fqmqa4TePEV9WWl/JBaey9SNUM8Hbuu4pNOx3aTtdtg8DEAZUFN8e3zqH4r3g6r0B7oSrbNGo6Zf2ksdDiyRj9gx+qBhlzq660dAQ9pdvLI2EG/NrMNQ/H0MB5LvEnvAJomunaJHb3XPRrpm1uZo+YMpFEZta3kPDPLkeiOE1A1SduCubV7VPc511d68hAHJxGk8MvhaWoryDbQgBaE2D/7Mtz+BnYs1lofo9NAO6OtdJAXzXpyVetvlziMdBqYjBohnCn+Xts5FYO4CQpoV68PNHLJPIxY+aYAEkmVWWhbKrLQtmPlE82FlVloWyqy0LZUkAAD+/MS6/aa6LAAAAAiZIAAAAPyB9Cj3Y8vJdLmgizR7Ib6CqiJOJEWnG1VJgBZOfUAneZXyICncmbcuE7lp0P786fIKZhvaHR63lZuNPGlnSEJKiT8NqKINbRlDbkZjTaxQHUo78bJR2+RZEfaoa1knG2DQ+e2VmK3LCz0pyTZ9aVo2XstHc3hSjRTNhi+1Xj36cx4U9YSTaEpCTvf6Lt7W/NElsJk6/Rr+xDUaAitvfWknCr3WeHV8hteNLkMQDbzm0EQpVchOHpk+oJEdS5KLSeWvrXoYBWqLgDgE1zqzBsLfj1AQFQSJ8ChlvAXTfkHhQ0+3z0tDtY2u0ZCtjq+Y0crRyWrzHvt2NJkzYth699tZ0zx3ul+nXMwo7Ualj3GE7hVVJFn8ek9wEmoODDP+B1aWVQ4sUqZKHSNKaEZbthmsMZxoKoUimIMDXAaVCo3fm7OnWX5hJQiNdpKUdGqiQ5LrB+pliKe26f7BcsPUBNzPmztt3iN/kexegy2hglnPN4BiwiYrsMgmTJKCOeiEI3c/9FZ+CnAElfBN6DwOxX3DLuxxAhC1spPJuy4PmJys8sT1E7RoXI3/c7WxawE2zEcESs3tCRid4DkzZtQ8/MpZm6tPlB9XOifN3KGZi3a2HwsBb2sfqhRKOJbxifuW/7Q7Sgx9sJTohEoe5ofGJsLIT93FzFIZVgMyzCHHtxiaOAFe/B65yL9CLN3tmjBjHyxDQvO/Uh21Gdw5DQ3UHZq7F+LaVgwkaOp4MdXX71h00mZDJB2wEfKP7qfYmC6abO1cp9FypJpNHkSDCkjDQlaKaKmDzrlER8164bxbrgBaRvAyyXeEU/93G9LjzLYXKtiqQDegmBOLswy1SWJWYK0m3LapTT/nfwuCM548i1MIC8MrNYj5HE8mVNyeVS1D1zrl6mMdxjYuVMrxaLP1I64jf9mdVAR1OjJa9HZ2CPL9Ntqfp8FtrJC9xloYjTxPe/JtH8obTICQcbnuz43iZkdtO8CiHnHbZetTQ+vqiIn8WoP3Pc/hw1qnyMhgH8Mj/Vhe3Q8QB7/QWuntsXLaRkJMOu9Aqtbmw1tUKe9Kb2BhI+RabORuyPku6gfI+YVx8XE0/PVC/5lgDTAUuDojeARFy2ij6bdUmsBrtW4Lef22+Ebaa9kQfvG9YM/PDEXBBrpz/O/UAAAAAAADWZxAG6qVUTsfHAAAAAAAAAAAAA==",
  sticker: "UklGRjYFAABXRUJQVlA4ICoFAAAwMwCdASpoAbQAPqFQpUymJSOoJbToUQAUCWdu4WhA1z61SkG22/55V9K8rFJqd4Jm5tnVJjSqM2zqkxl75S8JF0WvESenMxlX5zM+edgtYfPBofbsXrRa/BuenxjUbDZET0lnT4RN0Ged52549v5C+/0iQVflOYXl7Zk56f+No1FfNFUBw/CfIijMJ6Aya17pUNz7o/+l4UVCBLSD4e2Y4XfmlGAY7pNUrtitNwOaGE9DpJ7sQMGK7mn9MYHRgWDmFgL4q0waNGo55k2b32lU4n93HPe0geVxFWmznWjg/IzvAQwgFlNO+RbRQTH2XNJp3A22Kc67qNTh9GQHRqf/OOxgQYosvT5yuOCsuqWpXw8v89Vtb/kXxyi0gXQFSGhV9zUcSXh4i4e10vRj2q7LYk9bNeVXu6+TRey8Qgg7iH+qed51KzQfQQTBI9nk3fON2bkYdrc+gMfB5YchcRvHvZv8ZvuFLBFsWOEJTEz5QkXRa8RJ6czFKFx7BHgRQ/BGplbe2PSG+kMn9s2zqkxpVGbZ1uDcdaWPKhCxpVGbZwgAAP77sc7ZO4zFves4EAAsr4/SlR3PyLbd8bIJGjIwAU5xQns4rqucmCci/6/u3ixAfxBTLiyXbjAzFmMU/DG56uWCaEHVUuRAUxuj6KLX0nrt5e4yHI1c8fE5NcuisdT88wlWCcWQ01XT+77STAMMly4DN8fMJ/+W3KaZWVbOrCdlUdHY+fHT8AHHkielRVtnOc77awgAx7DFzsEWvmsf1vDHENvVE0eIF4qhTNhOnznQs27VOTrsBEUVy9YEsaXx1y9Y764kCN8HOdMjQlcO4OxIMYcy5s4aKoZuN/I4J8eLuDVJbohogliOBtJAju75wviOuItaD03869nuYb09Zc4qVuIAZJ7gDib06TI56OpdkKR2phmFPAIHAOLdEgGaSf7izHW93IVGa01oglZuxxsBrCT1uD9Sd5yAfscOLaWeI2cupwfdItmjEE4r7v7FFKugr5ITDNaTb1cYaoAR0+z8f+qqFo0bDKCgQzV72YgX7wKUuu+Hw/lOvc0AH5oBubXcAtLF1Z5T1dG3nzBnOKBA3okUdpc17grrizWYZ7VKdnl+9BkQx7ufyIl/ipYhqVUs3DCHfev2klN39JgXudGIMQjR2SdS6h8l35aB8MIW5APIvAyc3uNbAamy8LsEv5aEypldTI8VAj3OrzL7ceCrARUyTCFTHml4OQN3zVGl2wyA0gYI/4vc9tMWDpMfV+bcEaBJuB9NVaG0K6fbBrrjBU3Dn+nn87PKoyMKXNf7Wubp3b+ZrEy0Z5LCeHdo3iRW1Fi8S7mDCiG80tlksSJ05Q5oMI8gYm15ZEgVrHXg++Y2vr1h5uXoTPy0yI5f87+Kov8s89vwqQKgeGIIjWaz/MhGylwN2p8Ra2MBHnevb9/tefbngFWDK0ZxhM+qq16gCfCTpDmHFfDiqZK1kAl43wfyvPslIA0hY3x0+jAhM/5qko1rFat/fHHGuxhwXvg7uTC/DVDFpQyEhajiomyX60Cwv4Rt7nK96Hg/sseR0NGVFPq2w59YsI+8I0kI3Fc17HjeQtRQsoWFJk3cFrVsQlYwZmLfTWjsum9QxezpaacOgsRZBpp1d8ITuAoCCLH0D9qnfKF+rzxqcZPYnM8QChTdsUwh1cwiXk8oWoKvdXcAQJF6qATcixb8Iof2lkztw5XsxlOziCAtON8zTSaYiEZ4nxvQnEgAABLCAC+LixIBAAAAAA==",
};

function getTemplateImageDataUrl(kind) {
  const key = String(kind || "message");
  const cached = templateImageCache.get(key);
  if (cached) return cached;

  const externalImage = readTemplateImageDataUrl(key);
  if (externalImage) {
    templateImageCache.set(key, externalImage);
    return externalImage;
  }

  const dataUrl = `data:image/webp;base64,${TEMPLATE_IMAGE_WEBP_BASE64[key] || TEMPLATE_IMAGE_WEBP_BASE64.photo}`;
  templateImageCache.set(key, dataUrl);
  return dataUrl;
}

let templateImageResolver = null;

// 本地助手注入 fs 读取器以使用磁盘上的高清卡片；未注入时退回内嵌的 webp 素材。
export function setTemplateImageResolver(resolver) {
  templateImageResolver = typeof resolver === "function" ? resolver : null;
  templateImageCache.clear();
}

function readTemplateImageDataUrl(kind) {
  const fileName = TEMPLATE_IMAGE_FILES[kind];
  if (!fileName || !templateImageResolver) return "";
  try {
    return templateImageResolver(fileName) || "";
  } catch {
    return "";
  }
}

function md5(data) {
  return createHash("md5").update(data).digest("hex");
}

function encryptAesEcb(plaintext, key) {
  // 同 downloadIncomingWeixinImage：纯 Uint8Array + 零长度 IV，兼容 Supabase edge-runtime
  const cipher = createCipheriv("aes-128-ecb", new Uint8Array(key), new Uint8Array(0));
  return Buffer.concat([
    Buffer.from(cipher.update(new Uint8Array(plaintext))),
    Buffer.from(cipher.final()),
  ]);
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encodeMessageAesKey(aeskey) {
  return Buffer.from(aeskey.toString("hex")).toString("base64");
}

function numberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRequiredUrl(value, name) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error(`missing_${name}`);
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function sanitizePathPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function clampInterval(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(60, Math.max(3, n));
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function time() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// 微信云端助手 HTTP 入口。本文件不能单独运行：构建脚本
// （scripts/build-weixin-assistant-dist.mjs）会把它拼接到 assistant-core.mjs 之后，
// 生成可直接粘贴到 Supabase Edge Functions 的单文件云函数。
// 这里可以直接使用 core 里的 pollOnce、getObjectJson、putObject 等函数（同一模块作用域）。

const CLOUD_CRON_SECRET_PATH = "weixin-cloud/cron-secret.json";
const CLOUD_ASSISTANT_STATE_PATH = "weixin-cloud/state/cloud-assistant.json";
const CLOUD_CRON_JOB_NAME = "ai-phone-weixin-assistant";
const CLOUD_CORE_CODE_PATH = "weixin-cloud/function-core.mjs";
const REQUIRED_BUCKET_CORE_PROTOCOL_VERSION = 3;

// ── 自更新加载器 ──
// 小手机同步运行包时会把最新的 assistant-core.mjs 上传到桶里；这里每次运行
// 优先动态加载桶里的核心逻辑，失败则回退到本文件内置的拼接版本。
// 这样部署一次之后，后续逻辑更新随小手机同步自动生效，用户无需再到
// Supabase 里改代码。
// 配额注意：核心文件约 80KB，无脑重拉会烧掉用户免费档 egress（84KB × 每分钟
// ≈ 3.5GB/月）。这里 5 分钟内直接用内存缓存；过期后带 If-None-Match 条件请求，
// 未变更时 304 响应几乎零流量。自更新最坏晚 5 分钟生效。
let cachedBucketCore = null;
let cachedBucketCoreAt = 0;
let cachedBucketCoreEtag = "";
const BUCKET_CORE_TTL_MS = 5 * 60 * 1000;

async function loadBucketCore(env) {
  const now = Date.now();
  if (cachedBucketCore && now - cachedBucketCoreAt < BUCKET_CORE_TTL_MS) return cachedBucketCore;
  try {
    const headers = { ...supabaseHeaders(env) };
    if (cachedBucketCore && cachedBucketCoreEtag) headers["If-None-Match"] = cachedBucketCoreEtag;
    const res = await fetch(storageObjectUrl(env, CLOUD_CORE_CODE_PATH), {
      headers,
      cache: "no-store",
    });
    if (res.status === 304 && cachedBucketCore) {
      cachedBucketCoreAt = now;
      return cachedBucketCore;
    }
    if (!res.ok) return null;
    const code = await res.text();
    if (!code.includes("export async function pollOnce")
      || !code.includes(`WEIXIN_CORE_PROTOCOL_VERSION = ${REQUIRED_BUCKET_CORE_PROTOCOL_VERSION}`)) return null;
    const bytes = new TextEncoder().encode(code);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const mod = await import(`data:application/javascript;base64,${btoa(bin)}`);
    if (typeof mod.pollOnce !== "function"
      || typeof mod.setMediaReplyEnabled !== "function"
      || mod.WEIXIN_CORE_PROTOCOL_VERSION !== REQUIRED_BUCKET_CORE_PROTOCOL_VERSION) return null;
    cachedBucketCore = mod;
    cachedBucketCoreAt = now;
    cachedBucketCoreEtag = res.headers.get("etag") || "";
    return mod;
  } catch {
    return null;
  }
}
// 单次调用的时间预算：Edge Function 免费档墙钟上限 150s。只留 10s 给
// 收尾动作（状态回写/心跳/响应），把尽量多的时间让给 LLM 与媒体生成，
// 减少"预算不足降级模板卡"的频率；各环节的内层预留见 assistant-core。
const CLOUD_POLL_BUDGET_MS = 140_000;

// mode=loop 子轮询：cron 每分钟触发一次，函数内部隔 ~12 秒再拉几轮，
// 体验等同旧的 10 秒 cron，调用次数只有 1/6。窗口只占前 50 秒，
// 生成长回复时循环自然让位（每轮开始前检查剩余窗口）。
const CLOUD_LOOP_WINDOW_MS = 50_000;
const CLOUD_LOOP_INTERVAL_MS = 12_000;

const CLOUD_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function cloudJsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CLOUD_CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function buildCloudEnv(body) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("missing_supabase_env: 未读到 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，请确认函数部署在你自己的 Supabase 项目里。");
  }
  return {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    SUPABASE_BUCKET: typeof body?.bucket === "string" && body.bucket.trim() ? body.bucket.trim() : DEFAULT_BUCKET,
    WEIXIN_AUTO_REPLY: "true",
  };
}

// 部署密钥 10 分钟内存缓存：它只在用户重新生成密钥时才变，不值得每轮回源。
// 校验失败时穿透缓存重取一次，保证换钥后旧实例最多多打一次 Storage 就能跟上。
let cachedCronSecret = "";
let cachedCronSecretAt = 0;
const CRON_SECRET_TTL_MS = 10 * 60 * 1000;

async function loadCronSecret(env, force = false) {
  const now = Date.now();
  if (!force && cachedCronSecret && now - cachedCronSecretAt < CRON_SECRET_TTL_MS) return cachedCronSecret;
  const secret = await getObjectJson(env, CLOUD_CRON_SECRET_PATH).catch(() => null);
  const token = typeof secret?.token === "string" ? secret.token.trim() : "";
  if (token) {
    cachedCronSecret = token;
    cachedCronSecretAt = now;
  }
  return token;
}

async function verifyCloudCronToken(env, body) {
  const provided = typeof body?.token === "string" ? body.token.trim() : "";
  if (!provided) return { ok: false, status: 401, error: "missing_token" };
  let expected = await loadCronSecret(env);
  if (expected && provided !== expected) expected = await loadCronSecret(env, true);
  if (!expected) {
    return { ok: false, status: 500, error: "missing_cron_secret: 云端还没有部署密钥，请回到小手机微信设置重新复制定时 SQL。" };
  }
  if (provided !== expected) return { ok: false, status: 401, error: "invalid_token" };
  return { ok: true };
}

// 在线开关定时任务：小手机传 action=enable/disable/status，函数直连数据库
// 执行 cron.schedule / cron.unschedule（SUPABASE_DB_URL 由平台自动注入）。
// postgres 驱动按需动态加载，正常轮询路径不引入额外依赖。
async function runCloudScheduleAction(env, action) {
  const dbUrl = Deno.env.get("SUPABASE_DB_URL") || "";
  if (!dbUrl) {
    throw new Error("missing_SUPABASE_DB_URL: 当前环境读不到数据库连接串，无法在线开关定时任务，请改用手动 SQL。");
  }
  const { default: postgres } = await import("npm:postgres@3.4.7");
  const sql = postgres(dbUrl, { prepare: false });
  try {
    if (action === "enable") {
      const secret = await getObjectJson(env, CLOUD_CRON_SECRET_PATH).catch(() => null);
      const token = typeof secret?.token === "string" ? secret.token.trim() : "";
      if (!token) throw new Error("missing_cron_secret: 请回到小手机重新点「开启云端轮询」。");
      const functionUrl = `${env.SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/weixin-assistant`;
      await sql.unsafe("create extension if not exists pg_cron");
      await sql.unsafe("create extension if not exists pg_net");
      // 每分钟触发一次、函数内部按 ~12 秒子轮询（mode=loop）：回复延迟与旧的
      // 10 秒 cron 基本一致，但 Edge Function 调用次数降到 1/6（约 4.3 万次/月，
      // 免费档 50 万次的 9%）。timeout 只是 pg_net 等待响应的上限，函数照常跑完。
      await sql.unsafe(`select cron.schedule('${CLOUD_CRON_JOB_NAME}', '* * * * *', $CRON$
  select net.http_post(
    url     := '${functionUrl}',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object('token', '${token}', 'bucket', '${env.SUPABASE_BUCKET}', 'mode', 'loop'),
    timeout_milliseconds := 8000
  );
$CRON$)`);
      // pg_cron 每次运行都会往 cron.job_run_details 记一行，长期不清会蚕食免费档
      // 500MB 数据库容量；挂一个每天一次的清理任务，只留最近 3 天。
      await sql.unsafe(`select cron.schedule('${CLOUD_CRON_JOB_NAME}-cleanup', '0 3 * * *', $CRON$
  delete from cron.job_run_details where end_time < now() - interval '3 days';
$CRON$)`);
      return { scheduled: true };
    }
    if (action === "disable") {
      await sql.unsafe(`select cron.unschedule('${CLOUD_CRON_JOB_NAME}')`).catch(() => {});
      await sql.unsafe(`select cron.unschedule('${CLOUD_CRON_JOB_NAME}-cleanup')`).catch(() => {});
      return { scheduled: false };
    }
    const rows = await sql.unsafe(`select active from cron.job where jobname = '${CLOUD_CRON_JOB_NAME}'`);
    return { scheduled: rows.length > 0 && rows[0].active !== false };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function writeCloudHeartbeat(env, state) {
  await putObject(env, CLOUD_ASSISTANT_STATE_PATH, JSON.stringify({
    format: "ai-phone-weixin-cloud-assistant-state",
    version: 1,
    ...state,
  }, null, 2), "application/json").catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CLOUD_CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return cloudJsonResponse(405, { ok: false, error: "method_not_allowed" });
  }

  const body = await req.json().catch(() => ({}));
  let env;
  try {
    env = buildCloudEnv(body);
  } catch (err) {
    return cloudJsonResponse(500, { ok: false, error: errorMessage(err) });
  }

  const auth = await verifyCloudCronToken(env, body);
  if (!auth.ok) {
    return cloudJsonResponse(auth.status, { ok: false, error: auth.error });
  }

  const action = typeof body?.action === "string" ? body.action.trim() : "";
  if (action === "enable" || action === "disable" || action === "status") {
    try {
      const result = await runCloudScheduleAction(env, action);
      return cloudJsonResponse(200, { ok: true, action, ...result });
    } catch (err) {
      return cloudJsonResponse(500, { ok: false, action, error: errorMessage(err) });
    }
  }

  // 优先使用桶里的最新核心逻辑，失败回退到内置版本。
  const bucketCore = await loadBucketCore(env);
  const core = bucketCore || { pollOnce, setMediaReplyEnabled };

  // 离线主动发送：push-generate / push-bridge 凭部署密钥调用，把角色离线
  // 生成的消息改送微信（借该 bot 最近一条入站消息的回复上下文）。
  if (action === "send-text") {
    const botId = typeof body?.bot === "string" ? body.bot.trim() : "";
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
    if (!botId || !text) return cloudJsonResponse(400, { ok: false, error: "missing_bot_or_text" });
    const replyAnchor = {
      localMessageId: typeof body?.replyAfterLocalMessageId === "string" ? body.replyAfterLocalMessageId : "",
      createdAt: typeof body?.replyAfterCreatedAt === "string" ? body.replyAfterCreatedAt : "",
    };
    const bucketSendFn = bucketCore && typeof bucketCore.sendProactiveText === "function"
      ? bucketCore.sendProactiveText
      : null;
    const sendFn = bucketSendFn && (!replyAnchor.localMessageId || bucketSendFn.length >= 4)
      ? bucketSendFn
      : sendProactiveText;
    try {
      const result = await sendFn(env, botId, text, replyAnchor);
      return cloudJsonResponse(200, { ok: true, ...result });
    } catch (err) {
      return cloudJsonResponse(500, { ok: false, error: errorMessage(err) });
    }
  }

  // 媒体回复开关以运行包 promptContext.mediaReply 为准（随小手机同步下发）；
  // 请求体传 {"media": true} 可在旧运行包上强制开启。
  core.setMediaReplyEnabled(body?.media === true);

  const startedAt = Date.now();
  const targetBotId = typeof body?.bot === "string" && body.bot.trim() ? body.bot.trim() : undefined;
  const loopMode = body?.mode === "loop";
  try {
    let iterations = 0;
    let lastRows = [];
    let received = 0, stored = 0, sent = 0, skippedForDeadline = 0;
    let firstError;
    for (;;) {
      iterations += 1;
      const result = await core.pollOnce(env, targetBotId, {
        deadlineAt: startedAt + CLOUD_POLL_BUDGET_MS,
        debug: body?.debug === true,
      });
      const rows = Array.isArray(result?.results) ? result.results : [];
      lastRows = rows.length > 0 ? rows : lastRows;
      received += rows.reduce((sum, row) => sum + Number(row.received || 0), 0);
      stored += rows.reduce((sum, row) => sum + Number(row.stored || 0), 0);
      sent += rows.reduce((sum, row) => sum + Number(row.autoReply?.sent || 0), 0);
      skippedForDeadline += Number(result?.skippedForDeadline || 0);
      firstError = firstError || rows.map(row =>
        row.autoReply?.error
        || (row.tokenExpired ? "Token 已过期，请重新扫码" : "")
        || (row.ilinkErrorCode !== undefined ? `iLink error_code ${row.ilinkErrorCode}` : ""),
      ).find(Boolean);
      if (!loopMode) break;
      const nextAt = startedAt + iterations * CLOUD_LOOP_INTERVAL_MS;
      if (nextAt - startedAt >= CLOUD_LOOP_WINDOW_MS) break;
      const waitMs = nextAt - Date.now();
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      if (Date.now() - startedAt >= CLOUD_LOOP_WINDOW_MS) break;
    }
    const summary = {
      polled: lastRows.length,
      received,
      stored,
      sent,
      skippedForDeadline,
      iterations,
      elapsedMs: Date.now() - startedAt,
      codeSource: bucketCore ? "bucket" : "bundled",
      bots: lastRows.map(row => ({
        botId: row.botId,
        characterId: row.characterId,
        received: row.received,
        ilinkErrorCode: row.ilinkErrorCode,
        autoReplyStatus: row.autoReply?.status,
      })),
      error: firstError,
    };
    console.log(`[weixin-assistant] ${JSON.stringify(summary)}`);
    await writeCloudHeartbeat(env, {
      lastRunAt: new Date().toISOString(),
      lastError: summary.error,
      ...summary,
    });
    return cloudJsonResponse(200, { ok: true, ...summary });
  } catch (err) {
    const message = errorMessage(err);
    await writeCloudHeartbeat(env, {
      lastRunAt: new Date().toISOString(),
      lastError: message,
      elapsedMs: Date.now() - startedAt,
    });
    return cloudJsonResponse(500, { ok: false, error: message });
  }
});
