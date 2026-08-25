// lib/mixology/mascot-tools.ts
// 独家特调 · 小卷工具执行器：桌面助手直写酒柜与配方。
//
// 与酒柜界面同一套存储与规矩：官方出厂件与入柜导入的别人的作品不可修改，
// 导入的角色卡正文封存（工具也只回元信息）；删除刻意不提供——小卷只建不拆，
// 拆东西让用户自己在酒柜里做（那里有确认弹窗）。
// 每类材料的写作规格通过「读取制作说明」按需取（与人用的委托词同源派生），
// 这里只做字段校验：校验口径向导入器（transfer.ts）与编辑器看齐，报错给到能改的粒度。

import type { ToolResult } from "../tool-executor";
import {
    MIX_KIND_LABELS,
    MIX_SLOT_ORDER,
    createMixId,
    mixPanelLayoutSummary,
    normalizeMixPanelLayout,
    normalizeMixTags,
    type MixCharacterCard,
    type MixCondition,
    type MixFilterRule,
    type MixMaterial,
    type MixMaterialKind,
    type MixSlotEntry,
    type MixTicketVar,
} from "./types";
import {
    MIX_CABINET_UPDATED_EVENT,
    getMixMaterial,
    isMixBuiltinId,
    listMixBuiltins,
    loadMixCabinet,
    loadMixRecipes,
    saveMixMaterial,
    saveMixRecipe,
} from "./storage";

import { buildMixCraftSpec } from "./crafting-guides";
import { normalizePartCondition } from "./hall-parts";

/** 写库成功后通知已打开的特调 App 重读列表，否则界面要等用户自己操作才刷新 */
function broadcastCabinetUpdated(): void {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MIX_CABINET_UPDATED_EVENT));
}

/** 是否封存：与酒柜界面的 isSealedMaterial（mixology-shared.tsx）同一条规矩——
 *  只有「从酒材页拿来的别人的角色卡」藏正文。不从组件层 import，免得把 UI 拖进 lib。 */
function isSealed(material: MixMaterial): boolean {
    return Boolean(material.imported) && material.kind === "character";
}

const KIND_SET = new Set<string>(MIX_SLOT_ORDER);

