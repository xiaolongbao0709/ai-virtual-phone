// lib/tts-service.ts — 语音合成服务

import type { VoiceApiConfig, ContentAppId } from "./settings-types";
import { loadVoiceConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { prepareSpeechText } from "./tts-markup";

export type VoiceApiConfigResolved = VoiceApiConfig;

/**
 * Resolve the TTS voice config for a character via the binding cascade.
 * Returns null if no voice config is bound or found.
 */
export function resolveVoiceConfig(characterId: string, appId?: ContentAppId): VoiceApiConfig | null {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, appId ?? "chat");
    if (!slot.voiceConfigId) return null;

    const configs = loadVoiceConfigs();
    return configs.find(c => c.id === slot.voiceConfigId) || null;
}

/**
 * Synthesize speech from text using the given voice config.
 * Returns an audio Blob (mp3/wav) or null if synthesis failed.
 *
 * Supported providers:
 * - Minimax: REST API → hex-encoded mp3
 * - OpenAI: REST API → binary audio blob
 * - FishAudio: 经本站 /api/voice/fish-tts 转发（Fish 不允许浏览器直连）→ mp3
 */
export async function synthesizeSpeech(
    text: string,
    voiceConfig: VoiceApiConfig,
    options?: { emotion?: string },
): Promise<Blob | null> {
    if (!text.trim()) return null;

    const provider = voiceConfig.provider;
    // 〔语气/停顿〕标记 → 各家原生语法（不支持的直接去掉，绝不会被念出来）
    const prepared = prepareSpeechText(text, provider, voiceConfig.model);
    text = prepared.text;
    if (!text.trim()) return null;

    if (provider === "Minimax") {
        return synthesizeMinimax(text, voiceConfig, options?.emotion || prepared.emotion);
    }

    if (provider === "OpenAI") {
        return synthesizeOpenAI(text, voiceConfig);
    }

    if (provider === "FishAudio") {
        return synthesizeFish(text, voiceConfig);
    }

    return null;
}

// A stalled TTS request (TCP connected but no response — cold start, rate-limit
// hold, network blip) would otherwise hang forever, since fetch has no default
// timeout. That froze voice/video calls at "对方正在说话..." until the user
// toggled the mic. Abort after a ceiling so the caller can recover.
const TTS_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TTS_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
            throw new Error(`语音合成超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`);
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

// ── Minimax TTS ─────────────────────────────────────

// MiniMax voice_setting.emotion 官方取值。whisper（低语）也是情绪参数，不是写在文字里的标签——
// 写成 (whisper) 放进文字里会被当成英文单词念出来，下面的 sanitizeMinimaxText 会把它转成这个参数。
const MINIMAX_EMOTIONS = new Set([
    "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "neutral", "fluent", "whisper",
]);

// speech-2.8 官方支持的全部语气词（22 个），只有这些写在文字里不会被念出来
const MINIMAX_SOUND_TAGS = new Set([
    "laughs", "chuckle", "coughs", "clear-throat", "groans", "breath", "pant", "inhale", "exhale", "gasps",
    "sniffs", "sighs", "snorts", "burps", "lip-smacking", "humming", "hissing", "emm", "whistles", "sneezes",
    "crying", "applause",
]);
// 常见写错的词形 → 官方写法
const MINIMAX_SOUND_ALIASES: Record<string, string> = {
    laugh: "laughs", laughing: "laughs", laughter: "laughs", giggle: "chuckle", giggles: "chuckle", chuckles: "chuckle", chuckling: "chuckle",
    cough: "coughs", coughing: "coughs", "clear throat": "clear-throat", "clears throat": "clear-throat", "clearing throat": "clear-throat", "clear-throats": "clear-throat",
    groan: "groans", groaning: "groans", breathe: "breath", breathing: "breath", breaths: "breath", panting: "pant", pants: "pant",
    inhales: "inhale", inhaling: "inhale", exhales: "exhale", exhaling: "exhale", gasp: "gasps", gasping: "gasps",
    sniff: "sniffs", sniffing: "sniffs", sniffle: "sniffs", sniffles: "sniffs", sigh: "sighs", sighing: "sighs",
    snort: "snorts", snorting: "snorts", burp: "burps", "lip smacking": "lip-smacking", hum: "humming", hums: "humming",
    hiss: "hissing", um: "emm", umm: "emm", hmm: "emm", uh: "emm", em: "emm", whistle: "whistles", whistling: "whistles",
    sneeze: "sneezes", sneezing: "sneezes", cry: "crying", cries: "crying", sob: "crying", sobs: "crying", sobbing: "crying",
    clap: "applause", clapping: "applause", yawn: "exhale", yawns: "exhale", yawning: "exhale",
};
// 写在括号里的情绪/语气词 → 情绪参数
const MINIMAX_EMOTION_ALIASES: Record<string, string> = {
    whisper: "whisper", whispers: "whisper", whispering: "whisper", softly: "whisper", quietly: "whisper", murmur: "whisper", murmuring: "whisper",
    happy: "happy", excited: "happy", joyful: "happy", cheerful: "happy", sad: "sad", upset: "sad", sorrowful: "sad",
    angry: "angry", mad: "angry", furious: "angry", fearful: "fearful", scared: "fearful", afraid: "fearful", nervous: "fearful",
    disgusted: "disgusted", surprised: "surprised", shocked: "surprised", calm: "calm", gently: "calm", gentle: "calm",
    neutral: "neutral", fluent: "fluent",
};

