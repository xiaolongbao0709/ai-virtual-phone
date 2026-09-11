#!/usr/bin/env node
// 自定义 APP SDK 一致性校验
// 把四个“真相源”对齐，任何漂移立刻报错：
//   1. SDK 外壳 (custom-app-runner.tsx 的 window.AiPhone 封装)  —— App 能调到的方法
//   2. 宿主 dispatch (custom-app-runner.tsx 的 action === "...")  —— 真正会被处理的 action
//   3. 权限白名单 (custom-app-storage.ts normalizePermission)    —— 能声明的权限
//   4. 制作说明 (custom-app-creator-guide.ts)                     —— 文档承诺了什么
//
// 用法: node scripts/check-custom-app-sdk-consistency.mjs
// 退出码非 0 = 存在 ❌ 级别的不一致（可接入 CI / pre-commit）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const RUNNER = "components/app-market/custom-app-runner.tsx";
const STORAGE = "lib/custom-app-storage.ts";
const HOSTAPI = "lib/custom-app-host-api.ts";
const GUIDE = "lib/custom-app-creator-guide.ts";

const runner = read(RUNNER);
const storage = read(STORAGE);
const hostapi = read(HOSTAPI);
const guide = read(GUIDE);

// 顶层命名空间（用于过滤“像权限/方法”的 token，降噪）
const NAMESPACES = new Set([
  "app", "db", "ai", "user", "network", "tools", "events", "chat",
  "characters", "ui", "notifications", "tasks", "wallet", "memory",
  "voice", "calendar", "world", "media", "geo", "room", "cloud", "bridge",
]);

// ---------- 1. SDK 外壳：方法 -> 它发送的 action ----------
const apiStart = runner.indexOf("var api = {");
const apiEnd = runner.indexOf("window.AiPhone = Object.assign");
if (apiStart < 0 || apiEnd < 0) { console.error("无法定位 runner 里的 SDK 外壳 (var api = {})"); process.exit(2); }
const apiBlock = runner.slice(apiStart, apiEnd);

