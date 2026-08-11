"use client";

import { useEffect } from "react";
import { isMobileShell } from "@/lib/mobile-shell";

/**
 * 安卓全屏兜底：点击屏幕进入全屏模式（iOS 不支持此 API，会自动忽略）。
 *
 * world-builder（筑境）通过 window.open 开在独立窗口，不在 main-app 的 React 树内，
 * 因此拿不到 main-app 里那段「点击进全屏」的监听，会一直露出浏览器地址栏。
 * 这个组件把同一套逻辑复刻到 world-builder 窗口，挂上即可。
 */
export function AndroidFullscreen() {
  useEffect(() => {
    const isMobile = isMobileShell();
    if (!isMobile) return;

    // [TEST 分支验证] 点击强制全屏已禁用（同 main-app，验证强制横屏根因）
    return () => { };
  }, []);

  return null;
}
