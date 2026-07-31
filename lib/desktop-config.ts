import type { CustomAppIconId } from "@/lib/custom-app-types";

export type IconId =
  | "chat"
  | "diary"
  | "music"
  | "reading"
  | "cocreate"
  | "story"
  | "game"
  | "appmarket"
  | "xiaohongshu"
  | "dwelling"
  | "checkphone"
  | "shopping"
  | "calendar"
  | "interview_magazine"
  | "vnmode"
  | "mapmode"
  | "vnplay"
  | "vnchapters"
  | "moments"
  | "group_chat"
  | "settings"
  | "theme"
  | "resources"
  | "characters"
  | "worldbuilder";

export type DesktopIconId = IconId | CustomAppIconId;

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
  "cocreate",
  "game",
  "appmarket",
  "xiaohongshu",
  "dwelling",
  "story",
  "vnmode",
  "mapmode"
];

// 第三页默认图标（居中放置，位置见 createDefaultDesktopIconLayout）
export const PAGE_3_DEFAULT: IconId[] = ["worldbuilder"];

export const DOCK_DEFAULT: IconId[] = ["settings", "theme", "resources", "characters"];

export const ICONS: Record<IconId, IconMeta> = {
  chat: { id: "chat", label: "\u804a\u5929", tone: "var(--c-icon-green)", placeholder: false },
  diary: { id: "diary", label: "手记", tone: "var(--c-icon-violet)", placeholder: false },
  music: { id: "music", label: "\u97F3\u4E50", tone: "var(--c-icon-coral)", placeholder: false },
  reading: { id: "reading", label: "\u9605\u8BFB", tone: "var(--c-icon-amber)", placeholder: false },
  cocreate: { id: "cocreate", label: "共创", tone: "var(--c-icon-cocreate, #c8b58a)", placeholder: false },
  story: { id: "story", label: "\u5267\u60C5", tone: "var(--c-icon-story, #8b6f52)", placeholder: false },
  game: { id: "game", label: "游戏", tone: "var(--c-icon-blue)", placeholder: false },
  appmarket: { id: "appmarket", label: "应用市场", tone: "var(--c-icon-teal)", placeholder: false },
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
  vnmode: { id: "vnmode", label: "漫卷", tone: "var(--c-icon-rose)", placeholder: false },
  mapmode: { id: "mapmode", label: "冒险", tone: "var(--c-icon-amber)", placeholder: false },
  vnplay: { id: "vnplay", label: "漫卷播放", tone: "var(--c-icon-rose)", placeholder: true },
  vnchapters: { id: "vnchapters", label: "章节", tone: "var(--c-icon-rose)", placeholder: true },
  moments: { id: "moments", label: "\u670B\u53CB\u5708", tone: "var(--c-icon-lilac)", placeholder: false },
  group_chat: { id: "group_chat", label: "\u7FA4\u804A", tone: "var(--c-icon-teal)", placeholder: false },
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
  worldbuilder: {
    id: "worldbuilder",
    label: "筑境",
    tone: "var(--c-icon-amber)",
    placeholder: false,
    path: "/world-builder"
  },
};
