"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  Clock,
  Copy,
  FileText,
  Folder,
  Gamepad2,
  Heart,
  ImageIcon,
  Library,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Upload,
  Wand2,
  X,
} from "lucide-react";

import { GAME_CREATOR_GUIDE_MD, GAME_EMPTY_PICKER_HTML } from "@/lib/game-creator-guide";
import {
  deleteGameComment,
  deleteGameTemplate,
  fetchGameComments,
  fetchGameHallTemplate,
  fetchGameHallTemplates,
  fetchInstalledGameHallTemplates,
  postGameComment,
  publishGameTemplate,
  setGameFavorite,
  toggleGameLike,
  updateGameTemplate,
  uploadGameHallAsset,
} from "@/lib/game-hall-client";
import { useAccount } from "@/lib/account-context";
import { OnlineRoomConnection, onlineCloudApi } from "@/lib/online-room-client";
import { submitContentReport } from "@/lib/moderation-client";
import { buildGameRolePackage, callGameLLM } from "@/lib/game-engine";
import {
  createDefaultGameDraft,
  deleteGameProjectionEvent,
  deleteInstalledGame,
  getGameCatalog,
  installGameTemplate,
  loadGameDrafts,
  loadGameSave,
  loadGameState,
  markGamePlayed,
  parseGameRoleSlots,
  recordGameProjectionEvent,
  saveGameCollectionFolders,
  saveGameHallProfile,
  saveGameDrafts,
  saveLikedGameIds,
  saveGameRoleAssignments,
  saveGameSave,
  saveGameState,
} from "@/lib/game-storage";
import type {
  GameCollectionFolder,
  GameComment,
  GameHallDraft,
  GameInstalledItem,
  GameProjectionEntry,
  GameRoleAssignment,
  GameRolePackageMode,
  GameRoleSlot,
  GameState,
  GameTemplate,
  GameTemplateDraft,
} from "@/lib/game-types";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { incrementEventCounter } from "@/lib/memory-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";

type GameMainView = "hall" | "library" | "studio";
type GameStudioMode = "published" | "drafts";
type GameNotice = { id: number; tone: "success" | "error" | "info"; text: string };
type RuntimeStage = "permission" | "picker" | "game";
type RuntimeTitleBarMaterial = "clear" | "solid" | "glass";
type RuntimeTitleBarConfig = {
  material: RuntimeTitleBarMaterial;
  background: string;
  color: string;
  borderColor: string;
  buttonBackground: string;
  buttonColor: string;
  buttonBorderColor: string;
  buttonRadius: string;
  buttonShadow: string;
  iconOpacity: number;
};
type GameLibraryCollection = {
  id: string;
  name: string;
  description: string;
  colorA: string;
  colorB: string;
  count: number;
  updatedAt?: string;
  games: GameInstalledItem[];
};
type GameCommentNode = GameComment & { replies: GameCommentNode[] };
type GameCommentDisplayItem = {
  comment: GameComment;
  replyTargetName?: string;
  visualDepth: 0 | 1;
};
type CommentDeleteTarget = { template: GameTemplate; comment: GameComment };

const GAME_PREVIEW_LOCAL_ID_PREFIX = "preview_game_";
const GAME_HALL_COMMENTS_ENABLED = false;
const GAME_DECORATIVE_CODE = "✦";
const GAME_ALLOWED_TAGS = ["推荐", "休闲", "剧情", "解谜", "互动", "经营"];
const GAME_CATEGORY_FILTERS = GAME_ALLOWED_TAGS;
const GAME_COLLECTION_COLORS = [
  ["#a78bfa", "#fb7185"],
  ["#60a5fa", "#c084fc"],
  ["#f9a8d4", "#f97316"],
  ["#34d399", "#60a5fa"],
  ["#facc15", "#fb7185"],
];
const DEFAULT_GAME_COLLECTION_ID = "roles";
const DEFAULT_RUNTIME_TITLE_BAR: RuntimeTitleBarConfig = {
  material: "clear",
  background: "transparent",
  color: "rgba(36, 25, 47, 0.72)",
  borderColor: "transparent",
  buttonBackground: "rgba(255, 255, 255, 0.72)",
  buttonColor: "rgba(36, 25, 47, 0.72)",
  buttonBorderColor: "rgba(24, 17, 31, 0.08)",
  buttonRadius: "999px",
  buttonShadow: "0 8px 22px rgba(25, 18, 32, 0.12)",
  iconOpacity: 1,
};

const GAME_MAIN_TABS: Array<{ id: GameMainView; label: string; icon: typeof Gamepad2 }> = [
  { id: "hall", label: "游戏大厅", icon: Gamepad2 },
  { id: "studio", label: "创作工坊", icon: Wand2 },
  { id: "library", label: "我的", icon: Library },
];

function isSafeRuntimeCssValue(value: unknown, maxLength = 140): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text.length > maxLength) return false;
  if (/[<>{};]/.test(text)) return false;
  if (/url\s*\(/i.test(text)) return false;
  return true;
}

function normalizeRuntimeRadius(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${Math.max(0, Math.min(999, Math.round(value)))}px`;
  }
  if (!isSafeRuntimeCssValue(value, 24)) return fallback;
  if (/^\d{1,3}(\.\d{1,2})?(px|%)$/.test(value.trim()) || value.trim() === "999px") return value.trim();
  return fallback;
}

function normalizeRuntimeOpacity(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeRuntimeTitleBarConfig(value: unknown): RuntimeTitleBarConfig {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const material: RuntimeTitleBarMaterial =
    record.material === "glass" ? "glass" :
    record.material === "solid" ? "solid" :
    "clear";
  return {
    material,
    background: isSafeRuntimeCssValue(record.background) ? record.background.trim() : DEFAULT_RUNTIME_TITLE_BAR.background,
    color: isSafeRuntimeCssValue(record.color) ? record.color.trim() : DEFAULT_RUNTIME_TITLE_BAR.color,
    borderColor: isSafeRuntimeCssValue(record.borderColor) ? record.borderColor.trim() : DEFAULT_RUNTIME_TITLE_BAR.borderColor,
    buttonBackground: isSafeRuntimeCssValue(record.buttonBackground) ? record.buttonBackground.trim() : DEFAULT_RUNTIME_TITLE_BAR.buttonBackground,
    buttonColor: isSafeRuntimeCssValue(record.buttonColor) ? record.buttonColor.trim() : DEFAULT_RUNTIME_TITLE_BAR.buttonColor,
    buttonBorderColor: isSafeRuntimeCssValue(record.buttonBorderColor) ? record.buttonBorderColor.trim() : DEFAULT_RUNTIME_TITLE_BAR.buttonBorderColor,
    buttonRadius: normalizeRuntimeRadius(record.buttonRadius, DEFAULT_RUNTIME_TITLE_BAR.buttonRadius),
    buttonShadow: isSafeRuntimeCssValue(record.buttonShadow) ? record.buttonShadow.trim() : DEFAULT_RUNTIME_TITLE_BAR.buttonShadow,
    iconOpacity: normalizeRuntimeOpacity(record.iconOpacity, DEFAULT_RUNTIME_TITLE_BAR.iconOpacity),
  };
}

function formatGameDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatGameRelativeTime(value: string, now: number | null): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (now === null) return formatGameDate(value);
  const diffMinutes = Math.max(1, Math.round((now - date.getTime()) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  if (diffMinutes < 1440) return `${Math.round(diffMinutes / 60)}小时前`;
  if (diffMinutes < 43200) return `${Math.round(diffMinutes / 1440)}天前`;
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  return date.toLocaleDateString("zh-CN", sameYear
    ? { month: "2-digit", day: "2-digit" }
    : { year: "numeric", month: "2-digit", day: "2-digit" });
}

function sanitizeHtml(value: string): string {
  return value.replace(/\u0000/g, "").trim();
}

function isInlineImage(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp);base64,/i.test(value.trim());
}

function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 2).toUpperCase() : "玩家";
}

function displayGameAuthorName(value: string): string {
  const trimmed = value.replace(/^@+/, "").trim();
  if (!trimmed || trimmed === "本机玩家" || trimmed === "匿名作者" || trimmed === "匿名玩家") {
    return "匿名";
  }
  return trimmed;
}

function buildGameCommentTree(comments: GameComment[]): GameCommentNode[] {
  const nodes = new Map<string, GameCommentNode>();
  for (const comment of comments) {
    nodes.set(comment.id, { ...comment, replies: [] });
  }

  const roots: GameCommentNode[] = [];
  for (const comment of comments) {
    const node = nodes.get(comment.id);
    if (!node) continue;
    const parent = comment.parentId ? nodes.get(comment.parentId) : null;
    if (parent) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortTree = (items: GameCommentNode[]) => {
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    items.forEach(item => sortTree(item.replies));
  };
  sortTree(roots);
  return roots;
}

function flattenGameCommentTree(comments: GameComment[]): GameCommentDisplayItem[] {
  const commentById = new Map(comments.map(comment => [comment.id, comment]));
  const result: GameCommentDisplayItem[] = [];
  const collectDescendants = (node: GameCommentNode): GameCommentNode[] => {
    const descendants: GameCommentNode[] = [];
    const visit = (item: GameCommentNode) => {
      item.replies.forEach(reply => {
        descendants.push(reply);
        visit(reply);
      });
    };
    visit(node);
    return descendants.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  buildGameCommentTree(comments).forEach(comment => {
    result.push({ comment, visualDepth: 0 });
    collectDescendants(comment).forEach(reply => {
      const parent = reply.parentId ? commentById.get(reply.parentId) : undefined;
      result.push({
        comment: reply,
        replyTargetName: parent?.authorName,
        visualDepth: 1,
      });
    });
  });
  return result;
}

function gameSearchText(template: GameTemplate): string {
  return [
    template.title,
    template.playNote,
    template.synopsis,
    displayGameAuthorName(template.authorName),
    template.tags.join(" "),
  ].join(" ").toLowerCase();
}

function gameDisplayDescription(template: GameTemplate): string {
  return template.playNote || template.synopsis;
}

function gameDisplayTags(template: GameTemplate): string[] {
  const allowed = parseAllowedGameTags(template.tags.join(" "));
  return allowed.length > 0 ? allowed : ["互动"];
}

function gameMatchesCategory(template: GameTemplate, category: string): boolean {
  if (category === "推荐") return true;
  return gameDisplayTags(template).includes(category);
}

function parseAllowedGameTags(value: string): string[] {
  const requested = new Set(value.split(/[,\s，、#]+/).map(tag => tag.trim()).filter(Boolean));
  return GAME_ALLOWED_TAGS.filter(tag => requested.has(tag));
}

function installedGameActivityTime(item: GameInstalledItem): string {
  return item.lastPlayedAt || item.installedAt;
}

function latestInstalledGameTime(items: GameInstalledItem[]): string | undefined {
  return items
    .map(installedGameActivityTime)
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))[0];
}

async function compressImageFile(file: File, options: { width: number; height: number; quality: number; fit?: "cover" | "contain" }): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件。");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器无法处理图片。");
  if (options.fit === "contain") {
    const scale = Math.min(options.width / bitmap.width, options.height / bitmap.height);
    const dw = bitmap.width * scale;
    const dh = bitmap.height * scale;
    const dx = (options.width - dw) / 2;
    const dy = (options.height - dh) / 2;
    ctx.clearRect(0, 0, options.width, options.height);
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, dx, dy, dw, dh);
    bitmap.close();
    return canvas.toDataURL("image/webp", options.quality);
  }
  const sourceRatio = bitmap.width / bitmap.height;
  const targetRatio = options.width / options.height;
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (sourceRatio > targetRatio) {
    sw = bitmap.height * targetRatio;
    sx = (bitmap.width - sw) / 2;
  } else {
    sh = bitmap.width / targetRatio;
    sy = (bitmap.height - sh) / 2;
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, options.width, options.height);
  bitmap.close();
  return canvas.toDataURL("image/webp", options.quality);
}

async function blobFromDataUrl(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return await response.blob();
}

function mergeTemplate(games: GameTemplate[], template: GameTemplate): GameTemplate[] {
  return [template, ...games.filter(item => item.id !== template.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isFullGameTemplate(template: GameTemplate): boolean {
  return Boolean(template.pickerHtml && template.gameHtml);
}

function createGameFrameSrcDoc(html: string, frameId: string): string {
  const body = html.trim();
  const base = /<html[\s>]/i.test(body)
    ? body
    : `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body>
${body}
</body>
</html>`;

  const safeAreaStyle = `<style id="ai-phone-game-safe-area">
:root {
  --ai-phone-game-safe-top: 88px;
  --ai-phone-game-safe-bottom: 24px;
  --ai-phone-game-safe-left: 16px;
  --ai-phone-game-safe-right: 16px;
  --ai-phone-game-back-size: 44px;
}
</style>`;
  const bridge = `${safeAreaStyle}<script>
(function(){
  var frameId = ${JSON.stringify(frameId)};
  var pending = {};
  var seq = 0;
  function request(action, payload){
    var requestId = frameId + '_' + (++seq);
    parent.postMessage({ source:'ai-phone-game-frame', type:'request', id:frameId, requestId:requestId, action:action, payload:payload || {} }, '*');
    return new Promise(function(resolve, reject){
      pending[requestId] = { resolve: resolve, reject: reject };
      setTimeout(function(){
        if (!pending[requestId]) return;
        delete pending[requestId];
        reject(new Error('AiPhoneGame request timeout: ' + action));
      }, 45000);
    });
  }
  var eventHandlers = {};
  window.addEventListener('message', function(event){
    var data = event.data || {};
    if (data.source !== 'ai-phone-game-host' || data.id !== frameId) return;
    if (data.type === 'event' && data.event) {
      var handlers = (eventHandlers[data.event] || []).concat(eventHandlers['*'] || []);
      handlers.forEach(function(handler){
        Promise.resolve().then(function(){ return handler(data.payload, data.event); })
          .catch(function(err){ setTimeout(function(){ throw err; }, 0); });
      });
      return;
    }
    if (!data.requestId) return;
    var item = pending[data.requestId];
    if (!item) return;
    delete pending[data.requestId];
    if (data.ok) item.resolve(data.result);
    else item.reject(new Error(data.error || 'AiPhoneGame request failed'));
  });
  var api = {
    on: function(eventName, handler){
      var key = String(eventName || '').trim();
      if (!key || typeof handler !== 'function') throw new Error('AiPhoneGame.on 需要事件名和回调函数');
      (eventHandlers[key] = eventHandlers[key] || []).push(handler);
      return function(){
        eventHandlers[key] = (eventHandlers[key] || []).filter(function(item){ return item !== handler; });
      };
    },
    off: function(eventName, handler){
      var key = String(eventName || '').trim();
      eventHandlers[key] = (eventHandlers[key] || []).filter(function(item){ return item !== handler; });
    },
    room: {
      create: function(payload){ return request('room.create', payload || {}); },
      join: function(payload){ return request('room.join', payload || {}); },
      current: function(){ return request('room.current'); },
      send: function(payload){ return request('room.send', { payload: payload }); },
      setState: function(state){ return request('room.setState', { state: state }); },
      getState: function(){ return request('room.getState'); },
      players: function(){ return request('room.players'); },
      kick: function(userId){ return request('room.kick', { userId: userId }); },
      close: function(){ return request('room.close'); },
      leave: function(){ return request('room.leave'); },
      report: function(reason){ return request('room.report', { reason: reason }); }
    },
    cloud: {
      put: function(payload){ return request('cloud.put', payload || {}); },
      get: function(payload){ return request('cloud.get', typeof payload === 'string' ? { id: payload } : (payload || {})); },
      list: function(payload){ return request('cloud.list', payload || {}); },
      update: function(payload){ return request('cloud.update', payload || {}); },
      delete: function(payload){ return request('cloud.delete', typeof payload === 'string' ? { id: payload } : (payload || {})); },
      takeRandom: function(payload){ return request('cloud.takeRandom', payload || {}); },
      report: function(payload){ return request('cloud.report', payload || {}); }
    },
    listAvailableCharacters: function(){ return request('listAvailableCharacters'); },
    getRoleSlots: function(){ return request('getRoleSlots'); },
    submitRoleAssignments: function(assignments){ return request('submitRoleAssignments', assignments || {}); },
    cancelRoleSelection: function(){ return request('cancelRoleSelection'); },
    getRoleLightPackage: function(target){ return request('getRolePackage', { target: target, mode: 'light' }); },
    getRoleFullPackage: function(target){ return request('getRolePackage', { target: target, mode: 'full' }); },
    getPlayerProfile: function(){ return request('getPlayerProfile'); },
    callLLM: function(payload){ return request('callLLM', payload || {}); },
    callGlobalLLM: function(payload){ return request('callGlobalLLM', payload || {}); },
    recordGameEvent: function(payload){ return request('recordGameEvent', payload || {}); },
    saveGame: function(data){ return request('saveGame', { data: data }); },
    loadGame: function(){ return request('loadGame'); },
    setTitleBar: function(options){ return request('setTitleBar', options || {}); },
    closeGame: function(){ return request('closeGame'); }
  };
  window.AiPhoneGame = Object.assign({}, window.AiPhoneGame || {}, api);
})();
</script>`;

  if (/<body[\s>]/i.test(base)) {
    return base.replace(/<body([^>]*)>/i, `<body$1>${bridge}`);
  }
  return `${bridge}${base}`;
}

function GameIframe({
  html,
  title,
  allowExternalControl,
  onBridgeRequest,
  registerEventSender,
}: {
  html: string;
  title: string;
  allowExternalControl: boolean;
  onBridgeRequest: (action: string, payload: unknown) => Promise<unknown> | unknown;
  registerEventSender?: (sender: ((event: string, payload: unknown) => void) | null) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameId] = useState(() => `game_frame_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const srcDoc = useMemo(() => createGameFrameSrcDoc(html, frameId), [frameId, html]);

  useEffect(() => {
    if (!registerEventSender) return;
    registerEventSender((event, payload) => {
      iframeRef.current?.contentWindow?.postMessage({
        source: "ai-phone-game-host",
        type: "event",
        id: frameId,
        event,
        payload,
      }, "*");
    });
    return () => registerEventSender(null);
  }, [frameId, registerEventSender]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record.source !== "ai-phone-game-frame" || record.id !== frameId) return;
      if (record.type !== "request") return;
      const requestId = String(record.requestId || "");
      const action = String(record.action || "");
      if (!requestId || !action) return;
      void Promise.resolve(onBridgeRequest(action, record.payload))
        .then(result => {
          iframeRef.current?.contentWindow?.postMessage({
            source: "ai-phone-game-host",
            type: "response",
            id: frameId,
            requestId,
            ok: true,
            result,
          }, "*");
        })
        .catch(err => {
          iframeRef.current?.contentWindow?.postMessage({
            source: "ai-phone-game-host",
            type: "response",
            id: frameId,
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }, "*");
        });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameId, onBridgeRequest]);

  return (
    <iframe
      ref={iframeRef}
      title={title}
      className="game-hub-frame"
      sandbox={allowExternalControl ? "allow-scripts allow-same-origin" : "allow-scripts"}
      allow="autoplay"
      srcDoc={srcDoc}
    />
  );
}

