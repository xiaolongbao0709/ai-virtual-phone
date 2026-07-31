"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AtSign,
  BookOpenText,
  Camera,
  Compass,
  Film,
  Gamepad2,
  Images,
  Landmark,
  Mail,
  MessageCircleMore,
  MessagesSquare,
  Music4,
  NotebookPen,
  PhoneCall,
  Play,
  Radar,
  RefreshCw,
  Send,
  ShoppingBag,
  Sparkles,
  TvMinimalPlay,
  X,
  BatteryMedium,
  Wifi,
  Signal,
  ChevronLeft,
  Trash2,
  Shuffle,
  SkipBack,
  SkipForward,
  Pause,
  Heart,
  ChevronRight,
  Languages,
  History
} from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { ConfirmDialog, Toggle } from "@/components/ui";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { CheckPhoneAssetsPage } from "@/components/checkphone/checkphone-assets-page";
import { CheckPhoneBilibiliPage } from "@/components/checkphone/checkphone-bilibili-page";
import { CheckPhoneBrowserPage } from "@/components/checkphone/checkphone-browser-page";
import { CheckPhoneChatPage } from "@/components/checkphone/checkphone-chat-page";
import { CheckPhoneDoubanPage } from "@/components/checkphone/checkphone-douban-page";
import { CheckPhoneDouyinPage } from "@/components/checkphone/checkphone-douyin-page";
import { CheckPhoneEmailPage } from "@/components/checkphone/checkphone-email-page";
import { CheckPhoneInstagramPage } from "@/components/checkphone/checkphone-instagram-page";
import { CheckPhoneMessagesPage } from "@/components/checkphone/checkphone-messages-page";
import { CheckPhoneMusicPage } from "@/components/checkphone/checkphone-music-page";
import { CheckPhoneNotesPage } from "@/components/checkphone/checkphone-notes-page";
import { CheckPhonePhonePage } from "@/components/checkphone/checkphone-phone-page";
import { CheckPhonePhotosPage } from "@/components/checkphone/checkphone-photos-page";
import { CheckPhoneReadingPage } from "@/components/checkphone/checkphone-reading-page";
import { CheckPhoneRedditPage } from "@/components/checkphone/checkphone-reddit-page";
import { CheckPhoneShoppingPage } from "@/components/checkphone/checkphone-shopping-page";
import { CheckPhoneSteamPage } from "@/components/checkphone/checkphone-steam-page";
import { CheckPhoneTelegramPage } from "@/components/checkphone/checkphone-telegram-page";
import { CheckPhoneTakeoutPage } from "@/components/checkphone/checkphone-takeout-page";
import { CheckPhoneWeiboPage } from "@/components/checkphone/checkphone-weibo-page";
import { CheckPhoneXiaohongshuPage } from "@/components/checkphone/checkphone-xiaohongshu-page";
import { CheckPhoneXPage } from "@/components/checkphone/checkphone-x-page";
import { CheckPhoneYoutubePage } from "@/components/checkphone/checkphone-youtube-page";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
  CHECKPHONE_APP_SPECS,
  isCheckPhoneAppId,
  type CheckPhoneAppId,
  type CheckPhoneManifest,
} from "@/lib/checkphone-config";
import { generateCheckPhoneManifest } from "@/lib/checkphone-engine";
import {
  clearPhoneManifest,
  loadPhoneManifest,
  savePhoneManifest,
  hydrateCheckPhoneStorage,
  readPhoneManifestCache,
  loadCheckPhoneProjectionEntries,
  removeCheckPhoneProjectionEntry,
  clearCheckPhoneProjectionEntries,
  type CheckPhoneProjectionEntry,
} from "@/lib/checkphone-storage";
import {
  loadCheckPhoneSettings,
  saveCheckPhoneSettings,
  type CheckPhoneSettings,
} from "@/lib/checkphone-settings";
import { DEFAULT_CHECKPHONE_BILINGUAL_PROMPT } from "@/lib/bilingual-prompt-defaults";

type CheckPhoneAppProps = {
  onClose: () => void;
};

type ManifestState = {
  manifest: CheckPhoneManifest | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  debugRawOutput: string | null;
};

const CHECKPHONE_EMBEDDED_APP_IDS = [
  "chat",
  "phone",
  "notes",
  "shopping",
  "assets",
  "photos",
  "browser",
  "messages",
  "music",
  "reading",
  "weibo",
  "xiaohongshu",
  "email",
  "douyin",
  "takeout",
  "telegram",
  "steam",
  "x",
  "reddit",
  "youtube",
  "instagram",
  "bilibili",
  "douban",
] as const satisfies CheckPhoneAppId[];

function sanitizeCheckPhoneAppIds(value: unknown): CheckPhoneAppId[] {
  if (!Array.isArray(value)) return [];
  return value.filter((appId): appId is CheckPhoneAppId => typeof appId === "string" && isCheckPhoneAppId(appId));
}

