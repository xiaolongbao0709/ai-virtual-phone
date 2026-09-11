import { NextResponse } from "next/server";

import { cleanAccountText } from "@/lib/server/account-auth";
import { shortcutEmailSubjectTag } from "@/lib/shortcut-email";
import { getVerifiedShortcutEmailRecipient, sendShortcutEmail } from "@/lib/server/shortcut-email-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

/**
 * 云端代发触发邮件（无登录态，凭 bridge_token 认账号）。
 *
 * 为什么要有这条路由：邮件模式的快捷动作靠 iOS 自动化「收到信就跑」，是唯一
 * 无需用户点确认的通道，恰恰最适合 App 被杀、由云端接管生成的场景。但发信要
 * RESEND_API_KEY / REALITY_BRIDGE_EMAIL_FROM，这是站点的环境变量，用户自己的
 * Supabase 边缘函数里没有（ai-phone-push 的投递实现只会发 Web Push）。所以让
 * 个人云把「发这封信」外包给站点：站点只管发信，命令行、结果回传、续跑快照
 * 全部留在个人云闭环，这边不碰命令表也不写命令状态。
 *
 * 自部署用户的「站点」就是他自己那份部署，走的是同一条代码路径。
 *
 * ── 信任边界（改动前先读这一段）──
 * 站点看不到个人云那张命令表，做不到跨库核对命令本身，所以用两道旁证把关：
 *   1. actionId 必须在客户端同步上来的 email_action_ids 白名单里；
 *   2. 结果回传地址必须落在该账号登记的个人云源站上（resultUrlAllowed），
 *      令牌泄露也没法把快捷指令的输出引到别处。
 *
 * 仍未做的是**按各动作自己的 schema 校验参数**——参数由模型填写、原样进邮件正文。
 * 也就是说，能影响角色上下文的人（群成员、工具抓回的网页、自定义 APP）理论上能
 * 诱导出一次带任意参数的白名单内动作。要收紧就得把每个动作的 schema 也同步过来。
 */

/** 频控与 ai-phone-push 的 shortcut-create 同级：每分钟至多 6 封。 */
/** 仅供 RPC 缺失时的回退实现使用；须与 push_shortcut_email_claim_slot 里写死的值一致。 */
const CLOUD_DELIVERY_WINDOW_MS = 60_000;
const CLOUD_DELIVERY_MAX_PER_WINDOW = 6;
const MAX_ARGS_BYTES = 4000;
/** 与签发方 supabase/functions/ai-phone-push 的 SHORTCUT_COMMAND_ID_PATTERN 保持一致。 */
const SHORTCUT_COMMAND_ID_PATTERN = /^cmd_[a-z0-9-]{20,80}$/i;

type BridgeConfigRow = { user_id: string; cloud_origin: string | null; email_action_ids: string[] | null };
type EmailThrottleRow = { cloud_delivery_count: number | null; cloud_delivery_window_start: string | null };

function fail(error: string, status: number) {
    return NextResponse.json({ ok: false, error }, { status });
}

/** 结果回传地址必须落在该账号登记的个人云源站上。令牌泄露也无法把输出引去别处。 */
function resultUrlAllowed(resultUrl: string, cloudOrigin: string | null): boolean {
    if (!cloudOrigin) return false;
    try {
        const target = new URL(resultUrl);
        if (target.protocol !== "https:") return false;
        return target.origin === new URL(cloudOrigin).origin;
    } catch {
        return false;
    }
}

/** 函数不存在、或还是旧的三参数签名（找不到匹配重载）都算「没有可用 RPC」。 */
function isMissingClaimSlotRpc(error: string): boolean {
    return /push_shortcut_email_claim_slot|PGRST202|Could not find the function|schema cache|does not exist/i.test(error);
}

/**
 * 固定窗口频控。优先走行锁下读改写的 RPC，两个并发请求不会都读到旧计数而双双放行。
 * 老库没建这个函数时退回非原子实现——功能不能因为少跑一段 DDL 就整个失效，
 * 代价只是并发下同一窗口可能多放行一两封。
 */
