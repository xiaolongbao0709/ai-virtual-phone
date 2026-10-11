"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue, useSyncExternalStore } from "react";
import { loadChatContacts, ChatContact, createOrGetSession, ChatSession, addChatContact, pushChatMessage, loadChatMessages } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { PENDING_REPLY_PREFIX } from "@/lib/friend-request-engine";
import { loadCharacters } from "@/lib/character-storage";
import { Character } from "@/lib/character-types";
import { loadMomentPosts } from "@/lib/moments-storage";
import {
    getPendingFriendRequests,
    getAutoAcceptDays,
    setAutoAcceptDays,
    clearRequestsForCharacter,
    updateFriendRequestStatus,
    dispatchFriendRequestUpdated,
    type FriendRequest,
} from "@/lib/friend-request-storage";
import {
    handleAcceptFriendRequest,
    triggerRejectReaction,
    acceptAllPendingFriendRequests,
    autoAcceptStaleFriendRequests,
} from "@/lib/friend-request-engine";
import { PageShell } from "@/components/ui/page-shell";
import { pinyin } from "pinyin-pro";
import { kvSet } from "@/lib/kv-db";
import { scrollElementWithinContainer } from "@/lib/dom-scroll";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import {
    DEFAULT_MASCOT_AVATAR,
    getMascotSettingsSnapshot,
    resolveMascotImageRef,
    subscribeMascotSettings,
    updateMascotSettings,
} from "@/lib/mascot-settings";

type ChatContactsListProps = {
    onCloseApp: () => void;
    onSelectSession: (session: ChatSession | null) => void;
    onSelectMascot: () => void;
    /** 名片点击「加好友」：切到本 tab 后待打开添加页的角色 id */
    pendingAddContactId?: string | null;
    onPendingAddContactConsumed?: () => void;
    /** 名片来源的添加页按返回时回到原聊天室 */
    onPendingAddContactBack?: () => void;
};

