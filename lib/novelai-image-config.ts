export const NOVELAI_DEFAULT_MODEL = "nai-diffusion-4-curated-preview";
export const NOVELAI_DEFAULT_RESOLUTION = "832x1216";
export const NOVELAI_DEFAULT_SAMPLER = "k_euler";
export const NOVELAI_DEFAULT_NOISE_SCHEDULE = "karras";
export const NOVELAI_DEFAULT_STEPS = 28;
export const NOVELAI_DEFAULT_SCALE = 6;

export const NOVELAI_MODEL_OPTIONS = [
  { value: "nai-diffusion-5-full", label: "NovelAI Diffusion V5 Full" },
  { value: "nai-diffusion-5-curated", label: "NovelAI Diffusion V5 Curated" },
  { value: "nai-diffusion-4-5-full", label: "NovelAI Diffusion V4.5 Full" },
  { value: "nai-diffusion-4-5-curated", label: "NovelAI Diffusion V4.5 Curated" },
  { value: "nai-diffusion-4-full", label: "NovelAI Diffusion V4 Full" },
  { value: "nai-diffusion-4-curated-preview", label: "NovelAI Diffusion V4 Curated" },
  { value: "nai-diffusion-3", label: "NovelAI Diffusion V3" },
  { value: "nai-diffusion-furry-3", label: "NovelAI Diffusion Furry V3" },
] as const;

export const NOVELAI_COMMON_MODELS = NOVELAI_MODEL_OPTIONS.map(option => option.value);

export const NOVELAI_RESOLUTION_OPTIONS = [
  { value: "832x1216", label: "832x1216 (标准竖向 2:3)", width: 832, height: 1216 },
  { value: "1216x832", label: "1216x832 (标准横向 3:2)", width: 1216, height: 832 },
  { value: "1024x1024", label: "1024x1024 (正方形 1:1)", width: 1024, height: 1024 },
  { value: "1024x1536", label: "1024x1536 (大图竖向)", width: 1024, height: 1536 },
  { value: "1536x1024", label: "1536x1024 (大图横向)", width: 1536, height: 1024 },
  { value: "512x768", label: "512x768 (小图竖向)", width: 512, height: 768 },
  { value: "768x512", label: "768x512 (小图横向)", width: 768, height: 512 },
] as const;

export const NOVELAI_SAMPLER_OPTIONS = [
  { value: "k_euler", label: "Euler" },
  { value: "k_euler_ancestral", label: "Euler Ancestral" },
  { value: "k_dpmpp_2m", label: "DPM++ 2M" },
  { value: "k_dpmpp_2s_ancestral", label: "DPM++ 2S Ancestral" },
  { value: "k_dpmpp_sde", label: "DPM++ SDE" },
  { value: "ddim", label: "DDIM" },
] as const;

export const NOVELAI_NOISE_SCHEDULE_OPTIONS = [
  { value: "karras", label: "Karras" },
  { value: "native", label: "Native" },
  { value: "exponential", label: "Exponential" },
  { value: "polyexponential", label: "Polyexponential" },
] as const;

const resolutionValues = new Set<string>(NOVELAI_RESOLUTION_OPTIONS.map(option => option.value));
const samplerValues = new Set<string>(NOVELAI_SAMPLER_OPTIONS.map(option => option.value));
const noiseScheduleValues = new Set<string>(NOVELAI_NOISE_SCHEDULE_OPTIONS.map(option => option.value));

export function isValidNovelAiModel(value: string): boolean {
  return value.length <= 128 && /^[a-z0-9][a-z0-9._:-]*$/i.test(value);
}

export function normalizeNovelAiModel(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return isValidNovelAiModel(normalized) ? normalized : NOVELAI_DEFAULT_MODEL;
}

export function isNovelAiResolution(value: string): boolean {
  return resolutionValues.has(value);
}

export function normalizeNovelAiResolution(value: unknown): string {
  return typeof value === "string" && isNovelAiResolution(value)
    ? value
    : NOVELAI_DEFAULT_RESOLUTION;
}

export function getNovelAiResolution(value: unknown): { value: string; width: number; height: number } {
  const normalized = normalizeNovelAiResolution(value);
  const option = NOVELAI_RESOLUTION_OPTIONS.find(item => item.value === normalized)
    ?? NOVELAI_RESOLUTION_OPTIONS[0];
  return { value: option.value, width: option.width, height: option.height };
}

export function isNovelAiSampler(value: string): boolean {
  return samplerValues.has(value);
}

export function normalizeNovelAiSampler(value: unknown): string {
  return typeof value === "string" && isNovelAiSampler(value)
    ? value
    : NOVELAI_DEFAULT_SAMPLER;
}

export function isNovelAiNoiseSchedule(value: string): boolean {
  return noiseScheduleValues.has(value);
}

export function normalizeNovelAiNoiseSchedule(value: unknown): string {
  return typeof value === "string" && isNovelAiNoiseSchedule(value)
    ? value
    : NOVELAI_DEFAULT_NOISE_SCHEDULE;
}

export function normalizeNovelAiSteps(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(50, Math.floor(value)))
    : NOVELAI_DEFAULT_STEPS;
}

export function normalizeNovelAiScale(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(30, Number(value.toFixed(1))))
    : NOVELAI_DEFAULT_SCALE;
}
