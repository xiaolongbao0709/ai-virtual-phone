import type { CustomAppIconId } from "@/lib/custom-app-types";

export type IconId =
  | "chat"
  | "diary"
  | "music"
  | "reading"
  | "story"
  | "game"
  | "xiaohongshu"
  | "dwelling"
  | "checkphone"
  | "shopping"
  | "calendar"
  | "interview_magazine"
  | "moments"
  | "group_chat"
  | "settings"
  | "theme"
  | "resources"
  | "characters"
  | "realitybridge"
  | "qa"
  | "mixology";

// 桌面文件夹：以 folder: 前缀的 id 伪装成图标占一个格子参与拖拽/换页，
// 内容（名字 + 成员图标）另存 DesktopFolderMap。文件夹不允许进 dock。
export type FolderIconId = `folder:${string}`;

export function isFolderIconId(id: string): id is FolderIconId {
  return id.startsWith("folder:");
}

export function createFolderIconId(): FolderIconId {
  return `folder:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export type DesktopIconId = IconId | CustomAppIconId | FolderIconId;

export type IconPosition = { id: DesktopIconId; row: number; col: number };

export type IconMeta = {
  id: IconId;
  label: string;
  tone: string;
  placeholder: boolean;
  path?: string;
};

export const PAGE_1_DEFAULT: IconId[] = ["chat", "diary", "music", "calendar", "checkphone", "shopping", "reading", "interview_magazine"];

export const PAGE_2_DEFAULT: IconId[] = [
  "game",
  "xiaohongshu",
  "dwelling",
  "story"
];

// 第三页默认图标：右半边 2×2 排布（左半边留给日历组件），位置见 createDefaultDesktopIconLayout
export const PAGE_3_DEFAULT: IconId[] = ["qa", "realitybridge", "mixology"];

export const DOCK_DEFAULT: IconId[] = ["settings", "theme", "resources", "characters"];

export const ICONS: Record<IconId, IconMeta> = {
  chat: { id: "chat", label: "\u804a\u5929", tone: "var(--c-icon-green)", placeholder: false },
  diary: { id: "diary", label: "手记", tone: "var(--c-icon-violet)", placeholder: false },
  music: { id: "music", label: "\u97F3\u4E50", tone: "var(--c-icon-coral)", placeholder: false },
  reading: { id: "reading", label: "\u9605\u8BFB", tone: "var(--c-icon-amber)", placeholder: false },
  story: { id: "story", label: "\u5267\u60C5", tone: "var(--c-icon-story, #8b6f52)", placeholder: false },
  game: { id: "game", label: "游戏", tone: "var(--c-icon-blue)", placeholder: false },
  xiaohongshu: {
    id: "xiaohongshu",
    label: "\u5C0F\u7EA2\u4E66",
    tone: "var(--c-icon-rose)",
    placeholder: false
  },
  checkphone: { id: "checkphone", label: "查手机", tone: "var(--c-icon-slate)", placeholder: false },
  dwelling: {
    id: "dwelling",
    label: "栖所",
    tone: "var(--c-icon-rose)",
    placeholder: false
  },
  shopping: { id: "shopping", label: "\u8D2D\u7269", tone: "var(--c-icon-amber)", placeholder: false },
  calendar: { id: "calendar", label: "\u65E5\u5386", tone: "var(--c-icon-rose)", placeholder: true },
  interview_magazine: { id: "interview_magazine", label: "在场", tone: "var(--c-icon-lilac)", placeholder: false },
  moments: { id: "moments", label: "\u670B\u53CB\u5708", tone: "var(--c-icon-lilac)", placeholder: false },
  group_chat: { id: "group_chat", label: "\u7FA4\u804A", tone: "var(--c-icon-teal)", placeholder: false },
  realitybridge: { id: "realitybridge", label: "iOS现实桥", tone: "var(--c-icon-teal)", placeholder: false },
  settings: { id: "settings", label: "设置", tone: "var(--c-icon-slate)", placeholder: false },
  theme: { id: "theme", label: "\u4E3B\u9898", tone: "var(--c-icon-violet)", placeholder: true },
  resources: { id: "resources", label: "\u8D44\u6E90\u5E93", tone: "var(--c-icon-teal)", placeholder: false },
  characters: {
    id: "characters",
    label: "\u89D2\u8272",
    tone: "var(--c-icon-lilac)",
    placeholder: false,
    path: "/characters"
  },
  qa: { id: "qa", label: "工坊", tone: "var(--c-icon-qa, #4a505c99)", placeholder: false },
  mixology: { id: "mixology", label: "独家特调", tone: "var(--c-icon-violet)", placeholder: false },
};
