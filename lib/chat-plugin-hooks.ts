// lib/chat-plugin-hooks.ts
// 聊天插件系统 · hook 总线：transform（瀑布式改写）与 event（只读广播）。
// 铁律：任何插件的任何异常都不得打断宿主流程 —— 每次调用独立 try/catch、
// 异步 transform 带超时、错误归因到插件并计数，连续失败自动禁用。

import type {
    ChatPluginEventPayloadMap,
    ChatPluginEventPoint,
    ChatPluginTransformPayloadMap,
    ChatPluginTransformPoint,
    Disposable,
} from "./chat-plugin-types";
import { recordChatPluginLog, setChatPluginEnabled } from "./chat-plugin-storage";

const TRANSFORM_TIMEOUT_MS = 8000;
/** 连续失败达到该次数自动禁用插件（成功一次即清零） */
const AUTO_DISABLE_THRESHOLD = 5;

type AnyFn = (payload: unknown) => unknown;

type HookHandler = {
    pluginId: string;
    fn: AnyFn;
    priority: number;
    seq: number;
    /** transform 专用：覆盖默认超时 */
    timeoutMs?: number;
};

class ChatPluginHookBus {
    private transforms = new Map<string, HookHandler[]>();
    private events = new Map<string, HookHandler[]>();
    private failureCounts = new Map<string, number>();
    private seq = 0;
    /** 运行时注入：自动禁用时同步反注册该插件（避免循环依赖） */
    onAutoDisable: ((pluginId: string) => void) | null = null;

    private add(map: Map<string, HookHandler[]>, point: string, handler: HookHandler): Disposable {
        const list = map.get(point) ?? [];
        list.push(handler);
        list.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
        map.set(point, list);
        return () => {
            const cur = map.get(point);
            if (!cur) return;
            const idx = cur.indexOf(handler);
            if (idx >= 0) cur.splice(idx, 1);
        };
    }

    registerTransform(pluginId: string, point: ChatPluginTransformPoint, fn: AnyFn, priority = 100, timeoutMs?: number): Disposable {
        return this.add(this.transforms, point, { pluginId, fn, priority, seq: ++this.seq, timeoutMs });
    }

    registerEvent(pluginId: string, point: ChatPluginEventPoint, fn: AnyFn, priority = 100): Disposable {
        return this.add(this.events, point, { pluginId, fn, priority, seq: ++this.seq });
    }

    /** 反注册某插件的全部 hook（禁用/卸载时由运行时调用） */
    removePlugin(pluginId: string): void {
        for (const map of [this.transforms, this.events]) {
            for (const [point, list] of map) {
                map.set(point, list.filter(h => h.pluginId !== pluginId));
            }
        }
        this.failureCounts.delete(pluginId);
    }

    hasHandlers(point: ChatPluginTransformPoint | ChatPluginEventPoint): boolean {
        return (this.transforms.get(point)?.length ?? 0) > 0
            || (this.events.get(point)?.length ?? 0) > 0;
    }

    private reportFailure(pluginId: string, where: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        recordChatPluginLog({ pluginId, where, message, level: "error" });
        const count = (this.failureCounts.get(pluginId) ?? 0) + 1;
        this.failureCounts.set(pluginId, count);
        if (count >= AUTO_DISABLE_THRESHOLD) {
            this.failureCounts.delete(pluginId);
            recordChatPluginLog({
                pluginId,
                where: "runtime",
                message: `连续失败 ${AUTO_DISABLE_THRESHOLD} 次，已自动禁用该插件（可在插件管理页重新启用）`,
                level: "error",
            });
            setChatPluginEnabled(pluginId, false);
            this.onAutoDisable?.(pluginId);
        }
    }

    private reportSuccess(pluginId: string): void {
        this.failureCounts.delete(pluginId);
    }