/**
 * Minimax 合成前清洗文字：
 * - 官方 22 个语气词（仅 2.8 模型）保留；写错的词形自动改成官方写法
 * - (whisper)(happy) 这类情绪词不是文字标签：转成 voice_setting.emotion，并从文字里去掉
 * - 其它英文括号、中文括号动作（如（笑）(温柔)）全部去掉，避免被念出来
 * - <#秒#> 停顿保留，但去掉开头/结尾/连续的停顿（官方要求）
 */
export function sanitizeMinimaxText(text: string, model?: string): { text: string; emotion?: string } {
    const allowSounds = String(model || "").toLowerCase().includes("2.8");
    let emotion: string | undefined;
    let out = text.replace(/[(（]\s*([^()（）\r\n]{1,32}?)\s*[)）]/g, (whole, inner: string) => {
        const key = inner.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
        if (/^[a-z][a-z \-]*$/.test(key)) {
            const sound = MINIMAX_SOUND_TAGS.has(key) ? key : MINIMAX_SOUND_ALIASES[key];
            if (sound) return allowSounds ? `(${sound})` : "";
            const emo = MINIMAX_EMOTION_ALIASES[key];
            if (emo) { if (!emotion) emotion = emo; return ""; }
            return "";
        }
        // 中文/其它括号：短的当作动作或语气描写去掉；长的（像正常括号说明）保留文字、去掉括号
        if (inner.length <= 12) return "";
        return inner;
    });
    // 停顿：合并连续停顿、去掉首尾停顿
    out = out.replace(/(?:<#\s*[\d.]+\s*#>\s*){2,}/g, (m) => {
        const total = [...m.matchAll(/<#\s*([\d.]+)\s*#>/g)].reduce((a, x) => a + Number(x[1] || 0), 0);
        return `<#${Math.min(99.99, Math.max(0.01, total)).toFixed(2).replace(/\.?0+$/, "")}#>`;
    });
    out = out.replace(/^\s*(?:<#\s*[\d.]+\s*#>\s*)+/, "").replace(/(?:\s*<#\s*[\d.]+\s*#>)+\s*$/, "");
    out = out.replace(/[ \t\u3000]{2,}/g, " ").trim();
    return { text: out, emotion };
}

const MINIMAX_SPEED_MIN = 0.5;
const MINIMAX_SPEED_MAX = 2.0;
const MINIMAX_PITCH_MIN = -12;
const MINIMAX_PITCH_MAX = 12;

function normalizeMinimaxSpeed(speed: number | undefined): number {
    if (typeof speed !== "number" || !Number.isFinite(speed)) return 1.0;
    return Math.min(MINIMAX_SPEED_MAX, Math.max(MINIMAX_SPEED_MIN, speed));
}

function normalizeMinimaxPitch(pitch: number | undefined): number {
    if (typeof pitch !== "number" || !Number.isFinite(pitch)) return 0;
    return Math.min(MINIMAX_PITCH_MAX, Math.max(MINIMAX_PITCH_MIN, Math.round(pitch)));
}

async function synthesizeMinimax(text: string, config: VoiceApiConfig, emotion?: string): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("Minimax API Key 未配置");
    const cleaned = sanitizeMinimaxText(text, config.model);
    text = cleaned.text;
    if (!text) return null;
    emotion = emotion || cleaned.emotion;

    const baseUrl = (config.baseUrl || "https://api.minimaxi.com/v1").replace(/\/$/, "");
    const voiceSetting: Record<string, unknown> = {
        voice_id: config.defaultVoice || "male-qn-qingse",
        speed: normalizeMinimaxSpeed(config.speechSpeed),
        vol: 1.0,
        pitch: normalizeMinimaxPitch(config.speechPitch),
    };
    const normalizedEmotion = emotion?.trim().toLowerCase();
    const modelId = String(config.model || "").toLowerCase();
    // whisper / fluent 只有 speech-2.6、2.8 系列支持，老模型传了会报错，直接不传
    const newEmotionOk = modelId.includes("2.6") || modelId.includes("2.8");
    if (normalizedEmotion && MINIMAX_EMOTIONS.has(normalizedEmotion)
        && (newEmotionOk || (normalizedEmotion !== "whisper" && normalizedEmotion !== "fluent"))) {
        voiceSetting.emotion = normalizedEmotion;
    }

    const response = await fetchWithTimeout(`${baseUrl}/t2a_v2`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "speech-01-turbo",
            text,
            stream: false,
            ...(config.languageBoost ? { language_boost: config.languageBoost } : {}),
            voice_setting: voiceSetting,
            // 44100/256k 是 Minimax 支持的最高档;之前 32000/128k 会把 hd 模型
            // 的输出压闷(用户反馈"声音糊"),各模型均支持该档位。
            audio_setting: {
                sample_rate: 44100,
                bitrate: 256000,
                format: "mp3",
                channel: 1,
            },
        }),
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.base_resp?.status_msg || `Minimax API 请求失败 (${response.status})`);
    }

    const data = await response.json();
    if (data.data?.audio) {
        const hexString: string = data.data.audio;
        const bytes = new Uint8Array(hexString.length / 2);
        for (let i = 0; i < hexString.length; i += 2) {
            bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
        }
        return new Blob([bytes], { type: "audio/mpeg" });
    }

    throw new Error(data.base_resp?.status_msg || "Minimax 未返回音频数据");
}

