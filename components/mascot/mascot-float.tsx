"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  getMascotState,
  isMascotPanelOpen,
  getMascotWidgetRect,
  subscribeMascot,
  MASCOT_TRANSITION_MS,
  toggleMascotPanel,
  closeMascotPanel,
  deactivateMascot,
} from "@/lib/mascot-state";
import { getMascotContext, subscribeMascotContext } from "@/lib/mascot-context";
import { mascotNavigate, DIY_WIDGET_PREVIEW_EVENT, type DiyWidgetPreviewEventDetail, type DiyWidgetPreviewRequest } from "@/lib/mascot-events";
import { DIY_WIDGET_GUARD_STYLE } from "@/components/widgets/diy-widget-renderer";
import {
  clearMascotToolHistoryMessages,
  deleteMascotMessageWithLinkedTools,
  getMascotChatSnapshot,
  hasMascotToolHistoryMessages,
  hydrateMascotChat,
  resetMascotConversation,
  sendMascotMessage,
  setMascotMessages,
  stopMascotGeneration,
  subscribeMascotChat,
} from "@/lib/mascot-chat-store";
import {
  getMascotSettingsSnapshot,
  resolveMascotImageRef,
  subscribeMascotSettings,
} from "@/lib/mascot-settings";
import type { MascotMsg } from "@/lib/mascot-engine";
import {
  NINE_SLICE_CALIBRATION_EVENT,
  type NineSliceCalibrationEventDetail,
  type NineSliceValues,
} from "@/lib/css-asset-tools";


/**
 * Global mascot floating ball + panel.
 * Context-driven: auto-adapts UI based on current page context.
 */
const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i;
const MASCOT_FLOAT_WIDTH = 56;
const MASCOT_FLOAT_HEIGHT = 64;
const MASCOT_FLOAT_RIGHT = 6;
const MASCOT_FLOAT_BOTTOM = 112;

function isLikelyImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_FILE_EXT_RE.test(file.name) || !file.type;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

function isHiddenMascotPlaceholder(msg: MascotMsg): boolean {
  return msg.role === "mascot" && !!msg.displayText && /^（(调用工具中|无内容)/.test(msg.displayText);
}

function getMascotMessageText(msg: MascotMsg): string {
  return msg.displayText || msg.text || "";
}

function copyTextToClipboard(text: string): void {
  const fallbackCopy = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 从既有 display/slice 反推一个统一缩放比（百分比），作为滑块初值。 */
function initialScalePct(v: NineSliceValues): number {
  const ratios = [
    v.displayTop / v.sliceTop,
    v.displayRight / v.sliceRight,
    v.displayBottom / v.sliceBottom,
    v.displayLeft / v.sliceLeft,
  ].filter((r) => Number.isFinite(r) && r > 0);
  if (!ratios.length) return 30;
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return clampNumber(avg * 100, 1, 100);
}

/** 把初值的 display 归一化成统一缩放，避免一打开就显示成四边不同倍率的变形效果。 */
function normalizeInitial(v: NineSliceValues): NineSliceValues {
  const pctValue = initialScalePct(v);
  const apply = (slice: number) => clampNumber((slice * pctValue) / 100, 1, 140);
  return {
    ...v,
    displayTop: apply(v.sliceTop),
    displayRight: apply(v.sliceRight),
    displayBottom: apply(v.sliceBottom),
    displayLeft: apply(v.sliceLeft),
  };
}

type NineSliceSliderKey =
  | "sliceTop"
  | "sliceRight"
  | "sliceBottom"
  | "sliceLeft"
  | "paddingTop"
  | "paddingRight"
  | "paddingBottom"
  | "paddingLeft";

type NineSliceStep = 1 | 2 | 3;

/** DIY 组件预览尺寸（与组件挑选器 preview 像素一致） */
const DIY_PREVIEW_SIZE_PX: Record<string, [number, number]> = {
  "1x1": [70, 62], "1x2": [148, 62], "1x4": [320, 58],
  "2x1": [70, 160], "2x2": [148, 160], "2x3": [234, 160], "2x4": [320, 160],
  "3x2": [148, 258], "3x3": [234, 258], "3x4": [320, 258],
  "4x2": [148, 356], "4x3": [234, 356], "4x4": [320, 356],
  "5x4": [320, 454], "6x4": [320, 552],
};

function DiyWidgetPreviewDialog({ request, onClose }: { request: DiyWidgetPreviewRequest; onClose: () => void }) {
  const [w, h] = DIY_PREVIEW_SIZE_PX[request.size] || [320, 258];
  const scale = Math.min(1, 300 / w, 430 / h);
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 4000, background: "rgba(10,10,14,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        style={{ background: "#1c1d24", borderRadius: 18, padding: "14px 16px 16px", maxWidth: "88vw", boxShadow: "0 18px 48px rgba(0,0,0,0.45)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 12 }}>
          <span style={{ color: "#f2f2f5", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            组件预览 · {request.name}（{request.size}）
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 0, background: "rgba(255,255,255,0.12)", color: "#fff", borderRadius: 10, padding: "4px 12px", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", flex: "0 0 auto" }}
          >
            关闭
          </button>
        </div>
        <div style={{ width: w * scale, height: h * scale, margin: "0 auto", borderRadius: 18, overflow: "hidden", background: "rgba(255,255,255,0.06)" }}>
          <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "top left" }}>
            <iframe
              srcDoc={DIY_WIDGET_GUARD_STYLE + request.htmlString}
              sandbox="allow-scripts"
              style={{ width: "100%", height: "100%", border: "none", display: "block", background: "transparent" }}
              title="DIY 组件预览"
            />
          </div>
        </div>
        <div style={{ color: "rgba(255,255,255,0.45)", fontSize: "calc(10.5px*var(--app-text-scale,1))", textAlign: "center", marginTop: 8 }}>
          预览为沙箱渲染，配置不会保存
        </div>
      </div>
    </div>
  );
}

