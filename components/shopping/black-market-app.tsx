"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronLeft,
  Copy,
  Eye,
  FileText,
  Pencil,
  Plus,
  MoreHorizontal,
  PenLine,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { kvGet, kvSet } from "@/lib/kv-db";

import {
  BLACK_MARKET_DAILY_CHECKIN_CREDITS,
  BLACK_MARKET_UPDATED_EVENT,
  copyBlackMarketTheaterToVault,
  discardBlackMarketSceneSession,
  deleteBlackMarketTheaterProjectionEvent,
  deleteBlackMarketOwnedTheater,
  formatShadowCredits,
  getBlackMarketCatalog,
  getBlackMarketSceneSession,
  appendBlackMarketSceneMessage,
  loadAllBlackMarketTheaterProjectionEntries,
  loadBlackMarketSceneSessions,
  loadBlackMarketState,
  startBlackMarketSceneSession,
  syncBlackMarketWallet,
  syncOwnedBlackMarketTheaterSnapshot,
  trimBlackMarketSceneMessagesFrom,
  updateBlackMarketSceneMessageAndTrimAfter,
} from "@/lib/black-market-storage";
import {
  expandBlackMarketMacros,
  generateBlackMarketSceneReply,
  summarizeAndRecordBlackMarketScene,
} from "@/lib/black-market-scene-engine";
import {
  checkInBlackMarketCloud,
  deleteBlackMarketTheater,
  fetchBlackMarketTheater,
  fetchPurchasedBlackMarketTheatersCloud,
  fetchBlackMarketTheaters,
  fetchBlackMarketWallet,
  publishBlackMarketTheater,
  purchaseBlackMarketTheaterCloud,
  updateBlackMarketTheater,
} from "@/lib/black-market-client";
import { useAccount } from "@/lib/account-context";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { BlackMarketOwnedTheater, BlackMarketRenderRule, BlackMarketSceneSession, BlackMarketState, BlackMarketTheaterProjectionEntry, BlackMarketTheaterTemplate } from "@/lib/black-market-types";
import { IFRAME_ERROR_CAPTURE_SCRIPT } from "@/lib/qa-iframe-error-bridge";

type BlackMarketAppProps = {
  onClose: () => void;
};

type BlackMarketTab = "market" | "vault" | "ledger" | "studio";
type BlackMarketStudioMode = "published" | "drafts" | "create";
type BlackMarketPreviewMode = "info" | "opening";
type BlackMarketSceneBusy = "reply" | "summary" | null;
type BlackMarketDeleteTarget =
  | { kind: "owned"; localId: string }
  | { kind: "published"; templateId: string };
type BlackMarketExternalCanvasRequest = "start" | "resume" | null;
type BlackMarketSceneConfirmAction = "return" | "archive" | "restart" | "summary";
type BlackMarketPublishChoice = {
  sourceTemplateId: string;
  sourceTemplateTitle: string;
};

type BlackMarketNotice = {
  id: number;
  tone: "success" | "error" | "info";
  text: string;
};

const MARKET_TABS: Array<{ id: BlackMarketTab; label: string }> = [
  { id: "market", label: "市场" },
  { id: "vault", label: "暗柜" },
  { id: "ledger", label: "流水" },
  { id: "studio", label: "发布" },
];

const BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT = 320;
const BLACK_MARKET_THEATER_FRAME_COLLAPSE_THRESHOLD = 900;
const BLACK_MARKET_THEATER_FRAME_COLLAPSED_HEIGHT = 620;
const BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT = 90;
const BLACK_MARKET_STUDIO_DRAFTS_KEY = "ai_phone_black_market_studio_drafts_v1";
const BLACK_MARKET_STUDIO_TEST_USER_SAMPLE = "你刚才到底想隐瞒什么？";
const BLACK_MARKET_STUDIO_TEST_ASSISTANT_SAMPLE = `*他猛地攥紧袖口，呼吸停了一拍。*

【秘密】我确实一直知道答案，只是我不想让你听见我亲口承认。

\`\`\`html
<style>
  body{margin:0;background:#050608;color:#ecfdf5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px}
  .probe{border:1px solid rgba(0,255,102,.28);padding:12px;background:rgba(0,255,102,.06)}
  button{margin-top:10px;border:1px solid #00ff66;background:transparent;color:#00ff66;padding:8px 10px}
</style>
<div class="probe">
  <b>INTERACTION TEST</b>
  <p>这是一段 ASSISTANT 回复中的 html 画布。</p>
  <button data-action="继续追问这个秘密">继续追问</button>
</div>
\`\`\``;

type TheaterDraft = {
  title: string;
  codeName: string;
  subtitle: string;
  synopsis: string;
  storyText: string;
  tagsText: string;
  price: string;
  authorName: string;
  openingHtml: string;
  allowExternalControl: boolean;
  aiInstruction: string;
  outputContract: string;
  renderRulesText: string;
  renderCss: string;
  memorySummaryPrompt: string;
};

type BlackMarketStudioDraft = {
  id: string;
  title: string;
  draft: TheaterDraft;
  sourceTemplateId?: string;
  sourceTemplateTitle?: string;
  createdAt: string;
  updatedAt: string;
};

function formatBlackMarketDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function generateBlackMarketFileNumber(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const prefix = letters[Math.floor(Math.random() * letters.length)] || "X";
  const slot = Math.floor(Math.random() * 10);
  const suffix = Date.now().toString(36).slice(-3).toUpperCase();
  return `${prefix}${slot}-${suffix}`;
}

function getBlackMarketFileNumber(template: BlackMarketTheaterTemplate): string {
  return template.fileNumber?.trim() || "AUTO";
}

function isFullBlackMarketTheater(template: BlackMarketTheaterTemplate): boolean {
  return Boolean(template.openingHtml && template.aiInstruction);
}

function escapeSceneHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeRenderHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

function sanitizeRenderCss(value: string): string {
  return value.replace(/<\/?style\b[^>]*>/gi, "").replace(/<\/?script\b[^>]*>/gi, "");
}

function preserveRenderedHtmlSegment(value: string): string {
  return escapeSceneHtml(value).replace(/\n/g, "<br />");
}

function restoreRenderedHtmlMarkers(html: string, renderedSegments: Array<{ marker: string; html: string }>): string {
  let restored = html;
  for (let pass = 0; pass <= renderedSegments.length; pass += 1) {
    let changed = false;
    for (const segment of renderedSegments) {
      if (!restored.includes(segment.marker)) continue;
      restored = restored.split(segment.marker).join(segment.html);
      changed = true;
    }
    if (!changed) break;
  }
  return restored.replace(/\uE000BM_RENDER_\d+\uE000/g, "");
}

type BlackMarketReplySegment =
  | { type: "text"; content: string }
  | { type: "html"; content: string };

function splitBlackMarketReplyContent(content: string): BlackMarketReplySegment[] {
  const segments: BlackMarketReplySegment[] = [];
  const regex = /```html[^\n]*\n([\s\S]*?)```/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index);
    if (before.trim()) segments.push({ type: "text", content: before });
    const html = match[1]?.trim();
    if (html) segments.push({ type: "html", content: html });
    lastIndex = match.index + match[0].length;
  }

  const rest = content.slice(lastIndex);
  if (rest.trim()) segments.push({ type: "text", content: rest });
  return segments.length > 0 ? segments : [{ type: "text", content }];
}

function normalizeRegexFlags(flags: string): string {
  const unique = Array.from(new Set(flags.split("").filter(flag => "dgimsuvy".includes(flag))));
  if (!unique.includes("g")) unique.push("g");
  return unique.join("");
}

function createBlackMarketTheaterFrameSrcDoc(html: string, frameId: string): string {
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

  const bridge = `<style>
html,body{
  overflow:hidden!important;
  -webkit-overflow-scrolling:touch;
  min-height:0!important;
}
</style>
<script>
(function(){
  var frameId = ${JSON.stringify(frameId)};
  function measureHeight(){
    var body = document.body;
    if (!body) return ${BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT};
    var bodyRect = body.getBoundingClientRect();
    var height = bodyRect.height;
    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i];
      var rect = child.getBoundingClientRect();
      if (rect.width || rect.height) height = Math.max(height, rect.bottom - bodyRect.top);
    }
    return Math.max(Math.ceil(height), ${BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT});
  }
  function sendHeight(){
    var height = measureHeight();
    parent.postMessage({ source: 'black-market-theater-frame', type: 'resize', id: frameId, height: height }, '*');
  }
  function scheduleHeight(){
    requestAnimationFrame(function(){
      sendHeight();
      requestAnimationFrame(sendHeight);
    });
  }
  var existing = window.Theater || {};
  window.Theater = Object.assign({
    startScene: function(payload){ parent.postMessage({ source:'black-market-theater', type:'startScene', payload: payload || {} }, '*'); },
    sendUserAction: function(text){ parent.postMessage({ source:'black-market-theater', type:'sendUserAction', text: text || '' }, '*'); },
    endScene: function(){ parent.postMessage({ source:'black-market-theater', type:'endScene' }, '*'); }
  }, existing);
  window.addEventListener('load', scheduleHeight);
  window.addEventListener('resize', scheduleHeight);
  document.addEventListener('click', scheduleHeight, true);
  document.addEventListener('toggle', scheduleHeight, true);
  document.addEventListener('transitionend', scheduleHeight, true);
  document.addEventListener('animationend', scheduleHeight, true);
  if (window.MutationObserver) {
    new MutationObserver(scheduleHeight).observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(scheduleHeight);
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }
  setTimeout(sendHeight, 80);
  setTimeout(sendHeight, 500);
  setTimeout(sendHeight, 1600);
})();
</script>`;

  return /<\/body>/i.test(base) ? base.replace(/<\/body>/i, `${IFRAME_ERROR_CAPTURE_SCRIPT}${bridge}</body>`) : `${base}${IFRAME_ERROR_CAPTURE_SCRIPT}${bridge}`;
}

function createBlackMarketReplyFrameSrcDoc(html: string, frameId: string): string {
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

  const bridge = `<script>
(function(){
  var frameId = ${JSON.stringify(frameId)};
  function measureHeight(){
    var body = document.body;
    if (!body) return ${BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT};
    var bodyRect = body.getBoundingClientRect();
    var height = bodyRect.height;
    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i];
      var rect = child.getBoundingClientRect();
      if (rect.width || rect.height) height = Math.max(height, rect.bottom - bodyRect.top);
    }
    return Math.max(Math.ceil(height), ${BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT});
  }
  function sendHeight(){
    var height = measureHeight();
    parent.postMessage({ source: 'black-market-reply-canvas', type: 'resize', id: frameId, height: height }, '*');
  }
  function scheduleHeight(){
    requestAnimationFrame(function(){
      sendHeight();
      requestAnimationFrame(sendHeight);
    });
  }
  window.Theater = window.Theater || {
    startScene: function(payload){ parent.postMessage({ source:'black-market-theater', type:'startScene', payload: payload || {} }, '*'); },
    sendUserAction: function(text){ parent.postMessage({ source:'black-market-theater', type:'sendUserAction', text: text || '' }, '*'); },
    endScene: function(){ parent.postMessage({ source:'black-market-theater', type:'endScene' }, '*'); }
  };
  document.addEventListener('click', function(event){
    var target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target) return;
    event.preventDefault();
    parent.postMessage({ source:'black-market-theater', type:'sendUserAction', text: target.getAttribute('data-action') || target.textContent || '' }, '*');
  }, true);
  window.addEventListener('load', scheduleHeight);
  window.addEventListener('resize', scheduleHeight);
  document.addEventListener('click', scheduleHeight, true);
  document.addEventListener('toggle', scheduleHeight, true);
  document.addEventListener('transitionend', scheduleHeight, true);
  document.addEventListener('animationend', scheduleHeight, true);
  if (window.MutationObserver) {
    new MutationObserver(scheduleHeight).observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(scheduleHeight);
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }
  setTimeout(sendHeight, 80);
  setTimeout(sendHeight, 500);
  setTimeout(sendHeight, 1600);
})();
</script>`;

  return /<\/body>/i.test(base) ? base.replace(/<\/body>/i, `${IFRAME_ERROR_CAPTURE_SCRIPT}${bridge}</body>`) : `${base}${IFRAME_ERROR_CAPTURE_SCRIPT}${bridge}`;
}

