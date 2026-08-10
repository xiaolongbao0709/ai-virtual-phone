"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, RotateCcw } from "lucide-react";
import {
    clearVirtualTime,
    getVirtualNow,
    loadVirtualTimeConfig,
    saveVirtualTime,
} from "@/lib/virtual-time";
import { CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";

type VirtualTimeSettingsProps = {
    onNotice: (msg: string) => void;
};

/**
 * 把 Date 转成 <input type="datetime-local"> 需要的本地时间字符串（YYYY-MM-DDTHH:mm）。
 * datetime-local 使用本地时区、无秒，这里手动补零并裁到分钟。
 */
function toDatetimeLocalValue(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
}

const virtualTimeIconStyle = {
    "--icon-color": CONTENT_APP_ACCENTS.calendar,
} as React.CSSProperties;

export function VirtualTimeSettings({ onNotice }: VirtualTimeSettingsProps) {
    // 是否已激活虚拟时间（决定说明文案与“清除”按钮）
    const [active, setActive] = useState(false);
    // datetime-local 输入框的受控值
    const [inputValue, setInputValue] = useState("");
    // 当前虚拟时间的实时预览（激活时每秒刷新）
    const [preview, setPreview] = useState("");

    // 初次加载：若已设定虚拟时间，回填输入框为当前虚拟时刻；否则回填真实当前时间
    useEffect(() => {
        const cfg = loadVirtualTimeConfig();
        setActive(cfg !== null);
        setInputValue(toDatetimeLocalValue(getVirtualNow()));
    }, []);

    // 激活时，每秒刷新一次“当前虚拟时间”预览，让用户看到时间在流逝
    useEffect(() => {
        if (!active) {
            setPreview("");
            return;
        }
        const tick = () => setPreview(getVirtualNow().toLocaleString());
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, [active]);

    const handleApply = useCallback(() => {
        if (!inputValue) {
            onNotice("请先选择一个日期和时间");
            return;
        }
        // datetime-local 的值按本地时区解析成 Date
        const baseDate = new Date(inputValue);
        if (Number.isNaN(baseDate.getTime())) {
            onNotice("时间格式无效，请重新选择");
            return;
        }
        saveVirtualTime(baseDate);
        setActive(true);
        onNotice(`虚拟时间已设定为 ${baseDate.toLocaleString()}`);
    }, [inputValue, onNotice]);

    const handleClear = useCallback(() => {
        clearVirtualTime();
        setActive(false);
        setInputValue(toDatetimeLocalValue(new Date()));
        onNotice("已恢复真实系统时间");
    }, [onNotice]);

    return (
        <div className="app-card card-featured settings-toggle-card" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="card-icon" style={virtualTimeIconStyle}>
                    <CalendarClock size={22} strokeWidth={1.75} />
                </span>
                <div className="card-featured-body">
                    <div className="card-featured-label">虚拟时间</div>
                    <div className="card-featured-desc">
                        {active
                            ? "AI 与界面都活在你设定的时间线里，时间会正常流逝"
                            : "设定一个基准时刻后，全局时间从此开始流逝（默认跟随真实时间）"}
                    </div>
                </div>
            </div>

            {active && preview ? (
                <div
                    className="ts-12"
                    style={{
                        padding: "6px 10px",
                        borderRadius: 10,
                        background: "var(--c-surface-2, rgba(127,127,127,0.12))",
                    }}
                >
                    当前虚拟时间：{preview}
                </div>
            ) : null}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input
                    type="datetime-local"
                    className="ui-input"
                    style={{ flex: "1 1 180px", minWidth: 0 }}
                    value={inputValue}
                    onChange={event => setInputValue(event.target.value)}
                />
                <button
                    type="button"
                    className="ui-btn ui-btn-primary py-1 px-3 ts-13"
                    style={{ whiteSpace: "nowrap" }}
                    onClick={handleApply}
                >
                    {active ? "更新" : "设定"}
                </button>
                {active ? (
                    <button
                        type="button"
                        className="ui-btn ui-btn-outline py-1 px-3 ts-13"
                        style={{ whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}
                        onClick={handleClear}
                    >
                        <RotateCcw size={14} />
                        恢复真实时间
                    </button>
                ) : null}
            </div>
        </div>
    );
}
