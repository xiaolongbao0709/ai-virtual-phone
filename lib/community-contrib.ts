// 共同建设：自部署用户把自己 fork 里的改动贡献回官方仓库。
// 读侧全部走 GitHub 公共接口（compare API 直接给出"相对合并基准的差异"，
// 换文件清单和逐行 patch 都不用自己算）；写侧走资源集市的上传中转函数
// （action=contribute），由它持机器人 token 在官方仓库开 community PR。
// 本模块零密钥：任何自部署站点开箱即用。

export const UPSTREAM_REPO = "xiaolongbao0709/ai-virtual-phone";

// 与中转函数的白名单保持一致（netlify/functions/upload.mjs CONTRIB_PATH_RE）
export const CONTRIB_PATH_RE = /^(components|lib|styles|docs|hooks)\/[A-Za-z0-9_\-./一-鿿]+\.(ts|tsx|css|md|js|mjs)$/;

const FORK_STORE_KEY = "ai_phone_contrib_fork_v1";

export function loadContribFork(): string {
    try {
        return localStorage.getItem(FORK_STORE_KEY) || "";
    } catch {
        return "";
    }
}

export function saveContribFork(repo: string): void {
    try {
        localStorage.setItem(FORK_STORE_KEY, repo);
    } catch { /* 忽略 */ }
}

/** 把用户随手粘的 fork 地址清洗成 owner/repo（支持完整 URL / owner/repo / 带 .git） */
export function normalizeForkRepo(input: string): string | null {
    const trimmed = String(input || "").trim()
        .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
    return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(trimmed) ? trimmed : null;
}

export type ContribChangedFile = {
    path: string;
    status: string;           // modified | added | removed …
    inAllowlist: boolean;
    additions: number;
    deletions: number;
    patch?: string;           // GitHub 给的 unified diff（大文件可能缺省）
};

export type ContribCompareResult = {
    forkRepo: string;
    forkBranch: string;
    aheadBy: number;
    behindBy: number;
    files: ContribChangedFile[];
};

async function ghPublic(path: string, token?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.github.com${path}`, {
        headers: {
            Accept: "application/vnd.github+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
    if (!res.ok) {
        if (res.status === 403) throw new Error("GitHub 接口触发临时频率限制，请一小时后再试");
        if (res.status === 404) throw new Error("仓库或分支不存在（fork 地址对吗？私有 fork 需先在工坊「连接仓库」里连接它）");
        throw new Error(`GitHub 接口错误 ${res.status}`);
    }
    return await res.json() as Record<string, unknown>;
}

/** fork 与官方 main 的差异（GitHub compare API，按合并基准算，天然处理 fork 落后的情况）。
 *  branch 缺省用 fork 的默认分支；私有 fork 传 token（能读该 fork 即可）。 */
export async function compareForkWithUpstream(forkRepo: string, branch?: string, token?: string): Promise<ContribCompareResult> {
    const forkInfo = await ghPublic(`/repos/${forkRepo}`, token);
    const forkBranch = String(branch || "").trim() || String(forkInfo.default_branch || "main");
    const forkOwner = forkRepo.split("/")[0];
    const compare = await ghPublic(
        `/repos/${UPSTREAM_REPO}/compare/main...${encodeURIComponent(forkOwner)}:${encodeURIComponent(forkBranch)}`,
        token,
    );
    const rawFiles = Array.isArray(compare.files) ? compare.files as Array<Record<string, unknown>> : [];
    return {
        forkRepo,
        forkBranch,
        aheadBy: Number(compare.ahead_by) || 0,
        behindBy: Number(compare.behind_by) || 0,
        files: rawFiles.map(file => {
            const path = String(file.filename || "");
            return {
                path,
                status: String(file.status || "modified"),
                inAllowlist: CONTRIB_PATH_RE.test(path),
                additions: Number(file.additions) || 0,
                deletions: Number(file.deletions) || 0,
                patch: typeof file.patch === "string" ? file.patch : undefined,
            };
        }),
    };
}

/** contents API 的 JSON 元数据信封：有些镜像/代理会无视 raw 媒体类型原样返回它。
 *  若命中就解出真正的文件内容——否则"信封"会被当成源码一路走到 PR（社区 #103 事故）。 */
export function unwrapContentsApiEnvelope(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"content"')) return text;
    try {
        const data = JSON.parse(trimmed) as { type?: string; encoding?: string; content?: string };
        if (data && data.type === "file" && data.encoding === "base64" && typeof data.content === "string") {
            const binary = atob(data.content.replace(/\n/g, ""));
            try {
                return new TextDecoder("utf-8").decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
            } catch {
                return binary;
            }
        }
    } catch { /* 不是 JSON 或不是信封 → 原样返回 */ }
    return text;
}

/** 读 fork 里某个文件的当前内容。公开 fork 走 raw 域名（带 CORS 可直连）；
 *  私有 fork 带 token 走 contents API 的 raw 媒体类型（api 域名对带鉴权的跨域请求友好）。 */
export async function fetchForkFileText(forkRepo: string, branch: string, path: string, token?: string): Promise<string> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const res = token
        ? await fetch(`https://api.github.com/repos/${forkRepo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, {
            headers: { Accept: "application/vnd.github.raw+json", Authorization: `Bearer ${token}` },
        })
        : await fetch(`https://raw.githubusercontent.com/${forkRepo}/${encodeURIComponent(branch)}/${encodedPath}`);
    if (!res.ok) throw new Error(`读取 fork 文件失败 ${res.status}（${path}）`);
    return unwrapContentsApiEnvelope(await res.text());
}

