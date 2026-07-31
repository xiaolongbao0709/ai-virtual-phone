"use client";

import { useState, useEffect, useRef, useContext, useCallback, useMemo } from "react";
import { Plus, Upload, Download, Trash2, RotateCcw, ChevronLeft, ChevronDown, GripVertical, MessageSquare, AlertCircle, Maximize2, Copy, Replace } from "lucide-react";
import {
    loadPresets,
    savePresets,
    createPreset,
    parsePresetFromJson,
    resetBuiltinPreset,
    UNSUPPORTED_IMPORT_FORMAT,
} from "@/lib/settings-storage";
import type { PresetConfig, Prompt, PromptOrderEntry } from "@/lib/settings-types";
import {
    areTagsEqual,
    CONTENT_SCOPE_TAG_GROUPS,
    getPromptTags as getScopedPromptTags,
    getTagsLabel,
    resolveContentTagLabel,
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
    const [expandTarget, setExpandTarget] = useState<{ identifier: string; field: string } | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [customApps, setCustomApps] = useState<InstalledCustomApp[]>([]);

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
    const handlePromptReorder = useCallback((fromIndex: number, toIndex: number) => {
        if (!editingId) return;
        const preset = presets.find(p => p.id === editingId);
        if (!preset) return;
        // Build full display list (same logic as render: ordered + orphans)
        const ordered = preset.prompt_order && preset.prompt_order.length > 0
            ? preset.prompt_order.map(e => preset.prompts.find(p => p.identifier === e.identifier)).filter((p): p is Prompt => !!p)
            : [...preset.prompts];
        const orderedIds = new Set(ordered.map(p => p.identifier));
        const orphans = preset.prompts.filter(p => !orderedIds.has(p.identifier));
        const displayed = [...ordered, ...orphans];
        // Reorder
        const [item] = displayed.splice(fromIndex, 1);
        displayed.splice(toIndex, 0, item);
        const newOrder = displayed.map(p => ({
            identifier: p.identifier,
            enabled: preset.prompt_order
                ? (preset.prompt_order.find(o => o.identifier === p.identifier)?.enabled ?? p.enabled)
                : p.enabled,
        }));
        updatePreset(preset.id, { prompts: displayed, prompt_order: newOrder });
    }, [editingId, presets]);

    const { containerRef: promptListRef, onTouchStart: onPromptTouchStart, onTouchMove: onPromptTouchMove, onTouchEnd: onPromptTouchEnd } = useTouchSort(handlePromptReorder);

    // ── 条目左滑操作（微信式：左滑露出「新增/删除」） ──
    const swipe = useSwipeActions();

    const insertPromptAfter = (preset: PresetConfig, afterIdentifier: string) => {
        const newPrompt = {
            identifier: `prompt-${Date.now()}`,
            name: "新提示词",
            role: "system" as const,
            content: "",
            injection_depth: 0,
            enabled: true,
        };
        // 与渲染一致的显示顺序（prompt_order + 孤儿条目）
        const ordered = preset.prompt_order && preset.prompt_order.length > 0
            ? preset.prompt_order.map(entry => preset.prompts.find(p => p.identifier === entry.identifier)).filter((p): p is Prompt => !!p)
            : [...(preset.prompts || [])];
        const orderedIds = new Set(ordered.map(p => p.identifier));
        const orphans = (preset.prompts || []).filter(p => !orderedIds.has(p.identifier));
        const displayed = [...ordered, ...orphans];
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
        updatePreset(preset.id, { prompts: displayed, prompt_order: newOrder });
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
                                        <button
                                            type="button"
                                            onClick={() => setConfirmDeleteId(preset.id)}
                                            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-[var(--c-danger)] shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95"
                                        >
                                            <Trash2 size={15} strokeWidth={1.8} />
                                            <span>删除预设</span>
                                        </button>
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
                                                <ChevronDown size={16} className="text-[var(--c-text)]" style={{ transition: "transform 0.2s", transform: paramsOpen ? "rotate(180deg)" : "rotate(0deg)" }} />
                                            </div>
                                            {paramsOpen && (
                                                <div className="p-[14px]">
                                                    <div className="grid grid-cols-2 gap-3">
                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Temperature</label>
                                                                <span className="ui-slider-value">{preset.temperature.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="2" step="any" value={preset.temperature} onChange={(e) => updatePreset(preset.id, { temperature: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">稳定保守</span>
                                                                <span className="ui-slider-hint">发散创造</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Top P</label>
                                                                <span className="ui-slider-value">{preset.top_p.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="1" step="any" value={preset.top_p} onChange={(e) => updatePreset(preset.id, { top_p: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">用词精准</span>
                                                                <span className="ui-slider-hint">词汇丰富</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Top K</label>
                                                                <span className="ui-slider-value">{preset.top_k}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="100" step="1" value={preset.top_k} onChange={(e) => updatePreset(preset.id, { top_k: parseInt(e.target.value) })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">用词精准</span>
                                                                <span className="ui-slider-hint">词汇丰富</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Min P</label>
                                                                <span className="ui-slider-value">{(preset.min_p || 0).toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="1" step="any" value={preset.min_p || 0} onChange={(e) => updatePreset(preset.id, { min_p: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">发散跳跃</span>
                                                                <span className="ui-slider-hint">逻辑连贯</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Top A</label>
                                                                <span className="ui-slider-value">{(preset.top_a || 0).toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="1" step="any" value={preset.top_a || 0} onChange={(e) => updatePreset(preset.id, { top_a: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">自由发散</span>
                                                                <span className="ui-slider-hint">限制胡言乱语</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Repetition Penalty</label>
                                                                <span className="ui-slider-value">{preset.repetition_penalty.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="1" max="2" step="any" value={preset.repetition_penalty} onChange={(e) => updatePreset(preset.id, { repetition_penalty: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">允许重复</span>
                                                                <span className="ui-slider-hint">极力惩罚重复</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Frequency Penalty</label>
                                                                <span className="ui-slider-value">{preset.frequency_penalty.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="2" step="any" value={preset.frequency_penalty} onChange={(e) => updatePreset(preset.id, { frequency_penalty: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">自然口癖</span>
                                                                <span className="ui-slider-hint">杜绝车轱辘话</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Presence Penalty</label>
                                                                <span className="ui-slider-value">{preset.presence_penalty.toFixed(2)}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="2" step="any" value={preset.presence_penalty} onChange={(e) => updatePreset(preset.id, { presence_penalty: Math.round(parseFloat(e.target.value) * 100) / 100 })} />
                                                            <div className="ui-slider-hints">
                                                                <span className="ui-slider-hint">聚焦当前话题</span>
                                                                <span className="ui-slider-hint">积极拓展新话题</span>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1 col-span-full">
                                                            <div className="flex justify-between">
                                                                <label className="ui-slider-label">Max Tokens</label>
                                                                <span className="ui-slider-value">{preset.openai_max_tokens || "自动"}</span>
                                                            </div>
                                                            <input className="ui-slider" type="range" min="0" max="8192" step="128" value={preset.openai_max_tokens} onChange={(e) => updatePreset(preset.id, { openai_max_tokens: parseInt(e.target.value) })} />
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
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                </div>

                                {/* Prompts Section */}
                                <div className="flex flex-col gap-4 mt-3">
                                    <h2 className="mx-2 mb-0 mt-2 ts-20 font-bold leading-none text-black">Prompt Entries ({preset.prompts?.length || 0})</h2>

                                    <div ref={promptListRef} className="flex flex-col gap-2"
                                        onTouchMove={onPromptTouchMove}
                                        onTouchEnd={onPromptTouchEnd}
                                        onTouchCancel={onPromptTouchEnd}
                                    >
                                        {(() => {
                                            // Display prompts in prompt_order sequence
                                            const orderedPrompts = preset.prompt_order && preset.prompt_order.length > 0
                                                ? preset.prompt_order
                                                    .map(entry => preset.prompts.find(p => p.identifier === entry.identifier))
                                                    .filter((p): p is Prompt => !!p)
                                                : preset.prompts || [];
                                            // Append any prompts not in prompt_order (orphans)
                                            const orderedIds = new Set(orderedPrompts.map(p => p.identifier));
                                            const orphans = (preset.prompts || []).filter(p => !orderedIds.has(p.identifier));
                                            return [...orderedPrompts, ...orphans];
                                        })().map((prompt, index) => {
                                            const isEditing = editingPromptId === prompt.identifier;
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
                                                    onTouchStart={isEditing ? undefined : (e) => onPromptTouchStart(index, e)}
                                                    actions={
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
                                                        </>
                                                    }
                                                >
                                                    <div
                                                    className="ui-entry-card"
                                                    data-active={isEditing}
                                                    data-disabled={!effectiveEnabled}
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
                                                            setEditingPromptId(isEditing ? null : prompt.identifier);
                                                        }}
                                                        className="flex justify-between items-start gap-2 cursor-pointer"
                                                    >
                                                        <div className="flex gap-3 flex-1 min-w-0 items-start" style={{ cursor: isEditing ? "default" : "grab" }}>
                                                            <div className="ui-entry-icon mt-[2px]">
                                                                <MessageSquare size={20} />
                                                            </div>
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
        </div>
    );
}
