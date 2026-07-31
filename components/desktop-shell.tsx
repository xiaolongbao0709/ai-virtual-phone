"use client";

import { Component, memo, useCallback, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from "react";

import { updateStatusBarTone } from "@/lib/bg-tone";
import { startDiaryEntryTimerService, stopDiaryEntryTimerService } from "@/lib/diary-entry-timer-service";
import { startFollowUpService, stopFollowUpService } from "@/lib/follow-up-service";
import { startMomentsService, stopMomentsService } from "@/lib/moments-engine";
import { bgTimerCleanup } from "@/lib/bg-timer";
import { PhoneThemeApp } from "@/components/phone-theme-app";
import { PhoneCharacterApp } from "@/components/phone-character-app";
import { PhoneSettingsApp } from "@/components/phone-settings-app";
import { PhoneChatApp } from "@/components/chat/phone-chat-app";
import { PhonePlaceholderApp } from "@/components/phone-placeholder-app";
import MusicApp from "@/components/music/music-app";
import MusicPlayer from "@/components/music/music-player";
import MusicFloat from "@/components/music/music-float";
import MiniAppWindow from "@/components/music/mini-app-window";
import { PhoneCalendarApp } from "@/components/calendar-app";
import { DiaryApp } from "@/components/diary/diary-app";
import { XiaohongshuApp } from "@/components/xiaohongshu/xiaohongshu-app";
import { StoryApp } from "@/components/story/story-app";
import { VnApp } from "@/components/vn/vn-app";
import ReadingApp from "@/components/reading/reading-app";
import MapApp from "@/components/map/map-app";
import { DwellingApp } from "@/components/dwelling/dwelling-app";
import { MascotFloat } from "@/components/mascot/mascot-float";
import { useMusicControlsOptional } from "@/lib/music-context";
import { PhoneResourcesApp, type ResourceSubPage } from "@/components/phone-resources-app";
import { CheckPhoneApp } from "@/components/checkphone/checkphone-app";
import { ShoppingApp } from "@/components/shopping/shopping-app";
import { GameHubApp } from "@/components/game/game-hub-app";
import InterviewMagazineApp from "@/components/interview/interview-magazine-app";
import { CoCreateApp } from "@/components/cocreate/cocreate-app";
import { AppMarketApp } from "@/components/app-market/app-market-app";
import { CustomAppRunner } from "@/components/app-market/custom-app-runner";
import { hydrateKvDb, kvGet, kvSet, kvRemove, kvKeysWithPrefix } from "@/lib/kv-db";
import { deleteDatabase } from "@/lib/data-management/idb";
import { hydrateStoryStorage } from "@/lib/story-storage";
import { hydrateMomentsStorage } from "@/lib/moments-storage";
import { hydrateVnStorage } from "@/lib/vn-storage";
import { hydrateSettingsDb } from "@/lib/settings-db";
import { hydrateDwellingStorage } from "@/lib/dwelling-storage";
import { hydrateCheckPhoneStorage } from "@/lib/checkphone-storage";
import {
  DOCK_DEFAULT,
  ICONS,
  PAGE_1_DEFAULT,
  PAGE_2_DEFAULT,
  PAGE_3_DEFAULT,
  type DesktopIconId,
  type IconId,
  type IconPosition
} from "@/lib/desktop-config";
import { customAppIdFromIconId, isCustomAppIconId, toCustomAppIconId } from "@/lib/custom-app-types";
import type { InstalledCustomApp } from "@/lib/custom-app-types";
import {
  registerCustomAppBackgroundToolExecutor,
  type CustomAppToolExecutorPayload,
} from "@/lib/custom-app-tool-runtime";
import {
  CUSTOM_APPS_UPDATED_EVENT,
  loadInstalledCustomApps,
} from "@/lib/custom-app-storage";
import {
  isCustomAppMarketItemNewerThanInstalled,
  resolveCustomAppMarketItemForInstalled,
  updateInstalledCustomAppFromMarket,
} from "@/lib/custom-app-market-update";
import type { CustomAppMarketItem } from "@/lib/custom-app-market-types";
import {
  CUSTOM_APP_HOST_STATE_UPDATED_EVENT,
  loadCustomAppBadges,
  runDueCustomAppTasks,
} from "@/lib/custom-app-host-api";
import { CustomAppGlyph, IconGlyph } from "@/components/icon-glyph";
import { DesktopCustomizer } from "@/components/desktop-customizer";
import {
  collectThemeAssetIds,
  getThemeAssetMap,
  readThemeProfile,
  writeThemeProfile
} from "@/lib/theme-storage";
import {
  DEFAULT_THEME_PROFILE,
  DEFAULT_FONT_FAMILY,
  normalizeThemeProfile,
  resolveActiveIconSkins,
  type ThemeProfile
} from "@/lib/theme-types";
import { GRID_COLS, GRID_ROWS, WIDGET_SIZE_CELLS, WIDGET_CATALOG, type WidgetInstance, type WidgetType } from "@/lib/widget-types";
import { buildOccupancyGrid, canPlaceWidget, placeWidget, createDefaultWidgets, loadWidgets, saveWidgets, loadDIYTemplates, saveDIYTemplates } from "@/lib/widget-storage";
import {
  createDefaultDesktopIconLayout,
  getDesktopIconLayoutItems,
  getDesktopPageKey,
  getDesktopPageKeys,
  getDesktopPageNumber,
  loadDockLayout,
  normalizeDock,
  writeDockLayout,
  DOCK_LAYOUT_STORAGE_KEY,
  DOCK_MAX,
  type DesktopIconLayout,
  type DesktopPageKey,
} from "@/lib/desktop-layout-storage";
import { WidgetRenderer } from "@/components/widgets/widget-renderer";
import type { DIYWidgetTemplate } from "@/lib/widget-types";
import { DebugPromptPanel } from "@/components/debug-prompt-panel";
import { QuickActionFloat } from "@/components/quick-action-float";
import { CHAT_MESSAGE_PUSHED_EVENT, CHAT_REQUEST_REPLY_EVENT, hydrateChatStorage, loadChatSessions, loadChatMessages, pushChatMessage, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { requestBackgroundChatReply, scheduleFollowUp } from "@/lib/follow-up-service";
import { CHAT_MESSAGE_NOTICE_EVENT, CHAT_OPEN_SESSION_EVENT, type ChatMessageNoticeDetail } from "@/lib/chat-notification-events";
import { setMascotContext } from "@/lib/mascot-context";
import { DESKTOP_WIDGETS_CHANGED_EVENT } from "@/lib/mascot-events";
import { useWeixinBridge } from "@/lib/use-weixin-bridge";
import { startWeixinCloudRealtimeSync } from "@/lib/weixin-cloud-sync";
import { sendBrowserNotification } from "@/lib/browser-notification";
import type { ChatSharePayload } from "@/lib/chat-share";
import { completePendingMcpOAuthCallback } from "@/lib/tool-executor";
import { LayoutGrid, LoaderCircle, RefreshCw } from "lucide-react";

const EMOJI_FONTS = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla"';

const ICON_LAYOUT_STORAGE_KEY = "ai_phone_icon_layout_v2";
const ICON_LAYOUT_STORAGE_KEY_V1 = "ai_phone_icon_layout_v1";
// Sentinel "page" used by the drag engine to mean "the dock". getDesktopPageNumber
// returns 0 for it and getDesktopPageKeys filters it out, so page iteration never
// treats the dock as a real page.
const DOCK_PAGE_KEY = "dock" as const;
type DragPageKey = DesktopPageKey | typeof DOCK_PAGE_KEY;
const SWIPE_THRESHOLD_RATIO = 0.2;
const SWIPE_MIN_THRESHOLD = 60;

function parseColorAlpha(value: string): { hex: string; alpha: number } {
  const rgbaMatch = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch) {
    const r = Number(rgbaMatch[1]);
    const g = Number(rgbaMatch[2]);
    const b = Number(rgbaMatch[3]);
    const alpha = rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : 1;
    const hex = `#${[r, g, b].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
    return { hex, alpha: Math.max(0, Math.min(1, alpha)) };
  }

  if (value.startsWith("#")) {
    if (value.length === 9) {
      const alpha = parseInt(value.slice(7, 9), 16) / 255;
      return { hex: value.slice(0, 7), alpha: Math.max(0, Math.min(1, alpha)) };
    }
    if (value.length === 4) {
      return {
        hex: `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`,
        alpha: 1
      };
    }
    return { hex: value, alpha: 1 };
  }

  return { hex: "#000000", alpha: 1 };
}

function buildRgbaColor(hex: string, alpha: number): string {
  const safeAlpha = Math.max(0, Math.min(1, alpha));
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (safeAlpha >= 1) return hex;
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
}

function toCssPx(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return /[a-z%]/i.test(value) ? value : `${value}px`;
}

const TEXT = {
  ariaDesktopIcons: "\u684C\u9762\u56FE\u6807",
  backDesktop: "\u8FD4\u56DE\u684C\u9762",
  placeholderTitle: "\u529F\u80FD\u5360\u4F4D",
  placeholderBody:
    "\u8BE5\u5165\u53E3\u5DF2\u5728\u4EFF\u771F\u624B\u673A\u5185\u9884\u7559\uff0C\u540E\u7EED\u5F00\u53D1\u65F6\u4F1A\u5728\u624B\u673A\u754C\u9762\u5185\u5B8C\u6210\u529F\u80FD\u3002"
};

type DesktopLayout = DesktopIconLayout;

type DesktopShellProps = {
  initialThemeProfile?: ThemeProfile | null;
  initialThemeAssets?: Record<string, string>;
};

type CustomAppReturnTarget = {
  appId: "chat";
  sessionId?: string;
};

type CustomAppLaunchState = {
  appId: string;
  context: Record<string, unknown>;
  returnTo?: CustomAppReturnTarget | null;
};

type CustomAppBackgroundEventRun = {
  id: string;
  app: InstalledCustomApp;
  eventName: string;
  payload: Record<string, unknown>;
  launchContext: Record<string, unknown>;
  timeoutMs?: number;
};

type CustomAppBackgroundToolRun = {
  id: string;
  app: InstalledCustomApp;
  payload: CustomAppToolExecutorPayload;
  launchContext: Record<string, unknown>;
  timeoutMs?: number;
};

type PendingCustomAppBackgroundTool = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

type PendingCustomAppUpdatePrompt = {
  app: InstalledCustomApp;
  item: CustomAppMarketItem;
  launchContext: Record<string, unknown>;
};

const CHAT_CUSTOM_APP_RETURN_SOURCES = new Set(["chat_plus_action", "chat_card", "chat_directive"]);
const CUSTOM_APP_BACKGROUND_RUNNER_TIMEOUT_MS = 5 * 60_000;

type CustomAppEventRecord = {
  event?: unknown;
  entry?: unknown;
  background?: unknown;
  timeoutMs?: unknown;
};

type CustomAppBackgroundRunnerBoundaryProps = {
  runId: string;
  kind: "event" | "tool";
  children: ReactNode;
  onEventError?: (runId: string, result: { ok: boolean; reason: string; errors?: string[] }) => void;
  onToolError?: (runId: string, result: { ok: boolean; reason: string; result?: unknown; error?: string }) => void;
};

type CustomAppBackgroundRunnerBoundaryState = {
  failed: boolean;
};

class CustomAppBackgroundRunnerBoundary extends Component<CustomAppBackgroundRunnerBoundaryProps, CustomAppBackgroundRunnerBoundaryState> {
  state: CustomAppBackgroundRunnerBoundaryState = { failed: false };

  static getDerivedStateFromError(): CustomAppBackgroundRunnerBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[CustomAppBackground] ${this.props.runId} runner crashed: ${message}`, info.componentStack);
    if (this.props.kind === "event") {
      this.props.onEventError?.(this.props.runId, {
        ok: false,
        reason: "runner_crashed",
        errors: [message],
      });
      return;
    }
    this.props.onToolError?.(this.props.runId, {
      ok: false,
      reason: "runner_crashed",
      error: message,
    });
  }

  render(): ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function customAppReturnTargetFromLaunchContext(context: Record<string, unknown>): CustomAppReturnTarget | null {
  const source = String(context.source ?? "");
  if (!CHAT_CUSTOM_APP_RETURN_SOURCES.has(source)) return null;
  const sessionId = typeof context.sessionId === "string" && context.sessionId.trim() ? context.sessionId.trim() : undefined;
  return { appId: "chat", sessionId };
}

function isCustomAppEventRecord(value: unknown): value is CustomAppEventRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function customAppBackgroundTimeoutMs(value: unknown): number {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 30 * 60_000)
    : CUSTOM_APP_BACKGROUND_RUNNER_TIMEOUT_MS;
}

function customAppEventSubscriptions(app: InstalledCustomApp): CustomAppEventRecord[] {
  const canonical = Array.isArray(app.manifest.extensions?.events) ? app.manifest.extensions.events : [];
  const legacy = Array.isArray(app.manifest.events) ? app.manifest.events : [];
  return (canonical.length > 0 ? canonical : legacy).filter(isCustomAppEventRecord);
}

function getBackgroundChatMessageSubscription(app: InstalledCustomApp) {
  return customAppEventSubscriptions(app).find(event => (
    event.background === true
    && (event.event === "chat.message.created" || event.event === "*")
  ));
}

function serializeCustomAppBackgroundMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: String(message.content ?? ""),
    createdAt: message.createdAt,
    status: message.status,
    senderName: message.senderName,
    mediaType: message.mediaType,
    mediaData: message.mediaData && typeof message.mediaData === "object" ? message.mediaData : undefined,
    isRetracted: message.isRetracted === true,
    origin: message.origin,
  };
}

/** Convert an IconId array into absolute positions (flow left-to-right, top-to-bottom) */
function flowIconsToPositions(icons: IconId[]): IconPosition[] {
  const result: IconPosition[] = [];
  let idx = 0;
  for (let r = 0; r < GRID_ROWS && idx < icons.length; r++) {
    for (let c = 0; c < GRID_COLS && idx < icons.length; c++) {
      result.push({ id: icons[idx], row: r + 1, col: c + 1 });
      idx++;
    }
  }
  return result;
}

const DEFAULT_LAYOUT: DesktopLayout = createDefaultDesktopIconLayout(createDefaultWidgets());

function getDesktopPageKeysForState(layout: DesktopLayout, widgets: WidgetInstance[] = []): DesktopPageKey[] {
  const maxPage = Math.max(
    2,
    ...getDesktopPageKeys(layout).map(getDesktopPageNumber),
    ...widgets.map((widget) => widget.page).filter((page) => Number.isInteger(page) && page >= 1)
  );
  return Array.from({ length: maxPage }, (_, index) => getDesktopPageKey(index + 1));
}

function cloneDesktopLayout(layout: DesktopLayout, widgets: WidgetInstance[] = []): DesktopLayout {
  const next = {} as DesktopLayout;
  for (const pageKey of getDesktopPageKeysForState(layout, widgets)) {
    next[pageKey] = [...(layout[pageKey] ?? [])];
  }
  return next;
}

function ensureDesktopPage(layout: DesktopLayout, pageKey: DesktopPageKey): void {
  if (!layout[pageKey]) layout[pageKey] = [];
}

function trimEmptyTrailingPages(layout: DesktopLayout, widgets: WidgetInstance[]): DesktopLayout {
  const next = cloneDesktopLayout(layout, widgets);
  let maxPage = Math.max(2, ...getDesktopPageKeysForState(next, widgets).map(getDesktopPageNumber));
  while (maxPage > 2) {
    const pageKey = getDesktopPageKey(maxPage);
    const hasIcons = (next[pageKey] ?? []).length > 0;
    const hasWidgets = widgets.some((widget) => widget.page === maxPage);
    if (hasIcons || hasWidgets) break;
    delete next[pageKey];
    maxPage -= 1;
  }
  return next;
}

function getInstalledCustomIconIds(): Set<string> {
  return new Set(loadInstalledCustomApps().map(app => toCustomAppIconId(app.id)));
}

function migrateLegacyDesktopIconId(id: string, customIconIds = getInstalledCustomIconIds()): DesktopIconId | null {
  if (id === "weibo") return "game";
  if (id === "fortune") return "interview_magazine";
  if (id === "forum") return "cocreate";
  if (isCustomAppIconId(id) && customIconIds.has(id)) return id;
  return id in ICONS ? id as IconId : null;
}

/** Validate an IconPosition[] page, dedup by id and position */
function normalizePageV2(raw: unknown, pageWidgets: WidgetInstance[]): IconPosition[] {
  if (!Array.isArray(raw)) return [];

  const allKnown = new Set<string>(Object.keys(ICONS));
  const customIconIds = getInstalledCustomIconIds();
  const seenIds = new Set<DesktopIconId>();
  const seenCells = new Set<string>();
  const widgetOcc = buildWidgetOccupancy(pageWidgets);
  const result: IconPosition[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, row, col } = item as { id: string; row: number; col: number };
    if (typeof id !== "string" || typeof row !== "number" || typeof col !== "number") continue;
    const iconId = migrateLegacyDesktopIconId(id, customIconIds);
    if (!iconId || (!allKnown.has(iconId) && !customIconIds.has(iconId))) continue;
    if (seenIds.has(iconId)) continue;
    if (row < 1 || row > GRID_ROWS || col < 1 || col > GRID_COLS) continue;
    const cellKey = `${row},${col}`;
    if (seenCells.has(cellKey)) continue;
    if (widgetOcc[row - 1][col - 1]) continue;
    seenIds.add(iconId);
    seenCells.add(cellKey);
    result.push({ id: iconId, row, col });
  }

  return result;
}

/** Migrate v1 (array of IconId|null) to v2 (IconPosition[]) */
function migratePageV1(raw: unknown, defaults: IconId[], pageWidgets: WidgetInstance[]): IconPosition[] {
  const allowed = new Set<IconId>(defaults);
  const seen = new Set<IconId>();
  const ordered: (IconId | null)[] = [];

  const rawItems = Array.isArray(raw) ? raw : [];
  for (const item of rawItems) {
    if (item === null) { ordered.push(null); continue; }
    if (typeof item !== "string") continue;
    const id = migrateLegacyDesktopIconId(item);
    if (!id || !(id in ICONS)) continue;
    const builtinId = id as IconId;
    if (!allowed.has(builtinId) || seen.has(builtinId)) continue;
    seen.add(builtinId);
    ordered.push(builtinId);
  }
  for (const id of defaults) {
    if (!seen.has(id)) ordered.push(id);
  }

  // Flow into absolute positions (same as old computeIconPositions)
  const widgetOcc = buildWidgetOccupancy(pageWidgets);
  const freeCells: { row: number; col: number }[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!widgetOcc[r][c]) freeCells.push({ row: r + 1, col: c + 1 });
    }
  }
  const result: IconPosition[] = [];
  let fi = 0;
  for (const slot of ordered) {
    if (fi >= freeCells.length) break;
    if (slot === null) { fi++; continue; }
    result.push({ id: slot, ...freeCells[fi] });
    fi++;
  }
  return result;
}

function normalizeLayout(raw: unknown, widgets: WidgetInstance[], dockIds: Set<DesktopIconId> = new Set()): DesktopLayout {
  if (!raw || typeof raw !== "object") return createDefaultDesktopIconLayout(widgets);
  const candidate = raw as Record<string, unknown>;
  const maxPage = Math.max(
    2,
    ...Object.keys(candidate).map(getDesktopPageNumber),
    ...widgets.map((widget) => widget.page).filter((page) => Number.isInteger(page) && page >= 1)
  );
  const layout = {} as DesktopLayout;
  for (let page = 1; page <= maxPage; page += 1) {
    const pageKey = getDesktopPageKey(page);
    // Icons that live in the dock must never also appear on a page.
    layout[pageKey] = normalizePageV2(candidate[pageKey], widgets.filter(w => w.page === page))
      .filter((ic) => !dockIds.has(ic.id));
  }

  // Ensure all default icons exist somewhere across desktop pages (but not ones
  // the user has moved into the dock). DOCK_DEFAULT 也纳入兜底：若某默认 dock
  // 图标（如设置）既不在任何页面也不在 dock（如恢复默认/导入主题后 dock 未含它），
  // 就近放回页面，防止图标彻底丢失。
  const allPlaced = new Set<DesktopIconId>(getDesktopIconLayoutItems(layout).map(ic => ic.id));
  const allDefaults = [...PAGE_1_DEFAULT, ...PAGE_2_DEFAULT, ...PAGE_3_DEFAULT, ...DOCK_DEFAULT];

  for (const id of allDefaults) {
    if (allPlaced.has(id) || dockIds.has(id)) continue;
    const primaryPage = PAGE_1_DEFAULT.includes(id) ? 1 : PAGE_2_DEFAULT.includes(id) ? 2 : PAGE_3_DEFAULT.includes(id) ? 3 : 1;
    const fallbackPages = getDesktopPageKeysForState(layout, widgets)
      .map(getDesktopPageNumber)
      .filter((page) => page !== primaryPage);
    for (const page of [primaryPage, ...fallbackPages]) {
      const pageKey = getDesktopPageKey(page);
      ensureDesktopPage(layout, pageKey);
      const widgetOcc = buildWidgetOccupancy(widgets.filter(w => w.page === page));
      const usedCells = new Set(layout[pageKey].map(ic => `${ic.row},${ic.col}`));
      const free = findNearestFreeCell(1, 1, widgetOcc, usedCells);
      if (free) {
        layout[pageKey] = [...layout[pageKey], { id, row: free.row, col: free.col }];
        allPlaced.add(id);
        break;
      }
    }
  }

  return trimEmptyTrailingPages(layout, widgets);
}

