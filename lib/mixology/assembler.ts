// lib/mixology/assembler.ts
// 独家特调 · 装配器：把一杯特调（角色卡 + 各槽材料）装配成提示词。
//
// 一格可以叠多件材料：累加型的格（基底/风味/杯型/苦精）把这一叠依次拼接，
// 小票/尾调每件各自成块（一轮可同时带多个状态栏/小剧场，多块时开标签带名字），
// 择一型的格（角色卡/面具）只用第一件。带条件的材料由调用方先筛过再交进来。
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
    MixSectionTitleKey,
    MixState,
    MixTextMaterial,
    MixTicketMaterial,
} from "./types";
import { MIX_SECTION_TITLE_DEFAULTS, mixEncoreRenderHtml } from "./types";
import type { MixHookSection } from "./mechanism-protocol";
import { MIX_CARD_NAME_LABEL, isMixCardFreeform, mixCardProfileText, mixCardTextHasNameHeading, mixCardWorldText } from "./card-freeform";

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
     * 累加型的格（基底/风味/杯型/苦精）整叠依次拼接，小票/尾调每件各自成块，
     * 择一型的格（角色卡/面具）只看第一件。
     */
    materials: Partial<Record<MixMaterialKind, MixMaterial[]>>;
    /** 用户的名字，空则用默认 */
    userName?: string;
    /** 选用的开场索引，越界时回退到 0 */
    openingIndex?: number;
    /** 当前记住的值，供 {{状态.X}} 宏取用 */
    state?: MixState;
    /** 机括落杯前钩子挂进来的段：按 at 接在对应分段之后，标题由机括自带 */
    sections?: MixHookSection[];
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

function sectionBlock(title: string, lines: (string | null)[]): string | null {
    const kept = lines.filter((l): l is string => Boolean(l));
    if (!kept.length) return null;
    return `# ${title}\n${kept.join("\n\n")}`;
}

// 序言是一种材料（kind: "preface"，择一）：配了就用材料内容，没配这一段就
// 不存在——与基底/杯型同规则，绝不暗地里垫默认（官方出厂序言在槽位候选
// 第一位，想要默认文案选它即可）。

// 正文标记协议是 App 的渲染协议，内置且常驻——放在段首、用户杯型内容之后接，
// 不随材料缺失而消失（装饰 CSS 与正文渲染都依赖这四种标记）。
const PROSE_PROTOCOL = [
    "## 正文标记规则（系统内置）",
    "界面按此渲染，务必遵守：",
    "- 说出口的话用「」包裹；未说出口的心声用 * * 包裹。",
    "- 场景或时间切换时，单独一行用【】标出。",
    "- 需要重读的词可用 ~ ~ 包裹。",
    "- 除以上四种外，不要使用任何其他富文本标记（不用 Markdown 标题、粗体、列表）。",
    "- 仅当剧情确实需要呈现表格、卡片、图示、界面之类的版式时，可以写一段独立成段、从 < 开头的 HTML 片段（含内联 CSS），界面会就地渲染；代码或数据用 ``` 围起来。日常叙事不要用。",
].join("\n");

/** 具名开标签：一轮多块时块靠名字对号入座（[状态栏:心情卡]） */
export function mixNamedOpen(open: string, name: string): string {
    return `${open.slice(0, -1)}:${name.trim()}]`;
}

/**
 * 状态栏契约段：把小票材料的 contract 包进固定壳指令。
 * 单张 = 老格式（不具名的壳，旧对局提示词逐字不变）；
 * 多张 = 每张一块，开标签带小票名，回复开头按顺序依次输出。
 */
function ticketSection(tickets: MixTicketMaterial[], charName: string, userName: string, state: MixState | undefined, title: string): string | null {
    const withContract = tickets.filter((t) => t.contract.trim());
    if (!withContract.length) return null;
    if (withContract.length === 1) {
        return [
            `# ${title}`,
            `输出格式：每轮回复的最开头，第一行输出 ${MIX_TICKET_OPEN}，随后按「输出契约」的要求逐行填写本轮的实际数据，以 ${MIX_TICKET_CLOSE} 单独一行收束，之后空一行再写正文。任何一轮都不要省略这一段。`,
            "## 输出契约",
            applyMixMacros(withContract[0].contract.trim(), charName, userName, state),
        ].join("\n");
    }
    const lines = [
        `# ${title}`,
        `输出格式：本局有 ${withContract.length} 个状态栏，每轮回复的最开头按下面的顺序逐个输出，彼此独立成块：每块第一行输出带名字的开标签（如 ${mixNamedOpen(MIX_TICKET_OPEN, withContract[0].name)}），随后按该块「输出契约」的要求逐行填写本轮的实际数据，以 ${MIX_TICKET_CLOSE} 单独一行收束。全部块输出完之后空一行再写正文。任何一轮都不要省略任何一块。`,
    ];
    for (const ticket of withContract) {
        lines.push(
            `## ${mixNamedOpen(MIX_TICKET_OPEN, ticket.name)} 的输出契约`,
            applyMixMacros(ticket.contract.trim(), charName, userName, state),
        );
    }
    return lines.join("\n");
}

