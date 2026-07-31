import nodeCrypto from "crypto";

import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { getModeratorContext } from "@/lib/server/admin-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
import type { CustomAppManifest, CustomAppPermission } from "@/lib/custom-app-types";
import type { CustomAppMarketItem, CustomAppPackageKind, CustomAppReviewStatus } from "@/lib/custom-app-market-types";

/* 注意:此处不含 package_hash——存量库可能还没跑新版 SQL 加列,主读路径不能因此挂掉;
   哈希只在 validateMarketConflicts 里单独查询,列缺失时自动降级跳过查重。 */
const REST_APP_COLUMNS = "id,app_id,name,version,changelog,description,icon_data_url,permissions,manifest,package_url,package_path,package_kind,package_size,author_id,author_name,author_avatar,review_status,install_count,like_count,created_at,updated_at";
const GENERIC_PRIMARY_TAGS = new Set(["chat", "text", "custom_app", "group_chat"]);
const CUSTOM_APP_PACKAGE_BUCKET = "custom-app-market-packages";

/** 服务端权威计算包哈希（发布/更新时按 package_path 取回包内容），用于防原样重传倒卖。 */
async function computePackageHash(packagePath: string): Promise<string> {
  const config = getSupabaseServerConfig();
  const path = cleanText(packagePath, 600);
  if (!config || !path) return "";
  try {
    const response = await fetch(`${config.url}/storage/v1/object/${CUSTOM_APP_PACKAGE_BUCKET}/${path}`, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    });
    if (!response.ok) return "";
    const bytes = await response.arrayBuffer();
    return nodeCrypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  } catch {
    return "";
  }
}

/** 包直链只对作者本人下发；其他人下载一律走 /api/app-market/download 换短时签名地址。 */
function stripPackageLinkForViewer(app: CustomAppMarketItem | null, viewerId?: string | null): CustomAppMarketItem | null {
  if (!app) return null;
  if (viewerId && app.authorId === viewerId) return app;
  return { ...app, packageUrl: "", packagePath: "", packageHash: undefined };
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanId(value: unknown): string {
  return cleanText(value, 120).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

const MAX_ICON_DATA_URL_LENGTH = 300000;

// 图标 dataURL 不能截断:砍尾的 base64 图片只会渲染出顶部一条。超限一律
// 丢弃回退默认图标;达到上限的存量数据就是历史版本 slice 截断留下的坏图,同样丢弃。
function cleanIconDataUrl(value: unknown): string {
  const icon = String(value ?? "").trim();
  if (!icon.startsWith("data:image/")) return "";
  if (icon.length >= MAX_ICON_DATA_URL_LENGTH) return "";
  return icon;
}

function randomIdSuffix(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 12);
}

function generateMarketAppId(name: string): string {
  const suffix = randomIdSuffix();
  const base = cleanId(name).slice(0, Math.max(1, 70 - suffix.length)) || "custom-app";
  return `app_${base}_${suffix}`;
}

function normalizeManifestId(value: unknown, fallback?: unknown): string {
  return cleanId(value) || cleanId(fallback) || "custom-app";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown, maxLength = 160, limit = 50): string[] {
  if (Array.isArray(value)) return value.map(item => cleanText(item, maxLength)).filter(Boolean).slice(0, limit);
  const text = cleanText(value, maxLength);
  return text ? [text] : [];
}

function normalizeConflictName(value: unknown): string {
  return cleanText(value, 80).replace(/\s+/g, " ").toLowerCase();
}

function addPrimaryTag(target: Set<string>, tags: unknown): void {
  const primary = stringArray(tags, 80, 30)
    .map(tag => tag.toLowerCase())
    .find(tag => tag && !GENERIC_PRIMARY_TAGS.has(tag));
  if (primary) target.add(primary);
}

function getManifestPrimaryTags(manifest: unknown): string[] {
  const tags = new Set<string>();
  const record = asRecord(manifest);
  addPrimaryTag(tags, record.primaryTags);
  const extensions = asRecord(record.extensions);
  const chat = { ...asRecord(record.chatExtensions), ...asRecord(extensions.chat) };
  const prompt = asRecord(extensions.prompt);
  for (const scene of Array.isArray(chat.scenes) ? chat.scenes : []) {
    const item = asRecord(scene);
    addPrimaryTag(tags, item.tags ?? item.appTags ?? item.tag);
  }
  const directives = [
    ...(Array.isArray(record.chatDirectives) ? record.chatDirectives : []),
    ...(Array.isArray(chat.directives) ? chat.directives : []),
  ];
  for (const directive of directives) addPrimaryTag(tags, asRecord(directive).tags);
  const plusActions = [
    ...(Array.isArray(record.chatPlusActions) ? record.chatPlusActions : []),
    ...(Array.isArray(chat.plusActions) ? chat.plusActions : []),
  ];
  for (const action of plusActions) addPrimaryTag(tags, asRecord(action).tags);
  const profiles = [
    ...(Array.isArray(record.promptProfiles) ? record.promptProfiles : []),
    ...(Array.isArray(prompt.profiles) ? prompt.profiles : []),
  ];
  for (const profile of profiles) addPrimaryTag(tags, asRecord(profile).appTags ?? asRecord(profile).tags);
  return Array.from(tags);
}

function clampCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
}

