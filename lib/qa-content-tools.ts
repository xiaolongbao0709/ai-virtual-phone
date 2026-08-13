// ── 工坊内容开发工场（P2b）──────────────────────────
// 让工坊 agent 把写好的内容直接装进本机：自定义 APP、小游戏（游戏大厅·本机测试）、
// 黑市剧场（工作室·本机测试）。全部只写浏览器本地存储，可在对应 UI 里删除，不碰远端。

import { getQaPageChars } from "./qa-prefs";
import { createCustomAppPackageFile } from "./custom-app-package";
import { downloadFile } from "./download-utils";
import {
    parseGameRoleSlots,
    upsertLocalTestGame,
    isLocalTestGameId,
    loadGameState,
    loadGameDrafts,
    saveGameDrafts,
} from "./game-storage";
import type { GameHallDraft, GameRoleSlot, GameTemplate, GameTemplateDraft } from "./game-types";
import { kvGet, kvSet } from "./kv-db";
import { GAME_CREATOR_GUIDE_MD, GAME_EMPTY_PICKER_HTML } from "./game-creator-guide";
import {
    upsertLocalTestTheater,
    isLocalTestTheaterId,
    loadBlackMarketState,
} from "./black-market-storage";
import type { BlackMarketTheaterTemplate } from "./black-market-types";
import {
    loadInstalledCustomApps,
    saveInstalledCustomAppsAsync,
    installCustomAppAsync,
    generateCustomAppRuntimeId,
    normalizeCustomAppManifestId,
    loadCustomAppPackage,
    CUSTOM_APP_PLACE_DESKTOP_EVENT,
} from "./custom-app-storage";
import { applyCustomAppRegistrationsAsync, formatCustomAppRegistrationSummary } from "./custom-app-registration";
import { CUSTOM_APP_CREATOR_GUIDE_MD } from "./custom-app-creator-guide";
import { fetchCustomAppMarketItems, fetchMyCustomAppMarketItems } from "./custom-app-market-client";
import { buildMarketItemByAppId, classifyInstalledApp, type MarketOwnershipData } from "./custom-app-ownership";
import type { CustomAppPermission, InstalledCustomApp } from "./custom-app-types";

/** 本轮对话创建的内容条目（供工坊内预览打开） */
export type QaCreatedContent = {
    type: "app" | "game" | "theater";
    /** app→安装应用 id；game/theater→本机测试 localId */
    refId: string;
    title: string;
};

// 与 qa-agent-tools 的 QaTool 结构保持一致（避免循环依赖，这里重复声明最小形状）
type QaContentTool = {
    name: string;
    /** 原生工具协议的稳定英文名（function 名仅允许 ASCII） */
    nativeName: string;
    description: string;
    schemaLines: string[];
    /** 原生工具协议的 JSON Schema 参数定义 */
    parameters: Record<string, unknown>;
    run: (
        args: Record<string, unknown>,
        context?: { signal?: AbortSignal; onContentCreated?: (item: QaCreatedContent) => void },
    ) => Promise<string>;
};

// ── 小工具 ──

function text(value: unknown, max = 4000): string {
    return typeof value === "string" ? value.slice(0, max).trim() : "";
}

/** 由标题生成稳定 slug：同名内容反复安装会更新同一条目（幂等）。 */
function stableSlug(seed: string): string {
    let hash = 5381;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
    return hash.toString(36);
}

function normalizeStringArray(value: unknown, maxItems: number, maxLen: number): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => text(item, maxLen))
        .filter(Boolean)
        .slice(0, maxItems);
}

// ── 创作指南（按需取文档，模型写内容前先读）──

const THEATER_GUIDE_MD = `# 黑市剧场（夜间档案）制作说明

一个剧场 = 一段有开场、有回合限制、有输出规则的互动小剧。运行时由场景引擎驱动：
你写的 aiInstruction 会作为系统提示词交给用户选定角色的 LLM，逐回合生成剧情。

## 字段
- title（必填）：档案名
- aiInstruction（必填，核心）：给 AI 的完整演出指令。写清世界观、角色行为规则、
  每回合输出什么。支持宏：{{char}}=角色名、{{user}}=用户名。
- openingHtml（必填）：开场画面 HTML（纯静态展示，无 JS 交互协议），
  用户点开档案先看到它，再进入正戏。
- outputContract（可选）：输出契约，会附在指令后，用于约束每回合输出格式
  （例如固定段落结构、必须包含的标记）。
- durationTurns（可选，默认 8，1-30）：回合数上限，到达后剧场收档。
- renderRules（可选数组）：正则渲染规则 {pattern, flags, className, template}，
  把 AI 输出里匹配的文本包装成带样式的片段（template 里 $1 引用捕获组）。
- renderCss（可选）：配合 renderRules 的自定义 CSS。
- memorySummaryPrompt（可选）：收档时把剧情总结写入角色记忆用的提示词。
- subtitle / synopsis / storyText / tags / rarity(common|rare|legend|encrypted) / glyph：陈列信息。

## 建议
- aiInstruction 用分节结构：【背景】【你扮演】【每回合规则】【禁止】。
- 想要花字/特效：renderRules 匹配 AI 按 outputContract 输出的标记，renderCss 上样式。
- 写完用「上架本机剧场」装进 黑市剧场 → 工作室 → 本机测试，可反复试演（写记忆、可删除）。`;

// ── 发布前结构体检 ────────────────────────────────────
// 拦下"装上才发现全按钮失灵"的两类事故：①分段接缝把文档提前收尾（</html> 后
// 还挂着几万字，浏览器当纯文本）；②内联脚本语法错误（一个多余的大括号让整块
// 脚本被拒绝执行）。体检不过 → 拒绝安装并返回具体问题，模型用「编辑」修复。

const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function validateGeneratedHtml(html: string, fileLabel: string): string | null {
    const problems: string[] = [];
    const lower = html.toLowerCase();
    const htmlClose = lower.lastIndexOf("</html>");
    if (htmlClose !== -1) {
        const after = html.slice(htmlClose + "</html>".length).trim();
        if (after) {
            problems.push(`</html> 之后还有 ${after.length.toLocaleString()} 字符内容——文档被提前收尾（分段接缝常见错误），这些内容会被浏览器当纯文本，代码不执行`);
        }
    }
    // 配平检查基于"完整块剥离后是否还有孤立标签"：字符串里出现 </script> 时
    // 真实浏览器同样会提前终止脚本，标出来是正确行为
    const withoutBlocks = html.replace(SCRIPT_BLOCK_RE, "");
    if (/<script\b/i.test(withoutBlocks) || /<\/script>/i.test(withoutBlocks)) {
        problems.push("存在未配对的 <script> 标签（多余的开/闭标签，或脚本字符串里出现了 </script>）");
    }
    // 内联脚本试编译：语法错误会让整块脚本被浏览器静默拒绝执行
    let match: RegExpExecArray | null;
    let blockIndex = 0;
    SCRIPT_BLOCK_RE.lastIndex = 0;
    while ((match = SCRIPT_BLOCK_RE.exec(html)) !== null) {
        blockIndex += 1;
        const attrs = match[1] ?? "";
        if (/\bsrc\s*=/i.test(attrs)) continue;
        const typeAttr = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
        if (typeAttr && !/javascript/i.test(typeAttr)) continue; // module/json 等语法不同，跳过
        const code = match[2] ?? "";
        if (!code.trim()) continue;
        try {
            // eslint-disable-next-line no-new-func
            new Function(code);
        } catch (error) {
            const line = html.slice(0, match.index).split("\n").length;
            problems.push(`第 ${blockIndex} 个脚本块（约第 ${line} 行起）语法错误：${error instanceof Error ? error.message : String(error)}——整块脚本会被浏览器拒绝执行，所有交互失灵`);
        }
    }
    if (problems.length === 0) return null;
    return `${fileLabel} 发布体检未通过，已拒绝安装：\n${problems.map((p) => `· ${p}`).join("\n")}\n用「读取」核对对应位置原文，用「编辑」修复后重新发布。`;
}

const contentGuideTool: QaContentTool = {
    name: "创作指南",
    nativeName: "read_creation_guide",
    description:
        "读取三类本机内容的官方制作说明（自定义APP / 小游戏 / 黑市剧场）。动手写内容前必读：包含运行时协议、可用 API、字段含义与限制。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater",
        "    · page (可选) — 指南较长时分页返回，默认第 1 页",
        '  调用：[执行动作:创作指南({"type":"game"})]',
    ],
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater"], description: "内容类型" },
            page: { type: "number", description: "页码，默认 1" },
        },
        required: ["type"],
    },
    async run(args) {
        const type = text(args.type, 20);
        const guide =
            type === "app" ? CUSTOM_APP_CREATOR_GUIDE_MD
            : type === "game" ? GAME_CREATOR_GUIDE_MD
            : type === "theater" ? THEATER_GUIDE_MD
            : null;
        if (!guide) return "type 需为 app / game / theater 之一。";
        const pageSize = getQaPageChars();
        const pages = Math.max(1, Math.ceil(guide.length / pageSize));
        const page = Math.min(pages, Math.max(1, typeof args.page === "number" ? Math.floor(args.page) : 1));
        const slice = guide.slice((page - 1) * pageSize, page * pageSize);
        const head = `【${type} 创作指南 第 ${page}/${pages} 页】${pages > 1 ? `（还有内容，用 page 参数翻页）` : ""}`;
        return `${head}\n${slice}`;
    },
};

// ── 安装自定义 APP ──

const SINGLE_HTML_APP_PERMISSIONS: CustomAppPermission[] = [
    "app.data.read",
    "app.data.write",
    "app.manifest.read",
    "characters.read",
    "user.persona.read",
    "memory.readCore",
    "memory.readLongTerm",
    "memory.readShortTerm",
    "memory.search",
    "ai.generate",
    "chat.read",
    "chat.sendMessage",
    "chat.sendCard",
    "chat.requestReply",
    "chat.contacts.write",
    "ui.toast",
    "notifications.read",
    "notifications.write",
    "tasks.schedule",
    "wallet.read",
    "wallet.pay",
];