const IconSolidChat = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2.25c-5.385 0-9.75 3.825-9.75 8.543 0 2.65 1.488 4.966 3.75 6.444-.34 1.838-1.532 3.596-1.564 3.642a.75.75 0 001.037.98c2.404-1.272 3.882-2.502 4.67-3.21a10.96 10.96 0 001.857.144c5.385 0 9.75-3.825 9.75-8.543S17.385 2.25 12 2.25z" />
  </svg>
);
const IconSolidShop = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M7.5 6v.75H5.513c-.96 0-1.764.724-1.865 1.679l-1.263 12A1.875 1.875 0 004.25 22.5h15.5a1.875 1.875 0 001.865-2.071l-1.263-12a1.875 1.875 0 00-1.865-1.679H16.5V6a4.5 4.5 0 10-9 0zM12 3a3 3 0 00-3 3v.75h6V6a3 3 0 00-3-3zm-3 8.25a3 3 0 106 0v-.75a.75.75 0 011.5 0v.75a4.5 4.5 0 11-9 0v-.75a.75.75 0 011.5 0v.75z" clipRule="evenodd" />
  </svg>
);
const IconSolidBank = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2.05l-8.5 4v1.5h17v-1.5l-8.5-4zM4.5 9v9H6V9H4.5zm4 0v9h1.5V9H8.5zm4 0v9H14V9h-1.5zm4 0v9.5h1.5V9h-1.5zM3 19.5v2h18v-2H3z" />
  </svg>
);
const IconSolidNotes = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M4.5 3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25h15a2.25 2.25 0 002.25-2.25v-12a2.25 2.25 0 00-2.25-2.25h-15zM7.5 9h9v1.5h-9V9zm0 3.5h9V14h-9v-1.5z" clipRule="evenodd" />
  </svg>
);
const IconSolidPhone = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20 15.5c-1.25 0-2.45-.2-3.57-.57a1.02 1.02 0 00-1.02.24l-2.2 2.2a15.045 15.045 0 01-6.59-6.59l2.2-2.21a.96.96 0 00.25-1A11.36 11.36 0 018.5 4c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.5c0-.55-.45-1-1-1z" />
  </svg>
);
const IconSolidPhotos = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M3 6.75A3.75 3.75 0 016.75 3h10.5A3.75 3.75 0 0121 6.75v10.5A3.75 3.75 0 0117.25 21H6.75A3.75 3.75 0 013 17.25V6.75zM17.25 18a2.25 2.25 0 002.25-2.25V12.6l-2.48-2.48a1.5 1.5 0 00-2.12 0L9.12 15.9l-1.4-1.4a1.5 1.5 0 00-2.12 0L4.5 15.6v1.65A2.25 2.25 0 006.75 18h10.5z" />
  </svg>
);
const IconSolidBrowser = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2A10 10 0 1022 12 10 10 0 0012 2zm2.14 12.82l-5.6 1.83a.47.47 0 01-.6-.6l1.83-5.6a1 1 0 01.5-.5l5.6-1.83a.47.47 0 01.6.6l-1.83 5.6a1 1 0 01-.5.5zM12 10.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />
  </svg>
);
const IconSolidMessages = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M5.337 21.718a6.707 6.707 0 0 1-.533-.074.75.75 0 0 1-.44-1.223 3.73 3.73 0 0 0 .814-1.686c.023-.115-.022-.317-.254-.543C3.274 16.587 2.25 14.41 2.25 12c0-5.03 4.428-9 9.75-9s9.75 3.97 9.75 9c0 5.03-4.428 9-9.75 9-.833 0-1.643-.097-2.417-.279a6.721 6.721 0 0 1-4.246.997ZM7.5 12a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM11 12a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0ZM14.5 12a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z" clipRule="evenodd" />
  </svg>
);

