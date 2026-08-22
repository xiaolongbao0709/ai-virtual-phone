import { NextResponse } from "next/server";

export async function POST(request: Request) {
    try {
        const subscription = await request.json();

        if (!subscription?.endpoint) {
            return NextResponse.json(
                { error: "Invalid push subscription" },
                { status: 400 },
            );
        }

        console.log("[Push] subscription received:", subscription.endpoint);

        return NextResponse.json({ ok: true });
    } catch {
        return NextResponse.json(
            { error: "Invalid request" },
            { status: 400 },
        );
    }
}
