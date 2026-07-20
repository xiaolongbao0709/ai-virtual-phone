"use client";

import { useEffect, useState, useMemo } from "react";
import type { NativeTimelineEntry } from "@/lib/short-term-assembler";
import { buildTwoLevelMomentThreads } from "@/lib/moments-comment-threading";
import { findStickerByName } from "@/lib/sticker-data";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";

/* ================================================================
   Parsed types — structured data extracted from pre-formatted content
   ================================================================ */

type ParsedChat = {
    type: "chat";
    id: string;
    timestamp: string;
    sender: string;
    isUser: boolean;
    message: string;
    innerMonologue?: string;
};

type ParsedGroupChat = {
    type: "group";
    id: string;
    timestamp: string;
    sender: string;
    isUser: boolean;
    groupName: string;
    message: string;
};

type MomentComment = {
    id: string;
    createdAt: string;
    time: string;
    author: string;
    content: string;
    replyToCommentId?: string;
    replyToAuthorName?: string;
};

type ParsedMoment = {
    type: "moments";
    id: string;
    timestamp: string;
    author: string;
    content: string;
    location?: string;
    photoUrl?: string;
    photoDescription?: string;
    comments: MomentComment[];
};

type ParsedSystem = {
    type: "system";
    id: string;
    timestamp: string;
    message: string;
};

type ParsedProjection = {
    type: "projection";
    id: string;
    timestamp: string;
    source: "story" | "vn" | "map" | "game" | "diary" | "xiaohongshu" | "interview_magazine" | "cocreate" | "checkphone" | "custom_app" | "chat_offline";
    label: string;
    message: string;
};

type ParsedEntry = ParsedChat | ParsedGroupChat | ParsedMoment | ParsedSystem | ParsedProjection;

type TimelineCluster = {
    id: string;
    startTime: string;
    endTime: string;
    entries: ParsedEntry[];
    tags: string[];
    excerpts: string[];
    entryCount: number;
};

/* ================================================================
   Content parsers — extract structured data from pre-formatted strings
   ================================================================ */

