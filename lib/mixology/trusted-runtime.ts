// lib/mixology/trusted-runtime.ts
// 独家特调 · 信任模式机括的运行时。
//
// 沙盒机括（mechanism-runtime / mechanism-panel）跑在断网的 iframe 里，能做的事是一张白名单。
// 信任模式反过来：整段 script 直接在对局页面里执行一次，拿到一个 mix 对象，
// 用它登记坑位（拿裸 DOM 随便画）、登记钩子、读写状态；能自己 fetch、能碰整个页面。
// 和聊天插件同一个思路（插件与宿主同环境执行，安装时明示风险），特调这边装入配方 /
// 入柜 / 导入三处都会先问一句。
//
// 一件机括 × 一个对局一份实例（进对局时建、退出时销毁）；材料被改过要重建。
// 钩子的数据契约与沙盒版完全一致（MixHookPayload / MixHookResult），引擎按 trusted 分流。

import type { MixDialogueState, MixMechanismMaterial, MixState } from "./types";
import { normalizeHookResult, type MixHook, type MixHookPayload, type MixHookResult, type MixMechanismStore } from "./mechanism-protocol";
import type { MixConnectorParams } from "./connectors";

/** 坑位：turn = 每轮 AI 回复下方一块；prose = 每轮正文容器本身（可改 DOM）；float = 悬浮层；bottom = 最新一轮之下 */
export const MIX_TRUSTED_SLOTS = ["turn", "prose", "float", "bottom"] as const;
export type MixTrustedSlotName = (typeof MIX_TRUSTED_SLOTS)[number];

export type MixTrustedSlotProps = {
    /** turn / prose：这一轮的 id 与正文（已过滤网）；float / bottom 没有 */
    turnId?: string;
    text?: string;
    /** turn / prose：这一轮在对局里的序号（0 起） */
    index?: number;
    state: MixState;
    store: MixMechanismStore;
    charName: string;
    userName: string;
};

export type MixTrustedSlotMount = (el: HTMLElement, props: MixTrustedSlotProps) => (() => void) | void;

export type MixTrustedDialogueEvent = { id: string; text: string; turnId?: string };

/** 宿主给实例的能力：全部由对局页提供，实例自己不碰存储 */
export type MixTrustedHost = {
    getState: () => MixState;
    getStore: (materialId: string) => MixMechanismStore;
    setStore: (materialId: string, store: MixMechanismStore) => void;
    setState: (patch: MixState) => void;
    say: (text: string) => void;
    toast: (text: string) => void;
    mark: (materialId: string, id: string, state: MixDialogueState) => void;
    call: (materialId: string, name: string, params: MixConnectorParams) => Promise<{ status: number; data: unknown }>;
    play: (materialId: string, id: string, audio: unknown, type?: string) => void;
    stop: () => void;
    charName: () => string;
    userName: () => string;
};

type HookName = MixHook | "dialogue";

class TrustedInstance {
    readonly slots = new Map<MixTrustedSlotName, MixTrustedSlotMount[]>();
    readonly hooks = new Map<HookName, (payload: unknown) => unknown>();
    /** 坑位登记有变化 / 代码要求重挂时 +1，坑位组件据此重新挂载 */
    version = 0;
    readonly listeners = new Set<() => void>();
    readonly api: Record<string, unknown>;

    constructor(readonly sessionId: string, readonly material: MixMechanismMaterial, readonly host: MixTrustedHost) {
        const materialId = material.id;
        const bump = () => { this.version += 1; for (const fn of this.listeners) fn(); };
        this.api = {
            /** 登记一个坑位：宿主在对应位置给一块裸 DOM，回调里随便画；返回的函数在卸载时调 */
            slot: (name: unknown, mount: unknown) => {
                if (typeof mount !== "function") return;
                const key = String(name) as MixTrustedSlotName;
                if (!(MIX_TRUSTED_SLOTS as readonly string[]).includes(key)) throw new Error(`没有叫 ${String(name)} 的坑位，可选：${MIX_TRUSTED_SLOTS.join(" / ")}`);
                this.slots.set(key, [...(this.slots.get(key) ?? []), mount as MixTrustedSlotMount]);
                bump();
            },
            /** 登记钩子：sessionStart / beforeSend / rawReply / afterReply / sessionEnd（同沙盒契约），以及 dialogue（对白按钮） */
            on: (name: unknown, fn: unknown) => {
                if (typeof fn !== "function") return;
                this.hooks.set(String(name) as HookName, fn as (payload: unknown) => unknown);
            },
            /** 要求全部坑位重新挂载（比如数据变了想整体重画） */
            refresh: () => bump(),
            get state() { return host.getState(); },
            get store() { return host.getStore(materialId); },
            setState: (patch: unknown) => { if (patch && typeof patch === "object") host.setState(patch as MixState); },
            setStore: (store: unknown) => { if (store && typeof store === "object") host.setStore(materialId, store as MixMechanismStore); },
            say: (text: unknown) => host.say(String(text ?? "")),
            toast: (text: unknown) => host.toast(String(text ?? "")),
            mark: (id: unknown, state: unknown) => host.mark(materialId, String(id ?? ""), state === "busy" || state === "playing" ? state : ""),
            call: (name: unknown, params: unknown) => host.call(materialId, String(name ?? ""), (params && typeof params === "object" ? params : {}) as MixConnectorParams),
            play: (id: unknown, audio: unknown, type?: unknown) => host.play(materialId, String(id ?? ""), audio, typeof type === "string" ? type : undefined),
            stop: () => host.stop(),
            get charName() { return host.charName(); },
            get userName() { return host.userName(); },
            materialId,
            sessionId,
        };
    }

