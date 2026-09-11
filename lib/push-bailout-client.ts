// 离线推送·兜底预约（客户端侧）：
// 追问排期时把「组装好的完整请求快照」预约到服务端；本地正常触发就撤销，
// App 被杀则由服务端 cron 到点接管生成并推送。组装用的就是前台同一条
// buildChatPromptMessages → buildProviderRequest 链路，零新逻辑。

import { bgSetInterval } from "./bg-timer";
import { buildChatPromptMessages } from "./chat-engine";
import { buildProviderRequest, toLlmRequestMessages, type LlmRequestPayload } from "./llm-provider-adapter";
import { loadChatMessages, loadChatSessions, loadFollowUpSchedule, type ChatMessage, type ChatSession } from "./chat-storage";
import { hasAccountPushSubscription, isWithinPushQuietHours, loadPushQuietHours, peekAccountPushSubscribed } from "./push-client";
import { isPersonalPushCloudActive, pushJobsFetch } from "./personal-push-cloud";
import {
    buildOfflineShortcutContinuation,
    maybeAppendShortcutCapability,
    maybeAppendWeixinChannel,
    type OfflineShortcutContinuation,
} from "./offline-shortcut-capability";
import {
    getMenstrualPeriodCareEvent,
    hasMenstrualPeriodCareTriggered,
    loadMenstrualConfig,
    loadMenstrualRecords,
} from "./menstrual-storage";
import { loadTimedWakeSchedules, type TimedWakeSchedule } from "./timed-wake-storage";
import {
    IDLE_RECONNECT_MAX_CONSECUTIVE,
    loadIdleReconnectRules,
    type IdleReconnectRule,
} from "./idle-reconnect-storage";
import { loadCharacters } from "./character-storage";
import type { RegexConfig } from "./settings-types";
import type { LLMMessage } from "./llm-prompt-assembler";

// ── 离线来电：让 AI 自己决定"这条主动消息要不要改成打电话" ──────────
// 只在主动类离线任务（冷场重连/定时唤醒）的生成快照里注入一句能力说明；
// AI 使用小手机既有的「[我向用户名发起了语音通话]」格式时，
// 由 push-generate 以来电形式投递；服务端仍兼容旧的【拨打电话】标记。
// 频控在客户端：同一角色约 20 小时内只授权一次，防止模型学会了天天打。
// 安静时段无需在此处理——这两类任务落在安静时段根本不会预约（见上方门控）。

const CALL_INVITE_WINDOW_MS = 20 * 60 * 60 * 1000;
const CALL_INVITE_STORE_KEY = "ai_phone_call_invite_armed_v1";

const CALL_INVITE_INSTRUCTION = "（可选能力：如果你此刻更想直接给对方打语音电话——想念、着急、有情绪、"
    + "或者事情几句话说不清——就在回复的第一行使用你已有的小手机通话格式：[我向当前聊天对象发起了语音通话]，"
    + "其中聊天对象按当前用户填写；从第二行开始写你接通后要说的话。"
    + "不适合打电话就正常发消息。无论选哪种，都不要提及本条说明。）";

