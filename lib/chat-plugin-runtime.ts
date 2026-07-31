"use client";

// lib/chat-plugin-runtime.ts
// 聊天插件系统 · 运行时：加载执行、免刷新启停、ctx 构建、UI 坑位注册表、安全模式。
//
// 方案 B：插件与宿主同环境直接执行。运行时的职责是把"自由"工程化：
//  - 所有注册型 API 返回 Disposable 且自动归集，禁用 = 全部反注册，无需刷新
//  - 任何插件异常都被归因、记录、计数，连续失败自动禁用（见 chat-plugin-hooks）
//  - 连续两次启动未完成（插件把页面搞崩）自动进入安全模式，跳过全部插件
//  - URL 加 ?plugin-safe-mode=1 手动进入安全模式（逃生舱）

import { kvGet, kvSet, kvRemove, hydrateKvDb } from "./kv-db";
import { hydrateChatStorage, loadChatMessages, loadChatSessions, loadChatContacts, pushChatMessage, updateChatMessage, type ChatMessage } from "./chat-storage";
import { isMediaStoreRef, loadMediaBlob } from "./media-cache-storage";
import { loadCharacters } from "./character-storage";
import { loadApiConfigs, loadBindingConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { getChatPluginHookBus } from "./chat-plugin-hooks";
import { loadChatPluginModule } from "./chat-plugin-loader";
import {
    CHAT_PLUGINS_CHANGED_EVENT,
    getChatPluginVar,
    setChatPluginVar,
    unsetChatPluginVar,
    loadChatPlugins,
    readChatPluginData,
    writeChatPluginData,
    recordChatPluginLog,
    setChatPluginPromptFragment,
    updateChatPluginSettings,
} from "./chat-plugin-storage";
import type {
    ChatPluginContext,
    ChatPluginMessageAction,
    ChatPluginMessageKindRenderer,
    ChatPluginSlotMount,
    ChatPluginSlotName,
    ChatPluginSlotProps,
    Disposable,
    InstalledChatPlugin,
} from "./chat-plugin-types";
import { CHAT_PLUGIN_API_VERSION } from "./chat-plugin-types";

/** 插件 toast（chat-room 等 UI 层监听展示） */
export const CHAT_PLUGIN_TOAST_EVENT = "chat-plugin-toast";
/** 坑位注册变化（PluginSlot 据此重挂载） */
export const CHAT_PLUGIN_SLOTS_CHANGED_EVENT = "chat-plugin-slots-changed";

const SAFE_MODE_KEY = "chat_plugins_safe_mode";
const BOOT_GUARD_KEY = "chat_plugins_boot_guard";

type ActivePlugin = {
    installed: InstalledChatPlugin;
    disposables: Disposable[];
    settingsListeners: Set<(settings: Record<string, unknown>) => void>;
    lastSettingsJson: string;
};

type SlotRegistration = { pluginId: string; mount: ChatPluginSlotMount };

function emitDom(eventName: string, detail?: unknown) {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
}

export function isChatPluginSafeMode(): boolean {
    if (typeof window === "undefined") return false;
    try {
        if (new URLSearchParams(window.location.search).has("plugin-safe-mode")) return true;
    } catch { /* ignore */ }
    return kvGet(SAFE_MODE_KEY) === "1";
}

export function setChatPluginSafeMode(on: boolean): void {
    if (on) kvSet(SAFE_MODE_KEY, "1");
    else kvRemove(SAFE_MODE_KEY);
}

class ChatPluginRuntime {
    private active = new Map<string, ActivePlugin>();
    private slots = new Map<ChatPluginSlotName, SlotRegistration[]>();
    private messageActions = new Map<string, ChatPluginMessageAction[]>();
    private messageKinds = new Map<string, { pluginId: string; renderer: ChatPluginMessageKindRenderer }>();
    private busTopics = new Map<string, Set<{ pluginId: string; fn: (data: unknown) => void }>>();
    private toastSeq = 0;
    private slotsVersion = 0;
    private slotSubscribers = new Set<() => void>();
    private startPromise: Promise<void> | null = null;
    private started = false;
    private reloading = Promise.resolve();

    /** 幂等启动：应用启动时由 ChatPluginBootstrap 调用一次 */
    ensureStarted(): Promise<void> {
        if (typeof window === "undefined") return Promise.resolve();
        if (!this.startPromise) this.startPromise = this.start();
        return this.startPromise;
    }

    isStarted(): boolean { return this.started; }

    activePluginIds(): string[] { return [...this.active.keys()]; }

    private async start(): Promise<void> {
        await Promise.allSettled([hydrateKvDb(), hydrateChatStorage()]);

        if (isChatPluginSafeMode()) {
            recordChatPluginLog({ pluginId: "*", where: "runtime", message: "安全模式：已跳过全部插件加载", level: "info" });
            this.finishStart();
            return;
        }
        // 崩溃循环保护：连续三次启动未走完插件加载 → 自动进入安全模式。
        // 正常关闭页面（pagehide）会清除计数，避免 iOS 快速开关 App 误触发。
        window.addEventListener("pagehide", () => kvRemove(BOOT_GUARD_KEY));
        const guard = Number(kvGet(BOOT_GUARD_KEY) || "0");
        if (guard >= 3) {
            setChatPluginSafeMode(true);
            kvRemove(BOOT_GUARD_KEY);
            recordChatPluginLog({
                pluginId: "*", where: "runtime", level: "error",
                message: "检测到连续多次启动中断，疑似插件导致崩溃，已自动进入安全模式。可在插件管理页退出安全模式。",
            });
            emitDom(CHAT_PLUGIN_TOAST_EVENT, { text: "插件疑似导致崩溃，已进入安全模式" });
            this.finishStart();
            return;
        }
        kvSet(BOOT_GUARD_KEY, String(guard + 1));

        const bus = getChatPluginHookBus();
        bus.onAutoDisable = (pluginId) => { void this.stopPlugin(pluginId); };

        for (const installed of loadChatPlugins()) {
            if (installed.enabled) await this.startPlugin(installed);
        }
        kvRemove(BOOT_GUARD_KEY);
        this.finishStart();
        bus.emitEvent("app.ready", {});
    }

    private finishStart(): void {
        this.started = true;
        window.addEventListener(CHAT_PLUGINS_CHANGED_EVENT, () => {
            this.reloading = this.reloading.then(() => this.applyPluginListChange());
        });
    }

    /** 对齐"存储里的启用集合"与"内存里的运行集合"（免刷新启停/覆盖安装/设置变更） */
    private async applyPluginListChange(): Promise<void> {
        const installedList = loadChatPlugins();
        const wanted = new Map(installedList.filter(p => p.enabled).map(p => [p.manifest.id, p]));
        if (isChatPluginSafeMode()) return;

        for (const id of [...this.active.keys()]) {
            if (!wanted.has(id)) await this.stopPlugin(id);
        }
        for (const [id, installed] of wanted) {
            const running = this.active.get(id);
            if (!running) {
                await this.startPlugin(installed);
                continue;
            }
            if (running.installed.code !== installed.code) {
                // 覆盖安装：停旧起新
                await this.stopPlugin(id);
                await this.startPlugin(installed);
                continue;
            }
            const settingsJson = JSON.stringify(installed.settings ?? {});
            if (settingsJson !== running.lastSettingsJson) {
                running.lastSettingsJson = settingsJson;
                running.installed = installed;
                for (const fn of running.settingsListeners) {
                    try { fn(installed.settings ?? {}); } catch (e) {
                        recordChatPluginLog({ pluginId: id, where: "settings.onChange", message: e instanceof Error ? e.message : String(e), level: "error" });
                    }
                }
            } else {
                running.installed = installed;
            }
        }
        getChatPluginHookBus().emitEvent("plugins.changed", {});
        // 全部插件（重）加载完成后再补发一次坑位变更：安装/启用是异步的，插件 setup 里
        // 注册坑位时管理页的 ChatPluginSlot 可能还没挂好监听、漏掉那次事件；这里在
        // 加载完成、UI 早已渲染就位后再发一次，确保 settings.section 等坑位稳定显示。
        this.notifySlotsChanged();
    }

    private async startPlugin(installed: InstalledChatPlugin): Promise<void> {
        const pluginId = installed.manifest.id;
        if (this.active.has(pluginId)) return;
        const { module, error } = await loadChatPluginModule(installed.code);
        if (!module) {
            recordChatPluginLog({ pluginId, where: "setup", message: error ?? "加载失败", level: "error" });
            return;
        }
        if (module.manifest.id !== pluginId) {
            recordChatPluginLog({ pluginId, where: "setup", message: `源码内 manifest.id（${module.manifest.id}）与安装记录不一致，已拒绝加载`, level: "error" });
            return;
        }
        const activePlugin: ActivePlugin = {
            installed,
            disposables: [],
            settingsListeners: new Set(),
            lastSettingsJson: JSON.stringify(installed.settings ?? {}),
        };
        this.active.set(pluginId, activePlugin);
        try {
            const ctx = this.buildCtx(activePlugin);
            const cleanup = await module.setup(ctx);
            if (typeof cleanup === "function") activePlugin.disposables.push(cleanup);
        } catch (e) {
            recordChatPluginLog({ pluginId, where: "setup", message: e instanceof Error ? e.message : String(e), level: "error" });
            await this.stopPlugin(pluginId);
        }
    }

    private async stopPlugin(pluginId: string): Promise<void> {
        const activePlugin = this.active.get(pluginId);
        if (!activePlugin) return;
        this.active.delete(pluginId);
        for (const dispose of [...activePlugin.disposables].reverse()) {
            try { dispose(); } catch { /* 清理失败不阻塞 */ }
        }
        activePlugin.disposables.length = 0;
        activePlugin.settingsListeners.clear();
        getChatPluginHookBus().removePlugin(pluginId);
        this.notifySlotsChanged();
    }

    // ── 坑位变更通知：版本号 + 订阅回调 + window 事件三管齐下 ──
    // 版本号供 useSyncExternalStore 订阅：订阅瞬间自动补读当前版本，
    // 彻底消除"注册发生在监听挂载之前、事件被漏掉"的时序问题（iOS 上尤其常见）。
    private notifySlotsChanged(): void {
        this.slotsVersion += 1;
        for (const cb of [...this.slotSubscribers]) {
            try { cb(); } catch { /* 订阅方异常不影响运行时 */ }
        }
        emitDom(CHAT_PLUGIN_SLOTS_CHANGED_EVENT);
    }

    getSlotsVersion(): number { return this.slotsVersion; }

    /** 稳定绑定（箭头属性），可直接作 useSyncExternalStore 的 subscribe */
    subscribeSlotsChanged = (cb: () => void): (() => void) => {
        this.slotSubscribers.add(cb);
        return () => { this.slotSubscribers.delete(cb); };
    };

    // ── UI 注册表查询（供 PluginSlot / message-bubble / 菜单使用） ──

    getSlotRegistrations(name: ChatPluginSlotName, pluginId?: string): SlotRegistration[] {
        const all = this.slots.get(name) ?? [];
        return pluginId ? all.filter(r => r.pluginId === pluginId) : all;
    }

    /** 把某坑位上（可按插件过滤的）注册挂载到容器内（每插件一个子节点），返回统一清理函数 */
    mountSlot(name: ChatPluginSlotName, container: HTMLElement, props: ChatPluginSlotProps, pluginId?: string): Disposable {
        const cleanups: Disposable[] = [];
        for (const { pluginId: regPluginId, mount } of this.getSlotRegistrations(name, pluginId)) {
            const el = document.createElement("div");
            el.dataset.chatPlugin = regPluginId;
            container.appendChild(el);
            try {
                const cleanup = mount(el, props);
                cleanups.push(() => {
                    try { if (typeof cleanup === "function") cleanup(); } catch { /* ignore */ }
                    el.remove();
                });
            } catch (e) {
                el.remove();
                recordChatPluginLog({ pluginId: regPluginId, where: `slot:${name}`, message: e instanceof Error ? e.message : String(e), level: "error" });
            }
        }
        return () => { for (const c of [...cleanups].reverse()) c(); };
    }

    getMessageActions(msg: ChatMessage): (ChatPluginMessageAction & { pluginId: string })[] {
        const result: (ChatPluginMessageAction & { pluginId: string })[] = [];
        for (const [pluginId, actions] of this.messageActions) {
            for (const action of actions) {
                try {
                    if (!action.filter || action.filter(msg)) result.push({ ...action, pluginId });
                } catch { /* filter 报错按不显示处理 */ }
            }
        }
        return result;
    }

    runMessageAction(action: ChatPluginMessageAction & { pluginId: string }, msg: ChatMessage): void {
        const helpers = {
            updateMessage: (patch: Partial<ChatMessage>) => {
                updateChatMessage(msg.id, patch as Partial<Pick<ChatMessage, "content" | "mediaType" | "mediaUrl" | "mediaData">>);
            },
            toast: (text: string) => emitDom(CHAT_PLUGIN_TOAST_EVENT, { text }),
        };
        try {
            const result = action.onSelect(msg, helpers);
            if (result instanceof Promise) {
                result.catch(e => recordChatPluginLog({ pluginId: action.pluginId, where: `messageAction:${action.id}`, message: e instanceof Error ? e.message : String(e), level: "error" }));
            }
        } catch (e) {
            recordChatPluginLog({ pluginId: action.pluginId, where: `messageAction:${action.id}`, message: e instanceof Error ? e.message : String(e), level: "error" });
        }
    }

    getMessageKindRenderer(kind: string): { pluginId: string; renderer: ChatPluginMessageKindRenderer } | null {
        return this.messageKinds.get(kind) ?? null;
    }

    // ── ctx 构建 ─────────────────────────────────────────

    private buildCtx(activePlugin: ActivePlugin): ChatPluginContext {
        const pluginId = activePlugin.installed.manifest.id;
        const bus = getChatPluginHookBus();
        const track = (dispose: Disposable): Disposable => {
            let done = false;
            const once: Disposable = () => {
                if (done) return;
                done = true;
                dispose();
            };
            activePlugin.disposables.push(once);
            return once;
        };

        const ctx: ChatPluginContext = {
            meta: {
                id: pluginId,
                name: activePlugin.installed.manifest.name,
                version: activePlugin.installed.manifest.version,
                hostApiVersion: CHAT_PLUGIN_API_VERSION,
            },

            hooks: {
                transform: (point, fn, opts) =>
                    track(bus.registerTransform(pluginId, point, fn as (payload: unknown) => unknown, opts?.priority, opts?.timeoutMs)),
                on: (point, fn) =>
                    track(bus.registerEvent(pluginId, point, fn as (payload: unknown) => unknown)),
            },

            data: {
                messages: {
                    list: (sessionId) => loadChatMessages(sessionId),
                    push: (input) => pushChatMessage(input as Parameters<typeof pushChatMessage>[0]),
                    update: (id, patch) => {
                        updateChatMessage(id, patch as Partial<Pick<ChatMessage, "content" | "mediaType" | "mediaUrl" | "mediaData">>);
                    },
                    resolveMedia: (msg) => resolveChatMessageMedia(msg),
                },
                sessions: {
                    list: () => loadChatSessions(),
                    get: (id) => loadChatSessions().find(s => s.id === id) ?? null,
                },
                contacts: { list: () => loadChatContacts() },
                characters: {
                    list: () => loadCharacters(),
                    get: (id) => loadCharacters().find(c => c.id === id) ?? null,
                },
                variables: {
                    get: (name, scope = "global", targetId) => getChatPluginVar(name, scope, targetId),
                    set: (name, value, scope = "global", targetId) => setChatPluginVar(name, value, scope, targetId),
                    update: (name, patch, scope = "global", targetId) => {
                        const current = getChatPluginVar(name, scope, targetId);
                        const base = current && typeof current === "object" && !Array.isArray(current)
                            ? current as Record<string, unknown> : {};
                        const next = { ...base, ...patch };
                        setChatPluginVar(name, next, scope, targetId);
                        return next;
                    },
                    unset: (name, scope = "global", targetId) => unsetChatPluginVar(name, scope, targetId),
                },
            },

            ai: {
                chat: async ({ prompt, system, temperature, maxTokens }) => {
                    const configs = loadApiConfigs();
                    const defaultId = loadBindingConfig().globalDefaults.apiConfigId;
                    const config = (defaultId ? configs.find(c => c.id === defaultId) : undefined) ?? configs[0];
                    if (!config) throw new Error("尚未配置任何 LLM API，请先到 设置 → API 设置 添加");
                    const messages: { role: string; content: string }[] = [];
                    if (system?.trim()) messages.push({ role: "system", content: system });
                    messages.push({ role: "user", content: prompt });
                    const result = await simpleLLMCall(config, messages, { temperature, max_tokens: maxTokens });
                    if (result.error) throw new Error(result.error);
                    return result.content ?? "";
                },
            },

            prompts: {
                set: (text, opts) => setChatPluginPromptFragment(pluginId, text, opts?.sessionId),
                clear: (opts) => setChatPluginPromptFragment(pluginId, "", opts?.sessionId),
            },

            ui: {
                toast: (text, opts) => {
                    const id = `t_${++this.toastSeq}`;
                    emitDom(CHAT_PLUGIN_TOAST_EVENT, { id, text: String(text), durationMs: opts?.durationMs });
                    return { close: () => emitDom(CHAT_PLUGIN_TOAST_EVENT, { id, text: "", close: true }) };
                },
                slot: (name, mount) => {
                    const registration: SlotRegistration = { pluginId, mount };
                    const list = this.slots.get(name) ?? [];
                    list.push(registration);
                    this.slots.set(name, list);
                    this.notifySlotsChanged();
                    return track(() => {
                        const cur = this.slots.get(name);
                        if (cur) {
                            const idx = cur.indexOf(registration);
                            if (idx >= 0) cur.splice(idx, 1);
                        }
                        this.notifySlotsChanged();
                    });
                },
                messageAction: (action) => {
                    const list = this.messageActions.get(pluginId) ?? [];
                    list.push(action);
                    this.messageActions.set(pluginId, list);
                    return track(() => {
                        const cur = this.messageActions.get(pluginId);
                        if (cur) {
                            const idx = cur.indexOf(action);
                            if (idx >= 0) cur.splice(idx, 1);
                        }
                    });
                },
                messageKind: (kind, renderer) => {
                    const key = kind.trim();
                    const existing = this.messageKinds.get(key);
                    if (existing && existing.pluginId !== pluginId) {
                        recordChatPluginLog({ pluginId, where: `messageKind:${key}`, message: `消息类型 "${key}" 已被插件 ${existing.pluginId} 注册，本次注册被忽略`, level: "error" });
                        return () => { /* 未注册成功，无需清理 */ };
                    }
                    this.messageKinds.set(key, { pluginId, renderer });
                    return track(() => {
                        const cur = this.messageKinds.get(key);
                        if (cur?.pluginId === pluginId) this.messageKinds.delete(key);
                    });
                },
                injectCSS: (css) => {
                    const style = document.createElement("style");
                    style.dataset.chatPlugin = pluginId;
                    style.textContent = css;
                    document.head.appendChild(style);
                    return track(() => style.remove());
                },
                openModal: (mount) => {
                    const overlay = document.createElement("div");
                    overlay.dataset.chatPlugin = pluginId;
                    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45)";
                    const content = document.createElement("div");
                    // 默认卡片外观，插件可在 mount 里覆盖任意样式
                    content.style.cssText = "background:var(--c-card-bg,#fff);color:var(--c-text,#111);border-radius:16px;width:min(560px,100%);max-height:88vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.28)";
                    overlay.appendChild(content);
                    let userCleanup: Disposable | void;
                    const doClose = () => {
                        try { if (typeof userCleanup === "function") userCleanup(); } catch { /* ignore */ }
                        overlay.remove();
                    };
                    const close = track(doClose); // once-guard + 插件禁用时自动关闭
                    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
                    document.body.appendChild(overlay);
                    try {
                        userCleanup = mount(content, { close });
                    } catch (e) {
                        recordChatPluginLog({ pluginId, where: "openModal", message: e instanceof Error ? e.message : String(e), level: "error" });
                        close();
                    }
                    return { close };
                },
            },

            system: {
                storage: {
                    get: <T,>(key: string): T | null => {
                        const data = readChatPluginData(pluginId);
                        return (key in data ? data[key] : null) as T | null;
                    },
                    set: (key, value) => {
                        const data = readChatPluginData(pluginId);
                        data[key] = value;
                        writeChatPluginData(pluginId, data);
                    },
                    remove: (key) => {
                        const data = readChatPluginData(pluginId);
                        if (key in data) {
                            delete data[key];
                            writeChatPluginData(pluginId, data);
                        }
                    },
                    keys: () => Object.keys(readChatPluginData(pluginId)),
                },
                timers: {
                    setTimeout: (fn, ms) => {
                        const id = window.setTimeout(() => {
                            try { fn(); } catch (e) {
                                recordChatPluginLog({ pluginId, where: "timers.setTimeout", message: e instanceof Error ? e.message : String(e), level: "error" });
                            }
                        }, ms);
                        return track(() => window.clearTimeout(id));
                    },
                    setInterval: (fn, ms) => {
                        const id = window.setInterval(() => {
                            try { fn(); } catch (e) {
                                recordChatPluginLog({ pluginId, where: "timers.setInterval", message: e instanceof Error ? e.message : String(e), level: "error" });
                            }
                        }, Math.max(200, ms));
                        return track(() => window.clearInterval(id));
                    },
                },
                bus: {
                    emit: (topic, data) => {
                        for (const sub of this.busTopics.get(topic) ?? []) {
                            try { sub.fn(data); } catch (e) {
                                recordChatPluginLog({ pluginId: sub.pluginId, where: `bus:${topic}`, message: e instanceof Error ? e.message : String(e), level: "error" });
                            }
                        }
                    },
                    on: (topic, fn) => {
                        const set = this.busTopics.get(topic) ?? new Set();
                        const sub = { pluginId, fn };
                        set.add(sub);
                        this.busTopics.set(topic, set);
                        return track(() => { this.busTopics.get(topic)?.delete(sub); });
                    },
                },
                fetch: typeof window !== "undefined" ? window.fetch.bind(window) : fetch,
                settings: {
                    get: <T,>(key: string): T | undefined => {
                        const installed = loadChatPlugins().find(p => p.manifest.id === pluginId);
                        return installed?.settings?.[key] as T | undefined;
                    },
                    all: () => {
                        const installed = loadChatPlugins().find(p => p.manifest.id === pluginId);
                        return { ...(installed?.settings ?? {}) };
                    },
                    set: (key, value) => {
                        updateChatPluginSettings(pluginId, { [key]: value });
                    },
                    onChange: (fn) => {
                        activePlugin.settingsListeners.add(fn);
                        return track(() => activePlugin.settingsListeners.delete(fn));
                    },
                },
                log: (...args) => {
                    // eslint-disable-next-line no-console
                    console.log(`[chat-plugin:${pluginId}]`, ...args);
                    recordChatPluginLog({
                        pluginId,
                        where: "log",
                        message: args.map(a => typeof a === "string" ? a : safeStringify(a)).join(" ").slice(0, 500),
                        level: "info",
                    });
                },
            },
        };
        return ctx;
    }
}

