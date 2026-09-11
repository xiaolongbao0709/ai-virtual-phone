import type { BridgeShortcutAction } from "./reality-bridge/storage";
import { bgDelay } from "./bg-timer";
import { isPersonalPushCloudActive, personalPushFetch } from "./personal-push-cloud";

export type ShortcutCommandStatus =
  | "pending"
  | "claimed"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export type ShortcutCommand = {
  id: string;
  actionId: string;
  actionName: string;
  shortcutName: string;
  deliveryMode: BridgeShortcutAction["deliveryMode"];
  arguments: Record<string, unknown>;
  resultMode: BridgeShortcutAction["resultMode"];
  status: ShortcutCommandStatus;
  result: unknown;
  error?: string;
  expiresAt: string;
  notifiedAt?: string;
  claimedAt?: string;
  completedAt?: string;
  createdAt: string;
};

export type ShortcutCommandCreateResult = {
  command: ShortcutCommand;
  /** 本机直接拉起快捷指令的票据地址（/shortcut-run?...）；前台场景绕开系统通知用 */
  runUrl?: string;
  /** 实际使用的通道：personal=用户自己的 Supabase；site=站点线（含个人云回落） */
  line: "personal" | "site";
  delivered: boolean;
  deferred?: boolean;
  push?: { sent?: number; total?: number; error?: string };
  email?: { sent?: boolean; subject?: string; error?: string };
};

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { ok?: boolean; error?: string };
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `快捷指令服务请求失败（${response.status}）`);
  }
  return data;
}

// 个人云部署后，推送类快捷命令整条链路（创建/通知/认领/结果回传）都走用户
// 自己的 Supabase；邮件模式仍需站点的邮件服务。本表记录本次会话里建在个人
// 云上的命令 ID，后续投递与轮询按此分流。
const personalCommandIds = new Set<string>();

/** 旧版个人网关没有 shortcut-* 动作，返回「不支持的离线推送操作」；此时静默回落站点线。 */
function isOldPersonalGateway(err: unknown): boolean {
  return err instanceof Error && err.message.includes("不支持的离线推送操作");
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof DOMException && err.name === "AbortError");
}

export async function createShortcutCommand(
  action: BridgeShortcutAction,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  options?: { deferDelivery?: boolean },
): Promise<ShortcutCommandCreateResult> {
  if (action.deliveryMode !== "email" && isPersonalPushCloudActive()) {
    try {
      const response = await personalPushFetch("shortcut-create", {
        method: "POST",
        body: JSON.stringify({
          actionId: action.id,
          actionName: action.name,
          shortcutName: action.shortcutName,
          arguments: args,
          resultMode: action.resultMode,
          expiresInSeconds: action.expiresInSeconds,
          deferDelivery: options?.deferDelivery === true,
        }),
        signal,
      });
      const data = await parseApiResponse<{
        ok: true;
        command: ShortcutCommand;
        runUrl?: string;
        delivered: boolean;
        deferred?: boolean;
        push?: ShortcutCommandCreateResult["push"];
      }>(response);
      personalCommandIds.add(data.command.id);
      // 网关返回的 run 地址是跨域的：PWA 里直接跳会掉进应用内浏览器且不跟进
      // shortcuts:// 重定向。包一层站点的同源转发路由，与通知的 navigate 同构。
      const runUrl = data.runUrl
        ? `${window.location.origin}/personal-shortcut-run?to=${encodeURIComponent(data.runUrl)}`
        : undefined;
      return { command: data.command, runUrl, line: "personal", delivered: data.delivered, deferred: data.deferred, push: data.push };
    } catch (err) {
      if (isAbort(err, signal) || !isOldPersonalGateway(err)) throw err;
      // 旧版网关：回落站点线，等用户重新部署后自动切换
    }
  }
  const response = await fetch("/api/push/shortcut-commands", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionId: action.id,
      actionName: action.name,
      shortcutName: action.shortcutName,
      deliveryMode: action.deliveryMode,
      arguments: args,
      resultMode: action.resultMode,
      expiresInSeconds: action.expiresInSeconds,
      deferDelivery: options?.deferDelivery === true,
    }),
    signal,
  });
  const data = await parseApiResponse<{
    ok: true;
    command: ShortcutCommand;
    runUrl?: string;
    delivered: boolean;
    deferred?: boolean;
    push?: ShortcutCommandCreateResult["push"];
    email?: ShortcutCommandCreateResult["email"];
  }>(response);
  return { command: data.command, runUrl: data.runUrl, line: "site", delivered: data.delivered, deferred: data.deferred, push: data.push, email: data.email };
}

