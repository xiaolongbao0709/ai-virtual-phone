import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, type Dispatcher } from "undici";
import JSZip from "jszip";
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

    // NAI 返回 application/zip（ZIP 压缩包），里面是 image_0.png / image_1.png 等。
    // 需要解压取出第一张图再透传。老版本 NAI 可能直接返回 image/png，保留兼容。
    if (contentType.startsWith("image/")) {
      return new NextResponse(buffer, {
        status: 200,
        headers: { "Content-Type": contentType },
      });
    }

    if (contentType.includes("zip") || contentType.includes("octet-stream")) {
      try {
        const zip = await JSZip.loadAsync(buffer);
        // 找第一张图片文件（按文件名排序，image_0 优先）
        const imageFiles = Object.keys(zip.files)
          .filter(name => /\.(png|jpg|jpeg|webp)$/i.test(name))
          .sort();
        if (imageFiles.length === 0) {
          const fileList = Object.keys(zip.files).slice(0, 10).join(", ");
          return NextResponse.json(
            { error: `NAI 返回了 ZIP 但没有图片文件。内含: ${fileList}` },
            { status: 502 },
          );
        }
        const imageData = await zip.files[imageFiles[0]].async("nodebuffer");
        // 从文件名猜 MIME 类型
        const ext = (imageFiles[0].split(".").pop() || "png").toLowerCase();
        const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
        return new NextResponse(imageData, {
          status: 200,
          headers: { "Content-Type": mimeMap[ext] || "image/png" },
        });
      } catch (zipErr) {
        const msg = zipErr instanceof Error ? zipErr.message : String(zipErr);
        return NextResponse.json({ error: `NAI ZIP 解压失败：${msg}` }, { status: 502 });
      }
    }

    const text = buffer.toString("utf-8");
    return NextResponse.json(
      { error: `NAI 返回了未预期的响应类型 (${contentType || "unknown"}): ${text.slice(0, 300)}` },
      { status: 502 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `NAI 请求失败：${message}` }, { status: 502 });
  }
}
