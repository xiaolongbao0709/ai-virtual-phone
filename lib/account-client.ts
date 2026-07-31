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
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  }).catch(() => undefined);
}
