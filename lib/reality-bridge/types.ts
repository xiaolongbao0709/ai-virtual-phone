/** 现实桥：iPhone 快捷指令 ↔ 小手机 的双向数据管道。 */

export type BridgeItem = {
  id: string;
  /** 用户在快捷指令里自定的类型名，规则按它匹配 */
  type: string;
  /** 原始数据（文本或任意 JSON 序列化后的字符串） */
  payload: string;
  createdAt: string;
};

export type BridgeProcessMode = "raw" | "template" | "ai";

export type BridgeRuleActions = {
  /** 写进与某角色的聊天：role 决定聊天室里怎么显示；
   *  historyRole 可选，决定在角色记忆（prompt 历史）里算谁说的，缺省跟随 role */
  chat?: {
    characterId: string;
    role: "user" | "assistant" | "system";
    historyRole?: "user" | "assistant" | "system";
    requestReply: boolean;
  };
  /** 写入角色记忆 */
  memory?: { characterId: string; type: "long_term" | "core" };
  /** 写入角色时间线 */
  timeline?: { characterId: string };
  /** 浏览器系统通知 */
  notify?: boolean;
  /** 写入用户日历（今天，标题=加工结果）。
   *  新版：以触发时刻为锚点，direction=past 记录刚过去的 durationMinutes 分钟，future 记录接下来的；
   *  旧版规则仍带 startTime/endTime 固定时段，引擎兼容执行。 */
  calendar?: { startTime?: string; endTime?: string; direction?: "past" | "future"; durationMinutes?: number };
  /** 以卡片形式发进聊天 */
  card?: { characterId: string };
  /** 执行一个已配置的快捷动作：创建命令并推送运行通知，点通知即执行；
   *  App 被杀时由个人云的联动执行器代发（仅推送模式的快捷动作） */
  shortcut?: { actionId: string };
  /** 回传 iPhone 发件箱 */
  outbox?: { type: string };
  /** 广播 bridge.data 事件给已订阅的自定义 APP */
  broadcast?: boolean;
};

export type BridgeRule = {
  id: string;
  name: string;
  /** 匹配的数据类型；"*" 匹配全部 */
  matchType: string;
  enabled: boolean;
  process: {
    mode: BridgeProcessMode;
    /** template 模式：{payload} / {type} 占位 */
    template?: string;
    /** ai 模式：加工提示词，{payload} / {type} 占位 */
    prompt?: string;
  };
  actions: BridgeRuleActions;
  /** 触发间隔（分钟）：间隔内再次收到同信号只存档不执行；0/缺省 = 每次都触发 */
  cooldownMinutes?: number;
  createdAt: string;
};

export type BridgeFeedEntry = {
  id: string;
  type: string;
  payload: string;
  /** 加工后的文本（未加工时等于 payload） */
  processed?: string;
  /** 命中的规则名列表 */
  rules: string[];
  /** 执行的动作摘要 */
  actions: string[];
  error?: string;
  receivedAt: string;
};

export type BridgeOutboxEntry = {
  id: string;
  type: string;
  payload: string;
  createdAt: string;
  /** 来源：rule=规则回传 / tool=角色工具 / manual=手动测试 / app=自定义APP */
  source: "rule" | "tool" | "manual" | "app";
};

export const BRIDGE_INBOX_PREFIX = "bridge-inbox/";
export const BRIDGE_OUTBOX_QUEUE_PATH = "bridge-outbox/queue.json";
/** 状态快照目录：快捷指令覆盖写 bridge-state/<key>.json，角色工具按需读取 */
export const BRIDGE_STATE_PREFIX = "bridge-state/";
export const REALITY_BRIDGE_DATA_EVENT = "reality-bridge-data";
export const REALITY_BRIDGE_APP_EVENT_NAME = "bridge.data";
