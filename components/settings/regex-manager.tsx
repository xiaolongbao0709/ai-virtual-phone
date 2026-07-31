"use client";

import { useState, useEffect, useRef, useContext, useCallback, useMemo } from "react";
import { Plus, Trash2, Download, Database, Play, Upload, ChevronLeft, AlertCircle, Maximize2, X, Replace } from "lucide-react";
import {
    loadRegexes,
    saveRegexes,
    createRegexGroup,
    parseRegexFromJson,
    UNSUPPORTED_IMPORT_FORMAT,
} from "@/lib/settings-storage";
import type { RegexConfig, RegexRule } from "@/lib/settings-types";
import { testRegexRule } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";
import { areTagsEqual, getTagProfileId, getTagsLabel, type TagProfile } from "@/lib/content-tag-utils";
import { buildCustomAppTagGroups, flattenTagGroups } from "@/lib/custom-app-tag-profiles";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps } from "@/lib/custom-app-storage";
import type { InstalledCustomApp } from "@/lib/custom-app-types";
import { SettingsContext } from "../phone-settings-app";
import { BottomSheet, ConfirmDialog, TextExpandModal } from "@/components/ui/modal";
import { SwipeActionRow, useSwipeActions } from "@/components/ui/swipe-actions";
import { notifyMascotPageContext } from "@/lib/mascot-events";

function getRuleTags(rule: Pick<RegexRule, "tags">): string[] {
    return rule.tags && rule.tags.length > 0 ? [...rule.tags] : [];
}

const BASE_REGEX_SCOPE_TAG_PROFILES = [
    { id: "chat", label: "聊天", tags: ["chat", "text"] },
    { id: "group_chat", label: "群聊", tags: ["group_chat", "text"] },
    { id: "story", label: "剧情", tags: ["story"] },
    { id: "offline", label: "线下", tags: ["offline"] },
];

const DEFAULT_REGEX_TAGS = BASE_REGEX_SCOPE_TAG_PROFILES[0].tags;

function migrateLegacyRuleTags(tags: string[]): string[] {
    if (areTagsEqual(tags, ["chat"])) return ["chat", "text"];
    if (areTagsEqual(tags, ["group_chat"])) return ["group_chat", "text"];
    return tags;
}

function normalizeRuleScope(rule: RegexRule): RegexRule {
    const tags = migrateLegacyRuleTags(getRuleTags(rule));
    if (tags.length === 0) return rule.tags === undefined ? rule : { ...rule, tags: undefined };
    return areTagsEqual(tags, getRuleTags(rule)) ? rule : { ...rule, tags };
}

function normalizeGroupScope(group: RegexConfig): RegexConfig {
    return {
        ...group,
        rules: (group.rules || []).map(normalizeRuleScope),
    };
}

function getRuleTagProfileId(rule: Pick<RegexRule, "tags">, profiles: TagProfile[]): string {
    return getTagProfileId(getRuleTags(rule), profiles);
}

function getRuleTagsLabel(rule: Pick<RegexRule, "tags">, profiles: TagProfile[]): string {
    return getTagsLabel(getRuleTags(rule), profiles);
}

function getRuleRawTagsLabel(rule: Pick<RegexRule, "tags">): string {
    const tags = getRuleTags(rule);
    return tags.length > 0 ? tags.join(" · ") : "通用";
}

function setRuleTags(tags: string[]): Partial<RegexRule> {
    return {
        tags: tags.length > 0 ? tags : undefined,
    };
}

