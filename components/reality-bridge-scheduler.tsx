"use client";

import { useEffect } from "react";

import { bgSetTimeout } from "@/lib/bg-timer";
import { hydrateKvDb } from "@/lib/kv-db";
import { processBridgeItem } from "@/lib/reality-bridge/engine";
import { bridgeConnection, loadBridgeSettings, pullBridgeInbox } from "@/lib/reality-bridge/storage";

export const REALITY_BRIDGE_FEED_UPDATED_EVENT = "reality-bridge-feed-updated";

let pollRunning = false;

async function pollOnce(force = false): Promise<number> {
  if (pollRunning) return 0;
  pollRunning = true;
  try {
    await hydrateKvDb();
    const settings = loadBridgeSettings();
    /* force = 用户手动点刷新，是明确意图，不受自动接收开关限制 */
    if (!settings.enabled && !force) return 0;
    const { config, ready } = bridgeConnection();
    if (!ready) return 0;
    const items = await pullBridgeInbox(config);
    for (const item of items) {
      await processBridgeItem(item);
    }
    if (items.length > 0 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(REALITY_BRIDGE_FEED_UPDATED_EVENT));
    }
    return items.length;
  } catch (err) {
    console.warn("[现实桥] 轮询失败", err);
    return 0;
  } finally {
    pollRunning = false;
  }
}

/** 手动触发一次拉取（现实桥 APP 的「立即同步」按钮用），无视自动接收开关。 */
export async function pollRealityBridgeNow(): Promise<number> {
  return pollOnce(true);
}

/** 隐形调度器：挂在 main-app 里，小手机打开期间按间隔轮询收件箱。 */
export function RealityBridgeScheduler() {
  useEffect(() => {
    let cancelTimer: (() => void) | null = null;
    let disposed = false;

    const schedule = () => {
      if (disposed) return;
      const seconds = loadBridgeSettings().pollSeconds;
      // Worker 定时器：iOS 后台会冻结主线程 setTimeout（即使音频保活让进程活着），
      // 与追问/日记/朋友圈等后台服务同款走 bg-timer，保活期间后台照常轮询
      cancelTimer = bgSetTimeout(async () => {
        await pollOnce();
        schedule();
      }, Math.max(10, seconds) * 1000);
    };

    const cancelStartDelay = bgSetTimeout(() => {
      void pollOnce();
      schedule();
    }, 2000);

    // iOS PWA 从后台恢复时 focus 不一定触发，visibilitychange/pageshow 兜底：
    // 一回到小手机就立刻收取积压事件
    const onResume = () => { void pollOnce(); };
    const onVisible = () => { if (document.visibilityState === "visible") void pollOnce(); };
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      cancelStartDelay();
      if (cancelTimer) cancelTimer();
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
