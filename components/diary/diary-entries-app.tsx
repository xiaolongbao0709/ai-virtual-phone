"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type PointerEvent } from "react";
import { Bot, ChevronLeft, Clock3, NotebookPen, Trash2, WandSparkles, X } from "lucide-react";
import { DotsThree } from "@phosphor-icons/react";

import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateDiaryEntryForCharacter } from "@/lib/diary-entry-engine";
import { useDiaryGenerating } from "@/lib/diary-generating-tracker";
import {
  DIARY_ENTRIES_UPDATED_EVENT,
  DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT,
} from "@/lib/diary-entry-timer-service";
import {
  createDiaryEntry,
  deleteDiaryEntry,
  loadDiaryEntries,
  loadDiaryEntryFontAssetId,
  loadDiaryEntryFontScale,
  loadDiaryEntryTimerSettings,
  loadDiaryReplyRules,
  resolveDiaryReplyRule,
  saveDiaryEntryFontAssetId,
  saveDiaryEntryFontScale,
  saveDiaryEntryTimerSettings,
  saveDiaryReplyRules,
  updateDiaryEntry,
} from "@/lib/diary-entry-storage";
import type {
  DiaryEntry,
  DiaryEntryAuthorType,
  DiaryEntryBlock,
  DiaryEntryTimerSettings,
  DiaryEntryTrigger,
  DiaryReplyMode,
  DiaryReplyRules,
} from "@/lib/diary-entry-types";
import { cancelDiaryReply, scheduleDiaryReply } from "@/lib/diary-reply-service";
import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "@/lib/theme-storage";

// TA的日记和我的日记各自独立一套字体，互不影响，跟以前双日记插件的行为一致。
function diaryFontFamilyName(kind: DiaryEntryAuthorType): string {
  return kind === "user" ? "AIPhoneDiaryEntryUserWriterFont" : "AIPhoneDiaryEntryCharacterFont";
}
function diaryFontStyleId(kind: DiaryEntryAuthorType): string {
  return kind === "user" ? "ai-phone-diary-entry-user-writer-font-face" : "ai-phone-diary-entry-character-font-face";
}

const DIARY_REPLY_MODE_LABELS: Record<DiaryReplyMode, string> = {
  none: "不回应",
  immediate: "立即回应",
  delay: "延时回应",
  merge: "和下次互动合并",
};

type DiaryEntriesAppProps = {
  /** "character" = TA的日记（角色自己写，AI 生成）；"user" = 我的日记（用户手写，给角色看） */
  kind: DiaryEntryAuthorType;
  onBack: () => void;
  onNotice?: (message: string) => void;
};

type DiaryBook = {
  characterId: string;
  characterName: string;
  avatar: string;
  entries: DiaryEntry[];
};

type ComposeTarget =
  | { mode: "create"; characterId: string }
  | { mode: "edit"; entry: DiaryEntry };

type DiaryEntryDragState = {
  entry: DiaryEntry;
  x: number;
  y: number;
  width: number;
  height: number;
  isOverTrash: boolean;
};

type DiaryEntryDragSession = {
  entry: DiaryEntry;
  pointerId: number;
  target: HTMLButtonElement;
  startX: number;
  startY: number;
  width: number;
  height: number;
  timer: number | null;
  dragging: boolean;
};

type DiaryEntryDragScrollLock = {
  bodyOverflow: string;
  bodyTouchAction: string;
  htmlOverscrollBehavior: string;
  htmlTouchAction: string;
  main: HTMLElement | null;
  mainOverflow: string;
  mainTouchAction: string;
  mainScrollTop: number;
};

function formatEntryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "未知时间";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function blockPlainText(block: DiaryEntryBlock): string {
  if (block.type === "paragraph" || block.type === "quote") return block.text;
  if (block.type === "correction") return block.replacement || block.text;
  if (block.type === "image") return block.caption || block.description;
  if (block.type === "todo") return block.items.map(item => item.text).join(" / ");
  return "";
}

function getEntryMarkers(entry: DiaryEntry): string[] {
  return Array.from(new Set([
    entry.mood,
    ...entry.tags,
    entry.weather,
  ].map(item => item.trim()).filter(Boolean))).slice(0, 4);
}

