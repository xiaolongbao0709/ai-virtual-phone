import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import {
  beginShortcutEmailVerification,
  confirmShortcutEmailVerification,
  getShortcutEmailStatus,
  removeShortcutEmailVerification,
} from "@/lib/server/shortcut-email-service";
import { formatSupabaseRestError, getSupabaseServerConfig } from "@/lib/server/supabase-rest";

// 未配置站点 Supabase 与未登录是两回事：单机模式下账号永远是 local_user，
// 若把配置缺失也报成「请先登录」，自部署用户会以为要开账号系统。
const notConfigured = () =>
  NextResponse.json({ ok: false, error: "站点尚未配置 Supabase（部署环境缺 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，不是应用内的个人云），邮件自动通道未开通。请站点主人按 README「邮件自动运行」配置并执行一体脚本。" }, { status: 503 });

export async function GET(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return notConfigured();
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    return NextResponse.json({ ok: true, ...(await getShortcutEmailStatus(account.id)) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return notConfigured();
    const account = await getCurrentAccount(request);
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
    if (!getSupabaseServerConfig()) return notConfigured();
    const account = await getCurrentAccount(request);
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
    if (!getSupabaseServerConfig()) return notConfigured();
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    await removeShortcutEmailVerification(account.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}
