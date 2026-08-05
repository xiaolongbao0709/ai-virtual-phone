import type { ImageGenerationSettings, ImageProvider } from "./settings-types";
import { loadImageGenerationSettings } from "./settings-storage";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { storeMediaBlob } from "./media-cache-storage";
import { throwIfAborted } from "./abort-utils";
import JSZip from "jszip";

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
  // 始终走 Vercel 服务器中转获取模型列表（与生成一致），避免浏览器直连 api.openai.com 被墙。
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

// ── NovelAI 专属逻辑 ──────────────────────────────────────────────

/** NAI 尺寸预设 → [width, height]（与 Miya 小手机一致） */
const NAI_SIZE_MAP: Record<string, [number, number]> = {
    "832x1216": [832, 1216],   // 2:3 竖图
    "1216x832": [1216, 832],   // 3:2 横图
    "1024x1024": [1024, 1024], // 正方形
    "1536x1024": [1536, 1024], // 3:2 横图（高清）
    "1024x1536": [1024, 1536], // 2:3 竖图（高清）
    "1472x1472": [1472, 1472], // 1:1 正方形（高清）
};

function parseNaiSize(sizeStr: string): [number, number] {
    return NAI_SIZE_MAP[sizeStr] || ([832, 1216] as [number, number]);
}

/**
 * 构建 NAI 最终提示词：
 * 模板: {positive_prefix}, {prompt}, {quality_suffix}
 * 支持 {prompt} 占位符替换为实际描述
 */
function buildNaiPrompt(description: string, nai: ImageGenerationSettings["novelai"]): string {
    const template = nai.promptTemplate || "{prompt}";
    return template
        .replace(/\{positive_prefix\}/gi, nai.positivePrefix)
        .replace(/\{quality_suffix\}/gi, nai.qualitySuffix)
        .replace(/\{prompt\}/gi, description);
}

/**
 * 调用 NovelAI /ai/generate-image 接口生图。
 * 浏览器直连官方 image.novelai.net（与棉花糖机 / Miya 小手机同款方案：内置官方链接、无需梯子、无需服务器中转）。
 * 请求体与参数严格参照 Miya 的实现；NAI 返回 ZIP 包（多图）或 JSON（单张 base64），两种形态都兼容。
 */
