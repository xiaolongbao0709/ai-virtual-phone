"use client";

import { useEffect, useMemo, useState } from "react";
import { useCheckPhoneRefresh } from "@/lib/checkphone-refresh-tracker";
import {
  ChevronLeft,
  Heart,
  MessageCircle,
  MessageCircleMore,
  RefreshCw,
  Users,
  Aperture,
  UserCircle,
  Trash2,
  Search,
  MoreHorizontal,
  Plus,
  Smile,
  Mic,
  type LucideIcon,
} from "lucide-react";
import { CheckPhoneBilingualText, normalizeCheckPhoneText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneChatBubble,
  CheckPhoneChatConversation,
  CheckPhoneChatGroup,
  CheckPhoneChatMomentItem,
  CheckPhoneChatPayload,
  CheckPhoneSnapshot,
} from "@/lib/checkphone-config";
import { generateCheckPhoneChat } from "@/lib/checkphone-engine";
import {
  findCustomStickerByName,
  resolveCustomStickerUrl,
} from "@/lib/custom-sticker-storage";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import { findStickerByName } from "@/lib/sticker-data";
import {
  clearPhoneSnapshot,
  loadPhoneSnapshot,
  savePhoneSnapshot,
} from "@/lib/checkphone-storage";
import { splitBilingualText } from "@/lib/bilingual-text";
import { resolveUserIdentity } from "@/lib/settings-storage";

type CheckPhoneChatPageProps = {
  character: Character;
  onBack: () => void;
};

type ChatTabId = "conversations" | "groups" | "moments" | "contacts";
type ChatTextPart =
  | { type: "text"; value: string }
  | { type: "sticker"; label: string };

const CHAT_TABS: Array<{ id: ChatTabId; label: string; title: string; description: string; icon: LucideIcon }> = [
  {
    id: "conversations",
    label: "Chats",
    title: "Chats",
    description: "Private threads and recent words.",
    icon: MessageCircle,
  },
  {
    id: "groups",
    label: "Groups",
    title: "Group Chats",
    description: "Shared rooms and loose plans.",
    icon: Users,
  },
  {
    id: "moments",
    label: "Moments",
    title: "Moments",
    description: "Public traces from the day.",
    icon: Aperture,
  },
  {
    id: "contacts",
    label: "Contacts",
    title: "Contacts",
    description: "Names and nearby orbits.",
    icon: UserCircle,
  },
];
const CHECKPHONE_STICKER_RE = /\[表情包[：:]([^\]]+)\]/g;
const checkPhoneStickerUrlCache = new Map<string, string>();

function getInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "X";
}

function isRealDirectConversation(item: Pick<CheckPhoneChatConversation, "id" | "tagLabel">): boolean {
  return item.id.startsWith("real_conv_") || item.tagLabel === "真实会话";
}

function parseCheckPhoneChatText(text: string): ChatTextPart[] {
  const parts: ChatTextPart[] = [];
  let lastIndex = 0;
  const re = new RegExp(CHECKPHONE_STICKER_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "sticker", label: (match[1] ?? "").trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ type: "text", value: text.slice(lastIndex) });
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

function isCheckPhoneStickerOnly(text: string): boolean {
  const parts = parseCheckPhoneChatText(text.trim());
  return parts.length === 1 && parts[0].type === "sticker";
}

function isCheckPhoneImageStickerOnly(text: string, characterId: string): boolean {
  const parts = parseCheckPhoneChatText(text.trim());
  if (parts.length !== 1 || parts[0].type !== "sticker") return false;
  const custom = findCustomStickerByName(characterId, parts[0].label);
  return Boolean(custom?.externalUrl || custom?.assetId);
}

function formatCheckPhonePreviewText(text: string): string {
  return text.replace(CHECKPHONE_STICKER_RE, (_, label: string) => `[${label.trim() || "表情包"}]`);
}

function getChatListPlainText(text: string): string {
  const normalized = normalizeCheckPhoneText(text);
  return formatCheckPhonePreviewText(splitBilingualText(normalized)?.original ?? normalized);
}

function getConversationPreview(item: CheckPhoneChatConversation): string {
  const lastMessage = item.messages[item.messages.length - 1];
  return getChatListPlainText(lastMessage?.text?.trim() || item.preview);
}

function getGroupPreview(item: CheckPhoneChatGroup): string {
  const lastMessage = item.messages[item.messages.length - 1];
  return getChatListPlainText(lastMessage?.text?.trim() || item.preview);
}

function formatGroupMemberCountLabel(label: string): string {
  const compactLabel = label.trim().replace(/\s+/g, "");
  const numericCount = compactLabel.match(/^(\d+)人$/);
  return numericCount ? numericCount[1] : compactLabel;
}

function formatGroupMemberCountWithUnit(label: string): string {
  const count = formatGroupMemberCountLabel(label);
  return /^\d+$/.test(count) ? `${count}人` : count;
}

function formatMomentCountLabel(label: string): string {
  return label.trim().replace(/\s*(?:赞|评论)\s*$/, "");
}

const CHECKPHONE_BUBBLE_MERGE_THRESHOLD_MS = 5 * 60_000;

function isSameBubbleSender(
  current: CheckPhoneChatBubble,
  adjacent: CheckPhoneChatBubble | undefined,
): boolean {
  if (!adjacent || current.direction !== adjacent.direction) return false;
  if ((current.authorLabel ?? "") !== (adjacent.authorLabel ?? "")) return false;

  const currentTime = parseCheckPhoneTimeRank(current.timeLabel);
  const adjacentTime = parseCheckPhoneTimeRank(adjacent.timeLabel);
  if (currentTime <= 0 || adjacentTime <= 0) return false;

  return Math.abs(currentTime - adjacentTime) <= CHECKPHONE_BUBBLE_MERGE_THRESHOLD_MS;
}

function getMergedBubbleRadius(): string {
  return "16px";
}

function getSoftBubbleFill(outgoing: boolean): string {
  return outgoing
    ? "linear-gradient(145deg, rgba(235, 230, 255, 0.78), rgba(220, 212, 255, 0.78))"
    : "rgba(255, 255, 255, 0.74)";
}

function getSoftBubbleGlow(outgoing: boolean): string {
  return outgoing
    ? "0 0 12px 2px rgba(220, 212, 255, 0.28), 0 8px 20px rgba(70, 76, 112, 0.025)"
    : "0 0 12px 2px rgba(255, 255, 255, 0.38), 0 8px 20px rgba(70, 76, 112, 0.025)";
}

