#!/usr/bin/env node

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public/ai-phone-push");
mkdirSync(output, { recursive: true });

copyFileSync(resolve(root, "supabase/functions/ai-phone-push/index.ts"), resolve(output, "gateway.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-generate/index.ts"), resolve(output, "push-generate.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-shortcut-result/index.ts"), resolve(output, "push-shortcut-result.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-bridge/index.ts"), resolve(output, "push-bridge.mjs"));
copyFileSync(resolve(root, "supabase/functions/screen-chat/index.ts"), resolve(output, "screen-chat.mjs"));
copyFileSync(resolve(root, "docs/personal-push-supabase.sql"), resolve(output, "schema.sql"));

console.log("[personal-push-dist] 已生成个人离线推送部署包。");
