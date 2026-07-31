// lib/weixin-bridge.ts
// WeChat iLink Bot 核心收发逻辑。
// 所有 iLink 请求通过 /api/weixin 代理转发（解决 CORS）。

import { type WeixinBotConfig } from "./weixin-storage";
import { createOrGetSession, loadChatMessages, loadChatSessions, pushChatMessage, getLatestCharacterStateValues } from "./chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import type { MediaAttachment } from "./tool-executor";
import { loadMediaBlob, isMediaStoreRef } from "./media-cache-storage";
import { parseAIResponse, type ParsedMessagePart } from "./rich-message-parser";
import { splitBilingualText } from "./bilingual-text";
import { resolveVoiceConfig, synthesizeSpeech } from "./tts-service";
import { formatShoppingPaymentRequestHistory } from "./shopping-payment-request";

// ── iLink 实际消息格式 ────────────────────────────────────────
type ILinkTextItem = { type: 1; text_item: { text: string } };
type ILinkItem = ILinkTextItem | { type: number; [key: string]: unknown };

type ILinkMessage = {
    message_id?: number;
    from_user_id?: string;
    to_user_id?: string;
    context_token?: string;
    item_list?: ILinkItem[];
};

type ILinkPollResponse = {
    ret?: number;
    error_code?: number;
    msgs?: ILinkMessage[];
    get_updates_buf?: string;
};

const BASE_INFO = { channel_version: "1.0.2" };

type WeixinOutgoing =
    | { kind: "text"; text: string }
    | { kind: "image"; imageDataUrl: string }
    | { kind: "voice"; audioDataUrl: string; transcript: string; duration: number; fallbackImageDataUrl: string | null };

function cleanText(text: unknown): string {
    return typeof text === "string" ? text.trim() : "";
}

function moneyText(amount: unknown): string {
    return typeof amount === "number" && Number.isFinite(amount)
        ? `¥${amount.toFixed(2).replace(/\.00$/, "")}`
        : "";
}

function getMediaLabel(part: ParsedMessagePart): string {
    const data = part.mediaData || {};
    return cleanText(data.label)
        || cleanText(data.musicTitle)
        || cleanText(data.giftName)
        || cleanText(data.xiaohongshuTitle)
        || cleanText(part.content);
}

function getVoiceTranscript(part: ParsedMessagePart): string {
    return getMediaLabel(part) || "语音消息";
}

function getVoiceSpeechText(transcript: string): string {
    return transcript
        .split(/\n+/)
        .map(line => splitBilingualText(line)?.original || line)
        .join("\n")
        .trim();
}

function estimateVoiceDuration(text: string): number {
    return Math.max(2, Math.ceil(text.length / 4));
}

function partToWeixinText(part: ParsedMessagePart, charName: string): string | null {
    const data = part.mediaData || {};
    const content = cleanText(part.content);
    if (!part.mediaType) return content || null;

    if (part.mediaType === "audio") {
        const label = getMediaLabel(part);
        return label ? `语音：${label}` : "发来一条语音";
    }
    if (part.mediaType === "quote") {
        const quote = cleanText(data.quotePreview);
        return quote ? `引用「${quote}」：${content}` : content || null;
    }
    if (part.mediaType === "poke") {
        const sender = cleanText(data.pokeSender) || charName;
        const target = cleanText(data.pokeTarget) || "你";
        return `${sender === "我" ? charName : sender} 拍了拍 ${target}`;
    }
    if (part.mediaType === "voice_call") return `${charName}向你发起了语音通话`;
    if (part.mediaType === "video_call") return `${charName}向你发起了视频通话`;
    if (part.mediaType === "accept_red_packet") return `${charName}领取了红包`;
    if (part.mediaType === "decline_red_packet") return `${charName}退回了红包`;
    if (part.mediaType === "accept_transfer") return `${charName}接受了转账`;
    if (part.mediaType === "decline_transfer") return `${charName}拒收了转账`;
    if (part.mediaType === "payment_request") return formatShoppingPaymentRequestHistory({
        amount: data.amount,
        amountLabel: data.paymentRequestAmountLabel,
        items: data.paymentRequestItems,
        itemsText: data.paymentRequestItemsText,
    });
    if (part.mediaType === "accept_payment_request") return `${charName}接受了代付`;
    if (part.mediaType === "decline_payment_request") return `${charName}拒绝了代付`;

    return content || null;
}

const CANVAS_SCALE = 3;
const SANS_FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
const SERIF_FONT = `Georgia, "Times New Roman", "Noto Serif SC", "Songti SC", serif`;

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = width * CANVAS_SCALE;
    canvas.height = height * CANVAS_SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(CANVAS_SCALE, CANVAS_SCALE);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return { canvas, ctx };
}

function canvasFont(weight: number | string, size: number, family = SANS_FONT): string {
    return `${weight} ${size}px ${family}`;
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function wrapTextLines(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    maxLines: number,
): string[] {
    const chars = Array.from(text);
    const lines: string[] = [];
    let line = "";
    for (const ch of chars) {
        const next = line + ch;
        if (ctx.measureText(next).width > maxWidth && line) {
            lines.push(line);
            line = ch;
            if (lines.length >= maxLines) return lines;
        } else {
            line = next;
        }
    }
    if (line && lines.length < maxLines) lines.push(line);
    return lines;
}

function drawWrappedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    maxLines: number,
): number {
    const lines = wrapTextLines(ctx, text, maxWidth, maxLines);
    for (const line of lines) {
        ctx.fillText(line, x, y);
        y += lineHeight;
    }
    return y;
}

function drawCenteredWrappedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    centerX: number,
    centerY: number,
    maxWidth: number,
    lineHeight: number,
    maxLines: number,
): number {
    const previousAlign = ctx.textAlign;
    const previousBaseline = ctx.textBaseline;
    const lines = wrapTextLines(ctx, text, maxWidth, maxLines);
    const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((line, index) => {
        ctx.fillText(line, centerX, startY + index * lineHeight);
    });
    ctx.textAlign = previousAlign;
    ctx.textBaseline = previousBaseline;
    return startY + lines.length * lineHeight;
}

function drawSingleLineText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number) {
    if (ctx.measureText(text).width <= maxWidth) {
        ctx.fillText(text, x, y);
        return;
    }
    let clipped = text;
    while (clipped.length > 1 && ctx.measureText(`${clipped}...`).width > maxWidth) {
        clipped = clipped.slice(0, -1);
    }
    ctx.fillText(`${clipped}...`, x, y);
}

function fillRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient) {
    ctx.fillStyle = fill;
    drawRoundedRect(ctx, x, y, w, h, r);
    ctx.fill();
}

function clipRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    drawRoundedRect(ctx, x, y, w, h, r);
    ctx.clip();
}

function drawMoneyIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, fill: string, text = "¥") {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = canvasFont(800, size * 0.47);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + size / 2, y + size / 2 + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
}

function drawRedPacketIcon(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    fillRoundedRect(ctx, x, y, w, h, 8, "#c93424");
    ctx.fillStyle = "#f8d678";
    ctx.fillRect(x + 5, y + 8, w - 10, 3);
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2 + 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#9e251d";
    ctx.font = canvasFont(800, 13);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("福", x + w / 2, y + h / 2 + 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
}

function drawMusicIcon(ctx: CanvasRenderingContext2D, x: number, y: number, scale = 1, stroke = "#5b7b64") {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(10, 31);
    ctx.lineTo(10, 8);
    ctx.lineTo(32, 4);
    ctx.lineTo(32, 27);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(7, 31, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(29, 27, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

function drawMapPin(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, fill = "#4ca66a") {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.bezierCurveTo(-size * 0.55, size * 0.32, -size * 0.5, -size * 0.35, 0, -size * 0.42);
    ctx.bezierCurveTo(size * 0.5, -size * 0.35, size * 0.55, size * 0.32, 0, size);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(0, 1, size * 0.19, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function renderRedPacketCard(part: ParsedMessagePart): string | null {
    const data = part.mediaData || {};
    const canvasPack = makeCanvas(240, 108);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;
    ctx.save();
    clipRoundedRect(ctx, 0, 0, 240, 108, 12);

    const gradient = ctx.createLinearGradient(0, 0, 240, 76);
    gradient.addColorStop(0, "#fa9d3b");
    gradient.addColorStop(1, "#e8602c");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 240, 76);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 76, 240, 32);

    drawRedPacketIcon(ctx, 16, 21, 34, 34);
    ctx.fillStyle = "#ffffff";
    ctx.font = canvasFont(500, 15);
    drawSingleLineText(ctx, cleanText(data.label) || "恭喜发财，大吉大利", 62, 36, 160);
    if (typeof data.count === "number" && data.count > 1) {
        ctx.fillStyle = "rgba(255,255,255,0.74)";
        ctx.font = canvasFont(500, 12);
        ctx.fillText(`共 ${data.count} 个`, 62, 56);
    }

    ctx.fillStyle = data.status === "declined" ? "#a9a9a9" : "#8a8a8a";
    ctx.font = canvasFont(400, 11);
    ctx.fillText("微信红包", 16, 97);
    ctx.restore();
    return canvas.toDataURL("image/png");
}

function renderTransferCard(part: ParsedMessagePart): string | null {
    const data = part.mediaData || {};
    const hasRecipient = !!cleanText(data.recipientName);
    const height = hasRecipient ? 130 : 108;
    const canvasPack = makeCanvas(240, height);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;
    ctx.save();
    clipRoundedRect(ctx, 0, 0, 240, height, 12);

    const gradient = ctx.createLinearGradient(0, 0, 240, 78);
    gradient.addColorStop(0, "#fdbe5c");
    gradient.addColorStop(1, "#f09c41");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 240, hasRecipient ? 100 : 78);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, hasRecipient ? 100 : 78, 240, 32);

    drawMoneyIcon(ctx, 16, 23, 34, "rgba(255,255,255,0.22)");
    ctx.fillStyle = "#ffffff";
    ctx.font = canvasFont(800, 24);
    ctx.fillText(moneyText(data.amount) || "¥0", 62, 38);
    ctx.font = canvasFont(500, 13);
    ctx.fillStyle = "rgba(255,255,255,0.86)";
    drawSingleLineText(ctx, cleanText(data.label) || "转账", 62, 59, 154);
    if (hasRecipient) {
        ctx.font = canvasFont(500, 12);
        ctx.fillStyle = "rgba(255,255,255,0.72)";
        drawSingleLineText(ctx, `转给 ${cleanText(data.recipientName)}`, 16, 91, 208);
    }

    ctx.fillStyle = "#8a8a8a";
    ctx.font = canvasFont(400, 12);
    ctx.fillText("微信转账", 16, hasRecipient ? 120 : 98);
    if (data.status === "received") {
        ctx.textAlign = "right";
        ctx.fillText("已收款", 224, hasRecipient ? 120 : 98);
        ctx.textAlign = "left";
    } else if (data.status === "declined") {
        ctx.textAlign = "right";
        ctx.fillText("已退回", 224, hasRecipient ? 120 : 98);
        ctx.textAlign = "left";
    }
    ctx.restore();
    return canvas.toDataURL("image/png");
}

function renderPaymentRequestCard(part: ParsedMessagePart): string | null {
    const data = part.mediaData || {};
    const canvasPack = makeCanvas(260, 132);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;
    const amountText = moneyText(data.amount) || (cleanText(data.paymentRequestAmountLabel) ? `¥${cleanText(data.paymentRequestAmountLabel)}` : "¥0");
    const itemsText = cleanText(data.paymentRequestItemsText)
        || (Array.isArray(data.paymentRequestItems)
            ? data.paymentRequestItems
                .map(item => `${cleanText(item?.title)}/${cleanText(item?.detail)}/${cleanText(item?.priceLabel)}/${cleanText(item?.quantityLabel)}`)
                .filter(Boolean)
                .join("; ")
            : "");

    ctx.save();
    clipRoundedRect(ctx, 0, 0, 260, 132, 14);

    const gradient = ctx.createLinearGradient(0, 0, 260, 88);
    gradient.addColorStop(0, "#43b883");
    gradient.addColorStop(1, "#2b8f72");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 260, 88);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 88, 260, 44);

    drawMoneyIcon(ctx, 18, 26, 36, "rgba(255,255,255,0.22)");
    ctx.fillStyle = "#ffffff";
    ctx.font = canvasFont(800, 24);
    drawSingleLineText(ctx, amountText, 66, 42, 166);
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.font = canvasFont(500, 13);
    drawSingleLineText(ctx, "请TA代付", 66, 64, 166);

    ctx.fillStyle = "#3f4f49";
    ctx.font = canvasFont(600, 12);
    drawWrappedText(ctx, itemsText || "商品", 16, 108, 198, 15, 2);
    ctx.fillStyle = "#8a8a8a";
    ctx.font = canvasFont(500, 11);
    ctx.textAlign = "right";
    const status = data.status === "paid" ? "已代付" : data.status === "declined" ? "已拒绝" : "待代付";
    ctx.fillText(status, 244, 120);
    ctx.textAlign = "left";
    ctx.restore();
    return canvas.toDataURL("image/png");
}

