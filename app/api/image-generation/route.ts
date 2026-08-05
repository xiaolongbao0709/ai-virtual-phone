import { NextRequest, NextResponse } from "next/server";
import zlib from "node:zlib";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * NovelAI /ai/generate-image 返回的是一个 ZIP 二进制（内含 image_0.png），
 * 不是 JSON。这里做最小 ZIP 解包：支持 stored(0) 与 deflate(8)。
 */
function extractFirstFileFromZip(buf: Buffer): Buffer | null {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return null;

  const flags = buf.readUInt16LE(6);
  const method = buf.readUInt16LE(8);
  const fnlen = buf.readUInt16LE(26);
  const exlen = buf.readUInt16LE(28);
  const start = 30 + fnlen + exlen;

  let csize = buf.readUInt32LE(18);

  // 使用 data descriptor 时 local header 内的大小为 0，需回退到中央目录
  const cdSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  if ((flags & 0x08) !== 0 || csize === 0 || start + csize > buf.length) {
    const cdIdx = buf.indexOf(cdSig);
    if (cdIdx > start) {
      const fromCd = buf.readUInt32LE(cdIdx + 20);
      csize = fromCd > 0 && start + fromCd <= buf.length ? fromCd : cdIdx - start;
    } else {
      csize = buf.length - start;
    }
  }

  const raw = buf.subarray(start, start + csize);
  if (method === 0) return raw;
  if (method === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null;
}

type ImageGenerationRequest = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  prompt?: string;
  size?: string;
  quality?: string;
  referenceImageDataUrl?: string;
  /** Provider 类型 */
  provider?: "openai" | "novelai" | "google-imagen";
  /** NovelAI 专属配置（provider=novelai 时使用） */
  novelaiUrl?: string;
  novelaiKey?: string;
  novelaiModel?: string;
  novelaiSize?: string;
  novelaiPositivePrefix?: string;
  novelaiQualitySuffix?: string;
  novelaiNegativePrompt?: string;
  novelaiPromptTemplate?: string;
  // ---- 新增高级参数 ----
  novelaiSteps?: number;
  novelaiCfgScale?: number;
  novelaiSampler?: string;
  novelaiNoiseSchedule?: string;
  novelaiSeed?: string | null;
  novelaiStyleStrength?: number;
  novelaiUcPreset?: number;
  novelaiQualityTags?: boolean;
  novelaiSmea?: boolean;
  novelaiSmeaDyn?: boolean;
  novelaiEndpointMode?: "stream" | "normal";
  /** Google Imagen 专属配置（provider=google-imagen 时使用） */
  googleKey?: string;
  googleModel?: string;
  googleWidth?: number;
  googleHeight?: number;
  googleNegativePrompt?: string;
  googleAspectRatio?: string;
  googlePersonGeneration?: string;
};

type ExtractedImage =
  | { kind: "b64"; b64: string; mimeType?: string; revisedPrompt?: string }
  | { kind: "url"; url: string; revisedPrompt?: string };

function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
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

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } | null {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) return null;
  const mimeType = match[1] || "image/png";
  const buffer = Buffer.from(match[2], "base64");
  return { blob: new Blob([buffer], { type: mimeType }), mimeType };
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

async function externalFetch(url: string, init: RequestInit): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  return dispatcher
    ? fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher })
    : fetch(url, init);
}

async function fetchImageUrl(url: string): Promise<{ b64: string; mimeType: string }> {
  const res = await externalFetch(url, { method: "GET" });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`图片 URL 下载失败 ${res.status}: ${err.slice(0, 160)}`);
  }
  const mimeType = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { b64: buffer.toString("base64"), mimeType };
}

// ── NovelAI 服务端生图 ──────────────────────────────────────────

const NAI_SIZE_MAP: Record<string, [number, number]> = {
    "832x1216": [832, 1216],
    "1216x832": [1216, 832],
    "1024x1024": [1024, 1024],
    "832x832": [832, 832],
    "1280x720": [1280, 720],
    "720x1280": [720, 1280],
};

