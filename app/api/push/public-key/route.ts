import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { getOrCreateVapidConfig } from "@/lib/server/push-service";
import { formatSupabaseRestError, getSupabaseServerConfig } from "@/lib/server/supabase-rest";

export async function GET(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const vapid = await getOrCreateVapidConfig();
    return NextResponse.json({ ok: true, publicKey: vapid.publicKey });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
