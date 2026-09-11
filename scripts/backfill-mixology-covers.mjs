// 独家特调 · 存量条目封面批量补拍。
//
// 背景：小票/尾调的"渲染图封面"是上架时在作者浏览器里现拍的（lib/mixology/mat-thumb.ts），
// 存量条目上架时还没有这回事，云端 cover 一直是空的；现有的 backfillThumbs 只能在
// 作者本人进「我的发布」时补（依赖作者本地的整份材料），别人发布的老条目永远等不到。
// 但 mixology_items.payload 里本来就存着 renderHtml + previewRaw——服务端直接批量渲染即可。
//
// 做法：按 ticket-doc 同一套装配逻辑拼出完整 HTML，无头 Chromium 渲染后按
// mat-thumb 同规格拍缩略图（360 宽排版 → 降采样到最宽 300 / 最高 420 的透明底 WebP），
// 传到 mixology-assets 公开桶（哈希文件名 + 一年 immutable），最后只回写 cover 列、
// 不动 updated_at——补封面不该把老条目顶到大厅最前面。
//
// 跑法（puppeteer 不在依赖里，避免 Netlify 构建时下载 Chromium，需先临时安装）：
//   npm i -D puppeteer && node scripts/backfill-mixology-covers.mjs && npm remove puppeteer
// 环境变量沿用特调库那两个：MIXOLOGY_SUPABASE_URL / MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY
//（没导出的话会从 .env.local 里读）。可选参数：
//   --dry          只列出会补哪些条目，不渲染不写库
//   --force        已有封面的也重拍（比如想把换制前作者手传的旧图统一换成渲染图）
//   --id=mxi_xxx   只补这一条
//   --limit=N      最多处理 N 条（默认全部）

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 与 lib/mixology/mat-thumb.ts 同口径的拍摄参数 ──
const RENDER_W = 360;
const MAX_W = 300;
const MAX_H = 420;
const QUALITY = 72;
const MAX_BYTES = 300 * 1024;
const SETTLE_MS = 420;
const PAGE_TIMEOUT_MS = 10_000;

const ASSET_BUCKET = "mixology-assets";

// ── 参数 ──
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const FORCE = argv.includes("--force");
const ONLY_ID = (argv.find((a) => a.startsWith("--id=")) ?? "").slice(5);
const LIMIT = Number((argv.find((a) => a.startsWith("--limit=")) ?? "").slice(8)) || Infinity;

