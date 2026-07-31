// lib/chat-plugin-storage.ts
// 聊天插件系统 · 存储层：安装表 / 共享变量池 / 持久提示词片段 / 插件私有数据桶 / 错误日志。
// 运行时（加载执行、hook 总线、ctx 构建）见 chat-plugin-runtime.ts。

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";
import type {
    ChatPluginErrorEntry,
    ChatPluginManifest,
    ChatPluginVarScope,
    InstalledChatPlugin,
} from "./chat-plugin-types";
import { CHAT_PLUGIN_API_VERSION } from "./chat-plugin-types";

const PLUGINS_KEY = "chat_plugins_v3";
const VARS_KEY = "chat_plugin_vars_v2";
const FRAGMENTS_KEY = "chat_plugin_fragments_v2";
const DATA_PREFIX = "chat_plugin_data_v1:";
const ERRORS_KEY = "chat_plugin_errors_v1";
registerKvMigration(PLUGINS_KEY);
registerKvMigration(VARS_KEY);
registerKvMigration(FRAGMENTS_KEY);
registerKvMigration(ERRORS_KEY);

/** 插件列表/启停变化（运行时据此重建） */
export const CHAT_PLUGINS_CHANGED_EVENT = "chat-plugins-changed";
/** 插件报错/日志写入（管理页据此刷新） */
export const CHAT_PLUGIN_ERROR_EVENT = "chat-plugin-error";

const MAX_ERROR_ENTRIES = 100;
const MAX_CODE_LENGTH = 512_000;

function emit(eventName: string, detail?: unknown) {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
}

function readJson<T>(key: string, fallback: T): T {
    try {
        const raw = kvGet(key);
        if (raw) return JSON.parse(raw) as T;
    } catch { /* ignore */ }
    return fallback;
}

function writeJson(key: string, value: unknown): void {
    kvSet(key, JSON.stringify(value));
}

// ── 安装表 ────────────────────────────────────────────────

