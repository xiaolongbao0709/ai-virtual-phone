"use client";

import { useEffect } from "react";
import { loadChatSessions, saveChatSessions, type ChatSession } from "@/lib/chat-storage";

const CONTROL_ATTR = "data-chat-reasoning-visibility-control";
const HIDDEN_ATTR = "data-chat-reasoning-hidden-by-setting";

type ChatSessionWithReasoningVisibility = ChatSession & {
  hideReasoning?: boolean;
};

function getSessionId(wrapper: HTMLElement): string | null {
  for (const className of Array.from(wrapper.classList)) {
    if (className.startsWith("session-") && className.length > "session-".length) {
      return className.slice("session-".length);
    }
  }
  return null;
}

function readHidden(sessionId: string): boolean {
  const session = loadChatSessions().find((item) => item.id === sessionId) as
    | ChatSessionWithReasoningVisibility
    | undefined;
  return session?.hideReasoning === true;
}

function writeHidden(sessionId: string, hidden: boolean): void {
  const sessions = loadChatSessions();
  const index = sessions.findIndex((item) => item.id === sessionId);
  if (index === -1) return;

  const updated = { ...sessions[index] } as ChatSessionWithReasoningVisibility;
  if (hidden) updated.hideReasoning = true;
  else delete updated.hideReasoning;
  sessions[index] = updated;
  saveChatSessions(sessions);
}

function forceHide(element: HTMLElement): void {
  if (element.hasAttribute(HIDDEN_ATTR)) return;
  element.setAttribute(HIDDEN_ATTR, "");
  element.style.setProperty("display", "none", "important");
}

function restoreHidden(element: HTMLElement): void {
  if (!element.hasAttribute(HIDDEN_ATTR)) return;
  element.style.removeProperty("display");
  element.removeAttribute(HIDDEN_ATTR);
}

function applyReasoningVisibility(wrapper: HTMLElement, hidden: boolean): void {
  if (!hidden) {
    wrapper.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach(restoreHidden);
    return;
  }

  // 普通消息：隐藏整条思维链入口；纯思维链轮次连外层一起隐藏，避免残留 gap。
  wrapper
    .querySelectorAll<HTMLElement>(
      ".chat-reasoning-trigger, [data-reasoning-row], [data-reasoning-only], [data-reasoning-empty]",
    )
    .forEach(forceHide);

  // 若用户在弹窗打开时切换设置，也一并强制隐藏整个思维链弹层。
  wrapper.querySelectorAll<HTMLElement>(".chat-reasoning-sheet").forEach((sheet) => {
    const overlay = sheet.closest<HTMLElement>(".modal-overlay");
    forceHide(overlay ?? sheet);
  });
}

function setToggleVisual(toggle: HTMLButtonElement, checked: boolean): void {
  toggle.setAttribute("aria-checked", checked ? "true" : "false");
  if (checked) toggle.setAttribute("data-checked", "");
  else toggle.removeAttribute("data-checked");
}

function createClockIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "9");
  const hands = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hands.setAttribute("d", "M12 7v5l3 2");
  svg.append(circle, hands);
  return svg;
}

function ensureSettingsControl(menu: HTMLElement, wrapper: HTMLElement, sessionId: string): void {
  const existing = menu.querySelector<HTMLElement>(`[${CONTROL_ATTR}]`);
  if (existing) {
    const toggle = existing.querySelector<HTMLButtonElement>(".ui-toggle");
    if (toggle) setToggleVisual(toggle, readHidden(sessionId));
    return;
  }

  const cssLabel = Array.from(menu.querySelectorAll<HTMLElement>(".menu-label")).find(
    (el) => el.textContent?.trim() === "自定义 CSS 样式",
  );
  const cssItem = cssLabel?.closest<HTMLElement>(".menu-item");
  const advancedGroup = cssItem?.closest<HTMLElement>(".menu-group");
  if (!cssItem || !advancedGroup) return;

  const row = document.createElement("div");
  row.className = "menu-item";
  row.setAttribute(CONTROL_ATTR, "");

  const icon = document.createElement("span");
  icon.className = "chat-info-icon";
  icon.style.setProperty("--icon-color", "var(--c-icon-active)");
  icon.appendChild(createClockIcon());

  const labels = document.createElement("div");
  labels.className = "menu-label-group";
  const label = document.createElement("span");
  label.className = "menu-label";
  label.textContent = "隐藏思维链";
  const desc = document.createElement("span");
  desc.className = "menu-desc";
  desc.textContent = "开启后完全隐藏思维链入口";
  labels.append(label, desc);

  const right = document.createElement("div");
  right.className = "menu-right";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ui-toggle";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("data-ui", "toggle");
  const knob = document.createElement("span");
  knob.className = "ui-toggle-knob";
  toggle.appendChild(knob);
  setToggleVisual(toggle, readHidden(sessionId));
  right.appendChild(toggle);

  const setHidden = (next: boolean) => {
    writeHidden(sessionId, next);
    setToggleVisual(toggle, next);
    applyReasoningVisibility(wrapper, next);
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setHidden(!readHidden(sessionId));
  });
  row.addEventListener("click", () => setHidden(!readHidden(sessionId)));

  row.append(icon, labels, right);
  advancedGroup.insertBefore(row, cssItem);
}

function syncAll(): void {
  const wrappers = Array.from(document.querySelectorAll<HTMLElement>(".chat-room-wrapper"));
  wrappers.forEach((wrapper) => {
    const sessionId = getSessionId(wrapper);
    if (!sessionId) return;
    applyReasoningVisibility(wrapper, readHidden(sessionId));
  });

  // 聊天信息页通过 portal 挂在 session wrapper 外面；用 data-settings-open 找到它对应的会话。
  const activeWrapper = wrappers.find((wrapper) => wrapper.hasAttribute("data-settings-open"));
  if (!activeWrapper) return;
  const sessionId = getSessionId(activeWrapper);
  if (!sessionId) return;

  document.querySelectorAll<HTMLElement>(".chat-settings-layer .chat-info-menu").forEach((menu) => {
    ensureSettingsControl(menu, activeWrapper, sessionId);
  });
}

/**
 * 给聊天信息页补一个“隐藏思维链”开关。
 *
 * 这里故意在 DOM 层用 inline `display:none !important` 执行隐藏：
 * 会话自定义 CSS 来自 author stylesheet，优先级低于 inline !important，
 * 因此用户即使在自定义 CSS 里强制显示思维链，也无法覆盖这个隐私开关。
 * 关闭后移除 inline 样式，完整恢复项目原有 UI 与用户自己的 CSS 行为。
 */
export function ChatReasoningVisibilityController() {
  useEffect(() => {
    let frame = 0;
    const scheduleSync = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        syncAll();
      });
    };

    syncAll();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach(restoreHidden);
    };
  }, []);

  return null;
}
