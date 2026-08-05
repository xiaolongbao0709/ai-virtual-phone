import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, type Dispatcher } from "undici";
import JSZip from "jszip";

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
  /** NovelAI NSFW 模式：true 时向 NAI 发送 nsfw:true，允许生成成人内容 */
  novelaiNsfw?: boolean;
  /** 参与者外观描述（中文），翻译后拼入 prompt，让 NAI 区分「谁是谁」 */
  participantAppearance?: string;
  /** 结构化参与者（中文）：人物名 + 锚点形容 + 动作，用于拼装「人物名(锚点) 动作」格式 */
  participants?: Array<{ name: string; anchor?: string; action?: string }>;
  /** 背景描述（中文），如「樱花公园」 */
  sceneBackground?: string;
  /** 光源描述（中文），如「逆光、暖色夕阳」 */
  sceneLighting?: string;
  /** 参与者头像（data URL，base64），用于 NAI character_reference 锁脸 */
  referenceImages?: string[];
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

// ── 结构化场景提示词拼装（v19：NAI 与 OpenAI 共用）──
// 顺序：背景 → 光源 → 各参与者(人物名(锚点形容) 动作) → 用户原文([照片:]内容)
// 这样无论哪个 provider，提示词都是「谁是谁 + 在哪 + 什么光 + 在做什么」的统一格式。
function buildStructuredChinesePrompt(input: ImageGenerationRequest): string {
    const parts: string[] = [];
    if (input.sceneBackground?.trim()) parts.push(input.sceneBackground.trim());
    if (input.sceneLighting?.trim()) parts.push(input.sceneLighting.trim());
    if (input.participants?.length) {
        for (const p of input.participants) {
            const name = (p.name || "").trim();
            const anchor = (p.anchor || "").trim();
            const action = (p.action || "").trim();
            if (!name && !anchor && !action) continue;
            let clause = name || "某人";
            if (anchor) clause += `（${anchor}）`;
            if (action) clause += ` ${action}`;
            parts.push(clause);
        }
    }
    // 用户原文（[照片:] 内容 = 动作 / 场景描述）；OAI 路径里此处已含 extraPrompt 质量标签
    if (input.prompt?.trim()) parts.push(input.prompt.trim());
    // 兼容旧字段 participantAppearance（未传结构化 participants 时）
    if ((!input.participants || input.participants.length === 0) && input.participantAppearance?.trim()) {
        parts.push(input.participantAppearance.trim());
    }
    return parts.join("。");
}

// 检测是否含中日韩字符（中文提示词需要翻译给 NAI）
function containsCJK(text: string): boolean {
    return /[一-鿿぀-ヿ㐀-䶿豈-﫿ｦ-ﾟ]/.test(text);
}

// ── 多源中文→英文翻译（NAI 不识别中文 tag）──
// 优先级：Google Translate 免费接口 → MyMemory → 保留原文
// 所有翻译失败都不阻断生图（返回原文让 NAI 尝试）
async function translateToEnglish(text: string): Promise<string> {
    // 源1：Google Translate 免费接口（非官方但广泛使用、速度快）
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gsl&sl=zh-CN&tl=en&dt=t&q=${encodeURIComponent(text)}`;
        const res = await externalFetch(url, { 
            method: "GET",
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
            const json = await res.json() as unknown;
            // Google 返回格式：[[["translated text","original text",...],...],...]
            if (Array.isArray(json) && Array.isArray(json[0])) {
                const translated = (json[0] as unknown[][])
                    .map((segment: unknown[]) => segment?.[0] as string)
                    .filter(Boolean)
                    .join("");
                if (translated && translated !== text) {
                    console.log("[TRANSLATE] google ok:", text.slice(0, 50), "→", translated.slice(0, 50));
                    return translated.trim();
                }
            }
        }
    } catch (err) {
        console.log("[TRANSLATE] google failed:", typeof err === "object" && err instanceof Error ? err.message : String(err));
    }

    // 源2：MyMemory 免费翻译（fallback）
    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=zh|en`;
        const res = await externalFetch(url, { 
            method: "GET", 
            signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
            const data = await res.json() as { responseData?: { translatedText?: string } };
            const t = data.responseData?.translatedText;
            if (t && t.trim() && t.trim() !== text) {
                console.log("[TRANSLATE] mymemory ok:", text.slice(0, 50), "→", t.trim().slice(0, 50));
                return t.trim();
            }
        }
    } catch (err) {
        console.log("[TRANSLATE] mymemory failed:", typeof err === "object" && err instanceof Error ? err.message : String(err));
    }

    // 全部失败，返回原文（不阻断）
    console.log("[TRANSLATE] all failed, keeping original:", text.slice(0, 50));
    return text;
}

