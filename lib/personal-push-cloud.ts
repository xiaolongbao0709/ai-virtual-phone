import {
  isCloudBackupConfigured,
  loadCloudBackupConfig,
  normalizeBackupUrl,
} from "./cloud-backup/config";
import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";

const PERSONAL_PUSH_STATE_KEY = "personal_push_cloud_state_v1";
// 与 push-client 的账号订阅门控同一键；部署完成到独立订阅写入前必须保持关闭，
// 即使用户中途关页也不会把任务发到一个尚无订阅的个人项目。
const PUSH_SUBSCRIPTION_GATE_KEY = "push_account_subscribed_v1";
export const PERSONAL_PUSH_GATEWAY_SLUG = "ai-phone-push";
export const PERSONAL_PUSH_GENERATE_SLUG = "push-generate";
export const PERSONAL_PUSH_SW_SCOPE = "/personal-push/";
export const PERSONAL_PUSH_SCHEMA_VERSION = 3;

registerKvMigration(PERSONAL_PUSH_STATE_KEY);

export type PersonalPushCloudState = {
  enabled: boolean;
  projectRef: string;
  url: string;
  deployedAt: string;
  healthStatus: "ready" | "pending";
  schemaVersion: number;
  healthError?: string;
};

function projectRefFromUrl(value: string): string {
  try {
    return new URL(normalizeBackupUrl(value)).hostname.split(".")[0] || "";
  } catch {
    return "";
  }
}

export function loadPersonalPushCloudState(): PersonalPushCloudState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = kvGet(PERSONAL_PUSH_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersonalPushCloudState>;
    const url = normalizeBackupUrl(typeof parsed.url === "string" ? parsed.url : "");
    const projectRef = typeof parsed.projectRef === "string" ? parsed.projectRef : "";
    if (parsed.enabled !== true || !url || !projectRef) return null;
    return {
      enabled: true,
      projectRef,
      url,
      deployedAt: typeof parsed.deployedAt === "string" ? parsed.deployedAt : "",
      // 旧版本只会在健康检查通过后写入状态，因此向后兼容时视为 ready。
      healthStatus: parsed.healthStatus === "pending" ? "pending" : "ready",
      schemaVersion: Number.isSafeInteger(parsed.schemaVersion) ? Number(parsed.schemaVersion) : 2,
      healthError: typeof parsed.healthError === "string" ? parsed.healthError : undefined,
    };
  } catch {
    return null;
  }
}

/** 屏幕速聊只允许进入带连续会话/原子写入结构的最新版个人云。 */
export function isPersonalScreenChatCloudReady(): boolean {
  const state = loadPersonalPushCloudState();
  return Boolean(
    isPersonalPushCloudActive()
    && state?.healthStatus === "ready"
    && state.schemaVersion >= PERSONAL_PUSH_SCHEMA_VERSION,
  );
}

/** 只有部署记录和当前云备份仍指向同一个项目时才启用，防止换项目后误发数据。 */
export function isPersonalPushCloudActive(): boolean {
  const state = loadPersonalPushCloudState();
  const backup = loadCloudBackupConfig();
  return Boolean(
    state
    && isCloudBackupConfigured(backup)
    && state.projectRef === projectRefFromUrl(backup.url)
    && state.url === normalizeBackupUrl(backup.url),
  );
}

export function disablePersonalPushCloud(): void {
  if (typeof window === "undefined") return;
  kvRemove(PERSONAL_PUSH_STATE_KEY);
}

function requirePersonalPushConfig() {
  const backup = loadCloudBackupConfig();
  const state = loadPersonalPushCloudState();
  if (!state || !isCloudBackupConfigured(backup) || !isPersonalPushCloudActive()) {
    throw new Error("个人离线推送尚未部署，或 Supabase 项目已经变更。");
  }
  return { backup, state };
}

export async function personalPushFetch(
  action: string,
  init: RequestInit = {},
  params?: Record<string, string>,
): Promise<Response> {
  const { backup, state } = requirePersonalPushConfig();
  const headers = new Headers(init.headers);
  headers.set("x-ai-phone-service-key", backup.key.trim());
  headers.set("x-ai-phone-origin", typeof window !== "undefined" ? window.location.origin : "");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const query = new URLSearchParams({ action, ...(params || {}) });
  return fetch(`${state.url}/functions/v1/${PERSONAL_PUSH_GATEWAY_SLUG}?${query.toString()}`, {
    ...init,
    headers,
    cache: "no-store",
  });
}

