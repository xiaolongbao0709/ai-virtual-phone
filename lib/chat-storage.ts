// lib/chat-storage.ts

import {
    initChatDb,
    dbPutMessage, dbDeleteMessage, dbDeleteMessagesBySession, dbDeleteMessagesByIds,
    dbPutMessages, dbPutSessions, dbPutContacts, dbDeleteSession,
    dbReplaceContacts, dbReplaceSessions,
} from "./chat-db";
import { resolveUserIdentity } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { emitChatPluginEvent, runChatPluginTransformSync } from "./chat-plugin-hooks";
import { parseAIResponse } from "./rich-message-parser";
import { extractTextToolDirectiveText } from "./text-tool-protocol";

export const DEFAULT_VISION_IMAGE_PROMPT_LIMIT = 1;
export const MAX_VISION_IMAGE_PROMPT_LIMIT = 20;
export const CHAT_INITIAL_VISIBLE_MESSAGE_COUNT = 50;
export const CHAT_LOAD_MORE_MESSAGE_COUNT = 30;

export function normalizeVisionImagePromptLimit(value: unknown): number {
    if (value === undefined || value === null || value === "") return DEFAULT_VISION_IMAGE_PROMPT_LIMIT;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_VISION_IMAGE_PROMPT_LIMIT;
    return Math.max(0, Math.min(MAX_VISION_IMAGE_PROMPT_LIMIT, Math.floor(parsed)));
}

export type ChatContact = {
    id: string; // unique contact id
    characterId: string; // links to global character in character-storage.ts
    nickname?: string;
    addedAt: string; // ISO date
};

export type ChatSession = {
    id: string;
    contactId: string;
    lastMessageId?: string;
    lastMessagePreview?: string;
    unreadCount: number;
    updatedAt: string; // ISO date
    isPinned: boolean;
    backgroundImage?: string; // Add support for custom background
    autoReplied?: boolean; // Whether the initial greeting auto-reply has been triggered
    alias?: string;
    videoBackground?: string;
    voiceBackground?: string;
    isBlacklisted?: boolean;
    customCSS?: string;
    isMuted?: boolean;
    bilingualTranslationEnabled?: boolean;
    collapseBilingualTranslation?: boolean;
    /** 丢弃角色输出的无效表情包（名称不在角色表情包与内置表情中时直接滤除该消息） */
    discardInvalidStickers?: boolean;
    bilingualTranslationPrompt?: string;
    offlineBilingualTranslationPrompt?: string;
    nativeExpandedToolSourceIds?: string[];
    visionImagePromptLimit?: number;
    // Group chat fields
    isGroup?: boolean;
    groupName?: string;
    participantIds?: string[]; // characterId array
    groupVideoBackgrounds?: Record<string, string>; // characterId|"self" → image ID
    // Group admin fields ("self" = the user)
    groupOwnerId?: string; // "self" | characterId; legacy groups default to "self", spectator groups to first member
    groupAdminIds?: string[]; // characterId | "self"
    groupMutes?: Record<string, string>; // (characterId | "self") → mute expiry ISO
    allowAdminActionsOnUser?: boolean; // characters may kick/mute the user (default off)
    isSpectator?: boolean; // 围观群：用户不在群内，只能生成/线下
};

export type ChatMessageStatus = "sending" | "sent" | "read" | "failed";
export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export type StateValue = { name: string; value: number };
export type NativeToolCallRecord = { id: string; name: string; args: Record<string, unknown>; thoughtSignature?: string };
export type NativeToolResultRecord = { toolCallId: string; name: string; content: string };

export type ChatMessage = {
    id: string;
    sessionId: string;
    role: ChatMessageRole;
    content: string;
    status: ChatMessageStatus;
    createdAt: string; // ISO date
    order?: number; // Stable per-session display order
    responseBatchId?: string; // Assistant raw-response batch id
    rawResponseText?: string; // Assistant raw response before parsing/splitting
    responseRoundId?: string; // Group-chat whole-round id shared across all bubbles in one assistant turn
    toolExecutionId?: string; // Links visible tool attachments to their persisted tool result
    editableResponseText?: string; // Processed text shown in the reply editor
    isRetracted?: boolean;
    mediaType?: "image" | "audio" | "video"
        | "red_packet" | "transfer" | "location"
        | "poke" | "sticker" | "quote" | "dice"
        | "voice_call" | "video_call"
        | "accept_red_packet" | "decline_red_packet" | "accept_transfer" | "decline_transfer"
        | "payment_request" | "accept_payment_request" | "decline_payment_request"
        | "music" | "music_share" | "music_notify" | "music_not_found"
        | "xiaohongshu_note_share"
        | "gift"
        | "contact_card"
        | "app_card"
        | "tool_notice"
        | "tool_call"
        | "tool_result"
        | "memory_write_request"
        | "reading_discuss"
        | "system_instruction"
        | "group_admin_notice"
        | "media_file"
        | `plugin:${string}`; // 聊天插件自定义消息类型（由注册该 kind 的插件渲染气泡）
    origin?: "chat" | "reading_discuss" | "custom_app" | "custom_app_background";
    mediaUrl?: string;
    mediaData?: {
        amount?: number;          // 红包/转账金额
        count?: number;           // 红包个数
        label?: string;           // 红包留言/转账备注/照片描述/位置名/表情名
        status?: "pending" | "opened" | "received" | "declined" | "paid" | "canceled";  // 红包/转账/代付状态
        quoteMessageId?: string;  // 引用消息 ID
        quotePreview?: string;    // 引用消息预览文本
        quoteRole?: ChatMessageRole; // 引用消息的 role
        stickerUrl?: string;      // 表情包图片路径
        diceFace?: number;        // 骰子点数（1-6），气泡翻滚后定格并与全屏动效一致
        pokeSender?: string;      // 拍一拍发起人名字
        pokeTarget?: string;      // 拍一拍目标名字
        contactCardName?: string; // 名片被推荐人名字（渲染时按推荐人同世界实时解析，未建档也可成卡）
        senderName?: string;      // 转账发起人显示名（群聊）
        recipientId?: string;     // 转账收款人角色 ID
        recipientName?: string;   // 转账收款人显示名
        claimedBy?: string[];     // 群红包已领取人名列表
        claimedAmounts?: Record<string, number>; // 拼手气红包：每人领取金额
        walletTransactionId?: string; // 发送红包/转账时扣款流水
        walletRefundTransactionId?: string; // 被拒收/退回时退款流水
        walletDepositTransactionId?: string; // 领取红包/转账时入账流水
        shoppingGiftId?: string; // 购物订单中的可送礼物实例 ID
        giftOrderId?: string;    // 礼物来源订单 ID
        giftItemId?: string;     // 礼物来源商品 ID
        giftName?: string;       // 礼物商品名
        giftMerchantLabel?: string; // 礼物来源商家
        giftPriceLabel?: string; // 礼物商品价格
        giftPreviewIcon?: string;// 礼物展示图标
        giftTone?: "ivory" | "mist" | "blush" | "graphite";
        giftDeliveredAt?: string;// 到货时间
        giftSentAt?: string;     // 送出时间
        paymentRequestId?: string; // 代付请求 ID
        shoppingOrderId?: string;  // 代付关联购物订单 ID
        paymentRequestAmountLabel?: string; // 代付金额展示
        paymentRequestItemsText?: string;   // AI 输出的代付商品文本
        paymentRequestItems?: Array<{
            title: string;
            detail: string;
            priceLabel: string;
            quantityLabel: string;
        }>;
        paymentRequestSummary?: string;
        paymentRequesterId?: string;
        paymentRequesterName?: string;
        paymentPayerId?: string;
        paymentPayerName?: string;
        paymentRequestedAt?: string;
        paymentResolvedAt?: string;
        paymentWalletTransactionId?: string;
        blackMarketTheaterLocalId?: string;
        blackMarketTheaterTemplateId?: string;
        blackMarketTheaterTitle?: string;
        blackMarketTheaterCodeName?: string;
        blackMarketTheaterRarity?: string;
        blackMarketTheaterSynopsis?: string;
        blackMarketTheaterGlyph?: string;
        blackMarketTheaterStartedAt?: string;
        claimer?: string;         // 领取/接受动作的执行人名
        owner?: string;           // 领取/接受动作的目标人名（谁发的红包/转账）
        adminAction?: "transfer_owner" | "set_admin" | "unset_admin" | "kick" | "invite" | "mute" | "unmute"; // 群管理操作类型
        adminActorName?: string;  // 群管理操作执行人显示名
        adminTargetName?: string; // 群管理操作目标显示名
        adminMuteMinutes?: number;// 禁言时长（分钟）
        musicTitle?: string;      // 音乐标题
        musicArtist?: string;     // 音乐歌手
        xiaohongshuAuthor?: string;       // 小红书分享作者
        xiaohongshuTitle?: string;        // 小红书分享标题
        xiaohongshuBody?: string;         // 小红书分享正文
        xiaohongshuDescription?: string;  // 小红书分享图片/视频描述
        xiaohongshuNoteType?: "post" | "video";
        xiaohongshuTags?: string[];
        xiaohongshuImageAssetId?: string;
        xiaohongshuCoverIcon?: string;
        xiaohongshuTone?: string;
        callDuration?: string;    // 通话时长（如 05:23）
        voiceDuration?: number;   // 语音条时长（秒）
        synthesizedFromText?: string; // 语音条当前音频对应的合成文本
        memoryContent?: string;   // 记忆写入内容
        memoryReason?: string;    // 记忆写入原因
        memoryImportance?: number;// 记忆写入重要性
        memoryRequestStatus?: "pending" | "approved" | "ignored";
        fileType?: "audio" | "image" | "video" | "file";
        fileName?: string;
        fileDuration?: number;
        useReferenceImage?: boolean; // AI photo tag: whether to send the character reference image to the generator
        imageGenerationMediaRef?: string;
        imageGenerationPrompt?: string;
        imageGenerationUsedReference?: boolean;
        imageGenerationStatus?: "pending" | "failed" | "generated";
        imageGenerationError?: string;
        mediaCompressedAt?: string;
        mediaCleanedAt?: string;
        readingBookTitle?: string; // 阅读讨论所属书名，用于 prompt 短期记忆边界
        appId?: string;
        appName?: string;
        appCardTitle?: string;
        appCardBody?: string;
        appCardSummary?: string;
        appCardTone?: string;
        appCardLayout?: Record<string, unknown>;
        appDirectiveId?: string;
        appDirectiveLabel?: string;
        appDirectiveArgs?: string[];
        appDirectiveRaw?: string;
        appSceneId?: string;
        appSceneTag?: string;
        appTags?: string[];
        appHistoryText?: string;
        appHistoryRole?: ChatMessageRole;
    };
    isTyping?: boolean; // temporary flag for UI rendering
    statusPanel?: string; // AI display-only status content from [状态栏] tags
    innerMonologue?: string; // AI inner monologue content from [内心] tags
    reasoningText?: string; // 模型思维链（reasoning/CoT）内容，挂在回复批次的第一条气泡上
    stateValues?: StateValue[]; // parsed character state values from inner monologue
    // 本轮回复实际输出的状态值（未合并历史）。undefined = 旧数据（渲染时回退到 stateValues）；
    // [] = 本轮明确没输出（内心卡片不显示状态面板）。stateValues 仍存合并快照供状态链读取。
    freshStateValues?: StateValue[];
    followUpIndex?: number; // which follow-up round produced this message (1 = first follow-up)
    nativeToolCalls?: NativeToolCallRecord[]; // assistant native function/tool calls for prompt replay
    nativeToolResult?: NativeToolResultRecord; // tool result paired with an assistant native tool call
    nativeToolReasoning?: string; // provider reasoning content required by some tool APIs
    nativeToolOpenRouterReasoningDetails?: unknown[]; // OpenRouter provider-private reasoning state for tool replay
    cloudSync?: {
        source: "weixin-cloud";
        botId?: string;
        externalId?: string;
        direction?: "inbound" | "outbound" | "local";
        syncedAt?: string;
    };
    // Group chat fields
    senderCharacterId?: string; // which character sent this assistant message in a group chat
    senderName?: string; // cached display name to avoid repeated lookups
};