    boot(): void {
        const script = this.material.script?.trim();
        if (!script) return;
        try {
            // 与聊天插件同环境执行：整段代码跑一次，之后靠它登记的坑位与钩子工作
            new Function("mix", script)(this.api);
        } catch (err) {
            this.host.toast(`机括「${this.material.name}」启动出错：${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

const instances = new Map<string, TrustedInstance>();
const keyOf = (sessionId: string, materialId: string) => `${sessionId}::${materialId}`;

/** 进对局时建实例（已有且材料没变就复用）；材料被改过（updatedAt 变了）重建 */
export function ensureMixTrusted(sessionId: string, material: MixMechanismMaterial, host: MixTrustedHost): TrustedInstance {
    const key = keyOf(sessionId, material.id);
    const existing = instances.get(key);
    if (existing && existing.material.updatedAt === material.updatedAt && existing.material.script === material.script) return existing;
    if (existing) disposeInstance(existing);
    const instance = new TrustedInstance(sessionId, material, host);
    instances.set(key, instance);
    instance.boot();
    return instance;
}

function disposeInstance(instance: TrustedInstance): void {
    instances.delete(keyOf(instance.sessionId, instance.material.id));
    instance.slots.clear();
    instance.hooks.clear();
    instance.version += 1;
    for (const fn of instance.listeners) fn();
    instance.listeners.clear();
}

export function getMixTrusted(sessionId: string, materialId: string): TrustedInstance | undefined {
    return instances.get(keyOf(sessionId, materialId));
}

/** 退出对局：收掉这一局的全部信任实例 */
export function disposeMixTrusted(sessionId: string): void {
    for (const instance of [...instances.values()]) if (instance.sessionId === sessionId) disposeInstance(instance);
}

/** 材料被改过：旧实例跑的还是老代码，编辑保存时清掉，下次进局重建 */
export function disposeMixTrustedForMaterial(materialId: string): void {
    for (const instance of [...instances.values()]) if (instance.material.id === materialId) disposeInstance(instance);
}

/** 引擎调钩子：与沙盒版同一份数据契约；实例不存在（对局页没挂着）就当没写钩子 */
export async function runMixTrustedHook(sessionId: string, materialId: string, hook: MixHook, payload: MixHookPayload): Promise<MixHookResult> {
    const instance = instances.get(keyOf(sessionId, materialId));
    const fn = instance?.hooks.get(hook);
    if (!instance || !fn) return {};
    try {
        const out = await Promise.resolve(fn(payload));
        return normalizeHookResult(out);
    } catch (err) {
        instance.host.toast(`机括「${instance.material.name}」${hook} 出错：${err instanceof Error ? err.message : String(err)}`);
        return {};
    }
}

/** 对白按钮：玩家点了某句对白，递给信任实例的 dialogue 钩子 */
export function sendMixTrustedDialogue(sessionId: string, materialId: string, event: MixTrustedDialogueEvent): void {
    const instance = instances.get(keyOf(sessionId, materialId));
    const fn = instance?.hooks.get("dialogue");
    if (!instance || !fn) return;
    try {
        void Promise.resolve(fn(event)).catch((err: unknown) => {
            instance.host.toast(`机括「${instance.material.name}」对白按钮出错：${err instanceof Error ? err.message : String(err)}`);
        });
    } catch (err) {
        instance.host.toast(`机括「${instance.material.name}」对白按钮出错：${err instanceof Error ? err.message : String(err)}`);
    }
}

/** 坑位组件用：订阅某实例的登记变化 */
export function subscribeMixTrusted(sessionId: string, materialId: string, listener: () => void): () => void {
    const instance = instances.get(keyOf(sessionId, materialId));
    if (!instance) return () => undefined;
    instance.listeners.add(listener);
    return () => { instance.listeners.delete(listener); };
}

export function mixTrustedVersion(sessionId: string, materialId: string): number {
    return instances.get(keyOf(sessionId, materialId))?.version ?? 0;
}

export function mixTrustedMounts(sessionId: string, materialId: string, slot: MixTrustedSlotName): MixTrustedSlotMount[] {
    return instances.get(keyOf(sessionId, materialId))?.slots.get(slot) ?? [];
}
