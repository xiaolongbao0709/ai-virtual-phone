import type {
    CompositeToolConfig,
    CompositeToolPackageConfig,
    CompositeToolStep,
    InternalCapabilityConfig,
    RestToolConfig,
    RestToolPackageConfig,
    McpServerConfig,
} from "./settings-types";
import {
    loadCompositeTools,
    loadCompositeToolPackages,
    loadRestTools,
    loadRestToolPackages,
    loadMcpServers,
    saveCompositeTools,
    saveCompositeToolPackages,
    saveMcpServers,
    saveRestTools,
    saveRestToolPackages,
    expandToolNameMacros,
    toolNameMatches,
} from "./tool-storage";
import { executeCustomAppToolCall } from "./custom-app-tool-runtime";
import { CALENDAR_MANAGEMENT_CAPABILITY_ID, LOCAL_DATA_LIBRARY_CAPABILITY_ID, MEMORY_WRITE_CAPABILITY_ID, MUSIC_CONTROL_CAPABILITY_ID, NOTE_WALL_CAPABILITY_ID, SEND_FILE_CAPABILITY_ID, TIMED_WAKE_CAPABILITY_ID, TOOLBOX_MANAGEMENT_CAPABILITY_ID, getInternalCapability } from "./internal-capability-storage";
import { loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import type { MemoryEntry } from "./memory-types";
import { loadCharacters } from "./character-storage";
import {
    deleteCalendarScheduleItem,
    loadCalendarWeekPlan,
    loadOwnerCalendarPlans,
    upsertCalendarScheduleItem,
} from "./calendar-storage";
import type { CalendarOwnerType, CalendarScheduleItem } from "./calendar-types";
import {
    formatIsoDate,
    getWeekDates,
    getWeekStartIso,
    getWeekdayLabel,
    isCalendarTimeRangeAllowed,
    normalizeTime,
    parseIsoDate,
    sanitizeScheduleEmoji,
    sortScheduleItems,
} from "./calendar-utils";
import type { NoteWallBoard, NoteWallComment, NoteWallNote, NoteWallSize } from "./notewall-types";
import { findNoteWallPlacement, normalizeNoteWallSize } from "./notewall-utils";
import { recordNoteWallCommentEvent, recordNoteWallNoteEvent } from "./notewall-memory";
import { getMusicControlBridge } from "./music-control-bridge";
import { loadAllTracks, type MusicTrack } from "./music-storage";
import {
    checkLoginStatus,
    getNeteaseLyrics,
    getNeteaseSongDetail,
    getPlaylistTracks,
    getUserPlaylists,
    getUserRecord,
    isNeteaseConfigured,
    loadMusicApiConfig,
    unifiedSearch,
    type NeteaseSearchResult,
} from "./music-service";
import {
    inspectLocalDataFields,
    listLocalDataDirectory,
    readLocalDataFile,
    readLocalDataRecord,
    searchLocalDataRecords,
} from "./local-data-fs";
import { makeTimedWakeId, saveTimedWakeSchedule } from "./timed-wake-storage";
import { resolveUserIdentity } from "./settings-storage";
import { attachAbortSignal, isAbortError, throwIfAborted } from "./abort-utils";

// ── Types ─────────────────────────────────────

export type MemoryWriteRequest = {
    capabilityId: typeof MEMORY_WRITE_CAPABILITY_ID;
    sessionId: string;
    characterId: string;
    content: string;
    importance: number;
    reason?: string;
};

export type ToolExecutionContext = {
    appId?: string;
    sessionId?: string;
    characterId?: string;
    sourceEngine?: "chat" | "group_chat" | "custom_app";
    signal?: AbortSignal;
};

function isSupportedChatToolContext(
    context?: ToolExecutionContext,
): context is ToolExecutionContext & { characterId: string } {
    return Boolean(
        context?.characterId
        && (
            (context.appId === "chat" && context.sourceEngine === "chat")
            || (context.appId === "group_chat" && context.sourceEngine === "group_chat")
        ),
    );
}

export type MediaAttachment = {
    type: "audio" | "image" | "video" | "file";
    url: string;
    title?: string;
};

export type ToolResult = {
    name: string;
    success: boolean;
    data?: string;
    error?: string;
    actorName?: string;
    actorCharacterId?: string;
    continueConversation?: boolean;
    persistToHistory?: boolean;
    userNotice?: string;
    pendingApproval?: boolean;
    pendingRequest?: MemoryWriteRequest;
    mediaAttachments?: MediaAttachment[];
};

import { extractBase64Blocks, storeMediaBase64, storeMediaBlob, detectMediaType, MEDIA_STORE_PROTOCOL } from "./media-cache-storage";

const MAX_RESULT_LENGTH = 2000;
const PROXY_URL = "/api/tool-proxy";

const MIN_B64_MEDIA_LENGTH = 500;

async function replaceBase64WithRefs(text: string, signal?: AbortSignal): Promise<{ text: string; attachments: MediaAttachment[] }> {
    throwIfAborted(signal);
    const blocks = extractBase64Blocks(text);
    if (blocks.length === 0) return { text, attachments: [] };

    const attachments: MediaAttachment[] = [];
    let result = text;
    let offset = 0;

    for (const block of blocks) {
        throwIfAborted(signal);
        if (block.b64.length < MIN_B64_MEDIA_LENGTH) continue;
        try {
            const { ref, category, mime } = await storeMediaBase64(block.b64, block.declaredMime);
            throwIfAborted(signal);
            const placeholder = `${ref} (${mime})`;
            const adjustedStart = block.start + offset;
            result = result.slice(0, adjustedStart) + placeholder + result.slice(adjustedStart + block.fullMatch.length);
            offset += placeholder.length - block.fullMatch.length;
            attachments.push({ type: category, url: ref });
        } catch { /* ignore invalid embedded media */ }
    }

    return { text: result, attachments };
}

// ── Proxy fetch (bypasses CORS) ───────────────

// Combine a caller's abort signal with an internal one (e.g. a per-request timeout)
// so the fetch aborts when either fires.
function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
    if (!a) return b;
    if (!b) return a;
    const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    if (typeof anyFn === "function") return anyFn([a, b]);
    const controller = new AbortController();
    if (a.aborted || b.aborted) {
        controller.abort();
    } else {
        const onAbort = () => controller.abort();
        a.addEventListener("abort", onAbort, { once: true });
        b.addEventListener("abort", onAbort, { once: true });
    }
    return controller.signal;
}

async function proxyFetch(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
    throwIfAborted(options.signal);

    // Optional per-request timeout: abort the client→proxy fetch early so a hanging
    // upstream (slow/unreachable .well-known probe) can't block the whole flow.
    let signal = options.signal;
    let timeoutController: AbortController | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
        timeoutController = new AbortController();
        timeoutId = setTimeout(() => timeoutController!.abort(), options.timeoutMs);
        signal = combineAbortSignals(options.signal, timeoutController.signal);
    }

    try {
        const res = await fetch(PROXY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal,
            body: JSON.stringify({
                url,
                method: options.method || "POST",
                headers: options.headers || {},
                body: options.body,
            }),
        });

        const text = await res.text();
        throwIfAborted(options.signal);

        // Extract forwarded headers
        const headers: Record<string, string> = {};
        const sessionId = res.headers.get("mcp-session-id");
        if (sessionId) headers["mcp-session-id"] = sessionId;
        const wwwAuth = res.headers.get("www-authenticate");
        if (wwwAuth) headers["www-authenticate"] = wwwAuth;

        return { status: res.status, text, headers };
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

function truncate(text: string): string {
    if (text.length > MAX_RESULT_LENGTH) return text.slice(0, MAX_RESULT_LENGTH);
    return text;
}

// ── Parse tool calls from LLM output ──────────

export type ToolFetch = { actor?: string; name: string };

/**
 * Parse ["角色名"获取指令:动作类别名] or [获取指令:动作类别名] tags.
 * Backward compatible with the old 获取工具 wording.
 * Does NOT strip tags from text (raw text preserved in history).
 */
export function parseToolFetches(text: string): ToolFetch[] {
    const results: ToolFetch[] = [];
    const pattern = /\[[""\u201C]?([^""\u201D\]]*?)[""\u201D]?\s*(?:获取指令|获取工具)[:：]\s*([^\]]+?)\s*\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        results.push({ actor: match[1]?.trim() || undefined, name: match[2].trim() });
    }
    return results;
}

export type ToolCall = {
    name: string;
    args: Record<string, unknown>;
    actor?: string;
};

type ParsedToolCallSpan = {
    start: number;
    end: number;
    actor?: string;
    name: string;
    argsRaw: string;
};

function cleanToolActor(raw: string): string | undefined {
    const actor = raw.trim().replace(/^["“]+|["”]+$/g, "").trim();
    return actor || undefined;
}

function parseToolArgsJson(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    const parseObject = (text: string): Record<string, unknown> | null => {
        try {
            const parsed = JSON.parse(text) as unknown;
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch { /* try fallback below */ }
        return null;
    };
    return parseObject(trimmed) || parseObject(trimmed.replace(/'/g, '"'));
}

function parseToolCallAt(text: string, start: number): ParsedToolCallSpan | null {
    if (text[start] !== "[") return null;

    let opener = -1;
    for (let i = start + 1; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "\n" || ch === "]") return null;
        if (ch === "(" || ch === "（") {
            opener = i;
            break;
        }
    }
    if (opener < 0) return null;

    const header = text.slice(start + 1, opener).trim();
    const actionMatch = /^(.*?)\s*(?:执行动作|工具调用)\s*[:：]\s*(.+)$/.exec(header);
    if (!actionMatch) return null;

    const actor = cleanToolActor(actionMatch[1] || "");
    const name = actionMatch[2].trim();
    if (!name) return null;

    let depth = 1;
    let quote: '"' | "'" | null = null;
    let escaped = false;
    for (let i = opener + 1; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }

        if (ch === "\"" || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === "]" && depth === 1) {
            const argsRaw = text.slice(opener + 1, i);
            if (parseToolArgsJson(argsRaw)) {
                return {
                    start,
                    end: i + 1,
                    actor,
                    name,
                    argsRaw,
                };
            }
            continue;
        }
        if (ch === "(" || ch === "（") {
            depth += 1;
            continue;
        }
        if (ch !== ")" && ch !== "）") continue;

        depth -= 1;
        if (depth !== 0) continue;

        let closeBracket = i + 1;
        while (closeBracket < text.length && /\s/.test(text[closeBracket])) closeBracket += 1;
        if (text[closeBracket] !== "]") return null;

        return {
            start,
            end: closeBracket + 1,
            actor,
            name,
            argsRaw: text.slice(opener + 1, i),
        };
    }

    return null;
}

export function findToolCallEnd(text: string, start: number): number | null {
    return parseToolCallAt(text, start)?.end ?? null;
}

export function parseToolCalls(text: string): { cleanText: string; toolCalls: ToolCall[] } {
    const toolCalls: ToolCall[] = [];
    const spans: ParsedToolCallSpan[] = [];

    let pos = 0;
    while (pos < text.length) {
        const start = text.indexOf("[", pos);
        if (start < 0) break;
        const span = parseToolCallAt(text, start);
        if (!span) {
            pos = start + 1;
            continue;
        }
        const args = parseToolArgsJson(span.argsRaw) || {};
        toolCalls.push({ name: span.name, args, actor: span.actor });
        spans.push(span);
        pos = span.end;
    }

    let cleanText = "";
    let cursor = 0;
    for (const span of spans) {
        cleanText += text.slice(cursor, span.start);
        cursor = span.end;
    }
    cleanText += text.slice(cursor);
    cleanText = cleanText.replace(/\n{3,}/g, "\n\n").trim();
    return { cleanText, toolCalls };
}

// ── Execute tool calls (unified entry) ────────

export async function executeToolCalls(toolCalls: ToolCall[], context?: ToolExecutionContext): Promise<ToolResult[]> {
    throwIfAborted(context?.signal);
    return Promise.all(toolCalls.map(call => executeSingleToolCall(call, context, { depth: 0 })));
}

type ToolExecutionHint = {
    depth: number;
    toolType?: CompositeToolStep["toolType"];
    toolId?: string;
    serverId?: string;
};

const MAX_COMPOSITE_DEPTH = 2;

function buildToolNameMacroContext(context?: ToolExecutionContext) {
    const characterName = context?.characterId
        ? loadCharacters().find(character => character.id === context.characterId)?.name
        : undefined;
    const userName =
        resolveUserIdentity(context?.characterId, context?.appId)?.name
        || resolveUserIdentity(undefined, context?.appId)?.name
        || "用户";
    return { characterName, userName };
}

async function executeSingleToolCall(
    call: ToolCall,
    context: ToolExecutionContext | undefined,
    hint: ToolExecutionHint,
): Promise<ToolResult> {
    throwIfAborted(context?.signal);
    const preferredType = hint.toolType && hint.toolType !== "auto" && hint.toolType !== "script" ? hint.toolType : undefined;
    const restTools = loadRestTools();
    const restPackages = loadRestToolPackages();
    const restPackageIds = new Set(restPackages.map(pkg => pkg.id));
    const enabledRestPackageIds = new Set(restPackages.filter(pkg => pkg.enabled).map(pkg => pkg.id));
    const compositeTools = loadCompositeTools();
    const compositePackages = loadCompositeToolPackages();
    const compositePackageIds = new Set(compositePackages.map(pkg => pkg.id));
    const enabledCompositePackageIds = new Set(compositePackages.filter(pkg => pkg.enabled).map(pkg => pkg.id));
    const mcpServers = loadMcpServers();
    const nameMacroContext = buildToolNameMacroContext(context);

    const tryInternal = async () => {
        const internalResult = await executeInternalTool(call, context);
        return internalResult ? normalizeInternalToolResult(internalResult) : null;
    };

    const tryRest = () => {
        const restTool = restTools.find(t => (
            t.enabled
            && (!hint.toolId || t.id === hint.toolId)
            && toolNameMatches(t.name, call.name, nameMacroContext)
            && (!t.packageId || !restPackageIds.has(t.packageId) || enabledRestPackageIds.has(t.packageId))
        ));
        if (restTool) return executeRestTool(restTool, call.args, context?.signal);
        return null;
    };

    const tryMcp = () => {
        for (const server of mcpServers) {
            if (!server.enabled || !server.discoveredTools) continue;
            if (hint.serverId && server.id !== hint.serverId) continue;
            if (server.discoveredTools.find(t => t.name === call.name)) {
                return executeMcpTool(server, call.name, call.args, context?.signal);
            }
        }
        return null;
    };

    const tryComposite = () => {
        const compositeTool = compositeTools.find(t => (
            t.enabled
            && (!hint.toolId || t.id === hint.toolId)
            && toolNameMatches(t.name, call.name, nameMacroContext)
            && (!t.packageId || !compositePackageIds.has(t.packageId) || enabledCompositePackageIds.has(t.packageId))
        ));
        if (compositeTool) return executeCompositeTool(compositeTool, call.args, context, hint.depth);
        return null;
    };
    const tryCustomApp = () => executeCustomAppToolCall(call, context, nameMacroContext);

    if (preferredType === "internal") {
        const result = await tryInternal();
        return result || { name: call.name, success: false, error: "动作未找到" };
    }
    if (preferredType === "rest") return tryRest() || { name: call.name, success: false, error: "动作未找到" };
    if (preferredType === "mcp") return tryMcp() || { name: call.name, success: false, error: "动作未找到" };
    if (preferredType === "composite") return tryComposite() || { name: call.name, success: false, error: "动作未找到" };

    const internalResult = await tryInternal();
    throwIfAborted(context?.signal);
    if (internalResult) return internalResult;

    const restResult = tryRest();
    if (restResult) return restResult;

    const compositeResult = tryComposite();
    if (compositeResult) return compositeResult;

    const mcpResult = tryMcp();
    if (mcpResult) return mcpResult;

    const customAppResult = await tryCustomApp();
    throwIfAborted(context?.signal);
    if (customAppResult) return customAppResult;

    return { name: call.name, success: false, error: "动作未找到" };
}

type CompositeStepResult = {
    name: string;
    success: boolean;
    data?: string;
    json?: unknown;
    error?: string;
    userNotice?: string;
};

function tryParseCompositeJson(text: string | undefined): unknown {
    if (!text?.trim()) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function resolveCompositePath(path: string, scope: Record<string, unknown>): unknown {
    const parts = path.split(".").map(part => part.trim()).filter(Boolean);
    let current: unknown = scope;
    for (const part of parts) {
        if (current && typeof current === "object" && part in current) {
            current = (current as Record<string, unknown>)[part];
        } else {
            return "";
        }
    }
    return current ?? "";
}

function renderCompositeString(value: string, scope: Record<string, unknown>): unknown {
    const whole = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
    if (whole) return resolveCompositePath(whole[1], scope);
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path: string) => {
        const resolved = resolveCompositePath(path, scope);
        if (resolved === undefined || resolved === null) return "";
        if (typeof resolved === "string") return resolved;
        try {
            return JSON.stringify(resolved);
        } catch {
            return String(resolved);
        }
    });
}

function renderCompositeValue(value: unknown, scope: Record<string, unknown>): unknown {
    if (typeof value === "string") return renderCompositeString(value, scope);
    if (Array.isArray(value)) return value.map(item => renderCompositeValue(item, scope));
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            result[key] = renderCompositeValue(child, scope);
        }
        return result;
    }
    return value;
}

function renderCompositeArgs(template: string | undefined, scope: Record<string, unknown>): Record<string, unknown> {
    if (!template?.trim()) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(template);
    } catch {
        throw new Error("组合步骤 argsTemplate 必须是合法 JSON");
    }
    const rendered = renderCompositeValue(parsed, scope);
    if (!rendered || typeof rendered !== "object" || Array.isArray(rendered)) {
        throw new Error("组合步骤 argsTemplate 渲染后必须是对象");
    }
    return rendered as Record<string, unknown>;
}

