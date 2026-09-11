// lib/mixology/prose.ts
// 独家特调 · 正文语义协议：App 自有解析器，创作者零正则。
//
// 五种标记（由官方杯型引导 AI 书写，装饰 CSS 只管上色）：
//   「对白」   → dialogue    *心声*   → thought（整句斜体）
//   【场景】   → scene（独占一行，渲染成 — 场景 — 的过场行）
//   ~强调~    → accent      其余     → narration（普通叙述）
// 状态栏块 [状态栏]...[/状态栏] 在解析正文前剥离，交给沙盒 iframe 渲染。
// 另外两种"块"：独立成段、从 < 开头的 HTML 片段，以及 ``` 围起来的代码块——
// HTML（含 ```html）交给沙盒框就地渲染，其他代码按等宽块显示；块内不做标记解析。

import type { MixFilterRule } from "./types";

export type MixProseSegmentType = "dialogue" | "thought" | "accent" | "narration";

/**
 * 按滤网规则清洗正文。只在拆完状态栏/小剧场块之后调用（规则碰不到块数据）：
 * - mode="context"：回复入库前清洗一次（引擎调用）
 * - mode="display"：渲染前清洗（界面调用，不改存储）
 * 单条正则编译失败就跳过那条，绝不因为规则写错拦住整轮。
 */
export function applyMixFilterRules(
    text: string,
    rules: MixFilterRule[] | undefined,
    mode: MixFilterRule["mode"],
): string {
    if (!text || !rules?.length) return text;
    let out = text;
    for (const rule of rules) {
        if (rule.mode !== mode || !rule.find) continue;
        try {
            out = out.replace(new RegExp(rule.find, "g"), rule.replace ?? "");
        } catch {
            // 正则写错：这条作废，其余照跑
        }
    }
    return out;
}

/** 对白/心声内部的强调子段：~强调~ 可以嵌在「」与 *…* 里面 */
export type MixProseInner = {
    type: "plain" | "accent";
    text: string;
};

export type MixProseSegment = {
    type: MixProseSegmentType;
    /** 原文（对白含「」引号本体），无嵌套时直接整段渲染 */
    text: string;
    /** 对白/心声里嵌了 ~强调~ 时的子段序列（不含对白引号）；没嵌套则缺省 */
    inner?: MixProseInner[];
};

export type MixProseParagraph =
    | { type: "scene"; text: string }
    | { type: "text"; segments: MixProseSegment[] }
    /** HTML 片段（模型直接写的标签，或 ```html 代码块）：沙盒框就地渲染 */
    | { type: "html"; html: string }
    /** 其他代码块：等宽显示，lang 是 ``` 后面写的语言名（可空） */
    | { type: "code"; lang: string; code: string };

export type MixProseParseOptions = {
    /** 流式过程中：没闭合的 HTML/代码块先按原文显示，闭合了再渲染，免得半截 HTML 闪来闪去 */
    streaming?: boolean;
};

// 兼容旧标签（[小票]/[尾调]）、全角括号与标签内空格——模型输出没那么规矩。
// 开标签可带块名（[状态栏:心情卡]，冒号认全半角与间隔号）——一轮多块时靠名字对号入座。
type TagFamily = { open: RegExp; close: RegExp; openLine: RegExp };

const TAG_NAME = "(?:[:：·・]\\s*([^\\]】]*?))?";

function makeFamily(names: string): TagFamily {
    return {
        open: new RegExp(`[\\[【]\\s*(?:${names})\\s*${TAG_NAME}\\s*[\\]】]`, "g"),
        close: new RegExp(`[\\[【]\\s*\\/\\s*(?:${names})\\s*[\\]】]`, "g"),
        // 截断兜底只认"行首"的开标签，避免误伤正文里顺嘴提到的标签字样
        openLine: new RegExp(`(?:^|\\n)\\s*[\\[【]\\s*(?:${names})\\s*${TAG_NAME}\\s*[\\]】]`, "g"),
    };
}

const TICKET_TAGS = makeFamily("状态栏|小票");
const ENCORE_TAGS = makeFamily("小剧场|尾调");

function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
    re.lastIndex = 0;
    let last: RegExpExecArray | null = null;
    for (let m = re.exec(text); m; m = re.exec(text)) last = m;
    return last;
}

/** 剥出来的一块：name 来自开标签里的块名（[状态栏:心情卡]），旧格式没有 */
export type MixExtractedBlock = {
    name?: string;
    raw: string;
};

