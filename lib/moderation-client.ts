// 内容管理客户端：举报提交、管理员判定与管理中心操作的统一封装。

export type ReportContentType = "market_app" | "game" | "game_comment" | "online_doc" | "online_room";

export type ContentReport = {
  id: string;
  contentType: ReportContentType;
  contentId: string;
  contentPreview: string;
  contentOwnerId: string;
  contentOwnerName: string;
  reporterName: string;
  reason: string;
  status: "pending" | "resolved" | "dismissed";
  resolution: string;
  handledBy: string | null;
  handledAt: string | null;
  createdAt: string;
};

export async function moderationApi(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/moderation/reports", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || data.ok !== true) {
    throw new Error(String(data.error ?? `内容管理接口失败（HTTP ${response.status}）`));
  }
  return data;
}

/** 提交举报。重复举报同一内容也返回成功（服务端静默去重）。 */
export async function submitContentReport(input: {
  contentType: ReportContentType;
  contentId: string;
  reason?: string;
  preview?: string;
  ownerId?: string;
  ownerName?: string;
}): Promise<void> {
  await moderationApi({
    action: "submit",
    contentType: input.contentType,
    contentId: input.contentId,
    reason: input.reason ?? "",
    preview: input.preview ?? "",
    ownerId: input.ownerId ?? "",
    ownerName: input.ownerName ?? "",
  });
}

/** 当前登录账号是否管理员（管理中心入口显隐用；未登录/未配置一律 false）。 */
export async function fetchIsAdmin(): Promise<boolean> {
  try {
    const data = await moderationApi({ action: "me" });
    return data.isAdmin === true;
  } catch {
    return false;
  }
}

export async function fetchReports(status: "pending" | "resolved" | "dismissed"): Promise<ContentReport[]> {
  const data = await moderationApi({ action: "list", status });
  return Array.isArray(data.reports) ? data.reports as ContentReport[] : [];
}
