// iPhone 快捷指令结果入口（Supabase Edge Function 版）
// 部署：Dashboard → Edge Functions → 新建函数 push-shortcut-result → 粘贴本文件 →
//      关闭 JWT 校验。每条命令使用独立 callback_token 校验，无需 Supabase Auth。
// 职责：接收文本/图片结果；图片直接写入私有 Storage；向网页提供带票据的临时读取与清理。

type ShortcutCommandStatus = "pending" | "claimed" | "succeeded" | "failed" | "expired" | "cancelled";

type ShortcutCommandRow = {
  id: string;
  user_id: string;
  callback_token: string;
  result_mode: "none" | "text" | "image";
  status: ShortcutCommandStatus;
  result: unknown;
  error: string | null;
  expires_at: string;
};

const SHORTCUT_MEDIA_BUCKET = "shortcut-command-media";
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const CALLBACK_TOKEN_PATTERN = /^[a-f0-9]{32}$/i;
const COMMAND_ID_PATTERN = /^cmd_[a-z0-9-]{20,80}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function detectImage(bytes: Uint8Array, declared: string): { mime: string; extension: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", extension: "png" };
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }
  if (declared === "image/jpeg" || declared === "image/jpg") return { mime: "image/jpeg", extension: "jpg" };
  if (declared === "image/png") return { mime: "image/png", extension: "png" };
  if (declared === "image/webp") return { mime: "image/webp", extension: "webp" };
  return null;
}

