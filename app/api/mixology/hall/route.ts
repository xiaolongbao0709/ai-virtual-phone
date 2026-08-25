import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { getMixologySupabaseConfig, mixologyRestFetch, uploadMixologyCoverToStorage } from "@/lib/server/mixology-supabase";
import { normalizeRecipeParts as normalizeParts, validateMechanismPayload, type RecipePartRef } from "@/lib/mixology/hall-parts";

// 独家特调 · 酒材/配方 API：材料（mixology_items）与配方（mixology_recipes）共用一套路由，
// type=material|recipe 区分。全部经 service key 直连 Supabase REST，anon 无直读。
//
// 配方条目的 materials 列只存"槽位引用"数组 [{id,kind,name,builtin?,when?}]：
// builtin 指官方出厂件（客户端本地解析）；其余 id 指向 mixology_items 条目；
// when 是这一件的生效条件。同一 kind 可以出现多条（一格叠多件），数组顺序即叠放顺序。
// 详情接口现场联表把引用换成完整材料内容；已下架的标 gone。

const MATERIAL_KINDS = ["character", "persona", "base", "flavor", "glass", "strength", "ticket", "garnish", "encore", "filter", "mechanism"] as const;

const ITEM_SUMMARY_COLUMNS = "id,kind,name,hook,cover,tags,author_id,author_name,author_avatar,like_count,save_count,view_count,comment_count,created_at,updated_at";
const ITEM_COLUMNS = `${ITEM_SUMMARY_COLUMNS},payload`;
const RECIPE_SUMMARY_COLUMNS = "id,name,intro,cover,char_name,part_names,author_id,author_name,author_avatar,like_count,save_count,view_count,comment_count,created_at,updated_at";
const RECIPE_COLUMNS = `${RECIPE_SUMMARY_COLUMNS},materials`;

const MAX_MATERIAL_PAYLOAD = 900_000;
// 配方只存引用，不再内嵌材料内容，尺寸上限相应收紧
const MAX_RECIPE_PARTS_PAYLOAD = 20_000;

type HallType = "material" | "recipe";

const TABLES: Record<HallType, string> = {
  material: "mixology_items",
  recipe: "mixology_recipes",
};

/**
 * 列表（非"我的发布"）的 CDN 缓存头：列表不含任何按用户注入的字段
 *（likedByMe/savedByMe 只在详情里给），响应对所有人相同，让 Netlify 边缘
 * 挡掉重复回源——列表带封面 base64，是特调这边 Supabase 出站的大头。
 */
// 发布/更新时把 base64 封面转存到 Storage 公开桶，DB 只存公共 URL：
// 浏览器直连桶拉图，函数与 PostgREST 都不再背封面字节。转存失败回落
// 原 base64（老链路照常工作），空值或已是 URL 的原样保留。
async function resolveCoverForWrite(type: HallType, id: string, rawCover: unknown): Promise<string> {
  const cover = cleanText(rawCover, 2_000_000);
  if (!cover.startsWith("data:image/")) return cover;
  const url = await uploadMixologyCoverToStorage(type, id, cover);
  return url || cover;
}

const CDN_LIST_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Netlify-CDN-Cache-Control": "public, durable, s-maxage=60, stale-while-revalidate=300",
  // 必须显式让缓存键包含查询参数：Netlify 对函数响应默认忽略 query，
  // 不加这行，第一份缓存会顶掉所有 type/kind/mine/id 组合的响应
  "Netlify-Vary": "query",
} as const;

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function clampCount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.round(amount));
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, 24)).filter(Boolean).slice(0, 8);
  return [];
}

function encodeFilter(value: string): string {
  return encodeURIComponent(value);
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatSupabaseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && "cause" in err ? String((err as { cause?: unknown }).cause ?? "") : "";
  const details = `${message} ${cause}`;
  if (/getaddrinfo|EAI_AGAIN|ENOTFOUND/i.test(details)) return "Supabase 域名解析失败，请检查当前 Next 运行环境的网络/DNS。";
  if (/fetch failed/i.test(message)) return "无法连接 Supabase，请检查当前 Next 运行环境是否能访问 Supabase。";
  return message;
}

