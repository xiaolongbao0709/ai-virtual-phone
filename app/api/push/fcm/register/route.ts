import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { cleanAccountText } from "@/lib/server/account-auth";
import { upsertFcmDevice } from "@/lib/server/fcm-device-store";

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

    const userId = cleanAccountText(process.env.FCM_DEFAULT_USER_ID || "local_user", 120) || "local_user";
    await upsertFcmDevice({ token, userId, deviceId, appName });

    return NextResponse.json({ ok: true, provider: "fcm", userId, storage: "firestore" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
