// lib/mixology/mechanism-protocol.ts
// 独家特调 · 机括钩子的数据契约。
//
// 钩子被设计成「纯函数调用」：应用递一份数据包进沙盒，沙盒加工完还一份回来。
// 不开双向指令通道，是因为通道一开，能做的事就得逐条把关，而且每一条都是
// 一个可能被滥用的口子；纯函数只需要把「还回来的东西」验一遍就够了。
//
// 这里只放两件事：递进去的数据包长什么样、还回来的东西怎么验。
// 都是纯函数，可以脱离浏览器单测——这段错了不会报错，只会让机括默默改坏别人的对局。

import type { MixState, MixStateValue } from "./types";

/** 钩子点：流水线上开的四个口子（第五个「上桌时」属于常驻界面，不走这条通道） */
export type MixHook = "sessionStart" | "beforeSend" | "afterReply" | "sessionEnd";

/** 界面上就写这四个词，不玩调酒行话——创作者要一眼知道钩子在什么时候被叫起来 */
export const MIX_HOOK_LABELS: Record<MixHook, string> = {
    sessionStart: "开局时",
    beforeSend: "发送前",
    afterReply: "回复后",
    sessionEnd: "退出时",
};

/** 机括自己的存储桶：一件机括 × 一个对局一份，退出再进来还在 */
export type MixMechanismStore = Record<string, string>;

/** 递进沙盒的数据包 */
export type MixHookPayload = {
    hook: MixHook;
    /** 已经发生的轮数 */
    turnCount: number;
    /** 当前记住的值（只读快照） */
    state: MixState;
    /** 这件机括自己的存储 */
    store: MixMechanismStore;
    /** 角色名与用户的名字 */
    charName: string;
    userName: string;
    /** 落杯前：玩家这一句；出杯后：模型这一段正文 */
    text?: string;
    /** 出杯后：这一轮的状态栏与小剧场原文 */
    ticketRaw?: string;
    encoreRaw?: string;
};

/** 沙盒还回来的东西 */
export type MixHookResult = {
    /** 改写 text（落杯前改玩家这句，出杯后改模型正文） */
    text?: string;
    /** 追加一段只在这一轮生效的临时提示 */
    note?: string;
    /** 要写进对局的记住值 */
    state?: MixState;
    /** 覆盖这件机括自己的存储 */
    store?: MixMechanismStore;
};

/** 单条文本上限：防止机括往正文里灌一大坨把上下文撑爆 */
const MAX_TEXT = 20_000;
const MAX_NOTE = 2_000;
/** 存储桶上限：键数与总字节 */
const MAX_STORE_KEYS = 100;
const MAX_STORE_BYTES = 100_000;
/** 一次能写多少个记住值 */
const MAX_STATE_KEYS = 50;
const MAX_STATE_VALUE = 200;

function cleanText(value: unknown, max: number): string {
    return String(value ?? "").replace(/\u0000/g, "").slice(0, max);
}

/** 记住的值只收数字与短文本，其余（对象、数组、函数残留）一律丢掉 */
function normalizeStateValue(value: unknown): MixStateValue | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string") {
        const text = cleanText(value, MAX_STATE_VALUE).trim();
        return text || undefined;
    }
    return undefined;
}

export function normalizeMechanismStore(value: unknown): MixMechanismStore {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: MixMechanismStore = {};
    let bytes = 0;
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
        if (Object.keys(out).length >= MAX_STORE_KEYS) break;
        const key = cleanText(rawKey, 80).trim();
        if (!key) continue;
        // 值统一存成字符串：机括想存结构自己 JSON.stringify，省得在边界上猜类型
        const text = typeof rawValue === "string" ? cleanText(rawValue, MAX_STORE_BYTES) : cleanText(JSON.stringify(rawValue ?? null), MAX_STORE_BYTES);
        bytes += key.length + text.length;
        if (bytes > MAX_STORE_BYTES) break;
        out[key] = text;
    }
    return out;
}

/**
 * 验沙盒还回来的结果。字段一个个挑出来重建，不认识的丢掉；
 * 整体不合法就返回空对象——机括写错不该让这一轮生成失败。
 */
export function normalizeHookResult(value: unknown): MixHookResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const out: MixHookResult = {};

    if (typeof record.text === "string") out.text = cleanText(record.text, MAX_TEXT);
    if (typeof record.note === "string") {
        const note = cleanText(record.note, MAX_NOTE).trim();
        if (note) out.note = note;
    }
    if (record.state && typeof record.state === "object" && !Array.isArray(record.state)) {
        const state: MixState = {};
        for (const [rawKey, rawValue] of Object.entries(record.state as Record<string, unknown>)) {
            if (Object.keys(state).length >= MAX_STATE_KEYS) break;
            const key = cleanText(rawKey, 40).trim();
            if (!key) continue;
            const normalized = normalizeStateValue(rawValue);
            if (normalized !== undefined) state[key] = normalized;
        }
        if (Object.keys(state).length) out.state = state;
    }
    if (record.store !== undefined) out.store = normalizeMechanismStore(record.store);
    return out;
}

/** 把一份结果合并进现有状态（机括只能改自己声明的那些键，不能删别人的） */
export function mergeHookState(current: MixState, patch: MixState | undefined): MixState {
    if (!patch || !Object.keys(patch).length) return current;
    return { ...current, ...patch };
}
