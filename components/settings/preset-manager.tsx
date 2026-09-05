"use client";

import { useState, useEffect, useRef, useContext, useCallback, useMemo } from "react";
import { Plus, Upload, Download, Trash2, RotateCcw, ChevronLeft, ChevronDown, GripVertical, MessageSquare, AlertCircle, Maximize2, Copy, Replace, CheckSquare, Check, Filter, MoreHorizontal } from "lucide-react";
import {
    loadPresets,
    savePresets,
    createPreset,
    parsePresetFromJson,
    resetBuiltinPreset,
    UNSUPPORTED_IMPORT_FORMAT,
} from "@/lib/settings-storage";
import type { GenerationParameterKey, PresetConfig, Prompt, PromptOrderEntry } from "@/lib/settings-types";
import {
    GENERATION_PARAMETER_KEYS,
    resolveEnabledGenerationParameters,
} from "@/lib/generation-parameters";
import {
    areTagsEqual,
    CONTENT_SCOPE_TAG_GROUPS,
    getPromptTags as getScopedPromptTags,
    getTagsLabel,
    resolveContentTagLabel,
    type TagGroupProfile,
} from "@/lib/content-tag-utils";
import { buildCustomAppTagGroups, findTagGroupForTags, flattenTagGroups } from "@/lib/custom-app-tag-profiles";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps } from "@/lib/custom-app-storage";
import type { InstalledCustomApp } from "@/lib/custom-app-types";
import { SettingsContext } from "../phone-settings-app";
import { BottomSheet, ConfirmDialog, TextExpandModal } from "@/components/ui/modal";
import { SwipeActionRow, useSwipeActions } from "@/components/ui/swipe-actions";
import { notifyMascotPageContext } from "@/lib/mascot-events";
import { useTouchSort } from "@/lib/use-touch-sort";

// ── Tag helpers for backward compat (tags[] > featureTag + followUpOnly) ──
function getPromptTags(p: Prompt): string[] {
    return getScopedPromptTags(p);
}

/** 条目是否命中选中的 App 大类集合（多选；空集合视为未筛选，全部命中）。 */
function matchesSelectedAppTags(p: Prompt, tags: Set<string>): boolean {
    if (!tags || tags.size === 0) return true;
    const pt = getPromptTags(p);
    if (tags.has("__universal__") && pt.length === 0) return true;
    for (const t of tags) {
        if (t === "__universal__") continue;
        if (pt.includes(t)) return true;
    }
    return false;
}

function getPromptTagGroup(p: Prompt, tagGroups = CONTENT_SCOPE_TAG_GROUPS) {
    const tags = getPromptTags(p);
    return findTagGroupForTags(tagGroups, tags) ?? tagGroups[0];
}

function getPromptTagMinor(p: Prompt, group = getPromptTagGroup(p)) {
    const tags = getPromptTags(p);
    return group.minors.find(minor => areTagsEqual(minor.tags, tags)) ?? group.minors[0];
}

function getPromptTagsLabel(p: Prompt, tagProfiles = flattenTagGroups(CONTENT_SCOPE_TAG_GROUPS)): string {
    return getTagsLabel(getPromptTags(p), tagProfiles);
}

function getPromptTagsInlineLabel(p: Prompt): string {
    const tags = getPromptTags(p);
    return tags.length > 0 ? tags.map(resolveContentTagLabel).join(" · ") : "通用";
}

function setPromptTags(tags: string[]): Partial<Prompt> {
    return {
        tags: tags.length > 0 ? tags : undefined,
        featureTag: undefined,
        followUpOnly: undefined,
    };
}

// ── Marker 名称自动识别（手动编辑与桌宠填表共用） ──
// marker 条目靠 identifier 注入内容，条目名称命中下表时自动补齐 identifier + marker。
const MARKER_NAMES: Record<string, string> = {
    "◇ 用户人设": "personaDescription", "◇ 世界书（角色前）": "worldInfoBefore",
    "◇ 角色描述": "charDescription", "◇ 角色性格": "charPersonality",
    "◇ 角色关系": "characterRelations",
    "◇ 世界书（角色后）": "worldInfoAfter",
    "◇ 日程": "calendarSchedule",
    "◇ 核心记忆": "memoryCore", "◇ 长期记忆": "memoryLongTerm",
    "◇ [短期记忆]": "shortTermMemory",
};

// 宽松匹配：忽略 ◇ 前缀、空白和方括号，"用户人设" / "◇ 用户人设" 都能命中
function normalizeMarkerName(name: string): string {
    return name.replace(/[◇\s\[\]]/g, "");
}

const MARKER_NAMES_NORMALIZED: Record<string, string> = Object.fromEntries(
    Object.entries(MARKER_NAMES).map(([name, id]) => [normalizeMarkerName(name), id])
);

function matchMarkerByName(name: string): string | null {
    return MARKER_NAMES_NORMALIZED[normalizeMarkerName(name)] ?? null;
}

// 构建「有序 + 孤儿」的条目列表，并按 identifier 去重。
// 若 prompt_order 含重复 entry 或 prompts 含重复 identifier，会导致同一条目渲染多次、
// reorder 索引错位、touch 拖拽拖到错误的条目；这里统一保首个出现，保证渲染与重排视图唯一。
function buildDisplayedPrompts(preset: PresetConfig): Prompt[] {
    const seen = new Set<string>();
    const out: Prompt[] = [];
    const push = (p?: Prompt) => {
        if (p && !seen.has(p.identifier)) {
            seen.add(p.identifier);
            out.push(p);
        }
    };
    if (preset.prompt_order && preset.prompt_order.length > 0) {
        for (const e of preset.prompt_order) {
            push(preset.prompts.find(x => x.identifier === e.identifier));
        }
    }
    for (const p of preset.prompts || []) push(p);
    return out;
}

type AppFilterMode = "highlight" | "only-show" | "collapse" | "group-collapse";

const GENERATION_PARAMETER_OPTIONS: Array<{ key: GenerationParameterKey; label: string; title: string }> = [
    { key: "temperature", label: "Temperature", title: "Temperature" },
    { key: "top_p", label: "Top P", title: "Top P" },
    { key: "top_k", label: "Top K", title: "Top K" },
    { key: "min_p", label: "Min P", title: "Min P" },
    { key: "top_a", label: "Top A", title: "Top A" },
    { key: "repetition_penalty", label: "重复惩罚", title: "Repetition Penalty" },
    { key: "frequency_penalty", label: "频率惩罚", title: "Frequency Penalty" },
    { key: "presence_penalty", label: "存在惩罚", title: "Presence Penalty" },
    { key: "max_tokens", label: "Max Tokens", title: "Max Tokens" },
];

type PromptRenderItem =
    | { type: "item"; prompt: Prompt }
    | { type: "collapsed"; prompts: Prompt[]; groupKey: string; label: string }
    | { type: "collapse-header"; groupKey: string; label: string; count: number };

function buildPromptRenderItems(
    preset: PresetConfig,
    tagGroups: TagGroupProfile[],
    filterMode: AppFilterMode,
    filterTags: Set<string>,
    expandedGroups: Set<string>,
): PromptRenderItem[] {
    const allPrompts = buildDisplayedPrompts(preset);
    const matchesFilter = (prompt: Prompt) => matchesSelectedAppTags(prompt, filterTags);
    const hasFilter = filterTags.size > 0;

    if (filterMode === "only-show" && hasFilter) {
        return allPrompts.filter(matchesFilter).map(prompt => ({ type: "item", prompt }));
    }

    const getGroupKey = (prompt: Prompt): string => {
        const promptTags = getPromptTags(prompt);
        if (promptTags.length === 0) return "__universal__";
        const group = findTagGroupForTags(tagGroups, promptTags);
        return group?.tags[0] || promptTags[0];
    };
    const getGroupLabel = (tag: string): string => {
        if (tag === "__universal__") return "通用";
        return tagGroups.find(group => group.tags[0] === tag)?.label || tag;
    };

    if (filterMode !== "collapse" && filterMode !== "group-collapse") {
        return allPrompts.map(prompt => ({ type: "item", prompt }));
    }

    const makeCollapsedOrExpanded = (prompts: Prompt[], key: string, label: string): PromptRenderItem[] => {
        if (expandedGroups.has(key)) {
            return [
                { type: "collapse-header", groupKey: key, label, count: prompts.length },
                ...prompts.map(prompt => ({ type: "item" as const, prompt })),
            ];
        }
        return [{ type: "collapsed", prompts, groupKey: key, label }];
    };
    const participates = (prompt: Prompt): boolean => !hasFilter || matchesFilter(prompt);

    if (filterMode === "group-collapse") {
        const byGroup = new Map<string, Prompt[]>();
        for (const prompt of allPrompts) {
            if (!participates(prompt)) continue;
            const groupKey = getGroupKey(prompt);
            const group = byGroup.get(groupKey) || [];
            group.push(prompt);
            byGroup.set(groupKey, group);
        }

        const result: PromptRenderItem[] = [];
        const seenGroups = new Set<string>();
        for (const prompt of allPrompts) {
            if (!participates(prompt)) {
                result.push({ type: "item", prompt });
                continue;
            }
            const groupKey = getGroupKey(prompt);
            if (seenGroups.has(groupKey)) continue;
            seenGroups.add(groupKey);
            const group = byGroup.get(groupKey) || [];
            if (group.length >= 2) {
                result.push(...makeCollapsedOrExpanded(group, `g-${groupKey}`, getGroupLabel(groupKey)));
            } else {
                result.push({ type: "item", prompt });
            }
        }
        return result;
    }

    const result: PromptRenderItem[] = [];
    let index = 0;
    let segmentIndex = 0;
    while (index < allPrompts.length) {
        const prompt = allPrompts[index];
        const groupKey = getGroupKey(prompt);
        if (!participates(prompt)) {
            result.push({ type: "item", prompt });
            index += 1;
            continue;
        }

        const group: Prompt[] = [];
        let nextIndex = index;
        while (
            nextIndex < allPrompts.length
            && participates(allPrompts[nextIndex])
            && getGroupKey(allPrompts[nextIndex]) === groupKey
        ) {
            group.push(allPrompts[nextIndex]);
            nextIndex += 1;
        }
        if (group.length >= 2) {
            result.push(...makeCollapsedOrExpanded(
                group,
                `g-${groupKey}-seg${segmentIndex++}`,
                getGroupLabel(groupKey),
            ));
        } else {
            result.push({ type: "item", prompt });
        }
        index = nextIndex;
    }
    return result;
}

const MASCOT_PRESET_STORAGE_TOOL_NAMES = new Set([
    "创建剧情预设",
    "克隆内置预设",
    "复制预设",
    "添加预设条目",
    "更新预设条目",
    "更新预设信息",
]);

