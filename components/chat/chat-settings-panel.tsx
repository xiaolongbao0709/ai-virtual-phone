"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
    CHAT_INITIAL_VISIBLE_MESSAGE_COUNT,
    CHAT_LOAD_MORE_MESSAGE_COUNT,
    ChatSession,
    clearChatSessionMessages,
    clearChatSessionToolHistory,
    saveChatSessions,
    loadChatSessions,
    loadChatMessages,
    loadChatContacts,
    getChatMessagePreview,
    pushChatMessage,
    removeChatContact,
    normalizeVisionImagePromptLimit,
    MAX_VISION_IMAGE_PROMPT_LIMIT,
    type ChatMessage,
} from "@/lib/chat-storage";
import {
    GROUP_SELF_KEY,
    applyGroupAdminAction,
    buildGroupAdminNoticeText,
    canGroupAdminAct,
    formatMuteDurationLabel,
    formatMuteRemainingLabel,
    getGroupMemberDisplayName,
    getGroupMuteRemainingMs,
    getGroupOwnerKey,
    getGroupRole,
    pruneExpiredGroupMutes,
    type GroupAdminAction,
} from "@/lib/group-admin";
import { clearChatOfflineTurns } from "@/lib/chat-offline-storage";
import { removeChatSessionCompletely } from "@/lib/chat-session-remove";
import { triggerDeleteFriendReaction } from "@/lib/friend-request-engine";
import { loadCharacters } from "@/lib/character-storage";
import { isAgentComputerConfigured } from "@/lib/agent-computer";
import { CharacterComputerPage } from "./character-computer-page";
import { resolveUserIdentity, loadBindingConfig, loadPresets, resolveBinding } from "@/lib/settings-storage";
import { getStatusRegionConfig, saveStatusRegionConfig, presetSupportsStatusRegion, isCustomStatusRegionActive, STATUS_REGION_SCHEME_TARGET, STATUS_REGION_UPDATED_EVENT, type StatusRegionConfig } from "@/lib/chat-status-region";
import { downloadFile } from "@/lib/download-utils";
import { getSchemes, saveScheme, deleteScheme, type CSSScheme } from "@/lib/css-scheme-storage";
import { CustomStatusFrame } from "@/components/chat/custom-status-frame";
import { KeyboardAutoSendDebounceItem } from "@/components/chat/keyboard-auto-send-debounce-item";
import { ChevronRight, Image as ImageIcon, Video, Mic, UserMinus, UserPlus, Users, Pin, MessageSquare, Search, AlertCircle, Code, Laptop, Trash2, Smile, Sparkles, X, Play, Upload, Download, Save, FolderOpen, type LucideIcon } from "lucide-react";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { ConfirmDialog } from "@/components/ui/modal";
import { CHAT_SESSION_CSS_EXAMPLE } from "@/lib/css-examples";
import { Toggle, Input } from "@/components/ui/form";
import { PageShell } from "@/components/ui/page-shell";

// 自定义状态栏预填模板：微博主页（契约=「状态栏」章节整段正文，含【逻辑】【格式】与包裹要求）
// 预览用的默认示例数据：契约没有自带示例时兜底，字段与下面的微博模板对应
const STATUS_REGION_STARTER_PREVIEW = "名字=林晚\n认证=美食探店博主 · 深夜觅食团成员\n简介=白天写方案，晚上寻宵夜｜私信不回工作请走邮箱\n关注=132\n粉丝=8.7万\n帖子=23分钟前|谁懂啊，加班到十点，楼下面馆居然还给我留了最后一碗牛肉面🥹 #深夜食堂# 老板说看我常来……突然就不想跳槽了|🍜🌃✨|56|203|1.2万\n评论=小奶糖|这就是深夜的意义吧|赞 231\n评论=风住了|老板收留我当洗碗工吧，只求管饭|赞 89\n评论=momo不吃香菜|蹲一个面馆定位！|赞 156";

const STATUS_REGION_STARTER_CONTRACT = [
    "【逻辑】你在维护自己的微博主页。每行一个字段，用=分隔，除格式列出的字段外不要输出其他内容；帖子与评论要符合当前剧情与你的心境，网友评论可玩梗。按生成的内容整块用 [状态栏]...[/状态栏] 包裹输出。",
    "【格式】",
    "[状态栏]",
    "名字=<微博昵称>",
    "认证=<一句认证/身份标签>",
    "简介=<一句个性签名，随剧情心境更新>",
    "关注=<数字>",
    "粉丝=<数字，可带万>",
    "帖子=<时间，如 5分钟前>|<微博正文，可带 #话题#>|<0~4个emoji当配图，没有留空>|<转发数>|<评论数>|<点赞数>",
    "评论=<网友昵称>|<评论内容>|<点赞数>",
    "评论=<网友昵称>|<评论内容>|<点赞数>",
    "评论=<网友昵称>|<评论内容>|<点赞数>",
    "[/状态栏]",
].join("\n");

const STATUS_REGION_STARTER_RENDER = `<style>
  :root{--bg:#fff;--text:#333;--sub:#93999f;--accent:#ff8200;--soft:#f6f7f9;--line:#f0f1f3}
  @media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--text:#e8e8ea;--sub:#8e8e93;--soft:#2a2a2c;--line:#333}}
  body{margin:0;font:12.5px/1.6 -apple-system,system-ui,sans-serif;color:var(--text);background:transparent}
  .wb{background:var(--bg);border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  .cover{height:44px;background:linear-gradient(120deg,#ffb46b,#ff7d52 55%,#f65e7c)}
  .head{padding:0 14px 10px}
  .ava{width:52px;height:52px;border-radius:50%;margin-top:-24px;border:3px solid var(--bg);
       display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff}
  .nrow{display:flex;align-items:center;gap:5px;margin-top:6px}
  .name{font-size:15px;font-weight:700}
  .vip{width:15px;height:15px;border-radius:50%;background:#ffa100;color:#fff;font-size:10px;font-weight:800;
       display:inline-flex;align-items:center;justify-content:center}
  .verify{color:var(--accent);font-size:11px;margin-top:2px}
  .bio{color:var(--sub);font-size:11.5px;margin-top:3px}
  .stats{display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--sub)}
  .stats b{color:var(--text);font-size:12.5px;margin-right:3px}
  .post{margin:0 10px;padding:10px 4px 8px;border-top:1px solid var(--line)}
  .ptime{font-size:10.5px;color:var(--sub)}
  .ptxt{margin-top:4px;white-space:pre-wrap;word-break:break-word}
  .topic{color:#ff8200}
  .pics{display:flex;gap:5px;margin-top:8px}
  .pic{flex:0 0 30%;aspect-ratio:1;border-radius:8px;background:var(--soft);
       display:flex;align-items:center;justify-content:center;font-size:30px}
  .bar{display:flex;margin-top:8px;color:var(--sub);font-size:11px}
  .bar span{flex:1;text-align:center}
  .cmts{margin:0 10px 10px;background:var(--soft);border-radius:10px;padding:8px 10px}
  .cmt{display:flex;gap:7px;padding:5px 0}
  .cmt+.cmt{border-top:1px solid var(--line)}
  .cava{width:22px;height:22px;border-radius:50%;flex:none;
        display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff}
  .cbody{flex:1;min-width:0}
  .cname{color:#eb7340;font-size:11px}
  .ctxt{font-size:11.5px;word-break:break-word}
  .clike{font-size:10px;color:var(--sub);flex:none;padding-top:2px}
</style>
<div id="app"></div>
<script>
(function(){
  var G=[["#f89b6c","#f65e7c"],["#6cb6f8","#5e7cf6"],["#8ce08a","#3cb98f"],["#c99bf5","#8a6cf6"],["#f8d06c","#f6975e"]];
  function grad(s){var n=0;for(var i=0;i<s.length;i++)n+=s.charCodeAt(i);var g=G[n%G.length];
    return "linear-gradient(135deg,"+g[0]+","+g[1]+")";}
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;
    if(txt!=null)e.textContent=txt;return e;}
  var d={},cmts=[];
  (window.STATUS_RAW||"").split(/\\r?\\n/).forEach(function(line){
    var i=line.indexOf("=");if(i<1)return;
    var k=line.slice(0,i).trim(),v=line.slice(i+1).trim();
    if(k==="评论")cmts.push(v);else d[k]=v;
  });
  var name=d["名字"]||"微博用户";
  var app=document.getElementById("app"),wb=el("div","wb");
  wb.appendChild(el("div","cover"));
  var head=el("div","head");
  var ava=el("div","ava",name.slice(0,1));ava.style.background=grad(name);head.appendChild(ava);
  var nrow=el("div","nrow");nrow.appendChild(el("span","name",name));
  nrow.appendChild(el("span","vip","V"));head.appendChild(nrow);
  if(d["认证"])head.appendChild(el("div","verify","\\u5fae\\u535a\\u8ba4\\u8bc1\\uff1a"+d["认证"]));
  if(d["简介"])head.appendChild(el("div","bio",d["简介"]));
  var st=el("div","stats"),s1=el("span"),s2=el("span");
  s1.appendChild(el("b",null,d["关注"]||"0"));s1.appendChild(document.createTextNode("关注"));
  s2.appendChild(el("b",null,d["粉丝"]||"0"));s2.appendChild(document.createTextNode("粉丝"));
  st.appendChild(s1);st.appendChild(s2);head.appendChild(st);wb.appendChild(head);
  if(d["帖子"]){
    var f=d["帖子"].split("|"),post=el("div","post");
    post.appendChild(el("div","ptime",(f[0]||"刚刚")+" \\u00b7 来自微博手机版"));
    var ptxt=el("div","ptxt");
    (f[1]||"").split(/(#[^#]{1,20}#)/).forEach(function(seg){
      if(!seg)return;
      ptxt.appendChild(seg.charAt(0)==="#"&&seg.charAt(seg.length-1)==="#"?el("span","topic",seg):document.createTextNode(seg));
    });
    post.appendChild(ptxt);
    var emo=Array.from(f[2]||"").filter(function(c){return c.trim()&&!/[\\ufe0f\\u200d]/.test(c)});
    if(emo.length){var pics=el("div","pics");
      emo.slice(0,3).forEach(function(c){pics.appendChild(el("div","pic",c));});
      post.appendChild(pics);}
    var bar=el("div","bar");
    bar.appendChild(el("span",null,"\\u21bb "+(f[3]||"0")));
    bar.appendChild(el("span",null,"\\ud83d\\udcac "+(f[4]||"0")));
    bar.appendChild(el("span",null,"\\u2661 "+(f[5]||"0")));
    post.appendChild(bar);wb.appendChild(post);
  }
  if(cmts.length){
    var box=el("div","cmts");
    cmts.forEach(function(line){
      var p=line.split("|"),c=el("div","cmt");
      var ca=el("div","cava",(p[0]||"?").slice(0,1));ca.style.background=grad(p[0]||"?");
      var body=el("div","cbody");
      body.appendChild(el("div","cname",p[0]||"网友"));
      body.appendChild(el("div","ctxt",p[1]||""));
      c.appendChild(ca);c.appendChild(body);
      c.appendChild(el("div","clike","\\u2661 "+String(p[2]||"").replace(/[^0-9.\\u4e07\\u4ebf]/g,"")));
      box.appendChild(c);
    });
    wb.appendChild(box);
  }
  app.appendChild(wb);
})();
</` + `script>`;

