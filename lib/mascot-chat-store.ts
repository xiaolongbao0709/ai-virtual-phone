import { getMascotContext, type MascotPageContext } from "./mascot-context";
import { mascotFillField } from "./mascot-events";
import {
    mascotChatWithTools,
    type MascotMsg,
} from "./mascot-engine";
import { PAGE_GREETINGS } from "./mascot-prompts";
import {
    buildMascotPackageSchemaPrompt,
    clearExpandedPackages,
    executeMascotToolCall,
    findPackageByLabel,
    getMascotNativeLoaderName,
    loadExpandedPackages,
    saveExpandedPackages,
    touchExpandedPackage,
    type MascotToolContext,
} from "./mascot-tools";
import { isMascotPanelOpen } from "./mascot-state";
import { updateMascotMemory } from "./mascot-memory";

const MASCOT_DB_NAME = "AiPhoneMascotDB";
const MASCOT_DB_VERSION = 2;
const MASCOT_CHAT_STORE = "chat";
const MASCOT_MESSAGES_KEY = "messages";
const MAX_STORED_MASCOT_MESSAGES = 50;

type MascotChatSnapshot = {
    messages: MascotMsg[];
    hydrated: boolean;
    isThinking: boolean;
};

const listeners = new Set<() => void>();
let messages: MascotMsg[] = [];
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let isThinking = false;
let abortRequested = false;
let abortController: AbortController | null = null;
let snapshot: MascotChatSnapshot = { messages, hydrated, isThinking };

function openMascotDb(): IDBOpenDBRequest {
    const request = indexedDB.open(MASCOT_DB_NAME, MASCOT_DB_VERSION);
    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(MASCOT_CHAT_STORE)) {
            request.result.createObjectStore(MASCOT_CHAT_STORE);
        }
    };
    return request;
}

function emit() {
    snapshot = { messages, hydrated, isThinking };
    for (const listener of listeners) listener();
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("mascot-chat-updated", { detail: snapshot }));
    }
}

function persistMessages(nextMessages: MascotMsg[]) {
    if (typeof indexedDB === "undefined") return;
    try {
        const req = openMascotDb();
        req.onsuccess = () => {
            try {
                if (!req.result.objectStoreNames.contains(MASCOT_CHAT_STORE)) return;
                const tx = req.result.transaction(MASCOT_CHAT_STORE, "readwrite");
                tx.objectStore(MASCOT_CHAT_STORE).put(nextMessages, MASCOT_MESSAGES_KEY);
            } catch {
                // Keep in-memory chat usable even if persistence fails.
            }
        };
    } catch {
        // Ignore IndexedDB availability issues.
    }
}

function withTimestamp(msg: MascotMsg): MascotMsg {
    return msg.createdAt ? msg : { ...msg, createdAt: new Date().toISOString() };
}

function normalizeMessages(nextMessages: MascotMsg[]): MascotMsg[] {
    return nextMessages.map(withTimestamp).slice(-MAX_STORED_MASCOT_MESSAGES);
}

export type ClearMascotToolHistoryResult = {
    messages: MascotMsg[];
    deletedMessages: number;
    cleanedMessages: number;
};

export type DeleteMascotMessageWithLinkedToolsResult = {
    messages: MascotMsg[];
    deletedMessages: number;
    cleanedMessages: number;
};

export function isMascotToolHistoryMessage(msg: MascotMsg): boolean {
    return msg.role === "tool";
}

export function hasMascotNativeToolReplayMetadata(msg: MascotMsg): boolean {
    return msg.toolCalls !== undefined
        || msg.reasoning !== undefined
        || msg.openRouterReasoningDetails !== undefined;
}

function hasVisibleMascotPayload(msg: MascotMsg): boolean {
    const display = (msg.displayText || "").trim();
    return !!msg.text.trim()
        || (!!display && display !== "（调用工具中...）" && display !== "（无内容）")
        || !!msg.images?.length;
}

