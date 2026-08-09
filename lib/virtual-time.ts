// lib/virtual-time.ts
// Provides getVirtualNow(): returns a Date offset by the user's virtual time
// setting. When no virtual time is configured, returns real `new Date()`.

import { loadChatAppSettings } from "./chat-storage";

/**
 * Return the current virtual time.
 *
 * If the user has set a virtual base time (`virtualTimeBase`) the returned
 * Date equals:
 *
 *   virtualTimeBase + (Date.now() - virtualTimeSetAt)
 *
 * i.e. time keeps ticking from the moment it was set, but starts from the
 * user-chosen point instead of the real clock.
 *
 * When no virtual time is configured, falls back to `new Date()`.
 */
export function getVirtualNow(): Date {
    try {
        const settings = loadChatAppSettings();
        const { virtualTimeBase, virtualTimeSetAt } = settings;
        if (!virtualTimeBase || !virtualTimeSetAt) return new Date();

        const baseMs = new Date(virtualTimeBase).getTime();
        const setAtMs = new Date(virtualTimeSetAt).getTime();
        if (!Number.isFinite(baseMs) || !Number.isFinite(setAtMs)) return new Date();

        const elapsed = Date.now() - setAtMs;
        return new Date(baseMs + elapsed);
    } catch {
        return new Date();
    }
}
