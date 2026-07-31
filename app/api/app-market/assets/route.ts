import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { formatSupabaseRestError, getSupabaseServerConfig } from "@/lib/server/supabase-rest";
import type { CustomAppPackageKind } from "@/lib/custom-app-market-types";

const CUSTOM_APP_PACKAGE_BUCKET = "custom-app-market-packages";
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "app.zip";
}

function detectPackageKind(file: File): CustomAppPackageKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".floatapp")) return "floatapp";
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
  return null;
}

function contentTypeForKind(kind: CustomAppPackageKind): string {
  if (kind === "html") return "text/html;charset=utf-8";
  return "application/zip";
}

export async function POST(request: Request) {
  try {
    const config = getSupabaseServerConfig();
    if (!config) return NextResponse.json({ ok: false, error: "missing_supabase_env" }, { status: 503 });
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "missing_app_package_file" }, { status: 400 });
    }
    const kind = detectPackageKind(file);
    if (!kind) {
      return NextResponse.json({ ok: false, error: "只支持 .zip、.html 应用包；旧 .floatapp 包仍可兼容导入。" }, { status: 400 });
    }
    if (file.size > MAX_PACKAGE_BYTES) {
      return NextResponse.json({ ok: false, error: "应用包过大，请控制在 5MB 以内。" }, { status: 400 });
    }

    const ownerPath = safeFilename(account.id);
    const baseName = safeFilename(cleanText(file.name, 120));
    const path = `${ownerPath}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${baseName}`;
    const bytes = await file.arrayBuffer();
    const hash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    const upload = await fetch(`${config.url}/storage/v1/object/${CUSTOM_APP_PACKAGE_BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": contentTypeForKind(kind),
        "x-upsert": "true",
      },
      body: bytes,
    });
    const text = await upload.text();
    if (!upload.ok) {
      let message = text || upload.statusText;
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string };
        message = parsed.message || parsed.error || message;
      } catch {
        // ignore non-json storage errors
      }
      if (/bucket/i.test(message)) {
        message = "自定义 APP 包存储桶尚未创建：请先在 Supabase SQL Editor 执行 docs/custom-app-market-supabase.sql。";
      }
      return NextResponse.json({ ok: false, error: message }, { status: upload.status });
    }

    const url = `${config.url}/storage/v1/object/public/${CUSTOM_APP_PACKAGE_BUCKET}/${path}`;
    return NextResponse.json({ ok: true, url, path, kind, size: file.size, hash });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: getSupabaseServerConfig() ? 400 : 503 });
  }
}
