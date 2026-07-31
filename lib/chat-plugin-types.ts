// lib/chat-plugin-types.ts
// 聊天插件系统 · 契约层（apiVersion 1）
//
// 插件 = 一段 ES Module 源码（方案 B：与宿主同环境直接执行，无沙箱），形如：
//
//   export default {
//     manifest: { id: "my-plugin", name: "我的插件", apiVersion: 1 },
//     setup(ctx) {
//       const off = ctx.hooks.transform("llm.response", async (p) => { ...; return p; });
//       return () => off();   // 可选：返回额外清理函数
//     },
//   };
//
// 契约稳定性承诺：本文件里出现的 API 形状即 apiVersion 1 的全部承诺面，
// 只加不改；破坏性变更必须升 apiVersion 并保留旧版本兼容分发。
// 所有注册型 API 一律返回 Disposable —— 宿主据此实现免刷新启停插件。

import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";
import type { Character } from "./character-types";

/** 反注册函数：撤销对应的注册动作 */
export type Disposable = () => void;

export const CHAT_PLUGIN_API_VERSION = 1;

// ── manifest ──────────────────────────────────────────────

export type ChatPluginSettingField = {
    key: string;
    label: string;
    type: "text" | "number" | "boolean" | "select";
    default?: string | number | boolean;
    /** type === "select" 时的选项 */
    options?: { value: string; label: string }[];
    description?: string;
};

export type ChatPluginManifest = {
    /** 2~64 位字母/数字/横线/下划线/点，全局唯一 */
    id: string;
    name: string;
    /** 插件面向的契约版本，当前宿主为 1；不兼容时拒绝加载并明确报错 */
    apiVersion: number;
    version?: string;
    author?: string;
    description?: string;
    /**
     * 诚信披露用途声明（方案 B 下无技术强制力，管理页展示给用户）。
     * 约定值示例："chat.read" "chat.write" "ai" "network" "ui" "storage"
     */
    permissions?: string[];
    /** 声明后宿主在管理页自动渲染设置表单，插件经 ctx.system.settings 读取 */
    settings?: ChatPluginSettingField[];
};

export type ChatPluginModule = {
    manifest: ChatPluginManifest;
    /** 启用时调用；返回的函数会在禁用/卸载时执行（与各 Disposable 一并清理） */
    setup: (ctx: ChatPluginContext) => void | Disposable | Promise<void | Disposable>;
};

// ── 管线：transform（瀑布式，可修改）与 event（只读广播） ──

/**
 * 异步 transform 点（handler 可为 async，按 priority 升序串行，前一个的返回值是后一个的输入）：
 *   user.beforeSend   用户消息落库前。payload.text 可改写；cancelled=true 则取消发送
 *   prompt.system     单聊/群聊系统提示词组装时。payload.hint 追加/改写扩展提示词区
 *   llm.request       每次请求体发出前（含流式/工具通道）。可改 messages/model/temperature
 *   llm.response      模型原始回复文本落地前（正则式改写在这里做）
 * 同步 transform 点（handler 必须同步返回，返回 Promise 会被忽略并记一次警告）：
 *   message.beforePersist  任何消息写入存储前（用户/角色/系统/群聊全路径）
 */
export type ChatPluginTransformPoint =
    | "user.beforeSend"
    | "prompt.system"
    | "llm.request"
    | "llm.response"
    | "message.beforePersist";

export type UserBeforeSendPayload = {
    text: string;
    sessionId: string;
    isGroup: boolean;
    /** 置为 true 取消这次发送 */
    cancelled: boolean;
};

export type PromptSystemPayload = {
    sessionId: string;
    isGroup: boolean;
    characterId?: string;
    /** 扩展提示词区：初值为各插件持久片段（ctx.prompts）聚合，可继续追加/改写 */
    hint: string;
};

export type LlmRequestPayload = {
    /** 即将发送的完整 messages 数组（OpenAI 形状 {role, content}），可增删改 */
    messages: { role: string; content: unknown;[k: string]: unknown }[];
    /** 请求用途：appId（"chat" 单聊等）；群聊等场景可结合 sessionId 自查 session.isGroup */
    purpose: string;
    sessionId?: string;
    /** 采样参数改写（留空则用用户配置；仅在该次请求带预设时生效） */
    temperature?: number;
    maxTokens?: number;
};

export type LlmResponsePayload = {
    /** 模型原始回复文本（内置正则处理之前），可改写 */
    text: string;
    sessionId?: string;
    purpose: string;
};

export type MessageBeforePersistPayload = {
    message: ChatMessage;
};

