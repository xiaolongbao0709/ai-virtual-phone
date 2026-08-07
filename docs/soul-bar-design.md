# 灵魂酒吧（Soul Bar）设计文档 · APP 架构版

> 将「灵魂调酒模拟器」从单局小游戏，升级为虚拟手机世界里的一个**真实存在、有记忆的酒吧 APP**——
> 角色们可以约用户一起去，在那里调酒、卡座闲聊、点唱机放 BGM、偶遇其他角色/随机客人，
> **所有经历都通过 `memory.addTimeline` 沉淀为角色记忆**，下次再来熟客会记得你。
>
> **形态决策（用户确认）**：做成「自定义 APP」（应用市场安装），不是「iframe 小游戏」。
> 因为 APP SDK（`window.AiPhone`）原生提供记忆 / 私信 / BGM / 后台定时 / 多角色生成，
> 比小游戏（`window.AiPhoneGame`）能力完整得多，且**无需改动主仓库**。

---

## 1. 为什么用 APP 而不是游戏

| 能力 | 小游戏 `AiPhoneGame` | 自定义 APP `AiPhone` |
|------|---------------------|---------------------|
| 记忆回写 | 仅 `recordGameEvent`（结束写一次） | `memory.addTimeline`（事件可写进任意真实角色短期记忆流）+ `memory.add`（长期） |
| 多角色同台生成 | 仅第三人称群像叙事 | `ai.generate({ characterIds: [...] })` 原生多人、按角色切分 |
| 私信 / 聊天联动 | ❌ | `chat.writeHistory` / `sendCard` / `requestReply` / `openConversation` |
| BGM 背景音 | ❌（无音频通道） | `voice.play({ channel: "ambience", loop: true })` |
| 后台定时 / 随机事件 | ❌ | `tasks.schedule` |
| 红点 / 通知 | ❌ | `notifications.*` |
| 私有数据持久化 | `saveGame/loadGame`（单存档槽） | `db.create/list/get/update/delete`（多集合） |
| 读角色日程（生成随机事件素材） | ❌ | `calendar.read` |

**结论**：灵魂酒吧的所有需求在 APP SDK 下都有原生实现，不需要写自定义桥接、不需要改 `character-types.ts` 加 `isHidden`、不需要动主仓库。

---

## 2. 完整需求清单（用户多轮汇总）

| # | 需求 | APP SDK 实现 |
|---|------|-------------|
| 1 | 记忆继承进酒吧：情侣进去不像陌生人 | `ai.generate` 自动加载角色完整人设/记忆链路 |
| 2 | 游玩后记忆回写角色 | `memory.addTimeline({ characterId, appLabel:"Kissa", summary })` |
| 3 | 多人共调 + 角色间互动 | `ai.generate({ characterIds })`，预设约定 `[台词@角色Id]...` 格式 |
| 4 | 角色也给我调（心境模式） | `ai.generate({ characterId, appTags:["bar","bartend"] })` |
| 5 | 私聊后转回酒吧记忆接上 | `db` 存私信摘要 → 回酒吧注入下一轮 `instruction` |
| 6 | 离店后 NPC 有记忆点（老板打招呼/随机客互动） | NPC 档案存 `db`；互动事件 `memory.addTimeline` 写进真实角色流 |
| 7 | 进场提示栏：今日随机特调/小吃 2~3 种 | 进场 `ai.generate` 生成；作为随机事件种子 |
| 8 | 随机特调作为随机事件种子 | 点某特调 → 触发相关事件链 `instruction` |
| 9 | 点特调时角色按设定/记忆给建议 | 随行角色 `ai.generate` 注入用户人设（如「清纯小白兔点了烈酒→不适合你」） |
| 10 | 不玩调酒的选项：角色给你调 / 你自己调 | 酒单无想喝的 → 角色调 / 进调酒活动；调完回归剧情 |
| 11 | 模式间转换按钮（酒吧↔调酒↔私信↔事件） | 单一 `index.html` 内部 UI 状态机 |
| 12 | BGM 连通音乐系统选酒吧背景音乐 | `voice.play ambience` 通道循环播放 |
| 13 | 单/多人线下聊天模式 | 卡座区多角色闲聊 |
| 14 | 人物临时增减（偶遇加入 / 离开；可只打招呼就走） | `db` 在场名单 + `ai.generate` 生成入场/离场台词 |
| 15 | 群像角色自行跳转发私信（如讨厌在场某人） | 角色输出 `[私信@角色Id]内容` → APP 调 `chat.writeHistory`+`requestReply`+红点 |
| 16 | 随机事件：系统提示→问是否观看→AI 生成丰富剧情 | `ai.generate` 生成事件；参考本次对话 |
| 17 | 事件可让现有手机角色偶遇参与 | 从 `characters.list` 抽一个加入；事件进双方记忆 |
| 18 | 进入突发事件记忆对接（写回双方） | `memory.addTimeline` 两方 |
| 19 | 酒吧 UI 参考栖所（多房间、好看） | 视觉参考：玻璃美学 + 房间标签页（纯 CSS/JS 实现） |

