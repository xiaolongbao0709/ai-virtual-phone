"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, Camera, ChevronDown, HelpCircle, Image, RefreshCw, Sparkles, Trash2, Upload, X, BookOpen, Plus, Save } from "lucide-react";
import type { ImageGenerationSettings as ImageGenerationSettingsType, NaiPreset, NaiPresetGroup } from "@/lib/settings-types";
import {
    DEFAULT_IMAGE_GENERATION_SETTINGS,
    loadImageGenerationSettings,
    saveImageGenerationSettings,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import {
    fetchImageGenerationModels,
    filterLikelyImageModels,
    generateImageFromConfiguredApi,
} from "@/lib/image-generation-service";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";

const SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024"];
const QUALITY_OPTIONS = ["auto", "low", "medium", "high"];

/** NovelAI 尺寸选项 */
const NAI_SIZE_OPTIONS = [
    { value: "832x1216", label: "832x1216（竖图）" },
    { value: "1216x832", label: "1216x832（横图）" },
    { value: "1024x1024", label: "1024x1024（正方）" },
    { value: "832x832", label: "832x832（小正方）" },
    { value: "1280x720", label: "1280x720（横版）" },
    { value: "720x1280", label: "720x1280（竖版）" },
    { value: "1024x768", label: "1024x768（经典）" },
    { value: "768x1024", label: "768x1024（竖经典）" },
];

/** NAI 模型预设 */
const NAI_MODEL_OPTIONS = [
    { value: "nai-diffusion-4-5-full", label: "nai-diffusion-4-5-full" },
    { value: "nai-diffusion-3", label: "nai-diffusion-3" },
    { value: "nai-diffusion-xl", label: "nai-diffusion-xl" },
];

/** NAI 采样器选项 */
const NAI_SAMPLER_OPTIONS = [
    { value: "dpmpp_2m", label: "DPM++ 2M" },
    { value: "euler_ancestral", label: "Euler Ancestral" },
    { value: "euler", label: "Euler" },
    { value: "dpmpp_2m_sde", label: "DPM++ 2M SDE" },
    { value: "ddim", label: "DDIM" },
    { value: "uni_pc", label: "UniPC" },
];

/** NAI UC 预设选项 */
const NAI_UC_PRESET_OPTIONS = [
    { value: 0, label: "Preset 0 - Heavy" },
    { value: 1, label: "Preset 1 - Light" },
    { value: 2, label: "Preset 2 - Off" },
    { value: 3, label: "Preset 3 - Minimal" },
];

/** 出图接口选项 */
const NAI_ENDPOINT_OPTIONS = [
    { value: "stream", label: "流式 /ai/generate-image" },
    { value: "normal", label: "普通 /generate-image" },
];

/** NAI 噪声调度选项 */
const NAI_NOISE_SCHEDULE_OPTIONS = [
    { value: "karras", label: "Karras" },
    { value: "exponential", label: "Exponential" },
    { value: "polyexponential", label: "Polyexponential" },
    { value: "constant", label: "Constant" },
    { value: "native", label: "Native" },
];

/** Pollinations 模型选项 */
const POLLINATIONS_MODEL_OPTIONS = [
    { value: "flux", label: "flux（质量高）" },
    { value: "flux-realism", label: "flux-realism" },
    { value: "flux-anime", label: "flux-anime" },
    { value: "flux-3d", label: "flux-3d" },
    { value: "turbo", label: "turbo（速度快）" },
    { value: "gptimage", label: "gptimage" },
];

/** Google Imagen 模型选项 */
const GOOGLE_IMAGEN_MODEL_OPTIONS = [
    { value: "imagen-3.0-generate-002", label: "imagen-3.0-generate-002" },
    { value: "imagen-3.0-fast-generate-001", label: "imagen-3.0-fast-generate-001" },
    { value: "imagen-4.0-generate-001", label: "imagen-4.0-generate-001" },
    { value: "imagen-4.0-fast-generate-001", label: "imagen-4.0-fast-generate-001" },
];

/** Google Imagen 宽高比选项 */
const GOOGLE_ASPECT_RATIO_OPTIONS = [
    { value: "1:1", label: "1:1（正方形）" },
    { value: "3:4", label: "3:4（竖图）" },
    { value: "4:3", label: "4:3（横图）" },
    { value: "16:9", label: "16:9（宽屏）" },
    { value: "9:16", label: "9:16（竖屏）" },
];

/** Google Imagen 人物生成选项 */
const GOOGLE_PERSON_OPTIONS = [
    { value: "dont_allow", label: "dont_allow（不生成人物）" },
    { value: "allow_adult", label: "allow_adult（成人）" },
    { value: "allow_all", label: "allow_all（全部）" },
];

/** Provider 选项 */
const PROVIDER_OPTIONS = [
    { value: "openai", label: "OpenAI 兼容" },
    { value: "novelai", label: "NovelAI" },
    { value: "pollinations", label: "Pollinations" },
    { value: "google-imagen", label: "Google Imagen" },
] as const;

// Some relay APIs ignore the `size` param and pick their own aspect ratio.
const RATIO_HINT_MARKER = "【画面比例】";
const SIZE_RATIO_HINTS: Record<string, string> = {
    "1024x1024": "正方形 1:1 构图，square 1:1 composition",
    "1024x1536": "竖向 2:3 构图，vertical portrait composition",
    "1536x1024": "横向 3:2 构图，horizontal landscape composition",
};

function stripRatioHint(text: string): string {
    return text.replace(new RegExp(`\\s*${RATIO_HINT_MARKER}[^\\n]*`, "g"), "").replace(/\s+$/, "");
}

function withRatioHint(extraPrompt: string, size: string): string {
    const base = stripRatioHint(extraPrompt);
    const hint = SIZE_RATIO_HINTS[size];
    if (!hint) return base;
    return base ? `${base}\n${RATIO_HINT_MARKER}${hint}` : `${RATIO_HINT_MARKER}${hint}`;
}

const IMAGE_HOSTING_PROVIDER_OPTIONS = [
    { value: "none", label: "不使用图床" },
    { value: "imgbb", label: "ImgBB" },
] as const;

const imageGenerationIconStyle = { "--icon-color": "#0EA5E9" } as CSSProperties;
const naiIconStyle = { "--icon-color": "#A855F7" } as CSSProperties;
const pollinationsIconStyle = { "--icon-color": "#EC4899" } as CSSProperties;
const googleImagenIconStyle = { "--icon-color": "#4285F4" } as CSSProperties;

/** 各 Provider 的折叠式使用说明 */
function ProviderHelp({ which }: { which: "novelai" | "pollinations" | "google-imagen" }) {
    const content: Record<string, { title: string; items: string[] }> = {
        novelai: {
            title: "NovelAI 使用说明",
            items: [
                "NovelAI 官方的生图服务，擅长二次元 / 插画风格生图。",
                "API URL：留空即用官方 https://api.novelai.net；也可填中转站 / 镜像地址。",
                "API Access Token：在 NovelAI 官网 Account → Get AI Token 获取，格式 pst-...。",
                "出图接口：官方支持流式；中转站不支持时切到「普通接口」。",
                "参考图 / 画风强度 / 预设组等高级项，点「打开 NovelAI 详细设置」调整。",
                "填好后点「测试生图」验证；密钥仅保存在本地，不会上传。",
            ],
        },
        pollinations: {
            title: "Pollinations 使用说明",
            items: [
                "免费 AI 生图接口，无需 API Key 也能直接调用，适合快速 / 白嫖出图。",
                "默认使用公开接口 https://image.pollinations.ai，一般无需填写 Key。",
                "如需更高并发 / 额度，可在 Pollinations 官网获取账号 API Key 后填入。",
                "启用后点「测试生图」即可验证。",
            ],
        },
        "google-imagen": {
            title: "Google Imagen 使用说明",
            items: [
                "Google 文生图模型（Imagen 3），写实画质强，可能需要付费。",
                "API Key：在 Google AI Studio（aistudio.google.com）→ API Key 获取，格式 AIza...。",
                "填入 Key 与模型（如 imagen-3.0-generate-002）后即可使用。",
                "启用后点「测试生图」验证；密钥仅保存在本地。",
            ],
        },
    };
    const c = content[which];
    return (
        <div className="menu-group p-4 flex flex-col gap-2">
            <p className="menu-desc font-semibold">{c.title}</p>
            <ul className="menu-desc opacity-80 list-disc pl-5 flex flex-col gap-1 text-sm">
                {c.items.map((it, i) => (
                    <li key={i}>{it}</li>
                ))}
            </ul>
        </div>
    );
}

type Status = { success: boolean; message: string };

const DEFAULT_TEST_PROMPT = "一张放在桌面上的白色咖啡杯，柔和自然光，真实照片风格";

/** 专门的「测试生图」卡片：自定义提示词 + 测试按钮 + 带边框的预览框（对所有 Provider 生效） */
function TestGenCard({
    onTest,
    status,
    testPreviewUrl,
    isTesting,
}: {
    onTest: (prompt: string) => void;
    status: Status | null;
    testPreviewUrl: string | null;
    isTesting: boolean;
}) {
    const [prompt, setPrompt] = useState(DEFAULT_TEST_PROMPT);
    return (
        <div className="menu-group p-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <label className="menu-desc ml-1">测试提示词</label>
                <Textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={DEFAULT_TEST_PROMPT}
                    rows={3}
                />
                <p className="menu-desc ml-1 opacity-60 text-xs">
                    点击「测试生图」按当前选中的生图引擎出一张图，结果展示在下方预览框。
                </p>
            </div>
            <button
                type="button"
                className="ui-btn ui-btn-success"
                onClick={() => onTest(prompt)}
                disabled={isTesting}
            >
                <Image size={16} />
                {isTesting ? "测试中..." : "测试生图"}
            </button>
            {status && (
                <Alert variant={status.success ? "success" : "danger"}>
                    <AlertCircle size={16} className="mt-[2px] shrink-0" />
                    <span className="break-all leading-[1.5]">{status.message}</span>
                </Alert>
            )}
            <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-[var(--c-card-border)] bg-[var(--c-card-bg)]/40 p-4">
                {testPreviewUrl ? (
                    <img
                        src={testPreviewUrl}
                        alt="测试生图结果"
                        className="max-h-[300px] max-w-full rounded-lg object-contain"
                    />
                ) : (
                    <span className="menu-desc text-center text-sm opacity-50">测试生图结果将显示在此</span>
                )}
            </div>
        </div>
    );
}

/** 生成唯一 ID */
function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function ImageGenerationSettings() {
    const [settings, setSettings] = useState<ImageGenerationSettingsType>(DEFAULT_IMAGE_GENERATION_SETTINGS);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [referencePreviews, setReferencePreviews] = useState<Record<string, string>>({});
    const [models, setModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);

    // ---- NAI 弹窗状态 ----
    const [showNaiModal, setShowNaiModal] = useState(false);
    const [naiRefPreview, setNaiRefPreview] = useState<string | null>(null);
    const [presetGroupName, setPresetGroupName] = useState("");
    const [activeGroupId, setActiveGroupId] = useState<string>("");
    // 折叠式使用说明（一次只展开一个 Provider）
    const [openHelp, setOpenHelp] = useState<string | null>(null);

    useEffect(() => {
        const loaded = loadImageGenerationSettings();
        const syncedExtra = withRatioHint(loaded.extraPrompt, loaded.size);
        if (syncedExtra !== loaded.extraPrompt) {
            const next = { ...loaded, extraPrompt: syncedExtra };
            saveImageGenerationSettings(next);
            setSettings(next);
        } else {
            setSettings(loaded);
        }
        // 加载 NAI 参考图预览
        if (loaded.novelai?.referenceImageDataUrl) {
            setNaiRefPreview(loaded.novelai.referenceImageDataUrl);
        }
        setCharacters(loadCharacters());
    }, []);

    useEffect(() => {
        let cancelled = false;
        const refs = settings.characterReferences || {};
        Promise.all(Object.entries(refs).map(async ([characterId, ref]) => {
            const dataUrl = ref.assetId ? await getChatImageFromIndexedDB(ref.assetId) : null;
            return [characterId, dataUrl] as const;
        })).then(entries => {
            if (cancelled) return;
            const next: Record<string, string> = {};
            for (const [characterId, dataUrl] of entries) {
                if (dataUrl) next[characterId] = dataUrl;
            }
            setReferencePreviews(next);
        });
        return () => { cancelled = true };
    }, [settings.characterReferences]);

    useEffect(() => {
        return () => {
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
        };
    }, [testPreviewUrl]);

    const persist = useCallback((next: ImageGenerationSettingsType) => {
        setSettings(next);
        saveImageGenerationSettings(next);
    }, []);

    const updateSettings = useCallback((patch: Partial<ImageGenerationSettingsType>) => {
        persist({ ...settings, ...patch });
    }, [persist, settings]);

    const applySize = useCallback((size: string) => {
        persist({ ...settings, size, extraPrompt: withRatioHint(settings.extraPrompt, size) });
    }, [persist, settings]);

    const updateImageHosting = useCallback((patch: Partial<ImageGenerationSettingsType["imageHosting"]>) => {
        persist({
            ...settings,
            imageHosting: { ...settings.imageHosting, ...patch },
        });
    }, [persist, settings]);

    /** 更新 NAI 子配置 */
    const updateNai = useCallback((patch: Partial<ImageGenerationSettingsType["novelai"]>) => {
        persist({
            ...settings,
            novelai: { ...settings.novelai, ...patch },
        });
    }, [persist, settings]);

    /** 更新 Pollinations 子配置 */
    const updatePollinations = useCallback((patch: Partial<ImageGenerationSettingsType["pollinations"]>) => {
        persist({
            ...settings,
            pollinations: { ...settings.pollinations, ...patch },
        });
    }, [persist, settings]);

    /** 更新 Google Imagen 子配置 */
    const updateGoogleImagen = useCallback((patch: Partial<ImageGenerationSettingsType["googleImagen"]>) => {
        persist({
            ...settings,
            googleImagen: { ...settings.googleImagen, ...patch },
        });
    }, [persist, settings]);

    const likelyModels = useMemo(() => filterLikelyImageModels(models), [models]);

    // ── 拉取模型（OAI）──
    const fetchModels = async () => {
        setStatus(null);
        if (!settings.apiKey.trim() || !settings.baseUrl.trim()) {
            setStatus({ success: false, message: "请先填写 Base URL 和 API Key。" });
            return;
        }
        setIsFetchingModels(true);
        try {
            const fetched = await fetchImageGenerationModels(settings);
            setModels(fetched);
            setStatus({
                success: true,
                message: fetched.length > 0 ? `已拉取 ${fetched.length} 个模型。` : "接口返回为空，可手动填写模型名。",
            });
        } catch (err) {
            setModels([]);
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingModels(false);
        }
    };

    // ── 测试生图（自动根据 provider 选择逻辑，支持自定义提示词）──
    const testGeneration = async (customPrompt?: string) => {
        setStatus(null);
        setIsTesting(true);
        try {
            const result = await generateImageFromConfiguredApi({
                description: customPrompt && customPrompt.trim()
                    ? customPrompt.trim()
                    : "一张放在桌面上的白色咖啡杯，柔和自然光，真实照片风格",
                settings: { ...settings, enabled: true },
            });
            if (!result) throw new Error("图像生成未返回结果。");
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
            setTestPreviewUrl(URL.createObjectURL(result.blob));
            setStatus({ success: true, message: "测试生图成功。" });
        } catch (err) {
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsTesting(false);
        }
    };

    // ── NAI 参考图上传 ──
    const naiFileInputRef = useRef<HTMLInputElement>(null);
    const uploadNaiReference = async (file: File) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            setNaiRefPreview(dataUrl);
            updateNai({ referenceImageDataUrl: dataUrl });
        };
        reader.readAsDataURL(file);
    };

    const removeNaiReference = () => {
        setNaiRefPreview(null);
        updateNai({ referenceImageDataUrl: "" });
    };

    // ── 预设管理 ──
    const activeGroup = useMemo(
        () => settings.novelai.presetGroups.find(g => g.id === activeGroupId),
        [settings.novelai.presetGroups, activeGroupId]
    );
    const activePreset = useMemo(
        () => activeGroup?.presets.find(p => p.id === activeGroup?.activePresetId),
        [activeGroup]
    );

    /** 应用预设到当前设置 */
    const applyPreset = (preset: NaiPreset) => {
        updateNai({
            positivePrefix: preset.positivePrefix,
            negativePrompt: preset.negativePrompt,
            styleStrength: preset.styleStrength,
            steps: preset.steps,
            cfgScale: preset.cfgScale,
            sampler: preset.sampler,
            noiseSchedule: preset.noiseSchedule,
            size: preset.size || settings.novelai.size,
            defaultStyle: preset.defaultStyle,
        });
    };

    /** 保存当前设置为预设 */
    const saveCurrentAsPreset = (name: string) => {
        const newPreset: NaiPreset = {
            id: uid(),
            name,
            positivePrefix: settings.novelai.positivePrefix,
            negativePrompt: settings.novelai.negativePrompt,
            styleStrength: settings.novelai.styleStrength,
            steps: settings.novelai.steps,
            cfgScale: settings.novelai.cfgScale,
            sampler: settings.novelai.sampler,
            noiseSchedule: settings.novelai.noiseSchedule,
            size: settings.novelai.size,
            defaultStyle: settings.novelai.defaultStyle,
            createdAt: Date.now(),
        };
        let groups = [...settings.novelai.presetGroups];
        let group = groups.find(g => g.id === activeGroupId);
        if (!group) {
            group = { id: uid(), name: "默认组", presets: [], activePresetId: null };
            groups.push(group);
            setActiveGroupId(group.id);
        }
        group.presets.push(newPreset);
        group.activePresetId = newPreset.id;
        updateNai({ presetGroups: groups });
    };

    /** 新建预设组 */
    const createPresetGroup = (name: string) => {
        const newGroup: NaiPresetGroup = {
            id: uid(),
            name,
            presets: [],
            activePresetId: null,
        };
        const groups = [...settings.novelai.presetGroups, newGroup];
        updateNai({ presetGroups: groups });
        setActiveGroupId(newGroup.id);
    };

    /** 恢复 NAI 默认值 */
    const resetNaiDefaults = () => {
        updateNai({
            ...DEFAULT_IMAGE_GENERATION_SETTINGS.novelai,
            presetGroups: settings.novelai.presetGroups, // 保留预设组
        });
        setNaiRefPreview(null);
    };

    const uploadReference = async (characterId: string, file: File) => {
        const assetId = await saveChatImageToIndexedDB(file);
        persist({
            ...settings,
            characterReferences: {
                ...(settings.characterReferences || {}),
                [characterId]: { assetId, updatedAt: Date.now() },
            },
        });
    };

    const removeReference = (characterId: string) => {
        const nextRefs = { ...(settings.characterReferences || {}) };
        delete nextRefs[characterId];
        persist({ ...settings, characterReferences: nextRefs });
        setReferencePreviews(prev => {
            const next = { ...prev };
            delete next[characterId];
            return next;
        });
    };

    const isNai = settings.provider === "novelai";
    const isPollinations = settings.provider === "pollinations";
    const isGoogleImagen = settings.provider === "google-imagen";

    // Provider 图标样式
    const providerIconStyle = isNai ? naiIconStyle
        : isPollinations ? pollinationsIconStyle
        : isGoogleImagen ? googleImagenIconStyle
        : imageGenerationIconStyle;

    return (
        <div className="flex flex-col gap-6 pb-8">
            {/* ════════════ 标题栏 ════════════ */}
            <div className="flex items-center justify-between">
                <div className="flex items-center">
                    <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">
                        图像生成
                    </h2>
                </div>
                {/* 读取生图世界书 */}
                <button
                    type="button"
                    className="ui-btn ui-btn-primary"
                    onClick={() => {
                        try {
                            const worldBookStr = localStorage.getItem("image_gen_worldbook") || "";
                            if (!worldBookStr) {
                                setStatus({ success: false, message: "暂无生图世界书数据。请在聊天中通过 /worldbook 命令导入。" });
                                return;
                            }
                            const wb = JSON.parse(worldBookStr);
                            if (wb.positivePrefix) updateNai({ positivePrefix: wb.positivePrefix });
                            if (wb.negativePrompt) updateNai({ negativePrompt: wb.negativePrompt });
                            if (wb.qualitySuffix) updateNai({ qualitySuffix: wb.qualitySuffix });
                            if (wb.defaultStyle) updateNai({ defaultStyle: wb.defaultStyle });
                            setStatus({ success: true, message: `已读取生图世界书，共 ${wb.entries?.length || 0} 条条目。` });
                        } catch (e) {
                            setStatus({ success: false, message: "读取失败：" + String(e) });
                        }
                    }}
                >
                    <BookOpen size={16} />
                    读取生图世界书
                </button>
            </div>

            {/* ════════════ NOVELAI 区域 ════════════ */}
            <div className="flex flex-col gap-3">
                <div className="flex items-center ml-2">
                    <p className="menu-desc font-semibold opacity-60">NOVELAI</p>
                    <button
                        type="button"
                        onClick={() => setOpenHelp(openHelp === "novelai" ? null : "novelai")}
                        className="ml-1 inline-flex items-center justify-center rounded-full"
                        style={{ width: 20, height: 20, border: "1px solid currentColor", opacity: 0.5 }}
                        aria-label="NovelAI 使用说明"
                        title="使用说明"
                    >
                        <HelpCircle size={13} />
                    </button>
                </div>
                {openHelp === "novelai" && <ProviderHelp which="novelai" />}

                {/* 启用 NovelAI 开关 */}
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="card-icon" style={naiIconStyle}>
                            <Sparkles size={22} strokeWidth={1.75} />
                        </span>
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">启用 NovelAI</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={isNai}
                                onChange={(checked) => updateSettings({ provider: checked ? "novelai" : "openai" })}
                                className="settings-toggle-control"
                            />
                        </span>
                    </div>
                </div>

                {/* NAI 基础配置 */}
                {(isNai || true) && (
                    <>
                        {/* API Key */}
                        <div className="menu-group">
                            <div className="menu-item">
                                <span className="card-icon" style={naiIconStyle}>
                                    <Upload size={22} strokeWidth={1.75} />
                                </span>
                                <span className="settings-tools-menu-copy flex-1 min-w-0">
                                    <span className="menu-label appearance-menu-item-label truncate">API Key</span>
                                    <span className="menu-desc settings-tools-menu-desc truncate">
                                        {settings.novelai.apiKey ? "••••••••••••••••" : "未填写"}
                                    </span>
                                </span>
                            </div>
                        </div>

                        {/* NOVELAI API URL */}
                        <div className="menu-group p-4 flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1 font-medium">NOVELAI API URL</label>
                                <Input
                                    type="text"
                                    value={settings.novelai.url}
                                    onChange={(e) => updateNai({ url: e.target.value })}
                                    placeholder="留空使用官方 NovelAI"
                                />
                                <p className="menu-desc ml-1 opacity-60 text-xs">
                                    可填写中转站/镜像站地址；配置是否可用请用下方测试出图验证。
                                </p>
                            </div>

                            {/* 出图接口 */}
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1 font-medium">出图接口</label>
                                <Select
                                    value={settings.novelai.endpointMode}
                                    onChange={(e) => updateNai({ endpointMode: e.target.value as "stream" | "normal" })}
                                >
                                    {NAI_ENDPOINT_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                                <p className="menu-desc ml-1 opacity-60 text-xs">
                                    自定义站不支持流式时，可以改成普通接口后用测试出图验证。
                                </p>
                            </div>

                            {/* API ACCESS TOKEN */}
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1 font-medium">API ACCESS TOKEN</label>
                                <Input
                                    type="password"
                                    value={settings.novelai.apiKey}
                                    onChange={(e) => updateNai({ apiKey: e.target.value })}
                                    placeholder="pst-... 或中转站 Key"
                                />
                                <p className="menu-desc ml-1 opacity-60 text-xs">密钥仅保存在本地存储中。</p>
                            </div>
                        </div>

                        {/* 模型选择 + 拉取模型 */}
                        <div className="menu-group">
                            <div className="menu-item">
                                <span className="card-icon" style={naiIconStyle}>
                                    <Sparkles size={22} strokeWidth={1.75} />
                                </span>
                                <span className="settings-tools-menu-copy flex-1 min-w-0">
                                    <span className="menu-label appearance-menu-item-label truncate">选择模型</span>
                                    <span className="menu-desc settings-tools-menu-desc">{settings.novelai.model}</span>
                                </span>
                                <button
                                    type="button"
                                    className="ui-link-btn shrink-0"
                                    onClick={() => setShowNaiModal(true)}
                                >
                                    <RefreshCw size={16} />
                                    拉取模型
                                </button>
                            </div>
                        </div>

                        {/* 生成设定（尺寸） */}
                        <div className="menu-group">
                            <div className="menu-item">
                                <span className="card-icon" style={naiIconStyle}>
                                    <Image size={22} strokeWidth={1.75} />
                                </span>
                                <span className="settings-tools-menu-copy flex-1 min-w-0">
                                    <span className="menu-label appearance-menu-item-label truncate">生成设定</span>
                                    <span className="menu-desc settings-tools-menu-desc">{settings.novelai.size}</span>
                                </span>
                                <ChevronDown size={18} className="shrink-0 opacity-40" />
                            </div>
                        </div>

                        {/* 打开 NAI 详细设置弹窗按钮 */}
                        <div className="flex justify-center pt-1 pb-2">
                            <button
                                type="button"
                                className="ui-btn ui-btn-soft-action"
                                onClick={() => setShowNaiModal(true)}
                            >
                                <Sparkles size={16} />
                                打开 NovelAI 详细设置
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* ════════════ POLLINATIONS 区域 ════════════ */}
            <div className="flex flex-col gap-3">
                <div className="flex items-center ml-2">
                    <p className="menu-desc font-semibold opacity-60">POLLINATIONS</p>
                    <button
                        type="button"
                        onClick={() => setOpenHelp(openHelp === "pollinations" ? null : "pollinations")}
                        className="ml-1 inline-flex items-center justify-center rounded-full"
                        style={{ width: 20, height: 20, border: "1px solid currentColor", opacity: 0.5 }}
                        aria-label="Pollinations 使用说明"
                        title="使用说明"
                    >
                        <HelpCircle size={13} />
                    </button>
                </div>
                {openHelp === "pollinations" && <ProviderHelp which="pollinations" />}
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="card-icon" style={pollinationsIconStyle}>
                            <Image size={22} strokeWidth={1.75} />
                        </span>
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">启用 Pollinations</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={isPollinations}
                                onChange={(checked) => updateSettings({ provider: checked ? "pollinations" : "openai" })}
                                className="settings-toggle-control"
                            />
                        </span>
                    </div>
                </div>

                {(isPollinations || true) && (
                    <div className="menu-group p-4 flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">模型</label>
                            <Select value={settings.pollinations.model} onChange={(e) => updatePollinations({ model: e.target.value })}>
                                {POLLINATIONS_MODEL_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </Select>
                            <p className="menu-desc ml-1 opacity-60 text-xs">flux 质量高；turbo 速度快。免 Key 即可生图。</p>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">尺寸（宽 × 高）</label>
                            <div className="flex items-center gap-2">
                                <Input
                                    type="number"
                                    value={String(settings.pollinations.width)}
                                    onChange={(e) => updatePollinations({ width: Math.max(64, Math.min(2048, parseInt(e.target.value, 10) || 1024)) })}
                                />
                                <span className="opacity-50">×</span>
                                <Input
                                    type="number"
                                    value={String(settings.pollinations.height)}
                                    onChange={(e) => updatePollinations({ height: Math.max(64, Math.min(2048, parseInt(e.target.value, 10) || 1024)) })}
                                />
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">随机种子（留空=每次随机）</label>
                            <Input
                                type="text"
                                value={settings.pollinations.seed}
                                onChange={(e) => updatePollinations({ seed: e.target.value })}
                                placeholder="留空=每次随机"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">API Token（可选）</label>
                            <Input
                                type="password"
                                value={settings.pollinations.apiKey}
                                onChange={(e) => updatePollinations({ apiKey: e.target.value })}
                                placeholder="留空=匿名免费额度"
                            />
                            <p className="menu-desc ml-1 opacity-60 text-xs">去 pollinations.ai 注册可获得更高额度、避免限流。</p>
                        </div>

                        <div className="flex items-center justify-between">
                            <span className="menu-desc ml-1">提示词增强 (enhance)</span>
                            <Toggle checked={settings.pollinations.enhance} onChange={(c) => updatePollinations({ enhance: c })} className="settings-toggle-control" />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="menu-desc ml-1">去除水印 (nologo)</span>
                            <Toggle checked={settings.pollinations.nologo} onChange={(c) => updatePollinations({ nologo: c })} className="settings-toggle-control" />
                        </div>
                    </div>
                )}
            </div>

            {/* ════════════ GOOGLE IMAGEN 区域 ════════════ */}
            <div className="flex flex-col gap-3">
                <div className="flex items-center ml-2">
                    <p className="menu-desc font-semibold opacity-60">GOOGLE IMAGEN</p>
                    <button
                        type="button"
                        onClick={() => setOpenHelp(openHelp === "google-imagen" ? null : "google-imagen")}
                        className="ml-1 inline-flex items-center justify-center rounded-full"
                        style={{ width: 20, height: 20, border: "1px solid currentColor", opacity: 0.5 }}
                        aria-label="Google Imagen 使用说明"
                        title="使用说明"
                    >
                        <HelpCircle size={13} />
                    </button>
                </div>
                {openHelp === "google-imagen" && <ProviderHelp which="google-imagen" />}
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="card-icon" style={googleImagenIconStyle}>
                            <Image size={22} strokeWidth={1.75} />
                        </span>
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">启用 Google Imagen</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={isGoogleImagen}
                                onChange={(checked) => updateSettings({ provider: checked ? "google-imagen" : "openai" })}
                                className="settings-toggle-control"
                            />
                        </span>
                    </div>
                </div>

                {(isGoogleImagen || true) && (
                    <div className="menu-group p-4 flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">API Key</label>
                            <Input
                                type="password"
                                value={settings.googleImagen.apiKey}
                                onChange={(e) => updateGoogleImagen({ apiKey: e.target.value })}
                                placeholder="AI Studio / GCP 的 key"
                            />
                            <p className="menu-desc ml-1 opacity-60 text-xs">密钥仅保存在本地存储中；Imagen 按张计费，请确保已绑定计费账号。</p>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">模型</label>
                            <Select value={settings.googleImagen.model} onChange={(e) => updateGoogleImagen({ model: e.target.value })}>
                                {GOOGLE_IMAGEN_MODEL_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">尺寸（宽 × 高）</label>
                            <div className="flex items-center gap-2">
                                <Input
                                    type="number"
                                    value={String(settings.googleImagen.width)}
                                    onChange={(e) => updateGoogleImagen({ width: Math.max(64, Math.min(2048, parseInt(e.target.value, 10) || 1024)) })}
                                />
                                <span className="opacity-50">×</span>
                                <Input
                                    type="number"
                                    value={String(settings.googleImagen.height)}
                                    onChange={(e) => updateGoogleImagen({ height: Math.max(64, Math.min(2048, parseInt(e.target.value, 10) || 1024)) })}
                                />
                            </div>
                            <p className="menu-desc ml-1 opacity-60 text-xs">实际比例会按下方「宽高比」参数由 Google 决定，这里仅作参考/提示。</p>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">宽高比 (aspect_ratio)</label>
                            <Select value={settings.googleImagen.aspectRatio} onChange={(e) => updateGoogleImagen({ aspectRatio: e.target.value })}>
                                {GOOGLE_ASPECT_RATIO_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">人物生成 (person_generation)</label>
                            <Select value={settings.googleImagen.personGeneration} onChange={(e) => updateGoogleImagen({ personGeneration: e.target.value })}>
                                {GOOGLE_PERSON_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1 font-medium">负面提示词 (negative_prompt)</label>
                            <Textarea
                                value={settings.googleImagen.negativePrompt}
                                onChange={(e) => updateGoogleImagen({ negativePrompt: e.target.value })}
                                placeholder="排除不想要的内容，可留空"
                                rows={2}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* ════════════ OpenAI 兼容区域（当不是 NAI/Pollinations/Imagen 时显示）═════════════ */}
            {!isNai && !isPollinations && !isGoogleImagen && (
                <div className="menu-group p-4 flex flex-col gap-4">
                    <p className="menu-desc ml-1 text-sky-700 font-semibold text-sm">OpenAI 兼容设置</p>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">请求方式</label>
                        <Select
                            value={settings.requestMode}
                            onChange={(event) => updateSettings({
                                requestMode: event.target.value as ImageGenerationSettingsType["requestMode"],
                            })}
                        >
                            <option value="server">服务端转发</option>
                            <option value="direct">浏览器直连</option>
                        </Select>
                        <span className="menu-desc ml-1">
                            浏览器直连会从当前设备直接请求生图 API，可绕开部署平台函数超时；需要接口允许跨域。
                        </span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">Base URL</label>
                        <Input
                            type="url"
                            value={settings.baseUrl}
                            onChange={(event) => updateSettings({ baseUrl: event.target.value })}
                            placeholder="https://api.openai.com/v1"
                        />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">API Key</label>
                        <Input
                            type="password"
                            value={settings.apiKey}
                            onChange={(event) => updateSettings({ apiKey: event.target.value })}
                            placeholder="sk-..."
                        />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">模型名</label>
                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <Input
                                    type="text"
                                    value={settings.model}
                                    onChange={(event) => updateSettings({ model: event.target.value })}
                                    placeholder="gpt-image-2 / image2 / chatgpt-image-latest"
                                    className={likelyModels.length > 0 ? "w-full pr-9" : "w-full"}
                                />
                                {likelyModels.length > 0 && (
                                    <>
                                        <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-60" />
                                        <select
                                            aria-label="选择拉取到的模型"
                                            value=""
                                            onChange={(event) => {
                                                if (event.target.value) updateSettings({ model: event.target.value });
                                            }}
                                            className="absolute inset-y-0 right-0 w-10 cursor-pointer opacity-0"
                                        >
                                            <option value="">选择拉取到的模型...</option>
                                            {likelyModels.map(model => <option key={model} value={model}>{model}</option>)}
                                        </select>
                                    </>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={fetchModels}
                                disabled={isFetchingModels}
                                className="ui-btn ui-btn-soft-action shrink-0"
                            >
                                <RefreshCw size={16} className={isFetchingModels ? "animate-spin" : ""} />
                                {isFetchingModels ? "拉取中" : "拉取模型"}
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">尺寸</label>
                            <Select value={settings.size} onChange={(event) => applySize(event.target.value)}>
                                {SIZE_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                            </Select>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">质量</label>
                            <Select value={settings.quality} onChange={(event) => updateSettings({ quality: event.target.value })}>
                                {QUALITY_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                            </Select>
                        </div>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">补充提示词</label>
                        <Textarea
                            value={settings.extraPrompt}
                            onChange={(event) => updateSettings({ extraPrompt: event.target.value })}
                            placeholder="会和角色输出的图片描述一起发送给生图模型。"
                            rows={4}
                        />
                        <p className="menu-desc ml-1 opacity-70">
                            选择尺寸后会自动在末尾追加一句「{RATIO_HINT_MARKER}…」构图提示。
                        </p>
                </div>
            </div>
            )}

            {/* ════════════ 测试生图（专门预览框，对所有 Provider 生效）═════════════ */}
            <div className="flex flex-col gap-3">
                <p className="settings-menu-section-title">测试生图</p>
                <TestGenCard
                    onTest={(p) => testGeneration(p)}
                    status={status}
                    testPreviewUrl={testPreviewUrl}
                    isTesting={isTesting}
                />
            </div>

            {/* ════════════ 图床设置（通用）═════════════ */}
            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Image Hosting</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="card-icon" style={imageGenerationIconStyle}>
                            <Upload size={22} strokeWidth={1.75} />
                        </span>
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">允许小卷上传图床</span>
                            <span className="menu-desc settings-tools-menu-desc">开启后，小卷的图像处理套件可以把本地素材上传到公开图床并拿 URL 写 CSS。</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.imageHosting.allowMascotUpload}
                                onChange={(allowMascotUpload) => updateImageHosting({ allowMascotUpload })}
                                className="settings-toggle-control"
                            />
                        </span>
                    </div>
                </div>

                <div className="menu-group p-4 flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">图床提供方</label>
                        <Select
                            value={settings.imageHosting.provider}
                            onChange={(event) => updateImageHosting({
                                provider: event.target.value as ImageGenerationSettingsType["imageHosting"]["provider"],
                            })}
                        >
                            {IMAGE_HOSTING_PROVIDER_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">ImgBB API Key</label>
                        <Input
                            type="password"
                            value={settings.imageHosting.imgbbApiKey}
                            onChange={(event) => updateImageHosting({ imgbbApiKey: event.target.value })}
                            placeholder="从 imgbb.com/api/1 获取"
                            disabled={settings.imageHosting.provider !== "imgbb"}
                        />
                        <span className="menu-desc ml-1">Key 只保存在当前项目设置里；小卷工具结果不会显示它。</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">默认过期秒数</label>
                            <Input
                                type="number"
                                min={0}
                                max={15552000}
                                value={settings.imageHosting.defaultExpirationSeconds}
                                onChange={(event) => updateImageHosting({
                                    defaultExpirationSeconds: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                                })}
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                            <span className="menu-desc ml-1">0 表示不过期。</span>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">上传上限 KB</label>
                            <Input
                                type="number"
                                min={64}
                                max={32768}
                                value={Math.round(settings.imageHosting.maxUploadBytes / 1024)}
                                onChange={(event) => updateImageHosting({
                                    maxUploadBytes: Math.max(64, Number.parseInt(event.target.value, 10) || 900) * 1024,
                                })}
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                            <span className="menu-desc ml-1">默认 900KB，适合 CSS 主题素材。</span>
                        </div>
                    </div>

                    <div className="menu-item !px-0 !py-0">
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">上传前自动转 WebP</span>
                            <span className="menu-desc settings-tools-menu-desc">减小 PNG/JPEG 体积；GIF 会保留原格式。</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.imageHosting.autoConvertToWebp}
                                onChange={(autoConvertToWebp) => updateImageHosting({ autoConvertToWebp })}
                                className="settings-toggle-control"
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                        </span>
                    </div>
                </div>
            </div>

            {/* ════════════ 角色参考图（通用）═════════════ */}
            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Character References</p>
                <div className="menu-group">
                    {characters.length === 0 ? (
                        <div className="ui-empty py-8">
                            <Camera size={22} />
                            <span className="menu-desc">暂无角色。</span>
                        </div>
                    ) : characters.map(character => {
                        const preview = referencePreviews[character.id];
                        return (
                            <div key={character.id} className="menu-item">
                                <span className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-[var(--c-input)]">
                                    {preview ? (
                                        <img src={preview} alt="" className="h-full w-full object-cover" />
                                    ) : character.avatar ? (
                                        <img src={character.avatar} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                        <span className="flex h-full w-full items-center justify-center ts-13 font-semibold text-[var(--c-icon)]">
                                            {character.name.slice(0, 1)}
                                        </span>
                                    )}
                                </span>
                                <span className="min-w-0 flex flex-1 flex-col">
                                    <span className="menu-label truncate">{character.name}</span>
                                    <span className="menu-desc truncate">{preview ? "已上传参考图" : "未上传参考图"}</span>
                                </span>
                                <span className="menu-right flex gap-2">
                                    <button
                                        type="button"
                                        className="ui-link-btn"
                                        aria-label={`上传 ${character.name} 的参考图`}
                                        onClick={() => {
                                            const input = document.createElement("input");
                                            input.type = "file";
                                            input.accept = "image/*";
                                            input.onchange = async () => {
                                                const file = input.files?.[0];
                                                if (file) await uploadReference(character.id, file);
                                            };
                                            input.click();
                                        }}
                                    >
                                        <Upload size={18} />
                                    </button>
                                    {preview && (
                                        <button
                                            type="button"
                                            className="ui-link-btn"
                                            data-variant="danger"
                                            aria-label={`删除 ${character.name} 的参考图`}
                                            onClick={() => removeReference(character.id)}
                                        >
                                            <Trash2 size={18} />
                                        </button>
                                    )}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ════════════ NAI 详细设置弹窗 ════════════ */}
            {showNaiModal && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
                    onClick={(e) => { if (e.target === e.currentTarget) setShowNaiModal(false); }}
                >
                    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[92vw] max-w-lg max-h-[90vh] overflow-y-auto flex flex-col m-4">
                        {/* 弹窗标题栏 */}
                        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-800 rounded-t-2xl z-10">
                            <h3 className="m-0 ts-20 font-bold text-black dark:text-white">NovelAI 生成设置</h3>
                            <button
                                type="button"
                                className="ui-icon-btn"
                                onClick={() => setShowNaiModal(false)}
                            >
                                <X size={20} />
                            </button>
                        </div>

                        {/* 弹窗内容 */}
                        <div className="flex flex-col gap-5 p-5">

                            {/* 参考图区域 */}
                            <div className="flex flex-col gap-2">
                                <label className="ts-14 font-medium text-black dark:text-white">参考图（风格迁移）</label>
                                <div className="flex gap-3 items-start">
                                    {/* 参考图预览 */}
                                    <div className="w-20 h-20 rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-700 shrink-0 flex items-center justify-center border border-gray-200 dark:border-gray-600">
                                        {naiRefPreview ? (
                                            <img src={naiRefPreview} alt="参考图" className="w-full h-full object-cover" />
                                        ) : (
                                            <Image size={24} className="opacity-30" />
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2 flex-1">
                                        <button
                                            type="button"
                                            className="ui-btn ui-btn-soft-action w-full text-left justify-center"
                                            onClick={() => {
                                                const input = document.createElement("input");
                                                input.type = "file";
                                                input.accept = "image/*,.naiv4vibe";
                                                input.onchange = async () => {
                                                    const file = input.files?.[0];
                                                    if (file) await uploadNaiReference(file);
                                                };
                                                input.click();
                                            }}
                                        >
                                            更换
                                        </button>
                                        <button
                                            type="button"
                                            className="ui-btn ui-btn-soft-action w-full text-left justify-center"
                                            onClick={() => {
                                                const input = document.createElement("input");
                                                input.type = "file";
                                                input.accept = ".naiv4vibe";
                                                input.onchange = async () => {
                                                    const file = input.files?.[0];
                                                    if (file) await uploadNaiReference(file);
                                                };
                                                input.click();
                                            }}
                                        >
                                            导入 .naiv4vibe 文件
                                        </button>
                                        {naiRefPreview && (
                                            <button
                                                type="button"
                                                className="ui-btn w-full text-left justify-center"
                                                style={{ color: "#EF4444", borderColor: "#FECACA" }}
                                                onClick={removeNaiReference}
                                            >
                                                移除
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* 画风强度 */}
                            <div className="flex flex-col gap-1">
                                <div className="flex justify-between items-center">
                                    <label className="ts-14 font-medium text-black dark:text-white">画风强度</label>
                                    <span className="ts-13 text-purple-600 font-mono">{settings.novelai.styleStrength.toFixed(1)}</span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    value={settings.novelai.styleStrength}
                                    onChange={(e) => updateNai({ styleStrength: parseFloat(e.target.value) })}
                                    className="w-full h-2 rounded-full appearance-none bg-gray-200 accent-purple-500"
                                />
                                <p className="ts-12 opacity-50">0~1，越高越贴近参考画风（建议 0.5~0.7）</p>
                            </div>

                            {/* 预设组管理 */}
                            <div className="flex flex-col gap-2">
                                <label className="ts-14 font-medium text-black dark:text-white">预设组</label>
                                <div className="flex gap-2">
                                    <select
                                        value={activeGroupId}
                                        onChange={(e) => setActiveGroupId(e.target.value)}
                                        className="flex-1 ui-select"
                                    >
                                        <option value="">新建预设组...</option>
                                        {settings.novelai.presetGroups.map(g => (
                                            <option key={g.id} value={g.id}>{g.name} ({g.presets.length})</option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        className="ui-btn ui-btn-soft-action shrink-0"
                                        onClick={() => {
                                            const name = prompt("输入新预设组名称：");
                                            if (name?.trim()) createPresetGroup(name.trim());
                                        }}
                                    >
                                        <Plus size={16} />
                                        新增
                                    </button>
                                </div>
                                {activeGroup && (
                                    <div className="flex gap-2 items-center">
                                        <select
                                            value={activeGroup.activePresetId || ""}
                                            onChange={(e) => {
                                                const g = settings.novelai.presetGroups.find(x => x.id === activeGroupId);
                                                if (!g) return;
                                                const pid = e.target.value || null;
                                                const groups = settings.novelai.presetGroups.map(x =>
                                                    x.id === activeGroupId ? { ...x, activePresetId: pid } : x
                                                );
                                                updateNai({ presetGroups: groups });
                                                if (pid) {
                                                    const preset = g.presets.find(p => p.id === pid);
                                                    if (preset) applyPreset(preset);
                                                }
                                            }}
                                            className="flex-1 ui-select"
                                        >
                                            <option value="">-- 选择预设 --</option>
                                            {activeGroup.presets.map(p => (
                                                <option key={p.id} value={p.id}>{p.name}</option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            className="ui-btn ui-btn-soft-action shrink-0"
                                            onClick={() => {
                                                const name = prompt("保存当前设置为预设名称：");
                                                if (name?.trim()) saveCurrentAsPreset(name.trim());
                                            }}
                                        >
                                            <Save size={16} />
                                            保存
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* 正向预设词 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">正面预设词</label>
                                <Textarea
                                    value={settings.novelai.positivePrefix}
                                    onChange={(e) => updateNai({ positivePrefix: e.target.value })}
                                    placeholder="illumination, exquisite style, exquisite thick painting,-4::artist collaboration::..."
                                    rows={3}
                                />
                            </div>

                            {/* 负面预设词 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">负面预设词</label>
                                <Textarea
                                    value={settings.novelai.negativePrompt}
                                    onChange={(e) => updateNai({ negativePrompt: e.target.value })}
                                    placeholder="lowres, bad anatomy, worst quality..."
                                    rows={3}
                                />
                            </div>

                            {/* 分割线 */}
                            <hr className="border-gray-200 dark:border-gray-700" />

                            {/* 图像尺寸 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">图像尺寸（oplus可无限出小图）</label>
                                <Select
                                    value={settings.novelai.size}
                                    onChange={(e) => updateNai({ size: e.target.value })}
                                >
                                    {NAI_SIZE_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                                <p className="ts-12 opacity-50">建议使用官方支持的标准尺寸以获得最佳效果</p>
                            </div>

                            {/* 采样步数 — slider 1~50 */}
                            <div className="flex flex-col gap-1">
                                <div className="flex justify-between items-center">
                                    <label className="ts-14 font-medium text-black dark:text-white">采样步数 (Steps) : {settings.novelai.steps}</label>
                                </div>
                                <input
                                    type="range"
                                    min={1}
                                    max={50}
                                    value={settings.novelai.steps}
                                    onChange={(e) => updateNai({ steps: parseInt(e.target.value, 10) || 28 })}
                                    className="w-full h-2 rounded-full appearance-none bg-gray-200 accent-purple-500"
                                />
                                <p className="ts-12 opacity-50">推荐值: 28（值越高质量越好但耗时越长）</p>
                            </div>

                            {/* CFG Scale — slider */}
                            <div className="flex flex-col gap-1">
                                <div className="flex justify-between items-center">
                                    <label className="ts-14 font-medium text-black dark:text-white">提示词相关性 (CFG Scale) : {settings.novelai.cfgScale}</label>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={20}
                                    step={0.5}
                                    value={settings.novelai.cfgScale}
                                    onChange={(e) => updateNai({ cfgScale: parseFloat(e.target.value) || 5 })}
                                    className="w-full h-2 rounded-full appearance-none bg-gray-200 accent-purple-500"
                                />
                                <p className="ts-12 opacity-50">推荐值: 5（控制图像与提示词的相关程度）</p>
                            </div>

                            {/* 采样器 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">采样器 (Sampler)</label>
                                <Select
                                    value={settings.novelai.sampler}
                                    onChange={(e) => updateNai({ sampler: e.target.value })}
                                >
                                    {NAI_SAMPLER_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>

                            {/* 噪声调度 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">噪声调度 (Noise Schedule)</label>
                                <Select
                                    value={settings.novelai.noiseSchedule}
                                    onChange={(e) => updateNai({ noiseSchedule: e.target.value })}
                                >
                                    {NAI_NOISE_SCHEDULE_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>

                            {/* 负面预设 (UC PRESET) */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">负面预设 (UC PRESET)</label>
                                <Select
                                    value={String(settings.novelai.ucPreset)}
                                    onChange={(e) => updateNai({ ucPreset: parseInt(e.target.value, 10) || 0 })}
                                >
                                    {NAI_UC_PRESET_OPTIONS.map(opt => (
                                        <option key={opt.value} value={String(opt.value)}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>

                            {/* 随机种子 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">随机种子 (Seed)</label>
                                <Input
                                    type="text"
                                    value={settings.novelai.seed ?? ""}
                                    onChange={(e) => updateNai({ seed: e.target.value || null })}
                                    placeholder="-1 = 随机"
                                />
                                <p className="ts-12 opacity-50">'-1' 表示每次随机生成，固定数字可复现结果。</p>
                            </div>

                            {/* 自动添加质量标签 */}
                            <div className="flex items-center justify-between py-2">
                                <label className="ts-14 font-medium text-black dark:text-white">自动添加质量标签 (Quality Tags)</label>
                                <Toggle
                                    checked={settings.novelai.qualityTags}
                                    onChange={(checked) => updateNai({ qualityTags: checked })}
                                />
                            </div>

                            {/* SMEA */}
                            <div className="flex items-center justify-between py-2">
                                <label className="ts-14 font-medium text-black dark:text-white">SMEA (提升细节)</label>
                                <Toggle
                                    checked={settings.novelai.smea}
                                    onChange={(checked) => updateNai({ smea: checked })}
                                />
                            </div>

                            {/* SMEA DYN */}
                            <div className="flex items-center justify-between py-2">
                                <label className="ts-14 font-medium text-black dark:text-white">SMEA DYN (动态优化)</label>
                                <Toggle
                                    checked={settings.novelai.smeaDyn}
                                    onChange={(checked) => updateNai({ smeaDyn: checked })}
                                />
                            </div>

                            {/* 正向质量词后缀 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">正向质量词（后缀）</label>
                                <Input
                                    value={settings.novelai.qualitySuffix}
                                    onChange={(e) => updateNai({ qualitySuffix: e.target.value })}
                                    placeholder="best quality, very aesthetic, masterpiece"
                                />
                            </div>

                            {/* 提示词模板 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">提示词模板（高级）</label>
                                <Textarea
                                    value={settings.novelai.promptTemplate}
                                    onChange={(e) => updateNai({ promptTemplate: e.target.value })}
                                    placeholder='{{positive_prefix}}, {{prompt}}, {{quality_suffix}}'
                                    rows={2}
                                />
                            </div>

                            {/* 默认画风 */}
                            <div className="flex flex-col gap-1">
                                <label className="ts-14 font-medium text-black dark:text-white">默认画风</label>
                                <Input
                                    value={settings.novelai.defaultStyle}
                                    onChange={(e) => updateNai({ defaultStyle: e.target.value })}
                                    placeholder="不套用（用上方前缀/模板）"
                                />
                            </div>

                        </div>

                        {/* 弹窗底部按钮 */}
                        <div className="flex gap-3 px-5 py-4 border-t border-gray-200 dark:border-gray-700 sticky bottom-0 bg-white dark:bg-gray-800 rounded-b-2xl">
                            <button
                                type="button"
                                className="ui-btn ui-btn-soft-action flex-1"
                                onClick={resetNaiDefaults}
                            >
                                恢复默认
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-primary flex-1"
                                onClick={() => {
                                    setShowNaiModal(false);
                                    setStatus({ success: true, message: "NovelAI 设置已保存。" });
                                }}
                            >
                                保存设置
                            </button>
                        </div>

                        {/* 弹窗内专用测试生图框：不关闭弹窗即可直接预览结果 */}
                        <div className="px-5 pb-5">
                            <TestGenCard
                                onTest={(p) => testGeneration(p)}
                                status={status}
                                testPreviewUrl={testPreviewUrl}
                                isTesting={isTesting}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* ════════════ CORS 跨域代理 ════════════ */}
            <div className="flex flex-col gap-3">
                <p className="menu-desc ml-2 font-semibold opacity-60">网络设置</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="card-icon" style={imageGenerationIconStyle}>
                            <Image size={22} strokeWidth={1.75} />
                        </span>
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">CORS 跨域代理</span>
                            <span className="menu-desc settings-tools-menu-desc">本地运行通常建议开启。</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.novelai.corsProxy}
                                onChange={(checked) => updateNai({ corsProxy: checked })}
                                className="settings-toggle-control"
                            />
                        </span>
                    </div>
                </div>
            </div>

            {/* 隐藏的文件输入 */}
            <input
                ref={naiFileInputRef}
                type="file"
                accept="image/*,.naiv4vibe"
                className="hidden"
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadNaiReference(file);
                }}
            />

        </div>
    );
}