/** 读官方 main 某个文件的当前内容 */
export async function fetchUpstreamFileText(path: string): Promise<string> {
    const res = await fetch(`https://raw.githubusercontent.com/${UPSTREAM_REPO}/main/${path.split("/").map(encodeURIComponent).join("/")}`);
    if (!res.ok) throw new Error(`读取官方文件失败 ${res.status}（${path}）`);
    return await res.text();
}

function toBase64Utf8(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export type ContribSubmitInput = {
    endpoint: string;         // 集市上传服务地址（loadUploadConfig().endpoint）
    title: string;
    summary: string;
    contributor?: string;
    githubUser?: string;
    files: Array<{ path: string; content: string }>;
};

/** 提交贡献：中转函数在官方仓库开 community PR，返回 PR 链接 */
/** 内容像 contents API 信封 → 说明读取环节拿错了层，绝不能进 PR */
function looksLikeContentsEnvelope(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed.startsWith("{")) return false;
    try {
        const data = JSON.parse(trimmed) as Record<string, unknown>;
        return Boolean(data && data.type === "file" && typeof data.content === "string"
            && (data.encoding === "base64" || "_links" in data || "download_url" in data));
    } catch {
        return false;
    }
}

export async function submitContribution(input: ContribSubmitInput): Promise<{ prNumber: number; prUrl: string }> {
    for (const file of input.files) {
        if (looksLikeContentsEnvelope(file.content)) {
            throw new Error(`${file.path} 的内容是 GitHub API 元数据而不是源码——通常是读取文件时镜像源返回了 JSON 信封。请重新用「读取文件」获取该文件的真实内容后再提交。`);
        }
    }
    const res = await fetch(input.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            action: "contribute",
            title: input.title,
            summary: input.summary,
            contributor: input.contributor || "",
            githubUser: input.githubUser || "",
            files: input.files.map(file => ({ path: file.path, contentBase64: toBase64Utf8(file.content) })),
        }),
    });
    const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; prNumber?: number; prUrl?: string };
    if (!res.ok || !data.ok) throw new Error(data.error || `提交失败（${res.status}）`);
    return { prNumber: data.prNumber || 0, prUrl: data.prUrl || "" };
}

// ── 贡献墙：官方仓库已合并的 community PR ──

export type MergedContribution = {
    number: number;
    title: string;
    contributor: string;
    mergedAt: string;
    url: string;
};

/** 贡献墙静态快照在 share 仓库里的路径（GitHub Action 定时生成，见 share 仓
 *  .github/workflows/contrib-wall.yml）。客户端优先经集市三镜像读它——国内可达、
 *  免限流、零函数额度；读不到或格式不对再退回下方的直连 search 兜底。 */
export const CONTRIB_WALL_PATH = "_wall.json";

/** 解析 _wall.json 快照；形状不对返回 null（调用方退回直连兜底） */
export function parseContribWallJson(text: string): MergedContribution[] | null {
    try {
        const data = JSON.parse(text) as { items?: unknown };
        if (!data || !Array.isArray(data.items)) return null;
        return data.items
            .map((raw) => {
                const item = raw as Record<string, unknown>;
                const number = Number(item.number) || 0;
                const title = typeof item.title === "string" ? item.title.trim() : "";
                if (!number || !title) return null;
                return {
                    number,
                    title,
                    contributor: (typeof item.contributor === "string" && item.contributor.trim()) || "匿名",
                    mergedAt: typeof item.mergedAt === "string" ? item.mergedAt : "",
                    url: typeof item.url === "string" ? item.url : "",
                };
            })
            .filter((entry): entry is MergedContribution => Boolean(entry))
            .sort((a, b) => (b.mergedAt || "").localeCompare(a.mergedAt || ""));
    } catch {
        return null;
    }
}

/** 已采纳的社区贡献（只取已合并；审核中/未采纳一律不展示） */
export async function fetchMergedContributions(): Promise<MergedContribution[]> {
    // 上墙的两类：① 已合并的社区 PR；② 「设计被采纳、代码由维护侧移植」的 PR——
    // 这类因分支基座过期没法直接合并，维护者按其设计在 main 重新实现后关闭原 PR
    // 并打上「已采纳」标签。功劳同样算贡献者的，日期用关闭时间兜底（下方已有该回退）。
    const searches = [
        `repo:${UPSTREAM_REPO} is:pr is:merged label:community`,
        `repo:${UPSTREAM_REPO} is:pr is:closed is:unmerged label:已采纳`,
    ];
    const results = await Promise.all(searches.map(q =>
        ghPublic(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=50`),
    ));
    const seen = new Set<number>();
    const items: Array<Record<string, unknown>> = [];
    for (const data of results) {
        for (const item of (Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [])) {
            const number = Number(item.number) || 0;
            if (seen.has(number)) continue;
            seen.add(number);
            items.push(item);
        }
    }
    return items.map(item => {
        const body = String(item.body || "");
        const match = body.match(/^贡献者[:：]\s*([^\n（(]+)/m);
        const user = item.user as Record<string, unknown> | undefined;
        return {
            number: Number(item.number) || 0,
            title: String(item.title || ""),
            contributor: (match ? match[1].trim() : String(user?.login || "匿名")) || "匿名",
            mergedAt: String((item.pull_request as Record<string, unknown> | undefined)?.merged_at || item.closed_at || ""),
            url: String(item.html_url || ""),
        };
    }).sort((a, b) => (b.mergedAt || "").localeCompare(a.mergedAt || ""));
}
