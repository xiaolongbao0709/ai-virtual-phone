"use client";

import React, { useState, useEffect, useSyncExternalStore } from "react";
import { ChevronLeft } from "lucide-react";
import { loadChatSessions, loadChatContacts, ChatSession, createOrGetSession, createGroupSession, pushChatMessage, addChatContact, loadChatMessages, getLastVisibleSessionMessage, getChatMessagePreview } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { Character } from "@/lib/character-types";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";
import { PENDING_REPLY_PREFIX } from "@/lib/friend-request-engine";
import { clearRequestsForCharacter, dispatchFriendRequestUpdated } from "@/lib/friend-request-storage";
import { UserProfilePanel } from "./user-profile-panel";
import { PageShell } from "@/components/ui/page-shell";
import { GroupCreateModal } from "./group-create-modal";
import { Toggle } from "@/components/ui/form";
import { formatChatUiTime } from "@/lib/chat-time";
import { getChatOfflineTurnPreview, getLastChatOfflineTurn } from "@/lib/chat-offline-storage";
import {
    dismissMergeSignatures,
    findPromptableDuplicateSessionGroups,
    mergeDuplicateSessionGroup,
    type DuplicateSessionGroup,
} from "@/lib/chat-session-merge";
import { kvSet } from "@/lib/kv-db";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import {
    getMascotLastPreview,
    getMascotChatSnapshot,
    hydrateMascotChat,
    subscribeMascotChat,
} from "@/lib/mascot-chat-store";
import {
    DEFAULT_MASCOT_AVATAR,
    getMascotSettingsSnapshot,
    resolveMascotImageRef,
    subscribeMascotSettings,
    updateMascotSettings,
} from "@/lib/mascot-settings";

function parseTime(value?: string | null): number {
    if (!value) return 0;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? 0 : time;
}

/** 取两个时间里更晚的那个（空值视为最早） */
function pickLaterTime(a?: string | null, b?: string | null): string {
    if (!a) return b || "";
    if (!b) return a;
    return parseTime(a) >= parseTime(b) ? a : b;
}

/**
 * 会话在列表里是否有内容：线上可见消息、线下模式记录都算。
 * 只在线下聊过的会话（或线上记录被清空的会话）不该从列表里消失。
 */
function hasSessionListContent(sessionId: string): boolean {
    return Boolean(getLastVisibleSessionMessage(sessionId)) || Boolean(getLastChatOfflineTurn(sessionId));
}

/** 列表排序用的活跃时间：线上最后一条与线下最后一条里更晚的那个 */
function getSessionListTime(session: ChatSession): string {
    const onlineTime = getLastVisibleSessionMessage(session.id)?.createdAt;
    const offlineTime = getLastChatOfflineTurn(session.id)?.createdAt;
    return pickLaterTime(onlineTime, offlineTime) || session.updatedAt;
}

/** Fallback: find last non-empty, non-system message preview when session preview is empty */
function getLastNonEmptyPreview(sessionId: string): string {
    try {
        const lastVisible = getLastVisibleSessionMessage(sessionId);
        if (lastVisible) {
            const preview = getChatMessagePreview(lastVisible) || lastVisible.content;
            if (preview.trim()) return preview;
        }
        const offlinePreview = getChatOfflineTurnPreview(getLastChatOfflineTurn(sessionId));
        if (offlinePreview.trim()) return offlinePreview;
    } catch { /* ignore */ }
    return "暂无消息...";
}

type ChatMessageListProps = {
    onCloseApp: () => void;
    activeSession: ChatSession | null;
    onSelectSession: (session: ChatSession | null) => void;
    onSelectMascot: () => void;
};

