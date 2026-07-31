import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { getModeratorContext, isAdminAccount } from "@/lib/server/admin-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";

// 内容管理：举报提交（登录用户）+ 举报处置/下架/封号（管理员）。
// 覆盖应用市场 APP、游戏大厅游戏与评论、联机云文档、联机房间。

const CONTENT_TYPES = new Set(["market_app", "game", "game_comment", "online_doc", "online_room"]);
const MAX_PENDING_PER_REPORTER = 20;

type ReportRow = {
  id: string;
  content_type: string;
  content_id: string;
  content_preview: string;
  content_owner_id: string;
  content_owner_name: string;
  reporter_id: string;
  reporter_name: string;
  reason: string;
  status: "pending" | "resolved" | "dismissed";
  resolution: string;
  handled_by: string | null;
  handled_at: string | null;
  created_at: string;
};

const REPORT_COLUMNS = "id,content_type,content_id,content_preview,content_owner_id,content_owner_name,reporter_id,reporter_name,reason,status,resolution,handled_by,handled_at,created_at";

function publicReport(row: ReportRow) {
  return {
    id: row.id,
    contentType: row.content_type,
    contentId: row.content_id,
    contentPreview: row.content_preview,
    contentOwnerId: row.content_owner_id,
    contentOwnerName: row.content_owner_name,
    reporterName: row.reporter_name,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    handledBy: row.handled_by,
    handledAt: row.handled_at,
    createdAt: row.created_at,
  };
}

/** 服务端补全联机内容的摘要与作者（其他类型由客户端提交时携带）。 */
async function resolveOnlineContentInfo(contentType: string, contentId: string): Promise<{ preview: string; ownerId: string; ownerName: string } | null> {
  if (contentType === "online_doc") {
    const found = await supabaseRestFetch<{ data: unknown; owner_id: string; owner_name: string; collection: string }[]>(
      `online_cloud_docs?id=eq.${encodeSupabaseFilter(contentId)}&select=data,owner_id,owner_name,collection&limit=1`,
    );
    const doc = found.ok ? found.data[0] : null;
    if (!doc) return null;
    return {
      preview: `[${doc.collection}] ${JSON.stringify(doc.data ?? {}).slice(0, 300)}`,
      ownerId: doc.owner_id,
      ownerName: doc.owner_name,
    };
  }
  if (contentType === "online_room") {
    const found = await supabaseRestFetch<{ title: string; host_user_id: string; host_name: string; namespace: string }[]>(
      `online_rooms?id=eq.${encodeSupabaseFilter(contentId)}&select=title,host_user_id,host_name,namespace&limit=1`,
    );
    const room = found.ok ? found.data[0] : null;
    if (!room) return null;
    return {
      preview: `[${room.namespace}] ${room.title || "(无标题房间)"}`,
      ownerId: room.host_user_id,
      ownerName: room.host_name,
    };
  }
  return null;
}

/** 软删除游戏评论及其全部楼中楼回复，返回删除条数。 */
async function takedownGameComment(commentId: string): Promise<number> {
  const found = await supabaseRestFetch<{ id: string; game_id: string }[]>(
    `game_hall_comments?id=eq.${encodeSupabaseFilter(commentId)}&deleted_at=is.null&select=id,game_id&limit=1`,
  );
  const comment = found.ok ? found.data[0] : null;
  if (!comment) return 0;
  const all = await supabaseRestFetch<{ id: string; parent_id: string | null }[]>(
    `game_hall_comments?game_id=eq.${encodeSupabaseFilter(comment.game_id)}&deleted_at=is.null&select=id,parent_id&limit=1000`,
  );
  const rows = all.ok ? all.data : [];
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parent_id) continue;
    const list = childrenOf.get(row.parent_id) ?? [];
    list.push(row.id);
    childrenOf.set(row.parent_id, list);
  }
  const deleteIds = [commentId];
  for (let i = 0; i < deleteIds.length; i += 1) {
    for (const child of childrenOf.get(deleteIds[i]) ?? []) deleteIds.push(child);
  }
  await supabaseRestFetch(
    `game_hall_comments?id=in.(${deleteIds.map(encodeSupabaseFilter).join(",")})`,
    { method: "PATCH", body: JSON.stringify({ deleted_at: new Date().toISOString() }) },
  );
  return deleteIds.length;
}

