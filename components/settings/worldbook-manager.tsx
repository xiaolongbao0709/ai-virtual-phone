"use client";

import { useState, useEffect, useRef, useContext, useCallback, useMemo } from "react";
import { Plus, BookOpen, Trash2, Upload, Download, ChevronLeft, AlertCircle, Maximize2, Replace, GripVertical, FolderInput, Check, CheckSquare, RotateCcw } from "lucide-react";
import {
    loadWorldBooks,
    saveWorldBooks,
    createWorldBook,
    parseWorldBookFromJson,
    loadBindingConfig,
    UNSUPPORTED_IMPORT_FORMAT,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { WorldBookConfig, WorldBookEntry } from "@/lib/settings-types";
import { SettingsContext } from "../phone-settings-app";
import { BottomSheet, ConfirmDialog, TextExpandModal } from "@/components/ui/modal";
import { SwipeActionRow, useSwipeActions } from "@/components/ui/swipe-actions";
import { notifyMascotPageContext } from "@/lib/mascot-events";
import { useTouchSort } from "@/lib/use-touch-sort";
import { estimateTokens } from "@/lib/token-counter";

function estimateEntryTokens(entry: WorldBookEntry): number {
    return estimateTokens(entry.content || "");
}

function estimateBookTokens(book: WorldBookConfig): number {
    return (book.entries || []).reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
}

export function WorldBookManager({ isActive = true }: { isActive?: boolean } = {}) {
    const [books, setBooks] = useState<WorldBookConfig[]>([]);
    const [activeBookId, setActiveBookId] = useState<string>("");
    const [viewMode, setViewMode] = useState<"list" | "detail">("list");
    const [editingUid, setEditingUid] = useState<string | null>(null);
    const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{ type: 'book' | 'entry', id: string } | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);
    const [expandUid, setExpandUid] = useState<string | null>(null);
    // ── 多选模式（右滑选中 / 批量操作 / 多选拖拽，与预设一致） ──
    const [selectMode, setSelectMode] = useState(false);
    const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
    const [selectionBookId, setSelectionBookId] = useState<string | null>(null);
    const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const { setSubpageTitle, setOverrideBack, setSubpageRightAction } = useContext(SettingsContext);

    // Initial load
    useEffect(() => {
        const loaded = loadWorldBooks();
        if (loaded.length > 0) {
            setBooks(loaded);
            setActiveBookId(loaded[0]?.id || "");
        }
        setIsLoaded(true);
    }, []);

    const persist = useCallback((newBooks: WorldBookConfig[]) => {
        setBooks(newBooks);
        saveWorldBooks(newBooks);
    }, []);

    const wbContainerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (viewMode === "detail" && activeBookId) {
            setOverrideBack(() => () => setViewMode("list"));
            const target = books.find(b => b.id === activeBookId);
            setSubpageTitle(target?.name || "世界书详情");
        } else {
            setOverrideBack(null);
            setSubpageTitle(null);
        }
    }, [viewMode, activeBookId, books, setOverrideBack, setSubpageTitle]);

    useEffect(() => {
        const scrollParent = wbContainerRef.current?.closest(".page-body");
        if (scrollParent) scrollParent.scrollTop = 0;
    }, [viewMode, activeBookId]);

    // Refresh trigger — incremented when returning from binding page
    const [ctxRefreshKey, setCtxRefreshKey] = useState(0);
    useEffect(() => {
        const onRefresh = () => setCtxRefreshKey(k => k + 1);
        window.addEventListener("worldbook-refresh-context", onRefresh);
        return () => window.removeEventListener("worldbook-refresh-context", onRefresh);
    }, []);

    // Send mascot context when editing a worldbook (only when this tab is active)
    useEffect(() => {
        if (!isActive) return;
        if (viewMode === "detail" && activeBookId) {
            const book = books.find(b => b.id === activeBookId);
            if (!book) return;
            // Reverse-lookup: which characters have this worldbook bound?
            const bindingConfig = loadBindingConfig();
            const characters = loadCharacters();
            const boundNames: string[] = [];
            const boundCharProfiles: string[] = [];
            // Check global defaults
            if (bindingConfig.globalDefaults.worldBookIds?.includes(activeBookId)) {
                boundNames.push("全局默认");
            }
            // Check character bindings
            for (const cb of bindingConfig.characterBindings) {
                const hasIt = cb.defaults.worldBookIds?.includes(activeBookId)
                    || Object.values(cb.appOverrides).some(slot => slot?.worldBookIds?.includes(activeBookId));
                if (hasIt) {
                    const char = characters.find(c => c.id === cb.characterId);
                    if (char) {
                        boundNames.push(char.name);
                        const parts = [`【${char.name}】`];
                        if (char.persona) parts.push(char.persona);
                        if (char.personality) parts.push(`性格: ${char.personality}`);
                        boundCharProfiles.push(parts.join("\n"));
                    }
                }
            }
            // Build entry summaries and full content for context
            const fields: Record<string, string> = {
                worldbookName: book.name,
                worldbookDescription: book.description || "",
                boundCharacters: boundNames.length > 0 ? boundNames.join("、") : "未绑定",
            };
            if (boundCharProfiles.length > 0) {
                fields.characterProfiles = boundCharProfiles.join("\n\n");
            }
            for (const entry of book.entries) {
                const prefix = `entry_${entry.uid}`;
                fields[`${prefix}_comment`] = entry.comment || "";
                fields[`${prefix}_key`] = entry.key;
                fields[`${prefix}_content`] = entry.content;
                fields[`${prefix}_constant`] = entry.constant ? "true" : "false";
                fields[`${prefix}_position`] = String(entry.position);
                fields[`${prefix}_disable`] = entry.disable ? "true" : "false";
            }
            notifyMascotPageContext({
                page: "worldbook",
                mode: "editing",
                label: `世界书 · ${book.name}`,
                fields,
            });
        } else if (viewMode === "list") {
            notifyMascotPageContext({
                page: "worldbook",
                mode: "viewing",
                label: "世界书列表",
                fields: {},
            });
        }
    }, [viewMode, activeBookId, books, ctxRefreshKey, isActive]);

    // Reset mascot context on unmount
    useEffect(() => {
        return () => {
            notifyMascotPageContext({ page: "desktop", mode: "idle", label: "桌面", fields: {} });
        };
    }, []);

    // Debounced save for mascot batch actions — avoids flooding IndexedDB
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingSaveRef = useRef<WorldBookConfig[] | null>(null);
    const debouncedSave = (next: WorldBookConfig[]) => {
        pendingSaveRef.current = next;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            if (pendingSaveRef.current) saveWorldBooks(pendingSaveRef.current);
            pendingSaveRef.current = null;
            saveTimerRef.current = null;
        }, 300);
    };

    // Listen for mascot fill events — uses functional state update to handle rapid batched actions
    const activeBookIdRef = useRef(activeBookId);
    activeBookIdRef.current = activeBookId;

    useEffect(() => {
        const onFill = (e: Event) => {
            const { field, value, _batchId } = (e as CustomEvent).detail;
            const batchId = _batchId || "0";
            const bookId = activeBookIdRef.current;
            if (!bookId) return;

            setBooks(prev => {
                const bookIndex = prev.findIndex(b => b.id === bookId);
                if (bookIndex < 0) return prev;
                const book = prev[bookIndex];
                let updatedBook: WorldBookConfig | null = null;

                if (field === "worldbookName") {
                    updatedBook = { ...book, name: value, updatedAt: Date.now() };
                } else if (field === "worldbookDescription") {
                    updatedBook = { ...book, description: value, updatedAt: Date.now() };
                } else if (field.startsWith("entry_new_")) {
                    const match = field.match(/^entry_new_(\d+)_(\w+)$/);
                    if (match) {
                        const idx = parseInt(match[1], 10);
                        const subfield = match[2];
                        // Use a stable uid per batch+index — different batches never collide
                        const stableUid = `mascot_batch_${batchId}_${idx}`;
                        const entries = [...book.entries];
                        let entryIdx = entries.findIndex(e => e.uid === stableUid);
                        if (entryIdx < 0) {
                            entries.push({
                                uid: stableUid,
                                key: "", content: "", comment: "",
                                use_regex: false, disable: false, constant: false,
                                position: 0, insertion_order: 100, role: 0,
                            });
                            entryIdx = entries.length - 1;
                        }
                        const entry = { ...entries[entryIdx] };
                        if (subfield === "key") entry.key = value;
                        else if (subfield === "content") entry.content = value;
                        else if (subfield === "comment") entry.comment = value;
                        else if (subfield === "constant") entry.constant = value === "true";
                        else if (subfield === "position") entry.position = parseInt(value, 10) || 0;
                        entries[entryIdx] = entry;
                        updatedBook = { ...book, entries, updatedAt: Date.now() };
                    }
                } else if (field.startsWith("entry_") && field.includes("_")) {
                    // Modify existing entry: entry_{uid}_{subfield}
                    // Only changes the specified subfield, all other fields stay intact
                    const lastUnderscore = field.lastIndexOf("_");
                    const subfield = field.slice(lastUnderscore + 1);
                    const uid = field.slice("entry_".length, lastUnderscore);
                    const entryIdx = book.entries.findIndex(e => e.uid === uid);
                    if (entryIdx >= 0) {
                        const entries = [...book.entries];
                        const entry = { ...entries[entryIdx] };
                        if (subfield === "content") entry.content = value;
                        else if (subfield === "key") entry.key = value;
                        else if (subfield === "comment") entry.comment = value;
                        else if (subfield === "constant") entry.constant = value === "true";
                        else if (subfield === "position") entry.position = parseInt(value, 10) || 0;
                        else if (subfield === "disable") entry.disable = value === "true";
                        entries[entryIdx] = entry;
                        updatedBook = { ...book, entries, updatedAt: Date.now() };
                    }
                }

                if (!updatedBook) return prev;
                const next = [...prev];
                next[bookIndex] = updatedBook;
                debouncedSave(next);
                return next;
            });
        };
        window.addEventListener("mascot-fill-field", onFill);
        return () => window.removeEventListener("mascot-fill-field", onFill);
    }, []);

    // --- Book Level Operations ---
    const addBook = useCallback(() => {
        const newBook = createWorldBook("新世界书");
        persist([newBook, ...books]);
        setActiveBookId(newBook.id);
        setViewMode("detail");
    }, [books, persist]);

    useEffect(() => {
        if (viewMode !== "list") {
            setSubpageRightAction("worldbook", null);
            return;
        }
        setSubpageRightAction("worldbook",
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95 focus:outline-none"
                >
                    <Upload size={15} strokeWidth={1.8} />
                    <span>导入世界书</span>
                </button>
                <button
                    type="button"
                    onClick={addBook}
                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                >
                    <Plus size={15} strokeWidth={1.8} />
                    <span>新建世界书</span>
                </button>
            </div>
        );
        return () => setSubpageRightAction("worldbook", null);
    }, [addBook, setSubpageRightAction, viewMode]);

    const updateBook = (id: string, updates: Partial<WorldBookConfig>) => {
        persist(books.map(b => b.id === id ? { ...b, ...updates, updatedAt: Date.now() } : b));
    };

    const removeBook = (id: string) => {
        const remaining = books.filter(b => b.id !== id);
        persist(remaining);
        setViewMode("list");
        if (remaining.length > 0) {
            setActiveBookId(remaining[0].id);
        } else {
            setActiveBookId("");
        }
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                const parsed = parseWorldBookFromJson(text);
                if (parsed) {
                    persist([parsed, ...books]);
                    setActiveBookId(parsed.id);
                } else {
                    setImportError("无法解析世界书文件，格式不正确。");
                }
            } catch (e) {
                if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) {
                    setImportError("不支持该世界书格式");
                } else {
                    setImportError("无法解析世界书文件，格式不正确。");
                }
            }
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleExport = async (book: WorldBookConfig) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(book, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${book.name || "worldbook"}.json`);
    };

    // --- Entry Level Operations ---
    const activeBook = books.find(b => b.id === activeBookId);

    const visibleEntries = activeBook?.entries || [];

    // 多选模式切换世界书时自动退出，避免跨书误操作
    useEffect(() => {
        setSelectMode(false);
        setSelectedUids(new Set());
        setSelectionBookId(null);
        setConfirmDeleteSelected(false);
    }, [activeBookId, viewMode]);

    // 选中集合始终约束在当前世界书条目范围内
    useEffect(() => {
        setSelectedUids(previous => {
            if (previous.size === 0) return previous;
            const valid = new Set((activeBook?.entries || []).map(entry => entry.uid));
            const next = new Set([...previous].filter(uid => valid.has(uid)));
            if (next.size === previous.size && [...next].every(uid => previous.has(uid))) return previous;
            return next;
        });
    }, [books, activeBookId]);

    const actionableSelectedUids = useMemo(() => {
        if (!activeBookId || selectionBookId !== activeBookId) return new Set<string>();
        const valid = new Set((activeBook?.entries || []).map(entry => entry.uid));
        return new Set([...selectedUids].filter(uid => valid.has(uid)));
    }, [activeBook?.entries, activeBookId, selectedUids, selectionBookId]);

    // ── 条目左滑操作（微信式：左滑露出操作按钮；三键宽 186） ──
    const swipe = useSwipeActions(186);

    // 跨书：先选目标书，再选「复制到 / 转移到」
    const [crossBookEntryUid, setCrossBookEntryUid] = useState<string | null>(null);
    const [crossBookTargetId, setCrossBookTargetId] = useState<string | null>(null);

    const makeNewEntry = (): WorldBookEntry => ({
        uid: `wb-entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        key: "",
        content: "",
        comment: "",
        use_regex: false,
        disable: false,
        constant: false,
        position: 4,
        depth: 4,
        probability: 100,
        useProbability: false,
        role: 0,
        insertion_order: 50,
    });

    const scrollEntryIntoView = (uid: string) => {
        window.setTimeout(() => {
            wbContainerRef.current
                ?.querySelector(`[data-swipe-id="${CSS.escape(uid)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    const closeCrossBookSheet = () => {
        setCrossBookEntryUid(null);
        setCrossBookTargetId(null);
    };

    const addEntry = () => {
        if (!activeBook) return;
        const newEntry = makeNewEntry();
        updateBook(activeBook.id, { entries: [newEntry, ...(activeBook.entries || [])] });
        setEditingUid(newEntry.uid);
    };

    const insertEntryAfter = (afterUid: string) => {
        if (!activeBook) return;
        const newEntry = makeNewEntry();
        const entries = [...(activeBook.entries || [])];
        const idx = entries.findIndex(e => e.uid === afterUid);
        if (idx >= 0) entries.splice(idx + 1, 0, newEntry);
        else entries.push(newEntry);
        updateBook(activeBook.id, { entries });
        swipe.close();
        setEditingUid(newEntry.uid);
        scrollEntryIntoView(newEntry.uid);
    };

    /** 将条目复制到其他世界书（保留原条目，目标书末尾追加副本） */
    const copyEntryToBook = (uid: string, targetBookId: string) => {
        if (!activeBook || targetBookId === activeBook.id) return;
        const target = books.find(b => b.id === targetBookId);
        if (!target) return;
        const entry = activeBook.entries.find(e => e.uid === uid);
        if (!entry) return;

        const copy: WorldBookEntry = {
            ...entry,
            uid: `wb-entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        };
        persist(books.map(b => {
            if (b.id !== targetBookId) return b;
            return {
                ...b,
                entries: [...(b.entries || []), copy],
                updatedAt: Date.now(),
            };
        }));
        closeCrossBookSheet();
        swipe.close();
    };

    /** 将条目转移到其他世界书（从本书移除，追加到目标书末尾） */
    const moveEntryToBook = (uid: string, targetBookId: string) => {
        if (!activeBook || targetBookId === activeBook.id) return;
        const target = books.find(b => b.id === targetBookId);
        if (!target) return;
        const entry = activeBook.entries.find(e => e.uid === uid);
        if (!entry) return;

        const nextBooks = books.map(b => {
            if (b.id === activeBook.id) {
                return {
                    ...b,
                    entries: b.entries.filter(e => e.uid !== uid),
                    updatedAt: Date.now(),
                };
            }
            if (b.id === targetBookId) {
                return {
                    ...b,
                    entries: [...(b.entries || []), entry],
                    updatedAt: Date.now(),
                };
            }
            return b;
        });
        persist(nextBooks);
        if (editingUid === uid) setEditingUid(null);
        closeCrossBookSheet();
        swipe.close();
    };

    // ── 条目拖拽排序（长按上下拖动；多选时整组批量移动，与预设一致） ──
    const handleEntryReorder = useCallback((from: number, to: number) => {
        if (from < 0 || to < 0 || from === to) return;
        const book = books.find(b => b.id === activeBookId);
        if (!book) return;
        const entries = [...(book.entries || [])];
        if (from >= entries.length || to >= entries.length) return;
        const dragged = entries[from];
        const isBulk = selectMode && actionableSelectedUids.size > 1 && actionableSelectedUids.has(dragged.uid);
        if (isBulk) {
            const selected = entries.filter(e => actionableSelectedUids.has(e.uid));
            if (selected.length === entries.length) return;
            const rest = entries.filter(e => !actionableSelectedUids.has(e.uid));
            const anchor = rest.find(e => {
                const idx = entries.indexOf(e);
                return to > from ? idx > to : idx >= to;
            });
            const insertPos = anchor ? rest.indexOf(anchor) : rest.length;
            const next = [...rest.slice(0, insertPos), ...selected, ...rest.slice(insertPos)];
            persist(books.map(b => b.id === book.id ? { ...b, entries: next, updatedAt: Date.now() } : b));
            return;
        }
        const [item] = entries.splice(from, 1);
        entries.splice(to, 0, item);
        persist(books.map(b => b.id === book.id ? { ...b, entries, updatedAt: Date.now() } : b));
    }, [actionableSelectedUids, activeBookId, books, persist, selectMode]);

    const getEntryDragIndices = useCallback((pressedIndex: number) => {
        if (!selectMode) return [pressedIndex];
        const entries = books.find(b => b.id === activeBookId)?.entries || [];
        const pressedUid = entries[pressedIndex]?.uid;
        if (!pressedUid || !actionableSelectedUids.has(pressedUid)) return [pressedIndex];
        return entries.flatMap((entry, index) => actionableSelectedUids.has(entry.uid) ? [index] : []);
    }, [actionableSelectedUids, activeBookId, books, selectMode]);

    const {
        containerRef: entryListRef,
        onTouchStart: onEntryTouchStart,
        onTouchMove: onEntryTouchMove,
        onTouchEnd: onEntryTouchEnd,
    } = useTouchSort(handleEntryReorder, 400, getEntryDragIndices);

    // ── 条目级导入/导出（左滑「替换/导出」+ 底部「添加条目」菜单） ──
    const [addEntryMenuOpen, setAddEntryMenuOpen] = useState(false);
    const entryFileInputRef = useRef<HTMLInputElement>(null);
    const entryImportModeRef = useRef<{ mode: "append" } | { mode: "replace"; uid: string } | null>(null);

    const sanitizeEntryImport = (raw: unknown, fallbackUid: string): WorldBookEntry | null => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const obj = raw as Record<string, unknown>;
        if (typeof obj.content !== "string" && typeof obj.comment !== "string" && typeof obj.key !== "string" && !Array.isArray(obj.key)) return null;
        // 兼容酒馆世界书条目：key 可能是字符串数组
        const key = Array.isArray(obj.key)
            ? obj.key.filter((k): k is string => typeof k === "string").join(", ")
            : (typeof obj.key === "string" ? obj.key : "");
        return {
            uid: fallbackUid,
            key,
            content: typeof obj.content === "string" ? obj.content : "",
            comment: typeof obj.comment === "string" ? obj.comment : "",
            use_regex: !!obj.use_regex,
            disable: !!obj.disable,
            constant: !!obj.constant,
            position: typeof obj.position === "number" || typeof obj.position === "string"
                ? obj.position as WorldBookEntry["position"]
                : 4,
            depth: typeof obj.depth === "number" ? obj.depth : 4,
            probability: typeof obj.probability === "number" ? obj.probability : 100,
            useProbability: !!obj.useProbability,
            role: typeof obj.role === "number" ? obj.role : 0,
            insertion_order: typeof obj.insertion_order === "number" ? obj.insertion_order : 50,
        };
    };

    const appendImportedEntries = (book: WorldBookConfig, raws: unknown[]) => {
        const base = Date.now();
        const appended = raws
            .map((raw, i) => sanitizeEntryImport(raw, `wb-entry-${base + i}`))
            .filter((entry): entry is WorldBookEntry => !!entry);
        if (appended.length === 0) {
            setImportError("JSON 里没有可识别的条目内容。");
            return;
        }
        updateBook(book.id, { entries: [...(book.entries || []), ...appended] });
        if (appended.length === 1) setEditingUid(appended[0].uid);
        scrollEntryIntoView(appended[0].uid);
    };

    const replaceImportedEntry = (book: WorldBookConfig, targetUid: string, raw: unknown) => {
        const sanitized = sanitizeEntryImport(raw, targetUid);
        if (!sanitized) {
            setImportError("JSON 里没有可识别的条目内容。");
            return;
        }
        // 保留原 uid，只替换内容
        const finalEntry = { ...sanitized, uid: targetUid };
        updateBook(book.id, { entries: (book.entries || []).map(e => e.uid === targetUid ? finalEntry : e) });
    };

    const exportEntry = async (entry: WorldBookEntry) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${entry.comment || entry.key || "worldbook-entry"}.json`);
    };

    const handleEntryImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        const mode = entryImportModeRef.current;
        entryImportModeRef.current = null;
        if (entryFileInputRef.current) entryFileInputRef.current.value = "";
        if (!file || !mode) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const book = books.find(b => b.id === activeBookId);
            if (!book) return;
            try {
                const parsed = JSON.parse(event.target?.result as string);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                if (mode.mode === "replace") replaceImportedEntry(book, mode.uid, items[0]);
                else appendImportedEntries(book, items);
            } catch {
                setImportError("无法解析条目文件，格式不正确。");
            }
        };
        reader.readAsText(file);
    };

    const updateEntry = (uid: string, updates: Partial<WorldBookEntry>) => {
        if (!activeBook) return;
        const newEntries = activeBook.entries.map(e => e.uid === uid ? { ...e, ...updates } : e);
        updateBook(activeBook.id, { entries: newEntries });
    };

    const removeEntry = (uid: string) => {
        if (!activeBook) return;
        updateBook(activeBook.id, { entries: activeBook.entries.filter(e => e.uid !== uid) });
        if (editingUid === uid) setEditingUid(null);
    };

    // ── 多选模式：右滑选中 / 批量操作 / 多选拖拽（与预设一致） ──
    const enterSelectMode = useCallback(() => {
        if (!activeBookId) return;
        setSelectMode(true);
        setSelectionBookId(activeBookId);
        setSelectedUids(new Set());
        setEditingUid(null);
        swipe.close();
    }, [activeBookId, swipe]);

    const exitSelectMode = useCallback(() => {
        setSelectMode(false);
        setSelectedUids(new Set());
        setSelectionBookId(null);
        swipe.close();
    }, [swipe]);

    const toggleSelect = useCallback((uid: string) => {
        setSelectedUids(prev => {
            const next = new Set(prev);
            if (next.has(uid)) next.delete(uid);
            else next.add(uid);
            return next;
        });
    }, []);

    // 右滑条目 → 选中并进入多选模式；已处于多选模式时追加选中
    const handleSwipeRightSelect = useCallback((uid: string) => {
        if (!activeBookId) return;
        setSelectMode(true);
        setEditingUid(null);
        setSelectedUids(prev => {
            const next = selectionBookId === activeBookId ? new Set(prev) : new Set<string>();
            next.add(uid);
            return next;
        });
        setSelectionBookId(activeBookId);
        swipe.close();
    }, [activeBookId, selectionBookId, swipe]);

    const selectAllEntries = useCallback(() => {
        if (!activeBookId) return;
        setSelectionBookId(activeBookId);
        setSelectedUids(new Set((activeBook?.entries || []).map(entry => entry.uid)));
    }, [activeBook?.entries, activeBookId]);

    const bulkSetEnabled = useCallback((enabled: boolean) => {
        if (!activeBook || actionableSelectedUids.size === 0) return;
        updateBook(activeBook.id, {
            entries: activeBook.entries.map(entry =>
                actionableSelectedUids.has(entry.uid) ? { ...entry, disable: !enabled } : entry,
            ),
        });
    }, [actionableSelectedUids, activeBook]);

    const bulkExportSelected = useCallback(async () => {
        if (!activeBook || actionableSelectedUids.size === 0) return;
        const selected = activeBook.entries.filter(entry => actionableSelectedUids.has(entry.uid));
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${activeBook.name || "worldbook"}-entries.json`);
    }, [actionableSelectedUids, activeBook]);

    const deleteSelectedEntries = useCallback(() => {
        if (!activeBook || actionableSelectedUids.size === 0) return;
        updateBook(activeBook.id, { entries: activeBook.entries.filter(entry => !actionableSelectedUids.has(entry.uid)) });
        if (editingUid && actionableSelectedUids.has(editingUid)) setEditingUid(null);
        setSelectedUids(new Set());
        setSelectionBookId(null);
        setConfirmDeleteSelected(false);
        setSelectMode(false);
    }, [actionableSelectedUids, activeBook, editingUid]);

    if (!isLoaded) return null;

    return (
        <div ref={wbContainerRef} className="flex flex-col gap-5 h-full">
            <input type="file" accept=".json" className="hidden" ref={fileInputRef} onChange={handleImport} />
            <input type="file" accept=".json" className="hidden" ref={entryFileInputRef} onChange={handleEntryImportFile} />
            {viewMode === "list" ? (
                <>
                    <div className="flex items-center">
                        <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Worldbooks</h2>
                    </div>

                    {books.length === 0 ? (
                        <div className="ui-empty mt-2">
                            <div className="ui-icon-circle">
                                <BookOpen size={24} />
                            </div>
                            <span className="menu-label font-semibold">没有世界书</span>
                            <span className="menu-desc text-center max-w-[240px] !mt-0">
                                世界书用于为 AI 提供长期记忆和背景知识，当触发特定词汇时自动插入设定。
                            </span>
                            <button onClick={addBook} className="ui-btn ui-btn-primary mt-2">
                                <Plus size={16} /> 新建世界书
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 gap-3">
                            {books.map(book => (
                                <div
                                    key={book.id}
                                    className="ui-config-card min-w-0 cursor-pointer"
                                    style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`编辑 ${book.name || "世界书"}`}
                                    onClick={() => { setActiveBookId(book.id); setViewMode("detail"); }}
                                    onKeyDown={(event) => {
                                        if (event.target !== event.currentTarget) return;
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            setActiveBookId(book.id);
                                            setViewMode("detail");
                                        }
                                    }}
                                >
                                    <div className="min-w-0 flex flex-col gap-1.5">
                                        <div className="min-w-0 flex items-center gap-[6px]">
                                            <BookOpen size={16} className="shrink-0" />
                                            <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{book.name}</span>
                                        </div>
                                        <span className="menu-desc truncate">{book.description || `${book.entries?.length || 0} 个条目`}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="menu-desc ts-12">条目 {book.entries?.length || 0}</span>
                                        <ChevronLeft size={16} className="opacity-40" style={{ transform: "rotate(180deg)" }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            ) : (
                <>
                    {/* Detail View — matches preset-manager layout */}
                    {activeBook && (
                        <div className="flex flex-col gap-4 pb-6">
                            <div className="flex justify-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleExport(activeBook)}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95"
                                >
                                    <Download size={15} strokeWidth={1.8} />
                                    <span>导出世界书</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setConfirmDeleteTarget({ type: 'book', id: activeBook.id })}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-[var(--c-danger)] shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95"
                                >
                                    <Trash2 size={15} strokeWidth={1.8} />
                                    <span>删除世界书</span>
                                </button>
                            </div>

                            <div className="mx-2 mb-0 mt-2 flex items-center justify-between gap-2">
                                <h2 className="ts-20 font-bold leading-none text-black">Worldbook Info</h2>
                                <span className="menu-desc !mt-0 shrink-0 ts-12">
                                    总计 {estimateBookTokens(activeBook).toLocaleString()} tk
                                </span>
                            </div>
                            <div className="ui-entry-card" style={{ cursor: "default" }}>
                                <div className="flex flex-col gap-2">
                                    <label className="menu-label ts-13 font-semibold ml-1">世界书名称</label>
                                    <input
                                        type="text"
                                        value={activeBook.name}
                                        onChange={(e) => updateBook(activeBook.id, { name: e.target.value })}
                                        placeholder="世界书名称..."
                                        className="ui-input font-medium"
                                    />
                                </div>

                                <div className="flex flex-col gap-2">
                                    <label className="menu-label ts-13 font-semibold ml-1">简介描述</label>
                                    <textarea
                                        value={activeBook.description || ""}
                                        onChange={(e) => updateBook(activeBook.id, { description: e.target.value })}
                                        placeholder="简介描述..."
                                        rows={2}
                                        className="ui-textarea resize-none"
                                    />
                                </div>
                            </div>

                            {/* Entries Section */}
                            <div className="flex flex-col gap-4 mt-2">
                            <div className="mx-2 mt-2 flex items-center justify-between gap-2">
                                <h2 className="mb-0 ts-20 font-bold leading-none text-black">
                                    Worldbook Entries ({activeBook.entries?.length || 0})
                                </h2>
                                {!selectMode && (
                                    <button
                                        type="button"
                                        onClick={enterSelectMode}
                                        className="inline-flex h-8 items-center justify-center gap-1 rounded-full border border-black/10 bg-white px-3 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 active:scale-95"
                                    >
                                        <CheckSquare size={14} strokeWidth={1.8} />
                                        <span>多选</span>
                                    </button>
                                )}
                            </div>

                            {selectMode && (() => {
                                const bookEntries = activeBook?.entries || [];
                                const allVisibleSelected = bookEntries.length > 0 && bookEntries.every(entry => actionableSelectedUids.has(entry.uid));
                                const selectedEntries = bookEntries.filter(entry => actionableSelectedUids.has(entry.uid));
                                const allEnabled = selectedEntries.length > 0 && selectedEntries.every(entry => !entry.disable);
                                return (
                                <div className="multi-select-float-bar">
                                    <div className="msfb-main">
                                        <span className="msfb-count">已选 {actionableSelectedUids.size} 项</span>
                                        <button type="button" className="msfb-btn" onClick={() => {
                                            if (allVisibleSelected) setSelectedUids(new Set());
                                            else selectAllEntries();
                                        }}>
                                            <CheckSquare size={15} strokeWidth={1.8} />
                                            <span>{allVisibleSelected ? "取消全选" : "全选可见"}</span>
                                        </button>
                                        <button type="button" className="msfb-btn" onClick={() => bulkSetEnabled(!allEnabled)} disabled={actionableSelectedUids.size === 0}>
                                            {allEnabled ? <RotateCcw size={15} strokeWidth={1.8} /> : <Check size={15} strokeWidth={2} />}
                                            <span>{allEnabled ? "禁用" : "启用"}</span>
                                        </button>
                                        <button type="button" className="msfb-btn" onClick={() => bulkExportSelected()} disabled={actionableSelectedUids.size === 0}>
                                            <Download size={15} strokeWidth={1.8} />
                                            <span>导出</span>
                                        </button>
                                        <button type="button" className="msfb-btn msfb-danger" onClick={() => setConfirmDeleteSelected(true)} disabled={actionableSelectedUids.size === 0}>
                                            <Trash2 size={15} strokeWidth={1.8} />
                                            <span>删除</span>
                                        </button>
                                    </div>
                                    <div className="msfb-actions">
                                        <button type="button" className="msfb-btn msfb-done" onClick={exitSelectMode}>
                                            <Check size={15} strokeWidth={2} />
                                            <span>完成</span>
                                        </button>
                                    </div>
                                </div>
                                );
                            })()}

                            {/* Entry Cards */}
                            {visibleEntries.length === 0 ? (
                                <div className="menu-desc text-center mt-10 ts-14">
                                    没找到相关的世界书条目
                                </div>
                            ) : (
                            <div
                                ref={entryListRef}
                                className="flex flex-col gap-2"
                                onTouchMove={onEntryTouchMove}
                                onTouchEnd={onEntryTouchEnd}
                                onTouchCancel={onEntryTouchEnd}
                            >
                                    {visibleEntries.map((entry, entryIndex) => {
                                        const isEditing = editingUid === entry.uid;
                                        const isEntrySelected = selectionBookId === activeBookId && selectedUids.has(entry.uid);

                                        return (
                                            <SwipeActionRow
                                                key={entry.uid}
                                                controller={swipe}
                                                id={entry.uid}
                                                disabled={isEditing}
                                                leftSwipeDisabled={selectMode}
                                                rightSwipeEnabled
                                                onSwipeRight={() => handleSwipeRightSelect(entry.uid)}
                                                onTouchStart={isEditing ? undefined : (e) => onEntryTouchStart(entryIndex, e)}
                                                actions={selectMode ? null : (
                                                    <>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="insert"
                                                            onClick={() => insertEntryAfter(entry.uid)}
                                                        >
                                                            <Plus size={18} strokeWidth={2} />
                                                            <span>新增</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="transfer"
                                                            onClick={() => {
                                                                setCrossBookEntryUid(entry.uid);
                                                                setCrossBookTargetId(null);
                                                                swipe.close();
                                                            }}
                                                        >
                                                            <FolderInput size={18} strokeWidth={2} />
                                                            <span>转移</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="delete"
                                                            onClick={() => {
                                                                setConfirmDeleteTarget({ type: 'entry', id: entry.uid });
                                                                swipe.close();
                                                            }}
                                                        >
                                                            <Trash2 size={18} strokeWidth={2} />
                                                            <span>删除</span>
                                                        </button>
                                                    </>
                                                )}
                                            >
                                            <div
                                                className="ui-entry-card"
                                                data-active={isEditing ? "true" : undefined}
                                                data-selected={selectMode && isEntrySelected ? "true" : undefined}
                                                data-disabled={entry.disable && !isEditing ? "true" : undefined}
                                                style={{
                                                    gap: isEditing ? 12 : 0,
                                                    userSelect: isEditing ? undefined : "none",
                                                    WebkitUserSelect: isEditing ? undefined : "none",
                                                }}
                                            >
                                                {/* Summary Row */}
                                                <div className="flex justify-between items-start">
                                                    <button
                                                        onClick={() => {
                                                            if (swipe.consumeClickSuppression()) return;
                                                            if (swipe.openId || swipe.swipingId) {
                                                                swipe.close();
                                                                return;
                                                            }
                                                            if (selectMode) {
                                                                toggleSelect(entry.uid);
                                                                return;
                                                            }
                                                            setEditingUid(isEditing ? null : entry.uid);
                                                        }}
                                                        className="flex gap-3 flex-1 bg-none border-none text-left cursor-pointer p-0"
                                                        style={{ cursor: isEditing ? "default" : "grab" }}
                                                    >
                                                        {selectMode ? (
                                                            <div
                                                                className="mt-[2px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2"
                                                                style={{
                                                                    borderColor: isEntrySelected ? "var(--c-icon-active)" : "rgba(0,0,0,0.25)",
                                                                    background: isEntrySelected ? "var(--c-icon-active)" : "transparent",
                                                                    color: "#fff",
                                                                }}
                                                            >
                                                                {isEntrySelected && <Check size={13} strokeWidth={3} />}
                                                            </div>
                                                        ) : (
                                                            <div className="mt-0.5 ui-entry-icon">
                                                                <BookOpen size={20} />
                                                            </div>
                                                        )}
                                                        <div className="flex flex-col gap-1 flex-1">
                                                            <div className="flex items-center gap-[6px]">
                                                                <GripVertical size={14} className="text-[var(--c-text)] shrink-0" style={{ opacity: isEditing ? 0 : 0.5 }} />
                                                                <span className="menu-label font-semibold break-all ts-15">
                                                                    {entry.comment || "(未设置名称)"}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                {entry.constant && <span className="ui-status-tag" data-variant="warning">常驻激活</span>}
                                                                {!entry.constant && <span className="ui-status-tag" data-variant="success">关键词触发</span>}
                                                                {entry.use_regex && !entry.constant && <span className="ui-status-tag" data-variant="action">正则触发</span>}
                                                                {!entry.constant && (
                                                                    <span className="ui-tag" data-variant="muted">
                                                                        {entry.use_regex ? (entry.key || "/(regex)/") : (entry.key || "(无触发词)")}
                                                                    </span>
                                                                )}
                                                                {entry.disable && <span className="ui-status-tag">已禁用</span>}
                                                            </div>
                                                        </div>
                                                    </button>

                                                    <div className="flex gap-3 ml-3 shrink-0 items-center">
                                                        <label
                                                            className="ui-mini-toggle"
                                                            onClick={(e) => e.stopPropagation()}
                                                            title={entry.disable ? "已禁用 (点击启用)" : "已启用 (点击禁用)"}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={!entry.disable}
                                                                onChange={(e) => updateEntry(entry.uid, { disable: !e.target.checked })}
                                                                className="ui-mini-toggle-track"
                                                            />
                                                            <div className="ui-mini-toggle-thumb" />
                                                        </label>
                                                    </div>
                                                </div>

                                                {/* Expanded Edit */}
                                                {isEditing && (
                                                    <div className="ui-entry-separator flex flex-col gap-3">

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between items-end">
                                                                <label className="menu-desc">触发关键字 (Key)</label>
                                                                <div className="flex items-center gap-3">
                                                                    <label className="ui-checkbox-label">
                                                                        <input type="checkbox" checked={entry.constant} onChange={(e) => updateEntry(entry.uid, { constant: e.target.checked })} />
                                                                        常驻激活
                                                                    </label>
                                                                    <label className="ui-checkbox-label" style={{ opacity: entry.constant ? 0.5 : 1 }}>
                                                                        <input type="checkbox" checked={entry.use_regex} onChange={(e) => updateEntry(entry.uid, { use_regex: e.target.checked })} disabled={entry.constant} />
                                                                        使用正则
                                                                    </label>
                                                                </div>
                                                            </div>
                                                            <input
                                                                type="text"
                                                                value={entry.key}
                                                                onChange={(e) => updateEntry(entry.uid, { key: e.target.value })}
                                                                placeholder={entry.constant ? "已全局常驻，此字段无效" : (entry.use_regex ? "/正则表达式/i" : "例如: 魔法, 设定, 人物")}
                                                                disabled={entry.constant}
                                                                className="ui-input ts-14"
                                                                style={{ fontFamily: entry.use_regex && !entry.constant ? "monospace" : "inherit", opacity: entry.constant ? 0.5 : 1 }}
                                                            />
                                                        </div>

                                                        <div className="grid grid-cols-2 gap-3">
                                                            <div className="flex flex-col gap-1">
                                                                <label className="menu-desc">注入位置 (Position)</label>
                                                                <select
                                                                    value={String(
                                                                        typeof entry.position === "string"
                                                                            ? ({ before_char: 0, after_char: 1, before_an: 2, after_an: 3, before_em: 5, after_em: 6 }[entry.position] ?? 0)
                                                                            : (entry.position ?? 0)
                                                                    )}
                                                                    onChange={(e) => {
                                                                        const num = parseInt(e.target.value);
                                                                        updateEntry(entry.uid, { position: isNaN(num) ? 0 : num });
                                                                    }}
                                                                    className="ui-select ts-13"
                                                                >
                                                                    <option value="0">角色设定前</option>
                                                                    <option value="1">角色设定后</option>
                                                                    <option value="4">按深度插入</option>
                                                                </select>
                                                            </div>
                                                            <div className="flex flex-col gap-1">
                                                                <label className="menu-desc">注入深度 (Depth)</label>
                                                                <input
                                                                    type="number"
                                                                    value={entry.depth ?? 0}
                                                                    onChange={(e) => updateEntry(entry.uid, { depth: parseInt(e.target.value) || 0 })}
                                                                    min="0"
                                                                    disabled={entry.position !== 4}
                                                                    className="ui-input ts-13"
                                                                    style={{ opacity: entry.position !== 4 ? 0.5 : 1 }}
                                                                />
                                                            </div>

                                                            <div className="flex flex-col gap-1">
                                                                <label className="menu-desc">权重优先级 (Order)</label>
                                                                <input
                                                                    type="number"
                                                                    value={entry.insertion_order ?? 50}
                                                                    onChange={(e) => updateEntry(entry.uid, { insertion_order: parseInt(e.target.value) || 0 })}
                                                                    className="ui-input ts-13"
                                                                />
                                                            </div>
                                                            <div className="flex flex-col gap-1">
                                                                <label className="menu-desc">消息角色 (Role)</label>
                                                                <select
                                                                    value={entry.role ?? 0}
                                                                    onChange={(e) => updateEntry(entry.uid, { role: parseInt(e.target.value) || 0 })}
                                                                    className="ui-select ts-13"
                                                                >
                                                                    <option value={0}>System</option>
                                                                    <option value={1}>User</option>
                                                                    <option value={2}>Assistant</option>
                                                                </select>
                                                            </div>
                                                            <div className="col-span-full flex items-center gap-3">
                                                                <span className="menu-desc !mt-0 shrink-0">触发概率 (Probability)</span>
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={!!entry.useProbability} onChange={e => updateEntry(entry.uid, { useProbability: e.target.checked })} />
                                                                    启用
                                                                </label>
                                                                <input
                                                                    type="number"
                                                                    value={entry.probability ?? 100}
                                                                    onChange={(e) => updateEntry(entry.uid, { probability: parseInt(e.target.value) || 0 })}
                                                                    min="0" max="100"
                                                                    disabled={!entry.useProbability}
                                                                    className="ui-input ts-13 ml-auto w-[88px]"
                                                                    style={{ opacity: !entry.useProbability ? 0.5 : 1 }}
                                                                />
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">备注 (Comment)</label>
                                                            <input
                                                                type="text"
                                                                value={entry.comment}
                                                                onChange={(e) => updateEntry(entry.uid, { comment: e.target.value })}
                                                                placeholder="描述设定的作用..."
                                                                className="ui-input ts-13"
                                                            />
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <label className="menu-desc">设定内容 (Content)</label>
                                                                <span className="menu-desc !mt-0 ts-11">
                                                                    {estimateEntryTokens(entry).toLocaleString()} tk
                                                                </span>
                                                            </div>
                                                            <div className="relative">
                                                                <textarea
                                                                    value={entry.content}
                                                                    onChange={(e) => updateEntry(entry.uid, { content: e.target.value })}
                                                                    placeholder="当触发关键字时，会被作为背景信息输入给AI的内容..."
                                                                    rows={6}
                                                                    className="ui-textarea ts-13"
                                                                />
                                                                <button onClick={() => setExpandUid(entry.uid)} className="absolute top-2 right-2 bg-none border-none cursor-pointer p-0" style={{ color: "var(--c-icon)" }}><Maximize2 size={14} /></button>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-wrap gap-2">
                                                            <button
                                                                type="button"
                                                                className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[16px] border border-black/10 bg-white px-3 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 active:scale-95"
                                                                onClick={() => {
                                                                    entryImportModeRef.current = { mode: "replace", uid: entry.uid };
                                                                    entryFileInputRef.current?.click();
                                                                }}
                                                            >
                                                                <Replace size={14} strokeWidth={2} />
                                                                替换 JSON
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[16px] border border-black/10 bg-white px-3 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 active:scale-95"
                                                                onClick={() => exportEntry(entry)}
                                                            >
                                                                <Download size={14} strokeWidth={2} />
                                                                导出 JSON
                                                            </button>
                                                        </div>

                                                    </div>
                                                )}
                                            </div>
                                            </SwipeActionRow>
                                        )
                                    })}
                            </div>
                            )}

                            <button
                                type="button"
                                onClick={() => setAddEntryMenuOpen(true)}
                                className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                            >
                                <Plus size={15} strokeWidth={1.8} />
                                添加条目
                            </button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Delete Confirmation Dialog */}
            {confirmDeleteTarget && (
                <ConfirmDialog
                    title="确认删除？"
                    message={confirmDeleteTarget.type === 'book' ? "删除世界书后无法恢复。是否继续？" : "删除条目后无法恢复。是否继续？"}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        if (confirmDeleteTarget.type === 'book') {
                            removeBook(confirmDeleteTarget.id);
                        } else {
                            removeEntry(confirmDeleteTarget.id);
                        }
                        setConfirmDeleteTarget(null);
                    }}
                    onCancel={() => setConfirmDeleteTarget(null)}
                />
            )}

            {importError && (
                <ConfirmDialog
                    title="导入失败"                    message={importError}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="知道了"
                    cancelLabel=""
                    onConfirm={() => setImportError(null)}
                    onCancel={() => setImportError(null)}
                />
            )}

            {/* Confirm bulk delete selected entries */}
            {confirmDeleteSelected && activeBook && (
                <ConfirmDialog
                    title="确认批量删除？"
                    message={`将删除当前已选中的 ${actionableSelectedUids.size} 个条目，删除后无法恢复。是否继续？`}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    onConfirm={() => deleteSelectedEntries()}
                    onCancel={() => setConfirmDeleteSelected(false)}
                />
            )}

            {addEntryMenuOpen && activeBook && (
                <BottomSheet title="添加条目" onClose={() => setAddEntryMenuOpen(false)}>
                    <div className="flex flex-col gap-2">
                        <button
                            type="button"
                            className="ui-btn ui-btn-primary w-full"
                            onClick={() => {
                                setAddEntryMenuOpen(false);
                                addEntry();
                            }}
                        >
                            <Plus size={16} /> 直接创建
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline w-full"
                            onClick={() => {
                                setAddEntryMenuOpen(false);
                                entryImportModeRef.current = { mode: "append" };
                                entryFileInputRef.current?.click();
                            }}
                        >
                            <Upload size={16} /> 从 JSON 文件导入
                        </button>
                    </div>
                </BottomSheet>
            )}

            {crossBookEntryUid && activeBook && (() => {
                const sourceEntry = activeBook.entries.find(e => e.uid === crossBookEntryUid);
                const otherBooks = books.filter(b => b.id !== activeBook.id);
                const targetBook = crossBookTargetId ? books.find(b => b.id === crossBookTargetId) : null;
                const entryLabel = sourceEntry?.comment || sourceEntry?.key || "未命名条目";

                if (targetBook) {
                    return (
                        <BottomSheet title="复制 / 转移" onClose={closeCrossBookSheet}>
                            <div className="flex flex-col gap-2">
                                <p className="menu-desc !mt-0 text-center px-1">
                                    将「{entryLabel}」复制 / 转移到「{targetBook.name || "未命名世界书"}」
                                </p>
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-primary w-full"
                                    onClick={() => copyEntryToBook(crossBookEntryUid, targetBook.id)}
                                >
                                    复制到该世界书
                                </button>
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-outline w-full"
                                    onClick={() => moveEntryToBook(crossBookEntryUid, targetBook.id)}
                                >
                                    转移到该世界书
                                </button>
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-ghost w-full"
                                    onClick={closeCrossBookSheet}
                                >
                                    取消
                                </button>
                            </div>
                        </BottomSheet>
                    );
                }

                return (
                    <BottomSheet title="选择目标世界书" onClose={closeCrossBookSheet}>
                        <div className="flex flex-col gap-2">
                            <p className="menu-desc !mt-0 text-center px-1">
                                将「{entryLabel}」复制 / 转移到其他世界书
                            </p>
                            {otherBooks.length === 0 ? (
                                <p className="menu-desc text-center py-4">暂无其他世界书</p>
                            ) : (
                                otherBooks.map(book => (
                                    <button
                                        key={book.id}
                                        type="button"
                                        className="ui-btn ui-btn-outline w-full justify-start gap-2"
                                        onClick={() => setCrossBookTargetId(book.id)}
                                    >
                                        <BookOpen size={16} className="shrink-0" />
                                        <span className="truncate flex-1 text-left">{book.name || "未命名世界书"}</span>
                                        <span className="menu-desc !mt-0 shrink-0">{book.entries?.length || 0} 条</span>
                                    </button>
                                ))
                            )}
                            <button
                                type="button"
                                className="ui-btn ui-btn-ghost w-full"
                                onClick={closeCrossBookSheet}
                            >
                                取消
                            </button>
                        </div>
                    </BottomSheet>
                );
            })()}

            {expandUid && (() => {
                const entry = activeBook?.entries?.find(e => e.uid === expandUid);
                if (!entry) return null;
                return (
                    <TextExpandModal
                        title={entry.comment || "编辑设定内容"}
                        value={entry.content}
                        onChange={(v) => updateEntry(entry.uid, { content: v })}
                        placeholder="当触发关键字时，会被作为背景信息输入给AI的内容..."
                        className="ts-13"
                        onClose={() => setExpandUid(null)}
                    />
                );
            })()}
        </div>
    );
}
