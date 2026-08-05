export type SettingItemMeta = {
    id: string;
    name: string;
    description?: string;
    createdAt: number;
    updatedAt: number;
};

// --- WorldBook ---
export type WorldBookEntry = {
    uid: string;
    key: string;
    content: string;
    comment: string;
    use_regex: boolean;
    disable: boolean;
    constant: boolean;
    position: "before_char" | "after_char" | "before_em" | "after_em" | "before_an" | "after_an" | number;
    depth?: number;
    probability?: number;
    useProbability?: boolean;
    role?: number;
    insertion_order: number;
};

export type WorldBookConfig = SettingItemMeta & {
    entries: WorldBookEntry[];
};

// --- Preset ---
export type PromptOrderEntry = {
    identifier: string;
    enabled: boolean;
};

export type Prompt = {
    identifier: string;
    name: string;
    role: "system" | "user" | "assistant" | string;
    content: string;
    injection_depth: number;
    /** @deprecated Prompt order is determined by prompt_order / array order when depth matches. */
    injection_order?: number;
    enabled: boolean;
    system_prompt?: boolean;
    marker?: boolean;
    forbid_overrides?: boolean;
    injection_position?: number;
    /** @deprecated Use `tags` instead. */
    featureTag?: string;
    /** @deprecated Use `tags: [..., "followup"]` instead. */
    followUpOnly?: boolean;
    /** Multi-tag filtering. Entry is included only when ALL its tags are present in the active appTags. Empty/undefined = universal. */
    tags?: string[];
};

export type PresetConfig = SettingItemMeta & {
    builtIn?: boolean;
    builtInVersion?: number;
    temperature: number;
    top_p: number;
    top_k: number;
    frequency_penalty: number;
    presence_penalty: number;
    repetition_penalty: number;
    openai_max_tokens: number;
    openai_max_context: number;
    top_a?: number;
    min_p?: number;
    wrap_in_quotes?: boolean;
    names_behavior?: number;
    send_if_empty?: string;
    impersonation_prompt?: string;
    new_chat_prompt?: string;
    new_group_chat_prompt?: string;
    new_example_chat_prompt?: string;
    continue_nudge_prompt?: string;
    group_nudge_prompt?: string;
    bias_preset_selected?: string;
    max_context_unlocked?: boolean;
    wi_format?: string;
    scenario_format?: string;
    personality_format?: string;
    story_summary_tag?: string;
    prompt_order?: PromptOrderEntry[];
    prompts: Prompt[];
};

// --- Regex ---
// Regex rule config.
export type RegexRule = {
    id: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    /** Multi-tag filtering. Rule is included only when ALL its tags are present in the active appTags. Empty/undefined = universal. */
    tags?: string[];
    trimStrings?: string[];       // Strings to remove from each capture-group match before replacement
    disabled: boolean;
    placement: number[];          // 1=USER_INPUT, 2=AI_OUTPUT, 3=SLASH_COMMAND, 5=WORLD_INFO, 6=REASONING
    markdownOnly?: boolean;       // true → only apply during display rendering (non-destructive)
    promptOnly?: boolean;         // true → only apply during prompt assembly (non-destructive)
    runOnEdit?: boolean;          // true → also apply when user edits an existing message
    substituteRegex?: number;     // 0=NONE, 1=RAW macro substitution in findRegex, 2=ESCAPED
    minDepth?: number;            // Minimum message depth (-1 = unlimited)
    maxDepth?: number;            // Maximum message depth
};

export type RegexConfig = SettingItemMeta & {
    builtIn?: boolean;
    rules: RegexRule[];
};

// --- ApiConfig (migrated from api-settings.tsx) ---
export type ApiConfig = {
    id: string;
    name?: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
    defaultModel: string;
    enableNativeTools?: boolean;
    enableImageRecognition: boolean;
    enableImageGeneration: boolean;
    preventEmptyGenerateRambling?: boolean;
};

// --- VoiceApiConfig (migrated from voice-settings.tsx) ---
export type VoiceApiConfig = {
    id: string;
    name?: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
    region?: string;
    model?: string;
    sttModel?: string;
    defaultVoice: string;
    languageBoost?: string;
    customVoices?: { id: string; name: string; createdAt?: number }[];
    enableSTT: boolean;
    enableTTS: boolean;
};

// --- Image Generation ---
export type ImageGenerationRequestMode = "server" | "direct";
export type ImageProvider = "openai" | "novelai" | "pollinations" | "google-imagen";

export type ImageHostingProvider = "none" | "imgbb";

export type ImageHostingSettings = {
    provider: ImageHostingProvider;
    imgbbApiKey: string;
    defaultExpirationSeconds: number;
    maxUploadBytes: number;
    autoConvertToWebp: boolean;
    allowMascotUpload: boolean;
};