async function generateImageNovelAI(params: {
    settings: ImageGenerationSettings;
    prompt: string;
    signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
    const { settings, prompt, signal } = params;
    const nai = settings.novelai;
    throwIfAborted(signal);

    if (!nai.apiKey?.trim()) throw new Error("NovelAI API Key 未填写");

    // 空白 = 内置官方地址（同棉花糖机 / Miya：image.novelai.net，浏览器直连官网、无需梯子）
    const baseUrl = (nai.url?.trim() || "https://image.novelai.net").replace(/\/+$/, "");
    const apiUrl = /\/ai\/generate-image$/i.test(baseUrl) ? baseUrl : `${baseUrl}/ai/generate-image`;

    const [width, height] = parseNaiSize(nai.size);
    const finalPrompt = buildNaiPrompt(prompt, nai);

    // 种子：未填写则随机正整（NAI 接受随机种子；与 Miya 一致）
    const seed = (typeof nai.seed === "string" && nai.seed.trim())
        ? (parseInt(nai.seed, 10) || Math.floor(Math.random() * 999999999))
        : Math.floor(Math.random() * 999999999);

    // Miya 验证可用的 NAI v3 请求体
    const body = JSON.stringify({
        input: finalPrompt,
        model: nai.model || "nai-diffusion-4-5-full",
        action: "generate",
        parameters: {
            width,
            height,
            scale: typeof nai.cfgScale === "number" ? nai.cfgScale : 5,
            sampler: nai.sampler || "k_euler_ancestral",
            steps: typeof nai.steps === "number" ? Math.max(1, Math.min(50, nai.steps)) : 28,
            n_samples: 1,
            seed,
            negative_prompt: nai.negativePrompt || "",
            sm: !!nai.smea,
            sm_dyn: !!nai.smeaDyn,
            qualityToggle: true,
            ucPreset: typeof nai.ucPreset === "number" ? nai.ucPreset : 0,
        },
    });

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${nai.apiKey}`,
    };

    // 总超时 360s（NAI 生图可能较慢）
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
    const totalTimer = setTimeout(() => controller.abort(), 360_000);

    try {
        const res = await fetch(apiUrl, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
        });
        throwIfAborted(signal);

        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            // 402 = 点数不足。绝大多数情况是"参数超出免费额度"，给出可操作的中文指引。
            if (res.status === 402) {
                const px = width * height;
                const reasons: string[] = [];
                if (px > 1024 * 1024) {
                    reasons.push(`• 当前尺寸 ${width}×${height}（${px.toLocaleString()} 像素）超过免费上限 1024×1024，请改选带「✅免费」的尺寸`);
                }
                const usedSteps = typeof nai.steps === "number" ? nai.steps : 28;
                if (usedSteps > 28) {
                    reasons.push(`• 当前步数 ${usedSteps} 超过免费上限 28，请把步数调回 28 或更低`);
                }
                if (!reasons.length) {
                    reasons.push("• 参数已在免费范围内，说明你的 NAI 账号不是 Opus 订阅（只有 Opus 才有小图无限免费生成），需要订阅 Opus 或充值 Anlas 点数");
                }
                throw new Error(
                    `NovelAI 提示点数不足（402）。免费生成的条件是：尺寸 ≤ 1024×1024 且步数 ≤ 28。\n${reasons.join("\n")}`
                );
            }
            if (res.status === 401) {
                throw new Error("NovelAI 鉴权失败（401）：API Key / Token 不正确，请到 NAI 官网重新复制。");
            }
            throw new Error(`NovelAI API 错误 ${res.status}: ${errText.slice(0, 600)}`);
        }

        const contentType = (res.headers.get("content-type") || "").toLowerCase();

        // 1) JSON 形态：直接返回 base64 的 image 字段
        if (contentType.includes("json")) {
            const json = await res.json() as Record<string, unknown>;
            const image = typeof json.image === "string" ? json.image : undefined;
            if (!image) throw new Error(`NovelAI 返回格式异常：${JSON.stringify(Object.keys(json)).slice(0, 200)}`);
            return { b64: image, mimeType: "image/png", revisedPrompt: finalPrompt };
        }

        // 2) ZIP / 二进制流形态（NAI v3 标准返回）：解压取第一张图
        const buf = await res.arrayBuffer();
        throwIfAborted(signal);
        if (contentType.includes("zip") || contentType.includes("octet-stream") || !contentType.includes("image/")) {
            const b64 = await extractFirstImageBase64FromZip(buf);
            return { b64, mimeType: "image/png", revisedPrompt: finalPrompt };
        }

        // 3) 直接就是图片字节
        const mime = contentType.startsWith("image/") ? contentType : "image/png";
        return { b64: arrayBufferToBase64(buf), mimeType: mime, revisedPrompt: finalPrompt };
    } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("NovelAI 生图超时（360 秒未返回）");
        }
        if (error instanceof TypeError) {
            throw new Error("NovelAI 连接失败：该地址可能未允许跨域请求，或网络不通（直连官网请确认网络可访问 image.novelai.net）。");
        }
        throw error;
    } finally {
        clearTimeout(totalTimer);
        if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
}

/** ArrayBuffer → base64 字符串（浏览器环境） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

/** 从 NAI 返回的 ZIP 包里解压出第一张图片，返回 base64 */
async function extractFirstImageBase64FromZip(buffer: ArrayBuffer): Promise<string> {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files).filter(
        (n) => !zip.files[n].dir && /\.(png|jpe?g|webp)$/i.test(n),
    );
    if (!names.length) throw new Error("NovelAI 返回的 ZIP 中没有找到图片文件");
    const blob = await zip.files[names[0]].async("blob");
    const dataUrl = await blobToDataUrl(blob);
    const cleaned = cleanBase64(dataUrl);
    if (!cleaned.b64) throw new Error("NovelAI 解压后的图片数据为空");
    return cleaned.b64;
}

// ── Pollinations 生图（免费、免 Key，浏览器直连）────────────────────
// GET https://image.pollinations.ai/prompt/{prompt}?width=&height=&model=&seed=&nologo=&enhance=
async function generateImagePollinations(params: {
    settings: ImageGenerationSettings;
    prompt: string;
    signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
    const { settings, prompt, signal } = params;
    throwIfAborted(signal);
    const cfg = settings.pollinations;
    const width = typeof cfg.width === "number" ? cfg.width : 1024;
    const height = typeof cfg.height === "number" ? cfg.height : 1024;
    const model = cfg.model?.trim() || "flux";
    const encoded = encodeURIComponent(prompt.trim());
    const query = new URLSearchParams();
    query.set("width", String(width));
    query.set("height", String(height));
    query.set("model", model);
    query.set("nologo", cfg.nologo === false ? "false" : "true");
    query.set("enhance", cfg.enhance === false ? "false" : "true");
    if (cfg.seed?.trim()) query.set("seed", cfg.seed.trim());
    const url = `https://image.pollinations.ai/prompt/${encoded}?${query.toString()}`;

    const headers: Record<string, string> = {};
    if (cfg.apiKey?.trim()) headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;

    // 总超时 120s
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
    const totalTimer = setTimeout(() => controller.abort(), 120_000);
    try {
        const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
        throwIfAborted(signal);
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`Pollinations API 错误 ${res.status}: ${errText.slice(0, 400)}`);
        }
        const blob = await res.blob();
        throwIfAborted(signal);
        const dataUrl = await blobToDataUrl(blob);
        const cleaned = cleanBase64(dataUrl);
        if (!cleaned.b64) throw new Error("Pollinations 返回的图片数据为空");
        return {
            b64: cleaned.b64,
            mimeType: cleaned.mimeType || blob.type || "image/jpeg",
            revisedPrompt: prompt,
        };
    } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("Pollinations 生图超时（120 秒未返回）");
        }
        if (error instanceof TypeError) {
            throw new Error("Pollinations 连接失败：请检查网络或代理设置。");
        }
        throw error;
    } finally {
        clearTimeout(totalTimer);
        if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
}

