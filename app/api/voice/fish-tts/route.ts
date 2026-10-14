// Fish Audio 语音合成代理。
// 浏览器不能直接调 api.fish.audio（跨域），由这里转发：密钥只在本次请求里用，不落盘。
// 音频按流原样转回给前端，不在服务端整段缓存，首字节更快、也不受函数响应体大小影响。
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 60;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const FISH_MODELS = new Set(["s2.1-pro", "s2-pro", "s1", "s2.1-pro-free"]);
const MAX_TEXT_LENGTH = 5000;

function num(value: unknown, min: number, max: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.min(max, Math.max(min, value));
}

function errorJson(message: string, status: number) {
    return Response.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { return errorJson("请求格式错误", 400); }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!apiKey) return errorJson("Fish Audio API Key 未配置", 400);
    if (!text) return errorJson("没有要合成的文字", 400);
    if (text.length > MAX_TEXT_LENGTH) return errorJson(`文字太长（最多 ${MAX_TEXT_LENGTH} 字）`, 400);

    const model = typeof body.model === "string" && FISH_MODELS.has(body.model) ? body.model : "s2.1-pro";
    const referenceId = typeof body.referenceId === "string" ? body.referenceId.trim() : "";
    const speed = num(body.speed, 0.5, 2);
    const volume = num(body.volume, -20, 20);
    const temperature = num(body.temperature, 0, 1);
    const topP = num(body.topP, 0, 1);
    const latency = body.latency === "balanced" ? "balanced" : "normal";

    const payload: Record<string, unknown> = {
        text,
        format: "mp3",
        mp3_bitrate: 192,
        sample_rate: 44100,
        latency,
        normalize: true,
    };
    if (referenceId) payload.reference_id = referenceId;
    if (speed !== undefined || volume !== undefined) {
        payload.prosody = { ...(speed !== undefined ? { speed } : {}), ...(volume !== undefined ? { volume } : {}) };
    }
    if (temperature !== undefined) payload.temperature = temperature;
    if (topP !== undefined) payload.top_p = topP;

    let upstream: Response;
    try {
        upstream = await proxyFetch(FISH_TTS_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                model,
            },
            body: JSON.stringify(payload),
        });
    } catch (err) {
        return errorJson(`连接 Fish Audio 失败：${err instanceof Error ? err.message : String(err)}`, 502);
    }

    if (!upstream.ok || !upstream.body) {
        const raw = await upstream.text().catch(() => "");
        let message = raw.slice(0, 300);
        try {
            const j = JSON.parse(raw);
            message = String(j.message || j.detail || j.error || message);
        } catch { /* 不是 JSON，用原文 */ }
        if (upstream.status === 401 || upstream.status === 403) message = "API Key 无效或没有权限";
        if (upstream.status === 402) message = "Fish Audio 余额不足";
        if (upstream.status === 404 && referenceId) message = "找不到这个音色（Voice ID 不对，或音色未公开）";
        return errorJson(`Fish Audio 合成失败 (${upstream.status})：${message}`, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-store",
        },
    });
}
