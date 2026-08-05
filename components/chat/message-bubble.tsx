"use client";

import { type ReactNode, useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { findCustomStickerByName, resolveCustomStickerUrl } from "@/lib/custom-sticker-storage";
import { isMediaStoreRef, loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import { ChatMessage, createOrGetSession, updateMessageMediaStatus, updateMessageMediaData, updateMessageMediaUrl } from "@/lib/chat-storage";
import { resolveContactCard } from "@/lib/contact-card";
import { loadCharacters } from "@/lib/character-storage";
import { CHAT_OPEN_SESSION_EVENT, dispatchOpenAddContact } from "@/lib/chat-notification-events";
import { ContactCardGenerateFlow } from "@/components/chat/contact-card-generate-flow";
import { findStickerByName } from "@/lib/sticker-data";
import { splitBilingualText } from "@/lib/bilingual-text";
import { isInvisibleOrWhitespaceOnly } from "@/lib/rich-message-parser";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { createPortal } from "react-dom";
import { Blocks, Maximize2, ReceiptText, RefreshCw } from "lucide-react";
import { retryChatGeneratedImage } from "@/lib/generated-image-retry";
import { ScanPayCard } from "@/components/chat/scan-pay-card";
import { payWithWalletBalance } from "@/lib/wallet-storage";
import { formatShoppingPaymentRequestHistory } from "@/lib/shopping-payment-request";
import { toCustomAppIconId } from "@/lib/custom-app-types";
import { ChatPluginSlot } from "@/components/chat/chat-plugin-slot";
import { CHAT_PLUGIN_SLOTS_CHANGED_EVENT, getChatPluginRuntime } from "@/lib/chat-plugin-runtime";

interface MessageBubbleProps {
    msg: ChatMessage;
    onUpdate?: (updated: ChatMessage) => void;
    charName?: string;
    userName?: string;
    onSystemMessage?: (text: string) => void;
    groupSize?: number;
    onShowDetail?: (msg: ChatMessage) => void;
    characterId?: string;
    onMusicPlay?: (title: string, artist?: string) => void;
    onActionSelect?: (text: string) => void;
    displayContent?: string;
    defaultTranslationExpanded?: boolean;
}

/** 聊天插件自定义消息气泡：把裸 DOM 容器交给注册了该 kind 的插件渲染 */
function PluginKindBubble({ msg, kind }: { msg: ChatMessage; kind: string }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [slotVersion, setSlotVersion] = useState(0);

    useEffect(() => {
        const bump = () => setSlotVersion(v => v + 1);
        window.addEventListener(CHAT_PLUGIN_SLOTS_CHANGED_EVENT, bump);
        return () => window.removeEventListener(CHAT_PLUGIN_SLOTS_CHANGED_EVENT, bump);
    }, []);

    const registration = getChatPluginRuntime().getMessageKindRenderer(kind);

    useEffect(() => {
        const el = containerRef.current;
        if (!el || !registration) return;
        let cleanup: (() => void) | void;
        try {
            cleanup = registration.renderer(el, msg);
        } catch { /* 渲染失败按占位处理 */ }
        return () => {
            try { if (typeof cleanup === "function") cleanup(); } catch { /* ignore */ }
            el.replaceChildren();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [registration, slotVersion, msg.id, msg.content, msg.mediaData]);

    if (!registration) {
        return (
            <div className="bubble bubble-text opacity-60">
                <span className="ts-12">[插件消息：{kind}]（对应插件未启用）</span>
            </div>
        );
    }
    return <div ref={containerRef} data-chat-plugin-kind={kind} />;
}

/**
 * Renders a message bubble based on its mediaType.
 * Falls back to ReactMarkdown for plain text messages.
 */
export const MessageBubble = memo(function MessageBubble({ msg, onUpdate, charName, userName, onSystemMessage, groupSize, onShowDetail, characterId, onMusicPlay, onActionSelect, displayContent, defaultTranslationExpanded = false }: MessageBubbleProps) {
    switch (msg.mediaType) {
        case "red_packet":
            return <RedPacketBubble msg={msg} charName={charName} userName={userName} groupSize={groupSize} onShowDetail={onShowDetail} />;
        case "transfer":
            return <TransferBubble msg={msg} charName={charName} userName={userName} onShowDetail={onShowDetail} />;
        case "gift":
            return <GiftBubble msg={msg} />;
        case "contact_card":
            return <ContactCardBubble msg={msg} characterId={characterId} />;
        case "payment_request":
            return <PaymentRequestBubble msg={msg} charName={charName} userName={userName} onShowDetail={onShowDetail} />;
        case "app_card":
            return <AppCardBubble msg={msg} characterId={characterId} characterName={msg.senderName || charName} />;
        case "image":
            return <ImageBubble msg={msg} onUpdate={onUpdate} characterId={characterId} />;
        case "location":
            return <LocationBubble msg={msg} />;
        case "poke":
            return <PokeBubble msg={msg} charName={charName} userName={userName} />;
        case "sticker":
            return <StickerBubble msg={msg} characterId={characterId} />;
        case "dice":
            return <DiceBubble msg={msg} />;
        case "quote":
            return <QuoteBubble msg={msg} displayContent={displayContent} defaultTranslationExpanded={defaultTranslationExpanded} />;
        case "music_share":
            return <MusicShareBubble msg={msg} onPlay={onMusicPlay} />;
        case "media_file":
            return <MediaFileBubble msg={msg} onUpdate={onUpdate} characterId={characterId} />;
        case "xiaohongshu_note_share":
            return <XiaohongshuShareBubble msg={msg} />;
        case "audio":
            return <VoiceMessageBubble msg={msg} characterId={characterId} onUpdate={onUpdate} defaultTranslationExpanded={defaultTranslationExpanded} />;
        default: {
            // 聊天插件自定义消息类型：mediaType = "plugin:<kind>"，由注册插件渲染
            if (msg.mediaType?.startsWith("plugin:")) {
                return <PluginKindBubble msg={msg} kind={msg.mediaType.slice("plugin:".length)} />;
            }
            const textBubble = <TextBubble content={displayContent ?? msg.content} onActionSelect={onActionSelect} defaultTranslationExpanded={defaultTranslationExpanded} />;
            return (
                <>
                    {textBubble}
                    <ChatPluginSlot name="message.footer" slotProps={{ sessionId: msg.sessionId, message: msg }} className="chat-plugin-message-footer" />
                </>
            );
        }
    }
}, (prev, next) => {
    // Skip function props (onUpdate, onSystemMessage, onShowDetail) — they're inline and always new
    if (prev.msg !== next.msg) {
        if (prev.msg.id !== next.msg.id) return false;
        if (prev.msg.content !== next.msg.content) return false;
        if (prev.msg.mediaType !== next.msg.mediaType) return false;
        if (prev.msg.isRetracted !== next.msg.isRetracted) return false;
        if (prev.msg.isTyping !== next.msg.isTyping) return false;
        if (prev.msg.mediaData?.status !== next.msg.mediaData?.status) return false;
        if (prev.msg.mediaData?.label !== next.msg.mediaData?.label) return false;
        if (prev.msg.mediaData?.claimedBy?.length !== next.msg.mediaData?.claimedBy?.length) return false;
        if (prev.msg.mediaData?.appName !== next.msg.mediaData?.appName) return false;
        if (prev.msg.mediaData?.appCardTitle !== next.msg.mediaData?.appCardTitle) return false;
        if (prev.msg.mediaData?.appCardBody !== next.msg.mediaData?.appCardBody) return false;
        if (prev.msg.mediaData?.appCardLayout !== next.msg.mediaData?.appCardLayout) return false;
        if (prev.msg.mediaData?.imageGenerationPrompt !== next.msg.mediaData?.imageGenerationPrompt) return false;
        if (prev.msg.mediaData?.imageGenerationStatus !== next.msg.mediaData?.imageGenerationStatus) return false;
        if (prev.msg.mediaData?.imageGenerationError !== next.msg.mediaData?.imageGenerationError) return false;
        if (prev.msg.mediaUrl !== next.msg.mediaUrl) return false;
    }
    if (prev.charName !== next.charName) return false;
    if (prev.userName !== next.userName) return false;
    if (prev.groupSize !== next.groupSize) return false;
    if (prev.characterId !== next.characterId) return false;
    if (prev.displayContent !== next.displayContent) return false;
    if (prev.defaultTranslationExpanded !== next.defaultTranslationExpanded) return false;
    return true;
});

// ── Text Bubble (default) ─────────────────────────────

function extractStyles(text: string): { styles: string; body: string } {
    const styleBlocks: string[] = [];
    const body = text.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
        styleBlocks.push(css);
        return "";
    });
    return { styles: styleBlocks.join("\n"), body };
}

/** Split text into markdown segments and ```html blocks */
function splitChatContent(text: string): { type: "md" | "html"; content: string }[] {
    const segments: { type: "md" | "html"; content: string }[] = [];
    const rx = /```html\s*\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rx.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index).trim();
        if (before) segments.push({ type: "md", content: before });
        const html = match[1].trim();
        if (html) segments.push({ type: "html", content: html });
        lastIndex = match.index + match[0].length;
    }
    const remaining = text.slice(lastIndex).trim();
    if (remaining) segments.push({ type: "md", content: remaining });
    return segments;
}

export function normalizeTextBubbleContent(content: string): string {
    const cleaned = content
        .replace(/\[音乐(?:分享)?(?:[：:][^\]]*)?\]/g, "")
        .replace(/\[[^\]]+拍了拍[^\]]+\]/g, "")
        .replace(/\[[^\]]*?(?:获取指令|获取工具)[:：][^\]]*\]/g, "")
        .replace(/\[[^\]]*?(?:执行动作|工具调用)[:：][^\]]*?[（(][\s\S]*?[)）]\]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    // 只剩零宽字符/BOM 等不可见内容时按空处理，否则会渲染出一个空气泡
    //（也让历史脏数据在显示层直接被隐藏）
    return isInvisibleOrWhitespaceOnly(cleaned) ? "" : cleaned;
}

export function isStandaloneHtmlPreviewContent(content: string): boolean {
    const cleaned = normalizeTextBubbleContent(content);
    if (!cleaned) return false;

    const strippedCodeBlocks = cleaned.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
    if (/^\s*</.test(strippedCodeBlocks)
        && /<script\b[\s\S]*?<\/script>/i.test(strippedCodeBlocks)
        && /<style\b[\s\S]*?<\/style>/i.test(strippedCodeBlocks)) {
        return true;
    }

    const segments = splitChatContent(cleaned);
    return segments.length === 1 && segments[0].type === "html";
}

/** Full-screen iframe modal for interactive HTML content */
function HtmlFullscreenModal({ html, onClose, onActionSelect }: { html: string; onClose: () => void; onActionSelect?: (text: string) => void }) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

    useEffect(() => {
        setPortalTarget(document.querySelector<HTMLElement>(".phone-shell"));
    }, []);

    const srcDoc = useMemo(() => {
        // Inject: action communication only — let AI's HTML render as-is
        const inject = `<script>(function(){
            document.addEventListener("click",function(e){
                var t=e.target.closest("[data-action]");
                if(t){e.preventDefault();window.parent.postMessage({type:"_chat_action",text:t.getAttribute("data-action")},"*");return}
                var target=e.target;
                var interactive=target.closest("a,button,input,textarea,select,summary,label,[role='button']");
                var rect=target.getBoundingClientRect&&target.getBoundingClientRect();
                var backdrop=rect&&rect.width>=window.innerWidth*0.9&&rect.height>=window.innerHeight*0.9;
                if(!interactive&&(target===document.body||target===document.documentElement||backdrop)){
                    window.parent.postMessage({type:"_chat_close"},"*");
                }
            },true);
        })();<\/script>`;
        let h = html;
        if (h.includes("</body>")) h = h.replace("</body>", inject + "</body>");
        else h = h + inject;
        return h;
    }, [html]);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            if (!e.data || typeof e.data !== "object") return;
            if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
            if (e.data.type === "_chat_action" && typeof e.data.text === "string") {
                onActionSelect?.(e.data.text);
            }
            if (e.data.type === "_chat_close") {
                onClose();
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [onActionSelect, onClose]);

    if (!portalTarget) return null;

    return createPortal(
        <div className="chat-html-overlay" onClick={onClose}>
            <iframe
                ref={iframeRef}
                srcDoc={srcDoc}
                onClick={(e) => e.stopPropagation()}
            />
        </div>,
        portalTarget
    );
}

function buildChatHtmlDocument(html: string, inline = false): string {
    const action = `document.addEventListener("click",function(e){
                var t=e.target.closest("[data-action]");
                if(t){e.preventDefault();window.parent.postMessage({type:"_chat_action",text:t.getAttribute("data-action")},"*")}
            },true);`;
    const resize = inline ? `
            var n=0;
            var send=function(){
                if(n>=12)return;
                n++;
                var b=document.body;
                var d=document.documentElement;
                var h=Math.max(b?b.scrollHeight:0,d?d.scrollHeight:0,80);
                window.parent.postMessage({type:"_chat_inline_html_resize",h:h},"*");
            };
            window.addEventListener("load",send);
            if(window.ResizeObserver&&document.body){new ResizeObserver(function(){n=0;send();}).observe(document.body);}
            document.addEventListener("toggle",function(){n=0;setTimeout(send,50);},true);
            setTimeout(send,300);
            setTimeout(send,1200);
            setTimeout(send,2500);` : "";
    const inject = `<script>(function(){${action}${resize}})();<\/script>`;
    if (html.includes("</body>")) return html.replace("</body>", inject + "</body>");
    return html + inject;
}

type ChatHtmlFrameVariant = "default" | "offline";

function ChatHtmlInlineFrame({
    html,
    onActionSelect,
    variant = "default",
}: {
    html: string;
    onActionSelect?: (text: string) => void;
    variant?: ChatHtmlFrameVariant;
}) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(240);
    const [expanded, setExpanded] = useState(false);
    const allowFullscreen = variant !== "offline";
    const srcDoc = useMemo(() => buildChatHtmlDocument(html, true), [html]);

    useEffect(() => {
        setHeight(240);
    }, [srcDoc]);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            if (!e.data || typeof e.data !== "object") return;
            if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
            if (e.data.type === "_chat_inline_html_resize" && typeof e.data.h === "number") {
                setHeight(Math.max(80, Math.ceil(e.data.h)));
            }
            if (e.data.type === "_chat_action" && typeof e.data.text === "string") {
                onActionSelect?.(e.data.text);
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [onActionSelect]);

    return (
        <div className="chat-html-inline" data-chat-html-inline="" data-variant={variant}>
            <iframe
                ref={iframeRef}
                className="chat-html-inline-frame"
                srcDoc={srcDoc}
                title="AI 生成互动内容"
                style={{ height }}
            />
            {allowFullscreen ? (
                <button
                    type="button"
                    className="chat-html-inline-expand"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(true);
                    }}
                    aria-label="全屏查看"
                    title="全屏查看"
                >
                    <Maximize2 size={14} aria-hidden="true" />
                </button>
            ) : null}
            {allowFullscreen && expanded && (
                <HtmlFullscreenModal
                    html={html}
                    onClose={() => setExpanded(false)}
                    onActionSelect={onActionSelect}
                />
            )}
        </div>
    );
}

/** Inline renderer for ```html blocks, with a fullscreen escape hatch. */
function HtmlPreviewCard({
    html,
    onActionSelect,
    htmlFrameVariant,
}: {
    html: string;
    onActionSelect?: (text: string) => void;
    htmlFrameVariant?: ChatHtmlFrameVariant;
}) {
    return <ChatHtmlInlineFrame html={html} onActionSelect={onActionSelect} variant={htmlFrameVariant} />;
}

function mapMarkdownOutsideCode(text: string, mapper: (segment: string) => string): string {
    const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
    return parts.map(part => part.startsWith("`") ? part : mapper(part)).join("");
}

/**
 * 浏览器无法直接打开的支付类 scheme（微信 Native 扫码付、支付宝等）。
 * 命中后在气泡里渲染 ScanPayCard（二维码 + 在钱包中打开 + 复制），并从正文里剥掉这串。
 */
const PAY_SCHEME_RE = /(?:weixin|wechat|alipays|alipay):\/\/[^\s<>"'`)\]，。！？、；]+/gi;

function extractPaySchemeUrls(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of text.matchAll(PAY_SCHEME_RE)) {
        if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
    }
    return out;
}

function stripPaySchemeUrls(text: string): string {
    // 连同包裹的反引号（行内代码）一起剥掉，避免残留 ``
    return text
        .replace(/`*\s*(?:weixin|wechat|alipays|alipay):\/\/[^\s<>"'`)\]，。！？、；]+\s*`*/gi, "")
        .replace(/[ \t]{2,}/g, " ");
}

/**
 * 台词包裹：渲染前把引号内的对话包进 <q> 标签，
 * 让自定义 CSS 可以用 `q { ... }` 单独给台词上样式。
 * - 只处理代码块/行内代码之外的文本
 * - 跳过 HTML 标签内部，避免命中属性里的引号
 * - 支持中文弯引号 “…”、直角引号 「…」、英文直引号 "…"（同一行内成对才包）
 * - 默认无视觉变化（chat.css 已关掉 q 的浏览器默认引号），仅当用户 CSS 写了 q {} 才生效
 */
function wrapQuotedDialogue(text: string): string {
    return mapMarkdownOutsideCode(text, segment =>
        segment.split(/(<[^>]*>)/g).map(part => {
            if (part.startsWith("<")) return part;
            return part
                .replace(/“([^”\n]+)”/g, "<q>“$1”</q>")
                .replace(/「([^」\n]+)」/g, "<q>「$1」</q>")
                .replace(/"([^"\n]+)"/g, "<q>\"$1\"</q>");
        }).join(""),
    );
}

function linkifyBareUrls(text: string): string {
    return mapMarkdownOutsideCode(text, segment => {
        const normalized = segment.replace(
            /https?:\/\/[^\s<>"'`]+(?:\s*[?&]\s*[^\s<>"'`]+)*/g,
            match => match.replace(/\s+/g, ""),
        );
        return normalized.replace(/https?:\/\/[^\s<>"'`()[\]]+/g, (url, offset, source) => {
            const prev = source[offset - 1];
            if (prev === "[" || prev === "(" || prev === "<" || prev === "=" || prev === "\"" || prev === "'") return url;

            const trailing = url.match(/[),.;!?，。！？、]+$/)?.[0] || "";
            const href = trailing ? url.slice(0, -trailing.length) : url;
            return `[${href}](${href})${trailing}`;
        });
    });
}

