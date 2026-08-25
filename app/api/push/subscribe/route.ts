import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

type SubscribeBody = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as SubscribeBody;
    const endpoint = cleanAccountText(body.endpoint, 1000);
    const p256dh = cleanAccountText(body.keys?.p256dh, 300);
    const auth = cleanAccountText(body.keys?.auth, 300);
    if (!endpoint || !p256dh || !auth) {
      return NextResponse.json({ ok: false, error: "订阅数据不完整。" }, { status: 400 });
    }

    const result = await supabaseRestFetch("push_subscriptions", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{
        endpoint,
        user_id: account.id,
        p256dh,
        auth,
        user_agent: cleanAccountText(request.headers.get("user-agent"), 300) || null,
        fail_count: 0,
      }]),
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({})) as { endpoint?: unknown };
    const endpoint = cleanAccountText(body.endpoint, 1000);
    if (!endpoint) {
      return NextResponse.json({ ok: false, error: "缺少订阅端点。" }, { status: 400 });
    }
    const result = await supabaseRestFetch(
      `push_subscriptions?endpoint=eq.${encodeSupabaseFilter(endpoint)}&user_id=eq.${encodeSupabaseFilter(account.id)}`,
      { method: "DELETE" },
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