function BlackMarketTheaterHtmlFrame({
  html,
  title,
  allowExternalControl = false,
  collapsible = false,
}: {
  html: string;
  title: string;
  allowExternalControl?: boolean;
  collapsible?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameId] = useState(() => `bm_theater_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const [height, setHeight] = useState(BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const srcDoc = useMemo(() => createBlackMarketTheaterFrameSrcDoc(html, frameId), [frameId, html]);
  const canCollapse = collapsible && height > BLACK_MARKET_THEATER_FRAME_COLLAPSE_THRESHOLD;
  const displayedHeight = canCollapse && collapsed
    ? Math.min(height, BLACK_MARKET_THEATER_FRAME_COLLAPSED_HEIGHT)
    : height;

  useEffect(() => {
    setCollapsed(false);
  }, [html]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      const isBridgeResize = record.source === "black-market-theater-frame" && record.type === "resize" && record.id === frameId;
      const isLegacyResize = record.source === "black-market-theater" && record.type === "resize";
      if (!isBridgeResize && !isLegacyResize) return;
      const nextHeight = Number(record.height);
      if (!Number.isFinite(nextHeight)) return;
      setHeight(Math.max(BLACK_MARKET_THEATER_FRAME_MIN_HEIGHT, Math.round(nextHeight)));
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameId]);

  return (
    <div className="cp-black-market-frame-wrap">
      <iframe
        ref={iframeRef}
        title={title}
        className="cp-black-market-preview-frame"
        sandbox={allowExternalControl ? "allow-scripts allow-same-origin" : "allow-scripts"}
        allow="autoplay"
        scrolling="no"
        srcDoc={srcDoc}
        style={{ height: displayedHeight, touchAction: "pan-y" }}
      />
      {canCollapse ? (
        <button
          type="button"
          className="cp-black-market-frame-toggle"
          onClick={() => setCollapsed(value => !value)}
        >
          {collapsed ? "展开完整开场" : "收起开场"}
        </button>
      ) : null}
    </div>
  );
}

function renderSceneMessageHtml(content: string, template?: BlackMarketTheaterTemplate): string {
  let text = content;
  const renderedSegments: Array<{ marker: string; html: string }> = [];
  if (!template || template.renderRules.length === 0) return escapeSceneHtml(text).replace(/\n/g, "<br />");
  for (const rule of template.renderRules) {
    try {
      const regex = new RegExp(rule.pattern, normalizeRegexFlags(rule.flags));
      text = text.replace(regex, (...args: unknown[]) => {
        const full = String(args[0] ?? "");
        const hasNamedGroups = typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
        const captureEnd = hasNamedGroups ? args.length - 3 : args.length - 2;
        const captures = args.slice(1, captureEnd).map(value => String(value ?? ""));
        const namedGroups = hasNamedGroups ? args[args.length - 1] as Record<string, unknown> : null;
        let output = rule.template || "<span>$&</span>";
        output = output.replace(/\$&/g, preserveRenderedHtmlSegment(full));
        captures.forEach((capture, index) => {
          output = output.replace(new RegExp(`\\$${index + 1}`, "g"), preserveRenderedHtmlSegment(capture));
        });
        if (namedGroups) {
          output = output.replace(/\$<([^>]+)>/g, (_match, name: string) => preserveRenderedHtmlSegment(String(namedGroups[name] ?? "")));
        }
        const marker = `\uE000BM_RENDER_${renderedSegments.length}\uE000`;
        renderedSegments.push({ marker, html: sanitizeRenderHtml(output) });
        return marker;
      });
    } catch {
      continue;
    }
  }
  const html = escapeSceneHtml(text).replace(/\n/g, "<br />");
  return restoreRenderedHtmlMarkers(html, renderedSegments);
}

function BlackMarketReplyHtmlFrame({ html, title, allowExternalControl = false }: { html: string; title: string; allowExternalControl?: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameId] = useState(() => `bm_reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const [height, setHeight] = useState(BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT);
  const srcDoc = useMemo(() => createBlackMarketReplyFrameSrcDoc(html, frameId), [frameId, html]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record.source !== "black-market-reply-canvas" || record.type !== "resize" || record.id !== frameId) return;
      const nextHeight = Number(record.height);
      if (!Number.isFinite(nextHeight)) return;
      setHeight(Math.max(BLACK_MARKET_REPLY_FRAME_MIN_HEIGHT, Math.round(nextHeight)));
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameId]);

  return (
    <iframe
      ref={iframeRef}
      title={title}
      className="cp-black-market-reply-frame"
      sandbox={allowExternalControl ? "allow-scripts allow-same-origin" : "allow-scripts"}
      allow="autoplay"
      srcDoc={srcDoc}
      style={{ height }}
    />
  );
}

function BlackMarketSceneMessageContent({
  content,
  template,
  characterName,
  userName,
  messageId,
  allowExternalControl = false,
}: {
  content: string;
  template: BlackMarketTheaterTemplate;
  characterName: string;
  userName: string;
  messageId: string;
  allowExternalControl?: boolean;
}) {
  const segments = useMemo(() => splitBlackMarketReplyContent(content), [content]);

  return (
    <div className="cp-black-market-scene-message-body">
      {segments.map((segment, index) => {
        if (segment.type === "html") {
          return (
            <BlackMarketReplyHtmlFrame
              key={`${messageId}-html-${index}`}
              title={`小剧场回复画布 ${index + 1}`}
              html={expandBlackMarketMacros(segment.content, characterName, userName)}
              allowExternalControl={allowExternalControl}
            />
          );
        }
        return (
          <div
            key={`${messageId}-text-${index}`}
            className="cp-black-market-scene-text-segment"
            dangerouslySetInnerHTML={{ __html: renderSceneMessageHtml(segment.content, template) }}
          />
        );
      })}
    </div>
  );
}

function resolveOwnedTemplateIds(state: BlackMarketState): Set<string> {
  return new Set(state.ownedTheaters.map(item => item.remoteTemplateId));
}

