import { shortcutEmailSubjectTag } from "../shortcut-email";
import { resolvePushSubject, sendPushToUser } from "./push-service";
import { getVerifiedShortcutEmailRecipient, sendShortcutEmail } from "./shortcut-email-service";
import { shortcutCommandResultUrl } from "./shortcut-command-result-url";
import type { ShortcutCommandRow } from "./shortcut-commands";
import { encodeSupabaseFilter, supabaseRestFetch } from "./supabase-rest";

export type ShortcutCommandDeliveryResult = {
    delivered: boolean;
    deliveryMode: "push" | "email";
    push?: { sent: number; total: number; error?: string };
    email?: { sent: boolean; subject: string; error?: string };
    error?: string;
};

function commandTicketUrl(path: string, requestUrl: string, commandId: string, ticket: string): string {
    const url = new URL(path, requestUrl);
    url.searchParams.set("command", commandId);
    url.searchParams.set("ticket", ticket);
    return url.toString();
}

export async function deliverShortcutCommand(
    requestUrl: string,
    command: ShortcutCommandRow,
): Promise<ShortcutCommandDeliveryResult> {
    if (command.notified_at) {
        return { delivered: true, deliveryMode: command.delivery_mode };
    }

    const expiresInSeconds = Math.max(1, Math.min(900, Math.ceil((Date.parse(command.expires_at) - Date.now()) / 1000)));
    if (command.delivery_mode === "push") {
        let sent = 0;
        let total = 0;
        let pushError = "";
        try {
            const push = await sendPushToUser(command.user_id, {
                type: "shortcut_command",
                title: `运行「${command.action_name}」`,
                body: "角色请求执行一条已授权的快捷动作，轻点开始。",
                tag: command.id,
                url: commandTicketUrl("/shortcut-run", requestUrl, command.id, command.callback_token),
                commandId: command.id,
                ttl: expiresInSeconds,
            }, resolvePushSubject(requestUrl));
            sent = push.sent;
            total = push.total;
            pushError = push.errors[0] || "";
        } catch (err) {
            pushError = err instanceof Error ? err.message : String(err);
        }
        const delivered = sent > 0;
        if (delivered) {
            const now = new Date().toISOString();
            await supabaseRestFetch(
                `push_shortcut_commands?id=eq.${encodeSupabaseFilter(command.id)}&user_id=eq.${encodeSupabaseFilter(command.user_id)}`,
                { method: "PATCH", body: JSON.stringify({ notified_at: now, updated_at: now }) },
            ).catch(() => undefined);
        }
        return {
            delivered,
            deliveryMode: "push",
            push: { sent, total, error: pushError || undefined },
            error: delivered ? undefined : pushError || "当前账号没有可用的 Web Push 订阅。",
        };
    }

    const recipient = await getVerifiedShortcutEmailRecipient(command.user_id);
    if (!recipient) {
        return { delivered: false, deliveryMode: "email", error: "请先验证接收邮箱。" };
    }
    const subject = `${shortcutEmailSubjectTag(command.action_id)} ${command.action_name}`;
    let emailError = "";
    try {
        await sendShortcutEmail({
            to: recipient,
            subject,
            text: JSON.stringify({
                ...(command.action_args || {}),
                commandId: command.id,
                resultUrl: shortcutCommandResultUrl(command.id, command.callback_token).toString(),
            }),
            idempotencyKey: `shortcut-command-${command.id}`,
        });
    } catch (err) {
        emailError = err instanceof Error ? err.message : String(err);
    }
    const delivered = !emailError;
    const now = new Date().toISOString();
    await supabaseRestFetch(
        `push_shortcut_commands?id=eq.${encodeSupabaseFilter(command.id)}&user_id=eq.${encodeSupabaseFilter(command.user_id)}`,
        {
            method: "PATCH",
            body: JSON.stringify(delivered
                ? { notified_at: now, updated_at: now }
                : { status: "failed", error: emailError || "邮件发送失败。", completed_at: now, updated_at: now }),
        },
    ).catch(() => undefined);
    return {
        delivered,
        deliveryMode: "email",
        email: { sent: delivered, subject, error: emailError || undefined },
        error: delivered ? undefined : emailError || "邮件发送失败。",
    };
}
