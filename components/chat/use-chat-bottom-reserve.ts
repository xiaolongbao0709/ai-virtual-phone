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
        const isAndroidMobile = /Android/i.test(navigator.userAgent) && isMobileShell();

        let lastHeight = 0;
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
            const height = Math.ceil(overlay.getBoundingClientRect().height);

            // 防止 Chrome Android 在点击非输入区域时错误触发 resize 导致输入框消失
            // 如果高度没变化且不为 0，跳过本次更新
            if (height > 0 && height === lastHeight) {
                return;
            }
            lastHeight = height;

            if (height > 0) {
                wrapper.style.setProperty(CHAT_BOTTOM_RESERVE_CSS_VAR, `${height}px`);
            } else {
                wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
            }

            if (wasNearBottom) scheduleStickToBottom();
        };

        const requestMeasure = () => {
            if (frame) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(measure);
        };

        const overlay = findBottomOverlay(wrapper);
        if (overlay && typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(requestMeasure);
            observer.observe(overlay);
        }

        measure();
        window.addEventListener("resize", requestMeasure);
        // Android 设备不监听 visualViewport，避免输入框弹跳问题
        if (!isAndroidMobile) {
            window.visualViewport?.addEventListener("resize", requestMeasure);
            window.visualViewport?.addEventListener("scroll", requestMeasure);
        }

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            observer?.disconnect();
            window.removeEventListener("resize", requestMeasure);
            if (!isAndroidMobile) {
                window.visualViewport?.removeEventListener("resize", requestMeasure);
                window.visualViewport?.removeEventListener("scroll", requestMeasure);
            }
        };
    }, [wrapperRef, scrollRef, refreshKey]);
}