export type ChatAppSettings = {
    globalAppBackground?: string; // base64 or URL
    timeAware?: boolean; // When true, inject timestamps into prompt so AI knows message timing (default: true)
    promptViewerEnabled?: boolean; // When true, show the floating prompt viewer entry
    quickActionEnabled?: boolean; // When true, show the floating quick action entry
    browserNotificationsEnabled?: boolean; // When true, send browser Notification API alerts when page is hidden
    enterToSendEnabled?: boolean; // When true, Enter sends chat input and Shift+Enter inserts a newline
};

export const CHAT_APP_SETTINGS_UPDATED_EVENT = "chat-app-settings-updated";
export const CHAT_MESSAGE_PUSHED_EVENT = "chat-message-pushed";
export const CHAT_MESSAGES_DELETED_EVENT = "chat-messages-deleted";
export const CHAT_REQUEST_REPLY_EVENT = "chat-request-reply";

// ── Media Preview Map ─────────────────────────
const MEDIA_PREVIEW_MAP: Record<string, string> = {
    image: "[图片]", audio: "[语音]", video: "[视频]",
    red_packet: "[红包]", transfer: "[转账]", location: "[位置]",
    poke: "[拍了拍你]", sticker: "[表情]", quote: "[引用]", dice: "[掷骰子]",
    gift: "[礼物]",
    contact_card: "[名片]",
    payment_request: "[代付请求]",
    music: "[音乐]",
    music_share: "[音乐分享]",
    xiaohongshu_note_share: "[小红书分享]",
    app_card: "[应用卡片]",
    tool_notice: "[执行动作]",
    system_instruction: "[系统指令]",
    media_file: "[文件]",
};

export function isReadingDiscussMessage(msg: Pick<ChatMessage, "origin" | "mediaType">): boolean {
    return msg.origin === "reading_discuss" || msg.mediaType === "reading_discuss";
}

export function isSystemInstructionMessage(msg: Pick<ChatMessage, "role" | "mediaType">): boolean {
    return msg.role === "system" && msg.mediaType === "system_instruction";
}

export function getChatMessagePreview(msg: ChatMessage): string {
    if (isReadingDiscussMessage(msg)) return "";

    const userName = (() => { try { return resolveUserIdentity()?.name; } catch { return undefined; } })();
    const toYou = (text: string) => userName ? text.replace(new RegExp(userName, "g"), "你") : text;

    // Retracted: "你/对方撤回了一条消息"
    if (msg.isRetracted) return (msg.role === "user" ? "你" : "对方") + "撤回了一条消息";

    if (msg.mediaType === "tool_result" || msg.mediaType === "tool_call") return "";
    if (msg.mediaType === "quote" && msg.content) return msg.content;
    if (msg.mediaType === "music_notify") return msg.content;
    if (msg.mediaType === "memory_write_request") {
        const status = msg.mediaData?.memoryRequestStatus;
        if (status === "approved") return "[已写入长期记忆]";
        if (status === "ignored") return "[已忽略记忆写入]";
        return "[记忆写入申请]";
    }
    if (isSystemInstructionMessage(msg)) {
        const content = msg.content.trim();
        return content ? `[系统指令] ${content}` : "[系统指令]";
    }

    // Action notifications: show natural language with user name → "你"
    if (msg.mediaType === "accept_red_packet" || msg.mediaType === "decline_red_packet"
        || msg.mediaType === "accept_transfer" || msg.mediaType === "decline_transfer"
        || msg.mediaType === "accept_payment_request" || msg.mediaType === "decline_payment_request"
        || msg.mediaType === "group_admin_notice") {
        return toYou(msg.content);
    }

    // Call messages: stored as assistant/user role, detect by content
    const callInit = msg.content?.match(/\[我向(.+?)发起了((?:语音|视频)通话)\]/);
    if (callInit) {
        if (msg.role === "user") return `你向${callInit[1]}发起了${callInit[2]}`;
        const sess = _sessionsCache.find(s => s.id === msg.sessionId);
        const charName = msg.senderName || (!sess?.isGroup
            ? loadCharacters().find(c => c.id === sess?.contactId)?.name
            : undefined);
        if (sess?.isGroup || callInit[1] === "群聊") {
            return `${charName || "对方"}向群聊发起了${callInit[2]}`;
        }
        return `${charName || "对方"}向你发起了${callInit[2]}`;
    }
    const callHangup = msg.content?.match(/\[我挂断了((?:群?(?:语音|视频))通话)\]/);
    if (callHangup) {
        const dur = msg.mediaData?.callDuration;
        return dur ? `${callHangup[1]} ${dur}` : callHangup[1];
    }
    const callReject = msg.content?.match(/\[我拒绝了((?:群?(?:语音|视频))通话)\]/);
    if (callReject) return `你拒绝了${callReject[1]}`;
    const callCancel = msg.content?.match(/\[我取消了((?:群?(?:语音|视频))通话)\]/);
    if (callCancel) return `你取消了${callCancel[1]}`;

    // Poke: "你 拍了拍 XX" / "XX 拍了拍 你" (no brackets, user name → "你")
    if (msg.mediaType === "poke") {
        const sender = msg.mediaData?.pokeSender || (msg.role === "user" ? "你" : "对方");
        const target = msg.mediaData?.pokeTarget || (msg.role === "user" ? "对方" : "你");
        const dSender = (userName && sender === userName) ? "你" : sender;
        const dTarget = (userName && target === userName) ? "你" : target;
        return `${dSender} 拍了拍 ${dTarget}`;
    }
    if (msg.mediaType === "media_file" && msg.mediaData?.fileType === "image") {
        return msg.mediaData.label ? `[图片] ${msg.mediaData.label}` : "[图片]";
    }
    if (msg.mediaType === "image") {
        const label = msg.mediaData?.label?.trim();
        return label ? `[图片] ${label}` : "[图片]";
    }
    if (msg.mediaType === "app_card") {
        const appName = msg.mediaData?.appName || "APP";
        const title = msg.mediaData?.appCardTitle || msg.mediaData?.appCardSummary || msg.content;
        return title ? `[${appName}] ${title}` : `[${appName}]`;
    }

    if (msg.mediaType) return MEDIA_PREVIEW_MAP[msg.mediaType] || `[${msg.mediaType}]`;

    // Silent thought/status: empty content + folded panel → "♥"
    if (!msg.content.trim() && (msg.innerMonologue || msg.statusPanel || msg.reasoningText) && msg.role === "assistant") return "♥";

    // System messages: call messages → clean format, others → user name → "你"
    if (msg.role === "system") {
        const c = msg.content;
        // Call initiation: [我向XX发起了语音通话] → 你/对方发起了语音通话
        const initiate = c.match(/\[我向(.+?)发起了((?:语音|视频)通话)\]/);
        if (initiate) {
            const target = initiate[1];
            if (userName && target === userName) return `对方发起了${initiate[2]}`;
            return `你发起了${initiate[2]}`;
        }
        // Follow-up AI initiated: [我发起了语音通话] → 对方发起了语音通话
        const initNoTarget = c.match(/\[我发起了((?:语音|视频)通话)\]/);
        if (initNoTarget) return `对方发起了${initNoTarget[1]}`;
        // Hangup: [我挂断了语音通话] → 语音通话 05:23 (duration from mediaData or legacy content)
        const hangup = c.match(/\[我挂断了(群?(?:语音|视频)通话)\](?:\(时长\s*(\d+:\d+)\))?/);
        if (hangup) {
            const dur = msg.mediaData?.callDuration || hangup[2];
            return dur ? `${hangup[1]} ${dur}` : hangup[1];
        }
        // Reject: [我拒绝了语音通话] → 你拒绝了语音通话
        const reject = c.match(/\[我拒绝了(群?(?:语音|视频)通话)\]/);
        if (reject) return `你拒绝了${reject[1]}`;
        // Cancel: [我取消了语音通话] → 你取消了语音通话
        const cancel = c.match(/\[我取消了(群?(?:语音|视频)通话)\]/);
        if (cancel) return `你取消了${cancel[1]}`;
        // Other system messages: user name → "你"
        return toYou(c);
    }

    return msg.content;
}

function hasPreviewText(text: string | undefined): boolean {
    return !!text?.trim();
}

