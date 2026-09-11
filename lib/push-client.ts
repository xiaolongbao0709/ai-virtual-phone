// 离线推送（Web Push）客户端：订阅/退订/状态查询。
// 前提：主屏幕 PWA（iOS 16.4+）或支持 Push API 的浏览器，且已登录账号。

import { requestNotificationPermission } from "./browser-notification";
import { kvGet, kvRemove, kvSet } from "./kv-db";
import {
    isPersonalPushCloudActive,
    personalPushFetch,
    PERSONAL_PUSH_SW_SCOPE,
} from "./personal-push-cloud";

export type OfflinePushState = "unsupported" | "off" | "on";

// ── 订阅门控：账号没有任何推送订阅时，兜底预约/心跳完全不发起，不产生任何请求 ──

const PUSH_GATE_KV = "push_account_subscribed_v1";
const PUSH_GATE_TTL_MS = 24 * 60 * 60 * 1000;

/** 手动刷新门控缓存（开启推送 → true；关闭 → null 强制下次重查，因为其他设备可能还订着）。 */
export function markAccountPushSubscribed(value: boolean | null): void {
    if (typeof window === "undefined") return;
    if (value === null) kvRemove(PUSH_GATE_KV);
    else kvSet(PUSH_GATE_KV, JSON.stringify({ subscribed: value, checkedAt: Date.now() }));
}

// ── 推送安静时段：时段内不挂"角色主动"类兜底（追问/定时唤醒/经期关怀），
//    不影响"回复你消息"的兜底。格式 "23:00-08:00"，空 = 不启用 ──

const QUIET_HOURS_KV = "push_quiet_hours_v1";

export function loadPushQuietHours(): string {
    if (typeof window === "undefined") return "";
    return (kvGet(QUIET_HOURS_KV) || "").trim();
}

export function savePushQuietHours(value: string): void {
    if (typeof window === "undefined") return;
    const trimmed = value.trim();
    if (trimmed) kvSet(QUIET_HOURS_KV, trimmed);
    else kvRemove(QUIET_HOURS_KV);
}

/** 某个时间点是否落在安静时段内（支持跨零点，如 23:00-08:00）。格式非法视为未启用。 */
export function isWithinPushQuietHours(atMs: number): boolean {
    const setting = loadPushQuietHours();
    const match = setting.match(/^(\d{1,2}):(\d{2})\s*[-~—]\s*(\d{1,2}):(\d{2})$/);
    if (!match) return false;
    const startMinutes = Number(match[1]) * 60 + Number(match[2]);
    const endMinutes = Number(match[3]) * 60 + Number(match[4]);
    if (startMinutes === endMinutes) return false;
    const date = new Date(atMs);
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    return startMinutes < endMinutes
        ? nowMinutes >= startMinutes && nowMinutes < endMinutes
        : nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/** 同步读门控缓存：true/false=有效缓存值，null=未知（未查过或已过期）。 */
export function peekAccountPushSubscribed(): boolean | null {
    if (typeof window === "undefined") return false;
    try {
        const cached = kvGet(PUSH_GATE_KV);
        if (!cached) return null;
        const parsed = JSON.parse(cached) as { subscribed?: boolean; checkedAt?: number };
        if (typeof parsed.subscribed !== "boolean") return null;
        if (Date.now() - (parsed.checkedAt ?? 0) >= PUSH_GATE_TTL_MS) return null;
        return parsed.subscribed;
    } catch {
        return null;
    }
}

/** 当前账号（任意设备）是否有推送订阅。结果缓存 24 小时。 */
export async function hasAccountPushSubscription(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    try {
        const cached = kvGet(PUSH_GATE_KV);
        if (cached) {
            const parsed = JSON.parse(cached) as { subscribed?: boolean; checkedAt?: number };
            if (typeof parsed.subscribed === "boolean" && Date.now() - (parsed.checkedAt ?? 0) < PUSH_GATE_TTL_MS) {
                return parsed.subscribed;
            }
        }
    } catch {
        // fall through to refetch
    }
    try {
        const response = isPersonalPushCloudActive()
            ? await personalPushFetch("status")
            : await fetch("/api/push/status", { credentials: "include" });
        if (!response.ok) return false;
        const data = await response.json().catch(() => ({})) as { ok?: boolean; subscribed?: boolean };
        const subscribed = data.ok === true && data.subscribed === true;
        markAccountPushSubscribed(subscribed);
        return subscribed;
    } catch {
        return false;
    }
}

/** 是否运行在安卓壳（FloatShell App）的 WebView 里。壳自带长连接推送通道，不走 Web Push。 */
export function isShellEnvironment(): boolean {
    return typeof navigator !== "undefined" && navigator.userAgent.includes("FloatShell/");
}

function isPushSupported(): boolean {
    return typeof window !== "undefined"
        && "serviceWorker" in navigator
        && "PushManager" in window
        && "Notification" in window;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const output = new Uint8Array(new ArrayBuffer(rawData.length));
    for (let i = 0; i < rawData.length; i += 1) {
        output[i] = rawData.charCodeAt(i);
    }
    return output;
}

/** `navigator.serviceWorker.ready` 在 SW 未注册时（开发环境）会永远挂起——加超时。 */
async function getReadyRegistration(timeoutMs: number): Promise<ServiceWorkerRegistration | null> {
    if (!("serviceWorker" in navigator)) return null;
    const timeout = new Promise<null>(resolve => window.setTimeout(() => resolve(null), timeoutMs));
    try {
        return await Promise.race([navigator.serviceWorker.ready, timeout]);
    } catch {
        return null;
    }
}

async function getPersonalPushRegistration(create: boolean): Promise<ServiceWorkerRegistration | null> {
    if (!("serviceWorker" in navigator)) return null;
    try {
        const existing = await navigator.serviceWorker.getRegistration(PERSONAL_PUSH_SW_SCOPE);
        // 这个 scope 下没有任何页面，浏览器不会自发做 SW 更新检查；不主动 update
        // 的话，已部署用户的通知点击逻辑会永远停在旧版脚本上。
        if (existing) await existing.update().catch(() => undefined);
        const registration = existing || (create
            ? await navigator.serviceWorker.register("/personal-push-sw.js", { scope: PERSONAL_PUSH_SW_SCOPE })
            : null);
        if (!registration) return null;
        const worker = registration.installing || registration.waiting;
        if (!worker) return registration;
        await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, 4000);
            worker.addEventListener("statechange", () => {
                if (worker.state === "activated" || worker.state === "redundant") {
                    window.clearTimeout(timer);
                    resolve();
                }
            });
        });
        return registration;
    } catch {
        return null;
    }
}

