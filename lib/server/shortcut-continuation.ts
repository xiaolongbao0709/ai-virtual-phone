import { encodeSupabaseFilter, supabaseRestFetch } from "./supabase-rest";

/** Start the takeover lease after a result arrives; a live client keeps extending it. */
export async function wakeShortcutContinuation(userId: string, commandId: string): Promise<void> {
    const triggerKey = `shortcut:${commandId}`;
    const now = new Date().toISOString();
    const executeAt = new Date(Date.now() + 30_000).toISOString();
    await supabaseRestFetch(
        `push_jobs?user_id=eq.${encodeSupabaseFilter(userId)}`
        + `&trigger_key=eq.${encodeSupabaseFilter(triggerKey)}`
        + "&kind=eq.shortcut_resume&status=eq.pending",
        {
            method: "PATCH",
            body: JSON.stringify({ execute_at: executeAt, updated_at: now }),
        },
    ).catch(() => undefined);
}
