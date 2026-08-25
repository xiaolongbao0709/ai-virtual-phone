"use client";

import { useState, useEffect, useRef, useContext } from "react";
import type { ChangeEvent } from "react";
import { Plus, Trash2, Search, Wrench, AlertCircle, MoreHorizontal, Upload, Download, ChevronDown, ChevronRight } from "lucide-react";
import type {
    CompositeToolConfig,
    CompositeToolPackageConfig,
    CompositeToolStep,
    RestToolConfig,
    RestToolPackageConfig,
    McpServerConfig,
    InternalCapabilityConfig,
} from "@/lib/settings-types";
import {
    loadCompositeTools, saveCompositeTools, createCompositeTool,
    loadCompositeToolPackages, saveCompositeToolPackages, createCompositeToolPackage,
    loadRestTools, saveRestTools, createRestTool,
    loadRestToolPackages, saveRestToolPackages, createRestToolPackage,
    loadMcpServers, saveMcpServers, createMcpServer,
} from "@/lib/tool-storage";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps, saveInstalledCustomAppsAsync } from "@/lib/custom-app-storage";
import { loadCustomAppChatTools, type RegisteredCustomAppExtension } from "@/lib/custom-app-sdk-registry";
import type { CustomAppToolDefinition } from "@/lib/custom-app-types";
import { downloadFile } from "@/lib/download-utils";
import {
    CALENDAR_MANAGEMENT_CAPABILITY_ID,
    AGENT_COMPUTER_CAPABILITY_ID,
    LOCAL_DATA_LIBRARY_CAPABILITY_ID,
    loadInternalCapabilities,
    saveInternalCapabilities,
    MUSIC_CONTROL_CAPABILITY_ID,
    NOTE_WALL_CAPABILITY_ID,
    TOOLBOX_MANAGEMENT_CAPABILITY_ID,
} from "@/lib/internal-capability-storage";
import { discoverMcpTools, startMcpOAuth } from "@/lib/tool-executor";
import { getMaxToolRounds, loadChatAppSettings, saveChatAppSettings } from "@/lib/chat-storage";
import { SettingsContext } from "@/components/phone-settings-app";
import { Toggle, Input, Textarea, Select } from "@/components/ui/form";
import { ConfirmDialog, ContentDialog } from "@/components/ui/modal";

type ToolExportEntry = {
    key: string;
    label: string;
    description: string;
    kind: string;
};

type ToolboxExportFile = {
    format: "ai-phone-toolbox";
    version: 1;
    exportedAt: string;
    restPackages?: RestToolPackageConfig[];
    restTools?: RestToolConfig[];
    compositePackages?: CompositeToolPackageConfig[];
    compositeTools?: CompositeToolConfig[];
    mcpServers?: McpServerConfig[];
};

type CustomAppToolEntry = RegisteredCustomAppExtension<CustomAppToolDefinition>;

