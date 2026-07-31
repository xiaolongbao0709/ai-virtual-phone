"use client";

import { useRef, useState, type ReactNode } from "react";

// ── 微信式左滑操作 ──
// 横向快滑露出操作按钮；竖向滚动、长按拖动等手势不受影响。
// 一个列表共享一个 controller，保证同时只有一行处于展开状态。

const DEFAULT_ACTIONS_WIDTH = 248; // 四个 62px 按钮

interface SwipeGesture {
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    base: number;
    locked: boolean;
    offset: number;
}

export function useSwipeActions(width = DEFAULT_ACTIONS_WIDTH) {
    const [swipingId, setSwipingId] = useState<string | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const gestureRef = useRef<SwipeGesture | null>(null);
    const suppressClickRef = useRef(false);

    const close = () => {
        setOpenId(null);
        setSwipingId(null);
    };

    const getContent = (wrapper: HTMLElement) =>
        wrapper.querySelector(":scope > .ui-swipe-content") as HTMLElement | null;

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string) => {
        suppressClickRef.current = false;
        if (openId && openId !== id) close();
        const base = openId === id ? -width : 0;
        gestureRef.current = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, base, locked: false, offset: base };
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current;
        if (!g || g.pointerId !== e.pointerId) return;
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (!g.locked) {
            // 竖向意图（滚动/长按排序）时放弃左滑；横向超过阈值才锁定
            if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
                gestureRef.current = null;
                return;
            }
            if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
            g.locked = true;
            setSwipingId(g.id);
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        }
        if (e.cancelable) e.preventDefault();
        const content = getContent(e.currentTarget);
        if (!content) return;
        g.offset = Math.min(0, Math.max(-width, g.base + dx));
        content.style.transition = "none";
        content.style.transform = `translateX(${g.offset}px)`;
    };

    const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        const g = gestureRef.current;
        if (!g || g.pointerId !== e.pointerId) return;
        gestureRef.current = null;
        if (!g.locked) return;
        suppressClickRef.current = true;
        const open = g.offset < -width / 2;
        const content = getContent(e.currentTarget);
        if (content) {
            content.style.transition = "transform 0.2s ease";
            content.style.transform = `translateX(${open ? -width : 0}px)`;
        }
        if (open) {
            setOpenId(g.id);
        } else {
            const id = g.id;
            setOpenId(null);
            // 等回弹动画结束再卸载按钮，避免闪烁
            window.setTimeout(() => setSwipingId(cur => (cur === id ? null : cur)), 220);
        }
    };

    // 横滑结束后浏览器可能补发一次 click，交由行内 onClick 消费掉
    const consumeClickSuppression = () => {
        if (!suppressClickRef.current) return false;
        suppressClickRef.current = false;
        return true;
    };

    return {
        width,
        openId,
        swipingId,
        close,
        onPointerDown,
        onPointerMove,
        onPointerEnd,
        consumeClickSuppression,
        isRevealed: (id: string) => swipingId === id || openId === id,
        isOpen: (id: string) => openId === id,
    };
}

export type SwipeActionsController = ReturnType<typeof useSwipeActions>;

export function SwipeActionRow({ controller, id, disabled, actions, onTouchStart, children }: {
    controller: SwipeActionsController;
    id: string;
    disabled?: boolean;
    actions: ReactNode;
    onTouchStart?: (e: React.TouchEvent<HTMLDivElement>) => void;
    children: ReactNode;
}) {
    return (
        <div
            className="ui-swipe-wrap"
            data-swipe-id={id}
            onTouchStart={onTouchStart}
            onPointerDown={disabled ? undefined : (e) => controller.onPointerDown(e, id)}
            onPointerMove={disabled ? undefined : controller.onPointerMove}
            onPointerUp={disabled ? undefined : controller.onPointerEnd}
            onPointerCancel={disabled ? undefined : controller.onPointerEnd}
        >
            {controller.isRevealed(id) && <div className="ui-swipe-actions">{actions}</div>}
            <div
                className="ui-swipe-content"
                style={{
                    transform: `translateX(${controller.isOpen(id) ? -controller.width : 0}px)`,
                    transition: "transform 0.2s ease",
                }}
            >
                {children}
            </div>
        </div>
    );
}
