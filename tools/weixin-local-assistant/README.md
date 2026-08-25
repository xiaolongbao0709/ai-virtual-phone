# 微信助手（本地 / 云端）

微信自动回复有两种运行方式，共用同一份核心逻辑：

- **本地助手**：在用户自己的电脑上运行，每隔几秒轮询微信消息，读取小手机同步到 Supabase 的运行包，调用角色绑定的模型 API 回复，并把微信消息与回复写回 Supabase。电脑关机即停止。
- **云端助手**：同一套逻辑部署为用户自己 Supabase 项目里的 Edge Function，由 pg_cron 每 10 秒触发一次，不需要电脑常开。可直接在小手机「设置 → 云服务部署」自动创建独立项目并部署，也可按 `docs/weixin-cloud-assistant.md` 手动部署。

## 文件结构

- `assistant-core.mjs` —— 核心逻辑（轮询、组 prompt、调模型、分段、发回微信、防重复锁）。只依赖 fetch 与 `node:crypto` / `node:buffer`，Node 20+ 与 Deno 都能跑。**改行为只改这个文件**，本地版和云端版会同时生效。
- `assistant.mjs` —— 本地 CLI 壳：读 `config.txt`、命令行参数、轮询循环、fs 卡片素材。
- `cloud-function-wrapper.mjs` —— 云函数 HTTP 入口（鉴权、时间预算、心跳回写）。不能单独运行。
- 构建脚本 `scripts/build-weixin-assistant-dist.mjs` 会把上面的文件同步 / 拼接到：
  - `public/weixin-local-assistant/`（供小手机「下载本地助手包」「复制云函数代码」）
  - `supabase/functions/weixin-assistant/index.ts`（供 supabase CLI 部署自测）

改动源文件后运行 `npm run weixin:build-dist`；`npm run build` 也会自动执行。

## 本地助手使用步骤

1. 在小手机的数据管理里配置 Supabase 云端备份。
2. 在小手机微信设置里点击「下载本地助手包」。
3. 解压压缩包，双击 `启动助手.bat`。

开发调试时，也可以在项目根目录运行：

```bash
node tools/weixin-local-assistant/assistant.mjs
```

只测试一次：

```bash
node tools/weixin-local-assistant/assistant.mjs --once
```

更快轮询：

```bash
node tools/weixin-local-assistant/assistant.mjs --interval 3
```

## 注意

- `config.txt` 包含用户自己的 Supabase service_role key，等同私密密钥，不要公开。
- 本地助手在电脑关机、脚本关闭、网络断开时不会继续自动回复；需要 24 小时在线请部署云端助手。
- 本地助手与云端助手共用 Supabase 里的自动回复锁，可同时开启，不会重复回复。
- 角色、API、预设、世界书或记忆改动后，需要重新在小手机里下载本地助手包或同步运行包。
- 本地版与云端版共用状态清理、分段、图片 / 语音等媒体回复和快捷动作续跑逻辑。
