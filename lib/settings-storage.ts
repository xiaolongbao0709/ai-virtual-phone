import type {
    PresetConfig,
    WorldBookConfig,
    WorldBookEntry,
    RegexConfig,
    RegexRule,
    ApiConfig,
    VoiceApiConfig,
    ImageGenerationSettings,
    BindingConfig,
    BindingSlot,
    CharacterBinding,
    Prompt,
    PromptOrderEntry,
} from "./settings-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import { createBuiltinPreset, BUILTIN_PRESET_VERSION } from "./builtin-preset";
import { areTagsEqual, normalizePromptScopeTags, normalizeTags } from "./content-tag-utils";
import {
    readPresetsCache, writePresetsCache,
    writePresetsCacheAsync,
    readWorldBooksCache, writeWorldBooksCache,
    readRegexesCache, writeRegexesCache,
    hydrateSettingsDb,
} from "./settings-db";
import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

// --- Unsupported import format detection ---
export const UNSUPPORTED_IMPORT_FORMAT = "UNSUPPORTED_IMPORT_FORMAT";

/** Preset fingerprint fields never present in our exports. */
const UNSUPPORTED_PRESET_FIELDS = [
    // API/model provider fields
    "chat_completion_source", "openai_model", "claude_model", "windowai_model",
    "reverse_proxy", "proxy_password", "mancer_model", "togetherai_model",
    "ollama_model", "preset_settings_type", "api_url_scale",
    // External generation/feature fields
    "assistant_prefill", "assistant_impersonation", "claude_use_sysprompt",
    "use_makersuite_sysprompt", "squash_system_messages", "image_inlining",
    "continue_prefill", "function_calling", "seed", "n",
];

function isUnsupportedPresetFormat(obj: Record<string, unknown>): boolean {
    return UNSUPPORTED_PRESET_FIELDS.some(f => f in obj);
}

/** World book shapes with unsupported root/entry fields. */
const UNSUPPORTED_WB_ROOT_FIELDS = ["recursiveScan", "caseSensitive", "originalData", "globalSelect"];
const UNSUPPORTED_WB_ENTRY_FIELDS = ["selectiveLogic", "secondary_keys", "extensions", "characterFilter", "vectorized"];

