// ai-phone-personal-push-gateway
// 用户个人 Supabase 上的离线推送网关：订阅、预约、回传箱与测试推送。
// verify_jwt 必须关闭；请求改用用户自己的 service_role key 做逐次校验。

type SubscriptionRow = { endpoint: string; p256dh: string; auth: string };
type ShortcutCommandRow = {
  id: string;
  user_id: string;
  action_id: string;
  action_name: string;
  shortcut_name: string;
  delivery_mode: string;
  callback_token: string;
  action_args: Record<string, unknown> | null;
  result_mode: string;
  status: string;
  result: unknown;
  error: string | null;
  expires_at: string;
  notified_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};
type PushConfigRow = {
  vapid_public_key: string;
  vapid_private_key: string;
  cron_secret: string | null;
  payload_key: string | null;
  site_origin: string | null;
};
type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

const OWNER_ID = "owner";
const MAX_PAYLOAD_BYTES = 900_000;
const ALLOWED_JOB_KINDS = new Set(["followup", "reply_bailout", "timed_task", "shortcut_resume"]);
const SHORTCUT_RESULT_MODES = new Set(["none", "text", "image"]);
const SHORTCUT_MAX_ARGS_BYTES = 16_000;
const SHORTCUT_COMMAND_ID_PATTERN = /^cmd_[a-z0-9-]{20,80}$/i;
const SHORTCUT_TICKET_PATTERN = /^[a-f0-9]{32}$/i;
const SHORTCUT_COMMAND_SELECT = [
  "id", "user_id", "action_id", "action_name", "shortcut_name", "delivery_mode", "callback_token",
  "action_args", "result_mode", "status", "result", "error", "expires_at", "notified_at",
  "claimed_at", "completed_at", "created_at", "updated_at",
].join(",");
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-ai-phone-service-key, x-ai-phone-origin",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
const VERIFIED_KEY_TTL_MS = 5 * 60 * 1000;
const verifiedKeyFingerprints = new Map<string, number>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function randomHex(size: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToB64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

async function keyFingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value)));
  return bytesToB64url(digest);
}

/**
 * 云备份中保存的 service_role key 可能与函数运行时注入的旧 key 不同。
 * 不以字符串相等作授权，而是向同一项目的 Admin API 验证它是否真有管理员权限。
 */
async function hasProjectAdminAccess(supabaseUrl: string, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const fingerprint = await keyFingerprint(candidate);
  const cachedUntil = verifiedKeyFingerprints.get(fingerprint) || 0;
  if (cachedUntil > Date.now()) return true;

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: { apikey: candidate, Authorization: `Bearer ${candidate}` },
  }).catch(() => null);
  const allowed = response?.ok === true;
  await response?.body?.cancel().catch(() => undefined);
  if (allowed) verifiedKeyFingerprints.set(fingerprint, Date.now() + VERIFIED_KEY_TTL_MS);
  return allowed;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as unknown as BufferSource, info: info as unknown as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptWebPushPayload(p256dhB64: string, authB64: string, payload: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as unknown as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const ikm = await hkdf(authSecret, ecdh, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as unknown as BufferSource },
    aesKey,
    concatBytes(utf8(payload), new Uint8Array([2])) as unknown as BufferSource,
  ));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

async function buildVapidAuth(endpoint: string, subject: string, publicKeyB64: string, privateKeyB64: string): Promise<string> {
  const publicBytes = b64urlToBytes(publicKeyB64);
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC",
    crv: "P-256",
    d: privateKeyB64,
    x: bytesToB64url(publicBytes.slice(1, 33)),
    y: bytesToB64url(publicBytes.slice(33, 65)),
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(utf8(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput) as unknown as BufferSource,
  ));
  return `vapid t=${signingInput}.${bytesToB64url(signature)}, k=${publicKeyB64}`;
}

async function sendWebPushRaw(
  subscription: SubscriptionRow,
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttlSeconds = 3600,
): Promise<number> {
  const body = await encryptWebPushPayload(subscription.p256dh, subscription.auth, payload);
  const authorization = await buildVapidAuth(
    subscription.endpoint,
    vapid.subject,
    vapid.publicKey,
    vapid.privateKey,
  );
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(Math.max(60, Math.floor(ttlSeconds))),
      Urgency: "high",
    },
    body: body as unknown as BodyInit,
  });
  await response.text().catch(() => "");
  return response.status;
}