function readCallInviteArmedMap(): Record<string, number> {
    try {
        const raw = localStorage.getItem(CALL_INVITE_STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
    } catch {
        return {};
    }
}

/** 尝试为该角色的生成快照追加"可以打电话"的能力说明；频控窗口内返回 false 不追加。 */
function maybeAppendCallInvite(llmMessages: LLMMessage[], characterId: string): boolean {
    try {
        const map = readCallInviteArmedMap();
        const last = map[characterId] ?? 0;
        if (Date.now() - last < CALL_INVITE_WINDOW_MS) return false;
        llmMessages.push({ role: "system", content: CALL_INVITE_INSTRUCTION });
        map[characterId] = Date.now();
        // 顺手清理超窗旧记录，防止无限增长
        for (const key of Object.keys(map)) {
            if (Date.now() - map[key] > CALL_INVITE_WINDOW_MS * 2) delete map[key];
        }
        localStorage.setItem(CALL_INVITE_STORE_KEY, JSON.stringify(map));
        return true;
    } catch {
        return false;
    }
}

/** 追问兜底宽限：本地触发开始后有心跳续约，宽限只需覆盖「客户端整个死了」的场景。 */
export const FOLLOWUP_BAILOUT_GRACE_MS = 15_000;

/** 发送兜底租约：心跳每 30s 一跳把接管时刻推到 now+90s，为后台定时器降频留足抖动空间。 */
export const REPLY_BAILOUT_LEASE_MS = 90_000;

const HEARTBEAT_INTERVAL_MS = 30_000;

export type BailoutArmResult =
    | { ok: true }
    | { ok: false; reason: string };

function bailoutEnabled(): boolean {
    // 离线任务只写用户自己的个人云；单机自部署与账号站点使用同一链路。
    return typeof window !== "undefined" && isPersonalPushCloudActive();
}

function resolveTimedWakeElapsedMinutes(schedule: TimedWakeSchedule, history: ChatMessage[]): number {
    if (schedule.source === "user") {
        const lastUser = [...history].reverse().find(message => message.role === "user");
        const lastUserAt = lastUser ? Date.parse(lastUser.createdAt) : schedule.createdAt;
        return Math.max(1, Math.round((schedule.fireAt - lastUserAt) / 60000));
    }
    return Math.max(1, Math.round((schedule.fireAt - schedule.createdAt) / 60000));
}

/** 本地生成期间给兜底预约续命；返回停止函数。 */
export function startBailoutHeartbeat(triggerKey: string): () => void {
    if (!bailoutEnabled()) return () => undefined;
    const beat = () => {
        void pushJobsFetch({
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ triggerKey }),
        }).catch(() => undefined);
    };
    return bgSetInterval(beat, HEARTBEAT_INTERVAL_MS);
}

export type ReplyBailoutHandle = { settle: () => void };

/**
 * 发送兜底：本地开始生成回复的同时，把同一份请求快照（无工具的非流式孪生）
 * 预约到服务端，租约 90s、心跳续命。本地完成（成功或失败）即撤销；
 * App 被杀则心跳停跳，约 90s+扫描间隔后服务端接管生成并推送。
 */
export async function armReplyBailout(params: {
    sessionId: string;
    characterName: string;
    userName?: string;
    regexes: RegexConfig[];
    request: Pick<LlmRequestPayload, "url" | "headers" | "body" | "providerKind">;
    /** 云回复必须排在这条本地输入之后；跨设备排序不能只依赖两边时钟。 */
    replyAfter?: { localMessageId: string; createdAt: string };
    signal?: AbortSignal;
}): Promise<ReplyBailoutHandle | null> {
    if (!bailoutEnabled()) return null;
    if (!(await hasAccountPushSubscription())) return null;
    if (params.signal?.aborted) return null;

    const triggerKey = `reply:${params.sessionId}`;
    const armAt = new Date().toISOString();
    const response = await pushJobsFetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            triggerKey,
            kind: "reply_bailout",
            executeAt: new Date(Date.now() + REPLY_BAILOUT_LEASE_MS).toISOString(),
            payload: {
                request: {
                    url: params.request.url,
                    headers: params.request.headers,
                    body: params.request.body,
                    providerKind: params.request.providerKind,
                },
                notify: { title: params.characterName, url: "/" },
                merge: {
                    sessionId: params.sessionId,
                    prevCount: 0,
                    regexes: params.regexes,
                    characterName: params.characterName,
                    userName: params.userName ?? "用户",
                    appId: "chat",
                    appTags: ["chat", "text"],
                    armAt,
                    ...(params.replyAfter?.localMessageId
                        ? {
                            replyAfterLocalMessageId: params.replyAfter.localMessageId,
                            replyAfterCreatedAt: params.replyAfter.createdAt,
                        }
                        : {}),
                },
            },
        }),
    }).catch(() => null);
    if (!response || !response.ok) {
        // 413 = 快照超过服务端 900KB 上限（提示词太大/贴图太多）。以前这里
        // 完全静默，用户只会发现"App 被杀后没收到回复"却查不到原因。
        if (response) console.warn("[PushBailout] 回复兜底预约失败：HTTP", response.status);
        return null;
    }
    if (params.signal?.aborted) {
        await deleteBailoutJob(triggerKey);
        return null;
    }

    const stopHeartbeat = startBailoutHeartbeat(triggerKey);
    let settled = false;
    let detachAbort: (() => void) | null = null;
    const settle = () => {
        if (settled) return;
        settled = true;
        stopHeartbeat();
        detachAbort?.();
        void deleteBailoutJob(triggerKey);
    };
    if (params.signal) {
        const onAbort = () => settle();
        params.signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => params.signal?.removeEventListener("abort", onAbort);
    }
    return {
        settle,
    };
}

