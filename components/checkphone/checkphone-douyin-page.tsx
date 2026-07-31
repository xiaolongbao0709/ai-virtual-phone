"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type TouchEvent,
  type WheelEvent,
} from "react";
import { useCheckPhoneRefresh } from "@/lib/checkphone-refresh-tracker";
import {
  ChevronLeft,
  Bell,
  Clock3,
  Heart,
  LayoutGrid,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  Trash2,
  Search,
  Plus,
  Music,
  ImageIcon,
  AtSign,
  Smile,
  X,
  Maximize2,
} from "lucide-react";
import {
  ChatTeardrop as PhosphorChatTeardrop,
  Heart as PhosphorHeart,
  ShareFat as PhosphorShareFat,
  Star as PhosphorStar,
} from "@phosphor-icons/react";
import { CheckPhoneBilingualText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneDouyinPayload,
  CheckPhoneDouyinVideo,
  CheckPhoneSnapshot,
} from "@/lib/checkphone-config";
import { generateCheckPhoneDouyin } from "@/lib/checkphone-engine";
import {
  clearPhoneSnapshot,
  loadPhoneSnapshot,
  savePhoneSnapshot,
} from "@/lib/checkphone-storage";

type CheckPhoneDouyinPageProps = {
  character: Character;
  onBack: () => void;
};

type DouyinTabId = "works" | "saved" | "liked";
const DOUYIN_TABS: Array<{ id: DouyinTabId; label: string }> = [
  { id: "works", label: "作品" },
  { id: "saved", label: "收藏" },
  { id: "liked", label: "喜欢" },
];

const DOUYIN_PROFILE_SHORTCUTS = [
  { label: "我的订单", icon: ShoppingCart },
  { label: "我的预约", icon: Bell },
  { label: "观看历史", icon: Clock3 },
  { label: "创作者中心", icon: RotateCcw },
  { label: "全部功能", icon: LayoutGrid },
];

