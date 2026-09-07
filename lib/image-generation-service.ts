import type { ImageGenerationSettings, NovelAiPreset } from "./settings-types";
import { loadImageGenerationSettings, DEFAULT_NOVELAI_PRESET } from "./settings-storage";
import JSZip from "jszip";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { storeMediaBlob } from "./media-cache-storage";
import { throwIfAborted } from "./abort-utils";
import {
  NOVELAI_COMMON_MODELS,
  getNovelAiResolution,
  normalizeNovelAiModel,
  normalizeNovelAiNoiseSchedule,
  normalizeNovelAiSampler,
  normalizeNovelAiScale,
  normalizeNovelAiSteps,
} from "./novelai-image-config";

export type ImageGenerationResult = {
  mediaRef: string;
  dataUrl: string;
  blob: Blob;
  mimeType: string;
  prompt: string;
  usedReferenceImage: boolean;
  revisedPrompt?: string;
};

type ExtractedImage =
  | { kind: "b64"; b64: string; mimeType?: string; revisedPrompt?: string }
  | { kind: "url"; url: string; revisedPrompt?: string };

type ImageGenerationApiResponse = {
  b64: string;
  mimeType?: string;
  revisedPrompt?: string;
};

const IMAGE_MODEL_HINTS = [
  "image",
  "img",
  "dall",
  "flux",
  "stable",
  "sd",
  "midjourney",
  "mj",
  "ideogram",
  "imagen",
  "qwen-image",
  "kolors",
  "wan",
];

function mergePrompt(description: string, extraPrompt: string): string {
  const main = description.trim();
  const extra = extraPrompt.trim();
  return extra ? `${main}\n\n${extra}` : main;
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function dataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;]+);base64,/.exec(dataUrl);
  return match?.[1]?.toLowerCase() || "";
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } | null {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) return null;
  return { blob: base64ToBlob(match[2], match[1] || "image/png"), mimeType: match[1] || "image/png" };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function loadDataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("参考图解码失败"));
    image.src = dataUrl;
  });
}

async function normalizeReferenceImageForEdit(dataUrl: string): Promise<string> {
  if (dataUrlMimeType(dataUrl) === "image/png") return dataUrl;
  if (typeof document === "undefined") return dataUrl;

  try {
    const image = await loadDataUrlImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return dataUrl;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}

function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1] || "png";
  return subtype.replace("jpeg", "jpg");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/images\/(?:generations|edits)$/i, "")
    .replace(/\/images$/i, "");
}

function buildImageUrl(baseUrl: string, mode: "generations" | "edits"): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/images\/(?:generations|edits)$/i.test(trimmed)) {
    return trimmed.replace(/\/images\/(?:generations|edits)$/i, `/images/${mode}`);
  }
  if (/\/images$/i.test(trimmed)) return `${trimmed}/${mode}`;
  return `${normalizeBaseUrl(trimmed)}/images/${mode}`;
}

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/models$/i.test(trimmed)) return trimmed;
  return `${normalizeBaseUrl(trimmed)}/models`;
}

function cleanBase64(value: string): { b64: string; mimeType?: string } {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(value.trim());
  if (match) return { mimeType: match[1], b64: match[2] };
  return { b64: value.trim() };
}

function extractFromObject(data: unknown): ExtractedImage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const revisedPrompt = typeof record.revised_prompt === "string" ? record.revised_prompt : undefined;

  for (const key of ["b64_json", "base64", "b64", "image", "result"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      if (/^https?:\/\//i.test(value.trim())) return { kind: "url", url: value.trim(), revisedPrompt };
      const cleaned = cleanBase64(value);
      return { kind: "b64", ...cleaned, revisedPrompt };
    }
  }

  for (const key of ["url", "image_url"]) {
    const value = record[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      return { kind: "url", url: value.trim(), revisedPrompt };
    }
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).url;
      if (typeof nested === "string" && /^https?:\/\//i.test(nested.trim())) {
        return { kind: "url", url: nested.trim(), revisedPrompt };
      }
    }
  }

  for (const key of ["data", "images", "output", "content"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          if (/^https?:\/\//i.test(item.trim())) return { kind: "url", url: item.trim(), revisedPrompt };
          const cleaned = cleanBase64(item);
          return { kind: "b64", ...cleaned, revisedPrompt };
        }
        const nested = extractFromObject(item);
        if (nested) return { ...nested, revisedPrompt: nested.revisedPrompt || revisedPrompt };
      }
    }
  }

  return null;
}

