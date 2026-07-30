"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import type { MomentPost, MomentComment } from "@/lib/moments-types";
import { BilingualTextBlock, MediaImageWithPreview } from "@/components/chat/message-bubble";
import {
    loadMomentComments,
    toggleMomentLike,
    loadMomentsConfig,
    updateMomentPost,
    updateMomentComment,
    deleteMomentCommentThread,
} from "@/lib/moments-storage";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { buildTwoLevelMomentThreads } from "@/lib/moments-comment-threading";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import { splitBilingualText } from "@/lib/bilingual-text";
import { retryMomentGeneratedPhoto } from "@/lib/generated-image-retry";
import { RefreshCw, Trash2, MoreHorizontal, MapPin, Heart, MessageCircle, Pencil } from "lucide-react";
import { ConfirmDialog } from "@/components/ui";

type Props = {
    post: MomentPost;
    onUpdate: () => void;
    onRequestDelete?: (postId: string) => void;
    onOpenCommentComposer?: (post: MomentPost) => void;
    onOpenReplyComposer?: (post: MomentPost, comment: MomentComment, replyName: string) => void;
};

const DEFAULT_MOMENT_AVATAR_SRC = "/images/default-moment-avatar.png";

function MomentDefaultAvatar({ alt = "" }: { alt?: string }) {
    return <img src={DEFAULT_MOMENT_AVATAR_SRC} alt={alt} className="feed-default-avatar w-full h-full object-cover" />;
}

