"use client";

import { useEffect, useMemo, useState } from "react";
import { useCheckPhoneRefresh } from "@/lib/checkphone-refresh-tracker";
import { ChevronLeft, PlaySquare, User, RotateCcw, Eraser } from "lucide-react";
import { CheckPhoneBilingualText } from "@/components/checkphone/checkphone-bilingual-text";
import { CheckPhoneDebugErrorCard } from "@/components/checkphone/checkphone-debug-error-card";
import { ConfirmDialog } from "@/components/ui";
import type { Character } from "@/lib/character-types";
import type {
  CheckPhoneBilibiliPayload,
  CheckPhoneSnapshot,
} from "@/lib/checkphone-config";
import { generateCheckPhoneBilibili } from "@/lib/checkphone-engine";
import { clearPhoneSnapshot, loadPhoneSnapshot, savePhoneSnapshot } from "@/lib/checkphone-storage";

type CheckPhoneBilibiliPageProps = {
  character: Character;
  onBack: () => void;
};

type BilibiliTabId = "history" | "favorites";

type BilibiliEntry =
  | (CheckPhoneBilibiliPayload["watchHistory"][number] & { section: "history" })
  | (CheckPhoneBilibiliPayload["favorites"][number] & { section: "favorites" });

function formatBilibiliTime(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const hhmm = value.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (value >= todayStart) return `今天 ${hhmm}`;
  if (value >= yesterdayStart) return `昨天 ${hhmm}`;
  return value.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).replace(/\//g, ".") + ` ${hhmm}`;
}

