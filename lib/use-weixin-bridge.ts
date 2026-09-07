// lib/use-weixin-bridge.ts
// React hook：管理所有 WeChat Bot 的轮询生命周期 + 后台保活。

import { useEffect, useRef, useState, useCallback } from "react";
import { loadWeixinBots, loadKeepAlive, type WeixinBotConfig } from "./weixin-storage";
import { isAudioQualityOptimizationEnabled } from "./settings-storage";
import { runBotLoop } from "./weixin-bridge";

export type BotRunStatus = {
    status: "running" | "stopped" | "error";
    message?: string;
};

// ⏸ 临时总开关：暂停微信 Bot 的 getupdates 长轮询，止血 Netlify compute
//（长轮询会全程占用函数时长）。仅停轮询，不影响后台保活（保活是通用功能）。
// 恢复功能：改回 false 重新部署。长期方案=用户电脑本地助手接管轮询。
const WEIXIN_BRIDGE_PAUSED: boolean = true;

// 模块级状态：让设置页面也能读到
const _statusMap = new Map<string, BotRunStatus>();

export function getWeixinBotStatus(id: string): BotRunStatus {
    return _statusMap.get(id) ?? { status: "stopped" };
}

function broadcastStatus() {
    window.dispatchEvent(new CustomEvent("weixin-status-changed"));
}

// ── 保活：Wake Lock + 静音音频 ───────────────────────────────
let _wakeLock: WakeLockSentinel | null = null;
let _keepAliveAudio: HTMLAudioElement | null = null;
let _keepAliveAudioRate: number = 0;

let _keepAliveWanted = false; // 标记：想要保活但还没获得用户手势
let _suspendedForCall = false; // 标记：因语音/视频通话临时暂停了保活

function ensureAudioCreated() {
    const isHd = isAudioQualityOptimizationEnabled();
    const targetRate = isHd ? 48000 : 8000;
    const numChannels = isHd ? 2 : 1;

    if (!_keepAliveAudio) {
        _keepAliveAudio = new Audio();
        _keepAliveAudio.loop = true;
        _keepAliveAudio.volume = 0.01;
    }

    if (_keepAliveAudioRate === targetRate && _keepAliveAudio.src) return;

    _keepAliveAudioRate = targetRate;

    // 生成 1 秒静音 WAV（开启高清优化时为 48kHz 双声道；默认或关闭时为 8kHz 单声道）
    const sampleRate = targetRate;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const samplesPerChannel = sampleRate; // 1 秒
    const dataSize = samplesPerChannel * blockAlign;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);
    // ±1 LSB 微噪声（约 -90dB，不可闻）：纯零波形会被 Chrome 判为"无声页面"，
    // 安卓后台 5 分钟后定时器被强节流（轮询延迟拉到分钟级）；有微小能量的音频
    // 可获得 "playing audio" 豁免。
    const totalSamples = samplesPerChannel * numChannels;
    for (let i = 0; i < totalSamples; i++) {
        view.setInt16(44 + i * 2, i % 2 === 0 ? 1 : -1, true);
    }
    const blob = new Blob([buf], { type: "audio/wav" });
    const oldSrc = _keepAliveAudio.src;
    _keepAliveAudio.src = URL.createObjectURL(blob);
    if (oldSrc) {
        try { URL.revokeObjectURL(oldSrc); } catch {}
    }
}

/** 用户触摸时尝试播放（浏览器要求音频必须在用户手势中启动） */
function onUserGesture() {
    if (!_keepAliveWanted || !_keepAliveAudio) return;
    _keepAliveAudio.play().then(() => {
        // 成功了，移除监听
        document.removeEventListener("touchstart", onUserGesture, true);
        document.removeEventListener("click", onUserGesture, true);
    }).catch(() => {});
}

async function startKeepAlive() {
    _keepAliveWanted = true;

    // Wake Lock
    try {
        if ("wakeLock" in navigator) {
            _wakeLock = await navigator.wakeLock.request("screen");
            _wakeLock.addEventListener("release", () => { _wakeLock = null; });
        }
    } catch {}

    // 准备音频
    ensureAudioCreated();

    // 先尝试直接播放（如果之前已有用户手势则可以成功）
    _keepAliveAudio!.play().catch(() => {
        // 失败了：注册监听，等下一次用户触摸时播放
        document.addEventListener("touchstart", onUserGesture, { capture: true, once: false });
        document.addEventListener("click", onUserGesture, { capture: true, once: false });
    });
}

function stopKeepAlive() {
    _keepAliveWanted = false;
    _suspendedForCall = false;
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    if (_keepAliveAudio) {
        _keepAliveAudio.pause();
        _keepAliveAudio.currentTime = 0;
    }
    document.removeEventListener("touchstart", onUserGesture, true);
    document.removeEventListener("click", onUserGesture, true);
}

