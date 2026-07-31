"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Menu, ArrowUp, Square, UserRound, MessageSquareText, Clock3, Sparkles, Eye, EyeOff, Paintbrush, X } from "lucide-react";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Avatar } from "@/components/ui/primitives";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";
import { loadCharacters } from "@/lib/character-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { incrementEventCounter } from "@/lib/memory-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
  generateStoryCompletion,
  getStoryRenderSignature,
  rebuildStorySessionRenderCache,
} from "@/lib/story-engine";
import {
  createOrGetStorySession,
  hydrateStoryStorage,
  loadStoryMessages,
  loadStorySessions,
  pushStoryMessage,
  deleteStoryMessage,
  deleteStoryMessagesFrom,
  editStoryMessage,
  type StoryMessage,
  type StorySession,
  updateStorySession,
} from "@/lib/story-storage";
import { scopeSessionCSS } from "@/lib/css-scoper";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { applyEditOutputRegex } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";

type StoryAppProps = {
  onClose: () => void;
};

type StoryGenerationRun = {
  runId: string;
  controller: AbortController;
};

const activeStoryGenerationRuns = new Map<string, StoryGenerationRun>();

function createStoryGenerationRun(sessionId: string): StoryGenerationRun {
  activeStoryGenerationRuns.get(sessionId)?.controller.abort();
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController(),
  };
  activeStoryGenerationRuns.set(sessionId, run);
  return run;
}