function isUnsupportedWorldBookFormat(obj: Record<string, unknown>): boolean {
    // Root-level external fields
    if (UNSUPPORTED_WB_ROOT_FIELDS.some(f => f in obj)) return true;
    // Dictionary entries are treated as unsupported import format
    if (obj.entries && typeof obj.entries === "object" && !Array.isArray(obj.entries)) return true;
    // Check entry-level external fields
    const entries = Array.isArray(obj.entries) ? obj.entries : (obj.entries && typeof obj.entries === "object" ? Object.values(obj.entries) : []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (entries.length > 0 && entries.some((e: any) => e && UNSUPPORTED_WB_ENTRY_FIELDS.some(f => f in e))) return true;
    return false;
}

// --- Keys ---
const API_CONFIGS_KEY = "ai_phone_api_configs_v1";
const VOICE_CONFIGS_KEY = "ai_phone_voice_configs_v1";
const IMAGE_GENERATION_SETTINGS_KEY = "ai_phone_image_generation_settings_v1";
const BINDINGS_KEY = "ai_phone_bindings_v1";
const FOLLOW_UP_CONFIG_KEY = "ai_phone_follow_up_config_v1";
const CHAT_SEND_CONFIG_KEY = "ai_phone_chat_send_config_v1";
const USER_IDENTITIES_KEY = "ai_phone_user_identities_v1";

// Legacy key for migration
const LEGACY_OVERRIDES_KEY = "ai_phone_char_settings_v1";
registerKvMigration(API_CONFIGS_KEY);
registerKvMigration(VOICE_CONFIGS_KEY);
registerKvMigration(IMAGE_GENERATION_SETTINGS_KEY);
registerKvMigration(BINDINGS_KEY);
registerKvMigration(FOLLOW_UP_CONFIG_KEY);
registerKvMigration(CHAT_SEND_CONFIG_KEY);
registerKvMigration(USER_IDENTITIES_KEY);
registerKvMigration(LEGACY_OVERRIDES_KEY);

// --- Helpers ---
function generateId(prefix: string) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getNow() {
    return Date.now();
}

const CUSTOM_APP_PROMPT_IDENTIFIER_PREFIX = "custom_app_";
const CUSTOM_APP_PROMPT_IDENTIFIER_SEGMENT = "_prompt_";

function isCustomAppPromptIdentifier(identifier: unknown): identifier is string {
    return typeof identifier === "string"
        && identifier.startsWith(CUSTOM_APP_PROMPT_IDENTIFIER_PREFIX)
        && identifier.includes(CUSTOM_APP_PROMPT_IDENTIFIER_SEGMENT);
}

function collectCustomAppPresetPrompts(preset: PresetConfig | null | undefined): Prompt[] {
    if (!preset) return [];
    const seen = new Set<string>();
    const prompts: Prompt[] = [];
    for (const prompt of preset.prompts ?? []) {
        if (!isCustomAppPromptIdentifier(prompt.identifier) || seen.has(prompt.identifier)) continue;
        seen.add(prompt.identifier);
        prompts.push(prompt);
    }
    return prompts;
}

function collectCustomAppPromptOrder(
    preset: PresetConfig,
    customPromptIds: Set<string>,
    customPrompts: Prompt[],
): PromptOrderEntry[] {
    const seen = new Set<string>();
    const entries: PromptOrderEntry[] = [];
    for (const entry of preset.prompt_order ?? []) {
        if (!customPromptIds.has(entry.identifier) || seen.has(entry.identifier)) continue;
        seen.add(entry.identifier);
        entries.push({ identifier: entry.identifier, enabled: entry.enabled !== false });
    }
    for (const prompt of customPrompts) {
        if (seen.has(prompt.identifier)) continue;
        seen.add(prompt.identifier);
        entries.push({ identifier: prompt.identifier, enabled: prompt.enabled !== false });
    }
    return entries;
}

function preserveCustomAppPresetPrompts(fresh: PresetConfig, previous: PresetConfig | null | undefined): PresetConfig {
    const customPrompts = collectCustomAppPresetPrompts(previous);
    if (!previous || customPrompts.length === 0) return fresh;

    const customPromptIds = new Set(customPrompts.map(prompt => prompt.identifier));
    const customOrder = collectCustomAppPromptOrder(previous, customPromptIds, customPrompts);
    const basePrompts = (fresh.prompts ?? []).filter(prompt => (
        !customPromptIds.has(prompt.identifier) && !isCustomAppPromptIdentifier(prompt.identifier)
    ));
    const baseOrder = (fresh.prompt_order ?? []).filter(entry => (
        !customPromptIds.has(entry.identifier) && !isCustomAppPromptIdentifier(entry.identifier)
    ));
    const dividerIndex = baseOrder.findIndex(entry => entry.identifier === "shortTermMemory" || entry.identifier === "chatHistory");
    const promptOrder = dividerIndex >= 0
        ? [
            ...baseOrder.slice(0, dividerIndex + 1),
            ...customOrder,
            ...baseOrder.slice(dividerIndex + 1),
        ]
        : [...baseOrder, ...customOrder];

    return {
        ...fresh,
        prompts: [...basePrompts, ...customPrompts],
        prompt_order: promptOrder,
    };
}


// --- Presets ──────────────────────────────────────────

export function loadPresets(): PresetConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const cachedPresets = readPresetsCache();
        const presets: PresetConfig[] = cachedPresets.map(stripDeprecatedPresetFields);
        let shouldPersistCleanup = JSON.stringify(cachedPresets) !== JSON.stringify(presets);

        // Ensure built-in preset exists and is up-to-date
        const existingBuiltin = presets.find(p => p.builtIn);
        if (!existingBuiltin) {
            const builtin = createBuiltinPreset();
            presets.unshift(builtin);
            savePresets(presets);
            shouldPersistCleanup = false;
        } else if ((existingBuiltin.builtInVersion ?? 0) < BUILTIN_PRESET_VERSION) {
            const fresh = preserveCustomAppPresetPrompts(createBuiltinPreset(), existingBuiltin);
            fresh.id = existingBuiltin.id;
            const idx = presets.indexOf(existingBuiltin);
            presets[idx] = fresh;
            savePresets(presets);
            shouldPersistCleanup = false;
        } else if (shouldPersistCleanup) {
            savePresets(presets);
        }

        return presets;
    } catch {
        return [];
    }
}

/** Reset the built-in preset to factory defaults. */
export function resetBuiltinPreset(): void {
    const presets = loadPresets();
    const idx = presets.findIndex(p => p.builtIn);
    const previous = idx >= 0 ? presets[idx] : null;
    const fresh = preserveCustomAppPresetPrompts(createBuiltinPreset(), previous);
    if (idx >= 0) {
        fresh.id = presets[idx].id; // preserve ID to avoid binding breakage
        presets[idx] = fresh;
    } else {
        presets.unshift(fresh);
    }
    savePresets(presets);
}

/** 把采样参数规整到 2 位小数，保留 undefined（泛型保持原字段的可选性）。 */
function round2<T extends number | undefined>(value: T): T {
    return (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : value) as T;
}

function stripDeprecatedPresetFields(preset: PresetConfig & { fold_tags?: unknown }): PresetConfig {
    const { fold_tags: _foldTags, ...rest } = preset;
    return {
        ...rest,
        // 采样浮点参数规整为 2 位小数：滑块 step="any" 会产生 1.7000000000000002 这类长浮点，
        // 这里在加载时一并清洗老数据（loadPresets 的 shouldPersistCleanup 会自动回写）。
        temperature: round2(rest.temperature),
        top_p: round2(rest.top_p),
        min_p: round2(rest.min_p),
        top_a: round2(rest.top_a),
        repetition_penalty: round2(rest.repetition_penalty),
        frequency_penalty: round2(rest.frequency_penalty),
        presence_penalty: round2(rest.presence_penalty),
        prompts: rest.prompts.map(({ injection_order: _injectionOrder, ...prompt }) => normalizePresetPromptScope(prompt)),
    };
}