function isMissingTableError(message: string): boolean {
  return /mixology_items|mixology_recipes|mixology_likes|mixology_saves|mixology_comments/i.test(message)
    && /schema cache|Could not find the table|Could not find.*column|PGRST204|PGRST205|does not exist/i.test(message);
}

async function supabaseFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; status: number }> {
  // 特调只走特调库：mixologyRestFetch 里没有主库 fallback
  const result = await mixologyRestFetch<T>(path, init);
  if (!result.ok && isMissingTableError(result.error)) {
    return {
      ok: false,
      error: "独家特调共享表尚未创建：请先在特调 Supabase 项目的 SQL Editor 执行 docs/mixology-supabase.sql。",
      status: result.status,
    };
  }
  return result;
}

function parseType(value: unknown): HallType | null {
  return value === "material" || value === "recipe" ? value : null;
}

/** 校验配方槽位引用（实现在 lib/mixology/hall-parts.ts，那边可脱离路由单测） */
function normalizeRecipeParts(value: unknown): { parts: RecipePartRef[] } | { error: string } {
  return normalizeParts(value, { materialKinds: MATERIAL_KINDS, maxPayload: MAX_RECIPE_PARTS_PAYLOAD });
}

/** 分享/更新配方前确认云端引用的酒材条目都还在架上 */
async function verifyPartsOnShelf(parts: RecipePartRef[]): Promise<string | null> {
  // 一格叠多件时同一个 id 可能出现多次，去重免得白拉长查询串
  const cloudIds = [...new Set(parts.filter(p => !p.builtin).map(p => p.id))];
  if (cloudIds.length === 0) return null;
  const result = await supabaseFetch<Array<{ id?: string }>>(
    `mixology_items?id=in.(${cloudIds.map(encodeFilter).join(",")})&deleted_at=is.null&select=id`,
  );
  if (!result.ok) return result.error;
  const found = new Set(result.data.map(item => cleanText(item.id, 160)));
  const missing = parts.filter(p => !p.builtin && !found.has(p.id)).map(p => p.name);
  if (missing.length > 0) return `这些材料不在酒材页上（未上架或已下架）：${missing.join("、")}`;
  return null;
}

function normalizeEntry(type: HallType, value: unknown, options: { withPayload?: boolean } = {}): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 160);
  const name = cleanText(record.name, 80);
  if (!id || !name) return null;
  const base = {
    id,
    name,
    authorId: cleanText(record.author_id, 160) || "anonymous",
    authorName: cleanText(record.author_name, 80) || "匿名调酒师",
    authorAvatar: cleanText(record.author_avatar, 300_000),
    cover: cleanText(record.cover, 2_000_000),
    likeCount: clampCount(record.like_count),
    saveCount: clampCount(record.save_count),
    viewCount: clampCount(record.view_count),
    commentCount: clampCount(record.comment_count),
    createdAt: cleanText(record.created_at, 80),
    updatedAt: cleanText(record.updated_at, 80),
  };
  if (type === "material") {
    const kind = cleanText(record.kind, 20);
    if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) return null;
    return {
      ...base,
      kind,
      hook: cleanText(record.hook, 200),
      tags: normalizeTags(record.tags),
      ...(options.withPayload ? { payload: record.payload ?? null } : {}),
    };
  }
  const rawParts = options.withPayload && Array.isArray(record.materials)
    ? record.materials.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map(item => ({
        id: cleanText(item.id, 160),
        kind: cleanText(item.kind, 20),
        name: cleanText(item.name, 80),
        ...(item.builtin === true ? { builtin: true } : {}),
      }))
      .filter(part => part.id && part.name && (MATERIAL_KINDS as readonly string[]).includes(part.kind))
    : undefined;
  return {
    ...base,
    intro: cleanText(record.intro, 400),
    charName: cleanText(record.char_name, 80),
    partNames: normalizeTags(record.part_names),
    ...(rawParts ? { parts: rawParts } : {}),
  };
}