// ── 环境变量：优先 process.env，缺了从 .env.local 捞 ──
function readEnvLocal(name) {
  try {
    const text = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
    const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`, "m"));
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}
const SUPABASE_URL = (process.env.MIXOLOGY_SUPABASE_URL || readEnvLocal("MIXOLOGY_SUPABASE_URL")).trim().replace(/\/$/, "");
const SUPABASE_KEY = (process.env.MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY || readEnvLocal("MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY")).trim();
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("缺少 MIXOLOGY_SUPABASE_URL / MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY（环境变量或 .env.local）。");
  process.exit(1);
}

function restHeaders(extra = {}) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...extra };
}

async function rest(pathname, init) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, { ...init, headers: restHeaders(init?.headers) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message = data && typeof data === "object" && "message" in data ? String(data.message) : text || res.statusText;
    throw new Error(`${res.status} ${message}`);
  }
  return data;
}

// ── 与 lib/mixology/ticket-doc.ts 的 buildMixTicketDoc 同一套装配 ──
function escapeHtmlText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildTicketDoc(html, raw) {
  const withRaw = html.split("{{RAW}}").join(escapeHtmlText(raw));
  const base = /<html[\s>]/i.test(withRaw)
    ? withRaw
    : `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body>${withRaw}</body></html>`;
  const inject = `<script>window.TICKET_RAW=${JSON.stringify(raw)};window.ENCORE_RAW=window.TICKET_RAW;window.MIX_STATE={};</` + `script>`;
  return /<head[\s>]/i.test(base)
    ? base.replace(/<head([^>]*)>/i, `<head$1>${inject}`)
    : inject + base;
}

// ── 与 mat-thumb.ts 的 thumbSource 同口径：这条有没有可拍的自动封面 ──
function thumbSource(kind, payload) {
  if (!payload || typeof payload !== "object") return null;
  if (kind === "ticket") {
    const html = String(payload.renderHtml ?? "").trim();
    const raw = String(payload.previewRaw ?? "").trim();
    return html && raw ? { html, raw } : null;
  }
  if (kind === "encore") {
    // 尾调新旧字段统一出口（等价 mixEncoreRenderHtml）
    const html = String(payload.renderHtml ?? payload.html ?? "").trim();
    if (!html) return null;
    const raw = String(payload.previewRaw ?? "").trim();
    // AI 供稿型没留示例数据就渲染不出内容，别拍一张空壳
    if (String(payload.contract ?? "").trim() && !raw) return null;
    return { html, raw };
  }
  return null;
}

// ── 渲染 + 拍照：360 宽排版，deviceScaleFactor 降采样，透明底 WebP ──
async function shoot(browser, doc) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: RENDER_W, height: MAX_H, deviceScaleFactor: 1 });
    await page.setContent(doc, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS });
    // 等渲染代码把 DOM 画完（它可能在 load 之后才填内容），与线上抓拍同一拍
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const size = await page.evaluate(() => {
      // 折叠件保持收起状态原样拍：与线上拍图和酒柜卡的实时缩样同口径（见 mat-thumb.ts）
      const b = document.body;
      if (!b) return { w: 1, h: 1 };
      const cs = window.getComputedStyle(b);
      const mt = parseFloat(cs.marginTop) || 0;
      const mb = parseFloat(cs.marginBottom) || 0;
      let h = b.getBoundingClientRect().height + mt + mb;
      for (const child of b.children) {
        const c = child.getBoundingClientRect();
        if (c.width || c.height) h = Math.max(h, c.bottom + mb);
      }
      const w = Math.ceil(document.documentElement.getBoundingClientRect().width) || 0;
      return { w: Math.max(1, w), h: Math.max(1, Math.ceil(h)) };
    });
    // 只按宽度缩放；太高的渲染裁掉下半截，不整体压成一根细条
    const k = Math.min(1, MAX_W / size.w);
    if (k < 1) await page.setViewport({ width: RENDER_W, height: MAX_H, deviceScaleFactor: k });
    const clipH = Math.min(size.h, Math.round(MAX_H / k));
    const buffer = await page.screenshot({
      type: "webp",
      quality: QUALITY,
      omitBackground: true,
      clip: { x: 0, y: 0, width: size.w, height: clipH },
    });
    // 拍出来大得离谱就不要了（渲染代码里塞了大图之类），别把这种东西传上去
    if (!buffer || buffer.length === 0 || buffer.length > MAX_BYTES) return null;
    return Buffer.from(buffer);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── 与 lib/server/mixology-supabase.ts 的 uploadMixologyCoverToStorage 同一套路径规则 ──
async function uploadCover(id, bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const objectPath = `covers/material/${safeId}-${hash}.webp`;
  const objectUrl = `${SUPABASE_URL}/storage/v1/object/${ASSET_BUCKET}/${objectPath}`;
  const upload = () => fetch(objectUrl, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "image/webp",
      "x-upsert": "true",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
    body: new Uint8Array(bytes),
  });
  let res = await upload();
  if (res.status === 400 || res.status === 404) {
    // 多半是桶还不存在（自部署首次用）：建桶后重试一次
    await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: "POST",
      headers: restHeaders(),
      body: JSON.stringify({ id: ASSET_BUCKET, name: ASSET_BUCKET, public: true }),
    }).catch(() => {});
    res = await upload();
  }
  if (!res.ok) throw new Error(`Storage 上传失败：${res.status} ${await res.text().catch(() => "")}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${ASSET_BUCKET}/${objectPath}`;
}

async function launchBrowser() {
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    puppeteer = (await import("puppeteer-core")).default;
  }
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
}

async function main() {
  // 只拉小票/尾调：其余种类要么没有自动封面这回事（角色卡用作者配图），要么不上图
  const filters = ["deleted_at=is.null", "kind=in.(ticket,encore)", "select=id,kind,name,cover,payload,updated_at", "order=updated_at.desc"];
  if (ONLY_ID) filters.unshift(`id=eq.${encodeURIComponent(ONLY_ID)}`);
  else if (!FORCE) filters.unshift("or=(cover.is.null,cover.eq.%22%22)");
  const rows = await rest(`mixology_items?${filters.join("&")}`, { headers: { Range: "0-9999" } });
  const targets = [];
  const skipped = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (targets.length >= LIMIT) break;
    if (!FORCE && !ONLY_ID && String(row.cover ?? "").trim()) continue;
    const source = thumbSource(row.kind, row.payload);
    if (source) targets.push({ ...row, source });
    else skipped.push(row);
  }

  console.log(`待补封面：${targets.length} 条${skipped.length ? `（另有 ${skipped.length} 条没留渲染代码/示例数据，拍不出图，跳过）` : ""}`);
  for (const row of skipped) console.log(`  · 跳过 [${row.kind}] ${row.name}（${row.id}）`);
  if (DRY || targets.length === 0) {
    for (const row of targets) console.log(`  · 会补 [${row.kind}] ${row.name}（${row.id}）`);
    return;
  }

  const browser = await launchBrowser();
  let ok = 0;
  let fail = 0;
  try {
    for (const row of targets) {
      const label = `[${row.kind}] ${row.name}（${row.id}）`;
      try {
        const bytes = await shoot(browser, buildTicketDoc(row.source.html, row.source.raw));
        if (!bytes) {
          fail += 1;
          console.warn(`✗ ${label}：拍出来是空的或超过 ${MAX_BYTES / 1024}KB，跳过`);
          continue;
        }
        const url = await uploadCover(row.id, bytes);
        // 首次补空封面只写 cover 一列：不动 updated_at，不会把老条目顶到大厅最前面。
        // 换掉已有封面（--force 重拍）时把 updated_at 悄悄 +1 秒：列表的封面代理
        // /api/mixology/cover 带 v=updated_at 且 CDN 按年 immutable 缓存，v 不变的话
        // 新图永远被旧缓存挡住；+1 秒不足以改变列表排序。
        const patch = { cover: url };
        const oldCover = String(row.cover ?? "").trim();
        if (oldCover && oldCover !== url) {
          const stamp = Date.parse(String(row.updated_at ?? ""));
          if (Number.isFinite(stamp)) patch.updated_at = new Date(stamp + 1000).toISOString();
        }
        await rest(`mixology_items?id=eq.${encodeURIComponent(row.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(patch),
        });
        ok += 1;
        console.log(`✓ ${label} ${(bytes.length / 1024).toFixed(1)}KB → ${url}`);
      } catch (err) {
        fail += 1;
        console.warn(`✗ ${label}：${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`完成：成功 ${ok} 条，失败 ${fail} 条。大厅列表有 60 秒 CDN 缓存，稍等片刻或下拉刷新即可看到新封面。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