const installAppTool: QaContentTool = {
    name: "安装本机应用",
    nativeName: "install_local_app",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "应用名（显示在桌面）" },
            html: { type: "string", description: "完整单文件 HTML（含内联 CSS/JS）" },
            description: { type: "string", description: "一句话简介" },
            permissions: { type: "array", items: { type: "string" }, description: "可选：覆盖默认权限集（如需要 chat.tools 等）。不填用单文件默认权限" },
        },
        required: ["name", "html"],
    },
    description:
        "把写好的单文件 HTML 自定义 APP 直接安装到用户的小手机桌面（等同用户手动导入单 HTML）。同名应用会原地更新（保留应用数据）。写之前先读「创作指南」type=app 了解宿主 API。",
    schemaLines: [
        "  参数：",
        "    · name (必填) — 应用名（会显示在桌面）",
        "    · html (必填) — 完整单文件 HTML（含内联 CSS/JS）",
        "    · description (可选) — 一句话简介",
        "    · permissions (可选) — 权限数组，覆盖默认权限集（如 chat.tools）；不填用单文件默认权限",
        '  调用：[执行动作:安装本机应用({"name":"番茄钟","html":"<!doctype html>…"})]',
    ],
    async run(args, context) {
        const name = text(args.name, 60);
        const html = typeof args.html === "string" ? args.html : "";
        if (!name) return "缺少 name（应用名）。";
        if (!html.trim()) return "缺少 html（完整单文件 HTML 内容）。";
        const problem = validateGeneratedHtml(html, `应用「${name}」的 HTML`);
        if (problem) return problem;
        const description = text(args.description, 200);
        // 可选自定义权限：透传字符串，读取时 normalizeInstalledApp 会过滤无效项
        const customPerms = Array.isArray(args.permissions)
            ? ([...new Set(args.permissions.filter((v): v is string => typeof v === "string" && v.length < 60))] as CustomAppPermission[])
            : null;
        const perms = customPerms?.length ? customPerms : SINGLE_HTML_APP_PERMISSIONS;
        const now = new Date().toISOString();

        const apps = loadInstalledCustomApps();
        const existing = apps.find((app) => app.name.trim().toLowerCase() === name.toLowerCase());
        if (existing) {
            const denial = await denyIfOthersMarketApp(existing, "覆盖");
            if (denial) return `${denial}\n想创建自己的应用请换一个名称。`;
            const updated: InstalledCustomApp = {
                ...existing,
                entryHtml: html,
                permissions: customPerms?.length ? perms : existing.permissions,
                manifest: customPerms?.length ? { ...existing.manifest, permissions: perms } : existing.manifest,
                description: description || existing.description,
                // 关联市场版的 APP 被改动：与 UI 编辑/换包一致，标记有未发布改动
                hasUnpublishedChanges: existing.marketItemId ? true : existing.hasUnpublishedChanges,
                updatedAt: now,
            };
            await saveInstalledCustomAppsAsync([updated, ...apps.filter((app) => app.id !== existing.id)]);
            context?.onContentCreated?.({ type: "app", refId: existing.id, title: name });
            const linkedNote = existing.marketItemId ? "该 APP 已上架，本地测试卡片会显示「有未发布改动」，用户点「发布」即可提交更新到市场。" : "";
            return `✓ 已更新本机应用「${name}」（应用数据保留）。${linkedNote}请告诉用户：点输入框旁的预览按钮即可直接打开，或到桌面找「${name}」。`;
        }

        const app: InstalledCustomApp = {
            id: generateCustomAppRuntimeId(name),
            name,
            version: "1.0.0",
            description: description || undefined,
            entryHtml: html,
            permissions: perms,
            manifest: {
                id: normalizeCustomAppManifestId(name),
                name,
                version: "1.0.0",
                entry: "index.html",
                permissions: perms,
            },
            assets: {},
            installedAt: now,
            updatedAt: now,
        };
        await installCustomAppAsync(app);
        // 请求桌面为新应用摆放图标（应用市场安装走同一落位逻辑）
        window.dispatchEvent(new CustomEvent(CUSTOM_APP_PLACE_DESKTOP_EVENT, { detail: { appId: app.id } }));
        context?.onContentCreated?.({ type: "app", refId: app.id, title: name });
        return `✓ 已安装本机应用「${name}」。请告诉用户：点输入框旁的预览按钮即可直接打开测试；应用图标也已放到桌面，长按可卸载。`;
    },
};

// ── 应用包暂存区（分段写入 → 组包安装）──────────────
// 解决两个问题：① 模型单次输出有 max_tokens 上限，大 HTML 一次写不完——分多轮
// 追加暂存；② 单文件安装没有 manifest 声明（权限 / chat.tools 工具）——暂存区
// 支持完整应用包（manifest.json + 入口 + presets.json + 资源），组包后与上传 zip 等价。

type StagedAppFile = { text?: string; base64?: string };

// 暂存区持久化到 kv（IndexedDB）：手机上切后台/改设置随时可能触发页面重载，
// 纯内存 Map 会把已分段写入的几万字直接蒸发。懒加载 + 每次变更整份落盘。
const APP_STAGING_KEY = "ai_phone_qa_app_staging_v1";
const APP_STAGING_MEM = new Map<string, StagedAppFile>();
let appStagingLoaded = false;

function appStaging(): Map<string, StagedAppFile> {
    if (!appStagingLoaded) {
        appStagingLoaded = true;
        try {
            const parsed = JSON.parse(kvGet(APP_STAGING_KEY) || "[]") as Array<[string, StagedAppFile]>;
            if (Array.isArray(parsed)) {
                for (const [key, file] of parsed) {
                    if (typeof key === "string" && file && typeof file === "object") APP_STAGING_MEM.set(key, file);
                }
            }
        } catch {
            // ignore
        }
    }
    return APP_STAGING_MEM;
}

function persistAppStaging(): void {
    kvSet(APP_STAGING_KEY, JSON.stringify([...appStaging()]));
}
const STAGE_MAX_FILES = 40;
const STAGE_MAX_FILE_CHARS = 2_000_000;
const STAGE_MAX_TOTAL_CHARS = 10_000_000;

function stagePath(value: unknown): string {
    return String(value ?? "").replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "").trim();
}

function stagingSummary(): string {
    if (appStaging().size === 0) return "（暂存区为空）";
    return [...appStaging().entries()]
        .map(([path, f]) => `${path}(${(f.text ?? f.base64 ?? "").length})`)
        .join("、");
}

const stageAppFileTool: QaContentTool = {
    name: "暂存应用文件",
    nativeName: "stage_app_file",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "包内路径，如 manifest.json / index.html / presets.json / icon.png" },
            content: { type: "string", description: "文件内容（文本；二进制文件传 base64 并置 base64=true）" },
            append: { type: "boolean", description: "true=追加到该文件已暂存内容末尾（大 HTML 分多轮写入用）" },
            base64: { type: "boolean", description: "true=content 是 base64 编码的二进制（如图标）" },
        },
        required: ["path", "content"],
    },
    description:
        "把应用包文件写入暂存区（不落盘）。大 HTML 超过单次输出上限时分多轮写：第一轮写骨架，后续轮 append=true 追加，绝不会被 max_tokens 截断。完整包需要 manifest.json（含 id/name/version/entry/permissions，可声明 chat.tools 等权限与 extensions.tools 工具）+ 入口 HTML；presets.json、图标等资源文件也可暂存。全部就绪后用「安装暂存应用」组包安装。",
    schemaLines: [
        "  参数：",
        "    · path (必填) — 包内路径（manifest.json / index.html / presets.json / icon.png…）",
        "    · content (必填) — 文件内容；二进制传 base64 并置 base64=true",
        "    · append (可选) — true=追加到已暂存内容末尾（大文件分轮写）",
        '  调用：[执行动作:暂存应用文件({"path":"index.html","content":"<!doctype html>…","append":true})]',
    ],
    async run(args) {
        const path = stagePath(args.path);
        if (!path || path.includes("..") || path.length > 100) return "path 无效（相对包内路径，不允许 ..）。";
        const content = typeof args.content === "string" ? args.content : "";
        if (!content) return "缺少 content。";
        if (appStaging().size >= STAGE_MAX_FILES && !appStaging().has(path)) return `暂存文件数已达上限 ${STAGE_MAX_FILES}。`;
        const isBase64 = args.base64 === true;
        const existing = appStaging().get(path);
        let next: StagedAppFile;
        if (args.append === true && existing?.text != null && !isBase64) {
            next = { text: existing.text + content };
        } else if (args.append === true && existing?.base64 != null) {
            return `${path} 是二进制暂存，不支持追加。`;
        } else {
            next = isBase64 ? { base64: content.replace(/\s+/g, "") } : { text: content };
        }
        const size = (next.text ?? next.base64 ?? "").length;
        if (size > STAGE_MAX_FILE_CHARS) return `单文件暂存超限（${size} > ${STAGE_MAX_FILE_CHARS} 字符）。`;
        let total = size;
        for (const [k, f] of appStaging()) { if (k !== path) total += (f.text ?? f.base64 ?? "").length; }
        if (total > STAGE_MAX_TOTAL_CHARS) return `暂存区总量超限（${total} > ${STAGE_MAX_TOTAL_CHARS} 字符）。`;
        appStaging().set(path, next);
        persistAppStaging();
        return `✓ 已暂存 ${path}（当前 ${size.toLocaleString()} 字符${args.append === true ? "，本次为追加" : ""}）。暂存区：${stagingSummary()}。继续追加或暂存其他文件；全部就绪后用「发布」type=app 组包安装。`;
    },
};

