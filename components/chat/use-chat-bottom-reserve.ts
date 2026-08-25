"use client";

import { useLayoutEffect, type RefObject } from "react";
import { isMobileShell } from "@/lib/mobile-shell";

const CHAT_BOTTOM_RESERVE_CSS_VAR = "--chat-bottom-reserve";
const STICK_TO_BOTTOM_THRESHOLD = 120;

function findBottomOverlay(wrapper: HTMLElement): HTMLElement | null {
    for (const child of Array.from(wrapper.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const ui = child.dataset.ui;
        if (ui === "input" || ui === "multi-select") return child;
    }
    return null;
}

export function useChatBottomReserve<TWrapper extends HTMLElement, TScroll extends HTMLElement>(
    wrapperRef: RefObject<TWrapper | null>,
    scrollRef: RefObject<TScroll | null>,
    refreshKey: string,
) {
    useLayoutEffect(() => {
        if (typeof window === "undefined") return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        let frame = 0;
        let bottomScrollFrame = 0;
        let observer: ResizeObserver | null = null;

        const scheduleStickToBottom = () => {
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            bottomScrollFrame = window.requestAnimationFrame(() => {
                bottomScrollFrame = 0;
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
            });
        };

        // Android 设备在 Chrome PWA 下 visualViewport 事件会误触发，导致输入框消失
        // 参考 use-call-keyboard-offset.ts 的处理，Android 只用 ResizeObserver
        let lastHeight = 0;
        let lastViewportHeight = window.visualViewport?.height ?? window.innerHeight;
        
        const measure = () => {
            frame = 0;
            const overlay = findBottomOverlay(wrapper);
            if (!overlay) {
                wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
                lastHeight = 0;
                return;
            }

            const el = scrollRef.current;
            const wasNearBottom = el
                ? el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_THRESHOLD
                : false;
            
            // 计算输入框自身的高度
            const baseHeight = Math.ceil(overlay.getBoundingClientRect().height);
            
            // 计算键盘顶起的高度（通过 visualViewport 和 innerHeight 的差值）
            const viewport = window.visualViewport;
            const viewportHeight = viewport?.height ?? window.innerHeight;
            
            // 核心 Bug 修复：Chrome Android 在点击空白处时，会错误触发 visualViewport.resize
            // 此时 viewportHeight 可能会有 1-2px 的微小抖动，或者完全没变但疯狂触发事件。
            // 我们只在视口高度发生「实质性变化」（> 10px，说明键盘真的在收起/弹出）或者
            // 输入框自身高度变化时，才更新 CSS 变量。
            const viewportChanged = Math.abs(viewportHeight - lastViewportHeight) > 10;
            const heightChanged = baseHeight !== lastHeight;
            
            if (!viewportChanged && !heightChanged && lastHeight > 0) {
                return; // 忽略无效的抖动事件
            }
            
            lastViewportHeight = viewportHeight;
            lastHeight = baseHeight;

            // 键盘高度补偿：如果视口被压缩，计算压缩量
            // 在 PWA 下，这个补偿能解决全面屏手势条导致的底部被遮挡问题
            const keyboardOffset = Math.max(0, window.innerHeight - viewportHeight - (viewport?.offsetTop ?? 0));
            const totalReserve = baseHeight + keyboardOffset;

            if (totalReserve > 0) {
                wrapper.style.setProperty(CHAT_BOTTOM_RESERVE_CSS_VAR, `${totalReserve}px`);
            } else {
                wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
            }

            if (wasNearBottom) scheduleStickToBottom();
        };

        let debounceTimer = 0;
        const requestMeasure = (e?: Event) => {
            // 如果是 scroll 事件，不走防抖，保证滚动时贴底顺滑
            if (e?.type === "scroll") {
                if (frame) window.cancelAnimationFrame(frame);
                frame = window.requestAnimationFrame(measure);
                return;
            }
            
            if (debounceTimer) window.clearTimeout(debounceTimer);
            debounceTimer = window.setTimeout(() => {
                debounceTimer = 0;
                if (frame) window.cancelAnimationFrame(frame);
                frame = window.requestAnimationFrame(measure);
            }, 32); // 32ms 防抖，足以过滤掉 Chrome 点击时的连续假事件
        };

        const overlay = findBottomOverlay(wrapper);
        if (overlay && typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(requestMeasure);
            observer.observe(overlay);
        }

        measure();
        window.addEventListener("resize", requestMeasure);
        window.visualViewport?.addEventListener("resize", requestMeasure);
        window.visualViewport?.addEventListener("scroll", requestMeasure);

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            if (debounceTimer) window.clearTimeout(debounceTimer);
            observer?.disconnect();
            window.removeEventListener("resize", requestMeasure);
            window.visualViewport?.removeEventListener("resize", requestMeasure);
            window.visualViewport?.removeEventListener("scroll", requestMeasure);
        };
    }, [wrapperRef, scrollRef, refreshKey]);
}
