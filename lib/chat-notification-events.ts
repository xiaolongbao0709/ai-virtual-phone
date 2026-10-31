export const CHAT_MESSAGE_NOTICE_EVENT = "ai-chat-message-notice";
export const CHAT_OPEN_SESSION_EVENT = "ai-chat-open-session";
export const CHAT_JUMP_TO_MESSAGE_EVENT = "ai-chat-jump-to-message";

export type ChatJumpToMessageDetail = {
  sessionId: string;
  messageId: string;
};

export function dispatchChatJumpToMessage(detail: ChatJumpToMessageDetail): void {
  if (typeof window === "undefined") return;
  if (!detail.sessionId || !detail.messageId) return;
  window.dispatchEvent(new CustomEvent(CHAT_JUMP_TO_MESSAGE_EVENT, { detail }));
}

export type ChatMessageNoticeDetail = {
  sessionId: string;
  body: string;
  senderName?: string;
  avatar?: string | null;
  isGroup?: boolean;
};

export function dispatchChatMessageNotice(detail: ChatMessageNoticeDetail): void {
  if (typeof window === "undefined") return;
  const body = detail.body.trim();
  if (!detail.sessionId || !body) return;
  window.dispatchEvent(new CustomEvent(CHAT_MESSAGE_NOTICE_EVENT, {
    detail: { ...detail, body },
  }));
}

// 打开联系人 tab 的「添加朋友」页并预载指定角色资料（名片点击添加）
export const CHAT_OPEN_ADD_CONTACT_EVENT = "ai-chat-open-add-contact";

export function dispatchOpenAddContact(characterId: string): void {
  if (typeof window === "undefined" || !characterId) return;
  window.dispatchEvent(new CustomEvent(CHAT_OPEN_ADD_CONTACT_EVENT, { detail: { characterId } }));
}
