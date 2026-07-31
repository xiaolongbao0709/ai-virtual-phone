"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FileJson,
  HardDrive,
  ImageIcon,
  Info,
  Layers,
  Pencil,
  PackageCheck,
  RefreshCw,
  Search,
  LoaderCircle,
  Sparkles,
  Store,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { customAppGlyphPath } from "@/components/icon-glyph";

import { CUSTOM_APP_CREATOR_GUIDE_MD } from "@/lib/custom-app-creator-guide";
import { permissionLabelWithContext } from "@/lib/custom-app-permission-labels";
import { submitContentReport } from "@/lib/moderation-client";
import {
  fetchCustomAppMarketItems,
  fetchMyCustomAppMarketItems,
  deleteCustomAppMarketItem,
  publishCustomAppMarketItem,
  recordCustomAppInstall,
  updateCustomAppMarketItem,
  uploadCustomAppPackageAsset,
  validateCustomAppMarketItem,
} from "@/lib/custom-app-market-client";
import type { CustomAppMarketItem } from "@/lib/custom-app-market-types";
import {
  applyCustomAppRegistrationsAsync,
  formatCustomAppRegistrationRemovalSummary,
  formatCustomAppRegistrationSummary,
  removeCustomAppRegistrationsAsync,
} from "@/lib/custom-app-registration";
import {
  CUSTOM_APPS_UPDATED_EVENT,
  installCustomAppAsync,
  loadCustomAppPackage,
  loadInstalledCustomApps,
  loadSingleHtmlCustomApp,
  normalizeCustomAppManifestId,
  saveInstalledCustomApps,
  uninstallCustomAppAsync,
} from "@/lib/custom-app-storage";
import type { CustomAppManifest, CustomAppPermission, CustomAppResourceDeclarations, InstalledCustomApp } from "@/lib/custom-app-types";
import {
  loadCustomAppMarketPackageApp,
  newestCustomAppMarketItem,
  updateInstalledCustomAppFromMarket as updateInstalledCustomAppFromMarketPackage,
} from "@/lib/custom-app-market-update";

type AppMarketAppProps = {
  onClose: () => void;
  onOpenCustomApp: (appId: string) => void;
  onInstallToDesktop: (app: InstalledCustomApp) => void;
  onNotice?: (message: string) => void;
  launchContext?: Record<string, unknown> | null;
};

type AppMarketTab = "discover" | "installed" | "create";

type ManualUploadFiles = {
  manifest: File | null;
  entry: File | null;
  icon: File | null;
  presets: File | null;
  regex: File | null;
  worldBooks: File | null;
  bindings: File | null;
  assets: File[];
};

const EMPTY_MANUAL_FILES: ManualUploadFiles = {
  manifest: null,
  entry: null,
  icon: null,
  presets: null,
  regex: null,
  worldBooks: null,
  bindings: null,
  assets: [],
};

const DECLARATION_FILES = [
  { file: "presets.json", label: "预设", icon: Layers },
  { file: "regex.json", label: "正则", icon: Sparkles },
  { file: "worldbooks.json", label: "世界书", icon: FileJson },
  { file: "bindings.json", label: "默认绑定", icon: CheckCircle2 },
] as const;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatPackageSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "未知大小";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePackagePath(value: string, fallback: string): string {
  const text = (value || fallback).replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "").trim();
  return text || fallback;
}

function resourceKeyForPath(path: string): keyof CustomAppResourceDeclarations | null {
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  if (file === "presets.json") return "presets";
  if (file === "regex.json" || file === "regexes.json") return "regexes";
  if (file === "worldbook.json" || file === "worldbooks.json") return "worldBooks";
  if (file === "bindings.json") return "bindings";
  if (file === "tools.json") return "tools";
  if (file === "voices.json") return "voices";
  return null;
}

function appendResourcePath(resources: CustomAppResourceDeclarations, key: keyof CustomAppResourceDeclarations, path: string): void {
  const current = resources[key] ?? [];
  if (!current.includes(path)) resources[key] = [...current, path];
}

function replaceResourcePath(resources: CustomAppResourceDeclarations, key: keyof CustomAppResourceDeclarations, path: string): void {
  resources[key] = path ? [path] : [];
}

function normalizeManualResources(value: unknown): CustomAppResourceDeclarations {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as CustomAppResourceDeclarations : {};
  return {
    presets: [...(record.presets ?? [])],
    regexes: [...(record.regexes ?? [])],
    worldBooks: [...(record.worldBooks ?? [])],
    bindings: [...(record.bindings ?? [])],
    tools: [...(record.tools ?? [])],
    voices: [...(record.voices ?? [])],
    assets: [...(record.assets ?? [])],
  };
}

function appWithVersion(app: InstalledCustomApp, versionInput: string): InstalledCustomApp {
  const version = versionInput.trim() || app.version || "1.0.0";
  return {
    ...app,
    version,
    manifest: {
      ...app.manifest,
      version,
      permissions: app.permissions,
    },
  };
}

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return new Uint8Array();
  const meta = dataUrl.slice(0, comma).toLowerCase();
  const payload = dataUrl.slice(comma + 1);
  if (meta.includes(";base64")) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

function resourcePathsForKey(resources: CustomAppResourceDeclarations, key: keyof CustomAppResourceDeclarations): string[] {
  return (resources[key] ?? []).map(path => normalizePackagePath(path, path)).filter(Boolean);
}

function findAssetPath(app: InstalledCustomApp | null, filename: string): string {
  if (!app) return "";
  const lower = filename.toLowerCase();
  return Object.values(app.assets).find(asset => asset.path.toLowerCase() === lower)?.path ?? "";
}

function existingDeclarationPath(
  app: InstalledCustomApp | null,
  manifest: CustomAppManifest | undefined,
  key: keyof CustomAppResourceDeclarations,
  fallback: string,
): string {
  const fromManifest = manifest ? resourcePathsForKey(normalizeManualResources(manifest.resources), key)[0] : "";
  return fromManifest || findAssetPath(app, fallback);
}

function existingOtherAssetPaths(app: InstalledCustomApp | null, manifest: CustomAppManifest | undefined): string[] {
  const resources = normalizeManualResources(manifest?.resources);
  const reserved = new Set([
    "manifest.json",
    normalizePackagePath(manifest?.entry || "index.html", "index.html"),
    normalizePackagePath(manifest?.icon || "icon.png", "icon.png"),
    "presets.json",
    "regex.json",
    "worldbooks.json",
    "bindings.json",
    ...resourcePathsForKey(resources, "presets"),
    ...resourcePathsForKey(resources, "regexes"),
    ...resourcePathsForKey(resources, "worldBooks"),
    ...resourcePathsForKey(resources, "bindings"),
  ].map(path => path.toLowerCase()));
  const paths = new Set<string>();
  for (const path of resourcePathsForKey(resources, "assets")) {
    const normalized = normalizePackagePath(path, path);
    if (normalized && !reserved.has(normalized.toLowerCase())) paths.add(normalized);
  }
  if (app) {
    for (const asset of Object.values(app.assets)) {
      const normalized = normalizePackagePath(asset.path, asset.path);
      if (normalized && !reserved.has(normalized.toLowerCase())) paths.add(normalized);
    }
  }
  return Array.from(paths);
}

function fileSlotLabel(selected: File | null, existingPath: string, fallback: string, loading = false): string {
  if (selected) return selected.name;
  if (existingPath) return `当前：${existingPath}`;
  if (loading) return "正在读取线上文件…";
  return fallback;
}

function assetSlotLabel(selected: File[], existingPaths: string[], fallback: string, loading = false): string {
  if (selected.length > 0) return `${selected.length} 个文件`;
  if (existingPaths.length > 0) {
    const preview = existingPaths.slice(0, 2).join("、");
    return existingPaths.length > 2 ? `当前：${existingPaths.length} 个资源 · ${preview}…` : `当前：${preview}`;
  }
  if (loading) return "正在读取线上文件…";
  return fallback;
}

