import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { deliverShortcutCommand } from "@/lib/server/shortcut-command-delivery";
import { getVerifiedShortcutEmailRecipient } from "@/lib/server/shortcut-email-service";
import {
  SHORTCUT_COMMAND_MAX_ARGS_BYTES,
  SHORTCUT_COMMAND_SELECT,
  expireShortcutCommands,
  toPublicShortcutCommand,
  type ShortcutCommandRow,
} from "@/lib/server/shortcut-commands";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

const RESULT_MODES = new Set(["none", "text", "image"]);
const DELIVERY_MODES = new Set(["push", "email"]);

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const actionId = cleanAccountText(body.actionId, 100);
    const actionName = cleanAccountText(body.actionName, 60);
    const shortcutName = cleanAccountText(body.shortcutName, 80);
    const resultMode = cleanAccountText(body.resultMode, 20);
    const deliveryMode = cleanAccountText(body.deliveryMode, 20) || "push";
    const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
      ? body.arguments as Record<string, unknown>
      : {};
    const argsJson = JSON.stringify(args);
    const deferDelivery = body.deferDelivery === true && resultMode !== "none";
    // 上限 15 分钟：邮件模式的送达依赖收件方拉取节奏（如 Mail 抓取 Gmail 是 15 分钟一轮），5 分钟常常不够
    const expiresInSeconds = Math.max(30, Math.min(900, Number(body.expiresInSeconds) || 120));
    if (!actionId || !actionName || !shortcutName || !RESULT_MODES.has(resultMode) || !DELIVERY_MODES.has(deliveryMode)) {
      return NextResponse.json({ ok: false, error: "快捷动作参数不完整。" }, { status: 400 });
    }
    if (argsJson.length > SHORTCUT_COMMAND_MAX_ARGS_BYTES) {
      return NextResponse.json({ ok: false, error: "快捷动作参数过大。" }, { status: 413 });
    }
    const emailRecipient = deliveryMode === "email"
      ? await getVerifiedShortcutEmailRecipient(account.id)
      : "";
    if (deliveryMode === "email" && !emailRecipient) {
      return NextResponse.json({ ok: false, error: "请先在 iOS 现实桥教程中验证接收邮箱。" }, { status: 400 });
    }

    await expireShortcutCommands(account.id);
    const pending = await supabaseRestFetch<{ id: string }[]>(
      `push_shortcut_commands?user_id=eq.${encodeSupabaseFilter(account.id)}&status=in.(pending,claimed)&select=id&limit=10`,
    );
    if (!pending.ok) return NextResponse.json({ ok: false, error: pending.error }, { status: 500 });
    if (pending.data.length >= 10) {
      return NextResponse.json({ ok: false, error: "待执行快捷命令过多，请先处理或等待过期。" }, { status: 429 });
    }
    const minuteStart = new Date(Date.now() - 60_000).toISOString();
    const recent = await supabaseRestFetch<{ id: string }[]>(
      `push_shortcut_commands?user_id=eq.${encodeSupabaseFilter(account.id)}&created_at=gte.${encodeSupabaseFilter(minuteStart)}&select=id&limit=6`,
    );
    if (!recent.ok) return NextResponse.json({ ok: false, error: recent.error }, { status: 500 });
    if (recent.data.length >= 6) {
      return NextResponse.json({ ok: false, error: "快捷动作触发过于频繁，请稍后再试。" }, { status: 429 });
    }
    const id = `cmd_${crypto.randomUUID()}`;
    const callbackToken = crypto.randomUUID().replace(/-/g, "");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
    const inserted = await supabaseRestFetch<ShortcutCommandRow[]>("push_shortcut_commands", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        id,
        user_id: account.id,
        action_id: actionId,
        action_name: actionName,
        shortcut_name: shortcutName,
        delivery_mode: deliveryMode,
        callback_token: callbackToken,
        action_args: args,
        result_mode: resultMode,
        status: "pending",
        expires_at: expiresAt,
      }]),
    });
    if (!inserted.ok || !inserted.data[0]) {
      return NextResponse.json({ ok: false, error: inserted.ok ? "命令创建失败。" : inserted.error }, { status: 500 });
    }

    const delivery = deferDelivery
      ? { delivered: false, deliveryMode: deliveryMode as "push" | "email" }
      : await deliverShortcutCommand(request.url, inserted.data[0]);
    if (!deferDelivery && deliveryMode === "email" && !delivery.delivered) {
      return NextResponse.json({ ok: false, error: `邮件发送失败：${delivery.error || "未知错误"}` }, { status: 502 });
    }

    const runUrl = (() => {
      const url = new URL("/shortcut-run", request.url);
      url.searchParams.set("command", inserted.data[0].id);
      url.searchParams.set("ticket", inserted.data[0].callback_token);
      return url.toString();
    })();

    return NextResponse.json({
      ok: true,
      command: toPublicShortcutCommand(inserted.data[0]),
      runUrl,
      delivered: delivery.delivered,
      deferred: deferDelivery,
      deliveryMode,
      push: delivery.push,
      email: delivery.email,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const url = new URL(request.url);
    const id = cleanAccountText(url.searchParams.get("id"), 100);
    await expireShortcutCommands(account.id, id || undefined);
    const idFilter = id ? `&id=eq.${encodeSupabaseFilter(id)}` : "";
    const limit = id ? 1 : Math.max(1, Math.min(30, Number(url.searchParams.get("limit")) || 12));
    const result = await supabaseRestFetch<ShortcutCommandRow[]>(
      `push_shortcut_commands?user_id=eq.${encodeSupabaseFilter(account.id)}${idFilter}&select=${SHORTCUT_COMMAND_SELECT}&order=created_at.desc&limit=${limit}`,
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    if (id) {
      const command = result.data[0];
      return command
        ? NextResponse.json({ ok: true, command: toPublicShortcutCommand(command) })
        : NextResponse.json({ ok: false, error: "命令不存在。" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, commands: result.data.map(toPublicShortcutCommand) });
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
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const id = cleanAccountText(body.id, 100);
    if (!id) return NextResponse.json({ ok: false, error: "缺少命令 ID。" }, { status: 400 });
    const result = await supabaseRestFetch(
      `push_shortcut_commands?id=eq.${encodeSupabaseFilter(id)}&user_id=eq.${encodeSupabaseFilter(account.id)}&status=in.(pending,claimed)`,
      { method: "PATCH", body: JSON.stringify({ status: "cancelled", updated_at: new Date().toISOString() }) },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