/** NovelAI 专属配置 */
export type NovelAIConfig = {
    /** NovelAI API 地址（官方 https://image.novelai.net 或中转站；留空=内置官方、浏览器直连） */
    url: string;
    /** NovelAI API Key（pst-... 或中转站 key） */
    apiKey: string;
    /** 模型名，默认 nai-diffusion-4-5-full */
    model: string;
    /** 尺寸预设 */
    size: string;
    /** 正向提示词前缀（如 {handsome}, {delicate features}） */
    positivePrefix: string;
    /** 正向质量词后缀（如 best quality, masterpiece） */
    qualitySuffix: string;
    /** 负面提示词 */
    negativePrompt: string;
    /** 提示词模板，{prompt} 会被替换为实际描述 */
    promptTemplate: string;
    /** 默认画风（留空 = 不套用） */
    defaultStyle: string;
    // ---- 截图中的高级参数 ----
    /** 参考图数据（base64 data URL，用于风格迁移） */
    referenceImageDataUrl: string;
    /** 画风强度 0~1，越高越贴近参考画风（建议 0.5~0.7） */
    styleStrength: number;
    /** 采样步数 (Steps)，推荐值 28 */
    steps: number;
    /** 提示词相关性 (CFG Scale)，推荐值 5 */
    cfgScale: number;
    /** 采样器 (Sampler) */
    sampler: string;
    /** 噪声调度 (Noise Schedule) */
    noiseSchedule: string;
    /** 随机种子 (Seed)，留空则随机；-1 表示每次随机生成 */
    seed: string | null;
    /** 预设组列表 */
    presetGroups: NaiPresetGroup[];
    // ---- 截图中但之前缺失的字段 ----
    /** 负面预设 (UC PRESET)：0=Heavy, 1=Light, 2=Off 等 */
    ucPreset: number;
    /** 自动添加质量标签 (Quality Tags)：是否自动在提示词末尾追加质量词 */
    qualityTags: boolean;
    /** SMEA(提升细节)：NAI v3 细节增强参数 */
    smea: boolean;
    /** SMEA DYN(动态优化)：NAI v3 动态优化参数 */
    smeaDyn: boolean;
    /** 出图接口模式：stream=流式(/ai/generate-image), normal=普通接口 */
    endpointMode: "stream" | "normal";
    /** CORS 跨域代理：本地开发时建议开启 */
    corsProxy: boolean;
};

/** Pollinations 专属配置（免费、免 Key 即可用） */
export type PollinationsConfig = {
    /** 可选认证 token（去 pollinations.ai 注册后获得，提升额度/避免限流）；留空=匿名免费 */
    apiKey: string;
    /** 模型，默认 flux（可选 turbo / flux-realism / flux-anime 等） */
    model: string;
    /** 宽 */
    width: number;
    /** 高 */
    height: number;
    /** 随机种子，留空=每次随机 */
    seed: string;
    /** 提示词增强（让 AI 自动优化描述） */
    enhance: boolean;
    /** 去除 Pollinations 水印 logo */
    nologo: boolean;
};

/** Google Imagen 专属配置 */
export type GoogleImagenConfig = {
    /** Google AI Studio / GCP API Key（必填） */
    apiKey: string;
    /** 模型名，如 imagen-3.0-generate-002 / imagen-4.0-generate-001 */
    model: string;
    /** 宽 */
    width: number;
    /** 高 */
    height: number;
    /** 负面提示词（排除不想要的内容） */
    negativePrompt: string;
    /** 宽高比预设（如 1:1 / 3:4 / 4:3 / 16:9 / 9:16） */
    aspectRatio: string;
    /** 是否允许生成人物（dont_allow / allow_adult / allow_all） */
    personGeneration: string;
};

/** NAI 预设 */
export type NaiPreset = {
    id: string;
    name: string;
    positivePrefix: string;
    negativePrompt: string;
    styleStrength: number;
    steps: number;
    cfgScale: number;
    sampler: string;
    noiseSchedule: string;
    size: string;
    defaultStyle: string;
    createdAt: number;
};

/** NAI 预设组 */
export type NaiPresetGroup = {
    id: string;
    name: string;
    presets: NaiPreset[];
    activePresetId: string | null;
};

export type ImageGenerationSettings = {
    enabled: boolean;
    requestMode: ImageGenerationRequestMode;
    /** 当前使用的生图 Provider */
    provider: ImageProvider;
    // --- OpenAI 兼容字段 ---
    apiKey: string;
    baseUrl: string;
    model: string;
    size: string;
    quality: string;
    extraPrompt: string;
    // --- 生图场景结构化字段（锁脸 + 结构化提示词用）---
    sceneBackground: string;   // 背景描述（中文），如「樱花公园、樱花飞舞」
    sceneLighting: string;     // 光源描述（中文），如「逆光、暖色夕阳、柔光」
    // --- NovelAI 字段 ---
    novelai: NovelAIConfig;
    // --- Pollinations 字段 ---
    pollinations: PollinationsConfig;
    // --- Google Imagen 字段 ---
    googleImagen: GoogleImagenConfig;
    // --- 通用字段 ---
    characterReferences: Record<string, {
        assetId: string;
        updatedAt: number;
    }>;
    imageHosting: ImageHostingSettings;
};

