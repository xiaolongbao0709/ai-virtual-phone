"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";

export type RoleThemeProfile = {
  wallpaper: string;
  iconSkins: Record<string, string>;
  iconSlots: string[];
};

export const DEFAULT_ROLE_THEME_PROFILE: RoleThemeProfile = {
  wallpaper: "",
  iconSkins: {},
  iconSlots: ["phone", "notes", "chat", "shopping", "photos", "music"],
};

type RoleThemeCustomizerProps = {
  activeRoleName: string;
  profile: RoleThemeProfile;
  onChange: (next: RoleThemeProfile) => void;
  onApply: () => void;
  onClose: () => void;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export function RoleThemeCustomizer({
  activeRoleName,
  profile,
  onChange,
  onApply,
  onClose,
}: RoleThemeCustomizerProps) {
  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const [wallpaperUrl, setWallpaperUrl] = useState(profile.wallpaper || "");
  const [iconSkins, setIconSkins] = useState<Record<string, string>>(profile.iconSkins || {});
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);

  useEffect(() => {
    setWallpaperUrl(profile.wallpaper || "");
    setIconSkins(profile.iconSkins || {});
  }, [profile]);

  const saveTheme = () => {
    const next: RoleThemeProfile = {
      ...DEFAULT_ROLE_THEME_PROFILE,
      ...profile,
      wallpaper: wallpaperUrl,
      iconSkins,
    };
    onChange(next);
    onApply();
  };

  const handleWallpaperChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setWallpaperUrl(value);
    onChange({
      ...DEFAULT_ROLE_THEME_PROFILE,
      ...profile,
      wallpaper: value,
      iconSkins,
    });
  };

  const handleWallpaperUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    setWallpaperUrl(dataUrl);
    onChange({
      ...DEFAULT_ROLE_THEME_PROFILE,
      ...profile,
      wallpaper: dataUrl,
      iconSkins,
    });
    event.target.value = "";
  };

  const handleIconUrlChange = (slot: string, value: string) => {
    const nextSkins = { ...iconSkins, [slot]: value };
    setIconSkins(nextSkins);
    onChange({
      ...DEFAULT_ROLE_THEME_PROFILE,
      ...profile,
      wallpaper: wallpaperUrl,
      iconSkins: nextSkins,
    });
  };

  const handleIconUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    if (uploadTarget) {
      const nextSkins = { ...iconSkins, [uploadTarget]: dataUrl };
      setIconSkins(nextSkins);
      onChange({
        ...DEFAULT_ROLE_THEME_PROFILE,
        ...profile,
        wallpaper: wallpaperUrl,
        iconSkins: nextSkins,
      });
    }
    event.target.value = "";
    setUploadTarget(null);
  };

  const iconSlots = profile.iconSlots?.length ? profile.iconSlots : DEFAULT_ROLE_THEME_PROFILE.iconSlots;

  return (
    <section className="cp-role-theme-overlay">
      <div className="cp-role-theme-card">
        <header className="cp-role-theme-head">
          <button type="button" className="cp-role-theme-back" onClick={onClose}>
            返回
          </button>
          <div className="cp-role-theme-title-wrap">
            <div className="cp-role-theme-title">角色主题</div>
            <div className="cp-role-theme-subtitle">{activeRoleName}</div>
          </div>
          <button type="button" className="cp-role-theme-apply" onClick={saveTheme}>
            应用
          </button>
        </header>

        <div className="cp-role-theme-body">
          <section className="cp-role-theme-panel">
            <div className="cp-role-theme-panel-head">
              <strong>壁纸</strong>
              <span>支持 URL / 本地图片</span>
            </div>

            <label className="cp-role-theme-field">
              <span>壁纸链接</span>
              <input
                className="cp-role-theme-input"
                value={wallpaperUrl}
                placeholder="https://..."
                onChange={handleWallpaperChange}
              />
            </label>

            <div className="cp-role-theme-actions">
              <button type="button" className="cp-role-theme-btn" onClick={() => wallpaperInputRef.current?.click()}>
                上传本地壁纸
              </button>
              <button type="button" className="cp-role-theme-btn cp-role-theme-btn--ghost" onClick={() => setWallpaperUrl("")}>
                清空
              </button>
            </div>

            <input ref={wallpaperInputRef} type="file" accept="image/*" hidden onChange={handleWallpaperUpload} />

            <div className="cp-role-theme-preview" style={{ backgroundImage: wallpaperUrl ? `url(${wallpaperUrl})` : undefined }} />
          </section>

          <section className="cp-role-theme-panel">
            <div className="cp-role-theme-panel-head">
              <strong>图标图案</strong>
              <span>每个图标独立替换</span>
            </div>

            <div className="cp-role-theme-grid">
              {iconSlots.map((slot) => (
                <div key={slot} className="cp-role-theme-slot">
                  <div className="cp-role-theme-slot-title">{slot}</div>
                  <div className="cp-role-theme-slot-body">
                    <input
                      className="cp-role-theme-input"
                      value={iconSkins[slot] || ""}
                      placeholder="https://..."
                      onChange={(event) => handleIconUrlChange(slot, event.target.value)}
                    />
                    <button
                      type="button"
                      className="cp-role-theme-btn"
                      onClick={() => {
                        setUploadTarget(slot);
                        iconInputRef.current?.click();
                      }}
                    >
                      上传
                    </button>
                  </div>
                  <div className="cp-role-theme-icon-preview" style={{ backgroundImage: iconSkins[slot] ? `url(${iconSkins[slot]})` : undefined }} />
                </div>
              ))}
            </div>

            <input ref={iconInputRef} type="file" accept="image/*" hidden onChange={handleIconUpload} />
          </section>
        </div>
      </div>
    </section>
  );
}
