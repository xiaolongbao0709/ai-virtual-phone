"use client";

// 「收起键盘 = 自动触发回复」，带防抖窗口。
//
// 行为：用户收起键盘（或关掉表情/加号面板）后开始等 N 秒；
// N 秒内重新拉起键盘、点回输入框、打开表情面板，都会取消本次触发；
// N 秒安静过去，才替用户按下「触发回复」按钮。
//
// 实现上就是一个定时器：收起时 setTimeout(fire, N)，用户有动作就 clearTimeout。
// 所有业务判断（发过消息没被回、是否在生成等）都放在 fire 那一刻做，
// 所以收起信号可以「宁多勿漏」——误报会被 fire 时的体检拦下，不会误发。
//
// 收起检测（浏览器没有键盘事件，只能推断）走三条互补路径：
// 1. 输入框失焦：触屏环境（或键盘确认弹起过）直接视为收起信号。
//    iOS 有若干收键盘路径不发 visualViewport resize（见 use-call-keyboard-offset），
//    纯事件驱动会漏；blur 是这些路径里最可靠的伴随信号。
// 2. 视口高度：聚焦/键盘弹起期间主动轮询（不单赌 resize 事件），
//    高度恢复即收起。覆盖「键盘收起按钮」这种藏键盘不 blur 的路径。
// 3. 键盘经由路径 2 收起但焦点仍在输入框时，fire 不再因「焦点在输入框」
//    一票否决，改按键盘 inset 实测判断——inset 为零说明键盘确实没了。
//
// 零侵入约定：所有判定都在这个文件里，聊天室只需一次调用；
// 关掉配置开关后行为与原版完全一致。

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { loadChatMessages } from "@/lib/chat-storage";
import { getKeyboardAutoSendDebounceMs, isKeyboardAutoSendEnabled } from "@/lib/keyboard-auto-send-config";

const KEYBOARD_INSET_THRESHOLD = 80;
const KEYBOARD_HEIGHT_CHANGE_THRESHOLD = 48;
// 旋屏/分屏这类宽度突变会连带高度巨变，不能当成键盘开合
const LAYOUT_WIDTH_CHANGE_THRESHOLD = 80;
const VIEWPORT_POLL_MS = 200;
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

const currentKeyboardInset = () => {
    const viewport = window.visualViewport;
    return Math.max(0, viewport ? window.innerHeight - viewport.height - viewport.offsetTop : 0);
};