const wrapperMethods = new Set();        // "ns.method"
const methodToAction = new Map();        // "ns.method" -> action
const wrapperActions = new Set();        // 外壳会发送的 action
{
  let ns = null;
  for (const line of apiBlock.split("\n")) {
    const nsOpen = line.match(/^\s{4}(\w+):\s*\{/);
    if (nsOpen && NAMESPACES.has(nsOpen[1])) { ns = nsOpen[1]; continue; }
    const topMethod = line.match(/^\s{4}(\w+):\s*(?:function|onEvent|offEvent)/);
    if (topMethod) { wrapperMethods.add(topMethod[1]); }
    const method = line.match(/^\s{6,}(\w+):\s*function/);
    const req = line.match(/request\((['"])([\w.]+)\1/);
    if (method && ns) {
      const key = `${ns}.${method[1]}`;
      wrapperMethods.add(key);
      if (req) { methodToAction.set(key, req[2]); wrapperActions.add(req[2]); }
    } else if (req) {
      wrapperActions.add(req[2]);
    }
  }
}

// ---------- 2. 宿主 dispatch：真正处理的 action ----------
const dispatchActions = new Set();
for (const m of runner.matchAll(/action === (['"])([\w.]+)\1/g)) dispatchActions.add(m[2]);
const dbPrefixHandled = /action\.startsWith\((['"])db\.\1\)/.test(runner);
const roomPrefixHandled = /action\.startsWith\((['"])room\.\1\)/.test(runner);
const cloudPrefixHandled = /action\.startsWith\((['"])cloud\.\1\)/.test(runner);
const actionHandled = (a) => dispatchActions.has(a)
  || (dbPrefixHandled && a.startsWith("db."))
  || (roomPrefixHandled && a.startsWith("room."))
  || (cloudPrefixHandled && a.startsWith("cloud."));

// ---------- 3. 权限白名单 ----------
const allowStart = storage.indexOf("const allowed = new Set");
const allowSlice = storage.slice(allowStart, storage.indexOf("]", allowStart));
const allowedPerms = new Set([...allowSlice.matchAll(/["']([\w.]+)["']/g)].map((m) => m[1]));

// 权限是否被实际用到（requirePermission / requireAnyPermission / hasPermission / HOST_ACTION_PERMISSIONS）
const usedPerms = new Set();
for (const src of [runner, hostapi]) {
  for (const m of src.matchAll(/requirePermission\((['"])([\w.]+)\1/g)) usedPerms.add(m[2]);
  for (const m of src.matchAll(/requireAnyPermission\(\[([^\]]+)\]/g))
    for (const p of m[1].matchAll(/["']([\w.]+)["']/g)) usedPerms.add(p[1]);
  for (const m of src.matchAll(/hasPermission\([^,]+,\s*(['"])([\w.]+)\1/g)) usedPerms.add(m[2]);
}
// HOST_ACTION_PERMISSIONS 映射里出现的权限值
const hap = hostapi.match(/HOST_ACTION_PERMISSIONS[^=]*=\s*\{([\s\S]*?)\n\};/);
if (hap) for (const m of hap[1].matchAll(/\[([^\]]*)\]/g))
  for (const p of m[1].matchAll(/["']([\w.]+)["']/g)) usedPerms.add(p[1]);

// ---------- 4. 说明书：提到的方法与权限 ----------
const guideMethods = new Set();
for (const m of guide.matchAll(/AiPhone(?:App)?\.(\w+)\.(\w+)/g)) guideMethods.add(`${m[1]}.${m[2]}`);
for (const m of guide.matchAll(/AiPhone(?:App)?\.(on|off)\b/g)) guideMethods.add(m[1]);

const permSecStart = guide.indexOf("可用权限");
let permSecEnd = guide.indexOf("## 前端要求", permSecStart);
if (permSecEnd < 0) permSecEnd = permSecStart + 6000;
const permSec = guide.slice(permSecStart, permSecEnd);
const guidePerms = new Set();
// 只取每条权限条目“冒号前”的标识符，避免把正文里提到的方法名（如 chat.history）误判为权限
for (const bullet of permSec.matchAll(/-\s*([^：\n]+?)：/g))
  for (const t of bullet[1].matchAll(/\b([a-z]+(?:\.[a-z]+){1,3})\b/g))
    if (NAMESPACES.has(t[1].split(".")[0])) guidePerms.add(t[1]);

// ---------- 交叉比对 ----------
const errors = [];
const warns = [];

// ❌ 外壳暴露了方法，但它发送的 action 没有 dispatch 处理 → 调用必报错
for (const [method, action] of methodToAction)
  if (!actionHandled(action))
    errors.push(`SDK 方法 AiPhone.${method}() 发送 action "${action}"，但 dispatch 没有处理 → 调用会抛“未知动作”`);

// ❌ 说明书写了 AiPhone.x.y，但外壳里没有这个方法
for (const gm of guideMethods)
  if (!wrapperMethods.has(gm))
    errors.push(`说明书出现 AiPhone.${gm}()，但 SDK 外壳里没有这个方法`);

// ❌ 说明书“可用权限”里列了一个不在白名单的权限
for (const gp of guidePerms)
  if (!allowedPerms.has(gp))
    errors.push(`说明书“可用权限”提到 "${gp}"，但权限白名单里没有 → 声明后会被静默丢弃`);

// ⚠️ 白名单里的权限从没被任何地方用来鉴权 → 预留/未实现
for (const p of allowedPerms)
  if (!usedPerms.has(p))
    warns.push(`权限 "${p}" 在白名单中，但代码里没有任何 requirePermission/hasPermission 使用它 → 可能是预留或未实现`);

// ⚠️ dispatch 有 action，但外壳没有对应发送入口（可能内部用，或外壳漏封装）
const INTERNAL_ACTIONS = new Set([
  "app.getManifest", "app.getCapabilities", "app.getAssetUrl", "app.close",
  "events.subscribe", "events.unsubscribe",
  "tools.registerHandler", "tools.unregisterHandler",
]);
for (const a of dispatchActions)
  if (!wrapperActions.has(a) && !INTERNAL_ACTIONS.has(a) && !a.startsWith("db."))
    warns.push(`dispatch 处理 action "${a}"，但 SDK 外壳里没有方法发送它（App 调不到，除非内部使用）`);

// ---------- 报告 ----------
const line = "─".repeat(60);
console.log(line);
console.log("自定义 APP SDK 一致性校验");
console.log(line);
console.log(`SDK 外壳方法: ${wrapperMethods.size} | dispatch action: ${dispatchActions.size} | 权限白名单: ${allowedPerms.size} | 说明书方法: ${guideMethods.size}`);
console.log("");

if (errors.length === 0) console.log("✅ 没有发现 ❌ 级别的不一致");
else {
  console.log(`❌ 发现 ${errors.length} 处必须修复的不一致：\n`);
  errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
}
console.log("");
if (warns.length) {
  console.log(`⚠️  ${warns.length} 处提醒（不一定是 bug，但值得核对）：\n`);
  warns.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
}
console.log(line);

process.exit(errors.length > 0 ? 1 : 0);