const installStagedAppTool: QaContentTool = {
    name: "安装暂存应用",
    nativeName: "install_staged_app",
    parameters: {
        type: "object",
        properties: { clear: { type: "boolean", description: "true=不安装，只清空暂存区（重来）" } },
    },
    description:
        "把暂存区的文件组成应用包并安装到本机（等价上传 zip：manifest 声明的权限 / chat.tools / extensions.tools / presets 全部生效）。要求暂存区已有 manifest.json 与入口 HTML。同名/同 manifest id 应用会原地更新（保留应用数据与市场关联）。安装成功后暂存区自动清空。",
    schemaLines: [
        "  参数：",
        "    · clear (可选) — true=不安装，只清空暂存区",
        '  调用：[执行动作:安装暂存应用({})]',
    ],
    async run(args, context) {
        if (args.clear === true) {
            appStaging().clear();
            persistAppStaging();
            return "✓ 暂存区已清空。";
        }
        if (appStaging().size === 0) return "暂存区为空。先用「写入」type=app 写入 manifest.json 与入口 HTML（单文件应用只需 index.html）。";
        if (!appStaging().has("manifest.json")) return `暂存区缺少 manifest.json。当前：${stagingSummary()}`;
        for (const [path, staged] of appStaging()) {
            if (staged.text == null || !/\.html?$/i.test(path)) continue;
            const problem = validateGeneratedHtml(staged.text, `暂存文件 ${path}`);
            if (problem) return problem;
        }
        try {
            const JSZip = (await import("jszip")).default;
            const zip = new JSZip();
            for (const [path, f] of appStaging()) {
                if (f.base64 != null) {
                    const binary = atob(f.base64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
                    zip.file(path, bytes);
                } else {
                    zip.file(path, f.text ?? "");
                }
            }
            const blob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
            const loaded = await loadCustomAppPackage(new File([blob], "staged-app.zip", { type: "application/zip" }));

            // 同名 / 同 manifest id 原地更新：保留运行时 id（应用数据不丢）与市场关联
            const apps = loadInstalledCustomApps();
            const existing = apps.find(
                (a) => a.manifest?.id === loaded.manifest?.id || a.name.trim().toLowerCase() === loaded.name.trim().toLowerCase(),
            );
            if (existing) {
                const denial = await denyIfOthersMarketApp(existing, "覆盖安装");
                if (denial) return `${denial}\n想发布自己的应用请改用不同的名称与 manifest id 后重新组包。`;
            }
            let installed: InstalledCustomApp;
            if (existing) {
                installed = {
                    ...loaded,
                    id: existing.id,
                    installedAt: existing.installedAt,
                    marketItemId: existing.marketItemId,
                    hasUnpublishedChanges: existing.marketItemId ? true : existing.hasUnpublishedChanges,
                };
                await saveInstalledCustomAppsAsync([installed, ...apps.filter((a) => a.id !== existing.id)]);
            } else {
                installed = await installCustomAppAsync(loaded);
                window.dispatchEvent(new CustomEvent(CUSTOM_APP_PLACE_DESKTOP_EVENT, { detail: { appId: installed.id } }));
            }
            // 应用 manifest 声明（presets 等注册）
            let regNote = "";
            try {
                const summary = await applyCustomAppRegistrationsAsync(installed);
                const formatted = formatCustomAppRegistrationSummary(summary);
                if (formatted) regNote = `已登记：${formatted}。`;
            } catch {
                // 注册失败不阻塞安装
            }
            appStaging().clear();
            persistAppStaging();
            context?.onContentCreated?.({ type: "app", refId: installed.id, title: installed.name });
            const toolCount = installed.manifest?.extensions?.tools?.length ?? 0;
            const toolNote = toolCount > 0 ? `声明了 ${toolCount} 个聊天工具。` : "";
            return `✓ 已${existing ? "更新" : "安装"}应用「${installed.name}」（完整应用包）。${toolNote}${regNote}请告诉用户：点输入框旁的预览按钮可直接打开，或到桌面找「${installed.name}」。`;
        } catch (error) {
            return `组包安装失败：${error instanceof Error ? error.message : String(error)}。暂存区已保留，可修正后重试（清空用 clear=true）。`;
        }
    },
};

// ── 安装本机游戏（游戏大厅 · 本机测试）──

function normalizeRoleSlots(value: unknown): GameRoleSlot[] {
    if (!Array.isArray(value)) return [];
    const slots: GameRoleSlot[] = [];
    for (const item of value.slice(0, 12)) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const id = text(record.id, 64) || `slot_${slots.length + 1}`;
        const label = text(record.label, 40) || id;
        const min = Math.max(0, Math.min(12, Number(record.min) || 0));
        const max = Math.max(min || 1, Math.min(12, Number(record.max) || Math.max(min, 1)));
        slots.push({
            id,
            label,
            description: text(record.description, 200),
            required: record.required !== false,
            min,
            max,
        });
    }
    return slots;
}

const installGameTool: QaContentTool = {
    name: "安装本机游戏",
    nativeName: "install_local_game",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "游戏名" },
            gameHtml: { type: "string", description: "游戏正体单文件 HTML" },
            roleSlots: {
                type: "array",
                description: "角色槽位；不填则为无角色游戏",
                items: {
                    type: "object",
                    properties: {
                        id: { type: "string" }, label: { type: "string" }, description: { type: "string" },
                        required: { type: "boolean" }, min: { type: "number" }, max: { type: "number" },
                    },
                },
            },
            pickerHtml: { type: "string", description: "角色选择界面 HTML（启用 roleSlots 时必填）" },
            subtitle: { type: "string" }, synopsis: { type: "string" }, playNote: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            fromDraft: { type: "boolean", description: "true=从同标题草稿读取全部内容安装（分段写完大游戏后用，不必重新传 gameHtml）" },
        },
        required: ["title"],
    },
    description:
        "把写好的小游戏安装到 游戏大厅 → 创作工坊 → 本机测试（不发布市场）。同标题重复安装会更新同一条目。写之前先读「创作指南」type=game 了解游戏 HTML 与宿主的通信协议。",
    schemaLines: [
        "  参数：",
        "    · title (必填) — 游戏名",
        "    · gameHtml (必填) — 游戏正体单文件 HTML",
        "    · roleSlots (可选) — 角色槽位数组 [{id,label,description,required,min,max}]；不填则为无角色游戏",
        "    · pickerHtml (启用 roleSlots 时必填) — 角色选择界面 HTML",
        "    · subtitle / synopsis / playNote / tags (可选) — 陈列信息",
        "    · fromDraft (可选) — true=从同标题草稿读取全部内容安装（大游戏先分段存草稿再用它）",
        '  调用：[执行动作:安装本机游戏({"title":"五子棋","gameHtml":"<!doctype html>…"})] 或 [执行动作:安装本机游戏({"title":"五子棋","fromDraft":true})]',
    ],
    async run(args, context) {
        const title = text(args.title, 80);
        if (!title) return "缺少 title（游戏名）。";
        // fromDraft：从同标题草稿取内容（大游戏分段存草稿后安装，不必重新传大字段）
        let sourceDraft: GameTemplateDraft | null = null;
        if (args.fromDraft === true) {
            const found = loadGameDrafts().find((item) => norm(item.title) === norm(title));
            if (!found) return `草稿箱里没有「${title}」。先用「写入」type=game 写入草稿（大游戏可分段追加），再发布。`;
            sourceDraft = found.draft;
        }
        const gameHtml = sourceDraft ? sourceDraft.gameHtml : typeof args.gameHtml === "string" ? args.gameHtml : "";
        // fromDraft 时陈列字段与 tags 也取自草稿（否则 fromDraft 安装会丢掉草稿里的标签）
        const draftTags = sourceDraft ? sourceDraft.tagsText.split(/[\s,，]+/).filter(Boolean).slice(0, 8) : null;
        if (!gameHtml.trim()) return "缺少 gameHtml（游戏单文件 HTML）。大游戏先用「写入」type=game field=gameHtml 分段写进草稿，再发布。";
        const gameHtmlProblem = validateGeneratedHtml(gameHtml, `游戏「${title}」的 gameHtml`);
        if (gameHtmlProblem) return gameHtmlProblem;
        const roleSlots = sourceDraft ? parseGameRoleSlots(sourceDraft.roleSlotsText) : normalizeRoleSlots(args.roleSlots);
        const pickerHtml = sourceDraft ? sourceDraft.pickerHtml.trim() : typeof args.pickerHtml === "string" ? args.pickerHtml.trim() : "";
        if (roleSlots.length > 0 && !pickerHtml) return "启用 roleSlots 时必须提供 pickerHtml（角色选择界面）。";

        const slug = stableSlug(title);
        const now = new Date().toISOString();
        const template: GameTemplate = {
            id: `qa_game_${slug}`,
            title,
            codeName: `QA-${slug.toUpperCase()}`,
            subtitle: sourceDraft ? text(sourceDraft.subtitle, 160) : text(args.subtitle, 160),
            synopsis: sourceDraft ? text(sourceDraft.synopsis, 600) : text(args.synopsis, 600),
            playNote: sourceDraft ? text(sourceDraft.playNote, 3000) : text(args.playNote, 3000),
            coverImage: "",
            tags: draftTags ?? normalizeStringArray(args.tags, 8, 24),
            authorId: "qa_workshop",
            authorName: "工坊",
            authorAvatar: "",
            source: "local",
            version: 1,
            roleSlots,
            pickerHtml: roleSlots.length > 0 ? pickerHtml : GAME_EMPTY_PICKER_HTML,
            gameHtml,
            allowExternalControl: false,
            purchaseCount: 0,
            rating: 0,
            likeCount: 0,
            favoriteCount: 0,
            commentCount: 0,
            createdAt: now,
            updatedAt: now,
        };
        const result = upsertLocalTestGame(`qa_${slug}`, template);
        if (!result.ok) return `安装失败：${result.error ?? "游戏包无效"}。检查 gameHtml 是否为完整 HTML。`;
        context?.onContentCreated?.({ type: "game", refId: result.installedGame?.localId ?? `localtest_game_qa_${slug}`, title });
        return `✓ 已安装本机游戏「${title}」。请告诉用户：点输入框旁的预览按钮即可直接游玩；游戏也在 游戏大厅 → 创作工坊 → 本机测试；重复安装同名游戏会自动更新。`;
    },
};

// ── 上架本机剧场（黑市剧场 · 工作室 · 本机测试）──