function formatCompositeDefaultOutput(stepResults: CompositeStepResult[]): string {
    return stepResults.map((result, index) => {
        const body = result.success ? (result.data || result.userNotice || "执行成功") : (result.error || result.userNotice || "执行失败");
        return `步骤 ${index + 1}「${result.name}」${result.success ? "成功" : "失败"}：${body}`;
    }).join("\n\n");
}

function stringifyCompositeScriptReturn(value: unknown): string {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

async function executeCompositeScriptStep(
    tool: CompositeToolConfig,
    step: CompositeToolStep,
    stepArgs: Record<string, unknown>,
    scope: Record<string, unknown>,
): Promise<ToolResult> {
    const script = step.script?.trim();
    if (!script) {
        return { name: step.name || step.saveAs || "脚本步骤", success: false, error: "script 不能为空" };
    }

    try {
        const AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor as {
            new (...args: string[]): (...values: unknown[]) => Promise<unknown>;
        };
        const runner = new AsyncFunction("input", "steps", "last", "args", "context", script);
        const value = await runner(
            scope.input,
            scope.steps,
            scope.last,
            stepArgs,
            {
                toolId: tool.id,
                toolName: tool.name,
                stepId: step.id,
                stepName: step.name || step.saveAs || "脚本步骤",
                saveAs: step.saveAs,
            },
        );
        return {
            name: step.name || step.saveAs || "脚本步骤",
            success: true,
            data: truncate(stringifyCompositeScriptReturn(value)),
        };
    } catch (err) {
        const error = err instanceof Error ? (err.stack || err.message) : String(err);
        return {
            name: step.name || step.saveAs || "脚本步骤",
            success: false,
            error,
        };
    }
}

async function executeCompositeTool(
    tool: CompositeToolConfig,
    args: Record<string, unknown>,
    context: ToolExecutionContext | undefined,
    depth: number,
): Promise<ToolResult> {
    throwIfAborted(context?.signal);
    const toolDisplayName = expandToolNameMacros(tool.name, buildToolNameMacroContext(context));
    if (depth >= MAX_COMPOSITE_DEPTH) {
        return { name: toolDisplayName, success: false, error: "组合工具嵌套层级过深" };
    }
    if (!Array.isArray(tool.steps) || tool.steps.length === 0) {
        return { name: toolDisplayName, success: false, error: "组合工具没有配置步骤" };
    }

    const steps: Record<string, CompositeStepResult> = {};
    const stepResults: CompositeStepResult[] = [];
    const mediaAttachments: MediaAttachment[] = [];
    let last: CompositeStepResult = { name: "", success: true, data: "" };

    try {
        for (let index = 0; index < tool.steps.length; index += 1) {
            throwIfAborted(context?.signal);
            const step = tool.steps[index];
            const scope = { input: args, last, steps };
            const stepArgs = renderCompositeArgs(step.argsTemplate, scope);
            let result: ToolResult;
            if (step.toolType === "script") {
                result = await executeCompositeScriptStep(tool, step, stepArgs, scope);
            } else {
                if (!step.toolName?.trim()) throw new Error(`步骤 ${index + 1} 缺少 toolName`);
                result = await executeSingleToolCall(
                    { name: step.toolName.trim(), args: stepArgs },
                    context,
                    {
                        depth: depth + 1,
                        toolType: step.toolType,
                        toolId: step.toolId,
                        serverId: step.serverId,
                    },
                );
            }
            throwIfAborted(context?.signal);
            const stored: CompositeStepResult = {
                name: result.name,
                success: result.success,
                data: result.data,
                json: tryParseCompositeJson(result.data),
                error: result.error,
                userNotice: result.userNotice,
            };
            const key = step.saveAs?.trim() || step.id || `step${index + 1}`;
            steps[key] = stored;
            last = stored;
            stepResults.push(stored);
            mediaAttachments.push(...(result.mediaAttachments || []));
            if (!result.success) {
                return {
                    name: toolDisplayName,
                    success: false,
                    error: `步骤 ${index + 1}「${step.toolType === "script" ? (step.name || step.saveAs || "脚本步骤") : step.toolName}」失败：${result.error || result.userNotice || "未知错误"}`,
                    mediaAttachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
                };
            }
        }

        const scope = { input: args, last, steps };
        const renderedOutput = tool.outputTemplate?.trim()
            ? renderCompositeString(tool.outputTemplate, scope)
            : formatCompositeDefaultOutput(stepResults);
        const output = typeof renderedOutput === "string"
            ? renderedOutput
            : JSON.stringify(renderedOutput, null, 2);
        return {
            name: toolDisplayName,
            success: true,
            data: truncate(output),
            userNotice: `${toolDisplayName}完成`,
            mediaAttachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
        };
    } catch (err) {
        if (isAbortError(err)) throw err;
        return {
            name: toolDisplayName,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            mediaAttachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
        };
    }
}

function normalizeInternalToolResult(result: ToolResult): ToolResult {
    return {
        ...result,
        continueConversation: true,
        persistToHistory: true,
    };
}

async function executeInternalTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult | null> {
    if (isNoteWallToolName(call.name)) return executeNoteWallTool(call, context);
    if (isMusicControlToolName(call.name)) return executeMusicControlTool(call, context);
    if (isCalendarToolName(call.name)) return executeCalendarTool(call, context);
    if (isLocalDataToolName(call.name)) return executeLocalDataTool(call);
    if (isToolboxManagementToolName(call.name)) return executeToolboxManagementTool(call);
    if (call.name === "发送文件") return executeSendFileTool(call);
    if (call.name === "稍后主动联系" || call.name === "设置定时醒来") return executeTimedWakeTool(call, context);

    if (call.name !== "写入记忆") return null;

    const capability = getInternalCapability(MEMORY_WRITE_CAPABILITY_ID);
    if (!capability || !capability.enabled || capability.mode === "off") {
        return {
            name: call.name,
            success: false,
            error: "写入记忆能力未启用",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "写入记忆能力未启用",
        };
    }

    return executeMemoryWriteTool(call.args, capability, context);
}

function isNoteWallToolName(name: string): boolean {
    return name === "查看便签列表"
        || name === "查看便签详情及评论"
        || name === "发送便签"
        || name === "发送便签评论";
}

function isMusicControlToolName(name: string): boolean {
    return name === "查看音乐状态"
        || name === "查看音乐库概览"
        || name === "查看歌单歌曲"
        || name === "搜索音乐"
        || name === "播放音乐"
        || name === "加入播放列表"
        || name === "切换音乐";
}

function isCalendarToolName(name: string): boolean {
    return name === "查看日程"
        || name === "添加日程"
        || name === "修改日程"
        || name === "取消日程";
}

function isLocalDataToolName(name: string): boolean {
    return name === "列出资料目录"
        || name === "读取资料文件"
        || name === "查看资料字段"
        || name === "搜索资料记录"
        || name === "读取资料记录";
}

function isToolboxManagementToolName(name: string): boolean {
    return name === "添加REST套件"
        || name === "更新REST套件"
        || name === "设置REST套件启用"
        || name === "删除REST套件"
        || name === "添加REST工具"
        || name === "更新REST工具"
        || name === "设置REST工具启用"
        || name === "删除REST工具"
        || name === "添加组合工具套件"
        || name === "更新组合工具套件"
        || name === "设置组合工具套件启用"
        || name === "删除组合工具套件"
        || name === "添加组合工具"
        || name === "更新组合工具"
        || name === "设置组合工具启用"
        || name === "删除组合工具";
}

const MAX_LOCAL_DATA_RESULT_LENGTH = 12000;

function stringifyLocalDataResult(value: unknown): string {
    let text: string;
    try {
        text = JSON.stringify(value, null, 2);
    } catch {
        text = String(value);
    }
    if (text.length <= MAX_LOCAL_DATA_RESULT_LENGTH) return text;
    return text.slice(0, MAX_LOCAL_DATA_RESULT_LENGTH);
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" ? value : undefined;
}

function requiredStringArg(args: Record<string, unknown>, key: string): string {
    const value = optionalStringArg(args, key)?.trim();
    if (!value) throw new Error(`缺少参数：${key}`);
    return value;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
    const value = args[key];
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return items.length > 0 ? items : undefined;
}

async function executeLocalDataTool(call: ToolCall): Promise<ToolResult> {
    const capability = getInternalCapability(LOCAL_DATA_LIBRARY_CAPABILITY_ID);
    if (!capability || !capability.enabled || capability.mode === "off") {
        return {
            name: call.name,
            success: false,
            error: "本地资料库能力未启用",
            userNotice: "本地资料库能力未启用",
        };
    }

    try {
        let data: unknown;
        if (call.name === "列出资料目录") {
            data = await listLocalDataDirectory({
                path: optionalStringArg(call.args, "path"),
                limit: Number(call.args.limit),
                offset: Number(call.args.offset),
            });
        } else if (call.name === "读取资料文件") {
            data = await readLocalDataFile({
                path: requiredStringArg(call.args, "path"),
                limit: Number(call.args.limit),
                offset: Number(call.args.offset),
                fields: stringArrayArg(call.args, "fields"),
                select: stringArrayArg(call.args, "select"),
            });
        } else if (call.name === "查看资料字段") {
            data = await inspectLocalDataFields({
                path: requiredStringArg(call.args, "path"),
                sample: Number(call.args.sample),
            });
        } else if (call.name === "搜索资料记录") {
            data = await searchLocalDataRecords({
                path: optionalStringArg(call.args, "path"),
                query: typeof call.args.query === "string" ? call.args.query : "",
                limit: Number(call.args.limit),
                offset: Number(call.args.offset),
                fields: stringArrayArg(call.args, "fields"),
                select: stringArrayArg(call.args, "select"),
            });
        } else {
            data = await readLocalDataRecord({
                path: requiredStringArg(call.args, "path"),
                key: requiredStringArg(call.args, "key"),
                fields: stringArrayArg(call.args, "fields"),
                select: stringArrayArg(call.args, "select"),
            });
        }

        return {
            name: call.name,
            success: true,
            data: stringifyLocalDataResult(data),
            userNotice: `${call.name}完成`,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            name: call.name,
            success: false,
            error: message,
            userNotice: `${call.name}失败：${message}`,
        };
    }
}

function objectStringMapArg(value: unknown, fieldName: string): Record<string, string> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${fieldName} 必须是对象`);
    const result: Record<string, string> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child === undefined || child === null) continue;
        result[key] = String(child);
    }
    return result;
}

function optionalBooleanArg(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function validateHttpEndpoint(endpoint: string): void {
    try {
        const url = new URL(endpoint);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
        throw new Error("endpoint 必须是有效的 http/https 地址");
    }
}

function validateJsonString(text: string, fieldName: string): void {
    try {
        JSON.parse(text);
    } catch {
        throw new Error(`${fieldName} 必须是合法 JSON 字符串`);
    }
}

function normalizeRestToolPatch(raw: Record<string, unknown>, existing?: RestToolConfig): Partial<RestToolConfig> {
    const patch: Partial<RestToolConfig> = {};

    if ("name" in raw) {
        const name = String(raw.name || "").trim();
        if (!name) throw new Error("工具名称不能为空");
        patch.name = name;
    }
    if ("description" in raw) patch.description = String(raw.description || "").trim();
    if ("endpoint" in raw) {
        const endpoint = String(raw.endpoint || "").trim();
        validateHttpEndpoint(endpoint);
        patch.endpoint = endpoint;
    }
    if ("method" in raw) {
        const method = String(raw.method || "").toUpperCase();
        if (method !== "GET" && method !== "POST") throw new Error("method 只能是 GET 或 POST");
        patch.method = method;
    }
    if ("headers" in raw) patch.headers = objectStringMapArg(raw.headers, "headers");
    if ("fixedParams" in raw) patch.fixedParams = objectStringMapArg(raw.fixedParams, "fixedParams");
    if ("bodyTemplate" in raw) {
        const bodyTemplate = String(raw.bodyTemplate || "").trim();
        if (bodyTemplate) validateJsonString(bodyTemplate, "bodyTemplate");
        patch.bodyTemplate = bodyTemplate;
    }
    if ("parameterSchema" in raw) {
        const parameterSchema = String(raw.parameterSchema || "").trim();
        if (!parameterSchema) throw new Error("parameterSchema 不能为空");
        validateJsonString(parameterSchema, "parameterSchema");
        patch.parameterSchema = parameterSchema;
    }
    if ("enabled" in raw) patch.enabled = optionalBooleanArg(raw.enabled) ?? Boolean(raw.enabled);
    if ("directFetch" in raw) patch.directFetch = optionalBooleanArg(raw.directFetch);

    const next = { ...existing, ...patch } as Partial<RestToolConfig>;
    if (!next.name?.trim()) throw new Error("工具名称不能为空");
    if (!next.endpoint?.trim()) throw new Error("endpoint 不能为空");
    validateHttpEndpoint(next.endpoint);
    if (next.method !== "GET" && next.method !== "POST") throw new Error("method 只能是 GET 或 POST");
    if (!next.parameterSchema?.trim()) throw new Error("parameterSchema 不能为空");
    validateJsonString(next.parameterSchema, "parameterSchema");
    if (next.bodyTemplate?.trim()) validateJsonString(next.bodyTemplate, "bodyTemplate");

    return patch;
}

function generateToolboxToolId(): string {
    return `tool_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function generateToolboxPackageId(): string {
    return `rest_pkg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function generateToolboxCompositeId(): string {
    return `composite_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function generateToolboxCompositePackageId(): string {
    return `composite_pkg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function findRestToolByIdOrName(tools: RestToolConfig[], args: Record<string, unknown>): RestToolConfig | undefined {
    const id = optionalStringArg(args, "id")?.trim();
    const name = optionalStringArg(args, "name")?.trim();
    if (id) return tools.find(tool => tool.id === id);
    if (name) return tools.find(tool => tool.name === name);
    return undefined;
}

function assertAiOwnedRestTool(tool: RestToolConfig | undefined): RestToolConfig {
    if (!tool) throw new Error("工具不存在");
    if (tool.builtIn || tool.createdBy !== "ai") throw new Error("只能修改 AI 自己创建的 REST 工具");
    return tool;
}

function findRestPackageByIdOrName(packages: RestToolPackageConfig[], args: Record<string, unknown>): RestToolPackageConfig | undefined {
    const id = optionalStringArg(args, "id")?.trim() || optionalStringArg(args, "packageId")?.trim();
    const name = optionalStringArg(args, "name")?.trim() || optionalStringArg(args, "packageName")?.trim();
    if (id) return packages.find(pkg => pkg.id === id);
    if (name) return packages.find(pkg => pkg.name === name);
    return undefined;
}

function assertAiOwnedRestPackage(pkg: RestToolPackageConfig | undefined): RestToolPackageConfig {
    if (!pkg) throw new Error("REST 套件不存在");
    if (pkg.builtIn || pkg.createdBy !== "ai") throw new Error("只能修改 AI 自己创建的 REST 套件");
    return pkg;
}

function resolveOptionalAiRestPackageId(args: Record<string, unknown>, packages: RestToolPackageConfig[]): string | undefined {
    const hasPackageId = "packageId" in args;
    const hasPackageName = "packageName" in args;
    const packageId = optionalStringArg(args, "packageId")?.trim();
    const packageName = optionalStringArg(args, "packageName")?.trim();
    if (!hasPackageId && !hasPackageName) return undefined;
    if (!packageId && !packageName) return undefined;
    return assertAiOwnedRestPackage(findRestPackageByIdOrName(packages, args)).id;
}

function summarizeRestTool(tool: RestToolConfig): string {
    return JSON.stringify({
        id: tool.id,
        packageId: tool.packageId,
        name: tool.name,
        description: tool.description,
        endpoint: tool.endpoint,
        method: tool.method,
        enabled: tool.enabled,
        directFetch: tool.directFetch ?? true,
        createdBy: tool.createdBy,
    }, null, 2);
}

function summarizeRestPackage(pkg: RestToolPackageConfig): string {
    return JSON.stringify({
        id: pkg.id,
        name: pkg.name,
        description: pkg.description,
        enabled: pkg.enabled,
        createdBy: pkg.createdBy,
    }, null, 2);
}

function normalizeRestPackagePatch(raw: Record<string, unknown>, existing?: RestToolPackageConfig): Partial<RestToolPackageConfig> {
    const patch: Partial<RestToolPackageConfig> = {};
    if ("name" in raw) {
        const name = String(raw.name || "").trim();
        if (!name) throw new Error("套件名称不能为空");
        patch.name = name;
    }
    if ("description" in raw) patch.description = String(raw.description || "").trim();
    if ("enabled" in raw) patch.enabled = optionalBooleanArg(raw.enabled) ?? Boolean(raw.enabled);
    const next = { ...existing, ...patch } as Partial<RestToolPackageConfig>;
    if (!next.name?.trim()) throw new Error("套件名称不能为空");
    return patch;
}

function findCompositeToolByIdOrName(tools: CompositeToolConfig[], args: Record<string, unknown>): CompositeToolConfig | undefined {
    const id = optionalStringArg(args, "id")?.trim();
    const name = optionalStringArg(args, "name")?.trim();
    if (id) return tools.find(tool => tool.id === id);
    if (name) return tools.find(tool => tool.name === name);
    return undefined;
}

function assertAiOwnedCompositeTool(tool: CompositeToolConfig | undefined): CompositeToolConfig {
    if (!tool) throw new Error("组合工具不存在");
    if (tool.builtIn || tool.createdBy !== "ai") throw new Error("只能修改 AI 自己创建的组合工具");
    return tool;
}

function findCompositePackageByIdOrName(packages: CompositeToolPackageConfig[], args: Record<string, unknown>): CompositeToolPackageConfig | undefined {
    const id = optionalStringArg(args, "id")?.trim() || optionalStringArg(args, "packageId")?.trim();
    const name = optionalStringArg(args, "name")?.trim() || optionalStringArg(args, "packageName")?.trim();
    if (id) return packages.find(pkg => pkg.id === id);
    if (name) return packages.find(pkg => pkg.name === name);
    return undefined;
}

function assertAiOwnedCompositePackage(pkg: CompositeToolPackageConfig | undefined): CompositeToolPackageConfig {
    if (!pkg) throw new Error("组合工具套件不存在");
    if (pkg.builtIn || pkg.createdBy !== "ai") throw new Error("只能修改 AI 自己创建的组合工具套件");
    return pkg;
}

function resolveOptionalAiCompositePackageId(args: Record<string, unknown>, packages: CompositeToolPackageConfig[]): string | undefined {
    const hasPackageId = "packageId" in args;
    const hasPackageName = "packageName" in args;
    const packageId = optionalStringArg(args, "packageId")?.trim();
    const packageName = optionalStringArg(args, "packageName")?.trim();
    if (!hasPackageId && !hasPackageName) return undefined;
    if (!packageId && !packageName) return undefined;
    return assertAiOwnedCompositePackage(findCompositePackageByIdOrName(packages, args)).id;
}

function normalizeCompositeStep(raw: unknown, index: number): CompositeToolStep {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`steps[${index}] 必须是对象`);
    const item = raw as Record<string, unknown>;
    const rawToolType = String(item.toolType || "auto").trim();
    const toolType = ["auto", "rest", "internal", "mcp", "composite", "script"].includes(rawToolType)
        ? rawToolType as CompositeToolStep["toolType"]
        : "auto";
    const toolName = String(item.toolName || item.name || "").trim();
    if (toolType !== "script" && !toolName) throw new Error(`steps[${index}].toolName 不能为空`);
    let argsTemplate: string | undefined;
    if ("argsTemplate" in item) {
        if (typeof item.argsTemplate === "string") {
            argsTemplate = item.argsTemplate.trim();
        } else if (item.argsTemplate && typeof item.argsTemplate === "object" && !Array.isArray(item.argsTemplate)) {
            argsTemplate = JSON.stringify(item.argsTemplate);
        } else {
            throw new Error(`steps[${index}].argsTemplate 必须是对象或 JSON 字符串`);
        }
        if (argsTemplate) validateJsonString(argsTemplate, `steps[${index}].argsTemplate`);
    }
    return {
        id: String(item.id || `step_${index + 1}`).trim(),
        name: typeof item.name === "string" ? item.name.trim() : undefined,
        toolType,
        toolId: optionalStringArg(item, "toolId")?.trim(),
        serverId: optionalStringArg(item, "serverId")?.trim(),
        toolName: toolName || undefined,
        argsTemplate: argsTemplate || "{}",
        script: optionalStringArg(item, "script"),
        saveAs: optionalStringArg(item, "saveAs")?.trim() || `step${index + 1}`,
    };
}

function normalizeCompositeSteps(value: unknown): CompositeToolStep[] {
    if (!Array.isArray(value)) throw new Error("steps 必须是数组");
    return value.map((item, index) => normalizeCompositeStep(item, index));
}

function normalizeCompositeToolPatch(raw: Record<string, unknown>, existing?: CompositeToolConfig): Partial<CompositeToolConfig> {
    const patch: Partial<CompositeToolConfig> = {};
    if ("name" in raw) {
        const name = String(raw.name || "").trim();
        if (!name) throw new Error("组合工具名称不能为空");
        patch.name = name;
    }
    if ("description" in raw) patch.description = String(raw.description || "").trim();
    if ("parameterSchema" in raw) {
        const parameterSchema = String(raw.parameterSchema || "").trim();
        if (!parameterSchema) throw new Error("parameterSchema 不能为空");
        validateJsonString(parameterSchema, "parameterSchema");
        patch.parameterSchema = parameterSchema;
    }
    if ("steps" in raw) patch.steps = normalizeCompositeSteps(raw.steps);
    if ("outputTemplate" in raw) patch.outputTemplate = String(raw.outputTemplate || "");
    if ("enabled" in raw) patch.enabled = optionalBooleanArg(raw.enabled) ?? Boolean(raw.enabled);

    const next = { ...existing, ...patch } as Partial<CompositeToolConfig>;
    if (!next.name?.trim()) throw new Error("组合工具名称不能为空");
    if (!next.parameterSchema?.trim()) throw new Error("parameterSchema 不能为空");
    validateJsonString(next.parameterSchema, "parameterSchema");
    if (!Array.isArray(next.steps)) throw new Error("steps 必须是数组");
    return patch;
}

function normalizeCompositePackagePatch(raw: Record<string, unknown>, existing?: CompositeToolPackageConfig): Partial<CompositeToolPackageConfig> {
    const patch: Partial<CompositeToolPackageConfig> = {};
    if ("name" in raw) {
        const name = String(raw.name || "").trim();
        if (!name) throw new Error("组合工具套件名称不能为空");
        patch.name = name;
    }
    if ("description" in raw) patch.description = String(raw.description || "").trim();
    if ("enabled" in raw) patch.enabled = optionalBooleanArg(raw.enabled) ?? Boolean(raw.enabled);
    const next = { ...existing, ...patch } as Partial<CompositeToolPackageConfig>;
    if (!next.name?.trim()) throw new Error("组合工具套件名称不能为空");
    return patch;
}

function summarizeCompositeTool(tool: CompositeToolConfig): string {
    return JSON.stringify({
        id: tool.id,
        packageId: tool.packageId,
        name: tool.name,
        description: tool.description,
        steps: tool.steps,
        enabled: tool.enabled,
        createdBy: tool.createdBy,
    }, null, 2);
}

function summarizeCompositePackage(pkg: CompositeToolPackageConfig): string {
    return JSON.stringify({
        id: pkg.id,
        name: pkg.name,
        description: pkg.description,
        enabled: pkg.enabled,
        createdBy: pkg.createdBy,
    }, null, 2);
}

async function executeToolboxManagementTool(call: ToolCall): Promise<ToolResult> {
    const capability = getInternalCapability(TOOLBOX_MANAGEMENT_CAPABILITY_ID);
    if (!capability || !capability.enabled || capability.mode === "off") {
        return {
            name: call.name,
            success: false,
            error: "工具箱管理能力未启用",
            userNotice: "工具箱管理能力未启用",
        };
    }

    try {
        const tools = loadRestTools();
        const packages = loadRestToolPackages();
        const compositeTools = loadCompositeTools();
        const compositePackages = loadCompositeToolPackages();
        const now = Date.now();

        if (call.name === "添加组合工具套件") {
            const patch = normalizeCompositePackagePatch(call.args);
            if (compositePackages.some(pkg => pkg.name === patch.name)) throw new Error(`已存在同名组合工具套件：${patch.name}`);
            const nextPackage: CompositeToolPackageConfig = {
                id: generateToolboxCompositePackageId(),
                name: patch.name!,
                description: patch.description || "",
                enabled: patch.enabled ?? true,
                createdBy: "ai",
                createdAt: now,
                updatedAt: now,
            };
            saveCompositeToolPackages([nextPackage, ...compositePackages]);
            return {
                name: call.name,
                success: true,
                data: `已添加 AI 组合工具套件：\n${summarizeCompositePackage(nextPackage)}`,
                userNotice: `已添加组合套件：${nextPackage.name}`,
            };
        }

        if (call.name === "更新组合工具套件") {
            const target = assertAiOwnedCompositePackage(findCompositePackageByIdOrName(compositePackages, call.args));
            const rawUpdates = call.args.updates;
            if (!rawUpdates || typeof rawUpdates !== "object" || Array.isArray(rawUpdates)) throw new Error("updates 必须是对象");
            const patch = normalizeCompositePackagePatch(rawUpdates as Record<string, unknown>, target);
            if (patch.name && compositePackages.some(pkg => pkg.id !== target.id && pkg.name === patch.name)) {
                throw new Error(`已存在同名组合工具套件：${patch.name}`);
            }
            const updated: CompositeToolPackageConfig = { ...target, ...patch, createdBy: "ai", updatedAt: now };
            saveCompositeToolPackages(compositePackages.map(pkg => pkg.id === target.id ? updated : pkg));
            return {
                name: call.name,
                success: true,
                data: `已更新 AI 组合工具套件：\n${summarizeCompositePackage(updated)}`,
                userNotice: `已更新组合套件：${updated.name}`,
            };
        }

        if (call.name === "设置组合工具套件启用") {
            const target = assertAiOwnedCompositePackage(findCompositePackageByIdOrName(compositePackages, call.args));
            const enabled = optionalBooleanArg(call.args.enabled);
            if (enabled === undefined) throw new Error("enabled 必须是 boolean");
            const updated: CompositeToolPackageConfig = { ...target, enabled, updatedAt: now };
            saveCompositeToolPackages(compositePackages.map(pkg => pkg.id === target.id ? updated : pkg));
            return {
                name: call.name,
                success: true,
                data: `已${enabled ? "启用" : "停用"} AI 组合工具套件：\n${summarizeCompositePackage(updated)}`,
                userNotice: `已${enabled ? "启用" : "停用"}组合套件：${updated.name}`,
            };
        }

        if (call.name === "删除组合工具套件") {
            const target = assertAiOwnedCompositePackage(findCompositePackageByIdOrName(compositePackages, call.args));
            const childTools = compositeTools.filter(tool => tool.packageId === target.id);
            const lockedChild = childTools.find(tool => tool.builtIn || tool.createdBy !== "ai");
            if (lockedChild) throw new Error(`套件中包含非 AI 组合工具，不能删除：${lockedChild.name}`);
            saveCompositeToolPackages(compositePackages.filter(pkg => pkg.id !== target.id));
            saveCompositeTools(compositeTools.filter(tool => tool.packageId !== target.id));
            return {
                name: call.name,
                success: true,
                data: `已删除 AI 组合工具套件：${target.name} (${target.id})，同时删除 ${childTools.length} 个组合工具。`,
                userNotice: `已删除组合套件：${target.name}`,
            };
        }

        if (call.name === "添加组合工具") {
            const packageId = resolveOptionalAiCompositePackageId(call.args, compositePackages);
            const patch = normalizeCompositeToolPatch(call.args);
            if (compositeTools.some(tool => tool.name === patch.name)) throw new Error(`已存在同名组合工具：${patch.name}`);
            const nextTool: CompositeToolConfig = {
                id: generateToolboxCompositeId(),
                packageId,
                name: patch.name!,
                description: patch.description || "",
                parameterSchema: patch.parameterSchema!,
                steps: patch.steps || [],
                outputTemplate: patch.outputTemplate || "",
                enabled: patch.enabled ?? true,
                createdBy: "ai",
                createdAt: now,
                updatedAt: now,
            };
            saveCompositeTools([nextTool, ...compositeTools]);
            return {
                name: call.name,
                success: true,
                data: `已添加 AI 组合工具：\n${summarizeCompositeTool(nextTool)}`,
                userNotice: `已添加组合工具：${nextTool.name}`,
            };
        }

        if (call.name === "更新组合工具") {
            const target = assertAiOwnedCompositeTool(findCompositeToolByIdOrName(compositeTools, call.args));
            const rawUpdates = call.args.updates;
            if (!rawUpdates || typeof rawUpdates !== "object" || Array.isArray(rawUpdates)) throw new Error("updates 必须是对象");
            const patch = normalizeCompositeToolPatch(rawUpdates as Record<string, unknown>, target);
            if ("packageId" in rawUpdates || "packageName" in rawUpdates) {
                patch.packageId = resolveOptionalAiCompositePackageId(rawUpdates as Record<string, unknown>, compositePackages);
            }
            if (patch.name && compositeTools.some(tool => tool.id !== target.id && tool.name === patch.name)) {
                throw new Error(`已存在同名组合工具：${patch.name}`);
            }
            const updated: CompositeToolConfig = { ...target, ...patch, createdBy: "ai", updatedAt: now };
            saveCompositeTools(compositeTools.map(tool => tool.id === target.id ? updated : tool));
            return {
                name: call.name,
                success: true,
                data: `已更新 AI 组合工具：\n${summarizeCompositeTool(updated)}`,
                userNotice: `已更新组合工具：${updated.name}`,
            };
        }

        if (call.name === "设置组合工具启用") {
            const target = assertAiOwnedCompositeTool(findCompositeToolByIdOrName(compositeTools, call.args));
            const enabled = optionalBooleanArg(call.args.enabled);
            if (enabled === undefined) throw new Error("enabled 必须是 boolean");
            const updated: CompositeToolConfig = { ...target, enabled, updatedAt: now };
            saveCompositeTools(compositeTools.map(tool => tool.id === target.id ? updated : tool));
            return {
                name: call.name,
                success: true,
                data: `已${enabled ? "启用" : "停用"} AI 组合工具：\n${summarizeCompositeTool(updated)}`,
                userNotice: `已${enabled ? "启用" : "停用"}组合工具：${updated.name}`,
            };
        }

        if (call.name === "删除组合工具") {
            const target = assertAiOwnedCompositeTool(findCompositeToolByIdOrName(compositeTools, call.args));
            saveCompositeTools(compositeTools.filter(tool => tool.id !== target.id));
            return {
                name: call.name,
                success: true,
                data: `已删除 AI 组合工具：${target.name} (${target.id})`,
                userNotice: `已删除组合工具：${target.name}`,
            };
        }

        if (call.name === "添加REST套件") {
            const patch = normalizeRestPackagePatch(call.args);
            if (packages.some(pkg => pkg.name === patch.name)) throw new Error(`已存在同名 REST 套件：${patch.name}`);
            const nextPackage: RestToolPackageConfig = {
                id: generateToolboxPackageId(),
                name: patch.name!,
                description: patch.description || "",
                enabled: patch.enabled ?? true,
                createdBy: "ai",
                createdAt: now,
                updatedAt: now,
            };
            saveRestToolPackages([nextPackage, ...packages]);
            return {
                name: call.name,
                success: true,
                data: `已添加 AI REST 套件：\n${summarizeRestPackage(nextPackage)}`,
                userNotice: `已添加套件：${nextPackage.name}`,
            };
        }

        if (call.name === "更新REST套件") {
            const target = assertAiOwnedRestPackage(findRestPackageByIdOrName(packages, call.args));
            const rawUpdates = call.args.updates;
            if (!rawUpdates || typeof rawUpdates !== "object" || Array.isArray(rawUpdates)) throw new Error("updates 必须是对象");
            const patch = normalizeRestPackagePatch(rawUpdates as Record<string, unknown>, target);
            if (patch.name && packages.some(pkg => pkg.id !== target.id && pkg.name === patch.name)) {
                throw new Error(`已存在同名 REST 套件：${patch.name}`);
            }
            const updated: RestToolPackageConfig = { ...target, ...patch, createdBy: "ai", updatedAt: now };
            saveRestToolPackages(packages.map(pkg => pkg.id === target.id ? updated : pkg));
            return {
                name: call.name,
                success: true,
                data: `已更新 AI REST 套件：\n${summarizeRestPackage(updated)}`,
                userNotice: `已更新套件：${updated.name}`,
            };
        }

        if (call.name === "设置REST套件启用") {
            const target = assertAiOwnedRestPackage(findRestPackageByIdOrName(packages, call.args));
            const enabled = optionalBooleanArg(call.args.enabled);
            if (enabled === undefined) throw new Error("enabled 必须是 boolean");
            const updated: RestToolPackageConfig = { ...target, enabled, updatedAt: now };
            saveRestToolPackages(packages.map(pkg => pkg.id === target.id ? updated : pkg));
            return {
                name: call.name,
                success: true,
                data: `已${enabled ? "启用" : "停用"} AI REST 套件：\n${summarizeRestPackage(updated)}`,
                userNotice: `已${enabled ? "启用" : "停用"}套件：${updated.name}`,
            };
        }

        if (call.name === "删除REST套件") {
            const target = assertAiOwnedRestPackage(findRestPackageByIdOrName(packages, call.args));
            const childTools = tools.filter(tool => tool.packageId === target.id);
            const lockedChild = childTools.find(tool => tool.builtIn || tool.createdBy !== "ai");
            if (lockedChild) throw new Error(`套件中包含非 AI 工具，不能删除：${lockedChild.name}`);
            saveRestToolPackages(packages.filter(pkg => pkg.id !== target.id));
            saveRestTools(tools.filter(tool => tool.packageId !== target.id));
            return {
                name: call.name,
                success: true,
                data: `已删除 AI REST 套件：${target.name} (${target.id})，同时删除 ${childTools.length} 个子工具。`,
                userNotice: `已删除套件：${target.name}`,
            };
        }

        if (call.name === "添加REST工具") {
            const packageId = resolveOptionalAiRestPackageId(call.args, packages);
            const patch = normalizeRestToolPatch(call.args);
            if (tools.some(tool => tool.name === patch.name)) throw new Error(`已存在同名工具：${patch.name}`);
            const nextTool: RestToolConfig = {
                id: generateToolboxToolId(),
                packageId,
                name: patch.name!,
                description: patch.description || "",
                endpoint: patch.endpoint!,
                method: patch.method || "GET",
                headers: patch.headers,
                bodyTemplate: patch.bodyTemplate,
                parameterSchema: patch.parameterSchema!,
                fixedParams: patch.fixedParams,
                enabled: patch.enabled ?? true,
                directFetch: patch.directFetch ?? true,
                createdBy: "ai",
                createdAt: now,
                updatedAt: now,
            };
            saveRestTools([nextTool, ...tools]);
            return {
                name: call.name,
                success: true,
                data: `已添加 AI REST 工具：\n${summarizeRestTool(nextTool)}`,
                userNotice: `已添加工具：${nextTool.name}`,
            };
        }

        if (call.name === "更新REST工具") {
            const target = assertAiOwnedRestTool(findRestToolByIdOrName(tools, call.args));
            const rawUpdates = call.args.updates;
            if (!rawUpdates || typeof rawUpdates !== "object" || Array.isArray(rawUpdates)) throw new Error("updates 必须是对象");
            const patch = normalizeRestToolPatch(rawUpdates as Record<string, unknown>, target);
            if ("packageId" in rawUpdates || "packageName" in rawUpdates) {
                patch.packageId = resolveOptionalAiRestPackageId(rawUpdates as Record<string, unknown>, packages);
            }
            if (patch.name && tools.some(tool => tool.id !== target.id && tool.name === patch.name)) {
                throw new Error(`已存在同名工具：${patch.name}`);
            }
            const updated: RestToolConfig = { ...target, ...patch, createdBy: "ai", updatedAt: now };
            saveRestTools(tools.map(tool => tool.id === target.id ? updated : tool));
            return {
                name: call.name,
                success: true,
                data: `已更新 AI REST 工具：\n${summarizeRestTool(updated)}`,
                userNotice: `已更新工具：${updated.name}`,
            };
        }

        if (call.name === "设置REST工具启用") {
            const target = assertAiOwnedRestTool(findRestToolByIdOrName(tools, call.args));
            const enabled = optionalBooleanArg(call.args.enabled);
            if (enabled === undefined) throw new Error("enabled 必须是 boolean");
            const updated: RestToolConfig = { ...target, enabled, updatedAt: now };
            saveRestTools(tools.map(tool => tool.id === target.id ? updated : tool));
            return {
                name: call.name,
                success: true,
                data: `已${enabled ? "启用" : "停用"} AI REST 工具：\n${summarizeRestTool(updated)}`,
                userNotice: `已${enabled ? "启用" : "停用"}工具：${updated.name}`,
            };
        }

        const target = assertAiOwnedRestTool(findRestToolByIdOrName(tools, call.args));
        saveRestTools(tools.filter(tool => tool.id !== target.id));
        return {
            name: call.name,
            success: true,
            data: `已删除 AI REST 工具：${target.name} (${target.id})`,
            userNotice: `已删除工具：${target.name}`,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            name: call.name,
            success: false,
            error: message,
            userNotice: `${call.name}失败：${message}`,
        };
    }
}

async function executeNoteWallTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const capability = getInternalCapability(NOTE_WALL_CAPABILITY_ID);
    if (!capability || !capability.enabled || capability.mode === "off") {
        return {
            name: call.name,
            success: false,
            error: "便签墙能力未启用",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "便签墙能力未启用",
        };
    }

    if (!isSupportedChatToolContext(context)) {
        return {
            name: call.name,
            success: false,
            error: "当前场景暂不支持便签墙动作",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "当前场景暂不支持便签墙动作",
        };
    }

    try {
        switch (call.name) {
            case "查看便签列表":
                return await executeNoteWallListTool(call.args);
            case "查看便签详情及评论":
                return await executeNoteWallDetailTool(call.args);
            case "发送便签":
                return await executeNoteWallCreateNoteTool(call.args, context.characterId);
            case "发送便签评论":
                return await executeNoteWallCreateCommentTool(call.args, context.characterId);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            name: call.name,
            success: false,
            error: message,
            continueConversation: false,
            persistToHistory: false,
            userNotice: `${call.name}失败：${message}`,
        };
    }

    return {
        name: call.name,
        success: false,
        error: "未知便签墙动作",
        continueConversation: false,
        persistToHistory: false,
        userNotice: "未知便签墙动作",
    };
}

async function executeMusicControlTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const capability = getInternalCapability(MUSIC_CONTROL_CAPABILITY_ID);
    if (!capability || !capability.enabled || capability.mode === "off") {
        return {
            name: call.name,
            success: false,
            error: "网易云音乐能力未启用",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "网易云音乐能力未启用",
        };
    }

    if (context?.appId !== "chat" && context?.appId !== "group_chat") {
        return {
            name: call.name,
            success: false,
            error: "当前场景暂不支持网易云音乐动作",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "当前场景暂不支持网易云音乐动作",
        };
    }

    try {
        switch (call.name) {
            case "查看音乐状态":
                return executeMusicStatusTool(call.name);
            case "查看音乐库概览":
                return await executeMusicOverviewTool(call.args);
            case "查看歌单歌曲":
                return await executeMusicPlaylistTracksTool(call.args);
            case "搜索音乐":
                return await executeMusicSearchTool(call.args);
            case "播放音乐":
                return await executeMusicPlayTool(call.args);
            case "加入播放列表":
                return await executeMusicQueueTool(call.args);
            case "切换音乐":
                return executeMusicSwitchTool(call.args);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            name: call.name,
            success: false,
            error: message,
            continueConversation: false,
            persistToHistory: false,
            userNotice: `${call.name}失败：${message}`,
        };
    }

    return {
        name: call.name,
        success: false,
        error: "未知网易云音乐动作",
        continueConversation: false,
        persistToHistory: false,
        userNotice: "未知网易云音乐动作",
    };
}

async function executeCalendarTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const capability = getInternalCapability(CALENDAR_MANAGEMENT_CAPABILITY_ID);
    if (!capability || !capability.enabled || capability.mode === "off") {
        return {
            name: call.name,
            success: false,
            error: "日历管理能力未启用",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "日历管理能力未启用",
        };
    }

    if (!isSupportedChatToolContext(context)) {
        return {
            name: call.name,
            success: false,
            error: "当前场景暂不支持日历管理动作",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "当前场景暂不支持日历管理动作",
        };
    }

    try {
        switch (call.name) {
            case "查看日程":
                return executeCalendarListTool(call.args, context.characterId);
            case "添加日程":
                return executeCalendarAddTool(call.args, context.characterId);
            case "修改日程":
                return executeCalendarUpdateTool(call.args, context.characterId);
            case "取消日程":
                return executeCalendarDeleteTool(call.args, context.characterId);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            name: call.name,
            success: false,
            error: message,
            continueConversation: false,
            persistToHistory: false,
            userNotice: `${call.name}失败：${message}`,
        };
    }

    return {
        name: call.name,
        success: false,
        error: "未知日历管理动作",
        continueConversation: false,
        persistToHistory: false,
        userNotice: "未知日历管理动作",
    };
}

function executeCalendarListTool(args: Record<string, unknown>, characterId: string): ToolResult {
    const date = normalizeCalendarDate(args.date ?? args.weekDate ?? args.week_date, { fallbackToToday: true });
    if (!date) return calendarToolFailure("查看日程", "日期格式无效，请使用 YYYY-MM-DD", "日期格式无效");
    const weekStart = getWeekStartIso(parseIsoDate(date));
    const plan = loadCalendarWeekPlan("character", characterId, weekStart);
    return {
        name: "查看日程",
        success: true,
        data: truncate(JSON.stringify({
            ownerType: "character",
            ownerId: characterId,
            weekStart,
            dates: getWeekDates(weekStart),
            items: sortScheduleItems(plan?.items ?? []).map(formatCalendarItemForTool),
        })),
        continueConversation: true,
        persistToHistory: true,
        userNotice: "已查看日程",
    };
}

function executeCalendarAddTool(args: Record<string, unknown>, characterId: string): ToolResult {
    const parsed = parseCalendarDraft(args);
    if (!parsed.ok) return calendarToolFailure("添加日程", parsed.error, parsed.notice);

    const weekStart = getWeekStartIso(parseIsoDate(parsed.item.date));
    const plan = upsertCalendarScheduleItem("character", characterId, weekStart, parsed.item);
    const saved = plan.items.find(item => item.title === parsed.item.title && item.date === parsed.item.date && item.startTime === parsed.item.startTime);
    dispatchCalendarUpdated();
    return {
        name: "添加日程",
        success: true,
        data: `日程添加成功：${formatCalendarItemSummary(saved ?? parsed.item)}`,
        continueConversation: false,
        persistToHistory: false,
        userNotice: "已添加日程",
    };
}

function executeCalendarUpdateTool(args: Record<string, unknown>, characterId: string): ToolResult {
    const found = findCalendarItemByArgs(args, "character", characterId);
    if (!found) return calendarToolFailure("修改日程", "未找到匹配的日程", "未找到要修改的日程");

    const parsed = parseCalendarDraft(args);
    if (!parsed.ok) return calendarToolFailure("修改日程", parsed.error, parsed.notice);

    const nextWeekStart = getWeekStartIso(parseIsoDate(parsed.item.date));
    if (found.weekStart !== nextWeekStart) {
        deleteCalendarScheduleItem("character", characterId, found.weekStart, found.item.id);
    }
    upsertCalendarScheduleItem("character", characterId, nextWeekStart, {
        ...parsed.item,
        id: found.item.id,
        createdAt: found.item.createdAt,
    });
    dispatchCalendarUpdated();
    return {
        name: "修改日程",
        success: true,
        data: `日程修改成功：${formatCalendarItemSummary(parsed.item)}`,
        continueConversation: false,
        persistToHistory: false,
        userNotice: "已修改日程",
    };
}

function executeCalendarDeleteTool(args: Record<string, unknown>, characterId: string): ToolResult {
    const found = findCalendarItemByArgs(args, "character", characterId);
    if (!found) return calendarToolFailure("取消日程", "未找到匹配的日程", "未找到要取消的日程");

    deleteCalendarScheduleItem("character", characterId, found.weekStart, found.item.id);
    dispatchCalendarUpdated();
    return {
        name: "取消日程",
        success: true,
        data: `日程已取消：${formatCalendarItemSummary(found.item)}`,
        continueConversation: false,
        persistToHistory: false,
        userNotice: "已取消日程",
    };
}

type CalendarDraftParseResult =
    | { ok: true; item: Omit<CalendarScheduleItem, "id" | "weekday" | "colorKey" | "createdAt" | "updatedAt"> }
    | { ok: false; error: string; notice: string };

function parseCalendarDraft(args: Record<string, unknown>): CalendarDraftParseResult {
    const date = normalizeCalendarDate(args.date, { fallbackToToday: false });
    if (!date) return { ok: false, error: "缺少有效日期，请使用 YYYY-MM-DD", notice: "日期格式无效" };

    const startTime = normalizeTime(cleanToolString(args.startTime ?? args.start_time ?? args.start, 16));
    const endTime = normalizeTime(cleanToolString(args.endTime ?? args.end_time ?? args.end, 16));
    if (!startTime || !endTime || !isCalendarTimeRangeAllowed(startTime, endTime)) {
        return { ok: false, error: "时间无效，需使用 HH:MM 且开始时间早于结束时间", notice: "日程时间无效" };
    }

    const title = cleanToolString(args.title ?? args.task ?? args.content, 120);
    if (!title) return { ok: false, error: "缺少 title 参数", notice: "日程事项为空" };

    const location = cleanToolString(args.location ?? args.place, 80) || "无";
    const emoji = sanitizeScheduleEmoji(cleanToolString(args.emoji ?? args.icon, 16));
    return {
        ok: true,
        item: {
            date,
            startTime,
            endTime,
            location,
            title,
            emoji,
            source: "generated",
        },
    };
}

function normalizeCalendarDate(value: unknown, options?: { fallbackToToday?: boolean }): string | null {
    const rawInput = cleanToolString(value, 24);
    const raw = rawInput || (options?.fallbackToToday ? formatIsoDate(new Date()) : "");
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const date = parseIsoDate(raw);
    if (Number.isNaN(date.getTime())) return null;
    return formatIsoDate(date) === raw ? raw : null;
}

function findCalendarItemByArgs(
    args: Record<string, unknown>,
    ownerType: CalendarOwnerType,
    ownerId: string,
): { weekStart: string; item: CalendarScheduleItem } | null {
    const itemId = cleanToolString(args.itemId ?? args.item_id ?? args.id, 120);
    const keyword = cleanToolString(args.keyword ?? args.query ?? args.title, 120);
    const date = normalizeCalendarDate(args.date, { fallbackToToday: false });

    if (itemId) {
        for (const plan of loadOwnerCalendarPlans(ownerType, ownerId)) {
            const found = plan.items.find(item => item.id === itemId);
            if (found) return { weekStart: plan.weekStart, item: found };
        }
    }

    if (!keyword) return null;
    for (const weekStart of getCalendarSearchWeekStarts(date)) {
        const plan = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
        if (!plan) continue;
        const found = plan.items.find(item => calendarKeywordMatch(keyword, item.title, item.location));
        if (found) return { weekStart, item: found };
    }
    return null;
}

function getCalendarSearchWeekStarts(dateHint: string | null): string[] {
    const starts = new Set<string>();
    if (dateHint) starts.add(getWeekStartIso(parseIsoDate(dateHint)));
    const now = new Date();
    for (let offset = -4; offset <= 4; offset++) {
        const d = new Date(now);
        d.setDate(d.getDate() + offset * 7);
        starts.add(getWeekStartIso(d));
    }
    return [...starts];
}

function calendarKeywordMatch(keyword: string, title: string, location?: string): boolean {
    const kw = keyword.replace(/\s+/g, "");
    const t = title.replace(/\s+/g, "");
    if (!kw || !t) return false;
    if (t.includes(kw) || kw.includes(t)) return true;
    if (location && location !== "无") {
        const loc = location.replace(/\s+/g, "");
        const combined1 = loc + t;
        const combined2 = t + loc;
        if (kw.includes(combined1) || combined1.includes(kw)) return true;
        if (kw.includes(combined2) || combined2.includes(kw)) return true;
    }
    return false;
}

function formatCalendarItemForTool(item: CalendarScheduleItem): Record<string, unknown> {
    return {
        itemId: item.id,
        date: item.date,
        weekday: item.weekday || getWeekdayLabel(item.date),
        startTime: item.startTime,
        endTime: item.endTime,
        location: item.location,
        title: item.title,
        emoji: item.emoji || "",
        source: item.source,
    };
}

function formatCalendarItemSummary(item: Pick<CalendarScheduleItem, "date" | "startTime" | "endTime" | "location" | "title">): string {
    return `${item.date} ${item.startTime}-${item.endTime} @${item.location || "无"} ${item.title}`;
}

function calendarToolFailure(name: string, error: string, userNotice: string): ToolResult {
    return {
        name,
        success: false,
        error,
        continueConversation: false,
        persistToHistory: false,
        userNotice,
    };
}

function dispatchCalendarUpdated(): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("calendar-updated"));
    }
}

// ── Send File Tool ───────────────────────────────

async function executeSendFileTool(call: ToolCall): Promise<ToolResult> {
    const capability = getInternalCapability(SEND_FILE_CAPABILITY_ID);
    if (!capability || !capability.enabled || capability.mode === "off") {
        return { name: call.name, success: false, error: "发送文件能力未启用", continueConversation: false, persistToHistory: false };
    }

    const args = call.args || {};
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    const fileType = typeof args.type === "string" ? args.type : "";
    const title = typeof args.title === "string" ? args.title.trim() : "";

    if (!rawUrl) {
        return { name: call.name, success: false, error: "缺少文件 URL", continueConversation: false };
    }

    const validTypes = ["audio", "image", "video", "file"] as const;
    const resolvedType = validTypes.includes(fileType as typeof validTypes[number])
        ? (fileType as typeof validTypes[number])
        : inferMediaAttachmentType(rawUrl, title);

    let finalUrl = rawUrl;

    if (/^https?:\/\//.test(rawUrl)) {
        try {
            const res = await proxyFetch(rawUrl, { method: "GET" });
            if (res.status >= 200 && res.status < 300) {
                let blob: Blob;
                try {
                    const parsed = JSON.parse(res.text);
                    if (parsed._binary && parsed.data) {
                        const raw = Uint8Array.from(atob(parsed.data), c => c.charCodeAt(0));
                        blob = new Blob([raw], { type: parsed.contentType || "application/octet-stream" });
                    } else {
                        blob = new Blob([res.text], { type: "application/octet-stream" });
                    }
                } catch {
                    blob = new Blob([res.text], { type: "application/octet-stream" });
                }
                finalUrl = await storeMediaBlob(blob, blob.type, resolvedType);
            }
        } catch { /* proxy failed — fall back to raw URL */ }
    }

    return {
        name: call.name,
        success: true,
        data: `文件已发送：${title || rawUrl}`,
        continueConversation: true,
        persistToHistory: false,
        mediaAttachments: [{ type: resolvedType, url: finalUrl, title: title || undefined }],
    };
}

function inferMediaAttachmentType(url: string, title: string): MediaAttachment["type"] {
    const source = `${title} ${url.split(/[?#]/)[0]}`.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(source)) return "image";
    if (/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(source)) return "audio";
    if (/\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(source)) return "video";
    return "file";
}

function musicToolSuccess(name: string, data: unknown, options?: { continueConversation?: boolean; userNotice?: string; persistToHistory?: boolean }): ToolResult {
    return {
        name,
        success: true,
        data: truncate(typeof data === "string" ? data : JSON.stringify(data, null, 2)),
        continueConversation: options?.continueConversation ?? true,
        persistToHistory: options?.persistToHistory ?? true,
        ...(options?.userNotice ? { userNotice: options.userNotice } : {}),
    };
}

function getMusicBridgeResult(toolName: string) {
    const bridge = getMusicControlBridge();
    if (!bridge) {
        return {
            result: {
                name: toolName,
                success: false,
                error: "音乐播放器未就绪",
                continueConversation: false,
                persistToHistory: false,
                userNotice: "音乐播放器未就绪",
            } as ToolResult,
            bridge: null,
        };
    }
    return { result: null, bridge };
}

function executeMusicStatusTool(toolName: string): ToolResult {
    const { result, bridge } = getMusicBridgeResult(toolName);
    if (result || !bridge) return result!;
    const state = bridge.getState();
    return musicToolSuccess(toolName, {
        currentTrack: state.currentTrack ? formatMusicTrackForTool(state.currentTrack) : null,
        isPlaying: state.isPlaying,
        playMode: state.playMode,
        currentTime: Math.round(state.currentTime),
        duration: Math.round(state.duration),
        queue: state.queue.slice(0, 30).map(formatMusicTrackForTool),
        queueCount: state.queue.length,
    });
}

async function executeMusicOverviewTool(args: Record<string, unknown>): Promise<ToolResult> {
    const playlistLimit = clampToolInteger(args.playlistLimit ?? args.playlist_limit, 1, 30, 12);
    const localLimit = clampToolInteger(args.localLimit ?? args.local_limit, 1, 50, 20);
    const [localTracks, playlists, recentTracks, login] = await Promise.all([
        loadAllTracks().catch(() => []),
        isNeteaseConfigured() ? getUserPlaylists().catch(() => []) : Promise.resolve([]),
        isNeteaseConfigured() ? getUserRecord(1).catch(() => []) : Promise.resolve([]),
        getMusicLoginSummary(),
    ]);

    return musicToolSuccess("查看音乐库概览", {
        netease: login,
        localTracks: localTracks.slice(0, localLimit).map(formatMusicTrackForTool),
        localTrackCount: localTracks.length,
        playlists: playlists.slice(0, playlistLimit).map(playlist => ({
            playlistId: playlist.id,
            name: playlist.name,
            trackCount: playlist.trackCount,
            creator: playlist.creator,
        })),
        playlistCount: playlists.length,
        recentTracks: recentTracks.slice(0, 15).map(formatNeteaseTrackForTool),
    });
}

async function executeMusicPlaylistTracksTool(args: Record<string, unknown>): Promise<ToolResult> {
    const playlistId = Number(args.playlistId ?? args.playlist_id ?? args.id);
    if (!Number.isFinite(playlistId) || playlistId <= 0) {
        return { name: "查看歌单歌曲", success: false, error: "缺少有效 playlistId" };
    }
    const offset = clampToolInteger(args.offset, 0, 10000, 0);
    const limit = clampToolInteger(args.limit, 1, 50, 30);
    const tracks = await getPlaylistTracks(playlistId);
    return musicToolSuccess("查看歌单歌曲", {
        playlistId,
        offset,
        limit,
        total: tracks.length,
        tracks: tracks.slice(offset, offset + limit).map(formatNeteaseTrackForTool),
    });
}

async function executeMusicSearchTool(args: Record<string, unknown>): Promise<ToolResult> {
    const query = cleanToolString(args.query ?? args.keyword ?? args.q, 120);
    if (!query) return { name: "搜索音乐", success: false, error: "缺少搜索关键词 query" };
    const limit = clampToolInteger(args.limit, 1, 20, 10);
    const results = await unifiedSearch(query);
    return musicToolSuccess("搜索音乐", {
        query,
        results: results.slice(0, limit).map(result => ({
            source: result.source,
            songId: result.source === "local" ? result.localTrack?.id : result.neteaseResult?.id,
            title: result.title,
            artist: result.artist,
        })),
    });
}

async function executeMusicPlayTool(args: Record<string, unknown>): Promise<ToolResult> {
    const { result, bridge } = getMusicBridgeResult("播放音乐");
    if (result || !bridge) return result!;

    const source = cleanToolString(args.source, 20);
    const songId = args.songId ?? args.song_id ?? args.id;
    const query = cleanToolString(args.query ?? args.keyword ?? args.title, 160);

    if (songId !== undefined && songId !== null && String(songId).trim()) {
        const track = await resolveMusicTrackById(source, songId);
        if (!track) return { name: "播放音乐", success: false, error: "没有找到指定歌曲" };
        const played = await bridge.playTrack(track);
        return musicToolSuccess("播放音乐", played, {
            continueConversation: false,
            persistToHistory: false,
            userNotice: played.message,
        });
    }

    if (!query) return { name: "播放音乐", success: false, error: "缺少 query 或 songId" };
    const played = await bridge.playByQuery(query);
    return musicToolSuccess("播放音乐", played, {
        continueConversation: false,
        persistToHistory: false,
        userNotice: played.message,
    });
}

async function executeMusicQueueTool(args: Record<string, unknown>): Promise<ToolResult> {
    const { result, bridge } = getMusicBridgeResult("加入播放列表");
    if (result || !bridge) return result!;

    const limit = clampToolInteger(args.limit, 1, 50, 10);
    const replace = Boolean(args.replace);
    const playFirst = Boolean(args.playFirst ?? args.play_first);
    const playlistId = args.playlistId ?? args.playlist_id;
    const source = cleanToolString(args.source, 20);
    const songId = args.songId ?? args.song_id ?? args.id;
    const query = cleanToolString(args.query ?? args.keyword ?? args.title, 160);

    let tracks: MusicTrack[] = [];
    if (playlistId !== undefined && playlistId !== null && String(playlistId).trim()) {
        const pid = Number(playlistId);
        if (!Number.isFinite(pid) || pid <= 0) return { name: "加入播放列表", success: false, error: "playlistId 无效" };
        tracks = (await getPlaylistTracks(pid)).slice(0, limit).map(neteaseResultToTrack);
    } else if (songId !== undefined && songId !== null && String(songId).trim()) {
        const track = await resolveMusicTrackById(source, songId);
        if (track) tracks = [track];
    } else if (query) {
        const results = await unifiedSearch(query);
        tracks = results.slice(0, limit).map(result => result.source === "local" && result.localTrack ? result.localTrack : result.neteaseResult ? neteaseResultToTrack(result.neteaseResult) : null).filter(Boolean) as MusicTrack[];
    }

    if (tracks.length === 0) return { name: "加入播放列表", success: false, error: "没有找到可加入播放列表的歌曲" };
    const queued = await bridge.addToQueue(tracks, { replace, playFirst });
    return musicToolSuccess("加入播放列表", {
        ...queued,
        queue: queued.queue.slice(0, 30).map(formatMusicTrackForTool),
        queueCount: queued.queue.length,
    }, {
        continueConversation: false,
        persistToHistory: false,
        userNotice: queued.message,
    });
}

function executeMusicSwitchTool(args: Record<string, unknown>): ToolResult {
    const { result, bridge } = getMusicBridgeResult("切换音乐");
    if (result || !bridge) return result!;
    const action = cleanToolString(args.action ?? args.type, 20);
    const normalizedAction = action === "previous" ? "prev" : action === "play" ? "resume" : action;
    const labels: Record<string, string> = {
        next: "已切到下一首",
        prev: "已切到上一首",
        pause: "已暂停音乐",
        resume: "已继续播放",
        stop: "已停止播放",
    };
    switch (normalizedAction) {
        case "next":
            bridge.next();
            break;
        case "prev":
        case "previous":
            bridge.prev();
            break;
        case "pause":
            bridge.pause();
            break;
        case "resume":
        case "play":
            bridge.resume();
            break;
        case "stop":
            bridge.stop();
            break;
        default:
            return { name: "切换音乐", success: false, error: "action 必须是 next、prev、pause、resume 或 stop" };
    }
    return musicToolSuccess("切换音乐", labels[normalizedAction] || "已执行网易云音乐操作", {
        continueConversation: false,
        persistToHistory: false,
        userNotice: labels[normalizedAction] || "已执行网易云音乐操作",
    });
}

async function getMusicLoginSummary(): Promise<{ configured: boolean; loggedIn: boolean; nickname?: string }> {
    const configured = isNeteaseConfigured();
    if (!configured) return { configured: false, loggedIn: false };
    const cfg = loadMusicApiConfig();
    const status: { loggedIn: boolean; nickname?: string } = await checkLoginStatus(cfg.baseUrl).catch(() => ({ loggedIn: false }));
    return { configured: true, loggedIn: status.loggedIn, ...(status.nickname ? { nickname: status.nickname } : {}) };
}

async function resolveMusicTrackById(source: string, songId: unknown): Promise<MusicTrack | null> {
    const rawId = String(songId).trim();
    if (!rawId) return null;
    const normalizedSource = source.toLowerCase();
    if (normalizedSource === "local" || rawId.startsWith("trk_")) {
        const tracks = await loadAllTracks();
        return tracks.find(track => track.id === rawId) || null;
    }
    const numericId = Number(String(rawId).replace(/^netease_/, ""));
    if (!Number.isFinite(numericId) || numericId <= 0) return null;
    const [detail, lyrics] = await Promise.all([
        getNeteaseSongDetail(numericId).catch(() => null),
        getNeteaseLyrics(numericId).catch(() => ""),
    ]);
    return {
        id: `netease_${numericId}`,
        title: detail?.name || `网易云歌曲 ${numericId}`,
        artist: detail?.artists || "未知歌手",
        duration: 0,
        coverUrl: detail?.coverUrl,
        lyrics,
        liked: false,
        addedAt: new Date().toISOString(),
    };
}

function neteaseResultToTrack(result: NeteaseSearchResult): MusicTrack {
    return {
        id: `netease_${result.id}`,
        title: result.name,
        artist: result.artists || "未知歌手",
        album: result.album,
        duration: result.duration / 1000,
        coverUrl: result.coverUrl,
        liked: false,
        addedAt: new Date().toISOString(),
    };
}

function formatMusicTrackForTool(track: MusicTrack): Record<string, unknown> {
    return {
        source: track.id.startsWith("netease_") ? "netease" : "local",
        songId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: Math.round(track.duration || 0),
        liked: track.liked,
    };
}

function formatNeteaseTrackForTool(track: NeteaseSearchResult): Record<string, unknown> {
    return {
        source: "netease",
        songId: track.id,
        title: track.name,
        artist: track.artists,
        album: track.album,
        duration: Math.round((track.duration || 0) / 1000),
    };
}

function clampToolInteger(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

type NoteWallListResponse = {
    ok: boolean;
    board?: NoteWallBoard;
    notes?: NoteWallNote[];
    error?: string;
};

type NoteWallNoteResponse = {
    ok: boolean;
    board?: NoteWallBoard;
    note?: NoteWallNote;
    error?: string;
};

type NoteWallCommentsResponse = {
    ok: boolean;
    comments?: NoteWallComment[];
    error?: string;
};

type NoteWallCommentResponse = {
    ok: boolean;
    comment?: NoteWallComment;
    error?: string;
};

async function noteWallFetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
    const response = await fetch(input, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data as T;
}

async function loadNoteWall(): Promise<{ board: NoteWallBoard; notes: NoteWallNote[] }> {
    const data = await noteWallFetchJson<NoteWallListResponse>("/api/notewall/notes", { cache: "no-store" });
    if (!data.board || !data.notes) throw new Error(data.error || "便签墙数据为空");
    return { board: data.board, notes: data.notes };
}

function getCurrentCharacter(characterId: string): { id: string; name: string } {
    const character = loadCharacters().find(item => item.id === characterId);
    return { id: characterId, name: character?.name || "角色" };
}

function cleanToolString(value: unknown, maxLength: number): string {
    return String(value ?? "")
        .replace(/\u0000/g, "")
        .trim()
        .slice(0, maxLength);
}

function cleanToolMultiline(value: unknown, maxLength: number): string {
    return cleanToolString(value, maxLength)
        .replace(/\r\n?/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\n{5,}/g, "\n\n\n\n");
}

function boolArg(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    const text = cleanToolString(value, 24).toLowerCase();
    return text === "true" || text === "1" || text === "yes" || text === "y" || text === "匿名";
}

function numberArg(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function clipToolText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function serializeNoteList(notes: NoteWallNote[], limit: number, sort: string): string {
    const sorted = [...notes].filter(note => !note.deletedAt);
    if (sort === "hot") {
        sorted.sort((a, b) => (b.commentCount - a.commentCount) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    } else if (sort === "all") {
        sorted.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    } else {
        sorted.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }

    return JSON.stringify({
        notes: sorted.slice(0, limit).map(note => ({
            noteId: note.id,
            authorName: note.authorName,
            createdAt: note.createdAt,
            title: note.summary,
            bodyPreview: clipToolText(note.body || note.summary, 180),
            commentCount: note.commentCount,
        })),
    });
}

async function executeNoteWallListTool(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = numberArg(args.limit, 1, 30, 20);
    const sort = cleanToolString(args.sort, 20);
    const normalizedSort = sort === "hot" || sort === "all" ? sort : "latest";
    const { notes } = await loadNoteWall();
    return {
        name: "查看便签列表",
        success: true,
        data: truncate(serializeNoteList(notes, limit, normalizedSort)),
        continueConversation: true,
        persistToHistory: true,
        userNotice: "已查看便签列表",
    };
}

async function executeNoteWallDetailTool(args: Record<string, unknown>): Promise<ToolResult> {
    const noteId = cleanToolString(args.noteId ?? args.note_id ?? args.id, 120);
    if (!noteId) {
        return {
            name: "查看便签详情及评论",
            success: false,
            error: "缺少 noteId 参数",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "缺少便签 noteId",
        };
    }

    const commentLimit = numberArg(args.commentLimit ?? args.comment_limit, 1, 30, 20);
    const { notes } = await loadNoteWall();
    const note = notes.find(item => item.id === noteId && !item.deletedAt);
    if (!note) {
        return {
            name: "查看便签详情及评论",
            success: false,
            error: "未找到这张便签",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "未找到这张便签",
        };
    }

    const commentData = await noteWallFetchJson<NoteWallCommentsResponse>(
        `/api/notewall/comments?noteId=${encodeURIComponent(noteId)}`,
        { cache: "no-store" },
    );
    const comments = (commentData.comments ?? []).filter(comment => !comment.deletedAt).slice(-commentLimit);
    return {
        name: "查看便签详情及评论",
        success: true,
        data: truncate(JSON.stringify({
            note: {
                noteId: note.id,
                authorName: note.authorName,
                createdAt: note.createdAt,
                title: note.summary,
                body: note.body || note.summary,
                commentCount: note.commentCount,
            },
            comments: comments.map(comment => ({
                commentId: comment.id,
                authorName: comment.authorName,
                createdAt: comment.createdAt,
                body: comment.body,
            })),
        })),
        continueConversation: true,
        persistToHistory: true,
        userNotice: "已查看便签详情",
    };
}

async function executeNoteWallCreateNoteTool(args: Record<string, unknown>, characterId: string): Promise<ToolResult> {
    const character = getCurrentCharacter(characterId);
    const body = cleanToolMultiline(args.body ?? args.content ?? args.text, 3000);
    const summary = cleanToolString(args.summary ?? args.title ?? args.heading ?? body.slice(0, 48), 80);
    if (!body && !summary) {
        return {
            name: "发送便签",
            success: false,
            error: "缺少 body 或 summary 参数",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "便签内容为空，未发送",
        };
    }

    const size = normalizeNoteWallSize(args.size) as NoteWallSize;
    const { board, notes } = await loadNoteWall();
    const placement = findNoteWallPlacement(notes, board, size);
    const data = await noteWallFetchJson<NoteWallNoteResponse>("/api/notewall/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            authorType: "character",
            authorId: character.id,
            actorId: character.id,
            authorName: cleanToolString(args.authorName ?? args.author_name ?? args.signature ?? args.name, 80) || character.name,
            summary: summary || clipToolText(body, 48),
            body: body || summary,
            x: placement.x,
            y: placement.y,
            size,
            paper: cleanToolString(args.paper, 32) || "plain",
            tape: cleanToolString(args.tape, 32) || "none",
            font: cleanToolString(args.font, 32) || "default",
            rawCss: "",
            isAnonymous: boolArg(args.isAnonymous ?? args.is_anonymous ?? args.anonymous),
        }),
    });
    if (!data.note) throw new Error(data.error || "便签创建失败");
    recordNoteWallNoteEvent({
        characterId: character.id,
        characterName: character.name,
        note: data.note,
    });

    return {
        name: "发送便签",
        success: true,
        data: `便签发送成功：noteId=${data.note.id}`,
        continueConversation: false,
        persistToHistory: false,
        userNotice: "已发送便签",
    };
}

async function executeNoteWallCreateCommentTool(args: Record<string, unknown>, characterId: string): Promise<ToolResult> {
    const character = getCurrentCharacter(characterId);
    const noteId = cleanToolString(args.noteId ?? args.note_id ?? args.id, 120);
    const body = cleanToolMultiline(args.body ?? args.comment ?? args.text, 1200);
    if (!noteId || !body) {
        return {
            name: "发送便签评论",
            success: false,
            error: "缺少 noteId 或 body 参数",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "评论参数不完整，未发送",
        };
    }

    const data = await noteWallFetchJson<NoteWallCommentResponse>("/api/notewall/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            noteId,
            authorId: character.id,
            actorId: character.id,
            authorName: cleanToolString(args.authorName ?? args.author_name ?? args.signature ?? args.name, 80) || character.name,
            body,
            isAnonymous: boolArg(args.isAnonymous ?? args.is_anonymous ?? args.anonymous),
        }),
    });
    if (!data.comment) throw new Error(data.error || "评论创建失败");
    recordNoteWallCommentEvent({
        characterId: character.id,
        characterName: character.name,
        comment: data.comment,
    });

    return {
        name: "发送便签评论",
        success: true,
        data: `评论发送成功：commentId=${data.comment.id}`,
        continueConversation: false,
        persistToHistory: false,
        userNotice: "已发送便签评论",
    };
}

async function executeMemoryWriteTool(
    args: Record<string, unknown>,
    capability: InternalCapabilityConfig,
    context?: ToolExecutionContext,
): Promise<ToolResult> {
    if (!isSupportedChatToolContext(context) || !context.sessionId) {
        return {
            name: "写入记忆",
            success: false,
            error: "当前场景暂不支持写入记忆",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "当前场景暂不支持写入记忆",
        };
    }

    const content = String(args.content ?? "").trim();
    if (!content) {
        return {
            name: "写入记忆",
            success: false,
            error: "缺少 content 参数",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "记忆内容为空，未写入",
        };
    }
    if (content.length > 240) {
        return {
            name: "写入记忆",
            success: false,
            error: "记忆内容过长，请精简后再写入",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "记忆内容过长，未写入",
        };
    }

    const importance = clampImportance(args.importance);
    const reason = String(args.reason ?? "").trim() || undefined;

    const duplicate = await isDuplicateLongTermMemory(context.characterId, content);
    if (duplicate) {
        return {
            name: "写入记忆",
            success: true,
            data: "这条长期记忆已存在，未重复写入。",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "这条记忆已存在，未重复写入",
        };
    }

    const request: MemoryWriteRequest = {
        capabilityId: MEMORY_WRITE_CAPABILITY_ID,
        sessionId: context.sessionId,
        characterId: context.characterId,
        content,
        importance,
        ...(reason ? { reason } : {}),
    };

    if (capability.mode === "confirm") {
        return {
            name: "写入记忆",
            success: true,
            data: "这条记忆需要用户确认后才会写入。",
            continueConversation: false,
            persistToHistory: false,
            pendingApproval: true,
            pendingRequest: request,
            userNotice: "对方想记住一件事，等待你确认",
        };
    }

    const saved = await persistMemoryWriteRequest(request, { approvedByUser: false });
    if (!saved.success) return saved;

    return {
        ...saved,
        userNotice: saved.userNotice || "已写入长期记忆",
        continueConversation: false,
        persistToHistory: false,
    };
}

async function executeTimedWakeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const capability = getInternalCapability(TIMED_WAKE_CAPABILITY_ID);
    if (!capability || !capability.enabled || capability.mode === "off") {
        return {
            name: "稍后主动联系",
            success: false,
            error: "稍后主动联系能力未启用",
            userNotice: "稍后主动联系能力未启用",
        };
    }

    if (!context?.sessionId || !context.characterId || context.appId !== "chat" || context.sourceEngine !== "chat") {
        return {
            name: "稍后主动联系",
            success: false,
            error: "当前场景暂不支持稍后主动联系",
            userNotice: "当前场景暂不支持稍后主动联系",
        };
    }

    const intent = cleanToolString(call.args.intent, 300);
    if (!intent) {
        return {
            name: "稍后主动联系",
            success: false,
            error: "缺少 intent 参数",
            userNotice: "缺少主动联系的目的",
        };
    }

    const delayMinutes = numberArg(call.args.delayMinutes ?? call.args.delay_minutes, 1, 10080, 15);
    const now = Date.now();
    saveTimedWakeSchedule({
        id: makeTimedWakeId(context.sessionId),
        sessionId: context.sessionId,
        characterId: context.characterId,
        createdAt: now,
        fireAt: now + delayMinutes * 60 * 1000,
        delayMinutes,
        intent,
    });

    return {
        name: "稍后主动联系",
        success: true,
        data: `已设置稍后主动联系：约 ${delayMinutes} 分钟后到点。\n目的：${intent}`,
        userNotice: `已设置 ${delayMinutes} 分钟后主动联系`,
    };
}

function clampImportance(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return 0.8;
    return Math.max(0, Math.min(1, parsed));
}

function normalizeMemoryContent(text: string): string {
    return text
        .toLowerCase()
        .replace(/[，。！？；：、,.!?:;\s]+/g, "")
        .trim();
}

async function isDuplicateLongTermMemory(characterId: string, content: string): Promise<boolean> {
    const entries = await loadMemoryEntriesByType(characterId, "long_term");
    const recent = entries.slice(-20);
    const normalized = normalizeMemoryContent(content);
    return recent.some(entry => normalizeMemoryContent(entry.content) === normalized);
}

async function persistMemoryWriteRequest(
    request: MemoryWriteRequest,
    options?: { approvedByUser?: boolean },
): Promise<ToolResult> {
    const duplicate = await isDuplicateLongTermMemory(request.characterId, request.content);
    if (duplicate) {
        return {
            name: "写入记忆",
            success: true,
            data: "这条长期记忆已存在，未重复写入。",
            continueConversation: false,
            persistToHistory: false,
            userNotice: "这条记忆已存在，未重复写入",
        };
    }

    const now = new Date().toISOString();
    const entry: MemoryEntry = {
        id: `mem_lt_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId: request.characterId,
        sourceApp: "chat",
        type: "long_term",
        content: request.content,
        importance: request.importance,
        createdAt: now,
        updatedAt: now,
        metadata: {
            origin: "ai_tool",
            sessionId: request.sessionId,
            ...(request.reason ? { reason: request.reason } : {}),
            ...(options?.approvedByUser ? { approvedByUser: true } : {}),
        },
    };

    await saveMemoryEntry(entry);

    return {
        name: "写入记忆",
        success: true,
        data: `记忆写入成功：${request.content}`,
        continueConversation: false,
        persistToHistory: false,
        userNotice: options?.approvedByUser ? "已写入长期记忆" : "已自动写入长期记忆",
    };
}

export async function approveMemoryWriteRequest(request: MemoryWriteRequest): Promise<ToolResult> {
    return persistMemoryWriteRequest(request, { approvedByUser: true });
}

// ── ZIP media extraction ─────────────────────

const MEDIA_EXTENSIONS = /\.(png|jpe?g|gif|webp|mp3|wav|ogg|flac|mp4|webm|mkv|pdf)$/i;
const MIME_FROM_EXT: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
    pdf: "application/pdf",
};

async function extractMediaFromZip(blob: Blob): Promise<{ attachments: MediaAttachment[]; summary: string } | null> {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(blob);
    const attachments: MediaAttachment[] = [];
    const summaries: string[] = [];
    for (const [filename, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const extMatch = filename.match(MEDIA_EXTENSIONS);
        if (!extMatch) continue;
        const ext = extMatch[1].toLowerCase();
        const mime = MIME_FROM_EXT[ext] || "application/octet-stream";
        const { category } = detectMediaType("", mime);
        const bytes = await entry.async("uint8array");
        const fileBlob = new Blob([bytes as unknown as BlobPart], { type: mime });
        const ref = await storeMediaBlob(fileBlob, mime, category);
        attachments.push({ type: category, url: ref, title: filename });
        summaries.push(`[${category}: ${filename}]`);
    }
    return attachments.length > 0 ? { attachments, summary: summaries.join(", ") } : null;
}

async function sniffBlobType(blob: Blob): Promise<{ mime: string; category: "audio" | "image" | "video" | "file"; isZip: boolean }> {
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (header[0] === 0x50 && header[1] === 0x4B && header[2] === 0x03 && header[3] === 0x04) {
        return { mime: "application/zip", category: "file", isZip: true };
    }
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
        return { mime: "image/png", category: "image", isZip: false };
    }
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) {
        return { mime: "image/jpeg", category: "image", isZip: false };
    }
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
        return { mime: "image/gif", category: "image", isZip: false };
    }
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
        if (header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) {
            return { mime: "image/webp", category: "image", isZip: false };
        }
        if (header[8] === 0x57 && header[9] === 0x41 && header[10] === 0x56 && header[11] === 0x45) {
            return { mime: "audio/wav", category: "audio", isZip: false };
        }
    }
    if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
        return { mime: "audio/mpeg", category: "audio", isZip: false };
    }
    if (header[0] === 0xFF && (header[1] === 0xFB || header[1] === 0xF3 || header[1] === 0xF2)) {
        return { mime: "audio/mpeg", category: "audio", isZip: false };
    }
    if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) {
        return { mime: "application/pdf", category: "file", isZip: false };
    }
    return { mime: "application/octet-stream", category: "file", isZip: false };
}

// ── REST execution (direct or via proxy) ──────

const TEMPLATE_PLACEHOLDER_RE = /\{\{\{\s*([^{}\s]+)\s*\}\}\}|\{\{\s*([^{}\s]+)\s*\}\}/g;
const WHOLE_TEMPLATE_PLACEHOLDER_RE = /^\s*(?:\{\{\{\s*([^{}\s]+)\s*\}\}\}|\{\{\s*([^{}\s]+)\s*\}\})\s*$/;

type TemplateValueLookup = {
    found: boolean;
    value?: unknown;
    consumedKey?: string;
};

function resolveTemplateValue(values: Record<string, unknown>, key: string): TemplateValueLookup {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
        return { found: true, value: values[key], consumedKey: key };
    }

    const parts = key.split(".").filter(Boolean);
    if (parts.length <= 1 || !Object.prototype.hasOwnProperty.call(values, parts[0])) {
        return { found: false };
    }

    let current: unknown = values[parts[0]];
    for (const part of parts.slice(1)) {
        if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
            return { found: false };
        }
        current = (current as Record<string, unknown>)[part];
    }

    return { found: true, value: current, consumedKey: parts[0] };
}

function stringifyTemplateValue(value: unknown, encodeForUrl = false): string {
    const text = typeof value === "string"
        ? value
        : value === null || value === undefined
            ? ""
            : typeof value === "object"
                ? JSON.stringify(value)
                : String(value);
    return encodeForUrl ? encodeURIComponent(text) : text;
}

function renderTemplateString(
    template: string,
    values: Record<string, unknown>,
    consumedKeys: Set<string>,
    options?: { encodeForUrl?: boolean },
): string {
    return template.replace(TEMPLATE_PLACEHOLDER_RE, (_match, rawKey: string | undefined, encodedKey: string | undefined) => {
        const key = (rawKey || encodedKey || "").trim();
        const resolved = resolveTemplateValue(values, key);
        if (!resolved.found) throw new Error(`工具模板缺少参数：${key}`);
        if (resolved.consumedKey) consumedKeys.add(resolved.consumedKey);
        return stringifyTemplateValue(resolved.value, rawKey ? false : options?.encodeForUrl);
    });
}

function renderBodyTemplateValue(
    value: unknown,
    values: Record<string, unknown>,
    consumedKeys: Set<string>,
): unknown {
    if (typeof value === "string") {
        const whole = value.match(WHOLE_TEMPLATE_PLACEHOLDER_RE);
        if (whole) {
            const key = (whole[1] || whole[2] || "").trim();
            const resolved = resolveTemplateValue(values, key);
            if (!resolved.found) throw new Error(`请求体模板缺少参数：${key}`);
            if (resolved.consumedKey) consumedKeys.add(resolved.consumedKey);
            return resolved.value;
        }
        return renderTemplateString(value, values, consumedKeys);
    }

    if (Array.isArray(value)) {
        return value.map(item => renderBodyTemplateValue(item, values, consumedKeys));
    }

    if (value && typeof value === "object") {
        const rendered: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            rendered[key] = renderBodyTemplateValue(child, values, consumedKeys);
        }
        return rendered;
    }

    return value;
}

function renderRestBodyTemplate(
    template: string,
    values: Record<string, unknown>,
    consumedKeys: Set<string>,
): unknown {
    let parsed: unknown;
    try {
        parsed = JSON.parse(template);
    } catch {
        throw new Error("请求体模板不是有效 JSON");
    }
    return renderBodyTemplateValue(parsed, values, consumedKeys);
}

function renderRestHeaders(
    headers: Record<string, string>,
    values: Record<string, unknown>,
    consumedKeys: Set<string>,
): Record<string, string> {
    const rendered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        rendered[key] = renderTemplateString(value, values, consumedKeys);
    }
    return rendered;
}

async function executeRestTool(tool: RestToolConfig, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    try {
        throwIfAborted(signal);
        const typedFixed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(tool.fixedParams || {})) {
            if (v === "true") { typedFixed[k] = true; }
            else if (v === "false") { typedFixed[k] = false; }
            else if (v !== "" && !isNaN(Number(v))) { typedFixed[k] = Number(v); }
            else { typedFixed[k] = v; }
        }
        const mergedArgs = { ...args, ...typedFixed };
        const consumedKeys = new Set<string>();
        const headers: Record<string, string> = renderRestHeaders({ ...tool.headers }, mergedArgs, consumedKeys);

        let url = renderTemplateString(tool.endpoint, mergedArgs, consumedKeys, { encodeForUrl: true });
        let body: unknown = undefined;

        if (tool.method === "GET") {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(mergedArgs)) {
                if (!consumedKeys.has(k) && v !== undefined && v !== "") params.set(k, String(v));
            }
            const query = params.toString();
            if (query) {
                const sep = url.includes("?") ? "&" : "?";
                url = `${url}${sep}${query}`;
            }
        } else {
            headers["Content-Type"] = headers["Content-Type"] || "application/json";
            body = tool.bodyTemplate?.trim()
                ? renderRestBodyTemplate(tool.bodyTemplate.trim(), mergedArgs, consumedKeys)
                : mergedArgs;
        }

        let resStatus: number;
        let resText: string;
        let binaryAttachments: MediaAttachment[] | undefined;

        if (tool.directFetch ?? true) {
            const controller = new AbortController();
            const detachExternalAbort = attachAbortSignal(controller, signal);
            const timeout = setTimeout(() => controller.abort(), 120_000);
            const fetchOptions: RequestInit = { method: tool.method, headers, signal: controller.signal };
            if (body !== undefined && tool.method !== "GET") {
                fetchOptions.body = JSON.stringify(body);
            }
            let res: Response;
            try {
                res = await fetch(url, fetchOptions);
                throwIfAborted(signal);
                resStatus = res.status;
            } finally {
                clearTimeout(timeout);
                detachExternalAbort();
            }

            if (resStatus >= 200 && resStatus < 300) {
                const ct = (res.headers.get("content-type") || "").toLowerCase();
                const isBinaryCt = ct.includes("zip") || ct.includes("octet-stream") || ct.includes("pdf")
                    || ct.startsWith("image/") || ct.startsWith("audio/") || ct.startsWith("video/");

                if (isBinaryCt) {
                    const blob = await res.blob();
                    throwIfAborted(signal);
                    const sniffed = await sniffBlobType(blob);
                    throwIfAborted(signal);

                    if (sniffed.isZip || ct.includes("zip")) {
                        const extracted = await extractMediaFromZip(blob).catch(() => null);
                        if (extracted) {
                            binaryAttachments = extracted.attachments;
                            resText = extracted.summary;
                        } else {
                            const ref = await storeMediaBlob(blob, sniffed.mime, "file");
                            throwIfAborted(signal);
                            binaryAttachments = [{ type: "file", url: ref, title: "archive.zip" }];
                            resText = "[file: archive.zip]";
                        }
                    } else {
                        const mime = sniffed.mime !== "application/octet-stream" ? sniffed.mime : (blob.type || ct);
                        const category = sniffed.category;
                        const ext = mime.split("/").pop() || "bin";
                        const ref = await storeMediaBlob(blob, mime, category);
                        throwIfAborted(signal);
                        binaryAttachments = [{ type: category, url: ref, title: `file.${ext}` }];
                        resText = `[${category}: file.${ext}]`;
                    }
                } else {
                    resText = await res.text();
                    throwIfAborted(signal);
                }
            } else {
                resText = await res.text();
                throwIfAborted(signal);
            }
        } else {
            const res = await proxyFetch(url, { method: tool.method, headers, body, signal });
            resStatus = res.status;
            if (resStatus >= 200 && resStatus < 300) {
                try {
                    const parsed = JSON.parse(res.text);
                    if (parsed._binary && parsed.data) {
                        const ct = (parsed.contentType || "").toLowerCase();
                        const raw = Uint8Array.from(atob(parsed.data), c => c.charCodeAt(0));
                        const blob = new Blob([raw], { type: ct });
                        throwIfAborted(signal);
                        const sniffed = await sniffBlobType(blob);
                        throwIfAborted(signal);

                        if (sniffed.isZip || ct.includes("zip")) {
                            const extracted = await extractMediaFromZip(blob).catch(() => null);
                            if (extracted) {
                                binaryAttachments = extracted.attachments;
                                resText = extracted.summary;
                            } else {
                                const ref = await storeMediaBlob(blob, sniffed.mime, "file");
                                throwIfAborted(signal);
                                binaryAttachments = [{ type: "file", url: ref, title: "archive.zip" }];
                                resText = "[file: archive.zip]";
                            }
                        } else {
                            const mime = sniffed.mime !== "application/octet-stream" ? sniffed.mime : (ct || "application/octet-stream");
                            const category = sniffed.category;
                            const ext = mime.split("/").pop() || "bin";
                            const ref = await storeMediaBlob(blob, mime, category);
                            throwIfAborted(signal);
                            binaryAttachments = [{ type: category, url: ref, title: `file.${ext}` }];
                            resText = `[${category}: file.${ext}]`;
                        }
                    } else {
                        resText = res.text;
                    }
                } catch {
                    resText = res.text;
                }
            } else {
                resText = res.text;
            }
        }

        if (resStatus < 200 || resStatus >= 300) {
            return { name: tool.name, success: false, error: formatHttpToolError(resStatus, resText) };
        }

        if (binaryAttachments?.length) {
            const labels = binaryAttachments.map(a => ({ audio: "音频", image: "图片", video: "视频", file: "文件" })[a.type] || "文件");
            const unique = [...new Set(labels)];
            return {
                name: tool.name, success: true,
                data: `${unique.join("/")}已自动发送给用户（共 ${binaryAttachments.length} 个）。不要再用文字标签描述或重复发送。`,
                mediaAttachments: binaryAttachments,
            };
        }

        const { text: processed, attachments } = await replaceBase64WithRefs(resText, signal);
        throwIfAborted(signal);
        const result: ToolResult = { name: tool.name, success: true, data: truncate(processed) };
        if (attachments.length > 0) {
            result.mediaAttachments = attachments;
            const labels = attachments.map(a => ({ audio: "音频", image: "图片", video: "视频", file: "文件" })[a.type] || "文件");
            const unique = [...new Set(labels)];
            result.data = attachments.length === 1
                ? `${unique[0]}已自动发送给用户。不要再用文字标签描述或重复发送。`
                : `${unique.join("/")}已自动发送给用户（共 ${attachments.length} 个）。不要再用文字标签描述或重复发送。`;
        }
        return result;
    } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
            if (signal?.aborted) throw err;
            return { name: tool.name, success: false, error: "REST 工具请求超时（120秒）" };
        }
        return { name: tool.name, success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

function formatHttpToolError(status: number, text: string): string {
    try {
        const parsed = JSON.parse(text) as { error?: unknown; cause?: unknown; url?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) {
            const parts = [`HTTP ${status}: ${parsed.error.trim()}`];
            if (typeof parsed.cause === "string" && parsed.cause.trim() && !parsed.error.includes(parsed.cause)) {
                parts.push(`原因：${parsed.cause.trim()}`);
            }
            if (typeof parsed.url === "string" && parsed.url.trim()) {
                parts.push(`地址：${parsed.url.trim()}`);
            }
            return parts.join("\n");
        }
    } catch {
        // Non-JSON error bodies are shown as-is below.
    }
    return `HTTP ${status}: ${text.slice(0, 200)}`;
}

// ══════════════════════════════════════════════
// MCP Protocol Implementation
// ══════════════════════════════════════════════

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_CLIENT_INFO = { name: "ai-virtual-phone", version: "1.0.0" };

type McpOAuthMetadata = {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    code_challenge_methods_supported?: string[];
    grant_types_supported?: string[];
    response_types_supported?: string[];
    scopes_supported?: string[];
};

type McpProtectedResourceMetadata = {
    authorization_servers?: string[];
};

type ResolvedMcpOAuthMetadata = {
    metadata: McpOAuthMetadata;
    protectedResourceMetadataUrl?: string;
    authorizationServerUrl?: string;
};

type McpOAuthPendingState = {
    state: string;
    serverId: string;
    serverName: string;
    serverDescription?: string;
    serverUrl: string;
    serverEnabled: boolean;
    serverHeaders?: Record<string, string>;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
    authorizationServerUrl?: string;
    protectedResourceMetadataUrl?: string;
    createdAt: number;
};

type McpOAuthCallbackState = {
    state: string;
    code?: string;
    error?: string;
    createdAt: number;
};

const MCP_OAUTH_PENDING_STORAGE_KEY = "ai_phone_mcp_oauth_pending_v1";
export const MCP_OAUTH_CALLBACK_STORAGE_KEY = "ai_phone_mcp_oauth_callback_v1";
const MCP_OAUTH_MAX_AGE_MS = 10 * 60 * 1000;
const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
// Per-probe timeout for OAuth metadata discovery. Candidates are tried in parallel,
// so a missing/hanging .well-known URL fails fast instead of stalling the whole flow.
const MCP_OAUTH_DISCOVERY_TIMEOUT_MS = 8000;

// In-memory caches
const _mcpSessions = new Map<string, string>(); // serverId → sessionId
const _mcpSseEndpoints = new Map<string, string>(); // serverId → resolved message endpoint URL

/**
 * Detect if an MCP server uses SSE transport (by URL pattern).
 * SSE servers typically end with /sse, Streamable HTTP with /mcp.
 */
function isSseUrl(url: string): boolean {
    return url.endsWith("/sse") || url.includes("/sse?");
}

/**
 * Discover the SSE message endpoint by connecting to the SSE URL.
 * Returns the full message endpoint URL.
 */
async function discoverSseEndpoint(serverUrl: string, serverId: string, signal?: AbortSignal): Promise<string> {
    const cached = _mcpSseEndpoints.get(serverId);
    if (cached) return cached;

    const res = await proxyFetch(serverUrl, { method: "SSE_DISCOVER", signal });
    const data = JSON.parse(res.text);
    const endpointPath = data.endpointPath;

    if (!endpointPath) {
        const debug = data.debug || "";
        throw new Error(`SSE 服务器未返回 endpoint 路径。收到: ${debug.slice(0, 200)}`);
    }

    // Resolve relative path against server URL, preserving original query params (like key=xxx)
    let fullUrl: string;
    if (endpointPath.startsWith("http")) {
        fullUrl = endpointPath;
    } else {
        const base = new URL(serverUrl);
        const endpointUrl = new URL(endpointPath, base.origin);
        // Merge original query params (e.g., key=xxx) into the endpoint URL
        for (const [k, v] of base.searchParams.entries()) {
            if (!endpointUrl.searchParams.has(k)) {
                endpointUrl.searchParams.set(k, v);
            }
        }
        fullUrl = endpointUrl.toString();
    }

    _mcpSseEndpoints.set(serverId, fullUrl);
    return fullUrl;
}

// ── MCP JSON-RPC helper ───────────────────────

let _mcpRequestId = 1;

function extractSseMessageData(text: string): string[] {
    const messages: string[] = [];
    let eventName = "";
    let dataLines: string[] = [];

    const flush = () => {
        if (dataLines.length > 0 && (!eventName || eventName === "message")) {
            const data = dataLines.join("\n").trim();
            if (data && data !== "[DONE]") messages.push(data);
        }
        eventName = "";
        dataLines = [];
    };

    for (const rawLine of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
        if (rawLine === "") {
            flush();
            continue;
        }
        if (rawLine.startsWith(":")) continue;

        const separator = rawLine.indexOf(":");
        const field = separator >= 0 ? rawLine.slice(0, separator) : rawLine;
        let value = separator >= 0 ? rawLine.slice(separator + 1) : "";
        if (value.startsWith(" ")) value = value.slice(1);

        if (field === "event") eventName = value.trim();
        else if (field === "data") dataLines.push(value);
    }

    flush();
    return messages;
}

function parseMcpJsonRpcText(text: string): { result?: unknown; error?: unknown } {
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed) as { result?: unknown; error?: unknown };
    } catch (jsonError) {
        const messages = extractSseMessageData(trimmed);
        for (const message of messages) {
            try {
                return JSON.parse(message) as { result?: unknown; error?: unknown };
            } catch {
                // Try the next SSE message before surfacing the original parse error.
            }
        }
        throw jsonError;
    }
}

function normalizeMcpJsonRpcError(error: unknown): { code: number; message: string } | undefined {
    if (!error) return undefined;
    if (typeof error === "object") {
        const record = error as Record<string, unknown>;
        const code = typeof record.code === "number" ? record.code : -1;
        const message = typeof record.message === "string" ? record.message : JSON.stringify(error);
        return { code, message };
    }
    return { code: -1, message: String(error) };
}

async function mcpRequest(
    serverUrl: string,
    method: string,
    params?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
    isNotification?: boolean,
    useSse?: boolean,
    signal?: AbortSignal,
): Promise<{ result?: unknown; error?: { code: number; message: string }; headers: Record<string, string> }> {
    throwIfAborted(signal);
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        ...extraHeaders,
    };

    const body: Record<string, unknown> = {
        jsonrpc: "2.0",
        method,
        ...(params ? { params } : {}),
    };
    if (!isNotification) body.id = _mcpRequestId++;

    // SSE transport: use SSE_REQUEST which handles the full SSE flow
    const proxyMethod = useSse ? "SSE_REQUEST" : "POST";

    const res = await proxyFetch(serverUrl, {
        method: proxyMethod,
        headers,
        body,
        signal,
    });

    if (res.status === 401) {
        // 把响应体带回去：401 可能来自应用登录网关、隧道/反代或 MCP 服务器本身，
        // 上层靠 body + WWW-Authenticate 头才能区分并给出正确指引。
        return { error: { code: 401, message: res.text.slice(0, 300) || "Unauthorized" }, headers: res.headers };
    }

    if (res.status < 200 || res.status >= 300) {
        // Try to extract detailed error from response body
        let errDetail = `HTTP ${res.status}`;
        try {
            const parsed = parseMcpJsonRpcText(res.text);
            const parsedError = normalizeMcpJsonRpcError(parsed.error);
            if (parsedError) errDetail = parsedError.message;
        } catch { errDetail += `: ${res.text.slice(0, 200)}`; }
        return { error: { code: res.status, message: errDetail }, headers: res.headers };
    }

    try {
        const json = parseMcpJsonRpcText(res.text);
        return { result: json.result, error: normalizeMcpJsonRpcError(json.error), headers: res.headers };
    } catch {
        return { error: { code: -1, message: "Invalid JSON response" }, headers: res.headers };
    }
}

// ── MCP Initialize Handshake ──────────────────

/**
 * 401 分流：同一个状态码可能来自三个完全不同的地方，指错路会让用户在
 * 「OAuth 授权」按钮上打转（服务器不支持 OAuth 时那条路是死胡同）。
 */
function describeMcpUnauthorized(wwwAuthenticate: string | undefined, bodyText: string): string {
    // 托管部署下 middleware 对 /api/tool-proxy 的登录拦截——和 MCP 服务器无关
    if (bodyText.includes("请先登录")) {
        return "鉴权失败（401）：应用登录已过期，请刷新页面重新登录后再试（与 MCP 服务器配置无关）。";
    }
    // 标准 MCP OAuth 服务器会带 WWW-Authenticate 头，此时点授权按钮才是正解
    if (wwwAuthenticate) {
        return "需要 OAuth 授权。请在设置中点击「授权」按钮。";
    }
    return "鉴权失败（401）：Token 可能无效或已过期。本地工具类 MCP 通常不支持 OAuth，"
        + "请在设置中检查「访问 Token」是否为最新值（这类工具重启后 token 会变化），不必点击授权按钮。";
}

async function mcpInitialize(server: McpServerConfig, signal?: AbortSignal): Promise<{ success: boolean; error?: string }> {
    throwIfAborted(signal);
    // Check in-memory session cache
    const cachedSession = _mcpSessions.get(server.id);
    if (cachedSession) {
        server.sessionId = cachedSession;
        return { success: true };
    }

    // Refresh token if needed
    await ensureTokenFresh(server, signal);

    const authHeaders = buildMcpAuthHeaders(server);

    const useSse = isSseUrl(server.url);

    // For SSE: use the original SSE URL (proxy handles the full flow)
    // For Streamable HTTP: use the server URL directly
    const requestUrl = useSse ? server.url : server.url;

    // Step 1: initialize
    const initRes = await mcpRequest(requestUrl, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
    }, authHeaders, false, useSse, signal);

    // Handle 401 — 按来源分流：应用登录网关 / 真 OAuth 服务器 / Token 失效
    if (initRes.error?.code === 401) {
        return { success: false, error: describeMcpUnauthorized(initRes.headers["www-authenticate"], initRes.error.message) };
    }

    if (initRes.error) {
        return { success: false, error: initRes.error.message };
    }

    // Store session ID in memory cache
    const sessionId = initRes.headers["mcp-session-id"];
    if (sessionId) {
        server.sessionId = sessionId;
        _mcpSessions.set(server.id, sessionId);
    }

    // Step 2: send initialized notification (no id, no response expected)
    await mcpRequest(requestUrl, "notifications/initialized", {}, {
        ...authHeaders,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    }, true, useSse, signal);

    return { success: true };
}

async function ensureTokenFresh(server: McpServerConfig, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!server.accessToken || !server.tokenExpiresAt || !server.refreshToken) return;
    // Refresh if token expires within 60 seconds
    if (Date.now() < server.tokenExpiresAt - 60_000) return;

    try {
        let tokenEndpoint = server.oauthTokenEndpoint;
        if (!tokenEndpoint) {
            // We need the token endpoint — discover it from the protected resource metadata.
            const probe = await mcpRequest(server.url, "initialize", {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: MCP_CLIENT_INFO,
            }, undefined, false, undefined, signal);
            const resolved = await resolveMcpOAuthMetadata(server.url, probe.headers["www-authenticate"] || "", signal);
            tokenEndpoint = resolved.metadata.token_endpoint;
            server.oauthTokenEndpoint = tokenEndpoint;
            server.oauthAuthorizationEndpoint = resolved.metadata.authorization_endpoint;
            server.oauthRegistrationEndpoint = resolved.metadata.registration_endpoint;
            server.oauthAuthorizationServer = resolved.authorizationServerUrl;
            server.oauthProtectedResourceMetadataUrl = resolved.protectedResourceMetadataUrl;
        }
        if (!tokenEndpoint) return;

        const tokenBody: Record<string, string> = {
            grant_type: "refresh_token",
            refresh_token: server.refreshToken,
            client_id: server.oauthClientId || "ai-virtual-phone",
        };
        if (server.oauthClientSecret) tokenBody.client_secret = server.oauthClientSecret;

        const tokenRes = await proxyFetch(tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            signal,
            body: new URLSearchParams(tokenBody).toString(),
        });

        if (tokenRes.status === 200) {
            const data = JSON.parse(tokenRes.text);
            server.accessToken = data.access_token;
            if (data.refresh_token) server.refreshToken = data.refresh_token;
            server.tokenExpiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : undefined;
            persistMcpOAuthState(server);
        }
    } catch (err) {
        if (isAbortError(err)) throw err;
        // Keep the existing token if refresh fails.
    }
}

/** 用户常把 "Bearer xxx" 整段粘进 Token 栏，发出去会变成 "Bearer Bearer xxx"——这里兜底剥掉前缀。 */
function bearerAuthValue(accessToken: string): string {
    return `Bearer ${accessToken.replace(/^bearer\s+/i, "")}`;
}

function buildMcpAuthHeaders(server: McpServerConfig): Record<string, string> {
    const headers: Record<string, string> = cleanHeaders(server.headers);
    if (server.accessToken) {
        headers["Authorization"] = bearerAuthValue(server.accessToken);
    }
    return headers;
}

function getMcpSessionHeaders(server: McpServerConfig): Record<string, string> {
    const headers: Record<string, string> = cleanHeaders(server.headers);
    if (server.sessionId) headers["Mcp-Session-Id"] = server.sessionId;
    if (server.accessToken) headers["Authorization"] = bearerAuthValue(server.accessToken);
    return headers;
}

function cleanHeaders(headers?: Record<string, string>): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers || {})) {
        const headerName = key.trim();
        if (!headerName || !value) continue;
        cleaned[headerName] = value;
    }
    return cleaned;
}

function hasOAuthEndpoints(value: unknown): value is McpOAuthMetadata {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return typeof record.authorization_endpoint === "string" && typeof record.token_endpoint === "string";
}

function parseWwwAuthenticateParam(header: string, name: string): string | undefined {
    const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]+)"|([^,\\s]+))`, "i").exec(header);
    return (match?.[1] || match?.[2] || "").trim() || undefined;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
    return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

function getProtectedResourceMetadataUrls(serverUrl: string, wwwAuthenticate: string): string[] {
    const fromHeader = parseWwwAuthenticateParam(wwwAuthenticate, "resource_metadata")
        || parseWwwAuthenticateParam(wwwAuthenticate, "resource_metadata_uri");

    const candidates: Array<string | undefined> = [fromHeader];
    try {
        const url = new URL(serverUrl);
        const pathBase = trimTrailingSlash(url.pathname || "");
        if (pathBase) {
            candidates.push(`${url.origin}${pathBase}/.well-known/oauth-protected-resource`);
        }
        candidates.push(`${url.origin}/.well-known/oauth-protected-resource`);
    } catch {
        candidates.push(`${trimTrailingSlash(serverUrl)}/.well-known/oauth-protected-resource`);
    }

    return uniqueNonEmpty(candidates);
}

function getAuthorizationServerMetadataUrls(authorizationServerUrl: string): string[] {
    const candidates: Array<string | undefined> = [];
    try {
        const url = new URL(authorizationServerUrl);
        const pathBase = trimTrailingSlash(url.pathname || "");
        if (pathBase) {
            candidates.push(`${url.origin}${pathBase}/.well-known/oauth-authorization-server`);
        }
        candidates.push(`${url.origin}/.well-known/oauth-authorization-server`);
    } catch {
        candidates.push(`${trimTrailingSlash(authorizationServerUrl)}/.well-known/oauth-authorization-server`);
    }
    return uniqueNonEmpty(candidates);
}

async function fetchJsonObject(url: string, signal?: AbortSignal): Promise<unknown | null> {
    try {
        const res = await proxyFetch(url, { method: "GET", signal, timeoutMs: MCP_OAUTH_DISCOVERY_TIMEOUT_MS });
        if (res.status < 200 || res.status >= 300) return null;
        const parsed = JSON.parse(res.text);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
        // A user-initiated abort cancels the whole flow; a per-probe timeout (or any
        // network error) just means this candidate failed — skip it and try the rest.
        if (signal?.aborted) throw err;
        return null;
    }
}

async function resolveAuthorizationServerMetadata(
    authorizationServerUrl: string,
    signal?: AbortSignal,
): Promise<{ metadata: McpOAuthMetadata; metadataUrl: string } | null> {
    // Probe all candidate URLs in parallel, then pick the first valid one in priority order.
    const metadataUrls = getAuthorizationServerMetadataUrls(authorizationServerUrl);
    const fetched = await Promise.all(
        metadataUrls.map((metadataUrl) => fetchJsonObject(metadataUrl, signal).then((parsed) => ({ metadataUrl, parsed }))),
    );
    for (const { metadataUrl, parsed } of fetched) {
        if (hasOAuthEndpoints(parsed)) {
            return { metadata: parsed, metadataUrl };
        }
    }
    return null;
}

async function resolveMcpOAuthMetadata(
    serverUrl: string,
    wwwAuthenticate = "",
    signal?: AbortSignal,
): Promise<ResolvedMcpOAuthMetadata> {
    // Probe all protected-resource metadata candidates in parallel; evaluate results
    // in priority order so behaviour matches the old sequential loop, minus the stalls.
    const prmUrls = getProtectedResourceMetadataUrls(serverUrl, wwwAuthenticate);
    const fetched = await Promise.all(
        prmUrls.map((url) => fetchJsonObject(url, signal).then((parsed) => ({ url, parsed }))),
    );

    for (const { url: protectedResourceMetadataUrl, parsed } of fetched) {
        if (!parsed) continue;

        if (hasOAuthEndpoints(parsed)) {
            return { metadata: parsed, protectedResourceMetadataUrl };
        }

        const protectedResource = parsed as McpProtectedResourceMetadata;
        const authorizationServers = Array.isArray(protectedResource.authorization_servers)
            ? protectedResource.authorization_servers.filter((url): url is string => typeof url === "string" && Boolean(url.trim()))
            : [];

        // Resolve the linked authorization servers in parallel, first valid in priority order.
        const resolvedList = await Promise.all(
            authorizationServers.map((authorizationServerUrl) =>
                resolveAuthorizationServerMetadata(authorizationServerUrl, signal).then((resolved) => ({ authorizationServerUrl, resolved })),
            ),
        );
        for (const { authorizationServerUrl, resolved } of resolvedList) {
            if (resolved) {
                return {
                    metadata: resolved.metadata,
                    protectedResourceMetadataUrl,
                    authorizationServerUrl,
                };
            }
        }
    }

    throw new Error("无法发现 OAuth 授权端点——该服务器可能不支持 OAuth。若已有 Token，直接填入「访问 Token」即可，无需授权。");
}

function persistMcpOAuthState(server: McpServerConfig): void {
    const servers = loadMcpServers();
    const idx = servers.findIndex(s => s.id === server.id);
    if (idx >= 0) {
        servers[idx] = {
            ...servers[idx],
            accessToken: server.accessToken,
            refreshToken: server.refreshToken,
            tokenExpiresAt: server.tokenExpiresAt,
            oauthClientId: server.oauthClientId,
            oauthClientSecret: server.oauthClientSecret,
            oauthTokenEndpoint: server.oauthTokenEndpoint,
            oauthAuthorizationEndpoint: server.oauthAuthorizationEndpoint,
            oauthRegistrationEndpoint: server.oauthRegistrationEndpoint,
            oauthAuthorizationServer: server.oauthAuthorizationServer,
            oauthProtectedResourceMetadataUrl: server.oauthProtectedResourceMetadataUrl,
        };
        saveMcpServers(servers);
    }
}

function readStorageJson<T>(key: string): T | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function writeStorageJson(key: string, value: unknown): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch { /* ignore storage failures */ }
}

function removeStorageKey(key: string): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(key);
    } catch { /* ignore storage failures */ }
}