function NineSliceCalibrationDialog({
  detail,
  onClose,
}: {
  detail: NineSliceCalibrationEventDetail;
  onClose: () => void;
}) {
  const { request } = detail;
  const width = Math.max(1, Math.round(request.width || 1));
  const height = Math.max(1, Math.round(request.height || 1));
  const [values, setValues] = useState<NineSliceValues>(() => normalizeInitial(request.initial));
  const [imageUrl, setImageUrl] = useState("");
  const [sampleText, setSampleText] = useState("一行文字");
  const [step, setStep] = useState<NineSliceStep>(1);
  const editableTextRef = useRef<HTMLSpanElement | null>(null);
  // 统一缩放比：display = slice × scale（四边同一倍率，装饰不变形）。
  const [scalePct, setScalePct] = useState(() => initialScalePct(request.initial));

  const pct = (value: number, total: number) =>
    Math.min(100, Math.max(0, (value / Math.max(1, total)) * 100));

  const displayFor = (sliceValue: number, percent = scalePct) =>
    clampNumber((sliceValue * percent) / 100, 1, 140);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { loadMediaObjectUrl } = await import("@/lib/media-cache-storage");
      const url = await loadMediaObjectUrl(request.mediaRef);
      if (!cancelled) setImageUrl(url || "");
    })();
    return () => { cancelled = true; };
  }, [request.mediaRef]);

  const setValue = (key: NineSliceSliderKey, raw: number) => {
    setValues((prev) => {
      const next = { ...prev };
      // 调整裁切线时，按统一缩放比同步该边的装饰显示宽度。
      if (key === "sliceTop") {
        next.sliceTop = clampNumber(raw, 1, height - prev.sliceBottom - 1);
        next.displayTop = displayFor(next.sliceTop);
      } else if (key === "sliceBottom") {
        next.sliceBottom = clampNumber(raw, 1, height - prev.sliceTop - 1);
        next.displayBottom = displayFor(next.sliceBottom);
      } else if (key === "sliceLeft") {
        next.sliceLeft = clampNumber(raw, 1, width - prev.sliceRight - 1);
        next.displayLeft = displayFor(next.sliceLeft);
      } else if (key === "sliceRight") {
        next.sliceRight = clampNumber(raw, 1, width - prev.sliceLeft - 1);
        next.displayRight = displayFor(next.sliceRight);
      } else if (key.startsWith("display")) {
        next[key] = clampNumber(raw, 1, 160) as never;
      } else {
        next[key] = clampNumber(raw, 0, 240) as never;
      }
      return next;
    });
  };

  const changeScale = (raw: number) => {
    const nextPct = clampNumber(raw, 1, 100);
    setScalePct(nextPct);
    setValues((prev) => ({
      ...prev,
      displayTop: displayFor(prev.sliceTop, nextPct),
      displayRight: displayFor(prev.sliceRight, nextPct),
      displayBottom: displayFor(prev.sliceBottom, nextPct),
      displayLeft: displayFor(prev.sliceLeft, nextPct),
    }));
  };

  const cancel = () => {
    detail.reject(new Error("用户取消了九宫格校准。"));
    onClose();
  };

  const confirm = () => {
    detail.resolve({
      ...values,
      minWidth: Math.max(1, values.displayLeft + values.displayRight),
      minHeight: Math.max(1, values.displayTop + values.displayBottom),
    });
    onClose();
  };

  const slider = (
    label: string,
    key: NineSliceSliderKey,
    max: number,
    min = 0,
  ) => (
    <div className="mascot-nine-slider">
      <span className="mascot-nine-slider-label">{label}</span>
      <input
        type="range"
        className="mascot-nine-range"
        min={min}
        max={Math.max(min, max)}
        value={values[key]}
        onChange={(event) => setValue(key, Number(event.target.value))}
      />
    </div>
  );

  const bubbleStyle = {
    "--mascot-nine-image": imageUrl ? `url("${imageUrl}")` : "none",
    "--mascot-nine-slice": `${values.sliceTop} ${values.sliceRight} ${values.sliceBottom} ${values.sliceLeft} fill`,
    "--mascot-nine-border": `${values.displayTop}px ${values.displayRight}px ${values.displayBottom}px ${values.displayLeft}px`,
    padding: `${values.paddingTop}px ${values.paddingRight}px ${values.paddingBottom}px ${values.paddingLeft}px`,
    minWidth: `${Math.max(1, values.displayLeft + values.displayRight)}px`,
    minHeight: `${Math.max(1, values.displayTop + values.displayBottom)}px`,
  } as React.CSSProperties;
  const finalPreviewZoom = 2;
  const finalBubbleStyle = {
    ...bubbleStyle,
    "--mascot-nine-border": `${values.displayTop * finalPreviewZoom}px ${values.displayRight * finalPreviewZoom}px ${values.displayBottom * finalPreviewZoom}px ${values.displayLeft * finalPreviewZoom}px`,
    "--mascot-nine-final-zoom": finalPreviewZoom,
    padding: `${values.paddingTop * finalPreviewZoom}px ${values.paddingRight * finalPreviewZoom}px ${values.paddingBottom * finalPreviewZoom}px ${values.paddingLeft * finalPreviewZoom}px`,
    minWidth: `${Math.max(1, values.displayLeft + values.displayRight) * finalPreviewZoom}px`,
    minHeight: `${Math.max(1, values.displayTop + values.displayBottom) * finalPreviewZoom}px`,
  } as React.CSSProperties;

  const safeStyle = {
    top: `${values.paddingTop}px`,
    right: `${values.paddingRight}px`,
    bottom: `${values.paddingBottom}px`,
    left: `${values.paddingLeft}px`,
  } as React.CSSProperties;

  const scaleRow = (
    <div className="mascot-nine-scalerow">
      <input
        type="range"
        className="mascot-nine-range"
        min={1}
        max={100}
        value={scalePct}
        onChange={(event) => changeScale(Number(event.target.value))}
      />
    </div>
  );

  // 底图按缩放真实放大缩小（1 源像素 = scale 屏幕像素），预览额外等比放大，便于看清和操作。
  const baseImgWidth = Math.max(1, Math.round((width * scalePct) / 100));
  const previewZoom = 3.4;
  const previewImgWidth = Math.max(1, Math.round(baseImgWidth * previewZoom));
  const stepTitle = step === 1 ? "整体缩放" : step === 2 ? "裁剪四角" : "文字留白";
  const stepHint = step === 1
    ? "只看一个字和底图的比例。先把整张气泡缩到和聊天字号匹配。"
    : step === 2
      ? "把圆角、尾巴、云朵等装饰放到虚线外侧；中间拉伸区尽量保持无装饰。"
      : "这里看最终效果。文字留白可以进入裁剪保护区，只要别压到装饰即可。";
  const previousStep = () => {
    if (step === 1) {
      cancel();
      return;
    }
    setStep(step === 3 ? 2 : 1);
  };
  const nextStep = () => {
    if (step === 3) {
      confirm();
      return;
    }
    setStep(step === 1 ? 2 : 3);
  };
  const sourcePreview = (
    <div className="mascot-nine-stage">
      {imageUrl ? (
        <div
          className="mascot-nine-imgwrap"
          style={{
            width: `${previewImgWidth}px`,
            "--mascot-nine-preview-zoom": previewZoom,
          } as React.CSSProperties}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="mascot-nine-img" src={imageUrl} alt="" draggable={false} />
          {step === 1 ? (
            <span className="mascot-nine-scale-word">字</span>
          ) : (
            <>
              <span
                className="mascot-nine-region"
                style={{
                  top: `${pct(values.sliceTop, height)}%`,
                  bottom: `${pct(values.sliceBottom, height)}%`,
                  left: `${pct(values.sliceLeft, width)}%`,
                  right: `${pct(values.sliceRight, width)}%`,
                }}
              >
                <span className="mascot-nine-region-label">中间无装饰</span>
              </span>
              <span className="mascot-nine-line mascot-nine-line-h" style={{ top: `${pct(values.sliceTop, height)}%` }} />
              <span className="mascot-nine-line mascot-nine-line-h" style={{ top: `${100 - pct(values.sliceBottom, height)}%` }} />
              <span className="mascot-nine-line mascot-nine-line-v" style={{ left: `${pct(values.sliceLeft, width)}%` }} />
              <span className="mascot-nine-line mascot-nine-line-v" style={{ left: `${100 - pct(values.sliceRight, width)}%` }} />
            </>
          )}
        </div>
      ) : (
        <div className="mascot-nine-loading">加载图片…</div>
      )}
    </div>
  );
  const finalPreview = (
    <div className="mascot-nine-result">
      <div className="mascot-nine-realrow">
        <div className="mascot-nine-real" style={finalBubbleStyle}>
          <span
            ref={editableTextRef}
            className="mascot-nine-editable-text"
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            role="textbox"
            aria-label="气泡预览文字"
            onInput={(event) => setSampleText(event.currentTarget.textContent || "")}
            onFocus={(event) => {
              if (event.currentTarget.textContent === "一行文字") {
                event.currentTarget.textContent = "";
                setSampleText("");
              }
            }}
            onBlur={(event) => {
              if (!event.currentTarget.textContent?.trim()) {
                event.currentTarget.textContent = "一行文字";
                setSampleText("一行文字");
              }
            }}
          >
            {sampleText || "一行文字"}
          </span>
          <span className="mascot-nine-safe" style={safeStyle} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="mascot-nine-overlay" role="dialog" aria-modal="true" onContextMenu={(event) => event.preventDefault()}>
      <div className="mascot-nine-dialog">
        <div className="mascot-nine-head">
          <div>
            <div className="mascot-nine-title">校准九宫格气泡</div>
            <div className="mascot-nine-sub">{request.label} · {width}×{height}</div>
          </div>
          <button type="button" onClick={cancel} className="mascot-nine-close" aria-label="关闭">×</button>
        </div>

        <div className="mascot-nine-progress" aria-label="校准步骤">
          <button type="button" className={`mascot-nine-chip ${step === 1 ? "is-active" : ""}`} onClick={() => setStep(1)}>1 缩放</button>
          <button type="button" className={`mascot-nine-chip ${step === 2 ? "is-active" : ""}`} onClick={() => setStep(2)}>2 裁剪</button>
          <button type="button" className={`mascot-nine-chip ${step === 3 ? "is-active" : ""}`} onClick={() => setStep(3)}>3 留白</button>
        </div>

        <div className="mascot-nine-step">
          <span className="mascot-nine-stepnum">{step}</span>
          <div className="mascot-nine-steptitle">{stepTitle}</div>
          {step === 1 ? <span className="mascot-nine-stepval">{scalePct}%</span> : null}
        </div>
        <p className="mascot-nine-hint">{stepHint}</p>

        {step === 1 ? (
          <>
            {sourcePreview}
            {scaleRow}
          </>
        ) : null}

        {step === 2 ? (
          <>
            {sourcePreview}
            <div className="mascot-nine-sliders">
              {slider("上", "sliceTop", height - values.sliceBottom - 1, 1)}
              {slider("下", "sliceBottom", height - values.sliceTop - 1, 1)}
              {slider("左", "sliceLeft", width - values.sliceRight - 1, 1)}
              {slider("右", "sliceRight", width - values.sliceLeft - 1, 1)}
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            {finalPreview}
            <div className="mascot-nine-sliders">
              {slider("上", "paddingTop", 240)}
              {slider("下", "paddingBottom", 240)}
              {slider("左", "paddingLeft", 240)}
              {slider("右", "paddingRight", 240)}
            </div>
          </>
        ) : null}

        <div className="mascot-nine-actions">
          <button type="button" className="mascot-nine-btn" onClick={previousStep}>{step === 1 ? "取消" : "上一步"}</button>
          <button type="button" className="mascot-nine-btn mascot-nine-btn-primary" onClick={nextStep}>{step === 3 ? "确认校准" : "下一步"}</button>
        </div>
      </div>
    </div>
  );
}

