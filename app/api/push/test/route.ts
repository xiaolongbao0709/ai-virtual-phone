import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { resolvePushSubject, sendPushToUser } from "@/lib/server/push-service";

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }

    // WebToApp 原生 FCM 设备统一注册到这个账号。自部署默认 local_user。
    // 不再要求 Supabase；浏览器 Web Push 若未配置 Supabase 会由 push-service 自动跳过。
    const userId = (process.env.FCM_DEFAULT_USER_ID || account.id || "local_user").trim() || "local_user";

    // 留出杀后台的时间窗：请求收到后等 6 秒再发送（客户端此时可能已经被杀，无妨）。
    await new Promise(resolve => setTimeout(resolve, 6000));
    const result = await sendPushToUser(userId, {
      title: "小手机",
      body: "FCM 原生推送已连通。关掉后台也能收到这样的通知。",
      tag: "push-test",
      url: new URL("/", request.url).toString(),
    }, resolvePushSubject(request.url));

    if (result.total === 0) {
      return NextResponse.json({ ok: false, error: "没有找到已注册的 FCM 设备。" }, { status: 400 });
    }
    if (result.sent === 0) {
      return NextResponse.json({ ok: false, error: `发送失败：${result.errors[0] || "未知错误"}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, sent: result.sent, total: result.total, provider: "fcm" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
