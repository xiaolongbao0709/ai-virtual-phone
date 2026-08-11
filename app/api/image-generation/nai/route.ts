import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, type Dispatcher } from "undici";
import { NOVELAI_ENDPOINT, buildNovelAiRequestBody } from "@/lib/novelai-adapter";

// NAI 官方生图接口是逆向协议、无正式文档，单张耗时通常 30~90 秒。
export const maxDuration = 120;

type NovelAiProxyRequest = {
  token?: string;
  prompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  negativePrompt?: string;
};

function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

export async function POST(req: NextRequest) {
  let input: NovelAiProxyRequest;
  try {
    input = await req.json() as NovelAiProxyRequest;
  } catch {
    return NextResponse.json({ error: "请求体不是有效 JSON" }, { status: 400 });
  }

  const token = input.token?.trim();
  const model = input.model?.trim();
  const prompt = input.prompt?.trim();
  if (!token) {
    return NextResponse.json({ error: "缺少 NAI token（生图设置的 API Key 填 NAI 网站的 Persistent Token）" }, { status: 400 });
  }
  if (!model) return NextResponse.json({ error: "缺少模型名" }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: "缺少提示词" }, { status: 400 });

  const body = buildNovelAiRequestBody({
    model,
    prompt,
    size: input.size,
    quality: input.quality,
    negativePrompt: input.negativePrompt,
  });

  try {
    const dispatcher = getProxyDispatcher();
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(110_000),
    };
    if (dispatcher) init.dispatcher = dispatcher;

    const res = await fetch(NOVELAI_ENDPOINT, init);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const buffer = Buffer.from(await res.arrayBuffer());

    if (!res.ok) {
      let message = `NAI 生图失败 ${res.status}`;
      try {
        const text = buffer.toString("utf-8");
        const json = JSON.parse(text) as { message?: string; error?: string };
        if (typeof json.message === "string" && json.message) message += `: ${json.message}`;
        else if (typeof json.error === "string" && json.error) message += `: ${json.error}`;
        else if (text) message += `: ${text.slice(0, 300)}`;
      } catch {
        // 非 JSON 响应体，保持通用错误信息
      }
      return NextResponse.json({ error: message }, { status: 502 });
    }

    if (contentType.startsWith("image/")) {
      // 直接把图片二进制透传回去，产品端现有解析逻辑能识别 image/* 响应。
      return new NextResponse(buffer, {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    }

    const text = buffer.toString("utf-8");
    return NextResponse.json(
      { error: `NAI 返回了非图片响应 (${contentType || "unknown"}): ${text.slice(0, 300)}` },
      { status: 502 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `NAI 请求失败：${message}` }, { status: 502 });
  }
}
