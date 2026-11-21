const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isSelfHostedModeEnabled(): boolean {
  const raw = process.env.NEXT_PUBLIC_SELF_HOSTED_MODE;
  // This personal deployment starts locally unless a mode is explicitly configured.
  if (raw === undefined) return true;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}
