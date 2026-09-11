// 独立于主 PWA Service Worker 的个人 Supabase 推送通道。
// 使用单独 scope/PushSubscription，因此不会破坏现实桥和快捷指令仍在使用的旧订阅。

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // 声明式 Web Push 载荷（iOS 由系统直接处理，根本不进这里）；老浏览器
  // 收到的是同一份 JSON，在此解包做命令式展示。
  const declarative = data.web_push === 8030 && data.notification && typeof data.notification === "object"
    ? data.notification
    : null;
  const meta = declarative && declarative.data && typeof declarative.data === "object"
    ? declarative.data
    : data;
  const title = (declarative && declarative.title) || data.title || "小手机";
  event.waitUntil((async () => {
    if (meta.type === "chat_outbox" || meta.type === "incoming_call") {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.filter(client => client.visibilityState === "visible");
      if (visible.length > 0) {
        if (meta.type === "incoming_call") {
          visible.forEach(client => client.postMessage({
            type: "incoming_call_push",
            sessionId: meta.sessionId || "",
            callTs: meta.callTs || 0,
          }));
        }
        visible.forEach(client => client.postMessage({ type: "push_outbox_ready" }));
        return;
      }
    }
    await self.registration.showNotification(title, {
      body: (declarative && declarative.body) || data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: (declarative && declarative.tag) || data.tag || `personal-push-${Date.now()}`,
      data: {
        url: (declarative && declarative.navigate) || meta.url || "/",
        type: meta.type || "",
        sessionId: meta.sessionId || "",
        callTs: meta.callTs || 0,
      },
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // 快捷指令通知（只在非 iOS 走到这里；iOS 由声明式 navigate 原生跳转）：
    // 有活页面就交给页面 location 过去，App 被杀则开同源转发路由。
    if (data.type === "shortcut_command" && data.url) {
      for (const client of windows) {
        if (!("focus" in client)) continue;
        client.postMessage({ type: "run_shortcut", url: data.url });
        return client.focus();
      }
      return self.clients.openWindow(data.url);
    }
    for (const client of windows) {
      if (!("focus" in client)) continue;
      if (data.type === "incoming_call") {
        client.postMessage({
          type: "incoming_call_push",
          sessionId: data.sessionId || "",
          callTs: data.callTs || 0,
        });
      }
      client.postMessage({ type: "push_outbox_ready" });
      return client.focus();
    }
    return self.clients.openWindow(data.url || "/");
  })());
});
