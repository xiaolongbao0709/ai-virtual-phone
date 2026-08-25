# AI Virtual Phone

一个基于 Next.js 的 AI 虚拟互动手机：在浏览器中模拟一部完整的手机，支持与你创建的 AI 角色进行仿真聊天、朋友圈互动与剧情创作。

主要功能：

- 仿真聊天：私聊 / 群聊 / 朋友圈 / 语音消息 / 转账红包卡片，AI 角色有作息、记忆和长期关系
- 创作系统：角色卡、世界书、预设、正则，附带桌面 AI 助手「小卷」帮你写这些内容
- 剧情玩法：剧情模式、视觉小说、查手机、访谈、地图冒险、日记、便签墙
- 扩展生态：应用市场（用 SDK 写自定义 APP）、游戏大厅、内置小游戏
- 多媒体：AI 生图、Minimax 语音合成、网易云在线音乐（需自配 API）、3D 世界搭建（Tripo）
- 个人云：可把云备份、微信助手、离线回复、定时消息、快捷动作与云端来电部署到用户自己的 Supabase
- 现实桥：角色可调用用户映射的 iPhone 快捷指令，并在文本/图片结果回传后继续回复
- 屏幕速聊（iOS）：通过辅助触控截取当前屏幕，在系统弹窗里与角色连续对话，并同步回唯一聊天窗口
- 桌面美化：主题、壁纸、贴纸小组件、自定义 CSS，支持 PWA 安装到手机桌面

所有 LLM 调用都使用**你自己的 API key**，本项目不内置任何模型服务。

## 运行要求

- Node.js 20+（Next.js 15 要求 ≥ 18.18）
- 任意 OpenAI 兼容的 LLM API（OpenAI / DeepSeek / 中转站等），或 Anthropic / Google Gemini 官方 API

## 快速开始（本地运行）

```bash
git clone -b main <repo-url>
cd <repo-dir>
npm install
cp .env.example .env.local
npm run dev
```

浏览器打开 `http://localhost:3001`（默认端口 3001，可用 `PORT` 环境变量修改）。

`.env.example` 已默认开启：

```env
NEXT_PUBLIC_SELF_HOSTED_MODE=true
```

这个模式跳过账号/激活码门禁，用本地单机账号直接进入，适合个人使用。其余环境变量全部可选，功能按需启用（见下表）。

## 首次使用

进入应用后只差一步就能开聊：

1. 打开**设置 → API 设置**，添加你的 LLM API（填 Base URL + API Key，支持 OpenAI 兼容接口、Anthropic、Google Gemini）；
2. 创建或导入角色卡，开始聊天；
3. 可选：在设置里继续配置生图、Minimax 语音、网易云音乐 API 等增强功能。

## 部署到 Netlify / Vercel

两个平台都可以直接导入本仓库部署：

1. 新建站点 / 项目，关联你 fork 或 clone 的仓库，选择 `main` 或 `test` 分支；
2. 构建设置保持默认即可（Netlify 会自动读取仓库里的 `netlify.toml`；Vercel 自动识别 Next.js）；
3. **在平台后台添加环境变量**（平台不会读取仓库里的 `.env.example`）：

   ```env
   NEXT_PUBLIC_SELF_HOSTED_MODE=true
   ```

4. 部署完成后打开站点，按「首次使用」配置即可。

## 环境变量总表

除 `NEXT_PUBLIC_SELF_HOSTED_MODE` 外全部可选，不填时对应功能自动隐藏或停用。

