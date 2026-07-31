import { NextResponse } from "next/server";

import {
  cleanAccountText,
  findUserById,
  getCurrentAccount,
  updateUserPassword,
  verifyPassword,
} from "@/lib/server/account-auth";
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

    const record = await request.json().catch(() => ({})) as Record<string, unknown>;
    const oldPassword = cleanAccountText(record.oldPassword, 120);
    const newPassword = cleanAccountText(record.newPassword, 120);
    if (!oldPassword || !newPassword) {
      return NextResponse.json({ ok: false, error: "请填写当前密码和新密码。" }, { status: 400 });
    }
    if (newPassword.length < 6) {
      return NextResponse.json({ ok: false, error: "新密码至少需要 6 位。" }, { status: 400 });
    }
    if (newPassword === oldPassword) {
      return NextResponse.json({ ok: false, error: "新密码不能与当前密码相同。" }, { status: 400 });
    }

    const user = await findUserById(account.id);
    if (!user || !verifyPassword(oldPassword, cleanAccountText(user.password_hash, 300))) {
      return NextResponse.json({ ok: false, error: "当前密码不正确。" }, { status: 400 });
    }

    await updateUserPassword(account.id, newPassword);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
