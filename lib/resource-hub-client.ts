// lib/resource-hub-client.ts
// 资源集市客户端：CDN 多镜像拉取 + 目录索引 + 各目的地的导入落库。
// 浏览走 jsDelivr（国内可达、免限流），失败逐级回退，全程不经过自家服务端。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import {
    RESOURCE_HUB_DEFAULT_SOURCE,
    isPreviewImagePath,
    stripAssetImageMark,
    type ImportDestination,
    type ResourceHubSource,
    type ShareIndex,
    type ShareIndexEntry,
    type ShareIndexFolder,
} from "./resource-hub-types";
import { createCharacter, loadCharacters, parseCharacterFromJson, parseCharacterFromPng, saveCharacters } from "./character-storage";
import {
    loadPresets, savePresets, parsePresetFromJson,
    loadWorldBooks, saveWorldBooks, parseWorldBookFromJson,
    loadRegexes, saveRegexes, parseRegexFromJson,
} from "./settings-storage";
import { saveScheme } from "./css-scheme-storage";
import { STATUS_REGION_SCHEME_TARGET } from "./chat-status-region";
import { createOrGetSession, loadChatSessions, saveChatSessions } from "./chat-storage";
import { readThemeProfile, writeThemeProfile } from "./theme-storage";
import type { Prompt } from "./settings-types";
import type { MixMaterial } from "./mixology/types";

const SOURCE_KEY = "ai_phone_resource_hub_source_v1";
registerKvMigration(SOURCE_KEY);

const FETCH_TIMEOUT_MS = 15000;

// ── 源配置 ──

export function loadResourceHubSource(): ResourceHubSource {
    try {
        const raw = kvGet(SOURCE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<ResourceHubSource>;
            if (parsed.owner && parsed.repo) {
                return { owner: parsed.owner, repo: parsed.repo, branch: parsed.branch || "main" };
            }
        }
    } catch { /* fall through */ }
    return { ...RESOURCE_HUB_DEFAULT_SOURCE };
}

export function saveResourceHubSource(source: ResourceHubSource): void {
    kvSet(SOURCE_KEY, JSON.stringify(source));
}

// ── CDN 拉取（多镜像回退）──

function encodePath(path: string): string {
    return path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

// 已解析的最新 commit：@main 的 CDN 缓存可能滞后数小时，@commit 则永远精确。
// 每次拉目录时先问 GitHub 拿 main 的最新 commit 号，之后所有文件都按 commit 定位。
let _resolvedRef: { key: string; sha: string } | null = null;

function sourceKey(source: ResourceHubSource): string {
    return `${source.owner}/${source.repo}@${source.branch}`;
}

function effectiveRef(source: ResourceHubSource): string {
    return _resolvedRef?.key === sourceKey(source) ? _resolvedRef.sha : source.branch;
}

// 中转站 endpoint（与上传/送花同一个;不能 import resource-hub-upload,会循环依赖,直接读同一份配置）
const RELAY_ENDPOINT_FALLBACK = "https://floatshare.netlify.app/.netlify/functions/upload";
function relayEndpoint(): string {
    try {
        const parsed = JSON.parse(kvGet("ai_phone_resource_hub_upload_cfg_v1") || "{}") as { endpoint?: string };
        if (parsed && typeof parsed.endpoint === "string" && parsed.endpoint.trim()) return parsed.endpoint.trim();
    } catch { /* 用默认 */ }
    return RELAY_ENDPOINT_FALLBACK;
}

async function resolveLatestSha(source: ResourceHubSource): Promise<string | null> {
    try {
        const res = await fetchWithTimeout(
            `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.branch)}`,
            { headers: { Accept: "application/vnd.github.sha" } },
        );
        if (res.ok) {
            const sha = (await res.text()).trim();
            if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
        }
    } catch { /* 走中转站兜底 */ }
    // GitHub API 匿名配额（60 次/小时）耗尽时,请中转站代查——否则退回分支名,
    // jsDelivr 对分支的缓存可滞后数小时,刚上传/更新的资源会一直显示旧版
    try {
        const res = await fetchWithTimeout(relayEndpoint(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "head" }),
        });
        if (res.ok) {
            const data = await res.json() as { ok?: boolean; sha?: string; repo?: string };
            if (data.ok && data.repo === `${source.owner}/${source.repo}` && /^[0-9a-f]{40}$/i.test(data.sha || "")) {
                return (data.sha as string);
            }
        }
    } catch { /* 兜底也失败就退回分支名 */ }
    return null;
}