function parseCheckPhoneTimeRank(timeLabel: string): number {
  const label = timeLabel.trim();
  if (!label) return 0;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const minuteAgo = label.match(/^(\d+)\s*(?:分钟|分)前$/);
  if (minuteAgo) return now.getTime() - Number(minuteAgo[1]) * 60_000;
  const hourAgo = label.match(/^(\d+)\s*小时前$/);
  if (hourAgo) return now.getTime() - Number(hourAgo[1]) * 3_600_000;
  const dayAgo = label.match(/^(\d+)\s*天前$/);
  if (dayAgo) return now.getTime() - Number(dayAgo[1]) * 86_400_000;
  if (/^(刚刚|现在)$/.test(label)) return now.getTime();
  if (label === "今天") return todayStart.getTime();
  if (label === "昨天") return todayStart.getTime() - 86_400_000;
  if (label === "前天") return todayStart.getTime() - 2 * 86_400_000;

  const makeDate = (base: Date, hour: string, minute: string) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(hour), Number(minute)).getTime();

  const todayTime = label.match(/^(?:今天\s*)?(\d{1,2}):(\d{2})$/);
  if (todayTime) return makeDate(todayStart, todayTime[1], todayTime[2]);

  const yesterdayTime = label.match(/^昨天\s*(\d{1,2}):(\d{2})$/);
  if (yesterdayTime) {
    return makeDate(new Date(todayStart.getTime() - 86_400_000), yesterdayTime[1], yesterdayTime[2]);
  }

  const beforeYesterdayTime = label.match(/^前天\s*(\d{1,2}):(\d{2})$/);
  if (beforeYesterdayTime) {
    return makeDate(new Date(todayStart.getTime() - 2 * 86_400_000), beforeYesterdayTime[1], beforeYesterdayTime[2]);
  }

  const weekdayTime = label.match(/^(星期|周)([日一二三四五六])\s*(\d{1,2}):(\d{2})$/);
  if (weekdayTime) {
    const weekdayMap: Record<string, number> = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const targetDay = weekdayMap[weekdayTime[2]];
    const diff = (now.getDay() - targetDay + 7) % 7;
    return makeDate(new Date(todayStart.getTime() - diff * 86_400_000), weekdayTime[3], weekdayTime[4]);
  }

  const weekdayOnly = label.match(/^(星期|周)([日一二三四五六])$/);
  if (weekdayOnly) {
    const weekdayMap: Record<string, number> = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    const targetDay = weekdayMap[weekdayOnly[2]];
    const diff = (now.getDay() - targetDay + 7) % 7;
    return todayStart.getTime() - diff * 86_400_000;
  }

  const dateTime = label.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})$/);
  if (dateTime) {
    const year = dateTime[1] ? Number(dateTime[1]) : now.getFullYear();
    let time = new Date(year, Number(dateTime[2]) - 1, Number(dateTime[3]), Number(dateTime[4]), Number(dateTime[5])).getTime();
    if (!dateTime[1] && time > now.getTime() + 86_400_000) {
      time = new Date(year - 1, Number(dateTime[2]) - 1, Number(dateTime[3]), Number(dateTime[4]), Number(dateTime[5])).getTime();
    }
    return time;
  }

  const numericDateTime = label.match(/^(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (numericDateTime) {
    const year = numericDateTime[1] ? Number(numericDateTime[1]) : now.getFullYear();
    let time = new Date(
      year,
      Number(numericDateTime[2]) - 1,
      Number(numericDateTime[3]),
      Number(numericDateTime[4]),
      Number(numericDateTime[5]),
    ).getTime();
    if (!numericDateTime[1] && time > now.getTime() + 86_400_000) {
      time = new Date(
        year - 1,
        Number(numericDateTime[2]) - 1,
        Number(numericDateTime[3]),
        Number(numericDateTime[4]),
        Number(numericDateTime[5]),
      ).getTime();
    }
    return time;
  }

  const parsed = Date.parse(label);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatCheckPhoneDisplayTime(timeLabel: string): string {
  const label = timeLabel.trim();
  if (!label || !/\d{1,2}:\d{2}/.test(label)) return label;

  const timestamp = parseCheckPhoneTimeRank(label);
  if (timestamp <= 0) return label;

  const date = new Date(timestamp);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 86_400_000;
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

  if (timestamp >= todayStart.getTime()) return hhmm;
  if (timestamp >= todayStart.getTime() - dayMs) return `昨天 ${hhmm}`;
  if (timestamp >= todayStart.getTime() - 6 * dayMs) {
    const names = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    return `${names[date.getDay()]} ${hhmm}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}

function formatCheckPhoneRelativeTime(timeLabel: string): string {
  const label = timeLabel.trim().replace(/^最近活跃\s*/, "");
  if (!label) return "";

  const timestamp = parseCheckPhoneTimeRank(label);
  if (timestamp <= 0) return label;

  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - timestamp);
  const minuteMs = 60_000;
  const hourMs = 3_600_000;
  const dayMs = 86_400_000;

  if (diffMs < hourMs) {
    return `${Math.max(1, Math.floor(diffMs / minuteMs))}分钟前`;
  }
  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)}小时前`;
  }

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const date = new Date(timestamp);
  const activeDayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.max(1, Math.round((todayStart - activeDayStart) / dayMs));

  return dayDiff === 1 ? "昨天" : `${dayDiff}天前`;
}

function formatCheckPhoneGroupActivityLabel(activityLabel: string): string {
  const relativeTime = formatCheckPhoneRelativeTime(activityLabel);
  return relativeTime ? `最近活跃 ${relativeTime}` : "最近活跃";
}

function formatCheckPhoneDisplayDate(dateLabel: string): string {
  const label = dateLabel.trim();
  const match = label.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return label;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayMs = 86_400_000;

  if (dayStart === todayStart.getTime()) return "今天";
  if (dayStart === todayStart.getTime() - dayMs) return "昨天";
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function sortCheckPhoneItemsByRecent<T extends { timeLabel: string }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index, rank: parseCheckPhoneTimeRank(item.timeLabel) }))
    .sort((a, b) => Number(b.rank > 0) - Number(a.rank > 0) || b.rank - a.rank || a.index - b.index)
    .map(({ item }) => item);
}

function sortCheckPhoneGroupsByRecent(items: CheckPhoneChatGroup[]): CheckPhoneChatGroup[] {
  return items
    .map((item, index) => {
      const lastMessage = item.messages[item.messages.length - 1];
      return {
        item,
        index,
        rank: parseCheckPhoneTimeRank(lastMessage?.timeLabel || item.timeLabel),
      };
    })
    .sort((a, b) => Number(b.rank > 0) - Number(a.rank > 0) || b.rank - a.rank || a.index - b.index)
    .map(({ item }) => item);
}

