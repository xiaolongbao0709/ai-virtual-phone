import { CLOUD_BACKUP_BUCKET, normalizeBackupUrl, type CloudBackupConfig } from "./config";

/**
 * Thin client for the user's OWN Supabase Storage (REST), using their anon key
 * directly from the browser. Scoped entirely to the ai-phone-backup bucket.
 * No @supabase/supabase-js dependency — plain fetch against /storage/v1.
 */

type Creds = { url: string; key: string };

function resolveCreds(config: CloudBackupConfig): Creds | null {
  const url = normalizeBackupUrl(config.url);
  const key = (config.key || "").trim();
  if (!url || !key) return null;
  return { url, key };
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function objectUrl(creds: Creds, path: string): string {
  return `${creds.url}/storage/v1/object/${CLOUD_BACKUP_BUCKET}/${path.replace(/^\/+/, "")}`;
}

// ── hang / flake protection ──
// 移动端切网、锁屏后 fetch 可能永远不返回也不报错：没有超时的请求会让
// 备份/恢复进度条永久卡死（用户实报）。所有请求都必须有界，可重试的再重试。

const CONTROL_TIMEOUT_MS = 30 * 1000;          // list/delete/bucket 等小请求
const DOWNLOAD_HEADER_TIMEOUT_MS = 30 * 1000;  // 下载：等响应头
const DOWNLOAD_IDLE_TIMEOUT_MS = 60 * 1000;    // 下载：正文超过 60s 没有新字节视为断流
const UPLOAD_TIMEOUT_FLOOR_MS = 2 * 60 * 1000; // 上传：下限 2 分钟
const UPLOAD_TIMEOUT_CAP_MS = 20 * 60 * 1000;  // 上传：上限 20 分钟（40MB 分片按 ~40KB/s 兜底）
const RETRY_DELAYS_MS = [1500, 4000];

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // 网络断流（TypeError: Failed to fetch / NetworkError）、我们自己的超时、5xx。
  if (error instanceof TypeError) return true;
  return /^5\d\d(\s|$)|超时|timed? ?out|networkerror|failed to fetch|load failed/i.test(message);
}

