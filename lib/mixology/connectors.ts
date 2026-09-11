// lib/mixology/connectors.ts
// 独家特调 · 连接器：让沙盒里的机括界面能"借宿主的手"调外部接口。
//
// 沙盒是断网的（见 mechanism-runtime / mechanism-panel），而且必须一直断——
// 材料能在大厅分享，给它出网能力等于让任何一件机括都能把密钥和聊天记录带走。
// 这里的做法是把地址和密钥交给玩家而不是材料：玩家在酒柜里配好一个连接器
// （名字 + 地址 + 请求头 + 请求体模板），材料只声明"我要用叫 tts 的连接器"，
// 界面调 mix.call("tts", { text }) 时由宿主套上玩家的配置真正发请求，再把响应递回去。
// 材料自始至终碰不到密钥，数据也只会发往玩家自己填的地址。
//
// 模板替换 / 请求组装是纯函数，可脱离浏览器单测。

import type { MixConnector, MixConnectorResponse } from "./types";

/** 一次调用的参数：只收扁平的字符串/数字/布尔，别的形状一律拒绝 */
export type MixConnectorParams = Record<string, string | number | boolean>;

/** 单次请求的上限，防止界面写出循环把玩家的额度烧光 */
export const MIX_CONNECTOR_TIMEOUT_MS = 60_000;
export const MIX_CONNECTOR_MAX_PARAMS_CHARS = 20_000;
export const MIX_CONNECTOR_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
/** 每件机括每分钟最多调多少次 */
export const MIX_CONNECTOR_RATE_PER_MINUTE = 30;
/** 预设里密钥位置的占位文案：还留着它就说明用户没填密钥 */
export const MIX_CONNECTOR_KEY_PLACEHOLDER = "你的密钥";

// ── 预设 ──────────────────────────────────────────────

export type MixConnectorPreset = {
    id: string;
    label: string;
    /** 一句话说明这个预设接的是什么、参数怎么传 */
    note: string;
    build: () => Pick<MixConnector, "name" | "url" | "method" | "headers" | "body" | "response" | "note">;
};

const MINIMAX_TTS_BODY = [
    "{",
    '  "model": "{{model|speech-02-turbo}}",',
    '  "text": "{{text}}",',
    '  "stream": false,',
    '  "voice_setting": { "voice_id": "{{voice_id|male-qn-qingse}}", "speed": {{speed|1}}, "vol": 1, "pitch": 0 },',
    '  "audio_setting": { "sample_rate": 44100, "bitrate": 256000, "format": "mp3", "channel": 1 }',
    "}",
].join("\n");

const MINIMAX_NOTE = "MiniMax 语音合成（t2a_v2）。参数：text 必填，voice_id / speed / model 选填。响应 JSON 的 data.audio 是十六进制编码的 mp3，界面里解成字节再播（官方「朗读」机括就是这么做的）。";