import {
    DEFAULT_CHAT_BILINGUAL_PROMPT,
    DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT,
    DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT,
    DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT,
} from "@/lib/bilingual-prompt-defaults";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import { MessageBubble, isStandaloneHtmlPreviewContent } from "./message-bubble";
import { ScreenEffectSettingsModal } from "./screen-effect-settings-modal";

type ChatSettingsPanelProps = {
    session: ChatSession;
    onClose: () => void;
    onJumpToMessage?: (messageId: string) => void;
    onDeleteFriend?: () => void;
    onSessionDeleted?: () => void;
    onToolHistoryCleared?: () => void;
    onOfflineHistoryCleared?: () => void;
    offlineHistoryBusy?: boolean;
};

const chatInfoIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

type SearchResultRole = "user" | "assistant" | "system";
type SearchResultMediaType = NonNullable<ChatMessage["mediaType"]>;
const SEARCH_RESULT_LIMIT = 80;
const SEARCH_TEXT_SCAN_LIMIT = 20_000;
const SEARCH_SCAN_CHUNK_SIZE = 120;

const SEARCH_MEDIA_BUBBLE_TYPES = new Set<SearchResultMediaType>([
    "sticker",
    "red_packet",
    "transfer",
    "payment_request",
    "gift",
    "image",
    "location",
    "music_share",
    "xiaohongshu_note_share",
    "media_file",
]);

const SEARCH_VISUAL_MEDIA_TYPES = new Set<SearchResultMediaType>([
    ...SEARCH_MEDIA_BUBBLE_TYPES,
    "audio",
    "video",
    "quote",
]);

const SEARCH_ACTION_MEDIA_TYPES = new Set<SearchResultMediaType>([
    "poke",
    "accept_red_packet",
    "decline_red_packet",
    "accept_transfer",
    "decline_transfer",
    "accept_payment_request",
    "decline_payment_request",
    "group_admin_notice",
]);

function getSearchResultRole(msg: ChatMessage): SearchResultRole {
    if (msg.role === "system" || (msg.mediaType && SEARCH_ACTION_MEDIA_TYPES.has(msg.mediaType))) return "system";
    return msg.role === "user" ? "user" : "assistant";
}

function isSearchHiddenMessage(msg: ChatMessage): boolean {
    return msg.role === "tool"
        || msg.mediaType === "tool_call"
        || msg.mediaType === "tool_result"
        || msg.mediaType === "tool_notice"
        || msg.mediaType === "memory_write_request"
        || Boolean(msg.nativeToolCalls?.length && !msg.content.trim());
}

function isSearchVisibleMessage(msg: ChatMessage): boolean {
    if (isSearchHiddenMessage(msg)) return false;
    if (msg.mediaType && SEARCH_VISUAL_MEDIA_TYPES.has(msg.mediaType)) return true;
    if (msg.statusPanel || msg.innerMonologue) return true;
    return Boolean(getSearchResultText(msg));
}

function getSearchResultText(msg: ChatMessage): string {
    return (msg.content.trim() || getChatMessagePreview(msg)).trim();
}

function clipSearchText(value: unknown): string {
    return String(value ?? "").slice(0, SEARCH_TEXT_SCAN_LIMIT);
}

function getSearchHaystack(msg: ChatMessage): string {
    return [
        clipSearchText(msg.content),
        clipSearchText(getChatMessagePreview(msg)),
        clipSearchText(msg.mediaData?.label),
        clipSearchText(msg.mediaData?.musicTitle),
        clipSearchText(msg.mediaData?.xiaohongshuTitle),
        clipSearchText(msg.mediaData?.giftName),
        clipSearchText(msg.senderName),
    ].filter(Boolean).join("\n");
}

function ChatInfoIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="chat-info-icon" style={chatInfoIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

export function ChatSettingsPanel({
    session,
    onClose,
    onJumpToMessage,
    onDeleteFriend,
    onSessionDeleted,
    onToolHistoryCleared,
    onOfflineHistoryCleared,
    offlineHistoryBusy = false,
}: ChatSettingsPanelProps) {
    const [backgroundImage, setBackgroundImage] = useState<string>(session.backgroundImage || "");
    const [alias, setAlias] = useState<string>(session.alias || "");
    const [videoBackground, setVideoBackground] = useState<string>(session.videoBackground || "");
    const [voiceBackground, setVoiceBackground] = useState<string>(session.voiceBackground || "");
    const [isPinned, setIsPinned] = useState(session.isPinned || false);
    // 自定义状态栏（状态区）
    const [statusRegion, setStatusRegion] = useState<StatusRegionConfig>(() => getStatusRegionConfig(session.id));
    const [showStatusRegionDialog, setShowStatusRegionDialog] = useState(false);
    const [draftContract, setDraftContract] = useState("");
    const [draftRender, setDraftRender] = useState("");
    const [statusPreviewRaw, setStatusPreviewRaw] = useState(STATUS_REGION_STARTER_PREVIEW);
    const [previewHtml, setPreviewHtml] = useState("");
    const statusImportInputRef = useRef<HTMLInputElement | null>(null);
    // 状态栏方案库：复用 CSS 方案存储，负载为 JSON（契约+渲染+示例数据），全局跨会话
    const STATUS_SCHEME_TARGET = STATUS_REGION_SCHEME_TARGET;
    const [showStatusSchemes, setShowStatusSchemes] = useState(false);
    const [statusSchemes, setStatusSchemes] = useState<CSSScheme[]>([]);
    const [statusSchemeName, setStatusSchemeName] = useState("");
    const [statusSchemeDeleteId, setStatusSchemeDeleteId] = useState<string | null>(null);
    const applyStatusScheme = (scheme: CSSScheme) => {
        try {
            const parsed = JSON.parse(scheme.css) as Record<string, unknown>;
            const contract = typeof parsed.contract === "string" ? parsed.contract : "";
            const renderHtml = typeof parsed.renderHtml === "string" ? parsed.renderHtml : "";
            if (!contract && !renderHtml) throw new Error("empty");
            setDraftContract(contract);
            setDraftRender(renderHtml);
            if (typeof parsed.previewRaw === "string" && parsed.previewRaw) setStatusPreviewRaw(parsed.previewRaw);
            setPreviewHtml(renderHtml);
        } catch {
            alert("方案数据损坏，无法应用");
        }
    };
    const exportStatusRegion = () => {
        const payload = { type: "ai-phone-status-region", version: 1, contract: draftContract, renderHtml: draftRender, previewRaw: statusPreviewRaw };
        void downloadFile(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "自定义状态栏.json");
    };
    const importStatusRegion = (file: File) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result || "")) as Record<string, unknown>;
                const contract = typeof parsed.contract === "string" ? parsed.contract : "";
                const renderHtml = typeof parsed.renderHtml === "string" ? parsed.renderHtml : "";
                if (!contract && !renderHtml) throw new Error("empty");
                setDraftContract(contract);
                setDraftRender(renderHtml);
                if (typeof parsed.previewRaw === "string" && parsed.previewRaw) setStatusPreviewRaw(parsed.previewRaw);
                setPreviewHtml(renderHtml);
            } catch {
                alert("导入失败：不是有效的状态栏配置文件");
            }
        };
        reader.readAsText(file);
    };
    const statusPresetSupported = useMemo(() => {
        if (session.isGroup) return false;
        try {
            const slot = resolveBinding(loadBindingConfig(), session.contactId, "chat");
            const presets = loadPresets();
            const preset = (slot.presetId ? presets.find(item => item.id === slot.presetId) : null) ?? presets.find(item => item.builtIn) ?? null;
            return !!preset && presetSupportsStatusRegion(preset.prompts.map(item => item.content));
        } catch { return false; }
    }, [session.isGroup, session.contactId]);
    const saveStatusRegion = (next: StatusRegionConfig) => {
        setStatusRegion(next);
        saveStatusRegionConfig(session.id, next);
    };
    // 小卷的状态栏工具写入后广播，这里同步刷新——否则本页状态只在挂载时初始化一次，
    // 面板开着的时候被写入就会停在旧值，表现为「后台写了、前台看不到」。
    // 弹窗正开着时连草稿一起换掉，用户看到的就是小卷刚写的那份，可继续手改。
    useEffect(() => {
        const onExternalWrite = (event: Event) => {
            const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
            if (detail?.sessionId && detail.sessionId !== session.id) return;
            const next = getStatusRegionConfig(session.id);
            setStatusRegion(next);
            if (showStatusRegionDialog) {
                setDraftContract(next.contract || STATUS_REGION_STARTER_CONTRACT);
                setDraftRender(next.renderHtml || STATUS_REGION_STARTER_RENDER);
                setStatusPreviewRaw(next.previewRaw || STATUS_REGION_STARTER_PREVIEW);
                setPreviewHtml("");
            }
        };
        window.addEventListener(STATUS_REGION_UPDATED_EVENT, onExternalWrite);
        return () => window.removeEventListener(STATUS_REGION_UPDATED_EVENT, onExternalWrite);
    }, [session.id, showStatusRegionDialog]);
    const openStatusRegionDialog = () => {
        setDraftContract(statusRegion.contract || STATUS_REGION_STARTER_CONTRACT);
        setDraftRender(statusRegion.renderHtml || STATUS_REGION_STARTER_RENDER);
        // 示例数据跟着契约走：小卷写入时会一并给出，否则内置样例的字段对不上新契约
        setStatusPreviewRaw(statusRegion.previewRaw || STATUS_REGION_STARTER_PREVIEW);
        setPreviewHtml("");
        setShowStatusRegionDialog(true);
    };
    const [visionImagePromptLimit, setVisionImagePromptLimit] = useState(() => normalizeVisionImagePromptLimit(session.visionImagePromptLimit));
    const [bilingualTranslationEnabled, setBilingualTranslationEnabled] = useState(session.bilingualTranslationEnabled !== false);
    const [offlineSummaryRetry, setOfflineSummaryRetry] = useState(session.offlineSummaryRetry !== false);
    const [collapseBilingualTranslation, setCollapseBilingualTranslation] = useState(session.collapseBilingualTranslation !== false);
    const [discardInvalidStickers, setDiscardInvalidStickers] = useState(session.discardInvalidStickers === true);
    // 流式生成：按会话区分（线上/线下），存 ChatSession 字段，默认关
    const [streamOnline, setStreamOnline] = useState(session.streamOnline === true);
    const [streamOffline, setStreamOffline] = useState(session.streamOffline === true);
    const defaultBilingualPrompt = session.isGroup ? DEFAULT_GROUP_CHAT_BILINGUAL_PROMPT : DEFAULT_CHAT_BILINGUAL_PROMPT;
    const defaultOfflineBilingualPrompt = session.isGroup ? DEFAULT_GROUP_OFFLINE_CHAT_BILINGUAL_PROMPT : DEFAULT_OFFLINE_CHAT_BILINGUAL_PROMPT;
    const [bilingualTranslationPrompt, setBilingualTranslationPrompt] = useState(session.bilingualTranslationPrompt || defaultBilingualPrompt);
    const [bilingualPromptDraft, setBilingualPromptDraft] = useState(session.bilingualTranslationPrompt || defaultBilingualPrompt);
    const [offlineBilingualTranslationPrompt, setOfflineBilingualTranslationPrompt] = useState(session.offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
    const [offlineBilingualPromptDraft, setOfflineBilingualPromptDraft] = useState(session.offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
    const [customCSS, setCustomCSS] = useState(() => {
        // Read latest CSS from storage (in case 小卷 updated it)
        const sessions = loadChatSessions();
        const latest = sessions.find(s => s.id === session.id);
        return (latest as Record<string, unknown>)?.customCSS as string || session.customCSS || "";
    });

    const [showConfirmClear, setShowConfirmClear] = useState(false);
    const [showConfirmClearOffline, setShowConfirmClearOffline] = useState(false);
    const [showConfirmClearTools, setShowConfirmClearTools] = useState(false);
    const [showConfirmDeleteSession, setShowConfirmDeleteSession] = useState(false);
    const [showConfirmDelete, setShowConfirmDelete] = useState(false);
    const [editingAlias, setEditingAlias] = useState(false);
    const [editingBilingualPrompt, setEditingBilingualPrompt] = useState(false);
    const [editingCSS, setEditingCSS] = useState(false);
    const [showScreenEffects, setShowScreenEffects] = useState(false);
    const [showSearch, setShowSearch] = useState(false);
    // TA 的电脑：翻看角色云端电脑（连接了角色电脑才显示入口）
    const [showComputer, setShowComputer] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [submittedSearchQuery, setSubmittedSearchQuery] = useState("");
    const [searchHistoryMessages, setSearchHistoryMessages] = useState<ChatMessage[]>([]);
    const [searchHasMore, setSearchHasMore] = useState(false);
    const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const searchRunRef = useRef(0);

    const loadSearchHistoryWindow = (count = CHAT_INITIAL_VISIBLE_MESSAGE_COUNT) => {
        const visibleMessages = loadChatMessages(session.id).filter(isSearchVisibleMessage);
        const nextCount = Math.min(Math.max(count, CHAT_INITIAL_VISIBLE_MESSAGE_COUNT), visibleMessages.length);
        setSearchHistoryMessages(visibleMessages.slice(-nextCount).reverse());
        setSearchHasMore(nextCount < visibleMessages.length);
    };

    const openSearchPanel = () => {
        searchRunRef.current += 1;
        setSearchQuery("");
        setSubmittedSearchQuery("");
        setSearchResults([]);
        setIsSearching(false);
        loadSearchHistoryWindow();
        setShowSearch(true);
    };

    const closeSearchPanel = () => {
        searchRunRef.current += 1;
        setShowSearch(false);
        setSearchQuery("");
        setSubmittedSearchQuery("");
        setSearchResults([]);
        setSearchHistoryMessages([]);
        setSearchHasMore(false);
        setIsSearching(false);
    };

    const loadMoreSearchHistory = () => {
        const visibleMessages = loadChatMessages(session.id).filter(isSearchVisibleMessage);
        const nextCount = Math.min(searchHistoryMessages.length + CHAT_LOAD_MORE_MESSAGE_COUNT, visibleMessages.length);
        setSearchHistoryMessages(visibleMessages.slice(-nextCount).reverse());
        setSearchHasMore(nextCount < visibleMessages.length);
    };

    const runSearch = () => {
        const rawQuery = searchQuery.trim();
        const runId = searchRunRef.current + 1;
        searchRunRef.current = runId;
        setSubmittedSearchQuery(rawQuery);

        if (!rawQuery) {
            setSearchResults([]);
            setIsSearching(false);
            loadSearchHistoryWindow();
            return;
        }

        const needle = rawQuery.toLowerCase();
        const results: ChatMessage[] = [];
        setSearchResults([]);
        setIsSearching(true);

        window.setTimeout(() => {
            if (searchRunRef.current !== runId) return;
            const msgs = loadChatMessages(session.id);
            let index = msgs.length - 1;

            const scanChunk = () => {
                if (searchRunRef.current !== runId) return;

                const stop = Math.max(-1, index - SEARCH_SCAN_CHUNK_SIZE);
                for (; index > stop && results.length < SEARCH_RESULT_LIMIT; index -= 1) {
                    const msg = msgs[index];
                    if (!isSearchVisibleMessage(msg)) continue;
                    const haystack = getSearchHaystack(msg);
                    if (haystack && haystack.toLowerCase().includes(needle)) results.push(msg);
                }

                if (results.length >= SEARCH_RESULT_LIMIT || index < 0) {
                    setSearchResults([...results]);
                    setIsSearching(false);
                    return;
                }

                window.setTimeout(scanChunk, 0);
            };

            scanChunk();
        }, 0);
    };

    const [groupName, setGroupName] = useState(session.groupName || "");

    const characters = loadCharacters();
    const character = characters.find(c => c.id === session.contactId);

    const characterName = session.isGroup
        ? (groupName || session.groupName || "群聊")
        : (alias || character?.name || `User_${session.contactId.slice(-4)}`);

    // Group members
    const groupChars = session.isGroup
        ? (session.participantIds || []).map(id => characters.find(c => c.id === id)).filter(Boolean)
        : [];
    const userIdentity = resolveUserIdentity(undefined, session.isGroup ? "group_chat" : "chat");

    // ── Group member management ──
    const [, setRosterVersion] = useState(0); // bump to re-render after admin actions
    const [memberActionKey, setMemberActionKey] = useState<string | null>(null);
    const [mutePickerKey, setMutePickerKey] = useState<string | null>(null);
    const [showInvitePicker, setShowInvitePicker] = useState(false);
    const [allowAdminOnUser, setAllowAdminOnUser] = useState(session.allowAdminActionsOnUser === true);
    if (session.isGroup) pruneExpiredGroupMutes(session);
    const userName = userIdentity?.name || "用户";
    const ownerKey = session.isGroup ? getGroupOwnerKey(session) : "";
    const roleLabel = (key: string): string => {
        const role = getGroupRole(session, key);
        return role === "owner" ? "群主" : role === "admin" ? "管理员" : "";
    };
    type MemberEntry = { key: string; name: string; avatar?: string; muteMs: number };
    const memberEntries: MemberEntry[] = session.isGroup
        ? [
            ...(session.isSpectator ? [] : [{
                key: GROUP_SELF_KEY,
                name: `${userName}（我）`,
                avatar: userIdentity?.avatarUrl || undefined,
                muteMs: getGroupMuteRemainingMs(session, GROUP_SELF_KEY),
            }]),
            ...groupChars.map(c => ({
                key: c!.id,
                name: c!.name,
                avatar: c!.avatar || undefined,
                muteMs: getGroupMuteRemainingMs(session, c!.id),
            })),
        ]
        : [];
    const memberActionsFor = (key: string): { action: GroupAdminAction; label: string; danger?: boolean }[] => {
        if (!session.isGroup || session.isSpectator) return [];
        const items: { action: GroupAdminAction; label: string; danger?: boolean }[] = [];
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "transfer_owner", key)) items.push({ action: "transfer_owner", label: "转让群主" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "set_admin", key)) items.push({ action: "set_admin", label: "设为管理员" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "unset_admin", key)) items.push({ action: "unset_admin", label: "取消管理员" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "mute", key)) items.push({ action: "mute", label: "禁言" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "unmute", key)) items.push({ action: "unmute", label: "解除禁言" });
        if (canGroupAdminAct(session, GROUP_SELF_KEY, "kick", key)) items.push({ action: "kick", label: "移出群聊", danger: true });
        return items;
    };
    const pushAdminNotice = (action: GroupAdminAction, actorName: string, targetKey: string, muteMinutes?: number) => {
        const targetName = getGroupMemberDisplayName(targetKey, userName);
        // role 用 user（操作人是用户本人）：与 AI 侧 assistant 动作消息对称，
        // UI 仍按系统通知渲染，进历史时还原为 [A将B移出了群聊] 协议格式
        pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: buildGroupAdminNoticeText(action, actorName, targetName, muteMinutes),
            mediaType: "group_admin_notice",
            mediaData: {
                adminAction: action,
                adminActorName: actorName,
                adminTargetName: targetName,
                ...(action === "mute" ? { adminMuteMinutes: muteMinutes || 10 } : {}),
            },
        });
    };
    const performAdminAction = (action: GroupAdminAction, targetKey: string, muteMinutes?: number) => {
        if (!canGroupAdminAct(session, GROUP_SELF_KEY, action, targetKey)) return;
        applyGroupAdminAction(session, action, GROUP_SELF_KEY, targetKey, muteMinutes);
        pushAdminNotice(action, userName, targetKey, muteMinutes);
        setMemberActionKey(null);
        setMutePickerKey(null);
        setShowInvitePicker(false);
        setRosterVersion(v => v + 1);
    };
    // 上帝按钮：不走权限矩阵，防止用户把自己锁死
    const reclaimOwnership = () => {
        const updates: Partial<ChatSession> = { groupOwnerId: GROUP_SELF_KEY };
        const sessions = loadChatSessions();
        const idx = sessions.findIndex(s => s.id === session.id);
        if (idx !== -1) {
            sessions[idx] = { ...sessions[idx], ...updates };
            saveChatSessions(sessions);
        }
        Object.assign(session, updates);
        pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: `${userName}收回了群主身份`,
            mediaType: "group_admin_notice",
            mediaData: { adminAction: "transfer_owner", adminActorName: userName, adminTargetName: userName },
        });
        setRosterVersion(v => v + 1);
    };
    const inviteCandidates = session.isGroup
        ? loadChatContacts()
            .map(c => characters.find(ch => ch.id === c.characterId))
            .filter((c): c is NonNullable<typeof c> => Boolean(c && !(session.participantIds || []).includes(c.id)))
        : [];
    const canInvite = session.isGroup && !session.isSpectator
        && getGroupRole(session, GROUP_SELF_KEY) !== "member";
    const MUTE_DURATION_OPTIONS = [10, 60, 720, 1440, 4320];

    const updateSession = (updates: Partial<ChatSession>) => {
        const sessions = loadChatSessions();
        const sessIdx = sessions.findIndex(s => s.id === session.id);
        if (sessIdx !== -1) {
            sessions[sessIdx] = { ...sessions[sessIdx], ...updates };
            saveChatSessions(sessions);
            Object.assign(session, updates);
        }
    };

    const handleClearHistory = () => {
        clearChatSessionMessages(session.id);
        setShowConfirmClear(false);
    };

    const handleClearOfflineHistory = () => {
        if (offlineHistoryBusy) return;
        clearChatOfflineTurns(session.id);
        onOfflineHistoryCleared?.();
        setShowConfirmClearOffline(false);
    };

    const handleClearToolHistory = () => {
        clearChatSessionToolHistory(session.id);
        onToolHistoryCleared?.();
        setShowConfirmClearTools(false);
    };

    const handleDeleteSession = () => {
        if (offlineHistoryBusy) return;
        removeChatSessionCompletely(session.id);
        setShowConfirmDeleteSession(false);
        onSessionDeleted?.();
    };

    const updateVisionImagePromptLimit = (value: unknown) => {
        const next = normalizeVisionImagePromptLimit(value);
        setVisionImagePromptLimit(next);
        updateSession({ visionImagePromptLimit: next });
    };

    const openBilingualPromptEditor = () => {
        setBilingualPromptDraft(bilingualTranslationPrompt || defaultBilingualPrompt);
        setOfflineBilingualPromptDraft(offlineBilingualTranslationPrompt || defaultOfflineBilingualPrompt);
        setEditingBilingualPrompt(true);
    };

    const saveBilingualPromptDraft = () => {
        setBilingualTranslationPrompt(bilingualPromptDraft);
        setOfflineBilingualTranslationPrompt(offlineBilingualPromptDraft);
        updateSession({
            bilingualTranslationPrompt: bilingualPromptDraft,
            offlineBilingualTranslationPrompt: offlineBilingualPromptDraft,
        });
        setEditingBilingualPrompt(false);
    };

    const handleImageUpload = async (
        e: React.ChangeEvent<HTMLInputElement>,
        setter: React.Dispatch<React.SetStateAction<string>>,
        key: keyof ChatSession
    ) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const id = await saveChatImageToIndexedDB(file);
            setter(id);
            updateSession({ [key]: id });
        } catch (error) {
            console.error("Failed to save image", error);
            alert("图片保存失败，请重试");
        }
    };

    // Group video: per-participant background upload
    const [groupVideoBgs, setGroupVideoBgs] = useState<Record<string, string>>(session.groupVideoBackgrounds || {});
    const handleGroupVideoBgUpload = async (e: React.ChangeEvent<HTMLInputElement>, participantKey: string) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const id = await saveChatImageToIndexedDB(file);
            const updated = { ...groupVideoBgs, [participantKey]: id };
            setGroupVideoBgs(updated);
            updateSession({ groupVideoBackgrounds: updated });
        } catch {
            alert("图片保存失败，请重试");
        }
    };

    const jumpToSearchMessage = (messageId: string) => {
        if (onJumpToMessage) {
            onJumpToMessage(messageId);
        }
        closeSearchPanel();
        onClose();
    };

    const renderSearchMessage = (msg: ChatMessage) => {
        const resultRole = getSearchResultRole(msg);
        const senderChar = session.isGroup && msg.senderCharacterId
            ? characters.find(c => c.id === msg.senderCharacterId) || character
            : character;
        const senderName = msg.role === "user"
            ? "我"
            : (session.isGroup ? (msg.senderName || senderChar?.name || characterName) : characterName);
        const isSystemMessage = resultRole === "system";
        const isStandaloneHtmlPreview = !msg.mediaType && isStandaloneHtmlPreviewContent(msg.content);
        const isMediaBubble = (msg.mediaType && SEARCH_MEDIA_BUBBLE_TYPES.has(msg.mediaType)) || isStandaloneHtmlPreview;
        const bubbleRole = msg.role === "user" ? "user" : "assistant";

        return (
            <div key={msg.id} className="flex flex-col gap-2">
                <div className="flex justify-center">
                    <span className="chat-sys-msg py-[2px] px-2 rounded select-none">
                        {new Date(msg.createdAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                </div>
                {isSystemMessage ? (
                    <div className="chat-msg-wrapper" data-role="system">
                        <div
                            role="button"
                            tabIndex={0}
                            className="chat-sys-msg relative cursor-pointer"
                            onClick={() => jumpToSearchMessage(msg.id)}
                            onKeyDown={e => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    jumpToSearchMessage(msg.id);
                                }
                            }}
                        >
                            {msg.mediaType === "poke"
                                ? <MessageBubble msg={msg} charName={senderChar?.name} userName={userIdentity?.name || "你"} characterId={msg.senderCharacterId || session.contactId} />
                                : getSearchResultText(msg)}
                        </div>
                    </div>
                ) : (
                    <div className="chat-msg-wrapper" data-role={resultRole}>
                        {resultRole === "assistant" && (
                            <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-[var(--c-page-body-bg)] shrink-0 flex items-center justify-center overflow-hidden">
                                {senderChar?.avatar ? (
                                    <img src={senderChar.avatar} className="w-full h-full object-cover" alt="" />
                                ) : (
                                    <ChatFallbackAvatar />
                                )}
                            </div>
                        )}
                        <div className={`chat-msg-content-wrap flex flex-col min-w-0 max-w-[70%] ${isStandaloneHtmlPreview ? "chat-msg-content-wrap-html" : ""}`}>
                            {session.isGroup && msg.role !== "user" && (
                                <span className="chat-group-sender-name">
                                    {senderName}
                                    {msg.senderCharacterId && (session.participantIds || []).includes(msg.senderCharacterId) && (() => {
                                        const role = getGroupRole(session, msg.senderCharacterId);
                                        if (role === "owner") return <span className="chat-role-badge chat-role-badge-owner">群主</span>;
                                        if (role === "admin") return <span className="chat-role-badge chat-role-badge-admin">管理员</span>;
                                        return null;
                                    })()}
                                </span>
                            )}
                            <div
                                role="button"
                                tabIndex={0}
                                onClick={() => jumpToSearchMessage(msg.id)}
                                onKeyDown={e => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        jumpToSearchMessage(msg.id);
                                    }
                                }}
                                className={`chat-bubble-role-${bubbleRole} ${isMediaBubble ? "chat-bubble-media" : ""} ${isStandaloneHtmlPreview ? "chat-bubble-html-preview" : ""} ${msg.mediaType === "music_share" ? "chat-bubble-music-share" : ""} ${msg.mediaType === "gift" || msg.mediaType === "image" || isStandaloneHtmlPreview ? "rounded-none" : "rounded-md"} break-words relative cursor-pointer select-none`}
                                data-ui={bubbleRole === "user" ? "bubble-user" : "bubble-bot"}
                                data-msg-id={msg.id}
                            >
                                <MessageBubble
                                    msg={msg}
                                    charName={senderChar?.name}
                                    userName={userIdentity?.name || "你"}
                                    groupSize={session.isGroup ? (session.participantIds?.length || 0) + (session.isSpectator ? 0 : 1) : undefined}
                                    characterId={msg.senderCharacterId || session.contactId}
                                    defaultTranslationExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                />
                            </div>
                        </div>
                        {resultRole === "user" && (
                            <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-[var(--c-page-body-bg)] shrink-0 flex items-center justify-center overflow-hidden">
                                {userIdentity?.avatarUrl ? (
                                    <img src={userIdentity.avatarUrl} alt="Me" className="w-full h-full object-cover rounded-[20px]" />
                                ) : (
                                    <ChatFallbackAvatar />
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const searchMode = submittedSearchQuery.trim().length > 0;
    const displayedSearchMessages = searchMode ? searchResults : searchHistoryMessages;

    return (
        <PageShell title="聊天信息" onBack={onClose} className="absolute inset-0 z-[100]">
            <div className="page-menu chat-info-menu">
                {/* Basic Info & Search */}
                <div className="menu-group">
                    <button className="menu-item" onClick={() => setEditingAlias(true)}>
                        <ChatInfoIcon icon={MessageSquare} color={CONTENT_APP_ACCENTS.chat} />
                        <div className="menu-label-group"><span className="menu-label">{session.isGroup ? "群聊名称" : "设置备注"}</span></div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{session.isGroup ? (groupName || "未设置") : (alias || "无备注")}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                    <button className="menu-item" onClick={openSearchPanel}>
                        <ChatInfoIcon icon={Search} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group"><span className="menu-label">查找聊天记录</span></div>
                        <div className="menu-right"><ChevronRight size={16} /></div>
                    </button>
                    {!session.isGroup && isAgentComputerConfigured() && (
                        <button className="menu-item" onClick={() => setShowComputer(true)}>
                            <ChatInfoIcon icon={Laptop} color={BINDING_ACCENTS.memory} />
                            <div className="menu-label-group">
                                <span className="menu-label">TA 的电脑</span>
                                <span className="menu-desc">看看 TA 在自己电脑上存了什么</span>
                            </div>
                            <div className="menu-right"><ChevronRight size={16} /></div>
                        </button>
                    )}
                </div>

                {/* Group member management */}
                {session.isGroup && (
                    <div className="menu-group">
                        <div className="menu-item" style={{ cursor: "default" }}>
                            <ChatInfoIcon icon={Users} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">群成员管理</span>
                                <span className="menu-desc">
                                    {session.isSpectator
                                        ? "围观群：你不在群内，身份只读"
                                        : (getGroupRole(session, GROUP_SELF_KEY) === "member"
                                            ? "你是普通成员，没有管理权限"
                                            : "点击成员执行管理操作")}
                                </span>
                            </div>
                        </div>
                        {memberEntries.map(entry => {
                            const badge = roleLabel(entry.key);
                            const actionable = memberActionsFor(entry.key).length > 0;
                            return (
                                <button
                                    key={entry.key}
                                    className="menu-item"
                                    style={{ paddingLeft: 72, ...(actionable ? {} : { cursor: "default" }) }}
                                    onClick={() => { if (actionable) setMemberActionKey(entry.key); }}
                                >
                                    <div className="w-[24px] h-[24px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0 flex items-center justify-center">
                                        {entry.avatar ? <img src={entry.avatar} className="w-full h-full object-cover" alt="" /> : <ChatFallbackAvatar />}
                                    </div>
                                    <div className="menu-label-group">
                                        <span className="menu-label">{entry.name}</span>
                                        {entry.muteMs > 0 && (
                                            <span className="menu-desc">禁言中 · 剩余{formatMuteRemainingLabel(entry.muteMs)}</span>
                                        )}
                                    </div>
                                    <div className="menu-right">
                                        {badge && <span className="menu-desc mr-1">{badge}</span>}
                                        {actionable && <ChevronRight size={14} />}
                                    </div>
                                </button>
                            );
                        })}
                        {canInvite && (
                            <button className="menu-item" onClick={() => setShowInvitePicker(true)}>
                                <ChatInfoIcon icon={UserPlus} color={BINDING_ACCENTS.voice} />
                                <div className="menu-label-group"><span className="menu-label">拉人进群</span></div>
                                <div className="menu-right"><ChevronRight size={16} /></div>
                            </button>
                        )}
                        {!session.isSpectator && (
                            <div className="menu-item">
                                <ChatInfoIcon icon={AlertCircle} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">允许角色对我使用管理操作</span>
                                    <span className="menu-desc">开启后群主/管理员角色可以禁言你（不能踢你）</span>
                                </div>
                                <div className="menu-right">
                                    <Toggle
                                        checked={allowAdminOnUser}
                                        onChange={c => { setAllowAdminOnUser(c); updateSession({ allowAdminActionsOnUser: c }); }}
                                    />
                                </div>
                            </div>
                        )}
                        {!session.isSpectator && ownerKey !== GROUP_SELF_KEY && (
                            <button className="menu-item" onClick={reclaimOwnership}>
                                <ChatInfoIcon icon={Users} color="var(--c-danger)" />
                                <div className="menu-label-group">
                                    <span className="menu-label menu-label-danger">收回群主身份</span>
                                    <span className="menu-desc">上帝操作：无视群规则直接拿回群主</span>
                                </div>
                            </button>
                        )}
                    </div>
                )}

                {/* 状态栏（状态区）：原生开关 + 自定义契约/渲染。
                    群聊同样支持：群回复按 [角色名]: 切段后每段各自解析，
                    一份契约 + 一份渲染，群里每个角色各出一条状态栏。 */}
                {(
                    <div className="menu-group">
                        <div className="menu-item">
                            <ChatInfoIcon icon={Code} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">原生状态栏</span>
                                <span className="menu-desc">{statusPresetSupported ? "状态值与内心的默认输出（关闭后整块从提示词移除）" : "当前预设未声明状态区宏，仅默认预设支持"}</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={statusRegion.mode === "native"}
                                    disabled={!statusPresetSupported}
                                    onChange={c => {
                                        if (!statusPresetSupported) return;
                                        saveStatusRegion({
                                            ...statusRegion,
                                            mode: c ? "native" : (statusRegion.contract.trim() && statusRegion.renderHtml.trim() ? "custom" : "off"),
                                        });
                                    }}
                                />
                            </div>
                        </div>
                        {statusPresetSupported && statusRegion.mode !== "native" && (
                            <div className="menu-item cursor-pointer" onClick={openStatusRegionDialog}>
                                <ChatInfoIcon icon={Sparkles} color={BINDING_ACCENTS.preset} />
                                <div className="menu-label-group">
                                    <span className="menu-label">自定义状态栏</span>
                                    <span className="menu-desc">{isCustomStatusRegionActive(statusRegion)
                                        ? "已启用——点此编辑契约与渲染"
                                        : statusRegion.contract.trim() && statusRegion.renderHtml.trim()
                                            ? "已停用——配置保留，拨开关重新启用"
                                            : "未配置——点此填写契约与渲染"}</span>
                                </div>
                                <div className="menu-right" onClick={e => e.stopPropagation()}>
                                    <Toggle
                                        checked={isCustomStatusRegionActive(statusRegion)}
                                        onChange={c => {
                                            if (!c) { saveStatusRegion({ ...statusRegion, mode: "off" }); return; }
                                            if (statusRegion.contract.trim() && statusRegion.renderHtml.trim()) {
                                                saveStatusRegion({ ...statusRegion, mode: "custom" });
                                            } else {
                                                openStatusRegionDialog(); // 还没配置：先进弹窗填，保存即启用
                                            }
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Toggles */}
                <div className="menu-group">
                    <div className="menu-item">
                        <ChatInfoIcon icon={Pin} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group"><span className="menu-label">置顶聊天</span></div>
                        <div className="menu-right">
                            <Toggle checked={isPinned} onChange={c => { setIsPinned(c); updateSession({ isPinned: c }); }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <ChatInfoIcon icon={ImageIcon} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group">
                            <span className="menu-label">传入最近图片数</span>
                            <span className="menu-desc">进入模型视觉上下文的最近图片数量，0 表示不传图片内容</span>
                        </div>
                        <div className="menu-right gap-2">
                            <button
                                type="button"
                                className="ui-btn ui-btn-ghost h-8 w-8 p-0"
                                onClick={() => updateVisionImagePromptLimit(visionImagePromptLimit - 1)}
                                disabled={visionImagePromptLimit <= 0}
                            >
                                -
                            </button>
                            <input
                                type="number"
                                min={0}
                                max={MAX_VISION_IMAGE_PROMPT_LIMIT}
                                value={visionImagePromptLimit}
                                onChange={e => updateVisionImagePromptLimit(e.target.value)}
                                className="ui-input h-8 w-14 text-center"
                            />
                            <button
                                type="button"
                                className="ui-btn ui-btn-ghost h-8 w-8 p-0"
                                onClick={() => updateVisionImagePromptLimit(visionImagePromptLimit + 1)}
                                disabled={visionImagePromptLimit >= MAX_VISION_IMAGE_PROMPT_LIMIT}
                            >
                                +
                            </button>
                        </div>
                    </div>
                    <>
                        <div className="menu-item">
                            <ChatInfoIcon icon={MessageSquare} color={CONTENT_APP_ACCENTS.chat} />
                            <div className="menu-label-group">
                                <span className="menu-label">双语翻译</span>
                                <span className="menu-desc">{session.isGroup ? "外语发言自动附中文译文" : "外语回复自动附中文译文"}</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={bilingualTranslationEnabled}
                                    onChange={c => {
                                        setBilingualTranslationEnabled(c);
                                        updateSession({ bilingualTranslationEnabled: c });
                                    }}
                                />
                            </div>
                        </div>
                        {bilingualTranslationEnabled && (
                            <>
                                <div className="menu-item">
                                    <ChatInfoIcon icon={MessageSquare} color={BINDING_ACCENTS.voice} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">折叠中文译文</span>
                                        <span className="menu-desc">关闭后默认直接展开中文</span>
                                    </div>
                                    <div className="menu-right">
                                        <Toggle
                                            checked={collapseBilingualTranslation}
                                            onChange={c => {
                                                setCollapseBilingualTranslation(c);
                                                updateSession({ collapseBilingualTranslation: c });
                                            }}
                                        />
                                    </div>
                                </div>
                                <button className="menu-item" onClick={openBilingualPromptEditor}>
                                    <ChatInfoIcon icon={MessageSquare} color={BINDING_ACCENTS.memory} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">双语提示词</span>
                                    </div>
                                    <div className="menu-right">
                                        <span className="menu-desc mr-1">
                                            {bilingualTranslationPrompt === defaultBilingualPrompt && offlineBilingualTranslationPrompt === defaultOfflineBilingualPrompt ? "默认" : "已自定义"}
                                        </span>
                                        <ChevronRight size={16} />
                                    </div>
                                </button>
                            </>
                        )}
                        <div className="menu-item">
                            <ChatInfoIcon icon={Smile} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">丢弃无效表情包</span>
                                <span className="menu-desc">角色发送不存在的表情包时自动丢弃该消息</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={discardInvalidStickers}
                                    onChange={c => {
                                        setDiscardInvalidStickers(c);
                                        updateSession({ discardInvalidStickers: c });
                                    }}
                                />
                            </div>
                        </div>
                        <div className="menu-item">
                            <ChatInfoIcon icon={Sparkles} color={BINDING_ACCENTS.api} />
                            <div className="menu-label-group">
                                <span className="menu-label">线上流式生成</span>
                                <span className="menu-desc">仅当前会话：线上 AI 回复边生成边显示；关闭则整段返回</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={streamOnline}
                                    onChange={c => {
                                        setStreamOnline(c);
                                        updateSession({ streamOnline: c });
                                    }}
                                />
                            </div>
                        </div>
                        <div className="menu-item">
                            <ChatInfoIcon icon={Sparkles} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">线下流式生成</span>
                                <span className="menu-desc">仅当前会话：线下 AI 回复边生成边显示；关闭则整段返回</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={streamOffline}
                                    onChange={c => {
                                        setStreamOffline(c);
                                        updateSession({ streamOffline: c });
                                    }}
                                />
                            </div>
                        </div>
                        <div className="menu-item">
                            <ChatInfoIcon icon={Sparkles} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">线下摘要自动补提</span>
                                <span className="menu-desc">仅当前会话：模型漏写 &lt;summary&gt; 时再发一次请求让它补；关闭则只调一次 API，漏了那轮就没摘要</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={offlineSummaryRetry}
                                    onChange={c => {
                                        setOfflineSummaryRetry(c);
                                        updateSession({ offlineSummaryRetry: c });
                                    }}
                                />
                            </div>
                        </div>
                        <button className="menu-item" onClick={() => setShowScreenEffects(true)}>
                            <ChatInfoIcon icon={Sparkles} color={BINDING_ACCENTS.preset} />
                            <div className="menu-label-group">
                                <span className="menu-label">全屏特效</span>
                                <span className="menu-desc">消息包含触发词时播放表情雨/礼花，全局生效</span>
                            </div>
                            <div className="menu-right">
                                <ChevronRight size={16} />
                            </div>
                        </button>
                    </>
                </div>

                {/* Backgrounds & UI */}
                <div className="menu-group">
                    <label className="menu-item">
                        <ChatInfoIcon icon={ImageIcon} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group"><span className="menu-label">聊天背景</span></div>
                        <div className="menu-right">
                            {backgroundImage && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setBackgroundImage(""); updateSession({ backgroundImage: "" }); }}>清除</button></>}
                            <ChevronRight size={16} />
                        </div>
                        <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setBackgroundImage, "backgroundImage")} className="hidden" />
                    </label>
                    {session.isGroup ? (
                        <>
                            <div className="menu-item" style={{ cursor: "default" }}>
                                <ChatInfoIcon icon={Video} color={BINDING_ACCENTS.voice} />
                                <div className="menu-label-group"><span className="menu-label">视频通话背景</span></div>
                            </div>
                            {groupChars.map(c => c && (
                                <label key={c.id} className="menu-item" style={{ paddingLeft: 72 }}>
                                    <div className="w-[24px] h-[24px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0">
                                        {c.avatar ? <img src={c.avatar} className="w-full h-full object-cover" alt="" /> : <ChatFallbackAvatar />}
                                    </div>
                                    <div className="menu-label-group"><span className="menu-label">{c.name}</span></div>
                                    <div className="menu-right">
                                        {groupVideoBgs[c.id] && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); const updated = { ...groupVideoBgs }; delete updated[c.id]; setGroupVideoBgs(updated); updateSession({ groupVideoBackgrounds: updated }); }}>清除</button></>}
                                        <ChevronRight size={14} />
                                    </div>
                                    <input type="file" accept="image/*" onChange={e => handleGroupVideoBgUpload(e, c.id)} className="hidden" />
                                </label>
                            ))}
                            <label className="menu-item" style={{ paddingLeft: 72 }}>
                                <div className="w-[24px] h-[24px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0 flex items-center justify-center">
                                    {userIdentity?.avatarUrl ? (
                                        <img src={userIdentity.avatarUrl} className="w-full h-full object-cover" alt="" />
                                    ) : (
                                        <span className="ts-11">{(userIdentity?.name || "我")[0]}</span>
                                    )}
                                </div>
                                <div className="menu-label-group"><span className="menu-label">{userIdentity?.name || "我"}</span></div>
                                <div className="menu-right">
                                    {groupVideoBgs["self"] && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); const updated = { ...groupVideoBgs }; delete updated["self"]; setGroupVideoBgs(updated); updateSession({ groupVideoBackgrounds: updated }); }}>清除</button></>}
                                    <ChevronRight size={14} />
                                </div>
                                <input type="file" accept="image/*" onChange={e => handleGroupVideoBgUpload(e, "self")} className="hidden" />
                            </label>
                        </>
                    ) : (
                        <label className="menu-item">
                            <ChatInfoIcon icon={Video} color={BINDING_ACCENTS.voice} />
                            <div className="menu-label-group"><span className="menu-label">视频通话背景</span></div>
                            <div className="menu-right">
                                {videoBackground && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setVideoBackground(""); updateSession({ videoBackground: "" }); }}>清除</button></>}
                                <ChevronRight size={16} />
                            </div>
                            <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setVideoBackground, "videoBackground")} className="hidden" />
                        </label>
                    )}
                    <label className="menu-item">
                        <ChatInfoIcon icon={Mic} color={BINDING_ACCENTS.voice} />
                        <div className="menu-label-group"><span className="menu-label">语音通话背景</span></div>
                        <div className="menu-right">
                            {voiceBackground && <><span className="menu-desc mr-1">已设置</span><button className="menu-desc mr-1 text-[var(--c-danger)]" onClick={e => { e.preventDefault(); setVoiceBackground(""); updateSession({ voiceBackground: "" }); }}>清除</button></>}
                            <ChevronRight size={16} />
                        </div>
                        <input type="file" accept="image/*" onChange={e => handleImageUpload(e, setVoiceBackground, "voiceBackground")} className="hidden" />
                    </label>
                </div>

                {/* Advanced */}
                <div className="menu-group">
                    <KeyboardAutoSendDebounceItem sessionId={session.id} />
                    <button className="menu-item" onClick={() => setEditingCSS(true)}>
                        <ChatInfoIcon icon={Code} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group"><span className="menu-label">自定义 CSS 样式</span></div>
                        <div className="menu-right">
                            {customCSS && <span className="menu-desc mr-1">已设置</span>}
                            <ChevronRight size={16} />
                        </div>
                    </button>
                </div>

                {/* Destructive Actions */}
                <div className="menu-group">
                    {!session.isGroup && (
                    <button className="menu-item" onClick={() => setShowConfirmDelete(true)}>
                        <ChatInfoIcon icon={UserMinus} color="var(--c-danger)" />
                        <div className="menu-label-group"><span className="menu-label menu-label-danger">删除好友</span></div>
                    </button>
                    )}
                    <button className="menu-item" onClick={() => setShowConfirmClearTools(true)}>
                        <ChatInfoIcon icon={Code} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清理原生tool调用历史——防报错</span>
                            <span className="menu-desc">切换到文本协议 API 前使用</span>
                        </div>
                    </button>
                    <button className="menu-item" onClick={() => setShowConfirmClear(true)}>
                        <ChatInfoIcon icon={Trash2} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清空线上聊天记录</span>
                            <span className="menu-desc">不影响线下模式记录</span>
                        </div>
                    </button>
                    <button
                        className="menu-item"
                        disabled={offlineHistoryBusy}
                        onClick={() => {
                            if (!offlineHistoryBusy) setShowConfirmClearOffline(true);
                        }}
                        style={offlineHistoryBusy ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    >
                        <ChatInfoIcon icon={Trash2} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清空线下聊天记录</span>
                            <span className="menu-desc">
                                {offlineHistoryBusy ? "线下回复生成中，完成后再清空" : "同步移除该会话的线下短期记忆事件"}
                            </span>
                        </div>
                    </button>
                    <button
                        className="menu-item"
                        disabled={offlineHistoryBusy}
                        onClick={() => {
                            if (!offlineHistoryBusy) setShowConfirmDeleteSession(true);
                        }}
                        style={offlineHistoryBusy ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    >
                        <ChatInfoIcon icon={Trash2} color="var(--c-danger)" />
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">删除会话</span>
                            <span className="menu-desc">
                                {offlineHistoryBusy
                                    ? "线下回复生成中，完成后再删除"
                                    : session.isGroup
                                        ? "解散并移除该群聊，线上线下记录一并删除"
                                        : "移除该会话及线上线下记录，好友保留"}
                            </span>
                        </div>
                    </button>
                </div>

            </div>

            {/* Modal: Group member actions */}
            {memberActionKey && (
                <div className="modal-overlay" onClick={() => setMemberActionKey(null)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">
                            {getGroupMemberDisplayName(memberActionKey, userName)}
                            {roleLabel(memberActionKey) ? `（${roleLabel(memberActionKey)}）` : ""}
                        </span>
                        <div className="flex flex-col gap-2 w-full">
                            {memberActionsFor(memberActionKey).map(item => (
                                <button
                                    key={item.action}
                                    className={`ui-btn flex-1 ${item.danger ? "ui-btn-danger" : "ui-btn-ghost"}`}
                                    onClick={() => {
                                        if (item.action === "mute") {
                                            setMutePickerKey(memberActionKey);
                                            setMemberActionKey(null);
                                        } else {
                                            performAdminAction(item.action, memberActionKey);
                                        }
                                    }}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setMemberActionKey(null)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Mute duration picker */}
            {mutePickerKey && (
                <div className="modal-overlay" onClick={() => setMutePickerKey(null)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">禁言 {getGroupMemberDisplayName(mutePickerKey, userName)}</span>
                        <div className="flex flex-col gap-2 w-full">
                            {MUTE_DURATION_OPTIONS.map(minutes => (
                                <button
                                    key={minutes}
                                    className="ui-btn ui-btn-ghost flex-1"
                                    onClick={() => performAdminAction("mute", mutePickerKey, minutes)}
                                >
                                    {formatMuteDurationLabel(minutes)}
                                </button>
                            ))}
                        </div>
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setMutePickerKey(null)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Invite picker */}
            {showInvitePicker && (
                <div className="modal-overlay" onClick={() => setShowInvitePicker(false)}>
                    <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                        <span className="modal-header-title">拉人进群</span>
                        {inviteCandidates.length === 0 ? (
                            <span className="menu-desc">没有可以拉进群的联系人</span>
                        ) : (
                            <div className="chat-contact-list">
                                {inviteCandidates.map(c => (
                                    <div
                                        key={c.id}
                                        className="chat-contact-item"
                                        onClick={() => performAdminAction("invite", c.id)}
                                    >
                                        <div className="chat-contact-avatar">
                                            {c.avatar ? <img src={c.avatar} alt="" /> : <ChatFallbackAvatar />}
                                        </div>
                                        <span className="chat-contact-name">{c.name}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        <button className="ui-btn ui-btn-ghost w-full" onClick={() => setShowInvitePicker(false)}>取消</button>
                    </div>
                </div>
            )}

            {/* Modal: Alias / Group Name */}
            {editingAlias && (
                <div className="modal-overlay">
                    <div className="modal-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">{session.isGroup ? "修改群名" : "修改备注"}</div>
                        <Input
                            type="text"
                            value={session.isGroup ? groupName : alias}
                            onChange={e => session.isGroup ? setGroupName(e.target.value) : setAlias(e.target.value)}
                            placeholder={session.isGroup ? "输入群名" : (character?.name || "输入备注名")}
                        />
                        <div className="flex gap-3 w-full">
                            <button onClick={() => setEditingAlias(false)} className="ui-btn ui-btn-ghost flex-1">取消</button>
                            <button onClick={() => {
                                if (session.isGroup) {
                                    updateSession({ groupName });
                                } else {
                                    updateSession({ alias });
                                }
                                setEditingAlias(false);
                            }} className="ui-btn ui-btn-success flex-1">保存</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal: Bilingual Prompt */}
            {editingBilingualPrompt && (
                <div className="modal-overlay">
                    <div className="modal-dialog chat-bilingual-prompt-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">双语提示词</div>
                        <div className="chat-bilingual-prompt-stack">
                            <div className="chat-bilingual-prompt-section">
                                <div className="chat-bilingual-prompt-head">
                                    <div>
                                        <div className="chat-bilingual-prompt-title">线上聊天提示词</div>
                                        <div className="chat-bilingual-prompt-desc">即时通讯、富媒体和聊天气泡输出使用。</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="chat-bilingual-prompt-reset"
                                        onClick={() => setBilingualPromptDraft(defaultBilingualPrompt)}
                                    >
                                        默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input chat-bilingual-prompt-textarea chat-bilingual-prompt-textarea--split"
                                    value={bilingualPromptDraft}
                                    onChange={e => setBilingualPromptDraft(e.target.value)}
                                />
                            </div>
                            <div className="chat-bilingual-prompt-section">
                                <div className="chat-bilingual-prompt-head">
                                    <div>
                                        <div className="chat-bilingual-prompt-title">线下模式提示词</div>
                                        <div className="chat-bilingual-prompt-desc">只约束线下连续叙事中的角色对白。</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="chat-bilingual-prompt-reset"
                                        onClick={() => setOfflineBilingualPromptDraft(defaultOfflineBilingualPrompt)}
                                    >
                                        默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input chat-bilingual-prompt-textarea chat-bilingual-prompt-textarea--split"
                                    value={offlineBilingualPromptDraft}
                                    onChange={e => setOfflineBilingualPromptDraft(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className="flex gap-3 w-full">
                            <button
                                onClick={() => {
                                    setBilingualPromptDraft(defaultBilingualPrompt);
                                    setOfflineBilingualPromptDraft(defaultOfflineBilingualPrompt);
                                }}
                                className="ui-btn ui-btn-outline flex-1"
                            >
                                全部默认
                            </button>
                            <button onClick={() => setEditingBilingualPrompt(false)} className="ui-btn ui-btn-ghost flex-1">
                                取消
                            </button>
                            <button onClick={saveBilingualPromptDraft} className="ui-btn ui-btn-success flex-1">
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal: Screen Effects */}
            {showScreenEffects && <ScreenEffectSettingsModal onClose={() => setShowScreenEffects(false)} />}

            {/* Modal: Confirm Clear History */}
            {showConfirmClear && (
                <ConfirmDialog
                    title="确定要清空线上聊天记录吗？"
                    message="只清空普通聊天记录，不影响线下模式记录。清空后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清空"
                    cancelLabel="取消"
                    onConfirm={handleClearHistory}
                    onCancel={() => setShowConfirmClear(false)}
                />
            )}

            {/* Modal: Confirm Clear Offline History */}
            {showConfirmClearOffline && (
                <ConfirmDialog
                    title="确定要清空线下聊天记录吗？"
                    message="会同步移除该会话的线下短期记忆事件，不影响线上聊天与已保存的长期记忆。清空后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清空"
                    cancelLabel="取消"
                    onConfirm={handleClearOfflineHistory}
                    onCancel={() => setShowConfirmClearOffline(false)}
                />
            )}

            {/* Modal: Confirm Clear Tool History */}
            {showConfirmClearTools && (
                <ConfirmDialog
                    title="清理工具调用历史？"
                    message="将移除本会话中的工具调用记录、工具结果记录，并清除助手消息里的原生工具调用元数据。普通聊天内容不会删除。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清理"
                    cancelLabel="取消"
                    onConfirm={handleClearToolHistory}
                    onCancel={() => setShowConfirmClearTools(false)}
                />
            )}

            {/* Modal: Confirm Delete Session */}
            {showConfirmDeleteSession && (
                <ConfirmDialog
                    title="确定要删除该会话吗？"
                    message={session.isGroup
                        ? "群聊将从列表移除，线上与线下聊天记录一并删除，无法恢复。是否继续？"
                        : "会话将从列表移除，线上与线下聊天记录一并删除，好友不受影响，重新发起聊天会从空白开始。是否继续？"}
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={handleDeleteSession}
                    onCancel={() => setShowConfirmDeleteSession(false)}
                />
            )}

            {/* Modal: Confirm Delete Friend */}
            {showConfirmDelete && (
                <ConfirmDialog
                    title="确定要删除该好友吗？"
                    message="删除后对方将从联系人列表消失，聊天和朋友圈将被隐藏。重新添加好友后可恢复。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeChatContact(session.contactId);
                        // Fire-and-forget: AI reacts to being deleted
                        triggerDeleteFriendReaction(session.contactId).catch(() => {});
                        setShowConfirmDelete(false);
                        onDeleteFriend?.();
                    }}
                    onCancel={() => setShowConfirmDelete(false)}
                />
            )}

            {/* Sub-page: Custom CSS */}
            {editingCSS && (
                <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "#ffffff" }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--c-page-body-bg)" }}>
                    <PageShell title="自定义 CSS" onBack={() => setEditingCSS(false)}>
                        <div className="theme-section-page">
                            <p className="ts-13 text-[var(--c-text)] mb-3 leading-relaxed">
                                支持 :root 变量和选择器，仅作用于本会话。
                            </p>
                            <textarea
                                className="ui-textarea font-mono ts-13 leading-relaxed flex-1"
                                style={{ minHeight: 280, resize: "none", scrollbarWidth: "none" }}
                                placeholder={`:root {\n  --c-bubble-self: #95ec69;\n}\n\n.chat-bubble-role-user {\n  border-radius: 6px;\n}\n\n.chat-html-inline-frame {\n  max-height: min(36vh, 340px);\n}`}
                                value={customCSS}
                                onChange={e => setCustomCSS(e.target.value)}
                                spellCheck={false}
                            />
                            <div className="flex gap-2 mt-3 items-center">
                                <CSSSchemeBar target="chat_session" currentCSS={customCSS} onLoad={setCustomCSS} />
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setCustomCSS(CHAT_SESSION_CSS_EXAMPLE)}>示例</button>
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setCustomCSS("")}>清除</button>
                                <button type="button" className="ui-btn ui-btn-soft-action flex-1" onClick={() => { updateSession({ customCSS }); window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: session.id, css: customCSS } })); setEditingCSS(false); }}>应用</button>
                            </div>
                        </div>
                    </PageShell>
                </div>
                </div>
            )}

            {/* Sub-page: TA 的电脑 */}
            {showComputer && (
                <CharacterComputerPage
                    characterId={session.contactId}
                    characterName={characterName}
                    onClose={() => setShowComputer(false)}
                />
            )}

            {/* Sub-page: Search History */}
            {showSearch && (
                <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "#ffffff" }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--c-page-body-bg)" }}>
                    <PageShell title="查找聊天记录" onBack={closeSearchPanel}>
                        <div className="px-4 pt-2 pb-3 flex items-center gap-2">
                            <input
                                autoFocus
                                type="text"
                                placeholder="搜索聊天记录..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        runSearch();
                                    }
                                }}
                                className="ui-input flex-1 min-w-0"
                            />
                            <button
                                type="button"
                                aria-label="搜索聊天记录"
                                title="搜索"
                                onClick={runSearch}
                                disabled={isSearching}
                                className="h-10 w-10 shrink-0 grid place-items-center border-0 bg-transparent text-[var(--c-icon)] disabled:opacity-40"
                            >
                                <Search size={20} strokeWidth={2.1} />
                            </button>
                        </div>
                        <div className="flex flex-col gap-4 px-4 pb-4">
                            {!searchMode && searchHistoryMessages.length === 0 && (
                                <div className="ui-empty">
                                    <span className="menu-desc">暂无聊天记录</span>
                                </div>
                            )}
                            {searchMode && isSearching && (
                                <div className="ui-empty">
                                    <span className="menu-desc">正在搜索...</span>
                                </div>
                            )}
                            {searchMode && !isSearching && searchResults.length === 0 && (
                                <div className="ui-empty">
                                    <span className="menu-desc">无相关聊天记录</span>
                                </div>
                            )}
                            {displayedSearchMessages.map(renderSearchMessage)}
                            {!searchMode && searchHasMore && (
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-ghost ui-btn-bordered-ghost w-full"
                                    onClick={loadMoreSearchHistory}
                                >
                                    查看更多消息
                                </button>
                            )}
                            {searchMode && !isSearching && searchResults.length >= SEARCH_RESULT_LIMIT && (
                                <div className="ui-empty py-2">
                                    <span className="menu-desc">仅显示最近 {SEARCH_RESULT_LIMIT} 条结果</span>
                                </div>
                            )}
                        </div>
                    </PageShell>
                </div>
                </div>
            )}
            {showStatusRegionDialog && (
                <div className="fixed inset-0 z-[10030] flex items-end justify-center bg-black/45 sm:items-center" role="dialog" aria-modal="true" aria-label="自定义状态栏">
                    <div className="flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-[var(--c-page-body-bg)] text-[var(--c-text)] shadow-2xl sm:rounded-2xl">
                        <div className="flex items-center justify-between px-5 pb-2 pt-4">
                            <div className="font-bold text-[var(--c-text-title)]">自定义状态栏</div>
                            <div className="flex items-center gap-1.5">
                                <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="状态栏方案" onClick={() => { setStatusSchemes(getSchemes(STATUS_SCHEME_TARGET)); setStatusSchemeDeleteId(null); setShowStatusSchemes(v => !v); }}><FolderOpen size={16} /></button>
                                <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="导入状态栏" onClick={() => statusImportInputRef.current?.click()}><Upload size={16} /></button>
                                <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="导出状态栏" onClick={exportStatusRegion}><Download size={16} /></button>
                                <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="关闭" onClick={() => setShowStatusRegionDialog(false)}><X size={18} /></button>
                            </div>
                            <input ref={statusImportInputRef} type="file" accept="application/json,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importStatusRegion(f); e.target.value = ""; }} />
                        </div>
                        <div className="flex-1 overflow-y-auto px-4 pb-4">
                            {showStatusSchemes && (
                                <div className="mb-3 rounded-xl p-3" style={{ background: "color-mix(in srgb, var(--c-text) 6%, transparent)" }}>
                                    <div className="ts-12 font-semibold text-[var(--c-text-title)]">方案</div>
                                    {statusSchemes.length === 0 && <div className="mt-1 ts-11 opacity-45">还没有保存的方案</div>}
                                    {statusSchemes.map(scheme => (
                                        <div key={scheme.id} className="mt-1.5 flex items-center gap-2">
                                            <button type="button" className="flex-1 truncate text-left ts-12" onClick={() => { applyStatusScheme(scheme); setShowStatusSchemes(false); }}>{scheme.name}</button>
                                            {statusSchemeDeleteId === scheme.id ? (
                                                <button type="button" className="ts-11 text-[var(--c-danger)]" onClick={() => { deleteScheme(scheme.id); setStatusSchemes(getSchemes(STATUS_SCHEME_TARGET)); setStatusSchemeDeleteId(null); }}>确认删除</button>
                                            ) : (
                                                <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label={`删除方案 ${scheme.name}`} onClick={() => setStatusSchemeDeleteId(scheme.id)}><Trash2 size={13} /></button>
                                            )}
                                        </div>
                                    ))}
                                    <div className="mt-2 flex items-center gap-2">
                                        <input
                                            value={statusSchemeName}
                                            onChange={e => setStatusSchemeName(e.target.value)}
                                            placeholder="方案名称"
                                            className="ui-input flex-1"
                                            style={{ padding: "6px 10px", fontSize: 12, border: "none", borderRadius: 10, background: "var(--c-input)" }}
                                        />
                                        <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="保存当前为方案" onClick={() => {
                                            const name = statusSchemeName.trim();
                                            if (!name || !draftContract.trim() || !draftRender.trim()) return;
                                            saveScheme(STATUS_SCHEME_TARGET, name, JSON.stringify({ contract: draftContract, renderHtml: draftRender, previewRaw: statusPreviewRaw }));
                                            setStatusSchemes(getSchemes(STATUS_SCHEME_TARGET));
                                            setStatusSchemeName("");
                                        }}><Save size={15} /></button>
                                    </div>
                                </div>
                            )}
                            <div className="flex items-baseline justify-between px-1">
                                <span className="ts-12 font-semibold text-[var(--c-text-title)]">输出契约</span>
                                <span className="ts-10 opacity-40">整节写进提示词</span>
                            </div>
                            <textarea
                                value={draftContract}
                                onChange={e => setDraftContract(e.target.value)}
                                className="ui-input mt-1 w-full font-mono"
                                style={{ minHeight: 110, fontSize: 12, lineHeight: 1.6, border: "none", borderRadius: 12, background: "color-mix(in srgb, var(--c-text) 6%, transparent)" }}
                                spellCheck={false}
                            />
                            <div className="mt-3 flex items-baseline justify-between px-1">
                                <span className="ts-12 font-semibold text-[var(--c-text-title)]">输出渲染</span>
                                <span className="ts-10 opacity-40">HTML · 沙盒运行</span>
                            </div>
                            <textarea
                                value={draftRender}
                                onChange={e => setDraftRender(e.target.value)}
                                className="ui-input mt-1 w-full font-mono"
                                style={{ minHeight: 180, fontSize: 12, lineHeight: 1.6, border: "none", borderRadius: 12, background: "color-mix(in srgb, var(--c-text) 6%, transparent)" }}
                                spellCheck={false}
                            />
                            <div className="mt-3 flex items-center justify-between px-1">
                                <div className="flex items-baseline gap-2">
                                    <span className="ts-12 font-semibold text-[var(--c-text-title)]">预览</span>
                                    <span className="ts-10 opacity-40">示例数据可改</span>
                                </div>
                                <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="运行预览" onClick={() => setPreviewHtml(draftRender)}><Play size={15} /></button>
                            </div>
                            <textarea
                                value={statusPreviewRaw}
                                onChange={e => setStatusPreviewRaw(e.target.value)}
                                className="ui-input mt-1 w-full font-mono"
                                style={{ minHeight: 56, fontSize: 11, lineHeight: 1.5, border: "none", borderRadius: 12, background: "color-mix(in srgb, var(--c-text) 6%, transparent)" }}
                                spellCheck={false}
                            />
                            {previewHtml.trim() && (
                                <div className="mt-2 rounded-xl p-2" style={{ background: "color-mix(in srgb, var(--c-text) 6%, transparent)" }}>
                                    <CustomStatusFrame key={previewHtml + statusPreviewRaw} html={previewHtml} raw={statusPreviewRaw} />
                                </div>
                            )}
                        </div>
                        <div className="flex gap-2 px-5 pb-4 pt-1">
                            <button
                                type="button"
                                className="ui-btn flex-1"
                                onClick={() => setShowStatusRegionDialog(false)}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className="ui-btn ui-btn-primary flex-1"
                                onClick={() => {
                                    const contract = draftContract.trim();
                                    const renderHtml = draftRender.trim();
                                    saveStatusRegion({ mode: contract && renderHtml ? "custom" : "off", contract, renderHtml, previewRaw: statusPreviewRaw });
                                    setShowStatusRegionDialog(false);
                                }}
                            >
                                保存并启用
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </PageShell>
    );
}