async function withRetries<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${what}超时（${Math.round(timeoutMs / 1000)} 秒无响应），请检查网络后重试。`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Progress callback for downloads: received bytes so far and the total from
 *  Content-Length (null when the server didn't send one). */
export type DownloadProgress = (receivedBytes: number, totalBytes: number | null) => void;

/** Read a response body with an inactivity timeout: a stalled connection aborts
 *  instead of hanging the restore forever. */
async function responseToBlob(res: Response, onBytes?: DownloadProgress): Promise<Blob> {
  const contentType = res.headers.get("Content-Type") ?? "";
  const lengthHeader = res.headers.get("Content-Length");
  const totalBytes = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  if (!res.body) return await res.blob();
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`下载超时（${Math.round(DOWNLOAD_IDLE_TIMEOUT_MS / 1000)} 秒没有收到数据），请检查网络后重试。`)), DOWNLOAD_IDLE_TIMEOUT_MS);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        if (value) {
          chunks.push(value as unknown as BlobPart);
          received += value.byteLength;
          onBytes?.(received, totalBytes);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  return new Blob(chunks, { type: contentType });
}

/** Upload (overwrites if present). Body can be a Blob/ArrayBuffer/string. */
export async function putObject(config: CloudBackupConfig, path: string, body: BlobPart, contentType = "application/octet-stream"): Promise<void> {
  const creds = resolveCreds(config);
  if (!creds) throw new Error("未配置 Supabase 地址或 key。");
  const blob = body instanceof Blob ? body : new Blob([body], { type: contentType });
  // Scale the deadline with the payload (~40KB/s worst case) so slow uplinks
  // still finish while a dead connection can't hang the run forever.
  const timeoutMs = Math.min(UPLOAD_TIMEOUT_CAP_MS, UPLOAD_TIMEOUT_FLOOR_MS + Math.ceil(blob.size / 1024) * 25);
  await withRetries(async () => {
    const res = await fetchWithTimeout(objectUrl(creds, path), {
      method: "POST",
      headers: { ...authHeaders(creds.key), "Content-Type": contentType, "x-upsert": "true" },
      body: blob,
    }, timeoutMs, "上传");
    if (!res.ok) throw new Error(await describeError(res));
  });
}

/** Download an object's bytes. Returns null if the object doesn't exist.
 *  Supabase Storage 对不存在的对象返回 400 "Object not found" 而不是 404，
 *  与 claimObject/removeObject 相同，两种都视为不存在。 */
export async function getObject(config: CloudBackupConfig, path: string, onBytes?: DownloadProgress): Promise<Blob | null> {
  const creds = resolveCreds(config);
  if (!creds) throw new Error("未配置 Supabase 地址或 key。");
  return withRetries(async () => {
    const res = await fetchWithTimeout(
      objectUrl(creds, path),
      { headers: authHeaders(creds.key), cache: "no-store" },
      DOWNLOAD_HEADER_TIMEOUT_MS,
      "下载",
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const error = await describeError(res);
      if (res.status === 400 && /object not found|not found/i.test(error)) return null;
      throw new Error(error);
    }
    return await responseToBlob(res, onBytes);
  });
}

/** 删除并返回是否由本次调用真正删掉（200）。404 = 已被别处取走，视为未认领。
 *  现实桥收件箱用它做「删除即认领」互斥：谁删掉谁处理，防止重复触发与双端抢单。 */
export async function claimObject(config: CloudBackupConfig, path: string): Promise<boolean> {
  const creds = resolveCreds(config);
  if (!creds) throw new Error("未配置 Supabase 地址或 key。");
  // 认领语义下不能自动重试：第一次可能已删成功但响应丢失，重试会误报「未认领」。
  const res = await fetchWithTimeout(objectUrl(creds, path), { method: "DELETE", headers: authHeaders(creds.key) }, CONTROL_TIMEOUT_MS, "删除");
  if (res.ok) return true;
  if (res.status === 404) return false;
  const error = await describeError(res);
  if (res.status === 400 && /object not found|not found/i.test(error)) return false;
  throw new Error(error);
}

export async function removeObject(config: CloudBackupConfig, path: string): Promise<void> {
  const creds = resolveCreds(config);
  if (!creds) throw new Error("未配置 Supabase 地址或 key。");
  await withRetries(async () => {
    const res = await fetchWithTimeout(objectUrl(creds, path), { method: "DELETE", headers: authHeaders(creds.key) }, CONTROL_TIMEOUT_MS, "删除");
    if (res.ok || res.status === 404) return;
    const error = await describeError(res);
    if (res.status === 400 && /object not found|not found/i.test(error)) return;
    throw new Error(error);
  });
}

export type StorageObject = { name: string; size: number; updatedAt?: string };

/** List objects under a prefix (e.g. "manifests/"). */
export async function listObjects(config: CloudBackupConfig, prefix = "", limit = 100): Promise<StorageObject[]> {
  const creds = resolveCreds(config);
  if (!creds) throw new Error("未配置 Supabase 地址或 key。");
  const res = await withRetries(() => fetchWithTimeout(`${creds.url}/storage/v1/object/list/${CLOUD_BACKUP_BUCKET}`, {
    method: "POST",
    headers: { ...authHeaders(creds.key), "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit, offset: 0, sortBy: { column: "name", order: "asc" } }),
    cache: "no-store",
  }, CONTROL_TIMEOUT_MS, "列举"));
  if (!res.ok) throw new Error(await describeError(res));
  const rows = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  return (Array.isArray(rows) ? rows : []).map(row => ({
    name: String(row.name ?? ""),
    size: Number((row.metadata as Record<string, unknown> | undefined)?.size ?? 0),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : undefined,
  })).filter(item => item.name);
}

/**
 * Create the backup bucket if it doesn't exist. Requires a service_role key
 * (bucket creation is an admin operation); succeeds idempotently if present.
 */
export async function ensureBucket(config: CloudBackupConfig): Promise<void> {
  const creds = resolveCreds(config);
  if (!creds) throw new Error("未配置 Supabase 地址或 key。");
  const res = await fetchWithTimeout(`${creds.url}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...authHeaders(creds.key), "Content-Type": "application/json" },
    body: JSON.stringify({ id: CLOUD_BACKUP_BUCKET, name: CLOUD_BACKUP_BUCKET, public: false }),
  }, CONTROL_TIMEOUT_MS, "创建存储桶");
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  // Bucket already there → that's fine, treat as success.
  if (res.status === 409 || /already exists|Duplicate|resource already exists/i.test(text)) return;
  throw new Error(`${res.status} ${text || res.statusText}`.trim());
}

/**
 * Validate the full path the backup engine needs: auto-create the bucket (with
 * the service_role key), then write a tiny probe object and delete it. Proves
 * the project + key work and the bucket is ready — no manual SQL/dashboard setup.
 */
export async function testCloudBackupConnection(config: CloudBackupConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  const creds = resolveCreds(config);
  if (!creds) return { ok: false, error: "请先填写 Supabase 地址和 key。" };
  try {
    await ensureBucket(config);
  } catch (err) {
    return { ok: false, error: mapStorageError(err instanceof Error ? err.message : String(err)) };
  }
  const probePath = `.healthcheck/${Date.now()}.txt`;
  try {
    await putObject(config, probePath, "ok", "text/plain");
  } catch (err) {
    return { ok: false, error: mapStorageError(err instanceof Error ? err.message : String(err)) };
  }
  // Best-effort cleanup; failure here doesn't fail the test.
  try { await removeObject(config, probePath); } catch { /* ignore */ }
  return { ok: true };
}

async function describeError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    message = String(data.message ?? data.error ?? text);
  } catch { /* keep raw text */ }
  return `${res.status} ${message || res.statusText}`.trim();
}

function mapStorageError(error: string): string {
  if (/403|not authorized|permission|new row violates row-level security/i.test(error)) {
    return "权限不足：请填 service_role key（Supabase → Project Settings → API → service_role），不是 anon key。";
  }
  if (/401|invalid.*(jwt|key|token)|JWSError|signature/i.test(error)) {
    return "key 无效或不匹配该项目：请检查 Supabase 地址和 service_role key 是否对应同一个项目。";
  }
  if (/getaddrinfo|ENOTFOUND|fetch failed|Failed to fetch|networkerror/i.test(error)) {
    return "连不上该 Supabase 地址：请检查 URL 是否正确、网络是否可达。";
  }
  return error;
}