/**
 * 小剧场契约段：格式说明在前，内容要求在后；没写契约的不进提示词。
 * 单出 = 老格式；多出 = 每出一块、开标签带名。
 * 每轮必演——壳指令不给"这轮好像不用演"的台阶：条件式措辞会让模型在长篇里
 * 越来越常把末尾块整个吞掉（历史先例又会放大这一点）。创作者真想按条件上演，
 * 在契约里自己写条件，契约的要求压得过这句默认。
 */
function encoreSection(encores: MixEncoreMaterial[], charName: string, userName: string, state: MixState | undefined, title: string): string | null {
    const withContract = encores.filter((e) => e.contract?.trim());
    if (!withContract.length) return null;
    if (withContract.length === 1) {
        return [
            `# ${title}`,
            `输出格式：每轮回复的最末尾（正文之后）输出这一块，整块用 ${MIX_ENCORE_OPEN}...${MIX_ENCORE_CLOSE} 包裹，内容按「输出契约」的要求写。任何一轮都不要省略这一块。`,
            "## 输出契约",
            applyMixMacros(withContract[0].contract!.trim(), charName, userName, state),
        ].join("\n");
    }
    const lines = [
        `# ${title}`,
        `输出格式：本局有 ${withContract.length} 个小剧场，每轮回复的最末尾（正文之后）按下面的顺序全部输出，彼此独立成块：每块用带名字的开标签（如 ${mixNamedOpen(MIX_ENCORE_OPEN, withContract[0].name)}）开头，以 ${MIX_ENCORE_CLOSE} 收束。任何一轮任何一块都不要省略。`,
    ];
    for (const encore of withContract) {
        lines.push(
            `## ${mixNamedOpen(MIX_ENCORE_OPEN, encore.name)} 的输出契约`,
            applyMixMacros(encore.contract!.trim(), charName, userName, state),
        );
    }
    return lines.join("\n");
}

/** 收尾核对清单：放在最后压阵，防止模型写完正文忘了必须输出的块。
 *  段名引用跟随序言的自定义标题（refs），改了标题清单仍指得到对应段。 */
function checklistSection(
    ticketCount: number,
    encoreCount: number,
    title: string,
    refs: { glass: string; ticket: string; encore: string },
): string | null {
    if (!ticketCount && !encoreCount) return null;
    const items = [`- 正文符合「${refs.glass}」。`];
    if (ticketCount === 1) {
        items.push(`- 回复最开头已按「${refs.ticket}」的格式输出 ${MIX_TICKET_OPEN}...${MIX_TICKET_CLOSE} 块——任何一轮都不能缺。`);
    } else if (ticketCount > 1) {
        items.push(`- 回复最开头已按「${refs.ticket}」的格式与顺序输出全部 ${ticketCount} 块（每块开标签带名字）——任何一轮任何一块都不能缺。`);
    }
    if (encoreCount === 1) {
        items.push(`- 回复最末尾已按「${refs.encore}」的格式输出 ${MIX_ENCORE_OPEN}...${MIX_ENCORE_CLOSE} 块——任何一轮都不能缺。`);
    } else if (encoreCount > 1) {
        items.push(`- 回复最末尾已按「${refs.encore}」的格式与顺序输出全部 ${encoreCount} 块（每块开标签带名字）——任何一轮任何一块都不能缺。`);
    }
    return [`# ${title}`, "每轮回复发出前逐项核对：", ...items].join("\n");
}

