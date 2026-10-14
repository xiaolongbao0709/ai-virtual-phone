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
        build: (m) => {
            const label = m[1].trim();
            return {
                content: "",
                mediaType: "image",
                mediaData: {
                    label,
                    useReferenceImage: /(?:自拍|对镜拍|selfie)/i.test(label),
                },
            };
        },
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
    {
        // [强行动身:碰头地点:用时(可选):台词] or [强行赴约:碰头地点:用时(可选):台词] or [执意赶来:...]
        regex: new RegExp(`\\[(?:强行动身|强行赴约|霸道奔赴|执意赶来|执意奔赴)${C}([^：:\\]]+?)(?:${C}([^：:\\]]+?))?(?:${C}([^\\]]+))?\\]`),
        build: (m) => {
            const rawPlace = m[1]?.trim() || "";
            const isInvalidQuestionPlace = /^(?:你在[哪哪儿里]|在[哪哪儿里]|在哪个地方|去[哪哪儿里]|未知|未定|未知位置|不知道在哪[儿里]?)$/.test(rawPlace);
            const place = isInvalidQuestionPlace
                ? ""
                : ((!rawPlace || /(?:发错|迷路|具体位置|定位的位置|所在的位置|所在地|某个地方|某个屋檐)/.test(rawPlace))
                    ? "你身边"
                    : rawPlace);
            let timeStr: string | undefined;
            let rawReason = "";

            if (m[3] !== undefined) {
                timeStr = m[2]?.trim();
                rawReason = m[3]?.trim() || "";
            } else if (m[2] !== undefined) {
                const segment = m[2].trim();
                if (segment.includes("|")) {
                    rawReason = segment;
                } else if (/^(?:\d+|半个?小时|一刻钟|\d+个?小时|\d+\s*(?:分钟|分|mins?|min)|(?:二十|三十|四十|五十|十五|十|五)[\d分]*)$/.test(segment)) {
                    timeStr = segment;
                } else {
                    rawReason = segment;
                }
            }

            const segments = rawReason.split("|").map(s => s.trim());
            const reason = segments[0] || "";
            const onTheWayMessage = segments[1] || "";
            let transitCardMessage = "";
            let arrivedMessage = "";
            let arrivalCardMessage = "";

            if (segments.length >= 5) {
                transitCardMessage = segments[2] || "";
                arrivedMessage = segments[3] || "";
                arrivalCardMessage = segments[4] || "";
            } else if (segments.length === 4) {
                arrivedMessage = segments[2] || "";
                arrivalCardMessage = segments[3] || "";
            } else if (segments.length >= 3) {
                arrivedMessage = segments[2] || "";
            }

            return {
                content: "",
                mediaType: "offline_invite" as const,
                mediaData: {
                    offlineInvite: {
                        direction: "he_comes" as const,
                        theme: "forced" as const,
                        place,
                        timeStr,
                        reason,
                        onTheWayMessage,
                        transitCardMessage,
                        arrivedMessage,
                        arrivalCardMessage,
                        status: "on_the_way" as const,
                    },
                    label: "线下邀约:强行动身",
                },
            };
        },
    },
    {
        // [线下邀约:情绪(可选):方向(可选):地点:时间:台词] or [线下邀约:方向:地点:时间:台词] or [线下邀约:方向:地点:台词] or [线下邀约:方向:地点]
        regex: new RegExp(`\\[线下邀约(?:${C}(危机|警报|白红|紧急|严肃|执意))?(?:${C}(他来|我去|我来|你来|角色来|用户去|角色赴约|邀请赴约|强行动身|强行赴约|执意赶来|执意奔赴))?${C}([^：:\\]]+?)(?:${C}([^：:\\]]+?))?(?:${C}([^\\]]+))?\\]`),
        build: (m) => {
            const rawTone = m[1]?.trim();
            const rawDir = m[2]?.trim();
            const isForced = rawDir === "强行动身" || rawDir === "强行赴约" || rawDir === "执意赶来" || rawDir === "执意奔赴";
            const theme: "default" | "alert" | "forced" = isForced
                ? "forced"
                : ((rawTone || rawDir === "危机" || rawDir === "警报") ? "alert" : "default");
            let resolvedDirection: "he_comes" | "i_go" | undefined = isForced
                ? "he_comes"
                : (rawDir
                    ? ((rawDir === "我去" || rawDir === "你来" || rawDir === "用户去" || rawDir === "邀请赴约") ? "i_go" : "he_comes")
                    : undefined);
            const status = isForced ? ("on_the_way" as const) : ("pending" as const);
            const rawPlace = m[3]?.trim() || "";
            // 若模型在未知地点时输出反问词（如“你在哪”），视为空地点拦截提议
            const isInvalidQuestionPlace = /^(?:你在[哪哪儿里]|在[哪哪儿里]|在哪个地方|去[哪哪儿里]|未知|未定|未知位置|不知道在哪[儿里]?)$/.test(rawPlace);
            const place = isInvalidQuestionPlace
                ? ""
                : ((!rawPlace || /(?:发错|迷路|具体位置|定位的位置|所在的位置|所在地|某个地方|某个屋檐)/.test(rawPlace))
                    ? "你身边"
                    : rawPlace);
            let timeStr: string | undefined;
            let rawReason = "";

            if (m[5] !== undefined) {
                const seg4 = m[4]?.trim() || "";
                const seg5 = m[5]?.trim() || "";
                const isTimePattern = /^(?:\d+|半个?小时|一刻钟|\d+个?小时|\d+\s*(?:分钟|分|mins?|min)|(?:二十|三十|四十|五十|十五|十|五)[\d分]*)$/;
                if (!isTimePattern.test(seg4) && isTimePattern.test(seg5)) {
                    timeStr = seg5;
                    rawReason = seg4;
                } else {
                    timeStr = seg4;
                    rawReason = seg5;
                }
            } else if (m[4] !== undefined) {
                const segment = m[4].trim();
                if (segment.includes("|")) {
                    rawReason = segment;
                } else if (/^(?:\d+|半个?小时|一刻钟|\d+个?小时|\d+\s*(?:分钟|分|mins?|min)|(?:二十|三十|四十|五十|十五|十|五)[\d分]*)$/.test(segment)) {
                    timeStr = segment;
                } else {
                    rawReason = segment;
                }
            }

            if (!resolvedDirection && !isForced) {
                // 若大模型遗漏了方向标签：结合生活常理智能推断
                const isByYourSide = place === "你身边";
                const hasMultipleSegments = rawReason.includes("|");
                const hasTime = Boolean(timeStr);
                const mentionsComingOrPickingUp = /(?:接你|去找你|去你身边|动身|出门|在路上|赶过去|到你身边)/.test(rawReason);
                const mentionsWaitingOrHere = /(?:等|在这|过来|留着|坐着|慢点走|别跑|来找我|爱来不来)/.test(rawReason);

                if (isByYourSide || mentionsComingOrPickingUp || (hasTime && !mentionsWaitingOrHere) || hasMultipleSegments) {
                    resolvedDirection = "he_comes";
                } else {
                    // 地点为具体场所且为单句等候语（或无用时参数），智能推断为角色在现场等候用户前来（我去）
                    resolvedDirection = "i_go";
                }
            }

            const segments = rawReason.split("|").map(s => s.trim());
            let reason = "";
            let onTheWayMessage = "";
            let transitCardMessage = "";
            let arrivedMessage = "";
            let arrivalCardMessage = "";

            if (isForced) {
                // 红黑强行动身三大心语设计：正文已为动身宣言，无需在途报备，只需 3 句话：
                // 卡片在途心语 | 微信到达呼唤 | 卡片到达私房心语
                onTheWayMessage = "";
                if (segments.length === 3) {
                    // 纯粹 3 句话标准格式
                    transitCardMessage = segments[0] || "";
                    arrivedMessage = segments[1] || "";
                    arrivalCardMessage = segments[2] || "";
                    reason = transitCardMessage;
                } else if (segments.length >= 5) {
                    // 兼容 5 段格式：提议由头 | 微信在途报备 | 卡片在途心语 | 微信到达呼唤 | 卡片到达心语
                    reason = segments[0] || "";
                    transitCardMessage = segments[2] || "";
                    arrivedMessage = segments[3] || "";
                    arrivalCardMessage = segments[4] || "";
                } else if (segments.length === 4) {
                    reason = segments[0] || "";
                    transitCardMessage = segments[1] || "";
                    arrivedMessage = segments[2] || "";
                    arrivalCardMessage = segments[3] || "";
                } else if (segments.length === 2) {
                    arrivedMessage = segments[0] || "";
                    arrivalCardMessage = segments[1] || "";
                } else if (segments.length === 1) {
                    transitCardMessage = segments[0] || "";
                    arrivalCardMessage = segments[0] || "";
                }
            } else if (resolvedDirection === "i_go") {
                // 【我去】模式规范：仅需 1 句话（现场等候语 / 由头）
                reason = segments[0] || "";
                transitCardMessage = segments[0] || "";
            } else {
                // 【他来】标准 5 段格式：提议由头 | 微信在途报备 | 卡片在途心语 | 微信到达呼唤 | 卡片到达私房心语
                reason = segments[0] || "";
                onTheWayMessage = segments[1] || "";
                if (segments.length >= 5) {
                    transitCardMessage = segments[2] || "";
                    arrivedMessage = segments[3] || "";
                    arrivalCardMessage = segments[4] || "";
                } else if (segments.length === 4) {
                    arrivedMessage = segments[2] || "";
                    arrivalCardMessage = segments[3] || "";
                } else if (segments.length === 3) {
                    arrivedMessage = segments[2] || "";
                }
            }

            return {
                content: "",
                mediaType: "offline_invite" as const,
                mediaData: {
                    offlineInvite: {
                        direction: resolvedDirection,
                        theme,
                        place,
                        timeStr,
                        reason,
                        onTheWayMessage,
                        transitCardMessage,
                        arrivedMessage,
                        arrivalCardMessage,
                        status,
                    },
                    label: `线下邀约:${resolvedDirection === "i_go" ? "我去" : (isForced ? "强行动身" : "他来")}`,
                },
            };
        },
    },
    {
        // [更改地点:方向(可选):新地点:新用时(可选):由头|在途|呼唤|到达(可选)]
        regex: new RegExp(`\\[(?:更改地点|修改地点|变更地点)(?:${C}(他来|我去))?${C}([^：:\\]]+?)(?:${C}([^：:\\]]+?))?(?:${C}([^\\]]+))?\\]`),
        build: (m) => {
            const directionStr = m[1]?.trim();
            const direction = directionStr ? (directionStr === "我去" ? ("i_go" as const) : ("he_comes" as const)) : undefined;
            const rawPlace = m[2]?.trim() || "";
            const isInvalidQuestionPlace = /^(?:你在[哪哪儿里]|在[哪哪儿里]|在哪个地方|去[哪哪儿里]|未知|未定|未知位置|不知道在哪[儿里]?)$/.test(rawPlace);
            const place = isInvalidQuestionPlace
                ? ""
                : ((!rawPlace || /(?:发错|迷路|具体位置|定位的位置|所在的位置|所在地|某个地方|某个屋檐)/.test(rawPlace))
                    ? "你身边"
                    : rawPlace);
            let timeStr: string | undefined;
            let rawArrival = "";

            if (m[4] !== undefined) {
                const seg3 = m[3]?.trim() || "";
                const seg4 = m[4]?.trim() || "";
                const isTimePattern = /^(?:\d+|半个?小时|一刻钟|\d+个?小时|\d+\s*(?:分钟|分|mins?|min)|(?:二十|三十|四十|五十|十五|十|五)[\d分]*)$/;
                if (!isTimePattern.test(seg3) && isTimePattern.test(seg4)) {
                    timeStr = seg4;
                    rawArrival = seg3;
                } else {
                    timeStr = seg3;
                    rawArrival = seg4;
                }
            } else if (m[3] !== undefined) {
                const seg = m[3].trim();
                if (seg.includes("|") || seg.length > 8 || !/^(?:\d+|半个?小时|一刻钟|\d+个?小时|\d+\s*(?:分钟|分|mins?|min)|(?:二十|三十|四十|五十|十五|十|五)[\d分]*)$/.test(seg)) {
                    rawArrival = seg;
                } else {
                    timeStr = seg;
                }
            }

            const arrivalSegments = rawArrival ? rawArrival.split("|").map(s => s.trim()) : [];
            let reason = "";
            let onTheWayMessage = "";
            let transitCardMessage = "";
            let arrivedMessage = "";
            let arrivalCardMessage = "";

            if (arrivalSegments.length >= 5) {
                // 5段格式：提议由头 | 微信在途报备 | 卡片在途心语 | 微信到达呼唤 | 卡片到达心语
                reason = arrivalSegments[0] || "";
                onTheWayMessage = arrivalSegments[1] || "";
                transitCardMessage = arrivalSegments[2] || "";
                arrivedMessage = arrivalSegments[3] || "";
                arrivalCardMessage = arrivalSegments[4] || "";
            } else if (arrivalSegments.length === 4) {
                // 4段格式：由头/在途报备 | 卡片在途心语 | 微信到达呼唤 | 卡片到达心语
                reason = arrivalSegments[0] || "";
                onTheWayMessage = arrivalSegments[0] || "";
                transitCardMessage = arrivalSegments[1] || "";
                arrivedMessage = arrivalSegments[2] || "";
                arrivalCardMessage = arrivalSegments[3] || "";
            } else if (arrivalSegments.length === 3) {
                // 3段格式：卡片在途心语 | 微信到达呼唤 | 卡片到达心语
                transitCardMessage = arrivalSegments[0] || "";
                arrivedMessage = arrivalSegments[1] || "";
                arrivalCardMessage = arrivalSegments[2] || "";
            } else if (arrivalSegments.length === 2) {
                // 2段格式：微信到达呼唤 | 卡片到达心语
                arrivedMessage = arrivalSegments[0] || "";
                arrivalCardMessage = arrivalSegments[1] || "";
            } else if (arrivalSegments.length === 1) {
                // 1段格式：现场等候语 / 由头 / 在途心语
                reason = arrivalSegments[0] || "";
                transitCardMessage = arrivalSegments[0] || "";
            }

            return {
                content: "",
                mediaType: "offline_invite_change_place" as const,
                mediaData: {
                    offlineInvite: {
                        direction,
                        place,
                        timeStr,
                        reason,
                        onTheWayMessage,
                        transitCardMessage,
                        arrivedMessage,
                        arrivalCardMessage,
                        status: "pending" as const,
                    },
                    label: `更改地点:${place}`,
                },
            };
        },
    },
    {
        // [提前到达] or [我已到达] or [到达现场] or [提前抵达] or [提前到达:卡片到达私房心语]
        regex: new RegExp(`\\[(?:提前到达|我已到达|到达现场|提前抵达)(?:${C}([^\\]]+))?\\]`),
        build: (m) => {
            const arrivalCardMessage = m[1]?.trim() || "";
            return {
                content: "",
                mediaType: "offline_invite_early_arrive" as const,
                mediaData: {
                    offlineInvite: {
                        direction: "he_comes",
                        arrivalCardMessage,
                    },
                    label: "提前到达",
                },
            };
        },
    },
    {
        // [提醒赴约] or [再次邀约] or [重新邀约]
        regex: /\[(?:提醒赴约|再次邀约|重新邀约)\]/,
        build: () => ({
            content: "",
            mediaType: "offline_invite_remind" as const,
        }),
    },
    {
        // [取消邀约] or [撤销邀约] or [收回邀约] or [取消赴约] or [撤销赴约]
        regex: /\[(?:取消邀约|撤销邀约|收回邀约|取消赴约|撤销赴约)\]/,
        build: () => ({
            content: "",
            mediaType: "offline_invite_cancel" as const,
            mediaData: {
                label: "取消邀约",
            },
        }),
    },
    {
        // [封禁线下:次数:台词(可选)] / [线下封禁:次数:台词] / [封锁线下...] / [线下封锁...]
        regex: new RegExp(`\\[(?:封禁线下|线下封禁|封锁线下|线下封锁)(?:${C}(\\d+))?(?:${C}([^\\]]+))?\\]`),
        build: (m) => ({
            content: "",
            mediaType: "offline_lock" as const,
            mediaData: {
                offlineLock: {
                    requiredKnocks: Math.max(1, Math.min(7, parseInt(m[1] || "3", 10))),
                    lockMessage: m[2]?.trim() || "",
                },
                label: "封禁线下",
            },
        }),
    },
    {
        // [解除封禁] / [解除线下封禁] / [解封线下] / [解除封锁] / [解除线下封锁] / [线下解封]（支持可选理由参数）
        regex: new RegExp(`\\[(?:解除封禁|解除线下封禁|解封线下|解除封锁|解除线下封锁|线下解封)(?:${C}[^\\]]+)?\\]`),
        build: () => ({
            content: "",
            mediaType: "offline_unlock" as const,
        }),
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
    // Protect <style>...</style> and following HTML until next double-newline + non-HTML,
    // 或者撞上 [/状态栏]、[/内心] 的闭合标签。
    // 闭合标签这一支不能省：AI 按契约在 [状态栏] 里直出 HTML 时，HTML 和闭合标签之间
    // 通常只有单换行、没有空行可停，保护段就会一路吞到 $——把 [/状态栏] 连同它后面的
    // 聊天正文一起卷进占位符。闭合标签在下面 extractBracketBlock 跑之前就没了，状态栏
    // 提取不到，整块连标签带 HTML 全泄进气泡。（"要空一行才正常"就是撞的这里。）
    protected_ = protected_.replace(/<style[\s\S]*?<\/style>[\s\S]*?(?=\n\n[^<\x00]|\s*\[\/(?:状态栏|内心)\]|$)/gi, (match) => {
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
    // 保护线下邀约/封禁/解除封禁相关指令，防止被 parseStateValues 误匹配为角色状态值属性（如 [封禁线下:2]）
    const offlineDirectivePlaceholders: { placeholder: string; original: string }[] = [];
    const protectedForSV = protected_.replace(/\[(?:封禁线下|线下封禁|封锁线下|线下封锁|解除封禁|解除线下封禁|解封线下|解除封锁|解除线下封锁|线下解封|线下邀约|更改地点|修改地点|变更地点|提前到达|我已到达|到达现场|提前抵达|强行动身|强行赴约|霸道奔赴|执意赶来|执意奔赴|提醒赴约|再次邀约|重新邀约|取消邀约|撤销邀约|收回邀约|取消赴约|撤销赴约)(?:[:：][^\]]+)?\]/g, (match) => {
        const placeholder = `\x00OFFLINE_DIR_${offlineDirectivePlaceholders.length}\x00`;
        offlineDirectivePlaceholders.push({ placeholder, original: match });
        return placeholder;
    });

    const parsedSV = parseStateValues(protectedForSV);

    // 恢复 cleanText 中的线下指令占位符，供后续 parseSegment 与指令提取正常处理
    let svCleanText = parsedSV.cleanText;
    for (const { placeholder, original } of offlineDirectivePlaceholders) {
        svCleanText = svCleanText.split(placeholder).join(original);
    }

    // 过滤名为“封禁线下/线下封禁”的状态值，防止误识别为角色状态属性
    const isLockSVName = (name?: string) => name === "封禁线下" || name === "线下封禁" || name === "解除封禁" || name === "解封线下";
    const cleanPreviousState = (previousState || []).filter(sv => !isLockSVName(sv.name));
    const cleanFreshSV = parsedSV.stateValues.filter(sv => !isLockSVName(sv.name));
    const stateValues = mergeStateValues(cleanPreviousState, cleanFreshSV);

    // 1.5. Strip AI hallucination XML/bracket action shells
    const actionCleaned = stripActionShells(svCleanText);

    // 2. Extract display-only status panel, then inner monologue
    const status = extractBracketBlock(actionCleaned, "状态栏");
    const mono = extractBracketBlock(status.cleaned, "内心");

    // 过滤内心独白中可能夹带的封禁线下指令，避免在外显便利贴中暴露
    let monoCleanedContent = mono.content;
    let lockFromMono: ParsedMessagePart | null = null;
    const lockMatchInMono = monoCleanedContent.match(/\[(?:封禁线下|线下封禁|封锁线下|线下封锁)(?:[:：](\d+))?(?:[:：]([^\]]+))?\]/);
    if (lockMatchInMono) {
        lockFromMono = {
            content: "",
            mediaType: "offline_lock" as const,
            mediaData: {
                offlineLock: {
                    requiredKnocks: Math.max(1, Math.min(7, parseInt(lockMatchInMono[1] || "3", 10))),
                    lockMessage: lockMatchInMono[2]?.trim() || "",
                },
                label: "封禁线下",
            },
        };
        monoCleanedContent = monoCleanedContent.replace(/\[(?:封禁线下|线下封禁|封锁线下|线下封锁)(?:[:：][^\]]+)?\]/g, "").trim();
    }
    if (/\[(?:解除封禁|解除线下封禁|解封线下|解除封锁|解除线下封锁|线下解封)(?:[:：][^\]]+)?\]/.test(monoCleanedContent)) {
        if (!lockFromMono) {
            lockFromMono = {
                content: "",
                mediaType: "offline_unlock" as const,
            };
        }
        monoCleanedContent = monoCleanedContent.replace(/\[(?:解除封禁|解除线下封禁|解封线下|解除封锁|解除线下封锁|线下解封)(?:[:：][^\]]+)?\]/g, "").trim();
    }

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
    if (lockFromMono && !parts.some(p => p.mediaType === "offline_lock" || p.mediaType === "offline_unlock")) {
        parts.push(lockFromMono);
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
        freshStateValues: cleanFreshSV,
        statusPanel: restore(status.content),
        innerMonologue: restore(monoCleanedContent),
    };
}