// ── OpenAI TTS ──────────────────────────────────────

async function synthesizeOpenAI(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("OpenAI API Key 未配置");

    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: config.model || "tts-1",
            input: text,
            voice: config.defaultVoice || "alloy",
            response_format: "mp3",
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`OpenAI TTS 请求失败 (${response.status}): ${errText}`);
    }

    const blob = await response.blob();
    return new Blob([await blob.arrayBuffer()], { type: "audio/mpeg" });
}

// ── Fish Audio TTS ──────────────────────────────────

/** 从 Fish Audio 音色页链接（如 https://fish.audio/zh-CN/m/<id>/）或纯 ID 里取出 Voice ID */
export function extractFishVoiceId(value: string | undefined): string {
    const raw = String(value || "").trim();
    const m = raw.match(/[0-9a-f]{32}/i);
    return m ? m[0].toLowerCase() : raw;
}

// Fish 官方接口只有语速和音量，没有音调参数。音调在手机本地实现：
//   1) 请求 Fish 时把语速除以变调倍率（Fish 的变速不改音高）；
//   2) 拿到音频后按倍率重采样（音高和速度一起变），
// 两步抵消，最终语速不变、只有音高改变。失败时退回原声，不影响播放。
const FISH_PITCH_MIN = -12;
const FISH_PITCH_MAX = 12;

function normalizeFishPitch(pitch: number | undefined): number {
    if (typeof pitch !== "number" || !Number.isFinite(pitch)) return 0;
    return Math.min(FISH_PITCH_MAX, Math.max(FISH_PITCH_MIN, Math.round(pitch)));
}

