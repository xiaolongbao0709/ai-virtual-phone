# 微信云端助手部署指南

把微信自动回复托管到你自己的 Supabase 项目里：pg_cron 每分钟触发一次 Edge Function，
函数内部每 ~12 秒子轮询一轮，拉取微信消息、调用角色绑定的模型 API 回复。电脑关机也能 24 小时自动回复，全程免费额度内。

核心逻辑与本地助手是同一份代码（`tools/weixin-local-assistant/assistant-core.mjs`），
两者共用 Supabase 里的防重复锁，可以同时开启互为备份。

## 前提

- 已在小手机「数据管理」配置并测试过 Supabase 云端备份；
- 已添加并启用至少一个微信 Bot。

## 用户部署步骤（小手机内引导，约 2 分钟）

1. **一键部署**：到 supabase.com → Account Settings → Access Tokens 生成一个
   Access Token，粘贴到小手机「微信云端助手」步骤①，点「一键部署」。小手机会
   通过 Supabase 管理 API（等价于 `supabase functions deploy --use-api`）创建
   `weixin-assistant` 函数并直接指定 `verify_jwt=false`，用户无需进入代码编辑器、
   也无需手动关 JWT。Token 仅本次请求使用，不持久化。
   - 手动兜底：步骤①里可展开「手动部署方式」（Via Editor 粘贴 + Settings 关
     「Verify JWT with legacy secret」），适合不想生成 Token 的用户。
   - 函数用小手机生成的定时任务密钥做校验（与离线推送函数同一套做法），
     密钥存在用户自己的备份桶 `weixin-cloud/cron-secret.json`。
2. 点「开启云端轮询」：云函数直连数据库（平台注入的 `SUPABASE_DB_URL`）执行
   `cron.schedule`，创建每分钟一次的定时任务（函数内部子轮询保持 ~12 秒响应节奏），
   并顺带挂一个每日清理 `cron.job_run_details` 旧日志的任务。失败时可用「手动方式：复制
   定时 SQL」到 SQL Editor 执行——SQL 已自动填好项目 URL 与密钥。
3. 点「云端测试一次」验证部署；「刷新云端心跳」可查看最近一次轮询时间与错误。

## 停用

小手机「微信云端助手」心跳行右侧的电源按钮即可在线停用（云函数执行
`cron.unschedule`，停用后零配额消耗）。手动方式：SQL Editor 执行：

```sql
select cron.unschedule('ai-phone-weixin-assistant');
```

## 自更新机制

云函数是「加载器 + 内置逻辑」结构：每次运行优先动态加载备份桶里的
`weixin-cloud/function-core.mjs`（小手机每次同步运行包时自动上传的最新
`assistant-core.mjs`，60 秒内存缓存），加载失败回退到函数内置的拼接版本。
因此**函数只需部署一次**，后续核心逻辑更新随小手机同步自动生效；只有
HTTP 入口层（cloud-function-wrapper.mjs）本身变更时才需要重新粘贴部署。
心跳与轮询响应里的 `codeSource` 字段标明当前用的是 bucket 还是 bundled 版本。

## 运行细节

- **冷启动**：Bot 长时间无人轮询时，微信服务器会把它标记为离线（微信里显示
  「暂无法连接」）。刚部署或停用较久后重新开启定时任务时，微信侧需要几分钟才把
  Bot 恢复为在线并把消息路由到轮询通道——恢复期内第一条回复可能延迟数分钟，
  且**离线期间收到的消息不会补发**（新轮询游标收不到历史消息）。恢复后回复
  稳定在 10～60 秒。这是微信侧的行为，与 Supabase 无关（Edge Function 本身的
  冷启动只有约 20ms）。
- **提示词等价性**：运行包里的轻量模板（v2）把「已烘焙历史」和「深度注入」分别切成段
  下发。助手把烘焙历史与新微信消息接成一条完整历史，再把世界书 `position=4`、预设
  `injection_position≠0` 的条目重新定位到「倒数第 N 条」之前，而不是沿用同步那一刻
  算好的位置；组装完合并相邻同 role 消息，轮次粒度与小手机一致。
  仓库里有一组等价性测试，逐条比对「小手机拿到完整历史的组装结果」与「助手用模板
  重组的结果」，覆盖不同烘焙历史长度、注入深度与连续同 role 消息序列。
  老运行包（v1）没有这些字段时助手自动退回旧行为，**升级后需要在小手机里重新同步
  一次运行包才生效**。同步会顺带把新的 `assistant-core.mjs` 推到桶里，云函数下一轮
  自动加载，无需重新部署。
