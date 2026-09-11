"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// CommonMark 的 flanking 规则会让 **「加粗」** 这类紧贴全角标点的写法解析失败
// （** 后跟标点时要求前面是空格/标点，中文里前面通常是汉字），中文消息大量中招。
import remarkCjkFriendly from "remark-cjk-friendly";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Eye,
  FilePlus,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import {
  createCoCreateMessage,
  createDefaultCoCreateSettings,
  createCoCreateSession,
  createDefaultCoCreateSession,
  createNextCoCreateChapter,
  reindexCoCreateChapters,
  deleteCoCreateSession,
  ensureActiveCoCreateChapter,
  getActiveCoCreateChapter,
  loadCoCreateLibrary,
  saveCoCreateLibrary,
  saveCoCreateSession,
  setActiveCoCreateSession,
} from "@/lib/cocreate-storage";
import { generateCoCreateChapterAutoArchive, generateCoCreateReply, generateCoCreateSessionMemory } from "@/lib/cocreate-engine";
import {
  deleteCoCreateLongTermMemoriesBySession,
  deleteCoCreateProjectionEntriesBySession,
  recordCoCreateProjectionEvent,
} from "@/lib/cocreate-memory";
import {
  COCREATE_APP_ID,
  type CoCreateBackendLog,
  type CoCreateChapter,
  type CoCreateCastMember,
  type CoCreateLibrary,
  type CoCreateMessage,
  type CoCreateMode,
  type CoCreatePendingMutation,
  type CoCreateSession,
  type CoCreateSettings,
} from "@/lib/cocreate-types";
import {
  COCREATE_TOOL_DEFINITIONS,
  applyCoCreatePendingMutation,
  discardCoCreatePendingMutation,
  rollbackCoCreateRevision,
} from "@/lib/cocreate-tools";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { incrementEventCounter } from "@/lib/memory-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";

type CoCreateAppProps = {
  onClose: () => void;
  onNotice?: (message: string) => void;
};

type ViewMode = "library" | "write" | "characters" | "chapters" | "chapterReader";
type ChapterReaderEditTarget = "title" | "titleEn" | "content" | "summary";
type ChapterReaderExitTarget = "chapters" | "library";

type CastFormState = {
  name: string;
  role: string;
  color: string;
  major: string;
  label: string;
  desc: string;
  secret: string;
  secretHidden: boolean;
};

const CAST_COLOR_SWATCHES = ["#d4c5a0", "#94b89d", "#c87a7a", "#8fa6c9", "#b69ac7", "#888888"];
const WORK_DECORATIVE_SUBTITLE = "A COLLABORATIVE NOVEL DOSSIER";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "共创生成失败。";
}

function modeLabel(mode: CoCreateMode): string {
  return mode === "write" ? "WRITE" : "TALK";
}

