"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { loadCharacters } from "@/lib/character-storage";
import { CLOUD_BACKUP_BUCKET, normalizeBackupUrl } from "@/lib/cloud-backup/config";
import { pollRealityBridgeNow, REALITY_BRIDGE_FEED_UPDATED_EVENT } from "@/components/reality-bridge-scheduler";
import {
  bridgeConnection,
  clearBridgeFeed,
  getBridgeRuleLastRunAt,
  loadBridgeDataItems,
  loadBridgeFeed,
  loadBridgeRules,
  loadBridgeSettings,
  loadBridgeShortcutActions,
  saveShortcutEmailReady,
  loadScreenChatSettings,
  parseBridgeActionParameterSchema,
  readBridgeStateSnapshot,
  sanitizeBridgeDataKey,
  saveBridgeDataItems,
  saveBridgeRules,
  saveBridgeSettings,
  saveBridgeShortcutActions,
  saveScreenChatSettings,
  type BridgeDataItem,
  type BridgeShortcutAction,
  type ScreenChatSettings,
} from "@/lib/reality-bridge/storage";
import type { BridgeRule } from "@/lib/reality-bridge/types";
import { createShortcutCommand, loadRecentShortcutCommands, type ShortcutCommand } from "@/lib/shortcut-command-client";
import { enableOfflinePush, isShellEnvironment } from "@/lib/push-client";
import {
  isPersonalPushCloudActive,
  isPersonalScreenChatCloudReady,
  personalPushFetch,
} from "@/lib/personal-push-cloud";
import { isValidShortcutEmailAddress, shortcutEmailSubjectTag } from "@/lib/shortcut-email";

type TabId = "main" | "history";

type ShortcutEmailStatus = {
  providerConfigured: boolean;
  senderAddress: string;
  recipient: string;
  verified: boolean;
  verificationExpiresAt?: string;
};