function buildNaiPrompt(prompt: string, input: ImageGenerationRequest): string {
    const template = input.novelaiPromptTemplate || "{prompt}";
    return template
        .replace(/\{positive_prefix\}/gi, input.novelaiPositivePrefix || "")
        .replace(/\{quality_suffix\}/gi, input.novelaiQualitySuffix || "best quality, very aesthetic, masterpiece")
        .replace(/\{prompt\}/gi, prompt);
}

async function runNovelAIImageGeneration(input: ImageGenerationRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const naiKey = input.novelaiKey?.trim();
    // 空白 = 内置官方地址（与棉花糖机一致：地址写死、用户无需填写）
    const naiUrl = (input.novelaiUrl?.trim() || "https://image.novelai.net");
    const prompt = input.prompt?.trim();

    if (!naiKey) return { status: 400, body: { error: "缺少 NovelAI API Key" } };
    if (!prompt) return { status: 400, body: { error: "缺少提示词" } };

    const baseUrl = naiUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/ai/generate-image`;
    const sizeStr = input.novelaiSize || "832x1216";
    const [width, height] = NAI_SIZE_MAP[sizeStr] || ([832, 1216] as [number, number]);
    const finalPrompt = buildNaiPrompt(prompt, input);

    const body = JSON.stringify({
      input: finalPrompt,
      model: input.novelaiModel || "nai-diffusion-4-5-full",
      action: "generate",
      parameters: {
        params_version: 3,
        width,
        height,
        scale: typeof input.novelaiCfgScale === "number" ? input.novelaiCfgScale : 5,
        sampler: (input.novelaiSampler || "euler_ancestral").replace(/^k_/, "k_").replace("euler_ancestral", "k_euler_ancestral"),
        steps: typeof input.novelaiSteps === "number" ? Math.max(1, Math.min(150, input.novelaiSteps)) : 28,
        seed: (typeof input.novelaiSeed === "string" && input.novelaiSeed?.trim())
            ? (parseInt(input.novelaiSeed, 10) || Math.floor(Math.random() * 999999999))
            : Math.floor(Math.random() * 999999999),
        negative_prompt: input.novelaiNegativePrompt || "",
        ucPreset: typeof input.novelaiUcPreset === "number" ? input.novelaiUcPreset : 0,
        add_original_image: false,
        cfg_rescale: 0,
        controlnet_strength: 1,
        dynamic_thresholding: false,
        legacy: false,
        quality_toggle: true,
        sm: !!input.novelaiSmeaDyn,
        sm_dyn: !!input.novelaiSmeaDyn,
        uncond_scale: 1,
        noise_schedule: input.novelaiNoiseSchedule || "native",
        legacy_v3_extend: false,
        smea_dy: !!input.novelaiSmeaDyn,
        smea_static: !!input.novelaiSmea,
        smea: !!input.novelaiSmea,
        ref_sw: false,
        decr_countdown: false,
        v4_prompt: {
          caption: { base_caption: finalPrompt, char_captions: [] },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: { base_caption: input.novelaiNegativePrompt || "", char_captions: [] },
          legacy_uc: false,
        },
      },
    });

    // 使用全局 fetch（底层 undici，自动协商 HTTP/2）。
    // 关键：NAI 在 Vercel 上对 HTTP/1.1（原生 https 模块）会静默挂起，
    // 必须走 HTTP/2 通道才能拿到响应。
    const t0 = Date.now();
    let tHead = 0, tFirstByte = 0, received = 0;
    let naiResponse: {
      status: number;
      headers: Record<string, string>;
      body: Buffer;
      timeline?: Record<string, number>;
      error?: string;
    } = { status: 0, headers: {}, body: Buffer.alloc(0) };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100_000);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${naiKey}`,
          Accept: "*/*",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        },
        body,
        signal: controller.signal,
      });
      tHead = Date.now();
      const ab = await resp.arrayBuffer();
      received = ab.byteLength;
      tFirstByte = tHead;
      naiResponse = {
        status: resp.status,
        headers: {},
        body: Buffer.from(ab),
        timeline: { t0, tConnect: 0, tHead, tFirstByte },
      };
      clearTimeout(timer);
    } catch (err) {
      naiResponse = {
        status: 0,
        headers: {},
        body: Buffer.alloc(0),
        timeline: { t0, tConnect: 0, tHead, tFirstByte },
        error: (err as Error).message,
      };
    }

    if (naiResponse.error || naiResponse.status === 0) {
      return {
        status: 502,
        body: {
          error: `NovelAI 连接失败: ${naiResponse.error || "无响应"}`,
          _debug: {
            timeline: naiResponse.timeline,
            tConnectMs: tConnect ? tConnect - t0 : null,
            tHeadMs: tHead ? tHead - t0 : null,
            tFirstByteMs: tFirstByte ? tFirstByte - t0 : null,
            receivedBytes: received,
            requestedUrl: url,
          },
        },
      };
    }

    if (naiResponse.status !== 200) {
      const errText = naiResponse.body.toString("utf-8", 0, 800);
      return {
        status: 502,
        body: {
          error: `NovelAI API 错误 ${naiResponse.status}: ${errText.slice(0, 800)}`,
          _debug: {
            naiStatus: naiResponse.status,
            naiHeaders: naiResponse.headers,
            naiBodyPreview: errText.slice(0, 500),
            requestedUrl: url,
          },
        },
      };
    }

    // NovelAI 成功时返回 ZIP 二进制（内含 image_0.png），不是 JSON
    const buffer = naiResponse.body;

    // 情况一：标准 ZIP 包
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
      const png = extractFirstFileFromZip(buffer);
      if (!png || png.length === 0) {
        return { status: 502, body: { error: "NovelAI 返回的 ZIP 解包失败" } };
      }
      return {
        status: 200,
        body: {
          b64: png.toString("base64"),
          mimeType: "image/png",
          revisedPrompt: finalPrompt,
        },
      };
    }

    // 情况二：直接返回裸 PNG
    if (buffer.length > 8 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
      return {
        status: 200,
        body: {
          b64: buffer.toString("base64"),
          mimeType: "image/png",
          revisedPrompt: finalPrompt,
        },
      };
    }

    // 情况三：兼容旧版 / 反代返回的 JSON 结构
    try {
      const json = JSON.parse(buffer.toString("utf-8")) as Record<string, unknown>;
      const artifacts = json.artifacts as Array<Record<string, unknown>> | undefined;
      const b64 = artifacts?.[0]?.base64 as string | undefined;
      if (b64) {
        return {
          status: 200,
          body: {
            b64,
            mimeType: (artifacts?.[0]?.type as string) || "image/png",
            revisedPrompt: finalPrompt,
          },
        };
      }
      return {
        status: 502,
        body: { error: `NovelAI 返回格式异常：${JSON.stringify(Object.keys(json)).slice(0, 200)}` },
      };
    } catch {
      return {
        status: 502,
        body: { error: `NovelAI 返回未知格式，前16字节：${buffer.subarray(0, 16).toString("hex")}` },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.toLowerCase().includes("abort") ? 504 : 502;
    return { status, body: { error: message } };
  }
}