function renderGiftCard(part: ParsedMessagePart): string | null {
    const data = part.mediaData || {};
    const title = cleanText(data.giftName) || cleanText(data.label) || "礼物";
    const merchant = cleanText(data.giftMerchantLabel) || "角色赠礼";
    const recipient = cleanText(data.recipientName);
    const serial = (cleanText(data.shoppingGiftId) || cleanText(data.giftOrderId) || title || "gift")
        .replace(/[^a-z0-9]/gi, "")
        .slice(-6)
        .toUpperCase() || "GIFT01";
    const canvasPack = makeCanvas(248, 338);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 248, 338);
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, 247, 337);

    ctx.fillStyle = "#8e8a82";
    ctx.font = canvasFont(700, 11);
    ctx.fillText("GIFT CARD", 20, 30);
    ctx.fillStyle = "#2c3440";
    ctx.font = canvasFont(400, 12);
    drawSingleLineText(ctx, merchant, 20, 51, 128);
    fillRoundedRect(ctx, 180, 20, 48, 24, 4, "rgba(0,0,0,0.055)");
    ctx.fillStyle = "#2c3440";
    ctx.font = canvasFont(700, 11);
    ctx.fillText("已送出", 187, 36);

    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.beginPath();
    ctx.moveTo(20, 74);
    ctx.lineTo(228, 74);
    ctx.stroke();

    ctx.fillStyle = "#8e8a82";
    ctx.font = canvasFont(700, 10);
    ctx.fillText("SELECTED GIFT", 20, 106);
    ctx.fillStyle = "#2c3440";
    ctx.font = canvasFont(600, 24);
    drawWrappedText(ctx, title, 20, 136, 208, 28, 3);

    const cells: Array<[string, string, boolean?]> = [
        ...(recipient ? [["收礼人", recipient, true] as [string, string, boolean]] : []),
        ["编号", `G-${serial}`],
        ["来源", merchant],
        ["礼物值", cleanText(data.giftPriceLabel) || "心意礼物"],
    ];
    let x = 20;
    let y = 220;
    cells.slice(0, 4).forEach(([label, value, strong], index) => {
        x = index % 2 === 0 ? 20 : 132;
        y = 220 + Math.floor(index / 2) * 48;
        ctx.fillStyle = "#8e8a82";
        ctx.font = canvasFont(400, 10);
        ctx.fillText(label, x, y);
        ctx.fillStyle = strong ? "#2c3440" : "#5f6670";
        ctx.font = canvasFont(strong ? 700 : 400, 12);
        drawSingleLineText(ctx, value, x, y + 20, 88);
    });

    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.beginPath();
    ctx.moveTo(20, 300);
    ctx.lineTo(228, 300);
    ctx.stroke();
    ctx.fillStyle = "#8e8a82";
    ctx.font = canvasFont(700, 10);
    ctx.fillText("GIFT CERTIFICATE", 20, 322);
    ctx.textAlign = "right";
    ctx.fillText("AI PHONE", 228, 322);
    ctx.textAlign = "left";
    return canvas.toDataURL("image/png");
}