function normalizePermissions(value: unknown): CustomAppPermission[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 80) as CustomAppPermission[];
}

function normalizePackageKind(value: unknown): CustomAppPackageKind {
  if (value === "html") return "html";
  if (value === "floatapp") return "floatapp";
  if (value === "zip") return "zip";
  return "zip";
}

function normalizeReviewStatus(value: unknown): CustomAppReviewStatus {
  if (value === "approved" || value === "rejected") return value;
  return "pending";
}

function normalizeManifest(value: unknown, fallback: { appId: string; name: string; version: string }): CustomAppManifest {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    id: normalizeManifestId(record.id, fallback.name || fallback.appId),
    name: cleanText(record.name, 60) || fallback.name,
    version: cleanText(record.version, 30) || fallback.version,
    author: cleanText(record.author, 60) || undefined,
    description: cleanText(record.description, 800) || undefined,
    icon: cleanText(record.icon, 180) || undefined,
    entry: cleanText(record.entry, 180) || undefined,
    permissions: normalizePermissions(record.permissions),
    sdkVersion: cleanText(record.sdkVersion, 40) || undefined,
    resources: record.resources && typeof record.resources === "object" ? record.resources as CustomAppManifest["resources"] : undefined,
    primaryTags: stringArray(record.primaryTags, 80, 30),
    extensions: record.extensions && typeof record.extensions === "object" ? record.extensions as CustomAppManifest["extensions"] : undefined,
    promptProfiles: Array.isArray(record.promptProfiles) ? record.promptProfiles as CustomAppManifest["promptProfiles"] : undefined,
    events: Array.isArray(record.events) ? record.events as CustomAppManifest["events"] : undefined,
    network: record.network && typeof record.network === "object" ? record.network as CustomAppManifest["network"] : undefined,
    slots: record.slots && typeof record.slots === "object" ? record.slots as CustomAppManifest["slots"] : undefined,
    chatDirectives: Array.isArray(record.chatDirectives) ? record.chatDirectives as CustomAppManifest["chatDirectives"] : undefined,
    chatPlusActions: Array.isArray(record.chatPlusActions) ? record.chatPlusActions as CustomAppManifest["chatPlusActions"] : undefined,
    chatExtensions: record.chatExtensions && typeof record.chatExtensions === "object" ? record.chatExtensions as CustomAppManifest["chatExtensions"] : undefined,
    triggers: Array.isArray(record.triggers) ? record.triggers.slice(0, 50) as Array<Record<string, unknown>> : undefined,
  };
}

function normalizeMarketItem(raw: unknown): CustomAppMarketItem | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanId(record.id);
  const appId = cleanId(record.app_id ?? record.appId);
  const name = cleanText(record.name, 60);
  const version = cleanText(record.version, 30) || "1.0.0";
  const packageUrl = cleanText(record.package_url ?? record.packageUrl, 3000);
  const packagePath = cleanText(record.package_path ?? record.packagePath, 600);
  if (!id || !appId || !name || !packageUrl) return null;
  const manifest = normalizeManifest(record.manifest, { appId, name, version });
  return {
    id,
    appId,
    name,
    version,
    changelog: cleanText(record.changelog ?? record.release_notes ?? record.releaseNotes, 4000) || undefined,
    description: cleanText(record.description, 800) || undefined,
    iconDataUrl: cleanIconDataUrl(record.icon_data_url ?? record.iconDataUrl) || undefined,
    permissions: normalizePermissions(record.permissions),
    manifest,
    packageUrl,
    packagePath,
    packageHash: cleanText(record.package_hash ?? record.packageHash, 80) || undefined,
    packageKind: normalizePackageKind(record.package_kind ?? record.packageKind),
    packageSize: clampCount(record.package_size ?? record.packageSize),
    authorId: cleanText(record.author_id ?? record.authorId, 160) || "anonymous",
    // 对外只暴露 manifest 里作者自己填的署名;author_name 列存的是账号名,直接透出会泄露登录账号
    authorName: manifest.author || "匿名作者",
    authorAvatar: cleanText(record.author_avatar ?? record.authorAvatar, 2000) || undefined,
    reviewStatus: normalizeReviewStatus(record.review_status ?? record.reviewStatus),
    installCount: clampCount(record.install_count ?? record.installCount),
    likeCount: clampCount(record.like_count ?? record.likeCount),
    createdAt: cleanText(record.created_at ?? record.createdAt, 80) || new Date().toISOString(),
    updatedAt: cleanText(record.updated_at ?? record.updatedAt, 80) || new Date().toISOString(),
  };
}

