import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { deliverShortcutCommand } from "@/lib/server/shortcut-command-delivery";
import { SHORTCUT_COMMAND_SELECT, expireShortcutCommands, type ShortcutCommandRow } from "@/lib/server/shortcut-commands";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

export async function POST(request: Request) {
    try {
        if (!getSupabaseServerConfig()) {
            return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
        }
        const account = await getCurrentAccount(request);
        if (!account) return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const commandId = cleanAccountText(body.commandId, 100);
        if (!commandId) return NextResponse.json({ ok: false, error: "缺少命令 ID。" }, { status: 400 });

        await expireShortcutCommands(account.id, commandId);
        const selected = await supabaseRestFetch<ShortcutCommandRow[]>(
            `push_shortcut_commands?id=eq.${encodeSupabaseFilter(commandId)}`
            + `&user_id=eq.${encodeSupabaseFilter(account.id)}`
            + `&select=${SHORTCUT_COMMAND_SELECT}&limit=1`,
        );
        if (!selected.ok) return NextResponse.json({ ok: false, error: selected.error }, { status: 500 });
        const command = selected.data[0];
        if (!command) return NextResponse.json({ ok: false, error: "命令不存在。" }, { status: 404 });
        if (command.status !== "pending" && command.status !== "claimed") {
            return NextResponse.json({ ok: false, error: command.error || `命令状态：${command.status}` }, { status: 409 });
        }

        const delivery = await deliverShortcutCommand(request.url, command);
        return delivery.delivered
            ? NextResponse.json({ ok: true, ...delivery })
            : NextResponse.json({ ok: false, ...delivery }, { status: 502 });
    } catch (err) {
        return NextResponse.json(
            { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
            { status: 500 },
        );
    }
}
