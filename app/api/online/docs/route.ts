import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";

// 异步共享文档：漂流瓶、排行榜、留言板、串门数据……
// 按 namespace（APP/游戏）+ collection（APP 自定义）隔离，全部走 service key。

type DocRow = {
  id: string;
  namespace: string;
  collection: string;
  owner_id: string;
  owner_name: string;
  data: Record<string, unknown>;
  sort_key: number | null;
  taken_by: string | null;
  taken_at: string | null;
  created_at: string;
  updated_at: string;
};

const DOC_COLUMNS = "id,namespace,collection,owner_id,owner_name,data,sort_key,taken_by,taken_at,created_at,updated_at";
const MAX_DOCS_PER_OWNER = 200;
const MAX_DATA_CHARS = 8000;
const MAX_LIST_LIMIT = 50;

function normalizeNamespace(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!/^(custom_app|game):[\w.-]{1,120}$/.test(raw)) return "";
  return raw;
}

function normalizeCollection(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!/^[\w.-]{1,60}$/.test(raw)) return "";
  return raw;
}

function publicDoc(row: DocRow, viewerId: string) {
  return {
    id: row.id,
    collection: row.collection,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    isMine: row.owner_id === viewerId,
    data: row.data ?? {},
    sortKey: row.sort_key,
    takenBy: row.taken_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseData(value: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "data 必须是对象。" };
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_DATA_CHARS) {
    return { ok: false, error: `data 过大（上限 ${MAX_DATA_CHARS} 字符）。` };
  }
  return { ok: true, data: value as Record<string, unknown> };
}