function extractModels(data: unknown): string[] {
  const results: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/^models\//, "").trim();
    if (normalized) results.push(normalized);
  };

  if (Array.isArray(data)) {
    data.forEach(item => {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        push(row.id ?? row.name ?? row.model);
      }
    });
  } else if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    for (const key of ["data", "models", "items"]) {
      const value = row[key];
      if (Array.isArray(value)) results.push(...extractModels(value));
    }
    push(row.id ?? row.name ?? row.model);
  }

  return Array.from(new Set(results));
}

async function fetchImageUrlAsBase64(url: string, signal?: AbortSignal): Promise<{ b64: string; mimeType: string }> {
  throwIfAborted(signal);
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`图片 URL 下载失败 ${res.status}: ${text.slice(0, 160)}`);
  }
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  const cleaned = cleanBase64(dataUrl);
  return { b64: cleaned.b64, mimeType: cleaned.mimeType || blob.type || "image/png" };
}

async function parseImageGenerationResponse(res: Response, signal?: AbortSignal): Promise<ImageGenerationApiResponse> {
  throwIfAborted(signal);
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`生图 API 错误 ${res.status}: ${text.slice(0, 600)}`);
  }

  if (contentType.startsWith("image/")) {
    const blob = await res.blob();
    throwIfAborted(signal);
    const dataUrl = await blobToDataUrl(blob);
    const cleaned = cleanBase64(dataUrl);
    return { b64: cleaned.b64, mimeType: cleaned.mimeType || contentType };
  }

  const json = await res.json();
  throwIfAborted(signal);
  const extracted = extractFromObject(json);
  if (!extracted) {
    throw new Error(`生图 API 返回中没有找到图片字段：${JSON.stringify(Object.keys(json || {})).slice(0, 200)}`);
  }

  if (extracted.kind === "url") {
    const downloaded = await fetchImageUrlAsBase64(extracted.url, signal);
    return { ...downloaded, revisedPrompt: extracted.revisedPrompt };
  }

  return {
    b64: extracted.b64,
    mimeType: extracted.mimeType || "image/png",
    revisedPrompt: extracted.revisedPrompt,
  };
}

export function filterLikelyImageModels(models: string[]): string[] {
  const filtered = models.filter(model => {
    const lower = model.toLowerCase();
    return IMAGE_MODEL_HINTS.some(hint => lower.includes(hint));
  });
  return filtered.length > 0 ? filtered : models;
}

export async function fetchImageGenerationModels(settings: Pick<ImageGenerationSettings, "apiKey" | "baseUrl" | "requestMode">): Promise<string[]> {
  if (settings.requestMode === "direct") {
    try {
      const res = await fetch(buildModelsUrl(settings.baseUrl), {
        method: "GET",
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`模型列表 API 错误 ${res.status}: ${text.slice(0, 400)}`);
      }
      return extractModels(JSON.parse(text));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("浏览器直连失败：该 API 可能未允许跨域请求。");
      }
      throw error;
    }
  }

  const res = await fetch("/api/image-generation/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
    }),
  });
  const data = await res.json().catch(() => ({})) as { models?: string[]; error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error || `模型列表请求失败 ${res.status}`);
  }
  return Array.isArray(data.models) ? data.models : [];
}

// 通用生图代理(Cloudflare Worker)。配置后,「服务端中转」模式改为:
// 浏览器 → 本代理(带CORS、等待无时长限制) → 用户自己的生图API,
// 不再经过 Netlify 函数(其流式响应有 60s 硬上限,慢生图必死且中转站照样计费)。
// 留空 = 关闭,沿用 Netlify 心跳流式路由。自部署请配置自己的代理地址。
export const IMAGE_GEN_PROXY_URL = (process.env.NEXT_PUBLIC_IMAGE_GEN_PROXY_URL || "").trim().replace(/\/+$/, "");

