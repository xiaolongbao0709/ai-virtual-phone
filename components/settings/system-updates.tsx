"use client";

import { History } from "lucide-react";
import { APP_VERSION, CHANGELOG } from "@/lib/changelog";

export function SystemUpdates() {
  return (
    <div className="flex flex-col gap-5 h-full">
      <p className="card-section-label m-0 mx-2">当前版本</p>
      <div className="g-card flex-row items-center justify-between">
        <div className="flex items-center gap-3">
          <History size={20} className="shrink-0 text-[var(--c-icon-active)]" />
          <div className="flex flex-col">
            <span className="menu-label font-semibold">黑珍珠虚拟手机</span>
            <span className="menu-desc ts-13 !mt-0">功能版本 v{APP_VERSION}</span>
          </div>
        </div>
        <span
          className="ts-12 font-medium shrink-0"
          style={{ color: "#2e9e5b" }}
        >
          已是最新
        </span>
      </div>

      <p className="card-section-label m-0 mx-2">更新内容</p>
      <div className="flex flex-col gap-3">
        {CHANGELOG.map((e) => (
          <div className="g-card flex flex-col items-start gap-2" key={e.version}>
            <div className="flex items-center justify-between w-full">
              <span className="menu-label font-semibold">v{e.version} · {e.title}</span>
              <span className="menu-desc !mt-0">{e.date}</span>
            </div>
            <ul className="m-0 pl-4 list-disc flex flex-col gap-1">
              {e.highlights.map((h, i) => (
                <li key={i} className="menu-desc ts-13 leading-relaxed !mt-0">{h}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="ts-12 mx-2 leading-relaxed" style={{ color: "var(--c-text-muted)" }}>
        每次更新后这里都会追加一条记录。也可以直接问小卷：「最近更新了什么？」
      </p>
    </div>
  );
}
