export type TextToolDirectiveSpan = {
    start: number;
    end: number;
    raw: string;
};

const FETCH_DIRECTIVE_RE = /\[[^\]\r\n]*?(?:获取指令|获取工具)\s*[:：][^\]\r\n]*\]/g;
const ACTION_HEADER_RE = /(?:执行动作|工具调用)\s*[:：]/;

function findActionDirectiveSpans(text: string): TextToolDirectiveSpan[] {
    const spans: TextToolDirectiveSpan[] = [];

    for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
        let argsStart = -1;
        for (let index = start + 1; index < text.length; index += 1) {
            const char = text[index];
            if (char === "\n" || char === "\r" || char === "]") break;
            if (char === "(" || char === "（") {
                argsStart = index;
                break;
            }
        }
        if (argsStart === -1 || !ACTION_HEADER_RE.test(text.slice(start + 1, argsStart))) continue;

        let depth = 0;
        let quote = "";
        let escaped = false;
        let argsEnd = -1;
        for (let index = argsStart; index < text.length; index += 1) {
            const char = text[index];
            if (quote) {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === quote) quote = "";
                continue;
            }
            if (char === '"' || char === "'") {
                quote = char;
                continue;
            }
            if (char === "(" || char === "（") depth += 1;
            else if (char === ")" || char === "）") {
                depth -= 1;
                if (depth === 0) {
                    argsEnd = index;
                    break;
                }
            }
        }
        if (argsEnd === -1) continue;

        let end = argsEnd + 1;
        while (end < text.length && /\s/.test(text[end])) end += 1;
        if (text[end] !== "]") continue;
        end += 1;
        spans.push({ start, end, raw: text.slice(start, end) });
    }

    return spans;
}

export function findTextToolDirectiveSpans(text: string): TextToolDirectiveSpan[] {
    const spans: TextToolDirectiveSpan[] = [];
    for (const match of text.matchAll(FETCH_DIRECTIVE_RE)) {
        if (match.index === undefined) continue;
        spans.push({ start: match.index, end: match.index + match[0].length, raw: match[0] });
    }
    spans.push(...findActionDirectiveSpans(text));

    return spans
        .sort((left, right) => left.start - right.start || right.end - left.end)
        .filter((span, index, all) => index === 0 || span.start >= all[index - 1].end);
}

export function extractTextToolDirectiveText(text: string): string {
    return findTextToolDirectiveSpans(text).map(span => span.raw).join("\n");
}

export function stripTextToolDirectives(text: string): string {
    const spans = findTextToolDirectiveSpans(text);
    if (spans.length === 0) return text.trim();

    let cursor = 0;
    let output = "";
    for (const span of spans) {
        output += text.slice(cursor, span.start);
        cursor = span.end;
    }
    output += text.slice(cursor);
    return output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
