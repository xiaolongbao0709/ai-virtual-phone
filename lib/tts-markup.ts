// lib/tts-markup.ts — 角色语音里的「语气 / 停顿 / 声音」标记
//
// 角色在语音条、语音/视频通话里用全角龟甲括号〔…〕写语气标记，例如：
//   〔whispering〕你过来一点〔break〕我跟你说个秘密〔chuckling〕嘿嘿
// 选〔〕而不是 [] 的原因：聊天协议 [语音条:…] 的内容里不能出现半角 ]，否则整条语音会被截断。
//
// · 显示给用户看时：stripTtsMarkup() 把标记全部去掉，用户只看到正常文字。
// · 送去合成时：prepareSpeechText() 按服务商 / 模型换成各家原生语法：
//     Fish Audio S2 系列 → [tag]      （官方 bracket cues，支持自由描述）
//     Fish Audio S1      → (tag)      （官方固定标签集）
//     Minimax 2.8        → (laughs) 等 19 个语气词 + <#秒#> 停顿；情绪标签转成 voice_setting.emotion
//     Minimax 其它模型   → 只保留 <#秒#> 停顿 + 情绪参数
//     OpenAI 等          → 全部去掉，保证不会被念出来
// 不认识的标记一律丢弃，绝不会把标记本身念出来。

const MARK_RE = /〔([^〔〕\r\n]{1,48})〕/g;
/** 兼容：角色偶尔直接写出 Minimax 原生停顿 <#0.5#> */
const MINIMAX_PAUSE_RE = /<#\s*\d{1,2}(?:\.\d{1,2})?\s*#>/g;

/** 直接写成原生写法的官方标签（Minimax 语气词 / 情绪词、Fish S1 标签），显示时也一并隐藏 */
const NATIVE_TAG_RE = /[(（]\s*(laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|whistles|sneezes|crying|applause|whisper|whispering|fluent|happy|sad|angry|fearful|disgusted|surprised|calm|neutral|excited|nervous|confident|satisfied|delighted|scared|worried|upset|frustrated|depressed|empathetic|embarrassed|moved|proud|relaxed|grateful|curious|sarcastic|disdainful|unhappy|anxious|hysterical|indifferent|uncertain|doubtful|confused|disappointed|regretful|guilty|ashamed|jealous|envious|hopeful|optimistic|pessimistic|nostalgic|lonely|bored|contemptuous|sympathetic|compassionate|determined|resigned|in a hurry tone|shouting|screaming|soft tone|laughing|chuckling|sobbing|crying loudly|sighing|groaning|panting|gasping|yawning|snoring|audience laughing|background laughter|crowd laughing|break|long-break)\s*[)）]/gi;

