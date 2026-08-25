"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getTtsVolume, setTtsVolume } from "@/lib/tts-service";

/**
 * In-app volume control for character speech during calls. iOS plays the TTS on a
 * stream the hardware volume keys don't reach, so this slider is the only way to
 * adjust it. Self-positioned (top-right corner) so it drops into any of the four
 * call screens without touching their top-bar markup. Collapsed to a small icon by
 * default; tapping reveals a slider that auto-hides after a few idle seconds.
 */
export function CallVolumeControl() {
  const [open, setOpen] = useState(false);
  const [volume, setVolume] = useState(1);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 上次通话把音量拖到 0 会被永久记忆，控件又默认折叠，用户往往不知道
  // 通话为什么无声。不强制改用户的设置：进通话时若记忆是静音，把滑杆
  // 主动弹出来让用户看到、自己调，首次展示多停留几秒再收起。
  const mutedIntroRef = useRef(false);

  useEffect(() => {
    const v = getTtsVolume();
    setVolume(v);
    if (v <= 0.001) {
      mutedIntroRef.current = true;
      setOpen(true);
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const delay = mutedIntroRef.current ? 8000 : 2800;
    mutedIntroRef.current = false;
    hideTimer.current = setTimeout(() => setOpen(false), delay);
  }, []);

  useEffect(() => {
    if (open) scheduleHide();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [open, scheduleHide]);

  const onChange = (v: number) => {
    setVolume(v);
    setTtsVolume(v);
    scheduleHide();
  };

  const muted = volume <= 0.001;

  return (
    <div className={`call-volume${open ? " is-open" : ""}`} data-ui="call-volume">
      <button
        type="button"
        className="call-volume-btn"
        aria-label="角色语音音量"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          {muted ? (
            <><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>
          ) : (
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
          )}
        </svg>
      </button>
      {open && (
        <input
          type="range"
          className="call-volume-slider"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          aria-label="音量"
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerDown={scheduleHide}
        />
      )}
    </div>
  );
}