const MARKDOWN_COMPONENTS = {
    p: ({ node, className, ...props }: any) => (
        <div
            className={["chat-markdown-paragraph", className].filter(Boolean).join(" ")}
            {...props}
        />
    ),
    li: ({ node, ...props }: any) => <li {...props} />,
    blockquote: ({ node, ...props }: any) => <blockquote {...props} />,
    table: ({ node, ...props }: any) => (
        <div className="chat-markdown-table-wrap">
            <table {...props} />
        </div>
    ),
    a: ({ node, ...props }: any) => <a className="chat-markdown-link" target="_blank" rel="noreferrer" {...props} />,
    user: ({ node, ...props }: any) => <span className="rm-user" {...props} />,
    prologue: ({ node, ...props }: any) => <div className="rm-prologue" {...props} />,
    profile: ({ node, ...props }: any) => <div className="rm-profile" {...props} />,
    branches: ({ node, ...props }: any) => <div className="rm-branches" {...props} />,
    content: ({ node, ...props }: any) => <div className="rm-content" {...props} />
} as any;

function MarkdownTextContent({
    content,
    onActionSelect,
    htmlFrameVariant,
}: {
    content: string;
    onActionSelect?: (text: string) => void;
    htmlFrameVariant?: ChatHtmlFrameVariant;
}) {
    const containerRef = useRef<HTMLDivElement>(null);

    // Action delegate for data-action clicks in inline HTML
    useEffect(() => {
        if (!onActionSelect) return;
        const el = containerRef.current;
        if (!el) return;
        const handler = (e: MouseEvent) => {
            const target = (e.target as HTMLElement).closest("[data-action]");
            if (target) {
                e.preventDefault();
                e.stopPropagation();
                const action = target.getAttribute("data-action");
                if (action) onActionSelect(action);
            }
        };
        el.addEventListener("click", handler, true);
        return () => el.removeEventListener("click", handler, true);
    }, [onActionSelect]);

    // Strip [音乐:xxx] and tool tags, collapse newlines
    const cleaned = normalizeTextBubbleContent(content);
    if (!cleaned) return null;

    // 支付类 scheme（微信扫码付 / 支付宝等）→ 渲染成支付卡片，从正文剥离原始串
    const payUrls = extractPaySchemeUrls(cleaned);

    // Auto-detect rich HTML (with <script> + <style>) that wasn't wrapped in ```html
    const strippedCodeBlocks = cleaned.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
    if (/^\s*</.test(strippedCodeBlocks)
        && /<script\b[\s\S]*?<\/script>/i.test(strippedCodeBlocks)
        && /<style\b[\s\S]*?<\/style>/i.test(strippedCodeBlocks)) {
        return <HtmlPreviewCard html={cleaned} onActionSelect={onActionSelect} htmlFrameVariant={htmlFrameVariant} />;
    }

    // FIRST: split out ```html blocks (before extractStyles, so HTML block styles aren't leaked)
    const segments = splitChatContent(cleaned);
    const hasHtmlBlocks = segments.some(s => s.type === "html");

    if (!hasHtmlBlocks) {
        // Simple path: pure markdown — extract styles only from non-html content
        const { styles, body } = extractStyles(cleaned);
        const mdCleaned = wrapQuotedDialogue(linkifyBareUrls(stripPaySchemeUrls(body.trim())));
        if (!mdCleaned && !styles && payUrls.length === 0) return null;
        return (
            <div className="chat-markdown hide-scrollbar break-words" ref={containerRef}>
                {styles && <style dangerouslySetInnerHTML={{ __html: styles }} />}
                {mdCleaned && (
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeRaw]} components={MARKDOWN_COMPONENTS}>
                        {mdCleaned}
                    </ReactMarkdown>
                )}
                {payUrls.map((u, i) => <ScanPayCard key={`pay-${i}`} url={u} />)}
            </div>
        );
    }

    // Mixed path: markdown + html blocks
    return (
        <div className="chat-markdown hide-scrollbar break-words" ref={containerRef}>
            {segments.map((seg, i) => {
                if (seg.type === "html") {
                    return <HtmlPreviewCard key={`html-${i}`} html={seg.content} onActionSelect={onActionSelect} htmlFrameVariant={htmlFrameVariant} />;
                }
                // Extract styles only from markdown segments (not from html blocks)
                const { styles, body } = extractStyles(seg.content);
                const mdContent = wrapQuotedDialogue(linkifyBareUrls(stripPaySchemeUrls(body.trim())));
                return (
                    <div key={`md-${i}`}>
                        {styles && <style dangerouslySetInnerHTML={{ __html: styles }} />}
                        {mdContent && (
                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeRaw]} components={MARKDOWN_COMPONENTS}>
                                {mdContent}
                            </ReactMarkdown>
                        )}
                    </div>
                );
            })}
            {payUrls.map((u, i) => <ScanPayCard key={`pay-${i}`} url={u} />)}
        </div>
    );
}

