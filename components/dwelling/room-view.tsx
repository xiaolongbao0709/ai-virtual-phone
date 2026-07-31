"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Wand2 } from "lucide-react";
import type { DwellingRoom, DwellingFurniture, DwellingFurnitureItem } from "@/lib/dwelling-storage";
import { resolveFurnitureMarker } from "@/lib/dwelling-engine";
import { DWELLING_IMAGE_CANCELED_ERROR } from "@/lib/dwelling-image";

export type DwellingRoomImageStatus = "ambient" | "generating" | "ready" | "failed";

type RoomViewProps = {
    room: DwellingRoom;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
    onExploreItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem) => void;
    onOpenItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) => void;
    onMoveMarker: (furnitureId: string, marker: { x: number; y: number }) => void;
    imageUrl: string | null;
    imageStatus: DwellingRoomImageStatus;
    imageError: string | null;
    imageEnabled: boolean;
    imageConfigured: boolean;
    onToggleImage: () => void;
    onRetryImage: () => void;
    onCancelImage: () => void;
};

/** 与 dwelling-engine 的 clamp 范围保持一致：避开顶部玻璃栏区和底部引言区 */
const MK_X_MIN = 0.08, MK_X_MAX = 0.92, MK_Y_MIN = 0.24, MK_Y_MAX = 0.82;
const LONG_PRESS_MS = 450;
const LONG_PRESS_TOLERANCE = 10;

function ikey(roomId: string, itemId: string) { return `${roomId}_${itemId}`; }

