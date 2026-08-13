// 语音/视频来电振动：来电等待接听期间循环振动，替代铃声（App 全程不出声）。
// 开关在聊天主页「语音/视频来电振动」，默认开。iOS Safari 不支持
// Vibration API，此模块自动降级为 no-op，调用方不用关心平台。

import { loadChatAppSettings } from "@/lib/chat-storage";

// 一轮"嗡—嗡"仿来电节奏；间隔后重复，直到 stop
const PULSE_PATTERN = [500, 250, 500, 1400];
const PULSE_TOTAL = PULSE_PATTERN.reduce((sum, ms) => sum + ms, 0);

export function isCallVibrationEnabled(): boolean {
    return loadChatAppSettings().callVibrationEnabled !== false;
}

function vibrationSupported(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/**
 * 开始来电振动循环，返回停止函数。开关关闭或平台不支持时返回 no-op。
 * 调用方在「等待接听」态启动，接听/挂断/卸载时调用返回的函数停止。
 */
export function startIncomingCallVibration(): () => void {
    if (!vibrationSupported() || !isCallVibrationEnabled()) return () => {};
    try { navigator.vibrate(PULSE_PATTERN); } catch { return () => {}; }
    const timer = window.setInterval(() => {
        try { navigator.vibrate(PULSE_PATTERN); } catch { /* 忽略 */ }
    }, PULSE_TOTAL);
    return () => {
        window.clearInterval(timer);
        try { navigator.vibrate(0); } catch { /* 忽略 */ }
    };
}