export function hasMascotToolHistoryMessages(nextMessages: MascotMsg[]): boolean {
    return nextMessages.some((msg) => (
        isMascotToolHistoryMessage(msg) || hasMascotNativeToolReplayMetadata(msg)
    ));
}

export function clearMascotToolHistoryMessages(nextMessages: MascotMsg[]): ClearMascotToolHistoryResult {
    let deletedMessages = 0;
    let cleanedMessages = 0;
    const cleanedMessagesList: MascotMsg[] = [];

    for (const msg of nextMessages) {
        if (isMascotToolHistoryMessage(msg)) {
            deletedMessages += 1;
            continue;
        }

        if (!hasMascotNativeToolReplayMetadata(msg)) {
            cleanedMessagesList.push(msg);
            continue;
        }

        const cleaned: MascotMsg = { ...msg };
        delete cleaned.toolCalls;
        delete cleaned.reasoning;
        delete cleaned.openRouterReasoningDetails;

        if (msg.role === "mascot" && !hasVisibleMascotPayload(cleaned)) {
            deletedMessages += 1;
            continue;
        }

        cleanedMessages += 1;
        cleanedMessagesList.push(cleaned);
    }

    return { messages: cleanedMessagesList, deletedMessages, cleanedMessages };
}

function collectMascotToolCallIds(msg: MascotMsg): Set<string> {
    const ids = new Set<string>();
    if (msg.toolCallId) ids.add(msg.toolCallId);
    for (const call of msg.toolCalls || []) {
        if (call.id) ids.add(call.id);
    }
    return ids;
}

function removeToolCallsFromMascotMessage(msg: MascotMsg, idsToRemove: Set<string>): {
    message: MascotMsg | null;
    cleaned: boolean;
} {
    if (!msg.toolCalls?.length) return { message: msg, cleaned: false };

    const keptToolCalls = msg.toolCalls.filter((call) => !idsToRemove.has(call.id));
    if (keptToolCalls.length === msg.toolCalls.length) return { message: msg, cleaned: false };

    const cleaned: MascotMsg = { ...msg };
    if (keptToolCalls.length > 0) {
        cleaned.toolCalls = keptToolCalls;
    } else {
        delete cleaned.toolCalls;
    }

    if (!hasVisibleMascotPayload(cleaned) && !cleaned.toolCalls?.length) {
        return { message: null, cleaned: true };
    }

    return { message: cleaned, cleaned: true };
}

export function deleteMascotMessageWithLinkedTools(
    nextMessages: MascotMsg[],
    rawIndex: number,
): DeleteMascotMessageWithLinkedToolsResult {
    const target = nextMessages[rawIndex];
    if (!target) return { messages: nextMessages, deletedMessages: 0, cleanedMessages: 0 };

    const idsToRemove = collectMascotToolCallIds(target);
    const indexesToDelete = new Set<number>([rawIndex]);
    const replacements = new Map<number, MascotMsg>();
    let cleanedMessages = 0;

    if (idsToRemove.size > 0) {
        nextMessages.forEach((msg, index) => {
            if (index !== rawIndex && msg.role === "tool" && msg.toolCallId && idsToRemove.has(msg.toolCallId)) {
                indexesToDelete.add(index);
                return;
            }

            if (index !== rawIndex && msg.role === "mascot" && msg.toolCalls?.length) {
                const result = removeToolCallsFromMascotMessage(msg, idsToRemove);
                if (!result.cleaned) return;
                cleanedMessages += 1;
                if (result.message) {
                    replacements.set(index, result.message);
                } else {
                    indexesToDelete.add(index);
                }
            }
        });
    } else if (target.role === "mascot") {
        for (let i = rawIndex + 1; i < nextMessages.length; i += 1) {
            const msg = nextMessages[i];
            if (msg.role !== "tool") break;
            if (msg.toolCallId) break;
            indexesToDelete.add(i);
        }
    } else if (target.role === "tool") {
        for (let i = rawIndex - 1; i >= 0; i -= 1) {
            const msg = nextMessages[i];
            if (msg.role === "tool") continue;
            if (msg.role === "mascot" && !hasVisibleMascotPayload(msg)) indexesToDelete.add(i);
            break;
        }
    }

    let deletedMessages = 0;
    const messagesAfterDelete: MascotMsg[] = [];
    nextMessages.forEach((msg, index) => {
        if (indexesToDelete.has(index)) {
            deletedMessages += 1;
            return;
        }
        messagesAfterDelete.push(replacements.get(index) || msg);
    });

    return { messages: messagesAfterDelete, deletedMessages, cleanedMessages };
}