const installTheaterTool: QaContentTool = {
    name: "上架本机剧场",
    nativeName: "install_local_theater",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "档案名" },
            aiInstruction: { type: "string", description: "给 AI 的完整演出指令，支持 {{char}}/{{user}} 宏" },
            openingHtml: { type: "string", description: "开场画面 HTML" },
            outputContract: { type: "string" },
            renderRules: { type: "array", items: { type: "object", properties: { pattern: { type: "string" }, flags: { type: "string" }, className: { type: "string" }, template: { type: "string" } } } },
            renderCss: { type: "string" }, memorySummaryPrompt: { type: "string" },
            subtitle: { type: "string" }, synopsis: { type: "string" }, storyText: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            rarity: { type: "string", enum: ["common", "rare", "legend", "encrypted"] },
            glyph: { type: "string" }, durationTurns: { type: "number", description: "回合数上限 1-30，默认 8" },
            fromDraft: { type: "boolean", description: "true=从同标题草稿读取内容上架（分段写完超长开场后用，不必重新传大字段）" },
        },
        required: ["title"],
    },
    description:
        "把写好的黑市剧场（夜间档案）上架到 黑市剧场 → 工作室 → 本机测试（不发布市场、不扣钱）。同标题重复上架会更新同一条目。写之前先读「创作指南」type=theater。",
    schemaLines: [
        "  参数：",
        "    · title (必填) — 档案名",
        "    · aiInstruction (必填) — 给 AI 的完整演出指令（支持 {{char}}/{{user}} 宏）",
        "    · openingHtml (必填) — 开场画面 HTML",
        "    · outputContract / renderRules / renderCss / memorySummaryPrompt (可选) — 输出与渲染控制",
        "    · subtitle / synopsis / storyText / tags / rarity / glyph / durationTurns (可选) — 陈列与回合数",
        "    · fromDraft (可选) — true=从同标题草稿读取内容上架（大字段先分段存草稿再用它）",
        '  调用：[执行动作:上架本机剧场({"title":"雨夜档案","aiInstruction":"…","openingHtml":"<div>…</div>"})] 或 [执行动作:上架本机剧场({"title":"雨夜档案","fromDraft":true})]',
    ],
    async run(args, context) {
        const title = text(args.title, 80);
        if (!title) return "缺少 title（档案名）。";
        // fromDraft：从同标题草稿取内容（超长字段分段存草稿后上架）
        let theaterDraft: Record<string, unknown> | null = null;
        if (args.fromDraft === true) {
            const found = loadBmDrafts().find((item) => norm(item.title) === norm(title));
            if (!found) return `剧场草稿箱里没有「${title}」。先用「写入」type=theater 写入草稿（大字段可分段追加），再发布。`;
            theaterDraft = found.draft as unknown as Record<string, unknown>;
        }
        const pick = (key: string, arg: unknown): string =>
            typeof arg === "string" && arg.trim() ? arg.trim() : theaterDraft ? String(theaterDraft[key] ?? "").trim() : "";
        const aiInstruction = pick("aiInstruction", args.aiInstruction);
        const openingHtml = pick("openingHtml", args.openingHtml);
        if (!aiInstruction) return "缺少 aiInstruction（演出指令）。";
        if (!openingHtml) return "缺少 openingHtml（开场画面）。";

        const slug = stableSlug(title);
        const now = new Date().toISOString();
        const rarity = args.rarity === "rare" || args.rarity === "legend" || args.rarity === "encrypted" ? args.rarity : "common";
        const durationTurns = Math.min(30, Math.max(1, Number(args.durationTurns) || 8));
        const template: BlackMarketTheaterTemplate = {
            id: `qa_theater_${slug}`,
            title,
            codeName: `QA-${slug.toUpperCase()}`,
            subtitle: text(args.subtitle, 160) || pick("subtitle", ""),
            synopsis: text(args.synopsis, 600) || pick("synopsis", ""),
            storyText: text(args.storyText, 2000) || pick("storyText", ""),
            tags: normalizeStringArray(args.tags, 8, 24).length
                ? normalizeStringArray(args.tags, 8, 24)
                : theaterDraft
                    ? String(theaterDraft.tagsText ?? "").split(/[\s,，]+/).filter(Boolean).slice(0, 8)
                    : [],
            rarity,
            glyph: text(args.glyph, 8) || "◆",
            price: 0,
            authorId: "qa_workshop",
            authorName: "工坊",
            source: "local",
            version: 1,
            durationTurns,
            allowExternalControl: false,
            openingHtml,
            aiInstruction,
            outputContract: text(args.outputContract, 12000) || pick("outputContract", "").slice(0, 12000),
            renderRules: Array.isArray(args.renderRules)
                ? (args.renderRules as BlackMarketTheaterTemplate["renderRules"])
                : theaterDraft
                    ? ((): BlackMarketTheaterTemplate["renderRules"] => {
                        try { const r = JSON.parse(String(theaterDraft.renderRulesText ?? "[]")); return Array.isArray(r) ? r : []; } catch { return []; }
                    })()
                    : [],
            renderCss: text(args.renderCss, 20000) || pick("renderCss", "").slice(0, 20000),
            memorySummaryPrompt: text(args.memorySummaryPrompt, 12000) || pick("memorySummaryPrompt", "").slice(0, 12000),
            purchaseCount: 0,
            rating: 0,
            createdAt: now,
            updatedAt: now,
        };
        const result = upsertLocalTestTheater(`qa_${slug}`, template);
        if (!result.ok) return `上架失败：${result.error ?? "夜间档案无效"}。`;
        context?.onContentCreated?.({ type: "theater", refId: result.ownedTheater?.localId ?? `localtest_theater_qa_${slug}`, title });
        return `✓ 已上架本机剧场「${title}」。请告诉用户：点输入框旁的预览按钮即可直接试演；剧场也在 黑市剧场 → 工作室 → 本机测试；重复上架同名剧场会自动更新。`;
    },
};

// ── 草稿箱访问（游戏走 game-storage；黑市草稿存储在组件内，这里按同一 kv 键与记录形状读写）──

const BM_DRAFTS_KEY = "ai_phone_black_market_studio_drafts_v1";

type BmStudioDraftRecord = {
    id: string;
    title: string;
    draft: Record<string, unknown>;
    sourceTemplateId?: string;
    sourceTemplateTitle?: string;
    hasUnpublishedChanges?: boolean;
    /** 资源集市来源标记：别人的作品，不能上架（与 black-market-app 同字段） */
    importedFrom?: string;
    createdAt: string;
    updatedAt: string;
};

function loadBmDrafts(): BmStudioDraftRecord[] {
    try {
        const parsed = JSON.parse(kvGet(BM_DRAFTS_KEY) || "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is BmStudioDraftRecord =>
            Boolean(item && typeof item === "object" && text((item as Record<string, unknown>).id, 160)));
    } catch {
        return [];
    }
}

function saveBmDrafts(drafts: BmStudioDraftRecord[]): void {
    kvSet(BM_DRAFTS_KEY, JSON.stringify(drafts.slice(0, 80)));
}

function norm(value: unknown): string {
    return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// ── 读取本机内容（本机测试 / 草稿箱，分页）──

function paginate(doc: string, pageArg: unknown, head: string): string {
    const pageSize = getQaPageChars();
    const pages = Math.max(1, Math.ceil(doc.length / pageSize));
    const page = Math.min(pages, Math.max(1, typeof pageArg === "number" ? Math.floor(pageArg) : 1));
    const slice = doc.slice((page - 1) * pageSize, page * pageSize);
    return `【${head} 第 ${page}/${pages} 页】${pages > 1 ? "（还有内容，用 page 参数翻页）" : ""}\n${slice}`;
}

function section(label: string, value: string): string {
    return value.trim() ? `\n=== ${label} ===\n${value}` : "";
}

// 版权护栏：从市场安装的他人应用，源码读取/导出/修改仅限作者本人。
// 归类逻辑与市场 UI 的"本地测试"分区共用同一实现（lib/custom-app-ownership），
// 保证"本地测试里看不到的，小坊也碰不到"。市场数据短暂缓存，连续操作不反复拉接口。
let marketOwnershipCache: { at: number; data: MarketOwnershipData } | null = null;

async function fetchMarketOwnershipData(): Promise<MarketOwnershipData> {
    if (marketOwnershipCache && Date.now() - marketOwnershipCache.at < 60_000) return marketOwnershipCache.data;
    const [publicItems, myItems] = await Promise.all([fetchCustomAppMarketItems(), fetchMyCustomAppMarketItems()]);
    const data: MarketOwnershipData = { myItems, itemByAppId: buildMarketItemByAppId(publicItems, myItems) };
    marketOwnershipCache = { at: Date.now(), data };
    return data;
}

async function denyIfOthersMarketApp(app: InstalledCustomApp, action: string): Promise<string | null> {
    // 资源集市导入的应用不依赖服务端判定，离线也照样拒绝
    if (app.resourceHubPath) {
        return `「${app.name}」是从资源集市导入的他人作品，只能在本机使用，${action}仅限作者本人。`;
    }
    let data: MarketOwnershipData;
    try {
        data = await fetchMarketOwnershipData();
    } catch {
        // 失败策略与市场 UI 相反（UI 宽容防创作区被离线锁死，这里严格防泄露）：
        // 带市场标记的一律拒绝，宁可等联网确认；仅无标记应用放行——
        // 刚在本机写出的新应用不能因断网而无法继续迭代。
        if (!app.marketItemId) return null;  // 集市导入的已在函数开头拦下，这里只剩纯本地创作
        return `「${app.name}」关联了应用市场条目，当前无法确认你是否为其作者（未登录或网络异常），为保护创作者版权，暂不能${action}。请联网并登录后重试；如果这是你自己发布的应用，届时即可正常操作。`;
    }
    if (classifyInstalledApp(app, data) === "others") {
        return `「${app.name}」是从应用市场安装的他人作品，为保护创作者版权，${action}仅限作者本人。如需二次创作，请联系原作者或在市场中查看其授权说明。`;
    }
    return null;
}

const readContentTool: QaContentTool = {
    name: "读取本机内容",
    nativeName: "read_local_content",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater"], description: "内容类型" },
            name: { type: "string", description: "APP 名 / 游戏标题 / 剧场档案名（先用「清单」查有什么）" },
            page: { type: "number", description: "内容较长时分页返回，默认第 1 页" },
        },
        required: ["type", "name"],
    },
    description:
        "读取一条本机内容的完整源码与字段：自定义 APP（含 HTML）、游戏（草稿箱优先，其次本机测试）、剧场（草稿箱优先，其次本机测试）。修改前先读，改完用对应的保存/安装工具写回。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater",
        "    · name (必填) — APP 名 / 游戏标题 / 剧场档案名",
        "    · page (可选) — 内容较长时分页，默认第 1 页",
        '  调用：[执行动作:读取本机内容({"type":"game","name":"五子棋"})]',
    ],
    async run(args) {
        const type = text(args.type, 20);
        const name = text(args.name, 80);
        if (!name) return "缺少 name。先用「清单」看看本机有什么。";

        if (type === "app") {
            const app = loadInstalledCustomApps().find((item) => norm(item.name) === norm(name));
            if (!app) return `没有找到名为「${name}」的自定义 APP。先用「清单」确认名称。`;
            const denial = await denyIfOthersMarketApp(app, "读取源码");
            if (denial) return denial;
            const assets = Object.values(app.assets).map((a) => a.path);
            const doc = [
                `名称：${app.name} · v${app.version}`,
                `简介：${app.description || "（无）"}`,
                `权限：${app.permissions.join("、") || "（无）"}`,
                `市场关联：${app.marketItemId ? `已上架（条目 ${app.marketItemId}${app.hasUnpublishedChanges ? "，有未发布改动" : ""}）` : "未上架"}`,
                `附带资源：${assets.length ? assets.join("、") : "（无，单文件应用）"}`,
                section("entryHtml", app.entryHtml),
            ].join("\n");
            return paginate(doc, args.page, `APP「${app.name}」`);
        }

        if (type === "game") {
            const draft = loadGameDrafts().find((item) => norm(item.title) === norm(name));
            if (draft) {
                const d = draft.draft;
                const doc = [
                    `来源：草稿箱（标题「${draft.title}」）`,
                    `发布关联：${draft.publishedTemplateId ? `已发布（条目 ${draft.publishedTemplateId}${draft.hasUnpublishedChanges ? "，有未发布改动" : ""}）` : "未发布"}`,
                    `subtitle：${d.subtitle || "（无）"}`,
                    `synopsis：${d.synopsis || "（无）"}`,
                    `playNote：${d.playNote || "（无）"}`,
                    `tags：${d.tagsText || "（无）"}`,
                    `roleSlots：${d.roleSlotsText || "[]"}`,
                    section("gameHtml", d.gameHtml),
                    section("pickerHtml", d.pickerHtml),
                ].join("\n");
                return paginate(doc, args.page, `游戏草稿「${draft.title}」`);
            }
            const installed = loadGameState().installedGames
                .find((g) => isLocalTestGameId(g.localId) && norm(g.templateSnapshot.title) === norm(name));
            if (!installed) return `草稿箱和本机测试里都没有找到「${name}」。先用「清单」确认名称。`;
            const t = installed.templateSnapshot;
            const doc = [
                `来源：本机测试（localId ${installed.localId}）`,
                `subtitle：${t.subtitle || "（无）"}`,
                `synopsis：${t.synopsis || "（无）"}`,
                `tags：${t.tags.join("、") || "（无）"}`,
                `roleSlots：${JSON.stringify(t.roleSlots)}`,
                section("gameHtml", t.gameHtml),
                section("pickerHtml", t.pickerHtml),
            ].join("\n");
            return paginate(doc, args.page, `本机测试游戏「${t.title}」`);
        }

        if (type === "theater") {
            const draft = loadBmDrafts().find((item) => norm(item.title) === norm(name));
            if (draft) {
                const d = draft.draft;
                const doc = [
                    `来源：草稿箱（标题「${draft.title}」）`,
                    `发布关联：${draft.sourceTemplateId ? `已发布（档案 ${draft.sourceTemplateId}${draft.hasUnpublishedChanges ? "，有未发布改动" : ""}）` : "未发布"}`,
                    `subtitle：${text(d.subtitle, 300) || "（无）"}`,
                    `synopsis：${text(d.synopsis, 1000) || "（无）"}`,
                    `storyText：${text(d.storyText, 3000) || "（无）"}`,
                    `tags：${text(d.tagsText, 200) || "（无）"}`,
                    section("aiInstruction", String(d.aiInstruction ?? "")),
                    section("openingHtml", String(d.openingHtml ?? "")),
                    section("outputContract", String(d.outputContract ?? "")),
                    section("renderRules(JSON)", String(d.renderRulesText ?? "")),
                    section("renderCss", String(d.renderCss ?? "")),
                    section("memorySummaryPrompt", String(d.memorySummaryPrompt ?? "")),
                ].join("\n");
                return paginate(doc, args.page, `剧场草稿「${draft.title}」`);
            }
            const owned = loadBlackMarketState().ownedTheaters
                .find((t) => isLocalTestTheaterId(t.localId) && norm(t.templateSnapshot.title) === norm(name));
            if (!owned) return `草稿箱和本机测试里都没有找到「${name}」。先用「清单」确认名称。`;
            const t = owned.templateSnapshot;
            const doc = [
                `来源：本机测试（localId ${owned.localId}）`,
                `subtitle：${t.subtitle || "（无）"}`,
                `synopsis：${t.synopsis || "（无）"}`,
                `durationTurns：${t.durationTurns}`,
                section("aiInstruction", t.aiInstruction),
                section("openingHtml", t.openingHtml),
                section("outputContract", t.outputContract),
                section("renderRules(JSON)", JSON.stringify(t.renderRules)),
                section("renderCss", t.renderCss),
                section("memorySummaryPrompt", t.memorySummaryPrompt),
            ].join("\n");
            return paginate(doc, args.page, `本机测试剧场「${t.title}」`);
        }

        return "type 需为 app / game / theater 之一。";
    },
};

