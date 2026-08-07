import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

// ── 工坊 GitHub 接入（P3：只读）─────────────────────
// 浏览器端直连 GitHub REST API（支持 CORS）。配置（含 PAT）只存本地 kv，
// 绝不进 NEXT_PUBLIC、绝不上传。公开仓库可不填 PAT（有速率限制）。

const QA_GITHUB_CONFIG_KEY = "ai_phone_qa_github_v1";
registerKvMigration(QA_GITHUB_CONFIG_KEY);

export type QaGithubConfig = {
    owner: string;
    repo: string;
    branch?: string;
    /** fine-grained PAT，仅私有仓库或提高速率需要。只存本地。 */
    token?: string;
    /** 默认 https://api.github.com；GitHub Enterprise 或测试可覆盖。 */
    apiBase?: string;
    /** 写入模式：confirm=改前需用户确认（默认）；auto=说完直接改直接推。 */
    writeMode?: "confirm" | "auto";
};

export function loadQaGithubConfig(): QaGithubConfig | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(QA_GITHUB_CONFIG_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as QaGithubConfig;
        if (!parsed.owner || !parsed.repo) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveQaGithubConfig(config: QaGithubConfig): void {
    if (typeof window === "undefined") return;
    kvSet(QA_GITHUB_CONFIG_KEY, JSON.stringify(config));
}

export function clearQaGithubConfig(): void {
    if (typeof window === "undefined") return;
    kvRemove(QA_GITHUB_CONFIG_KEY);
}

function apiBase(config: QaGithubConfig): string {
    return (config.apiBase || "https://api.github.com").replace(/\/+$/, "");
}

function authHeaders(config: QaGithubConfig): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    return headers;
}

async function ghFetch(config: QaGithubConfig, path: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${apiBase(config)}${path}`, { headers: authHeaders(config), signal });
}

export type QaGithubValidation = {
    ok: boolean;
    private?: boolean;
    defaultBranch?: string;
    fullName?: string;
    error?: string;
};

/** 校验配置：能否访问该仓库，返回默认分支与可见性。 */
export async function validateQaGithubConfig(config: QaGithubConfig, signal?: AbortSignal): Promise<QaGithubValidation> {
    try {
        const response = await ghFetch(config, `/repos/${config.owner}/${config.repo}`, signal);
        if (response.status === 404) {
            return { ok: false, error: "仓库不存在，或是私有仓库但 PAT 无权限。检查 owner/repo 拼写，或填入有该仓库权限的 fine-grained PAT。" };
        }
        if (response.status === 401) return { ok: false, error: "PAT 无效或已过期。" };
        if (response.status === 403) {
            const remaining = response.headers.get("x-ratelimit-remaining");
            if (remaining === "0") return { ok: false, error: "GitHub API 速率超限（未登录每小时 60 次）。填入 PAT 可提升到每小时 5000 次。" };
            return { ok: false, error: "访问被拒绝（403）。" };
        }
        if (!response.ok) return { ok: false, error: `GitHub 返回 ${response.status}` };
        const data = (await response.json()) as { private?: boolean; default_branch?: string; full_name?: string };
        return { ok: true, private: data.private, defaultBranch: data.default_branch, fullName: data.full_name };
    } catch (error) {
        return { ok: false, error: `连接失败：${error instanceof Error ? error.message : String(error)}（浏览器直连 GitHub，检查网络）` };
    }
}

async function resolveBranch(config: QaGithubConfig, signal?: AbortSignal): Promise<string> {
    if (config.branch) return config.branch;
    const validation = await validateQaGithubConfig(config, signal);
    return validation.defaultBranch || "main";
}

export type QaGithubTreeEntry = { path: string; type: "blob" | "tree"; size?: number };

/** 拉取整棵文件树（recursive）。返回 blob（文件）与 tree（目录）路径。 */
export async function getQaGithubTree(config: QaGithubConfig, signal?: AbortSignal): Promise<{ entries: QaGithubTreeEntry[]; truncated: boolean }> {
    const branch = await resolveBranch(config, signal);
    const response = await ghFetch(config, `/repos/${config.owner}/${config.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, signal);
    if (!response.ok) throw new Error(`获取文件树失败：HTTP ${response.status}`);
    const data = (await response.json()) as { tree?: Array<{ path: string; type: string; size?: number }>; truncated?: boolean };
    const entries: QaGithubTreeEntry[] = (data.tree || [])
        .filter((e) => e.type === "blob" || e.type === "tree")
        .map((e) => ({ path: e.path, type: e.type as "blob" | "tree", size: e.size }));
    return { entries, truncated: Boolean(data.truncated) };
}

export type QaGithubFile = { path: string; text: string; size: number; truncated: boolean };