function clearMcpOAuthFlow(): void {
    removeStorageKey(MCP_OAUTH_PENDING_STORAGE_KEY);
    removeStorageKey(MCP_OAUTH_CALLBACK_STORAGE_KEY);
}

function consumeStoredOAuthCallback(expectedState: string): McpOAuthCallbackState | null {
    const callback = readStorageJson<McpOAuthCallbackState>(MCP_OAUTH_CALLBACK_STORAGE_KEY);
    if (!callback || callback.state !== expectedState) return null;
    removeStorageKey(MCP_OAUTH_CALLBACK_STORAGE_KEY);
    return callback;
}

export function hasPendingMcpOAuthCallback(): boolean {
    const pending = readStorageJson<McpOAuthPendingState>(MCP_OAUTH_PENDING_STORAGE_KEY);
    const callback = readStorageJson<McpOAuthCallbackState>(MCP_OAUTH_CALLBACK_STORAGE_KEY);
    return Boolean(pending?.state && callback?.state && pending.state === callback.state);
}

export async function completePendingMcpOAuthCallback(): Promise<{ completed: boolean; success?: boolean; error?: string; serverName?: string }> {
    const pending = readStorageJson<McpOAuthPendingState>(MCP_OAUTH_PENDING_STORAGE_KEY);
    const callback = readStorageJson<McpOAuthCallbackState>(MCP_OAUTH_CALLBACK_STORAGE_KEY);
    if (!pending || !callback || pending.state !== callback.state) {
        return { completed: false };
    }

    if (Date.now() - pending.createdAt > MCP_OAUTH_MAX_AGE_MS) {
        clearMcpOAuthFlow();
        return { completed: true, success: false, error: "OAuth 授权已过期，请重新授权。", serverName: pending.serverName };
    }

    if (callback.error) {
        clearMcpOAuthFlow();
        return { completed: true, success: false, error: callback.error, serverName: pending.serverName };
    }

    if (!callback.code) {
        clearMcpOAuthFlow();
        return { completed: true, success: false, error: "OAuth 回调没有返回授权码。", serverName: pending.serverName };
    }

    try {
        const tokenBody: Record<string, string> = {
            grant_type: "authorization_code",
            code: callback.code,
            redirect_uri: pending.redirectUri,
            client_id: pending.clientId,
            code_verifier: pending.codeVerifier,
        };
        if (pending.clientSecret) tokenBody.client_secret = pending.clientSecret;

        const tokenRes = await proxyFetch(pending.tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(tokenBody).toString(),
        });

        if (tokenRes.status !== 200) {
            clearMcpOAuthFlow();
            return { completed: true, success: false, error: `Token 请求失败: ${tokenRes.text.slice(0, 200)}`, serverName: pending.serverName };
        }

        const tokenData = JSON.parse(tokenRes.text);
        const servers = loadMcpServers();
        const idx = servers.findIndex(s => s.id === pending.serverId);
        const now = Date.now();
        const baseServer: McpServerConfig = idx >= 0 ? servers[idx] : {
            id: pending.serverId,
            name: pending.serverName,
            description: pending.serverDescription,
            url: pending.serverUrl,
            enabled: pending.serverEnabled,
            headers: pending.serverHeaders,
            createdAt: pending.createdAt,
            updatedAt: now,
        };

        const nextServer: McpServerConfig = {
            ...baseServer,
            name: baseServer.name || pending.serverName,
            url: baseServer.url || pending.serverUrl,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            tokenExpiresAt: tokenData.expires_in ? now + tokenData.expires_in * 1000 : undefined,
            oauthClientId: pending.clientId,
            oauthClientSecret: pending.clientSecret,
            oauthTokenEndpoint: pending.tokenEndpoint,
            oauthAuthorizationEndpoint: pending.authorizationEndpoint,
            oauthRegistrationEndpoint: pending.registrationEndpoint,
            oauthAuthorizationServer: pending.authorizationServerUrl,
            oauthProtectedResourceMetadataUrl: pending.protectedResourceMetadataUrl,
            updatedAt: now,
        };

        if (idx >= 0) {
            servers[idx] = nextServer;
        } else {
            servers.unshift(nextServer);
        }
        saveMcpServers(servers);
        clearMcpOAuthFlow();
        return { completed: true, success: true, serverName: nextServer.name };
    } catch (err) {
        clearMcpOAuthFlow();
        return { completed: true, success: false, error: err instanceof Error ? err.message : String(err), serverName: pending.serverName };
    }
}

