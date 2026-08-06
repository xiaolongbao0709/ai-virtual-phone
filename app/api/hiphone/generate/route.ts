import { NextRequest, NextResponse } from "next/server";
import {
    runNovelAIImageGeneration,
    runGoogleImagenImageGeneration,
    runImageGeneration,
    type ImageGenerationRequest,
} from "../../image-generation/route";

export const maxDuration = 120;

function validateToken(req: NextRequest): boolean {
    const expectedToken = process.env.HIPHONE_API_TOKEN;
    if (!expectedToken) return true; // 未配置 token 时允许所有请求
    const auth = req.headers.get("authorization") || "";
    return auth === `Bearer ${expectedToken}`;
}

export async function POST(req: NextRequest) {
    if (!validateToken(req)) {
        return NextResponse.json({ error: "未授权：token 无效" }, { status: 401 });
    }

    let input: ImageGenerationRequest;
    try {
        input = await req.json() as ImageGenerationRequest;
    } catch {
        return NextResponse.json({ error: "请求体不是有效 JSON" }, { status: 400 });
    }

    if (!input.prompt) {
        return NextResponse.json({ error: "prompt 参数必填" }, { status: 400 });
    }

    try {
        let result: { status: number; body: Record<string, unknown> };

        if (input.provider === "novelai") {
            result = await runNovelAIImageGeneration(input);
        } else if (input.provider === "google-imagen") {
            result = await runGoogleImagenImageGeneration(input);
        } else {
            result = await runImageGeneration(input);
        }

        return NextResponse.json(result.body, { status: result.status });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 502 });
    }
}
