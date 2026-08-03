// components/music/music-comments.tsx — Song comment page (Netease comments)
// Hot / latest sorting, floor replies, pagination, posting (requires login).
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    getSongCommentPage, getFloorComments, postSongComment,
    type NeteaseComment,
} from "@/lib/music-service";

const PAGE_SIZE = 20;

type Props = {
    songId: number;
    title: string;
    artist: string;
    coverUrl?: string;
    onClose: () => void;
};

type SortMode = "hot" | "new";

function formatLikes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "";
    if (value >= 10000) return `${Math.round(value / 1000) / 10}万`;
    return String(value);
}

function formatCommentTime(ts: number): string {
    if (!ts) return "";
    const date = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}天前`;
    const sameYear = date.getFullYear() === now.getFullYear();
    const md = `${date.getMonth() + 1}月${date.getDate()}日`;
    return sameYear ? md : `${date.getFullYear()}年${md}`;
}

export default function MusicCommentsPage({ songId, title, artist, coverUrl, onClose }: Props) {
    const [sort, setSort] = useState<SortMode>("hot");
    const [hotComments, setHotComments] = useState<NeteaseComment[]>([]);
    const [comments, setComments] = useState<NeteaseComment[]>([]);
    const [total, setTotal] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const offsetRef = useRef(0);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((text: string) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast(text);
        toastTimerRef.current = setTimeout(() => setToast(null), 2200);
    }, []);

    useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        offsetRef.current = 0;
        getSongCommentPage(songId, 0, PAGE_SIZE).then(page => {
            if (cancelled) return;
            setHotComments(page.hotComments);
            setComments(page.comments);
            setTotal(page.total);
            setHasMore(page.hasMore);
            offsetRef.current = page.comments.length;
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, [songId]);

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore) return;
        setLoadingMore(true);
        const page = await getSongCommentPage(songId, offsetRef.current, PAGE_SIZE);
        setComments(prev => {
            const seen = new Set(prev.map(c => c.id));
            return [...prev, ...page.comments.filter(c => !seen.has(c.id))];
        });
        offsetRef.current += page.comments.length;
        setHasMore(page.hasMore);
        setLoadingMore(false);
    }, [songId, loadingMore, hasMore]);

    const handleSend = useCallback(async () => {
        const content = draft.trim();
        if (!content || sending) return;
        setSending(true);
        const result = await postSongComment(songId, content);
        setSending(false);
        showToast(result.message);
        if (result.ok) {
            setDraft("");
            // Optimistic prepend to the latest list
            setComments(prev => [{
                id: -Date.now(),
                userName: "我",
                content,
                likedCount: 0,
                time: Date.now(),
                ipLocation: "",
                replyCount: 0,
            }, ...prev]);
            setTotal(prev => prev + 1);
        }
    }, [draft, sending, songId, showToast]);

    const list = sort === "hot" && hotComments.length > 0 ? hotComments : comments;

    return (
        <div className="mcmt-page">
            {/* Header */}
            <div className="mcmt-nav">
                <button className="music-player-close" onClick={onClose}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M15 19 8 12l7-7" />
                    </svg>
                </button>
                <b>评论</b>
                {total > 0 && <span className="mcmt-total">({total.toLocaleString()})</span>}
            </div>

            {/* Song card */}
            <div className="mcmt-song">
                <div className="mcmt-song-cover">
                    {coverUrl ? <img src={coverUrl} alt="" /> : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                    )}
                </div>
                <div className="mcmt-song-info">
                    <b>{title}</b>
                    <span>{artist}</span>
                </div>
            </div>

            {/* Sort pills */}
            <div className="mcmt-sorts">
                <button className="mcmt-sort" {...(sort === "hot" ? { "data-on": "" } : {})} onClick={() => setSort("hot")}>最热</button>
                <button className="mcmt-sort" {...(sort === "new" ? { "data-on": "" } : {})} onClick={() => setSort("new")}>最新</button>
            </div>

            {/* Comment list */}
            <div className="mcmt-list">
                {loading ? (
                    <div className="mcmt-hint">加载评论中...</div>
                ) : list.length === 0 ? (
                    <div className="mcmt-hint">还没有评论，来抢沙发</div>
                ) : (
                    <>
                        {list.map(c => <CommentItem key={c.id} comment={c} songId={songId} />)}
                        {sort === "new" && hasMore && (
                            <button className="mcmt-more" onClick={loadMore} disabled={loadingMore}>
                                {loadingMore ? "加载中..." : "加载更多评论"}
                            </button>
                        )}
                        {sort === "hot" && hotComments.length > 0 && (
                            <button className="mcmt-more" onClick={() => setSort("new")}>
                                查看全部 {total.toLocaleString()} 条评论
                            </button>
                        )}
                    </>
                )}
            </div>

            {/* Input bar */}
            <div className="mcmt-input-bar">
                <input
                    className="mcmt-input"
                    placeholder="说点什么…"
                    value={draft}
                    maxLength={140}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSend()}
                />
                <button className="mcmt-send" onClick={handleSend} disabled={sending || !draft.trim()}>
                    {sending ? "…" : "发送"}
                </button>
            </div>

            {toast && <div className="music-toast music-toast-ok mcmt-toast">{toast}</div>}
        </div>
    );
}

function CommentItem({ comment, songId }: { comment: NeteaseComment; songId: number }) {
    const [replies, setReplies] = useState<NeteaseComment[] | null>(null);
    const [loadingReplies, setLoadingReplies] = useState(false);
    const [expanded, setExpanded] = useState(false);

    const toggleReplies = useCallback(async () => {
        if (expanded) { setExpanded(false); return; }
        setExpanded(true);
        if (replies === null && !loadingReplies) {
            setLoadingReplies(true);
            const list = await getFloorComments(songId, comment.id);
            setReplies(list);
            setLoadingReplies(false);
        }
    }, [expanded, replies, loadingReplies, songId, comment.id]);

    const likeText = formatLikes(comment.likedCount);
    const meta = [formatCommentTime(comment.time), comment.ipLocation].filter(Boolean).join(" · ");

    return (
        <div className="mcmt-item">
            <div className="mcmt-ava">
                {comment.avatarUrl ? <img src={comment.avatarUrl} alt="" /> : <span>{comment.userName.slice(0, 1)}</span>}
            </div>
            <div className="mcmt-body">
                <div className="mcmt-name">{comment.userName}</div>
                <div className="mcmt-text">{comment.content}</div>
                <div className="mcmt-foot">
                    {meta && <span className="mcmt-meta">{meta}</span>}
                    <span className="mcmt-likes" {...(comment.likedCount >= 10000 ? { "data-hot": "" } : {})}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill={comment.likedCount >= 10000 ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                        {likeText}
                    </span>
                </div>
                {(comment.replyCount ?? 0) > 0 && (
                    <button className="mcmt-replies-toggle" onClick={toggleReplies}>
                        {expanded ? "收起回复" : `查看 ${comment.replyCount} 条回复`}
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={expanded ? { transform: "rotate(180deg)" } : undefined}><path d="m6 9 6 6 6-6" /></svg>
                    </button>
                )}
                {expanded && (
                    <div className="mcmt-replies">
                        {loadingReplies ? (
                            <div className="mcmt-hint mcmt-hint-small">加载回复...</div>
                        ) : (replies || []).length === 0 ? (
                            <div className="mcmt-hint mcmt-hint-small">暂无回复</div>
                        ) : (replies || []).map(r => (
                            <div key={r.id} className="mcmt-reply">
                                <b>{r.userName}：</b>{r.content}
                                <span className="mcmt-reply-meta">{[formatCommentTime(r.time), r.ipLocation].filter(Boolean).join(" · ")}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
