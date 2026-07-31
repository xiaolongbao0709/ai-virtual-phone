import type { ImageGenerationSettings } from "./settings-types";
import { loadImageGenerationSettings } from "./settings-storage";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { storeMediaBlob } from "./media-cache-storage";
import { throwIfAborted } from "./abort-utils";

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
  if (!description || !settings.apiKey.trim() || !settings.baseUrl.trim() || !settings.model.trim()) return null;

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
