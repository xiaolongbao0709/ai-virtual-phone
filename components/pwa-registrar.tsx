"use client";

import { useEffect } from "react";

type NativeBridgeWindow = Window & {
  FlutterWebView?: unknown;
};

export function PWARegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // WebToApp 的 WebView 由原生 FCM 负责通知。除了不再注册网页 SW，还主动
    // 注销旧版本曾经留下的 SW，避免 Notification/Web Push 继续触发“站点不对”等提示。
    if ((window as NativeBridgeWindow).FlutterWebView) {
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch((error) => {
          console.warn("[PWA] Failed to unregister legacy service workers in native app:", error);
        });
      return;
    }

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
        console.warn("[PWA] Service worker registration failed:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return () => {
        cancelled = true;
      };
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
