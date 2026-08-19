"use client";

import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from "react";
import { Bot, ChevronDown, ChevronRight, Languages, Menu, Minus, PenLine, Rocket, SendHorizontal, X, ZoomIn } from "lucide-react";
import {
    loadChapters,
    loadProgress,
    saveProgress,
    loadAnnotations,
    saveAnnotations,
    saveAnnotation,
    deleteAnnotation,
    saveChapters,
    loadRawFileBlob,
    updateBook,
    loadReadingInteractionConfig,
    saveReadingInteractionConfig,
    DEFAULT_READING_INTERACTION_CONFIG,
} from "@/lib/reading-storage";
import { generateAnnotationBatch, generateReadingChat, parseReadingDiscussResponse, type ReadingDiscussAction, type ReadingDiscussContext } from "@/lib/reading-engine";
import { loadChatMessages, pushChatMessage, deleteChatMessage, editChatMessage, loadChatContacts, createOrGetSession, isReadingDiscussMessage } from "@/lib/chat-storage";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ContentDialog } from "@/components/ui/modal";
import { Toggle } from "@/components/ui/form";
import { PdfPageRenderer } from "./reading-pdf-viewer";
import { decodeTxtArrayBuffer, parsePdfPageRange, PDF_PAGES_PER_CHAPTER, parseTxtContent, parseEpubFile } from "@/lib/reading-parser";
import type { Book, BookChapter, ReadingAnnotation, ReadingProgress } from "@/lib/reading-types";
import type { Character } from "@/lib/character-types";
import { splitBilingualText } from "@/lib/bilingual-text";

type TxtPageItem =
    | { kind: "line"; text: string; chapterIndex: number; paragraphIndex: number; indent?: boolean; segEnd?: boolean }
    | { kind: "gap"; chapterIndex: number; paragraphIndex: number }
    | { kind: "annotation"; annotation: ReadingAnnotation; chapterIndex: number; paragraphIndex: number };

type ParagraphRef = {
    absoluteIndex: number;
    chapterIndex: number;
    paragraphIndex: number;
    text: string;
    pageNum?: number;
    yRatio?: number;
};

type AnnotationBatchRequest = {
    key: string;
    title: string;
    size: number;
    items: ParagraphRef[];
};

type AnnotationDialogMode = "manual" | "auto";
type AnnotationBatchMode = AnnotationDialogMode | "auto-current";

const DISCUSS_TARGET_CHARS = 1000;
const DISCUSS_MIN_CHARS = 700;
const DISCUSS_MAX_CHARS = 1600;
const DISCUSS_MAX_PARAGRAPHS = 16;
const MAX_MANUAL_PDF_PREFETCH_PAGES = 30;

/** 聊天悬浮球/悬浮条/悬浮窗的位置记忆键 */
const CHAT_FLOAT_POS_KEY = "reading-chat-float-pos-v1";
const CHAT_FLOAT_MARGIN = 12;

function toCanvasFont(style: CSSStyleDeclaration): string {
    return [
        style.fontStyle,
        style.fontVariant,
        style.fontWeight,
        style.fontSize,
        style.fontFamily,
    ].join(" ");
}

function formatParagraphRangeLabel(start: number, end: number): string {
    return start === end ? `第${start + 1}段` : `第${start + 1}-${end + 1}段`;
}

function getParagraphLength(text: string): number {
    return text.replace(/\s+/g, "").length || text.trim().length;
}

/** 静默重试：生成失败时按用户配置的次数重试，重试间隔逐渐加大，全部失败后抛出最后一次错误 */
async function withAnnotationRetry<T>(task: () => Promise<T>, retryCount: number): Promise<T> {
    const maxAttempts = Math.max(1, retryCount + 1);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await task();
        } catch (err) {
            lastError = err;
            if (attempt >= maxAttempts) break;
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1200, 400 * attempt)));
        }
    }
    throw lastError;
}

function buildPdfChunkTitle(startPage: number, endPage: number): string {
    return `第${startPage}-${endPage}页`;
}

function buildParagraphRefsFromChapters(chapters: BookChapter[]): ParagraphRef[] {
    const refs: ParagraphRef[] = chapters.flatMap((chapter, currentChapterIndex) =>
        chapter.paragraphs.map((text, paragraphIndex) => ({
            absoluteIndex: 0,
            chapterIndex: currentChapterIndex,
            paragraphIndex,
            text,
            pageNum: chapter.paragraphPages?.[paragraphIndex],
            yRatio: chapter.paragraphYPositions?.[paragraphIndex],
        })),
    );

    for (let i = 0; i < refs.length; i += 1) {
        refs[i].absoluteIndex = i;
    }

    return refs;
}

function trimTrailingGaps(items: TxtPageItem[]): TxtPageItem[] {
    let end = items.length;
    while (end > 0 && items[end - 1]?.kind === "gap") end -= 1;
    return items.slice(0, end);
}

function wrapTextToLines(text: string, maxWidth: number, ctx: CanvasRenderingContext2D, firstLineOffset = 0): string[] {
    if (!text) return [""];

    const lines: string[] = [];
    let current = "";
    let lineIndex = 0;

    for (const char of Array.from(text)) {
        const candidate = current + char;
        const lineLimit = lineIndex === 0 ? Math.max(1, maxWidth - firstLineOffset) : maxWidth;
        if (current && ctx.measureText(candidate).width > lineLimit) {
            lines.push(current);
            current = char;
            lineIndex += 1;
        } else {
            current = candidate;
        }
    }

    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
}

function ReadingLoadingView({
    title,
    subtitle,
    compact = false,
    overlay = false,
}: {
    title: string;
    subtitle: string;
    compact?: boolean;
    overlay?: boolean;
}) {
    return (
        <div
            className={`reading-loading-view${compact ? " reading-loading-view--compact" : ""}${overlay ? " reading-loading-view--overlay" : ""}`}
            data-no-nav="true"
        >
            <div className="reading-loading-mark" aria-hidden="true">
                <span className="reading-loading-page reading-loading-page--back" />
                <span className="reading-loading-page reading-loading-page--middle" />
                <span className="reading-loading-page reading-loading-page--front" />
            </div>
            <div className="reading-loading-copy">
                <span className="reading-loading-title">
                    {title}
                    <span className="reading-loading-dots" aria-hidden="true"><i /><i /><i /></span>
                </span>
                <span className="reading-loading-subtitle">{subtitle}</span>
            </div>
            <div className="reading-loading-lines" aria-hidden="true">
                <span />
                <span />
                <span />
            </div>
        </div>
    );
}