// ── 保存游戏草稿（改草稿箱；只传要改的字段，未传的沿用原值）──

const saveGameDraftTool: QaContentTool = {
    name: "保存游戏草稿",
    nativeName: "save_game_draft",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "草稿标题（匹配现有草稿则更新，否则新建）" },
            gameHtml: { type: "string", description: "游戏正体单文件 HTML（新建时必填；整体覆盖）" },
            gameHtmlAppend: { type: "string", description: "追加到草稿现有 gameHtml 末尾（大游戏分多轮写，绕开单次输出上限）" },
            roleSlots: { type: "array", description: "角色槽位；传 [] 表示无角色游戏", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, required: { type: "boolean" }, min: { type: "number" }, max: { type: "number" } } } },
            pickerHtml: { type: "string", description: "角色选择界面 HTML" },
            subtitle: { type: "string" }, synopsis: { type: "string" }, playNote: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
    },
    description:
        "把游戏写进 游戏大厅 → 创作工坊 → 草稿箱：同标题草稿会被更新（只覆盖传入的字段，保留发布关联，卡片会提示有未发布改动），没有则新建。改用户已有的草稿前先用「读取本机内容」看当前内容。",
    schemaLines: [
        "  参数：",
        "    · title (必填) — 草稿标题（匹配现有草稿则更新，否则新建）",
        "    · gameHtml (新建时必填) — 游戏正体单文件 HTML（整体覆盖）",
        "    · gameHtmlAppend (可选) — 追加到现有 gameHtml 末尾：大游戏第一轮用 gameHtml 写骨架，后续轮用它分段续写",
        "    · roleSlots / pickerHtml / subtitle / synopsis / playNote / tags (可选) — 只传要改的字段",
        '  调用：[执行动作:保存游戏草稿({"title":"五子棋","synopsis":"新简介"})]',
    ],
    async run(args) {
        const title = text(args.title, 80);
        if (!title) return "缺少 title（草稿标题）。";
        const drafts = loadGameDrafts();
        const existing = drafts.find((item) => norm(item.title) === norm(title));
        const appendHtml = typeof args.gameHtmlAppend === "string" ? args.gameHtmlAppend : "";
        let gameHtml = typeof args.gameHtml === "string" && args.gameHtml.trim() ? args.gameHtml : existing?.draft.gameHtml ?? "";
        if (appendHtml) gameHtml = (gameHtml || "") + appendHtml;
        if (!gameHtml.trim()) return `草稿箱里没有「${title}」，新建草稿必须提供 gameHtml。`;
        if (gameHtml.length > 2_000_000) return "gameHtml 超过 2MB 上限。";

        const base: GameTemplateDraft = existing?.draft ?? {
            title, codeName: "QA", subtitle: "", synopsis: "", playNote: "", coverImage: "",
            tagsText: "互动", authorName: "工坊", roleSlotsText: "[]", pickerHtml: "", gameHtml: "",
            allowExternalControl: false,
        };
        const next: GameTemplateDraft = {
            ...base,
            title,
            gameHtml,
            pickerHtml: typeof args.pickerHtml === "string" ? args.pickerHtml : base.pickerHtml,
            roleSlotsText: Array.isArray(args.roleSlots) ? JSON.stringify(normalizeRoleSlots(args.roleSlots)) : base.roleSlotsText,
            subtitle: typeof args.subtitle === "string" ? text(args.subtitle, 160) : base.subtitle,
            synopsis: typeof args.synopsis === "string" ? text(args.synopsis, 600) : base.synopsis,
            playNote: typeof args.playNote === "string" ? text(args.playNote, 3000) : base.playNote,
            tagsText: Array.isArray(args.tags) ? normalizeStringArray(args.tags, 8, 24).join(" ") : base.tagsText,
        };
        const now = new Date().toISOString();
        const record: GameHallDraft = {
            id: existing?.id ?? `qa_draft_${stableSlug(title)}`,
            title,
            draft: next,
            publishedTemplateId: existing?.publishedTemplateId,
            // 关联已发布条目的草稿被改动：与 UI 存草稿一致，标记有未发布改动
            hasUnpublishedChanges: existing?.publishedTemplateId ? true : undefined,
            // 集市来源标记必须原样保留，否则让小坊改一次就把出处洗掉了
            importedFrom: existing?.importedFrom,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        saveGameDrafts([record, ...drafts.filter((item) => item.id !== record.id)]);
        const linked = existing?.publishedTemplateId
            ? "该草稿关联了已发布条目，卡片会显示「有未发布改动」，用户在草稿编辑器点「更新发布」即可同步到共享大厅。"
            : "用户可在草稿编辑器里点「本机测试」试玩或「发布共享」上架。";
        const appendNote = appendHtml ? `本次追加 ${appendHtml.length.toLocaleString()} 字符，gameHtml 当前共 ${gameHtml.length.toLocaleString()} 字符。写完后可用「安装本机游戏」fromDraft 上架试玩。` : "";
        return `✓ 已${existing ? "更新" : "新建"}游戏草稿「${title}」（游戏大厅 → 创作工坊 → 草稿箱）。${appendNote}${linked}`;
    },
};

// ── 保存剧场草稿（改草稿箱；只传要改的字段，未传的沿用原值）──

