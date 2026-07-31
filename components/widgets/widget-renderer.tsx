"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { WidgetInstance, WidgetType } from "@/lib/widget-types";
import { WIDGET_SIZE_CELLS, WIDGET_CATALOG } from "@/lib/widget-types";
import { useMusicPlayerOptional } from "@/lib/music-context";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { ContentDialog } from "@/components/ui/modal";
import { getMascotState, activateMascot, subscribeMascot } from "@/lib/mascot-state";
import { getMascotSettingsSnapshot, resolveMascotImageRef, subscribeMascotSettings } from "@/lib/mascot-settings";
import { loadDIYTemplates } from "@/lib/widget-storage";
import { DIYWidgetRenderer } from "@/components/widgets/diy-widget-renderer";

const DEFAULT_WHITE_IMAGE =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="transparent"/></svg>';

type WidgetRendererProps = {
  widget: WidgetInstance;
  /** If true, renders a compact version for the manager preview */
  preview?: boolean;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
};

export function WidgetRenderer({ widget, preview, onConfigChange }: WidgetRendererProps) {
  const [rows, cols] = WIDGET_SIZE_CELLS[widget.size];
  const sizeClass = `widget-${widget.size}`;
  const isKawaii = ["kawaiiCat", "kawaiiBubble", "kawaiiWeather", "kawaiiDate", "kawaiiBattery", "kawaiiMusicIcon"].includes(widget.type);
  const isFullBleed = ["kawaiiMusicPlayer", "iosMenu", "mySpace", "socialPost", "photoViewer", "largeTime", "moodPill"].includes(widget.type);

  const catalogEntry = WIDGET_CATALOG.find((e) => e.type === widget.type);
  const isFreestyle = catalogEntry?.track === "freestyle" || widget.type.startsWith("diy-");

  const widgetName = catalogEntry?.name || "";

  return (
    <div
      className={`widget-wrap ${sizeClass}-wrap`}
      data-flip-id={preview ? undefined : `widget:${widget.id}`}
      style={
        preview
          ? undefined
          : {
              gridRow: `${widget.row} / span ${rows}`,
              gridColumn: `${widget.col} / span ${cols}`,
            }
      }
    >
      <div
        className={`widget-glass ${sizeClass}${preview ? " widget-preview-mode" : ""}${isKawaii ? " widget-kawaii" : ""}${isFullBleed ? " widget-full-bleed" : ""}${isFreestyle ? " widget-freestyle" : ""}`}
        data-widget-type={widget.type}
      >
        <WidgetContent
          widget={widget}
          type={widget.type}
          config={widget.config}
          preview={preview}
          widgetId={widget.id}
          onConfigChange={onConfigChange}
        />
      </div>
      {!preview && <span className="widget-label">widgets</span>}
    </div>
  );
}

function WidgetContent({
  widget,
  type,
  config,
  preview,
  widgetId,
  onConfigChange,
}: {
  widget: WidgetInstance;
  type: WidgetType;
  config?: Record<string, unknown>;
  preview?: boolean;
  widgetId: string;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
}) {
  if (type.startsWith("diy-")) {
     const templates = loadDIYTemplates();
     const t = templates.find(temp => temp.id === type);
     if (t) return <DIYWidgetRenderer widget={widget} preview={preview} template={t} onConfigChange={onConfigChange} />;
     return <div className="text-gray-400 text-xs p-2 text-center h-full flex items-center">找不到此 DIY 组件</div>;
  }

  const props = { config, widgetId, onConfigChange, preview };
  switch (type) {
    case "music":
      return <MusicWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} />;
    case "calendar":
      return <CalendarWidget />;
    case "clock":
      return <ClockWidget />;
    case "photo":
      return <PhotoWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "loveNote":
      return <LoveNoteWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} />;
    case "interviewMagazine":
      return <InterviewMagazineWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "kaomoji":
      return <KaomojiWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} />;
    case "mascot":
      return <MascotWidget />;
    case "kawaiiMusicPlayer":
      return <KawaiiMusicPlayerWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "iosMenu":
      return <IosMenuWidget />;
    case "mySpace":
      return <MySpaceWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "socialPost":
      return <SocialPostWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "coupleChat":
      return <CoupleChatWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;

    case "largeTime":
      return <LargeTimeWidget />;
    case "moodPill":
      return <MoodPillWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "vinylRecord":
      return <VinylRecordWidget />;
    case "receiptTask":
      return <ReceiptWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "ticketStub":
      return <TicketStubWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "postCard":
      return <PostcardWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "cameraFrame":
      return <CameraFrameWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "colorPickerFrame":
      return <ColorPickerFrameWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame18":
      return <FreestyleFrame18Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame4":
      return <FreestyleFrame4Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame31":
      return <FreestyleFrame31Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame33":
      return <FreestyleFrame33Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame36":
      return <FreestyleFrame36Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame49":
      return <FreestyleFrame49Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame54":
      return <FreestyleFrame54Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame68":
      return <FreestyleFrame68Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame72":
      return <FreestyleFrame72Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame88":
      return <FreestyleFrame88Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "freestyleFrame90":
      return <FreestyleFrame90Widget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    case "profileCard":
      return <ProfileCardWidget config={config} widgetId={widgetId} onConfigChange={onConfigChange} preview={preview} />;
    default:
      return null;
  }
}

// ----------------------------------------------------
//   Camera Frame Widget (Freestyle)
// ----------------------------------------------------
function CameraFrameWidget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  return (
    <div 
      className="wg-camera-frame" 
      onClick={preview ? undefined : () => triggerUpload()}
      title="点击上传取景框底图"
    >
      {input}
      <div 
        className="wg-cf-bg" 
        style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : { backgroundColor: 'transparent' }}
      />
      <div 
        className="wg-cf-overlay" 
        style={{ backgroundImage: `url('/widgets/19老橙子素材.png')` }}
      />
    </div>
  );
}

