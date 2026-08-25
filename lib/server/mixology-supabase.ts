/**
 * 独家特调专用 Supabase 连接。
 *
 * 特调的数据（mixology_items / mixology_recipes / mixology_likes / mixology_saves /
 * mixology_comments 五张表，外加 mixology_item_list / mixology_recipe_list 两个列表 RPC）
 * 已整体迁到独立的 Supabase 项目，只认这两个环境变量：
 *
 *   MIXOLOGY_SUPABASE_URL
 *   MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY
 *
 * 这里刻意不做任何 fallback：没配这两个变量就当「特调库没接」处理（setupRequired / 503），
 * 绝不回退到主库的 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY。主库现在只剩账号与 session
 * 那条线（getCurrentAccount，走 lib/server/supabase-rest.ts）——一旦回退，特调的读写会
 * 落回旧库，和新库对不上账。
 */
import { encodeSupabaseFilter, formatSupabaseRestError } from "./supabase-rest";

type MixologySupabaseConfig = {
  url: string;
  key: string;
};

export type MixologyRestResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status: number };

export function getMixologySupabaseConfig(): MixologySupabaseConfig | null {
  const url = (process.env.MIXOLOGY_SUPABASE_URL ?? "").trim();
  const key = (process.env.MIXOLOGY_SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

export function mixologySupabaseHeaders(config: { key: string }): HeadersInit {
  return {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
  };
}

export async function mixologyRestFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<MixologyRestResult<T>> {
  const config = getMixologySupabaseConfig();
  // 前缀带 mixology_，同时保留 missing_supabase_env 子串：
  // components/mixology/mixology-hall.tsx 用它判「本地部署没有云端后厨」
  if (!config) return { ok: false, error: "mixology_missing_supabase_env", status: 503 };

  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...mixologySupabaseHeaders(config),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === "object" && data && "message" in data
      ? String((data as { message?: unknown }).message)
      : text || response.statusText;
    return { ok: false, error: message, status: response.status };
  }

  return { ok: true, data: data as T, status: response.status };
}

// ── 封面资产桶 ──
// 封面从「base64 塞数据库行」迁到 Storage 公开桶：浏览器直连桶的公共 URL 拉图，
// 不再经 Netlify 函数解码转发、也不再占 PostgREST（详情行随之瘦身）。
// 写入走发布路径的转存 + cover 路由的惰性迁移，两边共用这里的上传工具。
const MIXOLOGY_ASSET_BUCKET = "mixology-assets";

function mixologyCoverExtension(mime: string): string {
  if (/png/i.test(mime)) return "png";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  return "jpg";
}

/** 解析 data:image/... 的 base64 封面；非法或超限返回 null。 */
export function decodeMixologyCoverDataUrl(value: string): { mime: string; bytes: Buffer } | null {
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
    if (bytes.length === 0 || bytes.length > 3 * 1024 * 1024) return null;
    return { mime, bytes };
  } catch {
    return null;
  }
}

async function ensureMixologyAssetBucket(config: MixologySupabaseConfig): Promise<void> {
  await fetch(`${config.url}/storage/v1/bucket`, {
    method: "POST",
    headers: mixologySupabaseHeaders(config),
    body: JSON.stringify({ id: MIXOLOGY_ASSET_BUCKET, name: MIXOLOGY_ASSET_BUCKET, public: true }),
  }).catch(() => {});
}

/**
 * 把 base64 封面转存到公开桶，返回公共 URL；任何失败返回 null（调用方回落到
 * 原 base64 路径，绝不能因为转存失败丢内容）。路径带内容哈希：封面变更得到新
 * URL，旧 URL 可长期 immutable 缓存。
 */
export async function uploadMixologyCoverToStorage(
  type: "material" | "recipe",
  id: string,
  coverDataUrl: string,
): Promise<string | null> {
  const config = getMixologySupabaseConfig();
  if (!config) return null;
  const decoded = decodeMixologyCoverDataUrl(coverDataUrl);
  if (!decoded) return null;
  try {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(decoded.bytes).digest("hex").slice(0, 16);
    const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    const path = `covers/${type}/${safeId}-${hash}.${mixologyCoverExtension(decoded.mime)}`;
    const objectUrl = `${config.url}/storage/v1/object/${MIXOLOGY_ASSET_BUCKET}/${path}`;
    const upload = async () => fetch(objectUrl, {
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
    let res = await upload();
    if (res.status === 400 || res.status === 404) {
      // 多半是桶还不存在（自部署首次用）：建桶后重试一次。
      await ensureMixologyAssetBucket(config);
      res = await upload();
    }
    if (!res.ok) return null;
    return `${config.url}/storage/v1/object/public/${MIXOLOGY_ASSET_BUCKET}/${path}`;
  } catch {
    return null;
  }
}

// 纯字符串处理，和连的是哪个库无关，直接复用主库那份实现，
// 顺带让 app/api/mixology/** 只 import 这一个模块（好 grep 出漏网的主库引用）
export { encodeSupabaseFilter as encodeMixologyFilter, formatSupabaseRestError as formatMixologyError };
