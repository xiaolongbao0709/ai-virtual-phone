import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { resolvePushSubject, sendPushToUser } from "@/lib/server/push-service";
import { formatSupabaseRestError, getSupabaseServerConfig } from "@/lib/server/supabase-rest";

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    // 留出杀后台的时间窗：请求收到后等 6 秒再发送（客户端此时可能已经被杀，无妨）。
    await new Promise(resolve => setTimeout(resolve, 6000));
    const result = await sendPushToUser(account.id, {
      title: "小手机",
      body: "离线推送已连通。关掉后台也能收到这样的通知。",
      tag: "push-test",
      url: new URL("/", request.url).toString(),
    }, resolvePushSubject(request.url));
    if (result.total === 0) {
      return NextResponse.json({ ok: false, error: "当前账号没有任何推送订阅，请先开启离线推送。" }, { status: 400 });
    }
    if (result.sent === 0) {
      return NextResponse.json({ ok: false, error: `发送失败：${result.errors[0] || "未知错误"}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sent: result.sent, total: result.total });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