function buildMirrorUrls(source: ResourceHubSource, path: string): string[] {
    const { owner, repo } = source;
    const ref = effectiveRef(source);
    const clean = encodePath(path);
    return [
        `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${clean}`,
        `https://fastly.jsdelivr.net/gh/${owner}/${repo}@${ref}/${clean}`,
        `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${clean}`,
    ];
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal, cache: "no-cache" });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchMirrored(source: ResourceHubSource, path: string): Promise<Response> {
    let lastError: Error = new Error("无可用镜像");
    for (const url of buildMirrorUrls(source, path)) {
        try {
            const res = await fetchWithTimeout(url);
            if (res.ok) return res;
            lastError = new Error(`HTTP ${res.status}`);
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
        }
    }
    throw lastError;
}

/** 逐镜像尝试拉取文本；全部失败抛最后一个错误。 */
export async function fetchResourceHubText(source: ResourceHubSource, path: string): Promise<string> {
    return (await fetchMirrored(source, path)).text();
}

/** 二进制拉取（角色卡 PNG、应用 zip）。 */
export async function fetchResourceHubBinary(source: ResourceHubSource, path: string): Promise<ArrayBuffer> {
    return (await fetchMirrored(source, path)).arrayBuffer();
}

/** 图片等资源的展示 URL（仓库相对路径转 CDN 主镜像）。 */
export function resolveResourceHubAssetUrl(source: ResourceHubSource, pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return buildMirrorUrls(source, pathOrUrl)[0];
}

// ── 目录索引 ──

function normalizeIndex(raw: unknown): ShareIndex {
    const record = (raw ?? {}) as Record<string, unknown>;
    if (record.schema !== "ai_phone_share_index" || !Array.isArray(record.entries) || !Array.isArray(record.folders)) {
        throw new Error("索引格式不正确");
    }
    const folders: ShareIndexFolder[] = [];
    for (const f of record.folders) {
        const item = (f ?? {}) as Record<string, unknown>;
        if (typeof item.name !== "string") continue;
        folders.push({ name: item.name, count: typeof item.count === "number" ? item.count : 0 });
    }
    const entries: ShareIndexEntry[] = [];
    for (const e of record.entries) {
        const item = (e ?? {}) as Record<string, unknown>;
        if (typeof item.folder !== "string" || typeof item.name !== "string" || typeof item.path !== "string") continue;
        entries.push({
            folder: item.folder,
            name: item.name,
            type: item.type === "dir" ? "dir" : "file",
            path: item.path,
            files: Array.isArray(item.files) ? item.files.filter((v): v is string => typeof v === "string") : [],
            images: Array.isArray(item.images) ? item.images.filter((v): v is string => typeof v === "string") : [],
            description: typeof item.description === "string" ? item.description : "",
            author: typeof item.author === "string" ? item.author : "",
            avatar: typeof item.avatar === "string" ? item.avatar : "",
            ownerHash: typeof item.ownerHash === "string" ? item.ownerHash.toLowerCase() : "",
            updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
        });
    }
    return {
        schema: "ai_phone_share_index",
        schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : 1,
        generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : undefined,
        folders,
        entries,
    };
}

const DESC_NAME_RE = /^(说明\.txt|readme\.(md|txt))$/i;
// 基建目录（上传服务/索引脚本等），不是资源，不进市场。
// 索引脚本同样会跳过它们；这里再过滤一层，防御旧索引缓存。
const HIDDEN_FOLDERS = new Set(["netlify", "scripts", "node_modules", ".github", ".git"]);

function stripHiddenFolders(index: ShareIndex): ShareIndex {
    return {
        ...index,
        folders: index.folders.filter(f => !HIDDEN_FOLDERS.has(f.name)),
        entries: index.entries.filter(e => !HIDDEN_FOLDERS.has(e.folder)),
    };
}

/** 资源统一存放的仓库根目录 */
export const RESOURCE_ROOT = "资源";

