// 现实桥服务端联动：客户端与 Netlify 执行函数共享的纯常量/类型/小函数。
// 保持零浏览器、零存储依赖。

/** prompt 快照里预留的事件文本占位哨兵（私有区字符，正常文本不会出现） */
export const BRIDGE_EVENT_SENTINEL = "BRIDGE_EVENT_TEXT";

/** 屏幕速聊：快照在 push_bridge_snapshots 里的保留 rule_id（不会与联动规则撞名） */
export const SCREEN_CHAT_SNAPSHOT_ID = "screen-chat";
/** 屏幕速聊快照请求体里的对话占位哨兵（screen-chat 函数替换成会话文本） */
export const SCREEN_CHAT_SENTINEL = "SCREEN_CHAT_TURNS_TEXT";

/** 服务端可执行的精简规则形态（客户端从 BridgeRule 裁剪同步上来） */
export type ServerBridgeRule = {
    id: string;
    name: string;
    matchType: string;
    cooldownMinutes?: number;
    process: {
        mode: "raw" | "template" | "ai";
        template?: string;
    };
    chat?: {
        characterId: string;
        sessionId: string;
        role: "user" | "assistant" | "system";
        historyRole?: "user" | "assistant" | "system";
        requestReply: boolean;
        characterName: string;
    };
    notify?: boolean;
    /** 出站快捷动作快照（从本机快捷动作解析）：规则命中时服务端直接创建
     *  快捷命令并推送运行通知，不等回端补账 */
    shortcut?: {
        actionId: string;
        name: string;
        shortcutName: string;
        resultMode: "none" | "text" | "image";
        expiresInSeconds?: number;
    };
    /** 除 chat/notify/shortcut 外还有哪些动作（memory/timeline/...）——服务端不执行，回端补账 */
    deferredActions: string[];
};

/** template 模式的占位替换（与 engine.fillTemplate 同规则） */
export function fillBridgeTemplate(template: string, item: { type: string; payload: string }): string {
    return template
        .replace(/\{payload\}/g, item.payload)
        .replace(/\{type\}/g, item.type);
}

/** 把处理后的事件文本安全替换进序列化后的请求体 JSON（JSON 转义后再替换哨兵）。 */
export function substituteSentinelInRequestBody(bodyJson: string, text: string): string {
    const escaped = JSON.stringify(text).slice(1, -1);
    return bodyJson.split(BRIDGE_EVENT_SENTINEL).join(escaped);
}
