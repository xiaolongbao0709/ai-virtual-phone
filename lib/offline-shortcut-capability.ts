// 离线快捷动作能力：给离线生成快照注入"角色可调用快捷动作"的说明。
// 角色在离线回复里输出【快捷动作：名称】，云端生成器（push-generate /
// push-bridge）识别标记后经个人网关 shortcut-create 创建命令并推送运行
// 通知，用户点一下即执行——与【拨打电话】同一套标记模式。
// 动作目录由 push-bridge-sync 同步到 push_bridge_config.shortcut_actions，
// 仅个人云激活且现实桥能力开启时生效（站点线不注入、不同步）。

import { getWeixinCloudDeployedAt } from "./cloud-deploy-status";
import { getInternalCapability, REALITY_BRIDGE_CAPABILITY_ID } from "./internal-capability-storage";
import type { LLMMessage } from "./llm-prompt-assembler";
import { isPersonalPushCloudActive } from "./personal-push-cloud";
import { loadBridgeShortcutActions, type BridgeShortcutAction } from "./reality-bridge/storage";
import { loadWeixinBots } from "./weixin-storage";

export type OfflineShortcutAction = {
  actionId: string;
  name: string;
  shortcutName: string;
  resultMode: "none" | "text" | "image";
  expiresInSeconds?: number;
};

// 离线续跑占位符（整值精确匹配，与前台续跑同一套替换契约）：
// 云端创建需回传的快捷命令后，把角色刚生成的回复代入 REPLY 占位并武装
// shortcut_resume 任务；结果回传后由 push-generate 把结果/图片代入生成下一轮。
export const OFFLINE_SHORTCUT_REPLY_MARKER = "__FLOAT_OFFLINE_SHORTCUT_REPLY__";
export const OFFLINE_SHORTCUT_RESULT_MARKER = "__FLOAT_OFFLINE_SHORTCUT_RESULT__";
export const OFFLINE_SHORTCUT_IMAGE_MARKER = "__FLOAT_OFFLINE_SHORTCUT_IMAGE__";

export type OfflineShortcutContinuation = {
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: string };
  replyMarker: string;
  resultMarker: string;
  imageMarker: string;
};

/** 有会回传结果的快捷动作时，预挂一份"结果续跑"快照（与前台 text 式续跑同构）。 */
export function buildOfflineShortcutContinuation(
  llmMessages: LLMMessage[],
  buildRequest: (messages: LLMMessage[]) => OfflineShortcutContinuation["request"],
): OfflineShortcutContinuation | null {
  if (!availableActions().some(action => action.resultMode !== "none")) return null;
  try {
    const messages: LLMMessage[] = [
      ...llmMessages,
      { role: "assistant", content: OFFLINE_SHORTCUT_REPLY_MARKER },
      { role: "user", content: OFFLINE_SHORTCUT_RESULT_MARKER },
      { role: "user", content: OFFLINE_SHORTCUT_IMAGE_MARKER },
    ];
    return {
      request: buildRequest(messages),
      replyMarker: OFFLINE_SHORTCUT_REPLY_MARKER,
      resultMarker: OFFLINE_SHORTCUT_RESULT_MARKER,
      imageMarker: OFFLINE_SHORTCUT_IMAGE_MARKER,
    };
  } catch {
    return null;
  }
}

function availableActions(): BridgeShortcutAction[] {
  if (typeof window === "undefined" || !isPersonalPushCloudActive()) return [];
  const capability = getInternalCapability(REALITY_BRIDGE_CAPABILITY_ID);
  if (!capability || !capability.enabled || capability.mode === "off") return [];
  return loadBridgeShortcutActions()
    .filter(action => action.enabled && action.deliveryMode !== "email")
    .slice(0, 20);
}

/** 同步给云端的动作目录（云端按 name 精确匹配标记里的动作名）。 */
export function listOfflineShortcutActions(): OfflineShortcutAction[] {
  return availableActions().map(action => ({
    actionId: action.id,
    name: action.name,
    shortcutName: action.shortcutName,
    resultMode: action.resultMode,
    expiresInSeconds: action.expiresInSeconds,
  }));
}

/** 角色离线时可用的微信送达通道：个人云激活 + 微信云助手已部署 + 角色绑定了 bot。 */
export function offlineWeixinBotIdFor(characterId: string): string {
  if (typeof window === "undefined" || !isPersonalPushCloudActive()) return "";
  if (!getWeixinCloudDeployedAt()) return "";
  const bot = loadWeixinBots().find(entry => entry.enabled && entry.characterId === characterId);
  return bot?.id ?? "";
}

/** 快照注入：告诉角色离线消息可以改送微信。返回绑定的 botId（无通道时为空串）。 */
export function maybeAppendWeixinChannel(llmMessages: LLMMessage[], characterId: string): string {
  const botId = offlineWeixinBotIdFor(characterId);
  if (!botId) return "";
  llmMessages.push({
    role: "system",
    content: "（可选能力：对方现在没有在看你们的聊天，这条消息TA可能不会马上看到。"
      + "你和TA在现实中的真实微信上也有联系——如果你更想把这条消息发到TA的真实微信"
      + "（注意：是TA现实里的微信 App，不是你们这台手机里的微信），"
      + "就在回复的第一行单独输出【发到微信】，从第二行开始照常写正文。"
      + "不合适就不要输出，也不要提及本条说明。）",
  });
  return botId;
}

/** 快照注入：告诉角色离线时也能调用快捷动作。没有可用动作则什么都不加。 */
export function maybeAppendShortcutCapability(llmMessages: LLMMessage[]): void {
  const actions = availableActions();
  if (actions.length === 0) return;
  const menu = actions
    .map(action => action.description
      ? `「${action.name}」（${action.description.slice(0, 40)}）`
      : `「${action.name}」`)
    .join("、");
  llmMessages.push({
    role: "system",
    content: "（可选能力：你可以请求在对方的 iPhone 上执行这些快捷动作：" + menu
      + "。确有需要时，在回复中单独一行输出【快捷动作：动作名】，动作名必须与上面完全一致；"
      + "对方的手机会收到运行提示，TA点一下就会执行。会回传结果的动作，结果之后会自动交给你继续回复。"
      + "不需要就不要输出，也不要提及本条说明。）",
  });
}
