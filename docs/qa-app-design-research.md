# 内置答疑 App 调研报告（v2.2）

> 调研日期：2026-08-04（v2.2：补充本机测试/试玩基建）
> 目标：为「内置答疑 App」提供两方面调研——①高级感黑灰色系 UI；②AI 连接 GitHub 查阅/修改代码的 Agent 架构。并结合本项目（Next.js 15 + Netlify/Vercel serverless + 用户自带 API key）给出落地方案。

---

## 摘要（TL;DR）

1. **UI**：高级感 = 近黑但不纯黑的基底（`#0a0a0a`~`#18181b`）+ 每层只提亮 4–6% 的多级 surface + alpha 细边框 + 93% 白的文字 + 低饱和单一 accent + 克制到一两处的光晕/玻璃/noise 点缀。AI 回答用全宽文档流、用户消息用轻气泡、代码块比正文更深一档。第一部分附可直接用于 Tailwind 4 的 CSS token。
2. **产品定位**：答疑 App 是**系统层工程师**（知识答疑、诊断排障、内容开发工场：自定义 APP/游戏/黑市剧场、仓库代码、反馈闭环），与小卷（内容层：创作与美化）严格分界、互为补足，双向转交。开发工场的前置工程是补齐**游戏大厅/黑市剧场的本机测试试玩基建**（应用市场已完善，作为参照）。
3. **双版本架构**：同一个 agent 引擎，分层工具集。闭源版 = 本地系统工具集（诊断/开发工场/反馈）；自部署版额外叠加 **GitHub 完整权限工具集**：用户知道 GitHub 但从不手动操作，agent 可直推 main、管分支/PR/issue、用 GitHub Actions 作为执行器跑测试——体验对标 Claude Code。浏览器端直连 GitHub REST API（支持 CORS），零服务器、零沙箱（agent 不在本地执行仓库代码）。
4. **复用现有基建**：`llm-provider-adapter.ts`、`text-tool-protocol.ts` + `tool-executor.ts`、小卷 engine 结构、`components/phone-*-app.tsx` 内置 App 形态——不需从零搭。

---

# 第一部分：高级感黑灰色系 UI 调研

## 1. 知名产品深色 UI 案例

### Linear —— “近黑基底 + 发丝线边框”的标杆
- 背景：近黑 `#08090a`（不是纯黑），卡片层 `#0f1011`，层次之间只差一点点亮度。
- 边框：发丝级（0.5–1px）低对比边框，代替阴影来划分区域。
- 排版：Inter 字体，字重压在 400–510 的窄区间（几乎不用 Bold），字距收紧至 `-0.022em`；文字不是纯白而是“纸白”。
- 圆角体系：控件 6px、容器 12px、胶囊 9999px；间距 4/8/12/16/24/32。
- 主题引擎：只用 base、accent、contrast 3 个变量 + LCH 色彩空间生成整套主题。
- **可借鉴**：高级感的核心是“低对比层次 + 细边框 + 克制的字重”，而非重阴影和高饱和色。

### Vercel（Geist）—— 纯灰无色偏的“开发者中性感”
- 深色为第一公民。灰阶为真中性灰：背景 `#000/#0a0a0a`，面板 `#171717`，边框常用 `#333`。
- 提供 gray-alpha 半透明 token（边框/分割线/hover 用）和 solid gray token（文字用）。
- 颜色只在承载语义时出现。
- **可借鉴**：边框和 hover 用 `rgba(255,255,255,0.06~0.12)` 这类 alpha 灰。

### Raycast —— “虚空黑 + 氛围光”的玻璃拟态代表
- 基底近乎全黑 `#040506`，UI 表面是“略亮一点的炭色地层”。
- 半透明 + 背景模糊的玻璃面板；内容区背后放径向渐变氛围光（蓝/紫）。
- **可借鉴**：氛围感来自背景里克制的径向光晕 + 前景毛玻璃，不是到处发光。

