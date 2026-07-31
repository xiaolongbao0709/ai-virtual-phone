// lib/chat-plugin-docs.ts
// 聊天插件开发文档：管理页"一键复制"给用户，用户可整段发给任意 AI 代写插件。
// 文档必须与 chat-plugin-types.ts 的契约严格同步 —— 改契约先改这里。

export const CHAT_PLUGIN_EXAMPLE_MOOD = `export default {
  manifest: {
    id: "mood-status",
    name: "心情状态",
    apiVersion: 1,
    version: "1.0.0",
    author: "你",
    description: "角色每次回复携带 [心情:xxx]，气泡下方展示当前心情",
    settings: [
      { key: "showFooter", label: "在气泡下方显示心情", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    // 注入提示词：要求模型输出心情标记
    ctx.prompts.set("每次回复的最末尾，用 [心情:一个词] 标注你当前的心情。");

    // 拦截模型回复：提取心情、从正文中删掉标记
    ctx.hooks.transform("llm.response", (p) => {
      const m = p.text.match(/\\[心情[:：]([^\\]]+)\\]/);
      if (m && p.sessionId) {
        ctx.data.variables.set("mood", m[1].trim(), "session", p.sessionId);
      }
      p.text = p.text.replace(/\\[心情[:：][^\\]]+\\]/g, "").trim();
      return p;
    });

    // 气泡下方坑位：显示该会话当前心情
    ctx.ui.slot("message.footer", (el, props) => {
      if (ctx.system.settings.get("showFooter") === false) return;
      if (!props.message || props.message.role !== "assistant" || !props.sessionId) return;
      const mood = ctx.data.variables.get("mood", "session", props.sessionId);
      if (!mood) return;
      el.textContent = "心情 · " + mood;
      el.style.cssText = "font-size:11px;opacity:.65;margin-top:3px;";
    });
  },
};`;