const saveTheaterDraftTool: QaContentTool = {
    name: "保存剧场草稿",
    nativeName: "save_theater_draft",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "档案名（匹配现有草稿则更新，否则新建）" },
            aiInstruction: { type: "string", description: "给 AI 的完整演出指令（新建时必填）" },
            openingHtml: { type: "string", description: "开场画面 HTML（新建时必填；整体覆盖）" },
            openingHtmlAppend: { type: "string", description: "追加到草稿现有 openingHtml 末尾（超长开场分多轮写）" },
            outputContract: { type: "string" },
            renderRules: { type: "array", items: { type: "object", properties: { pattern: { type: "string" }, flags: { type: "string" }, className: { type: "string" }, template: { type: "string" } } } },
            renderCss: { type: "string" }, memorySummaryPrompt: { type: "string" },
            subtitle: { type: "string" }, synopsis: { type: "string" }, storyText: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
    },
    description:
        "把剧场写进 黑市剧场 → 工作室 → 草稿箱：同名草稿会被更新（只覆盖传入的字段，保留发布关联，卡片会提示有未发布改动），没有则新建。改用户已有的草稿前先用「读取本机内容」看当前内容。",
    schemaLines: [
        "  参数：",
        "    · title (必填) — 档案名（匹配现有草稿则更新，否则新建）",
        "    · aiInstruction / openingHtml (新建时必填) — 演出指令 / 开场画面",
        "    · openingHtmlAppend (可选) — 追加到现有 openingHtml 末尾（超长开场分多轮写）",
        "    · outputContract / renderRules / renderCss / memorySummaryPrompt / subtitle / synopsis / storyText / tags (可选) — 只传要改的字段",
        '  调用：[执行动作:保存剧场草稿({"title":"雨夜档案","synopsis":"新简介"})]',
    ],
    async run(args) {
        const title = text(args.title, 80);
        if (!title) return "缺少 title（档案名）。";
        const drafts = loadBmDrafts();
        const existing = drafts.find((item) => norm(item.title) === norm(title));
        const base = existing?.draft ?? {
            title, codeName: "QA", subtitle: "", synopsis: "", storyText: "", tagsText: "",
            price: "0", authorName: "工坊", openingHtml: "", allowExternalControl: false,
            aiInstruction: "", outputContract: "", renderRulesText: "[]", renderCss: "", memorySummaryPrompt: "",
        };
        const aiInstruction = typeof args.aiInstruction === "string" && args.aiInstruction.trim() ? args.aiInstruction : String(base.aiInstruction ?? "");
        const openingAppend = typeof args.openingHtmlAppend === "string" ? args.openingHtmlAppend : "";
        let openingHtml = typeof args.openingHtml === "string" && args.openingHtml.trim() ? args.openingHtml : String(base.openingHtml ?? "");
        if (openingAppend) openingHtml = (openingHtml || "") + openingAppend;
        if (openingHtml.length > 2_000_000) return "openingHtml 超过 2MB 上限。";
        if (!aiInstruction.trim() || !openingHtml.trim()) {
            return `草稿箱里没有「${title}」，新建草稿必须同时提供 aiInstruction 和 openingHtml。`;
        }
        const next = {
            ...base,
            title,
            aiInstruction,
            openingHtml,
            outputContract: typeof args.outputContract === "string" ? args.outputContract : base.outputContract,
            renderRulesText: Array.isArray(args.renderRules) ? JSON.stringify(args.renderRules) : String(base.renderRulesText ?? "[]"),
            renderCss: typeof args.renderCss === "string" ? args.renderCss : base.renderCss,
            memorySummaryPrompt: typeof args.memorySummaryPrompt === "string" ? args.memorySummaryPrompt : base.memorySummaryPrompt,
            subtitle: typeof args.subtitle === "string" ? text(args.subtitle, 160) : base.subtitle,
            synopsis: typeof args.synopsis === "string" ? text(args.synopsis, 600) : base.synopsis,
            storyText: typeof args.storyText === "string" ? text(args.storyText, 2000) : base.storyText,
            tagsText: Array.isArray(args.tags) ? normalizeStringArray(args.tags, 8, 24).join(",") : base.tagsText,
        };
        const now = new Date().toISOString();
        const record: BmStudioDraftRecord = {
            id: existing?.id ?? `qa_draft_${stableSlug(title)}`,
            title,
            draft: next,
            sourceTemplateId: existing?.sourceTemplateId,
            sourceTemplateTitle: existing?.sourceTemplateTitle,
            // 关联已发布档案的草稿被改动：与 UI 存草稿一致，标记有未发布改动
            hasUnpublishedChanges: existing?.sourceTemplateId ? true : undefined,
            // 集市来源标记必须原样保留，否则让小坊改一次就把出处洗掉了
            importedFrom: existing?.importedFrom,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        saveBmDrafts([record, ...drafts.filter((item) => item.id !== record.id)]);
        const linked = existing?.sourceTemplateId
            ? "该草稿关联了已发布档案，卡片会显示「有未发布改动」，用户在编辑器点「更新发布」即可同步到共享市场。"
            : "用户可在编辑器里点「本机测试」试演或「发布共享」上架。";
        return `✓ 已${existing ? "更新" : "新建"}剧场草稿「${title}」（黑市剧场 → 工作室 → 草稿箱）。${linked}`;
    },
};

// ── 本机内容清单 ──

/** 关键词匹配：对一组字段做包含匹配，返回命中的字段标签；keyword 为空时返回 null（不过滤，列出全部）。 */
function keywordHits(fields: Array<[label: string, value: string]>, keyword: string): string[] | null {
    const lower = keyword.toLowerCase();
    if (!lower) return null;
    const hits: string[] = [];
    for (const [label, value] of fields) {
        if (value && value.toLowerCase().includes(lower)) hits.push(label);
    }
    return hits;
}

const listContentTool: QaContentTool = {
    name: "本机内容清单",
    nativeName: "list_local_content",
    parameters: {
        type: "object",
        properties: {
            keyword: { type: "string", description: "可选：按关键词过滤（匹配名称、简介、标签、源码等），不填列出全部" },
            noop: { type: "string", description: "无需参数，忽略" },
        },
    },
    description:
        "列出当前本机的自定义 APP、游戏/剧场草稿箱、本机测试游戏与剧场，用于确认安装结果或决定读取/修改哪个。传 keyword 可按关键词检索：只列出名称/简介/标签/源码等字段包含该词的条目，并标注命中字段。",
    schemaLines: [
        "  参数：",
        "    · keyword (可选) — 按关键词过滤，只列出命中的条目；不填列出全部",
        '  调用：[执行动作:本机内容清单({})] 或 [执行动作:本机内容清单({"keyword":"五子棋"})]',
    ],
    async run(args) {
        const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
        const draftMark = (linked: boolean, dirty?: boolean) =>
            linked ? `（已发布${dirty ? "，有未发布改动" : ""}）` : "（未发布）";
        const hitMark = (hits: string[] | null) => (hits ? ` ← 命中：${hits.join("、")}` : "");
        const lines: string[] = [];
        let total = 0;

        const apps = loadInstalledCustomApps();
        const appHits = apps
            .map((a) => ({
                item: `${a.name}${a.marketItemId ? draftMark(true, a.hasUnpublishedChanges) : ""}`,
                hits: keywordHits([["名称", a.name], ["简介", a.description || ""], ["源码", a.entryHtml]], keyword),
            }))
            .filter((r) => !r.hits || r.hits.length > 0);
        total += appHits.length;
        lines.push(`自定义 APP（${keyword ? `命中 ${appHits.length}/${apps.length} 个` : `${apps.length} 个`}）：${appHits.length ? appHits.map((r) => `${r.item}${hitMark(r.hits)}`).join("、") : "无"}`);

        const gameDrafts = loadGameDrafts();
        const gameDraftHits = gameDrafts
            .map((d) => ({
                item: `${d.title}${draftMark(Boolean(d.publishedTemplateId), d.hasUnpublishedChanges)}`,
                hits: keywordHits([["标题", d.title], ["subtitle", d.draft.subtitle || ""], ["synopsis", d.draft.synopsis || ""], ["标签", d.draft.tagsText || ""], ["gameHtml", d.draft.gameHtml || ""], ["pickerHtml", d.draft.pickerHtml || ""]], keyword),
            }))
            .filter((r) => !r.hits || r.hits.length > 0);
        total += gameDraftHits.length;
        lines.push(`游戏草稿箱（${keyword ? `命中 ${gameDraftHits.length}/${gameDrafts.length} 个` : `${gameDrafts.length} 个`}）：${gameDraftHits.length ? gameDraftHits.map((r) => `${r.item}${hitMark(r.hits)}`).join("、") : "无"}`);

        const games = loadGameState().installedGames.filter((g) => isLocalTestGameId(g.localId));
        const gameHits = games
            .map((g) => {
                const t = g.templateSnapshot;
                return {
                    item: t.title,
                    hits: keywordHits([["标题", t.title], ["subtitle", t.subtitle || ""], ["synopsis", t.synopsis || ""], ["标签", (t.tags || []).join("、")], ["gameHtml", t.gameHtml || ""], ["pickerHtml", t.pickerHtml || ""]], keyword),
                };
            })
            .filter((r) => !r.hits || r.hits.length > 0);
        total += gameHits.length;
        lines.push(`本机测试游戏（${keyword ? `命中 ${gameHits.length}/${games.length} 个` : `${games.length} 个`}）：${gameHits.length ? gameHits.map((r) => `${r.item}${hitMark(r.hits)}`).join("、") : "无"}`);

        const bmDrafts = loadBmDrafts();
        const bmDraftHits = bmDrafts
            .map((d) => ({
                item: `${d.title}${draftMark(Boolean(d.sourceTemplateId), d.hasUnpublishedChanges)}`,
                hits: keywordHits([["标题", d.title], ["subtitle", text(d.draft.subtitle, 300) || ""], ["synopsis", text(d.draft.synopsis, 1000) || ""], ["storyText", text(d.draft.storyText, 3000) || ""], ["标签", text(d.draft.tagsText, 200) || ""], ["aiInstruction", String(d.draft.aiInstruction ?? "")], ["openingHtml", String(d.draft.openingHtml ?? "")]], keyword),
            }))
            .filter((r) => !r.hits || r.hits.length > 0);
        total += bmDraftHits.length;
        lines.push(`剧场草稿箱（${keyword ? `命中 ${bmDraftHits.length}/${bmDrafts.length} 个` : `${bmDrafts.length} 个`}）：${bmDraftHits.length ? bmDraftHits.map((r) => `${r.item}${hitMark(r.hits)}`).join("、") : "无"}`);

        const theaters = loadBlackMarketState().ownedTheaters.filter((t) => isLocalTestTheaterId(t.localId));
        const theaterHits = theaters
            .map((t) => {
                const tmpl = t.templateSnapshot;
                return {
                    item: tmpl.title,
                    hits: keywordHits([["标题", tmpl.title], ["subtitle", tmpl.subtitle || ""], ["synopsis", tmpl.synopsis || ""], ["storyText", tmpl.storyText || ""], ["标签", (tmpl.tags || []).join("、")], ["aiInstruction", tmpl.aiInstruction || ""], ["openingHtml", tmpl.openingHtml || ""]], keyword),
                };
            })
            .filter((r) => !r.hits || r.hits.length > 0);
        total += theaterHits.length;
        lines.push(`本机测试剧场（${keyword ? `命中 ${theaterHits.length}/${theaters.length} 个` : `${theaters.length} 个`}）：${theaterHits.length ? theaterHits.map((r) => `${r.item}${hitMark(r.hits)}`).join("、") : "无"}`);

        if (keyword) {
            lines.unshift(`【关键词「${keyword}」命中 ${total} 条】`);
        }
        lines.push("用「读取」查看某条内容的完整源码；小改用「编辑」（find/replace），大改/新写用「写入」，写完「发布」。");
        return lines.join("\n");
    },
};

