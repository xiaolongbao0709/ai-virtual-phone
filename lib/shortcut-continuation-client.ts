import type { LlmRequestPayload } from "./llm-provider-adapter";
import { pushJobsFetch } from "./personal-push-cloud";
import { startBailoutHeartbeat } from "./push-bailout-client";
import { hasAccountPushSubscription } from "./push-client";
import type { RegexConfig } from "./settings-types";
import { isSelfHostedModeEnabled } from "./self-hosting";
import { cleanupShortcutCommandMedia } from "./shortcut-command-media-client";

/** 识图关着时代替截图进上下文的说明：不留这句话，模型面对的是空白，
 *  既不知道图回没回来，也不知道自己为什么看不见。云端三条通道用同一句。 */
export const SHORTCUT_VISION_OFF_NOTE = "（系统记录：未配置或未启用图像识别，本轮回传的图片没有交给你；请结合上一条的文字内容回应。）";

export type ShortcutContinuationStyle = "text" | "native";

export type ShortcutContinuationHandle = {
    commandId: string;
    triggerKey: string;
    settle: () => void;
    release: () => void;
};

export async function armShortcutContinuation(params: {
    commandId: string;
    actionName: string;
    resultMode: "none" | "text" | "image";
    resultMarker: string;
    imageMarker?: string;
    style: ShortcutContinuationStyle;
    request: Pick<LlmRequestPayload, "url" | "headers" | "body" | "providerKind">;
    sessionId: string;
    characterName: string;
    userName?: string;
    regexes: RegexConfig[];
    appId?: string;
    appTags?: string[];
}): Promise<ShortcutContinuationHandle | null> {
    if (typeof window === "undefined" || isSelfHostedModeEnabled()) return null;
    if (!(await hasAccountPushSubscription())) return null;

    const triggerKey = `shortcut:${params.commandId}`;
    const armAt = new Date().toISOString();
    // 个人云启用时预约进用户自己的 push_jobs——结果回传函数的唤醒查询也在那张表
    const response = await pushJobsFetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            triggerKey,
            kind: "shortcut_resume",
            executeAt: new Date(Date.now() + 30_000).toISOString(),
            payload: {
                request: {
                    url: params.request.url,
                    headers: params.request.headers,
                    body: params.request.body,
                    providerKind: params.request.providerKind,
                },
                shortcut: {
                    commandId: params.commandId,
                    actionName: params.actionName,
                    resultMode: params.resultMode,
                    resultMarker: params.resultMarker,
                    imageMarker: params.imageMarker,
                    style: params.style,
                },
                notify: { title: params.characterName, url: "/" },
                merge: {
                    sessionId: params.sessionId,
                    regexes: params.regexes,
                    characterName: params.characterName,
                    userName: params.userName ?? "用户",
                    appId: params.appId ?? "chat",
                    appTags: params.appTags ?? ["chat", "text"],
                    armAt,
                    shortcutCommandId: params.commandId,
                },
            },
        }),
    }).catch(() => null);
    if (!response?.ok) return null;

    const stopHeartbeat = startBailoutHeartbeat(triggerKey);
    let finished = false;
    const stop = () => {
        if (finished) return false;
        finished = true;
        stopHeartbeat();
        return true;
    };
    return {
        commandId: params.commandId,
        triggerKey,
        settle: () => {
            if (!stop()) return;
            void pushJobsFetch({
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ triggerKey }),
            }).catch(() => undefined);
            if (params.resultMode === "image") {
                cleanupShortcutCommandMedia(params.commandId);
            }
        },
        release: () => {
            if (!stop()) return;
            void pushJobsFetch({
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ triggerKey, runNow: true }),
            }).catch(() => undefined);
        },
    };
}