export function ChatContactsList({ onCloseApp, onSelectSession, onSelectMascot, pendingAddContactId, onPendingAddContactConsumed, onPendingAddContactBack }: ChatContactsListProps) {
    const [contacts, setContacts] = useState<(ChatContact & { char?: Character })[]>([]);
    const [contactFilter, setContactFilter] = useState("");
    const [latestPost, setLatestPost] = useState<Record<string, string>>({});
    const [pendingRequests, setPendingRequests] = useState<FriendRequest[]>([]);
    const [showRequestList, setShowRequestList] = useState(false);
    const [selectedRequest, setSelectedRequest] = useState<FriendRequest | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [confirmAcceptAll, setConfirmAcceptAll] = useState(false);
    const [autoDays, setAutoDays] = useState<number>(() => getAutoAcceptDays());
    const [isAddFriendOpen, setIsAddFriendOpen] = useState(false);
    const [addQuery, setAddQuery] = useState("");
    const [addResult, setAddResult] = useState<Character | null | undefined>(undefined);
    const [isSendingAdd, setIsSendingAdd] = useState(false);
    const [greetingText, setGreetingText] = useState("");
    // 添加页是否由名片打开：返回时应回到原聊天室而非联系人列表
    const addFromCardRef = useRef(false);
    const mascotSettings = useSyncExternalStore(subscribeMascotSettings, getMascotSettingsSnapshot, getMascotSettingsSnapshot);
    const [mascotAvatarUrl, setMascotAvatarUrl] = useState(mascotSettings.avatarImage || DEFAULT_MASCOT_AVATAR);

    const identity = useMemo(() => resolveUserIdentity(), []);
    const chars = useMemo(() => loadCharacters(), []);
    const deferredContactFilter = useDeferredValue(contactFilter);
    const bodyRef = useRef<HTMLDivElement>(null);
    const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

    useEffect(() => {
        let cancelled = false;
        resolveMascotImageRef(mascotSettings.avatarImage).then((url) => {
            if (!cancelled) setMascotAvatarUrl(url);
        });
        return () => { cancelled = true; };
    }, [mascotSettings.avatarImage]);

    // 名片点击「添加到通讯录」：phone-chat-app 切到本 tab 后由 prop 传入待添加角色，
    // 打开添加页并预载资料（本组件仅在 tab 激活时挂载，不能直接监听事件）
    useEffect(() => {
        if (!pendingAddContactId) return;
        const found = loadCharacters().find(c => c.id === pendingAddContactId);
        onPendingAddContactConsumed?.();
        if (!found) return;
        addFromCardRef.current = true;
        setIsAddFriendOpen(true);
        setAddQuery(found.wechatID || found.id);
        setAddResult(found);
        setIsSendingAdd(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingAddContactId]);

    /** Get the pinyin initial letter (uppercase A-Z), fallback to # */
    function getInitial(name: string): string {
        if (!name) return "#";
        const first = name.charAt(0);
        // Already A-Z or a-z
        if (/[a-zA-Z]/.test(first)) return first.toUpperCase();
        // Chinese → pinyin
        const py = pinyin(first, { toneType: "none", type: "array" });
        if (py.length > 0 && /[a-zA-Z]/.test(py[0].charAt(0))) {
            return py[0].charAt(0).toUpperCase();
        }
        return "#";
    }

    const refresh = useCallback(() => {
        // 保底：超时未处理的好友申请自动通过（完成后会派发事件再刷新一次）
        autoAcceptStaleFriendRequests().catch(() => {});
        const rawContacts = loadChatContacts();
        const enriched = rawContacts.map(c => ({
            ...c,
            char: chars.find(ch => ch.id === c.characterId)
        })).filter(c => c.char);
        enriched.sort((a, b) => (a.char?.name || "").localeCompare(b.char?.name || ""));
        setContacts(enriched);

        const posts = loadMomentPosts();
        const map: Record<string, string> = {};
        for (const p of posts) {
            if (!map[p.authorId]) map[p.authorId] = p.content;
        }
        setLatestPost(map);

        setPendingRequests(getPendingFriendRequests());
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        refresh();
        const handler = () => refresh();
        window.addEventListener("friend-requests-updated", handler);
        return () => window.removeEventListener("friend-requests-updated", handler);
    }, [refresh]);

    /** Group contacts by pinyin initial */
    const { grouped, indexLetters } = useMemo(() => {
        const keyword = deferredContactFilter.trim().toLowerCase();
        const filtered = keyword
            ? contacts.filter(c => (c.char?.name || "").toLowerCase().includes(keyword))
            : contacts;
        const map: Record<string, typeof contacts> = {};
        for (const c of filtered) {
            const letter = getInitial(c.char?.name || "");
            (map[letter] ??= []).push(c);
        }
        // Sort keys: A-Z first, then #
        const sorted = Object.keys(map).sort((a, b) => {
            if (a === "#") return 1;
            if (b === "#") return -1;
            return a.localeCompare(b);
        });
        return { grouped: map, indexLetters: sorted };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contacts, deferredContactFilter]);

    const handleAccept = async (req: FriendRequest) => {
        setIsProcessing(true);
        try {
            const session = await handleAcceptFriendRequest(req.characterId, req.message);
            setSelectedRequest(null);
            setShowRequestList(false);
            refresh();
            onSelectSession(session);
        } catch (err) {
            console.warn("[Contacts] Accept friend request failed:", err);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleAcceptAll = async () => {
        if (!confirmAcceptAll) {
            setConfirmAcceptAll(true);
            return;
        }
        setIsProcessing(true);
        try {
            await acceptAllPendingFriendRequests();
            setConfirmAcceptAll(false);
            setShowRequestList(false);
            refresh();
        } finally {
            setIsProcessing(false);
        }
    };

    const handleReject = async (req: FriendRequest) => {
        setIsProcessing(true);
        try {
            updateFriendRequestStatus(req.id, "rejected");
            dispatchFriendRequestUpdated();
            setSelectedRequest(null);

            // Trigger AI's next attempt (fire-and-forget)
            triggerRejectReaction(req.characterId).catch(() => {});
            refresh();
        } finally {
            setIsProcessing(false);
        }
    };

    const getCharForRequest = (req: FriendRequest) =>
        chars.find(c => c.id === req.characterId);

    return (
        <div className="relative flex-1 h-full">
            <PageShell
                title="Contacts"
                onBack={onCloseApp}
                bodyRef={bodyRef}
                rightAction={
                    <button
                        className="page-back-btn"
                        type="button"
                        onClick={() => {
                            addFromCardRef.current = false;
                            setIsAddFriendOpen(true);
                            setAddQuery("");
                            setAddResult(undefined);
                            setIsSendingAdd(false);
                            setGreetingText(identity?.name ? `我是${identity.name}` : "你好");
                        }}
                    >
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v8M8 12h8" /></svg>
                    </button>
                }
            >
            <div className="px-5">
                {/* Search bar */}
                <div className="pt-5 pb-1">
                    <div className="flex items-center justify-between mb-4 mt-2">
                        <span className="ts-28 font-bold text-[var(--c-text-title)]">Contacts</span>
                    </div>
                    <div className="chat-search-bar">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--c-icon)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input
                            className="chat-search-input ts-15 w-full bg-transparent outline-none text-[var(--c-text-title)] placeholder:text-[var(--c-icon)]"
                            placeholder="Search contacts..."
                            value={contactFilter}
                            onChange={(e) => setContactFilter(e.target.value)}
                        />
                    </div>
                </div>

                {/* New Friends entry */}
                <div className="mb-3 mt-3">
                    <div
                        className="minimal-list-item"
                        onClick={() => pendingRequests.length > 0 && setShowRequestList(true)}
                    >
                        <div className="w-[48px] h-[48px] rounded-full bg-[var(--c-action-blue,#246bfd)] flex items-center justify-center shrink-0">
                            <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <line x1="19" y1="8" x2="19" y2="14" />
                                <line x1="22" y1="11" x2="16" y2="11" />
                            </svg>
                        </div>
                        <div className="flex-1 overflow-hidden h-[48px] flex flex-col justify-center">
                            <div className="ts-16 font-medium text-[var(--c-text-title)]">New Friends</div>
                        </div>
                        {pendingRequests.length > 0 && (
                            <div className="minimal-unread-count ml-auto shrink-0">{pendingRequests.length}</div>
                        )}
                    </div>
                </div>

                {mascotSettings.chatEnabled && (
                    <div className="mb-3">
                        <div className="minimal-list-item" onClick={onSelectMascot}>
                            <div className="minimal-avatar-wrapper bg-white">
                                <img src={mascotAvatarUrl} className="w-full h-full object-contain rounded-full p-[2px]" alt="" />
                                <span className="minimal-online-dot" />
                            </div>
                            <div className="flex-1 overflow-hidden h-[48px] flex flex-col justify-center gap-1">
                                <div className="ts-16 font-medium text-[var(--c-text-title)] truncate">{mascotSettings.nickname || "AI助手"}</div>
                                <div className="ts-13 text-[var(--c-text)] opacity-80 truncate font-normal">内置创作助手</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Contacts list grouped by pinyin initial */}
                {contacts.length === 0 ? (
                    <div className="ui-empty">
                        <span className="menu-desc">暂无联系人，去消息页右上角添加吧</span>
                    </div>
                ) : (
                    <div className="flex flex-col gap-1">
                        {indexLetters.map(letter => (
                            <div key={letter} ref={el => { sectionRefs.current[letter] = el; }} className="flex flex-col gap-0">
                                <div className="contact-letter-header text-[var(--c-icon)] py-2 ts-13 pl-1 font-semibold">{letter}</div>
                                {grouped[letter].map(c => {
                                    const char = c.char!;
                                    return (
                                        <div
                                            key={c.id}
                                            onClick={() => {
                                                const sess = createOrGetSession(char.id);
                                                onSelectSession(sess);
                                            }}
                                            className="minimal-list-item"
                                        >
                                            <div className="minimal-avatar-wrapper">
                                                {char.avatar ? (
                                                    <img src={char.avatar} className="w-full h-full object-cover rounded-full" alt="" />
                                                ) : (
                                                    <ChatFallbackAvatar className="rounded-full" />
                                                )}
                                            </div>
                                            <div className="flex-1 overflow-hidden h-[48px] flex flex-col justify-center gap-1">
                                                <div className="ts-16 font-medium text-[var(--c-text-title)] truncate">
                                                    {char.name || "UNNAMED"}
                                                </div>
                                                <div className="ts-13 text-[var(--c-text)] opacity-80 truncate font-normal">
                                                    {latestPost[char.id] || "暂无动态"}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                )}

                {/* Right-side alphabet index */}
                {indexLetters.length > 0 && (
                    <div className="contact-alpha-index">
                        {indexLetters.map(letter => (
                            <div
                                key={letter}
                                className="contact-alpha-letter"
                                onClick={() => {
                                    scrollElementWithinContainer(bodyRef.current, sectionRefs.current[letter], { behavior: "smooth", block: "start" });
                                }}
                            >
                                {letter}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Friend Request List Modal */}
            {showRequestList && (
                <div className="modal-overlay" onClick={() => setShowRequestList(false)}>
                    <div className="modal-dialog freq-dialog" onClick={e => e.stopPropagation()}>
                        <div className="ts-17 font-semibold text-center text-[var(--c-text-title)]">
                            新的朋友
                        </div>
                        {pendingRequests.length > 1 && (
                            <button
                                onClick={handleAcceptAll}
                                disabled={isProcessing}
                                className="ui-btn ui-btn-success w-full"
                            >
                                {isProcessing
                                    ? "处理中..."
                                    : confirmAcceptAll
                                        ? `再点一次，确认全部通过（${pendingRequests.length}人）`
                                        : `全部同意（${pendingRequests.length}人）`}
                            </button>
                        )}
                        {pendingRequests.length === 0 ? (
                            <div className="py-6 text-center text-[var(--c-text)] ts-14">
                                暂无好友申请
                            </div>
                        ) : (
                            <div className="freq-list">
                                {pendingRequests.map(req => {
                                    const char = getCharForRequest(req);
                                    return (
                                        <div
                                            key={req.id}
                                            className="freq-list-item"
                                            onClick={() => setSelectedRequest(req)}
                                        >
                                            <div className="freq-avatar">
                                                {char?.avatar ? (
                                                    <img src={char.avatar} alt="" />
                                                ) : (
                                                    <div className="freq-avatar-fallback">
                                                        {(char?.name || "?")[0]}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex-1 overflow-hidden">
                                                <div className="menu-label font-medium truncate">
                                                    {char?.name || "未知角色"}
                                                </div>
                                                <div className="ts-12 text-[var(--c-text)] truncate mt-[2px]">
                                                    {req.message}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        <div className="ts-12 text-[var(--c-text)] flex items-center justify-between gap-2">
                            <span>超过多久没处理，自动通过</span>
                            <select
                                value={autoDays}
                                onChange={e => {
                                    const n = Number(e.target.value);
                                    setAutoDays(n);
                                    setAutoAcceptDays(n);
                                }}
                                style={{ padding: "2px 6px", borderRadius: 6, border: "1px solid var(--c-border, #ddd)", background: "transparent", color: "inherit" }}
                            >
                                <option value={0}>关闭</option>
                                <option value={1}>1天</option>
                                <option value={3}>3天</option>
                                <option value={7}>7天</option>
                                <option value={14}>14天</option>
                            </select>
                        </div>
                        <button
                            onClick={() => { setConfirmAcceptAll(false); setShowRequestList(false); }}
                            className="ui-btn ui-btn-ghost w-full"
                        >
                            关闭
                        </button>
                    </div>
                </div>
            )}

            {/* Friend Request Detail Modal */}
            {selectedRequest && (() => {
                const char = getCharForRequest(selectedRequest);
                return (
                    <div className="modal-overlay" onClick={() => !isProcessing && setSelectedRequest(null)}>
                        <div className="modal-dialog freq-dialog" onClick={e => e.stopPropagation()}>
                            {/* Avatar */}
                            <div className="freq-detail-avatar">
                                {char?.avatar ? (
                                    <img src={char.avatar} alt="" />
                                ) : (
                                    <div className="freq-avatar-fallback" style={{ fontSize: "calc(28px*var(--app-text-scale,1))" }}>
                                        {(char?.name || "?")[0]}
                                    </div>
                                )}
                            </div>

                            {/* Name */}
                            <div className="ts-17 font-semibold text-center text-[var(--c-text)]">
                                {char?.name || "未知角色"}
                            </div>

                            {/* Message */}
                            <div className="freq-detail-msg">
                                {selectedRequest.message}
                            </div>

                            {/* Actions */}
                            <div className="flex gap-3 w-full">
                                <button
                                    onClick={() => handleReject(selectedRequest)}
                                    disabled={isProcessing}
                                    className="ui-btn ui-btn-ghost flex-1"
                                >
                                    拒绝
                                </button>
                                <button
                                    onClick={() => handleAccept(selectedRequest)}
                                    disabled={isProcessing}
                                    className="ui-btn ui-btn-success flex-1"
                                >
                                    {isProcessing ? "处理中..." : "接受"}
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            </PageShell>

            {/* Add Friend Modal */}
            {isAddFriendOpen && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 9999, background: '#ffffff' }}>
                <div style={{ position: 'absolute', inset: 0, background: 'var(--c-page-body-bg)' }}>
                <PageShell title="添加朋友" onBack={() => { setIsAddFriendOpen(false); if (addFromCardRef.current) { addFromCardRef.current = false; onPendingAddContactBack?.(); } }}>
                    {!addResult && addResult !== null && (
                        <div className="page-menu">
                            <div className="menu-group">
                                <div className="menu-item">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--c-icon)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                    <input
                                        autoFocus
                                        placeholder="微信号/手机号"
                                        value={addQuery}
                                        onChange={(e) => { setAddQuery(e.target.value); setAddResult(undefined); }}
                                        className="ui-input ui-input-inline"
                                    />
                                    {addQuery && (
                                        <button onClick={() => setAddQuery("")} className="ui-bare-btn text-[var(--c-icon)]">
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" /></svg>
                                        </button>
                                    )}
                                </div>
                                {addQuery.trim().length > 0 && (
                                    <button
                                        className="menu-item"
                                        onClick={() => {
                                            const found = chars.find(c => c.wechatID === addQuery.trim() || c.id === addQuery.trim());
                                            setAddResult(found || null);
                                        }}
                                    >
                                        <div className="menu-icon">
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--c-success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                        </div>
                                        <div className="menu-label-group">
                                            <span className="menu-label">搜索：<span className="text-[var(--c-success)]">{addQuery}</span></span>
                                        </div>
                                    </button>
                                )}
                            </div>
                            {!mascotSettings.chatEnabled && (
                                <div className="menu-group" style={{ marginTop: 12 }}>
                                    <div className="menu-item" style={{ pointerEvents: "none" }}>
                                        <span className="menu-desc">可添加的内置助手</span>
                                    </div>
                                    <button
                                        className="menu-item"
                                        onClick={() => {
                                            updateMascotSettings({ chatEnabled: true });
                                            addFromCardRef.current = false;
                                            setIsAddFriendOpen(false);
                                            setAddQuery("");
                                            setAddResult(undefined);
                                            setIsSendingAdd(false);
                                            onSelectMascot();
                                        }}
                                    >
                                        <div className="add-friend-avatar" style={{ width: 36, height: 36, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "#fff" }}>
                                            <img src={mascotAvatarUrl} className="w-full h-full object-contain p-[2px]" alt="" />
                                        </div>
                                        <div className="menu-label-group" style={{ minWidth: 0 }}>
                                            <span className="menu-label">AI助手</span>
                                            <span className="menu-desc">重新添加后不会自动打招呼</span>
                                        </div>
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {addResult === null && (
                        <div className="ui-empty"><span className="menu-desc">该用户不存在</span></div>
                    )}
                    {addResult && !isSendingAdd && (
                        <div className="page-menu">
                            <div className="menu-group">
                                <div className="menu-item !items-start">
                                    <div className="add-friend-avatar">
                                        {addResult.avatar ? (
                                            <img src={addResult.avatar} className="w-full h-full object-cover" alt="" />
                                        ) : (
                                            <ChatFallbackAvatar />
                                        )}
                                    </div>
                                    <div className="menu-label-group">
                                        <div className="ts-18 font-bold text-[var(--c-text-title)] mb-1">{addResult.name || "UNNAMED"}</div>
                                        <div className="menu-desc">微信号: {addResult.wechatID || "N/A"}</div>
                                        <div className="menu-desc">个性签名: {addResult.persona ? addResult.persona.slice(0, 30) + (addResult.persona.length > 30 ? "..." : "") : "暂无"}</div>
                                    </div>
                                </div>
                            </div>
                            <button onClick={() => setIsSendingAdd(true)} className="ui-btn ui-btn-success w-full">添加到通讯录</button>
                        </div>
                    )}
                    {isSendingAdd && addResult && (
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
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 6.41 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" /></svg>
                                    </button>
                                </div>
                            </div>
                            <div className="flex flex-col gap-3">
                                <button
                                    onClick={() => {
                                        addChatContact(addResult.id);
                                        clearRequestsForCharacter(addResult.id);
                                        dispatchFriendRequestUpdated();
                                        const newSession = createOrGetSession(addResult.id);
                                        const isReAdd = loadChatMessages(newSession.id).length > 0;
                                        const charIdentity = resolveUserIdentity(addResult.id, "chat");
                                        const userName = charIdentity?.name || identity?.name || "你";
                                        if (isReAdd) {
                                            const charName = addResult.name || "用户";
                                            pushChatMessage({ sessionId: newSession.id, role: "system", content: `${userName}向${charName}发起了好友申请\n${charName}通过了好友申请`, status: "sent" });
                                            kvSet(PENDING_REPLY_PREFIX + newSession.id, "1");
                                        } else {
                                            pushChatMessage({ sessionId: newSession.id, role: "system", content: `${userName}已添加了${addResult.name || "用户"}，现在可以开始聊天了。`, status: "sent" });
                                        }
                                        if (greetingText.trim()) {
                                            pushChatMessage({ sessionId: newSession.id, role: "user", content: greetingText.trim(), status: "sent" });
                                        }
                                        refresh();
                                        onSelectSession(newSession);
                                        addFromCardRef.current = false;
                                        setIsAddFriendOpen(false);
                                    }}
                                    className="ui-btn ui-btn-success w-full"
                                >发送</button>
                                <button onClick={() => setIsSendingAdd(false)} className="ui-btn ui-btn-ghost w-full">取消</button>
                            </div>
                        </div>
                    )}
                </PageShell>
                </div>
                </div>
            )}
        </div>
    );
}
