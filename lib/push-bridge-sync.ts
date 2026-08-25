// 现实桥离线联动·客户端同步器：
// 把规则/云配置/触发状态 + 每条「让TA回话」规则的 prompt 快照（带占位哨兵）
// 同步到服务端。快照用前台同一条组装链路构建，服务端只做占位符替换。
// 触发时机：规则变更、App 切后台、启动后延迟一次。内容没变则跳过上传。

import { buildChatPromptMessages } from "./chat-engine";
import { buildProviderRequest, toLlmRequestMessages } from "./llm-provider-adapter";
import {
    CHAT_MESSAGES_DELETED_EVENT,
    CHAT_MESSAGE_PUSHED_EVENT,
    createOrGetSession,
    addChatContact,
    loadChatContacts,
    type ChatMessage,
    loadChatMessages,
} from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { kvGet, kvSet } from "./kv-db";
import {
    BRIDGE_EVENT_SENTINEL,
    SCREEN_CHAT_SENTINEL,
    SCREEN_CHAT_SNAPSHOT_ID,
    type ServerBridgeRule,
} from "./push-bridge-shared";
import { hasAccountPushSubscription } from "./push-client";
import {
    buildOfflineShortcutContinuation,
    listOfflineShortcutActions,
    maybeAppendShortcutCapability,
    maybeAppendWeixinChannel,
} from "./offline-shortcut-capability";
import {
    isPersonalPushCloudActive,
    isPersonalScreenChatCloudReady,
    personalPushFetch,
} from "./personal-push-cloud";
import { isSelfHostedModeEnabled } from "./self-hosting";
import { loadApiConfigs, resolveAuxiliaryApiConfig } from "./settings-storage";
import {
    bridgeConnection,
    getBridgeRuleRunsMap,
    loadBridgeRules,
    loadBridgeSettings,
    loadBridgeShortcutActions,
    loadScreenChatSettings,
    loadScreenChatAck,
} from "./reality-bridge/storage";
import type { BridgeRule } from "./reality-bridge/types";

const SYNC_HASH_KV = "push_bridge_sync_hash_v1";
let syncing = false;
let debounceTimer: number | null = null;

function ensureSessionFor(characterId: string) {
    if (!loadChatContacts().some(contact => contact.characterId === characterId)) {
        addChatContact(characterId);
    }
    return createOrGetSession(characterId);
}

function toServerRule(rule: BridgeRule): (ServerBridgeRule & { actions: BridgeRule["actions"] }) | null {
    const chat = rule.actions?.chat;
    let chatMeta: ServerBridgeRule["chat"];
    if (chat?.characterId) {
        const session = ensureSessionFor(chat.characterId);
        const characterName = loadCharacters().find(c => c.id === chat.characterId)?.name ?? "小手机";
        chatMeta = {
            characterId: chat.characterId,
            sessionId: session.id,
            role: chat.role,
            historyRole: chat.historyRole,
            requestReply: chat.requestReply === true,
            characterName,
        };
    }
    // 出站快捷动作：把本机配置解析成服务端可直接执行的快照（仅推送模式）
    const shortcutAction = rule.actions?.shortcut?.actionId
        ? loadBridgeShortcutActions().find(entry =>
            entry.id === rule.actions?.shortcut?.actionId && entry.enabled && entry.deliveryMode !== "email")
        : undefined;
    const shortcutMeta: ServerBridgeRule["shortcut"] = shortcutAction
        ? {
            actionId: shortcutAction.id,
            name: shortcutAction.name,
            shortcutName: shortcutAction.shortcutName,
            resultMode: shortcutAction.resultMode,
            expiresInSeconds: shortcutAction.expiresInSeconds,
        }
        : undefined;
    const deferredActions = Object.entries(rule.actions ?? {})
        .filter(([key, value]) => value && key !== "chat" && key !== "notify" && key !== "shortcut")
        .map(([key]) => key);
    return {
        id: rule.id,
        name: rule.name,
        matchType: rule.matchType,
        cooldownMinutes: rule.cooldownMinutes,
        process: { mode: rule.process?.mode ?? "raw", template: rule.process?.template },
        chat: chatMeta,
        notify: rule.actions?.notify === true,
        shortcut: shortcutMeta,
        deferredActions,
        actions: rule.actions ?? {},
    };
}

