// NovelAI 官方接口适配层。
// 当「生图设置 → Base URL」填 nai://official（任意 nai:// 开头）时启用：
// 把本产品通用的 OpenAI 风格生图参数（model/prompt/size/quality/补充提示词）
// 翻译成 NovelAI 原生协议，再经服务端路由 app/api/image-generation/nai/route.ts
// 转发给 image.novelai.net。NAI 官方接口不允许浏览器跨域，因此本模式强制走服务端。

export const NOVELAI_SCHEME = "nai://";
export const NOVELAI_ENDPOINT = "https://image.novelai.net/ai/generate-image";

// NAI 官方没有公开模型列表接口，这里给出已知模型名供「拉取模型」使用。
export const NOVELAI_MODELS = [
  "nai-diffusion-3",
  "nai-diffusion-3-anime",
  "nai-diffusion-3-furry",
  "nai-diffusion-furry-3",
  "nai-diffusion-2",
  "nai-diffusion-furry-2",
];

export function isNovelAiBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().startsWith(NOVELAI_SCHEME);
}

// NAI 要求宽高为 64 的倍数且在模型支持范围内。
// v3 系最长边可到 1216；v2 系上限 1024。
const V3_SIZE_MAP: Record<string, [number, number]> = {
  "1024x1024": [1024, 1024],
  "1024x1536": [832, 1216],
  "1536x1024": [1216, 832],
};
const V2_SIZE_MAP: Record<string, [number, number]> = {
  "1024x1024": [1024, 1024],
  "1024x1536": [640, 960],
  "1536x1024": [960, 640],
};
const DEFAULT_SIZE: [number, number] = [832, 1216];

function isV3Model(model: string): boolean {
  return /3/.test(model);
}

export function splitNegativePrompt(prompt: string): { prompt: string; negativePrompt: string } {
  const lines = prompt.split("\n");
  const kept: string[] = [];
  const negatives: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:负面词|负面提示词|negative(?:\s*prompt)?)\s*[:：]\s*(.+?)\s*$/i.exec(line);
    if (match && match[1]) {
      negatives.push(match[1]);
    } else {
      kept.push(line);
    }
  }
  return {
    prompt: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    negativePrompt: negatives.join(", "),
  };
}

export type NovelAiRequestOptions = {
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  negativePrompt?: string;
};

export function buildNovelAiRequestBody(options: NovelAiRequestOptions) {
  const { model, size, quality } = options;
  const { prompt, negativePrompt } = splitNegativePrompt(options.prompt);
  const isV3 = isV3Model(model);
  const sizeMap = isV3 ? V3_SIZE_MAP : V2_SIZE_MAP;
  const [width, height] = (size && sizeMap[size]) || DEFAULT_SIZE;
  // 产品的 quality（low/medium/high）映射到采样步数。
  const steps = quality === "low" ? 20 : quality === "high" ? 32 : 28;
  const negative = [negativePrompt, options.negativePrompt || ""].filter(Boolean).join(", ");

  return {
    input: prompt,
    model,
    action: "generate",
    parameters: {
      params_version: isV3 ? 3 : 2,
      width,
      height,
      scale: 5,
      sampler: isV3 ? "k_dpmpp_2m" : "k_euler",
      steps,
      negative_prompt: negative,
      seed: 0,
      n_samples: 1,
      sm: false,
      sm_dyn: false,
      uncond_scale: 1.0,
      cfg_rescale: 0,
      noise_schedule: "native",
      legacy: false,
      skip_cfg_before_second_sampling: false,
      dynamic_thresholding: false,
      controlnet_strength: 1,
    },
  };
}