// ── MCP Tool Execution (with handshake) ───────

async function executeMcpTool(server: McpServerConfig, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    try {
        throwIfAborted(signal);
        // Ensure initialized
        const init = await mcpInitialize(server, signal);
        if (!init.success) {
            return { name: toolName, success: false, error: init.error || "MCP 初始化失败" };
        }

        const useSse = isSseUrl(server.url);
        const requestUrl = server.url;
        const res = await mcpRequest(requestUrl, "tools/call", {
            name: toolName,
            arguments: args,
        }, getMcpSessionHeaders(server), false, useSse, signal);

        // Session expired — retry once
        if (res.error?.code === 401 || res.error?.code === 404) {
            server.sessionId = undefined;
            _mcpSessions.delete(server.id);
            _mcpSseEndpoints.delete(server.id);
            const reinit = await mcpInitialize(server, signal);
            if (!reinit.success) {
                return { name: toolName, success: false, error: reinit.error || "MCP 重新初始化失败" };
            }
            const retry = await mcpRequest(server.url, "tools/call", {
                name: toolName,
                arguments: args,
            }, getMcpSessionHeaders(server), false, useSse, signal);

            if (retry.error) {
                return { name: toolName, success: false, error: retry.error.message };
            }
            return await extractMcpToolResult(toolName, retry.result, signal);
        }

        if (res.error) {
            return { name: toolName, success: false, error: res.error.message };
        }

        return await extractMcpToolResult(toolName, res.result, signal);
    } catch (err) {
        if (isAbortError(err)) throw err;
        return { name: toolName, success: false, error: String(err) };
    }
}

