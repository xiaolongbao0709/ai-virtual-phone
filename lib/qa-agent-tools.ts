import { buildProviderRequest, parseProviderResponse } from "./llm-provider-adapter";
import { loadApiConfigs } from "./settings-storage";
import type { ApiConfig } from "./settings-types";
import type { ToolCall } from "./tool-executor";
import { getQaErrorEntries } from "./qa-error-log";
import { getDebugPromptSnapshot } from "./debug-store";
import {
    loadQaGithubConfig,
    getQaGithubTree,
    readQaGithubFile,
    searchQaGithubCode,
    listQaGithubCommits,
    getQaGithubCommit,
    listQaGithubBranches,
    listQaGithubPulls,
    getQaGithubPull,
    listQaGithubIssues,
    getQaGithubIssue,
} from "./qa-github";
import {
    createQaBranch,
    createQaIssue,
    createQaPullRequest,
    deleteQaBranch,
    mergeQaPullRequest,
    updateQaIssue,
    type QaCommitFile,
} from "./qa-github-write";
import {
    saveQaFeedbackTicket,
    updateQaFeedbackTicket,
    captureQaEnvironment,
    formatQaFeedbackMarkdown,
    type QaFeedbackTicket,
} from "./qa-feedback";
import { QA_CONTENT_TOOLS, type QaCreatedContent } from "./qa-content-tools";
import { searchQaFaq, readQaFaqPage } from "./qa-faq";
import { getQaPageChars } from "./qa-prefs";

export type { QaCreatedContent } from "./qa-content-tools";

// ── 工坊诊断工具集（P1）──────────────────────────────
// 文本协议与全项目一致：[执行动作:工具名({"参数":"值"})]，解析复用 tool-executor.parseToolCalls。

export type QaProposedCommit = {
    message: string;
    branch?: string;
    files: QaCommitFile[];
    /** 本次提交要删除的文件路径 */
    deletes?: string[];
};

export type QaToolContext = {
    signal?: AbortSignal;
    /** 确认模式下，写工具通过它把提案交给 UI，返回 true 表示已暂存等待确认。 */
    onStageCommit?: (proposal: QaProposedCommit) => void;
    /** true=全自动模式，写工具直接提交。 */
    autoCommit?: boolean;
    /**
     * 全自动模式下立即提交并返回结果。必须在工具内同步完成，
     * 否则同一轮里后续工具（如「创建PR」）会跑在提交之前。
     */
    commitNow?: (proposal: QaProposedCommit) => Promise<{ ok: boolean; htmlUrl?: string; error?: string }>;
    /** 内容工具安装/更新本机内容后回调（store 记到会话上，供工坊内预览）。 */
    onContentCreated?: (item: QaCreatedContent) => void;
};

export type QaToolRunResult = {
    name: string;
    success: boolean;
    resultForModel: string;
};

type QaTool = {
    name: string;
    /** 原生工具协议的稳定英文名（function 名仅允许 ASCII） */
    nativeName: string;
    description: string;
    schemaLines: string[];
    /** 原生工具协议的 JSON Schema 参数定义 */
    parameters: Record<string, unknown>;
    run: (args: Record<string, unknown>, context?: QaToolContext) => Promise<string>;
};

/** 空参数工具的兜底 schema：带一个无意义可选字段，避免部分 provider（如 Gemini）拒绝空 properties */
const NOOP_PARAMS: Record<string, unknown> = {
    type: "object",
    properties: { noop: { type: "string", description: "无需参数，忽略" } },
};

const RESULT_CHAR_LIMIT = 2000;

function clip(text: string): string {
    return text.length > RESULT_CHAR_LIMIT ? `${text.slice(0, RESULT_CHAR_LIMIT)}\n…（已截断）` : text;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

// ── 工具 1：检测 API 连通性 ──

async function pingApiConfig(config: ApiConfig, signal?: AbortSignal): Promise<string> {
    const started = Date.now();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20_000);
    const onOuterAbort = () => abort.abort();
    signal?.addEventListener("abort", onOuterAbort);
    try {
        const request = buildProviderRequest(config, null, [{ role: "user", content: "连通性测试，只回复：ok" }]);
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: abort.signal,
        });
        const ms = Date.now() - started;
        if (!response.ok) {
            const bodyText = (await response.text()).slice(0, 300);
            return `✗ 「${config.name || config.provider}」HTTP ${response.status}（${ms}ms）：${bodyText}`;
        }
        const parsed = parseProviderResponse(request.providerKind, await response.json());
        if (!parsed.content) return `⚠ 「${config.name || config.provider}」请求成功但返回空内容（${ms}ms），检查模型名 ${config.defaultModel} 是否正确`;
        return `✓ 「${config.name || config.provider}」正常，模型 ${config.defaultModel}，耗时 ${ms}ms`;
    } catch (error) {
        const ms = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        if (abort.signal.aborted && !signal?.aborted) return `✗ 「${config.name || config.provider}」超时（>${ms}ms）`;
        return `✗ 「${config.name || config.provider}」连接失败（${ms}ms）：${message.slice(0, 200)}（常见原因：Base URL 写错、网络不通、CORS 被服务商拦截）`;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onOuterAbort);
    }
}