async function synthesizeFish(text: string, config: VoiceApiConfig): Promise<Blob | null> {
    if (!config.apiKey) throw new Error("Fish Audio API Key 未配置");
    const userSpeed = typeof config.speechSpeed === "number" && Number.isFinite(config.speechSpeed)
        ? Math.min(2, Math.max(0.5, config.speechSpeed))
        : 1;
    const pitch = normalizeFishPitch(config.speechPitch);
    const ratio = pitch ? Math.pow(2, pitch / 12) : 1;
    const requestSpeed = Math.min(2, Math.max(0.5, userSpeed / ratio));
    const response = await fetchWithTimeout("/api/voice/fish-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            apiKey: config.apiKey,
            text,
            model: config.model || "s2.1-pro",
            referenceId: extractFishVoiceId(config.defaultVoice),
            ...(requestSpeed !== 1 ? { speed: Number(requestSpeed.toFixed(3)) } : {}),
        }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err && (err.error || err.message)) || `Fish Audio 请求失败 (${response.status})`);
    }
    const buf = await response.arrayBuffer();
    if (!buf.byteLength) throw new Error("Fish Audio 未返回音频数据");
    if (pitch) {
        const shifted = await shiftPitchLocally(buf, ratio).catch(() => null);
        if (shifted) return shifted;
        // 本地变调失败（极老的浏览器）：退回原声，但把语速还原成用户设置
        if (requestSpeed !== userSpeed) return synthesizeFish(text, { ...config, speechPitch: 0 });
    }
    return new Blob([buf], { type: "audio/mpeg" });
}

