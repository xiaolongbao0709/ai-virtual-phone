#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["supabase/functions/ai-phone-push/index.ts", "public/ai-phone-push/gateway.mjs"],
  ["supabase/functions/push-generate/index.ts", "public/ai-phone-push/push-generate.mjs"],
  ["supabase/functions/push-shortcut-result/index.ts", "public/ai-phone-push/push-shortcut-result.mjs"],
  ["supabase/functions/push-bridge/index.ts", "public/ai-phone-push/push-bridge.mjs"],
  ["supabase/functions/screen-chat/index.ts", "public/ai-phone-push/screen-chat.mjs"],
  ["docs/personal-push-supabase.sql", "public/ai-phone-push/schema.sql"],
];

const failures = [];
for (const [source, output] of pairs) {
  const sourceText = readFileSync(resolve(root, source), "utf8");
  const outputText = readFileSync(resolve(root, output), "utf8");
  if (sourceText !== outputText) failures.push(`${output} 与 ${source} 不一致`);
}

const forbiddenOrigin = "floatbubble.netlify.app";
for (const file of [...new Set(pairs.flat())]) {
  if (readFileSync(resolve(root, file), "utf8").includes(forbiddenOrigin)) {
    failures.push(`${file} 含有私有站点地址`);
  }
}

if (failures.length > 0) {
  console.error(failures.map(item => `- ${item}`).join("\n"));
  console.error("请运行 npm run push:build-dist 后重试。");
  process.exit(1);
}

console.log("[personal-push-dist] 源文件、公开部署包与通用站点配置一致。");