function normalizePresetPromptScope(prompt: Prompt): Prompt {
    const legacyTags = prompt.tags && prompt.tags.length > 0
        ? prompt.tags
        : [
            ...(prompt.featureTag ? [prompt.featureTag] : []),
            ...(prompt.followUpOnly ? (prompt.featureTag ? ["followup"] : ["chat", "followup"]) : []),
        ];
    const normalizedTags = normalizePromptScopeTags(legacyTags);
    return {
        ...prompt,
        tags: normalizedTags,
        featureTag: undefined,
        followUpOnly: undefined,
    };
}

export function savePresets(presets: PresetConfig[]): void {
    if (typeof window === "undefined") return;
    writePresetsCache(presets.map(stripDeprecatedPresetFields));
}

export async function savePresetsAsync(presets: PresetConfig[]): Promise<void> {
    if (typeof window === "undefined") return;
    await writePresetsCacheAsync(presets.map(stripDeprecatedPresetFields));
}

export async function ensureSettingsStorageHydrated(): Promise<void> {
    await hydrateSettingsDb();
}

export function createPreset(name: string): PresetConfig {
    const now = getNow();
    return {
        id: generateId("preset"),
        name,
        description: "",
        createdAt: now,
        updatedAt: now,
        temperature: 1,
        top_p: 1,
        top_k: 0,
        frequency_penalty: 0,
        presence_penalty: 0,
        repetition_penalty: 1,
        openai_max_tokens: 0,
        openai_max_context: 100000,
        story_summary_tag: "summary",
        prompts: []
    };
}