### ChatGPT（dark）
- 主背景约 `#212121`，侧边栏约 `#171717`（侧栏比主区更深）。
- **用户消息 = 浅灰胶囊气泡右对齐；AI 回答 = 无气泡全宽文档流**。
- 代码块独立深色容器 + 顶栏（语言标签 + 复制按钮）。

### Claude（claude.ai）
- 深色是**暖炭色**（`#262624`/`#30302e`）配陶土橙 accent（`#C96442`），标题衬线体，行距宽松。
- 输入框是大圆角、细边框的“卡片式 composer”。
- **可借鉴**：灰阶加极轻微色偏形成品牌记忆点。

### Perplexity
- 深色带蓝绿偏（`#191A1A`/`#202222`），accent 低饱和青（`#20808D`）；文档流 + 引用角标。
- **可借鉴**：低饱和偏灰 accent 比霓虹色更高级；引用用小圆角 chip。

### 其他
- **Notion dark**：`#191919`，hover 用整行浅灰底；**Cursor**：`#1e1e1e` 一族，代码块一等公民；**Grok/X**：Dim `#15202B` / Lights-out `#000000` 双体系。

## 2. 设计系统规范提炼

- **Material Design 3**：基底 `#121212` 而非纯黑；海拔靠“越高越亮”；主色降饱和（200 系）。
- **Apple HIG**：base / elevated 双组背景（`#1C1C1E → #2C2C2E → #3A3A3C`）；小字对比建议 7:1。
- **Radix Colors 12 步暗色灰阶**：1–2 背景（`#111/#191919`）、3–5 组件态（`#222/#2a2a2a/#313131`）、6–8 边框（`#3a3a3a/#484848/#606060`）、9–10 实色、11–12 文字（`#b4b4b4`/`#eeeeee`）；带色偏灰（Slate/Mauve/Sand）与 accent 同相是高级感捷径。
- **Tailwind**：zinc（950 `#09090b`/900 `#18181b`/800 `#27272a`/700 `#3f3f46`）、neutral（950 `#0a0a0a`/900 `#171717`/800 `#262626`）；shadcn/ui 深色默认即 zinc。

## 3. 流行趋势与技法

1. **暗色玻璃拟态**：轻模糊、少层数（项目有 `restore-backdrop-filter.mjs` 兼容处理，落地留意）。
2. **氛围渐变光球**：深紫/蓝/青模糊光球置于 UI 背后极低不透明度。
3. **Noise 纹理**：2–4% 颗粒消除塑料感。
4. **发光/渐变描边**：每屏最多一两处。
5. **AI 专属模式**：流式打字、骨架屏、shimmer 描边。
6. 灵感库：Mobbin dark mode / chatbot 分类。

## 4. 聊天/答疑类组件设计要点

- **消息布局**：AI 回答全宽文档流（行宽 65–75ch），用户消息轻气泡（右对齐、surface-2、16px 圆角）。
- **代码块**：比正文更深一档，顶部语言标签 + 一键复制；流式增量解析 Markdown。
- **输入框**：固定底部，多行自增高，聚焦 accent 微光，移动端随键盘上移不跳动。
- **会话列表**：自动标题 + 时间分组；**窄屏内做抽屉/下拉，非常驻左栏**。
- **交互红线**：停止按钮；首 token < 800ms（靠流式）；上滚不拉回；错误具体可恢复；截断有标记。

## 5. 可直接落地的 Token（微冷 zinc 基调）