function appNameFromEntryPath(path: string): string {
  const filename = path.split("/").pop() || "custom-app";
  return filename.replace(/\.[^.]+$/, "").trim() || "custom-app";
}

async function createPackageFileFromApp(app: InstalledCustomApp): Promise<File> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const manifest: CustomAppManifest = {
    ...app.manifest,
    name: app.name,
    version: app.version,
    author: app.author,
    description: app.description,
    permissions: app.permissions,
  };
  const entryPath = normalizePackagePath(manifest.entry || "index.html", "index.html");
  zip.file(entryPath, app.entryHtml);
  for (const asset of Object.values(app.assets)) {
    const path = normalizePackagePath(asset.path, asset.path);
    if (!path || path === "manifest.json" || path === entryPath) continue;
    zip.file(path, bytesFromDataUrl(asset.dataUrl));
  }
  zip.file("manifest.json", JSON.stringify({ ...manifest, entry: entryPath }, null, 2));
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
  const manifestId = normalizeCustomAppManifestId(manifest.id, app.name);
  return new File([blob], `${manifestId}-${app.version}.zip`, { type: "application/zip" });
}

function statusLabel(status: CustomAppMarketItem["reviewStatus"]): string {
  if (status === "approved") return "已上架";
  if (status === "rejected") return "未通过";
  return "待上架";
}

function hasDeclaration(app: InstalledCustomApp | null, filename: string): boolean {
  if (!app) return false;
  return Object.values(app.assets).some(asset => asset.path.toLowerCase() === filename.toLowerCase());
}

function declarationCount(app: InstalledCustomApp | null): number {
  return DECLARATION_FILES.filter(item => hasDeclaration(app, item.file)).length;
}

// 没传图标的 APP:按名字哈希稳定地选一个 mdi 字形——和桌面图标同一套形状体系,
// 同一个 APP 在市场/桌面/已安装各处字形一致;颜色沿用市场页原来的统一蓝,不花哨。
function AppIcon({ iconDataUrl, seed = "", className = "" }: {
  iconDataUrl?: string;
  seed?: string;
  className?: string;
}) {
  if (iconDataUrl) {
    return (
      <span className={`app-market-app-icon ${className}`}>
        <img src={iconDataUrl} alt="" />
      </span>
    );
  }
  return (
    <span className={`app-market-app-icon ${className}`}>
      <svg viewBox="0 0 24 24" style={{ width: "58%", height: "58%" }} aria-hidden>
        <path d={customAppGlyphPath(seed)} fill="currentColor" />
      </svg>
    </span>
  );
}