    /**
     * 异步 transform：按 priority 串行，handler 返回新 payload（或原地修改后返回 undefined）。
     * 单个 handler 超时/异常 → 跳过该插件，payload 保持上一步结果。
     */
    async runTransform<P extends ChatPluginTransformPoint>(
        point: P,
        payload: ChatPluginTransformPayloadMap[P],
    ): Promise<ChatPluginTransformPayloadMap[P]> {
        const list = this.transforms.get(point);
        if (!list || list.length === 0) return payload;
        let current = payload;
        for (const handler of [...list]) {
            try {
                const timeout = handler.timeoutMs && handler.timeoutMs > 0 ? handler.timeoutMs : TRANSFORM_TIMEOUT_MS;
                const result = await withTimeout(
                    Promise.resolve(handler.fn(current)),
                    timeout,
                    `${point} 处理超时（${Math.round(timeout / 1000)}s）`,
                );
                if (result !== undefined && result !== null) {
                    current = result as ChatPluginTransformPayloadMap[P];
                }
                this.reportSuccess(handler.pluginId);
            } catch (e) {
                this.reportFailure(handler.pluginId, point, e);
            }
        }
        return current;
    }

    /**
     * 同步 transform（message.beforePersist 用）：handler 必须同步返回；
     * 返回 Promise 视为无效并记警告（宿主同步路径等不了）。
     */
    runTransformSync<P extends ChatPluginTransformPoint>(
        point: P,
        payload: ChatPluginTransformPayloadMap[P],
    ): ChatPluginTransformPayloadMap[P] {
        const list = this.transforms.get(point);
        if (!list || list.length === 0) return payload;
        let current = payload;
        for (const handler of [...list]) {
            try {
                const result = handler.fn(current);
                if (result instanceof Promise) {
                    result.catch(() => { /* 吞掉，避免 unhandled rejection */ });
                    recordChatPluginLog({
                        pluginId: handler.pluginId,
                        where: point,
                        message: `${point} 是同步 transform 点，async handler 的返回值被忽略`,
                        level: "info",
                    });
                    continue;
                }
                if (result !== undefined && result !== null) {
                    current = result as ChatPluginTransformPayloadMap[P];
                }
                this.reportSuccess(handler.pluginId);
            } catch (e) {
                this.reportFailure(handler.pluginId, point, e);
            }
        }
        return current;
    }

    /** 事件广播：fire-and-forget，async handler 的 rejection 也会被归因记录 */
    emitEvent<P extends ChatPluginEventPoint>(point: P, payload: ChatPluginEventPayloadMap[P]): void {
        const list = this.events.get(point);
        if (!list || list.length === 0) return;
        for (const handler of [...list]) {
            try {
                const result = handler.fn(payload);
                if (result instanceof Promise) {
                    result.catch(e => this.reportFailure(handler.pluginId, point, e));
                }
            } catch (e) {
                this.reportFailure(handler.pluginId, point, e);
            }
        }
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); },
        );
    });
}

// 单例存到 globalThis：见 chat-plugin-runtime.ts 同款说明。hook 总线若各 chunk
// 各存一份，会导致 ctx.hooks 注册进 A 实例、管线 transform 读 B 实例（拦截静默失效）。
const HOOK_BUS_KEY = "__aiPhoneChatPluginHookBus";
export function getChatPluginHookBus(): ChatPluginHookBus {
    const g = globalThis as unknown as Record<string, ChatPluginHookBus | undefined>;
    if (!g[HOOK_BUS_KEY]) g[HOOK_BUS_KEY] = new ChatPluginHookBus();
    return g[HOOK_BUS_KEY]!;
}

// ── 织入点辅助（宿主管线调用；SSR/无插件时零开销直通）────────
// 注意：本模块不依赖 chat-storage 的运行时代码，chat-storage 等底层模块
// 可以安全 import 这些辅助函数而不形成循环依赖。

export async function runChatPluginTransform<P extends ChatPluginTransformPoint>(
    point: P,
    payload: ChatPluginTransformPayloadMap[P],
): Promise<ChatPluginTransformPayloadMap[P]> {
    if (typeof window === "undefined") return payload;
    return getChatPluginHookBus().runTransform(point, payload);
}

export function runChatPluginTransformSync<P extends ChatPluginTransformPoint>(
    point: P,
    payload: ChatPluginTransformPayloadMap[P],
): ChatPluginTransformPayloadMap[P] {
    if (typeof window === "undefined") return payload;
    return getChatPluginHookBus().runTransformSync(point, payload);
}

export function emitChatPluginEvent<P extends ChatPluginEventPoint>(
    point: P,
    payload: ChatPluginEventPayloadMap[P],
): void {
    if (typeof window === "undefined") return;
    getChatPluginHookBus().emitEvent(point, payload);
}
