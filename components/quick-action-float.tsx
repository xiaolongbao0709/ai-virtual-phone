"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type CSSProperties } from "react";
import { BookOpen, Check, ChevronDown, Code2, SlidersHorizontal, UserRound, X } from "lucide-react";
import { CHAT_APP_SETTINGS_UPDATED_EVENT, loadChatAppSettings } from "@/lib/chat-storage";
import {
    getFloatingDockState,
    subscribeFloatingDockState,
    expandFloatingDock,
    collapseFloatingDock,
    setFloatingDockAnchor,
    setActiveFloatingTool,
} from "@/lib/floating-dock-store";
import {
    getCharacterBinding,
    loadApiConfigs,
    loadBindingConfig,
    loadWorldBooks,
    saveBindingConfig,
    setCharacterBinding,
} from "@/lib/settings-storage";
import type { ApiConfig, BindingConfig, BindingSlot, WorldBookConfig } from "@/lib/settings-types";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

type QuickScope = "global" | "character";
type FloatingPosition = { left: number; top: number };
type PopoverPosition = { left: number; top: number };
type FloatingDragState = {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
};

const EMPTY_BINDING_CONFIG: BindingConfig = { globalDefaults: {}, characterBindings: [] };

function clampFloatingPosition(value: number, max: number): number {
    return Math.min(Math.max(12, value), max);
}

function itemName<T extends { id: string; name?: string }>(items: T[], id?: string): string {
    if (!id) return "";
    return items.find(item => item.id === id)?.name || "已删除的配置";
}

function getStatusSafeTop(element: HTMLElement): number {
    const raw = window.getComputedStyle(element).getPropertyValue("--safe-area-top");
    const safeAreaTop = Number.parseFloat(raw);
    return Math.max(72, (Number.isFinite(safeAreaTop) ? safeAreaTop : 48) + 18);
}