function isSessionPreviewCandidate(msg: ChatMessage): boolean {
    if (isReadingDiscussMessage(msg)) return false;
    if (msg.mediaType === "tool_result" || msg.mediaType === "tool_call") return false;
    if (msg.mediaType === "tool_notice") return false;
    if (msg.mediaType === "memory_write_request") return false;
    if (msg.role === "tool") return false;
    if (msg.nativeToolCalls?.length && !hasPreviewText(msg.content)) return false;

    if (msg.isRetracted) return true;
    if (msg.mediaType) return true;
    if (hasPreviewText(msg.content)) return true;
    if (hasPreviewText(msg.statusPanel) || hasPreviewText(msg.innerMonologue) || hasPreviewText(msg.reasoningText)) return true;

    return false;
}

function getStableMessageOrder(msg: ChatMessage): number | null {
    return typeof msg.order === "number" && Number.isFinite(msg.order) ? msg.order : null;
}

function getMessageTimeValue(msg: Pick<ChatMessage, "createdAt">): number {
    const value = new Date(msg.createdAt).getTime();
    return Number.isFinite(value) ? value : 0;
}

export function compareChatMessages(a: ChatMessage, b: ChatMessage): number {
    const aOrder = getStableMessageOrder(a);
    const bOrder = getStableMessageOrder(b);
    if (aOrder !== null && bOrder !== null && aOrder !== bOrder) {
        return aOrder - bOrder;
    }

    const timeDiff = getMessageTimeValue(a) - getMessageTimeValue(b);
    if (timeDiff !== 0) return timeDiff;

    if (aOrder !== null && bOrder === null) return -1;
    if (aOrder === null && bOrder !== null) return 1;
    return a.id.localeCompare(b.id);
}

function getSortedSessionMessages(sessionId: string): ChatMessage[] {
    return _loadAllMessages()
        .filter(m => m.sessionId === sessionId)
        .sort(compareChatMessages);
}

function getNextMessageOrder(sessionId: string): number {
    let maxOrder = -1;
    for (const msg of _messagesCache) {
        if (msg.sessionId !== sessionId) continue;
        const order = getStableMessageOrder(msg);
        if (order !== null && order > maxOrder) maxOrder = order;
    }
    return maxOrder + 1;
}

function reindexSessionMessageOrders(sessionId: string): void {
    const ordered = getSortedSessionMessages(sessionId);
    const changed = new Map<string, ChatMessage>();

    ordered.forEach((msg, index) => {
        if (msg.order === index) return;
        changed.set(msg.id, { ...msg, order: index });
    });

    if (changed.size === 0) return;
    _messagesCache = _messagesCache.map(msg => changed.get(msg.id) || msg);
    dbPutMessages([...changed.values()]);
}

export function reindexSessionMessageOrdersByTime(sessionId: string): void {
    const ordered = _loadAllMessages()
        .filter(m => m.sessionId === sessionId)
        .sort((a, b) => {
            const timeDiff = getMessageTimeValue(a) - getMessageTimeValue(b);
            if (timeDiff !== 0) return timeDiff;
            return a.id.localeCompare(b.id);
        });
    const changed = new Map<string, ChatMessage>();

    ordered.forEach((msg, index) => {
        if (msg.order === index) return;
        changed.set(msg.id, { ...msg, order: index });
    });

    if (changed.size > 0) {
        _messagesCache = _messagesCache.map(msg => changed.get(msg.id) || msg);
        dbPutMessages([...changed.values()]);
    }

    const lastMsg = getLastVisibleSessionMessage(sessionId);
    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === sessionId);
    if (sessIdx !== -1 && lastMsg) {
        sessions[sessIdx].lastMessageId = lastMsg.id;
        sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
        sessions[sessIdx].updatedAt = lastMsg.createdAt;
        saveChatSessions(sessions);
    }
}

export function getLastVisibleSessionMessage(sessionId: string): ChatMessage | null {
    const messages = getSortedSessionMessages(sessionId);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (!isSessionPreviewCandidate(msg)) continue;
        return msg;
    }
    return null;
}

// ── Storage Keys (settings & follow-up stay in localStorage) ──
const SETTINGS_KEY = "ai_phone_chat_settings_v1";
const DEFAULT_CHAT_APP_SETTINGS: ChatAppSettings = {
    timeAware: true,
    promptViewerEnabled: false,
    quickActionEnabled: false,
    enterToSendEnabled: false,
};

// ── In-Memory Caches (hydrated from IndexedDB on startup) ──────────
let _contactsCache: ChatContact[] = [];
let _sessionsCache: ChatSession[] = [];
let _messagesCache: ChatMessage[] = [];
let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;

type NormalizedList<T> = { items: T[]; changed: boolean };
type NormalizedSessionList = NormalizedList<ChatSession> & { redirects: Map<string, string> };

