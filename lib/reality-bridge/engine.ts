"use client";

import { simpleLLMCall } from "../api-helpers";
import { loadApiConfigs, resolveAuxiliaryApiConfig, resolveUserIdentity } from "../settings-storage";
import { loadCharacters } from "../character-storage";
import { MacroEngine } from "../macro-engine";
import {
  addChatContact,
  CHAT_REQUEST_REPLY_EVENT,
  createOrGetSession,
  loadChatContacts,
  pushChatMessage,
  reindexSessionMessageOrdersByTime,
  type ChatMessage,
  upsertImportedChatMessage,
} from "../chat-storage";
import { cancelFollowUp, requestBackgroundChatReply } from "../follow-up-service";
import { saveMemoryEntry } from "../memory-storage";
import { appendCustomAppTimelineEntry } from "../custom-app-storage";
import { upsertCalendarScheduleItem } from "../calendar-storage";
import { getWeekStartIso } from "../calendar-utils";
import { sendBrowserNotification } from "../browser-notification";
import { dispatchChatMessageNotice } from "../chat-notification-events";
import { createShortcutCommand } from "../shortcut-command-client";
import {
  REALITY_BRIDGE_DATA_EVENT,
  type BridgeFeedEntry,
  type BridgeItem,
  type BridgeRule,
} from "./types";
import {
  appendBridgeFeed,
  appendBridgeOutbox,
  bridgeConnection,
  getBridgeRuleLastRunAt,
  loadBridgeRules,
  loadBridgeSettings,
  loadBridgeShortcutActions,
  markBridgeRuleRun,
  mergeBridgeRuleRuns,
} from "./storage";

const BRIDGE_SOURCE = { id: "reality_bridge", name: "现实桥" };

function fillTemplate(template: string, item: BridgeItem): string {
  return template
    .replace(/\{payload\}/g, item.payload)
    .replace(/\{type\}/g, item.type);
}

/** 展开 {{user}}/{{char}} 等宏：现实桥消息属于模板性质，写入前先替换 */
function expandBridgeMacros(text: string, characterId?: string): string {
  if (!text.includes("{{")) return text;
  const charName = characterId
    ? (loadCharacters().find(item => item.id === characterId)?.name ?? "")
    : "";
  const userName = resolveUserIdentity(characterId)?.name || "用户";
  try {
    return new MacroEngine(charName, userName).expand(text);
  } catch {
    return text;
  }
}

async function processText(rule: BridgeRule, item: BridgeItem): Promise<string> {
  const mode = rule.process?.mode ?? "raw";
  if (mode === "template" && rule.process.template) {
    return fillTemplate(rule.process.template, item).slice(0, 4000);
  }
  if (mode === "ai" && rule.process.prompt) {
    const config = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") ?? loadApiConfigs()[0];
    if (config) {
      const prompt = fillTemplate(rule.process.prompt, item);
      const result = await simpleLLMCall(config, [
        { role: "system", content: "你是「现实桥」的数据加工器。按用户指令处理数据，只输出处理结果本身，不要解释。" },
        { role: "user", content: prompt + "\n\n数据内容：" + item.payload },
      ], { temperature: 0.5 });
      const text = (result.content ?? "").trim();
      if (text) return text.slice(0, 4000);
    }
  }
  return item.payload;
}

/** 广播 bridge.data 事件给已订阅的自定义 APP（规则动作与「允许自定义APP订阅」总开关共用） */
function broadcastBridgeItemToApps(item: BridgeItem, text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(REALITY_BRIDGE_DATA_EVENT, {
    detail: { type: item.type, payload: item.payload, processed: text, receivedAt: item.createdAt },
  }));
}

const BROADCAST_ACTION_NOTE = "广播事件";

/** 通知打开中的聊天室刷新（与分享卡片等外部写入同一事件） */
function notifyChatUpdated(sessionId: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
  }
}

function ensureSession(characterId: string) {
  if (!loadChatContacts().some(contact => contact.characterId === characterId)) {
    addChatContact(characterId);
  }
  return createOrGetSession(characterId);
}

