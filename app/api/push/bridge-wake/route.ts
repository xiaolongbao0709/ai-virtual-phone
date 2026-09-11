import { NextResponse } from "next/server";

import { cleanAccountText } from "@/lib/server/account-auth";
import { encryptPushJobPayload } from "@/lib/server/push-job-crypto";
import { getOrCreatePushPayloadKey } from "@/lib/server/push-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

/**
 * 快捷指令唤醒入口（无登录态，凭 bridge_token 认账号）：
 * 上传事件到收件箱后调用一次，服务端 45 秒后扫描——若 App 活着，
 * 本地轮询（20s）会先拉走事件，扫描自然落空；App 被杀才由服务端接管。
 */
const SCAN_DELAY_MS = 45_000;

async function handleWake(request: Request, bodyToken: string) {
  try {
    const supabase = getSupabaseServerConfig();
    if (!supabase) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const url = new URL(request.url);
    const token = bodyToken || cleanAccountText(url.searchParams.get("token"), 100);
    if (!token) {
      return NextResponse.json({ ok: false, error: "缺少 token。" }, { status: 400 });
    }
    const config = await supabaseRestFetch<{ user_id: string }[]>(
      `push_bridge_config?bridge_token=eq.${encodeSupabaseFilter(token)}&select=user_id&limit=1`,
    );
    if (!config.ok) {
      return NextResponse.json({ ok: false, error: config.error }, { status: 500 });
    }
    const userId = config.data[0]?.user_id;
    if (!userId) {
      return NextResponse.json({ ok: false, error: "令牌无效。" }, { status: 403 });
    }

    // 同名扫描任务幂等覆盖：多个事件连续敲门只保留一次扫描（扫描会拉走全部）。
    // 预删除不限状态——push_jobs_trigger_idx 是全状态唯一索引，上次扫描留下的
    // done/failed 行不清掉会让后续所有唤醒撞唯一约束（首次成功、之后全失败）
    const triggerKey = `bridge:scan:${userId}`;
    const filter = `push_jobs?user_id=eq.${encodeSupabaseFilter(userId)}&trigger_key=eq.${encodeSupabaseFilter(triggerKey)}`;
    await supabaseRestFetch(filter, { method: "DELETE" });
    const insert = await supabaseRestFetch("push_jobs", {
      method: "POST",
      body: JSON.stringify([{
        id: `job_${crypto.randomUUID()}`,
        user_id: userId,
        trigger_key: triggerKey,
        kind: "bridge_scan",
        execute_at: new Date(Date.now() + SCAN_DELAY_MS).toISOString(),
        status: "pending",
        payload: encryptPushJobPayload(JSON.stringify({ kind: "bridge_scan" }), await getOrCreatePushPayloadKey()),
      }]),
    });
    if (!insert.ok) {
      // 并发唤醒（快捷指令里放两个唤醒步骤/连续触发）：另一次调用刚插完，
      // 扫描已经排上了，对本次也算成功
      if (/duplicate key/i.test(insert.error || "")) {
        return NextResponse.json({ ok: true, note: "scan already scheduled" });
      }
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

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  return handleWake(request, cleanAccountText(body.token, 100));
}

/** 快捷指令「获取 URL 内容」默认发 GET——同样支持，token 走查询参数。 */
export async function GET(request: Request) {
  return handleWake(request, "");
}