export function MomentPostCard({ post, onUpdate, onRequestDelete, onOpenCommentComposer, onOpenReplyComposer }: Props) {
    const [comments, setComments] = useState<MomentComment[]>(() => loadMomentComments(post.id));
    const [showPhotoPromptEditor, setShowPhotoPromptEditor] = useState(false);
    const [photoPromptDraft, setPhotoPromptDraft] = useState("");
    const [photoRegenerating, setPhotoRegenerating] = useState(false);
    const [photoRetryError, setPhotoRetryError] = useState("");
    const [showPostActions, setShowPostActions] = useState(false);
    const [editingPostOpen, setEditingPostOpen] = useState(false);
    const [postContentDraft, setPostContentDraft] = useState("");
    const [postPhotoDescDraft, setPostPhotoDescDraft] = useState("");
    const [postUseReferenceDraft, setPostUseReferenceDraft] = useState(false);
    const [postLocationDraft, setPostLocationDraft] = useState("");
    const [editingComment, setEditingComment] = useState<MomentComment | null>(null);
    const [commentDraft, setCommentDraft] = useState("");
    const [deleteCommentTarget, setDeleteCommentTarget] = useState<MomentComment | null>(null);

    // Resolve asset:// photo URLs from IndexedDB
    const [resolvedPhotoUrl, setResolvedPhotoUrl] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        setResolvedPhotoUrl(null);

        if (post.photoUrl?.startsWith("asset://")) {
            const assetId = post.photoUrl.slice(8);
            getChatImageFromIndexedDB(assetId).then(url => {
                if (cancelled) return;
                setResolvedPhotoUrl(url || null);
            });
        } else {
            setResolvedPhotoUrl(post.photoUrl || null);
        }

        return () => {
            cancelled = true;
        };
    }, [post.photoUrl]);

    const chars = loadCharacters();
    // 角色帖子下，用户名用该角色绑定的用户人设；用户自己的帖子用默认人设
    const contextCharId = post.authorType === "character" ? post.authorId : undefined;
    const userIdentity = resolveUserIdentity(contextCharId, "chat");

    const getCharName = (charId: string): string => {
        return chars.find(c => c.id === charId)?.name ?? "未知";
    };

    const getCharAvatar = (charId: string): string | null => {
        return chars.find(c => c.id === charId)?.avatar ?? null;
    };

    const getAuthorName = (authorType: "user" | "character" | "npc", authorId: string, authorName?: string): string => {
        if (authorType === "npc") return authorName!;
        return authorType === "user" ? (userIdentity?.name ?? "我") : getCharName(authorId);
    };

    const getAuthorAvatar = (authorType: "user" | "character" | "npc", authorId: string): string | null => {
        if (authorType === "npc") return null;
        return authorType === "user" ? (userIdentity?.avatarUrl ?? null) : getCharAvatar(authorId);
    };

    const authorName = getAuthorName(post.authorType, post.authorId);
    const authorAvatar = getAuthorAvatar(post.authorType, post.authorId);

    // Time formatting
    const timeAgo = formatTimeAgo(post.createdAt);

    // Like handling
    const isLikedByUser = post.likes.some(l => l.authorType === "user");
    const momentsConfig = loadMomentsConfig();
    const defaultTranslationExpanded = momentsConfig.collapseBilingualTranslation === true ? false : true;

    const handleLike = () => {
        toggleMomentLike(post.id, "user", "user");
        onUpdate();
    };

    const handleToggleComment = () => {
        onOpenCommentComposer?.(post);
    };

    const handleReply = (comment: MomentComment) => {
        const name = getAuthorName(comment.authorType, comment.authorId, comment.authorName);
        onOpenReplyComposer?.(post, comment, name);
    };

    const handleCommentPress = (comment: MomentComment, event: React.MouseEvent<HTMLElement>) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, a, input, textarea")) return;
        handleReply(comment);
    };

    const handleDelete = () => {
        if (onRequestDelete) {
            onRequestDelete(post.id);
        }
    };

    const dispatchMomentsUpdated = () => {
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("moments-updated"));
        }
    };

    const openPostEditor = () => {
        setPostContentDraft(post.content);
        setPostPhotoDescDraft(post.photoDescription || "");
        setPostUseReferenceDraft(post.photoUseReferenceImage === true);
        setPostLocationDraft(post.location || "");
        setShowPostActions(false);
        setEditingPostOpen(true);
    };

    const handlePostEditSave = () => {
        const content = postContentDraft.trim();
        if (!content) return;
        const photoDescription = postPhotoDescDraft.trim();
        updateMomentPost(post.id, {
            content,
            photoDescription: photoDescription || undefined,
            photoUseReferenceImage: photoDescription ? postUseReferenceDraft : false,
            location: postLocationDraft.trim() || undefined,
        });
        setEditingPostOpen(false);
        onUpdate();
        dispatchMomentsUpdated();
    };

    const openCommentEditor = (comment: MomentComment) => {
        setEditingComment(comment);
        setCommentDraft(comment.content);
    };

    const handleCommentEditSave = () => {
        if (!editingComment) return;
        const content = commentDraft.trim();
        if (!content) return;
        updateMomentComment(editingComment.id, { content });
        setEditingComment(null);
        setCommentDraft("");
        setComments(loadMomentComments(post.id));
        onUpdate();
        dispatchMomentsUpdated();
    };

    const getCommentDescendantCount = (commentId: string): number => {
        const deleteIds = new Set<string>([commentId]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const comment of comments) {
                if (comment.replyToCommentId && deleteIds.has(comment.replyToCommentId) && !deleteIds.has(comment.id)) {
                    deleteIds.add(comment.id);
                    changed = true;
                }
            }
        }
        return Math.max(0, deleteIds.size - 1);
    };

    const handleConfirmCommentDelete = () => {
        if (!deleteCommentTarget) return;
        deleteMomentCommentThread(deleteCommentTarget.id);
        setDeleteCommentTarget(null);
        setComments(loadMomentComments(post.id));
        onUpdate();
        dispatchMomentsUpdated();
    };

    // Refresh comments when moments update
    useEffect(() => {
        const handler = () => setComments(loadMomentComments(post.id));
        window.addEventListener("moments-updated", handler);
        return () => window.removeEventListener("moments-updated", handler);
    }, [post.id]);

    // Liked names list
    const likeNames = post.likes.map(l => getAuthorName(l.authorType, l.authorId, l.authorName));
    const commentThreads = useMemo(() => buildTwoLevelMomentThreads(comments), [comments]);
    const fallbackPhotoDescription = post.photoDescription && !post.photoUrl
        ? post.photoDescription
        : null;
    const canRetryPhoto = Boolean(fallbackPhotoDescription);
    const canRegeneratePhoto = Boolean(resolvedPhotoUrl)
        && Boolean(post.photoUrl)
        && Boolean(post.photoDescription?.trim())
        && (post.photoGenerationStatus === "generated" || Boolean(post.photoGenerationPrompt));
    const openPhotoPromptEditor = useCallback(() => {
        setPhotoPromptDraft(post.photoDescription?.trim() || "");
        setPhotoRetryError("");
        setShowPhotoPromptEditor(true);
    }, [post.photoDescription]);
    const handleRegeneratePhotoWithPrompt = useCallback(() => {
        const nextDescription = photoPromptDraft.trim();
        if (!nextDescription) {
            setPhotoRetryError("提示词不能为空");
            return;
        }
        setShowPhotoPromptEditor(false);
        setPhotoRegenerating(true);
        setPhotoRetryError("");
        retryMomentGeneratedPhoto(post, nextDescription)
            .then(() => onUpdate())
            .catch(error => {
                setPhotoRetryError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                setPhotoRegenerating(false);
            });
    }, [onUpdate, photoPromptDraft, post]);

    return (
        <div data-moment-post-id={post.id} className="feed-post relative border-b-[2.5px] border-[var(--c-card-border)] pb-5 mb-5 w-full bg-transparent px-4 pt-2">
            {/* Header row: avatar + name */}
            <div className="feed-post-header flex items-center gap-3 mb-3">
                <div
                    className="feed-post-author-avatar w-[40px] h-[40px] rounded-full shrink-0 bg-[var(--c-input)] overflow-hidden flex items-center justify-center"
                >
                    {authorAvatar ? (
                        <img src={authorAvatar} alt="" className="feed-post-author-avatar-image w-full h-full object-cover" />
                    ) : (
                        <MomentDefaultAvatar />
                    )}
                </div>
                <div className="feed-post-author flex-1 flex items-center gap-1">
                    <span className="feed-post-author-name ts-16 font-medium text-[var(--c-text-title)]">{authorName}</span>
                </div>
                <button
                    className="feed-post-more-btn p-1 text-[var(--c-icon)] opacity-70"
                    type="button"
                    aria-label="更多操作"
                    title="更多操作"
                    onClick={(event) => {
                        event.stopPropagation();
                        setShowPostActions(prev => !prev);
                    }}
                >
                    <MoreHorizontal size={18} strokeWidth={1.75} />
                </button>
                {showPostActions && typeof document !== "undefined" && createPortal(
                    <div className="fixed inset-0 z-[11]" onClick={() => setShowPostActions(false)} />,
                    document.body,
                )}
                {showPostActions && (
                    <div className="feed-post-action-menu" onClick={event => event.stopPropagation()}>
                        <button type="button" onClick={openPostEditor}>
                            <Pencil size={14} strokeWidth={1.75} />
                            <span>编辑动态</span>
                        </button>
                        {onRequestDelete && (
                            <button
                                type="button"
                                data-danger="true"
                                onClick={() => {
                                    setShowPostActions(false);
                                    handleDelete();
                                }}
                            >
                                <Trash2 size={14} strokeWidth={1.75} />
                                <span>删除动态</span>
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Text content */}
            <div className="feed-post-content ts-16 leading-[1.75] text-[var(--c-text-title)] whitespace-pre-wrap break-words mb-3 w-full">
                <BilingualTextBlock
                    text={post.content}
                    mode="plain"
                    defaultExpanded={defaultTranslationExpanded}
                />
            </div>

            {/* Location */}
            {post.location && (
                <div className="feed-post-location mb-3 text-[var(--c-icon)] opacity-80 flex items-center ts-12">
                    <MapPin size={12} strokeWidth={1.75} className="mr-1" />
                    {post.location}
                </div>
            )}

            {/* Photo area */}
            <div className="feed-post-media mb-5 w-full flex flex-col gap-2">
                {resolvedPhotoUrl && (
                    <MediaImageWithPreview
                        url={resolvedPhotoUrl}
                        title=""
                        filename={`moment-${post.id}.png`}
                        onError={() => {
                            setResolvedPhotoUrl(null);
                        }}
                        sideAction={canRegeneratePhoto ? (
                            <button
                                type="button"
                                className="feed-post-photo-retry-btn"
                                disabled={photoRegenerating}
                                aria-label="重新生成朋友圈图片"
                                onClick={e => {
                                    e.stopPropagation();
                                    openPhotoPromptEditor();
                                }}
                            >
                                <RefreshCw size={14} className={photoRegenerating ? "is-spinning" : undefined} />
                            </button>
                        ) : undefined}
                    />
                )}
                {fallbackPhotoDescription && (
                    <div className="feed-post-photo-retry-stack">
                        <div className="feed-post-photo-retry-row">
                            <div
                                className="feed-post-photo-description ts-13 italic leading-[1.8] opacity-80 text-[var(--c-text)] px-4 py-3 inline-block max-w-full"
                                style={{ background: "color-mix(in srgb, var(--c-text) 10%, transparent)", borderRadius: 0 }}
                            >
                                <MomentInlineBilingualText text={fallbackPhotoDescription} defaultExpanded={defaultTranslationExpanded} />
                                {canRetryPhoto && (
                                    <button
                                        type="button"
                                        className="feed-post-photo-retry-btn feed-post-photo-inline-retry-btn"
                                        disabled={photoRegenerating}
                                        aria-label="重新生成朋友圈图片"
                                        onClick={e => {
                                            e.stopPropagation();
                                            openPhotoPromptEditor();
                                        }}
                                    >
                                        <RefreshCw size={14} className={photoRegenerating ? "is-spinning" : undefined} />
                                    </button>
                                )}
                            </div>
                        </div>
                        {post.photoGenerationStatus === "pending" && (
                            <div className="ts-12 text-[var(--c-icon)] opacity-80">图片生成中…</div>
                        )}
                        {post.photoGenerationStatus === "failed" && post.photoGenerationError && !photoRetryError && (
                            <div className="feed-post-photo-retry-error">生成失败：{post.photoGenerationError}</div>
                        )}
                    </div>
                )}
                {photoRetryError && <div className="feed-post-photo-retry-error">生成失败：{photoRetryError}</div>}
            </div>
            {showPhotoPromptEditor && typeof document !== "undefined" && createPortal(
                <div className="modal-overlay" data-ui="modal" onClick={() => setShowPhotoPromptEditor(false)}>
                    <div className="modal-dialog feed-post-photo-prompt-dialog" data-ui="modal-dialog" onClick={e => e.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">重新生成图片</h3>
                        </div>
                        <div className="modal-body feed-post-photo-prompt-body" data-ui="modal-body">
                            <textarea
                                className="ui-textarea feed-post-photo-prompt-textarea"
                                value={photoPromptDraft}
                                onChange={e => setPhotoPromptDraft(e.target.value)}
                                placeholder="输入图片提示词"
                                disabled={photoRegenerating}
                            />
                            {photoRetryError && <div className="feed-post-photo-retry-error">生成失败：{photoRetryError}</div>}
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            <button className="ui-btn ui-btn-ghost" onClick={() => setShowPhotoPromptEditor(false)}>取消</button>
                            <button
                                className="ui-btn ui-btn-action"
                                disabled={photoRegenerating || !photoPromptDraft.trim()}
                                onClick={handleRegeneratePhotoWithPrompt}
                            >
                                生成
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}

            {editingPostOpen && typeof document !== "undefined" && createPortal(
                <div className="modal-overlay" data-ui="modal" onClick={() => setEditingPostOpen(false)}>
                    <div className="modal-dialog feed-post-edit-dialog" data-ui="modal-dialog" onClick={e => e.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">编辑动态</h3>
                        </div>
                        <div className="modal-body feed-post-edit-body" data-ui="modal-body">
                            <label className="feed-post-edit-field">
                                <span>正文</span>
                                <textarea
                                    className="ui-textarea feed-post-edit-textarea"
                                    value={postContentDraft}
                                    onChange={e => setPostContentDraft(e.target.value)}
                                    placeholder="输入动态正文"
                                />
                            </label>
                            <label className="feed-post-edit-field">
                                <span>图片描述</span>
                                <textarea
                                    className="ui-textarea feed-post-edit-textarea feed-post-edit-textarea-small"
                                    value={postPhotoDescDraft}
                                    onChange={e => setPostPhotoDescDraft(e.target.value)}
                                    placeholder="不需要图片描述时留空"
                                />
                            </label>
                            <label className="feed-post-edit-check">
                                <input
                                    type="checkbox"
                                    checked={postUseReferenceDraft}
                                    disabled={!postPhotoDescDraft.trim()}
                                    onChange={e => setPostUseReferenceDraft(e.target.checked)}
                                />
                                <span>图片使用角色参考图</span>
                            </label>
                            <label className="feed-post-edit-field">
                                <span>地点</span>
                                <input
                                    className="ui-input feed-post-edit-input"
                                    value={postLocationDraft}
                                    onChange={e => setPostLocationDraft(e.target.value)}
                                    placeholder="不显示地点时留空"
                                />
                            </label>
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            <button className="ui-btn ui-btn-ghost" onClick={() => setEditingPostOpen(false)}>取消</button>
                            <button className="ui-btn ui-btn-action" disabled={!postContentDraft.trim()} onClick={handlePostEditSave}>保存</button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}

            {editingComment && typeof document !== "undefined" && createPortal(
                <div className="modal-overlay" data-ui="modal" onClick={() => setEditingComment(null)}>
                    <div className="modal-dialog feed-post-edit-dialog" data-ui="modal-dialog" onClick={e => e.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">编辑评论</h3>
                        </div>
                        <div className="modal-body feed-post-edit-body" data-ui="modal-body">
                            <label className="feed-post-edit-field">
                                <span>评论内容</span>
                                <textarea
                                    className="ui-textarea feed-post-edit-textarea feed-post-edit-textarea-small"
                                    value={commentDraft}
                                    onChange={e => setCommentDraft(e.target.value)}
                                    placeholder="输入评论内容"
                                />
                            </label>
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            <button
                                className="ui-btn ui-btn-ghost"
                                onClick={() => {
                                    setEditingComment(null);
                                    setCommentDraft("");
                                }}
                            >
                                取消
                            </button>
                            <button className="ui-btn ui-btn-action" disabled={!commentDraft.trim()} onClick={handleCommentEditSave}>保存</button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}

            {deleteCommentTarget && (
                <ConfirmDialog
                    title="删除这条评论？"
                    message={(() => {
                        const descendantCount = getCommentDescendantCount(deleteCommentTarget.id);
                        return descendantCount > 0
                            ? `这条评论下还有 ${descendantCount} 条回复，删除后会一并删除。`
                            : "删除后无法恢复。";
                    })()}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={handleConfirmCommentDelete}
                    onCancel={() => setDeleteCommentTarget(null)}
                />
            )}

            {/* Timestamp + action buttons */}
            <div className="feed-post-action-row flex items-center justify-between mt-4 mb-3">
                <span className="feed-post-time ts-13 text-[var(--c-icon)]">{timeAgo}</span>
                <div className="feed-post-actions flex gap-4">
                    <button
                        onClick={handleLike}
                        className="feed-post-like-btn border-none p-0 w-[19px] h-[19px] cursor-pointer flex items-center justify-center transition-transform hover:scale-105 active:scale-95 bg-none shrink-0"
                    >
                        {isLikedByUser ? (
                            <Heart size={17} strokeWidth={1.75} fill="currentColor" className="text-[var(--c-icon)]" />
                        ) : (
                            <Heart size={17} strokeWidth={1.75} className="text-[var(--c-icon)]" />
                        )}
                    </button>
                    <button onClick={handleToggleComment} className="feed-post-comment-btn bg-none border-none p-0 cursor-pointer flex items-center transition-transform hover:scale-105 active:scale-95">
                        <MessageCircle size={16} strokeWidth={1.75} className="text-[var(--c-icon)]" />
                    </button>
                    <button onClick={handleDelete} className="feed-post-delete-btn bg-none border-none p-0 cursor-pointer flex items-center transition-transform hover:scale-105 active:scale-95">
                        <Trash2 size={16} strokeWidth={1.75} className="text-[var(--c-icon)]" />
                    </button>
                </div>
            </div>

            {/* Likes + Comments section */}
            {(likeNames.length > 0 || comments.length > 0) && (
                <div className="feed-feedback-section w-full flex flex-col gap-2 mb-3 mt-1">
                    {/* Likes row */}
                    {likeNames.length > 0 && (
                        <div className="feed-like-summary flex items-start gap-1 ts-15 leading-[1.55] text-[var(--c-text-title)]">
                            <span className="feed-like-summary-icon shrink-0 mt-[4px] mr-1 text-[var(--c-icon)] opacity-80">
                                <Heart size={15} strokeWidth={1.75} />
                            </span>
                            <span className="feed-like-summary-text opacity-90">
                                {likeNames.join("、")}{likeNames.length > 0 ? " 赞了" : ""}
                            </span>
                        </div>
                    )}

                    {/* Comments list */}
                    {comments.length > 0 && (
                        <div className="feed-comments flex flex-col gap-1 w-full mt-1">
                            {commentThreads.map(({ root, replies }) => {
                                const rootName = getAuthorName(root.authorType, root.authorId, root.authorName);
                                const rootAvatar = getAuthorAvatar(root.authorType, root.authorId);
                                const rootReplyName = root.replyToAuthorId
                                    ? getAuthorName(root.replyToAuthorType || "character", root.replyToAuthorId, root.replyToAuthorName)
                                    : null;

                                return (
                                    <div key={root.id} className="feed-comment feed-comment-root w-full">
                                        <div
                                            className="feed-comment-row flex items-start gap-2 cursor-pointer"
                                            onClick={(event) => handleCommentPress(root, event)}
                                        >
                                            <div
                                                className="feed-comment-avatar feed-comment-avatar-root w-[32px] h-[32px] rounded-full shrink-0 bg-[var(--c-input)] overflow-hidden flex items-center justify-center"
                                            >
                                                {rootAvatar ? (
                                                    <img src={rootAvatar} alt="" className="feed-comment-avatar-image w-full h-full object-cover" />
                                                ) : (
                                                    <MomentDefaultAvatar />
                                                )}
                                            </div>
                                            <div className="feed-comment-content min-w-0 flex-1 ts-14 leading-[1.8] break-words">
                                                <div className="feed-comment-main flex flex-col gap-[1px]">
                                                    <div className="feed-comment-author text-[var(--c-text)] opacity-70">{rootName}</div>
                                                    <div className="feed-comment-body ts-15 leading-[1.55] text-[var(--c-text-title)]">
                                                        {rootReplyName && (
                                                            <>
                                                                <span className="feed-comment-reply-prefix">回复 </span>
                                                                <span className="feed-comment-reply-target ts-14 font-normal text-[var(--c-text)] opacity-70">{rootReplyName}</span>
                                                                <span className="feed-comment-reply-colon">：</span>
                                                            </>
                                                        )}
                                                        <MomentInlineBilingualText
                                                            text={root.content}
                                                            defaultExpanded={defaultTranslationExpanded}
                                                            textColor="var(--c-text-title)"
                                                            translationColor="var(--c-text-title)"
                                                        />
                                                    </div>
                                                </div>
                                                <div className="feed-comment-meta flex items-center gap-0 mt-[2px] ts-13 text-[var(--c-icon)] w-full">
                                                    <span className="feed-comment-time whitespace-nowrap mr-4">{formatTimeAgo(root.createdAt)}</span>
                                                    <button
                                                        type="button"
                                                        title="回复"
                                                        aria-label="回复评论"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleReply(root);
                                                        }}
                                                        className="feed-comment-reply-btn"
                                                    >
                                                        回复
                                                    </button>
                                                    <div className="ml-auto flex items-center gap-1 -mr-[6px]">
                                                        <button
                                                            type="button"
                                                            title="编辑"
                                                            aria-label="编辑评论"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                openCommentEditor(root);
                                                            }}
                                                            className="feed-comment-icon-button"
                                                        >
                                                            <Pencil size={13} strokeWidth={1.75} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            title="删除"
                                                            aria-label="删除评论"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setDeleteCommentTarget(root);
                                                            }}
                                                            className="feed-comment-icon-button"
                                                        >
                                                            <Trash2 size={13} strokeWidth={1.75} />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        {replies.length > 0 && (
                                            <div className="feed-comment-replies flex flex-col gap-1 w-full mt-1 pl-[40px]">
                                                {replies.map((reply) => {
                                                    const replyName = getAuthorName(reply.authorType, reply.authorId, reply.authorName);
                                                    const replyAvatar = getAuthorAvatar(reply.authorType, reply.authorId);
                                                    const replyTargetName = reply.replyToAuthorId
                                                        ? getAuthorName(reply.replyToAuthorType || "character", reply.replyToAuthorId, reply.replyToAuthorName)
                                                        : null;
                                                    return (
                                                        <div
                                                            key={reply.id}
                                                            className="feed-comment feed-comment-child flex items-start gap-2 cursor-pointer"
                                                            onClick={(event) => handleCommentPress(reply, event)}
                                                        >
                                                            <div
                                                                className="feed-comment-avatar feed-comment-avatar-child w-[22px] h-[22px] rounded-full shrink-0 bg-[var(--c-input)] overflow-hidden flex items-center justify-center mt-[2px]"
                                                            >
                                                                {replyAvatar ? (
                                                                    <img src={replyAvatar} alt="" className="feed-comment-avatar-image w-full h-full object-cover" />
                                                                ) : (
                                                                    <MomentDefaultAvatar />
                                                                )}
                                                            </div>
                                                            <div className="feed-comment-content min-w-0 flex-1 ts-14 leading-[1.8] break-words">
                                                                <div className="feed-comment-main flex flex-col gap-[1px]">
                                                                    <div className="feed-comment-author text-[var(--c-text)] opacity-70">{replyName}</div>
                                                                    <div className="feed-comment-body ts-15 leading-[1.55] text-[var(--c-text-title)]">
                                                                        {replyTargetName && (
                                                                            <>
                                                                                <span className="feed-comment-reply-prefix">回复 </span>
                                                                                <span className="feed-comment-reply-target ts-14 font-normal text-[var(--c-text)] opacity-70">{replyTargetName}</span>
                                                                                <span className="feed-comment-reply-colon">：</span>
                                                                            </>
                                                                        )}
                                                                        <MomentInlineBilingualText
                                                                            text={reply.content}
                                                                            defaultExpanded={defaultTranslationExpanded}
                                                                            textColor="var(--c-text-title)"
                                                                            translationColor="var(--c-text-title)"
                                                                        />
                                                                    </div>
                                                                </div>
                                                                <div className="feed-comment-meta flex items-center gap-0 mt-[2px] ts-13 text-[var(--c-icon)] w-full">
                                                                    <span className="feed-comment-time whitespace-nowrap mr-4">{formatTimeAgo(reply.createdAt)}</span>
                                                                    <button
                                                                        type="button"
                                                                        title="回复"
                                                                        aria-label="回复评论"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleReply(reply);
                                                                        }}
                                                                        className="feed-comment-reply-btn"
                                                                    >
                                                                        回复
                                                                    </button>
                                                                    <div className="ml-auto flex items-center gap-1 -mr-[6px]">
                                                                        <button
                                                                            type="button"
                                                                            title="编辑"
                                                                            aria-label="编辑评论"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                openCommentEditor(reply);
                                                                            }}
                                                                            className="feed-comment-icon-button"
                                                                        >
                                                                            <Pencil size={13} strokeWidth={1.75} />
                                                                        </button>
                                                                        <button
                                                                            type="button"
                                                                            title="删除"
                                                                            aria-label="删除评论"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                setDeleteCommentTarget(reply);
                                                                            }}
                                                                            className="feed-comment-icon-button"
                                                                        >
                                                                            <Trash2 size={13} strokeWidth={1.75} />
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

        </div>
    );
}

function MomentInlineBilingualText({
    text,
    defaultExpanded,
    textColor = "var(--c-text)",
    translationColor = "var(--c-icon)",
}: {
    text: string;
    defaultExpanded: boolean;
    textColor?: string;
    translationColor?: string;
}) {
    const bilingual = splitBilingualText(text);
    const [expanded, setExpanded] = useState(defaultExpanded);

    useEffect(() => {
        setExpanded(defaultExpanded);
    }, [text, defaultExpanded]);

    if (!bilingual) {
        return <span className="feed-inline-text whitespace-pre-wrap break-words" style={{ color: textColor }}>{text}</span>;
    }

    return (
        <span className="feed-inline-bilingual whitespace-pre-wrap break-words" style={{ color: textColor }}>
            <span className="feed-inline-original whitespace-pre-wrap break-words">{bilingual.original}</span>
            {" "}
            <button
                type="button"
                className="feed-inline-translation-toggle chat-bilingual-toggle text-[var(--c-action-blue,#246bfd)] opacity-80"
                onClick={(e) => {
                    e.stopPropagation();
                    setExpanded(v => !v);
                }}
                aria-expanded={expanded}
            >
                {expanded ? "收起中文" : "中文"}
            </button>
            {expanded && (
                <span className="feed-inline-translation whitespace-pre-wrap break-words" style={{ color: translationColor }}>
                    {" / "}
                    {bilingual.translated}
                </span>
            )}
        </span>
    );
}

// ── Time formatting helper ──

function formatTimeAgo(isoStr: string): string {
    const now = Date.now();
    const then = new Date(isoStr).getTime();
    const diff = Math.floor((now - then) / 1000);

    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    if (diff < 172800) return "昨天";
    if (diff < 604800) return `${Math.floor(diff / 86400)}天前`;

    const d = new Date(isoStr);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}