function renderPhotoCard(part: ParsedMessagePart): string | null {
    const label = getMediaLabel(part) || "照片";
    const canvasPack = makeCanvas(180, 180);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 180, 180);
    ctx.strokeStyle = "rgba(0,0,0,0.06)";
    ctx.strokeRect(0.5, 0.5, 179, 179);
    ctx.fillStyle = "#2c3440";
    ctx.font = canvasFont("italic 400", 11.5, SERIF_FONT);
    drawCenteredWrappedText(ctx, label, 90, 90, 124, 16, 4);
    return canvas.toDataURL("image/png");
}

function renderLocationCard(part: ParsedMessagePart): string | null {
    const label = getMediaLabel(part) || "位置";
    const canvasPack = makeCanvas(220, 140);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;
    ctx.save();
    clipRoundedRect(ctx, 0, 0, 220, 140, 12);
    const gradient = ctx.createLinearGradient(0, 0, 220, 100);
    gradient.addColorStop(0, "#d4ebd0");
    gradient.addColorStop(0.52, "#a8d5a2");
    gradient.addColorStop(1, "#c5e1c0");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 220, 100);
    ctx.strokeStyle = "rgba(44,52,64,0.12)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= 220; x += 20) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 100); ctx.stroke();
    }
    for (let y = 0; y <= 100; y += 20) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(220, y); ctx.stroke();
    }
    drawMapPin(ctx, 110, 42, 34);
    ctx.fillStyle = "#f2f3f5";
    ctx.fillRect(0, 100, 220, 40);
    drawMapPin(ctx, 21, 114, 10, "#35a668");
    ctx.fillStyle = "#2c3440";
    ctx.font = canvasFont(600, 13);
    drawSingleLineText(ctx, label, 38, 124, 164);
    ctx.restore();
    return canvas.toDataURL("image/png");
}

function renderMusicShareCard(part: ParsedMessagePart): string | null {
    const data = part.mediaData || {};
    const title = cleanText(data.musicTitle) || getMediaLabel(part) || "未知歌曲";
    const artist = cleanText(data.musicArtist);
    const canvasPack = makeCanvas(220, 92);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;
    fillRoundedRect(ctx, 0, 0, 220, 92, 16, "#f6fbf5");
    ctx.strokeStyle = "rgba(91,123,100,0.28)";
    ctx.lineWidth = 1;
    drawRoundedRect(ctx, 0.5, 0.5, 219, 91, 16);
    ctx.stroke();
    fillRoundedRect(ctx, 12, 12, 44, 44, 10, "rgba(186,225,220,0.55)");
    drawMusicIcon(ctx, 23, 20, 0.72, "#5b7b64");
    ctx.fillStyle = "#2b3d31";
    ctx.font = canvasFont(700, 13);
    drawSingleLineText(ctx, title, 66, 33, 136);
    if (artist) {
        ctx.fillStyle = "#5b7b64";
        ctx.font = canvasFont(400, 11);
        drawSingleLineText(ctx, artist, 66, 51, 136);
    }
    ctx.strokeStyle = "rgba(91,123,100,0.14)";
    ctx.beginPath();
    ctx.moveTo(0, 68);
    ctx.lineTo(220, 68);
    ctx.stroke();
    drawMusicIcon(ctx, 12, 74, 0.34, "#5b7b64");
    ctx.fillStyle = "rgba(91,123,100,0.72)";
    ctx.font = canvasFont(500, 10);
    ctx.fillText("音乐", 30, 83);
    return canvas.toDataURL("image/png");
}

function renderXiaohongshuShareCard(part: ParsedMessagePart): string | null {
    const data = part.mediaData || {};
    const title = cleanText(data.xiaohongshuTitle) || getMediaLabel(part) || "小红书帖子";
    const author = cleanText(data.xiaohongshuAuthor) || "小红书用户";
    const body = cleanText(data.xiaohongshuDescription) || cleanText(data.xiaohongshuBody);
    const tags = Array.isArray(data.xiaohongshuTags) ? data.xiaohongshuTags.map(cleanText).filter(Boolean).slice(0, 3) : [];
    const canvasPack = makeCanvas(236, tags.length ? 164 : 138);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;
    fillRoundedRect(ctx, 0, 0, 236, tags.length ? 164 : 138, 8, "#ffffff");
    ctx.fillStyle = "#ff2442";
    fillRoundedRect(ctx, 11, 9, 30, 16, 4, "#ff2442");
    ctx.fillStyle = "#ffffff";
    ctx.font = canvasFont(800, 9);
    ctx.fillText("RED", 17, 21);
    ctx.fillStyle = "#6b4a50";
    ctx.font = canvasFont(600, 10);
    ctx.fillText(data.xiaohongshuNoteType === "video" ? "视频帖子" : "小红书帖子", 48, 21);

    const coverGradient = ctx.createLinearGradient(11, 34, 69, 106);
    coverGradient.addColorStop(0, "#fff1f4");
    coverGradient.addColorStop(1, "#f6f0ff");
    fillRoundedRect(ctx, 11, 34, 58, 72, 6, coverGradient);
    ctx.fillStyle = "#ff2442";
    ctx.font = canvasFont(800, 24);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cleanText(data.xiaohongshuCoverIcon) || (data.xiaohongshuNoteType === "video" ? "▶" : "小"), 40, 70);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    ctx.fillStyle = "#2c1d20";
    ctx.font = canvasFont(800, 13);
    drawWrappedText(ctx, title, 79, 48, 142, 17, 2);
    ctx.fillStyle = "#8d626b";
    ctx.font = canvasFont(500, 11);
    drawSingleLineText(ctx, author, 79, 77, 142);
    if (body) {
        ctx.fillStyle = "#6f5a5e";
        ctx.font = canvasFont(400, 11);
        drawWrappedText(ctx, body, 79, 97, 142, 15, 2);
    }

    let tagX = 11;
    tags.forEach((tag) => {
        const text = `#${tag}`;
        ctx.font = canvasFont(700, 10);
        const width = Math.min(70, ctx.measureText(text).width + 14);
        fillRoundedRect(ctx, tagX, 128, width, 20, 10, "#fff0f3");
        ctx.fillStyle = "#ff2442";
        drawSingleLineText(ctx, text, tagX + 7, 142, width - 14);
        tagX += width + 5;
    });
    return canvas.toDataURL("image/png");
}