function DiaryWritingStatus({ label = "写入中" }: { label?: string }) {
  return (
    <span className="diary-writing-status" aria-label={label}>
      <span>{label}</span>
      <span className="diary-writing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function DiaryEntriesApp({ kind, onBack, onNotice }: DiaryEntriesAppProps) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [settings, setSettings] = useState<DiaryEntryTimerSettings>(() => loadDiaryEntryTimerSettings());
  const [replyRules, setReplyRules] = useState<DiaryReplyRules>(() => loadDiaryReplyRules());
  const [timerSettingsOpen, setTimerSettingsOpen] = useState(false);
  const [replySettingsOpen, setReplySettingsOpen] = useState(false);
  const [writePanelOpen, setWritePanelOpen] = useState(false);
  const [composeTarget, setComposeTarget] = useState<ComposeTarget | null>(null);
  const [composePickerOpen, setComposePickerOpen] = useState(false);
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const [activeEntry, setActiveEntry] = useState<DiaryEntry | null>(null);
  const [deleteCandidateEntry, setDeleteCandidateEntry] = useState<DiaryEntry | null>(null);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [localGeneratingIds, setGeneratingCharacterIds] = useState<string[]>([]);
  const [diaryFontAssetId, setDiaryFontAssetId] = useState<string | null>(() => loadDiaryEntryFontAssetId(kind));
  const [diaryFontDataUrl, setDiaryFontDataUrl] = useState<string | null>(null);
  const [diaryFontScale, setDiaryFontScale] = useState<number>(() => loadDiaryEntryFontScale(kind));
  // Merge in the module-level tracker so background generation (timer, or a
  // batch started before leaving the app) is visible again after re-entry.
  const trackedGeneratingIds = useDiaryGenerating();
  const generatingCharacterIds = useMemo(
    () => Array.from(new Set([...localGeneratingIds, ...trackedGeneratingIds])),
    [localGeneratingIds, trackedGeneratingIds],
  );
  const [entryDrag, setEntryDrag] = useState<DiaryEntryDragState | null>(null);
  const entryMainRef = useRef<HTMLElement | null>(null);
  const entryTrashRef = useRef<HTMLDivElement | null>(null);
  const fontFileRef = useRef<HTMLInputElement | null>(null);
  const entryDragRef = useRef<DiaryEntryDragSession | null>(null);
  const entryDragClickSuppressedRef = useRef(false);
  const entryDragClickSuppressTimerRef = useRef<number | null>(null);
  const entryDragScrollLockRef = useRef<DiaryEntryDragScrollLock | null>(null);
  const entryDragTouchMoveBlockerRef = useRef<((event: globalThis.TouchEvent) => void) | null>(null);

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  const refreshEntries = useCallback(() => {
    setEntries(loadDiaryEntries());
  }, []);

  useEffect(() => {
    if (!diaryFontAssetId) {
      setDiaryFontDataUrl(null);
      return;
    }
    let cancelled = false;
    void getThemeAssetDataUrl(diaryFontAssetId).then((dataUrl) => {
      if (cancelled) return;
      if (dataUrl) {
        setDiaryFontDataUrl(dataUrl);
        return;
      }
      saveDiaryEntryFontAssetId(null, kind);
      setDiaryFontAssetId(null);
      setDiaryFontDataUrl(null);
      notify("日记字体资源丢失，已恢复默认字体");
    }).catch(() => {
      if (cancelled) return;
      setDiaryFontDataUrl(null);
      notify("日记字体加载失败，暂时使用默认字体");
    });
    return () => { cancelled = true; };
  }, [diaryFontAssetId, kind, notify]);

  useEffect(() => {
    const styleId = diaryFontStyleId(kind);
    let node = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!node) {
      node = document.createElement("style");
      node.id = styleId;
      document.head.append(node);
    }
    node.textContent = diaryFontDataUrl
      ? `@font-face{font-family:"${diaryFontFamilyName(kind)}";src:url("${diaryFontDataUrl}");font-display:swap;}`
      : "";
  }, [diaryFontDataUrl, kind]);

  const handleDiaryFontUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const assetId = await saveThemeAssetFromBlob(file, "font");
      const dataUrl = await getThemeAssetDataUrl(assetId);
      if (!dataUrl) {
        throw new Error("字体资源没有保存成功");
      }
      saveDiaryEntryFontAssetId(assetId, kind);
      setDiaryFontAssetId(assetId);
      setDiaryFontDataUrl(dataUrl);
      notify(`日记字体已上传：${file.name}`);
    } catch (error) {
      notify("日记字体上传失败：" + String(error));
    }
  }, [kind, notify]);

  const handleDiaryFontScaleChange = useCallback((scale: number) => {
    const normalized = Math.min(1.25, Math.max(0.85, scale));
    setDiaryFontScale(normalized);
    saveDiaryEntryFontScale(normalized, kind);
  }, [kind]);

  const handleDiaryFontReset = useCallback(() => {
    saveDiaryEntryFontAssetId(null, kind);
    saveDiaryEntryFontScale(1, kind);
    setDiaryFontAssetId(null);
    setDiaryFontDataUrl(null);
    setDiaryFontScale(1);
    notify("已恢复默认日记字体");
  }, [kind, notify]);

  const diaryEntryStyle = useMemo(() => {
    return {
      ...(diaryFontDataUrl
        ? { "--diary-entry-font-family": `"${diaryFontFamilyName(kind)}", "NoteWall Ximai", var(--app-font-family)` }
        : {}),
      "--diary-entry-font-scale": String(diaryFontScale),
    } as CSSProperties;
  }, [diaryFontDataUrl, diaryFontScale, kind]);

  const deleteEntry = useCallback((entry: DiaryEntry) => {
    deleteDiaryEntry(entry.id);
    cancelDiaryReply(entry.id);
    setActiveEntry(current => current?.id === entry.id ? null : current);
    setDeleteCandidateEntry(current => current?.id === entry.id ? null : current);
    refreshEntries();
    notify(`已删除${entry.authorType === "user" ? "" : ` ${entry.characterName}`}的日记。`);
  }, [notify, refreshEntries]);

  useEffect(() => {
    setCharacters(loadCharacters());
    refreshEntries();
  }, [refreshEntries]);

  useEffect(() => {
    saveDiaryEntryTimerSettings(settings);
    window.dispatchEvent(new CustomEvent(DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT));
  }, [settings]);

  useEffect(() => {
    saveDiaryReplyRules(replyRules);
  }, [replyRules]);

  useEffect(() => {
    const handleEntriesUpdated = () => {
      refreshEntries();
      setSettings(loadDiaryEntryTimerSettings());
    };
    window.addEventListener(DIARY_ENTRIES_UPDATED_EVENT, handleEntriesUpdated);
    return () => window.removeEventListener(DIARY_ENTRIES_UPDATED_EVENT, handleEntriesUpdated);
  }, [refreshEntries]);

  const resolveTargets = useCallback((characterIds: string[]): Character[] => {
    const stored = loadCharacters();
    const uniqueIds = Array.from(new Set(characterIds.filter(Boolean)));
    return uniqueIds
      .map(characterId => characters.find(item => item.id === characterId) ?? stored.find(item => item.id === characterId))
      .filter(Boolean) as Character[];
  }, [characters]);

  const generateForCharacters = useCallback(async (characterIds: string[], trigger: DiaryEntryTrigger = "manual") => {
    const targets = resolveTargets(characterIds);
    if (targets.length === 0) {
      notify("找不到角色。");
      return;
    }

    const targetIds = targets.map(character => character.id);
    setGeneratingCharacterIds(prev => Array.from(new Set([...prev, ...targetIds])));
    try {
      const baseEntries = loadDiaryEntries();
      const results = await Promise.all(targets.map(async character => {
        try {
          return {
            status: "fulfilled" as const,
            character,
            draft: await generateDiaryEntryForCharacter(character.id, baseEntries, trigger),
          };
        } catch {
          return { status: "rejected" as const, character };
        }
      }));

      const createdEntries: DiaryEntry[] = [];
      const failedNames: string[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          failedNames.push(result.character.name);
          continue;
        }
        try {
          createdEntries.push(createDiaryEntry({
            characterId: result.character.id,
            characterName: result.character.name,
            title: result.draft.title,
            mood: result.draft.mood,
            weather: result.draft.weather,
            tags: result.draft.tags,
            body: result.draft.body,
            blocks: result.draft.blocks,
            trigger,
          }));
        } catch {
          failedNames.push(result.character.name);
        }
      }

      refreshEntries();
      if (createdEntries.length === 1 && failedNames.length === 0) {
        notify(`${createdEntries[0].characterName} 写了一篇日记。`);
      } else if (createdEntries.length > 0) {
        notify(`已生成 ${createdEntries.length} 篇日记${failedNames.length ? `，${failedNames.length} 个失败` : ""}。`);
      } else {
        notify(failedNames.length ? `日记生成失败：${failedNames.join("、")}` : "日记生成失败。");
      }
    } finally {
      setGeneratingCharacterIds(prev => prev.filter(id => !targetIds.includes(id)));
    }
  }, [notify, refreshEntries, resolveTargets]);

  const saveComposeEntry = useCallback((input: {
    characterId: string;
    title: string;
    mood: string;
    weather: string;
    tags: string[];
    signature: string;
    blocks: DiaryEntryBlock[];
  }, editingId?: string) => {
    // body 是给"近期日记"这类只读纯文本上下文用的摊平版本；用 blockPlainText 而不是只拼
    // paragraph/quote，这样 correction/todo/image 这些板块的内容也不会在摊平时丢掉。
    const body = input.blocks.map(blockPlainText).filter(Boolean).join("\n\n");
    if (!editingId) {
      const character = resolveTargets([input.characterId])[0];
      const created = createDiaryEntry({
        characterId: input.characterId,
        characterName: character?.name ?? "角色",
        authorType: kind,
        title: input.title,
        mood: input.mood,
        weather: input.weather,
        tags: input.tags,
        signature: input.signature,
        body,
        blocks: input.blocks,
        trigger: "manual",
      });
      refreshEntries();
      setComposeTarget(null);
      if (created.authorType === "user") scheduleDiaryReply(created);
      notify("日记已保存。");
      return;
    }
    const updated = updateDiaryEntry(editingId, {
      title: input.title,
      mood: input.mood,
      weather: input.weather,
      tags: input.tags,
      signature: input.signature,
      body,
      blocks: input.blocks,
    });
    refreshEntries();
    setComposeTarget(null);
    if (updated) setActiveEntry(current => (current && current.id === updated.id ? updated : current));
    notify("日记已更新。");
  }, [kind, notify, refreshEntries, resolveTargets]);

  const clearEntryDragTimer = useCallback(() => {
    const timer = entryDragRef.current?.timer;
    if (timer !== null && timer !== undefined) {
      window.clearTimeout(timer);
      if (entryDragRef.current) entryDragRef.current.timer = null;
    }
  }, []);

  const suppressEntryClick = useCallback((duration = 700) => {
    if (entryDragClickSuppressTimerRef.current !== null) {
      window.clearTimeout(entryDragClickSuppressTimerRef.current);
    }
    entryDragClickSuppressedRef.current = true;
    entryDragClickSuppressTimerRef.current = window.setTimeout(() => {
      entryDragClickSuppressedRef.current = false;
      entryDragClickSuppressTimerRef.current = null;
    }, duration);
  }, []);

  const lockEntryDragScroll = useCallback(() => {
    if (entryDragScrollLockRef.current || typeof document === "undefined") return;
    const main = entryMainRef.current;
    entryDragScrollLockRef.current = {
      bodyOverflow: document.body.style.overflow,
      bodyTouchAction: document.body.style.touchAction,
      htmlOverscrollBehavior: document.documentElement.style.overscrollBehavior,
      htmlTouchAction: document.documentElement.style.touchAction,
      main,
      mainOverflow: main?.style.overflow ?? "",
      mainTouchAction: main?.style.touchAction ?? "",
      mainScrollTop: main?.scrollTop ?? 0,
    };
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.documentElement.style.overscrollBehavior = "none";
    document.documentElement.style.touchAction = "none";
    if (!entryDragTouchMoveBlockerRef.current) {
      entryDragTouchMoveBlockerRef.current = (event: globalThis.TouchEvent) => {
        event.preventDefault();
      };
      document.addEventListener("touchmove", entryDragTouchMoveBlockerRef.current, { capture: true, passive: false });
    }
    if (main) {
      main.style.overflow = "hidden";
      main.style.touchAction = "none";
    }
  }, []);

  const unlockEntryDragScroll = useCallback(() => {
    const lock = entryDragScrollLockRef.current;
    if (!lock || typeof document === "undefined") return;
    document.body.style.overflow = lock.bodyOverflow;
    document.body.style.touchAction = lock.bodyTouchAction;
    document.documentElement.style.overscrollBehavior = lock.htmlOverscrollBehavior;
    document.documentElement.style.touchAction = lock.htmlTouchAction;
    if (entryDragTouchMoveBlockerRef.current) {
      document.removeEventListener("touchmove", entryDragTouchMoveBlockerRef.current, { capture: true });
      entryDragTouchMoveBlockerRef.current = null;
    }
    if (lock.main) {
      lock.main.style.overflow = lock.mainOverflow;
      lock.main.style.touchAction = lock.mainTouchAction;
      lock.main.scrollTop = lock.mainScrollTop;
    }
    entryDragScrollLockRef.current = null;
  }, []);

  const isEntryOverTrash = useCallback((clientX: number, clientY: number, width: number, height: number) => {
    const trashRect = entryTrashRef.current?.getBoundingClientRect();
    if (!trashRect) return false;
    const entryRect = {
      left: clientX - width / 2,
      right: clientX + width / 2,
      top: clientY - height / 2,
      bottom: clientY + height / 2,
    };
    return entryRect.left < trashRect.right
      && entryRect.right > trashRect.left
      && entryRect.top < trashRect.bottom
      && entryRect.bottom > trashRect.top;
  }, []);

  const resetEntryDrag = useCallback(() => {
    clearEntryDragTimer();
    const session = entryDragRef.current;
    if (session?.dragging) {
      suppressEntryClick();
    }
    if (session) {
      try {
        session.target.releasePointerCapture(session.pointerId);
      } catch {
        // Pointer capture may already be gone.
      }
    }
    entryDragRef.current = null;
    setEntryDrag(null);
    unlockEntryDragScroll();
  }, [clearEntryDragTimer, suppressEntryClick, unlockEntryDragScroll]);

  const updateEntryDragPosition = useCallback((clientX: number, clientY: number) => {
    const session = entryDragRef.current;
    if (!session?.dragging) return;
    const lock = entryDragScrollLockRef.current;
    if (lock?.main) lock.main.scrollTop = lock.mainScrollTop;
    const isOverTrash = isEntryOverTrash(clientX, clientY, session.width, session.height);
    setEntryDrag({
      entry: session.entry,
      x: clientX,
      y: clientY,
      width: session.width,
      height: session.height,
      isOverTrash,
    });
  }, [isEntryOverTrash]);

  const finishEntryDrag = useCallback((clientX: number, clientY: number) => {
    const session = entryDragRef.current;
    if (!session) return;
    const shouldDelete = session.dragging && isEntryOverTrash(clientX, clientY, session.width, session.height);
    const entry = session.entry;
    resetEntryDrag();
    if (shouldDelete) setDeleteCandidateEntry(entry);
  }, [isEntryOverTrash, resetEntryDrag]);

  useEffect(() => {
    if (!entryDrag) return;
    const handleWindowPointerMove = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session?.dragging || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateEntryDragPosition(event.clientX, event.clientY);
    };
    const handleWindowPointerUp = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      finishEntryDrag(event.clientX, event.clientY);
    };
    const handleWindowPointerCancel = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      resetEntryDrag();
    };
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { passive: false });
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [entryDrag, finishEntryDrag, resetEntryDrag, updateEntryDragPosition]);

  useEffect(() => {
    return () => {
      resetEntryDrag();
      unlockEntryDragScroll();
      if (entryDragClickSuppressTimerRef.current !== null) {
        window.clearTimeout(entryDragClickSuppressTimerRef.current);
        entryDragClickSuppressTimerRef.current = null;
      }
    };
  }, [resetEntryDrag, unlockEntryDragScroll]);

  const handleEntryPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>, entry: DiaryEntry) => {
    if (!activeCharacterId) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearEntryDragTimer();
    const rect = event.currentTarget.getBoundingClientRect();
    const target = event.currentTarget;
    entryDragRef.current = {
      entry,
      pointerId: event.pointerId,
      target,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      timer: window.setTimeout(() => {
        const session = entryDragRef.current;
        if (!session || session.pointerId !== event.pointerId || session.dragging) return;
        session.dragging = true;
        session.timer = null;
        suppressEntryClick(900);
        lockEntryDragScroll();
        try {
          session.target.setPointerCapture(session.pointerId);
        } catch {
          // Some touch browsers release capture during native gestures.
        }
        setEntryDrag({
          entry: session.entry,
          x: event.clientX,
          y: event.clientY,
          width: session.width,
          height: session.height,
          isOverTrash: isEntryOverTrash(event.clientX, event.clientY, session.width, session.height),
        });
      }, 430),
      dragging: false,
    };
  }, [activeCharacterId, clearEntryDragTimer, isEntryOverTrash, lockEntryDragScroll, suppressEntryClick]);

  const handleEntryPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.dragging) {
      if (Math.hypot(dx, dy) > 8) {
        clearEntryDragTimer();
        entryDragRef.current = null;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    updateEntryDragPosition(event.clientX, event.clientY);
  }, [clearEntryDragTimer, updateEntryDragPosition]);

  const handleEntryPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishEntryDrag(event.clientX, event.clientY);
  }, [finishEntryDrag]);

  const handleEntryPointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resetEntryDrag();
  }, [resetEntryDrag]);

  const handleEntryPointerLeave = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId || session.dragging) return;
    clearEntryDragTimer();
    entryDragRef.current = null;
  }, [clearEntryDragTimer]);

  const kindEntries = useMemo(() => entries.filter(entry => entry.authorType === kind), [entries, kind]);

  const books = useMemo<DiaryBook[]>(() => {
    const map = new Map<string, DiaryEntry[]>();
    for (const entry of kindEntries) {
      const list = map.get(entry.characterId);
      if (list) list.push(entry);
      else map.set(entry.characterId, [entry]);
    }
    return Array.from(map.entries()).map(([characterId, characterEntries]) => ({
      characterId,
      characterName: characterEntries[0].characterName,
      avatar: characters.find(character => character.id === characterId)?.avatar ?? "",
      entries: characterEntries,
    }));
  }, [kindEntries, characters]);

  const activeBook = useMemo(
    () => (activeCharacterId ? books.find(book => book.characterId === activeCharacterId) ?? null : null),
    [activeCharacterId, books],
  );
  const activeBookBusy = Boolean(activeBook && generatingCharacterIds.includes(activeBook.characterId));

  return (
    <section className={`diary-app diary-entry-app ${entryDrag ? "is-entry-dragging" : ""}`} style={diaryEntryStyle}>
      {generatingCharacterIds.length > 0 && (
        <div className="diary-generating-toast" role="status">
          <span className="diary-generating-toast-spinner" aria-hidden="true" />
          正在生成日记{generatingCharacterIds.length > 1 ? `（${generatingCharacterIds.length} 篇）` : ""}…
        </div>
      )}
      <header className="diary-app-header diary-entry-header">
        <button
          type="button"
          className="diary-icon-btn"
          onClick={() => (activeBook ? setActiveCharacterId(null) : onBack())}
          aria-label="返回"
        >
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>{activeBook ? (kind === "user" ? `写给 ${activeBook.characterName} 的日记` : `${activeBook.characterName} 的日记`) : (kind === "user" ? "我的日记" : "TA的日记")}</h1>
          <p>{activeBook ? `共 ${activeBook.entries.length} 篇手写日常` : (kind === "user" ? "每个角色一本，写下只属于你们的纸页" : "每个角色一本，点开翻阅")}</p>
        </div>
        <input
          ref={fontFileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2,font/*,application/font-woff,application/font-woff2"
          className="hidden"
          onChange={handleDiaryFontUpload}
        />
        <span className="diary-entry-header-actions">
          <button
            type="button"
            className="note-wall-menu-btn diary-font-upload-btn"
            onClick={() => setFontPanelOpen(true)}
            aria-label="日记字体设置"
            title="日记字体设置"
          >
            <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
          </button>
          <button
            type="button"
            className="note-wall-menu-btn"
            onClick={() => (kind === "user" ? setReplySettingsOpen(true) : setTimerSettingsOpen(true))}
            aria-label={kind === "user" ? "聊天回应设置" : "日记设置"}
          >
            <DotsThree size={28} weight="bold" />
          </button>
        </span>
      </header>

      <main ref={entryMainRef} className="diary-entry-main">
        {kindEntries.length === 0 ? (
          <div className="diary-entry-empty">
            <NotebookPen size={34} strokeWidth={1.5} />
            <h2>还没有日记</h2>
            <p>{kind === "user" ? "从你写下的第一句话开始。" : "让角色先写一篇，纸面会从这里开始铺开。"}</p>
            <button type="button" onClick={() => (kind === "user" ? setComposePickerOpen(true) : setWritePanelOpen(true))}>
              {kind === "user" ? "写下第一篇" : "让TA写一篇"}
            </button>
          </div>
        ) : activeBook ? (
          <div className="diary-entry-list">
            {activeBook.entries.map(entry => (
              <DiaryEntryCard
                key={entry.id}
                entry={entry}
                isDragSource={entryDrag?.entry.id === entry.id}
                onPointerDown={(event) => handleEntryPointerDown(event, entry)}
                onPointerMove={handleEntryPointerMove}
                onPointerUp={handleEntryPointerUp}
                onPointerCancel={handleEntryPointerCancel}
                onPointerLeave={handleEntryPointerLeave}
                onClick={(event) => {
                  event.stopPropagation();
                  if (entryDragClickSuppressedRef.current) {
                    event.preventDefault();
                    return;
                  }
                  setActiveEntry(entry);
                }}
              />
            ))}
          </div>
        ) : (
          <div className="diary-shelf">
            {[0, 1].map(column => (
              <div className="diary-shelf-column" key={column}>
                {books.filter((_, index) => index % 2 === column).map(book => (
                  <DiaryBookCover
                    key={book.characterId}
                    book={book}
                    busy={generatingCharacterIds.includes(book.characterId)}
                    onOpen={() => setActiveCharacterId(book.characterId)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </main>

      {kindEntries.length > 0 ? (
        kind === "user" ? (
          activeBook ? (
            <button
              type="button"
              className="diary-entry-write-btn"
              onClick={() => setComposeTarget({ mode: "create", characterId: activeBook.characterId })}
            >
              <NotebookPen size={18} strokeWidth={1.7} />
              <span>写日记</span>
            </button>
          ) : (
            <button type="button" className="diary-entry-write-btn" onClick={() => setComposePickerOpen(true)}>
              <NotebookPen size={18} strokeWidth={1.7} />
              <span>写日记</span>
            </button>
          )
        ) : activeBook ? (
          <button
            type="button"
            className="diary-entry-write-btn"
            disabled={activeBookBusy}
            aria-busy={activeBookBusy}
            onClick={() => generateForCharacters([activeBook.characterId])}
          >
            <WandSparkles size={18} strokeWidth={1.7} />
            {activeBookBusy ? <DiaryWritingStatus /> : <span>让TA写</span>}
          </button>
        ) : (
          <button type="button" className="diary-entry-write-btn" onClick={() => setWritePanelOpen(true)}>
            <WandSparkles size={18} strokeWidth={1.7} />
            <span>让TA写</span>
          </button>
        )
      ) : null}

      {timerSettingsOpen ? (
        <DiaryEntryTimerSettingsPanel
          characters={characters}
          settings={settings}
          generatingCharacterIds={generatingCharacterIds}
          onChange={setSettings}
          onClose={() => setTimerSettingsOpen(false)}
        />
      ) : null}

      {replySettingsOpen ? (
        <DiaryReplySettingsPanel
          characters={characters}
          rules={replyRules}
          onChange={setReplyRules}
          onClose={() => setReplySettingsOpen(false)}
        />
      ) : null}

      {writePanelOpen ? (
        <DiaryEntryWritePanel
          characters={characters}
          generatingCharacterIds={generatingCharacterIds}
          onGenerateMany={generateForCharacters}
          onClose={() => setWritePanelOpen(false)}
        />
      ) : null}

      {composePickerOpen ? (
        <DiaryComposePickerPanel
          characters={characters}
          onPick={(characterId) => {
            setComposePickerOpen(false);
            setComposeTarget({ mode: "create", characterId });
          }}
          onClose={() => setComposePickerOpen(false)}
        />
      ) : null}

      {composeTarget ? (
        <DiaryEntryComposeForm
          target={composeTarget}
          characters={characters}
          onSave={saveComposeEntry}
          onClose={() => setComposeTarget(null)}
        />
      ) : null}

      {fontPanelOpen ? (
        <DiaryEntryFontPanel
          hasCustomFont={Boolean(diaryFontDataUrl)}
          scale={diaryFontScale}
          onUpload={() => fontFileRef.current?.click()}
          onScaleChange={handleDiaryFontScaleChange}
          onReset={handleDiaryFontReset}
          onClose={() => setFontPanelOpen(false)}
        />
      ) : null}

      {activeEntry ? (
        <DiaryEntryDetail
          entry={activeEntry}
          onClose={() => setActiveEntry(null)}
          onEdit={() => { setComposeTarget({ mode: "edit", entry: activeEntry }); setActiveEntry(null); }}
        />
      ) : null}

      {deleteCandidateEntry ? (
        <div
          className="nw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="diary-entry-delete-title"
          onClick={() => setDeleteCandidateEntry(null)}
        >
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2 id="diary-entry-delete-title">删除日记</h2>
            <p>这篇日记会被删除，对应的短期记忆事件也会消失。</p>
            <div>
              <button type="button" className="nw-secondary-btn" onClick={() => setDeleteCandidateEntry(null)}>取消</button>
              <button type="button" className="nw-danger-btn" onClick={() => deleteEntry(deleteCandidateEntry)}>
                <span className="note-wall-primary-content">
                  <span>删除</span>
                </span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <div
        ref={entryTrashRef}
        className={`diary-entry-trash-bin ${entryDrag ? "is-visible" : ""} ${entryDrag?.isOverTrash ? "is-over" : ""}`}
        aria-hidden={!entryDrag}
      >
        <Trash2 size={30} strokeWidth={1.8} />
      </div>

      {entryDrag ? (
        <div
          className="diary-entry-card diary-entry-drag-ghost"
          style={{
            left: entryDrag.x,
            top: entryDrag.y,
            width: entryDrag.width,
            minHeight: entryDrag.height,
          }}
        >
          <DiaryEntryCardContent entry={entryDrag.entry} />
        </div>
      ) : null}
    </section>
  );
}

const DIARY_BOOK_COVER_COUNT = 6;

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function DiaryBookCover({ book, busy, onOpen }: { book: DiaryBook; busy: boolean; onOpen: () => void }) {
  const hash = hashText(book.characterId);
  const latest = book.entries[0];
  return (
    <button
      type="button"
      className="diary-book"
      data-cover={hash % DIARY_BOOK_COVER_COUNT}
      onClick={onOpen}
    >
      <span className="diary-book-spine" aria-hidden="true" />
      <span className="diary-book-frame" aria-hidden="true" />
      <span className="diary-book-label">
        <span className="diary-book-avatar">
          {book.avatar ? <img src={book.avatar} alt="" /> : <Bot size={20} />}
        </span>
        <strong>{book.characterName}</strong>
        <em>{busy ? <DiaryWritingStatus /> : "的日记本"}</em>
      </span>
      <span className="diary-book-meta">
        <span>{book.entries.length} 篇</span>
        <time>{formatEntryTime(latest.createdAt)}</time>
      </span>
    </button>
  );
}

function DiaryEntryCardContent({ entry }: { entry: DiaryEntry }) {
  const preview = entry.blocks.map(blockPlainText).filter(Boolean).join(" ");
  const markers = getEntryMarkers(entry);
  return (
    <>
      <span className="diary-entry-card-kicker">DIARY</span>
      {markers.length > 0 ? (
        <span className="diary-entry-card-markers">
          {markers.map(marker => <span key={marker} className="diary-entry-marker">{marker}</span>)}
        </span>
      ) : null}
      <strong>{entry.title}</strong>
      <span className="diary-entry-card-text">{clipText(preview || entry.body, 130)}</span>
      <span className="diary-entry-card-meta">
        <span>{entry.characterName}</span>
        <time>{formatEntryTime(entry.createdAt)}</time>
      </span>
    </>
  );
}

function DiaryEntryCard({
  entry,
  isDragSource,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}: {
  entry: DiaryEntry;
  isDragSource: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`diary-entry-card ${isDragSource ? "is-drag-source" : ""}`}
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={event => event.preventDefault()}
      onClick={onClick}
    >
      <DiaryEntryCardContent entry={entry} />
    </button>
  );
}

function DiaryEntryFontPanel({
  hasCustomFont,
  scale,
  onUpload,
  onScaleChange,
  onReset,
  onClose,
}: {
  hasCustomFont: boolean;
  scale: number;
  onUpload: () => void;
  onScaleChange: (scale: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-font-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>日记字体</h2>
            <p>{hasCustomFont ? "已使用自定义字体" : "当前使用默认手写字体"}</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <button type="button" className="diary-font-upload-action" onClick={onUpload}>
          <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
          <span>上传字体</span>
        </button>

        <label className="diary-font-size-control">
          <span>
            <strong>字号</strong>
            <em>{Math.round(scale * 100)}%</em>
          </span>
          <input
            type="range"
            min="0.85"
            max="1.25"
            step="any"
            value={scale}
            onChange={event => onScaleChange(Number(event.target.value))}
          />
        </label>

        <button type="button" className="diary-font-reset-btn" onClick={onReset}>
          恢复默认
        </button>
      </section>
    </div>
  );
}

function DiaryEntryTimerSettingsPanel({ characters, settings, generatingCharacterIds, onChange, onClose }: {
  characters: Character[];
  settings: DiaryEntryTimerSettings;
  generatingCharacterIds: string[];
  onChange: (settings: DiaryEntryTimerSettings) => void;
  onClose: () => void;
}) {
  const busy = generatingCharacterIds.length > 0;

  const toggleTimerCharacter = (characterId: string) => {
    onChange({
      ...settings,
      characterIds: settings.characterIds.includes(characterId)
        ? settings.characterIds.filter(id => id !== characterId)
        : [...settings.characterIds, characterId],
    });
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>定时写日记</h2>
            <p>默认一天一次；未选择角色时，会按全部角色处理。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="diary-entry-setting-grid">
          <label className="diary-entry-toggle-row">
            <span>
              <Clock3 size={17} />
              定时写日记
            </span>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={event => onChange({ ...settings, enabled: event.target.checked })}
            />
          </label>
          <label className="diary-entry-number-field">
            <span>间隔小时</span>
            <input
              type="number"
              min={1}
              max={720}
              value={settings.intervalHours}
              onChange={event => onChange({ ...settings, intervalHours: Math.max(1, Math.min(720, Number(event.target.value) || 24)) })}
            />
          </label>
        </div>

        <section className="diary-entry-character-section">
          <div className="diary-entry-section-title">
            <strong>定时角色</strong>
            <span>{settings.characterIds.length ? `已选 ${settings.characterIds.length} 个` : "默认全部"}</span>
          </div>
          <CharacterAvatarGrid
            characters={characters}
            selectedIds={settings.characterIds}
            busyIds={generatingCharacterIds}
            disabled={busy}
            onToggle={toggleTimerCharacter}
          />
        </section>
      </section>
    </div>
  );
}

const DIARY_REPLY_MODE_OPTIONS: DiaryReplyMode[] = ["none", "immediate", "delay", "merge"];

function DiaryReplySettingsPanel({ characters, rules, onChange, onClose }: {
  characters: Character[];
  rules: DiaryReplyRules;
  onChange: (rules: DiaryReplyRules) => void;
  onClose: () => void;
}) {
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>TA如何在聊天中回应</h2>
            <p>写完日记后，TA 会从聊天 App 发普通消息回应；可统一设置，也可以为每个角色单独指定。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="diary-entry-setting-grid">
          <label
            className="diary-entry-toggle-row"
            style={rules.default.mode !== "delay" ? { gridColumn: "1 / -1" } : undefined}
          >
            <span>默认回应方式</span>
            <select
              value={rules.default.mode}
              onChange={event => onChange({ ...rules, default: { ...rules.default, mode: event.target.value as DiaryReplyMode } })}
            >
              {DIARY_REPLY_MODE_OPTIONS.map(mode => (
                <option key={mode} value={mode}>{DIARY_REPLY_MODE_LABELS[mode]}</option>
              ))}
            </select>
          </label>
          {rules.default.mode === "delay" ? (
            <label className="diary-entry-number-field">
              <span>延时小时</span>
              <input
                type="number"
                min={0.05}
                max={720}
                step={0.25}
                value={rules.default.delayHours}
                onChange={event => onChange({ ...rules, default: { ...rules.default, delayHours: Math.max(0.05, Math.min(720, Number(event.target.value) || 24)) } })}
              />
            </label>
          ) : null}
        </div>

        <section className="diary-entry-character-section">
          <div className="diary-entry-section-title">
            <strong>按角色单独设置</strong>
          </div>
          <div className="diary-reply-rule-list">
            {characters.map(character => {
              const own = rules.characters[character.id] ?? { mode: "inherit" as const, delayHours: rules.default.delayHours };
              return (
                <div key={character.id} className="diary-reply-rule-row">
                  <span className="diary-reply-rule-person">
                    {character.avatar ? <img src={character.avatar} alt="" /> : <Bot size={18} />}
                    <strong>{character.name}</strong>
                  </span>
                  <select
                    value={own.mode}
                    onChange={event => {
                      const mode = event.target.value as DiaryReplyMode | "inherit";
                      const nextCharacters = { ...rules.characters, [character.id]: { mode, delayHours: own.delayHours } };
                      onChange({ ...rules, characters: nextCharacters });
                    }}
                  >
                    <option value="inherit">跟随默认</option>
                    {DIARY_REPLY_MODE_OPTIONS.map(mode => (
                      <option key={mode} value={mode}>{DIARY_REPLY_MODE_LABELS[mode]}</option>
                    ))}
                  </select>
                  {own.mode === "delay" ? (
                    <input
                      type="number"
                      min={0.05}
                      max={720}
                      step={0.25}
                      value={own.delayHours}
                      onChange={event => {
                        const delayHours = Math.max(0.05, Math.min(720, Number(event.target.value) || rules.default.delayHours));
                        onChange({ ...rules, characters: { ...rules.characters, [character.id]: { mode: own.mode, delayHours } } });
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
        <p className="diary-entry-note">「和下次互动合并」不会主动发起新对话，只在你们下次真的开口聊天时顺带带出这篇日记；默认设为「不回应」，避免未经确认产生 API 调用。</p>
      </section>
    </div>
  );
}

function DiaryComposePickerPanel({ characters, onPick, onClose }: {
  characters: Character[];
  onPick: (characterId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>写给谁</h2>
            <p>选择一位角色，写一篇给TA的日记。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <CharacterAvatarGrid
          characters={characters}
          selectedIds={[]}
          busyIds={[]}
          disabled={false}
          onToggle={onPick}
        />
      </section>
    </div>
  );
}

type DraftBlock = { localId: string } & DiaryEntryBlock;

function makeLocalId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toDraftBlocks(blocks: DiaryEntryBlock[]): DraftBlock[] {
  return blocks.map(block => ({ localId: makeLocalId(), ...block }));
}

function stripDraftBlocks(blocks: DraftBlock[]): DiaryEntryBlock[] {
  return blocks.map(({ localId: _localId, ...block }) => block as DiaryEntryBlock);
}

function makeEmptyBlock(type: DiaryEntryBlock["type"]): DraftBlock {
  const localId = makeLocalId();
  if (type === "quote") return { localId, type, text: "" };
  if (type === "correction") return { localId, type, text: "", replacement: "" };
  if (type === "todo") return { localId, type, title: "", items: [] };
  if (type === "image") return { localId, type, caption: "", description: "" };
  return { localId, type: "paragraph", text: "" };
}

function draftBlockHasContent(block: DiaryEntryBlock): boolean {
  if (block.type === "paragraph" || block.type === "quote") return block.text.trim().length > 0;
  if (block.type === "correction") return block.text.trim().length > 0 || (block.replacement ?? "").trim().length > 0;
  if (block.type === "image") return block.description.trim().length > 0;
  if (block.type === "todo") return block.items.some(item => item.text.trim().length > 0);
  return false;
}

const DIARY_BLOCK_TYPE_LABELS: Record<DiaryEntryBlock["type"], string> = {
  paragraph: "段落",
  quote: "引用",
  correction: "涂改",
  todo: "待办",
  image: "配图",
};

function DiaryEntryComposeForm({ target, characters, onSave, onClose }: {
  target: ComposeTarget;
  characters: Character[];
  onSave: (input: { characterId: string; title: string; mood: string; weather: string; tags: string[]; signature: string; blocks: DiaryEntryBlock[] }, editingId?: string) => void;
  onClose: () => void;
}) {
  const editingEntry = target.mode === "edit" ? target.entry : null;
  const characterId = target.mode === "edit" ? target.entry.characterId : target.characterId;
  const character = characters.find(item => item.id === characterId);
  const [title, setTitle] = useState(editingEntry?.title ?? "");
  const [mood, setMood] = useState(editingEntry?.mood ?? "");
  const [weather, setWeather] = useState(editingEntry?.weather ?? "");
  const [tagsText, setTagsText] = useState(editingEntry?.tags.join("、") ?? "");
  const [signature, setSignature] = useState(editingEntry?.signature ?? "");
  // 编辑已有日记时直接从它原来的 blocks 起步——引用/涂改/待办/配图这些板块原样保留，
  // 不会因为编辑就被压平成纯段落。
  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>(() =>
    editingEntry && editingEntry.blocks.length > 0 ? toDraftBlocks(editingEntry.blocks) : [makeEmptyBlock("paragraph")]
  );

  const canSave = draftBlocks.some(draftBlockHasContent);

  const updateBlock = useCallback((localId: string, patch: Partial<DiaryEntryBlock>) => {
    setDraftBlocks(blocks => blocks.map(block => (block.localId === localId ? { ...block, ...patch } as DraftBlock : block)));
  }, []);

  const removeBlock = useCallback((localId: string) => {
    setDraftBlocks(blocks => (blocks.length > 1 ? blocks.filter(block => block.localId !== localId) : blocks));
  }, []);

  const addBlock = useCallback((type: DiaryEntryBlock["type"]) => {
    setDraftBlocks(blocks => [...blocks, makeEmptyBlock(type)]);
  }, []);

  const updateTodoItem = useCallback((localId: string, index: number, patch: Partial<{ text: string; done: boolean }>) => {
    setDraftBlocks(blocks => blocks.map(block => {
      if (block.localId !== localId || block.type !== "todo") return block;
      return { ...block, items: block.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) };
    }));
  }, []);

  const addTodoItem = useCallback((localId: string) => {
    setDraftBlocks(blocks => blocks.map(block => (
      block.localId === localId && block.type === "todo"
        ? { ...block, items: [...block.items, { text: "", done: false }] }
        : block
    )));
  }, []);

  const removeTodoItem = useCallback((localId: string, index: number) => {
    setDraftBlocks(blocks => blocks.map(block => (
      block.localId === localId && block.type === "todo"
        ? { ...block, items: block.items.filter((_, i) => i !== index) }
        : block
    )));
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const tags = tagsText.split(/[,，、\s]+/).map(tag => tag.trim()).filter(Boolean);
    const blocks = stripDraftBlocks(draftBlocks.filter(draftBlockHasContent));
    onSave({ characterId, title: title.trim(), mood: mood.trim(), weather: weather.trim(), tags, signature: signature.trim(), blocks }, editingEntry?.id);
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <form className="diary-entry-settings diary-compose-form" onClick={event => event.stopPropagation()} onSubmit={handleSubmit}>
        <header>
          <div>
            <h2>{editingEntry ? "编辑日记" : `写给 ${character?.name ?? "TA"} 的日记`}</h2>
            <p>{editingEntry?.authorType === "character" ? "改动会覆盖这篇日记的原文。" : "写完后会按你设置的回应方式，让TA看到这篇日记。"}</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <label className="diary-compose-field diary-compose-title-field">
          <input type="text" value={title} onChange={event => setTitle(event.target.value)} placeholder="给今天起个标题（留空自动取正文开头）" />
        </label>
        <div className="diary-entry-setting-grid">
          <label className="diary-compose-field diary-compose-tint-field">
            <span>心情</span>
            <input type="text" value={mood} onChange={event => setMood(event.target.value)} placeholder="例如：平静" />
          </label>
          <label className="diary-compose-field diary-compose-tint-field">
            <span>天气</span>
            <input type="text" value={weather} onChange={event => setWeather(event.target.value)} placeholder="例如：晴" />
          </label>
        </div>
        <label className="diary-compose-field diary-compose-tint-field">
          <span>标签（用顿号或逗号分隔）</span>
          <input type="text" value={tagsText} onChange={event => setTagsText(event.target.value)} placeholder="例如：日常、碎碎念" />
        </label>

        <div className="diary-compose-blocks">
          {draftBlocks.map(block => (
            <DiaryBlockEditor
              key={block.localId}
              block={block}
              canRemove={draftBlocks.length > 1}
              onChange={patch => updateBlock(block.localId, patch)}
              onRemove={() => removeBlock(block.localId)}
              onAddTodoItem={() => addTodoItem(block.localId)}
              onUpdateTodoItem={(index, patch) => updateTodoItem(block.localId, index, patch)}
              onRemoveTodoItem={index => removeTodoItem(block.localId, index)}
            />
          ))}
        </div>

        <div className="diary-compose-add-block">
          {(["paragraph", "quote", "correction", "todo", "image"] as const).map(type => (
            <button key={type} type="button" onClick={() => addBlock(type)}>
              + {DIARY_BLOCK_TYPE_LABELS[type]}
            </button>
          ))}
        </div>

        {!editingEntry || editingEntry.authorType === "user" ? (
          <label className="diary-compose-field diary-compose-tint-field">
            <span>署名（可选）</span>
            <input type="text" value={signature} onChange={event => setSignature(event.target.value)} placeholder="写在日记末尾的署名" />
          </label>
        ) : null}

        <button type="submit" className="diary-save-btn" disabled={!canSave}>
          {editingEntry ? "保存修改" : "保存日记"}
        </button>
      </form>
    </div>
  );
}

function DiaryBlockEditor({ block, canRemove, onChange, onRemove, onAddTodoItem, onUpdateTodoItem, onRemoveTodoItem }: {
  block: DraftBlock;
  canRemove: boolean;
  onChange: (patch: Partial<DiaryEntryBlock>) => void;
  onRemove: () => void;
  onAddTodoItem: () => void;
  onUpdateTodoItem: (index: number, patch: Partial<{ text: string; done: boolean }>) => void;
  onRemoveTodoItem: (index: number) => void;
}) {
  return (
    <div className="diary-compose-block">
      <div className="diary-compose-block-head">
        <span>{DIARY_BLOCK_TYPE_LABELS[block.type]}</span>
        {canRemove ? (
          <button type="button" onClick={onRemove} aria-label="删除这个板块">
            <X size={14} />
          </button>
        ) : null}
      </div>

      {block.type === "paragraph" || block.type === "quote" ? (
        <textarea
          className="diary-compose-body"
          value={block.text}
          onChange={event => onChange({ text: event.target.value })}
          placeholder={block.type === "quote" ? "摘一句当天听到或想到的话……" : "写下今天想对TA说的话……"}
          rows={block.type === "quote" ? 3 : 6}
        />
      ) : null}

      {block.type === "correction" ? (
        <div className="diary-compose-correction">
          <label>
            <span>原句</span>
            <input type="text" value={block.text} onChange={event => onChange({ text: event.target.value })} placeholder="原来写的" />
          </label>
          <label>
            <span>改成</span>
            <input type="text" value={block.replacement ?? ""} onChange={event => onChange({ replacement: event.target.value })} placeholder="改成这样" />
          </label>
        </div>
      ) : null}

      {block.type === "image" ? (
        <>
          <input
            type="text"
            value={block.caption ?? ""}
            onChange={event => onChange({ caption: event.target.value })}
            placeholder="配图标题（可选）"
          />
          <textarea
            className="diary-compose-body"
            value={block.description}
            onChange={event => onChange({ description: event.target.value })}
            placeholder="描述一下这张想象中的插图……"
            rows={3}
          />
        </>
      ) : null}

      {block.type === "todo" ? (
        <div className="diary-compose-todo">
          <input
            type="text"
            value={block.title ?? ""}
            onChange={event => onChange({ title: event.target.value })}
            placeholder="清单标题（可选）"
          />
          <div className="diary-compose-todo-items">
            {block.items.map((item, index) => (
              <div key={index} className="diary-compose-todo-item">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={event => onUpdateTodoItem(index, { done: event.target.checked })}
                />
                <input
                  type="text"
                  value={item.text}
                  onChange={event => onUpdateTodoItem(index, { text: event.target.value })}
                  placeholder="待办事项"
                />
                <button type="button" onClick={() => onRemoveTodoItem(index)} aria-label="删除这一项">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="diary-compose-add-todo-item" onClick={onAddTodoItem}>+ 加一项</button>
        </div>
      ) : null}
    </div>
  );
}

function DiaryEntryWritePanel({ characters, generatingCharacterIds, onGenerateMany, onClose }: {
  characters: Character[];
  generatingCharacterIds: string[];
  onGenerateMany: (characterIds: string[], trigger?: DiaryEntryTrigger) => Promise<void> | void;
  onClose: () => void;
}) {
  const [selectedImmediateIds, setSelectedImmediateIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const busy = confirming || generatingCharacterIds.length > 0;

  const toggleImmediateCharacter = (characterId: string) => {
    setSelectedImmediateIds(prev => prev.includes(characterId)
      ? prev.filter(id => id !== characterId)
      : [...prev, characterId]);
  };

  const handleConfirm = async () => {
    if (busy || selectedImmediateIds.length === 0) return;
    setConfirming(true);
    try {
      await onGenerateMany(selectedImmediateIds, "manual");
      setSelectedImmediateIds([]);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-entry-write-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>让TA写一篇</h2>
            <p>选择角色后确认，会并行生成日记。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <CharacterAvatarGrid
          characters={characters}
          selectedIds={selectedImmediateIds}
          busyIds={generatingCharacterIds}
          disabled={busy}
          onToggle={toggleImmediateCharacter}
        />
        {selectedImmediateIds.length > 0 ? (
          <button
            type="button"
            className={`diary-entry-confirm-btn ${confirming ? "is-loading" : ""}`}
            disabled={busy}
            onClick={handleConfirm}
            aria-busy={confirming}
          >
            <span className="note-wall-primary-content">
              {confirming ? <span className="note-wall-primary-spinner" aria-hidden="true" /> : null}
              <span>{confirming ? <DiaryWritingStatus /> : `确认让 ${selectedImmediateIds.length} 个角色写日记`}</span>
            </span>
          </button>
        ) : null}
      </section>
    </div>
  );
}

function CharacterAvatarGrid({ characters, selectedIds, busyIds, disabled, onToggle }: {
  characters: Character[];
  selectedIds: string[];
  busyIds: string[];
  disabled: boolean;
  onToggle: (characterId: string) => void;
}) {
  if (characters.length === 0) return <p className="diary-entry-empty-line">暂无角色。</p>;

  return (
    <div className="diary-entry-character-grid">
      {characters.map(character => {
        const selected = selectedIds.includes(character.id);
        const busy = busyIds.includes(character.id);
        return (
          <button
            key={character.id}
            type="button"
            className={selected ? "is-selected" : ""}
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onToggle(character.id)}
          >
            <span>
              {character.avatar ? <img src={character.avatar} alt="" /> : <Bot size={18} />}
            </span>
            <strong>{character.name}</strong>
            {busy ? <em><DiaryWritingStatus /></em> : null}
          </button>
        );
      })}
    </div>
  );
}

function DiaryEntryDetail({ entry, onClose, onEdit }: { entry: DiaryEntry; onClose: () => void; onEdit: () => void }) {
  const markers = getEntryMarkers(entry);
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <article className="diary-entry-detail-paper" onClick={(event) => event.stopPropagation()}>
        <span className="diary-entry-paper-clip" aria-hidden="true">
          <span />
        </span>
        <div className="diary-entry-detail-scroll">
          <header>
            <div className="diary-entry-detail-topline">
              <span>日记详情</span>
              <div className="diary-entry-detail-actions">
                <button type="button" onClick={onEdit}>编辑</button>
                <button type="button" onClick={onClose}>关闭</button>
              </div>
            </div>
            <div className="diary-entry-detail-titleline">
              <h2>{entry.title}</h2>
              {markers.length > 0 ? (
                <span className="diary-entry-detail-markers">
                  {markers.map(marker => <span key={marker} className="diary-entry-marker">{marker}</span>)}
                </span>
              ) : null}
            </div>
          </header>
          <div className="diary-entry-blocks">
            {entry.blocks.map((block, index) => (
              <DiaryBlockView key={`${block.type}-${index}`} block={block} />
            ))}
          </div>
          <footer className="diary-entry-detail-signature">
            <span>{entry.authorType === "user" ? (entry.signature || "我") : entry.characterName}</span>
            <time>{formatEntryTime(entry.createdAt)}</time>
          </footer>
        </div>
      </article>
    </div>
  );
}

function DiaryBlockView({ block }: { block: DiaryEntryBlock }) {
  if (block.type === "quote") {
    return <blockquote className="diary-entry-quote">{block.text}</blockquote>;
  }
  if (block.type === "correction") {
    return (
      <p className="diary-entry-correction">
        <del>{block.text}</del>
        {block.replacement ? <ins>{block.replacement}</ins> : null}
      </p>
    );
  }
  if (block.type === "todo") {
    return (
      <section className="diary-entry-todo">
        {block.title ? <h3>{block.title}</h3> : null}
        <ul>
          {block.items.map((item, index) => (
            <li key={`${item.text}-${index}`} data-done={item.done ? "true" : "false"}>
              <span />
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (block.type === "image") {
    return (
      <figure className="diary-entry-image-block">
        <div>{block.description}</div>
        {block.caption ? <figcaption>{block.caption}</figcaption> : null}
      </figure>
    );
  }
  return <p className="diary-entry-paragraph">{block.text}</p>;
}