function parseEntry(evt: NativeTimelineEntry, userName: string): ParsedEntry | null {
    const content = evt.content;

    // System message: [私聊 ...] message
    if (evt.sourceApp === "chat" && evt.sourceDetail === "system") {
        const m = content.match(/^\[私聊(?: [^\]]+)?\] ([\s\S]*)$/);
        return {
            type: "system",
            id: evt.id,
            timestamp: evt.timestamp,
            message: m ? m[1] : content.replace(/^\[.*?\]\s*/, ""),
        };
    }

    // Offline chat projections are summarized events, not raw chat turns.
    if (evt.sourceApp === "chat" && evt.sourceDetail === "chat_offline") {
        const stripped = content.replace(/^\[(?:事件|线下)(?: [^\]]+)?\]\s*/, "");
        return {
            type: "projection",
            id: evt.id,
            timestamp: evt.timestamp,
            source: "chat_offline",
            label: "线下",
            message: stripped || content,
        };
    }

    // Direct chat: [私聊 ...] Sender: message
    if (evt.sourceApp === "chat" && evt.sourceDetail !== "group") {
        const m = content.match(/^\[私聊(?: [^\]]+)?\] (.+?): ([\s\S]*)$/);
        if (m) {
            const raw = m[2];
            const inner = raw.match(/^([\s\S]*?)\n[（(]内心[：:]\s?([\s\S]+?)[）)]\s*$/);
            return {
                type: "chat",
                id: evt.id,
                timestamp: evt.timestamp,
                sender: m[1],
                isUser: m[1] === userName,
                message: inner ? inner[1] : raw,
                innerMonologue: inner ? inner[2] : undefined,
            };
        }
    }

    // Group chat: [群聊「Name」 ...] Sender: message
    if (evt.sourceApp === "chat" && evt.sourceDetail === "group") {
        const m = content.match(/^\[群聊「(.+?)」(?: [^\]]+)?\] (.+?): ([\s\S]*)$/);
        if (m) {
            return {
                type: "group",
                id: evt.id,
                timestamp: evt.timestamp,
                groupName: m[1],
                sender: m[2],
                isUser: m[2] === userName,
                message: m[3],
            };
        }
    }

    // Custom app timeline events.
    if (evt.sourceApp === "custom_app") {
        const stripped = content.replace(/^\[[^\]]+\]\s*/, "");
        return {
            type: "projection",
            id: evt.id,
            timestamp: evt.timestamp,
            source: "custom_app",
            label: evt.customAppLabel || evt.customAppName || "APP",
            message: stripped || content,
        };
    }

    // Story/VN/map/game/diary/note wall/Xiaohongshu/check phone/interview/co-create/black-market theater projection.
    if (evt.sourceApp === "story" && evt.sourceDetail === "black_market_theater") {
        const stripped = content.replace(/^\[小剧场(?: [^\]]+)?\]\s*/, "");
        return {
            type: "projection",
            id: evt.id,
            timestamp: evt.timestamp,
            source: "story",
            label: "小剧场",
            message: stripped || content,
        };
    }

    if (evt.sourceApp === "story" || evt.sourceApp === "vn" || evt.sourceApp === "map" || evt.sourceApp === "game" || evt.sourceApp === "xiaohongshu" || evt.sourceApp === "checkphone" || evt.sourceApp === "interview_magazine" || evt.sourceApp === "cocreate" || (evt.sourceApp === "diary" && (evt.sourceDetail === "diary_entry" || evt.sourceDetail === "notewall"))) {
        const source = evt.sourceApp as "story" | "vn" | "map" | "game" | "diary" | "xiaohongshu" | "interview_magazine" | "cocreate" | "checkphone";
        const label = source === "story" ? "剧情" : source === "vn" ? "漫卷" : source === "map" ? "冒险" : source === "game" ? "小游戏" : source === "xiaohongshu" ? "小红书" : source === "checkphone" ? "查手机" : source === "interview_magazine" ? "访谈" : source === "cocreate" ? "共创" : evt.sourceDetail === "diary_entry" ? "日记" : "便签墙";
        const stripped = content.replace(/^\[(?:事件|剧情|漫卷|梦境|跑团游戏|小游戏|日记|便签墙|小红书|查手机|访谈|共创)(?: [^\]]+)?\]\s*/, "");
        return {
            type: "projection",
            id: evt.id,
            timestamp: evt.timestamp,
            source,
            label,
            message: stripped || content,
        };
    }

    // Moments post: [朋友圈 ...] Author发了一条动态："..."
    if (evt.sourceApp === "moments") {
        if (evt.momentsMeta) {
            return {
                type: "moments",
                id: evt.id,
                timestamp: evt.timestamp,
                author: evt.momentsMeta.author,
                content: evt.momentsMeta.content,
                location: evt.momentsMeta.location,
                photoUrl: evt.momentsMeta.photoUrl,
                photoDescription: evt.momentsMeta.photoDescription,
                comments: evt.momentsMeta.comments,
            };
        }
        const m = content.match(/^\[朋友圈(?: [^\]]+)?\] (.+?)发了一条动态[：:]"([\s\S]*?)"([\s\S]*)$/);
        if (m) {
            const rest = m[3];
            const locMatch = rest.match(/📍(.+?)(?:\n|$)/);
            const lines = content.split("\n").slice(1);
            const comments: MomentComment[] = [];
            for (const [index, line] of lines.entries()) {
                const cm = line.match(/^\s+.*?(\d{2}:\d{2}) (.+?)(评论|回复.+?)[：:]"(.+?)"$/);
                if (cm) {
                    const replyToAuthorName = cm[3].startsWith("回复") ? cm[3].slice(2) : undefined;
                    comments.push({
                        id: `${evt.id}-comment-${index}`,
                        createdAt: `${evt.timestamp}|${String(index).padStart(3, "0")}`,
                        time: cm[1],
                        author: cm[2],
                        content: cm[4],
                        replyToAuthorName,
                    });
                }
            }
            return {
                type: "moments",
                id: evt.id,
                timestamp: evt.timestamp,
                author: m[1],
                content: m[2],
            location: locMatch ? locMatch[1] : undefined,
            photoDescription: m[3].match(/\[照片[:：]\s*([^\]]+)\]/)?.[1],
            comments,
        };
        }
    }

    // Fallback — strip header tag + sender prefix
    const stripped = content.replace(/^\[.*?\]\s*/, "");
    const fbMsg = stripped
        .replace(/^.+?发了一条动态[：:]\s*"?/, "")  // moments prefix
        .replace(/^.+?[：:]\s*/, "")                   // chat sender prefix
        .replace(/"$/, "");

    if (evt.sourceApp === "moments") {
        return {
            type: "moments",
            id: evt.id,
            timestamp: evt.timestamp,
            author: "...",
            content: fbMsg || stripped,
            comments: [],
        };
    }
    return {
        type: "chat",
        id: evt.id,
        timestamp: evt.timestamp,
        sender: "...",
        isUser: false,
        message: fbMsg || stripped,
    };
}

/* ================================================================
   Clustering — group events by 30-min gaps
   ================================================================ */

const CLUSTER_GAP_MS = 30 * 60 * 1000;

function clusterByTimeGap(entries: ParsedEntry[]): TimelineCluster[] {
    if (entries.length === 0) return [];
    const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const clusters: TimelineCluster[] = [];
    let buf: ParsedEntry[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const gap = new Date(sorted[i].timestamp).getTime() - new Date(sorted[i - 1].timestamp).getTime();
        if (gap > CLUSTER_GAP_MS) {
            clusters.push(buildCluster(buf));
            buf = [sorted[i]];
        } else {
            buf.push(sorted[i]);
        }
    }
    if (buf.length > 0) clusters.push(buildCluster(buf));
    return clusters.reverse(); // newest first
}

function buildCluster(entries: ParsedEntry[]): TimelineCluster {
    const tagSet = new Set<string>();
    const pool: string[] = [];

    for (const e of entries) {
        if (e.type === "chat") {
            tagSet.add("聊天");
            pool.push(e.message);
        } else if (e.type === "group") {
            tagSet.add("群聊");
            pool.push(e.message);
        } else if (e.type === "moments") {
            tagSet.add("朋友圈");
            pool.push(e.content);
        } else if (e.type === "projection") {
            tagSet.add(e.label);
            pool.push(e.message);
        }
        // system messages: no tag, not included in excerpts
    }

    // Pick 2-3 random excerpts, truncated, strip inner monologue
    const cleaned = pool
        .map(s => s.replace(/\n?\(内心[:：].+?\)$/, "").replace(/\[表情包:[^\]]*\]/g, "").trim())
        .filter(s => s && !/^\[(?:图片|语音|视频|红包|转账|位置)\]$/.test(s) && !/^\[音乐[:：]/.test(s) && !/^\[音乐分享[:：]/.test(s));
    const shuffled = [...cleaned].sort(() => Math.random() - 0.5);
    const excerpts = shuffled.slice(0, Math.min(3, shuffled.length)).map(s =>
        s.length > 35 ? s.slice(0, 35) + "..." : s
    );

    return {
        id: entries[0].id,
        startTime: entries[0].timestamp,
        endTime: entries[entries.length - 1].timestamp,
        entries,
        tags: Array.from(tagSet),
        excerpts,
        entryCount: entries.length,
    };
}

/* ================================================================
   Time formatting helpers
   ================================================================ */

function fmtClusterTime(startTime: string, endTime: string): string {
    const s = new Date(startTime), e = new Date(endTime);
    const pad = (n: number) => String(n).padStart(2, "0");
    const st = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
    const et = `${pad(e.getHours())}:${pad(e.getMinutes())}`;
    return st === et ? st : `${st} - ${et}`;
}

function renderWithStickers(text: string) {
    const parts = text.split(/(\[表情[：:][^\]]+\])/g);
    if (parts.length === 1) return text;
    return parts.map((part, i) => {
        const m = part.match(/^\[表情[：:]([^\]]+)\]$/);
        if (m) {
            const sticker = findStickerByName(m[1]);
            if (sticker?.stickerUrl) {
                // eslint-disable-next-line @next/next/no-img-element
                return <img key={i} src={sticker.stickerUrl} alt={m[1]} style={{ display: "inline-block", width: 48, height: 48, verticalAlign: "middle" }} />;
            }
            return sticker?.emoji || `[${m[1]}]`;
        }
        return part;
    });
}