export type ChatPluginTransformPayloadMap = {
    "user.beforeSend": UserBeforeSendPayload;
    "prompt.system": PromptSystemPayload;
    "llm.request": LlmRequestPayload;
    "llm.response": LlmResponsePayload;
    "message.beforePersist": MessageBeforePersistPayload;
};

/**
 * 事件点（只读广播，handler 可为 async，异常不影响宿主与其他插件）：
 *   app.ready          插件全部加载完成（每次运行时构建后触发一次）
 *   session.opened     进入聊天界面
 *   message.persisted  消息已落库（含用户/角色/系统全路径）
 *   message.updated    消息被修改
 *   message.deleted    消息被删除
 *   llm.streamChunk    流式分片（高频，勿做重活）
 *   plugins.changed    插件列表/启停状态变化
 */
export type ChatPluginEventPoint =
    | "app.ready"
    | "session.opened"
    | "message.persisted"
    | "message.updated"
    | "message.deleted"
    | "llm.streamChunk"
    | "plugins.changed";

export type ChatPluginEventPayloadMap = {
    "app.ready": Record<string, never>;
    "session.opened": { sessionId: string; isGroup: boolean };
    "message.persisted": { message: ChatMessage };
    "message.updated": { id: string; patch: Partial<ChatMessage> };
    "message.deleted": { id: string; sessionId?: string };
    "llm.streamChunk": { chunk: string; sessionId?: string; purpose: string };
    "plugins.changed": Record<string, never>;
};

// ── UI 坑位 ────────────────────────────────────────────────

/**
 * DOM 坑位：宿主把一个 React 不管辖的裸 HTMLElement 交给插件，插件自由渲染。
 *   chat.header        聊天室标题栏下方（每会话一个）
 *   chat.inputToolbar  输入栏"+"扩展面板内（插件工具按钮区）
 *   message.footer     每条文本消息气泡下方
 *   settings.section   插件管理页内该插件的自定义设置区
 */
export type ChatPluginSlotName =
    | "chat.header"
    | "chat.inputToolbar"
    | "message.footer"
    | "settings.section";

export type ChatPluginSlotProps = {
    sessionId?: string;
    isGroup?: boolean;
    /** message.footer 坑位携带当前消息 */
    message?: ChatMessage;
};

export type ChatPluginSlotMount = (
    el: HTMLElement,
    props: ChatPluginSlotProps,
) => Disposable | void;

/** 消息长按/操作菜单的插件菜单项 */
export type ChatPluginMessageAction = {
    id: string;
    label: string;
    /** 仅对满足条件的消息显示（缺省全部显示） */
    filter?: (msg: ChatMessage) => boolean;
    onSelect: (msg: ChatMessage, helpers: {
        updateMessage: (patch: Partial<ChatMessage>) => void;
        toast: (text: string) => void;
    }) => void | Promise<void>;
};

/** 自定义消息类型渲染器：消息 mediaType === `plugin:<kind>` 时由该插件渲染气泡 */
export type ChatPluginMessageKindRenderer = (
    el: HTMLElement,
    msg: ChatMessage,
) => Disposable | void;

// ── 变量（跨插件共享的世界状态；插件私有数据请用 ctx.system.storage） ──

export type ChatPluginVarScope = "session" | "character" | "global";

// ── ctx：注入给 setup 的完整宿主 API ─────────────────────────