/** 按内容类型执行下架，返回处理说明。 */
async function takedownContent(contentType: string, contentId: string): Promise<string> {
  const now = new Date().toISOString();
  if (contentType === "market_app") {
    await supabaseRestFetch(`custom_app_market_apps?id=eq.${encodeSupabaseFilter(contentId)}`, {
      method: "PATCH", body: JSON.stringify({ deleted_at: now, updated_at: now }),
    });
    return "已下架市场应用";
  }
  if (contentType === "game") {
    await supabaseRestFetch(`game_hall_games?id=eq.${encodeSupabaseFilter(contentId)}`, {
      method: "PATCH", body: JSON.stringify({ deleted_at: now, updated_at: now }),
    });
    return "已下架游戏";
  }
  if (contentType === "game_comment") {
    const count = await takedownGameComment(contentId);
    return count > 0 ? `已删除评论（含 ${count - 1} 条回复）` : "评论已不存在";
  }
  if (contentType === "online_doc") {
    await supabaseRestFetch(`online_cloud_docs?id=eq.${encodeSupabaseFilter(contentId)}`, {
      method: "PATCH", body: JSON.stringify({ deleted_at: now, updated_at: now }),
    });
    return "已删除云端共享内容";
  }
  if (contentType === "online_room") {
    await supabaseRestFetch(`online_rooms?id=eq.${encodeSupabaseFilter(contentId)}`, {
      method: "PATCH", body: JSON.stringify({ status: "closed", closed_at: now, updated_at: now }),
    });
    return "已关闭联机房间";
  }
  return "未知内容类型";
}