function renderStickerPlaceholder(part: ParsedMessagePart): string | null {
    const label = getMediaLabel(part) || "表情包";
    const canvasPack = makeCanvas(120, 120);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;
    fillRoundedRect(ctx, 8, 18, 104, 84, 14, "#f7f7f7");
    ctx.fillStyle = "#2c3440";
    ctx.font = canvasFont(600, 14);
    drawCenteredWrappedText(ctx, `[${label}]`, 60, 63, 72, 18, 3);
    return canvas.toDataURL("image/png");
}

function renderVoiceMessageCard(transcript: string, duration: number): string | null {
    const canvasPack = makeCanvas(360, 190);
    if (!canvasPack) return null;
    const { canvas, ctx } = canvasPack;

    const bg = ctx.createLinearGradient(0, 0, 360, 190);
    bg.addColorStop(0, "#f7f8f4");
    bg.addColorStop(1, "#eef2ec");
    fillRoundedRect(ctx, 0, 0, 360, 190, 18, bg);

    fillRoundedRect(ctx, 28, 24, 224, 58, 16, "#9be26c");
    ctx.fillStyle = "#1c3420";
    ctx.beginPath();
    ctx.moveTo(18, 54);
    ctx.lineTo(30, 44);
    ctx.lineTo(30, 64);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#1e3a24";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(58, 53, 8, -0.55, 0.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(58, 53, 15, -0.55, 0.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(58, 53, 22, -0.55, 0.55);
    ctx.stroke();

    ctx.fillStyle = "#1e3a24";
    ctx.font = canvasFont(700, 18);
    ctx.textBaseline = "middle";
    ctx.fillText(`${duration}"`, 106, 54);
    ctx.fillStyle = "#4f6b52";
    ctx.font = canvasFont(600, 12);
    ctx.fillText("VOICE MESSAGE", 158, 54);

    ctx.strokeStyle = "rgba(36, 56, 38, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(28, 104);
    ctx.lineTo(332, 104);
    ctx.stroke();

    ctx.fillStyle = "#5f6c5d";
    ctx.font = canvasFont(700, 12);
    ctx.textBaseline = "alphabetic";
    ctx.fillText("转文字", 28, 127);

    ctx.fillStyle = "#242b24";
    ctx.font = canvasFont(500, 16);
    drawWrappedText(ctx, transcript, 28, 153, 304, 22, 2);
    ctx.textBaseline = "alphabetic";

    return canvas.toDataURL("image/png");
}

function blobToAudioDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || "");
            if (/^data:audio\//i.test(dataUrl)) {
                resolve(dataUrl);
                return;
            }
            const normalized = dataUrl.replace(/^data:[^;]*;base64,/i, "data:audio/mpeg;base64,");
            resolve(normalized);
        };
        reader.onerror = () => reject(reader.error || new Error("read_audio_blob_failed"));
        reader.readAsDataURL(blob);
    });
}

function getAudioDuration(blob: Blob): Promise<number | null> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const cleanup = () => URL.revokeObjectURL(url);
        audio.onloadedmetadata = () => {
            const seconds = Number.isFinite(audio.duration) ? Math.ceil(audio.duration) : null;
            cleanup();
            resolve(seconds && seconds > 0 ? seconds : null);
        };
        audio.onerror = () => {
            cleanup();
            resolve(null);
        };
        audio.src = url;
    });
}

async function renderMediaCard(part: ParsedMessagePart, charName: string): Promise<string | null> {
    void charName;
    switch (part.mediaType) {
        case "red_packet": return renderRedPacketCard(part);
        case "transfer": return renderTransferCard(part);
        case "payment_request": return renderPaymentRequestCard(part);
        case "gift": return renderGiftCard(part);
        case "image": return renderPhotoCard(part);
        case "location": return renderLocationCard(part);
        case "music":
        case "music_share": return renderMusicShareCard(part);
        case "xiaohongshu_note_share": return renderXiaohongshuShareCard(part);
        case "sticker": return renderStickerPlaceholder(part);
        default: return null;
    }
}

