"use client";

import { useState, useEffect, useRef, useSyncExternalStore, useMemo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { getDebugChatState, getDebugPromptSnapshot, subscribeDebugChatState, subscribeDebugPromptSnapshot, type DebugPromptSnapshot } from "@/lib/debug-store";
import { previewPromptRequestSnapshot, ChatEngineError } from "@/lib/chat-engine";
import { previewGroupPromptRequestSnapshot } from "@/lib/group-chat-engine";
import { FileText, X } from "lucide-react";
import {
    previewMomentsPostPrompt,
    previewMomentsCommentPrompt,
    previewMomentsNPCPrompt,
    previewMomentsReplyPrompt,
    type MomentsPreviewResult,
} from "@/lib/moments-engine";
import { previewCalendarPromptPayload } from "@/lib/calendar-engine";
import { CHAT_APP_SETTINGS_UPDATED_EVENT, loadChatAppSettings, loadChatContacts, loadChatMessages, loadChatSessions, type ChatSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { getAllPosts } from "@/lib/moments-storage";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { getWeekStartIso } from "@/lib/calendar-utils";
import { loadStorySessions, loadStoryMessages } from "@/lib/story-storage";
import { previewStoryPromptPayload } from "@/lib/story-engine";
import { loadVnSessions, loadVnMessages } from "@/lib/vn-storage";
import { previewVnPromptPayload } from "@/lib/vn-engine";
import { loadChatOfflineTurns } from "@/lib/chat-offline-storage";
import { buildOfflinePromptHistory } from "@/lib/offline-prompt-builder";
import { EXTRA_PROMPT_APPS, type ExtraPromptAppId } from "@/components/debug-prompt-registry";
import { previewCheckPhonePromptPayload } from "@/lib/checkphone-engine";
import { CHECKPHONE_APP_SPECS, type CheckPhoneAppId } from "@/lib/checkphone-config";
import { hydrateReadingStorage, loadBooks, loadChapters, loadAnnotations } from "@/lib/reading-storage";
import { previewReadingAnnotationPrompt, previewReadingDiscussPrompt } from "@/lib/reading-engine";
import { previewDwellingPromptPayload, type DwellingRefreshMode } from "@/lib/dwelling-engine";
import { loadDiaryEntries } from "@/lib/diary-entry-storage";
import { previewDiaryEntryPromptPayload } from "@/lib/diary-entry-engine";
import { fetchNoteWall, fetchNoteWallComments } from "@/lib/notewall-client";
import { previewNoteWallPromptPayload, type NoteWallReplyCandidate } from "@/lib/notewall-engine";
import { loadXiaohongshuState } from "@/lib/xiaohongshu-storage";
import { previewXiaohongshuPromptPayload } from "@/lib/xiaohongshu-engine";
import { loadCoCreateSession } from "@/lib/cocreate-storage";
import { previewCoCreatePromptPayload } from "@/lib/cocreate-engine";
import { previewShoppingPromptPayload } from "@/lib/shopping-engine";
import { previewInterviewMagazinePromptPayload } from "@/lib/interview-magazine-engine";
import { hydrateMapStorage, loadMapWorlds, getLatestSave } from "@/lib/map-storage";
import { previewAdventureCompanionPromptPayload } from "@/lib/map-rpg-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { BookChapter } from "@/lib/reading-types";
import type { CoCreateMode } from "@/lib/cocreate-types";
import type { MapWorld, GameSave } from "@/lib/map-types";


type CoreDebugMode = "chat" | "moments" | "calendar" | "story" | "vn";
type DebugMode = CoreDebugMode | ExtraPromptAppId;

type UnifiedMessage = {
    role: string;
    content: string | import("@/lib/llm-prompt-assembler").LLMContentPart[];
    marker?: string;
    depth?: number;
    order?: number;
};

type PromptPreviewResult = {
    messages: LLMMessage[];
    characterName: string;
    model: string;
    presetName: string;
};

type FloatingPosition = {
    left: number;
    top: number;
};

type FloatingDragState = FloatingPosition & {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
};

function stringifyContent(content: UnifiedMessage["content"]): string {
    if (typeof content === "string") return content;
    return content.map(p => p.type === "text" ? p.text : "[图片]").join("\n");
}

function splitMarkerBadges(marker?: string): string[] {
    if (!marker) return [];
    return marker.split(" + ").map(part => part.trim()).filter(Boolean);
}

function isExtraPromptMode(mode: DebugMode): mode is ExtraPromptAppId {
    return EXTRA_PROMPT_APPS.some(app => app.id === mode);
}

export function DebugPromptPanel() {
    const chatState = useSyncExternalStore(subscribeDebugChatState, getDebugChatState, () => null);
    const promptSnapshot = useSyncExternalStore(subscribeDebugPromptSnapshot, getDebugPromptSnapshot, () => null);
    const [collapsed, setCollapsed] = useState(true);
    const [enabled, setEnabled] = useState(false);
    const [mode, setMode] = useState<DebugMode>("chat");
    const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null);
    const [draggingFloatingButton, setDraggingFloatingButton] = useState(false);
    const floatingDragRef = useRef<FloatingDragState | null>(null);
    const suppressFloatingClickRef = useRef(false);
    const [selectedChatSessionId, setSelectedChatSessionId] = useState("");
    const [followUpMode, setFollowUpMode] = useState(false);
    const [offlinePreviewMode, setOfflinePreviewMode] = useState(false);
    const [offlinePendingText, setOfflinePendingText] = useState("");

    // Moments state
    const [momentsResult, setMomentsResult] = useState<MomentsPreviewResult | null>(null);
    const [momentsType, setMomentsType] = useState<"post" | "comment" | "npc" | "reply">("post");
    const [selectedCharId, setSelectedCharId] = useState<string>("");
    const [selectedPostId, setSelectedPostId] = useState<string>("");

    // Calendar state
    const [calendarResult, setCalendarResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [calendarOwnerId, setCalendarOwnerId] = useState<string>("");
    const [calendarWeekStart, setCalendarWeekStart] = useState<string>(() => getWeekStartIso(new Date()));

    // Story state
    const [storyResult, setStoryResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [storyCharacterId, setStoryCharacterId] = useState<string>("");

    // VN state
    const [vnResult, setVnResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [vnCharacterId, setVnCharacterId] = useState<string>("");

    // Extra app state
    const [extraResult, setExtraResult] = useState<PromptPreviewResult | null>(null);
    const [extraAppId, setExtraAppId] = useState<ExtraPromptAppId>("checkphone");
    const [extraCharacterId, setExtraCharacterId] = useState<string>("");
    const [checkPhoneAppId, setCheckPhoneAppId] = useState<CheckPhoneAppId | "manifest">("manifest");
    const [readingBookId, setReadingBookId] = useState<string>("");
    const [readingChapterIndex, setReadingChapterIndex] = useState<string>("");
    const [readingChapters, setReadingChapters] = useState<BookChapter[]>([]);
    const [readingStorageVersion, setReadingStorageVersion] = useState(0);
    const [readingMode, setReadingMode] = useState<"annotate" | "discuss">("annotate");
    const [dwellingMode, setDwellingMode] = useState<DwellingRefreshMode | "explore">("full");
    const [noteWallMode, setNoteWallMode] = useState<"note" | "reply">("note");
    const [xiaohongshuMode, setXiaohongshuMode] = useState<"activity" | "reaction" | "comment" | "mention">("activity");
    const [coCreateMode, setCoCreateMode] = useState<CoCreateMode>("write");
    const [shoppingMode, setShoppingMode] = useState<"catalog" | "search">("catalog");
    const [shoppingQuery, setShoppingQuery] = useState("礼物");
    const [interviewMode, setInterviewMode] = useState<"opening" | "host" | "answer" | "article">("opening");
    const [interviewTheme, setInterviewTheme] = useState("一次关于在场的采访");
    const [adventureWorldId, setAdventureWorldId] = useState<string>("");
    const [adventureStorageVersion, setAdventureStorageVersion] = useState(0);
    const [adventureInstructionMode, setAdventureInstructionMode] = useState<"turn" | "exit">("turn");

    // Shared
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());
    const scrollRef = useRef<HTMLDivElement>(null);
    const chatSessionOptions = useMemo(() => {
        if (typeof window === "undefined") return [] as { session: ChatSession; label: string }[];
        const sessions = loadChatSessions();
        const chars = loadCharacters();
        const charNameById = new Map(chars.map(c => [c.id, c.name]));
        // 不列出已删除角色的残留单聊，也不列出没有任何有效角色的空群聊。
        return sessions
            .filter(session => session.isGroup
                ? (session.participantIds || []).some(id => charNameById.has(id))
                : charNameById.has(session.contactId))
            .map(session => {
                if (session.isGroup) {
                    const fallbackName = (session.participantIds || [])
                        .map(id => charNameById.get(id))
                        .filter(Boolean)
                        .slice(0, 3)
                        .join("、");
                    return {
                        session,
                        label: `群聊 · ${session.groupName || fallbackName || "未命名群聊"}`,
                    };
                }
                return {
                    session,
                    label: charNameById.get(session.contactId) || session.alias || session.contactId,
                };
            });
    }, [enabled, chatState?.session?.id]);
    const activeChatSession = chatSessionOptions.find(option => option.session.id === selectedChatSessionId)?.session
        ?? chatState?.session
        ?? null;
    const activeChatSnapshot: DebugPromptSnapshot | null = (() => {
        if (!activeChatSession) return null;
        if (!promptSnapshot) return null;
        const appTags = promptSnapshot.appTags || [];
        const isChatRequest = promptSnapshot.appId === "chat"
            || promptSnapshot.appId === "group_chat"
            || appTags.includes("chat")
            || appTags.includes("group_chat");
        if (!isChatRequest) return null;
        if (promptSnapshot.sessionId !== activeChatSession.id) return null;
        return promptSnapshot;
    })();

    // Clear on mode/session change
    useEffect(() => {
        setMomentsResult(null);
        setCalendarResult(null);
        setStoryResult(null);
        setVnResult(null);
        setExtraResult(null);
        setError(null);
        setExpandedIdx(new Set());
    }, [activeChatSession?.id, mode, extraAppId, readingMode]);

    useEffect(() => {
        if (selectedChatSessionId && chatSessionOptions.some(option => option.session.id === selectedChatSessionId)) return;
        const nextSessionId = chatState?.session?.id
            ?? chatSessionOptions[0]?.session.id
            ?? "";
        if (nextSessionId !== selectedChatSessionId) setSelectedChatSessionId(nextSessionId);
    }, [chatSessionOptions, chatState?.session?.id, selectedChatSessionId]);

    useEffect(() => {
        const syncEnabled = (event?: Event) => {
            const detail = (event as CustomEvent | undefined)?.detail;
            const nextEnabled = typeof detail?.promptViewerEnabled === "boolean"
                ? detail.promptViewerEnabled
                : loadChatAppSettings().promptViewerEnabled === true;
            setEnabled(nextEnabled);
            if (!nextEnabled) setCollapsed(true);
        };
        syncEnabled();
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
    }, []);

    useEffect(() => {
        if (mode !== "chat" || !activeChatSnapshot) return;
        setError(null);
        setExpandedIdx(new Set());
        requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
    }, [activeChatSnapshot?.id, mode]);

    // Get unified messages for display.
    const displayMessages: UnifiedMessage[] = (() => {
        if (mode === "chat" && activeChatSnapshot) {
            return activeChatSnapshot.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m.marker,
            }));
        }
        if (mode === "moments" && momentsResult) {
            return momentsResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "calendar" && calendarResult) {
            return calendarResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "story" && storyResult) {
            return storyResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "vn" && vnResult) {
            return vnResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (isExtraPromptMode(mode) && extraResult) {
            return extraResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        return [];
    })();

    const resultMeta = mode === "chat"
        ? activeChatSnapshot
        : mode === "moments"
            ? momentsResult
            : mode === "calendar"
                ? calendarResult
                : mode === "story"
                    ? storyResult
                    : mode === "vn"
                        ? vnResult
                        : extraResult;

    // ── Chat Preview ──
    async function handleChatPreview() {
        if (!activeChatSession) return;
        setError(null);
        setLoading(true);
        try {
            if (offlinePreviewMode) {
                // 线下模式：历史来自「线下轮次」，assistant 内容为 <content>+摘要 XML，
                // 与 chat-room 真实线下生成完全一致（appTags 带 offline）。
                // 空历史也允许预览：看的就是首条线下消息发出前的完整提示词
                const offlineTurns = loadChatOfflineTurns(activeChatSession.id);
                const offlineHistory = buildOfflinePromptHistory(activeChatSession, offlineTurns, offlinePendingText);
                if (activeChatSession.isGroup) {
                    await previewGroupPromptRequestSnapshot(activeChatSession, offlineHistory, {
                        appTags: ["group_chat", "offline"],
                        excludeOfflineSessionId: activeChatSession.id,
                        disableTools: true,
                    });
                } else {
                    await previewPromptRequestSnapshot(activeChatSession, offlineHistory, {
                        appTags: ["chat", "offline"],
                        excludeOfflineSessionId: activeChatSession.id,
                    });
                }
            } else {
                const latestMessages = loadChatMessages(activeChatSession.id);
                if (activeChatSession.isGroup) {
                    await previewGroupPromptRequestSnapshot(activeChatSession, latestMessages);
                } else {
                    await previewPromptRequestSnapshot(
                        activeChatSession,
                        latestMessages,
                        followUpMode
                            ? { followUpAuto: true, appTags: ["chat", "text", "followup"] }
                            : { appTags: ["chat", "text"] }
                    );
                }
            }
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof ChatEngineError ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    // ── Calendar Preview ──
    async function handleCalendarPreview() {
        setError(null);
        setLoading(true);
        try {
            const result = await previewCalendarPromptPayload("character", calendarOwnerId, calendarWeekStart);
            setCalendarResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setCalendarResult(null);
        } finally {
            setLoading(false);
        }
    }

    async function handleStoryPreview() {
        if (!storyCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            const session = loadStorySessions().find(s => s.characterId === storyCharacterId);
            const history = session ? loadStoryMessages(session.id) : [];
            const result = await previewStoryPromptPayload(storyCharacterId, history, {
                sessionContextExcludedTags: session?.contextExcludedTags,
            });
            setStoryResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStoryResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── VN Preview ──
    async function handleVnPreview() {
        if (!vnCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            const session = loadVnSessions().find(s => s.characterId === vnCharacterId);
            const history = session ? loadVnMessages(session.id) : [];
            const result = await previewVnPromptPayload(vnCharacterId, history);
            setVnResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setVnResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── Moments Preview ──
    async function handleMomentsPreview() {
        if (!selectedCharId) return;
        setError(null);
        setLoading(true);
        try {
            let result: MomentsPreviewResult | null;
            if (momentsType === "post") {
                result = await previewMomentsPostPrompt(selectedCharId);
            } else {
                if (!selectedPostId) {
                    setError("请先选择一条帖子");
                    setLoading(false);
                    return;
                }
                if (momentsType === "comment") {
                    result = await previewMomentsCommentPrompt(selectedCharId, selectedPostId);
                } else if (momentsType === "npc") {
                    result = await previewMomentsNPCPrompt(selectedCharId, selectedPostId);
                } else {
                    result = await previewMomentsReplyPrompt(selectedCharId, selectedPostId);
                }
            }
            if (!result) {
                setError("无法生成预览，请检查角色是否绑定了API和预设");
                setLoading(false);
                return;
            }
            setMomentsResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(String(e));
            setMomentsResult(null);
        } finally {
            setLoading(false);
        }
    }

    async function handleExtraPreview() {
        const requiresCharacter = extraAppId !== "shopping";
        if (requiresCharacter && !extraCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            let result: PromptPreviewResult;
            if (extraAppId === "checkphone") {
                result = await previewCheckPhonePromptPayload(extraCharacterId, checkPhoneAppId);
            } else if (extraAppId === "reading") {
                const book = loadBooks().find(item => item.id === readingBookId);
                const chapter = readingChapters.find(item => String(item.index) === readingChapterIndex);
                if (!book || !chapter) throw new Error("请先选择书籍与章节");
                const annotations = await loadAnnotations(book.id, chapter.index);
                if (readingMode === "discuss") {
                    const session = chatSessionOptions.find(option => !option.session.isGroup && option.session.contactId === extraCharacterId)?.session;
                    if (!session) throw new Error("没有找到这个角色的聊天会话，无法预览阅读对话");
                    result = await previewReadingDiscussPrompt(session, book, {
                        chapterTitle: chapter.title,
                        chapterContent: [
                            "当前阅读中心：整章",
                            "本次上下文范围：整章",
                            "",
                            chapter.paragraphs.map((paragraph, index) => `[${index + 1}] ${paragraph}`).join("\n\n"),
                        ].join("\n"),
                        annotations,
                    }, extraCharacterId);
                } else {
                    result = await previewReadingAnnotationPrompt(book, chapter, annotations, extraCharacterId);
                }
            } else if (extraAppId === "dwelling") {
                result = await previewDwellingPromptPayload(extraCharacterId, dwellingMode);
            } else if (extraAppId === "diary") {
                const entries = loadDiaryEntries().filter(entry => entry.characterId === extraCharacterId);
                result = await previewDiaryEntryPromptPayload(extraCharacterId, entries);
            } else if (extraAppId === "notewall") {
                const wall = await fetchNoteWall().catch(() => ({ notes: [] }));
                const candidates: NoteWallReplyCandidate[] = noteWallMode === "reply"
                    ? await Promise.all(wall.notes.slice(0, 5).map(async note => ({
                        note,
                        comments: await fetchNoteWallComments(note.id).catch(() => []),
                    })))
                    : [];
                result = await previewNoteWallPromptPayload(extraCharacterId, noteWallMode, wall.notes, candidates);
            } else if (extraAppId === "xiaohongshu") {
                const state = loadXiaohongshuState();
                result = await previewXiaohongshuPromptPayload(extraCharacterId, xiaohongshuMode, state.notes, state.settings);
            } else if (extraAppId === "cocreate") {
                const session = loadCoCreateSession(extraCharacterId);
                result = await previewCoCreatePromptPayload(session, coCreateMode);
            } else if (extraAppId === "shopping") {
                result = await previewShoppingPromptPayload(shoppingMode, { query: shoppingQuery });
            } else if (extraAppId === "interview") {
                result = await previewInterviewMagazinePromptPayload({
                    theme: interviewTheme,
                    characterIds: [extraCharacterId],
                    mode: interviewMode,
                    transcript: [],
                });
            } else {
                if (!selectedAdventureSave) throw new Error("请先选择一个有存档的冒险世界");
                const agent = selectedAdventureSave.agents.find(item => item.characterId === extraCharacterId);
                const sharedUserIdentity = selectedAdventureSave.agents.length > 1 ? resolveUserIdentity(undefined, "adventure") : undefined;
                result = await previewAdventureCompanionPromptPayload(
                    extraCharacterId,
                    selectedAdventureSave.streamLog,
                    sharedUserIdentity,
                    agent?.affinity,
                    adventureInstructionMode === "exit"
                        ? { instruction: "{{user}}刚才决定离开当前事件，不再继续。请以你的身份回应{{user}}的离开：你会说什么、有什么反应、接下来是否跟随/挽留/沉默旁观。" }
                        : undefined,
                );
            }
            setExtraResult(result);
            setExpandedIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setExtraResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── Expand/Collapse ──
    function toggleExpand(idx: number) {
        setExpandedIdx(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            return next;
        });
    }
    function expandAll() { setExpandedIdx(new Set(displayMessages.map((_, i) => i))); }
    function collapseAll() { setExpandedIdx(new Set()); }
    const allMessagesExpanded = displayMessages.length > 0 && expandedIdx.size === displayMessages.length;

    function clampFloatingPosition(value: number, max: number): number {
        return Math.min(Math.max(value, 12), max);
    }

    function getFloatingButtonBounds(button: HTMLButtonElement) {
        const parent = button.offsetParent instanceof HTMLElement ? button.offsetParent : null;
        const parentRect = parent?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        const rect = button.getBoundingClientRect();
        return {
            left: rect.left - parentRect.left,
            top: rect.top - parentRect.top,
            maxLeft: Math.max(12, parentRect.width - rect.width - 12),
            maxTop: Math.max(12, parentRect.height - rect.height - 12),
        };
    }

    function handleFloatingPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        event.stopPropagation();
        const button = event.currentTarget;
        const bounds = getFloatingButtonBounds(button);
        floatingDragRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            left: bounds.left,
            top: bounds.top,
            maxLeft: bounds.maxLeft,
            maxTop: bounds.maxTop,
            moved: false,
        };
        setDraggingFloatingButton(true);
        button.setPointerCapture(event.pointerId);
    }

    function handleFloatingPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const deltaX = event.clientX - drag.startClientX;
        const deltaY = event.clientY - drag.startClientY;
        if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
            drag.moved = true;
        }
        setFloatingPosition({
            left: clampFloatingPosition(drag.left + deltaX, drag.maxLeft),
            top: clampFloatingPosition(drag.top + deltaY, drag.maxTop),
        });
    }

    function handleFloatingPointerEnd(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (drag.moved) suppressFloatingClickRef.current = true;
        floatingDragRef.current = null;
        setDraggingFloatingButton(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    function handleFloatingButtonClick(event: ReactMouseEvent<HTMLButtonElement>) {
        event.stopPropagation();
        if (suppressFloatingClickRef.current) {
            suppressFloatingClickRef.current = false;
            return;
        }
        setCollapsed(false);
    }

    function handleModeChange(nextMode: DebugMode) {
        if (isExtraPromptMode(nextMode)) {
            setExtraAppId(nextMode);
        }
        setMode(nextMode);
    }

    const totalChars = displayMessages.reduce((sum, m) => sum + stringifyContent(m.content).length, 0);
    const estimatedTokens = Math.round(totalChars / 2);

    const debugTabs: [DebugMode, string][] = [
        ["chat", activeChatSession?.isGroup ? "群聊" : "聊天"],
        ["moments", "朋友圈"],
        ["calendar", "日历"],
        ["story", "剧情"],
        ["vn", "漫卷"],
        ...EXTRA_PROMPT_APPS.map(app => [app.id, app.label] as [DebugMode, string]),
    ];

    // ── Character/Post options for moments (memoized) ──
    const charOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        const contacts = loadChatContacts();
        const chars = loadCharacters();
        const map = new Map<string, string>();
        contacts.forEach(c => {
            map.set(c.characterId, chars.find(ch => ch.id === c.characterId)?.name ?? c.characterId);
        });
        chars.forEach(c => map.set(c.id, c.name));
        return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    }, []);

    const readingBookOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        return loadBooks().map(book => ({ id: book.id, title: book.title }));
    }, [enabled, extraAppId, readingStorageVersion]);

    const adventureWorldOptions = useMemo(() => {
        if (typeof window === "undefined") return [] as MapWorld[];
        return loadMapWorlds().filter(world => world.status !== "generating");
    }, [enabled, extraAppId, adventureStorageVersion]);
    const selectedAdventureWorld = adventureWorldOptions.find(world => world.id === adventureWorldId) ?? null;
    const selectedAdventureSave: GameSave | null = useMemo(
        () => selectedAdventureWorld ? getLatestSave(selectedAdventureWorld.id) : null,
        [selectedAdventureWorld, adventureStorageVersion],
    );

    const postOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        const posts = getAllPosts();
        const chars = loadCharacters();
        return posts.slice(0, 30).map(p => {
            const authorName = p.authorType === "user" ? "我" : (chars.find(c => c.id === p.authorId)?.name ?? "?");
            return { id: p.id, label: `${authorName}: ${p.content.slice(0, 30)}...` };
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [momentsType]);

    useEffect(() => {
        if (calendarOwnerId || charOptions.length === 0) return;
        setCalendarOwnerId(charOptions[0].id);
    }, [calendarOwnerId, charOptions]);

    useEffect(() => {
        if (extraCharacterId || charOptions.length === 0) return;
        setExtraCharacterId(charOptions[0].id);
    }, [extraCharacterId, charOptions]);

    useEffect(() => {
        if (extraAppId !== "reading") return;
        let cancelled = false;
        hydrateReadingStorage().then(() => {
            if (!cancelled) setReadingStorageVersion(version => version + 1);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [extraAppId]);

    useEffect(() => {
        if (readingBookId || readingBookOptions.length === 0) return;
        setReadingBookId(readingBookOptions[0].id);
    }, [readingBookId, readingBookOptions]);

    useEffect(() => {
        let cancelled = false;
        if (!readingBookId) {
            setReadingChapters([]);
            setReadingChapterIndex("");
            return;
        }
        loadChapters(readingBookId).then(chapters => {
            if (cancelled) return;
            setReadingChapters(chapters);
            const currentExists = readingChapterIndex && chapters.some(chapter => String(chapter.index) === readingChapterIndex);
            if (!currentExists) setReadingChapterIndex(chapters[0] ? String(chapters[0].index) : "");
        }).catch(() => {
            if (cancelled) return;
            setReadingChapters([]);
            setReadingChapterIndex("");
        });
        return () => { cancelled = true; };
    }, [readingBookId, readingChapterIndex]);

    useEffect(() => {
        if (extraAppId !== "adventure") return;
        let cancelled = false;
        hydrateMapStorage().then(() => {
            if (!cancelled) setAdventureStorageVersion(version => version + 1);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [extraAppId]);

    useEffect(() => {
        if (adventureWorldId || adventureWorldOptions.length === 0) return;
        setAdventureWorldId(adventureWorldOptions[0].id);
    }, [adventureWorldId, adventureWorldOptions]);

    if (!enabled) return null;

    if (collapsed) {
        return (
            <button
                type="button"
                className="prompt-viewer-float-button"
                aria-label="打开提示词查看器"
                data-positioned={floatingPosition ? "" : undefined}
                data-dragging={draggingFloatingButton ? "" : undefined}
                onPointerDown={handleFloatingPointerDown}
                onPointerMove={handleFloatingPointerMove}
                onPointerUp={handleFloatingPointerEnd}
                onPointerCancel={handleFloatingPointerEnd}
                onClick={handleFloatingButtonClick}
                style={floatingPosition ? { left: floatingPosition.left, top: floatingPosition.top } : undefined}
            >
                <FileText size={24} strokeWidth={1.9} />
            </button>
        );
    }

    const renderCharSelect = (value: string, onChange: (v: string) => void) => (
        <select value={value} onChange={e => onChange(e.target.value)} className="pv-select">
            <option value="">选择角色...</option>
            {charOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
    );

    const renderPreviewBtn = (onClick: () => void, disabled: boolean) => (
        <button onClick={onClick} disabled={disabled} className="pv-btn pv-btn-primary">
            {loading ? "加载中..." : "预览"}
        </button>
    );

    const getExtraPreviewWarning = () => {
        if (extraAppId === "reading") {
            return "实际上下文以阅读实际场景注入，不按章节注入，此处仅为模拟";
        }
        if (extraAppId === "dwelling" && dwellingMode === "explore") {
            return "实际上下文以栖所当前点击的房间、家具和物品注入，此处仅用首个物品模拟";
        }
        if (extraAppId === "notewall" && noteWallMode === "reply") {
            return "实际上下文以便签墙真实触发的便签和评论注入，此处仅取候选便签模拟";
        }
        if (extraAppId === "xiaohongshu") {
            return "实际上下文以小红书当前触发的笔记、评论或@注入，此处仅取现有数据模拟";
        }
        if (extraAppId === "cocreate") {
            return "实际上下文以共创当前会话和刚发送内容注入，此处仅基于已保存会话模拟";
        }
        if (extraAppId === "interview") {
            return "实际上下文以在场采访流程和已有转录注入，此处仅用空转录模拟";
        }
        if (extraAppId === "adventure") {
            return "实际上下文以冒险当前事件、队伍状态和本轮行为注入，此处仅基于最近存档模拟";
        }
        return null;
    };

    const renderExtraPreviewWarning = () => {
        const warning = getExtraPreviewWarning();
        return warning ? <span className="pv-context-warning">{warning}</span> : null;
    };

    const renderExtraControls = () => (
        <>
            {extraAppId !== "shopping" && renderCharSelect(extraCharacterId, setExtraCharacterId)}
            {extraAppId === "checkphone" && (
                <select value={checkPhoneAppId} onChange={e => setCheckPhoneAppId(e.target.value as CheckPhoneAppId | "manifest")} className="pv-select">
                    <option value="manifest">桌面清单</option>
                    {Object.values(CHECKPHONE_APP_SPECS).map(spec => (
                        <option key={spec.id} value={spec.id}>{spec.label}</option>
                    ))}
                </select>
            )}
            {extraAppId === "reading" && (
                <>
                    <select value={readingMode} onChange={e => setReadingMode(e.target.value as "annotate" | "discuss")} className="pv-select">
                        <option value="annotate">批注</option>
                        <option value="discuss">对话</option>
                    </select>
                    <select value={readingBookId} onChange={e => setReadingBookId(e.target.value)} className="pv-select">
                        <option value="">选择书籍...</option>
                        {readingBookOptions.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}
                    </select>
                    <select value={readingChapterIndex} onChange={e => setReadingChapterIndex(e.target.value)} className="pv-select">
                        <option value="">选择章节...</option>
                        {readingChapters.map(chapter => (
                            <option key={chapter.id} value={String(chapter.index)}>{chapter.title}</option>
                        ))}
                    </select>
                </>
            )}
            {extraAppId === "dwelling" && (
                <select value={dwellingMode} onChange={e => setDwellingMode(e.target.value as DwellingRefreshMode | "explore")} className="pv-select">
                    <option value="full">完整栖所</option>
                    <option value="items">刷新物品</option>
                    <option value="explore">探索物品</option>
                </select>
            )}
            {extraAppId === "notewall" && (
                <select value={noteWallMode} onChange={e => setNoteWallMode(e.target.value as "note" | "reply")} className="pv-select">
                    <option value="note">生成便签</option>
                    <option value="reply">回复便签</option>
                </select>
            )}
            {extraAppId === "xiaohongshu" && (
                <select value={xiaohongshuMode} onChange={e => setXiaohongshuMode(e.target.value as "activity" | "reaction" | "comment" | "mention")} className="pv-select">
                    <option value="activity">浏览互动</option>
                    <option value="reaction">回应用户笔记</option>
                    <option value="comment">回复评论</option>
                    <option value="mention">回复@</option>
                </select>
            )}
            {extraAppId === "cocreate" && (
                <select value={coCreateMode} onChange={e => setCoCreateMode(e.target.value as CoCreateMode)} className="pv-select">
                    <option value="write">写作</option>
                    <option value="discuss">讨论</option>
                </select>
            )}
            {extraAppId === "shopping" && (
                <>
                    <select value={shoppingMode} onChange={e => setShoppingMode(e.target.value as "catalog" | "search")} className="pv-select">
                        <option value="catalog">首页推荐</option>
                        <option value="search">搜索结果</option>
                    </select>
                    {shoppingMode === "search" && (
                        <input value={shoppingQuery} onChange={e => setShoppingQuery(e.target.value)} className="pv-select" placeholder="搜索词" />
                    )}
                </>
            )}
            {extraAppId === "interview" && (
                <>
                    <select value={interviewMode} onChange={e => setInterviewMode(e.target.value as "opening" | "host" | "answer" | "article")} className="pv-select">
                        <option value="opening">开场提问</option>
                        <option value="host">主持人追问</option>
                        <option value="answer">嘉宾回答</option>
                        <option value="article">专栏成稿</option>
                    </select>
                    <input value={interviewTheme} onChange={e => setInterviewTheme(e.target.value)} className="pv-select" placeholder="在场主题" />
                </>
            )}
            {extraAppId === "adventure" && (
                <>
                    <select value={adventureWorldId} onChange={e => setAdventureWorldId(e.target.value)} className="pv-select">
                        <option value="">选择冒险世界...</option>
                        {adventureWorldOptions.map(world => (
                            <option key={world.id} value={world.id}>{world.skeleton.world.name || "未命名世界"}</option>
                        ))}
                    </select>
                    <select value={adventureInstructionMode} onChange={e => setAdventureInstructionMode(e.target.value as "turn" | "exit")} className="pv-select">
                        <option value="turn">角色宣言</option>
                        <option value="exit">离开回应</option>
                    </select>
                </>
            )}
            {renderPreviewBtn(handleExtraPreview, loading || (extraAppId !== "shopping" && !extraCharacterId))}
            {renderExtraPreviewWarning()}
        </>
    );

    return (
        <div className="pv-panel" onPointerDown={e => e.stopPropagation()}>
            {/* Header */}
            <div className="pv-header">
                <span className="pv-header-title">提示词查看器</span>
                {resultMeta && <span className="pv-header-meta">{resultMeta.characterName}</span>}
                <span style={{ flex: 1 }} />
                <button type="button" className="pv-close-btn" aria-label="关闭" onClick={(e) => { e.stopPropagation(); setCollapsed(true); }}>
                    <X size={18} strokeWidth={2} />
                </button>
            </div>

            {/* Tabs */}
            <div className="pv-tabs">
                {debugTabs.map(([key, label]) => (
                    <button key={key} className="pv-tab" onClick={() => handleModeChange(key)} {...(mode === key ? { "data-active": "" } : {})}>
                        {label}
                    </button>
                ))}
            </div>
            <div className="pv-divider" />

            {/* Toolbar */}
            <div className="pv-toolbar">
                {mode === "chat" && (
                    <>
                        <select
                            value={activeChatSession?.id || ""}
                            onChange={e => setSelectedChatSessionId(e.target.value)}
                            className="pv-select"
                        >
                            <option value="">选择聊天...</option>
                            {chatSessionOptions.map(option => (
                                <option key={option.session.id} value={option.session.id}>{option.label}</option>
                            ))}
                        </select>
                        <button onClick={handleChatPreview} disabled={loading || !activeChatSession} className="pv-btn pv-btn-primary">
                            {loading ? "加载中..." : "预览 Prompt"}
                        </button>
                        {activeChatSession && !activeChatSession.isGroup && (
                            <button onClick={() => setFollowUpMode(f => !f)} className="pv-toggle" {...(followUpMode ? { "data-active": "" } : {})}>
                                {followUpMode ? "追发 ON" : "追发 OFF"}
                            </button>
                        )}
                        {activeChatSession && (
                            <>
                                <button onClick={() => { setOfflinePreviewMode(v => !v); }} className="pv-toggle" {...(offlinePreviewMode ? { "data-active": "" } : {})}>
                                    {offlinePreviewMode ? "线下 ON" : "线下 OFF"}
                                </button>
                                {offlinePreviewMode && (
                                    <input
                                        value={offlinePendingText}
                                        onChange={e => setOfflinePendingText(e.target.value)}
                                        className="pv-select"
                                        placeholder="输入下一条线下消息（可选）"
                                    />
                                )}
                            </>
                        )}
                    </>
                )}
                {mode === "moments" && (
                    <>
                        <select value={momentsType} onChange={e => setMomentsType(e.target.value as "post" | "comment" | "npc" | "reply")} className="pv-select">
                            <option value="post">发帖</option>
                            <option value="comment">评论</option>
                            <option value="npc">NPC互动</option>
                            <option value="reply">回复</option>
                        </select>
                        {renderCharSelect(selectedCharId, setSelectedCharId)}
                        {(momentsType !== "post") && (
                            <select value={selectedPostId} onChange={e => setSelectedPostId(e.target.value)} className="pv-select">
                                <option value="">选择帖子...</option>
                                {postOptions.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                            </select>
                        )}
                        {renderPreviewBtn(handleMomentsPreview, !selectedCharId || loading)}
                    </>
                )}
                {mode === "calendar" && (
                    <>
                        {renderCharSelect(calendarOwnerId, setCalendarOwnerId)}
                        <input type="date" value={calendarWeekStart} onChange={e => setCalendarWeekStart(e.target.value || getWeekStartIso(new Date()))} className="pv-select" />
                        {renderPreviewBtn(handleCalendarPreview, loading || !calendarOwnerId)}
                    </>
                )}
                {mode === "story" && (
                    <>
                        {renderCharSelect(storyCharacterId, setStoryCharacterId)}
                        {renderPreviewBtn(handleStoryPreview, loading || !storyCharacterId)}
                    </>
                )}
                {mode === "vn" && (
                    <>
                        {renderCharSelect(vnCharacterId, setVnCharacterId)}
                        {renderPreviewBtn(handleVnPreview, loading || !vnCharacterId)}
                    </>
                )}
                {isExtraPromptMode(mode) && renderExtraControls()}
                {displayMessages.length > 0 && (
                    <button onClick={allMessagesExpanded ? collapseAll : expandAll} className="pv-btn pv-btn-ghost">
                        {allMessagesExpanded ? "全部折叠" : "全部展开"}
                    </button>
                )}
                {resultMeta && (
                    <span className="pv-toolbar-meta">{resultMeta.model} · {resultMeta.presetName}</span>
                )}
            </div>
            <div className="pv-divider" />

            {/* Body */}
            <div ref={scrollRef} className="pv-body">
                {error && <div className="pv-error">{error}</div>}

                {displayMessages.map((msg, idx) => {
                    const isExpanded = expandedIdx.has(idx);
                    const textContent = stringifyContent(msg.content);
                    const preview = textContent.slice(0, 120);
                    const needsTruncation = textContent.length > 120;
                    const markerBadges = splitMarkerBadges(msg.marker);

                    return (
                        <div key={idx} className="pv-msg">
                            <div className="pv-msg-header" onClick={() => toggleExpand(idx)}>
                                <span className="pv-msg-role" data-role={msg.role}>{msg.role}</span>
                                {markerBadges.map((badge, bi) => (
                                    <span key={`${idx}-${bi}`} className="pv-msg-badge">{badge}</span>
                                ))}
                                {msg.depth !== undefined && (
                                    <span className="pv-msg-depth">D:{msg.depth} O:{msg.order}</span>
                                )}
                                <span style={{ flex: 1 }} />
                                <span className="pv-msg-toggle">
                                    {isExpanded ? "▼" : "▶"} {textContent.length}c
                                </span>
                            </div>
                            <div className="pv-msg-body" style={{
                                maxHeight: isExpanded ? undefined : 60,
                                overflow: isExpanded ? undefined : "hidden",
                            }}>
                                {isExpanded ? textContent : (needsTruncation ? preview + "..." : preview)}
                            </div>
                        </div>
                    );
                })}

                {displayMessages.length === 0 && !error && (
                    <div className="pv-empty">
                        {mode === "chat"
                            ? (activeChatSession
                                ? (offlinePreviewMode ? "点击「预览 Prompt」查看线下模式的真实提示词（含 <content> 与摘要 XML）" : "点击「预览 Prompt」查看下一轮会发送的真实提示词")
                                : "选择聊天对象后点击「预览 Prompt」")
                            : mode === "moments" ? "选择角色后点击「预览」查看朋友圈 Prompt"
                            : mode === "calendar" ? "选择角色与日期后点击「预览」"
                            : mode === "vn" ? "选择角色后点击「预览」查看漫卷 Prompt"
                            : mode === "story" ? "选择角色后点击「预览」查看剧情 Prompt"
                            : isExtraPromptMode(mode)
                                ? EXTRA_PROMPT_APPS.find(app => app.id === mode)?.emptyText ?? "选择 APP 后点击「预览」"
                                : "选择 APP 后点击「预览」"
                        }
                    </div>
                )}
            </div>

            {/* Footer */}
            {displayMessages.length > 0 && (
                <>
                    <div className="pv-divider" />
                    <div className="pv-footer">
                        <span>{displayMessages.length} 条消息</span>
                        <span>{totalChars.toLocaleString()} 字符</span>
                        <span>~{estimatedTokens.toLocaleString()} tokens</span>
                    </div>
                </>
            )}
        </div>
    );
}