const apiCheckTool: QaTool = {
    name: "检测API",
    nativeName: "check_api",
    parameters: {
        type: "object",
        properties: { name: { type: "string", description: "只测指定名称的 API 配置；不填测全部" } },
    },
    description: "逐个测试用户已配置的 LLM API 是否可用（真实发送一条极短请求），返回连通状态、耗时与错误详情。",
    schemaLines: [
        "  参数：",
        "    · name (可选) — 只测指定名称的 API 配置；不填测全部",
        '  调用：[执行动作:检测API({})] 或 [执行动作:检测API({"name":"DeepSeek"})]',
    ],
    async run(args, options) {
        const all = loadApiConfigs();
        if (all.length === 0) return "用户还没有配置任何 API。请引导用户到「设置 → API 设置」添加。";
        const filter = typeof args.name === "string" ? args.name.trim() : "";
        const targets = filter ? all.filter((c) => (c.name || "").includes(filter)) : all;
        if (targets.length === 0) return `找不到名称包含「${filter}」的 API 配置。现有配置：${all.map((c) => c.name || c.provider).join("、")}`;
        const results: string[] = [];
        for (const config of targets) {
            results.push(await pingApiConfig(config, options?.signal));
        }
        return clip(results.join("\n"));
    },
};

// ── 工具 2：存储体检 ──

const storageReportTool: QaTool = {
    name: "存储体检",
    nativeName: "storage_report",
    parameters: NOOP_PARAMS,
    description: "查看浏览器存储占用（配额、已用空间、各数据库清单），用于排查存储不足或数据异常。",
    schemaLines: ["  参数：无", "  调用：[执行动作:存储体检({})]"],
    async run() {
        const lines: string[] = [];
        try {
            const estimate = await navigator.storage?.estimate?.();
            if (estimate) {
                const usage = estimate.usage ?? 0;
                const quota = estimate.quota ?? 0;
                lines.push(`存储占用：${formatBytes(usage)} / 配额 ${formatBytes(quota)}（${quota ? ((usage / quota) * 100).toFixed(1) : "?"}%）`);
            }
            const persisted = await navigator.storage?.persisted?.();
            lines.push(`持久化存储：${persisted ? "已开启（浏览器不会自动清理）" : "未开启（存储紧张时浏览器可能清数据，建议提醒用户定期备份）"}`);
        } catch {
            lines.push("无法读取存储估算（浏览器不支持）。");
        }
        try {
            const dbs = await indexedDB.databases?.();
            if (dbs?.length) lines.push(`IndexedDB 数据库（${dbs.length} 个）：${dbs.map((d) => d.name).filter(Boolean).join("、")}`);
        } catch {
            // Safari 不支持 databases()
        }
        try {
            lines.push(`localStorage 键数量：${localStorage.length}`);
        } catch {
            // ignore
        }
        return clip(lines.join("\n"));
    },
};

// ── 工具 3：最近报错 ──

const errorLogTool: QaTool = {
    name: "最近报错",
    nativeName: "recent_errors",
    parameters: NOOP_PARAMS,
    description: "读取本次会话内页面捕获到的 JS 报错和未处理异常（最多 50 条），以及最近一次 LLM 请求的调试快照信息。",
    schemaLines: ["  参数：无", "  调用：[执行动作:最近报错({})]"],
    async run() {
        const lines: string[] = [];
        const errors = getQaErrorEntries();
        if (errors.length === 0) {
            lines.push("本次会话没有捕获到页面报错。");
        } else {
            lines.push(`捕获到 ${errors.length} 条报错（最近 10 条）：`);
            for (const entry of errors.slice(-10)) {
                const time = new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false });
                lines.push(`[${time}] ${entry.kind === "error" ? "JS错误" : "未处理异常"} ${entry.source ? `(${entry.source}) ` : ""}${entry.message}`);
            }
        }
        const snapshot = getDebugPromptSnapshot();
        if (snapshot) {
            lines.push("", "最近一次 LLM 请求快照存在（用户可在调试面板查看完整提示词）。");
        }
        return clip(lines.join("\n"));
    },
};

// ── 工具 4：设备环境 ──

const deviceInfoTool: QaTool = {
    name: "设备环境",
    nativeName: "device_info",
    parameters: NOOP_PARAMS,
    description: "读取设备与运行环境信息（浏览器、视口、PWA 状态、网络状态、通知权限），用于排查显示异常和兼容问题。",
    schemaLines: ["  参数：无", "  调用：[执行动作:设备环境({})]"],
    async run() {
        const lines: string[] = [];
        lines.push(`UA：${navigator.userAgent.slice(0, 160)}`);
        lines.push(`视口：${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`);
        lines.push(`语言：${navigator.language}；在线：${navigator.onLine ? "是" : "否"}`);
        try {
            const standalone = window.matchMedia("(display-mode: standalone)").matches;
            lines.push(`PWA 独立窗口：${standalone ? "是（已安装到桌面）" : "否（浏览器内打开）"}`);
        } catch {
            // ignore
        }
        try {
            lines.push(`Service Worker：${navigator.serviceWorker?.controller ? "已激活" : "未激活"}`);
        } catch {
            // ignore
        }
        try {
            lines.push(`通知权限：${typeof Notification !== "undefined" ? Notification.permission : "不支持"}`);
        } catch {
            // ignore
        }
        return clip(lines.join("\n"));
    },
};