export function ChatMessageList({ onCloseApp, activeSession, onSelectSession, onSelectMascot }: ChatMessageListProps) {
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [listFilter, setListFilter] = useState("");
    const [listTab, setListTab] = useState<"all" | "private" | "group">("all");
    const [showPlusMenu, setShowPlusMenu] = useState(false);
    const plusMenuRef = React.useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!showPlusMenu) return;
        const handler = (e: PointerEvent) => {
            if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
                setShowPlusMenu(false);
            }
        };
        document.addEventListener("pointerdown", handler);
        return () => document.removeEventListener("pointerdown", handler);
    }, [showPlusMenu]);
    const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResult, setSearchResult] = useState<Character | null | undefined>(undefined);
    // undefined: not searched yet, null: searched and not found, Character: found

    const [isSendingRequest, setIsSendingRequest] = useState(false);
    const [greetingText, setGreetingText] = useState("");

    const [showUserProfile, setShowUserProfile] = useState(false);
    const [showContactPicker, setShowContactPicker] = useState(false);
    const [showGroupCreate, setShowGroupCreate] = useState(false);
    // 重复会话合并弹窗：进列表时检测一次，用户按组勾选
    const [mergePrompt, setMergePrompt] = useState<DuplicateSessionGroup[] | null>(null);
    const [mergeSelected, setMergeSelected] = useState<Set<string>>(new Set());
    const [identity, setIdentity] = useState<UserIdentity | null>(null);
    const mascotSettings = useSyncExternalStore(subscribeMascotSettings, getMascotSettingsSnapshot, getMascotSettingsSnapshot);
    const mascotChat = useSyncExternalStore(subscribeMascotChat, getMascotChatSnapshot, getMascotChatSnapshot);
    const [mascotAvatarUrl, setMascotAvatarUrl] = useState(mascotSettings.avatarImage || DEFAULT_MASCOT_AVATAR);

    useEffect(() => {
        setIdentity(resolveUserIdentity());
    }, []);

    useEffect(() => {
        void hydrateMascotChat();
    }, []);

    useEffect(() => {
        let cancelled = false;
        resolveMascotImageRef(mascotSettings.avatarImage).then((url) => {
            if (!cancelled) setMascotAvatarUrl(url);
        });
        return () => { cancelled = true; };
    }, [mascotSettings.avatarImage]);

    useEffect(() => {
        if (!activeSession) {
            setSessions(loadChatSessions());
        }
    }, [activeSession]);

    useEffect(() => {
        const refreshSessions = () => setSessions(loadChatSessions());
        window.addEventListener("weixin-messages-updated", refreshSessions);
        window.addEventListener("chat-messages-updated", refreshSessions);
        return () => {
            window.removeEventListener("weixin-messages-updated", refreshSessions);
            window.removeEventListener("chat-messages-updated", refreshSessions);
        };
    }, []);

    // 进列表时检测重复会话（同一角色的单聊 / 同一批成员的群聊），默认全选
    useEffect(() => {
        const groups = findPromptableDuplicateSessionGroups();
        if (groups.length === 0) return;
        setMergePrompt(groups);
        setMergeSelected(new Set(groups.map(g => g.signature)));
    }, []);

    const handleMergeConfirm = () => {
        if (!mergePrompt) return;
        for (const group of mergePrompt) {
            if (mergeSelected.has(group.signature)) mergeDuplicateSessionGroup(group);
        }
        // 没勾的按签名记账：这批会话不再提醒，新出现的重复照常提示
        dismissMergeSignatures(mergePrompt.filter(g => !mergeSelected.has(g.signature)).map(g => g.signature));
        setMergePrompt(null);
        setSessions(loadChatSessions());
    };

    const handleMergeDismiss = () => {
        if (!mergePrompt) return;
        dismissMergeSignatures(mergePrompt.map(g => g.signature));
        setMergePrompt(null);
    };

    return (
        <div className="relative flex-1 h-full">
            <PageShell
                leftAction={
                    <div className="flex items-center min-w-max">
                        <button className="page-back-btn shrink-0 mr-2" type="button" onClick={onCloseApp} aria-label="返回">
                            <ChevronLeft size={24} strokeWidth={1.5} />
                        </button>
                        <div className="flex items-center gap-[10px]">
                            <div className="w-[36px] h-[36px] rounded-full overflow-hidden bg-[var(--c-input)] flex items-center justify-center shrink-0">
                                {identity?.avatarUrl ? (
                                    <img src={identity.avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                                ) : (
                                    <ChatFallbackAvatar />
                                )}
                            </div>
                            <div className="flex flex-col whitespace-nowrap">
                                <span className="ts-16 font-bold text-[var(--c-text-title)] leading-tight">{identity?.name || "用户"}</span>
                                <div className="flex items-center gap-1 mt-1">
                                    <span className="w-[8px] h-[8px] rounded-full bg-[#2dd36f]"></span>
                                    <span className="ts-10 text-[var(--c-icon)] font-medium">在线</span>
                                </div>
                            </div>
                        </div>
                    </div>
                }
                rightAction={
                    <span className="relative" ref={plusMenuRef}>
                        <button
                            onClick={() => setShowPlusMenu(!showPlusMenu)}
                            className="page-back-btn"
                            type="button"
                        >
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v8M8 12h8" /></svg>
                        </button>

                        {/* Dropout '+' Menu */}
                        {showPlusMenu && (
                            <div className="g-dropdown absolute top-[40px] right-0 py-2 px-0 w-[140px] z-[100]">
                                <MenuOption
                                    icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>}
                                    label="发起聊天"
                                    onClick={() => {
                                        setShowPlusMenu(false);
                                        setShowContactPicker(true);
                                    }}
                                />
                                <MenuOption
                                    icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>}
                                    label="创建群聊"
                                    onClick={() => {
                                        setShowPlusMenu(false);
                                        setShowGroupCreate(true);
                                    }}
                                />
                                <MenuOption
                                    icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>}
                                    label="添加好友"
                                    onClick={() => {
                                        setShowPlusMenu(false);
                                        setIsSearchModalOpen(true);
                                        setSearchQuery("");
                                        setSearchResult(undefined);

                                        setIsSendingRequest(false);
                                        setGreetingText(identity?.name ? `我是${identity.name}` : "你好");
                                    }}
                                />
                            </div>
                        )}
                    </span>
                }
            >
                <div className="px-5 pt-5 pb-3">
                    <div className="flex items-center justify-between mb-4 mt-2">
                        <span className="ts-28 font-bold text-[var(--c-text-title)]">Chats</span>
                    </div>
                    <div className="chat-search-bar">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--c-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input
                            className="chat-search-input ts-15 w-full bg-transparent outline-none text-[var(--c-text-title)] placeholder:text-[var(--c-icon)]"
                            placeholder="Search chats..."
                            value={listFilter}
                            onChange={(e) => setListFilter(e.target.value)}
                        />
                    </div>
                </div>
                <div className="chat-list-tabs" style={{ paddingLeft: 20, paddingRight: 20 }}>
                    {(["all", "private", "group"] as const).map(tab => (
                        <button
                            key={tab}
                            type="button"
                            className={`chat-list-tab${listTab === tab ? " active" : ""}`}
                            onClick={() => setListTab(tab)}
                        >
                            {{ all: "All", private: "Private", group: "Groups" }[tab]}
                        </button>
                    ))}
                </div>
                <div className="px-5 pt-2 flex flex-col">
                    {(() => {
                            const contactIds = new Set(loadChatContacts().map(c => c.characterId));
                            const allChars = loadCharacters();
                            const keyword = listFilter.trim().toLowerCase();
                            const showMascot = mascotSettings.chatEnabled
                                && listTab !== "group"
                                && (!keyword || (mascotSettings.nickname || "AI助手").toLowerCase().includes(keyword));
                            const regularItems = [...sessions]
                            .filter(s => {
                                if (!(s.isGroup || contactIds.has(s.contactId))) return false;
                                if (!hasSessionListContent(s.id)) return false;
                                if (listTab === "private" && s.isGroup) return false;
                                if (listTab === "group" && !s.isGroup) return false;
                                if (!keyword) return true;
                                if (s.isGroup) return (s.groupName || "群聊").toLowerCase().includes(keyword);
                                const name = s.alias || allChars.find(c => c.id === s.contactId)?.name || "";
                                return name.toLowerCase().includes(keyword);
                            })
                            .sort((a, b) => {
                                if (a.isPinned && !b.isPinned) return -1;
                                if (!a.isPinned && b.isPinned) return 1;
                                const aTime = getSessionListTime(a);
                                const bTime = getSessionListTime(b);
                                return parseTime(bTime) - parseTime(aTime);
                            })
                            .map(s => (
                                <div key={s.id}>
                                    <SessionItem session={s} onSelect={() => onSelectSession(s)} isPinned={!!s.isPinned} />
                                </div>
                            ));
                            if (!showMascot && regularItems.length === 0) {
                                return (
                                    <div className="px-5 py-10 text-center text-[var(--c-icon)] ts-14">
                                        暂无聊天记录，点击右上角「+」发起聊天
                                    </div>
                                );
                            }
                            return (
                                <>
                                    {showMascot && (
                                        <MascotSessionItem
                                            name={mascotSettings.nickname || "AI助手"}
                                            avatarUrl={mascotAvatarUrl}
                                            preview={getMascotLastPreview()}
                                            isThinking={mascotChat.isThinking}
                                            onSelect={onSelectMascot}
                                        />
                                    )}
                                    {regularItems}
                                </>
                            );
                        })()}
                </div>
            </PageShell>

            {/* Add Friend Search Modal */}
            {isSearchModalOpen && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 9999, background: '#ffffff' }}>
                <div style={{ position: 'absolute', inset: 0, background: 'var(--c-page-body-bg)' }}>
                <PageShell title="添加朋友" onBack={() => setIsSearchModalOpen(false)}>

                    {!searchResult && searchResult !== null && (
                        <div className="page-menu">
                            <div className="menu-group">
                                <div className="menu-item">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--c-icon)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                                    <input
                                        autoFocus
                                        placeholder="微信号/手机号"
                                        value={searchQuery}
                                        onChange={(e) => {
                                            setSearchQuery(e.target.value);
                                            setSearchResult(undefined);
                                        }}
                                        className="ui-input ui-input-inline"
                                    />
                                    {searchQuery && (
                                        <button onClick={() => setSearchQuery("")} className="ui-bare-btn text-[var(--c-icon)]">
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" /></svg>
                                        </button>
                                    )}
                                </div>

                                {searchQuery.trim().length > 0 && (
                                    <button
                                        className="menu-item"
                                        onClick={() => {
                                            const chars = loadCharacters();
                                            const found = chars.find(c => c.wechatID === searchQuery.trim() || c.id === searchQuery.trim());
                                            setSearchResult(found || null);
                                        }}
                                    >
                                        <div className="menu-icon">
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--c-success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                                        </div>
                                        <div className="menu-label-group">
                                            <span className="menu-label">搜索：<span className="text-[var(--c-success)]">{searchQuery}</span></span>
                                        </div>
                                    </button>
                                )}
                            </div>

                            {/* 备选：已有角色卡但还不在联系人里，点击直接填入号码 */}
                            {(() => {
                                const contactIds = new Set(loadChatContacts().map(c => c.characterId));
                                const candidates = loadCharacters().filter(c => !contactIds.has(c.id));
                                if (candidates.length === 0 && mascotSettings.chatEnabled) return null;
                                return (
                                    <div className="menu-group" style={{ marginTop: 12 }}>
                                        <div className="menu-item" style={{ pointerEvents: "none" }}>
                                            <span className="menu-desc">还不是好友的角色（点击填入号码）</span>
                                        </div>
                                        {!mascotSettings.chatEnabled && (
                                            <button
                                                className="menu-item"
                                                onClick={() => {
                                                    updateMascotSettings({ chatEnabled: true });
                                                    setIsSearchModalOpen(false);
                                                    setSearchQuery("");
                                                    setSearchResult(undefined);
                                                    onSelectMascot();
                                                }}
                                            >
                                                <div className="add-friend-avatar" style={{ width: 36, height: 36, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "#fff" }}>
                                                    <img src={mascotAvatarUrl} className="w-full h-full object-contain p-[2px]" alt="" />
                                                </div>
                                                <div className="menu-label-group" style={{ minWidth: 0 }}>
                                                    <span className="menu-label">AI助手</span>
                                                    <span className="menu-desc">内置创作助手</span>
                                                </div>
                                            </button>
                                        )}
                                        {candidates.map(c => (
                                            <button
                                                key={c.id}
                                                className="menu-item"
                                                onClick={() => {
                                                    setSearchQuery(c.wechatID?.trim() || c.id);
                                                    setSearchResult(undefined);
                                                }}
                                            >
                                                <div className="add-friend-avatar" style={{ width: 36, height: 36, borderRadius: 8, overflow: "hidden", flexShrink: 0 }}>
                                                    {c.avatar ? (
                                                        <img src={c.avatar} className="w-full h-full object-cover" alt="" />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center bg-[var(--c-page-body-bg)] text-[var(--c-icon)]" style={{ fontSize: 14 }}>
                                                            {c.name.slice(0, 1)}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="menu-label-group" style={{ minWidth: 0 }}>
                                                    <span className="menu-label" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                                                    <span className="menu-desc" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.wechatID?.trim() || c.id}</span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                );
                            })()}
                        </div>
                    )}

                    {searchResult === null && (
                        <div className="ui-empty">
                            <span className="menu-desc">该用户不存在</span>
                        </div>
                    )}

                    {searchResult && !isSendingRequest && (
                        <div className="page-menu">
                            <div className="menu-group">
                                <div className="menu-item !items-start">
                                    <div className="add-friend-avatar">
                                        {searchResult.avatar ? (
                                            <img src={searchResult.avatar} className="w-full h-full object-cover" alt="" />
                                        ) : (
                                            <ChatFallbackAvatar />
                                        )}
                                    </div>
                                    <div className="menu-label-group">
                                        <div className="ts-18 font-bold text-[var(--c-text-title)] mb-1">{searchResult.name || "UNNAMED"}</div>
                                        <div className="menu-desc">微信号: {searchResult.wechatID || "N/A"}</div>
                                        <div className="menu-desc">个性签名: {searchResult.persona ? searchResult.persona.slice(0, 30) + (searchResult.persona.length > 30 ? "..." : "") : "暂无"}</div>
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => setIsSendingRequest(true)}
                                className="ui-btn ui-btn-success w-full"
                            >
                                添加到通讯录
                            </button>
                        </div>
                    )}

                    {isSendingRequest && searchResult && (
                        <div className="page-menu">
                            <p className="menu-group-desc mx-0">发送添加朋友申请</p>
                            <div className="menu-group">
                                <div className="menu-item !items-start">
                                    <textarea
                                        autoFocus
                                        value={greetingText}
                                        onChange={e => setGreetingText(e.target.value)}
                                        placeholder="输入打招呼信息..."
                                        className="ui-textarea ui-input-inline min-h-[60px]"
                                    />
                                    <button onClick={() => setGreetingText("")} className="ui-bare-btn text-[var(--c-icon)]">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
                                    </button>
                                </div>
                            </div>
                            <div className="flex flex-col gap-3">
                                <button
                                    onClick={() => {
                                        // 1. Add to contacts
                                        addChatContact(searchResult.id);
                                        clearRequestsForCharacter(searchResult.id);
                                        dispatchFriendRequestUpdated();
                                        // 2. Create or get session
                                        const newSession = createOrGetSession(searchResult.id);

                                        // Check if re-adding (session already has messages)
                                        const isReAdd = loadChatMessages(newSession.id).length > 0;

                                        // Resolve character-bound user identity
                                        const charIdentity = resolveUserIdentity(searchResult.id, "chat");
                                        const userName = charIdentity?.name || identity?.name || "你";

                                        // 3. Insert system message(s)
                                        if (isReAdd) {
                                            // Re-add: single message with both lines for memory
                                            const charName = searchResult.name || "用户";
                                            pushChatMessage({
                                                sessionId: newSession.id,
                                                role: "system",
                                                content: `${userName}向${charName}发起了好友申请\n${charName}通过了好友申请`,
                                                status: "sent"
                                            });
                                            // Set flag to trigger AI reply on chat room mount
                                            kvSet(PENDING_REPLY_PREFIX + newSession.id, "1");
                                        } else {
                                            pushChatMessage({
                                                sessionId: newSession.id,
                                                role: "system",
                                                content: `${userName}已添加了${searchResult.name || "用户"}，现在可以开始聊天了。`,
                                                status: "sent"
                                            });
                                        }

                                        // 4. Insert user greeting message if any
                                        if (greetingText.trim()) {
                                            pushChatMessage({
                                                sessionId: newSession.id,
                                                role: "user",
                                                content: greetingText.trim(),
                                                status: "sent"
                                            });
                                        }

                                        // 6. Open Chat
                                        setSessions(loadChatSessions());
                                        onSelectSession(newSession);
                                        setIsSearchModalOpen(false);
                                        setSearchQuery("");
                                        setSearchResult(undefined);
                                        setIsSendingRequest(false);
                                    }}
                                    className="ui-btn ui-btn-success w-full"
                                >
                                    发送
                                </button>
                                <button
                                    onClick={() => setIsSendingRequest(false)}
                                    className="ui-btn ui-btn-ghost w-full"
                                >
                                    取消
                                </button>
                            </div>
                        </div>
                    )}
                </PageShell>
                </div>
                </div>
            )}

            {/* Contact Picker */}
            {showContactPicker && (
                <ContactPicker
                    onClose={() => setShowContactPicker(false)}
                    onSelect={(charId) => {
                        const session = createOrGetSession(charId);
                        setSessions(loadChatSessions());
                        onSelectSession(session);
                        setShowContactPicker(false);
                    }}
                />
            )}

            {/* Merge Duplicate Sessions Modal */}
            {mergePrompt && (
                <div className="modal-overlay" onClick={() => setMergePrompt(null)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">检测到相同角色的重复会话</span>
                        <p className="ts-13 text-[var(--c-text)] opacity-80 mb-3">
                            勾选要合并的组：聊天记录（含线下）将并入最近活跃的会话，其余重复会话被删除；不勾选的组之后不再提醒。
                        </p>
                        <div className="flex flex-col gap-2 w-full max-h-[40vh] overflow-y-auto mb-3">
                            {mergePrompt.map(group => (
                                <div key={group.signature} className="flex items-center gap-3 p-2 rounded-lg bg-[var(--c-input)]">
                                    <div className="flex-1 overflow-hidden">
                                        <div className="ts-14 font-medium text-[var(--c-text-title)] truncate">
                                            {group.isGroup ? "群聊 " : "单聊 "}{group.label}
                                        </div>
                                        <div className="ts-12 text-[var(--c-icon)] truncate">
                                            {group.sessions.length} 个会话
                                            {group.isGroup ? ` · 成员：${group.memberNames.join("、")}` : ""}
                                        </div>
                                    </div>
                                    <Toggle
                                        checked={mergeSelected.has(group.signature)}
                                        onChange={(next) => {
                                            setMergeSelected(prev => {
                                                const nextSet = new Set(prev);
                                                if (next) nextSet.add(group.signature);
                                                else nextSet.delete(group.signature);
                                                return nextSet;
                                            });
                                        }}
                                    />
                                </div>
                            ))}
                        </div>
                        <div className="flex gap-2 w-full">
                            <button className="ui-btn ui-btn-ghost flex-1" onClick={handleMergeDismiss}>
                                暂不合并
                            </button>
                            <button
                                className="ui-btn ui-btn-primary flex-1"
                                disabled={mergeSelected.size === 0}
                                onClick={handleMergeConfirm}
                            >
                                合并所选
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Group Create Modal */}
            {showGroupCreate && (
                <GroupCreateModal
                    onClose={() => setShowGroupCreate(false)}
                    onCreate={(groupName, participantIds, isSpectator) => {
                        const newSession = createGroupSession(groupName, participantIds, { isSpectator });
                        const userName = resolveUserIdentity()?.name ?? "用户";
                        const allChars = loadCharacters();
                        const memberNames = participantIds
                            .map(id => allChars.find(c => c.id === id)?.name ?? "未知")
                            .join("、");
                        pushChatMessage({
                            sessionId: newSession.id,
                            role: "system",
                            // 围观群：用户不在群里，开群消息不能提到用户
                            content: isSpectator
                                ? `${memberNames}加入了群聊`
                                : `${userName}邀请${memberNames}加入群聊`,
                            status: "sent",
                        });
                        setSessions(loadChatSessions());
                        onSelectSession(newSession);
                        setShowGroupCreate(false);
                    }}
                />
            )}

            {/* User Profile Panel */}
            {showUserProfile && (
                <UserProfilePanel onClose={() => { setShowUserProfile(false); setIdentity(resolveUserIdentity()); }} className="absolute inset-0 z-[100]" />
            )}
        </div>
    );
}