| 变量 | 用途 |
|---|---|
| `NEXT_PUBLIC_SELF_HOSTED_MODE` | `true`=单机模式（推荐自部署开启）；`false`=启用账号/激活码门禁（需配 Supabase） |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | 站点账号、社区功能和现实桥邮件自动化使用的 Supabase 项目（服务端专用，勿放进 NEXT_PUBLIC）；应用内创建的个人云不需要把密钥填到这里 |
| `MIXOLOGY_SUPABASE_URL` / `MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY` | 独家特调专用的独立 Supabase 项目（酒材/配方/点赞/入柜/评论）。特调数据只走这里，不填则特调云端不开张，不会回退主库 |
| `ACCOUNT_GATE_SECRET` | 账号门禁签名密钥，启用账号系统时设为随机长字符串 |
| `VERIFY_ADMIN_KEY` | 成年审核/激活码管理后台密钥 |
| `APP_MARKET_ADMIN_KEY` | 应用市场审核后台密钥（不填回退用 `VERIFY_ADMIN_KEY`） |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 便签墙实时刷新用（anon key 本身可公开） |
| `NEXT_PUBLIC_IMAGE_GEN_PROXY_URL` | 通用生图代理地址，需自己部署代理服务 |
| `NEXT_PUBLIC_DEFAULT_NETEASE_API_BASE` | 网易云音乐 API 默认地址（NeteaseCloudMusicApi 兼容实例，请自行部署）。留空时在线音乐隐藏，用户也可在音乐 APP 设置里自填 |
| `NEXT_PUBLIC_NETEASE_REAL_IP` | 网易云 API 的 X-Real-IP 参数（海外部署解锁地区限制用） |
| `TRIPO_API_KEY` | 可选的服务端兜底，一般不用填——用户在世界搭建界面内自行填写 Tripo key |
| `IMGBB_API_KEY` | 可选的服务端兜底，一般不用填——用户在应用内生图/图床设置里自行填写 |
| `WEIXIN_PROXY` | 微信本地助手代理，见 `tools/weixin-local-assistant/README.md` |
| `RESEND_API_KEY` / `REALITY_BRIDGE_EMAIL_FROM` / `SHORTCUT_EMAIL_VERIFICATION_SECRET` | 可选的现实桥“邮件自动”实验通道；普通推送快捷动作不需要 |

## 启用自己的 Supabase（可选云端功能）

账号、激活码、成年审核、便签墙、游戏大厅、应用市场、黑市等云端功能需要你自己的 Supabase 项目。推荐在 Supabase SQL Editor 直接执行 `docs/supabase-all-in-one.sql` 一键建齐全部云端功能（幂等脚本，重复执行不会破坏已有数据；粘贴后先确认最后一行是「全部结束」标记再 Run，防止复制被截断）。也可按需执行下列单个脚本：

- `docs/account-supabase.sql`：账号、会话、激活码
- `docs/verify-supabase.sql`：成年审核与审核图片桶（部署说明见 `docs/verify-setup.md`）
- `docs/notewall-supabase.sql`：便签墙
- `docs/game-hall-supabase.sql`：游戏大厅
- `docs/custom-app-market-supabase.sql`：应用市场
- `docs/black-market-supabase.sql`：黑市
- `docs/online-play-supabase.sql`：多人联机（自定义APP/游戏的实时房间与云端共享，可选；不在一体脚本内，需单独执行）
- `docs/moderation-supabase.sql`：内容管理（举报/管理员/下架/封号，可选；执行后用 SQL 把自己的账号 role 设为 admin，即可在 设置 → 管理中心 处理举报）

然后关闭单机模式并填入服务端密钥：

```env
NEXT_PUBLIC_SELF_HOSTED_MODE=false
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ACCOUNT_GATE_SECRET=your-random-long-secret
# 可选：启用多人联机（Project Settings → API 的 anon public key）
SUPABASE_ANON_KEY=your-anon-key
```

不要把 `.env.local` 提交到 Git。

## 个人云、离线推送与微信接入

这套功能不要求站点维护者把所有用户数据放进同一个 Supabase。每位用户可在
**设置 → 云服务部署**里粘贴自己的 Supabase Access Token、选择自己的组织，应用会：

