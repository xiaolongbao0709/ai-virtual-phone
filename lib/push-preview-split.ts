// 离线推送的弹窗预览分条：复刻 rich-message-parser.parseAIResponse 的
// 状态值剥离 → [状态栏]/[内心] 剥离 → 双空行分条 三步（纯文本层面）。
// 只用于推送横幅文案；聊天记录的正式落账仍由客户端走完整 parseAIResponse。
// 保持零浏览器依赖：Netlify Function 与客户端共享 import。

import { parseStateValues } from "./state-value-parser";

function stripBracketBlock(text: string, tag: string): string {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)\\[\\/${escaped}\\]`, "g"), "");
}

/** 常见富媒体标记 → 弹窗友好文案；与 parseAndSaveResponse 的横幅口径对齐。 */
function humanizeSegment(segment: string): string {
    const marker = segment.match(/^\[([^\][：:]{1,12})[：:]([\s\S]*?)\]$/);
    if (!marker) return segment;
    const kind = marker[1];
    if (/表情包/.test(kind)) return "[表情包]";
    if (/图片|照片|图片描述/.test(kind)) return `发了一张照片: ${marker[2].slice(0, 40)}`;
    if (/语音/.test(kind)) return "[语音]";
    if (/红包/.test(kind)) return "[红包]";
    if (/转账/.test(kind)) return "[转账]";
    if (/位置/.test(kind)) return "[位置]";
    if (/拍一拍|拍了拍/.test(kind)) return "拍了拍你";
    if (/语音通话/.test(kind)) return "发起了语音通话";
    if (/视频通话/.test(kind)) return "发起了视频通话";
    return segment;
}

/** 拆出推送弹窗用的每条文案（已剥状态栏/内心/状态值，双空行分条）。 */
export function splitResponseForPushPreview(rawText: string): string[] {
    let text = parseStateValues(rawText).cleanText;
    text = stripBracketBlock(text, "状态栏");
    text = stripBracketBlock(text, "内心");
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text
        .split(/\n\n+/)
        .map(segment => humanizeSegment(segment.trim()))
        .map(segment => segment.replace(/\s+/g, " ").trim())
        .filter(Boolean);
}