async function claimDeliverySlot(userId: string): Promise<boolean> {
    // 窗口与上限由函数内部写死（它是 security definer，参数越少攻击面越小），
    // 这里只传 user_id。老库若还是三参数签名，下面的 miss 判定会走回退实现。
    const rpc = await supabaseRestFetch<boolean>("rpc/push_shortcut_email_claim_slot", {
        method: "POST",
        body: JSON.stringify({ p_user_id: userId }),
    });
    if (rpc.ok) return rpc.data === true;
    if (!isMissingClaimSlotRpc(rpc.error)) throw new Error(rpc.error);

    const filter = `push_shortcut_email_config?user_id=eq.${encodeSupabaseFilter(userId)}`;
    const current = await supabaseRestFetch<EmailThrottleRow[]>(
        `${filter}&select=cloud_delivery_count,cloud_delivery_window_start&limit=1`,
    );
    if (!current.ok) throw new Error(current.error);
    const row = current.data[0];
    if (!row) return false;

    const now = Date.now();
    const startedAt = Date.parse(String(row.cloud_delivery_window_start ?? ""));
    const withinWindow = Number.isFinite(startedAt) && now - startedAt < CLOUD_DELIVERY_WINDOW_MS;
    const count = withinWindow ? Number(row.cloud_delivery_count) || 0 : 0;
    if (withinWindow && count >= CLOUD_DELIVERY_MAX_PER_WINDOW) return false;

    await supabaseRestFetch(filter, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
            cloud_delivery_count: count + 1,
            ...(withinWindow ? {} : { cloud_delivery_window_start: new Date(now).toISOString() }),
        }),
    }).catch(() => undefined);
    return true;
}

export async function POST(request: Request) {
    try {
        if (!getSupabaseServerConfig()) return fail("Supabase 环境变量未配置。", 503);

        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const token = cleanAccountText(body.token, 100);
        if (!token) return fail("缺少 token。", 400);

        const actionId = cleanAccountText(body.actionId, 100);
        const actionName = cleanAccountText(body.actionName, 60);
        const commandId = cleanAccountText(body.commandId, 100);
        const resultUrl = cleanAccountText(body.resultUrl, 600);
        if (!actionId || !actionName || !commandId || !resultUrl) return fail("快捷动作参数不完整。", 400);
        if (!SHORTCUT_COMMAND_ID_PATTERN.test(commandId)) return fail("命令 ID 无效。", 400);

        const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
            ? body.arguments as Record<string, unknown>
            : {};
        if (JSON.stringify(args).length > MAX_ARGS_BYTES) return fail("快捷动作参数过大。", 413);

        const config = await supabaseRestFetch<BridgeConfigRow[]>(
            `push_bridge_config?bridge_token=eq.${encodeSupabaseFilter(token)}`
            + `&select=user_id,cloud_origin,email_action_ids&limit=1`,
        );
        // 这是公开路由：库的原始报错只写日志，不回给调用方
        if (!config.ok) {
            console.warn("[DeliverEmail] bridge config lookup failed:", config.error);
            return fail("服务暂时不可用。", 500);
        }
        const row = config.data[0];
        if (!row?.user_id) return fail("令牌无效。", 403);

        if (!resultUrlAllowed(resultUrl, row.cloud_origin)) {
            return fail("结果回传地址不在该账号登记的个人云源站上。", 403);
        }

        // 只放行客户端登记过的邮件动作。站点看不到个人云的命令表，没有这道白名单
        // 就只能相信调用方报上来的 actionId，等于拿到 bridge_token 就能触发任意
        // 快捷指令——而快捷指令是用户自己登记的，不能假定它一定无害。
        const allowedActionIds = Array.isArray(row.email_action_ids) ? row.email_action_ids : [];
        if (!allowedActionIds.includes(actionId)) {
            return fail("该动作不在此账号登记的云端代发白名单内。", 403);
        }

        const recipient = await getVerifiedShortcutEmailRecipient(row.user_id);
        if (!recipient) return fail("请先验证接收邮箱。", 409);

        if (!await claimDeliverySlot(row.user_id)) return fail("云端代发邮件过于频繁，请稍后再试。", 429);

        // 正文与前台同构：iOS 自动化按主题里的动作标签分流，按 JSON 取参数与回传地址。
        await sendShortcutEmail({
            to: recipient,
            subject: `${shortcutEmailSubjectTag(actionId)} ${actionName}`,
            text: JSON.stringify({ ...args, commandId, resultUrl }),
            idempotencyKey: `shortcut-command-${commandId}`,
        });
        return NextResponse.json({ ok: true, delivered: true, deliveryMode: "email" });
    } catch (err) {
        const message = formatSupabaseRestError(err instanceof Error ? err.message : String(err));
        console.warn("[DeliverEmail] failed:", message);
        // 「邮件服务尚未配置」是调用方需要知道的配置结论，可以回传；
        // 其余错误可能带库结构细节，公开路由上一律收敛成一句话。
        const configurationIssue = /尚未配置|收件邮箱/.test(message);
        return NextResponse.json(
            { ok: false, delivered: false, error: configurationIssue ? message : "代发邮件失败。" },
            { status: configurationIssue ? 503 : 500 },
        );
    }
}