export function useKeyboardDismissAutoSend(
    rootRef: RefObject<HTMLElement | null>,
    options: KeyboardDismissAutoSendOptions,
): void {
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const waitTimerRef = useRef(0);
    // 本次防抖窗口是「键盘藏了但焦点没离开输入框」的收起（iPad 收起箭头等）
    const collapseKeptFocusRef = useRef(false);

    /** 取消当前防抖窗口（如果有）。 */
    const cancelWait = useCallback(() => {
        if (waitTimerRef.current) {
            window.clearTimeout(waitTimerRef.current);
            waitTimerRef.current = 0;
        }
    }, []);

    /**
     * 最后一条非 system 消息必须是 user，否则「什么都没发也收键盘」会误触发。
     * 例外：系统指令虽以 system 角色落库，但它就是用户刚发出的、在等回应的动作。
     */
    const hasUnrepliedUserMessage = useCallback((sessionId: string) => {
        const msgs = loadChatMessages(sessionId);
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
            const msg = msgs[i];
            if (msg.role === "system") {
                if (msg.mediaType === "system_instruction") return true;
                continue;
            }
            return msg.role === "user";
        }
        return false;
    }, []);

    /** 防抖窗口结束：触发前把现场完整查一遍，任何一条不满足都放弃。 */
    const fire = useCallback(() => {
        waitTimerRef.current = 0;
        const keptFocus = collapseKeptFocusRef.current;
        collapseKeptFocusRef.current = false;
        const cur = optionsRef.current;
        if (!cur.active || !cur.pending || cur.generating || cur.panelOpen) return;
        if (!isKeyboardAutoSendEnabled(cur.sessionId)) return;
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.matches(INPUT_SELECTOR)) {
            // 焦点还在输入框：通常表示用户还要接着说。
            // 唯一放行的情况是「键盘已实测收起、焦点留在原地」的收起路径（收起按钮不 blur）。
            if (!keptFocus) return;
            if (currentKeyboardInset() >= KEYBOARD_INSET_THRESHOLD) return;
        }
        // 输入框里已有草稿 = 用户还有话没发完
        const draft = rootRef.current?.querySelector<HTMLTextAreaElement>(INPUT_SELECTOR);
        if (draft?.value.trim()) return;
        if (!hasUnrepliedUserMessage(cur.sessionId)) return;
        cur.onTrigger();
    }, [rootRef, hasUnrepliedUserMessage]);

    /** 键盘收起 / 面板关闭 → 开一个 N 秒防抖窗口（重复调用会重置计时）。 */
    const scheduleWait = useCallback((keptFocus = false) => {
        if (!isKeyboardAutoSendEnabled(optionsRef.current.sessionId)) return;
        cancelWait();
        collapseKeptFocusRef.current = keptFocus;
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

    // 键盘开合检测：visualViewport 尺寸 + 输入框焦点推断。
    // 事件（resize/scroll/focus）只当「醒来」信号，判定期间另有主动轮询兜底，
    // 不依赖某一次 resize 是否如约而至。
    useEffect(() => {
        const viewport = window.visualViewport;
        const touchLike = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

        let keyboardWasOpen = false;
        let inputWasFocused = false;
        let stableViewportHeight = viewport?.height ?? window.innerHeight;
        let stableWindowHeight = window.innerHeight;
        let lastInnerWidth = window.innerWidth;
        let frame = 0;
        let pollTimer = 0;

        const chatInputFocused = () => {
            const focused = document.activeElement;
            return focused instanceof HTMLElement
                && focused.matches(INPUT_SELECTOR)
                && Boolean(rootRef.current?.contains(focused));
        };

        const syncPolling = () => {
            const shouldPoll = inputWasFocused || keyboardWasOpen;
            if (shouldPoll && !pollTimer) {
                pollTimer = window.setInterval(() => measure(), VIEWPORT_POLL_MS);
            } else if (!shouldPoll && pollTimer) {
                window.clearInterval(pollTimer);
                pollTimer = 0;
            }
        };

        const measure = () => {
            frame = 0;
            const viewportHeight = viewport?.height ?? window.innerHeight;
            // 宽度突变 = 旋屏/分屏/窗口缩放，这一拍只重采基线，不判定开合
            if (Math.abs(window.innerWidth - lastInnerWidth) >= LAYOUT_WIDTH_CHANGE_THRESHOLD) {
                lastInnerWidth = window.innerWidth;
                stableViewportHeight = viewportHeight;
                stableWindowHeight = window.innerHeight;
                return;
            }
            // 视口长高只可能是键盘收起/浏览器工具栏收缩——基线随之抬高，
            // 自愈「进聊天室时键盘已经开着、基线采成矮值」的失准
            if (viewportHeight > stableViewportHeight) stableViewportHeight = viewportHeight;
            if (window.innerHeight > stableWindowHeight) stableWindowHeight = window.innerHeight;

            const keyboardOpen = inputWasFocused && (
                currentKeyboardInset() >= KEYBOARD_INSET_THRESHOLD
                || stableViewportHeight - viewportHeight >= KEYBOARD_HEIGHT_CHANGE_THRESHOLD
                || stableWindowHeight - window.innerHeight >= KEYBOARD_HEIGHT_CHANGE_THRESHOLD
            );
            if (keyboardOpen) {
                // iOS 的 focusout 可能早于最后一次 visualViewport resize，
                // 焦点单独维护，关闭事件才不会丢。
                if (inputWasFocused || chatInputFocused()) keyboardWasOpen = true;
                cancelWait(); // 键盘（重新）弹起 → 上一个防抖窗口作废
                syncPolling();
                return;
            }
            if (!keyboardWasOpen) { syncPolling(); return; } // 没开过就不算「收起」
            keyboardWasOpen = false;
            inputWasFocused = false;
            stableViewportHeight = viewportHeight; // 重新采基线，否则下一轮判断用的是旧值
            stableWindowHeight = window.innerHeight;
            syncPolling();
            // 焦点若还留在输入框（键盘收起按钮路径），记下来让 fire 按 inset 实测放行
            scheduleWait(chatInputFocused());
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
                syncPolling();
            } else if (!keyboardWasOpen) {
                inputWasFocused = false;
                stableViewportHeight = viewport?.height ?? window.innerHeight;
                stableWindowHeight = window.innerHeight;
                syncPolling();
            }
            requestMeasure();
        };
        const handleFocusOut = (event: FocusEvent) => {
            const target = event.target;
            const related = event.relatedTarget;
            const fromOurInput = target instanceof HTMLElement
                && target.matches(INPUT_SELECTOR)
                && Boolean(rootRef.current?.contains(target));
            const toInput = related instanceof HTMLElement && related.matches(INPUT_SELECTOR);
            // 失焦即收起信号：触屏上键盘跟随焦点，blur 之后键盘不可能还留着。
            // iOS 部分收起路径不发 resize，等视口事件会漏，这里直接开防抖窗口；
            // 判断失准（其实没收起）也会在 fire 时被「焦点回到输入框」等体检拦下。
            if (fromOurInput && !toInput && (keyboardWasOpen || touchLike)) {
                keyboardWasOpen = false;
                inputWasFocused = false;
                stableViewportHeight = viewport?.height ?? window.innerHeight;
                stableWindowHeight = window.innerHeight;
                syncPolling();
                scheduleWait();
                return;
            }
            requestMeasure();
        };

        viewport?.addEventListener("resize", requestMeasure);
        viewport?.addEventListener("scroll", requestMeasure);
        window.addEventListener("resize", requestMeasure);
        document.addEventListener("focusin", handleFocusIn);
        document.addEventListener("focusout", handleFocusOut);
        requestMeasure();

        return () => {
            if (frame) cancelAnimationFrame(frame);
            if (pollTimer) window.clearInterval(pollTimer);
            viewport?.removeEventListener("resize", requestMeasure);
            viewport?.removeEventListener("scroll", requestMeasure);
            window.removeEventListener("resize", requestMeasure);
            document.removeEventListener("focusin", handleFocusIn);
            document.removeEventListener("focusout", handleFocusOut);
        };
    }, [rootRef, cancelWait, scheduleWait]);
}