async function runChatAction(
  rule: NonNullable<BridgeRule["actions"]["chat"]>,
  text: string,
): Promise<string> {
  const session = ensureSession(rule.characterId);
  // role = 聊天室里的显示身份；historyRole = 角色记忆里的身份（缺省跟随显示）
  const historyRole = rule.historyRole && rule.historyRole !== rule.role ? rule.historyRole : undefined;
  const effectiveRole = rule.historyRole || rule.role;
  pushChatMessage({
    sessionId: session.id,
    role: rule.role,
    content: expandBridgeMacros(text, session.contactId),
    mediaData: historyRole ? ({ appHistoryRole: historyRole } as ChatMessage["mediaData"]) : undefined,
  });
  notifyChatUpdated(session.id);
  // 与聊天室发消息同款：用户这边有新动静，旧的追问计划作废（回应生成后会重新安排）
  if (effectiveRole === "user") cancelFollowUp(session.id);
  // 记忆里算TA自己说的话，就没有「回话」可言；我说的/旁白事件都可以让TA回应
  if (!rule.requestReply || effectiveRole === "assistant") return "写入聊天";
  // 聊天室正开着这个会话时，交给它原生生成（输入中状态、锁定输入、分条协议全套）
  if (typeof window !== "undefined") {
    const detail = { source: "reality_bridge", sessionId: session.id, characterId: rule.characterId, handled: false, busy: false };
    window.dispatchEvent(new CustomEvent(CHAT_REQUEST_REPLY_EVENT, { detail }));
    if (detail.handled) return detail.busy ? "写入聊天（角色正在回复中）" : "写入聊天，已由聊天室生成回应";
    // 桥自己接管后台生成：先置 handled，避免 desktop-shell 的兜底监听
    // 稍后又触发一次 requestBackgroundChatReply（双重生成）
    detail.handled = true;
  }
  // 统一后台回复链路：与追问/自定义APP同一实现
  // （分条、状态栏、拍一拍、来电、收红包、生图、横幅+弹窗、逐条弹出、安排追问）
  try {
    const result = await requestBackgroundChatReply(session.id);
    if (result.ok) return "写入聊天并生成回应";
    if (result.skipped === "already_running") return "写入聊天（角色正在回复中）";
  } catch (err) {
    console.warn("[现实桥] 角色回应生成失败", err);
  }
  return "写入聊天（回应失败）";
}