async function generateImageDirect(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrl: string | null;
  signal?: AbortSignal;
  /** 走通用代理:请求发往代理地址,真实上游放进 x-upstream-base-url 头 */
  proxyBaseUrl?: string;
}): Promise<ImageGenerationApiResponse> {
  const { settings, prompt, referenceImageDataUrl, signal, proxyBaseUrl } = params;
  throwIfAborted(signal);
  const hasReference = Boolean(referenceImageDataUrl);
  const url = buildImageUrl(proxyBaseUrl || settings.baseUrl, hasReference ? "edits" : "generations");
  const headers: Record<string, string> = { Authorization: `Bearer ${settings.apiKey}` };
  if (proxyBaseUrl) headers["x-upstream-base-url"] = normalizeBaseUrl(settings.baseUrl);
  let body: BodyInit;

  if (hasReference) {
    const converted = dataUrlToBlob(referenceImageDataUrl || "");
    if (!converted) throw new Error("参考图格式无效");
    const form = new FormData();
    form.set("model", settings.model);
    form.set("prompt", prompt);
    if (settings.size && settings.size !== "auto") form.set("size", settings.size);
    if (settings.quality && settings.quality !== "auto") form.set("quality", settings.quality);
    form.append("image", converted.blob, `reference.${imageExtension(converted.mimeType)}`);
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: settings.model,
      prompt,
      ...(settings.size && settings.size !== "auto" ? { size: settings.size } : {}),
      ...(settings.quality && settings.quality !== "auto" ? { quality: settings.quality } : {}),
    });
  }

  // 总超时 360s,外部 signal 联动;防止上游悬挂导致界面永久转圈。
  // 部分中转的按次生图（如 gpt-image 系）单张实测 3~5 分钟,180s 会在完成前掐断(钱照扣图丢失)。
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 360_000);
  try {
    return await parseImageGenerationResponse(await fetch(url, { method: "POST", headers, body, signal: controller.signal }), signal);
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(proxyBaseUrl ? "生图代理超时（360 秒未返回）" : "生图请求超时（360 秒未返回）");
    }
    if (error instanceof TypeError) {
      throw new Error(proxyBaseUrl ? "生图代理连接失败" : "浏览器直连失败：该 API 可能未允许跨域请求。");
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

// 「代理中转」模式:配置了通用代理(CF Worker)就只走它——用户选择什么模式就走什么链路,
// 不做隐藏回落(不再兜底到 Netlify 函数,那会消耗站点额度且有 60s 上限)。
// 常量未配置时保留旧的 Netlify 心跳流式路由(自部署无 Worker 的场景)。
//
// Netlify 心跳路由是站点额度的最大计算开销之一(每张图占用函数 30~120s),而不少
// 选了「服务端转发」的用户,其生图 API 其实允许跨域。因此走 Netlify 前先试一次
// 浏览器直连:直连因 CORS 失败(预检被拒,真实请求未发出,上游不会计费)才回落
// 到服务端,并按 baseUrl 记住失败结果,本次会话内不再重复探测。
const directCorsFailedBaseUrls = new Set<string>();

async function generateImageViaServerOrProxy(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrl: string | null;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  if (IMAGE_GEN_PROXY_URL) {
    try {
      return await generateImageDirect({ ...params, proxyBaseUrl: IMAGE_GEN_PROXY_URL });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("生图代理连接失败")) {
        throw new Error("生图代理连接失败:当前网络可能无法访问代理服务器(部分地区需开启代理),或稍后重试。");
      }
      throw error;
    }
  }
  const baseUrlKey = normalizeBaseUrl(params.settings.baseUrl);
  if (!directCorsFailedBaseUrls.has(baseUrlKey)) {
    try {
      return await generateImageDirect(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只有连接层失败(CORS/断网)才回落;API 自身的错误(密钥无效、余额不足等)
      // 说明直连是通的,换服务端转发也会得到同样错误,直接抛出避免重复计费。
      if (!message.includes("浏览器直连失败")) throw error;
      throwIfAborted(params.signal);
      directCorsFailedBaseUrls.add(baseUrlKey);
    }
  }
  return generateImageViaServer(params);
}

async function generateImageViaServer(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrl: string | null;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { settings, prompt, referenceImageDataUrl, signal } = params;
  throwIfAborted(signal);
  // 防"无限卡住":函数被平台中途击杀时流可能既不关闭也不报错。
  // 总超时 180s + 断流检测(心跳每 3s 一个字节,超过 25s 没有任何字节视为断流)。
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);
  try {
    // x-stream-heartbeat:服务端以心跳流响应,真正的结果附在流末尾的 @@RESULT@@ 标记后。
    // 避免托管平台对缓冲响应的 10~26s 超时把慢生图(30~120s)掐成 504。
    const res = await fetch("/api/image-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-stream-heartbeat": "1" },
      signal: controller.signal,
      body: JSON.stringify({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        prompt,
        size: settings.size,
        quality: settings.quality,
        referenceImageDataUrl: referenceImageDataUrl || undefined,
      }),
    });
    throwIfAborted(signal);

    type ServerImagePayload = { httpStatus?: number; b64?: string; mimeType?: string; revisedPrompt?: string; error?: string };
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    let data: ServerImagePayload;
    if (contentType.includes("text/plain")) {
      let text = "";
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          for (;;) {
            idleTimer = setTimeout(() => controller.abort(), 25_000);
            const { done, value } = await reader.read();
            clearTimeout(idleTimer);
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } catch (err) {
          clearTimeout(idleTimer);
          if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("生图请求失败（服务器连接中断,超过 25 秒没有响应）");
          }
          throw err;
        }
      } else {
        text = await res.text();
      }
      const marker = "@@RESULT@@";
      const idx = text.lastIndexOf(marker);
      if (idx < 0) throw new Error(`生图请求失败 ${res.status}（流式响应中断,未收到结果）`);
      try {
        data = JSON.parse(text.slice(idx + marker.length)) as ServerImagePayload;
      } catch {
        throw new Error("生图请求失败（流式结果解析出错）");
      }
      throwIfAborted(signal);
      if (data.error || !data.b64) {
        throw new Error(data.error || `生图请求失败 ${data.httpStatus ?? res.status}`);
      }
    } else {
      // 非流式回退(旧服务端等)
      data = await res.json().catch(() => ({})) as ServerImagePayload;
      throwIfAborted(signal);
      if (!res.ok || data.error || !data.b64) {
        throw new Error(data.error || `生图请求失败 ${res.status}`);
      }
    }
    return { b64: data.b64, mimeType: data.mimeType, revisedPrompt: data.revisedPrompt };
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