async function subscribeRegistration(
    registration: ServiceWorkerRegistration,
    publicKey: string,
): Promise<PushSubscription | null> {
    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    let subscription = await registration.pushManager.getSubscription().catch(() => null);
    if (subscription) {
        const boundKey = subscription.options?.applicationServerKey;
        const bound = boundKey ? new Uint8Array(boundKey as ArrayBuffer) : null;
        const matches = bound !== null
            && bound.length === applicationServerKey.length
            && bound.every((byte, index) => byte === applicationServerKey[index]);
        if (!matches) {
            await subscription.unsubscribe().catch(() => undefined);
            subscription = null;
        }
    }
    if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    }
    return subscription;
}

/** 给个人 Supabase 建立独立 SW 订阅；主 PWA 订阅保留给现实桥/快捷指令，互不覆盖。 */
export async function ensurePersonalPushSubscription(): Promise<{ ok: boolean; error?: string }> {
    if (!isPersonalPushCloudActive()) return { ok: false, error: "个人离线推送尚未启用。" };
    const registration = await getPersonalPushRegistration(true);
    if (!registration) return { ok: false, error: "个人推送 Service Worker 注册失败。" };
    try {
        const keyResponse = await personalPushFetch("public-key");
        const keyData = await keyResponse.json().catch(() => ({})) as { ok?: boolean; publicKey?: string; error?: string };
        if (!keyResponse.ok || !keyData.ok || !keyData.publicKey) {
            return { ok: false, error: keyData.error || "个人推送公钥获取失败。" };
        }
        const subscription = await subscribeRegistration(registration, keyData.publicKey);
        if (!subscription) return { ok: false, error: "个人推送订阅创建失败。" };
        const saveResponse = await personalPushFetch("subscribe", {
            method: "POST",
            body: JSON.stringify(subscription.toJSON()),
        });
        const saveData = await saveResponse.json().catch(() => ({})) as { ok?: boolean; error?: string };
        if (!saveResponse.ok || !saveData.ok) return { ok: false, error: saveData.error || "个人推送订阅保存失败。" };
        markAccountPushSubscribed(true);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "个人推送订阅失败。" };
    }
}