/** 兜底：_index.json 不可用时，用 jsDelivr data API 的文件树现场构建索引（无时间与说明）。 */
async function buildIndexFromTree(source: ResourceHubSource): Promise<ShareIndex> {
    const { owner, repo, branch } = source;
    const res = await fetchWithTimeout(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${branch}?structure=flat`);
    if (!res.ok) throw new Error(`文件树获取失败（HTTP ${res.status}）`);
    const data = await res.json() as { files?: Array<{ name?: string }> };
    // 只认 资源/ 下的内容：资源/<分类>/<资源子文件夹或孤立文件>
    const paths = (data.files ?? [])
        .map(f => (f.name || "").replace(/^\/+/, ""))
        .filter(p => p.startsWith(`${RESOURCE_ROOT}/`));

    const folderMap = new Map<string, Map<string, ShareIndexEntry>>();
    for (const p of paths) {
        const segments = p.split("/");
        if (segments.length < 3) continue; // 资源/ 下的孤立文件不算资源
        const folder = segments[1];
        if (!folder || folder.startsWith(".") || HIDDEN_FOLDERS.has(folder)) continue;
        const base = segments[segments.length - 1];
        if (base.startsWith(".")) continue; // .owner 等隐藏文件
        if (!folderMap.has(folder)) folderMap.set(folder, new Map());
        const entryMap = folderMap.get(folder)!;
        if (segments.length === 3) {
            // 孤立文件式资源
            const key = `file:${p}`;
            entryMap.set(key, {
                folder,
                name: segments[2].replace(/\.[^.]+$/, ""),
                type: "file",
                path: p,
                files: [p],
                images: [],
                description: "",
                updatedAt: null,
            });
        } else {
            // 子文件夹式资源（取第三层为资源名，深层文件归并进来）
            const entryPath = `${segments[0]}/${segments[1]}/${segments[2]}`;
            const key = `dir:${entryPath}`;
            if (!entryMap.has(key)) {
                entryMap.set(key, {
                    folder,
                    name: segments[2],
                    type: "dir",
                    path: entryPath,
                    files: [],
                    images: [],
                    description: "",
                    updatedAt: null,
                });
            }
            const entry = entryMap.get(key)!;
            // 带 .asset 标记的图片是资源本体（PNG 角色卡等），要进可下载的 files
            if (isPreviewImagePath(base)) entry.images.push(p);
            else if (!DESC_NAME_RE.test(base)) entry.files.push(p);
        }
    }

    const folders: ShareIndexFolder[] = [];
    const entries: ShareIndexEntry[] = [];
    for (const [name, entryMap] of folderMap) {
        folders.push({ name, count: entryMap.size });
        entries.push(...entryMap.values());
    }
    return { schema: "ai_phone_share_index", schemaVersion: 0, folders, entries };
}

/** 强刷 CDN 缓存（fire-and-forget；no-cors 下拿不到响应但清缓存已生效）。 */
export function purgeShareIndexCache(source: ResourceHubSource): void {
    if (typeof fetch === "undefined") return;
    const url = `https://purge.jsdelivr.net/gh/${source.owner}/${source.repo}@${source.branch}/_index.json`;
    fetch(url, { mode: "no-cors" }).catch(() => { /* 尽力而为 */ });
}

export async function fetchShareIndex(source: ResourceHubSource): Promise<ShareIndex> {
    // 先解析最新 commit，命中后本次会话的所有文件都按 commit 定位（免疫 CDN 缓存滞后）
    const sha = await resolveLatestSha(source);
    _resolvedRef = sha ? { key: sourceKey(source), sha } : null;
    try {
        const text = await fetchResourceHubText(source, "_index.json");
        return stripHiddenFolders(normalizeIndex(JSON.parse(text)));
    } catch {
        // 索引缺失/坏掉时退化为现场扫树（无时间排序与说明摘要）
        return stripHiddenFolders(await buildIndexFromTree(source));
    }
}

// ── 下载 ──

export async function downloadResourceHubFile(source: ResourceHubSource, path: string): Promise<void> {
    const buffer = await fetchResourceHubBinary(source, path);
    const filename = stripAssetImageMark(path.split("/").pop() || "resource");
    const { downloadFile } = await import("./download-utils");
    await downloadFile(new Blob([buffer]), filename);
}

// ── 导入 ──

const CHAT_APP_CSS_KEY = "chat-app-custom-css";

function fileBaseName(path: string): string {
    const name = stripAssetImageMark(path.split("/").pop() || path);
    return name.replace(/\.[^.]+$/, "");
}

/** 目的地对文件类型的基本校验；返回错误文案或 null。 */
export function checkImportFileForDestination(destination: ImportDestination, path: string): string | null {
    const lower = path.toLowerCase();
    const isJson = lower.endsWith(".json");
    switch (destination) {
        case "preset":
        case "regex":
        case "worldbook":
        case "game":
        case "theater":
        case "status_bar":
            return isJson ? null : "该目的地需要 JSON 文件";
        case "character":
            return isJson || lower.endsWith(".png") ? null : "角色卡需要 JSON 或 PNG 文件";
        case "chat_session_css":
        case "chat_app_css":
        case "global_css":
            return lower.endsWith(".css") || lower.endsWith(".txt") ? null : "CSS 目的地需要 .css 或 .txt 文件";
        case "custom_app":
            return lower.endsWith(".zip") || lower.endsWith(".html") || lower.endsWith(".htm") ? null : "应用需要 zip 安装包或单 HTML 文件";
        case "plugin":
            return lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".txt") ? null : "插件需要 JS 源码文件";
        case "preset_entry":
            return isJson ? null : "预设条目需要 JSON 文件";
        case "theme":
            // 现在导出的就是 .zip；.ai-theme 是旧版后缀，留作兼容。
            // 真正的校验在 installThemePackageFile 里按包内 manifest.json 做，
            // 这里只是个便宜的前置过滤。
            return lower.endsWith(".zip") || lower.endsWith(".ai-theme") ? null : "主题包需要 zip 文件（旧版 .ai-theme 也可以）";
        case "mixology":
            return isJson || lower.endsWith(".png") ? null : "特调材料需要 JSON 或 PNG 文件（独家特调的导出格式）";
    }
}

