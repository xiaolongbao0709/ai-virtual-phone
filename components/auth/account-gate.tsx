"use client";

import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Loader2, LogIn } from "lucide-react";

import { AccountProvider } from "@/lib/account-context";
import { ACCOUNT_NETWORK_ERROR, fetchCurrentAccount, loginAccount, logoutAccount, type AccountProfile } from "@/lib/account-client";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";
import { VERIFY_APPLICATIONS_CLOSED_MESSAGE, VERIFY_APPLICATIONS_OPEN } from "@/lib/verification-availability";

type AccountGateProps = {
  children: ReactNode;
};

type GateStatus = "checking" | "ready" | "signed-out" | "unreachable";

const SELF_HOSTED_ACCOUNT: AccountProfile = {
  id: "local_user",
  username: "local_user",
  displayName: "本地用户",
  status: "active",
};

// 内联兜底：弱网/离线下 SW 可能回退到旧 HTML，外链 CSS 拉不到（旧 hash 已 404），
// 此时全页无样式，「正在校验账号」会裸排在左上角。内联样式不依赖外部 CSS，保证居中。
const gateRootFallbackStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const gatePanelFallbackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  textAlign: "center",
};

export function AccountGate({ children }: AccountGateProps) {
  const selfHostedMode = isSelfHostedModeEnabled();
  const [status, setStatus] = useState<GateStatus>(selfHostedMode ? "ready" : "checking");
  const [account, setAccount] = useState<AccountProfile | null>(selfHostedMode ? SELF_HOSTED_ACCOUNT : null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refreshAccount() {
    if (selfHostedMode) {
      setAccount(SELF_HOSTED_ACCOUNT);
      setStatus("ready");
      setError("");
      return;
    }

    let result: Awaited<ReturnType<typeof fetchCurrentAccount>>;
    try {
      result = await fetchCurrentAccount();
    } catch {
      result = { ok: false, account: null, error: ACCOUNT_NETWORK_ERROR };
    }
    if (result.ok && result.account) {
      setAccount(result.account);
      setStatus("ready");
      setError("");
      return;
    }
    // 网络层失败（超时/断连/切网）：会话 cookie 还在，不应登出——给重试入口
    if (result.error === ACCOUNT_NETWORK_ERROR) {
      setStatus("unreachable");
      return;
    }
    setAccount(null);
    setStatus("signed-out");
    if (result.error && !/账号状态读取失败/.test(result.error)) setError(result.error);
  }

  useEffect(() => {
    if (selfHostedMode) {
      setAccount(SELF_HOSTED_ACCOUNT);
      setStatus("ready");
      setError("");
      return;
    }

    void refreshAccount();
    // 网络恢复（含 WiFi↔流量切换完成）时自动重试校验
    const onOnline = () => {
      setStatus(current => {
        if (current === "checking" || current === "unreachable") {
          void refreshAccount();
        }
        return current;
      });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfHostedMode]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await loginAccount({
        username,
        password,
        activationCode: activationCode.trim() || undefined,
      });
      if (!result.ok || !result.account) {
        setError(result.error || "登录失败。");
        return;
      }
      setAccount(result.account);
      setStatus("ready");
      setPassword("");
      setActivationCode("");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (selfHostedMode) {
      setAccount(SELF_HOSTED_ACCOUNT);
      setStatus("ready");
      return;
    }

    await logoutAccount();
    setAccount(null);
    setStatus("signed-out");
  }

  const serviceError = error && /账号表尚未创建|Supabase 环境变量/.test(error);

  if (status === "unreachable") {
    return (
      <main className="app-root account-gate-root" style={gateRootFallbackStyle}>
        <section className="account-gate-card account-gate-loading" style={gatePanelFallbackStyle}>
          <span>网络连接不畅，账号校验失败</span>
          <button
            type="button"
            className="account-gate-retry-btn"
            onClick={() => { setStatus("checking"); void refreshAccount(); }}
          >
            重试
          </button>
        </section>
      </main>
    );
  }

  if (status === "checking") {
    return (
      <main className="app-root account-gate-root" style={gateRootFallbackStyle}>
        <section className="account-gate-panel" aria-live="polite" style={gatePanelFallbackStyle}>
          <Loader2 className="account-gate-spinner" size={24} />
          <span>正在校验账号...</span>
        </section>
      </main>
    );
  }

  if (status === "ready" && account) {
    return (
      <AccountProvider account={account} refreshAccount={refreshAccount} logout={handleLogout}>
        {children}
      </AccountProvider>
    );
  }

  return (
    <main className="app-root account-gate-root" style={gateRootFallbackStyle}>
      <section className="account-gate-card" aria-label="账号登录">
        <div className="account-gate-copy">
          <span>AI PHONE ACCESS</span>
          {serviceError ? <p>账号服务尚未就绪</p> : null}
        </div>

        <form className="account-gate-form" onSubmit={handleSubmit}>
          <label>
            <span>账号</span>
            <input
              value={username}
              onChange={event => setUsername(event.target.value)}
              autoComplete="username"
              inputMode="text"
              placeholder="例如 user001"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete="current-password"
              type="password"
              placeholder="至少 6 位"
            />
          </label>
          <label>
            <span>激活码</span>
            <input
              value={activationCode}
              onChange={event => setActivationCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="text"
              placeholder="首次使用该账号时填写"
            />
            {VERIFY_APPLICATIONS_OPEN ? (
              <a className="account-gate-verify-link" href="/verify" target="_blank" rel="noreferrer">
                没有激活码？申请内测资格 →
              </a>
            ) : (
              <span className="account-gate-verify-link" aria-disabled="true">
                {VERIFY_APPLICATIONS_CLOSED_MESSAGE}
              </span>
            )}
          </label>
          {error ? <div className="account-gate-error" role="alert">{error}</div> : null}
          <button type="submit" disabled={busy}>
            {busy ? <Loader2 size={18} className="account-gate-spinner" /> : <LogIn size={18} />}
            <span>{busy ? "处理中" : "登录 / 激活"}</span>
          </button>
        </form>
      </section>
    </main>
  );
}