async function partToWeixinOutgoing(part: ParsedMessagePart, charName: string, characterId: string): Promise<WeixinOutgoing | null> {
    const directImage = cleanText(part.mediaData?.stickerUrl);
    if (directImage.startsWith("data:image/")) return { kind: "image", imageDataUrl: directImage };
    if (part.mediaType === "audio") {
        const transcript = getVoiceTranscript(part);
        const speechText = getVoiceSpeechText(transcript);
        const fallbackDuration = typeof part.mediaData?.voiceDuration === "number"
            ? Math.max(1, Math.ceil(part.mediaData.voiceDuration))
            : estimateVoiceDuration(speechText || transcript);
        const fallbackImageDataUrl = renderVoiceMessageCard(transcript, fallbackDuration);
        const voiceConfig = resolveVoiceConfig(characterId, "chat");
        if (voiceConfig?.enableTTS) {
            try {
                const audioBlob = await synthesizeSpeech(speechText || transcript, voiceConfig);
                if (audioBlob) {
                    const [audioDataUrl, audioDuration] = await Promise.all([
                        blobToAudioDataUrl(audioBlob),
                        getAudioDuration(audioBlob),
                    ]);
                    if (audioDataUrl.startsWith("data:audio/")) {
                        return {
                            kind: "voice",
                            audioDataUrl,
                            transcript,
                            duration: audioDuration || fallbackDuration,
                            fallbackImageDataUrl,
                        };
                    }
                }
            } catch (err) {
                console.warn("[WeixinBridge] voice synthesis failed:", err);
            }
        }
        return fallbackImageDataUrl ? { kind: "image", imageDataUrl: fallbackImageDataUrl } : { kind: "text", text: `语音：${transcript}` };
    }
    const card = await renderMediaCard(part, charName);
    if (card) return { kind: "image", imageDataUrl: card };
    const text = partToWeixinText(part, charName);
    return text ? { kind: "text", text } : null;
}

// ── 通过代理调用 iLink ────────────────────────────────────────
async function ilinkCall<T = unknown>(
    path: string,
    body?: unknown,
    botToken?: string,
    signal?: AbortSignal,
): Promise<T> {
    const res = await fetch("/api/weixin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, method: "POST", botToken, body: body ?? {} }),
        signal,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`proxy ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
}

// ── QR 码登录 ─────────────────────────────────────────────────
export type QrLoginStatus = "wait" | "scaned" | "confirmed" | "expired";

type QrCodeResponse = {
    qrcode: string;                  // 轮询用的 ID
    qrcode_img_content: string;      // 可展示的二维码 URL
};

type QrStatusResponse = {
    status: QrLoginStatus;
    bot_token?: string;
    ilink_bot_id?: string;
};

/** 获取登录二维码 */
export async function getLoginQrCode(): Promise<QrCodeResponse> {
    return ilinkCall<QrCodeResponse>(
        "/ilink/bot/get_bot_qrcode?bot_type=3",
        undefined,
        undefined,
    );
}

/** 轮询扫码状态 */
export async function pollQrCodeStatus(qrcode: string): Promise<QrStatusResponse> {
    return ilinkCall<QrStatusResponse>(
        `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        undefined,
        undefined,
    );
}