---

## 3. 架构（APP 形态）

```
┌────────────── 小手机宿主 ──────────────┐
│ 角色 / 记忆(短期事件流) / 聊天 / 音乐 / 日历 │
│      ▲ 通过 AiPhone SDK 请求   │ 回调       │
│  ┌─────┴──────────────────▼──────┐       │
│  │  灵魂酒吧 APP（iframe 沙盒）      │       │
│  │  manifest.json + index.html     │       │
│  │  + presets.json（场景预设）      │       │
│  └───────────────────────────────┘       │
└──────────────────────────────────────────┘
```

- APP 包由用户压缩成 `.zip` 上传应用市场：`manifest.json`（必需）+ `index.html`（必需）+ `presets.json`（可选）+ `icon.png` + `assets/`。
- **不改动主仓库任何代码**，全部能力走 SDK。
- 之前修改的 `docs/soul-bar/灵魂调酒模拟器.html`（iframe 调酒游戏，已修 P0 记忆）可保留为「酒吧内的调酒小游戏」快速选项；但 MVP 优先用 APP 原生调酒活动（统一记忆/私信/BGM）。

---

## 4. NPC 升级路径（用户确认）

随机 NPC 非一次性，按参与度逐级升级：

```
一次性随机 NPC（本次生成，事件结束即删）
   │  连续 3 次访问中，都「正好」被随机事件选中并参与该客人剧情
   ▼
熟客 regular（持久留存于 APP db，下次可能再遇）
   │  后期「老是出现」（频繁命中）
   ▼
弹窗询问：是否把这个 NPC 升级为「独立角色」？
   │  用户确认
   ▼
独立角色（提示用户在小手机里正式创建该角色）
```

**实现（纯 APP 私有数据，不碰主仓库角色表）**：
- APP `db` 建集合 `bar_npcs`：`{ id, name, persona, appearanceCount, eventStreak, tier, lastSeenVisit }`
- `tier`: `oneoff` → `candidate` → `regular` → `independent`
- 判定「连续 3 次参与」：每次访问结束更新 `eventStreak`；未参与则 streak 归零。
- NPC 与真实角色（用户/手机角色）互动后，用 `memory.addTimeline` 把事件写进**真实角色**的短期记忆流 → 「角色之后聊天能回忆起酒吧」。
- NPC 自己的「成长档案」存 `db`；升级为独立角色时，提示用户去小手机创建该角色（APP 无法写主仓库角色表，符合 SDK 约束）。

---

## 5. 场景预设（presets.json）tags

| 场景 | appTags | 用途 |
|------|---------|------|
| 卡座闲聊 | `["bar","lounge"]` | 多角色在场闲聊，约定 `[台词@角色Id]内容` 输出格式 |
| 调酒（用户自己调） | `["bar","bartend"]` | 用户主导调酒，角色给建议/评价 |
| 心境调酒（角色给你调） | `["bar","bartend_mood"]` | 用户说心情，角色当调酒师 |
| 特调建议 | `["bar","suggest"]` | 用户点某特调，角色按人设（如清纯小白兔点烈酒）给建议 |
| 随机事件 | `["bar","event"]` | AI 生成丰富剧情，可参考本次对话；输出 `[台词@角色Id]...` |
| 私信 | `["bar","private"]` | 角色私下对用户说的话，语气更私密 |
| 入场/离场 | `["bar","entrance"]` | 角色/客人进入或离开酒吧的台词 |

---

## 6. 分阶段计划

