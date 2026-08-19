// lib/mixology/assembler.ts
// 独家特调 · 装配器：把一杯特调（角色卡 + 各槽材料）装配成提示词。
//
// 一格可以叠多件材料：累加型的格（基底/风味/杯型/苦精）把这一叠依次拼接，
// 择一型的格（面具/小票/尾调）只用第一件。带条件的材料由调用方先筛过再交进来。
//
// 固定装配顺序（创作者不可调，保证"任意搭配都不散架"）：
//   序言 → 基底 → 角色资料 → 世界与剧情 → 风味 → 杯型 → 状态栏契约 → 示例对话
//   → [对话历史] → 苦精（离生成最近，权重最高）
// 开场白作为首条 assistant 消息单独返回，不进系统提示词。
// 所有材料文本支持 {{char}} / {{user}} 宏；空字段整段消失，不留空壳标题。

import type {
    MixCharacterCard,
    MixEncoreMaterial,
    MixMaterial,
    MixMaterialKind,
    MixPersonaMaterial,
    MixState,
    MixTextMaterial,
    MixTicketMaterial,
} from "./types";
import { mixEncoreRenderHtml } from "./types";

export const MIX_DEFAULT_USER_NAME = "你";

// 壳标记用「状态栏」而不是应用里的比喻词「小票」——提示词是写给模型看的，
// 模型不知道"小票"是什么，但一眼能懂"状态栏"。
export const MIX_TICKET_OPEN = "[状态栏]";
export const MIX_TICKET_CLOSE = "[/状态栏]";

/** 小剧场壳标记：尾调写了契约时，AI 的加演内容放进这对标签 */
export const MIX_ENCORE_OPEN = "[小剧场]";
export const MIX_ENCORE_CLOSE = "[/小剧场]";

export type MixAssembleInput = {
    character: MixCharacterCard;
    /**
     * 其余槽位材料：每格是一叠（已由调用方按生效条件筛过、按顺序排好）。
     * 累加型的格（基底/风味/杯型/苦精）整叠依次拼接，择一型的格只看第一件。
     */
    materials: Partial<Record<MixMaterialKind, MixMaterial[]>>;
    /** 用户的名字，空则用默认 */
    userName?: string;
    /** 选用的开场索引，越界时回退到 0 */
    openingIndex?: number;
    /** 当前记住的值，供 {{状态.X}} 宏取用 */
    state?: MixState;
};

export type MixAssembledPrompt = {
    /** 系统提示词（对话历史之前的全部内容） */
    system: string;
    /** 苦精：注入在对话历史之后、本轮生成之前；无苦精材料时为空串 */
    postHistory: string;
    /** 开场白（已替换宏），作为首条 assistant 消息；角色卡没写开场时为空串 */
    opening: string;
    /** 本局是否带小票（运行时据此决定是否剥取小票块） */
    hasTicket: boolean;
    /** 本局尾调是否为 AI 小剧场（有契约且有渲染代码） */
    hasEncore: boolean;
};

function escapeForHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * 替换 {{char}} / {{user}} / {{状态.X}}。
 * escapeHtml：替换结果要插进 HTML（开场画布就是这种情况）时打开——
 * 只转义被替换进去的那几个值，不动作者自己写的标签。这个名字是用户自己填的，
 * 但一个叫「<b>」的名字照样能把画布的结构改坏，所以插进 HTML 前一律转义。
 */
export function applyMixMacros(
    text: string,
    charName: string,
    userName: string,
    state?: MixState,
    options?: { escapeHtml?: boolean },
): string {
    const esc = options?.escapeHtml ? escapeForHtml : (v: string) => v;
    const replaced = text
        .replace(/\{\{\s*char\s*\}\}/gi, esc(charName))
        .replace(/\{\{\s*user\s*\}\}/gi, esc(userName));
    // {{状态.好感度}}：取小票里勾了「记住」的值；没有这个值时整个宏留空，不留占位符
    return replaced.replace(/\{\{\s*状态\s*[.．。]\s*([^}]+?)\s*\}\}/g, (_all, name: string) => {
        const value = state?.[String(name).trim()];
        return value === undefined ? "" : esc(String(value));
    });
}

/** 一叠材料的正文按顺序拼起来（累加型的格用） */
/**
 * 一格里的材料拼成一段的正文。
 * 只叠了一件时正文直接跟在 # 段标题下面——那个段标题就是这一格在界面上的名字；
 * 叠了多件时每件多一层 ##，标题用材料自己的名字（吧台上的叠层本来就是按名字排的）。
 */
