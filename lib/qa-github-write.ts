import type { QaGithubConfig } from "./qa-github";

// ── 工坊 GitHub 写入（P4）───────────────────────────
// 浏览器端经 Git Data API 提交多文件到分支。所有写操作都需要 PAT 且
// 由用户在 UI 确认后触发（确认模式），或用户显式开启全自动后由 agent 触发。

function apiBase(config: QaGithubConfig): string {
    return (config.apiBase || "https://api.github.com").replace(/\/+$/, "");
}

function writeHeaders(config: QaGithubConfig): Record<string, string> {
    if (!config.token) throw new Error("写操作需要 PAT。请在工坊「仓库」里填入有 Contents: Read and write 权限的 fine-grained PAT。");
    return {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
    };
}

async function ghJson<T>(config: QaGithubConfig, path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${apiBase(config)}${path}`, { ...init, headers: writeHeaders(config), signal });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub ${init.method || "GET"} ${path} → ${response.status}: ${body.slice(0, 200)}`);
    }
    return (await response.json()) as T;
}

export type QaCommitFile = { path: string; content: string };

export type QaCommitResult = {
    sha: string;
    branch: string;
    parentSha: string;
    htmlUrl: string;
    fileCount: number;
};

async function resolveBranch(config: QaGithubConfig, signal?: AbortSignal): Promise<string> {
    if (config.branch) return config.branch;
    const repo = await ghJson<{ default_branch: string }>(config, `/repos/${config.owner}/${config.repo}`, { method: "GET" }, signal);
    return repo.default_branch || "main";
}

async function getRef(config: QaGithubConfig, branch: string, signal?: AbortSignal): Promise<string> {
    const ref = await ghJson<{ object: { sha: string } }>(
        config,
        `/repos/${config.owner}/${config.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        { method: "GET" },
        signal,
    );
    return ref.object.sha;
}

function isMissingRefError(error: unknown): boolean {
    return error instanceof Error && /→ 404/.test(error.message);
}

export type QaBranchResult = { name: string; from: string; sha: string; created: boolean };

/** 从指定分支（默认仓库配置分支/默认分支）创建新分支。已存在时返回 created: false。 */
export async function createQaBranch(
    config: QaGithubConfig,
    input: { name: string; from?: string },
    signal?: AbortSignal,
): Promise<QaBranchResult> {
    const name = input.name.trim();
    if (!name) throw new Error("分支名不能为空。");
    const base = `/repos/${config.owner}/${config.repo}`;
    try {
        const existing = await getRef(config, name, signal);
        return { name, from: name, sha: existing, created: false };
    } catch (error) {
        if (!isMissingRefError(error)) throw error;
    }
    let from = input.from?.trim() || (await resolveBranch(config, signal));
    if (from === name) {
        // 配置分支本身就是要建的分支：改从仓库默认分支切出
        const repo = await ghJson<{ default_branch: string }>(config, base, { method: "GET" }, signal);
        from = repo.default_branch || "main";
    }
    const fromSha = await getRef(config, from, signal);
    await ghJson(
        config,
        `${base}/git/refs`,
        { method: "POST", body: JSON.stringify({ ref: `refs/heads/${name}`, sha: fromSha }) },
        signal,
    );
    return { name, from, sha: fromSha, created: true };
}

/**
 * 提交多个文件到指定分支（默认目标分支）。走 Git Data API：
 * 为每个文件建 blob → 建 tree（base_tree 保留其它文件）→ 建 commit → 更新 ref。
 * 目标分支不存在时自动从配置分支/默认分支创建。
 */
export async function commitQaFiles(
    config: QaGithubConfig,
    input: { message: string; files: QaCommitFile[]; deletes?: string[]; branch?: string },
    signal?: AbortSignal,
): Promise<QaCommitResult> {
    const deletes = (input.deletes ?? []).map((p) => p.replace(/^\/+/, "")).filter(Boolean);
    if (!input.files.length && !deletes.length) throw new Error("没有要提交的文件。");
    const branch = input.branch || (await resolveBranch(config, signal));
    const base = `/repos/${config.owner}/${config.repo}`;

    let parentSha: string;
    try {
        parentSha = await getRef(config, branch, signal);
    } catch (error) {
        if (!isMissingRefError(error) || !input.branch) throw error;
        // 指定的目标分支不存在：从配置分支/默认分支自动创建
        parentSha = (await createQaBranch(config, { name: branch }, signal)).sha;
    }
    const parentCommit = await ghJson<{ tree: { sha: string } }>(config, `${base}/git/commits/${parentSha}`, { method: "GET" }, signal);

    const treeItems: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
    for (const file of input.files) {
        const blob = await ghJson<{ sha: string }>(
            config,
            `${base}/git/blobs`,
            { method: "POST", body: JSON.stringify({ content: file.content, encoding: "utf-8" }) },
            signal,
        );
        treeItems.push({ path: file.path.replace(/^\/+/, ""), mode: "100644", type: "blob", sha: blob.sha });
    }
    // 删除：tree 条目 sha 为 null 即从 base_tree 中移除该文件
    for (const path of deletes) {
        treeItems.push({ path, mode: "100644", type: "blob", sha: null });
    }

    const tree = await ghJson<{ sha: string }>(
        config,
        `${base}/git/trees`,
        { method: "POST", body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeItems }) },
        signal,
    );

    const commit = await ghJson<{ sha: string; html_url?: string }>(
        config,
        `${base}/git/commits`,
        { method: "POST", body: JSON.stringify({ message: input.message, tree: tree.sha, parents: [parentSha] }) },
        signal,
    );

    await ghJson(
        config,
        `${base}/git/refs/heads/${encodeURIComponent(branch)}`,
        { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) },
        signal,
    );

    return {
        sha: commit.sha,
        branch,
        parentSha,
        htmlUrl: commit.html_url || `https://github.com/${config.owner}/${config.repo}/commit/${commit.sha}`,
        fileCount: input.files.length + deletes.length,
    };
}