| Phase | 内容 | 交付 |
|-------|------|------|
| **P0 APP 骨架** | manifest.json + presets.json + index.html 基础框架（多房间、进场特调、BGM、在场名单、离店记忆回写） | 可安装的 APP 包 |
| **P1 卡座闲聊** | ✅ 多角色 `ai.generate` 闲聊、用户发言、角色间互动、私信跳转（`[私信@...]` 解析） | 在 P0 上 |
| **P2 调酒活动** | ✅ 今日特调建议、用户自调、角色心境调、调完回归剧情；记忆回写 | 在 P0 上 |
| **P3 动态角色** | ✅ 偶遇加入/离场、NPC db 档案、离场私信、私信转回衔接 | 在 P0 上 |
| **P4 随机事件** | ✅ 系统主动提示→是否观看→AI 丰富剧情（参考对话+特调+私信）→事件进双方记忆→现有角色偶遇 | 在 P3 上 |
| **P5 沉浸+NPC升级** | ✅ NPC 升级路径精确化（连续3次随机事件参与→常客→频繁≥5次→询问升独立角色）、醉酒度系统、时间流逝、账单结算、拍照发朋友圈、栖所式多房间视觉深化（卡座/吧台/点唱机/露台相册四区 + 状态条 + 房间氛围光） | 在 P4 上 |

> 实现位置：`docs/soul-bar/app/index.html`（APP 包，压缩为 `soul-bar-app.zip` 上传应用市场）。P0–P5 代码已全部落地并通过 JS 语法校验。
> **NPC 升级路径（P5 精确化）**：NPC 档案新增 `eventStreak`（连续访问中参与随机事件的连胜）、`appearanceCount`（总到访次数）、`participatedThisVisit`（本次是否参与事件）。每次参与随机事件 → `participatedThisVisit=true`，离店结算时：本晚参与过则 `eventStreak+1` 否则归零；`eventStreak>=3` 升「常客」（持久留存，下次进场有概率本来就在）；常客 `appearanceCount>=5` 离店时弹窗询问是否升级为正式角色（`A.characters.create`），确认后标记 `independent`。
> **醉酒度**：顶部状态条 + 细进度条（青→金→红）。点单/自调/角色调累加醉酒度，分级（清醒/微醺/上头/烂醉）注入对话氛围指令，越醉越坦诚感性、可能拦酒。
> **时间流逝**：开门 21:00，聊天/点单/事件分别推进分钟；≥23:00 触发「夜深了」提示，可结账离店。
> **账单**：吧台点单、自调(¥30)、角色心境调(¥52) 均累计消费，离开时渲染「今晚账单」卡片并计入记忆摘要。
> **拍照发朋友圈**：📸 调驻场摄影师用 AI 生成 scene+caption 拍立得卡，存进「露台相册」并最佳努力发到真实朋友圈（`A.social.postMoment`/`A.moments.create`/`A.feed.post` 特征探测，失败不影响本地相册）；也可自己写一句话留念。
> **栖所式多房间**：顶部状态条 + 四区标签页（🛋️卡座 / 🍸吧台 / 🎵点唱机 / 📸露台相册），每区带专属氛围光与 zonehead 文案，接近「栖所」的空间感。
> 自动随机事件：每轮卡座对话有 18% 概率系统主动提示突发事件（最多一次/晚）；另有 🎲 手动按钮。

> 之前 `docs/soul-bar/灵魂调酒模拟器.html` 的 P0 记忆修复（多人 full package、关系引导、丰富 summary）保留为可选内嵌调酒游戏。

---

## 7. 关键实现片段（SDK 速记）

```js
// 多角色在场闲聊
const r = await AiPhone.ai.generate({
  characterIds: presentIds, appTags: ["bar","lounge"],
  instruction: `你们在 Kissa 酒吧卡座区。${userLine}\n按 [台词@角色Id]内容 格式每人发言。`
});
// 解析 r.text 渲染各角色气泡

// 写回记忆（离店时）
await AiPhone.memory.addTimeline({
  characterId, appLabel: "Kissa 灵魂酒吧",
  detail: "bar_visit",
  summary: `${userName}和你在 Kissa 一起调了《夜色微醺》，玩到很晚。`
});

// BGM
await AiPhone.voice.play({ channel: "ambience", dataUrl: bgm, loop: true, volume: 0.3 });

// 角色私下给用户发消息
await AiPhone.chat.writeHistory({ characterId, role: "user",
  content: `[酒吧私信：${charName}私下跟你说：这个人不喜欢，我们待会去别处。]` });
await AiPhone.chat.requestReply({ characterId });
await AiPhone.notifications.create({ title: `${charName}的私信`, body: "...", badgeDelta: 1 });
```