// ── 导出文件（分享给别人）──

const exportContentTool: QaContentTool = {
    name: "导出文件",
    nativeName: "export_local_content",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater"], description: "内容类型" },
            name: { type: "string", description: "APP 名 / 游戏草稿标题 / 剧场草稿标题" },
        },
        required: ["type", "name"],
    },
    description:
        "把一条本机内容导出为文件下载（blob 下载，不刷新页面），用户可发给别人导入：APP 导出市场同款 zip 安装包（对方从应用市场上传导入）；游戏/剧场导出草稿 JSON（对方从草稿箱「从文件导入」）。游戏/剧场只支持草稿——本机测试内容先用对应的存草稿工具转成草稿再导出。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater",
        "    · name (必填) — APP 名 / 游戏草稿标题 / 剧场草稿标题",
        '  调用：[执行动作:导出文件({"type":"app","name":"番茄钟"})]',
    ],
    async run(args) {
        const type = text(args.type, 20);
        const name = text(args.name, 80);
        if (!name) return "缺少 name。先用「清单」看看本机有什么。";
        try {
            if (type === "app") {
                const app = loadInstalledCustomApps().find((item) => norm(item.name) === norm(name));
                if (!app) return `没找到名为「${name}」的本机 APP。用「清单」核对名称。`;
                const denial = await denyIfOthersMarketApp(app, "导出安装包");
                if (denial) return denial;
                const file = await createCustomAppPackageFile(app);
                await downloadFile(file, file.name);
                return `已导出「${app.name}」安装包（${file.name}）。对方在 应用市场 → 发布 → 上传安装包 即可导入。`;
            }
            if (type === "game") {
                const draft = loadGameDrafts().find((item) => norm(item.title) === norm(name));
                if (!draft) return `游戏草稿箱里没有「${name}」。如果它在本机测试里，先用「编辑」改一处（会自动转成草稿）再导出。`;
                const payload = { type: "ai-phone-game-draft", version: 1, title: draft.title, draft: draft.draft };
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
                await downloadFile(blob, `${draft.title.trim() || "游戏草稿"}.json`);
                return `已导出游戏草稿「${draft.title}」。对方在 游戏大厅 → 创作工坊 → 创建页 →「上传 HTML / 草稿」选择该文件即可导入。`;
            }
            if (type === "theater") {
                const draft = loadBmDrafts().find((item) => norm(item.title) === norm(name));
                if (!draft) return `剧场草稿箱里没有「${name}」。如果它在本机测试里，先用「编辑」改一处（会自动转成草稿）再导出。`;
                const payload = { type: "ai-phone-theater-draft", version: 1, title: draft.title, draft: draft.draft };
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
                await downloadFile(blob, `${draft.title.trim() || "剧场草稿"}.json`);
                return `已导出剧场草稿「${draft.title}」。对方在 黑市 → 工作室 → 创建发布 →「导入草稿文件」选择该文件即可导入。`;
            }
            return "type 需为 app / game / theater 之一。";
        } catch (error) {
            return `导出失败：${error instanceof Error ? error.message : String(error)}`;
        }
    },
};

// ── 统一工作台（清单/读取/写入/编辑/发布 的本机半边）──────
// 供 qa-agent-tools 的统一 CRUD 工具路由调用：按 type+name+field 寻址草稿字段，
// 允许逐字段建草稿（发布时才校验必填），并支持对草稿/暂存/已装 APP 的 find/replace 编辑。

type WbContext = { signal?: AbortSignal; onContentCreated?: (item: QaCreatedContent) => void };

const WB_FIELD_CHAR_LIMIT = 2_000_000;

/** game 对外字段名 → 草稿内部字段 */
const GAME_FIELD_MAP: Record<string, keyof GameTemplateDraft> = {
    gameHtml: "gameHtml",
    pickerHtml: "pickerHtml",
    roleSlots: "roleSlotsText",
    subtitle: "subtitle",
    synopsis: "synopsis",
    playNote: "playNote",
    tags: "tagsText",
};

/** theater 对外字段名 → 草稿内部字段 */
const THEATER_FIELD_MAP: Record<string, string> = {
    openingHtml: "openingHtml",
    aiInstruction: "aiInstruction",
    outputContract: "outputContract",
    renderRules: "renderRulesText",
    renderCss: "renderCss",
    memorySummaryPrompt: "memorySummaryPrompt",
    subtitle: "subtitle",
    synopsis: "synopsis",
    storyText: "storyText",
    tags: "tagsText",
};

const EMPTY_GAME_DRAFT: Omit<GameTemplateDraft, "title"> = {
    codeName: "QA", subtitle: "", synopsis: "", playNote: "", coverImage: "",
    tagsText: "互动", authorName: "工坊", roleSlotsText: "[]", pickerHtml: "", gameHtml: "",
    allowExternalControl: false,
};

const EMPTY_THEATER_DRAFT: Record<string, unknown> = {
    codeName: "QA", subtitle: "", synopsis: "", storyText: "", tagsText: "",
    price: "0", authorName: "工坊", openingHtml: "", allowExternalControl: false,
    aiInstruction: "", outputContract: "", renderRulesText: "[]", renderCss: "", memorySummaryPrompt: "",
};

function applyReplace(baseText: string, find: string, replace: string, all: boolean): { next: string; count: number } | { error: string } {
    const count = baseText.split(find).length - 1;
    if (count === 0) return { error: "找不到 find 片段。先用「读取」核对原文（空格与换行须完全一致）。" };
    if (count > 1 && !all) return { error: `find 片段匹配了 ${count} 处。加长片段使其唯一，或加 all:true 替换全部。` };
    return { next: all ? baseText.split(find).join(replace) : baseText.replace(find, replace), count: all ? count : 1 };
}

/** 找游戏草稿；只有本机测试时自动物化成草稿（编辑已装内容的前置步骤） */
function findOrMaterializeGameDraft(name: string): { record: GameHallDraft; materialized: boolean } | { error: string } {
    const existing = loadGameDrafts().find((item) => norm(item.title) === norm(name));
    if (existing) return { record: existing, materialized: false };
    const installed = loadGameState().installedGames
        .find((g) => isLocalTestGameId(g.localId) && norm(g.templateSnapshot.title) === norm(name));
    if (!installed) return { error: `草稿箱和本机测试里都没有「${name}」。先用「清单」确认名称。` };
    const t = installed.templateSnapshot;
    const now = new Date().toISOString();
    return {
        materialized: true,
        record: {
            id: `qa_draft_${stableSlug(t.title)}`,
            title: t.title,
            draft: {
                title: t.title, codeName: t.codeName || "QA", subtitle: t.subtitle, synopsis: t.synopsis,
                playNote: t.playNote, coverImage: t.coverImage || "", tagsText: t.tags.join(" "),
                authorName: t.authorName || "工坊", roleSlotsText: JSON.stringify(t.roleSlots),
                pickerHtml: t.pickerHtml, gameHtml: t.gameHtml, allowExternalControl: t.allowExternalControl,
            },
            createdAt: now,
            updatedAt: now,
        },
    };
}

/** 找剧场草稿；只有本机测试时自动物化成草稿 */
function findOrMaterializeTheaterDraft(name: string): { record: BmStudioDraftRecord; materialized: boolean } | { error: string } {
    const existing = loadBmDrafts().find((item) => norm(item.title) === norm(name));
    if (existing) return { record: existing, materialized: false };
    const owned = loadBlackMarketState().ownedTheaters
        .find((t) => isLocalTestTheaterId(t.localId) && norm(t.templateSnapshot.title) === norm(name));
    if (!owned) return { error: `草稿箱和本机测试里都没有「${name}」。先用「清单」确认名称。` };
    const t = owned.templateSnapshot;
    const now = new Date().toISOString();
    return {
        materialized: true,
        record: {
            id: `qa_draft_${stableSlug(t.title)}`,
            title: t.title,
            draft: {
                title: t.title, codeName: t.codeName || "QA", subtitle: t.subtitle, synopsis: t.synopsis,
                storyText: t.storyText, tagsText: t.tags.join(","), price: "0", authorName: t.authorName || "工坊",
                openingHtml: t.openingHtml, allowExternalControl: t.allowExternalControl,
                aiInstruction: t.aiInstruction, outputContract: t.outputContract,
                renderRulesText: JSON.stringify(t.renderRules), renderCss: t.renderCss,
                memorySummaryPrompt: t.memorySummaryPrompt,
            },
            createdAt: now,
            updatedAt: now,
        },
    };
}

function saveGameDraftRecord(record: GameHallDraft, draft: GameTemplateDraft): void {
    const now = new Date().toISOString();
    const next: GameHallDraft = {
        ...record,
        draft,
        hasUnpublishedChanges: record.publishedTemplateId ? true : record.hasUnpublishedChanges,
        updatedAt: now,
    };
    saveGameDrafts([next, ...loadGameDrafts().filter((item) => item.id !== record.id)]);
}

function saveBmDraftRecord(record: BmStudioDraftRecord, draft: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const next: BmStudioDraftRecord = {
        ...record,
        draft,
        hasUnpublishedChanges: record.sourceTemplateId ? true : record.hasUnpublishedChanges,
        updatedAt: now,
    };
    saveBmDrafts([next, ...loadBmDrafts().filter((item) => item.id !== record.id)]);
}