// ── 处理一条来自微信的消息 ────────────────────────────────────
async function handleIncomingMessage(
    bot: WeixinBotConfig,
    msg: ILinkMessage,
): Promise<void> {
    const textItem = msg.item_list?.find((i): i is ILinkTextItem => i.type === 1);
    if (!textItem || !msg.from_user_id || !msg.context_token) return;

    const userContent = textItem.text_item.text.trim();
    if (!userContent) return;

    const session = createOrGetSession(bot.characterId);
    const history = loadChatMessages(session.id);

  try { // ← 顶层 try，任何崩溃都会在聊天窗口显示

    // 1. 存入用户消息 → 通知 UI 刷新
    const userMsg = pushChatMessage({ sessionId: session.id, role: "user", content: userContent });
    notifyUI(session.id);

    // 2. 发送"正在输入"状态 + 调 chat engine
    let typingTicket: string | undefined;
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    try {
        const cfg = await ilinkCall<{ ret?: number; typing_ticket?: string }>(
            "/ilink/bot/getconfig",
            { ilink_user_id: msg.from_user_id, context_token: msg.context_token, base_info: BASE_INFO },
            bot.botToken,
        );
        typingTicket = cfg.typing_ticket;
    } catch { /* ignore */ }

    if (typingTicket) {
        const sendTyping = () => ilinkCall(
            "/ilink/bot/sendtyping",
            { ilink_user_id: msg.from_user_id, typing_ticket: typingTicket, status: 1, base_info: BASE_INFO },
            bot.botToken,
        ).catch(() => {});
        sendTyping();
        typingTimer = setInterval(sendTyping, 5000);
    }

    let rawReply: string;
    const toolMediaAttachments: MediaAttachment[] = [];

    window.dispatchEvent(new CustomEvent("weixin-generating", { detail: { sessionId: session.id, generating: true } }));

    try {
        rawReply = flattenCompletionResult(await generateChatCompletion(session, [...history, userMsg], { appTags: ["chat", "text"] }, {
            onToolNotice: (notice) => {
                pushChatMessage({ sessionId: session.id, role: "system", content: notice, mediaType: "tool_notice" });
                notifyUI(session.id);
            },
            onToolExecution: (results) => {
                for (const r of results) {
                    for (const att of r.mediaAttachments || []) {
                        toolMediaAttachments.push(att);
                        pushChatMessage({
                            sessionId: session.id,
                            role: "assistant",
                            content: att.title || "",
                            mediaType: "media_file",
                            mediaUrl: att.url,
                            mediaData: { fileType: att.type, fileName: att.title },
                        });
                    }
                }
                notifyUI(session.id);
            },
        }));
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        pushBridgeNotice(session.id, `[微信] AI 生成失败: ${errMsg}`);
        return;
    } finally {
        if (typingTimer) clearInterval(typingTimer);
        if (typingTicket) {
            ilinkCall("/ilink/bot/sendtyping",
                { ilink_user_id: msg.from_user_id, typing_ticket: typingTicket, status: 2, base_info: BASE_INFO },
                bot.botToken,
            ).catch(() => {});
        }
        window.dispatchEvent(new CustomEvent("weixin-generating", { detail: { sessionId: session.id, generating: false } }));
    }

    // 3. 用 parseAIResponse 解析（和 follow-up-service / chat-room 一致）
    const previousState = getLatestCharacterStateValues(bot.characterId);

    const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(rawReply, previousState);

    // 解析角色名
    const sessions = loadChatSessions();
    const sess = sessions.find(s => s.id === session.id);
    const charName = sess?.alias || bot.nickname || "对方";

    const visibleParts: ParsedMessagePart[] = [];
    const weixinOutbox: WeixinOutgoing[] = [];
    for (const p of parts) {
        const outgoing = await partToWeixinOutgoing(p, charName, bot.characterId);
        if (outgoing) weixinOutbox.push(outgoing);

        if (p.mediaType === "voice_call" || p.mediaType === "video_call") continue;
        if (p.mediaType === "accept_red_packet" || p.mediaType === "decline_red_packet"
            || p.mediaType === "accept_transfer" || p.mediaType === "decline_transfer"
            || p.mediaType === "accept_payment_request" || p.mediaType === "decline_payment_request") continue;
        if (p.mediaType === "poke") {
            const pokeSender = (p.mediaData?.pokeSender === "我" ? charName : p.mediaData?.pokeSender) || charName;
            const pokeTarget = p.mediaData?.pokeTarget || "你";
            pushChatMessage({
                sessionId: session.id, role: "system",
                content: `${pokeSender} 拍了拍 ${pokeTarget}`,
                mediaType: "poke", mediaData: { pokeSender, pokeTarget },
            });
            continue;
        }
        visibleParts.push(p);
    }

    // 4. 逐条存入（带 mediaType / innerMonologue / stateValues），和 chat-room 一模一样
    if (visibleParts.length === 0 && (statusPanel || innerMonologue)) {
        pushChatMessage({
            sessionId: session.id, role: "assistant", content: "",
            statusPanel, innerMonologue, stateValues: stateValues.length > 0 ? stateValues : undefined,
            freshStateValues,
        });
    } else {
        for (let i = 0; i < visibleParts.length; i++) {
            pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: visibleParts[i].content,
                mediaType: visibleParts[i].mediaType,
                mediaData: visibleParts[i].mediaData,
                statusPanel: i === 0 && statusPanel ? statusPanel : undefined,
                innerMonologue: i === 0 && innerMonologue ? innerMonologue : undefined,
                stateValues: i === 0 && stateValues.length > 0 ? stateValues : undefined,
                freshStateValues: i === 0 ? freshStateValues : undefined,
            });
        }
    }

    // 5. 通知 chat-room 从 storage 重新加载（格式完整）
    notifyUI(session.id);

    // 6. 逐条回复微信（文字直接发；富媒体卡片先渲染成图片再发）
    if (weixinOutbox.length === 0) return;

    for (let i = 0; i < weixinOutbox.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 600));
        try {
            const item = weixinOutbox[i];
            if (item.kind === "image") {
                const sendImageRes = await fetch("/api/weixin", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "send_image",
                        botToken: bot.botToken,
                        toUserId: msg.from_user_id,
                        contextToken: msg.context_token,
                        imageDataUrl: item.imageDataUrl,
                    }),
                });
                if (!sendImageRes.ok) {
                    const errText = await sendImageRes.text();
                    pushBridgeNotice(session.id, `[微信转发] 第${i + 1}张图片失败: ${errText.slice(0, 200)}`);
                }
                continue;
            }
            if (item.kind === "voice") {
                const sendVoiceRes = await fetch("/api/weixin", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "send_voice",
                        botToken: bot.botToken,
                        toUserId: msg.from_user_id,
                        contextToken: msg.context_token,
                        audioDataUrl: item.audioDataUrl,
                        duration: item.duration,
                        transcript: item.transcript,
                    }),
                });
                if (!sendVoiceRes.ok) {
                    const errText = await sendVoiceRes.text();
                    pushBridgeNotice(session.id, `[微信转发] 第${i + 1}条语音失败: ${errText.slice(0, 200)}`);
                    if (item.fallbackImageDataUrl) {
                        const fallbackRes = await fetch("/api/weixin", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                action: "send_image",
                                botToken: bot.botToken,
                                toUserId: msg.from_user_id,
                                contextToken: msg.context_token,
                                imageDataUrl: item.fallbackImageDataUrl,
                            }),
                        });
                        if (!fallbackRes.ok) {
                            const fallbackErr = await fallbackRes.text();
                            pushBridgeNotice(session.id, `[微信转发] 第${i + 1}条语音图片失败: ${fallbackErr.slice(0, 200)}`);
                        }
                    }
                }
                continue;
            }
            const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const sendRes = await fetch("/api/weixin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    path: "/ilink/bot/sendmessage",
                    method: "POST",
                    botToken: bot.botToken,
                    body: {
                        msg: {
                            from_user_id: "",
                            to_user_id: msg.from_user_id,
                            client_id: clientId,
                            message_type: 2,
                            message_state: 2,
                            context_token: msg.context_token,
                            item_list: [{ type: 1, text_item: { text: item.text } }],
                        },
                        base_info: BASE_INFO,
                    },
                }),
            });
            if (!sendRes.ok) {
                const errText = await sendRes.text();
                pushBridgeNotice(session.id, `[微信转发] 第${i + 1}条失败: ${errText.slice(0, 200)}`);
            }
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            pushBridgeNotice(session.id, `[微信转发] 第${i + 1}条异常: ${errMsg}`);
        }
    }

    // 7. 发送工具生成的媒体文件到微信
    for (let i = 0; i < toolMediaAttachments.length; i++) {
        const att = toolMediaAttachments[i];
        try {
            let blob: Blob | null = null;
            if (isMediaStoreRef(att.url)) {
                const media = await loadMediaBlob(att.url);
                if (media) blob = media.blob;
            } else if (att.url.startsWith("http://") || att.url.startsWith("https://")) {
                const res = await fetch(att.url);
                if (res.ok) blob = await res.blob();
            }
            if (!blob) continue;
            const reader = new FileReader();
            const dataUrl = await new Promise<string>((resolve) => {
                reader.onload = () => resolve(String(reader.result || ""));
                reader.readAsDataURL(blob!);
            });
            if (!dataUrl.startsWith("data:")) continue;

            if (att.type === "image" && dataUrl.startsWith("data:image/")) {
                const res = await fetch("/api/weixin", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "send_image",
                        botToken: bot.botToken,
                        toUserId: msg.from_user_id,
                        contextToken: msg.context_token,
                        imageDataUrl: dataUrl,
                    }),
                });
                if (!res.ok) pushBridgeNotice(session.id, `[微信转发] 工具图片${i + 1}失败: ${(await res.text()).slice(0, 200)}`);
            } else if (att.type === "audio" && dataUrl.startsWith("data:audio/")) {
                const res = await fetch("/api/weixin", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "send_voice",
                        botToken: bot.botToken,
                        toUserId: msg.from_user_id,
                        contextToken: msg.context_token,
                        audioDataUrl: dataUrl,
                    }),
                });
                if (!res.ok) pushBridgeNotice(session.id, `[微信转发] 工具音频${i + 1}失败: ${(await res.text()).slice(0, 200)}`);
            } else if (att.type === "video" || att.type === "file") {
                const defaultExt = att.type === "video" ? "mp4" : "bin";
                const rawName = att.title || "file";
                const fileName = /\.\w{2,5}$/.test(rawName) ? rawName : `${rawName}.${defaultExt}`;
                const res = await fetch("/api/weixin", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        action: "send_file",
                        botToken: bot.botToken,
                        toUserId: msg.from_user_id,
                        contextToken: msg.context_token,
                        fileDataUrl: dataUrl,
                        fileName,
                    }),
                });
                if (!res.ok) pushBridgeNotice(session.id, `[微信转发] 工具文件${i + 1}失败: ${(await res.text()).slice(0, 200)}`);
            }
        } catch (err) {
            pushBridgeNotice(session.id, `[微信转发] 工具媒体${i + 1}异常: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

  } catch (outerErr: unknown) { // ← 顶层 catch
    const errMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    pushBridgeNotice(session.id, `[微信桥接] 整体错误: ${errMsg}`);
  }
}

/** 通知 chat-room 从 storage 重新加载消息（格式完整，含内心卡片等） */
function notifyUI(sessionId: string) {
    window.dispatchEvent(new CustomEvent("weixin-messages-updated", { detail: { sessionId } }));
}

/** 在聊天窗口中插入一条桥接状态提示 */
function pushBridgeNotice(sessionId: string, text: string) {
    pushChatMessage({ sessionId, role: "system", content: text });
    notifyUI(sessionId);
}

// ── 单个 Bot 的轮询主循环 ─────────────────────────────────────
export async function runBotLoop(
    bot: WeixinBotConfig,
    signal: AbortSignal,
    onStatusChange: (status: "running" | "error", message?: string) => void,
): Promise<void> {
    let updatesBuf = "";
    let consecutiveErrors = 0;

    onStatusChange("running");

    while (!signal.aborted) {
        try {
            const data = await ilinkCall<ILinkPollResponse>(
                "/ilink/bot/getupdates",
                { get_updates_buf: updatesBuf, base_info: BASE_INFO },
                bot.botToken,
                signal,
            );

            if (signal.aborted) break;
            consecutiveErrors = 0;

            // Token 过期（-14）：停止，提示重新登录
            if (data.error_code === -14) {
                onStatusChange("error", "Token 已过期，请重新扫码");
                return;
            }

            // 保存游标
            if (data.get_updates_buf) {
                updatesBuf = data.get_updates_buf;
            }

            // 顺序处理每条消息（确保历史完整后再处理下一条）
            if (data.msgs?.length) {
                for (const msg of data.msgs) {
                    if (msg.from_user_id && msg.item_list?.length) {
                        await handleIncomingMessage(bot, msg).catch(err => {
                            console.warn("[WeixinBridge] handleIncomingMessage error:", err);
                        });
                    }
                }
            }
        } catch (err: unknown) {
            if (signal.aborted) break;
            consecutiveErrors++;
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[WeixinBridge] poll error (${consecutiveErrors}):`, errMsg);

            if (consecutiveErrors >= 5) {
                onStatusChange("error", `连续请求失败: ${errMsg}`);
                return;
            }

            const delay = Math.min(3000 * consecutiveErrors, 15000);
            await new Promise(resolve => {
                const t = setTimeout(resolve, delay);
                signal.addEventListener("abort", () => { clearTimeout(t); resolve(undefined); }, { once: true });
            });
        }
    }
}