// ── 答疑文档（可检索、可翻页的持续补充 FAQ）──────────

const faqTool: QaTool = {
    name: "答疑文档",
    nativeName: "read_faq_doc",
    parameters: {
        type: "object",
        properties: {
            find: { type: "string", description: "关键词（可空格分隔多个，任一命中即返回该问答条目）" },
            page: { type: "number", description: "不带 find 时按页顺序阅读全文，默认第 1 页" },
        },
    },
    description:
        "检索产品答疑文档（持续补充的 FAQ）：传 find 按关键词查相关问答，不传则分页通读。回答没把握的产品问题前先查这里；查不到再用 GitHub 工具读源码求证。",
    schemaLines: [
        "  参数：",
        "    · find (可选) — 关键词，任一命中即返回对应问答条目",
        "    · page (可选) — 不带 find 时分页通读，默认第 1 页",
        '  调用：[执行动作:答疑文档({"find":"备份 迁移"})]',
    ],
    async run(args) {
        const find = typeof args.find === "string" ? args.find.trim() : "";
        if (find) {
            const hits = searchQaFaq(find);
            if (hits.length === 0) {
                return `答疑文档里没有找到与「${find}」相关的条目。可换关键词再查，或（已连接仓库时）用「搜索仓库代码」「读取仓库文件」从源码求证；仍无结论就如实告诉用户并用「记录反馈」登记。`;
            }
            return `【答疑文档命中 ${hits.length} 条】\n\n${hits.join("\n\n")}`;
        }
        return readQaFaqPage(args.page);
    },
};

// ── GitHub 只读工具（仅在配置了仓库时启用）──────────

const githubTreeTool: QaTool = {
    name: "仓库文件树",
    nativeName: "repo_file_tree",
    parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "只返回路径包含该关键词的文件" } },
    },
    description: "列出已连接 GitHub 仓库的文件路径（可按关键词过滤），用于了解代码结构、定位文件。",
    schemaLines: [
        "  参数：",
        "    · filter (可选) — 只返回路径包含该关键词的文件/目录",
        '  调用：[执行动作:仓库文件树({})] 或 [执行动作:仓库文件树({"filter":"chat"})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。请引导用户在工坊右上角「仓库」里配置。";
        const { entries, truncated } = await getQaGithubTree(config, options?.signal);
        const filter = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
        let files = entries.filter((e) => e.type === "blob");
        if (filter) files = files.filter((e) => e.path.toLowerCase().includes(filter));
        const shown = files.slice(0, 200);
        const head = `仓库 ${config.owner}/${config.repo}${config.branch ? `@${config.branch}` : ""} 共 ${entries.filter((e) => e.type === "blob").length} 个文件${filter ? `，匹配「${filter}」${files.length} 个` : ""}${truncated ? "（文件树被 GitHub 截断，仅部分）" : ""}：`;
        return clip(`${head}\n${shown.map((e) => e.path).join("\n")}${files.length > shown.length ? `\n…还有 ${files.length - shown.length} 个` : ""}`);
    },
};

const githubReadTool: QaTool = {
    name: "读取仓库文件",
    nativeName: "read_repo_file",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "文件路径，如 lib/chat-engine.ts" },
            start: { type: "number", description: "起始行" },
            end: { type: "number", description: "结束行" },
        },
        required: ["path"],
    },
    description: "读取已连接 GitHub 仓库中某个文件的内容，可指定行范围。用于查看具体实现回答代码问题。",
    schemaLines: [
        "  参数：",
        "    · path (必填) — 文件路径，如 lib/chat-engine.ts",
        "    · start (可选) / end (可选) — 只看第 start 到 end 行",
        '  调用：[执行动作:读取仓库文件({"path":"package.json"})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) return "缺少 path 参数。";
        const file = await readQaGithubFile(config, path, options?.signal);
        const lines = file.text.split("\n");
        const start = typeof args.start === "number" ? Math.max(1, args.start) : 1;
        const end = typeof args.end === "number" ? Math.min(lines.length, args.end) : lines.length;
        const slice = lines.slice(start - 1, end);
        const numbered = slice.map((line, i) => `${start + i}\t${line}`).join("\n");
        const body = `${file.path}（${lines.length} 行，显示 ${start}-${Math.min(end, lines.length)}）：\n${numbered}`;
        // 读源码按「单页读取字符数」截断（工坊配置可调），截断时提示用行号范围续读
        const limit = getQaPageChars();
        return body.length > limit
            ? `${body.slice(0, limit)}\n…（已截断，用 start/end 行号范围继续读）`
            : body;
    },
};