/** 读取单个文件内容（base64 解码）。 */
export async function readQaGithubFile(config: QaGithubConfig, path: string, signal?: AbortSignal): Promise<QaGithubFile> {
    const branch = await resolveBranch(config, signal);
    const cleanPath = path.replace(/^\/+/, "");
    const response = await ghFetch(
        config,
        `/repos/${config.owner}/${config.repo}/contents/${cleanPath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
        signal,
    );
    if (response.status === 404) throw new Error(`文件不存在：${cleanPath}`);
    if (!response.ok) throw new Error(`读取文件失败：HTTP ${response.status}`);
    const data = (await response.json()) as { content?: string; encoding?: string; size?: number; type?: string };
    if (data.type !== "file") throw new Error(`${cleanPath} 不是文件（可能是目录）`);
    let text = "";
    if (data.encoding === "base64" && typeof data.content === "string") {
        try {
            text = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))));
        } catch {
            text = atob(data.content.replace(/\n/g, ""));
        }
    }
    return { path: cleanPath, text, size: data.size ?? text.length, truncated: false };
}

export type QaGithubCommitSummary = { sha: string; message: string; author: string; date: string };

/** 提交历史（可按分支/文件路径过滤）。 */
export async function listQaGithubCommits(
    config: QaGithubConfig,
    opts: { branch?: string; path?: string; limit?: number },
    signal?: AbortSignal,
): Promise<QaGithubCommitSummary[]> {
    const branch = opts.branch || (await resolveBranch(config, signal));
    const params = new URLSearchParams({ sha: branch, per_page: String(Math.min(30, Math.max(1, opts.limit ?? 10))) });
    if (opts.path) params.set("path", opts.path.replace(/^\/+/, ""));
    const response = await ghFetch(config, `/repos/${config.owner}/${config.repo}/commits?${params}`, signal);
    if (!response.ok) throw new Error(`获取提交历史失败：HTTP ${response.status}`);
    const data = (await response.json()) as Array<{ sha: string; commit: { message: string; author?: { name?: string; date?: string } } }>;
    return data.map((c) => ({
        sha: c.sha,
        message: c.commit.message.split("\n")[0],
        author: c.commit.author?.name ?? "?",
        date: c.commit.author?.date ?? "",
    }));
}

export type QaGithubCommitDetail = {
    sha: string;
    message: string;
    files: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
};

/** 单个提交的改动详情（含每个文件的 diff patch）。 */
export async function getQaGithubCommit(config: QaGithubConfig, sha: string, signal?: AbortSignal): Promise<QaGithubCommitDetail> {
    const response = await ghFetch(config, `/repos/${config.owner}/${config.repo}/commits/${encodeURIComponent(sha)}`, signal);
    if (response.status === 404) throw new Error(`提交不存在：${sha}`);
    if (!response.ok) throw new Error(`获取提交详情失败：HTTP ${response.status}`);
    const data = (await response.json()) as {
        sha: string;
        commit: { message: string };
        files?: Array<{ filename: string; status: string; additions?: number; deletions?: number; patch?: string }>;
    };
    return {
        sha: data.sha,
        message: data.commit.message,
        files: (data.files || []).map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions ?? 0,
            deletions: f.deletions ?? 0,
            patch: f.patch,
        })),
    };
}

/** 分支列表（含各分支头 sha 与默认分支标记）。 */
export async function listQaGithubBranches(
    config: QaGithubConfig,
    signal?: AbortSignal,
): Promise<{ branches: Array<{ name: string; sha: string }>; defaultBranch: string }> {
    const validation = await validateQaGithubConfig(config, signal);
    const response = await ghFetch(config, `/repos/${config.owner}/${config.repo}/branches?per_page=100`, signal);
    if (!response.ok) throw new Error(`获取分支列表失败：HTTP ${response.status}`);
    const data = (await response.json()) as Array<{ name: string; commit: { sha: string } }>;
    return {
        branches: data.map((b) => ({ name: b.name, sha: b.commit.sha })),
        defaultBranch: validation.defaultBranch || "main",
    };
}

export type QaGithubPullSummary = { number: number; title: string; state: string; head: string; base: string; htmlUrl: string };

/** PR 列表。 */
export async function listQaGithubPulls(
    config: QaGithubConfig,
    state: "open" | "closed" | "all",
    signal?: AbortSignal,
): Promise<QaGithubPullSummary[]> {
    const response = await ghFetch(config, `/repos/${config.owner}/${config.repo}/pulls?state=${state}&per_page=20`, signal);
    if (!response.ok) throw new Error(`获取 PR 列表失败：HTTP ${response.status}`);
    const data = (await response.json()) as Array<{
        number: number; title: string; state: string; html_url?: string;
        head: { ref: string }; base: { ref: string };
    }>;
    return data.map((p) => ({
        number: p.number, title: p.title, state: p.state,
        head: p.head.ref, base: p.base.ref,
        htmlUrl: p.html_url || `https://github.com/${config.owner}/${config.repo}/pull/${p.number}`,
    }));
}

export type QaGithubPullDetail = QaGithubPullSummary & {
    body: string;
    mergeable: boolean | null;
    merged: boolean;
    files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
};

