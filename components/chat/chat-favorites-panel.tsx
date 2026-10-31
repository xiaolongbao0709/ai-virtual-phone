"use client";

import { useState, useEffect, useMemo } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { Bookmark, ChevronRight, Trash2, Search, ArrowUpRight } from "lucide-react";
import {
    loadChatFavorites,
    removeChatFavorite,
    CHAT_FAVORITES_UPDATED_EVENT,
    type ChatFavoriteItem,
} from "@/lib/chat-favorites-storage";
import { loadChatSessions } from "@/lib/chat-storage";
import { dispatchChatJumpToMessage } from "@/lib/chat-notification-events";
import { formatChatUiTime } from "@/lib/chat-time";

interface ChatFavoritesPanelProps {
    onClose: () => void;
    onSelectSessionMessage?: (sessionId: string, messageId: string) => void;
}

export function ChatFavoritesPanel({ onClose, onSelectSessionMessage }: ChatFavoritesPanelProps) {
    const [favorites, setFavorites] = useState<ChatFavoriteItem[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [filterSender, setFilterSender] = useState<string>("all");

    const refresh = () => {
        setFavorites(loadChatFavorites());
    };

    useEffect(() => {
        refresh();
        window.addEventListener(CHAT_FAVORITES_UPDATED_EVENT, refresh);
        return () => window.removeEventListener(CHAT_FAVORITES_UPDATED_EVENT, refresh);
    }, []);

    // 提取可筛选的发信人/角色列表
    const senders = useMemo(() => {
        const set = new Set<string>();
        favorites.forEach(f => {
            if (f.senderName) set.add(f.senderName);
        });
        return Array.from(set);
    }, [favorites]);

    const filteredList = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return favorites.filter(item => {
            if (filterSender !== "all" && item.senderName !== filterSender) {
                return false;
            }
            if (!q) return true;
            return (
                item.content.toLowerCase().includes(q) ||
                item.senderName.toLowerCase().includes(q)
            );
        });
    }, [favorites, searchQuery, filterSender]);

    const handleItemClick = (item: ChatFavoriteItem) => {
        const sessions = loadChatSessions();
        const targetSession = sessions.find(s => s.id === item.sessionId);
        if (!targetSession) {
            alert("原会话已被删除或不存在");
            return;
        }

        if (onSelectSessionMessage) {
            onSelectSessionMessage(item.sessionId, item.messageId);
        } else {
            dispatchChatJumpToMessage({
                sessionId: item.sessionId,
                messageId: item.messageId,
            });
        }
        onClose();
    };

    const handleDelete = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        removeChatFavorite(id);
    };

    const renderContentPreview = (item: ChatFavoriteItem) => {
        if (item.mediaType === "image") {
            return <span className="text-[var(--c-theme)]">[图片] {item.content}</span>;
        }
        if (item.mediaType === "audio") {
            const label = (item.mediaData?.label as string) || item.content || "语音消息";
            return <span className="text-[var(--c-theme)]">[语音] {label}</span>;
        }
        if (item.mediaType === "sticker") {
            return <span className="text-[var(--c-theme)]">[表情] {item.content}</span>;
        }
        if (item.mediaType === "red_packet" || item.mediaType === "transfer") {
            return <span className="text-[var(--c-theme)]">[转账/红包] {item.content}</span>;
        }
        return item.content || "[空消息]";
    };

    return (
        <PageShell title="我的收藏" onBack={onClose} className="chat-favorites-panel-root">
            <div className="flex flex-col h-full bg-[var(--c-bg)] overflow-hidden">
                {/* 搜索栏与过滤 */}
                <div className="p-3 pb-2 flex flex-col gap-2 shrink-0 border-b border-[var(--c-border)]/50">
                    <div className="relative flex items-center bg-[var(--c-input)] rounded-xl px-3 py-1.5">
                        <Search size={16} className="text-[var(--c-icon)] opacity-50 mr-2 shrink-0" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            placeholder="搜索收藏的内容或角色..."
                            className="bg-transparent text-[var(--c-text)] text-sm flex-1 outline-none placeholder:opacity-50"
                        />
                    </div>

                    {senders.length > 1 && (
                        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1 text-xs">
                            <button
                                onClick={() => setFilterSender("all")}
                                className={`px-2.5 py-1 rounded-full shrink-0 transition-colors ${
                                    filterSender === "all"
                                        ? "bg-[var(--c-theme)] text-white font-medium"
                                        : "bg-[var(--c-card)] text-[var(--c-text)] opacity-70"
                                }`}
                            >
                                全部
                            </button>
                            {senders.map(sender => (
                                <button
                                    key={sender}
                                    onClick={() => setFilterSender(sender)}
                                    className={`px-2.5 py-1 rounded-full shrink-0 transition-colors ${
                                        filterSender === sender
                                            ? "bg-[var(--c-theme)] text-white font-medium"
                                            : "bg-[var(--c-card)] text-[var(--c-text)] opacity-70"
                                    }`}
                                >
                                    {sender}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* 列表内容 */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
                    {filteredList.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 opacity-40 text-sm gap-2">
                            <Bookmark size={36} strokeWidth={1.5} />
                            <span>{searchQuery ? "未找到相关收藏" : "暂无收藏的消息"}</span>
                            <span className="text-xs opacity-75">在聊天室长按任意消息即可收藏</span>
                        </div>
                    ) : (
                        filteredList.map(item => (
                            <div
                                key={item.id}
                                onClick={() => handleItemClick(item)}
                                className="group relative p-3.5 rounded-2xl bg-[var(--c-card)] border border-[var(--c-border)] shadow-sm hover:border-[var(--c-theme)]/50 transition-all cursor-pointer flex flex-col gap-2"
                            >
                                <div className="flex items-center justify-between text-xs">
                                    <span className="font-medium text-[var(--c-text-title)] opacity-90">
                                        {item.senderName}
                                    </span>
                                    <div className="flex items-center gap-2 text-[var(--c-text)] opacity-50">
                                        <span>{formatChatUiTime(item.createdAt)}</span>
                                        <button
                                            type="button"
                                            onClick={e => handleDelete(e, item.id)}
                                            className="p-1 hover:text-red-500 hover:opacity-100 transition-opacity"
                                            title="删除收藏"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>

                                <div className="text-sm text-[var(--c-text)] line-clamp-3 leading-relaxed break-words whitespace-pre-wrap select-none">
                                    {renderContentPreview(item)}
                                </div>

                                <div className="flex items-center justify-end text-[11px] text-[var(--c-theme)] opacity-80 pt-1 group-hover:opacity-100">
                                    <span className="flex items-center gap-0.5">
                                        回到上下文 <ArrowUpRight size={13} />
                                    </span>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </PageShell>
    );
}
