import { NextResponse } from "next/server";
import { broadcastPushNotification } from "@/lib/server/web-push";

export async function POST(request: Request) {
    try {
        // Simple authentication check
        const auth = request.headers.get("authorization");
        const token = process.env.CLIENT_TOKEN;

        if (token && auth !== `Bearer ${token}`) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 },
            );
        }

        const { title, body, icon, badge, tag, url } = await request.json();

        if (!title || !body) {
            return NextResponse.json(
                { error: "Missing title or body" },
                { status: 400 },
            );
        }

        const result = await broadcastPushNotification({
            title,
            body,
            icon: icon || "/icon-192.png",
            badge: badge || "/icon-192.png",
            tag,
            url
        });

        return NextResponse.json({
            ok: true,
            ...result
        });
    } catch (error: any) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Invalid request" },
            { status: 500 },
        );
    }
}