function parseBridgeMessages(value: unknown): LLMMessage[] {
  if (!Array.isArray(value)) throw new Error("messages 必须是数组。");
  return value.slice(0, 160).map((item): LLMMessage => {
    if (!item || typeof item !== "object") throw new Error("messages 内存在无效条目。");
    const record = item as Record<string, unknown>;
    const role = record.role === "assistant" || record.role === "user" || record.role === "system"
      ? record.role
      : "user";
    if (typeof record.content !== "string") throw new Error("当前游戏桥接只允许文本 messages。");
    return {
      role,
      content: record.content.slice(0, 120000),
      _debugMeta: { marker: "gameBridgeMessage", depth: 0, order: 0 },
    };
  });
}

function assignmentMap(assignments: GameRoleAssignment[]): Map<string, string[]> {
  return new Map(assignments.map(item => [item.slotId, item.characterIds]));
}

function normalizeAssignmentPayload(payload: unknown, slots: GameRoleSlot[], characters: Character[]): GameRoleAssignment[] {
  if (!payload || typeof payload !== "object") throw new Error("角色选择结果无效。");
  const record = payload as Record<string, unknown>;
  const rawSlots = record.slots && typeof record.slots === "object" ? record.slots as Record<string, unknown> : record;
  const characterIds = new Set(characters.map(item => item.id));
  const result: GameRoleAssignment[] = [];

  for (const slot of slots) {
    const raw = rawSlots[slot.id];
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const selected = Array.from(new Set(list.map(item => String(item)).filter(id => characterIds.has(id)))).slice(0, slot.max);
    if (selected.length < slot.min) {
      throw new Error(`${slot.label} 至少需要选择 ${slot.min} 个角色。`);
    }
    result.push({ slotId: slot.id, characterIds: selected });
  }

  return result;
}

