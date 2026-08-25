import { getSupabaseServerConfig } from "./supabase-rest";

const SHORTCUT_RESULT_FUNCTION = "push-shortcut-result";

export function shortcutCommandResultUrl(commandId: string, ticket: string): URL {
    const config = getSupabaseServerConfig();
    if (!config) throw new Error("Supabase 环境变量未配置。");
    const url = new URL(`/functions/v1/${SHORTCUT_RESULT_FUNCTION}`, config.url);
    url.searchParams.set("command", commandId);
    url.searchParams.set("ticket", ticket);
    return url;
}
