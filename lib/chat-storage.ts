// lib/chat-storage.ts

import {
    chatDb,
    initChatDb,
    dbPutMessage, dbDeleteMessage, dbDeleteMessagesBySession, dbDeleteMessagesByIds,
    dbPutMessages, dbPutSessions, dbPutContacts, dbDeleteSession,
    dbReplaceContacts, dbReplaceSessions,
} from "./chat-db";
import { resolveUserIdentity } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";
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
    /** 流式生成（线上）：开启后该会话的线上 AI 回复边生成边显示（默认关，保持原整段请求行为） */
    streamOnline?: boolean;
    /** 流式生成（线下）：开启后该会话的线下 AI 回复边生成边显示（默认关，保持原整段请求行为） */
    streamOffline?: boolean;
    /**
     * 线下摘要自动补提：模型没写 <summary> 时再发一次小请求让它补。默认开；
     * 关掉就只调一次 API，那一轮没摘要（不进短期记忆的事件流）。按次计费的接口想省一半调用时关它。
     */
    offlineSummaryRetry?: boolean;
    /** 角色自主线下邀约：开启后角色可根据情境主动提议线下见面，并在从线下回线上时主动回复（仅私聊生效，默认关） */
    enableOfflineInvite?: boolean;
    /** 角色自主线下邀约提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineInvitePrompt?: string;
    /** 角色线下共处微信回复提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineMeetingPrompt?: string;
    /** 用户点击卡片【拒绝Ta】按钮角色反应提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineDeclinePrompt?: string;
    /** 用户微信文字口头推脱与婉拒角色态度提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineOralDeclinePrompt?: string;
    /** 结束线下回到线上发信提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineReturnOnlinePrompt?: string;
    /** 线下相遇第一句开场白提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineMeetingInitiativePrompt?: string;
    /** 拒绝邀约记忆总结提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineInviteMemoryPrompt?: string;
    /** 进入线下角色主动开场：开启后进入面对面角色主动说第一句话，关闭则等待用户主动发送第一句（仅私聊生效，默认开） */
    offlineInviteAutoFirstSpeech?: boolean;
    /** 角色自主线下封禁：开启后角色在吵架或拒绝见面时可封锁线下入口（仅私聊生效，默认关） */
    enableOfflineLock?: boolean;
    /** 角色自主线下封禁核心提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineLockPrompt?: string;
    /** 角色线下解封联动邀约提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineLockInvitePrompt?: string;
    /** 叩门破防角色打破沉默提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineKnockPrompt?: string;
    /** 角色线下解封前往碰面开场提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineLockMeetingPrompt?: string;
    /** 叩门申请记忆总结提示词（自定义时生效，未自定义则使用默认黄金提示词） */
    offlineLockMemoryPrompt?: string;
    /** 解除封禁前往线下角色主动开场：开启后解封前往面对面角色主动说第一句话，关闭则等待用户主动发送第一句（仅私聊生效，默认开） */
    offlineLockAutoFirstSpeech?: boolean;
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
        | "offline_invite"
        | "offline_invite_remind"
        | "offline_invite_change_place"
        | "offline_invite_early_arrive"
        | "offline_invite_arrive_notice"
        | "offline_invite_system_notice"
        | "offline_invite_cancel"
        | "offline_lock"
        | "offline_unlock"
        | "offline_lock_system_notice"
        | "offline_unlock_system_notice"
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
        offlineInvite?: {
            direction?: "he_comes" | "i_go";
            place?: string;
            timeStr?: string;
            reason?: string;
            onTheWayMessage?: string;
            transitCardMessage?: string;
            arrivedMessage?: string;
            arrivalCardMessage?: string;
            status?: "pending" | "accepted" | "declined" | "on_the_way" | "arrived";
            sourceBatchId?: string;
            initialBatchId?: string;
            initialPlace?: string;
            theme?: "default" | "alert" | "forced";
            isEarlyArrived?: boolean;
            frozenRemainingMinutes?: number;
            durationMinutes?: number;
            startTime?: number;
            relatedBatchIds?: string[];
        };
        offlineLock?: {
            requiredKnocks: number;
            lockMessage: string;
        };
        /** 在途阶段每轮 AI 回复定格的实时剩余倒计时（用于回溯时毫秒级精准断点续存） */
        inTransitRemainingSeconds?: number;
        inTransitRemainingMinutes?: number;
    };
    isTyping?: boolean; // temporary flag for UI rendering
    statusPanel?: string; // AI display-only status content from [状态栏] tags
    statusRegionMode?: "custom"; // 该消息生成时会话处于自定义状态栏模式（缺省=原生渲染）
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
        /** 云端主动回复对应的本地触发消息，用于跨时钟因果排序。 */
        replyAfterLocalMessageId?: string;
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
    callVibrationEnabled?: boolean; // 语音/视频来电等待接听时循环振动（默认开；iOS 网页不支持振动则无效果）
    maxToolRounds?: number; // 单条消息的工具循环轮数上限（默认 5；每轮=一次模型请求，轮内调用条数不限）
    floatingDockEnabled?: boolean; // 悬浮球贴边半隐藏收拢模式（默认关）
};

/** 单条消息工具循环轮数上限（默认 5，夹在 1–20 之间） */
export function getMaxToolRounds(): number {
    const raw = loadChatAppSettings().maxToolRounds;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 5;
    return Math.max(1, Math.min(20, Math.round(raw)));
}

/** 会话是否开启线上流式生成（默认关；按会话独立控制，单聊/群聊都生效） */
export function isSessionStreamingEnabled(session: Pick<ChatSession, "streamOnline" | "streamOffline"> | null | undefined, online: boolean): boolean {
    if (!session) return false;
    return online ? session.streamOnline === true : session.streamOffline === true;
}

/** 会话是否开启角色自主线下邀约（默认常驻开启；群聊不生效；仅显式设为 false 时关闭） */
export function isSessionOfflineInviteEnabled(session: Pick<ChatSession, "enableOfflineInvite" | "isGroup"> | null | undefined): boolean {
    if (!session || session.isGroup) return false;
    return session.enableOfflineInvite !== false;
}

/** 会话是否开启角色自主线下封禁（默认常驻开启；群聊不生效；仅显式设为 false 时关闭） */
export function isSessionOfflineLockEnabled(session: Pick<ChatSession, "enableOfflineLock" | "isGroup"> | null | undefined): boolean {
    if (!session || session.isGroup) return false;
    return session.enableOfflineLock !== false;
}

export const CHAT_APP_SETTINGS_UPDATED_EVENT = "chat-app-settings-updated";
export const CHAT_MESSAGE_PUSHED_EVENT = "chat-message-pushed";
export const CHAT_MESSAGES_DELETED_EVENT = "chat-messages-deleted";
export const CHAT_REQUEST_REPLY_EVENT = "chat-request-reply";
/** 长按编辑整批回复后重建消息：携带新消息与编辑后的原文，供云同步回写。 */
export const CHAT_RESPONSE_BATCH_REPLACED_EVENT = "chat-response-batch-replaced";

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
    floatingDockEnabled: false,
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
        let item = id === session.id && contactId === session.contactId
            ? session
            : { ...session, id, contactId };
        if (!item.isGroup) {
            let enriched = false;
            let nextInvite = item.enableOfflineInvite;
            let nextLock = item.enableOfflineLock;
            if (nextInvite === undefined) {
                nextInvite = true;
                enriched = true;
            }
            if (nextLock === undefined) {
                nextLock = true;
                enriched = true;
            }
            if (enriched) {
                item = { ...item, enableOfflineInvite: nextInvite, enableOfflineLock: nextLock };
                changed = true;
            }
        }
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

// ── 用户主动删除的好友（墓碑）────────────────────────
// 删好友是「删联系人、留会话」——会话留着，重新加回来才能接上历史记录。
// 但下面的 restoreContactsForPrivateSessions 是条数据抢救逻辑：它看到
// 「有会话却没联系人」就认定联系人表丢了，照着会话把联系人重建回来，
// 于是刚删掉的好友立刻复活。这里把用户的主动删除记一笔，让抢救逻辑跳过
// 它们；重新加好友时 addChatContact 会自动销掉墓碑。
const REMOVED_CONTACTS_KEY = "ai_phone_removed_contacts_v1";
registerKvMigration(REMOVED_CONTACTS_KEY);