/** 预约流量在个人云启用后直达用户 Supabase；未启用时保持原有站点通道。 */
/** 在线开关个人云的每分钟任务扫描（网关函数直连数据库执行 cron 开关）。 */
export async function setPersonalPushCloudScheduled(enabled: boolean): Promise<void> {
  const res = await personalPushFetch("schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enable: enabled }),
  });
  const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `云函数返回 HTTP ${res.status}（旧版函数不支持在线开关，请到云服务部署里重新部署离线推送）`);
  }
}

export function pushJobsFetch(init: RequestInit): Promise<Response> {
  if (isPersonalPushCloudActive()) return personalPushFetch("jobs", init);
  return fetch("/api/push/jobs", { ...init, credentials: "include" });
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function isTransientHealthFailure(response: Response | null): boolean {
  return response === null || [404, 502, 503, 504].includes(response.status);
}

function savePersonalPushState(state: PersonalPushCloudState): void {
  kvSet(PERSONAL_PUSH_STATE_KEY, JSON.stringify(state));
  // 一旦管理接口确认个人函数已部署，立即关闭共享任务门控。即使健康检查尚在传播，
  // 也只允许等待个人云，绝不把任务重新送回 Netlify。
  kvSet(PUSH_SUBSCRIPTION_GATE_KEY, JSON.stringify({ subscribed: false, checkedAt: Date.now() }));
}

async function waitForPersonalPushHealth(
  url: string,
  serviceKey: string,
): Promise<{ ready: boolean; error?: string }> {
  const delays = [0, 1_500, 3_000, 5_000, 8_000];
  let lastError = "云函数仍在等待 Supabase 边缘节点生效。";
  for (const delayMs of delays) {
    if (delayMs > 0) await wait(delayMs);
    const health = await fetch(`${url}/functions/v1/${PERSONAL_PUSH_GATEWAY_SLUG}?action=health`, {
      headers: {
        "x-ai-phone-service-key": serviceKey,
        "x-ai-phone-origin": window.location.origin,
      },
      cache: "no-store",
    }).catch(() => null);
    const data = health ? await health.json().catch(() => ({})) as {
      ok?: boolean;
      error?: string;
      schemaVersion?: number;
      capabilities?: string[];
    } : null;
    if (
      health?.ok
      && data?.ok === true
      && Number(data.schemaVersion) >= PERSONAL_PUSH_SCHEMA_VERSION
      && data.capabilities?.includes("screen-chat-continuous")
    ) return { ready: true };
    if (health?.ok && data?.ok === true) {
      lastError = "个人云版本较旧，请重新部署后再启用屏幕速聊。";
      return { ready: false, error: lastError };
    }
    lastError = data?.error || (health ? `健康检查返回 HTTP ${health.status}` : "暂时无法连接个人云函数");
    // 无效密钥、数据库权限等确定性错误无需等待 17 秒后重复报错。
    if (!isTransientHealthFailure(health)) return { ready: false, error: lastError };
  }
  return { ready: false, error: lastError };
}

export type PersonalPushConnectOutcome =
  | { status: "connected"; note?: string }
  | { status: "absent"; error?: string };

/**
 * 换设备重连：不重新部署、不需要 Access Token。
 * 用当前云备份配置（URL + service_role key）打一次既有网关函数的健康检查，
 * 通过就地恢复本机部署状态；函数不存在（404）或探测失败则维持未部署。
 * 旧版函数也接：基础离线推送可用，schemaVersion 如实记录，屏幕速聊等
 * 新能力仍由 isPersonalScreenChatCloudReady 按版本关着，提示用户升级部署。
 */
export async function connectPersonalPushCloud(): Promise<PersonalPushConnectOutcome> {
  const backup = loadCloudBackupConfig();
  if (!isCloudBackupConfigured(backup)) {
    throw new Error("请先填写并测试 Supabase 地址与 service_role key。");
  }
  const url = normalizeBackupUrl(backup.url);
  const projectRef = projectRefFromUrl(url);
  if (!projectRef) throw new Error("无法从 Supabase URL 解析项目标识。");

  const res = await fetch(`${url}/functions/v1/${PERSONAL_PUSH_GATEWAY_SLUG}?action=health`, {
    headers: {
      "x-ai-phone-service-key": backup.key.trim(),
      "x-ai-phone-origin": window.location.origin,
    },
    cache: "no-store",
  }).catch(() => null);
  if (!res) return { status: "absent", error: "无法连接 Supabase 云函数" };
  if (res.status === 404) return { status: "absent" };
  const data = await res.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
    schemaVersion?: number;
    capabilities?: string[];
  };
  if (!(res.ok && data?.ok === true)) {
    return { status: "absent", error: data?.error || `健康检查返回 HTTP ${res.status}` };
  }

  const reported = Number(data.schemaVersion);
  const upToDate = reported >= PERSONAL_PUSH_SCHEMA_VERSION
    && Boolean(data.capabilities?.includes("screen-chat-continuous"));
  savePersonalPushState({
    enabled: true,
    projectRef,
    url,
    deployedAt: new Date().toISOString(),
    healthStatus: "ready",
    // 版本号如实记录；报了新版本号但缺能力标记的异常情况按旧版收，
    // 免得屏幕速聊被误放行
    schemaVersion: upToDate
      ? reported
      : Math.min(Number.isSafeInteger(reported) ? reported : 2, PERSONAL_PUSH_SCHEMA_VERSION - 1),
  });
  return {
    status: "connected",
    note: upToDate ? undefined : "云函数版本较旧：基础离线推送可用，屏幕速聊等新能力需重新部署升级（云端数据不受影响）。",
  };
}