function safeStringify(value: unknown): string {
    try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

function guessMediaCategory(msg: ChatMessage): string {
    if (msg.mediaType === "image" || msg.mediaType === "sticker") return "image";
    if (msg.mediaType === "audio") return "audio";
    if (msg.mediaType === "video") return "video";
    if (msg.mediaType === "media_file") return msg.mediaData?.fileType || "file";
    return "file";
}

/**
 * 把消息的二进制媒体解析成真实字节。图片/语音/视频/文件都把引用存在 msg.mediaUrl
 * （mediastore:// 引用 或 普通 http/data URL）。表情包用 mediaData.stickerUrl。
 */
async function resolveChatMessageMedia(msg: ChatMessage): Promise<{ dataURL: string; blob: Blob | null; mimeType: string; category: string } | null> {
    const ref = msg.mediaUrl || msg.mediaData?.stickerUrl || "";
    if (!ref) return null;
    const category = guessMediaCategory(msg);
    // 已经是 data: URL，直接可用
    if (ref.startsWith("data:")) {
        const mimeType = ref.slice(5, ref.indexOf(";") >= 0 ? ref.indexOf(";") : 5) || "application/octet-stream";
        let blob: Blob | null = null;
        try { blob = await (await fetch(ref)).blob(); } catch { /* ignore */ }
        return { dataURL: ref, blob, mimeType, category };
    }
    // mediastore:// 引用，从统一媒体仓库取
    if (isMediaStoreRef(ref)) {
        const media = await loadMediaBlob(ref);
        if (!media) return null;
        const dataURL = await blobToDataURL(media.blob);
        return { dataURL, blob: media.blob, mimeType: media.mimeType, category: media.category || category };
    }
    // 普通 http(s) URL：尝试取字节；取不到（跨域等）也把 URL 作为 dataURL 返回，
    // 视觉 API 通常也能直接吃图片 URL。
    try {
        const blob = await (await fetch(ref)).blob();
        const dataURL = await blobToDataURL(blob);
        return { dataURL, blob, mimeType: blob.type || "application/octet-stream", category };
    } catch {
        return { dataURL: ref, blob: null, mimeType: "", category };
    }
}

// 单例存到 globalThis：Next.js 的 "use client" 边界可能把本模块打进多个 chunk，
// 模块级变量会各存一份，导致插件注册进 A 实例、UI 读 B 实例（坑位不渲染）。
// 挂到 globalThis 保证跨 chunk 唯一。
const RUNTIME_KEY = "__aiPhoneChatPluginRuntime";
export function getChatPluginRuntime(): ChatPluginRuntime {
    const g = globalThis as unknown as Record<string, ChatPluginRuntime | undefined>;
    if (!g[RUNTIME_KEY]) g[RUNTIME_KEY] = new ChatPluginRuntime();
    return g[RUNTIME_KEY]!;
}
