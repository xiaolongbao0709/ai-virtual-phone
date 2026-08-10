// lib/virtual-time.ts
// Virtual system time: pretend the app's "now" is a user-chosen moment.
//
// When configured, getVirtualNow() returns:
//   base + (Date.now() - setAt)
// i.e. time keeps ticking at real speed, but from the virtual base point.
// When not configured, it falls back to real new Date().

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

const KEY = "ai_phone_virtual_time_v1";
registerKvMigration(KEY);

export type VirtualTimeConfig = {
    /** ISO string. Virtual "now" chosen by the user. */
    base: string;
    /** ISO string. Real wall-clock time when the base was set. */
    setAt: string;
};

export function loadVirtualTimeConfig(): VirtualTimeConfig | null {
    const raw = kvGet(KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<VirtualTimeConfig>;
        if (!parsed?.base || !parsed?.setAt) return null;
        if (Number.isNaN(new Date(parsed.base).getTime())) return null;
        if (Number.isNaN(new Date(parsed.setAt).getTime())) return null;
        return { base: parsed.base, setAt: parsed.setAt };
    } catch {
        return null;
    }
}

export function saveVirtualTime(baseDate: Date): void {
    if (Number.isNaN(baseDate.getTime())) return;
    const cfg: VirtualTimeConfig = {
        base: baseDate.toISOString(),
        setAt: new Date().toISOString(),
    };
    kvSet(KEY, JSON.stringify(cfg));
}

export function clearVirtualTime(): void {
    kvRemove(KEY);
}

export function isVirtualTimeActive(): boolean {
    return loadVirtualTimeConfig() !== null;
}

/**
 * Return the current virtual time. Falls back to real new Date() when the
 * user hasn't set a virtual base.
 */
export function getVirtualNow(): Date {
    const cfg = loadVirtualTimeConfig();
    if (!cfg) return new Date();
    const baseMs = new Date(cfg.base).getTime();
    const setAtMs = new Date(cfg.setAt).getTime();
    if (Number.isNaN(baseMs) || Number.isNaN(setAtMs)) return new Date();
    return new Date(baseMs + (Date.now() - setAtMs));
}
