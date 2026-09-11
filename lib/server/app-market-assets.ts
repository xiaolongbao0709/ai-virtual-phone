// 应用市场图标资产：从「base64 塞 custom_app_market_apps 行」迁到 Storage 公开桶。
// 浏览器直连桶的公共 URL 拉图标，函数与 PostgREST 不再背图标字节，应用详情行
// 随之瘦身。桶复用应用包所在的 custom-app-market-packages（该桶本就是 public，
// 免去自部署用户建新桶），路径前缀 icons/ 隔离。写入走发布路径的转存 +
// icon 路由的惰性迁移，两边共用这里的上传工具。
import nodeCrypto from "crypto";

import { getSupabaseServerConfig } from "./supabase-rest";

const CUSTOM_APP_PACKAGE_BUCKET = "custom-app-market-packages";

function iconExtension(mime: string): string {
  if (/png/i.test(mime)) return "png";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  if (/svg/i.test(mime)) return "svg";
  return "jpg";
}

/** 解析 data:image/... 图标；非法或超限返回 null（上限与图标字段一致）。 */
export function decodeIconDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  if (!value.startsWith("data:image/")) return null;
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const meta = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  const mime = meta.split(";")[0]?.trim().toLowerCase() || "image/png";
  if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) return null;
  try {
    const bytes = meta.toLowerCase().includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) return null;
    return { mime, bytes };
  } catch {
    return null;
  }
}

/**
 * 把 base64 图标转存到公开桶，返回公共 URL；任何失败返回 null（调用方回落到
 * 原 base64，绝不能因转存失败丢图标）。路径带内容哈希：图标变更得到新 URL，
 * 旧 URL 可长期 immutable 缓存。
 */
export async function uploadAppIconToStorage(appRowId: string, iconDataUrl: string): Promise<string | null> {
  const config = getSupabaseServerConfig();
  if (!config) return null;
  const decoded = decodeIconDataUrl(iconDataUrl);
  if (!decoded) return null;
  try {
    const hash = nodeCrypto.createHash("sha256").update(decoded.bytes).digest("hex").slice(0, 16);
    const safeId = appRowId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    const path = `icons/${safeId}-${hash}.${iconExtension(decoded.mime)}`;
    const res = await fetch(`${config.url}/storage/v1/object/${CUSTOM_APP_PACKAGE_BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": decoded.mime,
        "x-upsert": "true",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      body: new Uint8Array(decoded.bytes),
    });
    if (!res.ok) return null;
    return `${config.url}/storage/v1/object/public/${CUSTOM_APP_PACKAGE_BUCKET}/${path}`;
  } catch {
    return null;
  }
}
