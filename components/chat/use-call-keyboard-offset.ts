"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { isMobileShell } from "@/lib/mobile-shell";

// iOS 收起键盘的部分路径（切后台回来、字典收起、工具栏变化等）不会触发
// visualViewport resize，偏移会永远卡在键盘高度上，整个通话界面停在上移
// 状态、底部露白（实报：语音/视频通话下半屏白屏）。系统键盘跟随输入框
// 焦点，没有聚焦的可编辑元素就不可能有键盘——以此作为确定性兜底。
function hasEditableFocus(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el instanceof HTMLElement && el.isContentEditable;
}

export function useCallKeyboardOffsetStyle(): CSSProperties {
    const [offset, setOffset] = useState(0);

    useEffect(() => {
        if (typeof window === "undefined") return;

        const isAndroidMobile =
            /Android/i.test(navigator.userAgent) && isMobileShell();

        if (isAndroidMobile) {
            setOffset(0);
            return;
        }

        const viewport = window.visualViewport;
        const update = () => {
            if (!viewport || !hasEditableFocus()) {
                setOffset(0);
                return;
            }
            const next = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
            setOffset(next);
        };

        // focus 切换到另一个输入框时 focusout 先于 focusin，延迟分批重算，
        // 校验时若新输入框已聚焦则不会误归零；覆盖键盘收起动画期。
        const timers: number[] = [];
        const scheduleUpdate = () => {
            update();
            for (const delay of [50, 250, 600]) {
                timers.push(window.setTimeout(update, delay));
            }
        };

        update();
        viewport?.addEventListener("resize", update);
        viewport?.addEventListener("scroll", update);
        window.addEventListener("resize", update);
        window.addEventListener("focusin", scheduleUpdate);
        window.addEventListener("focusout", scheduleUpdate);

        return () => {
            for (const timer of timers) window.clearTimeout(timer);
            viewport?.removeEventListener("resize", update);
            viewport?.removeEventListener("scroll", update);
            window.removeEventListener("resize", update);
            window.removeEventListener("focusin", scheduleUpdate);
            window.removeEventListener("focusout", scheduleUpdate);
        };
    }, []);

    return useMemo(() => ({ "--call-keyboard-offset": `${offset}px` } as CSSProperties), [offset]);
}