export function RegexManager({ isActive = true }: { isActive?: boolean } = {}) {
    const [groups, setGroups] = useState<RegexConfig[]>([]);
    const [activeGroupId, setActiveGroupId] = useState<string>("");
    const [viewMode, setViewMode] = useState<"list" | "detail">("list");
    const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
    const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<{ type: 'group' | 'rule', id: string } | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);
    const [testingRuleId, setTestingRuleId] = useState<string | null>(null);
    const [testInput, setTestInput] = useState("在这里输入测试文本...");
    const [expandTarget, setExpandTarget] = useState<{ ruleId: string; field: "findRegex" | "replaceString" } | null>(null);
    const [previewHtml, setPreviewHtml] = useState<string | null>(null);
    const [groupTestOpen, setGroupTestOpen] = useState(false);
    const [groupTestInput, setGroupTestInput] = useState("");
    const [groupTestExpandStep, setGroupTestExpandStep] = useState<number | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [customApps, setCustomApps] = useState<InstalledCustomApp[]>([]);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const { setSubpageTitle, setOverrideBack, setSubpageRightAction } = useContext(SettingsContext);

    // Initial load
    useEffect(() => {
        const loaded = loadRegexes().map(normalizeGroupScope);
        if (loaded.length > 0) {
            setGroups(loaded);
            setActiveGroupId(loaded[0]?.id || "");
            saveRegexes(loaded);
        }
        setCustomApps(loadInstalledCustomApps());
        setIsLoaded(true);
    }, []);

    useEffect(() => {
        const refreshCustomApps = () => setCustomApps(loadInstalledCustomApps());
        const refreshRegexes = () => {
            const loaded = loadRegexes().map(normalizeGroupScope);
            setGroups(loaded);
            setActiveGroupId(current => current && loaded.some(group => group.id === current) ? current : loaded[0]?.id || "");
        };
        window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
        window.addEventListener("settings-regexes-updated", refreshRegexes);
        return () => {
            window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
            window.removeEventListener("settings-regexes-updated", refreshRegexes);
        };
    }, []);

    const regexScopeTagProfiles = useMemo(() => [
        ...BASE_REGEX_SCOPE_TAG_PROFILES,
        ...flattenTagGroups(buildCustomAppTagGroups(customApps, { regexes: groups })),
    ], [customApps, groups]);

    // Push mascot context only when this tab is active
    useEffect(() => {
        if (!isLoaded || !isActive) return;
        const activeGroup = groups.find(g => g.id === activeGroupId);
        const rulesSummary = activeGroup
            ? (activeGroup.rules || []).map(r => `${r.disabled ? "❌" : "✅"} ${r.scriptName}`).join(", ")
            : "";
        notifyMascotPageContext({
            page: "regex",
            mode: "editing",
            label: activeGroup ? `正则编辑 · ${activeGroup.name}` : "正则编辑",
            fields: activeGroup ? {
                groupId: activeGroup.id,
                groupName: activeGroup.name,
                ruleCount: String(activeGroup.rules?.length || 0),
                rules: rulesSummary,
            } : {},
        });
        return () => {
            notifyMascotPageContext({ page: "desktop", mode: "idle", label: "桌面", fields: {} });
        };
    }, [isLoaded, isActive, activeGroupId, groups]);

    const persist = useCallback((newGroups: RegexConfig[]) => {
        setGroups(newGroups);
        saveRegexes(newGroups);
    }, []);

    const rxContainerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (viewMode === "detail" && activeGroupId) {
            setOverrideBack(() => () => setViewMode("list"));
            const target = groups.find(g => g.id === activeGroupId);
            setSubpageTitle(target?.name || "正则组详情");
        } else {
            setOverrideBack(null);
            setSubpageTitle(null);
        }
    }, [viewMode, activeGroupId, groups, setOverrideBack, setSubpageTitle]);

    useEffect(() => {
        const scrollParent = rxContainerRef.current?.closest(".page-body");
        if (scrollParent) scrollParent.scrollTop = 0;
    }, [viewMode, activeGroupId]);

    // --- Group Level Operations ---
    const addGroup = useCallback(() => {
        const newGroup = createRegexGroup("新正则组");
        persist([newGroup, ...groups]);
        setActiveGroupId(newGroup.id);
        setViewMode("detail");
    }, [groups, persist]);

    useEffect(() => {
        if (viewMode !== "list") {
            setSubpageRightAction("regex", null);
            return;
        }
        setSubpageRightAction("regex",
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95 focus:outline-none"
                >
                    <Upload size={15} strokeWidth={1.8} />
                    <span>导入正则</span>
                </button>
                <button
                    type="button"
                    onClick={addGroup}
                    className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                >
                    <Plus size={15} strokeWidth={1.8} />
                    <span>新建正则</span>
                </button>
            </div>
        );
        return () => setSubpageRightAction("regex", null);
    }, [addGroup, setSubpageRightAction, viewMode]);

    const updateGroup = (id: string, updates: Partial<RegexConfig>) => {
        persist(groups.map(g => g.id === id ? { ...g, ...updates, updatedAt: Date.now() } : g));
    };

    const removeGroup = (id: string) => {
        const remaining = groups.filter(g => g.id !== id);
        persist(remaining);
        setViewMode("list");
        if (remaining.length > 0) {
            setActiveGroupId(remaining[0].id);
        } else {
            setActiveGroupId("");
        }
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                const fallbackName = file.name.replace(/\.json$/i, "") || "导入的正则组";
                const parsed = parseRegexFromJson(text, fallbackName);
                if (parsed) {
                    const scoped = normalizeGroupScope(parsed);
                    persist([scoped, ...groups]);
                    setActiveGroupId(scoped.id);
                } else {
                    setImportError("无法解析正则文件，格式不正确。");
                }
            } catch (e) {
                if (e instanceof Error && e.message === UNSUPPORTED_IMPORT_FORMAT) {
                    setImportError("不支持该正则格式");
                } else {
                    setImportError("无法解析正则文件，格式不正确。");
                }
            }
        };
        reader.readAsText(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleExport = async (group: RegexConfig) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const exportData = { name: group.name, description: group.description, rules: group.rules };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${group.name || "regex_group"}.json`);
    };

    // --- Rule Level Operations ---
    const activeGroup = groups.find(g => g.id === activeGroupId);

    const visibleRules = activeGroup?.rules || [];

    // ── 规则左滑操作（微信式：左滑露出「新增/删除」） ──
    const swipe = useSwipeActions();

    const makeNewRule = (): RegexRule => ({
        id: `regex-rule-${Date.now()}`,
        scriptName: "新正则规则",
        findRegex: "",
        replaceString: "",
        disabled: false,
        placement: [1],
        tags: [...DEFAULT_REGEX_TAGS],
    });

    const addRule = () => {
        if (!activeGroup) return;
        const newRule = makeNewRule();
        updateGroup(activeGroup.id, { rules: [newRule, ...(activeGroup.rules || [])] });
        setEditingRuleId(newRule.id);
    };

    const insertRuleAfter = (afterId: string) => {
        if (!activeGroup) return;
        const newRule = makeNewRule();
        const rules = [...(activeGroup.rules || [])];
        const idx = rules.findIndex(r => r.id === afterId);
        if (idx >= 0) rules.splice(idx + 1, 0, newRule);
        else rules.push(newRule);
        updateGroup(activeGroup.id, { rules });
        swipe.close();
        setEditingRuleId(newRule.id);
        window.setTimeout(() => {
            rxContainerRef.current
                ?.querySelector(`[data-swipe-id="${CSS.escape(newRule.id)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    // ── 规则级导入/导出（左滑「替换/导出」+ 底部「添加条目」菜单） ──
    const [addRuleMenuOpen, setAddRuleMenuOpen] = useState(false);
    const ruleFileInputRef = useRef<HTMLInputElement>(null);
    const ruleImportModeRef = useRef<{ mode: "append" } | { mode: "replace"; id: string } | null>(null);

    const sanitizeRuleImport = (raw: unknown, fallbackId: string): RegexRule | null => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const obj = raw as Record<string, unknown>;
        if (typeof obj.findRegex !== "string" && typeof obj.scriptName !== "string") return null;
        const placement = Array.isArray(obj.placement)
            ? obj.placement.filter((v): v is number => typeof v === "number")
            : [];
        const rule: RegexRule = {
            id: fallbackId,
            scriptName: typeof obj.scriptName === "string" ? obj.scriptName : "导入的规则",
            findRegex: typeof obj.findRegex === "string" ? obj.findRegex : "",
            replaceString: typeof obj.replaceString === "string" ? obj.replaceString : "",
            disabled: !!obj.disabled,
            placement: placement.length > 0 ? placement : [1],
        };
        if (Array.isArray(obj.tags)) rule.tags = obj.tags.filter((t): t is string => typeof t === "string");
        if (Array.isArray(obj.trimStrings)) rule.trimStrings = obj.trimStrings.filter((t): t is string => typeof t === "string");
        if (typeof obj.markdownOnly === "boolean") rule.markdownOnly = obj.markdownOnly;
        if (typeof obj.promptOnly === "boolean") rule.promptOnly = obj.promptOnly;
        if (typeof obj.runOnEdit === "boolean") rule.runOnEdit = obj.runOnEdit;
        if (typeof obj.substituteRegex === "number") rule.substituteRegex = obj.substituteRegex;
        if (typeof obj.minDepth === "number") rule.minDepth = obj.minDepth;
        if (typeof obj.maxDepth === "number") rule.maxDepth = obj.maxDepth;
        return normalizeRuleScope(rule);
    };

    const appendImportedRules = (group: RegexConfig, raws: unknown[]) => {
        const base = Date.now();
        const appended = raws
            .map((raw, i) => sanitizeRuleImport(raw, `regex-rule-${base + i}`))
            .filter((rule): rule is RegexRule => !!rule);
        if (appended.length === 0) {
            setImportError("JSON 里没有可识别的规则内容。");
            return;
        }
        updateGroup(group.id, { rules: [...(group.rules || []), ...appended] });
        if (appended.length === 1) setEditingRuleId(appended[0].id);
        window.setTimeout(() => {
            rxContainerRef.current
                ?.querySelector(`[data-swipe-id="${CSS.escape(appended[0].id)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 80);
    };

    const replaceImportedRule = (group: RegexConfig, targetId: string, raw: unknown) => {
        const sanitized = sanitizeRuleImport(raw, targetId);
        if (!sanitized) {
            setImportError("JSON 里没有可识别的规则内容。");
            return;
        }
        // 保留原 id，只替换内容
        const finalRule = { ...sanitized, id: targetId };
        updateGroup(group.id, { rules: (group.rules || []).map(r => r.id === targetId ? finalRule : r) });
    };

    const exportRule = async (rule: RegexRule) => {
        const { downloadFile } = await import("@/lib/download-utils");
        const blob = new Blob([JSON.stringify(rule, null, 2)], { type: "application/json" });
        await downloadFile(blob, `${rule.scriptName || "regex-rule"}.json`);
    };

    const handleRuleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        const mode = ruleImportModeRef.current;
        ruleImportModeRef.current = null;
        if (ruleFileInputRef.current) ruleFileInputRef.current.value = "";
        if (!file || !mode) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const group = groups.find(g => g.id === activeGroupId);
            if (!group) return;
            try {
                const parsed = JSON.parse(event.target?.result as string);
                const items = Array.isArray(parsed) ? parsed : [parsed];
                if (mode.mode === "replace") replaceImportedRule(group, mode.id, items[0]);
                else appendImportedRules(group, items);
            } catch {
                setImportError("无法解析规则文件，格式不正确。");
            }
        };
        reader.readAsText(file);
    };

    const updateRule = (id: string, updates: Partial<RegexRule>) => {
        if (!activeGroup) return;
        const newRules = activeGroup.rules.map(r => r.id === id ? { ...r, ...updates } : r);
        updateGroup(activeGroup.id, { rules: newRules });
    };

    const removeRule = (id: string) => {
        if (!activeGroup) return;
        updateGroup(activeGroup.id, { rules: activeGroup.rules.filter(r => r.id !== id) });
        if (editingRuleId === id) setEditingRuleId(null);
        if (testingRuleId === id) setTestingRuleId(null);
    };

    // Run a single regex rule against test input (delegates to the production engine)
    function runTestRegex(rule: RegexRule, input: string): { output: string; matchCount: number; error?: string } {
        return testRegexRule(rule, input);
    }

    if (!isLoaded) return null;

    return (
        <div ref={rxContainerRef} className="flex flex-col gap-5 h-full">
            <input type="file" accept=".json" className="hidden" ref={fileInputRef} onChange={handleImport} />
            <input type="file" accept=".json" className="hidden" ref={ruleFileInputRef} onChange={handleRuleImportFile} />
            {viewMode === "list" ? (
                <>
                    <div className="flex items-center">
                        <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Regex</h2>
                    </div>

                    {groups.length === 0 ? (
                        <div className="ui-empty mt-2">
                            <div className="ui-icon-circle">
                                <Database size={24} />
                            </div>
                            <span className="menu-label font-semibold">没有正则组</span>
                            <span className="menu-desc max-w-[240px]">
                                正则用于在发送给 AI 或收到 AI 回复时进行高阶的文本替换与格式处理。
                            </span>
                            <button onClick={addGroup} className="ui-btn ui-btn-primary mt-2">
                                <Plus size={16} /> 新建正则组
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {groups.map(group => (
                                <div
                                    key={group.id}
                                    className="ui-config-card min-w-0 cursor-pointer"
                                    style={{ minHeight: "84px", padding: "16px", justifyContent: "space-between" }}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`编辑 ${group.name || "正则组"}`}
                                    onClick={() => { setActiveGroupId(group.id); setViewMode("detail"); }}
                                    onKeyDown={(event) => {
                                        if (event.target !== event.currentTarget) return;
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            setActiveGroupId(group.id);
                                            setViewMode("detail");
                                        }
                                    }}
                                >
                                    <div className="min-w-0 flex flex-col gap-1.5">
                                        <div className="min-w-0 flex items-center gap-[6px]">
                                            <Database size={16} className="shrink-0" />
                                            <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{group.name}</span>
                                        </div>
                                        <span className="menu-desc truncate">{group.description || `${group.rules?.length || 0} 个规则`}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="menu-desc ts-12">规则 {group.rules?.length || 0}</span>
                                        <ChevronLeft size={16} className="opacity-40" style={{ transform: "rotate(180deg)" }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            ) : (
                <>
                    {activeGroup && (
                        <div className="flex flex-col gap-4 pb-6">
                            <div className="flex justify-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleExport(activeGroup)}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95"
                                >
                                    <Download size={15} strokeWidth={1.8} />
                                    <span>导出正则</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setConfirmDeleteTarget({ type: 'group', id: activeGroup.id })}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-[var(--c-danger)] shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95"
                                >
                                    <Trash2 size={15} strokeWidth={1.8} />
                                    <span>删除正则</span>
                                </button>
                            </div>

                            <h2 className="mx-2 mb-0 mt-2 ts-20 font-bold leading-none text-black">Regex Info</h2>
                            <div className="ui-entry-card" style={{ cursor: "default" }}>
                                <div className="flex flex-col gap-2">
                                    <label className="menu-label ts-13 font-semibold ml-1">正则组名称</label>
                                    <input
                                        type="text"
                                        value={activeGroup.name}
                                        onChange={(e) => updateGroup(activeGroup.id, { name: e.target.value })}
                                        placeholder="正则组名称..."
                                        className="ui-input font-medium"
                                    />
                                </div>

                                <div className="flex flex-col gap-2">
                                    <label className="menu-label ts-13 font-semibold ml-1">简介描述</label>
                                    <textarea
                                        value={activeGroup.description || ""}
                                        onChange={(e) => updateGroup(activeGroup.id, { description: e.target.value })}
                                        placeholder="简介描述..."
                                        rows={2}
                                        className="ui-textarea resize-none"
                                    />
                                </div>
                            </div>

                            <div className="flex flex-col gap-4 mt-2">
                            <h2 className="mx-2 mb-0 mt-2 ts-20 font-bold leading-none text-black">Regex Rules ({activeGroup.rules?.length || 0})</h2>

                            <button
                                className="ui-btn ui-btn-outline w-full ts-13"
                                onClick={() => setGroupTestOpen(!groupTestOpen)}
                            >
                                <Play size={14} fill="currentColor" /> {groupTestOpen ? "收起整组测试" : "整组测试"}
                            </button>

                            {groupTestOpen && activeGroup && (() => {
                                let groupOutput = groupTestInput;
                                const steps: { name: string; output: string; changed: boolean; skipped?: string }[] = [];
                                for (const rule of activeGroup.rules) {
                                    if (rule.disabled) { steps.push({ name: rule.scriptName, output: groupOutput, changed: false, skipped: "已禁用" }); continue; }
                                    if (!rule.placement?.includes(2)) { steps.push({ name: rule.scriptName, output: groupOutput, changed: false, skipped: `位置=${JSON.stringify(rule.placement)}` }); continue; }
                                    if (rule.promptOnly) { steps.push({ name: rule.scriptName, output: groupOutput, changed: false, skipped: "仅Prompt" }); continue; }
                                    const before = groupOutput;
                                    try {
                                        const { output } = testRegexRule(rule, groupOutput);
                                        groupOutput = output;
                                    } catch { /* skip */ }
                                    steps.push({ name: rule.scriptName, output: groupOutput, changed: groupOutput !== before });
                                }
                                return (
                                    <div className="ui-entry-card flex flex-col gap-3" data-active="true" style={{ gap: 12 }}>
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc">测试输入（粘贴一段完整的 AI 回复）</label>
                                            <textarea
                                                value={groupTestInput}
                                                onChange={(e) => { setGroupTestInput(e.target.value); setGroupTestExpandStep(null); }}
                                                placeholder="在这里粘入 AI 原始回复文本..."
                                                rows={5}
                                                className="ui-textarea ts-13"
                                            />
                                        </div>
                                        {groupTestInput.trim() && (
                                            <>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc">执行步骤 ({steps.filter(s => !s.skipped).length} 条规则执行，{steps.filter(s => s.skipped).length} 条跳过)</label>
                                                    <div className="flex flex-col gap-1">
                                                        {steps.map((step, i) => (
                                                            <div key={i}>
                                                                <button
                                                                    onClick={() => setGroupTestExpandStep(groupTestExpandStep === i ? null : i)}
                                                                    className="flex items-center gap-2 ts-12 w-full bg-transparent border-none text-left cursor-pointer p-0"
                                                                    style={{ padding: "4px 0", borderBottom: "1px solid var(--c-panel-border)" }}
                                                                >
                                                                    <span className="ui-tag" data-variant={step.skipped ? "muted" : step.changed ? "success" : "muted"} style={{ minWidth: 24, textAlign: "center", fontSize: "calc(11px*var(--app-text-scale,1))" }}>
                                                                        {step.skipped ? "跳" : step.changed ? "改" : "—"}
                                                                    </span>
                                                                    <span className="menu-label ts-12 truncate flex-1">{step.name}</span>
                                                                    {step.skipped && <span className="ts-11" style={{ color: "var(--c-icon)", opacity: 0.6 }}>{step.skipped}</span>}
                                                                </button>
                                                                {groupTestExpandStep === i && !step.skipped && (
                                                                    <div className="ui-code-block" style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", fontSize: "calc(12px*var(--app-text-scale,1))", margin: "4px 0 8px" }}>
                                                                        {step.output || <span className="menu-desc !mt-0">(空)</span>}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <label className="menu-desc">最终输出</label>
                                                    <div className="ui-code-block" style={{ maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", fontSize: "calc(13px*var(--app-text-scale,1))" }}>
                                                        {groupOutput || <span className="menu-desc !mt-0">(空)</span>}
                                                    </div>
                                                </div>
                                                {/<[a-z][\s\S]*?>/i.test(groupOutput) && (
                                                    <button
                                                        className="ui-btn ui-btn-outline self-end ts-13"
                                                        onClick={() => setPreviewHtml(groupOutput)}
                                                    >
                                                        <Maximize2 size={14} /> 渲染预览
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                );
                            })()}

                            <div className="flex flex-col gap-2">
                                {visibleRules.length === 0 ? (
                                    <div className="menu-desc text-center mt-10 ts-14">
                                        没找到相关的正则规则
                                    </div>
                                ) : (
                                    visibleRules.map(rule => {
                                        const isEditing = editingRuleId === rule.id;

                                        return (
                                            <SwipeActionRow
                                                key={rule.id}
                                                controller={swipe}
                                                id={rule.id}
                                                disabled={isEditing}
                                                actions={
                                                    <>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="insert"
                                                            onClick={() => insertRuleAfter(rule.id)}
                                                        >
                                                            <Plus size={18} strokeWidth={2} />
                                                            <span>新增</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="ui-swipe-action"
                                                            data-variant="replace"
                                                            onClick={() => {
                                                                ruleImportModeRef.current = { mode: "replace", id: rule.id };
                                                                ruleFileInputRef.current?.click();
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
                                                                exportRule(rule);
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
                                                                setConfirmDeleteTarget({ type: 'rule', id: rule.id });
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
                                                data-active={isEditing ? "true" : undefined}
                                                data-disabled={rule.disabled && !isEditing ? "true" : undefined}
                                                style={{ gap: isEditing ? 12 : 0 }}
                                            >
                                                <div className="flex justify-between items-start">
                                                    <button
                                                        onClick={() => {
                                                            if (swipe.consumeClickSuppression()) return;
                                                            if (swipe.openId || swipe.swipingId) {
                                                                swipe.close();
                                                                return;
                                                            }
                                                            setEditingRuleId(isEditing ? null : rule.id);
                                                        }}
                                                        className="flex gap-3 flex-1 bg-none border-none text-left cursor-pointer p-0"
                                                    >
                                                        <div className="mt-0.5 ui-entry-icon">
                                                            <Database size={20} />
                                                        </div>
                                                        <div className="flex flex-col gap-1 flex-1">
                                                            <span className="menu-label font-semibold break-all ts-15">
                                                                {rule.scriptName || "(未命名规则)"}
                                                            </span>
                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                <span className="ui-tag" data-variant="muted">
                                                                    <span className="font-mono overflow-hidden text-ellipsis whitespace-nowrap max-w-[160px] inline-block align-bottom">{rule.findRegex || "无匹配正则"}</span>
                                                                </span>
                                                                <span className="ui-status-tag" data-variant={getRuleTags(rule).length > 0 ? "success" : undefined}>
                                                                    {getRuleTagsLabel(rule, regexScopeTagProfiles)}
                                                                </span>
                                                                {rule.disabled && <span className="ui-status-tag">已禁用</span>}
                                                            </div>
                                                        </div>
                                                    </button>

                                                    <div className="flex gap-3 ml-3 shrink-0 items-center">
                                                        <label
                                                            className="ui-mini-toggle"
                                                            onClick={(e) => e.stopPropagation()}
                                                            title={rule.disabled ? "已禁用 (点击启用)" : "已启用 (点击禁用)"}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                checked={!rule.disabled}
                                                                onChange={(e) => updateRule(rule.id, { disabled: !e.target.checked })}
                                                                className="ui-mini-toggle-track"
                                                            />
                                                            <span className="ui-mini-toggle-thumb" />
                                                        </label>
                                                    </div>
                                                </div>

                                                {isEditing && (
                                                    <div className="ui-entry-separator flex flex-col gap-3">
                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">规则名称 (Script Name)</label>
                                                            <input
                                                                type="text"
                                                                value={rule.scriptName}
                                                                onChange={(e) => updateRule(rule.id, { scriptName: e.target.value })}
                                                                placeholder="例如: 屏蔽广告词"
                                                                className="ui-input ts-14 font-medium"
                                                            />
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">匹配内容 (Find Regex)</label>
                                                            <div className="relative">
                                                                <textarea
                                                                    value={rule.findRegex}
                                                                    onChange={(e) => updateRule(rule.id, { findRegex: e.target.value })}
                                                                    placeholder="/正则表达式/flags&#10;例: /\[.*?\]/gs&#10;flags 由用户指定，不会自动添加"
                                                                    rows={3}
                                                                    className="ui-textarea ts-13 font-mono"
                                                                />
                                                                <button onClick={() => setExpandTarget({ ruleId: rule.id, field: "findRegex" })} className="absolute top-2 right-2 bg-none border-none cursor-pointer p-0" style={{ color: "var(--c-icon)" }}><Maximize2 size={14} /></button>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">替换为 (Replace String)</label>
                                                            <div className="relative">
                                                                <textarea
                                                                    value={rule.replaceString}
                                                                    onChange={(e) => updateRule(rule.id, { replaceString: e.target.value })}
                                                                    placeholder="留空即为删除，支持 $1 $<name> {{match}} {{char}}"
                                                                    rows={2}
                                                                    className="ui-textarea ts-13 font-mono"
                                                                />
                                                                <button onClick={() => setExpandTarget({ ruleId: rule.id, field: "replaceString" })} className="absolute top-2 right-2 bg-none border-none cursor-pointer p-0" style={{ color: "var(--c-icon)" }}><Maximize2 size={14} /></button>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">作用位置 (Placement)</label>
                                                            <div className="flex items-center justify-between gap-4 mt-2">
                                                                {([
                                                                    [1, "用户输入"],
                                                                    [2, "AI 输出"],
                                                                    [5, "世界书"],
                                                                    [6, "思维链"],
                                                                ] as const).map(([val, label]) => (
                                                                    <label key={val} className="ui-checkbox-label whitespace-nowrap">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={rule.placement?.includes(val) ?? false}
                                                                            onChange={(e) => {
                                                                                const p = new Set(rule.placement || []);
                                                                                e.target.checked ? p.add(val) : p.delete(val);
                                                                                updateRule(rule.id, { placement: [...p] });
                                                                            }}
                                                                        />
                                                                        {label}
                                                                    </label>
                                                                ))}
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">应用模式</label>
                                                            <div className="flex items-center justify-between gap-6 mt-2">
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={rule.markdownOnly ?? false}
                                                                        onChange={(e) => updateRule(rule.id, { markdownOnly: e.target.checked || undefined, promptOnly: e.target.checked ? undefined : rule.promptOnly })} />
                                                                    仅显示时
                                                                </label>
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={rule.promptOnly ?? false}
                                                                        onChange={(e) => updateRule(rule.id, { promptOnly: e.target.checked || undefined, markdownOnly: e.target.checked ? undefined : rule.markdownOnly })} />
                                                                    仅Prompt
                                                                </label>
                                                                <label className="ui-checkbox-label whitespace-nowrap">
                                                                    <input type="checkbox" checked={rule.runOnEdit ?? false}
                                                                        onChange={(e) => updateRule(rule.id, { runOnEdit: e.target.checked || undefined })} />
                                                                    编辑时执行
                                                                </label>
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">适用范围</label>
                                                            <select
                                                                value={getRuleTagProfileId(rule, regexScopeTagProfiles)}
                                                                onChange={(e) => {
                                                                    const selectedProfile = regexScopeTagProfiles.find(profile => profile.id === e.target.value);
                                                                    if (!selectedProfile) return;
                                                                    updateRule(rule.id, setRuleTags(selectedProfile.tags));
                                                                }}
                                                                className="ui-input ts-13"
                                                            >
                                                                {getRuleTagProfileId(rule, regexScopeTagProfiles) === "__custom__" ? (
                                                                    <option value="__custom__">{getRuleRawTagsLabel(rule)}</option>
                                                                ) : null}
                                                                {regexScopeTagProfiles.map((profile) => (
                                                                    <option key={profile.id} value={profile.id}>{profile.label}</option>
                                                                ))}
                                                            </select>
                                                            <div className="menu-desc !mt-0">
                                                                实际标签：{getRuleRawTagsLabel(rule)}
                                                            </div>
                                                        </div>

                                                        <div className="flex flex-col gap-1">
                                                            <label className="menu-desc">Trim Strings（从捕获组中移除的文本，每行一条）</label>
                                                            <textarea
                                                                value={(rule.trimStrings || []).join("\n")}
                                                                onChange={(e) => {
                                                                    const lines = e.target.value.split("\n").filter(s => s.length > 0);
                                                                    updateRule(rule.id, { trimStrings: lines.length > 0 ? lines : undefined });
                                                                }}
                                                                placeholder="每行一条要移除的文本..."
                                                                rows={2}
                                                                className="ui-textarea ts-13 font-mono"
                                                            />
                                                        </div>

                                                        <div className="flex gap-4 items-end flex-wrap">
                                                            <div className="flex flex-col gap-1 flex-1 min-w-[100px]">
                                                                <label className="menu-desc">宏替换 (Find Regex)</label>
                                                                <select value={rule.substituteRegex ?? 0}
                                                                    onChange={(e) => updateRule(rule.id, { substituteRegex: Number(e.target.value) || undefined })}
                                                                    className="ui-input ts-13">
                                                                    <option value={0}>不替换</option>
                                                                    <option value={1}>RAW（直接展开）</option>
                                                                    <option value={2}>ESCAPED（转义特殊字符）</option>
                                                                </select>
                                                            </div>
                                                            <div className="flex flex-col gap-1 w-[72px]">
                                                                <label className="menu-desc">最小深度</label>
                                                                <input type="number" value={rule.minDepth ?? ""} placeholder="-1"
                                                                    onChange={(e) => updateRule(rule.id, { minDepth: e.target.value ? Number(e.target.value) : undefined })}
                                                                    className="ui-input ts-13" />
                                                            </div>
                                                            <div className="flex flex-col gap-1 w-[72px]">
                                                                <label className="menu-desc">最大深度</label>
                                                                <input type="number" value={rule.maxDepth ?? ""} placeholder="∞"
                                                                    onChange={(e) => updateRule(rule.id, { maxDepth: e.target.value ? Number(e.target.value) : undefined })}
                                                                    className="ui-input ts-13" />
                                                            </div>
                                                        </div>

                                                        <button
                                                            className="ui-btn ui-btn-outline w-full mt-1 ts-13"
                                                            onClick={() => {
                                                                const opening = testingRuleId !== rule.id;
                                                                setTestingRuleId(opening ? rule.id : null);
                                                            }}
                                                        >
                                                            <Play size={14} fill="currentColor" /> {testingRuleId === rule.id ? "收起测试" : "测试正则"}
                                                        </button>

                                                        {testingRuleId === rule.id && (() => {
                                                            const { output, matchCount, error } = runTestRegex(rule, testInput);
                                                            return (
                                                                <div className="ui-entry-separator flex flex-col gap-3">
                                                                    <div className="flex flex-col gap-1">
                                                                        <label className="menu-desc">测试输入</label>
                                                                        <textarea
                                                                            value={testInput}
                                                                            onChange={(e) => setTestInput(e.target.value)}
                                                                            placeholder="输入要测试的文本..."
                                                                            rows={3}
                                                                            className="ui-textarea ts-13"
                                                                        />
                                                                    </div>
                                                                    {error ? (
                                                                        <div className="flex items-start gap-2 p-2.5 rounded-lg" style={{ background: "color-mix(in srgb, var(--c-danger) 12%, transparent)", border: "1px solid var(--c-danger)" }}>
                                                                            <AlertCircle size={16} className="shrink-0 mt-0.5" style={{ color: "var(--c-danger)" }} />
                                                                            <span className="ts-12" style={{ color: "var(--c-danger)" }}>{error}</span>
                                                                        </div>
                                                                    ) : (
                                                                        <div className="flex flex-col gap-1">
                                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                                <label className="menu-desc !mt-0">替换结果</label>
                                                                                <span className="ui-tag" data-variant={matchCount > 0 ? "success" : "muted"}>
                                                                                    {matchCount > 0 ? `${matchCount} 处匹配` : "无匹配"}
                                                                                </span>
                                                                            </div>
                                                                            <div className="ui-code-block">{output || <span className="menu-desc !mt-0">(空)</span>}</div>
                                                                        </div>
                                                                    )}
                                                                    {!error && matchCount > 0 && /<[a-z][\s\S]*?>/i.test(output) && (
                                                                        <button
                                                                            className="ui-btn ui-btn-outline self-end ts-13"
                                                                            onClick={() => setPreviewHtml(output)}
                                                                        >
                                                                            <Maximize2 size={14} /> 渲染预览
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            );
                                                        })()}
                                                    </div>
                                                )}
                                            </div>
                                            </SwipeActionRow>
                                        )
                                    })
                                )}
                            </div>

                            <button
                                type="button"
                                onClick={() => setAddRuleMenuOpen(true)}
                                className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                            >
                                <Plus size={15} strokeWidth={1.8} />
                                添加条目
                            </button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {confirmDeleteTarget && (
                <ConfirmDialog
                    title="确认删除？"
                    message={confirmDeleteTarget.type === 'group' ? "删除正则组后无法恢复。是否继续？" : "删除规则后无法恢复。是否继续？"}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        if (confirmDeleteTarget.type === 'group') {
                            removeGroup(confirmDeleteTarget.id);
                        } else {
                            removeRule(confirmDeleteTarget.id);
                        }
                        setConfirmDeleteTarget(null);
                    }}
                    onCancel={() => setConfirmDeleteTarget(null)}
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

            {addRuleMenuOpen && activeGroup && (
                <BottomSheet title="添加条目" onClose={() => setAddRuleMenuOpen(false)}>
                    <div className="flex flex-col gap-2">
                        <button
                            type="button"
                            className="ui-btn ui-btn-primary w-full"
                            onClick={() => {
                                setAddRuleMenuOpen(false);
                                addRule();
                            }}
                        >
                            <Plus size={16} /> 直接创建
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline w-full"
                            onClick={() => {
                                setAddRuleMenuOpen(false);
                                ruleImportModeRef.current = { mode: "append" };
                                ruleFileInputRef.current?.click();
                            }}
                        >
                            <Upload size={16} /> 从 JSON 文件导入
                        </button>
                    </div>
                </BottomSheet>
            )}

            {expandTarget && (() => {
                const rule = activeGroup?.rules?.find(r => r.id === expandTarget.ruleId);
                if (!rule) return null;
                const isFind = expandTarget.field === "findRegex";
                return (
                    <TextExpandModal
                        title={isFind ? "匹配内容 (Find Regex)" : "替换为 (Replace String)"}
                        value={rule[expandTarget.field]}
                        onChange={(v) => updateRule(rule.id, { [expandTarget.field]: v })}
                        placeholder={isFind ? "/正则表达式/flags  例: /\\[.*?\\]/gs\nflags 由用户指定，不会自动添加" : "留空即为删除，支持 $1 $<name> {{match}} {{char}}"}
                        className="ts-13 font-mono"
                        onClose={() => setExpandTarget(null)}
                    />
                );
            })()}

            {previewHtml && (
                <div className="absolute inset-0 z-[999] flex flex-col" style={{ background: "var(--c-page-body-bg)" }}>
                    <header className="flex items-center justify-between px-4 shrink-0" style={{ height: 48, marginTop: 48 }}>
                        <span className="menu-label font-semibold ts-15">渲染预览</span>
                        <button onClick={() => setPreviewHtml(null)} className="w-[32px] h-[32px] rounded-full flex items-center justify-center" style={{ background: "var(--c-card)", color: "var(--c-text)" }}>
                            <X size={18} />
                        </button>
                    </header>
                    <div className="flex-1 overflow-auto p-4">
                        <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                    </div>
                </div>
            )}
        </div>
    );
}
