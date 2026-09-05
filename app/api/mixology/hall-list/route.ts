import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import {
  encodeMixologyFilter,
  formatMixologyError,
  getMixologySupabaseConfig,
  mixologyRestFetch,
} from "@/lib/server/mixology-supabase";

const MATERIAL_KINDS = ["character", "persona", "preface", "base", "flavor", "glass", "strength", "ticket", "garnish", "encore", "checklist", "filter", "mechanism"] as const;
type HallType = "material" | "recipe";

type HallListRow = {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  hook?: unknown;
  tags?: unknown;
  intro?: unknown;
  char_name?: unknown;
  part_names?: unknown;
  author_id?: unknown;
  author_name?: unknown;
  author_avatar?: unknown;
  like_count?: unknown;
  save_count?: unknown;
  view_count?: unknown;
  comment_count?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  has_cover?: unknown;
  cover?: unknown;
};

const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Netlify-CDN-Cache-Control": "public, durable, s-maxage=120, stale-while-revalidate=600",
  "Netlify-Vary": "query",
} as const;

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function clampCount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => cleanText(item, 24)).filter(Boolean).slice(0, 20);
}

function parseType(value: unknown): HallType | null {
  return value === "material" || value === "recipe" ? value : null;
}

function isMissingRpcError(message: string): boolean {
  return /mixology_(item|recipe)_list|PGRST202|Could not find the function|schema cache|does not exist/i.test(message);
}

function isMissingTableError(message: string): boolean {
  return /mixology_items|mixology_recipes/i.test(message)
    && /PGRST20[45]|Could not find the table|schema cache|does not exist/i.test(message);
}

function coverUrl(type: HallType, id: string, updatedAt: string, hasCover: boolean): string {
  if (!hasCover) return "";
  return `/api/mixology/cover?type=${type}&id=${encodeURIComponent(id)}&v=${encodeURIComponent(updatedAt)}`;
}

function normalizeEntry(type: HallType, row: HallListRow, optimized: boolean): Record<string, unknown> | null {
  const id = cleanText(row.id, 160);
  const name = cleanText(row.name, 80);
  if (!id || !name) return null;
  const updatedAt = cleanText(row.updated_at, 80) || new Date().toISOString();
  const rawCover = cleanText(row.cover, 2_000_000);
  const hasCover = row.has_cover === true || row.has_cover === "true";
  const base = {
    id,
    name,
    authorId: cleanText(row.author_id, 160) || "anonymous",
    authorName: cleanText(row.author_name, 80) || "匿名调酒师",
    authorAvatar: cleanText(row.author_avatar, 300_000),
    cover: optimized ? coverUrl(type, id, updatedAt, hasCover) : rawCover,
    likeCount: clampCount(row.like_count),
    saveCount: clampCount(row.save_count),
    viewCount: clampCount(row.view_count),
    commentCount: clampCount(row.comment_count),
    createdAt: cleanText(row.created_at, 80) || updatedAt,
    updatedAt,
  };
  if (type === "material") {
    const kind = cleanText(row.kind, 20);
    if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) return null;
    return { ...base, kind, hook: cleanText(row.hook, 200), tags: normalizeTags(row.tags) };
  }
  return {
    ...base,
    intro: cleanText(row.intro, 400),
    charName: cleanText(row.char_name, 80),
    partNames: normalizeTags(row.part_names),
  };
}

async function loadRows(type: HallType, authorId: string | null, kind: string | null) {
  const rpcPath = type === "material" ? "rpc/mixology_item_list" : "rpc/mixology_recipe_list";
  const body = type === "material"
    ? { p_author_id: authorId, p_kind: kind }
    : { p_author_id: authorId };
  const rpc = await mixologyRestFetch<HallListRow[]>(rpcPath, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (rpc.ok) return { ok: true as const, data: rpc.data, optimized: true };
  if (!isMissingRpcError(rpc.error)) return { ok: false as const, error: rpc.error, status: rpc.status };

  const table = type === "material" ? "mixology_items" : "mixology_recipes";
  const columns = type === "material"
    ? "id,kind,name,hook,cover,tags,author_id,author_name,author_avatar,like_count,save_count,view_count,comment_count,created_at,updated_at"
    : "id,name,intro,cover,char_name,part_names,author_id,author_name,author_avatar,like_count,save_count,view_count,comment_count,created_at,updated_at";
  const filters = ["deleted_at=is.null", `select=${columns}`, "order=updated_at.desc", "limit=100"];
  if (authorId) filters.unshift(`author_id=eq.${encodeMixologyFilter(authorId)}`);
  if (type === "material" && kind) filters.unshift(`kind=eq.${encodeMixologyFilter(kind)}`);
  const fallback = await mixologyRestFetch<HallListRow[]>(`${table}?${filters.join("&")}`);
  if (!fallback.ok) return { ok: false as const, error: fallback.error, status: fallback.status };
  return { ok: true as const, data: fallback.data, optimized: false };
}

export async function GET(request: Request) {
  try {
    if (!getMixologySupabaseConfig()) {
      return NextResponse.json({ ok: true, entries: [], setupRequired: true });
    }
    const url = new URL(request.url);
    const type = parseType(url.searchParams.get("type"));
    if (!type) return NextResponse.json({ ok: false, error: "missing_type", entries: [] }, { status: 400 });
    const mine = url.searchParams.get("mine") === "1";
    const account = mine ? await getCurrentAccount(request) : null;
    if (mine && !account) return NextResponse.json({ ok: true, entries: [] });
    const rawKind = type === "material" ? cleanText(url.searchParams.get("kind"), 20) : "";
    const kind = rawKind && (MATERIAL_KINDS as readonly string[]).includes(rawKind) ? rawKind : null;

    const result = await loadRows(type, mine ? account!.id : null, kind);
    if (!result.ok) {
      if (isMissingTableError(result.error)) {
        return NextResponse.json({ ok: true, entries: [], setupRequired: true, error: result.error });
      }
      return NextResponse.json({ ok: false, entries: [], error: result.error }, { status: result.status });
    }
    const entries = result.data
      .map(row => normalizeEntry(type, row, result.optimized))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    return NextResponse.json({ ok: true, entries }, mine ? undefined : { headers: PUBLIC_CACHE_HEADERS });
  } catch (err) {
    return NextResponse.json({ ok: false, entries: [], error: formatMixologyError(err) }, { status: 500 });
  }
}