async function deleteBailoutJob(triggerKey: string): Promise<void> {
    await pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerKey }),
    }).catch(() => undefined);
}

/** 复刻 fireFollowUp 的沉默标记注入，但时间基准取"预约触发时刻"而非现在。 */
export function buildFollowUpSilenceMessages(
    session: ChatSession,
    latestMessages: ChatMessage[],
    atMs: number,
): ChatMessage[] {
    const lastUserMsg = [...latestMessages].reverse().find(m => m.role === "user");
    const lastUserTime = lastUserMsg ? new Date(lastUserMsg.createdAt).getTime() : atMs;

    const annotated: ChatMessage[] = [];
    let currentRound = 0;
    for (const msg of latestMessages) {
        if (msg.role === "assistant" && msg.followUpIndex && msg.followUpIndex > currentRound) {
            currentRound = msg.followUpIndex;
            const markerTime = new Date(msg.createdAt).getTime();
            const silenceSec = Math.round((markerTime - lastUserTime) / 1000);
            annotated.push({
                id: `_marker_${currentRound}_${atMs}`,
                sessionId: session.id,
                role: "user",
                content: `[对方没有回复你的消息，距上次回复已过约${silenceSec}秒]`,
                status: "sent",
                createdAt: msg.createdAt,
            });
        }
        annotated.push(msg);
    }

    const finalSilenceSec = Math.round((atMs - lastUserTime) / 1000);
    return [
        ...annotated,
        {
            id: `_silence_${atMs}`,
            sessionId: session.id,
            role: "system",
            content: `[对方没有回复你的消息，距上次回复已过约${finalSilenceSec}秒]`,
            status: "sent",
            createdAt: new Date(atMs).toISOString(),
        },
    ];
}

