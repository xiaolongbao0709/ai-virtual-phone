"use client";

import { useEffect } from "react";

type FlutterFcmDetail = {
  token?: string | null;
  previousToken?: string | null;
  userId?: string | null;
  topic?: string | null;
  permission?: "authorized" | "provisional" | "denied" | "notDetermined" | string;
  platform?: "ios" | "android" | string;
};

type FlutterBridgeWindow = Window & {
  FlutterWebView?: {
    postMessage: (message: string) => void;
  };
  FlutterFcm?: FlutterFcmDetail;
};

function endpointForToken(token: string): string {
  return `fcm:${token}`;
}

async function currentAccountId(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/me", {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({})) as {
      account?: { id?: unknown } | null;
    };
    return typeof payload.account?.id === "string" && payload.account.id.trim()
      ? payload.account.id.trim()
      : null;
  } catch {
    return null;
  }
}

async function removeToken(token: string): Promise<void> {
  if (!token) return;
  await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ endpoint: endpointForToken(token) }),
  }).catch(() => undefined);
}

async function saveToken(token: string): Promise<void> {
  if (!token) return;
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      endpoint: endpointForToken(token),
      keys: { p256dh: "fcm", auth: "fcm" },
    }),
  }).catch(() => undefined);
}

export function NativePushBridge() {
  useEffect(() => {
    const appWindow = window as FlutterBridgeWindow;
    if (!appWindow.FlutterWebView) return;

    let disposed = false;

    const postToNative = (payload: Record<string, unknown>) => {
      try {
        appWindow.FlutterWebView?.postMessage(JSON.stringify(payload));
      } catch (error) {
        console.warn("[NativePush] bridge message failed:", error);
      }
    };

    const sync = async (detail?: FlutterFcmDetail) => {
      const accountId = await currentAccountId();
      if (disposed) return;

      postToNative({ type: "userId", userId: accountId });

      const current = detail || appWindow.FlutterFcm;
      if (!current) {
        postToNative({ type: "getFcmToken" });
        return;
      }

      const previousToken = typeof current.previousToken === "string" ? current.previousToken.trim() : "";
      const token = typeof current.token === "string" ? current.token.trim() : "";

      if (previousToken && previousToken !== token) await removeToken(previousToken);
      if (disposed) return;

      if (!accountId || current.permission === "denied" || !token) {
        if (token && current.permission === "denied") await removeToken(token);
        return;
      }

      await saveToken(token);
    };

    const onToken = (event: Event) => {
      const customEvent = event as CustomEvent<FlutterFcmDetail>;
      void sync(customEvent.detail);
    };
    const onFocus = () => {
      postToNative({ type: "getFcmToken" });
      void sync(appWindow.FlutterFcm);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus();
    };

    window.addEventListener("FlutterFcmToken", onToken as EventListener);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    void sync(appWindow.FlutterFcm);
    postToNative({ type: "getFcmToken" });

    return () => {
      disposed = true;
      window.removeEventListener("FlutterFcmToken", onToken as EventListener);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
