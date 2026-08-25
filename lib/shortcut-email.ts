export const SHORTCUT_EMAIL_SUBJECT_PREFIX = "FloatBridge";

export function shortcutEmailSubjectTag(actionId: string): string {
  const safeId = actionId.trim().replace(/[^a-z0-9_-]/gi, "").slice(0, 100);
  return `[${SHORTCUT_EMAIL_SUBJECT_PREFIX}:${safeId}]`;
}

export function normalizeShortcutEmailAddress(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().slice(0, 254);
}

export function isValidShortcutEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
