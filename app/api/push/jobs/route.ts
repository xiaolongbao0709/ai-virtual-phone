import { NextResponse } from "next/server";

import { cleanAccountText, getCurrentAccount } from "@/lib/server/account-auth";
import { encryptPushJobPayload } from "@/lib/server/push-job-crypto";
import { getOrCreatePushPayloadKey } from "@/lib/server/push-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

const MAX_PAYLOAD_BYTES = 900_000;
const ALLOWED_KINDS = new Set(["followup", "reply_bailout", "timed_task", "shortcut_resume"]);
const SHARED_PUSH_DISABLED = true;

function sharedPushDisabledResponse() {
  return NextResponse.json({ ok: false, error: "本站共享离线推送已停用，请部署个人 Supabase。" }, { status: 503 });
}

export async function POST(request: Request) {
  if (SHARED_PUSH_DISABLED) return sharedPushDisabledResponse();
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
    const triggerKey = cleanAccountText(body.triggerKey, 200);
    const kind = cleanAccountText(body.kind, 40);
    const executeAtRaw = cleanAccountText(body.executeAt, 60);
    const executeAt = executeAtRaw ? new Date(executeAtRaw) : null;
    if (!triggerKey || !kind || !ALLOWED_KINDS.has(kind) || !executeAt || Number.isNaN(executeAt.getTime())) {
      return NextResponse.json({ ok: false, error: "预约参数不完整。" }, { status: 400 });
    }
    if (!body.payload || typeof body.payload !== "object") {
      return NextResponse.json({ ok: false, error: "缺少 payload。" }, { status: 400 });
    }
    const plainJson = JSON.stringify(body.payload);
    if (plainJson.length > MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ ok: false, error: "快照过大，已跳过兜底预约。" }, { status: 413 });
    }

    // 同一个触发键重挂即覆盖：先删后插，保持幂等。
    const filter = `user_id=eq.${encodeSupabaseFilter(account.id)}&trigger_key=eq.${encodeSupabaseFilter(triggerKey)}`;
    await supabaseRestFetch(`push_jobs?${filter}`, { method: "DELETE" });

    const insert = await supabaseRestFetch("push_jobs", {
      method: "POST",
      body: JSON.stringify([{
        id: `job_${crypto.randomUUID()}`,
        user_id: account.id,
        trigger_key: triggerKey,
        kind,
        execute_at: executeAt.toISOString(),
        status: "pending",
        payload: encryptPushJobPayload(plainJson, await getOrCreatePushPayloadKey()),
      }]),
    });
    if (!insert.ok) {
      return NextResponse.json({ ok: false, error: insert.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

/** 心跳续约：把 pending 预约的接管时刻推迟到 now+90s。本地生成期间每 30s 一跳。 */
export async function PATCH(request: Request) {
  if (SHARED_PUSH_DISABLED) return sharedPushDisabledResponse();
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const triggerKey = cleanAccountText(body.triggerKey, 200);
    if (!triggerKey) {
      return NextResponse.json({ ok: false, error: "缺少 triggerKey。" }, { status: 400 });
    }
    const runNow = body.runNow === true;
    const filter = `user_id=eq.${encodeSupabaseFilter(account.id)}&trigger_key=eq.${encodeSupabaseFilter(triggerKey)}&status=eq.pending`;
    const result = await supabaseRestFetch(`push_jobs?${filter}`, {
      method: "PATCH",
      body: JSON.stringify({
        execute_at: new Date(Date.now() + (runNow ? 0 : 90_000)).toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  if (SHARED_PUSH_DISABLED) return sharedPushDisabledResponse();
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const triggerKey = cleanAccountText(body.triggerKey, 200);
    const triggerPrefix = cleanAccountText(body.triggerPrefix, 200);
    // 前缀清理时可保留一个刚挂上的新键（先挂后清，防止清理和重挂之间被杀导致预约丢失）
    const excludeKey = cleanAccountText(body.excludeKey, 200);
    if (!triggerKey && !triggerPrefix) {
      return NextResponse.json({ ok: false, error: "缺少 triggerKey 或 triggerPrefix。" }, { status: 400 });
    }
    const userFilter = `user_id=eq.${encodeSupabaseFilter(account.id)}&status=eq.pending`;
    const keyFilter = triggerKey
      ? `trigger_key=eq.${encodeSupabaseFilter(triggerKey)}`
      : `trigger_key=like.${encodeSupabaseFilter(`${triggerPrefix}%`)}`
        + (excludeKey ? `&trigger_key=neq.${encodeSupabaseFilter(excludeKey)}` : "");
    const result = await supabaseRestFetch(`push_jobs?${userFilter}&${keyFilter}`, { method: "DELETE" });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
