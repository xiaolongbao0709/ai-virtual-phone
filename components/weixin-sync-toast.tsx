"use client";

// 微信云同步 toast：weixin-cloud-sync 广播的同步事件在这里可视化。
// 现在只有失败会广播（进度/成功提示按用户反馈撤掉了），同 id 的后续事件
// 原地替换、text 为 null 时无声撤下。挂在桌面壳根部，停在哪个 App 都看得见。
// 挂在顶部（状态栏下方）：常驻条放底部会挡住聊天输入栏。

import { useEffect, useRef, useState } from "react";
import { WEIXIN_SYNC_TOAST_EVENT } from "@/lib/weixin-cloud-sync";

type ToastEntry = { id: string; text: string; sticky: boolean };

export function WeixinSyncToast() {
    const [entries, setEntries] = useState<ToastEntry[]>([]);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

    useEffect(() => {
        const timersMap = timers.current;
        const clearTimer = (id: string) => {
            const timer = timersMap.get(id);
            if (timer) clearTimeout(timer);
            timersMap.delete(id);
        };
        const remove = (id: string) => {
            clearTimer(id);
            setEntries(prev => prev.filter(entry => entry.id !== id));
        };
        const onToast = (event: Event) => {
            const detail = (event as CustomEvent).detail as
                { id?: string; text?: string | null; sticky?: boolean; duration?: number } | undefined;
            if (!detail?.id) return;
            const id = detail.id;
            if (detail.text === null || detail.text === undefined || !detail.text) {
                remove(id);
                return;
            }
            const entry: ToastEntry = { id, text: detail.text, sticky: detail.sticky === true };
            setEntries(prev => {
                const rest = prev.filter(item => item.id !== id);
                return [...rest, entry];
            });
            clearTimer(id);
            // sticky 常驻到被同 id 的后续事件替换/撤下；结果条到点自动消隐
            if (!entry.sticky) {
                timersMap.set(id, setTimeout(() => remove(id), Math.max(1200, Number(detail.duration) || 2200)));
            }
        };
        window.addEventListener(WEIXIN_SYNC_TOAST_EVENT, onToast);
        return () => {
            window.removeEventListener(WEIXIN_SYNC_TOAST_EVENT, onToast);
            for (const timer of timersMap.values()) clearTimeout(timer);
            timersMap.clear();
        };
    }, []);

    if (entries.length === 0) return null;
    return (
        <div
            style={{
                position: "fixed",
                left: "50%",
                top: "calc(env(safe-area-inset-top, 0px) + 44px)",
                transform: "translateX(-50%)",
                zIndex: 3000,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                pointerEvents: "none",
            }}
        >
            {entries.map(entry => (
                // wp-toast 本身是 sticky（为 App 内布局设计），此处在固定容器里改回常规流
                <div className="wp-toast" style={{ position: "static" }} key={entry.id}>
                    {entry.text}
                </div>
            ))}
        </div>
    );
}