/** 重采样变调：音高 × ratio，时长 ÷ ratio。输出 24kHz 单声道 WAV（人声足够清晰，体积可控） */
async function shiftPitchLocally(mp3: ArrayBuffer, ratio: number): Promise<Blob | null> {
    if (typeof window === "undefined") return null;
    const w = window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
    const OAC = w.OfflineAudioContext || w.webkitOfflineAudioContext;
    if (!OAC) return null;
    const OUT_RATE = 24000;
    const decoder = new OAC(1, 1, OUT_RATE);
    const decoded: AudioBuffer = await new Promise((resolve, reject) => {
        const p = decoder.decodeAudioData(mp3.slice(0), resolve, reject);
        if (p && typeof (p as Promise<AudioBuffer>).then === "function") (p as Promise<AudioBuffer>).then(resolve, reject);
    });
    const length = Math.max(1, Math.ceil((decoded.duration / ratio) * OUT_RATE));
    const offline = new OAC(1, length, OUT_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.playbackRate.value = ratio;
    source.connect(offline.destination);
    source.start(0);
    const rendered: AudioBuffer = await new Promise((resolve, reject) => {
        offline.oncomplete = (e) => resolve(e.renderedBuffer);
        const p = offline.startRendering();
        if (p && typeof p.then === "function") p.then(resolve, reject);
    });
    return encodeWav16(rendered);
}

function encodeWav16(buffer: AudioBuffer): Blob {
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    const bytes = new ArrayBuffer(44 + data.length * 2);
    const v = new DataView(bytes);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + data.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, data.length * 2, true);
    let o = 44;
    for (let i = 0; i < data.length; i++, o += 2) {
        const x = Math.max(-1, Math.min(1, data[i]));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([bytes], { type: "audio/wav" });
}

// ── iOS audio playback that coexists with speech recognition ──────────
// On iOS Safari, playing TTS through an <audio> element keeps the system audio
// session in "playback" mode, which steals the mic from webkitSpeechRecognition
// and stops it from restarting on the next turn (calls go silent after one
// round). To keep hands-free multi-turn working we play through a Web Audio
// AudioContext and explicitly suspend() it after each clip so iOS hands the
// audio session back to the microphone. A shared <audio> element is kept as a
// fallback for browsers without AudioContext.

let _audioCtx: AudioContext | null = null;
let _sharedAudio: HTMLAudioElement | null = null;
let _audioUnlocked = false;
let _unlockListenerInstalled = false;

// ── In-app TTS volume (0..1) ──
// iOS plays Web Audio on the ringer/voice stream, so the hardware volume keys
// don't control character speech. This in-app gain does. Synced to localStorage.
const TTS_VOLUME_KEY = "ai_phone_tts_volume_v1";
let _ttsVolume = ((): number => {
    if (typeof window === "undefined") return 1;
    try {
        const raw = window.localStorage.getItem(TTS_VOLUME_KEY);
        const v = raw == null ? 1 : Number(raw);
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch { return 1; }
})();
// Live gain node of the currently-playing AudioContext clip, so the slider can
// adjust volume mid-sentence.
let _activeGain: GainNode | null = null;

export function getTtsVolume(): number {
    return _ttsVolume;
}

export function setTtsVolume(volume: number): void {
    _ttsVolume = Math.min(1, Math.max(0, volume));
    try { window.localStorage.setItem(TTS_VOLUME_KEY, String(_ttsVolume)); } catch { /* ignore */ }
    if (_activeGain) { try { _activeGain.gain.value = _ttsVolume; } catch { /* ignore */ } }
    if (_sharedAudio) { try { _sharedAudio.volume = _ttsVolume; } catch { /* ignore */ } }
}

// ── 通话音频会话开关 ──
// 只有通话界面在场时才让 Web Audio 上下文保持 running。此前全局点击解锁会把
// 上下文永久 resume，页面从第一次点击起就一直持有系统音频会话；叠加通话退出
// 后识别泄漏，整页音频会被钉在"通话模式"（语音条/试听音量巨大且音量键失灵）。
let _callAudioSessionActive = false;

/** 通话界面挂载时置 true、卸载/挂断时置 false（false 时立即挂起空闲的上下文）。 */
export function setCallAudioSessionActive(active: boolean): void {
    _callAudioSessionActive = active;
    if (!active && _audioCtx && !_activeGain) {
        try { void _audioCtx.suspend(); } catch { /* ignore */ }
    }
}

function getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    if (!_audioCtx) {
        // 不要钉 sampleRate:部分 iOS 版本上非硬件采样率的 ctx 会"时钟照走、
        // 输出全静音"(比闷更糟)。防发闷靠 TTS 请求参数(44100/256k)兜底。
        try { _audioCtx = new Ctor(); } catch { return null; }
    }
    return _audioCtx;
}

function getSharedAudio(): HTMLAudioElement {
    if (!_sharedAudio) {
        _sharedAudio = new Audio();
        _sharedAudio.setAttribute("playsinline", "");
    }
    return _sharedAudio;
}

function silentWavUrl(): string {
    // A few ms of 16-bit mono PCM silence — a valid source so play() actually
    // starts (and thus unlocks the element) on iOS.
    // 采样率用 48kHz 而不是 8kHz：iOS 的系统音频会话采样率会跟着刚播放的媒体走，
    // 解锁音若是 8kHz，紧接着播的 TTS 会被压到 4kHz 以下而发闷（与保活音同理）。
    const sampleRate = 48000;
    const numSamples = 96; // 2ms
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, "data"); view.setUint32(40, dataSize, true);
    // 16-bit PCM 静音为 0，ArrayBuffer 默认全 0，无需再写
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/**
 * Unlock audio playback. Must run inside (or synchronously from) a user gesture.
 * Resumes the AudioContext (primary path) and unlocks the <audio> fallback.
 * Safe to call repeatedly.
 */
export function unlockAudioPlayback(): void {
    if (typeof window === "undefined") return;

    // Primary path: resume the Web Audio context within the gesture. Once
    // resumed under a gesture, subsequent programmatic resume()s are allowed.
    // 非通话期只借这次手势拿"授权"，随即挂起——不让页面平时一直持有音频会话。
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
        const keepRunning = _callAudioSessionActive;
        ctx.resume().then(() => {
            if (!keepRunning && !_activeGain && !_callAudioSessionActive) {
                try { void ctx.suspend(); } catch { /* ignore */ }
            }
        }).catch(() => {});
    }

    // Fallback path: unlock the shared <audio> element once.
    if (_audioUnlocked) return;
    const audio = getSharedAudio();
    const url = silentWavUrl();
    audio.muted = true;
    audio.src = url;
    const finish = () => {
        try { audio.pause(); audio.currentTime = 0; } catch {}
        audio.muted = false;
        URL.revokeObjectURL(url);
        _audioUnlocked = true;
    };
    try {
        const p = audio.play();
        if (p && typeof p.then === "function") {
            p.then(finish).catch(() => { audio.muted = false; URL.revokeObjectURL(url); });
        } else {
            finish();
        }
    } catch {
        audio.muted = false;
        URL.revokeObjectURL(url);
    }
}

function installUnlockListener(): void {
    if (_unlockListenerInstalled || typeof window === "undefined") return;
    _unlockListenerInstalled = true;
    const handler = () => { unlockAudioPlayback(); };
    window.addEventListener("touchend", handler, { passive: true });
    window.addEventListener("pointerdown", handler, { passive: true });
    window.addEventListener("mousedown", handler, { passive: true });
}

// Install the first-gesture unlock as soon as this module loads on the client.
// The call screens import this module statically (via chat-room), so the
// listener is in place well before the user taps the call button.
if (typeof window !== "undefined") installUnlockListener();