// ── Google Imagen 生图（需 Key，经服务端转发，避免浏览器跨域/暴露密钥）──
async function generateGoogleImagenViaServer(params: {
    settings: ImageGenerationSettings;
    prompt: string;
    signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
    const { settings, prompt, signal } = params;
    throwIfAborted(signal);
    const gi = settings.googleImagen;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
    const totalTimer = setTimeout(() => controller.abort(), 180_000);
    try {
        const res = await fetch("/api/image-generation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                provider: "google-imagen",
                prompt,
                googleKey: gi.apiKey,
                googleModel: gi.model,
                googleWidth: gi.width,
                googleHeight: gi.height,
                googleNegativePrompt: gi.negativePrompt,
                googleAspectRatio: gi.aspectRatio,
                googlePersonGeneration: gi.personGeneration,
            }),
            signal: controller.signal,
        });
        throwIfAborted(signal);
        const data = await res.json() as { b64?: string; mimeType?: string; revisedPrompt?: string; error?: string };
        throwIfAborted(signal);
        if (!res.ok || data.error || !data.b64) {
            throw new Error(data.error || `Google Imagen 请求失败 ${res.status}`);
        }
        return { b64: data.b64, mimeType: data.mimeType, revisedPrompt: data.revisedPrompt };
    } catch (error) {
        if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("Google Imagen 生图超时（180 秒未返回）");
        }
        throw error;
    } finally {
        clearTimeout(totalTimer);
        if (signal) signal.removeEventListener("abort", onOuterAbort);
    }
}

