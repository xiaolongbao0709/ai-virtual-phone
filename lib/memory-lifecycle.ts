// lib/memory-lifecycle.ts
// Ombre Brain lifecycle mechanics: lazy decay engine, touch + time ripple,
// and the write-admission gate.
// The Python original runs decay as a standalone process; in the browser we
// run it lazily (on retrieval / app usage) which is equivalent for our scale.

import type { MemoryEntry, MemoryConfig } from "./memory-types";
import {
    RIPPLE_WINDOW_HOURS,
    RIPPLE_INCREMENT,
    RIPPLE_MAX_NEIGHBORS,
    TIME_DECAY_RATE,
    TOUCH_NORMALIZE_CAP,
} from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryEntry, loadMemoryConfig } from "./memory-storage";
import { keywordOverlapRatio } from "./memory-embedding";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";

// ── Decay engine ──

const DECAY_LAST_RUN_PREFIX = "ai_phone_mem_decay_last_";
registerDynamicPrefix(DECAY_LAST_RUN_PREFIX);

/** Minimum interval between decay sweeps per character (ms). */
const DECAY_MIN_INTERVAL_MS = 6 * 3600 * 1000; // 6h

/**
 * Decay retention score for a single entry, 0-1.
 * Time-exponential on last_active, slowed by activation_count:
 * effective rate = base rate / (1 + activation_count / cap).
 * pinned / protected entries never decay.
 */
export function decayScore(entry: MemoryEntry, now: Date): number {
    if (entry.pinned || entry.protected) return 1;
    const ref = entry.lastActive || entry.updatedAt || entry.createdAt;
    const days = Math.max(0, (now.getTime() - new Date(ref).getTime()) / 86400000);
    const activation = entry.activationCount ?? 0;
    let rate = TIME_DECAY_RATE / (1 + activation / TOUCH_NORMALIZE_CAP);
    if (entry.digested) rate *= 2; // digested → fades faster
    let score = Math.exp(-rate * days);
    // importance keeps memories alive longer (floor scaled by importance)
    score = score + (1 - score) * Math.min(1, Math.max(0, entry.importance)) * 0.3;
    return score;
}

/**
 * Lazy decay sweep for one character: entries whose retention score falls
 * below the threshold are soft-archived (archived=true + deletedAt), never
 * physically deleted. Runs at most once per DECAY_MIN_INTERVAL_MS.
 * Returns number of entries archived.
 */
export async function maybeRunDecay(characterId: string): Promise<number> {
    const config = loadMemoryConfig();
    if (!config.decayEnabled) return 0;

    if (typeof window === "undefined") return 0;
    const lastRunKey = DECAY_LAST_RUN_PREFIX + characterId;
    const lastRun = kvGet(lastRunKey);
    const now = new Date();
    if (lastRun && now.getTime() - new Date(lastRun).getTime() < DECAY_MIN_INTERVAL_MS) return 0;
    kvSet(lastRunKey, now.toISOString());

    const entries = await loadMemoryEntriesByType(characterId, "long_term");
    let archivedCount = 0;
    for (const entry of entries) {
        if (entry.archived || entry.pinned || entry.protected) continue;
        if (decayScore(entry, now) < config.decayArchiveThreshold) {
            entry.archived = true;
            entry.deletedAt = now.toISOString();
            entry.updatedAt = now.toISOString();
            await saveMemoryEntry(entry);
            archivedCount++;
        }
    }
    if (archivedCount > 0) {
        console.log(`[MemoryDecay] Archived ${archivedCount} low-score memories for ${characterId}`);
    }
    return archivedCount;
}

/** Restore a soft-archived entry back to active pool. */
export async function restoreMemory(entry: MemoryEntry): Promise<void> {
    entry.archived = false;
    entry.deletedAt = undefined;
    entry.updatedAt = new Date().toISOString();
    await saveMemoryEntry(entry);
}

// ── Touch + time ripple ──

/**
 * Mark entries as recalled: bump activation_count + last_active, then apply
 * the OB time ripple — neighbors created within ±48h of a touched entry get
 * activation_count +0.3 (up to 5 neighbors per touched entry).
 * `pool` must contain the full candidate pool the touched entries came from
 * (used to locate neighbors without re-reading the DB).
 */
export async function touchMemories(touched: MemoryEntry[], pool: MemoryEntry[]): Promise<void> {
    if (touched.length === 0) return;
    const now = new Date().toISOString();
    const dirty = new Map<string, MemoryEntry>();

    for (const entry of touched) {
        entry.activationCount = (entry.activationCount ?? 0) + 1;
        entry.lastActive = now;
        dirty.set(entry.id, entry);
    }

    const touchedIds = new Set(touched.map(e => e.id));
    for (const entry of touched) {
        const center = new Date(entry.createdAt).getTime();
        const windowMs = RIPPLE_WINDOW_HOURS * 3600 * 1000;
        const neighbors = pool
            .filter(p =>
                !touchedIds.has(p.id) &&
                !p.archived &&
                Math.abs(new Date(p.createdAt).getTime() - center) <= windowMs)
            .sort((a, b) =>
                Math.abs(new Date(a.createdAt).getTime() - center) -
                Math.abs(new Date(b.createdAt).getTime() - center))
            .slice(0, RIPPLE_MAX_NEIGHBORS);
        for (const n of neighbors) {
            n.activationCount = (n.activationCount ?? 0) + RIPPLE_INCREMENT;
            dirty.set(n.id, n);
        }
    }

    for (const entry of dirty.values()) {
        await saveMemoryEntry(entry);
    }
}

// ── Write admission gate ──

export type AdmissionVerdict = {
    admitted: boolean;
    reason?: string;
    /** highest duplicate ratio found (0-1) */
    dupRatio?: number;
};

/**
 * OB write_admission port: auto (background) writes are checked for
 * duplication against existing memories; manual/forced writes pass through.
 * "Wait for recurrence" state from OB is simplified to plain rejection —
 * the summarization pipeline will naturally re-produce recurring content.
 */
export function checkWriteAdmission(
    candidate: string,
    existing: MemoryEntry[],
    config: MemoryConfig,
    auto: boolean,
): AdmissionVerdict {
    if (!auto || !config.writeAdmissionEnabled) return { admitted: true };
    if (!candidate.trim()) return { admitted: false, reason: "空内容" };

    let maxRatio = 0;
    for (const entry of existing) {
        if (entry.archived) continue;
        const ratio = keywordOverlapRatio(candidate, entry.content);
        if (ratio > maxRatio) maxRatio = ratio;
        if (maxRatio >= config.writeAdmissionDupThreshold) {
            return {
                admitted: false,
                reason: `与已有记忆重复率 ${(maxRatio * 100).toFixed(0)}% 超过阈值`,
                dupRatio: maxRatio,
            };
        }
    }
    return { admitted: true, dupRatio: maxRatio };
}
