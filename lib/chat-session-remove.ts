// lib/chat-session-remove.ts
// 「删除会话」的一站式清理：除了会话本体和线上消息（deleteChatSession），
// 还要把按 sessionId 散落在各处的状态一并收走，避免留下僵尸数据。
// 单独成文件是因为 chat-storage 不能反向依赖 chat-offline-storage / follow-up-service。

import { deleteChatSession } from "./chat-storage";
import { clearChatOfflineTurns } from "./chat-offline-storage";
import { cancelBackgroundGeneration, cancelFollowUp } from "./follow-up-service";
import { clearTimedWakeSchedule } from "./timed-wake-storage";
import { saveStatusRegionConfig } from "./chat-status-region";
import { setSessionKeyboardAutoSendDebounce, setSessionKeyboardAutoSendEnabled } from "./keyboard-auto-send-config";
import { PENDING_REPLY_PREFIX } from "./friend-request-engine";
import { kvRemove } from "./kv-db";

// 与 chat-room.tsx 里的同名常量保持一致（备份模块 data-management/modules.ts 也在用同样的字面量）
const GENERATING_PREFIX = "chat-generating:";
const CHAT_OFFLINE_MODE_PREFIX = "chat-offline-mode:";
const CHAT_THEATER_MODE_PREFIX = "chat-theater-mode:";

export function removeChatSessionCompletely(sessionId: string): void {
    // 先掐掉可能还在往会话里写消息的后台任务
    cancelBackgroundGeneration(sessionId);
    cancelFollowUp(sessionId);
    clearTimedWakeSchedule(sessionId);

    // 会话本体 + 线上消息 + 线下记录
    deleteChatSession(sessionId);
    clearChatOfflineTurns(sessionId);

    // 按 sessionId 存的零散开关
    kvRemove(GENERATING_PREFIX + sessionId);
    kvRemove(CHAT_OFFLINE_MODE_PREFIX + sessionId);
    kvRemove(CHAT_THEATER_MODE_PREFIX + sessionId);
    kvRemove(PENDING_REPLY_PREFIX + sessionId);

    // 自定义状态栏：写回默认值即等于删掉该会话的条目
    saveStatusRegionConfig(sessionId, { mode: "native", contract: "", renderHtml: "", previewRaw: "" });
    // 键盘自动发送的按会话配置
    setSessionKeyboardAutoSendEnabled(sessionId, false);
    setSessionKeyboardAutoSendDebounce(sessionId, null);
}
