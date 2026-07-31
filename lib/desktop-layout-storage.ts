import { DOCK_DEFAULT, ICONS, PAGE_1_DEFAULT, PAGE_2_DEFAULT, PAGE_3_DEFAULT, type DesktopIconId, type IconId, type IconPosition } from "@/lib/desktop-config";
import { isCustomAppIconId } from "@/lib/custom-app-types";
import { loadInstalledCustomApps } from "@/lib/custom-app-storage";
import { GRID_COLS, GRID_ROWS, WIDGET_SIZE_CELLS, type WidgetInstance } from "@/lib/widget-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const ICON_LAYOUT_STORAGE_KEY = "ai_phone_icon_layout_v2";
export const ICON_LAYOUT_STORAGE_KEY_V1 = "ai_phone_icon_layout_v1";
export const DOCK_LAYOUT_STORAGE_KEY = "ai_phone_dock_layout_v1";

/** Max icons the dock can hold. Dragging a page icon in is rejected once full. */
export const DOCK_MAX = 4;

registerKvMigration(ICON_LAYOUT_STORAGE_KEY);
registerKvMigration(ICON_LAYOUT_STORAGE_KEY_V1);
registerKvMigration(DOCK_LAYOUT_STORAGE_KEY);

export type DesktopPageKey = `page${number}`;

export type DesktopIconLayout = Record<DesktopPageKey, IconPosition[]> & {
  page1: IconPosition[];
  page2: IconPosition[];
};

export function getDesktopPageKey(pageNumber: number): DesktopPageKey {
  const safePage = Math.max(1, Math.floor(pageNumber));
  return `page${safePage}` as DesktopPageKey;
}

export function getDesktopPageNumber(pageKey: string): number {
  const match = pageKey.match(/^page([1-9]\d*)$/);
  return match ? Number(match[1]) : 0;
}

export function getDesktopPageKeys(layout: Partial<Record<string, unknown>>): DesktopPageKey[] {
  const maxPage = Math.max(
    2,
    ...Object.keys(layout)
      .map(getDesktopPageNumber)
      .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1)
  );
  return Array.from({ length: maxPage }, (_, index) => getDesktopPageKey(index + 1));
}

export function getDesktopIconLayoutItems(layout: DesktopIconLayout): IconPosition[] {
  return getDesktopPageKeys(layout).flatMap((pageKey) => layout[pageKey] ?? []);
}

function getInstalledCustomIconIds(): Set<string> {
  return new Set(loadInstalledCustomApps().map(app => `custom_app:${app.id}`));
}

function migrateLegacyDesktopIconId(id: string, customIconIds = getInstalledCustomIconIds()): DesktopIconId | null {
  if (id === "forum") return "cocreate";
  if (id === "fortune") return "interview_magazine";
  if (isCustomAppIconId(id) && customIconIds.has(id)) return id;
  return id in ICONS ? id as IconId : null;
}

function buildWidgetOccupancy(widgets: WidgetInstance[], page: number): boolean[][] {
  const grid: boolean[][] = Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => false)
  );

  for (const widget of widgets) {
    if (widget.page !== page) continue;
    const [rows, cols] = WIDGET_SIZE_CELLS[widget.size];
    for (let rowOffset = 0; rowOffset < rows; rowOffset++) {
      for (let colOffset = 0; colOffset < cols; colOffset++) {
        const row = widget.row - 1 + rowOffset;
        const col = widget.col - 1 + colOffset;
        if (row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS) {
          grid[row][col] = true;
        }
      }
    }
  }

  return grid;
}

function flowIconsToPositions(icons: DesktopIconId[], occupied?: boolean[][]): IconPosition[] {
  const result: IconPosition[] = [];
  let index = 0;
  for (let row = 0; row < GRID_ROWS && index < icons.length; row++) {
    for (let col = 0; col < GRID_COLS && index < icons.length; col++) {
      if (occupied?.[row]?.[col]) {
        continue;
      }
      result.push({ id: icons[index], row: row + 1, col: col + 1 });
      index++;
    }
  }
  return result;
}

export function createDefaultDesktopIconLayout(_widgets: WidgetInstance[] = []): DesktopIconLayout {
  return {
    page1: PAGE_1_DEFAULT.map((id, i) => ({
      id,
      row: 5 + Math.floor(i / GRID_COLS),
      col: (i % GRID_COLS) + 1,
    })),
    page2: PAGE_2_DEFAULT.map((id, i) => ({
      id,
      row: 4 + Math.floor(i / GRID_COLS),
      col: (i % GRID_COLS) + 1,
    })),
    // 第三页：水平居中排在中间那行（第 3 行）。单个图标居中于 col2，两个则 col2、col3。
    page3: PAGE_3_DEFAULT.map((id, i) => ({
      id,
      row: 3,
      col: Math.floor((GRID_COLS - PAGE_3_DEFAULT.length) / 2) + 1 + i,
    })),
  } as DesktopIconLayout;
}