export function QuickActionFloat() {
    const [enabled, setEnabled] = useState(false);
    const [open, setOpen] = useState(false);
    const [scope, setScope] = useState<QuickScope>("global");
    const [selectedCharId, setSelectedCharId] = useState("");
    const [config, setConfig] = useState<BindingConfig>(EMPTY_BINDING_CONFIG);
    const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
    const [worldBooks, setWorldBooks] = useState<WorldBookConfig[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null);
    const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
    const [draggingFloatingButton, setDraggingFloatingButton] = useState(false);
    const [floatingDockEnabled, setFloatingDockEnabled] = useState(false);
    const [promptViewerEnabled, setPromptViewerEnabled] = useState(false);
    const dockState = useSyncExternalStore(subscribeFloatingDockState, getFloatingDockState, getFloatingDockState);
    const layerRef = useRef<HTMLDivElement | null>(null);
    const floatingButtonRef = useRef<HTMLButtonElement | null>(null);
    const floatingDragRef = useRef<FloatingDragState | null>(null);
    const suppressFloatingClickRef = useRef(false);

    const handleClose = useCallback(() => {
        setOpen(false);
        if (floatingDockEnabled) {
            collapseFloatingDock();
        }
    }, [floatingDockEnabled]);

    const reloadData = useCallback(() => {
        const nextCharacters = loadCharacters();
        setConfig(loadBindingConfig());
        setApiConfigs(loadApiConfigs());
        setWorldBooks(loadWorldBooks());
        setCharacters(nextCharacters);
        setSelectedCharId(prev => {
            if (prev && nextCharacters.some(character => character.id === prev)) return prev;
            return nextCharacters[0]?.id || "";
        });
    }, []);

    useEffect(() => {
        const syncEnabled = (event?: Event) => {
            const detail = (event as CustomEvent | undefined)?.detail;
            const settings = loadChatAppSettings();
            const nextEnabled = typeof detail?.quickActionEnabled === "boolean"
                ? detail.quickActionEnabled
                : settings.quickActionEnabled === true;
            setEnabled(nextEnabled);
            setPromptViewerEnabled(typeof detail?.promptViewerEnabled === "boolean" ? detail.promptViewerEnabled : settings.promptViewerEnabled === true);
            setFloatingDockEnabled(typeof detail?.floatingDockEnabled === "boolean" ? detail.floatingDockEnabled : settings.floatingDockEnabled === true);
            if (!nextEnabled) setOpen(false);
        };
        syncEnabled();
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
    }, []);

    useEffect(() => {
        if (!enabled) return;
        reloadData();
        const handleBindingsUpdated = () => reloadData();
        const handleFocus = () => reloadData();
        window.addEventListener("settings-bindings-updated", handleBindingsUpdated);
        window.addEventListener("focus", handleFocus);
        return () => {
            window.removeEventListener("settings-bindings-updated", handleBindingsUpdated);
            window.removeEventListener("focus", handleFocus);
        };
    }, [enabled, reloadData]);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!layerRef.current?.contains(event.target as Node)) {
                handleClose();
            }
        };
        document.addEventListener("pointerdown", handlePointerDown);
        return () => document.removeEventListener("pointerdown", handlePointerDown);
    }, [open, handleClose]);

    useEffect(() => {
        if (!floatingDockEnabled || !dockState.isExpanded || open) return;
        const handleOutside = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target?.closest(".prompt-viewer-float-button")) {
                collapseFloatingDock();
            }
        };
        const timer = setTimeout(() => {
            document.addEventListener("pointerdown", handleOutside);
        }, 60);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("pointerdown", handleOutside);
        };
    }, [floatingDockEnabled, dockState.isExpanded, open]);

    useLayoutEffect(() => {
        const layer = layerRef.current;
        const button = floatingButtonRef.current;
        if (!open || !layer || !button) {
            setPopoverPosition(null);
            return;
        }
        const rect = layer.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const posAnchor = (draggingFloatingButton && floatingPosition)
            ? floatingPosition
            : (dockState.anchorPosition)
                ? dockState.anchorPosition
                : (floatingPosition ?? {
                    left: buttonRect.left - rect.left,
                    top: buttonRect.top - rect.top,
                });
        const width = Math.min(344, rect.width - 32);
        const statusSafeTop = getStatusSafeTop(layer);
        const estimatedHeight = Math.min(520, Math.max(240, rect.height - statusSafeTop - 12));
        const left = posAnchor.left - width - 8;
        const top = posAnchor.top - estimatedHeight - 8;
        const maxTop = Math.max(statusSafeTop, rect.height - estimatedHeight - 12);
        setPopoverPosition({
            left: Math.min(Math.max(12, left), Math.max(12, rect.width - width - 12)),
            top: Math.min(Math.max(statusSafeTop, top), maxTop),
        });
    }, [open, floatingPosition, dockState.anchorPosition, draggingFloatingButton]);

    const currentSlot: BindingSlot = useMemo(() => {
        if (scope === "global") return config.globalDefaults || {};
        if (!selectedCharId) return {};
        return getCharacterBinding(config, selectedCharId).defaults;
    }, [config, scope, selectedCharId]);

    const selectedCharacter = useMemo(
        () => characters.find(character => character.id === selectedCharId) || null,
        [characters, selectedCharId]
    );
    const selectedWorldBookIds = currentSlot.worldBookIds || [];
    const selectedWorldBookNames = selectedWorldBookIds.map(id => itemName(worldBooks, id)).filter(Boolean);
    const inheritedApiName = scope === "character" ? itemName(apiConfigs, config.globalDefaults.apiConfigId) : "";
    const inheritedWorldBookNames = scope === "character"
        ? (config.globalDefaults.worldBookIds || []).map(id => itemName(worldBooks, id)).filter(Boolean)
        : [];

    const persistConfig = useCallback((next: BindingConfig) => {
        setConfig(next);
        saveBindingConfig(next);
    }, []);

    const updateApiConfig = useCallback((apiConfigId: string | undefined) => {
        if (scope === "global") {
            persistConfig({ ...config, globalDefaults: { ...config.globalDefaults, apiConfigId: apiConfigId || undefined } });
            return;
        }
        if (!selectedCharId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        persistConfig(setCharacterBinding(config, {
            ...binding,
            defaults: { ...binding.defaults, apiConfigId: apiConfigId || undefined },
        }));
    }, [config, persistConfig, scope, selectedCharId]);

    const updateWorldBooks = useCallback((worldBookIds: string[]) => {
        const nextIds = worldBookIds.length > 0 ? worldBookIds : undefined;
        if (scope === "global") {
            persistConfig({ ...config, globalDefaults: { ...config.globalDefaults, worldBookIds: nextIds } });
            return;
        }
        if (!selectedCharId) return;
        const binding = getCharacterBinding(config, selectedCharId);
        persistConfig(setCharacterBinding(config, {
            ...binding,
            defaults: { ...binding.defaults, worldBookIds: nextIds },
        }));
    }, [config, persistConfig, scope, selectedCharId]);

    const toggleWorldBook = useCallback((worldBookId: string) => {
        const next = selectedWorldBookIds.includes(worldBookId)
            ? selectedWorldBookIds.filter(id => id !== worldBookId)
            : [...selectedWorldBookIds, worldBookId];
        updateWorldBooks(next);
    }, [selectedWorldBookIds, updateWorldBooks]);

    function getFloatingButtonBounds(button: HTMLButtonElement, currentPos: FloatingPosition | null) {
        const parent = button.offsetParent instanceof HTMLElement ? button.offsetParent : null;
        const parentRect = parent?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        // 始终使用未变换的纯净布局坐标：优先使用 state 中的位置，若初始未拖拽则取 offsetLeft / offsetTop（不受 CSS transform 影响）
        const left = currentPos ? currentPos.left : button.offsetLeft;
        const top = currentPos ? currentPos.top : button.offsetTop;
        return {
            left,
            top,
            maxLeft: Math.max(12, parentRect.width - 56 - 12),
            maxTop: Math.max(12, parentRect.height - 56 - 12),
            parentWidth: parentRect.width,
            parentHeight: parentRect.height,
        };
    }

    function handleFloatingPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        const isDual = floatingDockEnabled && promptViewerEnabled && enabled;
        const isQuickPrimary = !isDual || dockState.primaryTool === "quick-action";
        if (dockState.isExpanded || (isDual && !isQuickPrimary)) {
            // 展开挑选模式、或并非当前停靠的主球时，不接受拖拽
            return;
        }
        event.stopPropagation();
        const button = event.currentTarget;
        const anchor = isDual ? dockState.anchorPosition : null;
        const bounds = getFloatingButtonBounds(button, (isDual && anchor) ? anchor : floatingPosition);
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
        // 不在 pointerDown 立即 setDraggingFloatingButton(true)，避免普通点击时瞬间取消 is-docked 产生动画抖动
        button.setPointerCapture(event.pointerId);
    }

    function handleFloatingPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const deltaX = event.clientX - drag.startClientX;
        const deltaY = event.clientY - drag.startClientY;
        if (!drag.moved) {
            // 超过 3px 移动阈值才判定为拖拽，杜绝手指/鼠标微小震颤把贴边位移写入 floatingPosition
            if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
                drag.moved = true;
                setDraggingFloatingButton(true);
            } else {
                return;
            }
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
        if (drag.moved) {
            suppressFloatingClickRef.current = true;
            if (floatingDockEnabled) {
                // Auto-snap to closest edge (left or right)
                const bounds = getFloatingButtonBounds(event.currentTarget, floatingPosition);
                const midX = bounds.parentWidth / 2;
                const currentX = drag.left + (event.clientX - drag.startClientX);
                const currentTop = drag.top + (event.clientY - drag.startClientY);
                const isLeft = currentX < midX;
                const snappedLeft = isLeft ? 18 : Math.max(18, bounds.parentWidth - 56 - 18);
                const snappedTop = clampFloatingPosition(currentTop, bounds.maxTop);
                const newPos = { left: snappedLeft, top: snappedTop };
                setFloatingPosition(newPos);
                setFloatingDockAnchor({ ...newPos, dockSide: isLeft ? "left" : "right" });
                if (!open) {
                    collapseFloatingDock();
                }
            }
        }

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

        // If already open, clicking it collapses back to dock
        if (open) {
            handleClose();
            return;
        }

        if (floatingDockEnabled) {
            const isDual = promptViewerEnabled && enabled;
            const isQuickPrimary = !isDual || dockState.primaryTool === "quick-action";
            // Dual-ball mode: if currently docked as primary and not expanded, clicking expands both balls!
            if (isDual && isQuickPrimary && dockState.isDocked && !dockState.isExpanded) {
                expandFloatingDock();
                return;
            }
            setActiveFloatingTool("quick-action");
        }

        reloadData();
        setOpen(true);
    }

    if (!enabled) return null;

    const characterDisabled = scope === "character" && characters.length === 0;
    const inheritApiLabel = scope === "global"
        ? "未设置"
        : inheritedApiName
            ? `继承全局：${inheritedApiName}`
            : "继承全局";
    const inheritWorldBookLabel = scope === "global"
        ? "未设置"
        : inheritedWorldBookNames.length > 0
            ? `继承全局：${inheritedWorldBookNames.join("、")}`
            : "继承全局";
    const popoverStyle: CSSProperties | undefined = popoverPosition
        ? { left: popoverPosition.left, top: popoverPosition.top }
        : undefined;

    const isDual = floatingDockEnabled && promptViewerEnabled && enabled;
    const isQuickPrimary = !isDual || dockState.primaryTool === "quick-action";
    const isPromptViewerActive = floatingDockEnabled && promptViewerEnabled && dockState.activeTool === "prompt-viewer";

    const isHiddenBehind = isDual && !isQuickPrimary && !open && !dockState.isExpanded;
    const isDocked = floatingDockEnabled && !open && (
        isQuickPrimary ? (dockState.isDocked && !draggingFloatingButton) : false
    );
    const isOpen = open;
    const isExpanded = floatingDockEnabled && !open && dockState.isExpanded;
    const isPaired = isDual && !isQuickPrimary && !open && dockState.isExpanded;
    const dockSide = dockState.dockSide;
    const anchor = isDual ? dockState.anchorPosition : null;

    const buttonClass = [
        "prompt-viewer-float-button",
        "quick-action-float-button",
        isHiddenBehind ? "is-hidden-behind" : "",
        isDocked ? "is-docked" : "",
        isOpen ? "is-open" : "",
        isExpanded ? "is-expanded" : "",
        isPaired ? "is-paired" : "",
    ].filter(Boolean).join(" ");

    let buttonStyle: CSSProperties | undefined;
    if (draggingFloatingButton && floatingPosition) {
        buttonStyle = { left: floatingPosition.left, top: floatingPosition.top };
    } else if (isDual && anchor) {
        buttonStyle = { left: anchor.left, top: anchor.top };
    } else if (floatingPosition) {
        buttonStyle = { left: floatingPosition.left, top: floatingPosition.top };
    } else if (isDual) {
        buttonStyle = { bottom: 148, right: 18 };
    }
    if (isPromptViewerActive) {
        buttonStyle = { ...buttonStyle, display: "none" };
    }

    return (
        <div className="quick-action-layer" ref={layerRef}>
            <button
                ref={floatingButtonRef}
                type="button"
                className={buttonClass}
                aria-label="打开快捷操作"
                data-positioned={(isDual ? !!anchor : !!floatingPosition) ? "" : undefined}
                data-dragging={draggingFloatingButton ? "" : undefined}
                data-dock-side={floatingDockEnabled ? dockSide : undefined}
                onPointerDown={handleFloatingPointerDown}
                onPointerMove={handleFloatingPointerMove}
                onPointerUp={handleFloatingPointerEnd}
                onPointerCancel={handleFloatingPointerEnd}
                onClick={handleFloatingButtonClick}
                style={buttonStyle}
            >
                <SlidersHorizontal size={24} strokeWidth={1.9} />
            </button>

            {open ? (
                <div
                    className="quick-action-popover"
                    data-positioned={popoverPosition ? "" : undefined}
                    style={popoverStyle}
                    role="dialog"
                    aria-label="快捷操作"
                    onClick={event => event.stopPropagation()}
                >
                    <div className="quick-action-header">
                        <div className="quick-action-title">
                            <span className="quick-action-title-icon"><SlidersHorizontal size={18} /></span>
                            <div>
                                <h3>快捷操作</h3>
                                <p>{scope === "global" ? "全局默认" : selectedCharacter?.name || "角色默认"}</p>
                            </div>
                        </div>
                        <button type="button" className="quick-action-icon-btn" onClick={handleClose} aria-label="关闭快捷操作">
                            <X size={18} />
                        </button>
                    </div>

                    <div className="quick-action-body">
                        <div className="quick-action-tabs" role="tablist" aria-label="绑定范围">
                            <button
                                type="button"
                                data-active={scope === "global"}
                                onClick={() => setScope("global")}
                            >
                                全局
                            </button>
                            <button
                                type="button"
                                data-active={scope === "character"}
                                onClick={() => setScope("character")}
                            >
                                角色
                            </button>
                        </div>

                        {scope === "character" ? (
                            <label className="quick-action-select-wrap">
                                <span><UserRound size={15} />角色</span>
                                <div className="quick-action-select-shell">
                                    <select
                                        value={selectedCharId}
                                        onChange={event => setSelectedCharId(event.target.value)}
                                        disabled={characters.length === 0}
                                    >
                                        {characters.length === 0 ? (
                                            <option value="">暂无角色</option>
                                        ) : characters.map(character => (
                                            <option key={character.id} value={character.id}>{character.name}</option>
                                        ))}
                                    </select>
                                    <ChevronDown size={16} />
                                </div>
                            </label>
                        ) : null}

                        <section className="quick-action-section" data-disabled={characterDisabled ? "" : undefined}>
                            <div className="quick-action-section-heading">
                                <span><Code2 size={16} />API</span>
                                {currentSlot.apiConfigId ? <small>{itemName(apiConfigs, currentSlot.apiConfigId)}</small> : <small>{scope === "global" ? "未设置" : "继承"}</small>}
                            </div>
                            <div className="quick-action-option-list">
                                <button
                                    type="button"
                                    className="quick-action-option"
                                    data-selected={!currentSlot.apiConfigId}
                                    disabled={characterDisabled}
                                    onClick={() => updateApiConfig(undefined)}
                                >
                                    <span>{inheritApiLabel}</span>
                                    {!currentSlot.apiConfigId ? <Check size={15} /> : null}
                                </button>
                                {apiConfigs.length === 0 ? (
                                    <div className="quick-action-empty">暂无 API 配置</div>
                                ) : apiConfigs.map(api => (
                                    <button
                                        type="button"
                                        key={api.id}
                                        className="quick-action-option"
                                        data-selected={currentSlot.apiConfigId === api.id}
                                        disabled={characterDisabled}
                                        onClick={() => updateApiConfig(api.id)}
                                    >
                                        <span>{api.name || api.defaultModel || api.provider}</span>
                                        {currentSlot.apiConfigId === api.id ? <Check size={15} /> : null}
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className="quick-action-section" data-disabled={characterDisabled ? "" : undefined}>
                            <div className="quick-action-section-heading">
                                <span><BookOpen size={16} />世界书</span>
                                <button
                                    type="button"
                                    className="quick-action-clear-btn"
                                    disabled={characterDisabled || selectedWorldBookIds.length === 0}
                                    onClick={() => updateWorldBooks([])}
                                >
                                    清空
                                </button>
                            </div>
                            <button
                                type="button"
                                className="quick-action-option quick-action-inherit-option"
                                data-selected={selectedWorldBookIds.length === 0}
                                disabled={characterDisabled}
                                onClick={() => updateWorldBooks([])}
                            >
                                <span>{selectedWorldBookIds.length === 0 ? inheritWorldBookLabel : selectedWorldBookNames.join("、")}</span>
                                {selectedWorldBookIds.length === 0 ? <Check size={15} /> : null}
                            </button>
                            {worldBooks.length === 0 ? (
                                <div className="quick-action-empty">暂无世界书</div>
                            ) : (
                                <div className="quick-action-chip-grid">
                                    {worldBooks.map(book => {
                                        const selected = selectedWorldBookIds.includes(book.id);
                                        return (
                                            <button
                                                type="button"
                                                key={book.id}
                                                className="quick-action-chip"
                                                data-selected={selected}
                                                disabled={characterDisabled}
                                                onClick={() => toggleWorldBook(book.id)}
                                            >
                                                <span>{book.name}</span>
                                                {selected ? <Check size={14} /> : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </section>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
