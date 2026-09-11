// lib/api-log-store.ts
// 底层模型调用日志存储（独立模块，避免 chat-engine ↔ api-helpers 循环依赖）。
// 聊天引擎（整段/流式/原生工具）与 simpleLLMCall（记忆总结、朋友圈、日历等
// 通用 LLM 调用）共用这份日志，统一在「底层调用大模型日志」面板查看。

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

export type DebugInfo = {
    id: string;
    characterName?: string;
    model?: string;
    messages: { role: string; content: string; marker?: string }[];
    rawResponse: string;
    timestamp: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    /** 模型思维链（reasoning/CoT）原文，独立于回复内容存储，避免被清洗吞掉 */
    reasoning?: string;
    /** 调用来源：chat=聊天引擎、background=simpleLLMCall 后台功能（具体功能名看 characterName 标签）、qa=工坊答疑引擎 */
    source?: "chat" | "background" | "qa";
    /** 归属通道：qa 进工坊专用环，其余进底层调用日志环。分流只认这个显式字段，不看角色名 */
    channel?: "chat" | "qa";
};

// 底层调用日志环容量。原为 50：聊天请求与 18 处 simpleLLMCall 后台调用（记忆总结、
// NPC 生成、剧情、地图等）共享一个环，用户想看自己刚才那次聊天时很容易已被后台调用
// 挤掉，因此扩容；配合单条截断与体积预算控制总占用。
const MAX_API_LOGS = 150;
// 工坊环容量：只有答疑引擎写入，量小，维持原值。
const MAX_QA_API_LOGS = 50;
// 单环序列化字符预算：超预算时从最旧开始丢弃，控制 IndexedDB 常驻体积与序列化开销。
// 原为 2MB：特调对局一次调用带整段历史，单条日志逼近 100K，二十来轮就把预算塞满，
// 把普通聊天、记忆总结这些小记录全挤出去，来源过滤里只剩一个角色。提到 8MB 能装
// 八十来条这样的大记录；存在 IndexedDB 里，这个量级没有压力。
const MAX_API_LOGS_SERIALIZED_CHARS = 8 * 1024 * 1024;
const MAX_QA_LOGS_SERIALIZED_CHARS = 1024 * 1024;
// 单条文本截断上限：记忆总结类调用的完整 prompt 动辄几十 KB，写日志前先截断，
// 控制每次 push 的 parse/stringify 写放大与常驻体积。
const MAX_LOG_MESSAGE_CHARS = 4000;
const MAX_LOG_MESSAGES_TOTAL_CHARS = 96_000;
const MAX_LOG_RESPONSE_CHARS = 8000;
const MAX_LOG_METADATA_CHARS = 200;

const API_LOGS_KEY = "ai_phone_api_logs_v1";
// 工坊（QA 助手）专用调用记录：与聊天/记忆等底层调用日志彻底隔离，
// 只在工坊界面右上角「调用记录」里查看，绝不混进聊天页的「底层调用大模型日志」。
const QA_LOGS_KEY = "ai_phone_qa_api_logs_v1";
registerKvMigration(API_LOGS_KEY);
registerKvMigration(QA_LOGS_KEY);

function _loadLogs(key: string): DebugInfo[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(key) : null;
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as DebugInfo[] : [];
    } catch { return []; }
}
function _saveLogs(key: string, logs: DebugInfo[]): void {
    try { kvSet(key, JSON.stringify(logs)); } catch { /* 日志失败不影响主流程 */ }
}

