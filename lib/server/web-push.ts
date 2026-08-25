import fs from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";
import { getSupabaseServerConfig, supabaseRestFetch } from "./supabase-rest";

const SUBSCRIPTIONS_FILE = path.join(process.cwd(), "push-subscriptions.json");

// Configure VAPID details
const publicKey = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (publicKey && privateKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
} else {
    console.warn("[Push] VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is not configured. Web Push notifications will fail to send.");
}

export type PushSubscriptionKeys = {
    p256dh: string;
    auth: string;
};

export type PushSubscriptionData = {
    endpoint: string;
    keys: PushSubscriptionKeys;
};

export async function getSubscriptions(): Promise<PushSubscriptionData[]> {
    const supabaseConfig = getSupabaseServerConfig();
    if (supabaseConfig) {
        const res = await supabaseRestFetch<any[]>("push_subscriptions?select=*");
        if (res.ok && Array.isArray(res.data)) {
            return res.data.map(item => ({
                endpoint: item.endpoint,
                keys: {
                    p256dh: item.keys_p256dh,
                    auth: item.keys_auth
                }
            }));
        }
        console.warn("[Push] Supabase read failed, falling back to local file:", res.error);
    }

    try {
        const data = await fs.readFile(SUBSCRIPTIONS_FILE, "utf-8");
        return JSON.parse(data);
    } catch {
        return [];
    }
}

export async function saveSubscription(subscription: PushSubscriptionData): Promise<boolean> {
    const supabaseConfig = getSupabaseServerConfig();
    if (supabaseConfig) {
        const res = await supabaseRestFetch("push_subscriptions", {
            method: "POST",
            headers: {
                "Prefer": "resolution=merge-duplicates",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                endpoint: subscription.endpoint,
                keys_p256dh: subscription.keys?.p256dh || "",
                keys_auth: subscription.keys?.auth || "",
                updated_at: new Date().toISOString()
            })
        });
        if (res.ok) return true;
        console.warn("[Push] Supabase upsert failed, falling back to local file:", res.error);
    }

    try {
        let subs: PushSubscriptionData[] = [];
        try {
            const data = await fs.readFile(SUBSCRIPTIONS_FILE, "utf-8");
            subs = JSON.parse(data);
        } catch {}

        // Remove duplicate endpoints
        subs = subs.filter(s => s.endpoint !== subscription.endpoint);
        subs.push(subscription);

        await fs.writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2), "utf-8");
        return true;
    } catch (err) {
        console.error("[Push] Failed to write local subscription file:", err);
        return false;
    }
}

export async function deleteSubscription(endpoint: string): Promise<boolean> {
    const supabaseConfig = getSupabaseServerConfig();
    if (supabaseConfig) {
        const res = await supabaseRestFetch(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
            method: "DELETE"
        });
        if (res.ok) return true;
        console.warn("[Push] Supabase delete failed, falling back to local file:", res.error);
    }

    try {
        let subs: PushSubscriptionData[] = [];
        try {
            const data = await fs.readFile(SUBSCRIPTIONS_FILE, "utf-8");
            subs = JSON.parse(data);
        } catch {}

        subs = subs.filter(s => s.endpoint !== endpoint);
        await fs.writeFile(SUBSCRIPTIONS_FILE, JSON.stringify(subs, null, 2), "utf-8");
        return true;
    } catch (err) {
        console.error("[Push] Failed to delete local subscription:", err);
        return false;
    }
}

export type NotificationPayload = {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    tag?: string;
    url?: string;
};

export async function sendPushNotification(subscription: PushSubscriptionData, payload: NotificationPayload): Promise<boolean> {
    if (!publicKey || !privateKey) {
        console.error("[Push] Cannot send notification: VAPID keys not configured.");
        return false;
    }

    try {
        const pushSubscriptionObj = {
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth
            }
        };

        await webpush.sendNotification(pushSubscriptionObj, JSON.stringify(payload));
        return true;
    } catch (error: any) {
        // If subscription has expired or is invalid, remove it
        if (error.statusCode === 410 || error.statusCode === 404) {
            console.warn(`[Push] Subscription expired or invalid (status ${error.statusCode}). Deleting...`);
            await deleteSubscription(subscription.endpoint);
        } else {
            console.error("[Push] Error sending push notification:", error);
        }
        return false;
    }
}

export async function broadcastPushNotification(payload: NotificationPayload): Promise<{ success: number; failed: number }> {
    const subscriptions = await getSubscriptions();
    let success = 0;
    let failed = 0;

    const promises = subscriptions.map(async (sub) => {
        const ok = await sendPushNotification(sub, payload);
        if (ok) success++;
        else failed++;
    });

    await Promise.all(promises);
    return { success, failed };
}
