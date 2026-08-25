"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { AppWindow, ArrowUp, BrushCleaning, Check, ChevronLeft, ChevronRight, Copy, Drama, Gamepad2, Github, Loader2, Menu, MoreVertical, Pencil, Pin, PinOff, Play, Plus, Square, Trash2, Wrench, X } from "lucide-react";
import { QaFileCard } from "@/components/qa-file-card";
import { parseQaFileMarker } from "@/lib/qa-computer-tools";
import { mdiHammerWrench } from "@mdi/js";
import { CustomAppRunner } from "@/components/app-market/custom-app-runner";
import { CustomAppForegroundBoundary } from "@/components/app-market/custom-app-failure";
import { GameHubApp } from "@/components/game/game-hub-app";
import { BlackMarketApp } from "@/components/shopping/black-market-app";
import { getInstalledCustomApp } from "@/lib/custom-app-storage";
import type { QaCreatedContent } from "@/lib/qa-agent-tools";
import {
  applyQaCommit,
  cancelQaCommit,
  clearQaToolHistory,
  createQaSession,
  deleteQaSession,
  getQaActiveContextChars,
  getQaChatSnapshot,
  getQaContextBudgetChars,
  hasQaToolHistory,
  hydrateQaChat,
  QA_CONTEXT_BUDGET_MAX,
  QA_CONTEXT_BUDGET_MIN,
  QA_DEFAULT_CONTEXT_BUDGET_CHARS,
  setQaContextBudgetChars,
  retryQaMessage,
  renameQaSession,
  revertQaAppliedCommit,
  sendQaMessage,
  stopQaGeneration,
  subscribeQaChat,
  switchQaSession,
  toggleQaSessionPin,
  updateQaMessageContent,
  type QaMsg,
  type QaSession,
  type QaToolStatus,
} from "@/lib/qa-chat-store";
import {
  getQaPageChars,
  setQaPageChars,
  QA_DEFAULT_PAGE_CHARS,
  QA_PAGE_CHARS_MIN,
  QA_PAGE_CHARS_MAX,
  getQaMaxRounds,
  setQaMaxRounds,
  QA_DEFAULT_MAX_ROUNDS,
  QA_MAX_ROUNDS_MIN,
  QA_MAX_ROUNDS_MAX,
  getQaMaxOutputTokens,
  setQaMaxOutputTokens,
  QA_DEFAULT_MAX_OUTPUT_TOKENS,
  QA_MAX_OUTPUT_TOKENS_MIN,
  QA_MAX_OUTPUT_TOKENS_MAX,
} from "@/lib/qa-prefs";
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
  "帮我写个小游戏装到本机",
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
        <span className="qa-commit-branch">{proposal.branch || "默认分支"} · {files.length + (proposal.deletes?.length ?? 0)} 个文件</span>
      </div>
      <div className="qa-commit-msg">{proposal.message}</div>
      <ul className="qa-commit-files">
        {files.map((f) => (
          <li key={f.path}>{f.path}</li>
        ))}
        {(proposal.deletes ?? []).map((path) => (
          <li key={`del-${path}`} className="qa-commit-file-delete">− {path}（删除）</li>
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

// 工具调用行：折叠的单行摘要，点开展开参数与结果（Claude Code 风格）
function QaToolRow({ tool }: { tool: QaToolStatus }) {
  const [open, setOpen] = useState(false);
  // 「电脑文件 op=send」的结果里带文件卡标记：卡片常显，标记从结果文本中剥离
  const { text: resultText, file } = parseQaFileMarker(tool.result || "");
  const hasDetail = Boolean(tool.detail || resultText);
  const summary = tool.running ? `正在${tool.name}…` : tool.success === false ? `${tool.name}失败` : tool.name;
  return (
    <div className={`qa-tool-row ${tool.running ? "is-running" : tool.success === false ? "is-fail" : "is-done"}`}>
      <button
        type="button"
        className="qa-tool-row-head"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
      >
        {tool.running ? <Loader2 size={13} className="qa-spin" /> : <Wrench size={13} />}
        <span className="qa-tool-row-summary">
          {summary}
          {tool.subtitle && <span className="qa-tool-row-sub">{tool.subtitle}</span>}
        </span>
        {hasDetail && <ChevronRight size={14} className={`qa-tool-row-chevron ${open ? "is-open" : ""}`} />}
      </button>
      {open && hasDetail && (
        <div className="qa-tool-row-body">
          {tool.detail && (
            <>
              <div className="qa-tool-row-label">参数</div>
              <pre className="qa-tool-row-pre">{tool.detail}</pre>
            </>
          )}
          {resultText && (
            <>
              <div className="qa-tool-row-label">结果</div>
              <pre className="qa-tool-row-pre">{resultText}</pre>
            </>
          )}
        </div>
      )}
      {file && <QaFileCard file={file} />}
    </div>
  );
}

// 已完成文本的 Markdown 渲染：memo 缓存——流式期间每次增量都全文重排 remark 是
// 低端机 WebView OOM 崩溃的主因（几万字 × 每秒多次解析）。文本不变就不重渲。
const QaMarkdownBlock = memo(function QaMarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={QA_MARKDOWN_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

// 正在生长的活跃段：纯文本渲染（零解析成本），生成结束后换回完整 Markdown
function QaStreamingText({ text }: { text: string }) {
  return (
    <>
      <div className="qa-stream-text">{text}</div>
      <span className="qa-cursor" />
    </>
  );
}

const QaMessageItem = memo(function QaMessageItem({
  msg,
  isStreaming,
  onRetry,
  onViewImage,
  onCopy,
  onEdit,
}: {
  msg: QaMsg;
  isStreaming: boolean;
  onRetry: (id: string) => void;
  onViewImage: (url: string) => void;
  onCopy: (content: string) => void;
  onEdit: (msg: QaMsg) => void;
}) {
  const thinkingOnly = isStreaming && !msg.content && (!msg.tools || msg.tools.length === 0);
  // 消息操作（复制原始内容 / 编辑原始内容——前端渲染会吞掉一些特殊标签，
  // 沟通时看不到原文）常驻在气泡下方，不用长按触发：长按要跟系统的选词、
  // 取词、划词搜索抢同一个手势，在移动端几乎必然打架。
  // 生成中不显示（内容还不完整，复制/编辑都没有意义）。
  const showActions = !isStreaming && !thinkingOnly;
  const msgWrap = (node: ReactNode) => (
    <div className="qa-msg-wrap">
      {node}
      {showActions && (
        <div className="qa-msg-actions" data-role={msg.role}>
          <button type="button" className="qa-msg-action" aria-label="复制原始内容" title="复制" onClick={() => onCopy(msg.content)}>
            <Copy size={14} strokeWidth={2} />
          </button>
          <button type="button" className="qa-msg-action" aria-label="编辑原始内容" title="编辑" onClick={() => onEdit(msg)}>
            <Pencil size={14} strokeWidth={2} />
          </button>
        </div>
      )}
    </div>
  );
  // 时序分段渲染：文字与工具行按实际发生顺序交错（连续工具行合并成一组）；
  // 旧消息没有 segments 时回退「工具在顶、文字在下」布局。
  // hooks 必须在 user 分支 early-return 之前调用（rules-of-hooks）
  const segmentBlocks = useMemo(() => {
    if (!msg.segments?.length) return null;
    const blocks: Array<{ kind: "text"; text: string } | { kind: "tools"; tools: QaToolStatus[] }> = [];
    for (const seg of msg.segments) {
      const last = blocks[blocks.length - 1];
      if (seg.kind === "tool") {
        if (last?.kind === "tools") last.tools.push(seg.tool);
        else blocks.push({ kind: "tools", tools: [seg.tool] });
      } else if (seg.text.trim()) {
        if (last?.kind === "text") last.text += seg.text;
        else blocks.push({ kind: "text", text: seg.text });
      }
    }
    return blocks.length ? blocks : null;
  }, [msg.segments]);

  if (msg.role === "user") {
    return msgWrap(
      <div className="qa-msg-user-row">
        <div className="qa-msg-user">
          {msg.images && msg.images.length > 0 && (
            <div className="qa-msg-images">
              {msg.images.map((url, i) => (
                <button key={i} type="button" className="qa-msg-image" onClick={() => onViewImage(url)} aria-label="查看图片">
                  <img src={url} alt="" />
                </button>
              ))}
            </div>
          )}
          {msg.content}
        </div>
      </div>,
    );
  }

  return msgWrap(
    <div className="qa-msg-assistant">
      {segmentBlocks ? (
        segmentBlocks.map((block, i) =>
          block.kind === "tools" ? (
            <div className="qa-tools" key={i}>
              {block.tools.map((tool, j) => (
                <QaToolRow key={`${tool.name}-${j}`} tool={tool} />
              ))}
            </div>
          ) : isStreaming && i === segmentBlocks.length - 1 ? (
            <div className="qa-markdown" key={i}>
              <QaStreamingText text={block.text} />
            </div>
          ) : (
            <div className="qa-markdown" key={i}>
              <QaMarkdownBlock text={block.text} />
            </div>
          ),
        )
      ) : (
        <>
          {msg.tools && msg.tools.length > 0 && (
            <div className="qa-tools">
              {msg.tools.map((tool, i) => (
                <QaToolRow key={`${tool.name}-${i}`} tool={tool} />
              ))}
            </div>
          )}
          {thinkingOnly ? (
            <div className="qa-thinking">{msg.toolDrafting ? "正在编写工具调用…" : msg.reasoning ? "正在思考…" : "正在生成…"}</div>
          ) : isStreaming ? (
            <div className="qa-markdown">
              <QaStreamingText text={msg.content} />
            </div>
          ) : (
            <div className="qa-markdown">
              <QaMarkdownBlock text={msg.content} />
            </div>
          )}
        </>
      )}
      {isStreaming && msg.toolDrafting && !thinkingOnly && (
        <div className="qa-thinking qa-tool-drafting">正在编写工具调用…</div>
      )}
      {msg.streamNote && <div className="qa-msg-note">{msg.streamNote}</div>}
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
    </div>,
  );
});

// ── 会话抽屉 ─────────────────────────────────────────

function QaSessionDrawer({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onCreate,
  onOpenSettings,
  onRenameRequest,
}: {
  sessions: QaSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
  onRenameRequest: (id: string, title: string) => void;
}) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  // 置顶的排最前，其余保持时间序。只在渲染层排，存储顺序不动
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (Boolean(a.isPinned) !== Boolean(b.isPinned)) return a.isPinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [sessions]);

  return (
    <aside className="qa-drawer">
      <div className="qa-drawer-head">
        <span className="qa-drawer-title">对话记录</span>
      </div>
      <div
        className="qa-drawer-list hide-scrollbar"
        onClick={() => { if (menuOpenId) setMenuOpenId(null); }}
      >
        {sortedSessions.length === 0 && <div className="qa-drawer-empty">还没有对话</div>}
        {sortedSessions.map((session) => (
          <div
            key={session.id}
            className={`qa-drawer-item ${session.id === activeId ? "is-active" : ""}`}
            onClick={() => onSelect(session.id)}
          >
            <div className="qa-drawer-item-main">
              <span className="qa-drawer-item-title">
                {session.isPinned && <Pin size={12} className="qa-drawer-pin-mark" aria-label="已置顶" />}
                {session.title}
              </span>
              <span className="qa-drawer-item-time">{formatRelativeTime(session.updatedAt)}</span>
            </div>
            <button
              type="button"
              className="qa-icon-btn qa-drawer-item-more"
              aria-label="更多操作"
              aria-expanded={menuOpenId === session.id}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpenId(menuOpenId === session.id ? null : session.id);
              }}
            >
              <MoreVertical size={14} />
            </button>

            {menuOpenId === session.id && (
              <div className="qa-drawer-item-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="qa-drawer-menu-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleQaSessionPin(session.id);
                    setMenuOpenId(null);
                  }}
                >
                  {session.isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                  {session.isPinned ? "取消置顶" : "置顶"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="qa-drawer-menu-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRenameRequest(session.id, session.title);
                    setMenuOpenId(null);
                  }}
                >
                  <Pencil size={14} /> 重命名
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="qa-drawer-menu-btn is-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                    setMenuOpenId(null);
                  }}
                >
                  <Trash2 size={14} /> 删除
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="qa-drawer-foot">
        <button type="button" className="qa-drawer-new qa-drawer-settings" onClick={onOpenSettings}>
          <Wrench size={15} strokeWidth={2} />
          <span>工坊配置</span>
        </button>
        <button type="button" className="qa-drawer-new" onClick={onCreate}>
          <Plus size={16} strokeWidth={2} />
          <span>新对话</span>
        </button>
      </div>
    </aside>
  );
}

// ── 工坊配置面板 ─────────────────────────────────────

function QaSettingsSheet({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
  const [budget, setBudget] = useState(() => String(getQaContextBudgetChars()));
  const [pageChars, setPageChars] = useState(() => String(getQaPageChars()));
  const [maxRounds, setMaxRounds] = useState(() => String(getQaMaxRounds()));
  const [maxOutTokens, setMaxOutTokens] = useState(() => {
    const v = getQaMaxOutputTokens();
    return v == null ? "" : String(v);
  });
  const usedChars = getQaActiveContextChars();
  const pct = Math.round((usedChars / getQaContextBudgetChars()) * 100);

  const save = () => {
    const parsed = Number(budget);
    if (!Number.isFinite(parsed) || parsed < QA_CONTEXT_BUDGET_MIN || parsed > QA_CONTEXT_BUDGET_MAX) {
      onNotice?.(`预算需为 ${QA_CONTEXT_BUDGET_MIN.toLocaleString()} - ${QA_CONTEXT_BUDGET_MAX.toLocaleString()} 之间的数字。`);
      return;
    }
    const parsedPage = Number(pageChars);
    if (!Number.isFinite(parsedPage) || parsedPage < QA_PAGE_CHARS_MIN || parsedPage > QA_PAGE_CHARS_MAX) {
      onNotice?.(`单页字符数需为 ${QA_PAGE_CHARS_MIN.toLocaleString()} - ${QA_PAGE_CHARS_MAX.toLocaleString()} 之间的数字。`);
      return;
    }
    const parsedRounds = Number(maxRounds);
    if (!Number.isFinite(parsedRounds) || parsedRounds < QA_MAX_ROUNDS_MIN || parsedRounds > QA_MAX_ROUNDS_MAX) {
      onNotice?.(`工具调用上限需为 ${QA_MAX_ROUNDS_MIN} - ${QA_MAX_ROUNDS_MAX} 之间的数字。`);
      return;
    }
    const trimmedTokens = maxOutTokens.trim();
    const parsedTokens = trimmedTokens ? Number(trimmedTokens) : null;
    if (parsedTokens != null && (!Number.isFinite(parsedTokens) || parsedTokens < QA_MAX_OUTPUT_TOKENS_MIN || parsedTokens > QA_MAX_OUTPUT_TOKENS_MAX)) {
      onNotice?.(`单次最大输出 token 需留空或为 ${QA_MAX_OUTPUT_TOKENS_MIN.toLocaleString()} - ${QA_MAX_OUTPUT_TOKENS_MAX.toLocaleString()} 之间的数字。`);
      return;
    }
    setQaContextBudgetChars(parsed);
    setQaPageChars(parsedPage);
    setQaMaxRounds(parsedRounds);
    // 留空 = 显式不传 max_tokens（0 哨兵），与"没设置用默认值"区分开
    setQaMaxOutputTokens(trimmedTokens ? parsedTokens : 0);
    onNotice?.("已保存工坊配置。");
    onClose();
  };

  const reset = () => {
    setQaContextBudgetChars(null);
    setQaPageChars(null);
    setQaMaxRounds(null);
    setQaMaxOutputTokens(null);
    setBudget(String(QA_DEFAULT_CONTEXT_BUDGET_CHARS));
    setPageChars(String(QA_DEFAULT_PAGE_CHARS));
    setMaxRounds(String(QA_DEFAULT_MAX_ROUNDS));
    setMaxOutTokens(String(QA_DEFAULT_MAX_OUTPUT_TOKENS));
    onNotice?.("已恢复默认配置。");
  };

  return (
    <div className="qa-devnotice-backdrop" onClick={onClose}>
      <div className="qa-devnotice" role="dialog" aria-label="工坊配置" onClick={(e) => e.stopPropagation()}>
        <div className="qa-devnotice-title">工坊配置</div>
        <label className="qa-settings-field">
          <span>上下文预算（字符）</span>
          <input
            type="number"
            inputMode="numeric"
            min={QA_CONTEXT_BUDGET_MIN}
            max={QA_CONTEXT_BUDGET_MAX}
            step={1000}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <div className="qa-settings-hint">
          上下文满 100% 时自动压缩成摘要并重新累计。中文约 1 字符 ≈ 1 token；默认 {QA_DEFAULT_CONTEXT_BUDGET_CHARS.toLocaleString()}，小上下文（32k）模型建议 30000–50000。
        </div>
        <div className="qa-settings-hint">当前会话已用 {usedChars.toLocaleString()} 字符（约 {pct}%）。</div>
        <label className="qa-settings-field">
          <span>单页读取字符数</span>
          <input
            type="number"
            inputMode="numeric"
            min={QA_PAGE_CHARS_MIN}
            max={QA_PAGE_CHARS_MAX}
            step={1000}
            value={pageChars}
            onChange={(e) => setPageChars(e.target.value)}
          />
        </label>
        <div className="qa-settings-hint">
          小坊翻页读答疑文档 / 本机内容 / 仓库源码时，每页返回的字符数。默认 {QA_DEFAULT_PAGE_CHARS.toLocaleString()}；调大读得快但更占上下文，小上下文模型建议调小。
        </div>
        <label className="qa-settings-field">
          <span>单轮工具调用上限（次）</span>
          <input
            type="number"
            inputMode="numeric"
            min={QA_MAX_ROUNDS_MIN}
            max={QA_MAX_ROUNDS_MAX}
            step={1}
            value={maxRounds}
            onChange={(e) => setMaxRounds(e.target.value)}
          />
        </label>
        <div className="qa-settings-hint">
          一次提问里小坊最多连续执行多少轮工具，用完会提示「回复继续」。默认 {QA_DEFAULT_MAX_ROUNDS}；复杂任务（写游戏、改代码）可调大，想控制 token 消耗可调小。
        </div>
        <label className="qa-settings-field">
          <span>单次最大输出 token</span>
          <input
            type="number"
            inputMode="numeric"
            min={QA_MAX_OUTPUT_TOKENS_MIN}
            max={QA_MAX_OUTPUT_TOKENS_MAX}
            step={1000}
            placeholder="留空 = 不传"
            value={maxOutTokens}
            onChange={(e) => setMaxOutTokens(e.target.value)}
          />
        </label>
        <div className="qa-settings-hint">
          输出长度护栏：每次请求带 max_tokens，小坊会按该预算分段写大文件，写超被安全截断后自动续接，不再整轮报废。默认 {QA_DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()}；留空 = 不传该参数（部分模型/中转不支持 max_tokens 时请留空）。
        </div>
        <div className="qa-devnotice-actions is-row">
          <button type="button" className="qa-devnotice-btn" onClick={reset}>恢复默认</button>
          <button type="button" className="qa-devnotice-btn is-primary" onClick={save}>保存</button>
        </div>
      </div>
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
            <input className="qa-input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="例：octocat" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="qa-field">
            <span className="qa-field-label">Repo（仓库名）</span>
            <input className="qa-input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="例：hello-world" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="qa-field">
            <span className="qa-field-label">分支（可选，默认仓库默认分支）</span>
            <input className="qa-input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="qa-field">
            <span className="qa-field-label">Fine-grained PAT（私有仓库或搜索代码需要）</span>
            <input className="qa-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            <span className="qa-field-hint">
              GitHub → Settings → Menu 按钮 → Developer settings → Personal access tokens → Fine-grained tokens。创建时 Repository access 记得勾选目标仓库；Permissions 里：Contents——只查代码选 Read-only，要让工坊改代码选 Read and write；要用「创建PR」再加 Pull requests 的 Read and write（Metadata 会自动带上，其余权限都不用勾）。
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

export function PhoneQaApp({ onClose, onNotice }: PhoneQaAppProps) {
  const snapshot = useSyncExternalStore(subscribeQaChat, getQaChatSnapshot, getQaChatSnapshot);
  const [input, setInput] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [repoSheetOpen, setRepoSheetOpen] = useState(false);
  const [repoConnected, setRepoConnected] = useState(false);
  const [clearToolsOpen, setClearToolsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 会话重命名弹窗：抽屉菜单里点「重命名」打开 */
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [editingMsg, setEditingMsg] = useState<QaMsg | null>(null);
  const [editText, setEditText] = useState("");
  const [visionEnabled, setVisionEnabled] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [apiReady, setApiReady] = useState(true);
  const [modelName, setModelName] = useState("");
  const [repoWritable, setRepoWritable] = useState(false);
  const [writeMode, setWriteMode] = useState<"confirm" | "auto">("confirm");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottomRef = useRef(true);

  const refreshComposerMeta = useCallback(() => {
    setApiReady(resolveQaApiConfig() != null);
    setModelName(resolveQaApiConfig()?.defaultModel ?? "");
    setVisionEnabled(resolveQaApiConfig()?.enableImageRecognition === true);
    const gh = loadQaGithubConfig();
    setRepoConnected(gh != null);
    setRepoWritable(Boolean(gh?.token));
    setWriteMode(gh?.writeMode ?? "confirm");
  }, []);

  useEffect(() => {
    void hydrateQaChat();
    refreshComposerMeta();
  }, [refreshComposerMeta]);

  // 清理原生 tool 调用历史（防报错）：与小卷同款——移除上下文里的工具记录与原生元数据
  const handleClearToolHistory = useCallback(() => {
    if (snapshot.isGenerating) {
      onNotice?.("小坊正在执行，完成后再清理。");
      return;
    }
    if (!hasQaToolHistory()) {
      onNotice?.("没有可清理的工具调用历史。");
      return;
    }
    setClearToolsOpen(true);
  }, [snapshot.isGenerating, onNotice]);

  const confirmClearToolHistory = useCallback(() => {
    setClearToolsOpen(false);
    const result = clearQaToolHistory();
    onNotice?.(result && result.removed + result.cleaned > 0
      ? `已清理 ${result.removed} 条工具记录，整理 ${result.cleaned} 条消息。`
      : "没有可清理的工具调用历史。");
  }, [onNotice]);

  const toggleWriteMode = useCallback(() => {
    const gh = loadQaGithubConfig();
    if (!gh) return;
    const next = gh.writeMode === "auto" ? "confirm" : "auto";
    saveQaGithubConfig({ ...gh, writeMode: next });
    setWriteMode(next);
  }, []);

  const activeSession = useMemo(
    () => snapshot.sessions.find((s) => s.id === snapshot.activeSessionId) ?? null,
    [snapshot.sessions, snapshot.activeSessionId],
  );
  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);
  const createdContent = useMemo(() => activeSession?.createdContent ?? [], [activeSession]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewItem, setPreviewItem] = useState<QaCreatedContent | null>(null);
  const previewApp = useMemo(
    () => (previewItem?.type === "app" ? getInstalledCustomApp(previewItem.refId) : null),
    [previewItem],
  );

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
    if ((!text && pendingImages.length === 0) || snapshot.isGenerating) return;
    setInput("");
    const images = pendingImages;
    setPendingImages([]);
    stickToBottomRef.current = true;
    requestAnimationFrame(autoGrow);
    void sendQaMessage(text, images.length ? images : undefined);
  }, [input, pendingImages, snapshot.isGenerating, autoGrow]);

  // 附加图片：仅识图已开启的 API 显示入口；读为 dataURL，单张限 4MB
  const handlePickImages = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files).slice(0, 6)) {
      if (file.size > 4 * 1024 * 1024) {
        onNotice?.(`「${file.name}」超过 4MB，已跳过。`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        if (url) setPendingImages((current) => (current.length >= 6 ? current : [...current, url]));
      };
      reader.readAsDataURL(file);
    }
    if (imageInputRef.current) imageInputRef.current.value = "";
  }, [onNotice]);

  const handleRetry = useCallback((assistantMsgId: string) => {
    stickToBottomRef.current = true;
    void retryQaMessage(assistantMsgId);
  }, []);

  const handleCopyMessage = useCallback((content: string) => {
    void navigator.clipboard?.writeText(content).then(
      () => onNotice?.("已复制原始内容"),
      () => onNotice?.("复制失败"),
    );
  }, [onNotice]);

  const handleEditMessage = useCallback((msg: QaMsg) => {
    setEditingMsg(msg);
    setEditText(msg.content);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingMsg || !snapshot.activeSessionId) return;
    updateQaMessageContent(snapshot.activeSessionId, editingMsg.id, editText);
    setEditingMsg(null);
    onNotice?.("已保存消息内容");
  }, [editingMsg, editText, snapshot.activeSessionId, onNotice]);

  const streamingMsgId =
    snapshot.isGenerating && messages.length > 0 && messages[messages.length - 1].role === "assistant"
      ? messages[messages.length - 1].id
      : null;

  return (
    <div className="qa-app-shell">
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
        onOpenSettings={() => {
          setSettingsOpen(true);
          setDrawerOpen(false);
        }}
        onRenameRequest={(id, title) => {
          setRenameTarget({ id, title });
          setRenameTitle(title);
        }}
      />
      <div className={`qa-stage ${drawerOpen ? "is-pushed" : ""}`}>
      <div className="qa-ambient" aria-hidden />
      <header className="qa-header">
        <div className="qa-header-left">
          <button type="button" className="qa-icon-btn" onClick={onClose} aria-label="返回">
            <ChevronLeft size={22} strokeWidth={1.75} />
          </button>
        </div>
        <div className="qa-header-center">
          <span className="qa-header-title">工坊</span>
          {repoConnected && <span className="qa-header-sub">已连接仓库</span>}
        </div>
        <div className="qa-header-right">
          <button
            type="button"
            className="qa-icon-btn"
            onClick={handleClearToolHistory}
            aria-label="清理原生tool调用历史（防报错）"
            title="清理原生tool调用历史——防报错"
          >
            <BrushCleaning size={17} strokeWidth={1.75} />
          </button>
          <button type="button" className="qa-icon-btn" onClick={() => setDrawerOpen((v) => !v)} aria-label="对话记录">
            <Menu size={18} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <div className="qa-body hide-scrollbar" ref={bodyRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="qa-welcome">
            <div className="qa-welcome-badge" aria-hidden>
              <svg viewBox="0 0 24 24" width="26" height="26">
                <path d={mdiHammerWrench} fill="currentColor" />
              </svg>
            </div>
            <div className="qa-welcome-title">有什么问题？</div>
            <div className="qa-welcome-sub">
              我是小坊，工坊的驻场工程师。使用问题、报错排查、部署配置，都可以问我。
              <br />
              我还能动手：写小游戏 / APP / 剧场直接装进本机试玩；连接仓库后我会查源码答疑，填了有写权限的 PAT 还能帮你改代码。
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
              <QaMessageItem key={msg.id} msg={msg} isStreaming={msg.id === streamingMsgId} onRetry={handleRetry} onViewImage={setViewerImage} onCopy={handleCopyMessage} onEdit={handleEditMessage} />
            ))}
          </div>
        )}
      </div>

      <footer className="qa-composer-wrap">
        <div className={`qa-composer ${snapshot.isGenerating ? "is-generating" : ""}`}>
          {pendingImages.length > 0 && (
            <div className="qa-attach-strip">
              {pendingImages.map((url, i) => (
                <div key={i} className="qa-attach-thumb">
                  <button type="button" className="qa-attach-view" onClick={() => setViewerImage(url)} aria-label="查看图片">
                    <img src={url} alt="" />
                  </button>
                  <button
                    type="button"
                    className="qa-attach-remove"
                    onClick={() => setPendingImages((current) => current.filter((_, idx) => idx !== i))}
                    aria-label="移除图片"
                  >
                    <X size={11} strokeWidth={2.4} />
                  </button>
                </div>
              ))}
            </div>
          )}
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
          />
          <div className="qa-composer-toolbar">
            {visionEnabled && (
              <>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => handlePickImages(e.target.files)}
                />
                <button
                  type="button"
                  className="qa-circle-btn qa-attach-btn"
                  onClick={() => imageInputRef.current?.click()}
                  aria-label="发送图片"
                >
                  <Plus size={17} strokeWidth={2.2} />
                </button>
              </>
            )}
            {modelName && <span className="qa-model-pill">{modelName}</span>}

            {repoWritable && (
              <button type="button" className="qa-mode-pill" onClick={toggleWriteMode}>
                {writeMode === "auto" ? "全自动" : "确认后提交"}
              </button>
            )}

            <div className="qa-composer-spacer" />

            {createdContent.length > 0 && (
              <button
                type="button"
                className="qa-circle-btn qa-preview-btn"
                onClick={() => setPreviewOpen(true)}
                aria-label="预览本轮创建的内容"
              >
                <Play size={16} />
              </button>
            )}

            <button
              type="button"
              className={`qa-circle-btn qa-github-btn ${repoConnected ? "is-active" : ""}`}
              onClick={() => setRepoSheetOpen(true)}
              aria-label="连接仓库"
            >
              <Github size={16} strokeWidth={1.75} />
            </button>

            {snapshot.isGenerating ? (
              <button type="button" className="qa-circle-btn qa-send-btn is-stop" onClick={stopQaGeneration} aria-label="停止生成">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="qa-circle-btn qa-send-btn"
                onClick={handleSend}
                disabled={!input.trim()}
                aria-label="发送"
              >
                <ArrowUp size={20} strokeWidth={2.4} />
              </button>
            )}
          </div>
          <div
            className={`qa-context-meter ${snapshot.isCompacting ? "is-compacting" : ""}`}
            title="上下文用量：满 100% 时自动压缩成摘要并从头累计"
          >
            <div className="qa-context-meter-track" aria-hidden>
              <i style={{ width: `${Math.min(100, Math.round(snapshot.contextUsage * 100))}%` }} />
            </div>
            <span className="qa-context-meter-label">
              {snapshot.isCompacting ? "压缩中" : `${Math.min(999, Math.round(snapshot.contextUsage * 100))}%`}
            </span>
          </div>
        </div>
      </footer>

      {drawerOpen && (
        <button
          type="button"
          className="qa-stage-scrim"
          aria-label="关闭对话列表"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      </div>

      {renameTarget && (
        <div className="qa-rename-backdrop" role="presentation" onClick={() => setRenameTarget(null)}>
          <form
            className="qa-rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="qa-rename-dialog-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const title = renameTitle.trim();
              if (!title) return;
              renameQaSession(renameTarget.id, title);
              setRenameTarget(null);
            }}
          >
            <div id="qa-rename-dialog-title" className="qa-rename-title">重命名对话</div>
            <input
              className="qa-rename-input"
              autoFocus
              value={renameTitle}
              maxLength={80}
              aria-label="新对话名称"
              onChange={(e) => setRenameTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setRenameTarget(null); }}
            />
            <div className="qa-rename-actions">
              <button type="button" className="qa-rename-cancel" onClick={() => setRenameTarget(null)}>取消</button>
              <button type="submit" className="qa-drawer-new qa-rename-confirm" disabled={!renameTitle.trim()}>确认</button>
            </div>
          </form>
        </div>
      )}

      {clearToolsOpen && (
        <div className="qa-devnotice-backdrop" onClick={() => setClearToolsOpen(false)}>
          <div className="qa-devnotice" role="alertdialog" aria-label="清理工具历史确认" onClick={(e) => e.stopPropagation()}>
            <div className="qa-devnotice-title">清理工具调用历史？</div>
            <div className="qa-devnotice-text">
              将移除本会话上下文中的工具调用与工具结果记录，用于修复原生工具协议的报错。普通对话内容不会删除，之前的工具结论仍保留在小坊的回复文字里。
            </div>
            <div className="qa-devnotice-actions is-row">
              <button type="button" className="qa-devnotice-btn" onClick={() => setClearToolsOpen(false)}>
                取消
              </button>
              <button type="button" className="qa-devnotice-btn is-primary" onClick={confirmClearToolHistory}>
                清理
              </button>
            </div>
          </div>
        </div>
      )}

      {viewerImage && (
        <div className="qa-image-viewer" role="presentation" onClick={() => setViewerImage(null)}>
          <img src={viewerImage} alt="" />
          <button type="button" className="qa-image-viewer-close" aria-label="关闭" onClick={() => setViewerImage(null)}>
            <X size={20} />
          </button>
        </div>
      )}

      {editingMsg && (
        <div className="qa-edit-backdrop" onClick={() => setEditingMsg(null)}>
          <div className="qa-edit-dialog" role="dialog" aria-label="编辑消息" onClick={(e) => e.stopPropagation()}>
            <div className="qa-edit-head">
              <span className="qa-edit-title">编辑消息（未渲染原始内容）</span>
              <button type="button" className="qa-icon-btn" onClick={() => setEditingMsg(null)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <textarea
              className="qa-edit-textarea"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              spellCheck={false}
              autoFocus
              placeholder="这里显示的是消息的原始内容，不会被前端渲染，可放心查看特殊标签。"
            />
            <div className="qa-edit-actions">
              <button type="button" className="qa-devnotice-btn" onClick={() => setEditingMsg(null)}>
                取消
              </button>
              <button type="button" className="qa-devnotice-btn is-primary" onClick={handleSaveEdit}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <QaSettingsSheet onClose={() => setSettingsOpen(false)} onNotice={onNotice} />
      )}

      {repoSheetOpen && (
        <QaRepoSheet onClose={() => setRepoSheetOpen(false)} onSaved={refreshComposerMeta} />
      )}

      {previewOpen && !previewItem && (
        <div className="qa-sheet-backdrop" onClick={() => setPreviewOpen(false)}>
          <div className="qa-sheet qa-preview-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="qa-sheet-head">
              <span className="qa-sheet-title">
                <Play size={16} /> 预览本轮创建
              </span>
              <button type="button" className="qa-icon-btn" onClick={() => setPreviewOpen(false)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="qa-sheet-body">
              <p className="qa-sheet-note">本次对话里创建/更新的内容，点开直接测试，返回后回到聊天。</p>
              {createdContent.map((item) => (
                <button
                  key={`${item.type}-${item.refId}`}
                  type="button"
                  className="qa-preview-item"
                  onClick={() => setPreviewItem(item)}
                >
                  {item.type === "app" ? <AppWindow size={17} /> : item.type === "game" ? <Gamepad2 size={17} /> : <Drama size={17} />}
                  <span className="qa-preview-item-title">{item.title}</span>
                  <span className="qa-preview-item-type">
                    {item.type === "app" ? "应用" : item.type === "game" ? "游戏" : "剧场"}
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {previewItem && (
        <div className="qa-preview-runtime">
          {previewItem.type === "app" ? (
            previewApp ? (
              <CustomAppForegroundBoundary
                key={previewApp.id}
                appName={previewApp.name}
                appId={previewApp.id}
                appVersion={previewApp.version}
                manifestId={previewApp.manifest?.id}
                closeLabel="返回"
                onClose={() => setPreviewItem(null)}
              >
                <CustomAppRunner app={previewApp} onClose={() => setPreviewItem(null)} />
              </CustomAppForegroundBoundary>
            ) : (
              <div className="qa-preview-missing">
                <p>这个应用已被卸载或找不到了。</p>
                <button type="button" className="qa-sheet-btn is-primary" onClick={() => setPreviewItem(null)}>
                  返回
                </button>
              </div>
            )
          ) : previewItem.type === "game" ? (
            <GameHubApp onClose={() => setPreviewItem(null)} autoOpenLocalId={previewItem.refId} />
          ) : (
            <BlackMarketApp onClose={() => setPreviewItem(null)} autoOpenLocalId={previewItem.refId} />
          )}
        </div>
      )}
    </div>
  );
}