function isMissingTableError(message: string): boolean {
  return /custom_app_market_apps|package_url|review_status|app_id|changelog/i.test(message)
    && /schema cache|Could not find the table|Could not find.*column|PGRST204|PGRST205|does not exist/i.test(message);
}

function mapSupabaseError(message: string): string {
  if (isMissingTableError(message)) {
    return "自定义 APP 市场表尚未创建：请先在 Supabase SQL Editor 执行 docs/custom-app-market-supabase.sql。";
  }
  return message;
}

// 只收 header 不收查询参数(?key= 会原文进访问日志);sha256 后比较避免时序侧信道
function requireAppMarketAdminKey(request: Request): boolean {
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

function unauthorizedAdmin() {
  return NextResponse.json({ ok: false, error: "管理密钥不正确（需配置 APP_MARKET_ADMIN_KEY 或 VERIFY_ADMIN_KEY）。" }, { status: 401 });
}

function isAppMarketReviewEnabled(): boolean {
  return process.env.APP_MARKET_REVIEW_ENABLED === "true";
}

function reviewDisabled() {
  return NextResponse.json({ ok: false, error: "应用市场审核功能当前关闭。" }, { status: 403 });
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function buildPayload(
  input: Record<string, unknown>,
  account: { id: string; displayName: string },
  existing?: CustomAppMarketItem,
): Record<string, unknown> {
  const now = new Date().toISOString();
  const name = cleanText(input.name, 60) || existing?.name || "";
  const version = cleanText(input.version, 30) || existing?.version || "1.0.0";
  const packageUrl = cleanText(input.packageUrl ?? input.package_url, 3000) || existing?.packageUrl || "";
  const packagePath = cleanText(input.packagePath ?? input.package_path, 600) || existing?.packagePath || "";
  if (!name || !packageUrl || !packagePath) throw new Error("missing_required_custom_app_fields");
  const inputManifest = asRecord(input.manifest ?? existing?.manifest);
  const appIdSeed = normalizeManifestId(inputManifest.id, name);
  const appId = existing?.appId || cleanId(input.appId ?? input.app_id) || generateMarketAppId(appIdSeed);
  const id = cleanId(input.id) || existing?.id || appId;
  const permissions = hasOwn(input, "permissions") ? normalizePermissions(input.permissions) : existing?.permissions ?? [];
  const manifest = normalizeManifest(input.manifest ?? existing?.manifest, { appId, name, version });
  const hasChangelog = hasOwn(input, "changelog") || hasOwn(input, "release_notes") || hasOwn(input, "releaseNotes");
  const description = hasOwn(input, "description") ? cleanText(input.description, 800) : existing?.description ?? "";
  const iconDataUrl = hasOwn(input, "iconDataUrl") || hasOwn(input, "icon_data_url")
    ? cleanIconDataUrl(input.iconDataUrl ?? input.icon_data_url)
    : existing?.iconDataUrl ?? "";
  return {
    id,
    app_id: appId,
    name,
    version,
    changelog: hasChangelog
      ? cleanText(input.changelog ?? input.release_notes ?? input.releaseNotes, 4000)
      : existing?.changelog ?? "",
    description,
    icon_data_url: iconDataUrl,
    permissions,
    manifest: { ...manifest, name, version, description: description || undefined, permissions },
    package_url: packageUrl,
    package_path: packagePath,
    package_kind: hasOwn(input, "packageKind") || hasOwn(input, "package_kind")
      ? normalizePackageKind(input.packageKind ?? input.package_kind)
      : existing?.packageKind ?? "zip",
    package_size: hasOwn(input, "packageSize") || hasOwn(input, "package_size")
      ? clampCount(input.packageSize ?? input.package_size)
      : existing?.packageSize ?? 0,
    author_id: account.id,
    author_name: account.displayName || "匿名作者",
    author_avatar: existing?.authorAvatar ?? "",
    review_status: isAppMarketReviewEnabled() ? "pending" : "approved",
    updated_at: now,
  };
}

function buildConflictCheckPayload(
  input: Record<string, unknown>,
  existing?: CustomAppMarketItem,
): Record<string, unknown> {
  const name = cleanText(input.name, 60) || existing?.name || "";
  const version = cleanText(input.version, 30) || existing?.version || "1.0.0";
  const inputManifest = asRecord(input.manifest ?? existing?.manifest);
  const appIdSeed = normalizeManifestId(inputManifest.id, name);
  const appId = existing?.appId || cleanId(input.appId ?? input.app_id) || generateMarketAppId(appIdSeed);
  const id = cleanId(input.id) || existing?.id || appId;
  const manifest = normalizeManifest(input.manifest ?? existing?.manifest, { appId, name, version });
  return {
    id,
    app_id: appId,
    name,
    manifest: { ...manifest, name, version },
  };
}

async function validateMarketConflicts(payload: Record<string, unknown>, excludeId?: string): Promise<string | null> {
  const name = normalizeConflictName(payload.name);
  const packageHash = cleanText(payload.package_hash, 80);
  const primaryTags = new Set(getManifestPrimaryTags(payload.manifest));
  let result = await supabaseRestFetch<Array<{ id?: unknown; app_id?: unknown; name?: unknown; manifest?: unknown; package_hash?: unknown }>>(
    "custom_app_market_apps?deleted_at=is.null&select=id,app_id,name,manifest,package_hash&limit=500",
  );
  if (!result.ok && /package_hash/i.test(result.error)) {
    /* 存量库还没跑新版 SQL 加 package_hash 列:降级为不查重哈希,别把发布挡死 */
    result = await supabaseRestFetch(
      "custom_app_market_apps?deleted_at=is.null&select=id,app_id,name,manifest&limit=500",
    );
  }
  if (!result.ok) return mapSupabaseError(result.error);
  for (const item of result.data) {
    const itemId = cleanId(item.id);
    if (excludeId && itemId === excludeId) continue;
    if (itemId && itemId === cleanId(payload.id)) {
      return "该 APP 内部 ID 已被使用，请重新提交。";
    }
    if (cleanId(item.app_id) && cleanId(item.app_id) === cleanId(payload.app_id)) {
      return "该 APP 内部 ID 已被使用，请重新提交。";
    }
    if (name && normalizeConflictName(item.name) === name) {
      return `已存在同名 APP「${cleanText(item.name, 60)}」，请换一个应用名称。`;
    }
    if (packageHash && cleanText(item.package_hash, 80) === packageHash) {
      return `该应用包与已上架的「${cleanText(item.name, 60) || "未命名 APP"}」内容完全相同，请勿重复上传或搬运他人作品。`;
    }
    if (primaryTags.size > 0) {
      const existingTags = getManifestPrimaryTags(item.manifest);
      const overlap = existingTags.find(tag => primaryTags.has(tag));
      if (overlap) {
        return `主标签「${overlap}」已被 APP「${cleanText(item.name, 60) || "未命名 APP"}」使用，请更换新的英文主标签。`;
      }
    }
  }
  return null;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const account = await getCurrentAccount(request);
    const admin = url.searchParams.get("admin") === "1";
    if (admin) {
      if (!isAppMarketReviewEnabled()) return reviewDisabled();
      if (!requireAppMarketAdminKey(request) && !(await getModeratorContext(request))) return unauthorizedAdmin();
      const view = url.searchParams.get("view");
      const status = view === "approved" || view === "rejected" || view === "pending" ? view : "";
      const statusFilter = status ? `&review_status=eq.${status}` : "";
      const result = await supabaseRestFetch<unknown[]>(
        `custom_app_market_apps?deleted_at=is.null${statusFilter}&select=${REST_APP_COLUMNS}&order=updated_at.desc&limit=200`,
      );
      if (!result.ok) return NextResponse.json({ ok: false, apps: [], error: mapSupabaseError(result.error) }, { status: result.status });
      return NextResponse.json({ ok: true, apps: result.data.map(normalizeMarketItem).filter(Boolean) });
    }

    const requestedAppId = cleanId(url.searchParams.get("appId") ?? url.searchParams.get("app_id"));
    if (requestedAppId) {
      const result = await supabaseRestFetch<unknown[]>(
        `custom_app_market_apps?app_id=eq.${encodeSupabaseFilter(requestedAppId)}&deleted_at=is.null&select=${REST_APP_COLUMNS}&order=updated_at.desc&limit=1`,
      );
      if (!result.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(result.error) }, { status: result.status });
      const app = normalizeMarketItem(result.data[0]);
      if (!app || (app.reviewStatus !== "approved" && app.authorId !== account?.id)) {
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json({ ok: true, app: stripPackageLinkForViewer(app, account?.id) });
    }

    const requestedId = cleanId(url.searchParams.get("id"));
    if (requestedId) {
      const result = await supabaseRestFetch<unknown[]>(
        `custom_app_market_apps?id=eq.${encodeSupabaseFilter(requestedId)}&deleted_at=is.null&select=${REST_APP_COLUMNS}&limit=1`,
      );
      if (!result.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(result.error) }, { status: result.status });
      const app = normalizeMarketItem(result.data[0]);
      if (!app) return NextResponse.json({ ok: false, error: "没有找到应用。" }, { status: 404 });
      if (app.reviewStatus !== "approved" && app.authorId !== account?.id) {
        return NextResponse.json({ ok: false, error: "应用尚未通过审核。" }, { status: 403 });
      }
      return NextResponse.json({ ok: true, app: stripPackageLinkForViewer(app, account?.id) });
    }

    const mine = url.searchParams.get("mine") === "1";
    if (mine) {
      if (!account) return NextResponse.json({ ok: true, apps: [] });
      const result = await supabaseRestFetch<unknown[]>(
        `custom_app_market_apps?author_id=eq.${encodeSupabaseFilter(account.id)}&deleted_at=is.null&select=${REST_APP_COLUMNS}&order=updated_at.desc&limit=100`,
      );
      if (!result.ok) return NextResponse.json({ ok: false, apps: [], error: mapSupabaseError(result.error) }, { status: result.status });
      return NextResponse.json({ ok: true, apps: result.data.map(normalizeMarketItem).filter(Boolean) });
    }

    const result = await supabaseRestFetch<unknown[]>(
      `custom_app_market_apps?review_status=eq.approved&deleted_at=is.null&select=${REST_APP_COLUMNS}&order=updated_at.desc&limit=80`,
    );
    if (!result.ok) {
      const error = mapSupabaseError(result.error);
      if (/custom-app-market-supabase\.sql/.test(error)) {
        return NextResponse.json({ ok: true, apps: [], setupRequired: true, error });
      }
      return NextResponse.json({ ok: false, apps: [], error }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      apps: result.data.map(raw => stripPackageLinkForViewer(normalizeMarketItem(raw), account?.id)).filter(Boolean),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err), apps: [] }, { status: getSupabaseServerConfig() ? 500 : 503 });
  }
}