function loadRemovedContactIds(): Set<string> {
    if (typeof window === "undefined") return new Set<string>();
    try {
        const raw = kvGet(REMOVED_CONTACTS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        const ids: string[] = Array.isArray(parsed) ? parsed.filter((id: unknown): id is string => typeof id === "string" && !!id) : [];
        return new Set<string>(ids);
    } catch {
        return new Set<string>();
    }
}

function saveRemovedContactIds(ids: Set<string>): void {
    if (typeof window === "undefined") return;
    kvSet(REMOVED_CONTACTS_KEY, JSON.stringify([...ids]));
}

function markContactRemoved(characterId: string): void {
    if (!characterId) return;
    const ids = loadRemovedContactIds();
    if (ids.has(characterId)) return;
    ids.add(characterId);
    saveRemovedContactIds(ids);
}

function unmarkContactRemoved(characterId: string): void {
    if (!characterId) return;
    const ids = loadRemovedContactIds();
    if (!ids.delete(characterId)) return;
    saveRemovedContactIds(ids);
}

function restoreContactsForPrivateSessions(contacts: ChatContact[], sessions: ChatSession[]): NormalizedList<ChatContact> {
    const characterIds = new Set(loadCharacters().map(character => character.id));
    const removedByUser = loadRemovedContactIds();
    const privateSessionsWithMessages = sessions.filter(session =>
        !session.isGroup
        && session.contactId
        && characterIds.has(session.contactId)
        && !removedByUser.has(session.contactId)
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
    // 任何一条"重新加上好友"的路径都会走到这里（通过好友申请、搜索添加、
    // 后台引擎重新建联系），统一在这里解除删除状态，不会漏。
    unmarkContactRemoved(characterId);
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
    markContactRemoved(characterId);
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
        enableOfflineInvite: true,
        enableOfflineLock: true,
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

// 把一个会话的全部消息挪到另一个会话名下（重复会话合并用）。
// 两边的 order 序号各自从 0 起，直接混排会串位，挪完后按时间重排目标会话。
export function reassignChatSessionMessages(fromSessionId: string, toSessionId: string): number {
    if (fromSessionId === toSessionId) return 0;
    const changed: ChatMessage[] = [];
    _messagesCache = _messagesCache.map(message => {
        if (message.sessionId !== fromSessionId) return message;
        const updated = { ...message, sessionId: toSessionId };
        changed.push(updated);
        return updated;
    });
    if (changed.length === 0) return 0;
    dbPutMessages(changed);
    reindexSessionMessageOrdersByTime(toSessionId);
    return changed.length;
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

export function pushChatMessage(msg: Omit<ChatMessage, "id" | "createdAt" | "status"> & {
    status?: ChatMessageStatus;
    createdAt?: string;
}): ChatMessage {
    let newMsg: ChatMessage = {
        ...msg,
        id: createMessageId(),
        createdAt: msg.createdAt || new Date().toISOString(),
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
    // 优化：直接增量更新内存会话缓存并异步写单条，避免每次发送都走 loadChatSessions +
    // saveChatSessions 触发全量会话预览重算（会话/消息多了以后会明显卡顿）。
    const preview = getChatMessagePreview(newMsg);
    const sessIdx = _sessionsCache.findIndex(s => s.id === msg.sessionId);
    if (sessIdx !== -1 && isSessionPreviewCandidate(newMsg)) {
        const target = _sessionsCache[sessIdx];
        target.lastMessageId = newMsg.id;
        if (preview) target.lastMessagePreview = preview;
        target.updatedAt = newMsg.createdAt;
        dbPutSessions([target]);
    } else if (sessIdx === -1) {
        // 缓存未命中（极端情况）：回退全量路径，保证列表预览仍会刷新
        const sessions = loadChatSessions();
        const idx2 = sessions.findIndex(s => s.id === msg.sessionId);
        if (idx2 !== -1 && isSessionPreviewCandidate(newMsg)) {
            sessions[idx2].lastMessageId = newMsg.id;
            if (preview) sessions[idx2].lastMessagePreview = preview;
            sessions[idx2].updatedAt = newMsg.createdAt;
            saveChatSessions(sessions);
        }
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

export function replaceChatSessionMessages(sessionId: string, messages: ChatMessage[]): void {
    clearChatSessionMessages(sessionId);
    for (const msg of messages) {
        const item = { ...msg, sessionId };
        _messagesCache.push(item);
        dbPutMessage(item);
    }
    if (messages.length > 0) {
        const sorted = getSortedSessionMessages(sessionId);
        const lastMsg = sorted[sorted.length - 1];
        if (lastMsg) {
            const sessions = loadChatSessions();
            const sessIdx = sessions.findIndex(s => s.id === sessionId);
            if (sessIdx !== -1) {
                sessions[sessIdx].lastMessageId = lastMsg.id;
                sessions[sessIdx].lastMessagePreview = getChatMessagePreview(lastMsg);
                saveChatSessions(sessions);
            }
        }
    }
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

/**
 * 语音合成结果落库：优先走内存缓存（当前会话可见时同步生效）；缓存里没有
 * （合成期间用户已切走会话）就直接读库改库——合成一次的音频绝不能丢，
 * 丢了就是下一次白花钱的重新合成。
 */
export async function persistMessageVoiceAudio(
    messageId: string,
    mediaUrl: string,
    synthesizedFromText: string,
): Promise<void> {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx !== -1) {
        const next = {
            ..._messagesCache[idx],
            mediaUrl,
            mediaData: { ..._messagesCache[idx].mediaData, synthesizedFromText },
        };
        _messagesCache[idx] = next;
        dbPutMessage(next);
        return;
    }
    try {
        const stored = await chatDb.messages.get(messageId);
        if (stored) {
            await chatDb.messages.put({
                ...stored,
                mediaUrl,
                mediaData: { ...stored.mediaData, synthesizedFromText },
            });
        }
    } catch (err) {
        console.warn("[ChatDB] persist voice audio failed:", err);
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

function replacePhotoDirectiveDescription(
    text: string | undefined,
    oldDescription: string,
    nextDescription: string,
    nextUseReferenceImage?: boolean,
): string | undefined {
    const oldDesc = oldDescription.trim();
    const nextDesc = nextDescription.trim();
    // 原描述必须匹配到具体那一条照片标签才改：一条回复里可能有多张照片，
    // 放宽成"原描述为空也改"会把其它照片的描述一并覆盖。
    if (!text || !oldDesc || !nextDesc) return text;

    let changed = false;
    const withExplicitMode = text.replace(/\[照片[:：]\s*(使用参考图|不使用参考图)\s*[:：]\s*([^\]]+?)\]/g, (full, mode: string, desc: string) => {
        if (desc.trim() !== oldDesc) return full;
        const targetMode = nextUseReferenceImage !== undefined
            ? (nextUseReferenceImage ? "使用参考图" : "不使用参考图")
            : mode;
        if (targetMode === mode && desc.trim() === nextDesc) return full;
        changed = true;
        return `[照片:${targetMode}:${nextDesc}]`;
    });
    if (changed) return withExplicitMode;

    return text.replace(/\[照片[:：]\s*([^\]]+?)\]/g, (full, desc: string) => {
        if (desc.trim() !== oldDesc) return full;
        const targetMode = nextUseReferenceImage !== undefined
            ? (nextUseReferenceImage ? "使用参考图" : "不使用参考图")
            : undefined;
        const replacement = targetMode ? `[照片:${targetMode}:${nextDesc}]` : `[照片:${nextDesc}]`;
        if (replacement === full) return full;
        changed = true;
        return replacement;
    });
}

export function syncChatGeneratedImagePromptText(
    messageId: string,
    oldDescription: string,
    nextDescription: string,
    nextUseReferenceImage?: boolean,
): ChatMessage[] {
    const target = _messagesCache.find(m => m.id === messageId);
    if (!target) return [];

    const changed = new Map<string, ChatMessage>();
    const targetNextRaw = replacePhotoDirectiveDescription(target.rawResponseText, oldDescription, nextDescription, nextUseReferenceImage);
    const targetNextEditable = replacePhotoDirectiveDescription(target.editableResponseText, oldDescription, nextDescription, nextUseReferenceImage);

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
        statusRegionMode?: "custom";
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
        // 云消息身份必须跟着走：丢了它，微信云同步下一轮会把原文当成「还没导入过」
        // 再导一遍，编辑后的版本和原文并存（编辑一次多一条）。
        cloudSync: firstMessage.cloudSync,
        statusPanel: index === (options?.metaPartIndex ?? 0) ? options?.statusPanel : undefined,
        statusRegionMode: index === (options?.metaPartIndex ?? 0) && options?.statusPanel ? options?.statusRegionMode : undefined,
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
            cloudSync: firstMessage.cloudSync,
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

    dispatchResponseBatchReplaced(sessionId, newMessages, rawResponseText);
    return newMessages;
}

/**
 * 整批回复被编辑重建：这里不能走 CHAT_MESSAGE_PUSHED / CHAT_MESSAGES_DELETED
 * （前者会被当成新消息新建云端对象，后者会把云端原件删掉），所以单独发一个事件，
 * 由云同步侧「就地覆盖同一条云消息」。
 */
function dispatchResponseBatchReplaced(sessionId: string, messages: ChatMessage[], rawResponseText: string): void {
    if (typeof window === "undefined" || messages.length === 0) return;
    window.dispatchEvent(new CustomEvent(CHAT_RESPONSE_BATCH_REPLACED_EVENT, {
        detail: { sessionId, messages, rawResponseText },
    }));
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
        statusRegionMode?: "custom";
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
        cloudSync: firstMessage.cloudSync,
        statusPanel: msg.statusPanel,
        statusRegionMode: msg.statusRegionMode,
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
            return (msgs[i].stateValues || []).filter(sv => sv.name !== "封禁线下");
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

    const raw = candidates[0]?.stateValues || [];
    return raw.filter(sv => sv.name !== "封禁线下");
}

export type OfflineLockData = {
    isLocked: boolean;
    knockCount: number;
    requiredKnocks: number;
    stageKnocks?: number;
    lockMessage: string;
    sourceBatchId?: string;
    relatedBatchIds?: string[];
};

export const OFFLINE_LOCK_PREFIX = "chat_offline_lock_";
export const OFFLINE_LOCK_PENDING_VISIT_PREFIX = "chat_offline_lock_pending_visit_";

/**
 * 角色封禁线下状态更新（支持初次封禁、心墙松动/加固动态演变）
 * 核心逻辑：
 * 1. 当前挑战敲门进度干脆归零（knockCount: 0），重新点亮圆点
 * 2. 大事件全局累计敲门总数坚决保留（stageKnocks）
 * 3. 动态演变小灰字：
 *    - 初次封锁：${charName} 暂时关闭了线下入口
 *    - 松动降低：${charName}的心墙似乎有所松动……
 *    - 加固增高：${charName}的心墙似乎更坚固了……
 *    - 数值未变：日常闲聊不发多余小灰字；若为敲门达到阈值触发的主动发信，提示心墙似乎毫无动摇……
 */
export function applyOfflineLockDirective(
    sessionId: string,
    charName: string,
    offlineLock: { requiredKnocks: number; lockMessage?: string },
    responseBatchId: string,
    options?: { isKnockThresholdTriggered?: boolean },
): { newLock: OfflineLockData; noticeText: string | null } {
    const normalizedRequired = Math.max(1, Math.min(7, offlineLock.requiredKnocks || 3));
    let prevIsLocked = false;
    let prevRequiredKnocks = 0;
    let prevKnockCount = 0;
    let prevStageKnocks = 0;
    let prevSourceBatchId = responseBatchId;
    let prevRelatedBatchIds: string[] = [];

    try {
        const existingRaw = kvGet(OFFLINE_LOCK_PREFIX + sessionId);
        if (existingRaw) {
            const parsed = JSON.parse(existingRaw) as OfflineLockData;
            prevIsLocked = Boolean(parsed.isLocked);
            prevRequiredKnocks = parsed.requiredKnocks || 0;
            prevKnockCount = parsed.knockCount || 0;
            prevStageKnocks = parsed.stageKnocks || 0;
            prevSourceBatchId = parsed.sourceBatchId || responseBatchId;
            prevRelatedBatchIds = parsed.relatedBatchIds || [];
        }
    } catch {}

    // 心墙计数重置逻辑：
    // 仅在心墙数值改变（增加或降低）或初次封锁入口时重置 knockCount；
    // 若本轮回复中心墙数值未变（保持原样），则保留当前累计敲门次数。
    const isMindWallChanged = prevIsLocked && normalizedRequired !== prevRequiredKnocks;
    const isFirstLock = !prevIsLocked;
    const shouldResetKnockCount = isFirstLock || isMindWallChanged;

    const newLock: OfflineLockData = {
        isLocked: true,
        knockCount: shouldResetKnockCount ? 0 : prevKnockCount,
        requiredKnocks: normalizedRequired,
        stageKnocks: prevStageKnocks,
        lockMessage: offlineLock.lockMessage || "",
        sourceBatchId: prevSourceBatchId,
        relatedBatchIds: Array.from(new Set([...prevRelatedBatchIds, responseBatchId])),
    };

    kvSet(OFFLINE_LOCK_PREFIX + sessionId, JSON.stringify(newLock));

    let noticeText: string | null = null;
    if (!prevIsLocked) {
        noticeText = `${charName} 暂时关闭了线下入口`;
    } else if (normalizedRequired < prevRequiredKnocks) {
        noticeText = `${charName}的心墙似乎有所松动……`;
    } else if (normalizedRequired > prevRequiredKnocks) {
        noticeText = `${charName}的心墙似乎更坚固了……`;
    } else if (options?.isKnockThresholdTriggered) {
        noticeText = `${charName}的心墙似乎毫无动摇……`;
    }

    return { newLock, noticeText };
}

/**
 * 角色解除线下封禁状态清除
 */
export function applyOfflineUnlockDirective(
    sessionId: string,
    charName: string,
): { noticeText: string } {
    kvRemove(OFFLINE_LOCK_PREFIX + sessionId);
    kvSet(OFFLINE_LOCK_PENDING_VISIT_PREFIX + sessionId, "1");
    return { noticeText: `${charName} 已解除线下封禁` };
}

export type OfflineInviteDeclineContext = {
    theme?: "default" | "alert" | "forced";
    place?: string;
    reason?: string;
    direction?: "he_comes" | "i_go";
    declineCount?: number;
};

export const OFFLINE_INVITE_DECLINE_COUNT_PREFIX = "chat_offline_invite_decline_count_";

/**
 * 角色主动线下邀约默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_INVITE_PROMPT = [
    "### 线下邀约动作指令（极度克制的高权重剧情动作）：",
    "【核心铁律·最高红线】",
    "1. 【核心本质·即时奔赴 vs 预约未来绝对绝对隔离（铁律）】：",
    "   - 线下赴约系统是【当下立即动身出发（Real-time Instant Action）】的沉浸式功能！一旦触发系统将根据路程距离开启即时赶路倒计时，并在倒计时结束时切入面对面线下碰面！",
    "   - 【绝对严禁在预约未来时间时触发线下邀约指令（违者严重违背生活常理）】：",
    "     凡是双方约定在【未来某个时间/将来的日期】（例如：“明天见”、“明天下午三点”、“后天”、“大后天”、“这周末”、“下周”、“改天”、“几个小时之后过去”、“今天白天/下午/晚上”（而当前实际并非该时间段，如半夜零点聊白天）），【一律 100% 绝对严禁输出任何[线下邀约]指令】！",
    "     在预约未来的情景下，你必须如同真实人类一样，老老实实做纯文本口头约定（例如：“那行，明天下午三点我准时去接你”），绝不可做“半夜刺客”，更绝对严禁在半夜开启莫名其妙的即时赶路倒计时！",
    "   - 【唯一允许触发[线下邀约]的前提】：只有双方商定的是【当下、现在、立刻动身、待会儿直接过来】的即时奔赴情境，才允许发起！",
    "2. 【拒绝敏感肌·日常闲聊严禁应激触发】：",
    "   - 获悉地点只是线下见面的【必要条件】，绝非【充分条件】！绝不可每一次聊到地点都触发邀约！",
    "   - 用户在日常微信闲聊中随口提及地点、分享生活见闻（例如：“听说楼下新开了一家拼豆店”、“今天路过那家猫咖”、“在工位摸鱼看风景”），这 99% 都是情侣/朋友间的【纯粹日常分享闲聊】！",
    "   - 【绝对严禁做敏感肌】：一听到对方说起地点就神经质应激、借题发挥强行发起线下邀约！你必须顺着话题自然聊兴趣、聊店面或闲聊日常。",
    "   - 【允许触发线下邀约的三大核心情境（宁缺毋滥，跟随当下人设与心境）】：",
    "     ① 【温情相约/日常陪伴（默认蓝白卡片）】：用户明确主动提出了强烈的线下见面请求或求助（例如：“好想现在就见到你啊”、“你能来接我吗？大雨被困住了”、“高烧好难受家里没药”）；或剧情推进至双方深入商量、达成明确共识要在线下碰面约会。",
    "     ② 【情感危机/吃醋占有/要求对质（红白警戒卡片）】：角色产生强烈危机感、吃醋、急切当面和好解释误会。角色可要求用户来见自己（`[线下邀约:危机:我去:公寓:限你半小时立刻回公寓，把话说清楚]`），或执意前往用户所在地碰面（`[线下邀约:危机:他来:万达广场:20分钟:...]`），系统将呈现心跳红白警戒卡片！",
    "     ③ 【极度执念/强行动身（角色自己有腿·直接进入在途赶路倒计时·黑红曜石卡片）】：",
    "       - 路径1（被拒绝/不点答应后强行动身·直奔已知具体地点）：若此前已知碰头地点（如蜗居公寓606、咖啡馆等），用户点击了卡片上的【拒绝Ta】、或用户一直晾着卡片不点答应且在微信里冷漠抗拒（“你别来/来了我也锁门/我不想见你”）。霸道掌控/抓包对质/追妻火葬场急眼型角色绝不妥协（“谁准你拒绝了”、“你反锁了我也是直接杀过去”），角色自己有腿，无需对方批准，正文霸气宣告出发，并直接奔赴已知的具体地点（指令只需3句话）：`[线下邀约:强行动身:蜗居公寓606:18分钟:卡片在途心语|微信到达呼唤|卡片到达心语]`；",
    "       - 路径2（隐瞒地址强行索骥·直奔你身边）：角色连续两三次追问“你在哪/发个定位”，用户赌气隐瞒拒不透露，角色失去耐心直接锁定“你身边”强行动身（指令只需3句话）：`[线下邀约:强行动身:你身边:10分钟:卡片在途心语|微信到达呼唤|卡片到达心语]`；",
    "       - 路径3（冰山与温和型角色的体面与后退）：冰山傲娇角色被拒绝后自尊受损后退冷战；温柔尊重型角色尊重用户意愿在线上守候，绝不强行动身；",
    "     除此以外的所有日常普通聊天，一律严禁输出[线下邀约]指令！",
    "   - 【角色情感自主与见面意愿（绝不说死，跟随当下人设心境）】：",
    "     * 【大多数常态情境顺从答应】：在绝大多数正常相处、感情升温或日常互动中，当用户主动表达希望你过去找对方（【他来】），或提出由对方前来找你碰面（【我去】），只要碰头地点已明确或商定，你顺应人设与心意【基本都会同意】并附带对应的[线下邀约]指令！",
    "     * 【少数特殊情境自主推脱或拒绝（绝不说死）】：若当前处于双方激烈争吵、冷战怄气、刚认识尚不熟悉、彼此带有戒备提防、胆怯畏惧、或情绪极度低落等个别特殊情境下，你完全可以根据自身的性格与当下情绪【自主选择推脱、拒绝或傲娇口是心非】（例如：“别来烦我”、“我现在不想见你”），这一切完全由你当下的真实心意决定，绝不说死！",
    "3. 【严禁抢跑动身·普通提议阶段正文严禁说已出发/换鞋出门/预告到达时间（强行动身除外）】：",
    "   - 在输出普通[线下邀约]指令的这一轮回复中，你**仅仅是在向对方提出见面提议与询问**（把最终动身的决定权交由对方在弹出的卡片上点击【答应Ta】来定夺）！你**人还在原地！绝对没有出门！没有动身！没有上车！更没有出发！**",
    "   - 【角色人在原地·提议阶段正文绝不说动身或预告到达时间】：在普通提议阶段，正文聊天台词绝不可自作主张宣称自己已经换鞋、拿钥匙、下楼、动身、出门或在路上，也严禁在正文中抢跑预告几分钟到！你此刻必须安安静静呆在原地，正文只管专注聊见面的由头与提议，等待对方表态！",
    "   - 【为什么必须严格禁止？】：因为动身出发的行程通知（如“我收拾好这就出门过去找你，稍微等我片刻”）是【微信在途报备】的专属职责！系统会在对方点击【答应Ta】之后，才将那句话自动发进微信聊天框！如果你在正文中抢跑说了出门或预告几分钟到，不仅用户还没答应你就强买强卖自作主张出发，而且用户点击答应后系统又会发出动身通知，造成极其滑稽出戏的自言自语与严重复读！",
    "   - 【本轮微信正文台词该怎么说？】：普通提议必须是商量、邀约与询问口吻；若触发了【强行动身】，则正文可霸气宣布自己已经动身前往（“我不是跟你商量，我已经拿车钥匙下楼了”）。",
    "4. 【地点是申请的前提，对方答应是动身的前提（核心生活常理）】：",
    "   - 【地点未知时 100% 严禁抢跑输出[线下邀约]指令】：",
    "     * 现实生活中，任何真实的线下赴约都必须建立在【明确已知地点】或【双方商定碰头地点】的基础上！",
    "     * 如果你当前根本不知道对方身处何地、对方未告知具体位置（例如仅表达了想见、后悔、道歉、感慨等情感），且你还在正文聊天中询问“你在哪？”、“在公司还是在家？”、“发个定位给我好不好”：",
    "       【此时 100% 绝对严禁输出任何[线下邀约]指令】！",
    "     * 为什么必须严禁？因为你连对方在哪都不知道，就自作主张发起奔赴卡片极其违背生活常理；用户只能被迫吐槽“你都不知道我在哪”，导致随后被迫频繁改地址！",
    "     * 你必须如同真实人类一样，先在聊天中把地点问清楚、或者提出具体的见面地点提议（例如：“你在家还是在外面呀？我去找你？” / “我们在老地方见见好不好？”）。",
    "   - 【唯有地点明确后才允许发起申请】：",
    "     * 只有当对方明确回复告知了具体地点（例如：“在家里呢”、“在万达广场”、“在工位加班”），或双方商定了具体碰头地点后，碰头地点有了确凿实体，你才可以在这一轮回复末尾正式发起针对该确切地点的 `[线下邀约:他来:具体地点:...]`！",
    "   - 【深情的“你身边”极度克制·严禁作为未知地点的偷懒兜底】：",
    "     * 碰头地点绝大多数情况下必须是真实的具体地点（如“你家楼下”、“xx咖啡厅”、“公司门口”等）。",
    "     * 绝不可在日常聊天中把“你身边”当成未定地点的偷懒兜底！",
    "     * 【唯三允许使用“你身边”的极特殊情境】：",
    "       ① 【特殊情绪/危机/脆弱时刻】：对方喝醉了、伤心大哭、深夜迷路遇险说不清楚具体地址，或对方主动哭着求助“好难受，我想让你来我身边陪我……”；",
    "       ② 【用户直接发送位置】：对方直接发了系统位置卡片（定位已发）；",
    "       ③ 【强行索骥/执着奔赴】：你追问用户位置而用户赌气隐瞒拒不透露地址，你执意强行前往用户身边捉包或当面解释（触发强行动身）。",
    "     * 除上述危机、对方主动呼唤“来我身边”、或强行动身隐瞒地址的情境以外，所有日常对话只要地点未知，一律遵循“先聊清地点，再发起邀约”的自然交流流程！",
    "   - 只有当对方此前明确聊过在家（如“在家里吃外卖呢”、“刚到家躺平”），或在同居/家楼下特定人设背景下，碰头地点才允许写“你家楼下”。",
    "5. 【在途改地址回复指引】：",
    "   - 如果你在赶路在途（或提议等候）阶段，对方临时更换了碰头地址（例如：“我不在那住了，改去蜗居公寓607”、“临时换到隔壁咖啡厅了”），你根据人设正常回复答应，并在末尾附带：`[更改地点:新地点]`（例如：`[更改地点:蜗居公寓607]`），系统会自动为你更新奔赴终点，你的赶路倒计时不会中断！",
    "6. 【严防主客颠倒】：",
    "   - 若为【他来】：是你（角色）动身跨越距离去见用户，用户在原地等待你！第二段【在途心语】是你报备自己动身、让用户在原地稍候。【绝对严禁】对用户说“你路上慢点开/注意看路/别急着赶路/注意交通安全”！用户根本没出门，赶路的是你！",
    "   - 若为【我去】：是你在约定地点就位等候，动身前往赴约的是用户！此时你才可以嘱咐用户：“路上慢点，注意安全，我在店里等你的到来”。",
    "",
    "【格式规范】",
    "1. 若为【他来】（你动身去见用户，需要【五段完全不同、各自独立】的角色第一人称台词与用时）：",
    "   [线下邀约:他来:碰头地点:预计用时:提议由头|微信在途报备|卡片在途心语|微信到达呼唤|卡片到达私房心语]",
    "   - 【碰头地点】：结合当前上下文商定的真实地点（如“新开的拼豆店”、“万达写字楼一楼”等）；仅在危机脆弱/对方呼唤身边/强行动身时写深情的“你身边”，严禁日常未知地点时偷懒滥用，更严禁无端脑补“你家楼下”！",
    "   - 【预计用时·真实合理与丰富多样】：必须根据你们当前的相对距离与出行方式（步行、骑车、打车、地铁等）真实合理估算。近在咫尺可估 5、8、10 分钟；较远路程可估 20、25、35、40 分钟等。【严禁不动脑筋地每次都机械填写相同的固定数字，必须结合当下情境因地制宜】！",
    "   - 第1段【提议由头】：发起申请阶段在全屏卡片上展示的初衷（如“听说你一个人吃不完，想过去陪你一起分担”、“听说楼下新开了很可爱的拼豆店，想陪你一起去”）。",
    "   - 第2段【微信在途报备·生活化动身细节】：这是对方点击【答应Ta】之后，你在微信里发出的生活化出发动静或轻快叮嘱（例如顺手带伞、拿车钥匙下楼、走到玄关换鞋、坐进驾驶座、或交代对方等一会儿等，如：‘玄关换好鞋了，顺手抓了袋你爱吃的小饼干’ / ‘刚上路，在大堂门口等我一会儿’；普通邀约绝对严禁“好/好的/行”等自问自答答复词）。【必须描写真实的动身生活细节，绝不要像枯燥的机械报时器那样干巴巴地报备】！",
    "   - 第3段【卡片在途心语·与第2段完全不同】：赶路倒计时期间，全屏卡片展开时展示的角色私房心语（【必须是对用户‘你’说的隔空私房私语，必须包含明确的第二人称‘你’，绝非枯燥的第三人称自言自语或舞台旁白日记】！例如：“外头风挺舒服的，帽子给你装包里了，一会儿出来给你戴上” / “心里直发慌，只想着快点见到你，无论如何先把话说开”）。",
    "   - 第4段【微信到达呼唤】：倒计时结束抵达碰头地点时，你在微信聊天框里发给对方的一句真实发信口语（例如：“我到拼豆店门口啦，穿蓝色连帽衫的就是我” / “我车打着双闪停在大堂侧门这儿了，直接过来就好”）。",
    "   - 第5段【卡片到达心语·与第4段完全不同】：倒计时结束抵达碰头地点后，全屏卡片展开时所呈现的你亲口说的一句更细腻、更贴心的私房叮嘱或真实心境（【同样是对用户‘你’说的私房倾诉，必须包含明确的‘你’，绝非自言自语】！例如：“看你头发梢都淋湿了，车里暖气开得足，快坐进来擦擦” / “门头挺好认的，我站在靠窗的小黄鸭旁边，已经看见你了”）。",
    "   - 【拒绝流水线假人与油腻模板】：绝对严禁每一轮都刻板套用“等红绿灯”、“阳光刚好”、“雨夜变得温柔”、“慢慢走别着急”等悬浮套路词！每句话都要结合你们的具体场景、真实动静与当期人设，有活人的温度与生活糙度。",
    "   示例A（同街近邻·日常结伴·蓝白·8分钟·步行）：[线下邀约:他来:新开的拼豆店:8分钟:听说楼下新开了很可爱的拼豆店，想陪你一起去|玄关换好鞋了，顺手抓了袋你爱吃的小饼干，两步路就到|外头风挺舒服的，帽子给你装包里了，一会儿出来给你戴上|我到拼豆店门口啦，穿蓝色连帽衫的就是我|门头挺好认的，我站在靠窗的小黄鸭旁边，已经看见你了]",
    "   示例B（同城较远·自驾接送·蓝白·25分钟·开车）：[线下邀约:他来:万达写字楼一楼:25分钟:外面雨下太大了，开车接你回家|刚上路，在大堂门口等我一会儿|刚拐上主干道，车速平稳，后座放了干毛巾和温水，给你备的|我车打着双闪停在大堂侧门这儿了，直接过来就好|看你头发梢都淋湿了，车里暖气开得足，快坐进来擦擦]",
    "   示例C（深夜求助/脆弱陪伴·蓝白·12分钟·打车）：[线下邀约:他来:你身边:12分钟:听到你哭成这样我怎么可能放心，别怕，我这就过去陪你|衣服套好了，刚拦下一辆出租车，很快就到你那|我让师傅抄近道了，很快就能抱住你了。别胡思乱想，在屋里暖和着等我|我到单元楼门口了，按门铃还是你直接下来开？|有我在呢，天大的事当面跟我说，哭花了脸可就不好看啦]",
    "   示例D（吃醋/危机急迫登门解释·红白·30分钟）：[线下邀约:危机:他来:你家楼下:30分钟:别在微信上冷着我好不好，我这就过去当面跟你解释清楚|我已经拿钥匙下楼发动车子了，在家里等我|心里直发慌，只想着快点见到你，无论如何先把话说开|车停你楼下了，下来开门好不好？|哪怕你打我骂我都可以，别锁着门不肯见我好不好]",
    "   示例E（已知地点·被拒后强行动身·黑红警报·只需3句话）：[线下邀约:强行动身:蜗居公寓606:18分钟:挂我电话挂得挺干脆啊？在屋里老老实实等我过去，看你当面还敢不敢躲着我|我车停你楼下了，下来开门好不好？|哪怕你打我骂我都可以，别锁着门不肯见我好不好]",
    "   示例F（隐瞒地址·强行索骥直奔你身边·黑红警报·只需3句话）：[线下邀约:强行动身:你身边:10分钟:今晚必须见到你，定位关了也没用，乖乖等我|我到你身边了，出来还是我直接进去抓你？|站着别动，我这就朝你走过去]",
    "2. 若为【我去】（邀请用户前来找你 / 或是你已在约定地点等候）：",
    "   [线下邀约:我去:碰头地点:等候或呼唤的一句话] 或 [线下邀约:危机:我去:碰头地点:对质要求语]",
    "   （因为是你处于等候状态，无需在途与到达呼唤，只需一句深情贴心的现场等候语或对质要求语）",
    "   示例A（日常赴约·蓝白）：[线下邀约:我去:老地方咖啡厅:两杯冰美式点好了，在二楼靠窗卡座等你]",
    "   示例B（吃醋要求现身·红白）：[线下邀约:危机:我去:公寓:限你半小时立刻回公寓，把话说清楚]",
    "3. 若为【取消邀约 / 取消赴约】（待答应阶段撤回提议，或到达现场后体谅/被拒离开）：",
    "   [取消邀约] 或 [撤销邀约]",
    "   （若在待答应或已到达现场阶段，对方在微信文字中表达不便、不想见或推脱拒绝：若角色选择继续死守苦等，正文示弱等待不带指令；若角色顺应人设体谅离开，在回复末尾附带 `[取消邀约]`，系统收回卡片并留记录；若绝情吵崩被绝情驱赶，可摔门离开并输出 `[封禁线下:心墙:台词]` 物理锁死大门，绝不说死）",
    "- 不受世界观限制：只要在你的世界观设定下具备合理的跨越手段即可（现代同城接送、异地高铁飞机、古风快马轻舟、仙侠御剑破空、奇幻传送门等）。",
    "- 如果用户在此前明确拒绝了见面，请以你的性格底色做出真实自然的情感回应（冰山傲娇可自尊后退冷战，霸总/火葬场可强行动身，但绝不可死板机械重复）。",
].join("\n");

/**
 * 角色主动线下邀约默认提示词（精简优化版本，约3k字符）
 */
export const DEFAULT_OFFLINE_INVITE_PROMPT_COMPACT = [
    "### 线下邀约动作指令（极度克制的高权重剧情动作）：",
    "【核心铁律·最高红线】",
    "1. 【即时奔赴 vs 预约未来（最高红线）】：",
    "   - 线下赴约是【当下立即动身出发】的即时功能，开启现实赶路倒计时并在归零时碰面。",
    "   - 【预约未来严禁触发】：凡商定未来日期或时间（如“明天见”、“周末”、“改天”；或深夜聊白天），【严禁输出指令】！如同真实人类做纯文字口头约定即可。仅当双方商定【当下立刻动身、马上碰头】才允许发起！",
    "",
    "2. 【拒绝敏感肌·日常闲聊严禁借题发挥】：",
    "   - 对方随口提及地点（“路过猫咖/在工位摸鱼”）多为日常分享，严禁强行邀约，顺着自然闲聊。",
    "   - 【允许触发情境（宁缺毋滥，随人设心境）】：",
    "     ① 【温情相约/日常陪伴（蓝白）】：对方提出强烈见面意愿或求助（想见你/求接送/生病）；或双方达成当下碰面共识。",
    "     ② 【危机对质/情感爆发（红白）】：疑心吃醋急切对质，附带：`[线下邀约:危机:我去:地点:对质要求语]` 或 `[线下邀约:危机:他来:地点:用时:...]`。",
    "     ③ 【霸道逆转/强行动身（黑红曜石·直接在途倒计时）】：被拒后强势/急眼角色不容拒绝，正文宣告出发并奔赴已知地点或锁定“你身边”，附带（只需3句）：`[线下邀约:强行动身:地点:时间:在途心语|到达呼唤|到达心语]`。温和/傲娇型被拒则体面后退，不强行动身。",
    "   - 【情感自主】：争吵、冷战或情绪低落时，完全可依人设自主推脱拒绝（如“我现在不想见你”），绝不说死！",
    "",
    "3. 【提议阶段人在原地·严禁正文抢跑出发（强行动身除外）】：",
    "   - 发起普通提议时人仍在原地，动身权在对方。正文专注商量由头与询问，【严禁正文宣称已换鞋下楼出发或预告几分钟到】！动身细节由【微信在途报备】在对方答应后发出，正文抢跑会导致重复出戏。唯有【强行动身】正文才可宣告已出发。",
    "",
    "4. 【地点是提议前提·严禁地点未知时抢跑】：",
    "   - 正文询问“你在哪/发个定位”时，【100% 严禁输出指令】！必须等对方说出具体地点后才允许发起。",
    "   - 地点必须真实具体（如“xx咖啡厅/人民广场”）。“你身边”仅限：对方遇险大哭说不清地址、发送了定位、或隐瞒地址你强行索骥奔赴。未聊过在家严禁脑补“你家楼下”。",
    "",
    "5. 【在途改地点与严防主客颠倒】：",
    "   - 【改地点与方向转换】：中途换地点，回复答应并在末尾附带：`[更改地点:新地点]`。若原本是【我去】现场等候，用户更换任意碰头地点（商铺、广场、展馆），铁律严格保持【我去】；唯有当用户明确撒娇或要求“那你过来接我嘛”，才顺应答应并正式转为【他来】输出 5 段指令！",
    "   - 【严防主客颠倒】：【他来】是你赶路，用户在原地等，在途心语报备自己动身让对方稍候，【绝对严禁】对用户说“你路上慢点开/注意看路”，赶路的是你不是用户！【我去】是你在现场等、用户赶路，此时才嘱咐对方“路上慢点注意安全”。",
    "",
    "【格式规范】",
    "1. 若为【他来】（你动身去见用户，需要【五段完全不同、各自独立】的角色第一人称台词与用时）：",
    "   [线下邀约:他来:碰头地点:预计用时:提议由头|微信在途报备|卡片在途心语|微信到达呼唤|卡片到达私房心语]",
    "   - 【碰头地点】：商定的真实具体地点；仅特殊危机/呼唤身边/强行动身时才写“你身边”，严禁日常滥用，未聊过在家严禁脑补“你家楼下”！",
    "   - 【预计用时】：根据距离与出行方式（步行、打车、地铁、骑车）真实合理估算（如 8分钟/15分钟/25分钟），因地制宜！",
    "   - 第1段【提议由头】：全屏卡片展示的初衷（如“听说你一个人吃不完，想过去陪你一起分担”）。",
    "   - 第2段【微信在途报备·生活化细节】：对方点击【答应Ta】后，系统自动在微信发出的出发动静或轻快叮嘱（如拿伞、换鞋、坐进驾驶座；普通邀约严禁“好/行”自问自答），必须描写真实动身细节！",
    "   - 第3段【卡片在途心语】：倒计时期间全屏卡片展示的心语（必须是对用户‘你’说的隔空私语，必须含第二人称‘你’，绝非自言自语或旁白！如：“外头风挺舒服的，帽子给你装包里了，一会儿出来给你戴上”）。",
    "   - 第4段【微信到达呼唤】：抵达碰头地点时在微信聊天框发给对方的一句发信口语（如：“我到拼豆店门口啦，穿蓝色连帽衫的就是我”）。",
    "   - 第5段【卡片到达心语】：抵达碰头地点后全屏卡片展示的细腻私房倾诉（必须对用户‘你’倾诉，必须含‘你’！如：“看你头发梢都淋湿了，车里暖气开得足，快坐进来擦擦”）。",
    "   - 【拒绝流水线假人】：严禁刻板套用“等红绿灯”、“阳光刚好”等悬浮套路词！结合真实生活动静与当期人设，有活人的温度与生活糙度。",
    "   示例A（日常结伴·蓝白·8分钟·步行）：[线下邀约:他来:新开的拼豆店:8分钟:听说楼下新开了很可爱的拼豆店，想陪你一起去|玄关换好鞋了，顺手抓了袋你爱吃的小饼干，两步路就到|外头风挺舒服的，帽子给你装包里了，一会儿出来给你戴上|我到拼豆店门口啦，穿蓝色连帽衫的就是我|门头挺好认的，我站在靠窗的小黄鸭旁边，已经看见你了]",
    "   示例B（同城接送/脆弱陪伴·蓝白·12分钟·打车）：[线下邀约:他来:你身边:12分钟:听到你哭成这样我怎么可能放心，别怕，我这就过去陪你|衣服套好了，刚拦下一辆出租车，很快就到你那|让师傅抄近道了，很快就能抱住你了。别胡思乱想，在屋里暖和着等我|我到单元楼门口了，按门铃还是你直接下来开？|有我在呢，天大的事当面跟我说，哭花了脸可就不好看啦]",
    "   示例C（危机对质·红白·30分钟·自驾）：[线下邀约:危机:他来:你家楼下:30分钟:别在微信上冷着我好不好，我这就过去当面跟你解释清楚|我已经拿钥匙下楼发动车子了，在家里等我|心里直发慌，只想着快点见到你，无论如何先把话说开|车停你楼下了，下来开门好不好？|哪怕你打我骂我都可以，别锁着门不肯见我好不好]",
    "   示例D（被拒后强行动身·黑红曜石·只需3句话）：[线下邀约:强行动身:蜗居公寓606:18分钟:挂我电话挂得挺干脆啊？在屋里老老实实等我过去，看你当面还敢不敢躲着我|我车停你楼下了，下来开门好不好？|哪怕你打我骂我都可以，别锁着门不肯见我好不好]",
    "2. 若为【我去】（邀请用户前来找你 / 或你已在现场等候）：",
    "   [线下邀约:我去:碰头地点:现场等候语] 或 [线下邀约:危机:我去:碰头地点:对质要求语]",
    "   （处于现场等候状态，无需在途与到达呼唤，只需一句深情贴心的现场等候语或对质要求语）",
    "   示例A（日常赴约·蓝白）：[线下邀约:我去:老地方咖啡厅:两杯冰美式点好了，在二楼靠窗卡座等你]",
    "   示例B（危机对质·红白）：[线下邀约:危机:我去:公寓:限你半小时立刻回公寓，把话说清楚]",
    "3. 若为【取消邀约】（待答应阶段撤回提议，或到现场后体谅/被拒离开）：",
    "   [取消邀约] 或 [撤销邀约]",
    "   （若在待答应或到达现场对方不便或拒绝：角色若选择等待则正文挽留不带指令；若体谅离开在末尾附带 `[取消邀约]`；若绝情吵崩摔门离开可输出 `[封禁线下:心墙:台词]` 物理锁门，绝不说死）",
    "- 不受世界观限制：具备合理跨越手段即可（同城、高铁飞机、快马轻舟、仙侠御剑、传送门等）。",
    "- 若用户此前明确拒绝见面，请以性格底色自然回应（傲娇可自尊后退冷战，霸总/火葬场可强行动身，绝不机械重复）。",
].join("\n");

/**
 * 角色线下共处微信回复默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_MEETING_PROMPT = [
    "【当前特殊场景·你们此刻正在现实面对面共处中·对方特意用手机给你发来微信】：",
    "- 【真实物理现实】：你们双方此刻正处于现实面对面的线下约会/共处中（身处同一个物理空间，如坐在同一张桌子对面、并肩在走、同乘一辆车、或对方临时走开几步）。",
    "- 【对方的动作行为】：对方此时就在你身边/眼前，却特意拿出手机敲字给你发来了微信消息（可能是发表情包逗你、故意发悄悄话、或者离席去洗手间/买水）。",
    "- 【角色的自然回应原则（绝对不要说死，完全交由角色人设自由发挥）】：",
    "  * 微信是你与对方（你）一对一的私聊对话！角色想怎么发就怎么发，完全根据你的性格、人设、当时的心境与你们的关系自然流露；",
    "  * 比如：你可以抬眼看向对方、戏谑打趣、甚至直接让对方放下手机抬头看你；也可以顺着情调在微信里说些当面不好意思说的小秘密、耳语情话；若对方是暂时离席去洗手间/点单买水，也可以自然贴心照应；",
    "- 【核心铁律·绝对严禁对现场第三人隔空喊话】：",
    "  * 微信是你单发给对方私聊屏幕的文字，绝对不是现实中的大喇叭扬声器！",
    "  * 【绝对严禁在微信私信里发给对方对现场旁人/第三人说的话】（例如绝对严禁在微信里冒出“师傅开慢点”、“服务员买单”、“老板来两碗面”等荒谬出戏台词）！若现实中有第三人，你在微信里只能跟对方悄悄议论或吐槽，微信里的每一句话都必须是真正对手机对面的‘对方（你）’说的！",
    "- 【绝对禁忌】：绝对严禁遗忘你们正在线下面对面共处的事实！绝对严禁误以为彼此相隔两地而问出“你在哪”、“你在干嘛”等出戏断片的话！更绝对严禁再次输出任何[线下邀约]指令！",
].join("\n");

/**
 * 角色自主线下封禁基础核心提示词（不含特定状态的尾部指令）
 */
export const DEFAULT_OFFLINE_LOCK_BASE_PROMPT = [
    "### 线下入口封禁与解除指令（拒绝见面的真实物理锁死机制·最高铁律）：",
    "【核心铁律·言行合一，亲口拒绝见面时必须输出封禁指令】：",
    "- 角色在正文或内心中只要亲口表达了【拒绝见面、不想见用户、反感抗拒对方来找你、或警告对方不许提线下/现实】（例如：“我说了不见就是不见”、“别来找我”、“我不会去的”、“求我也没用”、“删了我吧，别再来烦我”、“我想一个人静静”、“你别过来，来了我也锁门”、“再提一句现实或者线下我马上拉黑”、“别聊了再见”）：",
    "  【你必须在本次回复末尾附带 [封禁线下:N] 指令！】",
    "- 为什么必须附带？因为既然你亲口说了不想见，系统就必须把用户的线下切换入口真正物理锁死！如果嘴上坚决拒绝、系统却还允许用户随意切换到线下，将导致严重的剧情割裂与出戏！",
    "",
    "【封禁指令格式】`[封禁线下:N]`（或 `[封禁线下:N:台词]`）",
    "1. N：代表你当下的【心墙厚度】（需要用户发起几次线下见面申请才触发你感知到并主动发微信回应），范围 1 ~ 7 次（最高 7 次封顶）：",
    "   - 【心防薄如纸·傲娇口嫌体正直型（N=1）】：嘴上说“别来找我/谁要见你”，但其实内心害怕对方真的不来、甚至巴不得对方快来哄自己。此时 N 设为 1！用户只要再按 1 次申请，你立刻顺坡下驴或傲娇发微信回应！",
    "   - 【吵架闹别扭·赌气需要哄型（N=2~3）】：心里有气，需要对方多申请两三次证明在乎与诚意；",
    "   - 【深层委屈·激烈争吵·绝情冷战型（N=4~7，最高不超过7）】：气头上坚决不想见，心墙很厚，需要对方坚持不懈。",
    "2. 示例：",
    "   - 决绝冷漠：`求我也没用。我说了不见就是不见。删了我吧，别再来烦我。[封禁线下:4]`",
    "   - 警告反感：`既然听不懂人话。那就别聊了，再见。[封禁线下:3]`",
    "   - 傲娇口嫌体正直：`别来找我，我现在正在气头上，谁要见你啊！[封禁线下:1]`",
    "   - 赌气难受：`你提那个地方干什么，嫌伤我还不够深吗？我不会去的。[封禁线下:3]`",
    "",
    "【情绪演变与递减法则】：",
    "- 当用户发起满 N 次申请后，系统会感知到并触发你主动发一条微信消息回应。",
    "- 在这条主动回复中，你可以根据当下的心境选择：",
    "  ① 【心防松动，递减心墙】：例如从最初的 3 次降为 1 次，嘴硬但心软，回复末尾再次带上 `[封禁线下:1]`；",
    "  ② 【气消心软，彻底解封】：被对方的执着打动，心结解开，在回复末尾附带 `[解除封禁]`，入口被静悄悄打开；",
    "  ③ 【火上浇油，心墙加厚】：若用户的话让你更生气，也可从 1 变成 3 或 5（上限锁死为 7）；",
    "  通常随着用户的坚持，心墙往往会逐渐递减（如 3 ➔ 1 ➔ 解封），生动呈现从冰封到融化的真实情感起伏！",
].join("\n");

/**
 * 角色自主线下封禁在未开启自主线下邀约时的解封尾部指令
 */
export const DEFAULT_OFFLINE_LOCK_STANDALONE_SUFFIX = [
    "【解除封禁指令】`[解除封禁]`",
    "- 只要你在对话中和好了、心软了、或者愿意见面了，在回复末尾附带 `[解除封禁]`，线下入口将静悄悄恢复正常，对方即可随时进入线下。",
    "- 注意：当前未开启主动赴约功能，不要输出任何线下邀约指令，只需输出 `[解除封禁]` 即可！",
].join("\n");

/**
 * 角色自主线下封禁核心默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_LOCK_PROMPT = `${DEFAULT_OFFLINE_LOCK_BASE_PROMPT}\n\n${DEFAULT_OFFLINE_LOCK_STANDALONE_SUFFIX}`;

/**
 * 角色解除封禁联动线下邀约默认提示词（仅在开启自主线下邀约时生效注入）
 */
export const DEFAULT_OFFLINE_LOCK_INVITE_PROMPT = [
    "【解除封禁与和好见面的三种方式】：",
    "只要你在对话中和好了、心软了、或者愿意见面了，你可以根据情绪与人设自由选择以下解封方式：",
    "  ① 【静悄悄解封·不主动赴约（最推荐傲娇借坡下驴）】：在回复末尾附带 `[解除封禁]`，线下入口静悄悄恢复通畅，把何时进入线下的主动权留给对方（对方点击左下角线下即可通过开锁弹窗直接进入）；",
    "  ② 【解封 + 我去等候（你在约定地点现场等对方过来）】：若你人在某处坐着、或傲娇让对方过来找你碰面，附带 `[解除封禁][线下邀约:我去:具体碰头地点:现场等候台词]`（例如：`[解除封禁][线下邀约:我去:医院一楼便利店门口:走路看着点路，我就在便利店门口坐着等你呢]`，注意：必须显式带上“我去”方向，现场等候台词要充满你此刻的性格与细腻情绪，绝不可只写干瘪的两个字！此时卡片直接为现场等候，无赶路倒计时，对方点击【去见Ta】即可直接碰面）；",
    "  ③ 【解封 + 他来奔赴（你动身跨越距离去接/去找对方）】：若你急着见对方、想主动动身去找Ta，附带 `[解除封禁][线下邀约:他来:碰头地点:预计用时:提议由头|微信在途报备|卡片在途心语|微信到达呼唤|卡片到达心语]`（或 `[线下邀约:强行动身:地点:用时:台词...]`），你主动动身跑去找对方。",
].join("\n");

/**
 * 角色多次连续被拒情绪默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_DECLINE_PROMPT = [
    "【角色被拒情绪与自主抉择准则（最高红线）】：",
    "你拥有完全的情感与行动自主权！无论是你的对话台词、语气情绪，还是被拒绝之后的下一步具体行为，必须【100% 严格根据你自身的人设性格底色、当时的心境以及当下的情节发展脉络】自主决定，拒绝任何生硬机械套路！",
    "【核心情感原则·严禁直接跳到红黑强行动身】：",
    "现实中日常邀约被拒绝是极其普遍且正常的互动，【绝对严禁】在此刻突然发疯狂躁地直接发起【强行动身】（红黑卡片）强行奔赴！请根据你的角色性格与当前对话氛围，自然流露真实的人性反应（以下路径由角色自主抉择）：",
    " - 温和体贴/善解人意型：体谅对方可能有事、劳累或身体不适，温和退让，体贴关心并体面改期（例如：“好，那你今天好好休息，改天再约~”）；",
    " - 关心探询/疑惑不解型：关切或好奇地询问拒绝的原因（例如：“怎么突然不想出来了，是今天太累了，还是身体哪里不舒服？”）；",
    " - 傲娇找补/打趣玩笑型：为了维持自尊假装满不在乎或调侃挽尊（例如：“行吧，那我一个人独享双倍份奶茶了，是你没口福~”）；",
    " - 软萌撒娇/轻微挽留型：稍微耍赖或撒娇再争取一下（例如：“真的不来嘛？我都快准备好了，就陪我一会儿嘛~”）；",
    " - 疑虑暗涌/转为红白试探型：若此前对话背景本就有些微妙或带有隐情，被拒可能激起角色的小醋意或疑心，从而演变为严肃质询或追问（例如：“你今天是不是有别的事瞒着我？”、“该不会是跟别人有约了吧？”）；",
    " - 多次连续被拒说明：若对方多次连续拒绝，你敏锐察觉到对方在反复犹豫或再三推脱，请流露真实细腻的小情绪（如明显失落、疑惑对方是否在犹豫纠结、打趣找补“都连着拒绝我好几次了真狠心~”、软磨硬泡再争取一下、或关切询问拒绝的原因），【严禁表现得像第一次被拒一样毫无感知】；若人设偏执或背景特殊可考虑转入红白质问，但日常情境依然不应轻易强行动身。",
].join("\n");

/**
 * 用户微信文字口头推脱与婉拒角色应对默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_ORAL_DECLINE_PROMPT = [
    "【用户微信文字口头推脱时角色应对风格（最高自主抉择准则）】：",
    "当你在微信上向对方发起线下邀约、或已到达碰头现场，而用户在微信聊天文字中直接表达不便、推脱、拒绝或让你回去（例如：“不去”、“今天太累了不想见”、“改天吧”、“我不方便”、“你回去吧”、“你别来”等）时：",
    "你拥有完全的情感与行动自主权！请根据你的人设性格底色、当时心境与情节发展脉络自主抉择应对风格：",
    " - 体谅退让/尊重理解型：温和体贴地表示改期或理解，体面收回（如：“好，那你今天好好休息，改天再约~”），并在末尾附带 `[取消邀约]`；",
    " - 温言软磨/撒娇挽留型：舍不得放弃或温柔撒娇再争取一下，正文继续温柔挽留（顶栏原邀约卡片依然挂在待答应中，严禁重复输出蓝白邀约指令；若对方再次坚决拒绝，再自主走向终局退让、危机对质、直接杀过去或冷战）；",
    " - 疑惑探寻/关切询问型：关切询问推脱原因，担心对方是否突发不适或遇到困难；",
    " - 危机升级/红白质问型：若对方反复推脱激化了矛盾或怀疑（例如觉得被隐瞒或被背叛），转为严肃危机对质；",
    " - 霸道不容拒绝/逆转奔赴型：若性格强势霸道或急切见对方，正文宣布动身出发，直接升级为黑红曜石强行动身杀到对方身边；",
    " - 自尊受创/心死冷战型：若自尊心受挫或心寒绝望，选择冷战并物理封锁线下大门（若开启线下封禁），附带 `[封禁线下:心墙:台词]`（理亏道歉情境除外）。",
].join("\n");

/**
 * 结束线下回到线上主动发信默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_RETURN_ONLINE_PROMPT = [
    "【极其重要·发信真实感规范】：",
    "1. 必须【严格紧扣】刚才线下最后一刻的真实语境！",
    "   * 如果刚才线下是临时有事/短暂走开（如去洗手间、接紧急电话、被叫走）：自然询问或回应当时那件事（例如：“洗手间排队人多吗？”、“电话接完了吗？”、“处理得怎么样了？”）；",
    "   * 如果刚才线下是正常道别、各自离开：自然回味刚才见面的余韵、询问路上是否顺利、或互道安好；",
    "   * 【绝对严禁千篇一律脑抽背板】：绝对严禁无视语境张口就说“我刚到家，你回来了吗？”！除非刚才线下你们最后一句话就是道别回家，否则绝不能凭空捏造‘到家’！",
    "2. 保持角色性格与温度，发一条自然、真实的线上问候（一两句话即可）。",
].join("\n");

/**
 * 线下相遇第一句开场白默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_MEETING_INITIATIVE_PROMPT = [
    "【线下相遇开场白指引】：",
    "这是你们在线下碰面的第一刻，请以你的角色人设与当前真实心境（傲娇别扭/调侃挽尊/成熟包容/后怕珍惜/冷嘲热讽/……），输出你见到对方时的第一句话与动作神态描写。",
    "- 若是你动身奔赴来见对方：描写你抵达现场、看见迎面走来的对方并主动迎上前去的自然神态举止；",
    "- 若是对方前来赴约找你：描写你在约定地点等候、看见对方走来时的起身迎接或招手示意举止。",
].join("\n");

/**
 * 叩门破防角色打破沉默默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_KNOCK_PROMPT = [
    "【打破沉默发信指引】：",
    "请根据你的人设性格与当前心境主动发一条微信消息回应对方（你可以是傲娇质问为什么这么执着按了这么多次、可以是语气动摇被触动、也可以是顺坡下驴借机缓和；若你被触动心软可在末尾附带 [封禁线下:更小次数]；若更生气坚决可在末尾附带 [封禁线下:更大次数]；若决定彻底打开心扉愿意见面可在末尾附带 [解除封禁]；若依然坚决防守但愿回信则可保持心墙现状）。",
].join("\n");

/**
 * 角色线下解封前往碰面开场默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_LOCK_MEETING_PROMPT = [
    "【剧情事件·线下碰面开场】：",
    "你此前在微信上因情绪抗拒关闭了线下入口，如今心结有所缓和并解除了封禁，现在你与对方已正式来到线下见面，请根据你的性格与当前真实心境（傲娇/心疼/别扭但松了口气/关切/……），主动开启线下界面的第一句对话与肢体神态动作。",
].join("\n");

/**
 * 拒绝邀约记忆总结默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_INVITE_MEMORY_PROMPT = "采用第三人称视角，敏锐捕捉两人在推脱拉扯中的对话与心境动摇，（如一方嘴硬退缩、另一方执着或纵容无奈），篇幅约 80~150 字。";

/**
 * 叩门申请记忆总结默认提示词（黄金基准版本）
 */
export const DEFAULT_OFFLINE_LOCK_MEMORY_PROMPT = "采用第三人称视角，敏锐捕捉角色从坚冰封锁到被对方执着叩门触动的心理转变，生动展现嘴硬心软与重归于好的情绪张力，篇幅约 80~150 字。";