// --- Configuration Binding System ---

// Content apps that can have per-character bindings.
export type ContentAppId =
    | "chat" | "diary" | "music" | "reading"
    | "forum" | "cocreate" | "story" | "game" | "xiaohongshu" | "dwelling"
    | "checkphone" | "shopping" | "calendar" | "interview_magazine"
    | "moments" | "group_chat" | "vn" | "adventure";

export const CONTENT_APP_IDS: ContentAppId[] = [
    "chat", "diary", "music", "reading",
    "cocreate", "story", "game", "xiaohongshu", "dwelling",
    "checkphone", "shopping", "calendar", "interview_magazine",
    "moments", "group_chat", "vn", "adventure"
];

export const CONTENT_APP_LABELS: Record<ContentAppId, string> = {
    chat: "聊天",
    diary: "手记",
    music: "音乐",
    reading: "阅读",
    forum: "论坛（旧）",
    cocreate: "共创",
    story: "剧情",
    game: "游戏",
    xiaohongshu: "小红书",
    dwelling: "栖所",
    checkphone: "查手机",
    shopping: "购物",
    calendar: "日历",
    interview_magazine: "在场",
    moments: "朋友圈",
    group_chat: "群聊",
    vn: "漫卷",
    adventure: "冒险",
};

// Binding slot — config selections for a given scope
export type BindingSlot = {
    apiConfigId?: string;
    voiceConfigId?: string;
    presetId?: string;
    userIdentityId?: string;
    worldBookIds?: string[];
    regexIds?: string[];
};

// Character binding: character defaults + per-app overrides
export type CharacterBinding = {
    characterId: string;
    defaults: BindingSlot;
    appOverrides: Partial<Record<string, BindingSlot>>;
};

// Overall binding configuration
export type BindingConfig = {
    globalDefaults: BindingSlot;
    /** App-level defaults shared by every character; character app overrides still win. */
    appDefaults?: Partial<Record<string, BindingSlot>>;
    characterBindings: CharacterBinding[];
    /** Auxiliary API: used for memory summarization (global, not per-character) */
    memorySummaryApiConfigId?: string;
    /** Auxiliary API: used for embedding/vector recall (global, not per-character) */
    embeddingApiConfigId?: string;
    /** Auxiliary API: used by the mascot assistant (global, not per-character) */
    mascotApiConfigId?: string;
    /** Auxiliary API: used to translate reasoning/chain-of-thought text (global, not per-character) */
    reasoningTranslateApiConfigId?: string;
};

// --- Chat Toolbox ---
export type RestToolPackageConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type RestToolConfig = {
    id: string;
    packageId?: string;
    name: string;
    description: string;
    endpoint: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    bodyTemplate?: string;        // Optional JSON body template with {{param}} placeholders
    parameterSchema: string;       // JSON Schema for LLM-visible params only
    fixedParams?: Record<string, string>;  // auto-injected params (api_key etc), hidden from LLM
    enabled: boolean;
    builtIn?: boolean;
    directFetch?: boolean;         // true = browser direct fetch, false = server proxy
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type CompositeToolStep = {
    id: string;
    name?: string;
    toolType?: "auto" | "rest" | "internal" | "mcp" | "composite" | "script";
    toolId?: string;
    serverId?: string;
    toolName?: string;
    argsTemplate?: string;        // JSON object template. Supports {{input.xxx}}, {{steps.key.data}}, {{last.data}}
    script?: string;              // Arbitrary async JS for script steps. Receives input, steps, last, args, context.
    saveAs?: string;
};

export type CompositeToolPackageConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type CompositeToolConfig = {
    id: string;
    packageId?: string;
    name: string;
    description: string;
    parameterSchema: string;
    steps: CompositeToolStep[];
    outputTemplate?: string;
    enabled: boolean;
    builtIn?: boolean;
    createdBy?: "user" | "ai";
    createdAt: number;
    updatedAt: number;
};

export type McpDiscoveredTool = {
    name: string;
    description: string;
    inputSchema: object;
};

export type McpServerConfig = {
    id: string;
    name: string;
    description?: string;
    url: string;
    enabled: boolean;
    headers?: Record<string, string>;
    discoveredTools?: McpDiscoveredTool[];
    // Session state (runtime, not persisted across page refresh)
    sessionId?: string;
    // OAuth tokens (persisted)
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthTokenEndpoint?: string;
    oauthAuthorizationEndpoint?: string;
    oauthRegistrationEndpoint?: string;
    oauthAuthorizationServer?: string;
    oauthProtectedResourceMetadataUrl?: string;
    createdAt: number;
    updatedAt: number;
};

// --- Internal Capabilities ---
export type InternalCapabilityMode = "off" | "confirm" | "auto";

export type InternalCapabilityConfig = {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    mode: InternalCapabilityMode;
    createdAt: number;
    updatedAt: number;
};
