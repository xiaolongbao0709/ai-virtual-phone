type RgbColor = { r: number; g: number; b: number };
type CssColor = RgbColor & { a: number };

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseCssColor(value: string): CssColor | null {
  const normalized = value.trim();
  const commaRgb = normalized.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i,
  );
  const spaceRgb = normalized.match(
    /rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+%?))?\s*\)/i,
  );
  const rgb = commaRgb || spaceRgb;
  if (rgb) {
    const rawAlpha = rgb[4];
    const alpha = rawAlpha?.endsWith("%")
      ? Number(rawAlpha.slice(0, -1)) / 100
      : Number(rawAlpha ?? 1);
    return {
      r: clampChannel(Number(rgb[1])),
      g: clampChannel(Number(rgb[2])),
      b: clampChannel(Number(rgb[3])),
      a: Math.max(0, Math.min(1, alpha)),
    };
  }

  const srgb = normalized.match(
    /color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/i,
  );
  if (srgb) {
    const rawAlpha = srgb[4];
    const alpha = rawAlpha?.endsWith("%")
      ? Number(rawAlpha.slice(0, -1)) / 100
      : Number(rawAlpha ?? 1);
    return {
      r: clampChannel(Number(srgb[1]) * 255),
      g: clampChannel(Number(srgb[2]) * 255),
      b: clampChannel(Number(srgb[3]) * 255),
      a: Math.max(0, Math.min(1, alpha)),
    };
  }

  const hex = normalized.match(/^#([\da-f]{3,8})$/i)?.[1];
  if (!hex) return null;
  const expanded = hex.length <= 4
    ? hex.split("").map((part) => part + part).join("")
    : hex;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
    a: expanded.length >= 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function colorBrightness(color: RgbColor): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

function composite(foreground: CssColor, background: RgbColor): RgbColor {
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
  };
}