function MenuOption({ icon, label, onClick }: { icon: React.ReactNode, label: string, onClick?: () => void }) {
    return (
        <div
            onClick={onClick}
            className="menu-option-border flex items-center gap-3 px-4 py-3 ts-14 text-[var(--c-text)] cursor-pointer"
        >
            <span className="flex items-center text-[var(--c-text)]">{icon}</span>
            <span>{label}</span>
        </div>
    );
}

function MascotSessionItem({
    name,
    avatarUrl,
    preview,
    isThinking,
    onSelect,
}: {
    name: string;
    avatarUrl: string;
    preview: string;
    isThinking: boolean;
    onSelect: () => void;
}) {
    return (
        <div className="minimal-list-item" onClick={onSelect}>
            <div className="minimal-avatar-wrapper bg-white">
                <img src={avatarUrl} className="w-full h-full object-contain pointer-events-none rounded-full p-[2px]" alt="" />
                <span className="minimal-online-dot" />
            </div>
            <div className="flex-1 overflow-hidden h-[48px] flex flex-col justify-center gap-1">
                <div className="flex justify-between items-center">
                    <span className="ts-16 font-medium text-[var(--c-text-title)] truncate">{name}</span>
                    <span className="ts-12 text-[var(--c-icon)] font-medium">AI</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                    <span className="ts-13 text-[var(--c-text)] opacity-80 truncate font-normal">
                        {isThinking ? "正在思考..." : preview}
                    </span>
                </div>
            </div>
        </div>
    );
}