function createStarterOpeningHtml(title = "自定义夜间档案", codeName = "CUSTOM_THEATER"): string {
  return String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    *{box-sizing:border-box}
    html,body{margin:0;background:#050608;color:#ecfdf5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
    body{min-height:100%;display:grid;place-items:center;padding:18px}
    .card{width:min(100%,360px);background:#080c0a;border:1px solid rgba(82,255,158,.22);padding:18px;box-shadow:0 22px 60px rgba(0,0,0,.42)}
    .label{font-size: calc(10px*var(--app-text-scale,1));color:#52ff9e;letter-spacing:.12em}
    h1{margin:9px 0 4px;font-size: calc(23px*var(--app-text-scale,1));line-height:1}
    p{margin:0;color:#a8b7b0;font:calc(13px*var(--app-text-scale,1))/1.7 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-wrap}
    button{margin-top:16px;min-height:38px;border:0;background:#52ff9e;color:#050608;font:800 calc(12px*var(--app-text-scale,1)) ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0 14px;cursor:pointer}
  </style>
</head>
<body>
  <main class="card">
    <div class="label">${codeName} // OPENING CANVAS</div>
    <h1>${title}</h1>
    <p>在这里写 {{user}} 点击“启封档案”后看到的开场剧情、按钮、动画和交互。
可以使用 {{char}} 和 {{user}} 宏；真正启封时会替换为当前角色和绑定用户人设名。</p>
    <button onclick="Theater.startScene({custom:true})">启封剧情</button>
  </main>
  <script>
    window.Theater = window.Theater || {
      startScene: function(payload){ parent.postMessage({ source:'black-market-theater', type:'startScene', payload: payload || {} }, '*'); },
      sendUserAction: function(text){ parent.postMessage({ source:'black-market-theater', type:'sendUserAction', text: text || '' }, '*'); },
      endScene: function(){ parent.postMessage({ source:'black-market-theater', type:'endScene' }, '*'); }
    };
    parent.postMessage({ source:'black-market-theater', type:'resize', height: document.documentElement.scrollHeight }, '*');
  </script>
</body>
</html>`;
}

function createDefaultDraft(): TheaterDraft {
  const defaultIntro = "写一段抓人的档案介绍：事件起源、开场局面、{{user}} 为什么会被卷进去。";
  return {
    title: "未命名夜间档案",
    codeName: "CUSTOM_THEATER",
    subtitle: "",
    synopsis: defaultIntro,
    storyText: defaultIntro,
    tagsText: "剧情,互动,自定义",
    price: "120",
    authorName: "匿名卖家",
    openingHtml: createStarterOpeningHtml(),
    allowExternalControl: false,
    aiInstruction: [
      "【当前剧情背景】{{user}} 刚刚启封了一份自定义夜间档案，{{char}} 被卷入这段剧情。请根据开场剧情继续演绎。",
      "【状态强制锁定】在本次夜间通道中，你必须遵守作者设定的剧情规则，不要跳出角色，不要解释系统。",
      "【行为演绎】结合你原本的人设、与玩家的关系、当前事件压力，给出有动作、有情绪、有推进的回应。",
      "【下一步行动】回应玩家刚刚说的话，并把剧情往下一步推动。",
    ].join("\n"),
    outputContract: "动作描写用 *动作* 包裹。重要心理活动可使用【失控】或【秘密】标记，便于自定义样式渲染。需要完整交互回复时，可以输出 ```html 代码块```，该代码块会作为独立回复画布渲染。",
    renderRulesText: JSON.stringify([
      {
        id: "stage",
        name: "舞台动作",
        pattern: "\\*([^*]{1,160})\\*",
        flags: "g",
        className: "bm-stage-action",
        template: "<span class=\"bm-stage-action\">$1</span>",
      },
      {
        id: "secret",
        name: "秘密揭露",
        pattern: "【秘密】\\s*([\\s\\S]*?)(?=\\n?【(?:失控|秘密|反应)】|$)",
        flags: "g",
        className: "bm-secret-line",
        template: "<div class=\"bm-secret-line\">$1</div>",
      },
    ], null, 2),
    renderCss: [
      ".bm-stage-action{color:#6b7280;font-style:italic;}",
      ".bm-secret-line{margin:8px 0;padding:10px 12px;background:#111827;color:#f9fafb;font-size: calc(13px*var(--app-text-scale,1));line-height:1.55;}",
    ].join("\n"),
    memorySummaryPrompt: "请总结本次夜间通道中发生的关键事件、角色暴露出的态度变化、玩家做出的重要选择，写成 1 条短期记忆。",
  };
}

function createStudioDraftId(): string {
  return `bm_draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStudioDraftPayload(value: unknown): TheaterDraft {
  const fallback = createDefaultDraft();
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  return {
    title: String(record.title ?? fallback.title),
    codeName: String(record.codeName ?? fallback.codeName),
    subtitle: String(record.subtitle ?? fallback.subtitle),
    synopsis: String(record.synopsis ?? fallback.synopsis),
    storyText: String(record.storyText ?? fallback.storyText),
    tagsText: String(record.tagsText ?? fallback.tagsText),
    price: String(record.price ?? fallback.price),
    authorName: String(record.authorName ?? fallback.authorName),
    openingHtml: String(record.openingHtml ?? fallback.openingHtml),
    allowExternalControl: record.allowExternalControl === true,
    aiInstruction: String(record.aiInstruction ?? fallback.aiInstruction),
    outputContract: String(record.outputContract ?? fallback.outputContract),
    renderRulesText: String(record.renderRulesText ?? fallback.renderRulesText),
    renderCss: String(record.renderCss ?? fallback.renderCss),
    memorySummaryPrompt: String(record.memorySummaryPrompt ?? fallback.memorySummaryPrompt),
  };
}

function normalizeStudioDraftRecord(value: unknown): BlackMarketStudioDraft | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = String(record.id ?? "").trim();
  if (!id) return null;
  const draft = normalizeStudioDraftPayload(record.draft);
  const now = new Date().toISOString();
  return {
    id,
    title: String(record.title ?? draft.title ?? "未命名草稿").trim() || "未命名草稿",
    draft,
    sourceTemplateId: String(record.sourceTemplateId ?? "").trim() || undefined,
    sourceTemplateTitle: String(record.sourceTemplateTitle ?? "").trim() || undefined,
    createdAt: String(record.createdAt ?? now),
    updatedAt: String(record.updatedAt ?? now),
  };
}

function loadBlackMarketStudioDrafts(): BlackMarketStudioDraft[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(kvGet(BLACK_MARKET_STUDIO_DRAFTS_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStudioDraftRecord)
      .filter((item): item is BlackMarketStudioDraft => Boolean(item))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function saveBlackMarketStudioDrafts(items: BlackMarketStudioDraft[]): BlackMarketStudioDraft[] {
  const next = items.slice(0, 80).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (typeof window !== "undefined") {
    kvSet(BLACK_MARKET_STUDIO_DRAFTS_KEY, JSON.stringify(next));
  }
  return next;
}

function createDraftFromTemplate(template: BlackMarketTheaterTemplate): TheaterDraft {
  return {
    title: template.title,
    codeName: template.codeName,
    subtitle: template.subtitle,
    synopsis: template.synopsis,
    storyText: template.storyText,
    tagsText: template.tags.join(","),
    price: String(template.price),
    authorName: template.authorName,
    openingHtml: template.openingHtml,
    allowExternalControl: template.allowExternalControl,
    aiInstruction: template.aiInstruction,
    outputContract: template.outputContract,
    renderRulesText: JSON.stringify(template.renderRules, null, 2),
    renderCss: template.renderCss,
    memorySummaryPrompt: template.memorySummaryPrompt,
  };
}

function parseDraftRenderRules(source: string): BlackMarketRenderRule[] {
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed)) throw new Error("渲染规则必须是 JSON 数组。");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 条渲染规则格式错误。`);
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    const pattern = String(record.pattern ?? "").trim();
    if (!id || !pattern) throw new Error(`第 ${index + 1} 条渲染规则缺少 id 或 pattern。`);
    return {
      id,
      name: String(record.name ?? "渲染规则").trim().slice(0, 80),
      pattern,
      flags: String(record.flags ?? "g").trim().slice(0, 12) || "g",
      className: String(record.className ?? "bm-render-rule").trim().slice(0, 120) || "bm-render-rule",
      template: String(record.template ?? "<span>$&</span>").trim().slice(0, 2000) || "<span>$&</span>",
    };
  });
}

function createDraftPreviewTemplate(draft: TheaterDraft, renderRules: BlackMarketRenderRule[]): BlackMarketTheaterTemplate {
  return {
    id: "draft_preview",
    title: draft.title || "测试夜间档案",
    codeName: draft.codeName || "DRAFT_PREVIEW",
    fileNumber: "AUTO",
    subtitle: draft.subtitle,
    synopsis: draft.synopsis,
    storyText: draft.storyText,
    tags: draft.tagsText.split(/[,\s，、]+/).map(item => item.trim()).filter(Boolean).slice(0, 8),
    rarity: "common",
    glyph: "◆",
    price: Number(draft.price) || 0,
    authorId: "draft_preview",
    authorName: draft.authorName || "匿名卖家",
    source: "local",
    version: 1,
    durationTurns: 8,
    allowExternalControl: draft.allowExternalControl,
    openingHtml: draft.openingHtml,
    aiInstruction: draft.aiInstruction,
    outputContract: draft.outputContract,
    renderRules,
    renderCss: draft.renderCss,
    memorySummaryPrompt: draft.memorySummaryPrompt,
    purchaseCount: 0,
    rating: 0,
    createdAt: "",
    updatedAt: "",
  };
}

export function BlackMarketApp({ onClose }: BlackMarketAppProps) {
  const { account } = useAccount();
  const [state, setState] = useState<BlackMarketState>(() => loadBlackMarketState());
  const [theaterRecords, setTheaterRecords] = useState<BlackMarketTheaterProjectionEntry[]>(() => loadAllBlackMarketTheaterProjectionEntries());
  const [selectedTab, setSelectedTab] = useState<BlackMarketTab>("market");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedTemplateMode, setSelectedTemplateMode] = useState<BlackMarketPreviewMode>("info");
  const [notice, setNotice] = useState<BlackMarketNotice | null>(null);
  const [communityTheaters, setCommunityTheaters] = useState<BlackMarketTheaterTemplate[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState<"sync" | "checkin" | "purchase" | null>(null);
  const [studioMode, setStudioMode] = useState<BlackMarketStudioMode>("published");
  const defaultDraft = useMemo(() => createDefaultDraft(), []);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [studioDrafts, setStudioDrafts] = useState<BlackMarketStudioDraft[]>(() => loadBlackMarketStudioDrafts());
  const [draft, setDraft] = useState<TheaterDraft>(() => createDefaultDraft());
  const [publishing, setPublishing] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BlackMarketDeleteTarget | null>(null);
  const [publishChoice, setPublishChoice] = useState<BlackMarketPublishChoice | null>(null);
  const [recordMenuId, setRecordMenuId] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [terminalTime, setTerminalTime] = useState("00:00:00");
  const [latency, setLatency] = useState(147);
  const [launchOwnedId, setLaunchOwnedId] = useState<string | null>(null);
  const [launchCharacterId, setLaunchCharacterId] = useState("");
  const [activeScene, setActiveScene] = useState<BlackMarketSceneSession | null>(null);
  const [externalCanvasAllowed, setExternalCanvasAllowed] = useState(false);
  const [externalCanvasRequest, setExternalCanvasRequest] = useState<BlackMarketExternalCanvasRequest>(null);
  const [sceneConfirmAction, setSceneConfirmAction] = useState<BlackMarketSceneConfirmAction | null>(null);
  const [sceneInput, setSceneInput] = useState("");
  const [editingSceneMessageId, setEditingSceneMessageId] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState<BlackMarketSceneBusy>(null);
  const [studioTestUserMessage, setStudioTestUserMessage] = useState(BLACK_MARKET_STUDIO_TEST_USER_SAMPLE);
  const [studioTestAssistantMessage, setStudioTestAssistantMessage] = useState(BLACK_MARKET_STUDIO_TEST_ASSISTANT_SAMPLE);
  const fullTheaterRequestsRef = useRef<Record<string, Promise<BlackMarketTheaterTemplate>>>({});

  const builtinCatalog = useMemo(() => getBlackMarketCatalog(), []);
  const characters = useMemo(() => loadCharacters(), []);
  const catalog = useMemo(() => {
    const seen = new Set<string>();
    return [...communityTheaters, ...builtinCatalog].filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }, [builtinCatalog, communityTheaters]);
  const ownedTemplateIds = useMemo(() => resolveOwnedTemplateIds(state), [state]);
  const publishedTheaters = useMemo(
    () => communityTheaters.filter(item => item.authorId === account.id || item.authorId === "local_user"),
    [account.id, communityTheaters],
  );
  const selectedTemplate = useMemo(
    () => catalog.find(item => item.id === selectedTemplateId) ?? null,
    [catalog, selectedTemplateId],
  );
  const launchOwnedTheater = useMemo(
    () => state.ownedTheaters.find(item => item.localId === launchOwnedId) ?? null,
    [launchOwnedId, state.ownedTheaters],
  );
  const selectedOwnedTheater = useMemo(
    () => selectedTemplate ? state.ownedTheaters.find(item => item.remoteTemplateId === selectedTemplate.id) ?? null : null,
    [selectedTemplate, state.ownedTheaters],
  );
  const pendingDeleteOwned = useMemo(
    () => deleteTarget?.kind === "owned"
      ? state.ownedTheaters.find(item => item.localId === deleteTarget.localId) ?? null
      : null,
    [deleteTarget, state.ownedTheaters],
  );
  const pendingDeletePublished = useMemo(
    () => deleteTarget?.kind === "published"
      ? communityTheaters.find(item => item.id === deleteTarget.templateId) ?? null
      : null,
    [deleteTarget, communityTheaters],
  );
  const launchCharacter = useMemo(
    () => characters.find(item => item.id === launchCharacterId) ?? null,
    [characters, launchCharacterId],
  );
  const editingTemplate = useMemo(
    () => editingTemplateId ? communityTheaters.find(item => item.id === editingTemplateId) ?? null : null,
    [communityTheaters, editingTemplateId],
  );
  const editingStudioDraft = useMemo(
    () => editingDraftId ? studioDrafts.find(item => item.id === editingDraftId) ?? null : null,
    [editingDraftId, studioDrafts],
  );
  const publishChoiceSourceTemplate = useMemo(
    () => publishChoice ? communityTheaters.find(item => item.id === publishChoice.sourceTemplateId) ?? null : null,
    [communityTheaters, publishChoice],
  );
  const resumableLaunchScene = useMemo(() => {
    if (!launchOwnedTheater || !launchCharacterId) return null;
    return loadBlackMarketSceneSessions().find(session =>
      session.localTheaterId === launchOwnedTheater.localId
      && session.characterId === launchCharacterId
      && session.status === "active"
    ) ?? null;
  }, [launchCharacterId, launchOwnedTheater, state]);
  const launchActiveCharacterIds = useMemo(() => {
    if (!launchOwnedTheater) return new Set<string>();
    return new Set(loadBlackMarketSceneSessions()
      .filter(session => session.localTheaterId === launchOwnedTheater.localId && session.status === "active")
      .map(session => session.characterId));
  }, [launchOwnedTheater, state]);
  const draftPreviewRenderRules = useMemo(() => {
    try {
      return parseDraftRenderRules(draft.renderRulesText);
    } catch {
      return [];
    }
  }, [draft.renderRulesText]);
  const draftPreviewTemplate = useMemo(
    () => createDraftPreviewTemplate(draft, draftPreviewRenderRules),
    [draft, draftPreviewRenderRules],
  );

  useEffect(() => {
    const syncState = () => {
      setState(loadBlackMarketState());
      setTheaterRecords(loadAllBlackMarketTheaterProjectionEntries());
    };
    window.addEventListener(BLACK_MARKET_UPDATED_EVENT, syncState);
    return () => window.removeEventListener(BLACK_MARKET_UPDATED_EVENT, syncState);
  }, []);

  useEffect(() => {
    if (!recordMenuId) return undefined;
    const closeRecordMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".cp-black-market-record-menu")) return;
      setRecordMenuId(null);
    };
    document.addEventListener("pointerdown", closeRecordMenu);
    return () => document.removeEventListener("pointerdown", closeRecordMenu);
  }, [recordMenuId]);

  useEffect(() => {
    void loadCommunityTheaters();
  }, []);

  useEffect(() => {
    let active = true;
    setWalletBusy("sync");
    Promise.all([fetchBlackMarketWallet(), fetchPurchasedBlackMarketTheatersCloud()])
      .then(([wallet, purchasedTheaters]) => {
        if (!active) return;
        syncBlackMarketWallet(wallet);
        const added = copyPurchasedTheatersToVault(purchasedTheaters);
        if (added > 0) {
          setNotice({ id: Date.now(), tone: "info", text: `已恢复 ${added} 份已购夜间档案` });
        }
      })
      .catch(err => {
        if (!active) return;
        const message = err instanceof Error ? err.message : "黑市钱包同步失败";
        setNotice({ id: Date.now(), tone: "error", text: message });
      })
      .finally(() => {
        if (active) setWalletBusy(null);
      });
    return () => {
      active = false;
    };
  }, [account.id]);

  useEffect(() => {
    const tick = () => {
      const date = new Date();
      const pad = (value: number) => String(value).padStart(2, "0");
      setTerminalTime(`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLatency(118 + Math.floor(Math.random() * 74));
    }, 2600);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record.source !== "black-market-theater") return;
      if (record.type === "resize") return;
      if (record.type === "startScene") {
        setNotice({ id: Date.now(), tone: "info", text: activeScene ? "开场画布已就绪，请输入你的行动。" : "请先选择角色并进入小剧场。" });
      }
      if (record.type === "sendUserAction") {
        const text = String(record.text ?? "").trim();
        if (text) {
          if (activeScene) {
            void handleSceneSubmit(text);
          } else {
            setSceneInput(text);
            setNotice({ id: Date.now(), tone: "info", text: "已读取画布行动，请先选择角色进入小剧场。" });
          }
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [activeScene, sceneBusy, sceneInput]);

  function showNotice(tone: BlackMarketNotice["tone"], text: string): void {
    setNotice({ id: Date.now(), tone, text });
  }

  async function ensureFullTheaterTemplate(template: BlackMarketTheaterTemplate): Promise<BlackMarketTheaterTemplate> {
    if (template.source !== "community" || isFullBlackMarketTheater(template)) return template;
    const current = communityTheaters.find(item => item.id === template.id);
    if (current && isFullBlackMarketTheater(current)) return current;
    let request = fullTheaterRequestsRef.current[template.id];
    if (!request) {
      request = fetchBlackMarketTheater(template.id).finally(() => {
        delete fullTheaterRequestsRef.current[template.id];
      });
      fullTheaterRequestsRef.current[template.id] = request;
    }
    const fullTemplate = await request;
    setCommunityTheaters(currentTheaters => [fullTemplate, ...currentTheaters.filter(item => item.id !== fullTemplate.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    return fullTemplate;
  }

  function copyPurchasedTheatersToVault(theaters: BlackMarketTheaterTemplate[]): number {
    const known = new Set(loadBlackMarketState().ownedTheaters.map(item => item.remoteTemplateId));
    let added = 0;
    for (const theater of theaters) {
      if (known.has(theater.id)) continue;
      const result = copyBlackMarketTheaterToVault(theater);
      if (result.ok) {
        known.add(theater.id);
        added += 1;
      }
    }
    setState(loadBlackMarketState());
    return added;
  }

  async function restorePurchasedTheatersFromCloud(): Promise<number> {
    const purchased = await fetchPurchasedBlackMarketTheatersCloud();
    return copyPurchasedTheatersToVault(purchased);
  }

  function closeTemplatePreview(): void {
    setSelectedTemplateId(null);
    setSelectedTemplateMode("info");
  }

  function openTemplateInfo(templateId: string): void {
    setSelectedTemplateMode("info");
    setSelectedTemplateId(templateId);
    const template = catalog.find(item => item.id === templateId);
    if (template && template.source === "community" && !isFullBlackMarketTheater(template)) {
      void ensureFullTheaterTemplate(template).catch(err => {
        showNotice("error", err instanceof Error ? err.message : "夜间档案详情加载失败");
      });
    }
  }

  function resolveSceneUserName(character?: Character | null): string {
    if (!character) return "用户";
    return resolveUserIdentity(character.id, "shopping")?.name?.trim()
      || resolveUserIdentity(character.id, "chat")?.name?.trim()
      || "用户";
  }

  function expandForNeutralPreview(text: string): string {
    return expandBlackMarketMacros(text, "角色", "用户");
  }

  function isOwnPublishedTemplate(template: BlackMarketTheaterTemplate): boolean {
    return template.authorId === account.id || template.authorId === "local_user";
  }

  function requiresExternalCanvasPermission(item?: BlackMarketOwnedTheater | null): boolean {
    return item?.templateSnapshot.allowExternalControl === true;
  }

  function openSceneLauncher(item: BlackMarketOwnedTheater): void {
    const existing = loadBlackMarketSceneSessions().find(session =>
      session.localTheaterId === item.localId && session.status === "active"
    );
    setLaunchOwnedId(item.localId);
    setLaunchCharacterId(existing?.characterId || characters[0]?.id || "");
    setExternalCanvasAllowed(false);
    setExternalCanvasRequest(null);
    setActiveScene(null);
    setSceneInput("");
    setSelectedTemplateId(null);
    setSelectedTemplateMode("info");
  }

  function closeSceneLayer(): void {
    setLaunchOwnedId(null);
    setActiveScene(null);
    setExternalCanvasAllowed(false);
    setExternalCanvasRequest(null);
    setSceneConfirmAction(null);
    setSceneInput("");
    setSceneBusy(null);
  }

  function getSceneConfirmMeta(action: BlackMarketSceneConfirmAction): { code: string; title: string; body: string; hint: string; confirmLabel: string; danger?: boolean } {
    if (action === "return") {
      return {
        code: "RETURN_TO_MARKET",
        title: "返回黑市？",
        body: "将关闭当前小剧场窗口，未结束的小剧场会话会保留，之后可从暗柜继续。",
        hint: "不会写入短期记忆，也不会删除当前进度。",
        confirmLabel: "确认返回",
      };
    }
    if (action === "archive") {
      return {
        code: "SAVE_FOR_LATER",
        title: "稍后继续？",
        body: "将暂存当前小剧场并返回黑市，之后可从暗柜重新进入继续。",
        hint: "当前对话记录会保留在本地小剧场会话中。",
        confirmLabel: "确认暂存",
      };
    }
    if (action === "restart") {
      return {
        code: "RESTART_SCENE",
        title: "重新开始？",
        body: "这会丢弃当前未结束的小剧场会话，并重新载入开场。",
        hint: "已经写入短期记忆的总结不会被删除；当前未总结的剧情会被清空。",
        confirmLabel: "确认重开",
        danger: true,
      };
    }
    return {
      code: "WRITE_MEMORY",
      title: "结束并写入记忆？",
      body: "将根据当前小剧场记录生成总结，并写入该角色的短期记忆。",
      hint: "写入后该小剧场会标记为已结束。",
      confirmLabel: "确认写入",
    };
  }

  function requestSceneConfirm(action: BlackMarketSceneConfirmAction): void {
    if (!activeScene) return;
    if (action === "restart" && (sceneBusy || activeScene.status === "ended")) return;
    if (action === "summary" && (sceneBusy || activeScene.status === "ended" || activeScene.messages.length === 0)) return;
    setSceneConfirmAction(action);
  }

  function cancelSceneConfirm(): void {
    setSceneConfirmAction(null);
  }

  function confirmSceneAction(): void {
    const action = sceneConfirmAction;
    if (!action) return;
    setSceneConfirmAction(null);
    if (action === "return" || action === "archive") {
      closeSceneLayer();
      return;
    }
    if (action === "restart") {
      handleSceneRestart();
      return;
    }
    void handleSceneSummary();
  }

  function expandForScene(text: string): string {
    const characterName = activeScene?.characterName || launchCharacter?.name || "角色";
    const userName = activeScene?.userName || resolveSceneUserName(launchCharacter);
    return expandBlackMarketMacros(text, characterName, userName);
  }

  function activateSceneFromLauncher(): void {
    if (!launchOwnedTheater) return;
    if (!launchCharacter) {
      showNotice("error", "请先选择一个角色。");
      return;
    }
    if (resumableLaunchScene) {
      setActiveScene(resumableLaunchScene);
      showNotice("info", "已继续未结束的小剧场");
      return;
    }
    const result = startBlackMarketSceneSession({
      localTheaterId: launchOwnedTheater.localId,
      characterId: launchCharacter.id,
      characterName: launchCharacter.name,
      userName: resolveSceneUserName(launchCharacter),
    });
    setState(result.state);
    if (!result.ok || !result.session) {
      showNotice("error", result.error || "启封失败");
      return;
    }
    setActiveScene(result.session);
    showNotice("success", "小剧场已启封");
  }

  function startSceneFromLauncher(): void {
    if (!launchOwnedTheater) return;
    if (!launchCharacter) {
      showNotice("error", "请先选择一个角色。");
      return;
    }
    if (requiresExternalCanvasPermission(launchOwnedTheater) && !externalCanvasAllowed) {
      setExternalCanvasRequest(resumableLaunchScene ? "resume" : "start");
      return;
    }
    activateSceneFromLauncher();
  }

  function confirmExternalCanvasRequest(): void {
    setExternalCanvasAllowed(true);
    setExternalCanvasRequest(null);
    activateSceneFromLauncher();
  }

  function cancelExternalCanvasRequest(): void {
    setExternalCanvasRequest(null);
    showNotice("info", "已取消高级自由画布启封");
  }

  async function copySceneMessage(content: string): Promise<void> {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      showNotice("success", "已复制");
    } catch {
      showNotice("error", "复制失败");
    }
  }

  function beginEditSceneUserMessage(message: BlackMarketSceneSession["messages"][number]): void {
    if (!activeScene || activeScene.status !== "active" || message.role !== "user" || sceneBusy) return;
    setEditingSceneMessageId(message.id);
    setSceneInput(message.content);
    showNotice("info", "编辑后发送，将重写这条后面的剧情。");
  }

  async function requestSceneReply(submittedSessionId: string, content: string): Promise<void> {
    setSceneBusy("reply");
    setSceneInput("");
    try {
      const result = await generateBlackMarketSceneReply(submittedSessionId, content);
      setActiveScene(result.session);
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "剧情生成失败");
      const restored = getBlackMarketSceneSession(submittedSessionId);
      if (restored) setActiveScene(restored);
    } finally {
      setSceneBusy(null);
    }
  }

  async function handleSceneSubmit(text?: string): Promise<void> {
    const content = (text ?? sceneInput).trim();
    if (!activeScene || activeScene.status !== "active" || !content || sceneBusy) return;
    const submittedSessionId = activeScene.id;

    const editingId = text === undefined ? editingSceneMessageId : null;
    if (editingId) {
      const target = activeScene.messages.find(message => message.id === editingId && message.role === "user");
      if (!target) {
        setEditingSceneMessageId(null);
        showNotice("error", "找不到要编辑的行动。");
        return;
      }
      const updated = updateBlackMarketSceneMessageAndTrimAfter(submittedSessionId, editingId, content);
      if (updated) setActiveScene(updated);
      setEditingSceneMessageId(null);
      await requestSceneReply(submittedSessionId, content);
      return;
    }

    const withUser = appendBlackMarketSceneMessage(submittedSessionId, "user", content);
    if (withUser) setActiveScene(withUser);
    setEditingSceneMessageId(null);
    await requestSceneReply(submittedSessionId, content);
  }

  async function retrySceneFromAssistantMessage(message: BlackMarketSceneSession["messages"][number]): Promise<void> {
    if (!activeScene || activeScene.status !== "active" || message.role !== "assistant" || sceneBusy) return;
    const targetIndex = activeScene.messages.findIndex(item => item.id === message.id);
    if (targetIndex < 0) return;
    const previousUser = [...activeScene.messages.slice(0, targetIndex)].reverse().find(item => item.role === "user");
    if (!previousUser) {
      showNotice("error", "找不到可用于重试的行动。");
      return;
    }
    const trimmed = trimBlackMarketSceneMessagesFrom(activeScene.id, message.id);
    if (trimmed) setActiveScene(trimmed);
    setEditingSceneMessageId(null);
    await requestSceneReply(activeScene.id, previousUser.content);
  }

  async function retrySceneFromUserMessage(message: BlackMarketSceneSession["messages"][number]): Promise<void> {
    if (!activeScene || activeScene.status !== "active" || message.role !== "user" || sceneBusy) return;
    const isLastMessage = activeScene.messages[activeScene.messages.length - 1]?.id === message.id;
    if (!isLastMessage) return;
    const trimmed = updateBlackMarketSceneMessageAndTrimAfter(activeScene.id, message.id, message.content);
    if (trimmed) setActiveScene(trimmed);
    setEditingSceneMessageId(null);
    await requestSceneReply(activeScene.id, message.content);
  }

  async function handleSceneSummary(): Promise<void> {
    if (!activeScene || sceneBusy) return;
    setSceneBusy("summary");
    try {
      const result = await summarizeAndRecordBlackMarketScene(activeScene.id);
      setActiveScene(result.session);
      showNotice("success", "小剧场总结已写入短期记忆");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "记忆总结失败");
    } finally {
      setSceneBusy(null);
    }
  }

  function handleSceneRestart(): void {
    if (!activeScene || sceneBusy || activeScene.status === "ended") return;
    const previous = activeScene;
    const discarded = discardBlackMarketSceneSession(previous.id);
    const result = startBlackMarketSceneSession({
      localTheaterId: previous.localTheaterId,
      characterId: previous.characterId,
      characterName: previous.characterName,
      userName: previous.userName,
    });
    setState(result.state || discarded.state);
    setSceneInput("");
    setSceneBusy(null);
    if (!result.ok || !result.session) {
      setActiveScene(null);
      showNotice("error", result.error || "重新开始失败");
      return;
    }
    setActiveScene(result.session);
    showNotice("success", "已重新开始，小剧场记录已丢弃");
  }

  function handleDeleteOwned(item: BlackMarketOwnedTheater): void {
    const result = deleteBlackMarketOwnedTheater(item.localId);
    setState(result.state);
    if (!result.ok) {
      showNotice("error", result.error || "删除失败");
      return;
    }
    if (launchOwnedId === item.localId) closeSceneLayer();
    setDeleteTarget(null);
    showNotice("success", "已从暗柜删除");
  }

  function handleDeleteTheaterRecord(entry: BlackMarketTheaterProjectionEntry): void {
    const result = deleteBlackMarketTheaterProjectionEvent(entry.id);
    setRecordMenuId(null);
    setTheaterRecords(loadAllBlackMarketTheaterProjectionEntries());
    if (!result.ok) {
      showNotice("error", result.error || "删除失败");
      return;
    }
    showNotice("success", "已删除该条小剧场记忆");
  }

  function closeDeleteConfirm(): void {
    if (deletingTemplateId) return;
    setDeleteTarget(null);
  }

  function confirmDeleteTarget(): void {
    if (deleteTarget?.kind === "owned" && pendingDeleteOwned) {
      handleDeleteOwned(pendingDeleteOwned);
      return;
    }
    if (deleteTarget?.kind === "published" && pendingDeletePublished) {
      void handleDeletePublished(pendingDeletePublished);
      return;
    }
    setDeleteTarget(null);
  }

  async function loadCommunityTheaters(showResult = false): Promise<void> {
    setCommunityLoading(true);
    setCommunityError(null);
    try {
      const theaters = await fetchBlackMarketTheaters();
      setCommunityTheaters(theaters);
      if (showResult) showNotice("success", theaters.length > 0 ? `同步 ${theaters.length} 份夜间档案` : "共享市场暂时为空");
    } catch (err) {
      const message = err instanceof Error ? err.message : "共享市场暂时不可用";
      setCommunityError(message);
      if (showResult) showNotice("error", message);
    } finally {
      setCommunityLoading(false);
    }
  }

  async function handleCheckin(): Promise<void> {
    if (walletBusy) return;
    setWalletBusy("checkin");
    try {
      const wallet = await checkInBlackMarketCloud();
      setState(syncBlackMarketWallet(wallet));
      showNotice("success", `签到成功，+${BLACK_MARKET_DAILY_CHECKIN_CREDITS} SC`);
    } catch (err) {
      showNotice("info", err instanceof Error ? err.message : "今天已经签到过了。");
    } finally {
      setWalletBusy(null);
    }
  }

  function handleOperatorTalk(): void {
    showNotice("info", "创作中介交互开发中");
  }

  async function handlePurchase(template: BlackMarketTheaterTemplate): Promise<void> {
    if (walletBusy) return;
    if (state.ownedTheaters.some(item => item.remoteTemplateId === template.id)) {
      showNotice("info", "已经收入暗柜。");
      return;
    }
    setWalletBusy("purchase");
    try {
      const fullTemplate = await ensureFullTheaterTemplate(template);
      // Built-in / local theaters are not in the cloud catalog (the cloud
      // purchase RPC would return theater_not_found), and they are operator
      // freebies — copy them straight into the vault at no cost.
      if (template.source !== "community") {
        const localResult = copyBlackMarketTheaterToVault(fullTemplate);
        if (!localResult.ok) {
          showNotice("error", localResult.error ?? "领取失败");
          return;
        }
        setState(localResult.state);
        setSelectedTab("vault");
        showNotice("success", "已免费收入暗柜");
        return;
      }
      const result = await purchaseBlackMarketTheaterCloud(template.id);
      const copied = copyBlackMarketTheaterToVault({
        ...fullTemplate,
        purchaseCount: fullTemplate.purchaseCount + 1,
      });
      const next = syncBlackMarketWallet(result.wallet);
      setState(next);
      if (copied.ok) {
        setCommunityTheaters(current => current.map(item => item.id === template.id ? { ...item, purchaseCount: item.purchaseCount + 1 } : item));
      }
      setSelectedTab("vault");
      showNotice("success", "已复制进暗柜");
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : "购买失败";
      if (message.includes("已经收入暗柜")) {
        let restored = 0;
        try {
          restored = await restorePurchasedTheatersFromCloud();
        } catch {
          restored = 0;
        }
        const fullTemplate = await ensureFullTheaterTemplate(template);
        const copied = restored > 0 ? { ok: true, state: loadBlackMarketState() } : copyBlackMarketTheaterToVault(fullTemplate);
        try {
          const wallet = await fetchBlackMarketWallet();
          setState(syncBlackMarketWallet(wallet));
        } catch {
          setState(copied.state);
        }
        if (copied.ok || restored > 0) {
          setSelectedTab("vault");
          showNotice("info", "已从购买记录恢复到暗柜。");
          return;
        }
      }
      showNotice("error", message);
    } finally {
      setWalletBusy(null);
    }
  }

  async function handleOwnTemplateUnseal(template: BlackMarketTheaterTemplate): Promise<void> {
    const existing = state.ownedTheaters.find(item => item.remoteTemplateId === template.id);
    if (existing) {
      openSceneLauncher(existing);
      return;
    }
    let fullTemplate = template;
    try {
      fullTemplate = await ensureFullTheaterTemplate(template);
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "夜间档案详情加载失败");
      return;
    }
    const result = copyBlackMarketTheaterToVault(fullTemplate);
    setState(result.state);
    if (result.ok && result.ownedTheater) {
      showNotice("success", "已复制进暗柜");
      openSceneLauncher(result.ownedTheater);
      return;
    }
    showNotice("error", result.error ?? "启封失败");
  }

  async function handleTemplatePrimaryAction(template: BlackMarketTheaterTemplate): Promise<void> {
    if (isOwnPublishedTemplate(template)) {
      await handleOwnTemplateUnseal(template);
      return;
    }
    await handlePurchase(template);
  }

  function updateDraft<K extends keyof TheaterDraft>(key: K, value: TheaterDraft[K]): void {
    setDraft(current => ({ ...current, [key]: value }));
  }

  function clearDraftSampleOnFocus<K extends keyof TheaterDraft>(key: K): void {
    if (editingTemplateId) return;
    const sample = defaultDraft[key];
    setDraft(current => current[key] === sample ? { ...current, [key]: "" } as TheaterDraft : current);
  }

  function clearDraftDescriptionOnFocus(): void {
    if (editingTemplateId) return;
    setDraft(current => (
      current.synopsis === defaultDraft.synopsis || current.storyText === defaultDraft.storyText
        ? { ...current, synopsis: "", storyText: "" }
        : current
    ));
  }

  function updateDraftDescription(value: string): void {
    setDraft(current => ({
      ...current,
      synopsis: value.trim().slice(0, 180),
      storyText: value,
    }));
  }

  function resetDraft(): void {
    setEditingTemplateId(null);
    setEditingDraftId(null);
    setDraft(createDefaultDraft());
    setPreviewNonce(value => value + 1);
  }

  async function beginEditPublished(template: BlackMarketTheaterTemplate): Promise<void> {
    let fullTemplate = template;
    try {
      fullTemplate = await ensureFullTheaterTemplate(template);
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "夜间档案详情加载失败");
      return;
    }
    setEditingTemplateId(fullTemplate.id);
    setEditingDraftId(null);
    setDraft(createDraftFromTemplate(fullTemplate));
    setStudioMode("create");
    setPreviewNonce(value => value + 1);
  }

  function beginEditStudioDraft(item: BlackMarketStudioDraft): void {
    setEditingTemplateId(null);
    setEditingDraftId(item.id);
    setDraft(item.draft);
    setStudioMode("create");
    setPreviewNonce(value => value + 1);
  }

  function handleSaveStudioDraft(): void {
    const now = new Date().toISOString();
    const id = editingDraftId || createStudioDraftId();
    const title = draft.title.trim() || "未命名草稿";
    const existingDraft = editingDraftId ? studioDrafts.find(item => item.id === editingDraftId) : null;
    const sourceTemplateId = editingTemplate?.id || existingDraft?.sourceTemplateId;
    const sourceTemplateTitle = editingTemplate?.title || existingDraft?.sourceTemplateTitle;
    setStudioDrafts(current => {
      const existing = current.find(item => item.id === id);
      return saveBlackMarketStudioDrafts([
        {
          id,
          title,
          draft,
          sourceTemplateId,
          sourceTemplateTitle,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        },
        ...current.filter(item => item.id !== id),
      ]);
    });
    if (editingTemplate?.id) {
      setEditingTemplateId(null);
      setEditingDraftId(id);
    }
    showNotice("success", "草稿已保存");
  }

  function handleDeleteStudioDraft(id: string): void {
    setStudioDrafts(current => saveBlackMarketStudioDrafts(current.filter(item => item.id !== id)));
    if (editingDraftId === id) {
      setEditingDraftId(null);
    }
    showNotice("info", "草稿已删除");
  }

  function getEditingDraftPublishSource(): BlackMarketPublishChoice | null {
    const currentDraft = editingStudioDraft;
    const sourceTemplateId = currentDraft?.sourceTemplateId?.trim();
    if (!editingDraftId || !currentDraft || !sourceTemplateId) return null;
    return {
      sourceTemplateId,
      sourceTemplateTitle: currentDraft.sourceTemplateTitle?.trim() || currentDraft.title || "原发布档案",
    };
  }

  function buildDraftTemplate(existing?: BlackMarketTheaterTemplate | null): BlackMarketTheaterTemplate {
    const title = draft.title.trim();
    const openingHtml = draft.openingHtml.trim();
    const aiInstruction = draft.aiInstruction.trim();
    if (!title) throw new Error("商品标题不能为空。");
    if (!openingHtml) throw new Error("开场画布不能为空。");
    if (!aiInstruction) throw new Error("剧情指令不能为空。");
    const now = new Date().toISOString();
    return {
      id: existing?.id || `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      codeName: draft.codeName.trim() || "CUSTOM_THEATER",
      fileNumber: existing?.fileNumber?.trim() || generateBlackMarketFileNumber(),
      subtitle: draft.subtitle.trim() || draft.synopsis.trim().slice(0, 56),
      synopsis: draft.synopsis.trim() || draft.storyText.trim().slice(0, 180),
      storyText: draft.storyText.trim() || draft.synopsis.trim(),
      tags: draft.tagsText.split(/[,\s，、]+/).map(tag => tag.trim()).filter(Boolean).slice(0, 8),
      rarity: "common",
      glyph: "◆",
      price: Math.min(500, Math.max(0, Math.round(Number(draft.price) || 0))),
      authorId: existing?.authorId || account.id,
      authorName: draft.authorName.trim() || account.displayName || "匿名卖家",
      source: "community",
      version: existing ? existing.version + 1 : 1,
      durationTurns: 8,
      allowExternalControl: draft.allowExternalControl,
      openingHtml,
      aiInstruction,
      outputContract: draft.outputContract.trim(),
      renderRules: parseDraftRenderRules(draft.renderRulesText),
      renderCss: draft.renderCss.trim(),
      memorySummaryPrompt: draft.memorySummaryPrompt.trim(),
      purchaseCount: existing?.purchaseCount ?? 0,
      rating: existing?.rating ?? 0,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
  }

  async function publishCurrentDraft(mode: "auto" | "new" | "overwrite-source" = "auto"): Promise<void> {
    setPublishing(true);
    try {
      const sourceTemplate = mode === "overwrite-source" && publishChoice
        ? communityTheaters.find(item => item.id === publishChoice.sourceTemplateId) ?? null
        : null;
      if (mode === "overwrite-source" && !sourceTemplate) {
        throw new Error("找不到原发布档案，请先刷新共享市场，或改为发布成新档案。");
      }
      const existingTemplate = mode === "new" ? null : editingTemplate ?? sourceTemplate;
      const template = buildDraftTemplate(existingTemplate);
      const published = existingTemplate
        ? await updateBlackMarketTheater(template)
        : await publishBlackMarketTheater(template);
      const snapshotSync = existingTemplate
        ? syncOwnedBlackMarketTheaterSnapshot(published)
        : null;
      if (snapshotSync?.updatedCount) {
        setState(snapshotSync.state);
      }
      if (editingDraftId) {
        setStudioDrafts(current => saveBlackMarketStudioDrafts(current.filter(item => item.id !== editingDraftId)));
        setEditingDraftId(null);
      }
      setCommunityTheaters(current => [published, ...current.filter(item => item.id !== published.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setSelectedTab("studio");
      setSelectedTemplateId(published.id);
      setEditingTemplateId(null);
      setStudioMode("published");
      setPublishChoice(null);
      showNotice(
        "success",
        existingTemplate
          ? snapshotSync?.updatedCount
            ? `夜间档案已同步修改，并更新 ${snapshotSync.updatedCount} 份暗柜副本`
            : "夜间档案已同步修改"
          : "夜间档案已送入黑市",
      );
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "发布失败");
    } finally {
      setPublishing(false);
    }
  }

  async function handlePublishDraft(): Promise<void> {
    if (!editingTemplate) {
      const source = getEditingDraftPublishSource();
      if (source) {
        setPublishChoice(source);
        return;
      }
    }
    await publishCurrentDraft("auto");
  }

  function closePublishChoice(): void {
    if (publishing) return;
    setPublishChoice(null);
  }

  async function handleDeletePublished(template: BlackMarketTheaterTemplate): Promise<void> {
    if (deletingTemplateId) return;
    setDeletingTemplateId(template.id);
    try {
      await deleteBlackMarketTheater({ id: template.id, authorId: template.authorId });
      setCommunityTheaters(current => current.filter(item => item.id !== template.id));
      if (selectedTemplateId === template.id) setSelectedTemplateId(null);
      if (editingTemplateId === template.id) resetDraft();
      setDeleteTarget(null);
      showNotice("success", "已从共享市场删除");
    } catch (err) {
      showNotice("error", err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeletingTemplateId(null);
    }
  }

  function renderMarketCard(template: BlackMarketTheaterTemplate) {
    const owned = ownedTemplateIds.has(template.id);
    const own = isOwnPublishedTemplate(template);
    return (
      <article key={template.id} className="cp-black-market-card">
        <div className="cp-black-market-card-top">
          <span className="cp-black-market-id">{getBlackMarketFileNumber(template)}</span>
        </div>
        <div className="cp-black-market-card-title">
          <div>
            <strong>{template.title}</strong>
            <em>SELLER · {template.authorName.trim() || "匿名卖家"}</em>
          </div>
        </div>
        <div className="cp-black-market-card-divider" />
        <p>{expandForNeutralPreview(template.synopsis)}</p>
        <div className="cp-black-market-tags">
          {template.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}
        </div>
        <div className="cp-black-market-card-actions">
          <button type="button" onClick={() => openTemplateInfo(template.id)}>
            <Eye size={15} />
            INFO
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => own ? void handleOwnTemplateUnseal(template) : void handlePurchase(template)}
            disabled={(owned && !own) || walletBusy === "purchase"}
          >
            {own ? <Play size={15} /> : owned ? <Check size={15} /> : <Copy size={15} />}
            {own ? "UNSEAL" : owned ? "OWNED" : template.source === "community" ? `BUY · ${formatShadowCredits(template.price)}` : "FREE"}
          </button>
        </div>
      </article>
    );
  }

  function renderOwnedCard(item: BlackMarketOwnedTheater) {
    const template = item.templateSnapshot;
    return (
      <article key={item.localId} className="cp-black-market-owned-card">
        <div>
          <span>VAULT ITEM</span>
          <strong>{template.title}</strong>
          <p>{expandForNeutralPreview(template.subtitle || template.synopsis)}</p>
        </div>
        <div className="cp-black-market-owned-meta">
          <span>{getBlackMarketFileNumber(template)}</span>
          <span>{formatBlackMarketDate(item.purchasedAt)}</span>
          <span>{item.useCount > 0 ? `已启封 ${item.useCount} 次` : "未启封"}</span>
        </div>
        <div className="cp-black-market-owned-actions">
          <button type="button" onClick={() => openTemplateInfo(template.id)}>INFO</button>
          <button type="button" className="is-primary" onClick={() => openSceneLauncher(item)}>UNSEAL</button>
          <button type="button" className="is-danger" onClick={() => setDeleteTarget({ kind: "owned", localId: item.localId })}>DELETE</button>
        </div>
      </article>
    );
  }

  function renderTheaterRecord(entry: BlackMarketTheaterProjectionEntry) {
    const character = characters.find(item => item.id === entry.characterId);
    const menuOpen = recordMenuId === entry.id;
    return (
      <article key={entry.id} className="cp-black-market-record-card">
        <div className="cp-black-market-record-main">
          <span>THEATER MEMORY</span>
          <strong>{entry.theaterTitle || "未命名小剧场"}</strong>
          <p>{entry.content}</p>
          <div className="cp-black-market-record-meta">
            <span>{character?.name || entry.characterId}</span>
            <span>{formatBlackMarketDate(entry.timestamp)}</span>
          </div>
        </div>
        <div className="cp-black-market-record-menu">
          <button
            type="button"
            aria-label={`${entry.theaterTitle || "小剧场"} 记录操作`}
            onClick={() => setRecordMenuId(menuOpen ? null : entry.id)}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen ? (
            <div className="cp-black-market-record-pop">
              <button type="button" onClick={() => handleDeleteTheaterRecord(entry)}>
                DELETE
              </button>
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  const pendingDeleteTitle = pendingDeleteOwned?.templateSnapshot.title || pendingDeletePublished?.title || "";
  const pendingDeleteBusy = deleteTarget?.kind === "published" && pendingDeletePublished
    ? deletingTemplateId === pendingDeletePublished.id
    : false;
  const sceneConfirmMeta = sceneConfirmAction ? getSceneConfirmMeta(sceneConfirmAction) : null;

  return (
    <div className="cp-black-market-root">
      <div className="cp-black-market-noise" />
      <div className="cp-black-market-scanlines" />

      <header className="cp-black-market-header">
        <button type="button" aria-label="返回购物" onClick={onClose}>
          <ChevronLeft size={22} strokeWidth={2.5} />
        </button>
        <div>
          <span>STYGIAN CHANNEL</span>
          <strong>BLACK MARKET</strong>
        </div>
        <button
          type="button"
          aria-label="刷新黑市剧场"
          onClick={() => void loadCommunityTheaters(true)}
          disabled={communityLoading}
        >
          <RefreshCw size={18} strokeWidth={2.4} className={communityLoading ? "cp-spin" : ""} />
        </button>
      </header>

      <main className="cp-black-market-scroll">
        <section className="cp-black-market-statusbar" aria-label="黑市连接状态">
          <span className="cp-black-market-led" />
          <span className="is-green">CONNECTED</span>
          <span>·</span>
          <span>TOR://night-channel.onion</span>
          <b>{terminalTime}</b>
          <span>·</span>
          <span>{latency}ms</span>
        </section>

        <div className="cp-black-market-warning">△ THIS SESSION IS BEING MONITORED △</div>

        <section className="cp-black-market-title-block">
          <div className="cp-black-market-title-prefix">v2.4.1 // STYGIAN · 夜间通道 · SANDBOX</div>
          <h1 className="cp-black-market-brand" data-text="BLACK MARKET">BLACK MARKET</h1>
          <div className="cp-black-market-title-sub">── // ACCESS GRANTED · WELCOME BACK ──────</div>
        </section>

        <section className="cp-black-market-operator">
          <span className="cp-black-market-corner is-tl" />
          <span className="cp-black-market-corner is-tr" />
          <span className="cp-black-market-corner is-bl" />
          <span className="cp-black-market-corner is-br" />
          <div className="cp-black-market-camera" aria-hidden="true">
            <span className="cp-black-market-camera-rec">● REC</span>
            <span className="cp-black-market-camera-sig">SIG -72dB</span>
            <span className="cp-black-market-camera-id">OPERATOR_03 / {terminalTime}</span>
          </div>
          <div className="cp-black-market-operator-info">
            <div className="cp-black-market-operator-label">OPERATOR_03</div>
            <div className="cp-black-market-operator-status">{communityLoading ? "正在校准共享信号." : communityError ? "信号不稳." : "等你说出第一个念头."}</div>
            <div className="cp-black-market-operator-meta">
              <span>· 职能&nbsp;&nbsp;<b>创作中介</b></span>
              <span>· 信任&nbsp;&nbsp;<b>★★☆☆☆</b></span>
              <span>· 真实来源&nbsp;&nbsp;<i>████████</i></span>
            </div>
            <div className="cp-black-market-operator-actions">
              <button type="button" className="cp-black-market-talk-btn" onClick={handleOperatorTalk}>
                {"// TALK ->"}
              </button>
              <button type="button" className="cp-black-market-sync-btn" onClick={() => void loadCommunityTheaters(true)} disabled={communityLoading}>
                {communityLoading ? "// SYNCING" : "// REFRESH MARKET ->"}
              </button>
            </div>
          </div>
          {communityError ? <div className="cp-black-market-sync-error">{communityError}</div> : null}
        </section>

        <section className="cp-black-market-wallet">
          <div>
            <span>WALLET</span>
            <strong>{formatShadowCredits(state.wallet.balance)}</strong>
            <em>SHADOW CREDITS · ENCRYPTED ✓</em>
          </div>
          <button type="button" onClick={() => void handleCheckin()} disabled={walletBusy === "sync" || walletBusy === "checkin"}>
            {walletBusy === "sync" ? "SYNCING" : walletBusy === "checkin" ? "CHECKING" : `+${BLACK_MARKET_DAILY_CHECKIN_CREDITS} DAILY`}
          </button>
        </section>

        <nav className="cp-black-market-tabs" aria-label="黑市导航">
          {MARKET_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={selectedTab === tab.id ? "is-active" : ""}
              onClick={() => setSelectedTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="cp-black-market-inventory-head">
          <span>──[ INVENTORY · {selectedTab === "market" ? catalog.length : selectedTab === "vault" ? state.ownedTheaters.length : selectedTab === "ledger" ? state.wallet.transactions.length : 1} ENTRIES ]</span>
          <b>[{selectedTab.toUpperCase()}]</b>
        </div>

        {selectedTab === "market" ? (
          <section className="cp-black-market-grid">
            {catalog.map(renderMarketCard)}
          </section>
        ) : null}

        {selectedTab === "vault" ? (
          <section className="cp-black-market-list">
            <div className="cp-black-market-section-head">
              <Archive size={16} />
              <span>本地暗柜</span>
              <b>{state.ownedTheaters.length}</b>
            </div>
            {state.ownedTheaters.length === 0 ? (
              <div className="cp-black-market-empty">暗柜里还没有可启封的夜间档案。</div>
            ) : state.ownedTheaters.map(renderOwnedCard)}
            <div className="cp-black-market-section-head cp-black-market-record-head">
              <FileText size={16} />
              <span>最近记录</span>
              <b>{theaterRecords.length}</b>
            </div>
            {theaterRecords.length === 0 ? (
              <div className="cp-black-market-empty cp-black-market-record-empty">没有小剧场回传记录</div>
            ) : (
              <div className="cp-black-market-record-list" aria-label="小剧场回传记录">
                {theaterRecords.slice(0, 20).map(renderTheaterRecord)}
              </div>
            )}
          </section>
        ) : null}

        {selectedTab === "ledger" ? (
          <section className="cp-black-market-list">
            <div className="cp-black-market-section-head">
              <FileText size={16} />
              <span>暗影信用点流水</span>
              <b>{state.wallet.transactions.length}</b>
            </div>
            {state.wallet.transactions.map(transaction => (
              <article key={transaction.id} className="cp-black-market-ledger-row">
                <div>
                  <strong>{transaction.title}</strong>
                  <span>{transaction.detail}</span>
                  <time>{formatBlackMarketDate(transaction.createdAt)}</time>
                </div>
                <b className={transaction.amount >= 0 ? "is-plus" : "is-minus"}>
                  {transaction.amount >= 0 ? "+" : ""}{transaction.amount} SC
                </b>
              </article>
            ))}
          </section>
        ) : null}

        {selectedTab === "studio" ? (
          <section className="cp-black-market-studio">
            <div className="cp-black-market-section-head">
              <PenLine size={16} />
              <span>夜间档案工坊</span>
              <b>{publishedTheaters.length} PUBLISHED · {studioDrafts.length} DRAFTS</b>
            </div>

            <div className="cp-black-market-studio-tabs" role="tablist" aria-label="发布管理">
              <button
                type="button"
                role="tab"
                aria-selected={studioMode === "published"}
                className={studioMode === "published" ? "is-active" : ""}
                onClick={() => setStudioMode("published")}
              >
                已发布
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={studioMode === "create"}
                className={studioMode === "create" ? "is-active" : ""}
                onClick={() => setStudioMode("create")}
              >
                创建发布
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={studioMode === "drafts"}
                className={studioMode === "drafts" ? "is-active" : ""}
                onClick={() => setStudioMode("drafts")}
              >
                草稿箱
              </button>
            </div>

            {studioMode === "published" ? (
              <div className="cp-black-market-studio-panel">
                <h3>我的共享档案</h3>
                <p className="cp-black-market-studio-hint">这里显示本机发布到云端共享市场的夜间档案。修改或删除只影响共享市场，已经被购买的本地副本不会变化。</p>
                {publishedTheaters.length === 0 ? (
                  <div className="cp-black-market-empty">还没有发布过夜间档案。</div>
                ) : (
                  <div className="cp-black-market-published-list">
                    {publishedTheaters.map(template => (
                      <article key={template.id} className="cp-black-market-published-card">
                        <div>
                          <span>{getBlackMarketFileNumber(template)}</span>
                          <strong>{template.title}</strong>
                          <p>{expandForNeutralPreview(template.subtitle || template.synopsis || template.storyText)}</p>
                          <time>{formatBlackMarketDate(template.updatedAt)}</time>
                        </div>
                        <div className="cp-black-market-published-actions">
                          <button type="button" onClick={() => openTemplateInfo(template.id)}>
                            <Eye size={14} />
                            INFO
                          </button>
                          <button type="button" onClick={() => void beginEditPublished(template)}>
                            <Pencil size={14} />
                            MODIFY
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            disabled={deletingTemplateId === template.id}
                            onClick={() => setDeleteTarget({ kind: "published", templateId: template.id })}
                          >
                            <Trash2 size={14} />
                            {deletingTemplateId === template.id ? "DELETING" : "DELETE"}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {studioMode === "drafts" ? (
              <div className="cp-black-market-studio-panel">
                <h3>草稿箱</h3>
                <p className="cp-black-market-studio-hint">草稿只保存在当前设备，不会进入共享市场。</p>
                {studioDrafts.length === 0 ? (
                  <div className="cp-black-market-empty">还没有保存过草稿。</div>
                ) : (
                  <div className="cp-black-market-published-list">
                    {studioDrafts.map(item => (
                      <article key={item.id} className="cp-black-market-published-card">
                        <div>
                          <span>{item.sourceTemplateId ? "来源草稿" : "草稿"}</span>
                          <strong>{item.title}</strong>
                          <p>{item.sourceTemplateId ? `来源：${item.sourceTemplateTitle || "已发布档案"}` : item.draft.subtitle || item.draft.synopsis || item.draft.storyText}</p>
                          <time>{formatBlackMarketDate(item.updatedAt)}</time>
                        </div>
                        <div className="cp-black-market-published-actions">
                          <button type="button" onClick={() => beginEditStudioDraft(item)}>
                            <Pencil size={14} />
                            EDIT
                          </button>
                          <button type="button" className="is-danger" onClick={() => handleDeleteStudioDraft(item.id)}>
                            <Trash2 size={14} />
                            DELETE
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {studioMode === "create" ? (
              <>
                {editingTemplate ? (
                  <div className="cp-black-market-editing-banner">
                    <span>修改中</span>
                    <strong>{editingTemplate.title}</strong>
                    <button type="button" onClick={resetDraft}>取消修改</button>
                  </div>
                ) : null}
                {editingDraftId && !editingTemplate ? (
                  <div className="cp-black-market-editing-banner">
                    <span>{editingStudioDraft?.sourceTemplateId ? "来源草稿" : "草稿中"}</span>
                    <strong>{editingStudioDraft?.title || "未命名草稿"}</strong>
                    <button type="button" onClick={resetDraft}>退出草稿</button>
                  </div>
                ) : null}

                <div className="cp-black-market-studio-panel">
                  <h3>商品档案</h3>
                  <p className="cp-black-market-studio-hint">只需要填写用户会看到的标题和介绍；内部编号会自动处理，发布昵称可每次单独设置。</p>
                  <label>
                    档案名字
                    <input value={draft.title} onFocus={() => clearDraftSampleOnFocus("title")} onChange={event => updateDraft("title", event.target.value)} />
                  </label>
                  <label>
                    发布昵称
                    <input
                      value={draft.authorName}
                      maxLength={40}
                      placeholder="例如 匿名卖家 / 夜间档案员"
                      onFocus={() => clearDraftSampleOnFocus("authorName")}
                      onChange={event => updateDraft("authorName", event.target.value)}
                    />
                  </label>
                  <div className="cp-black-market-nickname-actions" aria-label="发布昵称快捷操作">
                    <button type="button" onClick={() => updateDraft("authorName", account.displayName || "匿名卖家")}>使用账号名</button>
                    <button type="button" onClick={() => updateDraft("authorName", "匿名卖家")}>匿名卖家</button>
                  </div>
                  <label>
                    档案介绍
                    <textarea value={draft.storyText || draft.synopsis} onFocus={clearDraftDescriptionOnFocus} onChange={event => updateDraftDescription(event.target.value)} rows={5} />
                  </label>
                  <div className="cp-black-market-studio-row">
                    <label>
                      列表标签
                      <input value={draft.tagsText} onFocus={() => clearDraftSampleOnFocus("tagsText")} onChange={event => updateDraft("tagsText", event.target.value)} />
                    </label>
                    <label>
                      价格
                      <input inputMode="numeric" value={draft.price} onFocus={() => clearDraftSampleOnFocus("price")} onChange={event => updateDraft("price", event.target.value)} />
                    </label>
                  </div>
                </div>

                <div className="cp-black-market-studio-panel">
                  <h3>开场画布</h3>
                  <p className="cp-black-market-studio-hint">可用宏：{"{{char}}"} = 启封角色名，{"{{user}}"} = 该角色绑定的用户人设名。运行时会自动替换。</p>
                  <label className="cp-black-market-studio-check">
                    <input
                      type="checkbox"
                      checked={draft.allowExternalControl}
                      onChange={event => updateDraft("allowExternalControl", event.target.checked)}
                    />
                    <span>
                      <strong>启用高级自由画布</strong>
                      <em>允许小剧场代码与外层页面同源通信，用于固定音乐栏、侧边栏、全局浮层等效果。接收方每次启封前都会看到风险确认。</em>
                    </span>
                  </label>
                  <textarea value={draft.openingHtml} onFocus={() => clearDraftSampleOnFocus("openingHtml")} onChange={event => updateDraft("openingHtml", event.target.value)} rows={12} spellCheck={false} />
                </div>

                <div className="cp-black-market-studio-panel">
                  <h3>剧情指令</h3>
                  <p className="cp-black-market-studio-hint">剧情指令、输出契约、记忆总结提示词同样支持 {"{{char}}"} 和 {"{{user}}"}。</p>
                  <textarea value={draft.aiInstruction} onFocus={() => clearDraftSampleOnFocus("aiInstruction")} onChange={event => updateDraft("aiInstruction", event.target.value)} rows={10} />
                  <label>
                    输出契约
                    <textarea value={draft.outputContract} onFocus={() => clearDraftSampleOnFocus("outputContract")} onChange={event => updateDraft("outputContract", event.target.value)} rows={4} />
                  </label>
                  <p className="cp-black-market-studio-hint">AI 回复支持普通正则渲染，也支持输出 ```html 代码块``` 作为独立回复画布。画布内可用 Theater.sendUserAction(&quot;文本&quot;) 或 data-action 按钮把选择回填到小剧场。</p>
                  <details className="cp-black-market-studio-advanced">
                    <summary>高级渲染设置</summary>
                    <label>
                      正则规则 JSON
                      <textarea value={draft.renderRulesText} onFocus={() => clearDraftSampleOnFocus("renderRulesText")} onChange={event => updateDraft("renderRulesText", event.target.value)} rows={8} spellCheck={false} />
                    </label>
                    <label>
                      渲染 CSS
                      <textarea value={draft.renderCss} onFocus={() => clearDraftSampleOnFocus("renderCss")} onChange={event => updateDraft("renderCss", event.target.value)} rows={5} spellCheck={false} />
                    </label>
                    <label>
                      记忆总结提示词
                      <textarea value={draft.memorySummaryPrompt} onFocus={() => clearDraftSampleOnFocus("memorySummaryPrompt")} onChange={event => updateDraft("memorySummaryPrompt", event.target.value)} rows={4} />
                    </label>
                  </details>
                </div>

                <div className="cp-black-market-studio-panel">
                  <h3>测试运行</h3>
                  <BlackMarketTheaterHtmlFrame
                    key={previewNonce}
                    title="自定义夜间档案测试画布"
                    html={expandForNeutralPreview(draft.openingHtml)}
                    allowExternalControl={draft.allowExternalControl}
                  />
                  <div className="cp-black-market-studio-test">
                    <div className="cp-black-market-studio-test-head">
                      <h3>输出契约测试</h3>
                      <span>LOCAL_RENDER_ONLY</span>
                    </div>
                    <p className="cp-black-market-studio-hint">这里不请求 API。手动输入 USER 和 ASSISTANT 文本后，会按当前正则规则 JSON、渲染 CSS 和 ```html 代码块``` 逻辑即时渲染。</p>
                    <div className="cp-black-market-studio-test-grid">
                      <label>
                        USER 测试消息
                        <textarea
                          value={studioTestUserMessage}
                          onChange={event => setStudioTestUserMessage(event.target.value)}
                          onFocus={() => {
                            if (studioTestUserMessage === BLACK_MARKET_STUDIO_TEST_USER_SAMPLE) setStudioTestUserMessage("");
                          }}
                          rows={8}
                          spellCheck={false}
                        />
                      </label>
                      <label>
                        ASSISTANT 测试消息
                        <textarea
                          value={studioTestAssistantMessage}
                          onChange={event => setStudioTestAssistantMessage(event.target.value)}
                          onFocus={() => {
                            if (studioTestAssistantMessage === BLACK_MARKET_STUDIO_TEST_ASSISTANT_SAMPLE) setStudioTestAssistantMessage("");
                          }}
                          rows={8}
                          spellCheck={false}
                        />
                      </label>
                    </div>
                    {draft.renderCss ? <style>{sanitizeRenderCss(draft.renderCss)}</style> : null}
                    <div className="cp-black-market-scene-log cp-black-market-studio-render-preview" aria-label="输出契约渲染预览">
                      {studioTestUserMessage.trim() ? (
                        <article className="cp-black-market-scene-message is-user">
                          <span>USER</span>
                          <BlackMarketSceneMessageContent
                            content={studioTestUserMessage}
                            template={draftPreviewTemplate}
                            characterName="角色"
                            userName="用户"
                            messageId="studio-test-user"
                          />
                        </article>
                      ) : null}
                      {studioTestAssistantMessage.trim() ? (
                        <article className="cp-black-market-scene-message is-assistant">
                          <span>ASSISTANT</span>
                          <BlackMarketSceneMessageContent
                            content={studioTestAssistantMessage}
                            template={draftPreviewTemplate}
                            characterName="角色"
                            userName="用户"
                            messageId="studio-test-assistant"
                          />
                        </article>
                      ) : null}
                      {!studioTestUserMessage.trim() && !studioTestAssistantMessage.trim() ? (
                        <p className="cp-black-market-scene-empty">输入测试消息后，这里会显示输出契约的最终渲染效果。</p>
                      ) : null}
                    </div>
                  </div>
                  <div className="cp-black-market-studio-actions">
                    <button type="button" onClick={resetDraft}>
                      <Plus size={14} />
                      新建
                    </button>
                    <button type="button" onClick={handleSaveStudioDraft}>
                      <FileText size={14} />
                      存草稿
                    </button>
                    <button type="button" onClick={() => setPreviewNonce(value => value + 1)}>
                      <Play size={14} />
                      刷新预览
                    </button>
                    <button type="button" className="is-primary" disabled={publishing} onClick={() => void handlePublishDraft()}>
                      <Send size={14} />
                      {publishing ? "同步中" : editingTemplate ? "保存修改" : editingStudioDraft?.sourceTemplateId ? "选择发布方式" : "发布共享"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        ) : null}
      </main>

      {notice ? (
        <div key={notice.id} className={`cp-black-market-toast cp-black-market-toast--${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}

      {publishChoice ? (
        <div className="cp-black-market-modal cp-black-market-confirm-modal" role="presentation" onClick={closePublishChoice}>
          <section className="cp-black-market-modal-card cp-black-market-confirm-card" role="dialog" aria-modal="true" aria-label="选择发布方式" onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>发布方式</span>
                <strong>这个草稿来自已发布档案</strong>
              </div>
              <button type="button" onClick={closePublishChoice}>关闭</button>
            </div>
            <div className="cp-black-market-confirm-body">
              <div className="cp-black-market-confirm-code">{publishChoice.sourceTemplateTitle}</div>
              <p>请选择把这份草稿覆盖到原档案，还是作为一份新的夜间档案发布。</p>
              <span>{publishChoiceSourceTemplate ? "覆盖会更新原档案；发布为新档案会保留原档案不动。" : "当前列表里找不到原档案，只能发布为新档案；刷新共享市场后可再尝试覆盖。"}</span>
            </div>
            <div className="cp-black-market-modal-actions cp-black-market-confirm-actions">
              <button type="button" disabled={publishing} onClick={() => void publishCurrentDraft("new")}>
                发布为新档案
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={publishing || !publishChoiceSourceTemplate}
                onClick={() => void publishCurrentDraft("overwrite-source")}
              >
                覆盖原档案
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {sceneConfirmMeta ? (
        <div className="cp-black-market-modal cp-black-market-confirm-modal" role="presentation" onClick={cancelSceneConfirm}>
          <section className="cp-black-market-modal-card cp-black-market-confirm-card" role="dialog" aria-modal="true" aria-label={sceneConfirmMeta.title} onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>SCENE ACTION</span>
                <strong>{sceneConfirmMeta.title}</strong>
              </div>
              <button type="button" onClick={cancelSceneConfirm}>关闭</button>
            </div>
            <div className="cp-black-market-confirm-body">
              <div className="cp-black-market-confirm-code">{sceneConfirmMeta.code}</div>
              <p>{sceneConfirmMeta.body}</p>
              <span>{sceneConfirmMeta.hint}</span>
            </div>
            <div className="cp-black-market-modal-actions cp-black-market-confirm-actions">
              <button type="button" onClick={cancelSceneConfirm}>取消</button>
              <button
                type="button"
                className={sceneConfirmMeta.danger ? "is-danger" : "is-primary"}
                onClick={confirmSceneAction}
              >
                {sceneConfirmMeta.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="cp-black-market-modal cp-black-market-confirm-modal" role="presentation" onClick={closeDeleteConfirm}>
          <section className="cp-black-market-modal-card cp-black-market-confirm-card" role="dialog" aria-modal="true" aria-label="删除确认" onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>{deleteTarget.kind === "owned" ? "DELETE VAULT ITEM" : "DELETE MARKET FILE"}</span>
                <strong>{pendingDeleteTitle || "未知档案"}</strong>
              </div>
              <button type="button" disabled={pendingDeleteBusy} onClick={closeDeleteConfirm}>关闭</button>
            </div>
            <div className="cp-black-market-confirm-body">
              <div className="cp-black-market-confirm-code">CONFIRM_PURGE</div>
              <p>
                {deleteTarget.kind === "owned"
                  ? "这会从本地暗柜删除该道具，并丢弃关联的未完成小剧场会话。已经写入短期记忆的剧情总结可在暗柜的最近记录里单独删除。"
                  : "这会从共享市场删除该发布档案。已经被购买到本地暗柜的副本不会受影响。"}
              </p>
              <span>此操作不会退还暗影信用点。</span>
            </div>
            <div className="cp-black-market-modal-actions cp-black-market-confirm-actions">
              <button type="button" disabled={pendingDeleteBusy} onClick={closeDeleteConfirm}>取消</button>
              <button type="button" className="is-danger" disabled={pendingDeleteBusy} onClick={confirmDeleteTarget}>
                {pendingDeleteBusy ? "DELETING" : "确认删除"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {externalCanvasRequest && launchOwnedTheater ? (
        <div className="cp-black-market-modal cp-black-market-confirm-modal" role="presentation" onClick={cancelExternalCanvasRequest}>
          <section className="cp-black-market-modal-card cp-black-market-confirm-card cp-black-market-external-card" role="dialog" aria-modal="true" aria-label="高级自由画布确认" onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>ADVANCED CANVAS</span>
                <strong>{launchOwnedTheater.templateSnapshot.title}</strong>
              </div>
              <button type="button" onClick={cancelExternalCanvasRequest}>关闭</button>
            </div>
            <div className="cp-black-market-confirm-body">
              <div className="cp-black-market-confirm-code">EXTERNAL_CONTROL_REQUEST</div>
              <p>该小剧场使用高级自由画布，可能控制当前页面显示、播放音频、访问本地页面数据。请仅启封可信作者的作品。是否允许？</p>
              <span>本次授权只对当前打开的小剧场生效；关闭后再次打开仍会重新询问。</span>
            </div>
            <div className="cp-black-market-modal-actions cp-black-market-confirm-actions">
              <button type="button" onClick={cancelExternalCanvasRequest}>取消</button>
              <button type="button" className="is-primary" onClick={confirmExternalCanvasRequest}>
                允许并启封
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {selectedTemplate ? (
        <div className="cp-black-market-modal" role="presentation" onClick={closeTemplatePreview}>
          <section className="cp-black-market-modal-card" role="dialog" aria-modal="true" aria-label="夜间档案预览" onClick={event => event.stopPropagation()}>
            <div className="cp-black-market-modal-head">
              <div>
                <span>{selectedTemplateMode === "opening" ? "开场画布" : "夜间档案"}</span>
                <strong>{selectedTemplate.title}</strong>
              </div>
              <button type="button" onClick={closeTemplatePreview}>关闭</button>
            </div>
            {selectedTemplateMode === "opening" ? (
              <BlackMarketTheaterHtmlFrame
                title={`${selectedTemplate.title} 开场画布`}
                html={expandForNeutralPreview(selectedTemplate.openingHtml)}
              />
            ) : (
              <>
                <section className="cp-black-market-info-flat" aria-label="夜间档案信息">
                  <div className="cp-black-market-info-meta">
                    <span>{getBlackMarketFileNumber(selectedTemplate)}</span>
                    <span>{selectedTemplate.tags.slice(0, 3).join(" / ") || "未分类"}</span>
                  </div>
                  <p className="cp-black-market-file-intro">{expandForNeutralPreview(selectedTemplate.storyText || selectedTemplate.synopsis)}</p>
                  <div className="cp-black-market-file-actions">
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => selectedOwnedTheater ? openSceneLauncher(selectedOwnedTheater) : void handleTemplatePrimaryAction(selectedTemplate)}
                      disabled={!selectedOwnedTheater && !isOwnPublishedTemplate(selectedTemplate) && walletBusy === "purchase"}
                    >
                      {selectedOwnedTheater || isOwnPublishedTemplate(selectedTemplate) ? "启封档案" : selectedTemplate.source === "community" ? `购买 · ${formatShadowCredits(selectedTemplate.price)}` : "免费领取"}
                    </button>
                    <button type="button" onClick={closeTemplatePreview}>先观察</button>
                  </div>
                  <div className="cp-black-market-file-hint">{selectedOwnedTheater || isOwnPublishedTemplate(selectedTemplate) ? "启封后会进入独立小剧场，不写入普通聊天。" : selectedTemplate.source === "community" ? "购买后会复制到暗柜，再选择角色启封。" : "免费领取后会复制到暗柜，再选择角色启封。"}</div>
                </section>
              </>
            )}
            {selectedTemplateMode === "opening" ? (
              <div className="cp-black-market-modal-actions">
                <button type="button" onClick={() => setSelectedTemplateMode("info")}>返回档案</button>
                <button
                  type="button"
                  className="is-primary"
                  disabled={(ownedTemplateIds.has(selectedTemplate.id) && !isOwnPublishedTemplate(selectedTemplate)) || walletBusy === "purchase"}
                  onClick={() => void handleTemplatePrimaryAction(selectedTemplate)}
                >
                  {isOwnPublishedTemplate(selectedTemplate) ? "启封档案" : ownedTemplateIds.has(selectedTemplate.id) ? "已拥有" : selectedTemplate.source === "community" ? `购买 · ${formatShadowCredits(selectedTemplate.price)}` : "免费领取"}
                </button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {launchOwnedTheater ? (
        <div className={`cp-black-market-modal${activeScene ? " cp-black-market-scene-modal" : ""}`} role="presentation" onClick={closeSceneLayer}>
          <section className={`cp-black-market-modal-card cp-black-market-scene-card${activeScene ? " cp-black-market-scene-session-card" : ""}`} role="dialog" aria-modal="true" aria-label="启封小剧场" onClick={event => event.stopPropagation()}>
            {!activeScene ? (
              <>
                <div className="cp-black-market-modal-head">
                  <div>
                    <span>SELECT TARGET</span>
                    <strong>{launchOwnedTheater.templateSnapshot.title}</strong>
                  </div>
                  <button type="button" onClick={closeSceneLayer}>关闭</button>
                </div>
                <p className="cp-black-market-modal-copy">选择一个角色进入独立小剧场。剧情过程不会写入普通聊天，结束后可选择总结进短期记忆。</p>
                <div className="cp-black-market-character-grid">
                  {characters.length === 0 ? (
                    <div className="cp-black-market-empty">暂无可用角色。</div>
                  ) : characters.map(char => {
                    const canResume = launchActiveCharacterIds.has(char.id);
                    return (
                      <button
                        key={char.id}
                        type="button"
                        className={launchCharacterId === char.id ? "is-active" : ""}
                        onClick={() => setLaunchCharacterId(char.id)}
                      >
                        <span>{char.avatar ? <img src={char.avatar} alt="" /> : char.name.slice(0, 1)}</span>
                        <strong>{char.name}</strong>
                        <em>{resolveSceneUserName(char)}{canResume ? " · 可继续" : " · 新开"}</em>
                      </button>
                    );
                  })}
                </div>
                <div className="cp-black-market-modal-actions">
                  <button type="button" onClick={closeSceneLayer}>取消</button>
                  <button type="button" className="is-primary" disabled={!launchCharacter} onClick={startSceneFromLauncher}>
                    {resumableLaunchScene ? "继续小剧场" : "进入开场"}
                  </button>
                </div>
              </>
            ) : (
              <>
                {launchOwnedTheater.templateSnapshot.renderCss ? (
                  <style>{sanitizeRenderCss(launchOwnedTheater.templateSnapshot.renderCss)}</style>
                ) : null}
                <div className="cp-black-market-scene-toolbar" aria-label="小剧场操作">
                  <div className="cp-black-market-scene-toolbar-group">
                    <button type="button" aria-label="返回黑市" onClick={() => requestSceneConfirm("return")}>
                      <ChevronLeft size={20} strokeWidth={2.5} />
                    </button>
                    <button type="button" aria-label="稍后继续" onClick={() => requestSceneConfirm("archive")}>
                      <Archive size={18} strokeWidth={2.35} />
                    </button>
                  </div>
                  <div className="cp-black-market-scene-toolbar-group">
                    <button
                      type="button"
                      aria-label="重新开始小剧场"
                      disabled={activeScene.status === "ended" || sceneBusy !== null}
                      onClick={() => requestSceneConfirm("restart")}
                    >
                      <RotateCcw size={18} strokeWidth={2.35} />
                    </button>
                    <button
                      type="button"
                      aria-label="结束并写入记忆"
                      disabled={activeScene.status === "ended" || sceneBusy !== null || activeScene.messages.length === 0}
                      onClick={() => requestSceneConfirm("summary")}
                    >
                      <FileText size={18} strokeWidth={2.35} className={sceneBusy === "summary" ? "cp-spin" : ""} />
                    </button>
                  </div>
                </div>
                <div className="cp-black-market-scene-flow">
                  {externalCanvasAllowed && launchOwnedTheater.templateSnapshot.allowExternalControl ? (
                    <div id="black-market-creator-layer" className="cp-black-market-creator-layer" />
                  ) : null}
                  <BlackMarketTheaterHtmlFrame
                    key={activeScene.id}
                    title={`${launchOwnedTheater.templateSnapshot.title} 开场画布`}
                    html={expandForScene(launchOwnedTheater.templateSnapshot.openingHtml)}
                    allowExternalControl={externalCanvasAllowed && launchOwnedTheater.templateSnapshot.allowExternalControl}
                    collapsible
                  />
                  <div className="cp-black-market-scene-log">
                    {activeScene.messages.length === 0 ? (
                      <p className="cp-black-market-scene-empty">开场已载入。输入第一句话或行动，让角色接住这段剧情。</p>
                    ) : activeScene.messages.map(message => {
                      const isLastMessage = activeScene.messages[activeScene.messages.length - 1]?.id === message.id;
                      const canMutateScene = activeScene.status === "active" && sceneBusy === null;
                      const canRetryAssistant = canMutateScene && message.role === "assistant";
                      const canRetryUser = canMutateScene && message.role === "user" && isLastMessage;
                      return (
                        <article key={message.id} className={`cp-black-market-scene-message is-${message.role}`}>
                          <div className="cp-black-market-scene-message-head">
                            <span>{message.role === "assistant" ? activeScene.characterName : activeScene.userName}</span>
                            <span className="cp-black-market-scene-message-actions" aria-label="消息操作">
                              <button
                                type="button"
                                onClick={() => void copySceneMessage(message.content)}
                                aria-label="复制原文"
                                title="复制"
                              >
                                <Copy size={12} />
                              </button>
                              {message.role === "user" ? (
                                <button
                                  type="button"
                                  onClick={() => beginEditSceneUserMessage(message)}
                                  disabled={!canMutateScene}
                                  aria-label="编辑并重回"
                                  title="编辑"
                                >
                                  <Pencil size={12} />
                                </button>
                              ) : null}
                              {canRetryAssistant ? (
                                <button
                                  type="button"
                                  onClick={() => void retrySceneFromAssistantMessage(message)}
                                  aria-label="重试以下"
                                  title="重试以下"
                                >
                                  <RotateCcw size={12} />
                                </button>
                              ) : null}
                              {canRetryUser ? (
                                <button
                                  type="button"
                                  onClick={() => void retrySceneFromUserMessage(message)}
                                  aria-label="重新生成"
                                  title="重新生成"
                                >
                                  <RotateCcw size={12} />
                                </button>
                              ) : null}
                            </span>
                          </div>
                          <BlackMarketSceneMessageContent
                            content={message.content}
                            template={launchOwnedTheater.templateSnapshot}
                            characterName={activeScene.characterName}
                            userName={activeScene.userName}
                            messageId={message.id}
                            allowExternalControl={externalCanvasAllowed && launchOwnedTheater.templateSnapshot.allowExternalControl}
                          />
                        </article>
                      );
                    })}
                    {sceneBusy === "reply" ? (
                      <article className="cp-black-market-scene-message is-assistant is-thinking" aria-live="polite">
                        <span>{activeScene.characterName}</span>
                        <div className="cp-black-market-thinking-text">
                          正在思考中
                          <i aria-hidden="true" />
                          <i aria-hidden="true" />
                          <i aria-hidden="true" />
                        </div>
                      </article>
                    ) : null}
                  </div>
                  {activeScene.summary ? (
                    <div className="cp-black-market-scene-summary">
                      <span>RECENT_THEATER</span>
                      <p>{activeScene.summary}</p>
                    </div>
                  ) : null}
                </div>
                {activeScene.status === "active" ? (
                  <div className="cp-black-market-scene-input-wrap">
                    {editingSceneMessageId ? (
                      <div className="cp-black-market-scene-editing">
                        <span>正在编辑历史行动</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSceneMessageId(null);
                            setSceneInput("");
                          }}
                        >
                          取消
                        </button>
                      </div>
                    ) : null}
                    <div className="cp-black-market-scene-input">
                      <textarea
                        value={sceneInput}
                        onChange={event => setSceneInput(event.target.value)}
                        rows={3}
                        placeholder={editingSceneMessageId ? "修改后发送，将重写后续剧情..." : "输入你的行动、台词或选择..."}
                        disabled={sceneBusy !== null}
                      />
                      <button type="button" className="is-primary" disabled={!sceneInput.trim() || sceneBusy !== null} onClick={() => void handleSceneSubmit()}>
                        {sceneBusy === "reply" ? "生成中" : editingSceneMessageId ? "重写" : "发送"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
