"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type TouchEvent, type UIEvent, type WheelEvent } from "react";
import { ShareFat } from "@phosphor-icons/react";
import {
  AtSign,
  Bell,
  Bookmark,
  ChevronDown,
  ChevronLeft,
  Heart,
  Home,
  ImagePlus,
  Loader2,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Plus,
  RotateCw,
  Search,
  Send,
  Smile,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";

import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { incrementEventCounter } from "@/lib/memory-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { Toggle } from "@/components/ui/form";
import { CheckPhoneBilingualText } from "@/components/checkphone/checkphone-bilingual-text";
import { normalizeBilingualTextInput, splitBilingualText } from "@/lib/bilingual-text";
import { DEFAULT_XIAOHONGSHU_BILINGUAL_PROMPT } from "@/lib/bilingual-prompt-defaults";
import {
  applyCharacterActivityComment,
  applyCharacterCommentReply,
  applyCharacterMentionReply,
  applyCharacterReaction,
  applyNpcCommentReply,
  applyNpcMoreComments,
  applyNpcReaction,
  generateXiaohongshuCharacterActivity,
  generateXiaohongshuCharacterMentionReply,
  generateXiaohongshuCharacterReplyToUserComment,
  generateXiaohongshuCharacterReactionToUserPost,
  generateXiaohongshuNpcFeed,
  generateXiaohongshuNpcDmReply,
  generateXiaohongshuNpcMoreComments,
  generateXiaohongshuNpcReplyToUserComment,
  generateXiaohongshuNpcReactionForUserPost,
  XiaohongshuGenerationError,
} from "@/lib/xiaohongshu-engine";
import {
  createUserXiaohongshuNote,
  loadXiaohongshuState,
  makeXiaohongshuNpcId,
  makeXiaohongshuComment,
  makeXiaohongshuNotification,
  saveXiaohongshuState,
} from "@/lib/xiaohongshu-storage";
import {
  deleteXiaohongshuProjectionEventForComment,
  deleteXiaohongshuProjectionEventsForNote,
  recordXiaohongshuCommentEvent,
  recordXiaohongshuFollowUserEvent,
  recordXiaohongshuPostEvent,
  recordXiaohongshuReplyEvent,
} from "@/lib/xiaohongshu-memory";
import { resolveCharacterXiaohongshuDisplayName } from "@/lib/xiaohongshu-character-profile";
import type { ChatSharePayload } from "@/lib/chat-share";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import {
  DEFAULT_XIAOHONGSHU_SETTINGS,
  type ParsedXiaohongshuCharacterActivity,
  type XiaohongshuAccount,
  type XiaohongshuAuthorType,
  type XiaohongshuComment,
  type XiaohongshuNote,
  type XiaohongshuNotification,
  type XiaohongshuState,
  type XiaohongshuTabId,
  type XiaohongshuUserPostInput,
} from "@/lib/xiaohongshu-types";

type XiaohongshuAppProps = {
  onClose: (isBusy?: boolean) => void;
  onNotice?: (message: string) => void;
  visible?: boolean;
  onIdle?: () => void;
  onBusyChange?: (isBusy: boolean) => void;
};

type BusyState = "idle" | "npc-feed" | "character-activity" | "publish" | "npc-reaction" | "character-reaction" | "comment-reply" | "mention-reply" | "more-comments" | "dm-reply";
type XiaohongshuProfileTab = "notes" | "comments" | "saved" | "liked";
type XiaohongshuMessagePanel = "engagement" | "follow" | "comment";
type XiaohongshuHomeFeedTab = "follow" | "discover" | "video";
type XiaohongshuNoteCardVariant = "compact" | "regular" | "tall";
type XiaohongshuDmThread = {
  id: string;
  actorName: string;
  notifications: XiaohongshuNotification[];
  latest: XiaohongshuNotification;
  unreadCount: number;
};
type PendingDeleteTarget =
  | { type: "note"; noteId: string; title: string }
  | { type: "comment"; comment: XiaohongshuComment; noteTitle: string };
type PendingFeedAction = "refresh" | "clear";

const TABS: Array<{ id: XiaohongshuTabId; label: string; icon: typeof Home }> = [
  { id: "home", label: "首页", icon: Home },
  { id: "video", label: "附近", icon: MapPin },
  { id: "publish", label: "发布", icon: Plus },
  { id: "messages", label: "消息", icon: Bell },
  { id: "profile", label: "我的", icon: UserRound },
];

const PROFILE_TABS: Array<{ id: XiaohongshuProfileTab; label: string }> = [
  { id: "notes", label: "笔记" },
  { id: "comments", label: "评论" },
  { id: "saved", label: "收藏" },
  { id: "liked", label: "赞过" },
];

const HOME_FEED_TABS: Array<{ id: XiaohongshuHomeFeedTab; label: string }> = [
  { id: "follow", label: "关注" },
  { id: "discover", label: "发现" },
  { id: "video", label: "视频" },
];

const DEFAULT_XHS_AVATARS = [
  "/xiaohongshu/avatars/default-01.png",
  "/xiaohongshu/avatars/default-02.png",
  "/xiaohongshu/avatars/default-03.png",
  "/xiaohongshu/avatars/default-04.png",
  "/xiaohongshu/avatars/default-05.png",
  "/xiaohongshu/avatars/default-06.png",
];

const XHS_DM_EMOJIS = ["😊", "😂", "🥺", "😭", "😳", "👍", "❤️", "✨", "🌸", "🍵", "🥰", "🤔", "😎", "🙌", "💌", "🫶"];

const XHS_MAX_IMAGE_HEIGHT_RATIO = 4 / 3;
const XHS_TEXT_IMAGE_HEIGHT_RATIO = 1.18;
const XHS_VIDEO_IMAGE_HEIGHT_RATIO = XHS_TEXT_IMAGE_HEIGHT_RATIO;
const DEFAULT_XHS_IMAGE_FRAME_STYLE: CSSProperties = { aspectRatio: `1 / ${XHS_MAX_IMAGE_HEIGHT_RATIO}` };
const TEXT_XHS_IMAGE_FRAME_STYLE: CSSProperties = { aspectRatio: `1 / ${XHS_TEXT_IMAGE_HEIGHT_RATIO}` };
const VIDEO_XHS_IMAGE_FRAME_STYLE: CSSProperties = { aspectRatio: `1 / ${XHS_VIDEO_IMAGE_HEIGHT_RATIO}` };
const ICON_XHS_IMAGE_FRAME_STYLES: Record<XiaohongshuNoteCardVariant, CSSProperties> = {
  compact: { aspectRatio: "1 / 0.9" },
  regular: { aspectRatio: `1 / ${XHS_TEXT_IMAGE_HEIGHT_RATIO}` },
  tall: { aspectRatio: `1 / ${XHS_MAX_IMAGE_HEIGHT_RATIO}` },
};

function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(Math.max(0, Math.round(value)));
}

function formatBadgeCount(value: number): string {
  if (value > 99) return "99+";
  return String(Math.max(0, Math.round(value)));
}

function parseCompactCountLabel(value: string): number {
  const normalized = value.trim().replace(/[,，\s]/g, "");
  const match = /^(\d+(?:\.\d+)?)([kKwW万千])?$/.exec(normalized);
  if (!match) return 1;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 1;
  const unit = match[2];
  if (unit === "w" || unit === "W" || unit === "万") return Math.max(1, Math.round(amount * 10000));
  if (unit === "k" || unit === "K" || unit === "千") return Math.max(1, Math.round(amount * 1000));
  return Math.max(1, Math.round(amount));
}