/** 追问排期后挂兜底预约。失败静默（网络/未登录都不影响本地追问）。 */
export async function armFollowUpBailout(
    sessionId: string,
    prevCount: number,
    delaySec: number,
    fireAt: number,
): Promise<void> {
    if (!bailoutEnabled()) return;
    try {
        if (!(await hasAccountPushSubscription())) return;
        if (isWithinPushQuietHours(fireAt + FOLLOWUP_BAILOUT_GRACE_MS)) return; // 安静时段不打扰
        const session = loadChatSessions().find(s => s.id === sessionId);
        if (!session || session.isGroup) return; // 第一期只覆盖单聊追问
        const latestMessages = loadChatMessages(sessionId);
        const count = prevCount + 1;
        const messagesWithHint = buildFollowUpSilenceMessages(session, latestMessages, fireAt);

        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            messagesWithHint,
            { appTags: ["chat", "text", "followup"], followUpCount: count, followUpDelay: delaySec },
        );
        // 无原生工具重放：服务端执行不了本地工具循环，兜底生成按纯补全组装。
        // 但标记式快捷动作云端是支持的（push-generate 解析【快捷动作：名称】），
        // 所以照常注入动作目录，别让角色在离线追问里以为自己什么都做不了。
        maybeAppendShortcutCapability(llmMessages, { continuationAvailable: true });
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
            const req = buildProviderRequest(config, preset, toLlmRequestMessages(messages));
            return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
        }, config.enableImageRecognition === true);

        // 组装耗时不短——上传前复核排期还在且没被改过（用户可能已回复触发了取消）
        const latestSchedule = loadFollowUpSchedule(sessionId);
        if (!latestSchedule || latestSchedule.count !== prevCount || Math.abs(latestSchedule.fireAt - fireAt) > 1000) return;

        await pushJobsFetch({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                triggerKey: `followup:${sessionId}:${count}`,
                kind: "followup",
                executeAt: new Date(fireAt + FOLLOWUP_BAILOUT_GRACE_MS).toISOString(),
                payload: {
                    request: {
                        url: request.url,
                        headers: request.headers,
                        body: request.body,
                        providerKind: request.providerKind,
                    },
                    notify: { title: character.name, url: "/" },
                    ...(shortcutContinuation ? { shortcutContinuation } : {}),
                    merge: {
                        sessionId,
                        followUpIndex: count,
                        prevCount,
                        regexes,
                        characterName: character.name,
                        userName: userIdentity?.name ?? "用户",
                        appId: "chat",
                        appTags: ["chat", "text", "followup"],
                        followUpCount: count,
                    },
                },
            }),
        });
    } catch (err) {
        console.warn("[PushBailout] arm failed:", err);
    }
}

/** 通用预约上传：组装快照 → POST 服务端任务。返回是否成功。 */
async function postBailoutJob(input: {
    triggerKey: string;
    kind: "followup" | "reply_bailout" | "timed_task";
    executeAtMs: number;
    request: Pick<LlmRequestPayload, "url" | "headers" | "body" | "providerKind">;
    notifyTitle: string;
    merge: Record<string, unknown>;
    weixinBotId?: string;
    shortcutContinuation?: OfflineShortcutContinuation | null;
}): Promise<boolean> {
    const response = await pushJobsFetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            triggerKey: input.triggerKey,
            kind: input.kind,
            executeAt: new Date(input.executeAtMs).toISOString(),
            payload: {
                request: {
                    url: input.request.url,
                    headers: input.request.headers,
                    body: input.request.body,
                    providerKind: input.request.providerKind,
                },
                notify: { title: input.notifyTitle, url: "/" },
                ...(input.weixinBotId ? { weixin: { botId: input.weixinBotId } } : {}),
                ...(input.shortcutContinuation ? { shortcutContinuation: input.shortcutContinuation } : {}),
                merge: input.merge,
            },
        }),
    }).catch(() => null);
    return Boolean(response && response.ok);
}

/** 撤销任意兜底预约（精确键）。 */
export function cancelBailoutKey(triggerKey: string): void {
    if (!bailoutEnabled()) return;
    if (peekAccountPushSubscribed() === false) return;
    void pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerKey }),
    }).catch(() => undefined);
}

/** 撤销一批兜底预约（前缀）。excludeKey 可保留一个刚挂上的新键（先挂后清模式）。
 *  返回 Promise 以便调用方在重挂前先等撤销落地。 */
export async function cancelBailoutPrefix(triggerPrefix: string, excludeKey?: string): Promise<void> {
    if (!bailoutEnabled()) return;
    if (peekAccountPushSubscribed() === false) return;
    await pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(excludeKey ? { triggerPrefix, excludeKey } : { triggerPrefix }),
    }).catch(() => undefined);
}