function ReadingAnnotationContent({
    text,
    bilingualEnabled,
    expanded,
    onToggle,
}: {
    text: string;
    bilingualEnabled: boolean;
    expanded: boolean;
    onToggle: () => void;
}) {
    const bilingual = bilingualEnabled ? splitBilingualText(text) : null;
    if (!bilingual) {
        return <div className="reading-annotation-text">{text}</div>;
    }

    return (
        <div className="reading-annotation-text">
            <div>{bilingual.original}</div>
            <button
                type="button"
                className="chat-bilingual-toggle reading-annotation-bilingual-toggle"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onPointerCancel={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
                aria-expanded={expanded}
            >
                {expanded ? "收起中文" : "中文"}
            </button>
            {expanded && <div className="reading-annotation-translation">{bilingual.translated}</div>}
        </div>
    );
}

type Props = {
    book: Book;
    onBack: () => void;
};

export function ReadingViewer({ book, onBack }: Props) {
    const isPdf = book.format === "pdf";
    const [readingConfig, setReadingConfig] = useState(() => loadReadingInteractionConfig());
    // 阅读器保持挂载（返回书架不卸载），书架设置页保存后通过事件同步最新配置
    useEffect(() => {
        const reload = () => setReadingConfig(loadReadingInteractionConfig());
        window.addEventListener("reading-interaction-config-changed", reload);
        return () => window.removeEventListener("reading-interaction-config-changed", reload);
    }, []);
    const [chapters, setChapters] = useState<BookChapter[]>([]);
    const [chapterIndex, setChapterIndex] = useState(0);
    const [pdfCurrentPage, setPdfCurrentPage] = useState(1);
    const [pdfTotalPages, setPdfTotalPages] = useState(0);
    const [txtPage, setTxtPage] = useState(0);
    const [annotations, setAnnotations] = useState<ReadingAnnotation[]>([]);
    const [generating, setGenerating] = useState(false);
    const [companionId, setCompanionId] = useState<string | null>(null);
    const [immersive, setImmersive] = useState(true);
    const [showCharPicker, setShowCharPicker] = useState(false);
    const [charPickerClosing, setCharPickerClosing] = useState(false);
    const closeCharPicker = useCallback(() => {
        if (!showCharPicker || charPickerClosing) return;
        setCharPickerClosing(true);
        setTimeout(() => { setShowCharPicker(false); setCharPickerClosing(false); }, 180);
    }, [showCharPicker, charPickerClosing]);
    const [showChat, setShowChat] = useState(false);
    const [chatExpanded, setChatExpanded] = useState(false);
    const [chatOffset, setChatOffset] = useState<{ x: number; y: number }>(() => {
        try {
            const raw = localStorage.getItem(CHAT_FLOAT_POS_KEY);
            if (!raw) return { x: 0, y: 0 };
            const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
            if (typeof parsed.x === "number" && typeof parsed.y === "number" && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
                return { x: parsed.x, y: parsed.y };
            }
        } catch {
            // ignore storage errors
        }
        return { x: 0, y: 0 };
    });
    const [isDragging, setIsDragging] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [chatting, setChatting] = useState(false);
    const [autoAnnotate, setAutoAnnotate] = useState(false);
    const [annotationBatchSize, setAnnotationBatchSize] = useState(isPdf ? 5 : 50);
    const [annotationBatchInput, setAnnotationBatchInput] = useState(String(isPdf ? 5 : 50));
    const [annotationDialogMode, setAnnotationDialogMode] = useState<AnnotationDialogMode | null>(null);
    const [showReadingSettings, setShowReadingSettings] = useState(false);
    const [pdfRenderDraft, setPdfRenderDraft] = useState(() => ({
        pdfZoom: readingConfig.pdfZoom ?? 1,
        pdfPreloadRadius: readingConfig.pdfPreloadRadius ?? 3,
        pdfPreloadEnabled: readingConfig.pdfPreloadEnabled !== false,
    }));
    const [showNavigationDialog, setShowNavigationDialog] = useState(false);
    const [pdfJumpPage, setPdfJumpPage] = useState<number | undefined>(undefined);
    /** PDF 手动预批注对话框：自定义起始页/结束页，确认后立即预解析并预生成该范围批注 */
    const [pdfPrefetchDialogOpen, setPdfPrefetchDialogOpen] = useState(false);
    const [pdfPrefetchStartInput, setPdfPrefetchStartInput] = useState("");
    const [pdfPrefetchEndInput, setPdfPrefetchEndInput] = useState("");
    const [chaptersLoaded, setChaptersLoaded] = useState(false);
    const touchStartRef = useRef({ x: 0, y: 0 });
    const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
    const [readingMessageMenu, setReadingMessageMenu] = useState<{ messageId: string; x: number; y: number } | null>(null);
    const [editingDiscussMessage, setEditingDiscussMessage] = useState<ChatMessage | null>(null);
    const [editingDiscussContent, setEditingDiscussContent] = useState("");
    const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
    const [annotationTranslationOverrides, setAnnotationTranslationOverrides] = useState<Record<string, boolean>>({});
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const readingMessagePressStartRef = useRef<{ x: number; y: number } | null>(null);
    const chatDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
    const chatMovedRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const chatListRef = useRef<HTMLDivElement>(null); // 共读讨论悬浮窗消息列表（滚动容器）
    const txtMeasureLineRef = useRef<HTMLParagraphElement>(null);
    const txtMeasureGapRef = useRef<HTMLDivElement>(null);
    const txtMeasureAnnotationRef = useRef<HTMLDivElement>(null);
    const generatedBatchesRef = useRef<Set<string>>(new Set());
    /** 同步「生成中」锁：防止 auto/prefetch 竞态导致同一帧内并发发起多个批注生成任务 */
    const annotationInFlightRef = useRef(false);
    /** 正在生成中的批次 key：防止同一批在生成完成前被再次发起 */
    const inFlightBatchesRef = useRef<Set<string>>(new Set());
    const pendingTxtPageFractionRef = useRef<number | null>(null);
    const lastTxtPaginationSignatureRef = useRef("");
    // 滚动阅读模式：连续滚动（多章窗口无缝衔接）
    const scrollFractionRef = useRef(0);
    const initialScrollFractionRef = useRef<number | null>(null); // 打开书时保存的章节内比例
    const pendingScrollFractionRef = useRef<number | null>(null); // 滑块跨章待定位比例
    const scrollContentRef = useRef<HTMLDivElement>(null);        // 滚动内容容器（含多章块）
    const chapterMetricsRef = useRef<Map<number, { top: number; height: number }>>(new Map()); // 各章块在滚动坐标系中的 top/height
    const pendingScrollActionRef = useRef<{ kind: "shift-forward"; oldScrollTop: number; removedHeight: number } | { kind: "shift-backward"; oldScrollTop: number } | null>(null);
    const shiftCooldownRef = useRef(false);                      // 窗口平移后的冷却期，防止边界来回抖动
    const scrollPositionedKeyRef = useRef("");                   // 已做过初始定位的「书+模式」标识
    const chapterIndexRef = useRef(0);
    const chaptersLenRef = useRef(0);
    const [txtLayoutVersion, setTxtLayoutVersion] = useState(0);
    const [txtPages, setTxtPages] = useState<TxtPageItem[][]>([]);
    const [scrollFraction, setScrollFraction] = useState(0);
    const [flipAnim, setFlipAnim] = useState<{ direction: 'forward' | 'backward'; items: TxtPageItem[] } | null>(null);

    const [enrichedContacts, setEnrichedContacts] = useState<(ReturnType<typeof loadChatContacts>[number] & { char: Character })[]>([]);

    useEffect(() => {
        const chars = loadCharacters();
        const contacts = loadChatContacts();
        const enriched = contacts
            .map(c => ({ ...c, char: chars.find(ch => ch.id === c.characterId) }))
            .filter(c => c.char) as (typeof contacts[number] & { char: Character })[];
        setEnrichedContacts(enriched);
    }, []);

    useEffect(() => {
        const nextSize = isPdf ? 5 : 50;
        setAnnotationBatchSize(nextSize);
        setAnnotationBatchInput(String(nextSize));
        setAutoAnnotate(false);
        generatedBatchesRef.current.clear();
    }, [book.id, isPdf]);

    useEffect(() => {
        setAnnotationTranslationOverrides({});
    }, [book.id, chapterIndex, readingConfig.collapseBilingualTranslation]);

    const companion = companionId ? (enrichedContacts.find(c => c.characterId === companionId)?.char || loadCharacters().find(c => c.id === companionId)) : null;
    const bilingualTranslationEnabled = readingConfig.bilingualTranslationEnabled === true;
    const defaultTranslationExpanded = readingConfig.collapseBilingualTranslation !== true;
    const isScrollMode = !isPdf && readingConfig.readingMode === "scroll";
    // 保持 ref 与最新状态同步（供长生命周期滚动回调读取）
    chapterIndexRef.current = chapterIndex;
    chaptersLenRef.current = chapters.length;
    // 滚动模式渲染的章节窗口：上一章 + 当前章 + 下一章（无缝衔接用）
    const windowChapters = useMemo(() => {
        if (chapters.length === 0) return [] as BookChapter[];
        const start = Math.max(0, chapterIndex - 1);
        const end = Math.min(chapters.length - 1, chapterIndex + 1);
        const out: BookChapter[] = [];
        for (let i = start; i <= end; i++) out.push(chapters[i]);
        return out;
    }, [chapters, chapterIndex]);
    // 滚动模式：将「章节内比例(0-1)」换算为具体滚动位置（窗口布局下按当前章块定位）
    const scrollToChapterFraction = useCallback((fraction: number, targetChapterIndex: number) => {
        const body = scrollRef.current;
        if (!body) return;
        const metrics = chapterMetricsRef.current.get(targetChapterIndex);
        if (!metrics) return;
        const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);
        const span = Math.max(0, metrics.height - body.clientHeight);
        const target = Math.max(0, Math.min(maxScroll, metrics.top + Math.max(0, Math.min(1, fraction)) * span));
        body.scrollTop = target;
        const actual = span > 0 ? Math.min(1, Math.max(0, (target - metrics.top) / span)) : 0;
        scrollFractionRef.current = actual;
        setScrollFraction(actual);
    }, []);
    const currentChapter = chapters[chapterIndex];
    const txtPagesChapterIndex = txtPages[0]?.find((item) => item.kind !== "gap")?.chapterIndex ?? txtPages[0]?.[0]?.chapterIndex;
    const txtPagesReadyForCurrentChapter = !isPdf && !isScrollMode && txtPages.length > 0 && txtPagesChapterIndex === chapterIndex;
    const showTxtLoading = !isPdf && (
        !chaptersLoaded ||
        (chaptersLoaded && chapters.length > 0 && Boolean(currentChapter) && !isScrollMode && !txtPagesReadyForCurrentChapter)
    );

    const renderTxtPage = (pageIndex: number) => {
        const pageItems = txtPages[pageIndex] || [];
        if (pageItems.length === 0) return null;
        return (
            <div className="reading-page-content">
                {pageItems.map((item, i) => (
                    item.kind === "gap"
                        ? <div key={i} className="reading-line-gap" />
                        : item.kind === "annotation"
                            ? renderAnnotationItem(item.annotation)
                            : <p key={i} className={`reading-line${item.indent ? " reading-line-indent" : ""}${item.segEnd ? " reading-line-seg-end" : ""}`}>{item.text}</p>
                ))}
            </div>
        );
    };

    // 批注块（翻页与滚动模式共用）：长按呼出 复制/删除 菜单
    const renderAnnotationItem = (annotation: ReadingAnnotation) => (
        <div
            key={annotation.id}
            className="reading-annotation reading-annotation-interactive"
            data-no-nav="true"
            onPointerDown={() => {
                longPressTimer.current = setTimeout(() => {
                    setActiveMessageId(null);
                    setActiveAnnotationId(annotation.id);
                }, 500);
            }}
            onPointerUp={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onPointerCancel={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onPointerLeave={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onClick={(e) => {
                e.stopPropagation();
                if (activeAnnotationId && activeAnnotationId !== annotation.id) setActiveAnnotationId(null);
            }}
        >
            <span className="reading-annotation-name">{annotation.characterName}</span>
            <ReadingAnnotationContent
                text={annotation.content}
                bilingualEnabled={bilingualTranslationEnabled}
                expanded={isAnnotationTranslationExpanded(annotation.id)}
                onToggle={() => handleAnnotationTranslationToggle(annotation.id)}
            />
            {activeAnnotationId === annotation.id && (
                <div className="ctx-menu reading-annotation-menu" onClick={(e) => e.stopPropagation()}>
                    <button
                        onClick={() => {
                            copyToClipboard(annotation.content);
                            setActiveAnnotationId(null);
                        }}
                        className="ctx-menu-btn"
                    >
                        复制
                    </button>
                    <button
                        onClick={() => { void handleDeleteReadingAnnotation(annotation.id); }}
                        className="ctx-menu-btn ctx-menu-btn-danger"
                    >
                        删除
                    </button>
                </div>
            )}
        </div>
    );

    const renderStaticPage = (items: TxtPageItem[]) => (
        <div className="reading-page-content">
            {items.map((item, i) =>
                item.kind === "gap"
                    ? <div key={i} className="reading-line-gap" />
                    : item.kind === "annotation"
                        ? <div key={i} className="reading-annotation">
                            <span className="reading-annotation-name">{item.annotation.characterName}</span>
                            <span className="reading-annotation-text">{item.annotation.content}</span>
                        </div>
                        : <p key={i} className={`reading-line${item.indent ? " reading-line-indent" : ""}${item.segEnd ? " reading-line-seg-end" : ""}`}>{item.text}</p>
            )}
        </div>
    );

    const totalParagraphs = useMemo(
        () => chapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0),
        [chapters],
    );
    const charPickerBottom = showChat ? (chatExpanded ? 284 : 76) : 64;
    const paragraphRefs = useMemo(() => buildParagraphRefsFromChapters(chapters), [chapters]);
    const pdfRenderAnnotations = useMemo(() => {
        if (!isPdf) return annotations;
        const absoluteIndexMap = new Map(
            paragraphRefs.map((item) => [`${item.chapterIndex}:${item.paragraphIndex}`, item.absoluteIndex] as const),
        );
        return annotations
            .map((annotation) => {
                const absoluteIndex = absoluteIndexMap.get(`${annotation.chapterIndex}:${annotation.paragraphIndex}`);
                if (absoluteIndex === undefined) return null;
                return {
                    ...annotation,
                    paragraphIndex: absoluteIndex,
                };
            })
            .filter((annotation): annotation is ReadingAnnotation => annotation !== null);
    }, [annotations, isPdf, paragraphRefs]);

    const pdfAnnotationChapter: BookChapter | undefined = useMemo(() => {
        if (!isPdf || chapters.length === 0) return undefined;
        return {
            id: `${book.id}_pdf_all`,
            bookId: book.id,
            index: 0,
            title: book.title,
            paragraphs: paragraphRefs.map((item) => item.text),
            paragraphPages: paragraphRefs.map((item) => item.pageNum ?? 1),
            paragraphYPositions: paragraphRefs.map((item) => item.yRatio ?? 0.5),
        };
    }, [book.id, book.title, chapters.length, isPdf, paragraphRefs]);

    const clampBatchSize = useCallback((value: number) => {
        const fallback = isPdf ? 5 : 50;
        if (!Number.isFinite(value)) return fallback;
        const min = 1;
        const max = isPdf ? 30 : 200;
        return Math.min(max, Math.max(min, Math.round(value)));
    }, [isPdf]);

    const isAnnotationTranslationExpanded = useCallback((annotationId: string) => {
        return annotationTranslationOverrides[annotationId] ?? defaultTranslationExpanded;
    }, [annotationTranslationOverrides, defaultTranslationExpanded]);

    const handleAnnotationTranslationToggle = useCallback((annotationId: string) => {
        setAnnotationTranslationOverrides((prev) => {
            const current = prev[annotationId] ?? defaultTranslationExpanded;
            return { ...prev, [annotationId]: !current };
        });
        if (!isPdf) {
            setTxtLayoutVersion((version) => version + 1);
        }
    }, [defaultTranslationExpanded, isPdf]);

    // Find or create chat session for companion
    const getSession = useCallback((): ChatSession | null => {
        if (!companionId) return null;
        // 找不到与角色的一对一会话时自动创建（否则发送会静默无响应）
        return createOrGetSession(companionId);
    }, [companionId]);


    // Load book data
    useEffect(() => {
        // 清空上一本书遗留的滚动定位状态
        initialScrollFractionRef.current = null;
        pendingScrollFractionRef.current = null;
        pendingScrollActionRef.current = null;
        shiftCooldownRef.current = false;
        scrollPositionedKeyRef.current = "";
        setChaptersLoaded(false);
        (async () => {
            let chs = await loadChapters(book.id);
            if (!isPdf && chs.length === 0) {
                const rawFile = await loadRawFileBlob(book.id);
                if (rawFile && rawFile.size > 0) {
                    try {
                        const parsed = book.format === "txt"
                            ? parseTxtContent(decodeTxtArrayBuffer(await rawFile.arrayBuffer(), loadReadingInteractionConfig().txtEncoding).text, book.title)
                            : await parseEpubFile(await rawFile.arrayBuffer(), book.title);
                        const rebuiltChapters: BookChapter[] = parsed.chapters.map((chapter, index) => ({
                            id: `${book.id}_ch${index}`,
                            bookId: book.id,
                            index,
                            title: chapter.title,
                            paragraphs: chapter.paragraphs,
                        }));
                        if (rebuiltChapters.length > 0) {
                            await saveChapters(book.id, rebuiltChapters);
                            await updateBook({
                                ...book,
                                title: parsed.title || book.title,
                                author: parsed.author,
                                totalChapters: rebuiltChapters.length,
                            });
                            chs = rebuiltChapters;
                        }
                    } catch (err) {
                        console.error("[Reading] Failed to rebuild text chapters from raw file:", err);
                    }
                }
            }
            setChapters(chs);
            const progress = await loadProgress(book.id);
            if (progress) {
                const safeChapterIndex = chs.length > 0
                    ? Math.max(0, Math.min(chs.length - 1, progress.chapterIndex))
                    : 0;
                setChapterIndex(safeChapterIndex);
                setCompanionId(progress.companionCharacterId || null);
                if (isPdf) {
                    // PDF 恢复：scrollPosition 存的是「当前页 - 1」。
                    // 同时设置 pdfCurrentPage（避免跳转前保存逻辑把它覆盖回第 1 页）
                    // 与 pdfJumpPage（让 PdfPageRenderer 渲染完成后滚到该页）。
                    const restoredPage = Math.max(1, Math.round((progress.scrollPosition ?? 0) + 1));
                    setPdfCurrentPage(restoredPage);
                    setPdfJumpPage(restoredPage);
                } else if (progress.readingMode === "scroll") {
                    // 滚动模式：scrollPosition 存的是章节内滚动比例(0-1)
                    initialScrollFractionRef.current = Math.max(0, Math.min(1, progress.scrollPosition || 0));
                } else {
                    setTxtPage(Math.max(0, progress.scrollPosition || 0));
                }
            }
            // Default companion: first contact
            if (!progress?.companionCharacterId && enrichedContacts.length > 0) {
                setCompanionId(enrichedContacts[0].characterId);
            }
            if (!progress && !isPdf) setTxtPage(0);
            setChaptersLoaded(true);
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [book.id]);

    useEffect(() => {
        if (chapters.length === 0) return;
        if (chapterIndex >= 0 && chapterIndex < chapters.length) return;
        setChapterIndex(Math.max(0, Math.min(chapters.length - 1, chapterIndex)));
    }, [chapterIndex, chapters.length]);

    useEffect(() => {
        if (!isPdf || pdfTotalPages <= 0 || chapters.length === 0) return;
        const expectedCount = Math.max(1, Math.ceil(pdfTotalPages / PDF_PAGES_PER_CHAPTER));
        const needsSkeletonRefresh =
            chapters.length !== expectedCount ||
            chapters.some((chapter, index) => {
                const startPage = index * PDF_PAGES_PER_CHAPTER + 1;
                const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages);
                return chapter.pageStart !== startPage || chapter.pageEnd !== endPage;
            });
        if (!needsSkeletonRefresh) return;

        const nextChapters: BookChapter[] = Array.from({ length: expectedCount }, (_, index) => {
            const startPage = index * PDF_PAGES_PER_CHAPTER + 1;
            const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages);
            const existing = chapters.find((chapter) => chapter.index === index);
            return {
                id: existing?.id || `${book.id}_ch${index}`,
                bookId: book.id,
                index,
                title: buildPdfChunkTitle(startPage, endPage),
                paragraphs: existing?.paragraphs || [],
                paragraphPages: existing?.paragraphPages,
                paragraphYPositions: existing?.paragraphYPositions,
                pageStart: startPage,
                pageEnd: endPage,
            };
        });

        void saveChapters(book.id, nextChapters).then(() => {
            setChapters(nextChapters);
        }).catch((err) => {
            console.error("[Reading] PDF chapter skeleton error:", err);
        });
    }, [book.id, chapters, isPdf, pdfTotalPages]);

    // Load annotations for current scope
    useEffect(() => {
        (async () => {
            if (isPdf) {
                const groups = await Promise.all(chapters.map((chapter) => loadAnnotations(book.id, chapter.index)));
                setAnnotations(groups.flat());
                return;
            }
            // 滚动模式：加载窗口内所有章节（上一章+当前章+下一章）的批注，
            // 否则交界处批注缺失，且窗口平移时整组替换导致批注「时有时无」
            const chapterIndexes = isScrollMode
                ? [...new Set(windowChapters.map((c) => c.index))]
                : [chapterIndex];
            const groups = await Promise.all(chapterIndexes.map((idx) => loadAnnotations(book.id, idx)));
            setAnnotations(groups.flat());
        })();
    }, [book.id, isPdf, isScrollMode, windowChapters]);

    // Load reading-discuss chat messages
    const refreshChatMessages = useCallback(() => {
        const session = getSession();
        if (!session) { setChatMessages([]); return; }
        const msgs = loadChatMessages(session.id)
            .filter(isReadingDiscussMessage)
            .slice(-30);
        setChatMessages(msgs);
    }, [getSession]);

    useEffect(() => { refreshChatMessages(); }, [refreshChatMessages, companionId]);

    const [annotationError, setAnnotationError] = useState<string | null>(null);
    const loadExistingAnnotationsForItems = useCallback(async (items: ParagraphRef[]) => {
        const chapterIndexes = [...new Set(items.map((item) => item.chapterIndex))];
        const itemKeys = new Set(items.map((item) => `${item.chapterIndex}:${item.paragraphIndex}`));
        const groups = await Promise.all(chapterIndexes.map((idx) => loadAnnotations(book.id, idx)));
        return groups
            .flat()
            .filter((annotation) => itemKeys.has(`${annotation.chapterIndex}:${annotation.paragraphIndex}`));
    }, [book.id]);

    const ensurePdfPageRangeParsed = useCallback(async (startPage: number, endPage: number): Promise<BookChapter[]> => {
        if (!isPdf || chapters.length === 0) return chapters;

        const targetStart = Math.max(1, startPage);
        const targetEnd = Math.max(targetStart, endPage);
        const missing = chapters.filter((chapter) => {
            const chapterStart = chapter.pageStart ?? (chapter.index * PDF_PAGES_PER_CHAPTER + 1);
            const chapterEnd = chapter.pageEnd ?? (chapterStart + PDF_PAGES_PER_CHAPTER - 1);
            return chapter.paragraphs.length === 0 && chapterEnd >= targetStart && chapterStart <= targetEnd;
        });
        if (missing.length === 0) return chapters;

        const rawData = await loadRawFileBlob(book.id);
        if (!rawData || rawData.size === 0) {
            throw new Error("PDF 文件未找到或为空");
        }

        const parseStart = Math.min(...missing.map((chapter) => chapter.pageStart ?? (chapter.index * PDF_PAGES_PER_CHAPTER + 1)));
        const parseEnd = Math.max(...missing.map((chapter) => chapter.pageEnd ?? ((chapter.index + 1) * PDF_PAGES_PER_CHAPTER)));
        const parsed = await parsePdfPageRange(rawData, {
            startPage: parseStart,
            endPage: parseEnd,
            fileName: book.title,
        });

        const updates: BookChapter[] = parsed.chunks.map((chunk) => {
            const chunkIndex = Math.floor((chunk.startPage - 1) / PDF_PAGES_PER_CHAPTER);
            const existing = chapters[chunkIndex];
            return {
                id: existing?.id || `${book.id}_ch${chunkIndex}`,
                bookId: book.id,
                index: chunkIndex,
                title: chunk.title,
                paragraphs: chunk.paragraphs,
                paragraphPages: chunk.pdfMeta.map((item) => item.pageNum),
                paragraphYPositions: chunk.pdfMeta.map((item) => item.yRatio),
                pageStart: chunk.startPage,
                pageEnd: chunk.endPage,
            };
        });

        await saveChapters(book.id, updates);
        const merged = chapters.map((chapter) => {
            const replacement = updates.find((item) => item.index === chapter.index);
            return replacement || chapter;
        });
        setChapters(merged);
        return merged;
    }, [book.id, chapters, isPdf]);

    const buildTxtBatchRequest = useCallback((size: number, mode: AnnotationBatchMode): AnnotationBatchRequest | null => {
        let minParagraphIndex: number;
        let maxParagraphIndex: number;

        if (isScrollMode) {
            // 滚动模式没有分页：以当前滚动比例估算「正在阅读」的段落窗口
            const total = currentChapter?.paragraphs.length || 0;
            if (total === 0) return null;
            const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (total - 1));
            const half = Math.max(1, Math.ceil(size / 2));
            minParagraphIndex = Math.max(0, center - half);
            maxParagraphIndex = Math.min(total - 1, center + half);
        } else {
            const pageItems = txtPages[txtPage] || [];
            const visibleParagraphIndexes = [...new Set(
                pageItems
                    .filter((item): item is Extract<TxtPageItem, { kind: "line" | "annotation" }> => item.kind === "line" || item.kind === "annotation")
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
            if (visibleParagraphIndexes.length === 0) return null;
            minParagraphIndex = visibleParagraphIndexes[0];
            maxParagraphIndex = visibleParagraphIndexes[visibleParagraphIndexes.length - 1];
        }

        const visibleRefs = paragraphRefs.filter((item) => item.chapterIndex === chapterIndex && item.paragraphIndex >= minParagraphIndex && item.paragraphIndex <= maxParagraphIndex);
        if (visibleRefs.length === 0) return null;

        const startCandidates: number[] = [];
        if (mode === "manual") {
            startCandidates.push(visibleRefs[0].absoluteIndex);
        } else if (mode === "auto-current") {
            startCandidates.push(Math.floor(visibleRefs[0].absoluteIndex / size) * size);
        } else {
            for (let start = Math.floor(visibleRefs[0].absoluteIndex / size) * size; start <= visibleRefs[visibleRefs.length - 1].absoluteIndex; start += size) {
                if (start >= visibleRefs[0].absoluteIndex && start <= visibleRefs[visibleRefs.length - 1].absoluteIndex) {
                    startCandidates.push(start);
                    break;
                }
            }
        }

        const startAbsoluteIndex = startCandidates[0];
        if (startAbsoluteIndex === undefined) return null;
        const items = paragraphRefs.slice(startAbsoluteIndex, startAbsoluteIndex + size).filter((item) => item.text.trim());
        if (items.length === 0) return null;

        return {
            key: `txt:${startAbsoluteIndex}:${size}`,
            title: `第${items[0].absoluteIndex + 1}-${items[items.length - 1].absoluteIndex + 1}段`,
            size,
            items,
        };
    }, [chapterIndex, currentChapter, isScrollMode, paragraphRefs, scrollFraction, txtPage, txtPages]);

    const getPdfBatchWindow = useCallback((size: number, mode: AnnotationBatchMode) => {
        const chapterMaxPage = Math.max(0, ...chapters.map((chapter) => chapter.pageEnd ?? 0));
        const refMaxPage = Math.max(0, ...paragraphRefs.map((item) => item.pageNum || 0));
        const maxPage = pdfTotalPages || chapterMaxPage || refMaxPage;
        if (maxPage <= 0) return null;
        const startPage = mode === "manual" ? pdfCurrentPage : Math.floor((pdfCurrentPage - 1) / size) * size + 1;
        if (mode === "auto" && pdfCurrentPage !== startPage) return null;
        const endPage = Math.min(maxPage, startPage + size - 1);
        return {
            key: `pdf:${startPage}:${size}`,
            title: `第${startPage}-${endPage}页`,
            size,
            startPage,
            endPage,
        };
    }, [chapters, paragraphRefs, pdfCurrentPage, pdfTotalPages]);

    const buildPdfBatchRequest = useCallback((size: number, mode: AnnotationBatchMode, refs: ParagraphRef[] = paragraphRefs): AnnotationBatchRequest | null => {
        const windowInfo = getPdfBatchWindow(size, mode);
        if (!windowInfo) return null;
        const items = refs.filter((item) => (item.pageNum || 0) >= windowInfo.startPage && (item.pageNum || 0) <= windowInfo.endPage && item.text.trim());
        if (items.length === 0) return null;

        return {
            key: windowInfo.key,
            title: windowInfo.title,
            size: windowInfo.size,
            items,
        };
    }, [getPdfBatchWindow, paragraphRefs]);

    const materializeBatchRequest = useCallback(async (size: number, mode: AnnotationBatchMode): Promise<AnnotationBatchRequest | null> => {
        if (!isPdf) return buildTxtBatchRequest(size, mode);

        const windowInfo = getPdfBatchWindow(size, mode);
        if (!windowInfo) return null;

        const mergedChapters = await ensurePdfPageRangeParsed(windowInfo.startPage, windowInfo.endPage);
        const refs = buildParagraphRefsFromChapters(mergedChapters);
        return buildPdfBatchRequest(size, mode, refs);
    }, [buildPdfBatchRequest, buildTxtBatchRequest, ensurePdfPageRangeParsed, getPdfBatchWindow, isPdf]);

    const executeBatchAnnotation = useCallback(async (request: AnnotationBatchRequest, options?: { force?: boolean }): Promise<boolean> => {
        if (!companionId) return false;
        const batchKey = `${book.id}:${companionId}:${request.key}`;
        if (!options?.force && generatedBatchesRef.current.has(batchKey)) return false;
        // 同步锁：同一时间只允许一个批注生成任务（auto/prefetch 竞态时后面的请求直接跳过，
        // 避免闭包里的 generating 旧值放行并发请求，导致同一批被重复生成）
        if (annotationInFlightRef.current) return false;
        // 同一批已在生成中：跳过（生成完成前 generatedBatchesRef 尚未写入，需用 in-flight 集合兜底）
        if (!options?.force && inFlightBatchesRef.current.has(batchKey)) return false;
        annotationInFlightRef.current = true;
        inFlightBatchesRef.current.add(batchKey);
        setGenerating(true);
        setAnnotationError(null);

        try {
            // 历史已有批注仅作为生成参考传入（generateAnnotationBatch 接收 existingAnnotations），
            // 不用于跳过：重新开启自动批注/重读书籍时，用户期望生成新的批注。
            // 「本次阅读体验内不重复」由 generatedBatchesRef（内存）保证。
            const existing = await loadExistingAnnotationsForItems(request.items);

            const newAnnotations = await withAnnotationRetry(
                () => generateAnnotationBatch(
                    book,
                    request.title,
                    request.items.map((item) => ({
                        chapterIndex: item.chapterIndex,
                        paragraphIndex: item.paragraphIndex,
                        text: item.text,
                    })),
                    existing,
                    companionId,
                ),
                readingConfig.annotationRetryCount > 0 ? readingConfig.annotationRetryCount : 0,
            );

            generatedBatchesRef.current.add(batchKey);

            if (newAnnotations.length > 0) {
                await saveAnnotations(newAnnotations);
                setAnnotations((prev) => {
                    const merged = new Map(prev.map((annotation) => [annotation.id, annotation]));
                    for (const annotation of newAnnotations) merged.set(annotation.id, annotation);
                    return [...merged.values()];
                });
            } else {
                setAnnotationError("AI 没有返回批注（可能返回了[无批注]或API调用失败）");
            }
            return true;
        } catch (err) {
            console.error("[Reading] Annotation error:", err);
            setAnnotationError(`批注失败: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            inFlightBatchesRef.current.delete(batchKey);
            annotationInFlightRef.current = false;
            setGenerating(false);
        }
    }, [book, companionId, loadExistingAnnotationsForItems, readingConfig.annotationRetryCount]);

    const openAnnotationDialog = (mode: AnnotationDialogMode) => {
        const nextSize = annotationBatchSize || (isPdf ? 5 : 50);
        setAnnotationBatchInput(String(nextSize));
        setAnnotationDialogMode(mode);
    };

    const handleAnnotationDialogConfirm = async () => {
        if (!annotationDialogMode) return;
        const size = clampBatchSize(Number(annotationBatchInput));
        setAnnotationBatchSize(size);
        setAnnotationBatchInput(String(size));

        if (annotationDialogMode === "auto") {
            setAnnotationDialogMode(null);
            if (autoAnnotate) {
                setAutoAnnotate(false);
                return;
            }
            setAutoAnnotate(true);
            generatedBatchesRef.current.clear();
            prefetchedBatchStartRef.current = -1; // 新的阅读体验：预生成触发标记一并重置
            const request = await materializeBatchRequest(size, "auto-current");
            if (request) await executeBatchAnnotation(request);
            return;
        }

        const request = await materializeBatchRequest(size, "manual");
        setAnnotationDialogMode(null);
        if (!request) return;
        generatedBatchesRef.current.delete(`${book.id}:${companionId || ""}:${request.key}`);
        await executeBatchAnnotation(request, { force: true });
    };

    /** 打开手动预批注对话框：默认预生成「当前页起一个批次」的范围 */
    const openPdfPrefetchDialog = () => {
        const start = Math.max(1, pdfCurrentPage || 1);
        const batch = Math.max(1, annotationBatchSize || 5);
        const end = Math.min(pdfTotalPages || (start + batch - 1), start + batch - 1);
        setAnnotationError(null);
        setPdfPrefetchStartInput(String(start));
        setPdfPrefetchEndInput(String(end));
        setPdfPrefetchDialogOpen(true);
    };

    /** 手动预批注：按用户自定义的页码范围，预解析文本层并立即生成批注 */
    const handlePdfManualPrefetch = async () => {
        if (!companionId) {
            setAnnotationError("请先选择共读角色");
            return;
        }
        const total = Math.max(1, pdfTotalPages || 1);
        const start = Math.max(1, Math.min(total, Math.round(Number(pdfPrefetchStartInput) || 1)));
        const end = Math.max(start, Math.min(total, Math.round(Number(pdfPrefetchEndInput) || start)));
        if (end - start + 1 > MAX_MANUAL_PDF_PREFETCH_PAGES) {
            setAnnotationError(`一次最多预批注 ${MAX_MANUAL_PDF_PREFETCH_PAGES} 页，请缩小页码范围`);
            return;
        }
        setAnnotationError(null);
        setPdfPrefetchDialogOpen(false);
        try {
            // 预解析指定范围的文本层（渲染已解耦，不会重建页面）
            const merged = await ensurePdfPageRangeParsed(start, end);
            const refs = buildParagraphRefsFromChapters(merged);
            const items = refs.filter((item) => (item.pageNum || 0) >= start && (item.pageNum || 0) <= end && item.text.trim());
            if (items.length === 0) {
                setAnnotationError("所选范围没有可批注的文本");
                return;
            }
            const request: AnnotationBatchRequest = {
                key: `pdf:${start}:${end}:manual`,
                title: `第${start}-${end}页`,
                size: end - start + 1,
                items,
            };
            await executeBatchAnnotation(request, { force: true });
        } catch (err) {
            console.error("[Reading] PDF manual prefetch error:", err);
            setAnnotationError(`预批注失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const openNavigationDialog = () => {
        setShowNavigationDialog(true);
    };

    const copyToClipboard = useCallback((text: string) => {
        const fallbackCopy = () => {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try { document.execCommand("copy"); } catch {}
            document.body.removeChild(ta);
        };
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(fallbackCopy);
        } else {
            fallbackCopy();
        }
    }, []);

    const closeReadingMessageMenu = useCallback(() => {
        setReadingMessageMenu(null);
        setActiveMessageId(null);
    }, []);

    const cancelReadingMessageLongPress = useCallback(() => {
        readingMessagePressStartRef.current = null;
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = undefined;
        }
    }, []);

    const handleReadingMessagePointerDown = useCallback((event: React.PointerEvent<HTMLElement>, msg: ChatMessage) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        readingMessagePressStartRef.current = { x: event.clientX, y: event.clientY };
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
        longPressTimer.current = setTimeout(() => {
            setActiveAnnotationId(null);
            setActiveMessageId(msg.id);
            setReadingMessageMenu({ messageId: msg.id, x: event.clientX, y: event.clientY });
            longPressTimer.current = undefined;
        }, 500);
    }, []);

    const handleReadingMessagePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const start = readingMessagePressStartRef.current;
        if (!start) return;
        const dx = Math.abs(event.clientX - start.x);
        const dy = Math.abs(event.clientY - start.y);
        if (dx > 10 || dy > 10) cancelReadingMessageLongPress();
    }, [cancelReadingMessageLongPress]);

    const getReadingMessageMenuStyle = useCallback((menu: { x: number; y: number }): React.CSSProperties => {
        const margin = 12;
        const estimatedWidth = 168;
        const estimatedHeight = 42;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const left = Math.min(
            Math.max(menu.x - estimatedWidth / 2, margin),
            Math.max(margin, viewportWidth - estimatedWidth - margin),
        );
        const top = menu.y > viewportHeight - estimatedHeight - 24
            ? Math.max(margin, menu.y - estimatedHeight - 12)
            : Math.min(menu.y + 12, viewportHeight - estimatedHeight - margin);

        return {
            left,
            top,
        };
    }, []);

    const handleEditDiscussMessageStart = useCallback((msg: ChatMessage) => {
        setEditingDiscussMessage(msg);
        setEditingDiscussContent(msg.content);
        closeReadingMessageMenu();
    }, [closeReadingMessageMenu]);

    const handleSaveDiscussMessageEdit = useCallback(() => {
        if (!editingDiscussMessage) return;
        const nextContent = editingDiscussContent.trim();
        if (!nextContent) return;
        editChatMessage(editingDiscussMessage.id, nextContent);
        setChatMessages((prev) => prev.map((msg) => msg.id === editingDiscussMessage.id ? { ...msg, content: nextContent } : msg));
        setEditingDiscussMessage(null);
        setEditingDiscussContent("");
    }, [editingDiscussContent, editingDiscussMessage]);

    useEffect(() => {
        if (!showChat || !chatExpanded) {
            setReadingMessageMenu(null);
            setActiveMessageId(null);
        }
    }, [showChat, chatExpanded]);

    // 共读讨论悬浮窗展开时自动滚动到最新消息。
    // 仅在「打开」时滚动一次、无持续吸附——用户随后自由滑动即可打断，不会被拉回。
    useEffect(() => {
        if (!showChat || !chatExpanded) return;
        if (readingConfig.chatAutoScrollOnOpen === false) return;
        const el = chatListRef.current;
        if (!el) return;
        let raf1 = 0;
        let raf2 = 0;
        // 等展开动画与内容渲染稳定后再滚到底
        raf1 = window.requestAnimationFrame(() => {
            raf2 = window.requestAnimationFrame(() => {
                el.scrollTop = el.scrollHeight;
            });
        });
        return () => {
            window.cancelAnimationFrame(raf1);
            window.cancelAnimationFrame(raf2);
        };
    }, [showChat, chatExpanded, readingConfig.chatAutoScrollOnOpen]);

    const handleDeleteReadingAnnotation = useCallback(async (annotationId: string) => {
        await deleteAnnotation(annotationId);
        setAnnotations((prev) => prev.filter((annotation) => annotation.id !== annotationId));
        setActiveAnnotationId(null);
    }, []);

    const handlePdfJumpComplete = useCallback(() => {
        setPdfJumpPage(undefined);
    }, []);

    const handleNavChapterClick = (index: number) => {
        if (isPdf) {
            const chapter = chapters[index];
            const firstPage = chapter?.pageStart ?? chapter?.paragraphPages?.[0] ?? 1;
            setChapterIndex(index);
            setPdfJumpPage(firstPage);
        } else {
            goToChapter(index);
        }
        setShowNavigationDialog(false);
    };

    const handleNavPageSlider = (value: number) => {
        if (isPdf) {
            setPdfJumpPage(value);
        } else {
            if (chapters.length === 0) return;

            const maxSliderValue = chapters.length + 1;
            const boundedValue = Math.max(1, Math.min(maxSliderValue, value));
            const rawPosition = boundedValue - 1;
            const targetChapterIndex = Math.min(chapters.length - 1, Math.floor(rawPosition));
            const pageFraction = Math.max(0, Math.min(1, rawPosition - targetChapterIndex));

            if (targetChapterIndex === chapterIndex) {
                if (isScrollMode) {
                    scrollToChapterFraction(pageFraction, chapterIndex);
                } else {
                    pendingTxtPageFractionRef.current = null;
                    setTxtPage(Math.round(pageFraction * Math.max(0, txtTotalPages - 1)));
                }
            } else {
                pendingTxtPageFractionRef.current = pageFraction;
                pendingScrollFractionRef.current = pageFraction;
                setChapterIndex(targetChapterIndex);
                setTxtPage(0);
            }
        }
    };

    const handleReadingSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest("button, input, select, textarea, a, [data-no-nav='true']")) return;
        if (activeMessageId || activeAnnotationId) {
            setActiveMessageId(null);
            setActiveAnnotationId(null);
            return;
        }

        if (!isPdf && !isScrollMode && currentChapter) {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const w = rect.width;
            if (x < w * 0.3) { navigateWithFlip('backward'); return; }
            if (x > w * 0.7) { navigateWithFlip('forward'); return; }
        }

        setImmersive(prev => !prev);
    };

    useEffect(() => {
        // 自动批注：跟随阅读位置推进，为当前批生成批注。
        // 与开启时的 bootstrap 并发时由 executeBatchAnnotation 的同步锁去重；
        // 若 bootstrap 未拿到批次（书刚打开数据未就绪），本 effect 会随阅读位置变化持续兜底触发。
        if (!autoAnnotate || generating || !companionId) return;
        void (async () => {
            const request = await materializeBatchRequest(annotationBatchSize, "auto");
            if (!request) return;
            await executeBatchAnnotation(request);
        })();
    }, [annotationBatchSize, autoAnnotate, companionId, executeBatchAnnotation, generating, materializeBatchRequest]);

    // 批注预生成：当前批注批读到用户设置的阈值时，提前生成下一批，
    // 把生成时间差放在用户读上一批批注的时间里，避免用户读到下一批时批注还没生成完。不会重复批注（批次按 key 去重）。
    // TXT 按「段落」分批次（autoAnnotatePrefetch 控制）；PDF 按「页数」分批次（autoAnnotatePrefetchPdf 控制），
    // 两者各自独立开关，批次大小统一跟随自动批注的 annotationBatchSize。
    const prefetchedBatchStartRef = useRef(-1);
    useEffect(() => {
        if (!autoAnnotate) { prefetchedBatchStartRef.current = -1; return; }
        if (!companionId || generating) return;
        const size = Math.max(1, annotationBatchSize || (isPdf ? 5 : 50));
        const threshold = Math.max(0, Math.min(1, readingConfig.annotationPrefetchThreshold ?? 2 / 3));

        if (isPdf) {
            // PDF 预批注开关：关闭时不预生成
            if (!readingConfig.autoAnnotatePrefetchPdf) { prefetchedBatchStartRef.current = -1; return; }
            // PDF：按页分批次。当前页所在批次读到阈值时，预解析并预生成下一批批注。
            if (pdfTotalPages <= 0) return;
            const batchStartPage = Math.floor((pdfCurrentPage - 1) / size) * size + 1;
            const offsetInBatch = pdfCurrentPage - batchStartPage; // 0-based
            if ((offsetInBatch + 1) / size < threshold) return; // 本批还没读到阈值
            if (prefetchedBatchStartRef.current === batchStartPage) return;
            prefetchedBatchStartRef.current = batchStartPage;

            const nextStartPage = batchStartPage + size;
            if (nextStartPage > pdfTotalPages) return;
            const nextEndPage = Math.min(nextStartPage + size - 1, pdfTotalPages);
            void (async () => {
                try {
                    // 预解析下一批文本层（解析后 setChapters，但渲染已与文本层解耦，不会重建页面）
                    const merged = await ensurePdfPageRangeParsed(nextStartPage, nextEndPage);
                    const refs = buildParagraphRefsFromChapters(merged);
                    const items = refs.filter((item) => (item.pageNum || 0) >= nextStartPage && (item.pageNum || 0) <= nextEndPage && item.text.trim());
                    if (items.length === 0) { prefetchedBatchStartRef.current = -1; return; }
                    const request: AnnotationBatchRequest = {
                        key: `pdf:${nextStartPage}:${size}`,
                        title: `第${nextStartPage}-${nextEndPage}页`,
                        size,
                        items,
                    };
                    // 若被跳过，重置标记让下一轮滚动再试，避免预生成丢失
                    void executeBatchAnnotation(request).then((started) => {
                        if (!started) prefetchedBatchStartRef.current = -1;
                    });
                } catch (err) {
                    console.error("[Reading] PDF prefetch error:", err);
                    prefetchedBatchStartRef.current = -1;
                }
            })();
            return;
        }

        // TXT 预批注开关：关闭时不预生成
        if (!readingConfig.autoAnnotatePrefetch) { prefetchedBatchStartRef.current = -1; return; }

        // TXT：当前阅读位置 → 全书记绝对段落索引
        if (paragraphRefs.length === 0) return;
        let currentAbs = -1;
        if (isScrollMode) {
            const chapterRefs = paragraphRefs.filter((item) => item.chapterIndex === chapterIndex && item.text.trim());
            if (chapterRefs.length > 0) {
                const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (chapterRefs.length - 1));
                currentAbs = chapterRefs[center].absoluteIndex;
            }
        } else {
            const pageItems = txtPages[txtPage] || [];
            const firstLine = pageItems.find((item): item is Extract<TxtPageItem, { kind: "line" }> => item.kind === "line");
            if (firstLine) {
                const ref = paragraphRefs.find((r) => r.chapterIndex === firstLine.chapterIndex && r.paragraphIndex === firstLine.paragraphIndex);
                if (ref) currentAbs = ref.absoluteIndex;
            }
        }
        if (currentAbs < 0) return;

        const batchStart = Math.floor(currentAbs / size) * size;
        if ((currentAbs - batchStart + 1) / size < threshold) return; // 本批还没读到用户设置的阈值
        if (prefetchedBatchStartRef.current === batchStart) return;       // 本批已触发过预生成
        prefetchedBatchStartRef.current = batchStart;

        const nextStart = batchStart + size;
        if (nextStart >= paragraphRefs.length) return;
        const items = paragraphRefs.slice(nextStart, nextStart + size).filter((item) => item.text.trim());
        if (items.length === 0) return;

        const request: AnnotationBatchRequest = {
            key: `txt:${nextStart}:${size}`,
            title: `第${items[0].absoluteIndex + 1}-${items[items.length - 1].absoluteIndex + 1}段`,
            size,
            items,
        };
        // 若被跳过（自动批注正在生成/该批已生成），重置标记让下一轮滚动再试，避免预生成丢失
        void executeBatchAnnotation(request).then((started) => {
            if (!started) prefetchedBatchStartRef.current = -1;
        });
    }, [annotationBatchSize, autoAnnotate, chapterIndex, companionId, ensurePdfPageRangeParsed, executeBatchAnnotation, generating, isPdf, isScrollMode, paragraphRefs, pdfCurrentPage, pdfTotalPages, readingConfig.autoAnnotatePrefetch, readingConfig.autoAnnotatePrefetchPdf, readingConfig.annotationPrefetchThreshold, scrollFraction, txtPage, txtPages]);

    useEffect(() => {
        // 自动批注开启时，随滚动把当前 5 页的文本层预先解析好，让批注生成请求不用临时等待解析。
        // 手动写批注 / 共读讨论内部会自行 ensurePdfPageRangeParsed，关闭自动批注时纯阅读不预解析。
        // 渲染已与文本层解耦：此处 setChapters 只会触发批注钉局部更新，不会重建页面，无闪烁。
        if (!isPdf || !autoAnnotate || pdfCurrentPage <= 0 || chapters.length === 0) return;
        const chunkStart = Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1;
        const chunkEnd = Math.min(chunkStart + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages || chunkStart + PDF_PAGES_PER_CHAPTER - 1);
        void ensurePdfPageRangeParsed(chunkStart, chunkEnd).catch((err) => {
            console.error("[Reading] PDF lazy parse error:", err);
        });
    }, [autoAnnotate, chapters.length, ensurePdfPageRangeParsed, isPdf, pdfCurrentPage, pdfTotalPages]);

    // Chapter navigation
    const goToChapter = (idx: number, startFromEnd = false) => {
        if (idx < 0 || idx >= chapters.length) return;
        pendingTxtPageFractionRef.current = startFromEnd ? 1 : null;
        // 滚动模式：显式跳章后定位到新章节的起点（0）或终点（1），而非窗口顶部（可能是上一章）
        // 实际滚动位置由渲染后的 useLayoutEffect 依据章节块度量换算
        pendingScrollFractionRef.current = startFromEnd ? 1 : 0;
        setChapterIndex(idx);
        setTxtPage(0);
    };

    const buildDiscussContext = useCallback((sourceChapters: BookChapter[] = chapters): ReadingDiscussContext | null => {
        const sourceParagraphRefs = buildParagraphRefsFromChapters(sourceChapters);
        if (sourceParagraphRefs.length === 0) return null;

        let focusChapterIndex = chapterIndex;
        let focusParagraphIndexes: number[] = [];

        if (isPdf) {
            let focusRefs = sourceParagraphRefs.filter((item) => item.text.trim() && (item.pageNum || 0) === pdfCurrentPage);
            if (focusRefs.length === 0) {
                let nearestDistance = Number.POSITIVE_INFINITY;
                for (const item of sourceParagraphRefs) {
                    if (!item.text.trim() || !item.pageNum) continue;
                    nearestDistance = Math.min(nearestDistance, Math.abs(item.pageNum - pdfCurrentPage));
                }
                if (Number.isFinite(nearestDistance)) {
                    focusRefs = sourceParagraphRefs.filter((item) => item.text.trim() && item.pageNum && Math.abs(item.pageNum - pdfCurrentPage) === nearestDistance);
                }
            }
            if (focusRefs.length === 0) return null;

            const chapterCounts = new Map<number, number>();
            for (const item of focusRefs) {
                chapterCounts.set(item.chapterIndex, (chapterCounts.get(item.chapterIndex) || 0) + 1);
            }
            focusChapterIndex = [...chapterCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? chapterIndex;
            focusParagraphIndexes = [...new Set(
                focusRefs
                    .filter((item) => item.chapterIndex === focusChapterIndex)
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
        } else if (isScrollMode) {
            // 滚动模式没有分页：以当前滚动比例估算正在阅读的段落窗口
            const chapterRefs0 = sourceParagraphRefs.filter((item) => item.chapterIndex === focusChapterIndex && item.text.trim());
            if (chapterRefs0.length === 0) return null;
            const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (chapterRefs0.length - 1));
            const half = Math.max(1, Math.ceil(DISCUSS_MAX_PARAGRAPHS / 3));
            focusParagraphIndexes = chapterRefs0
                .slice(Math.max(0, center - half), Math.min(chapterRefs0.length, center + half + 1))
                .map((item) => item.paragraphIndex);
        } else {
            const pageItems = txtPages[txtPage] || [];
            focusParagraphIndexes = [...new Set(
                pageItems
                    .filter((item): item is Extract<TxtPageItem, { kind: "line" | "annotation" }> => item.kind === "line" || item.kind === "annotation")
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
        }

        if (focusParagraphIndexes.length === 0) return null;

        const chapterRefs = sourceParagraphRefs.filter((item) => item.chapterIndex === focusChapterIndex && item.text.trim());
        if (chapterRefs.length === 0) return null;

        const focusStartParagraph = focusParagraphIndexes[0];
        const focusEndParagraph = focusParagraphIndexes[focusParagraphIndexes.length - 1];
        let startPos = chapterRefs.findIndex((item) => item.paragraphIndex === focusStartParagraph);
        let endPos = chapterRefs.findIndex((item) => item.paragraphIndex === focusEndParagraph);
        if (startPos === -1 || endPos === -1) return null;

        let usedChars = chapterRefs.slice(startPos, endPos + 1).reduce((sum, item) => sum + getParagraphLength(item.text), 0);
        while ((usedChars < DISCUSS_TARGET_CHARS || usedChars < DISCUSS_MIN_CHARS) && (startPos > 0 || endPos < chapterRefs.length - 1)) {
            if (endPos - startPos + 1 >= DISCUSS_MAX_PARAGRAPHS) break;

            const prevRef = startPos > 0 ? chapterRefs[startPos - 1] : null;
            const nextRef = endPos < chapterRefs.length - 1 ? chapterRefs[endPos + 1] : null;
            if (!prevRef && !nextRef) break;

            const prevChars = prevRef ? getParagraphLength(prevRef.text) : Number.POSITIVE_INFINITY;
            const nextChars = nextRef ? getParagraphLength(nextRef.text) : Number.POSITIVE_INFINITY;
            const pickPrev = prevRef && (!nextRef || prevChars <= nextChars);
            const candidate = pickPrev ? prevRef : nextRef;
            if (!candidate) break;

            const nextUsedChars = usedChars + getParagraphLength(candidate.text);
            if (usedChars >= DISCUSS_TARGET_CHARS && usedChars >= DISCUSS_MIN_CHARS && nextUsedChars > DISCUSS_MAX_CHARS) break;

            if (pickPrev) startPos -= 1;
            else endPos += 1;
            usedChars = nextUsedChars;
        }

        const contextRefs = chapterRefs.slice(startPos, endPos + 1);
        if (contextRefs.length === 0) return null;

        const contextStartParagraph = contextRefs[0].paragraphIndex;
        const contextEndParagraph = contextRefs[contextRefs.length - 1].paragraphIndex;
        const paragraphSet = new Set(contextRefs.map((item) => item.paragraphIndex));
        const contextAnnotations = annotations.filter(
            (annotation) => annotation.chapterIndex === focusChapterIndex && paragraphSet.has(annotation.paragraphIndex),
        );
        const chapterTitleText = chapters[focusChapterIndex]?.title || currentChapter?.title || book.title;
        const chapterContent = [
            `当前阅读中心：${formatParagraphRangeLabel(focusStartParagraph, focusEndParagraph)}`,
            `本次上下文范围：${formatParagraphRangeLabel(contextStartParagraph, contextEndParagraph)}`,
            "",
            contextRefs.map((item) => `[${item.paragraphIndex + 1}] ${item.text}`).join("\n\n"),
        ].join("\n");

        return {
            chapterTitle: chapterTitleText,
            chapterContent,
            annotations: contextAnnotations,
        };
    }, [annotations, book.title, chapterIndex, chapters, currentChapter?.title, isPdf, isScrollMode, pdfCurrentPage, scrollFraction, txtPage, txtPages]);

    // Chat send — parse AI response like chat-room does
    const handleSend = async () => {
        if (!chatInput.trim() || !companionId || chatting) return;
        const text = chatInput.trim();
        setChatInput("");

        const session = getSession();
        if (!session) return;

        // Save user message
        const userMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: text,
            origin: "reading_discuss",
            mediaData: { readingBookTitle: book.title },
        });
        setChatMessages(prev => [...prev, userMsg]);

        setChatting(true);
        try {
            const sourceChapters = isPdf
                ? await ensurePdfPageRangeParsed(
                    Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1,
                    Math.min(
                        Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + PDF_PAGES_PER_CHAPTER,
                        pdfTotalPages || Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + PDF_PAGES_PER_CHAPTER,
                    ) - 1,
                )
                : chapters;
            const discussContext = buildDiscussContext(sourceChapters);
            if (!discussContext) return;
            const rawReply = await generateReadingChat(session, book, discussContext, companionId);
            if (rawReply) {
                const { reply, actions } = parseReadingDiscussResponse(rawReply);
                // Parse like chat: split into parts, extract inner monologue, state values, media
                if (reply) {
                    const { parts, statusPanel, innerMonologue, stateValues, freshStateValues } = parseAIResponse(reply, []);
                    const newMsgs: ChatMessage[] = [];
                    const saveParts: typeof parts = parts.length > 0 || !(statusPanel || innerMonologue) ? parts : [{ content: "" }];
                    for (let i = 0; i < saveParts.length; i++) {
                        const msg = pushChatMessage({
                            sessionId: session.id,
                            role: "assistant",
                            content: saveParts[i].content,
                            mediaType: saveParts[i].mediaType,
                            origin: "reading_discuss",
                            mediaData: { ...saveParts[i].mediaData, readingBookTitle: book.title },
                            statusPanel: i === 0 && statusPanel ? statusPanel : undefined,
                            innerMonologue: i === 0 && innerMonologue ? innerMonologue : undefined,
                            stateValues: i === 0 && stateValues.length > 0 ? stateValues : undefined,
                            freshStateValues: i === 0 ? freshStateValues : undefined,
                        });
                        newMsgs.push(msg);
                    }
                    setChatMessages(prev => [...prev, ...newMsgs]);
                }
                if (actions.length > 0) {
                    await applyDiscussActions(actions);
                }
            }
        } catch (err) {
            console.error("[Reading] Chat error:", err);
        } finally {
            setChatting(false);
        }
    };

    const applyDiscussActions = useCallback(async (actions: ReadingDiscussAction[]) => {
        if (!currentChapter || !companionId || !companion) return;

        let nextAnnotations = annotations;

        for (const action of actions) {
            if (action.type === "add_annotation") {
                if (action.paragraphIndex < 0 || action.paragraphIndex >= currentChapter.paragraphs.length) continue;
                const annotation: ReadingAnnotation = {
                    id: `ra_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    bookId: book.id,
                    chapterIndex,
                    paragraphIndex: action.paragraphIndex,
                    characterId: companionId,
                    characterName: companion.name,
                    content: action.content,
                    createdAt: new Date().toISOString(),
                };
                await saveAnnotation(annotation);
                nextAnnotations = [...nextAnnotations, annotation];
                continue;
            }

            const target = nextAnnotations.find((annotation) => annotation.id === action.annotationId && annotation.chapterIndex === chapterIndex);
            if (!target) continue;

            if (action.type === "delete_annotation") {
                await deleteAnnotation(action.annotationId);
                nextAnnotations = nextAnnotations.filter((annotation) => annotation.id !== action.annotationId);
                continue;
            }

            const updated: ReadingAnnotation = {
                ...target,
                content: action.content,
            };
            await saveAnnotation(updated);
            nextAnnotations = nextAnnotations.map((annotation) => annotation.id === updated.id ? updated : annotation);
        }

        setAnnotations(nextAnnotations);
    }, [annotations, book.id, chapterIndex, companion, companionId, currentChapter]);

    const handleOpenChat = () => {
        setShowChat(true);
        setChatExpanded(false);
        closeCharPicker();
    };

    const [chatClosing, setChatClosing] = useState(false);
    const handleCloseChat = () => {
        if (chatClosing) return;
        setChatClosing(true);
        setTimeout(() => {
            setShowChat(false);
            setChatExpanded(false);
            setChatClosing(false);
        }, 200);
    };

    const shouldIgnoreChatAction = () => {
        if (!chatMovedRef.current) return false;
        chatMovedRef.current = false;
        return true;
    };

    const handleChatDragStart = (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        // 悬浮球自身就是一个 button，点击与拖拽靠 chatMovedRef 区分，必须允许拖拽；
        // 悬浮条/窗内部的交互元素（按钮/输入框/正文滚动区等）不参与拖拽，避免抢占点击。
        const target = e.target as HTMLElement;
        if (!target.closest(".reading-chat-launch") && target.closest("button, input, textarea, select, a, .reading-chat-float-body, .reading-char-picker")) return;
        setIsDragging(true);
        chatDragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            originX: chatOffset.x,
            originY: chatOffset.y,
        };
        chatMovedRef.current = false;
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };

    const handleChatDragMove = (e: React.PointerEvent<HTMLElement>) => {
        const drag = chatDragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        const nextX = drag.originX + (e.clientX - drag.startX);
        const nextY = drag.originY + (e.clientY - drag.startY);
        const dragThreshold = e.pointerType === "touch" ? 12 : 6;
        if (!chatMovedRef.current && (Math.abs(nextX - drag.originX) > dragThreshold || Math.abs(nextY - drag.originY) > dragThreshold)) {
            chatMovedRef.current = true;
        }
        if (chatMovedRef.current) {
            // 拖拽过程中就约束在屏幕内，悬浮元素永不滑出屏幕外
            setChatOffset(clampChatOffset({ x: nextX, y: nextY }));
        }
    };

    // 悬浮元素尺寸（按当前形态估算，用于边界约束/贴边吸附）
    const getChatFloatSize = () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (!showChat) return { width: 56, height: 56 };                                    // 悬浮球
        if (!chatExpanded) return { width: Math.min(280, w - CHAT_FLOAT_MARGIN * 2), height: 56 }; // 悬浮条
        return { width: Math.min(300, w - CHAT_FLOAT_MARGIN * 2), height: Math.min(380, h * 0.55) }; // 悬浮窗
    };

    // 把偏移量约束在可视范围内。CSS 基础位置为 left:12px / bottom:12px，
    // 偏移是相对该基础位置的 translate3d，正 Y 向下。
    const clampChatOffset = (offset: { x: number; y: number }): { x: number; y: number } => {
        const { width, height } = getChatFloatSize();
        const w = window.innerWidth;
        const h = window.innerHeight;
        const maxX = w - CHAT_FLOAT_MARGIN * 2 - width;
        const maxY = height + CHAT_FLOAT_MARGIN * 2 - h; // 允许向上拖到接近顶边（负值表示可上移）
        return {
            x: Math.max(0, Math.min(maxX, offset.x)),
            y: Math.max(maxY, Math.min(0, offset.y)),
        };
    };

    const persistChatFloatPos = (offset: { x: number; y: number }) => {
        try {
            localStorage.setItem(CHAT_FLOAT_POS_KEY, JSON.stringify(clampChatOffset(offset)));
        } catch {
            // ignore storage errors
        }
    };

    // 悬浮形态切换（球→条→窗 / 收起）后把位置约束回可视范围，防止越界丢失
    useEffect(() => {
        setChatOffset((prev) => {
            const clamped = clampChatOffset(prev);
            return clamped.x === prev.x && clamped.y === prev.y ? prev : clamped;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showChat, chatExpanded]);

    // 始终指向最新版本的 clampChatOffset（供一次性挂载的监听器使用）
    const clampChatOffsetRef = useRef(clampChatOffset);
    clampChatOffsetRef.current = clampChatOffset;

    // 窗口尺寸变化（旋转/分屏）后把悬浮元素约束回屏幕内；书架设置里的「重置位置」事件
    useEffect(() => {
        const onResize = () => {
            setChatOffset((prev) => {
                const clamped = clampChatOffsetRef.current(prev);
                return clamped.x === prev.x && clamped.y === prev.y ? prev : clamped;
            });
        };
        const onResetPos = () => {
            setChatOffset({ x: 0, y: 0 });
            try {
                localStorage.setItem(CHAT_FLOAT_POS_KEY, JSON.stringify({ x: 0, y: 0 }));
            } catch {
                // ignore storage errors
            }
        };
        window.addEventListener("resize", onResize);
        window.addEventListener("reading-chat-float-reset", onResetPos);
        return () => {
            window.removeEventListener("resize", onResize);
            window.removeEventListener("reading-chat-float-reset", onResetPos);
        };
    }, []);

    const handleChatDragEnd = (e: React.PointerEvent<HTMLElement>) => {
        const drag = chatDragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        chatDragRef.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        setIsDragging(false);

        // 纯点击（没拖动）不吸附、不改位置
        if (!chatMovedRef.current) {
            chatMovedRef.current = false;
            return;
        }
        chatMovedRef.current = false;

        let target = clampChatOffset({ x: chatOffset.x, y: chatOffset.y });
        if (!chatExpanded) {
            // 悬浮球/悬浮条：横向吸附到最近的边缘（贴左或贴右）
            const { width } = getChatFloatSize();
            const maxX = window.innerWidth - CHAT_FLOAT_MARGIN * 2 - width;
            const leftDist = target.x;
            const rightDist = maxX - target.x;
            target = { x: leftDist <= rightDist ? 0 : maxX, y: target.y };
        }
        setChatOffset(target);
        persistChatFloatPos(target);
    };

    const handleChatLaunchClick = () => {
        if (chatMovedRef.current) {
            chatMovedRef.current = false;
            return;
        }
        handleOpenChat();
    };

    const chatFloatingStyle = {
        transform: `translate3d(${chatOffset.x}px, ${chatOffset.y}px, 0)`,
        transition: isDragging ? 'none' : 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), width 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), border-radius 0.3s ease-out',
    };

    useEffect(() => {
        if (isPdf || !scrollRef.current) return;

        const body = scrollRef.current;
        const onResize = () => setTxtLayoutVersion((v) => v + 1);
        const resizeObserver = new ResizeObserver(onResize);
        resizeObserver.observe(body);

        const fontsReady = (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
        fontsReady?.then(onResize).catch(() => {});

        return () => resizeObserver.disconnect();
    }, [isPdf]);

    useEffect(() => {
        if (isPdf || !currentChapter) return;
        const rafId = window.requestAnimationFrame(() => {
            setTxtLayoutVersion((v) => v + 1);
        });
        return () => window.cancelAnimationFrame(rafId);
    }, [annotations, chapterIndex, currentChapter, isPdf]);

    // TXT pagination — split by actual rendered width/height so each page fits one screen.
    // 滚动模式下不参与分页，直接渲染整章内容。
    useEffect(() => {
        if (isPdf || isScrollMode || !currentChapter || !scrollRef.current || !txtMeasureLineRef.current || !txtMeasureGapRef.current || !txtMeasureAnnotationRef.current) {
            setTxtPages([]);
            return;
        }

        const body = scrollRef.current;
        const bodyStyle = window.getComputedStyle(body);
        const bodyPaddingX = parseFloat(bodyStyle.paddingLeft || "0") + parseFloat(bodyStyle.paddingRight || "0");
        const bodyPaddingY = parseFloat(bodyStyle.paddingTop || "0") + parseFloat(bodyStyle.paddingBottom || "0");
        const surface = body.querySelector('.reading-page-surface') as HTMLElement | null;
        const surfacePadX = surface
            ? parseFloat(getComputedStyle(surface).paddingLeft || "0") + parseFloat(getComputedStyle(surface).paddingRight || "0")
            : 0;
        const maxWidth = Math.max(1, body.clientWidth - bodyPaddingX - surfacePadX);
        const bottomOverlayReserve = 40;
        const maxHeight = Math.max(1, body.clientHeight - bodyPaddingY - bottomOverlayReserve);

        const lineStyle = window.getComputedStyle(txtMeasureLineRef.current);
        const gapStyle = window.getComputedStyle(txtMeasureGapRef.current);
        const lineHeight = parseFloat(lineStyle.lineHeight || "0") || 30.4;
        const gapHeight = parseFloat(gapStyle.height || "0") || 20;
        const fontSize = parseFloat(lineStyle.fontSize || "0") || 16;
        const indentWidth = fontSize * 2;
        const annotationMeasure = txtMeasureAnnotationRef.current;
        const annotationNameEl = annotationMeasure.querySelector(".reading-annotation-name") as HTMLElement | null;
        const annotationTextEl = annotationMeasure.querySelector(".reading-annotation-text") as HTMLElement | null;
        const annotationMeasureStyle = window.getComputedStyle(annotationMeasure);
        const annotationMarginY =
            parseFloat(annotationMeasureStyle.marginTop || "0") +
            parseFloat(annotationMeasureStyle.marginBottom || "0");
        const chapterAnnotations = annotations.filter((annotation) => annotation.chapterIndex === chapterIndex);
        const annotationSignature = chapterAnnotations
            .map((annotation) => `${annotation.id}:${annotation.content.length}:${isAnnotationTranslationExpanded(annotation.id) ? 1 : 0}`)
            .join("|");
        const paragraphCharCount = currentChapter.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
        const paginationSignature = [
            currentChapter.id,
            chapterIndex,
            currentChapter.paragraphs.length,
            paragraphCharCount,
            annotationSignature,
            bilingualTranslationEnabled ? 1 : 0,
            Math.round(maxWidth),
            Math.round(maxHeight),
            lineHeight,
            gapHeight,
            fontSize,
            lineStyle.fontFamily,
            lineStyle.fontWeight,
            lineStyle.fontStyle,
        ].join("::");

        if (lastTxtPaginationSignatureRef.current === paginationSignature) return;

        const measureAnnotationHeight = (annotation: ReadingAnnotation) => {
            if (!annotationNameEl || !annotationTextEl) return lineHeight * 2;
            annotationNameEl.textContent = annotation.characterName;
            const bilingual = bilingualTranslationEnabled ? splitBilingualText(annotation.content) : null;
            if (!bilingual) {
                annotationTextEl.textContent = annotation.content;
            } else {
                const expanded = isAnnotationTranslationExpanded(annotation.id);
                annotationTextEl.textContent = expanded
                    ? `${bilingual.original}\n收起中文\n${bilingual.translated}`
                    : `${bilingual.original}\n中文`;
            }
            const blockHeight = annotationMeasure.offsetHeight || lineHeight * 2;
            return blockHeight + annotationMarginY;
        };

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            setTxtPages([[{ kind: "line", text: currentChapter.paragraphs.join(" "), chapterIndex, paragraphIndex: 0, indent: true }]]);
            return;
        }
        ctx.font = toCanvasFont(lineStyle);

        const tokens: TxtPageItem[] = [];
        const annotationMap = new Map<number, ReadingAnnotation[]>();
        for (const annotation of chapterAnnotations) {
            const list = annotationMap.get(annotation.paragraphIndex) || [];
            list.push(annotation);
            annotationMap.set(annotation.paragraphIndex, list);
        }

        currentChapter.paragraphs.forEach((paragraph, index) => {
            const segments = paragraph.split("\n");
            segments.forEach((segment, segmentIndex) => {
                const shouldIndent = segmentIndex === 0;
                const wrappedLines = wrapTextToLines(segment, maxWidth, ctx, shouldIndent ? indentWidth : 0);
                wrappedLines.forEach((line, lineIndex) => {
                    tokens.push({ kind: "line", text: line, chapterIndex, paragraphIndex: index, indent: shouldIndent && lineIndex === 0, segEnd: lineIndex === wrappedLines.length - 1 });
                });
                if (segmentIndex < segments.length - 1) tokens.push({ kind: "gap", chapterIndex, paragraphIndex: index });
            });
            const paragraphAnnotations = annotationMap.get(index) || [];
            for (const annotation of paragraphAnnotations) {
                tokens.push({ kind: "annotation", annotation, chapterIndex, paragraphIndex: index });
            }
            if (index < currentChapter.paragraphs.length - 1) tokens.push({ kind: "gap", chapterIndex, paragraphIndex: index });
        });

        const pages: TxtPageItem[][] = [];
        let currentPage: TxtPageItem[] = [];
        let usedHeight = 0;

        for (const token of tokens) {
            const tokenHeight = token.kind === "gap" ? gapHeight : token.kind === "annotation" ? measureAnnotationHeight(token.annotation) : lineHeight;
            if (token.kind === "gap" && currentPage.length === 0) continue;

            if (currentPage.length > 0 && usedHeight + tokenHeight > maxHeight) {
                pages.push(trimTrailingGaps(currentPage));
                currentPage = [];
                usedHeight = 0;
                if (token.kind === "gap") continue;
            }

            currentPage.push(token);
            usedHeight += tokenHeight;
        }

        const lastPage = trimTrailingGaps(currentPage);
        if (lastPage.length > 0) pages.push(lastPage);
        if (pages.length === 0) pages.push([{ kind: "line", text: "", chapterIndex, paragraphIndex: 0 }]);

        lastTxtPaginationSignatureRef.current = paginationSignature;
        setTxtPages(pages);
    }, [annotations, bilingualTranslationEnabled, chapterIndex, currentChapter, isAnnotationTranslationExpanded, isPdf, isScrollMode, txtLayoutVersion]);

    const txtTotalPages = txtPagesReadyForCurrentChapter ? txtPages.length : 1;

    const navigateWithFlip = useCallback((direction: 'forward' | 'backward') => {
        if (flipAnim || isPdf) return;
        const currentItems = txtPages[txtPage];
        if (!currentItems || currentItems.length === 0) return;

        const canForward = txtPage < txtTotalPages - 1 || chapterIndex < chapters.length - 1;
        const canBackward = txtPage > 0 || chapterIndex > 0;
        if (direction === 'forward' && !canForward) return;
        if (direction === 'backward' && !canBackward) return;

        setFlipAnim({ direction, items: currentItems });

        if (direction === 'forward') {
            if (txtPage < txtTotalPages - 1) setTxtPage(p => p + 1);
            else goToChapter(chapterIndex + 1);
        } else {
            if (txtPage > 0) setTxtPage(p => p - 1);
            else goToChapter(chapterIndex - 1, true);
        }
    }, [flipAnim, isPdf, txtPages, txtPage, txtTotalPages, chapterIndex, chapters.length]);

    const txtDisplayedPage = Math.min(txtPage + 1, txtTotalPages);
    const currentPageCount = isPdf ? Math.max(1, pdfTotalPages || 1) : Math.max(1, txtTotalPages);
    const txtBookSliderMax = chapters.length > 0 ? chapters.length + 1 : 1;
    const txtBookSliderValue = (() => {
        if (chapters.length === 0) return 1;
        const boundedChapterIndex = Math.max(0, Math.min(chapters.length - 1, chapterIndex));
        const pageFraction = isScrollMode
            ? Math.max(0, Math.min(1, scrollFraction))
            : (txtTotalPages > 1 ? Math.max(0, Math.min(txtPage, txtTotalPages - 1)) / (txtTotalPages - 1) : 0);
        return Math.max(1, Math.min(txtBookSliderMax, boundedChapterIndex + 1 + pageFraction));
    })();
    useEffect(() => {
        if (isPdf || isScrollMode) return;
        const pendingFraction = pendingTxtPageFractionRef.current;
        if (pendingFraction === null || txtPagesChapterIndex !== chapterIndex) return;

        setTxtPage(Math.round(pendingFraction * Math.max(0, txtTotalPages - 1)));
        pendingTxtPageFractionRef.current = null;
    }, [chapterIndex, isPdf, isScrollMode, txtPagesChapterIndex, txtTotalPages]);

    useEffect(() => {
        if (!chaptersLoaded || chapters.length === 0) return;

        let scrollPosition: number;
        let progressFraction: number;
        let progressCurrent: number;
        let progressTotal: number;
        let progressScope: "book" | "chapter";
        if (isPdf) {
            scrollPosition = Math.max(0, pdfCurrentPage - 1);
            progressFraction = pdfTotalPages > 0 ? Math.min(1, Math.max(0, pdfCurrentPage / pdfTotalPages)) : 0;
            progressCurrent = Math.max(1, pdfCurrentPage);
            progressTotal = Math.max(1, pdfTotalPages || 1);
            progressScope = "book";
        } else if (isScrollMode) {
            const fraction = Math.max(0, Math.min(1, scrollFraction));
            scrollPosition = fraction;
            progressFraction = Math.min(1, Math.max(0, (chapterIndex + fraction) / Math.max(1, chapters.length)));
            progressCurrent = Math.max(1, Math.round(fraction * 100));
            progressTotal = 100;
            progressScope = "chapter";
        } else {
            const chapterPageCurrent = Math.max(1, txtPage + 1);
            const chapterPageTotal = Math.max(1, txtTotalPages);
            scrollPosition = txtPage;
            progressFraction = Math.min(1, Math.max(0, (chapterIndex + chapterPageCurrent / chapterPageTotal) / Math.max(1, chapters.length)));
            progressCurrent = chapterPageCurrent;
            progressTotal = chapterPageTotal;
            progressScope = "chapter";
        }

        const progress: ReadingProgress = {
            bookId: book.id,
            chapterIndex,
            scrollPosition,
            companionCharacterId: companionId || undefined,
            progressFraction,
            progressCurrent,
            progressTotal,
            progressScope,
            readingMode: isPdf ? undefined : (isScrollMode ? "scroll" : "page"),
            lastReadAt: new Date().toISOString(),
        };
        saveProgress(progress);
    }, [book.id, chapterIndex, chapters.length, chaptersLoaded, companionId, isPdf, isScrollMode, pdfCurrentPage, pdfTotalPages, scrollFraction, txtPage, txtTotalPages]);

    useEffect(() => {
        setTxtPage((prev) => Math.min(prev, Math.max(0, txtTotalPages - 1)));
    }, [txtTotalPages]);

    // Scroll to top when page changes (仅翻页模式；滚动模式的位置由 useLayoutEffect 统一管理)
    useEffect(() => {
        if (isScrollMode) return;
        scrollRef.current?.scrollTo(0, 0);
    }, [txtPage, isScrollMode]);

    // 滚动模式：监听滚动 —— 更新章节内滚动比例；无缝衔接（多章窗口平移，保持视觉连续）
    // 前向：当前章内容读完（章底滚到视口顶部/底部）→ 移除顶部章块 + 补偿滚动位置，自然过渡到下一章
    // 后向：滚到窗口顶部 → 顶部前插上一章块 + 补偿滚动位置，自然回到上一章（无需「上一章」按钮）
    useEffect(() => {
        if (!isScrollMode) return;
        const body = scrollRef.current;
        if (!body) return;
        let rafId = 0;
        const onScroll = () => {
            if (rafId) return;
            rafId = window.requestAnimationFrame(() => {
                rafId = 0;
                const ci = chapterIndexRef.current;
                const len = chaptersLenRef.current;
                const viewport = body.clientHeight;
                const maxScroll = Math.max(0, body.scrollHeight - viewport);
                const metrics = chapterMetricsRef.current.get(ci);
                let fraction = 0;
                if (metrics) {
                    const span = Math.max(1, metrics.height - viewport);
                    fraction = Math.min(1, Math.max(0, (body.scrollTop - metrics.top) / span));
                } else {
                    fraction = maxScroll > 0 ? Math.min(1, Math.max(0, body.scrollTop / maxScroll)) : 0;
                }
                scrollFractionRef.current = fraction;
                setScrollFraction(fraction);
                if (!metrics) return;

                // 离开顶部后解除平移冷却
                if (body.scrollTop > 2) shiftCooldownRef.current = false;

                const bottom = metrics.top + metrics.height;
                // 高章节（超一屏）：章底滚到视口底部即衔接下一章，header 同步更新；
                // 矮章节（不足一屏）：等章底滚到视口顶部再衔接，避免移除顶部章块后滚动位置为负导致跳动
                const triggerAt = metrics.height >= viewport ? bottom - viewport - 2 : bottom - 2;
                // 前向：当前章已读完 → 移除顶部章块，窗口后移
                if (!shiftCooldownRef.current && ci < len - 1 && body.scrollTop >= triggerAt) {
                    shiftCooldownRef.current = true;
                    const prevMetrics = chapterMetricsRef.current.get(ci - 1);
                    pendingScrollActionRef.current = {
                        kind: "shift-forward",
                        oldScrollTop: body.scrollTop,
                        removedHeight: prevMetrics ? prevMetrics.height : 0,
                    };
                    setChapterIndex(ci + 1);
                    return;
                }
                // 后向：已滚到窗口顶部 → 顶部前插上一章块，窗口前移
                if (!shiftCooldownRef.current && ci > 0 && body.scrollTop <= 2) {
                    shiftCooldownRef.current = true;
                    pendingScrollActionRef.current = { kind: "shift-backward", oldScrollTop: body.scrollTop };
                    setChapterIndex(ci - 1);
                    return;
                }
            });
        };
        body.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            body.removeEventListener("scroll", onScroll);
            if (rafId) window.cancelAnimationFrame(rafId);
        };
    }, [isScrollMode]);

    // 滚动模式：渲染后测量各章块位置，并应用窗口平移补偿 / 显式定位（useLayoutEffect 保证在绘制前执行，无闪跳）
    useLayoutEffect(() => {
        if (!isScrollMode || !chaptersLoaded) return;
        const content = scrollContentRef.current;
        const body = scrollRef.current;
        if (!content || !body || windowChapters.length === 0) return;

        // 1. 测量窗口内各章块在滚动坐标系中的位置（top 与 body.scrollTop 同坐标系）
        const bodyRect = body.getBoundingClientRect();
        const metrics = new Map<number, { top: number; height: number }>();
        for (const chunk of content.querySelectorAll<HTMLElement>("[data-chapter-index]")) {
            const idx = Number(chunk.getAttribute("data-chapter-index"));
            if (!Number.isFinite(idx)) continue;
            const rect = chunk.getBoundingClientRect();
            metrics.set(idx, { top: rect.top - bodyRect.top + body.scrollTop, height: rect.height });
        }
        chapterMetricsRef.current = metrics;

        // 2. 窗口平移补偿（保持视觉位置不动，实现无缝衔接）
        const action = pendingScrollActionRef.current;
        if (action) {
            pendingScrollActionRef.current = null;
            if (action.kind === "shift-forward") {
                body.scrollTop = Math.max(0, action.oldScrollTop - action.removedHeight);
            } else {
                const newPrev = metrics.get(chapterIndex - 1);
                body.scrollTop = Math.max(0, action.oldScrollTop + (newPrev ? newPrev.height : 0));
            }
            return;
        }

        // 3. 显式跳章 / 打开恢复 / 默认定位到当前章起点
        const positionKey = `${book.id}:${isScrollMode}`;
        const pendingFraction = pendingScrollFractionRef.current;
        const initialFraction = initialScrollFractionRef.current;
        if (pendingFraction !== null) {
            pendingScrollFractionRef.current = null;
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(pendingFraction, chapterIndex);
        } else if (initialFraction !== null) {
            initialScrollFractionRef.current = null;
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(initialFraction, chapterIndex);
        } else if (scrollPositionedKeyRef.current !== positionKey) {
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(0, chapterIndex);
        }
    }, [isScrollMode, chapterIndex, windowChapters, chaptersLoaded, annotations, txtLayoutVersion, book.id]);

    // Swipe handlers for TXT
    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
        const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            navigateWithFlip(dx < 0 ? 'forward' : 'backward');
        }
    };

    const activeReadingMenuMessage = readingMessageMenu
        ? chatMessages.find((msg) => msg.id === readingMessageMenu.messageId) || null
        : null;

    /** PDF 渲染设置先在弹窗内暂存，确认时只重建一次，避免拖动滑块期间连续重渲染整本 PDF。 */
    const openReadingSettings = () => {
        setPdfRenderDraft({
            pdfZoom: readingConfig.pdfZoom ?? 1,
            pdfPreloadRadius: readingConfig.pdfPreloadRadius ?? 3,
            pdfPreloadEnabled: readingConfig.pdfPreloadEnabled !== false,
        });
        setShowReadingSettings(true);
    };

    const handleReadingSettingsConfirm = () => {
        if (isPdf) {
            setReadingConfig((prev) => {
                const next = { ...prev, ...pdfRenderDraft };
                saveReadingInteractionConfig(next);
                return next;
            });
        }
        setShowReadingSettings(false);
    };

    return (
        <div className="reading-app-surface absolute inset-0 z-[100] flex flex-col bg-[var(--c-page-body-bg)]" data-immersive={immersive} style={{ paddingTop: "var(--page-header-safe-top, 48px)" }}>
            {/* Page flip overlay */}
            {flipAnim && (
                <>
                    <div
                        className={`reading-flip-overlay reading-flip-overlay--${flipAnim.direction}`}
                        onAnimationEnd={() => setFlipAnim(null)}
                    >
                        <div className="reading-flip-overlay-body">
                            {renderStaticPage(flipAnim.items)}
                        </div>
                    </div>
                    <div className={`reading-flip-shadow reading-flip-shadow--${flipAnim.direction}`} />
                </>
            )}

            {/* Header — chapter name + page info */}
            <header className={`reading-header ${immersive ? "reading-header--immersive" : "reading-header--revealed"}`} data-ui="header">
                <div className="reading-header-top">
                    <button onClick={onBack} className="page-back-btn reading-header-back">
                        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    <span className="reading-header-title">{isPdf ? book.title : (currentChapter?.title || book.title)}</span>
                    <div className="reading-header-right-group">
                        <button
                            type="button"
                            className="page-back-btn"
                            onClick={openNavigationDialog}
                            aria-label="目录"
                        >
                            <Menu size={18} strokeWidth={1.7} />
                        </button>
                    </div>
                </div>
                {annotationError && (
                    <div className="reading-header-status" style={{ color: "var(--c-danger)" }}>{annotationError}</div>
                )}
            </header>

            {generating && (
                <div className="reading-status-float" aria-live="polite">
                    {companion?.name || "AI"} 正在批注中...
                </div>
            )}

            {/* Character picker dropdown — above bottom avatar */}
            {showCharPicker && (
                <div className="absolute inset-0 z-40" onClick={closeCharPicker} />
            )}
            {showCharPicker && (
                <div
                    className={`absolute left-3 z-50 g-card reading-char-picker ${charPickerClosing ? "reading-char-picker--closing" : ""}`}
                    style={{ minWidth: 160, bottom: `${charPickerBottom}px`, ...chatFloatingStyle, padding: "16px 16px 16px 24px" }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="chat-contact-list" style={{ padding: "4px 6px" }}>
                        {enrichedContacts.map(c => (
                            <div
                                key={c.characterId}
                                className="chat-contact-item"
                                onClick={() => { setCompanionId(c.characterId); closeCharPicker(); generatedBatchesRef.current.clear(); prefetchedBatchStartRef.current = -1; }}
                            >
                                <div className="chat-contact-avatar"
                                    style={companionId === c.characterId ? { outline: "3px solid var(--c-success)", outlineOffset: "2px" } : undefined}
                                >
                                    {c.char.avatar ? <img src={c.char.avatar} alt="" /> : <span className="chat-contact-avatar-fallback">{c.char.name[0]}</span>}
                                </div>
                                <span className="chat-contact-name">{c.char.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Reading content */}
            <div
                ref={scrollRef}
                className={`relative flex-1 min-h-0 px-4 pt-1 pb-3 ${(isPdf || isScrollMode) ? "overflow-auto" : "overflow-hidden"}`}
                data-ui="body"
                onClick={handleReadingSurfaceClick}
            >
                {isPdf ? (
                    <>
                        {/* PDF native rendering */}
                        <PdfPageRenderer
                            bookId={book.id}
                            chapter={pdfAnnotationChapter}
                            annotations={pdfRenderAnnotations}
                            bilingualTranslationEnabled={bilingualTranslationEnabled}
                            collapseBilingualTranslation={readingConfig.collapseBilingualTranslation === true}
                            onTotalPages={setPdfTotalPages}
                            onCurrentPage={setPdfCurrentPage}
                            jumpToPage={pdfJumpPage}
                            onJumpComplete={handlePdfJumpComplete}
                            onCopyAnnotation={copyToClipboard}
                            onDeleteAnnotation={handleDeleteReadingAnnotation}
                            zoom={readingConfig.pdfZoom ?? 1}
                            preloadRadius={readingConfig.pdfPreloadRadius ?? 3}
                            preloadEnabled={readingConfig.pdfPreloadEnabled !== false}
                        />
                    </>
                ) : !chaptersLoaded ? (
                    null
                ) : chapters.length === 0 ? (
                    <div className="reading-debug-card">
                        <div className="reading-debug-title">TXT 数据自检</div>
                        <div className="reading-debug-line">本地章节数：0</div>
                        <div className="reading-debug-line">总段落数：0</div>
                        <div className="reading-debug-line">当前章节索引：{chapterIndex}</div>
                        <div className="reading-debug-line">当前页进度：{txtPage + 1}</div>
                        <div className="reading-debug-hint">这更像是这本书在本地 IndexedDB 里的章节数据已经空了，不是单纯分页卡住。</div>
                    </div>
                ) : !currentChapter ? (
                    <div className="reading-debug-card">
                        <div className="reading-debug-title">TXT 数据自检</div>
                        <div className="reading-debug-line">本地章节数：{chapters.length}</div>
                        <div className="reading-debug-line">总段落数：{totalParagraphs}</div>
                        <div className="reading-debug-line">当前章节索引：{chapterIndex}</div>
                        <div className="reading-debug-line">当前页进度：{txtPage + 1}/{txtTotalPages}</div>
                        <div className="reading-debug-hint">章节数据存在，但当前索引取不到正文。这个状态不是“正在加载”，而是本地章节数据和进度状态不一致。</div>
                    </div>
                ) : isScrollMode ? (
                    <div ref={scrollContentRef} className="reading-scroll-content">
                        {windowChapters.map((chapter) => (
                            <div key={chapter.id} data-chapter-index={chapter.index}>
                                {chapter.paragraphs.map((paragraph, pIndex) => {
                                    const segmentCount = paragraph.split("\n").length;
                                    const paragraphAnnotations = annotations.filter(
                                        (annotation) => annotation.chapterIndex === chapter.index && annotation.paragraphIndex === pIndex
                                    );
                                    return (
                                        <div key={pIndex} className="reading-scroll-block">
                                            {paragraph.split("\n").map((segment, sIndex) => (
                                                <p
                                                    key={sIndex}
                                                    className={`reading-line reading-line-indent${sIndex === segmentCount - 1 ? " reading-line-seg-end" : ""}`}
                                                >
                                                    {segment}
                                                </p>
                                            ))}
                                            {paragraphAnnotations.map((annotation) => renderAnnotationItem(annotation))}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                        <div className="h-[72px]" aria-hidden="true" />
                    </div>
                ) : (
                    <>
                        <div
                            className="reading-page-stage"
                            onTouchStart={handleTouchStart}
                            onTouchEnd={handleTouchEnd}
                        >
                            <div className="reading-page-surface">
                                {txtPagesReadyForCurrentChapter ? renderTxtPage(txtPage) : null}
                            </div>
                        </div>

                        <div className="reading-page-measure" aria-hidden="true">
                            <p ref={txtMeasureLineRef} className="reading-line">测</p>
                            <div ref={txtMeasureGapRef} className="reading-line-gap" />
                            <div ref={txtMeasureAnnotationRef} className="reading-annotation">
                                <span className="reading-annotation-name">角色</span>
                                <span className="reading-annotation-text">批注内容</span>
                            </div>
                        </div>
                    </>
                )}

                {showTxtLoading && (
                    <ReadingLoadingView title="正在打开书页" subtitle="正在读取并排版当前章节" overlay />
                )}

                {isPdf && <div className="h-[88px]" />}
            </div>

            {/* Immersive Page Number */}
            <span className={`reading-immersive-page ${immersive ? 'opacity-35' : 'opacity-0'}`}>
                {isPdf ? `${pdfCurrentPage}/${pdfTotalPages || "?"}` : isScrollMode ? `${Math.round(Math.max(0, Math.min(1, scrollFraction)) * 100)}%` : `${txtDisplayedPage}/${txtTotalPages}`}
            </span>

            {/* Bottom bar — mirrors header style */}
            <footer className="reading-footer">
                <div className="reading-footer-inner">
                    <div className="reading-footer-slider-row">
                        <button
                            className="reading-footer-text-btn"
                            onClick={() => handleNavChapterClick(Math.max(0, chapterIndex - 1))}
                            disabled={chapterIndex <= 0}
                        >
                            上一章
                        </button>
                        <div className="reading-footer-slider">
                            {(() => {
                                const currentVal = isPdf ? pdfCurrentPage : txtBookSliderValue;
                                const maxVal = isPdf ? Math.max(1, currentPageCount) : txtBookSliderMax;
                                const progressPct = maxVal > 1 ? ((currentVal - 1) / (maxVal - 1)) * 100 : 0;
                                return (
                                    <input
                                        type="range"
                                        className="reading-custom-slider"
                                        min={1}
                                        max={maxVal}
                                        step={isPdf ? 1 : 0.001}
                                        value={currentVal}
                                        onChange={(e) => handleNavPageSlider(Number(e.target.value))}
                                        aria-label={isPdf ? "跳转页码" : "跳转阅读进度"}
                                        style={{ '--slider-progress': `${progressPct}%` } as React.CSSProperties}
                                    />
                                );
                            })()}
                        </div>
                        <button
                            className="reading-footer-text-btn"
                            onClick={() => handleNavChapterClick(Math.min(chapters.length - 1, chapterIndex + 1))}
                            disabled={chapterIndex >= chapters.length - 1}
                        >
                            下一章
                        </button>
                    </div>
                    <div className="reading-footer-actions">
                        <button
                            type="button"
                            className={`reading-footer-icon-btn ${autoAnnotate ? "is-active" : ""}`}
                            onClick={() => openAnnotationDialog("auto")}
                        >
                            <Bot size={22} strokeWidth={1.7} />
                            <span>自动批注</span>
                        </button>
                        <button
                            type="button"
                            className="reading-footer-icon-btn"
                            onClick={() => openAnnotationDialog("manual")}
                            disabled={generating || !companionId}
                        >
                            <PenLine size={22} strokeWidth={1.7} />
                            <span>写批注</span>
                        </button>
                        {isPdf && (
                            <button
                                type="button"
                                className="reading-footer-icon-btn"
                                onClick={openPdfPrefetchDialog}
                                disabled={generating || !companionId}
                            >
                                <Rocket size={22} strokeWidth={1.7} />
                                <span>预批注</span>
                            </button>
                        )}
                        <button
                            type="button"
                            className="reading-footer-icon-btn"
                            onClick={openReadingSettings}
                        >
                            <Languages size={22} strokeWidth={1.7} />
                            <span>设置</span>
                        </button>
                    </div>
                </div>
            </footer>

            {!showChat && (
                <button
                    onClick={handleChatLaunchClick}
                    className="reading-chat-launch"
                    aria-label="打开聊天悬浮窗"
                    title="打开聊天悬浮窗"
                    style={chatFloatingStyle}
                    onPointerDown={handleChatDragStart}
                    onPointerMove={handleChatDragMove}
                    onPointerUp={handleChatDragEnd}
                    onPointerCancel={handleChatDragEnd}
                >
                    {companion?.avatar ? (
                        <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                    ) : (
                        <span className="ts-13">{companion?.name?.[0] || "?"}</span>
                    )}
                </button>
            )}

            {showChat && (
                <div
                    className={`reading-chat-float ${chatExpanded ? "reading-chat-float-expanded" : ""}${chatClosing ? " reading-chat-float--closing" : ""}`}
                    style={chatFloatingStyle}
                    onPointerDown={handleChatDragStart}
                    onPointerMove={handleChatDragMove}
                    onPointerUp={handleChatDragEnd}
                    onPointerCancel={handleChatDragEnd}
                >
                    {!chatExpanded ? (
                        <div className="reading-chat-float-compact">
                            <button
                                type="button"
                                onClick={() => { if (shouldIgnoreChatAction()) return; setShowCharPicker(!showCharPicker); }}
                                className="reading-bottom-avatar"
                            >
                                {companion?.avatar ? (
                                    <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                                ) : (
                                    <span className="ts-12">{companion?.name?.[0] || "?"}</span>
                                )}
                            </button>
                            <button
                                type="button"
                                className="reading-chat-float-trigger"
                                onClick={() => { if (shouldIgnoreChatAction()) return; setChatExpanded(true); closeCharPicker(); }}
                                disabled={!companionId}
                            >
                                {companion ? `和${companion.name}讨论该章节...` : "选择陪读角色"}
                                {chatMessages.length > 0 && <span className="ml-1 ts-11 text-[var(--c-icon-active)]">({chatMessages.length})</span>}
                            </button>
                            <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; handleCloseChat(); }} className="reading-chat-float-close" aria-label="关闭聊天悬浮窗"><ChevronRight size={16} strokeWidth={2} /></button>
                        </div>
                    ) : (
                        <>
                            <div className="reading-chat-float-header">
                                <div className="reading-bottom-avatar">
                                    {companion?.avatar ? (
                                        <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                                    ) : (
                                        <span className="ts-12">{companion?.name?.[0] || "?"}</span>
                                    )}
                                </div>
                                <div className="reading-chat-float-header-copy">
                                    <span className="reading-chat-float-title">和{companion?.name || "AI"}讨论该章节</span>
                                    <span className="reading-chat-float-subtitle">拖拽任意位置移动</span>
                                </div>
                                <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; setChatExpanded(false); }} className="reading-chat-float-close" aria-label="收起聊天窗口"><ChevronDown size={18} strokeWidth={2} /></button>
                                <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; handleCloseChat(); }} className="reading-chat-float-close" aria-label="关闭聊天悬浮窗"><Minus size={18} strokeWidth={2} /></button>
                            </div>
                            <div ref={chatListRef} className="reading-chat-float-body" onClick={() => {
                                if (activeMessageId || readingMessageMenu) closeReadingMessageMenu();
                                if (activeAnnotationId) setActiveAnnotationId(null);
                            }} onScroll={() => {
                                if (readingMessageMenu) closeReadingMessageMenu();
                            }}>
                                {chatMessages.length === 0 && (
                                    <div className="text-center ts-13 text-[var(--c-icon)] py-6">和{companion?.name}聊聊这章内容吧</div>
                                )}
                                {chatMessages.map(msg => (
                                    <div key={msg.id} className="chat-msg-wrapper" data-role={msg.role}
                                        onPointerDown={(e) => { e.stopPropagation(); handleReadingMessagePointerDown(e, msg); }}
                                        onPointerUp={(e) => { e.stopPropagation(); cancelReadingMessageLongPress(); }}
                                        onPointerCancel={cancelReadingMessageLongPress}
                                        onPointerLeave={cancelReadingMessageLongPress}
                                        onPointerMove={handleReadingMessagePointerMove}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            cancelReadingMessageLongPress();
                                            setActiveAnnotationId(null);
                                            setActiveMessageId(msg.id);
                                            setReadingMessageMenu({ messageId: msg.id, x: e.clientX, y: e.clientY });
                                        }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (readingMessageMenu && readingMessageMenu.messageId !== msg.id) closeReadingMessageMenu();
                                        }}
                                    >
                                        <div className={`chat-bubble-role-${msg.role} rounded-lg ${msg.mediaType && ["sticker", "red_packet", "transfer", "image", "location", "music_share", "xiaohongshu_note_share"].includes(msg.mediaType) ? "chat-bubble-media" : "max-w-[80%]"} break-words relative`}
                                            data-ui={msg.role === "user" ? "bubble-user" : "bubble-bot"}
                                            {...(activeMessageId === msg.id ? { "data-active": "" } : {})}>
                                            <MessageBubble
                                                msg={msg}
                                                charName={companion?.name}
                                                userName=""
                                                characterId={companionId || undefined}
                                                onUpdate={m => setChatMessages(prev => prev.map(p => p.id === m.id ? m : p))}
                                                defaultTranslationExpanded={defaultTranslationExpanded}
                                            />
                                        </div>
                                    </div>
                                ))}
                                {chatting && <div className="ts-13 text-[var(--c-icon)] py-1">{companion?.name} 正在思考...</div>}
                            </div>
                            <div className="reading-chat-float-input">
                                <input
                                    value={chatInput}
                                    onChange={e => setChatInput(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                                    placeholder="输入消息..."
                                    className="ui-input flex-1"
                                    disabled={chatting}
                                />
                                <button
                                    onClick={handleSend}
                                    disabled={!chatInput.trim() || chatting}
                                    className="reading-chat-send-btn"
                                    aria-label="发送"
                                ><SendHorizontal size={18} strokeWidth={1.8} /></button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {activeReadingMenuMessage && readingMessageMenu && (
                <div
                    className="ctx-menu chat-floating-ctx-menu reading-chat-context-menu flex py-[6px] px-0"
                    data-role={activeReadingMenuMessage.role}
                    style={getReadingMessageMenuStyle(readingMessageMenu)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={() => {
                            copyToClipboard(activeReadingMenuMessage.content);
                            closeReadingMessageMenu();
                        }}
                        className="ctx-menu-btn"
                    >复制</button>
                    <button
                        type="button"
                        onClick={() => handleEditDiscussMessageStart(activeReadingMenuMessage)}
                        className="ctx-menu-btn"
                    >编辑</button>
                    <button
                        type="button"
                        onClick={() => {
                            deleteChatMessage(activeReadingMenuMessage.id);
                            setChatMessages((prev) => prev.filter((msg) => msg.id !== activeReadingMenuMessage.id));
                            closeReadingMessageMenu();
                        }}
                        className="ctx-menu-btn ctx-menu-btn-danger"
                    >删除</button>
                </div>
            )}

            {editingDiscussMessage && (
                <ContentDialog
                    title="编辑共读消息"
                    confirmLabel="保存"
                    cancelLabel="取消"
                    onConfirm={handleSaveDiscussMessageEdit}
                    onCancel={() => {
                        setEditingDiscussMessage(null);
                        setEditingDiscussContent("");
                    }}
                >
                    <div className="reading-discuss-edit">
                        <textarea
                            className="ui-textarea reading-discuss-edit-textarea"
                            value={editingDiscussContent}
                            onChange={(event) => setEditingDiscussContent(event.target.value)}
                            rows={6}
                        />
                    </div>
                </ContentDialog>
            )}

            {annotationDialogMode && (
                <ContentDialog
                    title={annotationDialogMode === "manual" ? "生成批注" : autoAnnotate ? "关闭自动批注" : "开启自动批注"}
                    confirmLabel={annotationDialogMode === "manual" ? "生成" : autoAnnotate ? "关闭" : "开启"}
                    cancelLabel="取消"
                    onConfirm={() => { void handleAnnotationDialogConfirm(); }}
                    onCancel={() => setAnnotationDialogMode(null)}
                >
                    <div className="reading-settings-grid">
                        {annotationDialogMode === "auto" && autoAnnotate ? (
                            <>
                                <div className="reading-settings-inline-note">
                                    <span>当前状态</span>
                                    <span>自动批注已开启</span>
                                </div>
                                <div className="reading-settings-inline-note">
                                    <span>批注单位</span>
                                    <span>{annotationBatchSize}{isPdf ? " 页" : " 段"}</span>
                                </div>
                            </>
                        ) : (
                            <>
                                <label className="reading-settings-label">
                                    <span>
                                        {annotationDialogMode === "manual"
                                            ? (isPdf
                                                ? `确认让${companion?.name || "AI"}为接下来几页生成批注`
                                                : `确认让${companion?.name || "AI"}为接下来几个段落生成批注`)
                                            : (isPdf
                                                ? `开启后，先生成当前页所在批次；之后翻到新批次第一页时自动生成批注`
                                                : `开启后，先生成当前段落所在批次；之后翻到新批次第一页时自动生成批注`)}
                                    </span>
                                    <input
                                        value={annotationBatchInput}
                                        onChange={(e) => setAnnotationBatchInput(e.target.value.replace(/[^\d]/g, ""))}
                                        className="ui-input"
                                        inputMode="numeric"
                                    />
                                </label>
                                <div className="reading-settings-inline-note">
                                    <span>默认值</span>
                                    <span>{isPdf ? "5 页" : "50 段"}</span>
                                </div>
                            </>
                        )}
                    </div>
                </ContentDialog>
            )}
            {pdfPrefetchDialogOpen && (
                <ContentDialog
                    title="PDF 预批注"
                    confirmLabel="开始预批注"
                    cancelLabel="取消"
                    onConfirm={() => { void handlePdfManualPrefetch(); }}
                    onCancel={() => setPdfPrefetchDialogOpen(false)}
                >
                    <div className="reading-settings-grid">
                        <p className="reading-settings-inline-note">
                            <span>为指定页码范围提前生成批注（先解析文本层再生成，翻到那里就是现成的）。</span>
                        </p>
                        <div className="reading-settings-inline-note">
                            <span>起始页</span>
                            <input
                                value={pdfPrefetchStartInput}
                                onChange={(e) => setPdfPrefetchStartInput(e.target.value.replace(/[^\d]/g, ""))}
                                className="ui-input"
                                inputMode="numeric"
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>结束页</span>
                            <input
                                value={pdfPrefetchEndInput}
                                onChange={(e) => setPdfPrefetchEndInput(e.target.value.replace(/[^\d]/g, ""))}
                                className="ui-input"
                                inputMode="numeric"
                            />
                        </div>
                        <p className="reading-settings-inline-note">
                            <span>当前第 {Math.max(1, pdfCurrentPage)} / {Math.max(1, pdfTotalPages)} 页。一次最多 {MAX_MANUAL_PDF_PREFETCH_PAGES} 页。</span>
                        </p>
                        {annotationError && (
                            <p className="reading-settings-inline-note" style={{ color: "var(--c-danger)" }}>
                                <span>{annotationError}</span>
                            </p>
                        )}
                    </div>
                </ContentDialog>
            )}
            {showReadingSettings && (
                <ContentDialog
                    title="阅读设置"
                    confirmLabel="完成"
                    cancelLabel="关闭"
                    onConfirm={handleReadingSettingsConfirm}
                    onCancel={() => setShowReadingSettings(false)}
                >
                    <div className="reading-settings-grid">
                        <div className="reading-settings-inline-note">
                            <span>启用阅读双语翻译</span>
                            <Toggle
                                checked={bilingualTranslationEnabled}
                                onChange={(checked) => {
                                    const next = { ...readingConfig, bilingualTranslationEnabled: checked };
                                    setReadingConfig(next);
                                    saveReadingInteractionConfig(next);
                                }}
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>折叠中文译文</span>
                            <Toggle
                                checked={readingConfig.collapseBilingualTranslation === true}
                                onChange={(checked) => {
                                    const next = { ...readingConfig, collapseBilingualTranslation: checked };
                                    setReadingConfig(next);
                                    saveReadingInteractionConfig(next);
                                }}
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>说明</span>
                            <span>只翻译 AI 讨论消息和 AI 批注，不翻书正文</span>
                        </div>
                        {bilingualTranslationEnabled && (
                            <div className="reading-settings-prompt">
                                <div className="reading-settings-prompt-head">
                                    <span>双语提示词</span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const next = {
                                                ...readingConfig,
                                                bilingualTranslationPrompt: DEFAULT_READING_INTERACTION_CONFIG.bilingualTranslationPrompt,
                                            };
                                            setReadingConfig(next);
                                            saveReadingInteractionConfig(next);
                                        }}
                                    >
                                        恢复默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input"
                                    rows={7}
                                    value={readingConfig.bilingualTranslationPrompt}
                                    onChange={(event) => {
                                        const next = { ...readingConfig, bilingualTranslationPrompt: event.target.value };
                                        setReadingConfig(next);
                                        saveReadingInteractionConfig(next);
                                    }}
                                />
                            </div>
                        )}

                        {isPdf && (
                            <section className="reading-settings-group">
                                <div className="reading-settings-heading">
                                    <ZoomIn size={15} />
                                    <span>PDF 渲染</span>
                                </div>
                                <div className="reading-settings-toggle-row">
                                    <span className="reading-settings-toggle-label">预加载后续页</span>
                                    <Toggle
                                        checked={pdfRenderDraft.pdfPreloadEnabled}
                                        onChange={(next) => setPdfRenderDraft((prev) => ({ ...prev, pdfPreloadEnabled: next }))}
                                    />
                                </div>
                                <p className="reading-settings-inline-note">
                                    <span>开启后阅读时会提前渲染当前页之后的页面，滚动更平滑；关闭则只渲染屏幕内的页。</span>
                                </p>
                                <div className="reading-settings-inline-note">
                                    <span>页面缩放率</span>
                                    <span>{Math.round(pdfRenderDraft.pdfZoom * 100)}%</span>
                                </div>
                                <input
                                    type="range"
                                    className="w-full my-1"
                                    min={0.5}
                                    max={2}
                                    step={0.05}
                                    value={pdfRenderDraft.pdfZoom}
                                    onChange={(e) => setPdfRenderDraft((prev) => ({ ...prev, pdfZoom: Number(e.target.value) }))}
                                />
                                <div className="reading-settings-inline-note">
                                    <span>一次渲染页数（当前页前后各几页）</span>
                                    <span>{pdfRenderDraft.pdfPreloadRadius} 页</span>
                                </div>
                                <input
                                    type="range"
                                    className="w-full my-1"
                                    min={1}
                                    max={8}
                                    step={1}
                                    value={pdfRenderDraft.pdfPreloadRadius}
                                    onChange={(e) => setPdfRenderDraft((prev) => ({ ...prev, pdfPreloadRadius: Number(e.target.value) }))}
                                />
                                <p className="reading-settings-inline-note">
                                    <span>提示：一次渲染页数过少时，滑动到未渲染的页会反复渲染，造成闪烁卡顿；调大并开启预加载可缓解。缩放率调大后一页更接近一屏。</span>
                                </p>
                            </section>
                        )}
                    </div>
                </ContentDialog>
            )}
            {showNavigationDialog && (
                <>
                    <div className="reading-nav-backdrop" onClick={() => setShowNavigationDialog(false)} />
                    <aside className="reading-nav-drawer">
                        <header className="reading-nav-header">
                            <span className="reading-nav-title">导航</span>
                            <button type="button" className="reading-nav-close" onClick={() => setShowNavigationDialog(false)} aria-label="关闭">
                                <X size={18} strokeWidth={2} />
                            </button>
                        </header>
                        <div className="reading-nav-chapter-count">共{chapters.length}章</div>
                        <div className="reading-nav-chapter-list">
                            {chapters.map((chapter, index) => {
                                const charCount = chapter.paragraphs.reduce((sum, p) => sum + p.replace(/\s+/g, "").length, 0);
                                const pageLabel = isPdf && chapter.pageStart ? chapter.pageStart : null;
                                return (
                                    <button
                                        key={chapter.id}
                                        type="button"
                                        className={`reading-nav-chapter-item${index === chapterIndex ? " is-active" : ""}`}
                                        onClick={() => handleNavChapterClick(index)}
                                    >
                                        <div className="reading-nav-chapter-main">
                                            <span className="reading-nav-chapter-name">{chapter.title || `第${index + 1}章`}</span>
                                            <span className="reading-nav-chapter-meta">{charCount > 0 ? `${charCount}字` : ""}</span>
                                        </div>
                                        {pageLabel && <span className="reading-nav-chapter-page">{pageLabel}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </aside>
                </>
            )}
        </div>
    );
}
