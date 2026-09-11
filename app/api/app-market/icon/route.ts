import { NextResponse } from "next/server";

import { uploadAppIconToStorage } from "@/lib/server/app-market-assets";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

type IconRow = { id?: unknown; icon_data_url?: unknown; review_status?: unknown; author_id?: unknown };
function cleanText(value: unknown, maxLength: number): string { return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength); }
function cleanId(value: unknown): string { return cleanText(value, 120).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); }
function decodeDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  if (!value.startsWith("data:image/")) return null;
  const comma = value.indexOf(","); if (comma < 0) return null;
  const meta = value.slice(5, comma); const payload = value.slice(comma + 1);
  const mime = meta.split(";")[0]?.trim().toLowerCase() || "image/png";
  if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) return null;
  try {
    const bytes = meta.toLowerCase().includes(";base64") ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) return null;
    return { mime, bytes };
  } catch { return null; }
}
export async function GET(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return new Response(null, { status: 404 });
    const url = new URL(request.url); const id = cleanId(url.searchParams.get("id"));
    if (!id) return new Response(null, { status: 400 });
    const result = await supabaseRestFetch<IconRow[]>(`custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&deleted_at=is.null&select=id,icon_data_url,review_status,author_id&limit=1`);
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    const row = result.data[0]; if (!row) return new Response(null, { status: 404 });
    const isPublic = row.review_status === "approved";
    if (!isPublic) {
      const account = await getCurrentAccount(request);
      if (!account || cleanText(row.author_id, 160) !== account.id) return new Response(null, { status: 404 });
    }
    const cacheHeaders: Record<string, string> = isPublic
      ? {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Netlify-CDN-Cache-Control": "public, durable, s-maxage=31536000, immutable",
        "Netlify-Vary": "query",
      }
      : { "Cache-Control": "private, max-age=300" };
    const stored = cleanText(row.icon_data_url, 2_000_000);
    // 图标列双格式：已迁移的行存 Storage 公开桶 URL，302 让浏览器直连拉图。
    if (/^https?:\/\//i.test(stored)) {
      return new Response(null, { status: 302, headers: { ...cacheHeaders, Location: stored } });
    }
    // 存量 base64 的惰性迁移：公开图标第一次被请求时顺手转存到桶并回写行，
    // 之后（含本次）都 302；转存失败照旧从函数下发字节。
    if (isPublic) {
      const migrated = await uploadAppIconToStorage(id, stored);
      if (migrated) {
        await supabaseRestFetch(
          `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&deleted_at=is.null`,
          { method: "PATCH", body: JSON.stringify({ icon_data_url: migrated }) },
        ).catch(() => null);
        return new Response(null, { status: 302, headers: { ...cacheHeaders, Location: migrated } });
      }
    }
    const decoded = decodeDataUrl(stored);
    if (!decoded) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(decoded.bytes), {
      status: 200,
      headers: { ...cacheHeaders, "Content-Type": decoded.mime, "Content-Length": String(decoded.bytes.length), "X-Content-Type-Options": "nosniff" },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}
