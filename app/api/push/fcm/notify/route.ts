import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { deleteFcmDevice, listFcmDevices } from "@/lib/server/fcm-device-store";
import { sendFcmNativePush } from "@/lib/server/fcm-native-push";

type NotifyBody = {
  title?: unknown;
  body?: unknown;
  url?: unknown;
};

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }

    const input = await request.json().catch(() => ({})) as NotifyBody;
    const title = cleanAccountText(input.title, 120) || "小手机";
    const body = cleanAccountText(input.body, 500);
    const requestedUrl = cleanAccountText(input.url, 1200);
    const openUrl = (() => {
      try {
        return new URL(requestedUrl || "/", request.url).toString();
      } catch {
        return new URL("/", request.url).toString();
      }
    })();

    if (!body) {
      return NextResponse.json({ ok: false, error: "通知内容为空。" }, { status: 400 });
    }

    const devices = await listFcmDevices(account.id);
    if (devices.length === 0) {
      return NextResponse.json({ ok: false, error: "当前账号没有已注册的 FCM 设备。", sent: 0, total: 0 }, { status: 404 });
    }

    let sent = 0;
    const errors: string[] = [];
    for (const device of devices) {
      const result = await sendFcmNativePush(device.token, { title, body, openUrl });
      if (result.ok) {
        sent += 1;
        continue;
      }
      if (result.stale) {
        await deleteFcmDevice(device.id).catch(() => undefined);
      }
      if (result.error) errors.push(result.error);
    }

    if (sent === 0) {
      return NextResponse.json({ ok: false, sent, total: devices.length, errors }, { status: 502 });
    }
    return NextResponse.json({ ok: true, sent, total: devices.length, errors });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
