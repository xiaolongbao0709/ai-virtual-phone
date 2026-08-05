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

/**
 * 提交多个文件到指定分支（默认目标分支）。走 Git Data API：
 * 为每个文件建 blob → 建 tree（base_tree 保留其它文件）→ 建 commit → 更新 ref。
 */
export async function commitQaFiles(
    config: QaGithubConfig,
    input: { message: string; files: QaCommitFile[]; branch?: string },
    signal?: AbortSignal,
): Promise<QaCommitResult> {
    if (!input.files.length) throw new Error("没有要提交的文件。");
    const branch = input.branch || (await resolveBranch(config, signal));
    const base = `/repos/${config.owner}/${config.repo}`;

    const parentSha = await getRef(config, branch, signal);
    const parentCommit = await ghJson<{ tree: { sha: string } }>(config, `${base}/git/commits/${parentSha}`, { method: "GET" }, signal);

    const treeItems = [];
    for (const file of input.files) {
        const blob = await ghJson<{ sha: string }>(
            config,
            `${base}/git/blobs`,
            { method: "POST", body: JSON.stringify({ content: file.content, encoding: "utf-8" }) },
            signal,
        );
        treeItems.push({ path: file.path.replace(/^\/+/, ""), mode: "100644", type: "blob", sha: blob.sha });
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
        fileCount: input.files.length,
    };
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
