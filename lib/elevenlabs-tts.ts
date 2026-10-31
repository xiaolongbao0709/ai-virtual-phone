import type { VoiceApiConfig } from "./settings-types";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
export const ELEVENLABS_MODELS = ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_v3", "eleven_v4", "eleven_v4_turbo"];
export const ELEVENLABS_DEFAULT_MODEL = ELEVENLABS_MODELS[0];

export function isElevenLabsV4(model: string | undefined): boolean {
    return ["eleven_v4", "eleven_v4_turbo"].includes(model?.trim() || "");
}

export function usesElevenLabsAccountVoiceSettings(model: string | undefined): boolean {
    return model?.trim() === "eleven_v3";
}

function baseUrl(config: VoiceApiConfig): string {
    const url = new URL((config.baseUrl?.trim() || ELEVENLABS_BASE_URL).replace(/\/+$/, ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new Error("ElevenLabs 接口地址须为不含账号、查询参数的 HTTPS 地址");
    }
    return url.href.replace(/\/+$/, "").replace(/\/v[12]$/, "");
}

function clamp(value: number | undefined, fallback: number, min = 0, max = 1) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function elevenLabsSpeechRequest(text: string, config: VoiceApiConfig) {
    if (!config.defaultVoice?.trim()) throw new Error("请先同步并选择 ElevenLabs 音色，或填写 Voice ID");
    const model = config.model?.trim() || ELEVENLABS_DEFAULT_MODEL;
    const language = config.elevenLabs?.languageCode?.trim().toLowerCase() || "";
    if (isElevenLabsV4(model) && language && !/^[a-z]{2}$/.test(language)) throw new Error("语言代码请填写两位字母，如 zh、ja、en；留空自动识别");
    return {
        url: `${baseUrl(config)}/v1/text-to-speech/${encodeURIComponent(config.defaultVoice.trim())}?output_format=mp3_44100_128`,
        body: {
            text, model_id: model,
            ...(isElevenLabsV4(model) && language ? { language_code: language } : {}),
            // Expressive models keep account defaults; don't assume v2 controls are compatible.
            ...(isElevenLabsV4(model) ? { voice_settings: {
                stability: clamp(config.elevenLabs?.stability, .5),
                similarity_boost: clamp(config.elevenLabs?.similarity, .75),
            } } : usesElevenLabsAccountVoiceSettings(model) ? {} : { voice_settings: {
                stability: clamp(config.elevenLabs?.stability, .5),
                similarity_boost: clamp(config.elevenLabs?.similarity, .75),
                style: clamp(config.elevenLabs?.style, 0),
                use_speaker_boost: config.elevenLabs?.speakerBoost ?? true,
                speed: clamp(config.speechSpeed, 1, .7, 1.2),
            } }),
        },
    };
}

async function request<T>(config: VoiceApiConfig, url: string, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
    const key = config.apiKey?.trim();
    if (!key) throw new Error("ElevenLabs API Key 未配置");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
        const response = await fetch(url, {
            ...init, signal: controller.signal, cache: "no-store", redirect: "error",
            headers: { ...init.headers, "xi-api-key": key },
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => null);
            const status = payload?.detail?.status;
            const hint = status === "quota_exceeded" ? "额度不足，请检查账户余额"
                : response.status === 401 ? "密钥无效或已过期"
                : response.status === 403 ? "密钥缺少权限，或当前套餐无法使用此音色／模型"
                : response.status === 404 ? "音色或模型不存在，请重新同步或检查 ID"
                : response.status === 429 ? "请求过于频繁或额度受限，请稍后重试"
                : "请检查模型、音色和参数，或稍后重试";
            // Do not echo arbitrary upstream text (it may contain credentials or user text).
            throw new Error(`ElevenLabs (${response.status})：${hint}`);
        }
        return await read(response);
    } catch (error) {
        if (controller.signal.aborted) throw new Error("ElevenLabs 请求超时（120 秒），请稍后重试");
        if (error instanceof TypeError) throw new Error("无法连接 ElevenLabs，请检查网络及接口地址（自定义中转须支持浏览器跨域）");
        throw error;
    } finally { clearTimeout(timer); }
}

export async function synthesizeElevenLabs(text: string, config: VoiceApiConfig): Promise<Blob> {
    const { url, body } = elevenLabsSpeechRequest(text, config);
    return request(config, url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "audio/mpeg" }, body: JSON.stringify(body) }, async response => {
        const type = response.headers.get("content-type") || "";
        if (type && !type.startsWith("audio/") && !type.startsWith("application/octet-stream")) throw new Error("ElevenLabs 返回的不是音频数据");
        const blob = await response.blob();
        if (!blob.size) throw new Error("ElevenLabs 返回了空音频");
        return new Blob([blob], { type: "audio/mpeg" });
    });
}

export async function listElevenLabsVoices(config: VoiceApiConfig): Promise<{ id: string; name: string }[]> {
    const voices = new Map<string, { id: string; name: string }>();
    const seen = new Set<string>();
    let token = "";
    for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ page_size: "100", include_total_count: "false" });
        if (token) query.set("next_page_token", token);
        const data = await request(config, `${baseUrl(config)}/v2/voices?${query}`, { method: "GET" }, response => response.json());
        if (!Array.isArray(data?.voices)) throw new Error("ElevenLabs 音色列表格式异常");
        for (const voice of data.voices) {
            if (typeof voice?.voice_id !== "string" || !voice.voice_id.trim()) continue;
            voices.set(voice.voice_id, { id: voice.voice_id, name: typeof voice.name === "string" ? voice.name : voice.voice_id });
        }
        if (!data.has_more) return [...voices.values()];
        token = data.next_page_token;
        if (typeof token !== "string" || !token || seen.has(token)) throw new Error("ElevenLabs 音色分页异常，请重新同步");
        seen.add(token);
    }
    throw new Error("ElevenLabs 音色数量过多，请直接填写 Voice ID");
}