function exampleSection(card: MixCharacterCard, charName: string, userName: string, title: string): string | null {
    const examples = card.examples?.filter((e) => e.text.trim());
    if (!examples?.length) return null;
    const lines = examples.map((e) =>
        `${e.role === "user" ? userName : charName}：${applyMixMacros(e.text.trim(), charName, userName)}`,
    );
    return `# ${title}\n以下仅为文风示范，不是已发生的剧情：\n${lines.join("\n")}`;
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
    const preface = firstOf<MixTextMaterial>("preface");
    // 用户的名字：显式传入 > 面具材料里填的 > 默认「你」
    const userName = input.userName?.trim() || persona?.userName?.trim() || MIX_DEFAULT_USER_NAME;
    // 小票/尾调是多块并行的格：条件命中的全部生效，每件各自成块
    const tickets = (m.ticket ?? []).filter((item): item is MixTicketMaterial => item.kind === "ticket");
    const encores = (m.encore ?? []).filter((item): item is MixEncoreMaterial => item.kind === "encore");

    const apply = (text: string) => applyMixMacros(text, charName, userName, input.state);
    // 两段资料的正文：表单式由各框拼成 ## 小节，一框式取作者写的原文（口径见 card-freeform）
    const profileText = mixCardProfileText(card);
    const worldText = mixCardWorldText(card);

    // 分段标题：序言材料可整套覆写（让标题措辞跟上序言定的基调），
    // 留空/缺省的键用默认标题；标题里也吃 {{char}}/{{user}} 宏。
    const customTitles = preface?.sectionTitles ?? {};
    const sectionTitle = (key: MixSectionTitleKey): string => {
        const raw = customTitles[key];
        const custom = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
        return custom ? apply(custom) : MIX_SECTION_TITLE_DEFAULTS[key];
    };

    // 累加型的格：这一叠里条件满足的全部按顺序拼接
    const baseText = stackBody(m.base, apply);
    const flavorText = stackBody(m.flavor, apply);
    const glassText = stackBody(m.glass, apply);
    const strengthText = stackBody(m.strength, apply);

    // 机括挂段：某一段本身为空（没装面具、没有文风）时挂在它上面的内容照样出现，
    // 位置就是那一段本来该在的位置。宏照常替换，多件机括按钩子跑的顺序依次接。
    const hung = (key: MixSectionTitleKey): string[] =>
        (input.sections ?? []).filter((item) => item.at === key).map((item) => apply(item.text));
    const withHung = (key: MixSectionTitleKey, own: string | null): string | null => {
        const extra = hung(key);
        if (!extra.length) return own;
        return [own, ...extra].filter((part): part is string => Boolean(part)).join("\n\n");
    };

    const sections: (string | null)[] = [
        // 序言：配了才有，宏照常替换；没配整段消失（与其他段一致）
        preface?.content.trim() ? apply(preface.content.trim()) : null,
        withHung("base", baseText ? `# ${sectionTitle("base")}\n${baseText}` : null),
        // 角色资料：分框表单时每框一个 ##；一框式时作者写的正文（含自己的 ## 小节）原样进来。
        // 角色名两种模式都由卡名提供——一框式正文里作者自己写了 ## 角色名 才不重复补。
        withHung("character", sectionBlock(sectionTitle("character"), [
            isMixCardFreeform(card) && mixCardTextHasNameHeading(profileText) ? null : `## ${MIX_CARD_NAME_LABEL}\n${charName}`,
            profileText || null,
        ].map((l) => (l ? apply(l) : l)))),
        // 用户资料：{{user}} 是谁。由面具材料提供，帮模型称呼与理解对面的人
        withHung("persona", persona && persona.content.trim()
            ? [
                // 标题写「名字」不写「你的名字」：提示词里的「你」指的是模型自己，
                // 用界面上那个词会指代不清。其余标题一律与界面一致。
                persona.userName?.trim()
                    ? `# ${sectionTitle("persona")}\n## 名字\n${apply(persona.userName.trim())}`
                    : `# ${sectionTitle("persona")}`,
                `## 用户人设\n${apply(persona.content.trim())}`,
            ].join("\n\n")
            : null),
        // 世界与剧情：同上。分框时标题跟编辑器里那个框的标签一字不差（含「对{{user}}的初始认知」），
        // 里面的 {{user}} 会统一替换成用户的名字
        withHung("world", sectionBlock(sectionTitle("world"), [worldText || null].map((l) => (l ? apply(l) : l)))),
        withHung("flavor", flavorText ? `# ${sectionTitle("flavor")}\n${flavorText}` : null),
        // 内置协议在前，作者写的正文输出要求接在后面，各自是一个 ## 条目
        withHung("glass", `# ${sectionTitle("glass")}\n${PROSE_PROTOCOL}${glassText ? `\n\n## ${sectionTitle("glass")}\n${glassText}` : ""}`),
        withHung("ticket", ticketSection(tickets, charName, userName, input.state, sectionTitle("ticket"))),
        withHung("encore", encoreSection(encores, charName, userName, input.state, sectionTitle("encore"))),
        withHung("examples", exampleSection(card, charName, userName, sectionTitle("examples"))),
        withHung("checklist", checklistSection(
            tickets.filter((t) => t.contract.trim()).length,
            encores.filter((e) => e.contract?.trim()).length,
            sectionTitle("checklist"),
            { glass: sectionTitle("glass"), ticket: sectionTitle("ticket"), encore: sectionTitle("encore") },
        )),
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
        hasTicket: tickets.some((t) => t.contract.trim() && t.renderHtml.trim()),
        hasEncore: encores.some((e) => e.contract?.trim() && mixEncoreRenderHtml(e).trim()),
    };
}
