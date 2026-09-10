import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { cleanAccountText } from "@/lib/server/account-auth";
import {
  encodeSupabaseFilter,
  formatSupabaseRestError,
  getSupabaseServerConfig,
  supabaseRestFetch,
} from "@/lib/server/supabase-rest";

type RegisterBody = {
  token?: unknown;
  deviceId?: unknown;
  platform?: unknown;
  provider?: unknown;
  appName?: unknown;
  authToken?: unknown;
};

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization")?.trim() || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || "";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }

    const expectedSecret = process.env.FCM_REGISTER_SECRET?.trim() || "";
    if (!expectedSecret) {
      return NextResponse.json({ ok: false, error: "FCM_REGISTER_SECRET 未配置。" }, { status: 503 });
    }

    const body = await request.json().catch(() => ({})) as RegisterBody;
    const suppliedSecret = bearerToken(request) || cleanAccountText(body.authToken, 1000);
    if (!suppliedSecret || !safeEqual(suppliedSecret, expectedSecret)) {
      return NextResponse.json({ ok: false, error: "FCM 注册密钥无效。" }, { status: 401 });
    }

    const token = cleanAccountText(body.token, 4096);
    const deviceId = cleanAccountText(body.deviceId, 300);
    const provider = cleanAccountText(body.provider, 40).toLowerCase();
    const platform = cleanAccountText(body.platform, 40).toLowerCase();
    const appName = cleanAccountText(body.appName, 120);
    if (!token) {
      return NextResponse.json({ ok: false, error: "缺少 FCM token。" }, { status: 400 });
    }
    if (provider && provider !== "fcm") {
      return NextResponse.json({ ok: false, error: "provider 不是 fcm。" }, { status: 400 });
    }
    if (platform && platform !== "android") {
      return NextResponse.json({ ok: false, error: "目前仅接受 Android FCM token。" }, { status: 400 });
    }

    // 当前 TAT1123 自部署模式是单用户 local_user。需要多账号时可在部署环境
    // 中把 FCM_DEFAULT_USER_ID 指向对应账号，避免把用户身份信任交给客户端。
    const userId = cleanAccountText(process.env.FCM_DEFAULT_USER_ID || "local_user", 120) || "local_user";
    const endpoint = `fcm:${token}`;
    const userAgent = [
      "WebToApp FCM",
      appName && `app=${appName}`,
      deviceId && `device=${deviceId}`,
    ].filter(Boolean).join("; ").slice(0, 300);

    const result = await supabaseRestFetch("push_subscriptions", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{
        endpoint,
        user_id: userId,
        p256dh: "fcm",
        auth: "fcm",
        user_agent: userAgent || "WebToApp FCM",
        fail_count: 0,
        last_ok_at: new Date().toISOString(),
      }]),
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    // 新 FCM token 注册成功后，移除旧 FloatShell 的 Realtime 占位订阅，
    // 防止同一条消息既走旧前台常驻服务又走 FCM 而重复弹两次。
    await supabaseRestFetch(
      `push_subscriptions?endpoint=eq.${encodeSupabaseFilter(`shell:${userId}`)}&user_id=eq.${encodeSupabaseFilter(userId)}`,
      { method: "DELETE" },
    ).catch(() => undefined);

    return NextResponse.json({ ok: true, provider: "fcm", userId });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
