"use client";

// 「收起键盘 = 自动触发回复」，带防抖窗口。
//
// 行为：用户收起键盘（或关掉表情/加号面板）后开始等 N 秒；
// N 秒内重新拉起键盘、点回输入框、打开表情面板，都会取消本次触发；
// N 秒安静过去，才替用户按下「触发回复」按钮。
//
// 实现上就是一个定时器：收起时 setTimeout(fire, N)，用户有动作就 clearTimeout。
// 所有业务判断（发过消息没被回、是否在生成等）都放在 fire 那一刻做，
// 所以取消路径漏掉某个边缘情况也只是多等一轮，不会误发。
//
// 零侵入约定：所有判定都在这个文件里，聊天室只需一次调用；
// 关掉配置开关后行为与原版完全一致。

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { loadChatMessages } from "@/lib/chat-storage";
import { getKeyboardAutoSendDebounceMs, isKeyboardAutoSendEnabled } from "@/lib/keyboard-auto-send-config";

const KEYBOARD_INSET_THRESHOLD = 80;
const KEYBOARD_HEIGHT_CHANGE_THRESHOLD = 48;
const INPUT_SELECTOR = ".chat-input-textarea";

interface KeyboardDismissAutoSendOptions {
    /** 当前场景是否允许自动触发（离线模式 / 多选模式下传 false） */
    active: boolean;
    /** 确实发过东西、还没被回复 */
    pending: boolean;
    /** 正在生成 */
    generating: boolean;
    /** 表情/贴纸/加号面板开着 */
    panelOpen: boolean;
    /** 用于「最后一条是不是用户发的」校验 + 按会话防抖时长 */
    sessionId: string;
    onTrigger: () => void;
}

