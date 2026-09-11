// lib/resource-hub-upload.ts
// 资源集市上传：
//  A) GitHub Token 直传 —— 有仓库写权限的 token 直接提交 main（立即上架）；
//     普通用户 token 自动 fork + 开 PR（待管理员审核）。浏览器直连 api.github.com（支持 CORS）。
//  B) 免账号代传 —— POST 到独立部署的上传服务（share 仓库里的 Netlify Function），
//     由机器人 token 代开 PR。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { ensureIdentityKey } from "./resource-hub-identity";
import { RESOURCE_ROOT } from "./resource-hub-client";
import { markAssetImageName, type ResourceHubSource } from "./resource-hub-types";

const UPLOAD_CFG_KEY = "ai_phone_resource_hub_upload_cfg_v1";
const MY_UPLOADS_KEY = "ai_phone_resource_hub_my_uploads_v1";
registerKvMigration(UPLOAD_CFG_KEY);
registerKvMigration(MY_UPLOADS_KEY);

export const DEFAULT_UPLOAD_ENDPOINT = "https://floatshare.netlify.app/.netlify/functions/upload";

export type ResourceHubUploadConfig = {
    /** 方案 A：用户自己的 GitHub token（可选） */
    githubToken: string;
    /** 方案 B：上传服务地址 */
    endpoint: string;
};

export function loadUploadConfig(): ResourceHubUploadConfig {
    try {
        const raw = kvGet(UPLOAD_CFG_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<ResourceHubUploadConfig>;
            return {
                githubToken: typeof parsed.githubToken === "string" ? parsed.githubToken : "",
                endpoint: typeof parsed.endpoint === "string" && parsed.endpoint.trim() ? parsed.endpoint : DEFAULT_UPLOAD_ENDPOINT,
            };
        }
    } catch { /* fall through */ }
    return { githubToken: "", endpoint: DEFAULT_UPLOAD_ENDPOINT };
}

export function saveUploadConfig(config: ResourceHubUploadConfig): void {
    kvSet(UPLOAD_CFG_KEY, JSON.stringify({
        githubToken: config.githubToken.trim(),
        endpoint: config.endpoint.trim() || DEFAULT_UPLOAD_ENDPOINT,
    }));
}

export type UploadPayloadFile = { name: string; contentBase64: string };

export type UploadPayload = {
    folder: string;
    name: string;
    author: string;
    description: string;
    /** 资源本体 + 图片，函数侧不区分（图片靠扩展名被索引识别） */
    files: UploadPayloadFile[];
    /** 作者头像（64×64 PNG 的纯 base64），可选 */
    avatarBase64?: string;
};

/** 作者编辑已上架资源的载荷（路径不变，只改内容） */
export type EditPayload = {
    /** 标题（可带贴纸/排版标记） */
    title: string;
    author: string;
    description: string;
    avatarBase64?: string;
    /** 新增或覆盖的文件（同名即覆盖） */
    addFiles: UploadPayloadFile[];
    /** 要删掉的文件（传仓库路径或文件名都行） */
    removeFiles: string[];
};

export type UploadResult = {
    /** merged=true 表示已直接进 main（立即上架）；否则为待审核 PR */
    merged: boolean;
    prUrl?: string;
};

// ── 我的上传记录（含自助删除凭证，只存在本机）──

export type MyUploadRecord = {
    /** 仓库内路径：资源/<分类>/<资源名> */
    path: string;
    name: string;
    /** 自助删除凭证（哈希已随投稿写进仓库 .owner，凭证本体只在本机） */
    ownerKey: string;
    uploadedAt: string;
};

export function loadMyUploads(): MyUploadRecord[] {
    try {
        const raw = kvGet(MY_UPLOADS_KEY);
        const parsed = raw ? JSON.parse(raw) as MyUploadRecord[] : [];
        return Array.isArray(parsed) ? parsed.filter(r => r && typeof r.path === "string" && typeof r.ownerKey === "string") : [];
    } catch { return []; }
}