const githubSearchTool: QaTool = {
    name: "搜索仓库代码",
    nativeName: "search_repo_code",
    parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词" } },
        required: ["query"],
    },
    description: "在已连接 GitHub 仓库里搜索代码或文件。有 PAT 时用 GitHub 代码搜索（搜内容），否则按文件路径匹配。",
    schemaLines: [
        "  参数：",
        "    · query (必填) — 搜索关键词",
        '  调用：[执行动作:搜索仓库代码({"query":"sendLLMRequest"})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return "缺少 query 参数。";
        const { hits, mode } = await searchQaGithubCode(config, query, options?.signal);
        if (hits.length === 0) return `没搜到「${query}」（${mode === "path-fallback" ? "按路径匹配，未配 PAT 无法搜文件内容" : "代码搜索"}）。`;
        const modeNote = mode === "path-fallback" ? "（按文件路径匹配，如需搜文件内容请配置 PAT）" : "（GitHub 代码搜索）";
        return clip(`搜到 ${hits.length} 个结果${modeNote}：\n${hits.map((h) => h.path).join("\n")}`);
    },
};

const githubHistoryTool: QaTool = {
    name: "提交历史",
    nativeName: "commit_history",
    parameters: {
        type: "object",
        properties: {
            sha: { type: "string", description: "看这个提交改了什么（含 diff）" },
            branch: { type: "string" },
            path: { type: "string", description: "只看该文件的历史" },
            limit: { type: "number", description: "默认 10" },
        },
    },
    description:
        "查看仓库提交历史；给 sha 时显示该次提交的改动详情（每个文件的 diff）。排查「什么时候改坏的」时先列历史再看具体提交。",
    schemaLines: [
        "  参数：",
        "    · sha (可选) — 看这个提交改了什么（含 diff）",
        "    · branch (可选) / path (可选) / limit (可选，默认 10) — 列历史时过滤",
        '  调用：[执行动作:提交历史({})] 或 [执行动作:提交历史({"sha":"abc123"})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const sha = typeof args.sha === "string" ? args.sha.trim() : "";
        if (sha) {
            const detail = await getQaGithubCommit(config, sha, options?.signal);
            const lines = [`提交 ${detail.sha.slice(0, 10)}：${detail.message.split("\n")[0]}`, `改动 ${detail.files.length} 个文件：`];
            for (const f of detail.files.slice(0, 10)) {
                lines.push(`--- ${f.filename}（${f.status}，+${f.additions}/-${f.deletions}）`);
                if (f.patch) lines.push(f.patch.slice(0, 600));
            }
            if (detail.files.length > 10) lines.push(`…还有 ${detail.files.length - 10} 个文件`);
            return clip(lines.join("\n"));
        }
        const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined;
        const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 10;
        const commits = await listQaGithubCommits(config, { branch, path, limit }, options?.signal);
        if (commits.length === 0) return "没有提交记录。";
        return clip(
            `最近 ${commits.length} 次提交${branch ? `（${branch}）` : ""}${path ? `（${path}）` : ""}：\n` +
            commits.map((c) => `${c.sha.slice(0, 10)}  ${c.date.slice(0, 10)}  ${c.author}  ${c.message}`).join("\n") +
            "\n\n想看某次改了什么，用 sha 参数再调一次。",
        );
    },
};

const githubBranchListTool: QaTool = {
    name: "分支列表",
    nativeName: "list_branches",
    parameters: NOOP_PARAMS,
    description: "列出仓库所有分支（标注默认分支与工坊当前工作分支）。",
    schemaLines: ["  参数：无", "  调用：[执行动作:分支列表({})]"],
    async run(_args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const { branches, defaultBranch } = await listQaGithubBranches(config, options?.signal);
        return clip(
            `共 ${branches.length} 个分支：\n` +
            branches
                .map((b) => {
                    const marks = [b.name === defaultBranch ? "默认" : "", b.name === config.branch ? "工坊工作分支" : ""].filter(Boolean);
                    return `${b.name}${marks.length ? `（${marks.join("、")}）` : ""}  ${b.sha.slice(0, 10)}`;
                })
                .join("\n"),
        );
    },
};

