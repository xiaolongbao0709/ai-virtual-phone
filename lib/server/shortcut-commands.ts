import { encodeSupabaseFilter, supabaseRestFetch } from "./supabase-rest";

export const SHORTCUT_COMMAND_MAX_ARGS_BYTES = 16_000;

export type ShortcutCommandStatus =
  | "pending"
  | "claimed"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export type ShortcutCommandRow = {
  id: string;
  user_id: string;
  action_id: string;
  action_name: string;
  shortcut_name: string;
  delivery_mode: "push" | "email";
  callback_token: string;
  action_args: Record<string, unknown> | null;
  result_mode: "none" | "text" | "image";
  status: ShortcutCommandStatus;
  result: unknown;
  error: string | null;
  expires_at: string;
  notified_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicShortcutCommand = {
  id: string;
  actionId: string;
  actionName: string;
  shortcutName: string;
  deliveryMode: "push" | "email";
  arguments: Record<string, unknown>;
  resultMode: "none" | "text" | "image";
  status: ShortcutCommandStatus;
  result: unknown;
  error?: string;
  expiresAt: string;
  notifiedAt?: string;
  claimedAt?: string;
  completedAt?: string;
  createdAt: string;
};

export const SHORTCUT_COMMAND_SELECT = [
  "id",
  "user_id",
  "action_id",
  "action_name",
  "shortcut_name",
  "delivery_mode",
  "callback_token",
  "action_args",
  "result_mode",
  "status",
  "result",
  "error",
  "expires_at",
  "notified_at",
  "claimed_at",
  "completed_at",
  "created_at",
  "updated_at",
].join(",");

export function toPublicShortcutCommand(row: ShortcutCommandRow): PublicShortcutCommand {
  return {
    id: row.id,
    actionId: row.action_id,
    actionName: row.action_name,
    shortcutName: row.shortcut_name,
    deliveryMode: row.delivery_mode,
    arguments: row.action_args && typeof row.action_args === "object" ? row.action_args : {},
    resultMode: row.result_mode,
    status: row.status,
    result: row.result ?? null,
    error: row.error || undefined,
    expiresAt: row.expires_at,
    notifiedAt: row.notified_at || undefined,
    claimedAt: row.claimed_at || undefined,
    completedAt: row.completed_at || undefined,
    createdAt: row.created_at,
  };
}

export async function expireShortcutCommands(userId: string, commandId?: string): Promise<void> {
  const now = new Date().toISOString();
  const idFilter = commandId ? `&id=eq.${encodeSupabaseFilter(commandId)}` : "";
  await supabaseRestFetch(
    `push_shortcut_commands?user_id=eq.${encodeSupabaseFilter(userId)}${idFilter}&status=in.(pending,claimed)&expires_at=lt.${encodeSupabaseFilter(now)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "expired", updated_at: now }),
    },
  ).catch(() => undefined);
}
