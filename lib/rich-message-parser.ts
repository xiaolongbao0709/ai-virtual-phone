/**
 * Shared rich-media message parser.
 *
 * Parse order:
 *   1. parseStateValues() → extract [好感度:72] etc.
 *   2. Extract [状态栏]...[/状态栏] display-only status panel
 *   3. Extract [内心]...[/内心] inner monologue
 *   4. split(/\n\n+/) → split by double newlines
 *   5. Parse each segment for rich-media markers (direct matching, no placeholders)
 */

import type { ChatMessage } from "./chat-storage";
import type { StateValue } from "./chat-storage";
import { parseStateValues, mergeStateValues } from "./state-value-parser";
import { stripActionShells } from "./action-parser";
import { stripTextToolDirectives } from "./text-tool-protocol";
import {
    formatCustomAppDirectiveSummary,
    getCustomAppDirectiveSyntaxHead,
    loadCustomAppChatDirectives,
    splitCustomAppDirectiveArgs,
    type RegisteredCustomAppChatDirective,
} from "./custom-app-chat-directives";

// ── Types ──────────────────────────────────────────────

export interface ParsedMessagePart {
    content: string;
    mediaType?: ChatMessage["mediaType"];
    mediaData?: ChatMessage["mediaData"];
}

export interface ParsedAIResponse {
    parts: ParsedMessagePart[];
    /** 与历史合并后的完整状态快照（用于状态链传递与下一轮提示词） */
    stateValues: StateValue[];
    /** 本轮回复实际输出的状态值（未合并历史；漏输出时为空，内心卡片按此渲染） */
    freshStateValues: StateValue[];
    statusPanel: string;
    innerMonologue: string;
}

// ── Rich-media patterns (non-global, for single match with index) ──

// 零宽空格/BOM 等不可见字符不属于 \s，trim() 删不掉；模型输出在媒体标记后夹带
// 这类字符时，会被切成一个"非空但渲染不可见"的段落，最终显示成一个空气泡。
// 不能直接从内容里删除这些字符——U+200D 是组合 emoji 的连接符，U+200C 在部分
// 文字里有语义——所以只在"判空"时把它们视同空白。
const INVISIBLE_OR_WHITESPACE_ONLY_RE = new RegExp(
    "^[\\s\\u00AD\\u034F\\u180E\\u200B-\\u200F\\u2060-\\u2064\\uFEFF]*$",
);

/** 内容是否没有任何可见字符（空串、空白、零宽字符/BOM 等的任意组合） */
export function isInvisibleOrWhitespaceOnly(text: string): boolean {
    return INVISIBLE_OR_WHITESPACE_ONLY_RE.test(text);
}

const C = "\\s*[：:]\\s*"; // half-width or full-width colon, allowing surrounding spaces

function parseMuteMinutes(num?: string, unit?: string): number {
    const n = parseInt(num || "", 10);
    if (!Number.isFinite(n) || n <= 0) return 10;
    if (unit === "天") return n * 1440;
    if (unit === "小时") return n * 60;
    return n;
}

