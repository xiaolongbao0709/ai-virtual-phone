import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ChatPluginBootstrap } from "@/components/chat-plugin-bootstrap";
import { ChatReasoningVisibilityController } from "@/components/chat-reasoning-visibility-controller";
import { CSSImportEnhancer } from "@/components/css-import-enhancer";
import { NativePushBridge } from "@/components/native-push-bridge";
import { PWAManifestInjector } from "@/components/pwa-manifest-injector";
import { shellChannel } from "@/lib/mobile-shell";
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
            行为受两层控制：部署渠道（shellChannel，beta 才启用物理强制与缩放的
            自动挡）+ 用户「显示形态」三挡覆盖（localStorage，外观 App 里设置，
            与 lib/mobile-shell.ts 的 writeShellModeOverride 保持同步）。
            大屏档（短边 ≥520）再算整屏缩放 --shell-zoom——与 lib/mobile-shell.ts
            的 computeShellZoom 保持同步。
            设完 --shell-zoom 后用探针元素实测 zoom:var() 是否生效：老 WebKit
            （iPadOS 18 之前）不认这种写法，壳只被变量缩小而没被放大回来，表现为
            居中小屏+大片留白。探测失败就打 data-zoom-fallback，CSS 换用
            transform: scale 完成同样的放大（见 phone-shell.css 末尾兜底块）。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var d=document.documentElement;var mode=null;try{mode=localStorage.getItem("ai_phone_shell_mode_v1");}catch(e3){}if(mode!=="phone"&&mode!=="desktop")mode="auto";var ch=${JSON.stringify(shellChannel())};var t=(navigator.maxTouchPoints||0)>0;var s=Math.min(screen.width,screen.height);var m=window.matchMedia("(hover: none) and (pointer: coarse)").matches;if(!m){if(mode==="phone"){d.setAttribute("data-force-mobile","1");m=true;}else if(mode==="auto"&&ch==="beta"&&t&&s>0&&s<=620){d.setAttribute("data-force-mobile","1");m=true;}}if(m&&s>=520&&(ch==="beta"||mode==="phone")){var z=Math.min(window.innerWidth/390,window.innerHeight/844);if(isFinite(z)&&z>1.001){d.style.setProperty("--shell-zoom",z.toFixed(4));try{var p=document.createElement("div");p.style.cssText="position:absolute;left:-9999px;top:0;width:100px;--zp:2;zoom:var(--zp)";d.appendChild(p);var w=p.getBoundingClientRect().width;d.removeChild(p);if(!(w>150)){d.setAttribute("data-zoom-fallback","1");}}catch(e2){}}}}catch(e){}})();`,
          }}
        />
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <meta name="theme-color" content="#f8f7f2" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <link rel="icon" href="/icon-192.png" type="image/png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="float" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <PWAManifestInjector />
        <NativePushBridge />
        <PWARegistrar />
        <CSSImportEnhancer />
        <ChatPluginBootstrap />
        <ChatReasoningVisibilityController />
        {children}
      </body>
    </html>
  );
}