/** PR 详情 + 改动文件列表。 */
export async function getQaGithubPull(config: QaGithubConfig, number: number, signal?: AbortSignal): Promise<QaGithubPullDetail> {
    const base = `/repos/${config.owner}/${config.repo}/pulls/${number}`;
    const response = await ghFetch(config, base, signal);
    if (response.status === 404) throw new Error(`PR #${number} 不存在。`);
    if (!response.ok) throw new Error(`获取 PR 详情失败：HTTP ${response.status}`);
    const p = (await response.json()) as {
        number: number; title: string; state: string; body?: string; html_url?: string;
        mergeable?: boolean | null; merged?: boolean;
        head: { ref: string }; base: { ref: string };
    };
    let files: QaGithubPullDetail["files"] = [];
    try {
        const filesResp = await ghFetch(config, `${base}/files?per_page=50`, signal);
        if (filesResp.ok) {
            const list = (await filesResp.json()) as Array<{ filename: string; status: string; additions?: number; deletions?: number }>;
            files = list.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions ?? 0, deletions: f.deletions ?? 0 }));
        }
    } catch {
        // 文件列表拿不到不阻塞详情
    }
    return {
        number: p.number, title: p.title, state: p.state,
        head: p.head.ref, base: p.base.ref,
        htmlUrl: p.html_url || `https://github.com/${config.owner}/${config.repo}/pull/${p.number}`,
        body: p.body || "", mergeable: p.mergeable ?? null, merged: Boolean(p.merged), files,
    };
}

export type QaGithubIssueSummary = { number: number; title: string; state: string; htmlUrl: string };

/** Issue 列表（不含 PR）。 */
export async function listQaGithubIssues(
    config: QaGithubConfig,
    state: "open" | "closed" | "all",
    signal?: AbortSignal,
): Promise<QaGithubIssueSummary[]> {
    const response = await ghFetch(config, `/repos/${config.owner}/${config.repo}/issues?state=${state}&per_page=20`, signal);
    if (!response.ok) throw new Error(`获取 issue 列表失败：HTTP ${response.status}`);
    const data = (await response.json()) as Array<{ number: number; title: string; state: string; html_url?: string; pull_request?: unknown }>;
    return data
        .filter((i) => !i.pull_request)
        .map((i) => ({
            number: i.number, title: i.title, state: i.state,
            htmlUrl: i.html_url || `https://github.com/${config.owner}/${config.repo}/issues/${i.number}`,
        }));
}

export type QaGithubIssueDetail = QaGithubIssueSummary & {
    body: string;
    comments: Array<{ author: string; body: string }>;
};

/** Issue 详情 + 评论。 */
export async function getQaGithubIssue(config: QaGithubConfig, number: number, signal?: AbortSignal): Promise<QaGithubIssueDetail> {
    const base = `/repos/${config.owner}/${config.repo}/issues/${number}`;
    const response = await ghFetch(config, base, signal);
    if (response.status === 404) throw new Error(`Issue #${number} 不存在。`);
    if (!response.ok) throw new Error(`获取 issue 详情失败：HTTP ${response.status}`);
    const issue = (await response.json()) as { number: number; title: string; state: string; body?: string; html_url?: string };
    let comments: QaGithubIssueDetail["comments"] = [];
    try {
        const commentsResp = await ghFetch(config, `${base}/comments?per_page=30`, signal);
        if (commentsResp.ok) {
            const list = (await commentsResp.json()) as Array<{ user?: { login?: string }; body?: string }>;
            comments = list.map((c) => ({ author: c.user?.login ?? "?", body: c.body ?? "" }));
        }
    } catch {
        // 评论拿不到不阻塞详情
    }
    return {
        number: issue.number, title: issue.title, state: issue.state,
        htmlUrl: issue.html_url || `https://github.com/${config.owner}/${config.repo}/issues/${issue.number}`,
        body: issue.body || "", comments,
    };
}

export type QaGithubSearchHit = { path: string; snippet?: string };

/** 代码搜索。优先 GitHub 搜索 API；失败或无 PAT 时退化为文件树路径匹配。 */
export async function searchQaGithubCode(config: QaGithubConfig, query: string, signal?: AbortSignal): Promise<{ hits: QaGithubSearchHit[]; mode: "code-search" | "path-fallback" }> {
    // GitHub 代码搜索 API 需要认证
    if (config.token) {
        try {
            const q = encodeURIComponent(`${query} repo:${config.owner}/${config.repo}`);
            const response = await ghFetch(config, `/search/code?q=${q}&per_page=20`, signal);
            if (response.ok) {
                const data = (await response.json()) as { items?: Array<{ path: string }> };
                return { hits: (data.items || []).map((i) => ({ path: i.path })), mode: "code-search" };
            }
        } catch {
            // 落到路径匹配
        }
    }
    const { entries } = await getQaGithubTree(config, signal);
    const lower = query.toLowerCase();
    const hits = entries
        .filter((e) => e.type === "blob" && e.path.toLowerCase().includes(lower))
        .slice(0, 30)
        .map((e) => ({ path: e.path }));
    return { hits, mode: "path-fallback" };
}