function ContactPicker({ onClose, onSelect }: { onClose: () => void; onSelect: (charId: string) => void }) {
    const contacts = loadChatContacts();
    const chars = loadCharacters();

    const enrichedContacts = contacts
        .map(c => ({ ...c, char: chars.find(ch => ch.id === c.characterId) }))
        .filter(c => c.char) as (typeof contacts[number] & { char: Character })[];

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                <span className="modal-header-title">选择联系人</span>
                {enrichedContacts.length === 0 ? (
                    <span className="menu-desc">暂无联系人，请先添加好友</span>
                ) : (
                    <div className="chat-contact-list">
                        {enrichedContacts.map(c => (
                            <div
                                key={c.characterId}
                                className="chat-contact-item"
                                onClick={() => onSelect(c.characterId)}
                            >
                                <div className="chat-contact-avatar">
                                    {c.char.avatar ? (
                                        <img src={c.char.avatar} alt="" />
                                    ) : (
                                        <ChatFallbackAvatar />
                                    )}
                                </div>
                                <span className="chat-contact-name">{c.char.name}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function SessionItem({ session, onSelect, isPinned }: { session: ChatSession, onSelect: () => void, isPinned?: boolean }) {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === session.contactId);
    const lastVisibleMessage = getLastVisibleSessionMessage(session.id);
    const lastOfflineTurn = getLastChatOfflineTurn(session.id);
    // 线下记录比线上消息新时（含只在线下聊过的会话），列表展示线下摘要
    const offlineIsNewer = Boolean(lastOfflineTurn)
        && parseTime(lastOfflineTurn?.createdAt) > parseTime(lastVisibleMessage?.createdAt);
    const onlinePreview = lastVisibleMessage ? (getChatMessagePreview(lastVisibleMessage) || lastVisibleMessage.content) : "";
    const preview = offlineIsNewer ? getChatOfflineTurnPreview(lastOfflineTurn) : onlinePreview;
    const displayTime = pickLaterTime(lastVisibleMessage?.createdAt, lastOfflineTurn?.createdAt) || session.updatedAt;

    // Group chat: build grid of participant avatars (2×2)
    const isGroup = session.isGroup;
    const userIdentity = isGroup ? resolveUserIdentity(undefined, "group_chat") : null;
    const groupAvatarItems = isGroup
        ? [
            ...(userIdentity ? [{ id: "self", name: userIdentity.name || "我", avatar: userIdentity.avatarUrl || "" }] : []),
            ...((session.participantIds || [])
                .map(id => chars.find(c => c.id === id))
                .filter(Boolean) as Character[])
                .map(c => ({ id: c.id, name: c.name, avatar: c.avatar || "" })),
        ].slice(0, 4)
        : [];

    return (
        <div
            className={`minimal-list-item${isPinned ? ' chat-pinned' : ''}`}
            onClick={onSelect}
        >
            {isGroup ? (
                <div className="minimal-avatar-wrapper grid grid-cols-2 grid-rows-2 gap-[1px] p-[2px] bg-[var(--c-card-border)] rounded-full overflow-hidden">
                    {groupAvatarItems.map((c) => (
                        <div key={c.id} className="overflow-hidden rounded-[3px] bg-[var(--c-page-body-bg)]">
                            {c.avatar ? (
                                <img src={c.avatar} className="w-full h-full object-cover pointer-events-none" alt="" />
                            ) : (
                                <ChatFallbackAvatar className="pointer-events-none" />
                            )}
                        </div>
                    ))}
                    {Array.from({ length: Math.max(0, 4 - groupAvatarItems.length) }).map((_, i) => (
                        <div key={`empty-${i}`} className="overflow-hidden rounded-[3px] bg-[var(--c-page-body-bg)]" />
                    ))}
                </div>
            ) : (
                <div className="minimal-avatar-wrapper">
                    {character?.avatar ? (
                        <img src={character.avatar} className="w-full h-full object-cover pointer-events-none rounded-full" alt="" />
                    ) : (
                        <ChatFallbackAvatar className="pointer-events-none rounded-full" />
                    )}
                    <span className="minimal-online-dot" />
                </div>
            )}
            <div className="flex-1 overflow-hidden h-[48px] flex flex-col justify-center gap-1">
                <div className="flex justify-between items-center">
                    <span className="ts-16 font-medium text-[var(--c-text-title)] truncate">
                        {isGroup ? (session.groupName || "群聊") : (session.alias || character?.name || `User_${session.contactId.slice(-4)}`)}
                    </span>
                    <span className="ts-12 text-[var(--c-icon)] font-medium">
                        {formatChatUiTime(displayTime)}
                    </span>
                </div>
                <div className="flex justify-between items-center gap-2">
                    <span className="ts-13 text-[var(--c-text)] opacity-80 truncate font-normal">
                        {preview || getLastNonEmptyPreview(session.id)}
                    </span>
                </div>
            </div>
        </div>
    );
}