async function encryptPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", utf8(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    utf8(plain) as unknown as BufferSource,
  ));
  return {
    v: 1,
    iv: bytesToB64(iv),
    tag: bytesToB64(combined.slice(combined.length - 16)),
    ct: bytesToB64(combined.slice(0, combined.length - 16)),
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Supabase 环境缺失。" }, 503);

  const restHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  const rest = (path: string, init: RequestInit = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init.headers || {}) },
  });
  const readJson = async <T,>(response: Response): Promise<T> => {
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const message = value && typeof value === "object" && "message" in value
        ? String((value as { message?: unknown }).message || "")
        : `数据库返回 HTTP ${response.status}`;
      throw new Error(message);
    }
    return value as T;
  };

  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "";
  const requestedOrigin = cleanText(request.headers.get("x-ai-phone-origin"), 500);
  let siteOrigin = "";
  try {
    const parsedOrigin = new URL(requestedOrigin);
    if (parsedOrigin.protocol === "https:") siteOrigin = parsedOrigin.origin;
  } catch { /* 未携带合法站点来源时沿用已保存配置 */ }

  const toPublicShortcutCommand = (row: ShortcutCommandRow) => ({
    id: row.id,
    actionId: row.action_id,
    actionName: row.action_name,
    shortcutName: row.shortcut_name,
    deliveryMode: row.delivery_mode,
    arguments: row.action_args && typeof row.action_args === "object" ? row.action_args : {},
    resultMode: row.result_mode,
    status: row.status,
    result: row.result ?? null,
    error: row.error || undefined,
    expiresAt: row.expires_at,
    notifiedAt: row.notified_at || undefined,
    claimedAt: row.claimed_at || undefined,
    completedAt: row.completed_at || undefined,
    createdAt: row.created_at,
  });

  const expireShortcutCommands = async (commandId?: string) => {
    const now = new Date().toISOString();
    const idFilter = commandId ? `&id=eq.${encodeURIComponent(commandId)}` : "";
    await rest(
      `push_shortcut_commands?user_id=eq.${OWNER_ID}${idFilter}&status=in.(pending,claimed)`
      + `&expires_at=lt.${encodeURIComponent(now)}`,
      { method: "PATCH", body: JSON.stringify({ status: "expired", updated_at: now }) },
    ).catch(() => undefined);
  };

  const shortcutResultUrl = (commandId: string, ticket: string) => {
    const target = new URL(`${supabaseUrl}/functions/v1/push-shortcut-result`);
    target.searchParams.set("command", commandId);
    target.searchParams.set("ticket", ticket);
    return target;
  };

  const loadConfig = async (): Promise<PushConfigRow> => {
    const current = await readJson<PushConfigRow[]>(await rest(
      "push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key,cron_secret,payload_key,site_origin&limit=1",
    ));
    if (current[0]) {
      const patch: Record<string, string> = {};
      if (!current[0].cron_secret) patch.cron_secret = randomHex(24);
      if (!current[0].payload_key) patch.payload_key = randomHex(32);
      if (siteOrigin && current[0].site_origin !== siteOrigin) patch.site_origin = siteOrigin;
      if (Object.keys(patch).length > 0) {
        await readJson(await rest("push_server_config?id=eq.main", {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(patch),
        }));
        return { ...current[0], ...patch };
      }
      return current[0];
    }

    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const publicKey = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    if (!privateJwk.d) throw new Error("VAPID 私钥生成失败。");
    await readJson(await rest("push_server_config", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{
        id: "main",
        vapid_public_key: publicKey,
        vapid_private_key: privateJwk.d,
        cron_secret: randomHex(24),
        payload_key: randomHex(32),
        site_origin: siteOrigin || null,
      }]),
    }));
    const created = await readJson<PushConfigRow[]>(await rest(
      "push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key,cron_secret,payload_key,site_origin&limit=1",
    ));
    if (!created[0]) throw new Error("推送配置初始化失败。");
    return created[0];
  };

  // 票据鉴权的快捷指令启动入口：通知/前台按钮打开本地址，认领命令后 302 到
  // shortcuts://。与站点 /shortcut-run 同一套逻辑，回传地址指向本项目自己的
  // push-shortcut-result——整条链路不经过站点。放在 service key 门卫之前，
  // 因为它由系统浏览器直接导航打开，带不了自定义请求头。
  if (action === "run" && request.method === "GET") {
    const plain = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
    try {
      const commandId = cleanText(url.searchParams.get("command"), 100);
      const ticket = cleanText(url.searchParams.get("ticket"), 64);
      if (!SHORTCUT_COMMAND_ID_PATTERN.test(commandId) || !SHORTCUT_TICKET_PATTERN.test(ticket)) {
        return plain(400);
      }
      const rows = await readJson<ShortcutCommandRow[]>(await rest(
        `push_shortcut_commands?id=eq.${encodeURIComponent(commandId)}`
        + `&callback_token=eq.${encodeURIComponent(ticket)}&select=${SHORTCUT_COMMAND_SELECT}&limit=1`,
      ));
      const command = rows[0];
      if (!command) return plain(404);

      const now = new Date();
      if (Date.parse(command.expires_at) <= now.getTime()) {
        await expireShortcutCommands(command.id);
        return plain(410);
      }
      if (command.status !== "pending" && command.status !== "claimed") return plain(409);

      if (command.status === "pending") {
        const update = command.result_mode === "none"
          ? {
              status: "succeeded",
              result: { text: "快捷指令已启动。" },
              claimed_at: now.toISOString(),
              completed_at: now.toISOString(),
              updated_at: now.toISOString(),
            }
          : { status: "claimed", claimed_at: now.toISOString(), updated_at: now.toISOString() };
        const claimed = await readJson<ShortcutCommandRow[]>(await rest(
          `push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}`
          + `&callback_token=eq.${encodeURIComponent(ticket)}&status=eq.pending&select=${SHORTCUT_COMMAND_SELECT}`,
          { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) },
        ));
        if (!claimed[0]) return plain(409);
        Object.assign(command, claimed[0]);
      }

      const input: Record<string, unknown> = {
        ...(command.action_args && typeof command.action_args === "object" ? command.action_args : {}),
        commandId: command.id,
        resultUrl: shortcutResultUrl(command.id, command.callback_token).toString(),
      };
      const isTextResult = command.result_mode === "text";
      const target = new URL(isTextResult
        ? "shortcuts://x-callback-url/run-shortcut"
        : "shortcuts://run-shortcut");
      target.searchParams.set("name", command.shortcut_name);
      target.searchParams.set("input", "text");
      target.searchParams.set("text", JSON.stringify(input));
      if (isTextResult) {
        const success = shortcutResultUrl(command.id, command.callback_token);
        success.searchParams.set("status", "succeeded");
        const failed = new URL(success);
        failed.searchParams.set("status", "failed");
        const cancelled = new URL(failed);
        cancelled.searchParams.set("errorMessage", "快捷指令已取消。");
        target.searchParams.set("x-success", success.toString());
        target.searchParams.set("x-error", failed.toString());
        target.searchParams.set("x-cancel", cancelled.toString());
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: target.toString(),
          "Cache-Control": "no-store, max-age=0",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    } catch {
      return plain(500);
    }
  }

  // iPhone 快捷指令免登录唤醒：上传事件到收件箱后调用一次，凭 bridge_token 认主。
  // 45 秒后由 cron 派 push-bridge 扫描——App 活着时本地轮询会先拉走事件，扫描
  // 自然落空；App 被杀才由服务端接管。放在 service key 门卫之前（快捷指令带
  // 不了自定义请求头）。
  if (action === "bridge-wake" && (request.method === "GET" || request.method === "POST")) {
    try {
      const bodyToken = request.method === "POST"
        ? cleanText(((await request.json().catch(() => ({}))) as { token?: unknown }).token, 100)
        : "";
      const token = bodyToken || cleanText(url.searchParams.get("token"), 100);
      if (!token) return json({ ok: false, error: "缺少 token。" }, 400);
      const rows = await readJson<{ user_id: string }[]>(await rest(
        `push_bridge_config?bridge_token=eq.${encodeURIComponent(token)}&select=user_id&limit=1`,
      ));
      const userId = rows[0]?.user_id;
      if (!userId) return json({ ok: false, error: "令牌无效。" }, 403);
      const config = await loadConfig();
      if (!config.payload_key) throw new Error("推送配置未初始化。");
      // 同名扫描任务幂等覆盖：连续唤醒只保留一次扫描（扫描会拉走全部）。
      // 预删除不限状态——唯一索引覆盖全状态，残留 done/failed 行会撞约束。
      const triggerKey = `bridge:scan:${userId}`;
      await readJson(await rest(
        `push_jobs?user_id=eq.${encodeURIComponent(userId)}&trigger_key=eq.${encodeURIComponent(triggerKey)}`,
        { method: "DELETE", headers: { Prefer: "return=representation" } },
      )).catch(() => undefined);
      const insert = await rest("push_jobs", {
        method: "POST",
        body: JSON.stringify([{
          id: `job_${crypto.randomUUID()}`,
          user_id: userId,
          trigger_key: triggerKey,
          kind: "bridge_scan",
          execute_at: new Date(Date.now() + 45_000).toISOString(),
          status: "pending",
          payload: await encryptPayload(JSON.stringify({ kind: "bridge_scan" }), config.payload_key),
        }]),
      });
      const insertDetail = await insert.text().catch(() => "");
      if (!insert.ok) {
        // 并发唤醒：另一次调用刚插完，扫描已排上，对本次也算成功
        if (/duplicate key/i.test(insertDetail)) return json({ ok: true, note: "scan already scheduled" });
        return json({ ok: false, error: "扫描任务创建失败。" }, 500);
      }
      return json({ ok: true });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  const suppliedKey = request.headers.get("x-ai-phone-service-key") || "";
  if (suppliedKey !== serviceKey && !await hasProjectAdminAccess(supabaseUrl, suppliedKey)) {
    return json({ ok: false, error: "个人云 service_role 密钥无效，或不属于当前 Supabase 项目。" }, 401);
  }

  // 向本项目 owner 的全部订阅推送「运行快捷指令」通知，点开即 run 入口。
  const deliverShortcutCommandRow = async (command: ShortcutCommandRow) => {
    if (command.notified_at) return { delivered: true, push: undefined as { sent: number; total: number; error?: string } | undefined };
    const config = await loadConfig();
    const subscriptions = await readJson<SubscriptionRow[]>(await rest(
      `push_subscriptions?user_id=eq.${OWNER_ID}&select=endpoint,p256dh,auth`,
    ));
    if (subscriptions.length === 0) {
      return { delivered: false, push: { sent: 0, total: 0, error: "个人云还没有任何离线推送订阅。" } };
    }
    const requestedOrigin = cleanText(request.headers.get("x-ai-phone-origin"), 300);
    const siteOrigin = requestedOrigin.startsWith("https://") ? requestedOrigin.replace(/\/$/, "") : "";
    const subject = siteOrigin || "mailto:push@ai-phone.local";
    const ttl = Math.max(60, Math.min(900, Math.ceil((Date.parse(command.expires_at) - Date.now()) / 1000)));
    const runUrl = `${supabaseUrl}/functions/v1/ai-phone-push?action=run&command=${command.id}&ticket=${command.callback_token}`;
    // iOS 上系统通知点击唯一可靠的启动方式是声明式 Web Push 的原生 navigate
    // （SW notificationclick 在 iOS 不可依赖）；navigate 必须同源起跳，因此指向
    // 站点的无状态转发路由，由它 302 回本网关的 run 入口。旧浏览器在 SW 里
    // 收到同一份 JSON 并解包展示。
    const navigate = siteOrigin ? `${siteOrigin}/personal-shortcut-run?to=${encodeURIComponent(runUrl)}` : runUrl;
    const payload = JSON.stringify({
      web_push: 8030,
      notification: {
        title: `运行「${command.action_name}」`,
        body: "角色请求执行一条已授权的快捷动作，轻点开始。",
        navigate,
        tag: command.id,
        icon: siteOrigin ? `${siteOrigin}/icon-192.png` : undefined,
        badge: siteOrigin ? `${siteOrigin}/icon-192.png` : undefined,
        silent: false,
        mutable: false,
        data: { url: navigate, type: "shortcut_command", commandId: command.id },
      },
    });
    let sent = 0;
    const errors: string[] = [];
    for (const subscription of subscriptions) {
      try {
        const status = await sendWebPushRaw(subscription, payload, {
          publicKey: config.vapid_public_key,
          privateKey: config.vapid_private_key,
          subject,
        }, ttl);
        if (status === 404 || status === 410) {
          await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE" });
        } else if (status >= 400) {
          errors.push(`HTTP ${status}`);
        } else {
          sent += 1;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (sent > 0) {
      const now = new Date().toISOString();
      await rest(
        `push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}&user_id=eq.${OWNER_ID}`,
        { method: "PATCH", body: JSON.stringify({ notified_at: now, updated_at: now }) },
      ).catch(() => undefined);
    }
    return { delivered: sent > 0, push: { sent, total: subscriptions.length, error: errors[0] || undefined } };
  };

  try {
    if (action === "health") {
      const response = await rest("push_server_config?select=id&limit=1");
      if (!response.ok) throw new Error("离线推送数据库尚未初始化。");
      const meta = await readJson<Array<{ schema_version?: number }>>(await rest(
        "ai_phone_cloud_meta?id=eq.personal-cloud&select=schema_version&limit=1",
      ));
      const schemaVersion = Number(meta[0]?.schema_version) || 1;
      return json({
        ok: true,
        service: "ai-phone-personal-push",
        version: 2,
        schemaVersion,
        capabilities: schemaVersion >= 3 ? ["screen-chat-continuous"] : [],
      });
    }

    if (action === "public-key" && request.method === "GET") {
      const config = await loadConfig();
      return json({ ok: true, publicKey: config.vapid_public_key });
    }

    if (action === "status" && request.method === "GET") {
      const rows = await readJson<Array<{ endpoint: string }>>(await rest(
        `push_subscriptions?user_id=eq.${OWNER_ID}&select=endpoint&limit=1`,
      ));
      return json({ ok: true, subscribed: rows.length > 0 });
    }

    if (action === "subscribe") {
      const body = await request.json().catch(() => ({})) as {
        endpoint?: unknown;
        keys?: { p256dh?: unknown; auth?: unknown };
      };
      const endpoint = cleanText(body.endpoint, 1000);
      if (request.method === "POST") {
        const p256dh = cleanText(body.keys?.p256dh, 300);
        const auth = cleanText(body.keys?.auth, 300);
        if (!endpoint || !p256dh || !auth) return json({ ok: false, error: "订阅数据不完整。" }, 400);
        await readJson(await rest("push_subscriptions?on_conflict=endpoint", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify([{
            endpoint,
            user_id: OWNER_ID,
            p256dh,
            auth,
            user_agent: cleanText(request.headers.get("user-agent"), 300) || null,
            fail_count: 0,
          }]),
        }));
        return json({ ok: true });
      }
      if (request.method === "DELETE") {
        if (!endpoint) return json({ ok: false, error: "缺少订阅端点。" }, 400);
        await readJson(await rest(
          `push_subscriptions?user_id=eq.${OWNER_ID}&endpoint=eq.${encodeURIComponent(endpoint)}`,
          { method: "DELETE", headers: { Prefer: "return=representation" } },
        ));
        return json({ ok: true });
      }
    }

    if (action === "jobs") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const triggerKey = cleanText(body.triggerKey, 200);
      if (request.method === "POST") {
        const kind = cleanText(body.kind, 40);
        const executeAt = new Date(cleanText(body.executeAt, 60));
        if (!triggerKey || !ALLOWED_JOB_KINDS.has(kind) || Number.isNaN(executeAt.getTime())) {
          return json({ ok: false, error: "预约参数不完整。" }, 400);
        }
        if (!body.payload || typeof body.payload !== "object") return json({ ok: false, error: "缺少 payload。" }, 400);
        const plainJson = JSON.stringify(body.payload);
        if (plainJson.length > MAX_PAYLOAD_BYTES) return json({ ok: false, error: "快照过大。" }, 413);
        const config = await loadConfig();
        if (!config.payload_key) throw new Error("预约加密密钥初始化失败。");
        await readJson(await rest(
          `push_jobs?user_id=eq.${OWNER_ID}&trigger_key=eq.${encodeURIComponent(triggerKey)}`,
          { method: "DELETE", headers: { Prefer: "return=representation" } },
        ));
        await readJson(await rest("push_jobs", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify([{
            id: `job_${crypto.randomUUID()}`,
            user_id: OWNER_ID,
            trigger_key: triggerKey,
            kind,
            execute_at: executeAt.toISOString(),
            status: "pending",
            payload: await encryptPayload(plainJson, config.payload_key),
          }]),
        }));
        return json({ ok: true });
      }
      if (request.method === "PATCH") {
        if (!triggerKey) return json({ ok: false, error: "缺少 triggerKey。" }, 400);
        const executeAt = new Date(Date.now() + (body.runNow === true ? 0 : 90_000)).toISOString();
        await readJson(await rest(
          `push_jobs?user_id=eq.${OWNER_ID}&trigger_key=eq.${encodeURIComponent(triggerKey)}&status=eq.pending`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ execute_at: executeAt, updated_at: new Date().toISOString() }),
          },
        ));
        return json({ ok: true });
      }
      if (request.method === "DELETE") {
        const triggerPrefix = cleanText(body.triggerPrefix, 200);
        const excludeKey = cleanText(body.excludeKey, 200);
        if (!triggerKey && !triggerPrefix) return json({ ok: false, error: "缺少预约键。" }, 400);
        const keyFilter = triggerKey
          ? `trigger_key=eq.${encodeURIComponent(triggerKey)}`
          : `trigger_key=like.${encodeURIComponent(`${triggerPrefix}%`)}`
            + (excludeKey ? `&trigger_key=neq.${encodeURIComponent(excludeKey)}` : "");
        await readJson(await rest(
          `push_jobs?user_id=eq.${OWNER_ID}&status=eq.pending&${keyFilter}`,
          { method: "DELETE", headers: { Prefer: "return=representation" } },
        ));
        return json({ ok: true });
      }
    }

    if (action === "outbox") {
      if (request.method === "GET") {
        const entries = await readJson(await rest(
          `push_outbox?user_id=eq.${OWNER_ID}&consumed_at=is.null`
          + "&select=id,session_id,trigger_key,raw_text,meta,created_at&order=created_at.asc&limit=20",
        ));
        return json({ ok: true, entries });
      }
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({})) as { ids?: unknown };
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 100).slice(0, 50)
          : [];
        if (ids.length === 0) return json({ ok: false, error: "缺少 ids。" }, 400);
        const list = ids.map(id => `"${id.replace(/"/g, "")}"`).join(",");
        await readJson(await rest(
          `push_outbox?user_id=eq.${OWNER_ID}&id=in.(${encodeURIComponent(list)})`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({ consumed_at: new Date().toISOString() }),
          },
        ));
        return json({ ok: true });
      }
    }

    if (action === "schedule" && request.method === "POST") {
      // 在线开关每分钟到期任务扫描（与微信云函数的在线开关同一套做法）。
      const body = await request.json().catch(() => ({})) as { enable?: unknown };
      const enable = body.enable === true;
      const dbUrl = Deno.env.get("SUPABASE_DB_URL") || "";
      if (!dbUrl) {
        return json({ ok: false, error: "当前环境读不到数据库连接串，无法在线开关定时任务。" }, 500);
      }
      const { default: postgres } = await import("npm:postgres@3.4.7");
      const sql = postgres(dbUrl, { prepare: false });
      try {
        if (enable) {
          const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
          await sql.unsafe("create extension if not exists pg_cron");
          await sql.unsafe("create extension if not exists pg_net");
          await sql.unsafe(`select cron.schedule('ai-phone-personal-push-jobs-scan', '* * * * *', $CRON$
  update public.push_jobs
     set status = 'pending', updated_at = now()
   where status = 'running' and updated_at < now() - interval '20 minutes';

  select net.http_post(
    url     := '${supabaseUrl}/functions/v1/push-generate',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'jobId', j.id,
      'token', (select cron_secret from public.push_server_config where id = 'main')
    ),
    timeout_milliseconds := 5000
  )
  from (
    select id
      from public.push_jobs
     where status = 'pending' and execute_at <= now() and kind <> 'bridge_scan'
     order by execute_at asc
     limit 10
  ) j;

  select net.http_post(
    url     := '${supabaseUrl}/functions/v1/push-bridge',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'jobId', j.id,
      'token', (select cron_secret from public.push_server_config where id = 'main')
    ),
    timeout_milliseconds := 5000
  )
  from (
    select id
      from public.push_jobs
     where status = 'pending' and execute_at <= now() and kind = 'bridge_scan'
     order by execute_at asc
     limit 5
  ) j;
$CRON$)`);
          await sql.unsafe(`select cron.schedule('ai-phone-personal-push-cron-cleanup', '0 3 * * *', $CRON$
  delete from cron.job_run_details where end_time < now() - interval '3 days';
$CRON$)`);
          return json({ ok: true, scheduled: true });
        }
        await sql.unsafe("select cron.unschedule('ai-phone-personal-push-jobs-scan')").catch(() => {});
        await sql.unsafe("select cron.unschedule('ai-phone-personal-push-cron-cleanup')").catch(() => {});
        return json({ ok: true, scheduled: false });
      } finally {
        await sql.end({ timeout: 1 }).catch(() => {});
      }
    }

    if (action === "bridge-config" && request.method === "GET") {
      const rows = await readJson<{ bridge_token: string }[]>(await rest(
        `push_bridge_config?user_id=eq.${OWNER_ID}&select=bridge_token&limit=1`,
      ));
      if (rows[0]) return json({ ok: true, bridgeToken: rows[0].bridge_token, hasConfig: true });
      const token = randomHex(18);
      await readJson(await rest("push_bridge_config", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify([{ user_id: OWNER_ID, bridge_token: token }]),
      }));
      return json({ ok: true, bridgeToken: token, hasConfig: false });
    }

    if (action === "bridge-sync" && request.method === "POST") {
      // 现实桥离线联动配置同步：规则/云配置/触发状态 + 各规则 prompt 快照。
      // 云配置与快照用 payload_key 加密落库（与站点版同一格式，push-bridge 直接解）。
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const rules = Array.isArray(body.rules) ? body.rules : [];
      if (JSON.stringify(rules).length > 200_000) return json({ ok: false, error: "规则快照过大。" }, 413);
      const config = await loadConfig();
      if (!config.payload_key) throw new Error("推送配置未初始化。");
      const cloudConfig = body.cloudConfig && typeof body.cloudConfig === "object"
        ? await encryptPayload(JSON.stringify(body.cloudConfig), config.payload_key)
        : null;
      const ruleRuns = body.ruleRuns && typeof body.ruleRuns === "object" ? body.ruleRuns : {};
      // 离线快捷动作目录：只保留云端执行需要的字段
      const shortcutActions = (Array.isArray(body.shortcutActions) ? body.shortcutActions : [])
        .slice(0, 20)
        .map(entry => entry && typeof entry === "object" ? entry as Record<string, unknown> : {})
        .filter(entry => cleanText(entry.name, 60) && cleanText(entry.shortcutName, 80))
        .map(entry => ({
          actionId: cleanText(entry.actionId, 100),
          name: cleanText(entry.name, 60),
          shortcutName: cleanText(entry.shortcutName, 80),
          resultMode: SHORTCUT_RESULT_MODES.has(cleanText(entry.resultMode, 20)) ? cleanText(entry.resultMode, 20) : "none",
          expiresInSeconds: Math.max(30, Math.min(900, Number(entry.expiresInSeconds) || 120)),
        }));
      const patched = await readJson<unknown[]>(await rest(`push_bridge_config?user_id=eq.${OWNER_ID}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          rules,
          ...(cloudConfig ? { cloud_config: cloudConfig } : {}),
          rule_runs: ruleRuns,
          shortcut_actions: shortcutActions,
          updated_at: new Date().toISOString(),
        }),
      }));
      if (patched.length === 0) {
        await readJson(await rest("push_bridge_config", {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify([{
            user_id: OWNER_ID,
            bridge_token: randomHex(18),
            rules,
            ...(cloudConfig ? { cloud_config: cloudConfig } : {}),
            rule_runs: ruleRuns,
            shortcut_actions: shortcutActions,
          }]),
        }));
      }

      const deleteIds = Array.isArray(body.deleteRuleIds)
        ? body.deleteRuleIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 100).slice(0, 100)
        : [];
      for (const ruleId of deleteIds) {
        await readJson(await rest(
          `push_bridge_snapshots?user_id=eq.${OWNER_ID}&rule_id=eq.${encodeURIComponent(ruleId)}`,
          { method: "DELETE", headers: { Prefer: "return=representation" } },
        )).catch(() => undefined);
      }
      const snapshots = Array.isArray(body.snapshots) ? body.snapshots.slice(0, 30) : [];
      let saved = 0;
      for (const snapshot of snapshots as Array<{ ruleId?: unknown; payload?: unknown }>) {
        const ruleId = cleanText(snapshot?.ruleId, 100);
        if (!ruleId || !snapshot?.payload || typeof snapshot.payload !== "object") continue;
        const plainJson = JSON.stringify(snapshot.payload);
        if (plainJson.length > MAX_PAYLOAD_BYTES) continue;
        await readJson(await rest(
          `push_bridge_snapshots?user_id=eq.${OWNER_ID}&rule_id=eq.${encodeURIComponent(ruleId)}`,
          { method: "DELETE", headers: { Prefer: "return=representation" } },
        )).catch(() => undefined);
        await readJson(await rest("push_bridge_snapshots", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify([{
            user_id: OWNER_ID,
            rule_id: ruleId,
            payload: await encryptPayload(plainJson, config.payload_key),
            updated_at: new Date().toISOString(),
          }]),
        }));
        saved += 1;
      }
      return json({ ok: true, saved, deleted: deleteIds.length });
    }

    if (action === "shortcut-create" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const actionId = cleanText(body.actionId, 100);
      const actionName = cleanText(body.actionName, 60);
      const shortcutName = cleanText(body.shortcutName, 80);
      const resultMode = cleanText(body.resultMode, 20);
      const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
        ? body.arguments as Record<string, unknown>
        : {};
      // 调用方可先创建命令、完成首条消息送达后再单独 shortcut-deliver。
      // 无回传动作也需要这个顺序保证，因此不再限定 resultMode。
      const deferDelivery = body.deferDelivery === true;
      const expiresInSeconds = Math.max(30, Math.min(900, Number(body.expiresInSeconds) || 120));
      if (!actionId || !actionName || !shortcutName || !SHORTCUT_RESULT_MODES.has(resultMode)) {
        return json({ ok: false, error: "快捷动作参数不完整。" }, 400);
      }
      if (JSON.stringify(args).length > SHORTCUT_MAX_ARGS_BYTES) {
        return json({ ok: false, error: "快捷动作参数过大。" }, 413);
      }

      await expireShortcutCommands();
      const pending = await readJson<{ id: string }[]>(await rest(
        `push_shortcut_commands?user_id=eq.${OWNER_ID}&status=in.(pending,claimed)&select=id&limit=10`,
      ));
      if (pending.length >= 10) {
        return json({ ok: false, error: "待执行快捷命令过多，请先处理或等待过期。" }, 429);
      }
      const minuteStart = new Date(Date.now() - 60_000).toISOString();
      const recent = await readJson<{ id: string }[]>(await rest(
        `push_shortcut_commands?user_id=eq.${OWNER_ID}&created_at=gte.${encodeURIComponent(minuteStart)}&select=id&limit=6`,
      ));
      if (recent.length >= 6) {
        return json({ ok: false, error: "快捷动作触发过于频繁，请稍后再试。" }, 429);
      }

      const id = `cmd_${crypto.randomUUID()}`;
      const callbackToken = randomHex(16);
      const now = new Date();
      const inserted = await readJson<ShortcutCommandRow[]>(await rest("push_shortcut_commands", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([{
          id,
          user_id: OWNER_ID,
          action_id: actionId,
          action_name: actionName,
          shortcut_name: shortcutName,
          delivery_mode: "push",
          callback_token: callbackToken,
          action_args: args,
          result_mode: resultMode,
          status: "pending",
          expires_at: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
        }]),
      }));
      if (!inserted[0]) return json({ ok: false, error: "命令创建失败。" }, 500);

      const delivery = deferDelivery
        ? { delivered: false, push: undefined }
        : await deliverShortcutCommandRow(inserted[0]);
      return json({
        ok: true,
        command: toPublicShortcutCommand(inserted[0]),
        runUrl: `${supabaseUrl}/functions/v1/ai-phone-push?action=run&command=${inserted[0].id}&ticket=${inserted[0].callback_token}`,
        delivered: delivery.delivered,
        deferred: deferDelivery,
        push: delivery.push,
      });
    }

    if (action === "shortcut-deliver" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const commandId = cleanText(body.commandId, 100);
      if (!SHORTCUT_COMMAND_ID_PATTERN.test(commandId)) return json({ ok: false, error: "缺少命令 ID。" }, 400);
      const rows = await readJson<ShortcutCommandRow[]>(await rest(
        `push_shortcut_commands?id=eq.${encodeURIComponent(commandId)}&user_id=eq.${OWNER_ID}`
        + `&select=${SHORTCUT_COMMAND_SELECT}&limit=1`,
      ));
      const command = rows[0];
      if (!command) return json({ ok: false, error: "命令不存在。" }, 404);
      if (command.notified_at) return json({ ok: true, delivered: true });
      if (Date.parse(command.expires_at) <= Date.now()) {
        await expireShortcutCommands(command.id);
        return json({ ok: false, error: "命令已过期。" }, 410);
      }
      if (command.status !== "pending") return json({ ok: false, error: `命令状态：${command.status}` }, 409);
      const delivery = await deliverShortcutCommandRow(command);
      return json({ ok: true, delivered: delivery.delivered, push: delivery.push });
    }

    if (action === "shortcut-commands" && request.method === "GET") {
      const id = cleanText(url.searchParams.get("id"), 100);
      await expireShortcutCommands(id || undefined);
      if (id) {
        const rows = await readJson<ShortcutCommandRow[]>(await rest(
          `push_shortcut_commands?id=eq.${encodeURIComponent(id)}&user_id=eq.${OWNER_ID}`
          + `&select=${SHORTCUT_COMMAND_SELECT}&limit=1`,
        ));
        return rows[0]
          ? json({ ok: true, command: toPublicShortcutCommand(rows[0]) })
          : json({ ok: false, error: "命令不存在。" }, 404);
      }
      const limit = Math.max(1, Math.min(30, Number(url.searchParams.get("limit")) || 12));
      const rows = await readJson<ShortcutCommandRow[]>(await rest(
        `push_shortcut_commands?user_id=eq.${OWNER_ID}&select=${SHORTCUT_COMMAND_SELECT}`
        + `&order=created_at.desc&limit=${limit}`,
      ));
      return json({ ok: true, commands: rows.map(toPublicShortcutCommand) });
    }

    if (action === "test" && request.method === "POST") {
      const config = await loadConfig();
      const subscriptions = await readJson<SubscriptionRow[]>(await rest(
        `push_subscriptions?user_id=eq.${OWNER_ID}&select=endpoint,p256dh,auth`,
      ));
      if (subscriptions.length === 0) return json({ ok: false, error: "请先开启离线推送。" }, 400);
      await new Promise(resolve => setTimeout(resolve, 6000));
      const requestedOrigin = cleanText(request.headers.get("x-ai-phone-origin"), 300);
      const subject = requestedOrigin.startsWith("https://") ? requestedOrigin : "mailto:push@ai-phone.local";
      const payload = JSON.stringify({
        type: "chat_outbox_test",
        title: "小手机",
        body: "个人 Supabase 离线推送已连通。",
        tag: `personal-push-test-${Date.now()}`,
        url: "/",
      });
      let sent = 0;
      const errors: string[] = [];
      for (const subscription of subscriptions) {
        try {
          const status = await sendWebPushRaw(subscription, payload, {
            publicKey: config.vapid_public_key,
            privateKey: config.vapid_private_key,
            subject,
          });
          if (status === 404 || status === 410) {
            await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE" });
          } else if (status >= 400) {
            errors.push(`HTTP ${status}`);
          } else {
            sent += 1;
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (sent === 0) return json({ ok: false, error: errors[0] || "测试推送发送失败。" }, 500);
      return json({ ok: true, sent, total: subscriptions.length });
    }

    return json({ ok: false, error: "不支持的离线推送操作。" }, 404);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
