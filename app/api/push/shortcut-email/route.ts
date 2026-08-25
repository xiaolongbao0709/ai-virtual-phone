import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import {
  beginShortcutEmailVerification,
  confirmShortcutEmailVerification,
  getShortcutEmailStatus,
  removeShortcutEmailVerification,
} from "@/lib/server/shortcut-email-service";
import { formatSupabaseRestError, getSupabaseServerConfig } from "@/lib/server/supabase-rest";

async function accountFor(request: Request) {
  if (!getSupabaseServerConfig()) return null;
  return getCurrentAccount(request);
}

export async function GET(request: Request) {
  try {
    const account = await accountFor(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    return NextResponse.json({ ok: true, ...(await getShortcutEmailStatus(account.id)) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const account = await accountFor(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const verificationExpiresAt = await beginShortcutEmailVerification(account.id, body.recipient);
    return NextResponse.json({ ok: true, verificationExpiresAt });
  } catch (err) {
    const message = formatSupabaseRestError(err);
    const status = /尚未配置/.test(message) ? 503 : /频繁/.test(message) ? 429 : /邮箱/.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const account = await accountFor(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const recipient = await confirmShortcutEmailVerification(account.id, body.code);
    return NextResponse.json({ ok: true, recipient, verified: true });
  } catch (err) {
    const message = formatSupabaseRestError(err);
    const status = /验证码|请先/.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const account = await accountFor(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    await removeShortcutEmailVerification(account.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}