const githubPullReadTool: QaTool = {
    name: "查看PR",
    nativeName: "view_pull_request",
    parameters: {
        type: "object",
        properties: {
            number: { type: "number", description: "PR 编号；不填列出 PR 列表" },
            state: { type: "string", enum: ["open", "closed", "all"], description: "列表时的状态过滤，默认 open" },
        },
    },
    description: "不带 number 时列出 PR（默认 open）；带 number 时看该 PR 的详情与改动文件。",
    schemaLines: [
        "  参数：",
        "    · number (可选) — PR 编号",
        "    · state (可选) — open（默认）/ closed / all，仅列表时有效",
        '  调用：[执行动作:查看PR({})] 或 [执行动作:查看PR({"number":12})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const number = typeof args.number === "number" ? args.number : 0;
        if (number > 0) {
            const p = await getQaGithubPull(config, number, options?.signal);
            const lines = [
                `PR #${p.number}「${p.title}」（${p.merged ? "已合并" : p.state}）`,
                `${p.head} → ${p.base}${p.mergeable === false ? "（有冲突，不可自动合并）" : ""}`,
                p.body ? `说明：${p.body.slice(0, 300)}` : "",
                `改动 ${p.files.length} 个文件：`,
                ...p.files.slice(0, 20).map((f) => `  ${f.filename}（${f.status}，+${f.additions}/-${f.deletions}）`),
                p.htmlUrl,
            ].filter(Boolean);
            return clip(lines.join("\n"));
        }
        const state = args.state === "closed" || args.state === "all" ? args.state : "open";
        const pulls = await listQaGithubPulls(config, state, options?.signal);
        if (pulls.length === 0) return `没有 ${state} 状态的 PR。`;
        return clip(
            `${state} PR 共 ${pulls.length} 个：\n` +
            pulls.map((p) => `#${p.number}  ${p.title}（${p.head} → ${p.base}）`).join("\n"),
        );
    },
};

const githubIssueReadTool: QaTool = {
    name: "查看Issue",
    nativeName: "view_issue",
    parameters: {
        type: "object",
        properties: {
            number: { type: "number", description: "issue 编号；不填列出 issue 列表" },
            state: { type: "string", enum: ["open", "closed", "all"], description: "列表时的状态过滤，默认 open" },
        },
    },
    description: "不带 number 时列出 issue（默认 open，不含 PR）；带 number 时看详情与评论。",
    schemaLines: [
        "  参数：",
        "    · number (可选) — issue 编号",
        "    · state (可选) — open（默认）/ closed / all，仅列表时有效",
        '  调用：[执行动作:查看Issue({})] 或 [执行动作:查看Issue({"number":41})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const number = typeof args.number === "number" ? args.number : 0;
        if (number > 0) {
            const issue = await getQaGithubIssue(config, number, options?.signal);
            const lines = [
                `Issue #${issue.number}「${issue.title}」（${issue.state}）`,
                issue.body ? `正文：${issue.body.slice(0, 400)}` : "（无正文）",
                issue.comments.length ? `评论 ${issue.comments.length} 条：` : "（无评论）",
                ...issue.comments.slice(-5).map((c) => `  @${c.author}：${c.body.slice(0, 150)}`),
                issue.htmlUrl,
            ].filter(Boolean);
            return clip(lines.join("\n"));
        }
        const state = args.state === "closed" || args.state === "all" ? args.state : "open";
        const issues = await listQaGithubIssues(config, state, options?.signal);
        if (issues.length === 0) return `没有 ${state} 状态的 issue。`;
        return clip(`${state} issue 共 ${issues.length} 个：\n` + issues.map((i) => `#${i.number}  ${i.title}`).join("\n"));
    },
};

const githubBranchTool: QaTool = {
    name: "新建分支",
    nativeName: "create_branch",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "新分支名，如 feature/dark-mode" },
            from: { type: "string", description: "从哪个分支切出，默认仓库配置分支/默认分支" },
        },
        required: ["name"],
    },
    description:
        "在已连接仓库创建新分支（从指定分支或默认分支切出）。建完后可用「提交修改」的 branch 参数往新分支提交。分支已存在时不报错、直接可用。",
    schemaLines: [
        "  参数：",
        "    · name (必填) — 新分支名，如 feature/dark-mode",
        "    · from (可选) — 从哪个分支切出，默认仓库配置分支/默认分支",
        '  调用：[执行动作:新建分支({"name":"feature/dark-mode"})]',
    ],
    async run(args, context) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        if (!config.token) return "写操作需要 PAT。请引导用户在工坊「仓库」里填入有写权限的 fine-grained PAT。";
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) return "缺少 name（分支名）。";
        const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : undefined;
        const result = await createQaBranch(config, { name, from }, context?.signal);
        if (!result.created) return `分支「${name}」已存在，可直接往它提交。`;
        return `✓ 已从「${result.from}」创建分支「${name}」。之后用「提交修改」的 branch 参数即可提交到该分支。`;
    },
};

