// lib/mixology/state.ts
// 独家特调 · 记住的值 + 生效条件。
//
// 两件事：
// ① 小票里勾了「记住」的项，每轮从小票原文里抽出来存进对局；抽不到就保留上一轮，
//    宁可停滞也不能跳变——数字突然归零对玩家的破坏感远大于这轮没涨。
// ② 每件材料可以带一个生效条件，装配前逐条判定，不满足的这一轮就当没放。
//    条件是纯数据比较，不做表达式求值，所以跟着材料分享出去也不执行任何东西。

import type {
    MixCompareOp,
    MixCondition,
    MixMaterial,
    MixMaterialKind,
    MixSession,
    MixSlotEntry,
    MixState,
    MixStateValue,
    MixTicketMaterial,
    MixTurn,
} from "./types";
import { MIX_SLOT_ORDER, MIX_SLOT_STACK, mixKindAllowsCondition } from "./types";

/**
 * 键名后面跟中英文冒号或等号，取到下一个分隔符为止。
 * 分隔符只认换行和分号/竖线（含全角）——逗号顿号不算，因为「地点：酒吧，吧台角落」
 * 这种值里本来就带逗号，拿它断句会把值截半截。
 */
const VAR_SEPARATORS = "\\n\\r;；|｜";

function buildVarPattern(name: string): RegExp {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[${VAR_SEPARATORS}])\\s*${escaped}\\s*[：:=]\\s*([^${VAR_SEPARATORS}]*)`, "i");
}

/** 从小票原文里抽一个值；抽不到返回 undefined（调用方保留上一轮） */
export function extractMixVar(raw: string, name: string): MixStateValue | undefined {
    if (!raw || !name.trim()) return undefined;
    const matched = buildVarPattern(name.trim()).exec(raw);
    if (!matched) return undefined;
    const text = (matched[1] ?? "").trim();
    if (!text) return undefined;
    // 纯数字（含正负号与小数）按数字存，条件里才能比大小
    if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    return text;
}

/** 开局初值：小票里声明过初始值的项。多张小票按槽位顺序合并，同名项先声明的优先 */
export function initialMixState(ticket: MixTicketMaterial | MixTicketMaterial[] | undefined): MixState {
    const state: MixState = {};
    const tickets = Array.isArray(ticket) ? ticket : ticket ? [ticket] : [];
    for (const one of tickets) {
        for (const item of one.vars ?? []) {
            const name = item.name.trim();
            if (!name || state[name] !== undefined) continue;
            const initial = (item.initial ?? "").trim();
            if (!initial) continue;
            state[name] = /^[+-]?\d+(?:\.\d+)?$/.test(initial) ? Number(initial) : initial;
        }
    }
    return state;
}

/** 用这一轮的小票原文更新记住的值 */
export function advanceMixState(
    prev: MixState | undefined,
    ticket: MixTicketMaterial | undefined,
    ticketRaw: string | undefined,
): MixState {
    const next: MixState = { ...(prev ?? {}) };
    const declared = ticket?.vars ?? [];
    if (!declared.length || !ticketRaw) return next;
    for (const item of declared) {
        const name = item.name.trim();
        if (!name) continue;
        const value = extractMixVar(ticketRaw, name);
        if (value !== undefined) next[name] = value;
    }
    return next;
}

/** 回溯 / 重说 / 编辑之后：回到剩下最后一轮的快照 */
export function rollbackMixState(turns: MixTurn[], fallback: MixState): MixState {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        const snapshot = turns[i].state;
        if (snapshot) return { ...snapshot };
    }
    return { ...fallback };
}

function compare(left: MixStateValue | undefined, op: MixCompareOp, right: string): boolean {
    if (left === undefined) return false;
    const rightNum = Number(right);
    const bothNumeric = typeof left === "number" && right.trim() !== "" && Number.isFinite(rightNum);
    if (bothNumeric) {
        switch (op) {
            case ">": return left > rightNum;
            case ">=": return left >= rightNum;
            case "<": return left < rightNum;
            case "<=": return left <= rightNum;
            case "=": return left === rightNum;
            case "!=": return left !== rightNum;
        }
    }
    // 非数字：只有相等/不等有意义，大小比较一律不成立
    const leftText = String(left).trim();
    const rightText = right.trim();
    if (op === "=") return leftText === rightText;
    if (op === "!=") return leftText !== rightText;
    return false;
}

/** 判定时能看到的现场 */
export type MixConditionContext = {
    /** 已经发生的轮数 */
    turnCount: number;
    /** 当前记住的值 */
    state: MixState;
    /** 最近若干轮的正文（含玩家这一句），下标 0 是最近的一轮 */
    recentTexts: string[];
    /** 随机源，注入是为了让测试可复现 */
    random?: () => number;
};

/** 条件是否成立；不写条件 = 一直成立 */
export function matchMixCondition(when: MixCondition | undefined, ctx: MixConditionContext): boolean {
    if (!when) return true;
    switch (when.type) {
        case "turn":
            return ctx.turnCount >= Math.max(0, Math.floor(when.after));
        case "var":
            return compare(ctx.state[when.name], when.op, when.value);
        case "keyword": {
            const words = when.words.map((w) => w.trim().toLowerCase()).filter(Boolean);
            if (!words.length) return false;
            const within = Math.max(1, Math.floor(when.within ?? 1));
            const haystack = ctx.recentTexts.slice(0, within).join("\n").toLowerCase();
            return words.some((word) => haystack.includes(word));
        }
        case "chance": {
            const percent = Math.max(0, Math.min(100, when.percent));
            if (percent <= 0) return false;
            if (percent >= 100) return true;
            return (ctx.random ?? Math.random)() * 100 < percent;
        }
        default:
            return true;
    }
}

/** 关键词条件最多回看多少轮：长局里别每轮都拼一大串正文 */
const MIX_KEYWORD_MAX_LOOKBACK = 10;

/** 从对局取出判定现场（下标 0 是最近的一轮） */
export function buildMixConditionContext(session: MixSession): MixConditionContext {
    return {
        turnCount: session.turns.length,
        state: session.state ?? {},
        recentTexts: session.turns.slice(-MIX_KEYWORD_MAX_LOOKBACK).reverse().map((t) => t.text),
    };
}

/**
 * 按生效条件筛出这一轮真正参与的材料。
 * 累加型的格保留全部命中的（小票/尾调也是——每件各自成块），
 * 择一型的格（角色卡/面具）只留第一件命中的；角色卡与面具不设条件，直接过。
 */
export function pickActiveMixMaterials(
    entries: Partial<Record<MixMaterialKind, { entry: MixSlotEntry; material: MixMaterial }[]>>,
    ctx: MixConditionContext,
): Partial<Record<MixMaterialKind, MixMaterial[]>> {
    const picked: Partial<Record<MixMaterialKind, MixMaterial[]>> = {};
    for (const kind of MIX_SLOT_ORDER) {
        const list = entries[kind];
        if (!list?.length) continue;
        const hit: MixMaterial[] = [];
        for (const { entry, material } of list) {
            if (mixKindAllowsCondition(kind) && !matchMixCondition(entry.when, ctx)) continue;
            hit.push(material);
            if (MIX_SLOT_STACK[kind] === "first") break;
        }
        if (hit.length) picked[kind] = hit;
    }
    return picked;
}

/** 条件的人话描述，界面上直接显示 */
export function describeMixCondition(when: MixCondition | undefined): string {
    if (!when) return "一直出现";
    switch (when.type) {
        case "turn":
            return `聊到第 ${Math.max(0, Math.floor(when.after))} 轮之后`;
        case "var":
            return `当「${when.name}」${when.op} ${when.value}`;
        case "keyword": {
            const words = when.words.filter((w) => w.trim());
            const within = Math.max(1, Math.floor(when.within ?? 1));
            const scope = within > 1 ? `最近 ${within} 轮内` : "";
            return `${scope}提到「${words.join("、") || "…"}」的时候`;
        }
        case "chance":
            return `随机 ${Math.max(0, Math.min(100, when.percent))}% 的时候`;
        default:
            return "一直出现";
    }
}
