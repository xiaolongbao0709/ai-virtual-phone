import { createSign } from "node:crypto";

type FirebaseCredentials = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

export type FcmNativeMessage = {
  title: string;
  body: string;
  openUrl: string;
};

export type FcmNativeSendResult = {
  ok: boolean;
  stale: boolean;
  error?: string;
};

let cachedToken: CachedToken | null = null;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function firebaseCredentials(): FirebaseCredentials | null {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

async function getAccessToken(credentials: FirebaseCredentials): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;

  const issuedAt = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsignedJwt = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedJwt);
  signer.end();
  const assertion = `${unsignedJwt}.${base64Url(signer.sign(credentials.privateKey))}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google OAuth ${response.status}`);
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: now + Math.max(300, Number(data.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

function isStaleFcmError(status: number, payload: unknown): boolean {
  if (status === 404) return true;
  const text = JSON.stringify(payload || {}).toUpperCase();
  return text.includes("UNREGISTERED") || text.includes("NOT_FOUND") || text.includes("REGISTRATION_TOKEN_NOT_REGISTERED");
}

export async function sendFcmNativePush(token: string, message: FcmNativeMessage): Promise<FcmNativeSendResult> {
  const credentials = firebaseCredentials();
  if (!credentials) {
    return {
      ok: false,
      stale: false,
      error: "FCM 未配置：缺少 FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY。",
    };
  }

  try {
    const accessToken = await getAccessToken(credentials);
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token,
            // shiaho777/web-to-app 的 NotificationFcmService 会从 data 读取
            // title/body/url 并自行创建 Android 系统通知。data-only + high
            // priority 也避免后台时由系统通知托盘绕过自定义点击 URL 逻辑。
            data: {
              title: message.title,
              body: message.body,
              url: message.openUrl,
            },
            android: {
              priority: "high",
              ttl: "3600s",
            },
          },
        }),
        cache: "no-store",
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, stale: false };
    return {
      ok: false,
      stale: isStaleFcmError(response.status, payload),
      error: `FCM ${response.status}: ${JSON.stringify(payload).slice(0, 600)}`,
    };
  } catch (error) {
    return {
      ok: false,
      stale: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
