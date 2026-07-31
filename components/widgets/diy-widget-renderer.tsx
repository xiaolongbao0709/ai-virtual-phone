import { useEffect, useState, useRef } from "react";
import type { WidgetInstance, DIYWidgetTemplate } from "@/lib/widget-types";
import { getThemeAssetMap } from "@/lib/theme-storage";

type Props = {
  widget: WidgetInstance;
  preview?: boolean;
  template: DIYWidgetTemplate;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
};

const CODE_WIDGET_BRIDGE_SOURCE = "ai-phone-diy-widget";

/** 注入 iframe 文档的守护样式：iframe 是独立文档，宿主工作区的 user-select:none
 *  管不进来——不禁掉的话长按组件文字会选中并呼出系统菜单，打断长按拖拽。
 *  需要可选文本的元素用 input/textarea/[contenteditable]/[data-selectable] 豁免。 */
export const DIY_WIDGET_GUARD_STYLE = `<style>
:root { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
input, textarea, [contenteditable], [data-selectable] {
  -webkit-user-select: auto;
  user-select: auto;
  -webkit-touch-callout: default;
}
</style>`;

function inlineJson(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? "null")
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  } catch {
    return "null";
  }
}

function injectCodeWidgetBridge(html: string, widgetId: string, config: Record<string, unknown> | undefined): string {
  const bridge = `${DIY_WIDGET_GUARD_STYLE}<script>
(function(){
  var SOURCE = ${inlineJson(CODE_WIDGET_BRIDGE_SOURCE)};
  var HOST_SOURCE = SOURCE + "-host";
  var widgetId = ${inlineJson(widgetId)};
  var initialConfig = ${inlineJson(config || {})};
  var MAX_IMAGE_DIMENSION = 1000;
  var INLINE_IMAGE_LIMIT = 1500000;
  var IMAGE_QUALITY = 0.86;

  function isObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    try { return JSON.parse(JSON.stringify(value || {})); } catch (_) { return {}; }
  }

  function getOwn(object, key, fallback) {
    return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : fallback;
  }

  function normalizePatch(patch) {
    if (!isObject(patch)) return {};
    var out = {};
    Object.keys(patch).forEach(function(key) {
      if (typeof key !== "string" || key.length === 0 || key.length > 100) return;
      out[key] = patch[key];
    });
    return out;
  }

  function resolveElement(target) {
    if (!target) return null;
    if (typeof target === "string") {
      try { return document.querySelector(target); } catch (_) { return null; }
    }
    return target.nodeType === 1 ? target : null;
  }

  function applyImage(target, dataUrl) {
    var el = resolveElement(target);
    if (!el || typeof dataUrl !== "string" || !dataUrl) return;
    if (String(el.tagName || "").toLowerCase() === "img") {
      el.src = dataUrl;
      if (el.style && el.style.display === "none") el.style.display = "block";
    } else if (el.style) {
      el.style.backgroundImage = "url(" + JSON.stringify(dataUrl) + ")";
      if (!el.style.backgroundSize) el.style.backgroundSize = "cover";
      if (!el.style.backgroundPosition) el.style.backgroundPosition = "center";
    }
  }

  function inferImageKey(input, index) {
    return input.getAttribute("data-ai-phone-config-key")
      || input.getAttribute("data-config-key")
      || input.getAttribute("data-persist-key")
      || input.getAttribute("name")
      || input.id
      || (index === 0 ? "imageDataUrl" : "imageDataUrl" + (index + 1));
  }

  function resolveImageTarget(input, key) {
    var selector = input.getAttribute("data-ai-phone-target")
      || input.getAttribute("data-target")
      || input.getAttribute("data-preview-target");
    var target = resolveElement(selector);
    if (target) return target;

    if (input.id) {
      try {
        target = document.querySelector("#" + input.id + "-preview, #preview-" + input.id + ", [data-for='" + input.id.replace(/'/g, "\\\\'") + "']");
        if (target) return target;
      } catch (_) {}
    }

    try {
      target = document.querySelector("[data-ai-phone-image='" + String(key).replace(/'/g, "\\\\'") + "'], [data-persist-key='" + String(key).replace(/'/g, "\\\\'") + "']");
      if (target) return target;
    } catch (_) {}

    var host = input.closest && (input.closest("[data-image-upload]") || input.closest("[data-ai-phone-upload]"));
    if (!host) host = input.parentElement;
    if (host) {
      target = host.querySelector("img, [data-ai-phone-image], [data-image-preview], .image-preview, .preview");
      if (target) return target;
    }

    return document.querySelector("img, [data-ai-phone-image], [data-image-preview], .image-preview, .preview");
  }

  function readImageFile(file, callback) {
    if (!file || !/^image\\//i.test(file.type || "")) return;
    var reader = new FileReader();
    reader.onload = function() {
      var raw = String(reader.result || "");
      var image = new Image();
      image.onload = function() {
        try {
          var width = image.naturalWidth || image.width;
          var height = image.naturalHeight || image.height;
          if (!width || !height) {
            callback(raw);
            return;
          }
          if (Math.max(width, height) <= MAX_IMAGE_DIMENSION && raw.length <= INLINE_IMAGE_LIMIT) {
            callback(raw);
            return;
          }
          var scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          var ctx = canvas.getContext("2d");
          if (!ctx) {
            callback(raw);
            return;
          }
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          var outputType = /^image\\/png$/i.test(file.type || "") ? "image/png" : "image/jpeg";
          callback(outputType === "image/jpeg"
            ? canvas.toDataURL(outputType, IMAGE_QUALITY)
            : canvas.toDataURL(outputType));
        } catch (_) {
          callback(raw);
        }
      };
      image.onerror = function() { callback(raw); };
      image.src = raw;
    };
    reader.readAsDataURL(file);
  }

  function normalizeImageDataUrl(dataUrl, callback) {
    if (typeof dataUrl !== "string" || !/^data:image\\//i.test(dataUrl)) {
      callback(dataUrl);
      return;
    }
    if (/^data:image\\/(gif|svg\\+xml)/i.test(dataUrl)) {
      callback(dataUrl);
      return;
    }
    var image = new Image();
    image.onload = function() {
      try {
        var width = image.naturalWidth || image.width;
        var height = image.naturalHeight || image.height;
        if (!width || !height) {
          callback(dataUrl);
          return;
        }
        if (Math.max(width, height) <= MAX_IMAGE_DIMENSION && dataUrl.length <= INLINE_IMAGE_LIMIT) {
          callback(dataUrl);
          return;
        }
        var scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        var ctx = canvas.getContext("2d");
        if (!ctx) {
          callback(dataUrl);
          return;
        }
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        callback(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
      } catch (_) {
        callback(dataUrl);
      }
    };
    image.onerror = function() { callback(dataUrl); };
    image.src = dataUrl;
  }

  function saveConfig(patch) {
    var cleanPatch = normalizePatch(patch);
    var keys = Object.keys(cleanPatch);
    if (keys.length === 0) return;
    keys.forEach(function(key) { api.config[key] = cleanPatch[key]; });
    parent.postMessage({ source: SOURCE, type: "saveConfig", widgetId: widgetId, patch: cleanPatch }, "*");
  }

  function bindImageUpload(input, target, key) {
    var inputEl = resolveElement(input);
    if (!inputEl) return null;
    var configKey = key || inferImageKey(inputEl, 0);
    var targetEl = resolveElement(target) || resolveImageTarget(inputEl, configKey);
    var saved = getOwn(api.config, configKey, null);
    if (typeof saved === "string") applyImage(targetEl, saved);
    var onChange = function() {
      var file = inputEl.files && inputEl.files[0];
      readImageFile(file, function(dataUrl) {
        var patch = {};
        patch[configKey] = dataUrl;
        saveConfig(patch);
        applyImage(targetEl || resolveImageTarget(inputEl, configKey), dataUrl);
      });
    };
    inputEl.addEventListener("change", onChange);
    return function() { inputEl.removeEventListener("change", onChange); };
  }

  var api = window.AiPhoneWidget || {};
  api.id = widgetId;
  api.config = clone(initialConfig);
  api.getConfig = function(key, fallback) { return getOwn(api.config, key, fallback); };
  api.saveConfig = saveConfig;
  api.setConfig = function(key, value) {
    if (typeof key !== "string") return;
    var patch = {};
    patch[key] = value;
    saveConfig(patch);
  };
  api.getImage = function(key, fallback) {
    if (typeof key !== "string") return fallback || "";
    var value = getOwn(api.config, key, null);
    return typeof value === "string" ? value : (fallback || "");
  };
  api.setImage = function(key, value) {
    if (typeof key !== "string" || typeof value !== "string") return;
    normalizeImageDataUrl(value, function(dataUrl) {
      var patch = {};
      patch[key] = dataUrl;
      saveConfig(patch);
      var target = null;
      try { target = document.querySelector("[data-ai-phone-image='" + key.replace(/'/g, "\\\\'") + "'], [data-persist-key='" + key.replace(/'/g, "\\\\'") + "']"); } catch (_) {}
      applyImage(target, dataUrl);
    });
  };
  api.bindImageUpload = bindImageUpload;
  window.AiPhoneWidget = api;

  function autoWireImageUploads() {
    var inputs = Array.prototype.slice.call(document.querySelectorAll("input[type='file']"));
    inputs.forEach(function(input, index) {
      var accept = input.getAttribute("accept") || "";
      if (accept && accept.indexOf("image") === -1 && accept.indexOf("*") === -1) return;
      if (input.__aiPhoneWidgetImageBound) return;
      input.__aiPhoneWidgetImageBound = true;
      bindImageUpload(input, null, inferImageKey(input, index));
    });
  }

  function start() {
    autoWireImageUploads();
    setTimeout(autoWireImageUploads, 100);
    setTimeout(autoWireImageUploads, 1000);
  }

  // 安卓长按会走 contextmenu 呼出系统菜单，同样会打断宿主的长按拖拽
  document.addEventListener("contextmenu", function(event) {
    var target = event.target;
    if (target && target.closest && target.closest("input, textarea, [contenteditable], [data-selectable]")) return;
    event.preventDefault();
  }, true);

  // 长按进入桌面编辑态：指针事件被本 iframe 吃掉、宿主检测不到长按，
  // 这里代为检测（500ms 内位移 <10px），命中后通知宿主。
  // 输入/可选中元素与标了 data-no-longpress 的交互区不参与。
  var lpTimer = null;
  var lpX = 0;
  var lpY = 0;
  function cancelLongPress() {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  }
  document.addEventListener("pointerdown", function(event) {
    var target = event.target;
    if (target && target.closest && target.closest("input, textarea, [contenteditable], [data-selectable], [data-no-longpress]")) return;
    lpX = event.clientX;
    lpY = event.clientY;
    cancelLongPress();
    lpTimer = setTimeout(function() {
      lpTimer = null;
      parent.postMessage({ source: SOURCE, type: "longPress", widgetId: widgetId }, "*");
    }, 500);
  }, true);
  document.addEventListener("pointermove", function(event) {
    if (!lpTimer) return;
    if (Math.abs(event.clientX - lpX) > 10 || Math.abs(event.clientY - lpY) > 10) cancelLongPress();
  }, true);
  document.addEventListener("pointerup", cancelLongPress, true);
  document.addEventListener("pointercancel", cancelLongPress, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("message", function(event) {
    var data = event.data || {};
    if (data.source !== HOST_SOURCE || data.type !== "config" || data.widgetId !== widgetId || !isObject(data.config)) return;
    api.config = clone(data.config);
    setTimeout(autoWireImageUploads, 0);
  });
})();
<\/script>`;

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${bridge}`);
  }
  if (/<body[\s>]/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>${bridge}`);
  }
  return `${bridge}${html}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSerializableWidgetConfigValue(value: unknown, depth = 0): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.length <= 8_000_000;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (depth >= 4) return false;
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => isSerializableWidgetConfigValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    return entries.length <= 100 && entries.every(([key, item]) =>
      key.length <= 100 && isSerializableWidgetConfigValue(item, depth + 1)
    );
  }
  return false;
}

function sanitizeWidgetConfigPatch(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  const patch: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 100) continue;
    if (!isSerializableWidgetConfigValue(item)) continue;
    patch[key] = item;
  }
  return patch;
}

/** Picker preview for code widgets: real iframe, lazily mounted on first scroll into view. */
function DIYCodePreview({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || mounted) return;
    if (typeof IntersectionObserver === "undefined") { setMounted(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setMounted(true);
        observer.disconnect();
      }
    }, { rootMargin: "100px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted]);

  return (
    <div ref={hostRef} className="w-full h-full relative rounded-[18px] overflow-hidden">
      {mounted ? (
        <iframe
          srcDoc={html}
          sandbox="allow-scripts"
          className="w-full h-full border-none"
          style={{ pointerEvents: "none" }}
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center"
          style={{
            background: "linear-gradient(135deg, #232838, #12151d)",
            color: "rgba(255,255,255,0.62)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: "calc(22px*var(--app-text-scale,1))",
            letterSpacing: "0.12em",
          }}
        >
          &lt;/&gt;
        </div>
      )}
    </div>
  );
}

export function DIYWidgetRenderer({ widget, preview, template, onConfigChange }: Props) {
  if (template.mode === "code") {
    // In the widget picker we render many candidates at once; mounting a live
    // <iframe> per code widget eagerly would spin up a browsing context each and
    // stall the tab. Preview therefore lazy-mounts the real iframe only when the
    // card scrolls into view (placeholder until then) — true-to-life preview,
    // but only the on-screen few ever load.
    if (preview) {
      return <DIYCodePreview html={template.htmlString || ""} />;
    }
    return <DIYCodeWidgetFrame widget={widget} template={template} onConfigChange={onConfigChange} />;
  }

  return <DIYImageWidgetFrame widget={widget} preview={preview} template={template} onConfigChange={onConfigChange} />;
}

function DIYCodeWidgetFrame({ widget, template, onConfigChange }: Omit<Props, "preview">) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [srcDoc, setSrcDoc] = useState(() =>
    injectCodeWidgetBridge(template.htmlString || "", widget.id, widget.config)
  );

  useEffect(() => {
    setSrcDoc(injectCodeWidgetBridge(template.htmlString || "", widget.id, widget.config));
  }, [template.htmlString, widget.id]);

  useEffect(() => {
    const iframeWindow = iframeRef.current?.contentWindow;
    if (!iframeWindow) return;
    iframeWindow.postMessage({
      source: `${CODE_WIDGET_BRIDGE_SOURCE}-host`,
      type: "config",
      widgetId: widget.id,
      config: widget.config || {},
    }, "*");
  }, [widget.id, widget.config]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!isPlainObject(data)) return;
      if (data.source !== CODE_WIDGET_BRIDGE_SOURCE || data.type !== "saveConfig") return;
      if (data.widgetId !== widget.id) return;
      if (iframeRef.current?.contentWindow && event.source !== iframeRef.current.contentWindow) return;
      const patch = sanitizeWidgetConfigPatch(data.patch);
      if (Object.keys(patch).length === 0) return;
      onConfigChange?.(widget.id, patch);
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onConfigChange, widget.id]);

  return (
    <div className="w-full h-full relative rounded-[18px] overflow-hidden" style={{ pointerEvents: 'auto' }}>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        className="w-full h-full border-none"
      />
    </div>
  );
}

function DIYImageWidgetFrame({ widget, preview, template, onConfigChange }: Props) {
  const [bgUrl, setBgUrl] = useState<string | null>(null);

  useEffect(() => {
    if (template.bgAssetId) {
      getThemeAssetMap([template.bgAssetId]).then(m => {
        if (m[template.bgAssetId!]) setBgUrl(m[template.bgAssetId!]);
      });
    }
  }, [template.bgAssetId]);

  return (
    <div 
      className="w-full h-full relative" 
      style={{ 
        pointerEvents: preview ? 'none' : 'auto'
      }}
    >
      {/* Slots form the base layer (photos) */}
      <div className="absolute inset-0 z-0">
        {template.slots?.map(slot => (
          <DIYImageSlot key={slot.id} widget={widget} slotId={slot.id} top={slot.top} bottom={slot.bottom} left={slot.left} right={slot.right} preview={preview} onConfigChange={onConfigChange} />
        ))}
      </div>
      
      {/* Background sticker forms the top layer with holes */}
      <div 
        className="absolute inset-0 z-10 pointer-events-none"
        style={{
          backgroundImage: bgUrl ? `url('${bgUrl}')` : 'none', 
          backgroundSize: 'cover', 
          backgroundPosition: 'center',
        }}
      />
    </div>
  );
}

function DIYImageSlot({ 
  widget, slotId, top, bottom, left, right, preview, onConfigChange 
}: { 
  widget: WidgetInstance, slotId: string, top: number, bottom: number, left: number, right: number, preview?: boolean, onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void 
}) {
  const configKey = `img-${slotId}`;
  const imageUrl = typeof widget.config?.[configKey] === "string" ? widget.config[configKey] : null;

  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleClick() {
    fileInputRef.current?.click();
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new globalThis.Image();
      img.onload = () => {
        const maxDim = 800;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          onConfigChange?.(widget.id, { [configKey]: dataUrl });
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  return (
    <div 
      className="absolute flex items-center justify-center overflow-hidden" 
      style={{ top: `${top}%`, bottom: `${bottom}%`, left: `${left}%`, right: `${right}%` }}
    >
      <div
        className={`w-full h-full ${!preview && !imageUrl ? "bg-black/10 backdrop-blur-sm" : ""} ${!preview ? "cursor-pointer" : ""}`}
        onClick={preview ? undefined : handleClick}
        style={{
          backgroundImage: imageUrl ? `url('${imageUrl}')` : 'none',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
      {!preview && <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFile} />}
    </div>
  );
}
