import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { encryptPushJobPayload } from "@/lib/server/push-job-crypto";
import { getOrCreatePushPayloadKey } from "@/lib/server/push-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

const MAX_SNAPSHOT_BYTES = 900_000;

/** 批量覆盖上传规则的 prompt 快照；delete 列表用于清掉已删除/关闭回话的规则。 */
export async function POST(request: Request) {
  try {
    const supabase = getSupabaseServerConfig();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({})) as {
      snapshots?: { ruleId?: unknown; payload?: unknown }[];
      deleteRuleIds?: unknown;
    };

    const deleteIds = Array.isArray(body.deleteRuleIds)
      ? body.deleteRuleIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 100)
      : [];
    for (const ruleId of deleteIds) {
      await supabaseRestFetch(
        `push_bridge_snapshots?user_id=eq.${encodeSupabaseFilter(account.id)}&rule_id=eq.${encodeSupabaseFilter(ruleId)}`,
        { method: "DELETE" },
      );
    }

    const snapshots = Array.isArray(body.snapshots) ? body.snapshots.slice(0, 30) : [];
    const payloadKey = snapshots.length > 0 ? await getOrCreatePushPayloadKey() : "";
    for (const snapshot of snapshots) {
      const ruleId = cleanAccountText(snapshot.ruleId, 100);
      if (!ruleId || !snapshot.payload || typeof snapshot.payload !== "object") continue;
      const plainJson = JSON.stringify(snapshot.payload);
      if (plainJson.length > MAX_SNAPSHOT_BYTES) continue;
      await supabaseRestFetch(
        `push_bridge_snapshots?user_id=eq.${encodeSupabaseFilter(account.id)}&rule_id=eq.${encodeSupabaseFilter(ruleId)}`,
        { method: "DELETE" },
      );
      const insert = await supabaseRestFetch("push_bridge_snapshots", {
        method: "POST",
        body: JSON.stringify([{
          user_id: account.id,
          rule_id: ruleId,
          payload: encryptPushJobPayload(plainJson, payloadKey),
          updated_at: new Date().toISOString(),
        }]),
      });
      if (!insert.ok) {
        return NextResponse.json({ ok: false, error: insert.error }, { status: 500 });
      }
    }
    return NextResponse.json({ ok: true, saved: snapshots.length, deleted: deleteIds.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
