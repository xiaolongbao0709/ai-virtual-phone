// lib/mixology/hall-parts.ts
// 独家特调 · 配方槽位引用的服务端校验。
//
// 配方分享出去的是「引用 + 顺序 + 生效条件」，材料本体在酒材页各自成条目。
// 这里的输入是别人写的、且会原样发给每一个下载者的数据，所以一律按白名单
// 逐字段重建，不做透传：形状不对、超长、越界的一概丢掉。
// 抽成独立模块是为了能脱离路由单测——这段错了不会报错，只会让所有人的配方悄悄变形。

/** 只能放一件的格：叠了也没意义，直接判非法，免得别人下载下来一脸问号 */
export const SINGLE_PART_KINDS: readonly string[] = ["character", "persona", "preface"];
/** 整份引用数组的条数上限：纯防滥用的护栏（正常配方远碰不到），不是玩法限制 */
export const MAX_RECIPE_PARTS = 200;

const COMPARE_OPS: readonly string[] = [">", ">=", "<", "<=", "=", "!="];

export type PartCondition =
    | { type: "turn"; after: number }
    | { type: "var"; name: string; op: string; value: string }
    | { type: "keyword"; words: string[]; within?: number }
    | { type: "chance"; percent: number };

export type RecipePartRef = {
    id: string;
    kind: string;
    name: string;
    builtin?: boolean;
    when?: PartCondition;
};

function cleanText(value: unknown, maxLength: number): string {
    return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

/**
 * 生效条件：按白名单重建。任何一项不合法就返回 undefined——
 * 宁可这一件变成「一直出现」，也不让来路不明的结构进到别人的配方里。
 */
export function normalizePartCondition(value: unknown): PartCondition | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const type = cleanText(record.type, 12);
    if (type === "turn") {
        const after = Math.floor(Number(record.after));
        if (!Number.isFinite(after) || after < 0 || after > 9999) return undefined;
        return { type: "turn", after };
    }
    if (type === "var") {
        const name = cleanText(record.name, 40);
        const op = cleanText(record.op, 2);
        const varValue = cleanText(record.value, 80);
        if (!name || !varValue || !COMPARE_OPS.includes(op)) return undefined;
        return { type: "var", name, op, value: varValue };
    }
    if (type === "keyword") {
        if (!Array.isArray(record.words)) return undefined;
        const words = record.words.map((word) => cleanText(word, 40)).filter(Boolean).slice(0, 12);
        if (!words.length) return undefined;
        const within = Math.floor(Number(record.within));
        const scope = Number.isFinite(within) && within > 1 ? Math.min(within, 50) : undefined;
        return scope ? { type: "keyword", words, within: scope } : { type: "keyword", words };
    }
    if (type === "chance") {
        const percent = Math.floor(Number(record.percent));
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
        return { type: "chance", percent };
    }
    return undefined;
}

/**
 * 机括是唯一一类「下载下来会在别人设备上按轮执行、还能改写对话」的材料，
 * 所以除了通用的 payload 体积上限，再单独卡一道：代码写不了那么长，
 * 界面摆放必须是一份认得出的数据。卡紧一点也让混淆塞大段东西变得更难。
 */
const MAX_MECHANISM_SCRIPT = 40_000;
const MAX_MECHANISM_PANEL = 200_000;
const MECHANISM_DOCKS: readonly string[] = ["left", "right", "bottom", "float"];

/**
 * 界面摆放：只看形状，不夹边界。数值越界交给下载方的 normalizeMixPanelLayout
 * 去夹——这一段刻意不 import 应用侧模块，好脱离运行时单测。
 */
function isPanelLayout(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    for (const key of ["x", "y", "w", "h"]) {
        if (!Number.isFinite(Number(record[key]))) return false;
    }
    if (record.chrome !== undefined && record.chrome !== "bar" && record.chrome !== "none") return false;
    if (record.z !== undefined && !Number.isFinite(Number(record.z))) return false;
    return true;
}

export function validateMechanismPayload(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return "missing_payload";
    const record = payload as Record<string, unknown>;
    const script = typeof record.script === "string" ? record.script : "";
    const panel = typeof record.panelHtml === "string" ? record.panelHtml : "";
    if (script.length > MAX_MECHANISM_SCRIPT) return "机括的逻辑代码太长了。";
    if (panel.length > MAX_MECHANISM_PANEL) return "机括的界面代码太长了。";
    if (!script.trim() && !panel.trim()) return "这件机括是空的：逻辑和界面至少要写一样。";
    if (record.dock !== undefined && record.dock !== null && !MECHANISM_DOCKS.includes(String(record.dock))) {
        return "invalid_dock";
    }
    // 摆放是纯数据（百分比坐标与几个开关），下载方拿到后还会自己夹一遍边界；
    // 这里只挡住"根本不是一份摆放"的东西。
    if (record.layout !== undefined && record.layout !== null && !isPanelLayout(record.layout)) {
        return "invalid_layout";
    }
    // 不再要求"配了界面就得声明画在哪"。摆放已经收进界面代码里（mix.move / mix.size /
    // mix.chrome …），新材料本来就没有 layout 与 dock 字段；下载方拿到后给一个中性起始值，
    // 第一帧之后由界面代码自己挪走。这里再拦一道，等于把新写法全挡在门外。
    return null;
}

/** 校验并清洗配方槽位引用；不合法返回错误码 */
export function normalizeRecipeParts(
    value: unknown,
    options: { materialKinds: readonly string[]; maxPayload: number },
): { parts: RecipePartRef[] } | { error: string } {
    if (!Array.isArray(value) || value.length === 0) return { error: "missing_parts" };
    if (value.length > MAX_RECIPE_PARTS) return { error: "too_many_parts" };
    const parts: RecipePartRef[] = [];
    // 一格可以叠多件，所以记的是每格已经收了几件，不再是「这格出现过没有」
    const kindCount = new Map<string, number>();
    for (const item of value) {
        if (!item || typeof item !== "object") return { error: "invalid_part" };
        const record = item as Record<string, unknown>;
        const id = cleanText(record.id, 160);
        const kind = cleanText(record.kind, 20);
        const name = cleanText(record.name, 80);
        const builtin = record.builtin === true;
        if (!id || !name || !options.materialKinds.includes(kind)) return { error: "invalid_part" };
        if (builtin && !id.startsWith("mix_builtin_")) return { error: "invalid_builtin_part" };
        const used = kindCount.get(kind) ?? 0;
        if (SINGLE_PART_KINDS.includes(kind) && used >= 1) return { error: "too_many_parts_in_kind" };
        kindCount.set(kind, used + 1);
        // 角色卡与面具不设条件；其余按白名单重建，非法就当没条件
        const when = SINGLE_PART_KINDS.includes(kind) ? undefined : normalizePartCondition(record.when);
        const base: RecipePartRef = builtin ? { id, kind, name, builtin: true } : { id, kind, name };
        parts.push(when ? { ...base, when } : base);
    }
    if (!kindCount.has("character")) return { error: "配方缺角色卡，没法分享。" };
    if (JSON.stringify(parts).length > options.maxPayload) return { error: "配方引用数据过大。" };
    return { parts };
}