function asKind(value: unknown): MixMaterialKind | null {
    return typeof value === "string" && KIND_SET.has(value) ? (value as MixMaterialKind) : null;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** 来源标注：官方出厂 / 入柜导入 / 自建 */
function originOf(material: MixMaterial): string {
    if (isMixBuiltinId(material.id)) return "官方";
    return material.imported ? "导入（他人作品，不可修改）" : "自建";
}

// ── 列出酒柜 ─────────────────────────────────────────

export function mixToolListCabinet(args: Record<string, unknown>): ToolResult {
    const NAME = "列出酒柜";
    const kindArg = args.kind === undefined || args.kind === "" ? null : asKind(args.kind);
    if (args.kind !== undefined && args.kind !== "" && !kindArg) {
        return { name: NAME, success: false, error: `未知材料种类：${String(args.kind)}。可选：${MIX_SLOT_ORDER.join(" / ")}` };
    }
    const cabinet = loadMixCabinet().filter((m) => !kindArg || m.kind === kindArg);
    const builtins = (kindArg ? listMixBuiltins(kindArg) : listMixBuiltins()).slice();
    const lines: string[] = [];
    lines.push(`酒柜共 ${cabinet.length} 件${kindArg ? `「${MIX_KIND_LABELS[kindArg]}」` : "材料"}，官方出厂件 ${builtins.length} 件。`);
    for (const m of [...cabinet].sort((a, b) => b.updatedAt - a.updatedAt)) {
        lines.push(`· [${m.id}] ${MIX_KIND_LABELS[m.kind]}「${m.name}」（${originOf(m)}）${m.hook ? ` — ${m.hook.slice(0, 40)}` : ""}`);
    }
    for (const m of builtins) {
        lines.push(`· [${m.id}] ${MIX_KIND_LABELS[m.kind]}「${m.name}」（官方）`);
    }
    const recipes = loadMixRecipes();
    if (!kindArg && recipes.length) {
        lines.push(`已有配方 ${recipes.length} 杯：${recipes.map((r) => `「${r.name}」`).join("、")}`);
    }
    return { name: NAME, success: true, data: lines.join("\n") };
}

// ── 读取材料 ─────────────────────────────────────────

/** 按 id 或名字找材料；名字重名时列出候选让模型带 id 再来 */
function findMaterial(args: Record<string, unknown>): { ok?: MixMaterial; err?: string } {
    const id = text(args.id).trim();
    if (id) {
        const m = getMixMaterial(id);
        return m ? { ok: m } : { err: `没有 id 为 ${id} 的材料。` };
    }
    const name = text(args.name).trim();
    if (!name) return { err: "请传 id 或 name 之一。" };
    const all = [...loadMixCabinet(), ...listMixBuiltins()];
    const hits = all.filter((m) => m.name === name);
    if (hits.length === 0) return { err: `酒柜里没有叫「${name}」的材料。可先用 列出酒柜 查看。` };
    if (hits.length > 1) return { err: `有 ${hits.length} 件材料都叫「${name}」：${hits.map((m) => `[${m.id}] ${MIX_KIND_LABELS[m.kind]}`).join("、")}。请带 id 再调用。` };
    return { ok: hits[0] };
}

function describeMaterial(material: MixMaterial): string {
    const lines: string[] = [];
    lines.push(`[${material.id}] ${MIX_KIND_LABELS[material.kind]}「${material.name}」（${originOf(material)}）`);
    if (material.hook) lines.push(`一句话介绍：${material.hook}`);
    if (material.tags?.length) lines.push(`标签：${material.tags.join("、")}`);
    const field = (label: string, value: string | undefined) => {
        if (value?.trim()) lines.push(`【${label}】\n${value}`);
    };
    switch (material.kind) {
        case "character": {
            const c = material as MixCharacterCard;
            field("基础信息", c.baseInfo); field("性格", c.personality); field("外貌", c.appearance);
            field("背景", c.background); field("世界观", c.worldview); field("初始认知", c.cognition);
            field("关系与身份", c.relations); field("当前剧情", c.plot); field("附加设定", c.extra);
            c.openings.forEach((o, i) => field(`开场白${i + 1}`, o));
            if (c.examples?.length) field("示例对话", c.examples.map((e) => `${e.role}：${e.text}`).join("\n"));
            field("开场画布", c.canvas);
            break;
        }
        case "persona":
            field("你的名字", material.userName); field("用户人设", material.content);
            break;
        case "ticket":
            field("输出契约", material.contract); field("渲染代码", material.renderHtml);
            field("预览示例数据", material.previewRaw);
            field("历史回传", material.historyFeed === "all" ? "all（全部轮次回传）" : material.historyFeed === "none" ? "none（完全不回传）" : undefined);
            if (material.vars?.length) field("记住的变量", material.vars.map((v) => `${v.name}${v.initial ? `＝${v.initial}` : ""}`).join("、"));
            break;
        case "garnish":
            field("外观 CSS", material.css);
            break;
        case "encore":
            field("输出契约", material.contract); field("渲染代码", material.renderHtml ?? material.html);
            field("预览示例数据", material.previewRaw);
            field("历史回传", material.historyFeed === "all" ? "all（全部轮次回传）" : material.historyFeed === "none" ? "none（完全不回传）" : undefined);
            break;
        case "filter":
            field("清洗规则", material.rules.map((r, i) => `${i + 1}. /${r.find}/ → ${r.replace || "（删除）"}（${r.mode === "display" ? "仅显示" : "进上下文"}）`).join("\n"));
            break;
        case "mechanism":
            field("钩子逻辑", material.script); field("界面代码", material.panelHtml);
            field("摆放", material.layout ? mixPanelLayoutSummary(material.layout) : undefined);
            break;
        default:
            field(`${MIX_KIND_LABELS[material.kind]}内容`, (material as { content?: string }).content);
    }
    return lines.join("\n");
}

export function mixToolReadMaterial(args: Record<string, unknown>): ToolResult {
    const NAME = "读取材料";
    const r = findMaterial(args);
    if (!r.ok) return { name: NAME, success: false, error: r.err };
    if (isSealed(r.ok)) {
        return {
            name: NAME, success: true,
            data: `[${r.ok.id}] 角色卡「${r.ok.name}」是从酒材页入柜的他人作品，正文封存（与酒柜界面同规矩），不可读取或修改。${r.ok.hook ? `\n一句话介绍：${r.ok.hook}` : ""}`,
        };
    }
    return { name: NAME, success: true, data: describeMaterial(r.ok) };
}

// ── 读取制作说明 ─────────────────────────────────────

export function mixToolReadCraftSpec(args: Record<string, unknown>): ToolResult {
    const NAME = "读取制作说明";
    const kind = asKind(args.kind);
    if (!kind) return { name: NAME, success: false, error: `请传材料种类 kind。可选：${MIX_SLOT_ORDER.join(" / ")}` };
    return { name: NAME, success: true, data: buildMixCraftSpec(kind) };
}

// ── 创建 / 更新材料 ──────────────────────────────────

type FieldSpec = { key: string; kinds: MixMaterialKind[] };
/** 各 kind 允许写入的正文字段（元信息 name/hook/tags 全类通用，单独处理） */
const CONTENT_FIELDS: FieldSpec[] = [
    { key: "content", kinds: ["persona", "base", "flavor", "glass", "strength"] },
    { key: "userName", kinds: ["persona"] },
    { key: "baseInfo", kinds: ["character"] },
    { key: "personality", kinds: ["character"] },
    { key: "appearance", kinds: ["character"] },
    { key: "background", kinds: ["character"] },
    { key: "worldview", kinds: ["character"] },
    { key: "cognition", kinds: ["character"] },
    { key: "relations", kinds: ["character"] },
    { key: "plot", kinds: ["character"] },
    { key: "extra", kinds: ["character"] },
    { key: "canvas", kinds: ["character"] },
    { key: "openings", kinds: ["character"] },
    { key: "examples", kinds: ["character"] },
    { key: "contract", kinds: ["ticket", "encore"] },
    { key: "renderHtml", kinds: ["ticket", "encore"] },
    { key: "previewRaw", kinds: ["ticket", "encore"] },
    { key: "historyFeed", kinds: ["ticket", "encore"] },
    { key: "vars", kinds: ["ticket"] },
    { key: "css", kinds: ["garnish"] },
    { key: "rules", kinds: ["filter"] },
    { key: "script", kinds: ["mechanism"] },
    { key: "panelHtml", kinds: ["mechanism"] },
    { key: "layout", kinds: ["mechanism"] },
];

function normalizeOpenings(value: unknown): string[] | { err: string } {
    if (!Array.isArray(value)) return { err: "openings 必须是字符串数组，每个元素一条开场白。" };
    const list = value.filter((o): o is string => typeof o === "string" && Boolean(o.trim())).map((o) => o.trim());
    return list;
}

function normalizeExamples(value: unknown): { role: "user" | "char"; text: string }[] | { err: string } {
    if (!Array.isArray(value)) return { err: 'examples 必须是数组，元素形如 {"role":"user"|"char","text":"…"}。' };
    const out: { role: "user" | "char"; text: string }[] = [];
    for (const item of value) {
        const role = (item as Record<string, unknown>)?.role;
        const t = (item as Record<string, unknown>)?.text;
        if ((role !== "user" && role !== "char") || typeof t !== "string" || !t.trim()) {
            return { err: 'examples 里有不合法的元素：role 只能是 "user" 或 "char"，text 不能为空。' };
        }
        out.push({ role, text: t.trim() });
    }
    return out;
}

function normalizeVars(value: unknown): MixTicketVar[] | { err: string } {
    if (!Array.isArray(value)) return { err: 'vars 必须是数组，元素形如 {"name":"好感度","initial":"50"}。' };
    const out: MixTicketVar[] = [];
    for (const item of value) {
        const name = text((item as Record<string, unknown>)?.name).trim();
        if (!name) return { err: "vars 里有缺 name 的元素。" };
        const initial = text((item as Record<string, unknown>)?.initial).trim();
        out.push(initial ? { name, initial } : { name });
    }
    return out;
}

function normalizeRules(value: unknown): MixFilterRule[] | { err: string } {
    if (!Array.isArray(value) || value.length === 0) return { err: 'rules 必须是非空数组，元素形如 {"find":"…","replace":"…","mode":"display"|"context"}。' };
    const out: MixFilterRule[] = [];
    for (const [i, item] of value.entries()) {
        const record = item as Record<string, unknown>;
        const find = text(record?.find);
        const mode = record?.mode;
        if (!find.trim()) return { err: `第 ${i + 1} 条规则缺 find。` };
        if (mode !== "display" && mode !== "context") return { err: `第 ${i + 1} 条规则的 mode 必须是 "display"（仅显示）或 "context"（进上下文）。` };
        try {
            new RegExp(find, "g");
        } catch {
            return { err: `第 ${i + 1} 条规则的正则编译失败：${find}（不要带斜杠定界符或反引号）。` };
        }
        out.push({ find, replace: text(record?.replace), mode });
    }
    return out;
}

/** 把工具参数里的正文字段并进材料对象；返回错误信息或 null */
function applyContentFields(target: Record<string, unknown>, kind: MixMaterialKind, args: Record<string, unknown>): string | null {
    for (const spec of CONTENT_FIELDS) {
        if (args[spec.key] === undefined) continue;
        if (!spec.kinds.includes(kind)) {
            return `字段 ${spec.key} 不属于${MIX_KIND_LABELS[kind]}（它属于：${spec.kinds.map((k) => MIX_KIND_LABELS[k]).join("/")}）。`;
        }
        switch (spec.key) {
            case "openings": {
                const r = normalizeOpenings(args[spec.key]);
                if (!Array.isArray(r)) return r.err;
                target.openings = r;
                break;
            }
            case "examples": {
                const r = normalizeExamples(args[spec.key]);
                if (!Array.isArray(r)) return r.err;
                target.examples = r;
                break;
            }
            case "vars": {
                const r = normalizeVars(args[spec.key]);
                if (!Array.isArray(r)) return r.err;
                target.vars = r;
                break;
            }
            case "rules": {
                const r = normalizeRules(args[spec.key]);
                if (!Array.isArray(r)) return r.err;
                target.rules = r;
                break;
            }
            case "layout": {
                const normalized = normalizeMixPanelLayout(args[spec.key]);
                if (!normalized) return 'layout 必须是摆放对象，如 {"slot":"inputbar-left","icon":"🎲","autoHeight":true}。';
                target.layout = normalized;
                break;
            }
            case "historyFeed": {
                const v = args[spec.key];
                if (v !== "latest" && v !== "all" && v !== "none") return 'historyFeed 只能是 "latest"（只回传最近一轮，默认）、"all"（全部轮次回传）或 "none"（完全不回传）。';
                if (v === "latest") delete target.historyFeed;
                else target.historyFeed = v;
                break;
            }
            default: {
                const value = args[spec.key];
                if (typeof value !== "string") return `字段 ${spec.key} 必须是字符串。`;
                target[spec.key] = value;
            }
        }
    }
    return null;
}

/** 封面来源校验：图床/远端 URL 或 dataURL，别的（本地路径、编造的短串）拒收 */
function normalizeCover(value: unknown): string | { err: string } {
    const cover = text(value).trim();
    if (/^https?:\/\//.test(cover) || cover.startsWith("data:image/")) return cover;
    return { err: "cover 必须是 http(s) 图片地址（可用图像处理套件上传图床取得）或 data:image/ 开头的 dataURL。" };
}

/**
 * 质量提示：不拦保存，但把偏薄的地方点出来写进成功返回——
 * 使用指南要求小卷看到质量提示必须跟进补足，这是防偷懒的软引导侧。
 */
function qualityHints(material: Record<string, unknown>, kind: MixMaterialKind): string {
    if (kind === "ticket") {
        const contract = typeof material.contract === "string" ? material.contract.trim().length : 0;
        if (contract > 0 && contract < 300)
            return `\n质量提示（建议用 更新材料 补足）：\n- 输出契约只有 ${contract} 字，撑不起有血肉的状态栏——整卡通常 6~10 项、描述项要求带细节的完整句、配一两个长文小节（见制作说明的信息量要求）`;
        return "";
    }
    if (kind === "encore") {
        const contract = typeof material.contract === "string" ? material.contract.trim().length : 0;
        if (contract > 0 && contract < 300)
            return `\n质量提示（建议用 更新材料 补足）：\n- 输出契约只有 ${contract} 字——小剧场是玩家等生成时读的加餐，契约要把每轮的内容量逼到微型作品级（成篇的社交帖楼层/完整一幕短剧，十来行两三百字起步，见制作说明），三五行的加演等于没演`;
        return "";
    }
    if (kind !== "character") return "";
    const hints: string[] = [];
    const len = (key: string) => (typeof material[key] === "string" ? (material[key] as string).trim().length : 0);
    const openings = Array.isArray(material.openings) ? material.openings.length : 0;
    if (openings < 2) hints.push("开场白只有一条，按规格写 2~3 条不同切入供玩家挑选");
    if (Array.isArray(material.openings)) {
        const thin = (material.openings as unknown[]).filter((o) => typeof o === "string" && o.trim().length > 0 && o.trim().length < 300).length;
        if (thin > 0) hints.push(`有 ${thin} 条开场白不足 300 字——每条四五百字起步，场景、动作、对白、内心铺成完整一幕，并用正文标记（「」对白、*…*心声、【】场景行）书写`);
    }
    const examples = Array.isArray(material.examples) ? material.examples.length : 0;
    if (examples < 6) hints.push(`示例对话只有 ${Math.floor(examples / 2)} 轮，建议补到 3~5 轮锚定文风`);
    const canvas = len("canvas");
    if (!canvas) hints.push("没有开场画布——按「画布制作规格」补一份完整门面页");
    else if (canvas < 6000) hints.push(`开场画布只有 ${canvas} 字符，体量不够——画布是一整页好几屏长的门面长页（通常 4~5 个模块，模块内可用折叠/点击交互收纳内容），把每个模块做深做厚，别缩水成一张信息卡`);
    for (const [key, label] of [["personality", "性格"], ["background", "背景"], ["worldview", "世界观"], ["relations", "关系与身份"]] as const) {
        if (len(key) === 0) hints.push(`${label}还空着`);
        else if (len(key) < 60) hints.push(`${label}偏薄（${len(key)} 字），用具体行为细节撑起来`);
    }
    return hints.length ? `\n质量提示（建议用 更新材料 补足）：\n- ${hints.join("\n- ")}` : "";
}

/** 成品校验：与导入器/编辑器同口径，缺什么说什么 */
function validateMaterial(material: Record<string, unknown>, kind: MixMaterialKind): string | null {
    const has = (key: string) => typeof material[key] === "string" && (material[key] as string).trim().length > 0;
    switch (kind) {
        case "character":
            if (!Array.isArray(material.openings) || material.openings.length === 0) return "角色卡至少要有一条开场白（openings），否则开不了局。";
            return null;
        case "persona": case "base": case "flavor": case "glass": case "strength":
            if (!has("content")) return `${MIX_KIND_LABELS[kind]}缺正文（content）。`;
            return null;
        case "ticket":
            if (!has("contract")) return "小票缺输出契约（contract）。";
            if (!has("renderHtml")) return "小票缺渲染代码（renderHtml）。";
            return null;
        case "garnish":
            if (!has("css")) return "外观缺 CSS（css）。";
            return null;
        case "encore":
            if (!has("renderHtml")) return "尾调缺渲染代码（renderHtml）。";
            return null;
        case "filter":
            if (!Array.isArray(material.rules) || material.rules.length === 0) return "滤网至少要有一条规则（rules）。";
            return null;
        case "mechanism":
            if (!has("script") && !has("panelHtml")) return "机括的钩子逻辑（script）与界面代码（panelHtml）至少要写一样。";
            return null;
    }
}

export function mixToolCreateMaterial(args: Record<string, unknown>): ToolResult {
    const NAME = "创建材料";
    const kind = asKind(args.kind);
    if (!kind) return { name: NAME, success: false, error: `请传材料种类 kind。可选：${MIX_SLOT_ORDER.join(" / ")}` };
    const name = text(args.name).trim();
    if (!name) return { name: NAME, success: false, error: "请传材料名 name。" };

    const now = Date.now();
    const material: Record<string, unknown> = { id: createMixId("mixmat"), kind, name, createdAt: now, updatedAt: now };
    if (kind === "character") {
        material.charName = text(args.charName).trim() || name;
        material.openings = [];
    }
    const hook = text(args.hook).trim();
    if (hook) material.hook = hook;
    const tags = normalizeMixTags(args.tags);
    if (tags.length) material.tags = tags;
    if (args.cover !== undefined) {
        // 封面只有角色卡收：其余种类的列表封面由渲染效果自动生成，不落库、也不上传
        if (kind !== "character") return { name: NAME, success: false, error: "只有角色卡需要 cover——小票/装饰/尾调的列表封面由渲染效果自动生成，不接受封面图。" };
        const cover = normalizeCover(args.cover);
        if (typeof cover !== "string") return { name: NAME, success: false, error: cover.err };
        material.cover = cover;
    }

    const fieldErr = applyContentFields(material, kind, args);
    if (fieldErr) return { name: NAME, success: false, error: fieldErr };
    const invalid = validateMaterial(material, kind);
    if (invalid) return { name: NAME, success: false, error: invalid };

    saveMixMaterial(material as unknown as MixMaterial);
    broadcastCabinetUpdated();
    return {
        name: NAME, success: true,
        data: `已把${MIX_KIND_LABELS[kind]}「${name}」放进酒柜（id: ${material.id}）。用户可在独家特调 App 的酒柜里查看详情与效果预览，然后去吧台配成特调开局。${qualityHints(material, kind)}`,
    };
}

export function mixToolUpdateMaterial(args: Record<string, unknown>): ToolResult {
    const NAME = "更新材料";
    const r = findMaterial(args);
    if (!r.ok) return { name: NAME, success: false, error: r.err };
    const existing = r.ok;
    if (isMixBuiltinId(existing.id)) return { name: NAME, success: false, error: "官方出厂件不可修改。可以参考它另建一件新材料。" };
    if (existing.imported) return { name: NAME, success: false, error: "入柜导入的他人作品不可修改（与酒柜界面同规矩）。可以另建一件自己的材料。" };
    if (args.kind !== undefined && asKind(args.kind) !== existing.kind) {
        return { name: NAME, success: false, error: `材料种类不能改（这件是${MIX_KIND_LABELS[existing.kind]}）。要换类请另建。` };
    }

    const next: Record<string, unknown> = { ...existing };
    const changed: string[] = [];
    const newName = text(args.name).trim();
    if (newName && newName !== existing.name) {
        next.name = newName;
        if (existing.kind === "character") next.charName = text(args.charName).trim() || newName;
        changed.push("name");
    } else if (existing.kind === "character" && text(args.charName).trim()) {
        next.charName = text(args.charName).trim();
        changed.push("charName");
    }
    if (args.hook !== undefined) { next.hook = text(args.hook).trim(); changed.push("hook"); }
    if (args.tags !== undefined) { next.tags = normalizeMixTags(args.tags); changed.push("tags"); }
    if (args.cover !== undefined) {
        if (existing.kind !== "character") return { name: NAME, success: false, error: "只有角色卡需要 cover——小票/装饰/尾调的列表封面由渲染效果自动生成，不接受封面图。" };
        const cover = normalizeCover(args.cover);
        if (typeof cover !== "string") return { name: NAME, success: false, error: cover.err };
        next.cover = cover;
        changed.push("cover");
    }

    const before = JSON.stringify(next);
    const fieldErr = applyContentFields(next, existing.kind, args);
    if (fieldErr) return { name: NAME, success: false, error: fieldErr };
    for (const spec of CONTENT_FIELDS) {
        if (args[spec.key] !== undefined && spec.kinds.includes(existing.kind)) changed.push(spec.key);
    }
    if (!changed.length && before === JSON.stringify(next)) {
        return { name: NAME, success: false, error: "没有传任何要修改的字段。" };
    }
    const invalid = validateMaterial(next, existing.kind);
    if (invalid) return { name: NAME, success: false, error: invalid };

    saveMixMaterial(next as unknown as MixMaterial);
    broadcastCabinetUpdated();
    return { name: NAME, success: true, data: `已更新${MIX_KIND_LABELS[existing.kind]}「${next.name}」的：${[...new Set(changed)].join("、")}。${qualityHints(next, existing.kind)}` };
}

// ── 保存配方 ─────────────────────────────────────────

const SINGLE_KINDS: MixMaterialKind[] = ["character", "persona"];

export function mixToolSaveRecipe(args: Record<string, unknown>): ToolResult {
    const NAME = "保存配方";
    const name = text(args.name).trim();
    if (!name) return { name: NAME, success: false, error: "请给这杯特调起个名（name）。" };
    const slotsArg = args.slots;
    if (!Array.isArray(slotsArg) || slotsArg.length === 0) {
        return { name: NAME, success: false, error: 'slots 必须是非空数组，元素形如 {"kind":"character","material":"材料名或id","when":{…可选生效条件}}。' };
    }

    const slots: Partial<Record<MixMaterialKind, MixSlotEntry[]>> = {};
    const picked: string[] = [];
    for (const [i, item] of slotsArg.entries()) {
        const record = item as Record<string, unknown>;
        const kind = asKind(record?.kind);
        if (!kind) return { name: NAME, success: false, error: `第 ${i + 1} 个槽位的 kind 不合法。可选：${MIX_SLOT_ORDER.join(" / ")}` };
        const ref = text(record?.material).trim();
        if (!ref) return { name: NAME, success: false, error: `第 ${i + 1} 个槽位缺 material（材料名或 id）。` };
        const found = findMaterial({ id: ref, name: ref });
        const material = found.ok ?? findMaterial({ name: ref }).ok;
        if (!material) return { name: NAME, success: false, error: `第 ${i + 1} 个槽位：${found.err ?? `找不到「${ref}」`}` };
        if (material.kind !== kind) {
            return { name: NAME, success: false, error: `第 ${i + 1} 个槽位：「${material.name}」是${MIX_KIND_LABELS[material.kind]}，不是${MIX_KIND_LABELS[kind]}。` };
        }
        const entries = slots[kind] ?? (slots[kind] = []);
        if (SINGLE_KINDS.includes(kind) && entries.length >= 1) {
            return { name: NAME, success: false, error: `${MIX_KIND_LABELS[kind]}槽位只放 1 件。` };
        }
        const entry: MixSlotEntry = { materialId: material.id };
        if (record?.when !== undefined && !SINGLE_KINDS.includes(kind)) {
            const when = normalizePartCondition(record.when);
            if (!when) {
                return { name: NAME, success: false, error: `第 ${i + 1} 个槽位的生效条件不合法。支持：{"type":"turn","after":N} / {"type":"var","name":"…","op":">=","value":"…"} / {"type":"keyword","words":["…"],"within":N} / {"type":"chance","percent":N}。` };
            }
            entry.when = when as MixCondition;
        }
        entries.push(entry);
        picked.push(`${MIX_KIND_LABELS[kind]}「${material.name}」`);
    }
    if (!slots.character?.length) return { name: NAME, success: false, error: "配方必须有一张角色卡，否则开不了局。" };

    const existing = loadMixRecipes().find((r) => r.name === name && !r.imported);
    const now = Date.now();
    saveMixRecipe({
        ...(existing ?? { id: createMixId("mixrec"), createdAt: now, updatedAt: now }),
        name,
        slots,
        imported: undefined,
    });
    broadcastCabinetUpdated();
    return {
        name: NAME, success: true,
        data: `${existing ? "已更新" : "已调好"}特调「${name}」：${picked.join(" + ")}。用户在独家特调 App 的吧台就能选它开局。`,
    };
}