function decodeAudio(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    // Support both the promise and legacy callback forms (older webkitAudioContext).
    return new Promise((resolve, reject) => {
        const ret = ctx.decodeAudioData(data, resolve, reject);
        if (ret && typeof (ret as Promise<AudioBuffer>).then === "function") {
            (ret as Promise<AudioBuffer>).then(resolve, reject);
        }
    });
}

/**
 * Playback via a shared <audio> element. Used as the fallback when AudioContext
 * is unavailable, and as the PRIMARY path for gesture-less auto-play scenarios
 * (e.g. VN/漫卷 auto voice): a media element that was unlocked once keeps playing
 * programmatically, whereas resuming a suspended AudioContext far from any user
 * gesture is often rejected on Android Chrome/Edge (the "only plays with WeChat
 * keep-alive on" bug — the keep-alive's looping silent <audio> was what kept the
 * context alive). Bonus: media-element playback also obeys hardware volume keys.
 */
export function playAudioBlobViaMediaElement(blob: Blob): { promise: Promise<void>; abort: () => void } {
    return playAudioBlobElement(blob);
}

function playAudioBlobElement(blob: Blob): { promise: Promise<void>; abort: () => void } {
    const url = URL.createObjectURL(blob);
    const audio = getSharedAudio();
    audio.muted = false;
    audio.volume = _ttsVolume;
    audio.src = url;

    let settled = false;
    let resolveFn: () => void = () => {};
    const finalize = () => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {}
        resolveFn();
    };
    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
        audio.onended = finalize;
        audio.onerror = finalize;
        audio.play().catch(() => {
            finalize();
        });
    });
    return { promise, abort: finalize };
}

/**
 * Play an audio blob through the Web Audio context and resolve when playback
 * ends. After playback the context is suspended so iOS releases the audio
 * session back to the microphone (lets SpeechRecognition restart next turn).
 * Returns an abort function to stop playback early. Playback is sequential.
 */
export function playAudioBlob(blob: Blob): { promise: Promise<void>; abort: () => void } {
    const ctx = getAudioContext();
    if (!ctx) return playAudioBlobElement(blob);

    let settled = false;
    let resolveFn: () => void = () => {};
    let source: AudioBufferSourceNode | null = null;

    let gain: GainNode | null = null;
    let fallbackAbort: (() => void) | null = null;

    const cleanupWebAudio = () => {
        if (source) {
            source.onended = null;
            try { source.stop(); } catch {}
            try { source.disconnect(); } catch {}
            source = null;
        }
        if (gain) { try { gain.disconnect(); } catch {} }
        if (_activeGain === gain) _activeGain = null;
        gain = null;
        // Suspend so iOS hands the audio session back to the microphone.
        try { ctx.suspend(); } catch {}
    };

    const finalize = () => {
        if (settled) return;
        settled = true;
        cleanupWebAudio();
        if (fallbackAbort) { fallbackAbort(); fallbackAbort = null; }
        resolveFn();
    };

    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
        (async () => {
            try {
                if (ctx.state === "suspended") {
                    // 程序化 resume 在部分安卓浏览器上会被拒绝，甚至让 promise 永远
                    // 悬着（要等下一次用户手势）。限时等待后检查状态，走不通就回落。
                    await Promise.race([
                        ctx.resume().catch(() => {}),
                        new Promise(r => setTimeout(r, 800)),
                    ]);
                }
                if (ctx.state !== "running") throw new Error("audio_context_not_running");
                const audioBuffer = await decodeAudio(ctx, await blob.arrayBuffer());
                if (settled) return;
                source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                // Route through a gain node so the in-app volume slider applies.
                gain = ctx.createGain();
                gain.gain.value = _ttsVolume;
                source.connect(gain);
                gain.connect(ctx.destination);
                _activeGain = gain;
                source.onended = finalize;
                source.start();
            } catch {
                // Web Audio 走不通（resume 被拒/解码失败等）时回落媒体元素播放：
                // 宁可这一段绕过「iOS 归还麦克风」的优化，也不要静默无声——
                // 此前这里直接 finalize，正是「语音条有声、通话没声」的来源之一。
                if (settled) return;
                cleanupWebAudio();
                const fallback = playAudioBlobElement(blob);
                fallbackAbort = fallback.abort;
                void fallback.promise.then(() => {
                    if (settled) return;
                    settled = true;
                    fallbackAbort = null;
                    resolveFn();
                });
            }
        })();
    });

    return { promise, abort: finalize };
}