function publishMessages(nextMessages: MascotMsg[], options: { persist?: boolean } = {}) {
    messages = normalizeMessages(nextMessages);
    if (options.persist !== false) persistMessages(messages);
    emit();
}

function setThinking(next: boolean) {
    isThinking = next;
    emit();
}

export function subscribeMascotChat(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getMascotChatSnapshot(): MascotChatSnapshot {
    return snapshot;
}

export function setMascotMessages(updater: MascotMsg[] | ((prev: MascotMsg[]) => MascotMsg[])) {
    const next = typeof updater === "function" ? updater(messages) : updater;
    publishMessages(next);
}

function defaultGreetingMessage(): MascotMsg | null {
    const greeting = PAGE_GREETINGS["desktop"];
    return greeting ? { role: "mascot", text: greeting, createdAt: new Date().toISOString() } : null;
}

export function resetMascotConversation(options: { withGreeting?: boolean } = {}) {
    const withGreeting = options.withGreeting !== false;
    clearExpandedPackages();
    const greeting = withGreeting ? defaultGreetingMessage() : null;
    publishMessages(greeting ? [greeting] : []);
}

export async function hydrateMascotChat(): Promise<void> {
    if (hydratePromise) return hydratePromise;
    hydratePromise = new Promise<void>((resolve) => {
        if (typeof indexedDB === "undefined") {
            hydrated = true;
            const greeting = defaultGreetingMessage();
            messages = greeting ? [greeting] : [];
            emit();
            resolve();
            return;
        }
        const req = openMascotDb();
        req.onsuccess = () => {
            try {
                if (!req.result.objectStoreNames.contains(MASCOT_CHAT_STORE)) {
                    hydrated = true;
                    const greeting = defaultGreetingMessage();
                    messages = greeting ? [greeting] : [];
                    emit();
                    resolve();
                    return;
                }
                const tx = req.result.transaction(MASCOT_CHAT_STORE, "readonly");
                const get = tx.objectStore(MASCOT_CHAT_STORE).get(MASCOT_MESSAGES_KEY);
                get.onsuccess = () => {
                    const loaded = Array.isArray(get.result) ? normalizeMessages(get.result) : [];
                    const greeting = loaded.length > 0 ? null : defaultGreetingMessage();
                    messages = greeting ? [greeting] : loaded;
                    hydrated = true;
                    if (greeting) persistMessages(messages);
                    emit();
                    resolve();
                };
                get.onerror = () => {
                    hydrated = true;
                    emit();
                    resolve();
                };
            } catch {
                hydrated = true;
                emit();
                resolve();
            }
        };
        req.onerror = () => {
            hydrated = true;
            emit();
            resolve();
        };
    });
    return hydratePromise;
}

export function stopMascotGeneration() {
    abortRequested = true;
    abortController?.abort();
}

export async function sendMascotMessage({
    text,
    images = [],
    context = getMascotContext(),
}: {
    text: string;
    images?: string[];
    context?: MascotPageContext;
}): Promise<void> {
    await hydrateMascotChat();
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || isThinking) return;

    const userMsg: MascotMsg = images.length > 0
        ? { role: "user", text: trimmed, images, createdAt: new Date().toISOString() }
        : { role: "user", text: trimmed, createdAt: new Date().toISOString() };
    let workingMessages = normalizeMessages([...messages, userMsg]);
    publishMessages(workingMessages);
    setThinking(true);

    const MAX_ROUNDS = 8;
    abortRequested = false;
    const controller = new AbortController();
    abortController = controller;
    let expandedPackageIds = loadExpandedPackages();
    const toolCtx: MascotToolContext = { pageContext: context, history: workingMessages };

    try {
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
            if (abortRequested) break;

            let streamedDisplay = "";
            let lastStreamPaintAt = 0;
            let lastStreamPaintLength = 0;
            const streamToolIds = new Set<string>();
            const streamToolMessages: MascotMsg[] = [];
            const paintStream = async (force = false) => {
                const now = Date.now();
                if (!force && streamedDisplay.length - lastStreamPaintLength < 12 && now - lastStreamPaintAt < 50) return;
                lastStreamPaintAt = now;
                lastStreamPaintLength = streamedDisplay.length;
                const liveItems: MascotMsg[] = [];
                if (streamedDisplay.trim()) {
                    liveItems.push({
                        role: "mascot",
                        text: streamedDisplay,
                        displayText: streamedDisplay,
                        createdAt: new Date().toISOString(),
                    });
                }
                liveItems.push(...streamToolMessages.map(withTimestamp));
                publishMessages([...workingMessages, ...liveItems], { persist: false });
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            };

            const response = await mascotChatWithTools(
                context,
                workingMessages,
                expandedPackageIds,
                {
                    signal: controller.signal,
                    callbacks: {
                        async onAssistantDelta(delta) {
                            if (!delta) return;
                            streamedDisplay += delta;
                            await paintStream(false);
                        },
                        async onToolCallStart(info) {
                            if (streamToolIds.has(info.id)) return;
                            streamToolIds.add(info.id);
                            streamToolMessages.push({
                                role: "tool",
                                text: "",
                                hidden: false,
                                displayText: `正在调用 ${info.name}…`,
                                toolName: info.name,
                                toolDisplayName: info.name,
                                createdAt: new Date().toISOString(),
                            });
                            await paintStream(true);
                        },
                        async onStreamFallback(reason) {
                            console.warn("[Mascot] 流式输出不可用，已切换普通生成:", reason);
                        },
                    },
                },
            );
            if (streamedDisplay) await paintStream(true);

            const displayReply = response.reply.join("\n");
            const assistantMsg: MascotMsg = {
                role: "mascot",
                text: response.rawAssistant,
                displayText: displayReply || (response.toolCalls.length > 0 || response.toolFetches.length > 0 ? "（调用工具中...）" : "（无内容）"),
                createdAt: new Date().toISOString(),
            };
            if (response.protocol === "native" && response.nativeToolCalls && response.nativeToolCalls.length > 0) {
                assistantMsg.toolCalls = response.nativeToolCalls;
            }
            if (response.protocol === "native" && response.reasoning) {
                assistantMsg.reasoning = response.reasoning;
            }
            if (response.protocol === "native" && response.openRouterReasoningDetails?.length) {
                assistantMsg.openRouterReasoningDetails = response.openRouterReasoningDetails;
            }
            workingMessages = normalizeMessages([...workingMessages, assistantMsg]);
            publishMessages(workingMessages);

            if (response.toolFetches.length > 0) {
                for (const fetch of response.toolFetches) {
                    const pkg = findPackageByLabel(fetch.name);
                    if (!pkg) continue;
                    expandedPackageIds = touchExpandedPackage(expandedPackageIds, pkg.id);
                    saveExpandedPackages(expandedPackageIds);

                    const guideContent = `「${pkg.label}」已展开，详细动作如下：\n${buildMascotPackageSchemaPrompt(pkg.label, response.protocol)}`;

                    if (response.protocol === "native") {
                        const loaderName = getMascotNativeLoaderName(pkg.id);
                        const loaderCall = response.nativeToolCalls?.find((call) => call.name === loaderName);
                        workingMessages = normalizeMessages([...workingMessages, {
                            role: "tool",
                            text: guideContent,
                            hidden: false,
                            displayText: `展开「${pkg.label}」工具集`,
                            toolCallId: loaderCall?.id || "",
                            toolName: loaderCall?.name || loaderName,
                            toolDisplayName: `展开${pkg.label}`,
                            toolSuccess: true,
                            createdAt: new Date().toISOString(),
                        }]);
                    } else {
                        workingMessages = normalizeMessages([...workingMessages, {
                            role: "tool",
                            text: guideContent,
                            hidden: false,
                            displayText: `展开「${pkg.label}」工具集`,
                            toolName: `展开${pkg.label}`,
                            toolDisplayName: `展开${pkg.label}`,
                            toolSuccess: true,
                            createdAt: new Date().toISOString(),
                        }]);
                    }
                    publishMessages(workingMessages);
                }
                continue;
            }

            if (response.toolCalls.length > 0) {
                const roundResults: Array<{ continueConversation?: boolean }> = [];
                for (let i = 0; i < response.toolCalls.length; i += 1) {
                    const call = response.toolCalls[i];
                    const nativeCall = response.protocol === "native"
                        ? response.nativeToolCalls?.[i]
                        : undefined;
                    const displayName = call.name;
                    const protocolName = nativeCall?.name || call.name;

                    const runningMessage: MascotMsg = {
                        role: "tool",
                        text: "",
                        hidden: false,
                        displayText: `正在调用 ${displayName}…`,
                        toolName: protocolName,
                        toolDisplayName: displayName,
                        createdAt: new Date().toISOString(),
                    };
                    workingMessages = normalizeMessages([...workingMessages, runningMessage]);
                    const runningIdx = workingMessages.length - 1;
                    publishMessages(workingMessages);
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

                    const result = await executeMascotToolCall(call, { ...toolCtx, history: workingMessages });
                    roundResults.push(result);
                    if (result.success) mascotFillField({ field: call.name, value: result.data || "" });

                    const resultText = result.success ? (result.data || "完成") : (result.error || "未知错误");
                    const updated = [...workingMessages];
                    updated[runningIdx] = {
                        role: "tool",
                        text: resultText,
                        hidden: false,
                        displayText: resultText,
                        images: result.mediaAttachments?.filter((attachment) => attachment.type === "image").map((attachment) => attachment.url),
                        toolCallId: nativeCall?.id || "",
                        toolName: protocolName,
                        toolDisplayName: displayName,
                        toolSuccess: result.success,
                        createdAt: updated[runningIdx]?.createdAt || new Date().toISOString(),
                    };
                    workingMessages = normalizeMessages(updated);
                    publishMessages(workingMessages);
                }
                // 若本轮所有工具都标记为终态（如导航），不再发起后续 LLM 轮次
                if (roundResults.length > 0 && roundResults.every((r) => r.continueConversation === false)) break;
                continue;
            }

            break;
        }

        if (abortRequested) {
            publishMessages([...workingMessages, { role: "user", text: "[用户中止了操作]", hidden: false, createdAt: new Date().toISOString() }]);
        }
        if (!isMascotPanelOpen() && typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("global-notice", { detail: abortRequested ? "操作已中止" : "AI助手已完成操作 ✓" }));
        }
    } catch (err) {
        if ((err as Error).name !== "AbortError" && !abortRequested) {
            publishMessages([...workingMessages, { role: "mascot", text: `出错了...${(err as Error).message}`, createdAt: new Date().toISOString() }]);
            if (!isMascotPanelOpen() && typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("global-notice", { detail: "AI助手生成失败了..." }));
            }
        }
    } finally {
        setThinking(false);
        abortController = null;
        // 更新小卷长期记忆（仅记录实质性对话，过滤导航/问候等短消息）
        if (trimmed.length > 15) {
            updateMascotMemory(trimmed);
        }
    }
}

export function getMascotLastPreview(): string {
    const latest = [...messages].reverse().find((msg) => {
        if (msg.hidden || msg.role === "tool") return false;
        const text = (msg.displayText || msg.text || "").trim();
        return !!text && text !== "（调用工具中...）" && text !== "（无内容）";
    });
    if (!latest) return "可以帮你创建角色、预设、正则和 CSS";
    if (latest.role === "user") return latest.images?.length ? "[图片] " + latest.text : latest.text;
    return latest.displayText || latest.text;
}