function stackBody(materials: MixMaterial[] | undefined, apply: (text: string) => string): string {
    const items = (materials ?? [])
        .map((m) => ({
            name: m.name?.trim() ?? "",
            text: typeof (m as MixTextMaterial).content === "string" ? (m as MixTextMaterial).content.trim() : "",
        }))
        .filter((item) => item.text);
    if (!items.length) return "";
    if (items.length === 1) return apply(items[0].text);
    return items.map((item, i) => `## ${apply(item.name || `第 ${i + 1} 件`)}\n${apply(item.text)}`).join("\n\n");
}

/**
 * 一个输入框 = 一个二级标题段。标题用的就是界面上那个框的标签，
 * 让作者在编辑器里看到的结构和发给模型的结构对得上。空框整段消失，不留空壳标题。
 */
function field(label: string, value: string | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    return `## ${label}\n${trimmed}`;
}

function sectionBlock(title: string, lines: (string | null)[]): string | null {
    const kept = lines.filter((l): l is string => Boolean(l));
    if (!kept.length) return null;
    return `# ${title}\n${kept.join("\n\n")}`;
}

/**
 * 序言。第一句就把「你演谁」点明——这是整份提示词里最该被看见的一件事，
 * 放在最顶上比藏在任何一栏资料里都稳。
 */
function preamble(charName: string): string {
    return [
        `这是一场沉浸式角色扮演，你要扮演的角色是${charName}。`,
        "下方依次给出扮演规则、角色资料与输出要求，请全部遵守；越靠后的要求优先级越高。",
        "\n（# 为分段，## 为该段下的具体条目；更深的层级来自创作者自己的分层。）",
    ].join("");
}

// 正文标记协议是 App 的渲染协议，内置且常驻——放在段首、用户杯型内容之后接，
// 不随材料缺失而消失（装饰 CSS 与正文渲染都依赖这四种标记）。
const PROSE_PROTOCOL = [
    "## 正文标记规则（系统内置）",
    "界面按此渲染，务必遵守：",
    "- 说出口的话用「」包裹；未说出口的心声用 * * 包裹。",
    "- 场景或时间切换时，单独一行用【】标出。",
    "- 需要重读的词可用 ~ ~ 包裹。",
    "- 除以上四种外，不要使用任何其他富文本标记（不用 Markdown 标题、粗体、列表）。",
].join("\n");

/** 状态栏契约段：把小票材料的 contract 包进固定壳指令 */
function ticketSection(ticket: MixTicketMaterial, charName: string, userName: string, state?: MixState): string | null {
    const contract = ticket.contract.trim();
    if (!contract) return null;
    return [
        "# 状态栏",
        `输出格式：每轮回复的最开头，第一行输出 ${MIX_TICKET_OPEN}，随后按「输出契约」的要求逐行填写本轮的实际数据，以 ${MIX_TICKET_CLOSE} 单独一行收束，之后空一行再写正文。任何一轮都不要省略这一段。`,
        "## 输出契约",
        applyMixMacros(contract, charName, userName, state),
    ].join("\n");
}

/** 小剧场契约段：格式说明在前，内容要求在后；契约留空则整段不存在 */
function encoreSection(encore: MixEncoreMaterial, charName: string, userName: string, state?: MixState): string | null {
    const contract = encore.contract?.trim();
    if (!contract) return null;
    return [
        "# 小剧场",
        `输出格式：放在回复最末尾（正文之后），整块用 ${MIX_ENCORE_OPEN}...${MIX_ENCORE_CLOSE} 包裹；是否输出由「输出契约」的条件决定，不输出时整段省略，不要输出空壳。`,
        "## 输出契约",
        applyMixMacros(contract, charName, userName, state),
    ].join("\n");
}

/** 收尾核对清单：放在最后压阵，防止模型写完正文忘了必须输出的块 */
function checklistSection(withTicket: boolean, withEncore: boolean): string | null {
    if (!withTicket && !withEncore) return null;
    const items = ["- 正文符合「正文输出要求」。"];
    if (withTicket) {
        items.push(`- 回复最开头已按「状态栏」的格式输出 ${MIX_TICKET_OPEN}...${MIX_TICKET_CLOSE} 块——任何一轮都不能缺。`);
    }
    if (withEncore) {
        items.push(`- 若本轮满足「小剧场」的输出条件，已用 ${MIX_ENCORE_OPEN}...${MIX_ENCORE_CLOSE} 块输出。`);
    }
    return ["# 输出格式检查", "每轮回复发出前逐项核对：", ...items].join("\n");
}