// ── 原有 OpenAI 兼容逻辑 ───────────────────────────────────────────
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
  participants?: Array<{ name: string; anchor?: string; action?: string }>;
  referenceImages?: string[];
  sceneBackground?: string;
  sceneLighting?: string;
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
  participantAppearance?: string;
  referenceImageDataUrl: string | null;
  participants?: Array<{ name: string; anchor?: string; action?: string }>;
  referenceImages?: string[];
  sceneBackground?: string;
  sceneLighting?: string;
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
        // Provider 路由信息
        provider: settings.provider,
        // OpenAI 兼容字段
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        prompt,
        size: settings.size,
        quality: settings.quality,
        referenceImageDataUrl: referenceImageDataUrl || undefined,
        // NovelAI 字段（provider=novelai 时服务端使用）
        novelaiUrl: settings.novelai.url,
        novelaiKey: settings.novelai.apiKey,
        novelaiModel: settings.novelai.model,
        novelaiSize: settings.novelai.size,
        novelaiPositivePrefix: settings.novelai.positivePrefix,
        novelaiQualitySuffix: settings.novelai.qualitySuffix,
        novelaiNegativePrompt: settings.novelai.negativePrompt,
        novelaiPromptTemplate: settings.novelai.promptTemplate,
        // NAI 高级参数
        novelaiSteps: settings.novelai.steps,
        novelaiCfgScale: settings.novelai.cfgScale,
        novelaiSampler: settings.novelai.sampler,
        novelaiNoiseSchedule: settings.novelai.noiseSchedule,
        novelaiSeed: settings.novelai.seed,
        novelaiStyleStrength: settings.novelai.styleStrength,
        // 新增字段
        novelaiUcPreset: settings.novelai.ucPreset,
        novelaiQualityTags: settings.novelai.qualityTags,
        novelaiSmea: settings.novelai.smea,
        novelaiSmeaDyn: settings.novelai.smeaDyn,
        novelaiEndpointMode: settings.novelai.endpointMode,
        // 参与者外观（中文），服务端翻译后注入 NAI prompt，让「谁是谁」可控
        participantAppearance: params.participantAppearance || undefined,
        // v18：结构化参与者 + 锁脸参考图 + 场景
        participants: params.participants && params.participants.length ? params.participants : undefined,
        referenceImages: params.referenceImages && params.referenceImages.length ? params.referenceImages : undefined,
        sceneBackground: params.sceneBackground?.trim() || undefined,
        sceneLighting: params.sceneLighting?.trim() || undefined,
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
        throw new Error(humanizeImageError(data.error || `生图请求失败 ${data.httpStatus ?? res.status}`));
      }
    } else {
      // 非流式回退(旧服务端等)
      data = await res.json().catch(() => ({})) as ServerImagePayload;
      throwIfAborted(signal);
      if (!res.ok || data.error || !data.b64) {
        throw new Error(humanizeImageError(data.error || `生图请求失败 ${res.status}`));
      }
    }
    return { b64: data.b64, mimeType: data.mimeType, revisedPrompt: data.revisedPrompt };
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

// ── 全局单飞锁（仅 NovelAI）──
// NAI 普通账号同一时刻只允许 1 张生图，聊天自动生图 / 测试按钮 / 🔄重roll
// 只要同时发起就会触发 429 "Concurrent generation is locked"。
// 用一个模块级串行队列，保证整个 app（同一标签页）任意时刻最多 1 个 NAI 生图在飞，
// 后续请求排队而非并发撞车。两个标签页各有一份模块状态，故跨标签仍需服务端兜底。
let naiGenChain: Promise<unknown> = Promise.resolve();
function serializeNai<T>(task: () => Promise<T>): Promise<T> {
  const run = naiGenChain.catch(() => undefined).then(task);
  // 无论前一个成功或失败，都让它从链上脱离，避免 reject 传导到后续
  naiGenChain = run.then(() => undefined, () => undefined);
  return run;
}

// 把服务端透传的生图错误转成中文友好提示
function humanizeImageError(raw: string): string {
  if (/concurrent generation|429/i.test(raw)) {
    return "NovelAI 同一时间只能生成 1 张，请等当前这张完成后再试（约 10–30 秒）。";
  }
  return raw;
}