1. 自动创建一个名为 `AI Phone Personal Cloud` 的独立项目；
2. 按用户勾选范围部署云备份、微信 Edge Function、离线推送与快捷动作函数；
3. 把该项目的地址和密钥只保存在用户自己的小手机数据中，Access Token 仅在本次部署请求中透传，不保存；
4. 用项目标记和数据库表检查阻止误装进已有业务库。

个人云与上文的站点运营库是两件事：`SUPABASE_URL` 用于账号、市场等站点级功能；
个人云由用户在界面中创建，默认不会复用或修改站点运营库。自部署者只想个人使用时，
保持 `NEXT_PUBLIC_SELF_HOSTED_MODE=true`，无需先配置站点运营库，也能使用个人云。

部署完成后，在聊天信息页开启「离线推送与定时消息」；微信 Bot 则在
**设置 → 微信接入**中添加。云端与本地使用相同的角色运行包，微信消息、离线回复、
快捷动作结果和来电留痕会按因果顺序合并回小手机。

### iOS 屏幕速聊（辅助触控双击）

屏幕速聊是现实桥的一个 iOS 入口：双击辅助触控悬浮球后，快捷指令截取当前屏幕，
角色的回复直接显示在系统弹窗里；你可以在弹窗中继续回复。每一轮对话都会按顺序写回
该角色原有的唯一聊天窗口，不会每 15/30 轮另开一段会话。

使用前请先在 **设置 → 云服务部署**完成或重新执行一次个人云部署。屏幕速聊要求
个人云 Schema v3；旧版个人云不会被静默复用，页面会提示重新部署。部署完成后：

1. 打开 **现实桥 → 屏幕速聊**，开启功能并选择一个角色；
2. 在第三步点“一键导入屏幕速聊”，导入项目提供的通用 iCloud 快捷指令；
3. 按导入问题填写页面显示的“接口地址”和“令牌”。共享快捷指令本身不包含你的地址、
   令牌或角色资料；
4. 到 iPhone **设置 → 辅助功能 → 触控 → 辅助触控 → 轻点两下**，选择“屏幕速聊”；
5. 首次运行时允许“截屏”“访问网络”和“显示提醒”等系统权限。

如果一键导入不可用，页面仍保留完整的手动搭建步骤。该功能不需要 Resend，也不需要
站点运营库；它只访问用户自己创建的个人云项目。截图原图不会写入 Supabase 数据库或
Storage，只存在于本次 Edge Function 内存和本次模型请求中。个人云仅暂存尚未合并回
小手机的文本轮次；应用启动或从后台回到前台时会立即补拉，而不是持续高频轮询。

### iOS 现实桥：通知点击运行

现实桥默认使用“通知点击运行”：角色触发快捷动作后，个人云向 iPhone 发送系统通知，
用户点击通知即可运行快捷指令。该模式随上面的个人云一起部署，**不需要 Resend**，
也不需要额外的站点 Supabase 环境变量，是推荐的默认选择。

### iOS 现实桥：邮件自动运行（实验）