export async function getOfflinePushState(): Promise<OfflinePushState> {
    if (!isPushSupported()) return "unsupported";
    if (isPersonalPushCloudActive()) {
        const personalRegistration = await getPersonalPushRegistration(false);
        if (!personalRegistration) return "off";
        const personalSubscription = await personalRegistration.pushManager.getSubscription().catch(() => null);
        return personalSubscription ? "on" : "off";
    }
    const registration = await getReadyRegistration(1500);
    if (!registration) return "unsupported";
    try {
        const subscription = await registration.pushManager.getSubscription();
        return subscription ? "on" : "off";
    } catch {
        return "off";
    }
}

export async function enableOfflinePush(): Promise<{ ok: boolean; error?: string }> {
    if (isShellEnvironment()) {
        return { ok: false, error: "App 版自带推送通道，无需在此开启；保持系统通知权限开启即可收到离线消息。" };
    }
    if (!isPushSupported()) {
        return { ok: false, error: "当前环境不支持系统推送。iOS 请先「添加到主屏幕」，再从主屏幕图标打开开启。" };
    }
    const granted = await requestNotificationPermission();
    if (!granted) {
        return { ok: false, error: "通知权限未授予。请在系统设置中允许通知后重试。" };
    }
    if (isPersonalPushCloudActive()) {
        return ensurePersonalPushSubscription();
    }
    const registration = await getReadyRegistration(4000);
    if (!registration) {
        return { ok: false, error: "Service Worker 未就绪，请刷新页面后重试（开发环境不可用）。" };
    }

    const keyResponse = await fetch("/api/push/public-key", { credentials: "include" }).catch(() => null);
    const keyData = keyResponse ? await keyResponse.json().catch(() => ({})) as { ok?: boolean; publicKey?: string; error?: string } : null;
    if (!keyData?.ok || !keyData.publicKey) {
        return { ok: false, error: keyData?.error || "推送服务连接失败。" };
    }
    const applicationServerKey = urlBase64ToUint8Array(keyData.publicKey);

    let subscription: PushSubscription | null = null;
    try {
        subscription = await registration.pushManager.getSubscription();
        // 老订阅可能绑着不同的服务器公钥（会导致推送服务 403 拒收）——比对后重订阅
        if (subscription) {
            const boundKey = subscription.options?.applicationServerKey;
            const bound = boundKey ? new Uint8Array(boundKey as ArrayBuffer) : null;
            const matches = bound !== null
                && bound.length === applicationServerKey.length
                && bound.every((byte, index) => byte === applicationServerKey[index]);
            if (!matches) {
                await subscription.unsubscribe().catch(() => undefined);
                subscription = null;
            }
        }
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        }
    } catch {
        // 旧订阅可能绑定了不同的服务器密钥——退订后重试一次。
        try {
            const stale = await registration.pushManager.getSubscription();
            if (stale) await stale.unsubscribe();
            subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        } catch (err) {
            void err;
            return { ok: false, error: "离线推送失败，可能是设备或浏览器不支持。" };
        }
    }
    if (!subscription) return { ok: false, error: "离线推送失败，可能是设备或浏览器不支持。" };

    const saveResponse = await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
    }).catch(() => null);
    const saveData = saveResponse ? await saveResponse.json().catch(() => ({})) as { ok?: boolean; error?: string } : null;
    if (!saveData?.ok) {
        return { ok: false, error: saveData?.error || "订阅保存失败。" };
    }
    markAccountPushSubscribed(true);
    return { ok: true };
}

export async function disableOfflinePush(): Promise<{ ok: boolean; error?: string }> {
    const registration = await getReadyRegistration(2000);
    const subscription = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
    if (subscription) {
        await fetch("/api/push/subscribe", {
            method: "DELETE",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => undefined);
        await subscription.unsubscribe().catch(() => undefined);
    }
    const personalRegistration = await getPersonalPushRegistration(false);
    const personalSubscription = personalRegistration
        ? await personalRegistration.pushManager.getSubscription().catch(() => null)
        : null;
    if (personalSubscription) {
        if (isPersonalPushCloudActive()) {
            await personalPushFetch("subscribe", {
                method: "DELETE",
                body: JSON.stringify({ endpoint: personalSubscription.endpoint }),
            }).catch(() => undefined);
        }
        await personalSubscription.unsubscribe().catch(() => undefined);
    }
    markAccountPushSubscribed(null);
    return { ok: true };
}

export async function sendTestOfflinePush(): Promise<{ ok: boolean; error?: string }> {
    const response = await (isPersonalPushCloudActive()
        ? personalPushFetch("test", { method: "POST" })
        : fetch("/api/push/test", { method: "POST", credentials: "include"}))
        .catch(() => null);
    if (!response) return { ok: false, error: "网络异常。" };
    const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!data.ok) return { ok: false, error: data.error || "发送失败。" };
    return { ok: true };
}
