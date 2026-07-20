"use client";

import { ChangeEvent, useRef, useState } from "react";

type RoleThemeProfile = {
  wallpaper: string;
  iconSkin: string;
  iconSlots: string[];
};

type RoleThemeCustomizerProps = {
  activeRoleName: string;
  profile: RoleThemeProfile;
  onChange: (next: RoleThemeProfile) => void;
  onApply: () => void;
  onClose: () => void;
};

const DEFAULT_ROLE_THEME: RoleThemeProfile = {
  wallpaper: "",
  iconSkin: "",
  iconSlots: ["PHONE", "NOTE", "MAP", "SHOP", "DIARY", "CHAT"],
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
  const [iconSkinUrl, setIconSkinUrl] = useState(profile.iconSkin || "");

  const saveTheme = () => {
    const next: RoleThemeProfile = {
      ...DEFAULT_ROLE_THEME,
      ...profile,
      wallpaper: wallpaperUrl,
      iconSkin: iconSkinUrl,
    };
    onChange(next);
    onApply();
  };

  const handleWallpaperChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setWallpaperUrl(value);
    onChange({
      ...DEFAULT_ROLE_THEME,
      ...profile,
      wallpaper: value,
      iconSkin: iconSkinUrl,
    });
  };

  const handleWallpaperUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    setWallpaperUrl(dataUrl);
    onChange({
      ...DEFAULT_ROLE_THEME,
      ...profile,
      wallpaper: dataUrl,
      iconSkin: iconSkinUrl,
    });
    event.target.value = "";
  };

  const handleIconChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setIconSkinUrl(value);
    onChange({
      ...DEFAULT_ROLE_THEME,
      ...profile,
      wallpaper: wallpaperUrl,
      iconSkin: value,
    });
  };

  const handleIconUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    setIconSkinUrl(dataUrl);
    onChange({
      ...DEFAULT_ROLE_THEME,
      ...profile,
      wallpaper: wallpaperUrl,
      iconSkin: dataUrl,
    });
    event.target.value = "";
  };

  const iconSlots = profile.iconSlots?.length ? profile.iconSlots : DEFAULT_ROLE_THEME.iconSlots;

  return (
    <section className="phone-sheet phone-sheet-theme">
      <header className="phone-sheet-header">
        <button type="button" className="phone-icon-btn" onClick={onClose}>
          返回
        </button>
        <div>
          <h2>角色主题</h2>
          <p>{activeRoleName}</p>
        </div>
        <button type="button" className="phone-btn phone-btn-primary" onClick={saveTheme}>
          应用
        </button>
      </header>

      <div className="phone-theme-body">
        <section className="phone-panel">
          <div className="phone-panel-head">
            <strong>壁纸</strong>
            <span>支持 URL / 本地图片</span>
          </div>

          <label className="phone-field">
            <span>壁纸链接</span>
            <input
              className="phone-input"
              value={wallpaperUrl}
              placeholder="https://..."
              onChange={handleWallpaperChange}
            />
          </label>

          <div className="phone-inline-actions">
            <button type="button" className="phone-btn" onClick={() => wallpaperInputRef.current?.click()}>
              上传本地壁纸
            </button>
            <button type="button" className="phone-btn" onClick={() => setWallpaperUrl("")}>
              清空
            </button>
          </div>

          <input
            ref={wallpaperInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleWallpaperUpload}
          />

          <div
            className="phone-preview-box"
            style={{
              backgroundImage: wallpaperUrl ? `url(${wallpaperUrl})` : undefined,
              backgroundSize: "cover",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }}
          />
        </section>

        <section className="phone-panel">
          <div className="phone-panel-head">
            <strong>图标图案</strong>
            <span>图标位置固定，只替换图案</span>
          </div>

          <label className="phone-field">
            <span>图标图案链接</span>
            <input
              className="phone-input"
              value={iconSkinUrl}
              placeholder="https://..."
              onChange={handleIconChange}
            />
          </label>

          <div className="phone-inline-actions">
            <button type="button" className="phone-btn" onClick={() => iconInputRef.current?.click()}>
              上传本地图标
            </button>
            <button type="button" className="phone-btn" onClick={() => setIconSkinUrl("")}>
              清空
            </button>
          </div>

          <input
            ref={iconInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleIconUpload}
          />

          <div className="phone-fixed-grid">
            {iconSlots.map((slot) => (
              <div key={slot} className="phone-grid-slot">
                <div
                  className="phone-grid-icon"
                  style={{
                    backgroundImage: iconSkinUrl ? `url(${iconSkinUrl})` : undefined,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    backgroundRepeat: "no-repeat",
                  }}
                />
                <span>{slot}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