/** 为一条「让TA回话」规则构建 prompt 快照：正文=聊天上下文+占位哨兵消息。 */
async function buildRuleSnapshot(rule: BridgeRule): Promise<Record<string, unknown> | null> {
    const chat = rule.actions?.chat;
    if (!chat?.characterId || !chat.requestReply) return null;
    try {
        const session = ensureSessionFor(chat.characterId);
        const history = loadChatMessages(session.id);
        const historyRole = chat.historyRole && chat.historyRole !== chat.role ? chat.historyRole : undefined;
        const synthetic: ChatMessage = {
            id: `_bridge_sentinel_${rule.id}`,
            sessionId: session.id,
            role: chat.role,
            content: BRIDGE_EVENT_SENTINEL,
            status: "sent",
            createdAt: new Date().toISOString(),
            ...(historyRole ? { mediaData: { appHistoryRole: historyRole } as ChatMessage["mediaData"] } : {}),
        };
        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            [...history, synthetic],
            { appTags: ["chat", "text"] },
        );
        maybeAppendShortcutCapability(llmMessages);
        const weixinBotId = maybeAppendWeixinChannel(llmMessages, chat.characterId);
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
            const req = buildProviderRequest(config, preset, toLlmRequestMessages(messages));
            return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
        });

        // ai 加工模式：预挂一个轻量加工请求（提示词里的 {payload} 也换成哨兵）
        let processRequest: Record<string, unknown> | undefined;
        if (rule.process?.mode === "ai" && rule.process.prompt) {
            const auxConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") ?? loadApiConfigs()[0];
            if (auxConfig) {
                const promptWithSentinel = rule.process.prompt
                    .replace(/\{payload\}/g, BRIDGE_EVENT_SENTINEL)
                    .replace(/\{type\}/g, rule.matchType === "*" ? "数据" : rule.matchType);
                const processReq = buildProviderRequest(auxConfig, null, [
                    { role: "system", content: "你是「现实桥」的数据加工器。按用户指令处理数据，只输出处理结果本身，不要解释。" },
                    { role: "user", content: `${promptWithSentinel}\n\n数据内容：${BRIDGE_EVENT_SENTINEL}` },
                ]);
                processRequest = {
                    url: processReq.url,
                    headers: processReq.headers,
                    body: processReq.body,
                    providerKind: processReq.providerKind,
                };
            }
        }

        return {
            replyRequest: {
                url: request.url,
                headers: request.headers,
                body: request.body,
                providerKind: request.providerKind,
            },
            ...(weixinBotId ? { weixin: { botId: weixinBotId } } : {}),
            ...(shortcutContinuation ? { shortcutContinuation } : {}),
            ...(processRequest ? { processRequest } : {}),
            reply: {
                sessionId: session.id,
                regexes,
                characterName: character.name,
                userName: userIdentity?.name ?? "用户",
                appId: "chat",
                appTags: ["chat", "text"],
            },
        };
    } catch (err) {
        console.warn("[BridgeSync] snapshot build failed for rule:", rule.name, err);
        return null;
    }
}

/** 屏幕速聊 prompt 快照：与联动规则快照同链路（rule_id 固定为 screen-chat），
 *  正文 = 所选角色的完整聊天上下文 + 对话占位哨兵；screen-chat 函数只做替换与注图。 */
async function buildScreenChatSnapshot(): Promise<Record<string, unknown> | null> {
    const screen = loadScreenChatSettings();
    if (!screen.enabled || !screen.characterId) return null;
    try {
        const session = ensureSessionFor(screen.characterId);
        const history = loadChatMessages(session.id);
        const synthetic: ChatMessage = {
            id: "_screen_chat_sentinel",
            sessionId: session.id,
            role: "user",
            content: SCREEN_CHAT_SENTINEL,
            status: "sent",
            createdAt: new Date().toISOString(),
        };
        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            [...history, synthetic],
            { appTags: ["chat", "text"] },
        );
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        return {
            replyRequest: {
                url: request.url,
                headers: request.headers,
                body: request.body,
                providerKind: request.providerKind,
            },
            // 图像识别开关跟随该角色绑定的 API 配置：开 = 服务端注入截图，关 = 代入 OCR 文字
            enableVision: config.enableImageRecognition === true,
            // 云端只保留尚未回端的增量；已合并轮次由该水位裁掉，避免和完整本地历史重复。
            ackSequence: loadScreenChatAck(screen.characterId),
            chat: { characterId: screen.characterId, sessionId: session.id, characterName: character.name },
            reply: {
                sessionId: session.id,
                regexes,
                characterName: character.name,
                userName: userIdentity?.name ?? "用户",
                appId: "chat",
                appTags: ["chat", "text"],
            },
        };
    } catch (err) {
        console.warn("[BridgeSync] screen chat snapshot build failed", err);
        return null;
    }
}

