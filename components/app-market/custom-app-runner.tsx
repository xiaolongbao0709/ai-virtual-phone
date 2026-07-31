"use client";

import { useCallback, useMemo, useRef, useState, useEffect, useLayoutEffect } from "react";
import { CheckCircle2, Circle, FileJson, Layers, LoaderCircle, MoreHorizontal, RefreshCw, Sparkles, Trash2, X } from "lucide-react";

import type { InstalledCustomApp } from "@/lib/custom-app-types";
import {
  readCustomAppCollection,
  uninstallCustomAppAsync,
  writeCustomAppCollection,
} from "@/lib/custom-app-storage";
import { formatCustomAppRegistrationRemovalSummary, removeCustomAppRegistrationsAsync } from "@/lib/custom-app-registration";
import { permissionLabelWithContext } from "@/lib/custom-app-permission-labels";
import { registerCustomAppToolExecutor, type CustomAppToolExecutorPayload } from "@/lib/custom-app-tool-runtime";
import { updateInstalledCustomAppFromMarket } from "@/lib/custom-app-market-update";
import { loadCharacters } from "@/lib/character-storage";
import { OnlineRoomConnection, onlineCloudApi } from "@/lib/online-room-client";
import { submitContentReport } from "@/lib/moderation-client";
import { hydrateKvDb } from "@/lib/kv-db";
import { ensureSettingsStorageHydrated } from "@/lib/settings-storage";
import {
  addChatContact,
  CHAT_MESSAGE_PUSHED_EVENT,
  createOrGetSession,
  hydrateChatStorage,
  loadChatContacts,
  loadChatSessions,
  type ChatMessage,
} from "@/lib/chat-storage";
import { deleteMediaRef, isMediaStoreRef, loadMediaBlob, storeMediaBase64 } from "@/lib/media-cache-storage";
import {
  addCustomAppMemory,
  addCustomAppTimelineEvent,
  activateCustomAppWorld,
  cancelCustomAppTask,
  cloneCustomAppVoice,
  createCustomAppNotification,
  deleteCustomAppTimelineEvent,
  fetchCustomAppNetwork,
  generateCustomAppGroupText,
  generateCustomAppImage,
  generateCustomAppText,
  isCustomAppGroupGenerateRecord,
  getCustomAppBadge,
  getWalletSnapshot,
  incrementCustomAppBadge,
  loadCustomAppNotifications,
  loadCustomAppTasks,
  markCustomAppNotificationsRead,
  payCustomAppWallet,
  readCustomAppCalendar,
  readCustomAppChatHistory,
  readCustomAppCharacterRelations,
  readCustomAppCharacterState,
  readCustomAppCoreMemory,
  readCustomAppLongTermMemory,
  readCustomAppShortTermMemory,
  readCustomAppUserPersona,
  readCustomAppUserPreferences,
  readCustomAppUserProfile,
  readCustomAppVoiceProfiles,
  readCustomAppWorld,
  recognizeCustomAppSpeech,
  recordCustomAppSpeech,
  stopCustomAppRecording,
  requestCustomAppReply,
  runCustomAppAiChat,
  runCustomAppAiClassify,
  runCustomAppAiEmbed,
  searchCustomAppMemory,
  sendCustomAppTextMessage,
  scheduleCustomAppTask,
  sendCustomAppCard,
  saveCustomAppMedia,
  setCustomAppBadge,
  setCustomAppChatContactState,
  suggestCustomAppMemory,
  synthesizeCustomAppSpeech,
  updateCustomAppCard,
  writeCustomAppCalendar,
  writeCustomAppHistoryMessage,
  writeCustomAppCharacterState,
  writeCustomAppWorld,
} from "@/lib/custom-app-host-api";

type CustomAppRunnerProps = {
  app: InstalledCustomApp;
  onClose: () => void;
  onNotice?: (message: string) => void;
  launchContext?: Record<string, unknown> | null;
  embedded?: boolean;
  backgroundEvent?: {
    runId: string;
    eventName: string;
    payload: Record<string, unknown>;
    timeoutMs?: number;
  };
  onBackgroundEventComplete?: (runId: string, result: { ok: boolean; reason: string; errors?: string[] }) => void;
  backgroundTool?: {
    runId: string;
    payload: CustomAppToolExecutorPayload;
    timeoutMs?: number;
  };
  onBackgroundToolComplete?: (runId: string, result: { ok: boolean; reason: string; result?: unknown; error?: string }) => void;
};

type BridgeResult = unknown;

const EMPTY_CUSTOM_APP_SRC_DOC = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";
const CUSTOM_APP_BACKGROUND_RUNNER_TIMEOUT_MS = 5 * 60_000;

function normalizeAssetRef(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "");
}