export async function POST(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    if (record.validateOnly === true || record.action === "validate") {
      const payload = buildConflictCheckPayload(record);
      if (!cleanText(payload.name, 60)) return NextResponse.json({ ok: false, error: "请先填写 APP 名称。" }, { status: 400 });
      const conflict = await validateMarketConflicts(payload);
      if (conflict) return NextResponse.json({ ok: false, error: conflict }, { status: 409 });
      return NextResponse.json({ ok: true });
    }
    const payload = buildPayload(record, account);
    payload.package_hash = await computePackageHash(String(payload.package_path ?? ""));
    const conflict = await validateMarketConflicts(payload);
    if (conflict) return NextResponse.json({ ok: false, error: conflict }, { status: 409 });
    let result = await supabaseRestFetch<unknown[]>(
      `custom_app_market_apps?select=${REST_APP_COLUMNS}`,
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(payload),
      },
    );
    if (!result.ok && /package_hash/i.test(result.error)) {
      /* 存量库无 package_hash 列:去掉该字段重试,发布不因未跑 SQL 而失败 */
      delete payload.package_hash;
      result = await supabaseRestFetch<unknown[]>(
        `custom_app_market_apps?select=${REST_APP_COLUMNS}`,
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(payload),
        },
      );
    }
    if (!result.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(result.error) }, { status: result.status });
    return NextResponse.json({ ok: true, app: normalizeMarketItem(result.data[0]) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: getSupabaseServerConfig() ? 400 : 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const id = cleanId(record.id);
    if (!id) return NextResponse.json({ ok: false, error: "missing_app_id" }, { status: 400 });
    const existingResult = await supabaseRestFetch<unknown[]>(
      `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&author_id=eq.${encodeSupabaseFilter(account.id)}&deleted_at=is.null&select=${REST_APP_COLUMNS}&limit=1`,
    );
    if (!existingResult.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(existingResult.error) }, { status: existingResult.status });
    const existing = normalizeMarketItem(existingResult.data[0]);
    if (!existing) return NextResponse.json({ ok: false, error: "没有找到可修改的已发布应用。" }, { status: 404 });
    if (record.validateOnly === true || record.action === "validate") {
      const payload = buildConflictCheckPayload(record, existing);
      const conflict = await validateMarketConflicts(payload, existing.id);
      if (conflict) return NextResponse.json({ ok: false, error: conflict }, { status: 409 });
      return NextResponse.json({ ok: true });
    }
    const payload = buildPayload(record, account, existing);
    payload.package_hash = await computePackageHash(String(payload.package_path ?? ""));
    const conflict = await validateMarketConflicts(payload, existing.id);
    if (conflict) return NextResponse.json({ ok: false, error: conflict }, { status: 409 });
    let result = await supabaseRestFetch<unknown[]>(
      `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&author_id=eq.${encodeSupabaseFilter(account.id)}&deleted_at=is.null&select=${REST_APP_COLUMNS}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      },
    );
    if (!result.ok && /package_hash/i.test(result.error)) {
      delete payload.package_hash;
      result = await supabaseRestFetch<unknown[]>(
        `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&author_id=eq.${encodeSupabaseFilter(account.id)}&deleted_at=is.null&select=${REST_APP_COLUMNS}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(payload),
        },
      );
    }
    if (!result.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(result.error) }, { status: result.status });
    const app = normalizeMarketItem(result.data[0]);
    if (!app) return NextResponse.json({ ok: false, error: "没有找到可修改的已发布应用。" }, { status: 404 });
    return NextResponse.json({ ok: true, app });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: getSupabaseServerConfig() ? 400 : 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const id = cleanId(record.id);
    if (!id) return NextResponse.json({ ok: false, error: "missing_app_id" }, { status: 400 });
    if (record.action === "approve" || record.action === "reject") {
      if (!isAppMarketReviewEnabled()) return reviewDisabled();
      if (!requireAppMarketAdminKey(request) && !(await getModeratorContext(request))) return unauthorizedAdmin();
      const reviewStatus = record.action === "approve" ? "approved" : "rejected";
      const result = await supabaseRestFetch<unknown[]>(
        `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&deleted_at=is.null&select=${REST_APP_COLUMNS}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ review_status: reviewStatus, updated_at: new Date().toISOString() }),
        },
      );
      if (!result.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(result.error) }, { status: result.status });
      const app = normalizeMarketItem(result.data[0]);
      if (!app) return NextResponse.json({ ok: false, error: "没有找到应用。" }, { status: 404 });
      return NextResponse.json({ ok: true, app });
    }

    if (record.action !== "increment_install") {
      return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
    }
    const current = await supabaseRestFetch<Array<{ install_count?: unknown }>>(
      `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&select=install_count&limit=1`,
    );
    if (!current.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(current.error) }, { status: current.status });
    const installCount = clampCount(current.data[0]?.install_count) + 1;
    const result = await supabaseRestFetch<unknown[]>(
      `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&select=${REST_APP_COLUMNS}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ install_count: installCount, updated_at: new Date().toISOString() }),
      },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(result.error) }, { status: result.status });
    return NextResponse.json({ ok: true, app: normalizeMarketItem(result.data[0]) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: getSupabaseServerConfig() ? 400 : 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "请先登录账号。" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const id = cleanId(record.id);
    if (!id) return NextResponse.json({ ok: false, error: "missing_app_id" }, { status: 400 });
    const result = await supabaseRestFetch<unknown[]>(
      `custom_app_market_apps?id=eq.${encodeSupabaseFilter(id)}&author_id=eq.${encodeSupabaseFilter(account.id)}&deleted_at=is.null&select=id`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      },
    );
    if (!result.ok) return NextResponse.json({ ok: false, error: mapSupabaseError(result.error) }, { status: result.status });
    if (!Array.isArray(result.data) || result.data.length === 0) {
      return NextResponse.json({ ok: false, error: "没有找到可删除的已发布应用。" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err) }, { status: getSupabaseServerConfig() ? 400 : 503 });
  }
}
