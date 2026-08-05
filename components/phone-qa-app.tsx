"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Check, ChevronLeft, Copy, Github, History, Loader2, Plus, Send, Square, Trash2, X } from "lucide-react";
import {
  applyQaCommit,
  cancelQaCommit,
  createQaSession,
  deleteQaSession,
  getQaChatSnapshot,
  hydrateQaChat,
  retryQaMessage,
  revertQaAppliedCommit,
  sendQaMessage,
  stopQaGeneration,
  subscribeQaChat,
  switchQaSession,
  type QaMsg,
  type QaSession,
} from "@/lib/qa-chat-store";
import { resolveQaApiConfig } from "@/lib/qa-agent-engine";
import {
  loadQaGithubConfig,
  saveQaGithubConfig,
  clearQaGithubConfig,
  validateQaGithubConfig,
  type QaGithubConfig,
  type QaGithubValidation,
} from "@/lib/qa-github";
import "@/lib/qa-error-log";

type PhoneQaAppProps = {
  onClose: () => void;
  onNotice?: (msg: string) => void;
};

const SUGGESTIONS = [
  "怎么添加我的 API？",
  "聊天没有回复怎么排查？",
  "怎么部署到 Netlify / Vercel？",
  "数据存在哪里，怎么备份？",
];

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// ── 代码块（语言标签 + 一键复制）─────────────────────

function QaCodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = /language-(\w+)/.exec(className || "")?.[1] ?? "";
  const code = String(children ?? "").replace(/\n$/, "");

  const handleCopy = useCallback(() => {
    navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [code]);

  return (
    <div className="qa-codeblock">
      <div className="qa-codeblock-head">
        <span className="qa-codeblock-lang">{language || "code"}</span>
        <button type="button" className="qa-codeblock-copy" onClick={handleCopy} aria-label="复制代码">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const QA_MARKDOWN_COMPONENTS = {
  pre({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  },
  code(props: { className?: string; children?: React.ReactNode }) {
    const { className, children } = props;
    const isBlock = /language-/.test(className || "") || String(children ?? "").includes("\n");
    if (isBlock) return <QaCodeBlock className={className}>{children}</QaCodeBlock>;
    return <code className="qa-inline-code">{children}</code>;
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// ── 提交提案卡片 ─────────────────────────────────────

function QaCommitCard({ msg }: { msg: QaMsg }) {
  const pending = msg.pendingCommit;
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  const { proposal, status, result, error } = pending;
  const files = proposal.files;

  const apply = async () => {
    setBusy(true);
    await applyQaCommit(msg.id);
    setBusy(false);
  };
  const revert = async () => {
    setBusy(true);
    await revertQaAppliedCommit(msg.id);
    setBusy(false);
  };

  return (
    <div className={`qa-commit-card status-${status}`}>
      <div className="qa-commit-head">
        <span className="qa-commit-title">
          {status === "applied" ? "已提交" : status === "reverted" ? "已撤销" : status === "canceled" ? "已取消" : "修改提案"}
        </span>
        <span className="qa-commit-branch">{proposal.branch || "默认分支"} · {files.length} 个文件</span>
      </div>
      <div className="qa-commit-msg">{proposal.message}</div>
      <ul className="qa-commit-files">
        {files.map((f) => (
          <li key={f.path}>{f.path}</li>
        ))}
      </ul>
      {error && <div className="qa-commit-error">{error}</div>}
      {status === "pending" && (
        <div className="qa-commit-actions">
          <button type="button" className="qa-commit-btn is-primary" onClick={apply} disabled={busy}>
            {busy ? <Loader2 size={13} className="qa-spin" /> : "应用"}
          </button>
          <button type="button" className="qa-commit-btn" onClick={() => cancelQaCommit(msg.id)} disabled={busy}>
            取消
          </button>
        </div>
      )}
      {(status === "applying" || status === "reverting") && (
        <div className="qa-commit-actions">
          <span className="qa-commit-progress">
            <Loader2 size={13} className="qa-spin" /> {status === "applying" ? "提交中…" : "撤销中…"}
          </span>
        </div>
      )}
      {status === "applied" && result && (
        <div className="qa-commit-actions">
          <a className="qa-commit-link" href={result.htmlUrl} target="_blank" rel="noreferrer noopener">
            查看 commit {result.sha.slice(0, 7)}
          </a>
          <button type="button" className="qa-commit-btn is-danger" onClick={revert} disabled={busy}>
            撤销
          </button>
        </div>
      )}
    </div>
  );
}

// ── 消息渲染 ─────────────────────────────────────────

function QaMessageItem({ msg, isStreaming, onRetry }: { msg: QaMsg; isStreaming: boolean; onRetry: (id: string) => void }) {
  if (msg.role === "user") {
    return (
      <div className="qa-msg-user-row">
        <div className="qa-msg-user">{msg.content}</div>
      </div>
    );
  }

  const thinkingOnly = isStreaming && !msg.content && (!msg.tools || msg.tools.length === 0);
  return (
    <div className="qa-msg-assistant">
      {msg.tools && msg.tools.length > 0 && (
        <div className="qa-tools">
          {msg.tools.map((tool, i) => (
            <span key={`${tool.name}-${i}`} className={`qa-tool-pill ${tool.running ? "is-running" : tool.success === false ? "is-fail" : "is-done"}`}>
              <span className="qa-tool-dot" />
              {tool.running ? `正在${tool.name}…` : tool.success === false ? `${tool.name}失败` : tool.name}
            </span>
          ))}
        </div>
      )}
      {thinkingOnly ? (
        <div className="qa-thinking">{msg.reasoning ? "正在思考…" : "正在生成…"}</div>
      ) : (
        <div className="qa-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={QA_MARKDOWN_COMPONENTS}>
            {msg.content}
          </ReactMarkdown>
          {isStreaming && <span className="qa-cursor" />}
        </div>
      )}
      {msg.pendingCommit && <QaCommitCard msg={msg} />}
      {msg.aborted && <div className="qa-msg-note">已停止生成</div>}
      {msg.error && (
        <div className="qa-msg-error">
          <div className="qa-msg-error-text">{msg.error}</div>
          <button type="button" className="qa-retry-btn" onClick={() => onRetry(msg.id)}>
            重试
          </button>
        </div>
      )}
    </div>
  );
}

// ── 会话抽屉 ─────────────────────────────────────────

function QaSessionDrawer({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onCreate,
  onClose,
}: {
  sessions: QaSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="qa-drawer-backdrop" onClick={onClose}>
      <aside className="qa-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="qa-drawer-head">
          <span className="qa-drawer-title">对话记录</span>
          <button type="button" className="qa-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <button type="button" className="qa-drawer-new" onClick={onCreate}>
          <Plus size={15} />
          <span>新对话</span>
        </button>
        <div className="qa-drawer-list hide-scrollbar">
          {sessions.length === 0 && <div className="qa-drawer-empty">还没有对话</div>}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`qa-drawer-item ${session.id === activeId ? "is-active" : ""}`}
              onClick={() => onSelect(session.id)}
            >
              <div className="qa-drawer-item-main">
                <span className="qa-drawer-item-title">{session.title}</span>
                <span className="qa-drawer-item-time">{formatRelativeTime(session.updatedAt)}</span>
              </div>
              <button
                type="button"
                className="qa-icon-btn qa-drawer-item-delete"
                aria-label="删除对话"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(session.id);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

// ── GitHub 仓库配置面板 ──────────────────────────────

function QaRepoSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const existing = useMemo(() => loadQaGithubConfig(), []);
  const [owner, setOwner] = useState(existing?.owner ?? "");
  const [repo, setRepo] = useState(existing?.repo ?? "");
  const [branch, setBranch] = useState(existing?.branch ?? "");
  const [token, setToken] = useState(existing?.token ?? "");
  const [writeMode, setWriteMode] = useState<"confirm" | "auto">(existing?.writeMode ?? "confirm");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<QaGithubValidation | null>(null);

  const buildConfig = useCallback((): QaGithubConfig => {
    const cfg: QaGithubConfig = { owner: owner.trim(), repo: repo.trim(), writeMode };
    if (branch.trim()) cfg.branch = branch.trim();
    if (token.trim()) cfg.token = token.trim();
    if (existing?.apiBase) cfg.apiBase = existing.apiBase;
    return cfg;
  }, [owner, repo, branch, token, writeMode, existing]);

  const handleVerify = useCallback(async () => {
    if (!owner.trim() || !repo.trim()) {
      setResult({ ok: false, error: "请填写 owner 和 repo。" });
      return;
    }
    setChecking(true);
    setResult(null);
    const validation = await validateQaGithubConfig(buildConfig());
    setResult(validation);
    setChecking(false);
  }, [owner, repo, buildConfig]);

  const handleSave = useCallback(() => {
    if (!owner.trim() || !repo.trim()) return;
    saveQaGithubConfig(buildConfig());
    onSaved();
    onClose();
  }, [owner, repo, buildConfig, onSaved, onClose]);

  const handleDisconnect = useCallback(() => {
    clearQaGithubConfig();
    onSaved();
    onClose();
  }, [onSaved, onClose]);

  return (
    <div className="qa-sheet-backdrop" onClick={onClose}>
      <div className="qa-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="qa-sheet-head">
          <span className="qa-sheet-title">
            <Github size={16} /> 连接 GitHub 仓库
          </span>
          <button type="button" className="qa-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="qa-sheet-body hide-scrollbar">
          <p className="qa-sheet-note">
            连接后可以让工坊查阅这个仓库的代码来回答问题。配置只保存在你的浏览器本地，不会上传。公开仓库可不填 PAT。
          </p>
          <label className="qa-field">
            <span className="qa-field-label">Owner（用户名 / 组织）</span>
            <input className="qa-input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="xiaolongbao0709" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="qa-field">
            <span className="qa-field-label">Repo（仓库名）</span>
            <input className="qa-input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="ai-virtual-phone" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="qa-field">
            <span className="qa-field-label">分支（可选，默认仓库默认分支）</span>
            <input className="qa-input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="qa-field">
            <span className="qa-field-label">Fine-grained PAT（私有仓库或搜索代码需要）</span>
            <input className="qa-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            <span className="qa-field-hint">
              GitHub → Settings → Developer settings → Fine-grained tokens。只查代码勾 Contents: Read；要让工坊改代码勾 Contents: Read and write。
            </span>
          </label>
          <div className="qa-field">
            <span className="qa-field-label">改代码时的模式</span>
            <div className="qa-segment">
              <button type="button" className={`qa-segment-btn ${writeMode === "confirm" ? "is-active" : ""}`} onClick={() => setWriteMode("confirm")}>
                确认后提交
              </button>
              <button type="button" className={`qa-segment-btn ${writeMode === "auto" ? "is-active" : ""}`} onClick={() => setWriteMode("auto")}>
                全自动
              </button>
            </div>
            <span className="qa-field-hint">
              {writeMode === "confirm"
                ? "工坊改代码前会先展示改动，你点「应用」才真正提交。推荐。"
                : "工坊说完直接提交推送，不再逐次确认。仍可事后一键撤销。仅在信任后开启。"}
            </span>
          </div>
          {result && (
            <div className={`qa-verify ${result.ok ? "is-ok" : "is-fail"}`}>
              {result.ok
                ? `✓ 已连接 ${result.fullName}（${result.private ? "私有" : "公开"}，默认分支 ${result.defaultBranch}）`
                : `✗ ${result.error}`}
            </div>
          )}
        </div>
        <div className="qa-sheet-actions">
          {existing && (
            <button type="button" className="qa-sheet-btn is-danger" onClick={handleDisconnect}>
              断开
            </button>
          )}
          <button type="button" className="qa-sheet-btn" onClick={handleVerify} disabled={checking}>
            {checking ? <Loader2 size={14} className="qa-spin" /> : "验证"}
          </button>
          <button type="button" className="qa-sheet-btn is-primary" onClick={handleSave} disabled={!owner.trim() || !repo.trim()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ── App 本体 ─────────────────────────────────────────

export function PhoneQaApp({ onClose }: PhoneQaAppProps) {
  const snapshot = useSyncExternalStore(subscribeQaChat, getQaChatSnapshot, getQaChatSnapshot);
  const [input, setInput] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [repoSheetOpen, setRepoSheetOpen] = useState(false);
  const [repoConnected, setRepoConnected] = useState(false);
  const [devNoticeOpen, setDevNoticeOpen] = useState(true);
  const [apiReady, setApiReady] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    void hydrateQaChat();
    setApiReady(resolveQaApiConfig() != null);
    setRepoConnected(loadQaGithubConfig() != null);
  }, []);

  const activeSession = useMemo(
    () => snapshot.sessions.find((s) => s.id === snapshot.activeSessionId) ?? null,
    [snapshot.sessions, snapshot.activeSessionId],
  );
  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);

  // 自动滚动：用户上滚阅读时不拉回底部
  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || snapshot.isGenerating) return;
    setInput("");
    stickToBottomRef.current = true;
    requestAnimationFrame(autoGrow);
    void sendQaMessage(text);
  }, [input, snapshot.isGenerating, autoGrow]);

  const handleRetry = useCallback((assistantMsgId: string) => {
    stickToBottomRef.current = true;
    void retryQaMessage(assistantMsgId);
  }, []);

  const streamingMsgId =
    snapshot.isGenerating && messages.length > 0 && messages[messages.length - 1].role === "assistant"
      ? messages[messages.length - 1].id
      : null;

  return (
    <div className="qa-app-shell">
      <div className="qa-ambient" aria-hidden />
      <header className="qa-header">
        <div className="qa-header-left">
          <button type="button" className="qa-icon-btn" onClick={onClose} aria-label="返回">
            <ChevronLeft size={22} strokeWidth={1.75} />
          </button>
        </div>
        <div className="qa-header-center">
          <span className="qa-header-title">工坊</span>
        </div>
        <div className="qa-header-right">
          <button
            type="button"
            className={`qa-icon-btn ${repoConnected ? "is-active" : ""}`}
            onClick={() => setRepoSheetOpen(true)}
            aria-label="连接仓库"
          >
            <Github size={17} strokeWidth={1.75} />
          </button>
          <button type="button" className="qa-icon-btn" onClick={() => setDrawerOpen(true)} aria-label="对话记录">
            <History size={17} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="qa-icon-btn"
            onClick={() => {
              createQaSession();
              setDrawerOpen(false);
            }}
            aria-label="新对话"
          >
            <Plus size={19} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <div className="qa-body hide-scrollbar" ref={bodyRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="qa-welcome">
            <div className="qa-welcome-badge" aria-hidden />
            <div className="qa-welcome-title">有什么问题？</div>
            <div className="qa-welcome-sub">
              使用问题、报错排查、部署配置，都可以问我。
              <br />
              想创作角色、世界书或美化桌面，找桌面上的小卷更合适。
            </div>
            {!apiReady && (
              <div className="qa-welcome-warn">还没有可用的 API：请先到「设置 → API 设置」添加 LLM API。</div>
            )}
            <div className="qa-suggestions">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="qa-suggestion"
                  onClick={() => {
                    stickToBottomRef.current = true;
                    void sendQaMessage(text);
                  }}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="qa-messages">
            {messages.map((msg) => (
              <QaMessageItem key={msg.id} msg={msg} isStreaming={msg.id === streamingMsgId} onRetry={handleRetry} />
            ))}
          </div>
        )}
      </div>

      <footer className="qa-composer-wrap">
        <div className={`qa-composer ${snapshot.isGenerating ? "is-generating" : ""}`}>
          <textarea
            ref={textareaRef}
            className="qa-composer-input hide-scrollbar"
            placeholder="输入你的问题…"
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          {snapshot.isGenerating ? (
            <button type="button" className="qa-send-btn is-stop" onClick={stopQaGeneration} aria-label="停止生成">
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="qa-send-btn"
              onClick={handleSend}
              disabled={!input.trim()}
              aria-label="发送"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </footer>

      {devNoticeOpen && (
        <div className="qa-devnotice-backdrop">
          <div className="qa-devnotice" role="alertdialog" aria-label="开发中提示">
            <div className="qa-devnotice-title">App 开发中</div>
            <div className="qa-devnotice-text">工坊还在开发中，请暂时不要使用。</div>
            <div className="qa-devnotice-actions">
              <button type="button" className="qa-devnotice-btn is-primary" onClick={onClose}>
                返回桌面
              </button>
              <button type="button" className="qa-devnotice-btn" onClick={() => setDevNoticeOpen(false)}>
                仍要看看
              </button>
            </div>
          </div>
        </div>
      )}

      {repoSheetOpen && (
        <QaRepoSheet onClose={() => setRepoSheetOpen(false)} onSaved={() => setRepoConnected(loadQaGithubConfig() != null)} />
      )}

      {drawerOpen && (
        <QaSessionDrawer
          sessions={snapshot.sessions}
          activeId={snapshot.activeSessionId}
          onSelect={(id) => {
            switchQaSession(id);
            setDrawerOpen(false);
          }}
          onDelete={deleteQaSession}
          onCreate={() => {
            createQaSession();
            setDrawerOpen(false);
          }}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}