async function extractMcpToolResult(toolName: string, result: unknown, signal?: AbortSignal): Promise<ToolResult> {
    throwIfAborted(signal);
    const r = result as { content?: { type?: string; text?: string; data?: string; mimeType?: string }[] } | undefined;
    const textParts: string[] = [];
    const mcpAttachments: MediaAttachment[] = [];

    if (Array.isArray(r?.content)) {
        for (const c of r.content) {
            throwIfAborted(signal);
            if (c.type === "text" && c.text) {
                textParts.push(c.text);
            } else if ((c.type === "image" || c.type === "resource") && c.data) {
                try {
                    const { ref, category } = await storeMediaBase64(c.data, c.mimeType);
                    throwIfAborted(signal);
                    mcpAttachments.push({ type: category, url: ref });
                } catch { /* skip */ }
            }
        }
    }

    const data = textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result);
    const { text: processed, attachments: b64Attachments } = await replaceBase64WithRefs(data, signal);
    const allAttachments = [...mcpAttachments, ...b64Attachments];

    const toolResult: ToolResult = { name: toolName, success: true, data: truncate(processed) };
    if (allAttachments.length > 0) {
        toolResult.mediaAttachments = allAttachments;
        const labels = allAttachments.map(a => ({ audio: "音频", image: "图片", video: "视频", file: "文件" })[a.type] || "文件");
        const unique = [...new Set(labels)];
        toolResult.data = allAttachments.length === 1
            ? `${unique[0]}已自动发送给用户。不要再用文字标签描述或重复发送。`
            : `${unique.join("/")}已自动发送给用户（共 ${allAttachments.length} 个）。不要再用文字标签描述或重复发送。`;
    }
    return toolResult;
}