async function generateNovelAiDirect(params: {
  apiKey: string;
  preset: NovelAiPreset;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { apiKey, preset, prompt, signal } = params;
  throwIfAborted(signal);

  const { width, height } = getNovelAiResolution(preset.resolution);

  const url = "https://image.novelai.net/ai/generate-image";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const body = JSON.stringify({
    input: prompt,
    model: normalizeNovelAiModel(preset.model),
    action: "generate",
    parameters: {
      width,
      height,
      scale: normalizeNovelAiScale(preset.scale),
      sampler: normalizeNovelAiSampler(preset.sampler),
      steps: normalizeNovelAiSteps(preset.steps),
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: preset.qualityToggle !== false,
      sm: preset.smea === true,
      sm_dyn: preset.smeaDyn === true,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: false,
      uncond_scale: 1,
      cfg_rescale: 0,
      noise_schedule: normalizeNovelAiNoiseSchedule(preset.noiseSchedule),
      negative_prompt: preset.negativePrompt || "",
    },
  });

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);

  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`NovelAI 接口报错 ${res.status}: ${errText.slice(0, 200)}`);
    }

    const arrayBuf = await res.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuf);
    const isZip = (uint8[0] === 0x50 && uint8[1] === 0x4b && uint8[2] === 0x03 && uint8[3] === 0x04)
      || (res.headers.get("content-type") || "").toLowerCase().includes("zip");

    if (isZip) {
      const zip = await JSZip.loadAsync(arrayBuf);
      const files = Object.keys(zip.files);
      const pngFile = files.find(f => f.endsWith(".png")) || files[0];
      if (!pngFile) throw new Error("NovelAI 返回的压缩包内未找到图片");
      const b64 = await zip.files[pngFile].async("base64");
      return { b64, mimeType: "image/png" };
    }

    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return { b64: btoa(binary), mimeType: res.headers.get("content-type") || "image/png" };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error("NovelAI 直连请求超时（180 秒未返回）");
    }
    if (error instanceof TypeError) {
      throw new Error("NovelAI 浏览器直连失败：可能受到浏览器跨域 (CORS) 限制，请在生图设置中将请求方式切换为「服务端转发」。");
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

async function generateNovelAiViaServer(params: {
  apiKey: string;
  preset: NovelAiPreset;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { apiKey, preset, prompt, signal } = params;
  throwIfAborted(signal);

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);

  try {
    const resolution = getNovelAiResolution(preset.resolution);
    const res = await fetch("/api/image-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-stream-heartbeat": "1" },
      signal: controller.signal,
      body: JSON.stringify({
        provider: "novelai",
        apiKey,
        model: normalizeNovelAiModel(preset.model),
        prompt,
        size: resolution.value,
        negativePrompt: preset.negativePrompt || "",
        steps: normalizeNovelAiSteps(preset.steps),
        scale: normalizeNovelAiScale(preset.scale),
        sampler: normalizeNovelAiSampler(preset.sampler),
        noiseSchedule: normalizeNovelAiNoiseSchedule(preset.noiseSchedule),
        qualityToggle: preset.qualityToggle,
        smea: preset.smea,
        smeaDyn: preset.smeaDyn,
      }),
    });
    throwIfAborted(signal);

    type ServerImagePayload = { httpStatus?: number; b64?: string; mimeType?: string; revisedPrompt?: string; error?: string };
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    let data: ServerImagePayload;

    if (contentType.includes("text/plain")) {
      let text = "";
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          for (;;) {
            idleTimer = setTimeout(() => controller.abort(), 25_000);
            const { done, value } = await reader.read();
            clearTimeout(idleTimer);
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } catch (err) {
          clearTimeout(idleTimer);
          if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("NovelAI 请求失败（服务器连接中断，超过 25 秒没有响应）");
          }
          throw err;
        }
      } else {
        text = await res.text();
      }
      const marker = "@@RESULT@@";
      const idx = text.lastIndexOf(marker);
      if (idx < 0) throw new Error(`NovelAI 请求失败 ${res.status}（流式响应中断，未收到结果）`);
      try {
        data = JSON.parse(text.slice(idx + marker.length)) as ServerImagePayload;
      } catch {
        throw new Error("NovelAI 请求失败（流式结果解析出错）");
      }
      throwIfAborted(signal);
      if (data.error || !data.b64) {
        throw new Error(data.error || `NovelAI 请求失败 ${data.httpStatus ?? res.status}`);
      }
    } else {
      data = await res.json().catch(() => ({})) as ServerImagePayload;
      throwIfAborted(signal);
      if (!res.ok || data.error || !data.b64) {
        throw new Error(data.error || `NovelAI 请求失败 ${res.status}`);
      }
    }
    return { b64: data.b64, mimeType: data.mimeType, revisedPrompt: data.revisedPrompt };
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

