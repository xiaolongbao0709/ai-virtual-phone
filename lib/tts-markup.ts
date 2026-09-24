// lib/tts-markup.ts — Fish Audio 语气/停顿标记（需要用户在预设里手动开启「语音语气标记 · Fish Audio」条目）
//
// 角色在语音里用全角龟甲括号 + 英文标签写语气，例如：
//   〔whispering〕你过来一点〔break〕我跟你说个秘密〔chuckling〕嘿嘿
// 为什么不用 Fish 原生的 [tag]：聊天协议 [语音条:…] 的内容里不能出现半角 ]，否则语音条会被截断。
//
// · 只有「〔〕里是英文标签」才算标记（如〔laughing〕〔pause 1.2s〕）；〔注〕这类中文内容一律不碰。
// · Fish Audio：合成前换成原生写法（S2 / S2.1 → [tag]，S1 → (tag)）。
// · 其它服务商：合成前去掉英文标签，避免被念出来；MiniMax / OpenAI 的其余文字不做任何改动。
// · 显示给用户时：stripTtsMarkup() 去掉英文标签。
// 没有开启该预设条目时，模型不会输出这种标记，以上逻辑都不会触发。

const MARK_RE = /〔\s*([A-Za-z][A-Za-z0-9 .,'\-]{0,47}?)\s*〕/g;

/** 给用户看的文字：去掉英文语气标记（中文内容的〔〕原样保留） */
export function stripTtsMarkup(text: string): string {
    if (!text || !text.includes("〔")) return text;
    return text.replace(MARK_RE, "").replace(/[ \t\u3000]{2,}/g, " ");
}

export function hasTtsMarkup(text: string): boolean {
    return !!text && text.includes("〔") && new RegExp(MARK_RE.source).test(text);
}

const EN_ALIASES: Record<string, string> = {
    "pause": "break", "short pause": "break", "beat": "break",
    "long pause": "long-break", "long break": "long-break", "silence": "long-break",
    "laugh": "laughing", "laughs": "laughing", "chuckle": "chuckling", "giggle": "chuckling", "giggling": "chuckling",
    "sigh": "sighing", "sighs": "sighing", "pant": "panting", "gasp": "gasping", "gasps": "gasping",
    "groan": "groaning", "groans": "groaning", "whisper": "whispering", "shout": "shouting", "scream": "screaming",
    "yawn": "yawning", "snore": "snoring", "cry": "sobbing", "crying": "sobbing", "sob": "sobbing", "soft": "soft tone",
    "clear-throat": "clear throat", "clearing throat": "clear throat",
};

function normTag(raw: string): string {
    const low = raw.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
    return EN_ALIASES[low] || low;
}

/** 停顿：〔break〕〔long-break〕〔pause 1.2s〕→ 秒数；不是停顿返回 null */
function pauseSeconds(tag: string): number | null {
    const m = tag.trim().match(/^(?:pause|break)\s*(\d{1,2}(?:\.\d{1,2})?)\s*s?$/i);
    if (m) return Math.min(99.99, Math.max(0.01, Number(m[1])));
    const n = normTag(tag);
    if (n === "break") return 0.4;
    if (n === "long-break") return 1.0;
    return null;
}

/** Fish S1 固定标签集（S2 / S2.1 支持自由描述，不限于此表） */
const FISH_S1_TAGS = new Set([
    "happy", "sad", "angry", "excited", "calm", "nervous", "confident", "surprised", "satisfied", "delighted", "scared", "worried",
    "upset", "frustrated", "depressed", "empathetic", "embarrassed", "disgusted", "moved", "proud", "relaxed", "grateful", "curious",
    "sarcastic", "disdainful", "unhappy", "anxious", "hysterical", "indifferent", "uncertain", "doubtful", "confused", "disappointed",
    "regretful", "guilty", "ashamed", "jealous", "envious", "hopeful", "optimistic", "pessimistic", "nostalgic", "lonely", "bored",
    "contemptuous", "sympathetic", "compassionate", "determined", "resigned",
    "in a hurry tone", "shouting", "screaming", "whispering", "soft tone",
    "laughing", "chuckling", "sobbing", "crying loudly", "sighing", "groaning", "panting", "gasping", "yawning", "snoring",
    "audience laughing", "background laughter", "crowd laughing", "break", "long-break",
]);

/** 把带〔英文标签〕的文字转成该服务商的合成文本；标记本身永远不会被念出来 */
export function prepareSpeechText(text: string, provider: string, model?: string): string {
    if (!hasTtsMarkup(text)) return text;
    if (provider !== "FishAudio") return stripTtsMarkup(text).trim();
    const s1 = String(model || "").toLowerCase() === "s1";
    return text
        .replace(MARK_RE, (_, raw: string) => {
            const sec = pauseSeconds(raw);
            if (sec !== null) {
                const tag = sec >= 0.8 ? "long-break" : "break";
                return s1 ? `(${tag})` : `[${tag}]`;
            }
            const tag = normTag(raw);
            if (s1) return FISH_S1_TAGS.has(tag) ? `(${tag})` : "";
            return `[${tag}]`;
        })
        .replace(/[ \t\u3000]{2,}/g, " ")
        .trim();
}