function createDraftId(): string {
  return `game_draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTemplateFromDraft(
  draft: GameTemplateDraft,
  state: GameState,
  existing?: GameTemplate | null,
  options: { anonymous?: boolean; authorId?: string; authorName?: string; authorAvatar?: string } = {},
): GameTemplate {
  const title = draft.title.trim();
  const gameHtml = sanitizeHtml(draft.gameHtml);
  const roleSlots = parseGameRoleSlots(draft.roleSlotsText);
  const pickerHtml = roleSlots.length > 0 ? sanitizeHtml(draft.pickerHtml) : GAME_EMPTY_PICKER_HTML;
  if (!title) throw new Error("游戏标题不能为空。");
  if (roleSlots.length > 0 && !pickerHtml) throw new Error("启用角色槽位时，角色选择 HTML 不能为空。");
  if (!gameHtml) throw new Error("游戏 HTML 不能为空。");
  const tags = parseAllowedGameTags(draft.tagsText);
  if (tags.length === 0) throw new Error("请至少选择一个游戏标签。");
  const now = new Date().toISOString();
  return {
    id: existing?.id || `game_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    codeName: GAME_DECORATIVE_CODE,
    subtitle: "",
    synopsis: "",
    playNote: draft.playNote.trim(),
    coverImage: draft.coverImage.trim(),
    tags,
    authorId: existing?.authorId || options.authorId || state.userId,
    authorName: options.anonymous ? "匿名" : displayGameAuthorName(options.authorName?.trim() || state.displayName.trim() || draft.authorName.trim()),
    authorAvatar: options.anonymous ? "" : (options.authorAvatar ?? state.avatarUrl).trim(),
    source: "community",
    version: existing ? existing.version + 1 : 1,
    roleSlots,
    pickerHtml,
    gameHtml,
    allowExternalControl: draft.allowExternalControl,
    purchaseCount: existing?.purchaseCount ?? 0,
    rating: existing?.rating ?? 0,
    likeCount: existing?.likeCount ?? 0,
    favoriteCount: existing?.favoriteCount ?? 0,
    commentCount: existing?.commentCount ?? 0,
    likedByMe: existing?.likedByMe ?? false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function draftFromTemplate(template: GameTemplate): GameTemplateDraft {
  const tags = parseAllowedGameTags(template.tags.join(" "));
  return {
    title: template.title,
    codeName: GAME_DECORATIVE_CODE,
    subtitle: "",
    synopsis: "",
    playNote: gameDisplayDescription(template),
    coverImage: template.coverImage,
    tagsText: tags.length > 0 ? tags.join(" ") : "互动",
    authorName: template.authorName,
    roleSlotsText: JSON.stringify(template.roleSlots, null, 2),
    pickerHtml: template.pickerHtml,
    gameHtml: template.gameHtml,
    allowExternalControl: template.allowExternalControl,
  };
}

export function GameHubApp({ onClose }: { onClose: () => void }) {
  const { account } = useAccount();
  const [mainView, setMainView] = useState<GameMainView>("hall");
  const [studioMode, setStudioMode] = useState<GameStudioMode>("drafts");
  const [state, setState] = useState<GameState>(() => loadGameState());
  const [communityGames, setCommunityGames] = useState<GameTemplate[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [notice, setNotice] = useState<GameNotice | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<GameTemplate | null>(null);
  const [creatorPageOpen, setCreatorPageOpen] = useState(false);
  const [draft, setDraft] = useState<GameTemplateDraft>(() => createDefaultGameDraft());
  const [drafts, setDrafts] = useState<GameHallDraft[]>(() => loadGameDrafts());
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishAnonymously, setPublishAnonymously] = useState(false);
  const [runtimeGame, setRuntimeGame] = useState<GameInstalledItem | null>(null);
  const [runtimeStage, setRuntimeStage] = useState<RuntimeStage | null>(null);
  const [advancedAllowed, setAdvancedAllowed] = useState(false);
  const [runtimeAssignments, setRuntimeAssignments] = useState<GameRoleAssignment[]>([]);
  const [runtimeTitleBar, setRuntimeTitleBar] = useState<RuntimeTitleBarConfig>(DEFAULT_RUNTIME_TITLE_BAR);
  const [advancedStudioOpen, setAdvancedStudioOpen] = useState(false);
  const [creatorGuideOpen, setCreatorGuideOpen] = useState(false);
  const [commentsByGame, setCommentsByGame] = useState<Record<string, GameComment[]>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [commentReplyTargets, setCommentReplyTargets] = useState<Record<string, GameComment>>({});
  const [commentDeleteTarget, setCommentDeleteTarget] = useState<CommentDeleteTarget | null>(null);
  const [commentMenu, setCommentMenu] = useState<{ template: GameTemplate; comment: GameComment; x: number; y: number } | null>(null);
  const commentPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentPressTriggeredRef = useRef(false);
  const gameRoomRef = useRef<OnlineRoomConnection | null>(null);
  const gameEventSenderRef = useRef<((event: string, payload: unknown) => void) | null>(null);
  const registerGameEventSender = useCallback((sender: ((event: string, payload: unknown) => void) | null) => {
    gameEventSenderRef.current = sender;
  }, []);
  const postGameEvent = useCallback((event: string, payload: unknown) => {
    gameEventSenderRef.current?.(event, payload);
  }, []);
  // 组件卸载兜底：退房（房主退房 = 关房）
  useEffect(() => () => {
    gameRoomRef.current?.leave();
    gameRoomRef.current = null;
  }, []);
  const commentPressPosRef = useRef<{ x: number; y: number } | null>(null);
  const [submittingCommentIds, setSubmittingCommentIds] = useState<Record<string, boolean>>({});
  const [deletingCommentIds, setDeletingCommentIds] = useState<Record<string, boolean>>({});
  const [commentsLoadingId, setCommentsLoadingId] = useState<string | null>(null);
  const [expandedCommentsGameId, setExpandedCommentsGameId] = useState<string | null>(null);
  const [hallSearch, setHallSearch] = useState("");
  const [hallCategory, setHallCategory] = useState("推荐");
  const [activeCollectionId, setActiveCollectionId] = useState(DEFAULT_GAME_COLLECTION_ID);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [collectionPickerTemplate, setCollectionPickerTemplate] = useState<GameTemplate | null>(null);
  const [collectionMenuId, setCollectionMenuId] = useState<string | null>(null);
  const [recordMenuId, setRecordMenuId] = useState<string | null>(null);
  const [deleteCollectionTarget, setDeleteCollectionTarget] = useState<GameLibraryCollection | null>(null);
  const [collectionDeleteBlockedOpen, setCollectionDeleteBlockedOpen] = useState(false);
  const [studioMenuId, setStudioMenuId] = useState<string | null>(null);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [coverDeleteConfirmOpen, setCoverDeleteConfirmOpen] = useState(false);
  const [profileDraftName, setProfileDraftName] = useState("");
  const [profileDraftAvatar, setProfileDraftAvatar] = useState("");
  const [relativeNow, setRelativeNow] = useState<number | null>(null);
  const htmlFileInputRef = useRef<HTMLInputElement | null>(null);
  const coverFileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const previewGameSaveRef = useRef<unknown>(null);
  const fullGameRequestsRef = useRef<Record<string, Promise<GameTemplate>>>({});

  const builtinCatalog = useMemo(() => getGameCatalog(), []);
  const catalog = useMemo(() => [...communityGames, ...builtinCatalog], [builtinCatalog, communityGames]);
  const filteredCatalog = useMemo(() => {
    const query = hallSearch.trim().toLowerCase();
    return catalog.filter(template => {
      if (!gameMatchesCategory(template, hallCategory)) return false;
      return !query || gameSearchText(template).includes(query);
    });
  }, [catalog, hallCategory, hallSearch]);
  const recentPlayedGames = useMemo(
    () => state.installedGames
      .filter(item => item.playCount > 0)
      .sort((a, b) => installedGameActivityTime(b).localeCompare(installedGameActivityTime(a))),
    [state.installedGames],
  );
  const recentGameEvents = useMemo(
    () => [...(state.gameEvents ?? [])]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 20),
    [state.gameEvents],
  );
  const libraryCollections = useMemo<GameLibraryCollection[]>(() => {
    const sortedInstalled = [...state.installedGames]
      .sort((a, b) => installedGameActivityTime(b).localeCompare(installedGameActivityTime(a)));
    const defaultCollectionHidden = state.hiddenDefaultCollectionIds.includes(DEFAULT_GAME_COLLECTION_ID);
    const customFolders = (state.collectionFolders ?? []).map((folder): GameLibraryCollection => {
      const ids = new Set(folder.gameIds);
      const games = sortedInstalled.filter(item => ids.has(item.remoteTemplateId));
      return {
        id: folder.id,
        name: folder.name,
        description: folder.description || "自定义收藏夹",
        colorA: folder.colorA,
        colorB: folder.colorB,
        count: games.length,
        updatedAt: folder.updatedAt,
        games,
      };
    });
    return [
      ...(defaultCollectionHidden ? [] : [{
        id: DEFAULT_GAME_COLLECTION_ID,
        name: "角色互动",
        description: "加入小柜的游戏会先显示在这里",
        colorA: "#c4b5fd",
        colorB: "#f9a8d4",
        count: sortedInstalled.length,
        updatedAt: latestInstalledGameTime(sortedInstalled),
        games: sortedInstalled,
      }]),
      ...customFolders,
    ];
  }, [state.collectionFolders, state.hiddenDefaultCollectionIds, state.installedGames]);
  const installedTemplateIds = useMemo(() => new Set(state.installedGames.map(item => item.remoteTemplateId)), [state.installedGames]);
  const publishedGames = useMemo(
    () => communityGames.filter(item => item.authorId === account.id || item.authorId === "local_user"),
    [account.id, communityGames],
  );
  const publishedFavoriteTotal = useMemo(
    () => publishedGames.reduce((total, item) => total + item.favoriteCount, 0),
    [publishedGames],
  );
  const editingTemplate = useMemo(
    () => editingTemplateId ? communityGames.find(item => item.id === editingTemplateId) ?? null : null,
    [communityGames, editingTemplateId],
  );

  useEffect(() => {
    const syncState = () => setState(loadGameState());
    window.addEventListener("ai-phone-game-updated", syncState);
    return () => window.removeEventListener("ai-phone-game-updated", syncState);
  }, []);

  useEffect(() => {
    void loadCommunityGames();
  }, []);

  useEffect(() => {
    setSelectedTemplate(current => {
      if (!current || current.source !== "community") return current;
      return communityGames.find(item => item.id === current.id) ?? current;
    });
  }, [communityGames]);

  useEffect(() => () => {
    if (commentPressTimerRef.current) clearTimeout(commentPressTimerRef.current);
  }, []);

  useEffect(() => {
    const updateRelativeNow = () => setRelativeNow(Date.now());
    updateRelativeNow();
    const timer = window.setInterval(updateRelativeNow, 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!collectionMenuId && !studioMenuId && !recordMenuId) return undefined;

    const closeFloatingMenus = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".game-collection-menu, .game-studio-card-menu, .game-play-record-menu")) return;
      setCollectionMenuId(null);
      setStudioMenuId(null);
      setRecordMenuId(null);
    };

    document.addEventListener("pointerdown", closeFloatingMenus);
    return () => document.removeEventListener("pointerdown", closeFloatingMenus);
  }, [collectionMenuId, studioMenuId, recordMenuId]);

  function showNotice(tone: GameNotice["tone"], text: string): void {
    setNotice({ id: Date.now(), tone, text });
  }

  function syncCloudInstalledTemplates(templates: GameTemplate[]): { added: number; refreshed: number } {
    if (templates.length === 0) return { added: 0, refreshed: 0 };
    const cloudTemplates = new Map(templates.map(template => [template.id, template]));
    const existingIds = new Set(loadGameState().installedGames.map(item => item.remoteTemplateId));
    let added = 0;
    for (const template of templates) {
      if (existingIds.has(template.id)) continue;
      const result = installGameTemplate(template);
      if (result.ok && result.installedGame) {
        existingIds.add(template.id);
        added += 1;
      }
    }

    const latest = loadGameState();
    let refreshed = 0;
    const installedGames = latest.installedGames.map(item => {
      const cloudTemplate = cloudTemplates.get(item.remoteTemplateId);
      if (!cloudTemplate) return item;
      if (
        item.templateSnapshot.version === cloudTemplate.version
        && item.templateSnapshot.updatedAt === cloudTemplate.updatedAt
        && item.templateSnapshot.likeCount === cloudTemplate.likeCount
        && item.templateSnapshot.favoriteCount === cloudTemplate.favoriteCount
        && item.templateSnapshot.commentCount === cloudTemplate.commentCount
      ) {
        return item;
      }
      refreshed += 1;
      return {
        ...item,
        templateSnapshot: cloudTemplate,
      };
    });

    if (added > 0 || refreshed > 0) {
      setState(saveGameState({
        ...latest,
        installedGames,
      }));
    }
    return { added, refreshed };
  }

  async function ensureFullGameTemplate(template: GameTemplate): Promise<GameTemplate> {
    if (template.source !== "community" || isFullGameTemplate(template)) return template;
    const current = communityGames.find(item => item.id === template.id);
    if (current && isFullGameTemplate(current)) return current;
    let request = fullGameRequestsRef.current[template.id];
    if (!request) {
      request = fetchGameHallTemplate(template.id).finally(() => {
        delete fullGameRequestsRef.current[template.id];
      });
      fullGameRequestsRef.current[template.id] = request;
    }
    const fullTemplate = await request;
    setCommunityGames(currentGames => mergeTemplate(currentGames, fullTemplate));
    setSelectedTemplate(currentSelected => currentSelected?.id === fullTemplate.id ? { ...currentSelected, ...fullTemplate } : currentSelected);
    setCollectionPickerTemplate(currentPicker => currentPicker?.id === fullTemplate.id ? { ...currentPicker, ...fullTemplate } : currentPicker);
    return fullTemplate;
  }

  function createCollectionFolder(): void {
    const name = newCollectionName.trim();
    if (!name) {
      showNotice("error", "先给收藏夹起个名字");
      return;
    }
    if (state.collectionFolders.some(folder => folder.name === name)) {
      showNotice("info", "已经有同名收藏夹了");
      return;
    }
    const now = new Date().toISOString();
    const colors = GAME_COLLECTION_COLORS[state.collectionFolders.length % GAME_COLLECTION_COLORS.length];
    const folder: GameCollectionFolder = {
      id: `collection_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description: "自定义收藏夹",
      colorA: colors[0],
      colorB: colors[1],
      gameIds: [],
      createdAt: now,
      updatedAt: now,
    };
    setState(saveGameCollectionFolders([folder, ...state.collectionFolders]));
    setActiveCollectionId(folder.id);
    setNewCollectionName("");
    setNewCollectionOpen(false);
    showNotice("success", "收藏夹已创建");
  }

  function requestDeleteCollectionFolder(collection: GameLibraryCollection): void {
    setCollectionMenuId(null);
    if (libraryCollections.length <= 1) {
      setDeleteCollectionTarget(null);
      setCollectionDeleteBlockedOpen(true);
      return;
    }
    setDeleteCollectionTarget(collection);
  }

  function confirmDeleteCollectionFolder(): void {
    const target = deleteCollectionTarget;
    if (!target) return;
    const folderId = target.id;
    const latest = loadGameState();
    const deletingDefaultCollection = folderId === DEFAULT_GAME_COLLECTION_ID;
    const existing = deletingDefaultCollection
      ? null
      : latest.collectionFolders.find(folder => folder.id === folderId);
    if (!existing) {
      if (!deletingDefaultCollection) {
        setCollectionMenuId(null);
        setDeleteCollectionTarget(null);
        showNotice("error", "没有找到这个分类");
        return;
      }
    }
    const gameIdsToRemove = new Set(deletingDefaultCollection
      ? latest.installedGames.map(item => item.remoteTemplateId)
      : existing?.gameIds ?? []);
    const removedGames = latest.installedGames.filter(item => gameIdsToRemove.has(item.remoteTemplateId));
    const removedLocalIds = new Set(removedGames.map(item => item.localId));
    const nextState = saveGameState({
      ...latest,
      installedGames: latest.installedGames.filter(item => !gameIdsToRemove.has(item.remoteTemplateId)),
      hiddenDefaultCollectionIds: deletingDefaultCollection
        ? [...new Set([...(latest.hiddenDefaultCollectionIds ?? []), DEFAULT_GAME_COLLECTION_ID])]
        : latest.hiddenDefaultCollectionIds,
      collectionFolders: latest.collectionFolders
        .filter(folder => folder.id !== folderId)
        .map(folder => ({
          ...folder,
          gameIds: folder.gameIds.filter(id => !gameIdsToRemove.has(id)),
          updatedAt: folder.gameIds.some(id => gameIdsToRemove.has(id)) ? new Date().toISOString() : folder.updatedAt,
        })),
      saves: latest.saves.filter(item => !removedLocalIds.has(item.localGameId)),
      gameEvents: latest.gameEvents.filter(item => !removedLocalIds.has(item.localGameId)),
    });
    setState(nextState);
    if (activeCollectionId === folderId) setActiveCollectionId("");
    removedGames.forEach(item => {
      void syncFavoriteCount(item.templateSnapshot, false);
    });
    setCollectionMenuId(null);
    setDeleteCollectionTarget(null);
    showNotice("info", removedGames.length > 0 ? "分类和其中游戏已删除" : "分类已删除");
  }

  async function loadCommunityGames(showResult = false): Promise<void> {
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      const games = await fetchGameHallTemplates(account.id);
      let restored = { added: 0, refreshed: 0 };
      try {
        restored = syncCloudInstalledTemplates(await fetchInstalledGameHallTemplates());
      } catch (err) {
        console.warn("[GameHub] Cloud installed games restore failed:", err);
      }
      setCommunityGames(games.map(game => ({
        ...game,
        likedByMe: game.likedByMe || state.likedGameIds.includes(game.id),
        favoritedByMe: game.favoritedByMe || installedTemplateIds.has(game.id),
      })));
      if (restored.added > 0 && !showResult) {
        showNotice("success", `已恢复 ${restored.added} 个云端小柜游戏`);
      } else if (showResult) {
        const suffix = restored.added > 0 ? `，恢复 ${restored.added} 个小柜游戏` : "";
        showNotice("success", games.length > 0 ? `同步 ${games.length} 个共享游戏${suffix}` : "共享大厅暂时为空");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "共享大厅暂时不可用";
      setCommunityError(message);
      if (showResult) showNotice("error", message);
    } finally {
      setCommunityLoading(false);
    }
  }

  async function syncFavoriteCount(template: GameTemplate, favorited: boolean): Promise<void> {
    if (template.source !== "community") return;
    const previousCount = template.favoriteCount;
    const nextCount = Math.max(0, previousCount + (favorited ? 1 : -1));
    patchTemplateLocal(template.id, { favoriteCount: nextCount });
    try {
      const result = await setGameFavorite({ gameId: template.id, userId: account.id, favorited });
      patchTemplateLocal(template.id, { favoriteCount: result.favoriteCount });
    } catch (err) {
      patchTemplateLocal(template.id, { favoriteCount: previousCount });
      console.warn("[GameHub] Favorite state update failed:", err);
    }
  }

  function installTemplate(template: GameTemplate, options: { countFavorite: boolean }): GameInstalledItem | null {
    const existing = state.installedGames.find(item => item.remoteTemplateId === template.id);
    if (existing) {
      return existing;
    }
    if (!isFullGameTemplate(template)) {
      showNotice("error", "游戏包还没有加载完成，请稍后再试");
      return null;
    }
    const result = installGameTemplate(template);
    setState(result.state);
    if (!result.ok || !result.installedGame) {
      showNotice(result.error === "已经安装过这个游戏。" ? "info" : "error", result.error || "安装失败");
      return result.installedGame ?? null;
    }
    if (options.countFavorite) void syncFavoriteCount(template, true);
    return result.installedGame;
  }

  function openCollectionPicker(template: GameTemplate): void {
    setCollectionPickerTemplate(template);
  }

  function closeCollectionPicker(): void {
    setCollectionPickerTemplate(null);
  }

  async function addTemplateToLibrary(template: GameTemplate, collectionId: string): Promise<void> {
    let fullTemplate = template;
    try {
      fullTemplate = await ensureFullGameTemplate(template);
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "游戏详情加载失败");
      return;
    }
    const wasInstalled = state.installedGames.some(item => item.remoteTemplateId === template.id);
    const installed = installTemplate(fullTemplate, { countFavorite: !wasInstalled });
    if (!installed) return;

    const collection = libraryCollections.find(item => item.id === collectionId);
    if (!collection) {
      showNotice("error", "没有找到这个分类");
      return;
    }

    if (collectionId !== DEFAULT_GAME_COLLECTION_ID) {
      const latest = loadGameState();
      const nextFolders = latest.collectionFolders.map(folder => {
        if (folder.id !== collectionId) return folder;
        if (folder.gameIds.includes(fullTemplate.id)) return folder;
        return {
          ...folder,
          gameIds: [fullTemplate.id, ...folder.gameIds],
          updatedAt: new Date().toISOString(),
        };
      });
      setState(saveGameCollectionFolders(nextFolders));
    }

    setActiveCollectionId(collectionId);
    closeCollectionPicker();
    showNotice("success", `已加入${collection.name}`);
  }

  function toggleTemplateLibrary(template: GameTemplate): void {
    const existing = state.installedGames.find(item => item.remoteTemplateId === template.id);
    if (!existing) {
      openCollectionPicker(template);
      return;
    }
    const result = deleteInstalledGame(existing.localId);
    setState(result.state);
    if (!result.ok) {
      showNotice("error", result.error || "移除失败");
      return;
    }
    void syncFavoriteCount(template, false);
    showNotice("info", "已从收藏柜移除");
  }

  function deleteGameRecord(eventId: string): void {
    const result = deleteGameProjectionEvent(eventId);
    setState(result.state);
    setRecordMenuId(null);
    if (!result.ok) {
      showNotice("error", result.error || "删除失败");
      return;
    }
    showNotice("info", "已删除该条游玩记录");
  }

  async function handleTemplatePrimaryAction(template: GameTemplate): Promise<void> {
    const existing = state.installedGames.find(item => item.remoteTemplateId === template.id);
    if (existing) {
      openRuntime(existing);
      return;
    }
    try {
      openCollectionPicker(await ensureFullGameTemplate(template));
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "游戏详情加载失败");
    }
  }

  function openRuntime(item: GameInstalledItem): void {
    const nextStage = item.templateSnapshot.allowExternalControl
      ? "permission"
      : item.templateSnapshot.roleSlots.length > 0 ? "picker" : "game";
    setRuntimeGame(item);
    setRuntimeAssignments(item.roleAssignments);
    setAdvancedAllowed(false);
    setRuntimeTitleBar(DEFAULT_RUNTIME_TITLE_BAR);
    setRuntimeStage(nextStage);
    if (nextStage === "game" && !isPreviewGame(item.localId)) setState(markGamePlayed(item.localId));
    setSelectedTemplate(null);
  }

  function closeRuntime(): void {
    gameRoomRef.current?.leave();
    gameRoomRef.current = null;
    setRuntimeGame(null);
    setRuntimeStage(null);
    setAdvancedAllowed(false);
    setRuntimeTitleBar(DEFAULT_RUNTIME_TITLE_BAR);
    setRuntimeAssignments([]);
  }

  function confirmAdvancedPermission(): void {
    if (!runtimeGame) return;
    const nextStage = runtimeGame.templateSnapshot.roleSlots.length > 0 ? "picker" : "game";
    setAdvancedAllowed(true);
    setRuntimeStage(nextStage);
    if (nextStage === "game" && !isPreviewGame(runtimeGame.localId)) setState(markGamePlayed(runtimeGame.localId));
  }

  function updateDraft<K extends keyof GameTemplateDraft>(key: K, value: GameTemplateDraft[K]): void {
    setDraft(current => ({ ...current, [key]: value }));
  }

  function toggleDraftTag(tag: string): void {
    if (!GAME_ALLOWED_TAGS.includes(tag)) return;
    setDraft(current => {
      const selected = new Set(parseAllowedGameTags(current.tagsText));
      if (selected.has(tag)) {
        selected.delete(tag);
      } else {
        selected.add(tag);
      }
      return {
        ...current,
        tagsText: GAME_ALLOWED_TAGS.filter(item => selected.has(item)).join(" "),
      };
    });
  }

  function resetDraft(): void {
    setEditingDraftId(null);
    setEditingTemplateId(null);
    setAdvancedStudioOpen(false);
    setPublishAnonymously(false);
    setDraft(createDefaultGameDraft());
  }

  function openCreatorPage(): void {
    resetDraft();
    setCreatorGuideOpen(false);
    setCreatorPageOpen(true);
    setMainView("studio");
  }

  function closeCreatorPage(): void {
    setCreatorPageOpen(false);
    setCreatorGuideOpen(false);
    resetDraft();
  }

  function saveDraft(): void {
    const now = new Date().toISOString();
    const id = editingDraftId || createDraftId();
    const title = draft.title.trim() || "未命名游戏";
    const tags = parseAllowedGameTags(draft.tagsText);
    const normalizedDraft = { ...draft, tagsText: (tags.length > 0 ? tags : ["互动"]).join(" ") };
    setDraft(normalizedDraft);
    setDrafts(current => {
      const existing = current.find(item => item.id === id);
      return saveGameDrafts([
        {
          id,
          title,
          draft: normalizedDraft,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        },
        ...current.filter(item => item.id !== id),
      ]);
    });
    showNotice("success", "草稿已保存");
  }

  function editDraft(item: GameHallDraft): void {
    setStudioMenuId(null);
    setEditingDraftId(item.id);
    setEditingTemplateId(null);
    setDraft(item.draft);
    setAdvancedStudioOpen(parseGameRoleSlots(item.draft.roleSlotsText).length > 0);
    setPublishAnonymously(false);
    setCreatorPageOpen(true);
    setMainView("studio");
  }

  function deleteDraft(id: string): void {
    setStudioMenuId(null);
    setDrafts(current => saveGameDrafts(current.filter(item => item.id !== id)));
    if (editingDraftId === id) setEditingDraftId(null);
    showNotice("info", "草稿已删除");
  }

  async function editPublished(template: GameTemplate): Promise<void> {
    let fullTemplate = template;
    try {
      fullTemplate = await ensureFullGameTemplate(template);
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "游戏详情加载失败");
      return;
    }
    setStudioMenuId(null);
    setEditingTemplateId(fullTemplate.id);
    setEditingDraftId(null);
    setDraft(draftFromTemplate(fullTemplate));
    setAdvancedStudioOpen(fullTemplate.roleSlots.length > 0);
    setPublishAnonymously(displayGameAuthorName(fullTemplate.authorName) === "匿名" && !fullTemplate.authorAvatar);
    setCreatorPageOpen(true);
    setMainView("studio");
  }

  async function copyCreatorGuide(): Promise<void> {
    try {
      await navigator.clipboard.writeText(GAME_CREATOR_GUIDE_MD);
      showNotice("success", "制作说明已复制");
    } catch {
      showNotice("error", "复制失败，请手动选择文本复制");
    }
  }

  async function uploadGameHtmlFile(file: File | null): Promise<void> {
    if (!file) return;
    const isHtmlFile = /\.(html?|xhtml)$/i.test(file.name) || file.type === "text/html";
    if (!isHtmlFile) {
      showNotice("error", "请选择 HTML 文件");
      return;
    }
    try {
      const text = await file.text();
      const html = text.replace(/^\uFEFF/, "");
      if (!html.trim()) {
        showNotice("error", "HTML 文件为空");
        return;
      }
      updateDraft("gameHtml", html);
      showNotice("success", `已导入 ${file.name}`);
    } catch {
      showNotice("error", "读取 HTML 文件失败");
    }
  }

  async function uploadCoverFile(file: File | null): Promise<void> {
    if (!file) return;
    try {
      const image = await compressImageFile(file, { width: 704, height: 640, quality: 0.84 });
      updateDraft("coverImage", image);
      showNotice("success", "封面已载入");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "封面读取失败");
    }
  }

  function confirmDeleteCoverImage(): void {
    updateDraft("coverImage", "");
    setCoverDeleteConfirmOpen(false);
    showNotice("success", "封面已删除");
  }

  function openProfileEditor(): void {
    setProfileDraftName(state.displayName);
    setProfileDraftAvatar(state.avatarUrl);
    setProfileEditorOpen(true);
  }

  function closeProfileEditor(): void {
    setProfileEditorOpen(false);
  }

  async function uploadProfileEditorAvatar(file: File | null): Promise<void> {
    if (!file) return;
    try {
      const image = await compressImageFile(file, { width: 256, height: 256, quality: 0.84, fit: "contain" });
      setProfileDraftAvatar(image);
      showNotice("success", "头像已载入");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "头像读取失败");
    }
  }

  async function saveProfileEditor(): Promise<void> {
    if (profileSaving) return;
    setProfileSaving(true);
    const displayName = profileDraftName.trim() || "本机玩家";
    try {
      const avatarUrl = await uploadInlineAsset(profileDraftAvatar, "avatar", `${account.id}-avatar.webp`);
      const next = saveGameHallProfile({ displayName, avatarUrl });
      setState(next);
      setProfileDraftAvatar(avatarUrl);
      setDraft(current => ({ ...current, authorName: next.displayName }));
      setProfileEditorOpen(false);
      showNotice("success", "资料已保存");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "头像保存失败");
    } finally {
      setProfileSaving(false);
    }
  }

  async function uploadInlineAsset(value: string, kind: "cover" | "avatar", filename: string): Promise<string> {
    if (!isInlineImage(value)) return value;
    const blob = await blobFromDataUrl(value);
    const result = await uploadGameHallAsset({ file: blob, filename, kind });
    return result.url;
  }

  async function prepareTemplateForPublish(template: GameTemplate): Promise<GameTemplate> {
    const coverImage = await uploadInlineAsset(template.coverImage, "cover", `${template.id}-cover.webp`);
    const authorAvatar = await uploadInlineAsset(template.authorAvatar, "avatar", `${account.id}-avatar.webp`);
    if (authorAvatar && authorAvatar !== state.avatarUrl) {
      setState(saveGameHallProfile({ displayName: state.displayName, avatarUrl: authorAvatar }));
    }
    return { ...template, coverImage, authorAvatar };
  }

  async function resolveProfileAvatarForCloud(): Promise<string> {
    const latest = loadGameState();
    const avatarUrl = latest.avatarUrl || state.avatarUrl;
    if (!isInlineImage(avatarUrl)) return avatarUrl;
    const uploadedAvatarUrl = await uploadInlineAsset(avatarUrl, "avatar", `${account.id}-avatar.webp`);
    const next = saveGameHallProfile({
      displayName: latest.displayName || state.displayName,
      avatarUrl: uploadedAvatarUrl,
    });
    setState(next);
    return uploadedAvatarUrl;
  }

  function isPreviewGame(localId: string): boolean {
    return localId.startsWith(GAME_PREVIEW_LOCAL_ID_PREFIX);
  }

  function previewDraft(): void {
    try {
      const template = createTemplateFromDraft(draft, state, editingTemplate);
      const now = new Date().toISOString();
      previewGameSaveRef.current = null;
      openRuntime({
        localId: `${GAME_PREVIEW_LOCAL_ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        remoteTemplateId: template.id,
        installedAt: now,
        templateSnapshot: { ...template, source: "local", updatedAt: now },
        roleAssignments: [],
        status: "installed",
        playCount: 0,
      });
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "当前草稿无法试玩");
    }
  }

  async function publishDraft(): Promise<void> {
    setPublishing(true);
    try {
      const template = await prepareTemplateForPublish(createTemplateFromDraft(draft, state, editingTemplate, {
        anonymous: publishAnonymously,
        authorId: account.id,
        authorName: state.displayName,
        authorAvatar: state.avatarUrl,
      }));
      const published = editingTemplate
        ? await updateGameTemplate(template)
        : await publishGameTemplate(template);
      setCommunityGames(current => mergeTemplate(current, published));
      if (editingDraftId) {
        setDrafts(current => saveGameDrafts(current.filter(item => item.id !== editingDraftId)));
      }
      setEditingDraftId(null);
      setEditingTemplateId(null);
      setStudioMode("published");
      setCreatorPageOpen(false);
      setCreatorGuideOpen(false);
      setMainView("studio");
      showNotice("success", editingTemplate ? "游戏已同步修改" : "游戏已发布到共享大厅");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "发布失败");
    } finally {
      setPublishing(false);
    }
  }

  async function deletePublished(template: GameTemplate): Promise<void> {
    try {
      await deleteGameTemplate({ id: template.id, authorId: template.authorId });
      setCommunityGames(current => current.filter(item => item.id !== template.id));
      showNotice("success", "已从共享大厅删除");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "删除失败");
    }
  }

  function patchTemplateLocal(templateId: string, patch: Partial<GameTemplate>): void {
    setCommunityGames(current => current.map(item => item.id === templateId ? { ...item, ...patch } : item));
    setSelectedTemplate(current => current?.id === templateId ? { ...current, ...patch } : current);
  }

  async function toggleLike(template: GameTemplate): Promise<void> {
    if (template.source !== "community") {
      showNotice("info", "内置游戏暂不支持点赞");
      return;
    }
    const wasLiked = Boolean(template.likedByMe || state.likedGameIds.includes(template.id));
    const nextLiked = !wasLiked;
    const nextCount = Math.max(0, template.likeCount + (nextLiked ? 1 : -1));
    const nextLikedIds = nextLiked
      ? [...new Set([...state.likedGameIds, template.id])]
      : state.likedGameIds.filter(id => id !== template.id);
    setState(saveLikedGameIds(nextLikedIds));
    patchTemplateLocal(template.id, { likedByMe: nextLiked, likeCount: nextCount });
    try {
      const result = await toggleGameLike({ gameId: template.id, userId: account.id });
      patchTemplateLocal(template.id, { likedByMe: result.liked, likeCount: result.likeCount });
      setState(saveLikedGameIds(result.liked
        ? [...new Set([...nextLikedIds, template.id])]
        : nextLikedIds.filter(id => id !== template.id)));
    } catch (err) {
      setState(saveLikedGameIds(state.likedGameIds));
      patchTemplateLocal(template.id, { likedByMe: wasLiked, likeCount: template.likeCount });
      showNotice("error", err instanceof Error ? err.message : "点赞失败");
    }
  }

  async function ensureCommentsLoaded(template: GameTemplate): Promise<void> {
    if (!GAME_HALL_COMMENTS_ENABLED) return;
    if (template.source !== "community" || commentsByGame[template.id]) return;
    setCommentsLoadingId(template.id);
    try {
      const comments = await fetchGameComments(template.id);
      setCommentsByGame(current => ({ ...current, [template.id]: comments }));
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "评论加载失败");
    } finally {
      setCommentsLoadingId(null);
    }
  }

  function openTemplateDetails(template: GameTemplate): void {
    setSelectedTemplate(template);
    setExpandedCommentsGameId(GAME_HALL_COMMENTS_ENABLED && template.source === "community" ? template.id : null);
    if (GAME_HALL_COMMENTS_ENABLED && template.source === "community") void ensureCommentsLoaded(template);
    if (template.source === "community" && !isFullGameTemplate(template)) {
      void ensureFullGameTemplate(template).catch(err => {
        showNotice("error", err instanceof Error ? err.message : "游戏详情加载失败");
      });
    }
  }

  function closeTemplateDetails(): void {
    const templateId = selectedTemplate?.id;
    setSelectedTemplate(null);
    setExpandedCommentsGameId(null);
    if (templateId) {
      setCommentReplyTargets(current => {
        if (!current[templateId]) return current;
        const next = { ...current };
        delete next[templateId];
        return next;
      });
    }
  }

  function toggleTemplateComments(template: GameTemplate): void {
    if (!GAME_HALL_COMMENTS_ENABLED) return;
    const nextOpen = expandedCommentsGameId !== template.id;
    setExpandedCommentsGameId(nextOpen ? template.id : null);
    if (nextOpen && template.source === "community") void ensureCommentsLoaded(template);
  }

  async function submitComment(template: GameTemplate): Promise<void> {
    if (!GAME_HALL_COMMENTS_ENABLED) return;
    const content = (commentDrafts[template.id] || "").trim();
    if (!content || submittingCommentIds[template.id]) return;
    const replyTarget = commentReplyTargets[template.id];
    setSubmittingCommentIds(current => ({ ...current, [template.id]: true }));
    try {
      const authorAvatar = await resolveProfileAvatarForCloud();
      const result = await postGameComment({
        gameId: template.id,
        parentId: replyTarget?.id,
        authorId: account.id,
        authorName: state.displayName || account.displayName || "匿名玩家",
        authorAvatar,
        content,
      });
      setCommentsByGame(current => ({
        ...current,
        [template.id]: [...(current[template.id] ?? []), result.comment],
      }));
      setCommentDrafts(current => ({ ...current, [template.id]: "" }));
      setCommentReplyTargets(current => {
        if (!current[template.id]) return current;
        const next = { ...current };
        delete next[template.id];
        return next;
      });
      setExpandedCommentsGameId(template.id);
      patchTemplateLocal(template.id, { commentCount: result.commentCount });
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "评论发布失败");
    } finally {
      setSubmittingCommentIds(current => {
        const next = { ...current };
        delete next[template.id];
        return next;
      });
    }
  }

  function canDeleteGameComment(template: GameTemplate, comment: GameComment): boolean {
    return GAME_HALL_COMMENTS_ENABLED && template.source === "community" && (comment.authorId === account.id || template.authorId === account.id);
  }

  function requestDeleteGameComment(template: GameTemplate, comment: GameComment): void {
    if (!canDeleteGameComment(template, comment)) return;
    setCommentDeleteTarget({ template, comment });
  }

  function clearCommentPressTimer(): void {
    if (commentPressTimerRef.current) {
      clearTimeout(commentPressTimerRef.current);
      commentPressTimerRef.current = null;
    }
  }

  function handleCommentPointerDown(event: React.PointerEvent, template: GameTemplate, comment: GameComment): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    commentPressPosRef.current = { x: event.clientX, y: event.clientY };
    commentPressTriggeredRef.current = false;
    clearCommentPressTimer();
    commentPressTimerRef.current = setTimeout(() => {
      commentPressTriggeredRef.current = true;
      const point = commentPressPosRef.current ?? { x: event.clientX, y: event.clientY };
      const menuWidth = 168;
      const x = Math.min(Math.max(point.x, menuWidth / 2 + 12), window.innerWidth - menuWidth / 2 - 12);
      const y = Math.max(point.y - 16, 64);
      setCommentMenu({ template, comment, x, y });
      commentPressTimerRef.current = null;
    }, 480);
  }

  function handleCommentPointerMove(event: React.PointerEvent): void {
    const start = commentPressPosRef.current;
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10) {
      clearCommentPressTimer();
    }
  }

  function handleCommentPointerEnd(): void {
    commentPressPosRef.current = null;
    clearCommentPressTimer();
  }

  async function handleCopyGameComment(comment: GameComment): Promise<void> {
    setCommentMenu(null);
    try {
      await navigator.clipboard.writeText(comment.content);
      showNotice("success", "评论已复制");
    } catch {
      showNotice("error", "复制失败");
    }
  }

  async function confirmDeleteGameComment(): Promise<void> {
    const target = commentDeleteTarget;
    if (!target || deletingCommentIds[target.comment.id]) return;
    setDeletingCommentIds(current => ({ ...current, [target.comment.id]: true }));
    try {
      const result = await deleteGameComment({ commentId: target.comment.id });
      const deletedIds = result.deletedIds.length > 0 ? result.deletedIds : [target.comment.id];
      const deletedSet = new Set(deletedIds);
      setCommentsByGame(current => ({
        ...current,
        [target.template.id]: (current[target.template.id] ?? []).filter(comment => !deletedSet.has(comment.id)),
      }));
      setCommentReplyTargets(current => {
        const replyTarget = current[target.template.id];
        if (!replyTarget || !deletedSet.has(replyTarget.id)) return current;
        const next = { ...current };
        delete next[target.template.id];
        return next;
      });
      patchTemplateLocal(target.template.id, { commentCount: result.commentCount });
      setCommentDeleteTarget(null);
      showNotice("success", deletedIds.length > 1 ? "评论和回复已删除" : "评论已删除");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "评论删除失败");
    } finally {
      setDeletingCommentIds(current => {
        const next = { ...current };
        delete next[target.comment.id];
        return next;
      });
    }
  }

  async function handleBridgeRequest(action: string, payload: unknown): Promise<unknown> {
    if (!runtimeGame) throw new Error("游戏未启动。");
    const template = runtimeGame.templateSnapshot;
    const characters = loadCharacters();
    const characterById = new Map(characters.map(character => [character.id, character]));
    const assignments = runtimeAssignments;
    const map = assignmentMap(assignments);
    const ensureAdvancedAccess = () => {
      if (!template.allowExternalControl || !advancedAllowed) {
        throw new Error("该游戏未获得高级游戏权限，不能读取角色包、调用模型或写入游戏记忆。");
      }
    };

    if (action.startsWith("room.") || action.startsWith("cloud.")) {
      const namespace = `game:${template.id}`;

      if (action.startsWith("cloud.")) {
        const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const cloudAction = action.slice("cloud.".length);
        if (cloudAction === "report") {
          const reportId = String(record.id ?? "").trim();
          if (!reportId) throw new Error("cloud.report 缺少 id。");
          await submitContentReport({
            contentType: "online_doc",
            contentId: reportId,
            reason: String(record.reason ?? "").slice(0, 500),
          });
          return true;
        }
        if (!["put", "get", "list", "update", "delete", "takeRandom"].includes(cloudAction)) {
          throw new Error(`未知云端动作：${action}`);
        }
        const response = await onlineCloudApi({
          action: cloudAction,
          namespace,
          collection: record.collection,
          id: record.id,
          data: record.data,
          sortKey: record.sortKey,
          limit: record.limit,
          mine: record.mine,
          orderBy: record.orderBy,
        });
        if (cloudAction === "list") return response.docs;
        if (cloudAction === "delete") return { deleted: response.deleted === true };
        return response.doc ?? null;
      }

      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const publicRoomInfo = (connection: OnlineRoomConnection) => ({
        id: connection.info.id,
        code: connection.info.code,
        title: connection.info.title,
        maxPlayers: connection.info.maxPlayers,
        meta: connection.info.meta,
        hostUserId: connection.info.hostUserId,
        hostName: connection.info.hostName,
        isHost: connection.info.isHost,
        selfUserId: connection.selfUserId,
        selfName: connection.selfName,
        players: connection.players(),
      });
      const current = gameRoomRef.current && !gameRoomRef.current.isClosed ? gameRoomRef.current : null;

      if (action === "room.create" || action === "room.join") {
        if (current) {
          current.leave();
          gameRoomRef.current = null;
        }
        const events = {
          onMessage: (message: { from: { userId: string; name: string }; payload: unknown; sentAt: number }) => {
            postGameEvent("room.message", { from: message.from, payload: message.payload, sentAt: message.sentAt });
          },
          onPlayers: (players: unknown[]) => postGameEvent("room.players", { players }),
          onState: (roomState: Record<string, unknown>) => postGameEvent("room.state", { state: roomState }),
          onClosed: (reason: string) => {
            gameRoomRef.current = null;
            postGameEvent("room.closed", { reason });
          },
        };
        const connection = action === "room.create"
          ? await OnlineRoomConnection.create({
            namespace,
            title: typeof record.title === "string" ? record.title : template.title.slice(0, 80),
            maxPlayers: Number(record.maxPlayers ?? 8) || 8,
            meta: record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
              ? record.meta as Record<string, unknown>
              : {},
          }, events)
          : await OnlineRoomConnection.join({ namespace, code: String(record.code ?? "") }, events);
        gameRoomRef.current = connection;
        return publicRoomInfo(connection);
      }

      if (action === "room.current") {
        return current ? { ...publicRoomInfo(current), state: current.state() } : null;
      }
      if (action === "room.leave") {
        if (current) {
          current.leave();
          gameRoomRef.current = null;
        }
        return { ok: true };
      }
      if (!current) throw new Error("当前没有已连接的联机房间，请先 room.create 或 room.join。");
      if (action === "room.report") {
        await submitContentReport({
          contentType: "online_room",
          contentId: current.info.id,
          reason: String(record.reason ?? "").slice(0, 500),
        });
        return true;
      }
      if (action === "room.send") {
        await current.send(record.payload ?? null);
        return { ok: true };
      }
      if (action === "room.setState") {
        const roomState = record.state ?? record.data;
        if (!roomState || typeof roomState !== "object" || Array.isArray(roomState)) throw new Error("room.setState 需要对象 state。");
        await current.setState(roomState as Record<string, unknown>);
        return { ok: true };
      }
      if (action === "room.getState") return current.state();
      if (action === "room.players") return current.players();
      if (action === "room.kick") {
        await current.kick(String(record.userId ?? ""));
        return { ok: true };
      }
      if (action === "room.close") {
        await current.close();
        gameRoomRef.current = null;
        return { ok: true };
      }
      throw new Error(`未知联机动作：${action}`);
    }

    if (action === "listAvailableCharacters") {
      return characters.map(character => ({
        id: character.id,
        name: character.name,
        avatar: character.avatar || "",
        subtitle: character.personality?.split(/\n/)[0]?.slice(0, 42) || "",
      }));
    }

    if (action === "getRoleSlots") return template.roleSlots;

    if (action === "getPlayerProfile") {
      const identity = resolveUserIdentity(undefined, "game");
      return {
        name: identity?.name?.trim() || state.displayName || "玩家",
      };
    }

    if (action === "setTitleBar") {
      setRuntimeTitleBar(normalizeRuntimeTitleBarConfig(payload));
      return { ok: true };
    }

    if (action === "submitRoleAssignments") {
      const nextAssignments = normalizeAssignmentPayload(payload, template.roleSlots, characters);
      setRuntimeAssignments(nextAssignments);
      setRuntimeStage("game");
      if (!isPreviewGame(runtimeGame.localId)) {
        setState(saveGameRoleAssignments(runtimeGame.localId, nextAssignments));
        setState(markGamePlayed(runtimeGame.localId));
      }
      return { ok: true };
    }

    if (action === "cancelRoleSelection" || action === "closeGame") {
      closeRuntime();
      return { ok: true };
    }

    if (action === "getRolePackage") {
      ensureAdvancedAccess();
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const target = String(record.target || "");
      const mode: GameRolePackageMode = record.mode === "full" ? "full" : "light";
      const slotCharacters = map.get(target);
      let fromSlot = false;
      let ids: string[] = [];
      if (slotCharacters && slotCharacters.length > 0) {
        fromSlot = true;
        ids = slotCharacters;
      } else if (characters.some(character => character.id === target)) {
        ids = [target];
      }
      if (ids.length === 0) throw new Error(`没有找到角色槽位或角色：${target}`);
      const packages = await Promise.all(ids.map(characterId => buildGameRolePackage({
        characterId,
        slotId: fromSlot ? target : undefined,
        mode,
      })));
      return packages.length === 1 ? packages[0] : packages;
    }

    if (action === "callLLM") {
      ensureAdvancedAccess();
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const messages = parseBridgeMessages(record.messages);
      const requestedCharacterId = typeof record.characterId === "string" ? record.characterId : "";
      const fallbackCharacterId = requestedCharacterId
        || assignments.flatMap(item => item.characterIds)[0]
        || undefined;
      return await callGameLLM({ messages, characterId: fallbackCharacterId });
    }

    if (action === "callGlobalLLM") {
      ensureAdvancedAccess();
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const messages = parseBridgeMessages(record.messages);
      return await callGameLLM({ messages });
    }

    if (action === "recordGameEvent") {
      ensureAdvancedAccess();
      if (isPreviewGame(runtimeGame.localId)) {
        return { ok: true, recorded: 0, preview: true };
      }
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const summary = typeof record.summary === "string" ? record.summary.trim() : "";
      if (!summary) throw new Error("recordGameEvent 需要 summary。");
      const rawCharacterIds = Array.isArray(record.characterIds)
        ? record.characterIds
        : typeof record.characterId === "string"
          ? [record.characterId]
          : [];
      const characterIds = [...new Set(rawCharacterIds.map(id => String(id || "").trim()).filter(Boolean))];
      if (characterIds.length === 0) throw new Error("recordGameEvent 至少需要一个角色 ID。");
      const unknownIds = characterIds.filter(id => !characterById.has(id));
      if (unknownIds.length > 0) throw new Error(`recordGameEvent 找不到角色：${unknownIds.join(", ")}`);
      const playerIdentity = resolveUserIdentity(undefined, "game");
      const playerName = playerIdentity?.name?.trim() || state.displayName || "玩家";
      let nextState: GameState | null = null;
      let recorded = 0;
      for (const characterId of characterIds) {
        const character = characterById.get(characterId);
        if (!character) continue;
        const result = recordGameProjectionEvent({
          localGameId: runtimeGame.localId,
          remoteTemplateId: runtimeGame.remoteTemplateId,
          templateTitle: String(record.title || template.title || "未命名游戏"),
          characterId,
          characterName: character.name,
          playerName,
          summary,
        });
        nextState = result.state;
        if (result.entry) {
          recorded += 1;
          try {
            incrementEventCounter(characterId);
            maybeRunSummarization(characterId, character.name)
              .catch(err => console.warn("[GameHub] Summarization check failed:", err));
          } catch (err) {
            console.warn("[GameHub] Memory counter failed:", err);
          }
        }
      }
      if (nextState) setState(nextState);
      return { ok: true, recorded };
    }

    if (action === "saveGame") {
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      if (isPreviewGame(runtimeGame.localId)) {
        previewGameSaveRef.current = record.data ?? null;
        return { ok: true };
      }
      setState(saveGameSave(runtimeGame.localId, record.data ?? null));
      return { ok: true };
    }

    if (action === "loadGame") return isPreviewGame(runtimeGame.localId)
      ? previewGameSaveRef.current
      : loadGameSave(runtimeGame.localId);

    throw new Error(`未知游戏桥接动作：${action}`);
  }

  function openInstalledGameDetails(item: GameInstalledItem): void {
    const latestTemplate = catalog.find(template => template.id === item.remoteTemplateId);
    openTemplateDetails(latestTemplate ?? item.templateSnapshot);
  }

  function renderCollectionGame(item: GameInstalledItem, compact = false) {
    const template = item.templateSnapshot;
    const hasCover = Boolean(template.coverImage);
    return (
      <button
        key={item.localId}
        type="button"
        className={compact ? "game-collection-mini" : "game-recent-card"}
        onClick={() => openInstalledGameDetails(item)}
      >
        <div className={`${compact ? "game-collection-mini-cover" : "game-recent-cover"} ${hasCover ? "has-image" : ""}`}>
          {hasCover ? <img src={template.coverImage} alt="" /> : <ImageIcon size={compact ? 18 : 24} />}
        </div>
        <div>
          <strong>{template.title}</strong>
          <span>{compact ? `@${displayGameAuthorName(template.authorName)}` : `${item.playCount > 0 ? `玩过 ${item.playCount} 次` : "还没启动"}`}</span>
        </div>
      </button>
    );
  }

  function renderGameRecord(entry: GameProjectionEntry, index: number) {
    const item = state.installedGames.find(game => game.localId === entry.localGameId)
      ?? state.installedGames.find(game => game.remoteTemplateId === entry.remoteTemplateId);
    const template = item?.templateSnapshot;
    const title = template?.title || entry.templateTitle || "未命名游戏";
    const hasCover = Boolean(template?.coverImage);
    const menuOpen = recordMenuId === entry.id;
    return (
      <div key={entry.id} className={`game-play-record-card ${menuOpen ? "is-menu-open" : ""}`} style={{ animationDelay: `${index * 0.04}s` }}>
        <button
          type="button"
          className="game-play-record-main"
          onClick={() => {
            setRecordMenuId(null);
            if (item) {
              openInstalledGameDetails(item);
              return;
            }
            showNotice("info", "这个游戏已不在柜子里");
          }}
        >
          <div className={`game-play-record-cover ${hasCover ? "has-image" : ""}`}>
            {hasCover && template?.coverImage ? <img src={template.coverImage} alt="" /> : <FileText size={22} />}
          </div>
          <div className="game-play-record-copy">
            <strong>{title}</strong>
            <p>{entry.characterName} · {formatGameRelativeTime(entry.timestamp, relativeNow)}</p>
            <span>{entry.summary}</span>
          </div>
        </button>
        <div className="game-collection-menu game-play-record-menu">
          <button
            type="button"
            aria-label={`${title} 记录操作`}
            onClick={() => {
              setCollectionMenuId(null);
              setStudioMenuId(null);
              setRecordMenuId(menuOpen ? null : entry.id);
            }}
          >
            <MoreHorizontal size={17} />
          </button>
          {menuOpen ? (
            <div className="game-collection-menu-pop">
              <button
                type="button"
                className="is-danger"
                onClick={() => deleteGameRecord(entry.id)}
              >
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function renderLibraryCollection(collection: GameLibraryCollection, index: number) {
    const open = activeCollectionId === collection.id;
    const menuOpen = collectionMenuId === collection.id;
    const updatedText = collection.updatedAt ? `更新 ${formatGameDate(collection.updatedAt)}` : "还没有游戏";
    return (
      <div key={collection.id} className={`game-collection-item ${menuOpen ? "is-menu-open" : ""}`} style={{ animationDelay: `${index * 0.04}s` }}>
        <div className={`game-collection-folder ${open ? "is-open" : ""}`}>
          <button
            type="button"
            className="game-collection-folder-main"
            onClick={() => {
              setCollectionMenuId(null);
              if (collection.games.length === 0) {
                showNotice("info", "该柜子里没有游戏噢~");
                return;
              }
              setActiveCollectionId(open ? "" : collection.id);
            }}
          >
            <div
              className="game-collection-thumb"
              style={{ background: `linear-gradient(135deg, ${collection.colorA}, ${collection.colorB})` }}
            >
              <Folder size={24} fill="currentColor" fillOpacity={0.26} />
              <span>{collection.count}</span>
            </div>
            <div>
              <strong>{collection.name}</strong>
              <p>{collection.count} 个收藏 · {updatedText}</p>
            </div>
          </button>
          <div className="game-collection-menu">
            <button
              type="button"
              aria-label={`${collection.name} 操作`}
              onClick={() => setCollectionMenuId(menuOpen ? null : collection.id)}
            >
              <MoreHorizontal size={17} />
            </button>
            {menuOpen ? (
              <div className="game-collection-menu-pop">
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => requestDeleteCollectionFolder(collection)}
                >
                  删除
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {open && collection.games.length > 0 ? (
          <div className="game-collection-preview">
            {collection.games.slice(0, 3).map(item => renderCollectionGame(item, true))}
          </div>
        ) : null}
      </div>
    );
  }

  function collectionHasTemplate(collection: GameLibraryCollection, templateId: string): boolean {
    if (collection.id === DEFAULT_GAME_COLLECTION_ID) return installedTemplateIds.has(templateId);
    return state.collectionFolders.some(folder => folder.id === collection.id && folder.gameIds.includes(templateId));
  }

  function renderGameCard(template: GameTemplate, index = 0) {
    const hasCover = Boolean(template.coverImage);
    const authorName = displayGameAuthorName(template.authorName);
    const installed = installedTemplateIds.has(template.id);
    const displayTags = gameDisplayTags(template);
    return (
      <article key={template.id} className="game-discover-card">
        <button type="button" className="game-discover-main" onClick={() => openTemplateDetails(template)}>
          <div className={`game-discover-cover game-discover-cover--${index % 4} ${hasCover ? "has-image" : ""}`}>
            {hasCover ? (
              <img src={template.coverImage} alt="" />
            ) : (
              <ImageIcon className="game-discover-placeholder-icon" size={28} aria-hidden="true" />
            )}
            {displayTags[0] ? <span>{displayTags[0]}</span> : null}
          </div>
          <div className="game-discover-body">
            <strong>{template.title}</strong>
            <p>{gameDisplayDescription(template)}</p>
            <div className="game-discover-foot">
              <div>
                <span><Heart size={10} />{template.likeCount}</span>
                {GAME_HALL_COMMENTS_ENABLED ? <span><MessageCircle size={10} />{template.commentCount}</span> : null}
                <span><Archive size={10} />{template.favoriteCount}</span>
              </div>
              <em>@{authorName}</em>
            </div>
          </div>
        </button>
        <button
          type="button"
          className={`game-discover-favorite ${installed ? "is-installed" : ""}`}
          aria-label={installed ? "从收藏柜移除" : "加入小柜"}
          aria-pressed={installed}
          onClick={() => toggleTemplateLibrary(template)}
        >
          <Heart size={12} fill={installed ? "currentColor" : "none"} />
        </button>
      </article>
    );
  }

  function renderCollectionPickerModal(template: GameTemplate) {
    return (
      <div className="game-modal" role="presentation" onClick={closeCollectionPicker}>
        <section
          className="game-modal-card game-modal-card--collection-picker"
          role="dialog"
          aria-modal="true"
          aria-label="选择收藏分类"
          onClick={event => event.stopPropagation()}
        >
          <div className="game-modal-head">
            <div>
              <span>COLLECTION</span>
              <strong>加入哪个分类？</strong>
            </div>
            <button type="button" aria-label="关闭" onClick={closeCollectionPicker}>
              <X size={18} />
            </button>
          </div>
          <div className="game-collection-picker-list" aria-label="收藏分类列表">
            {libraryCollections.map(collection => {
              const included = collectionHasTemplate(collection, template.id);
              return (
                <button
                  key={collection.id}
                  type="button"
                  disabled={included}
                  onClick={() => void addTemplateToLibrary(template, collection.id)}
                >
                  <span style={{ background: `linear-gradient(135deg, ${collection.colorA}, ${collection.colorB})` }}>
                    <Folder size={17} fill="currentColor" fillOpacity={0.24} />
                  </span>
                  <div>
                    <strong>{collection.name}</strong>
                    <p>{included ? "已在此分类" : `${collection.count} 个收藏`}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  function handleStudioCardKeyDown(event: React.KeyboardEvent<HTMLElement>, action: () => void): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    action();
  }

  function renderPublishedStudioCard(template: GameTemplate, index: number) {
    const menuId = `published:${template.id}`;
    const menuOpen = studioMenuId === menuId;
    return (
      <article
        key={template.id}
        className={`game-studio-list-card game-studio-list-card--published ${menuOpen ? "is-menu-open" : ""}`}
        role="button"
        tabIndex={0}
        style={{ animationDelay: `${index * 0.06}s` }}
        onClick={() => void editPublished(template)}
        onKeyDown={event => handleStudioCardKeyDown(event, () => { void editPublished(template); })}
      >
        <div className="game-studio-list-icon">
          <Send size={18} strokeWidth={2.5} />
        </div>
        <div className="game-studio-list-copy">
          <div>
            <strong>{template.title}</strong>
            <span>已发布</span>
          </div>
          <time>{formatGameDate(template.updatedAt)}</time>
        </div>
        <div className="game-studio-card-menu">
          <button
            type="button"
            aria-label="打开操作菜单"
            onClick={event => {
              event.stopPropagation();
              setStudioMenuId(current => current === menuId ? null : menuId);
            }}
          >
            <MoreHorizontal size={17} />
          </button>
          {menuOpen ? (
            <div className="game-studio-card-menu-pop" onClick={event => event.stopPropagation()}>
              <button type="button" onClick={() => { setStudioMenuId(null); void editPublished(template); }}>编辑</button>
              <button type="button" onClick={() => { setStudioMenuId(null); openTemplateDetails(template); }}>查看详情</button>
              <button type="button" className="is-danger" onClick={() => { setStudioMenuId(null); void deletePublished(template); }}>删除</button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  function renderDraftStudioCard(item: GameHallDraft, index: number) {
    const menuId = `draft:${item.id}`;
    const menuOpen = studioMenuId === menuId;
    return (
      <article
        key={item.id}
        className={`game-studio-list-card game-studio-list-card--draft ${menuOpen ? "is-menu-open" : ""}`}
        role="button"
        tabIndex={0}
        style={{ animationDelay: `${index * 0.06}s` }}
        onClick={() => editDraft(item)}
        onKeyDown={event => handleStudioCardKeyDown(event, () => editDraft(item))}
      >
        <div className="game-studio-list-icon">
          <Pencil size={18} strokeWidth={2.5} />
        </div>
        <div className="game-studio-list-copy">
          <div>
            <strong>{item.title}</strong>
            <span>草稿</span>
          </div>
          <time>{formatGameDate(item.updatedAt)}</time>
        </div>
        <div className="game-studio-card-menu">
          <button
            type="button"
            aria-label="打开操作菜单"
            onClick={event => {
              event.stopPropagation();
              setStudioMenuId(current => current === menuId ? null : menuId);
            }}
          >
            <MoreHorizontal size={17} />
          </button>
          {menuOpen ? (
            <div className="game-studio-card-menu-pop" onClick={event => event.stopPropagation()}>
              <button type="button" onClick={() => { setStudioMenuId(null); editDraft(item); }}>编辑</button>
              <button type="button" className="is-danger" onClick={() => { setStudioMenuId(null); deleteDraft(item.id); }}>删除</button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  function renderGameCommentItem(template: GameTemplate, item: GameCommentDisplayItem) {
    const { comment, replyTargetName, visualDepth } = item;
    const replyToComment = () => {
      setCommentReplyTargets(current => ({ ...current, [template.id]: comment }));
      setExpandedCommentsGameId(template.id);
    };
    return (
      <div key={comment.id} className="game-comment-thread" data-depth={visualDepth}>
        <div className="game-comment">
          <div className="game-comment-avatar">
            {comment.authorAvatar ? <img src={comment.authorAvatar} alt="" /> : <span>{initials(comment.authorName)}</span>}
          </div>
          <div
            className="game-comment-body"
            role="button"
            tabIndex={0}
            aria-label={`回复 ${comment.authorName} 的评论`}
            onPointerDown={event => handleCommentPointerDown(event, template, comment)}
            onPointerMove={handleCommentPointerMove}
            onPointerUp={handleCommentPointerEnd}
            onPointerCancel={handleCommentPointerEnd}
            onClick={event => {
              if (commentPressTriggeredRef.current) {
                commentPressTriggeredRef.current = false;
                event.preventDefault();
                return;
              }
              replyToComment();
            }}
            onKeyDown={event => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              replyToComment();
            }}
          >
            <div className="game-comment-meta">
              <strong>{comment.authorName}</strong>
              {replyTargetName ? (
                <>
                  <span className="game-comment-reply-label">回复</span>
                  <strong className="game-comment-reply-target">{replyTargetName}</strong>
                </>
              ) : null}
            </div>
            <p>{comment.content}</p>
            <div className="game-comment-actions">
              <time dateTime={comment.createdAt}>{formatGameRelativeTime(comment.createdAt, relativeNow)}</time>
              <button
                type="button"
                className="game-comment-reply-btn"
                aria-label={`回复 ${comment.authorName}`}
                onClick={event => {
                  event.stopPropagation();
                  replyToComment();
                }}
              >
                回复
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderTemplateDetailPage(template: GameTemplate) {
    const comments = commentsByGame[template.id] ?? [];
    const commentItems = flattenGameCommentTree(comments);
    const installed = installedTemplateIds.has(template.id);
    const canComment = GAME_HALL_COMMENTS_ENABLED && template.source === "community";
    const commentsExpanded = expandedCommentsGameId === template.id;
    const authorName = displayGameAuthorName(template.authorName);
    const displayTags = gameDisplayTags(template);
    return (
      <section className="game-detail-page" aria-label="游戏详情">
        <article className="game-detail-card game-modal-card--detail">
          <div className="game-modal-author">
            <div className="game-avatar">
              {template.authorAvatar ? <img src={template.authorAvatar} alt="" /> : <span>{initials(authorName)}</span>}
            </div>
            <div>
              <strong>{authorName}</strong>
              <time dateTime={template.updatedAt}>{formatGameRelativeTime(template.updatedAt, relativeNow)}</time>
            </div>
          </div>
          <div className="game-modal-head">
            <div className="game-modal-head-top">
              <span>{GAME_DECORATIVE_CODE}</span>
            </div>
            <div className="game-modal-title-row">
              <strong>{template.title}</strong>
              <button type="button" className={`game-modal-title-action ${installed ? "is-primary" : ""}`} onClick={() => void handleTemplatePrimaryAction(template)}>
                {installed ? <><Play size={12} fill="currentColor" strokeWidth={2.4} />启动游戏</> : <><Plus size={12} strokeWidth={2.6} />加入小柜</>}
              </button>
            </div>
          </div>
          {gameDisplayDescription(template) ? <p className="game-modal-note">{gameDisplayDescription(template)}</p> : null}
          <div className={`game-modal-cover ${template.coverImage ? "has-image" : ""}`}>
            {template.coverImage ? <img src={template.coverImage} alt="" /> : <ImageIcon size={28} />}
          </div>
          {displayTags.length > 0 ? (
            <div className="game-modal-tags">
              {displayTags.map(tag => <span key={tag}>#{tag}</span>)}
            </div>
          ) : null}
          {template.source === "community" ? (
            <button
              type="button"
              className="game-detail-report-link"
              style={{ border: "none", background: "none", color: "var(--text-tertiary, #999)", fontSize: 11, alignSelf: "flex-end", padding: "2px 4px", cursor: "pointer" }}
              onClick={() => {
                void submitContentReport({
                  contentType: "game",
                  contentId: template.id,
                  preview: `${template.title} — ${gameDisplayDescription(template) || ""}`.slice(0, 200),
                  ownerId: template.authorId || "",
                  ownerName: template.authorName || "",
                })
                  .then(() => showNotice("success", "已举报，管理员会尽快处理"))
                  .catch(err => showNotice("error", err instanceof Error ? err.message : "举报失败"));
              }}
            >
              举报该游戏
            </button>
          ) : null}
          {GAME_HALL_COMMENTS_ENABLED ? (
            <div className={`game-comments game-comments--modal ${commentsExpanded ? "is-open" : ""}`}>
              <div className="game-modal-subhead">
                <strong>评论</strong>
                <button type="button" onClick={() => toggleTemplateComments(template)} disabled={!canComment}>
                  <span>{canComment ? `${template.commentCount} 条` : "内置游戏暂不支持评论"}</span>
                  {canComment ? <ChevronDown size={14} /> : null}
                </button>
              </div>
              {commentsExpanded ? (
                <>
                  {canComment && commentsLoadingId === template.id ? <div className="game-comments-empty">评论加载中…</div> : null}
                  {canComment && commentsLoadingId !== template.id && comments.length === 0 ? <div className="game-comments-empty">还没有评论。</div> : null}
                  {commentItems.map(item => renderGameCommentItem(template, item))}
                </>
              ) : null}
            </div>
          ) : null}
        </article>
      </section>
    );
  }

  function renderTemplateDetailBottomBar(template: GameTemplate) {
    const liked = Boolean(template.likedByMe || state.likedGameIds.includes(template.id));
    const installed = installedTemplateIds.has(template.id);
    const canComment = GAME_HALL_COMMENTS_ENABLED && template.source === "community";
    const commentsExpanded = expandedCommentsGameId === template.id;
    const replyTarget = commentReplyTargets[template.id];
    const submittingComment = Boolean(submittingCommentIds[template.id]);
    return (
      <div className="game-detail-bottom-bar">
        {GAME_HALL_COMMENTS_ENABLED ? (
          canComment ? (
            <div className="game-detail-bottom-input">
              {replyTarget ? (
                <button
                  type="button"
                  className="game-reply-target-pill"
                  aria-label="取消回复"
                  onClick={() => setCommentReplyTargets(current => {
                    const next = { ...current };
                    delete next[template.id];
                    return next;
                  })}
                >
                  <span>回复 @{replyTarget.authorName}</span>
                  <X size={12} strokeWidth={2.6} />
                </button>
              ) : null}
              <input
                value={commentDrafts[template.id] || ""}
                maxLength={300}
                placeholder={replyTarget ? `回复 @${replyTarget.authorName}...` : "写评论..."}
                onChange={event => setCommentDrafts(current => ({ ...current, [template.id]: event.target.value }))}
                onKeyDown={event => {
                  if (event.key === "Enter" && !submittingComment) void submitComment(template);
                }}
              />
              {(commentDrafts[template.id] || "").trim() ? (
                <button
                  type="button"
                  className={submittingComment ? "is-loading" : ""}
                  disabled={submittingComment}
                  aria-busy={submittingComment}
                  aria-label={submittingComment ? "评论发送中" : "发送评论"}
                  onClick={() => void submitComment(template)}
                >
                  {submittingComment ? <span className="game-comment-send-spinner" aria-hidden="true" /> : "发送"}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="game-detail-bottom-input is-disabled" aria-disabled="true">内置游戏暂不支持评论</div>
          )
        ) : null}
        <div className="game-detail-bottom-actions" aria-label="互动数据">
          <button type="button" className={liked ? "is-active" : ""} onClick={() => void toggleLike(template)} aria-label="点赞">
            <Heart size={21} strokeWidth={1.8} fill={liked ? "currentColor" : "none"} />
            <span>{template.likeCount}</span>
          </button>
          <button type="button" className={installed ? "is-active" : ""} onClick={() => toggleTemplateLibrary(template)} aria-pressed={installed} aria-label="收藏">
            <Archive size={21} strokeWidth={1.8} />
            <span>{template.favoriteCount}</span>
          </button>
          {GAME_HALL_COMMENTS_ENABLED ? (
            <button type="button" className={commentsExpanded ? "is-active" : ""} onClick={() => toggleTemplateComments(template)} disabled={!canComment} aria-label="评论">
              <MessageCircle size={21} strokeWidth={1.8} />
              <span>{template.commentCount}</span>
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const runtimeAllowExternal = Boolean(runtimeGame?.templateSnapshot.allowExternalControl && advancedAllowed);
  const headerTitle = selectedTemplate
    ? "游戏 · 游戏详情"
    : creatorPageOpen
    ? editingTemplate
      ? "游戏 · 编辑游戏"
      : editingDraftId
        ? "游戏 · 编辑草稿"
        : "游戏 · 开始一个故事"
    : mainView === "studio"
      ? "游戏 · 创作工坊"
      : mainView === "library"
        ? "游戏 · 我的"
        : "游戏 · 游戏大厅";
  const runtimeBackButtonStyle: CSSProperties = {
    background: runtimeTitleBar.buttonBackground,
    color: runtimeTitleBar.buttonColor,
    borderColor: runtimeTitleBar.buttonBorderColor,
    borderRadius: runtimeTitleBar.buttonRadius,
    boxShadow: runtimeTitleBar.buttonShadow,
    opacity: runtimeTitleBar.iconOpacity,
  };

  return (
    <div className="game-hub-root">
      <header className="game-hub-header">
        <button
          type="button"
          aria-label={selectedTemplate ? "返回上一页" : creatorPageOpen ? "返回创作工坊" : "返回桌面"}
          onClick={selectedTemplate ? closeTemplateDetails : creatorPageOpen ? closeCreatorPage : onClose}
        >
          <ChevronLeft size={22} strokeWidth={2.5} />
        </button>
        <div>
          <strong>{headerTitle}</strong>
        </div>
        {creatorPageOpen ? (
          <span className="game-header-spacer" aria-hidden="true" />
        ) : (
          <button
            type="button"
            className={communityLoading ? "is-spinning" : ""}
            aria-label={selectedTemplate ? "刷新游戏详情" : "刷新游戏大厅"}
            onClick={() => void loadCommunityGames(true)}
            disabled={communityLoading}
          >
            <RefreshCw size={21} strokeWidth={2.3} />
          </button>
        )}
      </header>

      <main className={`game-hub-scroll ${creatorPageOpen || selectedTemplate ? "game-hub-scroll--page" : ""} ${selectedTemplate ? "game-hub-scroll--detail" : ""}`}>
        {communityError ? <div className="game-error">{communityError}</div> : null}

        {selectedTemplate ? renderTemplateDetailPage(selectedTemplate) : null}

        {!selectedTemplate && !creatorPageOpen && mainView === "hall" ? (
          <section className="game-hero game-hero--hall">
            <div className="game-search">
              <input
                value={hallSearch}
                placeholder="搜索游戏、作者或标签"
                onChange={event => setHallSearch(event.target.value)}
              />
              <button type="button" aria-label="搜索游戏" onClick={() => void loadCommunityGames(true)}>
                <Search size={16} />
              </button>
            </div>
            <div
              className="game-category-row"
              aria-label="游戏分类"
              data-active-index={Math.max(0, GAME_CATEGORY_FILTERS.indexOf(hallCategory))}
            >
              {GAME_CATEGORY_FILTERS.map(category => (
                <button
                  key={category}
                  type="button"
                  className={hallCategory === category ? "is-active" : ""}
                  onClick={() => setHallCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {!selectedTemplate && mainView === "hall" ? (
          <section className="game-grid">
            <div className="game-section-head">
              <Gamepad2 size={16} />
              <span>今日推荐</span>
              <b>{filteredCatalog.length}</b>
            </div>
            {filteredCatalog.length === 0 ? (
              <div className="game-empty">游戏大厅暂时空空哒～</div>
            ) : filteredCatalog.map((template, index) => renderGameCard(template, index))}
          </section>
        ) : null}

        {!selectedTemplate && mainView === "library" ? (
          <section className="game-list">
            <div className="game-library-head">
              <h2>我的柜子</h2>
              <button
                type="button"
                className="game-soft-pill-button"
                onClick={() => {
                  setNewCollectionName("");
                  setNewCollectionOpen(true);
                }}
              >
                <Plus size={13} />
                新建分类
              </button>
            </div>
            <div className="game-collection-list" aria-label="收藏夹列表">
              {libraryCollections.map(renderLibraryCollection)}
            </div>
            <div className="game-recent-played">
              <div className="game-recent-head">
                <h2><Clock size={14} />最近玩过</h2>
                <span>{recentPlayedGames.length} 个</span>
              </div>
              {recentPlayedGames.length === 0 ? (
                <div className="game-empty">还没有启动过收藏柜里的游戏。</div>
              ) : (
                <div className="game-recent-row">
                  {recentPlayedGames.slice(0, 8).map(item => renderCollectionGame(item))}
                </div>
              )}
            </div>
            <div className="game-play-records">
              <div className="game-recent-head">
                <h2><FileText size={14} />最近记录</h2>
                <span>{recentGameEvents.length} 条</span>
              </div>
              {recentGameEvents.length === 0 ? (
                <div className="game-empty">还没有小游戏回传记录</div>
              ) : (
                <div className="game-play-record-list" aria-label="最近游戏记录">
                  {recentGameEvents.map(renderGameRecord)}
                </div>
              )}
            </div>
          </section>
        ) : null}

        {!selectedTemplate && mainView === "studio" ? (
          <section className="game-studio">
            {!creatorPageOpen ? (
              <>
              <section className="game-workshop-profilebar" aria-label="创作工坊资料">
                <div className="game-workshop-profile-avatar">
                  {state.avatarUrl ? <img src={state.avatarUrl} alt="" /> : <span>{initials(state.displayName)}</span>}
                </div>
                <div className="game-workshop-profile-main">
                  <div className="game-workshop-profile-top">
                    <strong>{state.displayName}</strong>
                    <button type="button" className="game-soft-pill-button game-profile-edit-pill" onClick={openProfileEditor}>
                      <Pencil size={13} />
                      编辑资料
                    </button>
                  </div>
                  <div className="game-workshop-profile-stats" aria-label="创作数据">
                    <span>草稿 <b>{drafts.length}</b></span>
                    <i aria-hidden="true" />
                    <span>已发布 <b>{publishedGames.length}</b></span>
                    <i aria-hidden="true" />
                    <span>收藏 <b>{publishedFavoriteTotal}</b></span>
                  </div>
                </div>
              </section>

              <div className="game-studio-tabs" role="tablist" aria-label="游戏发布管理" data-active-index={studioMode === "drafts" ? 0 : 1}>
                <button type="button" className={studioMode === "drafts" ? "is-active" : ""} onClick={() => setStudioMode("drafts")}>草稿箱</button>
                <button type="button" className={studioMode === "published" ? "is-active" : ""} onClick={() => setStudioMode("published")}>已发布</button>
              </div>

              {studioMode === "published" ? (
                publishedGames.length === 0 ? (
                  <div className="game-empty">还没有发布过游戏。</div>
                ) : (
                  <div className="game-published-list">
                    {publishedGames.map(renderPublishedStudioCard)}
                  </div>
                )
              ) : null}

              {studioMode === "drafts" ? (
                drafts.length === 0 ? (
                  <div className="game-empty">还没有保存过草稿。</div>
                ) : (
                  <div className="game-published-list">
                    {drafts.map(renderDraftStudioCard)}
                  </div>
                )
              ) : null}
              </>
            ) : null}

            {creatorPageOpen ? (
              <>
                {editingTemplate ? (
                  <div className="game-editing-banner">
                    <span>MODIFYING</span>
                    <strong>{editingTemplate.title}</strong>
                    <button type="button" onClick={closeCreatorPage}>取消修改</button>
                  </div>
                ) : null}
                {editingDraftId && !editingTemplate ? (
                  <div className="game-drafting-title">
                    <span>DRAFTING</span>
                    <strong>{draft.title.trim() || drafts.find(item => item.id === editingDraftId)?.title || "未命名草稿"}</strong>
                  </div>
                ) : null}
                <div className="game-studio-panel">
                  <h3>制作说明</h3>
                  <p className="game-studio-hint">查看说明全文，把它和你的游戏想法一起交给创作助手。生成一份完整 HTML 后，上传或粘贴到下方即可发布。</p>
                  <div className="game-studio-actions">
                    <button type="button" className="game-soft-wide-button" onClick={() => setCreatorGuideOpen(open => !open)}>
                      <FileText size={14} />
                      {creatorGuideOpen ? "收起制作说明" : "查看制作说明"}
                    </button>
                  </div>
                  {creatorGuideOpen ? (
                    <div className="game-guide-box">
                      <textarea className="game-guide-text" value={GAME_CREATOR_GUIDE_MD} rows={16} readOnly spellCheck={false} />
                      <div className="game-studio-actions game-guide-actions">
                        <button type="button" className="game-soft-wide-button" onClick={() => void copyCreatorGuide()}><Copy size={14} /> 复制全文</button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="game-studio-panel">
                  <h3>游戏档案</h3>
                  <label>游戏标题<input value={draft.title} onChange={event => updateDraft("title", event.target.value)} /></label>
                  <div className="game-meta-row">
                    <label className="game-play-note-field">食用须知<textarea value={draft.playNote} rows={6} placeholder="像发帖一样写给玩家看的说明、推荐玩法、注意事项。它会显示在列表卡片和游戏详情里。" onChange={event => updateDraft("playNote", event.target.value)} /></label>
                    <div className="game-cover-field">
                      <span>游戏封面</span>
                      <div className={`game-cover-frame ${draft.coverImage ? "has-image" : ""}`}>
                        <div className="game-cover-preview-window">
                          {draft.coverImage ? (
                            <img src={draft.coverImage} alt="" />
                          ) : (
                            <button
                              type="button"
                              className="game-cover-upload"
                              onClick={() => coverFileInputRef.current?.click()}
                            >
                              <Upload size={14} />
                              上传封面
                            </button>
                          )}
                        </div>
                        {draft.coverImage ? (
                          <button
                            type="button"
                            className="game-cover-remove"
                            aria-label="删除游戏封面"
                            onClick={() => setCoverDeleteConfirmOpen(true)}
                          >
                            <X size={15} strokeWidth={3} />
                          </button>
                        ) : null}
                      </div>
                      <input
                        ref={coverFileInputRef}
                        className="game-file-input"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        aria-label="上传游戏封面"
                        onChange={event => {
                          const file = event.currentTarget.files?.[0] ?? null;
                          event.currentTarget.value = "";
                          void uploadCoverFile(file);
                        }}
                      />
                    </div>
                  </div>
                  <div className="game-tag-picker" role="group" aria-label="游戏标签">
                    <span>标签</span>
                    <div>
                      {GAME_ALLOWED_TAGS.map(tag => {
                        const active = parseAllowedGameTags(draft.tagsText).includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            className={active ? "is-active" : ""}
                            aria-pressed={active}
                            onClick={() => toggleDraftTag(tag)}
                          >
                            #{tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="game-studio-panel">
                  <h3>单文件 HTML</h3>
                  <p className="game-studio-hint">可以直接上传完整 HTML，也可以手动粘贴。</p>
                  <input
                    ref={htmlFileInputRef}
                    className="game-file-input"
                    type="file"
                    accept=".html,.htm,text/html"
                    aria-label="上传 HTML 文件"
                    onChange={event => {
                      const file = event.currentTarget.files?.[0] ?? null;
                      event.currentTarget.value = "";
                      void uploadGameHtmlFile(file);
                    }}
                  />
                  <div className="game-html-import">
                    <button type="button" className="game-soft-wide-button" onClick={() => htmlFileInputRef.current?.click()}><Upload size={14} /> 上传 HTML</button>
                  </div>
                  <textarea value={draft.gameHtml} rows={18} spellCheck={false} onChange={event => updateDraft("gameHtml", event.target.value)} />
                </div>
                <div className="game-studio-panel game-anonymous-section">
                  <h3>匿名发布</h3>
                  <label className="game-studio-check game-studio-switch game-anonymous-publish">
                    <input
                      type="checkbox"
                      checked={publishAnonymously}
                      onChange={event => setPublishAnonymously(event.target.checked)}
                    />
                    <span>
                      <strong>匿名发布</strong>
                      <em>勾选后，本次发布会显示为匿名，不使用创作工坊设置的昵称和头像。</em>
                    </span>
                  </label>
                </div>
                <div className="game-studio-panel">
                  <h3>高级游戏权限</h3>
                  <label className="game-studio-check game-studio-switch game-advanced-permission-switch">
                    <input type="checkbox" checked={draft.allowExternalControl} onChange={event => updateDraft("allowExternalControl", event.target.checked)} />
                    <span>
                      <strong>启用高级游戏权限</strong>
                      <em>如果 HTML 需要读取角色包、调用模型或写入游戏记忆，请开启。接收方每次启动前都会看到风险确认。</em>
                    </span>
                  </label>
                </div>
                <div className="game-studio-panel game-publish-actions-panel">
                  <div className="game-studio-actions">
                    <button type="button" onClick={previewDraft}><Play size={14} /> 试玩</button>
                    <button type="button" onClick={saveDraft}><Archive size={14} /> 存草稿</button>
                    <button type="button" className="is-primary" disabled={publishing} onClick={() => void publishDraft()}>
                      <Send size={14} />
                      {publishing ? "同步中" : editingTemplate ? "保存修改" : "发布共享"}
                    </button>
                  </div>
                </div>
                {/* 角色槽位属于旧的模板级选人通路（现行做法是游戏 HTML 内自行选人），
                    入口不再对新草稿开放；仅在编辑已带槽位的存量作品时显示以保持兼容。 */}
                {parseGameRoleSlots(draft.roleSlotsText).length > 0 ? (
                  <details className="game-advanced-details" open={advancedStudioOpen} onToggle={event => setAdvancedStudioOpen(event.currentTarget.open)}>
                    <summary>高级设置：角色槽位与独立选择页（旧版兼容）</summary>
                    <div className="game-studio-panel">
                      <h3>角色槽位 JSON</h3>
                      <p className="game-studio-hint">该作品使用了旧版角色槽位机制，此处保留编辑能力。清空为 [] 后将改为游戏内自行选人。</p>
                      <textarea value={draft.roleSlotsText} rows={10} spellCheck={false} onChange={event => updateDraft("roleSlotsText", event.target.value)} />
                    </div>
                    <div className="game-studio-panel">
                      <h3>独立角色选择 HTML</h3>
                      <p className="game-studio-hint">只有上方角色槽位不为空时才会使用。</p>
                      <textarea value={draft.pickerHtml} rows={12} spellCheck={false} onChange={event => updateDraft("pickerHtml", event.target.value)} />
                    </div>
                  </details>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
      </main>

      {!selectedTemplate && !creatorPageOpen && mainView === "studio" ? (
        <button type="button" className="game-studio-fab" aria-label="新建游戏" onClick={openCreatorPage}>
          <Plus size={26} strokeWidth={2.6} />
        </button>
      ) : null}

      {!selectedTemplate && !creatorPageOpen ? (
        <nav className="game-bottom-nav" aria-label="游戏导航">
          <div className="game-bottom-tabs" data-active-index={Math.max(0, GAME_MAIN_TABS.findIndex(tab => tab.id === mainView))}>
            {GAME_MAIN_TABS.map(tab => {
              const Icon = tab.icon;
              const active = mainView === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={active ? "is-active" : ""}
                  onClick={() => setMainView(tab.id)}
                >
                  <Icon size={20} strokeWidth={active ? 2.6 : 2.2} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      ) : null}

      {selectedTemplate ? renderTemplateDetailBottomBar(selectedTemplate) : null}

      {notice ? (
        <div key={notice.id} className={`game-toast game-toast--${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}

      {collectionPickerTemplate ? renderCollectionPickerModal(collectionPickerTemplate) : null}

      {profileEditorOpen ? (
        <div className="game-modal" role="presentation" onClick={closeProfileEditor}>
          <section
            className="game-modal-card game-modal-card--profile-editor"
            role="dialog"
            aria-modal="true"
            aria-label="编辑资料"
            onClick={event => event.stopPropagation()}
          >
            <div className="game-modal-head">
              <div>
                <span>PROFILE</span>
              </div>
              <button type="button" aria-label="关闭" disabled={profileSaving} onClick={closeProfileEditor}>
                <X size={18} />
              </button>
            </div>
            <div className="game-profile-editor">
              <input
                ref={avatarFileInputRef}
                className="game-file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="上传头像"
                onChange={event => {
                  const file = event.currentTarget.files?.[0] ?? null;
                  event.currentTarget.value = "";
                  void uploadProfileEditorAvatar(file);
                }}
              />
              <button
                type="button"
                className={`game-profile-editor-avatar ${profileDraftAvatar ? "has-image" : ""}`}
                onClick={() => avatarFileInputRef.current?.click()}
              >
                {profileDraftAvatar ? <img src={profileDraftAvatar} alt="" /> : <span>{initials(profileDraftName || state.displayName)}</span>}
                <em>上传头像</em>
              </button>
              <label>
                <span>昵称</span>
                <input
                  value={profileDraftName}
                  maxLength={40}
                  placeholder="输入游戏大厅昵称"
                  onChange={event => setProfileDraftName(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter") void saveProfileEditor();
                  }}
                />
              </label>
            </div>
            <div className="game-modal-actions">
              <button type="button" disabled={profileSaving} onClick={closeProfileEditor}>取消</button>
              <button type="button" className="is-primary" disabled={profileSaving} onClick={() => void saveProfileEditor()}>
                {profileSaving ? "保存中" : "保存"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {coverDeleteConfirmOpen ? (
        <div
          className="game-modal"
          role="presentation"
          onClick={() => setCoverDeleteConfirmOpen(false)}
        >
          <section
            className="game-modal-card game-modal-card--cover-delete"
            role="dialog"
            aria-modal="true"
            aria-label="删除游戏封面"
            onClick={event => event.stopPropagation()}
          >
            <div className="game-modal-head">
              <div>
                <span>DELETE</span>
                <strong>是否删除该图片</strong>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setCoverDeleteConfirmOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <p className="game-delete-copy">删除后会恢复为默认封面展示。</p>
            <div className="game-modal-actions">
              <button type="button" onClick={() => setCoverDeleteConfirmOpen(false)}>取消</button>
              <button type="button" className="is-danger" onClick={confirmDeleteCoverImage}>确认删除</button>
            </div>
          </section>
        </div>
      ) : null}

      {commentMenu ? (
        <div
          className="game-comment-menu-overlay"
          role="presentation"
          onPointerDown={() => setCommentMenu(null)}
        >
          <div
            className="game-comment-menu"
            role="menu"
            style={{ left: commentMenu.x, top: commentMenu.y }}
            onPointerDown={event => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="game-comment-menu-btn"
              onClick={() => void handleCopyGameComment(commentMenu.comment)}
            >
              复制
            </button>
            {canDeleteGameComment(commentMenu.template, commentMenu.comment) ? (
              <button
                type="button"
                role="menuitem"
                className="game-comment-menu-btn is-danger"
                onClick={() => {
                  const { template, comment } = commentMenu;
                  setCommentMenu(null);
                  requestDeleteGameComment(template, comment);
                }}
              >
                删除
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="game-comment-menu-btn"
              onClick={() => {
                const { comment } = commentMenu;
                setCommentMenu(null);
                void submitContentReport({
                  contentType: "game_comment",
                  contentId: comment.id,
                  preview: comment.content.slice(0, 200),
                  ownerId: comment.authorId || "",
                  ownerName: comment.authorName || "",
                })
                  .then(() => showNotice("success", "已举报，管理员会尽快处理"))
                  .catch(err => showNotice("error", err instanceof Error ? err.message : "举报失败"));
              }}
            >
              举报
            </button>
          </div>
        </div>
      ) : null}

      {commentDeleteTarget ? (
        <div
          className="game-modal"
          role="presentation"
          onClick={() => setCommentDeleteTarget(null)}
        >
          <section
            className="game-modal-card game-modal-card--comment-delete"
            role="dialog"
            aria-modal="true"
            aria-label="删除评论"
            onClick={event => event.stopPropagation()}
          >
            <div className="game-modal-head">
              <div>
                <span>DELETE</span>
                <strong>删除这条评论？</strong>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setCommentDeleteTarget(null)}>
                <X size={18} />
              </button>
            </div>
            <p className="game-delete-copy">
              删除后不会再显示在这个游戏下面。
              {(commentsByGame[commentDeleteTarget.template.id] ?? []).some(item => item.parentId === commentDeleteTarget.comment.id)
                ? " 这条评论下的回复也会一起删除。"
                : ""}
            </p>
            <div className="game-modal-actions">
              <button type="button" onClick={() => setCommentDeleteTarget(null)}>取消</button>
              <button
                type="button"
                className="is-danger"
                disabled={Boolean(deletingCommentIds[commentDeleteTarget.comment.id])}
                onClick={() => void confirmDeleteGameComment()}
              >
                {deletingCommentIds[commentDeleteTarget.comment.id] ? "删除中" : "确认删除"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteCollectionTarget ? (
        <div
          className="game-modal"
          role="presentation"
          onClick={() => setDeleteCollectionTarget(null)}
        >
          <section
            className="game-modal-card game-modal-card--delete-collection"
            role="dialog"
            aria-modal="true"
            aria-label="删除收藏夹分类"
            onClick={event => event.stopPropagation()}
          >
            <div className="game-modal-head">
              <div>
                <span>DELETE</span>
                <strong>删除收藏夹分类？</strong>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setDeleteCollectionTarget(null)}>
                <X size={18} />
              </button>
            </div>
            <p className="game-delete-copy">
              是否删除“{deleteCollectionTarget.name}”收藏夹分类及里面的游戏？
              {deleteCollectionTarget.games.length > 0 ? ` 确定后会一并从收藏柜中删除 ${deleteCollectionTarget.games.length} 个游戏。` : ""}
            </p>
            <div className="game-modal-actions">
              <button type="button" onClick={() => setDeleteCollectionTarget(null)}>取消</button>
              <button type="button" className="is-danger" onClick={confirmDeleteCollectionFolder}>确定删除</button>
            </div>
          </section>
        </div>
      ) : null}

      {collectionDeleteBlockedOpen ? (
        <div
          className="game-modal"
          role="presentation"
          onClick={() => setCollectionDeleteBlockedOpen(false)}
        >
          <section
            className="game-modal-card game-modal-card--delete-collection"
            role="dialog"
            aria-modal="true"
            aria-label="不能删除收藏夹分类"
            onClick={event => event.stopPropagation()}
          >
            <div className="game-modal-head">
              <div>
                <span>NOTICE</span>
                <strong>不能删除这个柜子</strong>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setCollectionDeleteBlockedOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <p className="game-delete-copy">这个柜子不能删除，因为只剩下一个柜子了噢~</p>
            <div className="game-modal-actions">
              <button type="button" className="is-primary" onClick={() => setCollectionDeleteBlockedOpen(false)}>我知道了</button>
            </div>
          </section>
        </div>
      ) : null}

      {newCollectionOpen ? (
        <div
          className="game-modal"
          role="presentation"
          onClick={() => {
            setNewCollectionOpen(false);
            setNewCollectionName("");
          }}
        >
          <section
            className="game-modal-card game-modal-card--collection"
            role="dialog"
            aria-modal="true"
            aria-label="新建柜子"
            onClick={event => event.stopPropagation()}
          >
            <div className="game-modal-head">
              <div>
                <span>NEW COLLECTION</span>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setNewCollectionOpen(false);
                  setNewCollectionName("");
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="game-collection-create">
              <label>
                <span>柜子名称</span>
                <input
                  value={newCollectionName}
                  maxLength={40}
                  placeholder="比如：约会小游戏"
                  onChange={event => setNewCollectionName(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter") createCollectionFolder();
                  }}
                />
              </label>
              <p>创建后会出现在柜子列表里，之后可以把喜欢的游戏整理进去。</p>
            </div>
            <div className="game-modal-actions">
              <button
                type="button"
                onClick={() => {
                  setNewCollectionOpen(false);
                  setNewCollectionName("");
                }}
              >
                取消
              </button>
              <button type="button" className="is-primary" onClick={createCollectionFolder}>创建柜子</button>
            </div>
          </section>
        </div>
      ) : null}

      {runtimeGame && runtimeStage ? (
        <div className="game-runtime-layer">
          <section className={`game-runtime-card game-runtime-card--${runtimeStage}`}>
            {runtimeStage === "permission" ? (
              <div className="game-runtime-permission-top">
                <button type="button" aria-label="返回" onClick={closeRuntime}>
                  <ChevronLeft size={22} strokeWidth={2.5} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="game-runtime-floating-back"
                aria-label="返回"
                onClick={closeRuntime}
                style={runtimeBackButtonStyle}
              >
                <ChevronLeft size={22} strokeWidth={2.5} />
              </button>
            )}

            {runtimeStage === "permission" ? (
              <div className="game-permission">
                <ShieldAlert size={34} />
                <h2>高级游戏权限确认</h2>
                <p>该游戏使用高级游戏权限，可能控制当前页面显示、播放音频、访问本地页面数据、读取你选择角色的提示词包，并把关键游戏结果写入角色记忆。请仅运行可信作者的游戏。</p>
                <span>本次授权只对当前打开的游戏生效；关闭后再次打开仍会重新询问。</span>
                <div className="game-permission-actions">
                  <button type="button" onClick={closeRuntime}>取消</button>
                  <button type="button" className="is-primary" onClick={confirmAdvancedPermission}>允许并继续</button>
                </div>
              </div>
            ) : null}

            {runtimeStage === "picker" ? (
              <GameIframe
                key={`${runtimeGame.localId}-picker-${advancedAllowed ? "advanced" : "safe"}`}
                title={`${runtimeGame.templateSnapshot.title} 角色选择`}
                html={runtimeGame.templateSnapshot.pickerHtml}
                allowExternalControl={runtimeAllowExternal}
                onBridgeRequest={handleBridgeRequest}
              />
            ) : null}

            {runtimeStage === "game" ? (
              <GameIframe
                key={`${runtimeGame.localId}-game-${advancedAllowed ? "advanced" : "safe"}`}
                title={`${runtimeGame.templateSnapshot.title} 游戏`}
                html={runtimeGame.templateSnapshot.gameHtml}
                allowExternalControl={runtimeAllowExternal}
                onBridgeRequest={handleBridgeRequest}
                registerEventSender={registerGameEventSender}
              />
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
