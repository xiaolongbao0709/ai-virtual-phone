// lib/mixology/mechanism-protocol.ts
// 独家特调 · 机括钩子的数据契约。
//
// 钩子被设计成「纯函数调用」：应用递一份数据包进沙盒，沙盒加工完还一份回来。
// 不开双向指令通道，是因为通道一开，能做的事就得逐条把关，而且每一条都是
// 一个可能被滥用的口子；纯函数只需要把「还回来的东西」验一遍就够了。
//
// 这里只放两件事：递进去的数据包长什么样、还回来的东西怎么验。
// 都是纯函数，可以脱离浏览器单测——这段错了不会报错，只会让机括默默改坏别人的对局。

import type { MixSectionTitleKey, MixState, MixStateValue } from "./types";

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
    /** 出杯后：这一轮的状态栏与小剧场原文（多块并行时为第一块，全量见 ticketRaws/encoreRaws） */
    ticketRaw?: string;
    encoreRaw?: string;
    /** 出杯后：这一轮全部状态栏/小剧场块的原文，按输出顺序 */
    ticketRaws?: string[];
    encoreRaws?: string[];
    /**
     * 出杯后专用：这次不是新生成，是玩家编辑了这一轮原文后手动要求的重跑。
     * 玩家选「替换」时应用已先把 store 回滚到这一轮记账前（钩子照常当新一轮记）；
     * 选「追加」则在现有 store 上再跑一遍。一般无需特殊处理，此标记仅供知情。
     */
    edited?: boolean;
};

/** 沙盒还回来的东西 */
/**
 * 挂进系统提示词的一段：at 指定挂在哪个分段之后，text 原样接上（标题自带，
 * 写 # 就是独立一段，写 ## 就读作那一段的小节）。只在这一轮的提示词里存在，不落库。
 */
export type MixHookSection = {
    at: MixSectionTitleKey;
    text: string;
};

export type MixHookResult = {
    /** 改写 text（落杯前改玩家这句，出杯后改模型正文） */
    text?: string;
    /** 追加一段只在这一轮生效的临时提示（挂在最末尾那条 user 消息） */
    note?: string;
    /** 挂进系统提示词指定分段之后的内容（落杯前钩子有效） */
    sections?: MixHookSection[];
    /** 要写进对局的记住值 */
    state?: MixState;
    /** 覆盖这件机括自己的存储 */
    store?: MixMechanismStore;
};

/** 可挂的分段键：与序言自定义标题的那一套一致 */
export const MIX_HOOK_SECTION_KEYS: readonly MixSectionTitleKey[] = [
    "base", "character", "persona", "world", "flavor", "glass", "ticket", "encore", "examples", "checklist",
];

// text / note / store 不设长度上限，也绝不静默裁剪——被截在半句话上的记忆、
// 悄悄丢掉的存储键，出了问题根本查不到原因，比撑大上下文更伤人。
// 内容多大是机括作者自己的责任（记忆类机括本来就要全量喂回模型）。
/** 一次能写多少个记住值（记住值是状态栏用的短文本，仍保留形状契约） */
const MAX_STATE_KEYS = 50;
const MAX_STATE_VALUE = 200;

function cleanText(value: unknown, max?: number): string {
    const text = String(value ?? "").replace(/\u0000/g, "");
    return max ? text.slice(0, max) : text;
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
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
        const key = cleanText(rawKey).trim();
        if (!key) continue;
        // 值统一存成字符串：机括想存结构自己 JSON.stringify，省得在边界上猜类型
        const text = typeof rawValue === "string" ? cleanText(rawValue) : cleanText(JSON.stringify(rawValue ?? null));
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

    if (typeof record.text === "string") out.text = cleanText(record.text);
    if (typeof record.note === "string") {
        const note = cleanText(record.note).trim();
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
    if (Array.isArray(record.sections)) {
        const sections: MixHookSection[] = [];
        for (const item of record.sections) {
            if (!item || typeof item !== "object") continue;
            const { at, text } = item as Record<string, unknown>;
            if (typeof at !== "string" || !(MIX_HOOK_SECTION_KEYS as readonly string[]).includes(at)) continue;
            const body = typeof text === "string" ? cleanText(text).trim() : "";
            if (body) sections.push({ at: at as MixSectionTitleKey, text: body });
        }
        if (sections.length) out.sections = sections;
    }
    return out;
}

/** 把一份结果合并进现有状态（机括只能改自己声明的那些键，不能删别人的） */
export function mergeHookState(current: MixState, patch: MixState | undefined): MixState {
    if (!patch || !Object.keys(patch).length) return current;
    return { ...current, ...patch };
}
