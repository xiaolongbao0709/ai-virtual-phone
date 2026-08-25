// 屏幕速聊·同步问答入口（Supabase Edge Function 版）
// 部署：Dashboard → Edge Functions → 新建函数 screen-chat → 粘贴本文件 →
//      关闭 JWT 校验（快捷指令带不了自定义请求头，本函数凭 bridge_token 自校验）。
// 职责：iPhone 悬浮球快捷指令 POST 截图/屏幕文字/回复文本 → 读取「屏幕速聊」
//      prompt 快照（现实桥同步，payload_key 加密）→ 代入会话上下文与截图 →
//      调 LLM 生成角色回复并在本次请求内同步返回（快捷指令用「显示提醒」弹窗）→
//      以角色在小手机中的唯一 sessionId 为准，只暂存尚未回端的文字增量 → 每轮原子写
//      push_outbox(kind=bridge)，小手机打开时合并进原聊天记录。不持久化截图。
// 注意：自包含移植文件，改动共享逻辑时需同步 push-bridge / push-generate。

type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

// ── 内嵌：lib/llm-provider-adapter 的响应文本提取 ──
function stripHallucinatedTimestamps(text: string): string {
  return text
    .replace(/[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*/g, "")
    .replace(/\(system\s*time\s*[:：][^)]*\)\s*/gi, "");
}

function textFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
      if (typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function extractResponseText(providerKind: ProviderKind, data: unknown): string {
  if (providerKind === "anthropic") {
    const blocks = (data as { content?: unknown[] }).content;
    let text = "";
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const item = block as { type?: string; text?: string };
      if (item.type === "text") text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  if (providerKind === "gemini") {
    const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      const item = part as { text?: string; thought?: boolean; functionCall?: unknown };
      if (!item.functionCall && !item.thought) text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  const d = data as { choices?: Array<{ message?: { content?: unknown }; text?: string }>; output?: { text?: string }; response?: string };
  const messageText = textFromUnknownContent(d.choices?.[0]?.message?.content).trim();
  const text = messageText
    || (typeof d.choices?.[0]?.text === "string" ? d.choices[0].text.trim() : "")
    || (typeof d.output?.text === "string" ? d.output.text.trim() : "")
    || (typeof d.response === "string" ? d.response.trim() : "");
  return stripHallucinatedTimestamps(text);
}

// ── 内嵌：lib/push-preview-split 的弹窗预览分条（用于弹窗正文净化） ──
const RICH_MEDIA_NAMES = new Set(["红包", "转账", "照片", "位置", "表情包", "引用", "语音", "音乐"]);

function stripStateValues(text: string): string {
  const regex = /\[([^\[\]:：]+)[：:](\d+(?:\.\d+)?)\]/g;
  return text.replace(regex, (m, rawName: string) => {
    const name = rawName.trim();
    if (!name || /^\d+$/.test(name) || RICH_MEDIA_NAMES.has(name)) return m;
    return "";
  });
}

function stripBracketBlock(text: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)\\[\\/${escaped}\\]`, "g"), "");
}

function humanizeSegment(segment: string): string {
  const marker = segment.match(/^\[([^\][：:]{1,12})[：:]([\s\S]*?)\]$/);
  if (!marker) return segment;
  const kind = marker[1];
  if (/表情包/.test(kind)) return "[表情包]";
  if (/图片|照片|图片描述/.test(kind)) return `发了一张照片: ${marker[2].slice(0, 40)}`;
  if (/语音通话/.test(kind)) return "发起了语音通话";
  if (/视频通话/.test(kind)) return "发起了视频通话";
  if (/语音/.test(kind)) return "[语音]";
  if (/红包/.test(kind)) return "[红包]";
  if (/转账/.test(kind)) return "[转账]";
  if (/位置/.test(kind)) return "[位置]";
  if (/拍一拍|拍了拍/.test(kind)) return "拍了拍你";
  return segment;
}

function popupTextFromReply(rawText: string): string {
  let text = stripStateValues(rawText);
  text = stripBracketBlock(text, "状态栏");
  text = stripBracketBlock(text, "内心");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  const parts = text
    .split(/\n\n+/)
    .map(segment => humanizeSegment(segment.trim()))
    .map(segment => segment.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  return (parts.join("\n") || "……").slice(0, 1200);
}

// ── 内嵌：lib/server/push-job-crypto 的解密（Web Crypto 实现，格式兼容） ──
type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function decryptPayload(payload: EncryptedPayload, serviceKey: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${serviceKey}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const ct = base64ToBytes(payload.ct);
  const tag = base64ToBytes(payload.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) as unknown as BufferSource },
    key,
    combined as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

// ── 屏幕速聊约定（与 lib/push-bridge-shared.ts 保持一致） ──
/** 快照在 push_bridge_snapshots 里的保留 rule_id */
const SCREEN_CHAT_SNAPSHOT_ID = "screen-chat";
/** 快照请求体里的对话占位哨兵（客户端组装 prompt 时预埋；私有区字符包裹防撞） */
const SCREEN_CHAT_SENTINEL = "SCREEN_CHAT_TURNS_TEXT";
/** 服务端在对话文本里预留的截图插入位（替换成图片附件或屏幕文字） */
const IMAGE_MARKER = "SCREEN_CHAT_IMAGE_SLOT";

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_DAILY_CAP = 120;
const MAX_PENDING_TURNS = 500;

type ScreenSnapshot = {
  replyRequest?: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  enableVision?: boolean;
  ackSequence?: number;
  dailyCap?: number;
  chat?: { characterId?: string; sessionId?: string; characterName?: string };
  reply?: Record<string, unknown>;
};

type ScreenTurn = {
  sequence: number;
  role: "user" | "assistant";
  text: string;
  /** 该轮携带了屏幕内容（截图或屏幕文字） */
  screen?: boolean;
  /** 快捷指令本地 OCR 出的屏幕文字（视觉关闭或注图失败时代入 prompt） */
  ocr?: string;
  at: string;
};

type BeginResult = {
  status?: "ok" | "busy" | "daily_cap";
  pendingTurns?: unknown;
  nextSequence?: number;
  sessionId?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "86400",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** 把对话文本安全替换进序列化后的请求体 JSON（JSON 转义后再替换哨兵）。 */
function substituteSentinel(bodyJson: string, marker: string, text: string): string {
  const escaped = JSON.stringify(text).slice(1, -1);
  return bodyJson.split(marker).join(escaped);
}

/** 遍历替换请求体里所有字符串中的标记（无图时把截图插入位换成屏幕文字）。 */
function replaceMarkerInStrings(value: unknown, marker: string, replacement: string): void {
  if (!value || typeof value !== "object") return;
  const entries: Array<[Record<string, unknown> | unknown[], string | number]> = [];
  if (Array.isArray(value)) {
    value.forEach((_, index) => entries.push([value, index]));
  } else {
    Object.keys(value as Record<string, unknown>).forEach(key => entries.push([value as Record<string, unknown>, key]));
  }
  for (const [container, key] of entries) {
    const item = (container as Record<string | number, unknown>)[key];
    if (typeof item === "string" && item.includes(marker)) {
      (container as Record<string | number, unknown>)[key] = item.split(marker).join(replacement);
    } else {
      replaceMarkerInStrings(item, marker, replacement);
    }
  }
}

/** 把截图插入位替换成真正的图片附件：找到含标记的文本段，按 marker 一分为三。
 *  三种服务商的 message 结构不同，与 push-generate 的 injectShortcutImage 同思路，
 *  区别是这里的 marker 藏在整段文本内部而非独占一段。 */
function injectImageAtMarker(
  body: Record<string, unknown>,
  providerKind: ProviderKind,
  marker: string,
  image: { mimeType: string; base64: string },
): boolean {
  const splitText = (text: string): { before: string; after: string } | null => {
    const at = text.indexOf(marker);
    if (at < 0) return null;
    return { before: text.slice(0, at), after: text.slice(at + marker.length) };
  };

  if (providerKind === "anthropic") {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const record = message as { content?: unknown };
      // 简单文本消息的 content 是字符串：先升级成分段数组再注图
      if (typeof record.content === "string" && record.content.includes(marker)) {
        const split = splitText(record.content);
        if (!split) continue;
        record.content = [
          ...(split.before.trim() ? [{ type: "text", text: split.before }] : []),
          { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } },
          ...(split.after.trim() ? [{ type: "text", text: split.after }] : []),
        ];
        return true;
      }
      const content = record.content;
      if (!Array.isArray(content)) continue;
      const index = content.findIndex(part => typeof (part as { text?: unknown })?.text === "string"
        && ((part as { text: string }).text).includes(marker));
      if (index < 0) continue;
      const split = splitText((content[index] as { text: string }).text);
      if (!split) continue;
      content.splice(index, 1,
        ...(split.before.trim() ? [{ type: "text", text: split.before }] : []),
        { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } },
        ...(split.after.trim() ? [{ type: "text", text: split.after }] : []),
      );
      return true;
    }
  } else if (providerKind === "gemini") {
    for (const message of Array.isArray(body.contents) ? body.contents : []) {
      const parts = (message as { parts?: unknown[] }).parts;
      if (!Array.isArray(parts)) continue;
      const index = parts.findIndex(part => typeof (part as { text?: unknown })?.text === "string"
        && ((part as { text: string }).text).includes(marker));
      if (index < 0) continue;
      const split = splitText((parts[index] as { text: string }).text);
      if (!split) continue;
      parts.splice(index, 1,
        ...(split.before.trim() ? [{ text: split.before }] : []),
        { inlineData: { mimeType: image.mimeType, data: image.base64 } },
        ...(split.after.trim() ? [{ text: split.after }] : []),
      );
      return true;
    }
  } else {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const record = message as { content?: unknown };
      if (typeof record.content === "string" && record.content.includes(marker)) {
        const split = splitText(record.content);
        if (!split) continue;
        record.content = [
          ...(split.before.trim() ? [{ type: "text", text: split.before }] : []),
          { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "low" } },
          ...(split.after.trim() ? [{ type: "text", text: split.after }] : []),
        ];
        return true;
      }
      if (Array.isArray(record.content)) {
        const parts = record.content as Array<Record<string, unknown>>;
        const index = parts.findIndex(part => typeof part?.text === "string" && (part.text as string).includes(marker));
        if (index < 0) continue;
        const split = splitText(parts[index].text as string);
        if (!split) continue;
        parts.splice(index, 1,
          ...(split.before.trim() ? [{ type: "text", text: split.before }] : []),
          { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "low" } },
          ...(split.after.trim() ? [{ type: "text", text: split.after }] : []),
        );
        return true;
      }
    }
  }
  return false;
}

function normalizePendingTurns(value: unknown, acknowledged: number): ScreenTurn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const row = item && typeof item === "object" ? item as Partial<ScreenTurn> : {};
    const sequence = Number(row.sequence);
    const role = row.role === "user" || row.role === "assistant" ? row.role : null;
    if (!Number.isSafeInteger(sequence) || sequence <= acknowledged || !role) return [];
    const text = cleanText(row.text, 2000);
    const ocr = cleanText(row.ocr, 6000);
    return [{
      sequence,
      role,
      text,
      ...(row.screen === true ? { screen: true } : {}),
      ...(ocr ? { ocr } : {}),
      at: cleanText(row.at, 60) || new Date().toISOString(),
    } satisfies ScreenTurn];
  }).slice(-MAX_PENDING_TURNS);
}

/** 快照本身已有小手机的完整历史；这里只代入尚未回端的增量和当前屏幕。
 *  不按时间或轮数新开对话，也不把过去的截图写入数据库。 */
function buildTranscript(turns: ScreenTurn[], liveSequence: number, hasLiveImage: boolean): string {
  const lines: string[] = [
    "【屏幕速聊】用户正通过 iPhone 悬浮球和你进行即时弹窗对话：TA把当前手机屏幕发给了你，"
    + "你的回复会以系统弹窗直接显示在TA的屏幕上，TA可以在弹窗里继续回复你。"
    + "请保持你的身份自然回应，每次回复保持简短（一至三句话）。",
    "",
  ];
  turns.forEach(turn => {
    if (turn.role === "assistant") {
      lines.push(`你：${turn.text}`);
      return;
    }
    if (turn.screen) {
      if (turn.sequence === liveSequence) {
        lines.push(hasLiveImage
          ? `用户发来了当前的屏幕截图：${IMAGE_MARKER}`
          : "用户发来了当前的屏幕内容（文字识别结果）：\n"
            + (turn.ocr ? turn.ocr.slice(0, 4000) : "（截图未能识别出文字，请结合上下文回应）"));
      } else {
        lines.push(turn.ocr
          ? `用户此前发来的屏幕文字：\n${turn.ocr.slice(0, 4000)}`
          : "用户此前发来过一张屏幕截图（原图未保存）。");
      }
      if (turn.text) lines.push(`用户：${turn.text}`);
      return;
    }
    lines.push(`用户：${turn.text}`);
  });
  lines.push("", "请直接输出你此刻对用户说的话。");
  return lines.join("\n");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "只支持 POST。" }, 405);

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Supabase 环境缺失。" }, 503);

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });

  try {
    if ((Number(request.headers.get("content-length")) || 0) > MAX_BODY_BYTES) {
      return json({ ok: false, error: "请求过大：截图请先缩放到宽 960 左右并转成 JPEG。" }, 413);
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const token = cleanText(body.token, 100);
    if (!token) return json({ ok: false, error: "缺少 token。" }, 400);

    // bridge_token 认主（与网关 bridge-wake 同一套：快捷指令免请求头）
    const tokenResponse = await rest(
      `push_bridge_config?bridge_token=eq.${encodeURIComponent(token)}&select=user_id&limit=1`,
    );
    const tokenRows = tokenResponse.ok ? await tokenResponse.json() as { user_id: string }[] : [];
    const userId = tokenRows[0]?.user_id;
    if (!userId) return json({ ok: false, error: "令牌无效。" }, 403);

    const secretResponse = await rest("push_server_config?id=eq.main&select=payload_key&limit=1");
    const secretRows = secretResponse.ok ? await secretResponse.json() as { payload_key?: string | null }[] : [];
    const payloadKey = secretRows[0]?.payload_key || "";
    if (!payloadKey) return json({ ok: false, error: "个人云推送配置未初始化，请先在小手机开启一次离线推送。" }, 503);

    // 屏幕速聊快照（现实桥客户端同步；没有说明功能未启用或尚未同步）
    const snapshotResponse = await rest(
      `push_bridge_snapshots?user_id=eq.${encodeURIComponent(userId)}`
      + `&rule_id=eq.${SCREEN_CHAT_SNAPSHOT_ID}&select=payload&limit=1`,
    );
    const snapshotRows = snapshotResponse.ok ? await snapshotResponse.json() as { payload: EncryptedPayload }[] : [];
    if (!snapshotRows[0]) {
      return json({ ok: false, error: "屏幕速聊尚未同步：请打开小手机 → 现实桥 → 屏幕速聊，启用并选择角色后稍等片刻。" }, 409);
    }
    let snapshot: ScreenSnapshot;
    try {
      snapshot = JSON.parse(await decryptPayload(snapshotRows[0].payload, payloadKey)) as ScreenSnapshot;
    } catch {
      return json({ ok: false, error: "屏幕速聊快照损坏，请到小手机重新保存一次屏幕速聊设置。" }, 500);
    }
    const replyRequest = snapshot.replyRequest;
    if (!replyRequest?.url || !replyRequest.body) {
      return json({ ok: false, error: "屏幕速聊快照不完整，请到小手机重新保存一次屏幕速聊设置。" }, 500);
    }
    const characterName = cleanText(snapshot.chat?.characterName, 30) || "TA";

    // 输入：截图（base64）/ 屏幕文字（快捷指令本地 OCR）/ 用户回复文本
    const text = cleanText(body.text, 2000);
    const ocr = cleanText(body.ocr, 6000);
    let image: { mimeType: string; base64: string } | null = null;
    // 兼容 dataURL 前缀（快捷指令「Base64 编码」给的是裸 base64，这里防御性剥一层）
    const imageBase64 = typeof body.image === "string"
      ? body.image.replace(/^data:[^,]*,/, "").replace(/\s+/g, "")
      : "";
    if (imageBase64) {
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(imageBase64);
      } catch {
        return json({ ok: false, error: "图片 Base64 无法解析。" }, 400);
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        return json({ ok: false, error: "截图过大：请在快捷指令里先缩放到宽 960 并转成 JPEG。" }, 413);
      }
      const mime = detectImageMime(bytes);
      if (!mime) return json({ ok: false, error: "只支持 JPEG、PNG 或 WebP 截图。" }, 415);
      image = { mimeType: mime, base64: imageBase64 };
    }
    if (!image && !text && !ocr) return json({ ok: false, error: "缺少内容：请携带截图（image）或文本（text）。" }, 400);

    const characterId = cleanText(snapshot.chat?.characterId, 100);
    const canonicalSessionId = cleanText(snapshot.chat?.sessionId, 100);
    if (!characterId || !canonicalSessionId) {
      return json({ ok: false, error: "屏幕速聊缺少角色会话，请打开小手机重新选择角色。" }, 409);
    }

    // 按角色原子串行生成并计数；不会因双击过快而覆盖另一轮。
    const dailyCap = Math.max(10, Math.min(500, Number(snapshot.dailyCap) || DEFAULT_DAILY_CAP));
    const lockToken = crypto.randomUUID();
    let lockHeld = false;
    try {
      const beginResponse = await rest("rpc/ai_phone_screen_chat_begin", {
        method: "POST",
        body: JSON.stringify({
          p_user_id: userId,
          p_character_id: characterId,
          p_session_id: canonicalSessionId,
          p_lock_token: lockToken,
          p_daily_cap: dailyCap,
        }),
      });
      if (!beginResponse.ok) {
        const detail = await beginResponse.text().catch(() => "");
        return json({ ok: false, error: `个人云版本不兼容，请重新部署（${detail.slice(0, 100)}）` }, 409);
      }
      const begin = await beginResponse.json().catch(() => ({})) as BeginResult;
      if (begin.status === "busy") return json({ ok: false, error: "角色正在回复上一条，请稍后再试。" }, 409);
      if (begin.status === "daily_cap") {
        return json({ ok: false, error: `今天的屏幕速聊次数已达上限（${dailyCap} 次），明天再来吧。` }, 429);
      }
      if (begin.status !== "ok") return json({ ok: false, error: "无法取得屏幕速聊会话锁。" }, 500);
      lockHeld = true;

      const acknowledged = Math.max(0, Number(snapshot.ackSequence) || 0);
      const pendingTurns = normalizePendingTurns(begin.pendingTurns, acknowledged);
      const sequence = Math.max(0, Number(begin.nextSequence) || 0) + 1;
      const now = new Date().toISOString();
      const carriesScreen = Boolean(image || ocr);
      pendingTurns.push({
        sequence,
        role: "user",
        text,
        ...(carriesScreen ? { screen: true } : {}),
        ...(ocr ? { ocr } : {}),
        at: now,
      });

      // 原图仅存在于本次函数内存和本次 LLM 请求中；不会写入任何 Supabase 表。
      const liveImage = snapshot.enableVision === true ? image : null;
      const transcript = buildTranscript(pendingTurns, sequence, Boolean(liveImage));
      const originalBodyJson = JSON.stringify(replyRequest.body);
      const bodyJson = substituteSentinel(originalBodyJson, SCREEN_CHAT_SENTINEL, transcript);
      if (bodyJson === originalBodyJson) {
        return json({ ok: false, error: "快照里找不到对话占位符，请到小手机重新保存一次屏幕速聊设置。" }, 500);
      }
      const requestBody = JSON.parse(bodyJson) as Record<string, unknown>;
      if (liveImage) {
        if (!injectImageAtMarker(requestBody, replyRequest.providerKind, IMAGE_MARKER, liveImage)) {
          replaceMarkerInStrings(requestBody, IMAGE_MARKER, ocr || "（截图注入失败，请结合上下文回应）");
        }
      } else {
        replaceMarkerInStrings(requestBody, IMAGE_MARKER, ocr || "（无截图内容）");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      let llmResponse: Response;
      try {
        llmResponse = await fetch(replyRequest.url, {
          method: "POST",
          headers: replyRequest.headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (err) {
        return json({
          ok: false,
          error: `AI 接口连接失败：${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
        }, 502);
      } finally {
        clearTimeout(timeout);
      }
      if (!llmResponse.ok) {
        const detail = await llmResponse.text().catch(() => "");
        return json({ ok: false, error: `AI 接口返回 ${llmResponse.status}：${detail.slice(0, 160)}` }, 502);
      }
      let rawText = extractResponseText(replyRequest.providerKind, await llmResponse.json()).trim();
      if (!rawText) return json({ ok: false, error: "AI 返回了空回复，请再试一次。" }, 502);

      // 弹窗通道不直接执行控制标记；只同步角色最终说出口的内容。
      rawText = rawText
        .replace(/【快捷动作[：:][^】\n]{1,60}】/g, "")
        .replace(/【发到微信】/g, "")
        .replace(/[\[【]我(?:向[^\]】\r\n]{1,80})?发起了语音通话[\]】]/g, "")
        .replace(/【拨打电话】/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim() || "……";

      const assistantAt = new Date().toISOString();
      pendingTurns.push({ sequence, role: "assistant", text: rawText.slice(0, 2000), at: assistantAt });
      const unacknowledgedTurns = pendingTurns.filter(turn => turn.sequence > acknowledged).slice(-MAX_PENDING_TURNS);
      const exchangeId = crypto.randomUUID();
      const userSideText = carriesScreen
        ? `（通过悬浮球把当前手机屏幕发给了${characterName}）${text ? `：${text}` : ""}`
        : text || "（继续了屏幕速聊）";
      const historyText = carriesScreen && ocr
        ? `${userSideText}\n[屏幕文字识别结果]\n${ocr}`.slice(0, 8000)
        : userSideText;
      const meta = {
        kind: "bridge",
        screenChat: true,
        screenChatCharacterId: characterId,
        screenChatSequence: sequence,
        screenChatResponseBatchId: `screen_reply_${exchangeId}`,
        screenChatAssistantAt: assistantAt,
        item: { id: exchangeId, type: "屏幕速聊", payload: userSideText, createdAt: now },
        historyText,
        chatMessageId: `screen_user_${exchangeId}`,
        chat: {
          characterId,
          sessionId: canonicalSessionId,
          role: "user",
          requestReply: false,
          characterName,
        },
        feedNote: "屏幕速聊（悬浮球）",
        reply: snapshot.reply ?? null,
      };
      const finishResponse = await rest("rpc/ai_phone_screen_chat_finish", {
        method: "POST",
        body: JSON.stringify({
          p_user_id: userId,
          p_character_id: characterId,
          p_lock_token: lockToken,
          p_pending_turns: unacknowledgedTurns,
          p_next_sequence: sequence,
          p_outbox_id: `out_${exchangeId}`,
          p_session_id: canonicalSessionId,
          p_trigger_key: `screen:${canonicalSessionId}:${sequence}`,
          p_raw_text: rawText,
          p_meta: meta,
        }),
      });
      const finished = finishResponse.ok && await finishResponse.json().catch(() => false) === true;
      if (!finished) return json({ ok: false, error: "回复已生成，但写入个人云失败，请重试。" }, 500);
      lockHeld = false;

      return json({ ok: true, reply: popupTextFromReply(rawText), characterName, sequence });
    } finally {
      if (lockHeld) {
        await rest("rpc/ai_phone_screen_chat_abort", {
          method: "POST",
          body: JSON.stringify({ p_user_id: userId, p_character_id: characterId, p_lock_token: lockToken }),
        }).catch(() => undefined);
      }
    }
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