function isStoryGenerationRunActive(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishStoryGenerationRun(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run || run.runId !== runId) return false;
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function cancelStoryGenerationRun(sessionId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  return false;
}

function formatStoryTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CSS_EXAMPLE = STORY_CSS_EXAMPLE;
const STORY_THEMES = [
  { id: "paper", color: "#94a3b8", name: "纸白" },
  { id: "warm", color: "#b89870", name: "手账" },
  { id: "night", color: "#3a4560", name: "夜读" },
  { id: "ink", color: "#1a1a1a", name: "水墨" },
  { id: "rose", color: "#d4889a", name: "玫瑰" },
  { id: "sage", color: "#7a9a6a", name: "青苔" },
] as const;

function getStoryPreview(messages: StoryMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "从这里开始新的剧情。";
  const source = last.renderedContent || last.rawContent;
  // Strip HTML tags and collapse whitespace for preview text
  const text = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "继续上次的场景。";
}

function resizeStoryComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

type StoryComposerAppendRequest = {
  id: number;
  text: string;
};

const STORY_GENERATION_STATUS = ["整理场景", "续写剧情", "打磨对白", "写入故事"];
const STORY_INITIAL_LOAD = 10;
const STORY_LOAD_MORE_COUNT = 10;

function StoryGeneratingIndicator({
  characterName,
  avatar,
  hideAvatar,
  hideTimestamp,
  hideBubble,
}: {
  characterName: string;
  avatar?: string;
  hideAvatar: boolean;
  hideTimestamp: boolean;
  hideBubble: boolean;
}) {
  const [statusIndex, setStatusIndex] = useState(0);
  const status = STORY_GENERATION_STATUS[statusIndex % STORY_GENERATION_STATUS.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStatusIndex((index) => (index + 1) % STORY_GENERATION_STATUS.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="story-row" data-role="assistant" data-hide-bubble={hideBubble ? "true" : undefined}>
      {!hideAvatar ? (
        <div className="story-avatar-wrap">
          <Avatar src={avatar || undefined} name={characterName} size="md" />
        </div>
      ) : null}
      <div className="story-bubble-wrap">
        {(!hideAvatar || !hideTimestamp) ? (
          <div className="story-bubble-head">
            {!hideAvatar ? <span>{characterName}</span> : null}
            {!hideAvatar && !hideTimestamp ? <span className="story-generating-head">{status}</span> : null}
          </div>
        ) : null}
        <div className="story-bubble story-generating-bubble" aria-label="正在生成剧情">
          <span className="story-generating-copy">{status}</span>
          <span className="story-generating-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </article>
  );
}

const StoryComposer = memo(function StoryComposer({
  characterName,
  isGenerating,
  appendRequest,
  onSend,
  onStop,
}: {
  characterName: string;
  isGenerating: boolean;
  appendRequest: StoryComposerAppendRequest | null;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAppendIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!appendRequest || appendRequest.id === lastAppendIdRef.current) return;
    lastAppendIdRef.current = appendRequest.id;
    setDraft(prev => prev + appendRequest.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  }, [appendRequest]);

  const submit = () => {
    if (isGenerating) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeStoryComposerTextarea(textarea);
    });
    onSend(text);
  };

  return (
    <div className="story-composer">
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onFocus={(event) => resizeStoryComposerTextarea(event.currentTarget)}
        onChange={(event) => {
          setDraft(event.target.value);
          resizeStoryComposerTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={`以你和“${characterName}”为主角继续这一段剧情……`}
      />
      <button
        className={`story-send-btn${isGenerating ? " is-generating" : ""}`}
        onClick={submit}
        aria-label={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        title={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        disabled={!isGenerating && !draft.trim()}
      >
        {isGenerating ? <Square size={17} /> : <ArrowUp className="story-send-icon" size={18} />}
      </button>
    </div>
  );
});

export function StoryApp({ onClose }: StoryAppProps) {
  const [ready, setReady] = useState(false);
  const [, setStorageVersion] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCharacterId, setActiveCharacterId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<StoryMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(STORY_INITIAL_LOAD);
  const [composerAppendRequest, setComposerAppendRequest] = useState<StoryComposerAppendRequest | null>(null);
  const [customCssDraft, setCustomCssDraft] = useState("");
  const [foldTagsDraft, setFoldTagsDraft] = useState("");
  const [contextExcludedTagsDraft, setContextExcludedTagsDraft] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [dragStartX, setDragStartX] = useState<number | null>(null);
  const [dragDeltaX, setDragDeltaX] = useState(0);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellInnerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const activeSessionIdRef = useRef("");
  const cacheRefreshKeyRef = useRef<string | null>(null);
  const composerAppendIdRef = useRef(0);
  const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(
    () => resolveUserIdentity(activeCharacterId, "story") ?? resolveUserIdentity(activeCharacterId) ?? resolveUserIdentity(),
    [activeCharacterId]
  );
  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId) || null,
    [characters, activeCharacterId]
  );
  const sessions = loadStorySessions();
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const uiPrefs = currentSession?.uiPrefs || {};

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeSessionIdRef.current) {
        cancelStoryGenerationRun(activeSessionIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    hydrateStoryStorage().then(() => {
      const initialChar = loadCharacters()[0]?.id || "";
      if (initialChar) {
        const session = createOrGetStorySession(initialChar);
        setActiveCharacterId(initialChar);
        setActiveSessionId(session.id);
        setVisibleMessageCount(STORY_INITIAL_LOAD);
        setMessages(loadStoryMessages(session.id));
        setCustomCssDraft(session.customCSS || "");
        setFoldTagsDraft(session.foldTags ?? "think,thinking");
        setContextExcludedTagsDraft(session.contextExcludedTags ?? "think,thinking");
        setStorageVersion((value) => value + 1);
      }
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!activeCharacterId) return;
    const session = createOrGetStorySession(activeCharacterId);
    setActiveSessionId(session.id);
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(session.id));
    setCustomCssDraft(session.customCSS || "");
    setFoldTagsDraft(session.foldTags ?? "think,thinking");
    setContextExcludedTagsDraft(session.contextExcludedTags ?? "think,thinking");
    setStorageVersion((value) => value + 1);
  }, [activeCharacterId]);

  // Listen for live CSS updates from 小卷
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === activeSessionId) {
        setCustomCssDraft(detail.css || "");
      }
    };
    window.addEventListener("story-session-css-updated", onCSSUpdate);
    return () => window.removeEventListener("story-session-css-updated", onCSSUpdate);
  }, [activeSessionId]);

  const autoBottomLockRef = useRef(true);
  const foldToggleSuppressUntilRef = useRef(0);
  // 段落编辑期间：贴底锁必须关掉，否则编辑框自适应高度每次变化都会被
  // ResizeObserver 拽到底部（表现为"一打字就滚到底"）
  const editingMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingMessageIdRef.current = editingMessageId;
    if (editingMessageId) autoBottomLockRef.current = false;
  }, [editingMessageId]);
  // 编辑草稿放 ref、textarea 非受控：逐键 setState 会让 React 回写 value，
  // 中文输入法下 iOS 会光标错位；逐键改 style.height 又会触发 iOS 自动滚动。
  // 高度自适应改由纯 CSS 镜像（.story-grow-wrap::after）完成，打字零 JS 干预。
  const editingDraftRef = useRef("");
  const scrollStoryToBottom = useCallback(() => {
    if (editingMessageIdRef.current) return; // 段落编辑期间任何路径都不允许自动贴底
    const node = scrollRef.current;
    if (!node) return;
    const prevBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.style.scrollBehavior = prevBehavior;
      });
    });
  }, []);

  // Keep the reader at the latest story entry on entry/session switch/message append.
  const prevMsgCountRef = useRef(0);
  const prevScrollSessionRef = useRef("");
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = prevScrollSessionRef.current !== activeSessionId;
    const shouldStickToBottom = sessionChanged || messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0;
    prevScrollSessionRef.current = activeSessionId;
    prevMsgCountRef.current = messages.length;
    if (!shouldStickToBottom) return;

    autoBottomLockRef.current = true;
    scrollStoryToBottom();
    const timers = [80, 300, 800, 1600].map((delay) => (
      setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay)
    ));
    return () => timers.forEach(clearTimeout);
  }, [messages.length, activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.querySelector(".story-stage-inner");
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (performance.now() < foldToggleSuppressUntilRef.current) return;
      if (editingMessageIdRef.current) return; // 编辑中不自动贴底
      if (!autoBottomLockRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollStoryToBottom);
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const handleToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (!node.contains(target)) return;
      if (!target.matches(".story-fold-block, .story-summary-fold")) return;
      foldToggleSuppressUntilRef.current = performance.now() + 500;
      autoBottomLockRef.current = false;
    };
    node.addEventListener("toggle", handleToggle, true);
    return () => node.removeEventListener("toggle", handleToggle, true);
  }, [activeSessionId]);

  const currentPreview = useMemo(() => getStoryPreview(messages), [messages]);
  const visibleMessages = useMemo(() => {
    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);
  const hasMoreMessages = visibleMessages.length < messages.length;

  const loadMoreMessages = useCallback(() => {
    if (!hasMoreMessages) return;
    const node = scrollRef.current;
    if (node) {
      loadMoreRestoreRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    setVisibleMessageCount((count) => Math.min(count + STORY_LOAD_MORE_COUNT, messages.length));
  }, [hasMoreMessages, messages.length]);

  useLayoutEffect(() => {
    const restore = loadMoreRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    node.scrollTop = restore.scrollTop + (node.scrollHeight - restore.scrollHeight);
    loadMoreRestoreRef.current = null;
  }, [visibleMessages.length]);

  const handleOptionSelect = useCallback((text: string) => {
    composerAppendIdRef.current += 1;
    setComposerAppendRequest({ id: composerAppendIdRef.current, text });
  }, []);

  // Close context menu when clicking outside (delay to avoid the opening tap closing it)
  useEffect(() => {
    if (!activeMessageId) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".story-ctx-menu")) {
        setActiveMessageId(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler, true);
    }, 300);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [activeMessageId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!ready || !activeCharacterId || !currentSession || isGenerating) return;

    const activeAssistantMessages = messages.filter((message) => message.role === "assistant");
    if (activeAssistantMessages.length === 0) return;

    const { regexSignature, parserVersion } = getStoryRenderSignature(activeCharacterId);
    const hasStaleMessage = activeAssistantMessages.some((message) => (
      !message.renderedContent
      || message.regexSignature !== regexSignature
      || message.parserVersion !== parserVersion
    ));
    if (!hasStaleMessage) return;

    const refreshKey = `${activeCharacterId}:${currentSession.id}`;
    if (cacheRefreshKeyRef.current === refreshKey) return;
    cacheRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const runRefresh = () => {
      if (cancelled) return;
      const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
      if (cancelled) return;
      if (activeSessionIdRef.current === currentSession.id) {
        setMessages(rebuilt);
      }
      setStorageVersion((value) => value + 1);
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runRefresh, { timeout: 700 });
    } else {
      timeoutId = globalThis.setTimeout(runRefresh, 80) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (idleId != null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };
  }, [ready, activeCharacterId, currentSession, messages, isGenerating]);

  function applySessionUpdates(updates: Partial<StorySession>) {
    if (!currentSession) return;
    const next = updateStorySession(currentSession.id, updates);
    if (!next) return;
    setCustomCssDraft(next.customCSS || "");
    setFoldTagsDraft(next.foldTags ?? "think,thinking");
    setContextExcludedTagsDraft(next.contextExcludedTags ?? "think,thinking");
    setStorageVersion((value) => value + 1);
  }

  async function handleSend(userTextInput: string) {
    const userText = userTextInput.trim();
    if (!activeSessionId || !userText || isGenerating) return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;

    const userMessage = pushStoryMessage({
      sessionId,
      role: "user",
      rawContent: userText,
      renderedContent: userText,
    });
    setMessages((prev) => [...prev, userMessage]);
    setStorageVersion((value) => value + 1);
    setIsGenerating(true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);

    try {
      const historyForGeneration = loadStoryMessages(sessionId);
      const result = await generateStoryCompletion(characterId, historyForGeneration, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages((prev) => [...prev, assistantMessage]);
      }
      setStorageVersion((value) => value + 1);

      const storyCharacter = characters.find((character) => character.id === characterId);
      if (storyCharacter) {
        void (async () => {
          try {
            incrementEventCounter(characterId);
            incrementEventCounter(characterId);
            await maybeRunSummarization(characterId, storyCharacter.name);
          } catch (err) {
            console.warn("[StoryApp] Memory counter/summarization failed:", err);
          }
        })();
      }
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "剧情生成失败，请稍后再试。";
      const systemMessage = pushStoryMessage({
        sessionId,
        role: "system",
        rawContent: errText,
        renderedContent: errText,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages((prev) => [...prev, systemMessage]);
      }
      setStorageVersion((value) => value + 1);
    } finally {
      if (!finishStoryGenerationRun(sessionId, generationRunId)) return;
      setIsGenerating(false);
    }
  }

  function handleDrawerToggle(key: keyof NonNullable<StorySession["uiPrefs"]>) {
    if (!currentSession) return;
    applySessionUpdates({
      uiPrefs: {
        ...uiPrefs,
        [key]: !uiPrefs[key],
      },
    });
  }

  function handleStopGeneration() {
    if (!activeSessionId) return;
    const cancelled = cancelStoryGenerationRun(activeSessionId);
    if (!cancelled && !isGenerating) return;
    setIsGenerating(false);
  }

  function handleTouchStart(clientX: number) {
    setDragStartX(clientX);
    setDragDeltaX(0);
  }

  function handleTouchMove(clientX: number) {
    if (dragStartX == null) return;
    setDragDeltaX(clientX - dragStartX);
  }

  function handleTouchEnd() {
    if (dragStartX == null) return;
    // 从右边缘向左滑打开
    const screenW = typeof window !== "undefined" ? window.innerWidth : 400;
    if (!drawerOpen && dragStartX > screenW - 32 && dragDeltaX < -54) {
      setDrawerOpen(true);
    }
    // 向右滑关闭
    if (drawerOpen && dragDeltaX > 54) {
      setDrawerOpen(false);
    }
    setDragStartX(null);
    setDragDeltaX(0);
  }

  // ── Long-press & context menu handlers ──
  function getClampedContextMenuPoint(clientX: number, clientY: number) {
    if (typeof window === "undefined") return { x: clientX, y: clientY };
    const menuHalfWidth = 112;
    const menuHeight = 96;
    return {
      x: Math.min(Math.max(clientX, menuHalfWidth), window.innerWidth - menuHalfWidth),
      y: Math.min(Math.max(clientY + 12, 16), window.innerHeight - menuHeight),
    };
  }

  function handleMsgPointerDown(e: React.PointerEvent, msgId: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Don't preventDefault — it blocks clicks on <details>, <summary>, <input> etc. inside messages
    startPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      const point = startPosRef.current ?? { x: e.clientX, y: e.clientY };
      setContextMenuPoint(getClampedContextMenuPoint(point.x, point.y));
      setActiveMessageId(msgId);
      longPressTimerRef.current = null;
    }, 500);
  }
  function handleMsgPointerMove(e: React.PointerEvent) {
    if (!startPosRef.current) return;
    if (Math.abs(e.clientX - startPosRef.current.x) > 10 || Math.abs(e.clientY - startPosRef.current.y) > 10) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
  }
  function handleMsgPointerUp(e: React.PointerEvent) {
    startPosRef.current = null;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (longPressTriggeredRef.current) { e.stopPropagation(); e.preventDefault(); longPressTriggeredRef.current = false; }
  }
  function handleMsgPointerCancel() {
    startPosRef.current = null; longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  function handleStoryDelete(msgId: string) {
    deleteStoryMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryDeleteFrom(msgId: string) {
    deleteStoryMessagesFrom(activeSessionId, msgId);
    setMessages(prev => { const idx = prev.findIndex(m => m.id === msgId); return idx >= 0 ? prev.slice(0, idx) : prev; });
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryEditStart(msg: StoryMessage) {
    setEditingMessageId(msg.id);
    setEditingContent(msg.rawContent); // 仅作为非受控 textarea 的初始值
    editingDraftRef.current = msg.rawContent;
    setActiveMessageId(null);
  }
  function handleStoryEditSave() {
    const draft = editingDraftRef.current;
    if (!editingMessageId || !draft.trim()) { setEditingMessageId(null); setEditingContent(""); return; }
    let newRawContent = draft.trim();
    // Apply runOnEdit regex rules (placement=2, isEdit=true) to the edited content.
    try {
      const { regexes } = getStoryRenderSignature(activeCharacterId);
      if (regexes.length > 0) {
        const macroEngine = new MacroEngine(currentCharacter?.name ?? "", userIdentity?.name ?? "用户");
        newRawContent = applyEditOutputRegex(newRawContent, regexes, { macroEngine, activeTags: ["story"] });
      }
    } catch {
      // If regex resolution fails, proceed with unmodified content
    }
    editStoryMessage(editingMessageId, newRawContent);
    setMessages(prev => prev.map(m => m.id === editingMessageId
      ? { ...m, rawContent: newRawContent, renderedContent: undefined, regexSignature: undefined, parserVersion: undefined }
      : m
    ));
    setEditingMessageId(null);
    setEditingContent("");
    setStorageVersion(v => v + 1);
  }
  function handleStoryCopy(text: string) {
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(fallbackCopy); }
    else { fallbackCopy(); }
    setActiveMessageId(null);
  }
  async function handleStoryRetry(msgId: string) {
    const msgIndex = messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;
    const retryMessage = messages[msgIndex];
    if (retryMessage.role !== "assistant" && retryMessage.role !== "user") return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const contextMessages = retryMessage.role === "user"
      ? messages.slice(0, msgIndex + 1)
      : messages.slice(0, msgIndex);
    const firstDiscardedMessage = messages[contextMessages.length];
    if (firstDiscardedMessage) {
      deleteStoryMessagesFrom(activeSessionId, firstDiscardedMessage.id);
    }
    setMessages(contextMessages);
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
    setIsGenerating(true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);
    try {
      const result = await generateStoryCompletion(characterId, contextMessages, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId, role: "assistant",
        rawContent: result.rawText, renderedContent: result.renderedText,
        storySummary: result.storySummary, regexSignature: result.regexSignature, parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) setMessages(prev => [...prev, assistantMessage]);
      setStorageVersion(v => v + 1);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "重试失败，请稍后再试。";
      const systemMessage = pushStoryMessage({ sessionId, role: "system", rawContent: errText, renderedContent: errText });
      if (activeSessionIdRef.current === sessionId) setMessages(prev => [...prev, systemMessage]);
      setStorageVersion(v => v + 1);
    } finally {
      if (!finishStoryGenerationRun(sessionId, generationRunId)) return;
      setIsGenerating(false);
    }
  }

  if (!ready) return null;

  if (characters.length === 0) {
    return (
      <div className="story-app-shell" data-story-theme="paper">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                  <ArrowLeft size={16} />
                </button>
              </div>
              <div className="story-header-center">Story</div>
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-stage story-stage-empty">
            <div className="story-stage-inner">
              <div className="story-empty story-empty-panel">
                <Sparkles size={28} opacity={0.5} />
                <div>
                  <div className="story-empty-title">还没有角色卡</div>
                  <div className="story-empty-desc">请先创建或导入角色卡，再进入剧情 APP 开始故事。</div>
                </div>
                <button className="story-empty-action" onClick={onClose}>
                  返回
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentCharacter || !currentSession) return null;

  const sessionScope = `.story-session-${currentSession.id}`;

  return (
    <div
      className={`story-app-shell story-session-${currentSession.id}`}
      data-story-theme={uiPrefs.theme || "paper"}
      onTouchStart={(event) => handleTouchStart(event.touches[0]?.clientX || 0)}
      onTouchMove={(event) => handleTouchMove(event.touches[0]?.clientX || 0)}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(event) => handleTouchStart(event.clientX)}
      onMouseMove={(event) => {
        if (dragStartX != null) handleTouchMove(event.clientX);
      }}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {/* Styles moved to styles/story.css */}
      {currentSession.customCSS ? (
        <style dangerouslySetInnerHTML={{ __html: scopeSessionCSS(currentSession.customCSS, sessionScope) }} />
      ) : null}

      {drawerOpen ? <div className="story-drawer-overlay" onClick={() => setDrawerOpen(false)} /> : null}
      <aside className="story-drawer" style={{ transform: drawerOpen ? "translateX(0)" : "translateX(106%)", transition: "transform 220ms ease" }}>
        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">剧情角色</div>
          <div className="story-character-list">
            {characters.map((character) => {
              const session = createOrGetStorySession(character.id);
              const sessionMessages = loadStoryMessages(session.id);
              return (
                <button
                  key={character.id}
                  className="story-character-chip"
                  data-active={character.id === activeCharacterId ? "true" : undefined}
                  onClick={() => {
                    setActiveCharacterId(character.id);
                    setDrawerOpen(false);
                  }}
                >
                  <Avatar src={character.avatar || undefined} name={character.name} size="md" />
                  <div className="text-left" style={{ minWidth: 0, overflow: "hidden", flex: 1 }}>
                    <div className="font-semibold text-[var(--c-story-text,#4b4335)] truncate">{character.name}</div>
                    <div className="text-[calc(12px*var(--app-text-scale,1))] text-[var(--c-story-sub,rgba(95,82,61,0.72))] truncate">
                      {getStoryPreview(sessionMessages)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">显示选项</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => handleDrawerToggle("hideBubble")}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "10px 0", borderRadius: 12, border: "1px solid var(--c-story-panel-border, rgba(0,0,0,0.04))", background: uiPrefs.hideBubble ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))", fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-text, #3a3b3c)" }}
            >
              <MessageSquareText size={18} opacity={uiPrefs.hideBubble ? 0.4 : 1} />
              <span>气泡</span>
              {uiPrefs.hideBubble ? <EyeOff size={12} opacity={0.4} /> : <Eye size={12} opacity={0.6} />}
            </button>
            <button
              onClick={() => handleDrawerToggle("hideAvatar")}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "10px 0", borderRadius: 12, border: "1px solid var(--c-story-panel-border, rgba(0,0,0,0.04))", background: uiPrefs.hideAvatar ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))", fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-text, #3a3b3c)" }}
            >
              <UserRound size={18} opacity={uiPrefs.hideAvatar ? 0.4 : 1} />
              <span>头像</span>
              {uiPrefs.hideAvatar ? <EyeOff size={12} opacity={0.4} /> : <Eye size={12} opacity={0.6} />}
            </button>
            <button
              onClick={() => handleDrawerToggle("hideTimestamp")}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "10px 0", borderRadius: 12, border: "1px solid var(--c-story-panel-border, rgba(0,0,0,0.04))", background: uiPrefs.hideTimestamp ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))", fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-text, #3a3b3c)" }}
            >
              <Clock3 size={18} opacity={uiPrefs.hideTimestamp ? 0.4 : 1} />
              <span>时间</span>
              {uiPrefs.hideTimestamp ? <EyeOff size={12} opacity={0.4} /> : <Eye size={12} opacity={0.6} />}
            </button>
          </div>
          <div style={{ padding: "10px 0", borderBottom: "1px solid var(--c-story-drawer-border, rgba(124, 104, 68, 0.08))" }}>
            <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))", display: "block", marginBottom: 6 }}>
              折叠标签
            </label>
            <input
              type="text"
              value={foldTagsDraft}
              onChange={(e) => setFoldTagsDraft(e.target.value)}
              onBlur={() => applySessionUpdates({ foldTags: foldTagsDraft.trim() || undefined })}
              placeholder="think,thinking"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 12px", borderRadius: 12,
                border: "1px solid var(--c-story-panel-border, rgba(139, 120, 94, 0.14))",
                background: "var(--c-story-css-box-bg, rgba(255, 251, 246, 0.88))",
                color: "var(--c-story-text, #4b4335)",
                font: "calc(13px*var(--app-text-scale,1))/1.6 inherit",
              }}
            />
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", marginTop: 4, color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))" }}>
              逗号分隔标签名，如 think,thinking,reasoning
            </div>
          </div>
          <div style={{ padding: "10px 0", borderBottom: "1px solid var(--c-story-drawer-border, rgba(124, 104, 68, 0.08))" }}>
            <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))", display: "block", marginBottom: 6 }}>
              不进上下文标签
            </label>
            <input
              type="text"
              value={contextExcludedTagsDraft}
              onChange={(e) => setContextExcludedTagsDraft(e.target.value)}
              onBlur={() => applySessionUpdates({ contextExcludedTags: contextExcludedTagsDraft.trim() || undefined })}
              placeholder="think,thinking"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 12px", borderRadius: 12,
                border: "1px solid var(--c-story-panel-border, rgba(139, 120, 94, 0.14))",
                background: "var(--c-story-css-box-bg, rgba(255, 251, 246, 0.88))",
                color: "var(--c-story-text, #4b4335)",
                font: "calc(13px*var(--app-text-scale,1))/1.6 inherit",
              }}
            />
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", marginTop: 4, color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))" }}>
              默认 think,thinking；影响后续生成上下文，不影响显示与保存
            </div>
          </div>
        </div>

        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">工具</div>
          <button
            className="story-character-chip justify-center"
            onClick={() => {
              const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
              setMessages(rebuilt);
              setStorageVersion((value) => value + 1);
              alert(`缓存重建完成，${rebuilt.length} 条消息已更新`);
            }}
          >
            重建渲染缓存
          </button>
        </div>
      </aside>

      <div className="story-shell-inner" ref={shellInnerRef}>

        {/* ====== 固定顶部标题栏 ====== */}
        <div className="story-header">
          <div className="story-header-safe-area" />
          <div className="story-header-content">
            <div className="story-header-left">
              <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                <ArrowLeft size={16} />
              </button>
            </div>
            <div className="story-header-center">Story</div>
            <div className="story-header-right" style={{ gap: 8 }}>
              <button className="story-top-btn" onClick={() => setCssModalOpen(true)} aria-label="页面样式">
                <Paintbrush size={16} />
              </button>
              <button className="story-top-btn" onClick={() => setDrawerOpen(true)} aria-label="打开剧情侧栏">
                <Menu size={16} />
              </button>
            </div>
          </div>
        </div>

        <div
          className="story-stage"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            if (performance.now() < foldToggleSuppressUntilRef.current) return;
            const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
            autoBottomLockRef.current = distanceFromBottom <= 12;
          }}
        >
          <div className="story-stage-inner">
            
            {/* ====== 顶部信息阅读卡片 ====== */}
            <div className="story-meta">
              <div className="story-meta-layout">
                <div className="story-meta-cover">
                  {currentCharacter.avatar ? (
                    <img src={currentCharacter.avatar} alt="cover" />
                  ) : (
                    <div style={{ width: "100%", height: "100%", background: "var(--c-story-accent, #94a3b8)", opacity: 0.2 }} />
                  )}
                </div>
                <div className="story-meta-body">
                  <div className="story-meta-title">本次阅读：《 {currentCharacter.name} 》</div>
                  <div className="story-meta-tags">
                    {userIdentity?.name || "我"} x {currentCharacter.name}
                  </div>
                  <div className="story-meta-desc">
                    {/* Character type might not have description, so we use a stylized default text */}
                    “有些故事，在开始之前就已经写好了结局。”
                  </div>
                </div>
              </div>
            </div>

            {messages.length === 0 ? (
              <div className="story-empty">
                <Sparkles size={26} opacity={0.5} />
                <div>
                  <div className="text-[calc(14px*var(--app-text-scale,1))] font-medium text-[var(--c-story-heading,#1e293b)] mb-1">故事从这里开始</div>
                  <div className="text-[calc(12px*var(--app-text-scale,1))] opacity-70">从底部输入一段引导，剧情会继续展开。</div>
                </div>
              </div>
            ) : (
              <>
                {hasMoreMessages ? (
                  <button
                    type="button"
                    className="story-load-more-btn"
                    onClick={loadMoreMessages}
                  >
                    <span>查看更多消息</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                ) : null}
                {visibleMessages.map((message) => {
                  const speakerName = message.role === "user"
                    ? (userIdentity?.name?.trim() || "我")
                    : message.role === "assistant"
                      ? currentCharacter.name
                      : "系统";
                  const avatarUrl = message.role === "user"
                    ? (userIdentity?.avatarUrl || undefined)
                    : message.role === "assistant"
                      ? (currentCharacter.avatar || undefined)
                      : undefined;
                  return (
                    <article
                      key={message.id}
                      className="story-row"
                      data-role={message.role}
                      data-hide-bubble={uiPrefs.hideBubble ? "true" : undefined}
                      onPointerDown={(e) => handleMsgPointerDown(e, message.id)}
                      onPointerMove={handleMsgPointerMove}
                      onPointerUp={handleMsgPointerUp}
                      onPointerCancel={handleMsgPointerCancel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenuPoint(getClampedContextMenuPoint(e.clientX, e.clientY));
                        setActiveMessageId(message.id);
                      }}
                    >
                      {!uiPrefs.hideAvatar ? (
                        <div className="story-avatar-wrap">
                          <Avatar src={avatarUrl} name={speakerName} size="md" />
                        </div>
                      ) : null}
                      <div className="story-bubble-wrap" style={{ position: "relative" }}>
                        {(!uiPrefs.hideAvatar || !uiPrefs.hideTimestamp) ? (
                          <div className="story-bubble-head">
                            {!uiPrefs.hideAvatar ? <span>{speakerName}</span> : null}
                            {!uiPrefs.hideTimestamp ? <span>{formatStoryTime(message.createdAt)}</span> : null}
                          </div>
                        ) : null}
                        <div className="story-bubble">
                          {editingMessageId === message.id ? (
                            <div className="story-inline-edit">
                              <div className="story-grow-wrap" data-value={editingContent}>
                                <textarea
                                  autoFocus
                                  defaultValue={editingContent}
                                  onInput={(e) => {
                                    const el = e.currentTarget;
                                    editingDraftRef.current = el.value;
                                    const wrap = el.parentElement;
                                    if (wrap) wrap.dataset.value = el.value;
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleStoryEditSave(); }
                                    if (e.key === "Escape") { setEditingMessageId(null); setEditingContent(""); }
                                  }}
                                />
                              </div>
                              <div className="story-inline-edit-actions">
                                <button onClick={() => { setEditingMessageId(null); setEditingContent(""); }} className="story-inline-edit-btn">取消</button>
                                <button onClick={handleStoryEditSave} className="story-inline-edit-btn story-inline-edit-btn-save">保存</button>
                              </div>
                            </div>
                          ) : (
                            <StoryHtmlRenderer
                              content={message.renderedContent || message.rawContent}
                              messageId={message.id}
                              onOptionSelect={handleOptionSelect}
                            />
                          )}
                        </div>
                        {activeMessageId === message.id && (() => {
                          const menu = (
                            <div
                              className="story-ctx-menu"
                              style={contextMenuPoint ? { left: contextMenuPoint.x, top: contextMenuPoint.y } : undefined}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryCopy(message.rawContent)} className="story-ctx-btn">复制</button>
                                <button onClick={() => handleStoryEditStart(message)} className="story-ctx-btn">编辑</button>
                                {(message.role === "assistant" || message.role === "user") && (
                                  <button onClick={() => { void handleStoryRetry(message.id); }} className="story-ctx-btn story-ctx-btn-danger">重试</button>
                                )}
                              </div>
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryDelete(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除</button>
                                <button onClick={() => handleStoryDeleteFrom(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除以下</button>
                              </div>
                              <div className="story-ctx-triangle" />
                            </div>
                          );
                          return shellInnerRef.current ? createPortal(menu, shellInnerRef.current) : menu;
                        })()}
                      </div>
                    </article>
                  );
                })}
              </>
            )}
            {isGenerating ? (
              <StoryGeneratingIndicator
                characterName={currentCharacter.name}
                avatar={currentCharacter.avatar || undefined}
                hideAvatar={Boolean(uiPrefs.hideAvatar)}
                hideTimestamp={Boolean(uiPrefs.hideTimestamp)}
                hideBubble={Boolean(uiPrefs.hideBubble)}
              />
            ) : null}
          </div>
        </div>
      </div>

      <StoryComposer
        characterName={currentCharacter.name}
        isGenerating={isGenerating}
        appendRequest={composerAppendRequest}
        onSend={(text) => { void handleSend(text); }}
        onStop={handleStopGeneration}
      />

      {/* CSS Style Modal */}
      {cssModalOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 300,
          background: "var(--c-story-bg-top, #fdfdfd)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "52px 20px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.04)",
          }}>
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "var(--c-story-sub, #94a3b8)" }}>
              页面样式
            </span>
            <button className="story-top-btn" onClick={() => setCssModalOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
                {STORY_THEMES.map(t => {
                  const active = (uiPrefs.theme || "paper") === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-label={`切换到${t.name}主题`}
                      aria-pressed={active}
                      onClick={() => applySessionUpdates({ uiPrefs: { ...uiPrefs, theme: t.id } })}
                      style={{
                        minHeight: 54,
                        borderRadius: 12,
                        border: active ? "1px solid var(--c-story-text, #3a3b3c)" : "1px solid var(--c-story-panel-border, rgba(139, 120, 94, 0.14))",
                        background: active ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))",
                        color: "var(--c-story-text, #3a3b3c)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        padding: "7px 4px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: t.color,
                        border: active ? "2px solid var(--c-story-bg-top, #fdfdfd)" : "2px solid transparent",
                        boxShadow: active ? "0 0 0 2px var(--c-story-text, #3a3b3c)" : "0 2px 8px rgba(0,0,0,0.1)",
                      }} />
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-sub, #94a3b8)", lineHeight: 1.1 }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              className="story-css-box"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* 这里写剧情模式的 session CSS */\n.story-bubble { border-radius: 30px; }\n.story-composer { backdrop-filter: blur(24px); }`}
              style={{ flex: 1, minHeight: 280 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CSSSchemeBar target="story" currentCSS={customCssDraft} onLoad={setCustomCssDraft} btnStyle={{
                border: "1px solid var(--c-story-btn-border, rgba(0,0,0,0.08))",
                background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))",
                color: "var(--c-story-text, #3a3b3c)",
              }} modalVars={{
                panel: "var(--c-story-drawer-top, #fdfdfd)",
                border: "var(--c-story-drawer-border, rgba(0,0,0,0.06))",
                text: "var(--c-story-text, #3a3b3c)",
                textDim: "var(--c-story-sub, #94a3b8)",
                input: "var(--c-story-css-box-bg, rgba(248,250,252,0.6))",
                inputBorder: "var(--c-story-panel-border, rgba(0,0,0,0.06))",
                accent: "var(--c-story-send-bg-active, #0f172a)",
              }} />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 12,
                  border: "1px solid var(--c-story-btn-border, rgba(0,0,0,0.08))",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                加载示例
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 12,
                  border: "1px solid var(--c-story-btn-border, rgba(0,0,0,0.08))",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                清除
              </button>
              <button
                onClick={() => { applySessionUpdates({ customCSS: customCssDraft }); setCssModalOpen(false); }}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 12, border: "none",
                  background: "var(--c-story-send-bg-active, #dbe3ea)", color: "var(--c-story-send-color-active, #475569)",
                  fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