/** 配对策略「最后闭合 + 它前面最近的开标签」，正文提及标签字样不会吞正文；块按原文顺序返回 */
function pullFamily(text: string, tags: TagFamily): { text: string; blocks: MixExtractedBlock[] } {
    const blocks: MixExtractedBlock[] = [];
    for (;;) {
        const close = lastMatch(tags.close, text);
        if (!close) break;
        const open = lastMatch(tags.open, text.slice(0, close.index));
        if (!open) break;
        const inner = text.slice(open.index + open[0].length, close.index).trim();
        if (inner) {
            const name = open[1]?.trim();
            // 从后往前剥，往队首塞才是原文顺序
            blocks.unshift(name ? { name, raw: inner } : { raw: inner });
        }
        text = (text.slice(0, open.index) + text.slice(close.index + close[0].length)).trim();
    }
    return { text, blocks };
}

/**
 * 流式过程中显示的内容：原文一字不扣，照流。
 * 状态栏/小剧场块、机括的标记行（〔选项〕〔记〕这类）全都原样流出来——
 * 模型写到哪用户看到哪，任何扣留都会让画面在那几秒定格、看起来像卡死
 * （机括标记行通常是回复最后一行，扣末尾行等于把整段收尾都藏了）。
 * 落库那一刻块换成正式壳渲染、标记行被钩子摘走变成面板内容，
 * 短暂的"变身"就是流式与成品之间该有的交接，不必藏。
 */
export function mixStreamText(partial: string): string {
    return String(partial ?? "");
}

export function extractMixBlocks(rawInput: string): {
    text: string;
    /** 第一块（多数对局仍是单块，也是旧调用方要的那份） */
    ticketRaw?: string;
    encoreRaw?: string;
    /** 全部块，按原文顺序；一轮多个状态栏/小剧场时靠它对号入座 */
    tickets: MixExtractedBlock[];
    encores: MixExtractedBlock[];
} {
    const afterEncore = pullFamily(rawInput, ENCORE_TAGS);
    const afterTicket = pullFamily(afterEncore.text, TICKET_TAGS);
    let text = afterTicket.text;
    const tickets = afterTicket.blocks;
    const encores = afterEncore.blocks;
    {
        // 漏写闭合（生成截断/流式半途）的兜底：还残留在正文里的行首开标签，
        // 其后的一切算进这一块。多块并行时前面几块已闭合剥走，这里兜的是最后那半块。
        const tOpen = lastMatch(TICKET_TAGS.openLine, text);
        const eOpen = lastMatch(ENCORE_TAGS.openLine, text);
        const pick = tOpen && eOpen ? (tOpen.index > eOpen.index ? "t" : "e") : tOpen ? "t" : eOpen ? "e" : null;
        if (pick) {
            const m = (pick === "t" ? tOpen : eOpen) as RegExpExecArray;
            const inner = text.slice(m.index + m[0].length).trim();
            if (inner) {
                const name = m[1]?.trim();
                const block = name ? { name, raw: inner } : { raw: inner };
                if (pick === "t") tickets.push(block);
                else encores.push(block);
                text = text.slice(0, m.index).trim();
            }
        }
    }
    return { text, ticketRaw: tickets[0]?.raw, encoreRaw: encores[0]?.raw, tickets, encores };
}

/** 兼容旧调用：只关心状态栏 */
export function extractMixTicket(raw: string): { text: string; ticketRaw?: string } {
    const result = extractMixBlocks(raw);
    return { text: result.text, ticketRaw: result.ticketRaw };
}

