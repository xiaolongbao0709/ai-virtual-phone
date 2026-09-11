import { NextResponse } from "next/server";

import { cleanAccountText } from "@/lib/server/account-auth";
import {
  SHORTCUT_COMMAND_SELECT,
  type ShortcutCommandRow,
} from "@/lib/server/shortcut-commands";
import {
  encodeSupabaseFilter,
  formatSupabaseRestError,
  getSupabaseServerConfig,
  supabaseRestFetch,
} from "@/lib/server/supabase-rest";
import { shortcutCommandResultUrl } from "@/lib/server/shortcut-command-result-url";

const COMMAND_ID_PATTERN = /^cmd_[a-z0-9-]{20,80}$/i;
const CALLBACK_TOKEN_PATTERN = /^[a-f0-9]{32}$/i;

function shortcutUrl(
  command: ShortcutCommandRow,
  input: Record<string, unknown>,
): string {
  const isTextResult = command.result_mode === "text";
  const target = new URL(isTextResult
    ? "shortcuts://x-callback-url/run-shortcut"
    : "shortcuts://run-shortcut");
  target.searchParams.set("name", command.shortcut_name);
  target.searchParams.set("input", "text");
  target.searchParams.set("text", JSON.stringify(input));

  if (isTextResult) {
    const success = shortcutCommandResultUrl(command.id, command.callback_token);
    success.searchParams.set("status", "succeeded");
    const failed = new URL(success);
    failed.searchParams.set("status", "failed");
    const cancelled = new URL(failed);
    cancelled.searchParams.set("errorMessage", "快捷指令已取消。");
    target.searchParams.set("x-success", success.toString());
    target.searchParams.set("x-error", failed.toString());
    target.searchParams.set("x-cancel", cancelled.toString());
  }

  return target.toString();
}

export async function GET(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const requestUrl = new URL(request.url);
    const commandId = cleanAccountText(requestUrl.searchParams.get("command"), 100);
    const ticket = cleanAccountText(requestUrl.searchParams.get("ticket"), 64);
    if (!COMMAND_ID_PATTERN.test(commandId) || !CALLBACK_TOKEN_PATTERN.test(ticket)) {
      return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    const selected = await supabaseRestFetch<ShortcutCommandRow[]>(
      `push_shortcut_commands?id=eq.${encodeSupabaseFilter(commandId)}&callback_token=eq.${encodeSupabaseFilter(ticket)}&select=${SHORTCUT_COMMAND_SELECT}&limit=1`,
    );
    if (!selected.ok) return NextResponse.json({ ok: false, error: selected.error }, { status: 500 });
    const command = selected.data[0];
    if (!command) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

    const now = new Date();
    if (Date.parse(command.expires_at) <= now.getTime()) {
      await supabaseRestFetch(
        `push_shortcut_commands?id=eq.${encodeSupabaseFilter(command.id)}&status=in.(pending,claimed)`,
        { method: "PATCH", body: JSON.stringify({ status: "expired", updated_at: now.toISOString() }) },
      ).catch(() => undefined);
      return new Response(null, { status: 410, headers: { "Cache-Control": "no-store" } });
    }
    if (command.status !== "pending" && command.status !== "claimed") {
      return new Response(null, { status: 409, headers: { "Cache-Control": "no-store" } });
    }

    if (command.status === "pending") {
      const update = command.result_mode === "none"
        ? {
            status: "succeeded",
            result: { text: "快捷指令已启动。" },
            claimed_at: now.toISOString(),
            completed_at: now.toISOString(),
            updated_at: now.toISOString(),
          }
        : {
            status: "claimed",
            claimed_at: now.toISOString(),
            updated_at: now.toISOString(),
          };
      const claimed = await supabaseRestFetch<ShortcutCommandRow[]>(
        `push_shortcut_commands?id=eq.${encodeSupabaseFilter(command.id)}&callback_token=eq.${encodeSupabaseFilter(ticket)}&status=eq.pending&select=${SHORTCUT_COMMAND_SELECT}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(update),
        },
      );
      if (!claimed.ok || !claimed.data[0]) {
        return new Response(null, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      Object.assign(command, claimed.data[0]);
    }

    const input: Record<string, unknown> = {
      ...(command.action_args && typeof command.action_args === "object" ? command.action_args : {}),
      commandId: command.id,
      resultUrl: shortcutCommandResultUrl(command.id, command.callback_token).toString(),
    };

    return new Response(null, {
      status: 302,
      headers: {
        Location: shortcutUrl(command, input),
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