async function resolveReport(reportId: string, resolution: string, actorLabel: string, status: "resolved" | "dismissed"): Promise<void> {
  await supabaseRestFetch(`content_reports?id=eq.${encodeSupabaseFilter(reportId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status, resolution, handled_by: actorLabel, handled_at: new Date().toISOString() }),
  });
}

export async function POST(request: NextRequest) {
  try {
    if (isSelfHostedModeEnabled()) {
      return NextResponse.json({ ok: false, error: "内容管理需要账号系统（联机模式），单机模式暂不支持。" }, { status: 400 });
    }
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "服务端未配置 Supabase。" }, { status: 503 });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "").trim();

    // ── 任意登录用户：查询自己是否管理员（管理中心入口显隐用）──
    if (action === "me") {
      const account = await getCurrentAccount(request);
      const isAdmin = account ? await isAdminAccount(account) : false;
      return NextResponse.json({ ok: true, isAdmin });
    }

    // ── 任意登录用户：提交举报 ──
    if (action === "submit") {
      const account = await getCurrentAccount(request);
      if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
      if (account.status === "disabled") return NextResponse.json({ ok: false, error: "当前账号已被停用。" }, { status: 403 });

      const contentType = String(body.contentType ?? "").trim();
      const contentId = String(body.contentId ?? "").trim();
      const reason = String(body.reason ?? "").slice(0, 500);
      if (!CONTENT_TYPES.has(contentType) || !contentId) {
        return NextResponse.json({ ok: false, error: "举报参数无效。" }, { status: 400 });
      }

      const pendingCount = await supabaseRestFetch<{ id: string }[]>(
        `content_reports?reporter_id=eq.${encodeSupabaseFilter(account.id)}&status=eq.pending&select=id&limit=${MAX_PENDING_PER_REPORTER + 1}`,
      );
      if (pendingCount.ok && pendingCount.data.length >= MAX_PENDING_PER_REPORTER) {
        return NextResponse.json({ ok: false, error: "你有太多待处理举报，请等待管理员处理后再提交。" }, { status: 429 });
      }

      // 联机内容由服务端补全摘要与作者；其他类型信任客户端携带（管理员处置前自会核实）
      let preview = String(body.preview ?? "").slice(0, 300);
      let ownerId = String(body.ownerId ?? "").slice(0, 160);
      let ownerName = String(body.ownerName ?? "").slice(0, 160);
      if (contentType === "online_doc" || contentType === "online_room") {
        const info = await resolveOnlineContentInfo(contentType, contentId);
        if (!info) return NextResponse.json({ ok: false, error: "被举报的内容不存在。" }, { status: 404 });
        preview = info.preview.slice(0, 300);
        ownerId = info.ownerId;
        ownerName = info.ownerName;
      }

      const insert = await supabaseRestFetch<ReportRow[]>("content_reports", {
        method: "POST",
        headers: { Prefer: "return=representation,resolution=ignore-duplicates" },
        body: JSON.stringify([{
          id: `rpt_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`,
          content_type: contentType,
          content_id: contentId,
          content_preview: preview,
          content_owner_id: ownerId,
          content_owner_name: ownerName,
          reporter_id: account.id,
          reporter_name: account.displayName || account.username,
          reason,
        }]),
      });
      if (!insert.ok) return NextResponse.json({ ok: false, error: insert.error }, { status: 500 });
      // 重复举报（唯一索引去重）也返回成功，不给刷举报的人反馈面
      return NextResponse.json({ ok: true });
    }

    // ── 以下全部需要管理员 ──
    const moderator = await getModeratorContext(request);
    if (!moderator) {
      return NextResponse.json({ ok: false, error: "需要管理员权限。" }, { status: 403 });
    }

    if (action === "list") {
      const status = ["pending", "resolved", "dismissed"].includes(String(body.status)) ? String(body.status) : "pending";
      const found = await supabaseRestFetch<ReportRow[]>(
        `content_reports?status=eq.${status}&select=${REPORT_COLUMNS}&order=created_at.desc&limit=100`,
      );
      if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: 500 });
      return NextResponse.json({ ok: true, reports: found.data.map(publicReport) });
    }

    if (action === "dismiss" || action === "takedown") {
      const reportId = String(body.reportId ?? "").trim();
      if (!reportId) return NextResponse.json({ ok: false, error: "缺少 reportId。" }, { status: 400 });
      const found = await supabaseRestFetch<ReportRow[]>(
        `content_reports?id=eq.${encodeSupabaseFilter(reportId)}&select=${REPORT_COLUMNS}&limit=1`,
      );
      const report = found.ok ? found.data[0] : null;
      if (!report) return NextResponse.json({ ok: false, error: "举报不存在。" }, { status: 404 });

      if (action === "dismiss") {
        await resolveReport(reportId, "举报被驳回", moderator.actorLabel, "dismissed");
        return NextResponse.json({ ok: true });
      }
      const resolution = await takedownContent(report.content_type, report.content_id);
      await resolveReport(reportId, resolution, moderator.actorLabel, "resolved");
      // 同一内容的其他待处理举报一并结掉
      await supabaseRestFetch(
        `content_reports?content_type=eq.${encodeSupabaseFilter(report.content_type)}&content_id=eq.${encodeSupabaseFilter(report.content_id)}&status=eq.pending`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "resolved", resolution: `${resolution}（合并处理）`, handled_by: moderator.actorLabel, handled_at: new Date().toISOString() }),
        },
      ).catch(() => undefined);
      return NextResponse.json({ ok: true, resolution });
    }

    // 直接下架（不经举报，管理员在内容页操作或按 contentType+contentId 处置）
    if (action === "takedownContent") {
      const contentType = String(body.contentType ?? "").trim();
      const contentId = String(body.contentId ?? "").trim();
      if (!CONTENT_TYPES.has(contentType) || !contentId) {
        return NextResponse.json({ ok: false, error: "参数无效。" }, { status: 400 });
      }
      const resolution = await takedownContent(contentType, contentId);
      return NextResponse.json({ ok: true, resolution });
    }

    if (action === "findUser") {
      const username = String(body.username ?? "").trim();
      if (!username) return NextResponse.json({ ok: false, error: "缺少 username。" }, { status: 400 });
      const found = await supabaseRestFetch<{ id: string; username: string; display_name: string; status: string }[]>(
        `app_users?username=eq.${encodeSupabaseFilter(username)}&select=id,username,display_name,status&limit=1`,
      );
      if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: 500 });
      const user = found.data[0];
      return NextResponse.json({
        ok: true,
        user: user ? { id: user.id, username: user.username, displayName: user.display_name, status: user.status } : null,
      });
    }

    if (action === "banUser" || action === "unbanUser") {
      const userId = String(body.userId ?? "").trim();
      if (!userId) return NextResponse.json({ ok: false, error: "缺少 userId。" }, { status: 400 });
      if (moderator.account && userId === moderator.account.id) {
        return NextResponse.json({ ok: false, error: "不能封禁自己。" }, { status: 400 });
      }
      // 不允许封禁其他管理员
      const target = await supabaseRestFetch<{ role?: string | null }[]>(
        `app_users?id=eq.${encodeSupabaseFilter(userId)}&select=role&limit=1`,
      ).catch(() => null);
      if (action === "banUser" && target?.ok && target.data[0]?.role === "admin") {
        return NextResponse.json({ ok: false, error: "不能封禁管理员账号。" }, { status: 400 });
      }
      const updated = await supabaseRestFetch<{ id: string }[]>(
        `app_users?id=eq.${encodeSupabaseFilter(userId)}&select=id`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: action === "banUser" ? "disabled" : "active", updated_at: new Date().toISOString() }),
        },
      );
      if (!updated.ok) return NextResponse.json({ ok: false, error: updated.error }, { status: 500 });
      if (updated.data.length === 0) return NextResponse.json({ ok: false, error: "用户不存在。" }, { status: 404 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "未知 action。" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err) },
      { status: 500 },
    );
  }
}