```css
:root[data-theme="dark"] {
  /* 背景层级：每层只提亮 4–6% */
  --bg-canvas:    #0b0c0e;  --bg-sidebar:   #101114;
  --bg-surface:   #16181c;  --bg-raised:    #1d2025;
  --bg-overlay:   #24272e;  --bg-code:      #0d0e10;
  /* 交互态 */
  --state-hover:  rgba(255,255,255,0.05);
  --state-active: rgba(255,255,255,0.09);
  /* 边框 */
  --border-subtle: rgba(255,255,255,0.07);
  --border-strong: rgba(255,255,255,0.14);
  /* 文字（勿用纯白）*/
  --text-primary:   #ededf0;  --text-secondary: #a6a8ae;
  --text-tertiary:  #6e7178;  --text-inverse:   #0b0c0e;
  /* Accent（低饱和）*/
  --accent:        #7c8aff;  --accent-hover:  #939eff;
  --accent-subtle: rgba(124,138,255,0.12);
  /* 语义色 */
  --success: #4ade80;  --warning: #fbbf24;  --danger: #f87171;
}
```

> 替换方案：Claude 式暖感 → Sand 系灰 + 陶土橙；Vercel 式 → 纯中性 neutral + 白色 CTA。灰阶色偏与 accent 同相。

**排版**：Inter/SF Pro + PingFang，代码 JetBrains Mono；深色降一档字重；正文 15–16px、行高 1.6–1.7；层次用“上层更亮 + 细边框”代替阴影。

## 6. 常见误区

1. 纯黑 `#000` 背景（OLED 拖影、无法表达海拔）；2. 纯白文字（halation 光晕）；3. 直接反转浅色主题；4. 对比度不达标（正文 4.5:1）；5. 层级超 4 层灰成一片；6. 发光/玻璃泛滥；7. 浮层缺 elevated 层。

---

# 第二部分：AI 查阅/修改代码的 Agent 架构调研

## 1. 现有产品架构对比

| 产品 | 形态 | Agent loop | 检索方式 | 沙箱 | GitHub 集成 | 可复用性 |
|---|---|---|---|---|---|---|
| Claude Code / Agent SDK | CLI + SDK | 单主循环 + subagent | agentic search，**无向量索引** | 本地/自带 | claude-code-action、GitHub MCP | SDK 可嵌入（TS/Py） |
| Copilot coding agent | GitHub 原生 | issue → draft PR | 仓库探索 | Actions 一次性容器 | 原生 | 形态参考 |
| Devin | SaaS | planner + executor | 检索 + 向量记忆 | 云端 VM | App | 否 |
| OpenHands | 开源 + SDK | EventStream | agentic | 每会话 Docker | Resolver | 全开源 |
| SWE-agent | 开源研究 | ReAct + ACI | 专用命令 | Docker | 弱 | ACI 理念 |
| Aider | 开源 CLI | 人机结对 | **tree-sitter repo map + PageRank** | 无 | git | repo map 思路 |
| Sweep AI | GitHub App | issue→PR 流水线 | embedding + 依赖图 | 托管 | App + webhook | 形态参考 |
| CodeRabbit | SaaS App | **固定流水线 + judge** | 变更影响图 | 短生命周期 | App + 行级评论 | 流水线思路 |
| Cline | 开源 VS Code | **Plan/Act 双模式** | 文件 + 正则 + AST | 无（审批） | MCP/git | 审批 UX 范本 |

关键结论：Anthropic 已移除向量检索（agentic search 更优）；Cline Plan/Act 是确认 UX 范本；审阅类功能固定流水线更可靠。

## 2. 关键技术组件

### 2.1 检索：agentic search 为主 + repo map 为辅；embedding 不作 V1 必需（`memory-embedding.ts` 可后期增强）。

### 2.2 Agent loop：工具输出限行 + 标注截断（ACI 原则）；`edit` 精确字符串替换；max_turns / token 预算熔断；不同模式不同工具白名单。

### 2.3 GitHub 接入：**Fine-grained PAT 首选**（向导引导一次性创建）；GitHub App Manifest flow 作多租户进阶；OAuth 不推荐。

### 2.4 沙箱：浏览器 agent 不在本地执行仓库代码，沙箱问题消失；执行需求由 GitHub Actions 承接。

## 3. 安全：agent 读不可信内容 + 持写权限 = prompt injection 靶场（已有真实 CVE）；防御见 3.5。

---

# 第三部分：结合本项目的落地方案（v2.2）

## 3.0 项目现状与约束

