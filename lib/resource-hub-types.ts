// lib/resource-hub-types.ts
// 资源集市：GitHub 仓库当后端的社区资源市场。
// 仓库文件夹结构完全自由——市场首页显示仓库根目录的文件夹，
// 索引 _index.json 由资源仓库的 GitHub Actions 自动生成（含时间/说明/图片）。

export type ShareIndexFolder = {
    name: string;
    count: number;
};

export type ShareIndexEntry = {
    /** 所属一级文件夹名 */
    folder: string;
    /** 展示名（子文件夹名或文件名去扩展名） */
    name: string;
    /** dir = 子文件夹式资源；file = 孤立文件式资源 */
    type: "dir" | "file";
    /** 仓库相对路径 */
    path: string;
    /** 资源本体文件（不含说明与图片） */
    files: string[];
    /** 图片（仓库相对路径），列表页显示第一张 */
    images: string[];
    /** 说明摘要（来自 说明.txt / README.md） */
    description: string;
    /** 投稿人（来自 .author 文件，可为空） */
    author?: string;
    /** 投稿人头像的仓库路径（.avatar.png，可为空） */
    avatar?: string;
    /** 发布者钥匙的 SHA-256 指纹（.owner 内容），用于换设备认领 */
    ownerHash?: string;
    /** 最近更新时间（ISO），索引生成时来自 git log */
    updatedAt: string | null;
};

export type ShareIndex = {
    schema: "ai_phone_share_index";
    schemaVersion: number;
    generatedAt?: string;
    folders: ShareIndexFolder[];
    entries: ShareIndexEntry[];
};

// ── 图片资源标记 ──────────────────────────────────
// 索引按扩展名分流：图片进 images（详情页直接展示），其余进 files（可选中下载/导入）。
// 但图片本身也可能就是资源——PNG 角色卡、表情包、贴纸——那样它就永远没有下载入口了。
// 投稿人在上传页其实已经分过一次（「选择资源文件」vs「选择配图」），只是这个意图之前
// 没被带上去。现在把用它当资源文件传的图片改名加上 .asset 标记，索引照标记分流。
//
// 标记只加在"图片当资源文件"这一种情况上：没标记的一律沿用旧规则（图片进 images），
// 所以存量资源的展示一个字都不会变。
export const ASSET_IMAGE_MARK = ".asset";
const IMAGE_NAME_RE = /\.(jpe?g|png|webp|gif)$/i;
const ASSET_IMAGE_RE = /\.asset\.[^.]+$/i;

/** 这个文件名是不是"被当成资源文件的图片" */
export function isAssetImageName(name: string): boolean {
    return ASSET_IMAGE_RE.test(name);
}

/** 上传前给图片加标记；非图片、已带标记的原样返回 */
export function markAssetImageName(name: string): string {
    if (!IMAGE_NAME_RE.test(name) || ASSET_IMAGE_RE.test(name)) return name;
    return name.replace(/(\.[^.]+)$/, `${ASSET_IMAGE_MARK}$1`);
}

/** 展示/下载/导入时把标记摘掉，用户看到的是干净的文件名 */
export function stripAssetImageMark(name: string): string {
    return name.replace(/\.asset(\.[^.]+)$/i, "$1");
}

/** 索引分流：true = 进 images（只展示），false = 进 files（可下载可导入） */
export function isPreviewImagePath(name: string): boolean {
    return IMAGE_NAME_RE.test(name) && !ASSET_IMAGE_RE.test(name);
}

export type ResourceHubSource = {
    owner: string;
    repo: string;
    branch: string;
};

export const RESOURCE_HUB_DEFAULT_SOURCE: ResourceHubSource = {
    owner: "xiaolongbao0709",
    repo: "ai-virtual-phone-share",
    branch: "main",
};

/** 导入目的地（用户在导入时选择） */
export type ImportDestination =
    | "preset"
    | "regex"
    | "worldbook"
    | "character"
    | "chat_session_css"
    | "chat_app_css"
    | "global_css"
    | "custom_app"
    | "game"
    | "theater"
    | "plugin"
    | "theme"
    | "preset_entry"
    | "status_bar"
    | "mixology";

export const IMPORT_DESTINATIONS: Array<{ key: ImportDestination; label: string; hint: string }> = [
    { key: "preset", label: "预设", hint: "预设管理页导出的 JSON" },
    { key: "regex", label: "正则", hint: "正则管理页导出的 JSON" },
    { key: "worldbook", label: "世界书", hint: "世界书管理页导出的 JSON" },
    { key: "character", label: "角色卡", hint: "角色卡 JSON 或 PNG" },
    { key: "chat_session_css", label: "聊天室CSS", hint: "需选择应用到哪个角色" },
    { key: "chat_app_css", label: "聊天主页CSS", hint: "应用到聊天主页" },
    { key: "global_css", label: "全局CSS", hint: "应用到外观页全局样式" },
    { key: "custom_app", label: "应用", hint: "应用市场 zip 安装包或单 HTML" },
    { key: "game", label: "游戏", hint: "游戏草稿箱导出的 JSON，导入后进我的柜子直接可玩" },
    { key: "theater", label: "黑市剧场", hint: "剧场草稿箱导出的 JSON，导入后进本地暗柜直接开演" },
    { key: "plugin", label: "插件", hint: "聊天插件 JS 源码文件" },
    { key: "theme", label: "主题包", hint: "外观页导出的主题包 zip" },
    { key: "preset_entry", label: "预设条目", hint: "单条预设条目，插入或覆盖到已有预设" },
    { key: "status_bar", label: "状态栏", hint: "聊天信息页导出的自定义状态栏 JSON，导入后进方案库" },
    { key: "mixology", label: "特调", hint: "独家特调导出的材料或配方文件（JSON/PNG），内容全部自动入柜" },
];