export function useKeyboardDismissAutoSend(
    rootRef: RefObject<HTMLElement | null>,
    options: KeyboardDismissAutoSendOptions,
): void {
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const waitTimerRef = useRef(0);

    /** 取消当前防抖窗口（如果有）。 */
    const cancelWait = useCallback(() => {
        if (waitTimerRef.current) {
            window.clearTimeout(waitTimerRef.current);
            waitTimerRef.current = 0;
        }
    }, []);

    /** 最后一条非 system 消息必须是 user，否则「什么都没发也收键盘」会误触发。 */
    const hasUnrepliedUserMessage = useCallback((sessionId: string) => {
        const msgs = loadChatMessages(sessionId);
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
            if (msgs[i].role === "system") continue;
            return msgs[i].role === "user";
        }
        return false;
    }, []);

    /** 防抖窗口结束：触发前把现场完整查一遍，任何一条不满足都放弃。 */
    const fire = useCallback(() => {
        waitTimerRef.current = 0;
        const cur = optionsRef.current;
        if (!cur.active || !cur.pending || cur.generating || cur.panelOpen) return;
        if (!isKeyboardAutoSendEnabled(cur.sessionId)) return;
        // 焦点又回到输入框 = 用户还要接着说
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.matches(INPUT_SELECTOR)) return;
        // 输入框里已有草稿同理
        const draft = rootRef.current?.querySelector<HTMLTextAreaElement>(INPUT_SELECTOR);
        if (draft?.value.trim()) return;
        if (!hasUnrepliedUserMessage(cur.sessionId)) return;
        cur.onTrigger();
    }, [rootRef, hasUnrepliedUserMessage]);

    /** 键盘收起 / 面板关闭 → 开一个 N 秒防抖窗口（重复调用会重置计时）。 */
    const scheduleWait = useCallback(() => {
        if (!isKeyboardAutoSendEnabled(optionsRef.current.sessionId)) return;
        cancelWait();
        const n = getKeyboardAutoSendDebounceMs(optionsRef.current.sessionId);
        waitTimerRef.current = window.setTimeout(fire, Math.max(0, n));
    }, [cancelWait, fire]);

    // 面板「开 → 关」等价于收起键盘；面板打开则取消等待。
    const prevPanelOpenRef = useRef(false);
    useEffect(() => {
        const wasOpen = prevPanelOpenRef.current;
        prevPanelOpenRef.current = options.panelOpen;
        if (options.panelOpen) { cancelWait(); return; }
        if (wasOpen) scheduleWait();
    }, [options.panelOpen, cancelWait, scheduleWait]);

    // 输入框重新获得焦点 / 有输入 → 用户还要说，取消等待。
    // 用捕获阶段的 document 监听：输入框在子组件里，state 传不进 hook。
    useEffect(() => {
        const isOurInput = (target: EventTarget | null) =>
            target instanceof HTMLElement
            && target.matches(INPUT_SELECTOR)
            && Boolean(rootRef.current?.contains(target));
        const onFocusIn = (event: FocusEvent) => { if (isOurInput(event.target)) cancelWait(); };
        const onInput = (event: Event) => { if (isOurInput(event.target)) cancelWait(); };
        document.addEventListener("focusin", onFocusIn, true);
        document.addEventListener("input", onInput, true);
        return () => {
            document.removeEventListener("focusin", onFocusIn, true);
            document.removeEventListener("input", onInput, true);
        };
    }, [rootRef, cancelWait]);

    // 卸载时清掉定时器
    useEffect(() => () => cancelWait(), [cancelWait]);

    // 键盘开合检测：浏览器没有键盘事件，只能靠 visualViewport 尺寸 + 输入框焦点推断。
    useEffect(() => {
        const viewport = window.visualViewport;

        let keyboardWasOpen = false;
        let inputWasFocused = false;
        let stableViewportHeight = viewport?.height ?? window.innerHeight;
        let stableWindowHeight = window.innerHeight;
        let frame = 0;

        const keyboardInset = () => Math.max(
            0,
            viewport ? window.innerHeight - viewport.height - viewport.offsetTop : 0,
        );
        const chatInputFocused = () => {
            const focused = document.activeElement;
            return focused instanceof HTMLElement
                && focused.matches(INPUT_SELECTOR)
                && Boolean(rootRef.current?.contains(focused));
        };

        const measure = () => {
            frame = 0;
            const viewportHeight = viewport?.height ?? window.innerHeight;
            const keyboardOpen = inputWasFocused && (
                keyboardInset() >= KEYBOARD_INSET_THRESHOLD
                || stableViewportHeight - viewportHeight >= KEYBOARD_HEIGHT_CHANGE_THRESHOLD
                || stableWindowHeight - window.innerHeight >= KEYBOARD_HEIGHT_CHANGE_THRESHOLD
            );
            if (keyboardOpen) {
                // iOS 的 focusout 可能早于最后一次 visualViewport resize，
                // 焦点单独维护，关闭事件才不会丢。
                if (inputWasFocused || chatInputFocused()) keyboardWasOpen = true;
                cancelWait(); // 键盘（重新）弹起 → 上一个防抖窗口作废
                return;
            }
            if (!keyboardWasOpen) return; // 没开过就不算「收起」，旋屏/地址栏收缩不误触发
            keyboardWasOpen = false;
            inputWasFocused = false;
            stableViewportHeight = viewportHeight; // 重新采基线，否则下一轮判断用的是旧值
            stableWindowHeight = window.innerHeight;
            scheduleWait(); // 收起 → 开 N 秒防抖窗口
        };

        const requestMeasure = () => {
            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
        };

        const handleFocusIn = (event: FocusEvent) => {
            const target = event.target;
            if (target instanceof HTMLElement
                && target.matches(INPUT_SELECTOR)
                && Boolean(rootRef.current?.contains(target))) {
                inputWasFocused = true;
                stableViewportHeight = Math.max(stableViewportHeight, viewport?.height ?? window.innerHeight);
                stableWindowHeight = Math.max(stableWindowHeight, window.innerHeight);
            } else if (!keyboardWasOpen) {
                inputWasFocused = false;
                stableViewportHeight = viewport?.height ?? window.innerHeight;
                stableWindowHeight = window.innerHeight;
            }
            requestMeasure();
        };
        const handleFocusOut = () => requestMeasure();

        viewport?.addEventListener("resize", requestMeasure);
        viewport?.addEventListener("scroll", requestMeasure);
        window.addEventListener("resize", requestMeasure);
        document.addEventListener("focusin", handleFocusIn);
        document.addEventListener("focusout", handleFocusOut);
        requestMeasure();

        return () => {
            if (frame) cancelAnimationFrame(frame);
            viewport?.removeEventListener("resize", requestMeasure);
            viewport?.removeEventListener("scroll", requestMeasure);
            window.removeEventListener("resize", requestMeasure);
            document.removeEventListener("focusin", handleFocusIn);
            document.removeEventListener("focusout", handleFocusOut);
        };
    }, [rootRef, cancelWait, scheduleWait]);
}