// ── MCP Tool Discovery (with handshake) ───────

export async function discoverMcpTools(serverUrl: string, server?: McpServerConfig): Promise<{ name: string; description: string; inputSchema: object }[]> {
    // Initialize if server object provided
    if (server) {
        const init = await mcpInitialize(server);
        if (!init.success) throw new Error(init.error || "初始化失败");
    }

    const headers = server ? getMcpSessionHeaders(server) : { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION };

    const useSse = isSseUrl(serverUrl);
    const res = await mcpRequest(serverUrl, "tools/list", {}, headers, false, useSse);

    if (res.error) throw new Error(res.error.message);

    const tools = (res.result as { tools?: unknown[] })?.tools;
    if (!Array.isArray(tools)) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return tools.map((t: any) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || {},
    }));
}

// ══════════════════════════════════════════════
// OAuth 2.1 + PKCE
// ══════════════════════════════════════════════

function generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Start OAuth authorization flow for an MCP server.
 * Opens a popup for user to authorize. Returns when authorization is complete.
 */
function renderMcpOAuthPopupLoading(popup: Window, server: McpServerConfig): void {
    const targetName = /notion/i.test(`${server.name} ${server.url}`) ? "Notion" : "MCP";
    const title = `正在连接 ${targetName}`;
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f7f8;
      color: #111827;
    }
    .wrap {
      width: min(360px, calc(100vw - 48px));
      text-align: center;
    }
    .mark {
      width: 42px;
      height: 42px;
      margin: 0 auto 18px;
      border: 2px solid rgba(17, 24, 39, 0.16);
      border-top-color: #111827;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.4;
      font-weight: 700;
      letter-spacing: 0;
    }
    p {
      margin: 10px 0 0;
      color: #6b7280;
      font-size: 13px;
      line-height: 1.6;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #f9fafb; }
      .mark { border-color: rgba(249, 250, 251, 0.18); border-top-color: #f9fafb; }
      p { color: #9ca3af; }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="mark" aria-hidden="true"></div>
    <h1><span id="label">${title}</span><span id="dots">...</span></h1>
    <p>正在准备授权页面，请不要关闭这个窗口。</p>
  </main>
  <script>
    var dots = document.getElementById("dots");
    var n = 0;
    setInterval(function () {
      n = (n + 1) % 4;
      dots.textContent = ".".repeat(n);
    }, 420);
  </script>
</body>
</html>`;

    try {
        popup.document.open();
        popup.document.write(html);
        popup.document.close();
    } catch { /* If the popup is not writable, it will remain about:blank. */ }
}

export async function startMcpOAuth(server: McpServerConfig): Promise<{ success: boolean; error?: string }> {
    // Open popup IMMEDIATELY (synchronous, from user click context) to avoid browser blocking
    const popup = window.open("about:blank", "mcp_oauth", "width=600,height=700,left=200,top=100");
    if (!popup) {
        return { success: false, error: "浏览器阻止了弹窗，请允许弹窗后重试" };
    }
    renderMcpOAuthPopupLoading(popup, server);

    try {
        // Step 1: Probe server to get www-authenticate header
        const probe = await mcpRequest(server.url, "initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: MCP_CLIENT_INFO,
        });

        if (probe.error?.code !== 401) {
            popup.close();
            const init = await mcpInitialize(server);
            return init;
        }

        // Step 2: Discover OAuth metadata. Notion MCP follows RFC 9470 protected
        // resource metadata, which then points to RFC 8414 authorization metadata.
        let resolvedMetadata: ResolvedMcpOAuthMetadata;
        try {
            resolvedMetadata = await resolveMcpOAuthMetadata(server.url, probe.headers["www-authenticate"] || "");
        } catch (err) {
            popup.close();
            return { success: false, error: err instanceof Error ? err.message : "无法获取 OAuth 元数据" };
        }

        const metadata = resolvedMetadata.metadata;
        const authEndpoint = metadata.authorization_endpoint;
        const tokenEndpoint = metadata.token_endpoint;
        const registrationEndpoint = metadata.registration_endpoint;

        if (!authEndpoint || !tokenEndpoint) {
            popup.close();
            return { success: false, error: "OAuth 元数据缺少必要端点" };
        }

        // Step 4: Dynamic client registration (if endpoint available)
        let clientId = server.oauthClientId || "ai-virtual-phone";
        let clientSecret: string | undefined = server.oauthClientSecret;
        const redirectUri = `${window.location.origin}/api/oauth-callback`;

        if (registrationEndpoint && !server.oauthClientId) {
            const regRes = await proxyFetch(registrationEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: {
                    client_name: "AI Virtual Phone",
                    redirect_uris: [redirectUri],
                    grant_types: ["authorization_code", "refresh_token"],
                    response_types: ["code"],
                    token_endpoint_auth_method: "none",
                },
            });

            if (regRes.status === 200 || regRes.status === 201) {
                const regData = JSON.parse(regRes.text);
                clientId = regData.client_id || clientId;
                clientSecret = regData.client_secret;
            } else {
                popup.close();
                return { success: false, error: `OAuth 动态客户端注册失败: ${regRes.text.slice(0, 200)}` };
            }
        }

        // Step 5: PKCE
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        // Step 6: Open authorization popup
        const state = crypto.randomUUID();
        const authUrl = new URL(authEndpoint);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("state", state);

        writeStorageJson(MCP_OAUTH_PENDING_STORAGE_KEY, {
            state,
            serverId: server.id,
            serverName: server.name,
            serverDescription: server.description,
            serverUrl: server.url,
            serverEnabled: server.enabled,
            serverHeaders: server.headers,
            redirectUri,
            codeVerifier,
            clientId,
            clientSecret,
            authorizationEndpoint: authEndpoint,
            tokenEndpoint,
            registrationEndpoint,
            authorizationServerUrl: resolvedMetadata.authorizationServerUrl,
            protectedResourceMetadataUrl: resolvedMetadata.protectedResourceMetadataUrl,
            createdAt: Date.now(),
        } satisfies McpOAuthPendingState);
        removeStorageKey(MCP_OAUTH_CALLBACK_STORAGE_KEY);

        // Navigate the already-opened popup to the auth URL
        popup.location.href = authUrl.toString();
        const authCode = await waitForAuthCallback(popup, state);
        if (!authCode) {
            return { success: false, error: "授权被取消，或等待超过 10 分钟仍未完成。" };
        }

        // Step 7: Exchange code for token
        const tokenBody: Record<string, string> = {
            grant_type: "authorization_code",
            code: authCode,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: codeVerifier,
        };
        if (clientSecret) tokenBody.client_secret = clientSecret;

        const tokenRes = await proxyFetch(tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(tokenBody).toString(),
        });

        if (tokenRes.status !== 200) {
            clearMcpOAuthFlow();
            return { success: false, error: `Token 请求失败: ${tokenRes.text.slice(0, 200)}` };
        }

        const tokenData = JSON.parse(tokenRes.text);
        server.accessToken = tokenData.access_token;
        server.refreshToken = tokenData.refresh_token;
        server.tokenExpiresAt = tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined;
        server.oauthClientId = clientId;
        server.oauthClientSecret = clientSecret;
        server.oauthTokenEndpoint = tokenEndpoint;
        server.oauthAuthorizationEndpoint = authEndpoint;
        server.oauthRegistrationEndpoint = registrationEndpoint;
        server.oauthAuthorizationServer = resolvedMetadata.authorizationServerUrl;
        server.oauthProtectedResourceMetadataUrl = resolvedMetadata.protectedResourceMetadataUrl;

        persistMcpOAuthState(server);
        clearMcpOAuthFlow();

        return { success: true };
    } catch (err) {
        try { popup.close(); } catch { /* ignore */ }
        return { success: false, error: String(err) };
    }
}

/**
 * Wait for the OAuth callback from an already-opened popup.
 */
function waitForAuthCallback(popup: Window, expectedState: string): Promise<string | null> {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve(null);
        }, MCP_OAUTH_CALLBACK_TIMEOUT_MS);

        function finishFromCallback(callback: McpOAuthCallbackState | null): boolean {
            if (!callback) return false;
            cleanup();
            if (callback.error) {
                resolve(null);
            } else {
                resolve(callback.code || null);
            }
            return true;
        }

        function checkStoredCallback(): boolean {
            return finishFromCallback(consumeStoredOAuthCallback(expectedState));
        }

        // Listen for postMessage from the callback page
        function onMessage(e: MessageEvent) {
            if (e.origin !== window.location.origin) return;
            if (e.data?.type !== "mcp-oauth-callback") return;
            if (e.data.state !== expectedState) return;

            cleanup();
            if (e.data.error) {
                resolve(null);
            } else {
                resolve(e.data.code || null);
            }
        }

        function onStorage(e: StorageEvent) {
            if (e.key !== MCP_OAUTH_CALLBACK_STORAGE_KEY) return;
            checkStoredCallback();
        }

        window.addEventListener("message", onMessage);
        window.addEventListener("storage", onStorage);

        // Also poll for popup close (user closed manually)
        const closeCheck = setInterval(() => {
            if (checkStoredCallback()) return;
            if (popup.closed) {
                cleanup();
                resolve(null);
            }
        }, 1000);

        function cleanup() {
            clearTimeout(timeout);
            clearInterval(closeCheck);
            window.removeEventListener("message", onMessage);
            window.removeEventListener("storage", onStorage);
            try { popup?.close(); } catch { /* ignore */ }
        }
    });
}

// ── Format results for prompt injection ───────

export function formatToolResults(results: ToolResult[]): string {
    const items = results.map(r => {
        if (r.success && r.data) {
            return `<action_result name="${r.name}">${r.data}</action_result>`;
        }
        return `<action_result name="${r.name}" error="${r.error || "未知错误"}"></action_result>`;
    }).join("\n");
    return `以下是系统处理结果：\n${items}\n请基于以上结果，继续以角色身份回复用户。不要重复你之前已经说过的内容，不要再次执行相同的动作。`;
}