/** 把本地安静时段设置编成服务端可用的窗口（分钟制 + 时区偏移），未启用返回 null。 */
function buildQuietWindowMeta(): { startMin: number; endMin: number; tzOffsetMin: number } | null {
    const match = loadPushQuietHours().match(/^(\d{1,2}):(\d{2})\s*[-~—]\s*(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return {
        startMin: Number(match[1]) * 60 + Number(match[2]),
        endMin: Number(match[3]) * 60 + Number(match[4]),
        tzOffsetMin: -new Date().getTimezoneOffset(),
    };
}

/** 冷场重连兜底：按「用户最后一条消息 + 间隔」预约服务端触发；
 *  服务端触发一次后会自动排下一发（连发上限内），用户回复后客户端重挂新周期。 */
export async function armIdleReconnectBailout(rule: IdleReconnectRule): Promise<BailoutArmResult> {
    if (!bailoutEnabled()) return { ok: false, reason: "当前环境不支持服务端离线预约" };
    try {
        if (!(await hasAccountPushSubscription())) return { ok: false, reason: "当前账号没有可用的离线推送订阅" };
        const session = loadChatSessions().find(s => s.id === rule.sessionId);
        if (!session || session.isGroup || session.contactId !== rule.characterId) return { ok: false, reason: "找不到对应的单聊会话" };
        const history = loadChatMessages(session.id);
        const lastUser = [...history].reverse().find(m => m.role === "user");
        if (!lastUser) return { ok: false, reason: "这个会话还没有你的消息，无法计算沉默时间" };
        const lastUserAt = new Date(lastUser.createdAt).getTime();

        const effectiveConsecutive = rule.lastFiredAt && rule.lastFiredAt > lastUserAt ? rule.consecutiveCount : 0;
        if (effectiveConsecutive >= IDLE_RECONNECT_MAX_CONSECUTIVE) {
            // 不再挂新单，把该规则的存量排队任务清干净
            await cancelBailoutPrefix(`idle:${rule.id}:`);
            return { ok: false, reason: "已达到连续主动联系上限" };
        }

        const intervalMs = Math.max(1, rule.intervalMinutes) * 60_000;
        const nextDueAt = Math.max(
            lastUserAt + intervalMs,
            rule.lastFiredAt ? rule.lastFiredAt + intervalMs : 0,
            rule.suppressedUntil ?? 0,
        );
        const fireAt = Math.max(nextDueAt, Date.now() + 30_000);
        if (isWithinPushQuietHours(fireAt)) {
            // 首发落在安静时段就不挂（本地醒着时会择机触发），存量任务一并清掉
            await cancelBailoutPrefix(`idle:${rule.id}:`);
            return { ok: false, reason: "触发时间落在推送安静时段内" };
        }

        const elapsedMinutes = Math.max(1, Math.round((fireAt - lastUserAt) / 60000));
        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            history,
            { appTags: ["chat", "text", "idle_wake"], timedWakeElapsedMinutes: elapsedMinutes },
        );
        maybeAppendCallInvite(llmMessages, rule.characterId);
        maybeAppendShortcutCapability(llmMessages, { continuationAvailable: true });
        const weixinBotId = maybeAppendWeixinChannel(llmMessages, rule.characterId);
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
            const req = buildProviderRequest(config, preset, toLlmRequestMessages(messages));
            return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
        }, config.enableImageRecognition === true);
        const remaining = IDLE_RECONNECT_MAX_CONSECUTIVE - effectiveConsecutive - 1;
        // 先挂后清：POST 本身按同键先删后插（幂等覆盖），挂稳后再清理同前缀的其他旧键
        //（旧连发序号、服务端续排的 "+" 后缀键）。之前是先清后挂，切后台/杀进程
        // 发生在清理和重挂之间会把预约整个删空——服务端从此无单可执行。
        const triggerKey = `idle:${rule.id}:${effectiveConsecutive}`;
        const posted = await postBailoutJob({
            triggerKey,
            kind: "timed_task",
            executeAtMs: fireAt + 15_000,
            request,
            notifyTitle: character.name,
            weixinBotId,
            shortcutContinuation,
            merge: {
                sessionId: session.id,
                prevCount: 0,
                regexes,
                characterName: character.name,
                userName: userIdentity?.name ?? "用户",
                appId: "chat",
                appTags: ["chat", "text", "idle_wake"],
                armAt: new Date(fireAt).toISOString(),
                idleReconnect: { ruleId: rule.id, firedAt: fireAt },
                ...(remaining > 0 ? { idleRepeat: { intervalMs, remaining, quietWin: buildQuietWindowMeta() } } : {}),
            },
        });
        if (!posted) return { ok: false, reason: "服务端预约接口没有确认成功" };
        // 清理不阻塞结果：新单已挂稳；旧键偶尔清不掉，下次任一重挂时机会再清
        void cancelBailoutPrefix(`idle:${rule.id}:`, triggerKey);
        // 服务端是"生成完才插入下一轮续排任务"——上面的清理可能赶在插入前跑完，
        // 旧链尾巴漏网就会和新链并存多发一轮。延迟再扫一次兜住这个竞态；
        // 新链首发至少在 30 秒后才会生成续排任务，10 秒时点不会误伤。
        window.setTimeout(() => void cancelBailoutPrefix(`idle:${rule.id}:`, triggerKey), 10_000);
        return { ok: true };
    } catch (err) {
        console.warn("[PushBailout] idle reconnect arm failed:", err);
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

/** 定时唤醒（稍后主动联系）兜底：创建/刷新时把到点生成预约到服务端。
 *  "已过X分钟"的语境按预定触发时刻精确烤入。 */
export async function armTimedWakeBailout(schedule: TimedWakeSchedule): Promise<BailoutArmResult> {
    if (!bailoutEnabled()) return { ok: false, reason: "当前环境不支持服务端离线预约" };
    try {
        if (!(await hasAccountPushSubscription())) return { ok: false, reason: "当前账号没有可用的离线推送订阅" };
        if (isWithinPushQuietHours(schedule.fireAt)) return { ok: false, reason: "触发时间落在推送安静时段内" };
        const session = loadChatSessions().find(s => s.id === schedule.sessionId);
        if (!session || session.isGroup || session.contactId !== schedule.characterId) return { ok: false, reason: "找不到对应的单聊会话" };
        const history = loadChatMessages(session.id);
        const elapsedMinutes = resolveTimedWakeElapsedMinutes(schedule, history);

        const wakeTag = schedule.source === "user" ? "user_timed_wake" : "timed_wake";
        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            history,
            { appTags: ["chat", "text", wakeTag], timedWakeElapsedMinutes: elapsedMinutes, timedWakeIntent: schedule.intent },
        );
        maybeAppendCallInvite(llmMessages, schedule.characterId);
        maybeAppendShortcutCapability(llmMessages, { continuationAvailable: true });
        const weixinBotId = maybeAppendWeixinChannel(llmMessages, schedule.characterId);
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
            const req = buildProviderRequest(config, preset, toLlmRequestMessages(messages));
            return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
        }, config.enableImageRecognition === true);
        const posted = await postBailoutJob({
            triggerKey: `timedwake:${schedule.id}`,
            kind: "timed_task",
            executeAtMs: schedule.fireAt + 15_000,
            request,
            notifyTitle: character.name,
            weixinBotId,
            shortcutContinuation,
            merge: {
                sessionId: session.id,
                prevCount: 0,
                regexes,
                characterName: character.name,
                userName: userIdentity?.name ?? "用户",
                appId: "chat",
                appTags: ["chat", "text", wakeTag],
                armAt: new Date(schedule.fireAt).toISOString(),
            },
        });
        return posted ? { ok: true } : { ok: false, reason: "服务端预约接口没有确认成功" };
    } catch (err) {
        console.warn("[PushBailout] timed wake arm failed:", err);
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

/** 经期关怀兜底：预测未来 7 天内的关怀日，为选中的角色各挂一单（每周期幂等）。 */
export async function armPeriodCareBailouts(): Promise<void> {
    if (!bailoutEnabled()) return;
    try {
        const config = loadMenstrualConfig();
        if (!config.periodCareEnabled || config.periodCareCharacterIds.length === 0) return;
        if (!(await hasAccountPushSubscription())) return;

        const records = loadMenstrualRecords();
        const now = new Date();
        for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
            const target = new Date(now.getTime() + dayOffset * 86_400_000);
            const targetDate = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
            const event = getMenstrualPeriodCareEvent(records, config, targetDate);
            if (!event) continue;

            // 当天 09:30 触发；已过则 10 分钟后
            const fireAt = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 9, 30).getTime();
            const executeAtMs = Math.max(fireAt, Date.now() + 10 * 60_000);
            if (isWithinPushQuietHours(executeAtMs)) return;

            const sessions = loadChatSessions()
                .filter(session => !session.isGroup && config.periodCareCharacterIds.includes(session.contactId))
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const seen = new Set<string>();
            for (const session of sessions) {
                if (seen.has(session.contactId)) continue;
                seen.add(session.contactId);
                if (hasMenstrualPeriodCareTriggered(session.contactId, event.cycleKey)) continue;
                const characterName = loadCharacters().find(c => c.id === session.contactId)?.name ?? "小手机";
                const history = loadChatMessages(session.id);
                const { llmMessages, config: apiConfig, preset, regexes, userIdentity } = await buildChatPromptMessages(
                    session,
                    history,
                    { appTags: ["chat", "text", "period_care"], periodCareContext: event.context },
                );
                maybeAppendShortcutCapability(llmMessages, { continuationAvailable: true });
                const request = buildProviderRequest(apiConfig, preset, toLlmRequestMessages(llmMessages));
                const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
                    const req = buildProviderRequest(apiConfig, preset, toLlmRequestMessages(messages));
                    return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
                }, apiConfig.enableImageRecognition === true);
                await postBailoutJob({
                    triggerKey: `periodcare:${session.contactId}:${event.cycleKey}`,
                    kind: "timed_task",
                    executeAtMs,
                    request,
                    notifyTitle: characterName,
                    shortcutContinuation,
                    merge: {
                        sessionId: session.id,
                        prevCount: 0,
                        regexes,
                        characterName,
                        userName: userIdentity?.name ?? "用户",
                        appId: "chat",
                        appTags: ["chat", "text", "period_care"],
                        armAt: new Date(executeAtMs).toISOString(),
                        periodCare: { characterId: session.contactId, cycleKey: event.cycleKey },
                    },
                });
            }
            return; // 只挂最近的一个关怀日
        }
    } catch (err) {
        console.warn("[PushBailout] period care arm failed:", err);
    }
}