“邮件自动”利用 iOS 的“收到指定邮件时立即运行”自动化，因此必须有服务负责发送触发
邮件。目前项目使用 [Resend](https://resend.com)：

- 自己部署、自己使用时，由站点主人配置一次 Resend。
- 多人共用一个站点时，由站点运营者配置一次；普通用户只在小手机里验证接收邮箱，
  不需要各自注册 Resend。
- 不配置 Resend 不影响云备份、微信、离线回复或“通知点击运行”，只是邮件模式不可用。

#### 1. 配置 Resend

1. 注册 Resend，在 Domains 中添加自己拥有的域名。推荐使用独立子域名，例如
   `notify.example.com`。
2. 按页面提示添加 DNS 记录，等待状态变成 `Verified`。参见
   [Resend 域名验证文档](https://resend.com/docs/dashboard/domains/introduction)。
3. 在 [Resend API Keys](https://resend.com/api-keys) 创建 API Key。密钥只显示一次，
   请立即保存，不要提交到 Git。

域名验证后可以直接使用该域名下的任意发件地址，例如
`bridge@notify.example.com`，该地址不要求拥有独立收件箱。

#### 2. 配置站点环境变量与数据库

在 Netlify / Vercel 的环境变量中增加：

```env
RESEND_API_KEY=re_xxxxxxxxx
REALITY_BRIDGE_EMAIL_FROM="Float Reality Bridge <bridge@notify.example.com>"
SHORTCUT_EMAIL_VERIFICATION_SECRET=独立随机长字符串
```

可用下面的命令生成验证码签名密钥：

```bash
openssl rand -hex 32
```

以上都是服务端秘密，不要添加 `NEXT_PUBLIC_` 前缀。发件邮箱的域名必须与 Resend
中已经验证的域名一致。

邮件验证记录和邮件型快捷指令目前存放在**站点 Supabase**，不是用户一键创建的个人云。
因此还需要配置：

```env
SUPABASE_URL=https://your-site-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

然后在这个站点 Supabase 项目的 SQL Editor 执行
[`docs/push-supabase.sql`](./docs/push-supabase.sql)，再重新部署站点。若已为账号或其他
站点功能配置过这两个变量，可以继续使用同一个站点项目。不要把 `service_role` 密钥
交给浏览器或写进任何 `NEXT_PUBLIC_*` 变量。

#### 3. 配置 iPhone

1. 打开“现实桥 → iOS 快捷动作”，将送达方式选为“邮件自动（实验）”。
2. 填写 iPhone“邮件”App 能及时收信的邮箱，接收并输入六位验证码。
3. 把页面显示的发件人加入白名单，避免触发邮件进入垃圾箱。
4. 在“快捷指令 → 自动化”中新建“电子邮件”自动化：发件人填写页面显示的地址，
   主题选择“包含”页面显示的主题标记，运行方式选“立即运行”。
5. 自动化动作设置为运行页面生成的快捷指令，并把邮件正文作为快捷指令输入。

为减少延迟，推荐使用在 iPhone 邮件 App 中支持实时推送的 iCloud 或 Exchange 邮箱。
首次运行仍可能要求 iOS 权限确认，部分动作在锁屏状态下也可能受到系统限制，因此该
模式仍标记为实验功能。

维护者修改云函数源文件后运行：

```bash
npm run push:build-dist   # 生成浏览器一键部署包
npm run check:push        # 校验源文件与部署包一致，且不含私有站点地址
npm run weixin:build-dist # 生成微信本地/云端分发包
npm run check:weixin      # 校验微信提示词与分发文件
```

## 分支选择

本仓库长期保留两个设备兼容版本：

- `main`：正常设备版
- `test`：兼容设备版，部分设备全屏或显示异常时部署此分支

## 常用命令

```bash
npm run dev     # 本地开发（端口 3001）
npm run build   # 生产构建
npm run start   # 生产运行
npm run lint    # 代码检查
npm run check:push # 校验个人云部署包
```

## License

本项目采用 GNU Affero General Public License v3.0 only（AGPL-3.0-only）开源。详见 [LICENSE](./LICENSE)。

## Credits

本项目为独立实现，但部分产品设计和系统抽象受 SillyTavern 启发，包括预设、正则处理、世界书 / lorebook / WorldInfo 等概念。

- SillyTavern: https://github.com/SillyTavern/SillyTavern
- SillyTavern 使用 AGPL-3.0 许可证。

字体、贴纸素材、3D 模型等第三方资源的授权说明见 [NOTICE](./NOTICE)。

## 备注

`NEXT_PUBLIC_*` 变量会打包进浏览器代码、完全公开。不要把 Supabase `service_role`、后台管理密钥、第三方 API 私钥写进任何 `NEXT_PUBLIC_*` 变量。