function toHex(color: RgbColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => clampChannel(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function firstBackgroundImageUrl(backgroundImage: string): string | null {
  return backgroundImage.match(/url\(\s*["']?(.+?)["']?\s*\)/i)?.[1] || null;
}

function firstGradientColor(backgroundImage: string): CssColor | null {
  if (!/(?:linear|radial)-gradient\(/i.test(backgroundImage)) return null;
  const gradient = backgroundImage.match(/rgba?\([^)]*\)|#[\da-f]{3,8}/i)?.[0];
  return gradient ? parseCssColor(gradient) : null;
}

/** 采样图片上部 40% 区域（状态栏所在位置）的平均颜色。 */
function sampleImageColor(url: string): Promise<RgbColor | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 50;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0, size, size);
      const sampleH = Math.round(size * 0.4);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, size, sampleH).data;
      } catch {
        resolve(null);
        return;
      }
      let red = 0;
      let green = 0;
      let blue = 0;
      let weight = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255;
        red += (data[i] * alpha) + (255 * (1 - alpha));
        green += (data[i + 1] * alpha) + (255 * (1 - alpha));
        blue += (data[i + 2] * alpha) + (255 * (1 - alpha));
        weight += 1;
      }
      resolve(weight > 0 ? { r: red / weight, g: green / weight, b: blue / weight } : null);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** 保留亮度检测 API，供旧调用方使用。 */
export async function detectImageBrightness(url: string): Promise<"light" | "dark"> {
  const color = await sampleImageColor(url);
  return colorBrightness(color || { r: 248, g: 247, b: 242 }) < 128 ? "dark" : "light";
}

/**
 * 检测任意 DOM 元素的视觉背景颜色。
 * 依次检查 background-image（URL）和 background-color。
 */
async function detectElementColor(el: HTMLElement): Promise<RgbColor | null> {
  const style = getComputedStyle(el);
  const backgroundColor = parseCssColor(style.backgroundColor);
  const solidBackground = backgroundColor && backgroundColor.a > 0
    ? composite(backgroundColor, { r: 255, g: 255, b: 255 })
    : null;

  // 1. 优先检测背景图片
  const bgImage = style.backgroundImage;
  const imageUrl = firstBackgroundImageUrl(bgImage);
  if (imageUrl) {
    const sampled = await sampleImageColor(imageUrl);
    if (sampled) {
      // 主题壁纸使用白色 linear-gradient 作为透明度蒙层，合成后才是屏幕实际颜色。
      const overlay = firstGradientColor(bgImage);
      return overlay ? composite(overlay, sampled) : sampled;
    }
  }

  // 2. 纯 CSS 渐变没有 URL，用首个渐变色与底色合成近似顶部主色。
  const gradient = firstGradientColor(bgImage);
  if (gradient) return composite(gradient, solidBackground || { r: 255, g: 255, b: 255 });

  // 3. 检测背景色
  if (solidBackground) return solidBackground;

  return null;
}

/** 检测任意 DOM 元素的视觉背景亮度。 */
export async function detectElementTone(el: HTMLElement): Promise<"light" | "dark"> {
  const color = await detectElementColor(el);
  return colorBrightness(color || { r: 248, g: 247, b: 242 }) < 128 ? "dark" : "light";
}

/**
 * 该元素是不是「页面底色」，而不是压在底色上的小装饰。
 *
 * 采色逻辑原本只看可见性（display/visibility/getClientRects），于是绝对定位的
 * 未读角标也会被当成背景候选。而 [class*="session-"] 这类选择器是按类名子串
 * 匹配的——会话列表里的 .chat-session-unread-badge 恰好含 "session-"，
 * 一进聊天列表就命中它，采到警示红（#ef4444）当作聊天室背景，
 * 状态栏随之被刷成红色，看起来像页面出了故障。
 *
 * 角标/指示灯这类装饰的颜色永远是警示色、面积又极小，不可能是页面底色，
 * 这里统一挡掉，避免以后再加角标时重蹈覆辙。
 */
function isBackgroundDecoration(el: HTMLElement): boolean {
  const className = typeof el.className === "string" ? el.className : "";
  if (/badge/i.test(className)) return true;
  const style = getComputedStyle(el);
  // 绝对/固定定位 + 不吃指针事件：典型的小色块装饰，不是底色
  return style.pointerEvents === "none" && (style.position === "absolute" || style.position === "fixed");
}

/**
 * 按优先级查找当前可见的背景元素。
 * 更具体的（如聊天室）优先于更通用的（如 app 外壳）。
 */
function findBgElements(shell: HTMLElement, activeApp: string | null): HTMLElement[] {
  if (!activeApp) {
    // 主页 → 壁纸
    const wallpaper = shell.querySelector(".phone-wallpaper") as HTMLElement | null;
    return wallpaper ? [wallpaper] : [];
  }

  // 按优先级：具体子页面 > app 容器 > workspace 兜底
  const selectors = [
    '[class*="session-"]',        // 聊天室（z-20，最上层）
    '.qa-app-shell',               // 工坊
    '.reading-app-surface',        // 阅读书架/阅读器（暖黄色背景）
    '.page-body',                  // 页面内容底色（page-shell 自身通常透明）
    '.page-shell',                // 设置/外观/资源库
    '[class*="char-page"]',       // 角色管理
    '.chat-app',                  // 聊天 app 容器（联系人/会话列表）
    '.phone-app-pane > *',        // 任何 app 最外层容器（改进 fallback）
  ];

  const found: HTMLElement[] = [];
  for (const sel of selectors) {
    const elements = Array.from(shell.querySelectorAll(sel)) as HTMLElement[];
    for (const el of elements) {
      const style = getComputedStyle(el);
      const visible = style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
      if (!visible) continue;
      if (isBackgroundDecoration(el)) continue;
      if (!found.includes(el)) found.push(el);
    }
  }
  return found;
}

let latestToneUpdate = 0;

/**
 * 检测当前可见背景的亮度并设置 --status-bar-color。
 * 由 desktop-shell 在 app 切换和 DOM 变化时调用。
 */
export async function updateStatusBarTone(shell: HTMLElement, activeApp: string | null) {
  const updateId = ++latestToneUpdate;
  const elements = findBgElements(shell, activeApp);
  let color: RgbColor | null = null;
  for (const el of elements) {
    color = await detectElementColor(el);
    if (color || updateId !== latestToneUpdate) break;
  }
  color ||= parseCssColor(getComputedStyle(document.documentElement).getPropertyValue("--c-page-body-bg"));
  if (updateId !== latestToneUpdate) return;
  const resolvedColor = color || { r: 248, g: 247, b: 242 };
  const tone = colorBrightness(resolvedColor) < 128 ? "dark" : "light";

  shell.style.setProperty(
    "--status-bar-color",
    tone === "dark" ? "rgba(255,255,255,0.9)" : "#1a1a1a"
  );

  // Drive the browser/PWA status-bar background to follow the actual page color.
  // Chrome/Edge use this meta tag for the Android status bar in standalone/minimal-ui.
  if (typeof document !== "undefined") {
    let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = toHex(resolvedColor);
  }
}
