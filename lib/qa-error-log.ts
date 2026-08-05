// ── 工坊：全局报错收集（轻量 ring buffer）────────────
// 由 desktop-shell 导入安装，供工坊「最近报错」诊断工具读取。

export type QaErrorEntry = {
    ts: number;
    kind: "error" | "unhandledrejection";
    message: string;
    source?: string;
};

const MAX_ENTRIES = 50;
const entries: QaErrorEntry[] = [];
let installed = false;

function push(entry: QaErrorEntry) {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function installQaErrorLog(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;
    window.addEventListener("error", (event) => {
        push({
            ts: Date.now(),
            kind: "error",
            message: String(event.message || event.error || "未知错误").slice(0, 400),
            source: event.filename ? `${event.filename.split("/").pop()}:${event.lineno}` : undefined,
        });
    });
    window.addEventListener("unhandledrejection", (event) => {
        let message: string;
        const reason: unknown = event.reason;
        if (reason instanceof Error) message = reason.message;
        else message = typeof reason === "string" ? reason : JSON.stringify(reason ?? "未知");
        push({ ts: Date.now(), kind: "unhandledrejection", message: message.slice(0, 400) });
    });
    // 收集来自游戏/剧场 iframe 的运行时报错（见 qa-iframe-error-bridge）
    window.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || typeof data !== "object" || data.source !== "ai-phone-iframe-error") return;
        const origin = typeof data.origin === "string" && data.origin ? data.origin : "iframe";
        const loc = typeof data.source_loc === "string" && data.source_loc ? data.source_loc : undefined;
        push({
            ts: Date.now(),
            kind: "error",
            message: `[${origin}] ${String(data.message ?? "").slice(0, 360)}`,
            source: loc,
        });
    });
}

export function getQaErrorEntries(): QaErrorEntry[] {
    return [...entries];
}

// 浏览器端导入即安装
installQaErrorLog();