const IconSolidEmail = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M1.5 8.67v8.58a3 3 0 003 3h15a3 3 0 003-3V8.67l-8.928 5.493a3 3 0 01-3.144 0L1.5 8.67z" />
    <path d="M22.5 6.908V6.75a3 3 0 00-3-3h-15a3 3 0 00-3 3v.158l9.714 5.978a1.5 1.5 0 001.572 0L22.5 6.908z" />
  </svg>
);
const IconSolidBook = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M11.25 4.533A9.707 9.707 0 006 3a9.735 9.735 0 00-3.25.555.75.75 0 00-.5.707v14.25a.75.75 0 001 .707A8.237 8.237 0 016 18.75c1.995 0 3.823.707 5.25 1.886V4.533zM12.75 20.636A8.214 8.214 0 0118 18.75c.966 0 1.89.166 2.75.47a.75.75 0 001-.708V4.262a.75.75 0 00-.5-.707A9.735 9.735 0 0018 3a9.707 9.707 0 00-5.25 1.533v16.103z" />
  </svg>
);
const IconSolidMusic = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M19.364 3.208a.75.75 0 00-.916-.145l-9 4.09A.75.75 0 009 7.844v8.283a3.5 3.5 0 101.5 2.873v-7.14l7.5-3.41v5.127a3.5 3.5 0 101.5 2.873V3.75a.75.75 0 00-.136-.542z" clipRule="evenodd" />
  </svg>
);
const IconSolidYoutube = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm14.024-.983a1.125 1.125 0 010 1.966l-5.603 3.113A1.125 1.125 0 019 15.113V8.887c0-.857.921-1.4 1.671-.983l5.603 3.113z" clipRule="evenodd" />
  </svg>
);
const IconSolidTv = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M2.25 5.25a3 3 0 013-3h13.5a3 3 0 013 3V15a3 3 0 01-3 3h-3v.257c0 .597.237 1.17.659 1.591l.621.622a.75.75 0 01-.53 1.28h-9a.75.75 0 01-.53-1.28l.621-.622a2.25 2.25 0 00.659-1.59V18h-3a3 3 0 01-3-3V5.25zm1.5 0v7.5a1.5 1.5 0 001.5 1.5h13.5a1.5 1.5 0 001.5-1.5v-7.5a1.5 1.5 0 00-1.5-1.5H5.25a1.5 1.5 0 00-1.5 1.5z" clipRule="evenodd" />
  </svg>
);
const IconSolidCamera = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 9a3.75 3.75 0 100 7.5A3.75 3.75 0 0012 9z" />
    <path fillRule="evenodd" d="M9.344 3.071L9 4.5H5.25v.001c-1.657 0-3 1.343-3 3v9.001c0 1.657 1.343 3 3 3h13.5c1.657 0 3-1.343 3-3V7.502c0-1.657-1.343-3-3-3H15l-.344-1.429A2.25 2.25 0 0012.463 1.5h-.926a2.25 2.25 0 00-2.193 1.571zM12 18a5.25 5.25 0 100-10.5 5.25 5.25 0 000 10.5z" clipRule="evenodd" />
  </svg>
);
const IconSolidSend = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
  </svg>
);
const IconSolidX = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
const IconSolidGlobe = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm-1.5 5.25a.75.75 0 011.5 0v1.954C14.072 9.873 15.688 11.25 17.625 11.25a.75.75 0 010 1.5c-1.937 0-3.553 1.377-5.625 1.796v1.954a.75.75 0 01-1.5 0v-1.954C8.428 14.127 6.812 12.75 4.875 12.75a.75.75 0 010-1.5c1.937 0 3.553-1.377 5.625-1.796V7.5z" clipRule="evenodd" />
  </svg>
);
const IconSolidGame = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm10.75-3.5a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5zm-5 5a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5zm10 0a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5zm-5 5a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5z" clipRule="evenodd" />
  </svg>
);
const IconSolidEye = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
    <path fillRule="evenodd" d="M1.323 11.447C2.811 6.976 7.028 3.75 12.001 3.75c4.97 0 9.185 3.223 10.675 7.69.12.362.12.752 0 1.113-1.487 4.471-5.705 7.697-10.677 7.697-4.97 0-9.186-3.223-10.675-7.69a1.762 1.762 0 010-1.113zM17.25 12a5.25 5.25 0 11-10.5 0 5.25 5.25 0 0110.5 0z" clipRule="evenodd" />
  </svg>
);
const IconSolidHeart = ({ size = 32 }: { size?: number | string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
  </svg>
);

function AppGlyph({ appId, size = 26, strokeWidth = 1.5 }: { appId: CheckPhoneAppId, size?: number | string; strokeWidth?: number }) {
  const common = { size, strokeWidth };
  switch (appId) {
    case "phone": return <IconSolidPhone size={size} />;
    case "messages": return <IconSolidMessages size={size} />;
    case "browser": return <IconSolidBrowser size={size} />;
    case "photos": return <IconSolidPhotos size={size} />;
    case "chat": return <IconSolidChat size={size} />;
    case "shopping": return <IconSolidShop size={size} />;
    case "assets": return <IconSolidBank size={size} />;
    case "notes": return <IconSolidNotes size={size} />;
    case "reading": return <IconSolidBook size={size} />;
    case "xiaohongshu": return <IconSolidHeart size={size} />;
    case "takeout": return <IconSolidShop size={size} />;
    case "weibo": return <IconSolidEye size={size} />;
    case "douyin": return <IconSolidMusic size={size} />;
    case "email": return <IconSolidEmail size={size} />;
    case "music": return <IconSolidMusic size={size} />;
    case "x": return <IconSolidX size={size} />;
    case "reddit": return <IconSolidGlobe size={size} />;
    case "youtube": return <IconSolidYoutube size={size} />;
    case "bilibili": return <IconSolidTv size={size} />;
    case "instagram": return <IconSolidCamera size={size} />;
    case "telegram": return <IconSolidSend size={size} />;
    case "steam": return <IconSolidGame size={size} />;
    case "douban": return <IconSolidBook size={size} />;
    default: return <Sparkles {...common} />;
  }
}

function getAppIconClass(appId: CheckPhoneAppId, isDock = false) {
  const baseClass = isDock ? "cp-app-icon cp-app-icon--dock" : "cp-app-icon";
  // Interspersed distribution to ensure grey icons don't cluster in one column
  const midGreyApps: string[] = ["photos", "weibo", "steam", "telegram", "reddit"];
  const lightGreyApps: string[] = ["messages", "bilibili", "xiaohongshu", "email", "instagram"];
  const whiteApps: string[] = ["browser", "douyin", "reading", "notes", "shopping", "assets", "youtube"];

  if (midGreyApps.includes(appId)) return `${baseClass} cp-app-icon--mid-grey`;
  if (lightGreyApps.includes(appId)) return `${baseClass} cp-app-icon--light-grey`;
  if (whiteApps.includes(appId)) return `${baseClass} cp-app-icon--white`;
  return baseClass;
}

export function CheckPhoneApp({ onClose }: CheckPhoneAppProps) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeCharId, setActiveCharId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, ManifestState>>({});
  const [manifestsCacheMap, setManifestsCacheMap] = useState<Record<string, CheckPhoneManifest>>({});
  
  // Real Date State
  const [currentDate, setCurrentDate] = useState<Date | null>(null);
  useEffect(() => {
    setCurrentDate(new Date());
    const timer = setInterval(() => setCurrentDate(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const calendarData = useMemo(() => {
    if (!currentDate) return null;
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const todayNum = currentDate.getDate();
    
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthName = monthNames[month];
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    const gridCells = [];
    for (let i = 0; i < firstDay; i++) {
      gridCells.push({ key: `empty-start-${i}`, label: "", isActive: false });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      gridCells.push({ key: `day-${i}`, label: i.toString(), isActive: i === todayNum });
    }
    const totalCells = Math.ceil(gridCells.length / 7) * 7;
    const trailingEmpty = totalCells - gridCells.length;
    for (let i = 0; i < trailingEmpty; i++) {
      gridCells.push({ key: `empty-end-${i}`, label: "", isActive: false });
    }
    
    return { monthName, todayNum, gridCells };
  }, [currentDate]);

  // Desktop Swiping State
  const [desktopPage, setDesktopPage] = useState(0);
  const [touchStartX, setTouchStartX] = useState<number>(0);

  const handleTouchStart = (e: React.TouchEvent) => setTouchStartX(e.touches[0].clientX);
  const handleTouchEnd = (e: React.TouchEvent) => {
    const diff = Math.abs(touchStartX - e.changedTouches[0].clientX);
    if (diff > 40) { // sensitivity
      if (touchStartX > e.changedTouches[0].clientX) {
        setDesktopPage(Math.min(1, desktopPage + 1));
      } else {
        setDesktopPage(Math.max(0, desktopPage - 1));
      }
    }
  };
  const [selectedAppId, setSelectedAppId] = useState<CheckPhoneAppId | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyGroups, setHistoryGroups] = useState<{ characterId: string; name: string; entries: CheckPhoneProjectionEntry[] }[]>([]);
  const [confirmClearHistoryCharId, setConfirmClearHistoryCharId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState(DEFAULT_CHECKPHONE_BILINGUAL_PROMPT);
  const [checkPhoneSettings, setCheckPhoneSettings] = useState<CheckPhoneSettings>({
    bilingualTranslationEnabled: true,
    collapseBilingualTranslation: true,
    bilingualTranslationPrompt: DEFAULT_CHECKPHONE_BILINGUAL_PROMPT,
  });
  const settingsPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const all = loadCharacters();
    setCharacters(all);
    setCheckPhoneSettings(loadCheckPhoneSettings());

    (async () => {
      await hydrateCheckPhoneStorage();
      const map: Record<string, CheckPhoneManifest> = {};
      for (const char of all) {
        const m = readPhoneManifestCache(char.id);
        if (m) {
          map[char.id] = m;
        }
      }
      setManifestsCacheMap(map);
    })();
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (settingsPanelRef.current?.contains(target)) return;
      setSettingsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSettingsOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!activeCharId) return;
    const current = states[activeCharId];
    if (current?.loaded) return;
    let cancelled = false;
    (async () => {
      const cached = await loadPhoneManifest(activeCharId);
      if (cancelled) return;
      setStates((prev) => ({
        ...prev,
        [activeCharId]: {
          manifest: cached,
          loading: false,
          loaded: true,
          error: null,
          debugRawOutput: null,
        },
      }));
    })();
    return () => { cancelled = true; };
  }, [activeCharId, states]);

  const activeCharacter = useMemo(
    () => characters.find((item) => item.id === activeCharId) ?? null,
    [characters, activeCharId],
  );
  const activeState = activeCharId ? states[activeCharId] : undefined;
  const manifest = activeState?.manifest ?? null;
  const isEmbeddedAppOpen =
    !!activeCharacter &&
    !!selectedAppId &&
    CHECKPHONE_EMBEDDED_APP_IDS.includes(selectedAppId as (typeof CHECKPHONE_EMBEDDED_APP_IDS)[number]);

  const closeSelectedApp = () => setSelectedAppId(null);

  function updateCheckPhoneSettings(patch: Partial<CheckPhoneSettings>) {
    const next = { ...checkPhoneSettings, ...patch };
    setCheckPhoneSettings(next);
    saveCheckPhoneSettings(next);
  }

  function openCheckPhonePromptEditor() {
    setPromptDraft(checkPhoneSettings.bilingualTranslationPrompt || DEFAULT_CHECKPHONE_BILINGUAL_PROMPT);
    setPromptEditorOpen(true);
    setSettingsOpen(false);
  }

  function saveCheckPhonePromptDraft() {
    updateCheckPhoneSettings({ bilingualTranslationPrompt: promptDraft });
    setPromptEditorOpen(false);
  }

  const activeEmbeddedAppView = useMemo(() => {
    if (!activeCharacter || !selectedAppId) return null;
    switch (selectedAppId) {
      case "chat":
        return <CheckPhoneChatPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "phone":
        return <CheckPhonePhonePage character={activeCharacter} onBack={closeSelectedApp} />;
      case "notes":
        return <CheckPhoneNotesPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "shopping":
        return <CheckPhoneShoppingPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "assets":
        return <CheckPhoneAssetsPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "photos":
        return <CheckPhonePhotosPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "browser":
        return <CheckPhoneBrowserPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "messages":
        return <CheckPhoneMessagesPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "music":
        return <CheckPhoneMusicPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "reading":
        return <CheckPhoneReadingPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "weibo":
        return <CheckPhoneWeiboPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "xiaohongshu":
        return <CheckPhoneXiaohongshuPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "email":
        return <CheckPhoneEmailPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "douyin":
        return <CheckPhoneDouyinPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "takeout":
        return <CheckPhoneTakeoutPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "telegram":
        return <CheckPhoneTelegramPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "steam":
        return <CheckPhoneSteamPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "x":
        return <CheckPhoneXPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "reddit":
        return <CheckPhoneRedditPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "youtube":
        return <CheckPhoneYoutubePage character={activeCharacter} onBack={closeSelectedApp} />;
      case "instagram":
        return <CheckPhoneInstagramPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "bilibili":
        return <CheckPhoneBilibiliPage character={activeCharacter} onBack={closeSelectedApp} />;
      case "douban":
        return <CheckPhoneDoubanPage character={activeCharacter} onBack={closeSelectedApp} />;
      default:
        return null;
    }
  }, [activeCharacter, selectedAppId]);

  async function handleGenerate() {
    if (!activeCharId || activeState?.loading) return;
    setStates((prev) => ({
      ...prev,
      [activeCharId]: {
        manifest: prev[activeCharId]?.manifest ?? null,
        loading: true,
        loaded: true,
        error: null,
        debugRawOutput: null,
      },
    }));

    const {
      manifest: nextManifest,
      error,
      debugRawOutput,
    } = await generateCheckPhoneManifest(activeCharId);
    if (nextManifest) {
      await savePhoneManifest(nextManifest);
      setManifestsCacheMap((prev) => ({ ...prev, [activeCharId]: nextManifest }));
    }

    setStates((prev) => ({
      ...prev,
      [activeCharId]: {
        manifest: nextManifest ?? prev[activeCharId]?.manifest ?? null,
        loading: false,
        loaded: true,
        error: error ?? null,
        debugRawOutput: debugRawOutput ?? null,
      },
    }));
  }

  const handleBack = () => {
    if (activeCharId) {
      setActiveCharId(null);
      setSelectedAppId(null);
    } else {
      onClose();
    }
  };

  async function handleClearManifest() {
    if (!activeCharId || activeState?.loading) return;
    await clearPhoneManifest(activeCharId);
    setManifestsCacheMap((prev) => {
      const next = { ...prev };
      delete next[activeCharId];
      return next;
    });
    setStates((prev) => ({
      ...prev,
      [activeCharId]: {
        manifest: null,
        loading: false,
        loaded: true,
        error: null,
        debugRawOutput: null,
      },
    }));
    setSelectedAppId(null);
    setConfirmClearOpen(false);
  }

  const topApps = sanitizeCheckPhoneAppIds(manifest?.topAppIds);
  const dockApps = sanitizeCheckPhoneAppIds(manifest?.dockAppIds);
  const selectedAppSpec = selectedAppId && isCheckPhoneAppId(selectedAppId) ? CHECKPHONE_APP_SPECS[selectedAppId] : null;

  // STAGE 2: PURE FULLSCREEN IMMERSIVE SIMULATOR
  if (activeCharacter) {
    return (
      <div className="cp-fullscreen-simulator">
        <div className={`cp-fullscreen-inner ${!manifest ? "is-empty" : ""}`}>
          {/* Floating Controls overhauled for real status bar */}
          {!isEmbeddedAppOpen && (
            <div className="cp-floating-controls">
              <div className="cp-floating-settings" ref={settingsPanelRef}>
                <button className="cp-float-back" onClick={handleBack} aria-label="Back to Archive">
                  <ChevronLeft size={22} strokeWidth={2.5} />
                </button>
                <button
                  className={`cp-float-settings ${settingsOpen ? "is-active" : ""}`}
                  onClick={() => setSettingsOpen((open) => !open)}
                  aria-label="CheckPhone settings"
                  aria-expanded={settingsOpen}
                >
                  <Languages size={18} strokeWidth={2.25} />
                </button>
                {settingsOpen && (
                  <div className="cp-desktop-settings-popover" role="dialog" aria-label="CheckPhone settings">
                    <div className="cp-desktop-settings-head">
                      <span>Settings</span>
                      <b>CHECKPHONE</b>
                    </div>
                    <div className="cp-desktop-settings-row">
                      <div>
                        <strong>双语翻译</strong>
                        <span>外语文本自动附中文译文</span>
                      </div>
                      <Toggle
                        checked={checkPhoneSettings.bilingualTranslationEnabled}
                        onChange={(checked) => updateCheckPhoneSettings({ bilingualTranslationEnabled: checked })}
                        disabled={!!activeState?.loading}
                      />
                    </div>
                    <div className="cp-desktop-settings-row">
                      <div>
                        <strong>折叠中文</strong>
                        <span>关闭后默认直接展开中文</span>
                      </div>
                      <Toggle
                        checked={checkPhoneSettings.collapseBilingualTranslation}
                        onChange={(checked) => updateCheckPhoneSettings({ collapseBilingualTranslation: checked })}
                        disabled={!!activeState?.loading}
                      />
                    </div>
                    {checkPhoneSettings.bilingualTranslationEnabled && (
                      <div className="cp-desktop-settings-action">
                        <button
                          type="button"
                          className="ui-btn ui-btn-primary cp-desktop-settings-edit-prompt"
                          onClick={openCheckPhonePromptEditor}
                          disabled={!!activeState?.loading}
                        >
                          编辑双语提示词
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="cp-floating-actions">
                <button className="cp-float-refresh" onClick={handleGenerate} aria-label="Refresh Signal" disabled={!!activeState?.loading}>
                  <RefreshCw size={18} strokeWidth={2.5} className={activeState?.loading ? "cp-spin" : undefined} />
                </button>
                <button
                  className="cp-float-clear"
                  onClick={() => setConfirmClearOpen(true)}
                  aria-label="Clear current desktop"
                  disabled={!!activeState?.loading || !manifest}
                >
                  <Trash2 size={17} strokeWidth={2.25} />
                </button>
              </div>
            </div>
          )}

          {activeState?.error ? (
            <CheckPhoneDebugErrorCard
              error={activeState.error}
              debugRawOutput={activeState.debugRawOutput}
            />
          ) : null}

          {manifest && activeState?.loading && (
            <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
              <span className="cp-refresh-indicator-text">正在刷新桌面</span>
              <span className="cp-refresh-indicator-dots" aria-hidden="true">
                <i></i><i></i><i></i>
              </span>
            </div>
          )}

          {!manifest && !activeState?.loading && !activeState?.error && (
            <div className="cp-screen-empty">
              <div className="cp-empty-circle"></div>
              <p>No Signal.</p>
              <button className="cp-inline-btn" onClick={handleGenerate}>
                Activate Simulator
              </button>
            </div>
          )}

          {activeState?.loading && !manifest && (
            <div className="cp-screen-loading">
              <span className="cp-loading-line"></span>
              <span className="cp-loading-text">BOOTING...</span>
            </div>
          )}

          {manifest && (
             <>
              {activeEmbeddedAppView ? (
                activeEmbeddedAppView
              ) : (
                <div className="cp-desktop-view">
                  <div 
                    className="cp-page-slider" 
                    onTouchStart={handleTouchStart} 
                    onTouchEnd={handleTouchEnd}
                    style={{ transform: `translateX(-${desktopPage * 100}%)` }}
                  >
                    {/* PAGE 1 */}
                    <div className="cp-desktop-page">
                      <div className="cp-app-grid">
                        {/* Huge Music Widget spanning 4 columns */}
                        <div className="cp-widget-wrapper cp-widget-wrapper--span4">
                          <div className="cp-widget cp-w-music">
                            <div className="cp-w-music-info">
                              <h4>Sunflower</h4>
                              <p className="cp-artist">- Post Malone</p>
                              <div className="cp-lyrics">
                                <p>Ooh, ooh, ooh, ohh (ooh)</p>
                                <p>Needless to say, I keep a check</p>
                              </div>
                              <div className="cp-w-music-controls">
                                <Shuffle size={13} strokeWidth={2.5} className="cp-music-icon-dim" />
                                <SkipBack size={16} strokeWidth={2.5} />
                                <Pause size={18} strokeWidth={3} />
                                <SkipForward size={16} strokeWidth={2.5} />
                                <Heart size={13} strokeWidth={2.5} className="cp-music-icon-dim" />
                              </div>
                            </div>
                            <div className="cp-w-music-disc"></div>
                            <div className="cp-w-tone-arm"></div>
                          </div>
                          <span className="cp-widget-label">Widgets</span>
                        </div>
                        
                        {/* Core Vitals Widget - 2x2 */}
                        <div className="cp-widget-wrapper cp-widget-wrapper--span2">
                          <div className="cp-widget cp-w-base cp-w-core">
                            <div className="cp-w-core-top">
                              <span className="cp-w-core-title">Core Vitals</span>
                              <span className="cp-w-core-dot"></span>
                            </div>
                            <div className="cp-w-core-mid">
                              <div className="cp-w-core-ring">
                                <div className="cp-w-core-ring-inner"></div>
                              </div>
                              <div className="cp-w-core-stats">
                                <span>MEM 42%</span>
                                <span>SYS OK</span>
                              </div>
                            </div>
                          </div>
                          <span className="cp-widget-label">System</span>
                        </div>

                        {/* Resonance Widget - 2x2 */}
                        <div className="cp-widget-wrapper cp-widget-wrapper--span2">
                          <div className="cp-widget cp-w-base cp-w-resonance">
                            <div className="cp-w-res-head">
                              <span className="cp-w-res-title">Resonance</span>
                              <span className="cp-w-res-val">98.2%</span>
                            </div>
                            <div className="cp-w-res-graph">
                              <div className="cp-res-bar" style={{height: '30%'}}></div>
                              <div className="cp-res-bar cp-res-active" style={{height: '70%'}}></div>
                              <div className="cp-res-bar" style={{height: '50%'}}></div>
                              <div className="cp-res-bar" style={{height: '90%'}}></div>
                              <div className="cp-res-bar" style={{height: '40%'}}></div>
                            </div>
                            <div className="cp-w-res-footer">Status: Harmonized</div>
                          </div>
                          <span className="cp-widget-label">AI Status</span>
                        </div>

                        {/* Top Apps (slice 0 to 4) */}
                        {topApps.slice(0, 4).map((appId) => {
                          const spec = CHECKPHONE_APP_SPECS[appId];
                          return (
                            <button
                              key={appId}
                              type="button"
                              className="cp-app-btn"
                              onClick={() => setSelectedAppId(appId)}
                            >
                              <div className={getAppIconClass(appId)}><AppGlyph appId={appId} size={32} strokeWidth={1.4} /></div>
                              <span className="cp-app-label">{spec.shortLabel ?? spec.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* PAGE 2 */}
                    <div className="cp-desktop-page">
                      <div className="cp-app-grid">
                        {/* Uplink Widget - 2x2 */}
                        <div className="cp-widget-wrapper cp-widget-wrapper--span2">
                          <div className="cp-widget cp-w-base cp-w-uplink">
                            <div className="cp-w-up-top">
                              <div className="cp-up-icon">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                              </div>
                              <div className="cp-up-speed">
                                <span className="cp-up-num">1.4</span>
                                <span className="cp-up-unit">GB/s UPLINK</span>
                              </div>
                            </div>
                            <div className="cp-w-up-bottom">
                              <div className="cp-up-stat">
                                <span className="cp-up-lbl">LATENCY</span>
                                <span className="cp-up-val">12ms</span>
                              </div>
                              <div className="cp-up-stat" style={{alignItems: 'flex-end'}}>
                                <span className="cp-up-lbl">PACKET</span>
                                <span className="cp-up-val">0.0%</span>
                              </div>
                            </div>
                          </div>
                          <span className="cp-widget-label">Network</span>
                        </div>
                        
                        {/* Top Apps (slice 4 to 8) fill row 1 and 2 to the right of the 2x2 photo widget */}
                        {topApps.slice(4, 8).map((appId, idx) => {
                          const spec = CHECKPHONE_APP_SPECS[appId];
                          // Bottom row apps are indices 2 and 3 here
                          const isBottomRow = idx >= 2;
                          return (
                            <button 
                              key={appId} 
                              type="button" 
                              className="cp-app-btn" 
                              onClick={() => setSelectedAppId(appId)}
                              style={isBottomRow ? { transform: "translateY(-8px)" } : undefined}
                            >
                              <div className={getAppIconClass(appId)}><AppGlyph appId={appId} size={32} strokeWidth={1.4} /></div>
                              <span className="cp-app-label">{spec.shortLabel ?? spec.label}</span>
                            </button>
                          );
                        })}

                        {/* Calendar Widget (Wide 4 columns layout) */}
                        <div className="cp-widget-wrapper cp-widget-wrapper--span4">
                          <div className="cp-widget cp-w-calendar">
                            <div className="cp-cal-left">
                              <div className="cp-cal-month-vert">{calendarData ? calendarData.monthName : "..."}</div>
                              <span className="cp-cal-today-num">{calendarData ? calendarData.todayNum : "..."}</span>
                            </div>
                            <div className="cp-cal-right">
                              <div className="cp-cal-header-row">
                                <span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span>
                              </div>
                              <div className="cp-cal-grid-month">
                                {calendarData ? calendarData.gridCells.map(cell => (
                                  <span key={cell.key} className={cell.isActive ? "cp-cal-active" : undefined}>
                                    {cell.label}
                                  </span>
                                )) : (
                                  Array.from({ length: 35 }).map((_, i) => <span key={i}></span>)
                                )}
                              </div>
                            </div>
                          </div>
                          <span className="cp-widget-label">iScreen</span>
                        </div>

                        {/* Top Apps (slice 8 to 12) -> Game Library, Music, Xiaohongshu, Reading */}
                        {topApps.slice(8, 12).map((appId) => {
                          const spec = CHECKPHONE_APP_SPECS[appId];
                          return (
                            <button key={appId} type="button" className="cp-app-btn" onClick={() => setSelectedAppId(appId)}>
                              <div className={getAppIconClass(appId)}><AppGlyph appId={appId} size={32} strokeWidth={1.4} /></div>
                              <span className="cp-app-label">{spec.shortLabel ?? spec.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="cp-page-dots">
                    <span className={desktopPage === 0 ? "active" : ""} onClick={() => setDesktopPage(0)}></span>
                    <span className={desktopPage === 1 ? "active" : ""} onClick={() => setDesktopPage(1)}></span>
                  </div>

                  <div className="cp-dock-area">
                    <div className="cp-dock-glass">
                      {dockApps.map((appId) => {
                        return (
                          <button
                            key={appId}
                            type="button"
                            className="cp-app-btn cp-app-btn--dock"
                            onClick={() => setSelectedAppId(appId)}
                          >
                            <div className={getAppIconClass(appId, true)}>
                              <AppGlyph appId={appId} />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
             </>
          )}

          {/* Temporary App Modal */}
          {selectedAppId && selectedAppSpec && !activeEmbeddedAppView && (
            <div className="cp-modal-backdrop" onClick={closeSelectedApp}>
              <div className="cp-modal-body" onClick={(e) => e.stopPropagation()}>
                 <div className="cp-modal-icon-container">
                   <AppGlyph appId={selectedAppId} />
                 </div>
                 <h3>{selectedAppSpec.label}</h3>
                 <p>Simulation module offline. UI renders will arrive in later phases.</p>
                 <button className="cp-modal-close" onClick={closeSelectedApp}>DISMISS</button>
              </div>
            </div>
          )}
        </div>
        {confirmClearOpen && (
          <ConfirmDialog
            title="清空当前桌面？"
            message="确认后会清空这位角色已生成的查手机桌面缓存。之后重新刷新时，不会再带入旧桌面内容。"
            variant="danger"
            confirmLabel="确认清空"
            cancelLabel="取消"
            onConfirm={handleClearManifest}
            onCancel={() => setConfirmClearOpen(false)}
          />
        )}
        {promptEditorOpen && (
          <div
            className="cp-prompt-modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="编辑查手机双语提示词"
            onClick={() => setPromptEditorOpen(false)}
          >
            <div className="cp-prompt-modal" onClick={(event) => event.stopPropagation()}>
              <div className="cp-prompt-modal-head">
                <div>
                  <h3>编辑双语提示词</h3>
                  <p>仅影响查手机页面的双语文本生成。</p>
                </div>
                <button
                  type="button"
                  onClick={() => setPromptDraft(DEFAULT_CHECKPHONE_BILINGUAL_PROMPT)}
                  disabled={!!activeState?.loading}
                >
                  恢复默认
                </button>
              </div>
              <textarea
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
                disabled={!!activeState?.loading}
              />
              <div className="cp-prompt-modal-actions">
                <button type="button" onClick={() => setPromptEditorOpen(false)}>
                  取消
                </button>
                <button type="button" onClick={saveCheckPhonePromptDraft} disabled={!!activeState?.loading}>
                  保存
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // STAGE 1: ARCHIVE ROSTER
  const refreshHistoryGroups = () => {
    setHistoryGroups(
      loadCharacters()
        .map(character => ({
          characterId: character.id,
          name: character.name || "未知角色",
          entries: loadCheckPhoneProjectionEntries(character.id),
        }))
        .filter(group => group.entries.length > 0),
    );
  };

  const openHistory = () => {
    refreshHistoryGroups();
    setHistoryOpen(true);
  };

  const handleDeleteHistoryEntry = (characterId: string, entryId: string) => {
    removeCheckPhoneProjectionEntry(characterId, entryId);
    refreshHistoryGroups();
  };

  const handleClearHistoryForChar = () => {
    if (confirmClearHistoryCharId) {
      clearCheckPhoneProjectionEntries(confirmClearHistoryCharId);
    }
    setConfirmClearHistoryCharId(null);
    refreshHistoryGroups();
  };

  const formatHistoryContent = (content: string, characterName: string) =>
    content.replace(/\{\{user\}\}/g, "你").replace(/\{\{char\}\}/g, characterName);

  return (
    <PageShell
      title="Access Control"
      onBack={handleBack}
      className="cp-page-override cp-roster-page"
      rightAction={
        <button
          type="button"
          className="cp-history-btn"
          aria-label="查手机记录"
          onClick={openHistory}
        >
          <History size={18} strokeWidth={1.8} />
        </button>
      }
    >
      <div className="cp-app-wrapper">
        <div className="cp-roster-view">
          {/* Tactical forensic header console */}
          <div className="cp-terminal-header">
            <div className="cp-terminal-title-bar">
              <span>SYSTEM: DECRYPTION NODE ACTIVE</span>
              <span className="cp-terminal-pulse-dot" />
            </div>
            <div className="cp-terminal-subtitle">
              MOBILE EVIDENCE FORENSIC WORKSTATION
            </div>
          </div>

          <div className="cp-roster-grid">
            {characters.length === 0 && (
               <div className="cp-roster-empty">No target records found.</div>
            )}
            {characters.map((character) => {
              const charManifest = manifestsCacheMap[character.id] || null;
              const isDecrypted = !!charManifest;
              const previewApps = charManifest ? sanitizeCheckPhoneAppIds(charManifest.allAppIds).slice(0, 5) : [];

              return (
                <div
                  key={character.id}
                  className="cp-roster-card"
                  onClick={() => setActiveCharId(character.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setActiveCharId(character.id);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="cp-roster-avatar-hud">
                    <div className="cp-roster-avatar">
                       {character.avatar ? (
                         <img src={character.avatar} alt="" />
                       ) : (
                         <div className="cp-roster-fallback-inner"><span /></div>
                       )}
                    </div>
                  </div>

                  <div className="cp-name-badge">
                    {character.name || "Unknown"}
                  </div>

                  {/* Decryption status indicator */}
                  <div className={`cp-status-indicator ${isDecrypted ? 'cp-status-indicator--decrypted' : 'cp-status-indicator--encrypted'}`}>
                    <span className="cp-status-dot" />
                    <span>{isDecrypted ? "DECRYPTED" : "LOCKED"}</span>
                  </div>

                  {/* Metadata fields */}
                  <div className="cp-card-metadata">
                    <div className="cp-card-meta-row">
                      <span>SYS-ID:</span>
                      <span className="cp-card-meta-val">CP-{(character.name && character.name.substring(0, 2)) || character.id.substring(0, 4)}</span>
                    </div>
                    {character.wechatID && (
                      <div className="cp-card-meta-row">
                        <span>W-ID:</span>
                        <span className="cp-card-meta-val">{character.wechatID}</span>
                      </div>
                    )}
                  </div>

                  {/* Apps preview list */}
                  <div className="cp-card-apps-preview">
                    {previewApps.map((appId) => (
                      <div key={appId} className="cp-card-app-icon-mini" title={appId}>
                        <AppGlyph appId={appId} size={10} strokeWidth={2} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Access log: 查手机记录（注入短期记忆的条目，可逐条删除） */}
        {historyOpen && (
          <div
            className="cp-history-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="查手机记录"
            onClick={() => setHistoryOpen(false)}
          >
            <div className="cp-history-modal" onClick={(event) => event.stopPropagation()}>
              <div className="cp-history-head">
                <div>
                  <div className="cp-history-title-bar">
                    <span>ACCESS LOG</span>
                    <span className="cp-terminal-pulse-dot" />
                  </div>
                  <div className="cp-history-subtitle">查手机记录 · 会注入对应角色的短期记忆</div>
                </div>
                <button
                  type="button"
                  className="cp-history-close"
                  aria-label="关闭"
                  onClick={() => setHistoryOpen(false)}
                >
                  <X size={16} strokeWidth={2} />
                </button>
              </div>
              <div className="cp-history-body">
                {historyGroups.length === 0 && (
                  <div className="cp-history-empty">NO ACCESS RECORDS</div>
                )}
                {historyGroups.map((group) => (
                  <div key={group.characterId} className="cp-history-group">
                    <div className="cp-history-group-head">
                      <span className="cp-history-group-name">{group.name}</span>
                      <span className="cp-history-group-count">{group.entries.length} 条</span>
                      <button
                        type="button"
                        className="cp-history-clear-btn"
                        onClick={() => setConfirmClearHistoryCharId(group.characterId)}
                      >
                        清空
                      </button>
                    </div>
                    {[...group.entries].reverse().map((entry) => (
                      <div key={entry.id} className="cp-history-entry">
                        <span className="cp-history-entry-text">
                          {formatHistoryContent(entry.content, group.name)}
                        </span>
                        <button
                          type="button"
                          className="cp-history-entry-delete"
                          aria-label="删除该记录"
                          onClick={() => handleDeleteHistoryEntry(group.characterId, entry.id)}
                        >
                          <Trash2 size={14} strokeWidth={1.8} />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {confirmClearHistoryCharId && (
          <ConfirmDialog
            title="清空该角色的查手机记录？"
            message="清空后这些记录将不再注入该角色的短期记忆，无法恢复。是否继续？"
            variant="danger"
            confirmLabel="清空"
            cancelLabel="取消"
            onConfirm={handleClearHistoryForChar}
            onCancel={() => setConfirmClearHistoryCharId(null)}
          />
        )}
      </div>
    </PageShell>
  );
}