function parseIsoTime(value: string | undefined): number {
    if (!value) return 0;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function isPreferredContact(candidate: ChatContact, current: ChatContact): boolean {
    const candidateTime = parseIsoTime(candidate.addedAt);
    const currentTime = parseIsoTime(current.addedAt);
    if (candidateTime !== currentTime) return candidateTime > currentTime;
    return candidate.id.localeCompare(current.id) > 0;
}

function normalizeChatContacts(contacts: ChatContact[]): NormalizedList<ChatContact> {
    const normalized: ChatContact[] = [];
    const indexByCharacter = new Map<string, number>();
    let changed = false;

    for (const contact of contacts) {
        const characterId = contact.characterId?.trim();
        if (!contact.id || !characterId) {
            changed = true;
            continue;
        }
        const item = characterId === contact.characterId ? contact : { ...contact, characterId };
        const existingIndex = indexByCharacter.get(characterId);
        if (existingIndex === undefined) {
            indexByCharacter.set(characterId, normalized.length);
            normalized.push(item);
            if (item !== contact) changed = true;
            continue;
        }

        changed = true;
        if (isPreferredContact(item, normalized[existingIndex])) {
            normalized[existingIndex] = item;
        }
    }

    return { items: normalized, changed };
}

function getSessionActivityTime(session: ChatSession): number {
    const lastVisible = getLastVisibleSessionMessage(session.id);
    return Math.max(parseIsoTime(lastVisible?.createdAt), parseIsoTime(session.updatedAt));
}

function isPreferredSession(candidate: ChatSession, current: ChatSession): boolean {
    const candidateActivity = getSessionActivityTime(candidate);
    const currentActivity = getSessionActivityTime(current);
    if (candidateActivity !== currentActivity) return candidateActivity > currentActivity;

    const candidateUpdated = parseIsoTime(candidate.updatedAt);
    const currentUpdated = parseIsoTime(current.updatedAt);
    if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;

    return candidate.id.localeCompare(current.id) > 0;
}

function normalizeChatSessions(sessions: ChatSession[]): NormalizedSessionList {
    const byId = new Map<string, ChatSession>();
    const idOrder: string[] = [];
    const redirects = new Map<string, string>();
    let changed = false;

    for (const session of sessions) {
        const id = session.id?.trim();
        const contactId = session.contactId?.trim();
        if (!id || !contactId) {
            changed = true;
            continue;
        }
        const item = id === session.id && contactId === session.contactId
            ? session
            : { ...session, id, contactId };
        const existing = byId.get(id);
        if (!existing) {
            byId.set(id, item);
            idOrder.push(id);
            if (item !== session) changed = true;
            continue;
        }

        changed = true;
        if (isPreferredSession(item, existing)) {
            byId.set(id, item);
        }
    }

    const normalized: ChatSession[] = [];
    const privateIndexByContact = new Map<string, number>();

    for (const id of idOrder) {
        const session = byId.get(id);
        if (!session) continue;
        if (session.isGroup) {
            normalized.push(session);
            continue;
        }

        const existingIndex = privateIndexByContact.get(session.contactId);
        if (existingIndex === undefined) {
            privateIndexByContact.set(session.contactId, normalized.length);
            normalized.push(session);
            continue;
        }

        changed = true;
        if (isPreferredSession(session, normalized[existingIndex])) {
            const previous = normalized[existingIndex];
            if (previous.id !== session.id) redirects.set(previous.id, session.id);
            normalized[existingIndex] = session;
        } else if (session.id !== normalized[existingIndex].id) {
            redirects.set(session.id, normalized[existingIndex].id);
        }
    }

    return { items: normalized, changed, redirects };
}

function restoreContactsForPrivateSessions(contacts: ChatContact[], sessions: ChatSession[]): NormalizedList<ChatContact> {
    const characterIds = new Set(loadCharacters().map(character => character.id));
    const privateSessionsWithMessages = sessions.filter(session =>
        !session.isGroup
        && session.contactId
        && characterIds.has(session.contactId)
        && Boolean(getLastVisibleSessionMessage(session.id))
    );
    if (privateSessionsWithMessages.length === 0 || contacts.length >= privateSessionsWithMessages.length) {
        return { items: contacts, changed: false };
    }
    if (contacts.length > 0 && contacts.length > Math.floor(privateSessionsWithMessages.length / 2)) {
        return { items: contacts, changed: false };
    }

    const contactIds = new Set(contacts.map(contact => contact.characterId));
    const restored: ChatContact[] = [...contacts];
    let changed = false;

    for (const session of privateSessionsWithMessages) {
        if (contactIds.has(session.contactId)) continue;
        const safeId = session.contactId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || Date.now().toString(36);
        restored.push({
            id: `contact_recovered_${safeId}`,
            characterId: session.contactId,
            addedAt: session.updatedAt || new Date().toISOString(),
        });
        contactIds.add(session.contactId);
        changed = true;
    }

    const normalized = normalizeChatContacts(restored);
    return { items: normalized.items, changed: changed || normalized.changed };
}

function redirectMessagesToPreferredSessions(redirects: Map<string, string>): number {
    if (redirects.size === 0) return 0;
    const affectedSessionIds = new Set<string>();
    const changedMessages: ChatMessage[] = [];

    _messagesCache = _messagesCache.map(message => {
        const nextSessionId = redirects.get(message.sessionId);
        if (!nextSessionId || nextSessionId === message.sessionId) return message;
        affectedSessionIds.add(nextSessionId);
        const updated = { ...message, sessionId: nextSessionId };
        changedMessages.push(updated);
        return updated;
    });

    if (changedMessages.length === 0) return 0;
    dbPutMessages(changedMessages);
    affectedSessionIds.forEach(reindexSessionMessageOrders);
    return changedMessages.length;
}

function normalizeLegacyTextToolHistory(messages: ChatMessage[]): {
    items: ChatMessage[];
    changedMessages: ChatMessage[];
} {
    const byId = new Map(messages.map(message => [message.id, message]));
    const changed = new Map<string, ChatMessage>();
    const added: ChatMessage[] = [];
    const sorted = [...messages].sort(compareChatMessages);

    for (const original of sorted) {
        const current = byId.get(original.id) || original;

        if (current.role === "user" && current.mediaType === "tool_result" && !current.nativeToolResult) {
            const normalized = { ...current, role: "tool" as const };
            byId.set(current.id, normalized);
            changed.set(current.id, normalized);
            continue;
        }

        if (current.role !== "assistant" || current.mediaType !== "tool_result" || current.nativeToolResult) continue;
        const directiveText = extractTextToolDirectiveText(current.content);
        if (!directiveText) continue;

        const currentTime = parseIsoTime(current.createdAt);
        const candidateCopies = sorted
            .map(message => byId.get(message.id) || message)
            .filter(message => {
                if (
                    message.sessionId !== current.sessionId
                    || message.role !== "assistant"
                    || message.mediaType !== "tool_notice"
                    || !message.rawResponseText
                ) return false;
                if (message.rawResponseText === current.content) return true;
                const copyTime = parseIsoTime(message.createdAt);
                return Math.abs(copyTime - currentTime) < 60_000
                    && extractTextToolDirectiveText(message.rawResponseText) === directiveText;
            });
        const copyGroups = new Map<string, ChatMessage[]>();
        for (const copy of candidateCopies) {
            if (!copy.responseBatchId) continue;
            const group = copyGroups.get(copy.responseBatchId) || [];
            group.push(copy);
            copyGroups.set(copy.responseBatchId, group);
        }
        const currentOrder = getStableMessageOrder(current);
        const matchingCopies = [...copyGroups.values()].sort((left, right) => {
            const score = (group: ChatMessage[]) => Math.min(...group.map(copy => {
                const copyOrder = getStableMessageOrder(copy);
                if (currentOrder !== null && copyOrder !== null) {
                    return copyOrder >= currentOrder
                        ? copyOrder - currentOrder
                        : 1_000_000 + currentOrder - copyOrder;
                }
                return Math.abs(parseIsoTime(copy.createdAt) - currentTime);
            }));
            return score(left) - score(right);
        })[0] || [];

        const responseBatchId = matchingCopies[0]?.responseBatchId || current.responseBatchId || createResponseBatchId();
        const copyOrders = matchingCopies
            .map(message => getStableMessageOrder(message))
            .filter((order): order is number => order !== null);
        const nextOrder = copyOrders.length > 0
            ? Math.max(...copyOrders) + 0.0001
            : current.order;
        const normalizedCall: ChatMessage = {
            ...current,
            content: directiveText,
            mediaType: "tool_call",
            responseBatchId,
            rawResponseText: undefined,
            order: nextOrder,
        };
        byId.set(current.id, normalizedCall);
        changed.set(current.id, normalizedCall);

        for (const copy of matchingCopies) {
            const normalizedCopy: ChatMessage = {
                ...copy,
                mediaType: undefined,
                responseBatchId,
            };
            byId.set(copy.id, normalizedCopy);
            changed.set(copy.id, normalizedCopy);
        }
    }

    for (const original of sorted) {
        const current = byId.get(original.id) || original;
        if (
            current.role !== "assistant"
            || current.mediaType !== "tool_notice"
            || !current.rawResponseText
            || !current.responseBatchId
        ) continue;
        const directiveText = extractTextToolDirectiveText(current.rawResponseText);
        if (!directiveText) continue;

        const batchCopies = sorted
            .map(message => byId.get(message.id) || message)
            .filter(message =>
                message.sessionId === current.sessionId
                && message.responseBatchId === current.responseBatchId
                && message.role === "assistant"
                && message.mediaType === "tool_notice"
            );
        for (const copy of batchCopies) {
            const normalizedCopy: ChatMessage = { ...copy, mediaType: undefined };
            byId.set(copy.id, normalizedCopy);
            changed.set(copy.id, normalizedCopy);
        }

        const copyOrders = batchCopies
            .map(message => getStableMessageOrder(message))
            .filter((order): order is number => order !== null);
        const toolCall: ChatMessage = {
            id: createMessageId(),
            sessionId: current.sessionId,
            role: "assistant",
            content: directiveText,
            status: current.status,
            createdAt: current.createdAt,
            order: copyOrders.length > 0 ? Math.max(...copyOrders) + 0.0001 : current.order,
            responseBatchId: current.responseBatchId,
            responseRoundId: current.responseRoundId,
            editableResponseText: current.editableResponseText,
            mediaType: "tool_call",
            senderCharacterId: current.senderCharacterId,
            senderName: current.senderName,
        };
        added.push(toolCall);
        byId.set(toolCall.id, toolCall);
        changed.set(toolCall.id, toolCall);
    }

    return {
        items: [...messages.map(message => byId.get(message.id) || message), ...added],
        changedMessages: [...changed.values()],
    };
}

function refreshSessionPreviewMetadata(sessions: ChatSession[]): NormalizedList<ChatSession> {
    let changed = false;
    const items = sessions.map(session => {
        const lastMsg = getLastVisibleSessionMessage(session.id);
        const nextLastMessageId = lastMsg?.id;
        const nextPreview = lastMsg ? getChatMessagePreview(lastMsg) : "";
        const nextUpdatedAt = lastMsg?.createdAt || session.updatedAt;
        if (
            session.lastMessageId === nextLastMessageId
            && (session.lastMessagePreview || "") === nextPreview
            && session.updatedAt === nextUpdatedAt
        ) {
            return session;
        }
        changed = true;
        return {
            ...session,
            lastMessageId: nextLastMessageId,
            lastMessagePreview: nextPreview,
            updatedAt: nextUpdatedAt,
        };
    });
    return { items, changed };
}

/**
 * Hydrate in-memory caches from IndexedDB. Must be awaited once at app startup
 * before any chat data is accessed. Concurrent calls share the same promise;
 * a failed attempt allows the next call to retry.
 */
export function hydrateChatStorage(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return Promise.resolve();
    if (_hydratePromise) return _hydratePromise;
    _hydratePromise = initChatDb().then(data => {
        const normalizedToolHistory = normalizeLegacyTextToolHistory(data.messages);
        _messagesCache = normalizedToolHistory.items;
        if (normalizedToolHistory.changedMessages.length > 0) {
            dbPutMessages(normalizedToolHistory.changedMessages);
        }
        let normalizedContacts = normalizeChatContacts(data.contacts);
        const normalizedSessions = normalizeChatSessions(data.sessions);
        const redirectedMessages = redirectMessagesToPreferredSessions(normalizedSessions.redirects);
        const refreshedSessions = refreshSessionPreviewMetadata(normalizedSessions.items);
        normalizedContacts = restoreContactsForPrivateSessions(normalizedContacts.items, normalizedSessions.items);
        _contactsCache = normalizedContacts.items;
        _sessionsCache = refreshedSessions.items;
        if (normalizedContacts.changed) dbReplaceContacts(normalizedContacts.items);
        if (normalizedSessions.changed || redirectedMessages > 0 || refreshedSessions.changed) dbReplaceSessions(refreshedSessions.items);
        _hydrated = true;
    }).catch(err => {
        console.warn("[ChatStorage] hydration failed, will retry on next call:", err);
        _hydratePromise = null;
    });
    return _hydratePromise;
}

export function isChatStorageHydrated(): boolean {
    return _hydrated;
}

function _loadAllMessages(): ChatMessage[] {
    return _messagesCache;
}

// ── CRUD for Contacts ─────────────────────────
export function loadChatContacts(): ChatContact[] {
    let normalized = normalizeChatContacts(_contactsCache);
    normalized = restoreContactsForPrivateSessions(normalized.items, _sessionsCache);
    if (normalized.changed) {
        _contactsCache = normalized.items;
        if (_hydrated && typeof window !== "undefined") dbReplaceContacts(normalized.items);
    }
    return _contactsCache;
}

export function saveChatContacts(contacts: ChatContact[]) {
    const normalized = normalizeChatContacts(contacts);
    _contactsCache = normalized.items;
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[ChatStorage] saveChatContacts before hydration; using additive write to avoid replacing existing contacts.");
        dbPutContacts(normalized.items);
        return;
    }
    dbReplaceContacts(normalized.items);
}

