import { NextResponse } from "next/server";

import { formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { cleanText, generateQueryCode, VERIFY_BUCKET, type VerificationRequestRow } from "@/lib/server/verification";
import { VERIFY_APPLICATIONS_CLOSED_MESSAGE, VERIFY_APPLICATIONS_OPEN } from "@/lib/verification-availability";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

// 尽力而为的同实例节流（Serverless 实例间不共享，仅挡住最粗暴的连点）。
const recentByIp = new Map<string, number>();
const THROTTLE_MS = 60 * 1000;

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || "unknown";
}

function extensionForType(type: string): string {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return "jpg";
}

export async function POST(request: Request) {
  try {
    if (!VERIFY_APPLICATIONS_OPEN) {
      return NextResponse.json({ ok: false, error: VERIFY_APPLICATIONS_CLOSED_MESSAGE }, { status: 503 });
    }

    const config = getSupabaseServerConfig();
    if (!config) return NextResponse.json({ ok: false, error: "服务端 Supabase 未配置。" }, { status: 503 });

    const ip = clientIp(request);
    const last = recentByIp.get(ip) || 0;
    if (Date.now() - last < THROTTLE_MS) {
      return NextResponse.json({ ok: false, error: "提交太频繁了，请一分钟后再试。" }, { status: 429 });
    }

    const formData = await request.formData();
    const contact = cleanText(formData.get("contact"), 120);
    const file = formData.get("file");

    if (!contact) {
      return NextResponse.json({ ok: false, error: "请填写小红书昵称（便于审核时对上号）。" }, { status: 400 });
    }
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ ok: false, error: "请上传一张证明图片。" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ ok: false, error: "只支持 JPG、PNG、WebP 图片。" }, { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ ok: false, error: "图片过大，请压缩到 4MB 以内。" }, { status: 400 });
    }

    const queryCode = generateQueryCode();
    const imagePath = `requests/${queryCode}.${extensionForType(file.type)}`;
    const bytes = await file.arrayBuffer();

    const upload = await fetch(`${config.url}/storage/v1/object/${VERIFY_BUCKET}/${imagePath}`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": file.type,
        "x-upsert": "true",
      },
      body: bytes,
    });
    if (!upload.ok) {
      let message = (await upload.text()) || upload.statusText;
      try {
        const parsed = JSON.parse(message) as { message?: string; error?: string };
        message = parsed.message || parsed.error || message;
      } catch { /* 保留原始文本 */ }
      if (/bucket/i.test(message)) {
        message = "审核图片存储桶尚未创建：请先在 Supabase SQL Editor 执行 docs/verify-supabase.sql。";
      }
      return NextResponse.json({ ok: false, error: message }, { status: 502 });
    }

    const inserted = await supabaseRestFetch<VerificationRequestRow[]>("verification_requests", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ query_code: queryCode, contact, image_path: imagePath }),
    });
    if (!inserted.ok) {
      return NextResponse.json({ ok: false, error: formatSupabaseRestError(inserted.error) }, { status: 502 });
    }

    recentByIp.set(ip, Date.now());
    if (recentByIp.size > 2000) recentByIp.clear();

    return NextResponse.json({ ok: true, queryCode });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: 500 });
  }
}