/** 给用户看的文字：去掉所有语音标记 */
export function stripTtsMarkup(text: string): string {
    if (!text) return text;
    if (!text.includes("〔") && !text.includes("<#") && !/[(（]/.test(text)) return text;
    return text
        .replace(MARK_RE, "")
        .replace(MINIMAX_PAUSE_RE, "")
        .replace(NATIVE_TAG_RE, "")
        .replace(/[ \t\u3000]{2,}/g, " ")
        .replace(/^[ \t\u3000]+|[ \t\u3000]+$/gm, "");
}

export function hasTtsMarkup(text: string): boolean {
    return !!text && (text.includes("〔") || /<#\s*\d/.test(text));
}

// ── 标签归一化：中文写法 / 同义词 → 统一的英文标签 ─────────────────────

const ZH_ALIASES: Record<string, string> = {
    // 停顿
    "停顿": "break", "短停顿": "break", "顿": "break", "停一下": "break",
    "长停顿": "long-break", "停很久": "long-break", "沉默": "long-break",
    // 笑
    "笑": "laughing", "大笑": "laughing", "哈哈大笑": "laughing", "笑出声": "laughing",
    "轻笑": "chuckling", "低笑": "chuckling", "偷笑": "chuckling", "笑了一下": "chuckling", "嗤笑": "chuckling",
    // 哭
    "哭": "sobbing", "抽泣": "sobbing", "哽咽": "sobbing", "啜泣": "sobbing", "大哭": "crying loudly", "嚎啕大哭": "crying loudly",
    // 呼吸
    "叹气": "sighing", "叹息": "sighing", "唉": "sighing",
    "喘气": "panting", "喘": "panting", "喘息": "panting", "气喘吁吁": "panting",
    "倒吸气": "gasping", "倒吸一口气": "gasping", "惊呼": "gasping", "抽气": "gasping",
    "吸气": "inhale", "深吸一口气": "inhale", "呼气": "exhale", "长呼一口气": "exhale", "换气": "breath", "呼吸": "breath",
    // 其它声音
    "打哈欠": "yawning", "哈欠": "yawning", "打呼": "snoring", "打鼾": "snoring",
    "清嗓子": "clear throat", "咳嗽": "coughs", "咳": "coughs",
    "呻吟": "groaning", "闷哼": "groaning", "哼": "groaning",
    "吸鼻子": "sniffs", "喷鼻息": "snorts", "嗤": "snorts", "打嗝": "burps", "咂嘴": "lip-smacking",
    "哼歌": "humming", "哼唱": "humming", "嘶": "hissing", "嘶嘶": "hissing", "嗯": "emm", "呃": "emm", "打喷嚏": "sneezes", "喷嚏": "sneezes",
    // 语调
    "小声": "whispering", "耳语": "whispering", "悄悄": "whispering", "低语": "whispering",
    "喊": "shouting", "大喊": "shouting", "吼": "shouting", "尖叫": "screaming",
    "温柔": "soft tone", "轻声": "soft tone", "急促": "in a hurry tone", "着急": "in a hurry tone", "重读": "emphasis", "强调": "emphasis",
    // 情绪
    "开心": "happy", "高兴": "happy", "难过": "sad", "伤心": "sad", "生气": "angry", "愤怒": "angry", "兴奋": "excited",
    "平静": "calm", "紧张": "nervous", "自信": "confident", "惊讶": "surprised", "满足": "satisfied", "欣喜": "delighted",
    "害怕": "scared", "担心": "worried", "烦躁": "frustrated", "沮丧": "depressed", "心疼": "empathetic", "害羞": "embarrassed",
    "尴尬": "embarrassed", "嫌弃": "disgusted", "感动": "moved", "骄傲": "proud", "放松": "relaxed", "感激": "grateful",
    "好奇": "curious", "阴阳怪气": "sarcastic", "讽刺": "sarcastic", "不屑": "disdainful", "焦虑": "anxious", "委屈": "upset",
    "失望": "disappointed", "后悔": "regretful", "愧疚": "guilty", "吃醋": "jealous", "期待": "hopeful", "怀念": "nostalgic",
    "寂寞": "lonely", "无聊": "bored", "坚定": "determined", "无奈": "resigned", "撒娇": "soft tone", "困": "yawning",
};

function normTag(raw: string): string {
    const t = raw.trim().replace(/\s+/g, " ");
    const zh = ZH_ALIASES[t];
    if (zh) return zh;
    const low = t.toLowerCase().replace(/_/g, " ");
    const EN_ALIASES: Record<string, string> = {
        "pause": "break", "short pause": "break", "beat": "break",
        "long pause": "long-break", "long break": "long-break", "silence": "long-break",
        "laugh": "laughing", "laughs": "laughing", "chuckle": "chuckling", "giggle": "chuckling", "giggling": "chuckling",
        "sigh": "sighing", "sighs": "sighing", "pant": "panting", "gasp": "gasping", "gasps": "gasping",
        "cough": "coughs", "coughing": "coughs", "clear-throat": "clear throat", "clearing throat": "clear throat",
        "groan": "groaning", "groans": "groaning", "sniff": "sniffs", "sniffing": "sniffs", "snort": "snorts", "snorting": "snorts",
        "burp": "burps", "hum": "humming", "hiss": "hissing", "hmm": "emm", "um": "emm", "uh": "emm", "sneeze": "sneezes", "sneezing": "sneezes",
        "whisper": "whispering", "shout": "shouting", "scream": "screaming", "yawn": "yawning", "cry": "sobbing", "crying": "sobbing",
        "sob": "sobbing", "breathing": "breath", "whistle": "whistles", "whistling": "whistles", "clap": "applause", "clapping": "applause", "inhales": "inhale", "exhales": "exhale", "soft": "soft tone",
    };
    return EN_ALIASES[low] || low;
}

/** 停顿标记 → 秒数；不是停顿返回 null */
function pauseSeconds(tag: string): number | null {
    const t = tag.trim();
    const m = t.match(/^(?:pause|break|停顿|停)\s*(\d{1,2}(?:\.\d{1,2})?)\s*(?:s|秒)?$/i);
    if (m) return Math.min(99.99, Math.max(0.01, Number(m[1])));
    const n = normTag(t);
    if (n === "break") return 0.4;
    if (n === "long-break") return 1.0;
    return null;
}

// ── 各家支持的标签 ─────────────────────────────────────────────

/** Fish S1 固定标签集（S2 为自由描述，不限于此表） */
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

/** Minimax speech-2.8 支持的 22 个语气词（官方列表） */
const MINIMAX_INTERJECTIONS: Record<string, string> = {
    "laughing": "(laughs)", "chuckling": "(chuckle)", "coughs": "(coughs)", "clear throat": "(clear-throat)",
    "groaning": "(groans)", "breath": "(breath)", "panting": "(pant)", "inhale": "(inhale)", "exhale": "(exhale)",
    "gasping": "(gasps)", "sniffs": "(sniffs)", "sighing": "(sighs)", "snorts": "(snorts)", "burps": "(burps)",
    "lip-smacking": "(lip-smacking)", "humming": "(humming)", "hissing": "(hissing)", "emm": "(emm)", "sneezes": "(sneezes)",
    "whistles": "(whistles)", "crying": "(crying)", "applause": "(applause)",
    "sobbing": "(crying)", "crying loudly": "(crying)",
    // Minimax 没有打哈欠，用长呼气代替
    "yawning": "(exhale)",
};

/** 情绪标签 → Minimax voice_setting.emotion */
const MINIMAX_EMOTION_OF: Record<string, string> = {
    happy: "happy", excited: "happy", delighted: "happy", satisfied: "happy", proud: "happy", grateful: "happy",
    optimistic: "happy", hopeful: "happy", confident: "happy", curious: "happy",
    sad: "sad", depressed: "sad", lonely: "sad", disappointed: "sad", regretful: "sad", moved: "sad", unhappy: "sad",
    nostalgic: "sad", guilty: "sad", ashamed: "sad", resigned: "sad", upset: "sad", empathetic: "calm", sympathetic: "calm", compassionate: "calm",
    angry: "angry", frustrated: "angry", furious: "angry", hysterical: "angry", jealous: "angry", envious: "angry",
    scared: "fearful", nervous: "fearful", anxious: "fearful", worried: "fearful", terrified: "fearful", uncertain: "fearful",
    disgusted: "disgusted", contemptuous: "disgusted", disdainful: "disgusted", sarcastic: "disgusted",
    surprised: "surprised", confused: "surprised", doubtful: "surprised",
    whispering: "whisper", whisper: "whisper", "soft tone": "whisper",
    calm: "calm", relaxed: "calm", indifferent: "calm", bored: "calm", determined: "calm", pessimistic: "calm",
    fearful: "fearful", neutral: "neutral",
};

export type PreparedSpeech = { text: string; emotion?: string };

/**
 * 把带〔〕标记的文字转换成该服务商能用的合成文本。
 * 无论哪家，标记本身都不会被念出来。
 */
export function prepareSpeechText(text: string, provider: string, model?: string): PreparedSpeech {
    if (!hasTtsMarkup(text)) return { text };
    const m = String(model || "").toLowerCase();

    if (provider === "FishAudio") {
        const s1 = m === "s1";
        const out = text
            .replace(MINIMAX_PAUSE_RE, (p) => {
                const sec = Number(p.replace(/[<#>\s]/g, ""));
                const tag = sec >= 0.8 ? "long-break" : "break";
                return s1 ? `(${tag})` : `[${tag}]`;
            })
            .replace(MARK_RE, (_, raw: string) => {
                const sec = pauseSeconds(raw);
                if (sec !== null) {
                    const tag = sec >= 0.8 ? "long-break" : "break";
                    return s1 ? `(${tag})` : `[${tag}]`;
                }
                const tag = normTag(raw);
                if (s1) return FISH_S1_TAGS.has(tag) ? `(${tag})` : "";
                // S2 / S2.1 支持自由描述：认识的用官方标签名，不认识的原样当描述传过去
                return `[${tag.replace(/[[\]]/g, "")}]`;
            });
        return { text: tidy(out) };
    }

    if (provider === "Minimax") {
        const interjections = m.includes("2.8");
        let emotion: string | undefined;
        let out = text
            .replace(MINIMAX_PAUSE_RE, (p) => `\u0000P${Number(p.replace(/[<#>\s]/g, ""))}\u0000`)
            .replace(MARK_RE, (_, raw: string) => {
                const sec = pauseSeconds(raw);
                if (sec !== null) return `\u0000P${sec}\u0000`;
                const tag = normTag(raw);
                if (!emotion && MINIMAX_EMOTION_OF[tag]) { emotion = MINIMAX_EMOTION_OF[tag]; return ""; }
                if (interjections && MINIMAX_INTERJECTIONS[tag]) return MINIMAX_INTERJECTIONS[tag];
                return "";
            });
        out = fixMinimaxPauses(out);
        return { text: tidy(out), emotion };
    }

    // 不支持语气控制的服务商：全部去掉
    return { text: stripTtsMarkup(text) };
}

/** Minimax 规则：停顿必须夹在两段能发音的文字之间，且不能连续出现 */
function fixMinimaxPauses(s: string): string {
    const parts = s.split(/\u0000P([\d.]+)\u0000/);
    // parts: [text, sec, text, sec, text...]
    let out = "";
    let pending = 0;
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) { pending += Number(parts[i]) || 0; continue; }
        const seg = parts[i];
        const speakable = /[\p{L}\p{N}]/u.test(seg.replace(/\([a-z-]+\)/g, ""));
        if (speakable && out && /[\p{L}\p{N}]/u.test(out.replace(/\([a-z-]+\)/g, "")) && pending > 0) {
            out += `<#${Math.min(99.99, Math.max(0.01, pending)).toFixed(2).replace(/\.?0+$/, "")}#>`;
        }
        if (speakable || seg.trim()) pending = speakable ? 0 : pending;
        out += seg;
    }
    return out;
}

function tidy(s: string): string {
    return s.replace(/[ \t\u3000]{2,}/g, " ").trim();
}
