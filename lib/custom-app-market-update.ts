"use client";

import {
  fetchCustomAppMarketItemByAppId,
  fetchCustomAppMarketItems,
  fetchMyCustomAppMarketItems,
} from "./custom-app-market-client";
import type { CustomAppMarketItem } from "./custom-app-market-types";
import {
  applyCustomAppRegistrationsAsync,
  type CustomAppRegistrationSummary,
  removeCustomAppRegistrationsAsync,
} from "./custom-app-registration";
import {
  installCustomAppAsync,
  loadCustomAppPackage,
  loadSingleHtmlCustomApp,
} from "./custom-app-storage";
import type { InstalledCustomApp } from "./custom-app-types";

export type CustomAppMarketUpdateResult = {
  item: CustomAppMarketItem;
  installed: InstalledCustomApp;
  registration: CustomAppRegistrationSummary;
  previousVersion: string;
};

export function appWithCustomAppMarketMetadata(app: InstalledCustomApp, item: CustomAppMarketItem): InstalledCustomApp {
  return {
    ...app,
    id: item.appId,
    name: item.name,
    version: item.version,
    description: item.description ?? app.description,
    iconDataUrl: item.iconDataUrl ?? app.iconDataUrl,
    marketItemId: item.id,
    manifest: {
      ...app.manifest,
      name: item.name,
      version: item.version,
      description: item.description ?? app.manifest.description,
      permissions: app.permissions,
    },
  };
}

export function newestCustomAppMarketItem(items: CustomAppMarketItem[], appId: string): CustomAppMarketItem | null {
  let match: CustomAppMarketItem | null = null;
  for (const item of items) {
    if (item.appId !== appId) continue;
    if (!match || new Date(item.updatedAt).getTime() > new Date(match.updatedAt).getTime()) {
      match = item;
    }
  }
  return match;
}

function parseVersionParts(value: string): number[] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^[vV]/, "");
  if (!/^\d+(?:[._-]\d+)*$/.test(normalized)) return null;
  return normalized.split(/[._-]/).map(part => Number(part));
}

export function compareCustomAppVersions(a: string, b: string): number | null {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (!left || !right) return null;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

export function isCustomAppMarketItemNewerThanInstalled(app: InstalledCustomApp, item: CustomAppMarketItem): boolean {
  if (item.appId !== app.id) return false;
  const versionCompare = compareCustomAppVersions(item.version, app.version);
  if (versionCompare !== null) {
    return versionCompare > 0;
  }
  return item.version.trim() !== app.version.trim();
}

export async function resolveCustomAppMarketItemForInstalled(appId: string): Promise<CustomAppMarketItem | null> {
  let exactError: unknown = null;
  try {
    const exact = await fetchCustomAppMarketItemByAppId(appId);
    if (exact) return exact;
  } catch (err) {
    exactError = err;
  }

  const [publicResult, ownResult] = await Promise.allSettled([
    fetchCustomAppMarketItems(),
    fetchMyCustomAppMarketItems(),
  ]);
  if (publicResult.status === "rejected" && ownResult.status === "rejected") {
    const reason = exactError ?? publicResult.reason;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
  const publicApps = publicResult.status === "fulfilled" ? publicResult.value : [];
  const ownApps = ownResult.status === "fulfilled" ? ownResult.value : [];
  return newestCustomAppMarketItem([...publicApps, ...ownApps], appId);
}

/** 向服务端换一个短时签名下载地址（登录 + 限频 + 留痕）；市场数据里不再对非作者下发包直链。 */
async function requestPackageDownloadUrl(itemId: string): Promise<string> {
  const response = await fetch("/api/app-market/download", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: itemId }),
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
  if (!response.ok || data.ok !== true || !data.url) {
    throw new Error(String(data.error ?? `应用包下载授权失败（HTTP ${response.status}）`));
  }
  return data.url;
}

export async function loadCustomAppMarketPackageApp(item: CustomAppMarketItem): Promise<InstalledCustomApp> {
  let url = "";
  try {
    url = await requestPackageDownloadUrl(item.id);
  } catch (err) {
    // 换签失败：作者自己的条目仍带直链可回落；其他人把授权错误（限频/未登录）如实抛给界面
    if (!item.packageUrl) throw err instanceof Error ? err : new Error("应用包下载失败");
  }
  if (!url) url = item.packageUrl;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`应用包下载失败：HTTP ${response.status}`);
  const blob = await response.blob();
  const suffix = item.packageKind === "html" ? "html" : item.packageKind === "floatapp" ? "floatapp" : "zip";
  const type = item.packageKind === "html" ? "text/html" : "application/zip";
  const file = new File([blob], `${item.appId}.${suffix}`, { type: blob.type || type });
  const app = item.packageKind === "html"
    ? await loadSingleHtmlCustomApp(file)
    : await loadCustomAppPackage(file);
  return appWithCustomAppMarketMetadata(app, item);
}

export async function updateInstalledCustomAppFromMarket(
  app: InstalledCustomApp,
  options: {
    resolveMarketItem?: (appId: string) => Promise<CustomAppMarketItem | null>;
  } = {},
): Promise<CustomAppMarketUpdateResult> {
  const item = await (options.resolveMarketItem ?? resolveCustomAppMarketItemForInstalled)(app.id);
  if (!item) {
    throw new Error("市场里没有找到这个 APP 的发布记录，可能是本地导入或作者已下架。");
  }

  const nextApp = await loadCustomAppMarketPackageApp(item);
  let removedOldRegistrations = false;
  try {
    await removeCustomAppRegistrationsAsync(app.id, { deleteResources: true });
    removedOldRegistrations = true;
    const installed = await installCustomAppAsync({
      ...nextApp,
      installedAt: app.installedAt,
      updatedAt: new Date().toISOString(),
    });
    const registration = await applyCustomAppRegistrationsAsync(installed);
    return {
      item,
      installed,
      registration,
      previousVersion: app.version,
    };
  } catch (err) {
    if (removedOldRegistrations) {
      try {
        await installCustomAppAsync(app);
        await applyCustomAppRegistrationsAsync(app);
      } catch {
        // Best-effort rollback for app-bundled preset/regex/worldbook registrations.
      }
    }
    throw err;
  }
}
