"use client";

import { forwardRef, Fragment, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChatSession, ChatMessage, CHAT_APP_SETTINGS_UPDATED_EVENT, CHAT_INITIAL_VISIBLE_MESSAGE_COUNT, CHAT_LOAD_MORE_MESSAGE_COUNT, CHAT_REQUEST_REPLY_EVENT, loadChatAppSettings, loadChatMessages, loadChatContacts, loadChatSessions, saveChatSessions, pushChatMessage, updateChatMessage, deleteChatMessage, deleteChatMessagesFrom, deleteChatMessagesByIds, retractChatMessage, editChatMessage, updateMessageMediaData, replaceResponseBatchWithParts, replaceGroupResponseRound, isReadingDiscussMessage, isSystemInstructionMessage, createResponseBatchId, createResponseRoundId, getLatestStateValues, getLatestCharacterStateValues, compareChatMessages, isSessionStreamingEnabled, applyOfflineLockDirective, applyOfflineUnlockDirective, OFFLINE_INVITE_DECLINE_COUNT_PREFIX, DEFAULT_OFFLINE_INVITE_MEMORY_PROMPT, DEFAULT_OFFLINE_LOCK_MEMORY_PROMPT, type OfflineInviteDeclineContext } from "@/lib/chat-storage";
import { cleanStreamText, splitStreamPreviewSegments, stripLiteralTexts, stripXmlTagBlocks } from "@/lib/stream-preview";
import type { StateValue } from "@/lib/chat-storage";
import { parseStateValues, mergeStateValues } from "@/lib/state-value-parser";
import { parseAIResponse, type ParsedMessagePart } from "@/lib/rich-message-parser";
import { isKnownStickerLabel } from "@/lib/sticker-data";
import { translateReasoningText } from "@/lib/reasoning-translate";
import { MessageBubble, MediaDetailModal, prewarmStickerCache, BilingualTextBlock, isStandaloneHtmlPreviewContent, normalizeTextBubbleContent } from "./message-bubble";
import { GeneratedImageErrorDialog } from "./generated-image-error-dialog";
import { PhotoInputModal, TextPhotoModal, VoiceRecordModal, RedPacketModal, LocationInputModal, SystemInstructionModal } from "./rich-input-modals";
import { EmojiPanel, StickerPanel } from "./emoji-panel";
import { StickerSearchSuggest } from "./sticker-search-suggest";
import { StateValuesPanel } from "./state-values-panel";
import { generateChatCompletion, generateOfflineChatCompletion, flattenCompletionResult, ChatEngineError } from "@/lib/chat-engine";
import { formatOfflineTurnXml as formatOfflineTurnXmlShared, buildOfflinePromptHistory as buildOfflinePromptHistoryShared } from "@/lib/offline-prompt-builder";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import { CustomStatusFrame } from "@/components/chat/custom-status-frame";
import { sendBrowserNotification } from "@/lib/browser-notification";
import { dispatchChatMessageNotice } from "@/lib/chat-notification-events";
import { shouldSendChatInputOnEnter } from "@/lib/chat-input-keyboard";
import { useChatBottomReserve } from "./use-chat-bottom-reserve";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { createPortal } from "react-dom";

import { loadCharacters } from "@/lib/character-storage";
import { Character } from "@/lib/character-types";
import { loadCustomAppChatPlusActions, type RegisteredCustomAppChatPlusAction } from "@/lib/custom-app-chat-directives";
import { CUSTOM_APPS_UPDATED_EVENT, getInstalledCustomApp } from "@/lib/custom-app-storage";
import { toCustomAppIconId, type InstalledCustomApp } from "@/lib/custom-app-types";
import { CustomAppRunner } from "@/components/app-market/custom-app-runner";
import { CustomAppForegroundBoundary } from "@/components/app-market/custom-app-failure";

import { ChatSettingsPanel } from "./chat-settings-panel";
import { VoiceCallScreen } from "./voice-call-screen";
import { VideoCallScreen } from "./video-call-screen";
import { GroupCallScreen } from "./group-call-screen";
import { TransferTargetModal } from "./transfer-target-modal";
import { GiftPickerModal } from "./gift-picker-modal";
import { ConfirmDialog } from "@/components/ui/modal";
import { deleteWeixinCloudMessagesFromCloud, emitWeixinSyncToast, syncAllWeixinBotRuntimesToCloud } from "@/lib/weixin-cloud-sync";
import { loadApiConfigs, loadBindingConfig, loadPresets, loadRegexes, resolveAuxiliaryApiConfig, resolveBinding, resolveUserIdentity } from "@/lib/settings-storage";
import { simpleLLMCall } from "@/lib/api-helpers";
import { saveMemoryEntry } from "@/lib/memory-storage";
import { generateGroupChatCompletion, generateGroupOfflineChatCompletion, parseGroupChatResponse, buildEditableGroupRoundText } from "@/lib/group-chat-engine";
import { appendChatOfflineTurn, deleteChatOfflineTurn, deleteChatOfflineTurnsFrom, extractThinkingTag, loadChatOfflineTurns, parseOfflineResponse, saveChatOfflineTurns, updateChatOfflineTurn, type ChatOfflineTurn } from "@/lib/chat-offline-storage";
import { applyDisplayRegex, applyEditRegex } from "@/lib/llm-prompt-assembler";
import { scheduleFollowUp, cancelFollowUp, cancelBackgroundGeneration, isBackgroundReplyGenerating } from "@/lib/follow-up-service";
import { useKeyboardDismissAutoSend } from "@/components/chat/use-keyboard-dismiss-auto-send";
import { cancelBailoutKey } from "@/lib/push-bailout-client";
import { PENDING_REPLY_PREFIX } from "@/lib/friend-request-engine";
import { OfflineInviteModal, OfflineInviteCapsule, getRemainingMinutes, type OfflineInviteData } from "./offline-invite-modal";
import type { UserIdentity } from "@/components/settings/user-identity";
import { AlertCircle, Blocks, Check, Trash2, Unlock, User, ChevronLeft, ChevronRight, Clapperboard, Clock, Gift, Languages, Loader2, Lock, MoreHorizontal, X } from "lucide-react";
import { setDebugChatState } from "@/lib/debug-store";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { setChatActive } from "@/lib/music-action-queue";
import { getMusicControlBridge } from "@/lib/music-control-bridge";
import { findPlayableMatch, getNeteaseLyrics, getNeteaseSongDetail } from "@/lib/music-service";
import { approveMemoryWriteRequest } from "@/lib/tool-executor";
import type { MemoryWriteRequest, ToolResult } from "@/lib/tool-executor";
import { formatChatUiTime } from "@/lib/chat-time";
import { parseActionTags } from "@/lib/action-parser";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";
import { creditWalletBalance, payWithWalletBalance } from "@/lib/wallet-storage";
import { loadDeliveredShoppingGifts, type ShoppingGiftCandidate } from "@/lib/shopping-gift-utils";
import { settleShoppingPaymentRequest } from "@/lib/shopping-payment-request";
import type { RegexConfig } from "@/lib/settings-types";
import { MacroEngine } from "@/lib/macro-engine";
import {
    createPendingChatGeneratedImageData,
    generateAndApplyChatGeneratedImage,
    isPendingChatGeneratedImageMessage,
} from "@/lib/generated-image-retry";
import { scrollElementWithinContainer } from "@/lib/dom-scroll";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import { ChatScreenEffectOverlay, type ActiveScreenEffect } from "./chat-screen-effect";
import {
    formatChatDiceResultMessage,
    isDiceOnlyMessage,
    matchChatScreenEffectRule,
    rollChatDiceFace,
} from "@/lib/chat-screen-effects";
import { abortableDelay, throwIfAborted } from "@/lib/abort-utils";
import { GROUP_SELF_KEY, canGroupAdminAct, applyGroupAdminAction, buildGroupAdminNoticeText, getGroupMemberDisplayName, getGroupMuteRemainingMs, getGroupRole, isGroupMuted, formatMuteRemainingLabel, resolveGroupMemberKeyByName, type GroupAdminAction } from "@/lib/group-admin";
import { extractTextToolDirectiveText } from "@/lib/text-tool-protocol";
import { emitChatPluginEvent, getChatPluginHookBus, runChatPluginTransform } from "@/lib/chat-plugin-hooks";
import { CHAT_PLUGIN_TOAST_EVENT, getChatPluginRuntime } from "@/lib/chat-plugin-runtime";
import { ChatPluginSlot } from "@/components/chat/chat-plugin-slot";

// ── Call system message detection ──────────────────────────
// Call messages are stored with user/assistant role for correct prompt alternation,
// but should render as centered system notifications in the UI.
const CALL_SYS_RE = /\[我(?:向.+)?(?:发起了|挂断了|拒绝了|取消了)(?:群?(?:语音|视频)通话)/;
function isCallSysMsg(msg: ChatMessage): boolean {
    return CALL_SYS_RE.test(msg.content);
}
/** Returns the effective UI role: call messages render as "system" regardless of stored role */
const ACTION_MEDIA_TYPES = new Set(["poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request", "group_admin_notice"]);
// 拍一拍/群管理通知/通话留痕渲染成灰色系统小字，没有 💭 面板入口——
// 状态栏/内心独白/状态值挂上去会被显示层吞掉，挂载时必须跳过它们
function canCarryFoldedPanel(part: { content?: string; mediaType?: ChatMessage["mediaType"] }): boolean {
    if (part.mediaType === "poke" || part.mediaType === "group_admin_notice") return false;
    return !CALL_SYS_RE.test(part.content || "");
}
function uiRole(msg: ChatMessage): string {
    if (msg.role === "system" || ACTION_MEDIA_TYPES.has(msg.mediaType || "")) return "system";
    if (isCallSysMsg(msg)) return "system";
    return msg.role;
}

function isChatRoomElementVisible(element: HTMLElement | null): boolean {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
}

function splitOfflineParagraphs(text: string): string[] {
    const normalized = text.replace(/\r\n?/g, "\n").trim();
    if (!normalized) return [];
    const splitPlainText = (value: string) => value
        .split(/\n\s*\n+/)
        .map(part => part.trim())
        .filter(Boolean);

    const parts: string[] = [];
    const fenceRx = /(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\3(?=\n|$)/g;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = fenceRx.exec(normalized)) !== null) {
        const fenceStart = match.index + match[1].length;
        const before = normalized.slice(cursor, fenceStart);
        parts.push(...splitPlainText(before));

        const fencedBlock = normalized.slice(fenceStart, fenceRx.lastIndex).trim();
        if (fencedBlock) parts.push(fencedBlock);
        cursor = fenceRx.lastIndex;
    }

    parts.push(...splitPlainText(normalized.slice(cursor)));
    return parts;
}

function hasOfflineHtmlPreview(text: string): boolean {
    return splitOfflineParagraphs(text).some(part => isStandaloneHtmlPreviewContent(part));
}

const OfflineAssistantTextBlock = memo(function OfflineAssistantTextBlock({
    text,
    defaultExpanded,
}: {
    text: string;
    defaultExpanded: boolean;
}) {
    const paragraphs = useMemo(() => splitOfflineParagraphs(text), [text]);
    if (paragraphs.length <= 1) {
        return <BilingualTextBlock text={text} mode="markdown" defaultExpanded={defaultExpanded} htmlFrameVariant="offline" />;
    }
    return (
        <div className="chat-offline-paragraph-stack">
            {paragraphs.map((paragraph, index) => (
                <div className="chat-offline-paragraph" key={`${index}-${paragraph.slice(0, 16)}`}>
                    <BilingualTextBlock text={paragraph} mode="markdown" defaultExpanded={defaultExpanded} htmlFrameVariant="offline" />
                </div>
            ))}
        </div>
    );
});

const CHAT_VISUAL_MEDIA_TYPES = new Set([
    "sticker",
    "dice",
    "red_packet",
    "transfer",
    "payment_request",
    "gift",
    "contact_card",
    "image",
    "location",
    "music_share",
    "xiaohongshu_note_share",
    "app_card",
    "audio",
    "video",
    "quote",
    "media_file",
]);

const WEIXIN_CLOUD_DELETE_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then(
            value => {
                window.clearTimeout(timer);
                resolve(value);
            },
            error => {
                window.clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function getWeixinCloudDeleteTargetCount(messages: ChatMessage[]): number {
    const targets = new Set<string>();
    for (const message of messages) {
        const sync = message.cloudSync;
        if (sync?.source !== "weixin-cloud") continue;
        if (!sync.botId || !sync.externalId) continue;
        targets.add(`${sync.botId}\u0000${sync.externalId}`);
    }
    return targets.size;
}

const CHAT_MEDIA_BUBBLE_TYPES = new Set([
    "sticker",
    "dice",
    "red_packet",
    "transfer",
    "payment_request",
    "gift",
    "contact_card",
    "image",
    "location",
    "music_share",
    "xiaohongshu_note_share",
    "app_card",
    "media_file",
]);

const STANDALONE_CARD_BUBBLE_STYLE = {
    background: "transparent",
    border: "none",
    boxShadow: "none",
    backdropFilter: "none",
    WebkitBackdropFilter: "none",
    padding: 0,
    overflow: "visible",
} as const;

function getChatFlowVisibleContent(msg: ChatMessage, displayContent?: string): string {
    return normalizeTextBubbleContent(displayContent ?? msg.content);
}

function isChatVisualMedia(msg: ChatMessage): boolean {
    return !!msg.mediaType && CHAT_VISUAL_MEDIA_TYPES.has(msg.mediaType);
}
/** 思维链触发条的单行摘要：取首个非空行并剥离 markdown 标记（**、`、# 等），避免星号原样显示 */
function reasoningPreviewLine(text: string): string {
    for (const rawLine of text.split("\n")) {
        const line = rawLine
            .replace(/```+/g, "")
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/__([^_]+)__/g, "$1")
            .replace(/\*([^*]+)\*/g, "$1")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/^\s*#{1,6}\s+/, "")
            .replace(/^\s*>\s+/, "")
            .replace(/^\s*[-*+]\s+/, "")
            .replace(/[*`]+/g, "")
            .trim();
        if (line) return line;
    }
    return "思考过程";
}

function isHiddenChatFlowMessage(msg: ChatMessage, displayContent?: string): boolean {
    if (msg.mediaType === "tool_result" || msg.mediaType === "tool_call") return true;
    return !isChatVisualMedia(msg)
        && !getChatFlowVisibleContent(msg, displayContent)
        && uiRole(msg) !== "system"
        && !msg.statusPanel
        && !msg.innerMonologue
        && !msg.reasoningText;
}

// ── Background generation tracking ──────────────────────────
const GENERATING_PREFIX = "chat-generating:";
const CHAT_BG_COMPLETE = "chat-bg-complete";
const CHAT_OFFLINE_MODE_PREFIX = "chat-offline-mode:";
const CHAT_THEATER_MODE_PREFIX = "chat-theater-mode:";
const GENERATING_LOCK_TTL_MS = 5 * 60 * 1000;
const OFFLINE_INITIAL_LOAD = 10;
const OFFLINE_LOAD_MORE_COUNT = 10;

type PendingNativeToolCall = {
    id: string;
    name: string;
};

type ActiveGenerationRun = {
    runId: string;
    controller: AbortController;
    pendingNativeToolCalls: PendingNativeToolCall[];
};

type GenerationRunGuard = {
    signal?: AbortSignal;
    isActive?: () => boolean;
};

type AssistantMessageDraft = Omit<ChatMessage, "id" | "createdAt" | "status"> & { status?: ChatMessage["status"] };

const PENDING_OFFLINE_INVITE_DECLINE_PREFIX = "chat_offline_invite_declined_";
const ACTIVE_OFFLINE_INVITE_PREFIX = "chat_active_offline_invite_";
const OFFLINE_INVITE_ACTIVE_SESSION_PREFIX = "chat_offline_invite_active_session_";
const OFFLINE_INVITE_ACTIVE_THEME_PREFIX = "chat_offline_invite_active_theme_";
const OFFLINE_LOCK_PREFIX = "chat_offline_lock_";
const OFFLINE_LOCK_PENDING_VISIT_PREFIX = "chat_offline_lock_pending_visit_";

type OfflineLockData = {
    isLocked: boolean;
    knockCount: number;         // 当前轮次用户已敲门次数
    requiredKnocks: number;     // 当前需要敲几次才触发角色主动回应（1~7次）
    stageKnocks?: number;       // 本阶段（当前事件）累计敲门次数
    lockMessage: string;        // 弹窗显示的固定台词
    sourceBatchId?: string;     // 发起封禁的那一整轮回复批次号，供整轮撤回/删除时溯源解除
    relatedBatchIds?: string[]; // 演变过程中的回复批次号集合
};

async function summarizeAndSaveOfflineBondMemory(options: {
    characterId: string;
    characterName: string;
    userName: string;
    eventType: "invite_decline" | "lock_knock";
    count: number;
    place?: string;
    allStoredMessages: ChatMessage[];
    fallbackContent: string;
    customStylePrompt?: string;
}): Promise<void> {
    const {
        characterId,
        characterName,
        userName,
        eventType,
        count,
        place,
        allStoredMessages,
        fallbackContent,
        customStylePrompt,
    } = options;

    let memoryContent = fallbackContent;

    try {
        const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") ?? loadApiConfigs()[0];
        if (apiConfig) {
            // 智能溯源切片：优先从事件起点（封禁关门或邀约发起）开始向后截取，最大容纳 25~30 轮（约 50~60 条消息）
            let eventStartIndex = -1;
            if (eventType === "lock_knock") {
                for (let i = allStoredMessages.length - 1; i >= 0; i--) {
                    const m = allStoredMessages[i];
                    if (
                        (m.mediaType === "offline_lock_system_notice" || Boolean(m.mediaData?.offlineLock) || m.role === "system") &&
                        Boolean(m.content && /暂时关闭了线下入口|封禁了线下入口|封锁了线下入口/.test(m.content))
                    ) {
                        eventStartIndex = i;
                        break;
                    }
                }
            } else {
                for (let i = allStoredMessages.length - 1; i >= 0; i--) {
                    const m = allStoredMessages[i];
                    if (m.mediaType === "offline_invite" || m.mediaData?.offlineInvite) {
                        eventStartIndex = i;
                        break;
                    }
                }
            }

            // 若找到起点且在合理范围内（<= 60 条消息），从起点开始完整截取；否则截取最近 60 条消息（约 25~30 轮）
            const maxMessages = 60;
            let slicedMessages: ChatMessage[];
            if (eventStartIndex >= 0 && (allStoredMessages.length - eventStartIndex) <= maxMessages) {
                slicedMessages = allStoredMessages.slice(eventStartIndex);
            } else {
                slicedMessages = allStoredMessages.slice(-maxMessages);
            }

            const dialogText = slicedMessages
                .map(m => {
                    if (m.role === "system" || m.mediaType?.includes("system_notice")) {
                        return `[系统提示]: ${m.content || ""}`;
                    }
                    const speaker = m.role === "user" ? userName : characterName;
                    const text = m.content || "";
                    return `${speaker}: ${text}`;
                })
                .join("\n");

            const headerPrefix = eventType === "lock_knock"
                ? `「${characterName}封禁线下与${userName}的叩门申请记录」：`
                : `「${userName}多次拒绝${characterName}线下邀约的记录」：`;

            const factDescription = eventType === "lock_knock"
                ? `此前角色（${characterName}）因情绪矛盾一度封锁了线下入口拒绝相见，用户（${userName}）不顾被拒、坚持不懈地连续按下了整整 ${count} 次见面申请；角色的心墙最终被这 ${count} 次执着的叩门敲动并解除封禁，两人正式和好。`
                : `此前角色（${characterName}）提议前往「${place || "约定地点"}」见面，期间曾被用户（${userName}）连续推开婉拒了整整 ${count} 次；但经过两人的推拉与角色的坚持，用户最终如约赶赴现场相见，两人顺利碰面相聚。`;

            const defaultStyleRequirement = eventType === "lock_knock"
                ? DEFAULT_OFFLINE_LOCK_MEMORY_PROMPT
                : DEFAULT_OFFLINE_INVITE_MEMORY_PROMPT;
            const activeStyleRequirement = customStylePrompt?.trim() || defaultStyleRequirement;

            const systemPrompt = `你是一个极擅长提炼角色深度羁绊与情感记忆的作家。你的任务是将用户与角色之间一段真实的【${eventType === "lock_knock" ? "线下封禁·叩门破防" : "线下赴约·推拉相聚"}】经历，提炼为一条富有温度、生动细腻的长期记忆。

【必须遵循的硬性要求】：
1. 必须客观且自然地体现核心事实：${eventType === "lock_knock" ? `用户执着敲门/申请了整整 ${count} 次才终得破防开门` : `提议见面曾被用户连续婉拒推开了整整 ${count} 次才终得答应`}。
2. 结合所附带的 25~30 轮真实对话上下文，敏锐捕捉两人的称呼习惯、性格反差与真实情绪拉扯，绝不允许出现机械死板的编程模板套话。
3. 【文风偏好与叙事视角】：${activeStyleRequirement}
4. 【格式铁律】：必须以「${headerPrefix}」开头（直角引号标题后紧跟中文冒号，绝对不要使用【】中括号或星号加粗），其后紧跟具体提炼的记忆正文。
5. 只输出最终提炼的记忆正文本身，不要有任何多余引言、解析或外部代码块包裹。`;

            const userPrompt = `角色姓名：${characterName}\n用户姓名：${userName}\n核心事实：${factDescription}\n\n真实对话上下文切片（涵盖风波始末与情绪拉扯）：\n${dialogText}\n\n请提炼这段专属长期记忆：`;

            const result = await simpleLLMCall(
                apiConfig,
                [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                { temperature: 0.4, label: `线下记忆提炼·${characterName}` }
            );

            const generated = result.content?.trim();
            if (generated && !result.wasTruncated) {
                let cleanGen = generated.replace(/^【[^】]+】[:：]?\s*/, "").trim();
                // 剔除可能残留的 markdown 加粗符号 ** 或引号包裹
                cleanGen = cleanGen.replace(/^\*\*(.*?)\*\*[:：]?\s*/, "「$1」：").trim();
                if (cleanGen.startsWith(headerPrefix)) {
                    memoryContent = cleanGen;
                } else {
                    const bodyOnly = cleanGen.replace(/^(?:「[^」]+」|\*\*[^*]+\*\*|【[^】]+】)[:：]?\s*/, "").trim();
                    memoryContent = `${headerPrefix}${bodyOnly}`;
                }
            }
        }
    } catch (err) {
        console.warn("[summarizeAndSaveOfflineBondMemory] LLM summarize failed, using fallback:", err);
    }

    const now = new Date().toISOString();
    await saveMemoryEntry({
        id: `offline_${eventType === "lock_knock" ? "lock_knock" : "invite_decline"}_${characterId}_${Date.now()}`,
        characterId,
        sourceApp: "chat",
        type: "long_term",
        content: memoryContent,
        importance: 0.85,
        createdAt: now,
        updatedAt: now,
        metadata: {
            eventType: eventType === "lock_knock" ? "offline_lock_knock" : "offline_invite_decline",
            ...(eventType === "lock_knock" ? { stageKnocks: count } : { declineCount: count, place }),
        },
    });
}

function extractDurationMinutes(text: string, fallback: number = 15): number {
    if (!text) return fallback;

    // 1. 常见小时/半小时/刻钟表达
    if (/(?:一个半小时|1\.5小时|1个半小时)/.test(text)) return 90;
    if (/(?:一个小时|1小时|1个?小时)/.test(text)) return 60;
    if (/(?:半个多小时)/.test(text)) return 40;
    if (/(?:半(?:个)?小时)/.test(text)) return 30;
    if (/(?:一刻钟)/.test(text)) return 15;

    // 口语中“十几分钟/十来分钟”锚定在 15 分钟，保持对话与倒计时一致
    if (/(?:十几|十来|十多|一二十)\s*(?:分钟|分)/.test(text)) return 15;
    if (/(?:二三十|二十多|二十来)\s*(?:分钟|分)/.test(text)) return 25;
    if (/(?:三四十|三十多|三十来)\s*(?:分钟|分)/.test(text)) return 35;
    if (/(?:四五十|四十多|四十来)\s*(?:分钟|分)/.test(text)) return 45;
    if (/(?:两三|三两|三五|几)\s*(?:分钟|分)/.test(text)) return 5;

    // 3. 阿拉伯数字 + 分钟 (如 15分钟, 20分, 45 mins)
    const numMatch = text.match(/(\d+)\s*(?:分钟|分|mins?|min)/i);
    if (numMatch) {
        const val = parseInt(numMatch[1], 10);
        if (!isNaN(val) && val > 0 && val <= 180) return val;
    }

    // 4. 中文数字组合 + 分钟 (严格按大数/复合数优先匹配，防止五分钟截胡十五分钟)
    const zhMap: [RegExp, number][] = [
        [/(?:九十五|95)\s*(?:分钟|分)/, 95],
        [/(?:九十分钟|90分钟|九十分)/, 90],
        [/(?:八十五|85)\s*(?:分钟|分)/, 85],
        [/(?:八十分钟|80分钟|八十分)/, 80],
        [/(?:七十五|75)\s*(?:分钟|分)/, 75],
        [/(?:七十分钟|70分钟|七十分)/, 70],
        [/(?:六十五|65)\s*(?:分钟|分)/, 65],
        [/(?:六十分钟|60分钟|六十分)/, 60],
        [/(?:五十五|55)\s*(?:分钟|分)/, 55],
        [/(?:五十分钟|50分钟|五十分)/, 50],
        [/(?:四十五|45)\s*(?:分钟|分)/, 45],
        [/(?:四十分钟|40分钟|四十分)/, 40],
        [/(?:三十五|35)\s*(?:分钟|分)/, 35],
        [/(?:三十分钟|30分钟|三十分)/, 30],
        [/(?:二十五|两十五|25)\s*(?:分钟|分)/, 25],
        [/(?:二十|两十|20)\s*(?:分钟|分)/, 20],
        [/(?:十五|15)\s*(?:分钟|分)/, 15],
        [/(?:十二|12)\s*(?:分钟|分)/, 12],
        [/(?:十分钟|10分钟|十分)/, 10],
        [/(?:八分钟|8分钟|八分)/, 8],
        [/(?:七分钟|7分钟|七分)/, 7],
        [/(?:六分钟|6分钟|六分)/, 6],
        [/(?:五分钟|5分钟|五分)/, 5],
        [/(?:四分钟|4分钟|四分)/, 4],
        [/(?:三分钟|3分钟|三分)/, 3],
        [/(?:两分钟|二分钟|2分钟|两分)/, 2],
        [/(?:一分钟|1分钟|一分)/, 1],
    ];

    for (const [pattern, val] of zhMap) {
        if (pattern.test(text)) {
            return val;
        }
    }

    return fallback;
}

function isOfflineInviteTerminatedMessage(m: ChatMessage): boolean {
    if (m.mediaType === "offline_invite_cancel") return true;
    if (m.mediaType === "offline_lock" || m.mediaType === "offline_lock_system_notice") return true;
    if (m.mediaType === "offline_invite_system_notice") {
        const text = m.content || "";
        if (
            text.includes("已取消线下邀约提议") ||
            text.includes("已取消本次线下赴约") ||
            text.includes("婉拒") ||
            text.includes("拒绝") ||
            text.includes("本次线下赴约已结束") ||
            text.includes("双方已返回线上")
        ) {
            return true;
        }
    }
    if (m.role === "system" && m.content) {
        const text = m.content;
        if (
            text.includes("已取消线下邀约提议") ||
            text.includes("已取消本次线下赴约") ||
            text.includes("你婉拒了") ||
            text.includes("婉拒了") ||
            text.includes("拒绝了线下") ||
            text.includes("本次线下赴约已结束") ||
            text.includes("双方已返回线上") ||
            text.includes("已暂时关闭线下见面入口") ||
            text.includes("线下见面入口已关闭")
        ) {
            return true;
        }
    }
    return false;
}

function restoreOfflineInviteFromMessages(
    historyMessages: ChatMessage[],
    fallbackInvite?: OfflineInviteData | null,
    targetRetryMsg?: ChatMessage | null
): OfflineInviteData | null {
    if (fallbackInvite?.sourceBatchId === "mock_offline_invite") {
        return fallbackInvite;
    }

    let lastEndNoticeIdxInHistory = -1;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
        const m = historyMessages[i];
        if ((m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && m.content.includes("双方已返回线上"))) {
            lastEndNoticeIdxInHistory = i;
            break;
        }
    }
    const currentRoundFloor = lastEndNoticeIdxInHistory !== -1 ? lastEndNoticeIdxInHistory + 1 : 0;

    // 若未传入 fallbackInvite（如单聊刚导入或无 KV 水合）：自动从历史消息中寻找当前轮次最初发起提议的生命之根
    let baseInvite: OfflineInviteData | null = fallbackInvite ? { ...fallbackInvite } : null;
    let rootMsgIndex = -1;

    // 在 currentRoundFloor 之后的区间内，定位最后一条终结事件（取消/婉拒/关闭）
    let lastTerminationIdxInRound = -1;
    for (let i = historyMessages.length - 1; i >= currentRoundFloor; i--) {
        if (isOfflineInviteTerminatedMessage(historyMessages[i])) {
            lastTerminationIdxInRound = i;
            break;
        }
    }
    const effectiveSearchStart = lastTerminationIdxInRound !== -1 ? lastTerminationIdxInRound + 1 : currentRoundFloor;

    if (baseInvite) {
        const rootId = baseInvite.initialBatchId || baseInvite.sourceBatchId;
        if (rootId) {
            rootMsgIndex = historyMessages.findIndex(m =>
                (m.responseBatchId && m.responseBatchId === rootId) ||
                m.id === rootId ||
                (m.mediaData?.offlineInvite && (m.mediaData.offlineInvite.initialBatchId === rootId || m.mediaData.offlineInvite.sourceBatchId === rootId))
            );
        }
    }

    // 若未传入 baseInvite，或者 baseInvite 携带的根节点在当前轮次有效区间之前（rootMsgIndex < effectiveSearchStart，即属于已被终结的历史旧轮次）：
    // 必须从 effectiveSearchStart 往后重新搜寻当前轮次合法存续的生命之根！
    if (!baseInvite || rootMsgIndex < effectiveSearchStart) {
        let currentRoundRootIndex = -1;
        let currentRoundBase: OfflineInviteData | null = null;

        for (let i = effectiveSearchStart; i < historyMessages.length; i++) {
            const m = historyMessages[i];
            if (m.mediaType === "offline_invite" || m.mediaData?.offlineInvite) {
                const data = m.mediaData?.offlineInvite;
                if (data) {
                    currentRoundRootIndex = i;
                    const isForced = data.theme === "forced" || data.status === "on_the_way";
                    currentRoundBase = {
                        direction: isForced ? "he_comes" : (data.direction || "he_comes"),
                        status: isForced ? "on_the_way" : (data.status === "arrived" ? "arrived" : "pending"),
                        theme: data.theme || (isForced ? "forced" : "default"),
                        place: data.place || "约定地点",
                        reason: data.reason || "",
                        onTheWayMessage: data.onTheWayMessage,
                        transitCardMessage: data.transitCardMessage,
                        arrivedMessage: data.arrivedMessage,
                        arrivalCardMessage: data.arrivalCardMessage,
                        durationMinutes: data.durationMinutes || 15,
                        initialPlace: data.initialPlace || data.place || "你身边",
                        sourceBatchId: m.responseBatchId || data.sourceBatchId || m.id,
                        initialBatchId: m.responseBatchId || data.sourceBatchId || m.id,
                    };
                    break;
                }
            }
        }
        if (!currentRoundBase) {
            // 孤柱支撑兜底：若带结构化数据的节点被删，但历史中仍存有任何关键系统灰字记录（提议/动身/到达/碰面），依然认其为最后的生命之根！
            for (let i = effectiveSearchStart; i < historyMessages.length; i++) {
                const m = historyMessages[i];
                if (m.role === "system" && m.content && (
                    m.content.includes("线下赴约提议") ||
                    m.content.includes("“请求”前往") ||
                    m.content.includes("“邀请你”前往") ||
                    m.content.includes("请求前往") ||
                    m.content.includes("邀请你前往") ||
                    m.content.includes("你已同意赴约") ||
                    m.content.includes("动身赶往") ||
                    m.content.includes("已直接动身") ||
                    m.content.includes("正在重新赶往") ||
                    m.content.includes("赴约地点已更改为") ||
                    m.content.includes("碰头方式已变更为") ||
                    m.content.includes("赴约提议地点已更改为") ||
                    m.content.includes("等候你碰面") ||
                    m.content.includes("已如约到达") ||
                    m.content.includes("已提前到达") ||
                    m.content.includes("就位等候") ||
                    m.content.includes("线下碰面中")
                )) {
                    currentRoundRootIndex = i;
                    const placeMatch = m.content.match(/(?:赴约(?:提议)?地点已更改为|正在动身赶往|前往|正在重新赶往|已(?:提前|如约)?到达|已在)[「"“]([^」"”]+)[」"”]/) ||
                                       m.content.match(/[「"“]([^」"”]+)[」"”]/) ||
                                       m.content.match(/(你身边)/);
                    const parsedPlace = placeMatch?.[1]?.trim() || "约定地点";
                    const isForcedNotice = m.content.includes("已直接动身") || m.content.includes("强行动身");
                    const isAlertNotice = m.content.includes("“请求”前往") || m.content.includes("“邀请你”前往") || m.content.includes("请求前往") || m.content.includes("邀请你前往");
                    const isIGo = !isForcedNotice && (m.content.includes("变更为由你") || m.content.includes("等候你碰面") || m.content.includes("就位等候") || m.content.includes("“邀请你”前往") || m.content.includes("邀请你前往"));
                    currentRoundBase = {
                        direction: isForcedNotice ? "he_comes" : (isIGo ? "i_go" : "he_comes"),
                        status: isForcedNotice ? "on_the_way" : "pending",
                        theme: isForcedNotice ? "forced" : (isAlertNotice ? "alert" : "default"),
                        place: parsedPlace,
                        reason: "",
                        durationMinutes: 15,
                        initialPlace: parsedPlace,
                        sourceBatchId: m.responseBatchId || m.id,
                        initialBatchId: m.responseBatchId || m.id,
                    };
                    break;
                }
            }
        }
        if (!currentRoundBase) {
            return null;
        }

        rootMsgIndex = currentRoundRootIndex;
        if (baseInvite) {
            // 已有 baseInvite 但根属于旧轮次：更新根锚点为当前轮次新根，其余定制数据保留
            baseInvite.initialBatchId = currentRoundBase.initialBatchId;
            baseInvite.sourceBatchId = currentRoundBase.sourceBatchId;
        } else {
            baseInvite = currentRoundBase;
        }
    }

    // 终结事件硬约束：若在发起提议的节点之后出现了取消、婉拒、返回线上或关闭入口等终结事件，
    // 且终止后并未重新发起新的邀约，则本次邀约已彻底终结，绝不可作为活跃邀约恢复！
    // 严防倒流：搜索起始点绝不能小于 effectiveSearchStart，绝不可翻查历史已被覆盖的前朝终结记录！
    const terminationSearchStart = Math.max(effectiveSearchStart, rootMsgIndex >= 0 ? rootMsgIndex + 1 : effectiveSearchStart);
    for (let i = terminationSearchStart; i < historyMessages.length; i++) {
        if (isOfflineInviteTerminatedMessage(historyMessages[i])) {
            return null;
        }
    }

    const rootId = baseInvite.initialBatchId || baseInvite.sourceBatchId;
    const hasRoot = rootId
        ? historyMessages.some(m =>
            (m.responseBatchId && m.responseBatchId === rootId) ||
            m.id === rootId ||
            (baseInvite.relatedBatchIds && m.responseBatchId && baseInvite.relatedBatchIds.includes(m.responseBatchId)) ||
            m.mediaData?.offlineInvite ||
            (m.role === "system" && m.content && (
                m.content.includes("你已同意赴约") ||
                m.content.includes("线下赴约提议") ||
                m.content.includes("正在动身赶往") ||
                m.content.includes("已直接动身") ||
                m.content.includes("前往") ||
                m.content.includes("正在重新赶往") ||
                m.content.includes("赴约地点已更改为") ||
                m.content.includes("已到达") ||
                m.content.includes("已提前到达") ||
                m.content.includes("就位等候")
            ))
          )
        : historyMessages.some(m =>
            m.mediaType === "offline_invite" ||
            m.mediaType === "offline_invite_system_notice" ||
            m.mediaType === "offline_invite_arrive_notice" ||
            m.mediaData?.offlineInvite ||
            (m.role === "system" && m.content && (
                m.content.includes("你已同意赴约") ||
                m.content.includes("线下赴约提议") ||
                m.content.includes("正在动身赶往") ||
                m.content.includes("已直接动身") ||
                m.content.includes("前往") ||
                m.content.includes("正在重新赶往") ||
                m.content.includes("赴约地点已更改为") ||
                m.content.includes("已到达") ||
                m.content.includes("已提前到达") ||
                m.content.includes("就位等候")
            ))
          );

    const hasSystemPillars = historyMessages.some(m =>
        (m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && (
            /向你发起了.*线下(?:赴约|邀约)提议/.test(m.content) ||
            /“请求”前往|“邀请你”前往/.test(m.content) ||
            m.content.includes("线下赴约提议") ||
            m.content.includes("你已同意赴约") ||
            m.content.includes("已直接动身赶往") ||
            m.content.includes("已直接动身") ||
            m.content.includes("强行动身") ||
            m.content.includes("正在动身赶往") ||
            m.content.includes("正在重新赶往") ||
            m.content.includes("赴约地点已更改为") ||
            m.content.includes("碰头方式已变更为") ||
            m.content.includes("赴约提议地点已更改为") ||
            m.content.includes("赴约提议已变更为") ||
            m.content.includes("已如约到达") ||
            m.content.includes("“如约”到达") ||
            m.content.includes("已提前到达") ||
            (m.content.includes("已在") && m.content.includes("就位等候")) ||
            (m.content.includes("双方正在") && m.content.includes("线下碰面中"))
        ))
    );

    if (!hasRoot || !hasSystemPillars) {
        return null;
    }

    let restored: OfflineInviteData = { ...baseInvite };

    // 1. 倒序查找 historyMessages 中最后一条带有碰头地点的变动/邀约消息或系统记录，提取当时的碰头信息
    for (let i = historyMessages.length - 1; i >= 0; i--) {
        const msg = historyMessages[i];
        const data = msg.mediaData?.offlineInvite;
        if (data?.place) {
            restored = {
                ...restored,
                direction: data.direction || baseInvite.direction,
                theme: data.theme || baseInvite.theme || "default",
                place: data.place,
                reason: data.reason || baseInvite.reason,
                onTheWayMessage: data.onTheWayMessage || baseInvite.onTheWayMessage,
                transitCardMessage: data.transitCardMessage || baseInvite.transitCardMessage,
                arrivedMessage: data.arrivedMessage || baseInvite.arrivedMessage,
                arrivalCardMessage: data.arrivalCardMessage || baseInvite.arrivalCardMessage,
                durationMinutes: data.timeStr ? extractDurationMinutes(data.timeStr, baseInvite.durationMinutes || 15) : (data.durationMinutes || baseInvite.durationMinutes),
                sourceBatchId: msg.responseBatchId || data.sourceBatchId || baseInvite.sourceBatchId,
            };
            break;
        }

        // 兜底：从系统小灰字记录中精准提取当时的碰头地点与方向！
        if (msg.role === "system" && msg.content) {
            if (msg.content.includes("变更为由你") || msg.content.includes("等候你碰面") || msg.content.includes("“邀请你”前往") || msg.content.includes("邀请你前往")) {
                restored.direction = "i_go";
            } else if (msg.content.includes("变更为由对方") || msg.content.includes("“请求”前往") || msg.content.includes("请求前往") || msg.content.includes("重新赶往") || msg.content.includes("动身赶往") || msg.content.includes("直接动身") || msg.content.includes("线下赴约提议")) {
                restored.direction = "he_comes";
            }
            const placeMatch = msg.content.match(/(?:赴约(?:提议)?地点已更改为|正在动身赶往|前往|正在重新赶往|已(?:提前|如约)?到达|已在)[「"“]([^」"”]+)[」"”]/) ||
                               msg.content.match(/(?:赴约(?:提议)?地点已更改为|正在动身赶往|前往|正在重新赶往|已(?:提前|如约)?到达|已在)(你身边)/);
            if (placeMatch && placeMatch[1]) {
                restored.place = placeMatch[1].trim();
                break;
            }
        }
    }

    // 卡片台词同步与原版心语继承：历史中曾为该地点生成过心语时优先继承，避免模板化
    let hasCustomTextForPlace = false;
    if (restored.place) {
        for (let i = historyMessages.length - 1; i >= 0; i--) {
            const data = historyMessages[i].mediaData?.offlineInvite;
            if (data?.place === restored.place && (data.transitCardMessage || data.arrivalCardMessage)) {
                if (data.transitCardMessage) restored.transitCardMessage = data.transitCardMessage;
                if (data.arrivalCardMessage) restored.arrivalCardMessage = data.arrivalCardMessage;
                if (data.onTheWayMessage) restored.onTheWayMessage = data.onTheWayMessage;
                if (data.arrivedMessage) restored.arrivedMessage = data.arrivedMessage;
                hasCustomTextForPlace = true;
                break;
            }
        }
    }

    // 若地点发生了回退变动且历史中没有任何专属台词，才使用通用温情文案兜底
    if (!hasCustomTextForPlace && restored.place && baseInvite.place && restored.place !== baseInvite.place) {
        const p = restored.place === "你身边" ? "你身边" : `「${restored.place}」`;
        if (restored.direction === "he_comes") {
            restored.transitCardMessage = `正重新赶往${p}的途中，稍候片刻。`;
            restored.onTheWayMessage = `我正往${p}赶呢，一会儿就到。`;
            restored.arrivedMessage = `我已经到${p}了，在附近等你，不用着急慢慢走。`;
            restored.arrivalCardMessage = `已经赶到${p}了，在安静等候你，慢慢走别急。`;
        } else {
            restored.arrivalCardMessage = `已经在${p}坐下了，不着急慢慢来。`;
            restored.arrivedMessage = `我在${p}等你过来呢。`;
        }
    }

    // 3. 核心因果链修复：状态判定必须以本次邀约根节点之后的事件为准！
    // 坚决杜绝历史上早已结束的旧到达记录污染当前新邀约的在途/待答应状态！
    const searchFloor = Math.max(effectiveSearchStart, rootMsgIndex >= 0 ? rootMsgIndex : effectiveSearchStart);
    let lastArriveIdx = -1;
    for (let i = historyMessages.length - 1; i >= searchFloor; i--) {
        const m = historyMessages[i];
        if (
            (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
            Boolean(m.content && (
                m.content.includes("已提前到达") ||
                m.content.includes("已如约到达") ||
                m.content.includes("“如约”到达") ||
                (m.content.includes("已在") && m.content.includes("就位等候"))
            ))
        ) {
            lastArriveIdx = i;
            break;
        }
    }

    let lastMovingIdx = -1;
    for (let i = historyMessages.length - 1; i >= searchFloor; i--) {
        const m = historyMessages[i];
        if (
            m.mediaType === "offline_invite_change_place" ||
            m.mediaData?.offlineInvite?.status === "on_the_way" ||
            (m.role === "system" && m.content && (
                m.content.includes("正在重新赶往") ||
                m.content.includes("赴约地点已更改为") ||
                m.content.includes("正在动身赶往") ||
                m.content.includes("已直接动身赶往") ||
                m.content.includes("已直接动身") ||
                m.content.includes("你已同意赴约")
            ))
        ) {
            lastMovingIdx = i;
            break;
        }
    }

    const relevantMsgs = searchFloor >= 0 ? historyMessages.slice(searchFloor) : historyMessages;
    const hasAcceptedInHistory = relevantMsgs.some(m =>
        m.role === "system" && m.content && m.content.includes("你已同意赴约")
    );
    // 强制出发判定：若存在用户同意记录则属于约定赴约，非强制；
    // 且必须有真实的动身系统灰字记录作为物理支撑，不能脱离系统灰字悬空存在！
    const hasForcedDeparture = !hasAcceptedInHistory && relevantMsgs.some(m =>
        (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
        m.content && (m.content.includes("已直接动身赶往") || m.content.includes("已直接动身") || m.content.includes("强行动身"))
    );
    const hasDepartedInHistory = hasAcceptedInHistory || hasForcedDeparture;

    // 检查历史中是否存在有效的提议记录（普通提议或紧急提议）：倒序查找以最新提议为准！
    let proposalMsg: ChatMessage | null = null;
    for (let i = relevantMsgs.length - 1; i >= 0; i--) {
        const m = relevantMsgs[i];
        if (
            (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
            m.content && (
                /向你发起了.*线下(?:赴约|邀约)提议/.test(m.content) ||
                /“请求”前往|“邀请你”前往|请求前往|邀请你前往/.test(m.content) ||
                m.content.includes("线下赴约提议")
            )
        ) {
            proposalMsg = m;
            break;
        }
    }
    const hasProposalInHistory = Boolean(proposalMsg);
    const isProposalAlert = Boolean(proposalMsg?.content && /“请求”前往|“邀请你”前往|请求前往|邀请你前往/.test(proposalMsg.content));

    // 到达防重：检查到达记录后是否有明确改地点重新出发的记录
    let hasExplicitReDepartureAfterArrive = false;
    if (lastArriveIdx !== -1) {
        for (let i = lastArriveIdx + 1; i < historyMessages.length; i++) {
            const m = historyMessages[i];
            if (
                m.mediaType === "offline_invite_change_place" ||
                (m.role === "system" && m.content && (
                    m.content.includes("正在重新赶往") ||
                    m.content.includes("赴约地点已更改为")
                ))
            ) {
                hasExplicitReDepartureAfterArrive = true;
                break;
            }
        }
    }

    const isEffectivelyArrived = lastArriveIdx !== -1 && !hasExplicitReDepartureAfterArrive;

    if (isEffectivelyArrived) {
        restored.status = "arrived";
        restored.hasFiredArrivalMessage = true;
        const arriveMsg = historyMessages[lastArriveIdx];
        restored.isEarlyArrived = Boolean(
            arriveMsg.mediaType === "offline_invite_early_arrive" ||
            arriveMsg.mediaData?.offlineInvite?.isEarlyArrived ||
            (arriveMsg.role === "system" && arriveMsg.content && arriveMsg.content.includes("已提前到达"))
        );
        // 用户同意的赴约到达后保持原主题，不转为 forced
        if (hasAcceptedInHistory) {
            restored.theme = (baseInvite?.theme === "forced" ? "default" : baseInvite?.theme) || "default";
        }
    } else {
        restored.isEarlyArrived = false;
        restored.hasFiredArrivalMessage = false;

        if (restored.direction === "i_go") {
            const hasIGoNotice = relevantMsgs.some(m =>
                (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                m.content && (m.content.includes("变更为由你") || m.content.includes("等候你碰面") || m.content.includes("就位等候") || m.content.includes("“邀请你”前往") || m.content.includes("邀请你前往"))
            );
            if (!hasIGoNotice && !hasProposalInHistory) {
                return null;
            }
            restored.status = "pending";
            restored.startTime = undefined;
            const latestExplicitTheme = (restored.theme && restored.theme !== "forced") ? restored.theme : undefined;
            restored.theme = latestExplicitTheme || (isProposalAlert ? "alert" : "default");
        } else if (hasDepartedInHistory && restored.direction === "he_comes") {
            restored.status = "on_the_way";
            if (hasForcedDeparture && !hasAcceptedInHistory) {
                restored.theme = "forced";
            } else if (hasAcceptedInHistory) {
                // 用户同意的赴约严格保持原主题，不转为 forced
                restored.theme = (baseInvite?.theme === "forced" ? "default" : baseInvite?.theme) || "default";
            }
            const duration = restored.durationMinutes || 15;
            let departureIdx = -1;
            for (let i = historyMessages.length - 1; i >= searchFloor; i--) {
                const m = historyMessages[i];
                if (
                    m.role === "system" && m.content && (
                        m.content.includes("你已同意赴约") ||
                        m.content.includes("已直接动身赶往") ||
                        m.content.includes("已直接动身") ||
                        m.content.includes("正在动身赶往")
                    )
                ) {
                    departureIdx = i;
                    break;
                }
            }
            const departureMsg = departureIdx !== -1 ? historyMessages[departureIdx] : null;
            const messagesAfterDeparture = departureIdx !== -1 ? historyMessages.slice(departureIdx + 1) : [];

            // 检查当前历史记录中的在途最新节点
            let latestInTransitSnapshotSecs: number | null = null;
            let latestInTransitSnapshotMins: number | null = null;
            for (let i = historyMessages.length - 1; i >= searchFloor; i--) {
                const m = historyMessages[i];
                if (m.role === "assistant" && (m.mediaData?.inTransitRemainingSeconds || m.mediaData?.inTransitRemainingMinutes)) {
                    latestInTransitSnapshotSecs = m.mediaData.inTransitRemainingSeconds ?? ((m.mediaData.inTransitRemainingMinutes || 15) * 60);
                    latestInTransitSnapshotMins = m.mediaData.inTransitRemainingMinutes || Math.max(1, Math.ceil(latestInTransitSnapshotSecs / 60));
                    break;
                }
            }

            // 计算当前 baseInvite 物理流逝下的剩余秒数
            let currentPhysicsRemainingSecs = 0;
            if (baseInvite?.startTime && baseInvite.durationMinutes) {
                const elapsedSec = Math.floor((Date.now() - baseInvite.startTime) / 1000);
                currentPhysicsRemainingSecs = Math.max(0, (baseInvite.durationMinutes * 60) - elapsedSec);
            }

            const assistantRounds = messagesAfterDeparture.filter(m => m.role === "assistant").length;

            // 若发生时间轮回溯（出发后的回复已被全删、或快照时间明显大于当前物理剩余时间），
            // 则必须打破原有 startTime 锁死，放行进入下方的 4 层回退算法！
            const isRewoundToStart = assistantRounds === 0 && Boolean(baseInvite?.startTime);
            const isRewoundBySnapshot = latestInTransitSnapshotSecs !== null && (latestInTransitSnapshotSecs > currentPhysicsRemainingSecs + 15);

            // 仅在非回溯、时间线自然向前推进的正常同步场景下保持原有物理 startTime，避免微小抖动
            if (!targetRetryMsg && baseInvite?.status === "on_the_way" && baseInvite.startTime && !isRewoundToStart && !isRewoundBySnapshot) {
                restored.startTime = baseInvite.startTime;
                restored.durationMinutes = baseInvite.durationMinutes || duration;
                restored.status = "on_the_way";
                if (hasAcceptedInHistory) {
                    restored.theme = (baseInvite.theme === "forced" ? "default" : baseInvite.theme) || "default";
                }
                return restored;
            }

            // 1. 最高优先：检查目标消息或目标点之前的专属定格时间
            let stampedMsg: ChatMessage | null = null;
            if (targetRetryMsg && targetRetryMsg.role === "assistant" && (targetRetryMsg.mediaData?.inTransitRemainingSeconds || targetRetryMsg.mediaData?.inTransitRemainingMinutes)) {
                stampedMsg = targetRetryMsg;
            }
            if (!stampedMsg) {
                for (let i = historyMessages.length - 1; i >= searchFloor; i--) {
                    const m = historyMessages[i];
                    if (m.role === "assistant" && (m.mediaData?.inTransitRemainingSeconds || m.mediaData?.inTransitRemainingMinutes)) {
                        stampedMsg = m;
                        break;
                    }
                }
            }

            // 若重试目标回复正文中包含明确时间承诺（如“还有8分钟”），以此时间为准计算倒计时
            let speechMins = 0;
            if (targetRetryMsg && targetRetryMsg.role === "assistant") {
                const speechContent = (targetRetryMsg.content || targetRetryMsg.rawResponseText || "").replace(/\[[^\]]+\]/g, "");
                if (/(?:还有|大概|等我|预计|还要|要|约|差不多)\s*[0-9一二三四五六七八九十两半十几多来]+\s*(?:分钟|分|小时)/.test(speechContent)) {
                    speechMins = extractDurationMinutes(speechContent, 0);
                }
            }

            if (speechMins > 0) {
                const targetDuration = Math.max(duration, speechMins);
                restored.durationMinutes = targetDuration;
                const elapsedMs = (targetDuration - speechMins) * 60000;
                restored.startTime = Date.now() - elapsedMs;
                restored.frozenRemainingMinutes = speechMins;
            } else if (stampedMsg && (stampedMsg.mediaData?.inTransitRemainingSeconds || stampedMsg.mediaData?.inTransitRemainingMinutes)) {
                // 命中该轮历史消息定格时间：毫秒级精准断点续存！
                const remSec = stampedMsg.mediaData.inTransitRemainingSeconds ?? ((stampedMsg.mediaData.inTransitRemainingMinutes || 15) * 60);
                const remMins = stampedMsg.mediaData.inTransitRemainingMinutes || Math.max(1, Math.ceil(remSec / 60));
                const targetDuration = Math.max(duration, remMins);
                restored.durationMinutes = targetDuration;
                const elapsedSec = Math.max(0, (targetDuration * 60) - remSec);
                restored.startTime = Date.now() - (elapsedSec * 1000);
                restored.frozenRemainingMinutes = remMins;
            } else {
                // 2. 次高优先：真实物理时间差推算法（检查消息真实创建时间差 createdAt）
                const refMsg = targetRetryMsg || (historyMessages.length > 0 ? historyMessages[historyMessages.length - 1] : null);
                let restoredFromTimestamp = false;
                if (departureMsg && refMsg && departureMsg.createdAt && refMsg.createdAt) {
                    const startMs = new Date(departureMsg.createdAt).getTime();
                    const curMs = new Date(refMsg.createdAt).getTime();
                    const elapsedMs = Math.max(0, curMs - startMs);
                    const totalMs = duration * 60000;
                    if (elapsedMs >= 10000 && elapsedMs < totalMs) {
                        const remMs = Math.max(60000, totalMs - elapsedMs);
                        const remMins = Math.ceil(remMs / 60000);
                        restored.durationMinutes = duration;
                        restored.startTime = Date.now() - (totalMs - remMs);
                        restored.frozenRemainingMinutes = remMins;
                        restoredFromTimestamp = true;
                    }
                }

                if (!restoredFromTimestamp) {
                    // 3. 智能轮次平滑推算（当快速测试物理时间差不明显时，按在途互动轮次平滑递减）
                    const assistantRounds = messagesAfterDeparture.filter(m => m.role === "assistant").length;
                    if (assistantRounds > 0) {
                        const totalExpectedRounds = Math.max(assistantRounds + 1, 4);
                        const progress = Math.min(0.9, assistantRounds / totalExpectedRounds);
                        const estimatedRemMins = Math.max(1, Math.round(duration * (1 - progress)));
                        restored.durationMinutes = duration;
                        restored.startTime = Date.now() - (duration - estimatedRemMins) * 60000;
                        restored.frozenRemainingMinutes = estimatedRemMins;
                    } else {
                        // 4. 起跑线：回溯到了刚动身出发的最初出门点，倒计时满额重新开始！
                        restored.durationMinutes = duration;
                        restored.startTime = Date.now();
                        restored.frozenRemainingMinutes = undefined;
                    }
                }
            }
        } else if (!hasDepartedInHistory && restored.direction === "he_comes") {
            // 他来方向但历史中既无动身也无到达：
            // 必须检查历史中是否存在前置发起的提议记录（向你发起了提议 / “请求”前往）！
            // 若历史中无提议记录（直接发起强行动身、或提议记录已被用户删除、动身是最后支撑的唯一柱子）：
            // 则该赴约连根拔起，直接返回 null！
            if (!hasProposalInHistory) {
                return null;
            }
            // 若历史中依然健存此前发起的前置提议记录：
            // 则动身记录被删后，状态平滑倒带回溯至最初的待答应提议！
            // 且主题严格恢复为前置提议原本的主题（alert 或 default），绝不保留 forced！
            restored.status = "pending";
            restored.startTime = undefined;
            const latestExplicitTheme = (restored.theme && restored.theme !== "forced") ? restored.theme : undefined;
            restored.theme = latestExplicitTheme || (isProposalAlert ? "alert" : "default");
        }
    }

    // 修剪关联节点列表：仅保留依然存在于当前 historyMessages 中的批次 ID
    const historyBatchIds = new Set(historyMessages.map(m => m.responseBatchId).filter(Boolean));
    const validRelated = (baseInvite.relatedBatchIds || []).filter(id => historyBatchIds.has(id));
    restored.relatedBatchIds = validRelated;

    // 红黑强制赴约不变式：仅允许在途与到达状态，禁止待答应或我去状态
    if (restored.theme === "forced") {
        if (restored.direction !== "he_comes" || (restored.status !== "on_the_way" && restored.status !== "arrived")) {
            return null;
        }
    }

    return restored;
}

type ManagedGenerationOptions = {
    history: ChatMessage[];
    errorPrefix?: string;
    onDecline?: () => void | Promise<void>;
    offlineInviteDeclined?: boolean | OfflineInviteDeclineContext;
    returnedFromOffline?: boolean;
    offlineInitiativePrompt?: string;
    isKnockThresholdTriggered?: boolean;
};

const activeGenerationRuns = new Map<string, ActiveGenerationRun>();
const activeOfflineGenerationRuns = new Map<string, Omit<ActiveGenerationRun, "pendingNativeToolCalls">>();

function generationLockKey(sessionId: string): string {
    return GENERATING_PREFIX + sessionId;
}

function setGenerationLock(sessionId: string): void {
    kvSet(generationLockKey(sessionId), JSON.stringify({ startedAt: Date.now() }));
}

function clearGenerationLock(sessionId: string): void {
    kvRemove(generationLockKey(sessionId));
}

function hasActiveGenerationLock(sessionId: string): boolean {
    const key = generationLockKey(sessionId);
    const raw = kvGet(key);
    if (!raw) return false;
    let startedAt = 0;
    try {
        const parsed = JSON.parse(raw);
        startedAt = Number(parsed?.startedAt) || 0;
    } catch {
        startedAt = 0;
    }
    if (!startedAt || Date.now() - startedAt > GENERATING_LOCK_TTL_MS) {
        kvRemove(key);
        return false;
    }
    return true;
}

function createGenerationRun(sessionId: string): ActiveGenerationRun {
    const existing = activeGenerationRuns.get(sessionId);
    existing?.controller.abort();
    const run: ActiveGenerationRun = {
        runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        controller: new AbortController(),
        pendingNativeToolCalls: [],
    };
    activeGenerationRuns.set(sessionId, run);
    return run;
}

function isGenerationRunActive(sessionId: string, runId: string): boolean {
    const run = activeGenerationRuns.get(sessionId);
    return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishGenerationRun(sessionId: string, runId: string): boolean {
    const run = activeGenerationRuns.get(sessionId);
    if (!run || run.runId !== runId) return false;
    activeGenerationRuns.delete(sessionId);
    return true;
}

function trackNativeToolCalls(sessionId: string, runId: string, calls: PendingNativeToolCall[]): void {
    const run = activeGenerationRuns.get(sessionId);
    if (!run || run.runId !== runId) return;
    const existingIds = new Set(run.pendingNativeToolCalls.map(call => call.id));
    for (const call of calls) {
        if (call.id && !existingIds.has(call.id)) {
            run.pendingNativeToolCalls.push(call);
            existingIds.add(call.id);
        }
    }
}

function resolveNativeToolCall(sessionId: string, runId: string, toolCallId: string): void {
    const run = activeGenerationRuns.get(sessionId);
    if (!run || run.runId !== runId) return;
    run.pendingNativeToolCalls = run.pendingNativeToolCalls.filter(call => call.id !== toolCallId);
}

function cancelGenerationRun(sessionId: string): ActiveGenerationRun | null {
    const run = activeGenerationRuns.get(sessionId);
    if (!run) return null;
    run.controller.abort();
    activeGenerationRuns.delete(sessionId);
    return run;
}

function isAbortLikeError(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (error instanceof Error) {
        return error.name === "AbortError" || /aborted|abort/i.test(error.message);
    }
    return false;
}

function throwIfGenerationStopped(guard?: GenerationRunGuard): void {
    throwIfAborted(guard?.signal);
    if (guard?.isActive && !guard.isActive()) {
        throw new DOMException("Aborted", "AbortError");
    }
}

function createOfflineGenerationRun(sessionId: string): Omit<ActiveGenerationRun, "pendingNativeToolCalls"> {
    const existing = activeOfflineGenerationRuns.get(sessionId);
    existing?.controller.abort();
    const run = {
        runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        controller: new AbortController(),
    };
    activeOfflineGenerationRuns.set(sessionId, run);
    return run;
}

function isOfflineGenerationRunActive(sessionId: string, runId: string): boolean {
    const run = activeOfflineGenerationRuns.get(sessionId);
    return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishOfflineGenerationRun(sessionId: string, runId: string): boolean {
    const run = activeOfflineGenerationRuns.get(sessionId);
    if (!run || run.runId !== runId) return false;
    activeOfflineGenerationRuns.delete(sessionId);
    return true;
}

function cancelOfflineGenerationRun(sessionId: string): boolean {
    const run = activeOfflineGenerationRuns.get(sessionId);
    if (!run) return false;
    run.controller.abort();
    activeOfflineGenerationRuns.delete(sessionId);
    return true;
}

// ── Rich media reprocessing on mount ──────────────────────────

const TIME_GAP = 1 * 60 * 1000;

function shouldShowTimestamp(currentMsg: string, prevMsg: string | null): boolean {
    if (!prevMsg) return true; // First message always shows time
    return new Date(currentMsg).getTime() - new Date(prevMsg).getTime() > TIME_GAP;
}

type ChatRoomProps = {
    session: ChatSession;
    onBack: () => void;
    /** 会话在设置页被删除后回调：由外层卸载本聊天室并回到列表 */
    onDeleted?: () => void;
};

type OfflineActionTarget = {
    turnId: string;
    role: "user" | "assistant";
};

type ContextMenuAnchor = {
    x: number;
    y: number;
};

type RenderChatMessage = ChatMessage & {
    displayProjected?: boolean;
    displaySourceId?: string;
};

type ScrollAnchorSnapshot = {
    messageId: string;
    offsetDelta: number;
};

type PendingMessageJump = {
    messageId: string;
    fallbackMessageId?: string;
};

const TRANSIENT_MESSAGE_PREFIX = "ui-transient-";
type RichModalKind = "photo" | "text_photo" | "red_packet" | "transfer" | "location" | "transfer_target" | "voice_msg" | "gift" | "system_instruction";
type ChatTextInputHandle = {
    appendText: (text: string, options?: { focus?: boolean }) => void;
    clear: () => void;
};
type OfflineTextInputHandle = {
    clear: () => void;
    setText: (text: string) => void;
    restoreIfEmpty: (text: string) => void;
};

function isTransientMessage(msg: Pick<ChatMessage, "id"> | string): boolean {
    return (typeof msg === "string" ? msg : msg.id).startsWith(TRANSIENT_MESSAGE_PREFIX);
}

function copyTextToClipboard(text: string): void {
    const fallbackCopy = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand("copy"); } catch {}
        document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(fallbackCopy);
    } else {
        fallbackCopy();
    }
}

function MemoryWriteRequestCard({
    msg,
    onApprove,
    onIgnore,
}: {
    msg: ChatMessage;
    onApprove: (msg: ChatMessage) => void | Promise<void>;
    onIgnore: (msg: ChatMessage) => void;
}) {
    const status = msg.mediaData?.memoryRequestStatus || "pending";
    const content = msg.mediaData?.memoryContent || msg.content;
    const reason = msg.mediaData?.memoryReason;
    const importance = msg.mediaData?.memoryImportance;
    const statusText = status === "approved" ? "已写入长期记忆" : status === "ignored" ? "已忽略本次写入" : "等待你确认";

    return (
        <div className="w-[280px] rounded-2xl border border-[var(--c-border)] bg-[var(--c-card)]/95 backdrop-blur px-4 py-3 flex flex-col gap-3 ui-bubble-shadow">
            <div className="flex items-center justify-between gap-3">
                <span className="menu-label">对方想记住这件事</span>
                <span className="menu-desc !mt-0 shrink-0">{statusText}</span>
            </div>
            <div className="rounded-xl bg-[var(--c-input)]/70 px-3 py-2">
                <p className="menu-desc !mt-0 leading-6 whitespace-pre-wrap">{content}</p>
            </div>
            {(reason || typeof importance === "number") && (
                <div className="flex flex-col gap-1">
                    {reason && <span className="menu-desc !mt-0">原因：{reason}</span>}
                    {typeof importance === "number" && <span className="menu-desc !mt-0">重要性：{importance.toFixed(2)}</span>}
                </div>
            )}
            {status === "pending" ? (
                <div className="flex gap-2">
                    <button onClick={() => void onApprove(msg)} className="ui-btn ui-btn-primary flex-1">确认写入</button>
                    <button onClick={() => onIgnore(msg)} className="ui-btn ui-btn-outline flex-1">忽略</button>
                </div>
            ) : null}
        </div>
    );
}

function SystemInstructionCard({ content }: { content: string }) {
    return (
        <>
            <div className="chat-system-instruction-head">
                <span className="chat-system-instruction-title">系统指令</span>
            </div>
            <div className="chat-system-instruction-body">{content}</div>
        </>
    );
}

type CustomChatPlusPresentation = "panel" | "modal" | "fullscreen" | "none";

type ActiveCustomChatPlus = {
    app: InstalledCustomApp;
    action: RegisteredCustomAppChatPlusAction;
    presentation: Exclude<CustomChatPlusPresentation, "fullscreen">;
    launchContext: Record<string, unknown>;
};

function getCustomChatPlusPresentation(action: RegisteredCustomAppChatPlusAction): CustomChatPlusPresentation {
    if (action.presentation === "fullscreen" || action.presentation === "app") return "fullscreen";
    if (action.presentation === "modal") return "modal";
    if (action.presentation === "none") return "none";
    return "panel";
}

function normalizeCustomPanelHeight(value: unknown): string | undefined {
    const text = String(value ?? "").trim();
    if (!text) return undefined;
    if (/^\d{2,3}$/.test(text)) return `${Math.max(220, Math.min(680, Number(text)))}px`;
    if (/^\d{2,3}px$/.test(text)) return text;
    if (/^\d{2,3}vh$/.test(text)) return text;
    if (/^calc\([^)]+\)$/.test(text)) return text;
    return undefined;
}

const ChatTextInputBar = memo(forwardRef<ChatTextInputHandle, {
    characterName: string;
    characterId: string;
    stickerCharacterIds?: string[];
    isGroup: boolean;
    isSpectator: boolean;
    muteUntilMs: number;
    isGenerating: boolean;
    theaterMode: boolean;
    enterToSendEnabled: boolean;
    quotingMessage: ChatMessage | null;
    showEmojiPanel: boolean;
    showStickerPanel: boolean;
    showPlusMenu: boolean;
    customPlusActions: RegisteredCustomAppChatPlusAction[];
    onClearQuote: () => void;
    onToggleOfflineMode: () => void;
    onClosePanels: () => void;
    onToggleEmojiPanel: () => void;
    onToggleStickerPanel: () => void;
    onTogglePlusMenu: () => void;
    onToggleTheaterMode: () => void;
    onCloseTheaterMode: () => void;
    onOpenRichModal: (modal: RichModalKind) => void;
    onOpenCustomPlusAction: (action: RegisteredCustomAppChatPlusAction) => void;
    onStartVideoCall: () => void;
    onStartVoiceCall: () => void;
    onSendText: (text: string, options?: { autoReply?: boolean }) => boolean;
    onStopGeneration: () => void;
    onTriggerAIResponse: () => void;
	onSendSticker: (name: string, url?: string) => void;
    offlineMeetingActive?: boolean;
}>(function ChatTextInputBar({
    characterName,
    characterId,
    stickerCharacterIds,
    isGroup,
    isSpectator,
    muteUntilMs,
    isGenerating,
    theaterMode,
    enterToSendEnabled,
    quotingMessage,
    showEmojiPanel,
    showStickerPanel,
    showPlusMenu,
    customPlusActions,
    onClearQuote,
    onToggleOfflineMode,
    onClosePanels,
    onToggleEmojiPanel,
    onToggleStickerPanel,
    onTogglePlusMenu,
    onToggleTheaterMode,
    onCloseTheaterMode,
    onOpenRichModal,
    onOpenCustomPlusAction,
    onStartVideoCall,
    onStartVoiceCall,
    onSendText,
    onStopGeneration,
    onTriggerAIResponse,
    onSendSticker,
    offlineMeetingActive,
}, ref) {
    const [inputText, setInputText] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // 表情包搜索联想：ESC/失焦置 true 隐藏，输入变化重新开启
    const [suggestClosed, setSuggestClosed] = useState(false);
    // 围观群/被禁言：输入与富媒体入口全部锁定，只留线下切换和生成按钮
    const [muteNowTick, setMuteNowTick] = useState(() => Date.now());
    useEffect(() => {
        if (!muteUntilMs || muteUntilMs <= Date.now()) return;
        const timer = window.setInterval(() => setMuteNowTick(Date.now()), 30000);
        return () => window.clearInterval(timer);
    }, [muteUntilMs]);
    const muteRemainingMs = muteUntilMs > muteNowTick ? muteUntilMs - muteNowTick : 0;
    const inputLocked = isSpectator || muteRemainingMs > 0;

    const resetTextareaHeight = () => {
        if (textareaRef.current) textareaRef.current.style.height = "auto";
    };

    const appendText = useCallback((text: string, options?: { focus?: boolean }) => {
        setInputText(prev => prev + text);
        requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (!ta) return;
            ta.style.height = "auto";
            ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
            if (options?.focus !== false) ta.focus();
        });
    }, []);

    useImperativeHandle(ref, () => ({
        appendText,
        clear: () => {
            setInputText("");
            resetTextareaHeight();
        },
    }), [appendText]);

    const handleSubmit = () => {
        if (inputLocked) return;
        if (isGenerating) {
            onStopGeneration();
            return;
        }
        const trimmed = inputText.trim();
        if (!trimmed) return;
        if (!onSendText(trimmed)) return;
        setInputText("");
        resetTextareaHeight();
        onClosePanels();
    };

    const panelOpen = showEmojiPanel || showStickerPanel || showPlusMenu;
    const suggestCharacterIds = useMemo(
        () => (isGroup ? (stickerCharacterIds || []) : characterId ? [characterId] : []),
        [isGroup, stickerCharacterIds, characterId],
    );
    const suggestEnabled = !inputLocked && !panelOpen && !suggestClosed && inputText.trim().length > 0;
    const plusMenuItems = [
        { icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg>, label: "照片墙", onClick: () => onOpenRichModal("photo") },
        { icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="7" y1="8" x2="17" y2="8" /><line x1="7" y1="12" x2="14" y2="12" /><line x1="7" y1="16" x2="11" y2="16" /></svg>, label: "文字图片", onClick: () => onOpenRichModal("text_photo") },
        { icon: <AlertCircle size={22} strokeWidth={1.5} color="var(--c-text)" />, label: "系统指令", onClick: () => onOpenRichModal("system_instruction") },
        { icon: <Clapperboard size={22} strokeWidth={1.5} color={theaterMode ? "var(--c-icon-active)" : "var(--c-text)"} />, label: "番外指令模式", active: theaterMode, onClick: onToggleTheaterMode },
        { icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>, label: "视频通话", onClick: onStartVideoCall },
        { icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /></svg>, label: "语音通话", onClick: onStartVoiceCall },
        { icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>, label: "红包", onClick: () => onOpenRichModal("red_packet") },
        { icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><text x="12" y="16" textAnchor="middle" fontSize="12" fill="var(--c-text)" stroke="none">¥</text></svg>, label: "转账", onClick: () => onOpenRichModal(isGroup ? "transfer_target" : "transfer") },
        { icon: <Gift size={22} strokeWidth={1.5} color="var(--c-text)" />, label: "礼物", onClick: () => onOpenRichModal("gift") },
        { icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>, label: "位置", onClick: () => onOpenRichModal("location") },
        { icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></svg>, label: "语音条", onClick: () => onOpenRichModal("voice_msg") },
        ...customPlusActions.map(action => ({
            icon: action.appIconDataUrl
                ? <span className="chat-plus-custom-app-icon" style={{ backgroundImage: `url(${action.appIconDataUrl})` }} aria-hidden="true" />
                : <Blocks size={22} strokeWidth={1.5} color="var(--c-text)" />,
            label: action.label,
            onClick: () => onOpenCustomPlusAction(action),
        })),
    ];

    return (
        <div className="chat-input-bar chat-room-main-pane flex flex-col" data-ui="input">
            {theaterMode && (
                <div className="chat-theater-mode-strip" role="status">
                    <span className="chat-theater-mode-icon" aria-hidden="true">
                        <Clapperboard size={16} strokeWidth={1.8} />
                    </span>
                    <span className="chat-theater-mode-title">番外指令模式</span>
                    <button
                        type="button"
                        className="chat-theater-mode-close"
                        onClick={onCloseTheaterMode}
                        aria-label="关闭番外指令模式"
                        title="关闭番外指令模式"
                    >
                        <X size={14} strokeWidth={2} />
                    </button>
                </div>
            )}
            {quotingMessage && (
                <div className="chat-quote-bar">
                    <div className="flex-1 ts-12 text-[var(--c-icon)] overflow-hidden text-ellipsis whitespace-nowrap">
                        引用 {quotingMessage.role === "user" ? "你" : characterName}: {quotingMessage.content.slice(0, 40)}
                    </div>
                    <button onClick={onClearQuote} className="ui-bare-btn text-[var(--c-icon)] ts-16 leading-none p-[2px]">✕</button>
                </div>
            )}

            {suggestEnabled && (
                <StickerSearchSuggest
                    query={inputText}
                    characterIds={suggestCharacterIds}
                    onSend={(name, url) => {
                        onSendSticker(name, url);
                        setInputText("");
                        resetTextareaHeight();
                    }}
                    onClose={() => setSuggestClosed(true)}
                />
            )}
            <textarea
                ref={textareaRef}
                rows={1}
                value={inputText}
                onChange={e => {
                    setInputText(e.target.value);
                    setSuggestClosed(false);
                    e.target.style.height = "auto";
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                }}
                onFocus={(e) => {
                    if (panelOpen) {
                        e.target.blur();
                        onClosePanels();
                        const target = e.target as HTMLTextAreaElement;
                        requestAnimationFrame(() => requestAnimationFrame(() => target.focus()));
                    }
                    setSuggestClosed(false);
                }}
                onBlur={() => setSuggestClosed(true)}
                onKeyDown={e => {
                    if (e.key === "Escape") {
                        setSuggestClosed(true);
                        return;
                    }
                    if (shouldSendChatInputOnEnter(e, enterToSendEnabled)) {
                        e.preventDefault();
                        handleSubmit();
                    }
                }}
                enterKeyHint={enterToSendEnabled ? "send" : "enter"}
                className="chat-input-textarea"
                disabled={inputLocked}
                placeholder={inputLocked
                    ? (isSpectator ? "围观中，你不在这个群里" : `禁言中，剩余${Math.ceil(muteRemainingMs / 60000)}分钟`)
                    : (theaterMode ? "写下番外指令..." : (offlineMeetingActive ? "对方就在你身边呢…（可发悄悄话或打个招呼）" : undefined))}
            />

            <div className="chat-input-actions">
                <button
                    onClick={onToggleOfflineMode}
                    className="ui-bare-btn text-[var(--c-text)] chat-offline-toggle"
                    aria-label="线下模式"
                    title="线下模式"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0Z" />
                        <circle cx="12" cy="10" r="3" />
                    </svg>
                </button>
                <button onClick={onToggleEmojiPanel} disabled={inputLocked} className="ui-bare-btn text-[var(--c-text)]" style={inputLocked ? { opacity: 0.35 } : undefined}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
                </button>
                <button onClick={onToggleStickerPanel} disabled={inputLocked} className="ui-bare-btn text-[var(--c-text)]" style={inputLocked ? { opacity: 0.35 } : undefined}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" /><polyline points="14 3 14 8 21 8" /><path d="M8 13h0" /><path d="M16 13h0" /><path d="M10 17c.5.3 1.2.5 2 .5s1.5-.2 2-.5" /></svg>
                </button>
                <button onClick={onTogglePlusMenu} disabled={inputLocked} className="ui-bare-btn text-[var(--c-text)]" style={inputLocked ? { opacity: 0.35 } : undefined}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
                </button>
                <button
                    onClick={handleSubmit}
                    disabled={!isGenerating && (inputLocked || !inputText.trim())}
                    style={inputLocked && !isGenerating ? { opacity: 0.35 } : undefined}
                    className="ui-bare-btn text-[var(--c-text)]"
                    aria-label={isGenerating ? "停止本轮生成" : "发送"}
                    title={isGenerating ? "停止本轮生成" : "发送"}
                >
                    {isGenerating ? (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="10" />
                            <rect x="9" y="9" width="6" height="6" rx="1" />
                        </svg>
                    ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
                    )}
                </button>
                {!isGenerating && (
                    <button
                        className="ui-bare-btn text-[var(--c-text)]"
                        title={!inputLocked && inputText.trim() ? "发送输入框内容并触发回复" : "触发 AI 主动回复"}
                        onClick={() => {
                            const trimmed = inputText.trim();
                            // 输入框已有文字：发送输入框内容并立即触发模型回复（一次按键完成），
                            // 避免「打完字却忘记发送」；没文字时才只触发 AI 主动回复
                            if (!inputLocked && trimmed) {
                                if (!onSendText(trimmed, { autoReply: true })) return;
                                setInputText("");
                                resetTextareaHeight();
                            } else {
                                onTriggerAIResponse();
                            }
                            onClosePanels();
                        }}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .963L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                            <path d="M20 3v4" /><path d="M22 5h-4" />
                        </svg>
                    </button>
                )}
            </div>

            {showPlusMenu && (
                <div className="chat-plus-menu">
                    {plusMenuItems.map((item, i) => (
                        <div key={`${item.label}-${i}`} onClick={item.onClick} className="chat-plus-menu-item flex flex-col items-center gap-1.5 cursor-pointer" {...(item.active ? { "data-active": "" } : {})}>
                            <div className="chat-plus-icon-box">
                                {item.icon}
                            </div>
                            <span className="ts-11 text-[var(--c-text)]">{item.label}</span>
                        </div>
                    ))}
                </div>
            )}
            {showPlusMenu && (
                <ChatPluginSlot name="chat.inputToolbar" slotProps={{ isGroup }} className="chat-plugin-input-toolbar" />
            )}

            {showEmojiPanel && (
                <EmojiPanel
                    onSelect={(emoji) => appendText(emoji, { focus: false })}
                    onEffectSend={(text) => {
                        if (inputLocked || isGenerating) return;
                        onSendText(text);
                        onClosePanels();
                    }}
                />
            )}

            {showStickerPanel && (
                <StickerPanel
                    onSend={onSendSticker}
                    characterId={characterId}
                    characterIds={stickerCharacterIds}
                />
            )}
        </div>
    );
}));

const OfflineTextInputBar = memo(forwardRef<OfflineTextInputHandle, {
    isOfflineGenerating: boolean;
    isSpectator: boolean;
    showEmojiPanel: boolean;
    enterToSendEnabled: boolean;
    onToggleOfflineMode: () => void;
    onCloseEmojiPanel: () => void;
    onToggleEmojiPanel: () => void;
    onSendText: (text: string) => boolean;
    onStopGeneration: () => void;
}>(function OfflineTextInputBar({
    isOfflineGenerating,
    isSpectator,
    showEmojiPanel,
    enterToSendEnabled,
    onToggleOfflineMode,
    onCloseEmojiPanel,
    onToggleEmojiPanel,
    onSendText,
    onStopGeneration,
}, ref) {
    const [inputText, setInputText] = useState("");
    const inputTextRef = useRef("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    const resetTextareaHeight = () => {
        if (textareaRef.current) textareaRef.current.style.height = "auto";
    };

    const resizeTextarea = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    }, []);

    const setTextAndResize = useCallback((text: string) => {
        inputTextRef.current = text;
        setInputText(text);
        requestAnimationFrame(resizeTextarea);
    }, [resizeTextarea]);

    const appendText = useCallback((text: string, options?: { focus?: boolean }) => {
        const nextText = inputTextRef.current + text;
        inputTextRef.current = nextText;
        setInputText(nextText);
        requestAnimationFrame(() => {
            resizeTextarea();
            if (options?.focus !== false) textareaRef.current?.focus();
        });
    }, [resizeTextarea]);

    useImperativeHandle(ref, () => ({
        clear: () => {
            inputTextRef.current = "";
            setInputText("");
            resetTextareaHeight();
        },
        setText: setTextAndResize,
        restoreIfEmpty: (text: string) => {
            if (inputTextRef.current.trim()) return;
            setTextAndResize(text);
        },
    }), [setTextAndResize]);

    const handleSubmit = () => {
        if (isOfflineGenerating) {
            onSendText(inputTextRef.current);
            return;
        }
        const trimmed = inputTextRef.current.trim();
        if (!trimmed && !isSpectator) return;
        if (!onSendText(trimmed)) return;
        inputTextRef.current = "";
        setInputText("");
        resetTextareaHeight();
    };

    return (
        <div className="chat-input-bar chat-room-main-pane flex flex-col" data-ui="input">
            <textarea
                ref={textareaRef}
                rows={1}
                value={inputText}
                onChange={e => {
                    inputTextRef.current = e.target.value;
                    setInputText(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                }}
                onFocus={(e) => {
                    if (showEmojiPanel) {
                        e.target.blur();
                        onCloseEmojiPanel();
                        const target = e.target as HTMLTextAreaElement;
                        requestAnimationFrame(() => requestAnimationFrame(() => target.focus()));
                    }
                }}
                onKeyDown={e => {
                    if (shouldSendChatInputOnEnter(e, enterToSendEnabled)) {
                        e.preventDefault();
                        handleSubmit();
                    }
                }}
                enterKeyHint={enterToSendEnabled ? "send" : "enter"}
                className="chat-input-textarea"
                disabled={isSpectator}
                placeholder={isSpectator ? "围观中，点右侧按钮推进他们的线下互动" : undefined}
            />
            <div className="chat-input-actions">
                <button
                    type="button"
                    onClick={onToggleOfflineMode}
                    disabled={isOfflineGenerating}
                    className="ui-bare-btn text-[var(--c-text)]"
                    aria-label="返回线上模式"
                    title="返回线上模式"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
                        <path d="M8 9h8" />
                        <path d="M8 13h5" />
                    </svg>
                </button>
                <button
                    onClick={onToggleEmojiPanel}
                    disabled={isSpectator}
                    className="ui-bare-btn text-[var(--c-text)]"
                    style={isSpectator ? { opacity: 0.35 } : undefined}
                    aria-label="表情"
                    title="表情"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
                </button>
                <button
                    type="button"
                    onClick={() => { if (isOfflineGenerating) onStopGeneration(); else handleSubmit(); }}
                    disabled={!isOfflineGenerating && !isSpectator && !inputText.trim()}
                    className="ui-bare-btn text-[var(--c-text)]"
                    aria-label={isOfflineGenerating ? "停止线下生成" : "发送"}
                    title={isOfflineGenerating ? "停止线下生成" : "发送"}
                >
                    {isOfflineGenerating ? (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="10" />
                            <rect x="9" y="9" width="6" height="6" rx="1" />
                        </svg>
                    ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
                    )}
                </button>
            </div>
            {showEmojiPanel && (
                <EmojiPanel onSelect={(emoji) => appendText(emoji, { focus: false })} />
            )}
        </div>
    );
}));

export function ChatRoom({ session, onBack, onDeleted }: ChatRoomProps) {
    const [liveCSS, setLiveCSS] = useState(session.customCSS || "");
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [transientMessages, setTransientMessages] = useState<ChatMessage[]>([]);
    const [stickerReady, setStickerReady] = useState(false);
    const [character, setCharacter] = useState<Character | null>(() => {
        const chars = loadCharacters();
        return chars.find(c => c.id === session.contactId) || null;
    });
    const [isGenerating, setIsGenerating] = useState(false);
    const [offlineMode, setOfflineMode] = useState(false);
    const [theaterMode, setTheaterMode] = useState(() => kvGet(CHAT_THEATER_MODE_PREFIX + session.id) === "1");
    const [offlineTurns, setOfflineTurns] = useState<ChatOfflineTurn[]>([]);
    const [offlineVisibleCount, setOfflineVisibleCount] = useState(OFFLINE_INITIAL_LOAD);
    const [pendingOfflineUserText, setPendingOfflineUserText] = useState("");
    const [isOfflineGenerating, setIsOfflineGenerating] = useState(false);
    const [activeOfflineInvite, setActiveOfflineInvite] = useState<OfflineInviteData | null>(() => {
        if (!session.enableOfflineInvite || session.isGroup) return null;
        try {
            const raw = kvGet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id);
            if (!raw) {
                // 兼容数据备份恢复/跨端导入场景：
                // 1. 若聊天历史中存在未被终结的碰面中节点，自动恢复面对面碰面状态！
                const currentMsgs = loadChatMessages(session.id);
                let lastEndNoticeIdx = -1;
                for (let i = currentMsgs.length - 1; i >= 0; i--) {
                    const m = currentMsgs[i];
                    if ((m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && m.content.includes("双方已返回线上"))) {
                        lastEndNoticeIdx = i;
                        break;
                    }
                }
                let hasActiveMeetingNotice = false;
                let meetingThemeFromNotice: string | undefined;
                for (let i = currentMsgs.length - 1; i > lastEndNoticeIdx; i--) {
                    const m = currentMsgs[i];
                    if ((m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && m.content.includes("线下碰面中"))) {
                        hasActiveMeetingNotice = true;
                        meetingThemeFromNotice = m.mediaData?.offlineInvite?.theme;
                        break;
                    }
                }
                if (hasActiveMeetingNotice) {
                    kvSet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id, "1");
                    if (meetingThemeFromNotice) {
                        kvSet(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id, meetingThemeFromNotice);
                    }
                    return null;
                }

                // 2. 若无碰面中记录但存在未完结的在途/到达节点，自动从消息水合（Auto-hydrate）恢复线上卡片！
                if (currentMsgs.length > 0) {
                    const hydrated = restoreOfflineInviteFromMessages(currentMsgs, null);
                    if (hydrated) {
                        kvSet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id, JSON.stringify(hydrated));
                        return hydrated;
                    }
                }
                return null;
            }
            const parsed: OfflineInviteData = JSON.parse(raw);
            const currentMsgs = loadChatMessages(session.id);
            // 若触发邀约的发起消息已不存在，清理悬空胶囊
            const rootId = parsed.initialBatchId || parsed.sourceBatchId;
            if (rootId === "mock_offline_invite") {
                return parsed;
            }
            const hasRoot = currentMsgs.some(m =>
                (rootId && (m.responseBatchId === rootId || m.id === rootId)) ||
                (parsed.relatedBatchIds && m.responseBatchId && parsed.relatedBatchIds.includes(m.responseBatchId)) ||
                m.mediaData?.offlineInvite ||
                (m.role === "system" && m.content && (
                    m.content.includes("你已同意赴约") ||
                    m.content.includes("线下赴约提议") ||
                    m.content.includes("正在动身赶往") ||
                    m.content.includes("前往") ||
                    m.content.includes("正在重新赶往") ||
                    m.content.includes("已到达") ||
                    m.content.includes("已提前到达") ||
                    m.content.includes("就位等候") ||
                    m.content.includes("线下碰面中")
                ))
            );
            if (!hasRoot) {
                kvRemove(ACTIVE_OFFLINE_INVITE_PREFIX + session.id);
                return null;
            }
            // 终结事件校验：若历史消息显示该邀约已被取消/婉拒/终结，彻底清除 KV 残留，坚决杜绝幽灵胶囊！
            const validated = restoreOfflineInviteFromMessages(currentMsgs, parsed);
            if (!validated) {
                // 自愈兜底：若带 parsed 校验未通过，尝试以干净消息流自愈推导，防止陈旧 rootId 误清空合法邀约
                const selfHealed = restoreOfflineInviteFromMessages(currentMsgs, null);
                if (selfHealed) {
                    kvSet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id, JSON.stringify(selfHealed));
                    return selfHealed;
                }
                kvRemove(ACTIVE_OFFLINE_INVITE_PREFIX + session.id);
                return null;
            }
            // 若历史中存在同意记录，保持 alert 主题避免被误判为 forced
            const hasAccepted = currentMsgs.some(m => m.role === "system" && m.content && m.content.includes("你已同意赴约"));
            if (hasAccepted && parsed.theme === "forced") {
                parsed.theme = "alert";
                kvSet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id, JSON.stringify(parsed));
            }
            // 到达防重：若历史中存在本次行程到达记录且未改地点，锁定为 arrived 并标记已到达
            const tripStartTime = parsed.startTime || 0;
            const hasArriveNoticeInHistory = currentMsgs.some(m => {
                const msgTime = m.createdAt ? new Date(m.createdAt).getTime() : 0;
                // 核心防御：必须发生在本次动身出发之后（容差 2 秒），绝不可把历史旧赴约的到达记录误当成这次的！
                if (tripStartTime > 0 && msgTime < tripStartTime - 2000) {
                    return false;
                }
                return (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                    Boolean(m.content && (
                        m.content.includes("已如约到达") ||
                        m.content.includes("已提前到达") ||
                        m.content.includes("“如约”到达") ||
                        (m.content.includes("已在") && m.content.includes("就位等候"))
                    ));
            });
            if (hasArriveNoticeInHistory) {
                let hasReDepart = false;
                for (let i = currentMsgs.length - 1; i >= 0; i--) {
                    const m = currentMsgs[i];
                    const msgTime = m.createdAt ? new Date(m.createdAt).getTime() : 0;
                    if (tripStartTime > 0 && msgTime < tripStartTime - 2000) {
                        break;
                    }
                    if ((m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && (m.content.includes("已如约到达") || m.content.includes("已提前到达") || m.content.includes("“如约”到达") || (m.content.includes("已在") && m.content.includes("就位等候"))))) {
                        break;
                    }
                    if (m.mediaType === "offline_invite_change_place" || (m.role === "system" && m.content && (m.content.includes("正在重新赶往") || m.content.includes("赴约地点已更改为")))) {
                        hasReDepart = true;
                        break;
                    }
                }
                if (!hasReDepart) {
                    parsed.status = "arrived";
                    parsed.hasFiredArrivalMessage = true;
                    kvSet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id, JSON.stringify(parsed));
                }
            } else {
                if (parsed.status === "on_the_way" || parsed.status === "pending") {
                    parsed.hasFiredArrivalMessage = false;
                }
            }
            return parsed;
        } catch {
            return null;
        }
    });
    const activeOfflineInviteRef = useRef<OfflineInviteData | null>(activeOfflineInvite);
    activeOfflineInviteRef.current = activeOfflineInvite;

    const [isOfflineInviteMinimized, setIsOfflineInviteMinimized] = useState(() => {
        if (!session.enableOfflineInvite || session.isGroup) return false;
        try {
            const raw = kvGet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id);
            if (raw) {
                const parsed: OfflineInviteData = JSON.parse(raw);
                return parsed.status === "on_the_way";
            }
        } catch {}
        return false;
    });
    // 重试等待生成期间，顶栏胶囊显示回溯中状态
    const [isRetryingOffline, setIsRetryingOffline] = useState(false);
    const [showConfirmExitOfflineInvite, setShowConfirmExitOfflineInvite] = useState(false);
    // 线下封禁状态：角色封死了线下入口，用户敲门 N 次才触发角色主动回应
    const [offlineLockData, setOfflineLockData] = useState<OfflineLockData | null>(() => {
        if (typeof window === "undefined") return null;
        try {
            const raw = kvGet(OFFLINE_LOCK_PREFIX + session.id);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as OfflineLockData;
            return parsed.isLocked ? parsed : null;
        } catch { return null; }
    });
    const offlineLockDataRef = useRef<OfflineLockData | null>(offlineLockData);
    useEffect(() => {
        offlineLockDataRef.current = offlineLockData;
    }, [offlineLockData]);
    // 线下封禁弹窗显示状态
    const [showOfflineLockPopup, setShowOfflineLockPopup] = useState(false);
    // 角色解除线下封禁后的前往线下确认弹窗
    const [showOfflineUnlockedConfirmModal, setShowOfflineUnlockedConfirmModal] = useState(false);
    // 敲门达到阈值标记：在用户关闭弹窗后再触发角色主动回应，保证弹窗期间不抢跑
    const pendingKnockTriggerRef = useRef(false);
    // 再次申请线下按钮的防连点节流冷却
    const [isReapplyingLock, setIsReapplyingLock] = useState(false);
    // 独立申请中弹窗状态（持续 1500ms）
    const [showOfflineApplyingPopup, setShowOfflineApplyingPopup] = useState(false);
    // 轻敲锁显现小圆点状态（持续 2000ms 后自动隐藏）
    const [showLockDotsHint, setShowLockDotsHint] = useState(false);
    const lockDotsTimerRef = useRef<NodeJS.Timeout | null>(null);
    // 删除邀约/赴约消息前弹窗确认，提示将同时取消相关赴约状态
    const [pendingInviteDeleteConfirm, setPendingInviteDeleteConfirm] = useState<{
        title: string;
        message: string | React.ReactNode;
        confirmLabel?: string;
        cancelLabel?: string;
        variant?: "danger" | "action" | "default";
        hideCancel?: boolean;
        onConfirm: () => void;
    } | null>(null);

    // 线下赴约进行时回溯重试确认弹窗状态
    const [offlineRetryConfirm, setOfflineRetryConfirm] = useState<{
        msgId: string;
        targetMsg: ChatMessage;
        msgIndex: number;
        truncatedMessages: ChatMessage[];
        truncatesInitialRoot: boolean;
        contextMessages: ChatMessage[];
    } | null>(null);

    // 邀约消息节点判定（发起根节点与关联变动节点）
    const isOfflineInviteRootMessage = useCallback((msg: ChatMessage) => {
        const invite = activeOfflineInviteRef.current;
        const isMeetingActive = !session.isGroup && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1";
        // 处于线下碰面进行中时，仍需识别并保护邀约发起根或变动节点
        if (!invite && !isMeetingActive) return false;
        if (invite?.sourceBatchId === "mock_offline_invite") return false;
        const rootId = invite?.initialBatchId || invite?.sourceBatchId;
        if (rootId && msg.responseBatchId === rootId) {
            return true;
        }
        if (invite?.relatedBatchIds && msg.responseBatchId && invite.relatedBatchIds.includes(msg.responseBatchId)) {
            return true;
        }
        return Boolean(
            msg.mediaType === "offline_invite" ||
            msg.mediaType === "offline_invite_early_arrive" ||
            msg.mediaType === "offline_invite_change_place" ||
            msg.mediaType === "offline_invite_arrive_notice" ||
            msg.mediaData?.offlineInvite
        );
    }, [session.id, session.isGroup]);

    // 线下赴约专属系统小灰字记录判定（防误触保护）
    const isOfflineInviteSystemMessage = useCallback((msg: ChatMessage) => {
        if (msg.role !== "system") return false;
        if (msg.mediaType === "offline_invite_system_notice") return true;
        const text = msg.content || "";
        return /(?:向你发起了.*线下(?:赴约|邀约)提议|“请求”前往|“邀请你”前往|你已同意赴约|双方正在.*线下碰面中|赴约地点已更改为|赴约地点已变更为|赴约提议地点已更改为|赴约提议已变更为|碰头方式已变更为|已得知新地点，正在重新赶往|已直接动身赶往|已直接动身|正在动身赶往|已如约到达|已[“"”']如约[“"”']到达|已提前到达|已在.*就位等候|你婉拒了.*线下(?:赴约|邀约)提议|婉拒了.*线下(?:赴约|邀约)提议|已取消线下邀约提议|已取消本次线下赴约|本次线下赴约已结束，双方已返回线上)/.test(text);
    }, []);

    // 判定是否为线下解封系统小灰字
    const isOfflineUnlockNoticeMessage = useCallback((msg: ChatMessage) => {
        if (!session.enableOfflineLock || session.isGroup) return false;
        return (
            msg.mediaType === "offline_unlock_system_notice" ||
            (msg.role === "system" && Boolean(msg.content && /已解除线下(?:封禁|封锁)|已解封线下/.test(msg.content)))
        );
    }, [session.enableOfflineLock, session.isGroup]);

    // 判定是否为线下封禁发起小灰字（封禁源头根节点）
    const isOfflineLockRootNoticeMessage = useCallback((msg: ChatMessage) => {
        if (!session.enableOfflineLock || session.isGroup) return false;
        return (
            (msg.mediaType === "offline_lock_system_notice" || Boolean(msg.mediaData?.offlineLock) || msg.role === "system") &&
            Boolean(msg.content && /暂时关闭了线下入口|封禁了线下入口|封锁了线下入口/.test(msg.content))
        );
    }, [session.enableOfflineLock, session.isGroup]);

    // 判定是否为心墙变动系统小灰字（心墙松动/坚固/变化节点）
    const isOfflineLockMindWallNoticeMessage = useCallback((msg: ChatMessage) => {
        if (!session.enableOfflineLock || session.isGroup) return false;
        return (
            (msg.mediaType === "offline_lock_system_notice" || Boolean(msg.mediaData?.offlineLock) || msg.role === "system") &&
            Boolean(msg.content && /的心墙似乎/.test(msg.content))
        );
    }, [session.enableOfflineLock, session.isGroup]);

    // 判定是否为线下封禁或心墙系统小灰字（涵盖发起与演变）
    const isOfflineLockNoticeMessage = useCallback((msg: ChatMessage) => {
        if (!session.enableOfflineLock || session.isGroup) return false;
        return (
            isOfflineLockRootNoticeMessage(msg) ||
            isOfflineLockMindWallNoticeMessage(msg) ||
            msg.mediaType === "offline_lock_system_notice" ||
            Boolean(msg.mediaData?.offlineLock)
        );
    }, [session.enableOfflineLock, session.isGroup, isOfflineLockRootNoticeMessage, isOfflineLockMindWallNoticeMessage]);

    const getInviteDeleteConfirmMessage = useCallback((_msg?: ChatMessage): string => {
        return "删除的内容中包含本次线下赴约的发起或变动消息，删除后将直接清除当前的赴约状态。若只想回退赴约状态，可取消并重试消息。";
    }, []);

    // [提醒赴约] 消息出现后预留 4 秒供用户阅读，随后自动展开弹窗
    const remindExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 解封确认弹窗计时器：角色解封后延迟 3 秒展开前往线下确认弹窗
    const unlockExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 记录最新一次含有 [提醒赴约] 的批次 ID，用于区分用户是“等角色说了动身后答应”还是“中途自助点击答应”
    const lastRemindBatchIdRef = useRef<string | null>(null);

    useEffect(() => {
        return () => {
            if (remindExpandTimerRef.current) {
                clearTimeout(remindExpandTimerRef.current);
                remindExpandTimerRef.current = null;
            }
            if (unlockExpandTimerRef.current) {
                clearTimeout(unlockExpandTimerRef.current);
                unlockExpandTimerRef.current = null;
            }
        };
    }, []);

    const sanitizeTransitMessage = useCallback((rawText?: string, direction?: "he_comes" | "i_go", place?: string): string => {
        let trimmed = rawText?.trim() || "";
        if (direction === "he_comes") {
            // 动身消息过滤答复性词汇（如“好、行、没问题、知道了”），避免角色自问自答产生语境脱节
            
            // 1. 强力剥离所有开头的应答词：如“好，/好的，/好啊，/行，/行啊，/行吧，/没问题，/知道了，/收到，/嗯，/成，”等
            trimmed = trimmed.replace(/^(?:好[的啊呀吧嘞啦]?[，,！!。\s]*|行[的啊呀吧嘞啦]?[，,！!。\s]*|没问题[，,！!。\s]*|知道了[，,！!。\s]*|收到[，,！!。\s]*|嗯[嗯]?[，,！!。\s]*|成[，,！!。\s]*|OK[，,！!。\s]*|ok[，,！!。\s]*)+/i, "");
            // 如果剥离后以“那我这就/那我/那”开头，转为更自然的“我这就/我现在”
            trimmed = trimmed.replace(/^那(?:我)?/, "我");
            trimmed = trimmed.trim();

            // 2. 主客角色纠偏：避免在“他来”模式下输出“你路上慢点”等颠倒台词
            if (!trimmed || /你?(?:路上慢点|注意看路|别急着赶路|路上小心|开车慢点|路上注意安全|注意交通安全)/.test(trimmed)) {
                return place ? `我这就动身过去找你，在${place}稍等我一会儿。` : "我这就动身过去找你，稍等我一会儿，很快就到。";
            }
            return trimmed;
        }
        if (!trimmed) {
            return place ? `路上慢点，注意安全，我在${place}等你。` : "路上慢点，注意安全，我在老地方等你。";
        }
        return trimmed;
    }, []);

    const getArrivalChatMessage = useCallback((invite: OfflineInviteData): string => {
        // 优先使用大模型结合上下文与地点生成的到达呼唤台词，避免模板化
        const rawArrived = invite.arrivedMessage?.trim();
        if (rawArrived) {
            return rawArrived;
        }
        const place = invite.place ? invite.place.trim() : "";
        if (invite.direction === "he_comes") {
            if (place === "你身边") {
                return "我到了，在附近等你，慢慢走出来就好。";
            }
            return place ? `我到了，在${place}等你，慢慢走别着急。` : "我到了，在附近等你，随时可以出来。";
        }
        return place ? `我在${place}就位等你了，慢慢过来不着急。` : "我已经就位等你了，慢慢过来。";
    }, []);

    const updateActiveOfflineInvite = useCallback((invite: OfflineInviteData | null) => {
        activeOfflineInviteRef.current = invite;
        setActiveOfflineInvite(invite);
        if (invite) {
            kvSet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id, JSON.stringify(invite));
        } else {
            kvRemove(ACTIVE_OFFLINE_INVITE_PREFIX + session.id);
        }
    }, [session.id]);

    useEffect(() => {
        if (!activeOfflineInvite || activeOfflineInvite.status !== "on_the_way" || activeOfflineInvite.hasFiredArrivalMessage) return;
        const checkArrival = () => {
            const remaining = getRemainingMinutes(activeOfflineInvite.startTime, activeOfflineInvite.durationMinutes || 15);
            if (remaining <= 0) {
                // 到达防重：检查聊天记录中是否已发送过本次行程的到达通知
                const currentMsgs = loadChatMessages(session.id);
                const tripStartTime = activeOfflineInvite.startTime || 0;
                const hasAlreadyArrivedNotice = currentMsgs.some(m => {
                    const msgTime = m.createdAt ? new Date(m.createdAt).getTime() : 0;
                    // 核心防御：必须发生在本次动身出发之后（容差 2 秒），绝不可把历史旧赴约的到达记录误当成这次的！
                    if (tripStartTime > 0 && msgTime < tripStartTime - 2000) {
                        return false;
                    }
                    return (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                        Boolean(m.content && (
                            m.content.includes("已如约到达") ||
                            m.content.includes("已提前到达") ||
                            m.content.includes("“如约”到达") ||
                            (m.content.includes("已在") && m.content.includes("就位等候"))
                        ));
                });
                if (hasAlreadyArrivedNotice) {
                    const syncedInvite: OfflineInviteData = {
                        ...activeOfflineInvite,
                        status: "arrived",
                        hasFiredArrivalMessage: true,
                    };
                    updateActiveOfflineInvite(syncedInvite);
                    setIsOfflineInviteMinimized(false);
                    return;
                }

                const arriveBatchId = `offline_arrive_${Date.now()}`;
                const arrivedInvite: OfflineInviteData = {
                    ...activeOfflineInvite,
                    status: "arrived",
                    hasFiredArrivalMessage: true,
                    relatedBatchIds: Array.from(new Set([...(activeOfflineInvite.relatedBatchIds || []), arriveBatchId])),
                };
                updateActiveOfflineInvite(arrivedInvite);
                setIsOfflineInviteMinimized(false);

                // 倒计时结束到达事实记录
                const charName = character?.name || "对方";
                const isOriginByYourSide = activeOfflineInvite.initialPlace === "你身边" || (!activeOfflineInvite.initialPlace && activeOfflineInvite.place === "你身边");
                const rawPlace = activeOfflineInvite.place?.trim();
                const placeStr = isOriginByYourSide ? "你身边" : (rawPlace ? (rawPlace === "你身边" ? "你身边" : `「${rawPlace}」`) : "约定地点");
                const isForced = activeOfflineInvite.theme === "forced" || activeOfflineInvite.theme === "alert";
                const asPromisedText = isForced ? "已“如约”到达" : "已如约到达";
                const sysArriveMsg = pushChatMessage({
                    sessionId: session.id,
                    role: "system",
                    content: activeOfflineInvite.direction === "he_comes"
                        ? `${charName} ${asPromisedText}${placeStr}`
                        : `${charName} 已在${placeStr}就位等候`,
                    mediaType: "offline_invite_system_notice",
                    mediaData: { offlineInvite: arrivedInvite },
                });
                setMessages(prev => [...prev, sysArriveMsg]);

                // 倒计时结束到达时，延迟 1 秒发出微信到达报备消息
                const arrivalChatText = getArrivalChatMessage(activeOfflineInvite);
                window.setTimeout(() => {
                    const newMsg = pushChatMessage({
                        sessionId: session.id,
                        role: "assistant",
                        content: arrivalChatText,
                        responseBatchId: arriveBatchId,
                        mediaType: "offline_invite_arrive_notice",
                    });
                    setMessages(prev => [...prev, newMsg]);
                }, 1000);
            }
        };
        checkArrival();
        const timer = setInterval(checkArrival, 1000);
        return () => clearInterval(timer);
    }, [activeOfflineInvite, getArrivalChatMessage, session.id, updateActiveOfflineInvite]);
    // 流式生成预览：线上（单聊/群聊）与线下各一份，生成中实时刷新，结束后清空
    const [streamPreview, setStreamPreview] = useState<null | {
        /** 单聊：按空行定型的分段气泡列表，最后一段在打字 */
        texts?: string[];
        parts?: { characterId: string; characterName: string; texts: string[] }[];
    }>(null);
    const [offlineStreamPreview, setOfflineStreamPreview] = useState<null | { content: string; summary: string }>(null);
    const streamAccumRef = useRef("");
    const offlineStreamAccumRef = useRef("");
    // 群聊/单聊流式预览解析的 rAF 合并帧（限频：一帧最多解析一次全文）
    const streamParseFrameRef = useRef(0);
    // 线下模式流式预览解析的 rAF 合并帧（独立于线上，避免互相干扰）
    const offlineStreamFrameRef = useRef(0);
    const [activeOfflineTarget, setActiveOfflineTarget] = useState<OfflineActionTarget | null>(null);
    const [editingOfflineTarget, setEditingOfflineTarget] = useState<OfflineActionTarget | null>(null);
    const [editingOfflineContent, setEditingOfflineContent] = useState("");
    const [regexRevision, setRegexRevision] = useState(0);
    // Whether there are unsent user messages waiting for AI generation
    const [pendingGenerate, setPendingGenerate] = useState(false);
    const [chatToast, setChatToast] = useState<string | null>(null);
    const chatToastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

    // ── Toast helpers ──
    const clearChatToast = useCallback(() => {
        clearTimeout(chatToastTimer.current);
        setChatToast(null);
    }, []);

    const showChatToast = useCallback((text: string, duration?: number) => {
        clearTimeout(chatToastTimer.current);
        setChatToast(text);
        // 系统顶部胶囊弹窗持续时间：涉及线下/封禁等重要状态通知或较长语句，预留足 4 秒（4000ms）供用户看清
        const defaultDuration = (text.includes("封禁") || text.includes("线下") || text.includes("赴约") || text.length >= 12) ? 4000 : 2500;
        const finalDuration = duration !== undefined ? duration : defaultDuration;
        if (finalDuration > 0) {
            chatToastTimer.current = setTimeout(() => setChatToast(null), finalDuration);
        }
    }, []);

    const showPersistentChatToast = useCallback((text: string) => {
        clearTimeout(chatToastTimer.current);
        setChatToast(text);
    }, []);
    // 自动生图失败：弹一次弹窗提示，关掉即消失（同一轮里多张失败只提示第一条）
    const [imageGenerationFailure, setImageGenerationFailure] = useState<string | null>(null);
    const [cloudDeletePending, setCloudDeletePending] = useState<{ count: number } | null>(null);
    const [showPlusMenu, setShowPlusMenu] = useState(false);
    const [customPlusActions, setCustomPlusActions] = useState<RegisteredCustomAppChatPlusAction[]>(() => loadCustomAppChatPlusActions());
    const [activeCustomChatPlus, setActiveCustomChatPlus] = useState<ActiveCustomChatPlus | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [showVoiceCall, setShowVoiceCall] = useState(false);
    const [showVideoCall, setShowVideoCall] = useState(false);
    const [callMinimized, setCallMinimized] = useState(false);
    const [callInitiator, setCallInitiator] = useState<"user" | "character">("user");
    const [callInitiatorName, setCallInitiatorName] = useState<string>("");
    const [userIdentity, setUserIdentity] = useState<UserIdentity | null>(null);
    const [enterToSendEnabled, setEnterToSendEnabled] = useState(() => loadChatAppSettings().enterToSendEnabled === true);

    // Rich media input modals
    const [richModal, setRichModal] = useState<RichModalKind | null>(null);
    const [transferTarget, setTransferTarget] = useState<Character | null>(null);
    // Media detail modal (red packet / transfer detail view)
    const [mediaDetailMsg, setMediaDetailMsg] = useState<ChatMessage | null>(null);
    // Quote reply
    const [quotingMessage, setQuotingMessage] = useState<ChatMessage | null>(null);
    // Emoji panel
    const [showEmojiPanel, setShowEmojiPanel] = useState(false);
    const [showStickerPanel, setShowStickerPanel] = useState(false);
    const chatTextInputRef = useRef<ChatTextInputHandle | null>(null);
    const offlineTextInputRef = useRef<OfflineTextInputHandle | null>(null);

    useEffect(() => {
        const syncEnterToSend = () => {
            setEnterToSendEnabled(loadChatAppSettings().enterToSendEnabled === true);
        };
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnterToSend);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnterToSend);
    }, []);

    useEffect(() => {
        const syncCustomPlusActions = () => setCustomPlusActions(loadCustomAppChatPlusActions());
        window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, syncCustomPlusActions);
        return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, syncCustomPlusActions);
    }, []);

    useEffect(() => {
        setTheaterMode(kvGet(CHAT_THEATER_MODE_PREFIX + session.id) === "1");
    }, [session.id]);

    // 聊天插件：进入聊天广播 session.opened
    useEffect(() => {
        emitChatPluginEvent("session.opened", { sessionId: session.id, isGroup: !!session.isGroup });
    }, [session.id, session.isGroup]);

    // 聊天插件：监听插件 toast（支持常驻加载态 + 手动关闭）
    const chatToastIdRef = useRef<string | null>(null);
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ id?: string; text: string; durationMs?: number; close?: boolean }>).detail || { text: "" };
            // 关闭请求：仅当关闭的是当前正在显示的那条时才清除
            if (detail.close) {
                if (chatToastIdRef.current === detail.id) {
                    clearTimeout(chatToastTimer.current);
                    setChatToast(null);
                    chatToastIdRef.current = null;
                }
                return;
            }
            if (!detail.text) return;
            clearTimeout(chatToastTimer.current);
            chatToastIdRef.current = detail.id ?? null;
            setChatToast(detail.text);
            // durationMs <= 0 表示常驻（加载态），不自动消失；缺省用 2400ms
            if (detail.durationMs === undefined || detail.durationMs > 0) {
                chatToastTimer.current = setTimeout(() => {
                    setChatToast(null);
                    chatToastIdRef.current = null;
                }, detail.durationMs ?? 2400);
            }
        };
        window.addEventListener(CHAT_PLUGIN_TOAST_EVENT, handler);
        return () => window.removeEventListener(CHAT_PLUGIN_TOAST_EVENT, handler);
    }, []);

    const [bgImageResolved, setBgImageResolved] = useState<string | null>(null);
    const [bgLoading, setBgLoading] = useState(!!session.backgroundImage);

    const wrapperRef = useRef<HTMLDivElement>(null);

    // 全屏特效：命中触发词的新消息播放表情雨/礼花（微信同款）
    const [activeScreenEffect, setActiveScreenEffect] = useState<ActiveScreenEffect | null>(null);
    const screenFxSeenRef = useRef<Set<string>>(new Set());
    const screenFxMountedAtRef = useRef(Date.now());

    useEffect(() => {
        const seen = screenFxSeenRef.current;
        let fired = activeScreenEffect !== null;
        for (const msg of messages) {
            if (seen.has(msg.id)) continue;
            seen.add(msg.id);
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            // 只对本次打开聊天室之后产生的消息生效，历史加载/翻页不触发
            if (new Date(msg.createdAt).getTime() < screenFxMountedAtRef.current) continue;
            // 骰子气泡：气泡自己翻滚定格，这里同步播全屏骰子（点数一致）
            if (msg.mediaType === "dice") {
                if (fired) continue;
                const face = Math.min(6, Math.max(1, Number(msg.mediaData?.diceFace) || 1));
                setActiveScreenEffect({ runId: msg.id, effect: "dice", emojis: "", diceFace: face });
                fired = true;
                continue;
            }
            if (msg.mediaType || !msg.content) continue;
            const hit = matchChatScreenEffectRule(msg.content);
            if (!hit) continue;
            if (hit.effect === "dice") {
                // 单独一条骰子图标（角色发的）：原地转成骰子气泡（内容保持图标），
                // 点数由系统旁白公布，避免结果挂在角色消息上被模仿
                const face = rollChatDiceFace();
                const patch = {
                    mediaType: "dice" as const,
                    mediaData: { ...msg.mediaData, diceFace: face },
                };
                updateChatMessage(msg.id, patch);
                setMessages(prev => prev.map(m => (m.id === msg.id ? { ...m, ...patch } : m)));
                const diceAside = pushChatMessage({
                    sessionId: session.id,
                    role: "system",
                    content: formatChatDiceResultMessage(face),
                });
                setMessages(prev => [...prev, diceAside]);
                if (!fired) {
                    setActiveScreenEffect({ runId: msg.id, effect: "dice", emojis: "", diceFace: face });
                    fired = true;
                }
                continue;
            }
            if (fired) continue;
            setActiveScreenEffect({ runId: msg.id, ...hit });
            fired = true;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);

    useEffect(() => {
        if (!session.backgroundImage) {
            setBgImageResolved(null);
            setBgLoading(false);
            return;
        }
        if (session.backgroundImage.startsWith("data:") || session.backgroundImage.startsWith("http")) {
            setBgImageResolved(session.backgroundImage);
            setBgLoading(false);
            return;
        }
        // It's an ID — load from IndexedDB
        setBgLoading(true);
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.backgroundImage!).then(dataUrl => {
                if (dataUrl) {
                    setBgImageResolved(dataUrl);
                }
                setBgLoading(false);
            });
        });
    }, [session.backgroundImage]);

    // Message Actions state
    const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
    const [contextMenuAnchor, setContextMenuAnchor] = useState<ContextMenuAnchor | null>(null);
    const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
    const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
    const [showConfirmMultiDelete, setShowConfirmMultiDelete] = useState(false);
    const [expandedMonologueId, setExpandedThinkingId] = useState<string | null>(null);
    // 思维链底部弹窗：存当前查看的 reasoning 文本，null = 关闭
    const [reasoningSheetText, setReasoningSheetText] = useState<string | null>(null);
    // 思维链翻译（弹窗内点击翻译按钮生成，切换弹窗内容时重置）
    const [reasoningTranslation, setReasoningTranslation] = useState<string | null>(null);
    const [reasoningTranslating, setReasoningTranslating] = useState(false);
    const [reasoningTranslateError, setReasoningTranslateError] = useState<string | null>(null);
    // 译文显示模式：对照（中文在上）/ 仅中文 / 仅原文
    const [reasoningViewMode, setReasoningViewMode] = useState<"both" | "zh" | "orig">("both");
    useEffect(() => {
        setReasoningTranslation(null);
        setReasoningTranslating(false);
        setReasoningTranslateError(null);
        setReasoningViewMode("both");
    }, [reasoningSheetText]);
    const handleTranslateReasoning = async () => {
        if (!reasoningSheetText || reasoningTranslating) return;
        if (reasoningTranslation) { setReasoningTranslation(null); setReasoningViewMode("both"); return; }
        setReasoningTranslating(true);
        setReasoningTranslateError(null);
        try {
            const result = await translateReasoningText(reasoningSheetText);
            if (result.content) { setReasoningTranslation(result.content); setReasoningViewMode("both"); }
            else setReasoningTranslateError(result.error || "翻译失败，请重试");
        } catch {
            setReasoningTranslateError("翻译失败，请重试");
        } finally {
            setReasoningTranslating(false);
        }
    };
    const [voiceTextIds, setVoiceTextIds] = useState<Set<string>>(new Set());
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [editingContent, setEditingContent] = useState("");
    const [editingResponseBatchId, setEditingResponseBatchId] = useState<string | null>(null);
    const [editingResponseRoundId, setEditingResponseRoundId] = useState<string | null>(null);
    const [editingResponseContent, setEditingResponseContent] = useState("");
    const [expandedVoiceCallIds, setExpandedVoiceCallIds] = useState<Set<string>>(new Set());
    const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const INITIAL_LOAD = CHAT_INITIAL_VISIBLE_MESSAGE_COUNT;
    const LOAD_MORE_COUNT = CHAT_LOAD_MORE_MESSAGE_COUNT;


    const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
    const startPosRef = useRef<{ x: number, y: number } | null>(null);
    const longPressTriggeredRef = useRef(false);

    const scrollRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(true);
    const isGeneratingRef = useRef(false);
    const visibleMessagesRef = useRef<ChatMessage[]>([]);
    const hasMoreRef = useRef(false);
    const offlineGenerationInputRef = useRef("");
    useEffect(() => () => { mountedRef.current = false; }, []);
    useEffect(() => { visibleMessagesRef.current = messages; }, [messages]);
    useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
    useChatBottomReserve(
        wrapperRef,
        scrollRef,
        `${session.id}:${offlineMode}:${isMultiSelectMode}:${showEmojiPanel}:${showStickerPanel}:${showPlusMenu}:${theaterMode}:${!!quotingMessage}`,
    );

    const selectStoredMessageWindow = useCallback((allMsgs: ChatMessage[]) => {
        if (allMsgs.length <= INITIAL_LOAD) {
            return { nextMessages: allMsgs, nextHasMore: false };
        }

        const visibleStoredMessages = visibleMessagesRef.current.filter(msg => !isTransientMessage(msg));
        const currentVisibleCount = Math.max(visibleStoredMessages.length, INITIAL_LOAD);

        if (!hasMoreRef.current && visibleStoredMessages.length >= allMsgs.length) {
            return { nextMessages: allMsgs, nextHasMore: false };
        }

        const firstVisibleId = visibleStoredMessages[0]?.id;
        const firstVisibleIndex = firstVisibleId
            ? allMsgs.findIndex(msg => msg.id === firstVisibleId)
            : -1;
        const startIndex = firstVisibleIndex >= 0
            ? firstVisibleIndex
            : Math.max(0, allMsgs.length - currentVisibleCount);

        return {
            nextMessages: allMsgs.slice(startIndex),
            nextHasMore: startIndex > 0,
        };
    }, []);

    const applyStoredMessageWindow = useCallback((allMsgs: ChatMessage[]) => {
        const { nextMessages, nextHasMore } = selectStoredMessageWindow(allMsgs);
        visibleMessagesRef.current = nextMessages;
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
        setMessages(nextMessages);
    }, [selectStoredMessageWindow]);

    const syncMessagesFromStorage = useCallback(() => {
        const stored = loadChatMessages(session.id);
        applyStoredMessageWindow(stored);

        // 若发起邀约的根消息在同步时已不存在，自动清理对应的赴约状态，防止状态悬空
        const currentInvite = activeOfflineInviteRef.current;
        if (currentInvite && currentInvite.sourceBatchId !== "mock_offline_invite") {
            const rootId = currentInvite.initialBatchId || currentInvite.sourceBatchId;
            const hasRoot = stored.some(m =>
                (rootId && (m.responseBatchId === rootId || m.id === rootId)) ||
                (currentInvite.relatedBatchIds && m.responseBatchId && currentInvite.relatedBatchIds.includes(m.responseBatchId)) ||
                m.mediaData?.offlineInvite ||
                (m.role === "system" && m.content && (
                    m.content.includes("你已同意赴约") ||
                    m.content.includes("线下赴约提议") ||
                    m.content.includes("正在动身赶往") ||
                    m.content.includes("前往") ||
                    m.content.includes("正在重新赶往") ||
                    m.content.includes("已到达") ||
                    m.content.includes("已提前到达") ||
                    m.content.includes("就位等候")
                ))
            );
            if (!hasRoot) {
                kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                kvRemove(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id);
                updateActiveOfflineInvite(null);
                setIsOfflineInviteMinimized(false);
                if (remindExpandTimerRef.current) {
                    clearTimeout(remindExpandTimerRef.current);
                    remindExpandTimerRef.current = null;
                }
                showChatToast("邀约发起消息已删除，相关赴约状态已自动取消");
            } else {
                // 若当前处于活跃的线下碰面中，不自动复活线上在途/到达卡片
                const isMeetingActive = !session.isGroup && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1";
                if (isMeetingActive) {
                    return;
                }
                const restored = restoreOfflineInviteFromMessages(stored, currentInvite);
                if (!restored) {
                    // 自愈兜底：若传入 currentInvite 恢复失败，尝试以干净消息流自愈推导，防止陈旧状态造成 1-0-1-0 翻转
                    const selfHealed = restoreOfflineInviteFromMessages(stored, null);
                    if (selfHealed) {
                        updateActiveOfflineInvite(selfHealed);
                    } else {
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                        if (remindExpandTimerRef.current) {
                            clearTimeout(remindExpandTimerRef.current);
                            remindExpandTimerRef.current = null;
                        }
                    }
                } else if (
                    restored.status !== currentInvite.status ||
                    restored.startTime !== currentInvite.startTime ||
                    restored.durationMinutes !== currentInvite.durationMinutes ||
                    restored.place !== currentInvite.place
                ) {
                    updateActiveOfflineInvite(restored);
                }
            }
        } else if (!currentInvite && session.enableOfflineInvite && !session.isGroup) {
            // 回溯复活铁律：当用户重试或删除了取消邀约/婉拒的消息时，activeOfflineInvite 虽然为 null，
            // 但历史消息中如果存在尚未结束的线下赴约，且最后一条不是终结记录，则自动复活回溯至当时的赴约状态！
            const isMeetingActive = !session.isGroup && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1";
            const hasPendingDeclineInStore = Boolean(kvGet(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id));
            const declineCountInHistory = stored.filter(m =>
                (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                Boolean(m.content && (/你婉拒了.*线下邀约提议|婉拒了.*线下赴约提议/.test(m.content)))
            ).length;

            // 若历史记录中已无任何婉拒小灰字，说明当前无需等待主动回复生成，立即清理待定标记
            if (declineCountInHistory === 0 && hasPendingDeclineInStore) {
                kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
            }

            const isWaitingDeclineReply = hasPendingDeclineInStore && declineCountInHistory > 0 && isGeneratingRef.current;
            if (!isMeetingActive && !isWaitingDeclineReply) {
                let lastTerminationIndex = -1;
                let lastInviteActionIndex = -1;
                for (let i = stored.length - 1; i >= 0; i--) {
                    const m = stored[i];
                    if (isOfflineInviteTerminatedMessage(m)) {
                        if (lastTerminationIndex === -1) lastTerminationIndex = i;
                    }
                    if (
                        m.mediaType === "offline_invite" ||
                        m.mediaType === "offline_invite_change_place" ||
                        m.mediaType === "offline_invite_early_arrive" ||
                        m.mediaType === "offline_invite_arrive_notice" ||
                        m.mediaData?.offlineInvite ||
                        (m.role === "system" && m.content && (
                            m.content.includes("你已同意赴约") ||
                            (m.content.includes("向你发起了") && m.content.includes("线下赴约提议")) ||
                            m.content.includes("正在动身赶往") ||
                            m.content.includes("已直接动身") ||
                            m.content.includes("正在重新赶往") ||
                            m.content.includes("赴约地点已更改为") ||
                            m.content.includes("已到达") ||
                            m.content.includes("已提前到达") ||
                            m.content.includes("就位等候") ||
                            m.content.includes("线下碰面中")
                        ))
                    ) {
                        if (lastInviteActionIndex === -1) lastInviteActionIndex = i;
                        break;
                    }
                }

                const isTerminatedAsLatestAction = lastTerminationIndex !== -1 && (lastInviteActionIndex === -1 || lastTerminationIndex > lastInviteActionIndex);
                if (!isTerminatedAsLatestAction && lastInviteActionIndex !== -1) {
                    // 检查在 lastTerminationIndex 之后的有效赴约记录中，最后一条是不是碰面小灰字
                    let lastMeetingNoticeIdx = -1;
                    let meetingThemeFromMsg: string | undefined;
                    for (let i = stored.length - 1; i > lastTerminationIndex; i--) {
                        const m = stored[i];
                        if ((m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && m.content.includes("线下碰面中"))) {
                            lastMeetingNoticeIdx = i;
                            meetingThemeFromMsg = m.mediaData?.offlineInvite?.theme;
                            break;
                        }
                    }

                    if (lastMeetingNoticeIdx !== -1) {
                        // 核心回溯锚点：时间线停留在“双方正在...线下碰面中”！
                        // 恢复碰面标记，顶栏显示 [回到现场]，置空线上卡片
                        kvSet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id, "1");
                        if (meetingThemeFromMsg) {
                            kvSet(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id, meetingThemeFromMsg);
                        }
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                    } else {
                        const restored = restoreOfflineInviteFromMessages(stored, null);
                        if (restored) {
                            kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                            kvRemove(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id);
                            updateActiveOfflineInvite(restored);
                            setIsOfflineInviteMinimized(true);
                        }
                    }
                }
            }
        }

        // 线下封禁状态水合：逆向扫描聊天记录，对齐并恢复最新的封禁或解封状态机（严格遵循生命之根法则）
        if (session.enableOfflineLock && !session.isGroup) {
            const wasLocked = Boolean(offlineLockDataRef.current?.isLocked);
            let latestEvent: { type: "unlock" } | { type: "lock"; lockData: OfflineLockData } | null = null;

            for (let i = stored.length - 1; i >= 0; i--) {
                const m = stored[i];
                if (isOfflineUnlockNoticeMessage(m)) {
                    latestEvent = { type: "unlock" };
                    break;
                }
                if (isOfflineLockNoticeMessage(m)) {
                    // 生命之根法则校验：封禁状态必须有明确的生命之根（关闭入口记录）支撑！
                    // 若当前节点不是根节点（例如为心墙变动小灰字），向前溯源直至找到本事件的根节点
                    let hasRoot = isOfflineLockRootNoticeMessage(m);
                    if (!hasRoot) {
                        for (let j = i - 1; j >= 0; j--) {
                            const prevM = stored[j];
                            if (isOfflineUnlockNoticeMessage(prevM)) {
                                // 遇上前一次风波的解封节点，说明该心墙为无根幽灵，直接跳出
                                break;
                            }
                            if (isOfflineLockRootNoticeMessage(prevM)) {
                                hasRoot = true;
                                break;
                            }
                        }
                    }

                    if (hasRoot) {
                        let lockData = (m.mediaData?.offlineLock as OfflineLockData) || null;
                        if (!lockData) {
                            try {
                                const raw = kvGet(OFFLINE_LOCK_PREFIX + session.id);
                                if (raw) lockData = JSON.parse(raw) as OfflineLockData;
                            } catch {}
                        }
                        if (!lockData) {
                            lockData = {
                                isLocked: true,
                                knockCount: 0,
                                requiredKnocks: 3,
                                stageKnocks: 0,
                                lockMessage: "",
                            };
                        }
                        latestEvent = { type: "lock", lockData };
                    }
                    // 已扫描至最新的封禁风波段，结束外层扫描
                    break;
                }
            }

            if (latestEvent?.type === "lock") {
                let activeLock = latestEvent.lockData;
                const currentInMemory = offlineLockDataRef.current;
                let existingKnockCount = (currentInMemory && currentInMemory.isLocked) ? currentInMemory.knockCount : undefined;
                let existingStageKnocks = (currentInMemory && currentInMemory.isLocked) ? currentInMemory.stageKnocks : undefined;
                if (existingKnockCount === undefined) {
                    try {
                        const raw = kvGet(OFFLINE_LOCK_PREFIX + session.id);
                        if (raw) {
                            const parsed = JSON.parse(raw) as OfflineLockData;
                            if (parsed.isLocked && parsed.requiredKnocks === activeLock.requiredKnocks) {
                                existingKnockCount = parsed.knockCount;
                                existingStageKnocks = parsed.stageKnocks;
                            }
                        }
                    } catch {}
                }
                if (existingKnockCount !== undefined && (!currentInMemory || currentInMemory.requiredKnocks === activeLock.requiredKnocks)) {
                    activeLock = {
                        ...activeLock,
                        knockCount: existingKnockCount,
                        stageKnocks: existingStageKnocks ?? activeLock.stageKnocks ?? 0,
                    };
                }
                kvSet(OFFLINE_LOCK_PREFIX + session.id, JSON.stringify(activeLock));
                setOfflineLockData(activeLock);
                offlineLockDataRef.current = activeLock;
                kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);
                if (!wasLocked) {
                    showChatToast("已回溯至角色封禁线下的历史节点，线下入口已重新封锁", 4000);
                }
            } else if (latestEvent?.type === "unlock") {
                kvRemove(OFFLINE_LOCK_PREFIX + session.id);
                setOfflineLockData(null);
                offlineLockDataRef.current = null;
            } else {
                kvRemove(OFFLINE_LOCK_PREFIX + session.id);
                setOfflineLockData(null);
                offlineLockDataRef.current = null;
                if (wasLocked) {
                    showChatToast("相关封禁消息已删除，线下入口已恢复畅通", 4000);
                }
                kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);
            }
        }
        if (stored.length === 0) {
            kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);
        }
    }, [applyStoredMessageWindow, session.id, updateActiveOfflineInvite, showChatToast]);

    const closeContextMenu = () => {
        setActiveMessageId(null);
        setActiveOfflineTarget(null);
        setContextMenuAnchor(null);
    };

    const openMessageContextMenu = (msgId: string, anchor: ContextMenuAnchor) => {
        setActiveOfflineTarget(null);
        setContextMenuAnchor(anchor);
        setActiveMessageId(msgId);
    };

    const openOfflineContextMenu = (target: OfflineActionTarget, anchor: ContextMenuAnchor) => {
        setActiveMessageId(null);
        setContextMenuAnchor(anchor);
        setActiveOfflineTarget(target);
    };

    const getContextMenuInitialStyle = () => {
        const anchor = contextMenuAnchor;
        if (!anchor) return { left: 0, top: 0 };
        return { left: anchor.x, top: Math.max(8, anchor.y - 90) };
    };

    const positionFloatingContextMenu = (el: HTMLDivElement | null) => {
        if (!el || !contextMenuAnchor) return;
        const margin = 8;
        const gap = 12;
        const anchor = contextMenuAnchor;
        const menuW = el.offsetWidth;
        const menuH = el.offsetHeight;
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;
        let left = anchor.x - menuW / 2;
        left = Math.max(margin, Math.min(left, viewportW - menuW - margin));
        const placeBelow = anchor.y - menuH - gap < margin;
        let top = placeBelow ? anchor.y + gap : anchor.y - menuH - gap;
        top = Math.max(margin, Math.min(top, viewportH - menuH - margin));
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        const tri = el.querySelector("[data-menu-triangle]") as HTMLElement | null;
        if (tri) {
            const triLeft = Math.max(14, Math.min(anchor.x - left, menuW - 14));
            tri.style.left = `${triLeft}px`;
            tri.style.right = "auto";
            tri.style.transform = "translateX(-50%)";
            if (placeBelow) {
                tri.style.top = "-6px";
                tri.style.bottom = "auto";
                tri.style.borderTop = "none";
                tri.style.borderBottom = "6px solid var(--ctx-menu-bg, #2c2c2c)";
            } else {
                tri.style.top = "auto";
                tri.style.bottom = "-6px";
                tri.style.borderBottom = "none";
                tri.style.borderTop = "6px solid var(--ctx-menu-bg, #2c2c2c)";
            }
        }
    };

    // --- Music action queue: send music operations as system messages ---
    useEffect(() => {
        const flushCallback = (text: string) => {
            const sysMsg = pushChatMessage({ sessionId: session.id, role: "system", content: text });
            setMessages(prev => [...prev, sysMsg]);
        };
        setChatActive(true, flushCallback);
        return () => { setChatActive(false); };
    }, [session.id]);

    // --- Follow-up: listen for background service events ---
    useEffect(() => {
        const onStarted = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                console.log("[ChatRoom] followup-started received, setting isGenerating=true");
                setIsGenerating(true);
            }
        };
        const onMessageSaved = (e: Event) => {
            const detail = (e as CustomEvent<{ sessionId?: string; message?: ChatMessage }>).detail;
            if (detail?.sessionId !== session.id || !detail.message) return;
            setMessages(prev => (
                prev.some(item => item.id === detail.message!.id)
                    ? prev
                    : [...prev, detail.message!]
            ));
        };
        const onFired = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                console.log("[ChatRoom] followup-fired received, reloading messages, setting isGenerating=false");
                // Reload messages from storage (the service already saved them)
                syncMessagesFromStorage();
                setIsGenerating(false);
            }
        };
        const onOfflineLockUpdated = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                try {
                    const raw = kvGet(OFFLINE_LOCK_PREFIX + session.id);
                    const parsed = raw ? (JSON.parse(raw) as OfflineLockData) : null;
                    setOfflineLockData(parsed);
                    offlineLockDataRef.current = parsed;
                } catch {
                    setOfflineLockData(null);
                    offlineLockDataRef.current = null;
                }
            }
        };
        window.addEventListener("followup-started", onStarted);
        window.addEventListener("followup-message-saved", onMessageSaved);
        window.addEventListener("followup-fired", onFired);
        window.addEventListener("offline-lock-updated", onOfflineLockUpdated);
        // 生成中途才进入聊天室会错过 followup-started 事件，
        // 挂载时主动查一次后台生成状态，把「正在输入」补回来
        if (isBackgroundReplyGenerating(session.id)) {
            setIsGenerating(true);
        }
        return () => {
            window.removeEventListener("followup-started", onStarted);
            window.removeEventListener("followup-message-saved", onMessageSaved);
            window.removeEventListener("followup-fired", onFired);
            window.removeEventListener("offline-lock-updated", onOfflineLockUpdated);
        };
    }, [session.id, syncMessagesFromStorage]);

    // Listen for live CSS updates from 小卷
    useEffect(() => {
        const onCSSUpdate = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                setLiveCSS(detail.css || "");
            }
        };
        window.addEventListener("chat-session-css-updated", onCSSUpdate);
        return () => window.removeEventListener("chat-session-css-updated", onCSSUpdate);
    }, [session.id]);

    // Listen for WeChat bridge: reload from storage (preserves rich formatting)
    useEffect(() => {
        const onWeixinUpdate = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                syncMessagesFromStorage();
            }
        };
        const onWeixinGenerating = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                setIsGenerating(Boolean(detail.generating));
                isGeneratingRef.current = Boolean(detail.generating);
            }
        };
        window.addEventListener("weixin-messages-updated", onWeixinUpdate);
        window.addEventListener("weixin-generating", onWeixinGenerating);
        return () => {
            window.removeEventListener("weixin-messages-updated", onWeixinUpdate);
            window.removeEventListener("weixin-generating", onWeixinGenerating);
        };
    }, [session.id, syncMessagesFromStorage]);

    // Listen for messages inserted by other apps, such as share-to-chat cards.
    useEffect(() => {
        const onExternalMessageUpdate = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                syncMessagesFromStorage();
            }
        };
        window.addEventListener("chat-messages-updated", onExternalMessageUpdate);
        return () => window.removeEventListener("chat-messages-updated", onExternalMessageUpdate);
    }, [session.id, syncMessagesFromStorage]);

    // --- Background generation: reload messages when a bg API call completes ---
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                syncMessagesFromStorage();
                isGeneratingRef.current = false;
                setIsGenerating(false);
                clearGenerationLock(session.id);
            }
        };
        window.addEventListener(CHAT_BG_COMPLETE, handler);
        return () => window.removeEventListener(CHAT_BG_COMPLETE, handler);
    }, [session.id, syncMessagesFromStorage]);


    // Group chat: map of characterId → Character for quick lookup
    const groupCharMap = useMemo(() => {
        if (!session.isGroup) return new Map<string, Character>();
        const chars = loadCharacters();
        const map = new Map<string, Character>();
        for (const id of session.participantIds || []) {
            const c = chars.find(ch => ch.id === id);
            if (c) map.set(id, c);
        }
        return map;
    }, [session.isGroup, session.participantIds]);

    // Flat array of group characters for components that need it
    const groupCharacters = useMemo(() => [...groupCharMap.values()], [groupCharMap]);
    const groupCharacterNames = useMemo(() => groupCharacters.map(item => item.name).filter(Boolean).join("、"), [groupCharacters]);

    const activeRegexes = useMemo<RegexConfig[]>(() => {
        const bindings = loadBindingConfig();
        const activeSlot = resolveBinding(bindings, session.isGroup ? undefined : session.contactId, session.isGroup ? "group_chat" : "chat");
        const allRegexes = loadRegexes();
        return (activeSlot.regexIds || [])
            .map(id => allRegexes.find(regex => regex.id === id))
            .filter((regex): regex is RegexConfig => Boolean(regex));
    }, [regexRevision, session.contactId, session.isGroup]);

    // 流式预览的标签净化配置：与引擎同源（当前会话绑定的预设）。预设开启标签式思维链时，
    // 生成过程中的预览也要按同一套标签剥掉思考过程/摘要，否则最终消息里被引擎剥掉的内容
    // 会先在预览气泡里闪现（cleanStreamText 自身不猜配置型标签名，由这里统一传入）。
    const streamPreviewTagConfig = useMemo(() => {
        const bindings = loadBindingConfig();
        const slot = resolveBinding(bindings, session.isGroup ? undefined : session.contactId, session.isGroup ? "group_chat" : "chat");
        const preset = loadPresets().find(item => item.id === slot.presetId) || null;
        const withThoughtCompat = (tag: string): string[] => (tag === "thinking" ? ["thinking", "thought", "think"] : [tag]);
        return {
            online: preset?.online_thinking_enabled === true
                ? withThoughtCompat(preset.online_thinking_tag?.trim() || "thinking")
                : [],
            offlineThinking: preset?.offline_thinking_enabled === true
                ? withThoughtCompat(preset.thinking_tag?.trim() || "thinking")
                : [],
            summaryTag: preset?.story_summary_tag?.trim() || "summary",
            // 预设「剔除文本」：引擎最终会删，预览阶段同步删，避免闪现（字面量删除，成本极低）
            stripTexts: (preset?.strip_texts || []).filter(Boolean),
        };
    }, [regexRevision, session.contactId, session.isGroup]);

    const displayRegexMacroEngine = useMemo(() => {
        const charName = session.isGroup
            ? (session.groupName || groupCharacterNames || "群聊")
            : (character?.name || "对方");
        const engine = new MacroEngine(charName, userIdentity?.name || "你");
        engine.group = groupCharacterNames || (session.isGroup ? (session.groupName || "群聊") : "");
        return engine;
    }, [character?.name, groupCharacterNames, session.groupName, session.isGroup, userIdentity?.name]);

    const getRegexActiveTags = useCallback((isOffline: boolean) => (
        session.isGroup
            ? ["group_chat", isOffline ? "offline" : "text"]
            : ["chat", isOffline ? "offline" : "text"]
    ), [session.isGroup]);

    const renderDisplayText = useCallback((
        text: string,
        placement: 1 | 2 | 5 | 6,
        isOffline = false,
    ) => {
        if (!text || activeRegexes.length === 0) return text;
        return applyDisplayRegex(text, activeRegexes, placement, {
            macroEngine: displayRegexMacroEngine,
            activeTags: getRegexActiveTags(isOffline),
        });
    }, [activeRegexes, displayRegexMacroEngine, getRegexActiveTags]);

    const getMessageDisplayContent = useCallback((message: RenderChatMessage): string => (
        message.displayProjected
            ? message.content
            : renderDisplayText(message.content, message.role === "user" ? 1 : 2, false)
    ), [renderDisplayText]);

    const applyEditTextRegex = useCallback((
        text: string,
        placement: 1 | 2 | 5 | 6,
        isOffline = false,
    ) => {
        if (!text || activeRegexes.length === 0) return text;
        return applyEditRegex(text, activeRegexes, placement, {
            macroEngine: displayRegexMacroEngine,
            activeTags: getRegexActiveTags(isOffline),
        });
    }, [activeRegexes, displayRegexMacroEngine, getRegexActiveTags]);

    // 「丢弃角色输出的无效表情包」开关：滤除名称不在角色表情包/内置表情中的 sticker part
    const stripInvalidStickerParts = useCallback((parts: ParsedMessagePart[], senderCharacterId?: string): ParsedMessagePart[] => {
        if (session.discardInvalidStickers !== true) return parts;
        const characterIds = senderCharacterId
            ? [senderCharacterId]
            : (session.isGroup ? (session.participantIds ?? []) : [session.contactId]);
        return parts.filter(part => part.mediaType !== "sticker"
            || isKnownStickerLabel(part.mediaData?.label || "", characterIds));
    }, [session.discardInvalidStickers, session.isGroup, session.participantIds, session.contactId]);

    const normalizeDisplayParts = useCallback((parts: ReturnType<typeof parseAIResponse>["parts"]) => {
        const charN = character?.name || "对方";
        const userN = userIdentity?.name || "你";
        return parts.flatMap(part => {
            if (
                part.mediaType === "voice_call" ||
                part.mediaType === "video_call" ||
                part.mediaType === "accept_red_packet" ||
                part.mediaType === "decline_red_packet" ||
                part.mediaType === "accept_transfer" ||
                part.mediaType === "decline_transfer" ||
                part.mediaType === "accept_payment_request" ||
                part.mediaType === "decline_payment_request"
            ) {
                return [];
            }
            if (part.mediaType === "music") {
                const title = part.mediaData?.musicTitle || part.mediaData?.label;
                return title ? [{ content: `[音乐:${title}]` }] : [];
            }
            if (part.mediaType === "group_admin_notice") {
                const d = part.mediaData;
                if (!d?.adminAction || !d.adminActorName) return [];
                return [{
                    content: buildGroupAdminNoticeText(d.adminAction, d.adminActorName, d.adminTargetName || "", d.adminMuteMinutes),
                    mediaType: "group_admin_notice" as const,
                    mediaData: d,
                }];
            }
            if (part.mediaType === "poke") {
                const pokeSender = (part.mediaData?.pokeSender === "我" ? charN : part.mediaData?.pokeSender) || charN;
                const pokeTarget = part.mediaData?.pokeTarget || userN;
                return [{
                    content: `${pokeSender} 拍了拍 ${pokeTarget}`,
                    mediaType: "poke" as const,
                    mediaData: { pokeSender, pokeTarget },
                }];
            }
            return [part];
        }).filter(part => part.mediaType || part.content.trim());
    }, [character?.name, userIdentity?.name]);

    useEffect(() => {
        const refreshRegexes = () => setRegexRevision(value => value + 1);
        window.addEventListener("settings-regexes-updated", refreshRegexes);
        window.addEventListener("settings-bindings-updated", refreshRegexes);
        window.addEventListener("settings-presets-updated", refreshRegexes);
        return () => {
            window.removeEventListener("settings-regexes-updated", refreshRegexes);
            window.removeEventListener("settings-bindings-updated", refreshRegexes);
            window.removeEventListener("settings-presets-updated", refreshRegexes);
        };
    }, []);

    const availableShoppingGifts = useMemo(
        () => loadDeliveredShoppingGifts(),
        [messages],
    );

    useEffect(() => {
        setUserIdentity(resolveUserIdentity(session.contactId, "chat"));
        setTransientMessages([]);
        setOfflineMode(kvGet(CHAT_OFFLINE_MODE_PREFIX + session.id) === "1");
        setOfflineVisibleCount(OFFLINE_INITIAL_LOAD);
        offlineTextInputRef.current?.clear();
        setPendingOfflineUserText("");
        setIsOfflineGenerating(false);
        setActiveOfflineTarget(null);
        setContextMenuAnchor(null);
        setIsMultiSelectMode(false);
        setSelectedMessageIds(new Set());
        setShowConfirmMultiDelete(false);
        setEditingOfflineTarget(null);
        setEditingOfflineContent("");
        setOfflineTurns(loadChatOfflineTurns(session.id));

        // Prewarm sticker cache for all relevant characters, then load messages
        const allMsgs = loadChatMessages(session.id);
        const msgs = allMsgs.length > INITIAL_LOAD ? allMsgs.slice(-INITIAL_LOAD) : allMsgs;
        const nextHasMore = allMsgs.length > INITIAL_LOAD;
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
        const charIds = session.isGroup && session.participantIds
            ? session.participantIds
            : [session.contactId];
        Promise.all(charIds.map(id => prewarmStickerCache(id))).then(() => {
            setStickerReady(true);
            needsInitialScrollRef.current = true;
            prevMsgCountRef.current = 0;
            visibleMessagesRef.current = msgs;
            setMessages(msgs);
        });

        // If a background generation is still in progress, show loading indicator.
        // Old or expired locks are cleared so the room cannot stay frozen forever.
        if (hasActiveGenerationLock(session.id)) {
            isGeneratingRef.current = true;
            setIsGenerating(true);
        } else {
            isGeneratingRef.current = false;
            setIsGenerating(false);
        }

        // Auto-reply logic for newly added friends with a greeting
        const freshSession = loadChatSessions().find(s => s.id === session.id);
        const alreadyReplied = freshSession?.autoReplied;

        if (session.isGroup && !alreadyReplied && msgs.length === 1 && msgs[0].role === "system") {
            // Group chat initial greeting: single API call for all members
            const sessions2 = loadChatSessions();
            const sessIdx2 = sessions2.findIndex(s => s.id === session.id);
            if (sessIdx2 !== -1) {
                sessions2[sessIdx2].autoReplied = true;
                saveChatSessions(sessions2);
            }

            void runManagedGeneration({ history: msgs });
        } else if (!session.isGroup && !alreadyReplied &&
            msgs.length === 2 &&
            msgs[0].role === "system" && msgs[0].content.includes("已添加了") &&
            msgs[1].role === "user") {

            const sessions = loadChatSessions();
            const sessIdx = sessions.findIndex(s => s.id === session.id);
            if (sessIdx !== -1) {
                sessions[sessIdx].autoReplied = true;
                saveChatSessions(sessions);
            }

            void runManagedGeneration({ history: msgs, onDecline: triggerReply });
        }

        // Friend request accepted: trigger AI reply (localStorage flag set by handleAcceptFriendRequest)
        const pendingKey = PENDING_REPLY_PREFIX + session.id;
        if (kvGet(pendingKey)) {
            kvRemove(pendingKey);
            void runManagedGeneration({ history: msgs, onDecline: triggerReply });
        }
    }, [session.id]);

    const needsInitialScrollRef = useRef(true);
    const prevMsgCountRef = useRef(0);
    const loadingMoreRef = useRef(false);
    const loadMoreScrollRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
    const offlineLoadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
    const loadMoreAnchorRef = useRef<ScrollAnchorSnapshot | null>(null);
    const loadMoreResizeObserverRef = useRef<ResizeObserver | null>(null);
    const loadMoreAnchorTimerRef = useRef<number | null>(null);
    const initialScrollVersionRef = useRef(0);
    const pendingSearchJumpRef = useRef<PendingMessageJump | null>(null);
    const searchJumpHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const stopLoadMoreAnchorTracking = useCallback(() => {
        loadMoreResizeObserverRef.current?.disconnect();
        loadMoreResizeObserverRef.current = null;
        if (loadMoreAnchorTimerRef.current !== null) {
            window.clearTimeout(loadMoreAnchorTimerRef.current);
            loadMoreAnchorTimerRef.current = null;
        }
        loadMoreAnchorRef.current = null;
    }, []);

    useEffect(() => stopLoadMoreAnchorTracking, [stopLoadMoreAnchorTracking]);
    useEffect(() => () => {
        if (searchJumpHighlightTimerRef.current) clearTimeout(searchJumpHighlightTimerRef.current);
    }, []);

    const flashMessageHighlight = useCallback((messageId: string) => {
        setHighlightMessageId(messageId);
        if (searchJumpHighlightTimerRef.current) {
            clearTimeout(searchJumpHighlightTimerRef.current);
        }
        searchJumpHighlightTimerRef.current = setTimeout(() => {
            setHighlightMessageId(current => current === messageId ? null : current);
            searchJumpHighlightTimerRef.current = null;
        }, 2000);
    }, []);

    const captureScrollAnchor = useCallback((): ScrollAnchorSnapshot | null => {
        const el = scrollRef.current;
        if (!el) return null;
        const containerRect = el.getBoundingClientRect();
        const candidates = Array.from(el.querySelectorAll<HTMLElement>('[id^="message-"]'));
        for (const candidate of candidates) {
            const rect = candidate.getBoundingClientRect();
            if (rect.bottom <= containerRect.top) continue;
            if (rect.top >= containerRect.bottom) continue;
            return {
                messageId: candidate.id.replace(/^message-/, ""),
                offsetDelta: candidate.offsetTop - el.scrollTop,
            };
        }
        return null;
    }, []);

    const restoreScrollAnchor = useCallback((anchor: ScrollAnchorSnapshot | null): boolean => {
        const el = scrollRef.current;
        if (!el || !anchor) return false;
        const target = document.getElementById(`message-${anchor.messageId}`);
        if (!target) return false;
        el.scrollTop = target.offsetTop - anchor.offsetDelta;
        return true;
    }, []);

    const watchLoadMoreAnchorImages = useCallback((anchor: ScrollAnchorSnapshot | null) => {
        const el = scrollRef.current;
        if (!el || !anchor) {
            stopLoadMoreAnchorTracking();
            return;
        }
        const target = document.getElementById(`message-${anchor.messageId}`);
        if (!target) {
            stopLoadMoreAnchorTracking();
            return;
        }

        loadMoreResizeObserverRef.current?.disconnect();
        loadMoreResizeObserverRef.current = null;
        if (loadMoreAnchorTimerRef.current !== null) {
            window.clearTimeout(loadMoreAnchorTimerRef.current);
            loadMoreAnchorTimerRef.current = null;
        }

        const targetTop = target.getBoundingClientRect().top;
        const imagesAboveAnchor = Array.from(el.querySelectorAll("img"))
            .filter(img => img.getBoundingClientRect().top < targetTop);

        if (imagesAboveAnchor.length === 0) {
            stopLoadMoreAnchorTracking();
            return;
        }

        const restoreAfterImageResize = () => {
            if (loadMoreAnchorRef.current !== anchor) return;
            restoreScrollAnchor(anchor);
            requestAnimationFrame(() => restoreScrollAnchor(anchor));
        };

        if (typeof ResizeObserver !== "undefined") {
            const observer = new ResizeObserver(restoreAfterImageResize);
            imagesAboveAnchor.forEach(img => observer.observe(img));
            loadMoreResizeObserverRef.current = observer;
        }

        imagesAboveAnchor.forEach(img => {
            img.addEventListener("load", restoreAfterImageResize, { once: true });
            img.addEventListener("error", restoreAfterImageResize, { once: true });
            img.decode?.().then(restoreAfterImageResize).catch(() => {});
        });

        loadMoreAnchorTimerRef.current = window.setTimeout(() => {
            if (loadMoreAnchorRef.current === anchor) {
                stopLoadMoreAnchorTracking();
            }
        }, 3000);
    }, [restoreScrollAnchor, stopLoadMoreAnchorTracking]);

    const loadMore = useCallback(() => {
        if (!hasMore || loadingMoreRef.current) return;
        stopLoadMoreAnchorTracking();
        loadingMoreRef.current = true;
        initialScrollVersionRef.current += 1;
        const el = scrollRef.current;
        if (el) {
            loadMoreAnchorRef.current = captureScrollAnchor();
            loadMoreScrollRestoreRef.current = {
                scrollHeight: el.scrollHeight,
                scrollTop: el.scrollTop,
            };
        }
        const allMsgs = loadChatMessages(session.id);
        const currentCount = messages.length;
        const nextCount = Math.min(currentCount + LOAD_MORE_COUNT, allMsgs.length);
        if (nextCount <= currentCount) {
            hasMoreRef.current = false;
            setHasMore(false);
            stopLoadMoreAnchorTracking();
            loadMoreScrollRestoreRef.current = null;
            loadingMoreRef.current = false;
            return;
        }
        const nextMessages = allMsgs.slice(-nextCount);
        const nextHasMore = nextCount < allMsgs.length;
        visibleMessagesRef.current = nextMessages;
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
        setMessages(nextMessages);
    }, [captureScrollAnchor, hasMore, messages.length, session.id, stopLoadMoreAnchorTracking]);
    // useLayoutEffect: runs synchronously after DOM mutation, before browser paint
    // Prevents flash of wrong scroll position, works reliably under transform: scale()
    const displayMessages = useMemo(() => {
        return [...messages, ...transientMessages]
            .map((msg, index) => ({ msg, index }))
            .sort((a, b) => {
                const orderDiff = compareChatMessages(a.msg, b.msg);
                return orderDiff !== 0 ? orderDiff : a.index - b.index;
            })
            .map(item => item.msg);
    }, [messages, transientMessages]);

    useLayoutEffect(() => {
        const el = scrollRef.current;
        const anchor = loadMoreAnchorRef.current;
        const loadMoreRestore = loadMoreScrollRestoreRef.current;
        if (loadMoreRestore) {
            if (el && !restoreScrollAnchor(anchor)) {
                el.scrollTop = loadMoreRestore.scrollTop + (el.scrollHeight - loadMoreRestore.scrollHeight);
            }
            loadMoreScrollRestoreRef.current = null;
            loadingMoreRef.current = false;
            prevMsgCountRef.current = displayMessages.length;
            watchLoadMoreAnchorImages(anchor);
            return;
        }

        const pendingJump = pendingSearchJumpRef.current;
        if (pendingJump && el) {
            const jumpIds = pendingJump.fallbackMessageId && pendingJump.fallbackMessageId !== pendingJump.messageId
                ? [pendingJump.messageId, pendingJump.fallbackMessageId]
                : [pendingJump.messageId];
            const targetId = jumpIds.find(id => document.getElementById(`message-${id}`));
            const target = targetId ? document.getElementById(`message-${targetId}`) as HTMLElement | null : null;
            if (targetId && target) {
                pendingSearchJumpRef.current = null;
                scrollElementWithinContainer(el, target, { behavior: "smooth", block: "center" });
                flashMessageHighlight(targetId);
            } else {
                pendingSearchJumpRef.current = null;
            }
            prevMsgCountRef.current = displayMessages.length;
            return;
        }

        if (needsInitialScrollRef.current && displayMessages.length > 0 && el) {
            needsInitialScrollRef.current = false;
            prevMsgCountRef.current = displayMessages.length;
            const scrollVersion = ++initialScrollVersionRef.current;

            // Wait for all images inside the scroll container to finish loading, then scroll once
            const imgs = Array.from(el.querySelectorAll("img"));
            const pending = imgs.filter(img => !img.complete);
            console.log(`[SCROLL] imgs total=${imgs.length}, pending=${pending.length}`);

            if (pending.length === 0) {
                el.scrollTop = el.scrollHeight;
                console.log(`[SCROLL] done (no pending), sH=${el.scrollHeight}`);
            } else {
                let loaded = 0;
                const onDone = () => {
                    loaded++;
                    if (loaded >= pending.length) {
                        if (initialScrollVersionRef.current !== scrollVersion || loadingMoreRef.current) return;
                        el.scrollTop = el.scrollHeight;
                        console.log(`[SCROLL] done (all loaded), sH=${el.scrollHeight}`);
                    }
                };
                for (const img of pending) {
                    img.addEventListener("load", onDone, { once: true });
                    img.addEventListener("error", onDone, { once: true });
                }
            }
        } else if (displayMessages.length > prevMsgCountRef.current && el) {
            el.scrollTop = el.scrollHeight;
        }
        prevMsgCountRef.current = displayMessages.length;
    }, [displayMessages, flashMessageHighlight, restoreScrollAnchor, watchLoadMoreAnchorImages]);

    // 从线下切回线上时，自动滚动并停留在最新消息底部
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        isNearBottomRef.current = true;
        if (!offlineMode) {
            requestAnimationFrame(() => {
                if (scrollRef.current) {
                    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                    isNearBottomRef.current = true;
                }
            });
        }
    }, [offlineMode, offlineTurns.length, isOfflineGenerating, pendingOfflineUserText]);

    // 流式预览增量更新时跟随滚动到底：仅在用户本来就停在底部附近时跟随，
    // 用户上翻历史/查看旧消息时绝不拽回底部（否则长回复生成中根本无法阅读）。
    const isNearBottomRef = useRef(true);
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onScroll = () => {
            // 距底部 < 120px 视为"在底部附近"；用户上翻即停用自动跟随
            isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, []);
    // 只在接近底部时才跟随，且用 rAF 合并到下一帧，避免每帧 setState 后 layout 抖动
    const streamFollowRef = useRef(0);
    const followStreamScroll = useCallback(() => {
        if (streamFollowRef.current) return;
        streamFollowRef.current = window.requestAnimationFrame(() => {
            streamFollowRef.current = 0;
            if (!isNearBottomRef.current) return;
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
        });
    }, []);
    useLayoutEffect(() => {
        if (!streamPreview && !offlineStreamPreview) return;
        followStreamScroll();
    }, [streamPreview, offlineStreamPreview, offlineMode, followStreamScroll]);

    // 卸载时清理挂起的流式预览 rAF 帧，防止切会话后回调残留触发 setState
    useEffect(() => {
        return () => {
            if (streamParseFrameRef.current) cancelAnimationFrame(streamParseFrameRef.current);
            if (offlineStreamFrameRef.current) cancelAnimationFrame(offlineStreamFrameRef.current);
            if (streamFollowRef.current) cancelAnimationFrame(streamFollowRef.current);
            streamParseFrameRef.current = 0;
            offlineStreamFrameRef.current = 0;
            streamFollowRef.current = 0;
        };
    }, []);

    // Sync current session+messages to debug store for DebugPromptPanel
    useEffect(() => {
        setDebugChatState({ session, messages });
        return () => { setDebugChatState(null); };
    }, [session, messages]);

    // Listen for AI-initiated call triggers from follow-up service
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.sessionId === session.id) {
                // Only handle call if this ChatRoom is currently visible
                if (!isChatRoomElementVisible(wrapperRef.current)) return;
                setCallInitiator("character");
                if (detail.type === "voice") setShowVoiceCall(true);
                else if (detail.type === "video") setShowVideoCall(true);
                // Dismiss the global incoming-call bar (if showing)
                window.dispatchEvent(new CustomEvent("incoming-call-dismiss"));
            }
        };
        window.addEventListener("ai-call-trigger", handler);
        return () => window.removeEventListener("ai-call-trigger", handler);
    }, [session.id]);

    // Helper: handle AI accepting/declining user's red packet or transfer
    const buildAssistantActionEditMeta = (rawResponseText: string) => ({
        responseBatchId: createResponseBatchId(),
        rawResponseText,
    });

    const handleAIMediaAction = (actionType: string, charN: string, userN: string) => {
        // Find the target message in current messages (most recent matching user message with pending status)
        const targetMediaType = actionType.includes("payment_request")
            ? "payment_request"
            : actionType.includes("red_packet") ? "red_packet" : "transfer";
        const targetMsg = [...messages].reverse().find(
            m => m.role === "user" && m.mediaType === targetMediaType && m.mediaData?.status === "pending"
        );
        if (!targetMsg) return;

        let newStatus: "opened" | "received" | "declined" | "paid";
        let sysText: string;
        let rawResponseText: string;
        if (actionType === "accept_red_packet") {
            newStatus = "opened";
            const amt = targetMsg.mediaData?.amount;
            const amtStr = amt != null ? `，金额:${amt}元` : "";
            sysText = `${charN}领取了${userN}的红包${amtStr}`;
            rawResponseText = `[${charN}领取了${userN}的红包]`;
        } else if (actionType === "decline_red_packet") {
            newStatus = "declined";
            sysText = `${charN}退回了${userN}的红包`;
            rawResponseText = `[${charN}退回了${userN}的红包]`;
        } else if (actionType === "accept_transfer") {
            newStatus = "received";
            sysText = `${charN}领取了${userN}的转账`;
            rawResponseText = `[${charN}领取了${userN}的转账]`;
        } else if (actionType === "accept_payment_request") {
            newStatus = "paid";
            sysText = `${charN}接受了${userN}的代付请求`;
            rawResponseText = `[${charN}接受了${userN}的代付]`;
            settleShoppingPaymentRequest({
                orderId: targetMsg.mediaData?.shoppingOrderId,
                requestId: targetMsg.mediaData?.paymentRequestId,
                accepted: true,
                payerCharacterId: session.contactId,
                payerCharacterName: charN,
            });
        } else if (actionType === "decline_payment_request") {
            newStatus = "declined";
            sysText = `${charN}拒绝了${userN}的代付请求`;
            rawResponseText = `[${charN}拒绝了${userN}的代付]`;
            settleShoppingPaymentRequest({
                orderId: targetMsg.mediaData?.shoppingOrderId,
                requestId: targetMsg.mediaData?.paymentRequestId,
                accepted: false,
                payerCharacterId: session.contactId,
                payerCharacterName: charN,
            });
        } else {
            newStatus = "declined";
            sysText = `${charN}拒收了${userN}的转账`;
            rawResponseText = `[${charN}拒收了${userN}的转账]`;
        }

        const refundReason = actionType === "decline_red_packet" ? "红包退回" : actionType === "decline_transfer" ? "转账退回" : null;
        const updatedMediaData = {
            ...(refundReason ? refundOutgoingMoneyMessage(targetMsg, refundReason) : targetMsg.mediaData),
            status: newStatus,
            ...(targetMediaType === "payment_request" ? {
                paymentResolvedAt: new Date().toISOString(),
                paymentPayerId: session.contactId,
                paymentPayerName: charN,
            } : {}),
        };
        updateMessageMediaData(targetMsg.id, updatedMediaData);
        setMessages(prev => prev.map(m =>
            m.id === targetMsg.id ? { ...m, mediaData: updatedMediaData } : m
        ));
        // Insert action notification (correct role + mediaType for prompt formatting)
        const sysMsg = pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: sysText,
            mediaType: actionType as ChatMessage["mediaType"],
            ...buildAssistantActionEditMeta(rawResponseText),
        });
        setMessages(prev => [...prev, sysMsg]);
    };

    // ── 群聊红包/转账动作处理 ──
    // 获取消息发送人显示名（user→用户名，assistant→角色名）
    const getMsgSender = (m: ChatMessage) =>
        m.role === "user" ? (userIdentity?.name || "你") : (m.senderName || "未知");

    // 红包：按 ownerName 匹配发送人，领取/退回
    // 拼手气红包：随机分配金额（二倍均值法）
    const calcRedPacketShare = (totalAmount: number, claimedAmounts: Record<string, number>, totalRecipients: number): number => {
        const claimedTotal = Object.values(claimedAmounts).reduce((s, v) => s + v, 0);
        const remaining = totalAmount - claimedTotal;
        const claimedCount = Object.keys(claimedAmounts).length;
        const leftCount = totalRecipients - claimedCount;
        if (leftCount <= 1) return Math.round(remaining * 100) / 100; // 最后一个人拿剩余
        const avg = remaining / leftCount;
        const max = avg * 2;
        const share = Math.max(0.01, Math.random() * max);
        return Math.round(Math.min(share, remaining - 0.01 * (leftCount - 1)) * 100) / 100;
    };

    const handleGroupRedPacketAction = (action: "accept" | "decline", claimerName: string, ownerName?: string) => {
        // 从 localStorage 读最新数据，避免 processGroupParts 循环中多人领取时闭包过期
        const freshMessages = loadChatMessages(session.id);
        const targetMsg = [...freshMessages].reverse().find(m => {
            if (m.mediaType !== "red_packet") return false;
            if (m.mediaData?.status !== "pending" && m.mediaData?.status !== "opened") return false;
            // 已被领完的跳过
            if (m.mediaData?.status === "opened") {
                const cnt = m.mediaData?.count || 1;
                if ((m.mediaData?.claimedBy?.length || 0) >= cnt) return false;
            }
            if (!ownerName) return true;
            return getMsgSender(m) === ownerName;
        });
        if (!targetMsg) return;
        // 已领过的不能重复领
        if (targetMsg.mediaData?.claimedBy?.includes(claimerName)) return;
        const owner = ownerName || getMsgSender(targetMsg);
        const ownerDisplay = owner === (userIdentity?.name) ? "你" : owner;
        // 发红包的人自己不能领
        if (claimerName === owner) return;
        const totalRecipients = targetMsg.mediaData?.count || 1;
        // 已领满则拒绝
        if ((targetMsg.mediaData?.claimedBy?.length || 0) >= totalRecipients) return;
        if (action === "accept") {
            const prevAmounts = targetMsg.mediaData?.claimedAmounts || {};
            const share = calcRedPacketShare(targetMsg.mediaData?.amount || 0, prevAmounts, totalRecipients);
            const claimedBy = [...(targetMsg.mediaData?.claimedBy || []), claimerName];
            const claimedAmounts = { ...prevAmounts, [claimerName]: share };
            // 所有人都领完才标记 opened，否则保持 pending 让其他人继续领
            const allClaimed = claimedBy.length >= totalRecipients;
            const newStatus = allClaimed ? "opened" as const : "pending" as const;
            const updatedData = { ...targetMsg.mediaData, status: newStatus, claimedBy, claimedAmounts };
            updateMessageMediaData(targetMsg.id, updatedData);
            setMessages(prev => prev.map(m => m.id === targetMsg.id ? { ...m, mediaData: updatedData } : m));
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: `${claimerName}领取了${ownerDisplay}的红包，金额:${share}元`,
                mediaType: "accept_red_packet",
                mediaData: { claimer: claimerName, owner: ownerDisplay },
                senderName: claimerName,
                ...buildAssistantActionEditMeta(`[${claimerName}领取了${ownerDisplay}的红包]`),
            });
            setMessages(prev => [...prev, sysMsg]);
        } else {
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: `${claimerName}退回了${ownerDisplay}的红包`,
                mediaType: "decline_red_packet",
                mediaData: { claimer: claimerName, owner: ownerDisplay },
                senderName: claimerName,
                ...buildAssistantActionEditMeta(`[${claimerName}退回了${ownerDisplay}的红包]`),
            });
            setMessages(prev => [...prev, sysMsg]);
        }
    };

    // 转账：按 ownerName 匹配发送人，且验证 claimerName === recipientName
    const handleGroupTransferAction = (action: "accept" | "decline", claimerName: string, ownerName?: string) => {
        const freshMessages = loadChatMessages(session.id);
        const targetMsg = [...freshMessages].reverse().find(m => {
            if (m.mediaType !== "transfer" || m.mediaData?.status !== "pending") return false;
            if (!ownerName) return true;
            const sender = m.mediaData?.senderName || getMsgSender(m);
            return sender === ownerName;
        });
        if (!targetMsg) return;
        // 验证：只有收款人才能接受/拒收
        const recipient = targetMsg.mediaData?.recipientName;
        if (recipient && recipient !== claimerName) return; // 非收款人，操作无效
        const owner = ownerName || targetMsg.mediaData?.senderName || getMsgSender(targetMsg);
        const ownerDisplay = owner === (userIdentity?.name) ? "你" : owner;
        const newStatus = action === "accept" ? "received" as const : "declined" as const;
        const refundData = action === "decline" && targetMsg.role === "user"
            ? refundOutgoingMoneyMessage(targetMsg, "转账退回")
            : targetMsg.mediaData;
        const updatedData = { ...refundData, status: newStatus };
        updateMessageMediaData(targetMsg.id, updatedData);
        setMessages(prev => prev.map(m => m.id === targetMsg.id ? { ...m, mediaData: updatedData } : m));
        const isAccept = action === "accept";
        const sysText = isAccept
            ? `${claimerName}领取了${ownerDisplay}的转账`
            : `${claimerName}退回了${ownerDisplay}的转账`;
        const sysMsg = pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: sysText,
            mediaType: isAccept ? "accept_transfer" : "decline_transfer",
            mediaData: { claimer: claimerName, owner: ownerDisplay },
            senderName: claimerName,
            ...buildAssistantActionEditMeta(
                isAccept
                    ? `[${claimerName}领取了${ownerDisplay}的转账]`
                    : `[${claimerName}退回了${ownerDisplay}的转账]`
            ),
        });
        setMessages(prev => [...prev, sysMsg]);
    };

    const handleGroupPaymentRequestAction = (action: "accept" | "decline", claimerName: string, ownerName?: string) => {
        const freshMessages = loadChatMessages(session.id);
        const targetMsg = [...freshMessages].reverse().find(m => {
            if (m.mediaType !== "payment_request" || m.mediaData?.status !== "pending") return false;
            if (!ownerName) return true;
            const sender = m.mediaData?.paymentRequesterName || m.mediaData?.senderName || getMsgSender(m);
            return sender === ownerName;
        });
        if (!targetMsg) return;
        const owner = ownerName || targetMsg.mediaData?.paymentRequesterName || targetMsg.mediaData?.senderName || getMsgSender(targetMsg);
        const ownerDisplay = owner === (userIdentity?.name) ? "你" : owner;
        const isAccept = action === "accept";
        const updatedData = {
            ...targetMsg.mediaData,
            status: isAccept ? "paid" as const : "declined" as const,
            paymentResolvedAt: new Date().toISOString(),
            paymentPayerName: claimerName,
        };
        if (targetMsg.role === "user") {
            settleShoppingPaymentRequest({
                orderId: targetMsg.mediaData?.shoppingOrderId,
                requestId: targetMsg.mediaData?.paymentRequestId,
                accepted: isAccept,
                payerCharacterName: claimerName,
            });
        }
        updateMessageMediaData(targetMsg.id, updatedData);
        setMessages(prev => prev.map(m => m.id === targetMsg.id ? { ...m, mediaData: updatedData } : m));
        const sysText = isAccept
            ? `${claimerName}接受了${ownerDisplay}的代付请求`
            : `${claimerName}拒绝了${ownerDisplay}的代付请求`;
        const sysMsg = pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: sysText,
            mediaType: isAccept ? "accept_payment_request" : "decline_payment_request",
            mediaData: { claimer: claimerName, owner: ownerDisplay },
            senderName: claimerName,
            ...buildAssistantActionEditMeta(
                isAccept
                    ? `[${claimerName}接受了${ownerDisplay}的代付]`
                    : `[${claimerName}拒绝了${ownerDisplay}的代付]`
            ),
        });
        setMessages(prev => [...prev, sysMsg]);
    };

    // Group admin action from AI output: validate permission + apply.
    // Returns display fields, or null when the tag must be silently dropped.
    const applyAIGroupAdminAction = (actorCharacterId: string, data: ChatMessage["mediaData"]) => {
        if (!session.isGroup || !data?.adminAction) return null;
        const action = data.adminAction as GroupAdminAction;
        const userN = userIdentity?.name || "用户";
        const actorKey = resolveGroupMemberKeyByName(session, data.adminActorName || "", userN);
        // 执行人必须是输出该标签的角色本人
        if (!actorKey || actorKey !== actorCharacterId) return null;
        const targetKey = resolveGroupMemberKeyByName(session, data.adminTargetName || "", userN, { includeOutsiders: action === "invite" });
        if (!targetKey) return null;
        if (!canGroupAdminAct(session, actorKey, action, targetKey)) return null;
        applyGroupAdminAction(session, action, actorKey, targetKey, data.adminMuteMinutes);
        const actorDisplay = getGroupMemberDisplayName(actorKey, userN);
        const targetDisplay = getGroupMemberDisplayName(targetKey, userN);
        return {
            content: buildGroupAdminNoticeText(action, actorDisplay, targetDisplay, data.adminMuteMinutes),
            mediaData: {
                adminAction: action,
                adminActorName: actorDisplay,
                adminTargetName: targetDisplay,
                ...(action === "mute" ? { adminMuteMinutes: data.adminMuteMinutes || 10 } : {}),
            } as ChatMessage["mediaData"],
            senderName: actorDisplay,
        };
    };

    // Helper: process group chat AI response parts with media filtering
    const processGroupParts = async (
        results: { characterId: string; characterName: string; responseText: string }[],
        msgsSetter: typeof setMessages,
        guard?: GenerationRunGuard,
        roundReasoning?: string,
        // 流式生成已让用户看着内容长出来了：落库改为立即放出，跳过 800ms 模拟打字节奏，
        // 否则预览流完一遍后消息又逐条「重播」一遍，观感像两次流式
        revealOptions?: { instantReveal?: boolean },
    ) => {
        throwIfGenerationStopped(guard);
        const responseRoundId = createResponseRoundId();
        const editableResponseText = buildEditableGroupRoundText(results);
        // 群聊一轮回复只有一份思维链，挂到本轮第一条落库消息上
        let reasoningAttached = !roundReasoning;
        const takeRoundReasoning = (): string | undefined => {
            if (reasoningAttached) return undefined;
            reasoningAttached = true;
            return roundReasoning;
        };
        const imageReplacementTasks: Promise<unknown>[] = [];
        const currentStateByCharacter = new Map<string, StateValue[]>();
        const getCurrentStateForCharacter = (characterId: string): StateValue[] => {
            const cached = currentStateByCharacter.get(characterId);
            if (cached) return cached;
            const latest = getLatestCharacterStateValues(characterId);
            currentStateByCharacter.set(characterId, latest);
            return latest;
        };
        let isFirst = true;
        for (const r of results) {
            throwIfGenerationStopped(guard);
            // 被踢出或禁言中的角色本轮不再发声
            if (!(session.participantIds || []).includes(r.characterId)) continue;
            if (isGroupMuted(session, r.characterId)) continue;
            const responseBatchId = createResponseBatchId();
            const { parts: rawParts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(r.responseText, getCurrentStateForCharacter(r.characterId));
            const parts = stripInvalidStickerParts(rawParts, r.characterId);
            let attachedState = false;
            let savedAnyPart = false;
            for (const part of parts) {
                throwIfGenerationStopped(guard);
                // Filter action types
                if (part.mediaType === "voice_call" || part.mediaType === "video_call") {
                    if (session.isSpectator) continue; // 围观群不能把用户卷进群通话
                    const callType = part.mediaType === "voice_call" ? "voice" : "video";
                    const isHidden = !mountedRef.current || !isChatRoomElementVisible(wrapperRef.current);
                    if (isHidden) {
                        window.dispatchEvent(new CustomEvent("ai-call-trigger", {
                            detail: { sessionId: session.id, type: callType, characterName: r.characterName },
                        }));
                    } else {
                        setCallInitiator("character");
                        setCallInitiatorName(r.characterName);
                        if (callType === "voice") setShowVoiceCall(true);
                        else setShowVideoCall(true);
                    }
                    continue;
                }
                if (part.mediaType === "accept_red_packet") {
                    throwIfGenerationStopped(guard);
                    const claimer = part.mediaData?.claimer || r.characterName;
                    const owner = part.mediaData?.owner;
                    handleGroupRedPacketAction("accept", claimer, owner);
                    continue;
                }
                if (part.mediaType === "decline_red_packet") {
                    throwIfGenerationStopped(guard);
                    const claimer = part.mediaData?.claimer || r.characterName;
                    const owner = part.mediaData?.owner;
                    handleGroupRedPacketAction("decline", claimer, owner);
                    continue;
                }
                if (part.mediaType === "accept_transfer") {
                    throwIfGenerationStopped(guard);
                    const claimer = part.mediaData?.claimer || r.characterName;
                    const owner = part.mediaData?.owner;
                    handleGroupTransferAction("accept", claimer, owner);
                    continue;
                }
                if (part.mediaType === "decline_transfer") {
                    throwIfGenerationStopped(guard);
                    const claimer = part.mediaData?.claimer || r.characterName;
                    const owner = part.mediaData?.owner;
                    handleGroupTransferAction("decline", claimer, owner);
                    continue;
                }
                if (part.mediaType === "accept_payment_request") {
                    throwIfGenerationStopped(guard);
                    const claimer = part.mediaData?.claimer || r.characterName;
                    const owner = part.mediaData?.owner;
                    handleGroupPaymentRequestAction("accept", claimer, owner);
                    continue;
                }
                if (part.mediaType === "decline_payment_request") {
                    throwIfGenerationStopped(guard);
                    const claimer = part.mediaData?.claimer || r.characterName;
                    const owner = part.mediaData?.owner;
                    handleGroupPaymentRequestAction("decline", claimer, owner);
                    continue;
                }
                if (part.mediaType === "group_admin_notice") {
                    if (!isFirst && !revealOptions?.instantReveal) await abortableDelay(800, guard?.signal);
                    throwIfGenerationStopped(guard);
                    const applied = applyAIGroupAdminAction(r.characterId, part.mediaData);
                    if (!applied) continue; // 无权限/名字不合法：整个标签静默丢弃
                    isFirst = false;
                    // 带上段落自己的 batch 元数据（与拍一拍同款）：
                    // 投影层按 batch 连续排布，缺了会被后续气泡挤到整段末尾
                    const msg = pushChatMessage({
                        sessionId: session.id, role: "assistant",
                        content: applied.content,
                        mediaType: "group_admin_notice",
                        mediaData: applied.mediaData,
                        responseBatchId,
                        rawResponseText: r.responseText,
                        responseRoundId,
                        editableResponseText,
                        // 系统小字样式不显示面板，不在这里挂载（见 canCarryFoldedPanel）
                        senderCharacterId: r.characterId,
                        senderName: applied.senderName,
                    });
                    savedAnyPart = true;
                    msgsSetter(prev => [...prev, msg]);
                    continue;
                }
                // Poke: keep it as a poke media message so UI renders it as a system notice.
                if (part.mediaType === "poke") {
                    const pokeSender = (part.mediaData?.pokeSender === "我" ? r.characterName : part.mediaData?.pokeSender) || r.characterName;
                    const pokeTarget = part.mediaData?.pokeTarget || "某人";
                    if (!isFirst && !revealOptions?.instantReveal) await abortableDelay(800, guard?.signal);
                    throwIfGenerationStopped(guard);
                    isFirst = false;
                    const msg = pushChatMessage({
                        sessionId: session.id, role: "assistant",
                        content: `${pokeSender} 拍了拍 ${pokeTarget}`,
                        mediaType: "poke",
                        mediaData: { pokeSender, pokeTarget },
                        responseBatchId,
                        rawResponseText: r.responseText,
                        responseRoundId,
                        editableResponseText,
                        // 系统小字样式不显示面板，不在这里挂载（见 canCarryFoldedPanel）
                        senderCharacterId: r.characterId,
                        senderName: pokeSender,
                    });
                    savedAnyPart = true;
                    msgsSetter(prev => [...prev, msg]);
                    dispatchChatMessageNotice({
                        sessionId: session.id,
                        senderName: session.groupName || "群聊",
                        body: `${pokeSender}: ${msg.content}`.slice(0, 80),
                        isGroup: true,
                    });
                    continue;
                }
                if (!isFirst && !revealOptions?.instantReveal) await abortableDelay(800, guard?.signal);
                throwIfGenerationStopped(guard);
                isFirst = false;
                const attachHere = !attachedState && canCarryFoldedPanel(part);
                const draft = buildAssistantMessageDraft(part, {
                    sessionId: session.id,
                    role: "assistant",
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    responseBatchId,
                    rawResponseText: r.responseText,
                    responseRoundId,
                    editableResponseText,
                    statusPanel: attachHere && statusPanel ? statusPanel : undefined,
                    statusRegionMode: customStatusActive && attachHere && statusPanel ? "custom" as const : undefined,
                    innerMonologue: attachHere && innerMonologue ? innerMonologue : undefined,
                    reasoningText: takeRoundReasoning(),
                    stateValues: attachHere && stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues: attachHere ? freshStateValues : undefined,
                    senderCharacterId: r.characterId,
                    senderName: r.characterName,
                }, guard);
                throwIfGenerationStopped(guard);
                const msg = pushChatMessage(draft);
                imageReplacementTasks.push(scheduleGeneratedImageReplacement(msg, r.characterId, guard));
                if (attachHere) attachedState = true;
                savedAnyPart = true;
                msgsSetter(prev => [...prev, msg]);
                const body = msg.content.trim()
                    || (msg.mediaType === "media_file" && msg.mediaData?.fileType === "image" && msg.mediaData?.label
                        ? `发了一张照片: ${msg.mediaData.label}`
                        : (msg.mediaType ? "发来一条消息" : ""));
                dispatchChatMessageNotice({
                    sessionId: session.id,
                    senderName: session.groupName || "群聊",
                    body: `${r.characterName}: ${body}`.slice(0, 80),
                    isGroup: true,
                });
            }
            // 面板没落到任何正常气泡上（纯静默，或整段只有拍一拍/群管理通知）→ 补空消息驮面板
            if (!attachedState && (statusPanel || innerMonologue || stateValues.length > 0)) {
                throwIfGenerationStopped(guard);
                const msg = pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: "",
                    responseBatchId,
                    rawResponseText: r.responseText,
                    responseRoundId,
                    editableResponseText,
                    statusPanel,
                    statusRegionMode: customStatusActive && statusPanel ? "custom" as const : undefined,
                    innerMonologue,
                    reasoningText: takeRoundReasoning(),
                    stateValues: stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues,
                    senderCharacterId: r.characterId,
                    senderName: r.characterName,
                });
                msgsSetter(prev => [...prev, msg]);
            }
            if (stateValues.length > 0) {
                currentStateByCharacter.set(r.characterId, stateValues);
            }
        }
        if (imageReplacementTasks.length > 0) {
            await Promise.allSettled(imageReplacementTasks);
            throwIfGenerationStopped(guard);
        }
    };

    // AI auto-play: search & play a song by title/artist when AI recommends music
    const autoPlayMusic = async (title: string, charName: string, artist?: string) => {
        const musicBridge = getMusicControlBridge();
        if (!musicBridge) { console.warn("[AutoPlay] MusicPlayer not available"); return; }
        try {
            const found = await findPlayableMatch(title, artist);
            if (!found) {
                const playMsg = pushChatMessage({ sessionId: session.id, role: "system", content: `${charName}播放了「${title}」`, mediaType: "music_notify" });
                const failMsg = pushChatMessage({ sessionId: session.id, role: "system", content: "没有找到这个音乐哦~", mediaType: "music_not_found", mediaData: { musicTitle: title } });
                setMessages(prev => [...prev, playMsg, failMsg]);
                return;
            }

            let playedTitle = title;
            const { result: match, playUrl } = found;
            if (match.source === "local" && match.localTrack) {
                await musicBridge.playTrack(match.localTrack);
                playedTitle = match.localTrack.title;
            } else if (match.source === "netease" && match.neteaseResult && playUrl) {
                const r = match.neteaseResult;
                const detail = await getNeteaseSongDetail(r.id);
                const lyrics = await getNeteaseLyrics(r.id);
                playedTitle = detail?.name || r.name;
                await musicBridge.playTrack({
                    id: `netease_${r.id}`,
                    title: playedTitle,
                    artist: detail?.artists || r.artists,
                    duration: r.duration / 1000,
                    coverUrl: detail?.coverUrl,
                    lyrics,
                    liked: false,
                    addedAt: new Date().toISOString(),
                });
            }
            const okMsg = pushChatMessage({ sessionId: session.id, role: "system", content: `${charName}播放了「${playedTitle}」`, mediaType: "music_notify" });
            setMessages(prev => [...prev, okMsg]);
        } catch (err) {
            console.warn("[AutoPlay] Failed:", err);
            const playMsg = pushChatMessage({ sessionId: session.id, role: "system", content: `${charName}播放了「${title}」`, mediaType: "music_notify" });
            const failMsg = pushChatMessage({ sessionId: session.id, role: "system", content: "没有找到这个音乐哦~" });
            setMessages(prev => [...prev, playMsg, failMsg]);
        }
    };


    const clearStuckGeneration = () => {
        setIsRetryingOffline(false);
        const cancelledRun = cancelGenerationRun(session.id);
        cancelBackgroundGeneration(session.id);
        cancelBailoutKey(`reply:${session.id}`);
        if (cancelledRun?.pendingNativeToolCalls.length) {
            for (const call of cancelledRun.pendingNativeToolCalls) {
                pushChatMessage({
                    sessionId: session.id,
                    role: "tool",
                    content: "本次动作已被用户取消。",
                    mediaType: "tool_result",
                    nativeToolResult: {
                        toolCallId: call.id,
                        name: call.name,
                        content: "本次动作已被用户取消。",
                    },
                });
            }
        }
        isGeneratingRef.current = false;
        setIsGenerating(false);
        clearGenerationLock(session.id);
        setPendingGenerate(true);
        syncMessagesFromStorage();
        showChatToast("已停止本轮生成");
    };

    const clearOfflineGeneration = () => {
        setIsRetryingOffline(false);
        const cancelled = cancelOfflineGenerationRun(session.id);
        if (!cancelled && !isOfflineGenerating) return;
        const pendingText = offlineGenerationInputRef.current || pendingOfflineUserText;
        offlineTextInputRef.current?.restoreIfEmpty(pendingText);
        setPendingOfflineUserText("");
        offlineGenerationInputRef.current = "";
        setIsOfflineGenerating(false);
        showChatToast("已停止线下生成");
    };

    const stripEditableToolTags = (text: string) => text
        .replace(/\[[^\]]*?(?:获取指令|获取工具)[:：][^\]]*\]/g, "")
        .replace(/\[[^\]]*?(?:执行动作|工具调用)[:：][^\]]*?[（(][\s\S]*?[)）]\]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    const cleanEditableAssistantText = (text: string) => {
        const { cleanText } = parseActionTags(text);
        return stripEditableToolTags(cleanText);
    };

    const hasKnownGroupSenderPrefix = (text: string) => {
        return groupCharacters.some((groupCharacter) => {
            const escapedName = groupCharacter.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return new RegExp(`^\\[${escapedName}\\]:\\s*`, "m").test(text);
        });
    };

    const buildAssistantMessageDraft = (
        part: ParsedMessagePart,
        draft: AssistantMessageDraft,
        guard?: GenerationRunGuard,
    ): AssistantMessageDraft => {
        if (draft.mediaType === "tool_notice" || part.mediaType !== "image") return draft;

        const description = part.mediaData?.label?.trim();
        if (!description) return draft;

        throwIfGenerationStopped(guard);
        return {
            ...draft,
            mediaType: "image",
            mediaData: {
                ...createPendingChatGeneratedImageData(part.mediaData, description),
                inTransitRemainingSeconds: draft.mediaData?.inTransitRemainingSeconds,
                inTransitRemainingMinutes: draft.mediaData?.inTransitRemainingMinutes,
            },
        };
    };

    const scheduleGeneratedImageReplacement = (
        message: ChatMessage,
        characterId?: string,
        guard?: GenerationRunGuard,
    ): Promise<ChatMessage | null> => {
        if (!isPendingChatGeneratedImageMessage(message)) return Promise.resolve(null);
        return generateAndApplyChatGeneratedImage(message, characterId || session.contactId, { signal: guard?.signal })
            .catch(error => {
                if (!isAbortLikeError(error)) {
                    console.warn("[ImageGeneration] Failed to generate chat image:", error);
                    const reason = error instanceof Error ? error.message : String(error);
                    setImageGenerationFailure(prev => prev ?? reason);
                }
                return null;
            });
    };

    // ── Music Card Click-to-Play ──
    const handleMusicCardPlay = async (title: string, artist?: string) => {
        const musicBridge = getMusicControlBridge();
        if (!musicBridge) { showChatToast("音乐播放器未就绪"); return; }
        showPersistentChatToast("加载音乐中...");
        try {
            const found = await findPlayableMatch(title, artist);
            if (!found) {
                showChatToast("没有找到该音乐哦~");
                return;
            }
            const { result: match, playUrl } = found;
            if (match.source === "local" && match.localTrack) {
                await musicBridge.playTrack(match.localTrack);
            } else if (match.source === "netease" && match.neteaseResult && playUrl) {
                const r = match.neteaseResult;
                const detail = await getNeteaseSongDetail(r.id);
                const lyrics = await getNeteaseLyrics(r.id);
                await musicBridge.playTrack({
                    id: `netease_${r.id}`,
                    title: detail?.name || r.name,
                    artist: detail?.artists || r.artists,
                    duration: r.duration / 1000,
                    coverUrl: detail?.coverUrl,
                    lyrics,
                    liked: false,
                    addedAt: new Date().toISOString(),
                });
            }
            clearChatToast();
        } catch {
            showChatToast("没有找到该音乐哦~");
        }
    };

    // Helper: Split AI response by \n\n into multiple messages (online chat mode)
    // Uses shared parseAIResponse for rich-media support.
    // Returns { hasVisible, stateValues, hasDecline } — hasVisible is false if the AI chose [静默].
    const splitAndSaveAIMessages = async (
        aiResponseText: string,
        options?: {
            responseBatchId?: string;
            rawResponseText?: string;
            reasoningText?: string;
            /** 流式生成场景：用户已看过内容逐段长出，落库立即放出、跳过模拟打字节奏 */
            instantReveal?: boolean;
            isKnockThresholdTriggered?: boolean;
        } & GenerationRunGuard,
    ): Promise<{ hasVisible: boolean; stateValues: StateValue[]; triggerCall?: "voice" | "video"; hasDecline?: boolean }> => {
        throwIfGenerationStopped(options);
        const responseBatchId = options?.responseBatchId || createResponseBatchId();
        const rawResponseText = options?.rawResponseText ?? aiResponseText;
        const previousState = session.isGroup
            ? getLatestStateValues(session.id)
            : getLatestCharacterStateValues(session.contactId);

        const { parts: rawParts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(aiResponseText, previousState);
        const parts = stripInvalidStickerParts(rawParts);
        throwIfGenerationStopped(options);

        // Detect call triggers and AI media actions, filter them out
        let triggerCall: "voice" | "video" | undefined;
        let hasDecline = false;
        let shouldAutoExpandInviteModalAfterTyping = false;
        let shouldAutoExpandUnlockModalAfterTyping = false;
        let pendingOfflineLockNotice: { text: string; lockData: OfflineLockData } | null = null;
        let pendingOfflineUnlockNotice: { text: string; totalKnocks?: number } | null = null;
        let pendingOfflineInviteNotice: { content: string; inviteData: OfflineInviteData } | null = null;

        // 黄金边界铁律：严格检测同一轮中是否【同时触发】解除封禁与线下邀约（碰撞场景）
        // 只有当两者在同一轮同时触发时，才启用让位与顺位排队；独立触发时各自行为 100% 保持原有逻辑！
        const hasUnlockCandidate = Boolean(session.enableOfflineLock && !session.isGroup && parts.some(p => p.mediaType === "offline_unlock"));
        const hasInviteCandidate = Boolean(session.enableOfflineInvite && !session.isGroup && !offlineMode && parts.some(p => p.mediaType === "offline_invite" || p.mediaType === "offline_invite_change_place"));
        const isConcurrentUnlockAndInviteCandidate = hasUnlockCandidate && hasInviteCandidate;

        const charN = character?.name || "对方";
        const userN = userIdentity?.name || "你";
        const filteredParts: typeof parts = [];
        const afterPublishEffects: Array<((message: ChatMessage) => void) | undefined> = [];
        const pushFilteredPart = (part: (typeof parts)[number], afterPublish?: (message: ChatMessage) => void) => {
            filteredParts.push(part);
            afterPublishEffects.push(afterPublish);
        };

        const emitOfflineInviteNotice = (noticeContent: string, inviteData: OfflineInviteData) => {
            if (isConcurrentUnlockAndInviteCandidate) {
                // 顺位铁律：同一轮同时触发时，邀约小灰字不抢跑在开头，暂存等所有气泡发表完毕后，排在解封小灰字后面发布！
                pendingOfflineInviteNotice = { content: noticeContent, inviteData };
            } else {
                // 独立触发：100% 保持原有行为，立即在气泡前发出系统小灰字记录
                const sysMsg = pushChatMessage({
                    sessionId: session.id,
                    role: "system",
                    content: noticeContent,
                    mediaType: "offline_invite_system_notice",
                    mediaData: { offlineInvite: inviteData },
                    responseBatchId,
                });
                setMessages(prev => [...prev, sysMsg]);
            }
        };

        const publishOfflineLockNotices = () => {
            if (pendingOfflineLockNotice) {
                const sysMsg = pushChatMessage({
                    sessionId: session.id,
                    role: "system",
                    content: pendingOfflineLockNotice.text,
                    mediaType: "offline_lock_system_notice",
                    mediaData: { offlineLock: pendingOfflineLockNotice.lockData },
                    responseBatchId,
                });
                setMessages(prev => [...prev, sysMsg]);
                pendingOfflineLockNotice = null;
            }
            // 顺位铁律（同一轮同时触发时）：
            // 气泡下方严格按因果逻辑顺位展示：先展示解除封禁，再展示发起线下赴约提议！
            if (pendingOfflineUnlockNotice) {
                const unlockNoticeData = pendingOfflineUnlockNotice;
                const sysMsg = pushChatMessage({
                    sessionId: session.id,
                    role: "system",
                    content: unlockNoticeData.text,
                    mediaType: "offline_unlock_system_notice",
                    responseBatchId,
                });
                setMessages(prev => [...prev, sysMsg]);
                pendingOfflineUnlockNotice = null;

                // 叩门破防长期记忆沉淀：若本次被封禁期间用户曾执着叩门申请（totalKnocks > 0），在角色解封提示落库后触发记忆提炼
                if (unlockNoticeData.totalKnocks && unlockNoticeData.totalKnocks > 0) {
                    const uName = userIdentity?.name?.trim() || "你";
                    const cName = charN;
                    const fallbackContent = `「${cName}封禁线下与${uName}的叩门申请记录」：此前因矛盾情绪一度封锁了线下入口拒绝相见，${uName} 不顾被拒、坚持不懈地连续按下了整整 ${unlockNoticeData.totalKnocks} 次见面申请；心墙最终被对方的执着叩动并解除封禁，两人正式和好。`;
                    const allMsgs = loadChatMessages(session.id);
                    void summarizeAndSaveOfflineBondMemory({
                        characterId: session.contactId,
                        characterName: cName,
                        userName: uName,
                        eventType: "lock_knock",
                        count: unlockNoticeData.totalKnocks,
                        allStoredMessages: allMsgs,
                        fallbackContent,
                        customStylePrompt: session.offlineLockMemoryPrompt,
                    });
                }
            }
            if (pendingOfflineInviteNotice) {
                const sysMsg = pushChatMessage({
                    sessionId: session.id,
                    role: "system",
                    content: pendingOfflineInviteNotice.content,
                    mediaType: "offline_invite_system_notice",
                    mediaData: { offlineInvite: pendingOfflineInviteNotice.inviteData },
                    responseBatchId,
                });
                setMessages(prev => [...prev, sysMsg]);
                pendingOfflineInviteNotice = null;
            }
        };

        for (const p of parts) {
            throwIfGenerationStopped(options);
            if (p.mediaType === "voice_call") { triggerCall = "voice"; continue; }
            if (p.mediaType === "video_call") { triggerCall = "video"; continue; }
            if (p.mediaType === "offline_lock") {
                // 角色封禁线下入口：仅在 enableOfflineLock 私聊下生效
                if (session.enableOfflineLock && !session.isGroup && p.mediaData?.offlineLock) {
                    const { newLock, noticeText } = applyOfflineLockDirective(
                        session.id,
                        charN,
                        p.mediaData.offlineLock,
                        responseBatchId,
                        { isKnockThresholdTriggered: options?.isKnockThresholdTriggered },
                    );
                    setOfflineLockData(newLock);
                    offlineLockDataRef.current = newLock;

                    if (noticeText) {
                        pendingOfflineLockNotice = {
                            text: noticeText,
                            lockData: newLock,
                        };
                    }

                    // 封锁线下入口时彻底清理掉可能残留的待答应、在途或到达邀约卡片与胶囊，防止幽灵悬挂
                    // 因果一致性防御：不仅依赖 ref，还向 KV 和历史消息多重核验，确保取消邀约记录可靠入库
                    let curPendingInvite = activeOfflineInviteRef.current;
                    if (!curPendingInvite) {
                        try {
                            const raw = kvGet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id);
                            if (raw) curPendingInvite = JSON.parse(raw);
                        } catch {}
                    }
                    if (!curPendingInvite) {
                        const curMsgs = loadChatMessages(session.id);
                        curPendingInvite = restoreOfflineInviteFromMessages(curMsgs, null);
                    }

                    if (curPendingInvite) {
                        if (remindExpandTimerRef.current) {
                            clearTimeout(remindExpandTimerRef.current);
                            remindExpandTimerRef.current = null;
                        }
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                        kvRemove(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id);

                        // 因果时序保障：封禁前先留下取消赴约记录，保证时间线因果清晰自洽
                        const wasArrived = curPendingInvite.status === "arrived";
                        const cancelNoticeText = wasArrived ? `${charN} 已取消本次线下赴约` : `${charN} 已取消线下邀约提议`;
                        const cancelMsg = pushChatMessage({
                            sessionId: session.id,
                            role: "system",
                            content: cancelNoticeText,
                            mediaType: "offline_invite_system_notice",
                            responseBatchId,
                        });
                        setMessages(prev => [...prev, cancelMsg]);
                    }
                }
                continue;
            }
            if (p.mediaType === "offline_invite_cancel") {
                // 角色自主撤回待答应阶段的邀约提议 或 到达现场后取消赴约离开
                if (session.enableOfflineInvite && !session.isGroup) {
                    let curInvite = activeOfflineInviteRef.current;
                    if (!curInvite) {
                        try {
                            const raw = kvGet(ACTIVE_OFFLINE_INVITE_PREFIX + session.id);
                            if (raw) curInvite = JSON.parse(raw);
                        } catch {}
                    }
                    if (!curInvite) {
                        const curMsgs = loadChatMessages(session.id);
                        curInvite = restoreOfflineInviteFromMessages(curMsgs, null);
                    }
                    if (curInvite && (curInvite.status === "pending" || curInvite.status === "arrived")) {
                        const wasArrived = curInvite.status === "arrived";
                        if (remindExpandTimerRef.current) {
                            clearTimeout(remindExpandTimerRef.current);
                            remindExpandTimerRef.current = null;
                        }
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                        const charName = character?.name || "对方";
                        const noticeText = wasArrived ? `${charName} 已取消本次线下赴约` : `${charName} 已取消线下邀约提议`;
                        const cancelMsg = pushChatMessage({
                            sessionId: session.id,
                            role: "system",
                            content: noticeText,
                            mediaType: "offline_invite_system_notice",
                            responseBatchId,
                        });
                        setMessages(prev => [...prev, cancelMsg]);
                        showChatToast(wasArrived ? "对方已取消本次线下赴约" : "对方已取消线下邀约提议");
                    }
                }
                continue;
            }
            if (p.mediaType === "offline_unlock") {
                // 角色解除封禁：恢复线下入口，打上待前往标记，当前大事件翻篇
                if (session.enableOfflineLock && !session.isGroup) {
                    // 若此前处于封禁中且用户曾叩门，在清除 KV 前提取累计叩门次数供解封时提炼长期记忆
                    let totalKnocks = 0;
                    const lockedRaw = kvGet(OFFLINE_LOCK_PREFIX + session.id);
                    if (lockedRaw) {
                        try {
                            const lockedData: OfflineLockData = JSON.parse(lockedRaw);
                            totalKnocks = lockedData.stageKnocks || lockedData.knockCount || 0;
                        } catch {}
                    }

                    const { noticeText } = applyOfflineUnlockDirective(session.id, charN);
                    setOfflineLockData(null);
                    offlineLockDataRef.current = null;

                    pendingOfflineUnlockNotice = {
                        text: noticeText,
                        totalKnocks,
                    };
                    // 弹窗让位法则：若同一轮同时触发了线下赴约，解封确认小弹窗完全给赴约大卡片让位！
                    shouldAutoExpandUnlockModalAfterTyping = !isConcurrentUnlockAndInviteCandidate;
                }
                continue;
            }
            if (p.mediaType === "offline_invite_remind") {
                // 仅对“他来”（角色动身找用户）且处于 pending 状态时响应，重新唤醒弹窗
                const curInvite = activeOfflineInviteRef.current;
                if (session.enableOfflineInvite && !session.isGroup && curInvite && curInvite.status === "pending" && curInvite.direction === "he_comes") {
                    const currentMins = curInvite.durationMinutes || 15;
                    // 若角色最新回复中提到了具体时间，则更新；若没提，保留之前商定好的时间，绝不无故回退重置
                    const parsedMins = extractDurationMinutes(rawResponseText || "", currentMins);
                    const updatedInvite: OfflineInviteData = {
                        ...curInvite,
                        durationMinutes: parsedMins,
                    };
                    updateActiveOfflineInvite(updatedInvite);
                    setIsOfflineInviteMinimized(true);
                    lastRemindBatchIdRef.current = responseBatchId;
                    shouldAutoExpandInviteModalAfterTyping = true;
                }
                continue;
            }
            if (p.mediaType === "offline_invite" || p.mediaType === "offline_invite_change_place") {
                if (session.enableOfflineInvite && !session.isGroup && p.mediaData?.offlineInvite) {
                    if (offlineMode) {
                        continue;
                    }

                    // 若角色主动发起了线下邀约，自然解除此前的线下封禁并清除待前往标记（由邀约体系接管）
                    const lockedRaw = kvGet(OFFLINE_LOCK_PREFIX + session.id);
                    if (lockedRaw) {
                        try {
                            const lockedData: OfflineLockData = JSON.parse(lockedRaw);
                            const totalKnocks = lockedData.stageKnocks || lockedData.knockCount || 0;
                            if (totalKnocks > 0) {
                                const uName = userIdentity?.name?.trim() || "你";
                                const cName = charN;
                                const fallbackContent = `「${cName}封禁线下与${uName}的叩门申请记录」：此前因矛盾情绪一度封锁了线下入口拒绝相见，${uName} 不顾被拒、坚持不懈地连续按下了整整 ${totalKnocks} 次见面申请；心墙最终被对方的执着叩动并解除封禁，两人正式和好。`;
                                const allMsgs = loadChatMessages(session.id);
                                void summarizeAndSaveOfflineBondMemory({
                                    characterId: session.contactId,
                                    characterName: cName,
                                    userName: uName,
                                    eventType: "lock_knock",
                                    count: totalKnocks,
                                    allStoredMessages: allMsgs,
                                    fallbackContent,
                                    customStylePrompt: session.offlineLockMemoryPrompt,
                                });
                            }
                        } catch {}
                        kvRemove(OFFLINE_LOCK_PREFIX + session.id);
                        setOfflineLockData(null);
                    }
                    kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);

                    const curInvite = activeOfflineInviteRef.current;
                    const incoming = p.mediaData.offlineInvite;
                    const rawTimeStr = incoming.timeStr || "";
                    const rawReason = incoming.reason || "";
                    // 正文时间承诺优先：若正文包含明确时间承诺（如“等我十几分钟”），以此时间为准
                    const cleanSpeechText = (rawResponseText || "").replace(/\[(?:线下邀约|提醒赴约|更改地点|强行动身|强行赴约|霸道奔赴|执意赶来|执意奔赴)[^\]]*\]/g, "");
                    const speechMins = extractDurationMinutes(cleanSpeechText, 0);
                    const tagMins = extractDurationMinutes(rawTimeStr, 0);
                    const reasonMins = extractDurationMinutes(rawReason, 0);
                    const parsedMins = speechMins > 0 ? speechMins : (tagMins > 0 ? tagMins : (reasonMins > 0 ? reasonMins : 15));

                    if (!curInvite) {
                        if (p.mediaType === "offline_invite_change_place") {
                            continue;
                        }

                        // 地点未知防抢跑：正文仍在询问地点且非求助情境时，拦截提议让角色先问清地点
                        const asksForLocation = /(?:你在[哪哪儿里]|在[哪哪儿里]|去[哪哪儿里]|在哪个地方|发个?定位|你在家还是|在公司还是|到你身边找你好不好|去你身边找你好不好)/.test(cleanSpeechText);
                        const isByYourSide = !incoming.place || incoming.place === "你身边";
                        const recentUserMessages = messages.filter(m => m.role === "user").slice(-3);
                        const isCrisisOrHelp = recentUserMessages.some(m =>
                            m.mediaType === "location" ||
                            /(?:哭|眼泪|难受|好痛|好怕|救命|救我|喝醉|醉了|迷路|车祸|医院|走丢|好想见你|好想你在身边|快来陪我|来我身边)/.test(m.content || "")
                        );

                        if (asksForLocation && isByYourSide && !isCrisisOrHelp) {
                            continue;
                        }

                        const isForced = incoming.status === "on_the_way" || incoming.theme === "forced";
                        const inviteTheme = incoming.theme || (isForced ? "forced" : "default");
                        const inviteData: OfflineInviteData = {
                            direction: incoming.direction || "he_comes",
                            theme: inviteTheme,
                            place: incoming.place,
                            reason: incoming.reason,
                            onTheWayMessage: sanitizeTransitMessage(
                                incoming.onTheWayMessage,
                                incoming.direction || "he_comes",
                                incoming.place
                            ),
                            transitCardMessage: incoming.transitCardMessage,
                            arrivedMessage: incoming.arrivedMessage,
                            arrivalCardMessage: incoming.arrivalCardMessage,
                            status: isForced ? "on_the_way" : "pending",
                            startTime: isForced ? Date.now() : undefined,
                            durationMinutes: parsedMins,
                            initialPlace: incoming.place?.trim() || "你身边",
                            initialBatchId: responseBatchId,
                            sourceBatchId: responseBatchId,
                            relatedBatchIds: [responseBatchId],
                            hasFiredArrivalMessage: false,
                        };

                        updateActiveOfflineInvite(inviteData);
                        setIsOfflineInviteMinimized(true);

                        // 发起提议或动身时留下系统记录
                        const charName = character?.name || "对方";
                        const rawPlace = inviteData.place?.trim();
                        const placeStr = (inviteData.initialPlace === "你身边" || rawPlace === "你身边") ? "你身边" : (rawPlace ? `「${rawPlace}」` : "你身边");

                        let noticeContent = "";
                        if (isForced) {
                            noticeContent = `${charName} 已直接动身赶往${placeStr}`;
                        } else if (inviteTheme === "alert") {
                            noticeContent = inviteData.direction === "he_comes"
                                ? `${charName} “请求”前往${placeStr === "你身边" ? "你身边" : placeStr}找你碰面`
                                : `${charName} “邀请你”前往${placeStr}与Ta见面`;
                        } else {
                            noticeContent = `${charName} 向你发起了前往${placeStr === "你身边" ? "你身边的" : `${placeStr}的`}线下赴约提议`;
                        }

                        emitOfflineInviteNotice(noticeContent, inviteData);

                        // 强行动身时，角色的回复正文即为霸气动身宣言，无需也不再额外补发微信在途报备
                        if (isForced) {
                            // 强行动身直接进入在途，清空多余在途报备
                            inviteData.onTheWayMessage = "";
                        }

                        // 标记在打字结束后留足 3 秒供用户读完文本，再平滑自动展开大卡片
                        shouldAutoExpandInviteModalAfterTyping = true;
                        continue;
                    }

                    // ====== curInvite 已存在：无论大模型输出 [线下邀约] 还是 [更改地点]，统一处理赴约变动与方向转换 ======
                    const oldPlace = curInvite.place?.trim() || "";
                    const newPlace = incoming.place?.trim() || oldPlace;
                    const oldDirection = curInvite.direction || "he_comes";
                    const newDirection = incoming.direction || oldDirection;
                    const isDirectionChanged = Boolean(incoming.direction && incoming.direction !== oldDirection);
                    const isPlaceChanged = Boolean(newPlace && oldPlace && newPlace !== oldPlace);
                    const wasOnTheWay = curInvite.status === "on_the_way";
                    const wasArrived = curInvite.status === "arrived";
                    const wasPending = curInvite.status === "pending";

                    const charName = character?.name || "对方";
                    const placeStr = newPlace === "你身边" ? "你身边" : `「${newPlace}」`;
                    const newBatchIds = Array.from(new Set([
                        ...(curInvite.relatedBatchIds || []),
                        curInvite.initialBatchId,
                        curInvite.sourceBatchId,
                        responseBatchId,
                    ].filter(Boolean) as string[]));

                    // 单向情绪递进规则：未决赴约中，情绪只升不降（default -> alert -> forced），避免突兀降级
                    const resolveEscalatedTheme = (inc?: "default" | "alert" | "forced", cur?: "default" | "alert" | "forced"): "default" | "alert" | "forced" => {
                        if (inc === "forced" || cur === "forced") return "forced";
                        if (inc === "alert" || cur === "alert") return "alert";
                        return "default";
                    };

                    if (newDirection === "i_go") {
                        // 切换为 / 保持【我去】：角色处于现场等候，旧的【他来】所有在途报备、在途心语、到达呼唤、到达心语全部彻底作废！
                        const newReason = incoming.reason?.trim() || (wasPending ? curInvite.reason : "");
                        const updatedInvite: OfflineInviteData = {
                            direction: "i_go",
                            theme: resolveEscalatedTheme(incoming.theme, curInvite.theme),
                            place: newPlace,
                            reason: newReason,
                            status: "pending",
                            initialPlace: curInvite.initialPlace || curInvite.place || "你身边",
                            initialBatchId: curInvite.initialBatchId || curInvite.sourceBatchId || responseBatchId,
                            sourceBatchId: curInvite.sourceBatchId || responseBatchId,
                            relatedBatchIds: newBatchIds,
                            hasFiredArrivalMessage: false,
                        };
                        updateActiveOfflineInvite(updatedInvite);
                        setIsOfflineInviteMinimized(true);

                        const isThemeChanged = Boolean(updatedInvite.theme && updatedInvite.theme !== (curInvite.theme || "default"));
                        if (isDirectionChanged || isPlaceChanged || isThemeChanged) {
                            let noticeContent = "";
                            if (updatedInvite.theme === "alert" && curInvite.theme !== "alert") {
                                noticeContent = `${charName} “邀请你”前往${placeStr}与Ta见面`;
                            } else if (isDirectionChanged) {
                                if (wasOnTheWay) {
                                    noticeContent = isPlaceChanged
                                        ? `赴约地点已更改为${placeStr}，对方正在现场等候你碰面`
                                        : (newPlace === "你身边" ? "碰头方式已变更为由你前去找对方" : `碰头方式已变更为由你前往${placeStr}找对方`);
                                } else if (wasArrived) {
                                    noticeContent = isPlaceChanged
                                        ? `赴约地点已更改为${placeStr}，对方正在现场等候你碰面`
                                        : (newPlace === "你身边" ? "碰头方式已变更为由你前去找对方" : `碰头方式已变更为由你前往${placeStr}找对方`);
                                } else {
                                    noticeContent = isPlaceChanged
                                        ? `赴约地点已更改为${placeStr}，对方正在现场等候你碰面`
                                        : (newPlace === "你身边" ? "赴约提议已变更为由你前去找对方" : `赴约提议已变更为由你前往${placeStr}找对方`);
                                }
                            } else {
                                noticeContent = `赴约提议地点已更改为${placeStr}`;
                            }

                            emitOfflineInviteNotice(noticeContent, updatedInvite);
                        }

                        // 【我去】模式打字完成后延迟 3 秒展开弹窗
                        shouldAutoExpandInviteModalAfterTyping = true;
                    } else {
                        // 切换为 / 保持【他来】
                        if (wasArrived && isPlaceChanged) {
                            // 角色到达后用户告知改地点：重新在途赶路！
                            const durationMins = parsedMins > 0 ? parsedMins : 5;
                            const newTransitCardMessage = incoming.transitCardMessage?.trim()
                                || (newPlace === "你身边" ? "正重新赶去你身边，稍等我片刻，马上就到。" : `正重新赶往${newPlace}的途中，稍候片刻。`);
                            const newArrivedMessage = incoming.arrivedMessage?.trim()
                                || (newPlace === "你身边" ? "我到了，在附近等你，不用着急慢慢走。" : `我已经到${newPlace}了，在附近等你，不用着急慢慢走。`);
                            const newArrivalCardMessage = incoming.arrivalCardMessage?.trim()
                                || (newPlace === "你身边" ? "已经在你身边了，安静等候碰面的那一刻。" : `已经赶到${newPlace}了，在安静等候你，慢慢走别急。`);

                            const updatedInvite: OfflineInviteData = {
                                direction: "he_comes",
                                theme: resolveEscalatedTheme(incoming.theme, curInvite.theme),
                                place: newPlace,
                                reason: incoming.reason?.trim() || curInvite.reason,
                                status: "on_the_way",
                                durationMinutes: durationMins,
                                startTime: Date.now(),
                                transitCardMessage: newTransitCardMessage,
                                arrivedMessage: newArrivedMessage,
                                arrivalCardMessage: newArrivalCardMessage,
                                initialPlace: curInvite.initialPlace || curInvite.place || "你身边",
                                initialBatchId: curInvite.initialBatchId || curInvite.sourceBatchId || responseBatchId,
                                sourceBatchId: curInvite.sourceBatchId || responseBatchId,
                                relatedBatchIds: newBatchIds,
                                hasFiredArrivalMessage: false,
                            };
                            updateActiveOfflineInvite(updatedInvite);

                            emitOfflineInviteNotice(`${charName} 已得知新地点，正在重新赶往${placeStr}`, updatedInvite);

                            setIsOfflineInviteMinimized(true);
                            shouldAutoExpandInviteModalAfterTyping = true;
                        } else if (wasOnTheWay && isPlaceChanged) {
                            // 在途中改地点（外卖中途改地址）：平滑更新地点，不打断倒计时（除非特别指定了新用时）
                            const newTransitCardMessage = incoming.transitCardMessage?.trim()
                                || (newPlace === "你身边" ? "正重新赶去你身边，稍等我片刻，马上就到。" : `正重新赶往${newPlace}的途中，稍候片刻。`);
                            const newArrivedMessage = incoming.arrivedMessage?.trim()
                                || (newPlace === "你身边" ? "我到了，在附近等你，不用着急慢慢走。" : `我已经到${newPlace}了，在附近等你，不用着急慢慢走。`);
                            const newArrivalCardMessage = incoming.arrivalCardMessage?.trim()
                                || (newPlace === "你身边" ? "已经在你身边了，安静等候碰面的那一刻。" : `已经赶到${newPlace}了，在安静等候你，慢慢走别急。`);

                            const updatedInvite: OfflineInviteData = {
                                ...curInvite,
                                direction: "he_comes",
                                theme: resolveEscalatedTheme(incoming.theme, curInvite.theme),
                                place: newPlace,
                                transitCardMessage: newTransitCardMessage,
                                arrivedMessage: newArrivedMessage,
                                arrivalCardMessage: newArrivalCardMessage,
                                initialPlace: curInvite.initialPlace || curInvite.place || "你身边",
                                ...(parsedMins > 0 && parsedMins !== curInvite.durationMinutes ? { durationMinutes: parsedMins, startTime: Date.now() } : {}),
                                sourceBatchId: curInvite.sourceBatchId || responseBatchId,
                                relatedBatchIds: newBatchIds,
                                hasFiredArrivalMessage: false,
                            };
                            updateActiveOfflineInvite(updatedInvite);

                            emitOfflineInviteNotice(`赴约地点已更改为${placeStr}`, updatedInvite);

                            setIsOfflineInviteMinimized(true);
                            shouldAutoExpandInviteModalAfterTyping = true;
                        } else if (wasPending) {
                            const isIncomingForced = incoming.status === "on_the_way" || incoming.theme === "forced";
                            if (isIncomingForced) {
                                // 角色强制动身前往用户身边
                                const durationMins = parsedMins > 0 ? parsedMins : (curInvite.durationMinutes || 15);
                                const sanitizedOnTheWay = incoming.onTheWayMessage?.trim()
                                    ? sanitizeTransitMessage(incoming.onTheWayMessage, "he_comes", newPlace)
                                    : "我拿了车钥匙这就出门去找你，等我片刻。";

                                const updatedInvite: OfflineInviteData = {
                                    ...curInvite,
                                    direction: "he_comes",
                                    theme: "forced",
                                    place: newPlace,
                                    reason: incoming.reason?.trim() || curInvite.reason,
                                    status: "on_the_way",
                                    durationMinutes: durationMins,
                                    startTime: Date.now(),
                                    onTheWayMessage: sanitizedOnTheWay,
                                    transitCardMessage: incoming.transitCardMessage || curInvite.transitCardMessage,
                                    arrivedMessage: incoming.arrivedMessage || curInvite.arrivedMessage,
                                    arrivalCardMessage: incoming.arrivalCardMessage || curInvite.arrivalCardMessage,
                                    initialPlace: curInvite.initialPlace || curInvite.place || "你身边",
                                    sourceBatchId: curInvite.sourceBatchId || responseBatchId,
                                    relatedBatchIds: newBatchIds,
                                    hasFiredArrivalMessage: false,
                                };
                                updateActiveOfflineInvite(updatedInvite);

                                emitOfflineInviteNotice(`${charName} 已直接动身赶往${placeStr}`, updatedInvite);

                                // 强行动身时回复正文已为动身宣言，无需再补发微信在途报备
                                updatedInvite.onTheWayMessage = "";

                                setIsOfflineInviteMinimized(true);
                                shouldAutoExpandInviteModalAfterTyping = true;
                            } else {
                                // 待答应阶段改地点，或从【我去】转为【他来】，或重试/再次确认提议
                                const sanitizedOnTheWay = incoming.onTheWayMessage?.trim()
                                    ? sanitizeTransitMessage(incoming.onTheWayMessage, "he_comes", newPlace)
                                    : sanitizeTransitMessage(undefined, "he_comes", newPlace);

                                const updatedInvite: OfflineInviteData = {
                                    ...curInvite,
                                    direction: "he_comes",
                                    theme: resolveEscalatedTheme(incoming.theme, curInvite.theme),
                                    place: newPlace,
                                    reason: incoming.reason?.trim() || curInvite.reason,
                                    onTheWayMessage: sanitizedOnTheWay,
                                    transitCardMessage: incoming.transitCardMessage || curInvite.transitCardMessage,
                                    arrivedMessage: incoming.arrivedMessage || curInvite.arrivedMessage,
                                    arrivalCardMessage: incoming.arrivalCardMessage || curInvite.arrivalCardMessage,
                                    status: "pending",
                                    durationMinutes: parsedMins > 0 ? parsedMins : curInvite.durationMinutes,
                                    initialPlace: curInvite.initialPlace || curInvite.place || "你身边",
                                    initialBatchId: curInvite.initialBatchId || curInvite.sourceBatchId || responseBatchId,
                                    sourceBatchId: curInvite.sourceBatchId || responseBatchId,
                                    relatedBatchIds: newBatchIds,
                                    hasFiredArrivalMessage: false,
                                };
                                updateActiveOfflineInvite(updatedInvite);

                                const isThemeChanged = Boolean(updatedInvite.theme && updatedInvite.theme !== (curInvite.theme || "default"));
                                if (isDirectionChanged || isPlaceChanged || isThemeChanged) {
                                    let noticeContent = "";
                                    if (updatedInvite.theme === "alert" && curInvite.theme !== "alert") {
                                        noticeContent = `${charName} “请求”前往${placeStr === "你身边" ? "你身边" : placeStr}找你碰面`;
                                    } else if (isDirectionChanged) {
                                        noticeContent = "赴约提议已变更为由对方前来找你";
                                    } else {
                                        noticeContent = `赴约提议地点已更改为${placeStr}`;
                                    }

                                    emitOfflineInviteNotice(noticeContent, updatedInvite);
                                }

                                setIsOfflineInviteMinimized(true);
                                shouldAutoExpandInviteModalAfterTyping = true;
                            }
                        }
                    }
                    continue;
                }
            }
            if (p.mediaType === "offline_invite_early_arrive") {
                const curEarlyInvite = activeOfflineInviteRef.current;
                if (session.enableOfflineInvite && !session.isGroup && curEarlyInvite && curEarlyInvite.status === "on_the_way") {
                    // 仅当包含明确处于在途或跑腿买东西语境时拦截提前到达，避免语义冲突
                    const speech = (rawResponseText || "").replace(/\[[^\]]+\]/g, "");
                    const isStillMovingOrErrand = /(?:去便利店|顺便|顺路|去买|在路上|路上有点|这就出门|快到了|还要一会儿|买小面包|等我|on my way|stop by|buying)/i.test(speech);
                    if (isStillMovingOrErrand) {
                        continue;
                    }

                    const customArrivalCard = p.mediaData?.offlineInvite?.arrivalCardMessage?.trim();
                    const remainingMins = getRemainingMinutes(curEarlyInvite.startTime, curEarlyInvite.durationMinutes || 15);
                    const arrivedInvite: OfflineInviteData = {
                        ...curEarlyInvite,
                        status: "arrived",
                        isEarlyArrived: true,
                        hasFiredArrivalMessage: true,
                        frozenRemainingMinutes: remainingMins,
                        arrivalCardMessage: customArrivalCard || curEarlyInvite.arrivalCardMessage,
                        relatedBatchIds: Array.from(new Set([
                            ...(curEarlyInvite.relatedBatchIds || []),
                            curEarlyInvite.initialBatchId,
                            curEarlyInvite.sourceBatchId,
                            responseBatchId,
                        ].filter(Boolean) as string[])),
                    };
                    updateActiveOfflineInvite(arrivedInvite);

                    // 提前到达打字发完后延迟 3 秒展开弹窗
                    setIsOfflineInviteMinimized(true);
                    shouldAutoExpandInviteModalAfterTyping = true;

                    // 提前到达时留下到达事实记录
                    const charName = character?.name || "对方";
                    const isOriginByYourSide = curEarlyInvite.initialPlace === "你身边" || (!curEarlyInvite.initialPlace && curEarlyInvite.place === "你身边");
                    const rawPlace = curEarlyInvite.place?.trim();
                    const placeStr = isOriginByYourSide ? "你身边" : (rawPlace ? (rawPlace === "你身边" ? "你身边" : `「${rawPlace}」`) : "约定地点");
                    const sysMsg = pushChatMessage({
                        sessionId: session.id,
                        role: "system",
                        content: `${charName} 已提前到达${placeStr}`,
                        mediaType: "offline_invite_system_notice",
                        mediaData: { offlineInvite: arrivedInvite },
                    });
                    setMessages(prev => [...prev, sysMsg]);
                }
                continue;
            }
            if (p.mediaType === "accept_red_packet" || p.mediaType === "decline_red_packet"
                || p.mediaType === "accept_transfer" || p.mediaType === "decline_transfer"
                || p.mediaType === "accept_payment_request" || p.mediaType === "decline_payment_request") {
                if (p.mediaType === "decline_red_packet" || p.mediaType === "decline_transfer" || p.mediaType === "decline_payment_request") {
                    hasDecline = true;
                }
                throwIfGenerationStopped(options);
                handleAIMediaAction(p.mediaType, charN, userN);
                continue;
            }
            // Music: convert to plain text [音乐:xxx] (stays in history for AI), auto-play
            if (p.mediaType === "music") {
                const mTitle = p.mediaData?.musicTitle || p.mediaData?.label;
                if (mTitle) {
                    pushFilteredPart(
                        { content: `[音乐:${mTitle}]` },
                        () => autoPlayMusic(mTitle, charN, p.mediaData?.musicArtist || undefined),
                    );
                    continue;
                }
            }
            // Poke: keep mediaType so UI renders it as a system notice, while preserving response order.
            if (p.mediaType === "poke") {
                const pokeSender = (p.mediaData?.pokeSender === "我" ? charN : p.mediaData?.pokeSender) || charN;
                const pokeTarget = p.mediaData?.pokeTarget || userN;
                pushFilteredPart({
                    content: `${pokeSender} 拍了拍 ${pokeTarget}`,
                    mediaType: "poke",
                    mediaData: { pokeSender, pokeTarget },
                });
                continue;
            }
            pushFilteredPart(p);
        }

        // 安全兜底防御：若预判了同时触发，但邀约被拦截（未实际产生邀约卡片），则恢复解封小弹窗
        if (isConcurrentUnlockAndInviteCandidate && !pendingOfflineInviteNotice && !shouldAutoExpandInviteModalAfterTyping && pendingOfflineUnlockNotice) {
            shouldAutoExpandUnlockModalAfterTyping = true;
        }

        // 在途到达正文兜底：若角色正文表达已到达碰头处但漏输出指令，自动推进为提前到达
        const hasExplicitEarlyArrive = parts.some(p => p.mediaType === "offline_invite_early_arrive");
        const curEarlyInviteAuto = activeOfflineInviteRef.current;
        if (!hasExplicitEarlyArrive && session.enableOfflineInvite && !session.isGroup && curEarlyInviteAuto && curEarlyInviteAuto.status === "on_the_way" && curEarlyInviteAuto.direction === "he_comes") {
            const speech = (rawResponseText || "").replace(/\[[^\]]+\]/g, "");
            const isStillMovingOrErrand = /(?:去便利店|顺便去|顺路去|顺路在|顺便在|去买|在路上|路上有点|这就出门|快到了|还要一会儿|还要几分钟|[0-9一二三四五六七八九十两半几]+\s*分钟(?:左右|之内|内)?(?:就|才|能)?到|[0-9一二三四五六七八九十两半几]+\s*分钟.*(?:门口|门外|楼下)|往[^，。！？\n]+[走跑赶去]|下楼|等我片刻|等我|耐心等|在赶去|赶过去|准备出门|刚出门|在打车|开着车|堵车|红绿灯|on my way|stop by|buying)/i.test(speech);
            // 现场到达高频语境（如“我在门口”、“出电梯了”等，严格排除预测时间与假设去敲门）
            const isExplicitlyArrivedSpeech = /(?:我(?:已经?)?(?:到|在)(?:门外|楼下|门口|你家|你身边|了|[0-9a-zA-Z一二三四五六七八九十]+室?门外)(?![吗么?？])|(?<!你|[0-9一二三四五六七八九十两半几分小时])(?:在门外|到门外|在楼下|到楼下|在门口|到门口|已经在[门楼]|站在门外|站在门口|到地方了|出电梯了?)(?:[了！。，\s]|$)(?![吗么?？])|听见敲门声|(?<!跑去|去|要|会)敲门了?|i(?:'m| am) (?:here|outside|at the door))/i.test(speech);

            if (isExplicitlyArrivedSpeech && !isStillMovingOrErrand) {
                const remainingMins = getRemainingMinutes(curEarlyInviteAuto.startTime, curEarlyInviteAuto.durationMinutes || 15);
                const arrivedInvite: OfflineInviteData = {
                    ...curEarlyInviteAuto,
                    status: "arrived",
                    isEarlyArrived: true,
                    hasFiredArrivalMessage: true,
                    frozenRemainingMinutes: remainingMins,
                    relatedBatchIds: Array.from(new Set([
                        ...(curEarlyInviteAuto.relatedBatchIds || []),
                        curEarlyInviteAuto.initialBatchId,
                        curEarlyInviteAuto.sourceBatchId,
                        responseBatchId,
                    ].filter(Boolean) as string[])),
                };
                updateActiveOfflineInvite(arrivedInvite);

                setIsOfflineInviteMinimized(true);
                shouldAutoExpandInviteModalAfterTyping = true;

                const charName = character?.name || "对方";
                const isOriginByYourSide = curEarlyInviteAuto.initialPlace === "你身边" || (!curEarlyInviteAuto.initialPlace && curEarlyInviteAuto.place === "你身边");
                const rawPlace = curEarlyInviteAuto.place?.trim();
                const placeStr = isOriginByYourSide ? "你身边" : (rawPlace ? (rawPlace === "你身边" ? "你身边" : `「${rawPlace}」`) : "约定地点");
                const sysMsg = pushChatMessage({
                    sessionId: session.id,
                    role: "system",
                    content: `${charName} 已提前到达${placeStr}`,
                    mediaType: "offline_invite_system_notice",
                    mediaData: { offlineInvite: arrivedInvite },
                });
                setMessages(prev => [...prev, sysMsg]);
            }
        }

        const currentInTransitInvite = (
            session.enableOfflineInvite &&
            !session.isGroup &&
            activeOfflineInviteRef.current?.status === "on_the_way" &&
            activeOfflineInviteRef.current?.direction === "he_comes"
        ) ? activeOfflineInviteRef.current : null;

        let inTransitCountdownSnapshot: { seconds: number; minutes: number } | null = null;
        if (currentInTransitInvite) {
            const now = Date.now();
            const elapsedMs = Math.max(0, now - (currentInTransitInvite.startTime || now));
            const totalMs = (currentInTransitInvite.durationMinutes || 15) * 60000;
            const remainingMs = Math.max(0, totalMs - elapsedMs);
            const remainingSeconds = Math.max(1, Math.round(remainingMs / 1000));
            const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
            inTransitCountdownSnapshot = {
                seconds: remainingSeconds,
                minutes: remainingMinutes,
            };
        }

        if (filteredParts.length === 0) {
            publishOfflineLockNotices();
            if (shouldAutoExpandUnlockModalAfterTyping) {
                if (unlockExpandTimerRef.current) {
                    clearTimeout(unlockExpandTimerRef.current);
                }
                unlockExpandTimerRef.current = setTimeout(() => {
                    setShowOfflineUnlockedConfirmModal(true);
                    unlockExpandTimerRef.current = null;
                }, 3000);
            }
            // Silence: only status panel / inner monologue / reasoning, no visible chat text
            if (statusPanel || innerMonologue || options?.reasoningText) {
                throwIfGenerationStopped(options);
                const aiMsg = pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: "",
                    responseBatchId,
                    rawResponseText,
                    statusPanel,
                    statusRegionMode: customStatusActive && statusPanel ? "custom" as const : undefined,
                    innerMonologue,
                    reasoningText: options?.reasoningText,
                    stateValues: stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues,
                    mediaData: inTransitCountdownSnapshot ? {
                        inTransitRemainingSeconds: inTransitCountdownSnapshot.seconds,
                        inTransitRemainingMinutes: inTransitCountdownSnapshot.minutes,
                    } : undefined,
                });
                setMessages(prev => [...prev, aiMsg]);
            }
            return { hasVisible: false, stateValues, triggerCall, hasDecline };
        }

        // Build rich-media drafts first, then publish them in the same order as the UI display.
        const messageDrafts: Array<{ draft: AssistantMessageDraft; afterPublish?: (message: ChatMessage) => Promise<unknown> | void }> = [];
        const imageReplacementTasks: Promise<unknown>[] = [];
        // 面板挂到第一条能显示它的消息上；全是拍一拍等系统样式时补空消息驮面板
        let metaIdx = filteredParts.findIndex(canCarryFoldedPanel);
        if (metaIdx === -1 && (statusPanel || innerMonologue || stateValues.length > 0)) {
            pushFilteredPart({ content: "" });
            metaIdx = filteredParts.length - 1;
        }
        for (let idx = 0; idx < filteredParts.length; idx += 1) {
            throwIfGenerationStopped(options);
            const part = filteredParts[idx];
            const mediaType = part.mediaType;
            const draft = buildAssistantMessageDraft(part, {
                sessionId: session.id,
                role: "assistant",
                content: part.content,
                mediaType,
                mediaData: inTransitCountdownSnapshot ? {
                    ...part.mediaData,
                    inTransitRemainingSeconds: inTransitCountdownSnapshot.seconds,
                    inTransitRemainingMinutes: inTransitCountdownSnapshot.minutes,
                } : part.mediaData,
                responseBatchId,
                rawResponseText,
                statusPanel: idx === metaIdx && statusPanel ? statusPanel : undefined,
                statusRegionMode: customStatusActive && idx === metaIdx && statusPanel ? "custom" as const : undefined,
                innerMonologue: idx === metaIdx && innerMonologue ? innerMonologue : undefined,
                reasoningText: idx === metaIdx ? options?.reasoningText : undefined,
                stateValues: idx === metaIdx && stateValues.length > 0 ? stateValues : undefined,
                freshStateValues: idx === metaIdx ? freshStateValues : undefined,
            }, options);
            throwIfGenerationStopped(options);
            messageDrafts.push({
                draft,
                afterPublish: isPendingChatGeneratedImageMessage(draft)
                    ? (message) => scheduleGeneratedImageReplacement(message, session.contactId, options)
                    : afterPublishEffects[idx],
            });
        }

        const mediaLabels: Record<string, string> = {
            red_packet: "发了一个红包",
            transfer: "发了一笔转账",
            payment_request: "发起了代付请求",
            sticker: "发了一个表情",
            image: "发了一张照片",
            location: "分享了位置",
            audio: "发了一条语音",
            music_share: "分享了音乐",
            xiaohongshu_note_share: "分享了一条小红书帖子",
            app_card: "分享了一张应用卡片",
            quote: "引用回复",
        };
        const getNoticeBody = (m: ChatMessage): string => {
            const text = m.content.trim();
            if (text) return text;
            if (!m.mediaType) return "";
            if (m.mediaType === "sticker") return `发了一个表情 ${m.mediaData?.label || ""}`.trim();
            if (m.mediaType === "image") return m.mediaData?.label ? `发了一张照片: ${m.mediaData.label}` : "发了一张照片";
            if (m.mediaType === "media_file" && m.mediaData?.fileType === "image") {
                return m.mediaData?.label ? `发了一张照片: ${m.mediaData.label}` : "发了一张照片";
            }
            if (m.mediaType === "location") return `分享了位置: ${m.mediaData?.label || ""}`.trim();
            if (m.mediaType === "audio") return `发了一条语音: ${m.mediaData?.label || ""}`.trim();
            if (m.mediaType === "music_share") return `分享了音乐: ${m.mediaData?.musicTitle || ""}`.trim();
            if (m.mediaType === "xiaohongshu_note_share") return `分享了一条小红书帖子: ${m.mediaData?.xiaohongshuTitle || ""}`.trim();
            if (m.mediaType === "app_card") return `分享了${m.mediaData?.appName || "APP"}卡片: ${m.mediaData?.appCardTitle || m.mediaData?.appCardSummary || ""}`.trim();
            if (m.mediaType === "quote") return `引用回复: ${m.mediaData?.quotePreview || ""}`.trim();
            if (m.mediaType === "payment_request") return `发起了代付请求: ${m.mediaData?.paymentRequestAmountLabel || m.mediaData?.amount || ""}`.trim();
            return mediaLabels[m.mediaType] || "";
        };
        const dispatchVisibleNotice = (m: ChatMessage): void => {
            const body = getNoticeBody(m);
            if (!body) return;
            dispatchChatMessageNotice({
                sessionId: session.id,
                senderName: charN,
                avatar: character?.avatar || null,
                body: body.slice(0, 80),
            });
        };

        const publishVisibleMessage = (entry: { draft: AssistantMessageDraft; afterPublish?: (message: ChatMessage) => void }): ChatMessage => {
            throwIfGenerationStopped(options);
            const msg = pushChatMessage(entry.draft);
            setMessages(prev => [...prev, msg]);
            dispatchVisibleNotice(msg);
            const body = getNoticeBody(msg);
            if (body) {
                sendBrowserNotification(charN, { body: body.slice(0, 60), icon: character?.avatar || undefined });
            }
            const afterPublishResult = entry.afterPublish?.(msg);
            if (afterPublishResult) imageReplacementTasks.push(Promise.resolve(afterPublishResult));
            return msg;
        };

        // Display messages one by one with staggered delays; update preview and notice with the same rhythm.
        // 流式预览已经按段展示过一遍时（instantReveal）直接全部放出，避免二次「重播」。
        if (messageDrafts.length <= 1 || options?.instantReveal) {
            messageDrafts.forEach(publishVisibleMessage);
        } else {
            publishVisibleMessage(messageDrafts[0]);
            for (let i = 1; i < messageDrafts.length; i++) {
                await abortableDelay(800, options?.signal);
                throwIfGenerationStopped(options);
                publishVisibleMessage(messageDrafts[i]);
            }
        }
        if (imageReplacementTasks.length > 0) {
            await Promise.allSettled(imageReplacementTasks);
            throwIfGenerationStopped(options);
        }

        // 叩门破防后角色主动发信：若大模型在回复中既没有输出 [解除封禁]，也没有变动心墙（未产生 lock notice），
        // 且角色当前仍处于线下封禁状态，说明角色依然防守抵抗、心墙保持原样，补发“心墙似乎毫无动摇……”小灰字！
        if (
            options?.isKnockThresholdTriggered &&
            session.enableOfflineLock &&
            !session.isGroup &&
            !pendingOfflineUnlockNotice &&
            !pendingOfflineLockNotice &&
            offlineLockDataRef.current?.isLocked
        ) {
            const curLock = offlineLockDataRef.current;
            const updatedLock: OfflineLockData = {
                ...curLock,
                relatedBatchIds: Array.from(new Set([...(curLock.relatedBatchIds || []), responseBatchId])),
            };
            kvSet(OFFLINE_LOCK_PREFIX + session.id, JSON.stringify(updatedLock));
            setOfflineLockData(updatedLock);
            offlineLockDataRef.current = updatedLock;
            pendingOfflineLockNotice = {
                text: `${charN}的心墙似乎毫无动摇……`,
                lockData: updatedLock,
            };
        }

        // 系统提示在气泡输出完毕后发布，确保位于底部
        publishOfflineLockNotices();

        // 气泡输出完毕后延迟 3 秒展开大卡片
        if (shouldAutoExpandInviteModalAfterTyping) {
            if (remindExpandTimerRef.current) {
                clearTimeout(remindExpandTimerRef.current);
            }
            remindExpandTimerRef.current = setTimeout(() => {
                setIsOfflineInviteMinimized(false);
                remindExpandTimerRef.current = null;
            }, 3000);
        }

        // 解封打字完毕后延迟 3 秒展开前往线下确认弹窗
        if (shouldAutoExpandUnlockModalAfterTyping) {
            if (unlockExpandTimerRef.current) {
                clearTimeout(unlockExpandTimerRef.current);
            }
            unlockExpandTimerRef.current = setTimeout(() => {
                setShowOfflineUnlockedConfirmModal(true);
                unlockExpandTimerRef.current = null;
            }, 3000);
        }

        return { hasVisible: true, stateValues, triggerCall, hasDecline };
    };

    // Helper: handle AI-triggered call from splitAndSaveAIMessages result
    const handleCallTrigger = (triggerCall?: "voice" | "video") => {
        if (!triggerCall) return;
        setCallInitiator("character");
        if (triggerCall === "voice") setShowVoiceCall(true);
        else setShowVideoCall(true);
    };

    const persistHiddenToolResult = (content?: string, toolExecutionId?: string) => {
        if (!content) return;
        pushChatMessage({
            sessionId: session.id,
            role: "tool",
            content,
            mediaType: "tool_result",
            toolExecutionId,
        });
    };

    const persistHiddenAssistantToolCall = (content?: string, options?: {
        responseBatchId?: string;
        responseRoundId?: string;
        senderCharacterId?: string;
        senderName?: string;
    }) => {
        if (!content) return;
        pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content,
            mediaType: "tool_call",
            responseBatchId: options?.responseBatchId,
            responseRoundId: options?.responseRoundId,
            senderCharacterId: options?.senderCharacterId,
            senderName: options?.senderName,
        });
    };

    const persistToolNotice = (content?: string) => {
        if (!content) return;
        const msg = pushChatMessage({
            sessionId: session.id,
            role: "system",
            content,
            mediaType: "tool_notice",
        });
        setMessages(prev => [...prev, msg]);
    };

    const appendTransientMessage = (
        role: ChatMessage["role"],
        content: string,
        mediaType?: ChatMessage["mediaType"],
        mediaData?: ChatMessage["mediaData"],
    ) => {
        const transientMsg: ChatMessage = {
            id: `${TRANSIENT_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId: session.id,
            role,
            content,
            status: "sent",
            createdAt: new Date().toISOString(),
            ...(mediaType ? { mediaType } : {}),
            ...(mediaData ? { mediaData } : {}),
        };
        setTransientMessages(prev => [...prev, transientMsg]);
    };

    const updateTransientMessage = (msgId: string, updater: (msg: ChatMessage) => ChatMessage) => {
        setTransientMessages(prev => prev.map(msg => msg.id === msgId ? updater(msg) : msg));
    };

    const removeTransientMessage = (msgId: string) => {
        setTransientMessages(prev => prev.filter(msg => msg.id !== msgId));
    };

    const handleToolExecution = (results: ToolResult[], guard?: GenerationRunGuard, toolExecutionId?: string) => {
        throwIfGenerationStopped(guard);
        const pending = results.find(result => result.pendingApproval && result.pendingRequest);
        if (pending?.pendingRequest) {
            throwIfGenerationStopped(guard);
            appendTransientMessage("system", pending.pendingRequest.content, "memory_write_request", {
                memoryContent: pending.pendingRequest.content,
                memoryReason: pending.pendingRequest.reason,
                memoryImportance: pending.pendingRequest.importance,
                memoryRequestStatus: "pending",
            });
        }
        for (const result of results) {
            for (const att of result.mediaAttachments || []) {
                throwIfGenerationStopped(guard);
                const msg = pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: att.title || "",
                    mediaType: "media_file",
                    mediaUrl: att.url,
                    mediaData: { fileType: att.type, fileName: att.title },
                    toolExecutionId,
                    ...(session.isGroup ? {
                        senderCharacterId: result.actorCharacterId,
                        senderName: result.actorName,
                    } : {}),
                });
                setMessages(prev => [...prev, msg]);
            }
        }
    };

    const handleApproveMemoryWrite = async (msg: ChatMessage) => {
        if (msg.mediaType !== "memory_write_request") return;
        persistHiddenToolResult("确认写入记忆");
        const request: MemoryWriteRequest = {
            capabilityId: "memory_write",
            sessionId: session.id,
            characterId: session.contactId,
            content: msg.mediaData?.memoryContent || msg.content,
            importance: msg.mediaData?.memoryImportance ?? 0.8,
            ...(msg.mediaData?.memoryReason ? { reason: msg.mediaData.memoryReason } : {}),
        };

        const result = await approveMemoryWriteRequest(request);
        if (result.success) {
            updateTransientMessage(msg.id, current => ({
                ...current,
                mediaData: {
                    ...current.mediaData,
                    memoryRequestStatus: "approved",
                },
            }));
        }

        persistToolNotice(result.userNotice || (result.success ? "已写入长期记忆" : (result.error || "记忆写入失败")));
    };

    const handleIgnoreMemoryWrite = (msg: ChatMessage) => {
        if (msg.mediaType !== "memory_write_request") return;
        persistHiddenToolResult("忽略写入记忆");
        updateTransientMessage(msg.id, current => ({
            ...current,
            mediaData: {
                ...current.mediaData,
                memoryRequestStatus: "ignored",
            },
        }));
        persistToolNotice("已忽略本次记忆写入");
    };

    // Helper: transform stored system message to UI display text
    // Stored (prompt): [XX向YY发起了语音通话] / [我向XX发起了语音通话]
    // UI: XX向群聊发起了视频通话 / 你向XX发起了语音通话 / XX向你发起了语音通话
    const formatSysMsgForUI = (content: string, msg?: ChatMessage): string => {
        let text = content;
        const charN = character?.name || "对方";
        const userN = userIdentity?.name;
        // Call initiation: [我向XX发起了语音/视频通话]
        text = text.replace(/\[我向(.+?)发起了((?:群?(?:语音|视频)通话))\]/, (_, target, callType) => {
            // 单聊：target=用户名 → 角色发起；target=角色名 → 用户发起
            // 群聊：target=群聊，用 role 判断
            if (userN && target === userN) return `${charN}向你发起了${callType}`;
            if (target === "群聊" && msg?.role === "assistant") {
                const sender = msg.senderName || charN;
                return `${sender}向群聊发起了${callType}`;
            }
            return `你向${target}发起了${callType}`;
        });
        // Follow-up AI initiated: [我发起了语音/视频通话]
        text = text.replace(/\[我发起了((?:语音|视频)通话)\]/, `${charN}发起了$1`);
        // Hangup: [我挂断了XX通话] (duration now in mediaData, not content)
        text = text.replace(/\[我挂断了(.+?通话)\](?:\(时长\s*(.+?)\))?/, (_, callType, dur) =>
            dur ? `你挂断了${callType}，时长 ${dur}` : `你挂断了${callType}`
        );
        // Reject: [我拒绝了XX通话]
        text = text.replace(/\[我拒绝了(.+?通话)\]/, `你拒绝了$1`);
        // Cancel: [我取消了XX通话]
        text = text.replace(/\[我取消了(.+?通话)\]/, `你取消了$1`);
        // General user name → "你"
        if (userN) text = text.replace(new RegExp(userN, "g"), "你");
        // Friend add normalization
        text = text.replace(/^.+(?=已添加了)/, "你");
        text = text.replace(/^.+向(.+)发起了好友申请\n.+通过了好友申请$/, "你已添加了$1，现在可以开始聊天了。");
        text = text.replace(/，备注：[\s\S]*$/, "");
        return text;
    };

    // QQ 式头衔徽标：群主/管理员，按当前群身份实时计算（被踢/卸任后旧消息不再显示）
    const renderGroupRoleBadge = (senderCharacterId?: string) => {
        if (!session.isGroup || !senderCharacterId) return null;
        if (!(session.participantIds || []).includes(senderCharacterId)) return null;
        const role = getGroupRole(session, senderCharacterId);
        if (role === "owner") return <span className="chat-role-badge chat-role-badge-owner">群主</span>;
        if (role === "admin") return <span className="chat-role-badge chat-role-badge-admin">管理员</span>;
        return null;
    };

    const runManagedGeneration = async ({
        history,
        errorPrefix = "发送失败",
        onDecline,
        offlineInviteDeclined,
        returnedFromOffline,
        offlineInitiativePrompt,
        isKnockThresholdTriggered,
    }: ManagedGenerationOptions) => {
        if (isGeneratingRef.current) {
            if (activeGenerationRuns.has(session.id)) return;
            // 上一轮被外部取消/顶替后收尾提前返回过，标记已是陈旧状态：复位后继续本次请求
            isGeneratingRef.current = false;
            setIsGenerating(false);
            clearGenerationLock(session.id);
        }

        const generationRun = createGenerationRun(session.id);
        const generationRunId = generationRun.runId;
        const isCurrentGeneration = () => isGenerationRunActive(session.id, generationRunId);
        const generationGuard: GenerationRunGuard = { signal: generationRun.controller.signal, isActive: isCurrentGeneration };
        let shouldRunDeclineReply = false;

        isGeneratingRef.current = true;
        setIsGenerating(true);
        setGenerationLock(session.id);

        try {
            if (offlineInviteDeclined) {
                kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
            }
            if (session.isGroup) {
                let roundReasoning: string | undefined;
                const results = await generateGroupChatCompletion(
                    session,
                    history,
                    {
                        onReasoning: (t) => { roundReasoning = t; },
                        onStreamDelta: (delta) => {
                            if (!isCurrentGeneration()) return;
                            streamAccumRef.current += delta;
                            // 群聊全文解析较重：合并到 rAF 下一帧执行，避免一帧多段增量重复解析
                            if (streamParseFrameRef.current) return;
                            streamParseFrameRef.current = window.requestAnimationFrame(() => {
                                streamParseFrameRef.current = 0;
                                if (!isCurrentGeneration()) return;
                                const nameToId = new Map(groupCharacters.map(item => [item.name, item.id]));
                                const rawParts = parseGroupChatResponse(streamAccumRef.current, nameToId);
                                const parts = rawParts
                                    .filter(item => item.responseText.trim())
                                    .map(item => ({
                                        characterId: item.characterId,
                                        characterName: item.characterName,
                                        texts: splitStreamPreviewSegments(cleanStreamText(item.responseText, { stripXmlTags: streamPreviewTagConfig.online, stripLiterals: streamPreviewTagConfig.stripTexts })),
                                    }));
                                setStreamPreview({ parts });
                            });
                        },
                        onTextPart: () => {
                            if (streamParseFrameRef.current) {
                                cancelAnimationFrame(streamParseFrameRef.current);
                                streamParseFrameRef.current = 0;
                            }
                            streamAccumRef.current = "";
                            setStreamPreview(null);
                        },
                    },
                    {
                        signal: generationRun.controller.signal,
                        appTags: theaterMode ? ["group_chat"] : undefined,
                    },
                );
                if (!isCurrentGeneration()) return;
                await processGroupParts(results, setMessages, generationGuard, roundReasoning, { instantReveal: isSessionStreamingEnabled(session, true) });
            } else {
                let capturedReasoning: string | undefined;
                const cr = await generateChatCompletion(
                    session,
                    history,
                    {
                        appTags: theaterMode ? ["chat"] : ["chat", "text"],
                        signal: generationRun.controller.signal,
                        offlineInviteDeclined,
                        returnedFromOffline,
                        offlineInitiativePrompt,
                    },
                    {
                        onReasoning: (t) => { capturedReasoning = t; },
                        onStreamDelta: (delta) => {
                            if (!isCurrentGeneration()) return;
                            streamAccumRef.current += delta;
                            // 预览更新合并到 rAF 下一帧：每帧最多一次全文净化+setState，避免高频增量卡顿
                            if (streamParseFrameRef.current) return;
                            streamParseFrameRef.current = window.requestAnimationFrame(() => {
                                streamParseFrameRef.current = 0;
                                if (!isCurrentGeneration()) return;
                                setStreamPreview({ texts: splitStreamPreviewSegments(cleanStreamText(streamAccumRef.current, { stripXmlTags: streamPreviewTagConfig.online, stripLiterals: streamPreviewTagConfig.stripTexts })) });
                            });
                        },
                        onTextPart: () => {
                            if (streamParseFrameRef.current) {
                                cancelAnimationFrame(streamParseFrameRef.current);
                                streamParseFrameRef.current = 0;
                            }
                            streamAccumRef.current = "";
                            setStreamPreview(null);
                        },
                    },
                );
                if (!isCurrentGeneration()) return;
                const result = await splitAndSaveAIMessages(flattenCompletionResult(cr), {
                    ...generationGuard,
                    reasoningText: capturedReasoning,
                    instantReveal: isSessionStreamingEnabled(session, true),
                    isKnockThresholdTriggered,
                });
                if (!isCurrentGeneration()) return;
                scheduleFollowUp(session.id, 0, result.stateValues);
                handleCallTrigger(result.triggerCall);
                shouldRunDeclineReply = Boolean(result.hasDecline);
            }
        } catch (error: any) {
            if (!isCurrentGeneration() || isAbortLikeError(error)) return;
            const errorMsg = pushChatMessage({
                sessionId: session.id,
                role: "system",
                content: `⚠️ ${errorPrefix}: ${error?.message || String(error)}`,
            });
            setMessages(prev => [...prev, errorMsg]);
        } finally {
            if (finishGenerationRun(session.id, generationRunId)) {
                isGeneratingRef.current = false;
                setIsGenerating(false);
                clearGenerationLock(session.id);
                if (!mountedRef.current) {
                    window.dispatchEvent(new CustomEvent(CHAT_BG_COMPLETE, { detail: { sessionId: session.id } }));
                }
            } else if (!activeGenerationRuns.has(session.id)) {
                // 本轮被外部取消且没有新一轮接手：仍需复位，否则「生成中」标记永久卡死，
                // 后续联动/追问的回复请求会被静默吞掉
                isGeneratingRef.current = false;
                setIsGenerating(false);
                clearGenerationLock(session.id);
            }
        }

        if (shouldRunDeclineReply && onDecline) await onDecline();
    };

    // Helper: trigger one AI reply based on current chat history (for events like call connect/hangup, decline)
    const triggerReply = async () => {
        const latestMessages = loadChatMessages(session.id);
        applyStoredMessageWindow(latestMessages);
        await runManagedGeneration({ history: latestMessages });
    };

    // ── Rich media send helpers ──
    const getMoneyMediaAmount = (mediaData: ChatMessage["mediaData"]): number => {
        const amount = Number(mediaData?.amount ?? 0);
        return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0;
    };

    const debitOutgoingMoneyMessage = (
        mediaType: ChatMessage["mediaType"],
        mediaData: ChatMessage["mediaData"],
    ): { ok: boolean; mediaData?: ChatMessage["mediaData"] } => {
        if (mediaType !== "red_packet" && mediaType !== "transfer") return { ok: true, mediaData };
        const amount = getMoneyMediaAmount(mediaData);
        if (amount <= 0) {
            showChatToast("金额无效");
            return { ok: false };
        }
        const isRedPacket = mediaType === "red_packet";
        const result = payWithWalletBalance({
            amount,
            title: isRedPacket ? "发红包" : "发转账",
            detail: `${session.isGroup ? session.groupName || "群聊" : character?.name || "聊天"}：${isRedPacket ? "发红包" : "发转账"} ${amount.toFixed(2)} 元`,
            category: isRedPacket ? "红包" : "转账",
        });
        if (!result.ok || !result.transaction) {
            showChatToast(result.error ?? "余额不足");
            return { ok: false };
        }
        return {
            ok: true,
            mediaData: {
                ...mediaData,
                walletTransactionId: result.transaction.id,
            },
        };
    };

    const refundOutgoingMoneyMessage = (msg: ChatMessage, reason: "红包退回" | "转账退回"): ChatMessage["mediaData"] => {
        const data = msg.mediaData;
        if (!data?.walletTransactionId || data.walletRefundTransactionId) return data;
        const amount = getMoneyMediaAmount(data);
        if (amount <= 0) return data;
        const result = creditWalletBalance(amount, reason, `${reason}：${data.label || msg.content || "聊天款项"}`, "聊天退款");
        if (!result.ok || !result.transaction) return data;
        return {
            ...data,
            walletRefundTransactionId: result.transaction.id,
        };
    };

    const creditIncomingMoneyMessage = (msg: ChatMessage, actionType: string): ChatMessage => {
        if (actionType !== "accept_red_packet" && actionType !== "accept_transfer") return msg;
        const data = msg.mediaData;
        if (data?.walletDepositTransactionId) return msg;
        const userName = userIdentity?.name || "你";
        const amount = actionType === "accept_red_packet"
            ? Number(data?.claimedAmounts?.[userName] ?? data?.amount ?? 0)
            : Number(data?.amount ?? 0);
        const safeAmount = Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0;
        if (safeAmount <= 0) return msg;
        const result = creditWalletBalance(
            safeAmount,
            actionType === "accept_red_packet" ? "领取红包" : "收款",
            `${actionType === "accept_red_packet" ? "领取红包" : "收款"}：${data?.label || msg.content || "聊天款项"}`,
            actionType === "accept_red_packet" ? "红包" : "转账",
        );
        if (!result.ok || !result.transaction) return msg;
        const updatedData = {
            ...data,
            walletDepositTransactionId: result.transaction.id,
        };
        updateMessageMediaData(msg.id, updatedData);
        return { ...msg, mediaData: updatedData };
    };

    const sendRichMessage = (mediaType: ChatMessage["mediaType"], mediaData: ChatMessage["mediaData"], content: string = "", mediaUrl?: string): boolean => {
        if (!ensureGroupSpeakPermission()) return false;
        if (isGenerating) {
            showChatToast("请先等待对方回复");
            return false;
        }
        cancelFollowUp(session.id);

        if (mediaType === "poke") {
            const pokeSender = userIdentity?.name || "你";
            const pokeTarget = mediaData?.pokeTarget || character?.name || "对方";
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: "user",
                content: `${pokeSender} 拍了拍 ${pokeTarget}`,
                mediaType: "poke",
                mediaData: { pokeSender, pokeTarget },
            });
            setMessages(prev => [...prev, sysMsg]);
            setPendingGenerate(true);
            return true;
        }

        const walletDebit = debitOutgoingMoneyMessage(mediaType, mediaData);
        if (!walletDebit.ok) return false;

        const newMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content,
            mediaType,
            mediaData: walletDebit.mediaData,
            ...(mediaUrl ? { mediaUrl } : {}),
        });
        setMessages(prev => [...prev, newMsg]);
        setPendingGenerate(true);
        return true;
    };

    const sendSystemInstruction = (content: string): boolean => {
        if (isGenerating) {
            showChatToast("请先等待对方回复");
            return false;
        }
        const trimmed = content.trim();
        if (!trimmed) return false;

        cancelFollowUp(session.id);
        setQuotingMessage(null);

        const newMsg = pushChatMessage({
            sessionId: session.id,
            role: "system",
            content: trimmed,
            mediaType: "system_instruction",
        });
        setMessages(prev => [...prev, newMsg]);
        setPendingGenerate(true);
        return true;
    };

    const handleOpenCustomPlusAction = useCallback((action: RegisteredCustomAppChatPlusAction) => {
        setShowPlusMenu(false);
        setShowEmojiPanel(false);
        setShowStickerPanel(false);
        setRichModal(null);
        const app = getInstalledCustomApp(action.appId);
        if (!app) {
            showChatToast("这个自定义 APP 已不存在");
            setCustomPlusActions(loadCustomAppChatPlusActions());
            return;
        }
        const presentation = getCustomChatPlusPresentation(action);
        const launchContext = {
            source: "chat_plus_action",
            sessionId: session.id,
            characterId: session.contactId,
            characterName: character?.name,
            isGroup: Boolean(session.isGroup),
            groupName: session.groupName,
            participantIds: session.participantIds ?? [],
            participants: groupCharacters.map(item => ({ id: item.id, name: item.name })),
            actionId: action.id,
            actionLabel: action.label,
            entry: action.entry,
            directiveId: action.directiveId,
            sceneId: action.sceneId,
            sceneTag: action.sceneTag,
            appTags: action.tags,
            data: action.data,
            presentation,
            panelHeight: action.panelHeight,
            appId: action.appId,
            appName: action.appName,
        };
        if (presentation === "fullscreen") {
            window.dispatchEvent(new CustomEvent("open-app", {
                detail: {
                    appId: toCustomAppIconId(action.appId),
                    launchContext,
                },
            }));
            return;
        }
        setActiveCustomChatPlus({
            app,
            action,
            presentation,
            launchContext,
        });
    }, [character?.name, groupCharacters, session.contactId, session.groupName, session.id, session.isGroup, session.participantIds]);

    const sendShoppingGiftMessage = (gift: ShoppingGiftCandidate, recipient?: Character): boolean => {
        if (session.isGroup && !recipient) {
            showChatToast("请选择收礼对象");
            return false;
        }
        const sent = sendRichMessage("gift", {
            label: gift.productName,
            giftName: gift.productName,
            shoppingGiftId: gift.id,
            giftOrderId: gift.orderId,
            giftItemId: gift.itemId,
            giftMerchantLabel: gift.merchantLabel,
            giftPriceLabel: gift.priceLabel,
            giftPreviewIcon: gift.previewIcon,
            giftTone: gift.tone,
            giftDeliveredAt: gift.deliveredAt,
            giftSentAt: new Date().toISOString(),
            senderName: userIdentity?.name || "你",
            ...(recipient ? { recipientId: recipient.id, recipientName: recipient.name } : {}),
        });
        if (sent) showChatToast("礼物已送出");
        return sent;
    };

    const triggerAIResponse = async () => {
        if (isGeneratingRef.current) {
            if (activeGenerationRuns.has(session.id)) return;
            // 上一轮被外部取消/顶替后收尾提前返回过，标记已是陈旧状态：复位后继续本次请求
            isGeneratingRef.current = false;
            setIsGenerating(false);
            clearGenerationLock(session.id);
        }
        const generationRun = createGenerationRun(session.id);
        const generationRunId = generationRun.runId;
        const isCurrentGeneration = () => isGenerationRunActive(session.id, generationRunId);
        const generationGuard: GenerationRunGuard = { signal: generationRun.controller.signal, isActive: isCurrentGeneration };
        let shouldRunDeclineReply = false;
        isGeneratingRef.current = true;
        setIsGenerating(true);
        setPendingGenerate(false);
        setGenerationLock(session.id);
        streamAccumRef.current = "";
        setStreamPreview(null);
        try {
            const latestMessages = loadChatMessages(session.id);
            if (session.isGroup) {
                const streamedImageReplacementTasks: Promise<unknown>[] = [];
                // 每轮 LLM 调用的思维链：中间轮挂到该轮首条气泡，最终轮传给 processGroupParts
                let pendingGroupReasoning: string | undefined;
                const results = await generateGroupChatCompletion(session, latestMessages, {
                    onReasoning: (t) => { pendingGroupReasoning = t; },
                    onStreamDelta: (delta) => {
                        if (!isCurrentGeneration()) return;
                        streamAccumRef.current += delta;
                        // 群聊全文解析较重：合并到 rAF 下一帧执行，避免一帧多段增量重复解析
                        if (streamParseFrameRef.current) return;
                        streamParseFrameRef.current = window.requestAnimationFrame(() => {
                            streamParseFrameRef.current = 0;
                            if (!isCurrentGeneration()) return;
                            const nameToId = new Map(groupCharacters.map(item => [item.name, item.id]));
                            const rawParts = parseGroupChatResponse(streamAccumRef.current, nameToId);
                            const parts = rawParts
                                .filter(item => item.responseText.trim())
                                .map(item => ({
                                    characterId: item.characterId,
                                    characterName: item.characterName,
                                    texts: splitStreamPreviewSegments(cleanStreamText(item.responseText, { stripXmlTags: streamPreviewTagConfig.online, stripLiterals: streamPreviewTagConfig.stripTexts })),
                                }));
                            setStreamPreview({ parts });
                        });
                    },
                    onTextPart: async (text, senderInfo, options) => {
                        if (!isCurrentGeneration()) return;
                        // 本轮群聊内容经 onTextPart 落库后重置，供下一轮（工具轮）重新预览
                        if (streamParseFrameRef.current) {
                            cancelAnimationFrame(streamParseFrameRef.current);
                            streamParseFrameRef.current = 0;
                        }
                        streamAccumRef.current = "";
                        setStreamPreview(null);
                        if (!text.trim() || !senderInfo) return;
                        const cleanedEditableText = cleanEditableAssistantText(text);
                        if (!cleanedEditableText) return;
                        const roundReasoning = pendingGroupReasoning;
                        pendingGroupReasoning = undefined;
                        const responseBatchId = options?.responseBatchId || createResponseBatchId();
                        const rawResponseText = options?.rawResponseText ?? text;
                        const responseRoundId = senderInfo.responseRoundId || createResponseRoundId();
                        const editableResponseText = senderInfo.editableResponseText || `[${senderInfo.characterName}]: ${cleanedEditableText}`;
                        const previousState = getLatestCharacterStateValues(senderInfo.characterId);
                        const { parts: rawParts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(text, previousState);
                        const parts = stripInvalidStickerParts(rawParts, senderInfo.characterId);
                        let attachedState = false;
                        let savedAnyPart = false;
                        for (const part of parts) {
                            throwIfGenerationStopped(generationGuard);
                            if (!part.content.trim() && !part.mediaType) continue;
                            const draft = buildAssistantMessageDraft(part, {
                                sessionId: session.id,
                                role: "assistant",
                                content: part.content,
                                mediaType: part.mediaType,
                                mediaData: part.mediaData,
                                responseBatchId,
                                rawResponseText,
                                responseRoundId,
                                editableResponseText,
                                statusPanel: !attachedState && statusPanel ? statusPanel : undefined,
                                statusRegionMode: customStatusActive && !attachedState && statusPanel ? "custom" as const : undefined,
                                innerMonologue: !attachedState && innerMonologue ? innerMonologue : undefined,
                                reasoningText: !attachedState ? roundReasoning : undefined,
                                stateValues: !attachedState && stateValues.length > 0 ? stateValues : undefined,
                                freshStateValues: !attachedState ? freshStateValues : undefined,
                                senderCharacterId: senderInfo.characterId,
                                senderName: senderInfo.characterName,
                            }, generationGuard);
                            throwIfGenerationStopped(generationGuard);
                            const msg = pushChatMessage(draft);
                            streamedImageReplacementTasks.push(scheduleGeneratedImageReplacement(msg, senderInfo.characterId, generationGuard));
                            attachedState = true;
                            savedAnyPart = true;
                            setMessages(prev => [...prev, msg]);
                        }
                        if (!savedAnyPart && (statusPanel || innerMonologue || roundReasoning)) {
                            throwIfGenerationStopped(generationGuard);
                            const msg = pushChatMessage({
                                sessionId: session.id,
                                role: "assistant",
                                content: "",
                                mediaType: undefined,
                                responseBatchId,
                                rawResponseText,
                                responseRoundId,
                                editableResponseText,
                                statusPanel,
                                statusRegionMode: customStatusActive && statusPanel ? "custom" as const : undefined,
                                innerMonologue,
                                reasoningText: roundReasoning,
                                stateValues: stateValues.length > 0 ? stateValues : undefined,
                                freshStateValues,
                                senderCharacterId: senderInfo.characterId,
                                senderName: senderInfo.characterName,
                            });
                            setMessages(prev => [...prev, msg]);
                        }
                    },
                    onToolNotice: (notice) => {
                        if (!isCurrentGeneration()) return;
                        persistToolNotice(notice);
                    },
                    onToolResult: (content, options) => {
                        if (!isCurrentGeneration()) return;
                        pushChatMessage({
                            sessionId: session.id,
                            role: "tool",
                            content,
                            mediaType: "tool_result",
                            toolExecutionId: options?.toolExecutionId,
                        });
                    },
                    onToolAssistantTurn: (content, options) => {
                        if (!isCurrentGeneration()) return;
                        persistHiddenAssistantToolCall(content, options);
                    },
                    onToolExecution: (results, _historyContent, options) => {
                        if (!isCurrentGeneration()) return;
                        handleToolExecution(results, generationGuard, options?.toolExecutionId);
                    },
                    onNativeToolAssistantTurn: async ({ content, rawContent, reasoning, openRouterReasoningDetails, toolCalls }) => {
                        if (!isCurrentGeneration()) return;
                        const nameToId = new Map(groupCharacters.map(item => [item.name, item.id]));
                        const visibleResults = parseGroupChatResponse(content, nameToId)
                            .filter(item => item.responseText.trim());
                        if (visibleResults.length > 0) {
                            await processGroupParts(visibleResults, setMessages, generationGuard, reasoning, { instantReveal: isSessionStreamingEnabled(session, true) });
                        }

                        throwIfGenerationStopped(generationGuard);
                        const firstActorName = typeof toolCalls[0]?.args?.actorName === "string"
                            ? toolCalls[0].args.actorName.trim()
                            : "";
                        const firstActor = groupCharacters.find(item => item.name === firstActorName);
                        pushChatMessage({
                            sessionId: session.id,
                            role: "assistant",
                            content: "",
                            rawResponseText: rawContent,
                            nativeToolCalls: toolCalls,
                            nativeToolReasoning: reasoning,
                            nativeToolOpenRouterReasoningDetails: openRouterReasoningDetails,
                            senderCharacterId: firstActor?.id,
                            senderName: firstActorName || firstActor?.name,
                        });
                        trackNativeToolCalls(session.id, generationRunId, toolCalls.map(call => ({ id: call.id, name: call.name })));
                    },
                    onNativeToolResult: ({ toolCallId, name, content, toolExecutionId }) => {
                        if (!isCurrentGeneration()) return;
                        pushChatMessage({
                            sessionId: session.id,
                            role: "tool",
                            content,
                            mediaType: "tool_result",
                            toolExecutionId,
                            nativeToolResult: { toolCallId, name, content },
                        });
                        resolveNativeToolCall(session.id, generationRunId, toolCallId);
                    },
                }, {
                    signal: generationRun.controller.signal,
                    appTags: theaterMode ? ["group_chat"] : undefined,
                });
                if (!isCurrentGeneration()) return;
                if (streamedImageReplacementTasks.length > 0) {
                    await Promise.allSettled(streamedImageReplacementTasks);
                    throwIfGenerationStopped(generationGuard);
                }
                await processGroupParts(results, setMessages, generationGuard, pendingGroupReasoning, { instantReveal: isSessionStreamingEnabled(session, true) });
            } else {
                let lastSendResult: Awaited<ReturnType<typeof splitAndSaveAIMessages>> | undefined;
                // 每轮 LLM 调用的思维链，onReasoning 先于该轮 onTextPart 触发
                let pendingReasoning: string | undefined;

                const pendingDeclineRaw = kvGet(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                let pendingDeclineContext: OfflineInviteDeclineContext | boolean = false;
                if (pendingDeclineRaw) {
                    kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                    try {
                        pendingDeclineContext = JSON.parse(pendingDeclineRaw);
                    } catch {
                        pendingDeclineContext = true;
                    }
                }
                const result = await generateChatCompletion(session, latestMessages, {
                    appTags: theaterMode ? ["chat"] : ["chat", "text"],
                    signal: generationRun.controller.signal,
                    offlineInviteDeclined: pendingDeclineContext,
                }, {
                    onReasoning: (t) => { pendingReasoning = t; },
                    onStreamDelta: (delta) => {
                        if (!isCurrentGeneration()) return;
                        streamAccumRef.current += delta;
                        // 预览更新合并到 rAF 下一帧：每帧最多一次全文净化+setState，避免高频增量卡顿
                        if (streamParseFrameRef.current) return;
                        streamParseFrameRef.current = window.requestAnimationFrame(() => {
                            streamParseFrameRef.current = 0;
                            if (!isCurrentGeneration()) return;
                            setStreamPreview({ texts: splitStreamPreviewSegments(cleanStreamText(streamAccumRef.current, { stripXmlTags: streamPreviewTagConfig.online, stripLiterals: streamPreviewTagConfig.stripTexts })) });
                        });
                    },
                    onTextPart: async (text, _senderInfo, options) => {
                        if (!isCurrentGeneration()) return;
                        // 本轮流式已结束且内容经 splitAndSaveAIMessages 落库：清掉预览、重置累积，
                        // 供下一轮（工具轮）重新累积预览
                        if (streamParseFrameRef.current) {
                            cancelAnimationFrame(streamParseFrameRef.current);
                            streamParseFrameRef.current = 0;
                        }
                        streamAccumRef.current = "";
                        setStreamPreview(null);
                        if (text.trim()) {
                            const reasoningText = pendingReasoning;
                            pendingReasoning = undefined;
                            lastSendResult = await splitAndSaveAIMessages(text, { ...options, ...generationGuard, reasoningText, instantReveal: isSessionStreamingEnabled(session, true) });
                        }
                    },
                    onToolNotice: (notice) => {
                        if (!isCurrentGeneration()) return;
                        persistToolNotice(notice);
                    },
                    onToolResult: (content, options) => {
                        if (!isCurrentGeneration()) return;
                        // Persist to history for future LLM context, hidden from UI
                        persistHiddenToolResult(content, options?.toolExecutionId);
                    },
                    onToolAssistantTurn: (content, options) => {
                        if (!isCurrentGeneration()) return;
                        persistHiddenAssistantToolCall(content, options);
                    },
                    onNativeToolAssistantTurn: async ({ content, rawContent, reasoning, openRouterReasoningDetails, toolCalls }) => {
                        if (!isCurrentGeneration()) return;
                        // Publish the visible turn (text + stickers / images / red packets /
                        // etc.) through the same splitter as normal replies, so rich media
                        // isn't dropped and blank-line-separated text becomes separate
                        // bubbles. The native tool-call metadata then rides on a separate
                        // empty carrier message — mirroring the group-chat path above.
                        if (content.trim()) {
                            await splitAndSaveAIMessages(content, { ...generationGuard, reasoningText: reasoning, instantReveal: isSessionStreamingEnabled(session, true) });
                        }
                        if (!isCurrentGeneration()) return;
                        const carrier = pushChatMessage({
                            sessionId: session.id,
                            role: "assistant",
                            content: "",
                            rawResponseText: rawContent,
                            nativeToolCalls: toolCalls,
                            nativeToolReasoning: reasoning,
                            nativeToolOpenRouterReasoningDetails: openRouterReasoningDetails,
                        });
                        setMessages(prev => [...prev, carrier]);
                        trackNativeToolCalls(session.id, generationRunId, toolCalls.map(call => ({ id: call.id, name: call.name })));
                    },
                    onNativeToolResult: ({ toolCallId, name, content, toolExecutionId }) => {
                        if (!isCurrentGeneration()) return;
                        const msg = pushChatMessage({
                            sessionId: session.id,
                            role: "tool",
                            content,
                            mediaType: "tool_result",
                            toolExecutionId,
                            nativeToolResult: { toolCallId, name, content },
                        });
                        setMessages(prev => [...prev, msg]);
                        resolveNativeToolCall(session.id, generationRunId, toolCallId);
                    },
                    onToolExecution: (results, _historyContent, options) => {
                        if (!isCurrentGeneration()) return;
                        handleToolExecution(results, generationGuard, options?.toolExecutionId);
                    },
                });
                if (!isCurrentGeneration()) return;

                if (lastSendResult) {
                    scheduleFollowUp(session.id, 0, lastSendResult.stateValues);
                    const isHidden = !mountedRef.current || !isChatRoomElementVisible(wrapperRef.current);
                    if (isHidden && lastSendResult.triggerCall) {
                        window.dispatchEvent(new CustomEvent("ai-call-trigger", {
                            detail: { sessionId: session.id, type: lastSendResult.triggerCall },
                        }));
                    } else {
                        handleCallTrigger(lastSendResult.triggerCall);
                    }
                    shouldRunDeclineReply = Boolean(lastSendResult.hasDecline);
                }
            }
        } catch (error: any) {
            if (!isCurrentGeneration() || isAbortLikeError(error)) return;
            const errorMsg = pushChatMessage({
                sessionId: session.id,
                role: "system",
                content: `⚠️ 发送失败: ${error?.message || String(error)}`
            });
            setMessages(prev => [...prev, errorMsg]);
        } finally {
            if (finishGenerationRun(session.id, generationRunId)) {
                isGeneratingRef.current = false;
                setIsGenerating(false);
                clearGenerationLock(session.id);
                if (!mountedRef.current) {
                    window.dispatchEvent(new CustomEvent(CHAT_BG_COMPLETE, { detail: { sessionId: session.id } }));
                }
                // If user sent more messages while AI was generating, show the generate button again
                const latestMsgs = loadChatMessages(session.id);
                const last = latestMsgs[latestMsgs.length - 1];
                if (last && last.role === "user") {
                    setPendingGenerate(true);
                }
            } else if (!activeGenerationRuns.has(session.id)) {
                // 本轮被外部取消且没有新一轮接手：仍需复位，否则「生成中」标记永久卡死，
                // 后续联动/追问的回复请求会被静默吞掉
                isGeneratingRef.current = false;
                setIsGenerating(false);
                clearGenerationLock(session.id);
            }
        }
        if (shouldRunDeclineReply) await triggerReply();
    };

    // 收起键盘（或关掉表情/加号面板）并安静 N 秒后自动触发回复，
    // 等价于替用户点一次「触发回复」。判定全在 hook 内部，配置关掉后与手动模式一致。
    useKeyboardDismissAutoSend(wrapperRef, {
        active: !offlineMode && !isMultiSelectMode,
        pending: pendingGenerate,
        generating: isGenerating,
        panelOpen: showEmojiPanel || showStickerPanel || showPlusMenu,
        sessionId: session.id,
        onTrigger: () => { void triggerAIResponse(); },
    });

    useEffect(() => {
        const handleCustomAppReplyRequest = (event: Event) => {
            const detail = (event as CustomEvent<{
                sessionId?: string;
                characterId?: string;
                handled?: boolean;
                busy?: boolean;
            }>).detail;
            const requestSessionId = typeof detail?.sessionId === "string" ? detail.sessionId : "";
            const requestCharacterId = typeof detail?.characterId === "string" ? detail.characterId : "";
            const matches = requestSessionId
                ? requestSessionId === session.id
                : Boolean(requestCharacterId && !session.isGroup && requestCharacterId === session.contactId);
            if (!matches) return;

            if (detail) detail.handled = true;
            syncMessagesFromStorage();
            // 真在生成中：如实告知调用方（避免记成「已生成回应」），本轮结束后 pendingGenerate 兜底
            if (isGeneratingRef.current && activeGenerationRuns.has(session.id)) {
                if (detail) detail.busy = true;
                return;
            }
            void triggerAIResponse();
        };

        window.addEventListener(CHAT_REQUEST_REPLY_EVENT, handleCustomAppReplyRequest);
        return () => window.removeEventListener(CHAT_REQUEST_REPLY_EVENT, handleCustomAppReplyRequest);
    }, [session.contactId, session.id, session.isGroup, syncMessagesFromStorage, triggerAIResponse]);

    // 围观群/被禁言时用户不能发言
    const ensureGroupSpeakPermission = (): boolean => {
        if (!session.isGroup) return true;
        if (session.isSpectator) {
            showChatToast("围观群不能发言，只能点生成");
            return false;
        }
        const muteMs = getGroupMuteRemainingMs(session, GROUP_SELF_KEY);
        if (muteMs > 0) {
            showChatToast(`你已被禁言，剩余${formatMuteRemainingLabel(muteMs)}`);
            return false;
        }
        return true;
    };

    const handleSendText = (text: string, options?: { autoReply?: boolean }): boolean => {
        if (!ensureGroupSpeakPermission()) return false;
        if (isGenerating) {
            showChatToast("请先等待对方回复");
            return false;
        }
        const trimmed = text.trim();
        if (!trimmed) return false;

        // Cancel any pending follow-up for this session
        cancelFollowUp(session.id);

        // If quoting a message, send as quote type
        const isQuoting = !!quotingMessage;
        const quoteData = quotingMessage ? {
            quoteMessageId: quotingMessage.id,
            quotePreview: quotingMessage.content.slice(0, 50),
            quoteRole: quotingMessage.role,
        } : undefined;
        setQuotingMessage(null);

        const commitSendText = (currentText: string) => {
            // 掷骰子：整条消息就是骰子图标时，发骰子气泡（内容仅图标），
            // 点数由系统旁白公布——避免结果挂在 user 消息上被角色模仿格式
            const diceOnly = !isQuoting && isDiceOnlyMessage(currentText);
            const diceFace = diceOnly ? rollChatDiceFace() : 0;

            const newMsg = pushChatMessage({
                sessionId: session.id,
                role: "user",
                content: currentText,
                mediaType: diceOnly ? "dice" : isQuoting ? "quote" : undefined,
                mediaData: diceOnly ? { diceFace } : isQuoting ? quoteData : undefined,
            });

            setMessages(prev => [...prev, newMsg]);
            if (diceOnly) {
                const diceAside = pushChatMessage({
                    sessionId: session.id,
                    role: "system",
                    content: formatChatDiceResultMessage(diceFace),
                });
                setMessages(prev => [...prev, diceAside]);
            }
            setPendingGenerate(true);
            // 按回复键发送：消息落库后立即触发模型回复（无论插件是否异步改写，
            // 都在消息真正写入后触发，避免回复基于旧上下文）
            if (options?.autoReply) void triggerAIResponse();
        };

        // 聊天插件织入点 user.beforeSend：无插件时走原同步路径，
        // 有插件时输入框先清空，改写/取消在异步续体里完成
        if (getChatPluginHookBus().hasHandlers("user.beforeSend")) {
            void runChatPluginTransform("user.beforeSend", {
                text: trimmed,
                sessionId: session.id,
                isGroup: !!session.isGroup,
                cancelled: false,
            }).then(payload => {
                if (payload.cancelled) return;
                const finalText = typeof payload.text === "string" ? payload.text.trim() : trimmed;
                if (finalText) commitSendText(finalText);
            });
        } else {
            commitSendText(trimmed);
        }
        return true;
    };

    // 线下 XML 构造与提示词查看器共用 lib/offline-prompt-builder（社区 #108），
    // 保证「预览 = 真实发出的提示词」；此处仅包一层稳定引用。
    // 自定义状态栏：custom 生效时新消息盖戳，折叠区改走用户渲染代码；旧消息按原生渲染
    const statusRegionCfg = getStatusRegionConfig(session.id);
    const customStatusActive = isCustomStatusRegionActive(statusRegionCfg);

    const formatOfflineTurnXml = useCallback((turn: ChatOfflineTurn): string => formatOfflineTurnXmlShared(turn), []);

    const buildOfflinePromptHistory = (turns: ChatOfflineTurn[], pendingUserContent: string): ChatMessage[] =>
        buildOfflinePromptHistoryShared(session, turns, pendingUserContent);
    const getOfflineCopyText = (turn: ChatOfflineTurn, role: OfflineActionTarget["role"]): string => {
        if (role === "user") return turn.userContent;
        return formatOfflineTurnXml(turn);
    };

    const getOfflineDisplayText = useCallback((turn: ChatOfflineTurn) => {
        const rawSource = formatOfflineTurnXml(turn);
        const rawDisplay = renderDisplayText(rawSource, 2, true);
        const parsed = rawDisplay !== rawSource
            ? parseOfflineResponse(rawDisplay, turn.summaryTag || "summary")
            : null;
        const hasParsedDisplay = Boolean(parsed?.content.trim() || parsed?.summary.trim());
        return {
            userContent: renderDisplayText(turn.userContent, 1, true),
            assistantContent: hasParsedDisplay
                ? (parsed!.content.trim() || renderDisplayText(turn.assistantContent, 2, true))
                : renderDisplayText(turn.assistantContent, 2, true),
            summary: hasParsedDisplay
                ? (parsed!.summary.trim() || renderDisplayText(turn.summary, 2, true))
                : renderDisplayText(turn.summary, 2, true),
        };
    }, [formatOfflineTurnXml, renderDisplayText]);

    const visibleOfflineTurns = useMemo(() => {
        return offlineTurns.slice(-offlineVisibleCount);
    }, [offlineTurns, offlineVisibleCount]);

    const hasMoreOfflineTurns = visibleOfflineTurns.length < offlineTurns.length;

    const offlineDisplayByTurnId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof getOfflineDisplayText>>();
        for (const turn of visibleOfflineTurns) {
            map.set(turn.id, getOfflineDisplayText(turn));
        }
        return map;
    }, [getOfflineDisplayText, visibleOfflineTurns]);

    const loadMoreOfflineTurns = useCallback(() => {
        if (!hasMoreOfflineTurns) return;
        const el = scrollRef.current;
        if (el) {
            offlineLoadMoreRestoreRef.current = {
                scrollHeight: el.scrollHeight,
                scrollTop: el.scrollTop,
            };
        }
        setOfflineVisibleCount(count => Math.min(count + OFFLINE_LOAD_MORE_COUNT, offlineTurns.length));
    }, [hasMoreOfflineTurns, offlineTurns.length]);

    useLayoutEffect(() => {
        const restore = offlineLoadMoreRestoreRef.current;
        const el = scrollRef.current;
        if (!restore || !el) return;
        el.scrollTop = restore.scrollTop + (el.scrollHeight - restore.scrollHeight);
        offlineLoadMoreRestoreRef.current = null;
    }, [visibleOfflineTurns.length]);

    const handleOfflinePointerDown = (e: React.PointerEvent, target: OfflineActionTarget) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        const anchor = { x: e.clientX, y: e.clientY };
        startPosRef.current = anchor;
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            openOfflineContextMenu(target, anchor);
            longPressTimerRef.current = null;
        }, 500);
    };

    const handleOfflineEditStart = (turn: ChatOfflineTurn, role: OfflineActionTarget["role"]) => {
        setActiveOfflineTarget(null);
        setEditingOfflineTarget({ turnId: turn.id, role });
        setEditingOfflineContent(role === "user" ? turn.userContent : formatOfflineTurnXml(turn));
    };

    const doToggleOfflineMode = (isFromConfirmedInviteExit: boolean = false) => {
        cancelFollowUp(session.id);
        setShowPlusMenu(false);
        setShowEmojiPanel(false);
        setShowStickerPanel(false);
        setRichModal(null);
        setQuotingMessage(null);
        setActiveOfflineTarget(null);
        setOfflineTurns(loadChatOfflineTurns(session.id));
        setOfflineVisibleCount(OFFLINE_INITIAL_LOAD);
        setOfflineMode(prev => {
            const next = !prev;
            kvSet(CHAT_OFFLINE_MODE_PREFIX + session.id, next ? "1" : "0");
            if (prev && !next) {
                // 从线下切回线上时重置初始滚动标记，确保定位至最新对话
                needsInitialScrollRef.current = true;
                // 只有当明确是由角色邀约赴约结束（用户在确认弹窗点击确认）时，才触发角色主动发信（报平安/余韵）
                // 用户平时的手动线下切换绝对不触发！
                if (isFromConfirmedInviteExit && session.enableOfflineInvite && !session.isGroup) {
                    window.setTimeout(() => {
                        void runManagedGeneration({
                            history: loadChatMessages(session.id),
                            returnedFromOffline: true,
                        });
                    }, 600);
                }
            }
            return next;
        });
    };

    const handleCloseOfflineLockPopup = () => {
        setShowOfflineLockPopup(false);
        setIsReapplyingLock(false);
        if (lockDotsTimerRef.current) {
            clearTimeout(lockDotsTimerRef.current);
            lockDotsTimerRef.current = null;
        }
        setShowLockDotsHint(false);
        if (pendingKnockTriggerRef.current) {
            pendingKnockTriggerRef.current = false;
            // 弹窗关闭后延迟 500ms 触发角色发信
            window.setTimeout(() => {
                const charName = character?.name || "对方";
                const knockPrompt = `【剧情事件·对方连续请求线下相见】你此前因情绪抗拒拒绝与对方见面并关闭了线下入口。系统检测到对方此前在界面上接连发起了多次线下见面申请，坚持要来见你！你清清楚楚感知到了对方不肯放弃的执着与真心付出。请根据你的人设性格与当前心境主动发一条微信消息回应对方（你可以是傲娇质问为什么这么执着、可以是语气动摇心软、也可以是顺坡下驴借机缓和；若你决定彻底打开心扉允许对方过来，可在回复末尾附带 [解除封禁]）。`;
                void runManagedGeneration({
                    history: loadChatMessages(session.id),
                    offlineInitiativePrompt: knockPrompt,
                });
            }, 500);
        }
    };

    // 点击锁图标显现心防小圆点（持续2秒后自动隐藏）
    const handleTapLockIcon = () => {
        if (typeof window !== "undefined" && "vibrate" in navigator) {
            try {
                navigator.vibrate(25);
            } catch {}
        }
        if (lockDotsTimerRef.current) {
            clearTimeout(lockDotsTimerRef.current);
        }
        setShowLockDotsHint(true);
        lockDotsTimerRef.current = setTimeout(() => {
            setShowLockDotsHint(false);
            lockDotsTimerRef.current = null;
        }, 2000);
    };

    const handleReapplyOfflineLock = () => {
        if (isReapplyingLock || !offlineLockData) return;
        setIsReapplyingLock(true);

        // 切换至独立申请中弹层
        setShowOfflineLockPopup(false);
        setShowOfflineApplyingPopup(true);

        // 缓慢厚重的两下震动（60ms 叩击 ➔ 140ms 沉寂 ➔ 70ms 次叩）
        if (typeof window !== "undefined" && "vibrate" in navigator) {
            try {
                navigator.vibrate([60, 140, 70]);
            } catch {}
        }

        // 申请中展示 1500ms
        window.setTimeout(() => {
            setShowOfflineApplyingPopup(false);
            setIsReapplyingLock(false);

            const newCount = (offlineLockData.knockCount || 0) + 1;
            const newStageKnocks = (offlineLockData.stageKnocks || 0) + 1;

            if (newCount >= offlineLockData.requiredKnocks) {
                // 达到心墙阈值：重置当前轮次计次，保留本阶段累计总数，并触发角色主动发信
                const reset: OfflineLockData = {
                    ...offlineLockData,
                    knockCount: 0,
                    stageKnocks: newStageKnocks,
                };
                kvSet(OFFLINE_LOCK_PREFIX + session.id, JSON.stringify(reset));
                setOfflineLockData(reset);
                offlineLockDataRef.current = reset;

                window.setTimeout(() => {
                    const effortDetail = newStageKnocks > newCount
                        ? `系统检测到对方刚刚不顾被拒绝，连续按下了整整 ${newCount} 次线下见面申请（在此次被你拒绝见面的拉扯中，对方前后已经累计为你按下了整整 ${newStageKnocks} 次申请）！`
                        : `系统检测到对方刚刚不顾被拒绝，在界面上连续按下了整整 ${newCount} 次线下见面申请，坚持要来见你！`;
                    const defaultKnockPrompt = `【剧情事件·对方连续请求线下相见】你此前因情绪抗拒拒绝与对方见面并关闭了线下入口（你原本要求至少申请 ${offlineLockData.requiredKnocks} 次）。${effortDetail}你清清楚楚感知到了对方不肯放弃的执着叩击与实际付出。请根据你的人设性格与当前心境主动发一条微信消息回应对方（你可以是傲娇质问为什么这么执着按了这么多次、可以是语气动摇被触动、也可以是顺坡下驴借机缓和；你可以根据当下心防与情绪选择：若被触动心软可在末尾附带 [封禁线下:更小次数]；若更生气坚决可在末尾附带 [封禁线下:更大次数]；若依然坚决防守但愿回信则可保持心墙现状；若决定彻底打开心扉愿意见面，可在末尾附带 [解除封禁]）。`;
                    const knockPrompt = session.offlineKnockPrompt?.trim()
                        ? `【剧情事件·对方连续请求线下相见】你此前因情绪抗拒拒绝与对方见面并关闭了线下入口（你原本要求至少申请 ${offlineLockData.requiredKnocks} 次）。${effortDetail}你清清楚楚感知到了对方不肯放弃的执着叩击与实际付出。\n\n${session.offlineKnockPrompt.trim()}`
                        : defaultKnockPrompt;
                    void runManagedGeneration({
                        history: loadChatMessages(session.id),
                        offlineInitiativePrompt: knockPrompt,
                        isKnockThresholdTriggered: true,
                    });
                }, 500);
            } else {
                // 尚未达到阈值：累加次数并持久化，优雅切回拒绝弹窗
                const updated: OfflineLockData = {
                    ...offlineLockData,
                    knockCount: newCount,
                    stageKnocks: newStageKnocks,
                };
                kvSet(OFFLINE_LOCK_PREFIX + session.id, JSON.stringify(updated));
                setOfflineLockData(updated);
                offlineLockDataRef.current = updated;
                setShowOfflineLockPopup(true);
            }
        }, 1500);
    };

    const toggleOfflineMode = () => {
        if (!offlineMode && isGenerating) {
            showChatToast("请先等待对方回复");
            return;
        }
        if (offlineMode && isOfflineGenerating) {
            showChatToast("线下回复生成中");
            return;
        }
        // 线下封禁拦截：仅在尝试进入线下时（!offlineMode）且处于封禁状态时拦截
        if (!offlineMode && offlineLockData?.isLocked && session.enableOfflineLock && !session.isGroup) {
            // 震动两下叩门反馈
            if (typeof window !== "undefined" && "vibrate" in navigator) {
                try {
                    navigator.vibrate([60, 140, 70]);
                } catch {}
            }
            const newCount = (offlineLockData.knockCount || 0) + 1;
            const newStageKnocks = (offlineLockData.stageKnocks || 0) + 1;

            if (newCount >= offlineLockData.requiredKnocks) {
                // 达到阈值：直接进入 1.5 秒申请中过渡，完成后触发角色主动发信
                setShowOfflineApplyingPopup(true);
                window.setTimeout(() => {
                    setShowOfflineApplyingPopup(false);
                    const reset: OfflineLockData = {
                        ...offlineLockData,
                        knockCount: 0,
                        stageKnocks: newStageKnocks,
                    };
                    kvSet(OFFLINE_LOCK_PREFIX + session.id, JSON.stringify(reset));
                    setOfflineLockData(reset);
                    offlineLockDataRef.current = reset;

                    window.setTimeout(() => {
                        const effortDetail = newStageKnocks > newCount
                            ? `系统检测到对方刚刚不顾被拒绝，连续按下了整整 ${newCount} 次线下见面申请（在此次被你拒绝见面的拉扯中，对方前后已经累计为你按下了整整 ${newStageKnocks} 次申请）！`
                            : `系统检测到对方刚刚不顾被拒绝，在界面上连续按下了整整 ${newCount} 次线下见面申请，坚持要来见你！`;
                        const defaultKnockPrompt = `【剧情事件·对方连续请求线下相见】你此前因情绪抗拒拒绝与对方见面并关闭了线下入口（你原本要求至少申请 ${offlineLockData.requiredKnocks} 次）。${effortDetail}你清清楚楚感知到了对方不肯放弃的执着叩击与实际付出。请根据你的人设性格与当前心境主动发一条微信消息回应对方（你可以是傲娇质问为什么这么执着按了这么多次、可以是语气动摇被触动、也可以是顺坡下驴借机缓和；你可以根据当下心防与情绪选择：若被触动心软可在末尾附带 [封禁线下:更小次数]；若更生气坚决可在末尾附带 [封禁线下:更大次数]；若依然坚决防守但愿回信则可保持心墙现状；若决定彻底打开心扉愿意见面，可在末尾附带 [解除封禁]）。`;
                    const knockPrompt = session.offlineKnockPrompt?.trim()
                        ? `【剧情事件·对方连续请求线下相见】你此前因情绪抗拒拒绝与对方见面并关闭了线下入口（你原本要求至少申请 ${offlineLockData.requiredKnocks} 次）。${effortDetail}你清清楚楚感知到了对方不肯放弃的执着叩击与实际付出。\n\n${session.offlineKnockPrompt.trim()}`
                        : defaultKnockPrompt;
                        void runManagedGeneration({
                            history: loadChatMessages(session.id),
                            offlineInitiativePrompt: knockPrompt,
                            isKnockThresholdTriggered: true,
                        });
                    }, 500);
                }, 1500);
                return;
            }

            // 尚未达到阈值：累加次数并持久化，弹出拒绝弹窗
            const updated: OfflineLockData = {
                ...offlineLockData,
                knockCount: newCount,
                stageKnocks: newStageKnocks,
            };
            kvSet(OFFLINE_LOCK_PREFIX + session.id, JSON.stringify(updated));
            setOfflineLockData(updated);
            offlineLockDataRef.current = updated;
            setShowOfflineLockPopup(true);
            return;
        }
        // 解除封禁待前往拦截：仅在尝试进入线下时（!offlineMode）且存在待前往标记时拦截，弹出确认弹窗
        if (!offlineMode && session.enableOfflineLock && !session.isGroup && kvGet(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id) === "1") {
            setShowOfflineUnlockedConfirmModal(true);
            return;
        }
        // 如果当前在线下模式，且当前会话属于“角色主动发起见面的线下赴约”：弹出确认弹窗
        if (offlineMode && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1") {
            setShowConfirmExitOfflineInvite(true);
            return;
        }
        doToggleOfflineMode(false);
    };

    const handleAcceptOfflineInvite = () => {
        if (!activeOfflineInvite) return;
        if (remindExpandTimerRef.current) {
            clearTimeout(remindExpandTimerRef.current);
            remindExpandTimerRef.current = null;
        }
        // 如果是角色来见用户，且当前还在待答应（pending）阶段：答应后开启“在途赶来”阶段
        if (activeOfflineInvite.direction === "he_comes" && activeOfflineInvite.status === "pending") {
            const duration = activeOfflineInvite.durationMinutes || 15;
            const inTransitInvite: OfflineInviteData = {
                ...activeOfflineInvite,
                status: "on_the_way",
                startTime: Date.now(),
                durationMinutes: duration,
                hasFiredArrivalMessage: false,
            };
            updateActiveOfflineInvite(inTransitInvite);
            setIsOfflineInviteMinimized(true);
            showChatToast(`${character?.name || "对方"}已动身，预计 ${duration} 分钟后到达`);

            // 同意动身：系统居中小灰字记录同意与动身状态
            const charName = character?.name || "对方";
            const rawPlace = activeOfflineInvite.place?.trim();
            const placeStr = rawPlace ? (rawPlace === "你身边" ? "你身边" : `「${rawPlace}」`) : "约定地点";
            const sysAcceptMsg = pushChatMessage({
                sessionId: session.id,
                role: "system",
                content: `你已同意赴约，${charName} 正在动身赶往${placeStr}`,
                mediaType: "offline_invite_system_notice",
                mediaData: { offlineInvite: inTransitInvite },
            });
            setMessages(prev => [...prev, sysAcceptMsg]);

            // 若用户稍后处理后自主点击答应，自动补发动身消息（延迟 1 秒模拟打字）
            const lastMsg = messages[messages.length - 1];
            const wasJustReminded = Boolean(
                lastRemindBatchIdRef.current && lastMsg?.responseBatchId === lastRemindBatchIdRef.current
            );
            if (!wasJustReminded) {
                // 使用 AI 动态生成的动身回复，避免死板模板
                const transitChat = sanitizeTransitMessage(
                    activeOfflineInvite.onTheWayMessage,
                    activeOfflineInvite.direction,
                    activeOfflineInvite.place
                );
                // 模拟角色打字 1 秒后发出
                window.setTimeout(() => {
                    const newMsg = pushChatMessage({
                        sessionId: session.id,
                        role: "assistant",
                        content: transitChat,
                    });
                    setMessages(prev => [...prev, newMsg]);
                }, 1000);
            }
            return;
        }

        // 若已到达（arrived）或角色在途用户提前去见，或用户主动去赴约（i_go）：进入线下模式
        const isHeComes = activeOfflineInvite.direction === "he_comes";
        const place = activeOfflineInvite.place || "约定地点";

        // 获取本次邀约拉扯期间用户曾点击拒绝的次数（客观陈述事实，情绪反应100%归还给角色人设与心境）
        const priorDeclineCount = parseInt(kvGet(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id) || "0", 10);
        const declineContextNotice = priorDeclineCount > 0
            ? `【重要背景：用户此前在界面上曾连续拒绝了你 ${priorDeclineCount} 次，经历了拉扯后如今终于答应来到现场与你碰面。请100%严格根据你的角色性格底色与当前真实心境（傲娇别扭/调侃挽尊/成熟包容/后怕珍惜/冷嘲热讽/……），自主决定第一句对话与神态动作。】`
            : "";

        // 长期记忆沉淀：仅在本次推拉中曾被拒绝（priorDeclineCount > 0）时，在碰面瞬间调用记忆总结模型沉淀专属羁绊记忆
        if (priorDeclineCount > 0) {
            const uName = userIdentity?.name?.trim() || "你";
            const cName = character?.name || "对方";
            const isOriginByYourSide = activeOfflineInvite.initialPlace === "你身边" || (!activeOfflineInvite.initialPlace && activeOfflineInvite.place === "你身边");
            const fallbackPlaceDesc = isOriginByYourSide ? "身边" : `「${place}」`;
            const fallbackContent = `「${uName}多次拒绝${cName}线下邀约的记录」：此前${cName}提议前往${fallbackPlaceDesc}见面，虽曾被${uName}连续推开婉拒了 ${priorDeclineCount} 次，但几番拉扯后${uName}最终答应赴约相见，两人顺利碰面相聚。`;
            const allMsgs = loadChatMessages(session.id);
            void summarizeAndSaveOfflineBondMemory({
                characterId: session.contactId,
                characterName: cName,
                userName: uName,
                eventType: "invite_decline",
                count: priorDeclineCount,
                place: isOriginByYourSide ? "身边" : place,
                allStoredMessages: allMsgs,
                fallbackContent,
                customStylePrompt: session.offlineInviteMemoryPrompt,
            });
        }

        const defaultInitiativePrompt = isHeComes
            ? `【线下相遇开场·你奔赴来见用户】：是你主动动身来到用户所在的地方（奔赴地点：${place}）。此时你刚刚抵达并在现场见到了走出来的用户。这是你们在线下碰面的第一刻，请以你的角色人设输出你见到用户时的第一句话与动作描写（注意是你奔赴来见对方，例如在车旁或路灯下看见对方迎上前去、递上热饮、上下打量对方温和打招呼等）。绝对严禁写成用户跑来你的地盘找你！${declineContextNotice}`
            : `【线下相遇开场·用户前来赴约找你】：你在约定的地点（奔赴地点：${place}）等候，用户此时如约赶到了现场。这是你们在线下见面的第一刻，请以你的角色人设输出你迎接用户时的第一句话与动作描写（例如在座位上看到对方走来起身招手、招呼对方坐下等）。${declineContextNotice}`;

        const initiativePrompt = session.offlineMeetingInitiativePrompt?.trim()
            ? `${session.offlineMeetingInitiativePrompt.trim()}${declineContextNotice ? `\n\n${declineContextNotice}` : ""}`
            : defaultInitiativePrompt;

        const rawPlace = activeOfflineInvite.place?.trim();
        const isByYourSide = rawPlace === "你身边" || activeOfflineInvite.initialPlace === "你身边";
        const placeStr = isByYourSide ? "你身边" : (rawPlace ? `「${rawPlace}」` : "约定地点");
        const sysMeetingMsg = pushChatMessage({
            sessionId: session.id,
            role: "system",
            content: `双方正在${placeStr}线下碰面中`,
            mediaType: "offline_invite_system_notice",
            mediaData: { offlineInvite: activeOfflineInvite },
        });
        setMessages(prev => [...prev, sysMeetingMsg]);

        // 标记本次线下是由角色自主邀约赴约开启的
        kvSet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id, "1");
        if (activeOfflineInvite.theme) {
            kvSet(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id, activeOfflineInvite.theme);
        }
        updateActiveOfflineInvite(null);
        setIsOfflineInviteMinimized(false);
        kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
        kvRemove(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id);
        kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);
        showChatToast("正在奔赴线下...");
        doToggleOfflineMode(false);

        // 角色在线下主动说出第一句话（开场白）
        if (session.offlineInviteAutoFirstSpeech !== false) {
            window.setTimeout(() => {
                void handleOfflineSend("", { isInitiative: true, initiativePrompt });
            }, 600);
        }
    };

    const handleDeclineOfflineInvite = () => {
        if (!activeOfflineInvite) return;
        if (remindExpandTimerRef.current) {
            clearTimeout(remindExpandTimerRef.current);
            remindExpandTimerRef.current = null;
        }

        const declineTheme = activeOfflineInvite.theme || "default";
        const isOriginByYourSide = activeOfflineInvite.initialPlace === "你身边" || (!activeOfflineInvite.initialPlace && activeOfflineInvite.place === "你身边");
        const rawPlace = activeOfflineInvite.place?.trim();
        const declinePlace = isOriginByYourSide ? "你身边" : (rawPlace || "");
        const declineReason = activeOfflineInvite.reason || "";
        const declineDirection = activeOfflineInvite.direction || "he_comes";

        const currentDeclineCount = parseInt(kvGet(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id) || "0", 10) + 1;
        kvSet(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id, String(currentDeclineCount));

        const declineContext: OfflineInviteDeclineContext = {
            theme: declineTheme,
            place: declinePlace,
            reason: declineReason,
            direction: declineDirection,
            declineCount: currentDeclineCount,
        };

        // 婉拒交代：留下拒绝记录，便于后续对话衔接（规范术语为“线下邀约提议”）
        const charName = character?.name || "对方";
        const sysDeclineMsg = pushChatMessage({
            sessionId: session.id,
            role: "system",
            content: `你婉拒了 ${charName} 的线下邀约提议`,
            mediaType: "offline_invite_system_notice",
        });
        setMessages(prev => [...prev, sysDeclineMsg]);

        updateActiveOfflineInvite(null);
        setIsOfflineInviteMinimized(false);
        if (remindExpandTimerRef.current) {
            clearTimeout(remindExpandTimerRef.current);
            remindExpandTimerRef.current = null;
        }
        kvSet(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id, JSON.stringify(declineContext));

        // 拒绝拉扯多级弹窗：第1次无弹窗；2~5次阶段性递进展示；第6次及以后进入常驻罢工状态，后台暗中真实累加直至碰面提炼记忆
        let declineToastText: string | null = null;
        if (currentDeclineCount === 2) {
            declineToastText = `这是你第 2 次婉拒了${charName}的线下见面`;
        } else if (currentDeclineCount === 3) {
            declineToastText = `这是你第 3 次婉拒了${charName}的线下见面\n你以为Ta不知道吗？`;
        } else if (currentDeclineCount === 4) {
            declineToastText = `这是你第 4 次婉拒了${charName}的线下见面\n你到底还要推开Ta多少次？`;
        } else if (currentDeclineCount === 5) {
            declineToastText = `这是你第 5 次婉拒了${charName}的线下见面\n计数器快数不过来了……`;
        } else if (currentDeclineCount >= 6) {
            declineToastText = `计数器已累瘫罢工\n但${charName}依旧把你每一次的推开刻在心上……`;
        }

        if (declineToastText) {
            showChatToast(declineToastText, 4500);
        }
        if (session.enableOfflineInvite && !session.isGroup) {
            void runManagedGeneration({
                history: loadChatMessages(session.id),
                offlineInviteDeclined: declineContext,
            });
        }
    };

    const handleEarlyArriveOfflineInvite = () => {
        if (!activeOfflineInvite || activeOfflineInvite.hasFiredArrivalMessage) return;
        const remainingMins = getRemainingMinutes(activeOfflineInvite.startTime, activeOfflineInvite.durationMinutes || 15);
        const arriveBatchId = `offline_early_arrive_${Date.now()}`;
        const arrivedInvite: OfflineInviteData = {
            ...activeOfflineInvite,
            status: "arrived",
            isEarlyArrived: true,
            hasFiredArrivalMessage: true,
            frozenRemainingMinutes: remainingMins,
            relatedBatchIds: Array.from(new Set([...(activeOfflineInvite.relatedBatchIds || []), arriveBatchId])),
        };
        updateActiveOfflineInvite(arrivedInvite);
        setIsOfflineInviteMinimized(false);

        // 提前到达：在聊天流中留下提前到达系统小灰字记录
        const charName = character?.name || "对方";
        const isOriginByYourSide = activeOfflineInvite.initialPlace === "你身边" || (!activeOfflineInvite.initialPlace && activeOfflineInvite.place === "你身边");
        const rawPlace = activeOfflineInvite.place?.trim();
        const placeStr = isOriginByYourSide ? "你身边" : (rawPlace ? (rawPlace === "你身边" ? "你身边" : `「${rawPlace}」`) : "约定地点");
        const sysArriveMsg = pushChatMessage({
            sessionId: session.id,
            role: "system",
            content: activeOfflineInvite.direction === "he_comes"
                ? `${charName} 已提前到达${placeStr}`
                : `${charName} 已在${placeStr}就位等候`,
            mediaType: "offline_invite_system_notice",
            mediaData: { offlineInvite: arrivedInvite },
        });
        setMessages(prev => [...prev, sysArriveMsg]);

        // 延迟 1 秒模拟打字后发出到达消息
        const arrivalChatText = getArrivalChatMessage(activeOfflineInvite);
        window.setTimeout(() => {
            const newMsg = pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: arrivalChatText,
                responseBatchId: arriveBatchId,
                mediaType: "offline_invite_arrive_notice",
            });
            setMessages(prev => [...prev, newMsg]);
        }, 1000);
    };

    const handleMinimizeOfflineInvite = () => {
        setIsOfflineInviteMinimized(true);
    };

    const handleExpandOfflineInvite = () => {
        if (remindExpandTimerRef.current) {
            clearTimeout(remindExpandTimerRef.current);
            remindExpandTimerRef.current = null;
        }
        setIsOfflineInviteMinimized(false);
    };

    const toggleTheaterMode = () => {
        setShowPlusMenu(false);
        setShowEmojiPanel(false);
        setShowStickerPanel(false);
        setTheaterMode(prev => {
            const next = !prev;
            if (next) kvSet(CHAT_THEATER_MODE_PREFIX + session.id, "1");
            else kvRemove(CHAT_THEATER_MODE_PREFIX + session.id);
            return next;
        });
    };

    const closeTheaterMode = () => {
        kvRemove(CHAT_THEATER_MODE_PREFIX + session.id);
        setTheaterMode(false);
    };

    const handleOfflineSend = (inputText: string, options?: { isInitiative?: boolean; initiativePrompt?: string }): boolean => {
        if (isOfflineGenerating) {
            showChatToast("线下回复生成中");
            return false;
        }
        const isInitiative = options?.isInitiative === true;
        const currentText = inputText.trim();
        if (!currentText && !(session.isGroup && session.isSpectator) && !isInitiative) return false;

        cancelFollowUp(session.id);
        setShowPlusMenu(false);
        setShowEmojiPanel(false);
        setShowStickerPanel(false);
        setRichModal(null);
        setPendingOfflineUserText(currentText);
        offlineGenerationInputRef.current = currentText;
        setIsOfflineGenerating(true);
        offlineStreamAccumRef.current = "";
        setOfflineStreamPreview(null);
        const offlineRun = createOfflineGenerationRun(session.id);
        const offlineRunId = offlineRun.runId;
        const isCurrentOfflineRun = () => isOfflineGenerationRunActive(session.id, offlineRunId);

        void (async () => {
            try {
                const history = buildOfflinePromptHistory(offlineTurns, currentText);
                const onOfflineDelta = (delta: string) => {
                    if (!isCurrentOfflineRun()) return;
                    offlineStreamAccumRef.current += delta;
                    // 线下预览解析合并到 rAF 下一帧：每帧最多一次全文解析+setState
                    if (offlineStreamFrameRef.current) return;
                    offlineStreamFrameRef.current = window.requestAnimationFrame(() => {
                        offlineStreamFrameRef.current = 0;
                        if (!isCurrentOfflineRun()) return;
                        // 与引擎顺序一致：先按预设 strip_texts 清洗原文，再解析（避免剔除文本影响 XML 结构时预览与最终结果不一致）
                        const previewRaw = stripLiteralTexts(offlineStreamAccumRef.current, streamPreviewTagConfig.stripTexts);
                        const parsed = parseOfflineResponse(previewRaw, streamPreviewTagConfig.summaryTag);
                        // 流式碎片阶段 XML 标签可能未闭合：content 提取不到时，剥掉开标签残片直接显示原文；
                        // 思维链/自定义摘要标签按当前预设整块隐藏，避免生成过程中闪现（与引擎最终清洗同源）
                        const previewContent = (parsed.content
                            ? stripXmlTagBlocks(parsed.content, [streamPreviewTagConfig.summaryTag, ...streamPreviewTagConfig.offlineThinking])
                            : stripXmlTagBlocks(previewRaw, [streamPreviewTagConfig.summaryTag, ...streamPreviewTagConfig.offlineThinking])
                                .replace(/<\/?(?:content|summary|thinking|thought|think)>/gi, "")
                                .replace(/<[^>]+>/g, "")
                        ).trim();
                        setOfflineStreamPreview({ content: previewContent, summary: parsed.summary });
                    });
                };
                const result = session.isGroup
                    ? await generateGroupOfflineChatCompletion(session, history, { signal: offlineRun.controller.signal, onStreamDelta: onOfflineDelta })
                    : await generateOfflineChatCompletion(session, history, {
                        signal: offlineRun.controller.signal,
                        onStreamDelta: onOfflineDelta,
                        offlineInitiativePrompt: options?.initiativePrompt,
                    });
                if (!isCurrentOfflineRun()) return;
                const assistantContent = result.content.trim() || result.rawText.trim();
                if (!assistantContent) throw new Error("AI 没有返回线下正文");
                if (!result.summary.trim()) showChatToast(`未提取到 <${result.summaryTag}> 摘要`);
                const saved = appendChatOfflineTurn({
                    sessionId: session.id,
                    userContent: currentText,
                    assistantContent,
                    summary: result.summary.trim(),
                    summaryTag: result.summaryTag,
                    rawText: result.rawText,
                    reasoningText: result.reasoning,
                    thinkingText: result.thinking,
                    thinkingTag: result.thinkingTag,
                });
                setOfflineTurns(prev => [...prev, saved]);
            } catch (error: any) {
                if (!isCurrentOfflineRun() || isAbortLikeError(error)) return;
                offlineTextInputRef.current?.setText(currentText);
                showChatToast(`线下生成失败: ${error?.message || String(error)}`, 3000);
            } finally {
                if (!finishOfflineGenerationRun(session.id, offlineRunId)) return;
                setPendingOfflineUserText("");
                offlineGenerationInputRef.current = "";
                setIsOfflineGenerating(false);
                offlineStreamAccumRef.current = "";
                setOfflineStreamPreview(null);
            }
        })();
        return true;
    };

    const handleOfflineEditSave = () => {
        if (!editingOfflineTarget) return;
        const content = editingOfflineContent.trim();
        const turn = offlineTurns.find(item => item.id === editingOfflineTarget.turnId);
        if (!turn) {
            setEditingOfflineTarget(null);
            setEditingOfflineContent("");
            return;
        }
        if (!content) {
            showChatToast("编辑内容不能为空");
            return;
        }

        if (editingOfflineTarget.role === "user") {
            const nextContent = applyEditTextRegex(content, 1, true);
            const updated = updateChatOfflineTurn(session.id, turn.id, { userContent: nextContent });
            if (updated) setOfflineTurns(prev => prev.map(item => item.id === updated.id ? updated : item));
            setEditingOfflineTarget(null);
            setEditingOfflineContent("");
            return;
        }

        const nextContent = applyEditTextRegex(content, 2, true);
        const parsed = parseOfflineResponse(nextContent, turn.summaryTag || "summary");
        const assistantContent = parsed.content.trim() || parsed.rawText.trim();
        if (!assistantContent) {
            showChatToast("没有解析到线下正文");
            return;
        }
        if (!parsed.summary.trim()) showChatToast(`未提取到 <${parsed.summaryTag}> 摘要`);
        // 思维链：parseOfflineResponse 已回归官方两参数（不再提取 thinking）。
        // 若该条原本带标签思维链（预设开启线下标签解析），按原标签从编辑后的正文重新提取，否则保持无。
        const editedThinking = turn.thinkingText !== undefined
            ? (extractThinkingTag(nextContent, turn.thinkingTag) || undefined)
            : undefined;
        const updated = updateChatOfflineTurn(session.id, turn.id, {
            assistantContent,
            summary: parsed.summary.trim(),
            summaryTag: parsed.summaryTag,
            rawText: parsed.rawText,
            thinkingText: editedThinking,
            thinkingTag: editedThinking !== undefined ? turn.thinkingTag : undefined,
        });
        if (updated) setOfflineTurns(prev => prev.map(item => item.id === updated.id ? updated : item));
        setEditingOfflineTarget(null);
        setEditingOfflineContent("");
    };

    const handleOfflineDeleteTurn = (turnId: string) => {
        setOfflineTurns(deleteChatOfflineTurn(session.id, turnId));
        setActiveOfflineTarget(null);
    };

    const handleOfflineDeleteTurnsFrom = (turnId: string) => {
        setOfflineTurns(deleteChatOfflineTurnsFrom(session.id, turnId));
        setActiveOfflineTarget(null);
    };

    const handleOfflineRetryFrom = async (turnId: string) => {
        if (isOfflineGenerating) {
            showChatToast("线下回复生成中");
            return;
        }
        const idx = offlineTurns.findIndex(turn => turn.id === turnId);
        if (idx < 0) return;
        const targetTurn = offlineTurns[idx];
        const baseTurns = offlineTurns.slice(0, idx);
        const retryInput = targetTurn.userContent.trim();
        if (!retryInput) {
            showChatToast("这一轮没有可重试的用户输入");
            return;
        }

        cancelFollowUp(session.id);
        setActiveOfflineTarget(null);
        setShowPlusMenu(false);
        setShowEmojiPanel(false);
        setShowStickerPanel(false);
        setRichModal(null);
        saveChatOfflineTurns(session.id, baseTurns);
        setOfflineTurns(baseTurns);
        setPendingOfflineUserText(retryInput);
        offlineGenerationInputRef.current = retryInput;
        setIsOfflineGenerating(true);
        offlineStreamAccumRef.current = "";
        setOfflineStreamPreview(null);
        const offlineRun = createOfflineGenerationRun(session.id);
        const offlineRunId = offlineRun.runId;
        const isCurrentOfflineRun = () => isOfflineGenerationRunActive(session.id, offlineRunId);

        try {
            const history = buildOfflinePromptHistory(baseTurns, retryInput);
            const onOfflineDelta = (delta: string) => {
                if (!isCurrentOfflineRun()) return;
                offlineStreamAccumRef.current += delta;
                // 线下预览解析合并到 rAF 下一帧：每帧最多一次全文解析+setState（与首次发送路径对齐）
                if (offlineStreamFrameRef.current) return;
                offlineStreamFrameRef.current = window.requestAnimationFrame(() => {
                    offlineStreamFrameRef.current = 0;
                    if (!isCurrentOfflineRun()) return;
                    // 与引擎顺序一致：先按预设 strip_texts 清洗原文，再解析（避免剔除文本影响 XML 结构时预览与最终结果不一致）
                    const previewRaw = stripLiteralTexts(offlineStreamAccumRef.current, streamPreviewTagConfig.stripTexts);
                    const parsed = parseOfflineResponse(previewRaw, streamPreviewTagConfig.summaryTag);
                    // 流式碎片阶段 XML 标签可能未闭合：content 提取不到时，剥掉开标签残片直接显示原文；
                    // 思维链/自定义摘要标签按当前预设整块隐藏，避免生成过程中闪现（与引擎最终清洗同源）
                    const previewContent = (parsed.content
                        ? stripXmlTagBlocks(parsed.content, [streamPreviewTagConfig.summaryTag, ...streamPreviewTagConfig.offlineThinking])
                        : stripXmlTagBlocks(previewRaw, [streamPreviewTagConfig.summaryTag, ...streamPreviewTagConfig.offlineThinking])
                            .replace(/<\/?(?:content|summary|thinking|thought|think)>/gi, "")
                            .replace(/<[^>]+>/g, "")
                    ).trim();
                    setOfflineStreamPreview({ content: previewContent, summary: parsed.summary });
                });
            };
            const result = session.isGroup
                ? await generateGroupOfflineChatCompletion(session, history, { signal: offlineRun.controller.signal, onStreamDelta: onOfflineDelta })
                : await generateOfflineChatCompletion(session, history, { signal: offlineRun.controller.signal, onStreamDelta: onOfflineDelta });
            if (!isCurrentOfflineRun()) return;
            const assistantContent = result.content.trim() || result.rawText.trim();
            if (!assistantContent) throw new Error("AI 没有返回线下正文");
            if (!result.summary.trim()) showChatToast(`未提取到 <${result.summaryTag}> 摘要`);
            const saved = appendChatOfflineTurn({
                sessionId: session.id,
                userContent: retryInput,
                assistantContent,
                summary: result.summary.trim(),
                summaryTag: result.summaryTag,
                rawText: result.rawText,
                reasoningText: result.reasoning,
                thinkingText: result.thinking,
                thinkingTag: result.thinkingTag,
            });
            setOfflineTurns([...baseTurns, saved]);
        } catch (error: any) {
            if (!isCurrentOfflineRun() || isAbortLikeError(error)) return;
            offlineTextInputRef.current?.setText(retryInput);
            showChatToast(`线下重试失败: ${error?.message || String(error)}`, 3000);
        } finally {
            if (!finishOfflineGenerationRun(session.id, offlineRunId)) return;
            setPendingOfflineUserText("");
            offlineGenerationInputRef.current = "";
            setIsOfflineGenerating(false);
            offlineStreamAccumRef.current = "";
            setOfflineStreamPreview(null);
        }
    };

    const handleRetry = async (msgId: string) => {
        const msgIndex = messages.findIndex(m => m.id === msgId);
        if (msgIndex === -1 || messages[msgIndex].role !== "assistant") return;

        const targetRetryMsg = messages[msgIndex];
        const contextMessages = messages.slice(0, msgIndex);
        const truncatedMessages = messages.slice(msgIndex);

        const currentInvite = activeOfflineInviteRef.current;
        const rootId = currentInvite?.initialBatchId || currentInvite?.sourceBatchId;
        const truncatesInitialRoot = Boolean(
            currentInvite &&
            currentInvite.sourceBatchId !== "mock_offline_invite" &&
            rootId &&
            truncatedMessages.some(m => m.responseBatchId === rootId) &&
            // 仅当剩余上下文中不再包含任何赴约根基（提议或同意记录）时，才视为根被截断
            !contextMessages.some(m =>
                (rootId && (m.responseBatchId === rootId || m.id === rootId)) ||
                m.mediaData?.offlineInvite ||
                (m.role === "system" && m.content && (
                    m.content.includes("你已同意赴约") ||
                    m.content.includes("线下赴约提议") ||
                    m.content.includes("正在动身赶往") ||
                    m.content.includes("前往")
                ))
            )
        );

        // 若当前正处于线下碰面中（用户切回线上发悄悄话）：
        // 关键判定：只有当重试截断了“双方正在xx线下碰面中”系统记录（即重试碰面之前的历史消息），才需要弹窗确认结束碰面并回溯！
        // 若重试的消息发生在“双方正在xx线下碰面中”之后（即碰面进行中的悄悄话对话），
        // 属于碰面现场的当场重抽，绝不弹窗、绝不结束线下，顶栏【回到现场】胶囊严格保持不变，直接放行重试！
        const isMeetingActive = !session.isGroup && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1";
        if (isMeetingActive) {
            let lastMeetingNoticeIdx = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                if ((m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && m.content.includes("线下碰面中"))) {
                    lastMeetingNoticeIdx = i;
                    break;
                }
            }

            const truncatesMeetingNotice = lastMeetingNoticeIdx === -1 || msgIndex <= lastMeetingNoticeIdx;
            if (truncatesMeetingNotice) {
                setActiveMessageId(null);
                setOfflineRetryConfirm({
                    msgId,
                    targetMsg: targetRetryMsg,
                    msgIndex,
                    truncatedMessages,
                    truncatesInitialRoot,
                    contextMessages,
                });
                return;
            }
        }

        const executeRetry = async () => {
            // Delete this message and everything after it
            deleteChatMessagesFrom(msgId);
            setMessages(prev => prev.slice(0, msgIndex));
            setActiveMessageId(null);

            // Cancel any pending follow-up for this session
            cancelFollowUp(session.id);

            // 取消可能存在的解封弹窗倒计时
            if (unlockExpandTimerRef.current) {
                clearTimeout(unlockExpandTimerRef.current);
                unlockExpandTimerRef.current = null;
            }

            // 封禁状态时光回溯：根据回退后的上下文历史同步恢复封禁状态机
            if (session.enableOfflineLock && !session.isGroup) {
                let latestEvent: { type: "unlock" } | { type: "lock"; lockData: OfflineLockData } | null = null;
                for (let i = contextMessages.length - 1; i >= 0; i--) {
                    const m = contextMessages[i];
                    if (
                        m.mediaType === "offline_unlock_system_notice" ||
                        (m.role === "system" && m.content && /已解除线下封禁/.test(m.content))
                    ) {
                        latestEvent = { type: "unlock" };
                        break;
                    }
                    if (
                        m.mediaType === "offline_lock_system_notice" ||
                        Boolean(m.mediaData?.offlineLock)
                    ) {
                        const lockData = (m.mediaData?.offlineLock as OfflineLockData) || null;
                        if (lockData) {
                            latestEvent = { type: "lock", lockData };
                            break;
                        }
                    }
                }

                if (latestEvent?.type === "lock") {
                    let activeLock = latestEvent.lockData;
                    const currentInMemory = offlineLockDataRef.current;
                    if (currentInMemory && currentInMemory.isLocked && currentInMemory.requiredKnocks === activeLock.requiredKnocks) {
                        activeLock = {
                            ...activeLock,
                            knockCount: currentInMemory.knockCount ?? activeLock.knockCount ?? 0,
                            stageKnocks: currentInMemory.stageKnocks ?? activeLock.stageKnocks ?? 0,
                        };
                    }
                    kvSet(OFFLINE_LOCK_PREFIX + session.id, JSON.stringify(activeLock));
                    setOfflineLockData(activeLock);
                    offlineLockDataRef.current = activeLock;
                    kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);
                } else {
                    kvRemove(OFFLINE_LOCK_PREFIX + session.id);
                    setOfflineLockData(null);
                    offlineLockDataRef.current = null;
                    kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);
                }
            }

            // 重试状态保全、根截断与历史回溯处理：
            if (session.enableOfflineInvite && !session.isGroup) {
                if (currentInvite?.sourceBatchId === "mock_offline_invite") {
                    // mock 数据保持原样
                } else if (truncatesInitialRoot) {
                    // 若重试截断了最初发起消息，彻底取消邀约
                    updateActiveOfflineInvite(null);
                    setIsOfflineInviteMinimized(false);
                    if (remindExpandTimerRef.current) {
                        clearTimeout(remindExpandTimerRef.current);
                        remindExpandTimerRef.current = null;
                    }
                    kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                    kvRemove(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id);
                } else {
                    // 时间线因果回溯：以截断点为基准向历史追溯，由最近发生的有效关键事件决定回溯状态
                    let lastEvent: "terminated" | "meeting" | "invite_active" | "none" = "none";
                    let meetingThemeFromMsg: string | undefined;

                    for (let i = contextMessages.length - 1; i >= 0; i--) {
                        const m = contextMessages[i];
                        // 1. 若最后遇到的是终结事件（已返回线上 / 已取消 / 婉拒 / 线下封锁）：代表在那一刻赴约已彻底结束，自然毫无状态！
                        if (isOfflineInviteTerminatedMessage(m)) {
                            lastEvent = "terminated";
                            break;
                        }
                        // 2. 若最后遇到的是碰面记录：代表在那一刻双方正处于面对面碰面中！
                        if ((m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && m.content.includes("线下碰面中"))) {
                            lastEvent = "meeting";
                            meetingThemeFromMsg = m.mediaData?.offlineInvite?.theme;
                            break;
                        }
                        // 3. 若最后遇到的是赴约提议/动身/在途/到达节点：代表在那一刻处于当时的赴约进展中！
                        if (
                            m.mediaType === "offline_invite" ||
                            m.mediaType === "offline_invite_change_place" ||
                            m.mediaType === "offline_invite_early_arrive" ||
                            m.mediaType === "offline_invite_arrive_notice" ||
                            Boolean(m.mediaData?.offlineInvite) ||
                            (m.role === "system" && m.content && (
                                m.content.includes("你已同意赴约") ||
                                (m.content.includes("向你发起了") && m.content.includes("线下赴约提议")) ||
                                m.content.includes("正在动身赶往") ||
                                m.content.includes("已直接动身") ||
                                m.content.includes("正在重新赶往") ||
                                m.content.includes("赴约地点已更改为") ||
                                m.content.includes("已到达") ||
                                m.content.includes("已提前到达") ||
                                m.content.includes("就位等候")
                            ))
                        ) {
                            lastEvent = "invite_active";
                            break;
                        }
                    }

                    if (lastEvent === "terminated" || lastEvent === "none") {
                        // 那一刻已终结或尚未发起任何赴约：彻底清理，保持纯净无状态
                        kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                        kvRemove(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id);
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                    } else if (lastEvent === "meeting") {
                        // 那一刻正处于线下碰面中：恢复碰面顶栏
                        kvSet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id, "1");
                        if (meetingThemeFromMsg) {
                            kvSet(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id, meetingThemeFromMsg);
                        }
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                    } else if (lastEvent === "invite_active") {
                        // 那一刻正处于提议/在途/到达赴约中：回溯恢复当时的赴约卡片
                        kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                        kvRemove(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id);
                        const restoredInvite = restoreOfflineInviteFromMessages(contextMessages, currentInvite, targetRetryMsg);
                        if (restoredInvite) {
                            updateActiveOfflineInvite(restoredInvite);
                            setIsOfflineInviteMinimized(true);
                        } else {
                            updateActiveOfflineInvite(null);
                            setIsOfflineInviteMinimized(false);
                        }
                    }
                }
            }

            const lastContextMsg = contextMessages.length > 0 ? contextMessages[contextMessages.length - 1] : null;
            const isRetryingDeclineReply = Boolean(
                lastContextMsg &&
                (lastContextMsg.role === "system" || lastContextMsg.mediaType === "offline_invite_system_notice") &&
                lastContextMsg.content &&
                (/你婉拒了.*线下邀约提议|婉拒了.*线下赴约提议/.test(lastContextMsg.content))
            );

            let retryDeclineContext: OfflineInviteDeclineContext | undefined;
            if (isRetryingDeclineReply) {
                const retryCount = Math.max(1, parseInt(kvGet(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id) || "1", 10));
                const refInvite = activeOfflineInviteRef.current;
                retryDeclineContext = {
                    theme: refInvite?.theme || "default",
                    place: refInvite?.place || "",
                    reason: refInvite?.reason || "",
                    direction: refInvite?.direction || "he_comes",
                    declineCount: retryCount,
                };
            }

            setIsRetryingOffline(true);
            try {
                await runManagedGeneration({
                    history: contextMessages,
                    errorPrefix: "重试失败",
                    onDecline: triggerReply,
                    offlineInviteDeclined: retryDeclineContext,
                });
            } finally {
                setIsRetryingOffline(false);
            }

            // 重试生成完毕后预留 3 秒供用户阅读，随后平滑展开大卡片
            const currentRestored = activeOfflineInviteRef.current;
            const needsModalExpand = Boolean(
                currentRestored && (
                    currentRestored.status === "pending" ||
                    currentRestored.status === "arrived" ||
                    currentRestored.direction === "i_go"
                )
            );
            if (needsModalExpand && !remindExpandTimerRef.current) {
                remindExpandTimerRef.current = setTimeout(() => {
                    setIsOfflineInviteMinimized(false);
                    remindExpandTimerRef.current = null;
                }, 3000);
            }
        };

        // 重试交互分流：
        // 1. 若重试截断了最初发起邀约的根源消息（生命之根）：弹窗预警会彻底取消赴约
        if (truncatesInitialRoot) {
            setActiveMessageId(null);
            setPendingInviteDeleteConfirm({
                title: "重试此条回复？",
                message: "重试将重新生成本条回复，并删除之后的内容（包含本次线下赴约的发起消息），同时取消当前的赴约状态，是否确认重试？",
                confirmLabel: "重试",
                variant: "danger",
                onConfirm: () => void executeRetry(),
            });
            return;
        }

        // 分支 1-B：回到线上后，重试截断了线下结束记录，提示将回溯并重新恢复线下赴约状态
        const truncatesEndMeetingNotice = truncatedMessages.some(m =>
            (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
            Boolean(m.content && m.content.includes("双方已返回线上"))
        );
        if (!currentInvite && truncatesEndMeetingNotice) {
            const contextHasMeetingNotice = contextMessages.some(m =>
                (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                Boolean(m.content && m.content.includes("线下碰面中"))
            );
            setActiveMessageId(null);
            setPendingInviteDeleteConfirm({
                title: contextHasMeetingNotice ? "回溯至线下碰面？" : "回溯至线下赴约？",
                message: contextHasMeetingNotice
                    ? "重试该消息将删除后续记录（包含结束线下的标记），时间线将回溯并重新恢复面对面碰面状态。是否确认重新生成？"
                    : "重试该消息将删除后续记录（包含结束线下的标记），时间线将回溯并重新恢复当时的线下赴约状态。是否确认重新生成？",
                confirmLabel: "确认回溯",
                variant: "danger",
                onConfirm: () => void executeRetry(),
            });
            return;
        }

        // 线下封禁关键节点重试拦截
        // 分支 1：重试封禁解除消息（截断解封记录，提示时间线回退至未解封历史节点）
        const truncatesUnlockNotice = truncatedMessages.some(isOfflineUnlockNoticeMessage);
        const contextHasLockNotice = contextMessages.some(isOfflineLockNoticeMessage);
        if (session.enableOfflineLock && !session.isGroup && truncatesUnlockNotice && contextHasLockNotice) {
            setActiveMessageId(null);
            setPendingInviteDeleteConfirm({
                title: "重试封禁解除消息？",
                message: "该消息包含角色本次线下解封的关键节点，重试将回溯至未解封的历史节点，线下入口可能会重新封锁。是否确认重试？",
                confirmLabel: "重试",
                variant: "danger",
                onConfirm: () => void executeRetry(),
            });
            return;
        }

        // 分支 2：重试封禁发起消息（截断封禁源头，提示清除当前封禁并重新生成）
        const truncatesLockNotice = truncatedMessages.some(isOfflineLockNoticeMessage);
        if (session.enableOfflineLock && !session.isGroup && offlineLockData?.isLocked && truncatesLockNotice && !contextHasLockNotice) {
            setActiveMessageId(null);
            setPendingInviteDeleteConfirm({
                title: "重试封禁发起消息？",
                message: "该消息包含角色本次线下封禁发起的关键节点，重试将清除当前封禁状态，并让角色重新根据情境做出情绪反应（可能会重新触发封禁）。是否确认重试？",
                confirmLabel: "重试",
                variant: "danger",
                onConfirm: () => void executeRetry(),
            });
            return;
        }

        // 分支 3：重试心墙变动消息（处于封禁拉扯中，提示重试后续变动轮次）
        if (session.enableOfflineLock && !session.isGroup && offlineLockData?.isLocked && truncatesLockNotice && contextHasLockNotice) {
            setActiveMessageId(null);
            setPendingInviteDeleteConfirm({
                title: "重试心墙变动消息？",
                message: "重试后时间线将回溯，并让角色重新根据情境做出情绪反应（封禁状态与需敲门次数也许会发生变化）。是否确认重试？",
                confirmLabel: "重试",
                variant: "danger",
                onConfirm: () => void executeRetry(),
            });
            return;
        }

        // 2. 场景 B（时光倒流）：只有当截断的后续内容包含用户发言（role === "user"）或系统变动记录（role === "system"）时，
        // 说明用户是在跨轮次倒退历史（会抹去用户自己后续说的话或同意/改地点记录），才弹窗确认防止误删！
        // 若截断的仅仅是最新一轮 AI 连发的多个气泡（后续无用户发言），即便点击倒数第二条气泡也是纯粹的当场重抽，0 弹窗 0 阻碍！
        const hasSubsequentTurns = truncatedMessages.slice(1).some(m => m.role === "user" || m.role === "system");
        if (currentInvite && hasSubsequentTurns) {
            setActiveMessageId(null);
            setPendingInviteDeleteConfirm({
                title: "回溯并重新生成？",
                message: `重试将删除本条及之后的 ${truncatedMessages.length} 条消息，赴约状态将同步回溯至当时。是否确认重新生成？`,
                confirmLabel: "确认回溯",
                variant: "default",
                onConfirm: () => void executeRetry(),
            });
            return;
        }

        // 3. 场景 A：当场重试最新一轮回复（无后续用户发言），0 弹窗 0 阻碍无缝即点即抽！
        await executeRetry();
    };

    // 线下赴约进行时回溯重试（回溯至当时时间线并结束当前线下状态）
    const handleExecuteOfflineRetryMode = async () => {
        if (!offlineRetryConfirm) return;
        const { msgId, msgIndex, contextMessages, targetMsg, truncatesInitialRoot } = offlineRetryConfirm;
        setOfflineRetryConfirm(null);

        // Delete this message and everything after it
        deleteChatMessagesFrom(msgId);
        setMessages(prev => prev.slice(0, msgIndex));
        setActiveMessageId(null);
        cancelFollowUp(session.id);

        // 1. 彻底结束线下赴约状态
        kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
        if (remindExpandTimerRef.current) {
            clearTimeout(remindExpandTimerRef.current);
            remindExpandTimerRef.current = null;
        }

        // 2. 根据 contextMessages 智能回溯赴约状态至当时那一刻
        if (truncatesInitialRoot) {
            updateActiveOfflineInvite(null);
            setIsOfflineInviteMinimized(false);
        } else {
            const restoredInvite = restoreOfflineInviteFromMessages(contextMessages, null, targetMsg);
            if (restoredInvite) {
                updateActiveOfflineInvite(restoredInvite);
                // 重试期间保持收起状态，避免遮挡“对方正在输入中”提示
                setIsOfflineInviteMinimized(true);
            } else {
                updateActiveOfflineInvite(null);
                setIsOfflineInviteMinimized(false);
            }
        }

        // 3. 重新生成该消息（绝不携带 returnedFromOffline，杜绝触发从线下回到线上的主动报备发信）
        setIsRetryingOffline(true);
        try {
            await runManagedGeneration({
                history: contextMessages,
                errorPrefix: "重试失败",
                onDecline: triggerReply,
            });
        } finally {
            setIsRetryingOffline(false);
        }

        // 重试生成完毕后预留 3 秒供用户阅读，随后平滑展开大卡片
        const currentRestored = activeOfflineInviteRef.current;
        const needsModalExpand = Boolean(
            currentRestored && (
                currentRestored.status === "pending" ||
                currentRestored.status === "arrived" ||
                currentRestored.direction === "i_go"
            )
        );
        if (needsModalExpand && !remindExpandTimerRef.current) {
            remindExpandTimerRef.current = setTimeout(() => {
                setIsOfflineInviteMinimized(false);
                remindExpandTimerRef.current = null;
            }, 3000);
        }

        showChatToast("已回溯至当时，线下赴约状态已结束");
    };

    const handleRetractMessage = (msgId: string) => {
        const targetMsg = messages.find(m => m.id === msgId) || loadChatMessages(session.id).find(m => m.id === msgId);
        if (targetMsg && isOfflineLockNoticeMessage(targetMsg)) {
            kvRemove(OFFLINE_LOCK_PREFIX + session.id);
            setOfflineLockData(null);
            offlineLockDataRef.current = null;
        }
        retractChatMessage(msgId);
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, isRetracted: true } : m));
        setActiveMessageId(null);
    };

    const handleEditMessageStart = (msg: ChatMessage) => {
        setEditingResponseBatchId(null);
        setEditingResponseRoundId(null);
        setEditingResponseContent("");
        setEditingMessageId(msg.id);
        // 语音条的文字存在 mediaData.label 里，content 是空的
        setEditingContent(msg.mediaType === "audio" ? (msg.mediaData?.label || msg.content) : msg.content);
        setActiveMessageId(null);
    };

    const handleEditMessageSave = () => {
        if (!editingMessageId || !editingContent.trim()) {
            setEditingMessageId(null);
            setEditingContent("");
            return;
        }

        const originalMessage = messages.find(m => m.id === editingMessageId) || loadChatMessages(session.id).find(m => m.id === editingMessageId);
        const isEditingSystemInstruction = originalMessage ? isSystemInstructionMessage(originalMessage) : false;
        const placement = originalMessage?.role === "user" ? 1 : 2;
        const nextContent = isEditingSystemInstruction
            ? editingContent.trim()
            : applyEditTextRegex(editingContent.trim(), placement, false);
        if (originalMessage?.mediaType === "audio") {
            // 语音条的显示文字和 AI 上下文都读 mediaData.label，改 content 不生效；
            // synthesizedFromText 保留旧值，AI 语音会因文字不一致自动重新合成
            const nextMediaData = { ...originalMessage.mediaData, label: nextContent };
            updateMessageMediaData(editingMessageId, nextMediaData);
            setMessages(prev => prev.map(m => m.id === editingMessageId ? { ...m, mediaData: nextMediaData } : m));
        } else {
            editChatMessage(editingMessageId, nextContent);
            setMessages(prev => prev.map(m => m.id === editingMessageId ? { ...m, content: nextContent } : m));
        }
        setEditingMessageId(null);
        setEditingContent("");
        const ta = document.querySelector<HTMLTextAreaElement>(".chat-input-textarea");
        if (ta) ta.style.height = "auto";
    };

    const normalizeEditedAssistantParts = (
        parts: ReturnType<typeof parseAIResponse>["parts"],
        senderNameOverride?: string,
        options?: { omitHandledFinancialActions?: boolean },
    ) => {
        return parts.flatMap(part => {
            if (part.mediaType === "music") {
                const title = part.mediaData?.musicTitle || part.mediaData?.label || "未知歌曲";
                const artist = part.mediaData?.musicArtist ? `-${part.mediaData.musicArtist}` : "";
                return [{ content: `[音乐:${title}${artist}]` }];
            }
            if (part.mediaType === "voice_call") {
                return [{ content: "[我发起了语音通话]" }];
            }
            if (part.mediaType === "video_call") {
                return [{ content: "[我发起了视频通话]" }];
            }
            if (
                options?.omitHandledFinancialActions &&
                (
                    part.mediaType === "accept_red_packet" ||
                    part.mediaType === "decline_red_packet" ||
                    part.mediaType === "accept_transfer" ||
                    part.mediaType === "decline_transfer" ||
                    part.mediaType === "accept_payment_request" ||
                    part.mediaType === "decline_payment_request"
                )
            ) {
                return [];
            }
            if (part.mediaType === "accept_red_packet") {
                return [{ content: "[领取红包]" }];
            }
            if (part.mediaType === "decline_red_packet") {
                return [{ content: "[拒收红包]" }];
            }
            if (part.mediaType === "accept_transfer") {
                return [{ content: "[领取转账]" }];
            }
            if (part.mediaType === "decline_transfer") {
                return [{ content: "[拒收转账]" }];
            }
            if (part.mediaType === "accept_payment_request") {
                return [{ content: "[接受代付]" }];
            }
            if (part.mediaType === "decline_payment_request") {
                return [{ content: "[拒绝代付]" }];
            }
            if (part.mediaType === "poke") {
                const sender = (part.mediaData?.pokeSender === "我" ? senderNameOverride : part.mediaData?.pokeSender)
                    || senderNameOverride
                    || (character?.name || "对方");
                const target = part.mediaData?.pokeTarget || (userIdentity?.name || "你");
                return [{
                    content: `${sender} 拍了拍 ${target}`,
                    mediaType: "poke" as const,
                    mediaData: { pokeSender: sender, pokeTarget: target },
                }];
            }
            return [part];
        }).filter(part => part.mediaType || part.content.trim());
    };

    const handleEditResponseStart = (msg: ChatMessage) => {
        if (session.isGroup && msg.responseRoundId && msg.editableResponseText) {
            setEditingMessageId(null);
            setEditingContent("");
            setEditingResponseBatchId(null);
            setEditingResponseRoundId(msg.responseRoundId);
            setEditingResponseContent(msg.editableResponseText);
            setActiveMessageId(null);
            return;
        }
        if (!msg.responseBatchId || !msg.rawResponseText) {
            handleEditMessageStart(msg);
            return;
        }
        setEditingMessageId(null);
        setEditingContent("");
        setEditingResponseBatchId(msg.responseBatchId);
        setEditingResponseRoundId(null);
        setEditingResponseContent(msg.rawResponseText);
        setActiveMessageId(null);
    };

    const handleEditResponseSave = () => {
        if (!editingResponseContent.trim()) {
            setEditingResponseBatchId(null);
            setEditingResponseRoundId(null);
            setEditingResponseContent("");
            return;
        }

        const editedResponseContent = applyEditTextRegex(editingResponseContent.trim(), 2, false);

        if (session.isGroup && editingResponseRoundId) {
            const storedMessages = loadChatMessages(session.id);
            const roundMessages = storedMessages.filter(msg => msg.responseRoundId === editingResponseRoundId);
            if (roundMessages.length === 0) {
                showChatToast("没有找到这轮群聊回复");
                setEditingResponseRoundId(null);
                setEditingResponseContent("");
                return;
            }

            const firstRoundIndex = storedMessages.findIndex(msg => msg.id === roundMessages[0].id);
            const stateCutoff = storedMessages[firstRoundIndex];

            const nameToId = new Map<string, string>();
            groupCharacters.forEach((groupCharacter) => {
                nameToId.set(groupCharacter.name, groupCharacter.id);
            });
            if (!hasKnownGroupSenderPrefix(editedResponseContent)) {
                showChatToast("群聊编辑内容需要保留 [角色名]: 前缀");
                return;
            }
            const segments = parseGroupChatResponse(editedResponseContent, nameToId);
            if (segments.length === 0) {
                showChatToast("没有识别到可编辑的群聊成员前缀");
                return;
            }

            const replacementMessages: Array<{
                content: string;
                mediaType?: ChatMessage["mediaType"];
                mediaData?: ChatMessage["mediaData"];
                rawResponseText?: string;
                responseBatchId?: string;
                statusPanel?: string;
                statusRegionMode?: "custom";
                innerMonologue?: string;
                stateValues?: StateValue[];
                freshStateValues?: StateValue[];
                senderCharacterId?: string;
                senderName?: string;
            }> = [];

            const currentStateByCharacter = new Map<string, StateValue[]>();
            const getCurrentStateForCharacter = (characterId: string): StateValue[] => {
                const cached = currentStateByCharacter.get(characterId);
                if (cached) return cached;
                const latest = getLatestCharacterStateValues(characterId, stateCutoff ? { before: stateCutoff } : undefined);
                currentStateByCharacter.set(characterId, latest);
                return latest;
            };
            for (const segment of segments) {
                const responseBatchId = createResponseBatchId();
                const { parts: rawParts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(segment.responseText, getCurrentStateForCharacter(segment.characterId));
                const parts = stripInvalidStickerParts(rawParts, segment.characterId);
                const normalizedParts = normalizeEditedAssistantParts(parts, segment.characterName, {
                    omitHandledFinancialActions: true,
                });
                let attachedState = false;
                for (const part of normalizedParts) {
                    if (!part.content.trim() && !part.mediaType && (!(statusPanel || innerMonologue) || attachedState)) continue;
                    // 面板只挂到能显示它的正常气泡上（拍一拍/通话留痕是系统小字）
                    const attachHere = !attachedState && canCarryFoldedPanel(part);
                    replacementMessages.push({
                        content: part.content,
                        mediaType: part.mediaType,
                        mediaData: part.mediaData,
                        rawResponseText: segment.responseText,
                        responseBatchId,
                        statusPanel: attachHere && statusPanel ? statusPanel : undefined,
                        statusRegionMode: customStatusActive && attachHere && statusPanel ? "custom" as const : undefined,
                        innerMonologue: attachHere && innerMonologue ? innerMonologue : undefined,
                        stateValues: attachHere && stateValues.length > 0 ? stateValues : undefined,
                        freshStateValues: attachHere ? freshStateValues : undefined,
                        senderCharacterId: segment.characterId,
                        senderName: segment.characterName,
                    });
                    if (attachHere) attachedState = true;
                }
                if (!attachedState && (statusPanel || innerMonologue || stateValues.length > 0)) {
                    replacementMessages.push({
                        content: "",
                        rawResponseText: segment.responseText,
                        responseBatchId,
                        statusPanel,
                        statusRegionMode: customStatusActive && statusPanel ? "custom" as const : undefined,
                        innerMonologue,
                        stateValues: stateValues.length > 0 ? stateValues : undefined,
                        freshStateValues,
                        senderCharacterId: segment.characterId,
                        senderName: segment.characterName,
                    });
                    attachedState = true;
                }
                const toolCallContent = extractTextToolDirectiveText(segment.responseText);
                if (toolCallContent) {
                    replacementMessages.push({
                        content: toolCallContent,
                        mediaType: "tool_call",
                        responseBatchId,
                        senderCharacterId: segment.characterId,
                        senderName: segment.characterName,
                    });
                }
                if (stateValues.length > 0) {
                    currentStateByCharacter.set(segment.characterId, stateValues);
                }
            }

            if (replacementMessages.length === 0) {
                showChatToast("编辑后的群聊回复没有可显示内容");
                return;
            }

            replaceGroupResponseRound(
                session.id,
                editingResponseRoundId,
                editedResponseContent,
                replacementMessages,
            );
            syncMessagesFromStorage();
            setEditingResponseBatchId(null);
            setEditingResponseRoundId(null);
            setEditingResponseContent("");
            setActiveMessageId(null);
            return;
        }

        if (!editingResponseBatchId) {
            setEditingResponseBatchId(null);
            setEditingResponseRoundId(null);
            setEditingResponseContent("");
            return;
        }

        const storedMessages = loadChatMessages(session.id);
        const batchMessages = storedMessages.filter(msg => msg.responseBatchId === editingResponseBatchId);
        if (batchMessages.length === 0) {
            showChatToast("没有找到这次回复的原始内容");
            setEditingResponseBatchId(null);
            setEditingResponseRoundId(null);
            setEditingResponseContent("");
            return;
        }

        const firstBatchIndex = storedMessages.findIndex(msg => msg.id === batchMessages[0].id);
        const stateCutoff = storedMessages[firstBatchIndex];
        const previousState = session.isGroup
            ? getLatestStateValues(session.id)
            : getLatestCharacterStateValues(session.contactId, stateCutoff ? { before: stateCutoff } : undefined);

        const { parts: rawParts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(editedResponseContent, previousState);
        const parts = stripInvalidStickerParts(rawParts);
        const normalizedParts = normalizeEditedAssistantParts(parts);
        if (normalizedParts.length === 0 && (statusPanel || innerMonologue)) {
            normalizedParts.push({ content: "" });
        }
        if (normalizedParts.length === 0) {
            showChatToast("编辑后的回复没有可显示内容");
            return;
        }
        // 面板挂到第一条能显示它的消息上（编辑后第一条可能是拍一拍或通话留痕，
        // 那类系统小字不显示面板）；全是系统样式时补空消息驮面板
        let metaPartIndex = normalizedParts.findIndex(canCarryFoldedPanel);
        if (metaPartIndex === -1) {
            if (statusPanel || innerMonologue || stateValues.length > 0) {
                normalizedParts.push({ content: "" });
                metaPartIndex = normalizedParts.length - 1;
            } else {
                metaPartIndex = 0;
            }
        }

        // 编辑只改文字，不改这批消息生成时所处的状态栏模式——沿用原戳，
        // 否则编辑一次就退回原生渲染，而且切回原生后再编辑又会反向串档。
        const originalStatusRegionMode = batchMessages.find(m => m.statusRegionMode === "custom")?.statusRegionMode;

        replaceResponseBatchWithParts(
            session.id,
            editingResponseBatchId,
            editedResponseContent,
            normalizedParts,
            {
                statusPanel,
                statusRegionMode: originalStatusRegionMode,
                innerMonologue,
                stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
                metaPartIndex,
                toolCallContent: extractTextToolDirectiveText(editedResponseContent),
            },
        );
        syncMessagesFromStorage();
        setEditingResponseBatchId(null);
        setEditingResponseRoundId(null);
        setEditingResponseContent("");
        setActiveMessageId(null);
    };

    const handleMessagePointerDown = (e: React.PointerEvent, msgId: string) => {
        if (isMultiSelectMode) return;
        // Prevent right click from triggering the timer, as it has its own context menu handler
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        // Prevent text selection on long press
        e.preventDefault();

        const anchor = { x: e.clientX, y: e.clientY };
        startPosRef.current = anchor;
        longPressTriggeredRef.current = false;

        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            openMessageContextMenu(msgId, anchor);
            longPressTimerRef.current = null;
        }, 500); // 500ms long press
    };

    const handleMessagePointerUp = (e: React.PointerEvent) => {
        startPosRef.current = null;
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        // If a long press just triggered, stop the event from becoming a click
        if (longPressTriggeredRef.current) {
            e.stopPropagation();
            e.preventDefault();
            longPressTriggeredRef.current = false;
        }
    };

    const handleMessagePointerCancel = () => {
        startPosRef.current = null;
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    const deleteWeixinCloudBeforeLocal = async (
        targetMessages: ChatMessage[],
        applyLocalDelete: () => void,
        successText?: string,
    ) => {
        if (cloudDeletePending) {
            showChatToast("正在删除云端记录，请稍候");
            return;
        }
        const cloudTargetCount = getWeixinCloudDeleteTargetCount(targetMessages);
        if (cloudTargetCount <= 0) {
            applyLocalDelete();
            if (successText) showChatToast(successText);
            return;
        }

        setCloudDeletePending({ count: cloudTargetCount });
        try {
            const deletedCount = await withTimeout(
                deleteWeixinCloudMessagesFromCloud(targetMessages),
                WEIXIN_CLOUD_DELETE_TIMEOUT_MS,
                "云端删除超时，请检查网络后重试。",
            );
            if (deletedCount < cloudTargetCount) {
                throw new Error("云端记录没有完全删除，请检查同步设置后重试。");
            }
            applyLocalDelete();
            if (successText) showChatToast(successText);
            // 删消息对象只解决"消息目录"这一半：删掉的历史早就烘焙进云端运行包的
            // bakedHistory 里，不重烘焙的话云端助手（微信）照样记得刚删的内容。
            // 事件监听那条重同步是 3 秒防抖，这里显式先跑；成功无感，失败必须报。
            void syncAllWeixinBotRuntimesToCloud()
                .catch(() => {
                    emitWeixinSyncToast("微信运行包同步失败：角色可能还记得刚删的内容，请到「设置 → 微信」手动同步运行包。", { id: "weixin-runtime", duration: 4500 });
                });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showChatToast(`云端删除失败：${message}`, 3500);
        } finally {
            setCloudDeletePending(null);
        }
    };

    // 赴约状态倒退判定函数（供单删与删除以下预处理鱼竿共享）
    const isInviteStateRegressed = (cur: OfflineInviteData | null, next: OfflineInviteData | null): boolean => {
        if (!cur || !next) return false;
        const rank = (status?: string) => {
            if (status === "arrived") return 2;
            if (status === "on_the_way") return 1;
            return 0; // pending or other
        };
        const curRank = rank(cur.status);
        const nextRank = rank(next.status);
        if (nextRank < curRank) return true;
        if (cur.isEarlyArrived && !next.isEarlyArrived) return true;
        if (cur.place && next.place && cur.place !== next.place) return true;
        if (cur.direction && next.direction && cur.direction !== next.direction) return true;
        if (cur.theme && next.theme && cur.theme !== next.theme) return true;
        return false;
    };

    const handleDeleteMessage = (msgId: string) => {
        if (isTransientMessage(msgId)) {
            removeTransientMessage(msgId);
            setActiveMessageId(null);
            return;
        }
        setActiveMessageId(null);
        const targetMsg = loadChatMessages(session.id).find(m => m.id === msgId);
        if (!targetMsg) return;

        const executeDelete = () => {
            void deleteWeixinCloudBeforeLocal([targetMsg], () => {
                deleteChatMessage(msgId);
                const isDeclineNotice = (targetMsg.role === "system" || targetMsg.mediaType === "offline_invite_system_notice") &&
                    Boolean(targetMsg.content && (/你婉拒了.*线下邀约提议|婉拒了.*线下赴约提议/.test(targetMsg.content)));
                if (isDeclineNotice) {
                    kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                }
                syncMessagesFromStorage();
            });
        };

        // =========================================================================
        // 【致未来阅读代码的你】：
        // 此处“钓鱼佬、预处理鱼竿与代码鱼”是弹窗集中解耦的核心架构设计：
        // 为避免几十个拦截弹窗零散分布在业务流各处难以维护，我们将其统一收拢至岸边，
        // 岸上的【钓鱼佬】是交互弹窗，深海里的【代码鱼】是真正执行功能与状态转移的底层代码；
        // 而连接两者的【预处理鱼竿】，则在物理执行前提前探出状态走向，实现集中调度与精准拦截。
        // =========================================================================
        // 【钓鱼佬一号聚集地】线下封禁系统·删除拦截
        // =========================================================================

        // 1. 封禁源头系统记录（生命之根·连根拔起法则）
        if (isOfflineLockRootNoticeMessage(targetMsg)) {
            const allStored = loadChatMessages(session.id);
            const rootIdx = allStored.findIndex(m => m.id === targetMsg.id);
            const noticesToDelete: ChatMessage[] = [targetMsg];
            if (rootIdx >= 0) {
                for (let i = rootIdx + 1; i < allStored.length; i++) {
                    const m = allStored[i];
                    // 遇到下一轮完全独立的封禁根节点，说明属于后续新事件，停止向后收集
                    if (isOfflineLockRootNoticeMessage(m)) {
                        break;
                    }
                    if (isOfflineLockMindWallNoticeMessage(m) || isOfflineUnlockNoticeMessage(m)) {
                        noticesToDelete.push(m);
                    }
                }
            }

            const isCurrentlyLocked = Boolean(offlineLockDataRef.current?.isLocked);
            const laterMsgs = rootIdx >= 0 ? allStored.slice(rootIdx + 1) : [];
            const hasLaterUnlock = laterMsgs.some(isOfflineUnlockNoticeMessage);
            const hasLaterLockRoot = laterMsgs.some(isOfflineLockRootNoticeMessage);
            const isHistoricalRoot = !isCurrentlyLocked || hasLaterUnlock || hasLaterLockRoot;

            if (isHistoricalRoot) {
                // 【删除后不变例外】：当前角色早已和好解封，或该条仅为早前已落幕历史风波的源头记录
                setPendingInviteDeleteConfirm({
                    title: "删除历史封禁记录？",
                    message: "该记录为早前的线下封禁发起提示，删除后将从聊天记录中移除本次风波的关联记录，当前状态保持不变。是否确认删除？",
                    confirmLabel: "确认删除",
                    variant: "default",
                    onConfirm: () => {
                        if (noticesToDelete.length > 1) {
                            void deleteWeixinCloudBeforeLocal(noticesToDelete, () => {
                                deleteChatMessagesByIds(session.id, noticesToDelete.map(m => m.id));
                                syncMessagesFromStorage();
                            });
                        } else {
                            executeDelete();
                        }
                    },
                });
                return;
            }

            setPendingInviteDeleteConfirm({
                title: "删除封禁记录？",
                message: "删除该记录将解除角色本次线下封禁（恢复线下入口畅通），并同步清除本次封禁产生的所有心墙变动与解封提示。是否确认删除？",
                confirmLabel: "确认删除",
                variant: "danger",
                onConfirm: () => {
                    kvRemove(OFFLINE_LOCK_PREFIX + session.id);
                    kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);
                    setOfflineLockData(null);
                    offlineLockDataRef.current = null;
                    if (noticesToDelete.length > 1) {
                        void deleteWeixinCloudBeforeLocal(noticesToDelete, () => {
                            deleteChatMessagesByIds(session.id, noticesToDelete.map(m => m.id));
                            syncMessagesFromStorage();
                        });
                    } else {
                        executeDelete();
                    }
                },
            });
            return;
        }

        // 2. 心墙变动记录（心墙变化提示，智能区分历史与当前锁定）
        if (isOfflineLockMindWallNoticeMessage(targetMsg)) {
            const allStored = loadChatMessages(session.id);
            const targetIdx = allStored.findIndex(m => m.id === targetMsg.id);
            const isCurrentlyLocked = Boolean(offlineLockDataRef.current?.isLocked);
            const laterMsgs = targetIdx >= 0 ? allStored.slice(targetIdx + 1) : [];
            const hasLaterUnlock = laterMsgs.some(isOfflineUnlockNoticeMessage);
            const hasLaterLockRoot = laterMsgs.some(isOfflineLockRootNoticeMessage);
            const isHistoricalMindWall = !isCurrentlyLocked || hasLaterUnlock || hasLaterLockRoot;

            if (isHistoricalMindWall) {
                // 【删除后不变例外】：角色当前已解封和好，或该条为此前已落幕历史风波中的心墙记录，删除不影响当前状态
                setPendingInviteDeleteConfirm({
                    title: "删除历史心墙记录？",
                    message: "该记录为角色早前的心墙变化提示，删除后将从聊天记录中移除，当前状态保持不变。是否确认删除？",
                    confirmLabel: "确认删除",
                    variant: "default",
                    onConfirm: () => {
                        executeDelete();
                    },
                });
                return;
            }

            setPendingInviteDeleteConfirm({
                title: "删除变动记录？",
                message: "该记录为角色心墙状态的变化提示，删除后将移除该提示并恢复此前的心墙状态，角色仍处于线下封禁中。是否确认删除？",
                confirmLabel: "确认删除",
                variant: "danger",
                onConfirm: () => {
                    executeDelete();
                },
            });
            return;
        }

        // 3. 解封系统记录（撤销解封或历史解封保持不变）
        if (isOfflineUnlockNoticeMessage(targetMsg)) {
            const allStored = loadChatMessages(session.id);
            const targetIdx = allStored.findIndex(m => m.id === targetMsg.id);
            const laterMessages = targetIdx >= 0 ? allStored.slice(targetIdx + 1) : [];
            const hasLaterUnlock = laterMessages.some(isOfflineUnlockNoticeMessage);
            const hasLaterLock = laterMessages.some(isOfflineLockRootNoticeMessage);
            const isCurrentlyLocked = Boolean(offlineLockDataRef.current?.isLocked);
            const isMeetingActive = !session.isGroup && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1";
            const hasActiveInvite = Boolean(activeOfflineInviteRef.current || isMeetingActive);

            // 若后续有更新的解封、或后续又被重新封禁了（当前处于新的封禁中）、或当前处于活跃线下赴约中：
            // 删除早前的解封记录不会对当前线下状态造成任何改变
            if (hasLaterUnlock || hasLaterLock || isCurrentlyLocked || hasActiveInvite) {
                // 【删除后不变例外】：后续仍有更新的解封记录或当前已翻篇，删除早前解封记录当前状态保持不变
                setPendingInviteDeleteConfirm({
                    title: "删除历史解封记录？",
                    message: "该记录为早前的解封提示，删除后将从聊天记录中移除，当前线下状态保持不变。是否确认删除？",
                    confirmLabel: "确认删除",
                    variant: "default",
                    onConfirm: () => {
                        executeDelete();
                    },
                });
                return;
            }

            setPendingInviteDeleteConfirm({
                title: "删除解封记录？",
                message: "删除该记录将取消角色本次对你的线下解封，恢复线下入口封闭。是否确认删除？",
                confirmLabel: "确认删除",
                variant: "danger",
                onConfirm: () => {
                    executeDelete();
                },
            });
            return;
        }

        // =========================================================================
        // 【钓鱼佬二号聚集地】角色主动发起线下赴约系统·删除拦截
        // 统一基于内存物理预演的“三大类结果法则”：
        // 1. 大类 A【状态不变 · 纯删记录】：删除历史记录？ / 确认删除（温和灰框）
        // 2. 大类 B【状态倒带 · 撤销回溯】：删除变动记录？ / 确认删除（危险红框）
        // 3. 大类 C【连根拔起 · 唯一支柱被拔】：删除邀约记录？ / 确认删除（危险红框）
        // =========================================================================

        const isInviteTarget =
            isOfflineInviteSystemMessage(targetMsg) ||
            isOfflineInviteRootMessage(targetMsg) ||
            targetMsg.mediaType === "offline_invite" ||
            targetMsg.mediaType === "offline_invite_change_place" ||
            targetMsg.mediaType === "offline_invite_early_arrive" ||
            targetMsg.mediaType === "offline_invite_arrive_notice" ||
            Boolean(targetMsg.mediaData?.offlineInvite) ||
            (targetMsg.role === "system" && Boolean(targetMsg.content && (
                targetMsg.content.includes("线下赴约提议") ||
                targetMsg.content.includes("找你碰面") ||
                targetMsg.content.includes("与Ta见面") ||
                targetMsg.content.includes("双方已返回线上")
            )));

        if (isInviteTarget) {
            // 保护机制：若当前处于活跃的线下碰面进行中，不可单删内部系统消息或邀约节点
            const isMeetingActive = !session.isGroup && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1";
            if (isMeetingActive && (isOfflineInviteSystemMessage(targetMsg) || isOfflineInviteRootMessage(targetMsg))) {
                setPendingInviteDeleteConfirm({
                    title: "线下赴约进行中",
                    message: `当前正与${character?.name || "对方"}线下碰面中，若想回溯至线上状态，请重试对应消息。`,
                    confirmLabel: "我知道了",
                    hideCancel: true,
                    variant: "default",
                    onConfirm: () => {},
                });
                return;
            }

            const storedMsgs = loadChatMessages(session.id);
            const targetIdxInStore = storedMsgs.findIndex(m => m.id === targetMsg.id);

            // 1. 定位最后一次碰面结束系统提示（双方已返回线上）
            let lastEndNoticeIdx = -1;
            for (let i = storedMsgs.length - 1; i >= 0; i--) {
                const m = storedMsgs[i];
                if ((m.role === "system" || m.mediaType === "offline_invite_system_notice") && Boolean(m.content && m.content.includes("双方已返回线上"))) {
                    lastEndNoticeIdx = i;
                    break;
                }
            }
            const hasEndNoticeInStore = lastEndNoticeIdx !== -1;
            const isTargetBeforeEndNotice = hasEndNoticeInStore && targetIdxInStore !== -1 && targetIdxInStore < lastEndNoticeIdx;
            const isEndNoticeSelf = (targetMsg.role === "system" || targetMsg.mediaType === "offline_invite_system_notice") &&
                Boolean(targetMsg.content && targetMsg.content.includes("双方已返回线上"));

            // 场景 0-B：若当前并无活跃赴约，且目标记录处于早前已结束的历史碰面轮次中（非结束提示本身）
            const hasActiveInvite = Boolean(activeOfflineInviteRef.current || isMeetingActive);
            if (!hasActiveInvite && isTargetBeforeEndNotice && !isEndNoticeSelf) {
                // 大类 A：历史记录清理，状态保持不变
                setPendingInviteDeleteConfirm({
                    title: "删除历史记录？",
                    message: "该记录为早前的提示，删除后将从聊天记录中移除，当前赴约进度保持不变。是否确认删除？",
                    confirmLabel: "确认删除",
                    variant: "default",
                    onConfirm: () => {
                        executeDelete();
                    },
                });
                return;
            }

            // 场景 8：删除“结束线下系统记录”（双方已返回线上）
            if (isEndNoticeSelf) {
                const hasLaterEndNotice = targetIdxInStore >= 0 && storedMsgs.slice(targetIdxInStore + 1).some(m =>
                    (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                    Boolean(m.content && m.content.includes("双方已返回线上"))
                );
                if (hasActiveInvite || hasLaterEndNotice) {
                    // 大类 A：后续已有新赴约或更晚结束记录，删除早前记录当前赴约保持不变
                    setPendingInviteDeleteConfirm({
                        title: "删除历史记录？",
                        message: "该记录为早前的提示，删除后将从聊天记录中移除，当前赴约进度保持不变。是否确认删除？",
                        confirmLabel: "确认删除",
                        variant: "default",
                        onConfirm: () => {
                            executeDelete();
                        },
                    });
                    return;
                }
                // 大类 B：撤销结束决定，恢复碰面状态
                setPendingInviteDeleteConfirm({
                    title: "删除变动记录？",
                    message: "删除该记录将撤销对应进展，赴约状态将同步回溯。是否确认删除？",
                    confirmLabel: "确认删除",
                    variant: "danger",
                    onConfirm: () => {
                        executeDelete();
                    },
                });
                return;
            }

            // 划分当前有效轮次消息
            const currentRoundStartIndex = hasEndNoticeInStore ? lastEndNoticeIdx + 1 : 0;
            const currentRoundMsgs = storedMsgs.slice(currentRoundStartIndex);

            // 判定是否为婉拒或取消系统记录自身
            const isDeclineOrCancelNoticeSelf = (targetMsg.role === "system" || targetMsg.mediaType === "offline_invite_system_notice") &&
                Boolean(targetMsg.content && (/(?:你婉拒了[\s\S]*线下(?:邀约|赴约)提议|已取消线下邀约提议|已取消本次线下赴约)/.test(targetMsg.content)));

            const simulatedRemaining = storedMsgs.filter(m => m.id !== targetMsg.id);
            const currentInvite = activeOfflineInviteRef.current;
            // 【状态栏预处理钓鱼竿】：以删除后的剩余消息模拟计算下一个状态栏（传入 null 客观物理推导，绝不携带旧状态残留）
            const simulatedNextInvite = restoreOfflineInviteFromMessages(simulatedRemaining, null);

            // ---------------------------------------------------------------------
            // 分流判断：根据记录所处生命周期阶段判定操作后果（大类 A/B/C）
            // ---------------------------------------------------------------------

            // 分流 1：连根拔起（无任何支撑节点，彻底清除本次线下赴约状态）
            // 触发条件：当前处于活跃邀约中，但删除该节点后，再无任何提议、动身或到达支撑节点（唯一支撑节点被拔除）
            const isTornDownToNull = Boolean(currentInvite) && !simulatedNextInvite;

            if (isTornDownToNull) {
                // 大类 C：连根拔起 · 清除本次线下赴约状态
                setPendingInviteDeleteConfirm({
                    title: "删除邀约记录？",
                    message: "删除该记录将清除本次线下赴约状态。是否确认删除？",
                    confirmLabel: "确认删除",
                    variant: "danger",
                    onConfirm: () => {
                        // 1. 清理全部线下赴约存储标记
                        kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                        kvRemove(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id);
                        kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                        kvRemove(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id);
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                        if (remindExpandTimerRef.current) {
                            clearTimeout(remindExpandTimerRef.current);
                            remindExpandTimerRef.current = null;
                        }

                        // 2. 单删铁律：严格只删除目标消息本身，绝不连坐删除其他历史记录！
                        executeDelete();
                    },
                });
                return;
            }

            // 分流 2：状态倒带（撤销对应进展，赴约状态同步回溯）
            // 触发条件：
            // A. 当前处于活跃邀约中，删除后状态降级（已到达 -> 在途，在途 -> 待答应，新地点 -> 旧地点等）；
            // B. 当前处于被婉拒/取消状态，删除了婉拒/取消提示本身，且成功复活提议
            const isRegressedActive = Boolean(currentInvite) && isInviteStateRegressed(currentInvite, simulatedNextInvite);
            const isDeclineRevival = isDeclineOrCancelNoticeSelf && !currentInvite && Boolean(simulatedNextInvite);

            if (isRegressedActive || isDeclineRevival) {
                // 大类 B：状态倒带 · 撤销回溯
                setPendingInviteDeleteConfirm({
                    title: "删除变动记录？",
                    message: "删除该记录将撤销对应进展，赴约状态将同步回溯。是否确认删除？",
                    confirmLabel: "确认删除",
                    variant: "danger",
                    onConfirm: () => {
                        if (simulatedNextInvite) {
                            updateActiveOfflineInvite(simulatedNextInvite);
                        }
                        executeDelete();
                    },
                });
                return;
            }

            // 分流 3：状态不变（该记录为早前提示，删除后当前赴约进度保持不变）
            // 触发条件：
            // A. 赴约早已被终结，删除早前历史变动、旧提议或孤儿婉拒记录；
            // B. 当前活跃进行中，删除了已被后续节点覆盖的早期提示（例如到达后删动身、更新地点后删旧地点）；
            // C. 当前轮次生命周期中其他不影响进度的普通系统小灰字
            // 大类 A：状态不变 · 纯删记录
            setPendingInviteDeleteConfirm({
                title: "删除历史记录？",
                message: "该记录为早前的提示，删除后将从聊天记录中移除，当前赴约进度保持不变。是否确认删除？",
                confirmLabel: "确认删除",
                variant: "default",
                onConfirm: () => {
                    if (simulatedNextInvite) {
                        updateActiveOfflineInvite(simulatedNextInvite);
                    }
                    executeDelete();
                },
            });
            return;
        }


        executeDelete();
    };

    const handleDeleteMessagesFrom = (msgId: string) => {
        if (isTransientMessage(msgId)) {
            setTransientMessages(prev => {
                const idx = prev.findIndex(m => m.id === msgId);
                return idx >= 0 ? prev.slice(0, idx) : prev;
            });
            setActiveMessageId(null);
            return;
        }
        setActiveMessageId(null);
        const storedMessages = loadChatMessages(session.id);
        const targetMsg = storedMessages.find(m => m.id === msgId);
        if (!targetMsg) return;
        const targetMessages = storedMessages.filter(m => (
            m.sessionId === session.id && compareChatMessages(m, targetMsg) >= 0
        ));

        const executeDeleteFrom = () => {
            void deleteWeixinCloudBeforeLocal(targetMessages, () => {
                deleteChatMessagesFrom(msgId);
                const hasDecline = targetMessages.some(m =>
                    (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                    Boolean(m.content && (/你婉拒了.*线下邀约提议|婉拒了.*线下赴约提议/.test(m.content)))
                );
                if (hasDecline) {
                    kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                }
                syncMessagesFromStorage();
            });
        };

        const isMeetingActive = !session.isGroup && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1";
        // 保护机制：若当前处于活跃的线下碰面进行中，不可批量删除线下碰面记录与邀约节点
        if (isMeetingActive && targetMessages.some(m => isOfflineInviteSystemMessage(m) || isOfflineInviteRootMessage(m))) {
            setPendingInviteDeleteConfirm({
                title: "线下赴约进行中",
                message: `当前正与${character?.name || "对方"}线下碰面中，若想回溯至线上状态，请重试对应消息。`,
                confirmLabel: "我知道了",
                hideCancel: true,
                variant: "default",
                onConfirm: () => {},
            });
            return;
        }

        // 场景 C：已返回线上后，删除以下截断了“双方已返回线上”结束记录
        const truncatesEndMeetingNotice = targetMessages.some(m =>
            (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
            Boolean(m.content && m.content.includes("双方已返回线上"))
        );
        if (!activeOfflineInviteRef.current && !isMeetingActive && truncatesEndMeetingNotice) {
            const targetIds = new Set(targetMessages.map(m => m.id));
            const remainingStored = storedMessages.filter(m => !targetIds.has(m.id));
            const remainingHasMeetingNotice = remainingStored.some(m =>
                (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                Boolean(m.content && m.content.includes("线下碰面中"))
            );
            const remainingHasRoot = remainingStored.some(m =>
                m.mediaType === "offline_invite" ||
                Boolean(m.mediaData?.offlineInvite) ||
                (m.role === "system" && m.content && (
                    m.content.includes("你已同意赴约") ||
                    m.content.includes("线下赴约提议") ||
                    m.content.includes("正在动身赶往") ||
                    m.content.includes("已直接动身") ||
                    m.content.includes("赴约地点已更改为") ||
                    m.content.includes("已到达") ||
                    m.content.includes("已提前到达") ||
                    m.content.includes("就位等候") ||
                    m.content.includes("线下碰面中")
                ))
            );

            if (remainingHasMeetingNotice) {
                setPendingInviteDeleteConfirm({
                    title: "回溯至线下碰面？",
                    message: "删除的内容中包含本次线下赴约的结束记录，删除后时间线将回溯并重新恢复面对面碰面状态。是否确认删除？",
                    confirmLabel: "确认回溯",
                    variant: "danger",
                    onConfirm: () => {
                        kvSet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id, "1");
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                        executeDeleteFrom();
                    },
                });
                return;
            } else if (remainingHasRoot) {
                setPendingInviteDeleteConfirm({
                    title: "回溯至线下赴约？",
                    message: "删除的内容中包含本次线下赴约的结束记录，删除后时间线将回溯并重新恢复当时的线下赴约状态。是否确认删除？",
                    confirmLabel: "确认回溯",
                    variant: "danger",
                    onConfirm: () => {
                        const nextInvite = restoreOfflineInviteFromMessages(remainingStored, null);
                        if (nextInvite) {
                            updateActiveOfflineInvite(nextInvite);
                            setIsOfflineInviteMinimized(nextInvite.status === "on_the_way");
                        }
                        executeDeleteFrom();
                    },
                });
                return;
            } else {
                setPendingInviteDeleteConfirm({
                    title: "删除以下消息？",
                    message: "删除的内容中包含本次线下赴约的发起消息与结束记录，删除后将彻底清除该线下赴约记录。是否确认删除？",
                    confirmLabel: "删除",
                    variant: "danger",
                    onConfirm: () => {
                        executeDeleteFrom();
                    },
                });
                return;
            }
        }

        const currentInvite = activeOfflineInviteRef.current;
        const targetIds = new Set(targetMessages.map(m => m.id));
        const simulatedRemaining = storedMessages.filter(m => !targetIds.has(m.id));

        const isInviteRelated = targetMessages.some(m =>
            isOfflineInviteRootMessage(m) ||
            isOfflineInviteSystemMessage(m) ||
            m.mediaType === "offline_invite" ||
            m.mediaType === "offline_invite_change_place" ||
            m.mediaType === "offline_invite_early_arrive" ||
            m.mediaType === "offline_invite_arrive_notice" ||
            Boolean(m.mediaData?.offlineInvite)
        );

        if (currentInvite && isInviteRelated) {
            // 【状态栏预处理钓鱼竿】：以删除后的剩余消息模拟计算下一个状态栏（传入 null 客观物理推导，绝不携带旧状态残留）
            const simulatedNextInvite = restoreOfflineInviteFromMessages(simulatedRemaining, null);

            // 分流 1：连根拔起（删除后状态栏没了，彻底清除本次线下赴约状态，对应 test-offline-modals.html 第 16 项）
            if (!simulatedNextInvite) {
                setPendingInviteDeleteConfirm({
                    title: "删除以下消息？",
                    message: "删除的内容中包含本次线下赴约的发起消息，删除后将直接清除当前的赴约状态。若只想回退赴约状态，请取消并尝试删除其他。",
                    confirmLabel: "删除",
                    variant: "danger",
                    onConfirm: () => {
                        // 确认批量删除包含邀约根节点的内容：清空赴约状态与活跃标记，结束线下赴约
                        kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                        kvRemove(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id);
                        kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                        kvRemove(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id);
                        updateActiveOfflineInvite(null);
                        setIsOfflineInviteMinimized(false);
                        if (remindExpandTimerRef.current) {
                            clearTimeout(remindExpandTimerRef.current);
                            remindExpandTimerRef.current = null;
                        }
                        executeDeleteFrom();
                    },
                });
                return;
            }

            // 分流 2：状态倒带 / 撤销回溯（状态确实发生倒退回溯，对应 test-offline-modals.html 第 15 项）
            const isRegressed = isInviteStateRegressed(currentInvite, simulatedNextInvite);
            if (isRegressed) {
                setPendingInviteDeleteConfirm({
                    title: "删除以下消息？",
                    message: "删除的内容中包含本次线下赴约的后续变动记录，删除后赴约将回溯至当时的状态。是否确认删除？",
                    confirmLabel: "确认删除",
                    variant: "danger",
                    onConfirm: () => {
                        updateActiveOfflineInvite(simulatedNextInvite);
                        executeDeleteFrom();
                    },
                });
                return;
            }

            // 分流 3：状态不变（虽包含小灰字但状态栏纹丝不动，或纯聊天记录），静默直接删除，绝不误弹变动
            executeDeleteFrom();
            return;
        }

        // 线下封禁或解封记录批量删除拦截
        const targetHasLockOrUnlock = targetMessages.some(m => isOfflineLockNoticeMessage(m) || isOfflineUnlockNoticeMessage(m));
        if (targetHasLockOrUnlock) {
            setPendingInviteDeleteConfirm({
                title: "删除以下消息？",
                message: "删除的内容中包含角色的线下封禁记录/心墙变更记录/解封记录，删除将可能导致线下入口状态变更。若只想回退状态，可取消并重试消息。是否确认删除？",
                confirmLabel: "删除",
                variant: "danger",
                onConfirm: () => {
                    executeDeleteFrom();
                },
            });
            return;
        }

        executeDeleteFrom();
    };

    const renderOfflineContextMenu = (turn: ChatOfflineTurn, role: OfflineActionTarget["role"]) => {
        const menu = (
            <div
                onPointerDown={e => e.stopPropagation()}
                ref={positionFloatingContextMenu}
                style={getContextMenuInitialStyle()}
                className="ctx-menu chat-floating-ctx-menu flex flex-col items-center gap-[6px] py-[4px] px-0"
                data-role={role}
            >
                <div className="flex">
                    <button onClick={() => { copyTextToClipboard(getOfflineCopyText(turn, role)); setActiveOfflineTarget(null); }} className="ctx-menu-btn">复制</button>
                    <button onClick={() => handleOfflineEditStart(turn, role)} className="ctx-menu-btn">编辑</button>
                    <button onClick={() => void handleOfflineRetryFrom(turn.id)} className="ctx-menu-btn ctx-menu-btn-danger">重试以下</button>
                </div>
                <div className="flex">
                    <button onClick={() => handleOfflineDeleteTurn(turn.id)} className="ctx-menu-btn ctx-menu-btn-danger">删除</button>
                    <button onClick={() => handleOfflineDeleteTurnsFrom(turn.id)} className="ctx-menu-btn ctx-menu-btn-danger">删除以下</button>
                </div>
                <div data-menu-triangle className="ctx-menu-triangle absolute -top-[6px] w-0 h-0" />
            </div>
        );
        return wrapperRef.current ? createPortal(menu, wrapperRef.current) : menu;
    };

    const getStoredActionMessageId = (msg: ChatMessage | RenderChatMessage): string => {
        return "displaySourceId" in msg && msg.displaySourceId ? msg.displaySourceId : msg.id;
    };

    /** Reusable context menu for user/assistant bubbles */
    const renderBubbleContextMenu = (m: ChatMessage, options?: { allowMultiSelect?: boolean }) => {
        const storedMessageId = getStoredActionMessageId(m);
        const menu = (
            <div
                onPointerDown={e => e.stopPropagation()}
                ref={positionFloatingContextMenu}
                style={getContextMenuInitialStyle()}
                className="ctx-menu chat-floating-ctx-menu flex flex-col items-center gap-[6px] py-[4px] px-0"
                data-role={m.role}>
                <div className="flex">
                    <button onClick={() => {
                        const text = m.content;
                        const fallbackCopy = () => {
                            const ta = document.createElement("textarea");
                            ta.value = text;
                            ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
                            document.body.appendChild(ta);
                            ta.focus();
                            ta.select();
                            try { document.execCommand("copy"); } catch {}
                            document.body.removeChild(ta);
                        };
                        if (navigator.clipboard?.writeText) {
                            navigator.clipboard.writeText(text).catch(fallbackCopy);
                        } else {
                            fallbackCopy();
                        }
                        setActiveMessageId(null);
                    }} className="ctx-menu-btn">复制</button>
                    <button onClick={() => (m.role === "assistant" ? handleEditResponseStart(m) : handleEditMessageStart(m))} className="ctx-menu-btn">
                        {m.role === "assistant" && (m.rawResponseText || m.editableResponseText) ? "编辑回复" : "编辑"}
                    </button>
                    {m.mediaType === "audio" && m.mediaData?.label && (
                        <button onClick={() => { setVoiceTextIds(prev => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next; }); setActiveMessageId(null); }} className="ctx-menu-btn">转文字</button>
                    )}
                    {m.role === "user" && (
                        <button onClick={() => handleRetractMessage(storedMessageId)} className="ctx-menu-btn">撤回消息</button>
                    )}
                    {m.role === "assistant" && (
                        <button onClick={() => handleRetry(storedMessageId)} className="ctx-menu-btn ctx-menu-btn-danger">重试以下</button>
                    )}
                </div>
                <div className="flex">
                    <button onClick={() => { setQuotingMessage(m); setActiveMessageId(null); }} className="ctx-menu-btn">引用</button>
                    {options?.allowMultiSelect !== false && (
                        <button onClick={() => startMultiSelectFromMessage(m)} className="ctx-menu-btn">多选</button>
                    )}
                    <button onClick={() => handleDeleteMessage(storedMessageId)} className="ctx-menu-btn ctx-menu-btn-danger">删除</button>
                    <button onClick={() => handleDeleteMessagesFrom(storedMessageId)} className="ctx-menu-btn ctx-menu-btn-danger">删除以下</button>
                </div>
                {(() => {
                    // 聊天插件注册的消息操作菜单项
                    const pluginActions = getChatPluginRuntime().getMessageActions(m);
                    if (pluginActions.length === 0) return null;
                    return (
                        <div className="flex">
                            {pluginActions.map(action => (
                                <button
                                    key={`${action.pluginId}:${action.id}`}
                                    className="ctx-menu-btn"
                                    onClick={() => {
                                        getChatPluginRuntime().runMessageAction(action, m);
                                        setActiveMessageId(null);
                                    }}
                                >{action.label}</button>
                            ))}
                        </div>
                    );
                })()}
                <div data-menu-triangle className="ctx-menu-triangle absolute -top-[6px] w-0 h-0" />
            </div>
        );
        return wrapperRef.current ? createPortal(menu, wrapperRef.current) : menu;
    };

    const renderDeleteOnlyContextMenu = (onDelete: () => void, onMultiSelect?: () => void) => {
        const menu = (
            <div
                onPointerDown={e => e.stopPropagation()}
                ref={positionFloatingContextMenu}
                style={getContextMenuInitialStyle()}
                className="ctx-menu chat-floating-ctx-menu flex py-[6px] px-0"
            >
                {onMultiSelect && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onMultiSelect();
                        }}
                        className="ctx-menu-btn"
                    >多选</button>
                )}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                        closeContextMenu();
                    }}
                    className="ctx-menu-btn ctx-menu-btn-danger"
                >删除</button>
                <div data-menu-triangle className="ctx-menu-triangle absolute -top-[6px] w-0 h-0" />
            </div>
        );
        return wrapperRef.current ? createPortal(menu, wrapperRef.current) : menu;
    };

    const renderSystemContextMenu = (msg: ChatMessage) => {
        const storedMessageId = getStoredActionMessageId(msg);
        if (isSystemInstructionMessage(msg)) {
            const instructionMenu = (
                <div
                    onPointerDown={e => e.stopPropagation()}
                    ref={positionFloatingContextMenu}
                    style={getContextMenuInitialStyle()}
                    className="ctx-menu chat-floating-ctx-menu flex py-[6px] px-0"
                >
                    <button
                        onClick={() => {
                            copyTextToClipboard(msg.content);
                            closeContextMenu();
                        }}
                        className="ctx-menu-btn"
                    >复制</button>
                    <button
                        onClick={() => {
                            handleEditMessageStart(msg);
                        }}
                        className="ctx-menu-btn"
                    >编辑</button>
                    <button
                        onClick={() => {
                            handleDeleteMessage(storedMessageId);
                            closeContextMenu();
                        }}
                        className="ctx-menu-btn ctx-menu-btn-danger"
                    >删除</button>
                    <div data-menu-triangle className="ctx-menu-triangle absolute -top-[6px] w-0 h-0" />
                </div>
            );
            return wrapperRef.current ? createPortal(instructionMenu, wrapperRef.current) : instructionMenu;
        }

        const menu = (
            <div
                onPointerDown={e => e.stopPropagation()}
                ref={positionFloatingContextMenu}
                style={getContextMenuInitialStyle()}
                className="ctx-menu chat-floating-ctx-menu flex py-[6px] px-0"
            >
                <button
                    onClick={() => {
                        const text = msg.mediaType === "memory_write_request"
                            ? (msg.mediaData?.memoryContent || msg.content)
                            : msg.content;
                        copyTextToClipboard(text);
                        closeContextMenu();
                    }}
                    className="ctx-menu-btn"
                >复制</button>
                {(msg.rawResponseText || msg.responseBatchId || msg.editableResponseText) && (
                    <button
                        onClick={() => {
                            handleEditResponseStart(msg);
                        }}
                        className="ctx-menu-btn"
                    >编辑</button>
                )}
                <button
                    onClick={() => {
                        startMultiSelectFromMessage(msg);
                    }}
                    className="ctx-menu-btn"
                >多选</button>
                <button
                    onClick={() => {
                        handleDeleteMessage(storedMessageId);
                        closeContextMenu();
                    }}
                    className="ctx-menu-btn ctx-menu-btn-danger"
                >删除</button>
                <div data-menu-triangle className="ctx-menu-triangle absolute -top-[6px] w-0 h-0" />
            </div>
        );
        return wrapperRef.current ? createPortal(menu, wrapperRef.current) : menu;
    };

    // ── Voice call message grouping ──────────────────
    // Deduplicate messages (staggered timeouts + concurrent reloads can cause duplicates)
    const dedupedMessages = useMemo(() => {
        const seen = new Set<string>();
        return displayMessages.filter(m => {
            if (isReadingDiscussMessage(m)) return false;
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
        });
    }, [displayMessages]);

    const projectedMessages = useMemo<RenderChatMessage[]>(() => {
        const batches = new Map<string, ChatMessage[]>();
        for (const msg of dedupedMessages) {
            if (msg.role !== "assistant" || !msg.responseBatchId || !msg.rawResponseText?.trim()) continue;
            const key = `${msg.responseRoundId || ""}\x1f${msg.responseBatchId}\x1f${msg.rawResponseText}`;
            const batch = batches.get(key) || [];
            batch.push(msg);
            batches.set(key, batch);
        }

        const projected: RenderChatMessage[] = [];
        const consumedBatchKeys = new Set<string>();
        for (const msg of dedupedMessages) {
            const batchKey = msg.role === "assistant" && msg.responseBatchId && msg.rawResponseText?.trim()
                ? `${msg.responseRoundId || ""}\x1f${msg.responseBatchId}\x1f${msg.rawResponseText}`
                : "";
            if (!batchKey) {
                projected.push(msg);
                continue;
            }
            if (consumedBatchKeys.has(batchKey)) continue;
            consumedBatchKeys.add(batchKey);

            const batch = batches.get(batchKey) || [msg];
            const raw = batch[0]?.rawResponseText?.trim();
            if (!raw) {
                projected.push(...batch);
                continue;
            }
            const displayRaw = renderDisplayText(raw, 2, false);
            if (displayRaw === raw) {
                projected.push(...batch);
                continue;
            }
            const parsed = parseAIResponse(displayRaw, []);
            const parts = normalizeDisplayParts(parsed.parts);
            // 面板投影到第一条能显示它的消息上（拍一拍/通话留痕是系统小字，没有面板入口）
            const displayMetaIdx = parts.findIndex(canCarryFoldedPanel);
            const storedMeta = batch.find(m => m.statusPanel || m.innerMonologue || m.reasoningText || (m.stateValues && m.stateValues.length > 0));
            let metaProjected = false;
            parts.forEach((part, index) => {
                const base = batch[Math.min(index, batch.length - 1)] || batch[0];
                if (!base) return;
                const sourceId = base.id;
                const id = index < batch.length ? sourceId : `${batch[0].id}__display_${index}`;
                const isMetaSlot = index === displayMetaIdx;
                const statusPanelHere = isMetaSlot ? (parsed.statusPanel || storedMeta?.statusPanel) : undefined;
                // 面板从 storedMeta 挪到了别的槽位，戳要跟着面板走：光靠 ...base 展开会取到
                // 槽位那条消息的戳（多半是空的），投影后状态栏就退回原生渲染了。
                const statusRegionModeHere = isMetaSlot && statusPanelHere
                    ? (storedMeta?.statusRegionMode ?? base.statusRegionMode)
                    : undefined;
                const innerMonologueHere = isMetaSlot ? (parsed.innerMonologue || storedMeta?.innerMonologue) : undefined;
                const reasoningTextHere = isMetaSlot ? storedMeta?.reasoningText : undefined;
                const stateValuesHere = isMetaSlot ? storedMeta?.stateValues : undefined;
                const freshStateValuesHere = isMetaSlot ? storedMeta?.freshStateValues : undefined;
                if (isMetaSlot && (statusPanelHere || innerMonologueHere || reasoningTextHere || (stateValuesHere && stateValuesHere.length > 0))) {
                    metaProjected = true;
                }
                // 语音条的 mediaData 里存着播放必需的状态（synthesizedFromText/voiceDuration），
                // 直接用重解析结果整体替换会把它们丢掉，导致气泡永远判定"待重合成"而点不响。
                // 双方都是语音条时按存储值打底、重解析字段覆盖。
                const mediaData = part.mediaType === "audio" && base.mediaType === "audio" && base.mediaData
                    ? { ...base.mediaData, ...part.mediaData }
                    : part.mediaData;
                projected.push({
                    ...base,
                    id,
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData,
                    statusPanel: statusPanelHere,
                    statusRegionMode: statusRegionModeHere,
                    innerMonologue: innerMonologueHere,
                    reasoningText: reasoningTextHere,
                    stateValues: stateValuesHere,
                    freshStateValues: freshStateValuesHere,
                    displayProjected: true,
                    displaySourceId: sourceId,
                });
            });
            // 投影后没有任何消息驮面板（比如整段只剩拍一拍/通话留痕）→ 补一条空投影消息
            if (!metaProjected && storedMeta) {
                projected.push({
                    ...storedMeta,
                    id: `${batch[0].id}__display_meta`,
                    content: "",
                    mediaType: undefined,
                    mediaData: undefined,
                    displayProjected: true,
                    displaySourceId: storedMeta.id,
                });
            }
        }
        return projected;
    }, [dedupedMessages, normalizeDisplayParts, renderDisplayText]);

    // Build a map: startMsgId → { startIdx, endIdx, duration }
    // and a set of all message indices that belong to a voice call group
    const voiceCallGroups = useMemo(() => {
        const groups: { startId: string; startIdx: number; endIdx: number; duration: string; callType: "voice" | "video" }[] = [];
        const memberSet = new Set<number>();

        let i = 0;
        while (i < projectedMessages.length) {
            const msg = projectedMessages[i];
            if (uiRole(msg) !== "system") { i++; continue; }
            // Detect call START precisely: "发起了语音通话" / "发起了视频通话"
            const isVoiceStart = msg.content.includes("发起了语音通话");
            const isVideoStart = msg.content.includes("发起了视频通话");
            if (isVoiceStart || isVideoStart) {
                const callType = isVideoStart ? "video" : "voice";
                const kw = isVideoStart ? "视频通话" : "语音通话";
                let endIdx = -1;
                let duration = "";
                for (let j = i + 1; j < projectedMessages.length; j++) {
                    if (uiRole(projectedMessages[j]) !== "system") continue;
                    const c = projectedMessages[j].content;
                    // Another call start → separate call, stop
                    if (c.includes("发起了语音通话") || c.includes("发起了视频通话")) break;
                    // Call end: 挂断/拒绝/取消（兼容"群语音通话"/"群视频通话"）
                    if (c.includes(`挂断了${kw}`) || c.includes(`挂断了群${kw}`) || c.includes(`拒绝了${kw}`) || c.includes(`拒绝了群${kw}`) || c.includes(`取消了${kw}`) || c.includes(`取消了群${kw}`)) {
                        endIdx = j;
                        const match = c.match(/时长\s*(\d+:\d+)/);
                        duration = match ? match[1] : "";
                        break;
                    }
                }
                if (endIdx > i) {
                    groups.push({ startId: msg.id, startIdx: i, endIdx, duration, callType });
                    for (let k = i; k <= endIdx; k++) memberSet.add(k);
                    i = endIdx + 1;
                    continue;
                }
            }
            i++;
        }
        return { groups, memberSet };
    }, [projectedMessages]);

    const getSelectableStoredMessageId = useCallback((msg: RenderChatMessage): string | null => {
        const id = msg.displaySourceId || msg.id;
        if (!id || id.startsWith("vc-") || isTransientMessage(id)) return null;
        return id;
    }, []);

    const visibleSelectableMessageIds = useMemo(() => {
        const ids: string[] = [];
        const seen = new Set<string>();
        projectedMessages.forEach((msg, idx) => {
            if (voiceCallGroups.memberSet.has(idx)) return;
            const storedId = getSelectableStoredMessageId(msg);
            if (!storedId || seen.has(storedId)) return;
            const displayContent = getMessageDisplayContent(msg);
            if (isHiddenChatFlowMessage(msg, displayContent)) return;
            seen.add(storedId);
            ids.push(storedId);
        });
        return ids;
    }, [getMessageDisplayContent, getSelectableStoredMessageId, projectedMessages, voiceCallGroups.memberSet]);

    const multiDeleteTargetIds = useMemo(() => {
        if (selectedMessageIds.size === 0) return [];
        const storedMessages = loadChatMessages(session.id);
        const storedIndexById = new Map(storedMessages.map((msg, index) => [msg.id, index]));
        const targets = new Set<string>();

        selectedMessageIds.forEach(id => {
            if (storedIndexById.has(id)) targets.add(id);
        });

        for (let i = 0; i < visibleSelectableMessageIds.length - 1; i += 1) {
            const leftId = visibleSelectableMessageIds[i];
            const rightId = visibleSelectableMessageIds[i + 1];
            if (!selectedMessageIds.has(leftId) || !selectedMessageIds.has(rightId)) continue;

            const leftIndex = storedIndexById.get(leftId);
            const rightIndex = storedIndexById.get(rightId);
            if (leftIndex === undefined || rightIndex === undefined || rightIndex <= leftIndex) continue;

            for (let storedIndex = leftIndex + 1; storedIndex < rightIndex; storedIndex += 1) {
                targets.add(storedMessages[storedIndex].id);
            }
        }

        return [...targets];
    }, [selectedMessageIds, session.id, visibleSelectableMessageIds]);

    const cancelMultiSelect = useCallback(() => {
        setIsMultiSelectMode(false);
        setSelectedMessageIds(new Set());
        setShowConfirmMultiDelete(false);
    }, []);

    const toggleMultiSelectedMessage = useCallback((messageId: string) => {
        setSelectedMessageIds(prev => {
            const next = new Set(prev);
            if (next.has(messageId)) next.delete(messageId);
            else next.add(messageId);
            return next;
        });
    }, []);

    const startMultiSelectFromMessage = useCallback((msg: RenderChatMessage) => {
        const storedId = getSelectableStoredMessageId(msg);
        if (!storedId) return;
        closeContextMenu();
        setShowEmojiPanel(false);
        setShowStickerPanel(false);
        setShowPlusMenu(false);
        setIsMultiSelectMode(true);
        setSelectedMessageIds(new Set([storedId]));
    }, [getSelectableStoredMessageId]);

    const confirmMultiDelete = useCallback(() => {
        if (multiDeleteTargetIds.length === 0) {
            showChatToast("请选择要删除的消息");
            return;
        }
        setShowConfirmMultiDelete(true);
    }, [multiDeleteTargetIds.length]);

    const handleMultiDeleteConfirmed = () => {
        const targetIds = new Set(multiDeleteTargetIds);
        const stored = loadChatMessages(session.id);
        const targetMessages = stored.filter(msg => targetIds.has(msg.id));
        const surviving = stored.filter(msg => !targetIds.has(msg.id));
        setShowConfirmMultiDelete(false);
        const currentInvite = activeOfflineInviteRef.current;
        const targetHasInviteRelated = targetMessages.some(m =>
            isOfflineInviteRootMessage(m) ||
            isOfflineInviteSystemMessage(m) ||
            m.mediaType === "offline_invite" ||
            m.mediaType === "offline_invite_change_place" ||
            m.mediaType === "offline_invite_early_arrive" ||
            m.mediaType === "offline_invite_arrive_notice" ||
            Boolean(m.mediaData?.offlineInvite)
        );

        if (currentInvite && targetHasInviteRelated) {
            // 【状态栏预处理钓鱼竿】：以多选删除后的剩余消息模拟计算下一个状态栏
            const nextInvite = restoreOfflineInviteFromMessages(surviving, currentInvite);

            if (!nextInvite) {
                // 状态栏没了：彻底清空本次线下赴约
                kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                kvRemove(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id);
                kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                kvRemove(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id);
                updateActiveOfflineInvite(null);
                setIsOfflineInviteMinimized(false);
                if (remindExpandTimerRef.current) {
                    clearTimeout(remindExpandTimerRef.current);
                    remindExpandTimerRef.current = null;
                }
            } else {
                // 状态栏变了：精准同步回溯
                updateActiveOfflineInvite(nextInvite);
            }
        }
        if (unlockExpandTimerRef.current) {
            clearTimeout(unlockExpandTimerRef.current);
            unlockExpandTimerRef.current = null;
        }
        const rootId = offlineLockDataRef.current?.sourceBatchId;
        const truncatesLockRoot = Boolean(rootId && targetMessages.some(m => m.responseBatchId === rootId || m.id === rootId));
        const survivingHasLock = surviving.some(isOfflineLockNoticeMessage);
        if (truncatesLockRoot || (!survivingHasLock && targetMessages.some(isOfflineLockNoticeMessage))) {
            kvRemove(OFFLINE_LOCK_PREFIX + session.id);
            setOfflineLockData(null);
            offlineLockDataRef.current = null;
        }
        const targetHasLockOrUnlock = targetMessages.some(m => isOfflineLockNoticeMessage(m) || isOfflineUnlockNoticeMessage(m));
        void deleteWeixinCloudBeforeLocal(targetMessages, () => {
            const deletedCount = deleteChatMessagesByIds(session.id, multiDeleteTargetIds);
            const hasDecline = targetMessages.some(m =>
                (m.role === "system" || m.mediaType === "offline_invite_system_notice") &&
                Boolean(m.content && (/你婉拒了.*线下邀约提议|婉拒了.*线下赴约提议/.test(m.content)))
            );
            if (hasDecline) {
                kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
            }
            syncMessagesFromStorage();
            cancelMultiSelect();
            if (deletedCount > 0 && !targetHasLockOrUnlock) showChatToast(`已删除 ${deletedCount} 条历史`);
        });
    };

    /* Settings panel is rendered as an overlay (not early return) to preserve chat scroll position */

    const jumpToStoredMessage = useCallback((messageId: string) => {
        const allMsgs = loadChatMessages(session.id);
        const targetIndex = allMsgs.findIndex(msg => msg.id === messageId);
        if (targetIndex < 0) return;

        let nextCount = Math.min(INITIAL_LOAD, allMsgs.length);
        while (allMsgs.length - nextCount > targetIndex) {
            nextCount = Math.min(allMsgs.length, nextCount + LOAD_MORE_COUNT);
        }
        const computedStartIndex = Math.max(0, allMsgs.length - nextCount);
        const currentFirstVisibleId = visibleMessagesRef.current.find(msg => !isTransientMessage(msg))?.id;
        const currentStartIndex = currentFirstVisibleId
            ? allMsgs.findIndex(msg => msg.id === currentFirstVisibleId)
            : -1;
        const startIndex = currentStartIndex >= 0
            ? Math.min(computedStartIndex, currentStartIndex)
            : computedStartIndex;
        const nextMessages = allMsgs.slice(startIndex);
        const targetMsg = allMsgs[targetIndex];
        const batchKey = targetMsg?.role === "assistant" && targetMsg.responseBatchId && targetMsg.rawResponseText?.trim()
            ? `${targetMsg.responseRoundId || ""}\x1f${targetMsg.responseBatchId}\x1f${targetMsg.rawResponseText}`
            : "";
        const fallbackMessageId = batchKey
            ? nextMessages.find(msg => (
                msg.role === "assistant" &&
                msg.responseBatchId &&
                msg.rawResponseText?.trim() &&
                `${msg.responseRoundId || ""}\x1f${msg.responseBatchId}\x1f${msg.rawResponseText}` === batchKey
            ))?.id
            : undefined;

        stopLoadMoreAnchorTracking();
        loadMoreScrollRestoreRef.current = null;
        loadingMoreRef.current = false;
        initialScrollVersionRef.current += 1;
        needsInitialScrollRef.current = false;
        pendingSearchJumpRef.current = {
            messageId,
            ...(fallbackMessageId && fallbackMessageId !== messageId ? { fallbackMessageId } : {}),
        };

        const nextHasMore = startIndex > 0;
        visibleMessagesRef.current = nextMessages;
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
        setMessages(nextMessages);
    }, [session.id, stopLoadMoreAnchorTracking]);

    // Shared handler: reload messages + re-trigger scroll-to-bottom after call ends
    const returnFromCall = (hide: () => void) => {
        hide();
        setCallMinimized(false);
        needsInitialScrollRef.current = true;
        prevMsgCountRef.current = 0;
        syncMessagesFromStorage();
        triggerReply();
    };

    const editingMessage = editingMessageId ? messages.find(m => m.id === editingMessageId) : null;
    const editingSystemInstruction = editingMessage ? isSystemInstructionMessage(editingMessage) : false;

    // 群聊通话没有缩小悬浮窗，维持原有的整屏早退渲染
    if (showVoiceCall && session.isGroup && groupCharacters.length > 0) {
        return (
            <GroupCallScreen
                type="voice"
                session={session}
                characters={groupCharacters}
                initiator={callInitiator}
                initiatorName={callInitiatorName}
                onEnd={() => returnFromCall(() => setShowVoiceCall(false))}
            />
        );
    }

    if (showVideoCall && session.isGroup && groupCharacters.length > 0) {
        return (
            <GroupCallScreen
                type="video"
                session={session}
                characters={groupCharacters}
                initiator={callInitiator}
                initiatorName={callInitiatorName}
                onEnd={() => returnFromCall(() => setShowVideoCall(false))}
            />
        );
    }
    // 单聊语音/视频通话改为在下方主返回内联渲染（而非提前 return），
    // 这样缩小为悬浮窗时聊天页与通话组件可以同时挂载，通话状态（计时/字幕）不会丢失。

    const chatRoomBackgroundStyle = bgImageResolved ? {
        backgroundColor: "#fff",
        backgroundImage: `url(${bgImageResolved})`,
        backgroundPosition: "center",
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
    } : undefined;

    return (
        <div ref={wrapperRef} className={`session-${session.id} chat-room-wrapper page-shell inset-0 flex flex-col z-20`} style={chatRoomBackgroundStyle} {...(bgLoading ? { "data-loading": "" } : {})} {...(bgImageResolved ? { "data-has-bg-image": "" } : {})} {...(showSettings ? { "data-settings-open": "" } : {})}>
            {/* Custom CSS Injection for this session — scoped to prevent leaking */}
            {liveCSS && (
                <SessionCustomCSS css={liveCSS} scope={`.session-${session.id}`} />
            )}

            {/* 全屏特效层（表情雨/礼花），不拦截任何触摸操作 */}
            <ChatScreenEffectOverlay active={activeScreenEffect} onDone={() => setActiveScreenEffect(null)} />
            {/* Header */}
            <header className="page-header chat-room-main-pane" data-ui="header">
                <div className="page-header-safe-area" />
                <div className="page-header-content">
                    <button className="page-back-btn" type="button" onClick={onBack} aria-label="返回">
                        <ChevronLeft size={24} strokeWidth={1.5} />
                    </button>
                    <span className="page-title" style={{ position: 'relative' }}>
                        {offlineMode ? "线下 · " : ""}
                        {session.isGroup
                            ? `${session.groupName || "群聊"}(${(session.participantIds?.length || 0) + (session.isSpectator ? 0 : 1)})`
                            : (session.alias || character?.name || `User_${session.contactId.slice(-4)}`)}
                        {(isGenerating || isOfflineGenerating) && (
                            <span className="chat-typing-indicator">
                                {offlineMode ? "线下生成中" : "对方正在输入"}<span className="chat-typing-dots"><i/><i/><i/></span>
                            </span>
                        )}
                    </span>
                    <span className="page-header-right">
                        <button className="page-back-btn" type="button" onClick={() => setShowSettings(true)} aria-label="更多">
                            <MoreHorizontal size={22} strokeWidth={1.5} />
                        </button>
                    </span>
                </div>
            </header>
            <ChatPluginSlot
                name="chat.header"
                slotProps={{ sessionId: session.id, isGroup: !!session.isGroup }}
                className="chat-plugin-header chat-room-main-pane"
            />

            {!offlineMode && (
                activeOfflineInvite && isOfflineInviteMinimized ? (
                    <div className="chat-offline-invite-capsule-wrapper">
                        <OfflineInviteCapsule
                            invite={activeOfflineInvite}
                            character={character}
                            onClick={handleExpandOfflineInvite}
                            onAccept={handleAcceptOfflineInvite}
                            isRetrying={isRetryingOffline}
                        />
                    </div>
                ) : (kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1" ? (() => {
                    const activeMeetingTheme = kvGet(OFFLINE_INVITE_ACTIVE_THEME_PREFIX + session.id) || activeOfflineInvite?.theme || "default";
                    const isMeetingForced = activeMeetingTheme === "forced";
                    const isMeetingAlert = activeMeetingTheme === "alert" || isMeetingForced;
                    const pingDotBg = isMeetingAlert ? "bg-[var(--c-danger,#FF3B30)]" : "bg-[var(--c-primary,#2563eb)]";
                    const solidDotBg = isMeetingAlert
                        ? `bg-[var(--c-danger,#FF3B30)] ${isMeetingForced ? "shadow-[0_0_8px_rgba(255,59,48,0.9)]" : ""}`
                        : "bg-[var(--c-primary,#2563eb)]";
                    const btnBg = isMeetingForced
                        ? "bg-[var(--c-danger,#FF3B30)] shadow-[0_2px_12px_rgba(255,59,48,0.6)] hover:opacity-95 text-white"
                        : isMeetingAlert
                        ? "bg-[var(--c-danger,#FF3B30)] shadow-[0_2px_8px_rgba(255,59,48,0.38)] hover:opacity-95 text-white"
                        : "bg-[var(--c-primary,#2563eb)] shadow-[0_2px_8px_rgba(37,99,235,0.35)] hover:opacity-90 text-white";

                    return (
                        <div className="chat-offline-invite-capsule-wrapper">
                            <div
                                onClick={() => doToggleOfflineMode(false)}
                                className={`w-fit max-w-[92%] mx-auto px-3.5 py-1.5 rounded-full backdrop-blur-md shadow-md flex items-center gap-2 cursor-pointer select-none hover:scale-[1.02] active:scale-[0.98] transition-all ${
                                    isMeetingForced
                                        ? "offline-invite-capsule-forced"
                                        : "bg-[var(--c-panel,#ffffff)]/95 border border-[var(--c-panel-border,rgba(0,0,0,0.12))]"
                                }`}
                                data-ui="offline-invite-capsule"
                                title="点击返回面对面碰面"
                            >
                                <span className="relative inline-flex items-center justify-center h-2 w-2 shrink-0">
                                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pingDotBg}`} />
                                    <span className={`relative inline-flex rounded-full h-2 w-2 ${solidDotBg}`} />
                                </span>
                                <span className={`text-xs font-medium truncate inline-flex items-center leading-none ${isMeetingForced ? "text-gray-100" : "text-[var(--c-text-title,#111827)]"}`}>
                                    {isMeetingAlert ? "" : "✨ "}与 {character?.name || "对方"} 线下碰面中
                                </span>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        doToggleOfflineMode(false);
                                    }}
                                    className={`text-[11px] font-semibold px-2.5 h-[22px] rounded-full active:scale-95 transition-all shrink-0 cursor-pointer shadow-sm inline-flex items-center justify-center leading-none ${btnBg}`}
                                >
                                    回到现场
                                </button>
                            </div>
                        </div>
                    );
                })() : null)
            )}

            {/* Message List */}
            <div
                ref={scrollRef}
                className="page-body chat-room-main-pane flex flex-col gap-4 chat-scroll-anchored"
                onScroll={(e) => {
                    if (activeMessageId || activeOfflineTarget) closeContextMenu();
                }}
                onPointerDown={(e) => {
                    if (activeMessageId || activeOfflineTarget) closeContextMenu();
                    if (showEmojiPanel) setShowEmojiPanel(false);
                    if (showStickerPanel) setShowStickerPanel(false);
                    if (showPlusMenu) setShowPlusMenu(false);
                }}
            >
                {offlineMode && (
                    <div className="chat-offline-body">
                        {offlineTurns.length === 0 && !pendingOfflineUserText ? (
                            <div className="chat-offline-empty">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0Z" /><circle cx="12" cy="10" r="3" /></svg>
                                线下模式
                            </div>
                        ) : null}
                        {hasMoreOfflineTurns && (
                            <button
                                type="button"
                                className="chat-sys-msg chat-load-more-button"
                                onClick={loadMoreOfflineTurns}
                            >
                                <span>查看更多线下记录</span>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="18 15 12 9 6 15" />
                                </svg>
                            </button>
                        )}
                        {visibleOfflineTurns.map((turn, turnIdx) => {
                            const offlineDisplay = offlineDisplayByTurnId.get(turn.id) ?? getOfflineDisplayText(turn);
                            const assistantHasHtmlPreview = hasOfflineHtmlPreview(offlineDisplay.assistantContent);
                            const prevTime = turnIdx > 0 ? visibleOfflineTurns[turnIdx - 1].createdAt : null;
                            const showTime = !prevTime || shouldShowTimestamp(turn.createdAt, prevTime);
                            return (
                            <Fragment key={turn.id}>
                            {showTime && <div className="chat-offline-time">{formatChatUiTime(turn.createdAt)}</div>}
                            <div className="chat-offline-turn">
                                <div className="chat-offline-entry" data-role="user" style={offlineDisplay.userContent.trim() ? undefined : { display: "none" }}>
                                    {/* 头像占位：默认 display:none（见 chat.css），供自定义 CSS 显示 */}
                                    <div className="chat-offline-avatar" aria-hidden="true">
                                        {userIdentity?.avatarUrl ? <img src={userIdentity.avatarUrl} alt="" /> : <User size={18} color="var(--c-text)" />}
                                    </div>
                                    <div className="chat-offline-label">你</div>
                                    <div
                                        className="chat-offline-text"
                                        onPointerDown={(e) => { e.stopPropagation(); handleOfflinePointerDown(e, { turnId: turn.id, role: "user" }); }}
                                        onPointerUp={(e) => handleMessagePointerUp(e)}
                                        onPointerCancel={handleMessagePointerCancel}
                                        onPointerLeave={handleMessagePointerCancel}
                                        onPointerMove={(e) => {
                                            if (startPosRef.current) {
                                                const dx = Math.abs(e.clientX - startPosRef.current.x);
                                                const dy = Math.abs(e.clientY - startPosRef.current.y);
                                                if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                            }
                                        }}
                                        onContextMenu={(e) => { e.preventDefault(); openOfflineContextMenu({ turnId: turn.id, role: "user" }, { x: e.clientX, y: e.clientY }); }}
                                        {...(activeOfflineTarget?.turnId === turn.id && activeOfflineTarget.role === "user" ? { "data-active": "" } : {})}
                                    >
                                        {activeOfflineTarget?.turnId === turn.id && activeOfflineTarget.role === "user" && renderOfflineContextMenu(turn, "user")}
                                        <BilingualTextBlock
                                            text={offlineDisplay.userContent}
                                            mode="markdown"
                                            defaultExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                        />
                                    </div>
                                </div>
                                <div className="chat-offline-entry" data-role="assistant">
                                    {/* 头像占位：默认 display:none（见 chat.css），供自定义 CSS 显示 */}
                                    <div className="chat-offline-avatar" aria-hidden="true">
                                        {character?.avatar ? <img src={character.avatar} alt="" /> : <ChatFallbackAvatar />}
                                    </div>
                                    <div className="chat-offline-label-row">
                                        <div className="chat-offline-label">{session.isGroup ? (session.groupName || "群聊") : (character?.name || "对方")}</div>
                                        {assistantHasHtmlPreview ? (
                                            <button
                                                type="button"
                                                className="chat-offline-menu-trigger"
                                                aria-label="线下回复操作"
                                                title="线下回复操作"
                                                onPointerDown={(e) => {
                                                    e.stopPropagation();
                                                    handleMessagePointerCancel();
                                                }}
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    const rect = e.currentTarget.getBoundingClientRect();
                                                    openOfflineContextMenu({ turnId: turn.id, role: "assistant" }, {
                                                        x: rect.left + rect.width / 2,
                                                        y: rect.bottom,
                                                    });
                                                }}
                                            >
                                                <MoreHorizontal size={16} strokeWidth={2} />
                                            </button>
                                        ) : null}
                                    </div>
                                    {/* 思维链触发条（线下模式，Claude app 风格）：优先展示预设格式 <thinking> 解析结果，缺省回退模型 API 原生思考 */}
                                    {(turn.thinkingText || turn.reasoningText) && (
                                        <button
                                            type="button"
                                            className="chat-reasoning-trigger"
                                            onClick={(e) => { e.stopPropagation(); setReasoningSheetText(turn.thinkingText || turn.reasoningText || null); }}
                                            aria-label="查看思考过程"
                                        >
                                            <Clock size={13} strokeWidth={1.8} className="chat-reasoning-trigger-icon" />
                                            <span className="chat-reasoning-trigger-text">{reasoningPreviewLine(turn.thinkingText || turn.reasoningText || "")}</span>
                                            <ChevronRight size={14} strokeWidth={1.8} className="chat-reasoning-trigger-icon" />
                                        </button>
                                    )}
                                    <div
                                        className="chat-offline-text"
                                        onPointerDown={(e) => { e.stopPropagation(); handleOfflinePointerDown(e, { turnId: turn.id, role: "assistant" }); }}
                                        onPointerUp={(e) => handleMessagePointerUp(e)}
                                        onPointerCancel={handleMessagePointerCancel}
                                        onPointerLeave={handleMessagePointerCancel}
                                        onPointerMove={(e) => {
                                            if (startPosRef.current) {
                                                const dx = Math.abs(e.clientX - startPosRef.current.x);
                                                const dy = Math.abs(e.clientY - startPosRef.current.y);
                                                if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                            }
                                        }}
                                        onContextMenu={(e) => { e.preventDefault(); openOfflineContextMenu({ turnId: turn.id, role: "assistant" }, { x: e.clientX, y: e.clientY }); }}
                                        {...(activeOfflineTarget?.turnId === turn.id && activeOfflineTarget.role === "assistant" ? { "data-active": "" } : {})}
                                    >
                                        {activeOfflineTarget?.turnId === turn.id && activeOfflineTarget.role === "assistant" && renderOfflineContextMenu(turn, "assistant")}
                                        <OfflineAssistantTextBlock
                                            text={offlineDisplay.assistantContent}
                                            defaultExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                        />
                                    </div>
                                    {turn.summary.trim() && (
                                        <details className="chat-offline-summary-fold">
                                            <summary>摘要（{turn.summaryTag || "summary"}）</summary>
                                            <div className="chat-offline-summary-content">
                                                <BilingualTextBlock
                                                    text={offlineDisplay.summary}
                                                    mode="markdown"
                                                    defaultExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                                />
                                            </div>
                                        </details>
                                    )}
                                </div>
                            </div>
                            </Fragment>
                            );
                        })}
                        {(pendingOfflineUserText || isOfflineGenerating) && (
                            <div className="chat-offline-turn">
                                <div className="chat-offline-entry" data-role="user" style={pendingOfflineUserText ? undefined : { display: "none" }}>
                                    {/* 头像占位：默认 display:none（见 chat.css），供自定义 CSS 显示 */}
                                    <div className="chat-offline-avatar" aria-hidden="true">
                                        {userIdentity?.avatarUrl ? <img src={userIdentity.avatarUrl} alt="" /> : <User size={18} color="var(--c-text)" />}
                                    </div>
                                    <div className="chat-offline-label">你</div>
                                    <div className="chat-offline-text">
                                        <BilingualTextBlock
                                            text={renderDisplayText(pendingOfflineUserText, 1, true)}
                                            mode="markdown"
                                            defaultExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                        />
                                    </div>
                                </div>
                                {offlineStreamPreview?.content ? (
                                    /* 流式预览原地长出：与正式剧情正文同结构（头像/角色名/正文区），
                                       正文用轻量 pre-wrap 渲染（避免每帧 markdown/双语解析），落库时原地换成正式排版 */
                                    <div className="chat-offline-entry" data-role="assistant">
                                        <div className="chat-offline-avatar" aria-hidden="true">
                                            {character?.avatar ? <img src={character.avatar} alt="" /> : <ChatFallbackAvatar />}
                                        </div>
                                        <div className="chat-offline-label-row">
                                            <div className="chat-offline-label">{session.isGroup ? (session.groupName || "群聊") : (character?.name || "对方")}</div>
                                        </div>
                                        <div className="chat-offline-text">
                                            <div className="chat-stream-text whitespace-pre-wrap break-words">{offlineStreamPreview.content}</div>
                                            <span className="chat-stream-cursor" aria-hidden="true" />
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>
                )}
                {!offlineMode && hasMore && (
                    <button
                        type="button"
                        className="chat-sys-msg chat-load-more-button"
                        onClick={loadMore}
                    >
                        <span>查看更多消息</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="18 15 12 9 6 15" />
                        </svg>
                    </button>
                )}
                {!offlineMode && projectedMessages.map((msg, idx) => {
                    // ── Voice call group: collapsed widget ──
                    const vcGroup = voiceCallGroups.groups.find(g => g.startIdx === idx);
                    if (vcGroup) {
                        const isExpanded = expandedVoiceCallIds.has(vcGroup.startId);
                        const groupMessages = projectedMessages.slice(vcGroup.startIdx, vcGroup.endIdx + 1);
                        const chatCount = groupMessages.filter(m => uiRole(m) !== "system").length;
                        return (
                            <div key={`vc-${vcGroup.startId}`} className="flex flex-col gap-2">
                                <div
                                    onPointerDown={(e) => { e.stopPropagation(); handleMessagePointerDown(e, `vc-${vcGroup.startId}`); }}
                                    onPointerUp={(e) => handleMessagePointerUp(e)}
                                    onPointerCancel={handleMessagePointerCancel}
                                    onPointerLeave={handleMessagePointerCancel}
                                    onPointerMove={(e) => {
                                        if (startPosRef.current) {
                                            const dx = Math.abs(e.clientX - startPosRef.current.x);
                                            const dy = Math.abs(e.clientY - startPosRef.current.y);
                                            if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                        }
                                    }}
                                    onContextMenu={(e) => { e.preventDefault(); openMessageContextMenu(`vc-${vcGroup.startId}`, { x: e.clientX, y: e.clientY }); }}
                                    onClick={() => {
                                        if (activeMessageId === `vc-${vcGroup.startId}`) return;
                                        setExpandedVoiceCallIds(prev => {
                                            const next = new Set(prev);
                                            if (next.has(vcGroup.startId)) next.delete(vcGroup.startId);
                                            else next.add(vcGroup.startId);
                                            return next;
                                        });
                                    }}
                                    className="chat-sys-msg flex items-center justify-center gap-[6px] py-[6px] px-[14px] mx-auto rounded-2xl cursor-pointer relative"
                                    {...(activeMessageId === `vc-${vcGroup.startId}` ? { "data-active": "" } : {})}
                                >
                                    {vcGroup.callType === "video" ? (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                                        </svg>
                                    ) : (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                                        </svg>
                                    )}
                                    <span>{vcGroup.callType === "video" ? "视频通话" : "语音通话"}{vcGroup.duration ? ` ${vcGroup.duration}` : ""}{chatCount > 0 ? ` · ${chatCount}条消息` : ""}</span>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                                        className="ui-chevron-down-flip" {...(isExpanded ? { "data-open": "" } : {})}>
                                        <polyline points="6 9 12 15 18 9" />
                                    </svg>
                                    {activeMessageId === `vc-${vcGroup.startId}` && renderDeleteOnlyContextMenu(() => {
                                        const groupMsgIds = groupMessages.map(m => m.id);
                                        void deleteWeixinCloudBeforeLocal(groupMessages, () => {
                                            groupMsgIds.forEach(id => deleteChatMessage(id));
                                            setMessages(prev => prev.filter(m => !groupMsgIds.includes(m.id)));
                                        });
                                    })}
                                </div>
                                {isExpanded && (
                                    <div className="chat-vc-group-border">
                                        {groupMessages.map((gMsg) => (
                                            uiRole(gMsg) === "system" ? (
                                                <div key={gMsg.id} className="flex justify-center">
                                                    <div
                                                        onPointerDown={(e) => { e.stopPropagation(); handleMessagePointerDown(e, gMsg.id); }}
                                                        onPointerUp={(e) => handleMessagePointerUp(e)}
                                                        onPointerCancel={handleMessagePointerCancel}
                                                        onPointerLeave={handleMessagePointerCancel}
                                                        onPointerMove={(e) => {
                                                            if (startPosRef.current) {
                                                                const dx = Math.abs(e.clientX - startPosRef.current.x);
                                                                const dy = Math.abs(e.clientY - startPosRef.current.y);
                                                                if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                                            }
                                                        }}
                                                        onContextMenu={(e) => { e.preventDefault(); openMessageContextMenu(gMsg.id, { x: e.clientX, y: e.clientY }); }}
                                                        className="chat-sys-msg relative cursor-pointer"
                                                        {...(activeMessageId === gMsg.id ? { "data-active": "" } : {})}
                                                    >
                                                        {formatSysMsgForUI(gMsg.content, gMsg)}
                                                        {activeMessageId === gMsg.id && renderDeleteOnlyContextMenu(() => handleDeleteMessage(getStoredActionMessageId(gMsg)))}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div key={gMsg.id} className={`flex ${gMsg.role === "user" ? "justify-end" : "justify-start"}`}>
                                                    <div className="flex flex-col min-w-0 max-w-[75%]">
                                                        {session.isGroup && gMsg.role !== "user" && (
                                                            <span className="chat-group-sender-name">{gMsg.senderName || ""}{renderGroupRoleBadge(gMsg.senderCharacterId)}</span>
                                                        )}
                                                        <div
                                                            onPointerDown={(e) => { e.stopPropagation(); handleMessagePointerDown(e, gMsg.id); }}
                                                            onPointerUp={(e) => handleMessagePointerUp(e)}
                                                            onPointerCancel={handleMessagePointerCancel}
                                                            onPointerLeave={handleMessagePointerCancel}
                                                            onPointerMove={(e) => {
                                                                if (startPosRef.current) {
                                                                    const dx = Math.abs(e.clientX - startPosRef.current.x);
                                                                    const dy = Math.abs(e.clientY - startPosRef.current.y);
                                                                    if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                                                }
                                                            }}
                                                            onContextMenu={(e) => { e.preventDefault(); openMessageContextMenu(gMsg.id, { x: e.clientX, y: e.clientY }); }}
                                                            className={`chat-bubble-role-${gMsg.role} py-2 px-3 rounded-md break-words relative cursor-pointer`}
                                                            {...(activeMessageId === gMsg.id ? { "data-active": "" } : {})}
                                                        >
                                                            <BilingualTextBlock
                                                                text={gMsg.displayProjected ? gMsg.content : renderDisplayText(gMsg.content, gMsg.role === "user" ? 1 : 2, false)}
                                                                mode="markdown"
                                                                defaultExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                                            />
                                                            {activeMessageId === gMsg.id && renderBubbleContextMenu(gMsg, { allowMultiSelect: false })}
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    }

                    // Skip messages that belong to a voice call group (rendered above)
                    if (voiceCallGroups.memberSet.has(idx)) return null;

                    const renderMsg = msg;
                    const isSystemInstruction = isSystemInstructionMessage(renderMsg);
                    const bubbleDisplayContent = getMessageDisplayContent(renderMsg);
                    let prevVisibleMsg: RenderChatMessage | null = null;
                    for (let prevIdx = idx - 1; prevIdx >= 0; prevIdx -= 1) {
                        if (voiceCallGroups.memberSet.has(prevIdx)) continue;
                        const candidate = projectedMessages[prevIdx];
                        const candidateDisplayContent = getMessageDisplayContent(candidate);
                        if (isHiddenChatFlowMessage(candidate, candidateDisplayContent)) continue;
                        prevVisibleMsg = candidate;
                        break;
                    }
                    const showTime = shouldShowTimestamp(msg.createdAt, prevVisibleMsg?.createdAt ?? null);
                    const isConsecutive = prevVisibleMsg && !showTime && uiRole(prevVisibleMsg) === uiRole(msg) && uiRole(msg) !== "system"
                        && (!session.isGroup || prevVisibleMsg.senderCharacterId === msg.senderCharacterId);
                    // Hide bubbles with no visible content (empty text, stripped music tags, etc.)
                    const visibleContent = getChatFlowVisibleContent(renderMsg, bubbleDisplayContent);
                    const isVisualMedia = isChatVisualMedia(renderMsg);
                    const hiddenEmpty = isHiddenChatFlowMessage(renderMsg, bubbleDisplayContent);
                    const hasFoldedPanel = !!(renderMsg.statusPanel || renderMsg.innerMonologue);
                    // 内心卡片只展示本轮实际输出的状态值；旧数据没有 freshStateValues 时回退到合并快照，且彻底剔除“封禁线下”
                    const rawCardStateValues = msg.freshStateValues ?? msg.stateValues;
                    const cardStateValues = rawCardStateValues?.filter(sv => sv.name !== "封禁线下");
                    const isSilentThought = !visibleContent && !renderMsg.mediaType && hasFoldedPanel && msg.role !== "user";
                    const isStandaloneHtmlPreview = !renderMsg.mediaType && isStandaloneHtmlPreviewContent(bubbleDisplayContent);
                    const isMediaBubble = (renderMsg.mediaType && CHAT_MEDIA_BUBBLE_TYPES.has(renderMsg.mediaType)) || isStandaloneHtmlPreview;
                    // Empty bubble: no visible content AND no visual media AND no folded panel.
                    const isEmptyBubble = !isVisualMedia && !visibleContent && uiRole(msg) !== "system" && !hasFoldedPanel;
                    const selectableStoredId = getSelectableStoredMessageId(msg);
                    const isMultiSelectable = isMultiSelectMode && !!selectableStoredId && !hiddenEmpty;
                    const isMultiSelected = !!selectableStoredId && selectedMessageIds.has(selectableStoredId);
                    const multiSelectWrapperProps = isMultiSelectable ? {
                        onClickCapture: (e: React.MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleMultiSelectedMessage(selectableStoredId!);
                        },
                        "data-multi-select": "",
                        ...(isMultiSelected ? { "data-selected": "" } : {}),
                    } : {};

                    return (
                        <div key={msg.id} className="flex flex-col gap-4" {...(hiddenEmpty ? { style: { display: "none" } } : {})} {...(isEmptyBubble && renderMsg.reasoningText && !showTime ? { "data-reasoning-only": "" } : {})}>
                            {showTime && (
                                <div className="flex justify-center w-full">
                                    <span className="chat-sys-msg py-[2px] px-2 rounded select-none">
                                        {formatChatUiTime(msg.createdAt)}
                                    </span>
                                </div>
                            )}
                            {/* 思维链触发条（Claude app 风格）：点击打开底部弹窗 */}
                            {renderMsg.reasoningText && msg.role !== "user" && uiRole(msg) !== "system" && (
                                <div className="chat-msg-wrapper" data-role={uiRole(msg)} data-reasoning-row="" style={{ marginBottom: -8 }}>
                                    <div className="w-[40px] shrink-0" />
                                    <button
                                        type="button"
                                        className="chat-reasoning-trigger"
                                        onClick={(e) => { e.stopPropagation(); setReasoningSheetText(renderMsg.reasoningText || null); }}
                                        aria-label="查看思考过程"
                                    >
                                        <Clock size={13} strokeWidth={1.8} className="chat-reasoning-trigger-icon" />
                                        <span className="chat-reasoning-trigger-text">{reasoningPreviewLine(renderMsg.reasoningText)}</span>
                                        <ChevronRight size={14} strokeWidth={1.8} className="chat-reasoning-trigger-icon" />
                                    </button>
                                </div>
                            )}
                            <div
                                id={`message-${msg.id}`}
                                className="chat-msg-wrapper"
                                data-role={uiRole(msg)}
                                {...(isEmptyBubble && renderMsg.reasoningText ? { "data-reasoning-empty": "" } : {})}
                                {...(isConsecutive ? { "data-consecutive": "" } : {})}
                                {...(activeMessageId === msg.id ? { "data-active": "" } : {})}
                                {...(highlightMessageId === msg.id ? { "data-highlight": "" } : {})}
                                {...multiSelectWrapperProps}
                            >
                                {isMultiSelectable && (
                                    <span className="chat-multi-select-check" aria-hidden="true">
                                        {isMultiSelected && <Check size={14} strokeWidth={2.5} />}
                                    </span>
                                )}
                                {uiRole(msg) === "system" ? (
                                    <div
                                        onPointerDown={(e) => { e.stopPropagation(); handleMessagePointerDown(e, msg.id); }}
                                        onPointerUp={(e) => handleMessagePointerUp(e)}
                                        onPointerCancel={handleMessagePointerCancel}
                                        onPointerLeave={handleMessagePointerCancel}
                                        onPointerMove={(e) => {
                                            if (startPosRef.current) {
                                                const dx = Math.abs(e.clientX - startPosRef.current.x);
                                                const dy = Math.abs(e.clientY - startPosRef.current.y);
                                                if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                            }
                                        }}
                                        onContextMenu={(e) => { e.preventDefault(); openMessageContextMenu(msg.id, { x: e.clientX, y: e.clientY }); }}
                                        className={isSystemInstruction
                                            ? "chat-system-instruction-card relative cursor-pointer"
                                            : `chat-sys-msg break-all max-w-[90%] relative cursor-pointer${
                                                // 骰子旁白：等骰子落定再淡入，避免剧透点数
                                                msg.content.startsWith("🎲 掷出了") && Date.now() - new Date(msg.createdAt).getTime() < 6000
                                                    ? " dice-aside-reveal"
                                                    : ""
                                            }`}
                                        {...(activeMessageId === msg.id ? { "data-active": "" } : {})}
                                    >
                                        {isSystemInstruction ? (
                                            <SystemInstructionCard content={msg.content} />
                                        ) : msg.mediaType === "memory_write_request" ? (
                                            <MemoryWriteRequestCard
                                                msg={msg}
                                                onApprove={handleApproveMemoryWrite}
                                                onIgnore={handleIgnoreMemoryWrite}
                                            />
                                        ) : (
                                            <>
                                                {msg.mediaType === "poke"
                                                    ? (() => {
                                                        const sender = msg.mediaData?.pokeSender || (msg.role === "user" ? "你" : (character?.name || "对方"));
                                                        const target = msg.mediaData?.pokeTarget || (msg.role === "user" ? (character?.name || "对方") : "你");
                                                        const displaySender = sender === userIdentity?.name ? "你" : sender;
                                                        const displayTarget = target === userIdentity?.name ? "你" : target;
                                                        return `${displaySender} 拍了拍 ${displayTarget}`;
                                                    })()
                                                    : formatSysMsgForUI(msg.content, msg)}
                                            </>
                                        )}
                                        {activeMessageId === msg.id && renderSystemContextMenu(msg)}
                                    </div>
                                ) : msg.isRetracted ? (
                                    <div
                                        onPointerDown={(e) => { e.stopPropagation(); handleMessagePointerDown(e, msg.id); }}
                                        onPointerUp={(e) => handleMessagePointerUp(e)}
                                        onPointerCancel={handleMessagePointerCancel}
                                        onPointerLeave={handleMessagePointerCancel}
                                        onPointerMove={(e) => {
                                            if (startPosRef.current) {
                                                const dx = Math.abs(e.clientX - startPosRef.current.x);
                                                const dy = Math.abs(e.clientY - startPosRef.current.y);
                                                if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                            }
                                        }}
                                        onContextMenu={(e) => { e.preventDefault(); openMessageContextMenu(msg.id, { x: e.clientX, y: e.clientY }); }}
                                        className="chat-sys-msg mx-auto relative cursor-pointer"
                                        {...(activeMessageId === msg.id ? { "data-active": "" } : {})}
                                    >
                                        {msg.role === "user" ? "你" : (character?.name || "对方")}撤回了一条消息
                                        {activeMessageId === msg.id && renderDeleteOnlyContextMenu(() => handleDeleteMessage(getStoredActionMessageId(msg)), () => startMultiSelectFromMessage(msg))}
                                    </div>
                                ) : (
                                    <>
                                        {msg.role !== "user" && !isEmptyBubble && (
                                            isSilentThought ? (
                                                /* Silent + inner monologue: no avatar, just heart */
                                                <div
                                                    onPointerDown={(e) => { e.stopPropagation(); handleMessagePointerDown(e, msg.id); }}
                                                    onPointerUp={(e) => handleMessagePointerUp(e)}
                                                    onPointerCancel={handleMessagePointerCancel}
                                                    onPointerLeave={handleMessagePointerCancel}
                                                    onPointerMove={(e) => {
                                                        if (startPosRef.current) {
                                                            const dx = Math.abs(e.clientX - startPosRef.current.x);
                                                            const dy = Math.abs(e.clientY - startPosRef.current.y);
                                                            if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                                        }
                                                    }}
                                                    onContextMenu={(e) => { e.preventDefault(); openMessageContextMenu(msg.id, { x: e.clientX, y: e.clientY }); }}
                                                    onClick={(e) => {
                                                        if (activeMessageId === msg.id) return;
                                                        e.stopPropagation();
                                                        setExpandedThinkingId(prev => prev === msg.id ? null : msg.id);
                                                    }}
                                                    className="chat-monologue-heart flex items-center justify-center shrink-0 w-[40px] h-[24px] relative cursor-pointer"
                                                    title={session.isGroup ? `${msg.senderName || "群成员"}的折叠状态` : "查看折叠状态"}
                                                    aria-label={session.isGroup ? `${msg.senderName || "群成员"}的折叠状态` : "查看折叠状态"}
                                                    {...(activeMessageId === msg.id ? { "data-active": "" } : {})}
                                                >
                                                    <span className="chat-monologue-heart ts-18 leading-none inline-block" {...(expandedMonologueId === msg.id ? { "data-active": "" } : {})}><svg viewBox="0 0 16 16" width="18" height="18" style={{display:"block"}}><path d="M8 14s-6-4-6-8c0-2.5 1.5-4 3.5-4 1 0 2 .5 2.5 1.5C8.5 2.5 9.5 2 10.5 2 12.5 2 14 3.5 14 6c0 4-6 8-6 8z" fill="currentColor"/></svg></span>
                                                    {activeMessageId === msg.id && renderDeleteOnlyContextMenu(() => handleDeleteMessage(getStoredActionMessageId(msg)), () => startMultiSelectFromMessage(msg))}
                                                </div>
                                            ) : (
                                                <div className="chat-msg-avatar flex flex-col items-center gap-1 shrink-0">
                                                    {(() => {
                                                        const senderChar = session.isGroup && msg.senderCharacterId
                                                            ? groupCharMap.get(msg.senderCharacterId) || character
                                                            : character;
                                                        return (
                                                            <>
                                                    <div onDoubleClick={() => {
                                                        const targetChar = session.isGroup && msg.senderCharacterId
                                                            ? groupCharMap.get(msg.senderCharacterId) || character
                                                            : character;
                                                        if (targetChar) sendRichMessage("poke", { pokeTarget: targetChar.name });
                                                    }} className="w-[40px] h-[40px] rounded-[20px] bg-[var(--c-input)] overflow-hidden cursor-pointer">
                                                        {senderChar?.avatar ? (
                                                            <img src={senderChar.avatar} className="w-full h-full object-cover" alt="" />
                                                        ) : (
                                                            <ChatFallbackAvatar />
                                                        )}
                                                    </div>
                                                            </>
                                                        );
                                                    })()}
                                                </div>
                                            )
                                        )}
                                        {!isSilentThought && !isEmptyBubble && <div
                                            className={`chat-msg-content-wrap flex flex-col min-w-0 max-w-[70%] ${isStandaloneHtmlPreview ? "chat-msg-content-wrap-html" : ""}`}
                                            {...(isStandaloneHtmlPreview ? { "data-html": "true" } : {})}
                                        >
                                            {session.isGroup && msg.role !== "user" && (
                                                <span className="chat-group-sender-name">{msg.senderName || ""}{renderGroupRoleBadge(msg.senderCharacterId)}</span>
                                            )}
                                            <div
                                            {...(editingMessageId !== msg.id ? {
                                                onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); handleMessagePointerDown(e, msg.id); },
                                                onPointerUp: (e: React.PointerEvent) => handleMessagePointerUp(e),
                                                onPointerCancel: handleMessagePointerCancel,
                                                onPointerLeave: handleMessagePointerCancel,
                                                onPointerMove: (e: React.PointerEvent) => {
                                                    if (startPosRef.current) {
                                                        const dx = Math.abs(e.clientX - startPosRef.current.x);
                                                        const dy = Math.abs(e.clientY - startPosRef.current.y);
                                                        if (dx > 10 || dy > 10) handleMessagePointerCancel();
                                                    }
                                                },
                                                onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); openMessageContextMenu(msg.id, { x: e.clientX, y: e.clientY }); },
                                            } : {})}
                                            className={`chat-bubble-role-${msg.role} ${isMediaBubble ? "chat-bubble-media" : ""} ${isStandaloneHtmlPreview ? "chat-bubble-html-preview" : ""} ${renderMsg.mediaType === "music_share" ? "chat-bubble-music-share" : ""} ${renderMsg.mediaType === "gift" || renderMsg.mediaType === "image" || isStandaloneHtmlPreview ? "rounded-none" : "rounded-md"} break-words relative cursor-pointer select-none`}
                                            style={isStandaloneHtmlPreview ? STANDALONE_CARD_BUBBLE_STYLE : undefined}
                                            data-ui={msg.role === "user" ? "bubble-user" : "bubble-bot"}
                                            data-msg-id={msg.id}
                                            {...(activeMessageId === msg.id ? { "data-active": "" } : {})}
                                            >
                                            {/* Message Actions Popup */}
                                            {activeMessageId === msg.id && renderBubbleContextMenu(msg)}

                                            <MessageBubble
                                                msg={renderMsg}
                                                displayContent={msg.displayProjected ? undefined : bubbleDisplayContent}
                                                charName={character?.name}
                                                userName={userIdentity?.name || "你"}
                                                groupSize={session.isGroup ? (session.participantIds?.length || 0) + (session.isSpectator ? 0 : 1) : undefined}
                                                onShowDetail={setMediaDetailMsg}
                                                characterId={msg.senderCharacterId || session.contactId}
                                                onUpdate={(updated) => setMessages(prev => prev.map(m => m.id === updated.id ? updated : m))}
                                                onSystemMessage={(text) => {
                                                    const sysMsg = pushChatMessage({
                                                        sessionId: session.id,
                                                        role: "system",
                                                        content: text,
                                                    });
                                                    setMessages(prev => [...prev, sysMsg]);
                                                }}
                                                onMusicPlay={handleMusicCardPlay}
                                                onActionSelect={(text) => chatTextInputRef.current?.appendText(text)}
                                                defaultTranslationExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                            />
                                        </div>
                                        </div>}
                                        {msg.role !== "user" && !isSilentThought && !isEmptyBubble && hasFoldedPanel && (
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setExpandedThinkingId(prev => prev === msg.id ? null : msg.id); }}
                                                className="chat-monologue-heart bg-none border-none cursor-pointer p-1 ts-14 leading-none self-end shrink-0 -ml-2"
                                                {...(expandedMonologueId === msg.id ? { "data-active": "" } : {})}
                                                title="查看折叠状态"
                                                aria-label="查看折叠状态"
                                            >
                                                <svg viewBox="0 0 16 16" width="14" height="14" style={{display:"block"}}>
                                                    <path d="M8 14s-6-4-6-8c0-2.5 1.5-4 3.5-4 1 0 2 .5 2.5 1.5C8.5 2.5 9.5 2 10.5 2 12.5 2 14 3.5 14 6c0 4-6 8-6 8z" fill="currentColor"/>
                                                </svg>
                                            </button>
                                        )}
                                        {msg.role === "user" && !isEmptyBubble && (
                                            <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-[var(--c-page-body-bg)] shrink-0 flex items-center justify-center overflow-hidden">
                                                {userIdentity?.avatarUrl ? (
                                                    <img src={userIdentity.avatarUrl} alt="Me" className="w-full h-full object-cover rounded-[20px]" />
                                                ) : (
                                                    <User size={20} color="var(--c-text)" />
                                                )}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                            {/* Voice message: text transcription bubble */}
                            {renderMsg.mediaType === "audio" && voiceTextIds.has(msg.id) && renderMsg.mediaData?.label && (
                                <div className={`chat-msg-wrapper`} data-role={uiRole(msg)} style={{ marginTop: -12 }}>
                                    {msg.role !== "user" && <div className="w-[40px] shrink-0" />}
                                    <div className="voice-msg-text-bubble">
                                        <BilingualTextBlock
                                            text={msg.displayProjected ? (renderMsg.mediaData?.label || "") : renderDisplayText(renderMsg.mediaData?.label || "", msg.role === "user" ? 1 : 2, false)}
                                            mode="markdown"
                                            defaultExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                        />
                                    </div>
                                    {msg.role === "user" && <div className="w-[40px] shrink-0" />}
                                </div>
                            )}
                            {/* 状态栏：一律裸渲染，不套便利贴外框（自定义模式下交给用户的渲染代码，
                                否则 [状态栏] 原文直接走 markdown/内联 HTML，让 AI 直出的卡片自己当外框）。
                                状态值跟内心独白走（留在便利贴里）；这轮没有内心独白时便利贴不出现，
                                数值裸放在状态栏上方。 */}
                            {hasFoldedPanel && expandedMonologueId === msg.id
                                && (renderMsg.statusPanel || (!renderMsg.innerMonologue && cardStateValues && cardStateValues.length > 0)) && (
                                <div className="chat-status-bare">
                                    {!renderMsg.innerMonologue && cardStateValues && cardStateValues.length > 0 && (
                                        <StateValuesPanel stateValues={cardStateValues} />
                                    )}
                                    {renderMsg.statusPanel && (
                                        msg.statusRegionMode === "custom" && statusRegionCfg.renderHtml.trim() ? (
                                            <CustomStatusFrame html={statusRegionCfg.renderHtml} raw={renderMsg.statusPanel} />
                                        ) : (
                                            <BilingualTextBlock text={msg.displayProjected ? renderMsg.statusPanel : renderDisplayText(renderMsg.statusPanel, 6, false)} mode="markdown" defaultExpanded={session.collapseBilingualTranslation !== false ? false : true} />
                                        )
                                    )}
                                </div>
                            )}
                            {/* Inner monologue card (sticky note / journal style) */}
                            {hasFoldedPanel && expandedMonologueId === msg.id && renderMsg.innerMonologue && (
                                <div className="chat-thought-card">
                                    {/* Decorative washi tape */}
                                    <div className="chat-thought-tape-left" />
                                    <div className="chat-thought-tape-right" />
                                    {/* Title */}
                                    <div className="chat-thought-title">
                                        💭 内心独白
                                    </div>
                                    {/* State values panel */}
                                    {cardStateValues && cardStateValues.length > 0 && (
                                        <StateValuesPanel stateValues={cardStateValues} />
                                    )}
                                    <div className="chat-thought-body">
                                        <BilingualTextBlock text={msg.displayProjected ? renderMsg.innerMonologue : renderDisplayText(renderMsg.innerMonologue, 6, false)} mode="markdown" defaultExpanded={session.collapseBilingualTranslation !== false ? false : true} />
                                    </div>
                                    {/* Signature */}
                                    <div className="chat-thought-sig">
                                        — {session.isGroup ? (msg.senderName || "群成员") : (character?.name || "TA")}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
                {/* 流式生成预览：生成中实时显示原文增量，结束后由正式消息替换 */}
                {!offlineMode && streamPreview && (
                    <div className="chat-stream-preview" data-ui="stream-preview">
                        {session.isGroup && streamPreview.parts && streamPreview.parts.length > 0 ? (
                            /* 按空行定型：写完的段落立即成为独立气泡（与最终拆条同规则），只有最后一段带光标打字 */
                            streamPreview.parts.map((part, i) => {
                                const senderChar = groupCharMap.get(part.characterId) || character;
                                const isLastPart = i === (streamPreview.parts?.length ?? 0) - 1;
                                return part.texts.map((segText, j) => {
                                    const isTyping = isLastPart && j === part.texts.length - 1;
                                    return (
                                        <div key={`stream-${part.characterId}-${i}-${j}`} className="chat-msg-wrapper" data-role="assistant">
                                            <div className="chat-msg-avatar flex flex-col items-center gap-1 shrink-0">
                                                <div className="w-[40px] h-[40px] rounded-[20px] bg-[var(--c-input)] overflow-hidden">
                                                    {senderChar?.avatar ? <img src={senderChar.avatar} className="w-full h-full object-cover" alt="" /> : <ChatFallbackAvatar />}
                                                </div>
                                            </div>
                                            <div className="chat-msg-content-wrap flex flex-col min-w-0 max-w-[70%]">
                                                <span className="chat-group-sender-name">{part.characterName}</span>
                                                <div className="chat-bubble-role-assistant chat-stream-bubble break-words rounded-md px-3 py-2">
                                                    {/* 流式预览用轻量 pre-wrap 渲染：避免每帧跑 markdown/双语解析导致闪烁卡顿 */}
                                                    <div className="chat-stream-text whitespace-pre-wrap break-words">{segText}</div>
                                                    {isTyping && <span className="chat-stream-cursor" aria-hidden="true" />}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                });
                            })
                        ) : streamPreview.texts && streamPreview.texts.length > 0 ? (
                            streamPreview.texts.map((segText, j) => {
                                const isTyping = j === (streamPreview.texts?.length ?? 0) - 1;
                                return (
                                    <div key={`stream-seg-${j}`} className="chat-msg-wrapper" data-role="assistant">
                                        <div className="chat-msg-avatar flex flex-col items-center gap-1 shrink-0">
                                            <div className="w-[40px] h-[40px] rounded-[20px] bg-[var(--c-input)] overflow-hidden">
                                                {character?.avatar ? <img src={character.avatar} className="w-full h-full object-cover" alt="" /> : <ChatFallbackAvatar />}
                                            </div>
                                        </div>
                                        <div className="chat-msg-content-wrap flex flex-col min-w-0 max-w-[70%]">
                                            <div className="chat-bubble-role-assistant chat-stream-bubble break-words rounded-md px-3 py-2">
                                                {/* 流式预览用轻量 pre-wrap 渲染：避免每帧跑 markdown/双语解析导致闪烁卡顿 */}
                                                <div className="chat-stream-text whitespace-pre-wrap break-words">{segText}</div>
                                                {isTyping && <span className="chat-stream-cursor" aria-hidden="true" />}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        ) : null}
                    </div>
                )}
                {/* Scroll anchor: browser keeps this in view when content above changes height */}
                <div style={{ overflowAnchor: 'auto', height: 1 }} />
            </div>

            {/* Input Bar — absolute at bottom, same layer as header */}
            {isMultiSelectMode && !offlineMode && (
                <div className="chat-multi-select-bar chat-room-main-pane" data-ui="multi-select">
                    <button
                        type="button"
                        className="chat-multi-select-icon-btn"
                        onClick={cancelMultiSelect}
                        aria-label="退出多选"
                        title="退出多选"
                    >
                        <X size={20} strokeWidth={1.8} />
                    </button>
                    <div className="chat-multi-select-summary">
                        <strong>已选 {selectedMessageIds.size} 条</strong>
                        <span>
                            {multiDeleteTargetIds.length > selectedMessageIds.size
                                ? `实际删除 ${multiDeleteTargetIds.length} 条，含隐藏历史`
                                : `实际删除 ${multiDeleteTargetIds.length} 条`}
                        </span>
                    </div>
                    <button
                        type="button"
                        className="chat-multi-select-delete-btn"
                        disabled={selectedMessageIds.size === 0 || multiDeleteTargetIds.length === 0}
                        onClick={confirmMultiDelete}
                    >
                        <Trash2 size={18} strokeWidth={1.8} />
                        删除
                    </button>
                </div>
            )}
            {!isMultiSelectMode && (offlineMode ? (
                <OfflineTextInputBar
                    key={session.id}
                    ref={offlineTextInputRef}
                    isOfflineGenerating={isOfflineGenerating}
                    isSpectator={!!session.isGroup && !!session.isSpectator}
                    showEmojiPanel={showEmojiPanel}
                    enterToSendEnabled={enterToSendEnabled}
                    onToggleOfflineMode={toggleOfflineMode}
                    onCloseEmojiPanel={() => setShowEmojiPanel(false)}
                    onToggleEmojiPanel={() => { setShowEmojiPanel(!showEmojiPanel); setShowStickerPanel(false); setShowPlusMenu(false); }}
                    onSendText={handleOfflineSend}
                    onStopGeneration={clearOfflineGeneration}
                />
            ) : (
            <ChatTextInputBar
                ref={chatTextInputRef}
                characterName={character?.name || "对方"}
                characterId={session.contactId}
                offlineMeetingActive={!session.isGroup && kvGet(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id) === "1"}
	                stickerCharacterIds={session.isGroup ? session.participantIds : undefined}
	                isGroup={!!session.isGroup}
	                isSpectator={!!session.isGroup && !!session.isSpectator}
	                muteUntilMs={session.isGroup && session.groupMutes?.[GROUP_SELF_KEY] ? new Date(session.groupMutes[GROUP_SELF_KEY]).getTime() : 0}
	                isGenerating={isGenerating}
	                theaterMode={theaterMode}
	                enterToSendEnabled={enterToSendEnabled}
	                quotingMessage={quotingMessage}
                showEmojiPanel={showEmojiPanel}
                showStickerPanel={showStickerPanel}
                showPlusMenu={showPlusMenu}
                customPlusActions={customPlusActions}
                onClearQuote={() => setQuotingMessage(null)}
                onToggleOfflineMode={toggleOfflineMode}
                onClosePanels={() => { setShowEmojiPanel(false); setShowStickerPanel(false); setShowPlusMenu(false); }}
	                onToggleEmojiPanel={() => { setShowEmojiPanel(!showEmojiPanel); setShowStickerPanel(false); setShowPlusMenu(false); }}
	                onToggleStickerPanel={() => { setShowStickerPanel(!showStickerPanel); setShowEmojiPanel(false); setShowPlusMenu(false); }}
	                onTogglePlusMenu={() => { setShowPlusMenu(!showPlusMenu); setShowEmojiPanel(false); setShowStickerPanel(false); }}
	                onToggleTheaterMode={toggleTheaterMode}
	                onCloseTheaterMode={closeTheaterMode}
	                onOpenRichModal={(modal) => { setShowPlusMenu(false); setRichModal(modal); }}
                onOpenCustomPlusAction={handleOpenCustomPlusAction}
                onStartVideoCall={() => { cancelFollowUp(session.id); setShowPlusMenu(false); setCallInitiator("user"); setShowVideoCall(true); }}
                onStartVoiceCall={() => { cancelFollowUp(session.id); setShowPlusMenu(false); setCallInitiator("user"); setShowVoiceCall(true); }}
                onSendText={handleSendText}
                onStopGeneration={clearStuckGeneration}
                onTriggerAIResponse={triggerAIResponse}
                onSendSticker={(name, url) => { setShowStickerPanel(false); sendRichMessage("sticker", { label: name, stickerUrl: url }); }}
            />
            ))}

            {showConfirmMultiDelete && (() => {
                const targetIds = new Set(multiDeleteTargetIds);
                const storedMessages = loadChatMessages(session.id);
                const targetMessages = storedMessages.filter(m => targetIds.has(m.id));
                const survivingMessages = storedMessages.filter(m => !targetIds.has(m.id));
                const currentInvite = activeOfflineInviteRef.current;
                const targetHasInviteRelated = targetMessages.some(m =>
                    isOfflineInviteRootMessage(m) ||
                    isOfflineInviteSystemMessage(m) ||
                    m.mediaType === "offline_invite" ||
                    m.mediaType === "offline_invite_change_place" ||
                    m.mediaType === "offline_invite_early_arrive" ||
                    m.mediaType === "offline_invite_arrive_notice" ||
                    Boolean(m.mediaData?.offlineInvite)
                );
                const targetHasLockOrUnlock = targetMessages.some(m => isOfflineLockNoticeMessage(m) || isOfflineUnlockNoticeMessage(m));
                const count = multiDeleteTargetIds.length;

                let title = "删除选中消息？";
                let message = count > selectedMessageIds.size
                    ? `将删除已选消息，并一并删除相邻已选消息之间的隐藏历史。实际删除 ${count} 条，删除后无法恢复。`
                    : `将删除已选的 ${count} 条消息，删除后无法恢复。`;

                if (currentInvite && targetHasInviteRelated) {
                    const nextInvite = restoreOfflineInviteFromMessages(survivingMessages, currentInvite);
                    title = "删除所选消息？";
                    if (!nextInvite) {
                        message = `删除的 ${count} 条消息中包含本次线下赴约的发起或有效记录，删除后将直接清除当前的赴约状态。若只想回退赴约状态，可取消并尝试删除其他。`;
                    } else {
                        message = `删除的 ${count} 条消息中包含本次线下赴约的变动记录，删除后赴约状态将同步回溯。是否确认删除？`;
                    }
                } else if (targetHasLockOrUnlock) {
                    title = "删除所选消息？";
                    message = "删除的内容中包含角色的线下封禁记录/心墙变更记录/解封记录，删除将可能导致线下入口状态变更。若只想回退状态，可取消并重试消息。是否确认删除？";
                }

                return (
                    <ConfirmDialog
                        title={title}
                        dialogClassName="[&_p]:whitespace-pre-line"
                        message={message}
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="删除"
                        cancelLabel="取消"
                        onConfirm={handleMultiDeleteConfirmed}
                        onCancel={() => setShowConfirmMultiDelete(false)}
                    />
                );
            })()}

            {pendingInviteDeleteConfirm && (
                <div
                    className="modal-overlay"
                    data-ui="modal"
                    onClick={() => setPendingInviteDeleteConfirm(null)}
                >
                    <div
                        className="modal-dialog relative"
                        data-ui="modal-dialog"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-header" data-ui="modal-header">
                            {pendingInviteDeleteConfirm.variant === "danger" && (
                                <div className="ui-icon-circle" data-variant="danger">
                                    <AlertCircle size={20} />
                                </div>
                            )}
                            <h3 className="modal-title">{pendingInviteDeleteConfirm.title}</h3>
                        </div>
                        <div className="modal-body text-center" data-ui="modal-body">
                            <p className="leading-relaxed whitespace-pre-line text-[14px]">
                                {pendingInviteDeleteConfirm.message}
                            </p>
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            {!pendingInviteDeleteConfirm.hideCancel && (
                                <button
                                    type="button"
                                    className="ui-btn"
                                    onClick={() => setPendingInviteDeleteConfirm(null)}
                                >
                                    {pendingInviteDeleteConfirm.cancelLabel || "取消"}
                                </button>
                            )}
                            <button
                                type="button"
                                className={`ui-btn ${
                                    pendingInviteDeleteConfirm.hideCancel
                                        ? "w-full ui-btn-primary"
                                        : pendingInviteDeleteConfirm.variant === "danger"
                                        ? "ui-btn-danger"
                                        : "ui-btn-primary"
                                }`}
                                onClick={() => {
                                    const act = pendingInviteDeleteConfirm.onConfirm;
                                    setPendingInviteDeleteConfirm(null);
                                    if (act) act();
                                }}
                            >
                                {pendingInviteDeleteConfirm.confirmLabel || "删除"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showConfirmExitOfflineInvite && (
                <div
                    className="modal-overlay"
                    data-ui="modal"
                    onClick={() => setShowConfirmExitOfflineInvite(false)}
                >
                    <div
                        className="modal-dialog relative"
                        data-ui="modal-dialog"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            type="button"
                            className="absolute top-3.5 right-3.5 w-7 h-7 rounded-full flex items-center justify-center bg-[var(--c-input,rgba(0,0,0,0.06))] hover:bg-[var(--c-input-border,rgba(0,0,0,0.12))] text-[var(--c-icon,#9ca3af)] hover:text-[var(--c-text-title,#111827)] transition-all cursor-pointer active:scale-90 shadow-xs"
                            onClick={() => setShowConfirmExitOfflineInvite(false)}
                            title="继续留在现场"
                            aria-label="继续留在现场"
                        >
                            <X size={16} />
                        </button>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">结束线下赴约？</h3>
                        </div>
                        <div className="modal-body text-center" data-ui="modal-body">
                            <p className="leading-relaxed">你可以选择暂时切回线上查阅消息，也可以正式结束本次线下赴约回到线上。</p>
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            <button
                                type="button"
                                className="ui-btn"
                                onClick={() => {
                                    setShowConfirmExitOfflineInvite(false);
                                    // 暂时离开：返回线上，保留赴约状态，不发结束系统消息，不触发主动发信
                                    doToggleOfflineMode(false);
                                }}
                            >
                                暂时离开
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-primary"
                                onClick={() => {
                                    setShowConfirmExitOfflineInvite(false);
                                    kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                                    kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                                    kvRemove(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id);
                                    updateActiveOfflineInvite(null);
                                    // 结束闭环：结束线下赴约回到线上时，在聊天流中留下系统结束记录
                                    const sysEndMsg = pushChatMessage({
                                        sessionId: session.id,
                                        role: "system",
                                        content: "本次线下赴约已结束，双方已返回线上",
                                        mediaType: "offline_invite_system_notice",
                                    });
                                    setMessages(prev => [...prev, sysEndMsg]);
                                    doToggleOfflineMode(true);
                                }}
                            >
                                结束赴约
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {offlineRetryConfirm && (
                <div
                    className="modal-overlay"
                    data-ui="modal"
                    onClick={() => setOfflineRetryConfirm(null)}
                >
                    <div
                        className="modal-dialog relative !max-w-[340px] !w-[90%]"
                        data-ui="modal-dialog"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-header" data-ui="modal-header">
                            <div className="ui-icon-circle" data-variant="danger">
                                <AlertCircle size={20} />
                            </div>
                            <h3 className="modal-title">线下赴约回溯确认</h3>
                        </div>

                        <div className="modal-body text-center" data-ui="modal-body">
                            <p className="leading-relaxed text-[13.5px] text-[var(--c-text,#4b5563)]">
                                当前正与{character?.name || "对方"}线下碰面中。重试该消息将删除后续记录并结束本次碰面，时间线将回溯至当时。是否确认重试？
                            </p>
                        </div>

                        {/* 左右结构：左取消，右回溯并结束线下（单行舒展不折行） */}
                        <div className="modal-footer !flex-row !gap-2.5 !w-full" data-ui="modal-footer">
                            <button
                                type="button"
                                className="ui-btn !flex-1 whitespace-nowrap cursor-pointer select-none text-[13px]"
                                onClick={() => setOfflineRetryConfirm(null)}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-danger !flex-1 whitespace-nowrap cursor-pointer select-none text-[12.5px] !px-2"
                                onClick={() => void handleExecuteOfflineRetryMode()}
                            >
                                回溯并结束线下
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Settings Panel — portaled outside session-scoped CSS, preserves chat room mount */}
            {showSettings && wrapperRef.current?.parentElement && createPortal(
                <div className="chat-settings-layer absolute inset-0 z-50">
                    <ChatSettingsPanel
                        session={session}
                        onClose={() => {
                            setShowSettings(false);
                            // Reload messages in case history was cleared
                            syncMessagesFromStorage();
                        }}
                        onJumpToMessage={(messageId) => {
                            setShowSettings(false);
                            jumpToStoredMessage(messageId);
                        }}
                        onHistoryCleared={() => {
                            updateActiveOfflineInvite(null);
                            setIsOfflineInviteMinimized(false);
                            if (remindExpandTimerRef.current) {
                                clearTimeout(remindExpandTimerRef.current);
                                remindExpandTimerRef.current = null;
                            }
                            kvRemove(OFFLINE_INVITE_ACTIVE_SESSION_PREFIX + session.id);
                            kvRemove(PENDING_OFFLINE_INVITE_DECLINE_PREFIX + session.id);
                            kvRemove(OFFLINE_INVITE_DECLINE_COUNT_PREFIX + session.id);
                            syncMessagesFromStorage();
                            showChatToast("已清空聊天记录与赴约状态");
                        }}
                        onToolHistoryCleared={syncMessagesFromStorage}
                        offlineHistoryBusy={isOfflineGenerating}
                        onOfflineHistoryCleared={() => {
                            setOfflineTurns([]);
                            setOfflineVisibleCount(OFFLINE_INITIAL_LOAD);
                            setPendingOfflineUserText("");
                            offlineGenerationInputRef.current = "";
                            setActiveOfflineTarget(null);
                            setContextMenuAnchor(null);
                            setEditingOfflineTarget(null);
                            setEditingOfflineContent("");
                            showChatToast("已清空线下聊天记录");
                        }}
                        onDeleteFriend={() => onBack()}
                        onSessionDeleted={() => {
                            setShowSettings(false);
                            (onDeleted ?? onBack)();
                        }}
                    />
                </div>,
                wrapperRef.current.parentElement
            )}

            {activeCustomChatPlus && activeCustomChatPlus.presentation === "none" && (
                <div className="chat-custom-app-headless" aria-hidden="true">
                    <CustomAppRunner
                        app={activeCustomChatPlus.app}
                        launchContext={activeCustomChatPlus.launchContext}
                        embedded
                        onClose={() => setActiveCustomChatPlus(null)}
                        onNotice={showChatToast}
                    />
                </div>
            )}

            {activeCustomChatPlus && activeCustomChatPlus.presentation !== "none" && (
                <div
                    className={`chat-custom-app-layer is-${activeCustomChatPlus.presentation}`}
                    role="presentation"
                    onClick={() => setActiveCustomChatPlus(null)}
                >
                    <div
                        className="chat-custom-app-shell"
                        role="dialog"
                        aria-modal="true"
                        aria-label={activeCustomChatPlus.action.label}
                        style={{
                            "--chat-custom-app-panel-height": normalizeCustomPanelHeight(activeCustomChatPlus.action.panelHeight) ?? undefined,
                        } as React.CSSProperties}
                        onClick={event => event.stopPropagation()}
                    >
                        <div className="chat-custom-app-head">
                            <div className="chat-custom-app-title">
                                <span className="chat-custom-app-icon" aria-hidden="true">
                                    {activeCustomChatPlus.app.iconDataUrl ? <img src={activeCustomChatPlus.app.iconDataUrl} alt="" /> : <Blocks size={18} />}
                                </span>
                                <span>{activeCustomChatPlus.action.label}</span>
                            </div>
                            <button
                                type="button"
                                className="chat-custom-app-close"
                                onClick={() => setActiveCustomChatPlus(null)}
                                aria-label="关闭"
                            >
                                <X size={18} strokeWidth={2} />
                            </button>
                        </div>
                        <div className="chat-custom-app-body">
                            <CustomAppForegroundBoundary
                                key={activeCustomChatPlus.app.id}
                                appName={activeCustomChatPlus.app.name}
                                appId={activeCustomChatPlus.app.id}
                                appVersion={activeCustomChatPlus.app.version}
                                manifestId={activeCustomChatPlus.app.manifest?.id}
                                closeLabel="返回聊天"
                                onClose={() => setActiveCustomChatPlus(null)}
                            >
                                <CustomAppRunner
                                    app={activeCustomChatPlus.app}
                                    launchContext={activeCustomChatPlus.launchContext}
                                    embedded
                                    onClose={() => setActiveCustomChatPlus(null)}
                                    onNotice={showChatToast}
                                />
                            </CustomAppForegroundBoundary>
                        </div>
                    </div>
                </div>
            )}

            {/* Rich Media Input Modals */}
            {richModal === "voice_msg" && (
                <VoiceRecordModal
                    characterId={session.contactId}
                    onSend={(text, audioDataUrl) => {
                        setRichModal(null);
                        sendRichMessage("audio", { label: text }, "", audioDataUrl);
                    }}
                    onClose={() => setRichModal(null)}
                />
            )}
            {richModal === "text_photo" && (
                <TextPhotoModal
                    onSend={(text) => { setRichModal(null); sendRichMessage("image", { label: text }); }}
                    onClose={() => setRichModal(null)}
                />
            )}
            {richModal === "photo" && (
                <PhotoInputModal
                    onSend={(desc, imageDataUrl) => { setRichModal(null); sendRichMessage("image", { label: desc }, "", imageDataUrl); }}
                    onClose={() => setRichModal(null)}
                />
            )}
            {richModal === "gift" && (
                <GiftPickerModal
                    gifts={availableShoppingGifts}
                    isGroup={session.isGroup}
                    recipients={groupCharacters}
                    onSend={(gift, recipient) => {
                        const sent = sendShoppingGiftMessage(gift, recipient);
                        if (sent) setRichModal(null);
                    }}
                    onClose={() => setRichModal(null)}
                />
            )}
            {richModal === "red_packet" && (
                <RedPacketModal
                    mode="red_packet"
                    isGroup={session.isGroup}
                    onSend={(amount, label, count) => {
                        const sent = sendRichMessage("red_packet", { amount, label, status: "pending", count: count || 1 });
                        if (sent) setRichModal(null);
                    }}
                    onClose={() => setRichModal(null)}
                />
            )}
            {richModal === "transfer_target" && session.isGroup && (
                <TransferTargetModal
                    participants={groupCharacters}
                    onSelect={(char) => {
                        setTransferTarget(char);
                        setRichModal("transfer");
                    }}
                    onClose={() => setRichModal(null)}
                />
            )}
            {richModal === "transfer" && (
                <RedPacketModal
                    mode="transfer"
                    onSend={(amount, label) => {
                        if (session.isGroup && transferTarget) {
                            const sent = sendRichMessage("transfer", {
                                amount, label, status: "pending",
                                senderName: userIdentity?.name || "你",
                                recipientId: transferTarget.id,
                                recipientName: transferTarget.name,
                            });
                            if (sent) {
                                setRichModal(null);
                                setTransferTarget(null);
                            }
                        } else {
                            const sent = sendRichMessage("transfer", { amount, label, status: "pending" });
                            if (sent) setRichModal(null);
                        }
                    }}
                    onClose={() => { setRichModal(null); setTransferTarget(null); }}
                />
            )}
            {richModal === "location" && (
                <LocationInputModal
                    onSend={(loc) => { setRichModal(null); sendRichMessage("location", { label: loc }); }}
                    onClose={() => setRichModal(null)}
                />
            )}
            {richModal === "system_instruction" && (
                <SystemInstructionModal
                    onSend={(text) => {
                        const sent = sendSystemInstruction(text);
                        if (sent) setRichModal(null);
                    }}
                    onClose={() => setRichModal(null)}
                />
            )}

            {/* 思维链底部弹窗（Claude app 风格） */}
            {reasoningSheetText !== null && (
                <div
                    className="modal-overlay modal-overlay-bottom"
                    data-ui="modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label="思考过程"
                    onClick={() => setReasoningSheetText(null)}
                >
                    <div className="modal-sheet chat-reasoning-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="chat-reasoning-sheet-handle" />
                        <div className="chat-reasoning-sheet-header">
                            <button
                                type="button"
                                className="chat-reasoning-sheet-close"
                                onClick={handleTranslateReasoning}
                                aria-label={reasoningTranslation ? "隐藏译文" : "翻译思考过程"}
                                title={reasoningTranslation ? "隐藏译文" : "翻译思考过程"}
                            >
                                {reasoningTranslating
                                    ? <Loader2 size={18} strokeWidth={2} className="animate-spin" />
                                    : <Languages size={18} strokeWidth={2} {...(reasoningTranslation ? { color: "var(--c-icon-active)" } : {})} />}
                            </button>
                            <span className="chat-reasoning-sheet-title">思考过程</span>
                            <button
                                type="button"
                                className="chat-reasoning-sheet-close"
                                onClick={() => setReasoningSheetText(null)}
                                aria-label="关闭"
                            >
                                <X size={18} strokeWidth={2} />
                            </button>
                        </div>
                        <div className="chat-reasoning-sheet-body">
                            {reasoningTranslateError && (
                                <div className="chat-reasoning-translate-error">{reasoningTranslateError}</div>
                            )}
                            {reasoningTranslation && (
                                <div className="chat-reasoning-view-switch">
                                    {([["zh", "中文"], ["orig", "原文"], ["both", "对照"]] as const).map(([mode, text]) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            className="chat-reasoning-view-btn"
                                            {...(reasoningViewMode === mode ? { "data-active": "" } : {})}
                                            onClick={() => setReasoningViewMode(mode)}
                                        >{text}</button>
                                    ))}
                                </div>
                            )}
                            {reasoningTranslation && reasoningViewMode !== "orig" && (
                                <div className={reasoningViewMode === "both" ? "chat-reasoning-translation" : undefined}>
                                    <BilingualTextBlock text={reasoningTranslation} mode="markdown" defaultExpanded />
                                </div>
                            )}
                            {(reasoningViewMode !== "zh" || !reasoningTranslation) && (
                                <BilingualTextBlock text={reasoningSheetText} mode="markdown" defaultExpanded />
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Red Packet / Transfer Detail Modal */}
            {mediaDetailMsg && (
                <MediaDetailModal
                    msg={mediaDetailMsg}
                    userName={userIdentity?.name || "你"}
                    groupSize={session.isGroup ? (session.participantIds?.length || 0) + (session.isSpectator ? 0 : 1) : undefined}
                    onAccept={(updatedMsg, sysText, actionType) => {
                        const walletUpdatedMsg = updatedMsg.role === "assistant"
                            ? creditIncomingMoneyMessage(updatedMsg, actionType)
                            : updatedMsg;
                        setMessages(prev => prev.map(m => m.id === walletUpdatedMsg.id ? walletUpdatedMsg : m));
                        setMediaDetailMsg(null);
                        const claimerN = userIdentity?.name || "你";
                        const ownerN = walletUpdatedMsg.senderName || (walletUpdatedMsg.role === "assistant" ? (character?.name || "对方") : claimerN);
                        const sysMsg = pushChatMessage({
                            sessionId: session.id, role: "user", content: sysText,
                            mediaType: actionType as ChatMessage["mediaType"],
                            ...(session.isGroup ? { mediaData: { claimer: claimerN, owner: ownerN }, senderName: claimerN } : {}),
                        });
                        setMessages(prev => [...prev, sysMsg]);
                    }}
                    onClose={() => setMediaDetailMsg(null)}
                />
            )}

            {editingOfflineTarget && (
                <div className="chat-html-overlay" onClick={() => { setEditingOfflineTarget(null); setEditingOfflineContent(""); }}>
                    <div
                        className="g-card w-[min(84vw,420px)] max-h-[78vh] p-4 flex flex-col gap-3"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex flex-col gap-1">
                                <span className="menu-label">
                                    {editingOfflineTarget.role === "user" ? "编辑线下输入" : "编辑线下回复"}
                                </span>
                                <span className="menu-desc !mt-0">
                                    {editingOfflineTarget.role === "user"
                                        ? "保存后会更新这一轮线下历史"
                                        : "保存后会重新解析 content 和摘要，并更新短期记忆事件流"}
                                </span>
                            </div>
                            <button
                                onClick={() => { setEditingOfflineTarget(null); setEditingOfflineContent(""); }}
                                className="ui-bare-btn text-[var(--c-icon)] ts-18 leading-none"
                                type="button"
                            >✕</button>
                        </div>
                        <textarea
                            autoFocus
                            value={editingOfflineContent}
                            onChange={(e) => setEditingOfflineContent(e.target.value)}
                            className="w-full min-h-[220px] max-h-[52vh] resize-none rounded-2xl border border-[var(--c-border)] bg-[var(--c-input)] px-4 py-3 ts-14 text-[var(--c-text)] outline-none"
                        />
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => { setEditingOfflineTarget(null); setEditingOfflineContent(""); }}
                                className="ui-btn ui-btn-outline"
                                type="button"
                            >取消</button>
                            <button
                                onClick={handleOfflineEditSave}
                                disabled={!editingOfflineContent.trim()}
                                className="ui-btn ui-btn-primary"
                                type="button"
                            >保存</button>
                        </div>
                    </div>
                </div>
            )}

            {editingMessageId && (
                <div className="chat-html-overlay" onClick={() => { setEditingMessageId(null); setEditingContent(""); }}>
                    <div
                        className="g-card w-[min(84vw,420px)] max-h-[78vh] p-4 flex flex-col gap-3"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex flex-col gap-1">
                                <span className="menu-label">{editingSystemInstruction ? "编辑系统指令" : "编辑消息"}</span>
                                <span className="menu-desc !mt-0">{editingSystemInstruction ? "保存后会按当前位置更新后续上下文" : "保存后会同步更新聊天记录和后续上下文"}</span>
                            </div>
                            <button
                                onClick={() => { setEditingMessageId(null); setEditingContent(""); }}
                                className="ui-bare-btn text-[var(--c-icon)] ts-18 leading-none"
                                type="button"
                            >✕</button>
                        </div>
                        <textarea
                            autoFocus
                            value={editingContent}
                            onChange={(e) => setEditingContent(e.target.value)}
                            className="w-full min-h-[180px] max-h-[52vh] resize-none rounded-2xl border border-[var(--c-border)] bg-[var(--c-input)] px-4 py-3 ts-14 text-[var(--c-text)] outline-none"
                        />
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => { setEditingMessageId(null); setEditingContent(""); }}
                                className="ui-btn ui-btn-outline"
                                type="button"
                            >取消</button>
                            <button
                                onClick={handleEditMessageSave}
                                disabled={!editingContent.trim()}
                                className="ui-btn ui-btn-primary"
                                type="button"
                            >保存</button>
                        </div>
                    </div>
                </div>
            )}

            {(editingResponseBatchId || editingResponseRoundId) && (
                <div className="chat-html-overlay" onClick={() => { setEditingResponseBatchId(null); setEditingResponseRoundId(null); setEditingResponseContent(""); }}>
                    <div
                        className="g-card w-[min(84vw,420px)] max-h-[78vh] p-4 flex flex-col gap-3"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex flex-col gap-1">
                                <span className="menu-label">编辑本次回复</span>
                                <span className="menu-desc !mt-0">保存后会按新的编辑文本重新拆分这次 AI 回复</span>
                            </div>
                            <button
                                onClick={() => { setEditingResponseBatchId(null); setEditingResponseRoundId(null); setEditingResponseContent(""); }}
                                className="ui-bare-btn text-[var(--c-icon)] ts-18 leading-none"
                                type="button"
                            >✕</button>
                        </div>
                        <textarea
                            autoFocus
                            value={editingResponseContent}
                            onChange={(e) => setEditingResponseContent(e.target.value)}
                            className="w-full min-h-[220px] max-h-[52vh] resize-none rounded-2xl border border-[var(--c-border)] bg-[var(--c-input)] px-4 py-3 ts-14 text-[var(--c-text)] outline-none"
                        />
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => { setEditingResponseBatchId(null); setEditingResponseRoundId(null); setEditingResponseContent(""); }}
                                className="ui-btn ui-btn-outline"
                                type="button"
                            >取消</button>
                            <button
                                onClick={handleEditResponseSave}
                                disabled={!editingResponseContent.trim()}
                                className="ui-btn ui-btn-primary"
                                type="button"
                            >保存</button>
                        </div>
                    </div>
                </div>
            )}

            {cloudDeletePending && (
                <div className="modal-overlay" data-ui="modal" role="alertdialog" aria-modal="true" aria-label="正在删除云端记录">
                    <div className="modal-dialog" data-ui="modal-dialog" onClick={(e) => e.stopPropagation()}>
                        <Loader2 size={30} className="animate-spin text-[var(--c-accent)]" />
                        <div className="flex flex-col items-center gap-2 text-center">
                            <h3 className="modal-title">正在删除云端记录</h3>
                            <p className="menu-desc !mt-0">
                                正在删除 {cloudDeletePending.count} 条微信云端记录，请不要关闭页面。
                            </p>
                            <p className="menu-desc !mt-0">
                                超过 {Math.round(WEIXIN_CLOUD_DELETE_TIMEOUT_MS / 1000)} 秒未完成会自动判定失败。
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {imageGenerationFailure && (
                <GeneratedImageErrorDialog
                    message={imageGenerationFailure}
                    onClose={() => setImageGenerationFailure(null)}
                />
            )}

            {activeOfflineInvite && !isOfflineInviteMinimized && !offlineMode && (
                <OfflineInviteModal
                    invite={activeOfflineInvite}
                    character={character}
                    onAccept={handleAcceptOfflineInvite}
                    onDecline={handleDeclineOfflineInvite}
                    onMinimize={handleMinimizeOfflineInvite}
                    onEarlyArrive={handleEarlyArriveOfflineInvite}
                />
            )}

            {/* 线下封禁弹窗：角色拒绝线下见面时弹出（双按钮系统级弹窗） */}
            {showOfflineLockPopup && offlineLockData && (
                <div
                    className="modal-overlay"
                    data-ui="modal"
                    onClick={handleCloseOfflineLockPopup}
                >
                    <div
                        className="modal-dialog offline-lock-dialog"
                        data-ui="modal-dialog"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="offline-lock-icon-group">
                            <div
                                className="offline-lock-icon-wrap cursor-pointer active:scale-95 transition-transform"
                                onClick={handleTapLockIcon}
                                title="轻敲锁扣"
                                aria-label="轻敲锁扣"
                            >
                                <Lock size={22} strokeWidth={1.8} />
                            </div>
                            {/* 轻敲锁显现小圆点托底（持续2秒后隐藏） */}
                            <div
                                className={`offline-lock-dots-container ${showLockDotsHint ? "opacity-100 scale-100" : "opacity-0 scale-95 pointer-events-none"}`}
                                aria-hidden="true"
                            >
                                {Array.from({ length: Math.min(7, Math.max(1, offlineLockData.requiredKnocks || 3)) }).map((_, idx) => {
                                    const isFilled = idx < (offlineLockData.knockCount || 0);
                                    return (
                                        <span
                                            key={idx}
                                            className={`offline-lock-dot ${isFilled ? "filled" : "empty"}`}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">
                                {character?.name || "对方"}拒绝与你线下见面
                            </h3>
                        </div>
                        <div className="modal-body text-center" data-ui="modal-body">
                            <p className="offline-lock-dialog-desc leading-relaxed">
                                对方因情绪抗拒，暂时关闭了线下入口。你可以继续在线上沟通化解，或再次发起线下申请。
                            </p>
                        </div>
                        <div className="modal-footer offline-lock-dialog-footer" data-ui="modal-footer">
                            <button
                                type="button"
                                className="ui-btn offline-lock-btn-cancel"
                                onClick={handleCloseOfflineLockPopup}
                            >
                                我知道了
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-primary offline-lock-btn-reapply"
                                disabled={isReapplyingLock}
                                onClick={handleReapplyOfflineLock}
                            >
                                再次申请
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 独立申请中弹窗（持续1500ms） */}
            {showOfflineApplyingPopup && (
                <div
                    className="modal-overlay"
                    data-ui="modal"
                >
                    <div
                        className="modal-dialog offline-applying-dialog"
                        data-ui="modal-dialog"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="offline-lock-icon-wrap offline-applying-pulse" aria-hidden="true">
                            <Lock size={22} strokeWidth={1.8} />
                        </div>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title offline-applying-title">
                                正在发起线下申请<span className="offline-applying-dots"><span>.</span><span>.</span><span>.</span></span>
                            </h3>
                        </div>
                    </div>
                </div>
            )}

            {/* 角色解除线下封禁后的前往线下确认弹窗 */}
            {showOfflineUnlockedConfirmModal && (
                <div
                    className="modal-overlay"
                    data-ui="modal"
                    onClick={() => setShowOfflineUnlockedConfirmModal(false)}
                >
                    <div
                        className="modal-dialog offline-lock-dialog"
                        data-ui="modal-dialog"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="offline-lock-icon-group">
                            <div
                                className="offline-lock-icon-wrap"
                                aria-hidden="true"
                            >
                                <Unlock size={22} strokeWidth={1.8} />
                            </div>
                        </div>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">
                                {character?.name || "对方"}已解除线下封禁
                            </h3>
                        </div>
                        <div className="modal-body text-center" data-ui="modal-body">
                            <p className="offline-lock-dialog-desc leading-relaxed">
                                对方情绪已有所平复，重新对你开放了线下入口。是否现在前往线下见Ta？
                            </p>
                        </div>
                        <div className="modal-footer offline-lock-dialog-footer" data-ui="modal-footer">
                            <button
                                type="button"
                                className="ui-btn offline-lock-btn-cancel"
                                onClick={() => setShowOfflineUnlockedConfirmModal(false)}
                            >
                                留在线上
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-primary offline-lock-btn-reapply"
                                onClick={() => {
                                    kvRemove(OFFLINE_LOCK_PENDING_VISIT_PREFIX + session.id);
                                    setShowOfflineUnlockedConfirmModal(false);
                                    doToggleOfflineMode(false);
                                    if (session.offlineLockAutoFirstSpeech !== false) {
                                        window.setTimeout(() => {
                                            void handleOfflineSend("", {
                                                isInitiative: true,
                                                initiativePrompt: session.offlineLockMeetingPrompt?.trim() || "【剧情事件·线下碰面开场】你此前在微信上因情绪抗拒关闭了线下入口，如今心结有所缓和并解除了封禁，现在你与对方已正式来到线下见面，请根据你的性格与当前真实心境（傲娇/心疼/别扭但松了口气/关切/……），主动开启线下界面的第一句对话与肢体神态动作。",
                                            });
                                        }, 600);
                                    }
                                }}
                            >
                                确认前往
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Chat toast notification (overlay, does not affect layout) */}
            {chatToast && (
                <div className="chat-toast-overlay">
                    <div className="wp-toast chat-toast-floating">
                        {chatToast === "加载音乐中..." ? (
                            <span className="ui-loading-toast-content">
                                <span className="ui-loading-spinner" />
                                <span>{chatToast}</span>
                            </span>
                        ) : chatToast}
                    </div>
                </div>
            )}

            {/* 单聊语音/视频通话：内联挂载（而非提前 return），使缩小为悬浮窗时通话组件
                不被卸载，计时/字幕等状态得以保留；组件内部依据 minimized 决定渲染
                全屏界面还是左侧悬浮窗 */}
            {showVoiceCall && character && (
                <VoiceCallScreen
                    session={session}
                    character={character}
                    initiator={callInitiator}
                    minimized={callMinimized}
                    onMinimize={() => setCallMinimized(true)}
                    onRestore={() => setCallMinimized(false)}
                    onEnd={() => returnFromCall(() => setShowVoiceCall(false))}
                />
            )}
            {showVideoCall && character && (
                <VideoCallScreen
                    session={session}
                    character={character}
                    initiator={callInitiator}
                    minimized={callMinimized}
                    onMinimize={() => setCallMinimized(true)}
                    onRestore={() => setCallMinimized(false)}
                    onEnd={() => returnFromCall(() => setShowVideoCall(false))}
                />
            )}

        </div >
    );
}
