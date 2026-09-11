import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";

// 当前登录账号 ID 的本地副本。有些同步代码（提示词组装、桥同步的缓存判定）取不到
// React context 也等不了 /api/auth/me，但又必须按账号隔离缓存——同一台设备换账号
// 后若继续复用上一个账号的凭据缓存，会把邮件发到上一个账号的收件箱。
const ACTIVE_ACCOUNT_ID_KEY = "ai_phone_active_account_id_v1";
registerKvMigration(ACTIVE_ACCOUNT_ID_KEY);

/** 账号解析成功/登出时由 account-gate 维护；自部署模式下固定是 local_user。 */
export function saveActiveAccountId(accountId: string): void {
  try {
    if (accountId) kvSet(ACTIVE_ACCOUNT_ID_KEY, accountId);
    else kvRemove(ACTIVE_ACCOUNT_ID_KEY);
  } catch { /* 写不进去只会让按账号隔离的缓存失效，不影响主流程 */ }
}

/** 读不到就返回空串——调用方一律按「与缓存不匹配」处理，宁可多取一次也不复用。 */
export function loadActiveAccountId(): string {
  try {
    return kvGet(ACTIVE_ACCOUNT_ID_KEY) || "";
  } catch {
    return "";
  }
}

export type AccountProfile = {
  id: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
};

type AccountResponse = {
  ok?: boolean;
  account?: AccountProfile | null;
  error?: string;
};

/** 网络层失败（超时/断连）时返回的哨兵错误码——调用方据此走"重试"而非"登出"。 */
export const ACCOUNT_NETWORK_ERROR = "__network__";

// 切换网络（WiFi↔流量）后浏览器可能复用已死的旧连接，无超时的 fetch 会挂起
// 几十秒以上，页面卡在"正在校验账号"。统一加超时。
async function fetchWithTimeout(input: RequestInfo, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchCurrentAccount(): Promise<AccountResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout("/api/auth/me", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }, 10000);
  } catch {
    return { ok: false, account: null, error: ACCOUNT_NETWORK_ERROR };
  }
  const data = await response.json().catch(() => ({})) as AccountResponse;
  if (!response.ok) return { ok: false, account: null, error: data.error || "账号状态读取失败。" };
  return { ok: true, account: data.account ?? null };
}

export async function loginAccount(input: {
  username: string;
  password: string;
  activationCode?: string;
}): Promise<AccountResponse> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json().catch(() => ({})) as AccountResponse;
  if (!response.ok || !data.ok) return { ok: false, account: null, error: data.error || "登录失败。" };
  return { ok: true, account: data.account ?? null };
}

export async function changeAccountPassword(input: {
  oldPassword: string;
  newPassword: string;
}): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("/api/auth/change-password", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => null);
  if (!response) return { ok: false, error: "网络异常，请稍后再试。" };
  const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok || !data.ok) return { ok: false, error: data.error || "修改失败。" };
  return { ok: true };
}

export async function logoutAccount(): Promise<void> {
  // 先清账号标识：按账号隔离的缓存（桥代发令牌、邮件通道就绪）据此失效，
  // 换账号后不会复用上一个账号的凭据。
  saveActiveAccountId("");
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  }).catch(() => undefined);
}