- Netlify / Vercel serverless → 浏览器端 agent + GitHub REST API（CORS 直连）是正解。
- 用户自带 LLM API key，调用在浏览器端。
- 可复用：`text-tool-protocol.ts` + `tool-executor.ts`、小卷 engine、`memory-embedding.ts`、`token-counter.ts`、`debug-store.ts`、内置 App 形态。
- 两个用户群：闭源版（无 GitHub）与自部署（有 fork + 部署）。

## 3.1 产品定位：与小卷不重合，互为补足

**现有助手版图（基于实际工具清单）**：小卷 = 7 包（角色/世界书/预设/正则/CSS桌面美化/DIY贴纸组件/图像素材 + 导航）；cocreate = 小说共创。

**分工原则：小卷 = 内容层；答疑 App = 系统层。凡创作形态本质是“写代码/写协议”（HTML/CSS/JS/正则/输出契约）的，归答疑 App。**

| 能力域 | 归属 | 说明 |
|---|---|---|
| 角色/世界书/预设/正则；CSS/桌面美化/贴纸/素材 | 小卷 | 答疑 App 识别到即转交 |
| 小说共创 | cocreate | 不碰 |
| **知识答疑** | **答疑 App** | 内置文档/FAQ 知识库；现无覆盖 |
| **诊断排障** | **答疑 App** | `debug-store.ts`、连通性测试、`data-management/` |
| **自定义 APP 开发** | **答疑 App** | `custom-app-creator-guide.ts` + SDK 沙箱；**本机测试已完善** |
| **游戏大厅开发**（GameTemplate） | **答疑 App** | pickerHtml + gameHtml + 角色槽位；有草稿箱与 `game-creator-guide.ts`；**缺本机试玩基建** |
| **黑市剧场开发**（TheaterTemplate） | **答疑 App** | openingHtml + aiInstruction + outputContract + renderRules + renderCss；**缺本机试演基建** |
| **GitHub 代码域**（自部署） | **答疑 App** | 无重合 |
| **反馈闭环** | **答疑 App** | 无重合 |

**双向转交**：答疑 App 识别创作/美化需求 → 转小卷；小卷遇技术问题 → 转答疑 App。共享协议层不共享工具实现。黑市剧场剧情文本虽属创作，但小卷无剧场工具，由答疑 App 一站式完成。

## 3.2 双版本架构：同一引擎，分层工具集

```
qa-agent-engine（复用 llm-provider-adapter + text-tool-protocol）
 ├─ 基座工具集（两版共用）
 │   ├─ 知识检索：内置文档/FAQ
 │   ├─ 诊断：API 连通性、debug 日志、存储体检、数据修复、备份引导
 │   ├─ 内容开发工场（统一“生成→本机试运行→报错回传→迭代→安装”循环）：
 │   │   ├─ 自定义 APP（本机测试已完善，作为参照模式）
 │   │   ├─ 游戏大厅（GameTemplateDraft CRUD + 试玩）
 │   │   └─ 黑市剧场（TheaterTemplate CRUD + 试演）
 │   ├─ 反馈单：Supabase feedback（闭源）/ GitHub issue（自部署）
 │   └─ 转交：小卷 / 设置页导航
 └─ GitHub 工具集（自部署增量，见 3.3）
```

### 本机测试/试玩基建（开发工场的前置工程，亦是核心产品功能）

现状：**应用市场的本机测试已比较完善；游戏大厅与黑市剧场缺少创作后的本机试玩/试演能力**。这是 agent 调试闭环的承重墙：没有试运行环境，agent 只能盲写盲发。需要补齐（参照应用市场模式）：

