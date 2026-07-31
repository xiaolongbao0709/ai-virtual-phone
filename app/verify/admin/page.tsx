"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "../verify.css";

const ADMIN_KEY_STORAGE = "float_verify_admin_key";

type AdminItem = {
  id: string;
  queryCode: string;
  contact: string;
  status: "pending" | "approved" | "rejected";
  activationCode: string | null;
  note: string | null;
  createdAt: string;
  reviewedAt: string | null;
  hasImage: boolean;
};

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function AdminImage({ id, adminKey }: { id: string; adminKey: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const node = hostRef.current;
    if (!node || shouldLoad) return;
    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setShouldLoad(true);
        observer.disconnect();
      }
    }, { rootMargin: "300px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    let objectUrl = "";
    setSrc("");
    setError("");

    void (async () => {
      try {
        const response = await fetch(`/api/verify/admin/image?id=${encodeURIComponent(id)}`, {
          headers: { "x-verify-admin-key": adminKey },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `图片加载失败（${response.status}）`);
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "图片加载失败");
        }
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [adminKey, id, shouldLoad]);

  return (
    <div ref={hostRef}>
      {error ? <div className="vr-error" style={{ marginTop: 8 }}>审核图片加载失败：{error}</div> : null}
      {!error && !src ? <div className="vr-admin-time" style={{ marginTop: 8 }}>审核图片加载中…</div> : null}
      {src ? <img className="vr-admin-img" src={src} alt="审核图片" /> : null}
    </div>
  );
}

export default function VerifyAdminPage() {
  const [key, setKey] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [items, setItems] = useState<AdminItem[]>([]);
  const [view, setView] = useState<"pending" | "all">("pending");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (adminKey: string, which: "pending" | "all") => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/verify/admin?view=${which}`, { headers: { "x-verify-admin-key": adminKey } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "加载失败");
      setItems(data.items as AdminItem[]);
      setUnlocked(true);
      try { window.localStorage.setItem(ADMIN_KEY_STORAGE, adminKey); } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
      if (!unlocked) setUnlocked(false);
    } finally {
      setLoading(false);
    }
  }, [unlocked]);

  useEffect(() => {
    document.title = "Float · 审核台";
    try {
      const saved = window.localStorage.getItem(ADMIN_KEY_STORAGE) || "";
      if (saved) { setKey(saved); void refresh(saved, "pending"); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function decide(id: string, action: "approve" | "reject") {
    if (busyId) return;
    let note = "";
    if (action === "reject") note = window.prompt("拒绝原因（会展示给申请者，可留空）：") ?? "";
    else if (!window.confirm("确认通过并自动发放一个激活码？")) return;
    setBusyId(id);
    setError("");
    try {
      const response = await fetch("/api/verify/admin", {
        method: "POST",
        headers: { "content-type": "application/json", "x-verify-admin-key": key },
        body: JSON.stringify({ id, action, note }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "操作失败");
      await refresh(key, view);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyId("");
    }
  }

  return (
    <main className="vr-root">
      <div className="vr-brand">Float</div>
      <div className="vr-brand-sub">内测审核台 · Admin</div>

      <section className="vr-card" style={{ maxWidth: 560 }}>
        {!unlocked ? (
          <div>
            <label className="vr-field">
              <span>管理密钥（VERIFY_ADMIN_KEY）</span>
              <input type="text" value={key} onChange={event => setKey(event.target.value)} placeholder="输入后进入审核台" />
            </label>
            {error ? <div className="vr-error">{error}</div> : null}
            <button type="button" className="vr-btn" disabled={loading || !key.trim()} onClick={() => refresh(key.trim(), view)}>
              {loading ? "验证中…" : "进入审核台"}
            </button>
          </div>
        ) : (
          <div>
            <div className="vr-tabs">
              <button type="button" className={`vr-tab${view === "pending" ? " on" : ""}`} onClick={() => { setView("pending"); void refresh(key, "pending"); }}>待审核</button>
              <button type="button" className={`vr-tab${view === "all" ? " on" : ""}`} onClick={() => { setView("all"); void refresh(key, "all"); }}>全部记录</button>
            </div>
            {error ? <div className="vr-error">{error}</div> : null}
            <button type="button" className="vr-btn ghost" style={{ marginTop: 0 }} disabled={loading} onClick={() => refresh(key, view)}>
              {loading ? "刷新中…" : "刷新列表"}
            </button>

            <div className="vr-admin-list">
              {items.length === 0 && !loading ? <div className="vr-status pending">{view === "pending" ? "暂无待审核的申请。" : "暂无记录。"}</div> : null}
              {items.map(item => (
                <div key={item.id} className="vr-admin-item">
                  <div className="vr-admin-meta">
                    <span className="vr-admin-contact">{item.contact}</span>
                    <span className={`vr-admin-tag ${item.status}`}>{item.status === "pending" ? "待审核" : item.status === "approved" ? "已通过" : "已拒绝"}</span>
                  </div>
                  <div className="vr-admin-time">提交 {formatTime(item.createdAt)} · 查询码 {item.queryCode}{item.reviewedAt ? ` · 审核 ${formatTime(item.reviewedAt)}` : ""}</div>
                  {item.status === "approved" && item.activationCode ? <div className="vr-admin-time">发放激活码：<span className="vr-admin-code">{item.activationCode}</span></div> : null}
                  {item.status === "rejected" && item.note ? <div className="vr-admin-time">拒绝原因：{item.note}</div> : null}
                  {item.hasImage ? <AdminImage id={item.id} adminKey={key} /> : <div className="vr-admin-time" style={{ marginTop: 8 }}>（图片已删除）</div>}
                  {item.status === "pending" ? (
                    <div className="vr-admin-actions">
                      <button type="button" className="vr-admin-approve" disabled={busyId === item.id} onClick={() => decide(item.id, "approve")}>{busyId === item.id ? "处理中…" : "通过并发码"}</button>
                      <button type="button" className="vr-admin-reject" disabled={busyId === item.id} onClick={() => decide(item.id, "reject")}>拒绝</button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
