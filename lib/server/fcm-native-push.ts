import { getFirebaseCredentials, getGoogleAccessToken } from "./google-service-account";

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

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

function isStaleFcmError(status: number, payload: unknown): boolean {
  if (status === 404) return true;
  const text = JSON.stringify(payload || {}).toUpperCase();
  return text.includes("UNREGISTERED") || text.includes("NOT_FOUND") || text.includes("REGISTRATION_TOKEN_NOT_REGISTERED");
}

export async function sendFcmNativePush(token: string, message: FcmNativeMessage): Promise<FcmNativeSendResult> {
  const credentials = getFirebaseCredentials();
  if (!credentials) {
    return {
      ok: false,
      stale: false,
      error: "FCM 未配置：缺少 FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY。",
    };
  }

  try {
    const accessToken = await getGoogleAccessToken(credentials, [FCM_SCOPE]);
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
