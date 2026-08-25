import { NextResponse } from "next/server";
import { saveSubscription, deleteSubscription } from "@/lib/server/web-push";

export async function POST(request: Request) {
    try {
        const subscription = await request.json();

        if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
            return NextResponse.json(
                { error: "Invalid push subscription structure" },
                { status: 400 },
            );
        }

        const ok = await saveSubscription({
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth
            }
        });

        if (!ok) {
            return NextResponse.json(
                { error: "Failed to save subscription" },
                { status: 500 },
            );
        }

        console.log("[Push] subscription registered:", subscription.endpoint);
        return NextResponse.json({ ok: true });
    } catch {
        return NextResponse.json(
            { error: "Invalid request" },
            { status: 400 },
        );
    }
}

export async function DELETE(request: Request) {
    try {
        const { endpoint } = await request.json();

        if (!endpoint) {
            return NextResponse.json(
                { error: "Missing endpoint" },
                { status: 400 },
            );
        }

        const ok = await deleteSubscription(endpoint);

        if (!ok) {
            return NextResponse.json(
                { error: "Failed to delete subscription" },
                { status: 500 },
            );
        }

        console.log("[Push] subscription deleted:", endpoint);
        return NextResponse.json({ ok: true });
    } catch {
        return NextResponse.json(
            { error: "Invalid request" },
            { status: 400 },
        );
    }
}
