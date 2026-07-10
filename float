# AI Virtual Phone

一个基于 Next.js 的 AI 虚拟互动手机：在浏览器中模拟一部完整的手机，支持与你创建的 AI 角色进行仿真聊天、朋友圈互动与剧情创作。

主要功能：

- 仿真聊天：私聊 / 群聊 / 朋友圈 / 语音消息 / 转账红包卡片，AI 角色有作息、记忆和长期关系
- 创作系统：角色卡、世界书、预设、正则，附带桌面 AI 助手「小卷」帮你写这些内容
- 剧情玩法：剧情模式、视觉小说、查手机、访谈、地图冒险、日记、便签墙
- 扩展生态：应用市场（用 SDK 写自定义 APP）、游戏大厅、内置小游戏
- 多媒体：AI 生图、Minimax 语音合成、网易云在线音乐（需自配 API）、3D 世界搭建（Tripo）
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
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | 你自己的 Supabase 项目，启用云端功能时必填（服务端专用，勿放进 NEXT_PUBLIC） |
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

## 启用自己的 Supabase（可选云端功能）

账号、激活码、成年审核、便签墙、游戏大厅、应用市场、黑市等云端功能需要你自己的 Supabase 项目。在 Supabase SQL Editor 按需执行 `docs/` 下的建表脚本：

- `docs/account-supabase.sql`：账号、会话、激活码
- `docs/verify-supabase.sql`：成年审核与审核图片桶（部署说明见 `docs/verify-setup.md`）
- `docs/notewall-supabase.sql`：便签墙
- `docs/game-hall-supabase.sql`：游戏大厅
- `docs/custom-app-market-supabase.sql`：应用市场
- `docs/black-market-supabase.sql`：黑市

然后关闭单机模式并填入服务端密钥：

```env
NEXT_PUBLIC_SELF_HOSTED_MODE=false
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ACCOUNT_GATE_SECRET=your-random-long-secret
```

不要把 `.env.local` 提交到 Git。

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