function rewriteAssetRefs(html: string, app: InstalledCustomApp): string {
  let next = html;
  for (const asset of Object.values(app.assets)) {
    const escapedPath = asset.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dataUrl = asset.dataUrl.replace(/"/g, "&quot;");
    next = next.replace(new RegExp(`(src|href)=["'](?:\\./|/)?${escapedPath}["']`, "g"), `$1="${dataUrl}"`);
    next = next.replace(new RegExp(`url\\((["']?)(?:\\./|/)?${escapedPath}\\1\\)`, "g"), `url("${dataUrl}")`);
  }
  return next;
}

function createCustomAppSrcDoc(app: InstalledCustomApp, frameId: string, launchContext?: Record<string, unknown> | null, embedded = false): string {
  const body = rewriteAssetRefs(app.entryHtml.trim(), app);
  const base = /<html[\s>]/i.test(body)
    ? body
    : `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>${app.name}</title>
</head>
<body>
${body}
</body>
</html>`;

  const bridge = `<style id="ai-phone-app-host-style">
:root {
  --ai-phone-app-safe-top: ${embedded ? "0px" : "88px"};
  --ai-phone-app-safe-bottom: ${embedded ? "0px" : "24px"};
  --ai-phone-app-safe-left: ${embedded ? "0px" : "16px"};
  --ai-phone-app-safe-right: ${embedded ? "0px" : "16px"};
}
html, body { min-height: 100%; }
* { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
</style>
<script>
(function(){
  var frameId = ${JSON.stringify(frameId)};
  var appId = ${JSON.stringify(app.id)};
  var launchContext = ${JSON.stringify(launchContext ?? null)};
  var pending = {};
  var eventHandlers = {};
  var toolHandlers = {};
  var seq = 0;
  function request(action, payload){
    var requestId = frameId + '_' + (++seq);
    parent.postMessage({ source:'ai-phone-custom-app-frame', type:'request', frameId:frameId, appId:appId, requestId:requestId, action:action, payload:payload || {} }, '*');
    return new Promise(function(resolve, reject){
      pending[requestId] = { resolve: resolve, reject: reject };
    });
  }
  window.addEventListener('message', function(event){
    var data = event.data || {};
    if (data.source !== 'ai-phone-custom-app-host' || data.frameId !== frameId) return;
    if (data.type === 'tool.invoke' && data.toolRequestId) {
      var handlerKey = String(data.handler || data.toolId || data.toolName || '').trim();
      var handler = toolHandlers[handlerKey] || toolHandlers[String(data.toolId || '')] || toolHandlers[String(data.toolName || '')];
      Promise.resolve()
        .then(function(){
          if (typeof handler !== 'function') throw new Error('AiPhone tool handler not found: ' + handlerKey);
          return handler(data.args || {}, data.context || {});
        })
        .then(function(result){
          parent.postMessage({ source:'ai-phone-custom-app-frame', type:'tool.result', frameId:frameId, appId:appId, toolRequestId:data.toolRequestId, ok:true, result:result }, '*');
        })
        .catch(function(err){
          parent.postMessage({ source:'ai-phone-custom-app-frame', type:'tool.result', frameId:frameId, appId:appId, toolRequestId:data.toolRequestId, ok:false, error: err && err.message ? err.message : String(err) }, '*');
        });
      return;
    }
    if (data.type === 'event' && data.event) {
      var list = eventHandlers[data.event] || [];
      var wildcard = eventHandlers['*'] || [];
      var handlers = list.concat(wildcard);
      var jobs = handlers.map(function(handler){
        return Promise.resolve().then(function(){ return handler(data.payload, data.event); });
      });
      if (data.backgroundRunId) {
        Promise.allSettled(jobs).then(function(results){
          var errors = results.filter(function(item){ return item.status === 'rejected'; }).map(function(item){
            var reason = item.reason;
            return reason && reason.message ? reason.message : String(reason);
          });
          parent.postMessage({
            source:'ai-phone-custom-app-frame',
            type:'event.complete',
            frameId:frameId,
            appId:appId,
            backgroundRunId:data.backgroundRunId,
            event:data.event,
            ok:errors.length === 0,
            errors:errors
          }, '*');
        });
      } else {
        jobs.forEach(function(job){
          job.catch(function(err){ setTimeout(function(){ throw err; }, 0); });
        });
      }
      return;
    }
    if (!data.requestId) return;
    var item = pending[data.requestId];
    if (!item) return;
    delete pending[data.requestId];
    if (data.ok) item.resolve(data.result);
    else item.reject(new Error(data.error || 'AiPhone request failed'));
  });
  function onEvent(eventName, handler){
    var key = String(eventName || '').trim();
    if (!key) throw new Error('AiPhone.on 需要 eventName');
    if (typeof handler !== 'function') throw new Error('AiPhone.on 需要 handler 函数');
    if (!eventHandlers[key]) eventHandlers[key] = [];
    eventHandlers[key].push(handler);
    request('events.subscribe', { event: key }).catch(function(err){
      if (typeof console !== 'undefined' && console.warn) console.warn(err);
    });
    return function(){ offEvent(key, handler); };
  }
  function offEvent(eventName, handler){
    var key = String(eventName || '').trim();
    if (!key || !eventHandlers[key]) return false;
    if (typeof handler === 'function') {
      eventHandlers[key] = eventHandlers[key].filter(function(item){ return item !== handler; });
    } else {
      eventHandlers[key] = [];
    }
    if (eventHandlers[key].length === 0) {
      delete eventHandlers[key];
      request('events.unsubscribe', { event: key }).catch(function(){});
    }
    return true;
  }
  var api = {
    on: onEvent,
    off: offEvent,
    app: {
      getManifest: function(){ return request('app.getManifest'); },
      getCapabilities: function(){ return request('app.getCapabilities'); },
      getLaunchContext: function(){ return Promise.resolve(launchContext); },
      getAssetUrl: function(path){ return request('app.getAssetUrl', { path: path }); },
      close: function(){ return request('app.close'); }
    },
    db: {
      create: function(collection, data){ return request('db.create', { collection: collection, data: data }); },
      update: function(collection, id, patch){ return request('db.update', { collection: collection, id: id, patch: patch }); },
      get: function(collection, id){ return request('db.get', { collection: collection, id: id }); },
      list: function(collection, query){ return request('db.list', { collection: collection, query: query || {} }); },
      delete: function(collection, id){ return request('db.delete', { collection: collection, id: id }); }
    },
    ai: {
      generate: function(payload){ return request('ai.generate', payload || {}); },
      generateImage: function(payload){ return request('ai.generateImage', payload || {}); },
      chat: function(payload){ return request('ai.chat', payload || {}); },
      embed: function(payload){ return request('ai.embed', payload || {}); },
      classify: function(payload){ return request('ai.classify', payload || {}); }
    },
    user: {
      getProfile: function(payload){ return request('user.getProfile', payload || {}); },
      getPersona: function(payload){ return request('user.getPersona', payload || {}); },
      getPreferences: function(payload){ return request('user.getPreferences', payload || {}); }
    },
    network: {
      fetch: function(payload){ return request('network.fetch', payload || {}); }
    },
    voice: {
      readProfiles: function(payload){ return request('voice.readProfiles', payload || {}); },
      tts: function(payload){ return request('voice.tts', payload || {}); },
      stt: function(payload){ return request('voice.stt', payload || {}); },
      record: function(payload){ return request('voice.record', payload || {}); },
      stopRecord: function(payload){ return request('voice.stopRecord', payload || {}); },
      clone: function(payload){ return request('voice.clone', payload || {}); },
      play: function(payload){ return request('voice.play', payload || {}); },
      stopPlayback: function(payload){ return request('voice.stopPlayback', payload || {}); },
      pausePlayback: function(payload){ return request('voice.pausePlayback', payload || {}); },
      resumePlayback: function(payload){ return request('voice.resumePlayback', payload || {}); }
    },
    calendar: {
      read: function(payload){ return request('calendar.read', payload || {}); },
      list: function(payload){ return request('calendar.read', payload || {}); },
      write: function(payload){ return request('calendar.write', payload || {}); },
      create: function(payload){ return request('calendar.write', Object.assign({}, payload || {}, { operation: 'upsert' })); },
      update: function(payload){ return request('calendar.write', Object.assign({}, payload || {}, { operation: 'upsert' })); },
      delete: function(payload){ return request('calendar.write', Object.assign({}, payload || {}, { operation: 'delete' })); },
      replaceWeek: function(payload){ return request('calendar.write', Object.assign({}, payload || {}, { operation: 'replace' })); }
    },
    world: {
      read: function(payload){ return request('world.read', payload || {}); },
      list: function(payload){ return request('world.read', payload || {}); },
      get: function(id){ return request('world.read', { id: id }); },
      write: function(payload){ return request('world.write', payload || {}); },
      create: function(payload){ return request('world.write', Object.assign({}, payload || {}, { operation: 'create' })); },
      update: function(payload){ return request('world.write', Object.assign({}, payload || {}, { operation: 'upsert' })); },
      delete: function(payload){ return request('world.write', Object.assign({}, payload || {}, { operation: 'delete' })); },
      activate: function(payload){ return request('world.activate', payload || {}); }
    },
    media: {
      pick: function(payload){ return request('media.pick', payload || {}); },
      save: function(payload){ return request('media.save', payload || {}); },
      put: function(payload){ return request('media.put', payload || {}); },
      get: function(payload){ return request('media.get', payload || {}); },
      revoke: function(payload){ return request('media.revoke', payload || {}); },
      delete: function(payload){ return request('media.delete', payload || {}); }
    },
    geo: {
      get: function(payload){ return request('geo.get', payload || {}); },
      watch: function(payload){ return request('geo.watch.start', payload || {}); },
      clearWatch: function(){ return request('geo.watch.stop', {}); }
    },
    tools: {
      handle: function(name, handler){
        var key = String(name || '').trim();
        if (!key) throw new Error('AiPhone.tools.handle 需要工具名或工具 id');
        if (typeof handler !== 'function') throw new Error('AiPhone.tools.handle 需要 handler 函数');
        toolHandlers[key] = handler;
        request('tools.registerHandler', { name: key }).catch(function(err){
          if (typeof console !== 'undefined' && console.warn) console.warn(err);
        });
        return function(){
          if (toolHandlers[key] === handler) delete toolHandlers[key];
          request('tools.unregisterHandler', { name: key }).catch(function(){});
        };
      },
      invoke: function(name, args, context){ return request('tools.invoke', { name: name, args: args || {}, context: context || {} }); },
      list: function(){ return request('tools.list'); }
    },
    events: {
      subscribe: function(eventName){ return request('events.subscribe', { event: eventName }); },
      unsubscribe: function(eventName){ return request('events.unsubscribe', { event: eventName }); }
    },
    chat: {
      getCurrentSession: function(){ return request('chat.getCurrentSession'); },
      readHistory: function(payload){ return request('chat.readHistory', payload || {}); },
      sendMessage: function(payload){ return request('chat.sendMessage', payload || {}); },
      sendCard: function(payload){ return request('chat.sendCard', payload || {}); },
      updateCard: function(payload){ return request('chat.updateCard', payload || {}); },
      writeHistory: function(payload){ return request('chat.history', payload || {}); },
      pushHistory: function(payload){ return request('chat.history', payload || {}); },
      requestReply: function(payload){ return request('chat.requestReply', payload || {}); },
      openConversation: function(payload){ return request('chat.openConversation', payload || {}); },
      setContactState: function(payload){ return request('chat.setContactState', payload || {}); },
      block: function(characterId){ return request('chat.setContactState', { characterId: characterId, isBlacklisted: true }); },
      unblock: function(characterId){ return request('chat.setContactState', { characterId: characterId, isBlacklisted: false }); },
      mute: function(characterId){ return request('chat.setContactState', { characterId: characterId, isMuted: true }); },
      unmute: function(characterId){ return request('chat.setContactState', { characterId: characterId, isMuted: false }); }
    },
    characters: {
      list: function(){ return request('characters.list'); },
      get: function(id){ return request('characters.get', { id: id }); },
      readState: function(payload){ return request('characters.state.read', payload || {}); },
      writeState: function(payload){ return request('characters.state.write', payload || {}); },
      readRelations: function(payload){ return request('characters.relations.read', payload || {}); }
    },
    ui: {
      toast: function(message){ return request('ui.toast', { message: message }); },
      showNotification: function(payload){ return request('ui.showNotification', payload || {}); },
      showSmsThread: function(payload){ return request('ui.showSmsThread', payload || {}); },
      showCallScreen: function(payload){ return request('ui.showCallScreen', payload || {}); },
      confirm: function(payload){ return request('ui.confirm', payload || {}); }
    },
    notifications: {
      create: function(payload){ return request('notifications.create', payload || {}); },
      list: function(payload){ return request('notifications.list', payload || {}); },
      markRead: function(id){ return request('notifications.markRead', { id: id }); },
      markAllRead: function(){ return request('notifications.markAllRead'); },
      getBadge: function(){ return request('notifications.getBadge'); },
      setBadge: function(count){ return request('notifications.setBadge', { count: count }); },
      incrementBadge: function(delta){ return request('notifications.incrementBadge', { delta: delta }); },
      clearBadge: function(){ return request('notifications.setBadge', { count: 0 }); }
    },
    tasks: {
      schedule: function(payload){ return request('tasks.schedule', payload || {}); },
      list: function(){ return request('tasks.list'); },
      cancel: function(id){ return request('tasks.cancel', { id: id }); }
    },
    wallet: {
      get: function(){ return request('wallet.get'); },
      pay: function(payload){ return request('wallet.pay', payload || {}); }
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
    memory: {
      readCore: function(payload){ return request('memory.readCore', payload || {}); },
      readLongTerm: function(payload){ return request('memory.readLongTerm', payload || {}); },
      readShortTerm: function(payload){ return request('memory.readShortTerm', payload || {}); },
      search: function(payload){ return request('memory.search', payload || {}); },
      add: function(payload){ return request('memory.add', payload || {}); },
      addTimeline: function(payload){ return request('memory.addTimeline', payload || {}); },
      deleteTimeline: function(payload){ return request('memory.deleteTimeline', payload || {}); },
      removeTimeline: function(payload){ return request('memory.deleteTimeline', payload || {}); },
      suggest: function(payload){ return request('memory.suggest', payload || {}); }
    }
  };
  window.AiPhone = Object.assign({}, window.AiPhone || {}, api);
  window.AiPhoneApp = window.AiPhone;
})();
</script>`;

  const safeBridge = bridge;
  if (/<head[\s>]/i.test(base)) {
    return base.replace(/<head([^>]*)>/i, `<head$1>${safeBridge}`);
  }
  if (/<body[\s>]/i.test(base)) {
    return base.replace(/<body([^>]*)>/i, `<body$1>${safeBridge}`);
  }
  return `${safeBridge}${base}`;
}

function hasPermission(app: InstalledCustomApp, permission: string): boolean {
  return app.permissions.includes(permission as never);
}

function collectionName(value: unknown): string {
  const text = String(value ?? "").trim().replace(/[^\w.-]+/g, "_").slice(0, 80);
  if (!text) throw new Error("collection 不能为空。");
  return text;
}

function recordId(value?: unknown): string {
  const text = String(value ?? "").trim().slice(0, 120);
  return text || `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── 媒体库(media.*)──
// APP 的音频/图片以 Blob 存 IndexedDB(复用聊天媒体库),db 记录里只存
// media-store:// 引用。Blob 是磁盘背书的句柄,不占 JS 堆,也不进 kv 的
// 全量内存缓存——这是大配音库不再压崩页面的根本解法。旧的 dataURL 数据
// 原地不动,继续按字符串使用。
const CUSTOM_APP_MEDIA_REFS_COLLECTION = "__media_refs";
// 单件媒体上限(按 base64 长度计约 25MB),防止单次写入把宿主进程压崩
const CUSTOM_APP_MEDIA_MAX_BASE64_LENGTH = 34_000_000;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("媒体读取失败"));
    reader.readAsDataURL(blob);
  });
}

// ── 宿主代播(voice.play)──
// APP 沙盒 iframe 里的 <audio> 会让 iOS 锁屏媒体卡片绑到 about:srcdoc(点了
// 就把 PWA 导航到空白页);而 Web Audio 又会被 iOS 静音拨键掐掉输出。所以
// 播放必须由宿主页面持有的 <audio> 元素来做:卡片绑到站点本身,点击无害,
// 静音拨键也不影响媒体元素。
type FrameAudioChannel = { el: HTMLAudioElement; settle: (() => void) | null; objectUrl: string | null };

const FRAME_AUDIO_UNLOCK_WAV = "data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA";

function normalizeFrameAudioChannelName(value: unknown): string {
  return String(value ?? "voice") === "ambience" ? "ambience" : "voice";
}

function cleanupFrameAudioChannel(entry: FrameAudioChannel): void {
  const el = entry.el;
  el.onended = null;
  el.onerror = null;
  el.loop = false;
  // 清掉 src 让 iOS 撤下锁屏媒体卡片
  try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
  if (entry.objectUrl) {
    try { URL.revokeObjectURL(entry.objectUrl); } catch { /* ignore */ }
    entry.objectUrl = null;
  }
}

// iOS 的播放解锁按元素记账:在用户手势窗口里让元素静音播一次,之后
// 程序化 play() 才不会被自动播放策略拦截。
function unlockFrameAudioEl(el: HTMLAudioElement): void {
  if (el.dataset.unlocked === "1") return;
  try {
    el.muted = true;
    el.src = FRAME_AUDIO_UNLOCK_WAV;
    const p = el.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        try { el.pause(); el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
        el.muted = false;
        el.dataset.unlocked = "1";
      }).catch(() => { el.muted = false; });
    } else {
      el.muted = false;
      el.dataset.unlocked = "1";
    }
  } catch { /* 解锁失败不阻断,播放时 APP 侧还有回落 */ }
}

function ensureCharacterSession(characterId: string) {
  const contacts = loadChatContacts();
  if (!contacts.some(contact => contact.characterId === characterId)) {
    addChatContact(characterId);
  }
  return createOrGetSession(characterId);
}

function bridgeActionNeedsChatStorage(action: string): boolean {
  return action === "characters.state.read"
    || action === "characters.state.write"
    || action === "ai.generate"
    || action === "memory.readShortTerm"
    || action === "chat.readHistory"
    || action === "chat.sendMessage"
    || action === "chat.history"
    || action === "chat.writeHistory"
    || action === "chat.pushHistory"
    || action === "chat.sendCard"
    || action === "chat.updateCard"
    || action === "chat.openConversation"
    || action === "chat.requestReply"
    || action === "chat.setContactState";
}

function bridgeActionNeedsSettingsStorage(action: string): boolean {
  return action === "ai.generate"
    || action.startsWith("world.");
}

function bridgeActionNeedsKvStorage(action: string): boolean {
  return action.startsWith("db.")
    || action.startsWith("notifications.")
    || action.startsWith("tasks.")
    || action.startsWith("wallet.")
    || action.startsWith("memory.")
    || action.startsWith("calendar.")
    || action.startsWith("world.")
    || action.startsWith("voice.")
    || action.startsWith("ai.")
    || action === "user.getProfile"
    || action === "user.getPersona"
    || action === "user.getPreferences"
    || action === "chat.sendMessage"
    || action === "chat.history"
    || action === "chat.writeHistory"
    || action === "chat.pushHistory"
    || action === "chat.sendCard"
    || action === "chat.updateCard"
    || action === "chat.requestReply"
    || action === "chat.setContactState";
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

async function pickCustomAppMedia(record: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    // iOS「文件」App 对宽泛的 audio/* / video/* 常把具体文件灰掉,补上常见扩展名兜底
    let accept = typeof record.accept === "string" ? record.accept : "";
    if (accept === "audio/*") accept = "audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac,.opus";
    else if (accept === "video/*") accept = "video/*,.mp4,.mov,.m4v,.webm";
    input.accept = accept;
    input.multiple = record.multiple === true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "-9999px";
    document.body.appendChild(input);
    const cleanup = () => {
      input.remove();
      window.removeEventListener("focus", handleFocus);
    };
    const handleFocus = () => {
      window.setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          cleanup();
          resolve({ canceled: true, files: [] });
        }
      }, 600);
    };
    input.onchange = async () => {
      try {
        const files = Array.from(input.files ?? []);
        const limit = Math.max(1, Math.min(20, Number(record.limit ?? files.length) || files.length || 1));
        const picked = await Promise.all(files.slice(0, limit).map(async file => ({
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl: await fileToDataUrl(file),
        })));
        cleanup();
        resolve({ canceled: false, files: picked, file: picked[0] ?? null });
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    window.addEventListener("focus", handleFocus);
    input.click();
  });
}

function serializeBridgeChatMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: String(message.content ?? "").slice(0, 4000),
    createdAt: message.createdAt,
    status: message.status,
    senderName: message.senderName,
    mediaType: message.mediaType,
    mediaData: message.mediaData && typeof message.mediaData === "object" ? message.mediaData : undefined,
    isRetracted: message.isRetracted === true,
  };
}

function getCustomAppDeclaredEventNames(app: InstalledCustomApp): Set<string> {
  const canonical = app.manifest.extensions?.events ?? [];
  const legacy = app.manifest.events ?? [];
  const events = canonical.length > 0 ? canonical : legacy;
  return new Set(events.map(item => String(item.event ?? "").trim()).filter(Boolean));
}

function getCustomAppDeclaredToolKeys(app: InstalledCustomApp): Set<string> {
  const canonical = app.manifest.extensions?.tools ?? [];
  const legacy = app.manifest.extensions?.chat?.tools ?? app.manifest.chatExtensions?.tools ?? [];
  const tools = canonical.length > 0 ? canonical : legacy;
  const keys = new Set<string>();
  for (const tool of tools) {
    for (const value of [tool.id, tool.name, tool.handler, tool.entry]) {
      const key = String(value ?? "").trim();
      if (key) keys.add(key);
    }
  }
  return keys;
}

function buildLaunchEventPayload(app: InstalledCustomApp, launchContext?: Record<string, unknown> | null): Record<string, unknown> {
  return {
    appId: app.id,
    appName: app.name,
    launchContext: launchContext ?? null,
    launchedAt: new Date().toISOString(),
  };
}

function toolInvocationKeys(payload: CustomAppToolExecutorPayload): string[] {
  return Array.from(new Set([
    payload.tool.handler,
    payload.tool.entry,
    payload.tool.id,
    payload.tool.name,
  ].map(value => String(value ?? "").trim()).filter(Boolean)));
}

function serializeToolContext(context: CustomAppToolExecutorPayload["context"]): Record<string, unknown> {
  if (!context) return {};
  return {
    appId: context.appId,
    sessionId: context.sessionId,
    characterId: context.characterId,
    sourceEngine: context.sourceEngine,
  };
}

export function CustomAppRunner({
  app,
  onClose,
  onNotice,
  launchContext,
  embedded = false,
  backgroundEvent,
  onBackgroundEventComplete,
  backgroundTool,
  onBackgroundToolComplete,
}: CustomAppRunnerProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const subscribedEventsRef = useRef<Set<string>>(new Set());
  const geoWatchIdRef = useRef<number | null>(null);
  const backgroundEventSentRef = useRef(false);
  const backgroundEventCompletedRef = useRef(false);
  const backgroundToolSentRef = useRef(false);
  const backgroundToolCompletedRef = useRef(false);
  const pendingToolInvocationsRef = useRef<Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>>(new Map());
  const registeredToolHandlersRef = useRef<Set<string>>(new Set());
  const frameAudioChannelsRef = useRef<Map<string, FrameAudioChannel>>(new Map());
  const frameObjectUrlsRef = useRef<Set<string>>(new Set());
  const onlineRoomRef = useRef<OnlineRoomConnection | null>(null);

  // 联机房间随 APP 生命周期走：关 APP 即退房（房主退房 = 关房）
  useEffect(() => () => {
    onlineRoomRef.current?.leave();
    onlineRoomRef.current = null;
  }, []);
  const [frameId] = useState(() => `custom_app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const [bridgeReady, setBridgeReady] = useState(false);
  const isBackgroundRunner = Boolean(backgroundEvent || backgroundTool);
  const effectiveEmbedded = embedded || isBackgroundRunner;
  const srcDoc = useMemo(() => createCustomAppSrcDoc(app, frameId, launchContext, effectiveEmbedded), [app, frameId, launchContext, effectiveEmbedded]);
  const declaredEvents = useMemo(() => getCustomAppDeclaredEventNames(app), [app]);
  const declaredToolKeys = useMemo(() => getCustomAppDeclaredToolKeys(app), [app]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [menuActionError, setMenuActionError] = useState("");
  const launchSource = launchContext && typeof launchContext === "object" ? String(launchContext.source ?? "") : "";
  const closeLabel = launchSource === "chat_plus_action" || launchSource === "chat_card" || launchSource === "chat_directive"
    ? "返回聊天室"
    : "返回桌面";

  const getFrameAudioChannel = useCallback((name: string): FrameAudioChannel => {
    let entry = frameAudioChannelsRef.current.get(name);
    if (!entry) {
      const el = new Audio();
      el.setAttribute("playsinline", "");
      entry = { el, settle: null, objectUrl: null };
      frameAudioChannelsRef.current.set(name, entry);
    }
    return entry;
  }, []);

  // 挂载发生在"打开 APP"那次点击的任务内(useLayoutEffect 同步执行),趁手势
  // 窗口把代播元素解锁;之后宿主层的任何触摸(如返回胶囊)也会补解锁。
  useLayoutEffect(() => {
    const unlockAll = () => {
      unlockFrameAudioEl(getFrameAudioChannel("voice").el);
      unlockFrameAudioEl(getFrameAudioChannel("ambience").el);
    };
    unlockAll();
    window.addEventListener("pointerdown", unlockAll, { passive: true });
    window.addEventListener("touchend", unlockAll, { passive: true });
    const channels = frameAudioChannelsRef.current;
    const objectUrls = frameObjectUrlsRef.current;
    return () => {
      window.removeEventListener("pointerdown", unlockAll);
      window.removeEventListener("touchend", unlockAll);
      for (const entry of channels.values()) {
        const settle = entry.settle;
        entry.settle = null;
        cleanupFrameAudioChannel(entry);
        settle?.();
      }
      channels.clear();
      for (const url of objectUrls) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }
      objectUrls.clear();
    };
  }, [getFrameAudioChannel]);

  const handleUninstall = useCallback(async (deleteData: boolean) => {
    const removal = await removeCustomAppRegistrationsAsync(app.id, { deleteResources: deleteData });
    const removalText = formatCustomAppRegistrationRemovalSummary(removal);
    await uninstallCustomAppAsync(app.id, { deleteData });
    const base = deleteData ? `已卸载「${app.name}」并删除数据` : `已卸载「${app.name}」`;
    onNotice?.(removalText ? `${base}，${removalText}` : base);
    onClose();
  }, [app, onNotice, onClose]);

  const updateCurrentApp = useCallback(async () => {
    if (updating) return;
    setUpdating(true);
    setMenuActionError("");
    try {
      const result = await updateInstalledCustomAppFromMarket(app);
      setMenuOpen(false);
      onNotice?.(result.previousVersion === result.installed.version
        ? `已同步「${result.installed.name}」`
        : `已更新「${result.installed.name}」到 v${result.installed.version}`);
    } catch (err) {
      setMenuActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  }, [app, onNotice, updating]);

  const postResponse = useCallback((requestId: string, ok: boolean, result?: BridgeResult, error?: string) => {
    iframeRef.current?.contentWindow?.postMessage({
      source: "ai-phone-custom-app-host",
      type: "response",
      frameId,
      requestId,
      ok,
      result,
      error,
    }, "*");
  }, [frameId]);

  const completeBackgroundEvent = useCallback((result: { ok: boolean; reason: string; errors?: string[] }) => {
    if (!backgroundEvent || backgroundEventCompletedRef.current) return;
    backgroundEventCompletedRef.current = true;
    onBackgroundEventComplete?.(backgroundEvent.runId, result);
  }, [backgroundEvent, onBackgroundEventComplete]);

  const completeBackgroundTool = useCallback((result: { ok: boolean; reason: string; result?: unknown; error?: string }) => {
    if (!backgroundTool || backgroundToolCompletedRef.current) return;
    backgroundToolCompletedRef.current = true;
    onBackgroundToolComplete?.(backgroundTool.runId, result);
  }, [backgroundTool, onBackgroundToolComplete]);

  const postBackgroundEventIfReady = useCallback(() => {
    if (!backgroundEvent || backgroundEventSentRef.current) return;
    if (!subscribedEventsRef.current.has(backgroundEvent.eventName) && !subscribedEventsRef.current.has("*")) return;
    backgroundEventSentRef.current = true;
    iframeRef.current?.contentWindow?.postMessage({
      source: "ai-phone-custom-app-host",
      type: "event",
      frameId,
      event: backgroundEvent.eventName,
      payload: backgroundEvent.payload,
      backgroundRunId: backgroundEvent.runId,
    }, "*");
  }, [backgroundEvent, frameId]);

  // APP 关闭/卸载运行器时停掉定位监听，避免后台白耗电
  useEffect(() => () => {
    if (geoWatchIdRef.current != null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(geoWatchIdRef.current);
    }
    geoWatchIdRef.current = null;
  }, []);

  const postHostEvent = useCallback((eventName: string, payload: Record<string, unknown>) => {
    if (!subscribedEventsRef.current.has(eventName) && !subscribedEventsRef.current.has("*")) return;
    iframeRef.current?.contentWindow?.postMessage({
      source: "ai-phone-custom-app-host",
      type: "event",
      frameId,
      event: eventName,
      payload,
    }, "*");
  }, [frameId]);

  const invokeOpenAppTool = useCallback((payload: CustomAppToolExecutorPayload) => (
    new Promise<unknown>((resolve, reject) => {
      const toolRequestId = `${frameId}_tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      pendingToolInvocationsRef.current.set(toolRequestId, { resolve, reject });
      iframeRef.current?.contentWindow?.postMessage({
        source: "ai-phone-custom-app-host",
        type: "tool.invoke",
        frameId,
        toolRequestId,
        toolId: payload.tool.id,
        toolName: payload.tool.name,
        handler: payload.tool.handler || payload.tool.entry || payload.tool.id,
        args: payload.args,
        context: serializeToolContext(payload.context),
      }, "*");
    })
  ), [frameId]);

  const postBackgroundToolIfReady = useCallback(() => {
    if (!backgroundTool || backgroundToolSentRef.current) return;
    const keys = toolInvocationKeys(backgroundTool.payload);
    if (!keys.some(key => registeredToolHandlersRef.current.has(key))) return;
    backgroundToolSentRef.current = true;
    void invokeOpenAppTool(backgroundTool.payload)
      .then(result => completeBackgroundTool({ ok: true, reason: "completed", result }))
      .catch(err => completeBackgroundTool({
        ok: false,
        reason: "failed",
        error: err instanceof Error ? err.message : String(err),
      }));
  }, [backgroundTool, completeBackgroundTool, invokeOpenAppTool]);

  const requirePermission = useCallback((permission: string) => {
    if (!hasPermission(app, permission)) {
      throw new Error(`应用未声明权限：${permission}`);
    }
  }, [app]);

  const requireAnyPermission = useCallback((permissions: string[]) => {
    if (permissions.some(permission => hasPermission(app, permission))) return;
    throw new Error(`应用未声明权限：${permissions.join(" 或 ")}`);
  }, [app]);

  const handleBridgeRequest = useCallback(async (action: string, payload: unknown): Promise<BridgeResult> => {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const launchRecord = launchContext && typeof launchContext === "object" ? launchContext : {};
    const backgroundRecord = launchRecord.origin === "custom_app_background" && !record.origin
      ? { ...record, origin: "custom_app_background" }
      : record;
    if (bridgeActionNeedsKvStorage(action)) {
      await hydrateKvDb();
    }
    if (bridgeActionNeedsSettingsStorage(action)) {
      await ensureSettingsStorageHydrated();
    }
    if (bridgeActionNeedsChatStorage(action)) {
      await hydrateChatStorage();
    }

    if (action === "app.getManifest") return app.manifest;
    if (action === "app.getCapabilities") {
      return {
        sdkVersion: app.manifest.sdkVersion || "1.0",
        permissions: app.permissions,
        resources: app.manifest.resources ?? {},
        extensions: app.manifest.extensions ?? {},
        promptProfiles: app.manifest.extensions?.prompt?.profiles ?? app.manifest.promptProfiles ?? [],
        events: app.manifest.extensions?.events ?? app.manifest.events ?? [],
        network: app.manifest.network ?? {},
        sdk: {
          app: ["getManifest", "getCapabilities", "getLaunchContext", "getAssetUrl", "close"],
          ai: ["generate", "chat", "embed", "classify"],
          user: ["getProfile", "getPersona", "getPreferences"],
          network: ["fetch"],
          voice: ["readProfiles", "tts", "stt", "record", "stopRecord", "clone", "play", "stopPlayback", "pausePlayback", "resumePlayback"],
          calendar: ["read", "list", "write", "create", "update", "delete", "replaceWeek"],
          world: ["read", "list", "get", "write", "create", "update", "delete", "activate"],
          media: ["pick", "save", "put", "get", "revoke", "delete"],
          characters: ["list", "get", "readState", "writeState", "readRelations"],
          chat: ["getCurrentSession", "readHistory", "sendMessage", "sendCard", "updateCard", "writeHistory", "requestReply", "openConversation", "setContactState"],
          memory: ["readCore", "readLongTerm", "readShortTerm", "search", "add", "addTimeline", "deleteTimeline", "removeTimeline", "suggest"],
          notifications: ["create", "list", "markRead", "markAllRead", "getBadge", "setBadge", "incrementBadge", "clearBadge"],
          tasks: ["schedule", "list", "cancel"],
          wallet: ["get", "pay"],
          geo: ["get", "watch", "clearWatch"],
        },
      };
    }
    if (action === "app.close") {
      onClose();
      return true;
    }
    if (action === "app.getAssetUrl") {
      const path = normalizeAssetRef(String(record.path ?? ""));
      return app.assets[path]?.dataUrl ?? "";
    }

    if (action === "events.subscribe") {
      const eventName = String(record.event ?? record.name ?? "").trim();
      if (!eventName) throw new Error("events.subscribe 缺少 event。");
      if (!declaredEvents.has(eventName) && !declaredEvents.has("*")) {
        throw new Error(`manifest.extensions.events 未声明事件：${eventName}`);
      }
      if (eventName === "chat.message.created") requireAnyPermission(["chat.read", "chat.read.background"]);
      subscribedEventsRef.current.add(eventName);
      if (eventName === "app.launched") {
        window.setTimeout(() => postHostEvent("app.launched", buildLaunchEventPayload(app, launchContext)), 0);
      }
      if (backgroundEvent && (eventName === backgroundEvent.eventName || eventName === "*")) {
        window.setTimeout(postBackgroundEventIfReady, 0);
      }
      return { ok: true, event: eventName };
    }

    if (action === "events.unsubscribe") {
      const eventName = String(record.event ?? record.name ?? "").trim();
      if (!eventName) return true;
      subscribedEventsRef.current.delete(eventName);
      return true;
    }

    if (action === "tools.registerHandler") {
      requirePermission("chat.tools");
      const toolKey = String(record.name ?? record.id ?? record.tool ?? "").trim();
      if (!toolKey) throw new Error("tools.registerHandler 缺少工具名。");
      if (declaredToolKeys.size > 0 && !declaredToolKeys.has(toolKey)) {
        throw new Error(`manifest.extensions.tools 未声明工具 handler：${toolKey}`);
      }
      registeredToolHandlersRef.current.add(toolKey);
      if (backgroundTool) window.setTimeout(postBackgroundToolIfReady, 0);
      return { ok: true, name: toolKey };
    }

    if (action === "tools.unregisterHandler") {
      const toolKey = String(record.name ?? record.id ?? record.tool ?? "").trim();
      if (toolKey) registeredToolHandlersRef.current.delete(toolKey);
      return true;
    }

    if (action === "tools.list") {
      requirePermission("chat.tools");
      const { getEnabledTools } = await import("@/lib/tool-storage");
      return getEnabledTools(`custom_app:${app.id}`).map(tool => ({
        name: tool.name,
        description: tool.description,
        source: tool.source,
        sourceId: tool.sourceId,
        parameterSchema: tool.parameterSchema,
      }));
    }

    if (action === "tools.invoke") {
      requirePermission("chat.tools");
      const name = String(record.name ?? record.tool ?? "").trim();
      if (!name) throw new Error("tools.invoke 缺少工具名。");
      const args = record.args && typeof record.args === "object" && !Array.isArray(record.args)
        ? record.args as Record<string, unknown>
        : {};
      const rawContext = record.context && typeof record.context === "object" && !Array.isArray(record.context)
        ? record.context as Record<string, unknown>
        : {};
      const launch = launchContext && typeof launchContext === "object" ? launchContext : {};
      const characterId = String(rawContext.characterId ?? record.characterId ?? launch.characterId ?? "").trim() || undefined;
      const sessionId = String(rawContext.sessionId ?? record.sessionId ?? launch.sessionId ?? "").trim() || undefined;
      const { executeToolCalls } = await import("@/lib/tool-executor");
      const [result] = await executeToolCalls([{ name, args }], {
        appId: `custom_app:${app.id}`,
        sessionId,
        characterId,
        sourceEngine: "custom_app",
      });
      return result ?? { name, success: false, error: "工具没有返回结果。" };
    }

    if (action.startsWith("room.") || action.startsWith("cloud.")) {
      requirePermission("online.play");
      const namespace = `custom_app:${app.id}`;

      if (action.startsWith("cloud.")) {
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
      const current = onlineRoomRef.current && !onlineRoomRef.current.isClosed ? onlineRoomRef.current : null;

      if (action === "room.create" || action === "room.join") {
        if (current) {
          current.leave();
          onlineRoomRef.current = null;
        }
        const events = {
          onMessage: (message: { from: { userId: string; name: string }; payload: unknown; sentAt: number }) => {
            postHostEvent("room.message", { from: message.from, payload: message.payload, sentAt: message.sentAt });
          },
          onPlayers: (players: unknown[]) => postHostEvent("room.players", { players }),
          onState: (state: Record<string, unknown>) => postHostEvent("room.state", { state }),
          onClosed: (reason: string) => {
            onlineRoomRef.current = null;
            postHostEvent("room.closed", { reason });
          },
        };
        const connection = action === "room.create"
          ? await OnlineRoomConnection.create({
            namespace,
            title: typeof record.title === "string" ? record.title : "",
            maxPlayers: Number(record.maxPlayers ?? 8) || 8,
            meta: record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
              ? record.meta as Record<string, unknown>
              : {},
          }, events)
          : await OnlineRoomConnection.join({ namespace, code: String(record.code ?? "") }, events);
        onlineRoomRef.current = connection;
        return publicRoomInfo(connection);
      }

      if (action === "room.current") {
        return current ? { ...publicRoomInfo(current), state: current.state() } : null;
      }
      if (action === "room.leave") {
        if (current) {
          current.leave();
          onlineRoomRef.current = null;
        }
        return true;
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
        await current.send(record.payload ?? record.data ?? record.message ?? null);
        return true;
      }
      if (action === "room.setState") {
        const state = record.state ?? record.data;
        if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("room.setState 需要对象 state。");
        await current.setState(state as Record<string, unknown>);
        return true;
      }
      if (action === "room.getState") return current.state();
      if (action === "room.players") return current.players();
      if (action === "room.kick") {
        await current.kick(String(record.userId ?? ""));
        return true;
      }
      if (action === "room.close") {
        await current.close();
        onlineRoomRef.current = null;
        return true;
      }
      throw new Error(`未知联机动作：${action}`);
    }

    if (action.startsWith("db.")) {
      if (action === "db.list" || action === "db.get") requirePermission("app.data.read");
      else requirePermission("app.data.write");
      const collection = collectionName(record.collection);
      const rows = readCustomAppCollection(app.id, collection);
      if (action === "db.create") {
        const row = {
          ...(record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {}),
          id: recordId((record.data as Record<string, unknown> | undefined)?.id),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        writeCustomAppCollection(app.id, collection, [row, ...rows]);
        return row;
      }
      if (action === "db.update") {
        const id = recordId(record.id);
        const patch = record.patch && typeof record.patch === "object" ? record.patch as Record<string, unknown> : {};
        let updated: Record<string, unknown> | null = null;
        writeCustomAppCollection(app.id, collection, rows.map(row => {
          if (String(row.id) !== id) return row;
          updated = { ...row, ...patch, id, updatedAt: new Date().toISOString() };
          return updated;
        }));
        return updated;
      }
      if (action === "db.get") {
        const id = recordId(record.id);
        return rows.find(row => String(row.id) === id) ?? null;
      }
      if (action === "db.list") {
        const limit = Math.max(1, Math.min(500, Number((record.query as Record<string, unknown> | undefined)?.limit ?? 100) || 100));
        return rows.slice(0, limit);
      }
      if (action === "db.delete") {
        const id = recordId(record.id);
        writeCustomAppCollection(app.id, collection, rows.filter(row => String(row.id) !== id));
        return true;
      }
    }

    if (action === "user.getProfile") {
      requirePermission("user.profile.read");
      return readCustomAppUserProfile(app, record);
    }
    if (action === "user.getPersona") {
      requirePermission("user.persona.read");
      return readCustomAppUserPersona(app, record);
    }
    if (action === "user.getPreferences") {
      requirePermission("user.preferences.read");
      return readCustomAppUserPreferences(app, record);
    }
    if (action === "network.fetch") {
      requirePermission("network.fetch");
      return fetchCustomAppNetwork(app, record);
    }

    if (action === "voice.play") {
      requirePermission("voice.tts");
      const channel = normalizeFrameAudioChannelName(record.channel);
      const rawSrc = String(record.dataUrl ?? record.src ?? record.ref ?? "");
      let src = rawSrc;
      let mediaObjectUrl: string | null = null;
      if (isMediaStoreRef(rawSrc)) {
        // 媒体库引用:宿主直接读 Blob 转 objectURL,音频数据不过桥
        const media = await loadMediaBlob(rawSrc);
        if (!media) throw new Error("voice.play 找不到对应媒体,可能已被删除。");
        mediaObjectUrl = URL.createObjectURL(media.blob);
        src = mediaObjectUrl;
      } else if (!src.startsWith("data:audio/") && !src.startsWith("blob:")) {
        throw new Error("voice.play 需要音频 dataUrl 或 media-store:// 引用。");
      }
      const entry = getFrameAudioChannel(channel);
      const prevSettle = entry.settle;
      entry.settle = null;
      cleanupFrameAudioChannel(entry);
      prevSettle?.();
      const el = entry.el;
      entry.objectUrl = mediaObjectUrl;
      el.loop = record.loop === true;
      const volume = Number(record.volume);
      el.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
      el.src = src;
      if (el.loop) {
        try { await el.play(); } catch (err) {
          cleanupFrameAudioChannel(entry);
          throw new Error(`宿主音频播放被拦截:${err instanceof Error ? err.message : String(err)}`);
        }
        return { ok: true, loop: true };
      }
      return await new Promise((resolve, reject) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (entry.settle === settle) entry.settle = null;
          cleanupFrameAudioChannel(entry);
          resolve({ ok: true });
        };
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          if (entry.settle === settle) entry.settle = null;
          cleanupFrameAudioChannel(entry);
          reject(new Error(message));
        };
        entry.settle = settle;
        el.onended = settle;
        el.onerror = () => fail("宿主音频解码或播放失败");
        const p = el.play();
        if (p && typeof p.catch === "function") {
          p.catch(err => fail(`宿主音频播放被拦截:${err instanceof Error ? err.message : String(err)}`));
        }
      });
    }
    if (action === "media.put") {
      requirePermission("app.data.write");
      const dataUrl = String(record.dataUrl ?? "");
      let base64 = String(record.base64 ?? "");
      let declaredMime = String(record.mime ?? "").trim() || undefined;
      if (dataUrl.startsWith("data:")) {
        const comma = dataUrl.indexOf(",");
        if (comma < 0) throw new Error("media.put 的 dataUrl 格式不合法。");
        declaredMime = declaredMime || dataUrl.slice(5, comma).split(";")[0] || undefined;
        base64 = dataUrl.slice(comma + 1);
      }
      if (!base64) throw new Error("media.put 需要 dataUrl 或 base64。");
      if (base64.length > CUSTOM_APP_MEDIA_MAX_BASE64_LENGTH) {
        throw new Error("media.put 单个媒体不能超过 25MB。");
      }
      const stored = await storeMediaBase64(base64, declaredMime);
      const refRows = readCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION);
      writeCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION, [
        { id: stored.ref, mime: stored.mime, category: stored.category, createdAt: new Date().toISOString() },
        ...refRows,
      ]);
      return { ref: stored.ref, mime: stored.mime, category: stored.category };
    }
    if (action === "media.get") {
      requirePermission("app.data.read");
      const ref = String(record.ref ?? record.id ?? "");
      if (!isMediaStoreRef(ref)) throw new Error("media.get 需要 media-store:// 引用。");
      const refRows = readCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION);
      if (!refRows.some(row => String(row.id) === ref)) {
        throw new Error("media.get 只能读取本 APP 存入的媒体。");
      }
      const media = await loadMediaBlob(ref);
      if (!media) return null;
      // 一律返回 dataURL:宿主创建的 blob objectURL 在沙盒 iframe(空源)里
      // 会被同源规则拒载,APP 根本用不了。音频播放走 voice.play(宿主自播)
      // 不经过这里,所以大文件驻留内存的问题只剩"正在显示的图片",可接受。
      return { ref, mime: media.mimeType, dataUrl: await blobToDataUrl(media.blob) };
    }
    if (action === "media.revoke") {
      requirePermission("app.data.read");
      const url = String(record.url ?? record.objectUrl ?? "");
      if (frameObjectUrlsRef.current.has(url)) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        frameObjectUrlsRef.current.delete(url);
      }
      return { ok: true };
    }
    if (action === "media.delete") {
      requirePermission("app.data.write");
      const ref = String(record.ref ?? record.id ?? "");
      if (!isMediaStoreRef(ref)) return { ok: true };
      const refRows = readCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION);
      if (refRows.some(row => String(row.id) === ref)) {
        writeCustomAppCollection(app.id, CUSTOM_APP_MEDIA_REFS_COLLECTION, refRows.filter(row => String(row.id) !== ref));
        await deleteMediaRef(ref);
      }
      return { ok: true };
    }
    if (action === "voice.stopPlayback") {
      requirePermission("voice.tts");
      const entry = frameAudioChannelsRef.current.get(normalizeFrameAudioChannelName(record.channel));
      if (entry) {
        const settle = entry.settle;
        entry.settle = null;
        cleanupFrameAudioChannel(entry);
        settle?.();
      }
      return { ok: true };
    }
    if (action === "voice.pausePlayback") {
      requirePermission("voice.tts");
      const entry = frameAudioChannelsRef.current.get(normalizeFrameAudioChannelName(record.channel));
      if (entry) { try { entry.el.pause(); } catch { /* ignore */ } }
      return { ok: true };
    }
    if (action === "voice.resumePlayback") {
      requirePermission("voice.tts");
      const entry = frameAudioChannelsRef.current.get(normalizeFrameAudioChannelName(record.channel));
      if (entry && entry.el.src) { void entry.el.play().catch(() => { /* ignore */ }); }
      return { ok: true };
    }

    if (action === "voice.readProfiles") {
      requirePermission("voice.readProfiles");
      return readCustomAppVoiceProfiles(app, record);
    }
    if (action === "voice.tts") {
      requirePermission("voice.tts");
      return synthesizeCustomAppSpeech(app, record);
    }
    if (action === "voice.stt") {
      requirePermission("voice.stt");
      return recognizeCustomAppSpeech(app, record);
    }
    // 录一段麦克风音频回传给 APP。沿用 voice.stt 权限:两者都是「听麦克风」,
    // 装应用时那一条授权说明已经覆盖了麦克风采集。
    if (action === "voice.record") {
      requirePermission("voice.stt");
      return recordCustomAppSpeech(record);
    }
    if (action === "voice.stopRecord") {
      requirePermission("voice.stt");
      return stopCustomAppRecording();
    }
    if (action === "voice.clone") {
      requirePermission("voice.clone");
      return cloneCustomAppVoice(app, record);
    }

    if (action === "calendar.read") {
      requirePermission("calendar.read");
      return readCustomAppCalendar(record);
    }
    if (action === "calendar.write") {
      requirePermission("calendar.write");
      return writeCustomAppCalendar(record);
    }

    if (action === "world.read") {
      requirePermission("world.read");
      return readCustomAppWorld(record);
    }
    if (action === "world.write") {
      requirePermission("world.write");
      return writeCustomAppWorld(app, record);
    }
    if (action === "world.activate") {
      requirePermission("world.activate");
      return activateCustomAppWorld(app, record);
    }

    if (action === "media.pick") {
      requirePermission("media.pick");
      return pickCustomAppMedia(record);
    }
    if (action === "media.save") {
      requirePermission("media.save");
      return saveCustomAppMedia(record);
    }

    // 定位：沙盒 iframe 是不透明源拿不到 navigator.geolocation 权限，由宿主页面代理
    if (action === "geo.get") {
      requirePermission("geo.read");
      return new Promise((resolve, reject) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          reject(new Error("当前设备或环境不支持定位。"));
          return;
        }
        navigator.geolocation.getCurrentPosition(
          pos => resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            timestamp: pos.timestamp,
          }),
          err => reject(new Error(err?.message ? `定位失败：${err.message}` : "定位失败或未授权。")),
          {
            enableHighAccuracy: record.highAccuracy !== false,
            timeout: Math.min(30000, Math.max(1000, Number(record.timeoutMs) || 10000)),
            maximumAge: Math.max(0, Number(record.maximumAgeMs) || 30000),
          },
        );
      });
    }
    if (action === "geo.watch.start") {
      requirePermission("geo.watch");
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        throw new Error("当前设备或环境不支持定位。");
      }
      if (geoWatchIdRef.current != null) navigator.geolocation.clearWatch(geoWatchIdRef.current);
      geoWatchIdRef.current = navigator.geolocation.watchPosition(
        pos => postHostEvent("geo.position", {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }),
        err => postHostEvent("geo.error", { message: err?.message ?? "定位失败" }),
        { enableHighAccuracy: record.highAccuracy !== false, maximumAge: Math.max(0, Number(record.maximumAgeMs) || 5000) },
      );
      return { ok: true };
    }
    if (action === "geo.watch.stop") {
      if (geoWatchIdRef.current != null && typeof navigator !== "undefined" && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoWatchIdRef.current);
      }
      geoWatchIdRef.current = null;
      return true;
    }

    if (action === "characters.list") {
      requirePermission("characters.read");
      return loadCharacters().map(character => ({
        id: character.id,
        name: character.name,
        avatar: character.avatar,
        persona: character.persona,
        personality: character.personality,
      }));
    }
    if (action === "characters.get") {
      requirePermission("characters.read");
      return loadCharacters().find(character => character.id === String(record.id ?? "")) ?? null;
    }
    if (action === "characters.state.read") {
      requirePermission("characters.state.read");
      return readCustomAppCharacterState(record);
    }
    if (action === "characters.state.write") {
      requirePermission("characters.state.write");
      return writeCustomAppCharacterState(app, record);
    }
    if (action === "characters.relations.read") {
      requirePermission("characters.relations.read");
      return readCustomAppCharacterRelations(record);
    }

    if (action === "chat.getCurrentSession") {
      requireAnyPermission(["chat.read", "chat.read.background"]);
      return launchContext && typeof launchContext === "object" ? launchContext : null;
    }

    if (action === "chat.readHistory") {
      requireAnyPermission(["chat.read", "chat.read.background"]);
      const mergedRecord = {
        ...launchRecord,
        ...record,
      };
      return readCustomAppChatHistory(mergedRecord);
    }

    if (action === "chat.sendMessage") {
      requireAnyPermission(["chat.write", "chat.sendMessage"]);
      const result = sendCustomAppTextMessage(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, ...result };
    }

    if (action === "chat.history" || action === "chat.writeHistory" || action === "chat.pushHistory") {
      requireAnyPermission(["chat.write", "chat.sendMessage"]);
      const result = writeCustomAppHistoryMessage(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, ...result };
    }

    if (action === "chat.sendCard") {
      requirePermission("chat.sendCard");
      const result = sendCustomAppCard(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, sessionId: result.sessionId, messageId: result.messageId };
    }

    if (action === "chat.updateCard") {
      requireAnyPermission(["chat.write", "chat.sendCard"]);
      const result = updateCustomAppCard(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, ...result };
    }

    if (action === "chat.openConversation") {
      const characterId = String(record.characterId ?? "").trim();
      if (!characterId) throw new Error("chat.openConversation 缺少 characterId。");
      const session = ensureCharacterSession(characterId);
      window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "chat", sessionId: session.id } }));
      return { sessionId: session.id };
    }

    if (action === "chat.requestReply") {
      requirePermission("chat.requestReply");
      const result = await requestCustomAppReply(app, { ...launchRecord, ...backgroundRecord });
      return { ok: true, ...result };
    }

    if (action === "chat.setContactState") {
      requirePermission("chat.contacts.write");
      return setCustomAppChatContactState(record);
    }

    if (action === "ai.generate") {
      requirePermission("ai.generate");
      // 分流只看 APP 显式传参，避免 launchContext 里的 sessionId 误触发群聊模式
      return isCustomAppGroupGenerateRecord(record)
        ? generateCustomAppGroupText(app, { ...launchRecord, ...record })
        : generateCustomAppText(app, { ...launchRecord, ...record });
    }
    if (action === "ai.generateImage") {
      requirePermission("ai.generateImage");
      return generateCustomAppImage(app, { ...launchRecord, ...record });
    }
    if (action === "ai.chat") {
      requirePermission("ai.chat");
      return runCustomAppAiChat(app, { ...launchRecord, ...record });
    }
    if (action === "ai.embed") {
      requirePermission("ai.embed");
      return runCustomAppAiEmbed(app, { ...launchRecord, ...record });
    }
    if (action === "ai.classify") {
      requirePermission("ai.classify");
      return runCustomAppAiClassify(app, { ...launchRecord, ...record });
    }

    if (action === "ui.toast") {
      requirePermission("ui.toast");
      onNotice?.(String(record.message ?? "已完成"));
      return true;
    }

    if (action === "ui.showNotification") {
      requirePermission("ui.notification");
      return createCustomAppNotification(app, record, onNotice);
    }

    if (action === "ui.showSmsThread") {
      requirePermission("ui.sms");
      onNotice?.("已触发短信界面（MVP 先以通知形式展示）。");
      return true;
    }

    if (action === "ui.showCallScreen") {
      requirePermission("ui.call");
      onNotice?.("已触发通话界面（MVP 先以通知形式展示）。");
      return true;
    }

    if (action === "ui.confirm") {
      const message = String(record.message ?? record.title ?? "确认操作？");
      return window.confirm(message);
    }

    if (action === "memory.readCore") {
      requirePermission("memory.readCore");
      return readCustomAppCoreMemory(record);
    }
    if (action === "memory.readLongTerm") {
      requirePermission("memory.readLongTerm");
      return readCustomAppLongTermMemory(record);
    }
    if (action === "memory.readShortTerm") {
      requirePermission("memory.readShortTerm");
      const mergedRecord = {
        ...(launchContext && typeof launchContext === "object" ? launchContext : {}),
        ...record,
      };
      return readCustomAppShortTermMemory(app, mergedRecord);
    }
    if (action === "memory.search") {
      requirePermission("memory.search");
      return searchCustomAppMemory(record);
    }

    if (action === "memory.add") {
      requirePermission("memory.write");
      return addCustomAppMemory(app, record);
    }
    if (action === "memory.addTimeline") {
      requirePermission("memory.write");
      return addCustomAppTimelineEvent(app, record);
    }
    if (action === "memory.deleteTimeline" || action === "memory.removeTimeline") {
      requirePermission("memory.write");
      return deleteCustomAppTimelineEvent(app, record);
    }
    if (action === "memory.suggest") {
      requirePermission("memory.suggest");
      return suggestCustomAppMemory(app, record);
    }

    if (action === "notifications.create") {
      requirePermission("notifications.write");
      return createCustomAppNotification(app, record, onNotice);
    }
    if (action === "notifications.list") {
      requirePermission("notifications.read");
      const unreadOnly = record.unreadOnly === true;
      const limit = Math.max(1, Math.min(200, Number(record.limit ?? 100) || 100));
      return loadCustomAppNotifications(app.id).filter(item => !unreadOnly || !item.readAt).slice(0, limit);
    }
    if (action === "notifications.markRead") {
      requirePermission("notifications.write");
      return markCustomAppNotificationsRead(app.id, String(record.id ?? ""));
    }
    if (action === "notifications.markAllRead") {
      requirePermission("notifications.write");
      return markCustomAppNotificationsRead(app.id);
    }
    if (action === "notifications.getBadge") {
      requirePermission("notifications.read");
      return getCustomAppBadge(app.id);
    }
    if (action === "notifications.setBadge") {
      requirePermission("notifications.write");
      return setCustomAppBadge(app.id, Number(record.count ?? 0) || 0);
    }
    if (action === "notifications.incrementBadge") {
      requirePermission("notifications.write");
      return incrementCustomAppBadge(app.id, Number(record.delta ?? 1) || 1);
    }

    if (action === "tasks.schedule") {
      requirePermission("tasks.schedule");
      return scheduleCustomAppTask(app, record);
    }
    if (action === "tasks.list") {
      requirePermission("tasks.schedule");
      return loadCustomAppTasks(app.id);
    }
    if (action === "tasks.cancel") {
      requirePermission("tasks.schedule");
      return cancelCustomAppTask(app.id, String(record.id ?? ""));
    }

    if (action === "wallet.get") {
      requirePermission("wallet.read");
      return getWalletSnapshot();
    }
    if (action === "wallet.pay") {
      requirePermission("wallet.pay");
      return payCustomAppWallet(app, record);
    }

    throw new Error(`未知 AiPhone 动作：${action}`);
  }, [app, backgroundEvent, backgroundTool, declaredEvents, declaredToolKeys, getFrameAudioChannel, launchContext, onClose, onNotice, postBackgroundEventIfReady, postBackgroundToolIfReady, postHostEvent, requireAnyPermission, requirePermission]);

  useEffect(() => {
    if (isBackgroundRunner) return undefined;
    const handleChatMessagePushed = (event: Event) => {
      if (!hasPermission(app, "chat.read") && !hasPermission(app, "chat.read.background")) return;
      if (!subscribedEventsRef.current.has("chat.message.created") && !subscribedEventsRef.current.has("*")) return;
      const message = (event as CustomEvent<{ message?: ChatMessage }>).detail?.message;
      if (!message) return;
      const session = loadChatSessions().find(item => item.id === message.sessionId);
      postHostEvent("chat.message.created", {
        sessionId: message.sessionId,
        characterId: session?.contactId ?? "",
        isGroup: session?.isGroup === true,
        message: serializeBridgeChatMessage(message),
      });
    };
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, handleChatMessagePushed);
    return () => window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, handleChatMessagePushed);
  }, [app, isBackgroundRunner, postHostEvent]);

  useEffect(() => {
    if (isBackgroundRunner || !hasPermission(app, "chat.tools")) return undefined;
    return registerCustomAppToolExecutor(app.id, invokeOpenAppTool);
  }, [app, invokeOpenAppTool, isBackgroundRunner]);

  useEffect(() => {
    if (!backgroundEvent) return undefined;
    const timeout = window.setTimeout(() => {
      completeBackgroundEvent({
        ok: false,
        reason: backgroundEventSentRef.current ? "timeout" : "not_subscribed",
      });
    }, Math.max(1000, backgroundEvent.timeoutMs ?? CUSTOM_APP_BACKGROUND_RUNNER_TIMEOUT_MS));
    return () => window.clearTimeout(timeout);
  }, [backgroundEvent, completeBackgroundEvent]);

  useEffect(() => {
    if (!backgroundTool) return undefined;
    const timeout = window.setTimeout(() => {
      completeBackgroundTool({
        ok: false,
        reason: backgroundToolSentRef.current ? "timeout" : "handler_not_registered",
        error: backgroundToolSentRef.current
          ? `AiPhone tool timeout: ${backgroundTool.payload.tool.name}`
          : `APP 未注册工具 handler：${toolInvocationKeys(backgroundTool.payload).join(" / ")}`,
      });
    }, Math.max(1000, backgroundTool.timeoutMs ?? CUSTOM_APP_BACKGROUND_RUNNER_TIMEOUT_MS));
    return () => window.clearTimeout(timeout);
  }, [backgroundTool, completeBackgroundTool]);

  useEffect(() => (
    () => {
      for (const [requestId, pending] of pendingToolInvocationsRef.current.entries()) {
        pending.reject(new Error(`AiPhone tool canceled: ${requestId}`));
      }
      pendingToolInvocationsRef.current.clear();
    }
  ), []);

  useLayoutEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record.source !== "ai-phone-custom-app-frame" || record.frameId !== frameId) return;
      if (record.type === "event.complete") {
        if (!backgroundEvent || record.backgroundRunId !== backgroundEvent.runId) return;
        const rawErrors = Array.isArray(record.errors) ? record.errors.map(item => String(item)).filter(Boolean) : [];
        completeBackgroundEvent({
          ok: record.ok !== false && rawErrors.length === 0,
          reason: "completed",
          errors: rawErrors.length > 0 ? rawErrors : undefined,
        });
        return;
      }
      if (record.type === "tool.result") {
        const toolRequestId = String(record.toolRequestId ?? "");
        const pending = pendingToolInvocationsRef.current.get(toolRequestId);
        if (!pending) return;
        pendingToolInvocationsRef.current.delete(toolRequestId);
        if (record.ok) pending.resolve(record.result);
        else pending.reject(new Error(String(record.error ?? "AiPhone tool failed")));
        return;
      }
      if (record.type !== "request") return;
      const requestId = String(record.requestId ?? "");
      const action = String(record.action ?? "");
      if (!requestId || !action) return;
      void Promise.resolve(handleBridgeRequest(action, record.payload))
        .then(result => postResponse(requestId, true, result))
        .catch(err => postResponse(requestId, false, undefined, err instanceof Error ? err.message : String(err)));
    };
    window.addEventListener("message", handleMessage);
    setBridgeReady(true);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [backgroundEvent, completeBackgroundEvent, frameId, handleBridgeRequest, postResponse]);

  return (
    <div className={`custom-app-runner${embedded ? " custom-app-runner-embedded" : ""}`}>
      {!embedded ? (
        <div className="custom-app-runner-capsule">
          <button type="button" className="cap-btn" onClick={() => { setMenuActionError(""); setMenuOpen(true); }} aria-label="应用菜单">
            <MoreHorizontal size={15} strokeWidth={2.4} />
          </button>
          <span className="cap-divider" />
          <button type="button" className="cap-btn" onClick={onClose} aria-label={closeLabel}>
            <Circle size={13} strokeWidth={2.4} />
          </button>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        title={app.name}
        className="custom-app-runner-frame"
        sandbox="allow-scripts allow-downloads"
        allow="autoplay"
        srcDoc={bridgeReady ? srcDoc : EMPTY_CUSTOM_APP_SRC_DOC}
      />

      {menuOpen ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={() => setMenuOpen(false)}>
          <div className="app-market-sheet app-market-detail-sheet" role="dialog" aria-modal="true" aria-label="应用详情" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>应用详情</strong>
              <button type="button" onClick={() => setMenuOpen(false)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <div className="app-market-preview-row">
                <span className="app-market-app-icon large">
                  {app.iconDataUrl ? <img src={app.iconDataUrl} alt="" /> : <Layers size={28} />}
                </span>
                <div>
                  <strong>{app.name}</strong>
                  <p>{app.description || "本地自定义 APP"}</p>
                  <span>{app.author || "本地作者"} · v{app.version}</span>
                </div>
              </div>
              <div className="app-market-declaration-strip">
                {[
                  { file: "presets.json", label: "预设", Icon: Layers },
                  { file: "regex.json", label: "正则", Icon: Sparkles },
                  { file: "worldbooks.json", label: "世界书", Icon: FileJson },
                  { file: "bindings.json", label: "默认绑定", Icon: CheckCircle2 },
                ].map(item => {
                  const Icon = item.Icon;
                  const active = Object.values(app.assets).some(asset => asset.path.toLowerCase() === item.file);
                  return (
                    <span key={item.file} data-active={active}>
                      <Icon size={15} />
                      {item.label}
                    </span>
                  );
                })}
              </div>
              <div className="app-market-permissions">
                <span>已授权能力</span>
                {app.permissions.length === 0 ? (
                  <p>未声明特殊权限。</p>
                ) : (
                  <ul>
                    {app.permissions.map(permission => (
                      <li key={permission}>{permissionLabelWithContext(permission, app.manifest)}</li>
                    ))}
                  </ul>
                )}
              </div>
              {menuActionError ? <div className="app-market-error" role="alert">{menuActionError}</div> : null}
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-secondary" onClick={() => void updateCurrentApp()} disabled={updating}>
                  {updating ? <LoaderCircle className="am-spin" size={18} /> : <RefreshCw size={18} />}
                  <span>{updating ? "更新中" : "更新"}</span>
                </button>
                <button type="button" className="app-market-danger" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }} disabled={updating}>
                  <Trash2 size={18} />
                  <span>卸载</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="app-market-overlay" role="presentation" onClick={() => setConfirmDelete(false)}>
          <div className="app-market-sheet" role="dialog" aria-modal="true" aria-label="卸载 APP" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>卸载「{app.name}」？</strong>
              <button type="button" onClick={() => setConfirmDelete(false)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-delete-copy">
                将移除桌面图标、权限授权和运行文件。聊天历史里的 APP 卡片会保留。
              </p>
              <div className="app-market-sheet-actions stacked">
                <button type="button" className="app-market-secondary" onClick={() => void handleUninstall(false)}>
                  卸载并保留数据
                </button>
                <button type="button" className="app-market-danger" onClick={() => void handleUninstall(true)}>
                  卸载并删除数据
                </button>
                <button type="button" className="app-market-secondary" onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