/** 统一「写入」的 game/theater 半边：按字段写草稿，允许逐字段建稿、append 分段追加 */
export async function workbenchWriteLocal(args: Record<string, unknown>): Promise<string> {
    const type = text(args.type, 20);
    const name = text(args.name, 80);
    const content = typeof args.content === "string" ? args.content : "";
    const append = args.append === true;
    if (!name) return "写入 game/theater 需要 name（草稿标题）。";
    if (!content) return "缺少 content。";

    if (type === "game") {
        const key = text(args.field, 40) || "gameHtml";
        const mapped = GAME_FIELD_MAP[key];
        if (!mapped) return `game 没有字段「${key}」。可用：${Object.keys(GAME_FIELD_MAP).join("、")}。`;
        if (key === "roleSlots") {
            try { if (!Array.isArray(JSON.parse(content))) throw new Error(); } catch { return "roleSlots 需为 JSON 数组文本，如 [{\"id\":\"hero\",\"label\":\"主角\"}]。"; }
        }
        const drafts = loadGameDrafts();
        const existing = drafts.find((item) => norm(item.title) === norm(name));
        const base: GameTemplateDraft = existing?.draft ?? { title: name, ...EMPTY_GAME_DRAFT };
        const prev = String(base[mapped] ?? "");
        const next = append ? prev + content : content;
        if (next.length > WB_FIELD_CHAR_LIMIT) return `${key} 超过 ${WB_FIELD_CHAR_LIMIT.toLocaleString()} 字符上限。`;
        const now = new Date().toISOString();
        const record: GameHallDraft = existing ?? { id: `qa_draft_${stableSlug(name)}`, title: name, draft: base, createdAt: now, updatedAt: now };
        saveGameDraftRecord(record, { ...base, title: name, [mapped]: next });
        return `✓ 已写入游戏草稿「${name}」的 ${key}（当前 ${next.length.toLocaleString()} 字符${append ? "，本次为追加" : ""}）。继续写其他字段或分段追加；全部写完后用「发布」type=game 装进本机测试。`;
    }

    if (type === "theater") {
        const key = text(args.field, 40) || "openingHtml";
        const mapped = THEATER_FIELD_MAP[key];
        if (!mapped) return `theater 没有字段「${key}」。可用：${Object.keys(THEATER_FIELD_MAP).join("、")}。`;
        if (key === "renderRules") {
            try { if (!Array.isArray(JSON.parse(content))) throw new Error(); } catch { return "renderRules 需为 JSON 数组文本。"; }
        }
        const drafts = loadBmDrafts();
        const existing = drafts.find((item) => norm(item.title) === norm(name));
        const base: Record<string, unknown> = existing?.draft ?? { title: name, ...EMPTY_THEATER_DRAFT };
        const prev = String(base[mapped] ?? "");
        const next = append ? prev + content : content;
        if (next.length > WB_FIELD_CHAR_LIMIT) return `${key} 超过 ${WB_FIELD_CHAR_LIMIT.toLocaleString()} 字符上限。`;
        const now = new Date().toISOString();
        const record: BmStudioDraftRecord = existing ?? { id: `qa_draft_${stableSlug(name)}`, title: name, draft: base, createdAt: now, updatedAt: now };
        saveBmDraftRecord(record, { ...base, title: name, [mapped]: next });
        return `✓ 已写入剧场草稿「${name}」的 ${key}（当前 ${next.length.toLocaleString()} 字符${append ? "，本次为追加" : ""}）。继续写其他字段或分段追加；全部写完后用「发布」type=theater 上架本机测试。`;
    }

    return "type 需为 game / theater（app 走包内 path 写入，repo 走仓库路径写入）。";
}

/** 统一「编辑」的本机半边：find/replace 改草稿字段 / 应用暂存文件 / 已装 APP */
export async function workbenchEditLocal(args: Record<string, unknown>, context?: WbContext): Promise<string> {
    const type = text(args.type, 20);
    const name = text(args.name, 80);
    const find = typeof args.find === "string" ? args.find : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    const all = args.all === true;
    if (!find) return "缺少 find（要被替换的原文片段）。";

    if (type === "app") {
        const path = stagePath(args.path);
        if (path && appStaging().has(path)) {
            const staged = appStaging().get(path)!;
            if (staged.text == null) return `${path} 是二进制暂存，不支持编辑。`;
            const result = applyReplace(staged.text, find, replace, all);
            if ("error" in result) return `暂存文件 ${path}：${result.error}`;
            appStaging().set(path, { text: result.next });
            persistAppStaging();
            return `✓ 已替换暂存文件 ${path} 的 ${result.count} 处（现 ${result.next.length.toLocaleString()} 字符）。就绪后「发布」type=app 组包安装。`;
        }
        if (!name) return "编辑 app 需要 name（已装应用名）或 path（暂存文件路径）。";
        const apps = loadInstalledCustomApps();
        const app = apps.find((item) => norm(item.name) === norm(name));
        if (!app) return `没找到已安装应用「${name}」${path ? `，暂存区也没有 ${path}` : ""}。先用「清单」确认。`;
        const denial = await denyIfOthersMarketApp(app, "修改");
        if (denial) return denial;
        const result = applyReplace(app.entryHtml, find, replace, all);
        if ("error" in result) return `应用「${app.name}」：${result.error}`;
        const updated: InstalledCustomApp = {
            ...app,
            entryHtml: result.next,
            hasUnpublishedChanges: app.marketItemId ? true : app.hasUnpublishedChanges,
            updatedAt: new Date().toISOString(),
        };
        await saveInstalledCustomAppsAsync([updated, ...apps.filter((item) => item.id !== app.id)]);
        context?.onContentCreated?.({ type: "app", refId: app.id, title: app.name });
        return `✓ 已修改应用「${app.name}」（替换 ${result.count} 处，立即生效）。请告诉用户可直接打开测试。`;
    }

    if (type === "game") {
        if (!name) return "缺少 name（游戏标题）。";
        const key = text(args.field, 40) || "gameHtml";
        const mapped = GAME_FIELD_MAP[key];
        if (!mapped) return `game 没有字段「${key}」。可用：${Object.keys(GAME_FIELD_MAP).join("、")}。`;
        const found = findOrMaterializeGameDraft(name);
        if ("error" in found) return found.error;
        const base = found.record.draft;
        const result = applyReplace(String(base[mapped] ?? ""), find, replace, all);
        if ("error" in result) return `游戏「${name}」的 ${key}：${result.error}`;
        saveGameDraftRecord(found.record, { ...base, [mapped]: result.next });
        const note = found.materialized ? "（该游戏原本只在本机测试，已自动转为草稿）" : "";
        return `✓ 已替换游戏草稿「${name}」${key} 的 ${result.count} 处${note}。改完用「发布」type=game 重新安装生效。`;
    }

    if (type === "theater") {
        if (!name) return "缺少 name（剧场档案名）。";
        const key = text(args.field, 40) || "openingHtml";
        const mapped = THEATER_FIELD_MAP[key];
        if (!mapped) return `theater 没有字段「${key}」。可用：${Object.keys(THEATER_FIELD_MAP).join("、")}。`;
        const found = findOrMaterializeTheaterDraft(name);
        if ("error" in found) return found.error;
        const base = found.record.draft;
        const result = applyReplace(String(base[mapped] ?? ""), find, replace, all);
        if ("error" in result) return `剧场「${name}」的 ${key}：${result.error}`;
        saveBmDraftRecord(found.record, { ...base, [mapped]: result.next });
        const note = found.materialized ? "（该剧场原本只在本机测试，已自动转为草稿）" : "";
        return `✓ 已替换剧场草稿「${name}」${key} 的 ${result.count} 处${note}。改完用「发布」type=theater 重新上架生效。`;
    }

    return "type 需为 app / game / theater（repo 编辑由仓库路由处理）。";
}

/** 统一「发布」的本机半边：暂存组包 / 单文件安装 / 草稿安装上架 */
export async function workbenchPublishLocal(args: Record<string, unknown>, context?: WbContext): Promise<string> {
    const type = text(args.type, 20);
    const name = text(args.name, 80);
    const findTool = (native: string) => QA_CONTENT_TOOLS.find((tool) => tool.nativeName === native)!;

    if (type === "app") {
        if (args.clear === true) return findTool("install_staged_app").run({ clear: true }, context);
        if (appStaging().has("manifest.json")) return findTool("install_staged_app").run({}, context);
        // 单文件应用：暂存里的 index.html（或唯一的 .html）+ name 走单文件安装
        const htmlEntries = [...appStaging().entries()].filter(([p, f]) => p.endsWith(".html") && f.text != null);
        const html = appStaging().get("index.html")?.text ?? (htmlEntries.length === 1 ? htmlEntries[0][1].text : undefined);
        if (html != null) {
            if (!name) return "单文件应用发布需要 name（应用名）。";
            const result = await findTool("install_local_app").run(
                { name, html, description: args.description, permissions: args.permissions },
                context,
            );
            if (result.startsWith("✓")) {
                appStaging().clear();
                persistAppStaging();
            }
            return result;
        }
        return `应用暂存区没有可发布的内容（当前：${stagingSummary()}）。先用「写入」type=app 写 index.html（单文件）或 manifest.json + 入口 HTML（完整包）。`;
    }
    if (type === "game") {
        if (!name) return "缺少 name（草稿标题）。";
        return findTool("install_local_game").run({ title: name, fromDraft: true }, context);
    }
    if (type === "theater") {
        if (!name) return "缺少 name（草稿标题）。";
        return findTool("install_local_theater").run({ title: name, fromDraft: true }, context);
    }
    return "type 需为 app / game / theater（repo 由仓库路由处理）。";
}

/** 应用暂存区状态（统一「清单」附加显示用） */
export function getAppStagingNote(): string {
    return `应用暂存区：${stagingSummary()}`;
}

/** 读取应用暂存区文件（分页）：分段写大文件时核实进度/续写衔接用 */
export function readStagedAppFile(pathArg: unknown, pageArg: unknown, startArg?: unknown, endArg?: unknown): string {
    const path = stagePath(pathArg);
    if (!path) return "缺少 path。";
    const staged = appStaging().get(path);
    if (!staged) return `应用暂存区里没有 ${path}。当前：${stagingSummary()}`;
    if (staged.base64 != null) return `${path} 是二进制暂存（base64 ${staged.base64.length.toLocaleString()} 字符），不支持读取内容。`;
    const content = staged.text ?? "";
    const start = typeof startArg === "number" && Number.isFinite(startArg) ? Math.max(1, Math.floor(startArg)) : null;
    const end = typeof endArg === "number" && Number.isFinite(endArg) ? Math.floor(endArg) : null;
    if (start != null || end != null) {
        const lines = content.split("\n");
        const from = start ?? 1;
        const to = Math.min(lines.length, end ?? lines.length);
        const numbered = lines.slice(from - 1, to).map((line, i) => `${from + i}\t${line}`).join("\n");
        const body = `暂存文件 ${path}（共 ${lines.length} 行，显示 ${from}-${to}）：\n${numbered}`;
        const limit = getQaPageChars();
        return body.length > limit ? `${body.slice(0, limit)}\n…（已截断，缩小行范围继续读）` : body;
    }
    return paginate(content, pageArg, `暂存文件 ${path}`);
}

export const QA_CONTENT_TOOLS = [
    contentGuideTool,
    listContentTool,
    readContentTool,
    installAppTool,
    stageAppFileTool,
    installStagedAppTool,
    installGameTool,
    installTheaterTool,
    saveGameDraftTool,
    saveTheaterDraftTool,
    exportContentTool,
];
