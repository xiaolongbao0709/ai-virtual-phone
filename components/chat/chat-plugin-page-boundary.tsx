"use client";

// 工坊/扩展插件页的白屏兜底。这两个页面一挂载就渲染插件相关数据，一条损坏
// 数据就能把整页打成白屏——而卸载/禁用/退出安全模式按钮全长在页面里，
// 页面一死用户就永远无法自救（实报：导入工坊插件后两页持久白屏，刷新、
// 清数据均无效）。插件安全模式只跳过代码加载，救不了渲染期崩溃，所以
// 兜底卡片必须自带出路：复制错误详情、一键进安全模式、清空已导入插件。

import { Component, type ErrorInfo, type ReactNode } from "react";
import { setChatPluginSafeMode } from "@/lib/chat-plugin-runtime";
import { saveChatPlugins } from "@/lib/chat-plugin-storage";

type ChatPluginPageBoundaryProps = {
    /** 页面名，用于错误详情与文案（如「工坊」「扩展插件」） */
    page: string;
    onClose?: () => void;
    children: ReactNode;
};

type ChatPluginPageBoundaryState = {
    error: string;
    componentStack?: string;
    copied: boolean;
    confirmClear: boolean;
};

export class ChatPluginPageBoundary extends Component<ChatPluginPageBoundaryProps, ChatPluginPageBoundaryState> {
    state: ChatPluginPageBoundaryState = { error: "", copied: false, confirmClear: false };

    static getDerivedStateFromError(error: unknown): Partial<ChatPluginPageBoundaryState> {
        return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ChatPluginPage] ${this.props.page} 页面崩溃：${message}`, info.componentStack);
        this.setState({ componentStack: info.componentStack ?? undefined });
    }

    private buildDiagnostics(): string {
        return [
            `页面：${this.props.page}`,
            `时间：${new Date().toISOString()}`,
            `错误：${this.state.error}`,
            this.state.componentStack ? `组件栈：${this.state.componentStack}` : "",
        ].filter(Boolean).join("\n");
    }

    private copyDiagnostics = (): void => {
        const text = this.buildDiagnostics();
        void navigator.clipboard?.writeText(text)
            .then(() => this.setState({ copied: true }))
            .catch(() => { window.prompt("复制失败，请手动复制：", text); });
    };

    private enterSafeMode = (): void => {
        setChatPluginSafeMode(true);
        window.location.reload();
    };

    private clearPlugins = (): void => {
        if (!this.state.confirmClear) {
            this.setState({ confirmClear: true });
            return;
        }
        try { saveChatPlugins([]); } catch { /* ignore */ }
        window.location.reload();
    };

    render(): ReactNode {
        if (!this.state.error) return this.props.children;
        return (
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, maxWidth: 420, margin: "0 auto" }}>
                <div className="menu-group" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                    <span className="menu-label" style={{ fontWeight: 600 }}>「{this.props.page}」页面出错了</span>
                    <span className="menu-desc">
                        页面渲染崩溃，通常由某个已导入插件的损坏数据引起。可先复制错误详情反馈，
                        再用下面的按钮自救：安全模式会跳过全部插件加载；仍无法进入时可清空已导入插件（不可恢复）。
                    </span>
                    <span className="menu-desc" style={{ wordBreak: "break-all", opacity: 0.75 }}>{this.state.error}</span>
                </div>
                <button className="ui-btn ui-btn-outline" onClick={this.copyDiagnostics}>
                    {this.state.copied ? "已复制，可粘贴到反馈里" : "复制错误详情"}
                </button>
                <button className="ui-btn ui-btn-primary" onClick={this.enterSafeMode}>
                    进入插件安全模式并刷新
                </button>
                <button className="ui-btn ui-btn-outline" style={{ color: "var(--c-danger)" }} onClick={this.clearPlugins}>
                    {this.state.confirmClear ? "再点一次确认：清空全部已导入插件" : "清空已导入插件（不可恢复）"}
                </button>
                {this.props.onClose && (
                    <button className="ui-btn ui-btn-ghost" onClick={this.props.onClose}>返回</button>
                )}
            </div>
        );
    }
}