function countTextWords(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function normalizeEditableText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function setEditableText(element: HTMLElement | null, text: string): void {
  if (!element) return;
  element.innerText = text;
}

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusEditableAtPoint(element: HTMLElement, point?: { x: number; y: number }): void {
  element.focus({ preventScroll: true });
  if (!point) {
    placeCaretAtEnd(element);
    return;
  }

  const docWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = document.createRange();
  const position = docWithCaret.caretPositionFromPoint?.(point.x, point.y);
  if (position && element.contains(position.offsetNode)) {
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
  } else {
    const pointRange = docWithCaret.caretRangeFromPoint?.(point.x, point.y);
    if (pointRange && element.contains(pointRange.commonAncestorContainer)) {
      range.setStart(pointRange.startContainer, pointRange.startOffset);
      range.collapse(true);
    } else {
      placeCaretAtEnd(element);
      return;
    }
  }

  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

const COCREATE_MARKDOWN_COMPONENTS = {
  a: ({ node, ...props }: any) => <a target="_blank" rel="noreferrer" {...props} />,
  table: ({ node, ...props }: any) => (
    <div className="cocreate-markdown-table">
      <table {...props} />
    </div>
  ),
} as any;

function CoCreateMarkdown({ content, className }: { content: string; className?: string }) {
  const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return null;
  return (
    <div className={`cocreate-markdown ${className ?? ""}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={COCREATE_MARKDOWN_COMPONENTS}>
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "00:00";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function buildExportText(session: CoCreateSession): string {
  const manuscript = session.chapters
    .filter((chapter) => chapter.content?.trim())
    .map((chapter) => [`## ${chapter.num}. ${chapter.title}`, chapter.content].join("\n\n"))
    .join("\n\n");
  return [`# ${session.title}`, "", manuscript].join("\n");
}

function chapterStatusLabel(chapter: CoCreateChapter): string {
  if (chapter.archivedAt) return chapter.memoryEntries && chapter.memoryEntries.length > 1 ? `DONE×${chapter.memoryEntries.length}` : "DONE";
  return "LIVE";
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function hasExportableContent(session: CoCreateSession): boolean {
  return session.chapters.some((chapter) => chapter.content?.trim());
}

function safeExportFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return cleaned || "cocreate_story";
}

function formatBackendLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return [
    `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`,
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`,
  ].join(" ");
}

function appendBackendLog(session: CoCreateSession, log: Omit<CoCreateBackendLog, "id" | "createdAt">): CoCreateSession {
  const nextLog: CoCreateBackendLog = {
    ...log,
    id: createClientId("cocreate_backend"),
    createdAt: new Date().toISOString(),
  };
  return {
    ...session,
    backendLogs: [...(session.backendLogs || []), nextLog].slice(-60),
    updatedAt: new Date().toISOString(),
  };
}

type ClearCoCreateToolHistoryResult = {
  session: CoCreateSession;
  deletedMessages: number;
  cleanedMessages: number;
};

function isCoCreateToolHistoryMessage(message: CoCreateMessage): boolean {
  return message.role === "tool"
    || message.kind === "tool"
    || message.authorName === "TOOL"
    || !!message.nativeToolResult;
}

function hasCoCreateNativeToolReplayMetadata(message: CoCreateMessage): boolean {
  return message.nativeToolCalls !== undefined
    || message.nativeToolReasoning !== undefined
    || message.nativeToolOpenRouterReasoningDetails !== undefined;
}

function hasVisibleCoCreatePayload(message: CoCreateMessage): boolean {
  return !!message.content.trim();
}

function clearCoCreateToolHistory(session: CoCreateSession): ClearCoCreateToolHistoryResult {
  let deletedMessages = 0;
  let cleanedMessages = 0;
  const messages: CoCreateMessage[] = [];

  for (const message of session.messages) {
    if (isCoCreateToolHistoryMessage(message)) {
      deletedMessages += 1;
      continue;
    }

    if (!hasCoCreateNativeToolReplayMetadata(message)) {
      messages.push(message);
      continue;
    }

    const cleaned: CoCreateMessage = { ...message };
    delete cleaned.nativeToolCalls;
    delete cleaned.nativeToolReasoning;
    delete cleaned.nativeToolOpenRouterReasoningDetails;

    if (message.role === "assistant" && !hasVisibleCoCreatePayload(cleaned)) {
      deletedMessages += 1;
      continue;
    }

    cleanedMessages += 1;
    messages.push(cleaned);
  }

  return {
    session: {
      ...session,
      messages,
      updatedAt: deletedMessages || cleanedMessages ? new Date().toISOString() : session.updatedAt,
    },
    deletedMessages,
    cleanedMessages,
  };
}

function backendLogKindLabel(kind: CoCreateBackendLog["kind"]): string {
  return kind === "archive" ? "结束章节" : "生成回复";
}

function copyTextToClipboard(text: string, onNotice?: (message: string) => void): void {
  if (!text) return;
  navigator.clipboard?.writeText(text)
    .then(() => onNotice?.("已复制。"))
    .catch(() => onNotice?.("复制失败，请长按文本手动复制。"));
}

function waitForLiveStep(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 80));
}

function waitForStreamPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function scrollPanelToBottom(panel: HTMLDivElement | null): void {
  if (!panel) return;
  window.requestAnimationFrame(() => {
    panel.scrollTop = panel.scrollHeight;
  });
}

function isCoCreateSystemStep(message: CoCreateSession["messages"][number]): boolean {
  return message.kind === "reasoning"
    || message.role === "system"
    || message.content.startsWith("动作结果返回：")
    || message.content.startsWith("正在执行：");
}

function fallbackInitial(name: string): string {
  return name.trim().slice(0, 1) || "共";
}

function pendingMutationTargetLabel(mutation: CoCreatePendingMutation): string {
  if (mutation.chapterNum || mutation.chapterTitle) {
    return `CHAPTER.${mutation.chapterNum || "--"} // ${mutation.chapterTitle || "未命名章节"}`;
  }
  const op = mutation.operation;
  if (op.type === "create_cast") return `CAST FILE // ${op.member.name}`;
  if (op.type === "set_cast") return `CAST FILE // ${op.nextMember.name}`;
  if (op.type === "delete_cast") return "CAST FILE";
  if (op.type === "set_dossier") return "DOSSIER // 人物关系档案";
  if (op.type === "set_notebook") return "NOTEBOOK // 作品笔记本";
  if (op.type === "create_chapter") return `CHAPTER.${op.chapter.num} // ${op.chapter.title}`;
  return "";
}

function createClientId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDefaultCastForm(): CastFormState {
  return {
    name: "",
    role: "",
    color: CAST_COLOR_SWATCHES[0],
    major: "",
    label: "",
    desc: "",
    secret: "",
    secretHidden: true,
  };
}

function castToForm(member: CoCreateCastMember): CastFormState {
  return {
    name: member.name,
    role: member.role,
    color: member.color,
    major: member.major,
    label: member.label,
    desc: member.desc,
    secret: member.secret || "",
    secretHidden: member.secretHidden ?? true,
  };
}

function createAutoCastCode(name: string, existing?: CoCreateCastMember): string {
  const trimmed = name.trim();
  if (existing?.name === trimmed && existing.nameEn.trim()) return existing.nameEn;
  const ascii = trimmed.match(/[A-Za-z0-9]+/g)?.join(" ").trim();
  if (ascii) return ascii.toUpperCase().slice(0, 32);
  let hash = 0;
  for (const char of trimmed || "CAST") {
    hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  }
  return `CAST-${hash.toString(36).toUpperCase().padStart(4, "0").slice(0, 4)}`;
}

function buildCastMember(form: CastFormState, existing?: CoCreateCastMember): CoCreateCastMember {
  const name = form.name.trim();
  return {
    id: existing?.id || createClientId("cocreate_cast"),
    name,
    nameEn: createAutoCastCode(name, existing),
    role: form.role.trim() || "未设定身份",
    color: form.color || CAST_COLOR_SWATCHES[0],
    major: form.major.trim() || "—",
    label: form.label.trim() || "未命名标签",
    desc: form.desc.trim() || "暂无公开设定。",
    secret: form.secret.trim() || null,
    secretHidden: form.secret.trim() ? form.secretHidden : false,
    tags: [],
  };
}

export function CoCreateApp({ onClose, onNotice }: CoCreateAppProps) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [library, setLibrary] = useState<CoCreateLibrary>({ activeSessionId: "", sessions: [], settings: createDefaultCoCreateSettings() });
  const [session, setSession] = useState<CoCreateSession>(() => createDefaultCoCreateSession());
  const [view, setView] = useState<ViewMode>("library");
  const [mode, setMode] = useState<CoCreateMode>("write");
  const [input, setInput] = useState("");
  const [writerNotebookDraft, setWriterNotebookDraft] = useState("");
  const [writerNotebookDirty, setWriterNotebookDirty] = useState(false);
  const [editingUserMessageId, setEditingUserMessageId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isDeletingWork, setIsDeletingWork] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolHistoryClearConfirmOpen, setToolHistoryClearConfirmOpen] = useState(false);
  const [backendLogOpen, setBackendLogOpen] = useState(false);
  const [newWorkOpen, setNewWorkOpen] = useState(false);
  const [newWorkTitle, setNewWorkTitle] = useState("");
  const [editingWorkId, setEditingWorkId] = useState<string | null>(null);
  const [editingWorkTitle, setEditingWorkTitle] = useState("");
  const [workDeleteTargetId, setWorkDeleteTargetId] = useState<string | null>(null);
  const [chapterDeleteTargetId, setChapterDeleteTargetId] = useState<string | null>(null);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editingChapterTitle, setEditingChapterTitle] = useState("");
  const [editingChapterTitleEn, setEditingChapterTitleEn] = useState("");
  const [editingChapterContent, setEditingChapterContent] = useState("");
  const [editingChapterSummary, setEditingChapterSummary] = useState("");
  const [chapterReaderEditing, setChapterReaderEditing] = useState(false);
  const [chapterExitConfirmOpen, setChapterExitConfirmOpen] = useState(false);
  const [chapterExitTarget, setChapterExitTarget] = useState<ChapterReaderExitTarget>("chapters");
  const [activeArchiveNoteChapterId, setActiveArchiveNoteChapterId] = useState<string | null>(null);
  const [dismissedArchiveNoteChapterId, setDismissedArchiveNoteChapterId] = useState<string | null>(null);
  const [castEditorOpen, setCastEditorOpen] = useState(false);
  const [editingCastId, setEditingCastId] = useState<string | null>(null);
  const [castDeleteTargetId, setCastDeleteTargetId] = useState<string | null>(null);
  const [castForm, setCastForm] = useState<CastFormState>(() => createDefaultCastForm());
  const [statusState, setStatusState] = useState<{ text: string; prominent?: boolean } | null>(null);
  const status = statusState?.text || null;
  const statusProminent = Boolean(statusState?.prominent);
  const setStatus = useCallback((text: string | null, opts?: { prominent?: boolean }) => {
    setStatusState(text ? { text, prominent: opts?.prominent } : null);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);
  const previousActiveChapterIdRef = useRef<string>("");
  const autoArchivingChaptersRef = useRef<Set<string>>(new Set());
  const sessionRef = useRef(session);
  const generationAbortRef = useRef<AbortController | null>(null);
  const resolvedPendingMutationIdsRef = useRef<Set<string>>(new Set());
  const readerSummaryRef = useRef<HTMLDivElement | null>(null);
  const readerTitleRef = useRef<HTMLHeadingElement | null>(null);
  const readerTitleEnRef = useRef<HTMLParagraphElement | null>(null);
  const readerBodyRef = useRef<HTMLElement | null>(null);
  const pendingReaderFocusRef = useRef<{ target: ChapterReaderEditTarget; point?: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const loadedCharacters = loadCharacters();
    const fallbackPartnerId = loadedCharacters[0]?.id || "";
    const loadedLibrary = loadCoCreateLibrary(fallbackPartnerId);
    const shouldPatchPartner = Boolean(fallbackPartnerId) && loadedLibrary.sessions.some((item) => !item.partnerCharacterId);
    const normalizedSessions = loadedLibrary.sessions.map((item) => (
      !item.partnerCharacterId && fallbackPartnerId ? { ...item, partnerCharacterId: fallbackPartnerId } : item
    ));
    const normalizedLibrary = shouldPatchPartner
      ? saveCoCreateLibrary({
        activeSessionId: loadedLibrary.activeSessionId,
        sessions: normalizedSessions,
        settings: loadedLibrary.settings,
      })
      : loadedLibrary;
    const activeSession = normalizedLibrary.sessions.find((item) => item.id === normalizedLibrary.activeSessionId)
      || normalizedLibrary.sessions[0]
      || createDefaultCoCreateSession(fallbackPartnerId);
    setCharacters(loadedCharacters);
    setLibrary(normalizedLibrary);
    setSession(activeSession);
  }, []);

  useEffect(() => {
    if (!scrollRef.current || view !== "write") return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    stickToBottomRef.current = true;
  }, [session.activeChapterId, view]);

  useEffect(() => {
    if (!scrollRef.current || view !== "write") return;
    if (!stickToBottomRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [session.messages.length, isGenerating, isArchiving, view]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distanceFromBottom < 32;
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [view]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), statusProminent ? 2600 : 3200);
    return () => window.clearTimeout(timer);
  }, [status, statusProminent, setStatus]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    resolvedPendingMutationIdsRef.current.clear();
  }, [session.id]);

  useEffect(() => {
    const previousId = previousActiveChapterIdRef.current;
    const currentId = session.activeChapterId;
    previousActiveChapterIdRef.current = currentId;
    if (!previousId || previousId === currentId) return;
    const previousChapter = session.chapters.find((chapter) => chapter.id === previousId);
    if (!previousChapter) return;
    if (!previousChapter.content?.trim()) return;
    if (previousChapter.archivedAt
      && previousChapter.updatedAt
      && previousChapter.updatedAt <= previousChapter.archivedAt) return;
    void runChapterAutoArchive(previousChapter.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.activeChapterId]);

  useEffect(() => {
    setWriterNotebookDraft(session.writerNotebook || "");
    setWriterNotebookDirty(false);
  }, [session.id, session.writerNotebook]);

  useEffect(() => {
    if (!chapterReaderEditing) return;
    setEditableText(readerTitleRef.current, editingChapterTitle);
    setEditableText(readerTitleEnRef.current, editingChapterTitleEn);
    setEditableText(readerBodyRef.current, editingChapterContent);
    setEditableText(readerSummaryRef.current, editingChapterSummary);

    window.requestAnimationFrame(() => {
      const pending = pendingReaderFocusRef.current;
      pendingReaderFocusRef.current = null;
      const target = pending?.target === "title"
        ? readerTitleRef.current
        : pending?.target === "titleEn"
          ? readerTitleEnRef.current
          : pending?.target === "summary"
            ? readerSummaryRef.current
            : readerBodyRef.current;
      if (target) focusEditableAtPoint(target, pending?.point);
    });
  }, [chapterReaderEditing, editingChapterId]);

  const partner = useMemo(
    () => characters.find((character) => character.id === session.partnerCharacterId) || null,
    [characters, session.partnerCharacterId],
  );

  const userName = useMemo(() => {
    if (!partner) return "用户";
    return resolveUserIdentity(partner.id, COCREATE_APP_ID)?.name?.trim() || "用户";
  }, [partner]);

  const activeChapter = useMemo(
    () => getActiveCoCreateChapter(session),
    [session],
  );
  const activeChapterIndex = activeChapter
    ? session.chapters.findIndex((chapter) => chapter.id === activeChapter.id)
    : -1;
  const visibleMessages = useMemo(
    () => session.messages.filter((message) => !message.promptHidden),
    [session.messages],
  );
  const firstAssistantMessageIds = useMemo(() => {
    const ids = new Set<string>();
    let waitingForAssistant = false;
    for (const message of visibleMessages) {
      if (message.role === "user") {
        waitingForAssistant = true;
        continue;
      }
      if (message.role === "assistant" && waitingForAssistant) {
        ids.add(message.id);
        waitingForAssistant = false;
      }
    }
    return ids;
  }, [visibleMessages]);
  const chapterWords = useMemo(
    () => session.chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    [session.chapters],
  );
  const previousArchiveNote = !activeChapter?.archivedAt && activeChapterIndex > 0 && !activeChapter?.content?.trim()
    ? session.chapters[activeChapterIndex - 1]?.archiveNote || ""
    : "";
  const previousArchiveNoteChapterId = activeChapterIndex > 0 ? session.chapters[activeChapterIndex - 1]?.id || "" : "";
  const seenArchiveNoteChapterIds = session.seenArchiveNoteChapterIds || [];
  const hasSeenPreviousArchiveNote = previousArchiveNoteChapterId
    ? seenArchiveNoteChapterIds.includes(previousArchiveNoteChapterId)
    : false;
  const showArchiveNote = view === "write"
    && Boolean(previousArchiveNote)
    && Boolean(previousArchiveNoteChapterId)
    && previousArchiveNoteChapterId !== dismissedArchiveNoteChapterId
    && (!hasSeenPreviousArchiveNote || activeArchiveNoteChapterId === previousArchiveNoteChapterId);
  const hasWriteContent = Boolean(activeChapter?.content) || visibleMessages.length > 0 || showArchiveNote;
  const sessionMessagesSinceLastSummary = useMemo(() => {
    const since = session.lastMemorySummarizedAt;
    return session.messages.filter((message) => (
      message.role !== "system"
      && message.role !== "tool"
      && !message.promptHidden
      && (!since || message.createdAt > since)
    )).length;
  }, [session.messages, session.lastMemorySummarizedAt]);
  const canSummarizeMemory = sessionMessagesSinceLastSummary >= 2 && !isGenerating && !isArchiving;
  const sessionTitle = session.title.trim() || "未命名共创";
  const pendingMutations = [...session.pendingMutations].reverse();
  const recentRevisions = [...session.revisions].slice(-6).reverse();
  const editingCast = editingCastId ? session.cast.find((member) => member.id === editingCastId) || null : null;
  const castDeleteTarget = castDeleteTargetId ? session.cast.find((member) => member.id === castDeleteTargetId) || null : null;
  const editingWork = editingWorkId ? library.sessions.find((item) => item.id === editingWorkId) || null : null;
  const workDeleteTarget = workDeleteTargetId ? library.sessions.find((item) => item.id === workDeleteTargetId) || null : null;
  const chapterDeleteTarget = chapterDeleteTargetId ? session.chapters.find((chapter) => chapter.id === chapterDeleteTargetId) || null : null;
  const editingChapter = editingChapterId ? session.chapters.find((chapter) => chapter.id === editingChapterId) || null : null;
  const sharedSettings = library.settings || session.settings;
  const disabledToolNames = sharedSettings.disabledToolNames || [];
  const disabledToolSet = useMemo(() => new Set(disabledToolNames), [disabledToolNames]);
  const enabledToolCount = COCREATE_TOOL_DEFINITIONS.filter((tool) => !disabledToolSet.has(tool.name)).length;
  const hiddenSecretCount = session.cast.filter((member) => member.secret && member.secretHidden).length;
  const revealedSecretCount = session.cast.filter((member) => member.secret && !member.secretHidden).length;
  const hasCurrentWorkToolHistory = useMemo(() => (
    session.messages.some((message) => isCoCreateToolHistoryMessage(message) || hasCoCreateNativeToolReplayMetadata(message))
  ), [session.messages]);

  function persistSession(next: CoCreateSession): CoCreateSession {
    const saved = saveCoCreateSession(next);
    sessionRef.current = saved;
    setSession(saved);
    setLibrary(loadCoCreateLibrary(saved.partnerCharacterId || characters[0]?.id || ""));
    return saved;
  }

  useEffect(() => {
    if (view !== "write" || !previousArchiveNote || !previousArchiveNoteChapterId) {
      setActiveArchiveNoteChapterId(null);
      return;
    }
    if (hasSeenPreviousArchiveNote) {
      setActiveArchiveNoteChapterId((current) => (current === previousArchiveNoteChapterId ? current : null));
      return;
    }
    setActiveArchiveNoteChapterId(previousArchiveNoteChapterId);
    persistSession({
      ...session,
      seenArchiveNoteChapterIds: Array.from(new Set([...seenArchiveNoteChapterIds, previousArchiveNoteChapterId])),
      updatedAt: new Date().toISOString(),
    });
  }, [
    hasSeenPreviousArchiveNote,
    previousArchiveNote,
    previousArchiveNoteChapterId,
    seenArchiveNoteChapterIds,
    session,
    view,
  ]);

  function persistSharedSettings(nextSettings: CoCreateSettings): void {
    const nextLibrary = saveCoCreateLibrary({
      ...library,
      sessions: library.sessions,
      settings: nextSettings,
    });
    const activeSession = nextLibrary.sessions.find((item) => item.id === session.id)
      || nextLibrary.sessions.find((item) => item.id === nextLibrary.activeSessionId)
      || nextLibrary.sessions[0]
      || { ...session, settings: nextLibrary.settings };
    setLibrary(nextLibrary);
    sessionRef.current = activeSession;
    setSession(activeSession);
  }

  function clearCurrentWorkToolHistory(): void {
    if (isGenerating || isArchiving) {
      setStatus("共创正在执行，完成后再清理。");
      return;
    }
    const result = clearCoCreateToolHistory(session);
    setToolHistoryClearConfirmOpen(false);

    if (result.deletedMessages === 0 && result.cleanedMessages === 0) {
      setStatus("当前作品没有可清理的工具调用历史。");
      return;
    }

    persistSession(result.session);
    setStatus(`已清理 ${result.deletedMessages} 条工具记录，整理 ${result.cleanedMessages} 条消息。`);
  }

  function saveWriterNotebook(): void {
    persistSession({
      ...session,
      writerNotebook: writerNotebookDraft.replace(/\r\n/g, "\n").trim(),
    });
    setWriterNotebookDirty(false);
    setStatus("创作笔记本已保存。");
  }

  function openLibrary(): void {
    setError(null);
    setStatus(null);
    setView("library");
  }

  function readChapterReaderDraft(): { title: string; titleEn: string; content: string; summary: string } {
    return {
      title: normalizeEditableText(readerTitleRef.current?.innerText || editingChapterTitle),
      titleEn: normalizeEditableText(readerTitleEnRef.current?.innerText || editingChapterTitleEn),
      content: normalizeEditableText(readerBodyRef.current?.innerText || editingChapterContent),
      summary: normalizeEditableText(readerSummaryRef.current?.innerText || editingChapterSummary),
    };
  }

  function hasUnsavedChapterReaderChanges(): boolean {
    if (!editingChapter || !chapterReaderEditing) return false;
    const draft = readChapterReaderDraft();
    return (draft.title || "未命名章节") !== editingChapter.title
      || (draft.titleEn || `CHAPTER ${editingChapter.num}`) !== editingChapter.titleEn
      || draft.content !== normalizeEditableText(editingChapter.content || "")
      || draft.summary !== normalizeEditableText(editingChapter.summary || "");
  }

  function leaveChapterReader(target: ChapterReaderExitTarget): void {
    setChapterExitConfirmOpen(false);
    setChapterReaderEditing(false);
    setEditingChapterId(null);
    if (target === "library") {
      openLibrary();
    } else {
      setView("chapters");
    }
  }

  function requestChapterReaderExit(target: ChapterReaderExitTarget): void {
    if (chapterReaderEditing && hasUnsavedChapterReaderChanges()) {
      setChapterExitTarget(target);
      setChapterExitConfirmOpen(true);
      return;
    }
    leaveChapterReader(target);
  }

  function handleBack(): void {
    if (view === "library") {
      onClose();
      return;
    }
    if (view === "chapterReader") {
      requestChapterReaderExit("chapters");
      return;
    }
    openLibrary();
  }

  function openNewWorkDialog(): void {
    setNewWorkTitle("");
    setNewWorkOpen(true);
    setError(null);
  }

  function openEditWorkDialog(work: CoCreateSession): void {
    setEditingWorkId(work.id);
    setEditingWorkTitle(work.title);
    setError(null);
  }

  function createWork(): void {
    const title = newWorkTitle.trim() || `未命名共创 ${String(library.sessions.length + 1).padStart(2, "0")}`;
    const created = createCoCreateSession(title, session.partnerCharacterId || characters[0]?.id || "");
    setSession(created);
    setLibrary(loadCoCreateLibrary(created.partnerCharacterId));
    setNewWorkOpen(false);
    setNewWorkTitle("");
    setView("write");
    setStatus(`已创建作品：${created.title}`);
  }

  function enterWork(sessionId: string): void {
    const selected = setActiveCoCreateSession(sessionId, characters[0]?.id || "");
    if (!selected) {
      setError("没有找到这本作品。");
      return;
    }
    setSession(selected);
    setLibrary(loadCoCreateLibrary(selected.partnerCharacterId || characters[0]?.id || ""));
    setError(null);
    setStatus(null);
    setView("write");
  }

  function saveWorkEdit(): void {
    if (!editingWork) return;
    const updated = {
      ...editingWork,
      title: editingWorkTitle.trim() || "未命名共创",
      updatedAt: new Date().toISOString(),
    };
    const nextLibrary = saveCoCreateLibrary({
      ...library,
      sessions: library.sessions.map((item) => (item.id === updated.id ? updated : item)),
      settings: library.settings,
    });
    setLibrary(nextLibrary);
    if (session.id === updated.id) setSession(updated);
    setEditingWorkId(null);
    setEditingWorkTitle("");
    setStatus(`已更新作品：${updated.title}`);
  }

  async function deleteWork(): Promise<void> {
    if (!workDeleteTarget || isDeletingWork) return;
    setIsDeletingWork(true);
    setError(null);
    try {
      const cleanupCharacterIds = Array.from(new Set([
        workDeleteTarget.partnerCharacterId,
        ...characters.map((character) => character.id),
      ].filter(Boolean)));
      let removedShortTerm = 0;
      let removedLongTerm = 0;
      for (const characterId of cleanupCharacterIds) {
        removedShortTerm += deleteCoCreateProjectionEntriesBySession(characterId, workDeleteTarget.id);
        removedLongTerm += await deleteCoCreateLongTermMemoriesBySession(characterId, workDeleteTarget.id);
      }
      const nextLibrary = deleteCoCreateSession(workDeleteTarget.id, workDeleteTarget.partnerCharacterId || characters[0]?.id || "");
      const nextSession = nextLibrary.sessions.find((item) => item.id === nextLibrary.activeSessionId)
        || nextLibrary.sessions[0]
        || createDefaultCoCreateSession(characters[0]?.id || "");
      setLibrary(nextLibrary);
      setSession(nextSession);
      setWorkDeleteTargetId(null);
      setView("library");
      setStatus(`已删除《${workDeleteTarget.title}》，并清理 ${removedShortTerm + removedLongTerm} 条相关记忆。`);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setIsDeletingWork(false);
    }
  }

  function choosePartner(characterId: string): void {
    setError(null);
    persistSession({ ...session, partnerCharacterId: characterId });
  }

  function revealSecret(memberId: string): void {
    persistSession({
      ...session,
      cast: session.cast.map((member) => (
        member.id === memberId ? { ...member, secretHidden: false } : member
      )),
    });
  }

  function openNewCastEditor(): void {
    setEditingCastId(null);
    setCastForm(createDefaultCastForm());
    setCastEditorOpen(true);
    setError(null);
  }

  function openEditCastEditor(member: CoCreateCastMember): void {
    setEditingCastId(member.id);
    setCastForm(castToForm(member));
    setCastEditorOpen(true);
    setError(null);
  }

  function updateCastFormField<K extends keyof CastFormState>(key: K, value: CastFormState[K]): void {
    setCastForm((current) => ({ ...current, [key]: value }));
  }

  function saveCastForm(): void {
    if (!castForm.name.trim()) {
      setError("请先填写角色姓名。");
      return;
    }
    const existing = editingCastId ? session.cast.find((member) => member.id === editingCastId) : undefined;
    const nextMember = buildCastMember(castForm, existing);
    const nextCast = existing
      ? session.cast.map((member) => (member.id === existing.id ? nextMember : member))
      : [...session.cast, nextMember];
    persistSession({ ...session, cast: nextCast });
    setCastEditorOpen(false);
    setEditingCastId(null);
    setError(null);
    setStatus(existing ? `已更新角色档案：${nextMember.name}` : `已新增角色档案：${nextMember.name}`);
  }

  function deleteCastMember(): void {
    if (!castDeleteTarget) return;
    persistSession({
      ...session,
      cast: session.cast.filter((member) => member.id !== castDeleteTarget.id),
    });
    setCastDeleteTargetId(null);
    setStatus(`已删除角色档案：${castDeleteTarget.name}`);
  }

  function openChapterReader(chapter: CoCreateChapter): void {
    setEditingChapterId(chapter.id);
    setEditingChapterTitle(chapter.title);
    setEditingChapterTitleEn(chapter.titleEn);
    setEditingChapterContent(chapter.content || "");
    setEditingChapterSummary(chapter.summary || "");
    setChapterReaderEditing(false);
    setChapterExitConfirmOpen(false);
    setView("chapterReader");
    setError(null);
  }

  function startChapterReaderEdit(
    target: ChapterReaderEditTarget = "content",
    event?: ReactPointerEvent<HTMLElement>,
  ): void {
    if (!editingChapter) return;
    if (chapterReaderEditing) return;
    pendingReaderFocusRef.current = {
      target,
      point: event ? { x: event.clientX, y: event.clientY } : undefined,
    };
    setEditingChapterTitle(editingChapter.title);
    setEditingChapterTitleEn(editingChapter.titleEn);
    setEditingChapterContent(editingChapter.content || "");
    setEditingChapterSummary(editingChapter.summary || "");
    setChapterReaderEditing(true);
    setError(null);
  }

  function discardChapterReaderEdit(): void {
    if (editingChapter) {
      setEditingChapterTitle(editingChapter.title);
      setEditingChapterTitleEn(editingChapter.titleEn);
      setEditingChapterContent(editingChapter.content || "");
      setEditingChapterSummary(editingChapter.summary || "");
    }
    setChapterExitConfirmOpen(false);
    setChapterReaderEditing(false);
  }

  function saveChapterEdit(): void {
    if (!editingChapter) return;
    const draft = readChapterReaderDraft();
    const nextTitle = draft.title || "未命名章节";
    const nextTitleEn = draft.titleEn || `CHAPTER ${editingChapter.num}`;
    const nextContent = draft.content;
    const previousContent = normalizeEditableText(editingChapter.content || "");
    const nextSummary = draft.summary;
    const previousSummary = normalizeEditableText(editingChapter.summary || "");
    const titleChanged = nextTitle !== editingChapter.title || nextTitleEn !== editingChapter.titleEn;
    const contentChanged = nextContent !== previousContent;
    const summaryChanged = nextSummary !== previousSummary;
    if (!titleChanged && !contentChanged && !summaryChanged) {
      setChapterReaderEditing(false);
      return;
    }
    const now = new Date().toISOString();
    const changedParts: string[] = [];
    if (titleChanged) changedParts.push("标题");
    if (contentChanged) changedParts.push("正文");
    if (summaryChanged) changedParts.push("摘要");
    const revisionSummary = `手动编辑第 ${editingChapter.num} 章${changedParts.join("、")}。`;
    const nextChapter = {
      ...editingChapter,
      title: nextTitle,
      titleEn: nextTitleEn,
      content: nextContent || undefined,
      words: nextContent ? countTextWords(nextContent) : 0,
      summary: nextSummary || undefined,
      updatedAt: now,
    };
    persistSession({
      ...session,
      chapters: session.chapters.map((chapter) => (
        chapter.id === editingChapter.id ? nextChapter : chapter
      )),
      revisions: [
        ...session.revisions,
        {
          id: createClientId("cocreate_revision"),
          chapterId: editingChapter.id,
          toolName: "手动编辑章节",
          beforeTitle: editingChapter.title,
          beforeTitleEn: editingChapter.titleEn,
          afterTitle: nextTitle,
          afterTitleEn: nextTitleEn,
          beforeContent: contentChanged ? previousContent : undefined,
          afterContent: contentChanged ? nextContent : undefined,
          summary: revisionSummary,
          createdAt: now,
        },
      ].slice(-80),
      updatedAt: now,
    });
    setEditingChapterTitle(nextTitle);
    setEditingChapterTitleEn(nextTitleEn);
    setEditingChapterContent(nextContent);
    setChapterReaderEditing(false);
    setStatus(`已更新第 ${editingChapter.num} 章。`);
  }

  function updateRecentFullTextChapters(value: number): void {
    const recentFullTextChapters = Math.max(0, Math.min(10, Math.round(value)));
    persistSharedSettings({
      ...sharedSettings,
      recentFullTextChapters,
    });
  }

  function setStreamingEnabled(enabled: boolean): void {
    persistSharedSettings({
      ...sharedSettings,
      streamingEnabled: enabled,
    });
  }

  function setAutoAccept(enabled: boolean): void {
    persistSharedSettings({
      ...sharedSettings,
      autoAccept: enabled,
    });
  }

  function updateMemorySummaryInterval(value: number): void {
    const memorySummaryInterval = Math.max(5, Math.min(100, Math.round(value)));
    persistSharedSettings({
      ...sharedSettings,
      memorySummaryInterval,
    });
  }

  function setToolEnabled(toolName: string, enabled: boolean): void {
    const nextDisabled = new Set(sharedSettings.disabledToolNames || []);
    if (enabled) {
      nextDisabled.delete(toolName);
    } else {
      nextDisabled.add(toolName);
    }
    persistSharedSettings({
      ...sharedSettings,
      disabledToolNames: Array.from(nextDisabled),
    });
  }

  function setAllToolsEnabled(enabled: boolean): void {
    persistSharedSettings({
      ...sharedSettings,
      disabledToolNames: enabled ? [] : COCREATE_TOOL_DEFINITIONS.map((tool) => tool.name),
    });
  }

  function confirmPendingMutation(id: string): void {
    const snapshot = sessionRef.current;
    if (snapshot.pendingMutations.some((mutation) => mutation.id === id)) {
      resolvedPendingMutationIdsRef.current.add(id);
    }
    const result = applyCoCreatePendingMutation(snapshot, id);
    persistSession(result.session);
    if (result.success) {
      setError(null);
      setStatus(result.notice);
    } else {
      setError(result.error || result.notice);
    }
  }

  function rejectPendingMutation(id: string): void {
    const snapshot = sessionRef.current;
    if (snapshot.pendingMutations.some((mutation) => mutation.id === id)) {
      resolvedPendingMutationIdsRef.current.add(id);
    }
    persistSession(discardCoCreatePendingMutation(snapshot, id));
    setStatus("已取消这次待确认修改。");
  }

  function rollbackRevision(id: string): void {
    const result = rollbackCoCreateRevision(session, id);
    persistSession(result.session);
    if (result.success) {
      setError(null);
      setStatus(result.notice);
    } else {
      setError(result.error || result.notice);
    }
  }

  function deleteChapter(chapter: CoCreateChapter): void {
    const targetIndex = session.chapters.findIndex((item) => item.id === chapter.id);
    if (targetIndex < 0) return;
    const remainingChapters = reindexCoCreateChapters(session.chapters.filter((item) => item.id !== chapter.id));
    const nextActiveChapter = remainingChapters[targetIndex] || remainingChapters[targetIndex - 1] || remainingChapters[0] || null;
    persistSession({
      ...session,
      activeChapterId: nextActiveChapter?.id || "",
      chapters: remainingChapters,
      revisions: session.revisions.filter((revision) => revision.chapterId !== chapter.id),
      pendingMutations: session.pendingMutations.filter((mutation) => mutation.chapterId !== chapter.id),
      toolArtifacts: session.toolArtifacts.filter((artifact) => artifact.chapterId !== chapter.id),
      rollingSummary: [...remainingChapters].reverse()
        .map((item) => item.memoryEntries?.[item.memoryEntries.length - 1]?.text?.trim())
        .find((text): text is string => Boolean(text)),
    });
    setChapterDeleteTargetId(null);
    setStatus(`已删除第 ${chapter.num} 章，章节序号已重排。`);
  }

  function createManualChapter(): void {
    const nextChapter = createNextCoCreateChapter(session.chapters);
    const saved = persistSession({
      ...session,
      activeChapterId: nextChapter.id,
      chapters: [...session.chapters, nextChapter],
    });
    const created = saved.chapters.find((chapter) => chapter.id === nextChapter.id) || nextChapter;
    setStatus(`已新增第 ${created.num} 章。`);
    openChapterReader(created);
  }

  function getMessageChapterId(message: CoCreateSession["messages"][number]): string {
    return message.chapterId || session.activeChapterId || "";
  }

  function beginEditUserMessage(message: CoCreateSession["messages"][number]): void {
    if (message.role !== "user" || isGenerating || isArchiving) return;
    setEditingUserMessageId(message.id);
    setMode(message.mode === "discuss" ? "discuss" : "write");
    setInput(message.content);
    setStatus("编辑后发送，将丢弃该条以下回复并重新生成。");
  }

  async function runCoCreateGeneration(
    draft: CoCreateSession,
    generationMode: CoCreateMode,
    chapterId: string,
    logInput: string,
  ): Promise<void> {
    if (!partner) {
      setError("请先选择一个共创搭档角色。");
      return;
    }
    const logChapter = draft.chapters.find((chapter) => chapter.id === chapterId)
      || draft.chapters.find((chapter) => chapter.id === draft.activeChapterId)
      || null;

    const liveMessages: CoCreateSession["messages"] = [];
    let assistantEmitted = false;
    let streamedAssistantContent = "";
    let activeAssistantMessageId = "";
    let lastAssistantMessageId = "";
    let reasoningMessageId = "";
    let latestWorkingSession = draft;
    const toolCardByCallId = new Map<string, string>();
    let lastStreamPaintAt = 0;
    let lastStreamPaintLength = 0;
    const autoScrollIfStuck = () => {
      if (stickToBottomRef.current) scrollPanelToBottom(scrollRef.current);
    };
    const updateSessionState = (updater: (current: CoCreateSession) => CoCreateSession) => {
      setSession((current) => {
        const next = updater(current);
        sessionRef.current = next;
        return next;
      });
    };
    const mergeCurrentWithWorkingSession = (current: CoCreateSession, nextSession: CoCreateSession): CoCreateSession => {
      if (current.id !== nextSession.id) return current;
      if (sharedSettings.autoAccept !== false) {
        return { ...nextSession, messages: current.messages };
      }

      const resolvedPendingIds = resolvedPendingMutationIdsRef.current;
      const currentPendingIds = new Set(current.pendingMutations.map((mutation) => mutation.id));
      const pendingMutations = [
        ...current.pendingMutations,
        ...nextSession.pendingMutations.filter((mutation) => (
          !resolvedPendingIds.has(mutation.id) && !currentPendingIds.has(mutation.id)
        )),
      ];
      const currentArtifactIds = new Set(current.toolArtifacts.map((artifact) => artifact.id));
      const toolArtifacts = [
        ...current.toolArtifacts,
        ...nextSession.toolArtifacts.filter((artifact) => !currentArtifactIds.has(artifact.id)),
      ].slice(-20);
      const nextActiveChapterId = current.chapters.some((chapter) => chapter.id === nextSession.activeChapterId)
        ? nextSession.activeChapterId
        : current.activeChapterId;

      return {
        ...nextSession,
        activeChapterId: nextActiveChapterId,
        cast: current.cast,
        chapters: current.chapters,
        relationshipDossier: current.relationshipDossier,
        writerNotebook: current.writerNotebook,
        revisions: current.revisions,
        pendingMutations,
        toolArtifacts,
        messages: current.messages,
      };
    };
    const mergeLiveMessagesIntoSession = (
      baseSession: CoCreateSession,
      messagesToMerge: CoCreateSession["messages"],
    ): CoCreateSession => {
      const liveById = new Map(messagesToMerge.map((message) => [message.id, message]));
      const mergedIds = new Set<string>();
      const messages = baseSession.messages.map((message) => {
        const live = liveById.get(message.id);
        if (!live) return message;
        mergedIds.add(message.id);
        return { ...message, ...live };
      });
      const existingIds = new Set(messages.map((message) => message.id));
      for (const message of messagesToMerge) {
        if (mergedIds.has(message.id) || existingIds.has(message.id)) continue;
        messages.push(message);
        existingIds.add(message.id);
      }
      return { ...baseSession, messages };
    };
    const appendLiveMessage = (message: CoCreateSession["messages"][number]) => {
      liveMessages.push(message);
      updateSessionState((current) => ({
        ...current,
        messages: [...current.messages, message],
      }));
      autoScrollIfStuck();
    };
    const updateLiveMessage = (id: string, content: string) => {
      const index = liveMessages.findIndex((message) => message.id === id);
      if (index >= 0) {
        liveMessages[index] = { ...liveMessages[index], content };
      }
      updateSessionState((current) => ({
        ...current,
        messages: current.messages.map((message) => (
          message.id === id ? { ...message, content } : message
        )),
      }));
      autoScrollIfStuck();
    };
    const updateLiveMessagePatch = (id: string, patch: Partial<CoCreateSession["messages"][number]>) => {
      const index = liveMessages.findIndex((message) => message.id === id);
      if (index >= 0) {
        liveMessages[index] = { ...liveMessages[index], ...patch };
      }
      updateSessionState((current) => ({
        ...current,
        messages: current.messages.map((message) => (
          message.id === id ? { ...message, ...patch } : message
        )),
      }));
      autoScrollIfStuck();
    };

    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    try {
      const generationDraft = { ...draft, settings: sharedSettings };
      const result = await generateCoCreateReply(generationDraft, generationMode, {
        async onAssistantStep(stepContent) {
          const normalized = stepContent.trim();
          if (!normalized) return;
          assistantEmitted = true;
          activeAssistantMessageId = "";
          const message = createCoCreateMessage("assistant", generationMode, normalized, partner.name, chapterId);
          lastAssistantMessageId = message.id;
          appendLiveMessage(message);
          await waitForLiveStep();
        },
        async onAssistantDelta(deltaContent) {
          if (!deltaContent) return;
          assistantEmitted = true;
          streamedAssistantContent += deltaContent;
          if (!activeAssistantMessageId) {
            const message = createCoCreateMessage("assistant", generationMode, deltaContent, partner.name, chapterId);
            activeAssistantMessageId = message.id;
            lastAssistantMessageId = message.id;
            appendLiveMessage(message);
          } else {
            const current = liveMessages.find((message) => message.id === activeAssistantMessageId)?.content || "";
            const nextContent = `${current}${deltaContent}`;
            lastAssistantMessageId = activeAssistantMessageId;
            updateLiveMessage(activeAssistantMessageId, nextContent);
          }
          const now = Date.now();
          if (streamedAssistantContent.length - lastStreamPaintLength >= 24 || now - lastStreamPaintAt >= 80) {
            lastStreamPaintAt = now;
            lastStreamPaintLength = streamedAssistantContent.length;
            await waitForStreamPaint();
          }
        },
        async onReasoningDelta(deltaContent) {
          if (!deltaContent) return;
          if (!reasoningMessageId) {
            const message = createCoCreateMessage(
              "system",
              generationMode,
              deltaContent,
              "正在创作剧本...",
              chapterId,
              "reasoning",
            );
            reasoningMessageId = message.id;
            appendLiveMessage(message);
          } else {
            const current = liveMessages.find((message) => message.id === reasoningMessageId)?.content || "";
            updateLiveMessage(reasoningMessageId, `${current}${deltaContent}`);
          }
          await waitForStreamPaint();
        },
        async onWorkingSessionUpdate(nextSession) {
          latestWorkingSession = nextSession;
          updateSessionState((current) => mergeCurrentWithWorkingSession(current, nextSession));
          await waitForLiveStep();
        },
        async onToolCallStart({ id, name }) {
          activeAssistantMessageId = "";
          const content = `正在调用 ${name}…`;
          const message = createCoCreateMessage("system", generationMode, content, "TOOL", chapterId);
          toolCardByCallId.set(id, message.id);
          appendLiveMessage(message);
          await waitForLiveStep();
        },
        async onToolCallResult({ id, name, notice, content: resultContent }) {
          const visible = notice?.trim() || resultContent?.trim() || `${name} 已完成`;
          if (name === "切换" && /切换到第/.test(visible)) {
            setStatus(visible, { prominent: true });
          }
          const messageId = toolCardByCallId.get(id);
          if (messageId) {
            updateLiveMessage(messageId, visible);
            toolCardByCallId.delete(id);
          } else {
            appendLiveMessage(createCoCreateMessage("system", generationMode, visible, "TOOL", chapterId));
          }
          lastAssistantMessageId = "";
          await waitForLiveStep();
        },
        async onToolStart() {
          activeAssistantMessageId = "";
        },
        async onToolResult() {
          lastAssistantMessageId = "";
        },
        async onNativeToolAssistantTurn({ content, rawContent, reasoning, openRouterReasoningDetails, toolCalls }) {
          const targetId = activeAssistantMessageId || lastAssistantMessageId;
          if (targetId) {
            updateLiveMessagePatch(targetId, {
              rawResponseText: rawContent,
              nativeToolCalls: toolCalls,
              nativeToolReasoning: reasoning,
              nativeToolOpenRouterReasoningDetails: openRouterReasoningDetails,
            });
            return;
          }
          const message = createCoCreateMessage("assistant", generationMode, content.trim(), partner.name, chapterId);
          message.promptHidden = true;
          message.rawResponseText = rawContent;
          message.nativeToolCalls = toolCalls;
          message.nativeToolReasoning = reasoning;
          message.nativeToolOpenRouterReasoningDetails = openRouterReasoningDetails;
          liveMessages.push(message);
        },
        async onNativeToolResult({ toolCallId, name, content }) {
          const message = createCoCreateMessage("tool", generationMode, "", "TOOL", chapterId, "tool");
          message.promptHidden = true;
          message.nativeToolResult = { toolCallId, name, content };
          liveMessages.push(message);
        },
        async onStreamFallback(reason) {
          setStatus(`流式输出不可用，已切换普通生成：${reason}`);
        },
      }, { signal: abortController.signal });
      const workingSession = result.updatedSession || latestWorkingSession;
      if (reasoningMessageId) {
        updateLiveMessagePatch(reasoningMessageId, { authorName: "创作过程" });
      }
      const normalizedResult = result.content.trim();
      if (normalizedResult && !assistantEmitted) {
        liveMessages.push(createCoCreateMessage("assistant", generationMode, normalizedResult, partner.name, workingSession.activeChapterId || chapterId));
      }
      const baseSession = mergeCurrentWithWorkingSession(sessionRef.current, workingSession);
      persistSession(appendBackendLog({
        ...mergeLiveMessagesIntoSession(baseSession, liveMessages),
        turnsSinceSummary: 0,
      }, {
        kind: "reply",
        status: "success",
        title: `${modeLabel(generationMode)} 生成成功`,
        mode: generationMode,
        chapterNum: logChapter?.num,
        chapterTitle: logChapter?.title,
        model: result.model,
        presetName: result.presetName,
        input: logInput,
        output: result.content,
        rawOutputs: result.rawOutputs,
        toolNotices: result.toolNotices,
        toolDebugs: result.toolDebugs,
      }));
      if (result.toolNotices?.length) {
        setStatus(result.toolNotices.join("；"));
      }
    } catch (generateError) {
      const isAbort = abortController.signal.aborted
        || (generateError instanceof DOMException && generateError.name === "AbortError");
      if (isAbort) {
        for (const messageId of toolCardByCallId.values()) {
          const card = liveMessages.find((message) => message.id === messageId);
          const name = card?.content?.match(/正在调用\s*([^\s…]+)/)?.[1];
          updateLiveMessage(messageId, name ? `已取消调用 ${name}` : "已取消调用");
        }
        toolCardByCallId.clear();
        const workingSession = latestWorkingSession || draft;
        const baseSession = mergeCurrentWithWorkingSession(sessionRef.current, workingSession);
        persistSession(appendBackendLog(mergeLiveMessagesIntoSession(baseSession, liveMessages), {
          kind: "reply",
          status: "success",
          title: `${modeLabel(generationMode)} 已停止`,
          mode: generationMode,
          chapterNum: logChapter?.num,
          chapterTitle: logChapter?.title,
          input: logInput,
          output: "（用户已停止生成）",
        }));
      } else {
        const message = errorMessage(generateError);
        const workingSession = latestWorkingSession || draft;
        const baseSession = mergeCurrentWithWorkingSession(sessionRef.current, workingSession);
        persistSession(appendBackendLog(mergeLiveMessagesIntoSession(baseSession, liveMessages), {
          kind: "reply",
          status: "error",
          title: `${modeLabel(generationMode)} 生成失败`,
          mode: generationMode,
          chapterNum: logChapter?.num,
          chapterTitle: logChapter?.title,
          input: logInput,
          error: message,
        }));
        setError(message);
      }
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
    }
  }

  async function handleSend(): Promise<void> {
    const content = input.trim();
    if (!content || isGenerating || isArchiving) return;
    if (!partner) {
      setError("请先选择一个共创搭档角色。");
      return;
    }

    stickToBottomRef.current = true;
    setInput("");
    setError(null);
    setStatus(null);
    setIsGenerating(true);

    const editingId = editingUserMessageId;
    setEditingUserMessageId(null);
    try {
      if (editingId) {
        const targetIndex = session.messages.findIndex((message) => message.id === editingId && message.role === "user");
        const targetMessage = targetIndex >= 0 ? session.messages[targetIndex] : null;
        if (!targetMessage) throw new Error("找不到要编辑的用户消息。");
        const chapterId = getMessageChapterId(targetMessage);
        const nextMessage = {
          ...targetMessage,
          mode: targetMessage.mode === "discuss" ? "discuss" as const : "write" as const,
          content,
          authorName: userName,
        };
        const nextMessages = session.messages.flatMap((message, index) => {
          if (index < targetIndex) return [message];
          if (index === targetIndex) return [nextMessage];
          return [];
        });
        const draft = persistSession({
          ...session,
          activeChapterId: chapterId || session.activeChapterId,
          messages: nextMessages,
        });
        await runCoCreateGeneration(draft, nextMessage.mode as CoCreateMode, chapterId || draft.activeChapterId, content);
      } else {
        const prepared = ensureActiveCoCreateChapter(session);
        const chapterId = prepared.activeChapterId;
        const userMessage = createCoCreateMessage("user", mode, content, userName, chapterId);
        const draft = persistSession({
          ...prepared,
          messages: [...prepared.messages, userMessage],
        });
        await runCoCreateGeneration(draft, mode, chapterId, content);
      }
      maybeAutoSummarizeSessionMemory();
    } finally {
      setIsGenerating(false);
    }
  }

  function maybeAutoSummarizeSessionMemory(): void {
    if (isArchiving) return;
    const snapshot = sessionRef.current;
    const interval = snapshot.settings?.memorySummaryInterval ?? sharedSettings.memorySummaryInterval ?? 20;
    if (!Number.isFinite(interval) || interval <= 0) return;
    const since = snapshot.lastMemorySummarizedAt;
    const newCount = snapshot.messages.filter((message) => (
      message.role !== "system"
      && message.role !== "tool"
      && !message.promptHidden
      && (!since || message.createdAt > since)
    )).length;
    if (newCount < interval) return;
    void handleSummarizeSessionMemory();
  }

  async function retryFromAssistantMessage(message: CoCreateSession["messages"][number]): Promise<void> {
    if (message.role !== "assistant" || isGenerating || isArchiving) return;
    const targetIndex = session.messages.findIndex((item) => item.id === message.id);
    if (targetIndex < 0) return;
    const chapterId = getMessageChapterId(message);
    const previousUser = [...session.messages.slice(0, targetIndex)]
      .reverse()
      .find((item) => item.role === "user");
    if (!previousUser) {
      setError("找不到可用于重试的用户输入。");
      return;
    }

    stickToBottomRef.current = true;
    setError(null);
    setStatus(null);
    setIsGenerating(true);
    try {
      const draft = persistSession({
        ...session,
        activeChapterId: chapterId || session.activeChapterId,
        messages: session.messages.filter((_, index) => index < targetIndex),
      });
      const generationMode = previousUser.mode === "discuss" ? "discuss" : "write";
      setMode(generationMode);
      await runCoCreateGeneration(draft, generationMode, chapterId || draft.activeChapterId, previousUser.content);
    } finally {
      setIsGenerating(false);
    }
  }

  async function runChapterAutoArchive(chapterId: string): Promise<void> {
    if (autoArchivingChaptersRef.current.has(chapterId)) return;
    autoArchivingChaptersRef.current.add(chapterId);
    try {
      const snapshot = sessionRef.current;
      const target = snapshot.chapters.find((chapter) => chapter.id === chapterId);
      if (!target || !target.content?.trim()) return;
      const result = await generateCoCreateChapterAutoArchive(snapshot, target);
      if (!result) return;
      const archivedAt = new Date().toISOString();
      setSession((current) => {
        if (!current.chapters.some((chapter) => chapter.id === chapterId)) return current;
        const next = {
          ...current,
          chapters: current.chapters.map((chapter) => (
            chapter.id === chapterId
              ? { ...chapter, summary: result.summary, archiveNote: result.archiveNote, archivedAt }
              : chapter
          )),
        };
        saveCoCreateSession(next);
        return next;
      });
    } catch (error) {
      console.warn("[cocreate] chapter auto-archive failed", error);
    } finally {
      autoArchivingChaptersRef.current.delete(chapterId);
    }
  }

  async function handleSummarizeSessionMemory(): Promise<void> {
    if (!partner || isArchiving || isGenerating) return;
    setArchiveConfirmOpen(false);
    setError(null);
    setStatus(null);
    setIsArchiving(true);

    try {
      const sinceTimestamp = session.lastMemorySummarizedAt;
      const result = await generateCoCreateSessionMemory(session, { sinceTimestamp });
      if (!result) {
        setStatus("最近没有足够的新对话可以总结。");
        return;
      }
      const summarizedAt = new Date().toISOString();
      const targetChapterId = sessionRef.current.activeChapterId;
      setSession((current) => {
        const chapters = current.chapters.map((chapter) => {
          if (chapter.id !== targetChapterId) return chapter;
          const nextEntries = [
            ...(chapter.memoryEntries || []),
            { text: result.memory, archivedAt: summarizedAt },
          ];
          return { ...chapter, memoryEntries: nextEntries };
        });
        const next: CoCreateSession = {
          ...current,
          chapters,
          rollingSummary: result.memory,
          turnsSinceSummary: 0,
          lastMemorySummarizedAt: summarizedAt,
        };
        const saved = saveCoCreateSession(next);
        const activeChapter = saved.chapters.find((chapter) => chapter.id === targetChapterId);
        const entryCount = activeChapter?.memoryEntries?.length || 1;
        recordCoCreateProjectionEvent({
          sessionId: saved.id,
          characterId: partner.id,
          title: saved.title,
          partnerName: partner.name,
          userName,
          memory: result.memory,
          chapterId: activeChapter?.id,
          chapterNum: activeChapter?.num,
          chapterTitle: activeChapter?.title,
          chapterVersion: entryCount,
        });
        return saved;
      });
      incrementEventCounter(partner.id);
      maybeRunSummarization(partner.id, partner.name).catch((summarizeError) => {
        console.warn("[cocreate] long-term memory summarization failed", summarizeError);
      });
      setStatus(`已把最近 ${result.messageCount} 条对话总结为一条记忆。`);
      onNotice?.("会话记忆已总结。");
    } catch (summaryError) {
      const message = errorMessage(summaryError);
      setError(message);
    } finally {
      setIsArchiving(false);
    }
  }

  function handleTextareaKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSend();
    }
  }

  function exportManuscriptTxt(): void {
    if (!hasExportableContent(session)) {
      setStatus("暂无正文可导出。");
      return;
    }
    try {
      const blob = new Blob([buildExportText(session)], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeExportFileName(session.title)}.txt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus("TXT 已导出。");
    } catch {
      setError("无法导出 TXT。");
    }
  }

  return (
    <div className="cocreate-app">
      <div className="cocreate-cosmic" aria-hidden="true" />
      <div className="cocreate-stars" aria-hidden="true" />
      {status && (
        <div
          className={statusProminent ? "cocreate-toast cocreate-toast--prominent" : "cocreate-toast"}
          role="status"
          aria-live="polite"
        >
          {status}
        </div>
      )}
      <header className="cocreate-topbar">
        <div className="cocreate-head-left">
          <button
            type="button"
            className="cocreate-back-button"
            onClick={handleBack}
            aria-label={view === "library" ? "返回桌面" : view === "chapterReader" ? "返回章节列表" : "返回作品库"}
          >
            <ChevronLeft size={22} />
          </button>
          <div className="cocreate-avatar-mark">
            <span>{fallbackInitial(view === "library" ? "作品库" : partner?.name || sessionTitle)}</span>
          </div>
          <div className="cocreate-brand">
            <span>{view === "library" ? "CO·CREATE LIBRARY" : "CO·CREATE"}</span>
            <strong>
              {view === "library"
                ? `${library.sessions.length} WORKS // NOVEL DESK`
                : `${partner?.name || "未选择搭档"} × ${userName} // S.1`}
            </strong>
          </div>
        </div>
        <div className="cocreate-head-actions">
          {view === "library" ? (
            <button type="button" className="cocreate-icon-button" onClick={() => setSettingsOpen(true)} aria-label="共创设置">
              <MoreHorizontal size={17} />
            </button>
          ) : view === "chapterReader" ? (
            editingChapter && !chapterReaderEditing ? (
              <button
                type="button"
                className="cocreate-icon-button"
                onClick={() => startChapterReaderEdit("content")}
                aria-label="编辑章节"
                title="编辑章节"
              >
                <Pencil size={15} />
              </button>
            ) : null
          ) : (
            <button type="button" className="cocreate-icon-button" onClick={() => setBackendLogOpen(true)} aria-label="后台记录">
              <Wrench size={16} />
            </button>
          )}
          <div className="cocreate-live-pill">
            <i />
            <span>{view === "library" ? "LIB" : "LIVE"}</span>
          </div>
        </div>
      </header>

      <main className="cocreate-main">
        {view === "library" ? (
          <section className="cocreate-library-panel">
            <div className="cocreate-library-hero">
              <span>WORK DESK</span>
              <h1>作品库</h1>
              <p>每一本小说拥有独立章节、角色档案、动作记录和共创记忆。删除作品时，会同步清理该作品写入的记忆。</p>
            </div>

            {error && <div className="cocreate-error cocreate-library-status">{error}</div>}

            <div className="cocreate-work-list" aria-label="已有作品">
              {library.sessions.length === 0 && (
                <div className="cocreate-work-empty">
                  <FilePlus size={22} />
                  <strong>还没有作品。</strong>
                  <p>新增一本小说后，再进入正文页和共创搭档开始写作。</p>
                </div>
              )}
              {library.sessions.map((item, index) => {
                const itemPartner = characters.find((character) => character.id === item.partnerCharacterId);
                const doneChapters = item.chapters.filter((chapter) => Boolean(chapter.archivedAt)).length;
                const words = item.chapters.reduce((sum, chapter) => sum + chapter.words, 0);
                return (
                  <article key={item.id} className="cocreate-work-card" data-active={item.id === session.id ? "1" : undefined}>
                    <button type="button" className="cocreate-work-main" onClick={() => enterWork(item.id)}>
                      <div className="cocreate-work-card-head">
                        <span>WORK {String(index + 1).padStart(2, "0")}</span>
                        <strong>{item.title || "未命名共创"}</strong>
                      </div>
                      <div className="cocreate-work-meta">
                        <div>
                          <span>PARTNER</span>
                          <strong>{itemPartner?.name || "未选择"}</strong>
                        </div>
                        <div>
                          <span>CHAPTER</span>
                          <strong>{doneChapters}/{item.chapters.length}</strong>
                        </div>
                        <div>
                          <span>WORDS</span>
                          <strong>{words.toLocaleString()}</strong>
                        </div>
                        <div>
                          <span>TIME</span>
                          <time>{formatShortDate(item.updatedAt || item.createdAt)}</time>
                        </div>
                      </div>
                    </button>
                    <div className="cocreate-work-actions">
                      <button type="button" onClick={() => openEditWorkDialog(item)} aria-label={`编辑作品 ${item.title || "未命名共创"}`} title="改名">
                        <Pencil size={14} />
                      </button>
                      <button type="button" onClick={() => setWorkDeleteTargetId(item.id)} aria-label={`删除作品 ${item.title || "未命名共创"}`} title="删除">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : (
          <>
            {view !== "chapterReader" && (
              <>
                <section className="cocreate-hero">
                  <div className="cocreate-title-wrap">
                    <h1>{sessionTitle}</h1>
                    <mark aria-hidden="true" />
                  </div>
                  <p>{WORK_DECORATIVE_SUBTITLE}</p>
                </section>

                <nav className="cocreate-tabs" aria-label="共创页面">
                  <button type="button" data-active={view === "write" ? "1" : undefined} onClick={() => setView("write")}>
                    <span>WRITE</span>
                    <small>正文</small>
                  </button>
                  <button type="button" data-active={view === "characters" ? "1" : undefined} onClick={() => setView("characters")}>
                    <span>ARCHIVE</span>
                    <small>档案</small>
                  </button>
                  <button type="button" data-active={view === "chapters" ? "1" : undefined} onClick={() => setView("chapters")}>
                    <span>INDEX</span>
                    <small>章节</small>
                  </button>
                </nav>
              </>
            )}

            {error && <div className={view === "chapterReader" ? "cocreate-error cocreate-reader-error" : "cocreate-error"}>{error}</div>}

        {view === "write" && (
          <section ref={scrollRef} className="cocreate-write-panel">
            {activeChapter && (
              <button
                type="button"
                className="cocreate-write-chapter-strip"
                onClick={() => openChapterReader(activeChapter)}
                aria-label={`查看第 ${activeChapter.num} 章`}
                title="点击查看 / 编辑章节正文"
              >
                <i aria-hidden="true" />
                <span>CHAPTER.{activeChapter.num}</span>
                <strong>{activeChapter.title}</strong>
                <em>{activeChapter.words.toLocaleString()} 字</em>
              </button>
            )}

            {!hasWriteContent && (
              <div className="cocreate-empty-state">
                <span>[ BLANK PAGE ]</span>
                <strong>还没有正文。</strong>
                <p>先选择共创搭档，然后创建一个章节，和你的AI角色开始沟通书写吧~</p>
              </div>
            )}

            {showArchiveNote && (
              <aside className="cocreate-archive-note-popover" aria-label="上一章结语">
                <button
                  type="button"
                  onClick={() => setDismissedArchiveNoteChapterId(previousArchiveNoteChapterId)}
                  aria-label="关闭上一章结语"
                >
                  <X size={14} />
                </button>
                <span>ARCHIVE NOTE</span>
                <strong>上一章结语</strong>
                <CoCreateMarkdown content={previousArchiveNote} />
              </aside>
            )}

            {visibleMessages.map((message) => {
              if (message.mode === "chapter") {
                return (
                  <article key={message.id} className="cocreate-chapter-card">
                    <CoCreateMarkdown content={message.content} />
                  </article>
                );
              }

              const isWrite = message.mode === "write";
              const isUser = message.role === "user";
              const canRetryFromHere = !isUser && message.role === "assistant" && firstAssistantMessageIds.has(message.id);
              const systemStepsBeforeAssistant = !isUser && message.role === "assistant"
                ? (() => {
                  const index = visibleMessages.findIndex((item) => item.id === message.id);
                  const steps: CoCreateSession["messages"] = [];
                  for (let i = index - 1; i >= 0; i -= 1) {
                    const previous = visibleMessages[i];
                    if (!previous || !isCoCreateSystemStep(previous)) break;
                    steps.unshift(previous);
                  }
                  return steps;
                })()
                : [];
              if (isCoCreateSystemStep(message)) {
                const index = visibleMessages.findIndex((item) => item.id === message.id);
                const nextNonSystem = visibleMessages.slice(index + 1).find((item) => !isCoCreateSystemStep(item));
                if (nextNonSystem?.role === "assistant") return null;
              }
              if (message.kind === "reasoning") {
                const isRunningReasoning = message.authorName?.includes("正在") && isGenerating;
                return (
                  <article key={message.id} className="cocreate-write-block">
                    <div className="cocreate-block-meta">
                      <span>// AI</span>
                      <strong>{partner?.name || "AI"}</strong>
                      <i />
                      <span>{formatDate(message.createdAt)}</span>
                    </div>
                    <details
                      className="cocreate-reasoning-fold cocreate-reasoning-fold-inline"
                      data-running={isRunningReasoning ? "1" : undefined}
                    >
                      <summary>
                        <span>
                          {isRunningReasoning ? <Loader2 size={13} /> : <ChevronDown size={13} />}
                          {message.authorName || "创作过程"}
                        </span>
                        {isRunningReasoning && (
                          <span className="cocreate-action-dots" aria-hidden="true">
                            <b />
                            <b />
                            <b />
                          </span>
                        )}
                        <time>{formatDate(message.createdAt)}</time>
                      </summary>
                      <CoCreateMarkdown content={message.content} />
                    </details>
                  </article>
                );
              }
              const isActionMessage = isCoCreateSystemStep(message);
              if (isActionMessage) {
                const isRunningTool = /^正在(调用|执行)/.test(message.content);
                return (
                  <article key={message.id} className="cocreate-tool-step" data-running={isRunningTool ? "1" : undefined}>
                    <div className="cocreate-tool-step-head">
                      <strong>// AI {partner?.name || "AI"}</strong>
                      {isRunningTool ? <Loader2 size={14} /> : <Check size={14} />}
                      <span>{isRunningTool ? "ACTION RUNNING" : "ACTION RESULT"}</span>
                      {isRunningTool && (
                        <span className="cocreate-action-dots" aria-hidden="true">
                          <b />
                          <b />
                          <b />
                        </span>
                      )}
                      <i />
                      <time>{formatDate(message.createdAt)}</time>
                    </div>
                    <CoCreateMarkdown content={message.content} />
                  </article>
                );
              }
              if (isWrite) {
                return (
                  <article key={message.id} className={isUser ? "cocreate-write-block cocreate-write-user" : "cocreate-write-block"}>
                    <div className="cocreate-block-meta">
                      <span>{isUser ? "// USER" : "// AI"}</span>
                      <strong>{message.authorName || (isUser ? userName : partner?.name || "AI")}</strong>
                      <i />
                      <span className="cocreate-message-actions" aria-label="消息操作">
                        <button
                          type="button"
                          onClick={() => copyTextToClipboard(message.content, onNotice)}
                          aria-label="复制原文"
                          title="复制"
                        >
                          <Copy size={12} />
                        </button>
                        {isUser ? (
                          <button
                            type="button"
                            onClick={() => beginEditUserMessage(message)}
                            disabled={isGenerating || isArchiving}
                            aria-label="编辑并重回"
                            title="编辑"
                          >
                            <Pencil size={12} />
                          </button>
                        ) : canRetryFromHere ? (
                          <button
                            type="button"
                            onClick={() => void retryFromAssistantMessage(message)}
                            disabled={isGenerating || isArchiving}
                            aria-label="重试以下"
                            title="重试以下"
                          >
                            <RotateCcw size={12} />
                          </button>
                        ) : null}
                      </span>
                      <span>{formatDate(message.createdAt)}</span>
                    </div>
                    {systemStepsBeforeAssistant.map((step) => {
                      if (step.kind === "reasoning") {
                        const isRunningReasoning = step.authorName?.includes("正在") && isGenerating;
                        return (
                          <details
                            key={step.id}
                            className="cocreate-reasoning-fold cocreate-reasoning-fold-inline"
                            data-running={isRunningReasoning ? "1" : undefined}
                          >
                            <summary>
                              <span>
                                {isRunningReasoning ? <Loader2 size={13} /> : <ChevronDown size={13} />}
                                {step.authorName || "创作过程"}
                              </span>
                              {isRunningReasoning && (
                                <span className="cocreate-action-dots" aria-hidden="true">
                                  <b />
                                  <b />
                                  <b />
                                </span>
                              )}
                              <time>{formatDate(step.createdAt)}</time>
                            </summary>
                            <CoCreateMarkdown content={step.content} />
                          </details>
                        );
                      }
                      const isRunningTool = step.content.includes("正在执行");
                      return (
                        <article key={step.id} className="cocreate-tool-step cocreate-tool-step-inline" data-running={isRunningTool ? "1" : undefined}>
                          <div className="cocreate-tool-step-head">
                            {isRunningTool ? <Loader2 size={14} /> : <Check size={14} />}
                            <span>{isRunningTool ? "ACTION RUNNING" : "ACTION RESULT"}</span>
                            {isRunningTool && (
                              <span className="cocreate-action-dots" aria-hidden="true">
                                <b />
                                <b />
                                <b />
                              </span>
                            )}
                            <i />
                            <time>{formatDate(step.createdAt)}</time>
                          </div>
                          <CoCreateMarkdown content={step.content} />
                        </article>
                      );
                    })}
                    <CoCreateMarkdown content={message.content} />
                  </article>
                );
              }

              return (
                <article
                  key={message.id}
                  className={isUser ? "cocreate-message cocreate-message-user" : "cocreate-message"}
                >
                  <div className="cocreate-block-meta">
                    <span>{message.authorName || (isUser ? userName : partner?.name || "AI")}</span>
                    <i />
                    <span className="cocreate-message-actions" aria-label="消息操作">
                      <button
                        type="button"
                        onClick={() => copyTextToClipboard(message.content, onNotice)}
                        aria-label="复制原文"
                        title="复制"
                      >
                        <Copy size={12} />
                      </button>
                      {isUser ? (
                        <button
                          type="button"
                          onClick={() => beginEditUserMessage(message)}
                          disabled={isGenerating || isArchiving}
                          aria-label="编辑并重回"
                          title="编辑"
                        >
                          <Pencil size={12} />
                        </button>
                      ) : canRetryFromHere ? (
                        <button
                          type="button"
                          onClick={() => void retryFromAssistantMessage(message)}
                          disabled={isGenerating || isArchiving}
                          aria-label="重试以下"
                          title="重试以下"
                        >
                          <RotateCcw size={12} />
                        </button>
                      ) : null}
                    </span>
                    <span>{modeLabel(message.mode as CoCreateMode)} · {formatDate(message.createdAt)}</span>
                  </div>
                  {systemStepsBeforeAssistant.map((step) => {
                    if (step.kind === "reasoning") {
                      const isRunningReasoning = step.authorName?.includes("正在") && isGenerating;
                      return (
                        <details
                          key={step.id}
                          className="cocreate-reasoning-fold cocreate-reasoning-fold-inline"
                          data-running={isRunningReasoning ? "1" : undefined}
                        >
                          <summary>
                            <span>
                              {isRunningReasoning ? <Loader2 size={13} /> : <ChevronDown size={13} />}
                              {step.authorName || "创作过程"}
                            </span>
                            {isRunningReasoning && (
                              <span className="cocreate-action-dots" aria-hidden="true">
                                <b />
                                <b />
                                <b />
                              </span>
                            )}
                            <time>{formatDate(step.createdAt)}</time>
                          </summary>
                          <CoCreateMarkdown content={step.content} />
                        </details>
                      );
                    }
                    const isRunningTool = step.content.includes("正在执行");
                    return (
                      <article key={step.id} className="cocreate-tool-step cocreate-tool-step-inline" data-running={isRunningTool ? "1" : undefined}>
                        <div className="cocreate-tool-step-head">
                          {isRunningTool ? <Loader2 size={14} /> : <Check size={14} />}
                          <span>{isRunningTool ? "ACTION RUNNING" : "ACTION RESULT"}</span>
                          {isRunningTool && (
                            <span className="cocreate-action-dots" aria-hidden="true">
                              <b />
                              <b />
                              <b />
                            </span>
                          )}
                          <i />
                          <time>{formatDate(step.createdAt)}</time>
                        </div>
                        <CoCreateMarkdown content={step.content} />
                      </article>
                    );
                  })}
                  <CoCreateMarkdown content={message.content} />
                </article>
              );
            })}

            {isGenerating && !sharedSettings.streamingEnabled && (
              <div className="cocreate-thinking">
                <Loader2 size={18} />
                <span>{mode === "write" ? "正在创作正文" : "正在整理讨论"}</span>
              </div>
            )}
            {isArchiving && (
              <div className="cocreate-thinking">
                <Loader2 size={18} />
                <span>正在总结会话记忆</span>
              </div>
            )}
          </section>
        )}

        {view === "characters" && (
          <section className="cocreate-character-panel">
            <div className="cocreate-intel-note">
              <span>[ PARTNER ]</span>
              <p>共创搭档会使用该角色在“共创”下的绑定API、预设、世界书、用户人设、历史记忆。</p>
            </div>
            <div className="cocreate-partner-grid">
              {characters.map((character) => (
                <button
                  type="button"
                  key={character.id}
                  className="cocreate-partner-card"
                  data-active={character.id === session.partnerCharacterId ? "1" : undefined}
                  onClick={() => choosePartner(character.id)}
                >
                  {character.avatar ? <img src={character.avatar} alt="" /> : <span>{character.name.slice(0, 1)}</span>}
                  <strong>{character.name}</strong>
                  <small>{character.tags?.slice(0, 3).join(" / ") || "未标记"}</small>
                </button>
              ))}
              {characters.length === 0 && (
                <div className="cocreate-empty">还没有角色卡。请先在角色应用里创建角色。</div>
              )}
            </div>

            <div className="cocreate-section-title cocreate-section-title-action">
              <div>
                <span>CAST</span>
                <strong>当前小说角色</strong>
              </div>
              <button type="button" className="cocreate-mini-action" onClick={openNewCastEditor}>
                <Plus size={13} />
                新增
              </button>
            </div>
            <div className="cocreate-cast-list">
              {session.cast.length === 0 && (
                <div className="cocreate-empty cocreate-empty-cast">当前小说还没有登记角色。点“新增”建立 session 角色档案，这些档案会随章节上下文一起传给共创搭档。</div>
              )}
              {session.cast.map((member) => (
                <article key={member.id} className="cocreate-cast-card" style={{ "--cc-accent": member.color } as CSSProperties}>
                  <div className="cocreate-cast-head">
                    <span>{member.nameEn}</span>
                    <strong>{member.name}</strong>
                  </div>
                  <div className="cocreate-cast-meta">
                    <div>
                      <span>ROLE</span>
                      <strong>{member.role}</strong>
                    </div>
                    <div>
                      <span>LABEL</span>
                      <strong>{member.label}</strong>
                    </div>
                    <div>
                      <span>MAJOR</span>
                      <strong>{member.major}</strong>
                    </div>
                  </div>
                  <p>{member.desc}</p>
                  {member.secret ? (
                    member.secretHidden ? (
                      <button type="button" className="cocreate-secret-button" onClick={() => revealSecret(member.id)}>
                        <Lock size={15} />
                        揭示暗线
                      </button>
                    ) : (
                      <div className="cocreate-secret">
                        <Eye size={15} />
                        {member.secret}
                      </div>
                    )
                  ) : null}
                  <div className="cocreate-cast-actions">
                    <button type="button" onClick={() => openEditCastEditor(member)}>
                      <Pencil size={14} />
                      编辑
                    </button>
                    <button type="button" onClick={() => setCastDeleteTargetId(member.id)}>
                      <Trash2 size={14} />
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="cocreate-section-title">
              <span>DOSSIER</span>
              <strong>人物关系档案</strong>
            </div>
            <div className="cocreate-dossier-links" aria-label="角色与关系状态">
              <div>
                <span>{session.cast.length}</span>
                <strong>角色档案</strong>
              </div>
              <div>
                <span>{session.relationshipDossier?.trim() ? "ON" : "EMPTY"}</span>
                <strong>关系档案</strong>
              </div>
              <div>
                <span>{hiddenSecretCount}/{hiddenSecretCount + revealedSecretCount}</span>
                <strong>隐藏暗线</strong>
              </div>
            </div>
            <article className="cocreate-memory-card cocreate-dossier-card">
              <span>RELATIONSHIP DOSSIER</span>
              <p>{session.relationshipDossier?.trim() || "当前还没有人物关系档案。角色可以通过可执行动作整理并提交更新，确认后会保存在这里。"}</p>
            </article>

            <div className="cocreate-section-title cocreate-section-title-action cocreate-notebook-title">
              <div>
                <span>WRITER NOTEBOOK</span>
                <strong>创作笔记本</strong>
              </div>
              <button
                type="button"
                className="cocreate-mini-action"
                onClick={saveWriterNotebook}
                disabled={!writerNotebookDirty}
              >
                <Check size={13} />
                保存
              </button>
            </div>
            <article className="cocreate-memory-card cocreate-notebook-card">
              <span>每轮注入</span>
              <p>AI 自行维护，并在每轮共创时注入给它的作品笔记本；你也可以手动编辑。</p>
              <textarea
                value={writerNotebookDraft}
                onChange={(event) => {
                  setWriterNotebookDraft(event.target.value);
                  setWriterNotebookDirty(true);
                }}
                placeholder="还没有笔记。AI 会在需要稳定故事大纲、伏笔、人物连续性、核心设定和后续计划时维护这里。"
                rows={8}
              />
            </article>
          </section>
        )}

        {view === "chapters" && (
          <section className="cocreate-index-panel">
            <div className="cocreate-section-title cocreate-section-title-action cocreate-chapter-index-title">
              <div>
                <span>CHAPTER INDEX</span>
                <strong>章节目录</strong>
              </div>
              <button type="button" className="cocreate-mini-action" onClick={createManualChapter}>
                <Plus size={13} />
                新增章节
              </button>
            </div>
            <div className="cocreate-stat-row">
              <div>
                <span>// WORDS</span>
                <strong>{chapterWords.toLocaleString()}</strong>
                <small>总字数</small>
              </div>
              <div>
                <span>// CHAPTERS</span>
                <strong>{session.chapters.filter((chapter) => Boolean(chapter.archivedAt)).length}/{session.chapters.length}</strong>
                <small>完成章节</small>
              </div>
              <div>
                <span>// MEMORY</span>
                <strong>{session.rollingSummary ? "ON" : "READY"}</strong>
                <small>共享记忆</small>
              </div>
            </div>

            <div className="cocreate-chapter-list">
              {session.chapters.length === 0 && (
                <div className="cocreate-empty">还没有章节目录，先创建一个章节，然后开始写作吧~</div>
              )}
              {session.chapters.map((chapter) => (
                <article
                  key={chapter.id}
                  className="cocreate-chapter-row"
                  data-active={chapter.id === session.activeChapterId ? "1" : undefined}
                  onClick={() => persistSession({ ...session, activeChapterId: chapter.id })}
                  role="button"
                  tabIndex={0}
                  aria-current={chapter.id === session.activeChapterId ? "true" : undefined}
                  aria-label={`设为当前章节：第 ${chapter.num} 章`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      persistSession({ ...session, activeChapterId: chapter.id });
                    }
                  }}
                >
                  <button
                    type="button"
                    className="cocreate-chapter-main"
                    onClick={(event) => {
                      event.stopPropagation();
                      persistSession({ ...session, activeChapterId: chapter.id });
                    }}
                  >
                    <span>{chapter.num}</span>
                    <strong>{chapter.title}</strong>
                    <small>{chapter.titleEn}</small>
                    <em>{chapterStatusLabel(chapter)}</em>
                  </button>
                  <button
                    type="button"
                    className="cocreate-chapter-edit"
                    onClick={(event) => {
                      event.stopPropagation();
                      openChapterReader(chapter);
                    }}
                    aria-label={`打开第 ${chapter.num} 章`}
                    title="阅读章节"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="cocreate-chapter-delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      setChapterDeleteTargetId(chapter.id);
                    }}
                    aria-label={`删除第 ${chapter.num} 章`}
                    title="删除章节"
                  >
                    <Trash2 size={14} />
                  </button>
                </article>
              ))}
            </div>

            {recentRevisions.length > 0 && (
              <section className="cocreate-revision-panel">
                <div className="cocreate-section-title">
                  <span>REVISIONS</span>
                  <strong>最近修订</strong>
                </div>
                <div className="cocreate-revision-list">
                  {recentRevisions.map((revision) => (
                    <article key={revision.id}>
                      <div>
                        <span>{formatShortDate(revision.createdAt)}</span>
                        <strong>{revision.summary}</strong>
                      </div>
                      <button type="button" onClick={() => rollbackRevision(revision.id)} aria-label="回滚这次修订">
                        <RotateCcw size={14} />
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )}
            <button type="button" className="cocreate-export-button" onClick={exportManuscriptTxt}>
              <Copy size={14} />
              EXPORT TXT // 导出完整故事
            </button>
          </section>
        )}

        {view === "chapterReader" && editingChapter && (
          <section className="cocreate-reader-panel">
            <div
              className="cocreate-reader-masthead"
              data-editing={chapterReaderEditing ? "1" : undefined}
            >
              <span>CHAPTER.{editingChapter.num}</span>
              <h1
                ref={readerTitleRef}
                contentEditable={chapterReaderEditing}
                suppressContentEditableWarning
                data-placeholder="未命名章节"
              >
                {chapterReaderEditing ? null : editingChapter.title}
              </h1>
              <p
                ref={readerTitleEnRef}
                contentEditable={chapterReaderEditing}
                suppressContentEditableWarning
                data-placeholder={`CHAPTER ${editingChapter.num}`}
              >
                {chapterReaderEditing ? null : editingChapter.titleEn}
              </p>
              <i aria-hidden="true" />
            </div>

            {(editingChapter.summary?.trim() || chapterReaderEditing) && (
              <aside
                ref={readerSummaryRef}
                className="cocreate-reader-sticky cocreate-reader-sticky-summary"
                data-editing={chapterReaderEditing ? "1" : undefined}
                data-placeholder="章节摘要（自动归档会覆盖）"
                contentEditable={chapterReaderEditing}
                suppressContentEditableWarning
                aria-multiline={chapterReaderEditing ? true : undefined}
                aria-label="章节摘要"
              >
                {chapterReaderEditing
                  ? null
                  : editingChapter.summary?.trim() ? (
                    <>
                      <span className="cocreate-sticky-label">CHAPTER SUMMARY</span>
                      <CoCreateMarkdown content={editingChapter.summary} />
                    </>
                  ) : null}
              </aside>
            )}

            <article
              ref={readerBodyRef}
              className="cocreate-reader-body"
              data-editing={chapterReaderEditing ? "1" : undefined}
              data-placeholder="这一章还没有正文。点击右上角编辑按钮开始写入。"
              contentEditable={chapterReaderEditing}
              suppressContentEditableWarning
              aria-multiline={chapterReaderEditing ? true : undefined}
              aria-label={chapterReaderEditing ? `正在编辑第 ${editingChapter.num} 章正文` : `第 ${editingChapter.num} 章正文`}
            >
              {chapterReaderEditing
                ? null
                : editingChapter.content?.trim() ? (
                  <CoCreateMarkdown content={editingChapter.content} />
                ) : (
                  <div className="cocreate-reader-empty">
                    <span>EMPTY PAGE</span>
                    <p>这一章还没有正文。点击页面开始编辑。</p>
                  </div>
                )}
            </article>

            {chapterReaderEditing && (
              <div className="cocreate-reader-actions" aria-label="章节编辑操作">
                <button type="button" onClick={discardChapterReaderEdit} aria-label="丢弃修改" title="丢弃修改">
                  <X size={18} />
                </button>
                <button type="button" onClick={saveChapterEdit} aria-label="保存修改" title="保存修改">
                  <Check size={18} />
                </button>
              </div>
            )}

            {editingChapter.archiveNote?.trim() && !chapterReaderEditing && (
              <aside className="cocreate-reader-sticky cocreate-reader-sticky-note">
                <span className="cocreate-sticky-label">ARCHIVE NOTE</span>
                <CoCreateMarkdown content={editingChapter.archiveNote} />
              </aside>
            )}
          </section>
        )}
          </>
        )}
      </main>

      {view === "library" && (
        <button
          type="button"
          className="cocreate-floating-new-work"
          onClick={openNewWorkDialog}
          aria-label="新增作品"
        >
          <Plus size={19} />
        </button>
      )}

      {view === "write" && (
        <footer className="cocreate-composer">
          <div className="cocreate-mode-toggle" role="group" aria-label="共创模式">
            <button type="button" data-active={mode === "write" ? "1" : undefined} onClick={() => setMode("write")}>
              正文
            </button>
            <button type="button" data-active={mode === "discuss" ? "1" : undefined} onClick={() => setMode("discuss")}>
              讨论
            </button>
          </div>
          <div className="cocreate-mode-indicator">{mode === "write" ? "// WRITE" : "// CHAT"}</div>
          <div className="cocreate-input-row">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder={mode === "write" ? "写正文、续写或提出修改……" : `和${partner?.name || "搭档"}聊聊……`}
              rows={1}
            />
            <button
              type="button"
              className="cocreate-archive-button"
              onClick={() => setArchiveConfirmOpen(true)}
              disabled={!canSummarizeMemory}
              aria-label="总结会话记忆"
              title={`总结记忆（自上次以来 ${sessionMessagesSinceLastSummary} 条）`}
            >
              {isArchiving ? <Loader2 size={16} /> : <Archive size={16} />}
            </button>
            <button
              type="button"
              className={isGenerating ? "cocreate-stop-button" : undefined}
              onClick={() => {
                if (isGenerating) {
                  generationAbortRef.current?.abort();
                } else {
                  void handleSend();
                }
              }}
              disabled={isGenerating ? !generationAbortRef.current : (!input.trim() || isArchiving)}
              aria-label={isGenerating ? "停止生成" : "发送"}
              title={isGenerating ? "停止生成" : undefined}
            >
              {isGenerating ? <Square size={14} fill="currentColor" /> : <Send size={16} />}
            </button>
          </div>
        </footer>
      )}

      {view !== "library" && pendingMutations.length > 0 && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-pending-panel" role="dialog" aria-modal="true" aria-labelledby="cocreate-pending-title">
            <div className="cocreate-pending-head">
              <span>PENDING PATCH</span>
              <strong id="cocreate-pending-title">{pendingMutations.length} 条待确认</strong>
            </div>
            <div className="cocreate-pending-list">
              {pendingMutations.map((mutation) => (
                <article key={mutation.id}>
                  <div className="cocreate-pending-item-head">
                    <span>{mutation.toolName}</span>
                    <time>{formatShortDate(mutation.createdAt)}</time>
                  </div>
                  {pendingMutationTargetLabel(mutation) && (
                    <div className="cocreate-pending-target">
                      {pendingMutationTargetLabel(mutation)}
                    </div>
                  )}
                  <p>{mutation.summary}</p>
                  {(mutation.beforePreview || mutation.afterPreview) && (
                    <div className="cocreate-pending-diff">
                      {mutation.beforePreview && (
                        <div className="cocreate-diff-before">
                          <span>BEFORE</span>
                          <p>{mutation.beforePreview}</p>
                        </div>
                      )}
                      {mutation.afterPreview && (
                        <div className="cocreate-diff-after">
                          <span>AFTER</span>
                          <p>{mutation.afterPreview}</p>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="cocreate-pending-actions">
                    <button type="button" onClick={() => rejectPendingMutation(mutation.id)} disabled={isArchiving}>
                      <X size={14} />
                      取消
                    </button>
                    <button type="button" onClick={() => confirmPendingMutation(mutation.id)} disabled={isArchiving}>
                      <Check size={14} />
                      应用修改
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {archiveConfirmOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-archive-title">
            <span>SESSION MEMORY</span>
            <h2 id="cocreate-archive-title">总结最近 {sessionMessagesSinceLastSummary} 条对话？</h2>
            <p>
              把自上次记忆总结以来累积的 {sessionMessagesSinceLastSummary} 条对话压缩成一条记忆条目，注入短期记忆库供后续创作参考。
            </p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setArchiveConfirmOpen(false)}>取消</button>
              <button type="button" onClick={() => void handleSummarizeSessionMemory()} disabled={isArchiving || !canSummarizeMemory}>
                {isArchiving ? "总结中" : "确认总结"}
              </button>
            </div>
          </section>
        </div>
      )}

      {chapterExitConfirmOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-reader-exit-title">
            <span>UNSAVED EDIT</span>
            <h2 id="cocreate-reader-exit-title">丢弃现有修改？</h2>
            <p>
              当前章节还有未保存的编辑内容。离开页面会丢弃这些修改，保存后再退出可以保留本次编辑。
            </p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setChapterExitConfirmOpen(false)}>继续编辑</button>
              <button type="button" className="cocreate-danger-action" onClick={() => leaveChapterReader(chapterExitTarget)}>
                丢弃修改
              </button>
            </div>
          </section>
        </div>
      )}

      {toolHistoryClearConfirmOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-tool-clear-title">
            <span>TOOL HISTORY</span>
            <h2 id="cocreate-tool-clear-title">清理工具调用历史？</h2>
            <p>将移除当前作品中的工具调用记录、工具结果记录，并清除助手消息里的原生工具调用元数据。普通共创内容不会删除。</p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setToolHistoryClearConfirmOpen(false)}>取消</button>
              <button type="button" className="cocreate-danger-action" onClick={clearCurrentWorkToolHistory}>
                清理
              </button>
            </div>
          </section>
        </div>
      )}

      {backendLogOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-backend-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-backend-title">
            <div className="cocreate-backend-head">
              <div>
                <span>BACKSTAGE LOG</span>
                <h2 id="cocreate-backend-title">后台记录</h2>
                <p>最近 {session.backendLogs?.length || 0} 条生成、归档、报错和原始输出。</p>
              </div>
              <button type="button" onClick={() => setBackendLogOpen(false)} aria-label="关闭后台记录">
                <X size={15} />
              </button>
            </div>
            <button
              type="button"
              className="cocreate-backend-clear-tools"
              disabled={isGenerating || isArchiving || !hasCurrentWorkToolHistory}
              onClick={() => setToolHistoryClearConfirmOpen(true)}
            >
              <strong>清理原生tool调用历史——防报错</strong>
              <small>只清理当前作品的工具调用、工具结果和原生回放元数据；普通共创内容不会删除。</small>
            </button>
            <div className="cocreate-backend-list">
              {(!session.backendLogs || session.backendLogs.length === 0) && (
                <div className="cocreate-backend-empty">暂无后台记录。触发生成、归档或报错后会显示在这里。</div>
              )}
              {[...(session.backendLogs || [])].reverse().map((log) => (
                <article key={log.id} className="cocreate-backend-item" data-status={log.status}>
                  <div className="cocreate-backend-item-head">
                    <div>
                      <span>{backendLogKindLabel(log.kind)} · {log.status === "success" ? "SUCCESS" : "ERROR"}</span>
                      <strong>{log.title}</strong>
                    </div>
                    <time>{formatBackendLogTime(log.createdAt)}</time>
                  </div>
                  <div className="cocreate-backend-meta">
                    {log.chapterNum && <span>CH.{log.chapterNum}</span>}
                    {log.mode && <span>{log.mode}</span>}
                    {log.model && <span>{log.model}</span>}
                    {log.presetName && <span>{log.presetName}</span>}
                  </div>
                  {log.error && (
                    <div className="cocreate-backend-copy-block">
                      <button type="button" onClick={() => copyTextToClipboard(log.error || "", onNotice)} aria-label="复制错误信息">
                        <Copy size={12} />
                        <span>复制</span>
                      </button>
                      <pre className="cocreate-backend-error">{log.error}</pre>
                    </div>
                  )}
                  {log.toolNotices && log.toolNotices.length > 0 && (
                    <div className="cocreate-backend-notices">
                      {log.toolNotices.map((notice, index) => <span key={`${log.id}_notice_${index}`}>{notice}</span>)}
                    </div>
                  )}
                  {log.toolDebugs?.map((debug, index) => (
                    <details key={`${log.id}_debug_${index}`}>
                      <summary>
                        解析诊断 {log.toolDebugs && log.toolDebugs.length > 1 ? index + 1 : ""}
                        <button type="button" onClick={(event) => { event.preventDefault(); copyTextToClipboard(debug, onNotice); }}>
                          <Copy size={12} />
                          <span>复制</span>
                        </button>
                      </summary>
                      <pre>{debug}</pre>
                    </details>
                  ))}
                  {log.input && (
                    <details>
                      <summary>
                        用户输入
                        <button type="button" onClick={(event) => { event.preventDefault(); copyTextToClipboard(log.input || "", onNotice); }}>
                          <Copy size={12} />
                          <span>复制</span>
                        </button>
                      </summary>
                      <pre>{log.input}</pre>
                    </details>
                  )}
                  {log.rawOutput && (
                    <details>
                      <summary>
                        原始输出
                        <button type="button" onClick={(event) => { event.preventDefault(); copyTextToClipboard(log.rawOutput || "", onNotice); }}>
                          <Copy size={12} />
                          <span>复制</span>
                        </button>
                      </summary>
                      <pre>{log.rawOutput}</pre>
                    </details>
                  )}
                  {log.rawOutputs?.map((raw, index) => (
                    <details key={`${log.id}_raw_${index}`}>
                      <summary>
                        原始输出 {log.rawOutputs && log.rawOutputs.length > 1 ? index + 1 : ""}
                        <button type="button" onClick={(event) => { event.preventDefault(); copyTextToClipboard(raw, onNotice); }}>
                          <Copy size={12} />
                          <span>复制</span>
                        </button>
                      </summary>
                      <pre>{raw}</pre>
                    </details>
                  ))}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {newWorkOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-work-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-new-work-title">
            <span>NEW WORK</span>
            <h2 id="cocreate-new-work-title">新增作品</h2>
            <p>作品会拥有独立的章节、角色档案和共享记忆。进入作品后可在设置里修改作品名。</p>
            <label className="cocreate-text-field">
              <span>作品名</span>
              <input
                value={newWorkTitle}
                onChange={(event) => setNewWorkTitle(event.target.value)}
                placeholder="例如：雨夜档案"
              />
            </label>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setNewWorkOpen(false)}>取消</button>
              <button type="button" onClick={createWork}>创建</button>
            </div>
          </section>
        </div>
      )}

      {editingWork && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-work-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-edit-work-title">
            <span>EDIT WORK</span>
            <h2 id="cocreate-edit-work-title">编辑作品信息</h2>
            <label className="cocreate-text-field">
              <span>作品名</span>
              <input
                value={editingWorkTitle}
                onChange={(event) => setEditingWorkTitle(event.target.value)}
                placeholder="作品标题"
              />
            </label>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setEditingWorkId(null)}>取消</button>
              <button type="button" onClick={saveWorkEdit}>保存</button>
            </div>
          </section>
        </div>
      )}

      {workDeleteTarget && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-work-delete-title">
            <span>DELETE WORK</span>
            <h2 id="cocreate-work-delete-title">删除这本作品？</h2>
            <p>《{workDeleteTarget.title}》的章节、角色档案、动作记录会被删除；该作品写入的共创短期记忆和相关长期记忆也会一起清理。</p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setWorkDeleteTargetId(null)} disabled={isDeletingWork}>取消</button>
              <button type="button" className="cocreate-danger-action" onClick={() => void deleteWork()} disabled={isDeletingWork}>
                {isDeletingWork ? "删除中" : "确认删除"}
              </button>
            </div>
          </section>
        </div>
      )}

      {chapterDeleteTarget && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-chapter-delete-title">
            <span>DELETE CHAPTER</span>
            <h2 id="cocreate-chapter-delete-title">删除这一章？</h2>
            <p>第 {chapterDeleteTarget.num} 章《{chapterDeleteTarget.title}》会被删除；对应对话、修订、待确认修改和动作记录也会一起移除。删除后章节序号会自动重排。</p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setChapterDeleteTargetId(null)}>取消</button>
              <button type="button" className="cocreate-danger-action" onClick={() => deleteChapter(chapterDeleteTarget)}>
                确认删除
              </button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-settings-title">
            <div className="cocreate-settings-scroll">
              <span>SETTINGS</span>
              <h2 id="cocreate-settings-title">共创全局设置</h2>
              <p>这些设置对所有作品生效。当前章节会完整传入；已结束章节中，最近 N 章传全文，更早章节只传标题和摘要。</p>
              <button
                type="button"
                className="cocreate-setting-toggle"
                data-active={sharedSettings.streamingEnabled ? "1" : undefined}
                aria-pressed={sharedSettings.streamingEnabled}
                onClick={() => setStreamingEnabled(!sharedSettings.streamingEnabled)}
              >
                <span>
                  <strong>流式输出</strong>
                  <small>部分 API 支持；不支持时自动使用普通生成。</small>
                </span>
                <em>{sharedSettings.streamingEnabled ? "ON" : "OFF"}</em>
              </button>
              <button
                type="button"
                className="cocreate-setting-toggle"
                data-active={sharedSettings.autoAccept ? "1" : undefined}
                aria-pressed={sharedSettings.autoAccept}
                onClick={() => setAutoAccept(!sharedSettings.autoAccept)}
              >
                <span>
                  <strong>自动接受 AI 修改</strong>
                  <small>开启：AI 的追加 / 编辑 / 删除立刻生效（章节变更可回滚）。关闭：每条修改进入待确认队列。</small>
                </span>
                <em>{sharedSettings.autoAccept ? "ON" : "OFF"}</em>
              </button>
              <label className="cocreate-setting-field">
                <span>传入最近{sharedSettings.recentFullTextChapters}章全文章节</span>
                <div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    value={sharedSettings.recentFullTextChapters}
                    onChange={(event) => updateRecentFullTextChapters(Number(event.target.value))}
                    aria-label="传入最近全文章节数量"
                  />
                </div>
              </label>
              <label className="cocreate-setting-field">
                <span>会话记忆自动总结：每 {sharedSettings.memorySummaryInterval} 条对话</span>
                <div className="cocreate-setting-field-row">
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={1}
                    value={sharedSettings.memorySummaryInterval}
                    onChange={(event) => updateMemorySummaryInterval(Number(event.target.value))}
                    aria-label="自动总结间隔（条数）"
                  />
                  <button
                    type="button"
                    className="cocreate-setting-inline-button"
                    disabled={!canSummarizeMemory}
                    onClick={() => { setSettingsOpen(false); void handleSummarizeSessionMemory(); }}
                  >
                    立即总结
                  </button>
                </div>
                <small className="cocreate-setting-hint">
                  从上次总结后累计 {sessionMessagesSinceLastSummary} 条；达到间隔会自动触发。
                </small>
              </label>
              <div className="cocreate-tool-settings">
                <div className="cocreate-tool-settings-head">
                  <div>
                    <span>ACTIONS</span>
                    <strong>共创动作</strong>
                  </div>
                  <em>{enabledToolCount}/{COCREATE_TOOL_DEFINITIONS.length} ON</em>
                </div>
                <div className="cocreate-tool-bulk-actions">
                  <button type="button" onClick={() => setAllToolsEnabled(true)}>全部开启</button>
                  <button type="button" onClick={() => setAllToolsEnabled(false)}>全部关闭</button>
                </div>
                <div className="cocreate-tool-toggle-list">
                  {COCREATE_TOOL_DEFINITIONS.map((tool) => {
                    const enabled = !disabledToolSet.has(tool.name);
                    return (
                      <button
                        type="button"
                        key={tool.name}
                        className="cocreate-tool-toggle"
                        data-active={enabled ? "1" : undefined}
                        aria-pressed={enabled}
                        onClick={() => setToolEnabled(tool.name, !enabled)}
                      >
                        <span>
                          <strong>{tool.label}</strong>
                          <small>{tool.category === "read" ? "READ" : "PATCH"}</small>
                        </span>
                        <em>{enabled ? "ON" : "OFF"}</em>
                        <p>{tool.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setSettingsOpen(false)}>关闭</button>
              <button type="button" onClick={() => setSettingsOpen(false)}>完成</button>
            </div>
          </section>
        </div>
      )}

      {castEditorOpen && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog cocreate-cast-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-cast-editor-title">
            <span>CAST FILE</span>
            <h2 id="cocreate-cast-editor-title">{editingCast ? "编辑角色档案" : "新增角色档案"}</h2>
            <div className="cocreate-cast-form">
              <label>
                <span>姓名</span>
                <input
                  value={castForm.name}
                  onChange={(event) => updateCastFormField("name", event.target.value)}
                  placeholder="例如：贺谨言"
                />
              </label>
              <label>
                <span>身份</span>
                <input
                  value={castForm.role}
                  onChange={(event) => updateCastFormField("role", event.target.value)}
                  placeholder="次兄 // YOUNGER BROTHER"
                />
              </label>
              <label>
                <span>颜色</span>
                <div className="cocreate-color-picker" role="group" aria-label="角色颜色">
                  {CAST_COLOR_SWATCHES.map((color) => (
                    <button
                      type="button"
                      key={color}
                      style={{ "--cc-swatch": color } as CSSProperties}
                      data-active={castForm.color === color ? "1" : undefined}
                      onClick={() => updateCastFormField("color", color)}
                      aria-label={`选择颜色 ${color}`}
                    />
                  ))}
                </div>
              </label>
              <label>
                <span>位置 / 背景</span>
                <input
                  value={castForm.major}
                  onChange={(event) => updateCastFormField("major", event.target.value)}
                  placeholder="A中 // 高二"
                />
              </label>
              <label>
                <span>人物标签</span>
                <input
                  value={castForm.label}
                  onChange={(event) => updateCastFormField("label", event.target.value)}
                  placeholder="失控的玩偶"
                />
              </label>
              <label>
                <span>公开设定</span>
                <textarea
                  value={castForm.desc}
                  onChange={(event) => updateCastFormField("desc", event.target.value)}
                  placeholder="写给 AI 可见的角色介绍"
                  rows={3}
                />
              </label>
              <label>
                <span>暗线设定</span>
                <textarea
                  value={castForm.secret}
                  onChange={(event) => updateCastFormField("secret", event.target.value)}
                  placeholder="默认对 AI 隐藏，揭示后才进入上下文"
                  rows={2}
                />
              </label>
              <label className="cocreate-checkbox-field">
                <input
                  type="checkbox"
                  checked={castForm.secretHidden}
                  onChange={(event) => updateCastFormField("secretHidden", event.target.checked)}
                />
                <span>暗线暂时隐藏，不传给 AI</span>
              </label>
            </div>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setCastEditorOpen(false)}>取消</button>
              <button type="button" onClick={saveCastForm}>
                {editingCast ? "保存修改" : "新增角色"}
              </button>
            </div>
          </section>
        </div>
      )}

      {castDeleteTarget && (
        <div className="cocreate-modal-backdrop" role="presentation">
          <section className="cocreate-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="cocreate-cast-delete-title">
            <span>DELETE FILE</span>
            <h2 id="cocreate-cast-delete-title">删除角色档案？</h2>
            <p>这会从当前共创 session 中移除“{castDeleteTarget.name}”的小说角色档案，但不会删除你的角色卡。</p>
            <div className="cocreate-archive-actions">
              <button type="button" onClick={() => setCastDeleteTargetId(null)}>取消</button>
              <button type="button" onClick={deleteCastMember}>确认删除</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