// ── Google Imagen 服务端生图（OpenAI 兼容端点）─────────────────────
const GOOGLE_IMAGEN_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/images:generations";

async function runGoogleImagenImageGeneration(input: ImageGenerationRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const apiKey = input.googleKey?.trim();
    const prompt = input.prompt?.trim();
    if (!apiKey) return { status: 400, body: { error: "缺少 Google API Key" } };
    if (!prompt) return { status: 400, body: { error: "缺少提示词" } };

    const model = input.googleModel?.trim() || "imagen-3.0-generate-002";
    const width = typeof input.googleWidth === "number" ? input.googleWidth : 1024;
    const height = typeof input.googleHeight === "number" ? input.googleHeight : 1024;

    const body: Record<string, unknown> = {
      model,
      prompt,
      n: 1,
      size: `${width}x${height}`,
      response_format: "b64_json",
    };
    if (input.googleNegativePrompt?.trim()) body.negative_prompt = input.googleNegativePrompt.trim();
    if (input.googleAspectRatio?.trim()) body.aspect_ratio = input.googleAspectRatio.trim();
    if (input.googlePersonGeneration?.trim()) body.person_generation = input.googlePersonGeneration.trim();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    let res: Response;
    try {
      res = await externalFetch(GOOGLE_IMAGEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { status: 502, body: { error: `Google Imagen API 错误 ${res.status}: ${errText.slice(0, 600)}` } };
    }

    const json = await res.json() as Record<string, unknown>;
    const extracted = extractFromObject(json);
    if (!extracted) {
      return { status: 502, body: { error: `Google Imagen 返回格式异常：${JSON.stringify(Object.keys(json || {})).slice(0, 200)}` } };
    }
    if (extracted.kind === "url") {
      const downloaded = await fetchImageUrl(extracted.url);
      return { status: 200, body: { ...downloaded, revisedPrompt: extracted.revisedPrompt } };
    }
    return {
      status: 200,
      body: { b64: extracted.b64, mimeType: extracted.mimeType || "image/png", revisedPrompt: extracted.revisedPrompt },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.toLowerCase().includes("abort") ? 504 : 502;
    return { status, body: { error: message } };
  }
}

// ── 原有 OpenAI 兼容生图 ──────────────────────────────────────────

async function runImageGeneration(input: ImageGenerationRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const apiKey = input.apiKey?.trim();
    const baseUrl = input.baseUrl?.trim();
    const model = input.model?.trim();
    const prompt = input.prompt?.trim();
    const hasReference = Boolean(input.referenceImageDataUrl?.trim());

    if (!apiKey) return { status: 400, body: { error: "缺少 API Key" } };
    if (!baseUrl) return { status: 400, body: { error: "缺少 Base URL" } };
    if (!model) return { status: 400, body: { error: "缺少模型名" } };
    if (!prompt) return { status: 400, body: { error: "缺少提示词" } };

    const url = buildImageUrl(baseUrl, hasReference ? "edits" : "generations");
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    let body: BodyInit;

    if (hasReference) {
      const converted = dataUrlToBlob(input.referenceImageDataUrl || "");
      if (!converted) return { status: 400, body: { error: "参考图格式无效" } };
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      if (input.size && input.size !== "auto") form.set("size", input.size);
      if (input.quality && input.quality !== "auto") form.set("quality", input.quality);
      form.append("image", converted.blob, `reference.${converted.mimeType.split("/")[1] || "png"}`);
      body = form;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        model,
        prompt,
        ...(input.size && input.size !== "auto" ? { size: input.size } : {}),
        ...(input.quality && input.quality !== "auto" ? { quality: input.quality } : {}),
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let res: Response;
    try {
      res = await externalFetch(url, { method: "POST", headers, body, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { status: 502, body: { error: `生图 API 错误 ${res.status}: ${errText.slice(0, 600)}` } };
    }

    if (contentType.startsWith("image/")) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: 200, body: { b64: buffer.toString("base64"), mimeType: contentType } };
    }

    const json = await res.json();
    const extracted = extractFromObject(json);
    if (!extracted) {
      return { status: 502, body: { error: `生图 API 返回中没有找到图片字段：${JSON.stringify(Object.keys(json || {})).slice(0, 200)}` } };
    }

    if (extracted.kind === "url") {
      const downloaded = await fetchImageUrl(extracted.url);
      return { status: 200, body: { ...downloaded, revisedPrompt: extracted.revisedPrompt } };
    }

    return {
      status: 200,
      body: {
        b64: extracted.b64,
        mimeType: extracted.mimeType || "image/png",
        revisedPrompt: extracted.revisedPrompt,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.toLowerCase().includes("abort") ? 504 : 502;
    return { status, body: { error: message } };
  }
}

const IMAGE_STREAM_RESULT_MARKER = "@@RESULT@@";

export async function POST(req: NextRequest) {
  let input: ImageGenerationRequest;
  try {
    input = await req.json() as ImageGenerationRequest;
  } catch {
    return NextResponse.json({ error: "请求体不是有效 JSON" }, { status: 400 });
  }

  // ── Provider 路由：NovelAI 走专属逻辑 ──
  if (input.provider === "novelai") {
    // 心跳流式模式同样支持
    if (req.headers.get("x-stream-heartbeat") === "1") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let finished = false;
          const heartbeat = setInterval(() => {
            if (!finished) {
              try { controller.enqueue(encoder.encode(" ")); } catch { /* */ }
            }
          }, 3000);
          runNovelAIImageGeneration(input)
            .then(({ status, body }) => {
              controller.enqueue(encoder.encode("\n" + IMAGE_STREAM_RESULT_MARKER + JSON.stringify({ httpStatus: status, ...body })));
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              try {
                controller.enqueue(encoder.encode("\n" + IMAGE_STREAM_RESULT_MARKER + JSON.stringify({ httpStatus: 502, error: message })));
              } catch { /* */ }
            })
            .finally(() => {
              finished = true;
              clearInterval(heartbeat);
              try { controller.close(); } catch { /* */ }
            });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    const { status, body } = await runNovelAIImageGeneration(input);
    return NextResponse.json(body, { status });
  }

  // ── Google Imagen（OpenAI 兼容端点）──
  if (input.provider === "google-imagen") {
    if (req.headers.get("x-stream-heartbeat") === "1") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let finished = false;
          const heartbeat = setInterval(() => {
            if (!finished) {
              try { controller.enqueue(encoder.encode(" ")); } catch { /* */ }
            }
          }, 3000);
          runGoogleImagenImageGeneration(input)
            .then(({ status, body }) => {
              controller.enqueue(encoder.encode("\n" + IMAGE_STREAM_RESULT_MARKER + JSON.stringify({ httpStatus: status, ...body })));
            })
            .catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              try {
                controller.enqueue(encoder.encode("\n" + IMAGE_STREAM_RESULT_MARKER + JSON.stringify({ httpStatus: 502, error: message })));
              } catch { /* */ }
            })
            .finally(() => {
              finished = true;
              clearInterval(heartbeat);
              try { controller.close(); } catch { /* */ }
            });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    const { status, body } = await runGoogleImagenImageGeneration(input);
    return NextResponse.json(body, { status });
  }

  // ── OpenAI 兼容（原有逻辑）──
  // 这样托管平台(Netlify 等)按"流式响应"计时,不会因为上游生图慢(30~120s)
  // 而在缓冲模式的 10~26s 上限处直接 504。旧客户端不带该头时行为不变。
  if (req.headers.get("x-stream-heartbeat") === "1") {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let finished = false;
        const heartbeat = setInterval(() => {
          if (!finished) {
            try { controller.enqueue(encoder.encode(" ")); } catch { /* 流已关闭 */ }
          }
        }, 3000);
        runImageGeneration(input)
          .then(({ status, body }) => {
            controller.enqueue(encoder.encode("\n" + IMAGE_STREAM_RESULT_MARKER + JSON.stringify({ httpStatus: status, ...body })));
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            try {
              controller.enqueue(encoder.encode("\n" + IMAGE_STREAM_RESULT_MARKER + JSON.stringify({ httpStatus: 502, error: message })));
            } catch { /* 流已关闭 */ }
          })
          .finally(() => {
            finished = true;
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* 已关闭 */ }
          });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const { status, body } = await runImageGeneration(input);
  return NextResponse.json(body, { status });
}
