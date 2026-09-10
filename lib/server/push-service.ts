// 服务端推送：浏览器 Web Push + WebToApp FCM + 旧安卓壳兼容。
// VAPID 密钥存 push_server_config 表，设备订阅存 push_subscriptions。

import { randomBytes } from "node:crypto";

import webpush from "web-push";

import { sendFcmNativePush } from "./fcm-native-push";
import { encodeSupabaseFilter, getSupabaseServerConfig, supabaseRestFetch } from "./supabase-rest";

type VapidKeys = { publicKey: string; privateKey: string };

type VapidConfigRow = {
  vapid_public_key: string;
  vapid_private_key: string;
  cron_secret?: string | null;
  payload_key?: string | null;
};

type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushMessage = {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  type?: "shortcut_command";
  commandId?: string;
  ttl?: number;
};

export type PushSendResult = {
  sent: number;
  total: number;
  errors: string[];
};

// 旧 FloatShell 使用 Supabase Realtime；WebToApp 新壳使用真正的系统 FCM。
const SHELL_ENDPOINT_PREFIX = "shell:";
const FCM_ENDPOINT_PREFIX = "fcm:";

/** 向旧安卓壳的个人频道 shellpush:<userId> 广播一条通知（兼容保留）。 */
export async function broadcastShellNotify(
  userId: string,
  message: { title: string; body: string; url?: string },
): Promise<boolean> {
  const config = getSupabaseServerConfig();
  if (!config) return false;
  try {
    const response = await fetch(`${config.url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{
          topic: `shellpush:${userId}`,
          event: "notify",
          payload: { title: message.title, body: message.body, url: message.url || "/" },
        }],
      }),
      cache: "no-store",
    });
    await response.text().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/** VAPID subject 必须是 https: 或 mailto:。本地 http 环境回退到 mailto。 */
export function resolvePushSubject(requestUrl: string): string {
  try {
    const origin = new URL(requestUrl).origin;
    if (origin.startsWith("https://")) return origin;
  } catch {
    // fall through
  }
  return "mailto:push@ai-virtual-phone.local";
}

export async function getOrCreateVapidConfig(): Promise<VapidKeys> {
  const select = "push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key,cron_secret,payload_key&limit=1";
  const existing = await supabaseRestFetch<VapidConfigRow[]>(select);
  if (!existing.ok) throw new Error(existing.error);
  if (existing.data[0]) {
    const patch: Record<string, string> = {};
    if (!existing.data[0].cron_secret) patch.cron_secret = randomBytes(24).toString("hex");
    if (!existing.data[0].payload_key) patch.payload_key = randomBytes(32).toString("hex");
    if (Object.keys(patch).length > 0) {
      await supabaseRestFetch("push_server_config?id=eq.main", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }).catch(() => undefined);
    }
    return { publicKey: existing.data[0].vapid_public_key, privateKey: existing.data[0].vapid_private_key };
  }

  const keys = webpush.generateVAPIDKeys();
  const insert = await supabaseRestFetch("push_server_config", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify([{
      id: "main",
      vapid_public_key: keys.publicKey,
      vapid_private_key: keys.privateKey,
      cron_secret: randomBytes(24).toString("hex"),
      payload_key: randomBytes(32).toString("hex"),
    }]),
  });
  if (!insert.ok) throw new Error(insert.error);

  const again = await supabaseRestFetch<VapidConfigRow[]>(select);
  if (!again.ok) throw new Error(again.error);
  if (again.data[0]) {
    return { publicKey: again.data[0].vapid_public_key, privateKey: again.data[0].vapid_private_key };
  }
  return keys;
}

/** 快照加解密密钥：存表共享，Next 路由与 Edge Function 从同一来源读取。 */
export async function getOrCreatePushPayloadKey(): Promise<string> {
  const select = "push_server_config?id=eq.main&select=payload_key&limit=1";
  const existing = await supabaseRestFetch<{ payload_key?: string | null }[]>(select);
  if (!existing.ok) throw new Error(existing.error);
  if (existing.data[0]?.payload_key) return existing.data[0].payload_key;
  await getOrCreateVapidConfig();
  const again = await supabaseRestFetch<{ payload_key?: string | null }[]>(select);
  if (!again.ok) throw new Error(again.error);
  const key = again.data[0]?.payload_key;
  if (!key) throw new Error("payload_key bootstrap failed");
  return key;
}

/** 给某个账号的所有订阅设备发一条推送。失效订阅会自动清掉。 */
export async function sendPushToUser(
  userId: string,
  message: PushMessage,
  subject: string,
): Promise<PushSendResult> {
  const subs = await supabaseRestFetch<PushSubscriptionRow[]>(
    `push_subscriptions?user_id=eq.${encodeSupabaseFilter(userId)}&select=endpoint,p256dh,auth`,
  );
  if (!subs.ok) throw new Error(subs.error);

  const navigate = (() => {
    if (message.url) {
      try {
        return new URL(message.url, subject.startsWith("https://") ? subject : undefined).toString();
      } catch {
        return message.url;
      }
    }
    return subject.startsWith("https://") ? subject : "/";
  })();
  const assetOrigin = (() => {
    try {
      return new URL(navigate).origin;
    } catch {
      return "";
    }
  })();

  const payload = JSON.stringify({
    web_push: 8030,
    notification: {
      title: message.title,
      body: message.body,
      navigate,
      tag: message.tag,
      icon: assetOrigin ? `${assetOrigin}/icon-192.png` : undefined,
      badge: assetOrigin ? `${assetOrigin}/icon-192.png` : undefined,
      silent: false,
      mutable: false,
      data: {
        url: navigate,
        type: message.type || "",
        commandId: message.commandId || "",
      },
    },
  });
  const result: PushSendResult = { sent: 0, total: subs.data.length, errors: [] };

  const shellSubs = subs.data.filter((sub) => sub.endpoint.startsWith(SHELL_ENDPOINT_PREFIX));
  const fcmSubs = subs.data.filter((sub) => sub.endpoint.startsWith(FCM_ENDPOINT_PREFIX));
  const webSubs = subs.data.filter((sub) =>
    !sub.endpoint.startsWith(SHELL_ENDPOINT_PREFIX) && !sub.endpoint.startsWith(FCM_ENDPOINT_PREFIX)
  );

  if (shellSubs.length > 0) {
    const ok = await broadcastShellNotify(userId, { title: message.title, body: message.body, url: navigate });
    if (ok) result.sent += shellSubs.length;
    else result.errors.push("shell broadcast failed");
  }

  for (const sub of fcmSubs) {
    const endpointFilter = `push_subscriptions?endpoint=eq.${encodeSupabaseFilter(sub.endpoint)}`;
    const token = sub.endpoint.slice(FCM_ENDPOINT_PREFIX.length).trim();
    if (!token) {
      await supabaseRestFetch(endpointFilter, { method: "DELETE" }).catch(() => undefined);
      continue;
    }

    const sent = await sendFcmNativePush(token, {
      title: message.title,
      body: message.body,
      openUrl: navigate,
    });
    if (sent.ok) {
      result.sent += 1;
      await supabaseRestFetch(endpointFilter, {
        method: "PATCH",
        body: JSON.stringify({ last_ok_at: new Date().toISOString(), fail_count: 0 }),
      }).catch(() => undefined);
    } else if (sent.stale) {
      await supabaseRestFetch(endpointFilter, { method: "DELETE" }).catch(() => undefined);
    } else {
      result.errors.push(sent.error || "FCM native push failed");
    }
  }

  if (webSubs.length > 0) {
    const vapid = await getOrCreateVapidConfig();
    for (const sub of webSubs) {
      const endpointFilter = `push_subscriptions?endpoint=eq.${encodeSupabaseFilter(sub.endpoint)}`;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          {
            vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
            TTL: Math.max(30, Math.min(86_400, Number(message.ttl) || 3600)),
          },
        );
        result.sent += 1;
        await supabaseRestFetch(endpointFilter, {
          method: "PATCH",
          body: JSON.stringify({ last_ok_at: new Date().toISOString(), fail_count: 0 }),
        }).catch(() => undefined);
      } catch (err) {
        const statusCode = typeof err === "object" && err && "statusCode" in err
          ? Number((err as { statusCode?: unknown }).statusCode)
          : 0;
        if (statusCode === 404 || statusCode === 410) {
          await supabaseRestFetch(endpointFilter, { method: "DELETE" }).catch(() => undefined);
        } else {
          result.errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  return result;
}
