import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { normalizeShortcutEmailAddress, isValidShortcutEmailAddress } from "../shortcut-email";
import { encodeSupabaseFilter, supabaseRestFetch } from "./supabase-rest";

type ShortcutEmailProviderConfig = {
  apiKey: string;
  from: string;
  senderAddress: string;
};

type ShortcutEmailConfigRow = {
  user_id: string;
  recipient: string;
  verified_at: string | null;
  verification_hash: string | null;
  verification_expires_at: string | null;
  verification_sent_at: string | null;
  verification_attempts: number;
  created_at: string;
  updated_at: string;
};

export type ShortcutEmailStatus = {
  providerConfigured: boolean;
  senderAddress: string;
  recipient: string;
  verified: boolean;
  verificationExpiresAt?: string;
};

const SHORTCUT_EMAIL_CONFIG_SELECT = [
  "user_id",
  "recipient",
  "verified_at",
  "verification_hash",
  "verification_expires_at",
  "verification_sent_at",
  "verification_attempts",
  "created_at",
  "updated_at",
].join(",");

export function getShortcutEmailProviderConfig(): ShortcutEmailProviderConfig | null {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.REALITY_BRIDGE_EMAIL_FROM || "").trim();
  const bracketAddress = from.match(/<([^<>]+)>\s*$/)?.[1];
  const senderAddress = normalizeShortcutEmailAddress(bracketAddress || from);
  if (!apiKey || !from || !isValidShortcutEmailAddress(senderAddress)) return null;
  return { apiKey, from, senderAddress };
}

async function loadShortcutEmailRow(userId: string): Promise<ShortcutEmailConfigRow | null> {
  const result = await supabaseRestFetch<ShortcutEmailConfigRow[]>(
    `push_shortcut_email_config?user_id=eq.${encodeSupabaseFilter(userId)}&select=${SHORTCUT_EMAIL_CONFIG_SELECT}&limit=1`,
  );
  if (!result.ok) throw new Error(result.error);
  return result.data[0] || null;
}

export async function getShortcutEmailStatus(userId: string): Promise<ShortcutEmailStatus> {
  const provider = getShortcutEmailProviderConfig();
  const row = await loadShortcutEmailRow(userId);
  return {
    providerConfigured: Boolean(provider),
    senderAddress: provider?.senderAddress || "",
    recipient: normalizeShortcutEmailAddress(row?.recipient),
    verified: Boolean(row?.verified_at),
    verificationExpiresAt: row?.verification_expires_at || undefined,
  };
}

export async function getVerifiedShortcutEmailRecipient(userId: string): Promise<string> {
  const row = await loadShortcutEmailRow(userId);
  const recipient = normalizeShortcutEmailAddress(row?.recipient);
  return row?.verified_at && isValidShortcutEmailAddress(recipient) ? recipient : "";
}

function verificationSecret(): string {
  return String(process.env.SHORTCUT_EMAIL_VERIFICATION_SECRET || process.env.RESEND_API_KEY || "").trim();
}

function verificationHash(userId: string, recipient: string, code: string): string {
  return createHmac("sha256", verificationSecret())
    .update(`${userId}\0${recipient}\0${code}`)
    .digest("hex");
}

export async function sendShortcutEmail(input: {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}): Promise<{ id: string }> {
  const provider = getShortcutEmailProviderConfig();
  if (!provider) throw new Error("邮件服务尚未配置。");
  const to = normalizeShortcutEmailAddress(input.to);
  if (!isValidShortcutEmailAddress(to)) throw new Error("收件邮箱无效。");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey.slice(0, 256),
      "User-Agent": "Float-Reality-Bridge/1.0",
    },
    body: JSON.stringify({
      from: provider.from,
      to: [to],
      subject: input.subject.slice(0, 180),
      text: input.text,
    }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as { id?: unknown; message?: unknown; error?: unknown };
  if (!response.ok || typeof data.id !== "string") {
    throw new Error(String(data.message || data.error || response.statusText || "邮件发送失败。"));
  }
  return { id: data.id };
}