function createImportedToolId(prefix: string): string {
    return `${prefix}_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueImportedName(baseName: string, existingNames: Set<string>): string {
    const base = baseName.trim() || "导入工具";
    if (!existingNames.has(base)) {
        existingNames.add(base);
        return base;
    }

    const first = `${base}（导入）`;
    if (!existingNames.has(first)) {
        existingNames.add(first);
        return first;
    }

    let index = 2;
    while (existingNames.has(`${base}（导入 ${index}）`)) {
        index += 1;
    }
    const next = `${base}（导入 ${index}）`;
    existingNames.add(next);
    return next;
}

function customAppToolKey(tool: Pick<CustomAppToolEntry, "appId" | "id">): string {
    return `${tool.appId}:${tool.id}`;
}

function customAppToolVisibilityLabel(tool: CustomAppToolEntry): string {
    return tool.visibility === "shared" ? "共享" : "仅应用内";
}

function isCustomAppToolEnabled(tool: CustomAppToolEntry): boolean {
    return tool.enabled !== false;
}

export function ToolboxSettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const importFileRef = useRef<HTMLInputElement | null>(null);
    const [restPackages, setRestPackages] = useState<RestToolPackageConfig[]>([]);
    const [restTools, setRestTools] = useState<RestToolConfig[]>([]);
    const [compositePackages, setCompositePackages] = useState<CompositeToolPackageConfig[]>([]);
    const [compositeTools, setCompositeTools] = useState<CompositeToolConfig[]>([]);
    const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
    const [internalCapabilities, setInternalCapabilities] = useState<InternalCapabilityConfig[]>([]);
    const [customAppTools, setCustomAppTools] = useState<CustomAppToolEntry[]>([]);
    const [editRestPackageId, setEditRestPackageId] = useState<string | null>(null);
    const [editRestId, setEditRestId] = useState<string | null>(null);
    const [editCompositePackageId, setEditCompositePackageId] = useState<string | null>(null);
    const [editCompositeId, setEditCompositeId] = useState<string | null>(null);
    const [editMcpId, setEditMcpId] = useState<string | null>(null);
    const [editInternalId, setEditInternalId] = useState<string | null>(null);
    const [editCustomAppToolKey, setEditCustomAppToolKey] = useState<string | null>(null);
    // Draft for new items (not yet persisted)
    const [draftRestPackage, setDraftRestPackage] = useState<RestToolPackageConfig | null>(null);
    const [draftRest, setDraftRest] = useState<RestToolConfig | null>(null);
    const [draftCompositePackage, setDraftCompositePackage] = useState<CompositeToolPackageConfig | null>(null);
    const [draftComposite, setDraftComposite] = useState<CompositeToolConfig | null>(null);
    const [draftMcp, setDraftMcp] = useState<McpServerConfig | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [confirmDeleteType, setConfirmDeleteType] = useState<"rest" | "restPackage" | "composite" | "compositePackage" | "mcp">("rest");
    const [isDiscovering, setIsDiscovering] = useState(false);
    const [isAuthorizing, setIsAuthorizing] = useState(false);
    // MCP 操作结果统一走一次性弹窗，不在编辑页里留常驻文案
    const [mcpNotice, setMcpNotice] = useState<{ title: string; message: string; error?: boolean } | null>(null);
    const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
    const [showExportDialog, setShowExportDialog] = useState(false);
    const [exportSelection, setExportSelection] = useState<string[]>([]);
    const [toolboxImportMessage, setToolboxImportMessage] = useState<string | null>(null);
    const [toolboxImportError, setToolboxImportError] = useState<string | null>(null);
    const [expandedCompositePackageIds, setExpandedCompositePackageIds] = useState<Set<string>>(() => new Set());
    const [expandedCustomAppGroupIds, setExpandedCustomAppGroupIds] = useState<Set<string>>(() => new Set());
    const [maxToolRounds, setMaxToolRounds] = useState(() => getMaxToolRounds());

    const handleMaxToolRoundsChange = (value: number) => {
        const settings = loadChatAppSettings();
        saveChatAppSettings({ ...settings, maxToolRounds: value });
        setMaxToolRounds(value);
    };

    function refreshCustomAppTools() {
        setCustomAppTools(loadCustomAppChatTools());
    }

    useEffect(() => {
        setRestTools(loadRestTools());
        setRestPackages(loadRestToolPackages());
        setCompositeTools(loadCompositeTools());
        setCompositePackages(loadCompositeToolPackages());
        setMcpServers(loadMcpServers());
        setInternalCapabilities(loadInternalCapabilities());
        refreshCustomAppTools();
    }, []);

    useEffect(() => {
        const handler = () => refreshCustomAppTools();
        window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
        return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
    }, []);

    function persistRestPackages(packages: RestToolPackageConfig[]) { setRestPackages(packages); saveRestToolPackages(packages); }
    function persistRest(tools: RestToolConfig[]) { setRestTools(tools); saveRestTools(tools); }
    function persistCompositePackages(packages: CompositeToolPackageConfig[]) { setCompositePackages(packages); saveCompositeToolPackages(packages); }
    function persistComposite(tools: CompositeToolConfig[]) { setCompositeTools(tools); saveCompositeTools(tools); }

    function toggleCustomAppGroupExpanded(appId: string) {
        setExpandedCustomAppGroupIds(prev => {
            const next = new Set(prev);
            if (next.has(appId)) next.delete(appId);
            else next.add(appId);
            return next;
        });
    }

    function toggleCompositePackageExpanded(id: string) {
        setExpandedCompositePackageIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }
    function persistMcp(servers: McpServerConfig[]) { setMcpServers(servers); saveMcpServers(servers); }
    function persistInternal(items: InternalCapabilityConfig[]) { setInternalCapabilities(items); saveInternalCapabilities(items); }

    function updateRestPackage(id: string, updates: Partial<RestToolPackageConfig>) {
        persistRestPackages(restPackages.map(pkg => pkg.id === id ? { ...pkg, ...updates, updatedAt: Date.now() } : pkg));
    }
    function updateRestTool(id: string, updates: Partial<RestToolConfig>) {
        persistRest(restTools.map(t => t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t));
    }
    function updateCompositePackage(id: string, updates: Partial<CompositeToolPackageConfig>) {
        persistCompositePackages(compositePackages.map(pkg => pkg.id === id ? { ...pkg, ...updates, updatedAt: Date.now() } : pkg));
    }
    function updateCompositeTool(id: string, updates: Partial<CompositeToolConfig>) {
        persistComposite(compositeTools.map(t => t.id === id ? { ...t, ...updates, updatedAt: Date.now() } : t));
    }
    function updateMcpServer(id: string, updates: Partial<McpServerConfig>) {
        persistMcp(mcpServers.map(s => s.id === id ? { ...s, ...updates, updatedAt: Date.now() } : s));
    }
    function updateInternalCapability(id: string, updates: Partial<InternalCapabilityConfig>) {
        persistInternal(internalCapabilities.map(item => item.id === id ? { ...item, ...updates, updatedAt: Date.now() } : item));
    }
    async function updateCustomAppToolEnabled(tool: CustomAppToolEntry, enabled: boolean) {
        const now = new Date().toISOString();
        const nextApps = loadInstalledCustomApps().map(app => {
            if (app.id !== tool.appId) return app;
            const updateTools = (tools: CustomAppToolDefinition[] | undefined) => (
                tools?.map(item => item.id === tool.id ? { ...item, enabled: enabled ? undefined : false } : item)
            );
            return {
                ...app,
                updatedAt: now,
                manifest: {
                    ...app.manifest,
                    extensions: {
                        ...app.manifest.extensions,
                        tools: updateTools(app.manifest.extensions?.tools),
                    },
                },
            };
        });
        await saveInstalledCustomAppsAsync(nextApps);
        refreshCustomAppTools();
    }
    async function updateCustomAppToolGroupEnabled(group: CustomAppToolEntry[], enabled: boolean) {
        const toolIdsByApp = new Map<string, Set<string>>();
        for (const tool of group) {
            const ids = toolIdsByApp.get(tool.appId) ?? new Set<string>();
            ids.add(tool.id);
            toolIdsByApp.set(tool.appId, ids);
        }
        const now = new Date().toISOString();
        const nextApps = loadInstalledCustomApps().map(app => {
            const ids = toolIdsByApp.get(app.id);
            if (!ids) return app;
            const updateTools = (tools: CustomAppToolDefinition[] | undefined) => (
                tools?.map(item => ids.has(item.id) ? { ...item, enabled: enabled ? undefined : false } : item)
            );
            return {
                ...app,
                updatedAt: now,
                manifest: {
                    ...app.manifest,
                    extensions: {
                        ...app.manifest.extensions,
                        tools: updateTools(app.manifest.extensions?.tools),
                    },
                },
            };
        });
        await saveInstalledCustomAppsAsync(nextApps);
        refreshCustomAppTools();
    }

    function defaultInternalMode(id: string): InternalCapabilityConfig["mode"] {
        return id === NOTE_WALL_CAPABILITY_ID || id === MUSIC_CONTROL_CAPABILITY_ID || id === CALENDAR_MANAGEMENT_CAPABILITY_ID || id === LOCAL_DATA_LIBRARY_CAPABILITY_ID || id === TOOLBOX_MANAGEMENT_CAPABILITY_ID ? "auto" : "confirm";
    }

    function isAutoOnlyInternalCapability(id: string): boolean {
        return id === NOTE_WALL_CAPABILITY_ID || id === MUSIC_CONTROL_CAPABILITY_ID || id === CALENDAR_MANAGEMENT_CAPABILITY_ID || id === LOCAL_DATA_LIBRARY_CAPABILITY_ID || id === TOOLBOX_MANAGEMENT_CAPABILITY_ID;
    }

    function getAutoOnlyCapabilityDetail(id: string): string {
        if (id === MUSIC_CONTROL_CAPABILITY_ID) {
            return "网易云音乐开启后，角色可以通过工具读取你的本地歌单、网易云歌单、歌单歌曲和当前播放列表，并执行加入播放列表、查看当前歌曲、切换歌曲等播放操作。";
        }
        if (id === NOTE_WALL_CAPABILITY_ID) {
            return "便签墙开启后，角色可以通过工具向公共便签墙写入便签，用来留下留言、记录想法或把聊天中的内容整理成可回看的便签。";
        }
        if (id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
            return "日历管理开启后，角色可以通过工具查看当前角色的日程，并添加、修改或取消日程安排；相关操作会走工具箱能力，不再依赖旧的日程指令。";
        }
        if (id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
            return "本地资料库开启后，角色可以通过工具浏览虚拟资料目录，并读取或搜索本机小手机里的角色卡、聊天、朋友圈、记忆、工具箱、设置和应用数据。";
        }
        if (id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
            return "工具箱管理开启后，角色可以创建和维护它自己写入的 REST 工具、REST 套件、组合工具和组合工具套件；系统会拒绝修改用户手动创建或内置内容。";
        }
        return "这是内置工具能力，开启后角色可以在聊天中按需获取并调用对应工具。";
    }

    function addRestPackage() {
        setDraftRestPackage(createRestToolPackage("新工具套件"));
    }
    function confirmDraftRestPackage() {
        if (!draftRestPackage) return;
        persistRestPackages([draftRestPackage, ...restPackages]);
        setDraftRestPackage(null);
    }
    function cancelDraftRestPackage() {
        setDraftRestPackage(null);
    }

    function addRestTool(packageId?: string) {
        setDraftRest(createRestTool("新工具", packageId));
    }
    function confirmDraftRest() {
        if (!draftRest) return;
        persistRest([draftRest, ...restTools]);
        setDraftRest(null);
    }
    function cancelDraftRest() {
        setDraftRest(null);
    }

    function addCompositePackage() {
        setDraftCompositePackage(createCompositeToolPackage("新组合套件"));
    }
    function confirmDraftCompositePackage() {
        if (!draftCompositePackage) return;
        persistCompositePackages([draftCompositePackage, ...compositePackages]);
        setDraftCompositePackage(null);
    }
    function cancelDraftCompositePackage() {
        setDraftCompositePackage(null);
    }

    function addCompositeTool(packageId?: string) {
        setDraftComposite(createCompositeTool("新组合工具", packageId));
    }
    function confirmDraftComposite() {
        if (!draftComposite) return;
        persistComposite([draftComposite, ...compositeTools]);
        setDraftComposite(null);
    }
    function cancelDraftComposite() {
        setDraftComposite(null);
    }

    function addMcpServer() {
        setDraftMcp(createMcpServer("新MCP服务器", ""));
    }
    function confirmDraftMcp() {
        if (!draftMcp) return;
        persistMcp([draftMcp, ...mcpServers]);
        setDraftMcp(null);
    }
    function cancelDraftMcp() {
        setDraftMcp(null);
    }

    function handleConfirmDelete() {
        if (!confirmDeleteId) return;
        if (confirmDeleteType === "rest") {
            persistRest(restTools.filter(t => t.id !== confirmDeleteId));
            if (editRestId === confirmDeleteId) setEditRestId(null);
        } else if (confirmDeleteType === "restPackage") {
            persistRestPackages(restPackages.filter(pkg => pkg.id !== confirmDeleteId));
            persistRest(restTools.filter(t => t.packageId !== confirmDeleteId));
            if (editRestPackageId === confirmDeleteId) setEditRestPackageId(null);
            if (editRestId && restTools.find(t => t.id === editRestId)?.packageId === confirmDeleteId) setEditRestId(null);
        } else if (confirmDeleteType === "composite") {
            persistComposite(compositeTools.filter(t => t.id !== confirmDeleteId));
            if (editCompositeId === confirmDeleteId) setEditCompositeId(null);
        } else if (confirmDeleteType === "compositePackage") {
            persistCompositePackages(compositePackages.filter(pkg => pkg.id !== confirmDeleteId));
            persistComposite(compositeTools.filter(t => t.packageId !== confirmDeleteId));
            if (editCompositePackageId === confirmDeleteId) setEditCompositePackageId(null);
            if (editCompositeId && compositeTools.find(t => t.id === editCompositeId)?.packageId === confirmDeleteId) setEditCompositeId(null);
        } else {
            persistMcp(mcpServers.filter(s => s.id !== confirmDeleteId));
            if (editMcpId === confirmDeleteId) setEditMcpId(null);
        }
        setConfirmDeleteId(null);
    }

    async function handleDiscover(server: McpServerConfig) {
        if (!server.url.trim()) return;
        setIsDiscovering(true);
        try {
            const tools = await discoverMcpTools(server.url, server);
            // Update draft or persisted server
            if (draftMcp?.id === server.id) {
                setDraftMcp(prev => prev ? { ...prev, discoveredTools: tools } : prev);
            } else {
                updateMcpServer(server.id, { discoveredTools: tools });
            }
        } catch (e) {
            setMcpNotice({ title: "发现工具失败", message: e instanceof Error ? e.message : "发现失败", error: true });
        } finally {
            setIsDiscovering(false);
        }
    }

    function buildExportEntries(): ToolExportEntry[] {
        const entries: ToolExportEntry[] = [];
        const restPackageIdSet = new Set(restPackages.map(pkg => pkg.id));
        const compositePackageIdSet = new Set(compositePackages.map(pkg => pkg.id));

        for (const tool of restTools.filter(t => !t.packageId || !restPackageIdSet.has(t.packageId))) {
            entries.push({
                key: `rest:${tool.id}`,
                label: tool.name,
                description: tool.description || "REST 单件工具",
                kind: "REST",
            });
        }
        for (const pkg of restPackages) {
            const children = restTools.filter(t => t.packageId === pkg.id);
            entries.push({
                key: `restPackage:${pkg.id}`,
                label: pkg.name,
                description: pkg.description || `${children.length} 个 REST 子工具`,
                kind: "REST 套件",
            });
            for (const tool of children) {
                entries.push({
                    key: `rest:${tool.id}`,
                    label: tool.name,
                    description: tool.description || `属于 ${pkg.name}`,
                    kind: "REST 子工具",
                });
            }
        }

        for (const tool of compositeTools.filter(t => !t.packageId || !compositePackageIdSet.has(t.packageId))) {
            entries.push({
                key: `composite:${tool.id}`,
                label: tool.name,
                description: tool.description || "组合单件工具",
                kind: "组合",
            });
        }
        for (const pkg of compositePackages) {
            const children = compositeTools.filter(t => t.packageId === pkg.id);
            entries.push({
                key: `compositePackage:${pkg.id}`,
                label: pkg.name,
                description: pkg.description || `${children.length} 个组合工具`,
                kind: "组合套件",
            });
            for (const tool of children) {
                entries.push({
                    key: `composite:${tool.id}`,
                    label: tool.name,
                    description: tool.description || `属于 ${pkg.name}`,
                    kind: "组合子工具",
                });
            }
        }

        for (const server of mcpServers) {
            entries.push({
                key: `mcp:${server.id}`,
                label: server.name,
                description: server.description || server.url || "MCP 服务器",
                kind: "MCP",
            });
        }
        return entries;
    }

    function buildExportFile(selectedKeys: string[]): ToolboxExportFile {
        const selected = new Set(selectedKeys);
        const restPackageIds = new Set<string>();
        const restToolIds = new Set<string>();
        const compositePackageIds = new Set<string>();
        const compositeToolIds = new Set<string>();
        const mcpServerIds = new Set<string>();
        const restPackageById = new Map(restPackages.map(pkg => [pkg.id, pkg]));
        const restToolById = new Map(restTools.map(tool => [tool.id, tool]));
        const compositePackageById = new Map(compositePackages.map(pkg => [pkg.id, pkg]));
        const compositeToolById = new Map(compositeTools.map(tool => [tool.id, tool]));

        for (const pkg of restPackages) {
            if (selected.has(`restPackage:${pkg.id}`)) {
                restPackageIds.add(pkg.id);
                restTools.filter(t => t.packageId === pkg.id).forEach(t => restToolIds.add(t.id));
            }
        }
        for (const tool of restTools) {
            if (selected.has(`rest:${tool.id}`)) {
                restToolIds.add(tool.id);
                if (tool.packageId) restPackageIds.add(tool.packageId);
            }
        }
        for (const pkg of compositePackages) {
            if (selected.has(`compositePackage:${pkg.id}`)) {
                compositePackageIds.add(pkg.id);
                compositeTools.filter(t => t.packageId === pkg.id).forEach(t => compositeToolIds.add(t.id));
            }
        }
        for (const tool of compositeTools) {
            if (selected.has(`composite:${tool.id}`)) {
                compositeToolIds.add(tool.id);
                if (tool.packageId) compositePackageIds.add(tool.packageId);
            }
        }
        for (const server of mcpServers) {
            if (selected.has(`mcp:${server.id}`)) mcpServerIds.add(server.id);
        }

        let changed = true;
        while (changed) {
            changed = false;
            for (const id of Array.from(compositeToolIds)) {
                const tool = compositeToolById.get(id);
                if (!tool) continue;
                for (const step of tool.steps) {
                    if (step.toolId && restToolById.has(step.toolId) && !restToolIds.has(step.toolId)) {
                        restToolIds.add(step.toolId);
                        const parentId = restToolById.get(step.toolId)?.packageId;
                        if (parentId) restPackageIds.add(parentId);
                        changed = true;
                    }
                    if (step.toolId && compositeToolById.has(step.toolId) && !compositeToolIds.has(step.toolId)) {
                        compositeToolIds.add(step.toolId);
                        const parentId = compositeToolById.get(step.toolId)?.packageId;
                        if (parentId) compositePackageIds.add(parentId);
                        changed = true;
                    }
                    if (step.serverId && !mcpServerIds.has(step.serverId)) {
                        mcpServerIds.add(step.serverId);
                        changed = true;
                    }
                }
            }
        }

        return {
            format: "ai-phone-toolbox",
            version: 1,
            exportedAt: new Date().toISOString(),
            restPackages: Array.from(restPackageIds).map(id => restPackageById.get(id)).filter(Boolean).map(item => cloneJson(item as RestToolPackageConfig)),
            restTools: Array.from(restToolIds).map(id => restToolById.get(id)).filter(Boolean).map(item => cloneJson(item as RestToolConfig)),
            compositePackages: Array.from(compositePackageIds).map(id => compositePackageById.get(id)).filter(Boolean).map(item => cloneJson(item as CompositeToolPackageConfig)),
            compositeTools: Array.from(compositeToolIds).map(id => compositeToolById.get(id)).filter(Boolean).map(item => cloneJson(item as CompositeToolConfig)),
            mcpServers: Array.from(mcpServerIds).map(id => mcpServers.find(server => server.id === id)).filter(Boolean).map(item => cloneJson(item as McpServerConfig)),
        };
    }

    function openExportDialog() {
        const entries = buildExportEntries();
        setExportSelection(entries.map(entry => entry.key));
        setShowExportDialog(true);
    }

    async function handleExportSelected() {
        if (exportSelection.length === 0) {
            setToolboxImportError("请至少选择一个要导出的工具。");
            return;
        }
        const exportData = buildExportFile(exportSelection);
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json;charset=utf-8" });
        await downloadFile(blob, `ai-phone-tools-${new Date().toISOString().slice(0, 10)}.json`);
        setShowExportDialog(false);
    }

    async function handleImportTools(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        if (!file) return;
        setToolboxImportError(null);
        setToolboxImportMessage(null);
        try {
            const parsed = JSON.parse(await file.text()) as Partial<ToolboxExportFile>;
            if (parsed.format !== "ai-phone-toolbox" || parsed.version !== 1) {
                throw new Error("这不是有效的工具箱导出文件。");
            }

            const importedRestPackages = Array.isArray(parsed.restPackages) ? parsed.restPackages : [];
            const importedRestTools = Array.isArray(parsed.restTools) ? parsed.restTools : [];
            const importedCompositePackages = Array.isArray(parsed.compositePackages) ? parsed.compositePackages : [];
            const importedCompositeTools = Array.isArray(parsed.compositeTools) ? parsed.compositeTools : [];
            const importedMcpServers = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
            if (
                importedRestPackages.length === 0
                && importedRestTools.length === 0
                && importedCompositePackages.length === 0
                && importedCompositeTools.length === 0
                && importedMcpServers.length === 0
            ) {
                throw new Error("文件里没有可导入的工具。");
            }

            const now = Date.now();
            const restPackageIdMap = new Map<string, string>();
            const restToolIdMap = new Map<string, string>();
            const restToolNameMap = new Map<string, string>();
            const compositePackageIdMap = new Map<string, string>();
            const compositeToolIdMap = new Map<string, string>();
            const compositeToolNameMap = new Map<string, string>();
            const mcpServerIdMap = new Map<string, string>();
            const existingRestPackageNames = new Set(restPackages.map(item => item.name));
            const existingRestToolNames = new Set(restTools.map(item => item.name));
            const existingCompositePackageNames = new Set(compositePackages.map(item => item.name));
            const existingCompositeToolNames = new Set(compositeTools.map(item => item.name));
            const existingMcpNames = new Set(mcpServers.map(item => item.name));
            const existingRestIds = new Set(restTools.map(item => item.id));
            const existingCompositeIds = new Set(compositeTools.map(item => item.id));
            const existingMcpIds = new Set(mcpServers.map(item => item.id));

            const nextRestPackages = importedRestPackages.map(pkg => {
                const id = createImportedToolId("rest_pkg");
                restPackageIdMap.set(pkg.id, id);
                return {
                    ...cloneJson(pkg),
                    id,
                    name: uniqueImportedName(pkg.name, existingRestPackageNames),
                    enabled: pkg.enabled !== false,
                    builtIn: false,
                    createdBy: pkg.createdBy || "user",
                    createdAt: now,
                    updatedAt: now,
                };
            });

            const nextRestTools = importedRestTools.map(tool => {
                const id = createImportedToolId("rest");
                restToolIdMap.set(tool.id, id);
                const name = uniqueImportedName(tool.name, existingRestToolNames);
                restToolNameMap.set(tool.name, name);
                return {
                    ...cloneJson(tool),
                    id,
                    packageId: tool.packageId ? restPackageIdMap.get(tool.packageId) : undefined,
                    name,
                    enabled: tool.enabled !== false,
                    builtIn: false,
                    createdBy: tool.createdBy || "user",
                    createdAt: now,
                    updatedAt: now,
                };
            });

            const nextMcpServers = importedMcpServers.map(server => {
                const id = createImportedToolId("mcp");
                mcpServerIdMap.set(server.id, id);
                const copy = cloneJson(server);
                delete copy.sessionId;
                return {
                    ...copy,
                    id,
                    name: uniqueImportedName(server.name, existingMcpNames),
                    enabled: server.enabled !== false,
                    createdAt: now,
                    updatedAt: now,
                };
            });

            const nextCompositePackages = importedCompositePackages.map(pkg => {
                const id = createImportedToolId("composite_pkg");
                compositePackageIdMap.set(pkg.id, id);
                return {
                    ...cloneJson(pkg),
                    id,
                    name: uniqueImportedName(pkg.name, existingCompositePackageNames),
                    enabled: pkg.enabled !== false,
                    builtIn: false,
                    createdBy: pkg.createdBy || "user",
                    createdAt: now,
                    updatedAt: now,
                };
            });

            for (const tool of importedCompositeTools) {
                const id = createImportedToolId("composite");
                compositeToolIdMap.set(tool.id, id);
                compositeToolNameMap.set(tool.name, uniqueImportedName(tool.name, existingCompositeToolNames));
            }

            const nextCompositeTools = importedCompositeTools.map(tool => {
                const id = compositeToolIdMap.get(tool.id) || createImportedToolId("composite");
                const name = compositeToolNameMap.get(tool.name) || tool.name;
                return {
                    ...cloneJson(tool),
                    id,
                    packageId: tool.packageId ? compositePackageIdMap.get(tool.packageId) : undefined,
                    name,
                    steps: (Array.isArray(tool.steps) ? tool.steps : []).map(step => {
                        const nextStep = cloneJson(step);
                        if (nextStep.toolId) {
                            const mappedToolId = restToolIdMap.get(nextStep.toolId) || compositeToolIdMap.get(nextStep.toolId);
                            if (mappedToolId) {
                                nextStep.toolId = mappedToolId;
                            } else if (
                                nextStep.toolType !== "internal"
                                && !existingRestIds.has(nextStep.toolId)
                                && !existingCompositeIds.has(nextStep.toolId)
                            ) {
                                delete nextStep.toolId;
                            }
                        }
                        if (nextStep.serverId) {
                            const mappedServerId = mcpServerIdMap.get(nextStep.serverId);
                            if (mappedServerId) {
                                nextStep.serverId = mappedServerId;
                            } else if (!existingMcpIds.has(nextStep.serverId)) {
                                delete nextStep.serverId;
                            }
                        }
                        if (nextStep.toolName) {
                            nextStep.toolName = restToolNameMap.get(nextStep.toolName)
                                || compositeToolNameMap.get(nextStep.toolName)
                                || nextStep.toolName;
                        }
                        return nextStep;
                    }),
                    enabled: tool.enabled !== false,
                    builtIn: false,
                    createdBy: tool.createdBy || "user",
                    createdAt: now,
                    updatedAt: now,
                };
            });

            persistRestPackages([...nextRestPackages, ...restPackages]);
            persistRest([...nextRestTools, ...restTools]);
            persistMcp([...nextMcpServers, ...mcpServers]);
            persistCompositePackages([...nextCompositePackages, ...compositePackages]);
            persistComposite([...nextCompositeTools, ...compositeTools]);

            const count = nextRestPackages.length + nextRestTools.length + nextCompositePackages.length + nextCompositeTools.length + nextMcpServers.length;
            setToolboxImportMessage(`导入完成：共导入 ${count} 个工具配置。`);
        } catch (error) {
            setToolboxImportError(error instanceof Error ? error.message : "导入失败。");
        } finally {
            event.target.value = "";
        }
    }

    useEffect(() => {
        setSubpageRightAction("toolbox", (
            <div className="relative">
                <button
                    type="button"
                    aria-label="工具菜单"
                    onClick={() => setToolsMenuOpen(open => !open)}
                    className="modal-header-btn modal-header-btn-muted"
                >
                    <MoreHorizontal size={20} />
                </button>
                {toolsMenuOpen && (
                    <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[132px] rounded-[14px] border border-black/10 bg-white p-1 shadow-xl">
                        <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-xs font-semibold text-gray-800 hover:bg-gray-100"
                            onClick={() => {
                                setToolsMenuOpen(false);
                                importFileRef.current?.click();
                            }}
                        >
                            <Upload size={14} />
                            导入工具
                        </button>
                        <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-xs font-semibold text-gray-800 hover:bg-gray-100"
                            onClick={() => {
                                setToolsMenuOpen(false);
                                openExportDialog();
                            }}
                        >
                            <Download size={14} />
                            导出工具
                        </button>
                    </div>
                )}
            </div>
        ));
        return () => setSubpageRightAction("toolbox", null);
    }, [setSubpageRightAction, toolsMenuOpen, restPackages, restTools, compositePackages, compositeTools, mcpServers]);

    // Active edit target: draft (new) or existing
    const editRestPackage = draftRestPackage || (editRestPackageId ? restPackages.find(pkg => pkg.id === editRestPackageId) : null);
    const isNewRestPackage = !!draftRestPackage;
    const editRest = draftRest || (editRestId ? restTools.find(t => t.id === editRestId) : null);
    const isNewRest = !!draftRest;
    const editCompositePackage = draftCompositePackage || (editCompositePackageId ? compositePackages.find(pkg => pkg.id === editCompositePackageId) : null);
    const isNewCompositePackage = !!draftCompositePackage;
    const editComposite = draftComposite || (editCompositeId ? compositeTools.find(t => t.id === editCompositeId) : null);
    const isNewComposite = !!draftComposite;
    const editMcp = draftMcp || (editMcpId ? mcpServers.find(s => s.id === editMcpId) : null);
    const isNewMcp = !!draftMcp;
    const restPackageIds = new Set(restPackages.map(pkg => pkg.id));
    const singleRestTools = restTools.filter(t => !t.packageId || !restPackageIds.has(t.packageId));
    const compositePackageIds = new Set(compositePackages.map(pkg => pkg.id));
    const singleCompositeTools = compositeTools.filter(t => !t.packageId || !compositePackageIds.has(t.packageId));
    const customAppToolGroups = Array.from(customAppTools.reduce((map, tool) => {
        const group = map.get(tool.appId) ?? [];
        group.push(tool);
        map.set(tool.appId, group);
        return map;
    }, new Map<string, CustomAppToolEntry[]>()).values());
    const editCustomAppTool = editCustomAppToolKey
        ? customAppTools.find(tool => customAppToolKey(tool) === editCustomAppToolKey) ?? null
        : null;
    const exportEntries = buildExportEntries();

    return (
        <div className="flex flex-col gap-[24px] h-full">
            <input
                ref={importFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImportTools}
            />
            {/* 通用：单条消息的工具循环轮数上限 */}
            <div className="ui-group-card !flex-row !items-center">
                <div className="flex-1 flex flex-col gap-1 min-w-0">
                    <span className="menu-label">工具轮数上限</span>
                    <span className="menu-desc !mt-0 !whitespace-normal">单条消息最多进行几轮工具调用（每轮一次模型请求，轮内条数不限）。连续干活的任务（如角色电脑跑命令）可调高</span>
                </div>
                <div className="shrink-0 w-[112px]">
                    <Select
                        value={String(maxToolRounds)}
                        onChange={e => handleMaxToolRoundsChange(Number(e.target.value))}
                    >
                        {[3, 5, 8, 12, 20].map(n => <option key={n} value={n}>{n === 5 ? "5（默认）" : n}</option>)}
                    </Select>
                </div>
            </div>
            {/* REST Tools */}
            <div className="flex justify-between items-center gap-3">
                <p className="settings-menu-section-title">Tools</p>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => addRestTool()}
                        className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95 focus:outline-none"
                    >
                        <Plus size={15} strokeWidth={1.8} />
                        <span>添加单件</span>
                    </button>
                    <button
                        type="button"
                        onClick={addRestPackage}
                        className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[18px] bg-black px-3 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                    >
                        <Plus size={14} strokeWidth={1.8} />
                        添加套件
                    </button>
                </div>
            </div>

            {restTools.length === 0 && restPackages.length === 0 ? (
                <div className="ui-empty-compact mt-2">
                    <div className="ui-icon-circle"><Wrench size={24} /></div>
                    <span className="menu-label font-semibold">没有工具</span>
                    <span className="menu-desc max-w-[240px]">可以创建单件 REST 工具，也可以创建套件后添加多个子工具。</span>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {singleRestTools.map(t => (
                        <div key={t.id} className="ui-group-card !flex-row !items-center">
                            <button onClick={() => setEditRestId(t.id)}
                                className="flex-1 min-w-0 bg-none border-none cursor-pointer py-2 px-0 text-left flex items-center gap-2 overflow-hidden">
                                <div className="flex-1 flex flex-col gap-1 min-w-0">
                                    <div className="flex items-center gap-[6px] min-w-0">
                                        <span className="menu-label truncate min-w-0">{t.name}</span>
                                        {t.builtIn && <span className="ui-badge shrink-0" data-variant="success">内置</span>}
                                        {t.createdBy === "ai" && <span className="ui-badge shrink-0">AI</span>}
                                    </div>
                                    <span className="menu-desc !mt-0 truncate">{t.description || "未配置"}</span>
                                </div>
                            </button>
                            <div className="flex items-center gap-3 shrink-0">
                                {!t.builtIn && (
                                    <button onClick={() => { setConfirmDeleteId(t.id); setConfirmDeleteType("rest"); }}
                                        className="ui-link-btn" data-variant="muted"><Trash2 size={14} /></button>
                                )}
                                <Toggle checked={t.enabled} onChange={v => updateRestTool(t.id, { enabled: v })} />
                            </div>
                        </div>
                    ))}

                    {restPackages.map(pkg => {
                        const children = restTools.filter(t => t.packageId === pkg.id);
                        return (
                            <div key={pkg.id} className="flex flex-col gap-1.5">
                                <div className="ui-group-card !flex-row !items-center">
                                    <button onClick={() => setEditRestPackageId(pkg.id)}
                                        className="flex-1 min-w-0 bg-none border-none cursor-pointer py-2 px-0 text-left flex items-center gap-2 overflow-hidden">
                                        <div className="flex-1 flex flex-col gap-1 min-w-0">
                                            <div className="flex items-center gap-[6px] min-w-0">
                                                <span className="menu-label truncate min-w-0">{pkg.name}</span>
                                                {pkg.builtIn && <span className="ui-badge shrink-0" data-variant="success">内置</span>}
                                                <span className="ui-badge shrink-0">{children.length} 个子工具</span>
                                            </div>
                                            <span className="menu-desc !mt-0 truncate">{pkg.description || "未配置"}</span>
                                        </div>
                                    </button>
                                    <div className="flex items-center gap-3 shrink-0">
                                        {!pkg.builtIn && (
                                            <>
                                                <button onClick={() => addRestTool(pkg.id)}
                                                    className="ui-link-btn" data-variant="muted"><Plus size={14} /></button>
                                                <button onClick={() => { setConfirmDeleteId(pkg.id); setConfirmDeleteType("restPackage"); }}
                                                    className="ui-link-btn" data-variant="muted"><Trash2 size={14} /></button>
                                            </>
                                        )}
                                        <Toggle checked={pkg.enabled} onChange={v => updateRestPackage(pkg.id, { enabled: v })} />
                                    </div>
                                </div>

                                <div className="ml-3 flex flex-col gap-1.5 border-l border-[var(--c-border)] pl-3">
                                    {children.length === 0 ? (
                                        <div className="ui-group-card py-2">
                                            <span className="menu-desc !mt-0">暂无子工具</span>
                                        </div>
                                    ) : children.map(t => (
                                        <div key={t.id} className="ui-group-card !flex-row !items-center py-2">
                                            <button onClick={() => setEditRestId(t.id)}
                                                className="flex-1 min-w-0 bg-none border-none cursor-pointer py-1 px-0 text-left flex items-center gap-2 overflow-hidden">
                                                <div className="flex-1 flex flex-col gap-1 min-w-0">
                                                    <div className="flex items-center gap-[6px] min-w-0">
                                                        <span className="menu-label truncate min-w-0">{t.name}</span>
                                                        {t.builtIn && <span className="ui-badge shrink-0" data-variant="success">内置</span>}
                                                        {t.createdBy === "ai" && <span className="ui-badge shrink-0">AI</span>}
                                                    </div>
                                                    <span className="menu-desc !mt-0 truncate">{t.description || "未配置"}</span>
                                                </div>
                                            </button>
                                            <div className="flex items-center gap-3 shrink-0">
                                                {!t.builtIn && (
                                                    <button onClick={() => { setConfirmDeleteId(t.id); setConfirmDeleteType("rest"); }}
                                                        className="ui-link-btn" data-variant="muted"><Trash2 size={14} /></button>
                                                )}
                                                <Toggle checked={t.enabled} onChange={v => updateRestTool(t.id, { enabled: v })} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Workflows */}
            <div className="flex justify-between items-center gap-3">
                <p className="settings-menu-section-title">Workflows</p>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => addCompositeTool()}
                        className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95 focus:outline-none"
                    >
                        <Plus size={15} strokeWidth={1.8} />
                        <span>添加单件</span>
                    </button>
                    <button
                        type="button"
                        onClick={addCompositePackage}
                        className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[18px] bg-black px-3 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                    >
                        <Plus size={14} strokeWidth={1.8} />
                        添加套件
                    </button>
                </div>
            </div>

            {compositeTools.length === 0 && compositePackages.length === 0 ? (
                <div className="ui-empty-compact mt-2"><span className="menu-desc">暂无 Workflows</span></div>
            ) : (
                <div className="flex flex-col gap-2">
                    {singleCompositeTools.map(t => (
                        <div key={t.id} className="ui-group-card !flex-row !items-center">
                            <button onClick={() => setEditCompositeId(t.id)}
                                className="flex-1 min-w-0 bg-none border-none cursor-pointer py-2 px-0 text-left flex items-center gap-2 overflow-hidden">
                                <div className="flex-1 flex flex-col gap-1 min-w-0">
                                    <div className="flex items-center gap-[6px] min-w-0">
                                        <span className="menu-label truncate min-w-0">{t.name}</span>
                                        {t.createdBy === "ai" && <span className="ui-badge shrink-0">AI</span>}
                                        <span className="ui-badge shrink-0">{t.steps.length} 步</span>
                                    </div>
                                    <span className="menu-desc !mt-0 truncate">{t.description || "未配置"}</span>
                                </div>
                            </button>
                            <div className="flex items-center gap-3 shrink-0">
                                {!t.builtIn && (
                                    <button onClick={() => { setConfirmDeleteId(t.id); setConfirmDeleteType("composite"); }}
                                        className="ui-link-btn" data-variant="muted"><Trash2 size={14} /></button>
                                )}
                                <Toggle checked={t.enabled} onChange={v => updateCompositeTool(t.id, { enabled: v })} />
                            </div>
                        </div>
                    ))}

                    {compositePackages.map(pkg => {
                        const children = compositeTools.filter(t => t.packageId === pkg.id);
                        const isExpanded = expandedCompositePackageIds.has(pkg.id);
                        return (
                            <div key={pkg.id} className="flex flex-col gap-1.5">
                                <div className="ui-group-card !flex-row !items-center">
                                    <button
                                        type="button"
                                        onClick={() => toggleCompositePackageExpanded(pkg.id)}
                                        aria-expanded={isExpanded}
                                        className="flex-1 min-w-0 bg-none border-none cursor-pointer py-2 px-0 text-left flex items-center gap-2 overflow-hidden">
                                        <span className="shrink-0 text-gray-500">
                                            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                        </span>
                                        <div className="flex-1 flex flex-col gap-1 min-w-0">
                                            <div className="flex items-center gap-[6px] min-w-0">
                                                <span className="menu-label truncate min-w-0">{pkg.name}</span>
                                                {pkg.createdBy === "ai" && <span className="ui-badge shrink-0">AI</span>}
                                                <span className="ui-badge shrink-0">{children.length} 个组合工具</span>
                                            </div>
                                            <span className="menu-desc !mt-0 truncate">{pkg.description || "未配置"}</span>
                                        </div>
                                    </button>
                                    <div className="flex items-center gap-3 shrink-0">
                                        <button
                                            type="button"
                                            onClick={() => setEditCompositePackageId(pkg.id)}
                                            className="ui-link-btn"
                                            data-variant="muted"
                                            aria-label="编辑组合套件"
                                        >
                                            <MoreHorizontal size={14} />
                                        </button>
                                        {!pkg.builtIn && (
                                            <>
                                                <button onClick={() => addCompositeTool(pkg.id)}
                                                    className="ui-link-btn" data-variant="muted"><Plus size={14} /></button>
                                                <button onClick={() => { setConfirmDeleteId(pkg.id); setConfirmDeleteType("compositePackage"); }}
                                                    className="ui-link-btn" data-variant="muted"><Trash2 size={14} /></button>
                                            </>
                                        )}
                                        <Toggle checked={pkg.enabled} onChange={v => updateCompositePackage(pkg.id, { enabled: v })} />
                                    </div>
                                </div>

                                {isExpanded && (
                                    <div className="ml-3 flex flex-col gap-1.5 border-l border-[var(--c-border)] pl-3">
                                        {children.length === 0 ? (
                                            <div className="ui-group-card py-2">
                                                <span className="menu-desc !mt-0">暂无组合工具</span>
                                            </div>
                                        ) : children.map(t => (
                                            <div key={t.id} className="ui-group-card !flex-row !items-center py-2">
                                                <button onClick={() => setEditCompositeId(t.id)}
                                                    className="flex-1 min-w-0 bg-none border-none cursor-pointer py-1 px-0 text-left flex items-center gap-2 overflow-hidden">
                                                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                                                        <div className="flex items-center gap-[6px] min-w-0">
                                                            <span className="menu-label truncate min-w-0">{t.name}</span>
                                                            {t.createdBy === "ai" && <span className="ui-badge shrink-0">AI</span>}
                                                            <span className="ui-badge shrink-0">{t.steps.length} 步</span>
                                                        </div>
                                                        <span className="menu-desc !mt-0 truncate">{t.description || "未配置"}</span>
                                                    </div>
                                                </button>
                                                <div className="flex items-center gap-3 shrink-0">
                                                    {!t.builtIn && (
                                                        <button onClick={() => { setConfirmDeleteId(t.id); setConfirmDeleteType("composite"); }}
                                                            className="ui-link-btn" data-variant="muted"><Trash2 size={14} /></button>
                                                    )}
                                                    <Toggle checked={t.enabled} onChange={v => updateCompositeTool(t.id, { enabled: v })} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Internal Capabilities */}
            <div className="flex justify-between items-center">
                <p className="settings-menu-section-title">Internal Capabilities</p>
            </div>

            <div className="flex flex-col gap-2">
                {/* 角色电脑的开关收进 设置 → 角色电脑，与小坊的开关放在一处 */}
                {internalCapabilities.filter(item => item.id !== AGENT_COMPUTER_CAPABILITY_ID).map(item => {
                    const summary = (
                        <div className="flex-1 flex flex-col gap-1 min-w-0">
                            <div className="flex items-center gap-[6px] min-w-0">
                                <span className="menu-label truncate min-w-0">{item.name}</span>
                                <span className="ui-badge shrink-0">内置</span>
                            </div>
                            <span className="menu-desc !mt-0 truncate">{item.description}</span>
                        </div>
                    );

                    return (
                        <div key={item.id} className="ui-group-card !flex-row !items-center">
                            <button onClick={() => setEditInternalId(item.id)}
                                className="flex-1 min-w-0 bg-none border-none cursor-pointer py-2 px-0 text-left flex items-center gap-2 overflow-hidden">
                                {summary}
                            </button>
                            <div className="flex items-center gap-3 shrink-0">
                                <Toggle
                                    checked={item.enabled && item.mode !== "off"}
                                    onChange={v => updateInternalCapability(item.id, {
                                        enabled: v,
                                        mode: v
                                            ? (isAutoOnlyInternalCapability(item.id) ? "auto" : (item.mode === "off" ? defaultInternalMode(item.id) : item.mode))
                                            : "off",
                                    })}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Custom APP Tools */}
            <div className="flex justify-between items-center">
                <p className="settings-menu-section-title">Custom APP Tools</p>
            </div>

            {customAppTools.length === 0 ? (
                <div className="ui-empty-compact mt-2">
                    <span className="menu-desc">暂无共享给聊天和其他 APP 的自定义 APP 工具</span>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {customAppToolGroups.map(group => {
                        const first = group[0];
                        if (group.length === 1) {
                            return (
                                <div key={customAppToolKey(first)} className="ui-group-card !flex-row !items-center">
                                    <button
                                        type="button"
                                        onClick={() => setEditCustomAppToolKey(customAppToolKey(first))}
                                        className="flex-1 min-w-0 bg-none border-none cursor-pointer py-2 px-0 text-left flex items-center gap-2 overflow-hidden"
                                    >
                                        {first.appIconDataUrl && <img src={first.appIconDataUrl} alt="" className="w-8 h-8 rounded-[8px] object-cover shrink-0" />}
                                        <div className="flex-1 flex flex-col gap-1 min-w-0">
                                            <div className="flex items-center gap-[6px] min-w-0">
                                                <span className="menu-label truncate min-w-0">{first.name}</span>
                                                <span className="ui-badge shrink-0">APP</span>
                                                <span className="ui-badge shrink-0">{first.appName}</span>
                                            </div>
                                            <span className="menu-desc !mt-0 truncate">{first.description || "来自自定义 APP 的聊天工具"}</span>
                                        </div>
                                    </button>
                                    <div className="flex items-center gap-3 shrink-0">
                                        <Toggle checked={isCustomAppToolEnabled(first)} onChange={v => void updateCustomAppToolEnabled(first, v)} />
                                    </div>
                                </div>
                            );
                        }
                        const groupEnabled = group.some(isCustomAppToolEnabled);
                        const isExpanded = expandedCustomAppGroupIds.has(first.appId);
                        return (
                            <div key={first.appId} className="flex flex-col gap-1.5">
                                <div className="ui-group-card !flex-row !items-center">
                                    <button
                                        type="button"
                                        onClick={() => toggleCustomAppGroupExpanded(first.appId)}
                                        aria-expanded={isExpanded}
                                        className="flex-1 min-w-0 bg-none border-none cursor-pointer py-2 px-0 text-left flex items-center gap-2 overflow-hidden">
                                        <span className="shrink-0 text-gray-500">
                                            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                        </span>
                                        {first.appIconDataUrl && <img src={first.appIconDataUrl} alt="" className="w-8 h-8 rounded-[8px] object-cover shrink-0" />}
                                        <div className="flex-1 flex flex-col gap-1 min-w-0">
                                            <div className="flex items-center gap-[6px] min-w-0">
                                                <span className="menu-label truncate min-w-0">{first.appName}工具</span>
                                                <span className="ui-badge shrink-0">APP</span>
                                                <span className="ui-badge shrink-0">{group.length} 个子工具</span>
                                            </div>
                                            <span className="menu-desc !mt-0 truncate">来自「{first.appName}」的自定义 APP 工具套件</span>
                                        </div>
                                    </button>
                                    <div className="flex items-center gap-3 shrink-0">
                                        <Toggle checked={groupEnabled} onChange={v => void updateCustomAppToolGroupEnabled(group, v)} />
                                    </div>
                                </div>
                                {isExpanded && (
                                <div className="ml-3 flex flex-col gap-1.5 border-l border-[var(--c-border)] pl-3">
                                    {group.map(tool => (
                                        <div key={customAppToolKey(tool)} className="ui-group-card !flex-row !items-center py-2">
                                            <button
                                                type="button"
                                                onClick={() => setEditCustomAppToolKey(customAppToolKey(tool))}
                                                className="flex-1 min-w-0 bg-none border-none cursor-pointer py-1 px-0 text-left flex items-center gap-2 overflow-hidden"
                                            >
                                                <div className="flex-1 flex flex-col gap-1 min-w-0">
                                                    <div className="flex items-center gap-[6px] min-w-0">
                                                        <span className="menu-label truncate min-w-0">{tool.name}</span>
                                                        <span className="ui-badge shrink-0">{customAppToolVisibilityLabel(tool)}</span>
                                                    </div>
                                                    <span className="menu-desc !mt-0 truncate">{tool.description || "未配置描述"}</span>
                                                </div>
                                            </button>
                                            <div className="flex items-center gap-3 shrink-0">
                                                <Toggle checked={isCustomAppToolEnabled(tool)} onChange={v => void updateCustomAppToolEnabled(tool, v)} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* MCP Servers */}
            <div className="flex justify-between items-center gap-3">
                <p className="settings-menu-section-title">MCP Servers</p>
                <button
                    onClick={addMcpServer}
                    className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[18px] bg-black px-3 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                >
                    <Plus size={14} strokeWidth={1.8} />
                    添加新MCP工具
                </button>
            </div>

            {mcpServers.length === 0 ? (
                <div className="ui-empty-compact mt-2"><span className="menu-desc">暂无 MCP 服务器</span></div>
            ) : (
                <div className="flex flex-col gap-2">
                    {mcpServers.map(s => (
                        <div key={s.id} className="ui-group-card !flex-row !items-center">
                            <button onClick={() => setEditMcpId(s.id)}
                                className="flex-1 min-w-0 bg-none border-none cursor-pointer py-2 px-0 text-left flex items-center gap-2 overflow-hidden">
                                <div className="flex-1 flex flex-col gap-1 min-w-0">
                                    <span className="menu-label truncate min-w-0">{s.name}</span>
                                    <span className="menu-desc !mt-0 truncate">
                                        {s.description || (s.discoveredTools ? `${s.discoveredTools.length} 个工具` : s.url ? "已配置" : "未配置")}
                                    </span>
                                </div>
                            </button>
                            <div className="flex items-center gap-3 shrink-0">
                                <button onClick={() => { setConfirmDeleteId(s.id); setConfirmDeleteType("mcp"); }}
                                    className="ui-link-btn" data-variant="muted"><Trash2 size={14} /></button>
                                <Toggle checked={s.enabled} onChange={v => updateMcpServer(s.id, { enabled: v })} />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* ── REST package edit modal ── */}
            {editRestPackage && (() => {
                const setP = (updates: Partial<RestToolPackageConfig>) => {
                    if (isNewRestPackage) setDraftRestPackage(prev => prev ? { ...prev, ...updates } : prev);
                    else updateRestPackage(editRestPackage.id, updates);
                };
                const onConfirm = () => { if (isNewRestPackage) confirmDraftRestPackage(); else setEditRestPackageId(null); };
                const onCancel = () => { if (isNewRestPackage) cancelDraftRestPackage(); else setEditRestPackageId(null); };
                const title = editRestPackage.builtIn ? editRestPackage.name : (isNewRestPackage ? "添加工具套件" : "编辑工具套件");
                const childCount = restTools.filter(t => t.packageId === editRestPackage.id).length;

                if (editRestPackage.builtIn) {
                    return (
                        <ContentDialog title={title} confirmLabel="完成" onConfirm={onConfirm} onCancel={onCancel}>
                            <div className="flex flex-col gap-3">
                                <span className="menu-desc">{editRestPackage.description}</span>
                                <span className="menu-desc">当前包含 {childCount} 个内置 REST 子工具。</span>
                            </div>
                        </ContentDialog>
                    );
                }

                return (
                    <ContentDialog title={title} confirmLabel={isNewRestPackage ? "创建" : "完成"} onConfirm={onConfirm} onCancel={onCancel}>
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">套件名称</label>
                                <Input value={editRestPackage.name} onChange={e => setP({ name: e.target.value })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">套件描述</label>
                                <Input value={editRestPackage.description} placeholder="例如：搜索、读取和整理网页内容" onChange={e => setP({ description: e.target.value })} />
                            </div>
                            {!isNewRestPackage && (
                                <div className="ui-group-card">
                                    <span className="menu-label">子工具</span>
                                    <span className="menu-desc !mt-0">当前包含 {childCount} 个 REST 子工具。</span>
                                    <button className="ui-link-btn self-start flex items-center gap-1" onClick={() => {
                                        setEditRestPackageId(null);
                                        addRestTool(editRestPackage.id);
                                    }}>
                                        <Plus size={14} /> 添加子工具
                                    </button>
                                </div>
                            )}
                        </div>
                    </ContentDialog>
                );
            })()}

            {/* ── REST tool edit modal ── */}
            {editRest && (() => {
                // Unified setter: updates draft or persisted storage
                const setR = (updates: Partial<RestToolConfig>) => {
                    if (isNewRest) setDraftRest(prev => prev ? { ...prev, ...updates } : prev);
                    else updateRestTool(editRest.id, updates);
                };
                const onConfirm = () => { if (isNewRest) confirmDraftRest(); else setEditRestId(null); };
                const onCancel = () => { if (isNewRest) cancelDraftRest(); else setEditRestId(null); };
                const title = editRest.builtIn ? editRest.name : (isNewRest ? "添加工具" : "编辑工具");

                if (editRest.builtIn) {
                    // Only tools that carry a key in fixedParams (weather/search) need an
                    // API Key field; keyless tools like 查看网页 (Jina Reader) don't.
                    const apiKeyField = Object.keys(editRest.fixedParams || {})[0];
                    return (
                        <ContentDialog title={title} confirmLabel="完成" onConfirm={onConfirm} onCancel={onCancel}>
                            <div className="flex flex-col gap-3">
                                <span className="menu-desc">{editRest.description}</span>
                                {apiKeyField && (
                                <div className="flex flex-col gap-1">
                                    <label className="menu-desc ml-1">API Key</label>
                                    <Input type="password" value={editRest.fixedParams?.[apiKeyField] ?? ""} placeholder="填入你的 API Key"
                                        onChange={e => setR({ fixedParams: { ...editRest.fixedParams, [apiKeyField]: e.target.value } })} />
                                    <span className="menu-desc ml-1">
                                        {editRest.id === "builtin_weather" && "去 weatherapi.com 免费注册获取"}
                                        {editRest.id === "builtin_search" && "去 tavily.com 免费注册获取"}
                                    </span>
                                </div>
                                )}
                                <div className="flex items-center justify-between gap-3">
                                    <span className="menu-desc">直连模式（跳过服务端代理，无超时限制）</span>
                                    <Toggle checked={editRest.directFetch ?? true} onChange={c => setR({ directFetch: c })} />
                                </div>
                            </div>
                        </ContentDialog>
                    );
                }

                return (
                    <ContentDialog title={title} confirmLabel={isNewRest ? "创建" : "完成"} onConfirm={onConfirm} onCancel={onCancel}>
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">工具名称</label>
                                <Input value={editRest.name} onChange={e => setR({ name: e.target.value })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">功能描述</label>
                                <Input value={editRest.description} placeholder="这个工具做什么" onChange={e => setR({ description: e.target.value })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">所属套件</label>
                                <Select value={editRest.packageId || ""} onChange={e => setR({ packageId: e.target.value || undefined })}>
                                    <option value="">不放入套件（单件工具）</option>
                                    {restPackages.filter(pkg => !pkg.builtIn).map(pkg => (
                                        <option key={pkg.id} value={pkg.id}>{pkg.name}</option>
                                    ))}
                                </Select>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">接口地址</label>
                                <Input value={editRest.endpoint} placeholder="https://api.example.com/..." onChange={e => setR({ endpoint: e.target.value })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">请求方式</label>
                                <Select value={editRest.method} onChange={e => setR({ method: e.target.value as "GET" | "POST" })}>
                                    <option value="GET">GET</option>
                                    <option value="POST">POST</option>
                                </Select>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="menu-desc">直连模式（跳过服务端代理，无超时限制）</span>
                                <Toggle checked={editRest.directFetch ?? true} onChange={c => setR({ directFetch: c })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">固定参数（API Key 等，不暴露给 AI）</label>
                                <FixedParamsEditor params={editRest.fixedParams || {}} onChange={fp => setR({ fixedParams: fp })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">请求头（可选）</label>
                                <FixedParamsEditor params={editRest.headers || {}} onChange={h => setR({ headers: h })}
                                    keyPlaceholder="Header 名" valuePlaceholder="Header 值" />
                                <span className="menu-desc ml-1">接口地址支持 {"{{参数名}}"} 转义插入、{"{{{参数名}}}"} 原样插入；请求头支持 {"{{参数名}}"}。</span>
                            </div>
                            {editRest.method === "POST" && (
                                <div className="flex flex-col gap-1">
                                    <label className="menu-desc ml-1">请求体模板（JSON，可选）</label>
                                    <Textarea
                                        className="font-mono ts-11"
                                        rows={5}
                                        value={editRest.bodyTemplate || ""}
                                        placeholder={`{\n  "input": "{{text}}",\n  "options": {\n    "tone": "{{style}}"\n  }\n}`}
                                        onChange={e => setR({ bodyTemplate: e.target.value })}
                                    />
                                    <span className="menu-desc ml-1">留空时沿用旧逻辑：把 AI 参数和固定参数合并后直接作为 POST JSON。</span>
                                </div>
                            )}
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">AI 参数定义（JSON Schema）</label>
                                <Textarea className="font-mono ts-11" rows={4} value={editRest.parameterSchema}
                                    onChange={e => setR({ parameterSchema: e.target.value })} />
                            </div>
                        </div>
                    </ContentDialog>
                );
            })()}

            {/* ── Composite package edit modal ── */}
            {editCompositePackage && (() => {
                const setP = (updates: Partial<CompositeToolPackageConfig>) => {
                    if (isNewCompositePackage) setDraftCompositePackage(prev => prev ? { ...prev, ...updates } : prev);
                    else updateCompositePackage(editCompositePackage.id, updates);
                };
                const onConfirm = () => { if (isNewCompositePackage) confirmDraftCompositePackage(); else setEditCompositePackageId(null); };
                const onCancel = () => { if (isNewCompositePackage) cancelDraftCompositePackage(); else setEditCompositePackageId(null); };
                const title = isNewCompositePackage ? "添加组合套件" : "编辑组合套件";
                const childCount = compositeTools.filter(t => t.packageId === editCompositePackage.id).length;

                return (
                    <ContentDialog title={title} confirmLabel={isNewCompositePackage ? "创建" : "完成"} onConfirm={onConfirm} onCancel={onCancel}>
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">套件名称</label>
                                <Input value={editCompositePackage.name} onChange={e => setP({ name: e.target.value })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">套件描述</label>
                                <Input value={editCompositePackage.description} placeholder="例如：网页研究、联系人整理、日程检查" onChange={e => setP({ description: e.target.value })} />
                            </div>
                            {!isNewCompositePackage && (
                                <div className="ui-group-card">
                                    <span className="menu-label">组合工具</span>
                                    <span className="menu-desc !mt-0">当前包含 {childCount} 个组合工具。</span>
                                    <button className="ui-link-btn self-start flex items-center gap-1" onClick={() => {
                                        setEditCompositePackageId(null);
                                        addCompositeTool(editCompositePackage.id);
                                    }}>
                                        <Plus size={14} /> 添加组合工具
                                    </button>
                                </div>
                            )}
                        </div>
                    </ContentDialog>
                );
            })()}

            {/* ── Composite tool edit modal ── */}
            {editComposite && (() => {
                const setC = (updates: Partial<CompositeToolConfig>) => {
                    if (isNewComposite) setDraftComposite(prev => prev ? { ...prev, ...updates } : prev);
                    else updateCompositeTool(editComposite.id, updates);
                };
                const onConfirm = () => { if (isNewComposite) confirmDraftComposite(); else setEditCompositeId(null); };
                const onCancel = () => { if (isNewComposite) cancelDraftComposite(); else setEditCompositeId(null); };
                const title = isNewComposite ? "添加组合工具" : "编辑组合工具";
                const parentCompositePackage = editComposite.packageId
                    ? compositePackages.find(pkg => pkg.id === editComposite.packageId)
                    : null;
                const belongsToBuiltInPackage = Boolean(editComposite.builtIn || parentCompositePackage?.builtIn);

                return (
                    <ContentDialog title={title} confirmLabel={isNewComposite ? "创建" : "完成"} onConfirm={onConfirm} onCancel={onCancel}>
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">工具名称</label>
                                <Input value={editComposite.name} onChange={e => setC({ name: e.target.value })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">功能描述</label>
                                <Input value={editComposite.description} placeholder="这个组合工具完成什么流程" onChange={e => setC({ description: e.target.value })} />
                            </div>
                            {belongsToBuiltInPackage ? (
                                <div className="flex flex-col gap-1">
                                    <label className="menu-desc ml-1">所属 Workflow</label>
                                    <div className="ui-group-card py-2">
                                        <span className="menu-label">{parentCompositePackage?.name || "内置 Workflow"}</span>
                                        <span className="menu-desc !mt-0">内置 Workflow 子工具，所属套件不可修改。</span>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-1">
                                    <label className="menu-desc ml-1">所属 Workflow</label>
                                    <Select value={editComposite.packageId || ""} onChange={e => setC({ packageId: e.target.value || undefined })}>
                                        <option value="">不放入 Workflow（单件组合工具）</option>
                                        {compositePackages.filter(pkg => !pkg.builtIn).map(pkg => (
                                            <option key={pkg.id} value={pkg.id}>{pkg.name}</option>
                                        ))}
                                    </Select>
                                </div>
                            )}
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">AI 参数定义（JSON Schema）</label>
                                <Textarea className="font-mono ts-11" rows={4} value={editComposite.parameterSchema}
                                    onChange={e => setC({ parameterSchema: e.target.value })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">执行步骤</label>
                                <CompositeStepsEditor steps={editComposite.steps} onChange={steps => setC({ steps })} />
                                <span className="menu-desc ml-1">参数模板支持 {"{{input.xxx}}"}、{"{{last.data}}"}、{"{{steps.名称.data}}"}；如果结果是 JSON，也可用 {"{{steps.名称.json}}"}。</span>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">最终返回模板（可选）</label>
                                <Textarea
                                    className="font-mono ts-11"
                                    rows={3}
                                    value={editComposite.outputTemplate || ""}
                                    placeholder="{{last.data}}"
                                    onChange={e => setC({ outputTemplate: e.target.value })}
                                />
                            </div>
                        </div>
                    </ContentDialog>
                );
            })()}

            {/* ── Custom APP tool details ── */}
            {editCustomAppTool && (
                <ContentDialog
                    title={editCustomAppTool.name}
                    confirmLabel="完成"
                    onConfirm={() => setEditCustomAppToolKey(null)}
                    onCancel={() => setEditCustomAppToolKey(null)}
                >
                    <div className="flex flex-col gap-3">
                        <div className="ui-group-card">
                            <span className="menu-label">来源应用</span>
                            <span className="menu-desc !mt-0">{editCustomAppTool.appName}</span>
                        </div>
                        <div className="ui-group-card">
                            <span className="menu-label">使用范围</span>
                            <span className="menu-desc !mt-0">{customAppToolVisibilityLabel(editCustomAppTool)}给普通聊天和其他 APP</span>
                        </div>
                        {editCustomAppTool.description && (
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">功能描述</label>
                                <div className="ui-group-card py-2">
                                    <span className="menu-desc !mt-0 whitespace-pre-wrap">{editCustomAppTool.description}</span>
                                </div>
                            </div>
                        )}
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Handler</label>
                            <div className="ui-group-card py-2">
                                <span className="menu-label">{editCustomAppTool.handler || editCustomAppTool.id}</span>
                                <span className="menu-desc !mt-0">由自定义 APP 页面注册并执行，工具箱不直接编辑。</span>
                            </div>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">AI 参数定义</label>
                            <pre className="ui-group-card max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                                {JSON.stringify(editCustomAppTool.parameterSchema || { type: "object", properties: {} }, null, 2)}
                            </pre>
                        </div>
                    </div>
                </ContentDialog>
            )}

            {/* ── MCP server edit modal ── */}
            {editMcp && (() => {
                const setM = (updates: Partial<McpServerConfig>) => {
                    if (isNewMcp) setDraftMcp(prev => prev ? { ...prev, ...updates } : prev);
                    else updateMcpServer(editMcp.id, updates);
                };
                const hasAuthHeader = (headers?: Record<string, string>) =>
                    Object.keys(headers || {}).some(k => k.trim().toLowerCase() === "authorization");
                // Token 会覆盖请求头里的 Authorization——在冲突刚形成时弹一次提醒，不在页面常驻
                const noticeTokenOverridesHeader = () => setMcpNotice({
                    title: "请求头 Authorization 将被忽略",
                    message: "「访问 Token」和请求头 Authorization 同时配置时，以 Token 栏为准，请求头里的 Authorization 不会发送。建议只保留一处。",
                    error: true,
                });
                const onConfirm = () => { if (isNewMcp) confirmDraftMcp(); else setEditMcpId(null); };
                const onCancel = () => { if (isNewMcp) cancelDraftMcp(); else setEditMcpId(null); };

                return (
                    <ContentDialog title={isNewMcp ? "添加 MCP 服务器" : "MCP 服务器"} confirmLabel={isNewMcp ? "创建" : "完成"} onConfirm={onConfirm} onCancel={onCancel}>
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">名称</label>
                                <Input value={editMcp.name} onChange={e => setM({ name: e.target.value })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">服务器 URL</label>
                                <Input value={editMcp.url} placeholder="https://mcp-server.example.com" onChange={e => setM({ url: e.target.value })} />
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="menu-desc">直连模式（浏览器直接请求，本机/内网 MCP 必开；需服务器允许 CORS，仅支持 Streamable HTTP）</span>
                                <Toggle className="flex-none" checked={editMcp.directFetch ?? false} onChange={c => setM({ directFetch: c })} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">工具描述</label>
                                <Input
                                    value={editMcp.description || ""}
                                    placeholder="例如：麦当劳点餐、查菜单、领券和下单"
                                    onChange={e => setM({ description: e.target.value })}
                                />
                                <span className="menu-desc ml-1">这段描述会和 MCP 名称一起发给 AI，具体工具列表不会默认塞进上下文。</span>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">访问 Token（可选）</label>
                                <Input
                                    type="password"
                                    value={editMcp.accessToken || ""}
                                    placeholder="需要鉴权的 MCP 填这里，会作为 Bearer Token 发送"
                                    onChange={e => {
                                        const nextToken = e.target.value.trim().replace(/^bearer\s+/i, "");
                                        if (nextToken && !editMcp.accessToken && hasAuthHeader(editMcp.headers)) noticeTokenOverridesHeader();
                                        setM({
                                        accessToken: nextToken,
                                        refreshToken: undefined,
                                        tokenExpiresAt: undefined,
                                        oauthClientId: undefined,
                                        oauthClientSecret: undefined,
                                        oauthTokenEndpoint: undefined,
                                        oauthAuthorizationEndpoint: undefined,
                                        oauthRegistrationEndpoint: undefined,
                                        oauthAuthorizationServer: undefined,
                                        oauthProtectedResourceMetadataUrl: undefined,
                                        });
                                    }}
                                />
                                <span className="menu-desc ml-1">适用于需要 `Authorization: Bearer TOKEN` 的 MCP 服务器。</span>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">请求头（可选）</label>
                                <FixedParamsEditor
                                    params={editMcp.headers || {}}
                                    onChange={headers => {
                                        if (editMcp.accessToken && !hasAuthHeader(editMcp.headers) && hasAuthHeader(headers)) noticeTokenOverridesHeader();
                                        setM({ headers });
                                    }}
                                    keyPlaceholder="Header 名"
                                    valuePlaceholder="Header 值"
                                />
                            </div>
                            {editMcp.url.trim() && (
                                <>
                                    <div className="modal-footer !p-0">
                                        <button className="ui-btn ui-btn-primary" onClick={() => handleDiscover(editMcp)}
                                            disabled={isDiscovering || !editMcp.url.trim()}>
                                            <Search size={14} /> {isDiscovering ? "发现中..." : "发现工具"}
                                        </button>
                                        <button className="ui-btn ui-btn-outline" onClick={async () => {
                                            setIsAuthorizing(true);
                                            const targetMcp = { ...editMcp };
                                            if (draftMcp?.id === editMcp.id) {
                                                persistMcp([targetMcp, ...mcpServers]);
                                                setDraftMcp(null);
                                                setEditMcpId(targetMcp.id);
                                            }
                                            const r = await startMcpOAuth(targetMcp);
                                            setIsAuthorizing(false);
                                            if (r.success) {
                                                setMcpServers(loadMcpServers());
                                                setMcpNotice({ title: "OAuth 授权成功", message: "已获取访问令牌，可以直接使用该 MCP 服务器。" });
                                            } else {
                                                setMcpNotice({ title: "OAuth 授权失败", message: r.error || "授权失败", error: true });
                                            }
                                        }} disabled={isAuthorizing || !editMcp.url.trim()}>
                                            {isAuthorizing ? "授权中..." : "OAuth 授权"}
                                        </button>
                                    </div>
                                    {editMcp.accessToken && <span className="menu-desc text-[var(--c-icon-green)]">✓ 已配置 Token</span>}
                                    {editMcp.discoveredTools && editMcp.discoveredTools.length > 0 && (
                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">已发现 {editMcp.discoveredTools.length} 个工具</label>
                                            {editMcp.discoveredTools.map((t, i) => (
                                                <div key={i} className="ui-group-card py-2">
                                                    <span className="menu-label">{t.name}</span>
                                                    <span className="menu-desc !mt-0">{t.description}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </ContentDialog>
                );
            })()}

            {/* ── Internal capability edit modal ── */}
            {editInternalId && (() => {
                const capability = internalCapabilities.find(item => item.id === editInternalId);
                if (!capability) return null;
                if (isAutoOnlyInternalCapability(capability.id)) {
                    return (
                        <ContentDialog
                            title={capability.name}
                            confirmLabel="我知道了"
                            cancelLabel=""
                            onConfirm={() => setEditInternalId(null)}
                            onCancel={() => setEditInternalId(null)}
                        >
                            <p className="menu-desc text-left leading-relaxed">{getAutoOnlyCapabilityDetail(capability.id)}</p>
                        </ContentDialog>
                    );
                }
                return (
                    <ContentDialog title={capability.name} confirmLabel="完成" onConfirm={() => setEditInternalId(null)} onCancel={() => setEditInternalId(null)}>
                        <div className="flex flex-col gap-3">
                            <span className="menu-desc">{capability.description}</span>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">执行模式</label>
                                <Select
                                    value={capability.mode}
                                    onChange={e => updateInternalCapability(capability.id, { mode: e.target.value as InternalCapabilityConfig["mode"], enabled: e.target.value !== "off" })}
                                >
                                    <option value="off">关闭</option>
                                    <option value="confirm">执行前确认</option>
                                    <option value="auto">自动执行</option>
                                </Select>
                            </div>
                            <div className="ui-group-card">
                                <span className="menu-label">建议</span>
                                <span className="menu-desc !mt-0">
                                    {capability.id === NOTE_WALL_CAPABILITY_ID || capability.id === MUSIC_CONTROL_CAPABILITY_ID
                                        ? "这是服务型工具，开启后日常提示词里只会出现服务入口，具体工具会在角色获取后返回。"
                                        : "默认使用“执行前确认”。这样角色可以提出工具请求，但真正落库前仍由你决定。"}
                                </span>
                            </div>
                        </div>
                    </ContentDialog>
                );
            })()}

            {/* Toolbox import/export dialogs */}
            {showExportDialog && (
                <ContentDialog title="导出工具" confirmLabel="导出" onConfirm={handleExportSelected} onCancel={() => setShowExportDialog(false)}>
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between gap-2">
                            <span className="menu-desc !mt-0">选择要导出的工具配置。</span>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    className="ui-link-btn"
                                    onClick={() => setExportSelection(exportEntries.map(entry => entry.key))}
                                >
                                    全选
                                </button>
                                <button
                                    type="button"
                                    className="ui-link-btn"
                                    data-variant="muted"
                                    onClick={() => setExportSelection([])}
                                >
                                    清空
                                </button>
                            </div>
                        </div>
                        {exportEntries.length === 0 ? (
                            <div className="ui-empty-compact">
                                <span className="menu-desc">暂无可导出的工具。</span>
                            </div>
                        ) : (
                            <div className="flex max-h-[46vh] flex-col gap-2 overflow-auto pr-1">
                                {exportEntries.map(entry => (
                                    <label key={entry.key} className="ui-group-card !flex-row !items-center gap-3 py-2">
                                        <input
                                            type="checkbox"
                                            checked={exportSelection.includes(entry.key)}
                                            onChange={e => setExportSelection(prev => (
                                                e.target.checked
                                                    ? Array.from(new Set([...prev, entry.key]))
                                                    : prev.filter(key => key !== entry.key)
                                            ))}
                                        />
                                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                <span className="menu-label truncate min-w-0">{entry.label}</span>
                                                <span className="ui-badge shrink-0">{entry.kind}</span>
                                            </div>
                                            <span className="menu-desc !mt-0 truncate">{entry.description}</span>
                                        </div>
                                    </label>
                                ))}
                            </div>
                        )}
                        <span className="menu-desc !mt-0">导出套件会自动包含它的子工具；组合工具会一并带上通过 ID 直接引用的工具。</span>
                    </div>
                </ContentDialog>
            )}

            {toolboxImportMessage && (
                <ConfirmDialog
                    title="工具导入完成"
                    message={toolboxImportMessage}
                    icon={Upload}
                    variant="action"
                    confirmLabel="我知道了"
                    cancelLabel=""
                    onConfirm={() => setToolboxImportMessage(null)}
                    onCancel={() => setToolboxImportMessage(null)}
                />
            )}

            {toolboxImportError && (
                <ConfirmDialog
                    title="工具导入/导出失败"
                    message={toolboxImportError}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="我知道了"
                    cancelLabel=""
                    onConfirm={() => setToolboxImportError(null)}
                    onCancel={() => setToolboxImportError(null)}
                />
            )}

            {mcpNotice && (
                <ConfirmDialog
                    title={mcpNotice.title}
                    message={mcpNotice.message}
                    icon={mcpNotice.error ? AlertCircle : Wrench}
                    variant={mcpNotice.error ? "danger" : "action"}
                    confirmLabel="我知道了"
                    cancelLabel=""
                    onConfirm={() => setMcpNotice(null)}
                    onCancel={() => setMcpNotice(null)}
                />
            )}

            {/* Delete confirm */}
            {confirmDeleteId && (
                <ConfirmDialog title="确认删除？" message="删除后无法恢复。是否继续？" icon={AlertCircle}
                    variant="danger" confirmLabel="确认删除" onConfirm={handleConfirmDelete} onCancel={() => setConfirmDeleteId(null)} />
            )}
        </div>
    );
}

function CompositeStepsEditor({
    steps,
    onChange,
}: {
    steps: CompositeToolStep[];
    onChange: (steps: CompositeToolStep[]) => void;
}) {
    function update(index: number, updates: Partial<CompositeToolStep>) {
        onChange(steps.map((step, i) => i === index ? { ...step, ...updates } : step));
    }
    function remove(index: number) {
        onChange(steps.filter((_, i) => i !== index));
    }
    function add() {
        onChange([
            ...steps,
            {
                id: `step_${Date.now()}`,
                toolType: "auto",
                toolName: "",
                argsTemplate: "{}",
                script: "",
                saveAs: `step${steps.length + 1}`,
            },
        ]);
    }

    return (
        <div className="flex flex-col gap-2">
            {steps.map((step, index) => (
                <div key={step.id || index} className="ui-group-card gap-2">
                    <div className="flex items-center justify-between gap-2">
                        <span className="menu-label">步骤 {index + 1}</span>
                        <button onClick={() => remove(index)} className="ui-link-btn" data-variant="muted"><Trash2 size={13} /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">类别</label>
                            <Select value={step.toolType || "auto"} onChange={e => update(index, { toolType: e.target.value as CompositeToolStep["toolType"] })}>
                                <option value="auto">自动</option>
                                <option value="rest">REST</option>
                                <option value="internal">内置能力</option>
                                <option value="mcp">MCP</option>
                                <option value="composite">组合工具</option>
                                <option value="script">脚本</option>
                            </Select>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">保存为</label>
                            <Input value={step.saveAs || ""} placeholder="search" onChange={e => update(index, { saveAs: e.target.value })} />
                        </div>
                    </div>
                    {step.toolType !== "script" && (
                        <>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">动作名称</label>
                                <Input value={step.toolName || ""} placeholder="例如：搜索 / 读取资料文件" onChange={e => update(index, { toolName: e.target.value })} />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <label className="menu-desc ml-1">工具 ID（可选）</label>
                                    <Input value={step.toolId || ""} placeholder="同名时填写" onChange={e => update(index, { toolId: e.target.value || undefined })} />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="menu-desc ml-1">MCP 服务器 ID（可选）</label>
                                    <Input value={step.serverId || ""} placeholder="MCP 同名时填写" onChange={e => update(index, { serverId: e.target.value || undefined })} />
                                </div>
                            </div>
                        </>
                    )}
                    {step.toolType === "script" && (
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">脚本（支持 await / return）</label>
                            <Textarea
                                className="font-mono ts-11"
                                rows={6}
                                value={step.script || ""}
                                placeholder={`const contacts = JSON.parse(steps.contacts.data);\nreturn contacts.map(item => item.value);`}
                                onChange={e => update(index, { script: e.target.value })}
                            />
                            <span className="menu-desc ml-1">可使用 input、steps、last、args、context，也可访问 window、localStorage、fetch、document。</span>
                        </div>
                    )}
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">参数模板（JSON）</label>
                        <Textarea
                            className="font-mono ts-11"
                            rows={3}
                            value={step.argsTemplate || "{}"}
                            placeholder={`{\n  "query": "{{input.query}}"\n}`}
                            onChange={e => update(index, { argsTemplate: e.target.value })}
                        />
                    </div>
                </div>
            ))}
            <button onClick={add} className="ui-link-btn self-start flex items-center gap-1">
                <Plus size={14} /> 添加步骤
            </button>
        </div>
    );
}

// ── Key-value editor ──
function FixedParamsEditor({
    params, onChange, keyPlaceholder = "参数名", valuePlaceholder = "参数值"
}: {
    params: Record<string, string>;
    onChange: (params: Record<string, string>) => void;
    keyPlaceholder?: string;
    valuePlaceholder?: string;
}) {
    const entries = Object.entries(params);
    function update(oldKey: string, newKey: string, value: string) {
        const next = { ...params }; if (oldKey !== newKey) delete next[oldKey]; next[newKey] = value; onChange(next);
    }
    function remove(key: string) { const next = { ...params }; delete next[key]; onChange(next); }

    return (
        <div className="flex flex-col gap-2">
            {entries.map(([key, value], i) => (
                <div key={i} className="flex gap-2 items-center">
                    {/* min-w-0：input 固有最小宽度 ~170px，不放开的话两个输入框会把窄弹窗撑出横向滚动 */}
                    <Input className="flex-1 min-w-0" value={key} placeholder={keyPlaceholder} onChange={e => update(key, e.target.value, value)} />
                    <Input className="flex-[2] min-w-0" value={value} placeholder={valuePlaceholder}
                        type={key.toLowerCase().includes("key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("secret") ? "password" : "text"}
                        onChange={e => update(key, key, e.target.value)} />
                    <button onClick={() => remove(key)} className="ui-link-btn" data-variant="muted"><Trash2 size={13} /></button>
                </div>
            ))}
            <button onClick={() => onChange({ ...params, [""]: "" })} className="ui-link-btn self-start flex items-center gap-1">
                <Plus size={14} /> 添加
            </button>
        </div>
    );
}