function exampleSection(card: MixCharacterCard, charName: string, userName: string): string | null {
    const examples = card.examples?.filter((e) => e.text.trim());
    if (!examples?.length) return null;
    const lines = examples.map((e) =>
        `${e.role === "user" ? userName : charName}：${applyMixMacros(e.text.trim(), charName, userName)}`,
    );
    return `# 示例对话\n以下仅为文风示范，不是已发生的剧情：\n${lines.join("\n")}`;
}

export function assembleMixPrompt(input: MixAssembleInput): MixAssembledPrompt {
    const card = input.character;
    const charName = card.charName.trim() || card.name.trim() || "角色";
    const m = input.materials;
    // 择一型的格：取这一叠里的第一件
    const firstOf = <T extends MixMaterial>(kind: MixMaterialKind): T | undefined => {
        const found = m[kind]?.find((item) => item.kind === kind);
        return found as T | undefined;
    };
    const persona = firstOf<MixPersonaMaterial>("persona");
    // 用户的名字：显式传入 > 面具材料里填的 > 默认「你」
    const userName = input.userName?.trim() || persona?.userName?.trim() || MIX_DEFAULT_USER_NAME;
    const ticket = firstOf<MixTicketMaterial>("ticket");
    const encore = firstOf<MixEncoreMaterial>("encore");

    const apply = (text: string) => applyMixMacros(text, charName, userName, input.state);

    // 累加型的格：这一叠里条件满足的全部按顺序拼接
    const baseText = stackBody(m.base, apply);
    const flavorText = stackBody(m.flavor, apply);
    const glassText = stackBody(m.glass, apply);
    const strengthText = stackBody(m.strength, apply);

    const sections: (string | null)[] = [
        preamble(charName),
        baseText ? `# 扮演总纲\n${baseText}` : null,
        sectionBlock("角色资料", [
            `## 角色名\n${charName}`,
            field("基础信息", card.baseInfo),
            field("性格", card.personality),
            field("外貌", card.appearance),
            field("背景", card.background),
        ].map((l) => (l ? apply(l) : l))),
        // 用户资料：{{user}} 是谁。由面具材料提供，帮模型称呼与理解对面的人
        persona && persona.content.trim()
            ? [
                // 标题写「名字」不写「你的名字」：提示词里的「你」指的是模型自己，
                // 用界面上那个词会指代不清。其余标题一律与界面一致。
                persona.userName?.trim()
                    ? `# 用户资料\n## 名字\n${apply(persona.userName.trim())}`
                    : "# 用户资料",
                `## 用户人设\n${apply(persona.content.trim())}`,
            ].join("\n\n")
            : null,
        sectionBlock("世界与剧情", [
            field("世界观", card.worldview),
            // 标题跟编辑器里那个框的标签一字不差；里面的 {{user}} 会在下面统一替换成用户的名字
            field("对{{user}}的初始认知", card.cognition),
            field("关系与身份", card.relations),
            field("当前剧情", card.plot),
            field("附加设定", card.extra),
        ].map((l) => (l ? apply(l) : l))),
        flavorText ? `# 文风\n${flavorText}` : null,
        // 内置协议在前，作者写的正文输出要求接在后面，各自是一个 ## 条目
        `# 正文输出要求\n${PROSE_PROTOCOL}${glassText ? `\n\n## 正文输出要求\n${glassText}` : ""}`,
        ticket ? ticketSection(ticket, charName, userName, input.state) : null,
        encore ? encoreSection(encore, charName, userName, input.state) : null,
        exampleSection(card, charName, userName),
        checklistSection(
            Boolean(ticket?.contract.trim()),
            Boolean(encore?.contract?.trim()),
        ),
    ];

    const openings = card.openings.filter((o) => o.trim());
    const idx = input.openingIndex ?? 0;
    const opening = openings.length
        ? apply(openings[idx >= 0 && idx < openings.length ? idx : 0].trim())
        : "";

    return {
        system: sections.filter((s): s is string => Boolean(s)).join("\n\n"),
        postHistory: strengthText
            ? `【最高优先级要求】\n${strengthText}`
            : "",
        opening,
        hasTicket: Boolean(ticket?.contract.trim() && ticket?.renderHtml.trim()),
        hasEncore: Boolean(encore?.contract?.trim() && encore && mixEncoreRenderHtml(encore).trim()),
    };
}