// 强调认全半角波浪号（模型两种都写）；对白同理兼容双引号——模型在长篇里经常
// 滑回 “” / ""，认下来照样当对白渲染。只认这一层：存储一个字不改，正文永远是
// 模型写的原样，回传给模型的历史也照旧。只吃单行、非空、不过长的一段，
// 免得把跨段落的引号并成一大坨。
// 对白/心声先整段匹配，强调再进去嵌套解析
const INLINE_RE = /「([^」]*)」|[“"]([^”"\n]{1,200})[”"]|\*([^*\n]+)\*|[~～]([^~～\n]+)[~～]/g;
const ACCENT_RE = /[~～]([^~～\n]+)[~～]/g;

/** 把一段文字按 ~强调~ 拆成子段；没有强调返回 undefined（走整段渲染的旧路） */
function parseAccentRuns(text: string): MixProseInner[] | undefined {
    ACCENT_RE.lastIndex = 0;
    if (!ACCENT_RE.test(text)) return undefined;
    const runs: MixProseInner[] = [];
    let cursor = 0;
    ACCENT_RE.lastIndex = 0;
    for (let match = ACCENT_RE.exec(text); match; match = ACCENT_RE.exec(text)) {
        if (match.index > cursor) runs.push({ type: "plain", text: text.slice(cursor, match.index) });
        runs.push({ type: "accent", text: match[1] });
        cursor = match.index + match[0].length;
    }
    if (cursor < text.length) runs.push({ type: "plain", text: text.slice(cursor) });
    return runs;
}

function parseInline(line: string): MixProseSegment[] {
    const segments: MixProseSegment[] = [];
    let cursor = 0;
    INLINE_RE.lastIndex = 0;
    for (let match = INLINE_RE.exec(line); match; match = INLINE_RE.exec(line)) {
        if (match.index > cursor) {
            segments.push({ type: "narration", text: line.slice(cursor, match.index) });
        }
        // 「」与双引号都是对白，一律按「」渲染，看不出模型当时掉没掉格式
        const said = match[1] ?? match[2];
        if (said !== undefined) segments.push({ type: "dialogue", text: `「${said}」`, inner: parseAccentRuns(said) });
        else if (match[3] !== undefined) segments.push({ type: "thought", text: match[3], inner: parseAccentRuns(match[3]) });
        else segments.push({ type: "accent", text: match[4] });
        cursor = match.index + match[0].length;
    }
    if (cursor < line.length) {
        segments.push({ type: "narration", text: line.slice(cursor) });
    }
    return segments;
}

// ── HTML / 代码块 ─────────────────────────────────────
// 只认"行首就是标签"的行作为 HTML 块的开头：叙述里偶尔夹一个 <b> 不算。
// 用开/闭标签配平来找块尾（自闭合与 void 元素不计深度），配平到 0 的那一行结束。
const HTML_BLOCK_START_RE = /^<([a-zA-Z][\w-]*)(?:\s[^<>]*)?\/?>/;
const HTML_TAG_RE = /<(\/?)([a-zA-Z][\w-]*)[^<>]*?(\/?)>/g;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_LANGS = new Set(["html", "htm", "xml", "svg"]);

/** 这一行让标签深度变化了多少 */
function tagDepthDelta(line: string): number {
    let delta = 0;
    HTML_TAG_RE.lastIndex = 0;
    for (let m = HTML_TAG_RE.exec(line); m; m = HTML_TAG_RE.exec(line)) {
        const name = m[2].toLowerCase();
        if (VOID_TAGS.has(name) || m[3] === "/") continue;
        delta += m[1] === "/" ? -1 : 1;
    }
    return delta;
}

type OpenBlock =
    | { kind: "code"; lang: string; lines: string[] }
    | { kind: "html"; lines: string[]; depth: number };

function pushTextLine(paragraphs: MixProseParagraph[], rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    const scene = line.match(/^【(.+)】$/);
    if (scene) {
        paragraphs.push({ type: "scene", text: scene[1].trim() });
        return;
    }
    const segments = parseInline(line);
    if (segments.length) paragraphs.push({ type: "text", segments });
}

function closeBlock(paragraphs: MixProseParagraph[], block: OpenBlock): void {
    const body = block.lines.join("\n").trim();
    if (!body) return;
    if (block.kind === "html" || HTML_LANGS.has(block.lang)) paragraphs.push({ type: "html", html: body });
    else paragraphs.push({ type: "code", lang: block.lang, code: body });
}

/**
 * 把 AI 正文解析成段落序列。
 * 段落按行切分；整行被【】包裹的行视为场景过场，行首是标签的 HTML 片段与 ``` 代码块
 * 整块成段（块内不做标记解析），其余走内联解析。
 */
export function parseMixProse(text: string, options: MixProseParseOptions = {}): MixProseParagraph[] {
    const paragraphs: MixProseParagraph[] = [];
    let block: OpenBlock | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (block?.kind === "code") {
            if (/^```/.test(line)) { closeBlock(paragraphs, block); block = null; }
            else block.lines.push(rawLine);
            continue;
        }
        if (block?.kind === "html") {
            block.lines.push(rawLine);
            block.depth += tagDepthDelta(rawLine);
            if (block.depth <= 0) { closeBlock(paragraphs, block); block = null; }
            continue;
        }
        if (!line) continue;
        const fence = line.match(/^```\s*([\w+-]*)\s*$/);
        if (fence) {
            block = { kind: "code", lang: fence[1].toLowerCase(), lines: [] };
            continue;
        }
        if (HTML_BLOCK_START_RE.test(line)) {
            const depth = tagDepthDelta(rawLine);
            if (depth <= 0) paragraphs.push({ type: "html", html: line });
            else block = { kind: "html", lines: [rawLine], depth };
            continue;
        }
        pushTextLine(paragraphs, rawLine);
    }
    if (block) {
        // 没闭合：流式中先按原文一行行显示；成品里模型忘了闭合也照渲染，浏览器兜得住
        if (options.streaming) for (const l of block.lines) pushTextLine(paragraphs, l);
        else closeBlock(paragraphs, block);
    }
    return paragraphs;
}