function newRule(): BridgeRule {
  return {
    id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    matchType: "",
    enabled: true,
    process: { mode: "raw", template: "", prompt: "" },
    actions: {},
    createdAt: new Date().toISOString(),
  };
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const SHORTCUT_PARAMETER_SCHEMAS = {
  none: "{}",
  text: JSON.stringify({
    type: "object",
    properties: {
      content: { type: "string", description: "要交给快捷指令处理的内容" },
    },
    required: ["content"],
  }, null, 2),
  wait: JSON.stringify({
    type: "object",
    properties: {
      waitSeconds: { type: "number", description: "打开目标 APP 后等待多少秒，默认 2", minimum: 0, maximum: 10 },
    },
  }, null, 2),
} as const;

/* 参数清单 ↔ JSON Schema 互转：用户只填参数行，Schema 自动生成 */
type ShortcutParamRow = { key: string; type: "string" | "number"; description: string };

function parseShortcutParamRows(schemaText: string): ShortcutParamRow[] | null {
  try {
    const parsed = JSON.parse(schemaText || "{}") as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const props = (parsed as { properties?: unknown }).properties;
    if (props === undefined) return [];
    if (!props || typeof props !== "object" || Array.isArray(props)) return null;
    const rows: ShortcutParamRow[] = [];
    for (const [key, def] of Object.entries(props as Record<string, unknown>)) {
      if (!def || typeof def !== "object" || Array.isArray(def)) return null;
      const type = String((def as { type?: unknown }).type ?? "string");
      if (type !== "string" && type !== "number" && type !== "integer") return null;
      rows.push({
        key,
        type: type === "integer" ? "number" : type as ShortcutParamRow["type"],
        description: String((def as { description?: unknown }).description ?? ""),
      });
    }
    return rows;
  } catch {
    return null;
  }
}

function buildShortcutParamSchema(rows: ShortcutParamRow[]): string {
  const clean = rows.filter(row => row.key.trim());
  if (clean.length === 0) return "{}";
  const properties: Record<string, unknown> = {};
  for (const row of clean) {
    properties[row.key.trim()] = {
      type: row.type,
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
    };
  }
  return JSON.stringify({ type: "object", properties, required: clean.map(row => row.key.trim()) }, null, 2);
}

function newDataItem(): BridgeDataItem {
  return {
    id: `data_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    key: "",
    description: "",
    createdAt: new Date().toISOString(),
  };
}

function newShortcutAction(): BridgeShortcutAction {
  return {
    id: `shortcut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    shortcutName: "",
    description: "",
    parameterSchema: SHORTCUT_PARAMETER_SCHEMAS.none,
    resultMode: "none",
    deliveryMode: "push",
    expiresInSeconds: 120,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

function shortcutStatusLabel(status: ShortcutCommand["status"]): string {
  if (status === "pending") return "等待执行";
  if (status === "claimed") return "执行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  if (status === "expired") return "已过期";
  return "已取消";
}

function fmtHM(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

const FREQ_OPTIONS = [
  { value: 15, label: "15秒" },
  { value: 20, label: "20秒" },
  { value: 30, label: "30秒" },
  { value: 60, label: "1分" },
  { value: 300, label: "5分" },
] as const;

/* 细线图标（与参考风格一致的 stroke 图形） */
const RB_SVG = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const RB_ICON_PHONE = <svg {...RB_SVG}><rect x="7" y="2" width="10" height="20" rx="2.5" /><path d="M11 18h2" /></svg>;
const RB_ICON_CHAT = <svg {...RB_SVG}><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" /></svg>;
const RB_ICON_BOOK = <svg {...RB_SVG}><path d="M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" /><path d="M9 7h6" /></svg>;
const RB_ICON_CALENDAR = <svg {...RB_SVG}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>;
const RB_ICON_BELL = <svg {...RB_SVG}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;
const RB_ICON_CARD = <svg {...RB_SVG}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 10h18" /></svg>;
const RB_ICON_BROADCAST = <svg {...RB_SVG}><circle cx="12" cy="12" r="2" /><path d="M7.5 7.5a6.5 6.5 0 0 0 0 9M16.5 7.5a6.5 6.5 0 0 1 0 9" /></svg>;
const RB_ICON_INBOX = <svg {...RB_SVG}><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6z" /></svg>;
const RB_ICON_GEAR = <svg {...RB_SVG}><circle cx="12" cy="12" r="3" /><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /></svg>;
const RB_ICON_HISTORY = <svg {...RB_SVG}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>;
const RB_ICON_REFRESH = <svg {...RB_SVG}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>;
const RB_ICON_CHEVRON = <svg {...RB_SVG}><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>;
const RB_ICON_DOTS = <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" /></svg>;
const RB_ICON_ARROW = <svg {...RB_SVG}><path d="M9.5 5.5 16 12l-6.5 6.5" /></svg>;
const RB_ICON_TRASH = <svg {...RB_SVG}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></svg>;
const RB_ICON_CROSS = <svg {...RB_SVG}><path d="M6 6l12 12M18 6 6 18" /></svg>;
const RB_ICON_CLOCK = <svg {...RB_SVG}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const RB_ICON_CHECK = <svg {...RB_SVG}><path d="M4.5 12.5 10 18 19.5 6.5" /></svg>;

const WIZ_STEP_NAMES = ["接通管道", "创建快捷指令", "选择信号", "加工内容", "决定动作", "测试与保存"] as const;
const SWIZ_STEP_NAMES = ["接通通道", "动作是什么", "触发方式", "参数与结果", "创建快捷指令", "测试与保存"] as const;
const DWIZ_STEP_NAMES = ["接通通道", "数据项是什么", "创建上传快捷指令", "测试与保存"] as const;
const SCREEN_WIZ_STEP_NAMES = ["接通个人云", "选择角色", "创建快捷指令", "确认与启用"] as const;
const SCREEN_CHAT_SHORTCUT_URL = "https://www.icloud.com/shortcuts/d0ce177469a34aceb4c44b6eb14baae0";

function ruleIcon(rule: BridgeRule) {
  const a = rule.actions ?? {};
  if (a.chat) return RB_ICON_CHAT;
  if (a.card) return RB_ICON_CARD;
  if (a.memory || a.timeline) return RB_ICON_BOOK;
  if (a.calendar) return RB_ICON_CALENDAR;
  if (a.notify) return RB_ICON_BELL;
  if (a.outbox) return RB_ICON_PHONE;
  if (a.broadcast) return RB_ICON_BROADCAST;
  return RB_ICON_INBOX;
}

export function RealityBridgeApp({ onClose, onNotice }: {
  onClose: () => void;
  onNotice?: (text: string) => void;
}) {
  const [tab, setTab] = useState<TabId>("main");
  const [settings, setSettings] = useState(() => loadBridgeSettings());
  const [rules, setRules] = useState<BridgeRule[]>(() => loadBridgeRules());
  const [feed, setFeed] = useState(() => loadBridgeFeed());
  const [editing, setEditing] = useState<BridgeRule | null>(null);
  const [dataItems, setDataItems] = useState<BridgeDataItem[]>(() => loadBridgeDataItems());
  const [editingItem, setEditingItem] = useState<BridgeDataItem | null>(null);
  const [shortcutActions, setShortcutActions] = useState<BridgeShortcutAction[]>(() => loadBridgeShortcutActions());
  const [editingShortcut, setEditingShortcut] = useState<BridgeShortcutAction | null>(null);
  const [recentCommands, setRecentCommands] = useState<ShortcutCommand[]>([]);
  const [testingShortcut, setTestingShortcut] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // 换一个动作/重新打开向导时清掉上次的测试结果
  useEffect(() => { setTestResult(null); }, [editingShortcut?.id]);
  const [shortcutEmailStatus, setShortcutEmailStatus] = useState<ShortcutEmailStatus | null>(null);
  const [shortcutEmailInput, setShortcutEmailInput] = useState("");
  const [shortcutEmailCode, setShortcutEmailCode] = useState("");
  const [shortcutEmailBusy, setShortcutEmailBusy] = useState<"send" | "verify" | "remove" | null>(null);
  const [copiedText, setCopiedText] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [bridgeToken, setBridgeToken] = useState("");
  const [closing, setClosing] = useState(false);
  const [spinTurns, setSpinTurns] = useState(0);
  const [mainSec, setMainSec] = useState<"rules" | "shortcuts" | "queries" | "screen">("rules");
  const [screenChat, setScreenChat] = useState<ScreenChatSettings>(() => loadScreenChatSettings());
  const [editingScreenChat, setEditingScreenChat] = useState<ScreenChatSettings | null>(null);
  const [histSec, setHistSec] = useState<"feed" | "commands">("feed");
  const [confirmClear, setConfirmClear] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [wizStep, setWizStep] = useState(1);
  const [wizMax, setWizMax] = useState(1);
  const [swizStep, setSwizStep] = useState(1);
  const [swizMax, setSwizMax] = useState(1);
  const [paramRows, setParamRows] = useState<ShortcutParamRow[]>([]);
  const [paramAdvanced, setParamAdvanced] = useState(false);
  const [dwizStep, setDwizStep] = useState(1);
  const [dwizMax, setDwizMax] = useState(1);
  const [screenWizStep, setScreenWizStep] = useState(1);
  const [screenWizMax, setScreenWizMax] = useState(1);
  const [dataSnapshot, setDataSnapshot] = useState<{ text: string; updatedAt?: string } | "none" | null>(null);
  const [dataSnapshotBusy, setDataSnapshotBusy] = useState(false);
  const characters = useMemo(() => loadCharacters().map(c => ({ id: c.id, name: c.name })), []);
  const charName = useCallback((id?: string) => characters.find(c => c.id === id)?.name ?? "角色", [characters]);
  const { config, ready } = bridgeConnection();

  useEffect(() => {
    const refresh = () => setFeed(loadBridgeFeed());
    window.addEventListener(REALITY_BRIDGE_FEED_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(REALITY_BRIDGE_FEED_UPDATED_EVENT, refresh);
  }, []);


  useEffect(() => {
    if (tab !== "history") return;
    let cancelled = false;
    void loadRecentShortcutCommands(8)
      .then(commands => { if (!cancelled) setRecentCommands(commands); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [tab]);

  const refreshShortcutEmailStatus = useCallback(async () => {
    const response = await fetch("/api/push/shortcut-email", { credentials: "include", cache: "no-store" });
    const data = await response.json().catch(() => ({})) as ShortcutEmailStatus & { ok?: boolean; error?: string };
    if (!response.ok || data.ok === false) throw new Error(data.error || "邮箱状态读取失败。");
    setShortcutEmailStatus(data);
    setShortcutEmailInput(data.recipient || "");
    // 离线目录要同步知道邮件通道能不能用（提示词组装是同步的，取不了接口）
    saveShortcutEmailReady(data.providerConfigured === true && data.verified === true);
  }, []);

  /* 快捷动作向导选了邮件模式时，拉取邮箱验证状态 */
  const editingShortcutDelivery = editingShortcut?.deliveryMode;
  useEffect(() => {
    if (editingShortcutDelivery === "email") void refreshShortcutEmailStatus().catch(() => undefined);
  }, [editingShortcutDelivery, refreshShortcutEmailStatus]);

  /* 已经登记过邮件送达的动作：进页面就刷一次状态，把离线目录的就绪缓存校准。
     只在"有邮件动作"时打这个接口，没用邮件的用户不会平白多一次请求。 */
  const hasEnabledEmailAction = shortcutActions.some(item => item.enabled && item.deliveryMode === "email");
  useEffect(() => {
    if (!hasEnabledEmailAction) {
      saveShortcutEmailReady(false);
      return;
    }
    void refreshShortcutEmailStatus().catch(() => undefined);
  }, [hasEnabledEmailAction, refreshShortcutEmailStatus]);

  const sendShortcutEmailCode = useCallback(async () => {
    const recipient = shortcutEmailInput.trim().toLowerCase();
    if (!isValidShortcutEmailAddress(recipient)) {
      onNotice?.("请输入有效的邮箱地址");
      return;
    }
    setShortcutEmailBusy("send");
    try {
      const response = await fetch("/api/push/shortcut-email", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; verificationExpiresAt?: string };
      if (!response.ok || data.ok === false) throw new Error(data.error || "验证码发送失败。");
      setShortcutEmailStatus(previous => ({
        providerConfigured: previous?.providerConfigured ?? true,
        senderAddress: previous?.senderAddress || "",
        recipient,
        verified: false,
        verificationExpiresAt: data.verificationExpiresAt,
      }));
      onNotice?.("验证码已发送");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setShortcutEmailBusy(null);
    }
  }, [shortcutEmailInput, onNotice]);

  const verifyShortcutEmailCode = useCallback(async () => {
    if (!/^\d{6}$/.test(shortcutEmailCode.trim())) {
      onNotice?.("请输入六位验证码");
      return;
    }
    setShortcutEmailBusy("verify");
    try {
      const response = await fetch("/api/push/shortcut-email", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: shortcutEmailCode.trim() }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || data.ok === false) throw new Error(data.error || "邮箱验证失败。");
      setShortcutEmailCode("");
      await refreshShortcutEmailStatus();
      onNotice?.("接收邮箱已验证");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setShortcutEmailBusy(null);
    }
  }, [shortcutEmailCode, refreshShortcutEmailStatus, onNotice]);

  const removeShortcutEmail = useCallback(async () => {
    setShortcutEmailBusy("remove");
    try {
      const response = await fetch("/api/push/shortcut-email", { method: "DELETE", credentials: "include" });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || data.ok === false) throw new Error(data.error || "邮箱解绑失败。");
      setShortcutEmailStatus(previous => previous ? { ...previous, recipient: "", verified: false } : null);
      setShortcutEmailInput("");
      setShortcutEmailCode("");
      onNotice?.("接收邮箱已解绑");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setShortcutEmailBusy(null);
    }
  }, [onNotice]);

  const updateSettings = useCallback((patch: Partial<ReturnType<typeof loadBridgeSettings>>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveBridgeSettings(next);
      return next;
    });
  }, []);

  const updateScreenChat = useCallback((patch: Partial<ScreenChatSettings>) => {
    setScreenChat(prev => {
      const next = { ...prev, ...patch };
      saveScreenChatSettings(next);
      return next;
    });
  }, []);

  const persistRules = useCallback((next: BridgeRule[]) => {
    setRules(next);
    saveBridgeRules(next);
  }, []);

  const syncNow = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const count = await pollRealityBridgeNow();
      setFeed(loadBridgeFeed());
      onNotice?.(count > 0 ? `收到 ${count} 条新消息` : "暂时没有新消息");
    } finally {
      setSyncing(false);
    }
  }, [syncing, onNotice]);

  const saveEditing = useCallback(() => {
    if (!editing) return;
    if (!editing.matchType.trim()) {
      onNotice?.("请填写要接收的信号名");
      return;
    }
    const name = editing.name.trim() || `当收到「${editing.matchType.trim()}」`;
    const cleaned: BridgeRule = { ...editing, name: name.slice(0, 30), matchType: editing.matchType.trim().slice(0, 60) };
    const exists = rules.some(rule => rule.id === cleaned.id);
    persistRules(exists ? rules.map(rule => rule.id === cleaned.id ? cleaned : rule) : [cleaned, ...rules]);
    setEditing(null);
    onNotice?.("联动已保存");
  }, [editing, rules, persistRules, onNotice]);

  const summarize = useCallback((rule: BridgeRule): string => {
    const parts: string[] = [];
    const a = rule.actions;
    if (a.chat) {
      const who = charName(a.chat.characterId);
      const effectiveRole = a.chat.historyRole || a.chat.role;
      const base = a.chat.role === "assistant" ? `以${who}的口吻记下`
        : a.chat.role === "system" ? `旁白记给${who}`
        : `告诉${who}`;
      parts.push(base + (a.chat.requestReply && effectiveRole !== "assistant" ? "并等TA回话" : ""));
    }
    if (a.memory) parts.push(`让${charName(a.memory.characterId)}记住`);
    if (a.timeline) parts.push("记入短期记忆");
    if (a.card) parts.push("做成卡片发过去");
    if (a.notify) parts.push("弹通知提醒我");
    if (a.calendar) parts.push("记到日历");
    if (a.shortcut) {
      const shortcutName = shortcutActions.find(item => item.id === a.shortcut?.actionId)?.name;
      parts.push(shortcutName ? `执行「${shortcutName}」` : "执行快捷动作");
    }
    if (a.outbox) parts.push("回传到 iPhone");
    if (a.broadcast) parts.push("转发给其他 APP");
    const summary = parts.length ? parts.join("、") : "只是收下来看看";
    const cooldown = Number(rule.cooldownMinutes) || 0;
    if (cooldown <= 0) return summary;
    const label = cooldown % 60 === 0 ? `${cooldown / 60} 小时` : `${cooldown} 分钟`;
    return `${summary}（${label}内只触发一次）`;
  }, [charName, shortcutActions]);

  const uploadUrl = `${config.url || "https://你的项目.supabase.co"}/storage/v1/object/${CLOUD_BACKUP_BUCKET}/bridge-inbox/[文件名].json`;
  const siteOrigin = typeof window !== "undefined" ? window.location.origin : "https://你的小手机域名";
  // 个人云激活时唤醒入口在用户自己的网关（离线扫描由用户库的 cron 驱动）；否则走站点
  const personalPushActive = isPersonalPushCloudActive();
  const personalScreenChatReady = isPersonalScreenChatCloudReady();
  const wakeUrl = bridgeToken
    ? personalPushActive
      ? `${normalizeBackupUrl(config.url)}/functions/v1/ai-phone-push?action=bridge-wake&token=${bridgeToken}`
      : `${siteOrigin}/api/push/bridge-wake?token=${bridgeToken}`
    : "";

  // 屏幕速聊同步入口（部署在用户个人云上的 screen-chat 函数）
  const screenChatUrl = `${normalizeBackupUrl(config.url) || "https://你的项目.supabase.co"}/functions/v1/screen-chat`;

  // 屏幕速聊令牌只从个人云读取，绝不回退到站点主项目。
  const wantWakeToken = editing !== null || mainSec === "screen";
  useEffect(() => {
    if (!wantWakeToken || bridgeToken) return;
    if (mainSec === "screen" && !personalScreenChatReady) return;
    let cancelled = false;
    const request = personalPushActive
      ? personalPushFetch("bridge-config")
      : fetch("/api/push/bridge-config", { credentials: "include" });
    void request
      .then(response => response.ok ? response.json() : null)
      .then((data: { ok?: boolean; bridgeToken?: string } | null) => {
        if (!cancelled && data?.ok && data.bridgeToken) setBridgeToken(data.bridgeToken);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [wantWakeToken, bridgeToken, personalPushActive, personalScreenChatReady, mainSec]);
  const stateUrl = useCallback((key: string) =>
    `${config.url || "https://你的项目.supabase.co"}/storage/v1/object/${CLOUD_BACKUP_BUCKET}/bridge-state/${key || "[标识]"}.json`, [config.url]);

  const persistDataItems = useCallback((next: BridgeDataItem[]) => {
    setDataItems(next);
    saveBridgeDataItems(next);
  }, []);

  const persistShortcutActions = useCallback((next: BridgeShortcutAction[]) => {
    setShortcutActions(next);
    saveBridgeShortcutActions(next);
  }, []);

  const saveEditingItem = useCallback(() => {
    if (!editingItem) return;
    const name = editingItem.name.trim().slice(0, 20);
    const key = sanitizeBridgeDataKey(editingItem.key);
    if (!name || !key) {
      onNotice?.("名称和标识都需要填写");
      return;
    }
    if (dataItems.some(item => item.id !== editingItem.id && (item.name === name || item.key === key))) {
      onNotice?.("名称或标识与已有数据项重复");
      return;
    }
    const cleaned: BridgeDataItem = { ...editingItem, name, key, description: editingItem.description.trim().slice(0, 200) };
    const exists = dataItems.some(item => item.id === cleaned.id);
    persistDataItems(exists ? dataItems.map(item => item.id === cleaned.id ? cleaned : item) : [...dataItems, cleaned]);
    setEditingItem(null);
    onNotice?.("数据项已保存");
  }, [editingItem, dataItems, persistDataItems, onNotice]);

  const saveEditingShortcut = useCallback(() => {
    if (!editingShortcut) return;
    const name = editingShortcut.name.trim().slice(0, 30);
    const shortcutName = editingShortcut.shortcutName.trim().slice(0, 80);
    const description = editingShortcut.description.trim().slice(0, 300);
    const parameterSchema = editingShortcut.parameterSchema.trim() || "{}";
    if (!name || !shortcutName || !description) {
      onNotice?.("工具名称、快捷指令名称和用途说明都需要填写");
      return;
    }
    if (!parseBridgeActionParameterSchema(parameterSchema)) {
      onNotice?.("参数定义不是有效的 JSON 对象");
      return;
    }
    if (parameterSchema.length > 8000) {
      onNotice?.("参数定义过长");
      return;
    }
    const reservedNames = new Set(["查看全部手机数据", ...dataItems.map(item => item.name)]);
    if (reservedNames.has(name)) {
      onNotice?.("工具名称与现实桥已有动作重复");
      return;
    }
    if (shortcutActions.some(item => item.id !== editingShortcut.id && item.name === name)) {
      onNotice?.("工具名称与已有快捷动作重复");
      return;
    }
    const cleaned: BridgeShortcutAction = {
      ...editingShortcut,
      name,
      shortcutName,
      description,
      parameterSchema,
      expiresInSeconds: Math.max(30, Math.min(900, Number(editingShortcut.expiresInSeconds) || 120)),
    };
    const exists = shortcutActions.some(item => item.id === cleaned.id);
    persistShortcutActions(exists
      ? shortcutActions.map(item => item.id === cleaned.id ? cleaned : item)
      : [...shortcutActions, cleaned]);
    setEditingShortcut(null);
    onNotice?.("快捷动作已加入现实桥工具箱");
  }, [editingShortcut, shortcutActions, dataItems, persistShortcutActions, onNotice]);

  const testEditingShortcut = useCallback(async () => {
    if (!editingShortcut || testingShortcut) return;
    setTestingShortcut(true);
    try {
      // "已发送"只代表推送服务接收，旧设备的僵尸订阅也会计入——先把本设备
      // 的订阅强制刷新一遍，保证测试通知一定包含当前手机。
      if (editingShortcut.deliveryMode !== "email" && !isShellEnvironment()) {
        const enabled = await enableOfflinePush();
        if (!enabled.ok) {
          setTestResult({ ok: false, text: `本设备推送订阅未就绪：${enabled.error || "未知原因"}` });
          return;
        }
      }
      const schema = parseBridgeActionParameterSchema(editingShortcut.parameterSchema) || {};
      const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? schema.properties as Record<string, { type?: unknown }>
        : {};
      const args: Record<string, unknown> = {};
      for (const [key, definition] of Object.entries(properties)) {
        args[key] = definition?.type === "number" || definition?.type === "integer"
          ? (key === "waitSeconds" ? 2 : 1)
          : definition?.type === "boolean" ? true : "来自小手机的测试";
      }
      const created = await createShortcutCommand(editingShortcut, args);
      if (created.delivered) {
        setTestResult({
          ok: true,
          text: editingShortcut.deliveryMode === "email"
            ? "测试邮件已发送"
            : created.line === "personal"
              ? "已发送，点弹出的通知即可运行"
              : isPersonalPushCloudActive()
                ? "已发送（站点旧通道）。请到「云服务部署」重新部署离线推送后再测"
                : "已发送。前台不弹通知，锁屏或退后台等通知即可",
        });
      } else {
        const detail = created.push?.error || created.email?.error || "";
        setTestResult({ ok: false, text: `测试命令未能送达${detail ? `：${detail}` : "，请确认本设备已开启离线推送"}` });
      }
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTestingShortcut(false);
    }
  }, [editingShortcut, testingShortcut]);

  /* 刷新键丝滑旋转：每次同步期间按 850ms 一圈递增角度，CSS 过渡负责缓动 */
  useEffect(() => {
    if (!syncing) return;
    setSpinTurns(t => t + 1);
    const id = window.setInterval(() => setSpinTurns(t => t + 1), 850);
    return () => window.clearInterval(id);
  }, [syncing]);

  /* 返回：按钮先渐隐再真正关闭 */
  const handleClose = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 200);
  }, [onClose]);

  /* 联动向导：打开时重置步骤；编辑已有联动可自由跳步 */
  const openRuleEditor = useCallback((rule: BridgeRule, existing: boolean) => {
    setEditing(rule);
    setWizStep(1);
    setWizMax(existing ? 6 : 1);
  }, []);

  const wizNext = useCallback(() => {
    if (!editing) return;
    if (wizStep === 3 && !editing.matchType.trim()) {
      onNotice?.("请先填写或点选一个信号名");
      return;
    }
    if (wizStep >= 6) {
      saveEditing();
      return;
    }
    const next = wizStep + 1;
    setWizStep(next);
    setWizMax(m => Math.max(m, next));
  }, [editing, wizStep, saveEditing, onNotice]);

  /* 快捷动作向导：打开时重置步骤；编辑已有动作可自由跳步 */
  const openShortcutEditor = useCallback((action: BridgeShortcutAction, existing: boolean) => {
    setEditingShortcut(action);
    setSwizStep(1);
    setSwizMax(existing ? 6 : 1);
    const rows = parseShortcutParamRows(action.parameterSchema);
    setParamRows(rows ?? []);
    setParamAdvanced(rows === null);
  }, []);

  const swizNext = useCallback(() => {
    if (!editingShortcut) return;
    if (swizStep === 2 && !editingShortcut.name.trim()) {
      onNotice?.("请先给这个动作起个名字");
      return;
    }
    if (swizStep === 5 && !editingShortcut.shortcutName.trim()) {
      onNotice?.("请填写快捷指令名称");
      return;
    }
    if (swizStep >= 6) {
      saveEditingShortcut();
      return;
    }
    const next = swizStep + 1;
    setSwizStep(next);
    setSwizMax(m => Math.max(m, next));
  }, [editingShortcut, swizStep, saveEditingShortcut, onNotice]);

  /* 数据项向导：打开时重置步骤与快照预览 */
  const openDataItemEditor = useCallback((item: BridgeDataItem, existing: boolean) => {
    setEditingItem(item);
    setDwizStep(1);
    setDwizMax(existing ? 4 : 1);
    setDataSnapshot(null);
  }, []);

  const dwizNext = useCallback(() => {
    if (!editingItem) return;
    if (dwizStep === 2 && (!editingItem.name.trim() || !sanitizeBridgeDataKey(editingItem.key))) {
      onNotice?.("请先填写名称和标识");
      return;
    }
    if (dwizStep >= 4) {
      saveEditingItem();
      return;
    }
    const next = dwizStep + 1;
    setDwizStep(next);
    setDwizMax(m => Math.max(m, next));
  }, [editingItem, dwizStep, saveEditingItem, onNotice]);

  /* 屏幕速聊向导：单例配置也沿用其他能力的「卡片 → 分步编辑」交互。 */
  const openScreenChatEditor = useCallback((existing: boolean) => {
    setEditingScreenChat({
      enabled: existing ? screenChat.enabled : true,
      characterId: screenChat.characterId || characters[0]?.id || "",
    });
    setScreenWizStep(1);
    setScreenWizMax(existing ? 4 : 1);
  }, [screenChat, characters]);

  const screenWizNext = useCallback(() => {
    if (!editingScreenChat) return;
    if (screenWizStep === 1 && !personalScreenChatReady) {
      onNotice?.(personalPushActive ? "请先重新部署最新版个人云" : "请先部署个人云");
      return;
    }
    if (screenWizStep === 2 && !editingScreenChat.characterId) {
      onNotice?.("请先选择一个角色");
      return;
    }
    if (screenWizStep >= 4) {
      setScreenChat(editingScreenChat);
      saveScreenChatSettings(editingScreenChat);
      setEditingScreenChat(null);
      onNotice?.("屏幕速聊已保存");
      return;
    }
    const next = screenWizStep + 1;
    setScreenWizStep(next);
    setScreenWizMax(max => Math.max(max, next));
  }, [editingScreenChat, screenWizStep, personalScreenChatReady, personalPushActive, onNotice]);

  /* 读取云端最新快照，验证上传链路是否打通 */
  const checkDataSnapshot = useCallback(async () => {
    if (!editingItem || dataSnapshotBusy) return;
    const key = sanitizeBridgeDataKey(editingItem.key);
    if (!key) {
      onNotice?.("请先在第②步填写标识");
      return;
    }
    setDataSnapshotBusy(true);
    try {
      const snapshot = await readBridgeStateSnapshot(config, key);
      setDataSnapshot(snapshot ?? "none");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setDataSnapshotBusy(false);
    }
  }, [editingItem, dataSnapshotBusy, config, onNotice]);

  /* 收到过的信号名去重，供向导第②步点选 */
  const feedSignals = useMemo(() => {
    const seen: string[] = [];
    for (const entry of feed) {
      const t = (entry.type || "").trim();
      if (t && !seen.includes(t)) seen.push(t);
      if (seen.length >= 8) break;
    }
    return seen;
  }, [feed]);

  const copy = useCallback((text: string, label: string) => {
    const done = () => {
      setCopiedText(text);
      window.setTimeout(() => setCopiedText(current => current === text ? "" : current), 1600);
      onNotice?.(label + "已复制");
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => done());
    } else done();
  }, [onNotice]);

  const isExistingRule = editing !== null && rules.some(rule => rule.id === editing.id);

  /* 联动向导第②步内联的快捷指令教程 */
  const shortcutSteps = (
    <>
      <div className="rb-substep">
        <i>1</i>
        <div className="rb-substep-body">
          <p><b>新建自动化</b>：打开系统「快捷指令」→「自动化」→ 新建，触发条件按需选择。</p>
          <div className="rb-kv"><span className="rb-eg">示例</span><span>收到包含“消费”的短信时</span></div>
        </div>
      </div>
      <div className="rb-substep">
        <i>2</i>
        <div className="rb-substep-body">
          <p><b>添加操作</b>：选择「获取 URL 内容」，URL 填写以下地址：</p>
          <div className="rb-code" onClick={() => copy(uploadUrl, "地址")}><code>{uploadUrl}</code><span className="rb-copy">复制</span></div>
          <p>粘贴后把地址里的 <b>[文件名]</b> 三个字删掉，在原位置插入「当前日期」变量，再轻点该变量把日期格式选「自定义」填 <button type="button" className="rb-copychip" onClick={() => copy("yyyyMMddHHmmss", "日期格式")}>yyyyMMddHHmmss</button>，变量后保留 .json——这样每条数据的文件名都不会重复。</p>
        </div>
      </div>
      <div className="rb-substep">
        <i>3</i>
        <div className="rb-substep-body">
          <p><b>配置请求</b>：展开地址下方的选项，方法选 <b>POST</b>，请求体选 <b>JSON</b>。</p>
          <p>「头部」新增一项：名称填 <button type="button" className="rb-copychip" onClick={() => copy("Authorization", "头部名称")}>Authorization</button>，值填下方密钥：</p>
          <div className="rb-code" onClick={() => copy(`Bearer ${config.key || ""}`, "密钥")}>
            <code>{config.key ? `Bearer ${config.key.slice(0, 12)}……${config.key.slice(-6)}` : "<请先完成第一步>"}</code>
            <span className="rb-copy">复制</span>
          </div>
          <p>再到「请求体」里新增两个「<b>文本</b>」类型字段：<b>type</b> 填信号名（例：duanxin）；<b>payload</b> 填要回传给小手机的正文（可插入「短信正文」等变量）。</p>
          <p className="rb-hint">{"payload 里可以写 {{user}}/{{char}} 宏，送达时会自动替换成对应名字。"}</p>
        </div>
      </div>
      <div className="rb-substep">
        <i>4</i>
        <div className="rb-substep-body">
          <p><b>完成</b>：关闭「运行前询问」并保存，然后<b>手动运行一次</b>发送测试数据。</p>
        </div>
      </div>
    </>
  );

  const isExistingShortcut = editingShortcut !== null && shortcutActions.some(item => item.id === editingShortcut.id);

  /* 快捷动作向导第⑤步：从参数 Schema 提取键名，生成个性化施工清单 */
  const shortcutParamKeys = (() => {
    if (!editingShortcut) return [] as string[];
    const schema = parseBridgeActionParameterSchema(editingShortcut.parameterSchema);
    const properties = schema?.properties;
    return properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.keys(properties as Record<string, unknown>)
      : [];
  })();

  /* 邮箱验证交互块：快捷动作向导第③步邮件 tab 使用 */
  const shortcutEmailVerifyBlock = shortcutEmailStatus && !shortcutEmailStatus.providerConfigured ? (
    <p className="rb-hint">服务端尚未配置 RESEND_API_KEY 与 REALITY_BRIDGE_EMAIL_FROM。</p>
  ) : shortcutEmailStatus?.verified ? (
    <div className="rb-email-verified">
      <span className="rb-email-verified-value">
        <small>已验证</small>
        <b>{shortcutEmailStatus.recipient}</b>
      </span>
      <button type="button" className="rb-btn ghost rb-email-unlink" disabled={shortcutEmailBusy !== null}
        onClick={() => void removeShortcutEmail()}>
        {shortcutEmailBusy === "remove" ? "解绑中…" : "解绑邮箱"}
      </button>
    </div>
  ) : (
    <>
      <div className="rb-email-form">
        <input type="email" value={shortcutEmailInput} placeholder="你的接收邮箱"
          aria-label="接收邮箱" autoComplete="email" inputMode="email"
          onChange={event => setShortcutEmailInput(event.target.value)} />
        <button type="button"
          className={`rb-btn ghost rb-email-submit${shortcutEmailBusy === "send" ? " is-busy" : shortcutEmailStatus?.verificationExpiresAt ? " is-sent" : ""}`}
          disabled={shortcutEmailBusy !== null || shortcutEmailStatus?.providerConfigured === false}
          onClick={() => void sendShortcutEmailCode()}>
          {shortcutEmailBusy === "send" ? "发送中…" : shortcutEmailStatus?.verificationExpiresAt ? "重新发送" : "发送验证码"}
        </button>
      </div>
      {shortcutEmailStatus?.verificationExpiresAt ? (
        <div className="rb-email-form">
          <input inputMode="numeric" maxLength={6} value={shortcutEmailCode} placeholder="六位验证码"
            aria-label="六位验证码" autoComplete="one-time-code"
            onChange={event => setShortcutEmailCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
          <button type="button"
            className={`rb-btn rb-email-submit${shortcutEmailBusy === "verify" ? " is-busy" : ""}`}
            disabled={shortcutEmailBusy !== null}
            onClick={() => void verifyShortcutEmailCode()}>
            {shortcutEmailBusy === "verify" ? "验证中…" : "确认验证"}
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="reality-bridge-app-shell">
      <div className="reality-bridge-app">
        <header className={`rb-header${closing ? " closing" : ""}`}>
          <button type="button" className="rb-back" onClick={handleClose} aria-label="返回桌面">{RB_ICON_CHEVRON}</button>
          {tab === "history" ? (
            <div className="rb-header-actions">
              {histSec === "feed" && feed.length > 0 ? (
                <button type="button" className="rb-iconbtn rb-trash" onClick={() => setConfirmClear(true)} aria-label="清空接收记录">{RB_ICON_TRASH}</button>
              ) : null}
              <button
                type="button"
                className="rb-iconbtn"
                onClick={() => void syncNow()}
                disabled={syncing || !ready}
                aria-label="刷新"
              ><span className="rb-refresh" style={{ transform: `rotate(${spinTurns * 360}deg)` }}>{RB_ICON_REFRESH}</span></button>
            </div>
          ) : (
            <button type="button" className="rb-iconbtn" onClick={() => setMenuOpen(true)} aria-label="桥接设置">{RB_ICON_DOTS}</button>
          )}
        </header>

        {tab === "history" ? (
          <div className="rb-chipbar rb-fixedbar">
            <div className="rb-chips">
              <button type="button" className={`rb-chip${histSec === "feed" ? " active" : ""}`} onClick={() => setHistSec("feed")}>最近收到</button>
              <button type="button" className={`rb-chip${histSec === "commands" ? " active" : ""}`} onClick={() => setHistSec("commands")}>最近快捷指令</button>
            </div>
          </div>
        ) : null}

        <div className="rb-body">
          {tab === "main" ? (
            <section>
              <div className="rb-hello">
                <h3>iOS现实桥</h3>
                <button
                  type="button"
                  className="rb-add"
                  disabled={mainSec === "screen" && Boolean(screenChat.characterId)}
                  aria-label={mainSec === "rules" ? "新建联动" : mainSec === "shortcuts" ? "新建快捷动作" : mainSec === "queries" ? "新建数据项" : screenChat.characterId ? "屏幕速聊已配置" : "配置屏幕速聊"}
                  onClick={() => {
                    if (mainSec === "rules") openRuleEditor(newRule(), false);
                    else if (mainSec === "shortcuts") openShortcutEditor(newShortcutAction(), false);
                    else if (mainSec === "queries") openDataItemEditor(newDataItem(), false);
                    else openScreenChatEditor(false);
                  }}
                >＋</button>
              </div>

              <div className="rb-tiles">
                <div className="rb-tile"><i>云端存储</i><b className={ready ? "ok" : "warn"}>{ready ? "已连接" : "未配置"}</b></div>
                <div className="rb-tile"><i>今日收到</i><b>{feed.filter(entry => isToday(entry.receivedAt)).length} 条</b></div>
                <div className="rb-tile"><i>联动启用</i><b>{rules.filter(rule => rule.enabled).length} / {rules.length}</b></div>
              </div>
              {!ready ? (
                <p className="rb-hint" style={{ padding: "8px 4px 0" }}>请前往「设置 → 数据管理 → 云端备份」填写 Supabase 配置；现实桥与云端备份共用同一存储空间。</p>
              ) : null}

            </section>
          ) : null}

          {tab === "history" ? (
            <section>
              {histSec === "feed" ? (
                <>
                  {feed.length === 0 ? (
                    <div className="rb-empty">
                      <b>还没有收到数据</b>
                      <p>在「设置」页新建联动，向导会带你完成快捷指令配置；运行一次后点右上角刷新。</p>
                      <button type="button" className="rb-btn" onClick={() => { setMainSec("rules"); setTab("main"); }}>去创建联动</button>
                    </div>
                  ) : feed.slice(0, 20).map(entry => (
                    <div key={entry.id + entry.receivedAt} className="rb-card rb-feed-item">
                      <div className="rb-feed-head">
                        <span className="rb-type">{entry.type}</span>
                        <span className="rb-time">{fmtTime(entry.receivedAt)}</span>
                      </div>
                      <p className="rb-payload">{(entry.processed || entry.payload).slice(0, 120)}</p>
                      <p className="rb-meta">{entry.actions.join("、")}{entry.error ? ` · 出了点问题：${entry.error}` : ""}</p>
                    </div>
                  ))}
                </>
              ) : (
                recentCommands.length === 0 ? (
                  <div className="rb-empty">
                    <b>还没有调用记录</b>
                    <p>角色调用快捷动作后，这里会显示每条命令的执行状态。</p>
                  </div>
                ) : (
                  recentCommands.map(command => (
                    <div className="rb-card rb-feed-item" key={command.id}>
                      <div className="rb-feed-head">
                        <span className="rb-type">{command.deliveryMode === "email" ? "邮件" : "推送"}</span>
                        <span className="rb-time">{fmtTime(command.createdAt)}</span>
                      </div>
                      <p className="rb-payload rb-cmd-name">
                        {command.actionName}
                        <span className={`rb-cmd-mark ${command.status}`} title={shortcutStatusLabel(command.status)} aria-label={shortcutStatusLabel(command.status)}>
                          {command.status === "succeeded" ? RB_ICON_CHECK
                            : command.status === "failed" || command.status === "expired" || command.status === "cancelled" ? RB_ICON_CROSS
                            : RB_ICON_CLOCK}
                        </span>
                      </p>
                    </div>
                  ))
                )
              )}
            </section>
          ) : null}

          {tab === "main" ? (
            <section>
              <>
                  <div className="rb-chipbar">
                    <div className="rb-chips">
                      <button type="button" className={`rb-chip${mainSec === "rules" ? " active" : ""}`} onClick={() => setMainSec("rules")}>自动联动</button>
                      <button type="button" className={`rb-chip${mainSec === "shortcuts" ? " active" : ""}`} onClick={() => setMainSec("shortcuts")}>快捷动作</button>
                      <button type="button" className={`rb-chip${mainSec === "queries" ? " active" : ""}`} onClick={() => setMainSec("queries")}>主动查询</button>
                      <button type="button" className={`rb-chip${mainSec === "screen" ? " active" : ""}`} onClick={() => setMainSec("screen")}>屏幕速聊</button>
                    </div>
                  </div>
                  {mainSec === "rules" ? (rules.length === 0 ? (
                    <div className="rb-empty">
                      <b>还没有联动</b>
                      <p>联动会在收到指定信号时自动执行动作，例如收到银行短信时告知角色并等待回复。</p>
                      <button type="button" className="rb-btn" onClick={() => openRuleEditor(newRule(), false)}>新建联动</button>
                    </div>
                  ) : (
                    <div className="rb-grid">
                      {rules.map(rule => {
                        const lastRun = getBridgeRuleLastRunAt(rule.id);
                        const fired = rule.enabled && lastRun > 0 && Date.now() - lastRun < 10 * 60_000;
                        return (
                          <div
                            key={rule.id}
                            className={`rb-rcard${rule.enabled ? "" : " off"}`}
                            onClick={() => openRuleEditor({ ...rule, process: { ...rule.process }, actions: { ...rule.actions } }, true)}
                          >
                            <div className="rb-rtop">
                              <span className="rb-icchip">{ruleIcon(rule)}</span>
                              {fired ? <span className="rb-fired-tag">{fmtHM(lastRun)} 已触发</span> : null}
                            </div>
                            <b>{rule.name || `当收到「${rule.matchType}」`}</b>
                            <p className="rb-rsum">{summarize(rule)}</p>
                            <div className="rb-rfoot">
                              <span className="rb-rstate">{rule.enabled ? "开启" : "已停用"}</span>
                              <button
                                type="button"
                                className={`rb-switch small ${rule.enabled ? "on" : ""}`}
                                onClick={event => {
                                  event.stopPropagation();
                                  persistRules(rules.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r));
                                }}
                                aria-label="启用联动"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )) : null}

                  {mainSec === "shortcuts" ? (shortcutActions.length === 0 ? (
                    <div className="rb-empty">
                      <b>还没有快捷动作</b>
                      <p>把角色工具绑定到你已有的 iOS 快捷指令。角色调用时会发系统通知，轻点后运行。</p>
                      <button type="button" className="rb-btn" onClick={() => openShortcutEditor(newShortcutAction(), false)}>新建快捷动作</button>
                    </div>
                  ) : (
                    <div className="rb-grid">
                      {shortcutActions.map(action => (
                        <div key={action.id} className={`rb-rcard${action.enabled ? "" : " off"}`}
                          onClick={() => openShortcutEditor({ ...action }, true)}>
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_PHONE}</span>
                            <span className="rb-type">{action.deliveryMode === "email" ? "邮件自动" : "通知点击"}</span>
                          </div>
                          <b>{action.name}</b>
                          <p className="rb-rsum">{action.shortcutName} · {action.description}</p>
                          <div className="rb-rfoot">
                            <span className="rb-rstate">{action.resultMode === "none" ? "不等待结果" : action.resultMode === "image" ? "回传图片" : "回传文本"}</span>
                            <button
                              type="button"
                              className={`rb-switch small ${action.enabled ? "on" : ""}`}
                              onClick={event => {
                                event.stopPropagation();
                                persistShortcutActions(shortcutActions.map(item => item.id === action.id ? { ...item, enabled: !item.enabled } : item));
                              }}
                              aria-label="启用快捷动作"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )) : null}

                  {mainSec === "queries" ? (dataItems.length === 0 ? (
                    <div className="rb-empty">
                      <b>还没有数据项</b>
                      <p>定义数据项后，角色即可查询手机的实时状态，需配合快捷指令定期上传，配置方法见教程。</p>
                      <button type="button" className="rb-btn" onClick={() => openDataItemEditor(newDataItem(), false)}>新建数据项</button>
                    </div>
                  ) : (
                    <>
                      <div className="rb-grid">
                        {dataItems.map(item => (
                          <div key={item.id} className="rb-rcard" onClick={() => openDataItemEditor({ ...item }, true)}>
                            <div className="rb-rtop">
                              <span className="rb-type">{item.key}</span>
                            </div>
                            <b>{item.name}</b>
                            <p className="rb-rsum">{item.description || "（未填写说明）"}</p>
                            <div className="rb-rfoot">
                              <button type="button" className="rb-link" onClick={event => { event.stopPropagation(); copy(stateUrl(item.key), "上传地址"); }}>复制上传地址</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )) : null}

                  {mainSec === "screen" ? (
                    screenChat.characterId ? (
                      <div className="rb-grid">
                        <div className={`rb-rcard${screenChat.enabled ? "" : " off"}`} onClick={() => openScreenChatEditor(true)}>
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_CHAT}</span>
                            <span className="rb-type">{personalScreenChatReady ? "个人云已连接" : "需要更新个人云"}</span>
                          </div>
                          <b>屏幕速聊</b>
                          <p className="rb-rsum">双击悬浮球，把当前屏幕交给 {charName(screenChat.characterId)}，并在系统弹窗里连续聊天。</p>
                          <div className="rb-rfoot">
                            <span className="rb-rstate">{screenChat.enabled ? "开启" : "已停用"}</span>
                            <button
                              type="button"
                              className={`rb-switch small ${screenChat.enabled ? "on" : ""}`}
                              onClick={event => {
                                event.stopPropagation();
                                if (!screenChat.enabled && !personalScreenChatReady) {
                                  onNotice?.(personalPushActive ? "请先重新部署最新版个人云" : "请先部署个人云");
                                  return;
                                }
                                updateScreenChat({ enabled: !screenChat.enabled });
                              }}
                              aria-label={screenChat.enabled ? "停用屏幕速聊" : "启用屏幕速聊"}
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rb-empty">
                        <b>还没有配置屏幕速聊</b>
                        <p>双击 iPhone 悬浮球，把当前屏幕发给角色，并直接在系统弹窗里连续聊天。</p>
                        <button type="button" className="rb-btn" onClick={() => openScreenChatEditor(false)}>开始配置</button>
                      </div>
                    )
                  ) : null}
              </>
            </section>
          ) : null}

        </div>

        {confirmClear ? (
          <div className="rb-modal-mask rb-menu-mask" onClick={() => setConfirmClear(false)}>
            <div className="rb-modal rb-glass-modal" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">清空接收记录？</b>
              <p className="rb-help">只删除本地流水列表；已执行的动作（写入的消息、记忆、日历）不受影响。</p>
              <div className="rb-editor-btns">
                <button type="button" className="rb-btn ghost" onClick={() => setConfirmClear(false)}>取消</button>
                <button type="button" className="rb-btn ghost danger" onClick={() => {
                  clearBridgeFeed();
                  setFeed([]);
                  setConfirmClear(false);
                  onNotice?.("接收记录已清空");
                }}>清空</button>
              </div>
            </div>
          </div>
        ) : null}

        {menuOpen ? (
          <div className="rb-modal-mask rb-menu-mask" onClick={() => setMenuOpen(false)}>
            <div className="rb-modal rb-glass-modal" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">桥接设置</b>
              <div className="rb-main-row">
                <span className="rb-icchip">{RB_ICON_PHONE}</span>
                <div className="rb-main-text">
                  <b>接收快捷指令消息</b>
                  <p>{ready ? "应用打开或后台保活期间自动接收" : "请先配置云端存储（设置 → 数据管理 → 云端备份）"}</p>
                </div>
                <button
                  type="button"
                  className={`rb-switch ${settings.enabled ? "on" : ""}`}
                  onClick={() => updateSettings({ enabled: !settings.enabled })}
                  aria-label="接收快捷指令消息"
                />
              </div>
              {settings.enabled ? (
                <div className="rb-freq">
                  {FREQ_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      className={settings.pollSeconds === opt.value ? "sel" : ""}
                      onClick={() => updateSettings({ pollSeconds: opt.value })}
                    >{opt.label}</button>
                  ))}
                </div>
              ) : null}
              <div className="rb-main-row">
                <span className="rb-icchip">{RB_ICON_BROADCAST}</span>
                <div className="rb-main-text">
                  <b>允许自定义APP订阅</b>
                  <p>每条收到的数据都转发给订阅了 bridge.data 的自定义APP</p>
                </div>
                <button
                  type="button"
                  className={`rb-switch ${settings.broadcastToApps ? "on" : ""}`}
                  onClick={() => updateSettings({ broadcastToApps: !settings.broadcastToApps })}
                  aria-label="允许自定义APP订阅"
                />
              </div>
            </div>
          </div>
        ) : null}

        {editing ? (
          <div className="rb-modal-mask" onClick={() => setEditing(null)}>
          <div className="rb-modal rb-editor" onClick={event => event.stopPropagation()}>
            <b className="rb-modal-title">{isExistingRule ? "编辑联动" : "新建联动"}</b>

            <div className="rb-wiz-steps">
              {[1, 2, 3, 4, 5, 6].map(n => (
                <Fragment key={n}>
                  {n > 1 ? <i className={`rb-wiz-line${n <= wizMax ? " done" : ""}`} /> : null}
                  <button
                    type="button"
                    className={`rb-wiz-dot${n === wizStep ? " cur" : n < wizStep ? " done" : ""}`}
                    disabled={!isExistingRule && n > wizMax}
                    onClick={() => setWizStep(n)}
                    aria-label={`第${n}步 ${WIZ_STEP_NAMES[n - 1]}`}
                  >{n < wizStep ? "✓" : n}</button>
                </Fragment>
              ))}
            </div>
            <p className="rb-wiz-label">{WIZ_STEP_NAMES[wizStep - 1]}</p>

            {wizStep === 1 ? (
              <div className="rb-wiz-page">
                <p className="rb-wiz-intro">联动的作用：当 iPhone 发来某个信号时，自动执行你安排好的动作。开始前先确认数据管道已接通。</p>
                {ready ? (
                  <div className="rb-wiz-ok">✓ 云端存储已连接，这一步自动完成</div>
                ) : (
                  <>
                    <div className="rb-wiz-warn">尚未配置云端存储</div>
                    <p className="rb-help">前往「设置 → 数据管理 → 云端备份」填写 Supabase 项目地址与密钥。现实桥与云端备份共用同一个存储空间，无需重复配置。</p>
                  </>
                )}
                <p className="rb-hint">iPhone 那头还需要一个负责上传数据的快捷指令；如果还没创建，下一步会给你指引。</p>
              </div>
            ) : null}

            {wizStep === 2 ? (
              <div className="rb-wiz-page">
                {feedSignals.length > 0 ? (
                  <>
                    <div className="rb-wiz-ok">✓ 已收到过信号，说明快捷指令在正常工作，可直接下一步</div>
                    <details className="rb-more">
                      <summary>需要再建一条快捷指令？展开教程</summary>
                      <div className="rb-more-body">{shortcutSteps}</div>
                    </details>
                  </>
                ) : (
                  <>
                    <p className="rb-wiz-tip">在 iPhone 的「快捷指令」里创建一个上传数据的自动化：</p>
                    {shortcutSteps}
                    <p className="rb-hint">创建好后手动运行一次发送测试数据，下一步就能直接点选它的信号名。</p>
                  </>
                )}
                <details className="rb-more">
                  <summary>可选：离线增强（小手机关着也能触发）</summary>
                  <div className="rb-more-body">
                    <p className="rb-hint">在这条自动化的「获取 URL 内容」（上传数据）之后，<b>再添加一个「获取 URL 内容」</b>，以 GET 方法请求以下地址（无需任何头部与请求体）。加上后，小手机完全关闭时，带「让TA回话」的联动会由服务端代为执行、回复通过系统通知推送；小手机在线时服务端自动让位，没有任何副作用。</p>
                    {wakeUrl ? (
                      <div className="rb-code" onClick={() => copy(wakeUrl, "唤醒地址")}><code>{wakeUrl}</code><span className="rb-copy">复制</span></div>
                    ) : (
                      <p className="rb-hint">（登录账号后这里会生成你的专属唤醒地址）</p>
                    )}
                    <p className="rb-hint">前提：聊天设置已开启「离线推送」。唤醒地址含你的专属令牌，请勿分享。</p>
                  </div>
                </details>
              </div>
            ) : null}

            {wizStep === 3 ? (
            <div className="rb-wiz-page">
            {feedSignals.length > 0 ? (
              <>
                <p className="rb-wiz-tip">从最近收到过的信号里点选，保证和快捷指令那头一致：</p>
                <div className="rb-signal-chips">
                  {feedSignals.map(signal => (
                    <button
                      key={signal}
                      type="button"
                      className={`rb-signal-chip${editing.matchType === signal ? " sel" : ""}`}
                      onClick={() => setEditing({ ...editing, matchType: signal })}
                    >{signal}</button>
                  ))}
                </div>
              </>
            ) : (
              <p className="rb-help">还没收到过信号。回上一步照教程创建快捷指令，并在 iPhone 上手动运行一次。</p>
            )}
            <button type="button" className="rb-btn ghost" disabled={syncing || !ready} onClick={() => void syncNow()}>
              {syncing ? "正在刷新…" : "刚发了测试数据？点此刷新"}
            </button>
            <label>信号名
              <input value={editing.matchType} maxLength={60} placeholder="例如 duanxin（要和快捷指令里填的一致）"
                onChange={event => setEditing({ ...editing, matchType: event.target.value })} />
            </label>
            <p className="rb-hint">信号名是你给这类消息起的名字。填 * 表示什么消息都算。</p>
            <label>触发间隔
              <select
                value={editing.cooldownMinutes ?? 0}
                onChange={event => setEditing({ ...editing, cooldownMinutes: Number(event.target.value) || 0 })}
              >
                <option value={0}>不限制，每次都触发</option>
                <option value={5}>5 分钟内只触发一次</option>
                <option value={15}>15 分钟内只触发一次</option>
                <option value={30}>30 分钟内只触发一次</option>
                <option value={60}>1 小时内只触发一次</option>
                <option value={180}>3 小时内只触发一次</option>
                <option value={720}>12 小时内只触发一次</option>
                <option value={1440}>24 小时内只触发一次</option>
              </select>
            </label>
            <p className="rb-hint">短时间反复收到同一信号（比如一小时内多次打开某个 APP）时，间隔内的重复消息只存档，不再打扰角色。</p>
            </div>
            ) : null}

            {wizStep === 4 ? (
            <div className="rb-wiz-page">
            <p className="rb-wiz-tip">收到的原始内容（比如整条短信）交给角色前，可以先加工一下：</p>
            <div className="rb-seg">
              {([["raw", "原样使用"], ["template", "套个句式"], ["ai", "AI 先处理"]] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={editing.process.mode === mode ? "sel" : ""}
                  onClick={() => setEditing({ ...editing, process: { ...editing.process, mode } })}
                >{label}</button>
              ))}
            </div>
            {editing.process.mode === "template" ? (
              <label>句式（{"{payload}"} 代表收到的内容）
                <input value={editing.process.template ?? ""} placeholder="例：我今天走了 {payload} 步"
                  onChange={event => setEditing({ ...editing, process: { ...editing.process, template: event.target.value } })} />
              </label>
            ) : null}
            {editing.process.mode === "ai" ? (
              <label>告诉 AI 怎么处理
                <textarea value={editing.process.prompt ?? ""} rows={2} placeholder="例：把这条银行短信浓缩成「花了多少钱、在哪花的」一句话"
                  onChange={event => setEditing({ ...editing, process: { ...editing.process, prompt: event.target.value } })} />
              </label>
            ) : null}
            </div>
            ) : null}

            {wizStep === 5 ? (
            <div className="rb-wiz-page">
            <p className="rb-wiz-tip">收到信号后要做的事，可多选：</p>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.chat}
                  onChange={event => setEditing({
                    ...editing,
                    actions: {
                      ...editing.actions,
                      chat: event.target.checked
                        ? { characterId: characters[0]?.id ?? "", role: "user", requestReply: true }
                        : undefined,
                    },
                  })} />
                告诉一个角色
              </label>
              {editing.actions.chat ? (
                <div className="rb-action-body grid2">
                  <select value={editing.actions.chat.characterId}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, chat: { ...editing.actions.chat!, characterId: event.target.value } } })}>
                    {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {(editing.actions.chat.historyRole || editing.actions.chat.role) !== "assistant" ? (
                    <label className="rb-check small">
                      <input type="checkbox" checked={editing.actions.chat.requestReply}
                        onChange={event => setEditing({ ...editing, actions: { ...editing.actions, chat: { ...editing.actions.chat!, requestReply: event.target.checked } } })} />
                      让TA回话
                    </label>
                  ) : <span aria-hidden="true" />}
                  <select value={editing.actions.chat.role}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, chat: { ...editing.actions.chat!, role: event.target.value as "user" | "assistant" | "system" } } })}>
                    <option value="user">显示为我说的</option>
                    <option value="assistant">显示为TA说的</option>
                    <option value="system">显示为旁白小字</option>
                  </select>
                  <select value={editing.actions.chat.historyRole ?? ""}
                    onChange={event => setEditing({
                      ...editing,
                      actions: {
                        ...editing.actions,
                        chat: {
                          ...editing.actions.chat!,
                          historyRole: (event.target.value || undefined) as "user" | "assistant" | "system" | undefined,
                        },
                      },
                    })}>
                    <option value="">TA记成：跟显示一致</option>
                    <option value="user">TA记成：我说的话</option>
                    <option value="assistant">TA记成：自己说的话</option>
                    <option value="system">TA记成：发生的事件</option>
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.memory}
                  onChange={event => setEditing({
                    ...editing,
                    actions: { ...editing.actions, memory: event.target.checked ? { characterId: characters[0]?.id ?? "", type: "long_term" } : undefined },
                  })} />
                让角色记住这件事
              </label>
              {editing.actions.memory ? (
                <div className="rb-action-body grid2">
                  <select value={editing.actions.memory.characterId}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, memory: { ...editing.actions.memory!, characterId: event.target.value } } })}>
                    {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select value={editing.actions.memory.type}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, memory: { ...editing.actions.memory!, type: event.target.value as "long_term" | "core" } } })}>
                    <option value="long_term">普通记忆</option>
                    <option value="core">重要记忆</option>
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.timeline}
                  onChange={event => setEditing({
                    ...editing,
                    actions: { ...editing.actions, timeline: event.target.checked ? { characterId: characters[0]?.id ?? "" } : undefined },
                  })} />
                记入和角色的短期记忆
              </label>
              {editing.actions.timeline ? (
                <div className="rb-action-body grid2">
                  <select value={editing.actions.timeline.characterId}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, timeline: { characterId: event.target.value } } })}>
                    {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.card}
                  onChange={event => setEditing({
                    ...editing,
                    actions: { ...editing.actions, card: event.target.checked ? { characterId: characters[0]?.id ?? "" } : undefined },
                  })} />
                做成卡片发到聊天里
              </label>
              {editing.actions.card ? (
                <div className="rb-action-body">
                  <select value={editing.actions.card.characterId}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, card: { characterId: event.target.value } } })}>
                    {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.calendar}
                  onChange={event => setEditing({
                    ...editing,
                    actions: { ...editing.actions, calendar: event.target.checked ? { direction: "future" as const, durationMinutes: 60 } : undefined },
                  })} />
                记到今天的日历上
              </label>
              {editing.actions.calendar ? (
                <div className="rb-action-body grid2">
                  <select
                    value={editing.actions.calendar.direction ?? "future"}
                    onChange={event => setEditing({
                      ...editing,
                      actions: { ...editing.actions, calendar: { ...editing.actions.calendar!, direction: event.target.value === "past" ? "past" : "future", durationMinutes: editing.actions.calendar!.durationMinutes ?? 60 } },
                    })}
                  >
                    <option value="past">记录刚过去的</option>
                    <option value="future">记录接下来的</option>
                  </select>
                  <select
                    value={editing.actions.calendar.durationMinutes ?? 60}
                    onChange={event => setEditing({
                      ...editing,
                      actions: { ...editing.actions, calendar: { ...editing.actions.calendar!, direction: editing.actions.calendar!.direction ?? "future", durationMinutes: Number(event.target.value) || 60 } },
                    })}
                  >
                    <option value={15}>15 分钟</option>
                    <option value={30}>30 分钟</option>
                    <option value={60}>1 小时</option>
                    <option value={90}>1.5 小时</option>
                    <option value={120}>2 小时</option>
                    <option value={180}>3 小时</option>
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.shortcut}
                  onChange={event => setEditing({
                    ...editing,
                    actions: {
                      ...editing.actions,
                      shortcut: event.target.checked
                        ? { actionId: shortcutActions.find(item => item.enabled && item.deliveryMode !== "email")?.id ?? "" }
                        : undefined,
                    },
                  })} />
                执行一个快捷动作
              </label>
              {editing.actions.shortcut ? (
                <div className="rb-action-body">
                  {shortcutActions.some(item => item.enabled && item.deliveryMode !== "email") ? (
                    <>
                      <select value={editing.actions.shortcut.actionId}
                        onChange={event => setEditing({ ...editing, actions: { ...editing.actions, shortcut: { actionId: event.target.value } } })}>
                        {shortcutActions.filter(item => item.enabled && item.deliveryMode !== "email").map(item => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                      <p className="rb-help">命中时发出该快捷动作的运行通知，点通知即执行；App 被杀时由个人云代发。</p>
                    </>
                  ) : (
                    <p className="rb-help">还没有可用的推送类快捷动作——先到「快捷动作」页创建一个。</p>
                  )}
                </div>
              ) : null}
            </div>

            </div>
            ) : null}

            {wizStep === 6 ? (
              <div className="rb-wiz-page">
                <div className="rb-wiz-summary">
                  <b>{editing.name.trim() || `当收到「${editing.matchType.trim() || "……"}」`}</b>
                  <p>{summarize(editing)}</p>
                </div>
                <p className="rb-help">保存后，在 iPhone 上运行一次对应的快捷指令，再到「历史」页点右上角刷新；看到这条数据出现，说明联动已经生效。</p>
                {isExistingRule ? (
                  <button
                    type="button"
                    className="rb-del-link"
                    onClick={() => {
                      persistRules(rules.filter(rule => rule.id !== editing.id));
                      setEditing(null);
                      onNotice?.("联动已删除");
                    }}
                  >删除这条联动</button>
                ) : null}
              </div>
            ) : null}

            <div className="rb-wiz-nav">
              {wizStep > 1 ? (
                <button type="button" className="rb-wiz-back" onClick={() => setWizStep(wizStep - 1)} aria-label="上一步">{RB_ICON_CHEVRON}</button>
              ) : null}
              <button
                type="button"
                className={`rb-wiz-next${wizStep === 3 && !editing.matchType.trim() ? " dim" : ""}`}
                onClick={wizNext}
                aria-label={wizStep === 6 ? "保存联动" : "下一步"}
              >{wizStep === 6 ? RB_ICON_CHECK : RB_ICON_ARROW}</button>
            </div>
          </div>
          </div>
        ) : null}

        {editingShortcut ? (
          <div className="rb-modal-mask" onClick={() => setEditingShortcut(null)}>
            <div className="rb-modal rb-editor" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">{isExistingShortcut ? "编辑快捷动作" : "新建快捷动作"}</b>

              <div className="rb-wiz-steps">
                {[1, 2, 3, 4, 5, 6].map(n => (
                  <Fragment key={n}>
                    {n > 1 ? <i className={`rb-wiz-line${n <= swizMax ? " done" : ""}`} /> : null}
                    <button
                      type="button"
                      className={`rb-wiz-dot${n === swizStep ? " cur" : n < swizStep ? " done" : ""}`}
                      disabled={!isExistingShortcut && n > swizMax}
                      onClick={() => setSwizStep(n)}
                      aria-label={`第${n}步 ${SWIZ_STEP_NAMES[n - 1]}`}
                    >{n < swizStep ? "✓" : n}</button>
                  </Fragment>
                ))}
              </div>
              <p className="rb-wiz-label">{SWIZ_STEP_NAMES[swizStep - 1]}</p>

              {swizStep === 1 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-intro">快捷动作是角色的「手」：角色调用工具后，你的 iPhone 弹出系统通知，轻点即运行对应的快捷指令，还可以把结果回传给角色。</p>
                  {ready ? (
                    <div className="rb-wiz-ok">✓ 云端存储已连接，这一步自动完成</div>
                  ) : (
                    <>
                      <div className="rb-wiz-warn">尚未配置云端存储</div>
                      <p className="rb-help">前往「设置 → 数据管理 → 云端备份」填写 Supabase 项目地址与密钥。</p>
                    </>
                  )}
                </div>
              ) : null}

              {swizStep === 2 ? (
                <div className="rb-wiz-page">
                  <label>工具名称（角色看到的动作名）
                    <input value={editingShortcut.name} maxLength={30} placeholder="例如：打开微信并截图"
                      onChange={event => {
                        const value = event.target.value;
                        const follows = !editingShortcut.shortcutName.trim() || editingShortcut.shortcutName === editingShortcut.name;
                        setEditingShortcut({ ...editingShortcut, name: value, shortcutName: follows ? value : editingShortcut.shortcutName });
                      }} />
                  </label>
                  <label>用途说明（告诉角色何时调用）
                    <textarea value={editingShortcut.description} rows={3} maxLength={300}
                      placeholder="例如：用户允许时打开微信，等待指定秒数后截图，并把图片回传"
                      onChange={event => setEditingShortcut({ ...editingShortcut, description: event.target.value })} />
                  </label>
                  <p className="rb-hint">用途说明会进入角色的工具列表，是角色判断「什么时候该用它」的唯一依据，写得越具体越好。</p>
                </div>
              ) : null}

              {swizStep === 3 ? (
                <div className="rb-wiz-page">
                  <div className="rb-seg">
                    <button type="button" className={editingShortcut.deliveryMode === "push" ? "sel" : ""}
                      onClick={() => setEditingShortcut({ ...editingShortcut, deliveryMode: "push" })}>系统通知</button>
                    <button type="button" className={editingShortcut.deliveryMode === "email" ? "sel" : ""}
                      onClick={() => setEditingShortcut({ ...editingShortcut, deliveryMode: "email" })}>邮件自动（实验）</button>
                  </div>
                  {editingShortcut.deliveryMode === "push" ? (
                    <>
                      <p className="rb-help">角色调用后，你的 iPhone 弹出系统通知，轻点通知即运行对应的快捷指令。</p>
                      <p className="rb-hint">前提：小手机已添加到 iPhone 主屏幕，并在聊天设置中开启「离线推送」。</p>
                    </>
                  ) : (
                    <>
                      <p className="rb-help">收到触发邮件时由 iOS 自动化「立即运行」，全程无需点按。实验功能：首次运行可能仍要求权限，锁屏下部分动作可能受 iOS 限制。</p>
                      <p className="rb-hint">邮件只是动作的触发通道：角色说的话仍走离线推送送达，所以离线推送要保持开启，否则 App 关着时这条动作也不会被触发。</p>
                      <p className="rb-wiz-tip">验证 iPhone「邮件」App 里能即时收信的邮箱（仅 iCloud / Exchange 支持实时推送）：</p>
                      {shortcutEmailVerifyBlock}
                      <p className="rb-hint">还要把发件人 <button type="button" className="rb-copychip" onClick={() => copy(shortcutEmailStatus?.senderAddress || "bridge@notify.floatbubble.top", "发件人地址")}>{shortcutEmailStatus?.senderAddress || "bridge@notify.floatbubble.top"}</button> 加入邮箱白名单，防止触发邮件进垃圾箱、自动化收不到。</p>
                      <details className="rb-more">
                        <summary>邮箱怎么开通 / 白名单怎么设</summary>
                        <div className="rb-more-body">
                          <p className="rb-hint"><b>iCloud 邮箱（推荐）</b>：设置 → 顶部你的名字 → iCloud → 打开“iCloud 邮件”，按提示创建 @icloud.com 地址（创建一次永久使用）。国区 Apple ID 同样支持，只是默认没开通。</p>
                          <p className="rb-hint"><b>QQ 邮箱（Exchange 方式）</b>：先在 QQ 邮箱 App/网页「设置 → 账户」开启服务并生成<b>授权码</b>；再到 iPhone「设置 → 邮件 → 账户 → 添加账户 → Microsoft Exchange」，邮箱填 QQ 邮箱地址，密码填<b>授权码</b>（不是 QQ 密码），服务器填 ex.qq.com。用“其他(IMAP)”方式添加的邮箱最长 15 分钟才收一次信，会慢到超时。</p>
                          <p className="rb-hint"><b>白名单</b>：QQ 邮箱在「设置 → 反垃圾 → 设置邮件地址白名单」添加发件人；iCloud 把发件人存入“通讯录”，或在“垃圾邮件”文件夹里把误判的信标记为“非垃圾邮件”。</p>
                        </div>
                      </details>
                    </>
                  )}
                </div>
              ) : null}

              {swizStep === 4 ? (
                <div className="rb-wiz-page">
                  <fieldset className="rb-fieldset">
                    <legend>需要角色输出的快捷指令运行参数（文本/数字）</legend>
                    <p className="rb-hint">例如：让角色输出要发送到你真实手机备忘录的文字——参数名：memo，类型：文本，参数描述：要写入备忘录的内容。不需要参数就保持为空。</p>
                    {paramAdvanced ? (
                      <>
                        <textarea className="rb-schema-input" value={editingShortcut.parameterSchema} rows={7} maxLength={8000}
                          aria-label="参数 JSON Schema"
                          onChange={event => setEditingShortcut({ ...editingShortcut, parameterSchema: event.target.value })} />
                        <p className="rb-hint">高级模式：直接编辑 JSON Schema。
                          <button type="button" className="rb-link" onClick={() => {
                            const rows = parseShortcutParamRows(editingShortcut.parameterSchema);
                            if (rows === null) { onNotice?.("当前 JSON 结构较复杂，无法转为简易清单"); return; }
                            setParamRows(rows);
                            setParamAdvanced(false);
                          }}>返回简易模式</button>
                        </p>
                      </>
                    ) : (
                      <>
                        {paramRows.map((row, index) => (
                          <div className="rb-param-row" key={index}>
                            <input className="rb-param-key" value={row.key} maxLength={40} placeholder="参数名（英文）"
                              onChange={event => {
                                const value = event.target.value.replace(/[^a-zA-Z0-9_]/g, "");
                                const rows = paramRows.map((r, i) => i === index ? { ...r, key: value } : r);
                                setParamRows(rows);
                                setEditingShortcut({ ...editingShortcut, parameterSchema: buildShortcutParamSchema(rows) });
                              }} />
                            <select value={row.type}
                              onChange={event => {
                                const value = (event.target.value === "number" ? "number" : "string") as ShortcutParamRow["type"];
                                const rows = paramRows.map((r, i) => i === index ? { ...r, type: value } : r);
                                setParamRows(rows);
                                setEditingShortcut({ ...editingShortcut, parameterSchema: buildShortcutParamSchema(rows) });
                              }}>
                              <option value="string">文本</option>
                              <option value="number">数字</option>
                            </select>
                            <input className="rb-param-desc" value={row.description} maxLength={120} placeholder="参数描述"
                              onChange={event => {
                                const rows = paramRows.map((r, i) => i === index ? { ...r, description: event.target.value } : r);
                                setParamRows(rows);
                                setEditingShortcut({ ...editingShortcut, parameterSchema: buildShortcutParamSchema(rows) });
                              }} />
                            <button type="button" className="rb-param-remove" aria-label="删除参数"
                              onClick={() => {
                                const rows = paramRows.filter((_, i) => i !== index);
                                setParamRows(rows);
                                setEditingShortcut({ ...editingShortcut, parameterSchema: buildShortcutParamSchema(rows) });
                              }}>−</button>
                          </div>
                        ))}
                        <button type="button" className="rb-btn rb-param-add" onClick={() => {
                          const rows = [...paramRows, { key: "", type: "string" as const, description: "" }];
                          setParamRows(rows);
                        }}>＋ 添加参数</button>
                        <p className="rb-hint">参数会自动生成 JSON 定义，运行时作为「快捷指令输入」传入。
                          <button type="button" className="rb-link" onClick={() => setParamAdvanced(true)}>高级：编辑 JSON</button>
                        </p>
                      </>
                    )}
                  </fieldset>
                  <label>执行结果
                    <select value={editingShortcut.resultMode}
                      onChange={event => setEditingShortcut({ ...editingShortcut, resultMode: event.target.value as BridgeShortcutAction["resultMode"] })}>
                      <option value="none">发出后立即返回，不等待结果</option>
                      <option value="text">等待快捷指令回传文本</option>
                      <option value="image">等待快捷指令上传图片（可附文字）</option>
                    </select>
                  </label>
                  {editingShortcut.resultMode !== "none" ? (
                    <label>等待回传时长
                      <select value={editingShortcut.expiresInSeconds}
                        onChange={event => setEditingShortcut({ ...editingShortcut, expiresInSeconds: Number(event.target.value) })}>
                        <option value={30}>30 秒</option>
                        <option value={60}>1 分钟</option>
                        <option value={120}>2 分钟</option>
                        <option value={300}>5 分钟</option>
                        <option value={600}>10 分钟（邮件模式推荐）</option>
                        <option value={900}>15 分钟</option>
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}

              {swizStep === 5 ? (() => {
                const hasParams = shortcutParamKeys.length > 0;
                const wantsResult = editingShortcut.resultMode !== "none";
                const isEmailMode = editingShortcut.deliveryMode === "email";
                const resultNo = 2 + (hasParams ? 1 : 0);
                const emailNo = resultNo + (wantsResult ? 1 : 0);
                const lastNo = emailNo + (isEmailMode ? 1 : 0);
                return (
                  <div className="rb-wiz-page">
                    <p className="rb-wiz-tip">按这份清单在 iPhone「快捷指令」App 里创建（内容根据你前几步的选择生成）：</p>
                    <label>快捷指令名称（默认与工具名一致，可改）
                      <input value={editingShortcut.shortcutName} maxLength={80} placeholder="必须和“快捷指令”App 中的名称完全一致"
                        onChange={event => setEditingShortcut({ ...editingShortcut, shortcutName: event.target.value })} />
                    </label>
                    <div className="rb-substep">
                      <i>1</i>
                      <div className="rb-substep-body">
                        <p><b>新建并命名</b>：在「快捷指令」标签页新建一条（注意不是自动化），名字设为 {editingShortcut.shortcutName.trim() ? (
                          <button type="button" className="rb-copychip" onClick={() => copy(editingShortcut.shortcutName.trim(), "快捷指令名称")}>{editingShortcut.shortcutName.trim()}</button>
                        ) : <b>（先填上方名称）</b>}（必须一字不差），然后搭好要执行的动作。</p>
                      </div>
                    </div>
                    {hasParams ? (
                      <div className="rb-substep">
                        <i>2</i>
                        <div className="rb-substep-body">
                          <p><b>接收参数</b>：先添加「获取文本」（输入选「快捷指令输入」），再添加「获取字典值」：字典选「文本」，键名填 {shortcutParamKeys.map((key, index) => (
                            <Fragment key={key}>{index > 0 ? "、" : null}<button type="button" className="rb-copychip" onClick={() => copy(key, "参数名")}>{key}</button></Fragment>
                          ))}，取到的值供后续操作使用。</p>
                        </div>
                      </div>
                    ) : null}
                    {wantsResult ? (
                      <div className="rb-substep">
                        <i>{resultNo}</i>
                        <div className="rb-substep-body">
                          {editingShortcut.resultMode === "image" ? (
                            <p><b>回传图片</b>：{hasParams ? null : <>先添加「获取文本」（输入选「快捷指令输入」），</>}用「获取字典值」取上传地址：字典选「文本」，键名填 <button type="button" className="rb-copychip" onClick={() => copy("resultUrl", "键名")}>resultUrl</button>；再用「获取 URL 内容」POST 到该变量。只传图：请求体选「文件」，文件选图片（≤8MB）。图+附文字（如截屏配 OCR 屏幕文字）：先对图片用「Base64 编码」，请求体选 JSON，加文本字段 <button type="button" className="rb-copychip" onClick={() => copy("image", "键名")}>image</button>（填编码结果）和 <button type="button" className="rb-copychip" onClick={() => copy("ocr", "键名")}>ocr</button>（填附带文字），文字会和图一起交给角色。</p>
                          ) : (
                            <p><b>回传文本</b>：{hasParams ? null : <>先添加「获取文本」（输入选「快捷指令输入」），</>}用「获取字典值」取上传地址：字典选「文本」，键名填 <button type="button" className="rb-copychip" onClick={() => copy("resultUrl", "键名")}>resultUrl</button>；再用「获取 URL 内容」POST 到该变量，请求体选 JSON，加文本字段 text 填结果。</p>
                          )}
                        </div>
                      </div>
                    ) : null}
                    {isEmailMode ? (
                      <div className="rb-substep">
                        <i>{emailNo}</i>
                        <div className="rb-substep-body">
                          <p><b>建邮件自动化</b>：在「自动化」新建「电子邮件」自动化——发件人填下方地址，主题包含下方标记，选「立即运行」，动作设为运行上面这条快捷指令并把邮件正文作为输入。</p>
                          {shortcutEmailStatus?.senderAddress ? (
                            <div className="rb-kv"><span className="rb-k">发件人</span><span style={{ wordBreak: "break-all" }}><button type="button" className="rb-copychip" onClick={() => copy(shortcutEmailStatus.senderAddress, "发件人地址")}>{shortcutEmailStatus.senderAddress}</button></span></div>
                          ) : null}
                          <div className="rb-kv"><span className="rb-k">主题标记</span><span style={{ wordBreak: "break-all" }}><button type="button" className="rb-copychip" onClick={() => copy(shortcutEmailSubjectTag(editingShortcut.id), "主题标记")}>{shortcutEmailSubjectTag(editingShortcut.id)}</button></span></div>
                        </div>
                      </div>
                    ) : null}
                    <div className="rb-substep">
                      <i>{lastNo}</i>
                      <div className="rb-substep-body">
                        <p><b>先手动跑通</b>：自己运行一次，确认快捷指令本身没问题，再进入下一步测试整条链路。</p>
                      </div>
                    </div>
                  </div>
                );
              })() : null}

              {swizStep === 6 ? (
                <div className="rb-wiz-page">
                  <div className="rb-wiz-summary">
                    <b>{editingShortcut.name.trim() || "未命名动作"}</b>
                    <p>{`运行「${editingShortcut.shortcutName.trim() || "……"}」 · ${editingShortcut.deliveryMode === "email" ? "邮件自动触发" : "通知点击运行"} · ${editingShortcut.resultMode === "none" ? "不等待结果" : editingShortcut.resultMode === "image" ? "回传图片" : "回传文本"}`}</p>
                  </div>
                  <button type="button" className="rb-btn ghost" disabled={testingShortcut}
                    onClick={() => void testEditingShortcut()}>
                    {testingShortcut ? "正在发送…" : editingShortcut.deliveryMode === "email" ? "发送测试邮件" : "发送测试通知"}
                  </button>
                  {testResult && (
                    <p className="rb-hint" style={{ color: testResult.ok ? "var(--c-success, #16a34a)" : "var(--c-danger, #dc2626)", wordBreak: "break-word" }} role="status">
                      {testResult.text}
                    </p>
                  )}
                  <p className="rb-hint">建议先发一条测试确认链路通了再保存；保存后角色即可调用这个工具。</p>
                  {isExistingShortcut ? (
                    <button type="button" className="rb-del-link" onClick={() => {
                      persistShortcutActions(shortcutActions.filter(item => item.id !== editingShortcut.id));
                      setEditingShortcut(null);
                      onNotice?.("快捷动作已删除");
                    }}>删除这个快捷动作</button>
                  ) : null}
                </div>
              ) : null}

              <div className="rb-wiz-nav">
                {swizStep > 1 ? (
                  <button type="button" className="rb-wiz-back" onClick={() => setSwizStep(swizStep - 1)} aria-label="上一步">{RB_ICON_CHEVRON}</button>
                ) : null}
                <button
                  type="button"
                  className={`rb-wiz-next${(swizStep === 2 && !editingShortcut.name.trim()) || (swizStep === 5 && !editingShortcut.shortcutName.trim()) ? " dim" : ""}`}
                  onClick={swizNext}
                  aria-label={swizStep === 6 ? "保存快捷动作" : "下一步"}
                >{swizStep === 6 ? RB_ICON_CHECK : RB_ICON_ARROW}</button>
              </div>
            </div>
          </div>
        ) : null}

        {editingItem ? (
          <div className="rb-modal-mask" onClick={() => setEditingItem(null)}>
            <div className="rb-modal rb-editor" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">{dataItems.some(item => item.id === editingItem.id) ? "编辑数据项" : "新建数据项"}</b>

              <div className="rb-wiz-steps">
                {[1, 2, 3, 4].map(n => (
                  <Fragment key={n}>
                    {n > 1 ? <i className={`rb-wiz-line${n <= dwizMax ? " done" : ""}`} /> : null}
                    <button
                      type="button"
                      className={`rb-wiz-dot${n === dwizStep ? " cur" : n < dwizStep ? " done" : ""}`}
                      disabled={!dataItems.some(item => item.id === editingItem.id) && n > dwizMax}
                      onClick={() => setDwizStep(n)}
                      aria-label={`第${n}步 ${DWIZ_STEP_NAMES[n - 1]}`}
                    >{n < dwizStep ? "✓" : n}</button>
                  </Fragment>
                ))}
              </div>
              <p className="rb-wiz-label">{DWIZ_STEP_NAMES[dwizStep - 1]}</p>

              {dwizStep === 1 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-intro">主动查询是角色的「仪表盘」：你的 iPhone 定期上传状态快照（电量、步数……），角色聊天时可以随时调工具查看最新数据，回答自动带上更新时间。</p>
                  {ready ? (
                    <div className="rb-wiz-ok">✓ 云端存储已连接，这一步自动完成</div>
                  ) : (
                    <>
                      <div className="rb-wiz-warn">尚未配置云端存储</div>
                      <p className="rb-help">前往「设置 → 数据管理 → 云端备份」填写 Supabase 项目地址与密钥。</p>
                    </>
                  )}
                </div>
              ) : null}

              {dwizStep === 2 ? (
                <div className="rb-wiz-page">
                  <label>名称（角色看到的工具名）
                    <input value={editingItem.name} maxLength={20} placeholder="例如：查看健康数据"
                      onChange={event => setEditingItem({ ...editingItem, name: event.target.value })} />
                  </label>
                  <label>标识（决定上传地址，仅小写字母、数字、-、_）
                    <input value={editingItem.key} maxLength={40} placeholder="例如：health"
                      onChange={event => setEditingItem({ ...editingItem, key: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} />
                  </label>
                  <label>说明（告诉角色这是什么数据）
                    <textarea value={editingItem.description} rows={2} maxLength={200}
                      placeholder="例如：今日步数、静息心率与昨晚睡眠时长"
                      onChange={event => setEditingItem({ ...editingItem, description: event.target.value })} />
                  </label>
                </div>
              ) : null}

              {dwizStep === 3 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-tip">在 iPhone 上建一条定期上传数据的自动化：</p>
                  <div className="rb-substep">
                    <i>1</i>
                    <div className="rb-substep-body">
                      <p><b>新建自动化</b>：在「快捷指令 → 自动化」新建，触发时机按数据特点选择。</p>
                      <div className="rb-kv"><span className="rb-eg">示例</span><span>电量 → 「充电时」+「每小时」；健康数据 → 每天早晚各一次</span></div>
                    </div>
                  </div>
                  <div className="rb-substep">
                    <i>2</i>
                    <div className="rb-substep-body">
                      <p><b>获取并上传数据</b>：先用系统动作取数据（如「获取电池电量」「查找健康样本」），再用「获取 URL 内容」以 POST 发到下方地址，请求体选 JSON，内容格式自由（例：{"{\"电量\":\"85%\",\"充电中\":\"是\"}"}）。</p>
                      <div className="rb-code" onClick={() => copy(stateUrl(sanitizeBridgeDataKey(editingItem.key) || "标识"), "上传地址")}><code>{stateUrl(sanitizeBridgeDataKey(editingItem.key) || "标识")}</code><span className="rb-copy">复制</span></div>
                    </div>
                  </div>
                  <div className="rb-substep">
                    <i>3</i>
                    <div className="rb-substep-body">
                      <p><b>设置头部</b>（两项都要）：<button type="button" className="rb-copychip" onClick={() => copy("Authorization", "头部名称")}>Authorization</button> 填下方密钥；<button type="button" className="rb-copychip" onClick={() => copy("x-upsert", "头部名称")}>x-upsert</button> 填 <button type="button" className="rb-copychip" onClick={() => copy("true", "头部值")}>true</button>（快照反复覆盖同一地址，缺它第二次上传会报 409）。</p>
                      <div className="rb-code" onClick={() => copy(`Bearer ${config.key || ""}`, "密钥")}>
                        <code>{config.key ? `Bearer ${config.key.slice(0, 12)}……${config.key.slice(-6)}` : "<请先完成第一步>"}</code>
                        <span className="rb-copy">复制</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {dwizStep === 4 ? (
                <div className="rb-wiz-page">
                  <div className="rb-wiz-summary">
                    <b>{editingItem.name.trim() || "未命名数据项"}</b>
                    <p>{editingItem.description.trim() || "（未填写说明）"}</p>
                  </div>
                  <button type="button" className="rb-btn ghost" disabled={dataSnapshotBusy || !ready}
                    onClick={() => void checkDataSnapshot()}>
                    {dataSnapshotBusy ? "正在读取…" : "已上传过数据？读取看看"}
                  </button>
                  {dataSnapshot === "none" ? (
                    <p className="rb-hint">还没读到数据。运行一次上一步的自动化后再试；刚上传的话等几秒。</p>
                  ) : dataSnapshot ? (
                    <div className="rb-wiz-snapshot">
                      <small>{dataSnapshot.updatedAt ? `更新于 ${fmtTime(dataSnapshot.updatedAt)}` : "已读到数据"}</small>
                      <code>{dataSnapshot.text.slice(0, 400)}</code>
                    </div>
                  ) : null}
                  <p className="rb-hint">保存后角色即可通过工具查询这项数据（需在「工具箱 → 内置能力」启用「现实桥」）。</p>
                  {dataItems.some(item => item.id === editingItem.id) ? (
                    <button type="button" className="rb-del-link" onClick={() => {
                      persistDataItems(dataItems.filter(item => item.id !== editingItem.id));
                      setEditingItem(null);
                      onNotice?.("数据项已删除");
                    }}>删除这个数据项</button>
                  ) : null}
                </div>
              ) : null}

              <div className="rb-wiz-nav">
                {dwizStep > 1 ? (
                  <button type="button" className="rb-wiz-back" onClick={() => setDwizStep(dwizStep - 1)} aria-label="上一步">{RB_ICON_CHEVRON}</button>
                ) : null}
                <button
                  type="button"
                  className={`rb-wiz-next${dwizStep === 2 && (!editingItem.name.trim() || !sanitizeBridgeDataKey(editingItem.key)) ? " dim" : ""}`}
                  onClick={dwizNext}
                  aria-label={dwizStep === 4 ? "保存数据项" : "下一步"}
                >{dwizStep === 4 ? RB_ICON_CHECK : RB_ICON_ARROW}</button>
              </div>
            </div>
          </div>
        ) : null}

        {editingScreenChat ? (
          <div className="rb-modal-mask" onClick={() => setEditingScreenChat(null)}>
            <div className="rb-modal rb-editor" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">配置屏幕速聊</b>

              <div className="rb-wiz-steps">
                {[1, 2, 3, 4].map(n => (
                  <Fragment key={n}>
                    {n > 1 ? <i className={`rb-wiz-line${n <= screenWizMax ? " done" : ""}`} /> : null}
                    <button
                      type="button"
                      className={`rb-wiz-dot${n === screenWizStep ? " cur" : n < screenWizStep ? " done" : ""}`}
                      disabled={n > screenWizMax}
                      onClick={() => setScreenWizStep(n)}
                      aria-label={`第${n}步 ${SCREEN_WIZ_STEP_NAMES[n - 1]}`}
                    >{n < screenWizStep ? "✓" : n}</button>
                  </Fragment>
                ))}
              </div>
              <p className="rb-wiz-label">{SCREEN_WIZ_STEP_NAMES[screenWizStep - 1]}</p>

              {screenWizStep === 1 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-intro">屏幕速聊会把当前屏幕交给角色，TA 的回复以系统弹窗直接出现，还能在弹窗里继续聊，全程不用打开小手机。</p>
                  {personalScreenChatReady ? (
                    <div className="rb-wiz-ok">✓ 最新版个人云已连接，这一步自动完成</div>
                  ) : (
                    <>
                      <div className="rb-wiz-warn">{personalPushActive ? "个人云版本需要更新" : "尚未部署个人云"}</div>
                      <p className="rb-help">前往「设置 → 云服务部署」{personalPushActive ? "重新部署最新版个人云" : "完成个人云部署"}，屏幕速聊接口会随部署一起创建。</p>
                    </>
                  )}
                  <p className="rb-hint">截图只用于当前一次 AI 生成，不保存到 Supabase；云端仅暂存尚未同步回小手机的文字消息。</p>
                </div>
              ) : null}

              {screenWizStep === 2 ? (
                <div className="rb-wiz-page">
                  {characters.length > 0 ? (
                    <label>谁来接弹窗
                      <select
                        value={editingScreenChat.characterId}
                        onChange={event => setEditingScreenChat({ ...editingScreenChat, characterId: event.target.value })}
                      >
                        <option value="" disabled>请选择角色</option>
                        {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                      </select>
                    </label>
                  ) : (
                    <div className="rb-wiz-warn">请先在小手机里创建一个角色</div>
                  )}
                  <p className="rb-hint">屏幕速聊始终接入这个角色原有的同一个聊天窗口。换 App、隔很久再双击也不会新开对话；打开小手机后，云端暂存的问答会按顺序进入原聊天记录。</p>
                </div>
              ) : null}

              {screenWizStep === 3 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-intro">推荐直接导入已经搭好的「屏幕速聊」，导入时按提示填写你的接口地址和令牌。</p>
                  <a
                    className="rb-btn rb-shortcut-import"
                    href={SCREEN_CHAT_SHORTCUT_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label="打开 iCloud 导入屏幕速聊快捷指令"
                  >一键导入屏幕速聊</a>
                  <div>
                    <p className="rb-wiz-tip">问题 1 · 接口地址</p>
                    <div className="rb-code" onClick={() => copy(screenChatUrl, "接口地址")}><code>{screenChatUrl}</code><span className="rb-copy">复制</span></div>
                  </div>
                  <div>
                    <p className="rb-wiz-tip">问题 2 · 令牌</p>
                    {bridgeToken ? (
                      <div className="rb-code" onClick={() => copy(bridgeToken, "令牌")}><code>{bridgeToken}</code><span className="rb-copy">复制</span></div>
                    ) : (
                      <p className="rb-hint">个人云连通后这里会显示你的专属令牌。</p>
                    )}
                  </div>
                  <p className="rb-hint rb-screen-chat-bind-hint">导入完成后，到系统「设置 → 辅助功能 → 触控 → 辅助触控」，把「轻点两下」设为这条快捷指令。</p>

                  <details className="rb-more rb-screen-chat-manual">
                    <summary>需要手动搭建？展开完整步骤</summary>
                    <div className="rb-more-body">
                      <div className="rb-substep">
                        <i>1</i>
                        <div className="rb-substep-body">
                          <p><b>新建快捷指令</b>：新建一条快捷指令（不是自动化），起名如「屏幕速聊」。</p>
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>2</i>
                        <div className="rb-substep-body">
                          <p><b>截屏并压缩</b>：依次添加「截屏」→「调整图像大小」（宽度 960，高度自动）→「转换图像」（JPEG）→「Base64 编码」。</p>
                          <p className="rb-hint">再加「从图像中提取文本」，输入选择调整大小后的图像，作为图像识别不可用时的兜底。</p>
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>3</i>
                        <div className="rb-substep-body">
                          <p><b>发给角色</b>：添加「获取 URL 内容」，URL 填：</p>
                          <div className="rb-code" onClick={() => copy(screenChatUrl, "接口地址")}><code>{screenChatUrl}</code><span className="rb-copy">复制</span></div>
                          <p>方法选 <b>POST</b>，请求体选 <b>JSON</b>，添加 4 个文本字段：
                            <button type="button" className="rb-copychip" onClick={() => copy("token", "字段名")}>token</button> 填下方令牌、
                            <button type="button" className="rb-copychip" onClick={() => copy("image", "字段名")}>image</button> 插入 Base64 变量、
                            <button type="button" className="rb-copychip" onClick={() => copy("imageType", "字段名")}>imageType</button> 填 <button type="button" className="rb-copychip" onClick={() => copy("image/jpeg", "字段值")}>image/jpeg</button>、
                            <button type="button" className="rb-copychip" onClick={() => copy("ocr", "字段名")}>ocr</button> 插入图像文本变量。</p>
                          {bridgeToken ? (
                            <div className="rb-code" onClick={() => copy(bridgeToken, "令牌")}><code>{bridgeToken}</code><span className="rb-copy">复制</span></div>
                          ) : (
                            <p className="rb-hint">个人云连通后这里会显示你的专属令牌。</p>
                          )}
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>4</i>
                        <div className="rb-substep-body">
                          <p><b>弹出回复</b>：从「URL 内容」获取字典值 <button type="button" className="rb-copychip" onClick={() => copy("reply", "键名")}>reply</button>，再用「显示提醒」弹出它。</p>
                          <p className="rb-hint">也可读取 <button type="button" className="rb-copychip" onClick={() => copy("error", "键名")}>error</button>，在请求失败时显示原因。</p>
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>5</i>
                        <div className="rb-substep-body">
                          <p><b>续聊循环</b>：添加「重复」（15 次），内部放「要求输入」→ 再次 POST 同一地址（<button type="button" className="rb-copychip" onClick={() => copy("token", "字段名")}>token</button> 与 <button type="button" className="rb-copychip" onClick={() => copy("text", "字段名")}>text</button>）→ 获取 reply →「显示提醒」。</p>
                          <p className="rb-hint">弹窗点「取消」即可结束本次对话。</p>
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>6</i>
                        <div className="rb-substep-body">
                          <p><b>绑定悬浮球</b>：系统「设置 → 辅助功能 → 触控 → 辅助触控」，把「轻点两下」设为这条快捷指令。</p>
                          <p className="rb-hint">首次运行请允许网络与截屏权限；每轮回复通常需要 3～8 秒。</p>
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              ) : null}

              {screenWizStep === 4 ? (
                <div className="rb-wiz-page">
                  <div className="rb-wiz-summary">
                    <b>屏幕速聊</b>
                    <p>{editingScreenChat.characterId ? `${charName(editingScreenChat.characterId)} 会接收屏幕并在原聊天窗口连续回复。` : "尚未选择角色"}</p>
                  </div>
                  <div className="rb-main-row">
                    <span className="rb-icchip">{RB_ICON_CHAT}</span>
                    <div className="rb-main-text">
                      <b>启用屏幕速聊</b>
                      <p>保存后可随时在配置卡片上暂停或恢复</p>
                    </div>
                    <button
                      type="button"
                      className={`rb-switch ${editingScreenChat.enabled ? "on" : ""}`}
                      onClick={() => setEditingScreenChat({ ...editingScreenChat, enabled: !editingScreenChat.enabled })}
                      aria-label={editingScreenChat.enabled ? "保存后停用屏幕速聊" : "保存后启用屏幕速聊"}
                    />
                  </div>
                  <p className="rb-hint">保存只更新小手机里的配置，不会重建个人云，也不会清空已有聊天或同步记录。</p>
                </div>
              ) : null}

              <div className="rb-wiz-nav">
                {screenWizStep > 1 ? (
                  <button type="button" className="rb-wiz-back" onClick={() => setScreenWizStep(screenWizStep - 1)} aria-label="上一步">{RB_ICON_CHEVRON}</button>
                ) : null}
                <button
                  type="button"
                  className={`rb-wiz-next${(screenWizStep === 1 && !personalScreenChatReady) || (screenWizStep === 2 && !editingScreenChat.characterId) ? " dim" : ""}`}
                  onClick={screenWizNext}
                  aria-label={screenWizStep === 4 ? "保存屏幕速聊" : "下一步"}
                >{screenWizStep === 4 ? RB_ICON_CHECK : RB_ICON_ARROW}</button>
              </div>
            </div>
          </div>
        ) : null}

        <nav className="rb-dock" aria-label="页面切换">
          <button type="button" className={tab === "main" ? "active" : ""} onClick={() => setTab("main")} aria-label="设置与联动">{RB_ICON_GEAR}</button>
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")} aria-label="接收历史">{RB_ICON_HISTORY}</button>
        </nav>
      </div>
    </div>
  );
}
