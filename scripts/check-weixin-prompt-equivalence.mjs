#!/usr/bin/env node
// 微信助手提示词等价性校验
//
// 微信托管的提示词不是在云端跑一遍组装器，而是「小手机烘焙一份轻量模板 + 助手按新
// 消息重组」。这条捷径一旦和小手机自己的组装结果对不上，表现就是世界书/预设的注入
// 位置、轮次粒度和普通聊天不一样——而这种偏差在真机上极难察觉。
//
// 本脚本以「小手机拿到完整历史（烘焙历史 + 新微信消息）时的组装结果」为基准，
// 逐条比对助手用模板重组的结果，覆盖：
//   · 不同的烘焙历史长度（含空历史）
//   · 预设 injection_position≠0 与世界书 position=4 的多种注入深度
//   · 新消息条数少于 / 等于 / 多于注入深度
//   · 连续同 role 的新消息序列（深度条目可能插在一轮中间）
//
// 用法: node scripts/check-weixin-prompt-equivalence.mjs
// 退出码非 0 = 助手重组结果与小手机不一致。

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// weixin-cloud-sync 是 TS 且依赖浏览器侧模块，注册一个即时转译 + 桩件的加载器跑起来。
const hooks = `
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import ts from ${JSON.stringify(pathToFileURL(path.join(root, "node_modules/typescript/lib/typescript.js")).href)};

const ROOT = ${JSON.stringify(root)};
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx", ".mjs", ".js"];
// Dexie 是 CJS，ESM 具名导入拿不到 default；这里只需要它能被 import 而已。
const STUBS = { dexie: "export default class Dexie { version(){return{stores(){return{upgrade(){}}}}} table(){return{}} open(){return Promise.resolve()} }" };

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) {
    return { url: "data:text/javascript;base64," + Buffer.from(STUBS[specifier]).toString("base64"), shortCircuit: true, format: "module" };
  }
  let spec = specifier;
  if (spec.startsWith("@/")) spec = pathToFileURL(resolvePath(ROOT, spec.slice(2))).href;
  else if (spec.startsWith(".") && context.parentURL?.startsWith("file:")) {
    spec = pathToFileURL(resolvePath(dirname(fileURLToPath(context.parentURL)), spec)).href;
  } else return next(specifier, context);
  for (const ext of EXTS) {
    try { readFileSync(fileURLToPath(spec + ext)); return { url: spec + ext, shortCircuit: true, format: "module" }; } catch {}
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.endsWith(".ts") && !url.endsWith(".tsx")) return next(url, context);
  const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
    fileName: fileURLToPath(url),
  }).outputText;
  return { format: "module", shortCircuit: true, source: out };
}
`;
register("data:text/javascript;base64," + Buffer.from(hooks).toString("base64"), pathToFileURL(root + "/"));

const { buildWeixinCloudPromptMessages, buildWeixinCloudPromptTemplate } =
  await import(pathToFileURL(path.join(root, "lib/weixin-cloud-sync.ts")).href);
const { buildRuntimePromptMessages, mergeAdjacentSameRoleMessages, normalizeLlmMessages } =
  await import(pathToFileURL(path.join(root, "tools/weixin-local-assistant/assistant-core.mjs")).href);

// 分发文件必须和源文件同步，否则线上跑的是旧逻辑而本校验查不出来
const CORE_SRC = readFileSync(path.join(root, "tools/weixin-local-assistant/assistant-core.mjs"), "utf8");
for (const dist of ["public/weixin-local-assistant/assistant-core.mjs"]) {
  if (readFileSync(path.join(root, dist), "utf8") !== CORE_SRC) {
    console.error(`❌ ${dist} 与源文件不一致，请先运行 npm run weixin:build-dist`);
    process.exit(1);
  }
}

const TZ = "Asia/Shanghai";
const T0 = Date.parse("2026-08-19T00:00:00Z");
const ROLES = ["user", "assistant"];
const chatMsg = (i, role, content) => ({
  id: `m${i}`, sessionId: "s1", role, content, status: "sent",
  createdAt: new Date(T0 + i * 3600_000).toISOString(),
});

const mkPreset = (depths) => ({
  id: "p1", name: "t", builtIn: false, temperature: 0.8, top_p: 1,
  prompts: [
    { identifier: "main", name: "主", role: "system", content: "主提示", enabled: true, injection_position: 0, injection_depth: 0 },
    ...depths.map(d => ({ identifier: `d${d}`, name: `深${d}`, role: "system", content: `P${d}`, enabled: true, injection_position: 1, injection_depth: d })),
    { identifier: "shortTermMemory", name: "历史", role: "system", content: "", enabled: true, marker: true },
    { identifier: "tail", name: "尾", role: "system", content: "尾指令", enabled: true, injection_position: 0, injection_depth: 0 },
  ],
  prompt_order: ["main", ...depths.map(d => `d${d}`), "shortTermMemory", "tail"].map(identifier => ({ identifier, enabled: true })),
});
const mkWorldBooks = (depths) => depths.length === 0 ? [] : [{
  id: "wb1", name: "wb",
  entries: depths.map(d => ({ id: `e${d}`, key: ["x"], content: `WB${d}`, position: 4, depth: d, constant: true, enabled: true, insertion_order: 50 })),
}];