export async function fetchNovelAiModels(apiKey: string): Promise<string[]> {
  const token = apiKey.trim();
  if (!token) throw new Error("请先填写 NovelAI API Token。");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://image.novelai.net/user/data", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error("NovelAI API Token 无效或已失效，请重新获取后再试。");
      }
      throw new Error(`NovelAI Token 验证失败 ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
    return [...NOVELAI_COMMON_MODELS];
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("NovelAI Token 验证超时，请检查网络后重试。");
    }
    if (error instanceof TypeError) {
      throw new Error("无法连接 NovelAI，请检查网络后重试。");
    }
    if (error instanceof Error) throw error;
    throw new Error("NovelAI Token 验证失败，请检查网络后重试。");
  } finally {
    clearTimeout(timeout);
  }
}

export function hasCharacterReferenceImage(characterId?: string, settings?: ImageGenerationSettings): boolean {
  const charId = characterId?.trim();
  if (!charId) return false;
  const s = settings ?? loadImageGenerationSettings();
  return Boolean(s.characterReferences?.[charId]?.assetId);
}

/**
 * 智能判定是否应该为本次生图使用角色参考图。
 *
 * 核心设计原则：
 * 1. 严格依赖发帖角色是否在设置中上传了参考图（未上传参考图直接返回 false）；
 * 2. 绝不使用模糊单字“我”做判定，避免与用户 {{user}} 或第一人称混淆；
 * 3. 严格排斥明确的多人、合照、合影场景（如“合照”、“两人”、“朋友们”等），防止把单人参考图强行塞入多人生图中造成画面崩坏；
 * 4. 强特征触发：
 *    - 显式标签为“使用参考图”或常见变体（如“自拍”、“参考图”）；
 *    - 描述中包含强烈的自拍动作特征（“自拍”、“近景自拍”、“对镜自拍”、“随手自拍”、“对着镜子”等）；
 *    - 描述中明确出现了发帖角色自己的名字（如“阿达希尔坐在书桌前...”）；
 * 5. 容错与保底：只要命中第 4 条的强特征，哪怕大模型漏写了标签前缀、或误选了“不使用参考图”，均智能纠正为 true。
 */
export function resolvePhotoUseReferenceImage(params: {
  description?: string;
  explicitMode?: string;
  characterId?: string;
  characterName?: string;
  settings?: ImageGenerationSettings;
}): boolean {
  const charId = params.characterId?.trim();
  if (!charId) return false;

  const settings = params.settings ?? loadImageGenerationSettings();
  if (!hasCharacterReferenceImage(charId, settings)) return false;

  const desc = (params.description || "").trim();
  const explicit = (params.explicitMode || "").trim();

  // 1. 显式声明模式
  const explicitUsesRef = explicit === "使用参考图" || explicit === "自拍" || explicit === "参考图";

  // 2. 检查多人/合照特征（若明显是多人合影，且不是单人自拍，则谨慎保持 false）
  const hasGroupIndicators = /(?:合照|合影|两人|二人|同行的人|路人|大家一起|朋友们|\b(?:group|multiple (?:boys|girls|people)|2boys|2girls)\b)/i.test(desc);

  // 3. 检查单人专属自拍动作特征（排除“我”字干扰）
  const hasSelfieIndicators = /(?:自拍|selfie|对镜拍|对着镜子|举起手机)/i.test(desc);

  // 4. 检查单人主角人像与镜头构图特征：
  // 单人主体词（全题材通用：现代都市、西幻奇幻、古风仙侠、日常称谓等）：
  // - 基础人称：男子、男人、男士、男生、男青年、青年、少年、美男子、美少年、帅哥、少年人、青年人；
  //            女子、女人、女士、女生、女青年、少女、姑娘、美少女、美女；
  // - 礼称社交：先生、小姐、少爷、夫人、太太；
  // - 现代职业/身份：学长、学弟、学姐、学妹、医生、警官、调酒师、执事、管家、保镖、总裁；
  // - 古风仙侠：公子、侠客、剑客、道长、仙尊、神官、王爷、世子、将军、刺客、修士；
  // - 西幻奇幻：骑士、法师、魔法师、大魔法师、术士、精灵、血族、吸血鬼、恶魔、天使、神父、修女、领主、公爵、伯爵、王女、魔王、勇者、猎魔人、圣骑士、游侠；
  // - 外貌着装起手：身穿、身着、一袭、一头；
  // - 英文常用：1boy, 1girl, solo, man, boy, girl, woman, gentleman, lady, knight, mage, elf, vampire 等
  const hasPortraitSubject = /(?:男子|男人|男士|男生|男青年|青年|少年|美少年|美男子|帅哥|青年人|少年人|女子|女人|女士|女生|女青年|少女|姑娘|美少女|美女|先生|小姐|少爷|夫人|太太|学长|学弟|学姐|学妹|医生|警官|调酒师|执事|管家|保镖|总裁|公子|侠客|剑客|道长|仙尊|神官|王爷|世子|将军|刺客|修士|骑士|法师|魔法师|大魔法师|术士|精灵|血族|吸血鬼|恶魔|天使|神父|修女|领主|公爵|伯爵|王女|魔王|勇者|猎魔人|圣骑士|游侠|身穿|身着|一袭|一头|\b(?:1boy|1girl|solo|man|boy|girl|woman|gentleman|lady|knight|mage|elf|vampire)\b)/i.test(desc);

  // 加上人像姿态或镜头构图（看向镜头、半身、中景、特写、肖像、looking at camera、upper body、portrait等）
  const hasPortraitComposition = /(?:看向镜头|望向镜头|看着镜头|面对镜头|迎向镜头|正对镜头|凝视镜头|注视镜头|直视镜头|对着镜头|半身|中景|近景|特写|肖像|单人|独坐|立绘|正面照|半身照|近照|全身照|托腮|侧身|侧影|正脸|侧脸|回眸|笑意|搭在|微偏头|微仰头|\b(?:looking at (?:camera|viewer)|portrait|upper body|cowboy shot|close-up|half body|full body|eye contact)\b)/i.test(desc);
  const isSoloPortrait = hasPortraitSubject && hasPortraitComposition;

  // 5. 检查是否出现发帖角色专属名字（避免单字名在普通词汇中误命中）
  const rawCharName = (params.characterName || "").trim();
  let hasCharacterName = false;
  if (rawCharName.length >= 2) {
    hasCharacterName = desc.includes(rawCharName);
  } else if (rawCharName.length === 1) {
    const escaped = rawCharName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    hasCharacterName = new RegExp(`(?:^|[^\\u4e00-\\u9fa5])${escaped}(?:[^\\u4e00-\\u9fa5]|$)`).test(desc);
  }

  // 若明显是多人合影，且未明确说明是单人自拍，则不使用单人参考图
  if (hasGroupIndicators && !hasSelfieIndicators) {
    return false;
  }

  // 显式声明使用参考图
  if (explicitUsesRef) {
    return true;
  }

  // 描述中包含强自拍特征、发帖角色姓名、或单人主角面向镜头人像
  if (hasSelfieIndicators || hasCharacterName || isSoloPortrait) {
    return true;
  }

  return false;
}

export async function generateImageFromConfiguredApi(params: {
  description: string;
  characterId?: string;
  useReferenceImage?: boolean;
  settings?: ImageGenerationSettings;
  signal?: AbortSignal;
}): Promise<ImageGenerationResult | null> {
  const settings = params.settings ?? loadImageGenerationSettings();
  if (!settings.enabled) return null;

  const description = params.description.trim();
  if (!description) return null;

  // NovelAI 模式
  if (settings.provider === "novelai") {
    const naiApiKey = settings.novelai?.apiKey?.trim();
    if (!naiApiKey) return null;

    const presets = settings.novelai?.presets && settings.novelai.presets.length > 0
      ? settings.novelai.presets
      : [DEFAULT_NOVELAI_PRESET];
    const activePreset = presets.find(p => p.id === settings.novelai?.activePresetId) || presets[0];

    const positiveParts: string[] = [];
    if (activePreset.positivePrompt?.trim()) positiveParts.push(activePreset.positivePrompt.trim());
    if (description) positiveParts.push(description);
    const fullPrompt = positiveParts.join(", ");

    const data = settings.requestMode === "direct"
      ? await generateNovelAiDirect({ apiKey: naiApiKey, preset: activePreset, prompt: fullPrompt, signal: params.signal })
      : await generateNovelAiViaServer({ apiKey: naiApiKey, preset: activePreset, prompt: fullPrompt, signal: params.signal });

    throwIfAborted(params.signal);
    const mimeType = data.mimeType || "image/png";
    const blob = base64ToBlob(data.b64, mimeType);
    throwIfAborted(params.signal);
    const mediaRef = await storeMediaBlob(blob, mimeType, "image");
    throwIfAborted(params.signal);
    return {
      mediaRef,
      dataUrl: `data:${mimeType};base64,${data.b64}`,
      blob,
      mimeType,
      prompt: fullPrompt,
      usedReferenceImage: false,
      revisedPrompt: data.revisedPrompt,
    };
  }

  // OpenAI 兼容模式
  if (!settings.apiKey.trim() || !settings.baseUrl.trim() || !settings.model.trim()) return null;

  const reference = params.characterId ? settings.characterReferences[params.characterId] : undefined;
  const rawReferenceImageDataUrl = params.useReferenceImage && reference?.assetId
    ? await getChatImageFromIndexedDB(reference.assetId)
    : null;
  throwIfAborted(params.signal);
  const referenceImageDataUrl = rawReferenceImageDataUrl
    ? await normalizeReferenceImageForEdit(rawReferenceImageDataUrl)
    : null;
  throwIfAborted(params.signal);
  const prompt = mergePrompt(description, settings.extraPrompt);

  const data = settings.requestMode === "direct"
    ? await generateImageDirect({ settings, prompt, referenceImageDataUrl, signal: params.signal })
    : await generateImageViaServerOrProxy({ settings, prompt, referenceImageDataUrl, signal: params.signal });

  throwIfAborted(params.signal);
  const mimeType = data.mimeType || "image/png";
  const blob = base64ToBlob(data.b64, mimeType);
  throwIfAborted(params.signal);
  const mediaRef = await storeMediaBlob(blob, mimeType, "image");
  throwIfAborted(params.signal);
  return {
    mediaRef,
    dataUrl: `data:${mimeType};base64,${data.b64}`,
    blob,
    mimeType,
    prompt,
    usedReferenceImage: Boolean(referenceImageDataUrl),
    revisedPrompt: data.revisedPrompt,
  };
}

export function generatedImageFilename(description: string, mimeType = "image/png"): string {
  const safe = description
    .replace(/\s+/g, "-")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]+/g, "")
    .slice(0, 28) || "generated-image";
  return `${safe}.${imageExtension(mimeType)}`;
}