/** 配方详情联表：把云端引用换成酒材条目的完整内容，下架的标 gone */
async function hydrateRecipeParts(entry: Record<string, unknown>): Promise<void> {
  const parts = Array.isArray(entry.parts) ? entry.parts as Array<Record<string, unknown>> : [];
  const cloudIds = [...new Set(parts.filter(p => p.builtin !== true).map(p => String(p.id)))];
  if (cloudIds.length === 0) return;
  const result = await supabaseFetch<unknown[]>(
    `mixology_items?id=in.(${cloudIds.map(encodeFilter).join(",")})&deleted_at=is.null&select=${ITEM_COLUMNS}`,
  );
  const found = new Map<string, Record<string, unknown>>();
  if (result.ok) {
    for (const item of result.data) {
      const normalized = normalizeEntry("material", item, { withPayload: true });
      if (normalized) found.set(normalized.id as string, normalized);
    }
  }
  entry.parts = parts.map(part => {
    if (part.builtin === true) return part;
    const item = found.get(String(part.id));
    const payload = item?.payload;
    if (!item || !payload || typeof payload !== "object") return { ...part, gone: true };
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      authorName: item.authorName,
      authorAvatar: item.authorAvatar,
      material: { ...(payload as Record<string, unknown>), id: item.id, kind: item.kind, name: item.name },
    };
  });
}

