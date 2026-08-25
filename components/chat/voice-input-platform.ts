"use client";

export function isAndroidBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Android/i.test(navigator.userAgent);
}

export function isIOSDevice(): boolean {
    if (typeof navigator === "undefined") return false;
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
    // iPadOS 13+ 桌面模式 UA 伪装成 Mac，但 Mac 没有多点触控
    return /Macintosh/i.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1;
}