async function runSync(): Promise<void> {
    if (syncing || typeof window === "undefined") return;
    syncing = true;
    try {
        const settings = loadBridgeSettings();
        const screenSettings = loadScreenChatSettings();
        const { config: cloudConfig, ready } = bridgeConnection();
        const usePersonal = isPersonalPushCloudActive();
        const screenCloudReady = isPersonalScreenChatCloudReady();
        if ((!settings.enabled && !screenSettings.enabled) || !ready) return;
        // 自部署站点没有共享回传身份，但配置好个人云后应完整支持规则和屏幕速聊。
        if (isSelfHostedModeEnabled() && !usePersonal) return;
        // 屏幕速聊不依赖推送订阅（快捷指令直连 screen-chat 函数），启用时照常同步快照
        if (!screenSettings.enabled && !(await hasAccountPushSubscription())) return;

        const rules = settings.enabled ? loadBridgeRules().filter(rule => rule.enabled) : [];
        const serverRules = rules.map(toServerRule).filter(Boolean);
        const ruleRuns = getBridgeRuleRunsMap();

        // 离线快捷动作目录：角色离线回复里的【快捷动作：名称】按它匹配执行
        const shortcutActions = listOfflineShortcutActions();

        // 内容指纹：触发状态也必须参与，否则本地刚执行过的规则不会刷新服务端冷却。
        const configFingerprint = JSON.stringify({
            serverRules,
            cloud: { url: cloudConfig.url, key: cloudConfig.key },
            ruleRuns,
            shortcutActions,
        });
        const snapshotRules = rules.filter(rule => rule.actions?.chat?.requestReply);
        const snapshots: { ruleId: string; payload: Record<string, unknown> }[] = [];
        for (const rule of snapshotRules) {
            const payload = await buildRuleSnapshot(rule);
            if (payload) snapshots.push({ ruleId: rule.id, payload });
        }
        // 屏幕截图和包含 API 密钥的生成快照绝不允许回退到站点主项目。
        const screenSnapshot = usePersonal && screenCloudReady ? await buildScreenChatSnapshot() : null;
        if (screenSnapshot) snapshots.push({ ruleId: SCREEN_CHAT_SNAPSHOT_ID, payload: screenSnapshot });
        // 个人云激活时规则/快照落到用户自己的库（push-bridge 也部署在那边）；
        // 指纹带上通道标记，切换通道后必然重传一次。
        const fullFingerprint = `${usePersonal ? "p" : "s"}:${hashString(configFingerprint)}:${hashString(JSON.stringify(snapshots))}`;
        if (kvGet(SYNC_HASH_KV) === fullFingerprint) return;

        const knownIds = new Set(snapshotRules.map(rule => rule.id));
        const allRuleIds = loadBridgeRules().map(rule => rule.id);
        const deleteRuleIds = allRuleIds.filter(id => !knownIds.has(id));
        // 屏幕速聊被关闭（或角色未选）时删除服务端快照，令 screen-chat 入口随之失效
        // 只在个人云上管理保留的屏幕快照；共享站点从不收发这项数据。
        if (usePersonal && !screenSnapshot) deleteRuleIds.push(SCREEN_CHAT_SNAPSHOT_ID);

        if (usePersonal) {
            const response = await personalPushFetch("bridge-sync", {
                method: "POST",
                body: JSON.stringify({
                    rules: serverRules,
                    cloudConfig: { url: cloudConfig.url, key: cloudConfig.key },
                    ruleRuns,
                    shortcutActions,
                    snapshots,
                    deleteRuleIds,
                }),
            }).catch(() => null);
            if (response?.ok) kvSet(SYNC_HASH_KV, fullFingerprint);
            return;
        }

        const configResponse = await fetch("/api/push/bridge-config", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                rules: serverRules,
                cloudConfig: { url: cloudConfig.url, key: cloudConfig.key },
                ruleRuns,
            }),
        }).catch(() => null);
        if (!configResponse || !configResponse.ok) return;

        const snapshotResponse = await fetch("/api/push/bridge-snapshots", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ snapshots, deleteRuleIds }),
        }).catch(() => null);
        if (snapshotResponse && snapshotResponse.ok) {
            kvSet(SYNC_HASH_KV, fullFingerprint);
        }
    } finally {
        syncing = false;
    }
}

function hashString(input: string): string {
    let hash = 5381;
    for (let i = 0; i < input.length; i += 1) {
        hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36) + ":" + input.length.toString(36);
}

function scheduleSync(delayMs: number): void {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void runSync();
    }, delayMs);
}

/** 安装同步钩子：规则变更 / 切后台 / 启动后一次。 */
export function installBridgeServerSync(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("reality-bridge-rules-updated", () => scheduleSync(3_000));
    // 唯一聊天窗口一有新增/删除/外部合并就刷新基础快照，云端始终接着本地最新上下文。
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, () => scheduleSync(3_000));
    window.addEventListener(CHAT_MESSAGES_DELETED_EVENT, () => scheduleSync(3_000));
    window.addEventListener("chat-messages-updated", () => scheduleSync(3_000));
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) void runSync();
    });
    scheduleSync(15_000);
}