const githubCommitTool: QaTool = {
    name: "提交修改",
    nativeName: "commit_changes",
    parameters: {
        type: "object",
        properties: {
            message: { type: "string", description: "提交说明（一句话，中文）" },
            files: {
                type: "array",
                description: "要写入的文件，每项 {path, content}，content 是完整新内容",
                items: {
                    type: "object",
                    properties: { path: { type: "string" }, content: { type: "string" } },
                    required: ["path", "content"],
                },
            },
            deletes: { type: "array", items: { type: "string" }, description: "要删除的文件路径" },
            branch: { type: "string", description: "目标分支，默认仓库默认分支；不存在会自动创建" },
        },
        required: ["message"],
    },
    description:
        "把对仓库文件的修改（新增/覆盖/删除）提交上去。给出完整的新文件内容（不是 diff）。确认模式下会先展示给用户确认再提交；全自动模式下直接提交。修改前应先用「读取仓库文件」拿到原内容再改。",
    schemaLines: [
        "  参数：",
        "    · message (必填) — 提交说明（一句话，中文）",
        "    · files (可选) — 数组，每项 {path, content}，content 是该文件的完整新内容",
        "    · deletes (可选) — 要删除的文件路径数组；重命名 = 新路径写入 files + 旧路径放 deletes",
        "    · branch (可选) — 目标分支，默认仓库默认分支；分支不存在会自动从默认分支创建",
        "    · files 与 deletes 至少给一个",
        '  调用：[执行动作:提交修改({"message":"更新标题","files":[{"path":"README.md","content":"# 新标题\\n"}],"deletes":["old.md"]})]',
    ],
    async run(args, context) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        if (!config.token) return "写操作需要 PAT。请引导用户在工坊「仓库」里填入有写权限的 fine-grained PAT。";
        const message = typeof args.message === "string" ? args.message.trim() : "";
        const rawFiles = Array.isArray(args.files) ? args.files : [];
        const files: QaCommitFile[] = rawFiles
            .filter((f): f is { path: string; content: string } => !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string" && typeof (f as { content?: unknown }).content === "string")
            .map((f) => ({ path: f.path.trim(), content: f.content }));
        const deletes = (Array.isArray(args.deletes) ? args.deletes : [])
            .map((p) => (typeof p === "string" ? p.trim() : ""))
            .filter(Boolean);
        if (!message) return "缺少 message（提交说明）。";
        if (files.length === 0 && deletes.length === 0) return "files 与 deletes 至少给一个（要提交的文件或要删除的路径）。";
        const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined;
        const proposal: QaProposedCommit = { message, branch, files, deletes: deletes.length ? deletes : undefined };
        context?.onStageCommit?.(proposal);
        const summary = [
            files.length ? `改 ${files.length} 个：${files.map((f) => f.path).join("、")}` : "",
            deletes.length ? `删 ${deletes.length} 个：${deletes.join("、")}` : "",
        ].filter(Boolean).join("；");
        if (context?.autoCommit) {
            // 立即提交：后续工具（创建PR 等）依赖提交已经落到分支上
            if (context.commitNow) {
                const result = await context.commitNow(proposal);
                if (!result.ok) return `提交失败：${result.error ?? "未知错误"}。请把失败原因告诉用户，不要假装已提交。`;
                return `✓ 已提交（${summary}）到 ${branch || "默认分支"}：${result.htmlUrl ?? ""}。请向用户简述你做的修改和影响。`;
            }
            return `修改提案已生成（${summary}），当前是全自动模式，系统会直接提交。请向用户简述你做的修改和影响。`;
        }
        return `已生成修改提案（${summary}），已在界面展示给用户，等待用户点「应用」确认。请告诉用户你准备做的修改和影响，让他确认。不要假装已经提交成功。`;
    },
};

function requireWritableConfig(): { config: NonNullable<ReturnType<typeof loadQaGithubConfig>> } | { error: string } {
    const config = loadQaGithubConfig();
    if (!config) return { error: "尚未连接 GitHub 仓库。" };
    if (!config.token) return { error: "写操作需要 PAT。请引导用户在工坊「仓库」里填入有写权限的 fine-grained PAT。" };
    return { config };
}

const githubBranchDeleteTool: QaTool = {
    name: "删除分支",
    nativeName: "delete_branch",
    parameters: {
        type: "object",
        properties: { name: { type: "string", description: "要删除的分支名" } },
        required: ["name"],
    },
    description: "删除仓库分支。默认分支与工坊当前工作分支受保护，不能删。",
    schemaLines: [
        "  参数：",
        "    · name (必填) — 要删除的分支名",
        '  调用：[执行动作:删除分支({"name":"feature/old"})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) return "缺少 name（分支名）。";
        await deleteQaBranch(gate.config, name, context?.signal);
        return `✓ 已删除分支「${name}」。`;
    },
};

const githubPullCreateTool: QaTool = {
    name: "创建PR",
    nativeName: "create_pull_request",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "PR 标题" },
            head: { type: "string", description: "源分支（改动所在分支）" },
            base: { type: "string", description: "目标分支，默认仓库默认分支" },
            body: { type: "string", description: "PR 描述" },
        },
        required: ["title", "head"],
    },
    description:
        "从某个分支向目标分支发起 Pull Request。典型流程：新建分支 → 提交修改到该分支 → 创建PR → 用户审阅或让你合并。",
    schemaLines: [
        "  参数：",
        "    · title (必填) — PR 标题",
        "    · head (必填) — 源分支（改动所在分支）",
        "    · base (可选) — 目标分支，默认仓库默认分支",
        "    · body (可选) — PR 描述",
        '  调用：[执行动作:创建PR({"title":"深色模式","head":"feature/dark-mode"})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const head = typeof args.head === "string" ? args.head.trim() : "";
        if (!title || !head) return "缺少 title 或 head（源分支）。";
        const base = typeof args.base === "string" && args.base.trim() ? args.base.trim() : undefined;
        const body = typeof args.body === "string" ? args.body : undefined;
        const result = await createQaPullRequest(gate.config, { title, head, base, body }, context?.signal);
        return `✓ 已创建 PR #${result.number}：${result.htmlUrl}。请把链接给用户。`;
    },
};