/**
 * 取一条预设条目（供集市的「预设条目」流程用）。
 * 单独暴露是因为这条路要先让用户选预设和位置，不能一步到底。
 */
export async function fetchPresetEntry(source: ResourceHubSource, path: string): Promise<Prompt> {
    const { ensureSettingsStorageHydrated } = await import("./settings-storage");
    await ensureSettingsStorageHydrated();
    const { parseSinglePromptEntry } = await import("./preset-entry-import");
    const parsed = parseSinglePromptEntry(await fetchResourceHubText(source, path));
    if (parsed.ok) return parsed.prompt;
    if (parsed.reason === "multiple") {
        throw new Error(`这个文件里有 ${parsed.count} 条条目，不是单条。整份预设请改用「预设」目的地导入。`);
    }
    throw new Error("解析失败，请确认这是预设条目左滑「导出」生成的 JSON");
}

/** 把取到的条目插入/覆盖进指定预设，落盘并返回给用户看的说明。 */
export async function applyPresetEntry(
    prompt: Prompt,
    presetId: string,
    mode: "insert" | "replace",
    anchorIdentifier: string | null,
): Promise<string> {
    const { ensureSettingsStorageHydrated } = await import("./settings-storage");
    await ensureSettingsStorageHydrated();
    const { insertPromptAfter, replacePromptEntry } = await import("./preset-entry-import");
    const presets = loadPresets();
    const target = presets.find(p => p.id === presetId);
    if (!target) throw new Error("目标预设不存在，可能已被删除");
    const next = mode === "replace" && anchorIdentifier
        ? replacePromptEntry(target, anchorIdentifier, prompt)
        : insertPromptAfter(target, anchorIdentifier, prompt);
    savePresets(presets.map(p => p.id === presetId ? next : p));
    dispatch("settings-presets-updated");
    const label = prompt.name || prompt.identifier;
    return mode === "replace"
        ? `已覆盖预设「${target.name}」里的一条条目为「${label}」`
        : `条目「${label}」已插入预设「${target.name}」`;
}

function dispatch(eventName: string): void {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(eventName));
}

function dispatchWith(eventName: string, detail: unknown): void {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(eventName, { detail }));
}

/** PNG 字节 → data URL（角色卡的画像就是这张图本身）。 */
function bytesToPngDataUrl(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * 解析器抛的是内部哨兵串（UNSUPPORTED_IMPORT_FORMAT / CHAR_BLOCKED_FIELDS），
 * 各管理页都会翻译成人话，集市原本直接甩给用户看，会显示成
 * 「导入失败：UNSUPPORTED_IMPORT_FORMAT」。
 */
function translateParseError<T>(run: () => T): T {
    try {
        return run();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "UNSUPPORTED_IMPORT_FORMAT") throw new Error("不支持该文件的格式，请确认它是本应用导出的");
        if (message === "CHAR_BLOCKED_FIELDS") throw new Error("不支持包含开场白、场景或示例对话的角色卡");
        throw err;
    }
}

/**
 * 把资源文件导入到指定目的地。chat_session_css 必须传 contactId（选中的角色会话）。
 * 返回给用户看的结果说明。
 */