- **长按编辑已拉回的回复**：编辑会就地覆盖同一条云消息，并触发一次运行包重新同步。
  两步都必要——只改云对象的话，那条回复如果已经烘焙进当前运行包，助手会因为它的
  时间戳早于运行包生成时刻而在历史过滤阶段跳过云对象，只看到模板里的旧版本。
- **已知限制**：世界书的关键词激活仍在同步时一次性算完。微信后续消息里出现的新关键词
  不会在云端触发新条目——v2 只解决了「已激活条目的位置」。要动态激活得把词条与匹配
  逻辑一起下发到云端，暂未做。
- **时间戳**：新微信消息的时间按运行包下发的 `promptTimeZone`（用户设备时区）标注，
  与烘焙进模板的小手机历史时间戳同一套钟——云函数本身跑在 UTC。模型仿写出来的
  时间戳由 `cleanReplyText` 剥掉，正则与小手机 `stripHallucinatedTimestamps` 保持一致
  （兼容全角括号、带秒、带时区/星期尾巴）。
- 触发频率每分钟一次、函数内部 ~12 秒子轮询（约 4.3 万次调用/月，仅占 Edge Functions
  免费档 50 万次的 9%；旧版 10 秒直触发是 26 万次/月）。核心代码自更新带 ETag 条件
  请求与 5 分钟缓存、部署密钥 10 分钟缓存、空闲兜底全量扫描 30 分钟一次，均为降低
  用户项目的 Storage egress。
- **旧部署升级**：入口层（轮询节奏、缓存）需要重新「一键部署」+ 重新点「开启云端轮询」
  才生效；核心逻辑的省流改动（兜底扫描降频）随小手机同步运行包自动生效，无需重部署。
- 单次调用有 120 秒时间预算（`CLOUD_POLL_BUDGET_MS`），预算耗尽时剩余 Bot 留给下一轮；
  长回复被平台掐断也安全——消息标记与锁保证下一轮重试，不会漏回。
- 并发安全：pg_cron 触发重叠、或与本地助手同时在跑时，`weixin-cloud/locks/` 下的
  自动回复锁保证同一个 Bot 同时只有一个实例在回复。
- 心跳：每次运行后写 `weixin-cloud/state/cloud-assistant.json`
  （lastRunAt / lastError / 轮询统计），小手机据此显示云端状态。
- 收到的图片：助手会从微信 CDN 下载并按上传路径的逆操作 AES-128-ECB 解密，
  存到桶里 `weixin-cloud/media/<botId>/<externalId>`，消息里记 `imagePath/imageMime`；
  API 配置开启图像识别（`enableImageRecognition` → 运行包 `promptContext.enableVision`）
  时，按会话的传入图片数（`session.visionImagePromptLimit`，默认 1，只取最近 N 张）
  以 `image_url` 多模态内容交给模型；小手机拉取时把图片转回 data URL 以图片气泡展示。
  下载/解密失败时降级为「[对方发来一张图片，但未能下载查看]」占位文本（仍会触发回复）。
  注意：下载端点是按上传协议推断的（`/download?encrypted_query_param=`），需线上实测。
  收到的语音/文件暂以占位文本提示。
- 发出的媒体：云端与本地一致，支持生图照片（遵循小手机「图像生成」设置）、
  表情包与语音卡。开关由运行包 `promptContext.mediaReply` 下发（当前恒为 true，
  旧运行包未带该字段时保持文字降级；请求体 `"media": true` 可强制开启）。
  生图/TTS 超时压缩到 90s/60s 以适配云函数 120s 单轮预算；首条分段送达后
  立即标记已回复，函数被平台掐断时最多丢失后续分段、不会整段重发。
- Token 过期：微信 bot token 过期后云端无法续期，仍需用户回小手机重新扫码；
  心跳里会带出「Token 已过期」错误。

## 开发者自测

```bash
npm run weixin:build-dist          # 源文件改动后重新生成分发文件
supabase functions deploy weixin-assistant --no-verify-jwt   # 用 CLI 部署到自己项目
```

生成的单文件云函数在 `public/weixin-local-assistant/cloud-function.mjs` 与
`supabase/functions/weixin-assistant/index.ts`，两者内容相同，请勿手工编辑
（构建脚本会覆盖）。
