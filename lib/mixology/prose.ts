// lib/mixology/prose.ts
// 独家特调 · 正文语义协议：App 自有解析器，创作者零正则。
//
// 五种标记（由官方杯型引导 AI 书写，装饰 CSS 只管上色）：
//   「对白」   → dialogue    *心声*   → thought（整句斜体）
//   【场景】   → scene（独占一行，渲染成 — 场景 — 的过场行）
//   ~强调~    → accent      其余     → narration（普通叙述）
// 状态栏块 [状态栏]...[/状态栏] 在解析正文前剥离，交给沙盒 iframe 渲染。

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

export type MixProseSegment = {
    type: MixProseSegmentType;
    text: string;
};

export type MixProseParagraph =
    | { type: "scene"; text: string }
    | { type: "text"; segments: MixProseSegment[] };

// 兼容旧标签（[小票]/[尾调]）、全角括号与标签内空格——模型输出没那么规矩
type TagFamily = { open: RegExp; close: RegExp; openLine: RegExp };

function makeFamily(names: string): TagFamily {
    return {
        open: new RegExp(`[\\[【]\\s*(?:${names})\\s*[\\]】]`, "g"),
        close: new RegExp(`[\\[【]\\s*\\/\\s*(?:${names})\\s*[\\]】]`, "g"),
        // 截断兜底只认"行首"的开标签，避免误伤正文里顺嘴提到的标签字样
        openLine: new RegExp(`(?:^|\\n)\\s*[\\[【]\\s*(?:${names})\\s*[\\]】]`, "g"),
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

/** 配对策略「最后闭合 + 它前面最近的开标签」，正文提及标签字样不会吞正文 */
function pullFamily(text: string, tags: TagFamily): { text: string; raw?: string } {
    let raw: string | undefined;
    for (;;) {
        const close = lastMatch(tags.close, text);
        if (!close) break;
        const open = lastMatch(tags.open, text.slice(0, close.index));
        if (!open) break;
        const inner = text.slice(open.index + open[0].length, close.index).trim();
        if (!raw && inner) raw = inner;
        text = (text.slice(0, open.index) + text.slice(close.index + close[0].length)).trim();
    }
    return { text, raw };
}

/** 从 AI 原文剥离状态栏与小剧场块；漏写闭合（生成截断）时走行首开标签兜底 */
/**
 * 流式过程中能安全显示的那一段正文。
 * 状态栏 / 小剧场块交给 extractMixBlocks 兜住——它认得"只开没关"的块，
 * 半张状态栏不会漏到正文里。机括的标记行（〔记〕这类）要等出杯后才被摘掉，
 * 流式里会先闪一下再消失，所以末尾那一行只要以 〔 或 [ 开头就先不显示：
 * 它要么是块的开头，要么是标记行，两种最终都不属于正文。
 */
export function mixStreamText(partial: string): string {
    const lines = extractMixBlocks(String(partial ?? "")).text.split("\n");
    // 从末尾往回剥：空行、以 〔 或 [ 开头的行都先不显示。
    // 写完整的块已经被 extractMixBlocks 摘走了，还留在这儿的一定是没写完的。
    while (lines.length) {
        const tail = lines[lines.length - 1].trim();
        if (tail === "" || /^[〔[]/.test(tail)) { lines.pop(); continue; }
        break;
    }
    return lines.join("\n");
}

export function extractMixBlocks(rawInput: string): { text: string; ticketRaw?: string; encoreRaw?: string } {
    const afterEncore = pullFamily(rawInput, ENCORE_TAGS);
    const afterTicket = pullFamily(afterEncore.text, TICKET_TAGS);
    let text = afterTicket.text;
    let ticketRaw = afterTicket.raw;
    let encoreRaw = afterEncore.raw;
    if (!ticketRaw || !encoreRaw) {
        const tOpen = ticketRaw ? null : lastMatch(TICKET_TAGS.openLine, text);
        const eOpen = encoreRaw ? null : lastMatch(ENCORE_TAGS.openLine, text);
        const pick = tOpen && eOpen ? (tOpen.index > eOpen.index ? "t" : "e") : tOpen ? "t" : eOpen ? "e" : null;
        if (pick) {
            const m = (pick === "t" ? tOpen : eOpen) as RegExpExecArray;
            const inner = text.slice(m.index + m[0].length).trim();
            if (inner) {
                if (pick === "t") ticketRaw = inner;
                else encoreRaw = inner;
                text = text.slice(0, m.index).trim();
            }
        }
    }
    return { text, ticketRaw, encoreRaw };
}

/** 兼容旧调用：只关心状态栏 */
export function extractMixTicket(raw: string): { text: string; ticketRaw?: string } {
    const result = extractMixBlocks(raw);
    return { text: result.text, ticketRaw: result.ticketRaw };
}

const INLINE_RE = /「([^」]*)」|\*([^*\n]+)\*|~([^~\n]+)~/g;

function parseInline(line: string): MixProseSegment[] {
    const segments: MixProseSegment[] = [];
    let cursor = 0;
    INLINE_RE.lastIndex = 0;
    for (let match = INLINE_RE.exec(line); match; match = INLINE_RE.exec(line)) {
        if (match.index > cursor) {
            segments.push({ type: "narration", text: line.slice(cursor, match.index) });
        }
        if (match[1] !== undefined) segments.push({ type: "dialogue", text: `「${match[1]}」` });
        else if (match[2] !== undefined) segments.push({ type: "thought", text: match[2] });
        else segments.push({ type: "accent", text: match[3] });
        cursor = match.index + match[0].length;
    }
    if (cursor < line.length) {
        segments.push({ type: "narration", text: line.slice(cursor) });
    }
    return segments;
}

/**
 * 把 AI 正文解析成段落序列。
 * 段落按空行/换行切分；整行被【】包裹的行视为场景过场，其余走内联解析。
 */
export function parseMixProse(text: string): MixProseParagraph[] {
    const paragraphs: MixProseParagraph[] = [];
    for (const rawLine of text.split(/\n+/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const scene = line.match(/^【(.+)】$/);
        if (scene) {
            paragraphs.push({ type: "scene", text: scene[1].trim() });
            continue;
        }
        const segments = parseInline(line);
        if (segments.length) paragraphs.push({ type: "text", segments });
    }
    return paragraphs;
}