function parseNotificationCountFromText(text: string): number {
  const match = text.match(/等\s*([0-9][\d.,，]*(?:\.\d+)?\s*(?:[kKwW万千])?)\s*人/);
  return match ? parseCompactCountLabel(match[1]) : 1;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMinutes = Math.max(1, Math.round((Date.now() - date.getTime()) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  if (diffMinutes < 1440) return `${Math.round(diffMinutes / 60)}小时前`;
  return `${Math.round(diffMinutes / 1440)}天前`;
}

function splitColumns<T>(items: T[]): [T[], T[]] {
  const left: T[] = [];
  const right: T[] = [];
  items.forEach((item, index) => {
    if (index % 2 === 0) left.push(item);
    else right.push(item);
  });
  return [left, right];
}

function addId(list: string[], id: string): string[] {
  return list.includes(id) ? list : [id, ...list];
}

function removeId(list: string[], id: string): string[] {
  return list.filter(item => item !== id);
}

function accountKey(account: Pick<XiaohongshuAccount, "type" | "id">): string {
  return `${account.type}:${account.id}`;
}

function noteAuthorKey(note: XiaohongshuNote): string {
  if (note.source === "user") return "";
  const id = note.authorId || (note.source === "npc" ? makeXiaohongshuNpcId(note.authorName) : note.source);
  return accountKey({ type: note.source, id });
}

function dedupeAccounts(accounts: XiaohongshuAccount[]): XiaohongshuAccount[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    const key = accountKey(account);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeNpcAccount(name: string): XiaohongshuAccount {
  return {
    type: "npc",
    id: makeXiaohongshuNpcId(name),
    name,
    followedAt: new Date().toISOString(),
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function pickDefaultAvatar(seed: string): string {
  return DEFAULT_XHS_AVATARS[hashString(seed || "npc") % DEFAULT_XHS_AVATARS.length];
}

function XhsAvatar({ className, src, name }: { className: string; src?: string | null; name: string }) {
  const isDefaultAvatar = Boolean(src?.startsWith("/xiaohongshu/avatars/"));
  return (
    <div className={`${className}${isDefaultAvatar ? " xhs-default-avatar" : ""}`}>
      {src ? <img src={src} alt="" /> : <span>{(name || "?").slice(0, 1)}</span>}
    </div>
  );
}

function XhsDislikeIcon() {
  return (
    <svg className="xhs-comment-dislike-icon" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" />
      <path d="M8.3 9.7h1.9" />
      <path d="M13.8 9.7h1.9" />
      <path d="M8.9 15.5c1.7-.85 4.5-.85 6.2 0" />
    </svg>
  );
}

function getImageFrameStyle(width?: number, height?: number): CSSProperties {
  if (!width || !height || width <= 0 || height <= 0) return DEFAULT_XHS_IMAGE_FRAME_STYLE;
  const heightRatio = Math.min(height / width, XHS_MAX_IMAGE_HEIGHT_RATIO);
  return { aspectRatio: `1 / ${heightRatio.toFixed(4)}` };
}

function getXhsPlainText(text: string): string {
  const normalized = normalizeBilingualTextInput(text);
  return splitBilingualText(normalized)?.original ?? normalized;
}

function getNoteCardVariant(note: Pick<XiaohongshuNote, "body" | "title">): XiaohongshuNoteCardVariant {
  const textLength = getXhsPlainText(note.body).length + getXhsPlainText(note.title).length;
  if (textLength > 95) return "tall";
  if (textLength > 54) return "regular";
  return "compact";
}

function getIconImageFrameStyle(note: Pick<XiaohongshuNote, "body" | "title">): CSSProperties {
  return ICON_XHS_IMAGE_FRAME_STYLES[getNoteCardVariant(note)];
}

function noteHasUserComment(note: XiaohongshuNote): boolean {
  return note.comments.some(comment => comment.authorType === "user");
}

function findAddedCharacterComment(before: XiaohongshuNote, after: XiaohongshuNote, character: Character): XiaohongshuComment | null {
  const beforeIds = new Set(before.comments.map(comment => comment.id));
  return after.comments.find(comment =>
    !beforeIds.has(comment.id)
    && comment.authorType === "character"
    && comment.authorId === character.id
  ) ?? null;
}

function XiaohongshuOverviewGlyph({ type }: { type: "heart" | "user" | "chat" | "bookmark" }) {
  if (type === "heart") {
    return (
      <svg className="cp-xhs-overview-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 21.2c-.35 0-.7-.13-.98-.39C4.88 15.28 2 12.67 2 8.72 2 5.58 4.47 3.1 7.58 3.1c1.75 0 3.43.82 4.42 2.11.99-1.29 2.67-2.11 4.42-2.11C19.53 3.1 22 5.58 22 8.72c0 3.95-2.88 6.56-9.02 12.09-.28.26-.63.39-.98.39Z" />
      </svg>
    );
  }
  if (type === "bookmark") {
    return (
      <svg className="cp-xhs-overview-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.35 4.55c0-1.1.9-2 2-2h7.3c1.1 0 2 .9 2 2v16.1c0 .7-.8 1.1-1.36.68L12 18.1l-4.29 3.23a.82.82 0 0 1-1.36-.68V4.55Z" />
      </svg>
    );
  }
  if (type === "user") {
    return (
      <svg className="cp-xhs-overview-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 11.2a4.55 4.55 0 1 0 0-9.1 4.55 4.55 0 0 0 0 9.1ZM4.15 21.06c0-4.13 3.52-7.48 7.85-7.48s7.85 3.35 7.85 7.48c0 .54-.39.99-.92 1.07-2.12.31-4.43.47-6.93.47s-4.81-.16-6.93-.47a1.08 1.08 0 0 1-.92-1.07Z" />
      </svg>
    );
  }
  return (
    <svg className="cp-xhs-overview-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.15c5.54 0 10 3.82 10 8.55s-4.46 8.55-10 8.55c-1.11 0-2.18-.15-3.18-.44l-3.54 1.56a.75.75 0 0 1-1.02-.88l.9-3.3C3.22 15.69 2 13.56 2 11.7c0-4.73 4.46-8.55 10-8.55Z" />
      <circle cx="8.8" cy="11.45" r="1.18" fill="white" />
      <circle cx="15.2" cy="11.45" r="1.18" fill="white" />
    </svg>
  );
}

function getGenderClassName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "xhs-profile-gender xhs-profile-gender--female";
  if (normalized.includes("女") || normalized.includes("♀") || normalized.includes("female")) {
    return "xhs-profile-gender xhs-profile-gender--female";
  }
  if (normalized.includes("男") || normalized.includes("♂") || normalized.includes("male")) {
    return "xhs-profile-gender xhs-profile-gender--male";
  }
  return "xhs-profile-gender";
}

function isCharacterXiaohongshuAuthor(authorName: string, character: Character, displayName: string): boolean {
  const normalized = authorName.trim();
  if (!normalized) return false;
  return [displayName.trim(), character.name.trim()].filter(Boolean).includes(normalized);
}

function createCharacterPost(character: Character, activity: ParsedXiaohongshuCharacterActivity): XiaohongshuNote | null {
  if (!activity.post) return null;
  const now = new Date().toISOString();
  const displayName = resolveCharacterXiaohongshuDisplayName(character);
  const noteId = `xhs_char_note_${character.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const comments = activity.post.comments
    .filter(comment => comment.text)
    .map((comment, index) => {
      const parsedReplyIndex = /^.*_comment_(\d+)$/.exec(comment.replyToCommentId || "")?.[1];
      const isCharacterAuthor = isCharacterXiaohongshuAuthor(comment.authorName, character, displayName);
      return {
        ...makeXiaohongshuComment({
          noteId,
          authorType: isCharacterAuthor ? "character" : "npc",
          authorId: isCharacterAuthor ? character.id : makeXiaohongshuNpcId(comment.authorName),
          authorName: isCharacterAuthor ? displayName : comment.authorName,
          text: comment.text,
          replyTo: comment.replyTo,
          replyToCommentId: parsedReplyIndex ? `${noteId}_comment_${Number(parsedReplyIndex)}` : comment.replyToCommentId,
        }),
        id: `${noteId}_comment_${index + 1}`,
      };
    });
  return {
    id: noteId,
    type: activity.post.type,
    source: "character",
    authorId: character.id,
    authorName: displayName,
    title: activity.post.title || activity.post.body.slice(0, 24) || "新的笔记",
    body: activity.post.body,
    videoDescription: activity.post.videoDescription,
    coverIcon: activity.post.coverIcon || (activity.post.type === "video" ? "▶" : "✦"),
    tone: "blush",
    tags: activity.post.tags,
    likeCount: activity.post.likeCount,
    saveCount: activity.post.saveCount,
    commentCount: activity.post.commentCount,
    liked: false,
    saved: false,
    recentLikeNames: activity.post.recentLikeNames,
    recentSaveNames: activity.post.recentSaveNames,
    comments,
    imageDescription: activity.post.type === "post" ? activity.post.imageDescription : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function NoteDetailSlider({
  note,
  imageIds,
  imageMap,
}: {
  note: XiaohongshuNote;
  imageIds: string[];
  imageMap: Record<string, string>;
}) {
  const [activeSlide, setActiveSlide] = useState(0);
  return (
    <div className="xhs-note-slider-container" style={getImageFrameStyle(note.imageWidth, note.imageHeight)}>
      <div
        className="xhs-note-slider-track"
        onScroll={(e) => {
          const el = e.currentTarget;
          const index = Math.round(el.scrollLeft / (el.clientWidth || 1));
          setActiveSlide(index);
        }}
      >
        {imageIds.map((id, idx) => (
          <div key={id || idx} className="xhs-note-slider-item">
            {imageMap[id] ? (
              <img src={imageMap[id]} alt={`Slide ${idx + 1}`} className="xhs-note-real-image" />
            ) : (
              <div className="cp-xhs-cover cp-xhs-cover--ivory" style={{ width: "100%", height: "100%" }} />
            )}
          </div>
        ))}
      </div>
      <div className="xhs-note-slider-indicator">
        {activeSlide + 1} / {imageIds.length}
      </div>
      <div className="xhs-note-slider-dots">
        {imageIds.map((_, idx) => (
          <span key={idx} className={`xhs-slider-dot ${idx === activeSlide ? "is-active" : ""}`} />
        ))}
      </div>
    </div>
  );
}

function NoteImage({
  note,
  imageMap,
  hideTextImageDescription = false,
  collapseBilingualTranslation,
  isDetail,
}: {
  note: XiaohongshuNote;
  imageMap: Record<string, string>;
  hideTextImageDescription?: boolean;
  collapseBilingualTranslation: boolean;
  isDetail?: boolean;
}) {
  const imageIds = (note.imageAssetIds && note.imageAssetIds.length > 0)
    ? note.imageAssetIds
    : (note.imageAssetId ? [note.imageAssetId] : []);
  if (note.type === "video") {
    return (
      <div className={`cp-xhs-cover cp-xhs-cover--video cp-xhs-cover--${note.tone}`} style={VIDEO_XHS_IMAGE_FRAME_STYLE}>
        {note.imageAssetId && imageMap[note.imageAssetId] ? (
          <img src={imageMap[note.imageAssetId]} alt="" className="xhs-video-real-image" />
        ) : (
          <span>
            {note.videoDescription || note.imageDescription ? (
              <CheckPhoneBilingualText
                text={note.videoDescription || note.imageDescription || ""}
                tone="light"
                collapseBilingualTranslation={collapseBilingualTranslation}
              />
            ) : note.coverIcon}
          </span>
        )}
      </div>
    );
  }
  if (imageIds.length > 0 && imageIds.some(id => Boolean(imageMap[id]))) {
    if (isDetail && imageIds.length > 1) {
      return <NoteDetailSlider note={note} imageIds={imageIds} imageMap={imageMap} />;
    }
    const firstImgId = imageIds.find(id => Boolean(imageMap[id])) || imageIds[0];
    return (
      <div className="xhs-note-real-image-frame" style={getImageFrameStyle(note.imageWidth, note.imageHeight)}>
        <img src={imageMap[firstImgId]} alt="" className="xhs-note-real-image" />
        {!isDetail && imageIds.length > 1 ? (
          <div className="xhs-waterfall-multi-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="3" width="14" height="14" rx="2" />
              <path d="M7 21h12a2 2 0 0 0 2-2V7" />
            </svg>
          </div>
        ) : null}
      </div>
    );
  }
  if (note.imageDescription?.trim() && !hideTextImageDescription) {
    return (
      <div className={`cp-xhs-cover cp-xhs-cover--${note.tone} xhs-note-text-image`} style={TEXT_XHS_IMAGE_FRAME_STYLE}>
        <span>
          <CheckPhoneBilingualText
            text={note.imageDescription}
            tone="xiaohongshu"
            collapseBilingualTranslation={collapseBilingualTranslation}
          />
        </span>
      </div>
    );
  }
  return (
    <div className={`cp-xhs-cover cp-xhs-cover--${note.tone}`} style={getIconImageFrameStyle(note)}>
      <span className="cp-xhs-cover-icon">{note.coverIcon}</span>
    </div>
  );
}

function NoteCard({
  note,
  imageMap,
  avatarSrc,
  onOpen,
  hideTextImageDescription,
  collapseBilingualTranslation,
}: {
  note: XiaohongshuNote;
  imageMap: Record<string, string>;
  avatarSrc: string;
  onOpen: () => void;
  hideTextImageDescription?: boolean;
  collapseBilingualTranslation: boolean;
}) {
  const variant = getNoteCardVariant(note);
  return (
    <button type="button" className={`cp-xhs-note-card cp-xhs-note-card--${variant}`} onClick={onOpen}>
      <NoteImage
        note={note}
        imageMap={imageMap}
        hideTextImageDescription={hideTextImageDescription}
        collapseBilingualTranslation={collapseBilingualTranslation}
      />
      <div className="cp-xhs-note-body">
        <strong>
          <CheckPhoneBilingualText
            text={note.title}
            tone="xiaohongshu"
            collapseBilingualTranslation={collapseBilingualTranslation}
          />
        </strong>
        <p>
          <CheckPhoneBilingualText
            text={note.body}
            tone="xiaohongshu"
            collapseBilingualTranslation={collapseBilingualTranslation}
          />
        </p>
        <div className="cp-xhs-note-foot">
          <div className="cp-xhs-note-author">
            <XhsAvatar className="cp-xhs-note-author-avatar" src={avatarSrc} name={note.authorName} />
            <span>{note.authorName}</span>
          </div>
          <em className={note.liked ? "is-liked" : ""}>
            <Heart size={12} strokeWidth={2.4} fill={note.liked ? "currentColor" : "none"} />
            {formatCount(note.likeCount)}
          </em>
        </div>
      </div>
    </button>
  );
}

function orderCommentsForDisplay(comments: XiaohongshuComment[]): XiaohongshuComment[] {
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const indexById = new Map(comments.map((comment, index) => [comment.id, index]));
  const childrenByParent = new Map<string, XiaohongshuComment[]>();
  const childIds = new Set<string>();

  function wouldCreateCycle(commentId: string, parentId: string) {
    const seen = new Set<string>([commentId]);
    let currentId = parentId;
    while (currentId) {
      if (seen.has(currentId)) return true;
      seen.add(currentId);
      currentId = byId.get(currentId)?.replyToCommentId || "";
    }
    return false;
  }

  comments.forEach((comment) => {
    const parentId = comment.replyToCommentId;
    if (!parentId || !byId.has(parentId) || wouldCreateCycle(comment.id, parentId)) return;
    childIds.add(comment.id);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(comment);
    childrenByParent.set(parentId, children);
  });

  // 小红书式二级平铺：每条顶级评论下，把它的全部后代（回复、回复的回复…）
  // 平铺成一层，统一按添加顺序排——避免线程式 DFS 里"回复的回复"插队到
  // 更早的同级回复前面。
  const ordered: XiaohongshuComment[] = [];
  const visited = new Set<string>();

  function collectDescendants(id: string, acc: XiaohongshuComment[]) {
    for (const child of childrenByParent.get(id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      acc.push(child);
      collectDescendants(child.id, acc);
    }
  }

  for (const comment of comments) {
    if (childIds.has(comment.id) || visited.has(comment.id)) continue;
    visited.add(comment.id);
    ordered.push(comment);
    const descendants: XiaohongshuComment[] = [];
    collectDescendants(comment.id, descendants);
    descendants.sort((a, b) => (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0));
    ordered.push(...descendants);
  }

  // 兜底：循环引用等漏网的评论追加在末尾
  for (const comment of comments) {
    if (!visited.has(comment.id)) {
      visited.add(comment.id);
      ordered.push(comment);
    }
  }
  return ordered;
}

function collectCommentThreadIds(comments: XiaohongshuComment[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    comments.forEach((comment) => {
      if (comment.replyToCommentId && ids.has(comment.replyToCommentId) && !ids.has(comment.id)) {
        ids.add(comment.id);
        changed = true;
      }
    });
  }
  return ids;
}

function CommentList({
  comments,
  getAvatar,
  onReply,
  onDeleteComment,
  onVoteComment,
  collapseBilingualTranslation,
}: {
  comments: XiaohongshuComment[];
  getAvatar: (comment: XiaohongshuComment) => string;
  onReply: (comment: XiaohongshuComment) => void;
  onDeleteComment: (comment: XiaohongshuComment) => void;
  onVoteComment: (comment: XiaohongshuComment, vote: "like" | "dislike") => void;
  collapseBilingualTranslation: boolean;
}) {
  if (comments.length === 0) return <div className="cp-xhs-mini-empty">还没有评论</div>;
  const orderedComments = orderCommentsForDisplay(comments);
  return (
    <>
      {orderedComments.map((comment) => {
        const parentComment = comment.replyToCommentId
          ? comments.find(item => item.id === comment.replyToCommentId)
          : null;
        const targetName = parentComment?.authorName ?? (!comment.replyToCommentId ? comment.replyTo : undefined);
        const depth = parentComment || (!comment.replyToCommentId && comment.replyTo) ? 1 : 0;
        return (
          <div key={comment.id} className={`cp-xhs-comment-card cp-xhs-comment-card--depth-${depth}`}>
            <XhsAvatar className="cp-xhs-comment-avatar" src={getAvatar(comment)} name={comment.authorName} />
            <div className="cp-xhs-comment-content">
              <strong>
                {comment.authorName}
                {targetName ? <><span className="cp-xhs-comment-reply-label">回复</span>{targetName}</> : null}
              </strong>
              <p>
                <CheckPhoneBilingualText
                  text={comment.text}
                  tone="xiaohongshu"
                  variant="inline"
                  collapseBilingualTranslation={collapseBilingualTranslation}
                />
              </p>
              <div className="xhs-comment-actions">
                <div className="xhs-comment-text-actions">
                  <time className="xhs-comment-time" dateTime={comment.createdAt}>{formatTime(comment.createdAt)}</time>
                  <button type="button" onClick={() => onReply(comment)}>回复</button>
                  <button type="button" onClick={() => onDeleteComment(comment)}>删除</button>
                </div>
                <div className="xhs-comment-vote-actions">
                  <button
                    type="button"
                    className={`xhs-comment-vote-btn ${comment.liked ? "is-active" : ""}`}
                    onClick={() => onVoteComment(comment, "like")}
                    aria-label="点赞评论"
                  >
                    <Heart size={20} strokeWidth={2.15} fill={comment.liked ? "currentColor" : "none"} />
                    {comment.likeCount > 0 ? <span>{formatCount(comment.likeCount)}</span> : null}
                  </button>
                  <button
                    type="button"
                    className={`xhs-comment-vote-btn ${comment.disliked ? "is-active is-disliked" : ""}`}
                    onClick={() => onVoteComment(comment, "dislike")}
                    aria-label="点踩评论"
                  >
                    <XhsDislikeIcon />
                    {comment.dislikeCount > 0 ? <span>{formatCount(comment.dislikeCount)}</span> : null}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export function XiaohongshuApp({ onClose, onNotice, visible = true, onIdle, onBusyChange }: XiaohongshuAppProps) {
  const [state, setState] = useState<XiaohongshuState>(() => loadXiaohongshuState());
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedTab, setSelectedTab] = useState<XiaohongshuTabId>("home");
  const [homeFeedTab, setHomeFeedTab] = useState<XiaohongshuHomeFeedTab>("discover");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyState>("idle");
  const [error, setError] = useState("");
  const [debugErrorTitle, setDebugErrorTitle] = useState("暂时无法完成小红书操作。");
  const [debugRawOutput, setDebugRawOutput] = useState("");
  const [debugParseError, setDebugParseError] = useState("");
  const [imageMap, setImageMap] = useState<Record<string, string>>({});
  const [profileTopbarVisible, setProfileTopbarVisible] = useState(false);
  const [profileTab, setProfileTab] = useState<XiaohongshuProfileTab>("notes");
  const [commentDraft, setCommentDraft] = useState("");
  const [replyTarget, setReplyTarget] = useState<XiaohongshuComment | null>(null);
  const [commentComposerFocused, setCommentComposerFocused] = useState(false);
  const [videoCommentsOpen, setVideoCommentsOpen] = useState(false);
  const videoSwipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const videoLastWheelAtRef = useRef(0);
  const videoSettleTimerRef = useRef<number | null>(null);
  const [videoDragOffset, setVideoDragOffset] = useState(0);
  const [videoDragSettling, setVideoDragSettling] = useState(false);
  const [videoDragDirection, setVideoDragDirection] = useState<"previous" | "next" | null>(null);
  const [videoCaptionExpanded, setVideoCaptionExpanded] = useState(false);
  const [videoCaptionCanExpand, setVideoCaptionCanExpand] = useState(false);
  const [collapsedVideoCaption, setCollapsedVideoCaption] = useState("");
  const videoCaptionMeasureRef = useRef<HTMLDivElement | null>(null);
  const [messagePanel, setMessagePanel] = useState<XiaohongshuMessagePanel | null>(null);
  const [selectedDmThreadId, setSelectedDmThreadId] = useState<string | null>(null);
  const [dmDraft, setDmDraft] = useState("");
  const [dmEmojiOpen, setDmEmojiOpen] = useState(false);
  const [commentEmojiOpen, setCommentEmojiOpen] = useState(false);
  const [commentMentionOpen, setCommentMentionOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PendingDeleteTarget | null>(null);
  const [pendingFeedAction, setPendingFeedAction] = useState<PendingFeedAction | null>(null);
  const [profileDraft, setProfileDraft] = useState(state.profile);
  const [settingsDraft, setSettingsDraft] = useState(state.settings);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<XiaohongshuUserPostInput>({
    title: "",
    body: "",
    tags: [],
    image: {},
  });
  const [tagInput, setTagInput] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const profileCoverFileRef = useRef<HTMLInputElement | null>(null);
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  const mainScrollTopRef = useRef(0);

  const selectedNote = selectedNoteId ? state.notes.find(note => note.id === selectedNoteId) ?? null : null;
  const requestClose = () => onClose(busy !== "idle");
  const commentComposerExpanded = commentComposerFocused || Boolean(commentDraft.trim()) || Boolean(replyTarget) || commentEmojiOpen || commentMentionOpen;
  const unreadCount = state.notifications.reduce((total, item) => total + notificationUnreadWeight(item), 0);
  const engagementUnreadCount = state.notifications.reduce((total, item) => {
    if (item.type !== "like" && item.type !== "save") return total;
    return total + notificationUnreadWeight(item);
  }, 0);
  const followUnreadCount = state.notifications.filter(item => item.unread && item.type === "follow").length;
  const commentUnreadCount = state.notifications.filter(item => item.unread && item.type === "comment").length;
  const dmNotifications = state.notifications.filter(item => item.type === "dm");
  const dmThreads = useMemo<XiaohongshuDmThread[]>(() => {
    const groups = new Map<string, XiaohongshuNotification[]>();
    dmNotifications.forEach((notice) => {
      const threadName = notice.threadName?.trim() || notice.actorName.trim() || "小红书用户";
      const threadId = notice.threadId?.trim() || `dm:${threadName}`;
      groups.set(threadId, [...(groups.get(threadId) ?? []), notice]);
    });
    return Array.from(groups.entries())
      .flatMap(([threadId, notifications]) => {
        const sorted = [...notifications].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const latest = sorted[sorted.length - 1];
        if (!latest) return [];
        const actorName = latest.threadName || sorted.find(item => item.direction !== "outgoing")?.actorName || latest.actorName || "小红书用户";
        return [{
          id: threadId,
          actorName,
          notifications: sorted,
          latest,
          unreadCount: sorted.reduce((total, item) => total + notificationUnreadWeight(item), 0),
        }];
      })
      .sort((a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt));
  }, [dmNotifications]);
  const selectedDmThread = selectedDmThreadId ? dmThreads.find(thread => thread.id === selectedDmThreadId) ?? null : null;
  const selectedMessageNotifications = messagePanel
    ? state.notifications.filter(item => messagePanel === "engagement" ? item.type === "like" || item.type === "save" : item.type === messagePanel)
    : [];
  const selectedMessagePanelLabel = messagePanel === "engagement" ? "点赞和收藏" : messagePanel === "follow" ? "新增关注" : messagePanel === "comment" ? "评论" : "";
  const selectedMessagePanelTitle = messagePanel === "engagement" ? "收到的赞和收藏" : selectedMessagePanelLabel;
  const isMessageSubpage = selectedTab === "messages" && (Boolean(messagePanel) || Boolean(selectedDmThread));
  const selectedAuthorAccount = selectedNote ? makeAccountFromNote(selectedNote) : null;
  const selectedAuthorFollowing = isFollowingAccount(selectedAuthorAccount);

  useEffect(() => {
    const isBusy = busy !== "idle";
    onBusyChange?.(isBusy);
    if (!visible && !isBusy) {
      onIdle?.();
    }
  }, [busy, visible, onBusyChange, onIdle]);

  const hiddenFeedNoteIds = useMemo(() => new Set(state.feedHiddenNoteIds), [state.feedHiddenNoteIds]);
  const followedAccountKeys = useMemo(() => new Set(state.socialGraph.following.map(accountKey)), [state.socialGraph.following]);
  const discoverNotes = useMemo(() => state.notes.filter(note => note.type === "post" && note.feedScope !== "nearby" && !hiddenFeedNoteIds.has(note.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [hiddenFeedNoteIds, state.notes]);
  const nearbyNotes = useMemo(() => state.notes.filter(note => note.type === "post" && note.feedScope === "nearby" && !hiddenFeedNoteIds.has(note.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [hiddenFeedNoteIds, state.notes]);
  const followedNotes = useMemo(() => state.notes.filter(note => note.source !== "user" && !hiddenFeedNoteIds.has(note.id) && followedAccountKeys.has(noteAuthorKey(note))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [followedAccountKeys, hiddenFeedNoteIds, state.notes]);
  const videoNotes = useMemo(() => state.notes.filter(note => note.type === "video" && !hiddenFeedNoteIds.has(note.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [hiddenFeedNoteIds, state.notes]);
  const activeHomeNotes = homeFeedTab === "follow" ? followedNotes : homeFeedTab === "video" ? videoNotes : discoverNotes;
  const activeVideoNoteIndex = useMemo(() => videoNotes.findIndex(note => note.id === selectedNoteId), [selectedNoteId, videoNotes]);
  const activeVideoCaption = selectedNote?.type === "video" ? selectedNote.body : "";
  const myNotes = useMemo(() => state.notes.filter(note => note.source === "user").sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.notes]);
  const profileNotes = useMemo(() => {
    if (profileTab === "notes") return myNotes;
    const ids = profileTab === "comments"
      ? [
          ...state.userInteractions.commentedNoteIds,
          ...state.notes.filter(note => note.comments.some(comment => comment.authorType === "user")).map(note => note.id),
        ]
      : profileTab === "saved"
        ? [
            ...state.userInteractions.savedNoteIds,
            ...state.notes.filter(note => note.saved).map(note => note.id),
          ]
        : profileTab === "liked"
          ? [
              ...state.userInteractions.likedNoteIds,
              ...state.notes.filter(note => note.liked).map(note => note.id),
            ]
          : [];
    const idSet = new Set(ids);
    return state.notes
      .filter(note => idSet.has(note.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [myNotes, profileTab, state.notes, state.userInteractions]);
  const homeColumns = useMemo(() => splitColumns(activeHomeNotes), [activeHomeNotes]);
  const nearbyColumns = useMemo(() => splitColumns(nearbyNotes), [nearbyNotes]);
  const profileColumns = useMemo(() => splitColumns(profileNotes), [profileNotes]);
  const videoMovableStyle: CSSProperties = {
    transform: `translate3d(0, ${videoDragOffset}px, 0)`,
    transition: videoDragSettling ? "transform 190ms cubic-bezier(0.2, 0.82, 0.2, 1)" : "none",
    willChange: "transform",
  };
  const videoPreviewNote = videoDragDirection ? getSiblingVideo(videoDragDirection) : undefined;
  const videoPreviewStyle: CSSProperties | null = videoDragDirection
    ? {
        transform:
          videoDragDirection === "next"
            ? `translate3d(0, calc(${videoDragOffset}px + 100vh), 0)`
            : `translate3d(0, calc(${videoDragOffset}px - 100vh), 0)`,
        transition: videoDragSettling ? "transform 190ms cubic-bezier(0.2, 0.82, 0.2, 1)" : "none",
        willChange: "transform",
        pointerEvents: "none",
      }
    : null;
  const userIdentity = useMemo(() => resolveUserIdentity(undefined, "xiaohongshu") ?? resolveUserIdentity(), []);
  const userAvatar = userIdentity?.avatarUrl || pickDefaultAvatar(`user:${userIdentity?.id || state.profile.nickname}`);
  const profileCoverImage = state.profile.coverImageAssetId ? imageMap[state.profile.coverImageAssetId] : "";
  const profileCoverStyle: CSSProperties | undefined = profileCoverImage
    ? { backgroundImage: `linear-gradient(180deg, rgba(0,0,0,0.34), rgba(0,0,0,0.54)), url(${profileCoverImage})` }
    : undefined;
  const profileStats = useMemo(() => ({
    followingCount: state.socialGraph.following.length,
    followerCount: state.socialGraph.followers.length,
    likedAndSavedCount: state.notes
      .filter(note => note.source === "user")
      .reduce((total, note) => total + note.likeCount + note.saveCount, 0),
  }), [state.notes, state.socialGraph.followers.length, state.socialGraph.following.length]);
  const characterAvatarMap = useMemo(() => {
    const map = new Map<string, string>();
    characters.forEach((character) => {
      if (character.avatar) map.set(character.id, character.avatar);
    });
    return map;
  }, [characters]);
  const followedMentionCharacters = useMemo(() => {
    const characterById = new Map(characters.map(character => [character.id, character]));
    return state.socialGraph.following
      .filter(account => account.type === "character")
      .map(account => {
        const character = characterById.get(account.id);
        if (!character) return null;
        return {
          account,
          character,
          displayName: account.name || resolveCharacterXiaohongshuDisplayName(character),
          avatar: account.avatar || character.avatar || "",
        };
      })
      .filter((item): item is { account: XiaohongshuAccount; character: Character; displayName: string; avatar: string } => Boolean(item));
  }, [characters, state.socialGraph.following]);

  function findMentionCharacterInText(text: string): Character | undefined {
    return [...followedMentionCharacters]
      .sort((left, right) => right.displayName.length - left.displayName.length)
      .find(item => text.includes(`@${item.displayName}`))
      ?.character;
  }

  function clearErrorState() {
    setError("");
    setDebugErrorTitle("暂时无法完成小红书操作。");
    setDebugRawOutput("");
    setDebugParseError("");
  }

  function handleGenerationError(err: unknown, title = "暂时无法完成小红书操作。") {
    const message = err instanceof Error ? err.message : String(err);
    setDebugErrorTitle(title);
    setError(message);
    if (err instanceof XiaohongshuGenerationError) {
      setDebugRawOutput(err.rawOutput || "");
      setDebugParseError(err.parseError || "");
    } else {
      setDebugRawOutput("");
      setDebugParseError(message);
    }
    onNotice?.(message);
  }

  function resolveAuthorAvatar(source: XiaohongshuAuthorType, authorId: string, authorName: string, seed: string): string {
    if (source === "user") return userAvatar;
    if (source === "character") return characterAvatarMap.get(authorId) || pickDefaultAvatar(`character:${authorId || authorName}`);
    return pickDefaultAvatar(`npc:${authorName || authorId || seed}`);
  }

  function getNoteAvatar(note: XiaohongshuNote): string {
    return resolveAuthorAvatar(note.source, note.authorId, note.authorName, note.id);
  }

  function getCommentAvatar(comment: XiaohongshuComment): string {
    return resolveAuthorAvatar(comment.authorType, comment.authorId, comment.authorName, comment.id);
  }

  function getNotificationAvatar(actorName: string, seed: string): string {
    const character = characters.find(item =>
      item.name === actorName || resolveCharacterXiaohongshuDisplayName(item) === actorName
    );
    if (character?.avatar) return character.avatar;
    if (actorName === state.profile.nickname || actorName === userIdentity?.name) return userAvatar;
    return pickDefaultAvatar(`notice:${actorName || seed}`);
  }

  function getNotificationNote(notice: XiaohongshuNotification): XiaohongshuNote | null {
    if (!notice.noteId) return null;
    return state.notes.find(note => note.id === notice.noteId) ?? null;
  }

  function renderNotificationThumbnail(notice: XiaohongshuNotification) {
    const note = getNotificationNote(notice);
    if (note?.imageAssetId && imageMap[note.imageAssetId]) {
      return <img src={imageMap[note.imageAssetId]} alt="" />;
    }
    return <span>{getXhsPlainText(notice.thumbnailText || note?.title || "笔记")}</span>;
  }

  function notificationEngagementCount(notice: XiaohongshuNotification): number {
    if (notice.type !== "like" && notice.type !== "save") return 1;
    return Math.max(1, Math.round(notice.count ?? parseNotificationCountFromText(notice.text)));
  }

  function notificationUnreadWeight(notice: XiaohongshuNotification): number {
    if (!notice.unread) return 0;
    return notificationEngagementCount(notice);
  }

  function notificationActorLabel(notice: XiaohongshuNotification) {
    if (notice.type === "like" || notice.type === "save") {
      const match = notice.text.match(/^(.+?)等\s*[0-9][\d.,，]*(?:\.\d+)?\s*(?:[kKwW万千])?\s*人/);
      return match?.[1]?.trim() || notice.actorName;
    }
    return notice.actorName;
  }

  function formatNotificationAction(notice: XiaohongshuNotification) {
    if (notice.type === "like") {
      const count = notificationEngagementCount(notice);
      return count > 1 ? `等${formatCount(count)}人赞了你的笔记` : "赞了你的笔记";
    }
    if (notice.type === "save") {
      const count = notificationEngagementCount(notice);
      return count > 1 ? `等${formatCount(count)}人收藏了你的笔记` : "收藏了你的笔记";
    }
    if (notice.type === "follow") return "关注了你";
    if (notice.type === "comment") return "评论了你的笔记";
    return notice.text;
  }

  function formatNotificationPreview(notice: XiaohongshuNotification) {
    if (notice.type !== "comment") return "";
    return notice.text
      .replace(new RegExp(`^${notice.actorName}\\s*(评论了你的笔记|回复了你)[:：]?\\s*`), "")
      .trim();
  }

  function notificationMatchesMessagePanel(notice: XiaohongshuNotification, panel: XiaohongshuMessagePanel): boolean {
    if (panel === "engagement") return notice.type === "like" || notice.type === "save";
    return notice.type === panel;
  }

  function handleOpenMessagePanel(panel: XiaohongshuMessagePanel) {
    setSelectedDmThreadId(null);
    setMessagePanel(panel);
    setState((current) => {
      let hasUnread = false;
      const notifications = current.notifications.map((notice) => {
        if (!notice.unread || !notificationMatchesMessagePanel(notice, panel)) return notice;
        hasUnread = true;
        return { ...notice, unread: false };
      });
      if (!hasUnread) return current;
      return saveXiaohongshuState({
        ...current,
        notifications,
      });
    });
  }

  function handleOpenDmThread(thread: XiaohongshuDmThread) {
    setMessagePanel(null);
    setSelectedDmThreadId(thread.id);
    const noticeIds = new Set(thread.notifications.map(notice => notice.id));
    setState((current) => {
      let hasUnread = false;
      const notifications = current.notifications.map((notice) => {
        if (!notice.unread || !noticeIds.has(notice.id)) return notice;
        hasUnread = true;
        return { ...notice, unread: false };
      });
      if (!hasUnread) return current;
      return saveXiaohongshuState({
        ...current,
        notifications,
      });
    });
  }

  function createOutgoingDmMessage(thread: XiaohongshuDmThread, text: string, createdAt = new Date().toISOString()): XiaohongshuNotification {
    const userName = state.profile.nickname || userIdentity?.name || "我";
    return {
      ...makeXiaohongshuNotification({
        type: "dm",
        actorName: userName,
        text,
        thumbnailText: "私信",
        direction: "outgoing",
        threadId: thread.id,
        threadName: thread.actorName,
        unread: false,
      }),
      createdAt,
    };
  }

  function handleSendDmMessage(thread: XiaohongshuDmThread) {
    const text = dmDraft.trim();
    if (!text || busy !== "idle") return;
    setDmDraft("");
    setDmEmojiOpen(false);
    clearErrorState();
    const userMessage = createOutgoingDmMessage(thread, text);
    const current = saveXiaohongshuState({
      ...state,
      notifications: [userMessage, ...state.notifications],
    });
    setState(current);
  }

  async function handleGenerateDmReply(thread: XiaohongshuDmThread) {
    if (busy !== "idle") return;
    setBusy("dm-reply");
    clearErrorState();
    setDmEmojiOpen(false);
    const pendingText = dmDraft.trim();
    const pendingMessage = pendingText ? createOutgoingDmMessage(thread, pendingText, new Date().toISOString()) : null;
    if (pendingMessage) setDmDraft("");
    let current = pendingMessage
      ? saveXiaohongshuState({
          ...state,
          notifications: [pendingMessage, ...state.notifications],
        })
      : state;
    if (pendingMessage) setState(current);
    const threadId = thread.id;
    const threadName = thread.actorName;
    const userName = state.profile.nickname || userIdentity?.name || "我";
    const baseMessages = pendingMessage ? [...thread.notifications, pendingMessage] : thread.notifications;
    const latestUserText = pendingMessage?.text ?? [...baseMessages].reverse().find(message => message.direction === "outgoing")?.text ?? "";
    if (!latestUserText) {
      setBusy("idle");
      onNotice?.("请先发送一条私信");
      return;
    }
    try {
      const reply = await generateXiaohongshuNpcDmReply({
        threadName,
        userName,
        messages: baseMessages,
        latestUserText,
        settings: current.settings,
      });
      const replies = reply.messages
        .filter(Boolean)
        .map((message, index) => ({
          ...makeXiaohongshuNotification({
            type: "dm" as const,
            actorName: threadName,
            text: message,
            thumbnailText: "私信",
            direction: "incoming" as const,
            threadId,
            threadName,
            unread: selectedDmThreadId !== threadId,
          }),
          createdAt: new Date(Date.now() + index + 1).toISOString(),
        }));
      if (replies.length > 0) {
        current = saveXiaohongshuState({
          ...current,
          notifications: [...replies, ...current.notifications],
        });
        setState(current);
      }
    } catch (err) {
      handleGenerationError(err, "暂时无法生成私信回复。");
    } finally {
      setBusy("idle");
    }
  }

  function touchCharacterMemory(character: Character) {
    incrementEventCounter(character.id);
    maybeRunSummarization(character.id, character.name)
      .catch(err => console.warn("[Xiaohongshu] Summarization check failed:", err));
  }

  function recordCharacterThreadCommentEvents(
    character: Character,
    sourceNote: XiaohongshuNote,
    appliedNote: XiaohongshuNote,
    threadComments: XiaohongshuComment[],
  ) {
    threadComments
      .filter(comment =>
        comment.authorType === "character"
        && comment.authorId === character.id
        && comment.text.trim()
        && (comment.replyToCommentId || comment.replyTo)
      )
      .forEach((comment) => {
        const targetComment = comment.replyToCommentId
          ? appliedNote.comments.find(item => item.id === comment.replyToCommentId)
          : undefined;
        recordXiaohongshuReplyEvent({
          characterId: character.id,
          characterName: character.name,
          note: sourceNote,
          comment,
          targetComment,
        });
      });
  }

  function makeCharacterAccount(character: Character): XiaohongshuAccount {
    return {
      type: "character",
      id: character.id,
      name: resolveCharacterXiaohongshuDisplayName(character),
      avatar: character.avatar || undefined,
      followedAt: new Date().toISOString(),
    };
  }

  function makeAccountFromNote(note: XiaohongshuNote): XiaohongshuAccount | null {
    if (note.source === "user") return null;
    return {
      type: note.source,
      id: note.authorId || (note.source === "npc" ? makeXiaohongshuNpcId(note.authorName) : note.source),
      name: note.authorName,
      followedAt: new Date().toISOString(),
    };
  }

  function isFollowingAccount(account: Pick<XiaohongshuAccount, "type" | "id"> | null): boolean {
    if (!account) return false;
    const key = accountKey(account);
    return state.socialGraph.following.some(item => accountKey(item) === key);
  }

  function addFollowersToState(current: XiaohongshuState, accounts: XiaohongshuAccount[], note?: XiaohongshuNote): { next: XiaohongshuState; added: XiaohongshuAccount[] } {
    const existing = new Set(current.socialGraph.followers.map(accountKey));
    const added = dedupeAccounts(accounts.filter(account => account.name.trim()))
      .filter(account => !existing.has(accountKey(account)))
      .map(account => ({ ...account, followedAt: account.followedAt || new Date().toISOString() }));
    if (added.length === 0) return { next: current, added };
    const notifications = added.map(account => makeXiaohongshuNotification({
      type: "follow" as const,
      noteId: note?.id,
      actorName: account.name,
      text: `${account.name} 关注了你`,
      thumbnailText: note?.title,
      unread: true,
    }));
    return {
      added,
      next: {
        ...current,
        profile: {
          ...current.profile,
          followerCount: current.socialGraph.followers.length + added.length,
        },
        socialGraph: {
          ...current.socialGraph,
          followers: [...added, ...current.socialGraph.followers],
        },
        notifications: [...notifications, ...current.notifications],
      },
    };
  }

  useEffect(() => {
    setCharacters(loadCharacters());
  }, []);

  useEffect(() => {
    const handleExternalUpdate = () => {
      setState(loadXiaohongshuState());
      setImageMap({});
    };
    window.addEventListener("xiaohongshu-updated", handleExternalUpdate);
    return () => window.removeEventListener("xiaohongshu-updated", handleExternalUpdate);
  }, []);

  useEffect(() => {
    setProfileTopbarVisible(false);
    if (selectedTab !== "messages") {
      setMessagePanel(null);
      setSelectedDmThreadId(null);
      setDmEmojiOpen(false);
    }
  }, [selectedTab]);

  useEffect(() => {
    setDmDraft("");
    setDmEmojiOpen(false);
  }, [selectedDmThreadId]);

  useEffect(() => {
    setCommentDraft("");
    setReplyTarget(null);
    setCommentComposerFocused(false);
    setVideoCommentsOpen(false);
    setVideoDragOffset(0);
    setVideoDragSettling(false);
    setVideoDragDirection(null);
    setVideoCaptionExpanded(false);
    setVideoCaptionCanExpand(false);
    setCollapsedVideoCaption("");
  }, [selectedNoteId]);

  useLayoutEffect(() => {
    if (selectedNoteId) {
      detailScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      return;
    }
    mainScrollRef.current?.scrollTo({ top: mainScrollTopRef.current, left: 0, behavior: "auto" });
  }, [selectedNoteId]);

  useEffect(() => {
    return () => {
      if (videoSettleTimerRef.current !== null) {
        window.clearTimeout(videoSettleTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!activeVideoCaption) {
      setVideoCaptionCanExpand(false);
      setCollapsedVideoCaption("");
      return;
    }
    if (videoCaptionExpanded) return;

    const frame = window.requestAnimationFrame(() => {
      const measureNode = videoCaptionMeasureRef.current;
      if (!measureNode) return;

      const computedStyle = window.getComputedStyle(measureNode);
      const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 19.6;
      const maxHeight = lineHeight * 3 + 1;

      measureNode.textContent = activeVideoCaption;
      if (measureNode.scrollHeight <= maxHeight) {
        setVideoCaptionCanExpand(false);
        setCollapsedVideoCaption(activeVideoCaption);
        return;
      }

      let left = 0;
      let right = activeVideoCaption.length;
      let best = "";
      while (left <= right) {
        const middle = Math.floor((left + right) / 2);
        const candidate = activeVideoCaption.slice(0, middle).trimEnd();
        measureNode.textContent = `${candidate}...  展开`;
        if (measureNode.scrollHeight <= maxHeight) {
          best = candidate;
          left = middle + 1;
        } else {
          right = middle - 1;
        }
      }

      setVideoCaptionCanExpand(true);
      setCollapsedVideoCaption(best.slice(0, Math.max(0, best.length - 1)).trimEnd());
    });

    return () => window.cancelAnimationFrame(frame);
  }, [selectedNote?.id, activeVideoCaption, videoCaptionExpanded]);

  useEffect(() => {
    const assetIds = Array.from(new Set([
      ...state.notes.flatMap(note => (note.imageAssetIds && note.imageAssetIds.length > 0 ? note.imageAssetIds : [note.imageAssetId])),
      state.profile.coverImageAssetId,
    ].filter(Boolean))) as string[];
    assetIds.forEach((assetId) => {
      if (imageMap[assetId]) return;
      getChatImageFromIndexedDB(assetId)
        .then((dataUrl) => {
          if (dataUrl) setImageMap(prev => ({ ...prev, [assetId]: dataUrl }));
        })
        .catch(() => undefined);
    });
  }, [state.notes, state.profile.coverImageAssetId, imageMap]);

  function persist(next: XiaohongshuState) {
    const saved = saveXiaohongshuState(next);
    setState(saved);
    return saved;
  }

  async function generateNpcFeedState(baseState: XiaohongshuState, activeSettings: XiaohongshuState["settings"]): Promise<{ state: XiaohongshuState; generated: XiaohongshuNote[] }> {
    const generated = await generateXiaohongshuNpcFeed(
      activeSettings,
      baseState.socialGraph.following.filter(account => account.type === "npc"),
      baseState.profile.ipLocation,
      baseState.profile.nickname,
    );
    if (generated.length === 0) throw new Error("没有解析到小红书笔记。");
    return {
      generated,
      state: saveXiaohongshuState({
        ...baseState,
        notes: [
          ...generated,
          ...baseState.notes,
        ],
      }),
    };
  }

  async function generateCharacterActivityState(baseState: XiaohongshuState, activeSettings: XiaohongshuState["settings"]): Promise<XiaohongshuState> {
    const ids = activeSettings.participantCharacterIds;
    let current = baseState;
    if (ids.length === 0) return current;

    const participants = ids
      .map(characterId => characters.find(item => item.id === characterId))
      .filter((character): character is Character => Boolean(character));
    let successCount = 0;
    let firstError: unknown = null;

    for (const character of participants) {
      let activity: ParsedXiaohongshuCharacterActivity | null = null;
      try {
        activity = await generateXiaohongshuCharacterActivity(character.id, current.notes.slice(0, 30), activeSettings);
      } catch (err) {
        firstError ??= err;
        console.warn("[Xiaohongshu] Character activity failed:", character.name, err);
        continue;
      }
      if (!activity) continue;
      successCount += 1;

      const collectedNotifications: XiaohongshuState["notifications"] = [];
      const updatedNotes = current.notes.map((note) => {
        const related = activity.comments.filter(comment => comment.noteId === note.id);
        if (related.length === 0) return note;
        let nextNote = note;
        for (const parsed of related) {
          if (!parsed.text.trim()) continue;
          const result = applyCharacterActivityComment({
            note: nextNote,
            character,
            text: parsed.text,
            liked: parsed.liked,
            saved: parsed.saved,
            thread: parsed.thread,
          });
          nextNote = result.note;
          collectedNotifications.push(...result.notifications);
          recordXiaohongshuCommentEvent({
            characterId: character.id,
            characterName: character.name,
            note,
            comment: result.mainComment,
            liked: parsed.liked,
            saved: parsed.saved,
          });
          recordCharacterThreadCommentEvents(character, note, result.note, result.threadComments);
          touchCharacterMemory(character);
        }
        return nextNote;
      });
      const characterPost = createCharacterPost(character, activity);
      if (characterPost) {
        recordXiaohongshuPostEvent({
          characterId: character.id,
          characterName: character.name,
          note: characterPost,
        });
        recordCharacterThreadCommentEvents(character, characterPost, characterPost, characterPost.comments);
        touchCharacterMemory(character);
      }
      current = saveXiaohongshuState({
        ...current,
        notes: characterPost ? [characterPost, ...updatedNotes] : updatedNotes,
        notifications: collectedNotifications.length > 0
          ? [...collectedNotifications, ...current.notifications]
          : current.notifications,
      });
      setState(current);
    }

    if (successCount === 0 && firstError) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
    return current;
  }

  async function handleGenerateHomeContent() {
    if (busy !== "idle") return;
    clearErrorState();
    try {
      const activeSettings = state.settings;
      setBusy("npc-feed");
      const { state: withNpc } = await generateNpcFeedState(state, activeSettings);
      setState(withNpc);

      if (activeSettings.participantCharacterIds.length > 0) {
        setBusy("character-activity");
        const withCharacters = await generateCharacterActivityState(withNpc, activeSettings);
        setState(withCharacters);
      }
      onNotice?.("小红书内容已生成");
    } catch (err) {
      handleGenerationError(err, "暂时无法刷新小红书内容。");
    } finally {
      setBusy("idle");
    }
  }

  function handleSaveProfile() {
    persist({
      ...state,
      profile: {
        ...profileDraft,
        followingCount: profileStats.followingCount,
        followerCount: profileStats.followerCount,
        likedAndSavedCount: profileStats.likedAndSavedCount,
      },
    });
    setProfileOpen(false);
  }

  function handleSaveSettings() {
    persist({
      ...state,
      settings: {
        ...settingsDraft,
        bilingualTranslationPrompt: settingsDraft.bilingualTranslationPrompt.trim() || DEFAULT_XIAOHONGSHU_BILINGUAL_PROMPT,
        sendToCharacterProbability: Math.max(0, Math.min(100, Number(settingsDraft.sendToCharacterProbability) || 0)),
      },
    });
    setSettingsOpen(false);
  }

  function handleResetSettingsDraft() {
    setSettingsDraft(DEFAULT_XIAOHONGSHU_SETTINGS);
  }

  async function processImageFile(file: File): Promise<XiaohongshuDraftImage | null> {
    return new Promise((resolve) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(file);
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const maxSize = 960;
        const sourceWidth = image.width;
        let sourceHeight = image.height;
        const sourceX = 0;
        let sourceY = 0;
        if (sourceHeight / sourceWidth > XHS_MAX_IMAGE_HEIGHT_RATIO) {
          sourceHeight = Math.round(sourceWidth * XHS_MAX_IMAGE_HEIGHT_RATIO);
          sourceY = Math.round((image.height - sourceHeight) / 2);
        }
        let width = sourceWidth;
        let height = sourceHeight;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round(height / width * maxSize);
            width = maxSize;
          } else {
            width = Math.round(width / height * maxSize);
            height = maxSize;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          URL.revokeObjectURL(objectUrl);
          resolve(null);
          return;
        }
        context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(objectUrl);
          if (!blob) {
            resolve(null);
            return;
          }
          saveChatImageToIndexedDB(blob).then((assetId) => {
            const preview = URL.createObjectURL(blob);
            setImageMap(prev => ({ ...prev, [assetId]: preview }));
            resolve({ assetId, dataUrl: preview, width: canvas.width, height: canvas.height });
          }).catch(() => resolve(null));
        }, "image/jpeg", 0.82);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      image.src = objectUrl;
    });
  }

  async function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;
    const results = (await Promise.all(files.map(processImageFile))).filter((img): img is XiaohongshuDraftImage => Boolean(img));
    if (results.length === 0) return;
    setDraft((prev) => {
      const existing = prev.images || (prev.image?.dataUrl ? [prev.image] : []);
      const nextImages = [...existing, ...results];
      return {
        ...prev,
        image: nextImages[0] || {},
        images: nextImages,
      };
    });
  }

  async function handleProfileCoverChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const maxWidth = 1440;
      let width = image.width;
      let height = image.height;
      if (width > maxWidth) {
        height = Math.round(height / width * maxWidth);
        width = maxWidth;
      }
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(objectUrl);
        if (!blob) return;
        saveChatImageToIndexedDB(blob).then((assetId) => {
          const preview = URL.createObjectURL(blob);
          setImageMap(prev => ({ ...prev, [assetId]: preview }));
          setState((current) => saveXiaohongshuState({
            ...current,
            profile: {
              ...current.profile,
              coverImageAssetId: assetId,
            },
          }));
        });
      }, "image/jpeg", 0.84);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
    };
    image.src = objectUrl;
  }

  async function handlePublish() {
    if (busy !== "idle" || (!draft.title.trim() && !draft.body.trim())) return;
    setBusy("publish");
    clearErrorState();
    try {
      const userNote = createUserXiaohongshuNote({ ...draft, tags: tagInput.split(/[,，、#\s]+/).filter(Boolean) }, state.profile);
      let current = saveXiaohongshuState({
        ...state,
        notes: [userNote, ...state.notes],
      });
      setState(current);
      setComposeOpen(false);
      setDraft({ title: "", body: "", tags: [], image: {} });
      setTagInput("");

      setBusy("npc-reaction");
      const npcReaction = await generateXiaohongshuNpcReactionForUserPost(userNote, current.settings);
      const npcApplied = applyNpcReaction(userNote, npcReaction);
      const npcFollowerAccounts = npcReaction.followerNames.map(makeNpcAccount);
      let nextAfterNpc: XiaohongshuState = {
        ...current,
        notes: current.notes.map(note => note.id === userNote.id ? npcApplied.note : note),
        notifications: [...npcApplied.notifications, ...current.notifications],
      };
      nextAfterNpc = addFollowersToState(nextAfterNpc, npcFollowerAccounts, userNote).next;
      current = saveXiaohongshuState(nextAfterNpc);
      setState(current);

      setBusy("character-reaction");
      for (const characterId of current.settings.participantCharacterIds) {
        if (Math.random() * 100 > current.settings.sendToCharacterProbability) continue;
        const character = characters.find(item => item.id === characterId);
        if (!character) continue;
        const latestNote = current.notes.find(note => note.id === userNote.id) ?? userNote;
        const reaction = await generateXiaohongshuCharacterReactionToUserPost(characterId, latestNote, current.settings);
        if (!reaction?.comment.trim()) continue;
        const applied = applyCharacterReaction(latestNote, character, reaction);
        const addedComment = findAddedCharacterComment(latestNote, applied.note, character);
        let nextAfterCharacter: XiaohongshuState = {
          ...current,
          notes: current.notes.map(note => note.id === latestNote.id ? applied.note : note),
          notifications: [...applied.notifications, ...current.notifications],
        };
        if (addedComment) {
          recordXiaohongshuCommentEvent({
            characterId: character.id,
            characterName: character.name,
            note: latestNote,
            comment: addedComment,
            liked: reaction.liked,
            saved: reaction.saved,
          });
          recordCharacterThreadCommentEvents(character, latestNote, applied.note, applied.threadComments);
          touchCharacterMemory(character);
        }
        if (reaction.followedAuthor) {
          const followerResult = addFollowersToState(nextAfterCharacter, [makeCharacterAccount(character)], latestNote);
          nextAfterCharacter = followerResult.next;
          if (followerResult.added.length > 0) {
            recordXiaohongshuFollowUserEvent({
              characterId: character.id,
              characterName: character.name,
              userDisplayName: latestNote.authorName,
            });
            touchCharacterMemory(character);
          }
        }
        current = saveXiaohongshuState(nextAfterCharacter);
        setState(current);
      }
      onNotice?.("小红书笔记已发布");
    } catch (err) {
      handleGenerationError(err, "暂时无法发布小红书笔记。");
    } finally {
      setBusy("idle");
    }
  }

  function handleToggleLike(note: XiaohongshuNote) {
    setState((current) => {
      let nextLiked = false;
      const notes = current.notes.map((item) => {
        if (item.id !== note.id) return item;
        nextLiked = !item.liked;
        return {
          ...item,
          liked: nextLiked,
          likeCount: Math.max(0, item.likeCount + (item.liked ? -1 : 1)),
          updatedAt: new Date().toISOString(),
        };
      });
      return saveXiaohongshuState({
        ...current,
        notes,
        userInteractions: {
          ...current.userInteractions,
          likedNoteIds: nextLiked ? addId(current.userInteractions.likedNoteIds, note.id) : removeId(current.userInteractions.likedNoteIds, note.id),
        },
      });
    });
  }

  function handleToggleSave(note: XiaohongshuNote) {
    setState((current) => {
      let nextSaved = false;
      const notes = current.notes.map((item) => {
        if (item.id !== note.id) return item;
        nextSaved = !item.saved;
        return {
          ...item,
          saved: nextSaved,
          saveCount: Math.max(0, item.saveCount + (item.saved ? -1 : 1)),
          updatedAt: new Date().toISOString(),
        };
      });
      return saveXiaohongshuState({
        ...current,
        notes,
        userInteractions: {
          ...current.userInteractions,
          savedNoteIds: nextSaved ? addId(current.userInteractions.savedNoteIds, note.id) : removeId(current.userInteractions.savedNoteIds, note.id),
        },
      });
    });
  }

  function handleToggleFollowAuthor(note: XiaohongshuNote) {
    const account = makeAccountFromNote(note);
    if (!account) return;
    setState((current) => {
      const key = accountKey(account);
      const following = current.socialGraph.following;
      const exists = following.some(item => accountKey(item) === key);
      const nextFollowing = exists
        ? following.filter(item => accountKey(item) !== key)
        : [{ ...account, followedAt: new Date().toISOString() }, ...following];
      return saveXiaohongshuState({
        ...current,
        profile: {
          ...current.profile,
          followingCount: nextFollowing.length,
        },
        socialGraph: {
          ...current.socialGraph,
          following: nextFollowing,
        },
      });
    });
  }

  function handleVoteComment(comment: XiaohongshuComment, vote: "like" | "dislike") {
    setState((current) => saveXiaohongshuState({
      ...current,
      notes: current.notes.map((note) => {
        if (note.id !== comment.noteId) return note;
        return {
          ...note,
          comments: note.comments.map((item) => {
            if (item.id !== comment.id) return item;
            if (vote === "like") {
              const liked = !item.liked;
              return {
                ...item,
                liked,
                disliked: liked ? false : item.disliked,
                likeCount: Math.max(0, item.likeCount + (liked ? 1 : -1)),
                dislikeCount: liked && item.disliked ? Math.max(0, item.dislikeCount - 1) : item.dislikeCount,
              };
            }
            const disliked = !item.disliked;
            return {
              ...item,
              disliked,
              liked: disliked ? false : item.liked,
              dislikeCount: Math.max(0, item.dislikeCount + (disliked ? 1 : -1)),
              likeCount: disliked && item.liked ? Math.max(0, item.likeCount - 1) : item.likeCount,
            };
          }),
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
  }

  async function submitUserComment(options: { mentionCharacter?: Character; textOverride?: string } = {}) {
    const text = (options.textOverride ?? commentDraft).trim();
    if (busy !== "idle" || !selectedNote || !text) return;
    const target = replyTarget && selectedNote.comments.some(comment => comment.id === replyTarget.id)
      ? replyTarget
      : undefined;
    const mentionCharacter = options.mentionCharacter ?? findMentionCharacterInText(text);
    const userComment = makeXiaohongshuComment({
      noteId: selectedNote.id,
      authorType: "user",
      authorId: "user",
      authorName: state.profile.nickname || "我",
      text,
      replyTo: target?.authorName,
      replyToCommentId: target?.id,
    });
    let current = saveXiaohongshuState({
      ...state,
      notes: state.notes.map(note => note.id === selectedNote.id
        ? {
            ...note,
            comments: [...note.comments, userComment],
            commentCount: note.commentCount + 1,
            updatedAt: new Date().toISOString(),
          }
        : note),
      userInteractions: {
        ...state.userInteractions,
        commentedNoteIds: addId(state.userInteractions.commentedNoteIds, selectedNote.id),
      },
    });
    setState(current);
    setCommentDraft("");
    setCommentComposerFocused(false);
    setCommentEmojiOpen(false);
    setCommentMentionOpen(false);
    setReplyTarget(null);
    setBusy(mentionCharacter ? "mention-reply" : "comment-reply");
    clearErrorState();
    try {
      let latestNote = current.notes.find(note => note.id === selectedNote.id);
      if (!latestNote) return;
      if (mentionCharacter) {
        const reaction = await generateXiaohongshuCharacterMentionReply(mentionCharacter.id, latestNote, userComment, target, current.settings);
        if (!reaction) {
          onNotice?.("该角色暂时没有可用的小红书回复配置");
          return;
        }
        if (reaction.comment.trim()) {
          const applied = applyCharacterMentionReply(latestNote, mentionCharacter, reaction, userComment.id);
          const addedComment = findAddedCharacterComment(latestNote, applied.note, mentionCharacter);
          if (addedComment) {
            recordXiaohongshuReplyEvent({
              characterId: mentionCharacter.id,
              characterName: mentionCharacter.name,
              note: latestNote,
              comment: addedComment,
              targetComment: userComment,
            });
            recordCharacterThreadCommentEvents(mentionCharacter, latestNote, applied.note, applied.threadComments);
            touchCharacterMemory(mentionCharacter);
          }
          current = saveXiaohongshuState({
            ...current,
            notes: current.notes.map(note => note.id === latestNote?.id ? applied.note : note),
            notifications: [...applied.notifications, ...current.notifications],
          });
          setState(current);
        }
        return;
      }
      const roleCharacterId = target?.authorType === "character"
        ? target.authorId
        : latestNote.source === "character"
          ? latestNote.authorId
          : "";
      const character = roleCharacterId ? characters.find(item => item.id === roleCharacterId) : undefined;
      if (character) {
        try {
          const reaction = await generateXiaohongshuCharacterReplyToUserComment(character.id, latestNote, userComment, target, current.settings);
          if (reaction?.comment.trim()) {
            const applied = applyCharacterCommentReply(latestNote, character, reaction, userComment.id);
            const addedComment = findAddedCharacterComment(latestNote, applied.note, character);
            if (addedComment) {
              recordXiaohongshuReplyEvent({
                characterId: character.id,
                characterName: character.name,
                note: latestNote,
                comment: addedComment,
                targetComment: userComment,
              });
              recordCharacterThreadCommentEvents(character, latestNote, applied.note, applied.threadComments);
              touchCharacterMemory(character);
            }
            current = saveXiaohongshuState({
              ...current,
              notes: current.notes.map(note => note.id === latestNote?.id ? applied.note : note),
              notifications: [...applied.notifications, ...current.notifications],
            });
            setState(current);
            latestNote = applied.note;
          }
        } catch (err) {
          handleGenerationError(err, "暂时无法生成评论回复。");
        }
      }
      const npcReply = await generateXiaohongshuNpcReplyToUserComment(latestNote, userComment, current.settings, target);
      const npcApplied = applyNpcCommentReply(latestNote, npcReply, userComment.id);
      current = saveXiaohongshuState({
        ...current,
        notes: current.notes.map(note => note.id === latestNote?.id ? npcApplied.note : note),
        notifications: [...npcApplied.notifications, ...current.notifications],
      });
      setState(current);
    } catch (err) {
      handleGenerationError(err, mentionCharacter ? "暂时无法生成@回复。" : "暂时无法生成评论回复。");
    } finally {
      setBusy("idle");
    }
  }

  function handleSubmitUserComment() {
    void submitUserComment();
  }

  async function handleLoadMoreComments(note: XiaohongshuNote) {
    if (busy !== "idle") return;
    const latestNote = state.notes.find(item => item.id === note.id) ?? note;
    setBusy("more-comments");
    clearErrorState();
    try {
      const reaction = await generateXiaohongshuNpcMoreComments(latestNote, state.settings);
      const addedCount = reaction.comments.filter(comment => comment.text).length;
      if (addedCount === 0) throw new Error("没有解析到新的小红书评论。");
      const updatedNote = applyNpcMoreComments(latestNote, reaction);
      setState(saveXiaohongshuState({
        ...state,
        notes: state.notes.map(item => item.id === latestNote.id ? updatedNote : item),
      }));
      onNotice?.(`已加载 ${addedCount} 条新评论`);
    } catch (err) {
      handleGenerationError(err, "暂时无法加载更多评论。");
    } finally {
      setBusy("idle");
    }
  }

  function requestDeleteNote(note: XiaohongshuNote) {
    setDeleteTarget({
      type: "note",
      noteId: note.id,
      title: note.title.trim() || note.body.trim().slice(0, 24) || "这篇笔记",
    });
  }

  function requestDeleteComment(comment: XiaohongshuComment) {
    const note = state.notes.find(item => item.id === comment.noteId);
    setDeleteTarget({
      type: "comment",
      comment,
      noteTitle: note?.title.trim() || note?.body.trim().slice(0, 24) || "这篇笔记",
    });
  }

  function handleDeleteComment(comment: XiaohongshuComment) {
    const sourceNote = state.notes.find(note => note.id === comment.noteId);
    const deletedCommentIdsForEvents = sourceNote ? collectCommentThreadIds(sourceNote.comments, comment.id) : new Set([comment.id]);
    deletedCommentIdsForEvents.forEach(id => deleteXiaohongshuProjectionEventForComment(id));
    setState((current) => {
      const notes = current.notes.map((note) => {
        if (note.id !== comment.noteId) return note;
        const deletedCommentIds = collectCommentThreadIds(note.comments, comment.id);
        const comments = note.comments.filter(item => !deletedCommentIds.has(item.id));
        return {
          ...note,
          comments,
          commentCount: Math.max(0, note.commentCount - deletedCommentIds.size),
          updatedAt: new Date().toISOString(),
        };
      });
      const targetNote = notes.find(note => note.id === comment.noteId);
      return saveXiaohongshuState({
        ...current,
        notes,
        userInteractions: {
          ...current.userInteractions,
          commentedNoteIds: targetNote && (comment.authorType !== "user" || noteHasUserComment(targetNote))
            ? current.userInteractions.commentedNoteIds
            : removeId(current.userInteractions.commentedNoteIds, comment.noteId),
        },
      });
    });
    if (replyTarget && deletedCommentIdsForEvents.has(replyTarget.id)) setReplyTarget(null);
  }

  function handleDeleteNote(noteId: string) {
    deleteXiaohongshuProjectionEventsForNote(noteId);
    setState((current) => saveXiaohongshuState({
      ...current,
      notes: current.notes.filter(note => note.id !== noteId),
      feedHiddenNoteIds: removeId(current.feedHiddenNoteIds, noteId),
      notifications: current.notifications.filter(notice => notice.noteId !== noteId),
      userInteractions: {
        likedNoteIds: removeId(current.userInteractions.likedNoteIds, noteId),
        savedNoteIds: removeId(current.userInteractions.savedNoteIds, noteId),
        commentedNoteIds: removeId(current.userInteractions.commentedNoteIds, noteId),
      },
    }));
    setSelectedNoteId(null);
    setVideoCommentsOpen(false);
    setReplyTarget(null);
    setCommentDraft("");
    setCommentEmojiOpen(false);
    setCommentMentionOpen(false);
  }

  function requestFeedAction(action: PendingFeedAction) {
    if (busy !== "idle") return;
    setPendingFeedAction(action);
  }

  function handleClearAllContent() {
    const visibleFeedIds = new Set([...discoverNotes, ...nearbyNotes, ...videoNotes].map(note => note.id));
    visibleFeedIds.forEach(noteId => deleteXiaohongshuProjectionEventsForNote(noteId));
    setState((current) => saveXiaohongshuState({
      ...current,
      feedHiddenNoteIds: Array.from(new Set([...current.feedHiddenNoteIds, ...visibleFeedIds])),
    }));
    if (selectedNoteId && visibleFeedIds.has(selectedNoteId)) {
      setSelectedNoteId(null);
      setVideoCommentsOpen(false);
    }
    setMessagePanel(null);
    setSelectedDmThreadId(null);
    setReplyTarget(null);
    setCommentDraft("");
    setCommentEmojiOpen(false);
    setCommentMentionOpen(false);
    onNotice?.("首页推荐、附近和视频内容已清空");
  }

  function handleConfirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.type === "note") {
      handleDeleteNote(deleteTarget.noteId);
    } else {
      handleDeleteComment(deleteTarget.comment);
    }
    setDeleteTarget(null);
  }

  async function handleConfirmFeedAction() {
    if (!pendingFeedAction) return;
    const action = pendingFeedAction;
    setPendingFeedAction(null);
    if (action === "refresh") {
      await handleGenerateHomeContent();
    } else {
      handleClearAllContent();
    }
  }

  function handlePickCommentEmoji(emoji: string) {
    setCommentDraft(prev => `${prev}${emoji}`);
    setCommentComposerFocused(true);
  }

  function handleMentionCharacter(displayName: string) {
    const mention = `@${displayName}`;
    setCommentDraft((current) => {
      const base = current.replace(/\s+$/g, "");
      if (base.includes(mention)) return `${base} `;
      return base ? `${base} ${mention} ` : `${mention} `;
    });
    setCommentMentionOpen(false);
    setCommentEmojiOpen(false);
    setCommentComposerFocused(true);
  }

  const commentToolbar = (
    <>
      {commentMentionOpen ? (
        <div className="xhs-comment-mention-panel">
          {followedMentionCharacters.length > 0 ? (
            followedMentionCharacters.map(({ account, displayName, avatar }) => (
              <button
                key={`${account.type}:${account.id}`}
                type="button"
                onMouseDown={event => event.preventDefault()}
                onClick={() => handleMentionCharacter(displayName)}
                disabled={busy !== "idle"}
              >
                <span>{avatar ? <img src={avatar} alt="" /> : displayName.slice(0, 1)}</span>
                <em>{displayName}</em>
              </button>
            ))
          ) : (
            <span className="xhs-comment-panel-empty">暂无已关注角色</span>
          )}
        </div>
      ) : null}
      {commentEmojiOpen ? (
        <div className="xhs-comment-emoji-panel">
          {XHS_DM_EMOJIS.map(emoji => (
            <button
              key={emoji}
              type="button"
              onMouseDown={event => event.preventDefault()}
              onClick={() => handlePickCommentEmoji(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
      <div className="xhs-comment-toolbar">
        <div className="xhs-comment-toolbar-icons">
          <button
            type="button"
            className={commentMentionOpen ? "is-active" : ""}
            aria-label="@已关注角色"
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              setCommentMentionOpen(prev => !prev);
              setCommentEmojiOpen(false);
            }}
            disabled={busy !== "idle"}
          >
            <AtSign size={22} strokeWidth={2.05} />
          </button>
          <button
            type="button"
            className={commentEmojiOpen ? "is-active" : ""}
            aria-label="选择表情"
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              setCommentEmojiOpen(prev => !prev);
              setCommentMentionOpen(false);
            }}
            disabled={busy !== "idle"}
          >
            <Smile size={22} strokeWidth={2.05} />
          </button>
        </div>
        <button
          type="button"
          className="xhs-comment-toolbar-send"
          onClick={handleSubmitUserComment}
          disabled={busy !== "idle" || !commentDraft.trim()}
        >
          {busy === "comment-reply" || busy === "mention-reply" ? <Loader2 className="cp-spin" size={15} /> : "发送"}
        </button>
      </div>
    </>
  );

  function handleMainScroll(event: UIEvent<HTMLDivElement>) {
    mainScrollTopRef.current = event.currentTarget.scrollTop;
    if (selectedTab !== "profile") {
      setProfileTopbarVisible(false);
      return;
    }
    const nextVisible = event.currentTarget.scrollTop >= 58;
    setProfileTopbarVisible(current => current === nextVisible ? current : nextVisible);
  }

  function openNote(noteId: string) {
    mainScrollTopRef.current = mainScrollRef.current?.scrollTop ?? mainScrollTopRef.current;
    setSelectedNoteId(noteId);
    setCommentEmojiOpen(false);
    setCommentMentionOpen(false);
  }

  function handleShareNote(note: XiaohongshuNote) {
    const description = (note.type === "video"
      ? note.videoDescription || note.imageDescription
      : note.imageDescription) || "";
    const share = {
      type: "xiaohongshu_note",
      authorName: note.authorName,
      title: getXhsPlainText(note.title),
      body: getXhsPlainText(note.body),
      description: getXhsPlainText(description),
      noteType: note.type,
      tags: note.tags,
      imageAssetId: note.imageAssetId,
      coverIcon: note.coverIcon,
      tone: note.tone,
    } satisfies ChatSharePayload;
    window.dispatchEvent(new CustomEvent("open-mini-chat", { detail: { share } }));
    onNotice?.("选择聊天对象后发送小红书帖子");
  }

  function getSiblingVideo(direction: "previous" | "next") {
    if (activeVideoNoteIndex < 0) return undefined;
    const nextIndex = direction === "previous" ? activeVideoNoteIndex - 1 : activeVideoNoteIndex + 1;
    return videoNotes[nextIndex];
  }

  function settleVideoDrag(nextNoteId?: string) {
    if (videoSettleTimerRef.current !== null) {
      window.clearTimeout(videoSettleTimerRef.current);
    }
    videoSettleTimerRef.current = window.setTimeout(() => {
      if (nextNoteId) setSelectedNoteId(nextNoteId);
      setVideoDragSettling(false);
      setVideoDragOffset(0);
      setVideoDragDirection(null);
      videoSettleTimerRef.current = null;
    }, 190);
  }

  function animateSiblingVideo(direction: "previous" | "next"): boolean {
    if (selectedNote?.type !== "video" || videoCommentsOpen) return false;
    const nextVideo = getSiblingVideo(direction);
    if (!nextVideo) return false;
    setVideoDragSettling(true);
    setVideoDragDirection(direction);
    setVideoDragOffset(direction === "next" ? -window.innerHeight : window.innerHeight);
    settleVideoDrag(nextVideo.id);
    return true;
  }

  function handleVideoWheel(event: WheelEvent<HTMLDivElement>) {
    if (videoCommentsOpen) return;
    const absY = Math.abs(event.deltaY);
    if (absY < 42 || absY < Math.abs(event.deltaX)) return;
    event.preventDefault();
    const now = Date.now();
    if (now - videoLastWheelAtRef.current < 520) return;
    videoLastWheelAtRef.current = now;
    animateSiblingVideo(event.deltaY > 0 ? "next" : "previous");
  }

  function handleVideoTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (videoCommentsOpen) return;
    if (videoSettleTimerRef.current !== null) {
      window.clearTimeout(videoSettleTimerRef.current);
      videoSettleTimerRef.current = null;
    }
    setVideoDragSettling(false);
    setVideoDragOffset(0);
    setVideoDragDirection(null);
    const touch = event.touches[0];
    videoSwipeStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function handleVideoTouchMove(event: TouchEvent<HTMLDivElement>) {
    if (videoCommentsOpen) return;
    const start = videoSwipeStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const absY = Math.abs(deltaY);
    if (absY < 2 || absY < Math.abs(deltaX) * 1.12) return;
    const direction = deltaY < 0 ? "next" : "previous";
    const nextVideo = getSiblingVideo(direction);
    if (!nextVideo) {
      setVideoDragOffset(0);
      setVideoDragDirection(null);
      return;
    }
    event.preventDefault();
    setVideoDragSettling(false);
    setVideoDragDirection(direction);
    setVideoDragOffset(deltaY);
  }

  function handleVideoTouchEnd(event: TouchEvent<HTMLDivElement>) {
    if (videoCommentsOpen) return;
    const start = videoSwipeStartRef.current;
    videoSwipeStartRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    const absY = Math.abs(deltaY);
    if (absY < 56 || absY < Math.abs(deltaX) * 1.15) {
      setVideoDragSettling(true);
      setVideoDragOffset(0);
      settleVideoDrag();
      return;
    }
    const direction = deltaY < 0 ? "next" : "previous";
    const nextVideo = getSiblingVideo(direction);
    if (!nextVideo) {
      setVideoDragSettling(true);
      setVideoDragOffset(0);
      settleVideoDrag();
      return;
    }
    setVideoDragSettling(true);
    setVideoDragDirection(direction);
    setVideoDragOffset(direction === "next" ? -window.innerHeight : window.innerHeight);
    settleVideoDrag(nextVideo.id);
  }

  function renderVideoMovingLayer(note: XiaohongshuNote, style: CSSProperties, preview = false) {
    const account = makeAccountFromNote(note);
    const following = isFollowingAccount(account);
    const showCaptionControls = !preview && note.id === selectedNote?.id;
    return (
      <div className={`cp-xhs-video-moving-layer${preview ? " cp-xhs-video-moving-layer--preview" : ""}`} style={style}>
        <main className="cp-xhs-video-stage">
          <div className={`cp-xhs-video-frame cp-xhs-cover--${note.tone}`}>
            {note.imageAssetId && imageMap[note.imageAssetId] ? (
              <img className="xhs-video-real-image" src={imageMap[note.imageAssetId]} alt="" />
            ) : note.videoDescription?.trim() || note.imageDescription?.trim() ? (
              <div className="cp-xhs-video-frame-text">
                <CheckPhoneBilingualText
                  text={note.videoDescription || note.imageDescription || ""}
                  tone="light"
                  collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                />
              </div>
            ) : null}
          </div>

          <section className="cp-xhs-video-meta">
            <div className="cp-xhs-video-author-row">
              <XhsAvatar className="cp-xhs-video-author-avatar" src={getNoteAvatar(note)} name={note.authorName} />
              <strong>{note.authorName}</strong>
              {account ? (
                <button
                  type="button"
                  className={following ? "is-following" : ""}
                  onClick={() => handleToggleFollowAuthor(note)}
                >
                  {following ? "已关注" : "关注"}
                </button>
              ) : null}
              <time>{formatTime(note.createdAt)}</time>
              <button
                type="button"
                className="xhs-delete-note-btn xhs-video-delete-note-btn"
                onClick={() => requestDeleteNote(note)}
                aria-label="删除帖子"
              >
                <Trash2 size={14} strokeWidth={2.1} />
                删除
              </button>
            </div>
            <h3>
              <CheckPhoneBilingualText
                text={note.title}
                tone="light"
                collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
              />
            </h3>
            <div className="cp-xhs-video-caption-wrap">
              {showCaptionControls ? (
                <div
                  ref={videoCaptionMeasureRef}
                  aria-hidden="true"
                  className="cp-xhs-video-caption-measure"
                />
              ) : null}
              <p className={!videoCaptionExpanded || preview ? "is-collapsed" : ""}>
                <CheckPhoneBilingualText
                  text={showCaptionControls && videoCaptionCanExpand && !videoCaptionExpanded
                    ? `${collapsedVideoCaption}...`
                    : note.body}
                  tone="light"
                  collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                />
                {showCaptionControls && videoCaptionCanExpand ? (
                  <>
                    {"  "}
                    <button
                      type="button"
                      className="cp-xhs-video-caption-toggle"
                      onClick={(event) => {
                        event.stopPropagation();
                        setVideoCaptionExpanded((current) => !current);
                      }}
                      onTouchStart={(event) => event.stopPropagation()}
                      onTouchEnd={(event) => event.stopPropagation()}
                    >
                      {videoCaptionExpanded ? "收起" : "展开"}
                    </button>
                  </>
                ) : null}
              </p>
            </div>
            {note.tags.length > 0 ? (
              <div className="cp-xhs-video-tags">
                {note.tags.map(tag => <em key={tag}>#{tag}</em>)}
              </div>
            ) : null}
            <div className="cp-xhs-video-progress" aria-hidden="true" />
          </section>
        </main>
      </div>
    );
  }

  function renderWaterfall(columns: [XiaohongshuNote[], XiaohongshuNote[]], options: { showGenerateButton?: boolean; hideCharacterTextImages?: boolean } = {}) {
    if (columns[0].length + columns[1].length === 0) {
      return (
        <div className="cp-xhs-status cp-empty-copy">
          <p>暂无小红书内容</p>
          <span>生成首页、附近、视频和角色互动</span>
          {options.showGenerateButton ? (
            <button
              type="button"
              className="xhs-empty-generate-btn"
              onClick={handleGenerateHomeContent}
              disabled={busy !== "idle"}
            >
              {busy === "npc-feed" || busy === "character-activity" ? "正在生成" : "生成小红书内容"}
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div className="cp-xhs-waterfall-grid">
        <div className="cp-xhs-waterfall-column">
          {columns[0].map(note => (
            <NoteCard
              key={note.id}
              note={note}
              imageMap={imageMap}
              avatarSrc={getNoteAvatar(note)}
              hideTextImageDescription={options.hideCharacterTextImages && note.source === "character" && note.type === "post"}
              collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
              onOpen={() => openNote(note.id)}
            />
          ))}
        </div>
        <div className="cp-xhs-waterfall-column">
          {columns[1].map(note => (
            <NoteCard
              key={note.id}
              note={note}
              imageMap={imageMap}
              avatarSrc={getNoteAvatar(note)}
              hideTextImageDescription={options.hideCharacterTextImages && note.source === "character" && note.type === "post"}
              collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
              onOpen={() => openNote(note.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="xhs-app cp-xhs-module">
      {selectedTab !== "profile" && !selectedNote && !selectedDmThread ? (
        <header className="cp-xhs-appbar xhs-appbar">
          <button
            type="button"
            className="cp-float-back"
            onClick={isMessageSubpage ? () => {
              setMessagePanel(null);
              setSelectedDmThreadId(null);
            } : requestClose}
            aria-label={isMessageSubpage ? "返回消息" : "返回桌面"}
          >
            <ChevronLeft size={24} strokeWidth={2} />
          </button>
          <div className="cp-xhs-header-stack">
            {isMessageSubpage ? (
              <div className="cp-xhs-header-title is-active">{selectedMessagePanelTitle}</div>
            ) : selectedTab === "home" ? (
              <>
                {HOME_FEED_TABS.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    className={`cp-xhs-header-title ${homeFeedTab === tab.id ? "is-active" : ""}`}
                    onClick={() => setHomeFeedTab(tab.id)}
                    aria-current={homeFeedTab === tab.id ? "page" : undefined}
                  >
                    {tab.label}
                  </button>
                ))}
              </>
            ) : (
              <div className="cp-xhs-header-title is-active">
                {selectedTab === "video" ? "附近" : selectedTab === "messages" ? "消息" : "发布"}
              </div>
            )}
          </div>
          {!isMessageSubpage ? <div className="cp-appbar-actions">
            <button
              type="button"
              className="cp-float-refresh xhs-icon-action xhs-icon-action--refresh"
              onClick={() => requestFeedAction("refresh")}
              disabled={busy !== "idle"}
              aria-label="刷新小红书内容"
            >
              <RotateCw size={18} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className="cp-float-refresh xhs-icon-action xhs-icon-action--clear"
              onClick={() => requestFeedAction("clear")}
              disabled={busy !== "idle" || state.notes.length === 0}
              aria-label="清空小红书内容"
            >
              <Trash2 size={17} strokeWidth={1.8} />
            </button>
          </div> : <div className="cp-appbar-actions" />}
        </header>
      ) : null}

      {busy !== "idle" ? (
        <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
          <span className="cp-refresh-indicator-text">
            {busy === "npc-feed" ? "正在生成帖子内容" : busy === "character-activity" ? "正在生成角色互动内容" : busy === "publish" ? "正在发布笔记" : busy === "comment-reply" || busy === "mention-reply" ? "正在生成回复内容" : busy === "dm-reply" ? "正在生成私信回复" : "正在生成互动内容"}
          </span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
        </div>
      ) : null}

      {error ? (
        <CheckPhoneDebugErrorCard
          title={debugErrorTitle}
          error={error}
          debugParseError={debugParseError}
          debugRawOutput={debugRawOutput}
        />
      ) : null}

      <main className="cp-xhs-body">
        {selectedDmThread ? (
          <div className="cp-xhs-thread-screen xhs-dm-thread-screen">
            <header className="cp-xhs-thread-appbar">
              <button type="button" className="cp-xhs-thread-nav-button" onClick={() => setSelectedDmThreadId(null)} aria-label="返回消息">
                <ChevronLeft size={26} strokeWidth={2.4} />
              </button>
              <div className="cp-xhs-thread-title-block">
                <XhsAvatar
                  className="cp-xhs-thread-avatar cp-xhs-thread-avatar--header"
                  src={getNotificationAvatar(selectedDmThread.actorName, selectedDmThread.id)}
                  name={selectedDmThread.actorName}
                />
                <strong>{selectedDmThread.actorName}</strong>
              </div>
              <button type="button" className="cp-xhs-thread-nav-button" aria-label="更多">
                <MoreHorizontal size={27} strokeWidth={2.4} />
              </button>
            </header>

            <div className="cp-xhs-thread-messages">
              <div className="cp-xhs-chat-stack">
                {selectedDmThread.notifications.map((notice, index) => {
                  const previous = selectedDmThread.notifications[index - 1];
                  const showTime = !previous || formatTime(previous.createdAt) !== formatTime(notice.createdAt);
                  const outgoing = notice.direction === "outgoing";
                  return (
                    <div key={notice.id} className="cp-xhs-chat-message-block">
                      {showTime ? <time className="cp-xhs-chat-time">{formatTime(notice.createdAt)}</time> : null}
                      <div className={`cp-xhs-chat-row ${outgoing ? "is-outgoing" : "is-incoming"}`}>
                        {!outgoing ? (
                          <XhsAvatar
                            className="cp-xhs-chat-avatar"
                            src={getNotificationAvatar(notice.actorName, notice.id)}
                            name={notice.actorName}
                          />
                        ) : null}
                        <div className="cp-xhs-chat-content">
                          <p>
                            <CheckPhoneBilingualText
                              text={notice.text}
                              tone="xiaohongshu"
                              variant="inline"
                              collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                            />
                          </p>
                        </div>
                        {outgoing ? (
                          <XhsAvatar
                            className="cp-xhs-chat-avatar cp-xhs-chat-avatar--me"
                            src={userAvatar}
                            name={state.profile.nickname}
                          />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="cp-xhs-thread-composer">
              {dmEmojiOpen ? (
                <div className="xhs-dm-emoji-panel">
                  {XHS_DM_EMOJIS.map(emoji => (
                    <button key={emoji} type="button" onClick={() => setDmDraft(prev => `${prev}${emoji}`)}>{emoji}</button>
                  ))}
                </div>
              ) : null}
              <div className="cp-xhs-thread-inputbar">
                <button type="button" aria-label="表情" className={dmEmojiOpen ? "is-active" : ""} onClick={() => setDmEmojiOpen(prev => !prev)}>
                  <Smile size={24} strokeWidth={1.8} />
                </button>
                <input
                  className="cp-xhs-thread-input-field"
                  value={dmDraft}
                  onChange={event => setDmDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSendDmMessage(selectedDmThread);
                    }
                  }}
                  placeholder="发消息..."
                />
                <button type="button" className="xhs-dm-generate-btn" aria-label="生成回复" disabled={busy !== "idle"} onClick={() => handleGenerateDmReply(selectedDmThread)}>
                  {busy === "dm-reply" ? <Loader2 className="cp-spin" size={21} /> : <Sparkles size={22} strokeWidth={1.8} />}
                </button>
                <button type="button" aria-label="发送" disabled={busy !== "idle" || !dmDraft.trim()} onClick={() => handleSendDmMessage(selectedDmThread)}>
                  <Send size={22} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          </div>
        ) : selectedNote ? selectedNote.type === "video" ? (
          <div
            className={`cp-xhs-video-detail-screen xhs-video-detail-screen${videoCommentsOpen ? " is-comments-open" : ""}`}
            onWheel={handleVideoWheel}
            onTouchStart={handleVideoTouchStart}
            onTouchMove={handleVideoTouchMove}
            onTouchEnd={handleVideoTouchEnd}
            onTouchCancel={handleVideoTouchEnd}
          >
            <header className="cp-xhs-video-detail-topbar">
              <button type="button" onClick={() => setSelectedNoteId(null)} aria-label="返回">
                <ChevronLeft size={26} strokeWidth={2} />
              </button>
              <button type="button" aria-label="更多视频">
                <span className="cp-xhs-video-stack-icon" aria-hidden="true" />
              </button>
              <div className="cp-xhs-video-topbar-spacer" />
              <button type="button" aria-label="搜索">
                <Search size={22} strokeWidth={2.2} />
              </button>
              <button type="button" aria-label="分享" onClick={() => handleShareNote(selectedNote)}>
                <ShareFat size={23} weight="regular" />
              </button>
            </header>

            {videoPreviewNote && videoPreviewStyle ? renderVideoMovingLayer(videoPreviewNote, videoPreviewStyle, true) : null}
            {renderVideoMovingLayer(selectedNote, videoMovableStyle)}

            <footer className="cp-xhs-video-actions xhs-video-actions">
              <button type="button" className="cp-xhs-video-input xhs-video-input-button" onClick={() => setVideoCommentsOpen(true)}>
                说点什么...
              </button>
              <button type="button" className={`cp-xhs-video-action ${selectedNote.liked ? "is-active" : ""}`} onClick={() => handleToggleLike(selectedNote)} aria-label="点赞">
                <Heart size={24} strokeWidth={2.1} fill={selectedNote.liked ? "currentColor" : "none"} />
                <span>{formatCount(selectedNote.likeCount)}</span>
              </button>
              <button type="button" className={`cp-xhs-video-action ${selectedNote.saved ? "is-active" : ""}`} onClick={() => handleToggleSave(selectedNote)} aria-label="收藏">
                <Bookmark size={24} strokeWidth={2.1} fill={selectedNote.saved ? "currentColor" : "none"} />
                <span>{formatCount(selectedNote.saveCount)}</span>
              </button>
              <button type="button" className="cp-xhs-video-action" onClick={() => setVideoCommentsOpen(true)} aria-label="评论">
                <MessageCircle size={24} strokeWidth={2.1} />
                <span>{formatCount(selectedNote.commentCount)}</span>
              </button>
            </footer>

            {videoCommentsOpen ? (
              <div className="cp-xhs-video-comments-backdrop" onClick={() => setVideoCommentsOpen(false)}>
                <section className="cp-xhs-video-comments-sheet xhs-video-comments-sheet" onClick={event => event.stopPropagation()}>
                  <div className="cp-xhs-video-comments-handle" aria-hidden="true" />
                  <header>
                    <strong>评论 {formatCount(selectedNote.commentCount)}</strong>
                    <button type="button" onClick={() => setVideoCommentsOpen(false)} aria-label="关闭评论">×</button>
                  </header>
                  <div className="cp-xhs-comment-list xhs-video-comment-list">
                    <CommentList
                      comments={selectedNote.comments}
                      getAvatar={getCommentAvatar}
                      onReply={comment => setReplyTarget(comment)}
                      onDeleteComment={requestDeleteComment}
                      onVoteComment={handleVoteComment}
                      collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                    />
                    <button
                      type="button"
                      className="xhs-load-comments-btn"
                      onClick={() => void handleLoadMoreComments(selectedNote)}
                      disabled={busy !== "idle"}
                    >
                      {busy === "more-comments" ? <Loader2 className="cp-spin" size={15} /> : null}
                      {busy === "more-comments" ? "加载中" : "加载更多评论"}
                    </button>
                  </div>
                  <div className={`xhs-video-comment-composer ${commentComposerExpanded ? "is-expanded" : ""}`}>
                    {replyTarget && replyTarget.noteId === selectedNote.id ? (
                      <div className="xhs-reply-target">
                        <span>回复 {replyTarget.authorName}</span>
                        <button type="button" onClick={() => setReplyTarget(null)}>取消</button>
                      </div>
                    ) : null}
                    <div className="xhs-comment-input-row">
                      <textarea
                        value={commentDraft}
                        onChange={event => setCommentDraft(event.target.value)}
                        onFocus={() => setCommentComposerFocused(true)}
                        onBlur={() => window.setTimeout(() => setCommentComposerFocused(false), 120)}
                        placeholder={replyTarget ? "写回复" : "写评论"}
                        rows={commentComposerExpanded ? 3 : 1}
                      />
                      {!commentComposerExpanded ? (
                        <button type="button" onClick={handleSubmitUserComment} disabled={busy !== "idle" || !commentDraft.trim()}>
                          {busy === "comment-reply" || busy === "mention-reply" ? <Loader2 className="cp-spin" size={15} /> : null}
                          发送
                        </button>
                      ) : null}
                    </div>
                    {commentComposerExpanded ? commentToolbar : null}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        ) : (
          <div ref={detailScrollRef} className="cp-xhs-scroll cp-xhs-scroll--detail xhs-detail-page">
            <div className="cp-xhs-note-detail-header">
              <button type="button" className="cp-xhs-detail-back" onClick={() => setSelectedNoteId(null)} aria-label="返回">
                <ChevronLeft size={24} strokeWidth={2.1} />
              </button>
              <div className="cp-xhs-detail-author-info">
                <XhsAvatar className="cp-xhs-detail-avatar" src={getNoteAvatar(selectedNote)} name={selectedNote.authorName} />
                <span className="cp-xhs-detail-name">{selectedNote.authorName}</span>
              </div>
              {selectedAuthorAccount ? (
                <button
                  type="button"
                  className={`cp-xhs-detail-follow ${selectedAuthorFollowing ? "is-following" : ""}`}
                  onClick={() => handleToggleFollowAuthor(selectedNote)}
                >
                  {selectedAuthorFollowing ? "已关注" : "关注"}
                </button>
              ) : null}
              <button type="button" className="cp-xhs-detail-share" aria-label="分享" onClick={() => handleShareNote(selectedNote)}>
                <ShareFat size={25} weight="regular" />
              </button>
            </div>
            <article className="cp-xhs-note-detail xhs-note-detail-page">
              <div className="xhs-note-detail-media">
                <NoteImage
                  note={selectedNote}
                  imageMap={imageMap}
                  collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                  isDetail={true}
                />
              </div>
              <div className="cp-xhs-note-detail-card">
                <h3>
                  <CheckPhoneBilingualText
                    text={selectedNote.title}
                    tone="xiaohongshu"
                    collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                  />
                </h3>
                <p className="cp-xhs-note-detail-body">
                  <CheckPhoneBilingualText
                    text={selectedNote.body}
                    tone="xiaohongshu"
                    collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                  />
                </p>
                {selectedNote.tags.length ? (
                  <div className="cp-xhs-note-detail-tags">
                    {selectedNote.tags.map(tag => <em key={tag}>#{tag}</em>)}
                  </div>
                ) : null}
                <div className="xhs-note-detail-meta-row">
                  <div className="cp-xhs-note-detail-time">{formatTime(selectedNote.createdAt)}</div>
                  <button
                    type="button"
                    className="xhs-delete-note-btn"
                    onClick={() => requestDeleteNote(selectedNote)}
                    aria-label="删除帖子"
                  >
                    <Trash2 size={14} strokeWidth={2.1} />
                    删除
                  </button>
                </div>
              </div>
              <div className="cp-xhs-comment-section xhs-detail-comment-section">
                <div className="cp-xhs-comment-count">共 {formatCount(selectedNote.commentCount)} 条评论</div>
                <div className="cp-xhs-comment-list">
                  <CommentList
                    comments={selectedNote.comments}
                    getAvatar={getCommentAvatar}
                    onReply={comment => setReplyTarget(comment)}
                    onDeleteComment={requestDeleteComment}
                    onVoteComment={handleVoteComment}
                    collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                  />
                  <button
                    type="button"
                    className="xhs-load-comments-btn"
                    onClick={() => void handleLoadMoreComments(selectedNote)}
                    disabled={busy !== "idle"}
                  >
                    {busy === "more-comments" ? <Loader2 className="cp-spin" size={15} /> : null}
                    {busy === "more-comments" ? "加载中" : "加载更多评论"}
                  </button>
                </div>
              </div>
            </article>
            <div className={`cp-xhs-detail-bottom-bar xhs-detail-bottom-bar ${commentComposerExpanded ? "is-expanded" : ""}`}>
              <div className="xhs-detail-comment-stack">
                {replyTarget && replyTarget.noteId === selectedNote.id ? (
                  <div className="xhs-reply-target xhs-detail-reply-target">
                    <span>回复 {replyTarget.authorName}</span>
                    <button type="button" onClick={() => setReplyTarget(null)}>取消</button>
                  </div>
                ) : null}
                <div className="cp-xhs-input-box xhs-detail-input-box">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>
                  <textarea
                    value={commentDraft}
                    onChange={event => setCommentDraft(event.target.value)}
                    onFocus={() => setCommentComposerFocused(true)}
                    onBlur={() => window.setTimeout(() => setCommentComposerFocused(false), 120)}
                    placeholder={replyTarget ? "写回复" : "说点什么..."}
                    rows={commentComposerExpanded ? 3 : 1}
                  />
                </div>
                {commentComposerExpanded ? commentToolbar : null}
              </div>
              {!commentComposerExpanded && commentDraft.trim() ? (
                <button type="button" className="xhs-detail-send-btn" onClick={handleSubmitUserComment} disabled={busy !== "idle"}>
                  {busy === "comment-reply" || busy === "mention-reply" ? <Loader2 className="cp-spin" size={15} /> : "发送"}
                </button>
              ) : null}
              {!commentComposerExpanded ? <div className="cp-xhs-action-icons">
                <button type="button" className={`cp-xhs-action-btn ${selectedNote.liked ? "is-liked" : ""}`} onClick={() => handleToggleLike(selectedNote)} aria-label="点赞">
                  <Heart size={24} strokeWidth={1.72} fill={selectedNote.liked ? "currentColor" : "none"} />
                  <span>{formatCount(selectedNote.likeCount)}</span>
                </button>
                <button type="button" className={`cp-xhs-action-btn ${selectedNote.saved ? "is-saved" : ""}`} onClick={() => handleToggleSave(selectedNote)} aria-label="收藏">
                  <Bookmark size={24} strokeWidth={1.72} fill={selectedNote.saved ? "currentColor" : "none"} />
                  <span>{formatCount(selectedNote.saveCount)}</span>
                </button>
                <button type="button" className="cp-xhs-action-btn" aria-label="评论">
                  <MessageCircle size={24} strokeWidth={1.72} />
                  <span>{formatCount(selectedNote.commentCount)}</span>
                </button>
              </div> : null}
            </div>
          </div>
        ) : (
        <div ref={mainScrollRef} className={`cp-xhs-scroll ${selectedTab === "profile" ? "cp-xhs-scroll--profile" : ""}`} onScroll={handleMainScroll}>
          {selectedTab === "home" ? (
            <section className="cp-xhs-home">{renderWaterfall(homeColumns, { showGenerateButton: true, hideCharacterTextImages: true })}</section>
          ) : null}

          {selectedTab === "video" ? (
            <section className="cp-xhs-home">{renderWaterfall(nearbyColumns, { showGenerateButton: true })}</section>
          ) : null}

          {selectedTab === "messages" ? (
            messagePanel ? (
            <section className="cp-xhs-panel cp-xhs-message-page xhs-message-detail-page">
              <div className="xhs-message-detail-list">
                {selectedMessageNotifications.length === 0 ? (
                  <div className="cp-xhs-mini-empty">暂无{selectedMessagePanelLabel}通知</div>
                ) : selectedMessageNotifications.map((notice, index) => (
                  <button
                    key={notice.id}
                    type="button"
                    className="xhs-message-detail-card"
                    onClick={() => notice.noteId && openNote(notice.noteId)}
                  >
                    <XhsAvatar
                      className={`xhs-message-detail-avatar cp-xhs-thread-avatar--tone-${(index % 6) + 1}`}
                      src={getNotificationAvatar(notice.actorName, notice.id)}
                      name={notice.actorName}
                    />
                    <div className="xhs-message-detail-copy">
                      <div>
                        <strong>{notificationActorLabel(notice)}</strong>
                        {notice.type === "follow" ? <em>你的粉丝</em> : null}
                      </div>
                      <span>{formatNotificationAction(notice)} <time>{formatTime(notice.createdAt)}</time></span>
                      {notice.type === "comment" ? (
                        <p>
                          <CheckPhoneBilingualText
                            text={formatNotificationPreview(notice)}
                            tone="xiaohongshu"
                            variant="inline"
                            collapseBilingualTranslation={state.settings.collapseBilingualTranslation}
                          />
                        </p>
                      ) : null}
                    </div>
                    <div className="xhs-message-detail-thumb">
                      {renderNotificationThumbnail(notice)}
                    </div>
                  </button>
                ))}
              </div>
            </section>
            ) : (
            <section className="cp-xhs-panel cp-xhs-message-page xhs-message-page">
              <div className="cp-xhs-message-overview">
                {([
                  { id: "engagement", label: "点赞和收藏", count: engagementUnreadCount, icon: "heart", tone: "heart" },
                  { id: "follow", label: "新增关注", count: followUnreadCount, icon: "user", tone: "follow" },
                  { id: "comment", label: "评论", count: commentUnreadCount, icon: "chat", tone: "chat" },
                ] as const).map(panel => (
                  <button
                    key={panel.id}
                    type="button"
                    className="cp-xhs-overview-card"
                    onClick={() => handleOpenMessagePanel(panel.id)}
                  >
                    <div className="cp-xhs-overview-icon-wrapper">
                      <div className={`cp-xhs-overview-icon cp-xhs-overview-icon--${panel.tone}`}>
                        <XiaohongshuOverviewGlyph type={panel.icon} />
                      </div>
                      {panel.count > 0 ? <span className="cp-xhs-overview-badge">{formatBadgeCount(panel.count)}</span> : null}
                    </div>
                    <span>{panel.label}</span>
                  </button>
                ))}
              </div>
              <div className="xhs-message-section-title">
                <strong>私信</strong>
                {dmThreads.length > 0 ? <span>{dmThreads.length} 个对话</span> : null}
              </div>
              <div className="cp-xhs-thread-list">
                {dmThreads.length === 0 ? <div className="cp-xhs-mini-empty">暂无私信</div> : null}
                {dmThreads.map((thread, index) => (
                  <button key={thread.id} type="button" className="cp-xhs-thread-card" onClick={() => handleOpenDmThread(thread)}>
                    <XhsAvatar
                      className={`cp-xhs-thread-avatar cp-xhs-thread-avatar--tone-${(index % 6) + 1}`}
                      src={getNotificationAvatar(thread.actorName, thread.id)}
                      name={thread.actorName}
                    />
                    <div className="cp-xhs-thread-meta">
                      <div className="cp-xhs-thread-text">
                        <span className="cp-xhs-thread-name">{thread.actorName}</span>
                        <span className="cp-xhs-thread-preview">{getXhsPlainText(thread.latest.text)}</span>
                      </div>
                      <div className="cp-xhs-thread-status">
                        <time className="cp-xhs-thread-time">{formatTime(thread.latest.createdAt)}</time>
                        {thread.unreadCount > 0 ? <span className="cp-xhs-thread-unread-badge">{formatBadgeCount(thread.unreadCount)}</span> : <span className="cp-xhs-thread-spacer" />}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
            )
          ) : null}

          {selectedTab === "profile" ? (
            <section className="cp-xhs-profile xhs-profile">
              <div className={`cp-xhs-profile-topbar ${profileTopbarVisible ? "is-visible" : ""}`}>
                <button type="button" onClick={requestClose} aria-label="返回桌面">
                  <ChevronLeft size={24} strokeWidth={2.4} />
                </button>
                <div>
                  <button type="button" onClick={() => setSettingsOpen(true)} aria-label="设置">
                    <MoreHorizontal size={22} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
              <div className="cp-xhs-profile-hero">
                <button
                  type="button"
                  className="cp-xhs-profile-cover"
                  style={profileCoverStyle}
                  aria-label="更换主页背景图"
                  onClick={() => profileCoverFileRef.current?.click()}
                />
                <input
                  ref={profileCoverFileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={handleProfileCoverChange}
                />
                <div className="cp-xhs-profile-main">
                  <div className="cp-xhs-profile-avatar-wrap">
                    <XhsAvatar className="cp-xhs-profile-avatar" src={userAvatar} name={state.profile.nickname} />
                  </div>
                  <div className="cp-xhs-profile-meta">
                    <h3>{state.profile.nickname}<ChevronDown size={16} strokeWidth={2.3} /></h3>
                    <span>小红书号：{state.profile.handle}</span>
                    <span>IP 属地：{state.profile.ipLocation}</span>
                  </div>
                </div>
                <div className="cp-xhs-profile-bio">
                  <p>{state.profile.signature}</p>
                  <em className={getGenderClassName(state.profile.gender)}>{state.profile.gender || "♀"}</em>
                </div>
                <div className="cp-xhs-profile-actions">
                  <div className="cp-xhs-profile-stats">
                    <div><strong>{formatCount(profileStats.followingCount)}</strong><span>关注</span></div>
                    <div><strong>{formatCount(profileStats.followerCount)}</strong><span>粉丝</span></div>
                    <div><strong>{formatCount(profileStats.likedAndSavedCount)}</strong><span>获赞与收藏</span></div>
                  </div>
                  <button type="button" className="cp-xhs-profile-edit" onClick={() => { setProfileDraft(state.profile); setProfileOpen(true); }}>编辑资料</button>
                  <button type="button" className="cp-xhs-profile-settings" aria-label="Profile settings" onClick={() => setSettingsOpen(true)}>
                    <MoreHorizontal size={22} strokeWidth={1.5} />
                  </button>
                </div>
                <div className="cp-xhs-profile-tools">
                  <div><strong>创作灵感</strong><span>学创作找灵感</span></div>
                  <div><strong>RED 创作大赛</strong><span>为新生代好作品助力</span></div>
                  <div><strong>浏览记录</strong><span>看过的笔记</span></div>
                </div>
              </div>
              <div className="cp-xhs-profile-content">
                <div className="cp-xhs-profile-tabs">
                  {PROFILE_TABS.map(tab => (
                    <button
                      key={tab.id}
                      type="button"
                      className={profileTab === tab.id ? "is-active" : ""}
                      onClick={() => setProfileTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                  <Search size={20} strokeWidth={1.55} />
                </div>
                {renderWaterfall(profileColumns)}
              </div>
            </section>
          ) : null}
        </div>
        )}
      </main>

      {!selectedNote && !isMessageSubpage ? <nav className="cp-xhs-tabbar xhs-tabbar" aria-label="小红书导航">
        {TABS.map((tab) => {
          if (tab.id === "publish") {
            return (
              <button key={tab.id} type="button" className="cp-xhs-tab-publish" onClick={() => setComposeOpen(true)} aria-label="发布">
                <div className="cp-xhs-tab-publish-inner"><Plus size={20} strokeWidth={3} /></div>
              </button>
            );
          }
          const active = selectedTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className={`cp-xhs-tab ${active ? "is-active" : ""}`}
              onClick={() => setSelectedTab(tab.id)}
            >
              <div className="cp-xhs-tab-inner">
                <span>{tab.label}</span>
                {tab.id === "messages" && unreadCount > 0 ? (
                  <span className="cp-xhs-tab-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
                ) : null}
              </div>
            </button>
          );
        })}
      </nav> : null}

      {composeOpen ? (
        <div className="xhs-modal-backdrop" onClick={() => setComposeOpen(false)}>
          <section className="xhs-publish-sheet" onClick={event => event.stopPropagation()}>
            <header>
              <strong>发布新笔记</strong>
              <button type="button" className="xhs-sheet-close-btn" onClick={() => setComposeOpen(false)} aria-label="关闭">×</button>
            </header>
            <div className="xhs-publish-content">
              <div className="xhs-publish-left">
                {((draft.images && draft.images.length > 0) || draft.image?.dataUrl) ? (
                  <div className="xhs-publish-multi-images">
                    <div className="xhs-publish-images-grid">
                      {(draft.images || [draft.image!]).map((img, idx) => (
                        <div key={img.assetId || idx} className="xhs-publish-grid-item">
                          <img src={img.dataUrl} alt={`Preview ${idx + 1}`} />
                          <button
                            type="button"
                            className="xhs-publish-img-remove"
                            onClick={() => {
                              setDraft((prev) => {
                                const list = (prev.images || [prev.image!]).filter((_, i) => i !== idx);
                                return {
                                  ...prev,
                                  image: list[0] || {},
                                  images: list.length > 0 ? list : undefined,
                                };
                              });
                            }}
                            aria-label="删除图片"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="xhs-publish-grid-add"
                        onClick={() => fileRef.current?.click()}
                        aria-label="继续添加图片"
                      >
                        <Plus size={24} />
                        <span>添加</span>
                      </button>
                    </div>
                    <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={handleImageChange} />
                    <button
                      type="button"
                      className="xhs-upload-change-btn"
                      onClick={() => setDraft(prev => ({ ...prev, image: {}, images: undefined }))}
                    >
                      清空所有图片
                    </button>
                  </div>
                ) : draft.image?.description === undefined ? (
                  <div className="xhs-image-upload-area">
                    <div className="xhs-publish-placeholder">
                      <ImagePlus size={42} strokeWidth={1.5} color="#bbb" />
                      <div className="xhs-placeholder-actions">
                        <button type="button" onClick={() => fileRef.current?.click()}>上传图片 (支持多张)</button>
                        <button type="button" onClick={() => setDraft(prev => ({ ...prev, image: { ...prev.image, description: "" } }))}>描述图片</button>
                      </div>
                    </div>
                    <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={handleImageChange} />
                  </div>
                ) : (
                  <>
                    <div className="xhs-image-upload-area is-text-mode">
                      <div className="xhs-text-image-preview">
                        {draft.image.description?.trim() || "在此区域下方输入描述\n即可生成文字图片"}
                      </div>
                    </div>
                    <div className="xhs-publish-field">
                      <label>文字图片内容</label>
                      <textarea
                        placeholder="输入文字描述..."
                        value={draft.image.description || ""}
                        onChange={event => setDraft(prev => ({ ...prev, image: { ...prev.image, description: event.target.value } }))}
                        autoFocus
                      />
                    </div>
                    <button type="button" className="xhs-upload-change-btn" onClick={() => setDraft(prev => ({ ...prev, image: {} }))}>
                      取消并重新选择
                    </button>
                  </>
                )}
              </div>
              <div className="xhs-publish-right">
                <input
                  className="xhs-publish-title-input"
                  placeholder="填写标题会有更多赞哦~"
                  value={draft.title}
                  onChange={event => setDraft(prev => ({ ...prev, title: event.target.value }))}
                />
                <textarea
                  className="xhs-publish-body-input"
                  placeholder="添加正文，和大家分享你的见闻..."
                  value={draft.body}
                  onChange={event => setDraft(prev => ({ ...prev, body: event.target.value }))}
                />
                <div className="xhs-publish-tag-input">
                  <span>#</span>
                  <input
                    value={tagInput}
                    onChange={event => setTagInput(event.target.value)}
                    placeholder="添加标签，用空格或逗号分隔"
                  />
                </div>
                <div className="xhs-publish-actions">
                  <button type="button" className="xhs-publish-submit-btn" onClick={handlePublish} disabled={busy !== "idle" || (!draft.title.trim() && !draft.body.trim())}>
                    {busy === "publish" ? <Loader2 className="cp-spin" size={18} /> : <Send size={18} />}
                    发布笔记
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="xhs-modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section
            className="xhs-profile-edit-sheet xhs-settings-edit-sheet"
            onClick={event => event.stopPropagation()}
          >
            <header className="xhs-profile-edit-header">
              <strong>小红书设置</strong>
              <button type="button" className="xhs-sheet-close-btn" onClick={() => setSettingsOpen(false)} aria-label="关闭">×</button>
            </header>

            <div className="xhs-profile-edit-body">
              <div className="xhs-profile-edit-field">
                <span className="xhs-profile-edit-section-title">INTERACTION <em>角色互动概率</em></span>
                <input
                  className="xhs-profile-edit-pill"
                  type="number"
                  min={0}
                  max={100}
                  value={settingsDraft.sendToCharacterProbability}
                  placeholder="发给角色的概率 (0–100)"
                  onChange={event => setSettingsDraft(prev => ({ ...prev, sendToCharacterProbability: Number(event.target.value) }))}
                />
              </div>

              <div className="xhs-profile-edit-field">
                <span className="xhs-profile-edit-section-title">TRANSLATION <em>双语翻译</em></span>
                <div className="xhs-settings-toggle-list">
                  <div className="xhs-settings-toggle-row">
                    <div>
                      <strong>双语翻译</strong>
                      <span>角色内容</span>
                    </div>
                    <Toggle
                      checked={settingsDraft.bilingualTranslationEnabled}
                      onChange={checked => setSettingsDraft(prev => ({ ...prev, bilingualTranslationEnabled: checked }))}
                    />
                  </div>
                  <div className="xhs-settings-toggle-row">
                    <div>
                      <strong>折叠翻译</strong>
                      <span>默认收起</span>
                    </div>
                    <Toggle
                      checked={settingsDraft.collapseBilingualTranslation}
                      onChange={checked => setSettingsDraft(prev => ({ ...prev, collapseBilingualTranslation: checked }))}
                    />
                  </div>
                </div>
              </div>

              <div className="xhs-profile-edit-field">
                <span className="xhs-profile-edit-section-title">PARTICIPANTS <em>参与角色</em></span>
                <div className="xhs-settings-edit-participants">
                  {characters.length === 0 ? (
                    <span className="xhs-settings-edit-participants-empty">暂无角色</span>
                  ) : (
                    characters.map((character) => {
                      const selected = settingsDraft.participantCharacterIds.includes(character.id);
                      return (
                        <button
                          key={character.id}
                          type="button"
                          className={selected ? "is-selected" : ""}
                          onClick={() => setSettingsDraft(prev => ({
                            ...prev,
                            participantCharacterIds: selected
                              ? prev.participantCharacterIds.filter(id => id !== character.id)
                              : [...prev.participantCharacterIds, character.id],
                          }))}
                        >
                          <span>{character.avatar ? <img src={character.avatar} alt="" /> : character.name.slice(0, 1)}</span>
                          <em>{character.name}</em>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="xhs-profile-edit-field">
                <span className="xhs-profile-edit-section-title">PROMPTS <em>提示词</em></span>
                {[
                  { key: "npcIdentityGuardPrompt", label: "NPC身份保护", value: settingsDraft.npcIdentityGuardPrompt ?? DEFAULT_XIAOHONGSHU_SETTINGS.npcIdentityGuardPrompt, onChange: (v: string) => setSettingsDraft(prev => ({ ...prev, npcIdentityGuardPrompt: v })) },
                  { key: "npcFeedPrompt", label: "帖子生成", value: settingsDraft.npcFeedPrompt, onChange: (v: string) => setSettingsDraft(prev => ({ ...prev, npcFeedPrompt: v })) },
                  { key: "npcUserPostReactionPrompt", label: "评论用户帖子", value: settingsDraft.npcUserPostReactionPrompt, onChange: (v: string) => setSettingsDraft(prev => ({ ...prev, npcUserPostReactionPrompt: v })) },
                  { key: "npcCommentReplyPrompt", label: "回复用户评论", value: settingsDraft.npcCommentReplyPrompt, onChange: (v: string) => setSettingsDraft(prev => ({ ...prev, npcCommentReplyPrompt: v })) },
                  { key: "npcMoreCommentsPrompt", label: "加载更多评论", value: settingsDraft.npcMoreCommentsPrompt ?? "", onChange: (v: string) => setSettingsDraft(prev => ({ ...prev, npcMoreCommentsPrompt: v })) },
                  { key: "npcDmReplyPrompt", label: "回复私信", value: settingsDraft.npcDmReplyPrompt ?? "", onChange: (v: string) => setSettingsDraft(prev => ({ ...prev, npcDmReplyPrompt: v })) },
                  { key: "bilingualTranslationPrompt", label: "双语翻译", value: settingsDraft.bilingualTranslationPrompt || DEFAULT_XIAOHONGSHU_BILINGUAL_PROMPT, onChange: (v: string) => setSettingsDraft(prev => ({ ...prev, bilingualTranslationPrompt: v })) },
                ].map(({ key, label, value, onChange }) => {
                  const isOpen = expandedPrompts.has(key);
                  return (
                    <div
                      key={key}
                      className={`xhs-settings-edit-prompt${isOpen ? " is-open" : ""}`}
                    >
                      <button
                        type="button"
                        className="xhs-settings-edit-prompt-head"
                        onClick={() => setExpandedPrompts(prev => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                      >
                        <span>{label}</span>
                        <ChevronDown size={15} strokeWidth={2} />
                      </button>
                      {isOpen ? (
                        <textarea
                          className="xhs-profile-edit-pill xhs-settings-edit-prompt-textarea"
                          value={value}
                          onChange={event => onChange(event.target.value)}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>

            <footer className="xhs-profile-edit-footer">
              <button
                type="button"
                className="xhs-profile-edit-footer-cancel"
                onClick={handleResetSettingsDraft}
              >
                恢复默认
              </button>
              <button
                type="button"
                className="xhs-profile-edit-footer-save"
                onClick={handleSaveSettings}
              >
                保存设置
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {profileOpen ? (
        <div className="xhs-modal-backdrop" onClick={() => setProfileOpen(false)}>
          <section className="xhs-profile-edit-sheet" onClick={event => event.stopPropagation()}>
            <header className="xhs-profile-edit-header">
              <strong>编辑资料</strong>
              <button type="button" className="xhs-sheet-close-btn" onClick={() => setProfileOpen(false)} aria-label="关闭">×</button>
            </header>

            <div className="xhs-profile-edit-body">
              <div className="xhs-profile-edit-row-2">
                <div className="xhs-profile-edit-field">
                  <span className="xhs-profile-edit-section-title">NICKNAME <em>昵称</em></span>
                  <input
                    className="xhs-profile-edit-pill"
                    value={profileDraft.nickname}
                    placeholder="给自己起个名字"
                    onChange={event => setProfileDraft(prev => ({ ...prev, nickname: event.target.value }))}
                  />
                </div>
                <div className="xhs-profile-edit-field">
                  <span className="xhs-profile-edit-section-title">ID <em>小红书号</em></span>
                  <input
                    className="xhs-profile-edit-pill"
                    value={profileDraft.handle}
                    placeholder="未设置"
                    onChange={event => setProfileDraft(prev => ({ ...prev, handle: event.target.value }))}
                  />
                </div>
              </div>

              <div className="xhs-profile-edit-row-2">
                <div className="xhs-profile-edit-field">
                  <span className="xhs-profile-edit-section-title">GENDER <em>性别</em></span>
                  <div className="xhs-profile-edit-gender">
                    <button
                      type="button"
                      className={/女|♀|female/i.test(profileDraft.gender ?? "") ? "is-active" : ""}
                      onClick={() => setProfileDraft(prev => ({ ...prev, gender: "♀" }))}
                      aria-label="女"
                    >
                      ♀
                    </button>
                    <button
                      type="button"
                      className={/男|♂|male/i.test(profileDraft.gender ?? "") ? "is-active" : ""}
                      onClick={() => setProfileDraft(prev => ({ ...prev, gender: "♂" }))}
                      aria-label="男"
                    >
                      ♂
                    </button>
                  </div>
                </div>
                <div className="xhs-profile-edit-field">
                  <span className="xhs-profile-edit-section-title">IP LOCATION <em>属地</em></span>
                  <input
                    className="xhs-profile-edit-pill"
                    value={profileDraft.ipLocation}
                    placeholder="北京"
                    onChange={event => setProfileDraft(prev => ({ ...prev, ipLocation: event.target.value }))}
                  />
                </div>
              </div>

              <div className="xhs-profile-edit-field">
                <span className="xhs-profile-edit-section-title">SIGNATURE <em>签名</em></span>
                <textarea
                  className="xhs-profile-edit-pill xhs-profile-edit-bio"
                  value={profileDraft.signature}
                  placeholder="说点什么..."
                  onChange={event => setProfileDraft(prev => ({ ...prev, signature: event.target.value }))}
                />
              </div>

            </div>
            <footer className="xhs-profile-edit-footer">
              <button
                type="button"
                className="xhs-profile-edit-footer-cancel"
                onClick={() => setProfileOpen(false)}
              >
                关闭
              </button>
              <button
                type="button"
                className="xhs-profile-edit-footer-save"
                onClick={handleSaveProfile}
              >
                保存
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="xhs-modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <section className="xhs-confirm-sheet" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="确认删除">
            <header>
              <strong>{deleteTarget.type === "note" ? "删除这篇笔记？" : "删除这条评论？"}</strong>
              <button type="button" className="xhs-sheet-close-btn" onClick={() => setDeleteTarget(null)} aria-label="关闭">×</button>
            </header>
            <p>
              {deleteTarget.type === "note"
                ? `将删除《${deleteTarget.title}》，相关评论、消息和短期记忆事件也会一并清理。`
                : `将删除 ${deleteTarget.comment.authorName} 在《${deleteTarget.noteTitle}》下的评论，相关短期记忆事件也会一并清理。`}
            </p>
            {deleteTarget.type === "comment" ? (
              <blockquote>{deleteTarget.comment.text}</blockquote>
            ) : null}
            <div className="xhs-confirm-actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="xhs-confirm-delete-btn" onClick={handleConfirmDelete}>确认删除</button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingFeedAction ? (
        <div className="xhs-modal-backdrop" onClick={() => setPendingFeedAction(null)}>
          <section className="xhs-confirm-sheet" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={pendingFeedAction === "refresh" ? "确认刷新" : "确认清空内容流"}>
            <header>
              <strong>{pendingFeedAction === "refresh" ? "新增一批小红书内容？" : "清空首页、附近和视频内容？"}</strong>
              <button type="button" className="xhs-sheet-close-btn" onClick={() => setPendingFeedAction(null)} aria-label="关闭">×</button>
            </header>
            <p>
              {pendingFeedAction === "refresh"
                ? "将生成一批新的首页与视频内容，已有内容会保留，旧内容不会回传给本次生成链路。"
                : "将清空首页推荐、附近和视频页当前可见内容；消息、私信、用户主页和互动记录会保留。"}
            </p>
            <div className="xhs-confirm-actions">
              <button type="button" onClick={() => setPendingFeedAction(null)}>取消</button>
              <button
                type="button"
                className={pendingFeedAction === "clear" ? "xhs-confirm-delete-btn" : "xhs-confirm-primary-btn"}
                onClick={() => void handleConfirmFeedAction()}
              >
                {pendingFeedAction === "refresh" ? "确认新增" : "确认清空"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
