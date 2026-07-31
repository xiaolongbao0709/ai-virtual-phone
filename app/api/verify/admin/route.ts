import { NextResponse } from "next/server";

import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { cleanText, deleteVerificationImage, requireAdminKey, type VerificationRequestRow } from "@/lib/server/verification";

type ActivationCodeRow = { code: string; expires_at: string | null };

function unauthorized() {
  return NextResponse.json({ ok: false, error: "管理密钥不正确（需配置 VERIFY_ADMIN_KEY 环境变量并携带）。" }, { status: 401 });
}

// GET ?key=...&view=pending|all → 申请列表
export async function GET(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "服务端 Supabase 未配置。" }, { status: 503 });
    }
    if (!requireAdminKey(request)) return unauthorized();

    const url = new URL(request.url);
    const view = url.searchParams.get("view") === "all" ? "all" : "pending";
    const filter = view === "pending" ? "&status=eq.pending" : "";
    const result = await supabaseRestFetch<VerificationRequestRow[]>(
      `verification_requests?select=id,query_code,contact,status,activation_code,note,created_at,reviewed_at,image_path${filter}&order=created_at.desc&limit=200`,
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: formatSupabaseRestError(result.error) }, { status: 502 });
    }
    const items = result.data.map(row => ({
      id: row.id,
      queryCode: row.query_code,
      contact: row.contact,
      status: row.status,
      activationCode: row.activation_code,
      note: row.note,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      hasImage: Boolean(row.image_path),
    }));
    return NextResponse.json({ ok: true, items });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}

async function pickAvailableActivationCode(): Promise<{ code?: string; error?: string }> {
  const candidates = await supabaseRestFetch<ActivationCodeRow[]>(
    "activation_codes?status=eq.active&used_count=eq.0&select=code,expires_at&order=created_at.asc&limit=1000",
  );
  if (!candidates.ok) return { error: formatSupabaseRestError(candidates.error) };

  const assigned = await supabaseRestFetch<{ activation_code: string }[]>(
    "verification_requests?activation_code=not.is.null&select=activation_code",
  );
  if (!assigned.ok) return { error: formatSupabaseRestError(assigned.error) };

  const taken = new Set(assigned.data.map(item => item.activation_code));
  const now = Date.now();
  const pick = candidates.data.find(item =>
    !taken.has(item.code) && (!item.expires_at || Date.parse(item.expires_at) > now));
  if (!pick) return { error: "没有可发放的激活码了：请先在 Supabase 的 activation_codes 表添加新的未用激活码。" };
  return { code: pick.code };
}

// POST {id, action: "approve"|"reject", note?} → 裁决；通过自动绑一个未用激活码；两种结果都会删除审核图片。
export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "服务端 Supabase 未配置。" }, { status: 503 });
    }
    if (!requireAdminKey(request)) return unauthorized();

    const body = await request.json().catch(() => ({}));
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const id = cleanText(record.id, 64);
    const action = record.action === "approve" ? "approve" : record.action === "reject" ? "reject" : "";
    const note = cleanText(record.note, 300);
    if (!id || !action) {
      return NextResponse.json({ ok: false, error: "缺少 id 或 action（approve/reject）。" }, { status: 400 });
    }

    const existing = await supabaseRestFetch<VerificationRequestRow[]>(
      `verification_requests?id=eq.${encodeSupabaseFilter(id)}&limit=1`,
    );
    if (!existing.ok) {
      return NextResponse.json({ ok: false, error: formatSupabaseRestError(existing.error) }, { status: 502 });
    }
    const row = existing.data[0];
    if (!row) return NextResponse.json({ ok: false, error: "申请不存在。" }, { status: 404 });
    if (row.status !== "pending") {
      return NextResponse.json({ ok: false, error: "这条申请已经处理过了。" }, { status: 409 });
    }

    let activationCode: string | null = null;
    if (action === "approve") {
      const picked = await pickAvailableActivationCode();
      if (!picked.code) return NextResponse.json({ ok: false, error: picked.error }, { status: 409 });
      activationCode = picked.code;
    }

    const updated = await supabaseRestFetch<VerificationRequestRow[]>(
      `verification_requests?id=eq.${encodeSupabaseFilter(id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status: action === "approve" ? "approved" : "rejected",
          activation_code: activationCode,
          note: note || null,
          reviewed_at: new Date().toISOString(),
          image_path: null,
        }),
      },
    );
    if (!updated.ok) {
      return NextResponse.json({ ok: false, error: formatSupabaseRestError(updated.error) }, { status: 502 });
    }

    // 审核完成即删图，最小化敏感图片留存。
    if (row.image_path) await deleteVerificationImage(row.image_path);

    return NextResponse.json({ ok: true, status: action === "approve" ? "approved" : "rejected", activationCode });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}
