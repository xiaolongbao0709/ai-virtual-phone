"use client";

import { Component, useCallback, useState, type ErrorInfo, type ReactNode } from "react";
import { Check, Copy, TriangleAlert, X } from "lucide-react";

// ── 前台应用失败面板 ────────────────────────────────
// 自定义 APP 跑在沙盒 iframe 里，它内部的报错既不会冒泡到 React，也不会显示在
// 界面上——出事时用户只看到一片白，反馈过来也无从查起。这里把两类失败收口到
// 同一个面板：① 宿主侧 runner 组件崩溃（错误边界捕获）；② 应用侧首屏什么都没
// 画出来（bridge 上报 app.blank，附带它捕获到的报错）。面板给出错误摘要、退出
// 入口，以及一份可直接粘贴给作者的诊断信息。

export type CustomAppFailureSource = "host" | "app";

export type CustomAppFailureDetail = {
  source: CustomAppFailureSource;
  appName: string;
  appId: string;
  appVersion: string;
  manifestId?: string;
  errors: string[];
  componentStack?: string;
};

const MAX_SHOWN_ERRORS = 3;

function failureHeadline(source: CustomAppFailureSource): string {
  return source === "host" ? "应用界面崩溃了" : "应用没能正常打开";
}

function failureHint(detail: CustomAppFailureDetail): string {
  if (detail.source === "host") return "小手机在显示这个应用时出错了，不是应用本身的问题。";
  if (detail.errors.length === 0) return "应用加载后没有画出任何内容，也没有报错。可能是它在等一个没有返回的请求。";
  return "应用的代码在启动时报错中断了，下面是它抛出的第一处错误。";
}

/** 生成可直接粘贴给作者/开发者的诊断文本。 */
export function buildCustomAppDiagnostics(detail: CustomAppFailureDetail): string {
  const lines: string[] = [];
  lines.push("【小手机·自定义应用诊断】");
  lines.push(`应用：${detail.appName} v${detail.appVersion}`);
  lines.push(`运行 ID：${detail.appId}${detail.manifestId ? `（包 ID：${detail.manifestId}）` : ""}`);
  lines.push(`失败类型：${detail.source === "host" ? "宿主界面崩溃" : "应用首屏空白"}`);
  if (detail.errors.length > 0) {
    lines.push("错误：");
    detail.errors.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
  } else {
    lines.push("错误：无（应用没有抛出可捕获的异常）");
  }
  if (detail.componentStack) {
    lines.push("组件栈：");
    lines.push(detail.componentStack.split("\n").slice(0, 8).map(line => `  ${line.trim()}`).join("\n"));
  }
  lines.push("环境：");
  if (typeof window !== "undefined") {
    lines.push(`  地址：${window.location.origin}`);
    lines.push(`  安全上下文：${window.isSecureContext ? "是" : "否（非 HTTPS，部分浏览器 API 不可用）"}`);
    lines.push(`  视口：${window.innerWidth}×${window.innerHeight}`);
    lines.push(`  UA：${navigator.userAgent}`);
  }
  lines.push(`  时间：${new Date().toISOString()}`);
  return lines.join("\n");
}

type CustomAppFailurePanelProps = {
  detail: CustomAppFailureDetail;
  closeLabel?: string;
  onClose: () => void;
  onDismiss?: () => void;
};

export function CustomAppFailurePanel({ detail, closeLabel = "返回桌面", onClose, onDismiss }: CustomAppFailurePanelProps) {
  const [copied, setCopied] = useState(false);

  const copyDiagnostics = useCallback(async () => {
    const text = buildCustomAppDiagnostics(detail);
    try {
      // navigator.clipboard 在非安全上下文里不存在，退回 execCommand
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 复制失败就把文本摊开，用户还能手动选中
      window.prompt("复制下面的诊断信息：", text);
    }
  }, [detail]);

  return (
    <div className="custom-app-failure" role="alert">
      {onDismiss ? (
        <button type="button" className="custom-app-failure-dismiss" onClick={onDismiss} aria-label="关闭提示">
          <X size={16} />
        </button>
      ) : null}
      <div className="custom-app-failure-card">
        <span className="custom-app-failure-icon">
          <TriangleAlert size={22} strokeWidth={2.2} />
        </span>
        <strong>{failureHeadline(detail.source)}</strong>
        <p className="custom-app-failure-app">{detail.appName} · v{detail.appVersion}</p>
        <p className="custom-app-failure-hint">{failureHint(detail)}</p>
        {detail.errors.length > 0 ? (
          <ul className="custom-app-failure-errors">
            {detail.errors.slice(0, MAX_SHOWN_ERRORS).map((item, index) => (
              <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>
            ))}
          </ul>
        ) : null}
        <div className="custom-app-failure-actions">
          <button type="button" className="custom-app-failure-primary" onClick={onClose}>
            {closeLabel}
          </button>
          <button type="button" className="custom-app-failure-secondary" onClick={() => void copyDiagnostics()}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "已复制" : "复制诊断信息"}
          </button>
        </div>
      </div>
    </div>
  );
}

type BoundaryProps = {
  appName: string;
  appId: string;
  appVersion: string;
  manifestId?: string;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
};

type BoundaryState = {
  error: string;
  componentStack?: string;
};

/** 前台应用错误边界：runner 组件自身崩溃时不再让整块界面变空白。 */
export class CustomAppForegroundBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: "" };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[CustomApp] ${this.props.appId} 前台 runner 崩溃：${message}`, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="custom-app-runner">
        <CustomAppFailurePanel
          detail={{
            source: "host",
            appName: this.props.appName,
            appId: this.props.appId,
            appVersion: this.props.appVersion,
            manifestId: this.props.manifestId,
            errors: [this.state.error],
            componentStack: this.state.componentStack,
          }}
          closeLabel={this.props.closeLabel}
          onClose={this.props.onClose}
        />
      </div>
    );
  }
}
