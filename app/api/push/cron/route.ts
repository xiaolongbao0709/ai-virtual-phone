import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const token = process.env.CLIENT_TOKEN;

  if (!token || auth !== `Bearer ${token}`) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Cron endpoint is working",
  });
}