export const CHAT_PLUGIN_FULL_DOC = `# 小手机聊天插件开发文档（apiVersion 1）

你要为一个聊天应用编写 JavaScript 插件。插件是一个 **ES Module**，必须 \`export default { manifest, setup }\`。
把这份文档 + 你想要的玩法描述发给 AI，就能得到可直接安装的插件代码。

## 基本结构

\`\`\`js
export default {
  manifest: {
    id: "my-plugin",        // 必填，2~64 位字母/数字/横线/下划线/点，全局唯一
    name: "我的插件",        // 必填
    apiVersion: 1,           // 必填，当前固定为 1
    version: "1.0.0",        // 可选
    author: "作者",          // 可选
    description: "一句话说明", // 可选
    permissions: ["chat.read", "ai"], // 可选，用途披露（展示给用户看）
    settings: [              // 可选，声明后宿主自动生成设置界面
      { key: "enabled", label: "开关", type: "boolean", default: true },
      { key: "style", label: "风格", type: "select", default: "a",
        options: [{ value: "a", label: "风格A" }, { value: "b", label: "风格B" }] },
      // type 还支持 "text" | "number"
    ],
  },
  setup(ctx) {
    // 启用时执行一次。在这里注册 hook / UI / 定时器。
    // 所有 ctx.hooks.*/ctx.ui.*/ctx.system.timers.* 返回"反注册函数"，
    // 宿主会在插件禁用时自动调用，一般不需要自己管理。
    // 可选返回一个函数作为额外清理逻辑。
  },
};
\`\`\`

## 运行环境（重要）

- 插件与宿主**同环境直接执行**（无沙箱），可以使用浏览器全部能力（fetch、DOM、localStorage 等），
  但**只应通过 ctx 与聊天系统交互** —— ctx 之外的宿主内部结构随时可能变化。
- 插件报错不会影响聊天：宿主会捕获、记入错误日志；**连续失败 5 次自动禁用**该插件。
- 异步 transform 单次处理超时 8 秒，超时按跳过处理。
- 禁用/卸载即时生效（免刷新），全部注册自动撤销。

## ctx.hooks —— 管线拦截

### transform（可修改数据，按 priority 升序串行，返回修改后的 payload；也可原地改后 return payload）

\`ctx.hooks.transform(点名, async (payload) => payload, { priority: 100, timeoutMs: 8000 })\`

opts.timeoutMs 覆盖该 transform 的超时（默认 8000ms）。在 transform 里做 OCR、联网等慢活时调大（如 60000），否则会因超时被跳过。

| 点名 | 时机 | payload 字段 |
|---|---|---|
| user.beforeSend | 用户消息落库前 | { text, sessionId, isGroup, cancelled } —— 改 text 可改写；cancelled=true 取消发送 |
| prompt.system | 组装系统提示词时（单聊/群聊） | { sessionId, isGroup, characterId?, hint } —— 往 hint 追加/改写提示词 |
| llm.request | 每次 LLM 请求发出前 | { messages, purpose, sessionId?, temperature?, maxTokens? } —— messages 为 OpenAI 形状数组，可增删改；设置 temperature/maxTokens 覆盖采样参数 |
| llm.response | 模型原始回复文本落地前 | { text, sessionId?, purpose } —— 改 text 即改写回复（在内置正则之前） |
| message.beforePersist | 任何消息写入存储前（**同步**，处理函数不能是 async） | { message } —— 可修改 message 的字段 |

### on（只读事件广播，处理函数可 async）

\`ctx.hooks.on(事件名, (payload) => {})\`

| 事件 | 时机 | payload |
|---|---|---|
| app.ready | 插件全部加载完成 | {} |
| session.opened | 进入某个聊天 | { sessionId, isGroup } |
| message.persisted | 消息已落库（用户/角色/系统全路径） | { message } |
| message.updated | 消息被修改 | { id, patch } |
| message.deleted | 消息被删除 | { id, sessionId } |
| llm.streamChunk | 流式回复分片（高频，勿做重活） | { chunk, sessionId?, purpose } |
| plugins.changed | 插件列表/启停变化 | {} |

## ctx.data —— 数据

- \`ctx.data.messages.list(sessionId)\` → 消息数组；\`.push({ sessionId, role, content, ... })\` 发一条消息（role: "user" | "assistant" | "system"）；\`.update(id, patch)\` 改消息
- \`await ctx.data.messages.resolveMedia(msg)\` → 把消息的二进制媒体（图片/语音/视频/文件）解析成真实字节：返回 \`{ dataURL, blob, mimeType, category }\`（category: image/audio/video/file），无媒体或失败返回 null。聊天里的图片/语音等存的是 mediastore:// 引用不能直接用，要靠这个解析。dataURL 可直接塞进视觉 API 的 image_url。
- \`ctx.data.sessions.list()\` / \`.get(id)\` → 会话（含 isGroup、contactId 等）
- \`ctx.data.contacts.list()\` → 聊天联系人
- \`ctx.data.characters.list()\` / \`.get(id)\` → 角色卡
- \`ctx.data.variables\` —— **跨插件共享**的变量池（好感度、心情这类世界状态）：
  - \`.get(name, scope?, targetId?)\` / \`.set(name, value, scope?, targetId?)\` / \`.update(name, patchObj, ...)\` / \`.unset(name, ...)\`
  - scope: "global"（默认）| "session"（传 sessionId）| "character"（传 characterId）
  - 插件自己的私有数据请用 ctx.system.storage，不要放变量池

## ctx.ai —— LLM 裸通道

\`await ctx.ai.chat({ prompt, system?, temperature?, maxTokens? })\` → 回复文本。
直连用户配置的模型 API：不挂角色、不进聊天记录、不写记忆。

## ctx.prompts —— 持久提示词片段

\`ctx.prompts.set(text, { sessionId? })\`：设置一段持续注入系统提示词的文本（不传 sessionId 为全局，传则只对该会话生效）；text 传空串或 \`ctx.prompts.clear()\` 清除。与 prompt.system transform 的区别：这个是持久的、无需每次拦截。

## ctx.ui —— 界面

- \`ctx.ui.toast(text, opts?)\` 聊天顶部轻提示，默认约 2.4s 消失。做"识别中/加载中"这类进行中提示时传 \`{ durationMs: 0 }\` 让它常驻，用返回的 \`close()\` 在完成时手动关闭：\`const t = ctx.ui.toast("处理中…", { durationMs: 0 }); try { …await… } finally { t.close(); }\`
- \`ctx.ui.slot(坑位名, (el, props) => { ...; return 可选清理函数 })\` —— 认领一块 **React 不管辖的裸 DOM 容器**，随便渲染：
  - "chat.header"：聊天标题栏下方（props: { sessionId, isGroup }）
  - "chat.inputToolbar"：输入栏"+"面板下方（props: { isGroup }）
  - "message.footer"：每条文本气泡下方（props: { sessionId, message }）——注意会被多条消息各调用一次
  - "settings.section"：插件管理页的自定义设置区
- \`ctx.ui.messageAction({ id, label, filter?, onSelect })\` —— 消息长按菜单加一项；onSelect(msg, { updateMessage, toast })
- \`ctx.ui.messageKind(kind, (el, msg) => {})\` —— 注册自定义消息类型；配合 \`ctx.data.messages.push({ ..., mediaType: "plugin:" + kind, mediaData: {...} })\` 发出由你渲染的卡片消息
- \`ctx.ui.injectCSS(css)\` —— 注入全局样式（禁用自动移除）
- \`ctx.ui.openModal((el, { close }) => { ... })\` —— 打开一个**插件完全掌控的浮层**：宿主给全屏遮罩 + 一块居中裸容器（默认卡片外观，可覆盖），你在里面自由渲染任意界面（表单、按钮、列表都行）。点遮罩空白处或调 \`close()\` 关闭；插件禁用时自动关。适合做"配置浮层""详情弹窗"等独立界面，摆脱静态设置表单的框框。

## ctx.system —— 系统

- \`ctx.system.storage.get/set/remove/keys\` —— 插件私有 KV（卸载时清除）
- \`ctx.system.timers.setTimeout/setInterval(fn, ms)\` —— 定时器（禁用自动清除；interval 最小 200ms）
- \`ctx.system.bus.emit(topic, data)\` / \`.on(topic, fn)\` —— 插件间通信
- \`ctx.system.fetch(url, init)\` —— 网络请求
- \`ctx.system.settings.get(key)\` / \`.all()\` / \`.set(key, value)\` / \`.onChange(fn)\` —— 读写 manifest.settings 声明的用户设置（set 用于"拉取模型后自动填入"这类场景）
- \`ctx.system.log(...)\` —— 日志（进管理页日志面板）

## 规则与建议

1. 输出**一个完整的 ES Module 文件**，不要用 TypeScript 语法、不要 import 其他文件。
2. transform 处理函数里改完 payload 记得 \`return payload\`（原地修改也要 return）。
3. message.beforePersist 是同步点：处理函数不能是 async。
4. 高频点（llm.streamChunk、message.footer）里避免昂贵计算与网络请求。
5. 需要用户可调的行为，声明成 manifest.settings 而不是写死。
6. 同 id 重新安装视为升级覆盖（保留用户设置）。

## 完整示例：心情状态

\`\`\`js
${CHAT_PLUGIN_EXAMPLE_MOOD}
\`\`\`
`;