export async function deployPersonalPushCloud(accessToken: string): Promise<PersonalPushCloudState> {
  const backup = loadCloudBackupConfig();
  if (!isCloudBackupConfigured(backup)) {
    throw new Error("请先在数据管理里配置并测试 Supabase 云端备份。");
  }
  const token = accessToken.trim();
  if (!token) throw new Error("请先粘贴 Supabase Access Token。");
  const url = normalizeBackupUrl(backup.url);
  const projectRef = projectRefFromUrl(url);
  if (!projectRef) throw new Error("无法从 Supabase URL 解析项目标识。");

  const [gatewayRes, generateRes, resultRes, bridgeRes, screenRes, schemaRes] = await Promise.all([
    fetch("/ai-phone-push/gateway.mjs", { cache: "no-store" }),
    fetch("/ai-phone-push/push-generate.mjs", { cache: "no-store" }),
    fetch("/ai-phone-push/push-shortcut-result.mjs", { cache: "no-store" }),
    fetch("/ai-phone-push/push-bridge.mjs", { cache: "no-store" }),
    fetch("/ai-phone-push/screen-chat.mjs", { cache: "no-store" }),
    fetch("/ai-phone-push/schema.sql", { cache: "no-store" }),
  ]);
  if (!gatewayRes.ok || !generateRes.ok || !resultRes.ok || !bridgeRes.ok || !screenRes.ok || !schemaRes.ok) {
    throw new Error("获取离线推送部署包失败，请刷新页面后重试。");
  }
  const [gatewayCode, generateCode, resultCode, bridgeCode, screenChatCode, schemaSql] = await Promise.all([
    gatewayRes.text(), generateRes.text(), resultRes.text(), bridgeRes.text(), screenRes.text(), schemaRes.text(),
  ]);

  let response: Response;
  try {
    response = await fetch("/api/push/deploy-personal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRef, token, gatewayCode, generateCode, resultCode, bridgeCode, screenChatCode, schemaSql }),
    });
  } catch {
    throw new Error("无法访问站点部署接口，请检查网络后重试。");
  }

  const result = await response.json().catch(() => ({})) as {
    ok?: boolean;
    error?: string;
    step?: string;
  };
  if (!response.ok || !result.ok) {
    const prefix = result.step ? `${result.step}：` : "";
    throw new Error(`${prefix}${result.error || `部署失败（HTTP ${response.status}）`}`);
  }

  // 管理接口已确认两个函数和 SQL 部署完成：先锁定个人云，再等待边缘节点传播。
  // 健康检查失败只会进入 pending，绝不删除状态或回退本站共享接口。
  let state: PersonalPushCloudState = {
    enabled: true,
    projectRef,
    url,
    deployedAt: new Date().toISOString(),
    healthStatus: "pending",
    schemaVersion: PERSONAL_PUSH_SCHEMA_VERSION,
  };
  savePersonalPushState(state);
  const health = await waitForPersonalPushHealth(url, backup.key.trim());
  state = {
    ...state,
    healthStatus: health.ready ? "ready" : "pending",
    schemaVersion: PERSONAL_PUSH_SCHEMA_VERSION,
    healthError: health.ready ? undefined : health.error,
  };
  savePersonalPushState(state);
  return state;
}