export function AppMarketApp({ onClose, onOpenCustomApp, onInstallToDesktop, onNotice, launchContext }: AppMarketAppProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const localPkgRef = useRef<HTMLInputElement | null>(null);
  const localUpdateTargetRef = useRef<InstalledCustomApp | null>(null);
  const manualLoadSeqRef = useRef(0);
  const consumedLaunchTargetRef = useRef("");
  const [tab, setTab] = useState<AppMarketTab>("discover");
  const [apps, setApps] = useState<InstalledCustomApp[]>(() => loadInstalledCustomApps());
  const [marketApps, setMarketApps] = useState<CustomAppMarketItem[]>([]);
  const [myMarketApps, setMyMarketApps] = useState<CustomAppMarketItem[]>([]);
  // 市场数据是否至少完成过一轮拉取:没完成前不能做"本地测试"归类——老版安装
  // (无 marketItemId 标记)要靠市场数据排除,数据没到就归类会把别人发布的 APP
  // 漏进本地测试,给非创作者暴露换包/编辑入口
  const [marketReady, setMarketReady] = useState(false);
  const [pendingApp, setPendingApp] = useState<InstalledCustomApp | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [selectedMarketApp, setSelectedMarketApp] = useState<CustomAppMarketItem | null>(null);
  const [selectedInstalledApp, setSelectedInstalledApp] = useState<InstalledCustomApp | null>(null);
  const [marketEditTarget, setMarketEditTarget] = useState<CustomAppMarketItem | null>(null);
  // 本地测试 APP 的"编辑"目标：确认本机测试安装时按它的运行时 id 原地替换（数据保留）
  const [localEditTarget, setLocalEditTarget] = useState<InstalledCustomApp | null>(null);
  const [confirmMarketDelete, setConfirmMarketDelete] = useState<CustomAppMarketItem | null>(null);
  const [publishVersion, setPublishVersion] = useState("");
  const [publishChangelog, setPublishChangelog] = useState("");
  const [manualFiles, setManualFiles] = useState<ManualUploadFiles>(EMPTY_MANUAL_FILES);
  const [manualFileInputKey, setManualFileInputKey] = useState(0);
  const [manualExistingApp, setManualExistingApp] = useState<InstalledCustomApp | null>(null);
  const [manualExistingLoading, setManualExistingLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [marketBusy, setMarketBusy] = useState(false);
  const [reportTarget, setReportTarget] = useState<CustomAppMarketItem | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportedMarketAppIds, setReportedMarketAppIds] = useState<Record<string, boolean>>({});
  const [marketRefreshing, setMarketRefreshing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [updatingInstalledId, setUpdatingInstalledId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [errorDialog, setErrorDialog] = useState<{ title: string; message: string } | null>(null);
  const [marketError, setMarketError] = useState("");
  const [installedActionError, setInstalledActionError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<InstalledCustomApp | null>(null);
  const [creatorGuideOpen, setCreatorGuideOpen] = useState(false);
  const [manualBuilderOpen, setManualBuilderOpen] = useState(false);
  const marketRefreshCountRef = useRef(0);

  const installedById = useMemo(() => new Map(apps.map(app => [app.id, app])), [apps]);
  const marketItemByAppId = useMemo(() => {
    const map = new Map<string, CustomAppMarketItem>();
    for (const item of [...marketApps, ...myMarketApps]) {
      const existing = map.get(item.appId);
      if (!existing || new Date(item.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
        map.set(item.appId, item);
      }
    }
    return map;
  }, [marketApps, myMarketApps]);
  // "本地测试"只列没发布到市场的本地 APP，已发布的留在"我的发布"里，避免同一个 APP 两处重复出现。
  // 运行时 id 每次安装都会变（卸载重装后就对不上发布记录了），所以按包内稳定身份判重：
  // manifest.id 优先，名字兜底（本机安装本来就强制名字唯一）。
  const localTestApps = useMemo(() => {
    // 市场数据没到位前不归类:此时无法排除老版安装的别人 APP,宁可先空着
    if (!marketReady) return [];
    const norm = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const publishedManifestIds = new Set(myMarketApps.map(item => norm(item.manifest?.id)).filter(Boolean));
    const publishedNames = new Set(myMarketApps.map(item => norm(item.name)).filter(Boolean));
    return apps.filter(app => {
      // 从应用广场安装的(含别人发布的)绝不进本地测试——不能对别人的APP提供换包/编辑
      if (app.marketItemId) return false;
      // 旧版安装没有 marketItemId 标记:市场安装的运行时 id 等于市场条目的 appId,按此兜底排除
      if (marketItemByAppId.has(app.id)) return false;
      // 自己发布过的留在「我的发布」里,不重复出现
      const manifestId = norm(app.manifest?.id);
      const name = norm(app.name);
      if (manifestId && publishedManifestIds.has(manifestId)) return false;
      if (name && publishedNames.has(name)) return false;
      return true;
    });
  }, [apps, myMarketApps, marketItemByAppId, marketReady]);

  // 老版安装的市场 APP 没有 marketItemId 标记,每次进场都得等市场数据才能归类。
  // 首轮市场数据到位后把能对上号的安装记录回填标记,一次持久化,之后进场瞬间
  // 就能本地判定(也顺带让老安装吃到市场更新检查)。
  useEffect(() => {
    if (!marketReady || marketItemByAppId.size === 0) return;
    const current = loadInstalledCustomApps();
    let changed = false;
    const next = current.map(app => {
      if (app.marketItemId) return app;
      const item = marketItemByAppId.get(app.id);
      if (!item) return app;
      changed = true;
      return { ...app, marketItemId: item.id };
    });
    if (changed) {
      saveInstalledCustomApps(next);
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketReady, marketItemByAppId]);
  const filteredMarketApps = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return marketApps;
    return marketApps.filter(item => [
      item.name,
      item.authorName,
      item.description ?? "",
      item.appId,
    ].some(value => value.toLowerCase().includes(keyword)));
  }, [marketApps, query]);

  const refresh = () => setApps(loadInstalledCustomApps());

  function showErrorDialog(message: unknown, title = "操作失败") {
    const text = message instanceof Error ? message.message : String(message || "请稍后再试。");
    setErrorDialog({ title, message: text });
  }

  function refreshCurrentView() {
    refresh();
    void refreshMarket();
  }

  async function refreshMarket() {
    marketRefreshCountRef.current += 1;
    setMarketRefreshing(true);
    setMarketBusy(true);
    setMarketError("");
    try {
      const [publicApps, ownApps] = await Promise.all([
        fetchCustomAppMarketItems(),
        fetchMyCustomAppMarketItems(),
      ]);
      setMarketApps(publicApps);
      setMyMarketApps(ownApps);
    } catch (err) {
      setMarketError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarketBusy(false);
      marketRefreshCountRef.current = Math.max(0, marketRefreshCountRef.current - 1);
      if (marketRefreshCountRef.current === 0) setMarketRefreshing(false);
      // 失败也放行(回到旧行为),否则离线时创作者的本地测试区会被永远锁空
      setMarketReady(true);
    }
  }

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
  }, []);

  useEffect(() => {
    void refreshMarket();
  }, []);

  useEffect(() => {
    setInstalledActionError("");
  }, [selectedInstalledApp?.id]);

  useEffect(() => {
    const targetId = typeof launchContext?.selectedInstalledAppId === "string"
      ? launchContext.selectedInstalledAppId.trim()
      : "";
    if (!targetId) {
      consumedLaunchTargetRef.current = "";
      return;
    }
    if (consumedLaunchTargetRef.current === targetId) return;
    const installed = apps.find(app => app.id === targetId);
    if (!installed) return;
    consumedLaunchTargetRef.current = targetId;
    setTab("installed");
    setSelectedInstalledApp(installed);
  }, [apps, launchContext?.selectedInstalledAppId]);

  function openImporter() {
    setMarketEditTarget(null);
    setLocalEditTarget(null);
    setTab("create");
    fileRef.current?.click();
  }

  async function copyCreatorGuide() {
    try {
      await navigator.clipboard.writeText(CUSTOM_APP_CREATOR_GUIDE_MD);
      onNotice?.("制作说明已复制");
    } catch {
      onNotice?.("复制失败，请手动选择文本复制");
    }
  }

  function updateManualFile(field: keyof ManualUploadFiles, files: FileList | null) {
    if (field === "assets") {
      setManualFiles(current => ({ ...current, assets: files ? Array.from(files) : [] }));
      return;
    }
    setManualFiles(current => ({ ...current, [field]: files?.[0] ?? null }));
  }

  function resetManualFiles() {
    setManualFiles(EMPTY_MANUAL_FILES);
    setManualFileInputKey(current => current + 1);
  }

  function closeManualBuilder() {
    if (busy) return;
    manualLoadSeqRef.current += 1;
    setManualBuilderOpen(false);
    setManualExistingApp(null);
    setManualExistingLoading(false);
  }

  // 编辑本地测试 APP：直接以本机安装的包为底稿打开单文件编辑器，不用下载线上包
  function openLocalManualBuilder(app: InstalledCustomApp) {
    manualLoadSeqRef.current += 1;
    setLocalEditTarget(app);
    setMarketEditTarget(null);
    setPendingApp(null);
    setSourceFile(null);
    setManualFiles(EMPTY_MANUAL_FILES);
    setManualExistingApp(app);
    setManualExistingLoading(false);
    setPublishVersion(app.version);
    setPublishChangelog("");
    setManualBuilderOpen(true);
    setManualFileInputKey(current => current + 1);
  }

  function openManualBuilder(item?: CustomAppMarketItem) {
    const loadSeq = manualLoadSeqRef.current + 1;
    manualLoadSeqRef.current = loadSeq;
    setMarketEditTarget(item ?? null);
    setLocalEditTarget(null);
    setPendingApp(null);
    setSourceFile(null);
    setManualFiles(EMPTY_MANUAL_FILES);
    setManualExistingApp(null);
    setManualExistingLoading(Boolean(item));
    setPublishVersion(item?.version ?? "");
    setPublishChangelog(item?.changelog ?? "");
    setManualBuilderOpen(true);
    setManualFileInputKey(current => current + 1);
    if (item) {
      void loadCustomAppMarketPackageApp(item)
        .then(app => {
          if (manualLoadSeqRef.current !== loadSeq) return;
          setManualExistingApp(app);
        })
        .catch(err => {
          if (manualLoadSeqRef.current !== loadSeq) return;
          showErrorDialog(err instanceof Error ? `读取线上包失败：${err.message}` : `读取线上包失败：${String(err)}`);
        })
        .finally(() => {
          if (manualLoadSeqRef.current === loadSeq) setManualExistingLoading(false);
        });
    }
  }

  function startMarketPackageUpdate(item: CustomAppMarketItem) {
    setMarketEditTarget(item);
    setLocalEditTarget(null);
    setPendingApp(null);
    setSourceFile(null);
    setPublishVersion(item.version);
    setPublishChangelog("");
    setManualFiles(EMPTY_MANUAL_FILES);
    setTab("create");
    fileRef.current?.click();
  }

  function cancelMarketUpdate() {
    setMarketEditTarget(null);
    setPendingApp(null);
    setSourceFile(null);
    setPublishVersion("");
    setPublishChangelog("");
  }

  // 本地测试换包：给某个已装 APP 直接选一个新包原地替换，沿用它的运行时 id（数据、桌面图标都在），
  // 不走"新安装"那套 id 逻辑，避免误替换别的同名 APP。
  function startLocalPackageUpdate(app: InstalledCustomApp) {
    localUpdateTargetRef.current = app;
    if (localPkgRef.current) {
      localPkgRef.current.value = "";
      localPkgRef.current.click();
    }
  }

  async function handleLocalPackageUpdate(file: File | null | undefined) {
    const target = localUpdateTargetRef.current;
    localUpdateTargetRef.current = null;
    if (localPkgRef.current) localPkgRef.current.value = "";
    if (!file || !target) return;
    setBusy(true);
    try {
      const lower = file.name.toLowerCase();
      const loaded = lower.endsWith(".html") || lower.endsWith(".htm")
        ? await loadSingleHtmlCustomApp(file)
        : await loadCustomAppPackage(file);
      const replaced: InstalledCustomApp = { ...loaded, id: target.id, installedAt: target.installedAt };
      const installed = await installApp(replaced);
      if (installed) {
        setSelectedInstalledApp(current => (current && current.id === installed.id ? installed : current));
      }
    } catch (err) {
      showErrorDialog(err, "换包失败");
    } finally {
      setBusy(false);
    }
  }

  async function buildManualPackage() {
    setBusy(true);
    try {
      const baseApp = manualExistingApp ?? (marketEditTarget ? await loadCustomAppMarketPackageApp(marketEditTarget) : null);
      if (!manualFiles.entry && !baseApp) throw new Error("请选择入口 HTML 文件。");
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let manifestRecord: Record<string, unknown> = baseApp ? { ...baseApp.manifest } : {};
      if (manualFiles.manifest) {
        const parsed = JSON.parse(await manualFiles.manifest.text()) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest.json 必须是 JSON 对象。");
        manifestRecord = { ...manifestRecord, ...parsed as Record<string, unknown> };
      }
      const fallbackEntryPath = normalizePackagePath(baseApp?.manifest.entry || "index.html", "index.html");
      const entryPath = normalizePackagePath(
        manualFiles.entry?.name || String(manifestRecord.entry ?? fallbackEntryPath),
        fallbackEntryPath,
      );
      zip.file(entryPath, manualFiles.entry ? await manualFiles.entry.arrayBuffer() : baseApp?.entryHtml ?? "");

      let iconPath = typeof manifestRecord.icon === "string" ? normalizePackagePath(manifestRecord.icon, "icon.png") : "";
      const declarationSlots = [
        { file: manualFiles.presets, path: "presets.json", key: "presets" as const },
        { file: manualFiles.regex, path: "regex.json", key: "regexes" as const },
        { file: manualFiles.worldBooks, path: "worldbooks.json", key: "worldBooks" as const },
        { file: manualFiles.bindings, path: "bindings.json", key: "bindings" as const },
      ];
      const selectedAssetPaths = manualFiles.assets.map(file => normalizePackagePath(file.name, file.name));
      const resources = normalizeManualResources(manifestRecord.resources);
      const replacedPaths = new Set([
        "manifest.json",
        entryPath,
        ...selectedAssetPaths,
        ...declarationSlots.filter(slot => slot.file).map(slot => slot.path),
        ...declarationSlots.flatMap(slot => slot.file ? resourcePathsForKey(resources, slot.key) : []),
      ].filter(Boolean));
      if (manualFiles.icon) {
        iconPath = normalizePackagePath(manualFiles.icon.name, "icon.png");
        zip.file(iconPath, await manualFiles.icon.arrayBuffer());
        replacedPaths.add(iconPath);
      }

      if (baseApp) {
        for (const asset of Object.values(baseApp.assets)) {
          const path = normalizePackagePath(asset.path, asset.path);
          if (!path || replacedPaths.has(path)) continue;
          zip.file(path, bytesFromDataUrl(asset.dataUrl));
        }
      }

      const usedPaths = new Set(["manifest.json", entryPath, iconPath].filter(Boolean));
      for (const slot of declarationSlots) {
        if (!slot.file) continue;
        usedPaths.add(slot.path);
        zip.file(slot.path, await slot.file.arrayBuffer());
        replaceResourcePath(resources, slot.key, slot.path);
      }
      for (const file of manualFiles.assets) {
        const path = normalizePackagePath(file.name, file.name);
        if (!path || usedPaths.has(path)) continue;
        usedPaths.add(path);
        zip.file(path, await file.arrayBuffer());
        const key = resourceKeyForPath(path);
        if (key) appendResourcePath(resources, key, path);
        appendResourcePath(resources, "assets", path);
      }

      const name = String(manifestRecord.name ?? baseApp?.name ?? "").trim() || appNameFromEntryPath(entryPath);
      if (!name) throw new Error("manifest.json 需要 name 字段。");
      const version = String(manifestRecord.version ?? baseApp?.version ?? "").trim() || "1.0.0";
      const permissions = Array.isArray(manifestRecord.permissions)
        ? manifestRecord.permissions as CustomAppPermission[]
        : baseApp?.permissions ?? [];
      const manifest: CustomAppManifest = {
        ...manifestRecord,
        id: normalizeCustomAppManifestId(manifestRecord.id, name),
        name,
        version,
        author: String(manifestRecord.author ?? baseApp?.author ?? "").trim() || undefined,
        description: String(manifestRecord.description ?? baseApp?.description ?? "").trim() || undefined,
        icon: iconPath || (typeof manifestRecord.icon === "string" ? manifestRecord.icon : undefined),
        entry: entryPath,
        permissions,
        resources,
      };
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      const blob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
      const packageFile = new File([blob], `${manifest.id}-${version}.zip`, { type: "application/zip" });
      setPublishVersion(version);
      const parsed = await handleFile(packageFile);
      if (parsed) setManualBuilderOpen(false);
    } catch (err) {
      showErrorDialog(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File | null | undefined): Promise<boolean> {
    if (!file) return false;
    setBusy(true);
    setSourceFile(file);
    setTab("create");
    try {
      const lower = file.name.toLowerCase();
      const app = lower.endsWith(".html") || lower.endsWith(".htm")
        ? await loadSingleHtmlCustomApp(file)
        : await loadCustomAppPackage(file);
      setPendingApp(app);
      setPublishVersion(app.version);
      return true;
    } catch (err) {
      setSourceFile(null);
      showErrorDialog(err, "导入失败");
      return false;
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function installApp(app: InstalledCustomApp, options: { silent?: boolean } = {}) {
    try {
      const wasInstalled = loadInstalledCustomApps().some(item => item.id === app.id);
      const installed = await installCustomAppAsync(app);
      const registration = await applyCustomAppRegistrationsAsync(installed);
      const registrationText = formatCustomAppRegistrationSummary(registration);
      onInstallToDesktop(installed);
      refresh();
      if (!options.silent) {
        const head = wasInstalled ? `已更新「${installed.name}」（换包成功，原有数据保留）` : `已安装「${installed.name}」`;
        onNotice?.(registrationText ? `${head}，${registrationText}` : head);
      }
      return installed;
    } catch (err) {
      showErrorDialog(err);
      return null;
    }
  }

  async function confirmInstall() {
    if (!pendingApp) return;
    setBusy(true);
    const base = appWithVersion(pendingApp, publishVersion);
    // 编辑本地测试 APP 后的"本机测试"是原地替换：沿用原运行时 id 和 installedAt，数据保留
    const app = localEditTarget ? { ...base, id: localEditTarget.id, installedAt: localEditTarget.installedAt } : base;
    const installed = await installApp(app);
    if (installed) {
      setLocalEditTarget(null);
      setPendingApp(null);
      setSourceFile(null);
      setTab(localEditTarget ? "create" : "installed");
    }
    setBusy(false);
  }

  async function confirmPublish() {
    if (!pendingApp) return;
    setPublishing(true);
    try {
      const app = appWithVersion(pendingApp, publishVersion);
      await validateCustomAppMarketItem({ id: marketEditTarget?.id, app, version: app.version });
      const packageFile = await createPackageFileFromApp(app);
      const asset = await uploadCustomAppPackageAsset({ file: packageFile, filename: packageFile.name });
      const published = marketEditTarget ? await updateCustomAppMarketItem({
        id: marketEditTarget.id,
        app,
        packageUrl: asset.url,
        packagePath: asset.path,
        packageKind: asset.kind,
        packageSize: asset.size,
        version: app.version,
        changelog: publishChangelog,
      }) : await publishCustomAppMarketItem({
        app,
        packageUrl: asset.url,
        packagePath: asset.path,
        packageKind: asset.kind,
        packageSize: asset.size,
        version: app.version,
        changelog: publishChangelog,
      });
      setPendingApp(null);
      setSourceFile(null);
      setMarketEditTarget(null);
      setPublishChangelog("");
      setPublishVersion("");
      await refreshMarket();
      setTab(marketEditTarget ? "create" : "discover");
      onNotice?.(published.reviewStatus === "approved"
        ? marketEditTarget ? `已更新「${published.name}」` : `已发布「${published.name}」`
        : marketEditTarget ? `已提交「${published.name}」更新，等待上架` : `已提交「${published.name}」，等待上架`);
    } catch (err) {
      showErrorDialog(err, marketEditTarget ? "提交更新失败" : "发布失败");
    } finally {
      setPublishing(false);
    }
  }

  async function deleteMarketItem(item: CustomAppMarketItem) {
    setPublishing(true);
    try {
      await deleteCustomAppMarketItem({ id: item.id });
      if (marketEditTarget?.id === item.id) cancelMarketUpdate();
      setConfirmMarketDelete(null);
      setSelectedMarketApp(current => current?.id === item.id ? null : current);
      await refreshMarket();
      onNotice?.(`已删除「${item.name}」的市场发布`);
    } catch (err) {
      showErrorDialog(err, "删除失败");
    } finally {
      setPublishing(false);
    }
  }

  async function submitMarketAppReport() {
    if (!reportTarget || reportSubmitting) return;
    setReportSubmitting(true);
    try {
      await submitContentReport({
        contentType: "market_app",
        contentId: reportTarget.id,
        reason: reportReason.trim().slice(0, 200),
        preview: `${reportTarget.name} — ${reportTarget.description || ""}`.slice(0, 200),
        ownerId: reportTarget.authorId || "",
        ownerName: reportTarget.authorName || "",
      });
      setReportedMarketAppIds(current => ({ ...current, [reportTarget.id]: true }));
      setReportTarget(null);
      setReportReason("");
      onNotice?.("已举报，管理员会尽快处理");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : "举报失败");
    } finally {
      setReportSubmitting(false);
    }
  }

  async function installMarketApp(item: CustomAppMarketItem) {
    setMarketBusy(true);
    setMarketError("");
    try {
      const app = await loadCustomAppMarketPackageApp(item);
      const installed = await installApp(app);
      if (installed) {
        await recordCustomAppInstall(item.id);
        await refreshMarket();
        setSelectedMarketApp(null);
      }
    } catch (err) {
      setMarketError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarketBusy(false);
    }
  }

  async function resolveMarketItemForInstalled(appId: string): Promise<CustomAppMarketItem | null> {
    const cached = marketItemByAppId.get(appId);
    if (cached) return cached;
    const [publicApps, ownApps] = await Promise.all([
      fetchCustomAppMarketItems(),
      fetchMyCustomAppMarketItems(),
    ]);
    setMarketApps(publicApps);
    setMyMarketApps(ownApps);
    return newestCustomAppMarketItem([...publicApps, ...ownApps], appId);
  }

  async function updateInstalledAppFromMarket(app: InstalledCustomApp) {
    setUpdatingInstalledId(app.id);
    setInstalledActionError("");
    try {
      const result = await updateInstalledCustomAppFromMarketPackage(app, {
        resolveMarketItem: resolveMarketItemForInstalled,
      });
      setSelectedInstalledApp(result.installed);
      refresh();
      onNotice?.(result.previousVersion === result.installed.version
        ? `已同步「${result.installed.name}」`
        : `已更新「${result.installed.name}」到 v${result.installed.version}`);
    } catch (err) {
      setInstalledActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingInstalledId(current => current === app.id ? null : current);
    }
  }

  function closePendingSheet() {
    if (publishing) return;
    setPendingApp(null);
    setSourceFile(null);
    setMarketEditTarget(null);
    setLocalEditTarget(null);
    setPublishVersion("");
    setPublishChangelog("");
  }

  async function deleteApp(app: InstalledCustomApp, deleteData: boolean) {
    setBusy(true);
    try {
      const removal = await removeCustomAppRegistrationsAsync(app.id, { deleteResources: deleteData });
      const removalText = formatCustomAppRegistrationRemovalSummary(removal);
      await uninstallCustomAppAsync(app.id, { deleteData });
      setConfirmDelete(null);
      setSelectedInstalledApp(null);
      refresh();
      const base = deleteData ? `已卸载「${app.name}」并删除数据` : `已卸载「${app.name}」`;
      onNotice?.(removalText ? `${base}，${removalText}` : base);
    } catch (err) {
      showErrorDialog(err, "卸载失败");
    } finally {
      setBusy(false);
    }
  }

  function installedForMarketItem(item: CustomAppMarketItem): InstalledCustomApp | null {
    return installedById.get(item.appId) ?? null;
  }

  const titleHint = tab === "discover" ? "探索新的可能" : tab === "installed" ? "我的应用" : "创作与发布";
  const manualFileCount = [
    manualFiles.manifest,
    manualFiles.entry,
    manualFiles.icon,
    manualFiles.presets,
    manualFiles.regex,
    manualFiles.worldBooks,
    manualFiles.bindings,
    ...manualFiles.assets,
  ].filter(Boolean).length;
  const manualExistingManifest = manualExistingApp?.manifest ?? marketEditTarget?.manifest;
  const manualExistingEntryPath = manualExistingManifest ? normalizePackagePath(manualExistingManifest.entry || "index.html", "index.html") : "";
  const manualExistingIconPath = manualExistingManifest?.icon
    ? normalizePackagePath(manualExistingManifest.icon, "icon.png")
    : manualExistingApp?.iconDataUrl || marketEditTarget?.iconDataUrl ? "icon.png" : "";
  const manualExistingPresetsPath = existingDeclarationPath(manualExistingApp, manualExistingManifest, "presets", "presets.json");
  const manualExistingRegexPath = existingDeclarationPath(manualExistingApp, manualExistingManifest, "regexes", "regex.json");
  const manualExistingWorldBooksPath = existingDeclarationPath(manualExistingApp, manualExistingManifest, "worldBooks", "worldbooks.json");
  const manualExistingBindingsPath = existingDeclarationPath(manualExistingApp, manualExistingManifest, "bindings", "bindings.json");
  const manualExistingAssetPaths = existingOtherAssetPaths(manualExistingApp, manualExistingManifest);
  const selectedInstalledMarketItem = selectedInstalledApp ? marketItemByAppId.get(selectedInstalledApp.id) ?? null : null;
  const selectedInstalledUpdating = Boolean(selectedInstalledApp && updatingInstalledId === selectedInstalledApp.id);

  return (
    <div className="app-market-app">
      <header className="app-market-header">
        <button type="button" className="app-market-icon-btn" onClick={onClose} aria-label="返回桌面">
          <ChevronLeft size={25} />
        </button>
        <div className="app-market-title">
          <strong>应用市场</strong>
          <span>{titleHint}</span>
        </div>
        <button
          type="button"
          className="app-market-icon-btn"
          onClick={refreshCurrentView}
          disabled={marketBusy}
          aria-label={marketRefreshing ? "正在刷新应用市场" : "刷新应用市场"}
          aria-busy={marketRefreshing}
        >
          <RefreshCw size={20} className={marketRefreshing ? "am-spin" : undefined} />
        </button>
      </header>

      <div className="app-market-tabbar">
        <div className="app-market-tabs" role="tablist" aria-label="应用市场视图">
          <button type="button" role="tab" aria-selected={tab === "discover"} className="app-market-tab" data-active={tab === "discover"} onClick={() => setTab("discover")}>
            <span>发现</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "installed"} className="app-market-tab" data-active={tab === "installed"} onClick={() => setTab("installed")}>
            <span>已安装</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "create"} className="app-market-tab" data-active={tab === "create"} onClick={() => setTab("create")}>
            <span>创作</span>
          </button>
        </div>
      </div>

      <main className="app-market-body">
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.html,.htm,.floatapp,application/zip,application/x-zip-compressed,text/html"
          className="app-market-hidden-input"
          onChange={event => void handleFile(event.target.files?.[0])}
        />

        <input
          ref={localPkgRef}
          type="file"
          accept=".zip,.html,.htm,.floatapp,application/zip,application/x-zip-compressed,text/html"
          className="app-market-hidden-input"
          onChange={event => void handleLocalPackageUpdate(event.target.files?.[0])}
        />

        {tab === "discover" ? (
          <>
            <label className="app-market-search">
              <Search size={16} />
              <input aria-label="搜索 APP" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索应用或作者" />
            </label>

            {marketError ? <div className="app-market-error" role="alert">{marketError}</div> : null}

            <section className="app-market-section">
              {filteredMarketApps.length === 0 ? (
                <div className="app-market-empty">
                  <Store size={26} />
                  <p>{marketBusy ? "正在加载…" : query ? "暂时没有找到匹配的应用" : "还没有上架的应用，来发布第一个吧"}</p>
                </div>
              ) : (
                <div className="am-store-list">
                  {filteredMarketApps.map(item => {
                    const installed = installedForMarketItem(item);
                    return (
                      <article className="am-list-row" key={item.id}>
                        <button type="button" className="am-list-icon-btn" onClick={() => setSelectedMarketApp(item)} aria-label={`${item.name} 详情`}>
                          <AppIcon iconDataUrl={item.iconDataUrl} seed={item.name} className="list" />
                        </button>
                        <div className="am-list-col">
                          <button type="button" className="am-list-text" onClick={() => setSelectedMarketApp(item)}>
                            <span className="am-list-name-row">
                              <strong>{item.name}</strong>
                              <span className="am-list-author">{item.authorName}</span>
                            </span>
                            {item.description ? <em>{item.description}</em> : null}
                          </button>
                          <div className="am-list-action">
                            <button
                              type="button"
                              className={installed ? "am-pill am-pill-open" : "am-pill am-pill-get"}
                              disabled={marketBusy}
                              onClick={() => installed ? onOpenCustomApp(installed.id) : void installMarketApp(item)}
                            >
                              {installed ? "打开" : "获取"}
                            </button>
                            <small>{item.installCount} 次安装</small>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        ) : null}

        {tab === "installed" ? (
          <>
            {apps.length === 0 ? (
              <div className="app-market-empty">
                <HardDrive size={26} />
                <p>还没有安装应用，去发现页逛逛吧</p>
              </div>
            ) : (
              <section className="app-market-section">
                <div className="am-store-list">
                  {apps.map(app => (
                    <article className="am-list-row" key={app.id}>
                      <button type="button" className="am-list-icon-btn" onClick={() => onOpenCustomApp(app.id)} aria-label={`打开${app.name}`}>
                        <AppIcon iconDataUrl={app.iconDataUrl} seed={app.name} className="list" />
                      </button>
                      <div className="am-list-col">
                        <button type="button" className="am-list-text" onClick={() => onOpenCustomApp(app.id)}>
                          <span className="am-list-name-row">
                            <strong>{app.name}</strong>
                            <span className="am-list-author">{app.author || "本地作者"} · v{app.version}</span>
                          </span>
                          {app.description ? <em>{app.description}</em> : null}
                        </button>
                        <div className="am-list-action">
                          <button type="button" className="am-pill am-pill-get" onClick={() => onOpenCustomApp(app.id)}>打开</button>
                          <button type="button" className="am-list-manage" onClick={() => setSelectedInstalledApp(app)} aria-label={`管理${app.name}`}>
                            <Info size={16} />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : null}

        {tab === "create" ? (
          <>
            <div className="am-create-actions">
              <button type="button" className="am-create-action" onClick={openImporter} disabled={busy}>
                <span className="am-create-action-icon"><CloudUpload size={23} /></span>
                <strong>{busy ? "正在解析…" : "导入整包"}</strong>
                <em>.zip · .html</em>
              </button>

              <button type="button" className="am-create-action" onClick={() => openManualBuilder()} disabled={busy}>
                <span className="am-create-action-icon"><PackageCheck size={23} /></span>
                <strong>单文件逐项上传</strong>
                <em>逐项选择文件</em>
              </button>
            </div>

            <button type="button" className="app-market-secondary am-guide-btn" onClick={() => setCreatorGuideOpen(true)}>
              <BookOpen size={17} />
              <span>制作说明</span>
            </button>

            {myMarketApps.length > 0 ? (
              <section className="app-market-section">
                <div className="app-market-section-head">
                  <h2>我的发布</h2>
                  <span>{myMarketApps.length} 个</span>
                </div>
                <div className="am-store-list">
                  {myMarketApps.map(item => (
                    <article className="am-list-row" key={item.id}>
                      <span className="am-list-icon-btn">
                        <AppIcon iconDataUrl={item.iconDataUrl} seed={item.name} className="list" />
                      </span>
                      <div className="am-list-col">
                        <div className="am-list-text">
                          <span className="am-list-name-row">
                            <strong>{item.name}</strong>
                            <span className="am-list-author">v{item.version} · {formatDate(item.updatedAt)}</span>
                            <b className="am-list-status am-list-status-corner" data-status={item.reviewStatus}>{statusLabel(item.reviewStatus)}</b>
                          </span>
                          {item.description ? <em>{item.description}</em> : null}
                        </div>
                        <div className="am-list-action am-publish-actions">
                          <button type="button" className="am-action-chip" onClick={() => openManualBuilder(item)} aria-label={`编辑${item.name}`}>
                            <Pencil size={14} />
                            <span>编辑</span>
                          </button>
                          <button type="button" className="am-action-chip" onClick={() => startMarketPackageUpdate(item)} aria-label={`替换${item.name}应用包`}>
                            <Upload size={16} />
                            <span>换包</span>
                          </button>
                          <button type="button" className="am-action-chip" onClick={() => setConfirmMarketDelete(item)} aria-label={`删除${item.name}`}>
                            <Trash2 size={16} />
                            <span>删除</span>
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : (
              <div className="app-market-empty compact">
                <PackageCheck size={26} />
                <p>还没有发布过 APP。导入整包后可以选择本机测试或发布到市场。</p>
              </div>
            )}

            {localTestApps.length > 0 ? (
              <section className="app-market-section">
                <div className="app-market-section-head">
                  <h2>本地测试</h2>
                  <span>{localTestApps.length} 个</span>
                </div>
                <div className="am-store-list">
                  {localTestApps.map(app => (
                    <article className="am-list-row" key={app.id}>
                      <span className="am-list-icon-btn">
                        <AppIcon iconDataUrl={app.iconDataUrl} seed={app.name} className="list" />
                      </span>
                      <div className="am-list-col">
                        <div className="am-list-text">
                          <span className="am-list-name-row">
                            <strong>{app.name}</strong>
                            <span className="am-list-author">v{app.version}</span>
                          </span>
                          {app.description ? <em>{app.description}</em> : null}
                        </div>
                        <div className="am-list-action am-publish-actions">
                          <button type="button" className="am-action-chip" onClick={() => openLocalManualBuilder(app)} disabled={busy} aria-label={`编辑${app.name}`}>
                            <Pencil size={14} />
                            <span>编辑</span>
                          </button>
                          <button type="button" className="am-action-chip" onClick={() => startLocalPackageUpdate(app)} disabled={busy} aria-label={`换包更新${app.name}`}>
                            <Upload size={16} />
                            <span>换包</span>
                          </button>
                          <button type="button" className="am-action-chip" onClick={() => setConfirmDelete(app)} aria-label={`卸载${app.name}`}>
                            <Trash2 size={16} />
                            <span>卸载</span>
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </main>

      {pendingApp ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={closePendingSheet}>
          <div className="app-market-sheet app-market-check-sheet" role="dialog" aria-modal="true" aria-label="发布前检查" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>{marketEditTarget ? "更新前检查" : "发布前检查"}</strong>
              <button type="button" onClick={closePendingSheet} aria-label="关闭" disabled={publishing}>
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <div className="app-market-preview-row">
                <AppIcon iconDataUrl={pendingApp.iconDataUrl} seed={pendingApp.name} className="large" />
                <div>
                  <strong>{pendingApp.name}</strong>
                  <p>{pendingApp.description || "本地自定义 APP"}</p>
                  <span>v{publishVersion || pendingApp.version} · {pendingApp.author || "本地作者"}</span>
                </div>
              </div>

              <div className="am-publish-fields">
                <label className="am-form-field">
                  <span>版本号</span>
                  <input value={publishVersion} onChange={event => setPublishVersion(event.target.value)} placeholder={pendingApp.version} spellCheck={false} />
                </label>
                <label className="am-form-field">
                  <span>更新日志</span>
                  <textarea
                    value={publishChangelog}
                    onChange={event => setPublishChangelog(event.target.value)}
                    placeholder={marketEditTarget ? "这次更新改了什么" : "首次发布说明，可选"}
                    rows={3}
                  />
                </label>
              </div>

              <div className="app-market-inspection-grid">
                <div><strong>{pendingApp.permissions.length}</strong><span>权限</span></div>
                <div><strong>{declarationCount(pendingApp)}</strong><span>声明文件</span></div>
                <div><strong>{sourceFile ? formatPackageSize(sourceFile.size) : "未知"}</strong><span>包大小</span></div>
              </div>

              <div className="app-market-declaration-strip">
                {DECLARATION_FILES.map(item => {
                  const Icon = item.icon;
                  const active = hasDeclaration(pendingApp, item.file);
                  return (
                    <span key={item.file} data-active={active}>
                      <Icon size={15} />
                      {item.label}
                    </span>
                  );
                })}
              </div>

              <div className="app-market-permissions">
                <span>请求权限</span>
                {pendingApp.permissions.length === 0 ? (
                  <p>未声明特殊权限，仅作为页面运行。</p>
                ) : (
                  <ul>
                    {pendingApp.permissions.map(permission => (
                      <li key={permission}>{permissionLabelWithContext(permission, pendingApp.manifest)}</li>
                    ))}
                  </ul>
                )}
              </div>

              {sourceFile ? <p className="app-market-upload-hint">文件：{sourceFile.name}</p> : null}

              <div className="app-market-sheet-actions three">
                <button type="button" className="app-market-secondary" onClick={closePendingSheet} disabled={publishing}>取消</button>
                <button type="button" className="app-market-secondary" onClick={() => void confirmInstall()} disabled={publishing || busy}>
                  <HardDrive size={18} />
                  <span>本机测试</span>
                </button>
                <button type="button" className="app-market-primary" onClick={() => void confirmPublish()} disabled={publishing}>
                  {publishing ? <LoaderCircle className="am-spin" size={18} /> : <CloudUpload size={18} />}
                  <span>{publishing ? "提交中" : marketEditTarget ? "提交更新" : "发布市场"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {selectedMarketApp ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={() => setSelectedMarketApp(null)}>
          <div className="app-market-sheet app-market-detail-sheet" role="dialog" aria-modal="true" aria-label="APP 详情" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>APP 详情</strong>
              <button type="button" onClick={() => setSelectedMarketApp(null)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <div className="app-market-preview-row">
                <AppIcon iconDataUrl={selectedMarketApp.iconDataUrl} seed={selectedMarketApp.name} className="large" />
                <div>
                  <strong>{selectedMarketApp.name}</strong>
                  <p>{selectedMarketApp.description || "这个 APP 暂未填写简介。"}</p>
                  <span>{selectedMarketApp.authorName} · v{selectedMarketApp.version}</span>
                </div>
              </div>
              <div className="app-market-info-grid">
                <div><strong>{selectedMarketApp.installCount}</strong><span>安装</span></div>
                <div><strong>{formatPackageSize(selectedMarketApp.packageSize)}</strong><span>大小</span></div>
                <div><strong>{selectedMarketApp.packageKind}</strong><span>格式</span></div>
              </div>
              {selectedMarketApp.changelog ? (
                <div className="app-market-permissions">
                  <span>更新日志</span>
                  <p>{selectedMarketApp.changelog}</p>
                </div>
              ) : null}
              <div className="app-market-permissions">
                <span>权限说明</span>
                {selectedMarketApp.permissions.length === 0 ? (
                  <p>未声明特殊权限。</p>
                ) : (
                  <ul>
                    {selectedMarketApp.permissions.map(permission => (
                      <li key={permission}>{permissionLabelWithContext(permission, selectedMarketApp.manifest)}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="app-market-sheet-actions with-report">
                <button type="button" className="app-market-secondary" onClick={() => setSelectedMarketApp(null)}>关闭</button>
                {installedForMarketItem(selectedMarketApp) ? (
                  <button type="button" className="app-market-primary" onClick={() => onOpenCustomApp(installedForMarketItem(selectedMarketApp)!.id)}>
                    <ExternalLink size={18} />
                    <span>打开</span>
                  </button>
                ) : (
                  <button type="button" className="app-market-primary" disabled={marketBusy} onClick={() => void installMarketApp(selectedMarketApp)}>
                    <Download size={18} />
                    <span>{marketBusy ? "安装中" : "安装"}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="app-market-danger app-market-report-btn"
                  disabled={!!reportedMarketAppIds[selectedMarketApp.id]}
                  onClick={() => {
                    setReportReason("");
                    setReportTarget(selectedMarketApp);
                  }}
                >
                  {reportedMarketAppIds[selectedMarketApp.id] ? "已举报" : "举报"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {reportTarget ? (
        <div
          className="app-market-overlay app-market-drawer-overlay"
          role="presentation"
          onClick={() => { if (!reportSubmitting) setReportTarget(null); }}
        >
          <div className="app-market-sheet app-market-report-sheet" role="dialog" aria-modal="true" aria-label="举报 APP" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>举报「{reportTarget.name}」</strong>
              <button type="button" onClick={() => setReportTarget(null)} aria-label="关闭" disabled={reportSubmitting}>
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <label className="am-form-field">
                <span>举报理由（选填，最多 200 字）</span>
                <textarea
                  value={reportReason}
                  onChange={event => setReportReason(event.target.value.slice(0, 200))}
                  placeholder="说明这个 APP 存在的问题，帮助管理员更快处理"
                  rows={4}
                />
              </label>
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-secondary" onClick={() => setReportTarget(null)} disabled={reportSubmitting}>取消</button>
                <button type="button" className="app-market-danger" onClick={() => void submitMarketAppReport()} disabled={reportSubmitting}>
                  {reportSubmitting ? <LoaderCircle className="am-spin" size={18} /> : null}
                  <span>{reportSubmitting ? "提交中" : "提交举报"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {selectedInstalledApp ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={() => setSelectedInstalledApp(null)}>
          <div className="app-market-sheet app-market-detail-sheet" role="dialog" aria-modal="true" aria-label="已安装 APP 详情" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>已安装 APP</strong>
              <button type="button" onClick={() => setSelectedInstalledApp(null)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <div className="app-market-preview-row">
                <AppIcon iconDataUrl={selectedInstalledApp.iconDataUrl} seed={selectedInstalledApp.name} className="large" />
                <div>
                  <strong>{selectedInstalledApp.name}</strong>
                  <p>{selectedInstalledApp.description || "本地自定义 APP"}</p>
                  <span>{selectedInstalledApp.author || "本地作者"} · v{selectedInstalledApp.version}</span>
                </div>
              </div>
              <div className="app-market-declaration-strip">
                {DECLARATION_FILES.map(item => {
                  const Icon = item.icon;
                  const active = hasDeclaration(selectedInstalledApp, item.file);
                  return (
                    <span key={item.file} data-active={active}>
                      <Icon size={15} />
                      {item.label}
                    </span>
                  );
                })}
              </div>
              <div className="app-market-permissions">
                <span>已授权能力</span>
                {selectedInstalledApp.permissions.length === 0 ? (
                  <p>未声明特殊权限。</p>
                ) : (
                  <ul>
                    {selectedInstalledApp.permissions.map(permission => (
                      <li key={permission}>{permissionLabelWithContext(permission, selectedInstalledApp.manifest)}</li>
                    ))}
                  </ul>
                )}
              </div>
              {installedActionError ? <div className="app-market-error" role="alert">{installedActionError}</div> : null}
              <div className="app-market-sheet-actions three">
                <button
                  type="button"
                  className="app-market-secondary"
                  onClick={() => void updateInstalledAppFromMarket(selectedInstalledApp)}
                  disabled={selectedInstalledUpdating}
                  title={selectedInstalledMarketItem ? `市场版本 v${selectedInstalledMarketItem.version}` : "点击后会刷新市场并查找更新"}
                >
                  {selectedInstalledUpdating ? <LoaderCircle className="am-spin" size={18} /> : <RefreshCw size={18} />}
                  <span>{selectedInstalledUpdating ? "更新中" : "更新"}</span>
                </button>
                <button type="button" className="app-market-danger" onClick={() => setConfirmDelete(selectedInstalledApp)} disabled={selectedInstalledUpdating}>
                  <Trash2 size={18} />
                  <span>卸载</span>
                </button>
                <button type="button" className="app-market-primary" onClick={() => onOpenCustomApp(selectedInstalledApp.id)} disabled={selectedInstalledUpdating}>
                  <ExternalLink size={18} />
                  <span>打开</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {manualBuilderOpen ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={closeManualBuilder}>
          <div className="app-market-sheet app-market-manual-sheet" role="dialog" aria-modal="true" aria-label="单文件逐项上传" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>{marketEditTarget ? `编辑「${marketEditTarget.name}」` : localEditTarget ? `编辑「${localEditTarget.name}」（本地）` : "单文件逐项上传"}</strong>
              <button type="button" onClick={closeManualBuilder} aria-label="关闭" disabled={busy}>
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              {marketEditTarget ? (
                <p className="app-market-upload-hint">{manualExistingLoading ? "正在读取当前线上包…" : "下方会显示当前线上包里的文件；只选择需要替换的文件，未选择的内容会沿用原文件。"}</p>
              ) : localEditTarget ? (
                <p className="app-market-upload-hint">下方是本机安装包里的文件；只选择需要替换的文件，未选择的沿用原文件。确认后选「本机测试」即可原地更新，数据保留。</p>
              ) : (
                <p className="app-market-upload-hint">基础信息从 manifest.json 读取；入口、图标、预设、正则、世界书、绑定和资源都用文件上传。</p>
              )}
              {marketEditTarget ? (
                <label className="am-form-field">
                  <span>更新日志</span>
                  <textarea
                    value={publishChangelog}
                    onChange={event => setPublishChangelog(event.target.value)}
                    rows={2}
                    placeholder="写给用户看的更新说明"
                  />
                </label>
              ) : null}
              <div className="am-manual-file-stack" key={manualFileInputKey}>
                <div className="am-file-section">
                  <div className="am-file-section-head">
                    <strong>基础文件</strong>
                    {manualFileCount > 0 ? (
                      <button type="button" onClick={resetManualFiles} disabled={busy}>清空已选</button>
                    ) : null}
                  </div>
                  <div className="am-file-grid">
                    <label className="am-file-pick" data-active={Boolean(manualFiles.manifest || marketEditTarget)}>
                      <FileJson size={18} />
                      <span>manifest.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("manifest", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.manifest, marketEditTarget ? "manifest.json" : "", "建议必选", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.entry || manualExistingEntryPath)}>
                      <FileCode2 size={18} />
                      <span>入口 HTML</span>
                      <input type="file" accept=".html,.htm,text/html" onChange={event => updateManualFile("entry", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.entry, manualExistingEntryPath, "选择 index.html", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.icon || manualExistingIconPath)}>
                      <ImageIcon size={18} />
                      <span>图标文件</span>
                      <input type="file" accept="image/*" onChange={event => updateManualFile("icon", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.icon, manualExistingIconPath, "可选上传", manualExistingLoading)}</em>
                    </label>
                  </div>
                </div>
                <div className="am-file-section">
                  <div className="am-file-section-head">
                    <strong>声明文件</strong>
                    <span>按槽位上传，不需要手写</span>
                  </div>
                  <div className="am-file-grid">
                    <label className="am-file-pick" data-active={Boolean(manualFiles.presets || manualExistingPresetsPath)}>
                      <Layers size={18} />
                      <span>presets.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("presets", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.presets, manualExistingPresetsPath, "预设条目", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.regex || manualExistingRegexPath)}>
                      <Sparkles size={18} />
                      <span>regex.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("regex", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.regex, manualExistingRegexPath, "正则美化", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.worldBooks || manualExistingWorldBooksPath)}>
                      <FileJson size={18} />
                      <span>worldbooks.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("worldBooks", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.worldBooks, manualExistingWorldBooksPath, "世界书资料", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.bindings || manualExistingBindingsPath)}>
                      <CheckCircle2 size={18} />
                      <span>bindings.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("bindings", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.bindings, manualExistingBindingsPath, "默认绑定", manualExistingLoading)}</em>
                    </label>
                  </div>
                </div>
                <div className="am-file-section">
                  <div className="am-file-section-head">
                    <strong>其他资源</strong>
                    <span>图片、脚本、样式、字体等</span>
                  </div>
                  <label className="am-file-pick am-file-pick-wide" data-active={manualFiles.assets.length > 0 || manualExistingAssetPaths.length > 0}>
                    <Upload size={18} />
                    <span>资源文件</span>
                    <input type="file" multiple accept=".json,.js,.css,.png,.jpg,.jpeg,.webp,.svg,.woff,.woff2,text/*,image/*,application/json" onChange={event => updateManualFile("assets", event.target.files)} />
                    <em>{assetSlotLabel(manualFiles.assets, manualExistingAssetPaths, "可多选，不包含上面的专用槽位", manualExistingLoading)}</em>
                  </label>
                </div>
              </div>
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-secondary" onClick={closeManualBuilder} disabled={busy}>取消</button>
                <button type="button" className="app-market-primary" onClick={() => void buildManualPackage()} disabled={busy}>
                  {busy ? <LoaderCircle className="am-spin" size={18} /> : <PackageCheck size={18} />}
                  <span>{busy ? "组包中" : marketEditTarget ? "保存并检查" : "生成并检查"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="app-market-overlay" role="presentation" onClick={() => setConfirmDelete(null)}>
          <div className="app-market-sheet" role="dialog" aria-modal="true" aria-label="卸载 APP" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>卸载「{confirmDelete.name}」？</strong>
              <button type="button" onClick={() => setConfirmDelete(null)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-delete-copy">
                将移除桌面图标、权限授权和运行文件。聊天历史里的 APP 卡片会保留。
              </p>
              <div className="app-market-sheet-actions stacked">
                <button type="button" className="app-market-secondary" onClick={() => void deleteApp(confirmDelete, false)} disabled={busy}>
                  卸载并保留数据
                </button>
                <button type="button" className="app-market-danger" onClick={() => void deleteApp(confirmDelete, true)} disabled={busy}>
                  卸载并删除数据
                </button>
                <button type="button" className="app-market-secondary" onClick={() => setConfirmDelete(null)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {errorDialog ? (
        <div className="app-market-overlay app-market-center-overlay" role="presentation" onClick={() => setErrorDialog(null)}>
          <div className="app-market-sheet app-market-confirm-sheet app-market-error-dialog" role="alertdialog" aria-modal="true" aria-label={errorDialog.title} onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>{errorDialog.title}</strong>
              <button type="button" onClick={() => setErrorDialog(null)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-delete-copy">{errorDialog.message}</p>
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-primary" onClick={() => setErrorDialog(null)}>知道了</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmMarketDelete ? (
        <div className="app-market-overlay app-market-center-overlay" role="presentation" onClick={() => setConfirmMarketDelete(null)}>
          <div className="app-market-sheet app-market-confirm-sheet" role="dialog" aria-modal="true" aria-label="删除市场发布" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>删除「{confirmMarketDelete.name}」的市场发布？</strong>
              <button type="button" onClick={() => setConfirmMarketDelete(null)} aria-label="关闭" disabled={publishing}>
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-delete-copy">
                删除后它会从应用广场下架，已经安装到用户手机里的本地副本不会被自动移除。
              </p>
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-secondary" onClick={() => setConfirmMarketDelete(null)} disabled={publishing}>取消</button>
                <button type="button" className="app-market-danger" onClick={() => void deleteMarketItem(confirmMarketDelete)} disabled={publishing}>
                  <Trash2 size={18} />
                  <span>{publishing ? "删除中" : "删除发布"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {creatorGuideOpen ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={() => setCreatorGuideOpen(false)}>
          <div className="app-market-sheet app-market-guide-sheet" role="dialog" aria-modal="true" aria-label="自定义 APP 制作说明" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>自定义 APP 制作说明</strong>
              <button type="button" onClick={() => setCreatorGuideOpen(false)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-guide-copy">
                把这份说明和你的 APP 想法一起发给创作助手，让它按小手机当前 SDK 生成应用包文件。
              </p>
              <textarea
                className="app-market-guide-text"
                value={CUSTOM_APP_CREATOR_GUIDE_MD}
                rows={18}
                readOnly
                spellCheck={false}
                aria-label="自定义 APP 制作说明全文"
              />
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-secondary" onClick={() => setCreatorGuideOpen(false)}>关闭</button>
                <button type="button" className="app-market-primary" onClick={() => void copyCreatorGuide()}>
                  <Copy size={18} />
                  <span>复制全文</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