const githubPullMergeTool: QaTool = {
    name: "合并PR",
    nativeName: "merge_pull_request",
    parameters: {
        type: "object",
        properties: {
            number: { type: "number", description: "PR 编号" },
            method: { type: "string", enum: ["merge", "squash", "rebase"], description: "合并方式，默认 merge" },
        },
        required: ["number"],
    },
    description: "合并一个 Pull Request。合并前建议先用「查看PR」确认无冲突；用户没明确要求时先询问再合并。",
    schemaLines: [
        "  参数：",
        "    · number (必填) — PR 编号",
        "    · method (可选) — merge（默认）/ squash / rebase",
        '  调用：[执行动作:合并PR({"number":12})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const number = typeof args.number === "number" ? args.number : 0;
        if (number <= 0) return "缺少 number（PR 编号）。";
        const method = args.method === "squash" || args.method === "rebase" ? args.method : "merge";
        const result = await mergeQaPullRequest(gate.config, { number, method }, context?.signal);
        if (!result.merged) return `合并失败：${result.message || "PR 可能有冲突或已关闭"}。可用「查看PR」检查状态。`;
        return `✓ PR #${number} 已合并（${method}），合并提交 ${result.sha?.slice(0, 10) ?? ""}。`;
    },
};

const githubIssueUpdateTool: QaTool = {
    name: "更新Issue",
    nativeName: "update_issue",
    parameters: {
        type: "object",
        properties: {
            number: { type: "number", description: "issue 编号" },
            comment: { type: "string", description: "追加的评论内容" },
            state: { type: "string", enum: ["closed", "open"], description: "closed=关闭，open=重开" },
        },
        required: ["number"],
    },
    description: "给 issue 追加评论、关闭或重新打开。comment / state 至少给一个。",
    schemaLines: [
        "  参数：",
        "    · number (必填) — issue 编号",
        "    · comment (可选) — 追加的评论内容",
        "    · state (可选) — closed（关闭）/ open（重开）",
        '  调用：[执行动作:更新Issue({"number":41,"comment":"已在 v2 修复","state":"closed"})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const number = typeof args.number === "number" ? args.number : 0;
        if (number <= 0) return "缺少 number（issue 编号）。";
        const comment = typeof args.comment === "string" && args.comment.trim() ? args.comment.trim() : undefined;
        const state = args.state === "closed" || args.state === "open" ? args.state : undefined;
        if (!comment && !state) return "comment 与 state 至少给一个。";
        await updateQaIssue(gate.config, { number, comment, state }, context?.signal);
        const did = [comment ? "已评论" : "", state === "closed" ? "已关闭" : state === "open" ? "已重开" : ""].filter(Boolean).join("、");
        return `✓ Issue #${number} ${did}。`;
    },
};

const GITHUB_TOOLS: QaTool[] = [
    githubTreeTool,
    githubReadTool,
    githubSearchTool,
    githubHistoryTool,
    githubBranchListTool,
    githubPullReadTool,
    githubIssueReadTool,
];
const GITHUB_WRITE_TOOLS: QaTool[] = [
    githubBranchTool,
    githubBranchDeleteTool,
    githubCommitTool,
    githubPullCreateTool,
    githubPullMergeTool,
    githubIssueUpdateTool,
];

// ── 注册表与执行入口 ──────────────────────────────────

// ── 反馈闭环工具 ──

let feedbackSeq = 0;