export function addChatContact(characterId: string): ChatContact | null {
    const contacts = loadChatContacts();
    if (contacts.find(c => c.characterId === characterId)) return null; // already exists

    const newContact: ChatContact = {
        id: `contact_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        characterId,
        addedAt: new Date().toISOString()
    };
    saveChatContacts([...contacts, newContact]);
    return newContact;
}

export function removeChatContact(characterId: string) {
    const contacts = loadChatContacts();
    saveChatContacts(contacts.filter(c => c.characterId !== characterId));
}

// ── CRUD for Sessions ─────────────────────────
export function loadChatSessions(): ChatSession[] {
    const normalized = normalizeChatSessions(_sessionsCache);
    const redirectedMessages = redirectMessagesToPreferredSessions(normalized.redirects);
    const refreshed = refreshSessionPreviewMetadata(normalized.items);
    if (normalized.changed || redirectedMessages > 0 || refreshed.changed) {
        _sessionsCache = refreshed.items;
        if (_hydrated && typeof window !== "undefined") dbReplaceSessions(refreshed.items);
    }
    return _sessionsCache;
}

export function saveChatSessions(sessions: ChatSession[]) {
    const normalized = normalizeChatSessions(sessions);
    const redirectedMessages = redirectMessagesToPreferredSessions(normalized.redirects);
    const refreshed = refreshSessionPreviewMetadata(normalized.items);
    _sessionsCache = refreshed.items;
    if (!_hydrated && typeof window !== "undefined") {
        console.warn("[ChatStorage] saveChatSessions before hydration; using additive write to avoid replacing existing sessions.");
        dbPutSessions(refreshed.items);
        return;
    }
    if (normalized.changed || redirectedMessages > 0 || refreshed.changed) dbReplaceSessions(refreshed.items);
    else dbPutSessions(refreshed.items);
}

export function createOrGetSession(contactId: string): ChatSession {
    const sessions = loadChatSessions();
    const existing = sessions.find(s => s.contactId === contactId);
    if (existing) return existing;

    const newSession: ChatSession = {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        contactId,
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
        isPinned: false,
        bilingualTranslationEnabled: true,
        collapseBilingualTranslation: true,
        visionImagePromptLimit: DEFAULT_VISION_IMAGE_PROMPT_LIMIT,
    };
    saveChatSessions([newSession, ...sessions]); // Prepend new session
    return newSession;
}

export function createGroupSession(groupName: string, participantIds: string[], options?: { isSpectator?: boolean }): ChatSession {
    const sessions = loadChatSessions();
    const isSpectator = options?.isSpectator === true;
    const newSession: ChatSession = {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        contactId: `group_${Date.now()}`, // synthetic contactId for group
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
        isPinned: false,
        bilingualTranslationEnabled: true,
        collapseBilingualTranslation: true,
        visionImagePromptLimit: DEFAULT_VISION_IMAGE_PROMPT_LIMIT,
        isGroup: true,
        groupName,
        participantIds,
        // 围观群用户不在群内，群主落在第一位成员头上
        groupOwnerId: isSpectator ? participantIds[0] : "self",
        ...(isSpectator ? { isSpectator: true } : {}),
    };
    saveChatSessions([newSession, ...sessions]);
    return newSession;
}

export function deleteChatSession(sessionId: string) {
    const sessions = loadChatSessions();
    const filtered = sessions.filter(s => s.id !== sessionId);
    saveChatSessions(filtered);
    dbDeleteSession(sessionId);
    clearChatSessionMessages(sessionId); // Cleanup associated messages
}

// ── CRUD for Messages ─────────────────────────
export function loadChatMessages(sessionId: string, limit?: number): ChatMessage[] {
    const all = getSortedSessionMessages(sessionId);
    if (limit && limit < all.length) return all.slice(-limit);
    return all;
}

function createMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createResponseBatchId(): string {
    return `resp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createResponseRoundId(): string {
    return `round_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createToolExecutionId(): string {
    return `toolrun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function pushChatMessage(msg: Omit<ChatMessage, "id" | "createdAt" | "status"> & { status?: ChatMessageStatus }): ChatMessage {
    let newMsg: ChatMessage = {
        ...msg,
        id: createMessageId(),
        createdAt: new Date().toISOString(),
        order: getNextMessageOrder(msg.sessionId),
        status: msg.status || "sent"
    };

    // 聊天插件织入点：消息落库前同步改写（全部消息路径都会经过这里）
    const pluginResult = runChatPluginTransformSync("message.beforePersist", { message: newMsg });
    if (pluginResult.message && typeof pluginResult.message === "object" && pluginResult.message.id === newMsg.id) {
        newMsg = pluginResult.message;
    }

    _messagesCache.push(newMsg);
    dbPutMessage(newMsg);

    // Auto update session last message only for records that can produce a list preview.
    const preview = getChatMessagePreview(newMsg);
    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === msg.sessionId);
    if (sessIdx !== -1 && isSessionPreviewCandidate(newMsg)) {
        sessions[sessIdx].lastMessageId = newMsg.id;
        if (preview) {
            sessions[sessIdx].lastMessagePreview = preview;
        }
        sessions[sessIdx].updatedAt = newMsg.createdAt;
        saveChatSessions(sessions);
    }

    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CHAT_MESSAGE_PUSHED_EVENT, { detail: { message: newMsg } }));
    }
    emitChatPluginEvent("message.persisted", { message: newMsg });

    return newMsg;
}

export function upsertImportedChatMessage(msg: ChatMessage): { message: ChatMessage; inserted: boolean } {
    const existing = _messagesCache.find(item => item.id === msg.id);
    if (existing) return { message: existing, inserted: false };

    const newMsg: ChatMessage = {
        ...msg,
        status: msg.status || "sent",
        createdAt: msg.createdAt || new Date().toISOString(),
        order: typeof msg.order === "number" ? msg.order : getNextMessageOrder(msg.sessionId),
    };

    _messagesCache.push(newMsg);
    dbPutMessage(newMsg);

    const preview = getChatMessagePreview(newMsg);
    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === newMsg.sessionId);
    if (sessIdx !== -1 && isSessionPreviewCandidate(newMsg)) {
        const currentLast = getLastVisibleSessionMessage(newMsg.sessionId);
        if (!currentLast || currentLast.id === newMsg.id) {
            sessions[sessIdx].lastMessageId = newMsg.id;
            if (preview) sessions[sessIdx].lastMessagePreview = preview;
            sessions[sessIdx].updatedAt = newMsg.createdAt;
            saveChatSessions(sessions);
        }
    }

    return { message: newMsg, inserted: true };
}

function removeFirstExactResponsePart(rawResponseText: string, content: string): string {
    const part = content.trim();
    if (!part) return rawResponseText;
    const index = rawResponseText.indexOf(part);
    if (index === -1) return rawResponseText;
    return `${rawResponseText.slice(0, index)}${rawResponseText.slice(index + part.length)}`
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function formatStateValuesForRaw(stateValues?: StateValue[]): string {
    if (!stateValues || stateValues.length === 0) return "";
    return stateValues.map(item => `[${item.name}:${item.value}]`).join("");
}

function messageToEditableRawPart(message: ChatMessage): string {
    if (message.mediaType === "tool_notice" || message.mediaType === "tool_result") return "";
    if (message.mediaType === "poke") {
        const sender = message.mediaData?.pokeSender?.trim();
        const target = message.mediaData?.pokeTarget?.trim();
        if (sender && target) return `[${sender}拍了拍${target}]`;
    }
    if (message.mediaType === "image") {
        const label = message.mediaData?.label?.trim() || message.content.trim();
        if (label) return `[照片:${label}]`;
    }
    return message.content.trim();
}

function rebuildEditableRawFromRemainingBatch(messages: ChatMessage[]): string {
    const sorted = [...messages]
        .filter(message => message.role === "assistant")
        .sort(compareChatMessages);
    if (sorted.length === 0) return "";

    const metaCarrier = sorted.find(message =>
        (message.stateValues && message.stateValues.length > 0)
        || message.statusPanel
        || message.innerMonologue
    );
    const headerParts = [
        formatStateValuesForRaw(metaCarrier?.stateValues),
        metaCarrier?.statusPanel ? `[状态栏]${metaCarrier.statusPanel}[/状态栏]` : "",
        metaCarrier?.innerMonologue ? `[内心]${metaCarrier.innerMonologue}[/内心]` : "",
    ].filter(Boolean);
    const bodyParts = sorted
        .map(messageToEditableRawPart)
        .filter(part => part.length > 0);

    return [...headerParts, ...bodyParts].join("\n\n").trim();
}

function normalizeParsedRawPartForCompare(part: ReturnType<typeof parseAIResponse>["parts"][number]): string {
    if (part.mediaType === "poke") {
        const sender = part.mediaData?.pokeSender?.trim();
        const target = part.mediaData?.pokeTarget?.trim();
        return sender && target ? `${sender} 拍了拍 ${target}` : "";
    }
    if (part.mediaType === "image") {
        return part.mediaData?.label?.trim() || part.content.trim();
    }
    return part.content.trim();
}

function rawTextStillContainsDeletedPart(rawText: string, deleted: ChatMessage): boolean {
    const deletedText = deleted.content.trim();
    if (deletedText && rawText.includes(deletedText)) return true;
    try {
        return parseAIResponse(rawText, []).parts.some(part => {
            if (deleted.mediaType === "poke" && part.mediaType === "poke") return true;
            const normalized = normalizeParsedRawPartForCompare(part);
            if (!normalized) return false;
            return normalized === deletedText
                || (!!deletedText && normalized.includes(deletedText))
                || (!!deleted.mediaData?.label && normalized.includes(String(deleted.mediaData.label)));
        });
    } catch {
        return false;
    }
}

function syncDeletedResponseBatchMetadata(deletedMessages: ChatMessage[]): void {
    const deletedByBatch = new Map<string, ChatMessage[]>();
    const deletedByRound = new Map<string, ChatMessage[]>();
    for (const message of deletedMessages) {
        if (message.responseBatchId) {
            const key = `${message.sessionId}\u0000${message.responseBatchId}`;
            const batch = deletedByBatch.get(key) || [];
            batch.push(message);
            deletedByBatch.set(key, batch);
        }
        if (message.responseRoundId) {
            const key = `${message.sessionId}\u0000${message.responseRoundId}`;
            const round = deletedByRound.get(key) || [];
            round.push(message);
            deletedByRound.set(key, round);
        }
    }

    const changed = new Map<string, ChatMessage>();
    for (const [key, deletedBatch] of deletedByBatch) {
        const separatorIndex = key.indexOf("\u0000");
        const sessionId = key.slice(0, separatorIndex);
        const responseBatchId = key.slice(separatorIndex + 1);
        const remainingBatch = _messagesCache.filter(message =>
            message.sessionId === sessionId && message.responseBatchId === responseBatchId
        );
        const rawCarrier = remainingBatch.find(message => message.rawResponseText !== undefined)
            || deletedBatch.find(message => message.rawResponseText !== undefined);
        if (rawCarrier?.rawResponseText === undefined) continue;

        const assistantDeleted = [...deletedBatch].sort(compareChatMessages).filter(deleted =>
            deleted.role === "assistant"
            && deleted.mediaType !== "tool_notice"
            && deleted.mediaType !== "tool_result"
        );
        let nextRaw = rawCarrier.rawResponseText;
        let needsRebuild = remainingBatch.some(message => message.role === "assistant") && assistantDeleted.length > 0;
        for (const deleted of assistantDeleted) {
            const before = nextRaw;
            nextRaw = removeFirstExactResponsePart(nextRaw, deleted.content);
            if (nextRaw === before && rawTextStillContainsDeletedPart(nextRaw, deleted)) {
                needsRebuild = true;
            }
        }
        if (needsRebuild) {
            const rebuilt = rebuildEditableRawFromRemainingBatch(remainingBatch);
            if (rebuilt) nextRaw = rebuilt;
        }
        if (nextRaw === rawCarrier.rawResponseText) continue;

        for (const message of remainingBatch) {
            if (message.rawResponseText === undefined || message.rawResponseText === nextRaw) continue;
            changed.set(message.id, { ...message, rawResponseText: nextRaw });
        }
    }

    for (const [key, deletedRound] of deletedByRound) {
        const separatorIndex = key.indexOf("\u0000");
        const sessionId = key.slice(0, separatorIndex);
        const responseRoundId = key.slice(separatorIndex + 1);
        const remainingRound = _messagesCache.filter(message =>
            message.sessionId === sessionId && message.responseRoundId === responseRoundId
        );
        const editableCarrier = remainingRound.find(message => message.editableResponseText !== undefined)
            || deletedRound.find(message => message.editableResponseText !== undefined);
        if (editableCarrier?.editableResponseText === undefined) continue;

        let nextEditable = editableCarrier.editableResponseText;
        for (const deleted of [...deletedRound].sort(compareChatMessages)) {
            if (
                deleted.role !== "assistant"
                || deleted.mediaType === "tool_notice"
                || deleted.mediaType === "tool_result"
            ) continue;
            nextEditable = removeFirstExactResponsePart(nextEditable, deleted.content);
        }
        if (nextEditable === editableCarrier.editableResponseText) continue;

        for (const message of remainingRound) {
            if (message.editableResponseText === undefined || message.editableResponseText === nextEditable) continue;
            const current = changed.get(message.id) || message;
            changed.set(message.id, { ...current, editableResponseText: nextEditable });
        }
    }

    if (changed.size === 0) return;
    _messagesCache = _messagesCache.map(message => changed.get(message.id) || message);
    dbPutMessages([...changed.values()]);
}

function expandToolExecutionDeleteSet(messages: ChatMessage[]): ChatMessage[] {
    const toolExecutionIds = new Set(
        messages
            .map(message => message.toolExecutionId)
            .filter((id): id is string => !!id),
    );
    if (toolExecutionIds.size === 0) return messages;

    const messageIds = new Set(messages.map(message => message.id));
    const sessionIds = new Set(messages.map(message => message.sessionId));
    const expanded = [...messages];
    for (const message of _messagesCache) {
        if (
            messageIds.has(message.id)
            || !sessionIds.has(message.sessionId)
            || !message.toolExecutionId
            || !toolExecutionIds.has(message.toolExecutionId)
        ) continue;
        messageIds.add(message.id);
        expanded.push(message);
    }
    return expanded;
}

export function deleteChatMessage(messageId: string) {
    const targetMsg = _messagesCache.find(m => m.id === messageId);
    if (!targetMsg) return;
    const sessionId = targetMsg.sessionId;

    const deletedMessages = expandToolExecutionDeleteSet([targetMsg]);
    const deletedIds = new Set(deletedMessages.map(message => message.id));
    _messagesCache = _messagesCache.filter(message => !deletedIds.has(message.id));
    syncDeletedResponseBatchMetadata(deletedMessages);
    dbDeleteMessagesByIds([...deletedIds]);

    // Recalculate the last message for the session to update the preview
    const lastMsg = getLastVisibleSessionMessage(sessionId);

    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === sessionId);
    if (sessIdx !== -1) {
        if (lastMsg) {
            sessions[sessIdx].lastMessageId = lastMsg.id;
            sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
            sessions[sessIdx].updatedAt = lastMsg.createdAt;
        } else {
            sessions[sessIdx].lastMessageId = undefined;
            sessions[sessIdx].lastMessagePreview = "";
        }
        saveChatSessions(sessions);
    }

    dispatchDeletedMessages(deletedMessages);
}

