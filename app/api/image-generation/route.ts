import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, type Dispatcher } from "undici";

export const maxDuration = 120;

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
        width,
        height,
        scale: typeof input.novelaiCfgScale === "number" ? input.novelaiCfgScale : 5,
        sampler: (input.novelaiSampler || "euler_ancestral").replace(/^k_/, "k_").replace("euler_ancestral", "k_euler_ancestral"),
        steps: typeof input.novelaiSteps === "number" ? Math.max(1, Math.min(150, input.novelaiSteps)) : 28,
        seed: typeof input.novelaiSeed === "string" && input.novelaiSeed ? parseInt(input.novelaiSeed, 10) || -1 : -1,
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
      },
    });

    // ── 诊断日志（Vercel Dashboard → Functions → Logs 可查看）──
    const diag = {
      ts: new Date().toISOString(),
      model: input.novelaiModel || "nai-diffusion-4-5-full",
      size: `${width}x${height}`,
      sizeStr,
      promptLen: finalPrompt.length,
      prefixLen: (input.novelaiPositivePrefix || "").length,
      suffixLen: (input.novelaiQualitySuffix || "").length,
      bodySize: body.length,
      steps: typeof input.novelaiSteps === "number" ? input.novelaiSteps : 28,
      sampler: input.novelaiSampler || "euler_ancestral",
      hasSm: !!input.novelaiSmeaDyn,
      endpointMode: input.novelaiEndpointMode || "normal",
    };
    console.log("[NAI-DIAG] request:", JSON.stringify(diag));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000); // 5min
    let res: Response;
    try {
      res = await externalFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${naiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // 收集 NAI 响应头辅助诊断
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      console.log("[NAI-DIAG] error:", JSON.stringify({
        naiStatus: res.status,
        naiHeaders: respHeaders,
        errBody: errText.slice(0, 1000),
        ...diag,
      }));
      return { status: 502, body: {
        error: `NovelAI API 错误 ${res.status}: ${errText.slice(0, 600)}`,
        _diag: {
          promptPreview: finalPrompt.slice(0, 200),
          model: diag.model,
          size: diag.size,
          bodySize: diag.bodySize,
          naiResponseHeaders: respHeaders,
        },
      } };
    }

    const json = await res.json() as Record<string, unknown>;
    const artifacts = json.artifacts as Array<Record<string, unknown>> | undefined;
    if (!artifacts || !artifacts.length) {
      return { status: 502, body: { error: `NovelAI 返回格式异常：${JSON.stringify(Object.keys(json)).slice(0, 200)}` } };
    }

    const b64 = artifacts[0].base64 as string | undefined;
    if (!b64) return { status: 502, body: { error: "NovelAI 返回的图片数据为空" } };

    console.log("[NAI-DIAG] success:", JSON.stringify({ ...diag, imgSize: (b64.length * 3 / 4) >>> 0 }));

    return {
      status: 200,
      body: {
        b64,
        mimeType: (artifacts[0].type as string) || "image/png",
        revisedPrompt: finalPrompt,
      },
    };
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