async function annotateMine(type: HallType, entries: Record<string, unknown>[], userId: string): Promise<void> {
  if (!userId || entries.length === 0) return;
  const [likes, saves] = await Promise.all([
    supabaseFetch<Array<{ target_id?: string }>>(
      `mixology_likes?target_type=eq.${type}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
    ),
    supabaseFetch<Array<{ target_id?: string }>>(
      `mixology_saves?target_type=eq.${type}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
    ),
  ]);
  const likedIds = new Set(likes.ok ? likes.data.map(item => item.target_id).filter(Boolean) : []);
  const savedIds = new Set(saves.ok ? saves.data.map(item => item.target_id).filter(Boolean) : []);
  for (const entry of entries) {
    entry.likedByMe = likedIds.has(entry.id as string);
    entry.savedByMe = savedIds.has(entry.id as string);
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const type = parseType(url.searchParams.get("type"));
    if (!type) return NextResponse.json({ ok: false, error: "missing_type", entries: [] }, { status: 400 });
    const account = await getCurrentAccount(request);
    const userId = account?.id || "";
    const table = TABLES[type];
    const requestedId = cleanText(url.searchParams.get("id"), 160);

    if (requestedId) {
      // 完整 payload 只发给登录用户：创作者的整卡源数据不做匿名裸发
      if (!account) return NextResponse.json({ ok: false, error: "请先登录账号再查看详情。" }, { status: 401 });
      const columns = type === "material" ? ITEM_COLUMNS : RECIPE_COLUMNS;
      const result = await supabaseFetch<unknown[]>(
        `${table}?id=eq.${encodeFilter(requestedId)}&deleted_at=is.null&select=${columns}&limit=1`,
      );
      if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
      const entry = normalizeEntry(type, result.data[0], { withPayload: true });
      if (!entry) return NextResponse.json({ ok: false, error: "没有找到这份内容。" }, { status: 404 });
      if (type === "recipe") await hydrateRecipeParts(entry);
      await annotateMine(type, [entry], userId);
      // 浏览量 +1（尽力而为，不阻塞返回）
      void supabaseFetch<unknown[]>(
        `${table}?id=eq.${encodeFilter(requestedId)}&deleted_at=is.null&select=id`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ view_count: clampCount(entry.viewCount) + 1 }),
        },
      );
      return NextResponse.json({ ok: true, entry });
    }

    const columns = type === "material" ? ITEM_SUMMARY_COLUMNS : RECIPE_SUMMARY_COLUMNS;
    const filters = [`deleted_at=is.null`, `select=${columns}`, "order=updated_at.desc", "limit=100"];
    if (type === "material") {
      const kind = cleanText(url.searchParams.get("kind"), 20);
      if ((MATERIAL_KINDS as readonly string[]).includes(kind)) filters.unshift(`kind=eq.${kind}`);
    }
    const isMine = url.searchParams.get("mine") === "1";
    if (isMine) {
      if (!account) return NextResponse.json({ ok: true, entries: [] });
      filters.unshift(`author_id=eq.${encodeFilter(userId)}`);
    }
    const result = await supabaseFetch<unknown[]>(`${table}?${filters.join("&")}`);
    if (!result.ok) {
      if (/mixology-supabase\.sql/.test(result.error)) {
        return NextResponse.json({ ok: true, entries: [], setupRequired: true, error: result.error });
      }
      return NextResponse.json({ ok: false, error: result.error, entries: [] }, { status: result.status });
    }
    const entries = result.data
      .map(item => normalizeEntry(type, item))
      .filter(Boolean) as Record<string, unknown>[];
    // 列表不做按用户标注（likedByMe/savedByMe 只在详情用得到）：响应因此对所有人相同，
    // 公共列表可整体进 CDN 缓存；「我的发布」按账号过滤，不缓存
    return NextResponse.json({ ok: true, entries }, isMine ? undefined : { headers: CDN_LIST_CACHE_HEADERS });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err), entries: [] }, { status: getMixologySupabaseConfig() ? 500 : 503 });
  }
}

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    if (!type) return NextResponse.json({ ok: false, error: "missing_type" }, { status: 400 });
    const name = cleanText(record.name, 80);
    if (!name) return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });
    const now = new Date().toISOString();

    if (type === "material") {
      const kind = cleanText(record.kind, 20);
      if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) {
        return NextResponse.json({ ok: false, error: "unknown_material_kind" }, { status: 400 });
      }
      const payload = record.payload;
      if (!payload || typeof payload !== "object") {
        return NextResponse.json({ ok: false, error: "missing_payload" }, { status: 400 });
      }
      if (JSON.stringify(payload).length > MAX_MATERIAL_PAYLOAD) {
        return NextResponse.json({ ok: false, error: "材料太大了（封面图请压小一点）。" }, { status: 413 });
      }
      if (kind === "mechanism") {
        const invalid = validateMechanismPayload(payload);
        if (invalid) return NextResponse.json({ ok: false, error: invalid }, { status: 400 });
      }
      const materialId = createId("mxi");
      const insert = await supabaseFetch<unknown[]>(
        `mixology_items?select=${ITEM_COLUMNS}`,
        {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            id: materialId,
            kind,
            name,
            hook: cleanText(record.hook, 200),
            cover: await resolveCoverForWrite("material", materialId, record.cover),
            tags: normalizeTags(record.tags),
            payload,
            author_id: account.id,
            author_name: cleanText(record.authorName, 80) || account.displayName,
            author_avatar: cleanText(record.authorAvatar, 300_000),
            created_at: now,
            updated_at: now,
          }),
        },
      );
      if (!insert.ok) return NextResponse.json({ ok: false, error: insert.error }, { status: insert.status });
      return NextResponse.json({ ok: true, entry: normalizeEntry("material", insert.data[0], { withPayload: true }) });
    }

    const normalized = normalizeRecipeParts(record.parts);
    if ("error" in normalized) {
      return NextResponse.json({ ok: false, error: normalized.error }, { status: 400 });
    }
    const shelfError = await verifyPartsOnShelf(normalized.parts);
    if (shelfError) return NextResponse.json({ ok: false, error: shelfError }, { status: 409 });
    const recipeId = createId("mxr");
    const insert = await supabaseFetch<unknown[]>(
      `mixology_recipes?select=${RECIPE_COLUMNS}`,
      {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id: recipeId,
          name,
          intro: cleanText(record.intro, 400),
          cover: await resolveCoverForWrite("recipe", recipeId, record.cover),
          char_name: cleanText(record.charName, 80),
          part_names: normalizeTags(record.partNames),
          materials: normalized.parts,
          author_id: account.id,
          author_name: cleanText(record.authorName, 80) || account.displayName,
          author_avatar: cleanText(record.authorAvatar, 300_000),
          created_at: now,
          updated_at: now,
        }),
      },
    );
    if (!insert.ok) return NextResponse.json({ ok: false, error: insert.error }, { status: insert.status });
    return NextResponse.json({ ok: true, entry: normalizeEntry("recipe", insert.data[0], { withPayload: true }) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getMixologySupabaseConfig() ? 400 : 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const name = cleanText(record.name, 80);
    if (!name) return NextResponse.json({ ok: false, error: "missing_name" }, { status: 400 });

    // 只改内容，不动 like/save/view/comment 计数与 created_at——更新不该清零社交数据
    let payload: Record<string, unknown>;
    if (type === "material") {
      const kind = cleanText(record.kind, 20);
      if (!(MATERIAL_KINDS as readonly string[]).includes(kind)) {
        return NextResponse.json({ ok: false, error: "unknown_material_kind" }, { status: 400 });
      }
      const materialPayload = record.payload;
      if (!materialPayload || typeof materialPayload !== "object") {
        return NextResponse.json({ ok: false, error: "missing_payload" }, { status: 400 });
      }
      if (JSON.stringify(materialPayload).length > MAX_MATERIAL_PAYLOAD) {
        return NextResponse.json({ ok: false, error: "材料太大了（封面图请压小一点）。" }, { status: 413 });
      }
      if (kind === "mechanism") {
        const invalid = validateMechanismPayload(materialPayload);
        if (invalid) return NextResponse.json({ ok: false, error: invalid }, { status: 400 });
      }
      payload = {
        kind,
        name,
        hook: cleanText(record.hook, 200),
        cover: await resolveCoverForWrite(type, id, record.cover),
        tags: normalizeTags(record.tags),
        payload: materialPayload,
        // 更新时同步刷新署名与头像：发布身份以创作者资料当前值为准
        author_name: cleanText(record.authorName, 80) || account.displayName,
        author_avatar: cleanText(record.authorAvatar, 300_000),
        updated_at: new Date().toISOString(),
      };
    } else {
      const normalized = normalizeRecipeParts(record.parts);
      if ("error" in normalized) {
        return NextResponse.json({ ok: false, error: normalized.error }, { status: 400 });
      }
      const shelfError = await verifyPartsOnShelf(normalized.parts);
      if (shelfError) return NextResponse.json({ ok: false, error: shelfError }, { status: 409 });
      payload = {
        name,
        intro: cleanText(record.intro, 400),
        cover: await resolveCoverForWrite(type, id, record.cover),
        char_name: cleanText(record.charName, 80),
        part_names: normalizeTags(record.partNames),
        materials: normalized.parts,
        author_name: cleanText(record.authorName, 80) || account.displayName,
        author_avatar: cleanText(record.authorAvatar, 300_000),
        updated_at: new Date().toISOString(),
      };
    }

    const columns = type === "material" ? ITEM_COLUMNS : RECIPE_COLUMNS;
    const result = await supabaseFetch<unknown[]>(
      `${TABLES[type]}?id=eq.${encodeFilter(id)}&author_id=eq.${encodeFilter(account.id)}&deleted_at=is.null&select=${columns}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    if (!Array.isArray(result.data) || result.data.length === 0) {
      // 已被自己下架、或根本不是自己的——让客户端清掉本地的发布标记，改走重新发布
      return NextResponse.json({ ok: false, error: "没有找到可更新的发布内容，它可能已经下架了。", gone: true }, { status: 404 });
    }
    return NextResponse.json({ ok: true, entry: normalizeEntry(type, result.data[0], { withPayload: true }) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getMixologySupabaseConfig() ? 400 : 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    const action = cleanText(record.action, 40);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const table = TABLES[type];
    const userId = account.id;

    const currentResult = await supabaseFetch<unknown[]>(
      `${table}?id=eq.${encodeFilter(id)}&deleted_at=is.null&select=id,like_count,save_count`,
    );
    if (!currentResult.ok) return NextResponse.json({ ok: false, error: currentResult.error }, { status: currentResult.status });
    const current = currentResult.data[0] as Record<string, unknown> | undefined;
    if (!current) return NextResponse.json({ ok: false, error: "没有找到这份内容。" }, { status: 404 });

    let liked = false;
    let saved = false;
    let likeCount = clampCount(current.like_count);
    let saveCount = clampCount(current.save_count);

    if (action === "toggle_like") {
      const existing = await supabaseFetch<unknown[]>(
        `mixology_likes?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
      );
      if (!existing.ok) return NextResponse.json({ ok: false, error: existing.error }, { status: existing.status });
      if (existing.data.length > 0) {
        const removed = await supabaseFetch<unknown[]>(
          `mixology_likes?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}`,
          { method: "DELETE" },
        );
        if (!removed.ok) return NextResponse.json({ ok: false, error: removed.error }, { status: removed.status });
        likeCount = Math.max(0, likeCount - 1);
        liked = false;
      } else {
        const added = await supabaseFetch<unknown[]>(
          "mixology_likes",
          {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ target_type: type, target_id: id, user_id: userId }),
          },
        );
        if (!added.ok) return NextResponse.json({ ok: false, error: added.error }, { status: added.status });
        likeCount += 1;
        liked = true;
      }
    } else if (action === "save") {
      const existing = await supabaseFetch<unknown[]>(
        `mixology_saves?target_type=eq.${type}&target_id=eq.${encodeFilter(id)}&user_id=eq.${encodeFilter(userId)}&select=target_id`,
      );
      if (!existing.ok) return NextResponse.json({ ok: false, error: existing.error }, { status: existing.status });
      if (existing.data.length === 0) {
        const added = await supabaseFetch<unknown[]>(
          "mixology_saves",
          {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ target_type: type, target_id: id, user_id: userId }),
          },
        );
        if (!added.ok) return NextResponse.json({ ok: false, error: added.error }, { status: added.status });
        saveCount += 1;
      }
      saved = true;
    } else {
      return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
    }

    const update = await supabaseFetch<unknown[]>(
      `${table}?id=eq.${encodeFilter(id)}&deleted_at=is.null&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ like_count: likeCount, save_count: saveCount }),
      },
    );
    if (!update.ok) return NextResponse.json({ ok: false, error: update.error }, { status: update.status });
    return NextResponse.json({ ok: true, liked, saved, likeCount, saveCount });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getMixologySupabaseConfig() ? 400 : 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const type = parseType(record.type);
    const id = cleanText(record.id, 160);
    if (!type || !id) return NextResponse.json({ ok: false, error: "missing_target" }, { status: 400 });
    const result = await supabaseFetch<unknown[]>(
      `${TABLES[type]}?id=eq.${encodeFilter(id)}&author_id=eq.${encodeFilter(account.id)}&deleted_at=is.null&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    if (!Array.isArray(result.data) || result.data.length === 0) {
      return NextResponse.json({ ok: false, error: "没有找到可下架的内容。" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseError(err) }, { status: getMixologySupabaseConfig() ? 400 : 503 });
  }
}
