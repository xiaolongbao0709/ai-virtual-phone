"use client";

import { useEffect, useState } from "react";

import { VERIFY_APPLICATIONS_CLOSED_MESSAGE } from "@/lib/verification-availability";

const QUERY_CODE_KEY = "float_verify_query_code";

type StatusResult = {
  status: "pending" | "approved" | "rejected";
  activationCode: string | null;
  note: string | null;
};

export function VerificationApplicationsClosed() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkCode, setCheckCode] = useState("");
  const [statusResult, setStatusResult] = useState<StatusResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = "Float · 资格查询";
    try {
      setCheckCode(window.localStorage.getItem(QUERY_CODE_KEY) || "");
    } catch { /* ignore */ }
  }, []);

  async function copyActivationCode() {
    const code = statusResult?.activationCode || "";
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，请长按手动复制。");
    }
  }

  async function check() {
    if (busy) return;
    setError("");
    setStatusResult(null);
    const code = checkCode.trim().toUpperCase();
    if (!code) {
      setError("请输入查询码。");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/verify/status?code=${encodeURIComponent(code)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "查询失败，请稍后再试。");
      setStatusResult({ status: data.status, activationCode: data.activationCode, note: data.note });
      try { window.localStorage.setItem(QUERY_CODE_KEY, code); } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : "查询失败，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="vr-root">
      <div className="vr-brand">Float</div>
      <div className="vr-brand-sub">访问资格查询 · Adult Verification</div>

      <section className="vr-card">
        <div className="vr-note">{VERIFY_APPLICATIONS_CLOSED_MESSAGE}</div>
        {error ? <div className="vr-error">{error}</div> : null}

        <label className="vr-field">
          <span>查询码</span>
          <input
            type="text"
            value={checkCode}
            onChange={event => setCheckCode(event.target.value)}
            placeholder="VR-XXXXXXXX"
            maxLength={16}
          />
        </label>
        <button type="button" className="vr-btn" disabled={busy} onClick={check}>
          {busy ? "查询中…" : "查询进度"}
        </button>

        {statusResult ? (
          statusResult.status === "approved" ? (
            <div className="vr-status approved">
              审核已通过 🎉
              <div className="vr-code-box" style={{ margin: "12px 0 0" }}>
                <div className="vr-code-label">你的激活码</div>
                <div className="vr-code-value">{statusResult.activationCode}</div>
                <button type="button" className="vr-copy-btn" onClick={copyActivationCode}>
                  {copied ? "✓ 已复制" : "复制激活码"}
                </button>
              </div>
              <div style={{ marginTop: 10, fontSize: 12.5 }}>回到登录页，激活账号时填入即可。</div>
            </div>
          ) : statusResult.status === "rejected" ? (
            <div className="vr-status rejected">
              申请未通过。
              {statusResult.note ? <div style={{ marginTop: 6 }}>原因：{statusResult.note}</div> : null}
            </div>
          ) : (
            <div className="vr-status pending">正在审核中...</div>
          )
        ) : null}
      </section>

      <a className="vr-back" href="/">← 返回登录页</a>
      <div className="vr-footer">FLOAT · ACCESS STATUS</div>
    </main>
  );
}