function sortCheckPhoneConversations(items: CheckPhoneChatConversation[]): CheckPhoneChatConversation[] {
  return items
    .map((item, index) => ({ item, index, rank: parseCheckPhoneTimeRank(item.timeLabel) }))
    .sort(
      (a, b) =>
        Number(b.item.pinned === true) - Number(a.item.pinned === true) ||
        Number(b.rank > 0) - Number(a.rank > 0) ||
        b.rank - a.rank ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

function CheckPhoneSticker({
  label,
  characterId,
}: {
  label: string;
  characterId: string;
}) {
  const normalizedLabel = label.trim();
  const cacheKey = `${characterId}:${normalizedLabel}`;
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(
    () => checkPhoneStickerUrlCache.get(cacheKey) ?? null,
  );

  useEffect(() => {
    if (!normalizedLabel || resolvedUrl) return;
    const custom = findCustomStickerByName(characterId, normalizedLabel);
    if (!custom) return;
    if (custom.externalUrl) {
      checkPhoneStickerUrlCache.set(cacheKey, custom.externalUrl);
      setResolvedUrl(custom.externalUrl);
      return;
    }
    if (!custom.assetId) return;

    let cancelled = false;
    resolveCustomStickerUrl(custom.assetId).then((url) => {
      if (!cancelled && url) {
        checkPhoneStickerUrlCache.set(cacheKey, url);
        setResolvedUrl(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, characterId, normalizedLabel, resolvedUrl]);

  if (resolvedUrl) {
    return (
      <img
        src={resolvedUrl}
        alt={normalizedLabel || "表情包"}
        style={{
          width: "92px",
          height: "92px",
          objectFit: "contain",
          display: "block",
        }}
      />
    );
  }

  const builtIn = normalizedLabel ? findStickerByName(normalizedLabel) : undefined;
  if (builtIn?.emoji) {
    return (
      <span
        style={{
          display: "inline-block",
          fontSize: "calc(42px*var(--app-text-scale,1))",
          lineHeight: 1,
        }}
      >
        {builtIn.emoji}
      </span>
    );
  }

  return <span>{`[${normalizedLabel || "表情包"}]`}</span>;
}

function CheckPhoneMessageContent({
  text,
  characterId,
}: {
  text: string;
  characterId: string;
}) {
  const parts = parseCheckPhoneChatText(text);
  if (parts.length === 1 && parts[0].type === "sticker") {
    return (
      <CheckPhoneSticker
        label={parts[0].label}
        characterId={characterId}
      />
    );
  }

  return (
    <span style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((part, index) =>
        part.type === "sticker" ? (
          <CheckPhoneSticker
            key={`sticker_${index}`}
            label={part.label}
            characterId={characterId}
          />
        ) : (
          <CheckPhoneBilingualText key={`text_${index}`} text={part.value} tone="chat" variant="inline" />
        ),
      )}
    </span>
  );
}

function getMomentMediaDescription(item: CheckPhoneChatMomentItem): string {
  const photoDescription = item.photoDescription?.trim();
  if (photoDescription) return photoDescription;

  const mediaLabel = item.mediaLabel.trim();
  if (
    !mediaLabel ||
    /^(文字|动态|有图|无图|图片|配图|照片|\d+\s*张图?)$/.test(mediaLabel)
  ) {
    return "";
  }

  const bracketDescription = mediaLabel.match(/^[^（(]*[（(]([\s\S]+)[）)]$/)?.[1]?.trim();
  if (bracketDescription) return bracketDescription;

  const colonDescription = mediaLabel.match(/^(?:一张图|图片|配图|照片|文字图片|图像|画面)[：:]\s*([\s\S]+)$/)?.[1]?.trim();
  if (colonDescription) return colonDescription;

  return mediaLabel.length > 8 ? mediaLabel : "";
}

function CheckPhoneMomentMedia({
  item,
}: {
  item: CheckPhoneChatMomentItem;
}) {
  const [resolvedPhotoUrl, setResolvedPhotoUrl] = useState<string | null>(null);
  const mediaDescription = getMomentMediaDescription(item);

  useEffect(() => {
    let cancelled = false;
    const photoUrl = item.photoUrl?.trim();
    if (!photoUrl) {
      setResolvedPhotoUrl(null);
      return;
    }
    if (photoUrl.startsWith("asset://")) {
      getChatImageFromIndexedDB(photoUrl.slice(8)).then((url) => {
        if (!cancelled) setResolvedPhotoUrl(url);
      });
    } else {
      setResolvedPhotoUrl(photoUrl);
    }
    return () => {
      cancelled = true;
    };
  }, [item.photoUrl]);

  if (!resolvedPhotoUrl && !mediaDescription) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        margin: "0 0 16px",
        alignItems: "flex-start",
      }}
    >
      {resolvedPhotoUrl ? (
        <img
          src={resolvedPhotoUrl}
          alt={mediaDescription}
          style={{
            maxWidth: "100%",
            maxHeight: "220px",
            objectFit: "scale-down",
            borderRadius: "12px",
            border: "1px solid #f0f0f0",
            background: "#f8f8f8",
          }}
        />
      ) : null}
      {mediaDescription ? (
        <div
          style={{
            width: "100%",
            fontSize: "calc(12px*var(--app-text-scale,1))",
            fontStyle: "italic",
            lineHeight: 1.6,
            color: "rgba(62, 67, 95, 0.62)",
            background: "#f7f4ff",
            borderRadius: "12px",
            padding: "14px 34px",
            boxSizing: "border-box",
            whiteSpace: "pre-wrap",
            textAlign: "center",
          }}
        >
          <CheckPhoneBilingualText text={mediaDescription} tone="chat" />
        </div>
      ) : null}
    </div>
  );
}

function CheckPhoneBubbleAvatar({
  label,
  outgoing,
  visible,
  reserveSpace = true,
}: {
  label: string;
  outgoing: boolean;
  visible: boolean;
  reserveSpace?: boolean;
}) {
  if (!visible && !reserveSpace) return null;

  return (
    <div
      style={{
        width: "38px",
        height: "38px",
        borderRadius: "50%",
        background: outgoing
          ? "linear-gradient(145deg, #9a78ff, #7452e9)"
          : "linear-gradient(145deg, #ece7ff, #f9f6ff)",
        color: outgoing ? "#fff" : "#7b57e8",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "calc(13px*var(--app-text-scale,1))",
        fontWeight: 600,
        flexShrink: 0,
        visibility: visible ? "visible" : "hidden",
        boxShadow: visible ? "0 6px 14px rgba(82, 88, 123, 0.05)" : "none",
      }}
    >
      {label}
    </div>
  );
}

function CheckPhoneChatComposer() {
  const iconStyle = {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.86)",
    color: "rgba(62, 67, 95, 0.56)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    border: "1px solid rgba(255, 255, 255, 0.76)",
    boxShadow: "0 6px 14px rgba(70, 76, 112, 0.025)",
  };

  return (
    <div
      style={{
        padding: "10px 14px calc(10px + env(safe-area-inset-bottom, 0px))",
        background: "rgba(255, 255, 255, 0.78)",
        backdropFilter: "blur(18px)",
        borderTop: "1px solid rgba(166, 171, 197, 0.14)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: "8px",
        position: "relative",
        zIndex: 1,
      }}
    >
      <div style={iconStyle} aria-hidden="true">
        <Plus size={18} strokeWidth={2.2} />
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: "rgba(247, 244, 255, 0.92)",
          height: "36px",
          borderRadius: "18px",
          padding: "0 12px 0 15px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          color: "rgba(62, 67, 95, 0.42)",
          fontSize: "calc(12px*var(--app-text-scale,1))",
          border: "1px solid rgba(155, 132, 235, 0.08)",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Type a message...
        </span>
        <Smile size={17} strokeWidth={2} style={{ flexShrink: 0 }} />
      </div>
      <div style={iconStyle} aria-hidden="true">
        <Mic size={17} strokeWidth={2.2} />
      </div>
      <div style={iconStyle} aria-hidden="true">
        <MoreHorizontal size={18} strokeWidth={2.2} />
      </div>
    </div>
  );
}

export function CheckPhoneChatPage({
  character,
  onBack,
}: CheckPhoneChatPageProps) {
  const [snapshot, setSnapshot] =
    useState<CheckPhoneSnapshot<CheckPhoneChatPayload> | null>(null);
  const [selectedTab, setSelectedTab] = useState<ChatTabId>("conversations");
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useCheckPhoneRefresh(character.id, "chat", setSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setSnapshot(null);
    setDebugRawOutput(null);
    setSelectedTab("conversations");
    setSelectedConversationId(null);
    setSelectedGroupId(null);
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhoneChatPayload>(
        character.id,
        "chat",
      );
      if (cancelled) return;
      setSnapshot(cached);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  async function handleRefresh() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setDebugRawOutput(null);
    const {
      payload,
      summary,
      error: nextError,
      debugRawOutput: nextDebugRawOutput,
    } = await generateCheckPhoneChat(
      character.id,
      snapshot?.payload ?? null,
      snapshot?.updatedAt,
    );
    if (payload) {
      const now = new Date().toISOString();
      const nextSnapshot: CheckPhoneSnapshot<CheckPhoneChatPayload> = {
        id: `${character.id}:chat`,
        characterId: character.id,
        appId: "chat",
        generatedAt: snapshot?.generatedAt ?? now,
        updatedAt: now,
        summary,
        payload,
      };
      await savePhoneSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setSelectedConversationId(null);
      setSelectedGroupId(null);
    }
    setError(nextError ?? null);
    setDebugRawOutput(nextDebugRawOutput ?? null);
    setLoading(false);
    setLoaded(true);
  }

  async function handleClear() {
    if (loading) return;
    await clearPhoneSnapshot(character.id, "chat");
    setSnapshot(null);
    setSelectedTab("conversations");
    setSelectedConversationId(null);
    setSelectedGroupId(null);
    setError(null);
    setDebugRawOutput(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const checkPhoneUserDisplayName = useMemo(
    () => resolveUserIdentity(character.id, "checkphone")?.name?.trim() || "用户",
    [character.id],
  );
  const getConversationDisplayName = (item: CheckPhoneChatConversation | null | undefined): string => {
    if (!item) return "";
    return isRealDirectConversation(item) ? checkPhoneUserDisplayName : item.name;
  };
  const sortedConversations = useMemo(
    () => sortCheckPhoneConversations(payload?.conversations ?? []),
    [payload],
  );
  const sortedGroups = useMemo(
    () => sortCheckPhoneGroupsByRecent(payload?.groups ?? []),
    [payload],
  );
  const sortedMomentsFeed = useMemo(
    () => sortCheckPhoneItemsByRecent(payload?.momentsFeed ?? []),
    [payload],
  );
  const activeConversation = useMemo(
    () =>
      payload?.conversations.find(
        (item) => item.id === selectedConversationId,
      ) ?? null,
    [payload, selectedConversationId],
  );
  const activeGroup = useMemo(
    () => payload?.groups.find((item) => item.id === selectedGroupId) ?? null,
    [payload, selectedGroupId],
  );
  const activeConversationDisplayName = getConversationDisplayName(activeConversation);

  const subtitle = activeGroup
    ? formatCheckPhoneGroupActivityLabel(activeGroup.activityLabel)
    : payload?.headerSubtitle || "会话、群聊与朋友圈";
  const homeTitle =
    CHAT_TABS.find((tab) => tab.id === selectedTab)?.title ?? "Chats";
  const homeDescription =
    CHAT_TABS.find((tab) => tab.id === selectedTab)?.description ?? "";
  const homeSearchLabel =
    selectedTab === "groups" ? "Search group chats..." : "Search chats...";

  const backAction = activeConversation
    ? () => setSelectedConversationId(null)
    : activeGroup
      ? () => setSelectedGroupId(null)
      : onBack;

  return (
    <div
      className="cp-chat-module"
      style={{
        background:
          "radial-gradient(circle at 18% 8%, rgba(255,255,255,0.99) 0, rgba(255,255,255,0) 34%), radial-gradient(circle at 86% 22%, rgba(139,104,255,0.04) 0, rgba(139,104,255,0) 36%), linear-gradient(180deg, #fdfdff 0%, #fbfbff 46%, #f9f9fd 100%)",
        fontFamily: "'Avenir Next', 'Helvetica Neue', sans-serif",
        color: "#20243a",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--cp-appbar-safe-top) 22px 18px",
          background: "transparent",
          flexShrink: 0,
        }}
      >
        {activeConversation || activeGroup ? (
          <>
            <button
              type="button"
              onClick={backAction}
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "50%",
                  border: "1px solid rgba(159, 164, 188, 0.18)",
                  background: "rgba(255, 255, 255, 0.82)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#20243a",
                  boxShadow: "0 8px 20px rgba(64, 69, 102, 0.05)",
                }}
              >
                <ChevronLeft size={19} strokeWidth={2.5} />
              </button>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
            >
              {activeConversation || activeGroup ? (
                <div
                  style={{
                    maxWidth: "100%",
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      borderRadius: activeGroup ? "15px" : "50%",
                      background: activeConversation?.pinned
                        ? "linear-gradient(145deg, #d9d0ff, #f1edff)"
                        : "linear-gradient(145deg, #ece7ff, #f9f6ff)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#7b57e8",
                      fontSize: "calc(15px*var(--app-text-scale,1))",
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {activeGroup ? (
                      <Users size={19} strokeWidth={1.7} />
                    ) : (
                      getInitial(activeConversationDisplayName)
                    )}
                  </div>
                  <strong
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "calc(15px*var(--app-text-scale,1))",
                      fontWeight: 500,
                      color: "#111",
                      letterSpacing: "-0.02em",
                    }}
                  >
                    {activeGroup
                      ? `${activeGroup.name}（${formatGroupMemberCountLabel(activeGroup.memberCountLabel)}）`
                      : activeConversationDisplayName}
                  </strong>
                </div>
              ) : (
                <strong
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "calc(16px*var(--app-text-scale,1))",
                    color: "#111",
                    letterSpacing: "-0.02em",
                  }}
                >
                  {subtitle}
                </strong>
              )}
            </div>
            <button
              type="button"
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "50%",
                  background: "rgba(255, 255, 255, 0.82)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#20243a",
                  border: "1px solid rgba(159, 164, 188, 0.18)",
                  boxShadow: "0 8px 20px rgba(64, 69, 102, 0.05)",
                }}
              >
              <MoreHorizontal size={20} strokeWidth={2} />
            </button>
          </>
        ) : (
          <>
              <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                <button
                type="button"
                onClick={onBack}
                aria-label="Back"
                  style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "50%",
                    border: "1px solid rgba(159, 164, 188, 0.18)",
                    background: "rgba(255, 255, 255, 0.82)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#20243a",
                    boxShadow: "0 8px 20px rgba(64, 69, 102, 0.05)",
                  }}
                >
                  <ChevronLeft size={19} strokeWidth={2.5} />
                </button>
              </div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <button
                type="button"
                onClick={handleRefresh}
                  style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "50%",
                    border: "none",
                    background: "linear-gradient(145deg, #9a78ff, #7452e9)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    boxShadow: "0 10px 22px rgba(116, 82, 233, 0.16)",
                  }}
                >
                  <RefreshCw
                    size={17}
                    strokeWidth={2.2}
                  className={loading ? "cp-spin" : ""}
                />
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearOpen(true)}
                aria-label="Clear chat snapshot"
                  style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "50%",
                    background: "rgba(255, 255, 255, 0.82)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#8a63f2",
                    border: "1px solid rgba(159, 164, 188, 0.18)",
                    boxShadow: "0 8px 20px rgba(64, 69, 102, 0.05)",
                  }}
                >
                  <Trash2 size={17} strokeWidth={2.1} />
                </button>
            </div>
          </>
        )}
      </header>

      {loading && (
        <div
          className="cp-refresh-indicator cp-refresh-indicator--floating"
          aria-live="polite"
        >
          <span className="cp-refresh-indicator-text">正在刷新聊天</span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
        </div>
      )}

      <div className="cp-chat-body">
        {!loaded && (
          <div className="cp-chat-status">Syncing social threads...</div>
        )}

        {loaded && !payload && !loading && (
          <div className="cp-chat-status cp-empty-copy">
            <p>暂无聊天内容</p>
            <span className="cp-chat-hint">点刷新同步会话群聊朋友圈与联系人</span>
          </div>
        )}

        {error ? <CheckPhoneDebugErrorCard error={error} debugRawOutput={debugRawOutput} /> : null}

        {payload && !activeConversation && !activeGroup && (
          <>
            <div
              className="cp-scroll-guard"
              style={{
                flex: "1 1 auto",
                minHeight: 0,
                overflowY: "auto",
                WebkitOverflowScrolling: "touch",
                padding: "0 0 20px",
                display: "flex",
                flexDirection: "column",
              }}
            >
                <div
                  style={{
                    padding: "8px 26px 18px",
                    background: "transparent",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "8px",
                      minWidth: 0,
                    }}
                  >
                    <strong
                      style={{
                        fontSize: "calc(38px*var(--app-text-scale,1))",
                        color: "#20243a",
                        letterSpacing: "-0.035em",
                        fontWeight: 600,
                        fontStyle: "italic",
                        lineHeight: 0.98,
                      }}
                    >
                      {homeTitle}
                    </strong>
                    <span
                      aria-hidden="true"
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: "#9a78ff",
                        boxShadow: "0 0 0 4px rgba(154, 120, 255, 0.12)",
                        marginTop: "6px",
                        flexShrink: 0,
                      }}
                    />
                  </div>
                  <p
                    style={{
                      margin: "12px 0 0",
                      maxWidth: "100%",
                      fontSize: "calc(11px*var(--app-text-scale,1))",
                      lineHeight: 1.45,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      color: "rgba(62, 67, 95, 0.42)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {homeDescription}
                </p>
              </div>

                {(selectedTab === "conversations" || selectedTab === "groups") ? (
                  <div
                    style={{
                      height: "44px",
                      margin: "14px 18px 22px",
                      padding: "0 17px",
                      borderRadius: "22px",
                      background: "rgba(255, 255, 255, 0.86)",
                      border: "1px solid rgba(255, 255, 255, 0.78)",
                      boxShadow: "0 6px 14px rgba(70, 76, 112, 0.02)",
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      color: "rgba(62, 67, 95, 0.42)",
                      fontSize: "calc(13px*var(--app-text-scale,1))",
                      flexShrink: 0,
                    }}
                  >
                    <Search size={16} strokeWidth={2.1} />
                    <span>{homeSearchLabel}</span>
                  </div>
              ) : null}

              {selectedTab === "conversations" && (
                <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "14px",
                      padding: "0 18px",
                    }}
                  >
                  {sortedConversations.map((item) => {
                    const conversationName = getConversationDisplayName(item);
                    return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedConversationId(item.id)}
                        style={{
                          background: item.pinned ? "rgba(246, 244, 255, 0.92)" : "rgba(255, 255, 255, 0.86)",
                          borderRadius: "24px",
                          padding: "16px 18px",
                          display: "flex",
                          alignItems: "center",
                          border: "1px solid rgba(255, 255, 255, 0.78)",
                          boxShadow: "0 10px 24px rgba(70, 76, 112, 0.04)",
                          gap: "16px",
                          textAlign: "left",
                        }}
                      >
                      <div
                        style={{
                            width: "58px",
                            height: "58px",
                            borderRadius: "50%",
                            background: item.pinned ? "linear-gradient(145deg, #d9d0ff, #f1edff)" : "linear-gradient(145deg, #efebff, #faf8ff)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "calc(18px*var(--app-text-scale,1))",
                            color: "#7b57e8",
                            fontWeight: "600",
                            flexShrink: 0,
                          }}
                      >
                        {getInitial(conversationName)}
                      </div>
                      <div
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "center",
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            marginBottom: "4px",
                            gap: "10px",
                            minWidth: 0,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              flex: "1 1 auto",
                              minWidth: 0,
                            }}
                          >
                            <strong
                              style={{
                                  fontSize: "calc(14px*var(--app-text-scale,1))",
                                  color: "#20243a",
                                  fontWeight: 600,
                                flex: "1 1 auto",
                                minWidth: 0,
                                display: "-webkit-box",
                                WebkitLineClamp: 1,
                                WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {getChatListPlainText(conversationName)}
                            </strong>
                            {item.pinned ? (
                              <span
                                style={{
                                    background: "rgba(154, 120, 255, 0.16)",
                                    color: "#7b57e8",
                                  fontSize: "calc(9px*var(--app-text-scale,1))",
                                  padding: "2px 6px",
                                  borderRadius: "8px",
                                    fontWeight: "bold",
                                  flexShrink: 0,
                                }}
                              >
                                置顶
                              </span>
                            ) : null}
                            {item.muted ? (
                              <span
                                style={{
                                    background: "rgba(141, 146, 166, 0.16)",
                                    color: "#777d92",
                                  fontSize: "calc(9px*var(--app-text-scale,1))",
                                  padding: "2px 6px",
                                  borderRadius: "8px",
                                  fontWeight: "bold",
                                  flexShrink: 0,
                                }}
                              >
                                静音
                              </span>
                            ) : null}
                          </div>
                          <time
                            style={{
                                fontSize: "calc(10px*var(--app-text-scale,1))",
                                color: "rgba(62, 67, 95, 0.48)",
                              flexShrink: 0,
                              marginLeft: "12px",
                            }}
                          >
                            {formatCheckPhoneDisplayTime(item.timeLabel)}
                          </time>
                        </div>
                        <p
                          style={{
                            margin: 0,
                              fontSize: "calc(11px*var(--app-text-scale,1))",
                              color: "rgba(62, 67, 95, 0.68)",
                            display: "-webkit-box",
                            WebkitLineClamp: 1,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            lineHeight: 1.4,
                          }}
                        >
                          {getConversationPreview(item)}
                        </p>
                      </div>
                    </button>
                    );
                  })}
                </div>
              )}

              {selectedTab === "groups" && (
                <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "14px",
                      padding: "0 18px",
                    }}
                  >
                  {sortedGroups.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedGroupId(item.id)}
                        style={{
                          background: "rgba(255, 255, 255, 0.86)",
                          borderRadius: "24px",
                          padding: "17px 18px",
                          display: "flex",
                          alignItems: "center",
                          border: "1px solid rgba(255, 255, 255, 0.78)",
                          boxShadow: "0 10px 24px rgba(70, 76, 112, 0.04)",
                          gap: "16px",
                          textAlign: "left",
                        }}
                    >
                      <div
                        style={{
                            width: "62px",
                            height: "62px",
                            borderRadius: "50%",
                            background: "linear-gradient(145deg, #efebff, #fbf9ff)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                            color: "#7b57e8",
                          flexShrink: 0,
                        }}
                      >
                          <Users size={24} strokeWidth={2} />
                      </div>
                      <div
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "center",
                          minWidth: 0,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            marginBottom: "4px",
                            gap: "10px",
                            minWidth: 0,
                          }}
                        >
                          <strong
                            style={{
                                fontSize: "calc(14px*var(--app-text-scale,1))",
                                color: "#20243a",
                                fontWeight: 600,
                              flex: "1 1 auto",
                              minWidth: 0,
                              display: "-webkit-box",
                              WebkitLineClamp: 1,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {getChatListPlainText(item.name)}
                          </strong>
                          <time
                            style={{
                                fontSize: "calc(10px*var(--app-text-scale,1))",
                                color: "rgba(62, 67, 95, 0.48)",
                              flexShrink: 0,
                              marginLeft: "12px",
                            }}
                          >
                            {formatCheckPhoneDisplayTime(item.timeLabel)}
                          </time>
                        </div>
                        <p
                          style={{
                            margin: 0,
                              fontSize: "calc(11px*var(--app-text-scale,1))",
                              color: "rgba(62, 67, 95, 0.68)",
                            display: "-webkit-box",
                            WebkitLineClamp: 1,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            lineHeight: 1.4,
                          }}
                        >
                          {getGroupPreview(item)}
                        </p>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            marginTop: "8px",
                          }}
                        >
                            <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(62, 67, 95, 0.58)" }}>
                            {formatGroupMemberCountWithUnit(item.memberCountLabel)}
                          </span>
                          <span
                            style={{
                              width: "4px",
                              height: "4px",
                              borderRadius: "50%",
                                background: "#9a78ff",
                            }}
                          />
                          <span
                            style={{
                                fontSize: "calc(10px*var(--app-text-scale,1))",
                                color: "rgba(62, 67, 95, 0.58)",
                              fontStyle: "italic",
                            }}
                          >
                            {formatCheckPhoneGroupActivityLabel(item.activityLabel)}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {selectedTab === "moments" && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "18px",
                      padding: "16px 18px",
                    }}
                  >
                  {sortedMomentsFeed.map((item) => (
                    <article
                      key={item.id}
                        style={{
                          background: "rgba(255, 255, 255, 0.86)",
                          padding: "18px 18px 20px",
                          borderRadius: "16px",
                          border: "1px solid rgba(255, 255, 255, 0.78)",
                          boxShadow: "0 10px 24px rgba(70, 76, 112, 0.04)",
                          display: "flex",
                          flexDirection: "column",
                        }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                          marginBottom: "16px",
                        }}
                      >
                        <div
                          style={{
                              width: "44px",
                              height: "44px",
                              borderRadius: "50%",
                              background: "linear-gradient(145deg, #e7ddff, #f7f2ff)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                              fontSize: "calc(14px*var(--app-text-scale,1))",
                              color: "#7b57e8",
                              fontWeight: "600",
                          }}
                        >
                          {getInitial(item.authorLabel)}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            flex: 1,
                          }}
                        >
                          <strong
                            style={{
                                fontSize: "calc(14px*var(--app-text-scale,1))",
                                color: "#20243a",
                                fontWeight: 600,
                            }}
                          >
                            {item.authorLabel}
                          </strong>
                          <time
                            style={{
                                fontSize: "calc(10px*var(--app-text-scale,1))",
                                color: "rgba(62, 67, 95, 0.48)",
                                marginTop: "2px",
                            }}
                          >
                            {formatCheckPhoneDisplayTime(item.timeLabel)}
                            </time>
                          </div>
                          <div
                            aria-hidden="true"
                            style={{
                              color: "rgba(62, 67, 95, 0.36)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                              transform: "translateY(-14px)",
                            }}
                          >
                            <MoreHorizontal size={22} strokeWidth={2.2} />
                          </div>
                        </div>
                        <p
                          style={{
                            margin: "2px 0 18px",
                            fontSize: "calc(13px*var(--app-text-scale,1))",
                            color: "#353a54",
                            lineHeight: 1.75,
                            letterSpacing: "0.01em",
                          }}
                      >
                        <CheckPhoneBilingualText text={item.body} tone="chat" />
                      </p>
                      <CheckPhoneMomentMedia item={item} />
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "16px",
                          marginBottom: "16px",
                        }}
                      >
                        {item.mediaLabel && !getMomentMediaDescription(item) && (
                          <span
                            style={{
                              fontSize: "calc(10px*var(--app-text-scale,1))",
                              color: "#666",
                              background: "#f9f9f9",
                              padding: "4px 8px",
                              borderRadius: "4px",
                            }}
                          >
                            {item.mediaLabel}
                          </span>
                        )}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "11px",
                              marginLeft: "auto",
                              color: "rgba(130, 100, 235, 0.72)",
                              fontSize: "calc(13px*var(--app-text-scale,1))",
                              fontWeight: 500,
                              lineHeight: 1,
                            }}
                          >
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: "6px",
                                height: "18px",
                              }}
                            >
                              <Heart
                                size={18}
                                fill="currentColor"
                                strokeWidth={0}
                                style={{ display: "block", flexShrink: 0, transform: "translateY(-1px)" }}
                              />
                              {formatMomentCountLabel(item.likeCountLabel)}
                            </span>
                            <span
                              aria-hidden="true"
                              style={{
                                width: "1px",
                                height: "12px",
                                background: "rgba(130, 100, 235, 0.20)",
                              }}
                            />
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: "6px",
                                height: "18px",
                              }}
                            >
                              <MessageCircleMore
                                size={19}
                                fill="rgba(130, 100, 235, 0.72)"
                                color="#fff"
                                strokeWidth={2.5}
                                style={{ display: "block", flexShrink: 0, transform: "translateY(-1px)" }}
                              />
                              {formatMomentCountLabel(item.commentCountLabel)}
                            </span>
                          </div>
                      </div>
                      {item.comments.length > 0 && (
                        <div
                          style={{
                              background: "rgba(248, 247, 255, 0.82)",
                              padding: "14px",
                              borderRadius: "12px",
                              border: "1px solid rgba(155, 132, 235, 0.10)",
                              display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                          }}
                        >
                          {item.comments.map((comment) => (
                            <div
                              key={comment.id}
                              style={{
                                fontSize: "calc(11px*var(--app-text-scale,1))",
                                color: "#333",
                                lineHeight: 1.5,
                              }}
                            >
                                <strong style={{ fontWeight: 600, color: "#7b57e8" }}>
                                {comment.authorLabel}
                              </strong>
                              {comment.replyToLabel ? (
                                <span
                                  style={{ color: "#999", margin: "0 4px" }}
                                >
                                  to
                                </span>
                              ) : (
                                <span style={{ margin: "0 4px" }}>:</span>
                              )}
                              {comment.replyToLabel ? (
                                <strong
                                  style={{
                                      fontWeight: 600,
                                      color: "#7b57e8",
                                    marginRight: "4px",
                                  }}
                                >
                                  {comment.replyToLabel}:
                                </strong>
                              ) : null}
                              <span><CheckPhoneBilingualText text={comment.text} tone="chat" variant="inline" /></span>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}

              {selectedTab === "contacts" && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "14px",
                      padding: "16px 18px",
                    }}
                  >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                        background: "rgba(255, 255, 255, 0.86)",
                        borderRadius: "22px",
                        border: "1px solid rgba(255, 255, 255, 0.78)",
                        boxShadow: "0 6px 14px rgba(70, 76, 112, 0.02)",
                        padding: "0 17px",
                        height: "44px",
                        color: "rgba(62, 67, 95, 0.42)",
                        fontSize: "calc(13px*var(--app-text-scale,1))",
                        gap: "10px",
                        margin: "0 0 8px",
                      }}
                    >
                      <Search size={16} strokeWidth={2.1} />
                      <span>Search contacts...</span>
                    </div>
                  {payload.contacts.map((item) => (
                    <article
                      key={item.id}
                        style={{
                          background: "rgba(255, 255, 255, 0.86)",
                          padding: "15px 18px",
                          borderRadius: "24px",
                          border: "1px solid rgba(255, 255, 255, 0.78)",
                          boxShadow: "0 10px 24px rgba(70, 76, 112, 0.04)",
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "14px",
                          textAlign: "left",
                          width: "100%",
                        }}
                    >
                      <div
                        style={{
                            width: "52px",
                            height: "52px",
                            borderRadius: "50%",
                            background: "linear-gradient(145deg, #e7ddff, #f7f2ff)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                            fontSize: "calc(16px*var(--app-text-scale,1))",
                            color: "#7b57e8",
                            fontWeight: "600",
                          flexShrink: 0,
                        }}
                      >
                        {getInitial(item.name)}
                      </div>
                      <div
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                            borderBottom: "none",
                            paddingBottom: 0,
                          justifyContent: "flex-start",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            marginBottom: "4px",
                          }}
                        >
                          <strong
                            style={{
                                fontSize: "calc(14px*var(--app-text-scale,1))",
                                color: "#20243a",
                                fontWeight: 600,
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {item.name}
                          </strong>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "8px",
                          }}
                        >
                          {item.relationLabel && (
                              <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(62, 67, 95, 0.58)" }}>
                              {item.relationLabel}
                            </span>
                          )}
                          {item.tagLabel && (
                            <>
                              <span
                                style={{
                                  width: "3px",
                                  height: "3px",
                                  borderRadius: "50%",
                                    background: "#9a78ff",
                                }}
                              />
                              <span
                                style={{
                                    fontSize: "calc(10px*var(--app-text-scale,1))",
                                    color: "rgba(62, 67, 95, 0.50)",
                                  fontStyle: "italic",
                                }}
                              >
                                {item.tagLabel}
                              </span>
                            </>
                          )}
                        </div>
                        {item.note ? (
                          <p
                            style={{
                              margin: "7px 0 0",
                                fontSize: "calc(11px*var(--app-text-scale,1))",
                                lineHeight: 1.55,
                                color: "rgba(62, 67, 95, 0.68)",
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                            }}
                          >
                            <CheckPhoneBilingualText text={item.note} tone="chat" />
                          </p>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

              <nav
                style={{
                  background: "rgba(255, 255, 255, 0.84)",
                  backdropFilter: "blur(18px)",
                  flexShrink: 0,
                  display: "flex",
                  justifyContent: "space-around",
                  padding: "18px 0 calc(16px + env(safe-area-inset-bottom, 0px))",
                  borderTop: "1px solid rgba(166, 171, 197, 0.18)",
                  boxShadow: "0 -18px 36px rgba(82, 88, 123, 0.05)",
                  zIndex: 10,
                }}
            >
              {CHAT_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = selectedTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSelectedTab(tab.id)}
                    style={{
                      background: "transparent",
                      border: "none",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "6px",
                        color: active ? "#7b57e8" : "rgba(62, 67, 95, 0.45)",
                        padding: "0 16px",
                      }}
                  >
                    <div style={{ position: "relative" }}>
                      <Icon
                          size={24}
                          strokeWidth={active ? 2.5 : 1.7}
                          color={active ? "#7b57e8" : "rgba(62, 67, 95, 0.45)"}
                        />
                    </div>
                    <span
                      style={{
                          fontSize: "calc(11px*var(--app-text-scale,1))",
                          fontWeight: active ? 700 : 500,
                        letterSpacing: "0.02em",
                      }}
                    >
                      {tab.label}
                    </span>
                  </button>
                );
              })}
            </nav>
          </>
        )}

        {payload && activeConversation && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 20,
              background:
                "radial-gradient(circle at 18% 8%, rgba(255,255,255,0.99) 0, rgba(255,255,255,0) 34%), radial-gradient(circle at 86% 22%, rgba(139,104,255,0.04) 0, rgba(139,104,255,0) 36%), linear-gradient(180deg, #fdfdff 0%, #fbfbff 46%, #f9f9fd 100%)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              className="cp-scroll-guard"
              style={{
                flex: 1,
                minHeight: 0,
                padding: "14px 18px 18px",
                overflowY: "auto",
                WebkitOverflowScrolling: "touch",
                display: "flex",
                flexDirection: "column",
                gap: "18px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 0,
                }}
              >
                {activeConversation.messages.map((message, index, messages) => {
                  const stickerOnly = isCheckPhoneStickerOnly(message.text);
                  const imageStickerOnly = isCheckPhoneImageStickerOnly(message.text, character.id);
                  const outgoing = message.direction === "outgoing";
                  const groupedWithPrevious = isSameBubbleSender(
                    message,
                    messages[index - 1],
                  );
                  const groupedWithNext = isSameBubbleSender(
                    message,
                    messages[index + 1],
                  );
                  return (
                    <div
                      key={message.id}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: outgoing ? "flex-end" : "flex-start",
                        maxWidth: "90%",
                        alignSelf: outgoing ? "flex-end" : "flex-start",
                        marginTop: index === 0 ? 0 : groupedWithPrevious ? "3px" : "13px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexDirection: outgoing ? "row-reverse" : "row",
                          alignItems: "flex-end",
                          gap: "8px",
                          maxWidth: "100%",
                        }}
                      >
                        <CheckPhoneBubbleAvatar
                          label={outgoing ? "我" : getInitial(activeConversationDisplayName)}
                          outgoing={outgoing}
                          visible={!outgoing && !groupedWithPrevious}
                          reserveSpace={!outgoing}
                        />
                        <div
                          style={{
                            position: "relative",
                            isolation: "isolate",
                            overflow: "visible",
                            background: "transparent",
                            color: imageStickerOnly
                              ? "#20243a"
                              : stickerOnly
                                ? outgoing
                                  ? "rgba(62, 67, 95, 0.58)"
                                  : "rgba(62, 67, 95, 0.56)"
                                : outgoing
                                  ? "#20243a"
                                  : "#20243a",
                            padding: imageStickerOnly ? 0 : "8px 13px",
                            borderRadius: getMergedBubbleRadius(),
                            fontSize: "calc(13px*var(--app-text-scale,1))",
                            lineHeight: 1.55,
                            border: imageStickerOnly ? "none" : "1px solid rgba(154, 120, 255, 0.16)",
                            boxSizing: "border-box",
                            boxShadow: imageStickerOnly ? "none" : getSoftBubbleGlow(outgoing),
                            wordBreak: "break-word",
                          }}
                        >
                          {!imageStickerOnly ? (
                            <span
                              aria-hidden="true"
                              style={{
                                position: "absolute",
                                inset: 0,
                                zIndex: 0,
                                pointerEvents: "none",
                                borderRadius: getMergedBubbleRadius(),
                                background: getSoftBubbleFill(outgoing),
                                filter: "blur(2.5px)",
                                transform: "scale(1.018)",
                              }}
                            />
                          ) : null}
                          <span style={{ position: "relative", zIndex: 1, display: "block" }}>
                            <CheckPhoneMessageContent
                              text={message.text}
                              characterId={character.id}
                            />
                          </span>
                        </div>
                      </div>
                      {!groupedWithNext ? (
                        <time
                          style={{
                            fontSize: "calc(10px*var(--app-text-scale,1))",
                            color: "rgba(62, 67, 95, 0.38)",
                            marginTop: "4px",
                            marginLeft: outgoing ? 0 : "46px",
                            marginRight: 0,
                            padding: "0 4px",
                          }}
                        >
                          {formatCheckPhoneDisplayTime(message.timeLabel)}
                        </time>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <CheckPhoneChatComposer />
          </div>
        )}

        {payload && activeGroup && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 20,
              background:
                "radial-gradient(circle at 18% 8%, rgba(255,255,255,0.99) 0, rgba(255,255,255,0) 34%), radial-gradient(circle at 86% 22%, rgba(139,104,255,0.04) 0, rgba(139,104,255,0) 36%), linear-gradient(180deg, #fdfdff 0%, #fbfbff 46%, #f9f9fd 100%)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              className="cp-scroll-guard"
              style={{
                flex: 1,
                minHeight: 0,
                padding: "14px 18px 18px",
                overflowY: "auto",
                WebkitOverflowScrolling: "touch",
                display: "flex",
                flexDirection: "column",
                gap: "18px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 0,
                }}
              >
                {activeGroup.messages.map((message, index, messages) => {
                  const stickerOnly = isCheckPhoneStickerOnly(message.text);
                  const imageStickerOnly = isCheckPhoneImageStickerOnly(message.text, character.id);
                  const outgoing = message.direction === "outgoing";
                  const speakerLabel = outgoing ? "我" : message.authorLabel;
                  const groupedWithPrevious = isSameBubbleSender(
                    message,
                    messages[index - 1],
                  );
                  const groupedWithNext = isSameBubbleSender(
                    message,
                    messages[index + 1],
                  );
                  return (
                    <div
                      key={message.id}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: outgoing ? "flex-end" : "flex-start",
                        maxWidth: "90%",
                        alignSelf: outgoing ? "flex-end" : "flex-start",
                        marginTop: index === 0 ? 0 : groupedWithPrevious ? "3px" : "13px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexDirection: outgoing ? "row-reverse" : "row",
                          alignItems: "flex-end",
                          gap: "8px",
                          maxWidth: "100%",
                        }}
                      >
                        <CheckPhoneBubbleAvatar
                          label={outgoing ? "我" : getInitial(message.authorLabel || activeGroup.name)}
                          outgoing={outgoing}
                          visible={!outgoing && !groupedWithPrevious}
                          reserveSpace={!outgoing}
                        />
                        <div
                          style={{
                            position: "relative",
                            isolation: "isolate",
                            overflow: "visible",
                            background: "transparent",
                            color: imageStickerOnly
                              ? "#20243a"
                              : stickerOnly
                                ? outgoing
                                  ? "rgba(62, 67, 95, 0.58)"
                                  : "rgba(62, 67, 95, 0.56)"
                                : outgoing
                                  ? "#20243a"
                                  : "#20243a",
                            padding: imageStickerOnly ? 0 : "8px 13px",
                            borderRadius: getMergedBubbleRadius(),
                            fontSize: "calc(13px*var(--app-text-scale,1))",
                            lineHeight: 1.55,
                            border: imageStickerOnly ? "none" : "1px solid rgba(154, 120, 255, 0.16)",
                            boxSizing: "border-box",
                            boxShadow: imageStickerOnly ? "none" : getSoftBubbleGlow(outgoing),
                            wordBreak: "break-word",
                          }}
                        >
                          {!imageStickerOnly ? (
                            <span
                              aria-hidden="true"
                              style={{
                                position: "absolute",
                                inset: 0,
                                zIndex: 0,
                                pointerEvents: "none",
                                borderRadius: getMergedBubbleRadius(),
                                background: getSoftBubbleFill(outgoing),
                                filter: "blur(2.5px)",
                                transform: "scale(1.018)",
                              }}
                            />
                          ) : null}
                          <span style={{ position: "relative", zIndex: 1, display: "block" }}>
                            <CheckPhoneMessageContent
                              text={message.text}
                              characterId={character.id}
                            />
                          </span>
                        </div>
                      </div>
                      {!groupedWithNext ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "calc(10px*var(--app-text-scale,1))",
                            color: "rgba(62, 67, 95, 0.38)",
                            marginTop: "4px",
                            marginLeft: outgoing ? 0 : "46px",
                            marginRight: 0,
                            padding: "0 4px",
                          }}
                        >
                            {speakerLabel ? (
                              <span style={{ color: "#7b57e8", fontWeight: 600 }}>
                                {speakerLabel}
                              </span>
                            ) : null}
                          <time>{formatCheckPhoneDisplayTime(message.timeLabel)}</time>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <CheckPhoneChatComposer />
          </div>
        )}
      </div>
      {confirmClearOpen && (
        <ConfirmDialog
          title="清空聊天内容？"
          message="确认后会清空当前聊天缓存。之后重新刷新时，不会再带入旧聊天内容。"
          variant="danger"
          confirmLabel="确认清空"
          cancelLabel="取消"
          onConfirm={handleClear}
          onCancel={() => setConfirmClearOpen(false)}
        />
      )}
    </div>
  );
}
