import type { GenerationParameterKey, PresetConfig } from "./settings-types";

export const GENERATION_PARAMETER_KEYS: readonly GenerationParameterKey[] = [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "top_a",
    "repetition_penalty",
    "frequency_penalty",
    "presence_penalty",
    "max_tokens",
];

const GENERATION_PARAMETER_KEY_SET = new Set<GenerationParameterKey>(GENERATION_PARAMETER_KEYS);

export function isGenerationParameterKey(value: unknown): value is GenerationParameterKey {
    return typeof value === "string" && GENERATION_PARAMETER_KEY_SET.has(value as GenerationParameterKey);
}

/**
 * Old presets did not store an allow-list. Derive the list from the exact legacy
 * request behavior so simply upgrading does not add or remove request fields.
 */
export function resolveEnabledGenerationParameters(
    preset: PresetConfig | null,
): Set<GenerationParameterKey> {
    if (preset?.enabled_generation_parameters) {
        return new Set(preset.enabled_generation_parameters.filter(isGenerationParameterKey));
    }

    const enabled = new Set<GenerationParameterKey>([
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
    ]);
    if (!preset) return enabled;
    if (preset.top_k > 0) enabled.add("top_k");
    if ((preset.min_p ?? 0) > 0) enabled.add("min_p");
    if ((preset.top_a ?? 0) > 0) enabled.add("top_a");
    if (preset.repetition_penalty !== undefined && preset.repetition_penalty !== 1) {
        enabled.add("repetition_penalty");
    }
    if (preset.openai_max_tokens > 0) enabled.add("max_tokens");
    return enabled;
}
