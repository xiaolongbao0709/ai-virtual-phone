// lib/browser-notification.ts
// Browser Notification API wrapper for background alerts.

import { loadChatAppSettings } from "./chat-storage";

let _notifCounter = 0;

/** Check if notifications are enabled in app settings. */
export function isNotificationEnabled(): boolean {
    if (typeof window === "undefined") return false;
    if (!("Notification" in window)) return false;
    const settings = loadChatAppSettings();
    return settings.browserNotificationsEnabled === true && Notification.permission === "granted";
}

/** Request notification permission from the browser. Returns true if granted. */
export async function requestNotificationPermission(): Promise<boolean> {
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;

    const result = await new Promise<NotificationPermission>((resolve) => {
        let settled = false;
        const finish = (permission: NotificationPermission) => {
            if (settled) return;
            settled = true;
            resolve(permission);
        };

        try {
            const request = Notification.requestPermission(finish);
            if (request && typeof request.then === "function") {
                request.then(finish).catch(() => finish(Notification.permission));
            }
        } catch {
            finish(Notification.permission);
        }

        window.setTimeout(() => finish(Notification.permission), 3000);
    });

    return result === "granted";
}

function constructNotification(title: string, payload: NotificationOptions): void {
    try {
        const notification = new Notification(title, payload);
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    } catch {
        // Android Chrome/Edge: "Illegal constructor" — handled by the SW path below.
    }
}

/**
 * Tell the server to fan this alert out through the native FCM channel.
 * This is deliberately independent from the browser-notification toggle: WebToApp
 * uses FCM for the Android system notification, while the toggle below controls
 * only Notification/ServiceWorker Web Push.
 */
function sendNativeFcmNotification(
    title: string,
    options?: { body?: string; icon?: string },
): void {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (!document.hidden) return;
    const body = options?.body?.trim();
    if (!body) return;

    void fetch("/api/push/fcm/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
        body: JSON.stringify({
            title,
            body,
            url: window.location.href,
        }),
    }).catch(() => undefined);
}

/**
 * Send a background notification when the page is hidden.
 *
 * Native FCM is attempted first and does not depend on the browser-notification
 * setting. Browser Notification / Service Worker delivery remains optional and
 * keeps the existing user-facing toggle.
 *
 * Android Chrome/Edge does NOT support the `new Notification()` constructor in
 * pages (throws Illegal constructor) — notifications there must go through the
 * service worker's showNotification(). We prefer the SW path everywhere and fall
 * back to the constructor (desktop / dev where the SW isn't registered).
 */
export function sendBrowserNotification(
    title: string,
    options?: { body?: string; icon?: string },
): void {
    if (typeof document === "undefined" || !document.hidden) return;

    // WebToApp/native path. The server only sends to FCM devices registered for
    // the current self-hosted/account identity, so no Supabase subscription is
    // required for this branch.
    sendNativeFcmNotification(title, options);

    // Existing browser notification path stays opt-in.
    if (!isNotificationEnabled()) return;

    const payload: NotificationOptions = {
        body: options?.body,
        icon: options?.icon || "/icon-192.png",
        tag: `ai-phone-${Date.now()}-${_notifCounter++}`,
    };

    if ("serviceWorker" in navigator) {
        // `ready` never rejects and may hang forever when no SW is registered
        // (dev mode) — race it with a short timeout, then fall back.
        const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 800));
        Promise.race([navigator.serviceWorker.ready, timeout])
            .then((registration) => {
                if (registration && typeof registration.showNotification === "function") {
                    return registration.showNotification(title, payload);
                }
                constructNotification(title, payload);
            })
            .catch(() => constructNotification(title, payload));
        return;
    }
    constructNotification(title, payload);
}
