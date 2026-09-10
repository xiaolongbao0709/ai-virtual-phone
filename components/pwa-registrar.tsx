"use client";

import { useEffect } from "react";

type NativeBridgeWindow = Window & {
  FlutterWebView?: unknown;
};

export function PWARegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;

    // WebToApp 的 WebView 由原生 FCM 负责通知。这里如果继续注册网页 SW，
    // 页面会把 Notification/Web Push 当成主通道，导致出现“站点不对”等网页权限提示。
    if ((window as NativeBridgeWindow).FlutterWebView) return;
    if (!("serviceWorker" in navigator)) return;

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