export async function generateImageFromConfiguredApi(params: {
  description: string;
  characterId?: string;
  useReferenceImage?: boolean;
  settings?: ImageGenerationSettings;
  signal?: AbortSignal;
  /** 参与合影的角色/用户外观描述（中文），注入 prompt 让 NAI 区分「谁是谁」 */
  participantAppearance?: string;
  /** 结构化参与者（人物名+锚点+动作），用于「人物名(锚点) 动作」格式 */
  participants?: Array<{ name: string; anchor?: string; action?: string }>;
  /** 参与者头像 data URL，用于 NAI character_reference 锁脸 */
  referenceImages?: string[];
  /** 背景描述（中文） */
  sceneBackground?: string;
  /** 光源描述（中文） */
  sceneLighting?: string;
}): Promise<ImageGenerationResult | null> {
  const settings = params.settings ?? loadImageGenerationSettings();
  if (!settings.enabled) return null;

  const description = params.description.trim();

  // ── Provider 路由：NAI vs OpenAI 兼容 ──
  if (settings.provider === "novelai") {
    const nai = settings.novelai;
    // NAI 校验：只要求 Key，地址留空即内置官方
    if (!description || !nai?.apiKey?.trim()) {
      console.warn("[IMG-SVC] NAI 路径返回 null", { hasDescription: Boolean(description), hasKey: Boolean(nai?.apiKey?.trim()), keyLen: nai?.apiKey?.length || 0 });
      return null;
    }

    throwIfAborted(params.signal);
    console.log("[IMG-SVC] NAI 开始请求服务端中转", { promptLen: description.length, model: nai.model });
    // 走服务端中转：浏览器只连我们自己 Vercel 服务器（国内合法），
    // 由 Vercel 海外服务器调 image.novelai.net（正确域名），
    // 解决浏览器 CORS + 境外网络双重拦截。
    const data = await serializeNai(() => generateImageViaServer({
      settings,
      prompt: description,
      participantAppearance: params.participantAppearance,
      referenceImages: params.referenceImages,
      participants: params.participants,
      sceneBackground: params.sceneBackground,
      sceneLighting: params.sceneLighting,
      referenceImageDataUrl: null,
      signal: params.signal,
    }));
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
      prompt: description,
      usedReferenceImage: false,
      revisedPrompt: data.revisedPrompt,
    };
  }

  // ── Pollinations（免费免 Key，浏览器直连）──
  if (settings.provider === "pollinations") {
    if (!description) return null;
    throwIfAborted(params.signal);
    const data = await generateImagePollinations({ settings, prompt: description, signal: params.signal });
    throwIfAborted(params.signal);
    const mimeType = data.mimeType || "image/jpeg";
    const blob = base64ToBlob(data.b64, mimeType);
    throwIfAborted(params.signal);
    const mediaRef = await storeMediaBlob(blob, mimeType, "image");
    throwIfAborted(params.signal);
    return {
        mediaRef,
        dataUrl: `data:${mimeType};base64,${data.b64}`,
        blob,
        mimeType,
        prompt: description,
        usedReferenceImage: false,
        revisedPrompt: data.revisedPrompt,
    };
  }

  // ── Google Imagen（需 Key，经服务端转发）──
  if (settings.provider === "google-imagen") {
    const gi = settings.googleImagen;
    if (!description || !gi?.apiKey?.trim()) return null;
    throwIfAborted(params.signal);
    const data = await generateGoogleImagenViaServer({ settings, prompt: description, signal: params.signal });
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
        prompt: description,
        usedReferenceImage: false,
        revisedPrompt: data.revisedPrompt,
    };
  }

  // ── OpenAI 兼容（原有逻辑）──
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

  // 统一走 Vercel 服务器中转（与 NAI 分支一致）：浏览器只连国内 Vercel，
  // 由海外服务器调 api.openai.com，避免国内网络直连被墙（"不能跨境"）。
  // 仅当用户显式配置了通用代理(IMAGE_GEN_PROXY_URL)时走代理，否则走服务端路由。
  // v19：与 NAI 对等 —— 透传 participants/场景/锁脸参考图，让 OAI 也享结构化提示词+参考图锁脸。
  const data = await generateImageViaServerOrProxy({
    settings,
    prompt,
    referenceImageDataUrl,
    participants: params.participants,
    referenceImages: params.referenceImages,
    sceneBackground: params.sceneBackground,
    sceneLighting: params.sceneLighting,
    signal: params.signal,
  });

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