function PlainTextContent({ content, className }: { content: string; className?: string }) {
    return (
        <div
            className={className ?? ""}
            style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", maxWidth: "100%" }}
        >
            {content}
        </div>
    );
}

export const BilingualTextBlock = memo(function BilingualTextBlock({
    text,
    onActionSelect,
    mode = "markdown",
    className,
    defaultExpanded = false,
    htmlFrameVariant,
}: {
    text: string;
    onActionSelect?: (text: string) => void;
    mode?: "markdown" | "plain";
    className?: string;
    defaultExpanded?: boolean;
    htmlFrameVariant?: ChatHtmlFrameVariant;
}) {
    const bilingual = splitBilingualText(text);
    const [expanded, setExpanded] = useState(defaultExpanded);
    useEffect(() => {
        setExpanded(defaultExpanded);
    }, [text, defaultExpanded]);
    const renderContent = (content: string, extraClass?: string) => {
        if (mode === "plain") return <PlainTextContent content={content} className={extraClass} />;
        return (
            <div className={extraClass}>
                <MarkdownTextContent content={content} onActionSelect={onActionSelect} htmlFrameVariant={htmlFrameVariant} />
            </div>
        );
    };

    if (!bilingual) {
        return renderContent(text, className);
    }

    return (
        <div className={`chat-bilingual-block ${className ?? ""}`.trim()}>
            <div className="chat-bilingual-section">
                {renderContent(bilingual.original, "chat-bilingual-content")}
            </div>
            <button
                type="button"
                className="chat-bilingual-toggle"
                onClick={(e) => {
                    e.stopPropagation();
                    setExpanded(v => !v);
                }}
                aria-expanded={expanded}
            >
                {expanded ? "收起中文" : "中文"}
            </button>
            {expanded && (
                <>
                    <div className="chat-bilingual-divider" />
                    <div className="chat-bilingual-section chat-bilingual-section-translation">
                        {renderContent(bilingual.translated, "chat-bilingual-content")}
                    </div>
                </>
            )}
        </div>
    );
});

function TextBubble({ content, onActionSelect, defaultTranslationExpanded = false }: { content: string; onActionSelect?: (text: string) => void; defaultTranslationExpanded?: boolean }) {
    return <BilingualTextBlock text={content} onActionSelect={onActionSelect} mode="markdown" defaultExpanded={defaultTranslationExpanded} />;
}

// ── Red Packet ─────────────────────────────

function RedPacketBubble({ msg, charName, userName, groupSize, onShowDetail }: {
    msg: ChatMessage; charName?: string; userName?: string; groupSize?: number;
    onShowDetail?: (msg: ChatMessage) => void;
}) {
    const d = msg.mediaData;
    const isDeclined = d?.status === "declined";
    const claimedBy = d?.claimedBy || [];
    const claimedAmounts = d?.claimedAmounts || {};
    const totalRecipients = d?.count || 1;
    const allClaimed = d?.status === "opened" || claimedBy.length >= totalRecipients;
    const isDone = allClaimed || isDeclined;
    const userShare = userName ? claimedAmounts[userName] : undefined;

    const bgClass = isDeclined
        ? "bg-declined-gradient"
        : isDone ? "bg-opened-gradient" : "bg-redpacket-gradient";

    return (
        <div
            className={`chat-red-packet-card w-[240px] rounded-xl overflow-hidden cursor-pointer ${!isDone ? "red-packet-pulse" : ""}`}
            onClick={() => onShowDetail?.(msg)}
        >
            <div className={`chat-red-packet-body p-4 flex items-center gap-3 min-h-[70px] ${bgClass}`}>
                <div className="ts-32 shrink-0">🧧</div>
                <div className="flex-1 min-w-0">
                    <div className="text-white ts-15 font-medium">
                        {d?.label || "恭喜发财，大吉大利"}
                    </div>
                    {userShare != null && (
                        <div className="ts-20 font-bold mt-1 ui-text-white-85">¥{userShare.toFixed(2)}</div>
                    )}
                    {isDeclined && <div className="ts-12 mt-1 ui-text-white-70">已退回</div>}
                </div>
            </div>
            <div className="ui-media-footer px-4 py-1.5 ts-11" {...(isDeclined ? { "data-status": "declined" } : {})}>
                <span>微信红包</span>
                {totalRecipients > 1 && claimedBy.length > 0 && (
                    <span className="ml-1 opacity-70">· {claimedBy.length}/{totalRecipients}已领取</span>
                )}
            </div>
        </div>
    );
}

// ── Transfer ─────────────────────────────

function TransferBubble({ msg, charName, userName, onShowDetail }: {
    msg: ChatMessage; charName?: string; userName?: string;
    onShowDetail?: (msg: ChatMessage) => void;
}) {
    const d = msg.mediaData;
    const isReceived = d?.status === "received";
    const isDeclined = d?.status === "declined";

    const bgClass = isDeclined
        ? "bg-declined-gradient"
        : isReceived ? "bg-opened-gradient" : "bg-transfer-gradient";

    return (
        <div
            className="chat-transfer-card w-[240px] rounded-xl overflow-hidden cursor-pointer"
            onClick={() => onShowDetail?.(msg)}
        >
            <div className={`chat-transfer-body p-4 flex items-center gap-3 ${bgClass}`}>
                <div className="ts-28 shrink-0">💰</div>
                <div className="flex-1">
                    <div className="text-white ts-24 font-bold">¥{d?.amount?.toFixed(2)}</div>
                    <div className="ts-13 mt-0.5 ui-text-white-85">{d?.label || "转账"}</div>
                </div>
            </div>
            {d?.recipientName && (
                <div className={`px-4 py-1 ts-12 ui-text-white-70 ${bgClass}`}>转给 {d.recipientName}</div>
            )}
            <div
                className="ui-media-footer px-4 py-2 ts-12 flex justify-between items-center"
                {...(isDeclined ? { "data-status": "declined" } : {})}
            >
                <span>微信转账</span>
                {isReceived && <span>已收款</span>}
                {isDeclined && <span>已退回</span>}
            </div>
        </div>
    );
}

// ── Payment Request ─────────────────────────────

function PaymentRequestBubble({ msg, charName, userName, onShowDetail }: {
    msg: ChatMessage; charName?: string; userName?: string;
    onShowDetail?: (msg: ChatMessage) => void;
}) {
    const d = msg.mediaData;
    const status = d?.status;
    const isPaid = status === "paid";
    const isDeclined = status === "declined";
    const requester = msg.role === "user" ? (userName || "你") : (msg.senderName || charName || "对方");
    const amount = typeof d?.amount === "number" ? d.amount.toFixed(2) : d?.paymentRequestAmountLabel || "0.00";
    const itemsText = d?.paymentRequestItemsText || (d?.paymentRequestItems || [])
        .map(item => `${item.title}/${item.detail}/${item.priceLabel}/${item.quantityLabel}`)
        .join("; ");
    const statusText = isPaid ? "已代付" : isDeclined ? "已拒绝" : "待代付";

    return (
        <div
            className="chat-payment-request-card w-[248px] rounded-xl overflow-hidden cursor-pointer"
            onClick={() => onShowDetail?.(msg)}
        >
            <div className={`chat-payment-request-body p-4 flex items-start gap-3 ${isDeclined ? "bg-declined-gradient" : isPaid ? "bg-opened-gradient" : "bg-transfer-gradient"}`}>
                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0 text-white">
                    <ReceiptText size={22} strokeWidth={2.2} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-white ts-12 ui-text-white-85">{requester}发起代付请求</div>
                    <div className="text-white ts-24 font-bold mt-1">¥{amount}</div>
                    <div className="ts-12 mt-1 ui-text-white-85 line-clamp-2">{itemsText || "商品订单"}</div>
                </div>
            </div>
            <div
                className="ui-media-footer px-4 py-2 ts-12 flex justify-between items-center"
                {...(isDeclined ? { "data-status": "declined" } : {})}
            >
                <span>代付请求</span>
                <span>{statusText}</span>
            </div>
        </div>
    );
}

// ── Custom App Card ─────────────────────────────