function formatCount(count: number): string {
  if (count >= 10000)
    return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1).replace(/\.0$/, "")}万`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

function hasCount(count: number | undefined): count is number {
  return Number.isFinite(count);
}

function getDouyinVideoText(video: CheckPhoneDouyinVideo): string {
  return video.videoDescription?.trim() || "";
}

function formatProfileHandle(handle: string): string {
  return handle.startsWith("抖音号") ? handle : `抖音号：${handle}`;
}

function formatVideoTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}.${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getTabVideos(
  payload: CheckPhoneDouyinPayload | null,
  tab: DouyinTabId,
): CheckPhoneDouyinVideo[] {
  if (!payload) return [];
  switch (tab) {
    case "saved":
      return payload.savedVideos;
    case "liked":
      return payload.likedVideos;
    case "works":
    default:
      return payload.works;
  }
}

function orderDouyinCommentsForThread(
  comments: CheckPhoneDouyinVideo["comments"],
): CheckPhoneDouyinVideo["comments"] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const repliesByParent = new Map<string, CheckPhoneDouyinVideo["comments"]>();
  const roots: CheckPhoneDouyinVideo["comments"] = [];

  comments.forEach((comment) => {
    const parentId = comment.replyToCommentId;
    if (parentId && byId.has(parentId)) {
      const replies = repliesByParent.get(parentId) ?? [];
      replies.push(comment);
      repliesByParent.set(parentId, replies);
      return;
    }
    roots.push(comment);
  });

  const ordered: CheckPhoneDouyinVideo["comments"] = [];
  const visited = new Set<string>();
  const appendWithReplies = (comment: CheckPhoneDouyinVideo["comments"][number]) => {
    if (visited.has(comment.id)) return;
    visited.add(comment.id);
    ordered.push(comment);
    repliesByParent.get(comment.id)?.forEach(appendWithReplies);
  };

  roots.forEach(appendWithReplies);
  comments.forEach(appendWithReplies);
  return ordered;
}

export function CheckPhoneDouyinPage({
  character,
  onBack,
}: CheckPhoneDouyinPageProps) {
  const [snapshot, setSnapshot] =
    useState<CheckPhoneSnapshot<CheckPhoneDouyinPayload> | null>(null);
  const [selectedTab, setSelectedTab] = useState<DouyinTabId>("works");
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useCheckPhoneRefresh(character.id, "douyin", setSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [debugSanitizedOutput, setDebugSanitizedOutput] = useState<string | null>(null);
  const [debugParseError, setDebugParseError] = useState<string | null>(null);
  const [debugNormalizeError, setDebugNormalizeError] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [captionCanExpand, setCaptionCanExpand] = useState(false);
  const [collapsedCaption, setCollapsedCaption] = useState("");
  const [detailDragOffset, setDetailDragOffset] = useState(0);
  const [detailDragSettling, setDetailDragSettling] = useState(false);
  const [detailDragDirection, setDetailDragDirection] =
    useState<"previous" | "next" | null>(null);
  const captionMeasureRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<CheckPhoneSnapshot<CheckPhoneDouyinPayload> | null>(null);
  const detailTouchStartYRef = useRef<number | null>(null);
  const detailLastWheelAtRef = useRef(0);
  const detailSettleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    snapshotRef.current = null;
    setSnapshot(null);
    setSelectedTab("works");
    setSelectedVideoId(null);
    setCommentsOpen(false);
    setCaptionExpanded(false);
    setCaptionCanExpand(false);
    setCollapsedCaption("");
    setDetailDragOffset(0);
    setDetailDragSettling(false);
    setDetailDragDirection(null);
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhoneDouyinPayload>(
        character.id,
        "douyin",
      );
      if (cancelled) return;
      snapshotRef.current = cached;
      setSnapshot(cached);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  useEffect(() => {
    setCaptionExpanded(false);
    setCaptionCanExpand(false);
    setCollapsedCaption("");
    setDetailDragOffset(0);
    setDetailDragSettling(false);
    setDetailDragDirection(null);
  }, [selectedVideoId]);

  async function handleRefresh() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    const previousSnapshot = snapshotRef.current;
    const {
      payload,
      summary,
      error: nextError,
      debugRawOutput: nextDebugRawOutput,
      debugSanitizedOutput: nextDebugSanitizedOutput,
      debugParseError: nextDebugParseError,
      debugNormalizeError: nextDebugNormalizeError,
    } = await generateCheckPhoneDouyin(
      character.id,
      previousSnapshot?.payload ?? null,
      previousSnapshot?.updatedAt,
    );
    if (payload) {
      const now = new Date().toISOString();
      const nextSnapshot: CheckPhoneSnapshot<CheckPhoneDouyinPayload> = {
        id: `${character.id}:douyin`,
        characterId: character.id,
        appId: "douyin",
        generatedAt: previousSnapshot?.generatedAt ?? now,
        updatedAt: now,
        summary,
        payload,
      };
      await savePhoneSnapshot(nextSnapshot);
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setSelectedVideoId(null);
      setCommentsOpen(false);
      setCaptionExpanded(false);
      setCaptionCanExpand(false);
      setCollapsedCaption("");
      setDetailDragOffset(0);
      setDetailDragSettling(false);
      setDetailDragDirection(null);
    }
    setError(nextError ?? null);
    setDebugRawOutput(nextDebugRawOutput ?? null);
    setDebugSanitizedOutput(nextDebugSanitizedOutput ?? null);
    setDebugParseError(nextDebugParseError ?? null);
    setDebugNormalizeError(nextDebugNormalizeError ?? null);
    setLoading(false);
    setLoaded(true);
  }

  async function handleClear() {
    if (loading) return;
    snapshotRef.current = null;
    await clearPhoneSnapshot(character.id, "douyin");
    setSnapshot(null);
    setSelectedVideoId(null);
    setCommentsOpen(false);
    setCaptionExpanded(false);
    setCaptionCanExpand(false);
    setCollapsedCaption("");
    setDetailDragOffset(0);
    setDetailDragSettling(false);
    setDetailDragDirection(null);
    setSelectedTab("works");
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const douyinNickname = payload?.profile.name.trim() ?? "";
  const characterName = character.name.trim();
  const resolveDouyinDisplayName = (name: string | undefined) => {
    const trimmed = name?.trim() ?? "";
    if (!trimmed) return "";
    const unprefixedName = trimmed.replace(/^@+/, "");
    return douyinNickname && characterName && unprefixedName === characterName
      ? douyinNickname
      : trimmed;
  };
  const currentVideos = useMemo(
    () => getTabVideos(payload, selectedTab),
    [payload, selectedTab],
  );
  const selectedTabIndex = DOUYIN_TABS.findIndex((tab) => tab.id === selectedTab);
  const allVideos = useMemo(
    () =>
      payload
        ? [...payload.works, ...payload.savedVideos, ...payload.likedVideos]
        : [],
    [payload],
  );
  const activeVideo = useMemo(
    () => allVideos.find((video) => video.id === selectedVideoId) ?? null,
    [allVideos, selectedVideoId],
  );
  const activeVideoIndex = useMemo(
    () => currentVideos.findIndex((video) => video.id === selectedVideoId),
    [currentVideos, selectedVideoId],
  );
  const activeVideoId = activeVideo?.id ?? null;
  const activeVideoCaption = activeVideo?.caption ?? "";
  const activeVideoComments = useMemo(
    () => (activeVideo ? orderDouyinCommentsForThread(activeVideo.comments) : []),
    [activeVideo],
  );
  const isOwnWorkDetail = selectedTab === "works";
  const ownerViewCount =
    activeVideo && hasCount(activeVideo.likeCount)
      ? Math.round(activeVideo.likeCount * 50)
      : undefined;
  const detailMovableStyle: CSSProperties = {
    transform: `translate3d(0, ${detailDragOffset}px, 0)`,
    transition: detailDragSettling
      ? "transform 170ms cubic-bezier(0.2, 0.82, 0.2, 1)"
      : "none",
    willChange: "transform",
  };
  const detailPreviewVideo = detailDragDirection
    ? getDetailVideoByDirection(detailDragDirection)
    : undefined;
  const detailPreviewStyle: CSSProperties | null = detailDragDirection
    ? {
        transform:
          detailDragDirection === "next"
            ? `translate3d(0, calc(${detailDragOffset}px + 100vh), 0)`
            : `translate3d(0, calc(${detailDragOffset}px - 100vh), 0)`,
        transition: detailDragSettling
          ? "transform 170ms cubic-bezier(0.2, 0.82, 0.2, 1)"
          : "none",
        willChange: "transform",
        pointerEvents: "none",
      }
    : null;

  useEffect(() => {
    return () => {
      if (detailSettleTimerRef.current !== null) {
        window.clearTimeout(detailSettleTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!activeVideoCaption || captionExpanded) return;
    const frame = window.requestAnimationFrame(() => {
      const measureNode = captionMeasureRef.current;
      if (!measureNode) return;

      const caption = activeVideoCaption;
      const computedStyle = window.getComputedStyle(measureNode);
      const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 19.6;
      const maxHeight = lineHeight * 3 + 1;

      measureNode.textContent = caption;
      if (measureNode.scrollHeight <= maxHeight) {
        setCaptionCanExpand(false);
        setCollapsedCaption(caption);
        return;
      }

      let left = 0;
      let right = caption.length;
      let best = "";
      while (left <= right) {
        const middle = Math.floor((left + right) / 2);
        const candidate = caption.slice(0, middle).trimEnd();
        measureNode.textContent = `${candidate}...  展开`;
        if (measureNode.scrollHeight <= maxHeight) {
          best = candidate;
          left = middle + 1;
        } else {
          right = middle - 1;
        }
      }

      setCaptionCanExpand(true);
      setCollapsedCaption(best.slice(0, Math.max(0, best.length - 1)).trimEnd());
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeVideoId, activeVideoCaption, captionExpanded]);

  function getDetailVideoByDirection(direction: "previous" | "next") {
    if (activeVideoIndex < 0) return;
    const nextIndex =
      direction === "previous" ? activeVideoIndex - 1 : activeVideoIndex + 1;
    return currentVideos[nextIndex];
  }

  function switchDetailVideo(direction: "previous" | "next") {
    const nextVideo = getDetailVideoByDirection(direction);
    if (!nextVideo) return;
    setSelectedVideoId(nextVideo.id);
  }

  function handleDetailTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (commentsOpen) return;
    if (detailSettleTimerRef.current !== null) {
      window.clearTimeout(detailSettleTimerRef.current);
      detailSettleTimerRef.current = null;
    }
    setDetailDragSettling(false);
    setDetailDragOffset(0);
    setDetailDragDirection(null);
    detailTouchStartYRef.current = event.touches[0]?.clientY ?? null;
  }

  function handleDetailTouchMove(event: TouchEvent<HTMLDivElement>) {
    if (commentsOpen) return;
    const startY = detailTouchStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY === null || currentY === undefined) return;
    const deltaY = currentY - startY;
    if (Math.abs(deltaY) < 2) return;
    const direction = deltaY < 0 ? "next" : "previous";
    const nextVideo = getDetailVideoByDirection(direction);
    if (!nextVideo) {
      setDetailDragOffset(0);
      setDetailDragDirection(null);
      return;
    }
    event.preventDefault();
    setDetailDragSettling(false);
    setDetailDragDirection(direction);
    setDetailDragOffset(deltaY);
  }

  function handleDetailTouchEnd(event: TouchEvent<HTMLDivElement>) {
    if (commentsOpen) return;
    const startY = detailTouchStartYRef.current;
    detailTouchStartYRef.current = null;
    const endY = event.changedTouches[0]?.clientY;
    if (startY === null || endY === undefined) return;
    const deltaY = endY - startY;
    if (Math.abs(deltaY) < 54) {
      setDetailDragSettling(true);
      setDetailDragOffset(0);
      detailSettleTimerRef.current = window.setTimeout(() => {
        setDetailDragSettling(false);
        setDetailDragDirection(null);
        detailSettleTimerRef.current = null;
      }, 170);
      return;
    }
    const direction = deltaY < 0 ? "next" : "previous";
    const nextVideo = getDetailVideoByDirection(direction);
    if (!nextVideo) {
      setDetailDragSettling(true);
      setDetailDragOffset(0);
      detailSettleTimerRef.current = window.setTimeout(() => {
        setDetailDragSettling(false);
        setDetailDragDirection(null);
        detailSettleTimerRef.current = null;
      }, 170);
      return;
    }
    const exitOffset =
      direction === "next" ? -window.innerHeight : window.innerHeight;
    setDetailDragSettling(true);
    setDetailDragDirection(direction);
    setDetailDragOffset(exitOffset);
    detailSettleTimerRef.current = window.setTimeout(() => {
      setSelectedVideoId(nextVideo.id);
      setDetailDragSettling(false);
      setDetailDragOffset(0);
      setDetailDragDirection(null);
      detailSettleTimerRef.current = null;
    }, 170);
  }

  function handleDetailWheel(event: WheelEvent<HTMLDivElement>) {
    if (commentsOpen || Math.abs(event.deltaY) < 26) return;
    const now = Date.now();
    if (now - detailLastWheelAtRef.current < 420) return;
    detailLastWheelAtRef.current = now;
    switchDetailVideo(event.deltaY < 0 ? "next" : "previous");
  }

  function renderDetailMovingLayer(
    video: CheckPhoneDouyinVideo,
    layerStyle: CSSProperties,
    isPreview = false,
  ) {
    const videoAuthor =
      resolveDouyinDisplayName(video.authorName) || payload?.profile.name || "";
    const showCaptionControls = !isPreview;
    return (
      <div className="cp-douyin-detail-layer" style={layerStyle}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "34px 30px",
            background:
              "radial-gradient(circle at 18% 14%, rgba(255,255,255,0.22), transparent 30%), linear-gradient(145deg, #3a3c43 0%, #14151a 100%)",
            color: "rgba(255,255,255,0.78)",
          }}
        >
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.34) 100%), rgba(0,0,0,0.22)",
            }}
          />
          {getDouyinVideoText(video) ? (
            <div
              style={{
                position: "relative",
                zIndex: 1,
                maxWidth: "78%",
                fontSize: "calc(15px*var(--app-text-scale,1))",
                fontStyle: "italic",
                fontWeight: 450,
                lineHeight: 1.55,
                letterSpacing: "0.03em",
                textAlign: "center",
                textShadow: "0 3px 18px rgba(0,0,0,0.72)",
                whiteSpace: "pre-wrap",
              }}
            >
              <CheckPhoneBilingualText text={getDouyinVideoText(video)} tone="light" />
            </div>
          ) : null}
        </div>

        <div
          style={{
            position: "absolute",
            right: "12px",
            bottom: "132px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "24px",
            zIndex: 60,
          }}
        >
          <div style={{ position: "relative", marginBottom: "8px" }}>
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                background: "#d9dce2",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "calc(24px*var(--app-text-scale,1))",
                color: "#171923",
                border: "2px solid #fff",
              }}
            >
              {videoAuthor.slice(0, 1)}
            </div>
            {!isOwnWorkDetail ? (
              <div
                style={{
                  position: "absolute",
                  bottom: "-8px",
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: "20px",
                  height: "20px",
                  borderRadius: "50%",
                  background: "#ff2c55",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff",
                }}
              >
                <Plus size={14} strokeWidth={3} />
              </div>
            ) : null}
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
            <PhosphorHeart
              size={30}
              weight="fill"
              color={selectedTab === "liked" ? "#ff2c55" : "#fff"}
            />
            {hasCount(video.likeCount) ? (
              <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500 }}>
                {formatCount(video.likeCount)}
              </span>
            ) : null}
          </div>

          <button
            type="button"
            onClick={isPreview ? undefined : () => setCommentsOpen(true)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "4px",
              border: "none",
              background: "transparent",
              color: "#fff",
              padding: 0,
            }}
          >
            <PhosphorChatTeardrop
              size={30}
              weight="fill"
              color="#fff"
              style={{ transform: "scaleX(-1)" }}
            />
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500 }}>
              {formatCount(video.commentCount ?? video.comments.length)}
            </span>
          </button>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
            <PhosphorStar
              size={30}
              weight="fill"
              color={selectedTab === "saved" ? "#fcd34d" : "#fff"}
            />
            {hasCount(video.saveCount) ? (
              <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500 }}>
                {formatCount(video.saveCount)}
              </span>
            ) : null}
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
            <PhosphorShareFat size={30} weight="fill" color="#fff" />
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500 }}>分享</span>
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            bottom: "104px",
            left: "16px",
            right: "72px",
            zIndex: 60,
          }}
        >
          <h3 style={{ fontSize: "calc(17px*var(--app-text-scale,1))", fontWeight: 600, margin: "0 0 8px 0" }}>
            @{videoAuthor}
          </h3>
          <div
            style={{
              fontSize: "calc(14px*var(--app-text-scale,1))",
              fontWeight: 650,
              lineHeight: 1.32,
              margin: "0 0 4px 0",
              display: "-webkit-box",
              WebkitLineClamp: 1,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            <CheckPhoneBilingualText text={video.title} tone="light" />
          </div>
          <div style={{ position: "relative", margin: "0 0 12px 0" }}>
            {showCaptionControls ? (
              <div
                ref={captionMeasureRef}
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: "100%",
                  visibility: "hidden",
                  pointerEvents: "none",
                  whiteSpace: "pre-wrap",
                  fontSize: "calc(14px*var(--app-text-scale,1))",
                  lineHeight: 1.4,
                  fontWeight: 400,
                }}
              />
            ) : null}
            <p
              style={{
                fontSize: "calc(14px*var(--app-text-scale,1))",
                lineHeight: 1.4,
                margin: 0,
                whiteSpace: "pre-wrap",
                ...(!captionExpanded || isPreview
                  ? { maxHeight: "calc(1.4em * 3)", overflow: "hidden" }
                  : {}),
              }}
            >
              <CheckPhoneBilingualText
                text={showCaptionControls && captionCanExpand && !captionExpanded
                  ? `${collapsedCaption}...`
                  : video.caption}
                tone="light"
              />
              {showCaptionControls && captionCanExpand ? (
                <>
                  {"  "}
                  <button
                    type="button"
                    onClick={() => setCaptionExpanded((current) => !current)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "rgba(255,255,255,0.82)",
                      padding: 0,
                      fontSize: "inherit",
                      lineHeight: "inherit",
                      fontWeight: 650,
                    }}
                  >
                    {captionExpanded ? "收起" : "展开"}
                  </button>
                </>
              ) : null}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "calc(14px*var(--app-text-scale,1))" }}>
            <Music size={16} />
            <span
              style={{
                display: "inline-block",
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                width: "200px",
              }}
            >
              {videoAuthor} 创作的原声
            </span>
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            bottom: "calc(58px + max(18px, env(safe-area-inset-bottom, 18px)))",
            left: 0,
            right: 0,
            height: "2px",
            background: "rgba(255,255,255,0.3)",
            zIndex: 70,
          }}
        >
          <div style={{ width: "30%", height: "100%", background: "#fff" }} />
        </div>
      </div>
    );
  }

  const backAction = activeVideo ? () => setSelectedVideoId(null) : onBack;

  return (
    <div
      className="cp-douyin-module"
      style={{
        background: "#f8f9fa",
        fontFamily: "sans-serif",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {!payload && (
        <>
          <header className="cp-douyin-appbar">
            <button type="button" className="cp-float-back" onClick={onBack} aria-label="Back">
              <ChevronLeft size={22} strokeWidth={2.5} />
            </button>
            <div className="cp-douyin-header-stack">
              <div className="cp-douyin-header-title">抖音</div>
              <div className="cp-douyin-header-subtitle">作品、收藏与喜欢</div>
            </div>
            <div className="cp-appbar-actions">
              <button type="button" className="cp-float-refresh" onClick={handleRefresh} disabled={loading} aria-label="Refresh">
                <RefreshCw size={18} strokeWidth={2.5} className={loading ? "cp-spin" : ""} />
              </button>
              <button type="button" className="cp-float-clear" onClick={() => setConfirmClearOpen(true)} disabled={loading || !snapshot} aria-label="Clear douyin snapshot">
                <Trash2 size={17} strokeWidth={2.25} />
              </button>
            </div>
          </header>

          {loading && (
            <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
              <span className="cp-refresh-indicator-text">正在刷新抖音</span>
              <span className="cp-refresh-indicator-dots" aria-hidden="true">
                <i></i><i></i><i></i>
              </span>
            </div>
          )}

          <div className="cp-douyin-body">
            {!loaded && <div className="cp-douyin-status">正在同步主页...</div>}
            {loaded && !loading && (
              <div className="cp-douyin-status cp-empty-copy">
                <p>暂无抖音内容</p>
                <span className="cp-douyin-hint">点刷新同步主页作品收藏和喜欢</span>
              </div>
            )}
          </div>
        </>
      )}

      {payload && !activeVideo && (
        <>
          <div
            className="cp-douyin-profile-topbar"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              zIndex: 80,
              padding: "var(--cp-appbar-safe-top) 16px 10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              pointerEvents: "none",
            }}
          >
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              style={{
                width: "38px",
                height: "38px",
                border: "none",
                borderRadius: "50%",
                background: "rgba(0,0,0,0.28)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "auto",
              }}
            >
              <ChevronLeft size={24} strokeWidth={2.4} />
            </button>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                pointerEvents: "auto",
              }}
            >
              <button
                type="button"
                onClick={handleRefresh}
                disabled={loading}
                aria-label="Refresh"
                style={{
                  width: "38px",
                  height: "38px",
                  border: "none",
                  borderRadius: "50%",
                  background: "rgba(0,0,0,0.28)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <RefreshCw size={18} strokeWidth={2.4} className={loading ? "cp-spin" : ""} />
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearOpen(true)}
                disabled={loading || !snapshot}
                aria-label="Clear douyin snapshot"
                style={{
                  width: "38px",
                  height: "38px",
                  border: "none",
                  borderRadius: "50%",
                  background: "rgba(0,0,0,0.28)",
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Trash2 size={18} strokeWidth={2.35} />
              </button>
            </div>
          </div>

          <div
            className="cp-scroll-guard"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              paddingBottom: "96px",
              background: "#fff",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                position: "relative",
                padding: "calc(var(--cp-appbar-safe-top) + 118px) 16px 76px",
                background:
                  "radial-gradient(circle at 6% 3%, rgba(210, 202, 232, 0.92) 0 18%, rgba(210, 202, 232, 0) 42%), radial-gradient(circle at 90% 4%, rgba(202, 240, 237, 0.95) 0 20%, rgba(202, 240, 237, 0) 44%), radial-gradient(ellipse at 52% 46%, rgba(82, 160, 224, 0.82) 0 34%, rgba(82, 160, 224, 0) 66%), linear-gradient(155deg, #a8bddb 0%, #86bce7 28%, #438fce 58%, #2f78bf 100%)",
                overflow: "hidden",
              }}
            >
            <div style={{ display: "flex", gap: "16px", alignItems: "center", transform: "translateY(-42px)" }}>
              <div style={{ position: "relative" }}>
                <div
                  style={{
                    width: "88px",
                    height: "88px",
                    borderRadius: "50%",
                    background: "#ccc",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "calc(36px*var(--app-text-scale,1))",
                    color: "#fff",
                    border: "2px solid #fff",
                  }}
                >
                  {payload.profile.name.slice(0, 1)}
                </div>
                <div
                  style={{
                    position: "absolute",
                    bottom: "4px",
                    right: "0",
                    background: "#67dc4c",
                    width: "24px",
                    height: "24px",
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "2px solid #fff",
                    color: "#fff",
                  }}
                >
                  <Plus size={16} />
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <h1
                  style={{
                    fontSize: "calc(19px*var(--app-text-scale,1))",
                    fontWeight: "bold",
                    color: "#fff",
                    margin: "0 0 4px 0",
                    textShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }}
                >
                  {payload.profile.name}
                </h1>
                <div
                  style={{
                    fontSize: "calc(12px*var(--app-text-scale,1))",
                    color: "rgba(255,255,255,0.9)",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  {payload.profile.handle ? (
                    <span>{formatProfileHandle(payload.profile.handle)}</span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              padding: "0 16px 16px",
              marginTop: "-16px",
              borderRadius: "16px 16px 0 0",
              position: "relative",
              zIndex: 10,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                paddingTop: "16px",
                marginBottom: "16px",
              }}
            >
              <div style={{ display: "flex", gap: "24px" }}>
                {([
                  ["获赞", payload.profile.likesTotal],
                  ["互关", payload.profile.mutualFollowCount],
                  ["关注", payload.profile.followingCount],
                  ["粉丝", payload.profile.followerCount],
                ] satisfies Array<[string, number | undefined]>).map(([label, value]) =>
                  hasCount(value) ? (
                  <div
                    key={label}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                    }}
                  >
                    <strong style={{ fontSize: "calc(18px*var(--app-text-scale,1))", color: "#111" }}>
                      {formatCount(value)}
                    </strong>
                    <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "#666" }}>{label}</span>
                  </div>
                  ) : null,
                )}
              </div>
              <button
                style={{
                  background: "#f5f5f5",
                  color: "#333",
                  border: "none",
                  borderRadius: "4px",
                  padding: "8px 16px",
                  fontSize: "calc(13px*var(--app-text-scale,1))",
                  fontWeight: 500,
                }}
              >
                编辑主页
              </button>
            </div>

            <div
              style={{
                fontSize: "calc(14px*var(--app-text-scale,1))",
                color: "#333",
                lineHeight: 1.5,
                marginBottom: "12px",
                whiteSpace: "pre-wrap",
              }}
            >
              <CheckPhoneBilingualText text={payload.profile.bio} tone="douyin" />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                padding: "18px 0 16px",
              }}
            >
              {DOUYIN_PROFILE_SHORTCUTS.map(({ label, icon: Icon }) => (
                <button
                  key={label}
                  type="button"
                  style={{
                    minWidth: 0,
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "7px",
                    color: "#151515",
                  }}
                >
                  <Icon size={23} strokeWidth={1.55} />
                  <span
                    style={{
                      width: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "calc(12px*var(--app-text-scale,1))",
                      lineHeight: 1,
                    }}
                  >
                    {label}
                  </span>
                </button>
              ))}
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-around",
                borderBottom: "1px solid #f0f0f0",
                position: "sticky",
                top: "calc(var(--cp-appbar-safe-top) + 40px)",
                background: "#fff",
                zIndex: 30,
                paddingTop: "8px",
                overflow: "hidden",
              }}
            >
              {DOUYIN_TABS.map((tab) => {
                const isActive = tab.id === selectedTab;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSelectedTab(tab.id)}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: "12px 0 8px",
                      fontSize: "calc(15px*var(--app-text-scale,1))",
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? "#111" : "#666",
                      flex: 1,
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: 0,
                  width: `${100 / DOUYIN_TABS.length}%`,
                  height: "2px",
                  display: "flex",
                  justifyContent: "center",
                  transform: `translateX(${Math.max(0, selectedTabIndex) * 100}%)`,
                  transition: "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)",
                  pointerEvents: "none",
                }}
              >
                <span
                  style={{
                    width: "100%",
                    height: "2px",
                    background: "#111",
                  }}
                />
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "1px",
                marginTop: "2px",
                marginLeft: "-16px",
                marginRight: "-16px",
              }}
            >
              {currentVideos.map((video) => (
                <button
                  key={video.id}
                  type="button"
                  onClick={() => {
                    setSelectedVideoId(video.id);
                    setCommentsOpen(false);
                  }}
                  style={{
                    position: "relative",
                    background:
                      "radial-gradient(circle at 18% 12%, rgba(255,255,255,0.38), transparent 34%), linear-gradient(145deg, #e5eaf1 0%, #c4ccd7 100%)",
                    aspectRatio: "3/4",
                    border: "none",
                    padding: "13px 11px",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "rgba(38,42,48,0.7)",
                  }}
                >
                  {video.coverIcon ? (
                    <span
                      style={{
                        position: "relative",
                        zIndex: 1,
                        fontSize: "calc(30px*var(--app-text-scale,1))",
                        lineHeight: 1,
                      }}
                    >
                      {video.coverIcon}
                    </span>
                  ) : null}
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      inset: 0,
                      background:
                        "linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.38) 100%)",
                    }}
                  />
                  {hasCount(video.playCount) ? (
                    <div
                      style={{
                        position: "absolute",
                        bottom: "4px",
                        left: "6px",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        color: "#fff",
                        fontSize: "calc(12px*var(--app-text-scale,1))",
                        textShadow: "0 1px 2px rgba(0,0,0,0.5)",
                      }}
                    >
                      ▷ {formatCount(video.playCount)}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
            {currentVideos.length === 0 && (
              <div
                style={{
                  padding: "48px 0",
                  textAlign: "center",
                  color: "#999",
                  fontSize: "calc(14px*var(--app-text-scale,1))",
                }}
              >
                暂无内容
              </div>
            )}
          </div>
          </div>
        </>
      )}

      {payload && activeVideo && (
        <div
          key={activeVideo.id}
          className={`cp-douyin-detail${commentsOpen ? " cp-douyin-detail--comments-open" : ""}`}
          onTouchStart={handleDetailTouchStart}
          onTouchMove={handleDetailTouchMove}
          onTouchEnd={handleDetailTouchEnd}
          onWheel={handleDetailWheel}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 50,
            background: "#000",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            color: "#fff",
          }}
        >
          <header
            className="cp-douyin-detail-topbar"
            style={{
              position: "absolute",
              top: "var(--cp-appbar-safe-top)",
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "0 16px",
              zIndex: 60,
            }}
          >
            <button
              type="button"
              onClick={backAction}
              style={{
                background: "transparent",
                border: "none",
                color: "#fff",
                padding: "8px",
              }}
            >
              <ChevronLeft size={28} strokeWidth={2} />
            </button>
            <button
              type="button"
              style={{
                background: "transparent",
                border: "none",
                color: "#fff",
                padding: "8px",
              }}
            >
              <Search size={24} strokeWidth={2} />
            </button>
          </header>

          {detailPreviewVideo && detailPreviewStyle
            ? renderDetailMovingLayer(detailPreviewVideo, detailPreviewStyle, true)
            : null}
          {renderDetailMovingLayer(activeVideo, detailMovableStyle)}

          <div
            className={`cp-douyin-video-commentbar${isOwnWorkDetail ? " cp-douyin-video-commentbar--owner" : ""}`}
          >
            {isOwnWorkDetail ? (
              <>
                <button type="button" className="cp-douyin-video-owner-action cp-douyin-video-owner-action--views">
                  <span>{hasCount(ownerViewCount) ? `${formatCount(ownerViewCount)}人浏览` : "浏览"}</span>
                  <ChevronLeft className="cp-douyin-video-owner-action-icon" size={13} strokeWidth={2.6} />
                </button>
                <button type="button" className="cp-douyin-video-owner-action cp-douyin-video-owner-action--analysis">
                  <span>视频分析</span>
                  <ChevronLeft className="cp-douyin-video-owner-action-icon" size={13} strokeWidth={2.6} />
                </button>
                <button type="button" className="cp-douyin-video-owner-action cp-douyin-video-owner-action--public">
                  <span>公开</span>
                </button>
              </>
            ) : (
              <>
              <button type="button" className="cp-douyin-video-comment-input" onClick={() => setCommentsOpen(true)}>
                <span>期待你的评论</span>
                <ImageIcon size={19} strokeWidth={2.4} />
                <AtSign size={20} strokeWidth={2.4} />
                <Smile size={20} strokeWidth={2.4} />
              </button>
              <button type="button" className="cp-douyin-video-share-daily">
                转发到日常
              </button>
              </>
            )}
          </div>

          {commentsOpen && (
            <div className="cp-douyin-comment-sheet" role="dialog" aria-modal="true" aria-label="评论">
              <div className="cp-douyin-comment-sheet-actions">
                <button type="button" aria-label="全屏评论">
                  <Maximize2 size={18} strokeWidth={2.2} />
                </button>
                <button type="button" aria-label="关闭评论" onClick={() => setCommentsOpen(false)}>
                  <X size={24} strokeWidth={2.2} />
                </button>
              </div>
              <div className="cp-douyin-comment-sheet-title">
                {formatCount(activeVideo.commentCount ?? activeVideo.comments.length)} 条评论
              </div>
              <div className="cp-douyin-comment-sheet-list">
                {activeVideoComments.length > 0 ? (
                  activeVideoComments.map((comment, index) => {
                    const isReply = Boolean(comment.replyToCommentId || comment.replyTo);
                    const commentAuthor = resolveDouyinDisplayName(comment.authorName);
                    const replyTo = resolveDouyinDisplayName(comment.replyTo);
                    return (
                    <article
                      key={comment.id}
                      className={`cp-douyin-sheet-comment${isReply ? " cp-douyin-sheet-comment--reply" : ""}`}
                    >
                      <div className={`cp-douyin-sheet-avatar cp-douyin-sheet-avatar--${(index % 4) + 1}`}>
                        {commentAuthor.slice(0, 1)}
                      </div>
                      <div className="cp-douyin-sheet-comment-main">
                        <strong>
                          {commentAuthor}
                          {replyTo ? <span>回复 {replyTo}</span> : null}
                        </strong>
                        <p><CheckPhoneBilingualText text={comment.text} tone="douyin" variant="inline" /></p>
                        <div>
                          <span>{formatVideoTime(comment.createdAt)}</span>
                          <button type="button">回复</button>
                        </div>
                      </div>
                      <button type="button" className="cp-douyin-sheet-like" aria-label="喜欢评论">
                        <Heart size={22} strokeWidth={2.1} />
                        {index % 3 === 0 ? <span>{index + 2}</span> : null}
                      </button>
                    </article>
                    );
                  })
                ) : (
                  <div className="cp-douyin-comment-empty">还没有评论</div>
                )}
              </div>
              <div className="cp-douyin-sheet-inputbar">
                <button type="button">
                  <span>期待你的评论</span>
                  <ImageIcon size={19} strokeWidth={2.4} />
                  <AtSign size={20} strokeWidth={2.4} />
                  <Smile size={20} strokeWidth={2.4} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}


      {error ? (
        <CheckPhoneDebugErrorCard
          error={error}
          debugRawOutput={debugRawOutput}
          debugSanitizedOutput={debugSanitizedOutput}
          debugParseError={debugParseError}
          debugNormalizeError={debugNormalizeError}
        />
      ) : null}

      {confirmClearOpen && (
        <ConfirmDialog
          title="清空抖音内容？"
          message="确认后会清空当前抖音缓存。之后重新刷新时，不会再带入旧抖音内容。"
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
