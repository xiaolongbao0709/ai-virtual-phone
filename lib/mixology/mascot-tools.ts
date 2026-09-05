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
    normalizeMixConnectorNames,
    normalizeMixDialogueButton,
    MIX_CONNECTOR_NAME_RE,
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
    findMixConnector,
    loadMixConnectors,
    saveMixConnector,
    deleteMixConnector,
} from "./storage";
import { MIX_CONNECTOR_KEY_PLACEHOLDER, MIX_CONNECTOR_PRESETS, parseMixConnectorHeaders } from "./connectors";

import { buildMixCraftSpec } from "./crafting-guides";
import { isMixCardFreeform, MIX_CARD_FIELD_KEYS, normalizeMixCardProfile } from "./card-freeform";
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
            if (isMixCardFreeform(c)) {
                // 一框式：两段正文原样给出（## 小节是作者自己排的），改它要用 profileText / worldText
                lines.push("资料写法：一框式（profileMode = freeform；改资料请传 profileText / worldText 整段正文）");
                field("角色资料", c.profileText); field("世界与剧情", c.worldText);
            } else {
                field("基础信息", c.baseInfo); field("性格", c.personality); field("外貌", c.appearance);
                field("背景", c.background); field("世界观", c.worldview); field("初始认知", c.cognition);
                field("关系与身份", c.relations); field("当前剧情", c.plot); field("附加设定", c.extra);
            }
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
            if (material.trusted) lines.push("运行方式：信任模式（trusted = true，代码直接在对局页面里执行，用 mix.slot / mix.on 登记坑位与钩子）");
            field(material.trusted ? "代码" : "钩子逻辑", material.script); field("界面代码", material.panelHtml);
            field("摆放", material.layout ? mixPanelLayoutSummary(material.layout) : undefined);
            if (material.dialogueButton?.icon) field("对白按钮", `${material.dialogueButton.icon}${material.dialogueButton.title ? ` ${material.dialogueButton.title}` : ""}`);
            if (material.connectors?.length) {
                field("需要的连接器", material.connectors.map((n) => `${n}${findMixConnector(n) ? "（用户本机已配）" : "（用户本机未配，需到酒柜「连接器」里创建）"}`).join("\n"));
            }
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
    { key: "content", kinds: ["persona", "preface", "base", "flavor", "glass", "strength", "checklist"] },
    // 序言可整套覆写各分段标题（对象 {base:"…",character:"…",…}，留空键用默认）
    { key: "sectionTitles", kinds: ["preface"] },
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
    // 一框式资料：profileMode="freeform" 时两段正文各一个字段，上面九个分框字段不再使用
    { key: "profileMode", kinds: ["character"] },
    { key: "profileText", kinds: ["character"] },
    { key: "worldText", kinds: ["character"] },
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
    // 界面要用的连接器名字（字符串数组）；mix.call 只放行声明过的
    { key: "connectors", kinds: ["mechanism"] },
    // 对白按钮：{icon, title}，宿主在每句对白后画图标，点击递进界面 onMixDialogue
    { key: "dialogueButton", kinds: ["mechanism"] },
    // 信任模式：代码直接在页面里跑（不进沙盒）
    { key: "trusted", kinds: ["mechanism"] },
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
            case "trusted": {
                const v = args[spec.key];
                if (v !== true && v !== false) return "trusted 只能是 true（信任模式：代码直接在页面里运行）或 false（沙盒）。";
                if (v) target.trusted = true; else delete target.trusted;
                break;
            }
            case "dialogueButton": {
                const raw = args[spec.key];
                if (raw === null || raw === "" || raw === false) { delete target.dialogueButton; break; }
                const button = normalizeMixDialogueButton(raw);
                if (!button) return 'dialogueButton 必须是 {"icon":"🔊","title":"朗读这句"}（icon 必填，一两个 emoji 或单字）；传 null 取消。';
                target.dialogueButton = button;
                break;
            }
            case "connectors": {
                const names = normalizeMixConnectorNames(args[spec.key]);
                if (Array.isArray(args[spec.key]) && (args[spec.key] as unknown[]).length && !names.length) {
                    return "connectors 必须是名字数组，名字只能用小写字母、数字、-、_（如 [\"tts\"]）。";
                }
                if (names.length) target.connectors = names;
                else delete target.connectors;
                break;
            }
            case "historyFeed": {
                const v = args[spec.key];
                if (v !== "latest" && v !== "all" && v !== "none") return 'historyFeed 只能是 "latest"（只回传最近一轮，默认）、"all"（全部轮次回传）或 "none"（完全不回传）。';
                if (v === "latest") delete target.historyFeed;
                else target.historyFeed = v;
                break;
            }
            case "profileMode": {
                const v = args[spec.key];
                if (v !== "form" && v !== "freeform") return 'profileMode 只能是 "form"（分框填写，默认）或 "freeform"（一框式：角色资料 / 世界与剧情各一段正文）。';
                target.profileMode = v;
                break;
            }
            default: {
                const value = args[spec.key];
                if (typeof value !== "string") return `字段 ${spec.key} 必须是字符串。`;
                target[spec.key] = value;
            }
        }
    }
    if (kind === "character") {
        // 资料模式归一：传了整段正文而没说模式，就视为改用一框式；
        // 一框式的卡再传分框字段会被静默忽略，所以直接拒绝并指路。
        const gaveText = args.profileText !== undefined || args.worldText !== undefined;
        if (gaveText && args.profileMode === undefined && target.profileMode !== "freeform") target.profileMode = "freeform";
        const gaveFields = MIX_CARD_FIELD_KEYS.filter((key) => args[key] !== undefined);
        if (target.profileMode === "freeform" && gaveFields.length) {
            return `这张卡的资料是一框式的，${gaveFields.join("/")} 这些分框字段不会生效。请改传 profileText（角色资料整段）/ worldText（世界与剧情整段），或先传 profileMode:"form" 切回分框再改。`;
        }
        Object.assign(target, normalizeMixCardProfile(target as unknown as MixCharacterCard));
        for (const key of [...MIX_CARD_FIELD_KEYS, "profileMode", "profileText", "worldText"] as const) {
            if (target[key] === undefined) delete target[key];
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
    if (material.profileMode === "freeform") {
        // 一框式看整段：两段各自的体量约等于分框时四五个框的总和
        for (const [key, label] of [["profileText", "角色资料"], ["worldText", "世界与剧情"]] as const) {
            if (len(key) === 0) hints.push(`${label}还空着`);
            else if (len(key) < 240) hints.push(`${label}偏薄（${len(key)} 字），用 ## 小节分开写性格/背景/世界观/关系等，各自用具体细节撑起来`);
        }
    } else {
        for (const [key, label] of [["personality", "性格"], ["background", "背景"], ["worldview", "世界观"], ["relations", "关系与身份"]] as const) {
            if (len(key) === 0) hints.push(`${label}还空着`);
            else if (len(key) < 60) hints.push(`${label}偏薄（${len(key)} 字），用具体行为细节撑起来`);
        }
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
        case "persona": case "preface": case "base": case "flavor": case "glass": case "strength": case "checklist":
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
            if (material.trusted === true && !has("script")) return "信任模式的机括必须有 script（代码在页面里执行，用 mix.slot / mix.on 登记坑位与钩子）。";
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

const SINGLE_KINDS: MixMaterialKind[] = ["character", "persona", "preface"];

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

// ── 连接器 ──────────────────────────────────────────
// 连接器是用户自己的外部接口配置（机括界面用 mix.call 请宿主代调）。
// 小卷可以替用户把连接器建好（预设一键、或自己写地址与模板），但密钥留占位——
// 密钥不该经过对话与模型，用户到酒柜「连接器」里粘上即可。

/** 请求头里的密钥打码：只告诉模型有没有、是不是还留着占位，不回真实值 */
function describeConnectorHeaders(headers: Record<string, string>): string {
    return Object.entries(headers)
        .map(([key, value]) => {
            const secret = /authorization|key|token|secret/i.test(key);
            if (!secret) return `${key}: ${value}`;
            return `${key}: ${value.includes(MIX_CONNECTOR_KEY_PLACEHOLDER) ? "（密钥还是占位，待用户填写）" : "（已填，不显示）"}`;
        })
        .join("；");
}

export function mixToolListConnectors(): ToolResult {
    const NAME = "列出连接器";
    const list = loadMixConnectors();
    const lines: string[] = [];
    lines.push(`本机连接器 ${list.length} 个。`);
    for (const c of list) {
        lines.push(`· ${c.name}${c.note ? `（${c.note}）` : ""} — ${c.method} ${c.url}，响应 ${c.response}${c.preset ? `，预设 ${c.preset}` : ""}`);
        if (Object.keys(c.headers).length) lines.push(`　请求头：${describeConnectorHeaders(c.headers)}`);
    }
    lines.push(`可用预设：${MIX_CONNECTOR_PRESETS.map((p) => `${p.id}（${p.label}）`).join("、")}。`);
    lines.push("官方机括「朗读」需要一个叫 tts 的连接器：装上它，对局里每句对白后面就有一颗喇叭，点一下念这句。");
    return { name: NAME, success: true, data: lines.join("\n") };
}

type HeadersArg = { headers: Record<string, string> } | { err: string };
function normalizeHeadersArg(value: unknown): HeadersArg {
    if (value === undefined) return { headers: {} };
    if (typeof value === "string") return { headers: parseMixConnectorHeaders(value) };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { err: 'headers 必须是对象 {"名字":"值"} 或一行一条「名字: 值」的文本。' };
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const name = key.trim();
        if (!name) continue;
        if (typeof raw !== "string") return { err: `请求头 ${name} 的值必须是字符串。` };
        out[name] = raw;
    }
    return { headers: out };
}

export function mixToolSaveConnector(args: Record<string, unknown>): ToolResult {
    const NAME = "创建连接器";
    const presetId = text(args.preset).trim();
    const preset = presetId ? MIX_CONNECTOR_PRESETS.find((p) => p.id === presetId) : null;
    if (presetId && !preset) {
        return { name: NAME, success: false, error: `没有叫 ${presetId} 的预设。可选：${MIX_CONNECTOR_PRESETS.map((p) => p.id).join(" / ")}` };
    }
    const built = preset?.build();
    const name = (text(args.name).trim() || built?.name || "").toLowerCase();
    if (!MIX_CONNECTOR_NAME_RE.test(name)) {
        return { name: NAME, success: false, error: "name 只能用小写字母、数字、-、_，以字母或数字开头，最长 32 位（如 tts）。" };
    }
    const url = text(args.url).trim() || built?.url || "";
    try {
        const parsed = new URL(url.replace(/\{\{[^}]*\}\}/g, "x"));
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad");
    } catch {
        return { name: NAME, success: false, error: "url 要是完整的 http(s) 地址（用预设可不传）。" };
    }
    const headersArg = normalizeHeadersArg(args.headers);
    if ("err" in headersArg) return { name: NAME, success: false, error: headersArg.err };
    const headers = Object.keys(headersArg.headers).length ? headersArg.headers : built?.headers ?? {};
    const method = args.method === "GET" ? "GET" : args.method === "POST" || args.method === undefined ? (built?.method ?? "POST") : null;
    if (!method) return { name: NAME, success: false, error: 'method 只能是 "POST" 或 "GET"。' };
    const response = args.response === undefined ? (built?.response ?? "json") : args.response;
    if (response !== "json" && response !== "text" && response !== "blob") {
        return { name: NAME, success: false, error: 'response 只能是 "json"（解析成对象）、"text" 或 "blob"（二进制转 data: URL）。' };
    }
    const body = args.body === undefined ? (built?.body ?? "") : text(args.body);
    if (method === "POST" && !body.trim() && !preset) {
        return { name: NAME, success: false, error: "POST 连接器需要 body 请求体模板（{{参数名}} 占位，可写 {{参数名|默认值}}）。" };
    }

    const existing = findMixConnector(name);
    if (existing && args.overwrite !== true) {
        return { name: NAME, success: false, error: `已经有叫「${name}」的连接器了。要覆盖请再传 overwrite: true；要保留就换个名字。` };
    }
    const note = text(args.note).trim() || built?.note;
    saveMixConnector({
        id: existing?.id ?? createMixId("mixconn"),
        name,
        note: note || undefined,
        url,
        method,
        headers,
        body,
        response,
        preset: preset?.id ?? existing?.preset,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
    });
    const placeholder = Object.values(headers).some((v) => v.includes(MIX_CONNECTOR_KEY_PLACEHOLDER));
    return {
        name: NAME, success: true,
        data: `连接器「${name}」已${existing ? "更新" : "创建"}（${method} ${url}）。`
            + (placeholder
                ? "\n密钥还是占位：请提醒用户到 独家特调 → 酒柜 → 右上角「连接器」→ 点开这一条，把请求头里的「你的密钥」换成自己的 API Key 并保存（可点「发一次试试」验证）。不要向用户索要密钥，密钥不经过对话。"
                : "\n用户可到 独家特调 → 酒柜 → 「连接器」里查看或试调用。"),
    };
}

export function mixToolDeleteConnector(args: Record<string, unknown>): ToolResult {
    const NAME = "删除连接器";
    const name = text(args.name).trim().toLowerCase();
    const existing = name ? findMixConnector(name) : null;
    if (!existing) return { name: NAME, success: false, error: `本机没有叫「${name || "（空）"}」的连接器。可先用 列出连接器 查看。` };
    deleteMixConnector(existing.id);
    return { name: NAME, success: true, data: `连接器「${name}」已删除。用到它的机括调用时会提示用户重新创建。` };
}
