import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// ── 工坊反馈单本地存储（P5）─────────────────────────
// 用户提的、工坊改不了的核心需求，整理成结构化反馈单本地留存。
// 连了 GitHub 会同时开 issue；没连就靠本地 + 复制。

const QA_FEEDBACK_KEY = "ai_phone_qa_feedback_v1";
registerKvMigration(QA_FEEDBACK_KEY);

export type QaFeedbackTicket = {
    id: string;
    ts: number;
    kind: "feature" | "bug" | "other";
    title: string;
    detail: string;
    /** 自动附带的环境信息 */
    environment: string;
    /** 若已开 issue */
    issueUrl?: string;
};

const MAX_TICKETS = 100;

export function loadQaFeedback(): QaFeedbackTicket[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(QA_FEEDBACK_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as QaFeedbackTicket[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function saveQaFeedbackTicket(ticket: QaFeedbackTicket): void {
    if (typeof window === "undefined") return;
    const all = [ticket, ...loadQaFeedback()].slice(0, MAX_TICKETS);
    kvSet(QA_FEEDBACK_KEY, JSON.stringify(all));
}

export function updateQaFeedbackTicket(id: string, patch: Partial<QaFeedbackTicket>): void {
    if (typeof window === "undefined") return;
    const all = loadQaFeedback().map((t) => (t.id === id ? { ...t, ...patch } : t));
    kvSet(QA_FEEDBACK_KEY, JSON.stringify(all));
}

export function captureQaEnvironment(): string {
    if (typeof window === "undefined") return "";
    const parts = [
        `视口 ${window.innerWidth}×${window.innerHeight}@${window.devicePixelRatio}x`,
        navigator.language,
        navigator.userAgent.slice(0, 120),
    ];
    return parts.join(" | ");
}

export function formatQaFeedbackMarkdown(ticket: QaFeedbackTicket): string {
    const kindLabel = ticket.kind === "feature" ? "功能建议" : ticket.kind === "bug" ? "问题反馈" : "其它";
    return [
        `## ${ticket.title}`,
        "",
        `**类型**：${kindLabel}`,
        `**时间**：${new Date(ticket.ts).toLocaleString("zh-CN")}`,
        "",
        "### 描述",
        ticket.detail,
        "",
        "### 环境",
        ticket.environment,
        "",
        "---",
        "_由工坊自动整理提交_",
    ].join("\n");
}