function formatBilibiliListTime(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  const pad = (number: number) => number.toString().padStart(2, "0");
  return `${value.getFullYear()}年${pad(value.getMonth() + 1)}月${pad(value.getDate())}日 ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function formatBilibiliPlayCount(value: number): string {
  if (value >= 10000) {
    const wan = value / 10000;
    const text = wan >= 10 ? Math.round(wan).toString() : wan.toFixed(1).replace(/\.0$/, "");
    return `${text}万播放`;
  }
  return `${value}播放`;
}

function getEntries(payload: CheckPhoneBilibiliPayload | null, tab: BilibiliTabId): BilibiliEntry[] {
  if (!payload) return [];
  if (tab === "history") return payload.watchHistory.map((item) => ({ ...item, section: "history" }));
  return payload.favorites.map((item) => ({ ...item, section: "favorites" }));
}

function parseBilibiliDurationToSeconds(value: string): number {
  const parts = value.match(/\d+/g)?.map((part) => Number(part)) ?? [];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function calculateBilibiliProgress(progressLabel: string, durationLabel: string): number {
  if (progressLabel.includes("看完")) return 100;
  if (progressLabel.includes("刚开始")) return 2;

  const percentMatch = progressLabel.match(/(\d+(?:\.\d+)?)%/);
  if (percentMatch) return Math.min(100, Math.max(0, Number(percentMatch[1])));

  const [currentLabel] = progressLabel.split("/");
  const current = parseBilibiliDurationToSeconds(currentLabel ?? "");
  const total = parseBilibiliDurationToSeconds(durationLabel);
  if (current > 0 && total > 0) return Math.min(100, Math.max(0, (current / total) * 100));

  return 0;
}

export function CheckPhoneBilibiliPage({ character, onBack }: CheckPhoneBilibiliPageProps) {
  const [snapshot, setSnapshot] = useState<CheckPhoneSnapshot<CheckPhoneBilibiliPayload> | null>(null);
  const [selectedTab, setSelectedTab] = useState<BilibiliTabId>("history");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useCheckPhoneRefresh(character.id, "bilibili", setSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [debugRawOutput, setDebugRawOutput] = useState<string | null>(null);
  const [debugSanitizedOutput, setDebugSanitizedOutput] = useState<string | null>(null);
  const [debugParseMode, setDebugParseMode] = useState<"raw" | "sanitized" | "failed" | null>(null);
  const [debugParseError, setDebugParseError] = useState<string | null>(null);
  const [debugNormalizeError, setDebugNormalizeError] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setSnapshot(null);
    setSelectedTab("history");
    setSelectedEntryId(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    (async () => {
      const cached = await loadPhoneSnapshot<CheckPhoneBilibiliPayload>(character.id, "bilibili");
      if (cancelled) return;
      setSnapshot(cached);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  async function handleRefresh() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    const {
      payload,
      summary,
      error: nextError,
      debugRawOutput: nextDebugRawOutput,
      debugSanitizedOutput: nextDebugSanitizedOutput,
      debugParseMode: nextDebugParseMode,
      debugParseError: nextDebugParseError,
      debugNormalizeError: nextDebugNormalizeError,
    } = await generateCheckPhoneBilibili(character.id, snapshot?.payload ?? null, snapshot?.updatedAt);
    if (payload) {
      const now = new Date().toISOString();
      const nextSnapshot: CheckPhoneSnapshot<CheckPhoneBilibiliPayload> = {
        id: `${character.id}:bilibili`,
        characterId: character.id,
        appId: "bilibili",
        generatedAt: snapshot?.generatedAt ?? now,
        updatedAt: now,
        summary,
        payload,
      };
      await savePhoneSnapshot(nextSnapshot);
      setSnapshot(nextSnapshot);
      setSelectedEntryId(null);
    }
    setError(nextError ?? null);
    setDebugRawOutput(nextDebugRawOutput ?? null);
    setDebugSanitizedOutput(nextDebugSanitizedOutput ?? null);
    setDebugParseMode(nextDebugParseMode ?? null);
    setDebugParseError(nextDebugParseError ?? null);
    setDebugNormalizeError(nextDebugNormalizeError ?? null);
    setLoading(false);
    setLoaded(true);
  }

  async function handleClear() {
    if (loading) return;
    await clearPhoneSnapshot(character.id, "bilibili");
    setSnapshot(null);
    setSelectedTab("history");
    setSelectedEntryId(null);
    setError(null);
    setDebugRawOutput(null);
    setDebugSanitizedOutput(null);
    setDebugParseMode(null);
    setDebugParseError(null);
    setDebugNormalizeError(null);
    setLoaded(true);
    setConfirmClearOpen(false);
  }

  const payload = snapshot?.payload ?? null;
  const currentEntries = useMemo(() => getEntries(payload, selectedTab), [payload, selectedTab]);
  const allEntries = useMemo(
    () =>
      payload
        ? [
            ...payload.watchHistory.map((item) => ({ ...item, section: "history" as const })),
            ...payload.favorites.map((item) => ({ ...item, section: "favorites" as const })),
          ]
        : [],
    [payload],
  );
  const activeEntry = useMemo(
    () => allEntries.find((item) => item.id === selectedEntryId) ?? null,
    [allEntries, selectedEntryId],
  );

  return (
    <div className="cp-bilibili-module">
      <header className="cp-bilibili-appbar" style={{ background: "#fff", borderBottom: "1px solid #f0f0f0", padding: "var(--cp-appbar-safe-top) 16px 10px" }}>
        <button type="button" className="cp-float-back" onClick={activeEntry ? () => setSelectedEntryId(null) : onBack} aria-label="Back" style={{ color: "#333", background: "transparent", boxShadow: "none" }}>
          <ChevronLeft size={26} strokeWidth={2} />
        </button>
        {!activeEntry ? (
          <div style={{ flex: 1, display: "flex", justifyContent: "center", gap: "28px", alignItems: "center" }}>
             <button type="button" onClick={() => setSelectedTab("history")} style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: selectedTab === "history" ? 500 : 400, color: selectedTab === "history" ? "#fb7299" : "#666", position: "relative", border: "none", background: "transparent", padding: 0 }}>
                历史记录
                {selectedTab === "history" && <div style={{ position: "absolute", bottom: "-6px", left: "50%", transform: "translateX(-50%)", width: "16px", height: "3px", background: "#fb7299", borderRadius: "2px" }} />}
             </button>
             <button type="button" onClick={() => setSelectedTab("favorites")} style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: selectedTab === "favorites" ? 500 : 400, color: selectedTab === "favorites" ? "#fb7299" : "#666", position: "relative", border: "none", background: "transparent", padding: 0 }}>
                收藏
                {selectedTab === "favorites" && <div style={{ position: "absolute", bottom: "-6px", left: "50%", transform: "translateX(-50%)", width: "16px", height: "3px", background: "#fb7299", borderRadius: "2px" }} />}
             </button>
          </div>
        ) : (
          <div className="cp-bilibili-header-stack" style={{ position: "static", transform: "none", flex: 1, alignItems: "center" }}>
            <div className="cp-bilibili-header-title" style={{ fontSize: "calc(16px*var(--app-text-scale,1))", color: "#333", fontWeight: 500 }}>{activeEntry.section === "history" ? "历史记录" : "收藏"}</div>
          </div>
        )}
        <div className="cp-appbar-actions" style={{ gap: "12px", position: "static" }}>
          <button type="button" onClick={handleRefresh} disabled={loading} aria-label="Refresh" style={{ border: "none", background: "transparent", color: "#666", padding: 0, boxShadow: "none" }}>
            <RotateCcw size={20} strokeWidth={2} className={loading ? "cp-spin" : ""} />
          </button>
          <button type="button" onClick={() => setConfirmClearOpen(true)} disabled={loading || !snapshot} aria-label="Clear" style={{ border: "none", background: "transparent", color: "#666", padding: 0, boxShadow: "none", marginLeft: 8 }}>
            <Eraser size={20} strokeWidth={2} />
          </button>
        </div>
      </header>

      {loading && (
        <div className="cp-refresh-indicator cp-refresh-indicator--floating" aria-live="polite">
          <span className="cp-refresh-indicator-text">正在刷新 B站</span>
          <span className="cp-refresh-indicator-dots" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
        </div>
      )}

      <div className="cp-bilibili-body" style={{ background: "#fff", padding: 0, gap: 0 }}>
        {!loaded && <div className="cp-bilibili-status">正在同步 B站痕迹...</div>}

        {loaded && !payload && !loading && (
          <div className="cp-bilibili-status cp-empty-copy">
            <p>暂无B站内容</p>
            <span className="cp-bilibili-hint">点刷新同步观看记录和收藏</span>
          </div>
        )}

        {error ? (
          <CheckPhoneDebugErrorCard
            title="暂时无法解析 B站 内容。"
            error={error}
            debugParseMode={debugParseMode}
            debugParseError={debugParseError}
            debugNormalizeError={debugNormalizeError}
            debugRawOutput={debugRawOutput}
            debugSanitizedOutput={debugSanitizedOutput}
          />
        ) : null}

        {payload && !activeEntry && (
          <>

            <div className="cp-bilibili-list" style={{ gap: 0, padding: "0 12px" }}>
              {currentEntries.map((entry) => (
                <button key={entry.id} type="button" className="cp-bilibili-card" onClick={() => setSelectedEntryId(entry.id)} style={{ flexDirection: "row", padding: "12px 0", borderBottom: "1px solid #f0f0f0", borderRadius: 0, boxShadow: "none", background: "transparent", alignItems: "flex-start" }}>
                  <div
                    className="cp-bilibili-card-icon"
                    style={{
                      width: "140px",
                      height: "80px",
                      borderRadius: "6px",
                      position: "relative",
                      background: "linear-gradient(145deg, #272b31 0%, #171a20 62%, #101216 100%)",
                      flexShrink: 0,
                      color: "#fff",
                      overflow: "hidden",
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -14px 24px rgba(0,0,0,0.18)",
                    }}
                  >
                    {entry.icon}
                    <div style={{ position: "absolute", bottom: "4px", right: "4px", background: "rgba(0,0,0,0.5)", color: "#fff", fontSize: "calc(10px*var(--app-text-scale,1))", padding: "2px 4px", borderRadius: "4px" }}>
                       {entry.durationLabel || "00:00"}
                    </div>
                  </div>
                  <div className="cp-bilibili-card-main" style={{ justifyContent: "space-between", height: "80px", marginLeft: "12px" }}>
                    <h4 style={{ margin: 0, fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 400, color: "#333", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", lineHeight: "1.4" }}><CheckPhoneBilingualText text={entry.title} tone="bilibili" /></h4>
                    <div className="cp-bilibili-card-meta" style={{ display: "flex", flexDirection: "column", gap: "4px", color: "#999", fontSize: "calc(12px*var(--app-text-scale,1))", marginTop: "auto" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ border: "1px solid #ccc", padding: "0 4px", borderRadius: "4px", fontSize: "calc(9px*var(--app-text-scale,1))", color: "#999" }}>UP</span>
                        <span>{entry.upName}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        {selectedTab === "history" ?
                          <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", whiteSpace: "nowrap" }}>{formatBilibiliListTime(entry.createdAt)}</span> :
                          <span>{formatBilibiliPlayCount(entry.playCount)}</span>
                        }
                      </div>
                    </div>
                  </div>
                  <div style={{ padding: "0 8px", color: "#999" }}>⋮</div>
                </button>
              ))}
            </div>
          </>
        )}

        {payload && activeEntry && (
          <div className="cp-scroll-guard" style={{ position: "absolute", inset: 0, zIndex: 20, background: "#fff", display: "flex", flexDirection: "column", overflowY: "auto" }}>
            <div style={{ paddingTop: "var(--cp-appbar-safe-top)", background: "#000" }}>
              <div style={{ position: "relative", width: "100%", aspectRatio: "16/9", background: "linear-gradient(135deg, #252a31 0%, #0d0f14 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: "30px 42px", color: "rgba(255,255,255,0.78)", fontSize: "calc(15px*var(--app-text-scale,1))", fontStyle: "italic", lineHeight: 1.65, textAlign: "center" }}>
                <div style={{ maxWidth: "82%" }}><CheckPhoneBilingualText text={activeEntry.visualDescription} tone="light" /></div>
                <button type="button" onClick={() => setSelectedEntryId(null)} style={{ position: "absolute", top: "12px", left: "12px", background: "rgba(0,0,0,0.4)", width: "32px", height: "32px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", border: "none" }}>
                  <ChevronLeft size={24} />
                </button>
                <div style={{ position: "absolute", bottom: "8px", right: "8px", background: "rgba(0,0,0,0.6)", color: "#fff", padding: "2px 6px", fontSize: "calc(11px*var(--app-text-scale,1))", borderRadius: "4px" }}>{activeEntry.durationLabel}</div>
                {"progressLabel" in activeEntry ? (
                  <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "3px", background: "rgba(255,255,255,0.32)" }} aria-hidden="true">
                    <div
                      style={{
                        width: `${calculateBilibiliProgress(activeEntry.progressLabel, activeEntry.durationLabel)}%`,
                        height: "100%",
                        background: "rgba(251, 114, 153, 0.58)",
                        borderRadius: "0 999px 999px 0",
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <div style={{ padding: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", color: "#999", fontSize: "calc(18px*var(--app-text-scale,1))", border: "1px solid #eee" }}>
                    <User size={20} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, color: "#fb7299" }}>{activeEntry.upName}</div>
                    <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#999" }}>10.1万粉丝  240视频</div>
                  </div>
                </div>
                <button style={{ background: "#fb7299", color: "#fff", border: "none", borderRadius: "14px", padding: "4px 16px", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500, display: "flex", alignItems: "center", gap: "4px" }}>
                  <span>+</span> 关注
                </button>
              </div>

              <h2 style={{ margin: "0 0 8px 0", fontSize: "calc(17px*var(--app-text-scale,1))", fontWeight: 500, color: "#111", lineHeight: 1.4 }}>
                <CheckPhoneBilingualText text={activeEntry.title} tone="bilibili" />
              </h2>

              <div style={{ display: "flex", alignItems: "center", gap: "12px", color: "#999", fontSize: "calc(12px*var(--app-text-scale,1))", marginBottom: "20px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "4px" }}><PlaySquare size={14} /> {formatBilibiliPlayCount(activeEntry.playCount)}</span>
                <span>{formatBilibiliTime(activeEntry.createdAt)}</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "16px 0", borderTop: "1px solid #f0f0f0" }}>
                {("stateNote" in activeEntry) && (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "calc(13px*var(--app-text-scale,1))", color: "#999", marginBottom: "4px" }}>
                      <span style={{ width: "3px", height: "12px", borderRadius: "999px", background: "rgba(251, 114, 153, 0.58)" }} />
                      当时状态
                    </div>
                    <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#333", lineHeight: 1.5 }}><CheckPhoneBilingualText text={activeEntry.stateNote} tone="bilibili" /></div>
                  </div>
                )}
                {("saveReason" in activeEntry) && (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "calc(13px*var(--app-text-scale,1))", color: "#999", marginBottom: "4px" }}>
                      <span style={{ width: "3px", height: "12px", borderRadius: "999px", background: "rgba(251, 114, 153, 0.58)" }} />
                      收藏原因
                    </div>
                    <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#333", lineHeight: 1.5 }}><CheckPhoneBilingualText text={activeEntry.saveReason} tone="bilibili" /></div>
                  </div>
                )}
                {activeEntry.feeling && (
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "calc(13px*var(--app-text-scale,1))", color: "#999", marginBottom: "4px" }}>
                      <span style={{ width: "3px", height: "12px", borderRadius: "999px", background: "rgba(251, 114, 153, 0.58)" }} />
                      内心感受
                    </div>
                    <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", color: "#333", lineHeight: 1.5 }}><CheckPhoneBilingualText text={activeEntry.feeling} tone="bilibili" /></div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {confirmClearOpen && (
        <ConfirmDialog
          title="清空 B站 内容？"
          message="确认后会清空当前 B站 缓存。之后重新刷新时，不会再带入旧 B站 内容。"
          variant="danger"
          confirmLabel="确认清空"
          cancelLabel="取消"
          onConfirm={handleClear}
          onCancel={() => setConfirmClearOpen(false)}
        />
      )}
    </div>
  );
}