export type ChatPluginContext = {
    meta: {
        id: string;
        name: string;
        version?: string;
        /** 宿主契约版本 */
        hostApiVersion: number;
    };

    hooks: {
        transform<P extends ChatPluginTransformPoint>(
            point: P,
            fn: (payload: ChatPluginTransformPayloadMap[P]) =>
                ChatPluginTransformPayloadMap[P] | Promise<ChatPluginTransformPayloadMap[P]> | void | Promise<void>,
            /** timeoutMs 覆盖该 transform 的超时（默认 8000）；做 OCR/联网等慢活时调大 */
            opts?: { priority?: number; timeoutMs?: number },
        ): Disposable;
        on<P extends ChatPluginEventPoint>(
            point: P,
            fn: (payload: ChatPluginEventPayloadMap[P]) => void | Promise<void>,
        ): Disposable;
    };

    data: {
        messages: {
            list(sessionId: string): ChatMessage[];
            push(input: { sessionId: string; role: "user" | "assistant" | "system"; content: string;[k: string]: unknown }): ChatMessage;
            update(id: string, patch: Partial<ChatMessage>): void;
            /**
             * 把消息的二进制媒体（图片/语音/视频/文件）解析成真实字节。
             * 聊天里的媒体存的是 mediastore:// 引用，无法直接使用；本方法统一解析。
             * 无媒体或解析失败返回 null。category：image/audio/video/file。
             */
            resolveMedia(msg: ChatMessage): Promise<{
                dataURL: string;
                blob: Blob | null;
                mimeType: string;
                category: string;
            } | null>;
        };
        sessions: {
            list(): ChatSession[];
            get(id: string): ChatSession | null;
        };
        contacts: { list(): ChatContact[] };
        characters: {
            list(): Character[];
            get(id: string): Character | null;
        };
        /** 跨插件共享变量池（好感度、心情这类"世界状态"），按作用域隔离 */
        variables: {
            get(name: string, scope?: ChatPluginVarScope, targetId?: string): unknown;
            set(name: string, value: unknown, scope?: ChatPluginVarScope, targetId?: string): void;
            update(name: string, patch: Record<string, unknown>, scope?: ChatPluginVarScope, targetId?: string): Record<string, unknown>;
            unset(name: string, scope?: ChatPluginVarScope, targetId?: string): void;
        };
    };

    ai: {
        /**
         * 裸通道 LLM 调用：直连用户配置的 API，不挂角色、不进聊天记录、不写记忆。
         * 走辅助 API 配置（若用户配置了）否则主配置。
         */
        chat(opts: {
            prompt: string;
            system?: string;
            temperature?: number;
            maxTokens?: number;
        }): Promise<string>;
    };

    /** 持久提示词片段：无需每次事件重设，聚合后注入 prompt.system 的 hint 初值 */
    prompts: {
        /** text 传空串等于清除；sessionId 缺省为全局片段 */
        set(text: string, opts?: { sessionId?: string }): void;
        clear(opts?: { sessionId?: string }): void;
    };

    ui: {
        /**
         * 顶部轻提示。默认约 2.4s 自动消失。
         * 做"进行中/加载"指示时传 { durationMs: 0 } 让它常驻，用返回的 close() 手动关闭。
         */
        toast(text: string, opts?: { durationMs?: number }): { close: () => void };
        /** 认领一个 DOM 坑位 */
        slot(name: ChatPluginSlotName, mount: ChatPluginSlotMount): Disposable;
        /** 注册消息操作菜单项 */
        messageAction(action: ChatPluginMessageAction): Disposable;
        /** 注册自定义消息类型渲染器（mediaType = `plugin:<kind>`） */
        messageKind(kind: string, renderer: ChatPluginMessageKindRenderer): Disposable;
        /** 注入全局 CSS（禁用时自动移除） */
        injectCSS(css: string): Disposable;
        /**
         * 打开一个插件完全掌控的浮层：宿主提供全屏遮罩 + 一块居中的裸容器（默认卡片样式，
         * 可自行覆盖），插件在里面自由渲染任意界面。点遮罩空白处或调 api.close() 关闭；
         * 插件被禁用时自动关闭。mount 可返回清理函数。
         */
        openModal(mount: (el: HTMLElement, api: { close: () => void }) => Disposable | void): { close: () => void };
    };

    system: {
        /** 插件私有 KV 存储（按插件 id 分桶，卸载时随插件清除） */
        storage: {
            get<T = unknown>(key: string): T | null;
            set(key: string, value: unknown): void;
            remove(key: string): void;
            keys(): string[];
        };
        /** 定时器：禁用插件时自动清除 */
        timers: {
            setTimeout(fn: () => void, ms: number): Disposable;
            setInterval(fn: () => void, ms: number): Disposable;
        };
        /** 插件间通信总线 */
        bus: {
            emit(topic: string, data?: unknown): void;
            on(topic: string, fn: (data: unknown) => void): Disposable;
        };
        /** 网络请求（显式提供，便于将来统计与代理） */
        fetch: typeof fetch;
        /** manifest.settings 声明的用户设置 */
        settings: {
            get<T = unknown>(key: string): T | undefined;
            all(): Record<string, unknown>;
            /** 写回自己的设置（如"拉取模型"后把选中的模型填进 model 字段） */
            set(key: string, value: unknown): void;
            onChange(fn: (settings: Record<string, unknown>) => void): Disposable;
        };
        /** 带插件 id 前缀的日志（也进管理页错误日志的 info 级） */
        log(...args: unknown[]): void;
    };
};

// ── 安装态 ────────────────────────────────────────────────

export type InstalledChatPlugin = {
    manifest: ChatPluginManifest;
    /** 插件 ES Module 源码全文 */
    code: string;
    enabled: boolean;
    installedAt: string;
    updatedAt: string;
    /** manifest.settings 对应的用户配置值 */
    settings: Record<string, unknown>;
};

export type ChatPluginErrorEntry = {
    pluginId: string;
    /** 出错位置："setup" | transform/event 点名 | "slot:<name>" 等 */
    where: string;
    message: string;
    level: "error" | "info";
    at: string;
};
