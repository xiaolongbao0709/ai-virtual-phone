"use client";

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { loadCloudBackupConfig, isCloudBackupConfigured, type CloudBackupConfig } from "../cloud-backup/config";
import { claimObject, getObject, listObjects, putObject, removeObject } from "../cloud-backup/storage-client";
import {
  BRIDGE_INBOX_PREFIX,
  BRIDGE_OUTBOX_QUEUE_PATH,
  BRIDGE_STATE_PREFIX,
  type BridgeFeedEntry,
  type BridgeItem,
  type BridgeOutboxEntry,
  type BridgeRule,
} from "./types";

const BRIDGE_RULES_KEY = "ai_phone_reality_bridge_rules_v1";
const BRIDGE_FEED_KEY = "ai_phone_reality_bridge_feed_v1";
const BRIDGE_SETTINGS_KEY = "ai_phone_reality_bridge_settings_v1";
const BRIDGE_DATA_ITEMS_KEY = "ai_phone_reality_bridge_data_items_v1";
const BRIDGE_SHORTCUT_ACTIONS_KEY = "ai_phone_reality_bridge_shortcut_actions_v1";
const BRIDGE_RULE_RUNS_KEY = "ai_phone_reality_bridge_rule_runs_v1";
const BRIDGE_SCREEN_CHAT_KEY = "ai_phone_reality_bridge_screen_chat_v1";
const FEED_LIMIT = 200;

registerKvMigration(BRIDGE_RULES_KEY);
registerKvMigration(BRIDGE_FEED_KEY);
registerKvMigration(BRIDGE_SETTINGS_KEY);
registerKvMigration(BRIDGE_DATA_ITEMS_KEY);
registerKvMigration(BRIDGE_SHORTCUT_ACTIONS_KEY);
registerKvMigration(BRIDGE_RULE_RUNS_KEY);
registerKvMigration(BRIDGE_SCREEN_CHAT_KEY);

export type BridgeSettings = {
  enabled: boolean;
  pollSeconds: number;
  /** 总开关：收到的每条桥数据都广播 bridge.data 事件给已订阅的自定义 APP（无需逐条规则勾选） */
  broadcastToApps: boolean;
};

const DEFAULT_SETTINGS: BridgeSettings = { enabled: true, pollSeconds: 20, broadcastToApps: true };