let refreshingScheduled = false;

/** 刷新所有"已知触发时刻"的兜底快照（切后台/启动时调用，保证上下文最新）。 */
export async function refreshScheduledBailouts(): Promise<void> {
    if (refreshingScheduled || !bailoutEnabled()) return;
    refreshingScheduled = true;
    try {
        for (const schedule of loadTimedWakeSchedules()) {
            await armTimedWakeBailout(schedule);
        }
        for (const rule of loadIdleReconnectRules()) {
            await armIdleReconnectBailout(rule);
        }
        await armPeriodCareBailouts();
    } finally {
        refreshingScheduled = false;
    }
}

/** 安装刷新钩子：切后台时 + 启动后一次。 */
export function installScheduledBailoutRefresher(): void {
    if (typeof window === "undefined") return;
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) void refreshScheduledBailouts();
    });
    window.setTimeout(() => { void refreshScheduledBailouts(); }, 20_000);
}

/** 撤销追问兜底预约：带 count 只撤该轮的精确键，不带则撤该会话全部。 */
export function cancelFollowUpBailout(sessionId: string, count?: number): void {
    if (!bailoutEnabled()) return;
    if (peekAccountPushSubscribed() === false) return; // 账号没订阅→从没挂过单，别浪费请求
    void pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
            typeof count === "number"
                ? { triggerKey: `followup:${sessionId}:${count}` }
                : { triggerPrefix: `followup:${sessionId}:` },
        ),
    }).catch(() => undefined);
}