/** 删除分支（默认分支与配置分支受保护，拒绝删除）。 */
export async function deleteQaBranch(config: QaGithubConfig, name: string, signal?: AbortSignal): Promise<void> {
    const branch = name.trim();
    if (!branch) throw new Error("分支名不能为空。");
    const repo = await ghJson<{ default_branch: string }>(config, `/repos/${config.owner}/${config.repo}`, { method: "GET" }, signal);
    if (branch === repo.default_branch) throw new Error(`「${branch}」是默认分支，拒绝删除。`);
    if (config.branch && branch === config.branch) throw new Error(`「${branch}」是工坊当前配置的工作分支，先在仓库设置里切走再删。`);
    const response = await fetch(
        `${apiBase(config)}/repos/${config.owner}/${config.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
        { method: "DELETE", headers: writeHeaders(config), signal },
    );
    if (response.status === 404 || response.status === 422) throw new Error(`分支「${branch}」不存在。`);
    if (!response.ok) throw new Error(`删除分支失败：HTTP ${response.status}`);
}

export type QaPullResult = { number: number; htmlUrl: string };

/** 创建 Pull Request。 */
export async function createQaPullRequest(
    config: QaGithubConfig,
    input: { title: string; head: string; base?: string; body?: string },
    signal?: AbortSignal,
): Promise<QaPullResult> {
    const base = input.base?.trim() || (await resolveBranch(config, signal));
    const pull = await ghJson<{ number: number; html_url?: string }>(
        config,
        `/repos/${config.owner}/${config.repo}/pulls`,
        { method: "POST", body: JSON.stringify({ title: input.title, head: input.head, base, body: input.body || "" }) },
        signal,
    );
    return {
        number: pull.number,
        htmlUrl: pull.html_url || `https://github.com/${config.owner}/${config.repo}/pull/${pull.number}`,
    };
}

/** 合并 Pull Request。 */
export async function mergeQaPullRequest(
    config: QaGithubConfig,
    input: { number: number; method?: "merge" | "squash" | "rebase" },
    signal?: AbortSignal,
): Promise<{ merged: boolean; sha?: string; message: string }> {
    const result = await ghJson<{ merged?: boolean; sha?: string; message?: string }>(
        config,
        `/repos/${config.owner}/${config.repo}/pulls/${input.number}/merge`,
        { method: "PUT", body: JSON.stringify({ merge_method: input.method || "merge" }) },
        signal,
    );
    return { merged: Boolean(result.merged), sha: result.sha, message: result.message || "" };
}

/** 更新 issue：追加评论和/或开关状态。 */
export async function updateQaIssue(
    config: QaGithubConfig,
    input: { number: number; comment?: string; state?: "open" | "closed" },
    signal?: AbortSignal,
): Promise<void> {
    const base = `/repos/${config.owner}/${config.repo}/issues/${input.number}`;
    if (input.comment?.trim()) {
        await ghJson(config, `${base}/comments`, { method: "POST", body: JSON.stringify({ body: input.comment }) }, signal);
    }
    if (input.state) {
        await ghJson(config, base, { method: "PATCH", body: JSON.stringify({ state: input.state }) }, signal);
    }
}

export type QaIssueResult = { number: number; htmlUrl: string };

/** 创建 GitHub issue（反馈闭环用）。 */
export async function createQaIssue(
    config: QaGithubConfig,
    input: { title: string; body: string; labels?: string[] },
    signal?: AbortSignal,
): Promise<QaIssueResult> {
    const issue = await ghJson<{ number: number; html_url?: string }>(
        config,
        `/repos/${config.owner}/${config.repo}/issues`,
        { method: "POST", body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }) },
        signal,
    );
    return {
        number: issue.number,
        htmlUrl: issue.html_url || `https://github.com/${config.owner}/${config.repo}/issues/${issue.number}`,
    };
}

/**
 * 撤销一次提交：把分支强制回退到该提交的父提交。
 * 仅当分支 HEAD 仍是该提交时才安全（否则报错，避免覆盖后续提交）。
 */
export async function revertQaCommit(config: QaGithubConfig, commit: QaCommitResult, signal?: AbortSignal): Promise<void> {
    const base = `/repos/${config.owner}/${config.repo}`;
    const currentHead = await getRef(config, commit.branch, signal);
    if (currentHead !== commit.sha) {
        throw new Error("分支已有更新的提交，无法安全撤销这一次（避免覆盖后来的改动）。请到 GitHub 手动处理。");
    }
    await ghJson(
        config,
        `${base}/git/refs/heads/${encodeURIComponent(commit.branch)}`,
        { method: "PATCH", body: JSON.stringify({ sha: commit.parentSha, force: true }) },
        signal,
    );
}
