"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { AlertCircle, Camera, ChevronDown, Image, Info, Plus, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import type { ImageGenerationSettings as ImageGenerationSettingsType, NovelAiPreset } from "@/lib/settings-types";
import {
    DEFAULT_IMAGE_GENERATION_SETTINGS,
    DEFAULT_NOVELAI_PRESET,
    loadImageGenerationSettings,
    saveImageGenerationSettings,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import {
    fetchImageGenerationModels,
    fetchNovelAiModels,
    filterLikelyImageModels,
    generateImageFromConfiguredApi,
} from "@/lib/image-generation-service";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/modal";
import {
    NOVELAI_COMMON_MODELS,
    NOVELAI_NOISE_SCHEDULE_OPTIONS,
    NOVELAI_RESOLUTION_OPTIONS,
    NOVELAI_SAMPLER_OPTIONS,
} from "@/lib/novelai-image-config";

const SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024"];
const QUALITY_OPTIONS = ["auto", "low", "medium", "high"];

// Some relay APIs (e.g. dzzi 的 gpt-image-2) ignore the `size` param and pick
// their own aspect ratio. As a fallback we append a natural-language ratio hint
// to the prompt, which these models DO respect. The marker lets us replace the
// previously-appended hint instead of stacking them when the size changes.
const RATIO_HINT_MARKER = "【画面比例】";
const SIZE_RATIO_HINTS: Record<string, string> = {
    "1024x1024": "正方形 1:1 构图，square 1:1 composition",
    "1024x1536": "竖向 2:3 构图，vertical portrait composition",
    "1536x1024": "横向 3:2 构图，horizontal landscape composition",
};

// Remove any auto-appended ratio hint line(s), preserving the user's own text.
function stripRatioHint(text: string): string {
    return text.replace(new RegExp(`\\s*${RATIO_HINT_MARKER}[^\\n]*`, "g"), "").replace(/\s+$/, "");
}

// Return the prompt with the ratio hint for `size` appended (replacing any
// previous hint). `auto` strips the hint entirely.
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

type Status = { success: boolean; message: string };

export function ImageGenerationSettings() {
    const [settings, setSettings] = useState<ImageGenerationSettingsType>(DEFAULT_IMAGE_GENERATION_SETTINGS);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [referencePreviews, setReferencePreviews] = useState<Record<string, string>>({});
    const [models, setModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [naiModels, setNaiModels] = useState<string[]>(NOVELAI_COMMON_MODELS);
    const [isFetchingNaiModels, setIsFetchingNaiModels] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [naiTokenStatus, setNaiTokenStatus] = useState<Status | null>(null);
    const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);
    const [pendingDeletePresetId, setPendingDeletePresetId] = useState<string | null>(null);

    useEffect(() => {
        // Sync the ratio hint to the saved size on load, so the hint is present
        // by default (not only after the user manually switches the size).
        const loaded = loadImageGenerationSettings();
        const syncedExtra = withRatioHint(loaded.extraPrompt, loaded.size);
        if (syncedExtra !== loaded.extraPrompt) {
            const next = { ...loaded, extraPrompt: syncedExtra };
            saveImageGenerationSettings(next);
            setSettings(next);
        } else {
            setSettings(loaded);
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
        return () => { cancelled = true; };
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

    // NovelAI 预设管理与状态
    const naiSettings = useMemo(() => {
        const nai = settings.novelai;
        const presets = nai?.presets && nai.presets.length > 0 ? nai.presets : [DEFAULT_NOVELAI_PRESET];
        const activePreset = presets.find(p => p.id === nai?.activePresetId) || presets[0];
        return {
            apiKey: nai?.apiKey || "",
            activePresetId: activePreset.id,
            presets,
            activePreset,
        };
    }, [settings.novelai]);

    const updateNovelAi = useCallback((patch: Partial<import("@/lib/settings-types").NovelAiSettings>) => {
        persist({
            ...settings,
            novelai: {
                apiKey: naiSettings.apiKey,
                activePresetId: naiSettings.activePresetId,
                presets: naiSettings.presets,
                ...patch,
            },
        });
    }, [naiSettings, persist, settings]);

    const updateActivePreset = useCallback((patch: Partial<NovelAiPreset>) => {
        const nextPresets = naiSettings.presets.map(p => {
            if (p.id === naiSettings.activePresetId) {
                return { ...p, ...patch };
            }
            return p;
        });
        updateNovelAi({ presets: nextPresets });
    }, [naiSettings, updateNovelAi]);

    const addPreset = useCallback(() => {
        const newId = `preset_nai_${Date.now()}`;
        const newPreset: NovelAiPreset = {
            ...naiSettings.activePreset,
            id: newId,
            name: `${naiSettings.activePreset.name} (副本)`,
        };
        updateNovelAi({
            presets: [...naiSettings.presets, newPreset],
            activePresetId: newId,
        });
    }, [naiSettings, updateNovelAi]);

    const deletePreset = useCallback((presetId: string) => {
        if (naiSettings.presets.length <= 1) return;
        const deletedIndex = naiSettings.presets.findIndex(p => p.id === presetId);
        if (deletedIndex < 0) return;
        const nextPresets = naiSettings.presets.filter(p => p.id !== presetId);
        const nextActivePreset = nextPresets[Math.min(deletedIndex, nextPresets.length - 1)];
        updateNovelAi({
            presets: nextPresets,
            activePresetId: nextActivePreset.id,
        });
    }, [naiSettings, updateNovelAi]);

    // Changing the size also refreshes the auto-appended ratio hint in the
    // 补充提示词 box (replacing any previous hint), so models that ignore the
    // `size` param still produce the requested orientation.
    const applySize = useCallback((size: string) => {
        persist({ ...settings, size, extraPrompt: withRatioHint(settings.extraPrompt, size) });
    }, [persist, settings]);

    const updateImageHosting = useCallback((patch: Partial<ImageGenerationSettingsType["imageHosting"]>) => {
        persist({
            ...settings,
            imageHosting: {
                ...settings.imageHosting,
                ...patch,
            },
        });
    }, [persist, settings]);

    const likelyModels = useMemo(() => filterLikelyImageModels(models), [models]);

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

    const fetchNaiModels = async () => {
        setNaiTokenStatus(null);
        if (!naiSettings.apiKey.trim()) {
            setNaiTokenStatus({ success: false, message: "请先填写 NovelAI API Token。" });
            return;
        }
        setIsFetchingNaiModels(true);
        try {
            const fetched = await fetchNovelAiModels(naiSettings.apiKey);
            setNaiModels(fetched);
            setNaiTokenStatus({
                success: true,
                message: `NovelAI Token 有效，已加载 ${fetched.length} 个常用模型。`,
            });
        } catch (err) {
            setNaiTokenStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingNaiModels(false);
        }
    };

    const testGeneration = async () => {
        setStatus(null);
        setIsTesting(true);
        try {
            const result = await generateImageFromConfiguredApi({
                description: settings.provider === "novelai"
                    ? "1girl, solo, upper body, white coffee cup on the wooden table, soft window light"
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

    return (
        <div className="flex flex-col gap-6 pb-8">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Image Generation</h2>
            </div>

            <div className="menu-group">
                <div className="menu-item">
                    <span className="card-icon" style={imageGenerationIconStyle}>
                        <Sparkles size={22} strokeWidth={1.75} />
                    </span>
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">启用自动生图</span>
                        <span className="menu-desc settings-tools-menu-desc">角色输出照片标签时自动调用图像生成 API。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={settings.enabled} onChange={(enabled) => updateSettings({ enabled })} className="settings-toggle-control" />
                    </span>
                </div>
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">生图提供方 / 引擎</label>
                    <Select
                        value={settings.provider || "openai"}
                        onChange={(event) => updateSettings({
                            provider: event.target.value as "openai" | "novelai",
                        })}
                    >
                        <option value="openai">OpenAI 兼容 (通用模型 / DALL-E / Flux / SD 中转等)</option>
                        <option value="novelai">NovelAI 原生接口 (官方 API)</option>
                    </Select>
                </div>

                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">请求方式</label>
                    <Select
                        value={settings.requestMode}
                        onChange={(event) => updateSettings({
                            requestMode: event.target.value as ImageGenerationSettingsType["requestMode"],
                        })}
                    >
                        <option value="server">服务端转发（推荐，可避免跨域报错）</option>
                        <option value="direct">浏览器直连（需接口允许 CORS 跨域）</option>
                    </Select>
                </div>

                {settings.provider === "novelai" ? (
                    /* --- NovelAI 配置面板 --- */
                    <>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">NovelAI API Token</label>
                            <Input
                                type="password"
                                value={naiSettings.apiKey}
                                onChange={(event) => {
                                    updateNovelAi({ apiKey: event.target.value });
                                    setNaiTokenStatus(null);
                                }}
                                placeholder="pst-..."
                            />
                            <span className="menu-desc ml-1">可在 NovelAI 官网 Account 页面获取 Persistent API Token。</span>
                            {naiTokenStatus && (
                                <div role={naiTokenStatus.success ? "status" : "alert"} className="mt-2">
                                    <Alert variant={naiTokenStatus.success ? "success" : "danger"}>
                                        <AlertCircle size={16} className="mt-[2px] shrink-0" />
                                        <span className="break-all leading-[1.5]">{naiTokenStatus.message}</span>
                                    </Alert>
                                </div>
                            )}
                        </div>

                        {/* 预设管理栏 */}
                        <div className="flex flex-col gap-2 rounded-xl bg-[var(--c-input)]/40 p-3 border border-[var(--c-card-border)]">
                            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <label className="menu-label text-sm font-semibold">NovelAI 参数预设</label>
                                <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                                    <button
                                        type="button"
                                        onClick={addPreset}
                                        className="ui-btn ui-btn-soft-action min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"
                                        title="复制当前为新预设"
                                    >
                                        <Plus size={14} />
                                        新建预设
                                    </button>
                                    {naiSettings.presets.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => setPendingDeletePresetId(naiSettings.activePresetId)}
                                            className="ui-btn ui-btn-danger min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"
                                            title="删除当前选中的预设"
                                        >
                                            <Trash2 size={14} />
                                            删除预设
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">切换当前预设</span>
                                    <Select
                                        value={naiSettings.activePresetId}
                                        onChange={(event) => updateNovelAi({ activePresetId: event.target.value })}
                                    >
                                        {naiSettings.presets.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">预设名称</span>
                                    <Input
                                        type="text"
                                        value={naiSettings.activePreset.name}
                                        onChange={(event) => updateActivePreset({ name: event.target.value })}
                                        placeholder="预设名称"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* 预设详细参数 */}
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">模型 (Model)</label>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Input
                                        type="text"
                                        value={naiSettings.activePreset.model}
                                        onChange={(event) => updateActivePreset({ model: event.target.value })}
                                        placeholder="nai-diffusion-4-curated-preview"
                                        className={naiModels.length > 0 ? "w-full pr-9" : "w-full"}
                                    />
                                    {naiModels.length > 0 && (
                                        <>
                                            <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-60" />
                                            <select
                                                aria-label="选择常见 NAI 模型"
                                                value=""
                                                onChange={(event) => {
                                                    if (event.target.value) updateActivePreset({ model: event.target.value });
                                                }}
                                                className="absolute inset-y-0 right-0 w-10 cursor-pointer opacity-0"
                                            >
                                                <option value="">快速选择模型...</option>
                                                {naiModels.map(m => (
                                                    <option key={m} value={m}>{m}</option>
                                                ))}
                                            </select>
                                        </>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={fetchNaiModels}
                                    disabled={isFetchingNaiModels}
                                    className="ui-btn ui-btn-soft-action min-h-11 shrink-0"
                                >
                                    <RefreshCw size={16} className={isFetchingNaiModels ? "animate-spin" : ""} />
                                    {isFetchingNaiModels ? "验证中" : "验证 Token"}
                                </button>
                            </div>
                            <span className="menu-desc ml-1 opacity-70">模型下拉列表内置于应用；“验证 Token”只检查凭证，不会发起生图。</span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">分辨率 (Resolution)</label>
                            <Select
                                value={naiSettings.activePreset.resolution}
                                onChange={(event) => updateActivePreset({ resolution: event.target.value })}
                            >
                                {NOVELAI_RESOLUTION_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">采样器 (Sampler)</label>
                                <Select
                                    value={naiSettings.activePreset.sampler}
                                    onChange={(event) => updateActivePreset({ sampler: event.target.value })}
                                >
                                    {NOVELAI_SAMPLER_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">调度器 (Schedule)</label>
                                <Select
                                    value={naiSettings.activePreset.noiseSchedule || "karras"}
                                    onChange={(event) => updateActivePreset({ noiseSchedule: event.target.value })}
                                >
                                    {NOVELAI_NOISE_SCHEDULE_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">步数 (Steps: {naiSettings.activePreset.steps})</label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={50}
                                    value={naiSettings.activePreset.steps}
                                    onChange={(event) => updateActivePreset({
                                        steps: Math.max(1, Math.min(50, parseInt(event.target.value, 10) || 28)),
                                    })}
                                />
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">提示词相关度 (CFG Scale: {naiSettings.activePreset.scale})</label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={30}
                                    step={0.1}
                                    value={naiSettings.activePreset.scale}
                                    onChange={(event) => updateActivePreset({
                                        scale: Math.max(1, Math.min(30, parseFloat(event.target.value) || 6.0)),
                                    })}
                                />
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">画师串 / 正面质量提示词 (Positive / Quality)</label>
                            <Textarea
                                value={naiSettings.activePreset.positivePrompt}
                                onChange={(event) => updateActivePreset({ positivePrompt: event.target.value })}
                                placeholder="masterpiece, best quality, very aesthetic, artist:..."
                                rows={3}
                            />
                            <span className="menu-desc ml-1 opacity-70">
                                会作为基础风格与角色聊天的画面描述组合发送。
                            </span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">负面提示词 (Undesired Content / Negative)</label>
                            <Textarea
                                value={naiSettings.activePreset.negativePrompt}
                                onChange={(event) => updateActivePreset({ negativePrompt: event.target.value })}
                                placeholder="lowres, bad anatomy, bad hands, blurry..."
                                rows={3}
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-2 pt-1">
                            <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={naiSettings.activePreset.qualityToggle !== false}
                                    onChange={(e) => updateActivePreset({ qualityToggle: e.target.checked })}
                                    className="rounded border-[var(--c-card-border)]"
                                />
                                <span className="text-xs font-medium">启用质量词 (Quality+)</span>
                            </label>
                            <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={naiSettings.activePreset.smea === true}
                                    onChange={(e) => updateActivePreset({ smea: e.target.checked })}
                                    className="rounded border-[var(--c-card-border)]"
                                />
                                <span className="text-xs font-medium">启用 SMEA</span>
                            </label>
                        </div>
                    </>
                ) : (
                    /* --- OpenAI 模式配置面板 --- */
                    <>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Base URL</label>
                            <Input
                                type="url"
                                value={settings.baseUrl}
                                onChange={(event) => updateSettings({ baseUrl: event.target.value })}
                                placeholder="https://api.example.com/v1"
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
                                选择尺寸后会自动在末尾追加一句「{RATIO_HINT_MARKER}…」构图提示，用于纠正部分不认 size 参数的接口（如 gpt-image-2）。可手动修改或删除。
                            </p>
                        </div>
                    </>
                )}

                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={testGeneration}
                        disabled={isTesting}
                        className="ui-btn ui-btn-success flex-1"
                    >
                        <Image size={16} />
                        {isTesting ? "测试中..." : "测试生图"}
                    </button>
                </div>

                {status && (
                    <div role={status.success ? "status" : "alert"}>
                        <Alert variant={status.success ? "success" : "danger"}>
                            <AlertCircle size={16} className="mt-[2px] shrink-0" />
                            <span className="break-all leading-[1.5]">{status.message}</span>
                        </Alert>
                    </div>
                )}
                {testPreviewUrl && (
                    <img
                        src={testPreviewUrl}
                        alt="测试生图结果"
                        className="max-h-[220px] max-w-full self-start rounded-xl border border-[var(--c-card-border)] object-contain"
                    />
                )}
            </div>

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

            {settings.provider === "novelai" ? (
                <div className="flex flex-col gap-2">
                    <p className="settings-menu-section-title">Character References</p>
                    <Alert variant="info">
                        <Info size={16} className="mt-[2px] shrink-0" />
                        <span className="leading-[1.5]">NovelAI 当前仅使用文字提示词生成图片，不会读取角色参考图。已有参考图会保留，切回 OpenAI 兼容引擎后仍可继续使用。</span>
                    </Alert>
                </div>
            ) : (
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
            )}

            {pendingDeletePresetId && (
                <ConfirmDialog
                    title="确认删除预设？"
                    message={`预设“${naiSettings.presets.find(p => p.id === pendingDeletePresetId)?.name || "未命名预设"}”删除后无法恢复。`}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        deletePreset(pendingDeletePresetId);
                        setPendingDeletePresetId(null);
                    }}
                    onCancel={() => setPendingDeletePresetId(null)}
                />
            )}

        </div>
    );
}