export async function deliverShortcutCommand(
  commandId: string,
  signal?: AbortSignal,
): Promise<{ delivered: boolean; push?: ShortcutCommandCreateResult["push"]; email?: ShortcutCommandCreateResult["email"] }> {
  if (personalCommandIds.has(commandId)) {
    const response = await personalPushFetch("shortcut-deliver", {
      method: "POST",
      body: JSON.stringify({ commandId }),
      signal,
    });
    const data = await parseApiResponse<{ ok: true; delivered: boolean; push?: ShortcutCommandCreateResult["push"] }>(response);
    return { delivered: data.delivered, push: data.push };
  }
  const response = await fetch("/api/push/shortcut-commands/deliver", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commandId }),
    signal,
  });
  const data = await parseApiResponse<{
    ok: true;
    delivered: boolean;
    push?: ShortcutCommandCreateResult["push"];
    email?: ShortcutCommandCreateResult["email"];
  }>(response);
  return { delivered: data.delivered, push: data.push, email: data.email };
}

export async function waitForShortcutCommand(
  commandId: string,
  expiresAt: string,
  signal?: AbortSignal,
): Promise<ShortcutCommand> {
  const expiresMs = Date.parse(expiresAt);
  let last: ShortcutCommand | null = null;
  while (!Number.isFinite(expiresMs) || Date.now() <= expiresMs + 5_000) {
    let response: Response;
    try {
      response = personalCommandIds.has(commandId)
        ? await personalPushFetch("shortcut-commands", { signal }, { id: commandId })
        : await fetch(`/api/push/shortcut-commands?id=${encodeURIComponent(commandId)}`, {
            credentials: "include",
            cache: "no-store",
            signal,
          });
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) throw err;
      await bgDelay(1500, signal);
      continue;
    }
    if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
      await bgDelay(1500, signal);
      continue;
    }
    const data = await parseApiResponse<{ ok: true; command: ShortcutCommand }>(response);
    last = data.command;
    if (["succeeded", "failed", "expired", "cancelled"].includes(last.status)) return last;
    await bgDelay(1500, signal);
  }
  return last || {
    id: commandId,
    actionId: "",
    actionName: "",
    shortcutName: "",
    deliveryMode: "push",
    arguments: {},
    resultMode: "none",
    status: "expired",
    result: null,
    expiresAt,
    createdAt: new Date().toISOString(),
  };
}

export async function loadRecentShortcutCommands(limit = 12): Promise<ShortcutCommand[]> {
  const capped = Math.max(1, Math.min(30, limit));
  const fromSite = async () => {
    const response = await fetch(`/api/push/shortcut-commands?limit=${capped}`, {
      credentials: "include",
      cache: "no-store",
    });
    const data = await parseApiResponse<{ ok: true; commands: ShortcutCommand[] }>(response);
    return data.commands;
  };
  if (!isPersonalPushCloudActive()) return fromSite();
  // 个人云启用后推送命令在用户库、邮件命令仍在站点库，合并展示最近记录。
  const [personal, site] = await Promise.all([
    personalPushFetch("shortcut-commands", {}, { limit: String(capped) })
      .then(response => parseApiResponse<{ ok: true; commands: ShortcutCommand[] }>(response))
      .then(data => data.commands)
      .catch(() => [] as ShortcutCommand[]),
    fromSite().catch(() => [] as ShortcutCommand[]),
  ]);
  return [...personal, ...site]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, capped);
}