export async function POST(request: NextRequest) {
  try {
    if (isSelfHostedModeEnabled()) {
      return NextResponse.json({ ok: false, error: "云端共享数据需要账号系统（联机模式），单机模式暂不支持。" }, { status: 400 });
    }
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "服务端未配置 Supabase。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "请先登录账号再使用联机功能。" }, { status: 401 });
    }
    if (account.status === "disabled") {
      return NextResponse.json({ ok: false, error: "当前账号已被停用。" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "").trim();
    const namespace = normalizeNamespace(body.namespace);
    const collection = normalizeCollection(body.collection);
    if (!namespace) return NextResponse.json({ ok: false, error: "namespace 无效。" }, { status: 400 });
    if (action !== "get" && action !== "delete" && action !== "update" && !collection) {
      return NextResponse.json({ ok: false, error: "collection 无效（1-60 位字母数字._-）。" }, { status: 400 });
    }

    const nsFilter = `namespace=eq.${encodeSupabaseFilter(namespace)}`;

    if (action === "put") {
      const parsed = parseData(body.data);
      if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
      const countCheck = await supabaseRestFetch<{ id: string }[]>(
        `online_cloud_docs?${nsFilter}&owner_id=eq.${encodeSupabaseFilter(account.id)}&deleted_at=is.null&select=id&limit=${MAX_DOCS_PER_OWNER + 1}`,
      );
      if (!countCheck.ok) return NextResponse.json({ ok: false, error: countCheck.error }, { status: 500 });
      if (countCheck.data.length >= MAX_DOCS_PER_OWNER) {
        return NextResponse.json({ ok: false, error: `每个账号在本 APP 最多保存 ${MAX_DOCS_PER_OWNER} 条云端数据，请先清理。` }, { status: 429 });
      }
      const sortKeyRaw = Number(body.sortKey);
      const row = {
        id: `odoc_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
        namespace,
        collection,
        owner_id: account.id,
        owner_name: account.displayName || account.username,
        data: parsed.data,
        sort_key: Number.isFinite(sortKeyRaw) ? sortKeyRaw : null,
      };
      const insert = await supabaseRestFetch<DocRow[]>("online_cloud_docs", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([row]),
      });
      if (!insert.ok) return NextResponse.json({ ok: false, error: insert.error }, { status: 500 });
      return NextResponse.json({ ok: true, doc: publicDoc(insert.data[0], account.id) });
    }

    if (action === "get") {
      const id = String(body.id ?? "").trim();
      if (!id) return NextResponse.json({ ok: false, error: "缺少 id。" }, { status: 400 });
      const found = await supabaseRestFetch<DocRow[]>(
        `online_cloud_docs?id=eq.${encodeSupabaseFilter(id)}&${nsFilter}&deleted_at=is.null&select=${DOC_COLUMNS}&limit=1`,
      );
      if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: 500 });
      const doc = found.data[0];
      return NextResponse.json({ ok: true, doc: doc ? publicDoc(doc, account.id) : null });
    }

    if (action === "list") {
      const limitRaw = Number(body.limit ?? 20);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(MAX_LIST_LIMIT, Math.round(limitRaw))) : 20;
      const mineOnly = body.mine === true;
      const orderBy = body.orderBy === "sortKey" ? "sort_key.desc.nullslast" : "created_at.desc";
      const ownerFilter = mineOnly ? `&owner_id=eq.${encodeSupabaseFilter(account.id)}` : "";
      const found = await supabaseRestFetch<DocRow[]>(
        `online_cloud_docs?${nsFilter}&collection=eq.${encodeSupabaseFilter(collection)}${ownerFilter}`
        + `&deleted_at=is.null&select=${DOC_COLUMNS}&order=${orderBy}&limit=${limit}`,
      );
      if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: 500 });
      return NextResponse.json({ ok: true, docs: found.data.map(row => publicDoc(row, account.id)) });
    }

    if (action === "update" || action === "delete") {
      const id = String(body.id ?? "").trim();
      if (!id) return NextResponse.json({ ok: false, error: "缺少 id。" }, { status: 400 });
      // 只能动自己的文档
      const ownFilter = `online_cloud_docs?id=eq.${encodeSupabaseFilter(id)}&${nsFilter}&owner_id=eq.${encodeSupabaseFilter(account.id)}&deleted_at=is.null`;
      if (action === "delete") {
        const del = await supabaseRestFetch<DocRow[]>(`${ownFilter}&select=id`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
        });
        if (!del.ok) return NextResponse.json({ ok: false, error: del.error }, { status: 500 });
        return NextResponse.json({ ok: true, deleted: del.data.length > 0 });
      }
      const parsed = parseData(body.data);
      if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
      const sortKeyRaw = Number(body.sortKey);
      const patch: Record<string, unknown> = { data: parsed.data, updated_at: new Date().toISOString() };
      if (Number.isFinite(sortKeyRaw)) patch.sort_key = sortKeyRaw;
      const updated = await supabaseRestFetch<DocRow[]>(`${ownFilter}&select=${DOC_COLUMNS}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      if (!updated.ok) return NextResponse.json({ ok: false, error: updated.error }, { status: 500 });
      const doc = updated.data[0];
      if (!doc) return NextResponse.json({ ok: false, error: "文档不存在或不属于你。" }, { status: 404 });
      return NextResponse.json({ ok: true, doc: publicDoc(doc, account.id) });
    }

    if (action === "takeRandom") {
      // 漂流瓶语义：随机捞一条"不是自己扔的、还没被捞走"的文档并独占标记。
      // 条件 PATCH（taken_by=is.null）保证并发下同一条只会被一个人捞到。
      const candidates = await supabaseRestFetch<{ id: string }[]>(
        `online_cloud_docs?${nsFilter}&collection=eq.${encodeSupabaseFilter(collection)}`
        + `&owner_id=neq.${encodeSupabaseFilter(account.id)}&taken_by=is.null&deleted_at=is.null&select=id&limit=40`,
      );
      if (!candidates.ok) return NextResponse.json({ ok: false, error: candidates.error }, { status: 500 });
      const pool = [...candidates.data];
      while (pool.length > 0) {
        const index = randomBytes(2).readUInt16BE(0) % pool.length;
        const [candidate] = pool.splice(index, 1);
        const claimed = await supabaseRestFetch<DocRow[]>(
          `online_cloud_docs?id=eq.${encodeSupabaseFilter(candidate.id)}&taken_by=is.null&deleted_at=is.null&select=${DOC_COLUMNS}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ taken_by: account.id, taken_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
          },
        );
        if (claimed.ok && claimed.data[0]) {
          return NextResponse.json({ ok: true, doc: publicDoc(claimed.data[0], account.id) });
        }
      }
      return NextResponse.json({ ok: true, doc: null });
    }

    return NextResponse.json({ ok: false, error: "未知 action。" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err) },
      { status: 500 },
    );
  }
}
