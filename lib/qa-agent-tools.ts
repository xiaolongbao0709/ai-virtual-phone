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
} from "./qa-github";
import { createQaIssue, type QaCommitFile } from "./qa-github-write";
import {
    saveQaFeedbackTicket,
    updateQaFeedbackTicket,
    captureQaEnvironment,
    formatQaFeedbackMarkdown,
    type QaFeedbackTicket,
} from "./qa-feedback";

// ── 工坊诊断工具集（P1）──────────────────────────────
// 文本协议与全项目一致：[执行动作:工具名({"参数":"值"})]，解析复用 tool-executor.parseToolCalls。

export type QaProposedCommit = {
    message: string;
    branch?: string;
    files: QaCommitFile[];
};

export type QaToolContext = {
    signal?: AbortSignal;
    /** 确认模式下，写工具通过它把提案交给 UI，返回 true 表示已暂存等待确认。 */
    onStageCommit?: (proposal: QaProposedCommit) => void;
    /** true=全自动模式，写工具直接提交。 */
    autoCommit?: boolean;
};

export type QaToolRunResult = {
    name: string;
    success: boolean;
    resultForModel: string;
};

type QaTool = {
    name: string;
    description: string;
    schemaLines: string[];
    run: (args: Record<string, unknown>, context?: QaToolContext) => Promise<string>;
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

// ── GitHub 只读工具（仅在配置了仓库时启用）──────────

const githubTreeTool: QaTool = {
    name: "仓库文件树",
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
        return clip(`${file.path}（${lines.length} 行，显示 ${start}-${Math.min(end, lines.length)}）：\n${numbered}`);
    },
};

const githubSearchTool: QaTool = {
    name: "搜索仓库代码",
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

const githubCommitTool: QaTool = {
    name: "提交修改",
    description:
        "把对仓库文件的修改提交上去。给出完整的新文件内容（不是 diff）。确认模式下会先展示给用户确认再提交；全自动模式下直接提交。修改前应先用「读取仓库文件」拿到原内容再改。",
    schemaLines: [
        "  参数：",
        "    · message (必填) — 提交说明（一句话，中文）",
        "    · files (必填) — 数组，每项 {path, content}，content 是该文件的完整新内容",
        "    · branch (可选) — 目标分支，默认仓库默认分支",
        '  调用：[执行动作:提交修改({"message":"更新标题","files":[{"path":"README.md","content":"# 新标题\\n"}]})]',
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
        if (!message) return "缺少 message（提交说明）。";
        if (files.length === 0) return "缺少 files（要提交的文件，每项含 path 和完整 content）。";
        const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined;
        const proposal: QaProposedCommit = { message, branch, files };
        context?.onStageCommit?.(proposal);
        if (context?.autoCommit) {
            return `修改提案已生成（${files.length} 个文件：${files.map((f) => f.path).join("、")}），当前是全自动模式，系统会直接提交。请向用户简述你做的修改和影响。`;
        }
        return `已生成修改提案（${files.length} 个文件：${files.map((f) => f.path).join("、")}），已在界面展示给用户，等待用户点「应用」确认。请告诉用户你准备做的修改和影响，让他确认。不要假装已经提交成功。`;
    },
};

const GITHUB_TOOLS: QaTool[] = [githubTreeTool, githubReadTool, githubSearchTool];
const GITHUB_WRITE_TOOLS: QaTool[] = [githubCommitTool];

// ── 注册表与执行入口 ──────────────────────────────────

// ── 反馈闭环工具 ──

let feedbackSeq = 0;

const feedbackTool: QaTool = {
    name: "记录反馈",
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

const BASE_TOOLS: QaTool[] = [apiCheckTool, storageReportTool, errorLogTool, deviceInfoTool, feedbackTool];

/** 当前可用工具集：基础诊断 + （已连接仓库时）GitHub 只读 + （有 PAT 时）写入工具。 */
export function getQaTools(): QaTool[] {
    const config = loadQaGithubConfig();
    if (!config) return BASE_TOOLS;
    const tools = [...BASE_TOOLS, ...GITHUB_TOOLS];
    if (config.token) tools.push(...GITHUB_WRITE_TOOLS);
    return tools;
}

// 全量工具（store 里用于工具名映射与执行查找）
export const QA_TOOLS: QaTool[] = [...BASE_TOOLS, ...GITHUB_TOOLS, ...GITHUB_WRITE_TOOLS];

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
    lines.push("· 回答代码问题时，先用「仓库文件树」或「搜索仓库代码」定位，再用「读取仓库文件」看具体实现，基于真实代码作答");
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