function StatusClock() {
  const [label, setLabel] = useState("--:--");

  useEffect(() => {
    const update = () => {
      setLabel(
        new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
      );
    };
    update();
    const timer = window.setInterval(update, 10000);
    return () => window.clearInterval(timer);
  }, []);

  return <span className="status-time">{label}</span>;
}

function collectCssOverrides(profile: ThemeProfile): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.cssOverrides)) {
    if (!key.startsWith("--")) continue;
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    overrides[key] = normalized;
  }
  return overrides;
}

function readInitialThemeProfile(): ThemeProfile {
  if (typeof window === "undefined") {
    return normalizeThemeProfile(DEFAULT_THEME_PROFILE);
  }
  return readThemeProfile();
}

/** Build a boolean grid marking cells occupied by widgets on one page */
function buildWidgetOccupancy(pageWidgets: WidgetInstance[]): boolean[][] {
  const grid: boolean[][] = Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => false)
  );
  for (const w of pageWidgets) {
    const [rows, cols] = WIDGET_SIZE_CELLS[w.size];
    for (let dr = 0; dr < rows; dr++) {
      for (let dc = 0; dc < cols; dc++) {
        const r = w.row - 1 + dr;
        const c = w.col - 1 + dc;
        if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
          grid[r][c] = true;
        }
      }
    }
  }
  return grid;
}

/** Convert IconPosition[] to the Map the renderer consumes */
function computeIconPositions(
  pageIcons: IconPosition[],
  _pageWidgets: WidgetInstance[]
): Map<DesktopIconId, { row: number; col: number }> {
  const positions = new Map<DesktopIconId, { row: number; col: number }>();
  for (const icon of pageIcons) {
    positions.set(icon.id, { row: icon.row, col: icon.col });
  }
  return positions;
}

/** Find nearest free cell to (fromRow, fromCol). Returns 1-based coords. */
function findNearestFreeCell(
  fromRow: number, fromCol: number,
  widgetOcc: boolean[][],
  usedCells: Set<string>,
): { row: number; col: number } | null {
  let bestDist = Infinity;
  let best: { row: number; col: number } | null = null;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (widgetOcc[r][c]) continue;
      const key = `${r + 1},${c + 1}`;
      if (usedCells.has(key)) continue;
      const dist = Math.abs(r + 1 - fromRow) * GRID_COLS + Math.abs(c + 1 - fromCol);
      if (dist < bestDist) { bestDist = dist; best = { row: r + 1, col: c + 1 }; }
    }
  }
  return best;
}

/** Displace only icons that overlap with widgets. Others stay put.
 *  Returns { placed, overflow } — overflow icons had no room on this page. */
function displaceIconsForWidgets(
  icons: IconPosition[],
  pageWidgets: WidgetInstance[],
): { placed: IconPosition[]; overflow: IconPosition[] } {
  const widgetOcc = buildWidgetOccupancy(pageWidgets);
  const placed: IconPosition[] = [];
  const usedCells = new Set<string>();
  const displaced: IconPosition[] = [];

  for (const icon of icons) {
    if (widgetOcc[icon.row - 1]?.[icon.col - 1]) {
      displaced.push(icon);
    } else {
      placed.push(icon);
      usedCells.add(`${icon.row},${icon.col}`);
    }
  }

  const overflow: IconPosition[] = [];
  for (const icon of displaced) {
    const free = findNearestFreeCell(icon.row, icon.col, widgetOcc, usedCells);
    if (free) {
      placed.push({ id: icon.id, row: free.row, col: free.col });
      usedCells.add(`${free.row},${free.col}`);
    } else {
      overflow.push(icon);
    }
  }

  return { placed, overflow };
}

function placeIconOnAvailablePage(
  layout: DesktopLayout,
  widgets: WidgetInstance[],
  icon: IconPosition,
  startPage: number,
): void {
  const maxPage = Math.max(
    2,
    startPage,
    ...getDesktopPageKeysForState(layout, widgets).map(getDesktopPageNumber)
  );
  for (let page = Math.max(1, startPage); page <= maxPage + 1; page += 1) {
    const pageKey = getDesktopPageKey(page);
    ensureDesktopPage(layout, pageKey);
    const widgetOcc = buildWidgetOccupancy(widgets.filter(w => w.page === page));
    const usedCells = new Set(layout[pageKey].map(ic => `${ic.row},${ic.col}`));
    const free = findNearestFreeCell(icon.row, icon.col, widgetOcc, usedCells);
    if (!free) continue;
    layout[pageKey] = [...layout[pageKey], { id: icon.id, row: free.row, col: free.col }];
    return;
  }
}

/** Convert pointer screen position to a grid cell (0-based) */
function pointerToGridCell(
  px: number,
  py: number,
  gridEl: HTMLElement
): { row: number; col: number } | null {
  const rect = gridEl.getBoundingClientRect();
  const computed = getComputedStyle(gridEl);
  const colWidths = computed.gridTemplateColumns.split(/\s+/).map(parseFloat);
  const colWidth = colWidths[0] || 66;
  const colGap = parseFloat(computed.columnGap) || 20;
  const rowGap = parseFloat(computed.rowGap) || 0;
  /* rect 高度是 border-box（含 padding），网格行轨道只占内容盒。 */
  const padY = (parseFloat(computed.paddingTop) || 0) + (parseFloat(computed.paddingBottom) || 0);
  const contentWidth = colWidths.length * colWidth + (colWidths.length - 1) * colGap;
  const originX = rect.left + (rect.width - contentWidth) / 2;
  const originY = rect.top + (parseFloat(computed.paddingTop) || 0);
  const colStep = colWidth + colGap;
  const totalRowGap = (GRID_ROWS - 1) * rowGap;
  const rowHeight = (rect.height - padY - totalRowGap) / GRID_ROWS;
  const rowStep = rowHeight + rowGap;
  const col = Math.floor((px - originX) / colStep);
  const row = Math.floor((py - originY) / rowStep);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return null;
  return { row, col };
}

function sanitizeWidgetsForLayout(_layout: DesktopLayout, widgets: WidgetInstance[]): WidgetInstance[] {
  const normalized: WidgetInstance[] = [];
  const pageNumbers = getDesktopPageKeysForState(_layout, widgets).map(getDesktopPageNumber);

  for (const page of pageNumbers) {
    for (const w of widgets.filter((widget) => widget.page === page)) {
      // Widget-only collision: pass empty icons so icons don't block widget placement
      const grid = buildOccupancyGrid([], normalized, page);
      if (canPlaceWidget(grid, w.size, w.row, w.col)) {
        normalized.push(w);
      }
    }
  }

  return normalized;
}

function sameWidgetOrder(a: WidgetInstance[], b: WidgetInstance[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.page !== y.page ||
      x.row !== y.row ||
      x.col !== y.col ||
      x.size !== y.size ||
      x.type !== y.type
    ) {
      return false;
    }
  }
  return true;
}

type KeyboardTargetRect = {
  top: number;
  bottom: number;
};

function isKeyboardEditableElement(element: EventTarget | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLSelectElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;

  const type = element.type.toLowerCase();
  return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
}

function shouldBypassDesktopItemPointerCapture(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("[data-ui='modal'], .modal-overlay, .modal-dialog, .modal-sheet, .modal-expand")) return true;
  return isKeyboardEditableElement(target);
}

function parseCssPixels(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function measureTextareaCaretRect(textarea: HTMLTextAreaElement): KeyboardTargetRect {
  const selectionStart = textarea.selectionStart ?? textarea.value.length;
  const computed = window.getComputedStyle(textarea);
  const rect = textarea.getBoundingClientRect();
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  const fontSize = parseCssPixels(computed.fontSize, 14);
  const lineHeight = computed.lineHeight === "normal" ? fontSize * 1.2 : parseCssPixels(computed.lineHeight, fontSize * 1.2);
  const mirrorProperties = [
    "font-family",
    "font-size",
    "font-style",
    "font-variant",
    "font-weight",
    "letter-spacing",
    "text-align",
    "text-indent",
    "text-transform",
    "word-spacing",
    "tab-size",
    "direction",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
  ];

  for (const property of mirrorProperties) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }

  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.left = "-10000px";
  mirror.style.top = "0";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.boxSizing = "border-box";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.wordBreak = computed.getPropertyValue("word-break");
  mirror.style.lineHeight = `${lineHeight}px`;
  mirror.textContent = textarea.value.slice(0, selectionStart);
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  document.body.removeChild(mirror);

  const top = rect.top + markerRect.top - mirrorRect.top - textarea.scrollTop;
  return {
    top,
    bottom: top + lineHeight,
  };
}

function getKeyboardTargetRect(element: HTMLElement): KeyboardTargetRect {
  if (element instanceof HTMLTextAreaElement) {
    return measureTextareaCaretRect(element);
  }

  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
  };
}

function useAndroidCaretKeyboardLift() {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const root = document.documentElement;
    if (!/Android/i.test(navigator.userAgent)) {
      root.style.removeProperty("--mobile-keyboard-lift");
      return;
    }

    const mobileMq = window.matchMedia("(max-width: 500px) and (hover: none) and (pointer: coarse)");
    const viewport = window.visualViewport;
    let focusedElement: HTMLElement | null = null;
    let raf = 0;
    let currentLift = 0;

    const applyLift = (nextLift: number) => {
      const rounded = Math.max(0, Math.round(nextLift));
      if (Math.abs(rounded - currentLift) < 2) return;
      currentLift = rounded;
      if (rounded > 0) {
        root.style.setProperty("--mobile-keyboard-lift", `${rounded}px`);
      } else {
        root.style.removeProperty("--mobile-keyboard-lift");
      }
    };

    const update = () => {
      raf = 0;
      const element = focusedElement;
      if (!element || document.activeElement !== element || !mobileMq.matches || !viewport) {
        applyLift(0);
        return;
      }

      const keyboardTop = viewport.offsetTop + viewport.height;
      const keyboardInset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      const targetRect = getKeyboardTargetRect(element);
      const gap = 36;

      if (keyboardInset < 80) {
        applyLift(0);
        return;
      }

      const naturalBottom = targetRect.bottom + currentLift;
      const neededLift = Math.max(0, naturalBottom + gap - keyboardTop);
      applyLift(Math.min(keyboardInset, neededLift));
    };

    const requestUpdate = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(update);
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!isKeyboardEditableElement(target)) return;
      focusedElement = target;
      requestUpdate();
    };

    const handleFocusOut = () => {
      focusedElement = null;
      applyLift(0);
    };

    const handleCaretMove = () => {
      if (focusedElement) requestUpdate();
    };

    const handleViewportChange = () => {
      if (focusedElement) requestUpdate();
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("click", handleCaretMove, true);
    document.addEventListener("keyup", handleCaretMove, true);
    document.addEventListener("input", handleCaretMove, true);
    viewport?.addEventListener("resize", handleViewportChange);
    viewport?.addEventListener("scroll", handleViewportChange);

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("click", handleCaretMove, true);
      document.removeEventListener("keyup", handleCaretMove, true);
      document.removeEventListener("input", handleCaretMove, true);
      viewport?.removeEventListener("resize", handleViewportChange);
      viewport?.removeEventListener("scroll", handleViewportChange);
      root.style.removeProperty("--mobile-keyboard-lift");
    };
  }, []);
}

type MusicOverlayController = {
  closeFullPlayer: () => void;
};

const MusicShellOverlays = memo(function MusicShellOverlays({
  activeApp,
  onControllerChange,
}: {
  activeApp: DesktopIconId | null;
  onControllerChange: (controller: MusicOverlayController | null) => void;
}) {
  const musicPlayer = useMusicControlsOptional();

  useEffect(() => {
    onControllerChange(musicPlayer ? { closeFullPlayer: musicPlayer.closeFullPlayer } : null);
  }, [musicPlayer?.closeFullPlayer, onControllerChange]);

  return (
    <>
      {musicPlayer?.showFullPlayer && musicPlayer.currentTrack && <MusicPlayer />}
      <MusicFloat hidden={activeApp === "music" || musicPlayer?.showFullPlayer} />
    </>
  );
});

