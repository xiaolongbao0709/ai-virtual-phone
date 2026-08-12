// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.
// Retrieval core is the Ombre Brain 7-dimension scoring engine (memory-scoring.ts)
// with lazy decay + touch/ripple lifecycle (memory-lifecycle.ts).
// Public function signatures are unchanged from v1 — callers need no changes.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { scoreMemories, type ScoredMemory } from "./memory-scoring";
import { maybeRunDecay, touchMemories } from "./memory-lifecycle";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Lazy decay sweep (throttled, archives low-retention entries)
 *   2. Active pool fits budget → return all (still touch them)
 *   3. Over budget → 7-dim OB scoring (topic/emotion/time/importance/touch/
 *      semantic/bm25), literal hits force-recalled, fill until token budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 * Missing embedding config degrades gracefully: semantic dim scores 0,
 * the other 6 dims still rank meaningfully.
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    await maybeRunDecay(characterId);

    const allEntries = await loadMemoryEntriesByType(characterId, "long_term");
    const pool = allEntries.filter(e => !e.archived && !e.dontSurface);
    if (pool.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // All fit within budget → return all
    let totalTokens = 0;
    for (const entry of pool) {
        totalTokens += estimateTokens(entry.content) + 4;
    }
    if (totalTokens <= budget) {
        void touchMemories(pool, allEntries);
        return sortByCreated(pool);
    }

    // Over budget → OB 7-dimension scoring
    let queryEmbedding: number[] | null = null;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        } catch { /* semantic dim degrades to 0 */ }
    }

    const scored = scoreMemories(pool, {
        query: currentContext,
        queryEmbedding,
    });

    const selected = fillByBudgetScored(scored, budget);
    void touchMemories(selected, allEntries);
    return sortByCreated(selected);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    const pool = coreEntries.filter(e => !e.archived);
    if (pool.length === 0) return [];

    const sorted = [...pool].sort((a, b) => {
        // pinned first, then active flag, then event date
        const aPin = a.pinned || a.protected ? 1 : 0;
        const bPin = b.pinned || b.protected ? 1 : 0;
        if (aPin !== bPin) return bPin - aPin;
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Chronological order for prompt injection (scoring picks WHAT, time orders HOW). */
function sortByCreated(entries: MemoryEntry[]): MemoryEntry[] {
    return [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Fill scored entries until token budget is exhausted.
 * OB rule: literal hits are force-recalled — they are placed first so budget
 * cutoff cannot drop them.
 */
function fillByBudgetScored(scored: ScoredMemory[], budget: number): MemoryEntry[] {
    const literalFirst = [
        ...scored.filter(s => s.literalHit),
        ...scored.filter(s => !s.literalHit),
    ];
    return fillByBudget(literalFirst.map(s => s.entry), budget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
