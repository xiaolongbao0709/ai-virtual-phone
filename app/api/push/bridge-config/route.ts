import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { encryptPushJobPayload } from "@/lib/server/push-job-crypto";
import { getOrCreatePushPayloadKey } from "@/lib/server/push-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

type ConfigRow = {
  bridge_token: string;
  updated_at: string;
};

/** 只收 https 源站，其余一律判无效——它要用来给回传地址做同源校验。 */
function normalizeCloudOrigin(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

/** 读取（必要时创建）本账号的桥唤醒令牌。 */
export async function GET(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const existing = await supabaseRestFetch<ConfigRow[]>(
      `push_bridge_config?user_id=eq.${encodeSupabaseFilter(account.id)}&select=bridge_token,updated_at&limit=1`,
    );
    if (!existing.ok) {
      return NextResponse.json({ ok: false, error: existing.error }, { status: 500 });
    }
    if (existing.data[0]) {
      return NextResponse.json({ ok: true, bridgeToken: existing.data[0].bridge_token, hasConfig: true });
    }
    const token = randomBytes(18).toString("hex");
    const insert = await supabaseRestFetch("push_bridge_config", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify([{ user_id: account.id, bridge_token: token }]),
    });
    if (!insert.ok) {
      return NextResponse.json({ ok: false, error: insert.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, bridgeToken: token, hasConfig: false });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

/** 同步规则/云配置/触发状态快照。 */
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
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    // 缺省即「不改这一项」：个人云模式下客户端只来登记 cloudOrigin，规则和触发
    // 状态留在用户自己的项目里，不能被这次调用洗成空。
    const rules = Array.isArray(body.rules) ? body.rules : null;
    if (rules && JSON.stringify(rules).length > 200_000) {
      return NextResponse.json({ ok: false, error: "规则快照过大。" }, { status: 413 });
    }
    const cloudConfig = body.cloudConfig && typeof body.cloudConfig === "object"
      ? encryptPushJobPayload(JSON.stringify(body.cloudConfig), await getOrCreatePushPayloadKey())
      : null;
    const ruleRuns = body.ruleRuns && typeof body.ruleRuns === "object" ? body.ruleRuns : null;
    // 个人云 Supabase 源站（明文，非密钥）：云端代发邮件时用来校验结果回传地址。
    const cloudOrigin = normalizeCloudOrigin(body.cloudOrigin);
    if (body.cloudOrigin !== undefined && !cloudOrigin) {
      return NextResponse.json({ ok: false, error: "个人云地址无效。" }, { status: 400 });
    }
    // 允许云端代发的邮件动作白名单：只收 actionId，代发路由据此拒绝表外动作。
    const emailActionIds = Array.isArray(body.emailActionIds)
      ? Array.from(new Set(body.emailActionIds
        .map(item => String(item ?? "").trim().slice(0, 100))
        .filter(Boolean))).slice(0, 40)
      : null;

    const filter = `push_bridge_config?user_id=eq.${encodeSupabaseFilter(account.id)}`;
    const patch = await supabaseRestFetch(filter, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        ...(rules ? { rules } : {}),
        ...(cloudConfig ? { cloud_config: cloudConfig } : {}),
        ...(ruleRuns ? { rule_runs: ruleRuns } : {}),
        ...(cloudOrigin ? { cloud_origin: cloudOrigin } : {}),
        ...(emailActionIds ? { email_action_ids: emailActionIds } : {}),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!patch.ok) {
      return NextResponse.json({ ok: false, error: patch.error }, { status: 500 });
    }
    if (Array.isArray(patch.data) && patch.data.length === 0) {
      // 行还不存在（用户没先 GET 过）——先建行再重试一次
      const token = randomBytes(18).toString("hex");
      await supabaseRestFetch("push_bridge_config", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates" },
        body: JSON.stringify([{
          user_id: account.id,
          bridge_token: token,
          ...(rules ? { rules } : {}),
          ...(cloudConfig ? { cloud_config: cloudConfig } : {}),
          ...(ruleRuns ? { rule_runs: ruleRuns } : {}),
          ...(cloudOrigin ? { cloud_origin: cloudOrigin } : {}),
          ...(emailActionIds ? { email_action_ids: emailActionIds } : {}),
        }]),
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
