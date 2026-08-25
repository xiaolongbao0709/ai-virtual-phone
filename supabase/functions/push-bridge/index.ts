// 现实桥服务端联动执行器（Supabase Edge Function 版）
// 部署：Dashboard → Edge Functions → 新建函数 push-bridge → 粘贴本文件 →
//      关闭 JWT 校验（本函数用 cron_secret 自校验）
// 职责：扫描用户自有 Supabase 的桥收件箱（拉走即删，与客户端互斥）→
//      匹配规则 → 冷却/上限 → 模板/AI 加工 → 占位符替换进 prompt 快照 →
//      生成真回复 → 写 push_outbox → 逐条推送。逻辑与 netlify 版一致。
// 注意：自包含移植文件，改动共享逻辑时需同步。

type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

// ── 内嵌：Web Push 协议原生实现（RFC8291 aes128gcm + RFC8292 VAPID）──
// npm:web-push 依赖 Node 加密接口，在 Deno Edge 运行时不可靠，这里用 WebCrypto 手写。

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

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
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as unknown as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const ikm = await hkdf(authSecret, ecdh, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
  const plaintext = concatBytes(utf8(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as unknown as BufferSource },
    aesKey,
    plaintext as unknown as BufferSource,
  ));

  // aes128gcm 头：salt(16) + rs(4, 4096) + idlen(1) + as_public(65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

async function buildVapidAuth(endpoint: string, subject: string, publicKeyB64: string, privateKeyB64: string): Promise<string> {
  const pub = b64urlToBytes(publicKeyB64);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateKeyB64,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
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

/** 发送一条 Web Push；返回 HTTP 状态码（201=成功，404/410=订阅失效）。 */
async function sendWebPushRaw(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttl: number,
): Promise<number> {
  const body = await encryptWebPushPayload(sub.p256dh, sub.auth, payload);
  const authorization = await buildVapidAuth(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  const response = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
    },
    body: body as unknown as BodyInit,
  });
  await response.text().catch(() => "");
  return response.status;
}

// ── 主流程 ──


const BRIDGE_EVENT_SENTINEL = "BRIDGE_EVENT_TEXT";

function stripHallucinatedTimestamps(text: string): string {
  return text
    .replace(/[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*/g, "")
    .replace(/\(system\s*time\s*[:：][^)]*\)\s*/gi, "");
}

function textFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
      if (typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function extractResponseText(providerKind: ProviderKind, data: unknown): string {
  if (providerKind === "anthropic") {
    const blocks = (data as { content?: unknown[] }).content;
    let text = "";
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const item = block as { type?: string; text?: string };
      if (item.type === "text") text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  if (providerKind === "gemini") {
    const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      const item = part as { text?: string; thought?: boolean; functionCall?: unknown };
      if (!item.functionCall && !item.thought) text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  const d = data as { choices?: Array<{ message?: { content?: unknown }; text?: string }>; output?: { text?: string }; response?: string };
  const messageText = textFromUnknownContent(d.choices?.[0]?.message?.content).trim();
  const text = messageText
    || (typeof d.choices?.[0]?.text === "string" ? d.choices[0].text.trim() : "")
    || (typeof d.output?.text === "string" ? d.output.text.trim() : "")
    || (typeof d.response === "string" ? d.response.trim() : "");
  return stripHallucinatedTimestamps(text);
}

const RICH_MEDIA_NAMES = new Set(["红包", "转账", "照片", "位置", "表情包", "引用", "语音", "音乐"]);

function stripStateValues(text: string): string {
  const regex = /\[([^\[\]:：]+)[：:](\d+(?:\.\d+)?)\]/g;
  return text.replace(regex, (m, rawName: string) => {
    const name = rawName.trim();
    if (!name || /^\d+$/.test(name) || RICH_MEDIA_NAMES.has(name)) return m;
    return "";
  });
}

function stripBracketBlock(text: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)\\[\\/${escaped}\\]`, "g"), "");
}

function humanizeSegment(segment: string): string {
  const marker = segment.match(/^\[([^\][：:]{1,12})[：:]([\s\S]*?)\]$/);
  if (!marker) return segment;
  const kind = marker[1];
  if (/表情包/.test(kind)) return "[表情包]";
  if (/图片|照片|图片描述/.test(kind)) return `发了一张照片: ${marker[2].slice(0, 40)}`;
  if (/语音通话/.test(kind)) return "发起了语音通话";
  if (/视频通话/.test(kind)) return "发起了视频通话";
  if (/语音/.test(kind)) return "[语音]";
  if (/红包/.test(kind)) return "[红包]";
  if (/转账/.test(kind)) return "[转账]";
  if (/位置/.test(kind)) return "[位置]";
  if (/拍一拍|拍了拍/.test(kind)) return "拍了拍你";
  return segment;
}

function splitResponseForPushPreview(rawText: string): string[] {
  let text = stripStateValues(rawText);
  text = stripBracketBlock(text, "状态栏");
  text = stripBracketBlock(text, "内心");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text
    .split(/\n\n+/)
    .map(segment => humanizeSegment(segment.trim()))
    .map(segment => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function fillBridgeTemplate(template: string, item: { type: string; payload: string }): string {
  return template.replace(/\{payload\}/g, item.payload).replace(/\{type\}/g, item.type);
}

function substituteSentinel(bodyJson: string, sentinel: string, text: string): string {
  const escaped = JSON.stringify(text).slice(1, -1);
  const escapedSentinel = JSON.stringify(sentinel).slice(1, -1);
  return bodyJson.split(escapedSentinel).join(escaped).split(sentinel).join(escaped);
}

type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(raw);
}

/** 与网关 encryptPayload 同格式：武装续跑任务时给快照加密落库。 */
async function encryptJobPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plain) as unknown as BufferSource,
  ));
  return {
    v: 1,
    iv: bytesToBase64(iv),
    tag: bytesToBase64(combined.slice(combined.length - 16)),
    ct: bytesToBase64(combined.slice(0, combined.length - 16)),
  };
}

async function decryptPayload(payload: EncryptedPayload, serviceKey: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${serviceKey}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const ct = base64ToBytes(payload.ct);
  const tag = base64ToBytes(payload.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) as unknown as BufferSource },
    key,
    combined as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

type JobRow = { id: string; user_id: string; trigger_key: string; kind: string };
type SubscriptionRow = { endpoint: string; p256dh: string; auth: string };
type BridgeItem = { id: string; type: string; payload: string; createdAt: string };

type ServerBridgeRule = {
  id: string;
  name: string;
  matchType: string;
  cooldownMinutes?: number;
  process: { mode: "raw" | "template" | "ai"; template?: string };
  chat?: {
    characterId: string;
    sessionId: string;
    role: string;
    historyRole?: string;
    requestReply: boolean;
    characterName: string;
  };
  notify?: boolean;
  /** 出站快捷动作快照：规则命中时调用本项目网关创建快捷命令并推送运行通知 */
  shortcut?: {
    actionId: string;
    name: string;
    shortcutName: string;
    resultMode: "none" | "text" | "image";
    expiresInSeconds?: number;
  };
  deferredActions?: string[];
};

type BridgeConfigRow = {
  rules: ServerBridgeRule[];
  cloud_config: EncryptedPayload | null;
  rule_runs: Record<string, string>;
  daily_cap: number;
  daily_count: { day?: string; count?: number };
  shortcut_actions?: unknown;
};

type SnapshotRow = { rule_id: string; payload: EncryptedPayload };

type RuleSnapshot = {
  replyRequest?: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  processRequest?: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  /** 角色绑定的微信 bot：离线回复可改送微信（AI 首行输出【发到微信】时启用） */
  weixin?: { botId?: string };
  /** 离线快捷动作的结果续跑快照：AI 调用需回传的动作时武装 shortcut_resume */
  shortcutContinuation?: {
    request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
    replyMarker: string;
    resultMarker: string;
    imageMarker?: string;
  };
  reply?: Record<string, unknown>;
};

const INBOX_PREFIX = "bridge-inbox/";
const BACKUP_BUCKET = "ai-phone-backup";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parseBridgeItem(name: string, text: string): BridgeItem | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const type = String(parsed.type ?? "").trim().slice(0, 60);
    if (!type) return null;
    const rawPayload = parsed.payload;
    const payload = typeof rawPayload === "string"
      ? rawPayload.slice(0, 8000)
      : JSON.stringify(rawPayload ?? "").slice(0, 8000);
    return { id: name, type, payload, createdAt: String(parsed.createdAt ?? new Date().toISOString()) };
  } catch {
    return null;
  }
}

async function callLlm(
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind },
  bodyJson: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: bodyJson,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`api ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
    }
    const data = await response.json();
    return extractResponseText(request.providerKind, data).trim();
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 200 });

  const { jobId, token } = await req.json().catch(() => ({})) as { jobId?: string; token?: string };
  if (!jobId || !token) return new Response("bad request", { status: 400 });

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });

  const secretResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key,site_origin&limit=1");
  const secretRows = secretResponse.ok ? await secretResponse.json() as { cron_secret?: string | null; payload_key?: string | null; site_origin?: string | null }[] : [];
  const cronSecret = secretRows[0]?.cron_secret || "";
  const payloadKey = secretRows[0]?.payload_key || "";
  const siteOrigin = secretRows[0]?.site_origin || "";
  if (!cronSecret || String(token) !== cronSecret) {
    return new Response("forbidden", { status: 403 });
  }

  const claim = await rest(`push_jobs?id=eq.${encodeURIComponent(jobId)}&status=eq.pending&kind=eq.bridge_scan`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() }),
  });
  const claimed = claim.ok ? await claim.json() as JobRow[] : [];
  const job = claimed[0];
  if (!job) return new Response("already claimed", { status: 200 });

  const finish = (status: "done" | "failed", note: string) => rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status, result_note: note.slice(0, 300), updated_at: new Date().toISOString() }),
  }).catch(() => undefined);

  // pg_net 的请求超时只有几秒：必须立即响应，重活放进 waitUntil 后台继续。
  const runJob = async (): Promise<void> => {
  try {
    const configResponse = await rest(
      `push_bridge_config?user_id=eq.${encodeURIComponent(job.user_id)}&select=rules,cloud_config,rule_runs,daily_cap,daily_count,shortcut_actions&limit=1`,
    );
    const configRows = configResponse.ok ? await configResponse.json() as BridgeConfigRow[] : [];
    const config = configRows[0];
    if (!config?.cloud_config) {
      await finish("done", "no bridge config");
      return;
    }
    if (!payloadKey) {
      await finish("failed", "payload_key missing (open push settings once to bootstrap)");
      return;
    }
    const cloud = JSON.parse(await decryptPayload(config.cloud_config, payloadKey)) as { url?: string; key?: string };
    const cloudUrl = (cloud.url || "").replace(/\/+$/, "");
    const cloudKey = cloud.key || "";
    if (!cloudUrl || !cloudKey) {
      await finish("done", "cloud config incomplete");
      return;
    }
    const storageHeaders = { apikey: cloudKey, Authorization: `Bearer ${cloudKey}` };

    const listResponse = await fetch(`${cloudUrl}/storage/v1/object/list/${BACKUP_BUCKET}`, {
      method: "POST",
      headers: { ...storageHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: INBOX_PREFIX, limit: 20, offset: 0, sortBy: { column: "name", order: "asc" } }),
    });
    const objects = listResponse.ok ? await listResponse.json() as { name?: string }[] : [];
    const fileNames = (Array.isArray(objects) ? objects : [])
      .map(obj => String(obj.name ?? ""))
      .filter(name => name && !name.endsWith("/") && name !== ".emptyFolderPlaceholder");
    if (fileNames.length === 0) {
      await finish("done", "inbox empty (client handled)");
      return;
    }

    const items: BridgeItem[] = [];
    for (const name of fileNames) {
      const path = `${INBOX_PREFIX}${name}`;
      try {
        const objectResponse = await fetch(`${cloudUrl}/storage/v1/object/${BACKUP_BUCKET}/${path}`, { headers: storageHeaders });
        if (!objectResponse.ok) continue;
        const text = await objectResponse.text();
        // 删除即认领：只有真正删掉（2xx）才有权处理；404=客户端已取走，其他失败留待下次，防重复触发
        const deleteResponse = await fetch(`${cloudUrl}/storage/v1/object/${BACKUP_BUCKET}/${path}`, { method: "DELETE", headers: storageHeaders });
        if (!deleteResponse.ok) continue;
        const item = parseBridgeItem(name, text);
        if (item) items.push(item);
      } catch {
        // 单条失败不阻塞
      }
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
    if (items.length === 0) {
      await finish("done", "no parsable items");
      return;
    }

    const subsResponse = await rest(`push_subscriptions?user_id=eq.${encodeURIComponent(job.user_id)}&select=endpoint,p256dh,auth`);
    const subs = subsResponse.ok ? await subsResponse.json() as SubscriptionRow[] : [];

    const vapidResponse = await rest("push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key&limit=1");
    const vapidRows = vapidResponse.ok ? await vapidResponse.json() as { vapid_public_key: string; vapid_private_key: string }[] : [];
    const vapidRow = vapidRows[0];
    const vapid = vapidRow
      ? { publicKey: vapidRow.vapid_public_key, privateKey: vapidRow.vapid_private_key, subject: siteOrigin || "mailto:push@ai-phone.local" }
      : null;
    const pushErrors: string[] = [];

    const sendPush = async (title: string, bodyText: string, tag: string) => {
      if (!vapid || subs.length === 0) return;
      const message = JSON.stringify({ title, body: bodyText.slice(0, 80), tag, url: "/" });
      for (const sub of subs) {
        try {
          const status = await sendWebPushRaw(sub, message, vapid, 3600);
          if (status === 404 || status === 410) {
            await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" }).catch(() => undefined);
          } else if (status >= 400) {
            pushErrors.push(`http ${status}`);
          }
        } catch (err) {
          pushErrors.push((err instanceof Error ? err.message : String(err)).slice(0, 80));
        }
      }
    };

    // 经本项目网关创建快捷命令并推送「运行」通知（声明式，点通知即拉起快捷指令）
    const sendShortcutCreate = async (
      action: Record<string, unknown>,
      deferDelivery = false,
    ): Promise<{ ok: boolean; note: string; commandId: string }> => {
      const actionName = String(action.name ?? "");
      try {
        const createResponse = await fetch(`${supabaseUrl}/functions/v1/ai-phone-push?action=shortcut-create`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ai-phone-service-key": serviceKey,
            "x-ai-phone-origin": siteOrigin,
          },
          body: JSON.stringify({
            actionId: String(action.actionId ?? ""),
            actionName,
            shortcutName: String(action.shortcutName ?? ""),
            arguments: {},
            resultMode: String(action.resultMode ?? "none"),
            expiresInSeconds: Number(action.expiresInSeconds) || undefined,
            deferDelivery,
          }),
        });
        const createResult = await createResponse.json().catch(() => ({})) as {
          ok?: boolean;
          delivered?: boolean;
          error?: string;
          command?: { id?: string };
        };
        const ok = createResponse.ok && createResult.ok === true;
        return {
          ok,
          commandId: ok ? String(createResult.command?.id || "") : "",
          note: ok
            ? (deferDelivery
              ? `快捷动作「${actionName}」已创建，等待首条回复送达`
              : createResult.delivered
              ? `已发出快捷动作「${actionName}」运行通知（服务端）`
              : `快捷动作「${actionName}」已创建但通知未送达`)
            : `快捷动作「${actionName}」发送失败：${(createResult.error || `HTTP ${createResponse.status}`).slice(0, 80)}`,
        };
      } catch (err) {
        return { ok: false, commandId: "", note: `快捷动作「${actionName}」发送失败：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` };
      }
    };
    const deliverShortcutCommand = async (
      commandId: string,
      actionName: string,
    ): Promise<{ ok: boolean; note: string }> => {
      try {
        const response = await fetch(`${supabaseUrl}/functions/v1/ai-phone-push?action=shortcut-deliver`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ai-phone-service-key": serviceKey,
            "x-ai-phone-origin": siteOrigin,
          },
          body: JSON.stringify({ commandId }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; delivered?: boolean; error?: string };
        const ok = response.ok && data.ok === true && data.delivered === true;
        return {
          ok,
          note: ok
            ? `已在首条回复后发出快捷动作「${actionName}」运行通知`
            : `快捷动作「${actionName}」通知失败：${String(data.error || `HTTP ${response.status}`).slice(0, 80)}`,
        };
      } catch (err) {
        return {
          ok: false,
          note: `快捷动作「${actionName}」通知失败：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`,
        };
      }
    };
    const shortcutCatalog = Array.isArray(config.shortcut_actions)
      ? config.shortcut_actions as Array<Record<string, unknown>>
      : [];

    // 借微信云助手把文本送到用户微信（send-text 动作，部署密钥鉴权）
    const sendWeixinText = async (
      botId: string,
      text: string,
      replyAnchor?: { localMessageId: string; createdAt: string },
    ): Promise<boolean> => {
      try {
        const secretResponse = await fetch(
          `${supabaseUrl}/storage/v1/object/ai-phone-backup/weixin-cloud/cron-secret.json`,
          { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
        );
        const secret = secretResponse.ok
          ? String(((await secretResponse.json().catch(() => ({}))) as { token?: unknown }).token || "")
          : "";
        if (!secret) return false;
        const sendResponse = await fetch(`${supabaseUrl}/functions/v1/weixin-assistant`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "send-text",
            token: secret,
            bot: botId,
            text,
            ...(replyAnchor?.localMessageId && replyAnchor.createdAt
              ? {
                  replyAfterLocalMessageId: replyAnchor.localMessageId,
                  replyAfterCreatedAt: replyAnchor.createdAt,
                }
              : {}),
          }),
        });
        const sendData = await sendResponse.json().catch(() => ({})) as { ok?: boolean };
        return sendResponse.ok && sendData.ok === true;
      } catch {
        return false;
      }
    };

    const snapshotCache = new Map<string, RuleSnapshot | null>();
    const loadSnapshot = async (ruleId: string): Promise<RuleSnapshot | null> => {
      if (snapshotCache.has(ruleId)) return snapshotCache.get(ruleId) ?? null;
      const response = await rest(
        `push_bridge_snapshots?user_id=eq.${encodeURIComponent(job.user_id)}&rule_id=eq.${encodeURIComponent(ruleId)}&select=rule_id,payload&limit=1`,
      );
      const rows = response.ok ? await response.json() as SnapshotRow[] : [];
      let parsed: RuleSnapshot | null = null;
      if (rows[0]) {
        try {
          parsed = JSON.parse(await decryptPayload(rows[0].payload, payloadKey)) as RuleSnapshot;
        } catch {
          parsed = null;
        }
      }
      snapshotCache.set(ruleId, parsed);
      return parsed;
    };

    const rules = Array.isArray(config.rules) ? config.rules : [];
    const ruleRuns: Record<string, string> = { ...(config.rule_runs || {}) };
    const today = new Date().toISOString().slice(0, 10);
    let dailyCount = config.daily_count?.day === today ? Number(config.daily_count.count) || 0 : 0;
    const dailyCap = Math.max(1, Number(config.daily_cap) || 20);

    const outboxRows: Record<string, unknown>[] = [];
    let generated = 0;

    for (const item of items) {
      const matched = rules.filter(rule => rule.matchType === "*" || rule.matchType === item.type);
      if (matched.length === 0) {
        outboxRows.push({
          id: `out_${crypto.randomUUID()}`,
          user_id: job.user_id,
          job_id: job.id,
          session_id: null,
          trigger_key: job.trigger_key,
          raw_text: "",
          meta: { kind: "bridge", item, feedNote: "仅存档（无匹配规则，服务端处理）" },
        });
        continue;
      }

      for (const rule of matched) {
        const cooldownMs = Math.max(0, Number(rule.cooldownMinutes) || 0) * 60_000;
        const lastRun = ruleRuns[rule.id] ? Date.parse(ruleRuns[rule.id]) : 0;
        if (cooldownMs > 0 && Date.now() - lastRun < cooldownMs) {
          outboxRows.push({
            id: `out_${crypto.randomUUID()}`,
            user_id: job.user_id,
            job_id: job.id,
            session_id: null,
            trigger_key: job.trigger_key,
            raw_text: "",
            meta: { kind: "bridge", item, ruleId: rule.id, ruleName: rule.name, feedNote: `「${rule.name}」还在触发间隔内，这次只存档（服务端）` },
          });
          continue;
        }

        ruleRuns[rule.id] = new Date().toISOString();

        let processed = item.payload;
        const bridgeChatMessageId = rule.chat
          ? `bridge_${rule.id}_${item.id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 240)
          : "";
        if (rule.process?.mode === "template" && rule.process.template) {
          processed = fillBridgeTemplate(rule.process.template, item).slice(0, 4000);
        } else if (rule.process?.mode === "ai") {
          const snapshot = await loadSnapshot(rule.id);
          if (snapshot?.processRequest) {
            try {
              const bodyJson = substituteSentinel(JSON.stringify(snapshot.processRequest.body), BRIDGE_EVENT_SENTINEL, item.payload);
              const text = await callLlm(snapshot.processRequest, bodyJson, 120_000);
              if (text) processed = text.slice(0, 4000);
            } catch {
              // 加工失败退回原始 payload
            }
          }
        }

        if (rule.notify) {
          await sendPush(`现实桥 · ${item.type}`, processed, `bridge-notify-${item.id}`);
        }

        // 出站快捷动作（规则勾选）：命中即由服务端直接发出运行通知。
        // 整条链都在用户自己的 Supabase 里。
        let shortcutNote = "";
        if (rule.shortcut?.shortcutName) {
          shortcutNote = (await sendShortcutCreate(rule.shortcut as unknown as Record<string, unknown>)).note;
        }

        let replyRaw = "";
        let capped = false;
        if (rule.chat?.requestReply) {
          if (dailyCount >= dailyCap) {
            capped = true;
          } else {
            const snapshot = await loadSnapshot(rule.id);
            if (snapshot?.replyRequest && subs.length > 0) {
              try {
                const bodyJson = substituteSentinel(JSON.stringify(snapshot.replyRequest.body), BRIDGE_EVENT_SENTINEL, processed);
                replyRaw = await callLlm(snapshot.replyRequest, bodyJson, 300_000);
                if (replyRaw) {
                  dailyCount += 1;
                  generated += 1;
                }
              } catch {
                replyRaw = "";
              }
            }
          }
        }

        // 角色离线自主调用：回复里输出【快捷动作：名称】即按目录匹配执行，
        // 标记从正文剥离（不进聊天记录）。每次生成最多执行一个。
        let deferredAiShortcutCommandId = "";
        let deferredAiShortcutName = "";
        if (replyRaw) {
          const markerMatch = replyRaw.match(/【快捷动作[：:]\s*([^】\n]{1,60})】/);
          if (markerMatch) {
            replyRaw = replyRaw.replace(/【快捷动作[：:][^】\n]{1,60}】/g, "").replace(/\n{3,}/g, "\n\n").trim();
            if (!replyRaw) replyRaw = "……";
            const wanted = markerMatch[1].trim();
            const catalogAction = shortcutCatalog.find(entry => String(entry.name ?? "") === wanted);
            let aiNote = `快捷动作「${wanted}」不存在或未启用`;
            if (catalogAction) {
              // 需回传结果的动作：武装 shortcut_resume 续跑——把桥事件文本和
              // 刚生成的回复代入续跑快照；结果回传后由 push-generate 生成下一轮。
              const resultMode = String(catalogAction.resultMode ?? "none");
              const snapshot = await loadSnapshot(rule.id);
              const continuation = snapshot?.shortcutContinuation;
              const canContinue = resultMode !== "none"
                && Boolean(continuation?.request && continuation.replyMarker && continuation.resultMarker);
              const created = await sendShortcutCreate(catalogAction, canContinue);
              aiNote = created.note;
              if (created.ok && created.commandId && canContinue && continuation) {
                try {
                  let contBodyJson = JSON.stringify(continuation.request.body);
                  contBodyJson = substituteSentinel(contBodyJson, BRIDGE_EVENT_SENTINEL, processed);
                  contBodyJson = substituteSentinel(contBodyJson, continuation.replyMarker, replyRaw);
                  const isImage = resultMode === "image";
                  if (!isImage && continuation.imageMarker) {
                    contBodyJson = substituteSentinel(contBodyJson, continuation.imageMarker, "（该动作没有图片回传）");
                  }
                  const expiresIn = Math.max(30, Math.min(900, Number(catalogAction.expiresInSeconds) || 120));
                  const contPayload = {
                    request: { ...continuation.request, body: JSON.parse(contBodyJson) as Record<string, unknown> },
                    shortcut: {
                      commandId: created.commandId,
                      actionName: String(catalogAction.name ?? "快捷动作"),
                      resultMode,
                      resultMarker: continuation.resultMarker,
                      ...(isImage && continuation.imageMarker ? { imageMarker: continuation.imageMarker } : {}),
                      style: "text",
                    },
                    notify: { title: rule.chat?.characterName || "小手机", url: "/" },
                    merge: {
                      sessionId: rule.chat?.sessionId ?? null,
                      regexes: (snapshot?.reply as { regexes?: unknown } | undefined)?.regexes ?? [],
                      characterName: rule.chat?.characterName || "小手机",
                      userName: (snapshot?.reply as { userName?: unknown } | undefined)?.userName ?? "用户",
                      appId: "chat",
                      appTags: ["chat", "text"],
                      shortcutCommandId: created.commandId,
                      ...(bridgeChatMessageId
                        ? {
                            replyAfterLocalMessageId: bridgeChatMessageId,
                            replyAfterCreatedAt: item.createdAt,
                          }
                        : {}),
                    },
                  };
                  const contTriggerKey = `shortcut:${created.commandId}`;
                  await rest(
                    `push_jobs?user_id=eq.${encodeURIComponent(job.user_id)}&trigger_key=eq.${encodeURIComponent(contTriggerKey)}`,
                    { method: "DELETE" },
                  ).catch(() => undefined);
                  const armed = await rest("push_jobs", {
                    method: "POST",
                    body: JSON.stringify([{
                      id: `job_${crypto.randomUUID()}`,
                      user_id: job.user_id,
                      trigger_key: contTriggerKey,
                      kind: "shortcut_resume",
                      execute_at: new Date(Date.now() + (expiresIn + 90) * 1000).toISOString(),
                      status: "pending",
                      result_note: "cloud_shortcut_resume",
                      payload: await encryptJobPayload(JSON.stringify(contPayload), payloadKey),
                    }]),
                  });
                  await armed.text().catch(() => "");
                  if (armed.ok) {
                    deferredAiShortcutCommandId = created.commandId;
                    deferredAiShortcutName = String(catalogAction.name ?? wanted);
                    aiNote += "，已挂结果续跑";
                  } else {
                    aiNote += "，结果续跑挂载失败";
                  }
                } catch {
                  aiNote += "，结果续跑挂载失败";
                }
              }
            }
            shortcutNote = shortcutNote ? `${shortcutNote}；${aiNote}` : aiNote;
          }
        }

        // 离线改送微信：AI 首行输出【发到微信】则借微信云助手发送；
        // 成功后回复归属微信会话（不写回箱正文、不推网页通知），失败回落普通推送。
        let deliveredViaWeixin = false;
        if (replyRaw) {
          const WEIXIN_MARKER = "【发到微信】";
          const markerAt = replyRaw.slice(0, 200).indexOf(WEIXIN_MARKER);
          if (markerAt >= 0) {
            replyRaw = (replyRaw.slice(0, markerAt) + replyRaw.slice(markerAt + WEIXIN_MARKER.length)).trim();
            if (!replyRaw) replyRaw = "……";
            const snapshot = await loadSnapshot(rule.id);
            const weixinBotId = typeof snapshot?.weixin?.botId === "string" ? snapshot.weixin.botId : "";
            if (weixinBotId) {
              deliveredViaWeixin = await sendWeixinText(
                weixinBotId,
                replyRaw,
                bridgeChatMessageId
                  ? { localMessageId: bridgeChatMessageId, createdAt: item.createdAt }
                  : undefined,
              );
            }
            const weixinNote = deliveredViaWeixin ? "回复已改送微信" : "改送微信失败，回落通知";
            shortcutNote = shortcutNote ? `${shortcutNote}；${weixinNote}` : weixinNote;
          }
        }

        const outboxId = `out_${crypto.randomUUID()}`;
        const outboxMeta: Record<string, unknown> = {
          kind: "bridge",
          item,
          ...(bridgeChatMessageId ? { chatMessageId: bridgeChatMessageId } : {}),
          ruleId: rule.id,
          ruleName: rule.name,
          executed: true,
          ranAt: ruleRuns[rule.id],
          processedText: processed,
          chat: rule.chat ?? null,
          deferredActions: rule.deferredActions ?? [],
          ...(shortcutNote ? { shortcutNote } : {}),
          capped,
          reply: replyRaw ? (await loadSnapshot(rule.id))?.reply ?? null : null,
        };
        const stored = await rest("push_outbox", {
          method: "POST",
          body: JSON.stringify([{
            id: outboxId,
            user_id: job.user_id,
            job_id: job.id,
            session_id: rule.chat?.sessionId ?? null,
            trigger_key: job.trigger_key,
            raw_text: deliveredViaWeixin ? "" : replyRaw,
            meta: outboxMeta,
          }]),
        });
        if (!stored.ok) {
          pushErrors.push(`outbox http ${stored.status}`);
        }

        if (stored.ok && replyRaw && rule.chat && !deliveredViaWeixin) {
          let parts = splitResponseForPushPreview(replyRaw).slice(0, 6);
          if (parts.length === 0) parts = ["发来一条消息"];
          for (let index = 0; index < parts.length; index += 1) {
            if (index > 0) await sleep(800);
            await sendPush(rule.chat.characterName || "小手机", parts[index], `bridge-${item.id}-${rule.id}-${index}`);
          }
        }

        if (stored.ok && deferredAiShortcutCommandId) {
          const delivered = await deliverShortcutCommand(deferredAiShortcutCommandId, deferredAiShortcutName);
          shortcutNote = shortcutNote ? `${shortcutNote}；${delivered.note}` : delivered.note;
          outboxMeta.shortcutNote = shortcutNote;
          await rest(`push_outbox?id=eq.${encodeURIComponent(outboxId)}`, {
            method: "PATCH",
            body: JSON.stringify({ meta: outboxMeta }),
          }).catch(() => undefined);
          if (!delivered.ok) pushErrors.push(delivered.note);
        }
      }
    }

    if (outboxRows.length > 0) {
      await rest("push_outbox", { method: "POST", body: JSON.stringify(outboxRows) });
    }
    await rest(`push_bridge_config?user_id=eq.${encodeURIComponent(job.user_id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        rule_runs: ruleRuns,
        daily_count: { day: today, count: dailyCount },
        updated_at: new Date().toISOString(),
      }),
    });

    await finish("done", `items ${items.length}, generated ${generated}${pushErrors.length ? `, push errors: ${pushErrors.slice(0, 3).join(" | ")}` : ""}`);
  } catch (err) {
    await finish("failed", err instanceof Error ? err.message : String(err));
  }
  };

  const work = runJob();
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work);
  else await work;
  return new Response("accepted", { status: 200 });
});