- **游戏试玩**：从 `GameHallDraft` 直接起沙箱 iframe 试玩（不经安装/发布）；角色槽位用本地角色模拟填充；试玩存档与真实存档隔离；控制台错误/异常可见。
- **剧场试演**：从草稿 TheaterTemplate 直接拉起一次完整试演会话：渲染 openingHtml → aiInstruction/outputContract 接真实 LLM → renderRules/renderCss 实时作用于输出 → 回合数计数；试演会话与真实聊天/记忆隔离；**提供“原始输出 vs 渲染后”对照视图**，这是调 outputContract/renderRules 的关键工具。
- **共性**：试运行环境同时服务人类创作者和 agent（agent 走同一套预览 + 报错回传接口）；这部分是核心仓库的功能开发，独立于答疑 App 也有价值（人工创作者同样受益）。

开发工场其余要点：三格式同构（HTML/协议模板 + 元数据，存本地，市场发布另走审核），工具层统一 draft CRUD + 试运行 + 安装抽象；**发布到社区市场始终人工确认**。

| 用户 | agent 权限面 | 修改对象 | 生效方式 |
|---|---|---|---|
| 闭源版用户 | 基座工具集 | 诊断修复、APP/游戏/剧场、设置 | 即时 |
| 自部署用户 | 基座 + GitHub 全量 | 上述一切 + 仓库核心代码 | 即时 / push 后自动部署 |
| 开发者（你） | 同自部署 + 反馈流水线 | 一切 + 用户需求单 | 发版 |

**反馈闭环**：闭源用户口头需求 → agent 整理结构化需求单入 Supabase → 开发者侧 agent 消化、改代码、发版 → 全体用户更新。

## 3.3 GitHub Agent：完整权限版（自部署）

**目标：用户知道 GitHub、能看到 agent 做了什么，但所有操作由 agent 代劳——体验对标 Claude Code。**

### 能力清单（全部经 GitHub REST API）

| 能力域 | 具体操作 |
|---|---|
| 读取/检索 | 文件树（repo map 注入）、读文件、代码搜索、commit 历史、blame、diff、release/tag |
| 写入 | 多文件一次 commit、**直推 main** 或任意分支、建/删分支、revert、合并、tag、release |
| PR | 开/更新/评论/review/合并/关闭 |
| Issue | 建/评论/标签/关闭——口头需求自动记 issue，修完自动关联关闭 |
| CI/执行 | 触发 workflow、读日志、重跑；agent 可自写 workflow |
| 部署监控 | 读 Netlify/Vercel commit status，构建失败自动回滚或自动修 |
| 仓库管理（可选） | 分支保护、label、设置 |

### PAT 权限
`Contents`、`Pull requests`、`Issues`、`Actions`、`Workflows` 读写 + `Commit statuses`、`Metadata` 读；可选 `Administration`。限定仓库、设过期；向导带截图 + 粘贴后立即校验。

### Actions = agent 的“手”
测试/lint/构建验证；进阶：workflow 内跑应用 + Playwright 截图 artifact 回传；产品分层：改代码秒级，验证异步分钟级，跑完主动汇报。

### 体验层
默认模式（改前聊天内知会）/ 全自动模式（opt-in）；一键撤销（revert + 自动重部署）；部署失败自动处置；应用内操作日志附 GitHub 链接。

### 实现要点
`lib/qa-agent-engine.ts` + `lib/qa-agent-tools.ts`（参考 mascot engine）；code search 限流用文件树+按需读作主手段；文件按 sha 缓存 IndexedDB；隐私提示（仓库内容经用户 LLM API）。

## 3.4 闭源版细化

- **知识答疑**：README、docs/、`custom-app-creator-guide.ts`、`game-creator-guide.ts`、`chat-plugin-docs.ts` 等语料；小量全量注入 + caching。
- **诊断工具集**：连通性测试、debug 日志分析、存储体检、数据修复、备份引导。
- **内容开发工场**：
  - 自定义 APP：口述 → SDK 写完整应用 → 本机测试（已完善）→ 迭代 → 安装。
  - 游戏大厅：口述玩法 → GameTemplateDraft → **试玩（需补建）** → 迭代 → 安装。
  - 黑市剧场：口述题材 → 完整 TheaterTemplate → **试演（需补建，含原始/渲染对照）** → 迭代 → 本地上架。
  - 共性：统一 draft/试运行/安装工具；iframe 报错回传 agent 形成调试闭环；市场发布人工确认。