export async function beginShortcutEmailVerification(userId: string, rawRecipient: unknown): Promise<string> {
  const provider = getShortcutEmailProviderConfig();
  if (!provider || !verificationSecret()) throw new Error("邮件服务尚未配置。");
  const recipient = normalizeShortcutEmailAddress(rawRecipient);
  if (!isValidShortcutEmailAddress(recipient)) throw new Error("请输入有效的邮箱地址。");

  const existing = await loadShortcutEmailRow(userId);
  const lastSentAt = Date.parse(existing?.verification_sent_at || "");
  if (Number.isFinite(lastSentAt) && Date.now() - lastSentAt < 60_000) {
    throw new Error("验证码发送过于频繁，请一分钟后再试。");
  }

  const code = String(randomInt(100000, 1000000));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const stored = await supabaseRestFetch("push_shortcut_email_config?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{
      user_id: userId,
      recipient,
      verified_at: existing?.recipient === recipient ? existing.verified_at : null,
      verification_hash: verificationHash(userId, recipient, code),
      verification_expires_at: expiresAt,
      verification_sent_at: now.toISOString(),
      verification_attempts: 0,
      updated_at: now.toISOString(),
    }]),
  });
  if (!stored.ok) throw new Error(stored.error);

  try {
    await sendShortcutEmail({
      to: recipient,
      subject: "小手机现实桥邮箱验证码",
      text: `你的验证码是：${code}\n\n验证码 10 分钟内有效。不是你本人操作时请忽略。`,
      idempotencyKey: `shortcut-email-verify-${userId}-${now.getTime()}`,
    });
  } catch (err) {
    await supabaseRestFetch(
      `push_shortcut_email_config?user_id=eq.${encodeSupabaseFilter(userId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ verification_sent_at: null, updated_at: new Date().toISOString() }),
      },
    ).catch(() => undefined);
    throw err;
  }
  return expiresAt;
}

export async function confirmShortcutEmailVerification(userId: string, rawCode: unknown): Promise<string> {
  const code = String(rawCode ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("请输入六位验证码。");
  const row = await loadShortcutEmailRow(userId);
  const recipient = normalizeShortcutEmailAddress(row?.recipient);
  if (!row?.verification_hash || !row.verification_expires_at || !recipient) {
    throw new Error("请先发送验证码。");
  }
  if (Date.parse(row.verification_expires_at) <= Date.now()) throw new Error("验证码已过期，请重新发送。");
  if (Number(row.verification_attempts) >= 5) throw new Error("验证码尝试次数过多，请重新发送。");
  const actual = Buffer.from(verificationHash(userId, recipient, code), "hex");
  const expected = Buffer.from(row.verification_hash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    await supabaseRestFetch(
      `push_shortcut_email_config?user_id=eq.${encodeSupabaseFilter(userId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ verification_attempts: Number(row.verification_attempts) + 1, updated_at: new Date().toISOString() }),
      },
    ).catch(() => undefined);
    throw new Error("验证码不正确。");
  }

  const now = new Date().toISOString();
  const updated = await supabaseRestFetch(
    `push_shortcut_email_config?user_id=eq.${encodeSupabaseFilter(userId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        verified_at: now,
        verification_hash: null,
        verification_expires_at: null,
        verification_attempts: 0,
        updated_at: now,
      }),
    },
  );
  if (!updated.ok) throw new Error(updated.error);
  return recipient;
}

export async function removeShortcutEmailVerification(userId: string): Promise<void> {
  const removed = await supabaseRestFetch(
    `push_shortcut_email_config?user_id=eq.${encodeSupabaseFilter(userId)}`,
    { method: "DELETE" },
  );
  if (!removed.ok) throw new Error(removed.error);
}