export async function importResourceHubFile(
    source: ResourceHubSource,
    path: string,
    destination: ImportDestination,
    options?: {
        contactId?: string;
        authorName?: string;
        /**
         * 特调材料里夹着信任模式机括（不进沙盒、直接在页面里跑）时，落库前先问用户。
         * 收到名单，返回 true 才继续；没传这个回调就一律拒绝，别静默放行。
         */
        confirmTrusted?: (names: string[]) => Promise<boolean>;
    },
): Promise<string> {
    // 下面全是"读出来 → 加一条 → 整份写回"。kv 的 kvSet 是无条件覆盖、kvGet 在
    // 水合前一律返回 null，抢在加载完成前写会把整份旧数据（角色库/主题/草稿/插件）
    // 抹掉。settings 与 chat 两层自带增量兜底，kv 没有，所以这里统一先等齐。
    const { hydrateKvDb } = await import("./kv-db");
    const { hydrateChatStorage } = await import("./chat-storage");
    const { ensureSettingsStorageHydrated } = await import("./settings-storage");
    await Promise.all([hydrateKvDb(), hydrateChatStorage(), ensureSettingsStorageHydrated()]);

    const lower = path.toLowerCase();
    const displayName = fileBaseName(path);
    switch (destination) {
        case "preset": {
            const presetText = await fetchResourceHubText(source, path);
            const preset = translateParseError(() => parsePresetFromJson(presetText, displayName));
            if (!preset) throw new Error("预设解析失败，请确认文件是预设管理页导出的 JSON");
            // 与各管理页一致：新导入的排在最前，别沉到长列表底部
            savePresets([preset, ...loadPresets()]);
            dispatch("settings-presets-updated");
            return `预设「${preset.name}」已导入`;
        }
        case "status_bar": {
            const statusText = await fetchResourceHubText(source, path);
            let statusParsed: Record<string, unknown>;
            try { statusParsed = JSON.parse(statusText) as Record<string, unknown>; }
            catch { throw new Error("状态栏解析失败，请确认文件是聊天信息页导出的 JSON"); }
            const statusContract = typeof statusParsed.contract === "string" ? statusParsed.contract : "";
            const statusRender = typeof statusParsed.renderHtml === "string" ? statusParsed.renderHtml : "";
            if (!statusContract.trim() || !statusRender.trim()) throw new Error("状态栏解析失败，缺少输出契约或渲染代码");
            const statusPreview = typeof statusParsed.previewRaw === "string" ? statusParsed.previewRaw : "";
            saveScheme(STATUS_REGION_SCHEME_TARGET, displayName, JSON.stringify({ contract: statusContract, renderHtml: statusRender, previewRaw: statusPreview }));
            return `状态栏方案「${displayName}」已存入方案库，在聊天信息 → 自定义状态栏中应用`;
        }
        case "regex": {
            const regexText = await fetchResourceHubText(source, path);
            const regex = translateParseError(() => parseRegexFromJson(regexText, displayName));
            if (!regex) throw new Error("正则解析失败，请确认文件是正则管理页导出的 JSON");
            saveRegexes([regex, ...loadRegexes()]);  // saveRegexes 自带事件派发
            return `正则组「${regex.name}」已导入`;
        }
        case "worldbook": {
            const bookText = await fetchResourceHubText(source, path);
            const book = translateParseError(() => parseWorldBookFromJson(bookText));
            if (!book) throw new Error("世界书解析失败，请确认文件是世界书管理页导出的 JSON");
            saveWorldBooks([book, ...loadWorldBooks()]);
            dispatch("settings-worldbooks-updated");
            return `世界书「${book.name}」已导入`;
        }
        case "character": {
            let avatar = "";
            let data;
            if (lower.endsWith(".png")) {
                const buffer = await fetchResourceHubBinary(source, path);
                data = translateParseError(() => parseCharacterFromPng(buffer));
                // PNG 角色卡的画就是这张图本身，导出时 avatar 被有意写成 "none"，
                // 不把图片补回去，导进来的角色就是个空白头像。
                avatar = bytesToPngDataUrl(buffer);
            } else {
                const charText = await fetchResourceHubText(source, path);
                data = translateParseError(() => parseCharacterFromJson(charText));
            }
            if (!data) throw new Error("角色卡解析失败");
            if (!avatar && typeof data.avatar === "string" && data.avatar.trim()) avatar = data.avatar;
            const character = createCharacter(avatar ? { ...data, avatar } : data);
            saveCharacters([character, ...loadCharacters()]);
            return `角色「${character.name}」已加入角色库`;
        }
        case "chat_session_css": {
            const contactId = options?.contactId;
            if (!contactId) throw new Error("请选择要应用的角色");
            const css = await fetchResourceHubText(source, path);
            const session = createOrGetSession(contactId);
            const sessions = loadChatSessions().map(s => s.id === session.id ? { ...s, customCSS: css } : s);
            saveChatSessions(sessions);
            window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: session.id, css } }));
            saveScheme("chat_session", displayName, css);
            return `聊天室 CSS 已应用，并存入方案库「${displayName}」`;
        }
        case "chat_app_css": {
            const css = await fetchResourceHubText(source, path);
            kvSet(CHAT_APP_CSS_KEY, css);
            window.dispatchEvent(new CustomEvent("chat-app-css-updated"));
            saveScheme("chat_app", displayName, css);
            return `聊天主页 CSS 已应用，并存入方案库「${displayName}」`;
        }
        case "global_css": {
            const css = await fetchResourceHubText(source, path);
            writeThemeProfile({ ...readThemeProfile(), globalCustomCSS: css });
            window.dispatchEvent(new CustomEvent("theme-css-updated"));
            saveScheme("global", displayName, css);
            return `全局 CSS 已应用（外观页可调整），并存入方案库「${displayName}」`;
        }
        case "custom_app": {
            const buffer = await fetchResourceHubBinary(source, path);
            const filename = path.split("/").pop() || "app.zip";
            const file = new File([buffer], filename);
            const { loadCustomAppPackage, loadSingleHtmlCustomApp, installCustomAppAsync, CUSTOM_APP_PLACE_DESKTOP_EVENT } = await import("./custom-app-storage");
            const { applyCustomAppRegistrationsAsync } = await import("./custom-app-registration");
            const app = lower.endsWith(".zip") ? await loadCustomAppPackage(file) : await loadSingleHtmlCustomApp(file);
            // 打来源标记：别人的作品，本机能玩，但不进本地测试、不能再发布到应用广场
            const tagged = { ...app, resourceHubPath: path };
            // 重复导入（作者更新了资源）：包每次都会拿到新的随机运行时 id，直接装必然
            // 撞名报错，而报错文案指向的「换包」入口对集市应用是关着的。这里比照小坊
            // 的做法原地更新，保住 id 与安装时间，应用数据不丢。
            const { loadInstalledCustomApps, saveInstalledCustomAppsAsync } = await import("./custom-app-storage");
            const apps = loadInstalledCustomApps();
            const existing = apps.find(a =>
                a.resourceHubPath === path
                || (a.resourceHubPath && a.name.trim().toLowerCase() === tagged.name.trim().toLowerCase()));
            let installed;
            if (existing) {
                installed = { ...tagged, id: existing.id, installedAt: existing.installedAt };
                await saveInstalledCustomAppsAsync([installed, ...apps.filter(a => a.id !== existing.id)]);
            } else {
                installed = await installCustomAppAsync(tagged);
            }
            // 注册（预设/正则等附带声明）失败不阻塞安装：应用已经装上了，
            // 抛出去会显示成「导入失败」，还会顺带跳过下面的摆图标。
            let registerWarning = "";
            try {
                await applyCustomAppRegistrationsAsync(installed);
            } catch (err) {
                registerWarning = `（附带内容注册失败：${err instanceof Error ? err.message : String(err)}）`;
            }
            // 请桌面摆图标：应用广场走 onInstallToDesktop 回调，我们够不着它，
            // 改派同一套事件（小坊装应用也是这么做的）。漏了这步图标不会出现在桌面。
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent(CUSTOM_APP_PLACE_DESKTOP_EVENT, { detail: { appId: installed.id } }));
            }
            return existing
                ? `应用「${installed.name}」已更新（原有数据保留）${registerWarning}`
                : `应用「${installed.name}」已安装，桌面可找到图标（集市来的作品仅供本机使用，不能再发布）${registerWarning}`;
        }
        case "game": {
            const payload = JSON.parse(await fetchResourceHubText(source, path)) as { type?: string; title?: string; draft?: unknown };
            if (payload?.type !== "ai-phone-game-draft" || !payload.draft || typeof payload.draft !== "object") {
                throw new Error("不是有效的游戏草稿文件（需要游戏草稿箱「导出文件」生成）");
            }
            // 别人的作品直接进「我的柜子」当成品玩，不进草稿箱——草稿是可编辑
            // 可发布的，落草稿等于开了二次编辑与转发布的口子。
            // 字段逐个安全取值：文件是外来的，任何字段都可能不是字符串
            const gameDraft = payload.draft as Record<string, unknown>;
            const gstr = (key: string): string => (typeof gameDraft[key] === "string" ? (gameDraft[key] as string).trim() : "");
            const { parseGameRoleSlots, upsertLocalTestGame } = await import("./game-storage");
            const { GAME_EMPTY_PICKER_HTML } = await import("./game-creator-guide");
            const title = (typeof payload.title === "string" && payload.title.trim()) || gstr("title") || displayName;
            const roleSlots = parseGameRoleSlots(gstr("roleSlotsText"));
            const now = new Date().toISOString();
            // 稳定 key 来自集市路径：作者更新资源后重复导入，原地更新同一件
            const hubSlug = `hub_${path.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(-80)}`;
            const gameResult = upsertLocalTestGame(hubSlug, {
                id: hubSlug,
                title,
                codeName: gstr("codeName"),
                subtitle: gstr("subtitle"),
                synopsis: gstr("synopsis"),
                playNote: gstr("playNote"),
                coverImage: gstr("coverImage"),
                tags: gstr("tagsText").split(/[\s,，、]+/).filter(Boolean).slice(0, 8),
                authorId: "resource_hub",
                authorName: gstr("authorName") || options?.authorName?.trim() || "集市投稿人",
                authorAvatar: "",
                source: "local",
                version: 1,
                roleSlots,
                pickerHtml: roleSlots.length > 0 ? gstr("pickerHtml") : GAME_EMPTY_PICKER_HTML,
                gameHtml: gstr("gameHtml"),
                allowExternalControl: gameDraft.allowExternalControl === true,
                purchaseCount: 0,
                rating: 0,
                likeCount: 0,
                favoriteCount: 0,
                commentCount: 0,
                createdAt: now,
                updatedAt: now,
            });
            if (!gameResult.ok) throw new Error(gameResult.error || "游戏包无效");
            return `游戏「${title}」已进我的柜子，直接可玩（集市来的作品不能编辑，也不能发布到大厅）`;
        }
        case "theater": {
            const payload = JSON.parse(await fetchResourceHubText(source, path)) as { type?: string; title?: string; draft?: unknown };
            if (payload?.type !== "ai-phone-theater-draft" || !payload.draft || typeof payload.draft !== "object") {
                throw new Error("不是有效的剧场草稿文件（需要剧场草稿箱「导出文件」生成）");
            }
            // 别人的作品直接进「本地暗柜」当成品演，不进草稿箱——理由同游戏：
            // 草稿可编辑可上架，落草稿等于开了二次编辑与转发布的口子。
            const theaterDraft = payload.draft as Record<string, unknown>;
            const str = (key: string): string => (typeof theaterDraft[key] === "string" ? (theaterDraft[key] as string).trim() : "");
            const theaterTitle = (typeof payload.title === "string" && payload.title.trim()) || str("title") || displayName;
            const aiInstruction = str("aiInstruction");
            const openingHtml = str("openingHtml");
            if (!aiInstruction || !openingHtml) throw new Error("剧场草稿缺少演出指令或开场画面");
            let renderRules: unknown[] = [];
            try {
                const parsedRules = JSON.parse(str("renderRulesText") || "[]");
                if (Array.isArray(parsedRules)) renderRules = parsedRules;
            } catch { renderRules = []; }
            const { upsertLocalTestTheater } = await import("./black-market-storage");
            const theaterNow = new Date().toISOString();
            const theaterSlug = `hub_${path.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(-80)}`;
            const theaterResult = upsertLocalTestTheater(theaterSlug, {
                id: theaterSlug,
                title: theaterTitle,
                codeName: str("codeName"),
                subtitle: str("subtitle"),
                synopsis: str("synopsis"),
                storyText: str("storyText"),
                tags: str("tagsText").split(/[\s,，、]+/).filter(Boolean).slice(0, 8),
                rarity: "common",
                glyph: "◆",
                price: 0,
                authorId: "resource_hub",
                authorName: str("authorName") || options?.authorName?.trim() || "集市投稿人",
                source: "local",
                version: 1,
                durationTurns: 8,
                allowExternalControl: theaterDraft.allowExternalControl === true,
                openingHtml,
                aiInstruction,
                outputContract: str("outputContract"),
                renderRules: renderRules as never,
                renderCss: str("renderCss"),
                memorySummaryPrompt: str("memorySummaryPrompt"),
                purchaseCount: 0,
                rating: 0,
                createdAt: theaterNow,
                updatedAt: theaterNow,
            });
            if (!theaterResult.ok) throw new Error(theaterResult.error || "夜间档案无效");
            return `剧场「${theaterTitle}」已进本地暗柜，可直接开演（集市来的作品不能编辑，也不能上架）`;
        }
        case "theme": {
            const buffer = await fetchResourceHubBinary(source, path);
            const filename = path.split("/").pop() || "theme.zip";
            const { installThemePackageFile, THEME_PACKAGE_INSTALLED_EVENT } = await import("./theme-package");
            // installThemePackageFile 自己就把资源/主题档案/组件/布局都落盘了，
            // 但桌面上那些 React 状态还是旧的，得派事件让 shell 重新落地一次。
            const result = await installThemePackageFile(new File([buffer], filename));
            dispatchWith(THEME_PACKAGE_INSTALLED_EVENT, result);
            return `主题包已应用：${result.summary.assetCount} 个资源，${result.summary.widgetCount} 个桌面组件`;
        }
        case "preset_entry":
            // 这条目的地要先选预设和位置，走 fetchPresetEntry + applyPresetEntry 两步，
            // 不经过这里。留个明确的兜底，免得以后有人直接调进来静默什么都不做。
            throw new Error("预设条目需要先选择目标预设与位置");
        case "mixology": {
            const { importMixRecipePack, mixTrustedMechanismNames, parseMixMaterialsFromJson, parseMixMaterialsFromPng, parseMixRecipeFile } = await import("./mixology/transfer");
            const { loadMixCabinet, saveMixMaterial, MIX_CABINET_UPDATED_EVENT } = await import("./mixology/storage");
            const { MIX_KIND_LABELS } = await import("./mixology/types");
            // 信任模式机括与聊天插件同权限：集市来的必然是陌生人写的代码，落库前必须问过
            const gateTrusted = async (list: MixMaterial[]): Promise<void> => {
                const names = mixTrustedMechanismNames(list);
                if (!names.length) return;
                const ok = options?.confirmTrusted ? await options.confirmTrusted(names) : false;
                if (!ok) throw new Error("已取消：这份资源里有信任模式的机括，未入柜");
            };
            let materials;
            if (lower.endsWith(".png")) {
                materials = parseMixMaterialsFromPng(await fetchResourceHubBinary(source, path));
            } else {
                const text = await fetchResourceHubText(source, path);
                // 配方文件（整杯打包）：配方与材料一起落库，规矩同下
                const pack = parseMixRecipeFile(text);
                if (pack) {
                    await gateTrusted(pack.materials);
                    return importMixRecipePack(pack, options?.authorName);
                }
                materials = parseMixMaterialsFromJson(text);
            }
            if (!materials.length) throw new Error("没有解析到特调材料，请确认文件是独家特调导出的 JSON 或 PNG");
            await gateTrusted(materials);
            // 种类与件数文件自带，全部自动入柜，用户不用选。集市来源打 imported 标记，
            // 与酒材大厅入柜同一套规矩：不能发布、不能编辑，角色卡正文封存，小卷工具拒改。
            // 同名同类的旧导入件就地更新（作者更新资源再导，不堆一柜副本）；
            // 自己的原件 id 不同，永远不会被动到。
            let updated = 0;
            for (const material of materials) {
                const prior = loadMixCabinet().find(
                    (m) => m.imported && m.kind === material.kind && m.name.trim() === material.name.trim(),
                );
                if (prior) updated += 1;
                saveMixMaterial({
                    ...material,
                    id: prior?.id ?? material.id,
                    imported: true,
                    author: options?.authorName?.trim() || material.author,
                    createdAt: prior?.createdAt ?? material.createdAt,
                });
            }
            dispatch(MIX_CABINET_UPDATED_EVENT);
            const listed = materials.slice(0, 4).map((m) => `${MIX_KIND_LABELS[m.kind]}「${m.name}」`).join("、");
            const more = materials.length > 4 ? ` 等 ${materials.length} 件` : "";
            const updatedNote = updated ? `，其中 ${updated} 件是柜中导入件的更新` : "";
            return `${listed}${more}已入柜${updatedNote}（集市来的作品不能发布，角色卡不可编辑）`;
        }
        case "plugin": {
            const code = await fetchResourceHubText(source, path);
            const { installChatPluginFromCode } = await import("./chat-plugin-loader");
            // 装插件即执行代码（模块顶层在校验阶段就会跑），与插件管理页同样的告知不能省
            const result = await installChatPluginFromCode(code);
            if (!result.ok) throw new Error(result.error || "插件安装失败");
            // persistChatPlugin 对新插件直接 enabled: true，装完就已经在跑了
            return result.upgraded
                ? `插件「${result.name}」已升级（${result.fromVersion} → ${result.toVersion}）`
                : `插件「${result.name}」已安装并启用，可在聊天设置的插件管理里关闭`;
        }
    }
}