function saveMyUploads(records: MyUploadRecord[]): void {
    kvSet(MY_UPLOADS_KEY, JSON.stringify(records.slice(0, 200)));
}

function recordMyUpload(record: MyUploadRecord): void {
    saveMyUploads([record, ...loadMyUploads().filter(r => r.path !== record.path)]);
}

export function removeMyUploadRecord(path: string): void {
    saveMyUploads(loadMyUploads().filter(r => r.path !== path));
}

// ── 找回作品：丢了摊主钥匙的作者提交证明材料，管理员人工审核 ──

export type OwnershipClaimInput = {
    endpoint: string;
    /** 仓库内路径：资源/<分类>/<资源名> */
    path: string;
    name: string;
    /** 申请人当前摊主钥匙的指纹（审核通过后 .owner 会绑到它） */
    ownerHash: string;
    nickname: string;
    note: string;
    files: UploadPayloadFile[];
};

/** 提交找回申请：中转函数把证明材料开成申请 PR，等管理员在管理中心裁决 */
export async function submitOwnershipClaim(input: OwnershipClaimInput): Promise<{ prNumber: number; prUrl: string }> {
    const res = await fetch(input.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            action: "claim",
            path: input.path,
            name: input.name,
            ownerHash: input.ownerHash,
            nickname: input.nickname,
            note: input.note,
            files: input.files,
        }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; prNumber?: number; prUrl?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || `提交失败（${res.status}）`);
    return { prNumber: data.prNumber || 0, prUrl: data.prUrl || "" };
}

// 发布用的钥匙 = 本机「摊主钥匙」。以前是一个资源一把随机钥匙，换设备就全丢；
// 现在全部资源共用一把，导出这一行短码就能在新设备上认领回所有发布。
function generateOwnerKey(): Promise<string> {
    return ensureIdentityKey();
}

/** 导入钥匙时把早期的单资源凭证并进本机记录（同路径以已有的为准） */
export function mergeMyUploads(records: MyUploadRecord[]): void {
    const existing = loadMyUploads();
    const known = new Set(existing.map(r => r.path));
    saveMyUploads([...existing, ...records.filter(r => !known.has(r.path))]);
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 选中的文件 → 上传条目。
 * asset=true 表示投稿人是从「选择资源文件」进来的：如果它是图片，加上 .asset 标记，
 * 索引才知道这张图是资源本体（PNG 角色卡、表情包），而不是配图。
 */
export async function fileToUploadEntry(file: File, options?: { asset?: boolean }): Promise<UploadPayloadFile> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const name = options?.asset ? markAssetImageName(file.name) : file.name;
    return { name, contentBase64: btoa(binary) };
}

// ── 方案 B：上传服务 ──

export async function uploadViaService(endpoint: string, payload: UploadPayload): Promise<UploadResult> {
    const ownerKey = await generateOwnerKey();
    const ownerKeyHash = await sha256Hex(ownerKey);
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, ownerKeyHash }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; prUrl?: string; path?: string };
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `上传服务返回 HTTP ${res.status}`);
    }
    recordMyUpload({
        // 服务端会把标题安全化成文件夹名，以它返回的真实路径为准，
        // 否则本机凭证记录会对不上，日后删不掉也改不了
        path: data.path || `${RESOURCE_ROOT}/${payload.folder}/${payload.name}`,
        name: payload.name,
        ownerKey,
        uploadedAt: new Date().toISOString(),
    });
    return { merged: false, prUrl: data.prUrl };
}

/** 作者自助编辑（免账号路径）：凭本机凭证请求上传服务改内容。 */
export async function editViaService(endpoint: string, record: MyUploadRecord, payload: EditPayload): Promise<void> {
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", path: record.path, ownerKey: record.ownerKey, ...payload }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `编辑服务返回 HTTP ${res.status}`);
    }
    // 标题可能改了，本机记录跟着更新
    saveMyUploads(loadMyUploads().map(r => (r.path === record.path ? { ...r, name: payload.title || r.name } : r)));
}

