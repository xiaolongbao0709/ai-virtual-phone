import crypto from "crypto";

import { ACCOUNT_SESSION_COOKIE as SHARED_ACCOUNT_SESSION_COOKIE } from "../account-cookie-constants";
import { isSelfHostedModeEnabled } from "../self-hosting";
import { encodeSupabaseFilter, supabaseRestFetch } from "./supabase-rest";

export const ACCOUNT_SESSION_COOKIE = SHARED_ACCOUNT_SESSION_COOKIE;
export const ACCOUNT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const PASSWORD_HASH_VERSION = "pbkdf2_sha256";
const PASSWORD_HASH_ITERATIONS = 210000;
const PASSWORD_KEY_LENGTH = 32;

export type AppAccount = {
  id: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt?: string;
  updatedAt?: string;
};

type AppUserRecord = {
  id?: unknown;
  username?: unknown;
  password_hash?: unknown;
  display_name?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type ActivationCodeRecord = {
  code?: unknown;
  status?: unknown;
  max_uses?: unknown;
  used_count?: unknown;
  expires_at?: unknown;
};

type SessionRecord = {
  token_hash?: unknown;
  user_id?: unknown;
  expires_at?: unknown;
};

export function cleanAccountText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

export function normalizeUsername(value: unknown): string {
  return cleanAccountText(value, 40).toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return /^[a-z0-9_@.-]{3,40}$/.test(username);
}

export function toPublicAccount(record: AppUserRecord): AppAccount | null {
  const id = cleanAccountText(record.id, 120);
  const username = normalizeUsername(record.username);
  const displayName = cleanAccountText(record.display_name, 80) || username;
  const status = record.status === "disabled" ? "disabled" : "active";
  if (!id || !username) return null;
  return {
    id,
    username,
    displayName,
    status,
    createdAt: cleanAccountText(record.created_at, 80) || undefined,
    updatedAt: cleanAccountText(record.updated_at, 80) || undefined,
  };
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function createAccountId(): string {
  return `acct_${base64Url(crypto.randomBytes(18))}`;
}

export function createSessionToken(): string {
  return `aps_${base64Url(crypto.randomBytes(36))}`;
}

export function hashSessionToken(token: string): string {
  return sha256(token);
}

export function hashPassword(password: string): string {
  const salt = base64Url(crypto.randomBytes(16));
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_HASH_ITERATIONS, PASSWORD_KEY_LENGTH, "sha256").toString("base64url");
  return `${PASSWORD_HASH_VERSION}$${PASSWORD_HASH_ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  const [version, iterationsRaw, salt, expectedHash] = encodedHash.split("$");
  const iterations = Number(iterationsRaw);
  if (version !== PASSWORD_HASH_VERSION || !Number.isFinite(iterations) || !salt || !expectedHash) return false;
  const actual = crypto.pbkdf2Sync(password, salt, iterations, PASSWORD_KEY_LENGTH, "sha256").toString("base64url");
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expectedHash);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function readCookie(request: Request, name: string): string {
  const cookie = request.headers.get("cookie") ?? "";
  const parts = cookie.split(";").map(item => item.trim());
  const prefix = `${name}=`;
  const match = parts.find(item => item.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

export async function updateUserPassword(userId: string, password: string): Promise<void> {
  const result = await supabaseRestFetch<unknown[]>(
    `app_users?id=eq.${encodeSupabaseFilter(userId)}&select=id`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        password_hash: hashPassword(password),
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!result.ok) throw new Error(result.error);
}

export async function findUserByUsername(username: string): Promise<AppUserRecord | null> {
  const result = await supabaseRestFetch<AppUserRecord[]>(
    `app_users?username=eq.${encodeSupabaseFilter(username)}&select=id,username,password_hash,display_name,status,created_at,updated_at&limit=1`,
  );
  if (!result.ok) throw new Error(result.error);
  return result.data[0] ?? null;
}

export async function findUserById(id: string): Promise<AppUserRecord | null> {
  const result = await supabaseRestFetch<AppUserRecord[]>(
    `app_users?id=eq.${encodeSupabaseFilter(id)}&select=id,username,password_hash,display_name,status,created_at,updated_at&limit=1`,
  );
  if (!result.ok) throw new Error(result.error);
  return result.data[0] ?? null;
}

export async function validateActivationCode(code: string): Promise<ActivationCodeRecord> {
  const result = await supabaseRestFetch<ActivationCodeRecord[]>(
    `activation_codes?code=eq.${encodeSupabaseFilter(code)}&select=code,status,max_uses,used_count,expires_at&limit=1`,
  );
  if (!result.ok) throw new Error(result.error);
  const record = result.data[0];
  if (!record) throw new Error("激活码不存在。");
  if (record.status !== "active") throw new Error("激活码不可用。");
  const maxUses = Number(record.max_uses);
  const usedCount = Number(record.used_count);
  if (!Number.isFinite(maxUses) || !Number.isFinite(usedCount) || usedCount >= maxUses) {
    throw new Error("激活码已被使用完。");
  }
  const expiresAt = cleanAccountText(record.expires_at, 80);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new Error("激活码已过期。");
  }
  return record;
}

export async function markActivationCodeUsed(code: string, userId: string): Promise<void> {
  const current = await validateActivationCode(code);
  const usedCount = Number(current.used_count);
  const result = await supabaseRestFetch<unknown[]>(
    `activation_codes?code=eq.${encodeSupabaseFilter(code)}&select=code`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        used_count: usedCount + 1,
        last_used_by: userId,
        last_used_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!result.ok) throw new Error(result.error);
}

export async function createUser(input: {
  username: string;
  password: string;
  displayName?: string;
}): Promise<AppUserRecord> {
  const now = new Date().toISOString();
  const payload = {
    id: createAccountId(),
    username: input.username,
    password_hash: hashPassword(input.password),
    display_name: cleanAccountText(input.displayName, 80) || input.username,
    status: "active",
    activated_at: now,
    last_login_at: now,
    created_at: now,
    updated_at: now,
  };
  const result = await supabaseRestFetch<AppUserRecord[]>("app_users?select=id,username,password_hash,display_name,status,created_at,updated_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload),
  });
  if (!result.ok) throw new Error(result.error);
  const user = result.data[0];
  if (!user) throw new Error("账号创建失败。");
  return user;
}

/** Sentinel: the atomic RPC isn't installed yet (account-supabase.sql not run). */
export const ACTIVATION_RPC_MISSING = "activation_rpc_missing";

function mapRegisterError(error: string): string {
  if (/Could not find the function|PGRST202|does not exist|schema cache/i.test(error)) {
    return ACTIVATION_RPC_MISSING;
  }
  if (/activation_code_not_found/i.test(error)) return "激活码不存在。";
  if (/activation_code_disabled/i.test(error)) return "激活码不可用。";
  if (/activation_code_expired/i.test(error)) return "激活码已过期。";
  if (/activation_code_exhausted/i.test(error)) return "激活码已被使用完。";
  if (/username_taken|duplicate key|app_users_username/i.test(error)) return "该账号已被注册。";
  return error;
}

/**
 * Atomically claim an activation code and create the account in one transaction
 * (the code row is locked, so concurrent first-time registrations can't exceed
 * max_uses). Throws Error(ACTIVATION_RPC_MISSING) if the RPC isn't installed,
 * so callers can fall back to the legacy non-atomic flow.
 */
export async function registerAccountWithCode(input: {
  username: string;
  password: string;
  displayName?: string;
  activationCode: string;
}): Promise<AppUserRecord> {
  const result = await supabaseRestFetch<AppUserRecord | AppUserRecord[]>("rpc/app_register_account", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      p_id: createAccountId(),
      p_username: input.username,
      p_password_hash: hashPassword(input.password),
      p_display_name: cleanAccountText(input.displayName, 80) || input.username,
      p_code: input.activationCode,
    }),
  });
  if (!result.ok) throw new Error(mapRegisterError(result.error));
  const user = (Array.isArray(result.data) ? result.data[0] : result.data) as AppUserRecord | undefined;
  if (!user || !cleanAccountText(user.id, 120)) throw new Error("账号创建失败。");
  return user;
}

export async function touchUserLogin(userId: string): Promise<void> {
  await supabaseRestFetch<unknown[]>(
    `app_users?id=eq.${encodeSupabaseFilter(userId)}&select=id`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    },
  );
}

export async function createSession(userId: string, request: Request): Promise<{ token: string; expiresAt: string }> {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + ACCOUNT_SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const result = await supabaseRestFetch<unknown[]>("app_sessions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      token_hash: hashSessionToken(token),
      user_id: userId,
      user_agent: cleanAccountText(request.headers.get("user-agent"), 500),
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    }),
  });
  if (!result.ok) throw new Error(result.error);
  return { token, expiresAt };
}

export async function deleteSessionToken(token: string): Promise<void> {
  if (!token) return;
  await supabaseRestFetch<unknown[]>(
    `app_sessions?token_hash=eq.${encodeSupabaseFilter(hashSessionToken(token))}`,
    { method: "DELETE" },
  );
}

// 自建模式（跳过登录）的固定本地账号：与客户端 AccountGate 使用的 local_user 保持一致。
// 没有这个短路，游戏大厅/应用市场/黑市等需要账号身份的接口在单机模式下会一律返回 401。
const SELF_HOSTED_ACCOUNT: AppAccount = {
  id: "local_user",
  username: "local_user",
  displayName: "本地用户",
  status: "active",
};

export async function getCurrentAccount(request: Request): Promise<AppAccount | null> {
  if (isSelfHostedModeEnabled()) return { ...SELF_HOSTED_ACCOUNT };
  const token = readCookie(request, ACCOUNT_SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const result = await supabaseRestFetch<SessionRecord[]>(
    `app_sessions?token_hash=eq.${encodeSupabaseFilter(tokenHash)}&expires_at=gt.${encodeSupabaseFilter(new Date().toISOString())}&select=token_hash,user_id,expires_at&limit=1`,
  );
  if (!result.ok) throw new Error(result.error);
  const session = result.data[0];
  const userId = cleanAccountText(session?.user_id, 120);
  if (!userId) return null;
  const user = await findUserById(userId);
  if (!user || user.status === "disabled") return null;
  await supabaseRestFetch<unknown[]>(
    `app_sessions?token_hash=eq.${encodeSupabaseFilter(tokenHash)}&select=token_hash`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
    },
  );
  return toPublicAccount(user);
}