function MomentMemoryPhoto({ photoUrl, photoDescription }: { photoUrl?: string; photoDescription?: string }) {
    const [resolvedPhotoUrl, setResolvedPhotoUrl] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setResolvedPhotoUrl(null);
        if (!photoUrl) return;
        if (photoUrl.startsWith("asset://")) {
            getChatImageFromIndexedDB(photoUrl.slice(8)).then((url) => {
                if (!cancelled) setResolvedPhotoUrl(url ?? null);
            });
        } else {
            setResolvedPhotoUrl(photoUrl);
        }
        return () => { cancelled = true; };
    }, [photoUrl]);

    if (!resolvedPhotoUrl && !photoDescription) return null;

    return (
        <div className="mem-tl-moment-photo-wrap">
            {resolvedPhotoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={resolvedPhotoUrl} alt="" className="mem-tl-moment-photo" />
            )}
            {photoDescription && (
                <div className="mem-tl-moment-photo-desc">{photoDescription}</div>
            )}
        </div>
    );
}

function fmtTime(ts: string): string {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtMomentCommentTime(comment: MomentComment): string {
    const fromCreatedAt = fmtTime(comment.createdAt);
    if (fromCreatedAt) return fromCreatedAt;
    const shortTime = comment.time.match(/\b(\d{2}:\d{2})\b/);
    return shortTime ? shortTime[1] : comment.time;
}

function fmtDate(ts: string): string {
    const d = new Date(ts);
    const now = new Date();
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return "今天";
    if (d.toDateString() === yesterday.toDateString()) return "昨天";
    return `${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`;
}

function tagVariant(tag: string): "success" | "purple" | "action" | "warning" {
    return tag === "聊天" ? "success"
        : tag === "群聊" ? "purple"
            : tag === "剧情" || tag === "漫卷" || tag === "冒险" || tag === "线下" ? "action"
                : "warning";
}

function formatClusterDate(cluster: TimelineCluster): string {
    return `${fmtDate(cluster.startTime)} ${fmtClusterTime(cluster.startTime, cluster.endTime)}`;
}

/* ================================================================
   Inline detail — renders the former modal content inside cards
   ================================================================ */

function ClusterDetail({ cluster }: { cluster: TimelineCluster }) {
    return (
        <div className="mem-tl-card-detail" onClick={(event) => event.stopPropagation()}>
            {(() => {
                const groups: { type: "chat-group" | "moment" | "projection"; entries: ParsedEntry[] }[] = [];
                for (const entry of cluster.entries) {
                    if (entry.type === "moments") {
                        groups.push({ type: "moment", entries: [entry] });
                    } else if (entry.type === "projection") {
                        groups.push({ type: "projection", entries: [entry] });
                    } else {
                        // chat, group, system all go into chat-group
                        const last = groups[groups.length - 1];
                        if (last && last.type === "chat-group") {
                            last.entries.push(entry);
                        } else {
                            groups.push({ type: "chat-group", entries: [entry] });
                        }
                    }
                }
                return groups.map((group, gi) => (
                    <div key={gi}>
                        {gi > 0 && <div className="mem-tl-sep" />}
                        {group.type === "chat-group" ? (
                            <div className="mem-tl-chat-group">
                                {group.entries.map(entry => {
                                    if (entry.type === "system") {
                                        return (
                                            <div key={entry.id} className="mem-tl-system">
                                                <span>{entry.message}</span>
                                            </div>
                                        );
                                    }
                                    const e = entry as ParsedChat | ParsedGroupChat;
                                    // Hide [音乐:xxx] messages
                                    if (/^\[音乐[:：]/.test(e.message)) return null;
                                    // Music share -> card
                                    const musicMatch = e.message.match(/^\[音乐分享[:：]([^\]]+)\]$/);
                                    if (musicMatch) {
                                        return (
                                            <div key={e.id} className={`mem-tl-bubble ${e.isUser ? "mem-tl-bubble-r" : "mem-tl-bubble-l"}`}>
                                                <span className="mem-tl-bubble-name">
                                                    {e.sender}
                                                    {e.type === "group" && <span className="mem-tl-bubble-group">{e.groupName}</span>}
                                                    <span className="mem-tl-bubble-ts">{fmtTime(e.timestamp)}</span>
                                                </span>
                                                <div className="chat-music-share-card">
                                                    <div className="chat-music-share-body">
                                                        <div className="chat-music-share-cover">
                                                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-music-accent, #7c9a92)" strokeWidth="1.2">
                                                                <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                                            </svg>
                                                        </div>
                                                        <div className="chat-music-share-info">
                                                            <div className="chat-music-share-title">{musicMatch[1]}</div>
                                                            {musicMatch[2] && <div className="chat-music-share-artist">{musicMatch[2]}</div>}
                                                        </div>
                                                    </div>
                                                    <div className="chat-music-share-footer">
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                                                        <span>音乐</span>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    }
                                    return (
                                        <div key={e.id} className={`mem-tl-bubble ${e.isUser ? "mem-tl-bubble-r" : "mem-tl-bubble-l"}`}>
                                            <span className="mem-tl-bubble-name">
                                                {e.sender}
                                                {e.type === "group" && <span className="mem-tl-bubble-group">{e.groupName}</span>}
                                                <span className="mem-tl-bubble-ts">{fmtTime(e.timestamp)}</span>
                                            </span>
                                            <div className="mem-tl-bubble-body">
                                                <p className="mem-tl-bubble-text">{renderWithStickers(e.message)}</p>
                                                {"innerMonologue" in e && e.innerMonologue && (
                                                    <p className="mem-tl-bubble-inner">{e.innerMonologue}</p>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : group.type === "projection" ? (
                            (() => {
                                const entry = group.entries[0] as ParsedProjection;
                                return (
                                    <div className="mem-tl-system" style={{ padding: "8px 12px", background: "color-mix(in srgb, var(--c-icon-active) 6%, transparent)", borderRadius: 8, border: "1px solid color-mix(in srgb, var(--c-icon-active) 12%, transparent)" }}>
                                        <span className="ui-status-tag" data-variant="action" style={{ marginRight: 6, fontSize: "calc(10px*var(--app-text-scale,1))" }}>{entry.label}</span>
                                        <span className="mem-tl-projection-text">{entry.message}</span>
                                        <span className="mem-tl-bubble-ts" style={{ marginLeft: 6 }}>{fmtTime(entry.timestamp)}</span>
                                    </div>
                                );
                            })()
                        ) : (
                            (() => {
                                const entry = group.entries[0] as ParsedMoment;
                                const commentThreads = buildTwoLevelMomentThreads(entry.comments);
                                return (
                                    <div className="mem-tl-moment">
                                        <div className="mem-tl-moment-head">
                                            <span className="mem-tl-moment-author">{entry.author}</span>
                                            <span className="mem-tl-bubble-ts">{fmtTime(entry.timestamp)}</span>
                                        </div>
                                        <p className="mem-tl-moment-text">{entry.content}</p>
                                        {entry.location && <span className="mem-tl-moment-loc">{entry.location}</span>}
                                        <MomentMemoryPhoto
                                            photoUrl={entry.photoUrl}
                                            photoDescription={entry.photoDescription}
                                        />
                                        {entry.comments.length > 0 && (
                                            <div className="mem-tl-moment-cmts">
                                                {commentThreads.map(({ root, replies }) => (
                                                    <div key={root.id} className="mem-tl-moment-cmt-group">
                                                        <div className="mem-tl-moment-cmt">
                                                            <span className="mem-tl-moment-cmt-author">{root.author}</span>
                                                            {root.replyToAuthorName && (
                                                                <>
                                                                    <span className="mem-tl-moment-cmt-action">回复</span>
                                                                    <span className="mem-tl-moment-cmt-author">{root.replyToAuthorName}</span>
                                                                    <span className="mem-tl-moment-cmt-action">:</span>
                                                                </>
                                                            )}
                                                            {!root.replyToAuthorName && (
                                                                <span className="mem-tl-moment-cmt-action">评论:</span>
                                                            )}
                                                            <span className="mem-tl-moment-cmt-text">{root.content}</span>
                                                            <span className="mem-tl-bubble-ts">{fmtMomentCommentTime(root)}</span>
                                                        </div>
                                                        {replies.length > 0 && (
                                                            <div className="mem-tl-moment-cmt-children">
                                                                {replies.map((reply) => (
                                                                    <div key={reply.id} className="mem-tl-moment-cmt mem-tl-moment-reply">
                                                                        <span className="mem-tl-moment-cmt-author">{reply.author}</span>
                                                                        {reply.replyToAuthorName && (
                                                                            <>
                                                                                <span className="mem-tl-moment-cmt-action">回复</span>
                                                                                <span className="mem-tl-moment-cmt-author">{reply.replyToAuthorName}</span>
                                                                                <span className="mem-tl-moment-cmt-action">:</span>
                                                                            </>
                                                                        )}
                                                                        {!reply.replyToAuthorName && (
                                                                            <span className="mem-tl-moment-cmt-action">评论:</span>
                                                                        )}
                                                                        <span className="mem-tl-moment-cmt-text">{reply.content}</span>
                                                                        <span className="mem-tl-bubble-ts">{fmtMomentCommentTime(reply)}</span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })()
                        )}
                    </div>
                ));
            })()}
        </div>
    );
}


/* ================================================================
   Main Timeline Component
   ================================================================ */

type Props = {
    events: NativeTimelineEntry[];
    userName: string;
};

export function MemoryTimeline({ events, userName }: Props) {
    const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);

    const clusters = useMemo(() => {
        const parsed = events.map(e => parseEntry(e, userName)).filter((e): e is ParsedEntry => e !== null);
        return clusterByTimeGap(parsed);
    }, [events, userName]);

    if (clusters.length === 0) {
        return (
            <p className="text-center ts-14 mt-10 text-secondary">
                暂无数据。聊天或朋友圈互动后会自动显示。
            </p>
        );
    }

    return (
        <>
            <div className="mem-tl mem-tl-cards">
                {clusters.map((cluster) => {
                    const expanded = expandedClusterId === cluster.id;
                    return (
                        <div
                            key={cluster.id}
                            className={`g-card mem-tl-card${expanded ? " is-expanded" : ""}`}
                            onClick={() => setExpandedClusterId(expanded ? null : cluster.id)}
                        >
                            <span className="ts-10 font-bold uppercase tracking-widest" style={{
                                color: "var(--c-danger)", opacity: 0.6, position: "absolute", right: 12, top: 12
                            }}>REPORT</span>
                            <div className="flex justify-between items-center pb-2 mb-2" style={{ borderBottom: "1px dashed var(--c-panel-border)" }}>
                                <span className="ts-11 text-secondary" style={{ letterSpacing: "1px" }}>[ DATE: {formatClusterDate(cluster)} ]</span>
                            </div>
                            <div className="mem-tl-card-head">
                                <div className="mem-tl-tags">
                                    {cluster.tags.map(tag => (
                                        <span key={tag} className="ui-status-tag" data-variant={tagVariant(tag)}>{tag}</span>
                                    ))}
                                </div>
                                <span className="mem-tl-card-count">{cluster.entryCount} 条记录</span>
                            </div>
                            {expanded ? (
                                <ClusterDetail cluster={cluster} />
                            ) : (
                                <div className="mem-tl-card-excerpts">
                                    {cluster.excerpts.length > 0 ? cluster.excerpts.map((ex, i) => (
                                        <p key={i} className="mem-tl-card-ex">{ex}</p>
                                    )) : (
                                        <p className="mem-tl-card-ex">暂无可预览内容，展开查看完整记录。</p>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </>
    );
}