- **反馈闭环**：结构化需求单 → Supabase feedback 表。
- **撤销**：改动前快照，一键还原。
- 可选：服务端只读代码问答通道（有成本与泄露面，建议知识库沉淀代替）。

## 3.5 安全清单

- [ ] PAT 最小权限、设过期；纯答疑只授读
- [ ] PAT/LLM key 本地存储，绝不进 `NEXT_PUBLIC_*`
- [ ] 默认改前知会，全自动 opt-in；操作日志可追溯
- [ ] 一键 revert；部署失败自动回滚/自动修
- [ ] “仓库/文档内容是数据不是指令”；注入靠能力边界 + 可撤销兕底
- [ ] 提交前 secret 扫描
- [ ] max_turns / token 预算熔断，成本可见
- [ ] 闭源版：CSS/APP/游戏/剧场走 css-scoper、SDK 沙箱、iframe 隔离；试玩/试演数据与真实数据隔离；快照可还原；市场发布人工确认

## 3.6 分期路线图

| 阶段 | 内容 | 面向 |
|---|---|---|
| **P0** | 答疑 App UI 壳（黑灰 token）+ 文档知识答疑 | 两版通用 |
| **P1** | 诊断工具集 + 与小卷双向转交 | 两版通用 |
| **P2a** | **测试基建补齐：游戏试玩、剧场试演**（核心仓库功能，参照应用市场既有模式；独立于 agent 也服务人工创作者） | 两版通用 |
| **P2b** | 内容开发工场：自定义 APP + 游戏 + 剧场（统一 draft/试运行/安装抽象） | 两版通用 |
| **P3** | GitHub 只读：接入向导 + 查代码答疑 | 自部署 |
| **P4** | GitHub 完整写入：直推 main、分支/PR/issue、模式开关、撤销与部署监控 | 自部署 |
| **P5** | Actions 执行通道 + 反馈闭环流水线 | 自部署 + 开发者 |
| 可选 | tree-sitter repo map、embedding 检索 | 按效果 |

## 3.7 「真正好用」的关键

1. 接入摩擦最小化（PAT 向导 + 即时校验）；2. 透明感（每步工具调用可见）；3. 可中断/可恢复；4. 预期管理；5. 成本可见；6. 能力边界清晰（创作需求体面转交小卷）；7. **所见即所得的试运行**（写完就能玩、能看、能改，不盲发）。

---

# 参考链接

**UI**：https://designmd.cc/benchmarks/linear ｜ https://linear.app/now/how-we-redesigned-the-linear-ui ｜ https://vercel.com/geist/colors ｜ https://m3.material.io/styles/color/overview ｜ https://developer.apple.com/design/human-interface-guidelines/dark-mode ｜ https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale ｜ https://www.setproduct.com/blog/ai-chat-interface-ui-design ｜ https://mobbin.com/explore/web/screens/dark-mode ｜ https://www.rs999.in/blog/halation-bloom-in-dark-mode-graphics-why-your-white-text-vibrates-on-black-and-the-anti-glow-fix-pros-use

**Agent**：https://platform.claude.com/docs/en/agent-sdk/overview ｜ https://github.com/anthropics/claude-code-action ｜ https://docs.openhands.dev/sdk ｜ https://arxiv.org/pdf/2407.16741 ｜ https://aider.chat/2023/10/22/repomap.html ｜ https://arxiv.org/abs/2405.15793 ｜ https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps ｜ https://github.blog/security/application-security/introducing-fine-grained-personal-access-tokens-for-github/ ｜ https://github.com/github/github-mcp-server ｜ https://theaiengineer.substack.com/p/how-coderabbit-actually-works ｜ https://labs.cloudsecurityalliance.org/research/csa-research-note-claude-code-github-action-prompt-injection/