export function loadBridgeSettings(): BridgeSettings {
  try {
    const raw = kvGet(BRIDGE_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<BridgeSettings>;
    return {
      /* 缺失键视为开启（默认开），仅显式 false 视为用户关闭 */
      enabled: parsed.enabled !== false,
      pollSeconds: Math.max(10, Math.min(300, Number(parsed.pollSeconds) || 20)),
      broadcastToApps: parsed.broadcastToApps !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveBridgeSettings(settings: BridgeSettings): void {
  kvSet(BRIDGE_SETTINGS_KEY, JSON.stringify(settings));
}

export function bridgeConnection(): { config: CloudBackupConfig; ready: boolean } {
  const config = loadCloudBackupConfig();
  return { config, ready: isCloudBackupConfigured(config) };
}

/* ---------- 规则 ---------- */

export function loadBridgeRules(): BridgeRule[] {
  try {
    const raw = kvGet(BRIDGE_RULES_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed.filter(r => r && typeof r === "object") as BridgeRule[] : [];
  } catch {
    return [];
  }
}

export function saveBridgeRules(rules: BridgeRule[]): void {
  kvSet(BRIDGE_RULES_KEY, JSON.stringify(rules.slice(0, 100)));
  // 离线联动：规则变了通知同步器刷新服务端快照
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("reality-bridge-rules-updated"));
  }
}

/* ---------- 屏幕速聊（悬浮球截屏 → 同步弹窗对话） ---------- */

export type ScreenChatSettings = {
  enabled: boolean;
  /** 弹窗里回话的角色 */
  characterId: string;
};

const DEFAULT_SCREEN_CHAT: ScreenChatSettings = { enabled: false, characterId: "" };
const SCREEN_CHAT_ACK_PREFIX = "screen_chat_ack_v1:";

export function loadScreenChatSettings(): ScreenChatSettings {
  try {
    const raw = kvGet(BRIDGE_SCREEN_CHAT_KEY);
    if (!raw) return { ...DEFAULT_SCREEN_CHAT };
    const parsed = JSON.parse(raw) as Partial<ScreenChatSettings>;
    return {
      enabled: parsed.enabled === true,
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
    };
  } catch {
    return { ...DEFAULT_SCREEN_CHAT };
  }
}

/** 最近已经完整合并进小手机聊天记录的云端屏幕速聊轮次。 */
export function loadScreenChatAck(characterId: string): number {
  const value = Number(kvGet(`${SCREEN_CHAT_ACK_PREFIX}${characterId}`));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function saveScreenChatAck(characterId: string, sequence: number): void {
  if (!characterId || !Number.isSafeInteger(sequence) || sequence <= loadScreenChatAck(characterId)) return;
  kvSet(`${SCREEN_CHAT_ACK_PREFIX}${characterId}`, String(sequence));
  if (typeof window !== "undefined") {
    // 立即重传带确认序号的新快照；下一次云端请求便会裁掉已回端的增量，避免上下文重复。
    window.dispatchEvent(new CustomEvent("reality-bridge-rules-updated"));
  }
}

export function saveScreenChatSettings(settings: ScreenChatSettings): void {
  kvSet(BRIDGE_SCREEN_CHAT_KEY, JSON.stringify(settings));
  // 快照走离线联动同一条同步链路：设置变了通知同步器重传
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("reality-bridge-rules-updated"));
  }
}

/* ---------- 手机数据项（用户自定义的状态快照，映射为「现实桥」套装子工具） ---------- */

export type BridgeDataItem = {
  id: string;
  /** 角色看到的工具名，如「查看健康数据」 */
  name: string;
  /** 云端路径标识：bridge-state/<key>.json */
  key: string;
  /** 写给角色的说明（这是什么数据、大概格式） */
  description: string;
  createdAt: string;
};

export function loadBridgeDataItems(): BridgeDataItem[] {
  try {
    const raw = kvGet(BRIDGE_DATA_ITEMS_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed)
      ? (parsed as BridgeDataItem[]).filter(item => item && typeof item === "object" && item.name && item.key)
      : [];
  } catch {
    return [];
  }
}

export function saveBridgeDataItems(items: BridgeDataItem[]): void {
  kvSet(BRIDGE_DATA_ITEMS_KEY, JSON.stringify(items.slice(0, 30)));
}

export function sanitizeBridgeDataKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

/* ---------- 快捷动作（用户登记后映射为「现实桥」套装子工具） ---------- */

export type BridgeShortcutResultMode = "none" | "text" | "image";
export type BridgeShortcutDeliveryMode = "push" | "email";

export type BridgeShortcutAction = {
  id: string;
  /** 角色看到的工具名，如「打开微信并截图」 */
  name: string;
  /** iPhone「快捷指令」App 中的准确名称 */
  shortcutName: string;
  /** 点击 Web Push 运行，或由 iOS 邮件自动化无确认运行 */
  deliveryMode: BridgeShortcutDeliveryMode;
  /** 告诉角色何时使用该动作 */
  description: string;
  /** 角色调用参数的 JSON Schema；空对象表示无参数 */
  parameterSchema: string;
  /** 是否等待快捷指令把文本或图片回传给当前一轮角色 */
  resultMode: BridgeShortcutResultMode;
  /** 命令过期时间，也是等待结果的最长时间 */
  expiresInSeconds: number;
  enabled: boolean;
  createdAt: string;
};

function normalizeShortcutResultMode(value: unknown): BridgeShortcutResultMode {
  return value === "text" || value === "image" ? value : "none";
}

function normalizeShortcutDeliveryMode(value: unknown): BridgeShortcutDeliveryMode {
  return value === "email" ? "email" : "push";
}

export function loadBridgeShortcutActions(): BridgeShortcutAction[] {
  try {
    const raw = kvGet(BRIDGE_SHORTCUT_ACTIONS_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    return (parsed as Partial<BridgeShortcutAction>[])
      .filter(item => item && typeof item === "object" && item.name && item.shortcutName)
      .map(item => {
        return {
          id: String(item.id || `shortcut_${Date.now().toString(36)}`),
          name: String(item.name).trim().slice(0, 30),
          shortcutName: String(item.shortcutName).trim().slice(0, 80),
          deliveryMode: normalizeShortcutDeliveryMode(item.deliveryMode),
          description: String(item.description || "").trim().slice(0, 300),
          parameterSchema: String(item.parameterSchema || "{}").slice(0, 8000),
          resultMode: normalizeShortcutResultMode(item.resultMode),
          expiresInSeconds: Math.max(30, Math.min(900, Number(item.expiresInSeconds) || 120)),
          enabled: item.enabled !== false,
          createdAt: String(item.createdAt || new Date().toISOString()),
        };
      })
      .filter(item => item.name && item.shortcutName)
      .slice(0, 30);
  } catch {
    return [];
  }
}

export function saveBridgeShortcutActions(actions: BridgeShortcutAction[]): void {
  kvSet(BRIDGE_SHORTCUT_ACTIONS_KEY, JSON.stringify(actions.slice(0, 30)));
}

export function parseBridgeActionParameterSchema(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const schema = parsed as Record<string, unknown>;
    if (schema.type !== undefined && schema.type !== "object") return null;
    if (schema.properties !== undefined
      && (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))) return null;
    if (schema.required !== undefined
      && (!Array.isArray(schema.required) || schema.required.some(item => typeof item !== "string"))) return null;
    return schema;
  } catch {
    return null;
  }
}

/** 读取单个状态快照：内容 + 云端更新时间（来自存储元数据，快捷指令无需自带时间戳） */
export async function readBridgeStateSnapshot(
  config: CloudBackupConfig,
  key: string,
): Promise<{ text: string; updatedAt?: string } | null> {
  const blob = await getObject(config, `${BRIDGE_STATE_PREFIX}${key}.json`);
  if (!blob) return null;
  const text = (await blob.text()).slice(0, 4000);
  let updatedAt: string | undefined;
  try {
    const objects = await listObjects(config, BRIDGE_STATE_PREFIX, 100);
    updatedAt = objects.find(obj => obj.name === `${key}.json`)?.updatedAt;
  } catch { /* 拿不到更新时间就不带 */ }
  return { text, updatedAt };
}

/** 读取全部状态快照（「查看全部手机数据」用） */
export async function readAllBridgeStateSnapshots(
  config: CloudBackupConfig,
  limit = 12,
): Promise<Array<{ key: string; text: string; updatedAt?: string }>> {
  const objects = (await listObjects(config, BRIDGE_STATE_PREFIX, 100))
    .filter(obj => obj.name.endsWith(".json"))
    .slice(0, limit);
  const out: Array<{ key: string; text: string; updatedAt?: string }> = [];
  for (const obj of objects) {
    try {
      const blob = await getObject(config, BRIDGE_STATE_PREFIX + obj.name);
      if (!blob) continue;
      out.push({
        key: obj.name.replace(/\.json$/, ""),
        text: (await blob.text()).slice(0, 800),
        updatedAt: obj.updatedAt,
      });
    } catch { /* 单个快照读失败不影响其余 */ }
  }
  return out;
}

/* ---------- 触发间隔（记录每条联动的上次触发时间） ---------- */

function loadRuleRuns(): Record<string, string> {
  try {
    const raw = kvGet(BRIDGE_RULE_RUNS_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

/** 全部触发记录（ruleId → ISO 时间）：离线联动同步给服务端做冷却判断。 */
export function getBridgeRuleRunsMap(): Record<string, string> {
  return loadRuleRuns();
}

/** 合并服务端的触发记录（服务端处理期间的冷却状态回灌本地）。 */
export function mergeBridgeRuleRuns(serverRuns: Record<string, string>): void {
  const runs = loadRuleRuns();
  let changed = false;
  for (const [ruleId, iso] of Object.entries(serverRuns)) {
    const serverTime = Date.parse(iso);
    if (!Number.isFinite(serverTime)) continue;
    const localTime = runs[ruleId] ? Date.parse(runs[ruleId]) : 0;
    if (serverTime > localTime) {
      runs[ruleId] = iso;
      changed = true;
    }
  }
  if (changed) kvSet(BRIDGE_RULE_RUNS_KEY, JSON.stringify(runs));
}

/** 该联动上次触发的时间戳（毫秒）；从未触发返回 0。 */
export function getBridgeRuleLastRunAt(ruleId: string): number {
  const iso = loadRuleRuns()[ruleId];
  const time = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

export function markBridgeRuleRun(ruleId: string): void {
  const runs = loadRuleRuns();
  runs[ruleId] = new Date().toISOString();
  const keys = Object.keys(runs);
  if (keys.length > 200) {
    // 防止已删除规则的记录无限堆积：只保留最近 100 条
    keys.sort((a, b) => (runs[a] < runs[b] ? -1 : 1))
      .slice(0, keys.length - 100)
      .forEach(key => delete runs[key]);
  }
  kvSet(BRIDGE_RULE_RUNS_KEY, JSON.stringify(runs));
}

/* ---------- 本地流水 ---------- */

export function loadBridgeFeed(): BridgeFeedEntry[] {
  try {
    const raw = kvGet(BRIDGE_FEED_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed as BridgeFeedEntry[] : [];
  } catch {
    return [];
  }
}

export function appendBridgeFeed(entry: BridgeFeedEntry): void {
  const next = [entry, ...loadBridgeFeed()].slice(0, FEED_LIMIT);
  kvSet(BRIDGE_FEED_KEY, JSON.stringify(next));
}

export function clearBridgeFeed(): void {
  kvSet(BRIDGE_FEED_KEY, "[]");
}

/* ---------- 收件箱（用户自己的 Supabase Storage） ---------- */

function parseBridgeItem(name: string, text: string): BridgeItem | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const type = String(parsed.type ?? "").trim().slice(0, 60);
    if (!type) return null;
    const rawPayload = parsed.payload;
    const payload = typeof rawPayload === "string"
      ? rawPayload.slice(0, 8000)
      : JSON.stringify(rawPayload ?? "").slice(0, 8000);
    return {
      id: name,
      type,
      payload,
      createdAt: String(parsed.createdAt ?? new Date().toISOString()),
    };
  } catch {
    return null;
  }
}

/** 拉取并清空收件箱，返回解析成功的条目。
 *  删除即认领：只处理真正由本次删除取走的文件——删除失败（如 key 无删除权限）
 *  则跳过留给下次，绝不「处理了却删不掉」导致每轮轮询重复触发；
 *  404 表示服务端扫描或其他标签页已抢先取走，同样跳过。 */
export async function pullBridgeInbox(config: CloudBackupConfig, limit = 30): Promise<BridgeItem[]> {
  const objects = await listObjects(config, BRIDGE_INBOX_PREFIX, limit);
  const items: BridgeItem[] = [];
  for (const obj of objects) {
    if (!obj.name || obj.name.endsWith("/")) continue;
    const path = BRIDGE_INBOX_PREFIX + obj.name;
    try {
      const blob = await getObject(config, path);
      if (!blob) continue;
      const text = await blob.text();
      if (!(await claimObject(config, path))) continue;
      const item = parseBridgeItem(obj.name, text);
      if (item) items.push(item);
    } catch (err) {
      console.warn("[现实桥] 收件箱条目认领失败，留待下次", path, err);
    }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return items;
}

/* ---------- 发件箱（单一 queue.json，iPhone 执行器取走后删除） ---------- */

let bridgeOutboxMutationQueue: Promise<void> = Promise.resolve();
const BRIDGE_OUTBOX_LOCK_NAME = "ai-phone-reality-bridge-outbox";

async function serializeBridgeOutboxMutation<T>(mutation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return await navigator.locks.request(BRIDGE_OUTBOX_LOCK_NAME, mutation);
  }
  const result = bridgeOutboxMutationQueue.then(mutation, mutation);
  bridgeOutboxMutationQueue = result.then(() => undefined, () => undefined);
  return await result;
}

async function loadBridgeOutboxQueue(config: CloudBackupConfig): Promise<BridgeOutboxEntry[]> {
  const blob = await getObject(config, BRIDGE_OUTBOX_QUEUE_PATH);
  if (!blob) return [];
  try {
    const parsed = JSON.parse(await blob.text()) as unknown;
    return Array.isArray(parsed) ? parsed as BridgeOutboxEntry[] : [];
  } catch {
    return [];
  }
}

export async function appendBridgeOutbox(
  config: CloudBackupConfig,
  entry: Omit<BridgeOutboxEntry, "id" | "createdAt">,
): Promise<BridgeOutboxEntry> {
  const full: BridgeOutboxEntry = {
    ...entry,
    id: `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };

  return serializeBridgeOutboxMutation(async () => {
    let queue = await loadBridgeOutboxQueue(config);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = [...queue.filter(item => item.id !== full.id), full].slice(-50);
      await putObject(config, BRIDGE_OUTBOX_QUEUE_PATH, JSON.stringify(next), "application/json");

      const confirmed = await loadBridgeOutboxQueue(config);
      if (confirmed.some(item => item.id === full.id)) return full;
      queue = confirmed;
    }
    throw new Error("现实桥发件箱写入后校验失败。");
  });
}

export async function readBridgeOutbox(config: CloudBackupConfig): Promise<BridgeOutboxEntry[]> {
  try {
    return await loadBridgeOutboxQueue(config);
  } catch {
    return [];
  }
}

export async function clearBridgeOutbox(config: CloudBackupConfig): Promise<void> {
  await serializeBridgeOutboxMutation(() => removeObject(config, BRIDGE_OUTBOX_QUEUE_PATH));
}