// ----------------------------------------------------
//   Color Picker Frame Widget (Freestyle)
// ----------------------------------------------------
function ColorPickerFrameWidget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  return (
    <div 
      className="wg-color-picker-frame" 
      onClick={preview ? undefined : () => triggerUpload()}
      title="点击上传底图"
    >
      {input}
      <div className="wg-cp-wrapper">
        <img 
          src="/widgets/9老橙子素材.png" 
          className="wg-cp-overlay-img" 
          alt="Color Picker Frame"
        />
        <div 
          className="wg-cp-bg" 
          style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}} 
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 18 Widget (Freestyle)
// ----------------------------------------------------
function FreestyleFrame18Widget({ config, widgetId, onConfigChange, preview }: any) {
  return (
    <div 
      className="wg-frame18" 
      title="老橙子装饰素材"
    >
      <div className="wg-f18-wrapper">
        <img 
          src="/widgets/18老橙子素材.png" 
          className="wg-f18-overlay-img" 
          alt="Frame 18"
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 4 Widget (Freestyle)
// ----------------------------------------------------
function FreestyleFrame4Widget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  return (
    <div 
      className="wg-frame4" 
      onClick={preview ? undefined : () => triggerUpload()}
      title="点击上传底图"
    >
      {input}
      <div className="wg-f4-wrapper">
        <img 
          src="/widgets/4老橙子素材.png" 
          className="wg-f4-overlay-img" 
          alt="Frame 4"
        />
        <div 
          className="wg-f4-bg" 
          style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}} 
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 31 Widget (Freestyle)
// ----------------------------------------------------
function FreestyleFrame31Widget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  return (
    <div 
      className="wg-frame31" 
      onClick={preview ? undefined : () => triggerUpload()}
      title="点击上传底图"
    >
      {input}
      <div className="wg-f31-wrapper">
        <img 
          src="/widgets/31老橙子素材.png" 
          className="wg-f31-overlay-img" 
          alt="Frame 31"
        />
        <div 
          className="wg-f31-bg" 
          style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}} 
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 33 Widget (Freestyle)
// ----------------------------------------------------
function FreestyleFrame33Widget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  return (
    <div 
      className="wg-frame33" 
      onClick={preview ? undefined : () => triggerUpload()}
      title="点击上传底图"
    >
      {input}
      <div className="wg-f33-wrapper">
        <img 
          src="/widgets/33老橙子素材.png" 
          className="wg-f33-overlay-img" 
          alt="Frame 33"
        />
        <div 
          className="wg-f33-bg" 
          style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}} 
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 36 Widget (Freestyle - No Interaction)
// ----------------------------------------------------
function FreestyleFrame36Widget(_props: {
  config?: Record<string, unknown>;
  widgetId?: string;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
  preview?: boolean;
}) {
  return (
    <div 
      className="wg-frame36" 
      title="老橙子装饰素材36"
    >
      <div className="wg-f36-wrapper">
        <img 
          src="/widgets/36老橙子素材.png" 
          className="wg-f36-overlay-img" 
          alt="Frame 36"
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 49 Widget (Freestyle)
// ----------------------------------------------------
function FreestyleFrame49Widget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  return (
    <div 
      className="wg-frame49" 
      onClick={preview ? undefined : () => triggerUpload()}
      title="点击上传底图"
    >
      {input}
      <div className="wg-f49-wrapper">
        <img 
          src="/widgets/49老橙子素材.png" 
          className="wg-f49-overlay-img" 
          alt="Frame 49"
        />
        <div 
          className="wg-f49-bg" 
          style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}} 
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 54 Widget (Freestyle)
// ----------------------------------------------------
function FreestyleFrame54Widget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  return (
    <div 
      className="wg-frame54" 
      onClick={preview ? undefined : () => triggerUpload()}
      title="点击配置右侧头像"
    >
      {input}
      <div className="wg-f54-wrapper">
        <img 
          src="/widgets/54老橙子素材.png" 
          className="wg-f54-overlay-img" 
          alt="Frame 54"
        />
        <div 
          className="wg-f54-bg" 
          style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}} 
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 68 Widget (Freestyle)
// ----------------------------------------------------
function FreestyleFrame68Widget({ config, widgetId, onConfigChange, preview }: any) {
  return (
    <div className="wg-frame68">
      <div className="wg-f68-wrapper">
        <img 
          src="/widgets/68老橙子素材.png" 
          className="wg-f68-overlay-img" 
          alt="Frame 68"
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 72 Widget (Freestyle 4×4)
// ----------------------------------------------------
function FreestyleFrame72Widget({ config, widgetId, onConfigChange, preview }: any) {
  const img1 = typeof config?.img1 === "string" ? config.img1 : "";
  const img2 = typeof config?.img2 === "string" ? config.img2 : "";
  const img3 = typeof config?.img3 === "string" ? config.img3 : "";
  const img4 = typeof config?.img4 === "string" ? config.img4 : "";

  const up1 = useImageUpload(widgetId, "img1", onConfigChange);
  const up2 = useImageUpload(widgetId, "img2", onConfigChange);
  const up3 = useImageUpload(widgetId, "img3", onConfigChange);
  const up4 = useImageUpload(widgetId, "img4", onConfigChange);
  
  return (
    <div className="wg-frame72">
      {up1.input}
      {up2.input}
      {up3.input}
      {up4.input}
      <div className="wg-f72-wrapper">
        <div 
          className="wg-f72-slot wg-f72-s1" 
          style={img1 ? { backgroundImage: `url(${img1})` } : {}}
          onClick={preview ? undefined : () => up1.triggerUpload()}
          title="点击上传左上图"
        />
        <div 
          className="wg-f72-slot wg-f72-s2" 
          style={img2 ? { backgroundImage: `url(${img2})` } : {}}
          onClick={preview ? undefined : () => up2.triggerUpload()}
          title="点击上传右上图"
        />
        <div 
          className="wg-f72-slot wg-f72-s3" 
          style={img3 ? { backgroundImage: `url(${img3})` } : {}}
          onClick={preview ? undefined : () => up3.triggerUpload()}
          title="点击上传左下图"
        />
        <div 
          className="wg-f72-slot wg-f72-s4" 
          style={img4 ? { backgroundImage: `url(${img4})` } : {}}
          onClick={preview ? undefined : () => up4.triggerUpload()}
          title="点击马上右下图"
        />
        
        <img 
          src="/widgets/72老橙子素材.png" 
          className="wg-f72-overlay-img" 
          alt="Frame 72"
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 88 Widget (Freestyle 2x4)
// ----------------------------------------------------
function FreestyleFrame88Widget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  return (
    <div 
      className="wg-frame88" 
      onClick={preview ? undefined : () => triggerUpload()}
      title="点击上传专辑封面"
    >
      {input}
      <div className="wg-f88-wrapper">
        <div 
          className="wg-f88-bg" 
          style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}} 
        />
        <img 
          src="/widgets/88老橙子素材.png" 
          className="wg-f88-overlay-img" 
          alt="Frame 88"
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Frame 90 Widget (Freestyle 2x4)
// ----------------------------------------------------
function FreestyleFrame90Widget({ config, widgetId, onConfigChange, preview }: any) {
  const img1 = typeof config?.img1 === "string" ? config.img1 : "";
  const img2 = typeof config?.img2 === "string" ? config.img2 : "";
  const img3 = typeof config?.img3 === "string" ? config.img3 : "";
  const img4 = typeof config?.img4 === "string" ? config.img4 : "";

  const up1 = useImageUpload(widgetId, "img1", onConfigChange);
  const up2 = useImageUpload(widgetId, "img2", onConfigChange);
  const up3 = useImageUpload(widgetId, "img3", onConfigChange);
  const up4 = useImageUpload(widgetId, "img4", onConfigChange);
  
  return (
    <div className="wg-frame90">
      {up1.input}
      {up2.input}
      {up3.input}
      {up4.input}
      <div className="wg-f90-wrapper">
        <div 
          className="wg-f90-slot wg-f90-s1" 
          style={img1 ? { backgroundImage: `url(${img1})` } : {}}
          onClick={preview ? undefined : () => up1.triggerUpload()}
          title="点击上传图1"
        />
        <div 
          className="wg-f90-slot wg-f90-s2" 
          style={img2 ? { backgroundImage: `url(${img2})` } : {}}
          onClick={preview ? undefined : () => up2.triggerUpload()}
          title="点击上传图2"
        />
        <div 
          className="wg-f90-slot wg-f90-s3" 
          style={img3 ? { backgroundImage: `url(${img3})` } : {}}
          onClick={preview ? undefined : () => up3.triggerUpload()}
          title="点击上传图3"
        />
        <div 
          className="wg-f90-slot wg-f90-s4" 
          style={img4 ? { backgroundImage: `url(${img4})` } : {}}
          onClick={preview ? undefined : () => up4.triggerUpload()}
          title="点击上传图4"
        />
        
        <img 
          src="/widgets/90老橙子素材.png" 
          className="wg-f90-overlay-img" 
          alt="Frame 90"
        />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Profile Card Widget (Freestyle 3x4 主页名片)
// ----------------------------------------------------
const PROFILE_CARD_DEFAULTS = {
  name: "こはる",
  handle: "SLOW DAYS",
  motto: "のんびり いこうね",
  location: "雲の上",
};

function ProfileCardWidget({ config, widgetId, onConfigChange, preview }: any) {
  const coverUrl = typeof config?.coverUrl === "string" ? config.coverUrl : "";
  const cardUrl = typeof config?.cardUrl === "string" ? config.cardUrl : "";
  const avatarUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const name = typeof config?.name === "string" ? config.name : PROFILE_CARD_DEFAULTS.name;
  const handle = typeof config?.handle === "string" ? config.handle : PROFILE_CARD_DEFAULTS.handle;
  const motto = typeof config?.motto === "string" ? config.motto : PROFILE_CARD_DEFAULTS.motto;
  const location = typeof config?.location === "string" ? config.location : PROFILE_CARD_DEFAULTS.location;

  const coverUp = useImageUpload(widgetId, "coverUrl", onConfigChange);
  const cardUp = useImageUpload(widgetId, "cardUrl", onConfigChange);
  const avatarUp = useImageUpload(widgetId, "avatarUrl", onConfigChange);

  const [showEdit, setShowEdit] = useState(false);
  const [draft, setDraft] = useState({ name, handle, motto, location });

  function openEdit(e: React.MouseEvent) {
    if (preview) return;
    e.stopPropagation();
    setDraft({ name, handle, motto, location });
    setShowEdit(true);
  }

  function handleSave() {
    onConfigChange?.(widgetId, {
      name: draft.name.trim() || PROFILE_CARD_DEFAULTS.name,
      handle: draft.handle.trim(),
      motto: draft.motto.trim(),
      location: draft.location.trim(),
    });
    setShowEdit(false);
  }

  const editFieldLabel = {
    fontSize: "calc(13px*var(--app-text-scale,1))",
    color: "var(--c-text)",
    margin: "10px 0 4px",
    display: "block",
  } as React.CSSProperties;

  return (
    <div className="wg-profile-card">
      {coverUp.input}
      {cardUp.input}
      {avatarUp.input}
      <div
        className="wg-pc-cover"
        style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : undefined}
        onClick={preview ? undefined : () => coverUp.triggerUpload()}
        title="点击更换上方背景图"
      />
      <div
        className="wg-pc-body"
        style={cardUrl ? { backgroundImage: `url(${cardUrl})` } : undefined}
        onClick={preview ? undefined : () => cardUp.triggerUpload()}
        title="点击更换下方背景图"
      >
        <div
          className="wg-pc-texts"
          onClick={openEdit}
          role={preview ? undefined : "button"}
          tabIndex={preview ? undefined : 0}
          title="点击编辑文字"
        >
          <div className="wg-pc-name">{name}</div>
          {handle && <div className="wg-pc-handle">{handle}</div>}
          {motto && <div className="wg-pc-motto">{motto}</div>}
          {location && (
            <div className="wg-pc-location">
              <svg viewBox="0 0 24 24" width="11" height="11" className="wg-pc-pin" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"
                />
              </svg>
              <span>{location}</span>
            </div>
          )}
        </div>
      </div>
      <div
        className="wg-pc-avatar"
        onClick={preview ? undefined : (e) => { e.stopPropagation(); avatarUp.triggerUpload(); }}
        role={preview ? undefined : "button"}
        tabIndex={preview ? undefined : 0}
        title="点击更换头像"
      >
        {avatarUrl
          ? <img src={avatarUrl} alt="" className="wg-pc-avatar-img" />
          : <div className="wg-pc-avatar-mock"><span className="wg-upload-hint">头像</span></div>}
      </div>

      {showEdit && !preview && createPortal(
        <ContentDialog
          title="编辑名片文字"
          onConfirm={handleSave}
          onCancel={() => setShowEdit(false)}
        >
          <label style={{ ...editFieldLabel, marginTop: 0 }}>名字</label>
          <input
            className="ui-input"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={PROFILE_CARD_DEFAULTS.name}
            style={{ width: "100%" }}
          />
          <label style={editFieldLabel}>小标题（留空隐藏）</label>
          <input
            className="ui-input"
            value={draft.handle}
            onChange={(e) => setDraft({ ...draft, handle: e.target.value })}
            placeholder={PROFILE_CARD_DEFAULTS.handle}
            style={{ width: "100%" }}
          />
          <label style={editFieldLabel}>签名（留空隐藏）</label>
          <input
            className="ui-input"
            value={draft.motto}
            onChange={(e) => setDraft({ ...draft, motto: e.target.value })}
            placeholder={PROFILE_CARD_DEFAULTS.motto}
            style={{ width: "100%" }}
          />
          <label style={editFieldLabel}>位置（留空隐藏）</label>
          <input
            className="ui-input"
            value={draft.location}
            onChange={(e) => setDraft({ ...draft, location: e.target.value })}
            placeholder={PROFILE_CARD_DEFAULTS.location}
            style={{ width: "100%" }}
          />
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
    </div>
  );
}

// ----------------------------------------------------
//   My Space Personal Profile Widget (2×2)
// ----------------------------------------------------

function MySpaceWidget({ config, widgetId, onConfigChange, preview }: any) {
  const avatarUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : undefined;
  const username = typeof config?.username === "string" ? config.username : "OLD ORANGE";
  
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  const [showEdit, setShowEdit] = useState(false);
  const [editText, setEditText] = useState(username);

  function handleNameClick(e: React.MouseEvent) {
    if (preview) return;
    e.stopPropagation();
    setEditText(username);
    setShowEdit(true);
  }

  function handleSave() {
    onConfigChange?.(widgetId, { ...config, username: editText.trim() || "OLD ORANGE" });
    setShowEdit(false);
  }

  return (
    <div className="wg-my-space">
      {input}
      <div className="wg-ms-top">
        <svg viewBox="0 0 13.9 13.9" width="16" height="16" className="wg-ms-icon wg-ms-icon-user">
          <g>
            <path d="M0.6,12.8c-0.3,0-0.6-0.3-0.6-0.6c0-2.5,2.3-4.5,5.2-4.5c1,0,2,0.3,2.9,0.8C8.4,8.7,8.5,9,8.3,9.3 C8.1,9.5,7.8,9.6,7.5,9.5C6.8,9.1,6,8.9,5.2,8.9c-2.2,0-4.1,1.5-4.1,3.4C1.1,12.6,0.9,12.8,0.6,12.8z"/>
            <path d="M10.7,13.9c-0.3,0-0.6-0.3-0.6-0.6V8c0-0.3,0.3-0.6,0.6-0.6c0.3,0,0.6,0.3,0.6,0.6v5.3C11.3,13.7,11,13.9,10.7,13.9z"/>
            <path d="M13.4,11.2H8c-0.3,0-0.6-0.3-0.6-0.6c0-0.3,0.3-0.6,0.6-0.6h5.3c0.3,0,0.6,0.3,0.6,0.6C13.9,11,13.7,11.2,13.4,11.2z"/>
            <path d="M5.3,6.8c-1.9,0-3.4-1.5-3.4-3.4S3.5,0,5.3,0c1.9,0,3.4,1.5,3.4,3.4S7.2,6.8,5.3,6.8z M5.3,1.1c-1.3,0-2.3,1-2.3,2.3 s1,2.3,2.3,2.3c1.3,0,2.3-1,2.3-2.3S6.6,1.1,5.3,1.1z"/>
          </g>
        </svg>

        <div className="wg-ms-title">*｡My Space｡*</div>

        <div className="wg-ms-top-right">
          <svg viewBox="0 0 13.2 9.8" width="16" height="12" className="wg-ms-icon wg-ms-icon-mail">
            <path fill="var(--c-home-text)" d="M1.2,0l10.7,0c0.6,0,1.1,0.5,1.2,1.1c0.1,2.5,0,4.9,0,7.4c0,0.7-0.6,1.2-1.3,1.3H1.3C0.6,9.7,0.1,9.2,0,8.5 l0-7.2C0.1,0.6,0.6,0.1,1.2,0z M10.8,1.2H2.4l0,0c1.4,1.2,2.8,2.3,4.2,3.5L10.8,1.2z M11.9,2L7,6.1c-0.2,0.1-0.5,0.2-0.7,0L1.3,2 v6.5c0,0,0,0,0.1,0.1l10.6,0c0,0,0.1,0,0.1,0V2z"/>
          </svg>
          <svg viewBox="0 0 14 10" width="16" height="12" className="wg-ms-icon wg-ms-icon-menu" fill="none" stroke="var(--c-home-text)" strokeWidth="1.8" strokeLinecap="round">
            <path d="M1 1h12 M1 5h12 M1 9h12" />
          </svg>
        </div>
      </div>
      
      <div className="wg-ms-center">
        <div 
           className="wg-ms-avatar" 
           onClick={preview ? undefined : triggerUpload}
           role={preview ? undefined : "button"}
           tabIndex={preview ? undefined : 0}
        >
          {avatarUrl ? <img src={avatarUrl} alt="" className="wg-ms-avatar-img"/> : <div className="wg-ms-avatar-mock"><span className="wg-upload-hint">点击换图</span></div>}
        </div>
        <div className="wg-ms-name" onClick={handleNameClick} role={preview ? undefined : "button"} tabIndex={preview ? undefined : 0}>
          @{username}
        </div>
      </div>

      <div className="wg-ms-bottom">
        <div className="wg-ms-stat"><span className="wg-ms-stat-num">23876</span><span className="wg-ms-stat-label">Following</span></div>
        <div className="wg-ms-stat"><span className="wg-ms-stat-num">4598</span><span className="wg-ms-stat-label">Follower</span></div>
        <div className="wg-ms-stat"><span className="wg-ms-stat-num">9999+</span><span className="wg-ms-stat-label">Like</span></div>
      </div>

      {showEdit && !preview && createPortal(
        <ContentDialog
          title="修改空间昵称"
          onConfirm={handleSave}
          onCancel={() => setShowEdit(false)}
        >
          <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)", marginBottom: 4, display: "block" }}>输入新昵称</label>
          <input
            className="ui-input"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder="OLD ORANGE"
            style={{ width: "100%" }}
          />
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
    </div>
  );
}

// ----------------------------------------------------
//   Social Post Widget (4×4)
// ----------------------------------------------------

function SocialPostWidget({ config, widgetId, onConfigChange, preview }: any) {
  const avatarUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : undefined;
  const postImageUrl = typeof config?.postImageUrl === "string" ? config.postImageUrl : undefined;
  const username = typeof config?.username === "string" ? config.username : "YOUR NAME";
  
  const { triggerUpload: triggerAvatar, input: avatarInput } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  const { triggerUpload: triggerPost, input: postInput } = useImageUpload(widgetId, "postImageUrl", onConfigChange);
  
  const [showEdit, setShowEdit] = useState(false);
  const [editText, setEditText] = useState(username);

  function handleNameClick(e: React.MouseEvent) {
    if (preview) return;
    e.stopPropagation();
    setEditText(username);
    setShowEdit(true);
  }

  function handleSave() {
    onConfigChange?.(widgetId, { ...config, username: editText.trim() || "YOUR NAME" });
    setShowEdit(false);
  }

  return (
    <div className="wg-sp-card">
      {avatarInput}
      {postInput}
      
      <div className="wg-sp-header">
        <div className="wg-sp-avatar" onClick={preview ? undefined : triggerAvatar} role={preview ? undefined : "button"} tabIndex={preview ? undefined : 0}>
          {avatarUrl ? <img src={avatarUrl} alt=""/> : <div className="wg-sp-avatar-mock"><span className="wg-upload-hint" style={{fontSize: "calc(8px*var(--app-text-scale,1))"}}>换图</span></div>}
        </div>
        <div className="wg-sp-user-info" onClick={handleNameClick} role={preview ? undefined : "button"} tabIndex={preview ? undefined : 0}>
          <div className="wg-sp-username">{username}</div>
          <div className="wg-sp-subtitle">Hi THIS IS MY SPACE</div>
        </div>
        <div className="wg-sp-more">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--c-home-sub)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
            <circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/>
          </svg>
        </div>
      </div>
      
      <div className="wg-sp-post-image" onClick={preview ? undefined : triggerPost} role={preview ? undefined : "button"} tabIndex={preview ? undefined : 0}>
        {postImageUrl ? <img src={postImageUrl} alt=""/> : <div className="wg-sp-post-mock"><span className="wg-upload-hint">点击换图</span></div>}
      </div>
      
      <div className="wg-sp-likes">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--c-home-pink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
        <span>999+</span>
      </div>
      
      <div className="wg-sp-actions">
        <div className="wg-sp-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>
          100
        </div>
        <div className="wg-sp-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
          100
        </div>
        <div className="wg-sp-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14"><polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path></svg>
          100
        </div>
      </div>

      {showEdit && !preview && createPortal(
        <ContentDialog
          title="修改发帖人昵称"
          onConfirm={handleSave}
          onCancel={() => setShowEdit(false)}
        >
          <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)", marginBottom: 4, display: "block" }}>输入新昵称</label>
          <input
            className="ui-input"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder="YOUR NAME"
            style={{ width: "100%" }}
          />
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
    </div>
  );
}

// ----------------------------------------------------
//   Retro Menu Widget (3×4)
// ----------------------------------------------------

function useImageUpload(
  widgetId: string,
  configKey: string,
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void
) {
  const fileRef = useRef<HTMLInputElement>(null);

  function triggerUpload() {
    fileRef.current?.click();
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Resize to max 800px for widget use to support retina displays
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
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        onConfigChange?.(widgetId, { [configKey]: dataUrl });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    // Reset so same file can be re-selected
    e.target.value = "";
  }

  const input = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={handleFile}
    />
  );

  return { triggerUpload, input };
}

/* ══════════════════════════════════════════
   1. Anniversary — 恋爱纪念日 (2x2)
   ══════════════════════════════════════════ */
function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function MusicWidget({
  config,
  widgetId,
  onConfigChange,
}: {
  config?: Record<string, unknown>;
  widgetId: string;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
}) {
  const player = useMusicPlayerOptional();
  const track = player?.currentTrack;
  const isPlaying = player?.isPlaying ?? false;
  const currentTime = player?.currentTime ?? 0;
  const duration = player?.duration ?? 0;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const customTitle = typeof config?.placeholderTitle === "string" ? config.placeholderTitle : "";
  const customArtist = typeof config?.placeholderArtist === "string" ? config.placeholderArtist : "";
  const placeholderTitle = customTitle || "\u6682\u65E0\u64AD\u653E";
  const placeholderArtist = customArtist || "\u70B9\u51FB\u64AD\u653E\u97F3\u4E50";

  const [showEdit, setShowEdit] = useState(false);
  const [editTitle, setEditTitle] = useState(customTitle);
  const [editArtist, setEditArtist] = useState(customArtist);

  function handlePlaceholderClick(e: React.MouseEvent) {
    if (track) return; // has real track, don't edit
    e.stopPropagation();
    setEditTitle(customTitle);
    setEditArtist(customArtist);
    setShowEdit(true);
  }

  function handleSave() {
    onConfigChange?.(widgetId, {
      ...config,
      placeholderTitle: editTitle.trim(),
      placeholderArtist: editArtist.trim(),
    });
    setShowEdit(false);
  }

  return (
    <>
      <div className="wg-music" onClick={() => player?.openFullPlayer()}>
        <div className="wg-music-disc" {...(isPlaying ? { "data-spinning": "" } : {})}>
          <div className="wg-music-disc-inner">
            {track?.coverUrl ? (
              <img src={track.coverUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
            ) : (
              <svg viewBox="0 0 80 80" className="wg-music-disc-svg">
                <circle cx="40" cy="40" r="38" fill="rgba(0,0,0,0.06)" />
                <circle cx="40" cy="40" r="28" fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth="0.5" />
                <circle cx="40" cy="40" r="18" fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth="0.5" />
                <circle cx="40" cy="40" r="8" fill="rgba(0,0,0,0.08)" />
                <circle cx="40" cy="40" r="3" fill="rgba(0,0,0,0.12)" />
              </svg>
            )}
          </div>
        </div>
        <div className="wg-music-info">
          <span className="wg-music-title" onClick={!track ? handlePlaceholderClick : undefined}>{track?.title ?? placeholderTitle}</span>
          <span className="wg-music-artist" onClick={!track ? handlePlaceholderClick : undefined}>{track?.artist ?? placeholderArtist}</span>
          <div className="wg-music-progress">
            <div className="wg-music-bar">
              <div className="wg-music-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="wg-music-times">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
          <div className="wg-music-controls">
            <button type="button" onClick={(e) => { e.stopPropagation(); player?.prev(); }}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="19,20 9,12 19,4" /><line x1="5" y1="19" x2="5" y2="5" /></svg>
            </button>
            <button type="button" className="wg-music-play-btn" onClick={(e) => { e.stopPropagation(); player?.togglePlay(); }}>
              {isPlaying ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7L8 5z" /></svg>
              )}
            </button>
            <button type="button" onClick={(e) => { e.stopPropagation(); player?.next(); }}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5,4 15,12 5,20" /><line x1="19" y1="5" x2="19" y2="19" /></svg>
            </button>
          </div>
        </div>
      </div>
      {showEdit && createPortal(
        <ContentDialog
          title={"\u7F16\u8F91\u663E\u793A\u6587\u5B57"}
          onConfirm={handleSave}
          onCancel={() => setShowEdit(false)}
        >
          <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)", marginBottom: 4, display: "block" }}>{"\u6807\u9898"}</label>
          <input
            className="ui-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder={"\u6682\u65E0\u64AD\u653E"}
            style={{ width: "100%", marginBottom: 12 }}
          />
          <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)", marginBottom: 4, display: "block" }}>{"\u526F\u6807\u9898"}</label>
          <input
            className="ui-input"
            value={editArtist}
            onChange={(e) => setEditArtist(e.target.value)}
            placeholder={"\u70B9\u51FB\u64AD\u653E\u97F3\u4E50"}
            style={{ width: "100%" }}
          />
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
    </>
  );
}

/* ══════════════════════════════════════════
   3. Calendar — 日历 (2x2)
   ══════════════════════════════════════════ */
function CalendarWidget() {
  const now = new Date();
  const year = now.getFullYear();
  const monthNum = now.getMonth() + 1;
  const day = now.getDate();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayEng = weekdays[now.getDay()];

  return (
    <div className="wg-calendar">
      <div className="wg-calendar-header">
        <div className="wg-calendar-header-glass">
          <span className="wg-calendar-ym">{year}{"\u5E74"}{monthNum}{"\u6708"}</span>
        </div>
      </div>
      <div className="wg-calendar-grid">
        {["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"].map((d) => (
          <span key={d} className="wg-cal-head">{d}</span>
        ))}
        {Array.from({ length: firstDay }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => (
          <span
            key={i + 1}
            className={i + 1 === day ? "wg-cal-day wg-cal-today" : "wg-cal-day"}
          >
            {i + 1}
          </span>
        ))}
      </div>
      <span className="wg-calendar-eng">{"today is "}{weekdayEng}</span>
    </div>
  );
}

/* ══════════════════════════════════════════
   4. Clock + Date — 时钟+日期 (2x2)
   ══════════════════════════════════════════ */
function ClockWidget() {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const h = String(time.getHours()).padStart(2, "0");
  const m = String(time.getMinutes()).padStart(2, "0");
  const month = time.getMonth() + 1;
  const day = time.getDate();
  const weekdaysCn = ["\u65E5", "\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4E94", "\u516D"];
  const weekday = "\u5468" + weekdaysCn[time.getDay()];

  return (
    <div className="wg-clock">
      <div className="wg-clock-top">
        <span className="wg-clock-date">{month}{"月"}{day}{"日"}</span>
        <span className="wg-clock-weekday">{weekday}</span>
      </div>
      <div className="wg-clock-time-row">
        <span className="wg-clock-h">{h}</span>
        <span className="wg-clock-colon">:</span>
        <span className="wg-clock-m">{m}</span>
      </div>
      <div className="wg-clock-bottom">
        <div className="wg-clock-line" />
        <span className="wg-clock-eng">have a nice day</span>
        <div className="wg-clock-line" />
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   5.5. Large Time — 极简大屏数字时钟 (4x2)
   ══════════════════════════════════════════ */
function LargeTimeWidget() {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const h = String(time.getHours()).padStart(2, "0");
  const m = String(time.getMinutes()).padStart(2, "0");
  const month = time.getMonth() + 1;
  const day = time.getDate();
  const weekdaysCn = ["日", "一", "二", "三", "四", "五", "六"];
  const weekday = "周" + weekdaysCn[time.getDay()];

  return (
    <div className="wg-large-time">
      <div className="wg-lt-date">
        {month}月{day}日 {weekday}
      </div>
      <div className="wg-lt-time">
        {h}:{m}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   5. Photo Frame — 照片相框 (2x2)
   ══════════════════════════════════════════ */
function PhotoWidget({
  config,
  widgetId,
  onConfigChange,
  preview,
}: {
  config?: Record<string, unknown>;
  widgetId: string;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
  preview?: boolean;
}) {
  const imageDataUrl = typeof config?.imageDataUrl === "string" ? config.imageDataUrl : undefined;
  const { triggerUpload, input } = useImageUpload(widgetId, "imageDataUrl", onConfigChange);
  const displayImageUrl = imageDataUrl ?? DEFAULT_WHITE_IMAGE;

  return (
    <div className="wg-photo" onClick={preview ? undefined : triggerUpload} role={preview ? undefined : "button"} tabIndex={preview ? undefined : 0}>
      {input}
      {imageDataUrl ? (
        <img src={imageDataUrl} alt="" className="wg-photo-img" />
      ) : (
        <div className="wg-photo-placeholder"><span className="wg-upload-hint">点击换图</span></div>
      )}
      <div className="wg-photo-deco">
        <svg viewBox="0 0 20 20" width="14" height="14">
          <path d="M10 18s-7-5-7-10c0-3 2-5 4-5 1 0 2 .5 3 1.5 1-1 2-1.5 3-1.5 2 0 4 2 4 5 0 5-7 10-7 10z" fill="currentColor" />
        </svg>
      </div>
      <div className="wg-photo-corner wg-photo-corner-tl" />
      <div className="wg-photo-corner wg-photo-corner-br" />
    </div>
  );
}

/* ══════════════════════════════════════════
   Love Note — 情话便签 (2x2)
   ══════════════════════════════════════════ */
const LOVE_NOTES_DEFAULT = [
  "\u4F60\u662F\u6211\u6700\u7F8E\u7684\u76F8\u9047",
  "\u6BCF\u5929\u90FD\u60F3\u548C\u4F60\u5728\u4E00\u8D77",
  "\u4F60\u7684\u7B11\u5BB9\u662F\u6211\u7684\u5168\u4E16\u754C",
  "\u60F3\u548C\u4F60\u8D70\u904D\u6BCF\u4E00\u4E2A\u89D2\u843D",
  "\u6709\u4F60\u7684\u65E5\u5B50\u90FD\u662F\u6674\u5929",
  "\u4F60\u662F\u6211\u5199\u4E0D\u5B8C\u7684\u6E29\u67D4",
];

function LoveNoteWidget({
  config,
  widgetId,
  onConfigChange,
}: {
  config?: Record<string, unknown>;
  widgetId: string;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
}) {
  const [noteIdx] = useState(() => Math.floor(Math.random() * LOVE_NOTES_DEFAULT.length));
  const customText = typeof config?.text === "string" ? config.text : "";
  const noteText = customText || LOVE_NOTES_DEFAULT[noteIdx];

  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  const [showEdit, setShowEdit] = useState(false);
  const [editText, setEditText] = useState(customText);

  function handleTextClick(e: React.MouseEvent) {
    e.stopPropagation();
    setEditText(customText);
    setShowEdit(true);
  }

  function handleSave() {
    onConfigChange?.(widgetId, { ...config, text: editText.trim() });
    setShowEdit(false);
  }

  return (
    <>
      <div className="wg-lovenote">
        <div className="wg-lovenote-top">
          <span className="wg-lovenote-eng">love note</span>
          <span className="wg-lovenote-date">{month}.{day}</span>
        </div>
        <div className="wg-lovenote-body" onClick={handleTextClick} role="button" tabIndex={0}>
          <span className="wg-lovenote-quote">{"\u201C"}</span>
          <span className="wg-lovenote-text">{noteText}</span>
          <span className="wg-lovenote-quote">{"\u201D"}</span>
        </div>
        <div className="wg-lovenote-footer">
          <div className="wg-lovenote-line" />
          <svg viewBox="0 0 20 20" width="14" height="14">
            <path d="M10 18s-7-5-7-10c0-3 2-5 4-5 1 0 2 .5 3 1.5 1-1 2-1.5 3-1.5 2 0 4 2 4 5 0 5-7 10-7 10z" fill="currentColor" />
          </svg>
          <div className="wg-lovenote-line" />
        </div>
      </div>
      {showEdit && createPortal(
        <ContentDialog
          title={"\u7F16\u8F91\u60C5\u8BDD"}
          onConfirm={handleSave}
          onCancel={() => setShowEdit(false)}
        >
          <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)", marginBottom: 4, display: "block" }}>{"\u60C5\u8BDD\u5185\u5BB9"}</label>
          <input
            className="ui-input"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder={LOVE_NOTES_DEFAULT[noteIdx]}
            style={{ width: "100%" }}
          />
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
    </>
  );
}

/* ══════════════════════════════════════════
   Interview Magazine — 在场摘录 (2x4)
   ══════════════════════════════════════════ */
const INTERVIEW_MAGAZINE_LINES = [
  { title: "夜谈", meta: "ON RECORD" },
  { title: "侧写", meta: "PROFILE" },
  { title: "问答", meta: "Q & A" },
  { title: "成刊", meta: "IN PRESS" },
  { title: "在场", meta: "PRESENCE" },
];

const INTERVIEW_MAGAZINE_QUOTES = [
  "每个人都值得被认真采访一次",
  "把沉默留给版心，把答案交给夜晚",
  "问题抵达之前，人物已经在场",
  "一句回答，也可以成为封面",
  "所有细节都等着被照亮",
];

function InterviewMagazineWidget({
  config,
  widgetId,
  onConfigChange,
  preview,
}: {
  config?: Record<string, unknown>;
  widgetId: string;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
  preview?: boolean;
}) {
  const [flipped, setFlipped] = useState(false);
  const [lineIdx] = useState(() => Math.floor(Math.random() * INTERVIEW_MAGAZINE_LINES.length));
  const line = INTERVIEW_MAGAZINE_LINES[lineIdx];
  const quote = INTERVIEW_MAGAZINE_QUOTES[lineIdx];
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const imageDataUrl = typeof config?.imageDataUrl === "string" ? config.imageDataUrl : undefined;
  const { triggerUpload, input } = useImageUpload(widgetId, "imageDataUrl", onConfigChange);
  const displayImageUrl = imageDataUrl ?? DEFAULT_WHITE_IMAGE;

  return (
    <div className="wg-interview-magazine">
      {input}
      <div className="wg-interview-magazine-photo" onClick={preview ? undefined : (e) => { e.stopPropagation(); triggerUpload(); }} role={preview ? undefined : "button"} tabIndex={preview ? undefined : 0}>
        <img src={displayImageUrl} alt="" className="wg-interview-magazine-photo-img" />
        {!imageDataUrl && <span className="wg-interview-magazine-photo-hint">点击换图</span>}
      </div>
      <div className="wg-interview-magazine-right" onClick={() => setFlipped((f) => !f)} role="button" tabIndex={0}>
        <div className={`wg-interview-magazine-card${flipped ? " wg-interview-magazine-flipped" : ""}`}>
          <div className="wg-interview-magazine-front">
            <span className="wg-interview-magazine-front-date">{month}.{day}</span>
            <span className="wg-interview-magazine-front-title">在场</span>
            <span className="wg-interview-magazine-front-eng">presence</span>
            <span className="wg-interview-magazine-front-hint">- 轻触翻页 -</span>
          </div>
          <div className="wg-interview-magazine-back">
            <span className="wg-interview-magazine-level">{line.title}</span>
            <div className="wg-interview-magazine-divider" />
            <div className="wg-interview-magazine-details">
              <span>{line.meta}</span>
              <span>ISSUE NOTES</span>
            </div>
            <span className="wg-interview-magazine-saying">“{quote}”</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   11. Kaomoji Status Bar — 颜文字状态栏 (1x4)
   ══════════════════════════════════════════ */
const KAOMOJI_SETS = [
  "Ω · ♡\uFE0E · ᶘ ᵒᴥᵒᶅ · ˖ ✧",
  "♪ · ₍ᐢ..ᐢ₎ · ☁\uFE0E · ◌",
  "✿\uFE0E · (ᵔᴥᵔ) · ☆\uFE0E · ♩",
  "❀\uFE0E · ᶘ ᵒ㉨ᵒᶅ · ˚ · ⋆",
  "♡\uFE0E · ʕ•ᴥ•ʔ · ✦ · ₊˚",
];

const GREETING_TEXT = "every day is a sweet dream";

function KaomojiWidget({
  config,
  widgetId,
  onConfigChange,
}: {
  config?: Record<string, unknown>;
  widgetId: string;
  onConfigChange?: (widgetId: string, config: Record<string, unknown>) => void;
}) {
  const [time, setTime] = useState(() => new Date());
  const [kaomojiIdx] = useState(() => Math.floor(Math.random() * KAOMOJI_SETS.length));
  const [identity] = useState(() => resolveUserIdentity());

  const customGreeting = typeof config?.greeting === "string" ? config.greeting : "";
  const greetingText = customGreeting || GREETING_TEXT;

  const [showEdit, setShowEdit] = useState(false);
  const [editGreeting, setEditGreeting] = useState(customGreeting);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const month = String(time.getMonth() + 1).padStart(2, "0");
  const day = String(time.getDate()).padStart(2, "0");
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekday = weekdays[time.getDay()];

  function handleGreetingClick(e: React.MouseEvent) {
    e.stopPropagation();
    setEditGreeting(customGreeting);
    setShowEdit(true);
  }

  function handleSave() {
    onConfigChange?.(widgetId, { ...config, greeting: editGreeting.trim() });
    setShowEdit(false);
  }

  return (
    <>
      <div className="wg-kaomoji">
        <div className="wg-kaomoji-avatar">
          {identity?.avatarUrl ? (
            <img src={identity.avatarUrl} alt="" />
          ) : (
            <svg viewBox="0 0 24 24" width="100%" height="100%">
              <circle cx="12" cy="9" r="4" fill="rgba(255,255,255,0.6)" />
              <path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="rgba(255,255,255,0.4)" />
            </svg>
          )}
        </div>
        <div className="wg-kaomoji-center">
          <div className="wg-kaomoji-top">
            <span className="wg-kaomoji-date">{month}-{day}  {weekday}</span>
            <span className="wg-kaomoji-face">{KAOMOJI_SETS[kaomojiIdx]}</span>
          </div>
          <span className="wg-kaomoji-greeting" onClick={handleGreetingClick}>{greetingText}</span>
        </div>
        <svg className="wg-kaomoji-heart" viewBox="0 0 16 16" width="14" height="14">
          <path d="M8 14s-6-4-6-8c0-2.5 1.5-4 3.5-4 1 0 2 .5 2.5 1.5C8.5 2.5 9.5 2 10.5 2 12.5 2 14 3.5 14 6c0 4-6 8-6 8z" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </div>
      {showEdit && createPortal(
        <ContentDialog
          title={"\u7F16\u8F91\u72B6\u6001\u6587\u5B57"}
          onConfirm={handleSave}
          onCancel={() => setShowEdit(false)}
        >
          <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)", marginBottom: 4, display: "block" }}>{"\u72B6\u6001\u6587\u5B57"}</label>
          <input
            className="ui-input"
            value={editGreeting}
            onChange={(e) => setEditGreeting(e.target.value)}
            placeholder={GREETING_TEXT}
            style={{ width: "100%" }}
          />
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
    </>
  );
}

/* ══════════════════════════════════════════
   12. Time & Date — 时间日期 (3x4)
   ══════════════════════════════════════════ */
function MascotWidget() {
  const elRef = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(subscribeMascot, getMascotState, () => "widget" as const);
  const mascotSettings = useSyncExternalStore(subscribeMascotSettings, getMascotSettingsSnapshot, getMascotSettingsSnapshot);
  const [mascotAvatarUrl, setMascotAvatarUrl] = useState(mascotSettings.avatarImage || "/mascot.png");
  const isFloating = state !== "widget";

  useEffect(() => {
    let cancelled = false;
    resolveMascotImageRef(mascotSettings.avatarImage).then((url) => {
      if (!cancelled) setMascotAvatarUrl(url);
    });
    return () => { cancelled = true; };
  }, [mascotSettings.avatarImage]);

  const handleClick = () => {
    if (isFloating) return;
    const el = elRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Defer activation to avoid layout thrash during click
    requestAnimationFrame(() => activateMascot(rect));
  };

  return (
    <div
      ref={elRef}
      onClick={(e) => { e.stopPropagation(); handleClick(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      style={{ position: "absolute", inset: 0, cursor: "pointer", zIndex: 2 }}
    >
      <style>{`
        .wg-mascot {
          width: 100%;
          height: 100%;
          border-radius: 18px;
          background: linear-gradient(135deg, rgba(200,180,240,0.12) 0%, rgba(255,200,220,0.08) 50%, rgba(160,140,220,0.06) 100%);
          border: none;
          box-shadow: 0 0 12px rgba(200,180,240,0.08), inset 0 0 20px rgba(200,180,240,0.04);
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
        }
        /* ── Roof decoration ── */
        .wg-mascot::before {
          content: "⌂";
          position: absolute;
          top: -12px;
          left: 50%;
          transform: translateX(-50%);
          font-size: calc(18px*var(--app-text-scale,1));
          color: rgba(200,180,240,0.35);
          text-shadow: 0 0 6px rgba(200,180,240,0.15);
          z-index: 2;
        }
        /* ── Border glow corners ── */
        .wg-mascot::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: 18px;
          border: 1.5px solid transparent;
          background: linear-gradient(135deg, rgba(200,180,240,0.3), rgba(255,200,220,0.2), rgba(160,200,240,0.3), rgba(200,180,240,0.3)) border-box;
          -webkit-mask: linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
        }
        .wg-mascot[data-active="true"] { opacity: 0.3; }
        .wg-mascot-img {
          height: 85%;
          max-width: 85%;
          margin-top: 20px;
          pointer-events: none;
          -webkit-user-drag: none;
          object-fit: contain;
          filter: drop-shadow(0 2px 6px rgba(200,180,240,0.3));
          animation: wg-mascot-bounce 3s ease-in-out infinite;
        }
        @keyframes wg-mascot-bounce {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          25% { transform: translateY(-3px) rotate(-2deg); }
          75% { transform: translateY(-3px) rotate(2deg); }
        }
        .wg-mascot-bubble {
          position: absolute;
          top: 2px;
          left: 0;
          right: 0;
          text-align: center;
          padding: 5px 0;
          font-size: calc(10px*var(--app-text-scale,1));
          color: rgba(255,255,255,0.75);
          letter-spacing: 0.04em;
          animation: wg-mascot-bubble-in 0.5s ease 0.3s both;
        }
        .wg-mascot-bubble span {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 12px;
          background: rgba(80, 60, 140, 0.45);
          border: 1px solid rgba(200,180,240,0.25);
          white-space: nowrap;
          color: rgba(255,255,255,0.9);
          position: relative;
          font-family: "Zpix", "Press Start 2P", monospace;
          font-size: calc(10px*var(--app-text-scale,1));
          letter-spacing: 0.04em;
          text-shadow: 0 1px 0 rgba(0,0,0,0.3);
        }
        .wg-mascot-bubble span::after {
          content: "";
          position: absolute;
          bottom: -6px;
          left: 50%;
          transform: translateX(-50%);
          width: 0;
          height: 0;
          border-left: 5px solid transparent;
          border-right: 5px solid transparent;
          border-top: 6px solid rgba(80, 60, 140, 0.45);
        }
        @keyframes wg-mascot-bubble-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .wg-mascot-sparkle {
          position: absolute; width: 6px; height: 6px;
          border-radius: 50%; background: rgba(200,180,240,0.5);
          animation: wg-mascot-sparkle 2s ease-in-out infinite;
          box-shadow: 0 0 4px rgba(200,180,240,0.3);
        }
        @keyframes wg-mascot-sparkle {
          0%, 100% { opacity: 0; transform: scale(0) rotate(0deg); }
          50% { opacity: 1; transform: scale(1) rotate(180deg); }
        }
        .wg-mascot-star {
          position: absolute;
          font-size: calc(10px*var(--app-text-scale,1));
          color: rgba(200,180,240,0.3);
          animation: wg-mascot-star-float 4s ease-in-out infinite;
        }
        @keyframes wg-mascot-star-float {
          0%, 100% { opacity: 0.3; transform: translateY(0) scale(0.8); }
          50% { opacity: 0.6; transform: translateY(-3px) scale(1.1); }
        }
      `}</style>
      <div className="wg-mascot" data-active={isFloating ? "true" : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="wg-mascot-img" src={mascotAvatarUrl} alt={mascotSettings.nickname || "AI助手"} />
        <div className="wg-mascot-bubble">
          <span>{isFloating ? "✦ 在线中~" : "✦ 点击召唤我哦~ ♡"}</span>
        </div>
        <div className="wg-mascot-sparkle" style={{ top: "18%", left: "12%", animationDelay: "0s" }} />
        <div className="wg-mascot-sparkle" style={{ top: "40%", right: "10%", animationDelay: "0.7s" }} />
        <div className="wg-mascot-sparkle" style={{ bottom: "25%", left: "10%", animationDelay: "1.4s" }} />
        <span className="wg-mascot-star" style={{ top: "30%", left: "8%", animationDelay: "0.3s" }}>✦</span>
        <span className="wg-mascot-star" style={{ bottom: "20%", right: "8%", animationDelay: "1.8s" }}>♡</span>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   🌸 KAWAII AESTHETIC SERIES 
   ══════════════════════════════════════════ */

function KawaiiMusicPlayerWidget({ config, widgetId, onConfigChange, preview }: any) {
  const albumUrl = typeof config?.albumUrl === "string" ? config.albumUrl : undefined;
  const { triggerUpload, input } = useImageUpload(widgetId, "albumUrl", onConfigChange);
  return (
    <div className="wg-kw-music-player">
      {input}
      <div className="kwmp-header">
        <div className="kwmp-album-art" onClick={preview ? undefined : triggerUpload} role={preview ? undefined : "button"} tabIndex={preview ? undefined : 0}>
          {albumUrl ? <img src={albumUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"inherit"}} /> : <span className="wg-upload-hint" style={{fontSize: "calc(8px*var(--app-text-scale,1))"}}>换图</span>}
        </div>
        <div className="kwmp-info">
          <div className="kwmp-info-top">
             <span className="kwmp-title">How I Wish You Were Her</span>
          </div>
          <span className="kwmp-sub">(✿╹◡╹)ﾉ☆.。.:*°。</span>
        </div>
        <div className="kwmp-eq">
           <svg viewBox="0 0 19.7 13.4" fill="currentColor">
              <path d="M9.7,13.4L9.7,13.4c-0.8,0-1.4-0.6-1.4-1.4V1.4C8.3,0.6,8.9,0,9.7,0l0,0c0.8,0,1.4,0.6,1.4,1.4V12 C11.1,12.8,10.4,13.4,9.7,13.4z"/>
              <path d="M14,10.3L14,10.3c-0.8,0-1.4-0.6-1.4-1.4V4.4C12.6,3.7,13.2,3,14,3l0,0c0.8,0,1.4,0.6,1.4,1.4V9 C15.3,9.7,14.7,10.3,14,10.3z"/>
              <path d="M18.3,9.2L18.3,9.2c-0.8,0-1.4-0.6-1.4-1.4V5.6c0-0.8,0.6-1.4,1.4-1.4l0,0c0.8,0,1.4,0.6,1.4,1.4v2.2 C19.7,8.6,19.1,9.2,18.3,9.2z"/>
              <path d="M5.5,11.7L5.5,11.7c-0.8,0-1.4-0.6-1.4-1.4V3.1c0-0.8,0.6-1.4,1.4-1.4l0,0c0.8,0,1.4,0.6,1.4,1.4v7.2 C6.9,11.1,6.3,11.7,5.5,11.7z"/>
              <path d="M1.4,10.1L1.4,10.1C0.6,10.1,0,9.4,0,8.7V4.7C0,4,0.6,3.3,1.4,3.3l0,0c0.8,0,1.4,0.6,1.4,1.4v3.9 C2.8,9.4,2.2,10.1,1.4,10.1z"/>
           </svg>
        </div>
      </div>
      
      <div className="kwmp-progress">
        <span className="kwmp-time-left">1:09</span>
        <div className="kwmp-bar">
          <div className="kwmp-bar-fill"></div>
        </div>
        <span className="kwmp-time-right">-3:52</span>
      </div>

      <div className="kwmp-controls">
         <div className="kwmp-btn kwmp-btn-star">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
         </div>
         <div className="kwmp-btn kwmp-btn-prev">
            <svg viewBox="0 0 28.5 15.5" fill="currentColor">
              <path d="M27.7,0.1L15.5,6.1V0.5c0-0.2-0.1-0.3-0.2-0.4c-0.2-0.1-0.3-0.1-0.5,0L0.3,7.3C0.1,7.4,0,7.6,0,7.8 s0.1,0.4,0.3,0.5l14.5,7.2c0.2,0.1,0.4,0.1,0.5,0c0.2-0.1,0.2-0.3,0.2-0.4V9.4l12.2,6.1c0.2,0.1,0.4,0.1,0.5,0 c0.2-0.1,0.2-0.3,0.2-0.4V0.5c0-0.2-0.1-0.3-0.2-0.4C28,0,27.9,0,27.7,0.1L27.7,0.1L27.7,0.1z"/>
            </svg>
         </div>
         <div className="kwmp-btn kwmp-btn-pause">
            <svg viewBox="0 0 20.2 25.4" fill="currentColor">
               <path d="M5.9,25.4H2.4c-1.3,0-2.4-1.1-2.4-2.4V2.4C0,1.1,1.1,0,2.4,0h3.5c1.3,0,2.4,1.1,2.4,2.4v20.7 C8.3,24.4,7.2,25.4,5.9,25.4z"/>
               <path d="M17.8,25.4h-3.5c-1.3,0-2.4-1.1-2.4-2.4V2.4C11.9,1.1,13,0,14.3,0h3.5c1.3,0,2.4,1.1,2.4,2.4v20.7 C20.2,24.4,19.1,25.4,17.8,25.4z"/>
            </svg>
         </div>
         <div className="kwmp-btn kwmp-btn-next">
            <svg viewBox="0 0 28.5 15.5" fill="currentColor">
              <path d="M0.8,0.1l12.2,6.1V0.5c0-0.2,0.1-0.3,0.2-0.4c0.2-0.1,0.3-0.1,0.5,0l14.5,7.2c0.2,0.1,0.3,0.3,0.3,0.5 s-0.1,0.4-0.3,0.5l-14.5,7.2c-0.2,0.1-0.4,0.1-0.5,0c-0.2-0.1-0.2-0.3-0.2-0.4V9.4L0.8,15.5c-0.2,0.1-0.4,0.1-0.5,0 C0.1,15.3,0,15.2,0,15V0.5c0-0.2,0.1-0.3,0.2-0.4C0.4,0,0.6,0,0.8,0.1L0.8,0.1L0.8,0.1z"/>
            </svg>
         </div>
         <div className="kwmp-btn kwmp-btn-headphones">
            <svg viewBox="0 0 20 21.1" fill="currentColor">
              <path d="M13.9,20.7c-0.8-0.9,0.2-2.1,0.6-3.1c0.9-1.7,2.1-3.9,2.8-4.9c0.4-0.7,1.3-1.2,1.2-2.1 c-0.2-13.2-18-12.2-17,0.9c0.1,0.2,0.4,0.4,0.6,0.6c0.5,0.4,0.7,0.8,1.1,1.5c0.9,1.6,2,3.6,2.7,5.1c0.3,0.6,0.6,1.1,0.4,1.6 c-0.2,0.4-0.5,0.7-0.9,0.8c-2,0.7-5.2-6.7-5.3-7.8c-0.1-0.9,0.2-1.9,0.2-2.9C-0.8-4,21.8-3.1,19.4,11.1c0,0.5,0.3,1,0.5,1.4 c0.5,1.2-1.6,4.6-2.6,6.3c-0.5,0.8-0.9,1.6-1.8,2C15.1,21.1,14.4,21.2,13.9,20.7L13.9,20.7z"/>
              <path d="M7,19.3c-0.5-0.3-0.6-0.8-1.2-1.7c-0.7-1.3-1.6-3-2.3-4.4c-0.3-0.7-0.6-1-0.7-1.6c0.1-0.8,1.4-0.8,1.8-0.2 c0.7,1,2.7,4.6,3.3,5.7C8.4,17.9,8.2,19.5,7,19.3L7,19.3z"/>
              <path d="M15.3,11.3c0.6-0.4,2-0.2,1.8,0.7c-0.5,1.8-2.9,4.6-3.8,6.5c-0.8,1.8-2.2-0.1-1.5-1.3c0.3-0.6,1.6-2.7,2.4-4.3 C14.7,12.1,14.8,11.7,15.3,11.3L15.3,11.3z"/>
            </svg>
         </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   System Menu Popup Widget (1×4)
// ----------------------------------------------------

function IosMenuWidget() {
  return (
    <div className="wg-ios-menu">
      <svg viewBox="16.2 16.2 335.2 40.9" fill="none" style={{ width: "100%", height: "100%", display: "block" }}>
        <g>
          <g>
            <g>
              <defs>
                <path id="SVGID_1_" d="M26,18.2h315.7c4.3,0,7.8,3.5,7.8,7.8v21.3c0,4.3-3.5,7.8-7.8,7.8H26c-4.3,0-7.8-3.5-7.8-7.8V26 C18.2,21.7,21.7,18.2,26,18.2z"/>
              </defs>
              <clipPath id="SVGID_2_">
                <use xlinkHref="#SVGID_1_" style={{ overflow: "visible" }} />
              </clipPath>
            </g>
          </g>
          <g>
            <g>
              <defs>
                <path id="SVGID_3_" d="M26,18.2h315.7c4.3,0,7.8,3.5,7.8,7.8v21.3c0,4.3-3.5,7.8-7.8,7.8H26c-4.3,0-7.8-3.5-7.8-7.8V26 C18.2,21.7,21.7,18.2,26,18.2z"/>
              </defs>
              <clipPath id="SVGID_4_">
                <use xlinkHref="#SVGID_3_" style={{ overflow: "visible" }} />
              </clipPath>
              <g style={{ clipPath: "url(#SVGID_4_)" }}>
                <path style={{ fill: "var(--c-home-border)" }} d="M26,18.2h315.7c4.3,0,7.8,3.5,7.8,7.8v21.3c0,4.3-3.5,7.8-7.8,7.8H26c-4.3,0-7.8-3.5-7.8-7.8V26 C18.2,21.7,21.7,18.2,26,18.2z"/>
                <rect x="18.2" y="18.2" style={{ fill: "var(--c-home-card)" }} width="54.8" height="36.9"/>
                <path fill="var(--c-home-text)" d="M39.2,41.9c-2.8,0-4.5-2.1-4.5-5.4v0c0-3.3,1.7-5.4,4.5-5.4c2.2,0,3.8,1.4,4.2,3.3l0,0H42l0,0 c-0.3-1.3-1.4-2.1-2.9-2.1c-2,0-3.2,1.6-3.2,4.2v0c0,2.6,1.2,4.2,3.2,4.2c1.4,0,2.5-0.7,2.8-1.9l0,0h1.3v0 C43,40.7,41.4,41.9,39.2,41.9z M47.7,41.8c-1.7,0-2.6-1-2.6-2.8v-5h1.2v4.7c0,1.4,0.5,2,1.7,2c1.4,0,2.1-0.8,2.1-2.2V34h1.2 v7.7H50v-1.1h-0.1C49.6,41.4,48.8,41.8,47.7,41.8z M56.1,41.7c-1.6,0-2.2-0.6-2.2-2V35h-1.2v-1h1.2v-2h1.3v2h1.7v1h-1.7v4.3 c0,0.9,0.3,1.3,1.1,1.3c0.2,0,0.3,0,0.6,0v1.1C56.6,41.7,56.3,41.7,56.1,41.7z"/>
                <rect x="73.5" y="18.2" style={{ fill: "var(--c-home-card)" }} width="66.1" height="36.9"/>
                <path fill="var(--c-home-text)" d="M94.6,41.9c-2.8,0-4.5-2.1-4.5-5.4v0c0-3.3,1.7-5.4,4.5-5.4c2.2,0,3.8,1.4,4.2,3.3l0,0h-1.3l0,0 c-0.3-1.3-1.4-2.1-2.9-2.1c-2,0-3.2,1.6-3.2,4.2v0c0,2.6,1.2,4.2,3.2,4.2c1.4,0,2.5-0.7,2.8-1.9l0,0h1.3v0 C98.4,40.7,96.8,41.9,94.6,41.9z M103.7,41.8c-2.2,0-3.5-1.5-3.5-4v0c0-2.5,1.4-4,3.5-4c2.2,0,3.5,1.5,3.5,4v0 C107.2,40.3,105.9,41.8,103.7,41.8z M103.7,40.7c1.5,0,2.3-1.1,2.3-2.9v0c0-1.8-0.8-2.9-2.3-2.9c-1.4,0-2.3,1.1-2.3,2.9v0 C101.4,39.7,102.2,40.7,103.7,40.7z M108.9,44.2V34h1.2v1.2h0.1c0.5-0.9,1.3-1.4,2.4-1.4c1.9,0,3.2,1.6,3.2,4v0 c0,2.4-1.3,4-3.2,4c-1.1,0-2-0.5-2.4-1.3h-0.1v3.8H108.9z M112.4,40.7c1.4,0,2.2-1.1,2.2-2.9v0c0-1.8-0.8-2.9-2.2-2.9 c-1.4,0-2.2,1.1-2.2,2.9v0C110.1,39.6,111,40.7,112.4,40.7z M117.9,44.4c-0.2,0-0.4,0-0.5,0v-1c0.1,0,0.3,0,0.5,0 c0.7,0,1.1-0.3,1.4-1.2l0.1-0.5l-2.8-7.7h1.3l2.1,6.3h0.1l2.1-6.3h1.3l-3,8.1C119.9,43.9,119.3,44.4,117.9,44.4z"/>
                <rect x="140.2" y="18.2" style={{ fill: "var(--c-home-card)" }} width="86.7" height="36.9"/>
                <path fill="var(--c-home-text)" d="M157.2,41.7V31.4h1.3v9.1h4.9v1.1H157.2z M167.8,41.8c-2.2,0-3.5-1.5-3.5-4v0c0-2.5,1.4-4,3.5-4c2.2,0,3.5,1.5,3.5,4v0 C171.4,40.3,170,41.8,167.8,41.8z M167.8,40.7c1.4,0,2.3-1.1,2.3-2.9v0c0-1.8-0.8-2.9-2.3-2.9c-1.4,0-2.3,1.1-2.3,2.9v0 C165.6,39.7,166.4,40.7,167.8,40.7z M176.2,41.8c-2.2,0-3.5-1.5-3.5-4v0c0-2.5,1.4-4,3.5-4c2.2,0,3.5,1.5,3.5,4v0 C179.7,40.3,178.4,41.8,176.2,41.8z M176.2,40.7c1.4,0,2.3-1.1,2.3-2.9v0c0-1.8-0.8-2.9-2.3-2.9c-1.4,0-2.3,1.1-2.3,2.9v0 C173.9,39.7,174.8,40.7,176.2,40.7z M181.5,41.7V31h1.2v6.4h0.1l3.3-3.3h1.5l-3.3,3.2l3.6,4.4h-1.6l-2.9-3.6l-0.7,0.7v2.9 H181.5z M197.2,41.9c-2.5,0-4.1-1.5-4.1-3.8v-6.7h1.3v6.6c0,1.6,1,2.7,2.8,2.7c1.8,0,2.8-1.1,2.8-2.7v-6.6h1.3v6.7 C201.2,40.4,199.7,41.9,197.2,41.9z M203.5,44.2V34h1.2v1.2h0.1c0.5-0.9,1.3-1.4,2.4-1.4c1.9,0,3.2,1.6,3.2,4v0 c0,2.4-1.3,4-3.2,4c-1.1,0-2-0.5-2.4-1.3h-0.1v3.8H203.5z M206.9,40.7c1.4,0,2.2-1.1,2.2-2.9v0c0-1.8-0.8-2.9-2.2-2.9 c-1.4,0-2.2,1.1-2.2,2.9v0C204.7,39.6,205.5,40.7,206.9,40.7z"/>
                <rect x="227.4" y="18.2" style={{ fill: "var(--c-home-card)" }} width="92.4" height="36.9"/>
                
                <g>
                  <path fill="var(--c-home-sub)" d="M243.1,41.7V31.2h3.8c1.2,0,2.2,0.2,3.1,0.6c0.9,0.4,1.5,1,2,1.8c0.4,0.8,0.7,1.7,0.7,2.8 c0,1.1-0.2,2-0.7,2.8c-0.5,0.8-1.2,1.4-2.1,1.8c-0.9,0.4-2,0.6-3.2,0.6H243.1z M246.7,40.3c1.4,0,2.4-0.3,3.1-1 c0.7-0.7,1.1-1.6,1.1-2.8c0-1.2-0.4-2.2-1.1-2.8c-0.7-0.7-1.7-1-3.1-1h-2v7.6H246.7z"/>
                  <path fill="var(--c-home-sub)" d="M261,38.5h-5.7c0.1,0.7,0.3,1.2,0.7,1.6s0.9,0.6,1.6,0.6c0.4,0,0.8-0.1,1.1-0.3s0.6-0.5,0.9-0.8l1.3,0.7 c-0.3,0.5-0.8,1-1.3,1.3c-0.6,0.3-1.2,0.4-2,0.4c-0.8,0-1.5-0.2-2.1-0.5c-0.6-0.3-1.1-0.8-1.4-1.3c-0.3-0.6-0.5-1.3-0.5-2.1 c0-0.8,0.2-1.5,0.5-2.1s0.8-1.1,1.3-1.4c0.6-0.3,1.3-0.5,2.1-0.5c1.1,0,2,0.3,2.7,0.9c0.6,0.6,1,1.4,1,2.4 C261.2,37.8,261.1,38.2,261,38.5z M259.5,37.2c0-0.6-0.2-1-0.5-1.3c-0.4-0.3-0.8-0.5-1.4-0.5c-0.6,0-1,0.2-1.4,0.5 c-0.4,0.3-0.6,0.8-0.7,1.4H259.5z"/>
                  <path fill="var(--c-home-sub)" d="M262.4,31.2h1.6v8.7c0,0.4,0.2,0.5,0.6,0.5h0.4v1.4h-0.8c-0.6,0-1-0.1-1.3-0.4c-0.3-0.3-0.5-0.6-0.5-1.1V31.2 z"/>
                  <path fill="var(--c-home-sub)" d="M272.9,38.5h-5.7c0.1,0.7,0.3,1.2,0.7,1.6s0.9,0.6,1.6,0.6c0.4,0,0.8-0.1,1.1-0.3s0.6-0.5,0.9-0.8l1.3,0.7 c-0.3,0.5-0.8,1-1.3,1.3c-0.6,0.3-1.2,0.4-2,0.4c-0.8,0-1.5-0.2-2.1-0.5c-0.6-0.3-1.1-0.8-1.4-1.3c-0.3-0.6-0.5-1.3-0.5-2.1 c0-0.8,0.2-1.5,0.5-2.1s0.8-1.1,1.3-1.4c0.6-0.3,1.3-0.5,2.1-0.5c1.1,0,2,0.3,2.7,0.9c0.6,0.6,1,1.4,1,2.4 C273,37.8,273,38.2,272.9,38.5z M271.4,37.2c0-0.6-0.2-1-0.5-1.3c-0.4-0.3-0.8-0.5-1.4-0.5c-0.6,0-1,0.2-1.4,0.5 c-0.4,0.3-0.6,0.8-0.7,1.4H271.4z"/>
                  <path fill="var(--c-home-sub)" d="M278.8,35.6h-2.3v3.8c0,0.4,0.1,0.6,0.3,0.8c0.2,0.2,0.5,0.3,0.9,0.3c0.3,0,0.6,0,0.9-0.1v1.4 c-0.4,0.1-0.8,0.2-1.3,0.2c-0.8,0-1.4-0.2-1.9-0.6c-0.4-0.4-0.7-1-0.7-1.8v-3.9h-1.3v-1.4h1.3V32h1.6v2.3h2.3V35.6z"/>
                  <path fill="var(--c-home-sub)" d="M286.5,38.5h-5.7c0.1,0.7,0.3,1.2,0.7,1.6s0.9,0.6,1.6,0.6c0.4,0,0.8-0.1,1.1-0.3s0.6-0.5,0.9-0.8l1.3,0.7 c-0.3,0.5-0.8,1-1.3,1.3c-0.6,0.3-1.2,0.4-2,0.4c-0.8,0-1.5-0.2-2.1-0.5c-0.6-0.3-1.1-0.8-1.4-1.3c-0.3-0.6-0.5-1.3-0.5-2.1 c0-0.8,0.2-1.5,0.5-2.1s0.8-1.1,1.3-1.4c0.6-0.3,1.3-0.5,2.1-0.5c1.1,0,2,0.3,2.7,0.9c0.6,0.6,1,1.4,1,2.4 C286.6,37.8,286.6,38.2,286.5,38.5z M284.9,37.2c0-0.6-0.2-1-0.5-1.3c-0.4-0.3-0.8-0.5-1.4-0.5c-0.6,0-1,0.2-1.4,0.5 c-0.4,0.3-0.6,0.8-0.7,1.4H284.9z"/>
                </g>
                <g>
                  <path fill="var(--c-home-sub)" d="M304.4,33.3h-9.7c-0.4,0-0.7-0.3-0.7-0.7c0-0.4,0.3-0.7,0.7-0.7h9.7c0.4,0,0.7,0.3,0.7,0.7 C305.1,33,304.8,33.3,304.4,33.3z"/>
                  <path fill="var(--c-home-sub)" d="M301.8,33.3h-4.3c-0.4,0-0.7-0.3-0.7-0.7v-1.1c0-0.9,0.7-1.7,1.7-1.7h2.3c0.9,0,1.7,0.7,1.7,1.7v1.1 C302.4,33,302.1,33.3,301.8,33.3z M298.1,31.9h2.9v-0.5c0-0.2-0.1-0.3-0.3-0.3h-2.3c-0.2,0-0.3,0.1-0.3,0.3V31.9z"/>
                  <path fill="var(--c-home-sub)" d="M303,42.7h-6.8c-0.4,0-0.7-0.3-0.7-0.6l-0.4-9.4c0-0.2,0.1-0.4,0.2-0.5c0.1-0.1,0.3-0.2,0.5-0.2h7.6 c0.2,0,0.4,0.1,0.5,0.2c0.1,0.1,0.2,0.3,0.2,0.5l-0.4,9.4C303.6,42.4,303.3,42.7,303,42.7z M296.8,41.3h5.5l0.4-8h-6.2 L296.8,41.3z"/>
                  <path fill="var(--c-home-sub)" d="M299.6,40.4c-0.3,0-0.5-0.2-0.5-0.5v-5c0-0.3,0.2-0.5,0.5-0.5c0.3,0,0.5,0.2,0.5,0.5v5 C300.1,40.2,299.9,40.4,299.6,40.4z"/>
                  <path fill="var(--c-home-sub)" d="M297.9,40.4c-0.3,0-0.5-0.2-0.5-0.5v-5c0-0.3,0.2-0.5,0.5-0.5c0.3,0,0.5,0.2,0.5,0.5v5 C298.5,40.2,298.2,40.4,297.9,40.4z"/>
                  <path fill="var(--c-home-sub)" d="M301.3,40.4c-0.3,0-0.5-0.2-0.5-0.5v-5c0-0.3,0.2-0.5,0.5-0.5c0.3,0,0.5,0.2,0.5,0.5v5 C301.8,40.2,301.6,40.4,301.3,40.4z"/>
                </g>
                
                <rect x="320.2" y="18.2" style={{ fill: "var(--c-home-card)" }} width="29.2" height="36.9"/>
                <path fill="var(--c-home-text)" d="M337.8,36.6c0-0.2-0.1-0.4-0.3-0.6l-4.4-4.3c-0.1-0.1-0.3-0.2-0.5-0.2c-0.4,0-0.8,0.3-0.8,0.8c0,0.2,0.1,0.4,0.2,0.6 l3.9,3.8l-3.9,3.8c-0.2,0.2-0.2,0.3-0.2,0.6c0,0.4,0.3,0.8,0.8,0.8c0.2,0,0.4-0.1,0.5-0.2l4.4-4.3 C337.7,37.1,337.8,36.9,337.8,36.6z"/>
              </g>
            </g>
            <use href="#SVGID_3_" className="wg-ios-menu-stroke-layer" style={{ fill: "none", strokeWidth: 1.5, stroke: "currentColor" }} />
          </g>
          <g>
            <g>
              <defs>
                <path id="SVGID_5_" d="M26,18.2h315.7c4.3,0,7.8,3.5,7.8,7.8v21.3c0,4.3-3.5,7.8-7.8,7.8H26c-4.3,0-7.8-3.5-7.8-7.8V26 C18.2,21.7,21.7,18.2,26,18.2z"/>
              </defs>
              <clipPath id="SVGID_6_">
                <use xlinkHref="#SVGID_5_" style={{ overflow: "visible" }} />
              </clipPath>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}

// ----------------------------------------------------
//   Couple Chat Widget (2×4)
// ----------------------------------------------------

function CoupleChatWidget({ config, widgetId, onConfigChange, preview }: any) {
  const { triggerUpload: triggerLeft, input: leftInput } = useImageUpload(widgetId, "leftAvatar", onConfigChange);
  const { triggerUpload: triggerRight, input: rightInput } = useImageUpload(widgetId, "rightAvatar", onConfigChange);

  const leftAvatar = typeof config?.leftAvatar === "string" ? config.leftAvatar : "";
  const rightAvatar = typeof config?.rightAvatar === "string" ? config.rightAvatar : "";

  const HEART_SVG_PATHS = [
    "M1.5,24.1c0.9,0,1.5-0.6,1.5-1.3v-5.4c0-0.7-0.7-1.3-1.5-1.3C0.7,16,0,16.6,0,17.4v5.4 C0,23.5,0.7,24.1,1.5,24.1z",
    "M7.7,24.8c0.9,0,1.5-0.6,1.5-1.3v-6.7c0-0.7-0.7-1.3-1.5-1.3c-0.9,0-1.6,0.6-1.6,1.3v6.7 C6.1,24.2,6.8,24.8,7.7,24.8z",
    "M13.8,25.2c0.9,0,1.6-0.6,1.6-1.3v-7.6c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3v7.6 C12.3,24.6,12.9,25.2,13.8,25.2z",
    "M19.9,24c0.9,0,1.5-0.6,1.5-1.3v-5.3c0-0.7-0.7-1.3-1.5-1.3c-0.9,0-1.6,0.6-1.6,1.3v5.3 C18.4,23.4,19.1,24,19.9,24z",
    "M26.1,29.4c0.9,0,1.6-0.6,1.6-1.3V12c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3v16.1 C24.5,28.8,25.2,29.4,26.1,29.4z",
    "M32.2,27c0.9,0,1.6-0.6,1.6-1.3V14.5c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3v11.2 C30.6,26.4,31.3,27,32.2,27z",
    "M38.4,25.7c0.9,0,1.5-0.6,1.5-1.3V14.2c0-0.7-0.7-1.3-1.5-1.3c-0.9,0-1.6,0.6-1.6,1.3v10.1 C36.8,25.1,37.5,25.7,38.4,25.7z",
    "M44.5,24c0.9,0,1.5-0.6,1.5-1.3v-6.7c0-0.7-0.7-1.3-1.5-1.3c-0.9,0-1.6,0.6-1.6,1.3v6.7 C42.9,23.3,43.6,24,44.5,24z",
    "M50.6,26.2L50.6,26.2c-0.9,0-1.7-0.8-1.7-1.7V12c0-0.9,0.8-1.7,1.7-1.7l0,0c0.9,0,1.7,0.8,1.7,1.7v12.6 C52.3,25.5,51.6,26.2,50.6,26.2z",
    "M56.7,30.2L56.7,30.2c-0.9,0-1.7-0.8-1.7-1.7V5.3c0-0.9,0.8-1.7,1.7-1.7l0,0c0.9,0,1.7,0.8,1.7,1.7v23.1 C58.4,29.4,57.6,30.2,56.7,30.2z",
    "M62.8,35.2L62.8,35.2c-0.9,0-1.7-0.8-1.7-1.7v-31c0-0.9,0.8-1.7,1.7-1.7l0,0c0.9,0,1.7,0.8,1.7,1.7v31 C64.5,34.4,63.7,35.2,62.8,35.2z",
    "M68.8,39.7L68.8,39.7c-0.9,0-1.7-0.8-1.7-1.7V1.7c0-0.9,0.8-1.7,1.7-1.7l0,0c0.9,0,1.7,0.8,1.7,1.7V38 C70.5,38.9,69.8,39.7,68.8,39.7z",
    "M75.3,43.6L75.3,43.6c-0.9,0-1.7-0.8-1.7-1.7V4.3c0-0.9,0.8-1.7,1.7-1.7l0,0c0.9,0,1.7,0.8,1.7,1.7v37.7 C77,42.9,76.2,43.6,75.3,43.6z",
    "M81.4,46.7L81.4,46.7c-0.9,0-1.7-0.8-1.7-1.7V8.5c0-0.9,0.8-1.7,1.7-1.7l0,0c0.9,0,1.7,0.8,1.7,1.7V45 C83.2,46,82.4,46.7,81.4,46.7z",
    "M87.5,43.6L87.5,43.6c0.9,0,1.7-0.8,1.7-1.7V4.3c0-0.9-0.8-1.7-1.7-1.7l0,0c-0.9,0-1.7,0.8-1.7,1.7v37.7 C85.8,42.9,86.5,43.6,87.5,43.6z",
    "M93.2,39.7L93.2,39.7c0.9,0,1.7-0.8,1.7-1.7V1.7c0-0.9-0.8-1.7-1.7-1.7l0,0c-0.9,0-1.7,0.8-1.7,1.7V38 C91.5,38.9,92.2,39.7,93.2,39.7z",
    "M99.3,35.2L99.3,35.2c0.9,0,1.7-0.8,1.7-1.7v-31c0-0.9-0.8-1.7-1.7-1.7l0,0c-0.9,0-1.7,0.8-1.7,1.7v31 C97.6,34.4,98.3,35.2,99.3,35.2z",
    "M105.3,32L105.3,32c0.9,0,1.7-0.8,1.7-1.7V7.2c0-0.9-0.8-1.7-1.7-1.7l0,0c-0.9,0-1.7,0.8-1.7,1.7v23.1 C103.6,31.3,104.4,32,105.3,32z",
    "M111.4,26.2L111.4,26.2c0.9,0,1.7-0.8,1.7-1.7V12c0-0.9-0.8-1.7-1.7-1.7l0,0c-0.9,0-1.7,0.8-1.7,1.7v12.6 C109.7,25.5,110.4,26.2,111.4,26.2z",
    "M118,25.8c0.9,0,1.6-0.6,1.6-1.3v-8.7c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.5,0.6-1.5,1.3v8.7 C116.4,25.2,117.1,25.8,118,25.8z",
    "M124.7,24.3c0.9,0,1.6-0.6,1.6-1.3v-5.4c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3v5.4 C123.2,23.7,123.9,24.3,124.7,24.3z",
    "M130.8,25c0.9,0,1.5-0.6,1.5-1.3v-6.7c0-0.7-0.7-1.3-1.5-1.3s-1.6,0.6-1.6,1.3v6.7 C129.3,24.4,130,25,130.8,25z",
    "M137,25.4c0.9,0,1.6-0.6,1.6-1.3v-7.6c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3V24 C135.4,24.8,136.1,25.4,137,25.4z",
    "M142.5,26.9c0.9,0,1.6-0.6,1.6-1.3v-11c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3v11 C140.9,26.3,141.6,26.9,142.5,26.9z",
    "M148.6,29.8c0.9,0,1.6-0.6,1.6-1.3V11.6c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3v16.9 C147.1,29.2,147.8,29.8,148.6,29.8z",
    "M154.8,30.8c0.9,0,1.6-0.6,1.6-1.3V10.7c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3v18.8 C153.2,30.2,153.9,30.8,154.8,30.8z",
    "M160.9,27.2c0.9,0,1.6-0.6,1.6-1.3V14.3c0-0.7-0.7-1.3-1.6-1.3c-0.9,0-1.6,0.6-1.6,1.3v11.5 C159.3,26.6,160,27.2,160.9,27.2z",
    "M167.5,24.1c0.9,0,1.5-0.6,1.5-1.3v-5.4c0-0.7-0.7-1.3-1.5-1.3c-0.9,0-1.6,0.6-1.6,1.3v5.4 C165.9,23.5,166.6,24.1,167.5,24.1z",
    "M173.6,24.8c0.9,0,1.6-0.6,1.6-1.3v-6.7c0-0.7-0.7-1.3-1.6-1.3s-1.6,0.6-1.6,1.3v6.7 C172,24.2,172.7,24.8,173.6,24.8z"
  ];

  return (
    <div className="wg-couple-chat">
      {leftInput}
      {rightInput}
      
      {/* Left Chat Row (Text) */}
      <div className="wg-chat-row left">
        <div 
          className="wg-chat-avatar" 
          onClick={preview ? undefined : triggerLeft}
          style={leftAvatar ? { backgroundImage: `url(${leftAvatar})` } : {}}
          title="点击更换左侧头像"
        >
          {!leftAvatar && <span className="wg-chat-avatar-ph">AI</span>}
        </div>
        <div className="wg-chat-bubble wg-bubble-text">
          <div className="wg-bubble-content">我也很想你～明天见哦！</div>
        </div>
      </div>
      
      {/* Right Chat Row (Voice wave) */}
      <div className="wg-chat-row right">
        <div className="wg-chat-bubble wg-bubble-voice">
           <div className="wg-heart-wave" style={{ display: 'flex', alignItems: 'center' }}>
             <svg viewBox="0 0 175.1 46.7" width="95" height="26" style={{ overflow: "visible" }}>
               {HEART_SVG_PATHS.map((d, i) => (
                  <path 
                    key={i} 
                    d={d}
                    className="wg-hw-svg-path" 
                    fill="currentColor"
                    style={{ animationDelay: `${i * 0.05}s` }} 
                  />
               ))}
             </svg>
           </div>
           <span className="wg-hw-time">0:12"</span>
        </div>
        <div 
          className="wg-chat-avatar" 
          onClick={preview ? undefined : triggerRight}
          style={rightAvatar ? { backgroundImage: `url(${rightAvatar})` } : {}}
          title="点击更换右侧头像"
        >
          {!rightAvatar && <span className="wg-chat-avatar-ph">ME</span>}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Mood Pill Widget (4x1)
// ----------------------------------------------------
function MoodPillWidget({ config, widgetId, onConfigChange, preview }: any) {
  const defaultText = ".*I ENJOY LIFE NOW ☁ 63°.*";
  const text = typeof config?.text === "string" ? config.text : defaultText;
  
  const [showEdit, setShowEdit] = useState(false);
  const [editText, setEditText] = useState(text);

  function handlePillClick(e: React.MouseEvent) {
    if (preview) return;
    e.stopPropagation();
    setEditText(text);
    setShowEdit(true);
  }

  function handleSave() {
    onConfigChange?.(widgetId, { ...config, text: editText.trim() || defaultText });
    setShowEdit(false);
  }

  return (
    <>
      <div className="wg-mood-pill">
        <div className="wg-mood-bubble" onClick={handlePillClick}>
          <span>{text}</span>
        </div>
      </div>
      {showEdit && createPortal(
        <ContentDialog
          title="编辑悬浮气泡"
          onConfirm={handleSave}
          onCancel={() => setShowEdit(false)}
        >
          <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-home-text)", marginBottom: 4, display: "block" }}>气泡文字</label>
          <input
            className="ui-input"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder={defaultText}
            style={{ width: "100%" }}
          />
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
    </>
  );
}

// ----------------------------------------------------
//   Vinyl Record Widget (2x2)
// ----------------------------------------------------
function VinylRecordWidget() {
  return (
    <div className="wg-vinyl-record">
      <div className="wg-vinyl-disc">
        <div className="wg-vinyl-label">
          <div className="wg-vinyl-hole" />
          <div className="wg-vinyl-decor">♪</div>
        </div>
      </div>
      <div className="wg-vinyl-arm">
        <div className="wg-vinyl-arm-stick" />
        <div className="wg-vinyl-arm-base" />
        <div className="wg-vinyl-arm-head" />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Receipt Widget (2x4)
// ----------------------------------------------------
function ReceiptWidget({ config, widgetId, onConfigChange, preview }: any) {
  const defaultItems = [
    { title: "MORNING COFFEE", qty: 1, price: "4.50" },
    { title: "AFTERNOON NAP", qty: 1, price: "0.00" },
    { title: "SUNSET WATCHING", qty: 1, price: "FREE" }
  ];
  
  return (
    <div className="wg-receipt-wrapper">
      <div className="wg-receipt-paper">
        <div className="wg-receipt-meta">
          <span>STORE #042</span>
          <span>{new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short' })}</span>
        </div>
        <div className="wg-receipt-header">SOUL MART</div>
        <div className="wg-receipt-divider" />
        <div className="wg-receipt-list">
          {defaultItems.map((item, i) => (
            <div className="wg-receipt-item" key={i}>
              <div className="wg-receipt-item-title">{item.title}</div>
              <div className="wg-receipt-item-row">
                <span>{item.qty}x</span>
                <span>{item.price}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="wg-receipt-divider" />
        <div className="wg-receipt-total">
          <span>TOTAL</span>
          <span>PRICELESS</span>
        </div>
        <div className="wg-receipt-barcode" />
      </div>
    </div>
  );
}

// ----------------------------------------------------
//   Ticket Stub Widget (2x4)
// ----------------------------------------------------
function TicketStubWidget({ config, widgetId, onConfigChange, preview }: any) {
  const posterUrl = typeof config?.posterUrl === "string" ? config.posterUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "posterUrl", onConfigChange);

  return (
    <div className="wg-ticket-paper">
      {input}
      <div className="wg-ticket-main">
        <div className="wg-ticket-content-wrapper">
          <div className="wg-ticket-text-col">
            <div className="wg-ticket-sub">ADMIT ONE</div>
            <div className="wg-ticket-title">MIDNIGHT EXPRESS</div>
            <div className="wg-ticket-info-row">
              <div className="wg-ticket-info-box">
                <span className="wg-ticket-info-label">DATE</span>
                <span className="wg-ticket-info-val">OCT 24</span>
              </div>
              <div className="wg-ticket-info-box">
                <span className="wg-ticket-info-label">TIME</span>
                <span className="wg-ticket-info-val">23:59</span>
              </div>
              <div className="wg-ticket-info-box">
                <span className="wg-ticket-info-label">SEAT</span>
                <span className="wg-ticket-info-val">F-13</span>
              </div>
            </div>
            {/* Aesthetic bottom barcode/dots */}
            <div className="wg-ticket-dots">
               ● ● ● ● ● ● ● ● ● ●
            </div>
          </div>
          <div 
            className="wg-ticket-poster"
            onClick={preview ? undefined : triggerUpload}
            style={posterUrl ? { backgroundImage: `url(${posterUrl})`, border: 'none' } : {}}
            title="点击上传海报/票面图片"
          >
            {!posterUrl && <span>+<br/>IMAGE</span>}
          </div>
        </div>
      </div>
      <div className="wg-ticket-stub" />
    </div>
  );
}

// ----------------------------------------------------
//   Postcard Widget (4x4)
// ----------------------------------------------------
function PostcardWidget({ config, widgetId, onConfigChange, preview }: any) {
  const bgUrl = typeof config?.avatarUrl === "string" ? config.avatarUrl : "";
  const { triggerUpload, input } = useImageUpload(widgetId, "avatarUrl", onConfigChange);
  
  const defaultMsg = "DREAMING";
  const msg = typeof config?.msg === "string" ? config.msg : defaultMsg;
  const [showEdit, setShowEdit] = useState(false);
  const [editText, setEditText] = useState(msg);
  
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  return (
    <div 
      className="wg-postcard-paper" 
      style={bgUrl ? { backgroundImage: `url(${bgUrl})` } : {}}
    >
      {input}
      <div 
        className="wg-pc-overlay"
        onClick={preview ? undefined : () => triggerUpload()} 
        title="点击更换全画幅底图"
      >
        <div className="wg-pc-top-text">
          <span className="wg-pc-micro-text">NOSTALGIA / VOL.1</span>
          <div className="wg-pc-sec-text">04</div>
        </div>

        <div className="wg-pc-center-group">
          <div 
            className="wg-pc-main-text"
            onClick={preview ? undefined : (e) => { e.stopPropagation(); setEditText(msg); setShowEdit(true); }}
            title="点击编辑焦点英文"
          >
            {msg}
          </div>
          <div className="wg-pc-sub-paragraph">
             Somewhere in time, memories are kept alive.<br/>
             <span style={{fontFamily: '"Noto Sans JP", sans-serif', letterSpacing: '0.1em'}}>光と影の交差点・1998</span>
          </div>
        </div>

        <div className="wg-pc-bottom-layout">
          <div className="wg-pc-badge">
            <span>EST.</span>
            <span>{new Date().getFullYear()}</span>
            <div className="wg-pc-micro-divider" />
            <span className="wg-pc-micro-jp">記憶の破片</span>
          </div>
          <div className="wg-pc-japanese">夢を見ている</div>
        </div>
      </div>
      
      {showEdit && mounted && createPortal(
        <ContentDialog 
          title="编辑焦点文字" 
          onCancel={() => setShowEdit(false)} 
          onConfirm={() => { onConfigChange?.(widgetId, { ...config, msg: editText }); setShowEdit(false); }}
        >
          <input
            className="ui-input"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            style={{ width: "100%", padding: "8px", fontSize: "calc(16px*var(--app-text-scale,1))" }}
            maxLength={18}
          />
        </ContentDialog>,
        document.body
      )}
    </div>


  );
}