/** Delete a message and all messages after it in the same session. */
export function deleteChatMessagesFrom(messageId: string) {
    const targetMsg = _messagesCache.find(m => m.id === messageId);
    if (!targetMsg) return;
    const sessionId = targetMsg.sessionId;

    const deletedMessages = expandToolExecutionDeleteSet(
        _messagesCache.filter(m => m.sessionId === sessionId && compareChatMessages(m, targetMsg) >= 0),
    );
    const deletedIds = deletedMessages.map(m => m.id);
    const deletedIdSet = new Set(deletedIds);

    _messagesCache = _messagesCache.filter(m => !deletedIdSet.has(m.id));
    syncDeletedResponseBatchMetadata(deletedMessages);
    dbDeleteMessagesByIds(deletedIds);

    const lastMsg = getLastVisibleSessionMessage(sessionId);

    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === sessionId);
    if (sessIdx !== -1) {
        if (lastMsg) {
            sessions[sessIdx].lastMessageId = lastMsg.id;
            sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
            sessions[sessIdx].updatedAt = lastMsg.createdAt;
        } else {
            sessions[sessIdx].lastMessageId = undefined;
            sessions[sessIdx].lastMessagePreview = "";
        }
        saveChatSessions(sessions);
    }

    dispatchDeletedMessages(deletedMessages);
}

export function deleteChatMessagesByIds(sessionId: string, messageIds: string[]): number {
    const targetIds = new Set(messageIds);
    if (targetIds.size === 0) return 0;

    const deletedMessages = expandToolExecutionDeleteSet(
        _messagesCache.filter(m => m.sessionId === sessionId && targetIds.has(m.id)),
    );
    const deletedIds = deletedMessages.map(m => m.id);
    if (deletedIds.length === 0) return 0;

    const deletedIdSet = new Set(deletedIds);
    _messagesCache = _messagesCache.filter(m => m.sessionId !== sessionId || !deletedIdSet.has(m.id));
    syncDeletedResponseBatchMetadata(deletedMessages);
    dbDeleteMessagesByIds(deletedIds);
    reindexSessionMessageOrders(sessionId);

    const lastMsg = getLastVisibleSessionMessage(sessionId);
    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === sessionId);
    if (sessIdx !== -1) {
        if (lastMsg) {
            sessions[sessIdx].lastMessageId = lastMsg.id;
            sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
            sessions[sessIdx].updatedAt = lastMsg.createdAt;
        } else {
            sessions[sessIdx].lastMessageId = undefined;
            sessions[sessIdx].lastMessagePreview = "";
        }
        saveChatSessions(sessions);
    }

    dispatchDeletedMessages(deletedMessages);
    return deletedIds.length;
}

export function editChatMessage(messageId: string, newContent: string) {
    const msgIdx = _messagesCache.findIndex(m => m.id === messageId);
    if (msgIdx !== -1) {
        _messagesCache[msgIdx] = { ..._messagesCache[msgIdx], content: newContent };
        dbPutMessage(_messagesCache[msgIdx]);

        const sessionId = _messagesCache[msgIdx].sessionId;
        const lastMsg = getLastVisibleSessionMessage(sessionId);

        const sessions = loadChatSessions();
        const sessIdx = sessions.findIndex(s => s.id === sessionId);
        if (sessIdx !== -1 && lastMsg && sessions[sessIdx].lastMessageId === lastMsg.id) {
            sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
            saveChatSessions(sessions);
        }
    }
}

export function retractChatMessage(messageId: string) {
    const msgIdx = _messagesCache.findIndex(m => m.id === messageId);
    if (msgIdx !== -1) {
        _messagesCache[msgIdx] = { ..._messagesCache[msgIdx], isRetracted: true };
        dbPutMessage(_messagesCache[msgIdx]);

        const sessionId = _messagesCache[msgIdx].sessionId;
        const lastMsg = getLastVisibleSessionMessage(sessionId);

        const sessions = loadChatSessions();
        const sessIdx = sessions.findIndex(s => s.id === sessionId);
        if (sessIdx !== -1 && lastMsg && sessions[sessIdx].lastMessageId === lastMsg.id) {
            sessions[sessIdx].lastMessagePreview = "撤回了一条消息";
            saveChatSessions(sessions);
        }
    }
}

export function clearChatSessionMessages(sessionId: string) {
    const deletedMessages = _messagesCache.filter(m => m.sessionId === sessionId);
    _messagesCache = _messagesCache.filter(m => m.sessionId !== sessionId);
    dbDeleteMessagesBySession(sessionId);

    // Update session to remove last message preview
    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === sessionId);
    if (sessIdx !== -1) {
        sessions[sessIdx].lastMessageId = undefined;
        sessions[sessIdx].lastMessagePreview = "";
        saveChatSessions(sessions);
    }

    dispatchDeletedMessages(deletedMessages);
}

function dispatchDeletedMessages(messages: ChatMessage[]): void {
    if (typeof window === "undefined" || messages.length === 0) return;
    window.dispatchEvent(new CustomEvent(CHAT_MESSAGES_DELETED_EVENT, { detail: { messages } }));
    for (const message of messages) {
        emitChatPluginEvent("message.deleted", { id: message.id, sessionId: message.sessionId });
    }
}

export type ClearChatSessionToolHistoryResult = {
    deletedMessages: number;
    cleanedMessages: number;
};

function isToolHistoryMessage(msg: ChatMessage): boolean {
    return msg.role === "tool"
        || msg.mediaType === "tool_call"
        || msg.mediaType === "tool_result"
        || msg.mediaType === "tool_notice"
        || !!msg.nativeToolResult;
}

function hasNativeToolReplayMetadata(msg: ChatMessage): boolean {
    return msg.nativeToolCalls !== undefined
        || msg.nativeToolReasoning !== undefined
        || msg.nativeToolOpenRouterReasoningDetails !== undefined;
}

function hasVisibleMessagePayload(msg: ChatMessage): boolean {
    return !!msg.content.trim()
        || !!msg.mediaUrl
        || (!!msg.mediaType && msg.mediaType !== "tool_call" && msg.mediaType !== "tool_result" && msg.mediaType !== "tool_notice")
        || !!msg.statusPanel?.trim()
        || !!msg.innerMonologue?.trim()
        || !!msg.reasoningText?.trim()
        || !!msg.stateValues?.length;
}