const feedbackTool: QaTool = {
    name: "记录反馈",
    nativeName: "record_feedback",
    parameters: {
        type: "object",
        properties: {
            kind: { type: "string", enum: ["feature", "bug", "other"], description: "反馈类型" },
            title: { type: "string", description: "一句话标题" },
            detail: { type: "string", description: "详细描述；bug 请含复现步骤与期望行为" },
        },
        required: ["kind", "title", "detail"],
    },
    description:
        "当用户提出你无法直接处理的核心功能需求或产品级 bug（需要改动应用本体代码、而非用户自己的仓库或本地设置）时，把它整理成结构化反馈单留存；若已连接 GitHub 仓库并有写权限，会同时创建一个 issue。",
    schemaLines: [
        "  参数：",
        "    · kind (必填) — feature（功能建议）/ bug（问题反馈）/ other",
        "    · title (必填) — 一句话标题",
        "    · detail (必填) — 详细描述；bug 请含复现步骤与期望行为",
        '  调用：[执行动作:记录反馈({"kind":"feature","title":"希望群聊支持消息撤回","detail":"…"})]',
    ],
    async run(args, context) {
        const kind = args.kind === "bug" || args.kind === "other" ? args.kind : "feature";
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const detail = typeof args.detail === "string" ? args.detail.trim() : "";
        if (!title || !detail) return "缺少 title 或 detail。";
        feedbackSeq += 1;
        const ticket: QaFeedbackTicket = {
            id: `fb-${Date.now().toString(36)}-${feedbackSeq}`,
            ts: Date.now(),
            kind: kind as QaFeedbackTicket["kind"],
            title,
            detail,
            environment: captureQaEnvironment(),
        };
        saveQaFeedbackTicket(ticket);

        // 优雅降级：连了 GitHub 且有写权限就开 issue；否则仅本地留存
        const config = loadQaGithubConfig();
        if (config?.token) {
            try {
                const issue = await createQaIssue(
                    config,
                    { title: `[${ticket.kind}] ${title}`, body: formatQaFeedbackMarkdown(ticket), labels: ["工坊反馈"] },
                    context?.signal,
                );
                updateQaFeedbackTicket(ticket.id, { issueUrl: issue.htmlUrl });
                return `✓ 已记录反馈并创建 issue #${issue.number}：${issue.htmlUrl}。请告诉用户已提交，附上 issue 链接。`;
            } catch (error) {
                return `已在本地记录反馈「${title}」。尝试创建 GitHub issue 失败：${error instanceof Error ? error.message : String(error)}。可让用户稍后在「仓库」检查 PAT 的 Issues 写权限。`;
            }
        }
        return `✓ 已在本地记录反馈「${title}」。当前未连接可写的 GitHub 仓库，反馈暂存在本机（用户可在需要时复制反馈内容发给开发者）。请告知用户已记录。`;
    },
};

const BASE_TOOLS: QaTool[] = [apiCheckTool, storageReportTool, errorLogTool, deviceInfoTool, feedbackTool, faqTool, ...QA_CONTENT_TOOLS];

/** 当前可用工具集：基础诊断 + 内容开发工场 + （已连接仓库时）GitHub 只读 + （有 PAT 时）写入工具。 */
export function getQaTools(): QaTool[] {
    const config = loadQaGithubConfig();
    if (!config) return BASE_TOOLS;
    const tools = [...BASE_TOOLS, ...GITHUB_TOOLS];
    if (config.token) tools.push(...GITHUB_WRITE_TOOLS);
    return tools;
}

// 全量工具（store 里用于工具名映射与执行查找）
export const QA_TOOLS: QaTool[] = [...BASE_TOOLS, ...GITHUB_TOOLS, ...GITHUB_WRITE_TOOLS];

// ── 原生工具协议（function calling）────────────────────

export type QaNativeToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };

/** 当前可用工具的原生定义（供请求体 tools 字段用）。 */
export function getQaNativeToolDefinitions(): QaNativeToolDefinition[] {
    return getQaTools().map((tool) => ({
        name: tool.nativeName,
        description: tool.description,
        parameters: tool.parameters,
    }));
}

/** 原生英文名 → 中文工具名（执行与 UI 展示都用中文名）。 */
export function buildQaNativeNameMap(): Map<string, string> {
    return new Map(QA_TOOLS.map((tool) => [tool.nativeName, tool.name]));
}

export function buildQaToolsPrompt(): string {
    const tools = getQaTools();
    const lines: string[] = [];
    lines.push("===== 你的工具 =====");
    lines.push("排查用户问题时优先实际检测，不要凭空猜测。可用工具：");
    lines.push("");
    for (const tool of tools) {
        lines.push(`【${tool.name}】${tool.description}`);
        lines.push(...tool.schemaLines);
        lines.push("");
    }
    lines.push("===== 调用规则 =====");
    lines.push('· 执行动作：使用 [执行动作:工具名({"参数":"值"})] 格式，无参数时用 [执行动作:工具名({})]');
    lines.push("· 一条回复里可以调用多个工具；调用后等待系统返回工具结果再继续分析");
    lines.push("· 产品问题没把握时先用「答疑文档」按关键词检索；文档查不到且已连接仓库时再查源码；仍无结论就如实说明");
    lines.push("· 回答代码问题时，先用「仓库文件树」或「搜索仓库代码」定位，再用「读取仓库文件」看具体实现，基于真实代码作答");
    lines.push("· 用户想要新 APP/小游戏/剧场时：先用「创作指南」读对应类型的制作说明（可分页），写好完整内容后用对应安装工具装进本机，最后告诉用户去哪里打开；同名会更新，改完可直接重装");
    lines.push("· 收到工具结果后，用人话向用户解释结论和建议，不要原样罗列");
    lines.push("· 不需要工具时直接回复文字");
    return lines.join("\n");
}

export async function runQaToolCall(call: ToolCall, context?: QaToolContext): Promise<QaToolRunResult> {
    const tool = QA_TOOLS.find((t) => t.name === call.name);
    if (!tool) {
        return { name: call.name, success: false, resultForModel: `未知工具「${call.name}」。可用工具：${getQaTools().map((t) => t.name).join("、")}` };
    }
    try {
        const result = await tool.run(call.args ?? {}, context);
        return { name: call.name, success: true, resultForModel: result };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { name: call.name, success: false, resultForModel: `工具执行失败：${message.slice(0, 300)}` };
    }
}