function normalizePage(raw: unknown): IconPosition[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const knownIcons = new Set<string>(Object.keys(ICONS));
  const customIconIds = getInstalledCustomIconIds();
  const seenIds = new Set<DesktopIconId>();
  const seenCells = new Set<string>();
  const result: IconPosition[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const { id, row, col } = item as { id?: unknown; row?: unknown; col?: unknown };
    if (typeof id !== "string" || typeof row !== "number" || typeof col !== "number") {
      continue;
    }
    const migratedId = migrateLegacyDesktopIconId(id, customIconIds);
    if (
      !migratedId
      || (!knownIcons.has(migratedId) && !customIconIds.has(migratedId))
      || row < 1
      || row > GRID_ROWS
      || col < 1
      || col > GRID_COLS
    ) {
      continue;
    }

    const iconId = migratedId;
    const cellKey = `${row},${col}`;
    if (seenIds.has(iconId) || seenCells.has(cellKey)) {
      continue;
    }

    seenIds.add(iconId);
    seenCells.add(cellKey);
    result.push({ id: iconId, row, col });
  }

  return result;
}

export function normalizeDesktopIconLayout(raw: unknown): DesktopIconLayout {
  if (!raw || typeof raw !== "object") {
    return createDefaultDesktopIconLayout();
  }

  const candidate = raw as Record<string, unknown>;
  const normalized = {} as DesktopIconLayout;
  for (const pageKey of getDesktopPageKeys(candidate)) {
    normalized[pageKey] = normalizePage(candidate[pageKey]);
  }
  return normalized;
}

export function writeDesktopIconLayout(layout: DesktopIconLayout): DesktopIconLayout {
  const normalized = normalizeDesktopIconLayout(layout);
  kvSet(ICON_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

/**
 * 把已安装但没出现在布局或 dock 里的自定义 app 图标补回桌面空位。
 * 恢复默认外观、导入主题包时图标布局会被整体覆盖，若不补回，
 * 已安装的自定义 app 会从桌面上消失（app 本体仍在，只是没有图标可点）。
 */
export function appendMissingCustomAppIcons(
  layout: DesktopIconLayout,
  widgets: WidgetInstance[] = [],
  dock: DesktopIconId[] = []
): DesktopIconLayout {
  const present = new Set<string>(dock);
  for (const icon of getDesktopIconLayoutItems(layout)) {
    present.add(icon.id);
  }
  const missing = Array.from(getInstalledCustomIconIds()).filter((id) => !present.has(id)) as DesktopIconId[];
  if (missing.length === 0) {
    return layout;
  }

  const next = { ...layout } as DesktopIconLayout;
  let index = 0;
  // 页面满（含组件占位）就顺延到下一页；上限只是防御性兜底，不会实际触达。
  for (let page = 1; index < missing.length && page <= 50; page++) {
    const pageKey = getDesktopPageKey(page);
    const icons = next[pageKey] ?? [];
    const occupied = buildWidgetOccupancy(widgets, page);
    for (const icon of icons) {
      if (icon.row >= 1 && icon.row <= GRID_ROWS && icon.col >= 1 && icon.col <= GRID_COLS) {
        occupied[icon.row - 1][icon.col - 1] = true;
      }
    }
    const placed: IconPosition[] = [];
    for (let row = 0; row < GRID_ROWS && index < missing.length; row++) {
      for (let col = 0; col < GRID_COLS && index < missing.length; col++) {
        if (occupied[row][col]) {
          continue;
        }
        placed.push({ id: missing[index], row: row + 1, col: col + 1 });
        index++;
      }
    }
    if (placed.length > 0) {
      next[pageKey] = [...icons, ...placed];
    }
  }
  return next;
}

// ── Dock layout ───────────────────────────────────────
// The dock is an ordered list of icon ids (max DOCK_MAX). It is stored
// separately from the paged icon layout, and the two are kept disjoint:
// an icon lives either on a page or in the dock, never both.

/** Keep only known/installed icons, dedup, cap at DOCK_MAX. */
export function normalizeDock(raw: unknown): DesktopIconId[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const knownIcons = new Set<string>(Object.keys(ICONS));
  const customIconIds = getInstalledCustomIconIds();
  const seen = new Set<DesktopIconId>();
  const result: DesktopIconId[] = [];

  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const migratedId = migrateLegacyDesktopIconId(item, customIconIds);
    if (
      !migratedId
      || (!knownIcons.has(migratedId) && !customIconIds.has(migratedId))
      || seen.has(migratedId)
    ) {
      continue;
    }
    seen.add(migratedId);
    result.push(migratedId);
    if (result.length >= DOCK_MAX) {
      break;
    }
  }

  return result;
}

/** Read the persisted dock, seeding DOCK_DEFAULT when nothing was ever stored. */
export function loadDockLayout(): DesktopIconId[] {
  const raw = kvGet(DOCK_LAYOUT_STORAGE_KEY);
  if (raw == null) {
    return normalizeDock(DOCK_DEFAULT);
  }
  try {
    return normalizeDock(JSON.parse(raw));
  } catch {
    return normalizeDock(DOCK_DEFAULT);
  }
}

export function writeDockLayout(dock: DesktopIconId[]): DesktopIconId[] {
  const normalized = normalizeDock(dock);
  kvSet(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}