export function clearChatSessionToolHistory(sessionId: string): ClearChatSessionToolHistoryResult {
    const sessionMessages = getSortedSessionMessages(sessionId);
    const deletedIds = new Set<string>();
    const cleanedMessages: ChatMessage[] = [];

    for (const msg of sessionMessages) {
        if (isToolHistoryMessage(msg)) {
            deletedIds.add(msg.id);
            continue;
        }

        if (!hasNativeToolReplayMetadata(msg)) continue;

        const cleaned: ChatMessage = { ...msg };
        delete cleaned.nativeToolCalls;
        delete cleaned.nativeToolReasoning;
        delete cleaned.nativeToolOpenRouterReasoningDetails;

        if (msg.role === "assistant" && !hasVisibleMessagePayload(cleaned)) {
            deletedIds.add(msg.id);
            continue;
        }

        cleanedMessages.push(cleaned);
    }

    if (deletedIds.size === 0 && cleanedMessages.length === 0) {
        return { deletedMessages: 0, cleanedMessages: 0 };
    }

    const cleanedById = new Map(cleanedMessages.map(msg => [msg.id, msg]));
    _messagesCache = _messagesCache
        .filter(msg => msg.sessionId !== sessionId || !deletedIds.has(msg.id))
        .map(msg => cleanedById.get(msg.id) || msg);

    if (deletedIds.size > 0) {
        syncDeletedResponseBatchMetadata(sessionMessages.filter(message => deletedIds.has(message.id)));
    }

    if (deletedIds.size > 0) dbDeleteMessagesByIds([...deletedIds]);
    if (cleanedMessages.length > 0) dbPutMessages(cleanedMessages);
    if (deletedIds.size > 0) reindexSessionMessageOrders(sessionId);

    const lastMsg = getLastVisibleSessionMessage(sessionId);
    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === sessionId);
    if (sessIdx !== -1) {
        if (lastMsg) {
            sessions[sessIdx].lastMessageId = lastMsg.id;
            sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
            sessions[sessIdx].updatedAt = lastMsg.createdAt;
        } else {
            sessions[sessIdx].lastMessageId = undefined;
            sessions[sessIdx].lastMessagePreview = "";
        }
        saveChatSessions(sessions);
    }

    return { deletedMessages: deletedIds.size, cleanedMessages: cleanedMessages.length };
}

// ── CRUD for App Settings ─────────────────────
export function loadChatAppSettings(): ChatAppSettings {
    if (typeof window === "undefined") return DEFAULT_CHAT_APP_SETTINGS;
    try {
        const raw = kvGet(SETTINGS_KEY);
        return raw ? { ...DEFAULT_CHAT_APP_SETTINGS, ...JSON.parse(raw) } : DEFAULT_CHAT_APP_SETTINGS;
    } catch {
        return DEFAULT_CHAT_APP_SETTINGS;
    }
}

export function saveChatAppSettings(settings: ChatAppSettings) {
    if (typeof window === "undefined") return;
    kvSet(SETTINGS_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent(CHAT_APP_SETTINGS_UPDATED_EVENT, { detail: settings }));
}

// --- Follow-up schedule persistence (supports multiple sessions) ---

const FOLLOW_UP_SCHEDULES_KEY = "ai_phone_followup_schedules_v1";
registerKvMigration(SETTINGS_KEY);
registerKvMigration(FOLLOW_UP_SCHEDULES_KEY);

export type FollowUpSchedule = {
    sessionId: string;
    fireAt: number;   // timestamp (ms) when next follow-up should fire
    count: number;     // how many follow-ups already sent
    delaySec?: number; // actual computed delay (for {{delay}} prompt template)
};

export function loadAllFollowUpSchedules(): FollowUpSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(FOLLOW_UP_SCHEDULES_KEY);
        return raw ? JSON.parse(raw) as FollowUpSchedule[] : [];
    } catch { return []; }
}

function saveAllFollowUpSchedules(schedules: FollowUpSchedule[]): void {
    if (typeof window === "undefined") return;
    kvSet(FOLLOW_UP_SCHEDULES_KEY, JSON.stringify(schedules));
}

export function saveFollowUpSchedule(schedule: FollowUpSchedule): void {
    const all = loadAllFollowUpSchedules();
    const idx = all.findIndex(s => s.sessionId === schedule.sessionId);
    if (idx >= 0) all[idx] = schedule; else all.push(schedule);
    saveAllFollowUpSchedules(all);
}

export function loadFollowUpSchedule(sessionId: string): FollowUpSchedule | null {
    return loadAllFollowUpSchedules().find(s => s.sessionId === sessionId) || null;
}

export function clearFollowUpSchedule(sessionId: string): void {
    saveAllFollowUpSchedules(loadAllFollowUpSchedules().filter(s => s.sessionId !== sessionId));
}

/** Update the mediaData.status of a message (for red packet / transfer interactions). */
export function updateMessageMediaStatus(messageId: string, newStatus: "pending" | "opened" | "received" | "declined") {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx !== -1) {
        _messagesCache[idx] = { ..._messagesCache[idx], mediaData: { ..._messagesCache[idx].mediaData, status: newStatus } };
        dbPutMessage(_messagesCache[idx]);
    }
}

/** Update the full mediaData of a message (for group red packet claims, etc.). */
export function updateMessageMediaData(messageId: string, data: ChatMessage["mediaData"]) {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx !== -1) {
        _messagesCache[idx] = { ..._messagesCache[idx], mediaData: data };
        dbPutMessage(_messagesCache[idx]);
    }
}

export function updateMessageMediaUrl(messageId: string, mediaUrl: string) {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx !== -1) {
        _messagesCache[idx] = { ..._messagesCache[idx], mediaUrl };
        dbPutMessage(_messagesCache[idx]);
    }
}

export function updateChatMessage(
    messageId: string,
    patch: Partial<Pick<ChatMessage, "content" | "mediaType" | "mediaUrl" | "mediaData">>,
): ChatMessage | null {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx === -1) return null;

    _messagesCache[idx] = { ..._messagesCache[idx], ...patch };
    const updated = _messagesCache[idx];
    dbPutMessage(updated);

    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === updated.sessionId);
    if (sessIdx !== -1 && sessions[sessIdx].lastMessageId === updated.id) {
        sessions[sessIdx].lastMessagePreview = getChatMessagePreview(updated);
        sessions[sessIdx].updatedAt = updated.createdAt;
        saveChatSessions(sessions);
    }

    emitChatPluginEvent("message.updated", { id: messageId, patch });

    return updated;
}

function replacePhotoDirectiveDescription(text: string | undefined, oldDescription: string, nextDescription: string): string | undefined {
    const oldDesc = oldDescription.trim();
    const nextDesc = nextDescription.trim();
    if (!text || !oldDesc || !nextDesc || oldDesc === nextDesc) return text;

    let changed = false;
    const withExplicitMode = text.replace(/\[照片[:：]\s*(使用参考图|不使用参考图)\s*[:：]\s*([^\]]+?)\]/g, (full, mode: string, desc: string) => {
        if (desc.trim() !== oldDesc) return full;
        changed = true;
        return `[照片:${mode}:${nextDesc}]`;
    });
    if (changed) return withExplicitMode;

    return text.replace(/\[照片[:：]\s*([^\]]+?)\]/g, (full, desc: string) => {
        if (desc.trim() !== oldDesc) return full;
        changed = true;
        return `[照片:${nextDesc}]`;
    });
}

export function syncChatGeneratedImagePromptText(
    messageId: string,
    oldDescription: string,
    nextDescription: string,
): ChatMessage[] {
    const target = _messagesCache.find(m => m.id === messageId);
    if (!target) return [];

    const changed = new Map<string, ChatMessage>();
    const targetNextRaw = replacePhotoDirectiveDescription(target.rawResponseText, oldDescription, nextDescription);
    const targetNextEditable = replacePhotoDirectiveDescription(target.editableResponseText, oldDescription, nextDescription);

    if (target.rawResponseText && targetNextRaw && targetNextRaw !== target.rawResponseText && target.responseBatchId) {
        for (const msg of _messagesCache) {
            if (
                msg.sessionId === target.sessionId
                && msg.responseBatchId === target.responseBatchId
                && msg.rawResponseText === target.rawResponseText
            ) {
                changed.set(msg.id, { ...(changed.get(msg.id) || msg), rawResponseText: targetNextRaw });
            }
        }
    }

    if (target.editableResponseText && targetNextEditable && targetNextEditable !== target.editableResponseText && target.responseRoundId) {
        for (const msg of _messagesCache) {
            if (
                msg.sessionId === target.sessionId
                && msg.responseRoundId === target.responseRoundId
                && msg.editableResponseText === target.editableResponseText
            ) {
                changed.set(msg.id, { ...(changed.get(msg.id) || msg), editableResponseText: targetNextEditable });
            }
        }
    }

    if (changed.size === 0) return [];
    _messagesCache = _messagesCache.map(msg => changed.get(msg.id) || msg);
    const updatedMessages = [...changed.values()];
    dbPutMessages(updatedMessages);
    return updatedMessages;
}

/**
 * Replace a single message with multiple parsed parts (for rich media reprocessing).
 * Preserves the original timestamp and metadata; returns the new messages.
 */
export function replaceMessageWithParts(
    originalId: string,
    parts: { content: string; mediaType?: ChatMessage["mediaType"]; mediaData?: ChatMessage["mediaData"] }[],
): ChatMessage[] {
    const idx = _messagesCache.findIndex(m => m.id === originalId);
    if (idx === -1 || parts.length === 0) return [];

    const original = _messagesCache[idx];
    const baseOrder = getStableMessageOrder(original) ?? getNextMessageOrder(original.sessionId);

    // Remove original
    _messagesCache.splice(idx, 1);
    dbDeleteMessage(originalId);

    // Insert parsed parts at the same position, preserving timestamp
    const newMsgs: ChatMessage[] = [];
    for (let i = 0; i < parts.length; i++) {
        const newMsg: ChatMessage = {
            id: `${originalId}_p${i}`,
            sessionId: original.sessionId,
            role: original.role,
            content: parts[i].content,
            mediaType: parts[i].mediaType,
            origin: original.origin,
            mediaData: parts[i].mediaData,
            status: original.status,
            createdAt: original.createdAt,
            order: baseOrder + i * 0.001,
            responseBatchId: original.responseBatchId,
            rawResponseText: original.rawResponseText,
            responseRoundId: original.responseRoundId,
            editableResponseText: original.editableResponseText,
            statusPanel: i === 0 ? original.statusPanel : undefined,
            innerMonologue: i === 0 ? original.innerMonologue : undefined,
            reasoningText: i === 0 ? original.reasoningText : undefined,
            stateValues: i === 0 ? original.stateValues : undefined,
            freshStateValues: i === 0 ? original.freshStateValues : undefined,
            followUpIndex: original.followUpIndex,
            senderCharacterId: original.senderCharacterId,
            senderName: original.senderName,
        };
        _messagesCache.splice(idx + i, 0, newMsg);
        dbPutMessage(newMsg);
        newMsgs.push(newMsg);
    }

    reindexSessionMessageOrders(original.sessionId);
    const newIds = new Set(newMsgs.map(msg => msg.id));
    return getSortedSessionMessages(original.sessionId).filter(msg => newIds.has(msg.id));
}