function formatStageTime(): string {
    const d = new Date();
    let h = d.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${String(h).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

export function RoomView({
    room, itemHtmlCache, loadingItemKeys, lastItemError,
    onExploreItem, onOpenItem, onMoveMarker,
    imageUrl, imageStatus, imageError, imageEnabled, imageConfigured,
    onToggleImage, onRetryImage, onCancelImage,
}: RoomViewProps) {
    const [viewMode, setViewMode] = useState<"stage" | "list">("stage");
    const [sheetFurnitureId, setSheetFurnitureId] = useState<string | null>(null);
    const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
    const [tip, setTip] = useState<string | null>(null);

    useEffect(() => {
        setSheetFurnitureId(null);
        setExpandedItemId(null);
    }, [room.id]);

    useEffect(() => {
        if (!tip) return;
        const t = setTimeout(() => setTip(null), 2600);
        return () => clearTimeout(t);
    }, [tip]);

    const stageRef = useRef<HTMLDivElement | null>(null);
    const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);

    useEffect(() => {
        if (viewMode !== "stage") return;
        const el = stageRef.current;
        if (!el) return;
        const update = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, [viewMode]);

    const markers = useMemo(() => {
        const base = (room.furniture || []).map(f => {
            const m = resolveFurnitureMarker(f);
            return {
                f, m,
                h: m.x <= 0.55 ? "right" as const : "left" as const,
                len: 38,
            };
        });
        if (!stageSize) return base;
        // 标签避让：引线始终是水平直线，冲突时先换方向、再加长引线错开
        const placed: Array<{ x1: number; x2: number; y: number }> = [];
        const rectFor = (mk: typeof base[number], h: "left" | "right", len: number) => {
            const px = mk.m.x * stageSize.w;
            const labelW = mk.f.label.length * 17 + 40;
            const x1 = h === "right" ? px + 20 + len : px - 20 - len - labelW;
            return { x1, x2: x1 + labelW };
        };
        const sorted = [...base].sort((a, b) => a.m.y - b.m.y);
        for (const mk of sorted) {
            const py = mk.m.y * stageSize.h;
            const flip = mk.h === "right" ? "left" as const : "right" as const;
            const attempts: Array<{ h: "left" | "right"; len: number }> = [
                { h: mk.h, len: 38 }, { h: flip, len: 38 },
                { h: mk.h, len: 104 }, { h: flip, len: 104 },
            ];
            let done = false;
            for (const at of attempts) {
                const { x1, x2 } = rectFor(mk, at.h, at.len);
                if (x1 < 8 || x2 > stageSize.w - 8) continue;
                if (placed.some(p => !(x2 < p.x1 || x1 > p.x2) && Math.abs(py - p.y) < 36)) continue;
                mk.h = at.h; mk.len = at.len;
                placed.push({ x1, x2, y: py });
                done = true;
                break;
            }
            if (!done) placed.push({ ...rectFor(mk, mk.h, mk.len), y: py });
        }
        return base;
    }, [room, stageSize]);

    // ── 长按拖动标注点 ──
    const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
    const dragRef = useRef<{
        id: string; pointerId: number; target: HTMLElement;
        startX: number; startY: number; timer: number;
        active: boolean; committed: { x: number; y: number } | null;
    } | null>(null);
    const suppressClickRef = useRef(false);

    function stagePoint(clientX: number, clientY: number): { x: number; y: number } | null {
        const el = stageRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
            x: Math.min(MK_X_MAX, Math.max(MK_X_MIN, (clientX - rect.left) / rect.width)),
            y: Math.min(MK_Y_MAX, Math.max(MK_Y_MIN, (clientY - rect.top) / rect.height)),
        };
    }

    function clearDragTimer() {
        const st = dragRef.current;
        if (st) window.clearTimeout(st.timer);
    }

    function handlePtDown(furnitureId: string, e: React.PointerEvent<HTMLButtonElement>) {
        const target = e.currentTarget;
        const { clientX, clientY, pointerId } = e;
        clearDragTimer();
        const st = {
            id: furnitureId, pointerId, target: target as HTMLElement,
            startX: clientX, startY: clientY, timer: 0,
            active: false, committed: null,
        };
        st.timer = window.setTimeout(() => {
            st.active = true;
            suppressClickRef.current = true;
            try { st.target.setPointerCapture(pointerId); } catch { /* ignore */ }
            const p = stagePoint(clientX, clientY);
            if (p) setDrag({ id: furnitureId, ...p });
        }, LONG_PRESS_MS);
        dragRef.current = st;
    }

    function handlePtMove(e: React.PointerEvent<HTMLButtonElement>) {
        const st = dragRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        if (!st.active) {
            // 还没触发长按：移动超过容差就当作普通滑动，取消长按
            if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) > LONG_PRESS_TOLERANCE) {
                clearDragTimer();
                dragRef.current = null;
            }
            return;
        }
        const p = stagePoint(e.clientX, e.clientY);
        if (p) {
            st.committed = p;
            setDrag({ id: st.id, ...p });
        }
    }

    function handlePtUp(e: React.PointerEvent<HTMLButtonElement>) {
        const st = dragRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        clearDragTimer();
        if (st.active) {
            const p = st.committed ?? stagePoint(e.clientX, e.clientY);
            if (p) onMoveMarker(st.id, p);
        }
        dragRef.current = null;
        setDrag(null);
    }

    function handlePtCancel(e: React.PointerEvent<HTMLButtonElement>) {
        const st = dragRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        clearDragTimer();
        dragRef.current = null;
        setDrag(null);
        suppressClickRef.current = false;
    }

    function handleMarkerTap(furnitureId: string) {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        setSheetFurnitureId(furnitureId);
    }

    const sheetFurniture = sheetFurnitureId
        ? (room.furniture || []).find(f => f.id === sheetFurnitureId) ?? null
        : null;

    /** 待确认的操作：重新生成图 / 切换生图开关 */
    const [confirmAction, setConfirmAction] = useState<"regen" | "toggle" | null>(null);

    function handleToggleImage() {
        if (!imageConfigured) {
            setTip("请先在设置中配置并开启图像生成");
            return;
        }
        setConfirmAction("toggle");
    }

    // ── 清单视图 ──
    if (viewMode === "list") {
        return (
            <div className="dw-room">
                <div className="dw2-listbar">
                    <span className="dw2-listbar-title">物品清单<span className="dw2-listbar-en">INVENTORY</span></span>
                    <button className="dw2-listback" onClick={() => setViewMode("stage")}>返回实景</button>
                </div>
                <div className="dw-room-atmosphere"><p>{room.description}</p></div>
                <div className="dw-furniture-grid">
                    {(room.furniture || []).map(f => (
                        <ListFurnitureCard
                            key={f.id}
                            room={room}
                            furniture={f}
                            itemHtmlCache={itemHtmlCache}
                            loadingItemKeys={loadingItemKeys}
                            lastItemError={lastItemError}
                            onExploreItem={onExploreItem}
                            onOpenItem={onOpenItem}
                        />
                    ))}
                </div>
            </div>
        );
    }

    // ── 舞台视图 ──
    return (
        <div className="dw2-stage" ref={stageRef}>
            {/* 氛围底图（生图未就绪时可见） */}
            <div className="dw2-ambient">
                <div className="dw2-l1" /><div className="dw2-l2" /><div className="dw2-l3" />
                <div className="dw2-grain" />
                {!imageUrl && markers.length > 1 && (
                    <svg className="dw2-cst" viewBox="0 0 100 100" preserveAspectRatio="none">
                        {markers.slice(0, -1).map((mk, i) => {
                            const next = markers[i + 1];
                            return (
                                <line key={mk.f.id}
                                    x1={mk.m.x * 100} y1={mk.m.y * 100}
                                    x2={next.m.x * 100} y2={next.m.y * 100}
                                    vectorEffect="non-scaling-stroke" />
                            );
                        })}
                    </svg>
                )}
            </div>

            {/* 生成图 */}
            {imageUrl && imageStatus === "ready" && (
                <img className="dw2-img" src={imageUrl} alt={room.name} draggable={false} />
            )}

            <div className="dw2-scrim-top" />
            <div className="dw2-scrim-bottom" />
            <div className="dw2-wall">DWELLING</div>

            {/* 生成中悬浮条（每个房间独立） */}
            {imageStatus === "generating" && (
                <div className="dw2-genbar">
                    <span className="dw2-genbar-spin" />
                    <span className="dw2-genbar-text">房间生成中…</span>
                    <button className="dw2-genbar-stop" onClick={onCancelImage}>停止</button>
                </div>
            )}
            {/* 状态徽标 */}
            {imageStatus === "failed" && (
                <button className="dw2-badge" data-kind="fail" onClick={onRetryImage} title={imageError ?? undefined}>
                    {imageError === DWELLING_IMAGE_CANCELED_ERROR ? "已停止 · 点击生成" : "生成失败 · 重试"}
                </button>
            )}
            {imageStatus === "ambient" && !imageUrl && <div className="dw2-badge" data-kind="amb">AMBIENT</div>}

            {/* 家具标注（长按可拖动微调位置） */}
            {markers.map(({ f, m, h, len }) => {
                const isDragging = drag?.id === f.id;
                const x = isDragging ? drag.x : m.x;
                const y = isDragging ? drag.y : m.y;
                return (
                    <div key={f.id} className="dw2-mk" data-h={h} data-drag={isDragging ? "true" : undefined}
                        style={{ left: `${x * 100}%`, top: `${y * 100}%`, "--mklen": `${len}px` } as React.CSSProperties}>
                        <button className="dw2-pt" aria-label={f.label}
                            onClick={() => handleMarkerTap(f.id)}
                            onPointerDown={e => handlePtDown(f.id, e)}
                            onPointerMove={handlePtMove}
                            onPointerUp={handlePtUp}
                            onPointerCancel={handlePtCancel}
                            onContextMenu={e => e.preventDefault()} />
                        <span className="dw2-hln" />
                        <span className="dw2-lbl" onClick={() => handleMarkerTap(f.id)}>
                            <span className="dw2-zh">{f.label}<i>{String(f.items.length).padStart(2, "0")}</i></span>
                            {f.en && <span className="dw2-en">{f.en}</span>}
                        </span>
                    </div>
                );
            })}

            {/* 底部：氛围引言 + 元信息 */}
            <div className="dw2-bottom">
                <div className="dw2-qline">
                    <span className="dw2-qbar" />
                    <p className="dw2-quote">{room.description}</p>
                </div>
                <div className="dw2-meta">
                    <span className="dw2-time">{formatStageTime()}</span>
                    <span className="dw2-ops">
                        {imageEnabled && imageConfigured && imageStatus === "ready" && (
                            <button className="dw2-op" onClick={() => setConfirmAction("regen")} title="重新生成房间图">↻</button>
                        )}
                        <button className="dw2-op" data-on={imageEnabled && imageConfigured ? "true" : undefined}
                            onClick={handleToggleImage} title={imageEnabled ? "关闭生图" : "开启生图"}>✦</button>
                    </span>
                </div>
            </div>

            {tip && <div className="dw2-tip">{tip}</div>}

            {/* 重新生成 / 开关生图确认弹窗 */}
            {confirmAction && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setConfirmAction(null)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">
                            {confirmAction === "regen" ? "重新生成房间图" : imageEnabled ? "关闭生图" : "开启生图"}
                        </div>
                        <div className="dw-confirm-msg">
                            {confirmAction === "regen"
                                ? `将为「${room.name}」重新生成一张房间图\n并替换当前图片`
                                : imageEnabled
                                    ? "关闭后房间将显示氛围底图\n已生成的图片会保留"
                                    : "开启后会自动为没有图的房间生成图片"}
                        </div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setConfirmAction(null)}>取消</button>
                            <button className="dw-confirm-btn" onClick={() => {
                                const action = confirmAction;
                                setConfirmAction(null);
                                if (action === "regen") onRetryImage();
                                else onToggleImage();
                            }}>确认</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 家具底部弹窗 */}
            {sheetFurniture && (
                <div className="dw2-sheet-overlay">
                    <div className="dw2-dim" onClick={() => { setSheetFurnitureId(null); setExpandedItemId(null); }} />
                    <div className="dw2-sheet" role="dialog" aria-modal="true" aria-label={sheetFurniture.label}>
                        <div className="dw2-grab" />
                        <div className="dw2-sh">
                            <span className="dw2-sh-zh">{sheetFurniture.label}<i>{String(sheetFurniture.items.length).padStart(2, "0")}</i></span>
                            {sheetFurniture.en && <span className="dw2-sh-en">{sheetFurniture.en}</span>}
                            <span className="dw2-sh-cnt">{sheetFurniture.items.length} 件物品</span>
                        </div>
                        <div className="dw2-shline" />
                        {sheetFurniture.items.map((item, idx) => {
                            const key = ikey(room.id, item.id);
                            const html = itemHtmlCache[key];
                            const isLoading = loadingItemKeys.has(key);
                            const isOpen = expandedItemId === item.id;
                            return (
                                <div key={item.id}>
                                    <button className="dw2-srow"
                                        onClick={() => {
                                            if (html) { onOpenItem(sheetFurniture, item, html); return; }
                                            setExpandedItemId(isOpen ? null : item.id);
                                        }}>
                                        <span className="dw2-sno">{String(idx + 1).padStart(2, "0")}</span>
                                        <span className="dw2-stx">
                                            <span className="dw2-sname">{item.name}{html && <em className="dw2-sdone">已探索</em>}</span>
                                            <span className="dw2-sprev">{item.preview}</span>
                                        </span>
                                        <span className="dw2-sgo">{html ? "›" : isOpen ? "▾" : "›"}</span>
                                    </button>
                                    {isOpen && !html && (
                                        <div className="dw2-sexpand">
                                            {isLoading ? (
                                                <div className="dw2-sload">
                                                    <span className="dwelling-spinner" style={{ width: 13, height: 13, borderWidth: 1.5 }} />
                                                    <span>正在探索…</span>
                                                </div>
                                            ) : (
                                                <>
                                                    <button className="dw2-cta" onClick={() => onExploreItem(sheetFurniture, item)}>
                                                        开 始 探 索
                                                        <span className="dw2-cta-en">EXPLORE</span>
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── 清单视图的家具卡（沿用旧交互） ──

type ListFurnitureCardProps = {
    room: DwellingRoom;
    furniture: DwellingFurniture;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
    onExploreItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem) => void;
    onOpenItem: (furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) => void;
};

function ListFurnitureCard({ room, furniture, itemHtmlCache, loadingItemKeys, lastItemError, onExploreItem, onOpenItem }: ListFurnitureCardProps) {
    const [collapsed, setCollapsed] = useState(false);
    const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
    const isExpanded = !collapsed;

    return (
        <div className="dw-fur-card" data-expanded={isExpanded ? "true" : undefined}>
            <button className="dw-fur-header" onClick={() => setCollapsed(c => !c)}>
                <span className="dw-fur-label">{furniture.label}</span>
                <span className="dw-fur-count">{furniture.items.length}</span>
                <span className="dw-fur-chevron">{isExpanded ? "▾" : "▸"}</span>
            </button>
            {isExpanded && (
                <div className="dw-fur-items">
                    {furniture.items.map(item => {
                        const key = ikey(room.id, item.id);
                        const html = itemHtmlCache[key];
                        const isLoading = loadingItemKeys.has(key);
                        const isOpen = expandedItemId === item.id;
                        return (
                            <div key={item.id}>
                                <button className="dw-item-row" onClick={() => {
                                    if (html) { onOpenItem(furniture, item, html); return; }
                                    setExpandedItemId(isOpen ? null : item.id);
                                }}>
                                    <span className="dw-item-dot" />
                                    <div className="dw-item-text">
                                        <span className="dw-item-name">{item.name}</span>
                                        <span className="dw-item-preview">{item.preview}</span>
                                    </div>
                                    <span className="dw-item-go">{html ? "›" : isOpen ? "▾" : "›"}</span>
                                </button>
                                {isOpen && !html && (
                                    <div className="dw-item-expand">
                                        {isLoading ? (
                                            <div className="dw-explore-loading">
                                                <span className="dwelling-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                                <span>正在探索…</span>
                                            </div>
                                        ) : (
                                            <>
                                                {lastItemError && <div className="dwelling-error" style={{ margin: "4px 0 8px" }}>{lastItemError}</div>}
                                                <button className="dw-explore-btn" onClick={() => onExploreItem(furniture, item)}>
                                                    <Wand2 size={14} />
                                                    开始探索
                                                </button>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