/**
 * Pause keep-alive for the duration of a voice/video call. Starting STT grabs
 * the mic and the OS audio focus, which would otherwise interrupt the looping
 * silent audio and leave it dead after the call. The call holds the mic + audio
 * session itself, so keep-alive is redundant meanwhile. No-op if keep-alive is off.
 */
export function suspendKeepAliveForCall() {
    if (!_keepAliveWanted) return;
    _suspendedForCall = true;
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    if (_keepAliveAudio) {
        try { _keepAliveAudio.pause(); } catch {}
    }
    document.removeEventListener("touchstart", onUserGesture, true);
    document.removeEventListener("click", onUserGesture, true);
}

/** Re-arm keep-alive after a call ends, unless the user turned it off meanwhile. */
export function resumeKeepAliveAfterCall() {
    if (!_suspendedForCall) return;
    _suspendedForCall = false;
    if (!_keepAliveWanted) return; // keep-alive was switched off during the call
    void startKeepAlive(); // re-acquires Wake Lock + replays the silent audio
}

export function useWeixinBridge() {
    const [bots, setBots] = useState<WeixinBotConfig[]>([]);
    const abortMap = useRef(new Map<string, AbortController>());

    // 初始加载 + 监听配置变更
    useEffect(() => {
        setBots(loadWeixinBots());
        const handler = () => setBots(loadWeixinBots());
        window.addEventListener("weixin-config-changed", handler);
        return () => window.removeEventListener("weixin-config-changed", handler);
    }, []);

    // 启动 bot（可复用：首次 + 回前台恢复）
    const startBot = useCallback((bot: WeixinBotConfig) => {
        if (WEIXIN_BRIDGE_PAUSED) {
            _statusMap.set(bot.id, { status: "stopped", message: "已暂停（为节省额度临时关闭，稍后恢复）" });
            broadcastStatus();
            return;
        }
        if (abortMap.current.has(bot.id)) return;

        const ctrl = new AbortController();
        abortMap.current.set(bot.id, ctrl);

        _statusMap.set(bot.id, { status: "running" });
        broadcastStatus();

        runBotLoop(
            bot,
            ctrl.signal,
            (status, message) => {
                _statusMap.set(bot.id, { status, message });
                broadcastStatus();
            },
        ).finally(() => {
            abortMap.current.delete(bot.id);
            if (!_statusMap.get(bot.id)?.message) {
                _statusMap.set(bot.id, { status: "stopped" });
                broadcastStatus();
            }
        });
    }, []);

    // 同步轮询 loop
    useEffect(() => {
        const activeBots = bots.filter(b => b.enabled && b.botToken.trim());

        for (const bot of activeBots) startBot(bot);

        // 停止已禁用或已删除的 bot
        for (const [id, ctrl] of abortMap.current) {
            if (!activeBots.find(b => b.id === id)) {
                ctrl.abort();
                _statusMap.set(id, { status: "stopped" });
            }
        }
        broadcastStatus();
    }, [bots, startBot]);

    // 保活管理：只要用户开启保活就启动，不依赖 Bot 是否启用。
    useEffect(() => {
        const shouldKeepAlive = loadKeepAlive();
        if (shouldKeepAlive) {
            startKeepAlive();
        } else {
            stopKeepAlive();
        }

        // 监听保活设置变更
        const onCfg = () => {
            const on = loadKeepAlive();
            if (on) startKeepAlive(); else stopKeepAlive();
        };
        window.addEventListener("weixin-config-changed", onCfg);

        // 监听语音配置变更（高清音频开关切换时动态切换采样率）
        const onVoiceCfg = () => {
            if (loadKeepAlive() && _keepAliveWanted) {
                const wasPlaying = _keepAliveAudio && !_keepAliveAudio.paused;
                ensureAudioCreated();
                if (wasPlaying) {
                    _keepAliveAudio?.play().catch(() => {});
                }
            }
        };
        window.addEventListener("voice-configs-changed", onVoiceCfg);

        return () => {
            window.removeEventListener("weixin-config-changed", onCfg);
            window.removeEventListener("voice-configs-changed", onVoiceCfg);
            stopKeepAlive();
        };
    }, []);

    // 回到前台：恢复被挂起的轮询 + 重新获取 Wake Lock
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState !== "visible") return;

            // 重启所有已停止（非错误）的 bot
            const activeBots = loadWeixinBots().filter(b => b.enabled && b.botToken.trim());
            for (const bot of activeBots) {
                if (!abortMap.current.has(bot.id)) {
                    startBot(bot);
                }
            }

            // Wake Lock 在 visibilitychange 时会自动释放，需重新获取
            if (loadKeepAlive()) {
                startKeepAlive();
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, [startBot]);

    // 卸载时全部停止
    useEffect(() => {
        return () => {
            for (const ctrl of abortMap.current.values()) ctrl.abort();
        };
    }, []);
}
