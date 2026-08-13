# 资源集市（Resource Hub）

小手机内置的社区资源市场。**后端是公开 GitHub 仓库 `xiaolongbao0709/ai-virtual-phone-share`**，浏览走 jsDelivr CDN（国内可达、免限流、免费），导入直接写进本机存储 —— 全程不经过自建服务器。

- 前端：桌面「资源集市」App（`components/resource-hub/resource-hub-app.tsx`），复古 Windows 风格
- 客户端：`lib/resource-hub-client.ts`（CDN 三镜像回退 + 索引 + 各目的地导入）
- 资源仓库地址可在 App 标题栏 ⚙ 里更换

## 仓库结构：完全自由

**前端不预设任何文件夹** —— 仓库根目录建什么文件夹，市场首页（仿文件管理器，一行两个）就显示什么。分类下每个**子文件夹**或**孤立文件**是一条资源：

```
ai-virtual-phone-share/
├── _index.json            ← 时间索引，Actions 自动生成，勿手改
├── 预设/
│   ├── 日常向预设/         ← 子文件夹式资源
│   │   ├── 日常向.json      ← 本体（可多个）
│   │   ├── 说明.txt         ← 可选：说明（论坛列表显示摘要）
│   │   └── 封面.jpg         ← 可选：图片（列表显示第一张）
│   └── 极简预设.json       ← 孤立文件式资源（纯文字条目）
└── 随便新建的分类/          ← 前端自动出现
```

文件夹页为古早论坛式列表，按 `_index.json` 里的更新时间倒序（索引由 Actions 用 `git log` 生成；索引不可用时前端退化为 jsDelivr data API 现场扫树，无时间与说明）。

## 下载与导入

资源详情页每个文件有两个动作：

- **下载**：原文件下载到本机
- **导入**：弹出目的地选择，直接落库：

| 目的地 | 接受文件 | 落点 |
|---|---|---|
| 预设 / 正则 / 世界书 | JSON | 对应管理页列表 |
| 角色卡 | JSON / PNG | 角色库 |
| 聊天室自定义CSS | CSS/TXT | **需选角色** → 直接应用到该角色聊天室，并存入方案库 |
| 聊天主页自定义CSS | CSS/TXT | 直接应用 + 存方案库 |
| 全局自定义CSS | CSS/TXT | 应用到外观页全局样式 + 存方案库 |
| 应用 | zip / 单 HTML | 应用市场同款安装（桌面自动出图标） |
| 游戏 | 草稿 JSON（`ai-phone-game-draft`） | 游戏草稿箱 |
| 黑市剧场 | 草稿 JSON（`ai-phone-theater-draft`） | 黑市工作室草稿箱 |
| 插件 | JS 源码 | 聊天插件（同 id 覆盖升级） |

## 资源仓库侧（ai-virtual-phone-share 内自带）

- `README.md`：投稿约定
- `scripts/build-index.mjs` + `.github/workflows/build-index.yml`：push 后自动重建 `_index.json`（fetch-depth 0 取真实更新时间；bot 提交自动跳过防死循环）

## 运营流程

- **投稿**：PR 往分类文件夹加子文件夹（本体 + 可选 说明.txt + 可选图片）
- **上架**：merge PR（Actions 自动重建索引）；**下架**：删文件 merge；**回滚**：revert
- **CDN 缓存**：jsDelivr 对 `@main` 最长缓存约 12 小时；急刷访问
  `https://purge.jsdelivr.net/gh/xiaolongbao0709/ai-virtual-phone-share@main/_index.json`

## 体积约束

jsDelivr 单文件上限 20MB；图片建议单张 ≤ 300KB。

## 应用内上传

工具条「上传」按钮：填分类（可新建）/名称/说明 + 选文件与配图。提交走两条链路之一：

- **配了 GitHub Token**（标题栏 ⚙ 里填）：有仓库写权限的 token 直接提交 main 立即上架；普通用户 token 自动 fork + 开 PR 待审核
- **没配 Token**：匿名 POST 到独立部署的上传服务（share 仓库 `netlify/functions/upload.mjs`，从该仓库单独建 Netlify 站点 + 配 `SHARE_BOT_TOKEN` 环境变量），由机器人代开 PR 待审核。默认地址 `https://floatshare.netlify.app/.netlify/functions/upload`，设置里可改

安全设计：匿名与普通用户的提交都只生成 PR，管理员 merge 才上架；上传服务含单文件/总量体积限制（≤5MB）与 IP 频控。上传服务与主站部署完全隔离。

投稿前建议先阅读 share 仓库 `README.md` 的投稿约定，确保目录结构与命名规范一致，便于管理员快速审核合并。