function truncateForLog(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n…[日志截断：原文共 ${text.length} 字符]`;
}

function truncateMessagesForLog(messages: DebugInfo["messages"]): DebugInfo["messages"] {
    const truncated = messages.map(message => ({
        ...message,
        content: truncateForLog(message.content, MAX_LOG_MESSAGE_CHARS),
    }));
    const totalChars = truncated.reduce((sum, message) => sum + message.content.length, 0);
    if (totalChars <= MAX_LOG_MESSAGES_TOTAL_CHARS || truncated.length <= 1) return truncated;

    // 首条通常是系统提示，保留它和尽可能多的最新上下文；中间历史用一条说明代替。
    const first = truncated[0];
    const tail: DebugInfo["messages"] = [];
    let usedChars = first.content.length;
    for (let index = truncated.length - 1; index >= 1; index -= 1) {
        const message = truncated[index];
        if (usedChars + message.content.length > MAX_LOG_MESSAGES_TOTAL_CHARS) break;
        tail.push(message);
        usedChars += message.content.length;
    }
    tail.reverse();
    const omittedCount = truncated.length - 1 - tail.length;
    return [
        first,
        ...(omittedCount > 0 ? [{
            role: "system",
            content: `…[日志截断：省略 ${omittedCount} 条中间消息]`,
            marker: "log-truncated",
        }] : []),
        ...tail,
    ];
}

function truncateEntryForLog(entry: Omit<DebugInfo, "id" | "timestamp">): Omit<DebugInfo, "id" | "timestamp"> {
    return {
        ...entry,
        characterName: entry.characterName !== undefined
            ? truncateForLog(entry.characterName, MAX_LOG_METADATA_CHARS)
            : undefined,
        model: entry.model !== undefined ? truncateForLog(entry.model, MAX_LOG_METADATA_CHARS) : undefined,
        messages: truncateMessagesForLog(entry.messages),
        rawResponse: truncateForLog(entry.rawResponse, MAX_LOG_RESPONSE_CHARS),
        reasoning: entry.reasoning !== undefined ? truncateForLog(entry.reasoning, MAX_LOG_RESPONSE_CHARS) : undefined,
    };
}

function trimLogsForStorage(logs: DebugInfo[], maxCount: number, maxSerializedChars: number): DebugInfo[] {
    const candidates = logs.slice(-maxCount);
    const newestFirst: DebugInfo[] = [];
    let serializedChars = 2; // []

    // 每条只序列化一次，避免超预算时反复 stringify 整个日志环造成主线程卡顿。
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const entryChars = JSON.stringify(candidates[index]).length;
        const separatorChars = newestFirst.length > 0 ? 1 : 0;
        if (serializedChars + separatorChars + entryChars > maxSerializedChars) break;
        newestFirst.push(candidates[index]);
        serializedChars += separatorChars + entryChars;
    }

    return newestFirst.reverse();
}

export function getApiLogs(): DebugInfo[] { return _loadLogs(API_LOGS_KEY); }
export function clearApiLogs(): void { try { kvRemove(API_LOGS_KEY); } catch { } }

/** 工坊专用调用记录（仅工坊 UI 读取，与底层日志完全隔离）。 */
export function getQaApiLogs(): DebugInfo[] { return _loadLogs(QA_LOGS_KEY); }
export function clearQaApiLogs(): void { try { kvRemove(QA_LOGS_KEY); } catch { } }

/** 追加一条调用日志（id/timestamp 自动生成、超限文本截断），超出数量/体积上限时裁掉最旧的记录。 */
export function pushApiLog(entry: Omit<DebugInfo, "id" | "timestamp">): void {
    // 工坊（QA 助手）的调用单独归档，不进聊天页的底层调用日志。
    // 分流只认显式 channel 字段：角色名恰好叫「工坊」的聊天不会被误扔进工坊记录。
    const isQa = entry.channel === "qa";
    const key = isQa ? QA_LOGS_KEY : API_LOGS_KEY;
    const maxCount = isQa ? MAX_QA_API_LOGS : MAX_API_LOGS;
    const maxSerializedChars = isQa ? MAX_QA_LOGS_SERIALIZED_CHARS : MAX_API_LOGS_SERIALIZED_CHARS;
    try {
        const logs = _loadLogs(key);
        logs.push({
            ...truncateEntryForLog(entry),
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
        });
        _saveLogs(key, trimLogsForStorage(logs, maxCount, maxSerializedChars));
    } catch { /* 日志写入失败不影响主流程 */ }
}
