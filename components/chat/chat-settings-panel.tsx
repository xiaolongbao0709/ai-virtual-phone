"use client";

import { useRef, useState, type CSSProperties } from "react";
import {
    CHAT_INITIAL_VISIBLE_MESSAGE_COUNT,
    CHAT_LOAD_MORE_MESSAGE_COUNT,
    ChatSession,
    clearChatSessionMessages,
    clearChatSessionToolHistory,
    saveChatSessions,
    loadChatSessions,
    loadChatMessages,
    loadChatContacts,
    getChatMessagePreview,
    pushChatMessage,
    removeChatContact,
    normalizeVisionImagePromptLimit,
    MAX_VISION_IMAGE_PROMPT_LIMIT,
    type ChatMessage,
} from "@/lib/chat-storage";
import {
    GROUP_SELF_KEY,
    applyGroupAdminAction,
    buildGroupAdminNoticeText,
    canGroupAdminAct,
    formatMuteDurationLabel,
    formatMuteRemainingLabel,
    getGroupMemberDisplayName,
    getGroupMuteRemainingMs,
    getGroupOwnerKey,
    getGroupRole,
    pruneExpiredGroupMutes,
    type GroupAdminAction,
} from "@/lib/group-admin";
import { clearChatOfflineTurns } from "@/lib/chat-offline-storage";
import { triggerDeleteFriendReaction } from "@/lib/friend-request-engine";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { ChevronRight, Image as ImageIcon, Video, Mic, UserMinus, UserPlus, Users, Pin, MessageSquare, Search, AlertCircle, Code, Trash2, Smile, Sparkles, type LucideIcon } from "lucide-react";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { ConfirmDialog } from "@/components/ui/modal";
import { CHAT_SESSION_CSS_EXAMPLE } from "@/lib/css-examples";
import { Toggle, Input } from "@/components/ui/form";
import { PageShell } from "@/components/ui/page-shell";
import {
    DEFAULT_CHAT_BILINGUAL_PROMPT,
    DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT,
    DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT,
    DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT,
} from "@/lib/bilingual-prompt-defaults";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import { MessageBubble, isStandaloneHtmlPreviewContent } from "./message-bubble";
import { ScreenEffectSettingsModal } from "./screen-effect-settings-modal";

type ChatSettingsPanelProps = {
    session: ChatSession;
    onClose: () => void;
    onJumpToMessage?: (messageId: string) => void;
    onDeleteFriend?: () => void;
    onToolHistoryCleared?: () => void;
    onOfflineHistoryCleared?: () => void;
    offlineHistoryBusy?: boolean;
};

const chatInfoIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

type SearchResultRole = "user" | "assistant" | "system";
type SearchResultMediaType = NonNullable<ChatMessage["mediaType"]>;
const SEARCH_RESULT_LIMIT = 80;
const SEARCH_TEXT_SCAN_LIMIT = 20_000;
const SEARCH_SCAN_CHUNK_SIZE = 120;

const SEARCH_MEDIA_BUBBLE_TYPES = new Set<SearchResultMediaType>([
    "sticker",
    "red_packet",
    "transfer",
    "payment_request",
    "gift",
    "image",
    "location",
    "music_share",
    "xiaohongshu_note_share",
    "media_file",
]);

const SEARCH_VISUAL_MEDIA_TYPES = new Set<SearchResultMediaType>([
    ...SEARCH_MEDIA_BUBBLE_TYPES,
    "audio",
    "video",
    "quote",
]);

const SEARCH_ACTION_MEDIA_TYPES = new Set<SearchResultMediaType>([
    "poke",
    "accept_red_packet",
    "decline_red_packet",
    "accept_transfer",
    "decline_transfer",
    "accept_payment_request",
    "decline_payment_request",
    "group_admin_notice",
]);

function getSearchResultRole(msg: ChatMessage): SearchResultRole {
    if (msg.role === "system" || (msg.mediaType && SEARCH_ACTION_MEDIA_TYPES.has(msg.mediaType))) return "system";
    return msg.role === "user" ? "user" : "assistant";
}

function isSearchHiddenMessage(msg: ChatMessage): boolean {
    return msg.role === "tool"
        || msg.mediaType === "tool_call"
        || msg.mediaType === "tool_result"
        || msg.mediaType === "tool_notice"
        || msg.mediaType === "memory_write_request"
        || Boolean(msg.nativeToolCalls?.length && !msg.content.trim());
}

function isSearchVisibleMessage(msg: ChatMessage): boolean {
    if (isSearchHiddenMessage(msg)) return false;
    if (msg.mediaType && SEARCH_VISUAL_MEDIA_TYPES.has(msg.mediaType)) return true;
    if (msg.statusPanel || msg.innerMonologue) return true;
    return Boolean(getSearchResultText(msg));
}

function getSearchResultText(msg: ChatMessage): string {
    return (msg.content.trim() || getChatMessagePreview(msg)).trim();
}

function clipSearchText(value: unknown): string {
    return String(value ?? "").slice(0, SEARCH_TEXT_SCAN_LIMIT);
}

function getSearchHaystack(msg: ChatMessage): string {
    return [
        clipSearchText(msg.content),
        clipSearchText(getChatMessagePreview(msg)),
        clipSearchText(msg.mediaData?.label),
        clipSearchText(msg.mediaData?.musicTitle),
        clipSearchText(msg.mediaData?.xiaohongshuTitle),
        clipSearchText(msg.mediaData?.giftName),
        clipSearchText(msg.senderName),
    ].filter(Boolean).join("\n");
}

function ChatInfoIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="chat-info-icon" style={chatInfoIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

export function ChatSettingsPanel({
    session,
    onClose,
    onJumpToMessage,
    onDeleteFriend,
    onToolHistoryCleared,
    onOfflineHistoryCleared,
    offlineHistoryBusy = false,
}: ChatSettingsPanelProps) {
    const [backgroundImage, setBackgroundImage] = useState<string>(session.backgroundImage || "");
    const [alias, setAlias] = useState<string>(session.alias || "");
    const [videoBackground, setVideoBackground] = useState<string>(session.videoBackground || "");
    const [voiceBackground, setVoiceBackground] = useState<string>(session.voiceBackground || "");
    const [isPinned, setIsPinned] = useState(session.isPinned || false);
    const [visionImagePromptLimit, setVisionImagePromptLimit] = useState(() => normalizeVisionImagePromptLimit(session.visionImagePromptLimit));
    const [bilingualTranslationEnabled, setBilingualTranslationEnabled] = useState(session.bilingualTranslationEnabled !== false);
    const [collapseBilingualTranslation, setCollapseBilingualTranslation] = useState(session.collapseBilingualTranslation !== false);
    const [discardInvalidStickers, setDiscardInvalidStickers] = useState(session.discardInvalidStickers === true);
    const defaultBilingualPrompt = session.isGroup ? DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT : DEFAULT_CHAT_BILINGUAL_PROMPT;
    const defaultOfflineBilingualPrompt = session.isGroup ? DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT : DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT;
    const [bilingualTranslationPrompt, setBilingualTranslationPrompt] = useState(session.bilingualTranslationPrompt || defaultBilingualPrompt);
    const [bilingualPromptDraft, setBilingualPromptDraft] = useState(session.bilingualTranslationPrompt || defaultBilingualPrompt);
    const [offlineBilingualTranslationPrompt, setOfflineBilingualTranslationPrompt] = useState(session.offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
    const [offlineBilingualPromptDraft, setOfflineBilingualPromptDraft] = useState(session.offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
    const [customCSS, setCustomCSS] = useState(() => {
        // Read latest CSS from storage (in case 小卷 updated it)
        const sessions = loadChatSessions();
        const latest = sessions.find(s => s.id === session.id);
        return (latest as Record<string, unknown>)?.customCSS as string || session.customCSS || "";
    });

    const [showConfirmClear, setShowConfirmClear] = useState(false);
    const [showConfirmClearOffline, setShowConfirmClearOffline] = useState(false);
    const [showConfirmClearTools, setShowConfirmClearTools] = useState(false);
    const [showConfirmDelete, setShowConfirmDelete] = useState(false);
    const [editingAlias, setEditingAlias] = useState(false);
    const [editingBilingualPrompt, setEditingBilingualPrompt] = useState(false);
    const [editingCSS, setEditingCSS] = useState(false);
    const [showScreenEffects, setShowScreenEffects] = useState(false);
    const [showSearch, setShowSearch] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [submittedSearchQuery, setSubmittedSearchQuery] = useState("");
    const [searchHistoryMessages, setSearchHistoryMessages] = useState<ChatMessage[]>([]);
    const [searchHasMore, setSearchHasMore] = useState(false);
    const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const searchRunRef = useRef(0);

    const loadSearchHistoryWindow = (count = CHAT_INITIAL_VISIBLE_MESSAGE_COUNT) => {
        const visibleMessages = loadChatMessages(session.id).filter(isSearchVisibleMessage);
        const nextCount = Math.min(Math.max(count, CHAT_INITIAL_VISIBLE_MESSAGE_COUNT), visibleMessages.length);
        setSearchHistoryMessages(visibleMessages.slice(-nextCount).reverse());
        setSearchHasMore(nextCount < visibleMessages.length);
    };

    const openSearchPanel = () => {
        searchRunRef.current += 1;
        setSearchQuery("");
        setSubmittedSearchQuery("");
        setSearchResults([]);
        setIsSearching(false);
        loadSearchHistoryWindow();
        setShowSearch(true);
    };

    const closeSearchPanel = () => {
        searchRunRef.current += 1;
        setShowSearch(false);
        setSearchQuery("");
        setSubmittedSearchQuery("");
        setSearchResults([]);
        setSearchHistoryMessages([]);
        setSearchHasMore(false);
        setIsSearching(false);
    };

    const loadMoreSearchHistory = () => {
        const visibleMessages = loadChatMessages(session.id).filter(isSearchVisibleMessage);
        const nextCount = Math.min(searchHistoryMessages.length + CHAT_LOAD_MORE_MESSAGE_COUNT, visibleMessages.length);
        setSearchHistoryMessages(visibleMessages.slice(-nextCount).reverse());
        setSearchHasMore(nextCount < visibleMessages.length);
    };

    const runSearch = () => {
        const rawQuery = searchQuery.trim();
        const runId = searchRunRef.current + 1;
        searchRunRef.current = runId;
        setSubmittedSearchQuery(rawQuery);

        if (!rawQuery) {
            setSearchResults([]);
            setIsSearching(false);
            loadSearchHistoryWindow();
            return;
        }

        const needle = rawQuery.toLowerCase();
        const results: ChatMessage[] = [];
        setSearchResults([]);
        setIsSearching(true);

        window.setTimeout(() => {
            if (searchRunRef.current !== runId) return;
            const msgs = loadChatMessages(session.id);
            let index = msgs.length - 1;

            const scanChunk = () => {
                if (searchRunRef.current !== runId) return;

                const stop = Math.max(-1, index - SEARCH_SCAN_CHUNK_SIZE);
                for (; index > stop && results.length < SEARCH_RESULT_LIMIT; index -= 1) {
                    const msg = msgs[index];
                    if (!isSearchVisibleMessage(msg)) continue;
                    const haystack = getSearchHaystack(msg);
                    if (haystack && haystack.toLowerCase().includes(needle)) results.push(msg);
                }

                if (results.length >= SEARCH_RESULT_LIMIT || index < 0) {
                    setSearchResults([...results]);
                    setIsSearching(false);
                    return;
                }

                window.setTimeout(scanChunk, 0);
            };

            scanChunk();
        }, 0);
    };

    const [groupName, setGroupName] = useState(session.groupName || "");

    const characters = loadCharacters();
    const character = characters.find(c => c.id === session.contactId);

    const characterName = session.isGroup
        ? (groupName || session.groupName || "群聊")
        : (alias || character?.name || `User_${session.contactId.slice(-4)}`);

    // Group members
    const groupChars = session.isGroup
        ? (session.participantIds || []).map(id => characters.find(c => c.id === id)).filter(Boolean)
        : [];
    const userIdentity = resolveUserIdentity(undefined, session.isGroup ? "group_chat" : "chat");

    // ── Group member management ──
    const [, setRosterVersion] = useState(0); // bump to re-render after admin actions
    const [memberActionKey, setMemberActionKey] = useState<string | null>(null);
    const [mutePickerKey, setMutePickerKey] = useState<string | null>(null);
    const [showInvitePicker, setShowInvitePicker] = useState(false);
    const [allowAdminOnUser, setAllowAdminOnUser] = useState(session.allowAdminActionsOnUser === true);
    if (session.isGroup) pruneExpiredGroupMutes(session);
    const userName = userIdentity?.name || "用户";
    const ownerKey = session.isGroup ? getGroupOwnerKey(session) : "";
    const roleLabel = (key: string): string => {
        const role = getGroupRole(session, key);
        return role === "owner" ? "群主" : role === "admin" ? "管理员" : "";
    };
    type MemberEntry = { key: string; name: string; avatar?: string; muteMs: number };
    const memberEntries: MemberEntry[] = session.isGroup
        ? [
            ...(session.isSpectator ? [] : [{
                key: GROUP_SELF_KEY,
                name: `${userName}（我）`,
                avatar: userIdentity?.avatarUrl || undefined,
                muteMs: getGroupMuteRemainingMs(session, GROUP_SELF_KEY),
            }]),
            ...groupChars.map(c => ({
                key: c!.id,
                name: c!.name,
                avatar: c!.avatar || undefined,
                muteMs: getGroupMuteRemainingMs(session, c!.id),
            })),
        ]
        : [];
    const memberActionsFor = (key: string): { action: GroupAdminAction; label: string; danger?: boolean }[] => {
        if (!session.isGroup || session.isSpectator) return [];
        const items: { action: GroupAdminAction; label: string; danger?: boolean }[] = [];
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "transfer_owner", key)) items.push({ action: "transfer_owner", label: "转让群主" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "set_admin", key)) items.push({ action: "set_admin", label: "设为管理员" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "unset_admin", key)) items.push({ action: "unset_admin", label: "取消管理员" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "mute", key)) items.push({ action: "mute", label: "禁言" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "unmute", key)) items.push({ action: "unmute", label: "解除禁言" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "kick", key)) items.push({ action: "kick", label: "移出群聊", danger: true });
        return items;
    };
    const pushAdminNotice = (action: GroupAdminAction, actorName: string, targetKey: string, muteMinutes?: number) => {
        const targetName = getGroupMemberDisplayName(targetKey, userName);
        // role 用 user（操作人是用户本人）：与 AI 侧 assistant 动作消息对称，
        // UI 仍按系统通知渲染，进历史时还原为 [A将B移出了群聊] 协议格式
        pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: buildGroupAdminNoticeText(action, actorName, targetName, muteMinutes),
            mediaType: "group_admin_notice",
            mediaData: {
                adminAction: action,
                adminActorName: actorName,
                adminTargetName: targetName,
                ...(action === "mute" ? { adminMuteMinutes: muteMinutes || 10 } : {}),
            },
        });
    };
    const performAdminAction = (action: GroupAdminAction, targetKey: string, muteMinutes?: number) => {
        if (!canGroupAdminAct(session, GROUP_SELF_KEY, action, targetKey)) return;
        applyGroupAdminAction(session, action, GROUP_SELF_KEY, targetKey, muteMinutes);
        pushAdminNotice(action, userName, targetKey, muteMinutes);
        setMemberActionKey(null);
        setMutePickerKey(null);
        setShowInvitePicker(false);
        setRosterVersion(v => v + 1);
    };
    // 上帝按钮：不走权限矩阵，防止用户把自己锁死
    const reclaimOwnership = () => {
        const updates: Partial<ChatSession> = { groupOwnerId: GROUP_SELF_KEY };
        const sessions = loadChatSessions();
        const idx = sessions.findIndex(s => s.id === session.id);
        if (idx !== -1) {
            sessions[idx] = { ...sessions[idx], ...updates };
            saveChatSessions(sessions);
        }
        Object.assign(session, updates);
        pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: `${userName}收回了群主身份`,
            mediaType: "group_admin_notice",
            mediaData: { adminAction: "transfer_owner", adminActorName: userName, adminTargetName: userName },
        });
        setRosterVersion(v => v + 1);
    };
    const inviteCandidates = session.isGroup
        ? loadChatContacts()
            .map(c => characters.find(ch => ch.id === c.characterId))
            .filter((c): c is NonNullable<typeof c> => Boolean(c && !(session.participantIds || []).includes(c.id)))
        : [];
    const canInvite = session.isGroup && !session.isSpectator
        && getGroupRole(session, GROUP_SELF_KEY) !== "member";
    const MUTE_DURATION_OPTIONS = [10, 60, 720, 1440, 4320];

    const updateSession = (updates: Partial<ChatSession>) => {
        const sessions = loadChatSessions();
        const sessIdx = sessions.findIndex(s => s.id === session.id);
        if (sessIdx !== -1) {
            sessions[sessIdx] = { ...sessions[sessIdx], ...updates };
            saveChatSessions(sessions);
            Object.assign(session, updates);
        }
    };

    const handleClearHistory = () => {
        clearChatSessionMessages(session.id);
        setShowConfirmClear(false);
    };

    const handleClearOfflineHistory = () => {
        if (offlineHistoryBusy) return;
        clearChatOfflineTurns(session.id);
        onOfflineHistoryCleared?.();
        setShowConfirmClearOffline(false);
    };

    const handleClearToolHistory = () => {
        clearChatSessionToolHistory(session.id);
        onToolHistoryCleared?.();
        setShowConfirmClearTools(false);
    };

    const updateVisionImagePromptLimit = (value: unknown) => {
        const next = normalizeVisionImagePromptLimit(value);
        setVisionImagePromptLimit(next);
        updateSession({ visionImagePromptLimit: next });
    };

    const openBilingualPromptEditor = () => {
        setBilingualPromptDraft(bilingualTranslationPrompt || defaultBilingualPrompt);
        setOfflineBilingualPromptDraft(offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
        setEditingBilingualPrompt(true);
    };

    const saveBilingualPromptDraft = () => {
        setBilingualTranslationPrompt(bilingualPromptDraft);
        setOfflineBilingualTranslationPrompt(offlineBilingualPromptDraft);
        updateSession({
            bilingualTranslationPrompt: bilingualPromptDraft,
            offlineBilingualTranslationPrompt: offlineBilingualPromptDraft,
        });
        setEditingBilingualPrompt(false);
    };

    const handleImageUpload = async (
        e: React.ChangeEvent<HTMLInputElement>,
        setter: React.Dispatch<React.SetStateAction<string>>,
        key: keyof ChatSession
    ) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const id = await saveChatImageToIndexedDB(file);
            setter(id);
            updateSession({ [key]: id });
        } catch (error) {
            console.error("Failed to save image", error);
            alert("图片保存失败，请重试");
        }
    };

    // Group video: per-participant background upload
    const [groupVideoBgs, setGroupVideoBgs] = useState<Record<string, string>>(session.groupVideoBackgrounds || {});
    const handleGroupVideoBgUpload = async (e: React.ChangeEvent<HTMLInputElement>, participantKey: string) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const id = await saveChatImageToIndexedDB(file);
            const updated = { ...groupVideoBgs, [participantKey]: id };
            setGroupVideoBgs(updated);
            updateSession({ groupVideoBackgrounds: updated });
        } catch {
            alert("图片保存失败，请重试");
        }
    };

    const jumpToSearchMessage = (messageId: string) => {
        if (onJumpToMessage) {
            onJumpToMessage(messageId);
        }
        closeSearchPanel();
        onClose();
    };

    const renderSearchMessage = (msg: ChatMessage) => {
        const resultRole = getSearchResultRole(msg);
        const senderChar = session.isGroup && msg.senderCharacterId
            ? characters.find(c => c.id === msg.senderCharacterId) || character
            : character;
        const senderName = msg.role === "user"
            ? "我"
            : (session.isGroup ? (msg.senderName || senderChar?.name || characterName) : characterName);
        const isSystemMessage = resultRole === "system";
        const isStandaloneHtmlPreview = !msg.mediaType && isStandaloneHtmlPreviewContent(msg.content);
        const isMediaBubble = (msg.mediaType && SEARCH_MEDIA_BUBBLE_TYPES.has(msg.mediaType)) || isStandaloneHtmlPreview;
        const bubbleRole = msg.role === "user" ? "user" : "assistant";

        return (
            <div key={msg.id} className="flex flex-col gap-2">
                <div className="flex justify-center">
                    <span className="chat-sys-msg py-[2px] px-2 rounded select-none">
                        {new Date(msg.createdAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                </div>
                {isSystemMessage ? (
                    <div className="chat-msg-wrapper" data-role="system">
                        <div
                            role="button"
                            tabIndex={0}
                            className="chat-sys-msg relative cursor-pointer"
                            onClick={() => jumpToSearchMessage(msg.id)}
                            onKeyDown={e => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    jumpToSearchMessage(msg.id);
                                }
                            }}
                        >
                            {msg.mediaType === "poke"
                                ? <MessageBubble msg={msg} charName={senderChar?.name} userName={userIdentity?.name || "你"} characterId={msg.senderCharacterId || session.contactId} />
                                : getSearchResultText(msg)}
                        </div>
                    </div>
                ) : (
                    <div className="chat-msg-wrapper" data-role={resultRole}>
                        {resultRole === "assistant" && (
                            <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-[var(--c-page-body-bg)] shrink-0 flex items-center justify-center overflow-hidden">
                                {senderChar?.avatar ? (
                                    <img src={senderChar.avatar} className="w-full h-full object-cover" alt="" />
                                ) : (
                                    <ChatFallbackAvatar />
                                )}
                            </div>
                        )}
                        <div className={`chat-msg-content-wrap flex flex-col min-w-0 max-w-[70%] ${isStandaloneHtmlPreview ? "chat-msg-content-wrap-html" : ""}`}>
                            {session.isGroup && msg.role !== "user" && (
                                <span className="chat-group-sender-name">
                                    {senderName}
                                    {msg.senderCharacterId && (session.participantIds || []).includes(msg.senderCharacterId) && (() => {
                                        const role = getGroupRole(session, msg.senderCharacterId);
                                        if (role === "owner") return <span className="chat-role-badge chat-role-badge-owner">群主</span>;
                                        if (role === "admin") return <span className="chat-role-badge chat-role-badge-admin">管理员</span>;
                                        return null;
                                    })()}
                                </span>
                            )}
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={() => jumpToSearchMessage(msg.id)}
                                onKeyDown={e => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        jumpToSearchMessage(msg.id);
                                    }
                                }}
                                className={`chat-bubble-role-${bubbleRole} ${isMediaBubble ? "chat-bubble-media" : ""} ${isStandaloneHtmlPreview ? "chat-bubble-html-preview" : ""} ${msg.mediaType === "music_share" ? "chat-bubble-music-share" : ""} ${msg.mediaType === "gift" || msg.mediaType === "image" || isStandaloneHtmlPreview ? "rounded-none" : "rounded-md"} break-words relative cursor-pointer select-none`}
                                data-ui={bubbleRole === "user" ? "bubble-user" : "bubble-bot"}
                                data-msg-id={msg.id}
                            >
                                <MessageBubble
                                    msg={msg}
                                    charName={senderChar?.name}
                                    userName={userIdentity?.name || "你"}
                                    groupSize={session.isGroup ? (session.participantIds?.length || 0) + (session.isSpectator ? 0 : 1) : undefined}
                                    characterId={msg.senderCharacterId || session.contactId}
                                    defaultTranslationExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                />
                            </div>
                        </div>
                        {resultRole === "user" && (
                            <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-[var(--c-page-body-bg)] shrink-0 flex items-center justify-center overflow-hidden">
                                {userIdentity?.avatarUrl ? (
                                    <img src={userIdentity.avatarUrl} alt="Me" className="w-full h-full object-cover rounded-[20px]" />
                                ) : (
                                    <ChatFallbackAvatar />
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const searchMode = submittedSearchQuery.trim().length > 0;
    const displayedSearchMessages = searchMode ? searchResults : searchHistoryMessages;

    return (
        <PageShell title="聊天信息" onBack={onClose} className="absolute inset-0 z-[100]">
            <div className="page-menu chat-info-menu">
                {/* Basic Info & Search */}
                <div className="menu-group">
                    <button className="menu-item" onClick={() => setEditingAlias(true)}>
                        <ChatInfoIcon icon={MessageSquare} color={CONTENT_APP_ACCENTS.chat} />
                        <div className="menu-label-group"><span className="menu-label">{session.isGroup ? "群聊名称" : "设置备注"}</span></div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{session.isGroup ? (groupName || "未设置") : (alias || "无备注")}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                    <button className="menu-item" onClick={openSearchPanel}>
                        <ChatInfoIcon icon={Search} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group"><span className="menu-label">查找聊天记录</span></div>
                        <div className="menu-right"><ChevronRight size={16} /></div>
                    </button>
                </div>

                {/* Group member management */}
                {session.isGroup && (
                    <div className="menu-group">
                        <div className="menu-item" style={{ cursor: "default" }}>
                            <ChatInfoIcon icon={Users} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">群成员管理</span>
                                <span className="menu-desc">
                                    {session.isSpectator
                                        ? "围观群：你不在群内，身份只读"
                                        : (getGroupRole(session, GROUP_SELF_KEY) === "member"
                                            ? "你是普通成员，没有管理权限"
                                            : "点击成员执行管理操作")}
                                </span>
                            </div>
                        </div>
                        {memberEntries.map(entry => {
                            const badge = roleLabel(entry.key);
                            const actionable = memberActionsFor(entry.key).length > 0;
                            return (
                                <button
                                    key={entry.key}
                                    className="menu-item"
                                    style={{ paddingLeft: 72, ...(actionable ? {} : { cursor: "default" }) }}
                                    onClick={() => { if (actionable) setMemberActionKey(entry.key); }}
                                >
                                    <div className="w-[24px] h-[24px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0 flex items-center justify-center">
                                        {entry.avatar ? <img src={entry.avatar} className="w-full h-full object-cover" alt="" /> : <ChatFallbackAvatar />}
                                    </div>
                                    <div className="menu-label-group">
                                        <span className="menu-label">{entry.name}</span>
                                        {entry.muteMs > 0 && (
                                            <span className="menu-desc">禁言中 · 剩余{formatMuteRemainingLabel(entry.muteMs)}</span>
                                        )}
                                    </div>
                                    <div className="menu-right">
                                        {badge && <span className="menu-desc mr-1">{badge}</span>}
                                        {actionable && <ChevronRight size={14} />}
                                    </div>
                                </button>
                            );
                        })}
                        {canInvite && (
                            <button className="menu-item" onClick={() => setShowInvitePicker(true)}>
                                <ChatInfoIcon icon={UserPlus} color={BINDING_ACCENTS.voice} />
                                <div className="menu-label-group"><span className="menu-label">拉人进群</span></div>
                                <div className="menu-right"><ChevronRight size={16} /></div>
                            </button>
                        )}
                        {!session.isSpectator && (
                            <div className="menu-item">
                                <ChatInfoIcon icon={AlertCircle} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">允许角色对我使用管理操作</span>
                                    <span className="menu-desc">开启后群主/管理员角色可以禁言你（不能踢你）</span>
                                </div>
                                <div className="menu-right">
                                    <Toggle
                                        checked={allowAdminOnUser}
                                        onChange={c => { setAllowAdminOnUser(c); updateSession({ allowAdminActionsOnUser: c }); }}
                                    />
                                </div>
                            </div>
                        )}
                        {!session.isSpectator && ownerKey !== GROUP_SELF_KEY && (
                            <button className="menu-item" onClick={reclaimOwnership}>
                                <ChatInfoIcon icon={Users} color="var(--c-danger)" />
                                <div className="menu-label-group">
                                    <span className="menu-label menu-label-danger">收回群主身份</span>
                                    <span className="menu-desc">上帝操作：无视群规则直接拿回群主</span>
                                </div>
                            </button>
                        )}
                    </div>
                )}

                {/* Toggles */}
                <div className="menu-group">
                    <div className="menu-item">
                        <ChatInfoIcon icon={Pin} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group"><span className="menu-label">置顶聊天</span></div>
                        <div className="menu-right">
                            <Toggle checked={isPinned} onChange={c => { setIsPinned(c); updateSession({ isPinned: c }); }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <ChatInfoIcon icon={ImageIcon} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group">
                            <span className="menu-label">传入最近图片数</span>
                            <span className="menu-desc">进入模型视觉上下文的最近图片数量，0 表示不传图片内容</span>
                        </div>
                        <div className="menu-right gap-2">
                            <button
                                type="button"
                                className="ui-btn ui-btn-ghost h-8 w-8 p-0"
                                onClick={() => updateVisionImagePromptLimit(visionImagePromptLimit - 1)}
                                disabled={visionImagePromptLimit <= 0}
                            >
                                -
                            </button>
                            <input
                                type="number"
                                min={0}
                                max={MAX_VISION_IMAGE_PROMPT_LIMIT}
                                value={visionImagePromptLimit}
                                onChange={e => updateVisionImagePromptLimit(e.target.value)}
                                className="ui-input h-8 w-14 text-center"
                            />
                            <button
                                type="button"
                                className="ui-btn ui-btn-ghost h-8 w-8 p-0"
                                onClick={() => updateVisionImagePromptLimit(visionImagePromptLimit + 1)}
                                disabled={visionImagePromptLimit >= MAX_VISION_IMAGE_PROMPT_LIMIT}
                            >
                                +
                            </button>
                        </div>
                    </div>
                    <>
                        <div className="menu-item">
                            <ChatInfoIcon icon={MessageSquare} color={CONTENT_APP_ACCENTS.chat} />
                            <div className="menu-label-group">
                                <span className="menu-label">双语翻译</span>
                                <span className="menu-desc">{session.isGroup ? "外语发言自动附中文译文" : "外语回复自动附中文译文"}</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={bilingualTranslationEnabled}
                                    onChange={c => {
                                        setBilingualTranslationEnabled(c);
                                        updateSession({ bilingualTranslationEnabled: c });
                                    }}
                                />
                            </div>
                        </div>
                        {bilingualTranslationEnabled && (
                            <>
                                <div className="menu-item">
                                    <ChatInfoIcon icon={MessageSquare} color={BINDING_ACCENTS.voice} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">折叠中文译文</span>
                                        <span className="menu-desc">关闭后默认直接展开中文</span>
                                    </div>
                                    <div className="menu-right">
                                        <Toggle
                                            checked={collapseBilingualTranslation}
                                            onChange={c => {
                                                setCollapseBilingualTranslation(c);
                                                updateSession({ collapseBilingualTranslation: c });
                                            }}
                                        />
                                    </div>
                                </div>
                                <button className="menu-item" onClick={openBilingualPromptEditor}>
                                    <ChatInfoIcon icon={MessageSquare} color={BINDING_ACCENTS.memory} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">双语提示词</span>
                                    </div>
                                    <div className="menu-right">
                                        <span className="menu-desc mr-1">
                                            {bilingualTranslationPrompt === defaultBilingualPrompt && offlineBilingualTranslationPrompt === defaultOfflineBilingualPrompt ? "默认" : "已自定义"}
                                        </span>
                                        <ChevronRight size={16} />
                                    </div>
                                </button>
                            </>
                        )}
                        <div className="menu-item">
                            <ChatInfoIcon icon={Smile} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">丢弃无效表情包</span>
                                <span className="menu-desc">角色发送不存在的表情包时自动丢弃该消息</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={discardInvalidStickers}
                                    onChange={c => {
                                        setDiscardInvalidStickers(c);
                                        updateSession({ discardInvalidStickers: c });
                                    }}
                                />
                            </div>
                        </div>
                        <button className="menu-item" onClick={() => setShowScreenEffects(true)}>
                            <ChatInfoIcon icon={Sparkles} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">全屏特效</span>
                                <span className="menu-desc">消息包含触发词时播放表情雨/礼花，全局生效</span>
                            </div>
                            <div className="menu-right">
                                <ChevronRight size={16} />
                            </div>
                        </button>
                    </>
                </div>

                {/* Backgrounds & UI */}
                <div className="menu-group">
                    <label className="menu-item">
                        <ChatInfoIcon icon={ImageIcon} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group"><span className="menu-label">聊天背景</span></div>
                        <div className="menu-right">
                            {backgroundImage && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setBackgroundImage(""); updateSession({ backgroundImage: "" }); }}>清除</button></>}
                            <ChevronRight size={16} />
                        </div>
                        <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setBackgroundImage, "backgroundImage")} className="hidden" />
                    </label>
                    {session.isGroup ? (
                        <>
                            <div className="menu-item" style={{ cursor: "default" }}>
                                <ChatInfoIcon icon={Video} color={BINDING_ACCENTS.voice} />
                                <div className="menu-label-group"><span className="menu-label">视频通话背景</span></div>
                            </div>
                            {groupChars.map(c => c && (
                                <label key={c.id} className="menu-item" style={{ paddingLeft: 72 }}>
                                    <div className="w-[24px] h-[24px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0">
                                        {c.avatar ? <img src={c.avatar} className="w-full h-full object-cover" alt="" /> : <ChatFallbackAvatar />}
                                    </div>
                                    <div className="menu-label-group"><span className="menu-label">{c.name}</span></div>
                                    <div className="menu-right">
                                        {groupVideoBgs[c.id] && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); const updated = { ...groupVideoBgs }; delete updated[c.id]; setGroupVideoBgs(updated); updateSession({ groupVideoBackgrounds: updated }); }}>清除</button></>}
                                        <ChevronRight size={14} />
                                    </div>
                                    <input type="file" accept="image/*" onChange={e => handleGroupVideoBgUpload(e, c.id)} className="hidden" />
                                </label>
                            ))}
                            <label className="menu-item" style={{ paddingLeft: 72 }}>
                                <div className="w-[24px] h-[24px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0 flex items-center justify-center">
                                    {userIdentity?.avatarUrl ? (
                                        <img src={userIdentity.avatarUrl} className="w-full h-full object-cover" alt="" />
                                    ) : (
                                        <span className="ts-11">{(userIdentity?.name || "我")[0]}</span>
                                    )}
                                </div>
                                <div className="menu-label-group"><span className="menu-label">{userIdentity?.name || "我"}</span></div>
                                <div className="menu-right">
                                    {groupVideoBgs["self"] && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); const updated = { ...groupVideoBgs }; delete updated["self"]; setGroupVideoBgs(updated); updateSession({ groupVideoBackgrounds: updated }); }}>清除</button></>}
                                    <ChevronRight size={14} />
                                </div>
                                <input type="file" accept="image/*" onChange={e => handleGroupVideoBgUpload(e, "self")} className="hidden" />
                            </label>
                        </>
                    ) : (
                        <label className="menu-item">
                            <ChatInfoIcon icon={Video} color={BINDING_ACCENTS.voice} />
                            <div className="menu-label-group"><span className="menu-label">视频通话背景</span></div>
                            <div className="menu-right">
                                {videoBackground && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setVideoBackground(""); updateSession({ videoBackground: "" }); }}>清除</button></>}
                                <ChevronRight size={16} />
                            </div>
                            <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setVideoBackground, "videoBackground")} className="hidden" />
                        </label>
                    )}
                    <label className="menu-item">
                        <ChatInfoIcon icon={Mic} color={BINDING_ACCENTS.voice} />
                        <div className="menu-label-group"><span className="menu-label">语音通话背景</span></div>
                        <div className="menu-right">
                            {voiceBackground && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setVoiceBackground(""); updateSession({ voiceBackground: "" }); }}>清除</button></>}
                            <ChevronRight size={16} />
                        </div>
                        <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setVoiceBackground, "voiceBackground")} className="hidden" />
                    </label>
                </div>

                {/* Advanced */}
                <div className="menu-group">
                    <button className="menu-item" onClick={() => setEditingCSS(true)}>
                        <ChatInfoIcon icon={Code} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group"><span className="menu-label">自定义 CSS 样式</span></div>
                        <div className="menu-right">
                            {customCSS && <span className="menu-desc mr-1">已设置</span>}
                            <ChevronRight size={16} />
                        </div>
                    </button>
                </div>

                {/* Destructive Actions */}
                <div className="menu-group">
                    {!session.isGroup && (
                    <button className="menu-item" onClick={() => setShowConfirmDelete(true)}>
                        <ChatInfoIcon icon={UserMinus} color="var(--c-danger)" />
                        <div className="menu-label-group"><span className="menu-label menu-label-danger">删除好友</span></div>
                    </button>
                    )}
                    <button className="menu-item" onClick={() => setShowConfirmClearTools(true)}>
                        <ChatInfoIcon icon={Code} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清理原生tool调用历史——防报错</span>
                            <span className="menu-desc">切换到文本协议 API 前使用</span>
                        </div>
                    </button>
                    <button className="menu-item" onClick={() => setShowConfirmClear(true)}>
                        <ChatInfoIcon icon={Trash2} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清空线上聊天记录</span>
                            <span className="menu-desc">不影响线下模式记录</span>
                        </div>
                    </button>
                    <button
                        className="menu-item"
                        disabled={offlineHistoryBusy}
                        onClick={() => {
                            if (!offlineHistoryBusy) setShowConfirmClearOffline(true);
                        }}
                        style={offlineHistoryBusy ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    >
                        <ChatInfoIcon icon={Trash2} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清空线下聊天记录</span>
                            <span className="menu-desc">
                                {offlineHistoryBusy ? "线下回复生成中，完成后再清空" : "同步移除该会话的线下短期记忆事件"}
                            </span>
                        </div>
                    </button>
                </div>

            </div>

            {/* Modal: Group member actions */}
            {memberActionKey && (
                <div className="modal-overlay" onClick={() => setMemberActionKey(null)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">
                            {getGroupMemberDisplayName(memberActionKey, userName)}
                            {roleLabel(memberActionKey) ? `（${roleLabel(memberActionKey)}）` : ""}
                        </span>
                        <div className="flex flex-col gap-2 w-full">
                            {memberActionsFor(memberActionKey).map(item => (
                                <button
                                    key={item.action}
                                    className={`ui-btn flex-1 ${item.danger ? "ui-btn-danger" : "ui-btn-ghost"}`}
                                    onClick={() => {
                                        if (item.action === "mute") {
                                            setMutePickerKey(memberActionKey);
                                            setMemberActionKey(null);
                                        } else {
                                            performAdminAction(item.action, memberActionKey);
                                        }
                                    }}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setMemberActionKey(null)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Mute duration picker */}
            {mutePickerKey && (
                <div className="modal-overlay" onClick={() => setMutePickerKey(null)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">禁言 {getGroupMemberDisplayName(mutePickerKey, userName)}</span>
                        <div className="flex flex-col gap-2 w-full">
                            {MUTE_DURATION_OPTIONS.map(minutes => (
                                <button
                                    key={minutes}
                                    className="ui-btn ui-btn-ghost flex-1"
                                    onClick={() => performAdminAction("mute", mutePickerKey, minutes)}
                                >
                                    {formatMuteDurationLabel(minutes)}
                                </button>
                            ))}
                        </div>
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setMutePickerKey(null)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Invite picker */}
            {showInvitePicker && (
                <div className="modal-overlay" onClick={() => setShowInvitePicker(false)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">拉人进群</span>
                        {inviteCandidates.length === 0 ? (
                            <span className="menu-desc">没有可以拉进群的联系人</span>
                        ) : (
                            <div className="chat-contact-list">
                                {inviteCandidates.map(c => (
                                    <div
                                        key={c.id}
                                        className="chat-contact-item"
                                        onClick={() => performAdminAction("invite", c.id)}
                                    >
                                        <div className="chat-contact-avatar">
                                            {c.avatar ? <img src={c.avatar} alt="" /> : <ChatFallbackAvatar />}
                                        </div>
                                        <span className="chat-contact-name">{c.name}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setShowInvitePicker(false)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Alias / Group Name */}
            {editingAlias && (
                <div className="modal-overlay">
                    <div className="modal-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">{session.isGroup ? "修改群名" : "修改备注"}</div>
                        <Input
                            type="text"
                            value={session.isGroup ? groupName : alias}
                            onChange={e => session.isGroup ? setGroupName(e.target.value) : setAlias(e.target.value)}
                            placeholder={session.isGroup ? "输入群名" : (character?.name || "输入备注名")}
                        />
                        <div className="flex gap-3 w-full">
                            <button onClick={() => setEditingAlias(false)} className="ui-btn ui-btn-ghost flex-1">取消</button>
                            <button onClick={() => {
                                if (session.isGroup) {
                                    updateSession({ groupName });
                                } else {
                                    updateSession({ alias });
                                }
                                setEditingAlias(false);
                            }} className="ui-btn ui-btn-success flex-1">保存</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal: Bilingual Prompt */}
            {editingBilingualPrompt && (
                <div className="modal-overlay">
                    <div className="modal-dialog chat-bilingual-prompt-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">双语提示词</div>
                        <div className="chat-bilingual-prompt-stack">
                            <div className="chat-bilingual-prompt-section">
                                <div className="chat-bilingual-prompt-head">
                                    <div>
                                        <div className="chat-bilingual-prompt-title">线上聊天提示词</div>
                                        <div className="chat-bilingual-prompt-desc">即时通讯、富媒体和聊天气泡输出使用。</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="chat-bilingual-prompt-reset"
                                        onClick={() => setBilingualPromptDraft(defaultBilingualPrompt)}
                                    >
                                        默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input chat-bilingual-prompt-textarea chat-bilingual-prompt-textarea--split"
                                    value={bilingualPromptDraft}
                                    onChange={e => setBilingualPromptDraft(e.target.value)}
                                />
                            </div>
                            <div className="chat-bilingual-prompt-section">
                                <div className="chat-bilingual-prompt-head">
                                    <div>
                                        <div className="chat-bilingual-prompt-title">线下模式提示词</div>
                                        <div className="chat-bilingual-prompt-desc">只约束线下连续叙事中的角色对白。</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="chat-bilingual-prompt-reset"
                                        onClick={() => setOfflineBilingualPromptDraft(defaultOfflineBilingualPrompt)}
                                    >
                                        默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input chat-bilingual-prompt-textarea chat-bilingual-prompt-textarea--split"
                                    value={offlineBilingualPromptDraft}
                                    onChange={e => setOfflineBilingualPromptDraft(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="flex gap-3 w-full">
                            <button
                                onClick={() => {
                                    setBilingualPromptDraft(defaultBilingualPrompt);
                                    setOfflineBilingualPromptDraft(defaultOfflineBilingualPrompt);
                                }}
                                className="ui-btn ui-btn-outline flex-1"
                            >
                                全部默认
                            </button>
                            <button onClick={() => setEditingBilingualPrompt(false)} className="ui-btn ui-btn-ghost flex-1">
                                取消
                            </button>
                            <button onClick={saveBilingualPromptDraft} className="ui-btn ui-btn-success flex-1">
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal: Screen Effects */}
            {showScreenEffects && <ScreenEffectSettingsModal onClose={() => setShowScreenEffects(false)} />}

            {/* Modal: Confirm Clear History */}
            {showConfirmClear && (
                <ConfirmDialog
                    title="确定要清空线上聊天记录吗？"
                    message="只清空普通聊天记录，不影响线下模式记录。清空后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清空"
                    cancelLabel="取消"
                    onConfirm={handleClearHistory}
                    onCancel={() => setShowConfirmClear(false)}
                />
            )}

            {/* Modal: Confirm Clear Offline History */}
            {showConfirmClearOffline && (
                <ConfirmDialog
                    title="确定要清空线下聊天记录吗？"
                    message="会同步移除该会话的线下短期记忆事件，不影响线上聊天与已保存的长期记忆。清空后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清空"
                    cancelLabel="取消"
                    onConfirm={handleClearOfflineHistory}
                    onCancel={() => setShowConfirmClearOffline(false)}
                />
            )}

            {/* Modal: Confirm Clear Tool History */}
            {showConfirmClearTools && (
                <ConfirmDialog
                    title="清理工具调用历史？"
                    message="将移除本会话中的工具调用记录、工具结果记录，并清除助手消息里的原生工具调用元数据。普通聊天内容不会删除。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清理"
                    cancelLabel="取消"
                    onConfirm={handleClearToolHistory}
                    onCancel={() => setShowConfirmClearTools(false)}
                />
            )}

            {/* Modal: Confirm Delete Friend */}
            {showConfirmDelete && (
                <ConfirmDialog
                    title="确定要删除该好友吗？"
                    message="删除后对方将从联系人列表消失，聊天和朋友圈将被隐藏。重新添加好友后可恢复。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeChatContact(session.contactId);
                        // Fire-and-forget: AI reacts to being deleted
                        triggerDeleteFriendReaction(session.contactId).catch(() => {});
                        setShowConfirmDelete(false);
                        onDeleteFriend?.();
                    }}
                    onCancel={() => setShowConfirmDelete(false)}
                />
            )}

            {/* Sub-page: Custom CSS */}
            {editingCSS && (
                <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "#ffffff" }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--c-page-body-bg)" }}>
                    <PageShell title="自定义 CSS" onBack={() => setEditingCSS(false)}>
                        <div className="theme-section-page">
                            <p className="ts-13 text-[var(--c-text)] mb-3 leading-relaxed">
                                支持 :root 变量和选择器，仅作用于本会话。
                            </p>
                            <textarea
                                className="ui-textarea font-mono ts-13 leading-relaxed flex-1"
                                style={{ minHeight: 280, resize: "none", scrollbarWidth: "none" }}
                                placeholder={`:root {\n  --c-bubble-self: #95ec69;\n}\n\n.chat-bubble-role-user {\n  border-radius: 6px;\n}\n\n.chat-html-inline-frame {\n  max-height: min(36vh, 340px);\n}`}
                                value={customCSS}
                                onChange={e => setCustomCSS(e.target.value)}
                                spellCheck={false}
                            />
                            <div className="flex gap-2 mt-3 items-center">
                                <CSSSchemeBar target="chat_session" currentCSS={customCSS} onLoad={setCustomCSS} />
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setCustomCSS(CHAT_SESSION_CSS_EXAMPLE)}>示例</button>
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setCustomCSS("")}>清除</button>
                                <button type="button" className="ui-btn ui-btn-soft-action flex-1" onClick={() => { updateSession({ customCSS }); window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: session.id, css: customCSS } })); setEditingCSS(false); }}>应用</button>
                            </div>
                        </div>
                    </PageShell>
                </div>
                </div>
            )}

            {/* Sub-page: Search History */}
            {showSearch && (
                <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "#ffffff" }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--c-page-body-bg)" }}>
                    <PageShell title="查找聊天记录" onBack={closeSearchPanel}>
                        <div className="px-4 pt-2 pb-3 flex items-center gap-2">
                            <input
                                autoFocus
                                type="text"
                                placeholder="搜索聊天记录..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        runSearch();
                                    }
                                }}
                                className="ui-input flex-1 min-w-0"
                            />
                            <button
                                type="button"
                                aria-label="搜索聊天记录"
                                title="搜索"
                                onClick={runSearch}
                                disabled={isSearching}
                                className="h-10 w-10 shrink-0 grid place-items-center border-0 bg-transparent text-[var(--c-icon)] disabled:opacity-40"
                            >
                                <Search size={20} strokeWidth={2.1} />
                            </button>
                        </div>
                        <div className="flex flex-col gap-4 px-4 pb-4">
                            {!searchMode && searchHistoryMessages.length === 0 && (
                                <div className="ui-empty">
                                    <span className="menu-desc">暂无聊天记录</span>
                                </div>
                            )}
                            {searchMode && isSearching && (
                                <div className="ui-empty">
                                    <span className="menu-desc">正在搜索...</span>
                                </div>
                            )}
                            {searchMode && !isSearching && searchResults.length === 0 && (
                                <div className="ui-empty">
                                    <span className="menu-desc">无相关聊天记录</span>
                                </div>
                            )}
                            {displayedSearchMessages.map(renderSearchMessage)}
                            {!searchMode && searchHasMore && (
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-ghost ui-btn-bordered-ghost w-full"
                                    onClick={loadMoreSearchHistory}
                                >
                                    查看更多消息
                                </button>
                            )}
                            {searchMode && !isSearching && searchResults.length >= SEARCH_RESULT_LIMIT && (
                                <div className="ui-empty py-2">
                                    <span className="menu-desc">仅显示最近 {SEARCH_RESULT_LIMIT} 条结果</span>
                                </div>
                            )}
                        </div>
                    </PageShell>
                </div>
                </div>
            )}
        </PageShell>
    );
}