async function runNovelAIImageGeneration(input: ImageGenerationRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const naiKey = input.novelaiKey?.trim();
    // 空白 = 内置官方地址（与棉花糖机一致：地址写死、用户无需填写）
    const naiUrl = (input.novelaiUrl?.trim() || "https://image.novelai.net");
    const rawPrompt = input.prompt?.trim();

    if (!naiKey) return { status: 400, body: { error: "缺少 NovelAI API Key" } };
    if (!rawPrompt) return { status: 400, body: { error: "缺少提示词" } };

    // ── 结构化场景提示词拼装（v19：NAI 与 OpenAI 共用 buildStructuredChinesePrompt）──
    const rawChinese = buildStructuredChinesePrompt(input);

    // 整段中文翻译为英文（NAI 不识别中文 tag；翻译失败则保留原文）
    let finalUserPrompt = rawChinese;
    const hasCJK = containsCJK(rawChinese);
    if (hasCJK) {
        try {
            finalUserPrompt = await translateToEnglish(rawChinese);
            console.log("[NAI-PROMPT] translated scene:", { from: rawChinese.slice(0, 80), to: finalUserPrompt.slice(0, 80), changed: finalUserPrompt !== rawChinese });
        } catch (e) {
            console.log("[NAI-PROMPT] translate error:", e);
        }
    }

    const baseUrl = naiUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/ai/generate-image`;
    const sizeStr = input.novelaiSize || "832x1216";
    const [width, height] = NAI_SIZE_MAP[sizeStr] || ([832, 1216] as [number, number]);
    const finalPrompt = buildNaiPrompt(finalUserPrompt, input);

    const seedValue = (typeof input.novelaiSeed === "string" && input.novelaiSeed ? parseInt(input.novelaiSeed, 10) : 0) || Math.floor(Math.random() * 2 ** 53);
    // ── 完全对齐 7xrk/novelai-api（权威SDK源码）──
    // 参考：https://github.com/7xrk/novelai-api/blob/main/src/high_level/generateImage.ts
    //       https://github.com/7xrk/novelai-api/blob/main/src/high_level/consts.ts
    // v9: 逐字段对照SDK的getGenerateImageParams()，消除所有差异

    // Sampler 名称映射（必须带 k_ 前缀）
    const rawSampler = input.novelaiSampler || "euler_ancestral";
    const samplerMap: Record<string, string> = {
      "euler": "k_euler", "k_euler": "k_euler",
      "euler_ancestral": "k_euler_ancestral", "k_euler_ancestral": "k_euler_ancestral",
      "dpmpp_2m": "k_dpmpp_2m", "k_dpmpp_2m": "k_dpmpp_2m",
      "dpmpp_2m_sde": "k_dpmpp_2m_sde", "k_dpmpp_2m_sde": "k_dpmpp_2m_sde",
      "dpmpp_2s_ancestral": "k_dpmpp_2s_ancestral", "k_dpmpp_2s_ancestral": "k_dpmpp_2s_ancestral",
    };
    const apiSampler = samplerMap[rawSampler] || "k_euler";

    // noise_schedule（小写）
    const rawNoise = input.novelaiNoiseSchedule || "karras";
    const noiseMap: Record<string, string> = {
      "native": "native", "karras": "karras",
      "exponential": "exponential", "polyexponential": "polyexponential",
    };
    let apiNoise = noiseMap[rawNoise] || "karras";
    // SDK行为：V4X模型下native自动转karras
    if (apiNoise === "native") apiNoise = "karras";

    const parameters: Record<string, unknown> = {
      // ── 基础参数（与SDK完全一致）──
      nsfw: input.novelaiNsfw === true,   // NSFW 模式：true 向 NAI 关闭内容过滤，允许成人内容（默认 false = 启用过滤）
      cfg_rescale: 0,
      controlnet_strength: 1,
      dynamic_thresholding: true,
      skip_cfg_above_sigma: null,
      legacy: false,
      legacy_uc: false,
      legacy_v3_extend: false,
      n_samples: 1,
      negative_prompt: input.novelaiNegativePrompt || "",
      params_version: 3,
      noise_schedule: apiNoise,
      qualityToggle: false,
      sampler: apiSampler,
      scale: typeof input.novelaiCfgScale === "number" ? input.novelaiCfgScale : 5,
      seed: seedValue,
      sm: false,           // V4.5模型不支持smea
      sm_dyn: false,
      autoSmea: false,
      steps: typeof input.novelaiSteps === "number" ? Math.max(1, Math.min(50, input.novelaiSteps)) : 28,
      width,
      height,

      // ── V4/V4.5 模型额外参数 ──
      use_coords: false,
      prefer_brownian: true,
      deliberate_euler_ancestral_bug: false,   // ⚠️ SDK用false，不是true！

      // ── V4/V4.5 必需的结构化提示词（严格按SDK格式）──
      v4_negative_prompt: {
        legacy_uc: false,
        caption: { base_caption: input.novelaiNegativePrompt || "", char_captions: [] },
      },
      v4_prompt: {
        use_coords: false,
        use_order: true,
        caption: { base_caption: finalPrompt, char_captions: [] },
      },
      // ⚠️ 不发送ucPreset！SDK只在客户端用它拼接negative_prompt标签，不传给NAI API
    };

    // ── 参考图锁脸（NAI V4.5 character_reference，仅 V4.5 模型生效）──
    // 把参与者头像作为参考图注入，让 NAI 锁定各自外貌/脸。type="character" 只传外观、保留生图风格。
    if (input.referenceImages?.length) {
        const refs = input.referenceImages
            .map((d) => (d && d.startsWith("data:") ? cleanBase64(d).b64 : null))
            .filter(Boolean)
            .slice(0, 4)
            .map((b64) => ({ image: b64, type: "character", strength: 1, fidelity: 0.75 }));
        if (refs.length) {
            (parameters as Record<string, unknown>).character_reference = refs;
            console.log("[NAI-PROMPT] character_reference 注入数量:", refs.length);
        }
    }
    const body = JSON.stringify({
      input: finalPrompt,
      model: input.novelaiModel || "nai-diffusion-4-5-full",
      action: "generate",
      parameters,
    });

    // ── 诊断日志（Vercel Dashboard → Functions → Logs 可查看）──
    const diag = {
      _codeVersion: "v19",  // v19=结构化场景提示词(NAI/OAI共用) + 参考图锁脸；OAI 现与 NAI 对等
      ts: new Date().toISOString(),
      model: input.novelaiModel || "nai-diffusion-4-5-full",
      size: `${width}x${height}`,
      sizeStr,
      rawPromptLen: rawPrompt.length,
      promptLen: finalPrompt.length,
      prefixLen: (input.novelaiPositivePrefix || "").length,
      suffixLen: (input.novelaiQualitySuffix || "").length,
      bodySize: body.length,
      steps: typeof input.novelaiSteps === "number" ? input.novelaiSteps : 28,
      sampler: apiSampler,
      noiseSchedule: apiNoise,
      paramsV: 3,
      hasCJK,
      translated: hasCJK ? finalUserPrompt !== rawPrompt : undefined,
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
        error: `NovelAI API 错误 ${res.status}: ${errText.slice(0, 400)} [DIAG: ${diag._codeVersion} model=${diag.model} size=${diag.size} sampler=${diag.sampler} noise=${diag.noiseSchedule} paramsV=${diag.paramsV} bodySize=${diag.bodySize} hasCJK=${diag.hasCJK} translated=${diag.translated}]`,
        _diag: {
          promptPreview: finalPrompt.slice(0, 200),
          model: diag.model,
          size: diag.size,
          bodySize: diag.bodySize,
          naiResponseHeaders: respHeaders,
        },
      } };
    }

    // ── NAI 响应解析 ──
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    console.log("[NAI-DIAG] response:", JSON.stringify({
      ...diag,
      naiStatus: res.status,
      contentType,
      contentLength: res.headers.get("content-length"),
    }));

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { status: 502, body: {
        error: `NovelAI API 错误 ${res.status}: ${errText.slice(0, 400)} [DIAG: ${diag._codeVersion} model=${diag.model} size=${diag.size} sampler=${diag.sampler} noise=${diag.noiseSchedule} paramsV=${diag.paramsV} bodySize=${diag.bodySize} hasCJK=${diag.hasCJK} translated=${diag.translated}]`,
      } };
    }

    const arrayBuffer = await res.arrayBuffer();

    // 情况1：ZIP 文件（NAI 默认返回格式，内含 image_0.png）
    if (
      contentType.includes("application/zip") ||
      contentType.includes("application/octet-stream") ||
      !contentType.startsWith("application/json")
    ) {
      try {
        const zip = await JSZip.loadAsync(arrayBuffer);
        // 优先找 image_0.png，其次首个 png 文件
        let pngFile =
          zip.file("image_0.png") ||
          Object.values(zip.files).find(
            (f) => !f.dir && /\.png$/i.test(f.name)
          );
        if (pngFile) {
          const pngBuffer = await pngFile.async("nodebuffer");
          const b64 = pngBuffer.toString("base64");
          console.log("[NAI-DIAG] success ZIP:", JSON.stringify({ ...diag, imgSize: pngBuffer.length, fileName: pngFile.name }));
          return { status: 200, body: { b64, mimeType: "image/png", revisedPrompt: finalPrompt } };
        }
        // ZIP 里没有 png — 尝试把整个 ZIP 当二进制图片（罕见情况）
        const b64 = Buffer.from(arrayBuffer).toString("base64");
        console.log("[NAI-DIAG] success binary:", JSON.stringify({ ...diag, imgSize: arrayBuffer.byteLength }));
        return { status: 200, body: { b64, mimeType: "image/png", revisedPrompt: finalPrompt } };
      } catch (zipErr) {
        console.log("[NAI-DIAG] zip_parse_err:", String(zipErr));
        // ZIP 解析失败，降级尝试 JSON
      }
    }

    // 情况2：JSON 响应 {artifacts:[{base64}]}
    try {
      const json = await res.json() as Record<string, unknown>;
      const artifacts = json.artifacts as Array<Record<string, unknown>> | undefined;
      if (artifacts && artifacts.length) {
        const b64 = artifacts[0].base64 as string | undefined;
        if (b64) {
          console.log("[NAI-DIAG] success JSON:", JSON.stringify({ ...diag, imgSize: (b64.length * 3 / 4) >>> 0 }));
          return { status: 200, body: { b64, mimeType: (artifacts[0].type as string) || "image/png", revisedPrompt: finalPrompt } };
        }
      }
      return { status: 502, body: { error: `NovelAI 返回格式异常：${JSON.stringify(Object.keys(json)).slice(0, 200)}` } };
    } catch {
      return { status: 502, body: { error: `NovelAI 响应无法解析 [contentType=${contentType}]` } };
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
    const rawPrompt = input.prompt?.trim();

    if (!rawPrompt) return { status: 400, body: { error: "缺少提示词" } };

    // ── 结构化场景提示词拼装（与 NAI 一致：背景 + 光源 + 人物名(锚点) + 动作 + 用户原文）──
    // GPT(OpenAI) 同样吃中文，但翻译为英文质量更稳定，故整段翻译。
    const rawChinese = buildStructuredChinesePrompt(input);
    let finalPrompt = rawChinese;
    const hasCJK = containsCJK(rawChinese);
    if (hasCJK) {
      try {
        finalPrompt = await translateToEnglish(rawChinese);
        console.log("[OAI-PROMPT] translated:", { from: rawChinese.slice(0, 80), to: finalPrompt.slice(0, 80) });
      } catch (e) {
        console.log("[OAI-PROMPT] translate error:", e);
      }
    }

    const hasReference = Boolean(input.referenceImages?.length) || Boolean(input.referenceImageDataUrl?.trim());
    // 锁脸提示（GPT 尽力而为：用参考图保留每个人脸与身份；GPT 无 NAI 那种强锁脸，靠此提示+参考图）
    if (hasReference) {
      finalPrompt += ". Preserve each person's exact facial features and identity shown in the reference image(s).";
    }
    console.log("[OAI-PROMPT] final:", { hasReference, hasCJK, len: finalPrompt.length });

    if (!apiKey) return { status: 400, body: { error: "缺少 API Key" } };
    if (!baseUrl) return { status: 400, body: { error: "缺少 Base URL" } };
    if (!model) return { status: 400, body: { error: "缺少模型名" } };

    const url = buildImageUrl(baseUrl, hasReference ? "edits" : "generations");
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    let body: BodyInit;

    if (hasReference) {
      const refImages = (input.referenceImages?.length ? input.referenceImages : [input.referenceImageDataUrl || ""])
        .filter(Boolean);
      if (!refImages.length) return { status: 400, body: { error: "参考图格式无效" } };
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", finalPrompt);
      if (input.size && input.size !== "auto") form.set("size", input.size);
      if (input.quality && input.quality !== "auto") form.set("quality", input.quality);
      for (const ref of refImages) {
        const converted = dataUrlToBlob(ref);
        if (!converted) continue;
        form.append("image", converted.blob, `reference.${converted.mimeType.split("/")[1] || "png"}`);
      }
      body = form;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({
        model,
        prompt: finalPrompt,
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
