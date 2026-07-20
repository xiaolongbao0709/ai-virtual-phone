"use client";

import { ChangeEvent, useRef, useState } from "react";

export type RoleThemeProfile = {
  wallpaper: string;
  iconSkin: string;
  iconSlots: string[];
};

export const DEFAULT_ROLE_THEME_PROFILE: RoleThemeProfile = {
  wallpaper: "",
  iconSkin: "",
  iconSlots: ["PHONE", "NOTE", "MAP", "SHOP", "DIARY", "CHAT"],
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
  const [iconSkinUrl, setIconSkinUrl] = useState(profile.iconSkin || "");

  const saveTheme = () => {
    const next: RoleThemeProfile = {
      ...DEFAULT_ROLE_THEME_PROFILE,
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
      ...DEFAULT_ROLE_THEME_PROFILE,
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
      ...DEFAULT_ROLE_THEME_PROFILE,
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
      ...DEFAULT_ROLE_THEME_PROFILE,
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
      ...DEFAULT_ROLE_THEME_PROFILE,
      ...profile,
      wallpaper: wallpaperUrl,
      iconSkin: dataUrl,
    });
    event.target.value = "";
  };

  const iconSlots = profile.iconSlots?.length ? profile.iconSlots : DEFAULT_ROLE_THEME_PROFILE.iconSlots;

  return (
    <section
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(8, 12, 20, 0.46)",
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        style={{
          width: "min(720px, 100%)",
          maxHeight: "84vh",
          overflowY: "auto",
          borderRadius: 20,
          background: "rgba(255,255,255,0.9)",
          border: "1px solid rgba(180, 190, 205, 0.6)",
          boxShadow: "0 18px 50px rgba(8, 12, 20, 0.24)",
          color: "#1b2330",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "14px 16px",
            borderBottom: "1px solid rgba(200, 209, 223, 0.8)",
            background: "rgba(245, 247, 251, 0.95)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "rgba(22, 32, 48, 0.08)",
              color: "#243044",
              padding: "8px 12px",
              borderRadius: 10,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            返回
          </button>
          <div style={{ textAlign: "center", flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>角色主题</div>
            <div style={{ fontSize: 12, color: "#5c6780" }}>{activeRoleName}</div>
          </div>
          <button
            type="button"
            onClick={saveTheme}
            style={{
              border: "none",
              background: "#2f6df6",
              color: "#fff",
              padding: "8px 14px",
              borderRadius: 10,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            应用
          </button>
        </header>

        <div style={{ display: "grid", gap: 12, padding: 16 }}>
          <section
            style={{
              borderRadius: 16,
              background: "rgba(246, 248, 252, 0.98)",
              border: "1px solid rgba(200, 208, 220, 0.95)",
              padding: 14,
              display: "grid",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ fontSize: 15 }}>壁纸</strong>
              <span style={{ fontSize: 12, color: "#6a7488" }}>支持 URL / 本地图片</span>
            </div>

            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 12, color: "#5b6578" }}>壁纸链接</span>
              <input
                value={wallpaperUrl}
                placeholder="https://..."
                onChange={handleWallpaperChange}
                style={{
                  width: "100%",
                  border: "1px solid rgba(183, 193, 208, 0.9)",
                  background: "#fff",
                  borderRadius: 10,
                  padding: "10px 12px",
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </label>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => wallpaperInputRef.current?.click()}
                style={{
                  border: "none",
                  background: "#eef2ff",
                  color: "#2344a8",
                  padding: "8px 12px",
                  borderRadius: 10,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                上传本地壁纸
              </button>
              <button
                type="button"
                onClick={() => setWallpaperUrl("")}
                style={{
                  border: "1px solid rgba(183, 193, 208, 0.9)",
                  background: "#fff",
                  color: "#344052",
                  padding: "8px 12px",
                  borderRadius: 10,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                清空
              </button>
            </div>

            <input ref={wallpaperInputRef} type="file" accept="image/*" hidden onChange={handleWallpaperUpload} />

            <div
              style={{
                height: 160,
                borderRadius: 14,
                background: wallpaperUrl ? `url(${wallpaperUrl}) center / cover no-repeat` : "linear-gradient(135deg, #eaf0ff, #f5f7fb)",
                border: "1px solid rgba(186, 197, 214, 0.9)",
              }}
            />
          </section>

          <section
            style={{
              borderRadius: 16,
              background: "rgba(246, 248, 252, 0.98)",
              border: "1px solid rgba(200, 208, 220, 0.95)",
              padding: 14,
              display: "grid",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong style={{ fontSize: 15 }}>图标图案</strong>
              <span style={{ fontSize: 12, color: "#6a7488" }}>图标位置固定，只替换图案</span>
            </div>

            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 12, color: "#5b6578" }}>图标图案链接</span>
              <input
                value={iconSkinUrl}
                placeholder="https://..."
                onChange={handleIconChange}
                style={{
                  width: "100%",
                  border: "1px solid rgba(183, 193, 208, 0.9)",
                  background: "#fff",
                  borderRadius: 10,
                  padding: "10px 12px",
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </label>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => iconInputRef.current?.click()}
                style={{
                  border: "none",
                  background: "#eef2ff",
                  color: "#2344a8",
                  padding: "8px 12px",
                  borderRadius: 10,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                上传本地图标
              </button>
              <button
                type="button"
                onClick={() => setIconSkinUrl("")}
                style={{
                  border: "1px solid rgba(183, 193, 208, 0.9)",
                  background: "#fff",
                  color: "#344052",
                  padding: "8px 12px",
                  borderRadius: 10,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                清空
              </button>
            </div>

            <input ref={iconInputRef} type="file" accept="image/*" hidden onChange={handleIconUpload} />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: 10,
              }}
            >
              {iconSlots.map((slot) => (
                <div
                  key={slot}
                  style={{
                    display: "grid",
                    justifyItems: "center",
                    gap: 6,
                    padding: 10,
                    borderRadius: 12,
                    background: "#fff",
                    border: "1px solid rgba(191, 201, 216, 0.9)",
                  }}
                >
                  <div
                    style={{
                      width: 42,
                      height: 42,
                      borderRadius: 12,
                      background: iconSkinUrl ? `url(${iconSkinUrl}) center / cover no-repeat` : "linear-gradient(135deg, #dbe7ff, #f0f4ff)",
                      border: "1px solid rgba(160, 178, 207, 0.9)",
                    }}
                  />
                  <span style={{ fontSize: 11, color: "#59657a" }}>{slot}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
