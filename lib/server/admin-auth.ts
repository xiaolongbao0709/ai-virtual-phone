// 管理员鉴权：双通道。
// ① 账号通道：app_users.role = 'admin'（moderation-supabase.sql 加的列）——
//    role 列单独查询、查询失败视为非管理员，保证未跑迁移的老库不受影响。
// ② 站长密钥通道：x-app-market-admin-key / x-verify-admin-key 请求头，
//    与应用市场审核接口共用同一对环境变量，作为没有账号体系时的兜底。

import nodeCrypto from "node:crypto";

import { getCurrentAccount, type AppAccount } from "./account-auth";
import { encodeSupabaseFilter, supabaseRestFetch } from "./supabase-rest";

export type ModeratorContext = {
  account: AppAccount | null;
  viaKey: boolean;
  /** 展示用身份：账号名或「站长密钥」 */
  actorLabel: string;
};

export function hasAdminKey(request: Request): boolean {
  const expected = (process.env.APP_MARKET_ADMIN_KEY || process.env.VERIFY_ADMIN_KEY || "").trim();
  if (!expected) return false;
  const provided = (
    request.headers.get("x-app-market-admin-key")
    || request.headers.get("x-verify-admin-key")
    || ""
  ).trim();
  if (!provided) return false;
  const hash = (value: string) => nodeCrypto.createHash("sha256").update(value).digest();
  return nodeCrypto.timingSafeEqual(hash(provided), hash(expected));
}

export async function isAdminAccount(account: AppAccount | null): Promise<boolean> {
  if (!account || account.status === "disabled") return false;
  const result = await supabaseRestFetch<{ role?: string | null }[]>(
    `app_users?id=eq.${encodeSupabaseFilter(account.id)}&select=role&limit=1`,
  ).catch(() => null);
  if (!result || !result.ok) return false; // role 列不存在（未迁移）→ 非管理员
  return result.data[0]?.role === "admin";
}

/** 返回管理员上下文；非管理员返回 null。 */
export async function getModeratorContext(request: Request): Promise<ModeratorContext | null> {
  const account = await getCurrentAccount(request).catch(() => null);
  if (account && await isAdminAccount(account)) {
    return { account, viaKey: false, actorLabel: account.displayName || account.username };
  }
  if (hasAdminKey(request)) {
    return { account, viaKey: true, actorLabel: "站长密钥" };
  }
  return null;
}
