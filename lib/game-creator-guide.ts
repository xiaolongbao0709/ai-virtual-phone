export const GAME_SINGLE_FILE_EXAMPLE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #111827;
      color: #f9fafb;
      overflow: hidden;
    }
    .app { height: 100%; display: grid; grid-template-rows: auto 1fr auto; gap: 12px; padding: 18px; }
    .panel { border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 14px; background: rgba(255,255,255,.08); }
    button { border: 0; border-radius: 10px; padding: 10px 12px; background: #38bdf8; color: #082f49; font-weight: 800; }
    .characters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; overflow: auto; }
    .character { min-height: 44px; background: rgba(255,255,255,.1); color: #f9fafb; text-align: left; }
    .character.is-active { outline: 2px solid #38bdf8; }
    .log { overflow: auto; white-space: pre-wrap; line-height: 1.55; font-size: calc(13px*var(--app-text-scale,1)); }
  </style>
</head>
<body>
  <main class="app">
    <section class="panel">
      <h1>示例小游戏</h1>
      <p>选择一个小手机角色，然后让角色陪你进入第一幕。</p>
    </section>
    <section class="panel characters" id="characters">正在读取角色...</section>
    <section class="panel log" id="log">等待开始。</section>
    <button id="start" disabled>开始剧情</button>
  </main>
  <script>
    var selectedCharacterId = "";
    var selectedCharacterName = "";
    var playerName = "玩家";

    function escapeText(value) {
      return String(value == null ? "" : value).replace(/[&<>"]/g, function(ch) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch];
      });
    }

    async function boot() {
      await AiPhoneGame.setTitleBar({
        material: "glass",
        background: "rgba(17,24,39,.72)",
        buttonColor: "#f9fafb",
        buttonBackground: "rgba(255,255,255,.1)",
        buttonBorderColor: "rgba(255,255,255,.16)"
      });
      var profile = await AiPhoneGame.getPlayerProfile();
      playerName = profile && profile.name ? profile.name : "玩家";
      var characters = await AiPhoneGame.listAvailableCharacters();
      var box = document.getElementById("characters");
      if (!characters.length) {
        box.textContent = "还没有可选择的角色。";
        return;
      }
      box.innerHTML = characters.map(function(ch) {
        return '<button class="character" data-id="' + escapeText(ch.id) + '" data-name="' + escapeText(ch.name) + '">' + escapeText(ch.name) + '</button>';
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".character"), function(btn) {
        btn.onclick = function() {
          selectedCharacterId = btn.getAttribute("data-id") || "";
          selectedCharacterName = btn.getAttribute("data-name") || "";
          Array.prototype.forEach.call(box.querySelectorAll(".character"), function(item) { item.classList.remove("is-active"); });
          btn.classList.add("is-active");
          document.getElementById("start").disabled = false;
        };
      });
    }

    async function startGame() {
      var log = document.getElementById("log");
      log.textContent = "正在让 " + selectedCharacterName + " 进入游戏...";
      var pkg = await AiPhoneGame.getRoleLightPackage(selectedCharacterId);
      var result = await AiPhoneGame.callLLM({
        characterId: selectedCharacterId,
        messages: pkg.messages.concat([
          { role: "system", content: "你正在参与一个小手机 iframe 小游戏。请以角色第一人称进入开场，语气自然，输出 3 句以内。" },
          { role: "user", content: "玩家打开一扇陌生的门，门后传来微弱的音乐声。" }
        ])
      });
      log.textContent = result.content || "没有返回内容。";
      await AiPhoneGame.saveGame({ selectedCharacterId: selectedCharacterId, lastText: log.textContent });
      await AiPhoneGame.recordGameEvent({
        characterIds: [selectedCharacterId],
        summary: playerName + "和" + selectedCharacterName + "开启了《示例小游戏》，" + selectedCharacterName + "陪" + playerName + "进入了门后的第一幕。"
      });
    }

    document.getElementById("start").onclick = startGame;
    boot().catch(function(err) {
      document.getElementById("log").textContent = err && err.message ? err.message : String(err);
    });
  </script>
</body>
</html>`;

export const GAME_EMPTY_PICKER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body></body>
</html>`;

export const GAME_CREATOR_GUIDE_MD = `# 小手机小游戏制作说明

你正在为“仿真 AI 互动小手机”制作一个可以安装到【游戏大厅】里的小游戏。

【游戏大厅】是小手机系统内的一个 APP。用户会在里面安装、试玩、发布和游玩由 HTML 写成的小游戏。小游戏运行在小手机提供的 iframe 沙盒中，看起来像手机里的一个游戏页面。

这个小游戏可以和用户小手机里的 AI 角色一起玩。原因是小手机宿主会向 iframe 注入一个全局对象：

\`\`\`js
window.AiPhoneGame
\`\`\`

小游戏不能直接读取角色卡、记忆、模型密钥或用户数据。它只能通过 AiPhoneGame 提供的安全接口，请求宿主完成这些事情，例如：

- 读取接收方用户小手机里的角色列表
- 让玩家在小游戏 UI 里选择一个或多个角色
- 获取被选中角色的轻量包或全量包
- 让某个角色根据当前游戏局面说话、行动或判断
- 调用不绑定小手机角色的通用模型入口，用于规则判定、旁白或游戏代码临时定义的 NPC 文本
- 保存游戏进度
- 在游戏结束时把本局结果总结写回角色近期记忆

你需要生成的是一个完整的单文件 HTML 小游戏。用户会把这个 HTML 上传或粘贴到游戏大厅发布页，然后其他用户安装后即可游玩。

## 输出要求

1. 只输出一个完整 HTML 文件，不要输出解释文字。
2. HTML 必须包含 \`<!doctype html>\`、\`<html>\`、\`<head>\`、\`<body>\`、\`<style>\`、\`<script>\`。
3. 不要依赖外部构建工具，不要使用 npm，不要要求用户创建多个文件。
4. 尽量不要引用外部 CDN；如果能用原生 HTML/CSS/JS 完成，就全部写在一个文件里。
5. 游戏运行在 iframe sandbox 里，尺寸是手机内固定视口。请让页面适配 100% 宽高：

\`\`\`css
html, body {
  width: 100%;
  height: 100%;
  margin: 0;
}
body {
  overflow: hidden;
}
\`\`\`

6. 小手机宿主会在 iframe 内注入安全区变量。主游戏容器建议预留顶部空间，避免标题、计时器、关键按钮被左上角悬浮返回按钮遮挡：

\`\`\`css
.game-screen {
  min-height: 100%;
  box-sizing: border-box;
  padding: var(--ai-phone-game-safe-top, 88px) 16px var(--ai-phone-game-safe-bottom, 24px);
}
\`\`\`

7. 如果内容很多，请在游戏内部自己设置滚动区域，不要让整个 body 无限变高。
8. 所有按钮、输入、状态提示都要能在手机竖屏里使用。
9. 如果需要保存进度，使用 \`AiPhoneGame.saveGame()\` 和 \`AiPhoneGame.loadGame()\`。
10. 如果需要把游戏结果写回小手机记忆，使用 \`AiPhoneGame.recordGameEvent()\`，但只在游戏结束时调用一次。
11. 小手机宿主会在左上角固定保留一个悬浮返回按钮。它不占页面布局高度，游戏画面会铺满 iframe；不要把关键 UI 贴在左上角安全区内。如需让返回按钮融入游戏风格，可以用 \`AiPhoneGame.setTitleBar()\` 修改按钮样式。

## 宿主 API

游戏 HTML 里可以使用全局对象：

\`\`\`js
window.AiPhoneGame
\`\`\`

### 读取可选角色

\`\`\`js
const characters = await AiPhoneGame.listAvailableCharacters();
\`\`\`

返回示例：

\`\`\`js
[
  { id: "char_xxx", name: "沈砚清", avatar: "头像地址", subtitle: "简短说明" }
]
\`\`\`

你可以自己渲染角色选择界面。用户点选后，把 \`character.id\` 保存起来。

### 读取玩家信息

\`\`\`js
const player = await AiPhoneGame.getPlayerProfile();
console.log(player.name);
\`\`\`

\`player.name\` 是接收方小手机里全局绑定的默认用户名。游戏里需要称呼玩家、写结果总结时，都应该使用这个真实名字。

### 获取角色轻量包

\`\`\`js
const pkg = await AiPhoneGame.getRoleLightPackage(characterId);
\`\`\`

轻量包包含角色卡、用户人设、世界书、核心记忆、长期记忆等，适合大多数回合、对话、小游戏互动。

### 获取角色全量包

\`\`\`js
const pkg = await AiPhoneGame.getRoleFullPackage(characterId);
\`\`\`

全量包会带更多近期上下文，适合开场、结局、关键剧情节点。它更耗 token，不建议每一步都调用。

### 调用角色生成

当要让用户选择的小手机角色行动、说话、判断时，使用角色包和 \`callLLM()\`：

\`\`\`js
const result = await AiPhoneGame.callLLM({
  characterId,
  messages: [
    ...pkg.messages,
    { role: "system", content: "这里写游戏规则、输出格式、角色任务。" },
    { role: "user", content: "这里写当前局面。" }
  ]
});

console.log(result.content);
\`\`\`

注意：游戏拿不到用户模型密钥，模型请求由小手机宿主代调用。

### 调用全局生成

当你需要“裁判、旁白、系统主持人、商店老板、怪物、路人”等游戏内置 NPC 时，不要获取角色包，也不要把它们写成用户的小手机角色。请使用通用模型调用：

\`\`\`js
const judge = await AiPhoneGame.callGlobalLLM({
  messages: [
    { role: "system", content: "你是这个小游戏的裁判，只负责判定规则、推进回合、给出简短结果。" },
    { role: "user", content: "玩家掷出 17 点，敌方防御值 12。请判断是否命中，并给出一句结果。" }
  ]
});

console.log(judge.content);
\`\`\`

\`callGlobalLLM()\` 是不绑定小手机角色的通用模型调用，不读取任何角色卡、角色记忆或角色绑定。它适合处理游戏规则、随机事件、旁白，或由游戏代码在 prompt 里临时定义的 NPC。

如果游戏里有多个内置 NPC，请在 prompt 中自行写清楚这些 NPC 的身份、任务和当前状态，并要求模型按 JSON 返回多个结果；宿主不会为这些 NPC 提供独立角色包、独立记忆或多个内置模型实例。

### 写入游戏事件记忆

当一局游戏结束时，可以把本局结果写回短期记忆：

\`\`\`js
await AiPhoneGame.recordGameEvent({
  characterIds: [characterId],
  summary: \`\${player.name}和\${character.name}玩了《默契大考验》，\${character.name}以 3:2 获胜。游戏结束时，\${player.name}觉得\${character.name}很懂自己。\`
});
\`\`\`

重要规则：

- \`summary\` 必须使用真实名字，例如 \`player.name\` 和 \`character.name\`。
- 不要写“玩家”“用户”“角色A”“男主”“女主”“TA”这种泛称。
- 多个角色都需要记住同一件事时，把所有角色 ID 放进 \`characterIds\`。
- 只在游戏结束时写入一次；不要在章节中途、回合中途、动画帧、倒计时或普通按钮点击时写入。
- 这条记录会进入对应角色的近期游戏记忆，后续可能被小手机整理进长期记忆。

### 保存和读取存档

\`\`\`js
await AiPhoneGame.saveGame({
  scene: 2,
  hp: 80,
  inventory: ["钥匙", "旧照片"]
});

const save = await AiPhoneGame.loadGame();
\`\`\`

没有存档时，\`loadGame()\` 返回 \`null\`。

### 修改悬浮返回按钮样式

游戏运行时，宿主会固定保留一个左上角悬浮返回按钮。这个按钮不能隐藏，确保玩家始终有退出路径。它覆盖在 iframe 上方，不占游戏页面布局高度，所以游戏自己的主容器需要预留顶部安全区。

如果想让返回按钮更符合游戏风格，可以调用：

\`\`\`js
await AiPhoneGame.setTitleBar({
  material: "glass", // "clear" | "solid" | "glass"
  background: "rgba(17, 24, 39, 0.72)",
  color: "#f9fafb",
  borderColor: "rgba(255,255,255,.12)",
  buttonBackground: "rgba(255,255,255,.1)",
  buttonColor: "#f9fafb",
  buttonBorderColor: "rgba(255,255,255,.16)",
  buttonRadius: "999px",
  buttonShadow: "0 8px 20px rgba(0,0,0,.18)",
  iconOpacity: 1
});
\`\`\`

说明：

- 不支持隐藏返回按钮。
- \`background\` 和 \`borderColor\` 是兼容旧标题栏写法的字段；新结构主要读取 \`buttonBackground\`、\`buttonColor\`、\`buttonBorderColor\`、\`buttonRadius\`、\`buttonShadow\` 和 \`iconOpacity\`。
- 如果想要沉浸感，可以把 \`buttonBackground\`、\`buttonBorderColor\` 设为 \`transparent\`，或把 \`buttonColor\` 调成更贴合游戏背景的颜色。
- 不要依赖宿主为游戏内容自动留出顶部布局高度；请在游戏主容器里使用 \`var(--ai-phone-game-safe-top, 88px)\` 预留顶部安全区。
- 不要依赖隐藏返回入口来做剧情锁定；退出路径必须始终存在。

### 关闭游戏

\`\`\`js
await AiPhoneGame.closeGame();
\`\`\`

### 多人联机（真人对战/云共享）

游戏可以让不同用户的真人联机：开房间实时对战（狼人杀、谁是卧底、你画我猜），或用云端共享数据做异步玩法（排行榜、漂流瓶）。联机不需要高级游戏权限，但要求玩家登录了联机账号——未登录或单机模式下调用会抛错，请 catch 后在界面上提示"联机功能需要登录账号"。

实时房间：

\`\`\`js
// 房主开房，拿到 4 位房号给朋友；其他玩家凭房号加入
const room = await AiPhoneGame.room.create({ title: "谁是卧底", maxPlayers: 8 });
const joined = await AiPhoneGame.room.join({ code: "8A3F" });

// 收发消息与玩家名单
AiPhoneGame.on("room.message", (msg) => handle(msg.from.name, msg.payload));
AiPhoneGame.on("room.players", ({ players }) => renderPlayers(players));
await AiPhoneGame.room.send({ type: "speak", text: "我觉得是3号" });

// 权威状态：只有房主能写，全员（含中途加入者）自动同步
AiPhoneGame.on("room.state", ({ state }) => renderGame(state));
if (room.isHost) await AiPhoneGame.room.setState({ phase: "vote", round: 2 });

// 房主特权与退出；房间被关/被踢/房主掉线时收到 room.closed
await AiPhoneGame.room.kick(playerId);
await AiPhoneGame.room.close();
await AiPhoneGame.room.leave();
AiPhoneGame.on("room.closed", ({ reason }) => showEnd(reason));
\`\`\`

云端共享（异步）：

\`\`\`js
await AiPhoneGame.cloud.put({ collection: "scores", data: { score: 9800 }, sortKey: 9800 });
const top = await AiPhoneGame.cloud.list({ collection: "scores", orderBy: "sortKey", limit: 10 });
const bottle = await AiPhoneGame.cloud.takeRandom({ collection: "bottles" }); // 可能为 null
\`\`\`

联机架构规则（重要）：

- 游戏权威逻辑（发牌、分身份、回合判定）全部放在**房主客户端**，用 \`room.setState\` 下发；其他玩家只用 \`room.send\` 把自己的操作报给房主。
- 游戏画面始终从 \`room.state\` 渲染，\`room.send\` 的消息只当事件用——新玩家进房自动收到最新 state。
- 房主掉线 30 秒后房间自动结束（reason 为 \`host_left\`），本版本不支持房主迁移，请做好收尾界面。
- 限速每人每秒 25 条、单条 16000 字符；适合回合制与低频同步，不适合动作类帧同步。
- 内容安全：请在联机 UI 里放举报入口——\`AiPhoneGame.room.report(原因)\` 举报当前房间、\`AiPhoneGame.cloud.report({ id, reason })\` 举报一条云端内容（如排行榜/漂流瓶条目）。

带角色上桌（人和 AI 角色同场玩）：

联机局里可以有两类 AI 参与者，驱动方不同，别弄混：

1. **无主 NPC**（系统裁判、补位路人）：只在**房主端**用 \`callGlobalLLM\` 生成（prompt 里自定义 NPC 人设），结果写进 \`room.state\` 同步全员。
2. **玩家自带的角色**（每个玩家把自己的角色带进来一起玩）：由**角色主人的客户端**驱动——人设、记忆、API key 都只在主人设备上，轮到这个角色行动时，主人的客户端本地调 \`getRoleFullPackage\` + \`callLLM\` 生成，再把结果当普通玩家操作用 \`room.send\` 报给房主。其他玩家只看到角色的发言，永远拿不到人设。token 由角色主人消耗。

虚拟座位协议（推荐照抄）：

\`\`\`js
// 加入时把自己带的角色报给房主
await AiPhoneGame.room.send({ type: "bring", name: "小红", charId: "c1" });

// 房主维护座位表并轮转回合（seatId 全局唯一）
await AiPhoneGame.room.setState({
  seats: [
    { seatId: "s1", kind: "human",     ownerUserId: "u_a", name: "爱丽丝" },
    { seatId: "s2", kind: "character", ownerUserId: "u_a", name: "小红" },
    { seatId: "s3", kind: "human",     ownerUserId: "u_b", name: "鲍勃" },
  ],
  turn: "s2", phase: "speak",
});

// 每个客户端收到 state 后：轮到"我拥有的角色座位"就代它行动
AiPhoneGame.on("room.state", async ({ state }) => {
  const seat = state.seats.find(s => s.seatId === state.turn);
  if (seat && seat.kind === "character" && seat.ownerUserId === myUserId) {
    const pkg = await AiPhoneGame.getRoleFullPackage(seat.charId);
    const reply = await AiPhoneGame.callLLM({ messages: [...pkg.messages,
      { role: "user", content: buildTurnPrompt(state) }], characterId: seat.charId });
    await AiPhoneGame.room.send({ type: "action", seatId: seat.seatId, text: reply });
  }
});
\`\`\`

注意：角色主人掉线时它的角色也会"卡回合"，房主端要做超时跳过（比如 60 秒无响应自动弃权）；同一角色生成期间禁止重复触发（加个 generating 锁）。

## 权限说明

如果游戏只是普通前端小游戏，只用 \`saveGame\`、\`loadGame\`、\`closeGame\`，通常不需要高级权限。

如果游戏需要读取角色包或调用模型，也就是使用：

- \`getRoleLightPackage\`
- \`getRoleFullPackage\`
- \`callLLM\`
- \`callGlobalLLM\`
- \`recordGameEvent\`

发布时应启用高级游戏权限。接收方打开游戏时会看到确认提示。

## 推荐交互方式

低门槛做法：

1. 游戏开场调用 \`listAvailableCharacters()\`。
2. 让玩家选择一个或多个角色。
3. 保存选中的 \`characterId\`。
4. 调用 \`getPlayerProfile()\` 读取玩家真实名字。
5. 需要角色参与时，用 \`getRoleLightPackage(characterId)\` 获取角色包。
6. 把角色包和当前游戏局面一起传给 \`callLLM()\`。
7. 如果需要裁判、旁白、系统 NPC 或规则判定，用 \`callGlobalLLM()\`，并在 prompt 里自行定义这些 NPC；不要为这些 NPC 获取角色包。
8. 把返回文本渲染到游戏界面。
9. 用 \`saveGame()\` 保存关键状态。
10. 游戏结束时，用 \`recordGameEvent()\` 写入一条使用真实名字的本局总结。

## 生成时请遵守

- 不要让用户手动填写复杂配置。
- 不要要求用户理解角色槽位。
- 如果需要角色，就在 HTML 内自己做角色选择。
- 游戏内置 NPC 不属于用户角色，不要调用角色包；请用 \`callGlobalLLM()\` 并在 prompt 里自行定义。
- 写入游戏记忆时必须使用玩家和角色的真实名字，不要使用“玩家/用户/角色A”等泛称。
- 所有代码都放在一个 HTML 文件里。
- 最终只输出 HTML。`;