export function parsePresetFromJson(text: string, fallbackName: string = "导入的预设"): PresetConfig | null {
    try {
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== "object") return null;

        if (isUnsupportedPresetFormat(obj)) throw new Error(UNSUPPORTED_IMPORT_FORMAT);

        const preset = createPreset(obj.name || fallbackName);

        // Extract basic fields
        if (typeof obj.temperature === "number") preset.temperature = obj.temperature;
        if (typeof obj.top_p === "number") preset.top_p = obj.top_p;
        if (typeof obj.top_k === "number") preset.top_k = obj.top_k;
        if (typeof obj.frequency_penalty === "number") preset.frequency_penalty = obj.frequency_penalty;
        if (typeof obj.presence_penalty === "number") preset.presence_penalty = obj.presence_penalty;
        if (typeof obj.repetition_penalty === "number") preset.repetition_penalty = obj.repetition_penalty;
        if (typeof obj.openai_max_tokens === "number") preset.openai_max_tokens = obj.openai_max_tokens;
        if (typeof obj.openai_max_context === "number") preset.openai_max_context = obj.openai_max_context;
        // New preset globals
        if (typeof obj.top_a === "number") preset.top_a = obj.top_a;
        if (typeof obj.min_p === "number") preset.min_p = obj.min_p;
        if (typeof obj.wrap_in_quotes === "boolean") preset.wrap_in_quotes = obj.wrap_in_quotes;
        if (typeof obj.names_behavior === "number") preset.names_behavior = obj.names_behavior;
        if (typeof obj.send_if_empty === "string") preset.send_if_empty = obj.send_if_empty;
        if (typeof obj.impersonation_prompt === "string") preset.impersonation_prompt = obj.impersonation_prompt;
        if (typeof obj.new_chat_prompt === "string") preset.new_chat_prompt = obj.new_chat_prompt;
        if (typeof obj.new_group_chat_prompt === "string") preset.new_group_chat_prompt = obj.new_group_chat_prompt;
        if (typeof obj.new_example_chat_prompt === "string") preset.new_example_chat_prompt = obj.new_example_chat_prompt;
        if (typeof obj.continue_nudge_prompt === "string") preset.continue_nudge_prompt = obj.continue_nudge_prompt;
        if (typeof obj.group_nudge_prompt === "string") preset.group_nudge_prompt = obj.group_nudge_prompt;
        if (typeof obj.bias_preset_selected === "string") preset.bias_preset_selected = obj.bias_preset_selected;
        if (typeof obj.max_context_unlocked === "boolean") preset.max_context_unlocked = obj.max_context_unlocked;
        if (typeof obj.wi_format === "string") preset.wi_format = obj.wi_format;
        if (typeof obj.scenario_format === "string") preset.scenario_format = obj.scenario_format;
        if (typeof obj.personality_format === "string") preset.personality_format = obj.personality_format;
        if (typeof obj.story_summary_tag === "string") preset.story_summary_tag = obj.story_summary_tag;

        // Parse prompts if array
        if (Array.isArray(obj.prompts)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            preset.prompts = obj.prompts.map((p: any) => normalizePresetPromptScope({
                identifier: p.identifier || p.name || `prompt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                name: String(p.name || "未命名"),
                role: String(p.role || "system"),
                content: String(p.content || ""),
                injection_depth: Number(p.injection_depth) || 0,
                enabled: p.enabled !== false,
                system_prompt: Boolean(p.system_prompt || false),
                marker: Boolean(p.marker || false),
                forbid_overrides: Boolean(p.forbid_overrides || false),
                injection_position: Number(p.injection_position) || 0,
                featureTag: p.featureTag || undefined,
                followUpOnly: p.followUpOnly === true ? true : undefined,
                tags: Array.isArray(p.tags) && p.tags.length > 0 ? p.tags.map(String) : undefined,
            }));
        }

        // Parse prompt_order from the current flat export format.
        if (Array.isArray(obj.prompt_order)) {
            const rawOrder: Array<{ identifier: string; enabled?: unknown }> =
                (obj.prompt_order as unknown[]).filter((entry: unknown): entry is { identifier: string; enabled?: unknown } =>
                    !!entry && typeof entry === "object" && typeof (entry as { identifier?: unknown }).identifier === "string"
                );
            if (rawOrder.length > 0) {
                preset.prompt_order = rawOrder.map((entry) => {
                    return {
                        identifier: String(entry.identifier),
                        enabled: entry.enabled !== false,
                    };
                });
            }
        }

        return preset;
    } catch (e) {
        if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) throw e;
        return null;
    }
}

// --- WorldBooks ──────────────────────────────────────────

export function loadWorldBooks(): WorldBookConfig[] {
    if (typeof window === "undefined") return [];
    return [...readWorldBooksCache()];
}

export function saveWorldBooks(books: WorldBookConfig[]): void {
    if (typeof window === "undefined") return;
    writeWorldBooksCache(books);
}

export function createWorldBook(name: string): WorldBookConfig {
    const now = getNow();
    return {
        id: generateId("wb"),
        name,
        description: "",
        createdAt: now,
        updatedAt: now,
        entries: []
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseWorldBookEntry(e: any): WorldBookEntry {
    // Resolve key: support arrays, strings, and fallback field names
    let key = "";
    if (Array.isArray(e.key)) {
        key = e.key.join(",");
    } else {
        key = String(e.key ?? e.keysecondary ?? e.keyword ?? e.keys?.join(",") ?? "");
    }
    // Merge disable/disabled/enabled: entry is disabled if disable=true OR enabled=false
    const isDisabled = Boolean(e.disable || e.disabled || false) || (e.enabled === false);
    return {
        uid: e.uid ? String(e.uid) : String(e.id || generateId("wb-entry")),
        key,
        content: String(e.content ?? ""),
        comment: String(e.comment ?? ""),
        use_regex: Boolean(e.use_regex || e.isRegex || false),
        disable: isDisabled,
        constant: Boolean(e.constant || false),
        position: e.position !== undefined ? (typeof e.position === "string" && /^\d+$/.test(e.position) ? Number(e.position) : e.position) : "before_char",
        depth: Number(e.depth) || 0,
        probability: Number(e.probability) || 100,
        useProbability: Boolean(e.useProbability || false),
        role: Number(e.role) || 0,
        insertion_order: Number(e.order ?? e.insertion_order ?? 50),
    };
}

export function parseWorldBookFromJson(text: string): WorldBookConfig | null {
    try {
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== "object") return null;

        if (isUnsupportedWorldBookFormat(obj)) throw new Error(UNSUPPORTED_IMPORT_FORMAT);

        const wb = createWorldBook(obj.name || "导入的世界书");
        if (Array.isArray(obj.entries)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const parsedEntries = obj.entries.map((e: any) => parseWorldBookEntry(e));

            // Note: some formats might use dictionary-shaped entries.
            wb.entries = parsedEntries;
        } else if (typeof obj.entries === "object" && obj.entries !== null) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const parsedEntries = Object.values(obj.entries).map((e: any) => parseWorldBookEntry(e));
            wb.entries = parsedEntries;
        }

        return wb;
    } catch (e) {
        if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) throw e;
        return null;
    }
}

// --- Regexes ──────────────────────────────────────────

function normalizeRegexRuleTags(tags: unknown): string[] | undefined {
    const normalized = normalizeTags(tags);
    if (!normalized) return undefined;
    if (areTagsEqual(normalized, ["chat"])) return ["chat", "text"];
    if (areTagsEqual(normalized, ["group_chat"])) return ["group_chat", "text"];
    return normalized;
}

function normalizeRegexRuleScope(rule: RegexRule): RegexRule {
    const currentTags = normalizeTags(rule.tags);
    const nextTags = normalizeRegexRuleTags(rule.tags);

    if (!nextTags) {
        return rule.tags === undefined ? rule : { ...rule, tags: undefined };
    }

    if (currentTags && areTagsEqual(currentTags, nextTags)) return rule;
    return { ...rule, tags: nextTags };
}

function normalizeRegexGroupScopes(group: RegexConfig): RegexConfig {
    const currentRules = group.rules || [];
    const rules = currentRules.map(normalizeRegexRuleScope);
    return rules.every((rule, index) => rule === currentRules[index])
        ? group
        : { ...group, rules };
}

export function loadRegexes(): RegexConfig[] {
    if (typeof window === "undefined") return [];
    try {
        return readRegexesCache().map(normalizeRegexGroupScopes);
    } catch {
        return [];
    }
}

export function saveRegexes(regexes: RegexConfig[]): void {
    if (typeof window === "undefined") return;
    writeRegexesCache(regexes);
    window.dispatchEvent(new CustomEvent("settings-regexes-updated"));
}

export function createRegexGroup(name: string): RegexConfig {
    const now = getNow();
    return {
        id: generateId("regex"),
        name,
        description: "",
        createdAt: now,
        updatedAt: now,
        rules: []
    };
}

export function parseRegexFromJson(text: string, fallbackName: string = "导入的正则组"): RegexConfig | null {
    try {
        const obj = JSON.parse(text);
        if (!obj) return null;

        let rulesArray = [];
        if (Array.isArray(obj)) {
            // Raw array of rules is an unsupported import format.
            throw new Error(UNSUPPORTED_IMPORT_FORMAT);
        } else if (obj.rules && Array.isArray(obj.rules)) {
            // Group format: { name, rules: [...] } — our format
            rulesArray = obj.rules;
        } else if (obj.findRegex || obj.scriptName) {
            // Single regex script object without group wrapper is unsupported.
            throw new Error(UNSUPPORTED_IMPORT_FORMAT);
        } else {
            return null; // Don't know how to parse
        }

        // Determine group name: JSON name > filename > first rule's scriptName > default
        const groupName = obj.name || obj.scriptName || fallbackName
            || (rulesArray[0]?.scriptName ? String(rulesArray[0].scriptName) : "导入的正则组");

        const group = createRegexGroup(groupName);
        if (obj.description) group.description = String(obj.description);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        group.rules = rulesArray.map((r: any) => {
            // --- placement mapping ---
            // Some imports use promptOnly/markdownOnly flags alongside placement array.
            // If only promptOnly is set and placement is missing, default to [1] (input).
            let placement: number[] = Array.isArray(r.placement) ? r.placement.map(Number) : [1];
            if (r.promptOnly && !r.markdownOnly && placement.length === 0) {
                placement = [1];
            }

            // --- trimStrings ---
            let trimStrings: string[] | undefined;
            if (Array.isArray(r.trimStrings) && r.trimStrings.length > 0) {
                trimStrings = r.trimStrings.map(String);
            }

            return {
                id: r.id || generateId("regex-rule"),
                scriptName: String(r.scriptName || r.name || "未命名规则"),
                findRegex: String(r.findRegex || r.regex || ""),
                replaceString: String(r.replaceString || r.replace || ""),
                tags: normalizeRegexRuleTags(r.tags),
                disabled: Boolean(r.disabled || false),
                placement,
                trimStrings,
                markdownOnly: r.markdownOnly === true ? true : undefined,
                promptOnly: r.promptOnly === true ? true : undefined,
                runOnEdit: r.runOnEdit === true ? true : undefined,
                substituteRegex: typeof r.substituteRegex === "number" ? r.substituteRegex : undefined,
                minDepth: typeof r.minDepth === "number" && !isNaN(r.minDepth) ? r.minDepth : undefined,
                maxDepth: typeof r.maxDepth === "number" && !isNaN(r.maxDepth) ? r.maxDepth : undefined,
            };
        });

        return group;
    } catch (e) {
        if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) throw e;
        return null;
    }
}

// --- API Configs ──────────────────────────────────────────

type LegacyApiConfig = ApiConfig & {
    toolProtocol?: "text" | "openai-compatible" | "anthropic" | "gemini";
};

function normalizeApiConfig(config: LegacyApiConfig): ApiConfig {
    const rest: Partial<LegacyApiConfig> = { ...config };
    delete rest.toolProtocol;
    return {
        ...(rest as ApiConfig),
        enableNativeTools: typeof config.enableNativeTools === "boolean"
            ? config.enableNativeTools
            : true,
        preventEmptyGenerateRambling: typeof config.preventEmptyGenerateRambling === "boolean"
            ? config.preventEmptyGenerateRambling
            : true,
    };
}

export function loadApiConfigs(): ApiConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(API_CONFIGS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as LegacyApiConfig[];
        return Array.isArray(parsed) ? parsed.map(normalizeApiConfig) : [];
    } catch {
        return [];
    }
}

export function saveApiConfigs(configs: ApiConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(API_CONFIGS_KEY, JSON.stringify(configs.map(normalizeApiConfig)));
}

// --- Voice Configs ──────────────────────────────────────────

export function loadVoiceConfigs(): VoiceApiConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(VOICE_CONFIGS_KEY);
        if (!raw) return [];
        return JSON.parse(raw) as VoiceApiConfig[];
    } catch {
        return [];
    }
}

export function saveVoiceConfigs(configs: VoiceApiConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(VOICE_CONFIGS_KEY, JSON.stringify(configs));
}

// --- Image Generation Settings ──────────────────────────────────────────

export const DEFAULT_IMAGE_GENERATION_SETTINGS: ImageGenerationSettings = {
    enabled: false,
    requestMode: "direct",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "auto",
    extraPrompt: "",
    characterReferences: {},
    imageHosting: {
        provider: "none",
        imgbbApiKey: "",
        defaultExpirationSeconds: 0,
        maxUploadBytes: 900 * 1024,
        autoConvertToWebp: true,
        allowMascotUpload: false,
    },
};

function normalizeImageGenerationSettings(settings: Partial<ImageGenerationSettings> | null | undefined): ImageGenerationSettings {
    const refs = settings?.characterReferences && typeof settings.characterReferences === "object"
        ? settings.characterReferences
        : {};
    const requestMode = settings?.requestMode === "server" || settings?.requestMode === "direct"
        ? settings.requestMode
        : DEFAULT_IMAGE_GENERATION_SETTINGS.requestMode;
    const hosting: Partial<ImageGenerationSettings["imageHosting"]> = settings?.imageHosting && typeof settings.imageHosting === "object"
        ? settings.imageHosting
        : {};
    const provider = hosting.provider === "imgbb" ? "imgbb" : "none";
    const defaultExpirationSeconds = typeof hosting.defaultExpirationSeconds === "number"
        ? Math.max(0, Math.min(15552000, Math.floor(hosting.defaultExpirationSeconds)))
        : DEFAULT_IMAGE_GENERATION_SETTINGS.imageHosting.defaultExpirationSeconds;
    const maxUploadBytes = typeof hosting.maxUploadBytes === "number"
        ? Math.max(64 * 1024, Math.min(32 * 1024 * 1024, Math.floor(hosting.maxUploadBytes)))
        : DEFAULT_IMAGE_GENERATION_SETTINGS.imageHosting.maxUploadBytes;
    return {
        ...DEFAULT_IMAGE_GENERATION_SETTINGS,
        ...(settings || {}),
        requestMode,
        characterReferences: refs,
        imageHosting: {
            ...DEFAULT_IMAGE_GENERATION_SETTINGS.imageHosting,
            ...hosting,
            provider,
            defaultExpirationSeconds,
            maxUploadBytes,
            autoConvertToWebp: hosting.autoConvertToWebp !== false,
            allowMascotUpload: hosting.allowMascotUpload === true,
            imgbbApiKey: typeof hosting.imgbbApiKey === "string" ? hosting.imgbbApiKey : "",
        },
    };
}

export function loadImageGenerationSettings(): ImageGenerationSettings {
    if (typeof window === "undefined") return { ...DEFAULT_IMAGE_GENERATION_SETTINGS };
    try {
        const raw = kvGet(IMAGE_GENERATION_SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_IMAGE_GENERATION_SETTINGS };
        return normalizeImageGenerationSettings(JSON.parse(raw) as Partial<ImageGenerationSettings>);
    } catch {
        return { ...DEFAULT_IMAGE_GENERATION_SETTINGS };
    }
}

export function saveImageGenerationSettings(settings: ImageGenerationSettings): void {
    if (typeof window === "undefined") return;
    kvSet(IMAGE_GENERATION_SETTINGS_KEY, JSON.stringify(normalizeImageGenerationSettings(settings)));
    window.dispatchEvent(new CustomEvent("settings-image-generation-updated"));
}

// --- Binding Config ──────────────────────────────────────────

const DEFAULT_BINDING_CONFIG: BindingConfig = {
    globalDefaults: {},
    appDefaults: {},
    characterBindings: []
};

function normalizeBindingConfig(config: BindingConfig): { config: BindingConfig; changed: boolean } {
    let changed = false;
    const characterBindings = config.characterBindings.map(binding => {
        const appOverrides = { ...binding.appOverrides } as Record<string, BindingSlot | undefined>;
        if (appOverrides.weibo) {
            if (!appOverrides.game) appOverrides.game = appOverrides.weibo;
            delete appOverrides.weibo;
            changed = true;
        }
        if (appOverrides.fortune) {
            if (!appOverrides.interview_magazine) appOverrides.interview_magazine = appOverrides.fortune;
            delete appOverrides.fortune;
            changed = true;
        }
        if (appOverrides.forum) {
            if (!appOverrides.cocreate) appOverrides.cocreate = appOverrides.forum;
            delete appOverrides.forum;
            changed = true;
        }
        return { ...binding, appOverrides: appOverrides as CharacterBinding["appOverrides"] };
    });
    return {
        config: {
            ...config,
            appDefaults: config.appDefaults && typeof config.appDefaults === "object" ? config.appDefaults : {},
            characterBindings,
        },
        changed,
    };
}

export function loadBindingConfig(): BindingConfig {
    if (typeof window === "undefined") return { ...DEFAULT_BINDING_CONFIG };
    try {
        const raw = kvGet(BINDINGS_KEY);
        if (!raw) {
            // Attempt migration from legacy overrides
            const migrated = migrateLegacyOverrides();
            if (migrated) {
                saveBindingConfig(migrated, false);
                return migrated;
            }
            return { ...DEFAULT_BINDING_CONFIG };
        }
        const normalized = normalizeBindingConfig(JSON.parse(raw) as BindingConfig);
        if (normalized.changed) saveBindingConfig(normalized.config, false);
        return normalized.config;
    } catch {
        return { ...DEFAULT_BINDING_CONFIG };
    }
}

export function saveBindingConfig(config: BindingConfig, notify: boolean = true): void {
    if (typeof window === "undefined") return;
    kvSet(BINDINGS_KEY, JSON.stringify(config));
    if (notify) window.dispatchEvent(new CustomEvent("settings-bindings-updated"));
}

export function getCharacterBinding(config: BindingConfig, characterId: string): CharacterBinding {
    const existing = config.characterBindings.find(b => b.characterId === characterId);
    if (existing) return existing;
    return { characterId, defaults: {}, appOverrides: {} };
}

export function setCharacterBinding(config: BindingConfig, binding: CharacterBinding): BindingConfig {
    const index = config.characterBindings.findIndex(b => b.characterId === binding.characterId);
    const newBindings = [...config.characterBindings];
    if (index >= 0) {
        newBindings[index] = binding;
    } else {
        newBindings.push(binding);
    }
    return { ...config, characterBindings: newBindings };
}

/**
 * Cascade resolution: global defaults → character defaults → app overrides.
 * undefined/empty fields mean "inherit from parent level".
 */
export function resolveBinding(
    config: BindingConfig,
    characterId?: string,
    appId?: string
): BindingSlot {
    const global = config.globalDefaults;

    // Start with global defaults
    const resolved: BindingSlot = {
        apiConfigId: global.apiConfigId,
        voiceConfigId: global.voiceConfigId,
        presetId: global.presetId,
        userIdentityId: global.userIdentityId,
        worldBookIds: global.worldBookIds ? [...global.worldBookIds] : undefined,
        regexIds: global.regexIds ? [...global.regexIds] : undefined,
    };

    const applySlot = (slot: BindingSlot): void => {
        if (slot.apiConfigId) resolved.apiConfigId = slot.apiConfigId;
        if (slot.voiceConfigId) resolved.voiceConfigId = slot.voiceConfigId;
        if (slot.presetId) resolved.presetId = slot.presetId;
        if (slot.userIdentityId) resolved.userIdentityId = slot.userIdentityId;
        if (slot.worldBookIds && slot.worldBookIds.length > 0) resolved.worldBookIds = [...slot.worldBookIds];
        if (slot.regexIds && slot.regexIds.length > 0) resolved.regexIds = [...slot.regexIds];
    };

    if (!characterId) return resolved;

    // Apply character defaults
    const charBinding = config.characterBindings.find(b => b.characterId === characterId);
    if (charBinding) {
        applySlot(charBinding.defaults);
    }

    if (appId && config.appDefaults?.[appId]) {
        applySlot(config.appDefaults[appId]!);
    }

    if (appId && charBinding?.appOverrides[appId]) {
        applySlot(charBinding.appOverrides[appId]!);
    }

    return resolved;
}

/**
 * Resolve auxiliary API config for system features.
 * Falls back to global default apiConfigId if not explicitly set.
 */
export function resolveAuxiliaryApiConfig(
    field: "memorySummaryApiConfigId" | "embeddingApiConfigId" | "mascotApiConfigId" | "reasoningTranslateApiConfigId"
): ApiConfig | null {
    const config = loadBindingConfig();
    const apiConfigs = loadApiConfigs();
    const auxId = config[field];
    if (auxId) {
        const found = apiConfigs.find(c => c.id === auxId);
        if (found) return found;
    }
    // Fallback: global default API config
    if (config.globalDefaults.apiConfigId) {
        return apiConfigs.find(c => c.id === config.globalDefaults.apiConfigId) ?? null;
    }
    return null;
}

// --- Migration from legacy CharacterSettingsOverride ---

type LegacyOverride = {
    characterId: string;
    presetId?: string;
    worldBookId?: string;
    regexId?: string;
};

// --- Follow-up Config ──────────────────────────────────────────

export type FollowUpConfig = {
    prompt: string;              // 追发提示词，支持 {{count}} {{delay}} 占位符
    anxietyThreshold: number;    // 触发阈值（默认 50，0-100）
    anxietyFieldName: string;    // 状态值字段名（默认 "焦虑值"）
    anxietyMinDelay: number;     // 最短延迟 秒（焦虑=100 时，默认 15）
    anxietyMaxDelay: number;     // 最长延迟 秒（焦虑=阈值时，默认 180）
};

export type ChatSendConfig = {
    multiSendGapMs: number;      // 连续多发消息间隙（毫秒）
};

const DEFAULT_FOLLOW_UP_PROMPT = `你已经在未收到{{user}}回复的情况下主动发送了{{count}}条消息。距你上次发消息已过{{delay}}秒。请根据{{char}}的性格决定是静默还是继续发消息。
如果继续发消息，内容应该自然，遵循chat_output_format的格式，不要重复之前说过的话。
如果决定静默，只输出状态值和内心想法，不输出任何聊天消息。`;


export function getDefaultFollowUpConfig(): FollowUpConfig {
    return {
        prompt: DEFAULT_FOLLOW_UP_PROMPT,
        anxietyThreshold: 50,
        anxietyFieldName: "焦虑值",
        anxietyMinDelay: 15,
        anxietyMaxDelay: 180,
    };
}

export function getDefaultChatSendConfig(): ChatSendConfig {
    return {
        multiSendGapMs: 1500,
    };
}

export function loadFollowUpConfig(): FollowUpConfig {
    if (typeof window === "undefined") return getDefaultFollowUpConfig();
    try {
        const raw = kvGet(FOLLOW_UP_CONFIG_KEY);
        if (!raw) return getDefaultFollowUpConfig();
        const parsed = JSON.parse(raw) as Partial<FollowUpConfig>;
        const defaults = getDefaultFollowUpConfig();
        return {
            prompt: typeof parsed.prompt === "string" && parsed.prompt.trim() ? parsed.prompt : defaults.prompt,
            anxietyThreshold: typeof parsed.anxietyThreshold === "number" ? Math.max(0, Math.min(100, parsed.anxietyThreshold)) : defaults.anxietyThreshold,
            anxietyFieldName: typeof parsed.anxietyFieldName === "string" && parsed.anxietyFieldName.trim() ? parsed.anxietyFieldName : defaults.anxietyFieldName,
            anxietyMinDelay: typeof parsed.anxietyMinDelay === "number" ? Math.max(5, Math.min(300, parsed.anxietyMinDelay)) : defaults.anxietyMinDelay,
            anxietyMaxDelay: typeof parsed.anxietyMaxDelay === "number" ? Math.max(15, Math.min(600, parsed.anxietyMaxDelay)) : defaults.anxietyMaxDelay,
        };
    } catch {
        return getDefaultFollowUpConfig();
    }
}

export function saveFollowUpConfig(config: FollowUpConfig): void {
    if (typeof window === "undefined") return;
    kvSet(FOLLOW_UP_CONFIG_KEY, JSON.stringify(config));
}

export function loadChatSendConfig(): ChatSendConfig {
    if (typeof window === "undefined") return getDefaultChatSendConfig();
    try {
        const raw = kvGet(CHAT_SEND_CONFIG_KEY);
        if (!raw) return getDefaultChatSendConfig();
        const parsed = JSON.parse(raw) as Partial<ChatSendConfig>;
        const defaults = getDefaultChatSendConfig();
        return {
            multiSendGapMs: typeof parsed.multiSendGapMs === "number"
                ? Math.max(500, Math.min(10000, Math.round(parsed.multiSendGapMs / 500) * 500))
                : defaults.multiSendGapMs,
        };
    } catch {
        return getDefaultChatSendConfig();
    }
}

export function saveChatSendConfig(config: ChatSendConfig): void {
    if (typeof window === "undefined") return;
    const normalized = {
        multiSendGapMs: Math.max(500, Math.min(10000, Math.round(config.multiSendGapMs / 500) * 500)),
    };
    kvSet(CHAT_SEND_CONFIG_KEY, JSON.stringify(normalized));
}

// --- User Identities ──────────────────────────────────────────

export function loadUserIdentities(): UserIdentity[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(USER_IDENTITIES_KEY);
        if (!raw) return [];
        return JSON.parse(raw) as UserIdentity[];
    } catch {
        return [];
    }
}

export function saveUserIdentities(identities: UserIdentity[]): void {
    if (typeof window === "undefined") return;
    kvSet(USER_IDENTITIES_KEY, JSON.stringify(identities));
}

/**
 * Resolve user identity through the binding cascade:
 *   global defaults → character defaults → app overrides.
 * Falls back to first identity if binding has no userIdentityId set.
 */
export function resolveUserIdentity(characterId?: string, appId?: string): UserIdentity | null {
    const identities = loadUserIdentities();
    if (identities.length === 0) return null;
    const config = loadBindingConfig();
    const resolved = resolveBinding(config, characterId, appId);
    if (resolved.userIdentityId) {
        return identities.find(i => i.id === resolved.userIdentityId) || identities[0];
    }
    return identities[0];
}

// --- Migration from legacy CharacterSettingsOverride ---

function migrateLegacyOverrides(): BindingConfig | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(LEGACY_OVERRIDES_KEY);
        if (!raw) return null;

        const legacyOverrides = JSON.parse(raw) as LegacyOverride[];
        if (!Array.isArray(legacyOverrides) || legacyOverrides.length === 0) return null;

        const config: BindingConfig = {
            globalDefaults: {},
            appDefaults: {},
            characterBindings: legacyOverrides.map(o => ({
                characterId: o.characterId,
                defaults: {
                    presetId: o.presetId,
                    worldBookIds: o.worldBookId ? [o.worldBookId] : undefined,
                    regexIds: o.regexId ? [o.regexId] : undefined,
                },
                appOverrides: {}
            }))
        };

        return config;
    } catch {
        return null;
    }
}