async function runActions(rule: BridgeRule, item: BridgeItem, text: string): Promise<string[]> {
  const done: string[] = [];
  const actions = rule.actions ?? {};

  if (actions.chat?.characterId) {
    done.push(await runChatAction(actions.chat, text));
  }
  if (actions.memory?.characterId) {
    const now = new Date().toISOString();
    await saveMemoryEntry({
      id: `bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      characterId: actions.memory.characterId,
      sourceApp: "chat",
      type: actions.memory.type === "core" ? "core" : "long_term",
      content: expandBridgeMacros(text, actions.memory.characterId).slice(0, 1000),
      importance: 0.6,
      createdAt: now,
      updatedAt: now,
    });
    done.push("写入记忆");
  }
  if (actions.timeline?.characterId) {
    appendCustomAppTimelineEntry(BRIDGE_SOURCE, {
      characterId: actions.timeline.characterId,
      summary: expandBridgeMacros(text, actions.timeline.characterId).slice(0, 200),
      detail: item.payload.slice(0, 1000),
    });
    done.push("写入时间线");
  }
  if (actions.notify) {
    sendBrowserNotification("现实桥 · " + item.type, { body: expandBridgeMacros(text).slice(0, 120) });
    done.push("系统通知");
  }
  if (actions.calendar) {
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    let startTime: string;
    let endTime: string;
    const duration = Number(actions.calendar.durationMinutes);
    if (Number.isFinite(duration) && duration > 0) {
      // 新版：以触发时刻为锚点，向前或向后铺 duration 分钟，跨天部分钳在今天之内
      const span = Math.min(720, Math.max(5, duration)) * 60_000;
      const start = actions.calendar.direction === "past" ? new Date(now.getTime() - span) : now;
      const end = actions.calendar.direction === "past" ? now : new Date(now.getTime() + span);
      startTime = start.getDate() === now.getDate() ? hm(start) : "00:00";
      endTime = end.getDate() === now.getDate() ? hm(end) : "23:59";
    } else {
      // 旧版规则：固定时段
      startTime = actions.calendar.startTime || "09:00";
      endTime = actions.calendar.endTime || "10:00";
    }
    upsertCalendarScheduleItem("user", "user", getWeekStartIso(now), {
      date: iso,
      startTime,
      endTime,
      location: "",
      title: expandBridgeMacros(text).slice(0, 60),
      source: "manual",
    });
    done.push("写入日历");
  }
  if (actions.card?.characterId) {
    const session = ensureSession(actions.card.characterId);
    const cardText = expandBridgeMacros(text, actions.card.characterId);
    pushChatMessage({
      sessionId: session.id,
      role: "user",
      content: cardText.slice(0, 2000),
      mediaType: "app_card",
      mediaData: {
        appId: BRIDGE_SOURCE.id,
        appName: BRIDGE_SOURCE.name,
        appCardTitle: item.type,
        appCardBody: cardText.slice(0, 2000),
        appCardSummary: cardText.slice(0, 200),
      } as ChatMessage["mediaData"],
    });
    notifyChatUpdated(session.id);
    done.push("发送卡片");
  }
  if (actions.shortcut?.actionId) {
    const shortcutAction = loadBridgeShortcutActions()
      .find(entry => entry.id === actions.shortcut?.actionId && entry.enabled);
    if (shortcutAction) {
      try {
        const created = await createShortcutCommand(shortcutAction, {});
        done.push(created.delivered
          ? `发出快捷动作「${shortcutAction.name}」`
          : `快捷动作「${shortcutAction.name}」未能送达`);
      } catch (err) {
        done.push(`快捷动作「${shortcutAction.name}」失败：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`);
      }
    }
  }
  if (actions.outbox?.type) {
    const { config, ready } = bridgeConnection();
    if (ready) {
      await appendBridgeOutbox(config, { type: actions.outbox.type, payload: expandBridgeMacros(text).slice(0, 2000), source: "rule" });
      done.push("回传 iPhone");
    }
  }
  if (actions.broadcast) {
    broadcastBridgeItemToApps(item, text);
    done.push(BROADCAST_ACTION_NOTE);
  }
  return done;
}

/** 服务端处理过的桥事件·回端补账：写桥消息、补执行非聊天动作、记流水、回灌冷却。
 *  角色回复正文由调用方（push-outbox-client）走通用解析管线单独合并。 */
export async function applyServerBridgeEntry(meta: {
  item?: { id?: string; type?: string; payload?: string; createdAt?: string };
  /** 服务端生成并传给微信云消息的同一个因果锚点 ID。 */
  chatMessageId?: string;
  ruleId?: string;
  ruleName?: string;
  ranAt?: string;
  executed?: boolean;
  processedText?: string;
  /** 聊天气泡仍显示 processedText；可另给模型一份更完整但不打扰 UI 的历史文本。 */
  historyText?: string;
  feedNote?: string;
  shortcutNote?: string;
  capped?: boolean;
  chat?: {
    characterId?: string;
    sessionId?: string;
    role?: "user" | "assistant" | "system";
    historyRole?: "user" | "assistant" | "system";
    requestReply?: boolean;
  } | null;
}): Promise<{ sessionId?: string }> {
  const item: BridgeItem = {
    id: String(meta.item?.id ?? `srv_${Date.now().toString(36)}`),
    type: String(meta.item?.type ?? "数据"),
    payload: String(meta.item?.payload ?? ""),
    createdAt: String(meta.item?.createdAt ?? new Date().toISOString()),
  };
  const text = meta.processedText ?? item.payload;
  const actionNotes: string[] = [];
  let sessionId: string | undefined;

  if (meta.ruleId && meta.ranAt) {
    mergeBridgeRuleRuns({ [meta.ruleId]: meta.ranAt });
  }

  // 桥消息写入（与 runChatAction 的写入部分同规则；回复由外层合并）
  if (meta.chat?.characterId && meta.chat.role) {
    const session = ensureSession(meta.chat.characterId);
    sessionId = session.id;
    const historyRole = meta.chat.historyRole && meta.chat.historyRole !== meta.chat.role ? meta.chat.historyRole : undefined;
    const effectiveRole = meta.chat.historyRole || meta.chat.role;
    const sourceMs = Date.parse(item.createdAt);
    const createdAt = Number.isFinite(sourceMs) ? new Date(sourceMs).toISOString() : new Date().toISOString();
    const fallbackId = `bridge_${String(meta.ruleId || "rule")}_${item.id}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 240);
    upsertImportedChatMessage({
      id: String(meta.chatMessageId || fallbackId),
      sessionId: session.id,
      role: meta.chat.role,
      content: expandBridgeMacros(text, session.contactId),
      status: "sent",
      createdAt,
      mediaData: (historyRole || meta.historyText) ? ({
        ...(historyRole ? { appHistoryRole: historyRole } : {}),
        ...(meta.historyText ? { appHistoryText: expandBridgeMacros(meta.historyText, session.contactId) } : {}),
      } as ChatMessage["mediaData"]) : undefined,
    });
    // 服务端回端补账发生在 App 重开时，不能用“此刻”作为桥事件时间；按收件箱
    // 原始 createdAt 重排，确保桥输入位于它触发的云端微信回复之前。
    reindexSessionMessageOrdersByTime(session.id);
    notifyChatUpdated(session.id);
    if (effectiveRole === "user") cancelFollowUp(session.id);
    actionNotes.push("写入聊天（服务端触发）");
  }

  // 非聊天动作补执行：仅对服务端真正执行过的条目重放（冷却/无规则的存档条不补），
  // 规则已删则跳过
  const rule = meta.executed && meta.ruleId ? loadBridgeRules().find(r => r.id === meta.ruleId) : undefined;
  if (rule) {
    // chat/notify/shortcut 服务端已执行过，补账只重放剩余动作
    const deferredRule: BridgeRule = {
      ...rule,
      actions: { ...rule.actions, chat: undefined, notify: undefined, shortcut: undefined },
    };
    try {
      actionNotes.push(...await runActions(deferredRule, item, text));
    } catch (err) {
      console.warn("[现实桥] 服务端事件补账失败", rule.name, err);
    }
  }
  if (meta.shortcutNote) actionNotes.push(meta.shortcutNote);
  if (meta.capped) actionNotes.push("已达当日服务端回复上限，仅存档");

  // 「允许自定义APP订阅」总开关：服务端补账的条目也照常广播（规则动作已广播过则不重复）
  if (loadBridgeSettings().broadcastToApps && !actionNotes.includes(BROADCAST_ACTION_NOTE)) {
    broadcastBridgeItemToApps(item, text);
    actionNotes.push(BROADCAST_ACTION_NOTE);
  }

  appendBridgeFeed({
    id: item.id,
    type: item.type,
    payload: item.payload.slice(0, 2000),
    processed: text !== item.payload ? text.slice(0, 2000) : undefined,
    rules: rule ? [rule.name] : meta.ruleName ? [meta.ruleName] : [],
    actions: meta.feedNote ? [meta.feedNote, ...actionNotes] : actionNotes,
    receivedAt: new Date().toISOString(),
  });
  return { sessionId };
}

/** 处理一条收件箱数据：匹配规则 → 加工 → 执行动作 → 记录流水。 */
export async function processBridgeItem(item: BridgeItem): Promise<BridgeFeedEntry> {
  const rules = loadBridgeRules().filter(rule =>
    rule.enabled && (rule.matchType === "*" || rule.matchType === item.type));
  const entry: BridgeFeedEntry = {
    id: item.id,
    type: item.type,
    payload: item.payload.slice(0, 2000),
    rules: rules.map(rule => rule.name),
    actions: [],
    receivedAt: new Date().toISOString(),
  };
  for (const rule of rules) {
    // 触发间隔：间隔内再次收到同信号，只存档不执行（避免反复打开某 APP 时刷屏）
    const cooldownMs = Math.max(0, Number(rule.cooldownMinutes) || 0) * 60_000;
    if (cooldownMs > 0 && Date.now() - getBridgeRuleLastRunAt(rule.id) < cooldownMs) {
      entry.actions.push(`「${rule.name}」还在触发间隔内，这次只存档`);
      continue;
    }
    try {
      markBridgeRuleRun(rule.id);
      const text = await processText(rule, item);
      if (text !== item.payload) entry.processed = text.slice(0, 2000);
      entry.actions.push(...await runActions(rule, item, text));
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      console.warn("[现实桥] 规则执行失败", rule.name, err);
    }
  }
  // 「允许自定义APP订阅」总开关：不管有没有命中规则，每条数据都广播一次
  // （规则动作已广播过则不重复；加工文本取最后一次加工结果）
  if (loadBridgeSettings().broadcastToApps && !entry.actions.includes(BROADCAST_ACTION_NOTE)) {
    broadcastBridgeItemToApps(item, entry.processed ?? item.payload);
    entry.actions.push(BROADCAST_ACTION_NOTE);
  }
  if (rules.length === 0 && entry.actions.length === 0) entry.actions.push("仅存档（无匹配规则）");
  appendBridgeFeed(entry);
  return entry;
}