function AppCardBubble({ msg, characterId, characterName }: { msg: ChatMessage; characterId?: string; characterName?: string }) {
    const d = msg.mediaData;
    const appName = d?.appName || "APP";
    const layout = normalizeAppCardLayout(d?.appCardLayout);
    const title = layout.title || d?.appCardTitle || d?.label || appName;
    const subtitle = layout.subtitle;
    const body = d?.appDirectiveId
        ? (layout.body || d?.appCardBody || "")
        : (layout.body || d?.appCardBody || d?.appCardSummary || msg.content);
    const toneClass = d?.appCardTone ? ` tone-${String(d.appCardTone).replace(/[^a-z0-9_-]/gi, "")}` : "";
    const cardOpenDisabled = layout.openDisabled || (layout.actions.length > 0 && layout.actions.every(action => action.disabled));
    const style = {
        ...(layout.accentColor ? { "--chat-app-card-accent": layout.accentColor } : {}),
        ...(layout.background ? { "--chat-app-card-bg": layout.background } : {}),
    } as React.CSSProperties;
    const openApp = () => {
        if (cardOpenDisabled) return;
        if (!d?.appId || typeof window === "undefined") return;
        window.dispatchEvent(new CustomEvent("open-app", {
            detail: {
                appId: toCustomAppIconId(d.appId),
                launchContext: {
                    source: d.appDirectiveId ? "chat_directive" : "chat_card",
                    messageId: msg.id,
                    sessionId: msg.sessionId,
                    characterId,
                    characterName,
                    appId: d.appId,
                    appName: d.appName,
                    directiveId: d.appDirectiveId,
                    directiveLabel: d.appDirectiveLabel,
                    directiveArgs: d.appDirectiveArgs,
                    directiveRaw: d.appDirectiveRaw,
                    sceneId: d.appSceneId,
                    sceneTag: d.appSceneTag,
                    appTags: d.appTags,
                    historyText: d.appHistoryText || msg.content,
                    historyRole: d.appHistoryRole,
                    summary: d.appCardSummary || msg.content,
                },
            },
        }));
    };

    if (layout.html) {
        return (
            <div className={`chat-app-custom-card${toneClass}`} data-disabled={cardOpenDisabled || undefined} style={style} onClick={openApp}>
                <iframe
                    title={title}
                    className="chat-app-custom-card-frame"
                    sandbox=""
                    style={{ height: layout.height }}
                    srcDoc={buildAppCardSrcDoc(layout.html)}
                />
            </div>
        );
    }

    return (
        <div className={`chat-app-card${toneClass}`} data-disabled={cardOpenDisabled || undefined} style={style} onClick={openApp}>
            <div className="chat-app-card-head">
                <span className="chat-app-card-icon" aria-hidden>
                    <Blocks size={18} strokeWidth={2} />
                </span>
                <span className="chat-app-card-name">{layout.appLabel || appName}</span>
                {layout.status ? <span className="chat-app-card-status">{layout.status}</span> : null}
            </div>
            {layout.image ? <img className="chat-app-card-image" src={layout.image} alt="" /> : null}
            <div className="chat-app-card-title">{title}</div>
            {subtitle ? <div className="chat-app-card-subtitle">{subtitle}</div> : null}
            {body ? <div className="chat-app-card-body">{body}</div> : null}
            {layout.sections.length > 0 ? (
                <div className="chat-app-card-sections">
                    {layout.sections.map((section, index) => (
                        <div className="chat-app-card-section" key={`${section.title || "section"}-${index}`}>
                            {section.title ? <div className="chat-app-card-section-title">{section.title}</div> : null}
                            {section.text ? <div className="chat-app-card-section-text">{section.text}</div> : null}
                            {section.rows.length > 0 ? (
                                <div className="chat-app-card-rows">
                                    {section.rows.map((row, rowIndex) => (
                                        <div className="chat-app-card-row" key={`${row.label}-${rowIndex}`}>
                                            <span>{row.label}</span>
                                            <strong>{row.value}</strong>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                            {section.chips.length > 0 ? (
                                <div className="chat-app-card-chips">
                                    {section.chips.map((chip, chipIndex) => <span key={`${chip}-${chipIndex}`}>{chip}</span>)}
                                </div>
                            ) : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {layout.actions.length > 0 ? (
                <div className="chat-app-card-actions">
                    {layout.actions.map((action, index) => (
                        <button
                            type="button"
                            key={`${action.label}-${index}`}
                            data-style={action.style || "default"}
                            disabled={action.disabled}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (action.disabled) return;
                                openApp();
                            }}
                        >
                            {action.label}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

type NormalizedAppCardLayout = {
    appLabel: string;
    title: string;
    subtitle: string;
    body: string;
    html: string;
    height: number;
    status: string;
    image: string;
    accentColor: string;
    background: string;
    openDisabled: boolean;
    sections: Array<{
        title: string;
        text: string;
        rows: Array<{ label: string; value: string }>;
        chips: string[];
    }>;
    actions: Array<{ label: string; style: string; disabled: boolean }>;
};

function cardRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cardText(value: unknown, max = 240): string {
    return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function cardTextArray(value: unknown, maxItems = 6): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => cardText(item, 80)).filter(Boolean).slice(0, maxItems);
}

function cardNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function stripAppCardExecutableHtml(html: string): string {
    return html
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "");
}

function buildAppCardSrcDoc(html: string): string {
    const safeHtml = stripAppCardExecutableHtml(html);
    if (/<html[\s>]/i.test(safeHtml)) return safeHtml;
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    *{box-sizing:border-box;}
  </style>
</head>
<body>${safeHtml}</body>
</html>`;
}

function normalizeAppCardLayout(value: unknown): NormalizedAppCardLayout {
    const record = cardRecord(value);
    const sections = Array.isArray(record.sections) ? record.sections : [];
    const rows = Array.isArray(record.rows) ? [{ title: record.rowsTitle, rows: record.rows }] : [];
    const normalizedSections = [...sections, ...rows].map(item => {
        const section = cardRecord(item);
        const sectionRows = Array.isArray(section.rows) ? section.rows : [];
        return {
            title: cardText(section.title, 80),
            text: cardText(section.text ?? section.body, 500),
            rows: sectionRows.map(row => {
                const rowRecord = cardRecord(row);
                return {
                    label: cardText(rowRecord.label ?? rowRecord.name, 80),
                    value: cardText(rowRecord.value ?? rowRecord.text, 160),
                };
            }).filter(row => row.label || row.value).slice(0, 8),
            chips: cardTextArray(section.chips ?? section.tags),
        };
    }).filter(section => section.title || section.text || section.rows.length || section.chips.length).slice(0, 6);
    const actions = Array.isArray(record.actions) ? record.actions : [];
    return {
        appLabel: cardText(record.appLabel, 60),
        title: cardText(record.title, 100),
        subtitle: cardText(record.subtitle, 160),
        body: cardText(record.body ?? record.text, 1000),
        html: cardText(record.html, 20000),
        height: cardNumber(record.height ?? record.cardHeight, 220, 96, 520),
        status: cardText(record.status, 60),
        image: cardText(record.image ?? record.imageUrl, 2000),
        accentColor: cardText(record.accentColor, 40),
        background: cardText(record.background, 120),
        openDisabled: record.openDisabled === true || record.clickDisabled === true || record.disabled === true || record.clickable === false,
        sections: normalizedSections,
        actions: actions.map(item => {
            const action = cardRecord(item);
            return {
                label: cardText(action.label ?? action.text, 40),
                style: cardText(action.style, 30),
                disabled: action.disabled === true || action.enabled === false,
            };
        }).filter(action => action.label).slice(0, 3),
    };
}

// ── Contact card（推荐联系人名片） ─────────────────────────────
// 三态：已好友（角标，点击开会话）/ 已建档未添加（点击跳添加页）/
// 未建档（点击进入现场生成档案流程——AI 幻觉转建档）。
// 名字实时按推荐人同世界解析，建档后所有同名旧名片自动可添加。

function ContactCardBubble({ msg, characterId }: { msg: ChatMessage; characterId?: string }) {
    const contactName = msg.mediaData?.contactCardName || msg.mediaData?.label || "";
    const [showGenerateFlow, setShowGenerateFlow] = useState(false);
    const [resolveTick, setResolveTick] = useState(0);

    const resolved = useMemo(
        () => (characterId && contactName ? resolveContactCard(characterId, contactName) : { character: null, isContact: false }),
        // resolveTick：建档完成后强制重新解析
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [characterId, contactName, resolveTick],
    );
    const recommenderName = useMemo(
        () => loadCharacters().find(c => c.id === characterId)?.name || "对方",
        [characterId],
    );

    function handleClick(e: React.MouseEvent) {
        e.stopPropagation();
        if (!contactName) return;
        if (resolved.character && resolved.isContact) {
            // 已是好友：直接打开与 TA 的会话
            const session = createOrGetSession(resolved.character.id);
            window.dispatchEvent(new CustomEvent(CHAT_OPEN_SESSION_EVENT, { detail: { sessionId: session.id } }));
            return;
        }
        if (resolved.character) {
            // 已建档未添加：跳「添加朋友」页并预载资料
            dispatchOpenAddContact(resolved.character.id);
            return;
        }
        if (characterId) setShowGenerateFlow(true);
    }

    return (
        <>
            <div className="chat-contact-card" onClick={handleClick} role="button">
                <div className="chat-contact-card-main">
                    <div className="chat-contact-card-avatar">
                        {resolved.character?.avatar
                            ? <img src={resolved.character.avatar} alt="" />
                            : <CharAvatarFallbackInline name={contactName} />}
                    </div>
                    <div className="chat-contact-card-info">
                        <div className="chat-contact-card-name">{contactName || "联系人"}</div>
                        <div className="chat-contact-card-sub">
                            {resolved.character
                                ? `微信号: ${resolved.character.wechatID || resolved.character.id.slice(0, 10)}`
                                : "点击查看"}
                        </div>
                    </div>
                    {resolved.isContact && <span className="chat-contact-card-badge">已添加</span>}
                </div>
                <div className="chat-contact-card-footer">个人名片</div>
            </div>
            {showGenerateFlow && characterId && typeof document !== "undefined" && createPortal(
                <ContactCardGenerateFlow
                    recommenderCharacterId={characterId}
                    recommenderName={recommenderName}
                    contactName={contactName}
                    sessionId={msg.sessionId}
                    messageId={msg.id}
                    onClose={() => setShowGenerateFlow(false)}
                    onCreated={() => setResolveTick(t => t + 1)}
                />,
                document.body,
            )}
        </>
    );
}

/** 无头像时的首字占位（名片专用，避免依赖其它气泡的 fallback 组件） */
function CharAvatarFallbackInline({ name }: { name: string }) {
    return (
        <div className="chat-contact-card-avatar-fallback">
            {(name || "?").slice(0, 1)}
        </div>
    );
}

// ── Gift ─────────────────────────────

function GiftBubble({ msg }: { msg: ChatMessage }) {
    const d = msg.mediaData;
    const title = d?.giftName || d?.label || "礼物";
    const recipient = d?.recipientName;
    const merchant = d?.giftMerchantLabel || "购物订单";
    const serial = (d?.shoppingGiftId || d?.giftOrderId || msg.id || "gift")
        .replace(/[^a-z0-9]/gi, "")
        .slice(-6)
        .toUpperCase() || "GIFT01";
    const sentLabel = d?.giftSentAt
        ? new Date(d.giftSentAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "";

    return (
        <div
            className="chat-gift-card w-[248px] rounded-none"
        >
            <div
                className="chat-gift-card-body relative min-h-[338px] px-5 py-5"
            >
                <div className="relative z-[1] min-h-[298px] flex flex-col">
                    <div className="chat-gift-card-header flex items-start justify-between gap-4">
                        <div className="min-w-0">
                            <div className="chat-gift-card-kicker ts-11 uppercase font-semibold tracking-normal text-[var(--c-icon)]">Gift Card</div>
                            <div className="chat-gift-card-source ts-12 text-[var(--c-text)] mt-1 truncate">{merchant}</div>
                        </div>
                        <div className="chat-gift-card-status ts-11 font-semibold px-2 py-1 shrink-0">
                            已送出
                        </div>
                    </div>

                    <div className="chat-gift-card-divider my-4 h-px" />

                    <div className="chat-gift-card-main min-h-[86px]">
                        <div className="min-w-0 flex-1">
                            <div className="chat-gift-card-label ts-10 uppercase font-semibold text-[var(--c-icon)]">Selected Gift</div>
                            <div className="chat-gift-card-title ts-24 font-semibold text-[var(--c-text-title)] leading-[1.12] break-words mt-1">
                                {title}
                            </div>
                        </div>
                    </div>

                    <div className="chat-gift-card-grid mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
                        {recipient && (
                            <GiftInfoCell label="收礼人" value={recipient} strong />
                        )}
                        <GiftInfoCell label="编号" value={`G-${serial}`} />
                        <GiftInfoCell label="来源" value={merchant} />
                        <GiftInfoCell label="礼物值" value={d?.giftPriceLabel || "心意礼物"} />
                        {sentLabel && <GiftInfoCell label="送出" value={sentLabel} />}
                    </div>

                    <div className="flex-1" />

                    <div className="chat-gift-card-footer mt-5 pt-3 flex items-center justify-between gap-3">
                        <div className="ts-10 uppercase font-semibold text-[var(--c-icon)]">Gift Certificate</div>
                        <div className="chat-gift-card-brand ts-10 font-semibold text-[var(--c-icon)]">AI PHONE</div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function GiftInfoCell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
    return (
        <div className="chat-gift-card-cell min-w-0">
            <div className="chat-gift-card-cell-label ts-10 text-[var(--c-icon)]">{label}</div>
            <div className={`chat-gift-card-cell-value ts-12 mt-1 leading-snug truncate ${strong ? "font-semibold text-[var(--c-text-title)]" : "text-[var(--c-text)]"}`}>
                {value}
            </div>
        </div>
    );
}

// ── Image (placeholder) ─────────────────────────────

function GeneratedImagePromptDialog({
    value,
    onChange,
    onCancel,
    onConfirm,
    busy,
    error,
}: {
    value: string;
    onChange: (value: string) => void;
    onCancel: () => void;
    onConfirm: () => void;
    busy: boolean;
    error?: string;
}) {
    return (
        <div
            className="modal-overlay"
            data-ui="modal"
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
            onPointerCancel={e => e.stopPropagation()}
            onPointerMove={e => e.stopPropagation()}
            onContextMenu={e => e.stopPropagation()}
            onClick={e => {
                e.stopPropagation();
                onCancel();
            }}
        >
            <div className="modal-dialog chat-generated-image-prompt-dialog" data-ui="modal-dialog" onClick={e => e.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <h3 className="modal-title">重新生成图片</h3>
                </div>
                <div className="modal-body chat-generated-image-prompt-body" data-ui="modal-body">
                    <textarea
                        className="ui-textarea chat-generated-image-prompt-textarea"
                        value={value}
                        onChange={e => onChange(e.target.value)}
                        placeholder="输入图片提示词"
                        disabled={busy}
                    />
                    {error && <div className="chat-generated-image-retry-error">生成失败：{error}</div>}
                </div>
                <div className="modal-footer" data-ui="modal-footer">
                    <button className="ui-btn ui-btn-ghost" onClick={onCancel}>取消</button>
                    <button
                        className="ui-btn ui-btn-action"
                        disabled={busy || !value.trim()}
                        onClick={onConfirm}
                    >
                        生成
                    </button>
                </div>
            </div>
        </div>
    );
}

function ImageBubble({
    msg,
    onUpdate,
    characterId,
}: {
    msg: ChatMessage;
    onUpdate?: (updated: ChatMessage) => void;
    characterId?: string;
}) {
    const d = msg.mediaData;
    const label = d?.label || "照片";
    const rawUrl = msg.mediaUrl || "";
    // 媒体维护压缩后 mediaUrl 是 media-store:// 引用，直接当 <img src> 会裂图，
    // 与 MediaFileBubble 相同：先解析为 object URL 再渲染。
    const [resolvedUrl, setResolvedUrl] = useState<string>(isMediaStoreRef(rawUrl) ? "" : rawUrl);
    const [refExpired, setRefExpired] = useState(false);
    const [showPromptEditor, setShowPromptEditor] = useState(false);
    const [promptDraft, setPromptDraft] = useState("");
    const [regenerating, setRegenerating] = useState(false);
    const [retryError, setRetryError] = useState("");
    const isPending = d?.imageGenerationStatus === "pending";
    const canRetry = (!msg.mediaUrl || refExpired)
        && !isPending
        && Boolean(d?.label?.trim());

    useEffect(() => {
        if (!isMediaStoreRef(rawUrl)) {
            setResolvedUrl(rawUrl);
            setRefExpired(false);
            return;
        }
        let revokeUrl = "";
        loadMediaObjectUrl(rawUrl).then(objUrl => {
            if (objUrl) { setResolvedUrl(objUrl); revokeUrl = objUrl; }
            else setRefExpired(true);
        });
        return () => { if (revokeUrl) URL.revokeObjectURL(revokeUrl); };
    }, [rawUrl]);

    const openPromptEditor = useCallback(() => {
        setPromptDraft(d?.label?.trim() || "");
        setRetryError("");
        setShowPromptEditor(true);
    }, [d?.label]);

    const handleRetry = useCallback(() => {
        const nextDescription = promptDraft.trim();
        if (!nextDescription) {
            setRetryError("提示词不能为空");
            return;
        }
        setShowPromptEditor(false);
        setRegenerating(true);
        setRetryError("");
        retryChatGeneratedImage(msg, characterId, nextDescription)
            .then(updated => {
                onUpdate?.(updated);
            })
            .catch(error => {
                setRetryError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                setRegenerating(false);
            });
    }, [characterId, msg, onUpdate, promptDraft]);

    if (resolvedUrl) {
        return (
            <div className="chat-photo-card chat-photo-card--image rounded-none">
                <img
                    src={resolvedUrl}
                    alt={label}
                    className="chat-photo-card-image block max-w-[240px] max-h-[320px] w-auto h-auto"
                />
            </div>
        );
    }
    // media-store 引用解析中：占个位，避免闪一下重试卡
    if (isMediaStoreRef(rawUrl) && !refExpired) {
        return <div className="chat-photo-card w-[180px] aspect-square rounded-none" />;
    }
    if (isPending) {
        return (
            <div className="chat-photo-card chat-photo-card--pending w-[180px] aspect-square rounded-none">
                <div className="chat-photo-card-pending-inner">
                    <div className="chat-photo-card-loader" aria-hidden="true">
                        <span className="chat-photo-card-loader-orbit" />
                        <span className="chat-photo-card-loader-core" />
                    </div>
                    <div className="chat-photo-card-pending-text">图片接收中...</div>
                </div>
            </div>
        );
    }
    return (
        <div className="chat-generated-image-retry-stack">
            <div className="chat-generated-image-retry-wrap" data-action-placement={msg.role === "user" ? "left" : "right"}>
                <div className="chat-photo-card w-[180px] aspect-square rounded-none">
                    <div className="chat-photo-card-placeholder w-full h-full flex items-center justify-center px-5">
                        <div className="chat-photo-card-text">{label}</div>
                    </div>
                </div>
                {canRetry && (
                    <button
                        type="button"
                        className="chat-generated-image-retry-btn"
                        disabled={regenerating}
                        aria-label="重新生成图片"
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => {
                            e.stopPropagation();
                            openPromptEditor();
                        }}
                    >
                        <RefreshCw size={14} className={regenerating ? "is-spinning" : undefined} />
                    </button>
                )}
            </div>
            {retryError && <div className="chat-generated-image-retry-error">生成失败：{retryError}</div>}
            {showPromptEditor && typeof document !== "undefined" && createPortal(
                <GeneratedImagePromptDialog
                    value={promptDraft}
                    onChange={setPromptDraft}
                    onConfirm={handleRetry}
                    onCancel={() => setShowPromptEditor(false)}
                    busy={regenerating}
                    error={retryError}
                />,
                document.body,
            )}
        </div>
    );
}

// ── Location ─────────────────────────────

function LocationBubble({ msg }: { msg: ChatMessage }) {
    const d = msg.mediaData;
    return (
        <div
            className="chat-location-card w-[220px] rounded-xl overflow-hidden"
        >
            <div
                className="chat-location-map w-full h-[100px] flex items-center justify-center relative ui-map-gradient"
            >
                {/* Grid pattern for map feel */}
                <div
                    className="absolute inset-0 opacity-15 ui-map-grid"
                />
                <div className="ts-36 relative z-[1]">📍</div>
            </div>
            <div className="chat-location-label px-3 py-2.5 bg-[var(--c-input)] flex items-center gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                    <circle cx="12" cy="10" r="3" />
                </svg>
                <span className="ts-13 text-[var(--c-text)] font-medium">
                    {d?.label || "位置"}
                </span>
            </div>
        </div>
    );
}

// ── Poke ─────────────────────────────

// 骰子点位：3x3 宫格（0-8）中每个点数要点亮的格子
const DICE_BUBBLE_PIPS: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
};

// 让指定点数朝向屏幕所需的立方体末态旋转（配合各面的摆放变换）
const DICE_BUBBLE_ORIENTATIONS: Record<number, [number, number]> = {
    1: [0, 0],
    2: [-90, 0],
    3: [0, -90],
    4: [0, 90],
    5: [90, 0],
    6: [0, 180],
};

/** 骰子消息：3D 实骰。新消息立方体翻滚约 1.4 秒后定格在掷出的点数；历史消息直接定格 */
function DiceBubble({ msg }: { msg: ChatMessage }) {
    const face = Math.min(6, Math.max(1, Number(msg.mediaData?.diceFace) || 1));
    // 挂载瞬间判定一次：只有刚发出的消息播翻滚动画
    const rollingRef = useRef(Date.now() - new Date(msg.createdAt).getTime() < 6000);
    const [rx, ry] = DICE_BUBBLE_ORIENTATIONS[face];

    return (
        <div className="dice-bubble3d" aria-label={`骰子 ${face} 点`}>
            <div className="dice-bubble3d-tilt">
                <div
                    className="dice-bubble3d-cube"
                    {...(rollingRef.current ? { "data-rolling": "" } : {})}
                    style={{ "--dice-rx": `${rx}deg`, "--dice-ry": `${ry}deg` } as React.CSSProperties}
                >
                    {[1, 2, 3, 4, 5, 6].map(f => (
                        <span key={f} className="dice-bubble3d-face" data-face={f}>
                            {Array.from({ length: 9 }, (_, cell) => (
                                <span
                                    key={cell}
                                    className="dice-bubble3d-pip"
                                    {...(DICE_BUBBLE_PIPS[f].includes(cell) ? { "data-on": "" } : {})}
                                />
                            ))}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}

function PokeBubble({ msg, charName, userName }: { msg: ChatMessage; charName?: string; userName?: string }) {
    // Prefer mediaData fields (group chat aware), fallback to old role-based logic
    const sender = msg.mediaData?.pokeSender || (msg.role === "user" ? (userName || "你") : (charName || "对方"));
    const target = msg.mediaData?.pokeTarget || (msg.role === "user" ? (charName || "对方") : (userName || "你"));
    // Replace user's own name with "你" for display
    const displaySender = sender === userName ? "你" : sender;
    const displayTarget = target === userName ? "你" : target;
    return (
        <div
            className="chat-sys-msg ts-12 mx-auto text-center"
        >
            {displaySender} 拍了拍 {displayTarget}
        </div>
    );
}

// ── Sticker ─────────────────────────────

// In-memory cache: assetId/name → resolved URL (survives re-renders, cleared on page reload)
const _stickerUrlCache = new Map<string, string>();

/** Pre-populate sticker cache for a character. Call before rendering messages. */
export async function prewarmStickerCache(characterId: string): Promise<void> {
    const { resolveCustomStickerMap } = await import("@/lib/custom-sticker-storage");
    const map = await resolveCustomStickerMap(characterId);
    for (const [name, url] of Object.entries(map)) {
        _stickerUrlCache.set(`${characterId}:${name}`, url);
    }
}

function StickerBubble({ msg, characterId }: { msg: ChatMessage; characterId?: string }) {
    const d = msg.mediaData;
    const label = d?.label || "";

    // Check pre-resolved URL or memory cache first
    const cacheKey = `${characterId || ""}:${label}`;
    const cachedUrl = d?.stickerUrl || _stickerUrlCache.get(cacheKey);
    const [resolvedUrl, setResolvedUrl] = useState<string | null>(cachedUrl || null);

    useEffect(() => {
        if (resolvedUrl || d?.stickerUrl || !label || !characterId) return;
        const custom = findCustomStickerByName(characterId, label);
        if (!custom) return;
        if (custom.externalUrl) {
            _stickerUrlCache.set(cacheKey, custom.externalUrl);
            setResolvedUrl(custom.externalUrl);
            return;
        }
        if (!custom.assetId) return;
        // Check cache
        const cached = _stickerUrlCache.get(cacheKey);
        if (cached) { setResolvedUrl(cached); return; }
        // Only hit IndexedDB once, then cache
        let cancelled = false;
        resolveCustomStickerUrl(custom.assetId).then(url => {
            if (!cancelled && url) {
                _stickerUrlCache.set(cacheKey, url);
                setResolvedUrl(url);
            }
        });
        return () => { cancelled = true; };
    }, [label, characterId, d?.stickerUrl]);

    const imgUrl = d?.stickerUrl || resolvedUrl;
    if (imgUrl) {
        return (
            <div className="chat-sticker chat-sticker-image sticker-bounce p-1">
                <img
                    src={imgUrl}
                    alt={label || "表情包"}
                    className="w-[120px] h-[120px] object-contain"
                    style={{ WebkitTouchCallout: 'none', userSelect: 'none', pointerEvents: 'none' }}
                />
            </div>
        );
    }
    // 2. Fallback: look up emoji from built-in sticker data
    const matched = label ? findStickerByName(label) : undefined;
    if (matched?.emoji) {
        return (
            <div className="chat-sticker chat-sticker-emoji sticker-bounce px-4 py-3 ts-48 text-center leading-none">
                {matched.emoji}
            </div>
        );
    }
    // 3. No match — show label as styled tag
    return (
        <div className="chat-sticker chat-sticker-fallback px-4 py-2 ts-14 text-[var(--c-text)] bg-black/5 rounded-lg text-center">
            [{label || "表情包"}]
        </div>
    );
}

// ── Quote ─────────────────────────────

function QuoteBubble({ msg, displayContent, defaultTranslationExpanded = false }: { msg: ChatMessage; displayContent?: string; defaultTranslationExpanded?: boolean }) {
    const d = msg.mediaData;
    return (
        <div className="chat-quote-message max-w-full">
            {d?.quotePreview && (
                <div className="chat-quote-preview bg-black/[0.06] border-l-[3px] border-l-black/15 px-2.5 py-1.5 ts-12 text-[var(--c-icon)] mb-1.5 rounded-r-[6px] truncate max-w-full">
                    {d.quotePreview}
                </div>
            )}
            {msg.content && <TextBubble content={displayContent ?? msg.content} defaultTranslationExpanded={defaultTranslationExpanded} />}
        </div>
    );
}


// ── Media Detail Modal (red packet / transfer) ─────────────────────────────

interface MediaDetailModalProps {
    msg: ChatMessage;
    userName: string;
    groupSize?: number;
    onAccept: (updatedMsg: ChatMessage, sysText: string, actionType: string) => void;
    onClose: () => void;
}

export function MediaDetailModal({ msg, userName, groupSize, onAccept, onClose }: MediaDetailModalProps) {
    const d = msg.mediaData;
    const isRedPacket = msg.mediaType === "red_packet";
    const isTransfer = msg.mediaType === "transfer";
    const isPaymentRequest = msg.mediaType === "payment_request";
    const [paymentError, setPaymentError] = useState("");
    if (!isRedPacket && !isTransfer && !isPaymentRequest) return null;

    const isFromUser = msg.role === "user";
    const senderDisplay = isFromUser ? userName : (d?.senderName || msg.senderName || "对方");

    // ── Red packet state ──
    const claimedBy = d?.claimedBy || [];
    const claimedAmounts = d?.claimedAmounts || {};
    const totalRecipients = d?.count || 1;
    const allClaimed = d?.status === "opened" || claimedBy.length >= totalRecipients;
    const alreadyClaimed = claimedBy.includes(userName);
    const userShare = claimedAmounts[userName];
    const isDeclined = d?.status === "declined";
    const isReceived = d?.status === "received";
    const isPaid = d?.status === "paid";

    // ── Transfer state ──
    const isRecipient = !d?.recipientName || d.recipientName === userName;
    const transferDone = isReceived || isDeclined;
    const paymentDone = isPaid || isDeclined || d?.status === "canceled";

    // Can user act?
    const canClaimRedPacket = isRedPacket && !isFromUser && !allClaimed && !isDeclined && !alreadyClaimed;
    const canActTransfer = isTransfer && !isFromUser && !transferDone && isRecipient;
    const canActPaymentRequest = isPaymentRequest && !isFromUser && !paymentDone;

    // 拼手气：随机分配（二倍均值法）
    const calcShare = (): number => {
        const total = d?.amount || 0;
        const claimedTotal = Object.values(claimedAmounts).reduce((s, v) => s + v, 0);
        const remaining = total - claimedTotal;
        const leftCount = totalRecipients - claimedBy.length;
        if (leftCount <= 1) return Math.round(remaining * 100) / 100;
        const max = (remaining / leftCount) * 2;
        const share = Math.max(0.01, Math.random() * max);
        return Math.round(Math.min(share, remaining - 0.01 * (leftCount - 1)) * 100) / 100;
    };

    const handleRedPacketAccept = () => {
        const share = totalRecipients > 1 ? calcShare() : (d?.amount || 0);
        const newClaimedBy = [...claimedBy, userName];
        const newClaimedAmounts = { ...claimedAmounts, [userName]: share };
        const newAllClaimed = newClaimedBy.length >= totalRecipients;
        const newStatus = newAllClaimed ? "opened" as const : "pending" as const;
        const updatedData = { ...d, status: newStatus, claimedBy: newClaimedBy, claimedAmounts: newClaimedAmounts };
        updateMessageMediaData(msg.id, updatedData);
        onAccept({ ...msg, mediaData: updatedData }, `${userName}领取了${senderDisplay}的红包，金额:${share}元`, "accept_red_packet");
    };

    const handleRedPacketDecline = () => {
        const updatedData = { ...d, status: "declined" as const };
        updateMessageMediaStatus(msg.id, "declined");
        onAccept({ ...msg, mediaData: updatedData }, `${userName}退回了${senderDisplay}的红包`, "decline_red_packet");
    };

    const handleTransferAccept = () => {
        updateMessageMediaStatus(msg.id, "received");
        const updatedData = { ...d, status: "received" as const };
        onAccept({ ...msg, mediaData: updatedData }, `${userName}领取了${senderDisplay}的转账`, "accept_transfer");
    };

    const handleTransferDecline = () => {
        updateMessageMediaStatus(msg.id, "declined");
        const updatedData = { ...d, status: "declined" as const };
        onAccept({ ...msg, mediaData: updatedData }, `${userName}拒收了${senderDisplay}的转账`, "decline_transfer");
    };

    const handlePaymentRequestAccept = () => {
        const amount = Number(d?.amount ?? d?.paymentRequestAmountLabel ?? 0);
        const safeAmount = Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0;
        if (safeAmount <= 0) {
            setPaymentError("金额无效，无法代付。");
            return;
        }
        const result = payWithWalletBalance({
            amount: safeAmount,
            title: "代付",
            detail: formatShoppingPaymentRequestHistory({
                amount: safeAmount,
                amountLabel: d?.paymentRequestAmountLabel,
                items: d?.paymentRequestItems,
                itemsText: d?.paymentRequestItemsText,
            }),
            category: "代付",
            relatedOrderId: d?.shoppingOrderId,
        });
        if (!result.ok || !result.transaction) {
            setPaymentError(result.error ?? "余额不足，无法代付。");
            return;
        }
        const updatedData = {
            ...d,
            status: "paid" as const,
            paymentResolvedAt: new Date().toISOString(),
            paymentPayerName: userName,
            paymentWalletTransactionId: result.transaction.id,
        };
        updateMessageMediaData(msg.id, updatedData);
        onAccept({ ...msg, mediaData: updatedData }, `${userName}接受了${senderDisplay}的代付请求`, "accept_payment_request");
    };

    const handlePaymentRequestDecline = () => {
        const updatedData = {
            ...d,
            status: "declined" as const,
            paymentResolvedAt: new Date().toISOString(),
            paymentPayerName: userName,
        };
        updateMessageMediaData(msg.id, updatedData);
        onAccept({ ...msg, mediaData: updatedData }, `${userName}拒绝了${senderDisplay}的代付请求`, "decline_payment_request");
    };

    // Gradient class
    const gradientClass = isRedPacket ? "bg-redpacket-gradient" : isTransfer ? "bg-transfer-gradient" : "bg-transfer-gradient";

    // Status label
    let statusText = "";
    if (isRedPacket) {
        if (isDeclined) statusText = "已退回";
        else if (alreadyClaimed && userShare != null) statusText = `你领取了 ¥${userShare.toFixed(2)}`;
        else if (allClaimed) statusText = "红包已领完";
        else if (isFromUser) statusText = "你发出的红包";
    } else {
        if (isTransfer) {
            if (isReceived) statusText = "已收款";
            else if (isDeclined) statusText = "已退回";
            else if (isFromUser) statusText = "你发出的转账";
            else if (!isRecipient) statusText = `转给 ${d?.recipientName}`;
        } else if (isPaymentRequest) {
            if (isPaid) statusText = "已代付";
            else if (isDeclined) statusText = "已拒绝";
            else if (isFromUser) statusText = "你发出的代付请求";
        }
    }

    const paymentItemsText = d?.paymentRequestItemsText || (d?.paymentRequestItems || [])
        .map(item => `${item.title}/${item.detail}/${item.priceLabel}/${item.quantityLabel}`)
        .join("; ");
    const modalAmountText = typeof d?.amount === "number" && Number.isFinite(d.amount)
        ? d.amount.toFixed(2)
        : String(d?.paymentRequestAmountLabel || "0.00");

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="media-modal" onClick={(e) => e.stopPropagation()}>
                {/* Header with gradient */}
                <div className={`media-modal-header ${gradientClass}`}>
                    <div className="media-modal-emoji">{isRedPacket ? "🧧" : isTransfer ? "💰" : "🧾"}</div>
                    <div className="media-modal-amount">¥{modalAmountText}</div>
                    <div className="media-modal-label">
                        {isRedPacket ? (d?.label || "恭喜发财，大吉大利") : isTransfer ? (d?.label || "转账") : "代付请求"}
                    </div>
                    <div className="media-modal-sub">来自 {senderDisplay}</div>
                    {isTransfer && d?.recipientName && (
                        <div className="media-modal-sub">转给 {d.recipientName}</div>
                    )}
                    {isRedPacket && totalRecipients > 1 && (
                        <div className="media-modal-sub">共{totalRecipients}个 · 拼手气红包 · {claimedBy.length}/{totalRecipients}已领取</div>
                    )}
                </div>

                {/* Body */}
                <div className="media-modal-body">
                    {isPaymentRequest && paymentItemsText ? (
                        <div className="media-modal-list">
                            <div className="media-modal-list-row" style={{ alignItems: "flex-start", gap: 12 }}>
                                <span style={{ whiteSpace: "normal", lineHeight: 1.5 }}>{paymentItemsText}</span>
                            </div>
                        </div>
                    ) : null}
                    {paymentError ? <div className="media-modal-status" style={{ color: "#b91c1c" }}>{paymentError}</div> : null}

                    {/* Claimed list for red packet */}
                    {isRedPacket && claimedBy.length > 0 && (
                        <div className="media-modal-list">
                            {claimedBy.map((name) => (
                                <div key={name} className="media-modal-list-row">
                                    <span>{name}</span>
                                    <span className="media-modal-list-amt">¥{(claimedAmounts[name] ?? 0).toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Action buttons or status */}
                    {canClaimRedPacket ? (
                        <div className="media-modal-actions">
                            <button onClick={handleRedPacketAccept} className="ui-btn ui-btn-redpacket">领取</button>
                            <button onClick={handleRedPacketDecline} className="ui-btn ui-btn-outline">退回</button>
                        </div>
                    ) : canActTransfer ? (
                        <div className="media-modal-actions">
                            <button onClick={handleTransferAccept} className="ui-btn ui-btn-transfer">收款</button>
                            <button onClick={handleTransferDecline} className="ui-btn ui-btn-outline">退回</button>
                        </div>
                    ) : canActPaymentRequest ? (
                        <div className="media-modal-actions">
                            <button onClick={handlePaymentRequestAccept} className="ui-btn ui-btn-transfer">帮TA代付</button>
                            <button onClick={handlePaymentRequestDecline} className="ui-btn ui-btn-outline">拒绝</button>
                        </div>
                    ) : statusText ? (
                        <div className="media-modal-status">{statusText}</div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

// ── Music Share Bubble ──────────────────────────

// ── Media File Bubble ────────────────────────────────

export function MediaImageWithPreview({
    url,
    title,
    filename,
    onError,
    sideAction,
    sideActionPlacement = "right",
}: {
    url: string;
    title: string;
    filename?: string;
    onError?: () => void;
    sideAction?: ReactNode;
    sideActionPlacement?: "left" | "right";
}) {
    const [preview, setPreview] = useState(false);
    const saveName = filename || title;
    return (
        <>
            <div className="chat-media-file-wrap" data-action-placement={sideActionPlacement}>
                <div className="chat-media-file-card chat-media-file-image" onClick={(e) => { e.stopPropagation(); setPreview(true); }}>
                    {title && <div className="chat-media-file-title">{title}</div>}
                    <img src={url} alt={title} style={{ cursor: "pointer" }} onError={onError} />
                </div>
                {sideAction ? (
                    <div className="chat-media-file-actions">
                        {sideAction}
                        <MediaSaveButton url={url} filename={ensureExtension(saveName, "image")} />
                    </div>
                ) : (
                    <MediaSaveButton url={url} filename={ensureExtension(saveName, "image")} />
                )}
            </div>
            {preview && createPortal(
                <div
                    style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}
                    onClick={() => setPreview(false)}
                >
                    <img src={url} alt={title} style={{ maxWidth: "90vw", maxHeight: "80vh", objectFit: "contain", borderRadius: 8 }} />
                    <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={async (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            const { downloadUrl } = await import("@/lib/download-utils");
                            await downloadUrl(url, ensureExtension(saveName, "image"));
                        }}
                        style={{ color: "#fff", fontSize: "calc(14px*var(--app-text-scale,1))", opacity: 0.8, border: "none", cursor: "pointer", padding: "8px 20px", borderRadius: 20, background: "rgba(255,255,255,0.15)", backdropFilter: "blur(8px)" }}
                    >
                        保存图片
                    </button>
                </div>,
                document.body,
            )}
        </>
    );
}

function MediaSaveButton({ url, filename }: { url: string; filename: string }) {
    return (
        <button
            className="chat-media-file-save"
            aria-label="保存文件"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={async (e) => {
                e.stopPropagation();
                e.preventDefault();
                const { downloadUrl } = await import("@/lib/download-utils");
                await downloadUrl(url, filename);
            }}
        >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
        </button>
    );
}

const DEFAULT_EXT: Record<string, string> = { audio: ".mp3", image: ".png", video: ".mp4", file: ".bin" };

function ensureExtension(name: string, fileType: string): string {
    if (!name) return `file${DEFAULT_EXT[fileType] || ""}`;
    if (/\.\w{2,5}$/.test(name)) return name;
    return `${name}${DEFAULT_EXT[fileType] || ""}`;
}

function MediaFileBubble({
    msg,
    onUpdate,
    characterId,
}: {
    msg: ChatMessage;
    onUpdate?: (updated: ChatMessage) => void;
    characterId?: string;
}) {
    const rawUrl = msg.mediaUrl || "";
    const fileType = msg.mediaData?.fileType || "file";
    const title = msg.mediaData?.fileName || msg.content || "";
    const [resolvedUrl, setResolvedUrl] = useState<string>(isMediaStoreRef(rawUrl) ? "" : rawUrl);
    const [expired, setExpired] = useState(false);
    const audioRef = useRef<HTMLAudioElement>(null);
    const [playing, setPlaying] = useState(false);
    const [progress, setProgress] = useState(0);
    const [duration, setDuration] = useState(0);
    const [showImagePromptEditor, setShowImagePromptEditor] = useState(false);
    const [imagePromptDraft, setImagePromptDraft] = useState("");
    const [imageRegenerating, setImageRegenerating] = useState(false);
    const [imageRetryError, setImageRetryError] = useState("");

    useEffect(() => {
        if (!isMediaStoreRef(rawUrl)) {
            // Plain URLs (e.g. the fresh data URL written by image regeneration)
            // must re-sync when the message's mediaUrl changes — resolvedUrl is
            // only initialized at mount, which left the old image on screen
            // until the chat app was reopened.
            setResolvedUrl(rawUrl);
            setExpired(false);
            return;
        }
        let revokeUrl = "";
        loadMediaObjectUrl(rawUrl).then(objUrl => {
            if (objUrl) { setResolvedUrl(objUrl); revokeUrl = objUrl; }
            else setExpired(true);
        });
        return () => { if (revokeUrl) URL.revokeObjectURL(revokeUrl); };
    }, [rawUrl]);

    const togglePlay = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        const audio = audioRef.current;
        if (!audio) return;
        if (playing) { audio.pause(); } else { audio.play(); }
    }, [playing]);

    const handleTimeUpdate = useCallback(() => {
        const audio = audioRef.current;
        if (!audio || !audio.duration) return;
        setProgress(audio.currentTime / audio.duration);
    }, []);

    const openImagePromptEditor = useCallback(() => {
        setImagePromptDraft(msg.mediaData?.label?.trim() || "");
        setImageRetryError("");
        setShowImagePromptEditor(true);
    }, [msg.mediaData?.label]);

    const handleRegenerateImage = useCallback(() => {
        const nextDescription = imagePromptDraft.trim();
        if (!nextDescription) {
            setImageRetryError("提示词不能为空");
            return;
        }
        setShowImagePromptEditor(false);
        setImageRegenerating(true);
        setImageRetryError("");
        retryChatGeneratedImage(msg, characterId, nextDescription)
            .then(updated => {
                onUpdate?.(updated);
            })
            .catch(error => {
                setImageRetryError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
                setImageRegenerating(false);
            });
    }, [characterId, imagePromptDraft, msg, onUpdate]);

    const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.stopPropagation();
        const audio = audioRef.current;
        if (!audio || !audio.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        audio.currentTime = ratio * audio.duration;
    }, []);

    const url = resolvedUrl;

    if (expired) {
        return (
            <div className="chat-media-file-card chat-media-file-generic">
                <span className="chat-media-file-title" style={{ opacity: 0.5 }}>文件已过期</span>
            </div>
        );
    }

    if (!url && isMediaStoreRef(rawUrl)) {
        return (
            <div className="chat-media-file-card chat-media-file-generic">
                <span className="chat-media-file-title" style={{ opacity: 0.5 }}>加载中...</span>
            </div>
        );
    }

    if (fileType === "image" && !url) {
        const fallbackTitle = msg.mediaData?.label?.trim() || title || "图片";
        return (
            <div className="chat-media-file-card chat-media-file-generic">
                <span className="chat-media-file-title">{fallbackTitle}</span>
            </div>
        );
    }

    const formatTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, "0")}`;
    };

    if (fileType === "audio" && url) {
        return (
            <div className="chat-media-file-wrap">
                <div className="chat-media-file-card chat-media-file-audio">
                    <audio
                        ref={audioRef}
                        src={url}
                        preload="metadata"
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onEnded={() => { setPlaying(false); setProgress(0); }}
                        onTimeUpdate={handleTimeUpdate}
                        onLoadedMetadata={() => { if (audioRef.current) setDuration(audioRef.current.duration); }}
                    />
                    <div className="chat-media-file-header">
                        <button className="chat-media-file-play" onClick={togglePlay}>
                            {playing ? (
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                            ) : (
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                            )}
                        </button>
                        <div className="chat-media-file-info">
                            <div className="chat-media-file-title">{title}</div>
                            <div className="chat-media-file-time">
                                {duration > 0 ? `${formatTime(progress * duration)} / ${formatTime(duration)}` : "加载中..."}
                            </div>
                        </div>
                    </div>
                    <div className="chat-media-file-progress" onClick={handleSeek}>
                        <div className="chat-media-file-progress-fill" style={{ width: `${progress * 100}%` }} />
                    </div>
                </div>
                <MediaSaveButton url={url} filename={ensureExtension(title, "audio")} />
            </div>
        );
    }

    if (fileType === "image" && url) {
        const displayTitle = msg.mediaData?.imageGenerationPrompt ? "" : title;
        const canRegenerateImage = Boolean(msg.mediaData?.label?.trim())
            && (msg.mediaData?.imageGenerationStatus === "generated" || Boolean(msg.mediaData?.imageGenerationPrompt));
        return (
            <div className="chat-generated-image-retry-stack">
                <MediaImageWithPreview
                    url={url}
                    title={displayTitle}
                    filename={title}
                    sideActionPlacement={msg.role === "user" ? "left" : "right"}
                    sideAction={canRegenerateImage ? (
                        <button
                            type="button"
                            className="chat-generated-image-retry-btn"
                            disabled={imageRegenerating}
                            aria-label="重新生成图片"
                            onPointerDown={e => e.stopPropagation()}
                            onClick={e => {
                                e.stopPropagation();
                                openImagePromptEditor();
                            }}
                        >
                            <RefreshCw size={14} className={imageRegenerating ? "is-spinning" : undefined} />
                        </button>
                    ) : undefined}
                />
                {imageRetryError && <div className="chat-generated-image-retry-error">生成失败：{imageRetryError}</div>}
                {showImagePromptEditor && typeof document !== "undefined" && createPortal(
                    <GeneratedImagePromptDialog
                        value={imagePromptDraft}
                        onChange={setImagePromptDraft}
                        onConfirm={handleRegenerateImage}
                        onCancel={() => setShowImagePromptEditor(false)}
                        busy={imageRegenerating}
                        error={imageRetryError}
                    />,
                    document.body,
                )}
            </div>
        );
    }

    if (fileType === "video" && url) {
        return (
            <div className="chat-media-file-wrap">
                <div className="chat-media-file-card chat-media-file-video">
                    {title && <div className="chat-media-file-title">{title}</div>}
                    <video src={url} controls preload="metadata" onClick={(e) => e.stopPropagation()} />
                </div>
                <MediaSaveButton url={url} filename={ensureExtension(title, "video")} />
            </div>
        );
    }

    return (
        <div className="chat-media-file-wrap">
            <div className="chat-media-file-card chat-media-file-generic" onClick={(e) => { e.stopPropagation(); if (url) window.open(url, "_blank"); }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><path d="M14 2v6h6" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <span className="chat-media-file-title">{title}</span>
            </div>
            {url && <MediaSaveButton url={url} filename={ensureExtension(title, "file")} />}
        </div>
    );
}

function MusicShareBubble({ msg, onPlay }: { msg: ChatMessage; onPlay?: (title: string, artist?: string) => void }) {
    const title = msg.mediaData?.musicTitle || "未知歌曲";
    const artist = msg.mediaData?.musicArtist || "";
    return (
        <div
            className="chat-music-share-card"
            style={{ cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); onPlay?.(title, artist || undefined); }}
        >
            <div className="chat-music-share-body">
                <div className="chat-music-share-cover">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--c-music-accent, #7c9a92)" strokeWidth="1.2">
                        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                    </svg>
                </div>
                <div className="chat-music-share-info">
                    <div className="chat-music-share-title">{title}</div>
                    {artist && <div className="chat-music-share-artist">{artist}</div>}
                </div>
            </div>
            <div className="chat-music-share-footer">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                <span>音乐</span>
            </div>
        </div>
    );
}

// ── Xiaohongshu Share Bubble ──────────────────────────

function XiaohongshuShareBubble({ msg }: { msg: ChatMessage }) {
    const data = msg.mediaData;
    const title = data?.xiaohongshuTitle || "小红书帖子";
    const author = data?.xiaohongshuAuthor || "小红书用户";
    const body = data?.xiaohongshuBody || "";
    const description = data?.xiaohongshuDescription || "";
    const tags = data?.xiaohongshuTags || [];
    const coverIcon = data?.xiaohongshuCoverIcon || (data?.xiaohongshuNoteType === "video" ? "▶" : "小");
    const [imageUrl, setImageUrl] = useState<string>("");

    useEffect(() => {
        let cancelled = false;
        const assetId = data?.xiaohongshuImageAssetId;
        if (!assetId) {
            setImageUrl("");
            return;
        }
        getChatImageFromIndexedDB(assetId)
            .then((url) => {
                if (!cancelled) setImageUrl(url || "");
            })
            .catch(() => {
                if (!cancelled) setImageUrl("");
            });
        return () => {
            cancelled = true;
        };
    }, [data?.xiaohongshuImageAssetId]);

    return (
        <div className="chat-xhs-share-card">
            <div className="chat-xhs-share-head">
                <span className="chat-xhs-share-mark">RED</span>
                <span>{data?.xiaohongshuNoteType === "video" ? "视频帖子" : "小红书帖子"}</span>
            </div>
            <div className="chat-xhs-share-body">
                <div className={`chat-xhs-share-cover chat-xhs-share-cover--${data?.xiaohongshuTone || "blush"}`}>
                    {imageUrl ? <img src={imageUrl} alt="" /> : <span>{coverIcon}</span>}
                </div>
                <div className="chat-xhs-share-info">
                    <div className="chat-xhs-share-title">{title}</div>
                    <div className="chat-xhs-share-author">{author}</div>
                    <div className="chat-xhs-share-desc">{description || body}</div>
                </div>
            </div>
            {tags.length > 0 ? (
                <div className="chat-xhs-share-tags">
                    {tags.slice(0, 3).map(tag => <span key={tag}>#{tag}</span>)}
                </div>
            ) : null}
        </div>
    );
}

// ── Voice Message ───────────────────────────────
function VoiceMessageBubble({ msg, characterId, onUpdate, defaultTranslationExpanded = false }: { msg: ChatMessage; characterId?: string; onUpdate?: (m: ChatMessage) => void; defaultTranslationExpanded?: boolean }) {
    const [playing, setPlaying] = useState(false);
    const [synthesizing, setSynthesizing] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const text = msg.mediaData?.label || "语音消息";
    const bilingual = splitBilingualText(text);
    const speechText = bilingual?.original || text;
    const synthesizedFromText = msg.mediaData?.synthesizedFromText;
    const needsResynthesis = msg.role !== "user" && synthesizedFromText !== speechText;
    const duration = msg.mediaData?.voiceDuration || Math.max(2, Math.ceil(speechText.length / 4));

    // Auto-synthesize on mount if no audio yet (AI messages)
    useEffect(() => {
        if ((msg.mediaUrl && !needsResynthesis) || msg.role === "user" || synthesizing) return;
        if (!characterId) return;
        let cancelled = false;
        setSynthesizing(true);
        (async () => {
            try {
                const { resolveVoiceConfig, synthesizeSpeech } = await import("@/lib/tts-service");
                const vc = resolveVoiceConfig(characterId);
                if (!vc || cancelled) { setSynthesizing(false); return; }
                const blob = await synthesizeSpeech(speechText, vc);
                if (cancelled || !blob) { setSynthesizing(false); return; }
                // Convert to base64 data URL and persist
                const reader = new FileReader();
                reader.onload = () => {
                    if (cancelled) return;
                    const dataUrl = reader.result as string;
                    const nextMediaData = { ...msg.mediaData, synthesizedFromText: speechText };
                    updateMessageMediaData(msg.id, nextMediaData);
                    updateMessageMediaUrl(msg.id, dataUrl);
                    if (onUpdate) onUpdate({ ...msg, mediaUrl: dataUrl, mediaData: nextMediaData });
                    setSynthesizing(false);
                };
                reader.readAsDataURL(blob);
            } catch { if (!cancelled) setSynthesizing(false); }
        })();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [msg.id, msg.mediaUrl, msg.mediaData, characterId, needsResynthesis, speechText]);

    const handlePlay = () => {
        if (synthesizing || needsResynthesis) return;
        if (playing && audioRef.current) {
            const active = audioRef.current;
            audioRef.current = null;
            try { active.pause(); active.removeAttribute("src"); active.load(); } catch { /* ignore */ }
            setPlaying(false);
            return;
        }
        const src = msg.mediaUrl;
        if (!src) return;
        // 必须用 <audio> 元素:iOS 静音拨键会掐掉 Web Audio 的输出(表现为全线
        // 无声),媒体元素不受影响。元素属于宿主页面,锁屏媒体卡片指向站点本身,
        // 点了只会回到 App;播完清 src 让卡片立即撤下。
        const audio = new Audio(src);
        audioRef.current = audio;
        setPlaying(true);
        const finalize = () => {
            if (audioRef.current === audio) audioRef.current = null;
            try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { /* ignore */ }
            setPlaying(false);
        };
        audio.onended = finalize;
        audio.onerror = finalize;
        audio.play().catch(finalize);
    };

    useEffect(() => () => { audioRef.current?.pause(); }, []);

    // Wave bars — slightly irregular heights so the idle state already looks intentional.
    const barCount = Math.min(Math.max(4, Math.round(duration / 2)), 9);
    const barHeights = Array.from({ length: barCount }, (_, i) => {
        const center = (barCount - 1) / 2;
        const dist = Math.abs(i - center);
        return Math.max(6, Math.round(15 - dist * 2.2));
    });

    return (
        <div className="voice-msg-bubble" onClick={handlePlay}
            style={{ minWidth: `${Math.min(60 + duration * 8, 220)}px` }}
        >
            <div className="voice-msg-icon-shell">
                <div className="voice-msg-icon">
                {synthesizing ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" /></svg>
                ) : playing ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                )}
                </div>
            </div>
            <div className="voice-msg-bars" {...(playing ? { "data-playing": "" } : {})}>
                {barHeights.map((height, i) => (
                    <div
                        key={i}
                        className="voice-msg-bar"
                        style={{ height: `${height}px`, animationDelay: `${i * 0.08}s` }}
                    />
                ))}
            </div>
            <span className="voice-msg-dur">{duration}&quot;</span>
        </div>
    );
}