export function MascotFloat() {
  const state = useSyncExternalStore(subscribeMascot, getMascotState, () => "widget" as const);
  const panelOpen = useSyncExternalStore(subscribeMascot, isMascotPanelOpen, () => false);
  const widgetRect = useSyncExternalStore(subscribeMascot, getMascotWidgetRect, () => null);
  const context = useSyncExternalStore(subscribeMascotContext, getMascotContext, () => getMascotContext());

  const [floatPos, setFloatPos] = useState<{ left: number; top: number } | null>(null);
  const floatPosRef = useRef<{ left: number; top: number } | null>(null);
  const dragState = useRef<{ startX: number; startY: number; startLeft: number; startTop: number; moved: boolean } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);
  const floatRef = useRef<HTMLDivElement>(null);
  const [animStyle, setAnimStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    floatPosRef.current = floatPos;
  }, [floatPos]);

  // Animate: widget → float (in) or float → widget (out)
  useLayoutEffect(() => {
    if (state !== "animating_in" && state !== "animating_out") return;
    const shell = document.querySelector("[data-ui='phone-screen']") as HTMLElement | null;
    const shellRect = shell?.getBoundingClientRect();
    const shellW = shellRect?.width ?? 390;
    const shellH = shellRect?.height ?? 844;
    const defaultFloatLeft = shellW - MASCOT_FLOAT_RIGHT - MASCOT_FLOAT_WIDTH;
    const defaultFloatTop = shellH - MASCOT_FLOAT_BOTTOM - MASCOT_FLOAT_HEIGHT;
    const currentFloatLeft = floatPosRef.current?.left ?? defaultFloatLeft;
    const currentFloatTop = floatPosRef.current?.top ?? defaultFloatTop;
    const shellLeft = shellRect?.left ?? 0;
    const shellTop = shellRect?.top ?? 0;

    if (!widgetRect) {
      setAnimStyle({});
      return;
    }

    const widgetLeft = widgetRect.left - shellLeft;
    const widgetTop = widgetRect.top - shellTop;
    const widgetCenter = {
      x: widgetLeft + widgetRect.width / 2,
      y: widgetTop + widgetRect.height / 2,
    };
    const scaleFromWidget = Math.min(3.2, Math.max(0.7, (widgetRect.height / MASCOT_FLOAT_HEIGHT) * 0.9));
    const transition = `transform ${MASCOT_TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${Math.min(220, MASCOT_TRANSITION_MS)}ms ease-out`;
    const transformFrom = (fromX: number, fromY: number, anchorLeft: number, anchorTop: number, scale: number) => {
      const anchorCenterX = anchorLeft + MASCOT_FLOAT_WIDTH / 2;
      const anchorCenterY = anchorTop + MASCOT_FLOAT_HEIGHT / 2;
      return `translate3d(${fromX - anchorCenterX}px, ${fromY - anchorCenterY}px, 0) scale(${scale})`;
    };

    if (state === "animating_in") {
      setFloatPos(null);
      setAnimStyle({
        position: "absolute",
        left: defaultFloatLeft,
        top: defaultFloatTop,
        width: MASCOT_FLOAT_WIDTH,
        height: MASCOT_FLOAT_HEIGHT,
        opacity: 0.9,
        transform: transformFrom(widgetCenter.x, widgetCenter.y, defaultFloatLeft, defaultFloatTop, scaleFromWidget),
        transition: "none",
        zIndex: 9999,
      });

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimStyle({
            position: "absolute",
            left: defaultFloatLeft,
            top: defaultFloatTop,
            width: MASCOT_FLOAT_WIDTH,
            height: MASCOT_FLOAT_HEIGHT,
            opacity: 1,
            transform: "translate3d(0, 0, 0) scale(1)",
            transition,
            zIndex: 9999,
          });
        });
      });
      return;
    }

    if (state === "animating_out") {
      setAnimStyle({
        position: "absolute",
        left: currentFloatLeft,
        top: currentFloatTop,
        width: MASCOT_FLOAT_WIDTH,
        height: MASCOT_FLOAT_HEIGHT,
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1)",
        transition: "none",
        zIndex: 9999,
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimStyle({
            position: "absolute",
            left: currentFloatLeft,
            top: currentFloatTop,
            width: MASCOT_FLOAT_WIDTH,
            height: MASCOT_FLOAT_HEIGHT,
            opacity: 0.18,
            transform: transformFrom(widgetCenter.x, widgetCenter.y, currentFloatLeft, currentFloatTop, scaleFromWidget),
            transition,
            zIndex: 9999,
          });
        });
      });
    }
  }, [state, widgetRect]);

  // Chat state
  const [chatInput, setChatInput] = useState("");
  const mascotChat = useSyncExternalStore(subscribeMascotChat, getMascotChatSnapshot, getMascotChatSnapshot);
  const mascotSettings = useSyncExternalStore(subscribeMascotSettings, getMascotSettingsSnapshot, getMascotSettingsSnapshot);
  const mascotDisplayName = mascotSettings.nickname || "AI助手";
  const mascotMessages = mascotChat.messages;
  const isThinking = mascotChat.isThinking;
  const [mascotAvatarUrl, setMascotAvatarUrl] = useState(mascotSettings.avatarImage || "/mascot.png");
  const [moduleDrawerOpen, setModuleDrawerOpen] = useState(false);
  // 待发送图片（media-store:// 引用列表）
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // ref → blob object URL 缓存，渲染预览用
  const [imagePreviewCache, setImagePreviewCache] = useState<Record<string, string>>({});
  const [nineSliceCalibration, setNineSliceCalibration] = useState<NineSliceCalibrationEventDetail | null>(null);
  const [diyWidgetPreview, setDiyWidgetPreview] = useState<DiyWidgetPreviewRequest | null>(null);
  const [activeMascotMessageIndex, setActiveMascotMessageIndex] = useState<number | null>(null);
  const msgLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgLongPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const msgLongPressTriggeredRef = useRef(false);
  const visibleMascotEntries = mascotMessages
    .map((msg, rawIndex) => ({ msg, rawIndex }))
    .filter(({ msg }) => !msg.hidden && !isHiddenMascotPlaceholder(msg));

  useEffect(() => {
    void hydrateMascotChat();
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveMascotImageRef(mascotSettings.avatarImage).then((url) => {
      if (!cancelled) setMascotAvatarUrl(url);
    });
    return () => { cancelled = true; };
  }, [mascotSettings.avatarImage]);

  /** 把 File 准备成小卷可读图片：最长边 1280；PNG/WebP 保留透明通道，JPEG 才转 JPEG。 */
  const compressImageToBlob = useCallback(async (file: File): Promise<Blob> => {
    const lowerName = file.name.toLowerCase();
    const sourceMime = file.type.toLowerCase()
      || (lowerName.endsWith(".png") ? "image/png" : lowerName.endsWith(".webp") ? "image/webp" : lowerName.endsWith(".gif") ? "image/gif" : "image/jpeg");
    if (sourceMime === "image/gif") return file;

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取失败"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("解码失败"));
        img.onload = () => {
          const maxSide = 1280;
          let { width, height } = img;
          if (width > maxSide || height > maxSide) {
            const scale = maxSide / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("canvas 不可用")); return; }
          ctx.drawImage(img, 0, 0, width, height);
          const outputMime = sourceMime === "image/png" || sourceMime === "image/webp" ? sourceMime : "image/jpeg";
          const quality = outputMime === "image/webp" ? 0.9 : outputMime === "image/jpeg" ? 0.82 : undefined;
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error("canvas 转 blob 失败"));
          }, outputMime, quality);
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const handlePickImages = useCallback(async (files: File[] | FileList | null) => {
    if (!files || files.length === 0) return;
    const pickedFiles = Array.from(files);
    const refs: string[] = [];
    const previews: Record<string, string> = {};
    for (const file of pickedFiles) {
      if (!isLikelyImageFile(file)) {
        console.warn("[Mascot] 文件 MIME 不像图片，仍按图片尝试处理:", file.type || "(empty)", file.name);
      }
      try {
        let blob: Blob = file;
        try {
          blob = await compressImageToBlob(file);
        } catch (e) {
          console.warn("[Mascot] 图片压缩失败，使用原图:", e);
        }
        const ref = await blobToDataUrl(blob);
        refs.push(ref);
        previews[ref] = ref;
      } catch (e) {
        console.warn("[Mascot] 图片处理失败:", e);
      }
    }
    if (refs.length > 0) {
      setImagePreviewCache((prev) => ({ ...prev, ...previews }));
      setPendingImages((prev) => [...prev, ...refs].slice(0, 4));
    }
  }, [compressImageToBlob]);

  // 缺失的预览懒加载：发现没缓存的 ref → 加载 blob → 生成 object URL
  useEffect(() => {
    const allRefs = new Set<string>();
    for (const m of mascotMessages) {
      if (m.images) for (const ref of m.images) allRefs.add(ref);
    }
    for (const ref of pendingImages) allRefs.add(ref);

    const missing = [...allRefs].filter((r) => !imagePreviewCache[r]);
    if (missing.length === 0) return;

    let cancelled = false;
    (async () => {
      const { loadMediaObjectUrl } = await import("@/lib/media-cache-storage");
      const updates: Record<string, string> = {};
      for (const ref of missing) {
        if (ref.startsWith("data:")) {
          updates[ref] = ref;
          continue;
        }
        const url = await loadMediaObjectUrl(ref);
        if (cancelled) return;
        if (url) updates[ref] = url;
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setImagePreviewCache((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => { cancelled = true; };
  }, [mascotMessages, pendingImages, imagePreviewCache]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NineSliceCalibrationEventDetail>).detail;
      if (!detail?.request || typeof detail.resolve !== "function" || typeof detail.reject !== "function") return;
      detail.handled = true;
      setNineSliceCalibration((current) => {
        if (current) current.reject(new Error("新的九宫格校准请求已打开，上一轮已取消。"));
        return detail;
      });
      if (!isMascotPanelOpen()) toggleMascotPanel();
    };
    window.addEventListener(NINE_SLICE_CALIBRATION_EVENT, handler);
    return () => window.removeEventListener(NINE_SLICE_CALIBRATION_EVENT, handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DiyWidgetPreviewEventDetail>).detail;
      if (!detail?.request) return;
      detail.handled = true;
      setDiyWidgetPreview(detail.request);
    };
    window.addEventListener(DIY_WIDGET_PREVIEW_EVENT, handler);
    return () => window.removeEventListener(DIY_WIDGET_PREVIEW_EVENT, handler);
  }, []);

  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Selected module from grid (shows teleport button before navigating)
  const MODULES = [
    { id: "characters", icon: "🎭", label: "角色卡" },
    { id: "worldbook", icon: "📖", label: "世界书" },
    { id: "regex", icon: "✨", label: "正则" },
    { id: "presets", icon: "🎨", label: "预设" },
    { id: "css", icon: "🖌️", label: "CSS" },
    { id: "new_session", icon: "🔄", label: "新会话" },
  ] as const;
  const [selectedModule, setSelectedModule] = useState<string | null>(null);

  // Worldbook confirmation state: show binding info before entering chat
  const [wbConfirmed, setWbConfirmed] = useState(false);
  // Reset confirmation when leaving worldbook page
  useEffect(() => {
    if (context.page !== "worldbook") setWbConfirmed(false);
  }, [context.page]);

  // Refresh worldbook context when panel opens (re-reads binding info)
  useEffect(() => {
    if (panelOpen && context.page === "worldbook") {
      window.dispatchEvent(new CustomEvent("worldbook-refresh-context"));
    }
  }, [panelOpen, context.page]);

  useEffect(() => {
    if (activeMascotMessageIndex === null) return;
    if (!mascotMessages[activeMascotMessageIndex]) setActiveMascotMessageIndex(null);
  }, [activeMascotMessageIndex, mascotMessages]);

  useEffect(() => {
    if (!isThinking) return;
    setActiveMascotMessageIndex(null);
    msgLongPressStartRef.current = null;
    msgLongPressTriggeredRef.current = false;
    if (msgLongPressTimerRef.current) {
      clearTimeout(msgLongPressTimerRef.current);
      msgLongPressTimerRef.current = null;
    }
  }, [isThinking]);

  const hasMascotToolHistory = hasMascotToolHistoryMessages(mascotMessages);

  const handleClearMascotToolHistory = useCallback(() => {
    if (isThinking) {
      window.dispatchEvent(new CustomEvent("global-notice", { detail: `${mascotDisplayName}正在执行，完成后再清理。` }));
      return;
    }
    if (!hasMascotToolHistory) {
      window.dispatchEvent(new CustomEvent("global-notice", { detail: "没有可清理的工具调用历史。" }));
      return;
    }
    const confirmed = window.confirm(`将移除${mascotDisplayName}会话中的工具调用记录、工具结果记录，并清除消息里的原生工具调用元数据。普通对话内容不会删除。`);
    if (!confirmed) return;

    const result = clearMascotToolHistoryMessages(mascotMessages);
    setMascotMessages(result.messages);
    window.dispatchEvent(new CustomEvent("global-notice", {
      detail: result.deletedMessages + result.cleanedMessages > 0
        ? `已清理 ${result.deletedMessages} 条工具记录，整理 ${result.cleanedMessages} 条消息。`
        : "没有可清理的工具调用历史。",
    }));
  }, [hasMascotToolHistory, isThinking, mascotDisplayName, mascotMessages]);

  const closeMascotMessageMenu = useCallback(() => {
    setActiveMascotMessageIndex(null);
  }, []);

  const cancelMascotMessageLongPress = useCallback(() => {
    msgLongPressStartRef.current = null;
    msgLongPressTriggeredRef.current = false;
    if (msgLongPressTimerRef.current) {
      clearTimeout(msgLongPressTimerRef.current);
      msgLongPressTimerRef.current = null;
    }
  }, []);

  const openMascotMessageMenu = useCallback((rawIndex: number) => {
    if (isThinking) return;
    setActiveMascotMessageIndex(rawIndex);
  }, [isThinking]);

  const handleMascotMessagePointerDown = useCallback((event: ReactPointerEvent, rawIndex: number) => {
    if (isThinking) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    msgLongPressStartRef.current = { x: event.clientX, y: event.clientY };
    msgLongPressTriggeredRef.current = false;
    if (msgLongPressTimerRef.current) clearTimeout(msgLongPressTimerRef.current);
    msgLongPressTimerRef.current = setTimeout(() => {
      msgLongPressTriggeredRef.current = true;
      openMascotMessageMenu(rawIndex);
      msgLongPressTimerRef.current = null;
    }, 500);
  }, [isThinking, openMascotMessageMenu]);

  const handleMascotMessagePointerUp = useCallback((event: ReactPointerEvent) => {
    msgLongPressStartRef.current = null;
    if (msgLongPressTimerRef.current) {
      clearTimeout(msgLongPressTimerRef.current);
      msgLongPressTimerRef.current = null;
    }
    if (msgLongPressTriggeredRef.current) {
      event.preventDefault();
      event.stopPropagation();
      msgLongPressTriggeredRef.current = false;
    }
  }, []);

  const handleMascotMessagePointerMove = useCallback((event: ReactPointerEvent) => {
    if (!msgLongPressStartRef.current) return;
    const dx = Math.abs(event.clientX - msgLongPressStartRef.current.x);
    const dy = Math.abs(event.clientY - msgLongPressStartRef.current.y);
    if (dx > 10 || dy > 10) cancelMascotMessageLongPress();
  }, [cancelMascotMessageLongPress]);

  const handleCopyMascotMessage = useCallback((rawIndex: number) => {
    const msg = mascotMessages[rawIndex];
    if (!msg) return;
    const text = getMascotMessageText(msg).trim() || (msg.images?.length ? "[图片]" : "");
    if (text) copyTextToClipboard(text);
    closeMascotMessageMenu();
  }, [closeMascotMessageMenu, mascotMessages]);

  const handleDeleteMascotMessage = useCallback((rawIndex: number) => {
    if (isThinking) {
      window.dispatchEvent(new CustomEvent("global-notice", { detail: `${mascotDisplayName}正在回复，完成后再删除消息。` }));
      closeMascotMessageMenu();
      return;
    }
    const result = deleteMascotMessageWithLinkedTools(mascotMessages, rawIndex);
    if (result.deletedMessages > 0 || result.cleanedMessages > 0) {
      setMascotMessages(result.messages);
    }
    closeMascotMessageMenu();
  }, [closeMascotMessageMenu, isThinking, mascotDisplayName, mascotMessages]);

  const renderMascotMessageMenu = (rawIndex: number) => {
    if (activeMascotMessageIndex !== rawIndex) return null;
    return (
      <div className="mascot-msg-context-menu" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => handleCopyMascotMessage(rawIndex)}>复制</button>
        <button type="button" data-danger="true" onClick={() => handleDeleteMascotMessage(rawIndex)}>删除</button>
      </div>
    );
  };

  // Drag handlers
  const handlePointerDown = useCallback((e: ReactPointerEvent) => {
    longPressTriggered.current = false;
    const el = floatRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const shell = el.closest("[data-ui='phone-screen']") as HTMLElement | null;
    const shellRect = shell?.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left - (shellRect?.left ?? 0),
      startTop: rect.top - (shellRect?.top ?? 0),
      moved: false,
    };
    longPressTimer.current = setTimeout(() => {
      if (!dragState.current?.moved) {
        longPressTriggered.current = true;
        deactivateMascot();
      }
    }, 600);
    el.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: ReactPointerEvent) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      dragState.current.moved = true;
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
      closeMascotPanel();
    }
    if (dragState.current.moved) {
      setFloatPos({ left: dragState.current.startLeft + dx, top: dragState.current.startTop + dy });
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    const wasDrag = dragState.current?.moved;
    dragState.current = null;
    if (longPressTriggered.current) { longPressTriggered.current = false; return; }
    if (!wasDrag) toggleMascotPanel();
  }, []);

  const scrollMascotChatToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Scroll only the mascot chat container; scrollIntoView can move the mobile viewport.
  useEffect(() => { scrollMascotChatToBottom("smooth"); }, [mascotMessages, scrollMascotChatToBottom]);
  // 面板打开时立刻跳到底部（不平滑），保证用户每次打开看到的都是最新消息
  useEffect(() => {
    if (!panelOpen) return;
    // 等下一帧 DOM 渲染完
    requestAnimationFrame(() => {
      scrollMascotChatToBottom("auto");
    });
  }, [panelOpen, scrollMascotChatToBottom]);

  // 渲染单条消息（聊天气泡 / 工具步骤卡片）
  const renderMascotMsg = ({ msg, rawIndex }: { msg: MascotMsg; rawIndex: number }) => {
    // 工具消息：渲染为紧凑步骤卡片
    if (msg.role === "tool") {
      // toolSuccess 没设置 → 还在运行
      const running = msg.toolSuccess === undefined;
      const success = msg.toolSuccess === true;
      const label = msg.displayText || msg.text || msg.toolDisplayName || msg.toolName || "工具";
      const shownName = msg.toolDisplayName || msg.toolName || "工具";
      return (
        <article
          key={`${rawIndex}-${msg.createdAt || ""}`}
          className="mascot-tool-step"
          data-running={running ? "1" : undefined}
          data-success={!running && success ? "1" : undefined}
          data-error={!running && !success ? "1" : undefined}
          onPointerDown={(event) => handleMascotMessagePointerDown(event, rawIndex)}
          onPointerUp={handleMascotMessagePointerUp}
          onPointerCancel={cancelMascotMessageLongPress}
          onPointerLeave={cancelMascotMessageLongPress}
          onPointerMove={handleMascotMessagePointerMove}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMascotMessageMenu(rawIndex);
          }}
          {...(activeMascotMessageIndex === rawIndex ? { "data-active": "1" } : {})}
        >
          {renderMascotMessageMenu(rawIndex)}
          <div className="mascot-tool-step-main">
            <span className="mascot-tool-step-icon" aria-hidden="true">
              {running ? "◌" : success ? "✓" : "✗"}
            </span>
            <span className="mascot-tool-step-name">{shownName}</span>
            {!running && (
              <span className="mascot-tool-step-result" title={label}>{label.slice(0, 80)}{label.length > 80 ? "…" : ""}</span>
            )}
          </div>
          {msg.images && msg.images.length > 0 && (
            <div className="mascot-tool-step-images">
              {msg.images.map((ref, idx) => {
                const url = imagePreviewCache[ref];
                if (!url) return <div key={idx} className="mascot-msg-image mascot-msg-image-loading" />;
                /* eslint-disable-next-line @next/next/no-img-element */
                return <img key={idx} src={url} alt="" className="mascot-msg-image" />;
              })}
            </div>
          )}
        </article>
      );
    }
    // 跳过纯占位的 mascot 消息（如 "（调用工具中...）"），它们只是过渡，没有实际内容
    if (isHiddenMascotPlaceholder(msg)) {
      return null;
    }
    return (
      <div key={`${rawIndex}-${msg.createdAt || ""}`} className="mascot-msg" data-role={msg.role}>
        {msg.role === "mascot" && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img className="mascot-msg-avatar" src={mascotAvatarUrl} alt="" />
        )}
        <div
          className="mascot-msg-bubble"
          onPointerDown={(event) => handleMascotMessagePointerDown(event, rawIndex)}
          onPointerUp={handleMascotMessagePointerUp}
          onPointerCancel={cancelMascotMessageLongPress}
          onPointerLeave={cancelMascotMessageLongPress}
          onPointerMove={handleMascotMessagePointerMove}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMascotMessageMenu(rawIndex);
          }}
          {...(activeMascotMessageIndex === rawIndex ? { "data-active": "1" } : {})}
        >
          {renderMascotMessageMenu(rawIndex)}
          {msg.images && msg.images.length > 0 && (
            <div className="mascot-msg-images">
              {msg.images.map((ref, idx) => {
                const url = imagePreviewCache[ref];
                if (!url) return <div key={idx} className="mascot-msg-image mascot-msg-image-loading" />;
                /* eslint-disable-next-line @next/next/no-img-element */
                return <img key={idx} src={url} alt="" className="mascot-msg-image" />;
              })}
            </div>
          )}
          {getMascotMessageText(msg) && <span>{getMascotMessageText(msg)}</span>}
        </div>
      </div>
    );
  };

  // ── Unified send handler, shared with the full chat-room assistant ──
  const handleSend = useCallback(async () => {
    const text = chatInput.trim();
    if ((!text && pendingImages.length === 0) || isThinking) return;
    setChatInput("");
    const images = pendingImages;
    setPendingImages([]);
    await sendMascotMessage({ text, images, context });
  }, [chatInput, isThinking, context, pendingImages]);

  // Select a module from grid (show teleport confirmation)
  const handleModuleSelect = useCallback((moduleId: string) => {
    setSelectedModule(moduleId);
  }, []);

  // Teleport to the selected module
  const handleTeleport = useCallback(() => {
    if (!selectedModule) return;
    // Modules that live inside settings app
    const settingsModules = ["worldbook", "regex", "presets"];
    if (settingsModules.includes(selectedModule)) {
      mascotNavigate("settings", selectedModule);
    } else if (selectedModule === "css") {
      sessionStorage.setItem("mascot-theme-section", "css");
      mascotNavigate("theme");
    } else {
      mascotNavigate(selectedModule);
    }
    setSelectedModule(null);
  }, [selectedModule]);

  if (state === "widget") return null;

  const isDesktop = context.page === "desktop";

  return (
    <>
      <style>{`
        .mascot-float {
          position: absolute;
          right: ${MASCOT_FLOAT_RIGHT}px;
          bottom: ${MASCOT_FLOAT_BOTTOM}px;
          width: ${MASCOT_FLOAT_WIDTH}px;
          height: ${MASCOT_FLOAT_HEIGHT}px;
          z-index: 9999;
          cursor: pointer;
          -webkit-user-select: none;
          user-select: none;
          -webkit-touch-callout: none;
          touch-action: none;
          will-change: transform;
        }
        .mascot-flight-img {
          position: absolute;
          right: ${MASCOT_FLOAT_RIGHT}px;
          bottom: ${MASCOT_FLOAT_BOTTOM}px;
          width: ${MASCOT_FLOAT_WIDTH}px;
          height: ${MASCOT_FLOAT_HEIGHT}px;
          opacity: 0;
          object-fit: contain;
          pointer-events: none;
          transform-origin: center center;
          transform: translate3d(0, 0, 0) scale(1);
          will-change: transform, opacity;
          filter: drop-shadow(0 4px 14px rgba(0,0,0,0.28));
          backface-visibility: hidden;
        }
        .mascot-float img {
          pointer-events: none;
        }
        .mascot-float-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          filter: drop-shadow(0 2px 8px rgba(0,0,0,0.3));
          animation: mascot-idle 3s ease-in-out infinite;
        }
        @keyframes mascot-idle {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        .mascot-float:active .mascot-float-img {
          transform: scale(0.9);
        }

        /* ── Panel ── */
        .mascot-panel-overlay {
          position: absolute;
          inset: 0;
          z-index: 9998;
        }
        .mascot-panel {
          position: absolute;
          width: min(280px, 75vw);
          z-index: 9999;
          background: var(--mascot-panel-bg, rgba(10, 8, 20, 0.92));
          border: var(--mascot-panel-border, 1px solid rgba(255,255,255,0.1));
          border-radius: var(--mascot-panel-radius, 16px);
          padding: 16px;
          box-shadow: var(--mascot-panel-shadow, 0 8px 32px rgba(0,0,0,0.4));
          animation: mascot-panel-in 0.25s ease;
          transform-origin: right bottom;
          will-change: transform, opacity;
        }
        @keyframes mascot-panel-in {
          from { opacity: 0; transform: translateY(12px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .mascot-flight-img,
          .mascot-panel,
          .mascot-float-img {
            animation: none !important;
            transition: opacity 120ms ease-out !important;
          }
        }

        .mascot-nine-overlay {
          position: absolute;
          inset: 0;
          z-index: 10020;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          background: rgba(0,0,0,0.5);
          backdrop-filter: blur(10px);
          user-select: none;
          -webkit-user-select: none;
          -webkit-touch-callout: none;
        }
        .mascot-nine-dialog {
          width: min(440px, 96vw);
          max-height: 94vh;
          display: flex;
          flex-direction: column;
          gap: 11px;
          padding: 18px;
          border-radius: 20px;
          background: linear-gradient(180deg, rgba(33,30,48,0.98), rgba(22,20,34,0.98));
          border: 1px solid rgba(255,255,255,0.1);
          box-shadow: 0 24px 60px rgba(0,0,0,0.55);
          color: rgba(255,255,255,0.9);
          overflow: auto;
        }
        .mascot-nine-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
        }
        .mascot-nine-title {
          font-weight: 700;
          font-size: calc(16px*var(--app-text-scale,1));
          letter-spacing: 0.01em;
        }
        .mascot-nine-sub {
          margin-top: 4px;
          color: rgba(255,255,255,0.45);
          font-size: calc(11px*var(--app-text-scale,1));
          font-variant-numeric: tabular-nums;
        }
        .mascot-nine-close {
          flex: none;
          width: 30px;
          height: 30px;
          border: 0;
          border-radius: 10px;
          background: rgba(255,255,255,0.07);
          color: rgba(255,255,255,0.7);
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
          transition: background 0.15s;
        }
        .mascot-nine-close:hover { background: rgba(255,255,255,0.14); }

        .mascot-nine-progress {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 7px;
          padding: 4px;
          border-radius: 13px;
          background: rgba(255,255,255,0.05);
        }
        .mascot-nine-chip {
          border: 0;
          padding: 0;
          min-width: 0;
          height: 26px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 10px;
          background: transparent;
          color: rgba(255,255,255,0.48);
          font-family: inherit;
          font-size: calc(11px*var(--app-text-scale,1));
          font-weight: 700;
          white-space: nowrap;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
        }
        .mascot-nine-chip:hover {
          background: rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.75);
        }
        .mascot-nine-chip.is-active {
          background: rgba(178,150,255,0.22);
          color: rgba(255,255,255,0.95);
          box-shadow: inset 0 0 0 1px rgba(178,150,255,0.2);
        }

        .mascot-nine-step {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 4px;
        }
        .mascot-nine-stepnum {
          flex: none;
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: linear-gradient(180deg, rgba(178,150,255,0.98), rgba(150,118,250,0.98));
          color: #fff;
          font-size: calc(11px*var(--app-text-scale,1));
          font-weight: 700;
        }
        .mascot-nine-steptitle {
          font-weight: 700;
          font-size: calc(13.5px*var(--app-text-scale,1));
          color: rgba(255,255,255,0.92);
        }
        .mascot-nine-stepval {
          margin-left: auto;
          color: rgba(178,150,255,0.95);
          font-size: calc(12px*var(--app-text-scale,1));
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }

        .mascot-nine-hint {
          margin: -4px 0 0;
          color: rgba(255,255,255,0.5);
          font-size: calc(11px*var(--app-text-scale,1));
          line-height: 1.5;
        }

        .mascot-nine-stage {
          position: relative;
          width: 100%;
          min-height: 180px;
          max-height: 320px;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          padding: 14px;
          border-radius: 14px;
          overflow: auto;
          background:
            linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%),
            linear-gradient(-45deg, rgba(255,255,255,0.06) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.06) 75%),
            linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.06) 75%);
          background-color: rgba(0,0,0,0.2);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0;
        }
        .mascot-nine-loading {
          color: rgba(255,255,255,0.45);
          font-size: calc(12px*var(--app-text-scale,1));
        }
        .mascot-nine-imgwrap {
          position: relative;
          display: inline-block;
          flex: none;
          line-height: 0;
          margin: auto;
          max-width: none;
        }
        .mascot-nine-img {
          display: block;
          width: 100%;
          height: auto;
        }
        .mascot-nine-region {
          position: absolute;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          background: rgba(120,225,170,0.14);
        }
        .mascot-nine-scale-word {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          color: rgba(40,40,55,0.86);
          font-size: calc(13.5px*var(--app-text-scale,1)*var(--mascot-nine-preview-zoom,1));
          line-height: 1.45;
          text-align: center;
          text-shadow: 0 1px 2px rgba(255,255,255,0.9);
          pointer-events: none;
        }
        .mascot-nine-region-label {
          max-width: 100%;
          padding: 2px 6px;
          border-radius: 999px;
          background: rgba(20,25,28,0.35);
          color: rgba(255,255,255,0.88);
          font-size: calc(10.5px*var(--app-text-scale,1));
          font-weight: 700;
          line-height: 1.45;
          text-align: center;
          overflow-wrap: anywhere;
        }
        .mascot-nine-line {
          position: absolute;
          pointer-events: none;
        }
        .mascot-nine-line-h {
          left: 0;
          right: 0;
          height: 0;
          border-top: 1.5px dashed rgba(120,235,175,0.95);
          transform: translateY(-0.75px);
        }
        .mascot-nine-line-v {
          top: 0;
          bottom: 0;
          width: 0;
          border-left: 1.5px dashed rgba(120,235,175,0.95);
          transform: translateX(-0.75px);
        }
        .mascot-nine-result {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 220px;
          justify-content: center;
          padding: 18px 14px;
          border-radius: 14px;
          background: linear-gradient(180deg, #f3f6fb, #e9eef6);
          overflow: auto;
        }
        .mascot-nine-result-top {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .mascot-nine-result-label {
          flex: none;
          color: rgba(60,55,80,0.5);
          font-size: calc(10.5px*var(--app-text-scale,1));
          font-weight: 600;
          letter-spacing: 0.04em;
        }
        .mascot-nine-textinput {
          flex: 1;
          min-width: 0;
          height: 30px;
          padding: 0 10px;
          border: 1px solid rgba(60,55,80,0.18);
          border-radius: 9px;
          background: rgba(255,255,255,0.85);
          color: rgba(40,38,55,0.95);
          font-size: calc(12.5px*var(--app-text-scale,1));
        }
        .mascot-nine-textinput:focus {
          outline: none;
          border-color: rgba(150,118,250,0.7);
        }
        .mascot-nine-textinput::placeholder {
          color: rgba(60,55,80,0.4);
        }
        .mascot-nine-realrow {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-start;
          justify-content: center;
          gap: 14px;
        }
        .mascot-nine-real {
          position: relative;
          isolation: isolate;
          display: inline-flex;
          flex-direction: column;
          align-items: flex-start;
          width: fit-content;
          max-width: 82%;
          box-sizing: border-box;
          border: 0;
          background: transparent;
          overflow: visible;
          color: rgba(73,55,48,0.92);
          font-size: calc(13.5px*var(--app-text-scale,1)*var(--mascot-nine-final-zoom,1));
          line-height: 1.45;
          pointer-events: auto;
        }
        .mascot-nine-real::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: -1;
          pointer-events: none;
          border-style: solid;
          border-width: var(--mascot-nine-border);
          border-image-source: var(--mascot-nine-image);
          border-image-slice: var(--mascot-nine-slice);
          border-image-width: 1;
          border-image-repeat: stretch;
          box-sizing: border-box;
        }
        .mascot-nine-real span { overflow-wrap: anywhere; }
        .mascot-nine-editable-text {
          position: relative;
          z-index: 2;
          min-width: 4em;
          cursor: text;
          border-radius: 6px;
          outline: none;
          white-space: pre-wrap;
        }
        .mascot-nine-editable-text:focus {
          background: rgba(255,255,255,0.42);
          box-shadow: 0 0 0 1px rgba(150,118,250,0.38);
        }
        .mascot-nine-safe {
          position: absolute;
          z-index: 1;
          pointer-events: none;
          border: 1px dashed rgba(60,170,115,0.6);
          border-radius: 4px;
        }

        .mascot-nine-sliders {
          display: grid;
          grid-template-columns: 1fr;
          gap: 10px;
        }
        .mascot-nine-slider,
        .mascot-nine-scalerow {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .mascot-nine-slider-label {
          flex: none;
          width: 18px;
          color: rgba(255,255,255,0.7);
          font-size: calc(13px*var(--app-text-scale,1));
          font-weight: 600;
          text-align: center;
        }
        .mascot-nine-range {
          flex: 1;
          min-width: 0;
          height: 44px;
          margin: -9px 0;
          accent-color: rgba(178,150,255,0.95);
          cursor: pointer;
          touch-action: none;
          -webkit-tap-highlight-color: transparent;
        }

        .mascot-nine-actions {
          display: flex;
          gap: 10px;
        }
        .mascot-nine-btn {
          flex: 1;
          height: 42px;
          border: 0;
          border-radius: 13px;
          background: rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.82);
          font-size: calc(14px*var(--app-text-scale,1));
          font-weight: 600;
          cursor: pointer;
          transition: filter 0.15s, background 0.15s;
        }
        .mascot-nine-btn:hover { background: rgba(255,255,255,0.14); }
        .mascot-nine-btn-primary {
          background: linear-gradient(180deg, rgba(178,150,255,0.98), rgba(150,118,250,0.98));
          color: #fff;
          box-shadow: 0 5px 16px rgba(120,90,230,0.4);
        }
        .mascot-nine-btn-primary:hover { filter: brightness(1.06); background: linear-gradient(180deg, rgba(178,150,255,0.98), rgba(150,118,250,0.98)); }
        @media (max-width: 380px) {
          .mascot-nine-dialog {
            padding: 14px;
          }
          .mascot-nine-sliders {
            grid-template-columns: 1fr;
          }
          .mascot-nine-result-top {
            flex-direction: column;
            align-items: stretch;
          }
        }
        /* ── Thinking indicator ── */
        .mascot-thinking {
          color: var(--mascot-accent, rgba(200,180,240,0.95));
          font-weight: 500;
        }
        .mascot-thinking .mascot-dot {
          display: inline-block;
          width: 7px;
          height: 7px;
          margin: 0 2px;
          border-radius: 50%;
          background: var(--mascot-accent, rgba(200,180,240,0.95));
          vertical-align: middle;
          animation: mascot-dot-bounce 1s infinite ease-in-out;
          box-shadow: 0 0 6px currentColor;
        }
        .mascot-thinking .mascot-dot:nth-child(1) { animation-delay: 0s; }
        .mascot-thinking .mascot-dot:nth-child(2) { animation-delay: 0.15s; }
        .mascot-thinking .mascot-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes mascot-dot-bounce {
          0%, 70%, 100% { transform: scale(0.6); opacity: 0.5; }
          35% { transform: scale(1.15); opacity: 1; }
        }

        /* ── Image upload ── */
        .mascot-msg-images {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-bottom: 4px;
        }
        .mascot-msg-image {
          max-width: 140px;
          max-height: 140px;
          border-radius: 6px;
          object-fit: cover;
          cursor: pointer;
          transition: transform 0.15s;
        }
        .mascot-msg-image:active { transform: scale(0.96); }
        .mascot-msg-image-loading {
          width: 100px;
          height: 100px;
          background: var(--mascot-btn-bg, rgba(255,255,255,0.04));
          animation: mascot-img-pulse 1.2s ease-in-out infinite;
        }
        @keyframes mascot-img-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
        .mascot-pending-images {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          padding: 6px 4px;
          margin-bottom: 4px;
        }
        .mascot-pending-image-item {
          position: relative;
          width: 50px;
          height: 50px;
          border-radius: 6px;
          overflow: hidden;
          border: 1px solid var(--mascot-border, rgba(255,255,255,0.1));
          background: var(--mascot-btn-bg, rgba(255,255,255,0.04));
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--mascot-text-dim, rgba(255,255,255,0.45));
          font-size: calc(10px*var(--app-text-scale,1));
        }
        .mascot-pending-image-item::before {
          content: "图片";
        }
        .mascot-pending-image-item img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          z-index: 1;
        }
        .mascot-pending-image-item .mascot-msg-image-loading {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          z-index: 1;
        }
        .mascot-pending-image-item button {
          position: absolute;
          top: -4px;
          right: -4px;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: rgba(0,0,0,0.8);
          color: #fff;
          border: 1px solid rgba(255,255,255,0.3);
          font-size: 9px;
          line-height: 1;
          cursor: pointer;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2;
        }
        .mascot-chat-attach {
          position: relative;
          flex-shrink: 0;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: none;
          background: var(--mascot-btn-bg, rgba(255,255,255,0.05));
          color: var(--mascot-text, rgba(255,255,255,0.7));
          font-size: calc(14px*var(--app-text-scale,1));
          cursor: pointer;
          transition: all 0.15s;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .mascot-chat-attach:hover:not([aria-disabled="true"]) {
          background: var(--mascot-btn-active, rgba(255,255,255,0.1));
        }
        .mascot-chat-attach[aria-disabled="true"] {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .mascot-chat-attach-input {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          opacity: 0;
          cursor: pointer;
        }
        .mascot-chat-attach[aria-disabled="true"] .mascot-chat-attach-input {
          pointer-events: none;
        }
        /* ── Tool step card ── */
        .mascot-tool-step {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 4px 8px;
          margin: 2px 0 2px 30px;
          border-radius: 6px;
          background: var(--mascot-btn-bg, rgba(255,255,255,0.03));
          border: 1px solid var(--mascot-border, rgba(255,255,255,0.06));
          font-size: calc(11px*var(--app-text-scale,1));
          color: var(--mascot-text, rgba(255,255,255,0.55));
          line-height: 1.4;
          -webkit-user-select: none;
          user-select: none;
        }
        .mascot-tool-step[data-active="1"] {
          overflow: visible;
        }
        .mascot-tool-step-main {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          width: 100%;
        }
        .mascot-tool-step-icon {
          flex-shrink: 0;
          width: 14px;
          text-align: center;
          font-weight: 600;
        }
        .mascot-tool-step[data-running="1"] .mascot-tool-step-icon {
          color: var(--mascot-accent, rgba(200,180,240,0.9));
          animation: mascot-tool-spin 1.4s linear infinite;
          display: inline-block;
        }
        .mascot-tool-step[data-success="1"] .mascot-tool-step-icon {
          color: rgba(120,200,140,0.9);
        }
        .mascot-tool-step[data-error="1"] .mascot-tool-step-icon {
          color: rgba(220,90,90,0.9);
        }
        .mascot-tool-step-name {
          font-weight: 500;
          color: var(--mascot-text, rgba(255,255,255,0.7));
          white-space: nowrap;
        }
        .mascot-tool-step-result {
          color: var(--mascot-text-dim, rgba(255,255,255,0.4));
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }
        .mascot-tool-step-images {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          padding-left: 20px;
        }
        .mascot-tool-step-images .mascot-msg-image {
          max-width: 120px;
          max-height: 120px;
        }
        @keyframes mascot-tool-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        /* ── Module Drawer ── */
        .mascot-module-drawer {
          margin-bottom: 8px;
        }
        .mascot-drawer-handle {
          display: flex;
          justify-content: center;
          align-items: center;
          width: 100%;
          height: 14px;
          margin-bottom: 6px;
          padding: 0;
          background: transparent;
          border: none;
          cursor: pointer;
          opacity: 0.4;
          transition: opacity 0.15s;
        }
        .mascot-drawer-handle:hover {
          opacity: 0.8;
        }
        .mascot-drawer-handle-bar {
          width: 36px;
          height: 4px;
          border-radius: 2px;
          background: var(--mascot-text, rgba(255,255,255,0.6));
          transition: background 0.15s;
        }
        .mascot-module-drawer[data-open="true"] .mascot-drawer-handle-bar {
          background: var(--mascot-accent, rgba(200,180,240,0.9));
        }

        /* ── Module Grid ── */
        .mascot-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
          margin-bottom: 14px;
        }
        .mascot-grid-btn {
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: center;
          gap: 5px;
          padding: 6px 4px;
          border-radius: 10px;
          border: 1px solid var(--mascot-border, rgba(255,255,255,0.06));
          background: var(--mascot-btn-bg, rgba(255,255,255,0.03));
          color: var(--mascot-text, rgba(255,255,255,0.6));
          font-size: calc(11px*var(--app-text-scale,1));
          font-family: inherit;
          cursor: pointer;
          transition: all 0.15s;
        }
        .mascot-grid-btn:active {
          background: var(--mascot-btn-active, rgba(255,255,255,0.08));
          transform: scale(0.95);
        }
        .mascot-grid-btn[data-selected="true"] {
          background: var(--mascot-accent-bg, rgba(200,180,240,0.15));
          border-color: var(--mascot-accent-border, rgba(200,180,240,0.3));
          color: var(--mascot-accent, rgba(200,180,240,0.9));
        }
        .mascot-grid-icon {
          font-size: calc(14px*var(--app-text-scale,1));
          line-height: 1;
        }

        /* ── Teleport button ── */
        .mascot-teleport-btn {
          padding: 8px 20px;
          border-radius: 8px;
          border: 1px solid var(--mascot-accent-border, rgba(200,180,240,0.25));
          background: var(--mascot-accent-bg, rgba(200,180,240,0.15));
          color: var(--mascot-accent, rgba(200,180,240,0.9));
          font-size: calc(12px*var(--app-text-scale,1));
          font-family: inherit;
          cursor: pointer;
          transition: all 0.15s;
        }
        .mascot-teleport-btn:active {
          background: rgba(200,180,240,0.3);
          transform: scale(0.95);
        }
        .mascot-clear-tools-btn {
          width: 100%;
          min-height: 38px;
          margin-top: 2px;
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid rgba(255, 105, 105, 0.28);
          background: rgba(255, 105, 105, 0.1);
          color: rgba(255, 190, 190, 0.92);
          font-size: calc(12px*var(--app-text-scale,1));
          font-family: inherit;
          cursor: pointer;
          transition: background 0.15s, transform 0.15s, opacity 0.15s;
        }
        .mascot-clear-tools-btn:active {
          background: rgba(255, 105, 105, 0.18);
          transform: scale(0.98);
        }
        .mascot-clear-tools-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        /* ── Context header ── */
        .mascot-ctx-header {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 10px;
          font-size: calc(12px*var(--app-text-scale,1));
          color: var(--mascot-accent, rgba(200,180,240,0.8));
        }
        .mascot-ctx-home {
          border: none;
          background: transparent;
          color: var(--mascot-text-dim, rgba(255,255,255,0.35));
          font-size: calc(14px*var(--app-text-scale,1));
          cursor: pointer;
          padding: 0;
          line-height: 1;
        }
        .mascot-ctx-home:active { color: var(--mascot-text, rgba(255,255,255,0.6)); }

        /* ── Chat area ── */
        .mascot-chat {
          border-top: 1px solid var(--mascot-border, rgba(255,255,255,0.06));
          padding-top: 10px;
        }
        .mascot-chat-messages {
          max-height: 360px;
          overflow-y: auto;
          margin-bottom: 10px;
          scrollbar-width: none;
        }
        .mascot-chat-messages::-webkit-scrollbar { display: none; }
        .mascot-msg {
          margin-bottom: 8px;
          display: flex;
          gap: 6px;
          align-items: flex-start;
        }
        .mascot-msg[data-role="user"] { justify-content: flex-end; }
        .mascot-msg-avatar {
          width: 22px; height: 22px; border-radius: 50%;
          object-fit: cover; flex-shrink: 0;
        }
        .mascot-msg-bubble {
          position: relative;
          max-width: 85%;
          padding: 6px 10px;
          border-radius: 10px;
          font-size: calc(12px*var(--app-text-scale,1));
          line-height: 1.5;
          white-space: pre-wrap;
          /* 长 URL / 错误堆栈这类不可断字串能强制换行，不再溢出气泡 */
          overflow-wrap: anywhere;
          word-break: break-word;
          min-width: 0;
          -webkit-user-select: none;
          user-select: none;
        }
        .mascot-msg-bubble[data-active="1"] {
          overflow: visible;
        }
        .mascot-msg-context-menu {
          position: absolute;
          left: 50%;
          top: -34px;
          z-index: 12;
          display: flex;
          align-items: center;
          overflow: hidden;
          border-radius: 8px;
          background: rgba(36, 36, 42, 0.96);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
          transform: translateX(-50%);
          white-space: nowrap;
        }
        .mascot-msg-context-menu button {
          height: 28px;
          padding: 0 12px;
          border: 0;
          border-right: 1px solid rgba(255,255,255,0.1);
          background: transparent;
          color: #fff;
          font-size: calc(11.5px*var(--app-text-scale,1));
          font-family: inherit;
          cursor: pointer;
        }
        .mascot-msg-context-menu button:last-child {
          border-right: 0;
        }
        .mascot-msg-context-menu button[data-danger="true"] {
          color: #ff8b8b;
        }
        .mascot-msg[data-role="user"] .mascot-msg-context-menu {
          left: auto;
          right: 0;
          transform: none;
        }
        .mascot-tool-step .mascot-msg-context-menu {
          top: -32px;
          left: 50%;
          right: auto;
          transform: translateX(-50%);
        }
        .mascot-msg[data-role="mascot"] .mascot-msg-bubble {
          background: var(--mascot-bubble-mascot-bg, rgba(200,180,240,0.12));
          color: var(--mascot-bubble-mascot-text, rgba(255,255,255,0.8));
          border-top-left-radius: 2px;
        }
        .mascot-msg[data-role="user"] .mascot-msg-bubble {
          background: var(--mascot-bubble-user-bg, rgba(255,255,255,0.1));
          color: var(--mascot-bubble-user-text, rgba(255,255,255,0.75));
          border-top-right-radius: 2px;
        }
        .mascot-chat-row {
          display: flex;
          gap: 8px;
        }
        .mascot-chat-input {
          flex: 1;
          padding: 8px 12px;
          border-radius: 20px;
          border: 1px solid var(--mascot-border, rgba(255,255,255,0.1));
          background: var(--mascot-input-bg, rgba(255,255,255,0.04));
          color: var(--mascot-text, rgba(255,255,255,0.8));
          font-size: calc(13px*var(--app-text-scale,1));
          font-family: inherit;
          outline: none;
        }
        .mascot-chat-input::placeholder {
          color: var(--mascot-text-dim, rgba(255,255,255,0.25));
        }
        .mascot-chat-send {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: none;
          background: rgba(200,180,240,0.15);
          color: rgba(200,180,240,0.8);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          font-size: calc(16px*var(--app-text-scale,1));
        }
        .mascot-chat-send:active {
          background: rgba(200,180,240,0.3);
        }

        /* ── Confirmation dialog ── */
        .mascot-confirm {
          text-align: center;
          padding: 8px 0;
        }
        .mascot-confirm-label {
          font-size: calc(11px*var(--app-text-scale,1));
          color: rgba(255,255,255,0.4);
          margin-bottom: 4px;
        }
        .mascot-confirm-value {
          font-size: calc(13px*var(--app-text-scale,1));
          color: rgba(255,255,255,0.8);
          margin-bottom: 6px;
        }
        .mascot-confirm-chars {
          font-size: calc(12px*var(--app-text-scale,1));
          color: rgba(200,180,240,0.8);
          margin-bottom: 12px;
        }
        .mascot-confirm-btns {
          display: flex;
          gap: 8px;
          justify-content: center;
        }
        .mascot-confirm-btn {
          padding: 7px 16px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.1);
          background: transparent;
          color: rgba(255,255,255,0.5);
          font-size: calc(12px*var(--app-text-scale,1));
          font-family: inherit;
          cursor: pointer;
        }
        .mascot-confirm-btn:active { background: rgba(255,255,255,0.06); }
        .mascot-confirm-btn[data-primary="true"] {
          background: rgba(200,180,240,0.15);
          border-color: rgba(200,180,240,0.25);
          color: rgba(200,180,240,0.9);
        }

        /* ── Return hint ── */
        .mascot-return-hint {
          font-size: calc(10px*var(--app-text-scale,1));
          color: rgba(255,255,255,0.2);
          text-align: center;
          margin-top: 10px;
          letter-spacing: 0.05em;
        }
      `}</style>

      {nineSliceCalibration && (
        <NineSliceCalibrationDialog
          detail={nineSliceCalibration}
          onClose={() => setNineSliceCalibration(null)}
        />
      )}

      {diyWidgetPreview && (
        <DiyWidgetPreviewDialog
          request={diyWidgetPreview}
          onClose={() => setDiyWidgetPreview(null)}
        />
      )}

      {/* ── Animating / Floating mascot ── */}
      {(state === "animating_in" || state === "animating_out") ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="mascot-flight-img" src={mascotAvatarUrl} alt={mascotDisplayName} style={animStyle} />
      ) : (
        <>
          {/* Panel overlay */}
          {panelOpen && (
            <div className="mascot-panel-overlay" onClick={closeMascotPanel} onPointerDown={(e) => e.stopPropagation()} />
          )}

          {/* Floating ball */}
          <div
            ref={floatRef}
            className="mascot-float"
            style={floatPos ? { left: floatPos.left, top: floatPos.top, right: "auto", bottom: "auto" } : undefined}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="mascot-float-img" src={mascotAvatarUrl} alt={mascotDisplayName} />
          </div>

          {/* Panel */}
          {panelOpen && (() => {
            const el = floatRef.current;
            const shell = el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
            const shellRect = shell?.getBoundingClientRect();
            const ballRect = el?.getBoundingClientRect();
            const shellW = shellRect?.width ?? 390;
            const shellH = shellRect?.height ?? 844;
            const ballLeft = (ballRect?.left ?? 0) - (shellRect?.left ?? 0);
            const ballTop = (ballRect?.top ?? 0) - (shellRect?.top ?? 0);
            const panelW = Math.min(280, shellW * 0.75);
            const onRight = ballLeft > shellW / 2;
            const pLeft = onRight ? Math.max(8, ballLeft + 56 - panelW) : Math.min(ballLeft, shellW - panelW - 8);
            const pBottom = shellH - ballTop + 8;
            const moduleDrawer = (
              <div className="mascot-module-drawer" data-open={moduleDrawerOpen ? "true" : undefined}>
                <button
                  type="button"
                  className="mascot-drawer-handle"
                  onClick={() => setModuleDrawerOpen((v) => !v)}
                  aria-label={moduleDrawerOpen ? "收起" : "展开"}
                >
                  <span className="mascot-drawer-handle-bar" />
                </button>
                {moduleDrawerOpen && (
                  <>
                    <div className="mascot-grid">
                      {MODULES.map((m) => (
                        <button
                          key={m.id}
                          className="mascot-grid-btn"
                          data-selected={selectedModule === m.id ? "true" : undefined}
                          onClick={() => {
                            if (m.id === "new_session") {
                              if (window.confirm("确定要开始新会话吗？当前 AI助手聊天记录会被清空。")) {
                                resetMascotConversation();
                              }
                              setSelectedModule(null);
                              return;
                            }
                            handleModuleSelect(m.id);
                          }}
                        >
                          <span className="mascot-grid-icon">{m.icon}</span>{m.label}
                        </button>
                      ))}
                    </div>
                    {selectedModule && (
                      <div style={{ textAlign: "center", marginBottom: 10 }}>
                        <button className="mascot-teleport-btn" onClick={handleTeleport}>
                          ✦ 传送到{MODULES.find((m) => m.id === selectedModule)?.label} →
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="mascot-clear-tools-btn"
                      onClick={handleClearMascotToolHistory}
                      disabled={isThinking || !hasMascotToolHistory}
                    >
                      清理原生tool调用历史——防报错
                    </button>
                  </>
                )}
              </div>
            );
            return (
            <div
              className="mascot-panel"
              style={{ left: pLeft, bottom: pBottom }}
              onPointerDown={() => {
                if (activeMascotMessageIndex !== null) closeMascotMessageMenu();
              }}
            >
              {/* 模块抽屉 — 任何页面都显示，作为统一的顶部把手 */}
              {moduleDrawer}
              {isDesktop ? (
                <>
                  {/* Chat section */}
                  <div className="mascot-chat">
                    <div className="mascot-chat-messages" ref={chatScrollRef}>
                      {visibleMascotEntries.map(renderMascotMsg)}
                      {isThinking && (
                        <div className="mascot-msg" data-role="mascot">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img className="mascot-msg-avatar" src={mascotAvatarUrl} alt="" />
                          <div className="mascot-msg-bubble mascot-thinking">思考中<span className="mascot-dot"></span><span className="mascot-dot"></span><span className="mascot-dot"></span></div>
                        </div>
                      )}
                    </div>
                    {pendingImages.length > 0 && (
                      <div className="mascot-pending-images">
                        {pendingImages.map((ref, idx) => {
                          const previewUrl = imagePreviewCache[ref];
                          return (
                            <div key={idx} className="mascot-pending-image-item">
                              {previewUrl && (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={previewUrl} alt="" />
                              )}
                              <button type="button" onClick={() => setPendingImages((arr) => arr.filter((_, i) => i !== idx))} aria-label="删除">✕</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="mascot-chat-row">
	                      <label
	                        className="mascot-chat-attach"
	                        aria-disabled={isThinking || pendingImages.length >= 4}
	                        title={pendingImages.length >= 4 ? "最多 4 张图" : "添加图片"}
	                        onClick={(e) => {
	                          if (isThinking || pendingImages.length >= 4) { e.preventDefault(); return; }
	                        }}
	                      >
	                        📎
	                        <input
	                          type="file"
	                          accept="image/*"
	                          multiple
	                          className="mascot-chat-attach-input"
	                          onChange={(e) => {
	                            const files = e.currentTarget.files ? Array.from(e.currentTarget.files) : [];
	                            e.currentTarget.value = "";
	                            void handlePickImages(files);
	                          }}
	                        />
	                      </label>
                      <input
                        className="mascot-chat-input"
                        placeholder={`跟${mascotDisplayName}聊聊...`}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
                        disabled={isThinking}
                      />
                      {isThinking
                        ? <button className="mascot-chat-send" onClick={stopMascotGeneration} style={{ color: "var(--c-error, #e53e3e)" }}>■</button>
                        : <button className="mascot-chat-send" onClick={handleSend}>→</button>
                      }
                    </div>
                  </div>
                  <div className="mascot-return-hint">
                    长按悬浮球可收回桌面
                  </div>
                </>
              ) : (
                <>
                  {/* Non-desktop: context header + chat */}
                  <div className="mascot-ctx-header">
                    <button className="mascot-ctx-home" onClick={() => mascotNavigate("desktop")} title="回到桌面">🏠</button>
                    <span>📍 {context.label}{context.mode === "editing" ? " (编辑中)" : ""}</span>
                  </div>

                  {/* Worldbook editing: show confirmation before entering chat */}
                  {context.page === "worldbook" && context.mode === "editing" && !wbConfirmed ? (
                    <div className="mascot-confirm">
                      <div className="mascot-confirm-label">当前世界书</div>
                      <div className="mascot-confirm-value">{context.fields.worldbookName || "未知"}</div>
                      <div className="mascot-confirm-label">绑定角色</div>
                      <div className="mascot-confirm-chars">{context.fields.boundCharacters || "未绑定"}</div>
                      <div className="mascot-confirm-btns">
                        <button className="mascot-confirm-btn" onClick={() => {
                          window.dispatchEvent(new CustomEvent("settings-navigate", { detail: { page: "binding" } }));
                          closeMascotPanel();
                        }}>
                          修改绑定 →
                        </button>
                        <button className="mascot-confirm-btn" data-primary="true" onClick={() => {
                          // If on binding page (came from worldbook), navigate back first
                          window.dispatchEvent(new CustomEvent("settings-navigate", { detail: { page: "worldbook" } }));
                          window.dispatchEvent(new CustomEvent("worldbook-refresh-context"));
                          setWbConfirmed(true);
                        }}>
                          确认
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mascot-chat">
                      <div className="mascot-chat-messages" ref={chatScrollRef}>
                        {visibleMascotEntries.map(renderMascotMsg)}
                        {isThinking && (
                          <div className="mascot-msg" data-role="mascot">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img className="mascot-msg-avatar" src={mascotAvatarUrl} alt="" />
                            <div className="mascot-msg-bubble mascot-thinking">思考中<span className="mascot-dot"></span><span className="mascot-dot"></span><span className="mascot-dot"></span></div>
                          </div>
                        )}
                      </div>
	                      {pendingImages.length > 0 && (
	                        <div className="mascot-pending-images">
	                          {pendingImages.map((ref, idx) => {
	                            const previewUrl = imagePreviewCache[ref];
	                            return (
	                              <div key={idx} className="mascot-pending-image-item">
	                                {previewUrl ? (
	                                  /* eslint-disable-next-line @next/next/no-img-element */
	                                  <img src={previewUrl} alt="" />
	                                ) : (
	                                  <div className="mascot-msg-image-loading" />
	                                )}
	                                <button type="button" onClick={() => setPendingImages((arr) => arr.filter((_, i) => i !== idx))} aria-label="删除">✕</button>
	                              </div>
	                            );
	                          })}
	                        </div>
	                      )}
                      <div className="mascot-chat-row">
	                        <label
	                          className="mascot-chat-attach"
	                          aria-disabled={isThinking || pendingImages.length >= 4}
	                          title={pendingImages.length >= 4 ? "最多 4 张图" : "添加图片"}
	                          onClick={(e) => {
	                            if (isThinking || pendingImages.length >= 4) { e.preventDefault(); return; }
	                          }}
	                        >
	                          📎
	                          <input
	                            type="file"
	                            accept="image/*"
	                            multiple
	                            className="mascot-chat-attach-input"
	                            onChange={(e) => {
	                              const files = e.currentTarget.files ? Array.from(e.currentTarget.files) : [];
	                              e.currentTarget.value = "";
	                              void handlePickImages(files);
	                            }}
	                          />
	                        </label>
                        <input
                          className="mascot-chat-input"
                          placeholder={context.mode === "editing" ? `告诉${mascotDisplayName}你想改什么...` : `跟${mascotDisplayName}聊聊...`}
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleSend(); }}
                          disabled={isThinking}
                        />
                        {isThinking
                        ? <button className="mascot-chat-send" onClick={stopMascotGeneration} style={{ color: "var(--c-error, #e53e3e)" }}>■</button>
                        : <button className="mascot-chat-send" onClick={handleSend}>→</button>
                      }
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            );
          })()}
        </>
      )}

    </>
  );
}