function validStoragePath(result: unknown, userId: string, commandId: string): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const path = cleanText((result as Record<string, unknown>).storagePath, 300);
  const prefix = `${userId}/${commandId}.`;
  return path.startsWith(prefix) && /\.(?:jpg|png|webp)$/.test(path) ? path : "";
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return empty(204);

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "missing env" }, 503);

  const url = new URL(request.url);
  const commandId = cleanText(url.searchParams.get("command"), 100);
  const ticket = cleanText(url.searchParams.get("ticket"), 64);
  if (!COMMAND_ID_PATTERN.test(commandId) || !CALLBACK_TOKEN_PATTERN.test(ticket)) {
    return json({ ok: false, error: "结果地址无效。" }, 403);
  }

  const restHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });
  const storage = (path: string, init?: RequestInit) => fetch(
    `${supabaseUrl}/storage/v1/object/${SHORTCUT_MEDIA_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      ...init,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        ...(init?.headers ?? {}),
      },
    },
  );

  try {
    const selected = await rest(
      `push_shortcut_commands?id=eq.${encodeURIComponent(commandId)}`
      + `&callback_token=eq.${encodeURIComponent(ticket)}`
      + "&select=id,user_id,callback_token,result_mode,status,result,error,expires_at&limit=1",
    );
    if (!selected.ok) return json({ ok: false, error: "命令读取失败。" }, 500);
    const rows = await selected.json() as ShortcutCommandRow[];
    const command = rows[0];
    if (!command) return json({ ok: false, error: "命令不存在或结果地址已失效。" }, 404);

    if (request.method === "GET" && url.searchParams.get("download") === "1") {
      if (command.status !== "succeeded" || command.result_mode !== "image") {
        return json({ ok: false, error: "图片尚未就绪。" }, 409);
      }
      const path = validStoragePath(command.result, command.user_id, command.id);
      if (!path) return json({ ok: false, error: "图片不存在。" }, 404);
      const file = await storage(path);
      if (!file.ok || !file.body) return json({ ok: false, error: "图片读取失败。" }, file.status || 404);
      return new Response(file.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": file.headers.get("content-type") || "image/jpeg",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (request.method === "DELETE") {
      const path = validStoragePath(command.result, command.user_id, command.id);
      if (path) await storage(path, { method: "DELETE" }).catch(() => undefined);
      return json({ ok: true });
    }

    const now = new Date();
    if (Date.parse(command.expires_at) <= now.getTime()) {
      if (command.status === "pending" || command.status === "claimed") {
        await rest(
          `push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}`
          + `&callback_token=eq.${encodeURIComponent(ticket)}&status=in.(pending,claimed)`,
          { method: "PATCH", body: JSON.stringify({ status: "expired", updated_at: now.toISOString() }) },
        ).catch(() => undefined);
      }
      return json({ ok: false, error: "结果地址已过期。" }, 410);
    }

    const wakeContinuation = async () => {
      const filter = `push_jobs?user_id=eq.${encodeURIComponent(command.user_id)}`
        + `&trigger_key=eq.${encodeURIComponent(`shortcut:${command.id}`)}`
        + "&kind=eq.shortcut_resume&status=eq.pending";
      const selected = await rest(`${filter}&select=id,result_note`).catch(() => null);
      const jobs = selected?.ok
        ? await selected.json().catch(() => []) as Array<{ id?: unknown; result_note?: unknown }>
        : [];
      const updatedAt = new Date().toISOString();
      await Promise.all(jobs.map(job => {
        const id = cleanText(job.id, 100);
        if (!id) return Promise.resolve();
        // 纯云端动作不存在前台抢跑，结果回来即可生成第二轮；前台创建的
        // 续跑仍保留 30 秒接管窗口，避免网页与云端同时生成两份回复。
        const cloudGenerated = job.result_note === "cloud_shortcut_resume";
        return rest(`push_jobs?id=eq.${encodeURIComponent(id)}&status=eq.pending`, {
          method: "PATCH",
          body: JSON.stringify({
            execute_at: new Date(Date.now() + (cloudGenerated ? 0 : 30_000)).toISOString(),
            updated_at: updatedAt,
          }),
        }).then(() => undefined).catch(() => undefined);
      }));
    };

    if (command.status === "succeeded" || command.status === "failed") {
      await wakeContinuation();
      return empty(204);
    }
    if (command.status !== "pending" && command.status !== "claimed") {
      return json({ ok: false, error: `命令状态：${command.status}` }, 409);
    }
    if (request.method !== "POST" && request.method !== "GET") return empty(405);

    if (command.result_mode === "image") {
      if (request.method !== "POST") return json({ ok: false, error: "图片必须使用 POST 上传。" }, 405);
      const declaredLength = Number(request.headers.get("content-length")) || 0;
      if (declaredLength > MAX_MEDIA_BYTES) return json({ ok: false, error: "图片超过 8MB，请先压缩。" }, 413);
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_MEDIA_BYTES) {
        return json({ ok: false, error: buffer.byteLength === 0 ? "没有收到图片文件。" : "图片超过 8MB，请先压缩。" }, 413);
      }
      const bytes = new Uint8Array(buffer);
      const image = detectImage(bytes, (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase());
      if (!image) return json({ ok: false, error: "只支持 JPEG、PNG 或 WebP 图片。" }, 415);

      const storagePath = `${command.user_id}/${command.id}.${image.extension}`;
      const uploaded = await storage(storagePath, {
        method: "POST",
        headers: { "Content-Type": image.mime, "x-upsert": "true" },
        body: buffer,
      });
      if (!uploaded.ok) {
        const detail = await uploaded.text().catch(() => "");
        return json({ ok: false, error: detail || "图片存储失败。" }, uploaded.status);
      }

      const mediaUrl = new URL(`${supabaseUrl}/functions/v1/push-shortcut-result`);
      mediaUrl.searchParams.set("command", command.id);
      mediaUrl.searchParams.set("ticket", ticket);
      mediaUrl.searchParams.set("download", "1");
      const result = {
        text: "快捷指令已回传图片。",
        mediaUrl: mediaUrl.toString(),
        mediaType: "image",
        mimeType: image.mime,
        storagePath,
      };
      const completed = await rest(
        `push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}`
        + `&callback_token=eq.${encodeURIComponent(ticket)}&status=in.(pending,claimed)&select=id`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            status: "succeeded",
            result,
            completed_at: now.toISOString(),
            updated_at: now.toISOString(),
          }),
        },
      );
      const completedRows = completed.ok ? await completed.json() as { id: string }[] : [];
      if (!completedRows[0]) {
        await storage(storagePath, { method: "DELETE" }).catch(() => undefined);
        return json({ ok: false, error: "命令状态已经变化。" }, 409);
      }
      await wakeContinuation();
      return json({ ok: true, commandId: command.id, mediaUrl: mediaUrl.toString(), mimeType: image.mime });
    }

    const failed = url.searchParams.get("status") === "failed";
    let resultText = cleanText(url.searchParams.get("result"), 8000);
    let error = cleanText(url.searchParams.get("errorMessage"), 1000);
    if (request.method === "POST") {
      const declaredLength = Number(request.headers.get("content-length")) || 0;
      if (declaredLength > 16_000) return empty(413);
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        resultText = cleanText(body.text ?? body.result, 8000);
        error = cleanText(body.error, 1000);
      } else {
        resultText = cleanText(await request.text(), 8000);
      }
    }
    const status: ShortcutCommandStatus = failed ? "failed" : "succeeded";
    const completed = await rest(
      `push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}`
      + `&callback_token=eq.${encodeURIComponent(ticket)}&status=in.(pending,claimed)&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status,
          result: failed ? null : {
            text: command.result_mode === "none" ? "邮件自动化已执行。" : (resultText || "快捷指令已执行。"),
          },
          error: failed ? (error || "快捷指令执行失败。") : null,
          completed_at: now.toISOString(),
          updated_at: now.toISOString(),
        }),
      },
    );
    const completedRows = completed.ok ? await completed.json() as { id: string }[] : [];
    if (!completedRows[0]) return empty(409);
    await wakeContinuation();
    return empty(204);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
