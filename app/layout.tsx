import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ChatPluginBootstrap } from "@/components/chat-plugin-bootstrap";
import { CSSImportEnhancer } from "@/components/css-import-enhancer";
import { PWARegistrar } from "@/components/pwa-registrar";
import "../styles/fonts.css";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "float",
  description: "float",
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        {/* 物理手机检测：浏览器谎报视口（桌面版网站/私有缩放/显示大小调小）时，
            按物理屏幕+触摸点强制手机布局。同步执行避免首屏闪桌面壳。
            大屏档（短边 ≥520）再算整屏缩放 --shell-zoom——与 lib/mobile-shell.ts
            的 computeShellZoom 保持同步。
            设完 --shell-zoom 后用探针元素实测 zoom:var() 是否生效：老 WebKit
            （iPadOS 18 之前）不认这种写法，壳只被变量缩小而没被放大回来，表现为
            居中小屏+大片留白。探测失败就打 data-zoom-fallback，CSS 换用
            transform: scale 完成同样的放大（见 phone-shell.css 末尾兜底块）。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var d=document.documentElement;var t=(navigator.maxTouchPoints||0)>0;var s=Math.min(screen.width,screen.height);var m=window.matchMedia("(hover: none) and (pointer: coarse)").matches;if(!m&&t&&s>0&&s<=620){d.setAttribute("data-force-mobile","1");m=true;}if(m&&s>=520){var z=Math.min(window.innerWidth/390,window.innerHeight/844);if(isFinite(z)&&z>1.001){d.style.setProperty("--shell-zoom",z.toFixed(4));try{var p=document.createElement("div");p.style.cssText="position:absolute;left:-9999px;top:0;width:100px;--zp:2;zoom:var(--zp)";d.appendChild(p);var w=p.getBoundingClientRect().width;d.removeChild(p);if(!(w>150)){d.setAttribute("data-zoom-fallback","1");}}catch(e2){}}}}catch(e){}})();`,
          }}
        />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#f8f7f2" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <link rel="icon" href="/icon-192.png" type="image/png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="float" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <PWARegistrar />
        <CSSImportEnhancer />
        <ChatPluginBootstrap />
        {children}
        {/* 手机横屏提示：网页无法阻止浏览器转屏（部分国产浏览器会自动横屏），
            纯 CSS 检测"触屏+横屏+矮视口"时盖全屏提示，转回竖屏自动消失。
            已安装 PWA 由 manifest orientation:portrait 系统级锁定，不会看到它。 */}
        <div className="rotate-lock-hint" aria-hidden>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="7" y="3" width="10" height="18" rx="2" />
            <path d="M3 8a9 9 0 0 1 3-4M21 16a9 9 0 0 1-3 4" />
          </svg>
          <span>请竖屏使用</span>
        </div>
      </body>
    </html>
  );
}