const mkContext = (history) => ({
  appId: "chat", appTags: ["chat", "text"], promptHistory: history, llmMessages: [], recentBlocks: [],
  unifiedRecentItems: history.map((m, i) => ({ kind: "history", timestamp: m.createdAt, historyIndex: i })),
  worldBookActivationContext: "", initialStateValues: [], longTermMemories: "", coreMemories: "",
  scheduleSummary: "", currentSchedule: "", customStickerNames: "", customStickerExample: "",
  musicLocal: "", musicCloud: "", musicOnlineHint: "", tools: "", chatBilingualInstruction: "",
  offlineBilingualInstruction: "", offlineSummaryTag: "summary", enableVision: false, mediaReply: true,
  timeAware: true, promptTimeZone: TZ, promptTimestampIncludeZone: false, nativeToolHistory: false,
});
const mkSnapshot = (history, preset, worldBooks) => ({
  format: "ai-phone-weixin-runtime", version: 1, promptEngineVersion: 2, createdAt: "2026-08-19T09:00:00Z",
  source: { app: "ai-phone", appId: "chat", appTags: ["chat", "text"], promptBuilder: "buildChatPromptMessages", note: "" },
  bot: { id: "b1", characterId: "c1", botToken: "t", enabled: true, addedAt: "" },
  character: { id: "c1", name: "小夏", description: "d", personality: "", scenario: "", firstMessage: "" },
  session: { id: "s1", contactId: "c1", createdAt: "", updatedAt: "" },
  messages: history, bindingSlot: {},
  apiConfig: { id: "a1", provider: "OpenAI", apiKey: "k", defaultModel: "m" },
  voiceConfig: null, preset, worldBooks, regexes: [], userIdentity: { name: "我" },
  memoryConfig: {}, memories: [], chatAppSettings: { timeAware: true },
  promptContext: mkContext(history), stats: {},
});

const flat = m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
// 只比对骨架：注入标记与消息标记的相对顺序，正是「插入位置 / 轮次粒度」这件事
const skeleton = msgs => (msgs.map(flat).join("\n").match(/P\d+|WB\d+|H\d+|W\d+/g) ?? []).join(" ");

const PATTERNS = [
  ["user"], ["user", "assistant"], ["user", "user"], ["user", "user", "user"],
  ["assistant", "assistant", "user"], ["user", "assistant", "assistant", "assistant", "user"],
  ["user", "assistant", "user", "assistant", "user", "assistant", "user"],
];

let total = 0;
const failures = [];
for (const bakedN of [0, 1, 3, 4, 8]) {
  for (const presetDepths of [[], [2], [4], [1, 3, 6]]) {
    for (const wbDepths of [[], [2], [5]]) {
      if (presetDepths.length === 0 && wbDepths.length === 0) continue;
      const preset = mkPreset(presetDepths);
      const worldBooks = mkWorldBooks(wbDepths);
      const baked = Array.from({ length: bakedN }, (_, i) => chatMsg(i + 1, ROLES[i % 2], `H${i + 1}`));
      const template = buildWeixinCloudPromptTemplate(mkSnapshot(baked, preset, worldBooks));

      for (const pattern of PATTERNS) {
        const newChat = pattern.map((role, i) => chatMsg(100 + i, role, `W${i}`));
        const newCloud = pattern.map((role, i) => ({
          externalId: `w${i}`, role, direction: role === "user" ? "inbound" : "outbound",
          content: `W${i}`, receivedAt: new Date(T0 + (100 + i) * 3600_000).toISOString(),
        }));
        const phone = buildWeixinCloudPromptMessages(
          mkSnapshot([...baked, ...newChat], preset, worldBooks), { skipEmptyGenerateGuard: true });
        const runtime = { promptContext: { ...mkContext(baked), promptTemplate: template } };
        const assistant = mergeAdjacentSameRoleMessages(
          normalizeLlmMessages(buildRuntimePromptMessages(runtime, newCloud, [])));

        total += 1;
        const expected = skeleton(phone);
        const actual = skeleton(assistant);
        if (expected !== actual) {
          failures.push({ bakedN, presetDepths, wbDepths, pattern: pattern.join("+"), expected, actual });
        }
      }
    }
  }
}

for (const f of failures.slice(0, 8)) {
  console.error(`❌ 烘焙历史=${f.bakedN} 预设深度=${JSON.stringify(f.presetDepths)} 世界书深度=${JSON.stringify(f.wbDepths)} 新消息=${f.pattern}`);
  console.error(`   小手机基准: ${f.expected}`);
  console.error(`   助手重组  : ${f.actual}`);
}
if (failures.length > 0) {
  console.error(`\n❌ 微信提示词等价性校验失败：${failures.length}/${total} 个场景不一致`);
  process.exit(1);
}
console.log(`✅ 微信提示词等价性校验通过：${total} 个场景，助手重组结果与小手机逐条一致`);