function minimaxPreset(id: string, label: string, base: string): MixConnectorPreset {
    return {
        id,
        label,
        note: MINIMAX_NOTE,
        build: () => ({
            name: "tts",
            note: `${label}：把 Authorization 里的「你的密钥」换成 MiniMax API Key`,
            url: `${base}/t2a_v2`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${MIX_CONNECTOR_KEY_PLACEHOLDER}`,
            },
            body: MINIMAX_TTS_BODY,
            response: "json",
        }),
    };
}

export const MIX_CONNECTOR_PRESETS: MixConnectorPreset[] = [
    minimaxPreset("minimax-cn", "MiniMax 语音（国内版）", "https://api.minimaxi.com/v1"),
    minimaxPreset("minimax-global", "MiniMax 语音（海外版）", "https://api.minimax.io/v1"),
];

// ── 模板替换 ────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_一-龥.-]+)\s*(?:\|((?:[^{}]|\{(?!\{)|\}(?!\}))*?))?\s*\}\}/g;

/** 模板整体像 JSON 时，替进字符串位置的值要按 JSON 规则转义，否则一个引号就把请求体弄坏 */
function looksLikeJson(template: string): boolean {
    const t = template.trim();
    return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}

/**
 * 把 {{参数名}} / {{参数名|默认值}} 换成调用参数。没传又没默认值的换成空串。
 * jsonMode 下字符串值按 JSON 字符串内容转义（不带外层引号，模板里的引号是作者写的）；
 * 数字与布尔原样放，方便写在引号外面。
 */
export function renderMixConnectorTemplate(template: string, params: MixConnectorParams, jsonMode: boolean): string {
    return template.replace(PLACEHOLDER_RE, (_all, key: string, fallback: string | undefined) => {
        const raw = params[key];
        if (raw === undefined || raw === null) return fallback ?? "";
        if (typeof raw === "string") return jsonMode ? JSON.stringify(raw).slice(1, -1) : raw;
        return String(raw);
    });
}

export type MixConnectorRequest = { url: string; init: { method: "POST" | "GET"; headers: Record<string, string>; body?: string } };

/** 组装一次请求（纯函数）：地址、请求头、请求体都过一遍模板 */
export function buildMixConnectorRequest(connector: MixConnector, params: MixConnectorParams): MixConnectorRequest {
    const url = renderMixConnectorTemplate(connector.url, params, false);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(connector.headers ?? {})) {
        const name = key.trim();
        if (!name) continue;
        headers[name] = renderMixConnectorTemplate(value, params, false);
    }
    const init: MixConnectorRequest["init"] = { method: connector.method === "GET" ? "GET" : "POST", headers };
    if (init.method === "POST") {
        init.body = renderMixConnectorTemplate(connector.body ?? "", params, looksLikeJson(connector.body ?? ""));
    }
    return { url, init };
}

/** 请求头文本框 ↔ 对象：一行一条「名字: 值」 */
export function parseMixConnectorHeaders(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key) out[key] = value;
    }
    return out;
}

export function formatMixConnectorHeaders(headers: Record<string, string> | undefined): string {
    return Object.entries(headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
}

// ── 参数把关 ────────────────────────────────────────────

/** 沙盒递上来的参数：只认扁平对象、值只认字符串/数字/布尔，总量有上限 */
export function normalizeMixConnectorParams(value: unknown): { params: MixConnectorParams } | { err: string } {
    if (value === undefined || value === null) return { params: {} };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { err: "参数必须是一个对象，如 { text: \"…\" }。" };
    const out: MixConnectorParams = {};
    let chars = 0;
    for (const [rawKey, raw] of Object.entries(value as Record<string, unknown>)) {
        const key = rawKey.trim();
        if (!key) continue;
        if (typeof raw === "string") { out[key] = raw; chars += raw.length; }
        else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
        else if (typeof raw === "boolean") out[key] = raw;
        else return { err: `参数 ${key} 只能是字符串、数字或布尔。` };
        if (chars > MIX_CONNECTOR_MAX_PARAMS_CHARS) return { err: `参数总长超过 ${MIX_CONNECTOR_MAX_PARAMS_CHARS} 字。` };
    }
    return { params: out };
}

// ── 限流 ────────────────────────────────────────────────

const callLog = new Map<string, number[]>();

/** 每件机括一分钟内的调用次数：超了就拒，界面写出循环也烧不掉玩家的额度 */
export function takeMixConnectorQuota(materialId: string, now = Date.now()): boolean {
    const window = now - 60_000;
    const list = (callLog.get(materialId) ?? []).filter((t) => t > window);
    if (list.length >= MIX_CONNECTOR_RATE_PER_MINUTE) { callLog.set(materialId, list); return false; }
    list.push(now);
    callLog.set(materialId, list);
    return true;
}

// ── 真正发请求 ───────────────────────────────────────────

export type MixConnectorResult =
    | { ok: true; status: number; data: unknown }
    | { ok: false; error: string; status?: number };

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("响应读取失败"));
        reader.readAsDataURL(blob);
    });
}

async function readResponse(response: Response, mode: MixConnectorResponse): Promise<unknown> {
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MIX_CONNECTOR_MAX_RESPONSE_BYTES) throw new Error("响应太大，超过 24MB。");
    if (mode === "blob") {
        const blob = await response.blob();
        if (blob.size > MIX_CONNECTOR_MAX_RESPONSE_BYTES) throw new Error("响应太大，超过 24MB。");
        return blobToDataUrl(blob);
    }
    const text = await response.text();
    if (text.length > MIX_CONNECTOR_MAX_RESPONSE_BYTES) throw new Error("响应太大，超过 24MB。");
    if (mode === "text") return text;
    try {
        return JSON.parse(text);
    } catch {
        // 接口在出错时常常回一段纯文本：别因为解析失败把状态码也吞掉
        return text;
    }
}

/**
 * 代调一次。网络层面的失败（连不上、超时、CORS 拒绝）回 ok:false；
 * 接口回了非 2xx 也照样把状态码和响应体交回去，让界面自己解释错误。
 */
export async function runMixConnector(connector: MixConnector, params: MixConnectorParams): Promise<MixConnectorResult> {
    let request: MixConnectorRequest;
    try {
        request = buildMixConnectorRequest(connector, params);
        new URL(request.url);
    } catch {
        return { ok: false, error: "连接器地址不合法。" };
    }
    if (!/^https?:$/.test(new URL(request.url).protocol)) return { ok: false, error: "连接器地址必须是 http(s)。" };
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), MIX_CONNECTOR_TIMEOUT_MS);
    try {
        const response = await fetch(request.url, { ...request.init, signal: controller.signal });
        const data = await readResponse(response, connector.response);
        return { ok: true, status: response.status, data };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (controller.signal.aborted) return { ok: false, error: "请求超时（60 秒）。" };
        if (/failed to fetch|networkerror|load failed/i.test(message)) {
            return { ok: false, error: "请求发不出去：网络不通，或接口不允许浏览器跨域访问（CORS）。" };
        }
        return { ok: false, error: message };
    } finally {
        window.clearTimeout(timer);
    }
}
