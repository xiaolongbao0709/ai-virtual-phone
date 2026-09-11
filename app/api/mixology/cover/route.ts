import { NextResponse } from "next/server";

import {
  encodeMixologyFilter,
  formatMixologyError,
  getMixologySupabaseConfig,
  mixologyRestFetch,
  uploadMixologyCoverToStorage,
} from "@/lib/server/mixology-supabase";

type CoverRow = { cover?: unknown };
type HallType = "material" | "recipe";

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function parseType(value: unknown): HallType | null {
  return value === "material" || value === "recipe" ? value : null;
}

function decodeDataUrl(value: string): { mime: string; bytes: Buffer } | null {
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

const IMMUTABLE_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "Netlify-CDN-Cache-Control": "public, durable, s-maxage=31536000, immutable",
  "Netlify-Vary": "query",
} as const;

export async function GET(request: Request) {
  try {
    if (!getMixologySupabaseConfig()) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    const type = parseType(url.searchParams.get("type"));
    const id = cleanText(url.searchParams.get("id"), 160);
    if (!type || !id) return new Response(null, { status: 400 });
    const table = type === "material" ? "mixology_items" : "mixology_recipes";
    const result = await mixologyRestFetch<CoverRow[]>(
      `${table}?id=eq.${encodeMixologyFilter(id)}&deleted_at=is.null&select=cover&limit=1`,
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    const cover = cleanText(result.data[0]?.cover, 3_000_000);
    if (!cover) return new Response(null, { status: 404 });

    if (/^https?:\/\//i.test(cover)) {
      return new Response(null, {
        status: 302,
        headers: { ...IMMUTABLE_HEADERS, Location: cover },
      });
    }

    // 存量 base64 封面的惰性迁移：第一次被请求时顺手转存到公开桶并回写行，
    // 之后（含本次）都 302 到桶的公共 URL；转存失败则照旧从函数下发字节。
    const migratedUrl = await uploadMixologyCoverToStorage(type, id, cover);
    if (migratedUrl) {
      await mixologyRestFetch(
        `${table}?id=eq.${encodeMixologyFilter(id)}&deleted_at=is.null`,
        { method: "PATCH", body: JSON.stringify({ cover: migratedUrl }) },
      ).catch(() => null);
      return new Response(null, {
        status: 302,
        headers: { ...IMMUTABLE_HEADERS, Location: migratedUrl },
      });
    }

    const decoded = decodeDataUrl(cover);
    if (!decoded) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(decoded.bytes), {
      status: 200,
      headers: {
        ...IMMUTABLE_HEADERS,
        "Content-Type": decoded.mime,
        "Content-Length": String(decoded.bytes.length),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatMixologyError(err) }, { status: 500 });
  }
}
