"use client";

import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { getAllPosts, deleteMomentPost, getUnreadMomentsNotifications, saveMomentsLastSeen, addMomentComment } from "@/lib/moments-storage";
import { loadChatContacts } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { getActiveChatWorldId, setActiveChatWorldId } from "@/lib/character-world-storage";
import { saveChatImageToIndexedDB, getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import type { MomentComment, MomentPost } from "@/lib/moments-types";
import { MomentPostCard } from "./moment-post-card";
import { MomentsCompose } from "./moments-compose";
import { ConfirmDialog } from "@/components/ui/modal";
import { PageShell } from "@/components/ui/page-shell";
import { AlertCircle } from "lucide-react";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { onUserComment, MOMENT_PHOTO_GENERATION_FAILED_EVENT } from "@/lib/moments-engine";
import { GeneratedImageErrorDialog } from "./generated-image-error-dialog";

const COVER_ASSET_KEY = "moments_cover_asset_id";
registerKvMigration(COVER_ASSET_KEY);
registerKvMigration("moments_signature");

const MOMENTS_INITIAL_POST_COUNT = 10;
const MOMENTS_LOAD_MORE_COUNT = 10;

type MomentScrollAnchorSnapshot = {
    postId: string;
    offsetDelta: number;
};

type ActiveMomentComposer = {
    postId: string;
    replyTo?: {
        commentId: string;
        authorId: string;
        authorType: "user" | "character" | "npc";
        name: string;
    };
};

type MomentsFeedProps = {
    onCloseApp: () => void;
};

export function MomentsFeed({ onCloseApp }: MomentsFeedProps) {
    const [posts, setPosts] = useState<MomentPost[]>([]);
    const [activeWorldId, setActiveWorldId] = useState<string>(() => getActiveChatWorldId());
    const [showCompose, setShowCompose] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    // 后台生图失败：弹一次弹窗提示，关掉即消失（同时多条失败只提示第一条）
    const [photoFailureNotice, setPhotoFailureNotice] = useState<string | null>(null);
    const [coverUrl, setCoverUrl] = useState<string | null>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [userIdentity, setUserIdentity] = useState<any>(() => resolveUserIdentity(undefined, "chat"));
    useEffect(() => {
        setUserIdentity(resolveUserIdentity(undefined, "chat"));
    }, [activeWorldId]);
    const [signature, setSignature] = useState(() => {
        if (typeof window !== "undefined") {
            return kvGet("moments_signature") || "make every day count (●ˇ∀ˇ●)";
        }
        return "make every day count (●ˇ∀ˇ●)";
    });
    const [editingSignature, setEditingSignature] = useState(false);
    const sigInputRef = useRef<HTMLInputElement>(null);
    const handleSignatureSubmit = (val: string) => {
        const trimmed = val.trim() || "make every day count (●ˇ∀ˇ●)";
        setSignature(trimmed);
        kvSet("moments_signature", trimmed);
        setEditingSignature(false);
    };

    const [unreadNotifs, setUnreadNotifs] = useState<ReturnType<typeof getUnreadMomentsNotifications>>([]);
    const [showNotifModal, setShowNotifModal] = useState(false);
    const [headerScrolled, setHeaderScrolled] = useState(false);
    const [visiblePostCount, setVisiblePostCount] = useState(MOMENTS_INITIAL_POST_COUNT);
    const [activeComposer, setActiveComposer] = useState<ActiveMomentComposer | null>(null);
    const [composerText, setComposerText] = useState("");
    const composerInputRef = useRef<HTMLTextAreaElement>(null);
    const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
    const loadMoreAnchorRef = useRef<MomentScrollAnchorSnapshot | null>(null);
    const loadMoreResizeObserverRef = useRef<ResizeObserver | null>(null);
    const loadMoreAnchorTimerRef = useRef<number | null>(null);

    const getScrollElement = useCallback(() => {
        if (scrollRef.current) return scrollRef.current;
        if (typeof document === "undefined") return null;
        const el = document.querySelector<HTMLDivElement>(".moments-feed-page .page-body");
        if (el) scrollRef.current = el;
        return el;
    }, []);

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

    const refreshPosts = useCallback(() => {
        const contactIds = new Set(loadChatContacts().map(c => c.characterId));
        let allFiltered = getAllPosts().filter(p => p.authorType === "user" || contactIds.has(p.authorId));
        setPosts(allFiltered);
        setUnreadNotifs(getUnreadMomentsNotifications());
    }, []);

    const captureScrollAnchor = useCallback((): MomentScrollAnchorSnapshot | null => {
        const el = getScrollElement();
        if (!el) return null;
        const containerRect = el.getBoundingClientRect();
        const candidates = Array.from(el.querySelectorAll<HTMLElement>("[data-moment-post-id]"));
        for (const candidate of candidates) {
            const rect = candidate.getBoundingClientRect();
            if (rect.bottom <= containerRect.top) continue;
            if (rect.top >= containerRect.bottom) continue;
            const postId = candidate.dataset.momentPostId;
            if (!postId) continue;
            return {
                postId,
                offsetDelta: candidate.offsetTop - el.scrollTop,
            };
        }
        return null;
    }, [getScrollElement]);

    const restoreScrollAnchor = useCallback((anchor: MomentScrollAnchorSnapshot | null): boolean => {
        const el = getScrollElement();
        if (!el || !anchor) return false;
        const target = Array.from(el.querySelectorAll<HTMLElement>("[data-moment-post-id]"))
            .find(candidate => candidate.dataset.momentPostId === anchor.postId);
        if (!target) return false;
        el.scrollTop = target.offsetTop - anchor.offsetDelta;
        return true;
    }, [getScrollElement]);

    const watchLoadMoreAnchorImages = useCallback((anchor: MomentScrollAnchorSnapshot | null) => {
        const el = getScrollElement();
        if (!el || !anchor) {
            stopLoadMoreAnchorTracking();
            return;
        }
        const target = Array.from(el.querySelectorAll<HTMLElement>("[data-moment-post-id]"))
            .find(candidate => candidate.dataset.momentPostId === anchor.postId);
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
    }, [getScrollElement, restoreScrollAnchor, stopLoadMoreAnchorTracking]);

    const worldGroups = useMemo(() => {
        return (typeof window !== "undefined") ? require("@/lib/character-world-storage").loadCharacterWorldGroups() : [];
    }, []);

    const activeWorld = activeWorldId === "all" ? null : worldGroups.find((g: any) => g.id === activeWorldId);
    const activeWorldMemberIds = useMemo(
        () => (activeWorld ? new Set<string>(activeWorld.memberIds) : null),
        [activeWorld]
    );

    const filteredPosts = useMemo(() => {
        if (!activeWorldMemberIds) return posts;
        return posts.filter(post => {
            if (post.authorType === 'character') {
                return activeWorldMemberIds.has(post.authorId);
            }
            // 用户自己的动态：只有可见名单里至少有一个本世界角色时，才出现在该世界
            return (post.visibility ?? []).some(id => activeWorldMemberIds.has(id));
        });
    }, [posts, activeWorldMemberIds]);

    const visiblePosts = filteredPosts.slice(0, visiblePostCount);
    const hasMorePosts = visiblePostCount < filteredPosts.length;

    const handleLoadMorePosts = useCallback(() => {
        if (!hasMorePosts) return;
        stopLoadMoreAnchorTracking();
        const el = getScrollElement();
        if (el) {
            loadMoreAnchorRef.current = captureScrollAnchor();
            loadMoreRestoreRef.current = {
                scrollHeight: el.scrollHeight,
                scrollTop: el.scrollTop,
            };
        }
        setVisiblePostCount(current => Math.min(current + MOMENTS_LOAD_MORE_COUNT, posts.length));
    }, [captureScrollAnchor, getScrollElement, hasMorePosts, posts.length, stopLoadMoreAnchorTracking]);

    const closeComposer = useCallback(() => {
        setActiveComposer(null);
        setComposerText("");
        composerInputRef.current?.blur();
    }, []);

    const openCommentComposer = useCallback((post: MomentPost) => {
        setComposerText("");
        setActiveComposer({ postId: post.id });
    }, []);

    const openReplyComposer = useCallback((post: MomentPost, comment: MomentComment, replyName: string) => {
        setComposerText("");
        setActiveComposer({
            postId: post.id,
            replyTo: {
                commentId: comment.id,
                authorId: comment.authorId,
                authorType: comment.authorType,
                name: replyName,
            },
        });
    }, []);

    const submitComposer = useCallback(() => {
        const text = composerText.trim();
        const target = activeComposer;
        if (!text || !target) return;

        addMomentComment({
            postId: target.postId,
            authorType: "user",
            authorId: "user",
            content: text,
            replyToCommentId: target.replyTo?.commentId,
            replyToAuthorId: target.replyTo?.authorId,
            replyToAuthorType: target.replyTo?.authorType,
        });

        closeComposer();
        refreshPosts();
        window.dispatchEvent(new CustomEvent("moments-updated"));
        onUserComment(target.postId);
    }, [activeComposer, closeComposer, composerText, refreshPosts]);

    useEffect(() => {
        if (!activeComposer) return;
        const timer = window.setTimeout(() => {
            composerInputRef.current?.focus({ preventScroll: true });
        }, 40);
        return () => window.clearTimeout(timer);
    }, [activeComposer]);

    useEffect(() => {
        if (!activeComposer) return;
        const exists = posts.some(post => post.id === activeComposer.postId);
        if (!exists) closeComposer();
    }, [activeComposer, closeComposer, posts]);

    useLayoutEffect(() => {
        const restore = loadMoreRestoreRef.current;
        if (!restore) return;
        const el = getScrollElement();
        const anchor = loadMoreAnchorRef.current;
        if (el && !restoreScrollAnchor(anchor)) {
            el.scrollTop = restore.scrollTop;
        }
        loadMoreRestoreRef.current = null;
        watchLoadMoreAnchorImages(anchor);
    }, [getScrollElement, restoreScrollAnchor, visiblePostCount, watchLoadMoreAnchorImages]);

    useEffect(() => {
        const bodyEl = getScrollElement();
        if (!bodyEl) return;
        
        const handleScroll = () => {
            setHeaderScrolled(bodyEl.scrollTop > 160);
        };
        bodyEl.addEventListener('scroll', handleScroll, { passive: true });
        return () => bodyEl.removeEventListener('scroll', handleScroll);
    }, [getScrollElement]);

    // Load posts + start background service + load cover
    useEffect(() => {
        refreshPosts();

        const handler = () => refreshPosts();
        window.addEventListener("moments-updated", handler);

        const photoFailureHandler = (event: Event) => {
            const reason = (event as CustomEvent<{ message?: string }>).detail?.message;
            setPhotoFailureNotice(prev => prev ?? (reason || "生图配置未启用或生成失败"));
        };
        window.addEventListener(MOMENT_PHOTO_GENERATION_FAILED_EVENT, photoFailureHandler);

        // Load saved cover image
        const savedId = kvGet(COVER_ASSET_KEY);
        if (savedId) {
            getChatImageFromIndexedDB(savedId).then(url => {
                if (url) setCoverUrl(url);
            });
        }

        return () => {
            window.removeEventListener("moments-updated", handler);
            window.removeEventListener(MOMENT_PHOTO_GENERATION_FAILED_EVENT, photoFailureHandler);
        };
    }, [refreshPosts]);

    // Hide tab bar only when the full compose page is open.
    useEffect(() => {
        window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: showCompose }));
        return () => {
            window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false }));
        };
    }, [showCompose]);


    const handleDeleteConfirm = () => {
        if (confirmDeleteId) {
            deleteMomentPost(confirmDeleteId);
            setConfirmDeleteId(null);
            refreshPosts();
            window.dispatchEvent(new CustomEvent("moments-updated"));
        }
    };

    const handlePublished = () => {
        setShowCompose(false);
        refreshPosts();
        window.dispatchEvent(new CustomEvent("moments-updated"));
    };

    const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            const maxSize = 800;
            let w = img.width, h = img.height;
            if (w > maxSize || h > maxSize) {
                if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
                else { w = Math.round(w * maxSize / h); h = maxSize; }
            }
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d")!;
            ctx.drawImage(img, 0, 0, w, h);
            canvas.toBlob(blob => {
                URL.revokeObjectURL(objectUrl);
                if (!blob) return;
                saveChatImageToIndexedDB(blob).then(assetId => {
                    kvSet(COVER_ASSET_KEY, assetId);
                    getChatImageFromIndexedDB(assetId).then(url => {
                        if (url) setCoverUrl(url);
                    });
                });
            }, "image/jpeg", 0.8);
        };
        img.src = objectUrl;
        // Reset so same file can be re-selected
        e.target.value = "";
    };

    return (
        <>
        {photoFailureNotice && (
            <GeneratedImageErrorDialog
                message={photoFailureNotice}
                onClose={() => setPhotoFailureNotice(null)}
            />
        )}
        <PageShell
            title="动态"
            onBack={onCloseApp}
            rightAction={
                <button
                    onClick={() => setShowCompose(true)}
                    className="page-back-btn"
                    title="发布朋友圈"
                    type="button"
                    aria-label="发布朋友圈"
                >
                    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" stroke="currentColor">
                        <rect x="2" y="6" width="20" height="14" rx="2" />
                        <circle cx="12" cy="13" r="4" />
                        <path d="M8 6l1-3h6l1 3" />
                    </svg>
                </button>
            }
            className={`moments-feed-page ${headerScrolled ? "is-scrolled" : ""} ${activeComposer ? "has-comment-modal" : ""}`}
            bodyRef={scrollRef}
            footer={showCompose ? (
                <MomentsCompose
                    onClose={() => setShowCompose(false)}
                    onPublished={handlePublished}
                    allowedCharacterIds={activeWorldMemberIds ? Array.from(activeWorldMemberIds) : undefined}
                />
            ) : activeComposer ? (
                <div className="feed-comment-modal-layer" data-ui="modal">
                    <button
                        type="button"
                        className="feed-comment-modal-backdrop"
                        aria-label="关闭评论输入"
                        onClick={closeComposer}
                    />
                    <div
                        className="feed-comment-modal-dialog"
                        data-ui="modal-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label={activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "发表评论"}
                    >
                        <div className="feed-comment-modal-title">
                            {activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "发表评论"}
                        </div>
                        <textarea
                            ref={composerInputRef}
                            value={composerText}
                            onChange={e => setComposerText(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    submitComposer();
                                } else if (e.key === "Escape") {
                                    closeComposer();
                                }
                            }}
                            placeholder={activeComposer.replyTo ? `回复 ${activeComposer.replyTo.name}` : "说点什么吧"}
                            className="feed-comment-modal-input"
                        />
                        <div className="feed-comment-modal-actions">
                            <button
                                type="button"
                                className="feed-comment-modal-cancel"
                                onClick={closeComposer}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className="feed-comment-modal-send"
                                disabled={!composerText.trim()}
                                onClick={submitComposer}
                            >
                                发送
                            </button>
                        </div>
                    </div>
                </div>
            ) : undefined}
        >
                {/* Cover card + avatar wrapper */}
                <div className="feed-cover-shell w-full relative mb-4">
                    
                    {/* Background Absolute Cover */}
                    <div
                        onClick={() => coverInputRef.current?.click()}
                        className="feed-cover-bg absolute inset-0 w-full h-full bg-[var(--c-input)] cursor-pointer z-0"
                        style={{ 
                            maskImage: "linear-gradient(to bottom, black 40%, transparent 100%)",
                            WebkitMaskImage: "linear-gradient(to bottom, black 40%, transparent 100%)"
                        }}
                    >
                        {coverUrl && (
                            <img
                                src={coverUrl}
                                alt=""
                                className="feed-cover-image w-full h-full object-cover"
                            />
                        )}
                    </div>
                    <input
                        ref={coverInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleCoverUpload}
                        className="hidden"
                    />

                    {/* Content Container (Layered above absolute bg) */}
                    <div
                        className="feed-profile relative w-full px-5 pb-5 pointer-events-none"
                        style={{ paddingTop: "calc(var(--page-header-safe-top, 48px) + var(--page-header-content-height, 54px) + 160px)" }}
                    >
                        {/* Avatar */}
                        <div className="feed-profile-avatar w-[72px] h-[72px] rounded-full border-[3px] border-[var(--c-page-body-bg)] bg-[var(--c-input)] overflow-hidden flex items-center justify-center translate-x-[2px] pointer-events-auto">
                            {userIdentity?.avatarUrl ? (
                                <img src={userIdentity.avatarUrl} alt="" className="feed-profile-avatar-image w-full h-full object-cover" />
                            ) : (
                                <span className="feed-profile-avatar-fallback ts-24 text-[var(--c-icon)] font-bold">{(userIdentity?.name ?? "我")[0]}</span>
                            )}
                        </div>
                        
                        {/* Name and Flex Data */}
                        <div className="feed-profile-info flex flex-col gap-1 mt-3 ml-[6px] pointer-events-auto">
                            <span className="feed-profile-name ts-20 font-bold text-[var(--c-text-title)]">{userIdentity?.name ?? "我"}</span>
                            <div className="feed-profile-stats flex gap-4 ts-13 text-[var(--c-icon)] font-medium mt-[2px]">
                                <span className="feed-profile-stat"><strong className="feed-profile-stat-value text-[var(--c-text-title)]">128</strong> 关注</span>
                                <span className="feed-profile-stat"><strong className="feed-profile-stat-value text-[var(--c-text-title)]">12.4K</strong> 粉丝</span>
                                <span className="feed-profile-stat"><strong className="feed-profile-stat-value text-[var(--c-text-title)]">8.2M</strong> 获赞与收藏</span>
                            </div>
                            
                            {/* Signature */}
                            <div className="feed-profile-signature mt-[2px] text-left text-[var(--c-text)]">
                                {editingSignature ? (
                                    <input
                                        ref={sigInputRef}
                                        defaultValue={signature}
                                        autoFocus
                                        className="feed-profile-signature-input bg-transparent outline-none ts-14 text-[var(--c-text)] w-full border-b border-[var(--c-action-blue)] pb-1"
                                        onBlur={(e) => handleSignatureSubmit(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") handleSignatureSubmit((e.target as HTMLInputElement).value); }}
                                    />
                                ) : (
                                    <span className="feed-profile-signature-text cursor-pointer ts-14 opacity-90 leading-[1.6]" onClick={() => setEditingSignature(true)}>
                                        {signature || "编写你的个性签名..."}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Unread notifications banner */}
                {unreadNotifs.length > 0 && (
                    <button
                        className="feed-notif-banner"
                        onClick={() => setShowNotifModal(true)}
                    >
                        {unreadNotifs.length}条新评论/回复/点赞
                    </button>
                )}

                {/* World Filter */}
                {worldGroups.length > 1 && (
                    <div className="px-5 mb-2 flex justify-end">
                        <select
                            className="bg-[var(--c-input)] text-[var(--c-text)] text-xs rounded-md px-2 py-1 outline-none appearance-none"
                            style={{ minWidth: "80px", textAlign: "center" }}
                            value={activeWorldId}
                            onChange={(e) => { setActiveWorldId(e.target.value); setActiveChatWorldId(e.target.value); }}
                        >
                            <option value="all">所有世界</option>
                            {worldGroups.map((g: any) => (
                                <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                        </select>
                    </div>
                )}

                {/* Posts list */}
                {filteredPosts.length === 0 ? (
                    <div className="feed-empty-state py-10 text-center text-[var(--c-icon)] ts-14">
                        还没有动态，发一条吧
                    </div>
                ) : (
                    visiblePosts.map(post => (
                        <MomentPostCard
                            key={post.id}
                            post={post}
                            onUpdate={refreshPosts}
                            onRequestDelete={setConfirmDeleteId}
                            onOpenCommentComposer={openCommentComposer}
                            onOpenReplyComposer={openReplyComposer}
                        />
                    ))
                )}
                {hasMorePosts && (
                    <div className="feed-load-more-row flex justify-center px-4 pt-3 pb-8">
                        <button
                            type="button"
                            className="chat-sys-msg chat-load-more-button"
                            onClick={handleLoadMorePosts}
                        >
                            <span>查看更多动态</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="18 15 12 9 6 15" />
                            </svg>
                        </button>
                    </div>
                )}


            {/* Delete confirm dialog */}
            {confirmDeleteId && (
                <ConfirmDialog
                    title="确定删除这条朋友圈吗？"
                    message="删除后无法恢复，评论也会一并删除。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={handleDeleteConfirm}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}

            {/* Notification detail modal */}
            {showNotifModal && (
                <div className="modal-overlay" onClick={() => { setShowNotifModal(false); saveMomentsLastSeen(); setUnreadNotifs([]); }}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()} style={{ maxHeight: "60vh", overflow: "auto" }}>
                        <div className="ts-16 font-semibold text-center text-[var(--c-text)] mb-3">新消息</div>
                        {unreadNotifs.length === 0 ? (
                            <div className="ts-14 text-[var(--c-icon)] text-center py-4">暂无新消息</div>
                        ) : (
                            <div className="flex flex-col gap-3">
                                {unreadNotifs.map((n, i) => (
                                    <div key={i} className="flex flex-col gap-1 px-1">
                                        <span className="ts-13 text-[var(--c-text)]">
                                            <span className="font-semibold">{n.authorName}</span>
                                            {n.type === "comment" ? " 评论了你：" : n.type === "reply" ? " 回复了你：" : " 赞了你的朋友圈"}
                                        </span>
                                        {n.content && <span className="ts-13 text-[var(--c-icon)] leading-relaxed">{n.content.slice(0, 100)}{n.content.length > 100 ? "..." : ""}</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                        <button
                            className="ui-btn ui-btn-ghost ui-btn-bordered-ghost w-full mt-3"
                            onClick={() => { setShowNotifModal(false); saveMomentsLastSeen(); setUnreadNotifs([]); }}
                        >知道了</button>
                    </div>
                </div>
            )}

        </PageShell>
        </>
    );
}