export function DesktopShell({ initialThemeProfile, initialThemeAssets }: DesktopShellProps) {
  const musicOverlayControllerRef = useRef<MusicOverlayController | null>(null);
  const handleMusicOverlayControllerChange = useCallback((controller: MusicOverlayController | null) => {
    musicOverlayControllerRef.current = controller;
  }, []);
  useAndroidCaretKeyboardLift();
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [layout, setLayout] = useState<DesktopLayout>(DEFAULT_LAYOUT);
  // Dock is an ordered icon-id list (max DOCK_MAX), kept disjoint from `layout`.
  const [dock, setDock] = useState<DesktopIconId[]>(DOCK_DEFAULT);
  const [desktopReady, setDesktopReady] = useState(false);
  const [glassPaintPass, setGlassPaintPass] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeApp, setActiveApp] = useState<DesktopIconId | null>(null);
  const [customApps, setCustomApps] = useState<InstalledCustomApp[]>([]);
  const [customAppUpdatePrompt, setCustomAppUpdatePrompt] = useState<PendingCustomAppUpdatePrompt | null>(null);
  const [customAppUpdateBusy, setCustomAppUpdateBusy] = useState(false);
  const customAppUpdateCheckingRef = useRef<Set<string>>(new Set());
  const activeAppRef = useRef<DesktopIconId | null>(null);
  const [customAppBadges, setCustomAppBadges] = useState<Record<string, number>>({});
  const [customAppBackgroundRuns, setCustomAppBackgroundRuns] = useState<CustomAppBackgroundEventRun[]>([]);
  const [customAppBackgroundToolRuns, setCustomAppBackgroundToolRuns] = useState<CustomAppBackgroundToolRun[]>([]);
  const backgroundRunSeqRef = useRef(0);
  const pendingCustomAppBackgroundToolsRef = useRef<Map<string, PendingCustomAppBackgroundTool>>(new Map());
  const [resourcesInitialPage, setResourcesInitialPage] = useState<ResourceSubPage>("main");
  const [dwellingMounted, setDwellingMounted] = useState(false);
  const [xiaohongshuMounted, setXiaohongshuMounted] = useState(false);
  const [xiaohongshuBusy, setXiaohongshuBusy] = useState(false);
  const [shoppingMounted, setShoppingMounted] = useState(false);
  const [shoppingBusy, setShoppingBusy] = useState(false);
  if (activeApp === "dwelling" && !dwellingMounted) setDwellingMounted(true);
  if (activeApp === "xiaohongshu" && !xiaohongshuMounted) setXiaohongshuMounted(true);
  if (activeApp === "shopping" && !shoppingMounted) setShoppingMounted(true);
  const [widgets, setWidgets] = useState<WidgetInstance[]>([]);
  const [incomingCall, setIncomingCall] = useState<{
    sessionId: string; type: "voice" | "video"; charName: string; charAvatar: string | null; isGroup?: boolean;
  } | null>(null);
  const [chatMessageNotice, setChatMessageNotice] = useState<{
    sessionId: string;
    title: string;
    body: string;
    avatar: string | null;
    isGroup?: boolean;
  } | null>(null);
  const chatMessageNoticeTimerRef = useRef<number | null>(null);
  // Swipe-up-to-dismiss state for the chat message notice banner.
  const [noticeDragY, setNoticeDragY] = useState(0);
  const noticeDragRef = useRef({ startY: 0, dy: 0, dragging: false, far: false });
  const [musicCustomCss, setMusicCustomCss] = useState(() =>
    typeof window !== "undefined" ? kvGet("music-custom-css") || "" : ""
  );
  const [savedTheme, setSavedTheme] = useState<ThemeProfile>(() => initialThemeProfile ?? readInitialThemeProfile());
  const [draftTheme, setDraftTheme] = useState<ThemeProfile>(() => initialThemeProfile ?? readInitialThemeProfile());
  useEffect(() => {
    activeAppRef.current = activeApp;
  }, [activeApp]);
  // Listen for theme CSS updates from 小卷
  useEffect(() => {
    const onThemeUpdate = () => {
      const fresh = readThemeProfile();
      setDraftTheme(prev => ({ ...prev, globalCustomCSS: fresh.globalCustomCSS }));
    };
    window.addEventListener("theme-css-updated", onThemeUpdate);

    // Listen for iframe communication (DIY Widgets)
    const onIframeMessage = (e: MessageEvent) => {
      if (e.data?.type === "OS_CMD") {
        if (e.data.action === "open_app" && typeof e.data.appId === "string") {
          setActiveApp(e.data.appId as DesktopIconId);
        } else if (e.data.action === "show_notice" && typeof e.data.message === "string") {
          setNotice(e.data.message);
        } else if (e.data.action === "simulate_call" && typeof e.data.charName === "string") {
          setIncomingCall({
            sessionId: `diy-${Date.now()}`,
            type: "voice",
            charName: e.data.charName,
            charAvatar: e.data.charAvatar || null,
          });
        }
      }
    };
    window.addEventListener("message", onIframeMessage);

    return () => {
      window.removeEventListener("theme-css-updated", onThemeUpdate);
      window.removeEventListener("message", onIframeMessage);
    };
  }, []);

  const [themeAssets, setThemeAssets] = useState<Record<string, string>>(() => initialThemeAssets ?? {});
  const [slotIconWidth, setSlotIconWidth] = useState<number | null>(null);
  const [slotIconHeight, setSlotIconHeight] = useState<number | null>(null);
  const [slotRowStep, setSlotRowStep] = useState<number | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const glassBusyTimerRef = useRef<number>(0);
  const iconGridRef = useRef<HTMLElement | null>(null);
  const swipeRef = useRef<{
    startX: number;
    startY: number;
    deltaX: number;
    locked: "x" | "y" | null;
    pointerId: number | null;
  }>({ startX: 0, startY: 0, deltaX: 0, locked: null, pointerId: null });
  const swipeLayerRef = useRef<HTMLDivElement | null>(null);

  // ── Edit mode (long-press drag) ──
  const [editMode, setEditMode] = useState(false);
  const [showWidgetPicker, setShowWidgetPicker] = useState(false);
  const [diyTemplates, setDiyTemplates] = useState<DIYWidgetTemplate[]>([]);

  useEffect(() => {
    if (showWidgetPicker) {
      setDiyTemplates(loadDIYTemplates());
    }
  }, [showWidgetPicker]);

  const mergedCatalog = useMemo(() => {
    const diyEntries = diyTemplates.map(t => ({
      type: t.id as WidgetType,
      name: t.name || "DIY组件",
      desc: t.mode === "image" ? "图片贴纸" : "自定义代码",
      size: t.size,
      track: "freestyle" as const
    }));
    return [...WIDGET_CATALOG, ...diyEntries];
  }, [diyTemplates]);

  const [widgetPickerTab, setWidgetPickerTab] = useState<"standard" | "freestyle">("standard");
  const [showDesktopCustomizer, setShowDesktopCustomizer] = useState(false);
  const pageKeys = useMemo(() => getDesktopPageKeysForState(layout, widgets), [layout, widgets]);
  const pageCount = pageKeys.length;
  const [dragItem, setDragItem] = useState<{
    type: "icon" | "widget";
    id: string;
    sourcePage: DragPageKey;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    page: DesktopPageKey;
    row: number; // 1-based
    col: number; // 1-based
  } | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const dockElRef = useRef<HTMLElement | null>(null);
  const gridRefs = useRef<Record<string, HTMLElement | null>>({ page1: null, page2: null });

  // ── FLIP：编辑/拖拽中，图标与组件"让位"时平滑滑动到新格（grid 行列本身不可过渡）──
  // 坐标取相对所在 icon-grid 的局部值，整页横滑平移不会误触发动画。
  const flipRectsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  useLayoutEffect(() => {
    const editing = editMode || dragItem !== null;
    if (!editing) {
      if (flipRectsRef.current.size) flipRectsRef.current = new Map();
      return;
    }
    const prev = flipRectsRef.current;
    const next = new Map<string, { x: number; y: number }>();
    const entries: Array<{ el: HTMLElement; key: string; x: number; y: number }> = [];
    for (const pageKey of pageKeys) {
      const grid = gridRefs.current[pageKey];
      if (!grid) continue;
      // 测量前清掉上一轮 FLIP 残留的 transform，避免量到动画中间值（同步无重绘，安全）
      const els = grid.querySelectorAll<HTMLElement>("[data-flip-id]");
      els.forEach((el) => {
        if (el.dataset.flipActive) {
          el.style.transition = "none";
          el.style.transform = "";
          delete el.dataset.flipActive;
          el.removeAttribute("data-flip-active");
        }
      });
      const gridRect = grid.getBoundingClientRect();
      els.forEach((el) => {
        const key = `${pageKey}|${el.dataset.flipId}`;
        const r = el.getBoundingClientRect();
        const x = r.left - gridRect.left;
        const y = r.top - gridRect.top;
        next.set(key, { x, y });
        entries.push({ el, key, x, y });
      });
    }
    const moved: HTMLElement[] = [];
    for (const item of entries) {
      const before = prev.get(item.key);
      if (!before) continue;
      const dx = before.x - item.x;
      const dy = before.y - item.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      if (item.el.classList.contains("dragging") || item.el.closest(".dragging")) continue;
      item.el.style.transition = "none";
      item.el.style.transform = `translate(${dx}px, ${dy}px)`;
      item.el.dataset.flipActive = "1";
      item.el.setAttribute("data-flip-active", "1");
      moved.push(item.el);
    }
    if (moved.length) {
      // 强制一次 reflow，让起始 transform 先生效
      void moved[0].offsetWidth;
      for (const el of moved) {
        el.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        el.style.transform = "";
      }
      window.setTimeout(() => {
        for (const el of moved) {
          el.style.transition = "";
          delete el.dataset.flipActive;
          el.removeAttribute("data-flip-active");
        }
      }, 240);
    }
    flipRectsRef.current = next;
  });
  const longPressRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    pointerId: number;
    startX: number;
    startY: number;
    itemType: "icon" | "widget";
    itemId: string;
    page: DragPageKey;
    element: HTMLElement;
  } | null>(null);
  const editDragRef = useRef<{
    active: boolean;
    pending: boolean;
    itemType: "icon" | "widget";
    itemId: string;
    sourcePage: DragPageKey;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    edgeTimer: ReturnType<typeof setTimeout> | null;
    lastTargetKey: string;
    // Drop target (stored in ref so commitDrop always reads the latest value)
    targetPage: DragPageKey | null;
    targetRow: number; // 1-based
    targetCol: number; // 1-based
    // Insertion index within the dock when targetPage === DOCK_PAGE_KEY
    targetDockIndex: number;
    // For widgets: grab offset in grid cells (so pointer cell → widget top-left)
    grabCellRow: number;
    grabCellCol: number;
    element: HTMLElement;
    ghostW: number;
    ghostH: number;
    // Ghost lives INSIDE .phone-shell (so theme/glass CSS applies to the clone);
    // it is absolutely positioned, so viewport coords must subtract the shell origin.
    shellLeft: number;
    shellTop: number;
    initialLayout: DesktopLayout;
    initialWidgets: WidgetInstance[];
    initialDock: DesktopIconId[];
  } | null>(null);
  const editTapRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // Refs to latest state for use in stable callbacks
  const currentPageIndexRef = useRef(currentPageIndex);
  currentPageIndexRef.current = currentPageIndex;
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const dockRef = useRef(dock);
  dockRef.current = dock;

  const activeIconSkins = useMemo(() => resolveActiveIconSkins(draftTheme), [draftTheme]);
  const themeAssetKey = useMemo(() => collectThemeAssetIds(draftTheme).sort().join("|"), [draftTheme]);
  const wallpaperDataUrl = draftTheme.wallpaperAssetId ? themeAssets[draftTheme.wallpaperAssetId] ?? null : null;
  const fontDataUrl = draftTheme.fontAssetId ? themeAssets[draftTheme.fontAssetId] ?? null : null;
  const dockSkinUrl = draftTheme.dockSkinAssetId ? themeAssets[draftTheme.dockSkinAssetId] ?? null : null;
  const resolvedOutlineWidth = toCssPx(draftTheme.cssOverrides["--desktop-outline-width"], "1.5px");
  const outlineOpacity = Number(draftTheme.cssOverrides["--desktop-outline-opacity"] || "1");
  const { hex: outlineHex, alpha: borderBaseAlpha } = parseColorAlpha(draftTheme.globalBorderColor || "#000000");
  const resolvedOutlineColor = buildRgbaColor(
    outlineHex,
    borderBaseAlpha * Math.max(0, Math.min(1, Number.isFinite(outlineOpacity) ? outlineOpacity : 1))
  );
  const themeFontFamily = useMemo(() => {
    const fallback = draftTheme.fontFamily || DEFAULT_FONT_FAMILY;
    if (!fontDataUrl) {
      return fallback;
    }
    return `"AIVirtualPhoneUserFont", ${fallback}`;
  }, [draftTheme.fontFamily, fontDataUrl]);
  const cssOverrides = useMemo(
    () => collectCssOverrides(draftTheme),
    [draftTheme]
  );
  const iconEffect = cssOverrides["--desktop-icon-effect"] || "glass";
  const widgetEffect = cssOverrides["--desktop-widget-effect"] || "glass";
  // Without an uploaded font, legacy theme/custom CSS can provide the normal app font.
  // Once a font file is uploaded, that file becomes the authoritative global font.
  const resolvedFontFamily = useMemo(() => {
    if (fontDataUrl) return themeFontFamily;
    // Check if globalCustomCSS contains --app-font-family
    const cssText = draftTheme.globalCustomCSS || "";
    const match = cssText.match(/--app-font-family\s*:\s*([^;}]+)/);
    if (match) return match[1].trim();
    // Check cssOverrides
    if (cssOverrides["--app-font-family"]) return cssOverrides["--app-font-family"];
    // Fallback to theme setting
    return themeFontFamily;
  }, [draftTheme.globalCustomCSS, cssOverrides, fontDataUrl, themeFontFamily]);

  // Auto-load Google Font for custom font names
  useEffect(() => {
    const match = resolvedFontFamily.match(/^["']?([^"',]+)/);
    if (!match) return;
    const fontName = match[1].trim();
    const systemFonts = [
      "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Noto Serif SC", "Source Han Serif SC", "SF Pro Text", "Inter", "Segoe UI",
      "Microsoft YaHei", "STKaiti", "KaiTi", "Arial", "Helvetica", "AIVirtualPhoneUserFont",
      "Huiwen", "Bodoni Moda", "EB Garamond", "Long Cang", "Special Elite", "Cinzel", "Press Start 2P",
      "Game Hall Fredoka", "Game Hall Caveat", "Game Hall Zen Maru Gothic",
      "NoteWall Ximai", "NoteWall Xiaozhitiao", "NoteWall Huiwen"
    ];
    if (systemFonts.some(f => f.toLowerCase() === fontName.toLowerCase())) return;
    const linkId = "user-google-font";
    let link = document.getElementById(linkId) as HTMLLinkElement | null;
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}&display=swap`;
    if (link) {
      if (link.href === url) return;
      link.href = url;
    } else {
      link = document.createElement("link");
      link.id = linkId;
      link.rel = "stylesheet";
      link.href = url;
      document.head.appendChild(link);
    }
    return () => { document.getElementById(linkId)?.remove(); };
  }, [resolvedFontFamily]);

  // Build theme overrides as a CSS string (injected as <style> tag, NOT inline style)
  // This allows globalCustomCSS to override theme colors without !important
  const themeOverridesCSS = useMemo(() => {
    const { "--app-font-family": _removed, ...restOverrides } = cssOverrides;
    const vars: string[] = [`  --app-font-family: ${resolvedFontFamily}, ${EMOJI_FONTS};`];
    for (const [key, value] of Object.entries(restOverrides)) {
      if (key.startsWith("--") && value) vars.push(`  ${key}: ${value};`);
    }
    return `:root {\n${vars.join("\n")}\n}`;
  }, [cssOverrides, resolvedFontFamily]);
  const uploadedFontOverrideCSS = useMemo(() => {
    if (!fontDataUrl) return "";
    const family = `${themeFontFamily}, ${EMOJI_FONTS}`;
    return [
      `:root {`,
      `  --app-font-family: ${family};`,
      `}`,
      `html body,`,
      `html body *,`,
      `html body *::before,`,
      `html body *::after {`,
      `  font-family: ${family} !important;`,
      `}`
    ].join("\n");
  }, [fontDataUrl, themeFontFamily]);

  // Keep phoneThemeStyle for non-CSS-variable inline styles only (wallpaper, etc.)
  const phoneThemeStyle = useMemo<CSSProperties>(() => {
    return {} as CSSProperties;
  }, []);
  const wallpaperStyle = useMemo<CSSProperties>(() => {
    if (!wallpaperDataUrl) {
      return { backgroundColor: "#ffffff" };
    }
    const whiteMaskAlpha = Number((1 - draftTheme.wallpaperOpacity).toFixed(3));
    return {
      backgroundColor: "#ffffff",
      backgroundImage: `linear-gradient(rgba(255, 255, 255, ${whiteMaskAlpha}), rgba(255, 255, 255, ${whiteMaskAlpha})), url("${wallpaperDataUrl}")`,
      opacity: 1,
      filter: draftTheme.wallpaperBlur ? `blur(${draftTheme.wallpaperBlur}px)` : undefined,
      // blur 会向元素边界外采样、边界外无像素 → 边缘晕开变透。把壁纸层向四周外扩
      // 2×模糊半径，让晕开的边缘落到 .phone-shell 的 overflow:hidden 之外被裁掉，
      // 可视区内始终是实色（边缘不再模糊）。
      inset: draftTheme.wallpaperBlur ? `${-2 * draftTheme.wallpaperBlur}px` : undefined,
      backgroundSize: draftTheme.wallpaperScale !== 100 ? `${draftTheme.wallpaperScale}%` : "cover",
      backgroundPosition: `${draftTheme.wallpaperX}% ${draftTheme.wallpaperY}%`
    };
  }, [
    draftTheme.wallpaperBlur,
    draftTheme.wallpaperOpacity,
    draftTheme.wallpaperScale,
    draftTheme.wallpaperX,
    draftTheme.wallpaperY,
    wallpaperDataUrl
  ]);
  useEffect(() => {
    hydrateKvDb().then(() => {
      const stored = readThemeProfile();
      setSavedTheme(stored);
      setDraftTheme(stored);
      setCustomApps(loadInstalledCustomApps());

      // Reload widgets + layout after hydration
      const hydratedWidgets = loadWidgets();
      setWidgets(hydratedWidgets);
      // Dock loads first so page normalization can keep the two disjoint.
      const hydratedDock = loadDockLayout();
      setDock(hydratedDock);
      const dockIds = new Set<DesktopIconId>(hydratedDock);
      const rawV2 = kvGet(ICON_LAYOUT_STORAGE_KEY);
      if (rawV2) {
        try { setLayout(normalizeLayout(JSON.parse(rawV2), hydratedWidgets, dockIds)); setDesktopReady(true); return; } catch {}
      }
      const rawV1 = kvGet(ICON_LAYOUT_STORAGE_KEY_V1);
      if (rawV1) {
        try {
          const parsed = JSON.parse(rawV1) as Record<string, unknown>;
          const w1 = hydratedWidgets.filter(w => w.page === 1);
          const w2 = hydratedWidgets.filter(w => w.page === 2);
          setLayout({
            page1: migratePageV1(parsed.page1, PAGE_1_DEFAULT, w1).filter(ic => !dockIds.has(ic.id)),
            page2: migratePageV1(parsed.page2, PAGE_2_DEFAULT, w2).filter(ic => !dockIds.has(ic.id)),
          } as DesktopLayout);
          kvRemove(ICON_LAYOUT_STORAGE_KEY_V1);
          setDesktopReady(true);
          return;
        } catch {}
      }
      setLayout(createDefaultDesktopIconLayout(hydratedWidgets));
      setDesktopReady(true);
    });
  }, []);

  useEffect(() => {
    const refreshCustomApps = () => {
      const installed = loadInstalledCustomApps();
      setCustomApps(installed);
      // Drop any dock icons whose custom app was uninstalled, then keep the
      // paged layout disjoint from whatever remains in the dock.
      const nextDock = normalizeDock(dockRef.current);
      if (nextDock.length !== dockRef.current.length || nextDock.some((id, i) => id !== dockRef.current[i])) {
        dockRef.current = nextDock;
        setDock(nextDock);
        writeDockLayout(nextDock);
      }
      const dockIds = new Set<DesktopIconId>(nextDock);
      setLayout(prev => {
        const next = normalizeLayout(prev, widgetsRef.current, dockIds);
        kvSet(ICON_LAYOUT_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
      setActiveApp(prev => {
        const appId = prev ? customAppIdFromIconId(prev) : null;
        return appId && !installed.some(app => app.id === appId) ? null : prev;
      });
    };
    window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
    return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
  }, []);

  useEffect(() => {
    const refreshHostState = () => setCustomAppBadges(loadCustomAppBadges());
    refreshHostState();
    window.addEventListener(CUSTOM_APP_HOST_STATE_UPDATED_EVENT, refreshHostState);
    return () => window.removeEventListener(CUSTOM_APP_HOST_STATE_UPDATED_EVENT, refreshHostState);
  }, []);

  useEffect(() => {
    const unregister = registerCustomAppBackgroundToolExecutor(payload => (
      new Promise<unknown>((resolve, reject) => {
        const id = `bg_tool_${Date.now()}_${++backgroundRunSeqRef.current}_${payload.app.id}`;
        const timeoutMs = customAppBackgroundTimeoutMs(payload.tool.timeoutMs);
        const timeoutId = window.setTimeout(() => {
          pendingCustomAppBackgroundToolsRef.current.delete(id);
          setCustomAppBackgroundToolRuns(prev => prev.filter(run => run.id !== id));
          reject(new Error(`APP handler 执行超时：${payload.tool.name}`));
        }, timeoutMs + 5000);
        pendingCustomAppBackgroundToolsRef.current.set(id, { resolve, reject, timeoutId });
        setCustomAppBackgroundToolRuns(prev => [
          ...prev,
          {
            id,
            app: payload.app,
            payload,
            timeoutMs,
            launchContext: {
              source: "background_tool",
              background: true,
              runId: id,
              origin: "custom_app_background",
              toolId: payload.tool.id,
              toolName: payload.tool.name,
              handler: payload.tool.handler ?? payload.tool.entry ?? payload.tool.id,
              sessionId: payload.context?.sessionId,
              characterId: payload.context?.characterId,
              sourceEngine: payload.context?.sourceEngine,
            },
          },
        ]);
      })
    ));
    return () => {
      unregister();
      for (const [id, pending] of pendingCustomAppBackgroundToolsRef.current.entries()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error(`APP handler 已取消：${id}`));
      }
      pendingCustomAppBackgroundToolsRef.current.clear();
      setCustomAppBackgroundToolRuns([]);
    };
  }, []);

  useEffect(() => {
    const handleCustomAppBackgroundChatEvent = (event: Event) => {
      try {
        const message = (event as CustomEvent<{ message?: ChatMessage }>).detail?.message;
        if (!message || message.origin === "custom_app_background" || !message.sessionId) return;
        const session = loadChatSessions().find(item => item.id === message.sessionId);
        const payload = {
          sessionId: message.sessionId,
          characterId: session?.contactId ?? "",
          isGroup: session?.isGroup === true,
          message: serializeCustomAppBackgroundMessage(message),
        };
        const nextRuns = customApps
          .map(app => ({ app, subscription: getBackgroundChatMessageSubscription(app) }))
          .filter((item): item is { app: InstalledCustomApp; subscription: CustomAppEventRecord } => Boolean(item.subscription))
          .filter(({ app }) => (
            Array.isArray(app.permissions)
            && (app.permissions.includes("chat.read.background" as never) || app.permissions.includes("chat.read" as never))
          ))
          .filter(({ app }) => activeApp !== toCustomAppIconId(app.id))
          .map(({ app, subscription }) => {
            const id = `bg_${Date.now()}_${++backgroundRunSeqRef.current}_${app.id}`;
            const entry = typeof subscription.entry === "string" ? subscription.entry : undefined;
            const timeoutMs = customAppBackgroundTimeoutMs(subscription.timeoutMs);
            return {
              id,
              app,
              eventName: "chat.message.created",
              payload,
              timeoutMs,
              launchContext: {
                source: "background_event",
                background: true,
                eventName: "chat.message.created",
                entry,
                runId: id,
                origin: "custom_app_background",
                ...payload,
              },
            } satisfies CustomAppBackgroundEventRun;
          });
        if (nextRuns.length > 0) {
          setCustomAppBackgroundRuns(prev => [...prev, ...nextRuns].slice(-12));
        }
      } catch (err) {
        console.warn("[CustomAppBackground] failed to queue chat.message.created event", err);
      }
    };
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, handleCustomAppBackgroundChatEvent);
    return () => window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, handleCustomAppBackgroundChatEvent);
  }, [activeApp, customApps]);

  useEffect(() => {
    let canceled = false;
    const runTasks = () => {
      if (canceled) return;
      void runDueCustomAppTasks(setNotice).then(count => {
        if (count > 0) setCustomAppBadges(loadCustomAppBadges());
      }).catch(error => {
        console.warn("[CustomAppTasks] failed", error);
      });
    };
    runTasks();
    const timer = window.setInterval(runTasks, 30_000);
    window.addEventListener("focus", runTasks);
    return () => {
      canceled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", runTasks);
    };
  }, []);

  // Listen for music custom CSS changes from music app
  useEffect(() => {
    const handler = (e: Event) => {
      setMusicCustomCss((e as CustomEvent).detail ?? "");
    };
    window.addEventListener("music-css-change", handler);
    return () => window.removeEventListener("music-css-change", handler);
  }, []);

  // Start background services after storage hydration so they don't read half-initialized state.
  useEffect(() => {
    let cancelled = false;
    let servicesStarted = false;
    let cleanupWeixinCloudRealtimeSync: (() => void) | null = null;

    void (async () => {
      try {
        await Promise.all([
          hydrateKvDb(),
          hydrateChatStorage(),
          hydrateSettingsDb(),
          hydrateStoryStorage(),
          hydrateMomentsStorage(),
          hydrateVnStorage(),
          hydrateDwellingStorage(),
          hydrateCheckPhoneStorage(),
        ]);
      } catch (err) {
        console.warn("[Desktop] storage hydration error:", err);
      }

      // Clear stale generating flags from previous browser session
      // (if the user closed the browser while AI was generating, the flag would be stuck forever)
      kvKeysWithPrefix("chat-generating:").forEach(k => kvRemove(k));

      // One-time cleanup of the orphaned folder-backup handle DB. The removed
      // auto-backup feature opened (and thus created) AiPhoneBackupHandleDB on
      // every launch even though it never had a UI to select a folder.
      if (!kvGet("ai_phone_orphan_db_cleaned_v1")) {
        void deleteDatabase("AiPhoneBackupHandleDB");
        kvSet("ai_phone_orphan_db_cleaned_v1", "1");
      }

      if (cancelled) return;
      startFollowUpService();
      startMomentsService();
      startDiaryEntryTimerService();
      const stopWeixinCloudRealtimeSync = startWeixinCloudRealtimeSync();
      servicesStarted = true;
      cleanupWeixinCloudRealtimeSync = stopWeixinCloudRealtimeSync;
    })();

    return () => {
      cancelled = true;
      cleanupWeixinCloudRealtimeSync?.();
      if (servicesStarted) {
        stopFollowUpService();
        stopMomentsService();
        stopDiaryEntryTimerService();
      }
      bgTimerCleanup();
    };
  }, []);

  // WeChat iLink Bot bridge (polls messages for all enabled bots)
  useWeixinBridge();

  // Listen for mascot navigation events
  useEffect(() => {
    const onMascotNav = (e: Event) => {
      const { app, mode } = (e as CustomEvent).detail ?? {};
      if (app === "desktop") setActiveApp(null);
      else if (app) {
        setActiveApp(app as DesktopIconId);
        // Forward mode (e.g. "worldbook") so the target app can jump to the right sub-page
        if (mode) {
          // Store mode for settings page to read on mount (event might miss if component hasn't mounted yet)
          sessionStorage.setItem("mascot-settings-mode", mode);
          setTimeout(() => window.dispatchEvent(new CustomEvent("mascot-navigate-mode", { detail: { mode } })), 100);
        }
      }
    };
    window.addEventListener("mascot-navigate", onMascotNav);
    return () => window.removeEventListener("mascot-navigate", onMascotNav);
  }, []);

  // Update mascot context when activeApp changes
  useEffect(() => {
    if (!activeApp) {
      setMascotContext({ page: "desktop", mode: "idle", label: "桌面", fields: {} });
    }
    // Specific pages update their own precise context via notifyMascotPageContext
  }, [activeApp]);

  // Listen for AI-initiated call triggers globally (incoming call bar)
  useEffect(() => {
    const onTrigger = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.sessionId || !detail?.type) return;
      if (detail.__fromBar) return;
      const sessions = loadChatSessions();
      const session = sessions.find(s => s.id === detail.sessionId);
      if (!session) return;
      const chars = loadCharacters();
      const isGroup = !!session.isGroup;
      // Group chat: use characterName from event detail; 1:1: use session.contactId
      const char = isGroup
        ? (detail.characterName ? chars.find(c => c.name === detail.characterName) : null)
        : chars.find(c => c.id === session.contactId);
      const charName = isGroup
        ? (detail.characterName || session.groupName || "群聊")
        : (session.alias || char?.name || "未知");
      // Write call initiation system message
      const callLabel = detail.type === "voice" ? "语音通话" : "视频通话";
      if (isGroup) {
        pushChatMessage({
          sessionId: detail.sessionId,
          role: "assistant",
          content: `[我向群聊发起了${callLabel}]`,
          ...(char ? { senderCharacterId: char.id, senderName: detail.characterName || charName } : {}),
        });
      } else {
        const userName = resolveUserIdentity(session.contactId, "chat")?.name || "你";
        pushChatMessage({
          sessionId: detail.sessionId,
          role: "assistant",
          content: `[我向${userName}发起了${callLabel}]`,
        });
      }
      setIncomingCall({
        sessionId: detail.sessionId,
        type: detail.type,
        charName,
        charAvatar: char?.avatar || null,
        isGroup,
      });
      sendBrowserNotification("来电", {
        body: `${charName} ${isGroup ? "群" : ""}${detail.type === "voice" ? "语音通话" : "视频通话"}`,
        icon: char?.avatar || undefined,
      });
    };
    // Chat-room dispatches this when it handles the call directly
    const onDismiss = () => setIncomingCall(null);
    window.addEventListener("ai-call-trigger", onTrigger);
    window.addEventListener("incoming-call-dismiss", onDismiss);
    return () => {
      window.removeEventListener("ai-call-trigger", onTrigger);
      window.removeEventListener("incoming-call-dismiss", onDismiss);
    };
  }, []);

  useEffect(() => {
    const ids = collectThemeAssetIds(draftTheme);
    if (ids.length === 0) {
      return;
    }

    let disposed = false;
    void getThemeAssetMap(ids).then((map) => {
      if (disposed) {
        return;
      }
      setThemeAssets((previous) => ({ ...previous, ...map }));
    });

    return () => {
      disposed = true;
    };
  }, [draftTheme, themeAssetKey]);


  useEffect(() => {
    const styleId = "ai-phone-theme-font-face";
    let node = document.getElementById(styleId) as HTMLStyleElement | null;

    if (!node) {
      node = document.createElement("style");
      node.id = styleId;
      document.head.append(node);
    }

    if (!fontDataUrl) {
      node.textContent = "";
      return;
    }

    node.textContent = `@font-face{font-family:"AIVirtualPhoneUserFont";src:url("${fontDataUrl}");font-display:swap;}`;
  }, [fontDataUrl]);

  // Inject theme color overrides as <style> tag (BEFORE globalCustomCSS so it can be overridden)
  useInsertionEffect(() => {
    const id = "ai-phone-theme-overrides";
    let node = document.getElementById(id) as HTMLStyleElement | null;
    if (!node) {
      node = document.createElement("style");
      node.id = id;
      node.setAttribute("data-source", "theme-overrides");
    }
    node.textContent = themeOverridesCSS;
    // Ensure it's in <head> but before custom CSS
    const customCSSNode = document.getElementById("ai-phone-global-custom-css");
    if (customCSSNode) {
      document.head.insertBefore(node, customCSSNode);
    } else {
      document.head.appendChild(node);
    }
  }, [themeOverridesCSS]);

  // Inject user's globalCustomCSS as a <style> tag AFTER theme overrides.
  // This way globalCustomCSS can override theme colors without !important.
  useInsertionEffect(() => {
    const id = "ai-phone-global-custom-css";
    let node = document.getElementById(id) as HTMLStyleElement | null;
    if (!node) {
      node = document.createElement("style");
      node.id = id;
      node.setAttribute("data-source", "user-custom");
    }
    const css = draftTheme.globalCustomCSS || "";
    node.textContent = css;
    // Always re-append to ensure it's the LAST stylesheet in <head>
    document.head.appendChild(node);
  }, [draftTheme.globalCustomCSS]);

  // Uploaded fonts are an explicit global override. Keep this after user CSS.
  useInsertionEffect(() => {
    const id = "ai-phone-uploaded-font-override";
    let node = document.getElementById(id) as HTMLStyleElement | null;
    if (!uploadedFontOverrideCSS) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("style");
      node.id = id;
      node.setAttribute("data-source", "uploaded-font-override");
    }
    node.textContent = uploadedFontOverrideCSS;
    document.head.appendChild(node);
  }, [uploadedFontOverrideCSS]);

  useEffect(() => {
    if (!desktopReady) return;

    let frameOne = 0;
    let frameTwo = 0;
    let timer = 0;
    const repaintGlass = () => {
      shellRef.current?.getBoundingClientRect();
      setGlassPaintPass(pass => pass + 1);
    };

    frameOne = window.requestAnimationFrame(() => {
      frameTwo = window.requestAnimationFrame(repaintGlass);
    });
    timer = window.setTimeout(repaintGlass, 180);

    return () => {
      window.cancelAnimationFrame(frameOne);
      window.cancelAnimationFrame(frameTwo);
      window.clearTimeout(timer);
    };
  }, [desktopReady, iconEffect, widgetEffect, wallpaperDataUrl, dockSkinUrl]);



  // Enforce layout rules when icon layout changes (keeps old bad data from breaking grid).
  useEffect(() => {
    setWidgets((prev) => {
      const next = sanitizeWidgetsForLayout(layout, prev);
      return sameWidgetOrder(prev, next) ? prev : next;
    });
  }, [layout]);


  useEffect(() => {
    if (!notice) {
      return;
    }
    const timeout = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  // Global notice from mascot (or other non-prop sources)
  useEffect(() => {
    const onGlobalNotice = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (text) setNotice(text);
    };
    window.addEventListener("global-notice", onGlobalNotice);
    return () => window.removeEventListener("global-notice", onGlobalNotice);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void completePendingMcpOAuthCallback().then((result) => {
      if (cancelled || !result.completed) return;
      if (result.success) {
        setNotice(result.serverName ? `${result.serverName} 授权成功` : "MCP 授权成功");
      } else {
        setNotice(`MCP 授权失败：${result.error || "未知错误"}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (currentPageIndex > pageCount - 1) {
      setCurrentPageIndex(Math.max(0, pageCount - 1));
    }
  }, [currentPageIndex, pageCount]);

  const boundedCurrentPageIndex = Math.min(currentPageIndex, Math.max(0, pageCount - 1));
  const currentPageKey = pageKeys[boundedCurrentPageIndex] ?? "page1";
  const currentIcons = layout[currentPageKey] ?? [];
  const currentPage = getDesktopPageNumber(currentPageKey) || 1;
  const currentPageWidgets = useMemo(
    () => widgets.filter((w) => w.page === currentPage),
    [widgets, currentPage]
  );

  // Compute explicit icon positions
  const iconPositions = useMemo(
    () => computeIconPositions(currentIcons, currentPageWidgets),
    [currentIcons, currentPageWidgets]
  );

  const customAppMap = useMemo(() => {
    const map = new Map<string, InstalledCustomApp>();
    for (const app of customApps) map.set(app.id, app);
    return map;
  }, [customApps]);

  const getCustomAppForIcon = useCallback((iconId: DesktopIconId): InstalledCustomApp | null => {
    const appId = customAppIdFromIconId(iconId);
    return appId ? customAppMap.get(appId) ?? null : null;
  }, [customAppMap]);

  const getDesktopIconMeta = useCallback((iconId: DesktopIconId) => {
    const customApp = getCustomAppForIcon(iconId);
    if (customApp) {
      return {
        id: iconId,
        label: customApp.name,
        tone: "var(--c-icon-teal)",
        placeholder: false,
        iconDataUrl: customApp.iconDataUrl,
        customApp,
      };
    }
    return iconId in ICONS ? { ...ICONS[iconId as IconId], customApp: null as InstalledCustomApp | null } : null;
  }, [getCustomAppForIcon]);

  const activeIcon = activeApp ? getDesktopIconMeta(activeApp) : null;

  function openWorldBuilder(path: string): void {
    const targetUrl = new URL(path, window.location.origin).toString();
    const escapedTargetUrl = JSON.stringify(targetUrl);
    const bootHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#121110" />
<title>筑境</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:100%;height:100%;background:#121110;color:rgba(255,248,232,.92);color-scheme:dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.wb-initial-boot{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;isolation:isolate;width:100vw;height:100vh;height:100dvh;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:calc(env(safe-area-inset-top,0px) + 18px) 22px calc(env(safe-area-inset-bottom,0px) + 22px);background:#121110;color:rgba(255,248,232,.92);overflow:hidden;pointer-events:auto}
.wb-initial-boot:before{content:"";position:fixed;top:-2px;right:-2px;bottom:-2px;left:-2px;opacity:.18;background-color:#121110;background-image:linear-gradient(rgba(245,198,104,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(98,207,214,.1) 1px,transparent 1px);background-size:34px 34px;mask-image:linear-gradient(to bottom,transparent,black 20%,black 80%,transparent);pointer-events:none}
.wb-initial-center{position:relative;z-index:1;width:min(300px,100%);display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center}
.wb-initial-mark{width:72px;height:72px;display:grid;place-items:center;border:1px solid rgba(245,198,104,.32);border-radius:18px;background:rgba(255,255,255,.07);color:#f5c668}
.wb-initial-mark span{width:28px;height:28px;border:2px solid rgba(245,198,104,.26);border-top-color:#f5c668;border-radius:50%;animation:wbInitialSpin .9s linear infinite}
.wb-initial-copy{display:flex;flex-direction:column;gap:7px;align-items:center}
.wb-initial-copy span{color:#f5c668;font-size: calc(11px*var(--app-text-scale,1));font-weight:700;letter-spacing:.08em}
.wb-initial-copy h1{margin:0;color:rgba(255,248,232,.96);font-size: calc(21px*var(--app-text-scale,1));line-height:1.3;font-weight:750;letter-spacing:.06em}
.wb-initial-copy p{margin:0;color:rgba(255,248,232,.58);font-size: calc(13px*var(--app-text-scale,1));line-height:1.5}
.wb-initial-back{appearance:none;-webkit-appearance:none;min-height:44px;padding:0 18px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.07);color:rgba(255,248,232,.76);font:inherit;font-size: calc(13px*var(--app-text-scale,1));font-weight:600;cursor:pointer}
@keyframes wbInitialSpin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.wb-initial-mark span{animation:none}}
</style>
</head>
<body>
<main class="wb-initial-boot" role="status" aria-live="polite">
  <div class="wb-initial-center">
    <div class="wb-initial-mark" aria-hidden="true"><span></span></div>
    <div class="wb-initial-copy">
      <span>World Builder</span>
      <h1>正在搭建筑境</h1>
      <p>场景出现后会自动进入。</p>
    </div>
    <button class="wb-initial-back" type="button" onclick="if(window.opener&&!window.opener.closed){window.opener.focus();window.close();}else{window.location.replace('/')}">返回小手机</button>
  </div>
</main>
<script>setTimeout(function(){window.location.replace(${escapedTargetUrl});},80);</script>
</body>
</html>`;
    const popup = window.open("", "_blank");

    if (!popup) {
      window.location.href = targetUrl;
      return;
    }

    popup.document.open();
    popup.document.write(bootHtml);
    popup.document.close();
  }

  function getFreshInstalledCustomApp(appId: string): InstalledCustomApp | null {
    const installed = loadInstalledCustomApps();
    if (installed.length !== customApps.length || installed.some((app, index) => app.id !== customApps[index]?.id || app.version !== customApps[index]?.version)) {
      setCustomApps(installed);
    }
    return installed.find(app => app.id === appId) ?? customAppMap.get(appId) ?? null;
  }

  function activateCustomApp(appId: string, launchContext: Record<string, unknown> = {}): void {
    const iconId = toCustomAppIconId(appId);
    activeAppRef.current = iconId;
    setCustomAppLaunchContext({
      appId,
      context: launchContext,
      returnTo: customAppReturnTargetFromLaunchContext(launchContext),
    });
    setActiveApp(iconId);
  }

  function checkCustomAppUpdateInBackground(app: InstalledCustomApp, launchContext: Record<string, unknown>): void {
    if (customAppUpdateCheckingRef.current.has(app.id)) return;
    customAppUpdateCheckingRef.current.add(app.id);
    void (async () => {
      try {
        const item = await resolveCustomAppMarketItemForInstalled(app.id);
        const activeCustomAppId = activeAppRef.current ? customAppIdFromIconId(activeAppRef.current) : null;
        if (activeCustomAppId !== app.id || !item) return;
        const freshApp = getFreshInstalledCustomApp(app.id) ?? app;
        if (isCustomAppMarketItemNewerThanInstalled(freshApp, item)) {
          setCustomAppUpdatePrompt(current => current?.app.id === freshApp.id ? current : {
            app: freshApp,
            item,
            launchContext,
          });
        }
      } catch {
        // 本地导入、离线或市场不可用时不打扰用户。
      } finally {
        customAppUpdateCheckingRef.current.delete(app.id);
      }
    })();
  }

  function openCustomAppWithBackgroundUpdateCheck(
    iconId: DesktopIconId,
    launchContext: Record<string, unknown> = {},
  ): void {
    const appId = customAppIdFromIconId(iconId);
    if (!appId) return;
    const app = getFreshInstalledCustomApp(appId);
    if (!app) {
      setNotice("这个 APP 已被卸载或不存在。");
      return;
    }
    activateCustomApp(app.id, launchContext);
    checkCustomAppUpdateInBackground(app, launchContext);
  }

  function openApp(iconId: DesktopIconId): void {
    if (customAppIdFromIconId(iconId)) {
      openCustomAppWithBackgroundUpdateCheck(iconId);
      return;
    }
    const builtinIconId = iconId as IconId;
    const meta = ICONS[builtinIconId];
    if (meta?.path && meta.id === "worldbuilder") {
      openWorldBuilder(meta.path);
      return;
    }
    if (builtinIconId === "resources") setResourcesInitialPage("main");
    if (builtinIconId === "chat") setChatInitSessionId(null);
    setActiveApp(builtinIconId);
  }

  const handleInstallCustomAppToDesktop = useCallback((app: InstalledCustomApp) => {
    const iconId = toCustomAppIconId(app.id);
    setCustomApps(loadInstalledCustomApps());
    let placedPageNumber: number | null = null;
    setLayout(prev => {
      const widgets = widgetsRef.current;
      const next = cloneDesktopLayout(prev, widgets);
      if (getDesktopIconLayoutItems(next).some(icon => icon.id === iconId) || dockRef.current.includes(iconId)) {
        return next;
      }
      const pageNumbers = getDesktopPageKeysForState(next, widgets).map(getDesktopPageNumber);
      const maxPage = Math.max(2, ...pageNumbers);
      for (let page = 1; page <= maxPage + 1; page += 1) {
        const pageKey = getDesktopPageKey(page);
        ensureDesktopPage(next, pageKey);
        const widgetOcc = buildWidgetOccupancy(widgets.filter(w => w.page === page));
        const usedCells = new Set(next[pageKey].map(icon => `${icon.row},${icon.col}`));
        const free = findNearestFreeCell(1, 1, widgetOcc, usedCells);
        if (!free) continue;
        next[pageKey] = [...next[pageKey], { id: iconId, row: free.row, col: free.col }];
        placedPageNumber = page;
        break;
      }
      const trimmed = trimEmptyTrailingPages(next, widgets);
      kvSet(ICON_LAYOUT_STORAGE_KEY, JSON.stringify(trimmed));
      return trimmed;
    });
    if (placedPageNumber) {
      window.setTimeout(() => setCurrentPageIndex(Math.max(0, (placedPageNumber ?? 1) - 1)), 0);
    }
  }, []);

  // Allow other components to switch apps via custom event
  const [chatInitSessionId, setChatInitSessionId] = useState<string | null>(null);
  const [activeChatSession, setActiveChatSession] = useState<ChatSession | null>(null);
  const [customAppLaunchContext, setCustomAppLaunchContext] = useState<CustomAppLaunchState | null>(null);
  const [appMarketLaunchContext, setAppMarketLaunchContext] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.appId) {
        const nextAppId = String(detail.appId);
        const customAppId = customAppIdFromIconId(nextAppId);
        const rawLaunchContext = detail.launchContext;
        const launchContextRecord = rawLaunchContext && typeof rawLaunchContext === "object" && !Array.isArray(rawLaunchContext)
          ? rawLaunchContext as Record<string, unknown>
          : {};
        if (customAppId) {
          openCustomAppWithBackgroundUpdateCheck(toCustomAppIconId(customAppId), launchContextRecord);
          if (detail.sessionId) setChatInitSessionId(detail.sessionId);
          else setChatInitSessionId(null);
          return;
        }
        setCustomAppLaunchContext(customAppId
          ? {
            appId: customAppId,
            context: launchContextRecord,
            returnTo: customAppReturnTargetFromLaunchContext(launchContextRecord),
          }
          : null);
        setAppMarketLaunchContext(nextAppId === "appmarket" ? launchContextRecord : null);
        if (detail.appId === "resources") {
          setResourcesInitialPage(detail.resourcePage === "vn_assets" || detail.resourcePage === "memory" ? detail.resourcePage : "main");
        }
        setActiveApp(nextAppId as DesktopIconId);
        if (detail.sessionId) setChatInitSessionId(detail.sessionId);
        else setChatInitSessionId(null);
      }
    };
    window.addEventListener("open-app", handler);
    return () => window.removeEventListener("open-app", handler);
  }, []);

  // Mini chat window state
  const [showMiniChat, setShowMiniChat] = useState(false);
  const [miniSharePayload, setMiniSharePayload] = useState<ChatSharePayload | null>(null);
  const miniSessionRef = useRef<ChatSession | null>(null);
  const handleMiniChatClose = useCallback(() => setShowMiniChat(false), []);
  const handleMiniChatSessionChange = useCallback((session: ChatSession | null) => {
    miniSessionRef.current = session;
  }, []);
  const handleMiniShareDone = useCallback(() => setMiniSharePayload(null), []);
  const handleMiniChatExpand = useCallback(() => {
    setShowMiniChat(false);
    musicOverlayControllerRef.current?.closeFullPlayer();
    setActiveApp("chat" as IconId);
    const sid = miniSessionRef.current?.id;
    if (sid) setChatInitSessionId(sid);
  }, []);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.share) setMiniSharePayload(detail.share);
      else setMiniSharePayload(null);
      setShowMiniChat(true);
    };
    window.addEventListener("open-mini-chat", handler);
    return () => window.removeEventListener("open-mini-chat", handler);
  }, []);

  const openChatSessionFromNotice = useCallback((sessionId: string) => {
    if (chatMessageNoticeTimerRef.current !== null) {
      window.clearTimeout(chatMessageNoticeTimerRef.current);
      chatMessageNoticeTimerRef.current = null;
    }
    setChatMessageNotice(null);
    setShowMiniChat(false);
    setActiveApp("chat" as IconId);
    setChatInitSessionId(sessionId);
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CHAT_OPEN_SESSION_EVENT, { detail: { sessionId } }));
    }, 0);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        sessionId?: string;
        characterId?: string;
        handled?: boolean;
        replayed?: boolean;
      }>).detail;
      if (!detail || detail.replayed) return;

      const sessions = loadChatSessions();
      const sessionId = detail.sessionId
        || sessions.find(session => !session.isGroup && session.contactId === detail.characterId)?.id
        || "";
      if (!sessionId) return;

      window.setTimeout(() => {
        if (detail.handled) return;
        detail.handled = true;
        void requestBackgroundChatReply(sessionId);
      }, 0);
    };

    window.addEventListener(CHAT_REQUEST_REPLY_EVENT, handler);
    return () => window.removeEventListener(CHAT_REQUEST_REPLY_EVENT, handler);
  }, []);

  // Swipe up to dismiss the message notice; tap still opens the chat. Auto-dismiss
  // pauses while the finger is down and resumes if the swipe doesn't pass threshold.
  const armNoticeAutoDismiss = useCallback(() => {
    if (chatMessageNoticeTimerRef.current !== null) window.clearTimeout(chatMessageNoticeTimerRef.current);
    chatMessageNoticeTimerRef.current = window.setTimeout(() => {
      setChatMessageNotice(null);
      chatMessageNoticeTimerRef.current = null;
    }, 6000);
  }, []);

  const handleNoticePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    noticeDragRef.current = { startY: e.clientY, dy: 0, dragging: true, far: false };
    if (chatMessageNoticeTimerRef.current !== null) {
      window.clearTimeout(chatMessageNoticeTimerRef.current);
      chatMessageNoticeTimerRef.current = null;
    }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  const handleNoticePointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = noticeDragRef.current;
    if (!drag.dragging) return;
    let dy = e.clientY - drag.startY;
    if (dy > 0) dy = Math.min(12, dy * 0.3); // rubber-band a little when pulled down
    drag.dy = dy;
    if (Math.abs(dy) > 6) drag.far = true;
    setNoticeDragY(dy);
  }, []);

  const handleNoticePointerUp = useCallback(() => {
    const drag = noticeDragRef.current;
    if (!drag.dragging) return;
    drag.dragging = false;
    if (drag.dy < -44) {
      setNoticeDragY(-220); // slide away, then unmount
      window.setTimeout(() => setChatMessageNotice(null), 170);
    } else {
      setNoticeDragY(0); // bounce back + resume auto-dismiss
      armNoticeAutoDismiss();
    }
  }, [armNoticeAutoDismiss]);

  const handleNoticeClick = useCallback(() => {
    if (noticeDragRef.current.far) { noticeDragRef.current.far = false; return; }
    if (chatMessageNotice) openChatSessionFromNotice(chatMessageNotice.sessionId);
  }, [chatMessageNotice, openChatSessionFromNotice]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ChatMessageNoticeDetail>).detail;
      if (!detail?.sessionId || !detail.body?.trim()) return;

      const isCurrentMainChat = activeApp === "chat" && activeChatSession?.id === detail.sessionId;
      const isCurrentMiniChat = showMiniChat && miniSessionRef.current?.id === detail.sessionId;
      if (isCurrentMainChat || isCurrentMiniChat) return;

      const sessions = loadChatSessions();
      const session = sessions.find(s => s.id === detail.sessionId);
      if (!session) return;

      const chars = loadCharacters();
      const isGroup = detail.isGroup ?? !!session.isGroup;
      const char = !isGroup ? chars.find(c => c.id === session.contactId) : null;
      const detailSenderName = detail.senderName?.trim();
      const title = detailSenderName && detailSenderName !== "对方"
        ? detailSenderName
        : (isGroup ? session.groupName || "群聊" : session.alias || char?.name || "新消息");

      if (chatMessageNoticeTimerRef.current !== null) {
        window.clearTimeout(chatMessageNoticeTimerRef.current);
      }
      noticeDragRef.current = { startY: 0, dy: 0, dragging: false, far: false };
      setNoticeDragY(0);
      setChatMessageNotice({
        sessionId: detail.sessionId,
        title,
        body: detail.body.trim(),
        avatar: detail.avatar ?? char?.avatar ?? null,
        isGroup,
      });
      chatMessageNoticeTimerRef.current = window.setTimeout(() => {
        setChatMessageNotice(null);
        chatMessageNoticeTimerRef.current = null;
      }, 6000);
    };

    window.addEventListener(CHAT_MESSAGE_NOTICE_EVENT, handler);
    return () => window.removeEventListener(CHAT_MESSAGE_NOTICE_EVENT, handler);
  }, [activeApp, activeChatSession?.id, showMiniChat]);

  useEffect(() => {
    return () => {
      if (chatMessageNoticeTimerRef.current !== null) {
        window.clearTimeout(chatMessageNoticeTimerRef.current);
      }
    };
  }, []);

  // ── Edit mode: drag & drop helpers ──

  function cancelLongPress() {
    const lp = longPressRef.current;
    if (lp?.timer) clearTimeout(lp.timer);
    longPressRef.current = null;
  }

  function exitEditMode() {
    setEditMode(false);
    setShowDesktopCustomizer(false);
    setShowWidgetPicker(false);
    setShowWidgetPicker(false);
    setDragItem(null);
    setDropTarget(null);
    editDragRef.current = null;
    editTapRef.current = null;
    if (ghostRef.current) ghostRef.current.style.display = "none";
    // Save layout, dock and widgets once on exit
    kvSet(ICON_LAYOUT_STORAGE_KEY, JSON.stringify(layoutRef.current));
    kvSet(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify(dockRef.current));
    saveWidgets(widgetsRef.current);
  }

  function startDragPending(
    pointerId: number,
    clientX: number,
    clientY: number,
    itemType: "icon" | "widget",
    itemId: string,
    page: DragPageKey,
    element: HTMLElement
  ) {
    const rect = element.getBoundingClientRect();
    // For widgets: compute grab offset in grid cells
    let grabCellRow = 0;
    let grabCellCol = 0;
    if (itemType === "widget" && page !== DOCK_PAGE_KEY) {
      const gridEl = gridRefs.current[page];
      if (gridEl) {
        const cs = getComputedStyle(gridEl);
        const colW = parseFloat(cs.gridTemplateColumns.split(/\s+/)[0] || "66");
        const colGap = parseFloat(cs.columnGap) || 20;
        const rowGap = parseFloat(cs.rowGap) || 0;
        /* rect 高度是 border-box（含 padding），网格行轨道只占内容盒。 */
        const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const rowH = (gridEl.getBoundingClientRect().height - padY - (GRID_ROWS - 1) * rowGap) / GRID_ROWS;
        grabCellCol = Math.floor((clientX - rect.left) / (colW + colGap));
        grabCellRow = Math.floor((clientY - rect.top) / (rowH + rowGap));
      }
    }
    editDragRef.current = {
      active: false,
      pending: true,
      itemType,
      itemId,
      sourcePage: page,
      pointerId,
      startX: clientX,
      startY: clientY,
      offsetX: clientX - rect.left,
      offsetY: clientY - rect.top,
      edgeTimer: null,
      lastTargetKey: "",
      targetPage: null,
      targetRow: 0,
      targetCol: 0,
      targetDockIndex: 0,
      grabCellRow,
      grabCellCol,
      element,
      ghostW: rect.width,
      ghostH: rect.height,
      shellLeft: 0,
      shellTop: 0,
      initialLayout: layoutRef.current,
      initialWidgets: widgetsRef.current,
      initialDock: dockRef.current,
    };
    // Kill swipe tracking for this pointer
    swipeRef.current.pointerId = null;
  }

  // 安卓：长按激活拖拽后若不松手继续移动，浏览器会把这串触摸判定为滚动手势
  // 并发出 pointercancel（表现为"拖到一半弹回去，必须松手重按"）。touch-action
  // 在触摸开始时已快照，事后改无效——唯一可靠的办法是在拖拽激活期间用
  // non-passive touchmove 阻止默认行为，浏览器就无法启动滚动接管。iOS 不受影响。
  useEffect(() => {
    const blockScrollWhileDragging = (event: TouchEvent) => {
      if (editDragRef.current?.active && event.cancelable) event.preventDefault();
    };
    document.addEventListener("touchmove", blockScrollWhileDragging, { passive: false });
    return () => document.removeEventListener("touchmove", blockScrollWhileDragging);
  }, []);

  function activateDrag(e: React.PointerEvent) {
    const drag = editDragRef.current;
    if (!drag) return;
    drag.active = true;
    drag.pending = false;
    // Clone element for ghost
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.innerHTML = "";
      const clone = drag.element.cloneNode(true) as HTMLElement;
      clone.style.margin = "0";
      clone.style.gridRow = "";
      clone.style.gridColumn = "";
      // Set explicit size — the clone loses .icon-grid CSS variable context
      clone.style.width = `${drag.ghostW}px`;
      clone.style.height = `${drag.ghostH}px`;
      clone.style.minHeight = "";
      clone.style.boxSizing = "border-box";
      // 拿起手感：克隆体轻微放大 + 投影
      clone.style.transition = "transform 0.16s ease, filter 0.16s ease";
      ghost.appendChild(clone);
      requestAnimationFrame(() => {
        clone.style.transform = "scale(1.06)";
        clone.style.filter = "drop-shadow(0 14px 22px rgba(0,0,0,0.32))";
      });
      ghost.style.display = "block";
      ghost.style.width = `${drag.ghostW}px`;
      ghost.style.height = `${drag.ghostH}px`;
    }
    const shellRect = shellRef.current?.getBoundingClientRect();
    drag.shellLeft = shellRect?.left ?? 0;
    drag.shellTop = shellRect?.top ?? 0;
    setDragItem({ type: drag.itemType, id: drag.itemId, sourcePage: drag.sourcePage });
    workspaceRef.current?.setPointerCapture(e.pointerId);
    updateGhostPos(e.clientX, e.clientY);
  }

  function updateGhostPos(x: number, y: number) {
    const drag = editDragRef.current;
    if (!drag || !ghostRef.current) return;
    ghostRef.current.style.transform = `translate3d(${x - drag.offsetX - drag.shellLeft}px, ${y - drag.offsetY - drag.shellTop}px, 0)`;
  }

  /** True when the pointer is within (a slightly padded) dock footer. */
  function pointerOverDock(x: number, y: number): boolean {
    const el = dockElRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 24 && y <= r.bottom + 48;
  }

  /** Insertion index into the dock (excluding the dragged item) from pointer x. */
  function dockDropIndexFromPointer(x: number): number {
    const el = dockElRef.current;
    if (!el) return 0;
    // Skip the faded, currently-dragged item so indices map onto initialDock
    // with the dragged icon removed — exactly what simulateDockReflow expects.
    const items = Array.from(el.querySelectorAll<HTMLElement>(".dock-item:not(.dragging)"));
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return items.length;
  }

  function resetDragPreview(drag: NonNullable<typeof editDragRef.current>) {
    setLayout(drag.initialLayout);
    setWidgets(drag.initialWidgets);
    setDock(drag.initialDock);
  }

  function updateDropTargetFromPointer(x: number, y: number) {
    const drag = editDragRef.current;
    if (!drag) return;

    // ── Dock drop zone (icons only; widgets can't live in the dock) ──
    if (drag.itemType === "icon" && pointerOverDock(x, y)) {
      const fromDock = drag.sourcePage === DOCK_PAGE_KEY;
      const baseLen = drag.initialDock.filter((id) => id !== drag.itemId).length;
      // Dock full and the icon comes from a page → not allowed. Behave as no-target.
      if (!fromDock && baseLen >= DOCK_MAX) {
        if (drag.targetPage !== null) resetDragPreview(drag);
        drag.targetPage = null;
        drag.lastTargetKey = "";
        setDropTarget(null);
        return;
      }
      const index = Math.min(dockDropIndexFromPointer(x), baseLen);
      const key = `dock:${index}`;
      if (key === drag.lastTargetKey) return;
      drag.lastTargetKey = key;
      drag.targetPage = DOCK_PAGE_KEY;
      drag.targetDockIndex = index;
      setDropTarget(null);
      simulateDockReflow(drag, index);
      return;
    }

    const pageIdx = currentPageIndexRef.current;
    const activePageKeys = getDesktopPageKeysForState(layoutRef.current, widgetsRef.current);
    const pageKey = activePageKeys[Math.min(pageIdx, activePageKeys.length - 1)] ?? "page1";
    const gridEl = gridRefs.current[pageKey];
    if (!gridEl) return;

    const cell = pointerToGridCell(x, y, gridEl);
    if (!cell) {
      if (drag.targetPage !== null) resetDragPreview(drag);
      drag.targetPage = null;
      drag.lastTargetKey = "";
      setDropTarget(null);
      return;
    }

    const pageNum = getDesktopPageNumber(pageKey) || 1;
    const ws = widgetsRef.current;

    if (drag.itemType === "icon") {
      const key = `${pageKey}:${cell.row}:${cell.col}`;
      if (key === drag.lastTargetKey) return;
      drag.lastTargetKey = key;
      drag.targetPage = pageKey;
      drag.targetRow = cell.row + 1;
      drag.targetCol = cell.col + 1;
      setDropTarget({ page: pageKey, row: cell.row + 1, col: cell.col + 1 });
      simulateDragReflow(drag, pageKey, cell.row + 1, cell.col + 1);
    } else {
      const w = ws.find((ww) => ww.id === drag.itemId);
      if (!w) return;
      const [wRows, wCols] = WIDGET_SIZE_CELLS[w.size];
      // Subtract grab offset: pointer cell → widget top-left cell
      const topRow = cell.row - drag.grabCellRow;
      const topCol = cell.col - drag.grabCellCol;
      // Allow drop indicator as long as the widget bounds fit INSIDE the grid visually
      if (topRow < 0 || topCol < 0 || topRow + wRows > GRID_ROWS || topCol + wCols > GRID_COLS) return;
      
      const key = `${pageKey}:${topRow}:${topCol}`;
      if (key === drag.lastTargetKey) return;
      drag.lastTargetKey = key;
      drag.targetPage = pageKey;
      drag.targetRow = topRow + 1;
      drag.targetCol = topCol + 1;
      setDropTarget({ page: pageKey, row: topRow + 1, col: topCol + 1 });
      simulateDragReflow(drag, pageKey, topRow + 1, topCol + 1);
    }
  }

  /** Live preview for dropping an icon into the dock at `index`. */
  function simulateDockReflow(drag: NonNullable<typeof editDragRef.current>, index: number) {
    const iconId = drag.itemId as DesktopIconId;
    const nextDock = drag.initialDock.filter((id) => id !== iconId);
    const clamped = Math.max(0, Math.min(index, nextDock.length));
    nextDock.splice(clamped, 0, iconId);
    setDock(nextDock);
    if (drag.sourcePage === DOCK_PAGE_KEY) {
      // Reordering within the dock — pages untouched.
      setLayout(drag.initialLayout);
      setWidgets(drag.initialWidgets);
    } else {
      // A page icon is entering the dock — drop it from its page.
      const next = cloneDesktopLayout(drag.initialLayout, drag.initialWidgets);
      const src = drag.sourcePage as DesktopPageKey;
      ensureDesktopPage(next, src);
      next[src] = next[src].filter((ic) => ic.id !== iconId);
      setLayout(trimEmptyTrailingPages(next, drag.initialWidgets));
      setWidgets(drag.initialWidgets);
    }
  }

  function simulateDragReflow(drag: NonNullable<typeof editDragRef.current>, tPage: DesktopPageKey, tRow: number, tCol: number) {
    const targetPageNum = getDesktopPageNumber(tPage) || 1;

    if (drag.itemType === "icon") {
      const iconId = drag.itemId as DesktopIconId;
      const fromDock = drag.sourcePage === DOCK_PAGE_KEY;
      const targetPageWidgets = drag.initialWidgets.filter((w) => w.page === targetPageNum);
      const occ = buildWidgetOccupancy(targetPageWidgets);
      if (!occ[tRow - 1][tCol - 1]) {
        const next = cloneDesktopLayout(drag.initialLayout, drag.initialWidgets);
        ensureDesktopPage(next, tPage);

        if (fromDock) {
          // Coming out of the dock onto a page.
          setDock(drag.initialDock.filter((id) => id !== iconId));
          const tgtArr = (next[tPage] ?? []).filter((ic) => ic.id !== iconId);
          const occupant = tgtArr.find((ic) => ic.row === tRow && ic.col === tCol);
          if (occupant) {
            // Target cell taken: land on the nearest free cell rather than evict.
            const used = new Set(tgtArr.map((ic) => `${ic.row},${ic.col}`));
            const free = findNearestFreeCell(tRow, tCol, occ, used);
            if (!free) return;
            next[tPage] = [...tgtArr, { id: iconId, row: free.row, col: free.col }];
          } else {
            next[tPage] = [...tgtArr, { id: iconId, row: tRow, col: tCol }];
          }
        } else {
          setDock(drag.initialDock); // undo any prior dock preview
          const sourcePage = drag.sourcePage as DesktopPageKey;
          ensureDesktopPage(next, sourcePage);
          const srcArr = next[sourcePage].filter(ic => ic.id !== iconId);
          if (sourcePage === tPage) {
            const occupant = srcArr.find(ic => ic.row === tRow && ic.col === tCol);
            const draggedOld = (drag.initialLayout[sourcePage] ?? []).find(ic => ic.id === iconId);
            if (occupant && draggedOld) {
              next[sourcePage] = srcArr.map(ic =>
                ic.id === occupant.id ? { ...ic, row: draggedOld.row, col: draggedOld.col } : ic
              );
              next[sourcePage].push({ id: iconId, row: tRow, col: tCol });
            } else {
              next[sourcePage] = [...srcArr, { id: iconId, row: tRow, col: tCol }];
            }
          } else {
            next[sourcePage] = srcArr;
            const tgtArr = [...(next[tPage] ?? [])];
            const occupant = tgtArr.find(ic => ic.row === tRow && ic.col === tCol);
            const draggedOld = (drag.initialLayout[sourcePage] ?? []).find(ic => ic.id === iconId);
            if (occupant && draggedOld) {
              next[sourcePage] = [...srcArr, { id: occupant.id, row: draggedOld.row, col: draggedOld.col }];
              next[tPage] = tgtArr.filter(ic => ic.id !== occupant.id);
              next[tPage].push({ id: iconId, row: tRow, col: tCol });
            } else {
              next[tPage] = [...tgtArr, { id: iconId, row: tRow, col: tCol }];
            }
          }
        }
        setLayout(trimEmptyTrailingPages(next, drag.initialWidgets));
        setWidgets(drag.initialWidgets); // reset widgets completely to initial state
      }
    } else {
      const draggedWidget = drag.initialWidgets.find(w => w.id === drag.itemId);
      if (!draggedWidget) return;

      let tentativeWidgets = [...drag.initialWidgets];

      const placeWidgetWithBump = (
        widgetToPlace: WidgetInstance,
        targetPageNum: number,
        tRow: number,
        tCol: number,
        depth: number
      ): boolean => {
        if (depth > 6) return false;
        const [wRows, wCols] = WIDGET_SIZE_CELLS[widgetToPlace.size];

        const overlappingWidgets = tentativeWidgets.filter(w => {
          if (w.id === widgetToPlace.id || w.page !== targetPageNum) return false;
          const [oRows, oCols] = WIDGET_SIZE_CELLS[w.size];
          const oX = Math.max(0, Math.min(tCol + wCols, w.col + oCols) - Math.max(tCol, w.col));
          const oY = Math.max(0, Math.min(tRow + wRows, w.row + oRows) - Math.max(tRow, w.row));
          return oX > 0 && oY > 0;
        });

        tentativeWidgets = tentativeWidgets.map(w =>
          w.id === widgetToPlace.id ? { ...w, page: targetPageNum, row: tRow, col: tCol } : w
        );

        for (const displaced of overlappingWidgets) {
          const [dRows, dCols] = WIDGET_SIZE_CELLS[displaced.size];

          const attemptInsert = (pageNum: number) => {
            const occ = buildWidgetOccupancy(tentativeWidgets.filter(w => w.page === pageNum && w.id !== displaced.id));
            const startRow = pageNum === targetPageNum ? displaced.row : 1;
            for (let r = startRow; r <= GRID_ROWS - dRows + 1; r++) {
              for (let c = 1; c <= GRID_COLS - dCols + 1; c++) {
                let free = true;
                for (let dr = 0; dr < dRows; dr++) {
                  for (let dc = 0; dc < dCols; dc++) {
                    if (occ[r - 1 + dr][c - 1 + dc]) free = false;
                  }
                }
                if (free) {
                  if (placeWidgetWithBump(displaced, pageNum, r, c, depth + 1)) {
                    return true;
                  }
                }
              }
            }
            return false;
          };

          const maxPage = Math.max(
            2,
            targetPageNum,
            ...getDesktopPageKeysForState(drag.initialLayout, tentativeWidgets).map(getDesktopPageNumber)
          );
          const fallbackPages = Array.from({ length: maxPage + 1 }, (_, index) => index + 1)
            .filter((page) => page !== targetPageNum);
          let inserted = attemptInsert(targetPageNum);
          for (const page of fallbackPages) {
            if (inserted) break;
            inserted = attemptInsert(page);
          }
          if (!inserted) return false;
        }
        return true;
      };

      const success = placeWidgetWithBump(draggedWidget, targetPageNum, tRow, tCol, 0);

      if (!success) {
        // Grid overflow, preview ignores this invalid state
      } else {
        const newLayout = cloneDesktopLayout(drag.initialLayout, tentativeWidgets);
        const affectedPages = getDesktopPageKeysForState(newLayout, tentativeWidgets);
        for (const pk of affectedPages) {
          const pn = getDesktopPageNumber(pk) || 1;
          const newPW = tentativeWidgets.filter((w) => w.page === pn);
          const { placed, overflow } = displaceIconsForWidgets(newLayout[pk] ?? [], newPW);
          newLayout[pk] = placed;
          for (const ov of overflow) {
            placeIconOnAvailablePage(newLayout, tentativeWidgets, ov, pn + 1);
          }
        }
        suspendGlass();
        setWidgets(tentativeWidgets);
        setLayout(trimEmptyTrailingPages(newLayout, tentativeWidgets));
      }
    }
  }

  function checkEdgeSwitch(x: number) {
    const drag = editDragRef.current;
    const ws = workspaceRef.current;
    if (!drag || !ws) return;
    const rect = ws.getBoundingClientRect();
    const EDGE = 36;
    const pageIdx = currentPageIndexRef.current;
    const activePageKeys = getDesktopPageKeysForState(layoutRef.current, widgetsRef.current);
    const lastPageIndex = Math.max(0, activePageKeys.length - 1);
    const nearLeft = x - rect.left < EDGE;
    const nearRight = rect.right - x < EDGE;
    const canSwitchLeft = nearLeft && pageIdx > 0;
    const canSwitchRight = nearRight;

    if (canSwitchLeft && !drag.edgeTimer) {
      drag.edgeTimer = setTimeout(() => {
        setCurrentPageIndex(Math.max(0, pageIdx - 1));
        drag.edgeTimer = null;
        drag.lastTargetKey = "";
      }, 350);
    } else if (canSwitchRight && !drag.edgeTimer) {
      drag.edgeTimer = setTimeout(() => {
        if (pageIdx >= lastPageIndex) {
          const nextPageKey = getDesktopPageKey(pageIdx + 2);
          setLayout((prev) => {
            const next = cloneDesktopLayout(prev, widgetsRef.current);
            ensureDesktopPage(next, nextPageKey);
            return next;
          });
        }
        setCurrentPageIndex(pageIdx + 1);
        drag.edgeTimer = null;
        drag.lastTargetKey = "";
      }, 350);
    } else if (!canSwitchLeft && !canSwitchRight && drag.edgeTimer) {
      clearTimeout(drag.edgeTimer);
      drag.edgeTimer = null;
    }
  }

  function commitDrop() {
    const drag = editDragRef.current;
    if (!drag) return;

    // Read target from ref (NOT React state — avoids stale closure)
    const hasTarget = drag.active && drag.targetPage;
    if (!hasTarget) {
      setLayout(drag.initialLayout);
      setWidgets(drag.initialWidgets);
      setDock(drag.initialDock);
    } else {
      window.setTimeout(() => {
        const trimmedLayout = trimEmptyTrailingPages(layoutRef.current, widgetsRef.current);
        const trimmedPageCount = getDesktopPageKeysForState(trimmedLayout, widgetsRef.current).length;
        setLayout(trimmedLayout);
        setCurrentPageIndex((index) => Math.min(index, Math.max(0, trimmedPageCount - 1)));
      }, 0);
    }

    // Cleanup drag
    if (drag.edgeTimer) clearTimeout(drag.edgeTimer);
    const wasActive = drag.active;
    const flipKey = `${drag.itemType}:${drag.itemId}`;
    const shellLeft = drag.shellLeft;
    const shellTop = drag.shellTop;
    editDragRef.current = null;
    setDropTarget(null);

    const ghost = ghostRef.current;
    const finalize = () => {
      if (ghost) {
        ghost.style.transition = "";
        ghost.style.display = "none";
        const inner = ghost.firstElementChild as HTMLElement | null;
        if (inner) { inner.style.transform = ""; inner.style.filter = ""; }
      }
      setDragItem(null);
    };
    if (!wasActive || !ghost || ghost.style.display === "none") {
      finalize();
      return;
    }
    // 落位动画：ghost 平滑飞到最终格位（布局已实时写入/恢复，元素就位）
    requestAnimationFrame(() => {
      let el: HTMLElement | null = null;
      try {
        el = document.querySelector<HTMLElement>(`[data-flip-id="${CSS.escape(flipKey)}"]`);
      } catch { /* ignore */ }
      if (!el) { finalize(); return; }
      const r = el.getBoundingClientRect();
      const inner = ghost.firstElementChild as HTMLElement | null;
      if (inner) { inner.style.transform = "scale(1)"; inner.style.filter = "none"; }
      ghost.style.transition = "transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1)";
      ghost.style.transform = `translate3d(${r.left - shellLeft}px, ${r.top - shellTop}px, 0)`;
      window.setTimeout(finalize, 210);
    });
  }

  function handleItemPointerDown(
    e: React.PointerEvent,
    itemType: "icon" | "widget",
    itemId: string,
    page: DragPageKey
  ) {
    if (shouldBypassDesktopItemPointerCapture(e.target)) return;

    let el = e.currentTarget as HTMLElement;
    // For widgets wrapped in display:contents div, target the widget-glass element
    if (itemType === "widget") {
      const inner = el.querySelector(".widget-glass") as HTMLElement;
      if (inner) el = inner;
    }
    // The dock lives OUTSIDE .phone-workspace, so its pointermove/up won't reach the
    // workspace handlers until activateDrag transfers capture. Capture to the dock
    // button now so movement is delivered (and can activate the drag) meanwhile.
    if (page === DOCK_PAGE_KEY) {
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    if (editMode) {
      // Start drag immediately in edit mode
      e.stopPropagation();
      e.preventDefault();
      startDragPending(e.pointerId, e.clientX, e.clientY, itemType, itemId, page, el);
      return;
    }
    // Prevent native context menu on long-press (e.g. "save image" on widgets with photos)
    e.preventDefault();
    // Start long-press timer (don't stopPropagation — swipe should still work)
    cancelLongPress();
    longPressRef.current = {
      timer: setTimeout(() => {
        longPressRef.current = null;
        setEditMode(true);
        try { navigator.vibrate?.(30); } catch {}
        startDragPending(e.pointerId, e.clientX, e.clientY, itemType, itemId, page, el);
      }, 500),
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      itemType,
      itemId,
      page,
      element: el,
    };
  }

  async function applyTheme(nextTheme: ThemeProfile): Promise<void> {
    const persisted = writeThemeProfile(nextTheme);
    setSavedTheme(persisted);
    setDraftTheme(persisted);
  }

  /**
   * Suspend real backdrop-filter blur on glass widgets for a short window while
   * the desktop is busy adding/dragging. The live blur is the dominant GPU cost
   * during reflow; we toggle a DOM attribute directly (no React state) so it
   * doesn't itself trigger a re-render, then let the blur snap back when idle.
   */
  function suspendGlass(): void {
    const el = shellRef.current;
    if (!el) return;
    el.setAttribute("data-glass-busy", "1");
    if (glassBusyTimerRef.current) window.clearTimeout(glassBusyTimerRef.current);
    glassBusyTimerRef.current = window.setTimeout(() => {
      shellRef.current?.removeAttribute("data-glass-busy");
      glassBusyTimerRef.current = 0;
    }, 360);
  }

  function handleWidgetsChange(next: WidgetInstance[]): void {
    suspendGlass();
    const currentLayout = layoutRef.current;
    const newLayout = cloneDesktopLayout(currentLayout, next);
    for (const pk of getDesktopPageKeysForState(newLayout, next)) {
      const pn = getDesktopPageNumber(pk) || 1;
      const newPW = next.filter(w => w.page === pn);
      const { placed, overflow } = displaceIconsForWidgets(newLayout[pk] ?? [], newPW);
      newLayout[pk] = placed;
      for (const ov of overflow) {
        placeIconOnAvailablePage(newLayout, next, ov, pn + 1);
      }
    }
    const trimmedLayout = trimEmptyTrailingPages(newLayout, next);
    const trimmedPageCount = getDesktopPageKeysForState(trimmedLayout, next).length;
    setWidgets(next);
    setLayout(trimmedLayout);
    setCurrentPageIndex((index) => Math.min(index, Math.max(0, trimmedPageCount - 1)));
  }

  function handleThemeDesktopChange(next: { widgets: WidgetInstance[]; iconLayout: DesktopLayout; dock?: DesktopIconId[] }): void {
    const normalizedWidgets = sanitizeWidgetsForLayout(next.iconLayout, next.widgets);
    // dock：恢复默认时传入出厂 dock；主题包导入不含 dock 时保留当前。
    // 新布局里明确摆放的图标从 dock 去重（一个图标只能存在于一处）。
    const placedIds = new Set<DesktopIconId>(getDesktopIconLayoutItems(next.iconLayout).map(ic => ic.id));
    const nextDock = normalizeDock(next.dock ?? dockRef.current).filter(id => !placedIds.has(id));
    dockRef.current = nextDock;
    setDock(nextDock);
    writeDockLayout(nextDock);
    const normalizedLayout = normalizeLayout(next.iconLayout, normalizedWidgets, new Set(nextDock));
    setWidgets(normalizedWidgets);
    setLayout(normalizedLayout);
    saveWidgets(normalizedWidgets);
    kvSet(ICON_LAYOUT_STORAGE_KEY, JSON.stringify(normalizedLayout));
  }

  function handleWidgetConfigChange(widgetId: string, config: Record<string, unknown>): void {
    setWidgets((prev) => {
      const next = prev.map((w) =>
        w.id === widgetId ? { ...w, config: { ...w.config, ...config } } : w
      );
      saveWidgets(next);
      return next;
    });
  }

  // 小卷（内置助手）写入组件/DIY 模板后通知桌面重新水合，实现实时热更新。
  // 拖拽进行中不能换底层数组（会打断 FLIP 和落点计算），先挂起，退出编辑模式后补一次。
  const mascotWidgetsDirtyRef = useRef(false);
  useEffect(() => {
    const reload = () => {
      if (editDragRef.current?.active || editDragRef.current?.pending) {
        mascotWidgetsDirtyRef.current = true;
        return;
      }
      setWidgets(loadWidgets());
    };
    window.addEventListener(DESKTOP_WIDGETS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(DESKTOP_WIDGETS_CHANGED_EVENT, reload);
  }, []);
  useEffect(() => {
    if (!editMode && mascotWidgetsDirtyRef.current) {
      mascotWidgetsDirtyRef.current = false;
      setWidgets(loadWidgets());
    }
  }, [editMode]);

  // DIY code 组件的长按发生在沙箱 iframe 里，宿主收不到指针事件；
  // 桥接脚本检测到长按后 postMessage，这里代为进入编辑态。
  // 进入编辑态后 iframe 会放弃指针事件（CSS），后续拖拽走宿主正常链路。
  useEffect(() => {
    function handleDiyLongPress(event: MessageEvent) {
      const data = event.data as { source?: unknown; type?: unknown; widgetId?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.source !== "ai-phone-diy-widget" || data.type !== "longPress") return;
      if (typeof data.widgetId !== "string") return;
      if (!widgetsRef.current.some((w) => w.id === data.widgetId)) return;
      setEditMode(true);
      try { navigator.vibrate?.(30); } catch { /* ignore */ }
    }
    window.addEventListener("message", handleDiyLongPress);
    return () => window.removeEventListener("message", handleDiyLongPress);
  }, []);

  // Build a map of icon skins (icon ID -> data URL) for the theme app preview
  const iconSkinUrls = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const iconPos of getDesktopIconLayoutItems(layout)) {
      const skinId = activeIconSkins[iconPos.id];
      map[iconPos.id] = skinId ? themeAssets[skinId] ?? null : null;
    }
    for (const iconId of dock) {
      const skinId = activeIconSkins[iconId];
      map[iconId] = skinId ? themeAssets[skinId] ?? null : null;
    }
    return map;
  }, [activeIconSkins, layout, dock, themeAssets]);

  useEffect(() => {
    if (activeApp) {
      return;
    }

    const grid = iconGridRef.current;
    if (!grid) {
      return;
    }

    let raf = 0;
    const readGridMetrics = () => {
      const gridEl = iconGridRef.current;
      if (!gridEl) {
        return;
      }

      const firstGlyph = gridEl.querySelector<HTMLElement>(".icon-glyph-box");
      if (firstGlyph) {
        const glyphRect = firstGlyph.getBoundingClientRect();
        if (glyphRect.width > 0) {
          const roundedIconWidth = Number(glyphRect.width.toFixed(2));
          setSlotIconWidth((prev) =>
            prev !== null && Math.abs(prev - roundedIconWidth) < 0.1 ? prev : roundedIconWidth
          );
        }
        if (glyphRect.height > 0) {
          const roundedIconHeight = Number(glyphRect.height.toFixed(2));
          setSlotIconHeight((prev) =>
            prev !== null && Math.abs(prev - roundedIconHeight) < 0.1 ? prev : roundedIconHeight
          );
        }
      }

      const computed = window.getComputedStyle(gridEl);
      const rowGap = Number.parseFloat(computed.rowGap || "0");
      /* rect 高度是 border-box（含 padding），网格行轨道只占内容盒；
         padding-bottom（--home-grid-bottom-trim）不减掉会让 --slot-row-step
         虚高 padding/6，跨行组件随之比图标行低。 */
      const padY =
        (Number.parseFloat(computed.paddingTop || "0") || 0) +
        (Number.parseFloat(computed.paddingBottom || "0") || 0);
      const gridHeight = gridEl.getBoundingClientRect().height - padY;
      const rowHeight = (gridHeight - (GRID_ROWS - 1) * rowGap) / GRID_ROWS;
      const nextRowStep = rowHeight + rowGap;
      if (nextRowStep <= 0) {
        return;
      }
      const roundedRowStep = Number(nextRowStep.toFixed(2));
      setSlotRowStep((prev) =>
        prev !== null && Math.abs(prev - roundedRowStep) < 0.1 ? prev : roundedRowStep
      );
    };

    raf = window.requestAnimationFrame(readGridMetrics);

    const onResize = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(readGridMetrics);
    };
    window.addEventListener("resize", onResize);

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
          window.cancelAnimationFrame(raf);
          raf = window.requestAnimationFrame(readGridMetrics);
        })
        : null;
    observer?.observe(grid);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [activeApp, currentPage, currentPageIndex, currentIcons.length, currentPageWidgets.length]);

  const getSwipePageWidth = useCallback(() => {
    return swipeLayerRef.current?.getBoundingClientRect().width || shellRef.current?.getBoundingClientRect().width || 390;
  }, []);

  // Live finger offset while dragging — a transient CSS var so moving doesn't
  // re-render. Releasing sets it back to 0 and the CSS transition settles the page.
  const setSwipeDrag = useCallback((px: number) => {
    swipeLayerRef.current?.style.setProperty("--swipe-drag", `${px}px`);
  }, []);

  const handleSwipeStart = useCallback((e: React.PointerEvent) => {
    if (activeApp) return;
    if (editMode && editDragRef.current) return;
    // Track tap on empty for "exit edit" detection
    if (editMode) {
      editTapRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    }
    // Start swipe tracking (works in both normal and edit mode)
    const s = swipeRef.current;
    s.startX = e.clientX;
    s.startY = e.clientY;
    s.deltaX = 0;
    s.locked = null;
    s.pointerId = e.pointerId;
    // Suppress the settle transition for 1:1 finger tracking while dragging.
    swipeLayerRef.current?.classList.add("phone-swipe-dragging");
  }, [activeApp, editMode]);

  // ── 状态栏颜色自适应：检测当前背景亮度 ──
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    let debounceTimer: ReturnType<typeof setTimeout>;
    const detect = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => updateStatusBarTone(shell, activeApp), 120);
    };

    // 初始检测（延迟让 app 渲染完毕）
    detect();

    // 监听 workspace 内 DOM 变化（如：进入聊天室、切换子页面）
    // 修复：仅当进入 App 时才监听，防止桌面组件（如时钟秒针更新）疯狂触发画布亮度计算导致严重发烫
    let observer: MutationObserver | null = null;
    if (activeApp !== null) {
      const workspace = shell.querySelector(".phone-workspace");
      if (workspace) {
        observer = new MutationObserver(detect);
        observer.observe(workspace, { childList: true, subtree: true });
      }
    }

    return () => {
      clearTimeout(debounceTimer);
      observer?.disconnect();
    };
  }, [
    activeApp,
    draftTheme.wallpaperBlur,
    draftTheme.wallpaperOpacity,
    draftTheme.wallpaperScale,
    draftTheme.wallpaperX,
    draftTheme.wallpaperY,
    wallpaperDataUrl,
  ]);

  const handleSwipeMove = useCallback((e: React.PointerEvent) => {
    // ── Long-press cancellation ──
    const lp = longPressRef.current;
    if (lp && lp.pointerId === e.pointerId) {
      const dx2 = e.clientX - lp.startX;
      const dy2 = e.clientY - lp.startY;
      if (dx2 * dx2 + dy2 * dy2 > 100) cancelLongPress();
    }

    // ── Edit mode drag ──
    const drag = editDragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      if (drag.pending) {
        const ddx = e.clientX - drag.startX;
        const ddy = e.clientY - drag.startY;
        if (ddx * ddx + ddy * ddy > 9) activateDrag(e);
        return;
      }
      if (drag.active) {
        updateGhostPos(e.clientX, e.clientY);
        updateDropTargetFromPointer(e.clientX, e.clientY);
        checkEdgeSwitch(e.clientX);
        return;
      }
    }

    // Edit mode: cancel empty-tap if moved
    if (editMode) {
      const tap = editTapRef.current;
      if (tap && tap.pointerId === e.pointerId) {
        const tdx = e.clientX - tap.x;
        const tdy = e.clientY - tap.y;
        if (tdx * tdx + tdy * tdy > 100) editTapRef.current = null;
      }
      // Fall through to swipe handling (allow page swipe in edit mode)
    }

    // ── Normal swipe ──
    const s = swipeRef.current;
    if (s.pointerId === null || s.pointerId !== e.pointerId) return;

    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;

    if (s.locked === null) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        s.locked = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        if (s.locked === "x") {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
      } else {
        return;
      }
    }

    if (s.locked !== "x") return;

    // Compute the pixel position from the committed page + finger delta, with
    // rubber-banding past the first/last page, then express it as an offset from
    // the current page's base (= the --swipe-drag CSS var).
    const pageWidth = getSwipePageWidth();
    const page = currentPageIndexRef.current;
    let translateX = -page * pageWidth + dx;
    const minTranslateX = -Math.max(0, pageCount - 1) * pageWidth;
    if (translateX > 0) translateX *= 0.25;
    if (translateX < minTranslateX) translateX = minTranslateX + (translateX - minTranslateX) * 0.25;

    s.deltaX = dx;
    setSwipeDrag(translateX + page * pageWidth);
  }, [editMode, getSwipePageWidth, pageCount, setSwipeDrag]);

  const handleSwipeEnd = useCallback((e: React.PointerEvent) => {
    // Clear long-press
    cancelLongPress();
    // Pointer is up → never keep the transition suppressed, whatever branch we take.
    swipeLayerRef.current?.classList.remove("phone-swipe-dragging");

    // ── Edit mode drag end ──
    const drag = editDragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      commitDrop();
      return;
    }

    // Edit mode: tap on empty → exit edit mode (only if no swipe happened)
    if (editMode) {
      const tap = editTapRef.current;
      if (tap && tap.pointerId === e.pointerId) {
        exitEditMode();
        editTapRef.current = null;
        // Also clean up swipe state
        swipeRef.current.pointerId = null;
        return;
      }
      editTapRef.current = null;
      // Fall through to swipe end handling
    }

    // ── Normal swipe end ──
    const s = swipeRef.current;
    if (s.pointerId === null || s.pointerId !== e.pointerId) return;
    s.pointerId = null;

    const dx = s.deltaX;
    s.deltaX = 0;
    const pageWidth = getSwipePageWidth();
    const swipeThreshold = Math.max(SWIPE_MIN_THRESHOLD, pageWidth * SWIPE_THRESHOLD_RATIO);

    const page = currentPageIndexRef.current;
    let targetPageIndex = page;
    if (Math.abs(dx) > swipeThreshold) {
      targetPageIndex = Math.min(Math.max(0, pageCount - 1), Math.max(0, page + (dx < 0 ? 1 : -1)));
    }

    // Re-enable the transition, clear the finger offset, and commit the page.
    // currentPageIndex is the single source of truth → CSS settles to it, no race.
    swipeLayerRef.current?.classList.remove("phone-swipe-dragging");
    setSwipeDrag(0);
    if (targetPageIndex !== page) setCurrentPageIndex(targetPageIndex);
  }, [editMode, getSwipePageWidth, pageCount, setSwipeDrag]);

  const handleCloseXiaohongshu = useCallback((isBusy?: boolean) => {
    const shouldKeepMounted = isBusy ?? xiaohongshuBusy;
    setActiveApp(null);
    if (shouldKeepMounted) {
      setNotice("小红书正在后台生成，完成后会自动更新。");
      return;
    }
    setXiaohongshuBusy(false);
    setXiaohongshuMounted(false);
  }, [xiaohongshuBusy]);

  const handleCloseShopping = useCallback((isBusy?: boolean) => {
    const shouldKeepMounted = isBusy ?? shoppingBusy;
    setActiveApp(null);
    if (shouldKeepMounted) {
      setNotice("购物正在后台生成，完成后会自动更新。");
      return;
    }
    setShoppingBusy(false);
    setShoppingMounted(false);
  }, [shoppingBusy]);

  function closeCustomAppRunner(app: InstalledCustomApp): void {
    const launchState = customAppLaunchContext?.appId === app.id ? customAppLaunchContext : null;
    setCustomAppLaunchContext(null);
    if (launchState?.returnTo?.appId === "chat") {
      const sessionId = launchState.returnTo.sessionId;
      setActiveApp("chat" as IconId);
      setChatInitSessionId(sessionId ?? null);
      if (sessionId) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(CHAT_OPEN_SESSION_EVENT, { detail: { sessionId } }));
        }, 0);
      }
      return;
    }
    setActiveApp(null);
  }

  function dismissPendingCustomAppUpdate(): void {
    if (customAppUpdateBusy || !customAppUpdatePrompt) return;
    setCustomAppUpdatePrompt(null);
  }

  async function confirmPendingCustomAppUpdate(): Promise<void> {
    if (customAppUpdateBusy || !customAppUpdatePrompt) return;
    const pending = customAppUpdatePrompt;
    setCustomAppUpdateBusy(true);
    try {
      const result = await updateInstalledCustomAppFromMarket(pending.app, {
        resolveMarketItem: async () => pending.item,
      });
      setCustomApps(loadInstalledCustomApps());
      setCustomAppUpdatePrompt(null);
      setNotice(result.previousVersion === result.installed.version
        ? `已同步「${result.installed.name}」`
        : `已更新「${result.installed.name}」到 v${result.installed.version}`);
      activateCustomApp(result.installed.id, pending.launchContext);
    } catch (err) {
      setNotice(`更新失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCustomAppUpdateBusy(false);
    }
  }

  const handleCustomAppBackgroundComplete = useCallback((runId: string, result: { ok: boolean; reason: string; errors?: string[] }) => {
    setCustomAppBackgroundRuns(prev => prev.filter(run => run.id !== runId));
    if (!result.ok && result.reason !== "not_subscribed") {
      const message = result.errors?.[0] || result.reason;
      console.warn(`[CustomAppBackground] ${runId} failed: ${message}`);
    }
  }, []);

  const handleCustomAppBackgroundToolComplete = useCallback((runId: string, result: { ok: boolean; reason: string; result?: unknown; error?: string }) => {
    setCustomAppBackgroundToolRuns(prev => prev.filter(run => run.id !== runId));
    const pending = pendingCustomAppBackgroundToolsRef.current.get(runId);
    if (!pending) return;
    pendingCustomAppBackgroundToolsRef.current.delete(runId);
    window.clearTimeout(pending.timeoutId);
    if (result.ok) {
      pending.resolve(result.result);
    } else {
      pending.reject(new Error(result.error || result.reason));
    }
  }, []);

  function renderAppBody() {
    if (!activeApp || !activeIcon) {
      return null;
    }

    const customApp = getCustomAppForIcon(activeApp);
    if (customApp) {
      return (
        <CustomAppRunner
          app={customApp}
          launchContext={customAppLaunchContext?.appId === customApp.id ? customAppLaunchContext.context : null}
          onClose={() => closeCustomAppRunner(customApp)}
          onNotice={setNotice}
        />
      );
    }

    if (activeApp === "chat") {
      return (
        <PhoneChatApp
          onClose={() => {
            setActiveApp(null);
            setActiveChatSession(null);
            setChatInitSessionId(null);
          }}
          initialSessionId={chatInitSessionId}
          onSessionChange={setActiveChatSession}
        />
      );
    }

    if (activeApp === "theme") {
      return (
        <PhoneThemeApp
          draft={draftTheme}
          onDraftChange={setDraftTheme}
          onApply={applyTheme}
          onClose={() => setActiveApp(null)}
          onNotice={setNotice}
          widgets={widgets}
          onWidgetsChange={handleWidgetsChange}
          onDesktopThemeChange={handleThemeDesktopChange}
          pageIcons={layout}
          iconSkins={iconSkinUrls}
          wallpaperStyle={wallpaperStyle}
        />
      );
    }

    if (activeApp === "characters") {
      return (
        <PhoneCharacterApp
          onClose={() => setActiveApp(null)}
          onNotice={setNotice}
        />
      );
    }

    if (activeApp === "settings") {
      return (
        <PhoneSettingsApp
          onClose={() => setActiveApp(null)}
          onNotice={setNotice}
        />
      );
    }

    if (activeApp === "resources") {
      return (
        <PhoneResourcesApp
          onClose={() => setActiveApp(null)}
          onNotice={setNotice}
          initialPage={resourcesInitialPage}
        />
      );
    }

    if (activeApp === "music") {
      return <MusicApp onClose={() => setActiveApp(null)} />;
    }

    if (activeApp === "calendar") {
      return <PhoneCalendarApp onClose={() => setActiveApp(null)} onNotice={setNotice} />;
    }

    if (activeApp === "diary") {
      return <DiaryApp onClose={() => setActiveApp(null)} onNotice={setNotice} />;
    }

    if (activeApp === "xiaohongshu") {
      return null;
    }

    if (activeApp === "story") {
      return <StoryApp onClose={() => setActiveApp(null)} />;
    }

    if (activeApp === "vnmode") {
      return <VnApp onClose={() => setActiveApp(null)} />;
    }

    if (activeApp === "reading") {
      return <ReadingApp onClose={() => setActiveApp(null)} />;
    }

    if (activeApp === "mapmode") {
      return <MapApp onClose={() => setActiveApp(null)} />;
    }

    if (activeApp === "dwelling") {
      // DwellingApp is rendered separately (kept alive) — see below
      return null;
    }

    if (activeApp === "checkphone") {
      return <CheckPhoneApp onClose={() => setActiveApp(null)} />;
    }

    if (activeApp === "shopping") {
      return null;
    }

    if (activeApp === "game") {
      return <GameHubApp onClose={() => setActiveApp(null)} />;
    }

    if (activeApp === "appmarket") {
      return (
        <AppMarketApp
          onClose={() => {
            setAppMarketLaunchContext(null);
            setActiveApp(null);
          }}
          onOpenCustomApp={(appId) => {
            setAppMarketLaunchContext(null);
            openCustomAppWithBackgroundUpdateCheck(toCustomAppIconId(appId));
          }}
          onInstallToDesktop={handleInstallCustomAppToDesktop}
          onNotice={setNotice}
          launchContext={appMarketLaunchContext}
        />
      );
    }

    if (activeApp === "interview_magazine") {
      return <InterviewMagazineApp onClose={() => setActiveApp(null)} />;
    }

    if (activeApp === "cocreate") {
      return <CoCreateApp onClose={() => setActiveApp(null)} onNotice={setNotice} />;
    }

    return activeApp in ICONS
      ? <PhonePlaceholderApp icon={ICONS[activeApp as IconId]} onClose={() => setActiveApp(null)} />
      : null;
  }

  return (
    <>
      <section
        className="phone-shell-wrap"
        style={{
          ...phoneThemeStyle,
          "--status-bar-drop": `${draftTheme.statusBarDropPx ?? 0}px`
        } as React.CSSProperties}
        data-hide-top-bar={draftTheme.hideTopBar ? "1" : "0"}
      >
        {/* User's global custom CSS is injected via useEffect into document.head */}
        <div className="phone-case">
          <div className="phone-frame">
            <div
              ref={shellRef}
              className={activeApp ? "phone-shell app-open-shell" : "phone-shell"}
              data-ui="phone-screen"
              data-active-app={activeApp || ""}
              data-app={activeApp || ""}
              data-shadows={Number(draftTheme.cssOverrides["--desktop-global-shadow"] ?? (draftTheme.enableGlobalShadows ? "0.5" : "0")) > 0 ? "on" : "off"}
              data-icon-effect={iconEffect}
              data-widget-effect={widgetEffect}
              data-glass-pass={glassPaintPass % 2}
              data-borders={draftTheme.enableGlobalBorder ? "on" : "off"}
              style={{
                "--user-border-color": draftTheme.globalBorderColor,
                "--desktop-outline-color": resolvedOutlineColor,
                "--custom-global-stroke": draftTheme.cssOverrides["--desktop-icon-stroke"] || "2.0",
                "--desktop-outline-width": resolvedOutlineWidth,
                "--desktop-outline-opacity": draftTheme.cssOverrides["--desktop-outline-opacity"] || "1",
                "--desktop-shadow-strength": draftTheme.cssOverrides["--desktop-global-shadow"] ?? (draftTheme.enableGlobalShadows ? "0.5" : "0")
              } as React.CSSProperties}
            >
              <div className="phone-wallpaper" style={wallpaperStyle} />

              <header className="phone-status-bar">
                <StatusClock />
                <div className="status-island" />
                <div className="status-right" aria-hidden>
                  <svg viewBox="0 0 72 51" className="status-signal" fill="currentColor">
                    <path d="M11.6,41.9c0,1.4,0,2.8,0,4.3c0,2.3-1.4,3.7-3.6,3.8c-1.5,0.1-3,0.1-4.4,0c-1.9-0.1-3.2-1.2-3.4-3c-0.3-3.4-0.2-6.8,0-10.1c0.1-1.8,1.5-3,3.3-3.1c1.5-0.1,3-0.1,4.4,0c2.2,0.1,3.6,1.5,3.7,3.8C11.6,39,11.6,40.5,11.6,41.9z" />
                    <path d="M31.7,36.9c0,2.8,0,5.7,0,8.5c0,3.5-1.1,4.6-4.5,4.6c-1.2,0-2.4,0-3.6,0c-2-0.1-3.4-1.5-3.4-3.4c-0.1-6.5-0.1-13,0-19.6c0-1.9,1.6-3.4,3.6-3.5c1.4-0.1,2.7,0,4.1,0c2.3,0.1,3.8,1.4,3.8,3.8C31.8,30.5,31.7,33.7,31.7,36.9z" />
                    <path d="M40.4,30.3c0-5,0-10.1,0-15.1c0-3,1.2-4.2,4.2-4.2c1,0,2,0,3,0c2.9,0,4.2,1.4,4.2,4.2c0,9,0,17.9,0,26.9c0,1.4,0,2.7,0,4.1c0,2.3-1.4,3.8-3.7,3.8c-1.3,0-2.6,0-3.9,0c-2.5-0.1-3.8-1.3-3.8-3.9C40.4,40.9,40.4,35.6,40.4,30.3z" />
                    <path d="M72,25.7c0,6.6,0,13.3,0,19.9c0,3.2-1.2,4.4-4.4,4.4c-1.1,0-2.3,0-3.4,0c-2.3-0.1-3.7-1.4-3.8-3.8c0-2.9,0-5.8,0-8.7c0-10.6,0-21.2,0-31.8c0-3.3,1.2-4.5,4.5-4.5c0.9,0,1.8,0,2.7,0c3.1,0,4.4,1.3,4.4,4.5C72,12.3,72,19,72,25.7z" />
                  </svg>
                  <svg viewBox="98 0 67 51" className="status-wifi" fill="currentColor">
                    <path d="M134.6,0c9.8,0.1,20.4,4.8,29.2,13.7c1.6,1.6,1.6,2.1,0,3.8c-0.8,0.8-1.6,1.6-2.3,2.5c-1.1,1.3-2.1,1.2-3.3,0c-3.5-3.7-7.6-6.5-12.3-8.6c-13-5.6-28.3-2.7-38.7,7.3c-0.5,0.5-0.9,0.9-1.4,1.4c-1,1.1-2,1.1-3-0.1c-0.9-1.1-2-2-3-3.1c-0.9-0.9-0.9-1.8,0-2.8C107.7,5.4,119.9,0,134.6,0z" />
                    <path d="M132.1,13.9c8.9,0.2,16.5,3.5,22.8,9.8c1.1,1.1,1.1,2.1,0,3.2c-0.9,0.9-1.8,1.9-2.7,2.8c-1.1,1.2-2,1.1-3.1,0c-3.9-3.9-8.6-6.3-14.1-6.9c-7.5-0.9-13.9,1.5-19.4,6.5c-1.9,1.8-2.1,1.8-3.9,0c-0.8-0.8-1.6-1.7-2.5-2.6c-1.1-1-1-2,0-3C115.5,17.5,123.1,14.1,132.1,13.9z" />
                    <path d="M131.9,27.8c5.4,0.1,9.8,2,13.6,5.5c1.1,1,1.2,2,0.1,3c-0.9,0.9-1.9,1.8-2.7,2.8c-1.1,1.4-2.1,1.3-3.4,0.2c-3.6-3-7.7-3.7-12.1-1.9c-1.3,0.5-2.4,1.3-3.4,2.2c-0.9,0.8-1.8,0.9-2.6-0.1c-1.1-1.1-2.1-2.2-3.2-3.3c-0.9-1-0.8-1.8,0.1-2.8C122.2,29.8,126.8,27.9,131.9,27.8z" />
                    <path d="M132,41.6c1.8,0,3.5,0.5,5,1.6c0.9,0.6,1.1,1.3,0.2,2.2c-1.5,1.5-2.9,2.9-4.4,4.4c-0.7,0.7-1.2,0.6-1.8,0c-1.5-1.6-2.9-3.1-4.4-4.6c-0.7-0.8-0.5-1.3,0.2-1.9C128.4,42.1,130.1,41.5,132,41.6z" />
                  </svg>
                  <svg viewBox="0 0 26 12" className="status-battery" fill="currentColor">
                    <rect x="0.5" y="0.5" width="22" height="11" rx="2.6" fill="none" stroke="currentColor" strokeOpacity="0.42" strokeWidth="1" />
                    <rect x="22.7" y="4" width="1.8" height="4" rx="0.7" opacity="0.42" />
                    <rect x="2" y="2" width="14" height="8" rx="1.5" />
                  </svg>
                </div>
              </header>

              {notice ? (
                <aside className="phone-shell-notice" role="status" aria-live="polite">
                  {notice}
                </aside>
              ) : null}

              {customAppUpdatePrompt ? (
                <div
                  className="modal-overlay"
                  data-ui="modal"
                  role="presentation"
                  onClick={dismissPendingCustomAppUpdate}
                >
                  <div
                    className="modal-dialog"
                    data-ui="modal-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label="APP 更新"
                    onClick={event => event.stopPropagation()}
                  >
                    <div className="modal-header" data-ui="modal-header">
                      <div className="ui-icon-circle" data-variant="action">
                        {customAppUpdateBusy ? <LoaderCircle className="am-spin" size={20} /> : <RefreshCw size={20} />}
                      </div>
                      <h3 className="modal-title">发现新版本</h3>
                    </div>
                    <div className="modal-body" data-ui="modal-body">
                      <p>
                        「{customAppUpdatePrompt.app.name}」当前为 v{customAppUpdatePrompt.app.version}，
                        市场版本为 v{customAppUpdatePrompt.item.version}。是否立即更新？
                      </p>
                      {customAppUpdatePrompt.item.changelog?.trim() ? (
                        <p style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                          更新日志：{customAppUpdatePrompt.item.changelog.trim()}
                        </p>
                      ) : null}
                    </div>
                    <div className="modal-footer" data-ui="modal-footer">
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost"
                        onClick={dismissPendingCustomAppUpdate}
                        disabled={customAppUpdateBusy}
                      >
                        稍后
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-primary"
                        onClick={() => void confirmPendingCustomAppUpdate()}
                        disabled={customAppUpdateBusy}
                      >
                        {customAppUpdateBusy ? "更新中" : "立即更新"}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {customAppBackgroundRuns.length > 0 || customAppBackgroundToolRuns.length > 0 ? (
                <div
                  aria-hidden
                  style={{
                    position: "fixed",
                    left: "-10000px",
                    top: 0,
                    width: 1,
                    height: 1,
                    overflow: "hidden",
                    opacity: 0,
                    pointerEvents: "none",
                  }}
                >
                  {customAppBackgroundRuns.map(run => (
                    <CustomAppBackgroundRunnerBoundary
                      key={run.id}
                      runId={run.id}
                      kind="event"
                      onEventError={handleCustomAppBackgroundComplete}
                    >
                      <CustomAppRunner
                        app={run.app}
                        launchContext={run.launchContext}
                        embedded
                        backgroundEvent={{
                          runId: run.id,
                          eventName: run.eventName,
                          payload: run.payload,
                          timeoutMs: run.timeoutMs,
                        }}
                        onClose={() => handleCustomAppBackgroundComplete(run.id, { ok: true, reason: "closed" })}
                        onNotice={setNotice}
                        onBackgroundEventComplete={handleCustomAppBackgroundComplete}
                      />
                    </CustomAppBackgroundRunnerBoundary>
                  ))}
                  {customAppBackgroundToolRuns.map(run => (
                    <CustomAppBackgroundRunnerBoundary
                      key={run.id}
                      runId={run.id}
                      kind="tool"
                      onToolError={handleCustomAppBackgroundToolComplete}
                    >
                      <CustomAppRunner
                        app={run.app}
                        launchContext={run.launchContext}
                        embedded
                        backgroundTool={{
                          runId: run.id,
                          payload: run.payload,
                          timeoutMs: run.timeoutMs,
                        }}
                        onClose={() => handleCustomAppBackgroundToolComplete(run.id, {
                          ok: false,
                          reason: "closed",
                          error: "APP handler 在工具执行完成前关闭。",
                        })}
                        onNotice={setNotice}
                        onBackgroundToolComplete={handleCustomAppBackgroundToolComplete}
                      />
                    </CustomAppBackgroundRunnerBoundary>
                  ))}
                </div>
              ) : null}

              {/* Incoming call bar — global overlay */}
              {incomingCall && (
                <div className="incoming-call-bar">
                  <div className="incoming-call-bar-info">
                    {incomingCall.charAvatar ? (
                      <img src={incomingCall.charAvatar} alt="" className="incoming-call-bar-avatar" />
                    ) : (
                      <span className="incoming-call-bar-avatar incoming-call-bar-avatar-fallback">
                        {incomingCall.charName[0] || "?"}
                      </span>
                    )}
                    <div className="incoming-call-bar-text">
                      <span className="incoming-call-bar-name">{incomingCall.charName}</span>
                      <span className="incoming-call-bar-type">
                        {incomingCall.isGroup ? "群" : ""}{incomingCall.type === "voice" ? "语音通话" : "视频通话"}
                      </span>
                    </div>
                  </div>
                  <div className="incoming-call-bar-actions">
                    <button
                      className="incoming-call-bar-btn incoming-call-bar-decline"
                      onClick={() => {
                        const call = incomingCall;
                        const callLabel = call.type === "voice" ? "语音通话" : "视频通话";
                        pushChatMessage({
                          sessionId: call.sessionId,
                          role: "user",
                          content: `[我拒绝了${callLabel}]`,
                        });
                        setIncomingCall(null);
                        // Trigger AI reply after declining — fire event for chat-room, plus background fallback
                        window.dispatchEvent(new CustomEvent("call-declined", { detail: { sessionId: call.sessionId } }));
                        const sessions = loadChatSessions();
                        const sess = sessions.find(s => s.id === call.sessionId);
                        if (sess) {
                          const sid = call.sessionId;
                          kvSet("chat-generating:" + sid, JSON.stringify({ startedAt: Date.now() }));
                          const msgs = loadChatMessages(sid);
                          generateChatCompletion(sess, msgs, { appTags: ["chat", "text"] }).then(cr => { const text = flattenCompletionResult(cr);
                            const { parts, stateValues } = parseAIResponse(text, []);
                            for (const p of parts) {
                              if (p.mediaType === "voice_call" || p.mediaType === "video_call") continue;
                              pushChatMessage({ sessionId: sid, role: "assistant", content: p.content, mediaType: p.mediaType, mediaData: p.mediaData });
                            }
                            scheduleFollowUp(sid, 0, stateValues);
                          }).catch(() => {}).finally(() => {
                            kvRemove("chat-generating:" + sid);
                            window.dispatchEvent(new CustomEvent("chat-bg-complete", { detail: { sessionId: sid } }));
                          });
                        }
                      }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                        <line x1="23" y1="1" x2="1" y2="23" />
                      </svg>
                    </button>
                    <button
                      className="incoming-call-bar-btn incoming-call-bar-accept"
                      onClick={() => {
                        const call = incomingCall;
                        setIncomingCall(null);
                        setActiveApp("chat" as IconId);
                        setChatInitSessionId(call.sessionId);
                        // Wait for chat-room to mount, then trigger the call screen
                        // __fromBar prevents desktop-shell handler from re-showing the bar
                        setTimeout(() => {
                          window.dispatchEvent(new CustomEvent("ai-call-trigger", {
                            detail: { sessionId: call.sessionId, type: call.type, __fromBar: true },
                          }));
                        }, 600);
                      }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}

              {chatMessageNotice && !incomingCall ? (
                <button
                  type="button"
                  className="chat-message-notice-bar"
                  style={{
                    transform: noticeDragY ? `translateY(${noticeDragY}px)` : undefined,
                    opacity: noticeDragY < 0 ? Math.max(0, 1 + noticeDragY / 160) : 1,
                    transition: noticeDragRef.current.dragging ? "none" : "transform 180ms ease, opacity 180ms ease",
                    touchAction: "none",
                  }}
                  onPointerDown={handleNoticePointerDown}
                  onPointerMove={handleNoticePointerMove}
                  onPointerUp={handleNoticePointerUp}
                  onPointerCancel={handleNoticePointerUp}
                  onClick={handleNoticeClick}
                  aria-label={`查看 ${chatMessageNotice.title} 的新消息`}
                >
                  <div className="chat-message-notice-info">
                    {chatMessageNotice.avatar ? (
                      <img src={chatMessageNotice.avatar} alt="" className="chat-message-notice-avatar" />
                    ) : (
                      <span className="chat-message-notice-avatar chat-message-notice-avatar-fallback">
                        {chatMessageNotice.title[0] || "消"}
                      </span>
                    )}
                    <div className="chat-message-notice-text">
                      <span className="chat-message-notice-name">{chatMessageNotice.title}</span>
                      <span className="chat-message-notice-body">{chatMessageNotice.body}</span>
                    </div>
                  </div>
                  <span className="chat-message-notice-action">查看</span>
                </button>
              ) : null}

              {/* Music custom CSS — injected at shell level so it persists across apps */}
              {musicCustomCss && <style dangerouslySetInnerHTML={{ __html: musicCustomCss }} />}

              {/* Music overlays are isolated so playback progress does not rerender the desktop shell. */}
              <MusicShellOverlays
                activeApp={activeApp}
                onControllerChange={handleMusicOverlayControllerChange}
              />

              {/* Mini chat window — persists across music pages */}
              <MiniAppWindow
                title="聊天"
                visible={showMiniChat}
                onClose={handleMiniChatClose}
                onExpand={handleMiniChatExpand}
              >
                <PhoneChatApp
                  onClose={handleMiniChatClose}
                  onSessionChange={handleMiniChatSessionChange}
                  sharePayload={miniSharePayload}
                  onShareDone={handleMiniShareDone}
                />
              </MiniAppWindow>

              <div
                ref={workspaceRef}
                className={
                  activeApp
                    ? "phone-workspace app-open"
                    : editMode
                      ? "phone-workspace edit-mode"
                      : "phone-workspace"
                }
                style={{
                  touchAction: activeApp ? undefined : editMode ? "none" : "pan-y",
                  ...(!desktopReady && !activeApp ? { visibility: "hidden" } : {}),
                }}
                onPointerDown={handleSwipeStart}
                onPointerMove={handleSwipeMove}
                onPointerUp={handleSwipeEnd}
                onPointerCancel={handleSwipeEnd}
              >
                {/* Edit mode Done button */}
                {editMode && !activeApp && (
                  <>
                    <button type="button" className="edit-mode-edit" style={{ left: 16 }} onPointerDown={e => e.stopPropagation()} onClick={() => { setShowWidgetPicker(true); setShowDesktopCustomizer(false); }}>
                      添加
                    </button>
                    <button type="button" className="edit-mode-edit" style={{ left: "50%", transform: "translateX(-50%)" }} onPointerDown={e => e.stopPropagation()} onClick={() => { setShowDesktopCustomizer(true); setShowWidgetPicker(false); }}>
                      装扮
                    </button>
                    <button type="button" className="edit-mode-done" onClick={exitEditMode}>
                      完成
                    </button>
                  </>
                )}


                {!activeApp ? (
                  <>
                    <div
                      ref={swipeLayerRef}
                      className="phone-swipe-layer"
                      style={{ "--swipe-page": boundedCurrentPageIndex } as CSSProperties}
                    >
                      {pageKeys.map((pageKey, pageIndex) => {
                        const pageNum = getDesktopPageNumber(pageKey) || pageIndex + 1;
                        const pageIcons = layout[pageKey] ?? [];
                        const pageWidgets = widgets.filter((w) => w.page === pageNum);
                        const pageIconPositions = computeIconPositions(pageIcons, pageWidgets);

                        return (
                          <section
                            key={pageKey}
                            ref={(el) => {
                              gridRefs.current[pageKey] = el;
                              if (pageIndex === 0) iconGridRef.current = el;
                            }}
                            className={`icon-grid icon-grid-explicit icon-grid-${pageKey}`}
                            aria-label={pageIndex === 0 ? TEXT.ariaDesktopIcons : undefined}
                            style={
                              slotIconWidth || slotIconHeight || slotRowStep
                                ? ({
                                  ...(slotIconWidth ? { "--slot-icon-width": `${slotIconWidth}px` } : {}),
                                  ...(slotIconHeight ? { "--slot-icon-height": `${slotIconHeight}px` } : {}),
                                  ...(slotRowStep ? { "--slot-row-step": `${slotRowStep}px` } : {})
                                } as CSSProperties)
                                : undefined
                            }
                          >
                            {/* Render widgets for this page */}
                            {pageWidgets.map((widget) => {
                              const wDragging = dragItem?.type === "widget" && dragItem.id === widget.id;
                              return (
                                <div
                                  key={widget.id}
                                  className={wDragging ? "widget-drag-wrap dragging" : "widget-drag-wrap"}
                                  onPointerDownCapture={(e) => handleItemPointerDown(e, "widget", widget.id, pageKey)}
                                >
                                  <WidgetRenderer widget={widget} onConfigChange={handleWidgetConfigChange} />
                                  {editMode && !wDragging && (
                                    <button
                                      type="button"
                                      className="widget-delete-btn"
                                      style={{
                                        gridRow: widget.row,
                                        gridColumn: `${widget.col + WIDGET_SIZE_CELLS[widget.size][1] - 1}`,
                                      }}
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleWidgetsChange(widgetsRef.current.filter((w) => w.id !== widget.id));
                                      }}
                                      aria-label="删除组件"
                                    >
                                      ×
                                    </button>
                                  )}
                                </div>
                              );
                            })}

                            {/* Drop target indicator */}
                            {editMode && dropTarget && dropTarget.page === pageKey && (() => {
                              if (dragItem?.type === "widget") {
                                const w = widgets.find((ww) => ww.id === dragItem.id);
                                if (!w) return null;
                                const [wr, wc] = WIDGET_SIZE_CELLS[w.size];
                                return (
                                  <div
                                    className={`drop-indicator widget-${w.size}`}
                                    style={{
                                      gridRow: `${dropTarget.row} / span ${wr}`,
                                      gridColumn: `${dropTarget.col} / span ${wc}`,
                                      justifySelf: "start",
                                      alignSelf: "start",
                                      marginLeft: "var(--slot-icon-offset-x)",
                                    }}
                                  />
                                );
                              }
                              return (
                                <div
                                  className="drop-indicator"
                                  style={{ gridRow: dropTarget.row, gridColumn: dropTarget.col }}
                                />
                              );
                            })()}

                            {/* Render icons with explicit positions for this page */}
                            {pageIcons.map((iconPos) => {
                              const iconId = iconPos.id;
                              const icon = getDesktopIconMeta(iconId);
                              const pos = pageIconPositions.get(iconId);
                              if (!pos || !icon) return null;
                              const customApp = icon.customApp;
                              const builtinIconId = customApp ? null : icon.id as IconId;
                              const iconSkinId = activeIconSkins[iconId];
                              const iconSkinUrl = iconSkinId ? themeAssets[iconSkinId] ?? null : null;
                              const customIconUrl = customApp?.iconDataUrl ?? null;
                              const iconImageUrl = iconSkinUrl || customIconUrl;
                              const hasImageIcon = Boolean(iconImageUrl);
                              const isDragging = dragItem?.type === "icon" && dragItem.id === iconId;
                              const badgeCount = customApp ? customAppBadges[customApp.id] ?? 0 : 0;
                              return (
                                <button
                                  key={iconId}
                                  data-flip-id={`icon:${iconId}`}
                                  className={isDragging ? "icon-item dragging" : "icon-item"}
                                  style={{ gridRow: pos.row, gridColumn: pos.col }}
                                  onClick={() => { if (!editMode) openApp(iconId); }}
                                  onPointerDown={(e) => handleItemPointerDown(e, "icon", iconId, pageKey)}
                                >
                                  <span
                                    className={hasImageIcon ? "icon-glyph-box icon-glyph-box-skin" : "icon-glyph-box"}
                                    style={hasImageIcon ? undefined : { "--icon-tone": icon.tone } as React.CSSProperties}
                                    aria-hidden
                                  >
                                    {iconImageUrl ? (
                                      <span
                                        className="icon-skin-layer"
                                        style={{ backgroundImage: `url("${iconImageUrl}")` }}
                                      />
                                    ) : null}
                                    {builtinIconId ? (
                                      <IconGlyph
                                        id={builtinIconId}
                                        className={
                                          builtinIconId === "music"
                                            ? iconSkinUrl
                                              ? "icon-glyph icon-glyph-music icon-glyph-hidden"
                                              : "icon-glyph icon-glyph-music"
                                            : iconSkinUrl
                                              ? "icon-glyph icon-glyph-hidden"
                                              : "icon-glyph"
                                        }
                                      />
                                    ) : customIconUrl ? null : (
                                      <CustomAppGlyph seed={customApp?.name || icon.label} className="icon-glyph" />
                                    )}
                                    {badgeCount > 0 ? (
                                      <span className="desktop-icon-badge" aria-label={`${badgeCount} 条未读`}>
                                        {badgeCount > 99 ? "99+" : badgeCount}
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="icon-label">{icon.label}</span>
                                </button>
                              );
                            })}
                          </section>
                        );
                      })}
                    </div>

                    <div className="page-controls">
                      {pageKeys.map((pageKey, pageIndex) => (
                        <button
                          key={pageKey}
                          type="button"
                          className={boundedCurrentPageIndex === pageIndex ? "dot active dot-btn" : "dot dot-btn"}
                          aria-label={`第${pageIndex + 1}页`}
                          onClick={() => setCurrentPageIndex(pageIndex)}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <section className="phone-app-pane" style={activeApp === "dwelling" || activeApp === "xiaohongshu" || activeApp === "shopping" ? { display: "none" } : undefined}>
                      {renderAppBody()}
                    </section>
                    {/* DwellingApp stays mounted while generating — auto-unmounts when idle */}
                    {dwellingMounted && (
                      <section className="phone-app-pane" style={activeApp !== "dwelling" ? { display: "none" } : undefined}>
                        <DwellingApp
                          onClose={() => setActiveApp(null)}
                          visible={activeApp === "dwelling"}
                          onIdle={() => { if (activeApp !== "dwelling") setDwellingMounted(false); }}
                        />
                      </section>
                    )}
                  </>
                )}
                {xiaohongshuMounted && (
                  <section className="phone-app-pane" style={activeApp !== "xiaohongshu" ? { display: "none" } : undefined}>
                    <XiaohongshuApp
                      onClose={handleCloseXiaohongshu}
                      onNotice={setNotice}
                      visible={activeApp === "xiaohongshu"}
                      onBusyChange={setXiaohongshuBusy}
                      onIdle={() => {
                        if (activeApp !== "xiaohongshu") {
                          setXiaohongshuBusy(false);
                          setXiaohongshuMounted(false);
                        }
                      }}
                    />
                  </section>
                )}
                {shoppingMounted && (
                  <section className="phone-app-pane" style={activeApp !== "shopping" ? { display: "none" } : undefined}>
                    <ShoppingApp
                      onClose={handleCloseShopping}
                      visible={activeApp === "shopping"}
                      onBusyChange={setShoppingBusy}
                      onIdle={() => {
                        if (activeApp !== "shopping") {
                          setShoppingBusy(false);
                          setShoppingMounted(false);
                        }
                      }}
                    />
                  </section>
                )}
              </div>

              {!activeApp ? (
                <footer
                  ref={dockElRef}
                  className={editMode ? "dock edit-mode" : "dock"}
                  {...(dockSkinUrl ? { "data-skinned": "" } : {})}
                  style={{ "--dock-count": Math.max(1, dock.length) } as CSSProperties}
                  onPointerMove={handleSwipeMove}
                  onPointerUp={handleSwipeEnd}
                  onPointerCancel={handleSwipeEnd}
                >
                  {dockSkinUrl && (
                    <span className="dock-skin-layer" style={{ backgroundImage: `url("${dockSkinUrl}")` }} />
                  )}
                  {dock.map((iconId) => {
                    const icon = getDesktopIconMeta(iconId);
                    if (!icon) return null;
                    const customApp = icon.customApp;
                    const builtinIconId = customApp ? null : (icon.id as IconId);
                    const iconSkinId = activeIconSkins[iconId];
                    const iconSkinUrl = iconSkinId ? themeAssets[iconSkinId] ?? null : null;
                    const customIconUrl = customApp?.iconDataUrl ?? null;
                    const iconImageUrl = iconSkinUrl || customIconUrl;
                    const hasImageIcon = Boolean(iconImageUrl);
                    const isDragging = dragItem?.type === "icon" && dragItem.id === iconId;
                    return (
                      <button
                        key={iconId}
                        type="button"
                        data-flip-id={`icon:${iconId}`}
                        className={isDragging ? "dock-item dragging" : "dock-item"}
                        onClick={() => { if (!editMode) openApp(iconId); }}
                        onPointerDown={(e) => handleItemPointerDown(e, "icon", iconId, DOCK_PAGE_KEY)}
                      >
                        <span
                          className={
                            hasImageIcon
                              ? "icon-glyph-box dock-glyph-box icon-glyph-box-skin"
                              : "icon-glyph-box dock-glyph-box"
                          }
                          style={hasImageIcon ? undefined : { "--icon-tone": icon.tone } as React.CSSProperties}
                          aria-hidden
                        >
                          {iconImageUrl ? (
                            <span className="icon-skin-layer" style={{ backgroundImage: `url("${iconImageUrl}")` }} />
                          ) : null}
                          {builtinIconId ? (
                            <IconGlyph
                              id={builtinIconId}
                              className={
                                builtinIconId === "music"
                                  ? iconSkinUrl
                                    ? "icon-glyph icon-glyph-music icon-glyph-hidden"
                                    : "icon-glyph icon-glyph-music"
                                  : iconSkinUrl
                                    ? "icon-glyph icon-glyph-hidden"
                                    : "icon-glyph"
                              }
                            />
                          ) : customIconUrl ? null : (
                            <CustomAppGlyph seed={customApp?.name || icon.label} className="icon-glyph" />
                          )}
                        </span>
                        <span className="icon-label">{icon.label}</span>
                      </button>
                    );
                  })}
                </footer>
              ) : null}
              <DebugPromptPanel />
              <QuickActionFloat />
              <MascotFloat />

              {/* Widget Picker Bottom Sheet */}
              {showWidgetPicker && (
                <div className="widget-picker-sheet" onClick={e => e.stopPropagation()}>
                  <div className="wm-header" style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="ts-16 font-medium text-[var(--c-text-title)] flex items-center gap-2">
                      <LayoutGrid size={18} /> 添加组件
                    </span>
                    <button className="ui-bare-btn text-[var(--c-icon)]" onClick={() => setShowWidgetPicker(false)}>✕</button>
                  </div>

                  <div className="px-4 py-3 flex gap-2 w-full">
                    {[
                      { id: "standard", label: "全局套件" },
                      { id: "freestyle", label: "自由艺术" },
                    ].map(tab => (
                      <button
                        key={tab.id}
                        onClick={() => setWidgetPickerTab(tab.id as "standard" | "freestyle")}
                        className={`flex-1 flex justify-center py-1.5 rounded-full text-[calc(13px*var(--app-text-scale,1))] font-medium transition-colors ${widgetPickerTab === tab.id ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="wm-catalog-list" style={{ overflow: "auto", maxHeight: "calc(65vh - 120px)", paddingTop: 10 }}>
                    {widgetPickerTab === "standard" && mergedCatalog.filter(e => e.track !== "freestyle").map(entry => {
                      const sizeClass = `wm-cat-size-${entry.size}`;
                      const dummyWidget: WidgetInstance = { id: `pick-${entry.type}`, type: entry.type, size: entry.size, page: 1, row: 1, col: 1 };
                      return (
                        <div
                          key={entry.type}
                          className={`wm-cat-item ${sizeClass}`}
                          role="button"
                          onClick={() => {
                            const page = currentPage;
                            const pageKey = currentPageKey;
                            const currentWidgets = widgetsRef.current;
                            const grid = buildOccupancyGrid(layoutRef.current[pageKey] ?? [], currentWidgets, page);
                            let placed = false;
                            for (let r = 1; r <= GRID_ROWS && !placed; r++) {
                              for (let c = 1; c <= GRID_COLS && !placed; c++) {
                                if (canPlaceWidget(grid, entry.size, r, c)) {
                                  const next = placeWidget(currentWidgets, { type: entry.type, size: entry.size, page, row: r, col: c });
                                  handleWidgetsChange(next);
                                  placed = true;
                                }
                              }
                            }
                            if (!placed) setNotice("当前页面没有足够空间");
                            setShowWidgetPicker(false);
                          }}
                        >
                          <WidgetRenderer widget={dummyWidget} preview />
                          <span className="wm-cat-name">{entry.name}</span>
                        </div>
                      );
                    })}
                    
                    {widgetPickerTab === "freestyle" && mergedCatalog.filter(e => e.track === "freestyle").map(entry => {
                      const sizeClass = `wm-cat-size-${entry.size}`;
                      const dummyWidget: WidgetInstance = { id: `pick-${entry.type}`, type: entry.type, size: entry.size, page: 1, row: 1, col: 1 };
                      const isDIY = entry.type.startsWith("diy-");
                      return (
                        <div
                          key={entry.type}
                          className={`wm-cat-item ${sizeClass} relative`}
                          style={{ overflow: "visible" }}
                        >
                          {/* Delete button removed from desktop picker layout per user request */}
                          <div
                            role="button"
                            className="w-full h-full flex flex-col items-center gap-2"
                            onClick={() => {
                            const page = currentPage;
                            const pageKey = currentPageKey;
                            const currentWidgets = widgetsRef.current;
                            const grid = buildOccupancyGrid(layoutRef.current[pageKey] ?? [], currentWidgets, page);
                            let placed = false;
                            for (let r = 1; r <= GRID_ROWS && !placed; r++) {
                              for (let c = 1; c <= GRID_COLS && !placed; c++) {
                                if (canPlaceWidget(grid, entry.size, r, c)) {
                                  const next = placeWidget(currentWidgets, { type: entry.type, size: entry.size, page, row: r, col: c });
                                  handleWidgetsChange(next);
                                  placed = true;
                                }
                              }
                            }
                            if (!placed) setNotice("当前页面没有足够空间");
                            setShowWidgetPicker(false);
                          }}
                        >
                          <WidgetRenderer widget={dummyWidget} preview />
                          <span className="wm-cat-name" style={{ color: "var(--c-home-pink)" }}>{entry.name}</span>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}
              {showDesktopCustomizer && (
                <DesktopCustomizer
                  draft={draftTheme}
                  onDraftChange={setDraftTheme}
                  onApply={applyTheme}
                  onClose={() => setShowDesktopCustomizer(false)}
                />
              )}

              {/* Drag ghost — absolutely positioned INSIDE .phone-shell so the
                  clone keeps theme variables + glass effect selectors
                  (.phone-shell[data-icon-effect] etc.); follows pointer via ref */}
              <div ref={ghostRef} className="drag-ghost" />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