const AutoResizeTextarea = ({ value, onChange, placeholder, style, rows = 1, className }: { value: string, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void, placeholder?: string, style?: React.CSSProperties, rows?: number, className?: string }) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        }
    }, [value]);

    return (
        <textarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            rows={rows}
            className={`resize-none overflow-hidden ${className || ""}`}
            style={style}
        />
    );
};

export function PresetManager({ isActive = true }: { isActive?: boolean } = {}) {
    const [presets, setPresets] = useState<PresetConfig[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<"list" | "detail">("list");
    const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
    const [confirmExportId, setConfirmExportId] = useState<string | null>(null);
    const [confirmResetId, setConfirmResetId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [confirmDeleteEntry, setConfirmDeleteEntry] = useState<string | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);
    const [paramsOpen, setParamsOpen] = useState(false);
    const [parameterPickerOpen, setParameterPickerOpen] = useState(false);
    const [expandTarget, setExpandTarget] = useState<{ identifier: string; field: string } | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [customApps, setCustomApps] = useState<InstalledCustomApp[]>([]);
    // ── 多选模式（右滑选中 / 批量操作 / 多选拖拽） ──
    const [selectMode, setSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [selectionPresetId, setSelectionPresetId] = useState<string | null>(null);
    const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);

    // ── 按 App 筛选（高亮/仅显示/仅折叠/同类折叠） ──
    const [appFilterOpen, setAppFilterOpen] = useState(false);
    const [appFilterMode, setAppFilterMode] = useState<AppFilterMode>("highlight");
    const [appFilterTags, setAppFilterTags] = useState<Set<string>>(new Set()); // 选中的大类 tag 集合（可多选）
    const [expandedCollapseGroups, setExpandedCollapseGroups] = useState<Set<string>>(new Set()); // 已展开的折叠组 key

    const toggleFilterTag = useCallback((tag: string) => {
        setAppFilterTags(prev => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
    }, []);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const { setSubpageTitle, setOverrideBack, setSubpageRightAction } = useContext(SettingsContext);

    // Initial load
    useEffect(() => {
        const loaded = loadPresets();
        if (loaded.length > 0) {
            setPresets(loaded);
        }
        setCustomApps(loadInstalledCustomApps());
        setIsLoaded(true);
    }, []);

    useEffect(() => {
        const refreshCustomApps = () => setCustomApps(loadInstalledCustomApps());
        const refreshPresets = () => setPresets(loadPresets());
        window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
        window.addEventListener("settings-presets-updated", refreshPresets);
        return () => {
            window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
            window.removeEventListener("settings-presets-updated", refreshPresets);
        };
    }, []);

    const tagGroups = useMemo(() => [
        ...CONTENT_SCOPE_TAG_GROUPS,
        ...buildCustomAppTagGroups(customApps, {
            prompts: presets.flatMap(preset => preset.prompts ?? []),
        }),
    ], [customApps, presets]);

    const tagProfiles = useMemo(() => flattenTagGroups(tagGroups), [tagGroups]);
    const activePreset = useMemo(
        () => presets.find(preset => preset.id === editingId) ?? null,
        [editingId, presets],
    );
    const promptRenderItems = useMemo(
        () => activePreset
            ? buildPromptRenderItems(activePreset, tagGroups, appFilterMode, appFilterTags, expandedCollapseGroups)
            : [],
        [activePreset, appFilterMode, appFilterTags, expandedCollapseGroups, tagGroups],
    );
    const visiblePromptIds = useMemo(
        () => new Set(
            promptRenderItems
                .filter((item): item is Extract<PromptRenderItem, { type: "item" }> => item.type === "item")
                .map(item => item.prompt.identifier),
        ),
        [promptRenderItems],
    );
    const actionableSelectedIds = useMemo(() => {
        if (!editingId || selectionPresetId !== editingId) return new Set<string>();
        return new Set([...selectedIds].filter(identifier => visiblePromptIds.has(identifier)));
    }, [editingId, selectedIds, selectionPresetId, visiblePromptIds]);

    useEffect(() => {
        setSelectMode(false);
        setSelectedIds(new Set());
        setSelectionPresetId(null);
        setConfirmDeleteSelected(false);
        setParameterPickerOpen(false);
    }, [editingId, viewMode]);

    useEffect(() => {
        setSelectedIds(previous => {
            const next = new Set([...previous].filter(identifier => visiblePromptIds.has(identifier)));
            if (next.size === previous.size && [...next].every(identifier => previous.has(identifier))) return previous;
            return next;
        });
    }, [visiblePromptIds]);

    const containerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (viewMode === "detail" && editingId) {
            setOverrideBack(() => () => setViewMode("list"));
            const target = presets.find(p => p.id === editingId);
            setSubpageTitle(target?.name || "预设详情");
        } else {
            setOverrideBack(null);
            setSubpageTitle(null);
        }
    }, [viewMode, editingId, presets, setOverrideBack, setSubpageTitle]);

    useEffect(() => {
        // Reset scroll only when changing view/preset, not on every field edit.
        const scrollParent = containerRef.current?.closest(".page-body");
        if (scrollParent) scrollParent.scrollTop = 0;
    }, [viewMode, editingId]);

    // Send mascot context when viewing preset detail (only when this tab is active)
    useEffect(() => {
        if (!isActive) return;
        if (viewMode === "detail" && editingId) {
            const preset = presets.find(p => p.id === editingId);
            if (!preset) return;
            const fields: Record<string, string> = {
                presetId: editingId,
                presetName: preset.name,
                presetDescription: preset.description || "",
                promptCount: String(preset.prompts.length),
            };
            // Include current prompt_order
            if (preset.prompt_order && preset.prompt_order.length > 0) {
                fields.current_prompt_order = preset.prompt_order.map(e => `${e.identifier}(${e.enabled ? "on" : "off"})`).join(" → ");
            }
            // Include full prompt data
            for (let i = 0; i < preset.prompts.length; i++) {
                const p = preset.prompts[i];
                const prefix = `prompt_${i}`;
                fields[`${prefix}_identifier`] = p.identifier;
                fields[`${prefix}_name`] = p.name;
                fields[`${prefix}_role`] = p.role;
                fields[`${prefix}_marker`] = p.marker ? "true" : "false";
                if (!p.marker && p.content) {
                    fields[`${prefix}_content`] = p.content;
                }
                if (p.system_prompt) fields[`${prefix}_system_prompt`] = "true";
            }
            notifyMascotPageContext({
                page: "presets",
                mode: "editing",
                label: `预设 · ${preset.name}`,
                fields,
            });
        } else if (viewMode === "list") {
            notifyMascotPageContext({
                page: "presets",
                mode: "viewing",
                label: "预设列表",
                fields: {},
            });
        }
    }, [viewMode, editingId, presets, isActive]);

    // Reset mascot context on unmount
    useEffect(() => {
        return () => {
            notifyMascotPageContext({ page: "desktop", mode: "idle", label: "桌面", fields: {} });
        };
    }, []);

    // Listen for mascot fill events — assembles preset from prompt_N_xxx actions
    const editingIdRef = useRef(editingId);
    editingIdRef.current = editingId;

    useEffect(() => {
        const onFill = (e: Event) => {
            const { field, value } = (e as CustomEvent).detail;
            const presetId = editingIdRef.current;

            if (MASCOT_PRESET_STORAGE_TOOL_NAMES.has(field)) {
                const loaded = loadPresets();
                setPresets(loaded);
                if (presetId && !loaded.some(p => p.id === presetId)) {
                    setEditingId(null);
                    setViewMode("list");
                }
                return;
            }

            if (!presetId) return;

            setPresets(prev => {
                const idx = prev.findIndex(p => p.id === presetId);
                if (idx < 0) return prev;
                const preset = { ...prev[idx] };
                let handled = false;

                if (field === "preset_name") {
                    preset.name = value;
                    handled = true;
                } else if (field === "preset_description") {
                    preset.description = value;
                    handled = true;
                } else if (field === "prompt_order") {
                    try {
                        const parsed = JSON.parse(value);
                        let newOrder: PromptOrderEntry[];
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            newOrder = (parsed[0].order ? parsed[0].order : parsed) as PromptOrderEntry[];
                        } else {
                            newOrder = [];
                        }
                        if (newOrder.length > 0) {
                            preset.prompt_order = newOrder;
                            // Re-sort prompts array to match new order
                            const orderMap = new Map(newOrder.map((e, i) => [e.identifier, i]));
                            preset.prompts = [...preset.prompts].sort((a, b) => {
                                const ia = orderMap.get(a.identifier) ?? 999;
                                const ib = orderMap.get(b.identifier) ?? 999;
                                return ia - ib;
                            });
                        }
                        handled = true;
                    } catch {
                        // Ignore invalid preset order payloads.
                    }
                } else if (field.startsWith("prompt_")) {
                    const match = field.match(/^prompt_(\d+)_(\w+)$/);
                    if (match) {
                        const promptIdx = parseInt(match[1], 10);
                        const subfield = match[2];
                        // Ensure prompts array is large enough
                        const prompts = [...preset.prompts];
                        while (prompts.length <= promptIdx) {
                            prompts.push({
                                identifier: `prompt_${prompts.length}`,
                                name: "",
                                role: "system",
                                content: "",
                                injection_position: 0,
                                injection_depth: 4,
                                enabled: true,
                                marker: false,
                                system_prompt: false,
                                forbid_overrides: false,
                            });
                        }
                        const prompt = { ...prompts[promptIdx] };
                        if (subfield === "identifier") {
                            prompt.identifier = value;
                            handled = true;
                        }
                        else if (subfield === "name") {
                            prompt.name = value;
                            handled = true;
                        }
                        else if (subfield === "role") {
                            prompt.role = value as "system" | "user" | "assistant";
                            handled = true;
                        }
                        else if (subfield === "content") {
                            prompt.content = value;
                            handled = true;
                        }
                        else if (subfield === "marker") {
                            prompt.marker = value === "true";
                            if (prompt.marker) {
                                prompt.content = "";
                                prompt.injection_depth = 0;
                            }
                            handled = true;
                        }
                        else if (subfield === "system_prompt") {
                            prompt.system_prompt = value === "true";
                            handled = true;
                        }
                        if (!handled) return prev;
                        // Auto-detect marker by matching fixed names
                        const autoMarkerId = subfield === "name" ? matchMarkerByName(value) : null;
                        if (autoMarkerId && !prompts.some((p, pi) => pi !== promptIdx && p.identifier === autoMarkerId)) {
                            prompt.marker = true;
                            prompt.identifier = autoMarkerId;
                            prompt.content = "";
                            prompt.injection_depth = 0;
                        }
                        // Auto-generate identifier from name if not set or still placeholder
                        if (!prompt.marker && prompt.name && (!prompt.identifier || prompt.identifier.startsWith("_placeholder"))) {
                            prompt.identifier = prompt.name.replace(/[^\w\u4e00-\u9fff]/g, "").slice(0, 30) || `prompt_${promptIdx}`;
                        }
                        prompts[promptIdx] = prompt;
                        preset.prompts = prompts;
                        // Auto-set system_prompt on the first non-marker system prompt
                        const firstSystemIdx = prompts.findIndex(p => !p.marker && p.role === "system" && p.content);
                        for (let pi = 0; pi < prompts.length; pi++) {
                            prompts[pi] = { ...prompts[pi], system_prompt: pi === firstSystemIdx };
                        }
                        // Auto-generate prompt_order from array order
                        preset.prompt_order = prompts.filter(p => p.identifier && !p.identifier.startsWith("_placeholder")).map(p => ({ identifier: p.identifier, enabled: true }));
                    }
                }

                if (!handled) return prev;
                preset.updatedAt = Date.now();
                const next = [...prev];
                next[idx] = preset;
                savePresets(next);
                return next;
            });
        };
        window.addEventListener("mascot-fill-field", onFill);
        return () => window.removeEventListener("mascot-fill-field", onFill);
    }, []);

    const persist = useCallback((newPresets: PresetConfig[]) => {
        setPresets(newPresets);
        savePresets(newPresets);
    }, []);

    const addPreset = useCallback(() => {
        const newPreset = createPreset("新预设");
        persist([newPreset, ...presets]);
        setEditingId(newPreset.id);
        setViewMode("detail");
    }, [persist, presets]);

    const duplicatePreset = useCallback((preset: PresetConfig) => {
        const now = Date.now();
        const source = JSON.parse(JSON.stringify(preset)) as PresetConfig;
        const copy: PresetConfig = {
            ...source,
            id: `preset_${now}_${Math.random().toString(36).slice(2, 9)}`,
            name: `${source.name || "预设"} 副本`,
            createdAt: now,
            updatedAt: now,
            builtIn: undefined,
            builtInVersion: undefined,
        };
        persist([copy, ...presets]);
        setEditingId(copy.id);
        setViewMode("detail");
    }, [persist, presets]);

    useEffect(() => {
        if (viewMode !== "list") {
            setSubpageRightAction("presets", null);
            return;
        }
        setSubpageRightAction("presets",
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95 focus:outline-none"
                >
                    <Upload size={15} strokeWidth={1.8} />
                    <span>导入预设</span>
                </button>
                <button
                    type="button"
                    onClick={addPreset}
                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                >
                    <Plus size={15} strokeWidth={1.8} />
                    <span>新建预设</span>
                </button>
            </div>
        );
        return () => setSubpageRightAction("presets", null);
    }, [addPreset, setSubpageRightAction, viewMode]);

    const updatePreset = (id: string, updates: Partial<PresetConfig>) => {
        persist(presets.map(p => p.id === id ? { ...p, ...updates, updatedAt: Date.now() } : p));
    };

    const toggleGenerationParameter = (preset: PresetConfig, key: GenerationParameterKey) => {
        const enabled = resolveEnabledGenerationParameters(preset);
        const willEnable = !enabled.has(key);
        if (willEnable) enabled.add(key);
        else enabled.delete(key);

        const updates: Partial<PresetConfig> = {
            enabled_generation_parameters: GENERATION_PARAMETER_KEYS.filter(item => enabled.has(item)),
        };
        // 0 在 Max Tokens 中表示“不发送”。用户主动开启时给一个可用值，
        // 避免胶囊显示已选、请求里却仍然没有该字段。
        if (key === "max_tokens" && willEnable && preset.openai_max_tokens <= 0) {
            updates.openai_max_tokens = 4096;
        }
        updatePreset(preset.id, updates);
    };

    const updatePrompt = (
        preset: PresetConfig,
        promptId: string,
        updater: (prompt: Prompt) => Prompt,
        updates: Partial<PresetConfig> = {},
    ) => {
        const newPrompts = preset.prompts.map(prompt =>
            prompt.identifier === promptId ? updater(prompt) : prompt,
        );
        updatePreset(preset.id, { ...updates, prompts: newPrompts });
    };

    // ── Prompt reorder (shared by HTML5 drag & touch sort) ──
    // 多选模式下拖动选中的条目 → 整组批量移动；否则单条目移动。
    const handlePromptReorder = useCallback((fromRenderIndex: number, toRenderIndex: number) => {
        if (!editingId) return;
        const preset = presets.find(p => p.id === editingId);
        if (!preset) return;
        const fromRenderItem = promptRenderItems[fromRenderIndex];
        const toRenderItem = promptRenderItems[toRenderIndex];
        if (fromRenderItem?.type !== "item" || toRenderItem?.type !== "item") return;

        // DOM 索引来自当前筛选/折叠视图；先按 identifier 映射回完整顺序，避免拖错条目。
        const displayed = buildDisplayedPrompts(preset);
        const fromIndex = displayed.findIndex(prompt => prompt.identifier === fromRenderItem.prompt.identifier);
        const toIndex = displayed.findIndex(prompt => prompt.identifier === toRenderItem.prompt.identifier);
        if (fromIndex < 0 || toIndex < 0) return;
        const dragged = displayed[fromIndex];

        let newDisplayed: Prompt[];
        const isBulk = selectMode
            && actionableSelectedIds.size > 1
            && actionableSelectedIds.has(dragged.identifier);
        if (isBulk) {
            // 整组选中条目一起移动（选中集内部相对顺序保持不变）
            const selected = displayed.filter(p => actionableSelectedIds.has(p.identifier));
            if (selected.length === displayed.length) return; // 全选时移动无意义
            const rest = displayed.filter(p => !actionableSelectedIds.has(p.identifier));
            // 锚点：向下拖时插到「原位置 > to 的第一个未选中条目」之前；向上拖同理用 >= to
            const anchor = rest.find(p => {
                const idx = displayed.indexOf(p);
                return toIndex > fromIndex ? idx > toIndex : idx >= toIndex;
            });
            const insertPos = anchor ? rest.indexOf(anchor) : rest.length;
            newDisplayed = [...rest.slice(0, insertPos), ...selected, ...rest.slice(insertPos)];
        } else {
            // 单条目移动（未选中条目 / 单选）
            const [item] = displayed.splice(fromIndex, 1);
            displayed.splice(toIndex, 0, item);
            newDisplayed = displayed;
        }
        const newOrder = newDisplayed.map(p => ({
            identifier: p.identifier,
            enabled: preset.prompt_order
                ? (preset.prompt_order.find(o => o.identifier === p.identifier)?.enabled ?? p.enabled)
                : p.enabled,
        }));
        // 排序只更新 prompt_order；prompts 是原始数据源，不能用去重后的显示投影覆盖。
        updatePreset(preset.id, { prompt_order: newOrder });
    }, [actionableSelectedIds, editingId, presets, promptRenderItems, selectMode]);

    const getPromptDragIndices = useCallback((pressedIndex: number) => {
        const pressedItem = promptRenderItems[pressedIndex];
        if (
            !selectMode
            || pressedItem?.type !== "item"
            || !actionableSelectedIds.has(pressedItem.prompt.identifier)
        ) {
            return [pressedIndex];
        }
        return promptRenderItems.flatMap((item, index) => (
            item.type === "item" && actionableSelectedIds.has(item.prompt.identifier) ? [index] : []
        ));
    }, [actionableSelectedIds, promptRenderItems, selectMode]);

    const { containerRef: promptListRef, onTouchStart: onPromptTouchStart, onTouchMove: onPromptTouchMove, onTouchEnd: onPromptTouchEnd } = useTouchSort(
        handlePromptReorder,
        400,
        getPromptDragIndices,
    );

    // ── 条目左滑操作（微信式：左滑露出「新增/删除」） ──
    const swipe = useSwipeActions();

    // ── 多选模式：右滑选中 / 批量操作 / 多选拖拽 ──
    const enterSelectMode = useCallback(() => {
        if (!editingId) return;
        setSelectMode(true);
        setSelectionPresetId(editingId);
        setSelectedIds(new Set());
        setEditingPromptId(null); // 收起展开的编辑，避免手势冲突
        swipe.close();
    }, [editingId, swipe]);

    const exitSelectMode = useCallback(() => {
        setSelectMode(false);
        setSelectedIds(new Set());
        setSelectionPresetId(null);
        swipe.close();
    }, [swipe]);

    const toggleSelect = useCallback((identifier: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(identifier)) next.delete(identifier);
            else next.add(identifier);
            return next;
        });
    }, []);

    // 右滑条目 → 选中并进入多选模式；已处于多选模式时追加选中
    const handleSwipeRightSelect = useCallback((identifier: string) => {
        if (!editingId) return;
        setSelectMode(true);
        setEditingPromptId(null);
        setSelectedIds(prev => {
            const next = selectionPresetId === editingId ? new Set(prev) : new Set<string>();
            next.add(identifier);
            return next;
        });
        setSelectionPresetId(editingId);
        swipe.close();
    }, [editingId, selectionPresetId, swipe]);

    const selectAllPrompts = useCallback(() => {
        if (!editingId) return;
        setSelectionPresetId(editingId);
        setSelectedIds(new Set(visiblePromptIds));
    }, [editingId, visiblePromptIds]);

    const bulkSetEnabled = useCallback((enabled: boolean) => {
        const preset = presets.find(p => p.id === editingId);
        if (!preset || actionableSelectedIds.size === 0) return;
        const newPrompts = preset.prompts.map(p =>
            actionableSelectedIds.has(p.identifier) ? { ...p, enabled } : p,
        );
        const newOrder = preset.prompt_order?.map(o =>
            actionableSelectedIds.has(o.identifier) ? { ...o, enabled } : o,
        );
        updatePreset(preset.id, { prompts: newPrompts, ...(newOrder ? { prompt_order: newOrder } : {}) });
    }, [actionableSelectedIds, presets, editingId]);

    const bulkExportSelected = useCallback(async () => {
        const preset = presets.find(p => p.id === editingId);
        if (!preset || actionableSelectedIds.size === 0) return;
        const selected = preset.prompts.filter(p => actionableSelectedIds.has(p.identifier));
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(selected, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${preset.name || "preset"}-entries.json`);
    }, [actionableSelectedIds, presets, editingId]);

    const deleteSelectedPrompts = useCallback(() => {
        const preset = presets.find(p => p.id === editingId);
        if (!preset || actionableSelectedIds.size === 0) return;
        const newPrompts = preset.prompts.filter(p => !actionableSelectedIds.has(p.identifier));
        const newOrder = (preset.prompt_order || []).filter(o => !actionableSelectedIds.has(o.identifier));
        updatePreset(preset.id, { prompts: newPrompts, prompt_order: newOrder });
        if (editingPromptId && actionableSelectedIds.has(editingPromptId)) setEditingPromptId(null);
        setSelectedIds(new Set());
        setSelectionPresetId(null);
        setConfirmDeleteSelected(false);
        setSelectMode(false);
    }, [actionableSelectedIds, presets, editingId, editingPromptId]);

    const insertPromptAfter = (preset: PresetConfig, afterIdentifier: string) => {
        const newPrompt = {
            identifier: `prompt-${Date.now()}`,
            name: "新提示词",
            role: "system" as const,
            content: "",
            injection_depth: 0,
            enabled: true,
        };
        // 与渲染一致的显示顺序（去重后的 prompt_order + 孤儿条目）
        const displayed = buildDisplayedPrompts(preset);
        const idx = displayed.findIndex(p => p.identifier === afterIdentifier);
        if (idx >= 0) displayed.splice(idx + 1, 0, newPrompt);
        else displayed.push(newPrompt);
        const newOrder = displayed.map(p => ({
            identifier: p.identifier,
            enabled: p.identifier === newPrompt.identifier
                ? true
                : (preset.prompt_order
                    ? (preset.prompt_order.find(o => o.identifier === p.identifier)?.enabled ?? p.enabled)
                    : p.enabled),
        }));
        updatePreset(preset.id, { prompts: [...preset.prompts, newPrompt], prompt_order: newOrder });
        swipe.close();
        setEditingPromptId(newPrompt.identifier);
        window.setTimeout(() => {
            promptListRef.current
                ?.querySelector(`[data-swipe-id="${newPrompt.identifier}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    // ── 条目级导入/导出（左滑「替换/导出」+ 底部「添加条目」菜单） ──
    const [addEntryMenuOpen, setAddEntryMenuOpen] = useState(false);
    const entryFileInputRef = useRef<HTMLInputElement>(null);
    const entryImportModeRef = useRef<{ mode: "append" } | { mode: "replace"; identifier: string } | null>(null);

    const sanitizePromptImport = (raw: unknown, fallbackIdentifier: string): Prompt | null => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const obj = raw as Record<string, unknown>;
        if (typeof obj.name !== "string" && typeof obj.content !== "string" && typeof obj.identifier !== "string") return null;
        const role = obj.role === "user" || obj.role === "assistant" || obj.role === "system" ? obj.role : "system";
        const prompt: Prompt = {
            identifier: typeof obj.identifier === "string" && obj.identifier ? obj.identifier : fallbackIdentifier,
            name: typeof obj.name === "string" ? obj.name : "",
            role,
            content: typeof obj.content === "string" ? obj.content : "",
            injection_depth: typeof obj.injection_depth === "number" ? obj.injection_depth : 0,
            injection_position: typeof obj.injection_position === "number" ? obj.injection_position : 0,
            enabled: obj.enabled !== false,
            marker: !!obj.marker,
            system_prompt: !!obj.system_prompt,
            forbid_overrides: !!obj.forbid_overrides,
        };
        if (Array.isArray(obj.tags)) prompt.tags = obj.tags.filter((t): t is string => typeof t === "string");
        if (typeof obj.featureTag === "string") prompt.featureTag = obj.featureTag;
        if (typeof obj.followUpOnly === "boolean") prompt.followUpOnly = obj.followUpOnly;
        return prompt;
    };

    const createPromptAtEnd = (preset: PresetConfig) => {
        const newPrompt = {
            identifier: `prompt-${Date.now()}`,
            name: "新提示词",
            role: "system" as const,
            content: "",
            injection_depth: 0,
            enabled: true,
        };
        const newPrompts = [...(preset.prompts || []), newPrompt];
        const newOrder = newPrompts.map(p => ({
            identifier: p.identifier,
            enabled: preset.prompt_order
                ? (preset.prompt_order.find(o => o.identifier === p.identifier)?.enabled ?? p.enabled)
                : p.enabled,
        }));
        updatePreset(preset.id, { prompts: newPrompts, prompt_order: newOrder });
    };

    const appendImportedPrompts = (preset: PresetConfig, raws: unknown[]) => {
        const base = Date.now();
        const sanitized = raws
            .map((raw, i) => sanitizePromptImport(raw, `prompt-${base + i}`))
            .filter((p): p is Prompt => !!p);
        if (sanitized.length === 0) {
            setImportError("JSON 里没有可识别的条目内容。");
            return;
        }
        const used = new Set((preset.prompts || []).map(p => p.identifier));
        const appended = sanitized.map(p => {
            let id = p.identifier;
            let n = 1;
            while (used.has(id)) id = `${p.identifier}_${n++}`;
            used.add(id);
            return { ...p, identifier: id };
        });
        const newPrompts = [...(preset.prompts || []), ...appended];
        const newOrder = newPrompts.map(p => ({
            identifier: p.identifier,
            enabled: preset.prompt_order
                ? (preset.prompt_order.find(o => o.identifier === p.identifier)?.enabled ?? p.enabled)
                : p.enabled,
        }));
        updatePreset(preset.id, { prompts: newPrompts, prompt_order: newOrder });
        if (appended.length === 1) setEditingPromptId(appended[0].identifier);
        window.setTimeout(() => {
            promptListRef.current
                ?.querySelector(`[data-swipe-id="${CSS.escape(appended[0].identifier)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    const replaceImportedPrompt = (preset: PresetConfig, targetIdentifier: string, raw: unknown) => {
        const sanitized = sanitizePromptImport(raw, targetIdentifier);
        if (!sanitized) {
            setImportError("JSON 里没有可识别的条目内容。");
            return;
        }
        // 导入的 identifier 与其它条目冲突时保留原 identifier，避免顶掉别的条目
        const finalId = sanitized.identifier !== targetIdentifier && preset.prompts.some(p => p.identifier === sanitized.identifier)
            ? targetIdentifier
            : sanitized.identifier;
        const finalPrompt = { ...sanitized, identifier: finalId };
        const newPrompts = preset.prompts.map(p => p.identifier === targetIdentifier ? finalPrompt : p);
        const newOrder = preset.prompt_order?.map(o => o.identifier === targetIdentifier ? { ...o, identifier: finalId } : o);
        updatePreset(preset.id, { prompts: newPrompts, ...(newOrder ? { prompt_order: newOrder } : {}) });
        if (editingPromptId === targetIdentifier) setEditingPromptId(finalId);
    };

    const exportPrompt = async (prompt: Prompt) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(prompt, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${prompt.name || prompt.identifier || "prompt"}.json`);
    };

    const handleEntryImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        const mode = entryImportModeRef.current;
        entryImportModeRef.current = null;
        if (entryFileInputRef.current) entryFileInputRef.current.value = "";
        if (!file || !mode) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const preset = presets.find(p => p.id === editingId);
            if (!preset) return;
            try {
                const parsed = JSON.parse(event.target?.result as string);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                if (mode.mode === "replace") replaceImportedPrompt(preset, mode.identifier, items[0]);
                else appendImportedPrompts(preset, items);
            } catch {
                setImportError("无法解析条目文件，格式不正确。");
            }
        };
        reader.readAsText(file);
    };

    const removePreset = (id: string) => {
        const remaining = presets.filter(p => p.id !== id);
        persist(remaining);
        setViewMode("list");
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                const fallbackName = file.name.replace(/\.json$/i, '');
                const parsed = parsePresetFromJson(text, fallbackName);
                if (parsed) {
                    persist([parsed, ...presets]);
                } else {
                    setImportError("无法解析预设文件，格式不正确。");
                }
            } catch (e) {
                if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) {
                    setImportError("不支持该预设格式");
                } else {
                    setImportError("无法解析预设文件，格式不正确。");
                }
            }
        };
        reader.readAsText(file);
        // Reset file input
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    };

    const handleExport = async (preset: PresetConfig) => {
        const exportData = { ...preset };
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${preset.name || "preset"}.json`);
    };

    if (!isLoaded) return null; // loading state

    return (
        <div ref={containerRef} className="flex flex-col gap-[24px] h-full">
            <input type="file" accept=".json" className="hidden" ref={fileInputRef} onChange={handleImport} />
            <input type="file" accept=".json" className="hidden" ref={entryFileInputRef} onChange={handleEntryImportFile} />
            {viewMode === "list" ? (
                <>
                    <div className="flex items-center">
                        <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Presets</h2>
                    </div>

                    {presets.length === 0 ? (
                        <div className="ui-empty mt-5">
                            <div className="ui-icon-circle">
                                <MessageSquare size={24} />
                            </div>
                            <span className="menu-label font-semibold">没有预设</span>
                            <span className="menu-desc max-w-[240px]">
                                预设用于定义 AI 的回复风格、行为设定和核心参数。
                            </span>
                            <div className="flex gap-3">
                                <button onClick={addPreset} className="ui-btn ui-btn-primary">
                                    <Plus size={16} /> 新建预设
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {presets.map(preset => (
                                <div
                                    key={preset.id}
                                    className="ui-config-card min-w-0 cursor-pointer"
                                    style={{ minHeight: "84px", padding: "16px", justifyContent: "space-between" }}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`编辑 ${preset.name || "预设"}`}
                                    onClick={() => { setEditingId(preset.id); setViewMode("detail"); }}
                                    onKeyDown={(event) => {
                                        if (event.target !== event.currentTarget) return;
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            setEditingId(preset.id);
                                            setViewMode("detail");
                                        }
                                    }}
                                >
                                    <div className="min-w-0 flex flex-col gap-1.5">
                                        <div className="min-w-0 flex items-center gap-[6px]">
                                            <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{preset.name}</span>
                                            {preset.builtIn && (
                                                <span className="ui-badge shrink-0" data-variant="success">内置</span>
                                            )}
                                        </div>
                                        <span className="menu-desc truncate">{preset.description || `包含 ${preset.prompts?.length || 0} 个设定条目`}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="menu-desc ts-12">条目 {preset.prompts?.length || 0}</span>
                                        <ChevronLeft size={16} style={{ transform: "rotate(180deg)", opacity: 0.4 }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            ) : (
                <>
                    {presets.map(preset => {
                        if (preset.id !== editingId) return null;
                        const enabledGenerationParameters = resolveEnabledGenerationParameters(preset);
                        return (
                            <div key={preset.id} className="flex flex-col gap-4 pb-[24px]">
                                <div className="flex justify-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => duplicatePreset(preset)}
                                        className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95"
                                    >
                                        <Copy size={15} strokeWidth={1.8} />
                                        <span>复制预设</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirmExportId(preset.id)}
                                        className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95"
                                    >
                                        <Download size={15} strokeWidth={1.8} />
                                        <span>导出预设</span>
                                    </button>
                                    {preset.builtIn ? (
                                        <button
                                            type="button"
                                            onClick={() => setConfirmResetId(preset.id)}
                                            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95"
                                            title="重置为默认"
                                        >
                                            <RotateCcw size={15} strokeWidth={1.8} />
                                            <span>重置默认</span>
                                        </button>
                                    ) : (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => setConfirmDeleteId(preset.id)}
                                                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-[var(--c-danger)] shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95"
                                            >
                                                <Trash2 size={15} strokeWidth={1.8} />
                                                <span>删除预设</span>
                                            </button>
                                        </>
                                    )}
                                </div>
                                <h2 className="mx-2 mb-0 mt-2 ts-20 font-bold leading-none text-black">Preset Info</h2>
                                <div className="ui-entry-card" style={{ cursor: "default" }}>
                                        <div className="flex flex-col gap-2">
                                            <div className="flex justify-between items-center">
                                                <label className="menu-label ts-13 font-semibold ml-1">预设名称</label>
                                            </div>
                                            <input
                                                type="text"
                                                value={preset.name}
                                                onChange={(e) => updatePreset(preset.id, { name: e.target.value })}
                                                placeholder="预设名称..."
                                                className="ui-input font-medium"
                                            />
                                        </div>

                                        <div className="flex flex-col gap-2">
                                            <label className="menu-label ts-13 font-semibold ml-1">简介描述</label>
                                            <textarea
                                                value={preset.description || ""}
                                                onChange={(e) => updatePreset(preset.id, { description: e.target.value })}
                                                placeholder="在这个预设的描述..."
                                                rows={2}
                                                className="ui-textarea resize-none"
                                            />
                                        </div>

                                        {/* Collapsible: 生成参数 */}
                                        <div className="ui-collapsible">
                                            <div
                                                onClick={() => setParamsOpen(!paramsOpen)}
                                                className="ui-collapsible-header flex justify-between items-center select-none"
                                                data-open={paramsOpen}
                                            >
                                                <span className="menu-label ts-13 font-semibold">生成参数</span>
                                                <div className="generation-parameter-header-actions">
                                                    <button
                                                        type="button"
                                                        className="generation-parameter-picker-btn"
                                                        aria-label="选择发送的生成参数"
                                                        title="选择发送的生成参数"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            setParameterPickerOpen(true);
                                                        }}
                                                    >
                                                        <MoreHorizontal size={18} />
                                                    </button>
                                                    <ChevronDown size={16} className="text-[var(--c-text)]" style={{ transition: "transform 0.2s", transform: paramsOpen ? "rotate(180deg)" : "rotate(0deg)" }} />
                                                </div>
                                            </div>
                                            {paramsOpen && (
                                                <div className="p-[14px]">
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <div className="generation-parameter-control flex flex-col gap-1" data-disabled={enabledGenerationParameters.has("temperature") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Temperature</label>
                                                                <span className="ui-slider-value">{preset.temperature.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="2" step="any" value={preset.temperature} disabled={!enabledGenerationParameters.has("temperature")} onChange={(e) => updatePreset(preset.id, { temperature: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">稳定保守</span>
                                                                <span className="ui-slider-hint">发散创造</span>
                                                            </div>
                                                        </div>

                                                        <div className="generation-parameter-control flex flex-col gap-1" data-disabled={enabledGenerationParameters.has("top_p") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Top P</label>
                                                                <span className="ui-slider-value">{preset.top_p.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="1" step="any" value={preset.top_p} disabled={!enabledGenerationParameters.has("top_p")} onChange={(e) => updatePreset(preset.id, { top_p: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">用词精准</span>
                                                                <span className="ui-slider-hint">词汇丰富</span>
                                                            </div>
                                                        </div>

                                                        <div className="generation-parameter-control flex flex-col gap-1" data-disabled={enabledGenerationParameters.has("top_k") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Top K</label>
                                                                <span className="ui-slider-value">{preset.top_k}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="100" step="1" value={preset.top_k} disabled={!enabledGenerationParameters.has("top_k")} onChange={(e) => updatePreset(preset.id, { top_k: parseInt(e.target.value) })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">用词精准</span>
                                                                <span className="ui-slider-hint">词汇丰富</span>
                                                            </div>
                                                        </div>

                                                        <div className="generation-parameter-control flex flex-col gap-1" data-disabled={enabledGenerationParameters.has("min_p") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Min P</label>
                                                                <span className="ui-slider-value">{(preset.min_p || 0).toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="1" step="any" value={preset.min_p || 0} disabled={!enabledGenerationParameters.has("min_p")} onChange={(e) => updatePreset(preset.id, { min_p: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">发散跳跃</span>
                                                                <span className="ui-slider-hint">逻辑连贯</span>
                                                            </div>
                                                        </div>

                                                        <div className="generation-parameter-control flex flex-col gap-1" data-disabled={enabledGenerationParameters.has("top_a") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Top A</label>
                                                                <span className="ui-slider-value">{(preset.top_a || 0).toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="1" step="any" value={preset.top_a || 0} disabled={!enabledGenerationParameters.has("top_a")} onChange={(e) => updatePreset(preset.id, { top_a: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">自由发散</span>
                                                                <span className="ui-slider-hint">限制胡言乱语</span>
                                                            </div>
                                                        </div>

                                                        <div className="generation-parameter-control flex flex-col gap-1" data-disabled={enabledGenerationParameters.has("repetition_penalty") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Repetition Penalty</label>
                                                                <span className="ui-slider-value">{preset.repetition_penalty.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="1" max="2" step="any" value={preset.repetition_penalty} disabled={!enabledGenerationParameters.has("repetition_penalty")} onChange={(e) => updatePreset(preset.id, { repetition_penalty: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">允许重复</span>
                                                                <span className="ui-slider-hint">极力惩罚重复</span>
                                                            </div>
                                                        </div>

                                                        <div className="generation-parameter-control flex flex-col gap-1" data-disabled={enabledGenerationParameters.has("frequency_penalty") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Frequency Penalty</label>
                                                                <span className="ui-slider-value">{preset.frequency_penalty.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="2" step="any" value={preset.frequency_penalty} disabled={!enabledGenerationParameters.has("frequency_penalty")} onChange={(e) => updatePreset(preset.id, { frequency_penalty: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">自然口癖</span>
                                                                <span className="ui-slider-hint">杜绝车轱辘话</span>
                                                            </div>
                                                        </div>

                                                        <div className="generation-parameter-control flex flex-col gap-1" data-disabled={enabledGenerationParameters.has("presence_penalty") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Presence Penalty</label>
                                                                <span className="ui-slider-value">{preset.presence_penalty.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="2" step="any" value={preset.presence_penalty} disabled={!enabledGenerationParameters.has("presence_penalty")} onChange={(e) => updatePreset(preset.id, { presence_penalty: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">聚焦当前话题</span>
                                                                <span className="ui-slider-hint">积极拓展新话题</span>
                                                            </div>
                                                        </div>

                                                        <div className="generation-parameter-control flex flex-col gap-1 col-span-full" data-disabled={enabledGenerationParameters.has("max_tokens") ? undefined : ""}>
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Max Tokens</label>
                                                                <span className="ui-slider-value">{preset.openai_max_tokens || "自动"}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="8192" step="128" value={preset.openai_max_tokens} disabled={!enabledGenerationParameters.has("max_tokens")} onChange={(e) => updatePreset(preset.id, { openai_max_tokens: parseInt(e.target.value) })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">自动 (推荐)</span>
                                                                <span className="ui-slider-hint">限制回复长度</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-2 col-span-full">
                                                            <label className="ui-slider-label">剧情/线下模式摘要字段</label>
                                                            <input
                                                                type="text"
                                                                value={preset.story_summary_tag || "summary"}
                                                                onChange={(e) => updatePreset(preset.id, { story_summary_tag: e.target.value })}
                                                                placeholder="summary"
                                                                className="ui-input"
                                                            />
                                                            <div className="ui-slider-hint">
                                                                用于从剧情模式和聊天线下模式的原始 XML 输出中提取事件摘要字段名。默认读取 {"<summary>"}。
                                                            </div>
                                                        </div>
                                                        <div className="flex flex-col gap-2 col-span-full">
                                                            <label className="ui-slider-label">剧情/线下模式思维链字段</label>
                                                            <input
                                                                type="text"
                                                                value={preset.thinking_tag || "thinking"}
                                                                onChange={(e) => updatePreset(preset.id, { thinking_tag: e.target.value })}
                                                                placeholder="thinking"
                                                                className="ui-input"
                                                            />
                                                            <div className="ui-slider-hint">
                                                                从线下模式原始 XML 中提取思考过程（思维链）的字段名。仅当下方「线下思维链解析」开启时生效；关闭时走模型原生思维链。
                                                            </div>
                                                        </div>
                                                        <div className="flex flex-col gap-2 col-span-full">
                                                            <label className="ui-slider-label">线上模式思维链字段</label>
                                                            <input
                                                                type="text"
                                                                value={preset.online_thinking_tag || "thinking"}
                                                                onChange={(e) => updatePreset(preset.id, { online_thinking_tag: e.target.value })}
                                                                placeholder="thinking"
                                                                className="ui-input"
                                                            />
                                                            <div className="ui-slider-hint">
                                                                从线上模式 AI 输出中提取思考过程（思维链）的标签字段名。仅当下方「线上思维链解析」开启时生效；关闭时走模型原生思维链。
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-3 col-span-full">
                                                            <div className="flex flex-col gap-1">
                                                                <label className="ui-slider-label">线上思维链解析</label>
                                                                <span className="ui-slider-hint">开启后按上方标签字段解析线上思维链；关闭走模型原生思维链（官方默认）</span>
                                                            </div>
                                                            <label className="ui-mini-toggle" onClick={(e) => e.stopPropagation()}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={preset.online_thinking_enabled === true}
                                                                    onChange={(e) => updatePreset(preset.id, { online_thinking_enabled: e.target.checked })}
                                                                />
                                                            </label>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-3 col-span-full">
                                                            <div className="flex flex-col gap-1">
                                                                <label className="ui-slider-label">线下思维链解析</label>
                                                                <span className="ui-slider-hint">开启后按「剧情/线下模式思维链字段」解析线下思维链；关闭走模型原生思维链（官方默认）</span>
                                                            </div>
                                                            <label className="ui-mini-toggle" onClick={(e) => e.stopPropagation()}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={preset.offline_thinking_enabled === true}
                                                                    onChange={(e) => updatePreset(preset.id, { offline_thinking_enabled: e.target.checked })}
                                                                />
                                                            </label>
                                                        </div>
                                                        <div className="flex flex-col gap-2 col-span-full">
                                                            <label className="ui-slider-label">剔除文本（一行一个）</label>
                                                            <textarea
                                                                rows={3}
                                                                value={(preset.strip_texts || []).join("\n")}
                                                                onChange={(e) => updatePreset(preset.id, {
                                                                    strip_texts: e.target.value.split("\n").map(s => s.trim()).filter(Boolean),
                                                                })}
                                                                placeholder={"<思考结束>\n</思考结束>"}
                                                                className="ui-input"
                                                            />
                                                            <div className="ui-slider-hint">
                                                                模型回复中出现这些文本时直接删除，不进入消息、不进入发给模型的记录（如思维链残留标签）。字面量删除，不走正则。
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                </div>

                                {/* Prompts Section */}
                                <div className="flex flex-col gap-4 mt-3">
                                    <div className="mx-2 mb-0 mt-2 flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <h2 className="ts-20 font-bold leading-none text-black">Prompt Entries ({preset.prompts?.length || 0})</h2>
                                            <button
                                                type="button"
                                                onClick={() => setAppFilterOpen(true)}
                                                className={`inline-flex h-8 items-center justify-center gap-1 rounded-full border px-3 text-xs font-bold shadow-sm transition-all active:scale-95 ${appFilterTags.size > 0 || appFilterMode !== "highlight" ? "border-[var(--c-icon-active)] bg-[var(--c-icon-active)] text-white" : "border-black/10 bg-white text-gray-800 hover:bg-gray-50"}`}
                                            >
                                                <Filter size={14} strokeWidth={1.8} />
                                                <span>按 App{appFilterTags.size > 0 ? ` · ${appFilterTags.size} 个` : ""}</span>
                                            </button>
                                        </div>
                                        {!selectMode && (
                                            <button
                                                type="button"
                                                onClick={enterSelectMode}
                                                className="inline-flex h-8 items-center justify-center gap-1 rounded-full border border-black/10 bg-white px-3 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 active:scale-95"
                                            >
                                                <CheckSquare size={14} strokeWidth={1.8} />
                                                <span>多选</span>
                                            </button>
                                        )}
                                    </div>

                                    {selectMode && (
                                        <div className="multi-select-float-bar">
                                            <div className="msfb-main">
                                                <span className="msfb-count">已选 {actionableSelectedIds.size} 项</span>
                                                <button type="button" className="msfb-btn" onClick={selectAllPrompts}>
                                                    <CheckSquare size={15} strokeWidth={1.8} />
                                                    <span>全选可见</span>
                                                </button>
                                                <button type="button" className="msfb-btn" onClick={() => bulkSetEnabled(true)} disabled={actionableSelectedIds.size === 0}>
                                                    <Check size={15} strokeWidth={2} />
                                                    <span>启用</span>
                                                </button>
                                                <button type="button" className="msfb-btn" onClick={() => bulkSetEnabled(false)} disabled={actionableSelectedIds.size === 0}>
                                                    <RotateCcw size={15} strokeWidth={1.8} />
                                                    <span>禁用</span>
                                                </button>
                                                <button type="button" className="msfb-btn" onClick={() => bulkExportSelected()} disabled={actionableSelectedIds.size === 0}>
                                                    <Download size={15} strokeWidth={1.8} />
                                                    <span>导出</span>
                                                </button>
                                                <button type="button" className="msfb-btn msfb-danger" onClick={() => setConfirmDeleteSelected(true)} disabled={actionableSelectedIds.size === 0}>
                                                    <Trash2 size={15} strokeWidth={1.8} />
                                                    <span>删除</span>
                                                </button>
                                            </div>
                                            <div className="msfb-actions">
                                                <button type="button" className="msfb-btn msfb-done" onClick={exitSelectMode}>
                                                    <Check size={15} strokeWidth={2} />
                                                    <span>完成</span>
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    <div ref={promptListRef} className="flex flex-col gap-2"
                                        onTouchMove={onPromptTouchMove}
                                        onTouchEnd={onPromptTouchEnd}
                                        onTouchCancel={onPromptTouchEnd}
                                    >
                                        {promptRenderItems.flatMap((renderItem, _flatIndex) => {
                                            const toggleExpand = (gKey: string) => {
                                                setExpandedCollapseGroups(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(gKey)) next.delete(gKey);
                                                    else next.add(gKey);
                                                    return next;
                                                });
                                            };

                                            if (renderItem.type === "collapse-header") {
                                                return [
                                                    <div key={`collapse-header-${renderItem.groupKey}`} className="ui-entry-card ui-entry-collapsed-group" data-app-match="1" onClick={() => toggleExpand(renderItem.groupKey)}>
                                                        <div className="flex items-center justify-between cursor-pointer">
                                                            <div className="flex items-center gap-2">
                                                                <ChevronDown size={16} />
                                                                <span className="text-xs font-bold text-gray-800">{renderItem.label}</span>
                                                                <span className="menu-desc ts-11">· {renderItem.count} 个条目</span>
                                                            </div>
                                                            <span className="menu-desc ts-11">点击收起</span>
                                                        </div>
                                                    </div>,
                                                ];
                                            }

                                            if (renderItem.type === "collapsed") {
                                                return [
                                                    <div key={`collapsed-${renderItem.groupKey}`} className="ui-entry-card ui-entry-collapsed-group" data-app-match="1" onClick={() => toggleExpand(renderItem.groupKey)}>
                                                        <div className="flex items-center justify-between cursor-pointer">
                                                            <div className="flex items-center gap-2">
                                                                <ChevronDown size={16} style={{ transform: "rotate(-90deg)" }} />
                                                                <span className="text-xs font-bold text-gray-800">{renderItem.label}</span>
                                                                <span className="menu-desc ts-11">· {renderItem.prompts.length} 个条目已折叠</span>
                                                            </div>
                                                            <span className="menu-desc ts-11">点击展开</span>
                                                        </div>
                                                    </div>,
                                                ];
                                            }
                                            const prompt = renderItem.prompt;
                                            const isEditing = editingPromptId === prompt.identifier;
                                            const isPromptSelected = selectionPresetId === editingId && selectedIds.has(prompt.identifier);
                                            // Effective enabled: prompt_order overrides prompt.enabled
                                            const effectiveEnabled = preset.prompt_order
                                                ? (preset.prompt_order.find(e => e.identifier === prompt.identifier)?.enabled ?? prompt.enabled)
                                                : prompt.enabled;
                                            const promptTags = getPromptTags(prompt);
                                            const matchedTagGroup = findTagGroupForTags(tagGroups, promptTags);
                                            const isCustomPromptTags = promptTags.length > 0 && !matchedTagGroup;
                                            const selectedTagGroup = matchedTagGroup ?? tagGroups[0];
                                            const selectedTagMinor = matchedTagGroup ? getPromptTagMinor(prompt, selectedTagGroup) : selectedTagGroup.minors[0];

                                            return (
                                                <SwipeActionRow
                                                    key={prompt.identifier}
                                                    controller={swipe}
                                                    id={prompt.identifier}
                                                    disabled={isEditing}
                                                    leftSwipeDisabled={selectMode}
                                                    rightSwipeEnabled
                                                    onSwipeRight={() => handleSwipeRightSelect(prompt.identifier)}
                                                    onTouchStart={isEditing ? undefined : (e) => onPromptTouchStart(_flatIndex, e)}
                                                    actions={selectMode ? null : (
                                                        <>
                                                            <button
                                                                type="button"
                                                                className="ui-swipe-action"
                                                                data-variant="insert"
                                                                onClick={() => insertPromptAfter(preset, prompt.identifier)}
                                                            >
                                                                <Plus size={18} strokeWidth={2} />
                                                                <span>新增</span>
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="ui-swipe-action"
                                                                data-variant="replace"
                                                                onClick={() => {
                                                                    entryImportModeRef.current = { mode: "replace", identifier: prompt.identifier };
                                                                    entryFileInputRef.current?.click();
                                                                    swipe.close();
                                                                }}
                                                            >
                                                                <Replace size={18} strokeWidth={2} />
                                                                <span>替换</span>
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="ui-swipe-action"
                                                                data-variant="export"
                                                                onClick={() => {
                                                                    exportPrompt(prompt);
                                                                    swipe.close();
                                                                }}
                                                            >
                                                                <Download size={18} strokeWidth={2} />
                                                                <span>导出</span>
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="ui-swipe-action"
                                                                data-variant="delete"
                                                                onClick={() => {
                                                                    setConfirmDeleteEntry(prompt.identifier);
                                                                    swipe.close();
                                                                }}
                                                            >
                                                                <Trash2 size={18} strokeWidth={2} />
                                                                <span>删除</span>
                                                            </button>
                                                        </>)
                                                    }
                                                >
                                                    <div
                                                    className="ui-entry-card"
                                                    data-active={isEditing}
                                                    data-selected={selectMode && isPromptSelected ? "true" : undefined}
                                                    data-disabled={!effectiveEnabled}
                                                    data-app-match={(() => {
                                                        if (appFilterTags.size === 0) return undefined;
                                                        if (appFilterMode === "only-show") return undefined;
                                                        return matchesSelectedAppTags(prompt, appFilterTags) ? "1" : "0";
                                                    })()}
                                                    style={{
                                                        gap: isEditing ? "12px" : "0px",
                                                        userSelect: isEditing ? undefined : "none",
                                                        WebkitUserSelect: isEditing ? undefined : "none",
                                                    }}
                                                >
                                                    {/* Summary Row */}
                                                    <div
                                                        onClick={() => {
                                                            if (swipe.consumeClickSuppression()) return;
                                                            if (swipe.openId || swipe.swipingId) {
                                                                swipe.close();
                                                                return;
                                                            }
                                                            if (selectMode) {
                                                                toggleSelect(prompt.identifier);
                                                                return;
                                                            }
                                                            setEditingPromptId(isEditing ? null : prompt.identifier);
                                                        }}
                                                        className="flex justify-between items-start gap-2 cursor-pointer"
                                                    >
                                                        <div className="flex gap-3 flex-1 min-w-0 items-start" style={{ cursor: isEditing ? "default" : "grab" }}>
                                                            {selectMode ? (
                                                                <div
                                                                    className="mt-[2px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2"
                                                                    style={{
                                                                        borderColor: isPromptSelected ? "var(--c-icon-active)" : "rgba(0,0,0,0.25)",
                                                                        background: isPromptSelected ? "var(--c-icon-active)" : "transparent",
                                                                        color: "#fff",
                                                                    }}
                                                                >
                                                                    {isPromptSelected && <Check size={13} strokeWidth={3} />}
                                                                </div>
                                                            ) : (
                                                                <div className="ui-entry-icon mt-[2px]">
                                                                    <MessageSquare size={20} />
                                                                </div>
                                                            )}
                                                            <div className="flex flex-col gap-1 flex-1">
                                                                <div className="flex items-center gap-[6px]">
                                                                    {/* Drag Handle shown subtly */}
                                                                    <GripVertical size={14} className="text-[var(--c-text)]" style={{ opacity: isEditing ? 0 : 0.5 }} />
                                                                    <span className="menu-label ts-15 font-semibold break-all">
                                                                        {prompt.name || "未命名提示词"}
                                                                    </span>
                                                                </div>
                                                                {!isEditing && (
                                                                    <div className="ts-12 flex items-center gap-[6px] flex-wrap mt-[2px]">
                                                                        {prompt.marker && (
                                                                            <span className="ui-status-tag" data-variant="warning">
                                                                                Marker
                                                                            </span>
                                                                        )}
                                                                        {!prompt.marker && (
                                                                            <>
                                                                                {/* Feature tag badge */}
                                                                                <span className="ui-status-tag" data-variant={getPromptTags(prompt).length > 0 ? "success" : undefined}>
                                                                                    {getPromptTagsLabel(prompt, tagProfiles)}
                                                                                </span>
                                                                            </>
                                                                        )}
                                                                        {/* System/User badge — shown for all entries */}
                                                                        <span className="ui-status-tag">
                                                                            {prompt.role === "system" ? "系统 (System)" : prompt.role === "assistant" ? "助手 (Assistant)" : "用户 (User)"}
                                                                        </span>
                                                                        {!prompt.marker && (
                                                                            /* Depth badge — only for non-marker entries */
                                                                            <span className="ui-status-tag" data-variant="action">
                                                                                深度: {prompt.injection_depth}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-3 shrink-0 mt-[2px]">
                                                            {/* Custom iOS-style Switch */}
                                                            <label
                                                                className="ui-mini-toggle"
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                <input
                                                                    type="checkbox"
                                                                    checked={effectiveEnabled}
                                                                    onChange={(e) => {
                                                                        const checked = e.target.checked;
                                                                        let newOrder = preset.prompt_order;
                                                                        if (newOrder) {
                                                                            newOrder = newOrder.map(entry =>
                                                                                entry.identifier === prompt.identifier
                                                                                    ? { ...entry, enabled: checked }
                                                                                    : entry
                                                                            );
                                                                        }
                                                                        updatePrompt(
                                                                            preset,
                                                                            prompt.identifier,
                                                                            current => ({ ...current, enabled: checked }),
                                                                            { prompt_order: newOrder },
                                                                        );
                                                                    }}
                                                                    className="ui-mini-toggle-track"
                                                                />
                                                                <span className="ui-mini-toggle-thumb" />
                                                            </label>
                                                        </div>
                                                    </div>

                                                    {/* Detail Expanded Content */}
                                                    {isEditing && (
                                                        <div className="ui-entry-separator flex flex-col gap-3">
                                                            <div className="flex justify-between items-start gap-2">
                                                                <AutoResizeTextarea
                                                                    value={prompt.name}
                                                                    onChange={(e) => {
                                                                        const nextName = e.target.value;
                                                                        // 名称命中 marker 固定名时自动补齐 identifier + marker（与桌宠填表同逻辑）
                                                                        const markerId = matchMarkerByName(nextName);
                                                                        if (
                                                                            markerId
                                                                            && markerId !== prompt.identifier
                                                                            && !preset.prompts.some(p => p.identifier === markerId)
                                                                        ) {
                                                                            const newOrder = preset.prompt_order?.map(entry =>
                                                                                entry.identifier === prompt.identifier
                                                                                    ? { ...entry, identifier: markerId }
                                                                                    : entry
                                                                            );
                                                                            updatePrompt(
                                                                                preset,
                                                                                prompt.identifier,
                                                                                current => ({
                                                                                    ...current,
                                                                                    name: nextName,
                                                                                    identifier: markerId,
                                                                                    marker: true,
                                                                                    content: "",
                                                                                    injection_depth: 0,
                                                                                }),
                                                                                newOrder ? { prompt_order: newOrder } : {},
                                                                            );
                                                                            setEditingPromptId(markerId);
                                                                            return;
                                                                        }
                                                                        updatePrompt(
                                                                            preset,
                                                                            prompt.identifier,
                                                                            current => ({ ...current, name: nextName }),
                                                                        );
                                                                    }}
                                                                    placeholder="提示词名称 (例如: 主力 Prompt)"
                                                                    rows={1}
                                                                    className="border-none bg-transparent ts-16 font-semibold outline-none flex-1 min-w-0 font-[inherit] py-1 px-0 text-[var(--c-text)]"
                                                                />
                                                            </div>
                                                            {!prompt.marker && (
                                                            <div className="relative">
                                                                <textarea
                                                                    value={prompt.content}
                                                                    onChange={(e) => {
                                                                        updatePrompt(
                                                                            preset,
                                                                            prompt.identifier,
                                                                            current => ({ ...current, content: e.target.value }),
                                                                        );
                                                                    }}
                                                                    placeholder="在此输入提示词内容..."
                                                                    rows={6}
                                                                    className="ui-textarea resize-y"
                                                                />
                                                                <button onClick={() => setExpandTarget({ identifier: prompt.identifier, field: "content" })} className="absolute top-2 right-2 bg-none border-none cursor-pointer p-0" style={{ color: "var(--c-icon)" }}><Maximize2 size={14} /></button>
                                                            </div>
                                                            )}
                                                            <div className="flex flex-col gap-3 p-[10px] rounded-lg bg-[var(--c-input)]">
                                                                {prompt.marker && (
                                                                    <div className="menu-desc ts-11">
                                                                        标记条目的位置由排序与「短期记忆」分界决定，Role 固定为 System——以下「注入方式 / Inject Depth / Role」对标记条目不生效
                                                                    </div>
                                                                )}
                                                                <div className="grid grid-cols-2 gap-3">
                                                                    <div className={`flex flex-col gap-1 min-w-0${prompt.marker ? " opacity-40 pointer-events-none" : ""}`}>
                                                                        <label className="menu-desc ts-11">注入方式</label>
                                                                        <select disabled={!!prompt.marker} value={(prompt.injection_position ?? 0) === 0 ? "0" : "1"} onChange={e => {
                                                                            updatePrompt(
                                                                                preset,
                                                                                prompt.identifier,
                                                                                current => ({ ...current, injection_position: parseInt(e.target.value) }),
                                                                            );
                                                                        }} className="ui-select ts-13 px-2 py-[6px] rounded-[6px]">
                                                                            <option value="0">跟随排序</option>
                                                                            <option value="1">插入聊天</option>
                                                                        </select>
                                                                    </div>
                                                                    <div className={`flex flex-col gap-1 min-w-0${prompt.marker ? " opacity-40 pointer-events-none" : ""}`}>
                                                                        <label className="menu-desc ts-11">Inject Depth</label>
                                                                        <input type="number" disabled={!!prompt.marker} value={prompt.injection_depth ?? 0} onChange={e => {
                                                                            updatePrompt(
                                                                                preset,
                                                                                prompt.identifier,
                                                                                current => ({ ...current, injection_depth: parseInt(e.target.value) || 0 }),
                                                                            );
                                                                        }} className="ui-input ts-13 px-2 py-[6px] rounded-[6px]" />
                                                                    </div>
                                                                </div>
                                                                <div className="grid grid-cols-2 gap-3">
                                                                    <div className={`flex flex-col gap-[2px] min-w-0${prompt.marker ? " opacity-40 pointer-events-none" : ""}`}>
                                                                        <label className="menu-desc ts-11 ml-[2px]">Role</label>
                                                                        <select
                                                                            disabled={!!prompt.marker}
                                                                            value={prompt.role}
                                                                            onChange={(e) => {
                                                                                updatePrompt(
                                                                                    preset,
                                                                                    prompt.identifier,
                                                                                    current => ({ ...current, role: e.target.value }),
                                                                                );
                                                                            }}
                                                                            className="ui-select ts-13 px-2 py-[6px] rounded-[6px]"
                                                                        >
                                                                            <option value="system">System</option>
                                                                            <option value="user">User</option>
                                                                            <option value="assistant">Assistant</option>
                                                                        </select>
                                                                    </div>
                                                                    <div className="flex flex-col gap-[2px] min-w-0">
                                                                        <label className="menu-desc ts-11 ml-[2px]">适用范围</label>
                                                                        <div className="grid grid-cols-2 gap-2">
                                                                            <select
                                                                                value={isCustomPromptTags ? "__custom__" : selectedTagGroup.id}
                                                                                onChange={(e) => {
                                                                                    const group = tagGroups.find(item => item.id === e.target.value);
                                                                                    const firstMinor = group?.minors[0];
                                                                                    if (!firstMinor) return;
                                                                                    updatePrompt(
                                                                                        preset,
                                                                                        prompt.identifier,
                                                                                        current => ({ ...current, ...setPromptTags(firstMinor.tags) }),
                                                                                    );
                                                                                }}
                                                                                className="ui-select ts-13 px-2 py-[6px] rounded-[6px]"
                                                                            >
                                                                                {isCustomPromptTags ? (
                                                                                    <option value="__custom__">自定义</option>
                                                                                ) : null}
                                                                                {tagGroups.map((group) => (
                                                                                    <option key={group.id} value={group.id}>{group.label}</option>
                                                                                ))}
                                                                            </select>
                                                                            <select
                                                                                value={isCustomPromptTags ? "__custom__" : selectedTagMinor.id}
                                                                                onChange={(e) => {
                                                                                    const minor = selectedTagGroup.minors.find(item => item.id === e.target.value);
                                                                                    if (!minor) return;
                                                                                    updatePrompt(
                                                                                        preset,
                                                                                        prompt.identifier,
                                                                                        current => ({ ...current, ...setPromptTags(minor.tags) }),
                                                                                    );
                                                                                }}
                                                                                className="ui-select ts-13 px-2 py-[6px] rounded-[6px]"
                                                                            >
                                                                                {isCustomPromptTags ? (
                                                                                    <option value="__custom__">自定义</option>
                                                                                ) : null}
                                                                                {selectedTagGroup.minors.map((minor) => (
                                                                                    <option key={minor.id} value={minor.id}>{minor.label}</option>
                                                                                ))}
                                                                            </select>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="flex gap-[10px] pt-1 flex-wrap items-center">
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={Boolean(prompt.marker)} onChange={e => {
                                                                        updatePrompt(
                                                                            preset,
                                                                            prompt.identifier,
                                                                            current => ({ ...current, marker: e.target.checked }),
                                                                        );
                                                                    }} />
                                                                    Marker
                                                                </label>
                                                                <span className="menu-desc ts-11 whitespace-nowrap">
                                                                    实际标签：{getPromptTagsInlineLabel(prompt)}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    )}
                                                    </div>
                                                </SwipeActionRow>
                                            );
                                        })}
                                        {(!preset.prompts || preset.prompts.length === 0) && (
                                            <div className="menu-desc text-center ts-13 p-3">
                                                空预设不会产生背景设定，请添加提示词条目。
                                            </div>
                                        )}
                                    </div>

                                    <button
                                        type="button"
                                        onClick={() => setAddEntryMenuOpen(true)}
                                        className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                                    >
                                        <Plus size={15} strokeWidth={1.8} />
                                        添加条目
                                    </button>
                                </div>
                            </div>
                        )
                    })}
                </>
            )}

            {confirmExportId && (() => {
                const targetPreset = presets.find(preset => preset.id === confirmExportId);
                if (!targetPreset) return null;
                return (
                    <ConfirmDialog
                        title="确认导出预设？"
                        message={`将导出“${targetPreset.name || "当前预设"}”为 JSON 文件。是否继续？`}
                        icon={Download}
                        variant="action"
                        confirmLabel="确认导出"
                        onConfirm={() => {
                            handleExport(targetPreset);
                            setConfirmExportId(null);
                        }}
                        onCancel={() => setConfirmExportId(null)}
                    />
                );
            })()}

            {confirmResetId && (() => {
                const targetPreset = presets.find(preset => preset.id === confirmResetId);
                if (!targetPreset) return null;
                return (
                    <ConfirmDialog
                        title="确认重置默认？"
                        message={`这会把“${targetPreset.name || "默认预设"}”恢复为出厂内容，当前修改会被覆盖。是否继续？`}
                        icon={RotateCcw}
                        variant="danger"
                        confirmLabel="确认重置"
                        onConfirm={() => {
                            resetBuiltinPreset();
                            setPresets(loadPresets());
                            setConfirmResetId(null);
                        }}
                        onCancel={() => setConfirmResetId(null)}
                    />
                );
            })()}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除预设后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    onConfirm={() => {
                        removePreset(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
            {/* Confirm delete entry dialog */}
            {confirmDeleteEntry !== null && editingId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除条目后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    onConfirm={() => {
                        const p = presets.find(x => x.id === editingId);
                        if (p) {
                            const removedId = confirmDeleteEntry;
                            const newPrompts = p.prompts.filter(prompt => prompt.identifier !== removedId);
                            const newOrder = (p.prompt_order || []).filter(o => o.identifier !== removedId);
                            updatePreset(p.id, { prompts: newPrompts, prompt_order: newOrder });
                            if (editingPromptId === removedId) setEditingPromptId(null);
                        }
                        setConfirmDeleteEntry(null);
                    }}
                    onCancel={() => setConfirmDeleteEntry(null)}
                />
            )}
            {/* Confirm bulk delete selected entries */}
            {confirmDeleteSelected && editingId && (
                <ConfirmDialog
                    title="确认批量删除？"
                    message={`将删除当前可见并已选中的 ${actionableSelectedIds.size} 个条目，删除后无法恢复。是否继续？`}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    onConfirm={() => deleteSelectedPrompts()}
                    onCancel={() => setConfirmDeleteSelected(false)}
                />
            )}

            {importError && (
                <ConfirmDialog
                    title="导入失败"
                    message={importError}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="知道了"
                    cancelLabel=""
                    onConfirm={() => setImportError(null)}
                    onCancel={() => setImportError(null)}
                />
            )}

            {addEntryMenuOpen && editingId && (() => {
                const preset = presets.find(p => p.id === editingId);
                if (!preset) return null;
                return (
                    <BottomSheet title="添加条目" onClose={() => setAddEntryMenuOpen(false)}>
                        <div className="flex flex-col gap-2">
                            <button
                                type="button"
                                className="ui-btn ui-btn-primary w-full"
                                onClick={() => {
                                    setAddEntryMenuOpen(false);
                                    createPromptAtEnd(preset);
                                }}
                            >
                                <Plus size={16} /> 直接创建
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline w-full"
                                onClick={() => {
                                    setAddEntryMenuOpen(false);
                                    entryImportModeRef.current = { mode: "append" };
                                    entryFileInputRef.current?.click();
                                }}
                            >
                                <Upload size={16} /> 从 JSON 文件导入
                            </button>
                        </div>
                    </BottomSheet>
                );
            })()}

            {parameterPickerOpen && activePreset && (
                <BottomSheet title="选择发送的参数" onClose={() => setParameterPickerOpen(false)}>
                    <div className="generation-parameter-picker">
                        <p className="menu-desc generation-parameter-picker-desc">
                            高亮参数允许随请求发送；未选择的参数会从请求中移除，并在设置中置灰。接口不适用的参数会自动忽略。
                        </p>
                        <div className="generation-parameter-chips" role="group" aria-label="选择发送的生成参数">
                            {GENERATION_PARAMETER_OPTIONS.map(option => {
                                const selected = resolveEnabledGenerationParameters(activePreset).has(option.key);
                                return (
                                    <button
                                        key={option.key}
                                        type="button"
                                        className="generation-parameter-chip"
                                        data-selected={selected ? "" : undefined}
                                        aria-pressed={selected}
                                        title={option.title}
                                        onClick={() => toggleGenerationParameter(activePreset, option.key)}
                                    >
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="ui-slider-hint generation-parameter-picker-note">
                            原生 Anthropic 接口要求 Max Tokens 必须存在；关闭后仍会使用安全默认值，其余接口会正常省略。
                        </p>
                    </div>
                </BottomSheet>
            )}

            {expandTarget && editingId && (() => {
                const preset = presets.find(p => p.id === editingId);
                const promptIdx = preset?.prompts.findIndex(p => p.identifier === expandTarget.identifier) ?? -1;
                const prompt = promptIdx >= 0 ? preset?.prompts[promptIdx] : undefined;
                if (!preset || !prompt || promptIdx < 0) return null;
                return (
                    <TextExpandModal
                        title={prompt.name || "编辑提示词"}
                        value={prompt.content}
                        onChange={(v) => {
                            const newPrompts = [...preset.prompts];
                            newPrompts[promptIdx] = { ...prompt, content: v };
                            updatePreset(preset.id, { prompts: newPrompts });
                        }}
                        placeholder="在此输入提示词内容..."
                        onClose={() => setExpandTarget(null)}
                    />
                );
            })()}

            {/* ── 按 App 筛选弹窗 ── */}
            {appFilterOpen && editingId && (() => {
                return (
                    <BottomSheet title="按 App 筛选条目" onClose={() => setAppFilterOpen(false)}>
                        <div className="flex flex-col gap-4">
                            {/* 选择 App 大类（可多选，不细分 minor / 起效范围） */}
                            <div>
                                <div className="menu-label ts-12 mb-2">选择 App{appFilterTags.size > 0 ? `（已选 ${appFilterTags.size} 个）` : "（可多选）"}</div>
                                <div className="flex flex-wrap gap-2">
                                    {tagGroups.map(g => {
                                        const tag = g.tags.length > 0 ? g.tags[0] : "__universal__";
                                        const selected = appFilterTags.has(tag);
                                        return (
                                            <button
                                                key={g.id}
                                                type="button"
                                                onClick={() => toggleFilterTag(tag)}
                                                className={`inline-flex items-center justify-center gap-1 rounded-full border px-3 py-1.5 text-xs font-bold transition-all active:scale-95 ${selected ? "border-[var(--c-icon-active)] bg-[var(--c-icon-active)] text-white" : "border-black/10 bg-white text-gray-800 hover:bg-gray-50"}`}
                                            >
                                                {g.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* 选择模式（再次点击折叠模式可退出） */}
                            <div>
                                <div className="menu-label ts-12 mb-2">操作模式</div>
                                <div className="flex flex-col gap-2">
                                    {([
                                        { id: "highlight", label: "高亮显示", desc: "匹配条目高亮，其它变暗" },
                                        { id: "only-show", label: "仅显示", desc: "只显示匹配条目，隐藏其它" },
                                        { id: "collapse", label: "仅折叠", desc: "相邻同类条目折叠为摘要，可点击展开/收起；再次点击退出折叠" },
                                        { id: "group-collapse", label: "同类折叠", desc: "所有同类条目折叠成一组（不管分散在哪）；再次点击退出折叠" },
                                    ] as const).map(opt => {
                                        const isActive = appFilterMode === opt.id;
                                        return (
                                            <button
                                                key={opt.id}
                                                type="button"
                                                onClick={() => {
                                                    if (isActive && (opt.id === "collapse" || opt.id === "group-collapse")) {
                                                        // 再次点击折叠模式 → 退出折叠（回到高亮，保留 App 选中用于高亮/仅显示）
                                                        setAppFilterMode("highlight");
                                                        setExpandedCollapseGroups(new Set());
                                                    } else {
                                                        setAppFilterMode(opt.id);
                                                    }
                                                }}
                                                className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-all active:scale-[0.98] ${isActive ? "border-[var(--c-icon-active)] bg-[var(--c-icon-active)]/5" : "border-black/10 bg-white hover:bg-gray-50"}`}
                                            >
                                                <div className="flex flex-col gap-0.5">
                                                    <span className="text-xs font-bold text-gray-800">{opt.label}</span>
                                                    <span className="menu-desc ts-11">{opt.desc}</span>
                                                </div>
                                                <div className={`h-4 w-4 rounded-full border-2 ${isActive ? "border-[var(--c-icon-active)] bg-[var(--c-icon-active)]" : "border-gray-300"}`} />
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* 清除按钮 */}
                            {(appFilterTags.size > 0 || appFilterMode !== "highlight") && (
                                <button
                                    type="button"
                                    onClick={() => { setAppFilterTags(new Set()); setAppFilterMode("highlight"); setExpandedCollapseGroups(new Set()); }}
                                    className="ui-btn w-full"
                                >
                                    清除筛选
                                </button>
                            )}
                        </div>
                    </BottomSheet>
                );
            })()}
        </div>
    );
}
