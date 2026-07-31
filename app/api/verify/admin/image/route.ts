import { NextResponse } from "next/server";

import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { cleanText, requireAdminKey, VERIFY_BUCKET, type VerificationRequestRow } from "@/lib/server/verification";

// GET ?key=...&id=... → 用 service_role 从私有桶取审核图片流回管理页。
export async function GET(request: Request) {
  try {
    const config = getSupabaseServerConfig();
    if (!config) return NextResponse.json({ ok: false, error: "服务端 Supabase 未配置。" }, { status: 503 });
    if (!requireAdminKey(request)) {
      return NextResponse.json({ ok: false, error: "管理密钥不正确。" }, { status: 401 });
    }

    const url = new URL(request.url);
    const id = cleanText(url.searchParams.get("id"), 64);
    if (!id) return NextResponse.json({ ok: false, error: "缺少 id。" }, { status: 400 });

    const result = await supabaseRestFetch<VerificationRequestRow[]>(
      `verification_requests?id=eq.${encodeSupabaseFilter(id)}&select=image_path&limit=1`,
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: formatSupabaseRestError(result.error) }, { status: 502 });
    }
    const imagePath = result.data[0]?.image_path;
    if (!imagePath) {
      return NextResponse.json({ ok: false, error: "图片不存在（可能已审核删除）。" }, { status: 404 });
    }

    const file = await fetch(`${config.url}/storage/v1/object/authenticated/${VERIFY_BUCKET}/${imagePath}`, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
      cache: "no-store",
    });
    if (!file.ok) {
      return NextResponse.json({ ok: false, error: `读取图片失败（${file.status}）。` }, { status: 502 });
    }
    const bytes = await file.arrayBuffer();
    return new NextResponse(bytes, {
      headers: {
        "content-type": file.headers.get("content-type") || "image/jpeg",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}