export function replaceResponseBatchWithParts(
    sessionId: string,
    responseBatchId: string,
    rawResponseText: string,
    parts: { content: string; mediaType?: ChatMessage["mediaType"]; mediaData?: ChatMessage["mediaData"] }[],
    options?: {
        statusPanel?: string;
        innerMonologue?: string;
        reasoningText?: string;
        stateValues?: StateValue[];
        freshStateValues?: StateValue[];
        /** 面板挂在第几条（缺省第 0 条；调用方跳过拍一拍/通话留痕这类不显示面板的消息） */
        metaPartIndex?: number;
        toolCallContent?: string;
    },
): ChatMessage[] {
    if (parts.length === 0) return [];

    const batchMessages = _loadAllMessages()
        .filter(m => m.sessionId === sessionId && m.responseBatchId === responseBatchId)
        .sort(compareChatMessages);
    if (batchMessages.length === 0) return [];

    const firstMessage = batchMessages[0];
    const baseOrder = getStableMessageOrder(firstMessage) ?? getNextMessageOrder(sessionId);
    const insertIdx = _messagesCache.findIndex(m => m.id === firstMessage.id);
    if (insertIdx === -1) return [];

    const deletedIds = batchMessages.map(m => m.id);
    _messagesCache = _messagesCache.filter(m => !deletedIds.includes(m.id));
    dbDeleteMessagesByIds(deletedIds);

    const baseTime = new Date(firstMessage.createdAt).getTime();
    const visibleMessages: ChatMessage[] = parts.map((part, index) => ({
        id: createMessageId(),
        sessionId,
        role: firstMessage.role,
        content: part.content,
        mediaType: part.mediaType,
        origin: firstMessage.origin,
        mediaData: part.mediaData,
        status: firstMessage.status,
        createdAt: new Date(baseTime + index).toISOString(),
        order: baseOrder + index * 0.001,
        responseBatchId,
        rawResponseText,
        responseRoundId: firstMessage.responseRoundId,
        editableResponseText: firstMessage.editableResponseText,
        statusPanel: index === (options?.metaPartIndex ?? 0) ? options?.statusPanel : undefined,
        innerMonologue: index === (options?.metaPartIndex ?? 0) ? options?.innerMonologue : undefined,
        reasoningText: index === (options?.metaPartIndex ?? 0) ? options?.reasoningText : undefined,
        stateValues: index === (options?.metaPartIndex ?? 0) ? options?.stateValues : undefined,
        freshStateValues: index === (options?.metaPartIndex ?? 0) ? options?.freshStateValues : undefined,
        followUpIndex: firstMessage.followUpIndex,
        senderCharacterId: firstMessage.senderCharacterId,
        senderName: firstMessage.senderName,
    }));
    const toolCallContent = options?.toolCallContent?.trim();
    const toolCallMessage: ChatMessage | undefined = toolCallContent
        ? {
            id: createMessageId(),
            sessionId,
            role: "assistant",
            content: toolCallContent,
            mediaType: "tool_call",
            status: firstMessage.status,
            createdAt: new Date(baseTime + parts.length).toISOString(),
            order: baseOrder + parts.length * 0.001,
            responseBatchId,
            responseRoundId: firstMessage.responseRoundId,
            editableResponseText: firstMessage.editableResponseText,
            followUpIndex: firstMessage.followUpIndex,
            senderCharacterId: firstMessage.senderCharacterId,
            senderName: firstMessage.senderName,
        }
        : undefined;
    const newMessages = toolCallMessage ? [...visibleMessages, toolCallMessage] : visibleMessages;

    _messagesCache.splice(insertIdx, 0, ...newMessages);
    dbPutMessages(newMessages);
    reindexSessionMessageOrders(sessionId);

    const lastMsg = getLastVisibleSessionMessage(sessionId);
    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === sessionId);
    if (sessIdx !== -1) {
        if (lastMsg) {
            sessions[sessIdx].lastMessageId = lastMsg.id;
            sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
            sessions[sessIdx].updatedAt = lastMsg.createdAt;
        } else {
            sessions[sessIdx].lastMessageId = undefined;
            sessions[sessIdx].lastMessagePreview = "";
        }
        saveChatSessions(sessions);
    }

    return newMessages;
}

export function replaceGroupResponseRound(
    sessionId: string,
    responseRoundId: string,
    editableResponseText: string,
    messages: Array<{
        content: string;
        mediaType?: ChatMessage["mediaType"];
        mediaData?: ChatMessage["mediaData"];
        rawResponseText?: string;
        responseBatchId?: string;
        statusPanel?: string;
        innerMonologue?: string;
        reasoningText?: string;
        stateValues?: StateValue[];
        freshStateValues?: StateValue[];
        senderCharacterId?: string;
        senderName?: string;
    }>,
): ChatMessage[] {
    if (messages.length === 0) return [];

    const roundMessages = _loadAllMessages()
        .filter(m => m.sessionId === sessionId && m.responseRoundId === responseRoundId)
        .sort(compareChatMessages);
    if (roundMessages.length === 0) return [];

    const firstMessage = roundMessages[0];
    const baseOrder = getStableMessageOrder(firstMessage) ?? getNextMessageOrder(sessionId);
    const insertIdx = _messagesCache.findIndex(m => m.id === firstMessage.id);
    if (insertIdx === -1) return [];

    const deletedIds = roundMessages.map(m => m.id);
    _messagesCache = _messagesCache.filter(m => !deletedIds.includes(m.id));
    dbDeleteMessagesByIds(deletedIds);

    const baseTime = new Date(firstMessage.createdAt).getTime();
    const newMessages: ChatMessage[] = messages.map((msg, index) => ({
        id: createMessageId(),
        sessionId,
        role: firstMessage.role,
        content: msg.content,
        mediaType: msg.mediaType,
        origin: firstMessage.origin,
        mediaData: msg.mediaData,
        status: firstMessage.status,
        createdAt: new Date(baseTime + index).toISOString(),
        order: baseOrder + index * 0.001,
        responseBatchId: msg.responseBatchId,
        rawResponseText: msg.rawResponseText,
        responseRoundId,
        editableResponseText,
        statusPanel: msg.statusPanel,
        innerMonologue: msg.innerMonologue,
        reasoningText: msg.reasoningText,
        stateValues: msg.stateValues,
        freshStateValues: msg.freshStateValues,
        followUpIndex: firstMessage.followUpIndex,
        senderCharacterId: msg.senderCharacterId,
        senderName: msg.senderName,
    }));

    _messagesCache.splice(insertIdx, 0, ...newMessages);
    dbPutMessages(newMessages);
    reindexSessionMessageOrders(sessionId);

    const lastMsg = getLastVisibleSessionMessage(sessionId);
    const sessions = loadChatSessions();
    const sessIdx = sessions.findIndex(s => s.id === sessionId);
    if (sessIdx !== -1) {
        if (lastMsg) {
            sessions[sessIdx].lastMessageId = lastMsg.id;
            sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
            sessions[sessIdx].updatedAt = lastMsg.createdAt;
        } else {
            sessions[sessIdx].lastMessageId = undefined;
            sessions[sessIdx].lastMessagePreview = "";
        }
        saveChatSessions(sessions);
    }

    return newMessages;
}

/** Scan messages in reverse to find the most recent stateValues. */
export function getLatestStateValues(sessionId: string): StateValue[] {
    const msgs = loadChatMessages(sessionId);
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].stateValues && msgs[i].stateValues!.length > 0) {
            return msgs[i].stateValues!;
        }
    }
    return [];
}

function getStateOwnerCharacterId(
    msg: Pick<ChatMessage, "sessionId" | "senderCharacterId" | "stateValues">,
    sessionsById: Map<string, ChatSession>,
): string | null {
    if (!msg.stateValues || msg.stateValues.length === 0) return null;
    if (msg.senderCharacterId) return msg.senderCharacterId;

    const session = sessionsById.get(msg.sessionId);
    if (!session || session.isGroup) return null;
    return session.contactId || null;
}

function isBeforeStateCutoff(
    msg: Pick<ChatMessage, "createdAt" | "id">,
    before?: Pick<ChatMessage, "createdAt" | "id">,
): boolean {
    if (!before) return true;
    const msgTime = getMessageTimeValue(msg);
    const beforeTime = getMessageTimeValue(before);
    if (msgTime !== beforeTime) return msgTime < beforeTime;
    return msg.id < before.id;
}

/** Scan all direct and group chat messages for a character's latest stateValues. */
export function getLatestCharacterStateValues(
    characterId: string,
    options?: { before?: Pick<ChatMessage, "createdAt" | "id"> },
): StateValue[] {
    if (!characterId) return [];
    const sessionsById = new Map(loadChatSessions().map(session => [session.id, session]));
    const candidates = _loadAllMessages()
        .filter(msg => {
            if (!isBeforeStateCutoff(msg, options?.before)) return false;
            return getStateOwnerCharacterId(msg, sessionsById) === characterId;
        })
        .sort((a, b) => {
            const timeDiff = getMessageTimeValue(b) - getMessageTimeValue(a);
            if (timeDiff !== 0) return timeDiff;
            return b.id.localeCompare(a.id);
        });

    return candidates[0]?.stateValues || [];
}
