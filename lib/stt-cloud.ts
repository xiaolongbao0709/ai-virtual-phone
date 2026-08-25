// lib/stt-cloud.ts — 云端语音识别（按住说话）
//
// 非 iOS 设备的通话不再依赖浏览器 Web Speech API（国内安卓基本不可用，且持续
// 开麦会把整页音频会话钉在通话模式）。改为微信式按住说话：按住用 MediaRecorder
// 录一段音，松手后发给 OpenAI 兼容的 /audio/transcriptions 转文字。麦克风只在
// 按住的几秒内打开，松手立刻释放，不再有音频会话残留问题。
// iOS 保持原有 Web Speech 免提方案（见 tts-service.ts 的会话说明）。

import { loadBindingConfig, loadVoiceConfigs, resolveBinding } from "./settings-storage";
import type { VoiceApiConfig } from "./settings-types";

export type CloudSttConfig = {
    baseUrl: string;
    apiKey: string;
    model: string;
};

const DEFAULT_STT_MODEL = "whisper-1";
const TRANSCRIBE_TIMEOUT_MS = 60_000;
// 录音兜底上限：忘记松手/指针事件丢失时自动停，避免无限占用麦克风
const MAX_RECORDING_MS = 60_000;

function toCloudSttConfig(config: VoiceApiConfig | undefined | null): CloudSttConfig | null {
    if (!config || config.provider !== "OpenAI") return null;
    if (!config.apiKey?.trim()) return null;
    if (config.enableSTT === false) return null;
    return {
        baseUrl: (config.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, ""),
        apiKey: config.apiKey.trim(),
        model: config.sttModel?.trim() || DEFAULT_STT_MODEL,
    };
}

/**
 * 解析可用的云端识别配置：优先角色绑定的语音配置（须为 OpenAI 兼容且启用 STT），
 * 否则取第一个满足条件的语音配置。没有则返回 null（通话回落到旧输入方式）。
 */
export function resolveCloudSttConfig(characterId?: string): CloudSttConfig | null {
    const configs = loadVoiceConfigs();
    if (characterId) {
        const bindings = loadBindingConfig();
        const slot = resolveBinding(bindings, characterId, "chat");
        const bound = configs.find(c => c.id === slot.voiceConfigId);
        const fromBound = toCloudSttConfig(bound);
        if (fromBound) return fromBound;
    }
    for (const config of configs) {
        const cloud = toCloudSttConfig(config);
        if (cloud) return cloud;
    }
    return null;
}

export function isCallRecordingSupported(): boolean {
    return typeof navigator !== "undefined"
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== "undefined";
}

export type ActiveCallRecording = {
    /** 松手：停止录音并返回音频（没录到内容返回 null）。 */
    stop: () => Promise<Blob | null>;
    /** 取消：丢弃已录内容，立即释放麦克风。 */
    cancel: () => void;
};

/** 按下开始录音。resolve 时麦克风已经在录；权限被拒等失败会 reject。 */
export async function startCallRecording(): Promise<ActiveCallRecording> {
    if (!isCallRecordingSupported()) throw new Error("当前环境不支持录音");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error("麦克风权限被拒绝或不可用");
    });

    // 优先 opus：体积小、转写接口普遍支持
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
    const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
        : new MediaRecorder(stream);

    const chunks: Blob[] = [];
    let finished = false;
    let cancelled = false;
    let resolveStop: ((blob: Blob | null) => void) | null = null;

    const releaseMic = () => {
        try { stream.getTracks().forEach(track => track.stop()); } catch { /* ignore */ }
    };

    recorder.ondataavailable = event => {
        if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        if (cancelled) { resolveStop?.(null); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        resolveStop?.(blob.size > 0 ? blob : null);
    };
    recorder.onerror = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(maxTimer);
        releaseMic();
        resolveStop?.(null);
    };

    const maxTimer = window.setTimeout(() => {
        try { recorder.stop(); } catch { /* ignore */ }
    }, MAX_RECORDING_MS);

    recorder.start();

    return {
        stop: () => new Promise<Blob | null>(resolve => {
            resolveStop = resolve;
            if (finished) { resolve(null); return; }
            try { recorder.stop(); } catch { recorder.onstop?.(new Event("stop") as never); }
        }),
        cancel: () => {
            cancelled = true;
            if (finished) return;
            try { recorder.stop(); } catch {
                finished = true;
                window.clearTimeout(maxTimer);
                releaseMic();
            }
        },
    };
}

/** 调 OpenAI 兼容 /audio/transcriptions 把录音转文字。 */
export async function transcribeAudioBlob(blob: Blob, config: CloudSttConfig): Promise<string> {
    const type = (blob.type || "").toLowerCase();
    const ext = type.includes("mp4") ? "mp4"
        : type.includes("ogg") ? "ogg"
        : type.includes("wav") ? "wav"
        : "webm";
    const form = new FormData();
    form.set("model", config.model);
    form.set("file", blob, `speech.${ext}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
        const res = await fetch(`${config.baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}` },
            body: form,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`语音识别 API 错误 ${res.status}: ${text.slice(0, 200)}`);
        }
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("json")) {
            const data = await res.json() as { text?: unknown };
            return typeof data.text === "string" ? data.text.trim() : "";
        }
        // response_format=text 风格的中转直接回纯文本
        return (await res.text()).trim();
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音识别超时（超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