export function loadChatPlugins(): InstalledChatPlugin[] {
    const list = readJson<InstalledChatPlugin[]>(PLUGINS_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter(p =>
        !!p && typeof p === "object"
        && typeof p.manifest?.id === "string"
        && typeof p.code === "string");
}

export function saveChatPlugins(plugins: InstalledChatPlugin[]): void {
    writeJson(PLUGINS_KEY, plugins);
    emit(CHAT_PLUGINS_CHANGED_EVENT);
}

export function getInstalledChatPlugin(id: string): InstalledChatPlugin | null {
    return loadChatPlugins().find(p => p.manifest.id === id) ?? null;
}

export function validateChatPluginManifest(input: unknown): { manifest?: ChatPluginManifest; error?: string } {
    if (!input || typeof input !== "object") return { error: "default 导出缺少 manifest 对象" };
    const m = input as Record<string, unknown>;
    if (typeof m.id !== "string" || !/^[A-Za-z0-9_.-]{2,64}$/.test(m.id)) {
        return { error: "manifest.id 无效（2~64 位字母/数字/横线/下划线/点）" };
    }
    if (typeof m.name !== "string" || !m.name.trim()) return { error: "缺少 manifest.name" };
    if (typeof m.apiVersion !== "number") return { error: "缺少 manifest.apiVersion（当前宿主为 1）" };
    if (m.apiVersion > CHAT_PLUGIN_API_VERSION) {
        return { error: `插件要求 apiVersion ${m.apiVersion}，当前宿主为 ${CHAT_PLUGIN_API_VERSION}，请升级应用` };
    }
    const settings = Array.isArray(m.settings)
        ? (m.settings as ChatPluginManifest["settings"])!.filter(f =>
            !!f && typeof f.key === "string" && typeof f.label === "string"
            && ["text", "number", "boolean", "select"].includes(f.type))
        : undefined;
    return {
        manifest: {
            id: m.id,
            name: (m.name as string).trim().slice(0, 40),
            apiVersion: m.apiVersion,
            version: typeof m.version === "string" ? m.version.slice(0, 16) : undefined,
            author: typeof m.author === "string" ? m.author.slice(0, 40) : undefined,
            description: typeof m.description === "string" ? m.description.slice(0, 300) : undefined,
            permissions: Array.isArray(m.permissions) ? m.permissions.map(String).slice(0, 20) : undefined,
            settings,
        },
    };
}

/** 落库一个（已通过 loader 校验的）插件；同 id 覆盖安装保留原设置 */
export function persistChatPlugin(manifest: ChatPluginManifest, code: string): { ok: boolean; error?: string } {
    if (code.length > MAX_CODE_LENGTH) return { ok: false, error: `插件源码过长（上限 ${MAX_CODE_LENGTH / 1000}KB）` };
    const plugins = loadChatPlugins();
    const now = new Date().toISOString();
    const idx = plugins.findIndex(p => p.manifest.id === manifest.id);
    const defaults: Record<string, unknown> = {};
    for (const f of manifest.settings ?? []) {
        if (f.default !== undefined) defaults[f.key] = f.default;
    }
    if (idx >= 0) {
        plugins[idx] = {
            ...plugins[idx],
            manifest,
            code,
            updatedAt: now,
            settings: { ...defaults, ...plugins[idx].settings },
        };
    } else {
        plugins.push({ manifest, code, enabled: true, installedAt: now, updatedAt: now, settings: defaults });
    }
    saveChatPlugins(plugins);
    return { ok: true };
}

export function uninstallChatPlugin(id: string): void {
    saveChatPlugins(loadChatPlugins().filter(p => p.manifest.id !== id));
    // 插件私有数据、提示词片段随卸载清除；共享变量池是世界状态，保留
    kvRemove(DATA_PREFIX + id);
    const fragments = readJson<Record<string, Record<string, string>>>(FRAGMENTS_KEY, {});
    if (fragments[id]) { delete fragments[id]; writeJson(FRAGMENTS_KEY, fragments); }
}

export function setChatPluginEnabled(id: string, enabled: boolean): void {
    const plugins = loadChatPlugins();
    const target = plugins.find(p => p.manifest.id === id);
    if (target && target.enabled !== enabled) {
        target.enabled = enabled;
        saveChatPlugins(plugins);
    }
}

export function updateChatPluginSettings(id: string, settings: Record<string, unknown>): void {
    const plugins = loadChatPlugins();
    const target = plugins.find(p => p.manifest.id === id);
    if (target) {
        target.settings = { ...target.settings, ...settings };
        saveChatPlugins(plugins);
    }
}

// ── 共享变量池（session / character / global 三作用域） ──────

type VarStore = {
    global: Record<string, string>;
    sessions: Record<string, Record<string, string>>;
    characters: Record<string, Record<string, string>>;
};

function loadVarStore(): VarStore {
    const s = readJson<VarStore>(VARS_KEY, { global: {}, sessions: {}, characters: {} });
    return { global: s.global || {}, sessions: s.sessions || {}, characters: s.characters || {} };
}

function varBucket(store: VarStore, scope: ChatPluginVarScope, targetId?: string): Record<string, string> | null {
    if (scope === "global") return store.global;
    if (!targetId) return null;
    const map = scope === "session" ? store.sessions : store.characters;
    map[targetId] = map[targetId] || {};
    return map[targetId];
}

export function getChatPluginVar(name: string, scope: ChatPluginVarScope, targetId?: string): unknown {
    const bucket = varBucket(loadVarStore(), scope, targetId);
    const raw = bucket?.[name];
    if (raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
}

export function setChatPluginVar(name: string, value: unknown, scope: ChatPluginVarScope, targetId?: string): void {
    const store = loadVarStore();
    const bucket = varBucket(store, scope, targetId);
    if (!bucket) return;
    bucket[name] = JSON.stringify(value === undefined ? null : value);
    writeJson(VARS_KEY, store);
}

export function unsetChatPluginVar(name: string, scope: ChatPluginVarScope, targetId?: string): void {
    const store = loadVarStore();
    const bucket = varBucket(store, scope, targetId);
    if (bucket && name in bucket) {
        delete bucket[name];
        writeJson(VARS_KEY, store);
    }
}

// ── 持久提示词片段 ─────────────────────────────────────────

const GLOBAL_FRAGMENT_KEY = "__global__";

export function setChatPluginPromptFragment(pluginId: string, text: string, sessionId?: string): void {
    const store = readJson<Record<string, Record<string, string>>>(FRAGMENTS_KEY, {});
    store[pluginId] = store[pluginId] || {};
    const key = sessionId || GLOBAL_FRAGMENT_KEY;
    if (text.trim()) store[pluginId][key] = text;
    else delete store[pluginId][key];
    writeJson(FRAGMENTS_KEY, store);
}

/** 聚合启用插件在该会话生效的持久片段（prompt.system transform 的 hint 初值） */
export function buildChatPluginPromptFragments(sessionId?: string): string {
    const enabledIds = new Set(loadChatPlugins().filter(p => p.enabled).map(p => p.manifest.id));
    if (enabledIds.size === 0) return "";
    const store = readJson<Record<string, Record<string, string>>>(FRAGMENTS_KEY, {});
    const blocks: string[] = [];
    for (const [pluginId, byScope] of Object.entries(store)) {
        if (!enabledIds.has(pluginId)) continue;
        const text = (sessionId && byScope[sessionId]) || byScope[GLOBAL_FRAGMENT_KEY];
        if (text?.trim()) blocks.push(text.trim());
    }
    return blocks.join("\n\n");
}

// ── 插件私有数据桶 ─────────────────────────────────────────

export function readChatPluginData(pluginId: string): Record<string, unknown> {
    return readJson<Record<string, unknown>>(DATA_PREFIX + pluginId, {});
}

export function writeChatPluginData(pluginId: string, data: Record<string, unknown>): void {
    writeJson(DATA_PREFIX + pluginId, data);
}

// ── 错误日志与自动禁用 ─────────────────────────────────────

export function loadChatPluginErrors(): ChatPluginErrorEntry[] {
    return readJson<ChatPluginErrorEntry[]>(ERRORS_KEY, []);
}

export function clearChatPluginErrors(): void {
    kvRemove(ERRORS_KEY);
    emit(CHAT_PLUGIN_ERROR_EVENT);
}

export function recordChatPluginLog(entry: Omit<ChatPluginErrorEntry, "at">): void {
    const list = loadChatPluginErrors();
    list.push({ ...entry, at: new Date().toISOString() });
    while (list.length > MAX_ERROR_ENTRIES) list.shift();
    writeJson(ERRORS_KEY, list);
    emit(CHAT_PLUGIN_ERROR_EVENT, entry);
}