/** 投稿者自助下架：把本机保存的删除凭证发给上传服务比对后删除。 */
export async function ownerDeleteViaService(endpoint: string, record: MyUploadRecord): Promise<void> {
    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", path: record.path, ownerKey: record.ownerKey }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `删除服务返回 HTTP ${res.status}`);
    }
    removeMyUploadRecord(record.path);
}

// ── 方案 A：GitHub Token 直传 ──

const GH_API = "https://api.github.com";

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${GH_API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const message = (data as { message?: string })?.message || `GitHub API ${res.status}`;
        throw new Error(message);
    }
    return data as T;
}

/** 仓库里某个路径是否存在（目录或文件都算）。查不到、查出错都当不存在。 */
async function pathExists(token: string, repoPath: string, path: string, ref: string): Promise<boolean> {
    try {
        await gh(token, "GET", `/repos/${repoPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
        return true;
    } catch { return false; }
}

/**
 * 一次提交写多个文件（Git Data API：blobs → tree → commit → 更新 ref）。
 *
 * 原先是每个文件单独打一次 contents API，一个资源九个文件就是九次提交，两个后果：
 *  1. 撞 GitHub 的乐观锁——share 仓库的 build-index Action 监听 main，你写完第一个
 *     文件它就重建 _index.json 推一格，第二个文件带着旧头过去就是
 *     「main is at X but expected Y」；
 *  2. 没有原子性——第 N 次失败时前 N-1 个文件已经落库，仓库里留下一份没有 .owner
 *     的空壳资源，作者既看不到（本机没记上凭证）也删不掉（凭证比对不上）。
 * 合成一次提交后两个问题一起消失，Action 也只会被触发一次。
 */
async function commitFiles(
    token: string,
    repoPath: string,
    branch: string,
    message: string,
    writes: { path: string; contentBase64: string }[],
    deletes: string[] = [],
): Promise<void> {
    if (writes.length === 0 && deletes.length === 0) return;

    // blob 不动分支，先一次性传完；下面重试时这些 sha 可以直接复用。
    const entries: Record<string, unknown>[] = [];
    for (const item of writes) {
        const blob = await gh<{ sha: string }>(token, "POST", `/repos/${repoPath}/git/blobs`, {
            content: item.contentBase64,
            encoding: "base64",
        });
        entries.push({ path: item.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    // 树里 sha 置空表示删除。调用方只塞确实存在的路径，否则 GitHub 会整棵树报错。
    for (const path of deletes) {
        entries.push({ path, mode: "100644", type: "blob", sha: null });
    }

    // 分支头仍可能在这期间被推进（build-index 机器人、另一台设备同时投稿、
    // 管理员正好合了 PR）。更新 ref 会以非快进被拒；重读分支头拿新父提交重来即可。
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const ref = await gh<{ object: { sha: string } }>(token, "GET", `/repos/${repoPath}/git/ref/heads/${branch}`);
            const headSha = ref.object.sha;
            const head = await gh<{ tree: { sha: string } }>(token, "GET", `/repos/${repoPath}/git/commits/${headSha}`);
            const tree = await gh<{ sha: string }>(token, "POST", `/repos/${repoPath}/git/trees`, {
                base_tree: head.tree.sha,
                tree: entries,
            });
            const commit = await gh<{ sha: string }>(token, "POST", `/repos/${repoPath}/git/commits`, {
                message,
                tree: tree.sha,
                parents: [headSha],
            });
            await gh(token, "PATCH", `/repos/${repoPath}/git/refs/heads/${branch}`, { sha: commit.sha });
            return;
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        }
    }
    throw lastError instanceof Error ? lastError : new Error("提交失败，请稍后重试");
}

/** 标题 → 安全的文件夹名（与上传服务的规则保持一致） */
export function safeSegment(value: string): string {
    return value.trim()
        .replace(/[\\/:*?"<>|#%\x00-\x1f]/g, "")
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 60);
}

export async function uploadViaToken(token: string, source: ResourceHubSource, payload: UploadPayload): Promise<UploadResult> {
    const { owner, repo, branch } = source;
    const dirName = safeSegment(payload.name);
    const dir = `${RESOURCE_ROOT}/${payload.folder}/${dirName}`;

    // 同分类同名 = 同一个文件夹，写进去就是覆盖别人的资源。投稿一律不许覆盖，
    // 在传任何东西之前就拦下来（判定看上游仓库，fork 里的副本不算数）。
    // 作者要更新自己的资源走「编辑」入口，那条路凭 .owner 认人。
    if (await pathExists(token, `${owner}/${repo}`, dir, branch)) {
        throw new Error(`「${payload.folder}」里已经有叫「${dirName}」的资源了，换个名字再发`);
    }

    const ownerKey = await generateOwnerKey();
    const toWrite: UploadPayloadFile[] = [...payload.files];
    if (payload.description.trim()) {
        toWrite.push({
            name: "说明.txt",
            contentBase64: btoa(unescape(encodeURIComponent(payload.description.trim()))),
        });
    }
    // 删除凭证哈希写进资源文件夹，凭证本体只留在本机
    toWrite.push({ name: ".owner", contentBase64: btoa(await sha256Hex(ownerKey)) });
    // 投稿人写进 .author，索引带上后详情页展示
    if (payload.author.trim()) {
        toWrite.push({ name: ".author", contentBase64: btoa(unescape(encodeURIComponent(payload.author.trim()))) });
    }
    // 原始标题（可能带贴纸标记，与安全化后的文件夹名不同）
    if (payload.name.trim() && payload.name.trim() !== dirName) {
        toWrite.push({ name: ".title", contentBase64: btoa(unescape(encodeURIComponent(payload.name.trim()))) });
    }
    if (payload.avatarBase64) {
        toWrite.push({ name: ".avatar.png", contentBase64: payload.avatarBase64 });
    }
    const writes = toWrite.map(file => ({ path: `${dir}/${file.name}`, contentBase64: file.contentBase64 }));

    // 有写权限（仓库主/协作者）→ 直接提交默认分支，立即上架
    const repoInfo = await gh<{ permissions?: { push?: boolean } }>(token, "GET", `/repos/${owner}/${repo}`);
    if (repoInfo.permissions?.push) {
        await commitFiles(token, `${owner}/${repo}`, branch, `上架：${dir}`, writes);
        recordMyUpload({ path: dir, name: payload.name, ownerKey, uploadedAt: new Date().toISOString() });
        return { merged: true };
    }

    // 普通用户 → fork + 分支提交 + 跨仓库 PR
    const me = await gh<{ login: string }>(token, "GET", "/user");
    const fork = await gh<{ full_name: string; default_branch: string }>(token, "POST", `/repos/${owner}/${repo}/forks`, {});
    const [forkOwner, forkRepo] = fork.full_name.split("/");

    // fork 是异步创建的，轮询等它就绪
    let forkReady = false;
    for (let i = 0; i < 10; i++) {
        try {
            await gh(token, "GET", `/repos/${forkOwner}/${forkRepo}/git/ref/heads/${fork.default_branch || branch}`);
            forkReady = true;
            break;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }
    if (!forkReady) throw new Error("fork 创建超时，请稍后重试");

    const baseRef = await gh<{ object: { sha: string } }>(token, "GET", `/repos/${forkOwner}/${forkRepo}/git/ref/heads/${fork.default_branch || branch}`);
    const submitBranch = `submit-${Date.now().toString(36)}`;
    await gh(token, "POST", `/repos/${forkOwner}/${forkRepo}/git/refs`, {
        ref: `refs/heads/${submitBranch}`,
        sha: baseRef.object.sha,
    });
    await commitFiles(token, `${forkOwner}/${forkRepo}`, submitBranch, `投稿：${dir}`, writes);
    const pr = await gh<{ html_url: string }>(token, "POST", `/repos/${owner}/${repo}/pulls`, {
        title: `投稿：${dir}`,
        head: `${me.login}:${submitBranch}`,
        base: branch,
        body: `来自资源集市 App 的投稿。\n\n- 分类：${payload.folder}\n- 名称：${payload.name}\n- 投稿人：${payload.author || me.login}${payload.description.trim() ? `\n\n${payload.description.trim()}` : ""}`,
    });
    recordMyUpload({ path: dir, name: payload.name, ownerKey, uploadedAt: new Date().toISOString() });
    return { merged: false, prUrl: pr.html_url };
}

/** 作者编辑（Token 直传路径）：直接改仓库里的文件。 */
export async function editViaToken(token: string, source: ResourceHubSource, record: MyUploadRecord, payload: EditPayload): Promise<void> {
    const { owner, repo, branch } = source;
    const repoPath = `${owner}/${repo}`;
    const dirName = record.path.split("/")[2] || "";

    // 编辑是覆盖自己的资源，路径不变，所以不做查重；但删除项要先确认存在，
    // 否则树里那条 sha:null 会让整次提交被 GitHub 拒掉。
    const writes: { path: string; contentBase64: string }[] = [];
    const deletes: string[] = [];
    const queueWrite = (name: string, contentBase64: string) => {
        writes.push({ path: `${record.path}/${name}`, contentBase64 });
    };
    const queueDelete = async (name: string) => {
        if (await pathExists(token, repoPath, `${record.path}/${name}`, branch)) {
            deletes.push(`${record.path}/${name}`);
        }
    };

    for (const raw of payload.removeFiles) {
        const name = raw.split("/").pop() || "";
        if (name && !name.startsWith(".")) await queueDelete(name);
    }
    for (const file of payload.addFiles) queueWrite(file.name, file.contentBase64);

    const title = payload.title.trim();
    const fields: Array<{ name: string; value: string }> = [
        { name: ".title", value: title && title !== dirName ? title : "" },
        { name: "说明.txt", value: payload.description.trim() },
        { name: ".author", value: payload.author.trim() },
    ];
    for (const field of fields) {
        if (field.value) queueWrite(field.name, btoa(unescape(encodeURIComponent(field.value))));
        else await queueDelete(field.name);
    }
    if (payload.avatarBase64) queueWrite(".avatar.png", payload.avatarBase64);

    // 同名文件既删又写时（删掉旧图又传了同名新图）只保留写入：一棵树里同路径
    // 出现两次的行为没有保证，与其赌不如在这里定死。
    const writePaths = new Set(writes.map(item => item.path));
    await commitFiles(token, repoPath, branch, `编辑：${record.path}`, writes, deletes.filter(path => !writePaths.has(path)));

    saveMyUploads(loadMyUploads().map(r => (r.path === record.path ? { ...r, name: title || r.name } : r)));
}

/** 统一入口：配了 token 走直传，否则走上传服务。 */
export async function uploadResource(source: ResourceHubSource, payload: UploadPayload): Promise<UploadResult> {
    const config = loadUploadConfig();
    if (config.githubToken.trim()) {
        return uploadViaToken(config.githubToken.trim(), source, payload);
    }
    return uploadViaService(config.endpoint, payload);
}

/** 统一编辑入口：同上，token 优先。 */
export async function editResource(source: ResourceHubSource, record: MyUploadRecord, payload: EditPayload): Promise<void> {
    const config = loadUploadConfig();
    const token = config.githubToken.trim();
    // 与上传一致：只有对仓库有写权限（仓库主/协作者）才直连 GitHub 提交；
    // 普通用户填了自己的 Token 也没有写权限，直连会被 403，退回上传服务凭钥匙改。
    // 权限查不到（网络/Token 失效）也按没有写权限处理，别让编辑卡死在 Token 上。
    if (token && await hasPushPermission(token, source)) {
        return editViaToken(token, source, record, payload);
    }
    return editViaService(config.endpoint, record, payload);
}

async function hasPushPermission(token: string, source: ResourceHubSource): Promise<boolean> {
    try {
        const info = await gh<{ permissions?: { push?: boolean } }>(token, "GET", `/repos/${source.owner}/${source.repo}`);
        return info.permissions?.push === true;
    } catch {
        return false;
    }
}