const RICH_PATTERNS: {
    regex: RegExp;
    build: (m: RegExpMatchArray) => ParsedMessagePart;
}[] = [
    {
        // 3段格式：[红包:金额:个数:留言]
        regex: new RegExp(`\\[红包${C}(\\d+(?:\\.\\d+)?)${C}(\\d+)${C}([^\\]]*)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "red_packet",
            mediaData: { amount: parseFloat(m[1]), count: parseInt(m[2], 10), label: m[3] || "恭喜发财", status: "pending" },
        }),
    },
    {
        // 2段格式（向后兼容）：[红包:金额:留言]
        regex: new RegExp(`\\[红包${C}(\\d+(?:\\.\\d+)?)${C}([^\\]]*)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "red_packet",
            mediaData: { amount: parseFloat(m[1]), count: 1, label: m[2] || "恭喜发财", status: "pending" },
        }),
    },
    {
        // 兼容两种格式：[转账:金额:留言] (1:1) 和 [转账:金额:留言:转账人:收款人] (群聊)
        regex: /\[转账[：:](\d+(?:\.\d+)?)[：:]([^\]：:]*?)(?:[：:]([^\]：:]*?)[：:]([^\]]*?))?\]/,
        build: (m) => ({
            content: "",
            mediaType: "transfer",
            mediaData: {
                amount: parseFloat(m[1]),
                label: m[2]?.trim() || "转账",
                status: "pending" as const,
                senderName: m[3]?.trim() || "",
                recipientName: m[4]?.trim() || "",
            },
        }),
    },
    {
        // [代付请求:总金额:商品名/详情/价格/数量; 商品名/详情/价格/数量]
        regex: /\[代付请求[：:](\d+(?:\.\d+)?)[：:]([^\]]+)\]/,
        build: (m) => ({
            content: "",
            mediaType: "payment_request" as const,
            mediaData: {
                amount: parseFloat(m[1]),
                paymentRequestAmountLabel: m[1],
                paymentRequestItemsText: m[2].trim(),
                label: "代付请求",
                status: "pending" as const,
                paymentRequestedAt: new Date().toISOString(),
            },
        }),
    },
    {
        // 群聊赠礼：[礼物:商品名:收礼人]，兼容旧格式：[礼物:商品名:送给收礼人]
        regex: new RegExp(`\\[礼物${C}([^\\]：:]+)${C}(?:送给)?([^\\]]+)\\]`),
        build: (m) => {
            const giftName = m[1].trim();
            return {
                content: "",
                mediaType: "gift" as const,
                mediaData: {
                    giftName,
                    label: giftName,
                    recipientName: m[2].trim(),
                    giftMerchantLabel: "角色赠礼",
                    giftPriceLabel: "心意礼物",
                    giftSentAt: new Date().toISOString(),
                },
            };
        },
    },
    {
        // 私聊赠礼：[礼物:商品名]
        regex: new RegExp(`\\[礼物${C}([^\\]]+)\\]`),
        build: (m) => {
            const giftName = m[1].trim();
            return {
                content: "",
                mediaType: "gift" as const,
                mediaData: {
                    giftName,
                    label: giftName,
                    giftMerchantLabel: "角色赠礼",
                    giftPriceLabel: "心意礼物",
                    giftSentAt: new Date().toISOString(),
                },
            };
        },
    },
    {
        // 推荐联系人名片：[名片:角色名]。名字在渲染时按推荐人同世界实时解析，
        // 查无此人也放行成卡——点击后可现场生成该角色档案（幻觉转建档）。
        regex: new RegExp(`\\[名片${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "contact_card" as const,
            mediaData: { contactCardName: m[1].trim(), label: m[1].trim() },
        }),
    },
    {
        regex: new RegExp(`\\[照片${C}(使用参考图|不使用参考图)${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "image",
            mediaData: { label: m[2].trim(), useReferenceImage: m[1] === "使用参考图" },
        }),
    },
    {
        regex: new RegExp(`\\[照片${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "image",
            mediaData: { label: m[1].trim(), useReferenceImage: false },
        }),
    },
    {
        regex: new RegExp(`\\[位置${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "location",
            mediaData: { label: m[1] },
        }),
    },
    {
        regex: /\[([^\]]+)拍了拍([^\]]+)\]/,
        build: (m) => ({
            content: "",
            mediaType: "poke" as const,
            mediaData: { pokeSender: m[1]?.trim() || "", pokeTarget: m[2]?.trim() || "" },
        }),
    },
    {
        regex: new RegExp(`\\[表情包${C}([^\\]]+)\\]`),
        build: (m) => {
            const name = m[1].trim();
            return {
                content: "",
                mediaType: "sticker" as const,
                mediaData: { label: name },
            };
        },
    },
    {
        regex: new RegExp(`\\[引用${C}([^\\]]+)\\](.+)`),
        build: (m) => ({
            content: m[2].trim(),
            mediaType: "quote" as const,
            mediaData: { quotePreview: m[1].trim() },
        }),
    },
    {
        // [音乐:歌名-歌手] or [音乐:歌名]
        regex: new RegExp(`\\[音乐${C}([^\\]]+)\\]`),
        build: (m) => {
            const raw = m[1].trim();
            const sep = raw.indexOf("-");
            const title = sep > 0 ? raw.slice(0, sep).trim() : raw;
            const artist = sep > 0 ? raw.slice(sep + 1).trim() : "";
            return {
                content: "",
                mediaType: "music" as const,
                mediaData: { musicTitle: title, musicArtist: artist, label: raw },
            };
        },
    },
    {
        // [音乐分享:歌名] — AI shares a song as a card
        regex: new RegExp(`\\[音乐分享${C}([^\\]]+)\\]`),
        build: (m) => {
            const title = m[1].trim();
            return {
                content: "",
                mediaType: "music_share" as const,
                mediaData: { musicTitle: title, label: title },
            };
        },
    },
    {
        // [语音条:文字内容] — voice message
        regex: new RegExp(`\\[语音条${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "audio" as const,
            mediaData: { label: m[1].trim() },
        }),
    },
    {
        regex: /\[我向[^\]]+发起了语音通话\]/,
        build: () => ({ content: "", mediaType: "voice_call" as const }),
    },
    {
        regex: /\[我向[^\]]+发起了视频通话\]/,
        build: () => ({ content: "", mediaType: "video_call" as const }),
    },
    // 群聊带主语宾语的格式（优先匹配）
    {
        regex: /\[([^\]]+)领取了([^\]]+)的红包\]/,
        build: (m) => ({ content: "", mediaType: "accept_red_packet" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)退回了([^\]]+)的红包\]/,
        build: (m) => ({ content: "", mediaType: "decline_red_packet" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)(?:接受|领取)了([^\]]+)的转账\]/,
        build: (m) => ({ content: "", mediaType: "accept_transfer" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)(?:拒收|退回)了([^\]]+)的转账\]/,
        build: (m) => ({ content: "", mediaType: "decline_transfer" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)(?:接受|同意|支付|代付)了([^\]]+)的代付\]/,
        build: (m) => ({ content: "", mediaType: "accept_payment_request" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)(?:拒绝|拒收|退回)了([^\]]+)的代付\]/,
        build: (m) => ({ content: "", mediaType: "decline_payment_request" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    // 群管理操作（权限在 processGroupParts 校验，无权限的标签直接丢弃）
    {
        regex: /\[([^\]]+?)将群主转让给了?([^\]]+?)\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "transfer_owner" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+?)将([^\]]+?)设为了?管理员\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "set_admin" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+?)取消了([^\]]+?)的管理员\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "unset_admin" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+?)将([^\]]+?)移出了?群聊\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "kick" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+?)邀请([^\]]+?)加入了?群聊\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "invite" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        // [A将B禁言30分钟]（必须先于下面的宽松模式，否则 "A将B禁言了1天" 会被错误拆分）
        regex: /\[([^\]：:]+?)将([^\]：:]+?)禁言(?:了)?\s*(\d+)?\s*(分钟|小时|天)?\]/,
        build: (m) => ({
            content: "",
            mediaType: "group_admin_notice" as const,
            mediaData: {
                adminAction: "mute" as const,
                adminActorName: m[1]?.trim(),
                adminTargetName: m[2]?.trim(),
                adminMuteMinutes: parseMuteMinutes(m[3], m[4]),
            },
        }),
    },
    {
        // [A禁言了B:30分钟] / [A禁言了B]（默认10分钟）
        regex: /\[([^\]：:]+?)禁言了([^\]：:]+?)(?:[：:]\s*(\d+)\s*(分钟|小时|天))?\]/,
        build: (m) => ({
            content: "",
            mediaType: "group_admin_notice" as const,
            mediaData: {
                adminAction: "mute" as const,
                adminActorName: m[1]?.trim(),
                adminTargetName: m[2]?.trim(),
                adminMuteMinutes: parseMuteMinutes(m[3], m[4]),
            },
        }),
    },
    {
        regex: /\[([^\]]+?)解除了([^\]]+?)的禁言\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "unmute" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    // 1:1 简单格式（兼容）
    {
        regex: /\[领取红包\]/,
        build: () => ({ content: "", mediaType: "accept_red_packet" as const }),
    },
    {
        regex: /\[拒收红包\]/,
        build: () => ({ content: "", mediaType: "decline_red_packet" as const }),
    },
    {
        regex: /\[(?:接受|领取)转账\]/,
        build: () => ({ content: "", mediaType: "accept_transfer" as const }),
    },
    {
        regex: /\[拒收转账\]/,
        build: () => ({ content: "", mediaType: "decline_transfer" as const }),
    },
    {
        regex: /\[接受代付\]/,
        build: () => ({ content: "", mediaType: "accept_payment_request" as const }),
    },
    {
        regex: /\[拒绝代付\]/,
        build: () => ({ content: "", mediaType: "decline_payment_request" as const }),
    },
];

type RichPatternCandidate = {
    index: number;
    matchText: string;
    build: () => ParsedMessagePart;
};

function syntaxArgLabels(syntax: string | undefined): string[] {
    const text = String(syntax ?? "").trim();
    const body = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
    const parts = body.split(/[：:]/).map(item => item.trim()).filter(Boolean);
    return parts.slice(1).map((item, index) => (
        item
            .replace(/[<>{}\[\]【】]/g, "")
            .replace(/^(参数|内容)$/, `参数${index + 1}`)
            .slice(0, 24)
            || `参数${index + 1}`
    ));
}

type DirectiveCardInterpolationContext = {
    args: string[];
    argLabels: string[];
    raw: string;
    summary: string;
    directive: RegisteredCustomAppChatDirective;
};

function buildDirectiveCardTokenMap(ctx: DirectiveCardInterpolationContext): Map<string, string> {
    const tokens = new Map<string, string>();
    tokens.set("raw", ctx.raw);
    tokens.set("summary", ctx.summary);
    tokens.set("directive", ctx.directive.label);
    tokens.set("label", ctx.directive.label);
    tokens.set("app", ctx.directive.appName);
    tokens.set("appName", ctx.directive.appName);
    ctx.args.forEach((arg, index) => {
        const oneBased = String(index + 1);
        tokens.set(`arg${oneBased}`, arg);
        tokens.set(`参数${oneBased}`, arg);
        tokens.set(oneBased, arg);
        const label = ctx.argLabels[index];
        if (label) tokens.set(label, arg);
    });
    return tokens;
}

function interpolateDirectiveCardValue(value: unknown, tokens: Map<string, string>): unknown {
    if (typeof value === "string") {
        return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, token: string) => {
            const key = token.trim();
            return tokens.has(key) ? tokens.get(key)! : match;
        });
    }
    if (Array.isArray(value)) {
        return value.map(item => interpolateDirectiveCardValue(item, tokens));
    }
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = interpolateDirectiveCardValue(item, tokens);
        }
        return result;
    }
    return value;
}

function interpolateDirectiveCardLayout(
    card: unknown,
    ctx: DirectiveCardInterpolationContext,
): Record<string, unknown> | null {
    if (!card || typeof card !== "object" || Array.isArray(card)) return null;
    return interpolateDirectiveCardValue(card, buildDirectiveCardTokenMap(ctx)) as Record<string, unknown>;
}

function buildCustomAppDirectivePart(
    directive: RegisteredCustomAppChatDirective,
    args: string[],
    raw: string,
): ParsedMessagePart {
    const summary = formatCustomAppDirectiveSummary(directive, args);
    const title = directive.title || directive.label;
    const argLabels = syntaxArgLabels(directive.syntax);
    const defaultLayout = {
        appLabel: directive.appLabel || directive.appName,
        title,
        subtitle: "",
        body: "",
        status: directive.status || "待确认",
        accentColor: directive.accentColor || "",
        sections: args.length > 0 ? [{
            rows: args.map((arg, index) => ({
                label: argLabels[index] || `参数${index + 1}`,
                value: arg,
            })),
        }] : [],
        actions: directive.actions && directive.actions.length > 0
            ? directive.actions
            : [{ label: "查看", style: "default" }],
    };
    const customLayout = interpolateDirectiveCardLayout(directive.card, {
        args,
        argLabels,
        raw,
        summary,
        directive,
    });
    return {
        content: summary,
        mediaType: "app_card",
        mediaData: {
            appId: directive.appId,
            appName: directive.appName,
            appCardTitle: title,
            appCardBody: "",
            appCardSummary: summary,
            appCardTone: directive.tone,
            appDirectiveId: directive.id,
            appDirectiveLabel: directive.label,
            appDirectiveArgs: args,
            appDirectiveRaw: raw,
            appSceneId: directive.sceneId,
            appSceneTag: directive.sceneTag,
            appTags: directive.tags,
            appHistoryText: summary,
            appCardLayout: customLayout
                ? { ...defaultLayout, ...customLayout }
                : defaultLayout,
        },
    };
}

function findBuiltInRichCandidate(segment: string): RichPatternCandidate | null {
    let best: { index: number; m: RegExpMatchArray; build: (m: RegExpMatchArray) => ParsedMessagePart } | null = null;
    for (const { regex, build } of RICH_PATTERNS) {
        const m = segment.match(regex);
        if (m && m.index !== undefined && (best === null || m.index < best.index)) {
            best = { index: m.index, m, build };
        }
    }
    if (!best) return null;
    const candidate = best;
    return {
        index: best.index,
        matchText: best.m[0],
        build: () => candidate.build(candidate.m),
    };
}

function findCustomAppRichCandidate(segment: string): RichPatternCandidate | null {
    const directives = loadCustomAppChatDirectives();
    if (directives.length === 0) return null;
    const bySyntaxHead = new Map(directives.map(item => [getCustomAppDirectiveSyntaxHead(item.syntax), item]));
    const bracketPattern = /\[([^\]\n：:]{1,24})([：:][^\]\n]*)?\]/g;
    let match: RegExpExecArray | null;
    while ((match = bracketPattern.exec(segment)) !== null) {
        const directive = bySyntaxHead.get(match[1].trim());
        if (!directive) continue;
        const args = splitCustomAppDirectiveArgs(match[2] || "");
        const raw = match[0];
        return {
            index: match.index,
            matchText: raw,
            build: () => buildCustomAppDirectivePart(directive, args, raw),
        };
    }
    return null;
}

// ── Structured hidden block extraction ───────────────────

function extractBracketBlock(text: string, tag: string): { cleaned: string; content: string } {
    let content = "";
    let cleaned = text;
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`\\[${escapedTag}\\]([\\s\\S]*?)\\[\\/${escapedTag}\\]`, "g");

    let match;
    while ((match = rx.exec(cleaned)) !== null) {
        const block = match[1].trim();
        if (!block) continue;
        if (content) content += "\n\n";
        content += block;
    }
    cleaned = cleaned.replace(rx, "").trim();

    return { cleaned, content };
}

// ── Segment parser ──────────────────────────────────────

/**
 * Parse a segment for rich-media markers.
 * If found, splits into before-text + media + recurse(after-text).
 * If not found, pushes as plain text.
 */
function parseSegment(segment: string, parts: ParsedMessagePart[]) {
    // Pick the rich marker that appears EARLIEST in the text, not the first
    // pattern that happens to match. Otherwise, when an earlier-in-text marker
    // (e.g. [表情包:x]) belongs to a pattern listed after a later-in-text marker
    // (e.g. [...拍了拍...]), the earlier marker lands in the un-parsed `before`
    // chunk and leaks as literal text. Ties keep list order (priority).
    const builtIn = findBuiltInRichCandidate(segment);
    const customApp = findCustomAppRichCandidate(segment);
    const best = customApp && (!builtIn || customApp.index < builtIn.index) ? customApp : builtIn;

    if (best) {
        const before = segment.slice(0, best.index).trim();
        const after = segment.slice(best.index + best.matchText.length).trim();

        // `before` is guaranteed marker-free (we chose the earliest marker).
        if (before) parts.push({ content: before });
        parts.push(best.build());
        if (after) parseSegment(after, parts);
        return;
    }

    // No rich media — plain text
    parts.push({ content: segment });
}

// ── Main parser ──────────────────────────────────────────

export function parseAIResponse(rawText: string, previousState: StateValue[]): ParsedAIResponse {
    // 0. FIRST: extract ```html blocks and <style>+HTML before any processing
    const htmlBlockPlaceholders: { placeholder: string; original: string }[] = [];
    let protected_ = rawText;
    // Protect ```html...``` blocks
    protected_ = protected_.replace(/```html\s*\n[\s\S]*?```/g, (match) => {
        const placeholder = `\x00HTML_BLOCK_${htmlBlockPlaceholders.length}\x00`;
        htmlBlockPlaceholders.push({ placeholder, original: match });
        return placeholder;
    });
    // Protect <style>...</style> and following HTML until next double-newline + non-HTML
    protected_ = protected_.replace(/<style[\s\S]*?<\/style>[\s\S]*?(?=\n\n[^<\x00]|$)/gi, (match) => {
        const placeholder = `\x00HTML_BLOCK_${htmlBlockPlaceholders.length}\x00`;
        htmlBlockPlaceholders.push({ placeholder, original: match });
        return placeholder;
    });

    // Helper to restore placeholders
    const restore = (text: string) => {
        let r = text;
        for (const { placeholder, original } of htmlBlockPlaceholders) {
            r = r.split(placeholder).join(original);
        }
        return r;
    };

    // 1. Parse state values
    const parsedSV = parseStateValues(protected_);
    const stateValues = mergeStateValues(previousState, parsedSV.stateValues);

    // 1.5. Strip AI hallucination XML/bracket action shells
    const actionCleaned = stripActionShells(parsedSV.cleanText);

    // 2. Extract display-only status panel, then inner monologue
    const status = extractBracketBlock(actionCleaned, "状态栏");
    const mono = extractBracketBlock(status.cleaned, "内心");

    // 2.1. Collapse residual blank lines left by tag extraction
    const postCleaned = mono.cleaned.replace(/\n{3,}/g, "\n\n").trim();

    // 2.5. Merge [引用:...] with following reply text even if separated by newlines
    const mergedText = postCleaned.replace(/(\[引用[：:][^\]]+\])\s*\n+\s*/g, "$1");

    // 2.6. Collapse blank lines around [表情包:...] so stickers stay in the same segment as adjacent text
    const stickerMerged = mergedText
        .replace(/\n\n+(?=\[表情包[：:][^\]]+\])/g, "\n")
        .replace(/(\[表情包[：:][^\]]+\])\n\n+/g, "$1\n");

    // 3. Split by double newlines (placeholders still in place)
    const segments = stickerMerged.split(/\n\n+/).map(s => s.trim()).filter(Boolean);

    // 4. Parse each segment
    const parts: ParsedMessagePart[] = [];
    for (const seg of segments) {
        parseSegment(seg, parts);
    }

    // 5. Restore HTML block placeholders and keep unknown bracket protocols as plain text.
    //    Strip tool directives (获取指令/执行动作) from display content too: a
    //    directive-only segment would otherwise survive as a non-empty part, render
    //    as an empty bubble after the display layer strips it, and capture the inner
    //    monologue (which then has nowhere to attach). Stripping here makes such a
    //    part empty → filtered out → inner monologue lands on the first real reply.
    const cleaned = parts.map(p => {
        if (p.mediaType) return p;
        const display = stripTextToolDirectives(restore(p.content));
        return { ...p, content: display };
    }).filter(p => p.mediaType || !isInvisibleOrWhitespaceOnly(p.content));

    return {
        parts: cleaned,
        stateValues,
        freshStateValues: parsedSV.stateValues,
        statusPanel: restore(status.content),
        innerMonologue: restore(mono.content),
    };
}
