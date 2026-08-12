// lib/memory-scoring.ts
// 7-dimension weighted memory scoring engine (Ombre Brain "breath" port).
// Dimensions: topic / emotion / time / importance / touch / semantic / bm25.
// Each dimension is normalized to 0-1, weighted, summed, then normalized to 0-100.

import type { MemoryEntry, MemoryScoringWeights } from "./memory-types";
import {
    DEFAULT_SCORING_WEIGHTS,
    LITERAL_HIT_BONUS,
    RESOLVED_DEMOTE_FACTOR,
    SEMANTIC_THRESHOLD,
    TIME_DECAY_RATE,
    TOUCH_NORMALIZE_CAP,
} from "./memory-types";
import { buildBm25Index, scoreBm25, normalizeBm25Scores, tokenizeForBm25 } from "./memory-bm25";
import { cosineSimilarity } from "./memory-embedding";

export type ScoredMemory = {
    entry: MemoryEntry;
    /** final score 0-100 (after resolved demotion & literal bonus) */
    score: number;
    /** literal query hit → force recall regardless of budget cutoff position */
    literalHit: boolean;
};

export type ScoringContext = {
    query: string;
    queryEmbedding?: number[] | null;
    queryValence?: number;
    queryArousal?: number;
    weights?: Partial<MemoryScoringWeights>;
    now?: Date;
};

// ── topic: fuzzy match over name-ish fields + body ──
// rapidfuzz.partial_ratio approximation: token-overlap ratio between query
// tokens and entry tokens, with substring containment counted as full match.

function topicScore(queryTokens: string[], queryRaw: string, entry: MemoryEntry): number {
    const haystack = [
        entry.content,
        ...(entry.tags ?? []),
        ...(entry.domain ?? []),
        ...(entry.meaning ?? []),
    ].join(" ").toLowerCase();
    if (!haystack) return 0;
    // full substring containment → strong signal
    if (queryRaw.length >= 2 && haystack.includes(queryRaw)) return 1;
    if (queryTokens.length === 0) return 0;
    const entryTokens = new Set(tokenizeForBm25(haystack));
    let matched = 0;
    for (const qt of queryTokens) {
        if (entryTokens.has(qt)) matched++;
    }
    return matched / queryTokens.length;
}

// ── emotion: 1 - euclidean distance in (valence, arousal) space ──
// Max possible distance in unit square is √2; normalize by it.

function emotionScore(qv: number, qa: number, entry: MemoryEntry): number {
    const ev = typeof entry.valence === "number" ? entry.valence : 0.5;
    const ea = typeof entry.arousal === "number" ? entry.arousal : 0.5;
    const dist = Math.sqrt((qv - ev) ** 2 + (qa - ea) ** 2);
    return Math.max(0, 1 - dist / Math.SQRT2);
}

// ── time: e^(-0.02 × days since last_active) ──

function timeScore(entry: MemoryEntry, now: Date): number {
    const ref = entry.lastActive || entry.updatedAt || entry.createdAt;
    const days = Math.max(0, (now.getTime() - new Date(ref).getTime()) / 86400000);
    return Math.exp(-TIME_DECAY_RATE * days);
}

// ── importance: stored 0-1 in this project (OB uses 1-10; we keep 0-1) ──

function importanceScore(entry: MemoryEntry): number {
    if (entry.pinned || entry.protected) return 1;
    return Math.min(1, Math.max(0, entry.importance));
}

// ── touch: activation_count normalized, capped ──

function touchScore(entry: MemoryEntry): number {
    const count = entry.activationCount ?? 0;
    return Math.min(1, count / TOUCH_NORMALIZE_CAP);
}

// ── semantic: cosine similarity, gated by threshold ──

function semanticScore(queryEmbedding: number[] | null | undefined, entry: MemoryEntry): number {
    if (!queryEmbedding || !entry.embedding || entry.embedding.length === 0) return 0;
    const sim = cosineSimilarity(queryEmbedding, entry.embedding);
    return sim >= SEMANTIC_THRESHOLD ? sim : 0;
}

// ── literal hit: raw query string appears verbatim in searchable fields ──

function isLiteralHit(queryRaw: string, entry: MemoryEntry): boolean {
    if (queryRaw.length < 2) return false;
    const fields = [
        entry.content,
        ...(entry.tags ?? []),
        ...(entry.domain ?? []),
    ];
    return fields.some(f => f.toLowerCase().includes(queryRaw));
}

/**
 * Score a batch of memories against a query context.
 * Returns entries sorted by final score (desc). Does not mutate entries.
 * Weight dimensions with missing data (no embedding, no emotion on query)
 * contribute 0 and their weight still counts in the normalizer — same as OB,
 * which keeps scores comparable across queries.
 */
export function scoreMemories(entries: MemoryEntry[], ctx: ScoringContext): ScoredMemory[] {
    if (entries.length === 0) return [];
    const now = ctx.now ?? new Date();
    const w: MemoryScoringWeights = { ...DEFAULT_SCORING_WEIGHTS, ...ctx.weights };
    const queryRaw = ctx.query.trim().toLowerCase();
    const queryTokens = [...new Set(tokenizeForBm25(queryRaw))];
    const qv = ctx.queryValence ?? 0.5;
    const qa = ctx.queryArousal ?? 0.5;
    const hasQueryEmotion = ctx.queryValence !== undefined || ctx.queryArousal !== undefined;

    // BM25 over the whole batch (index built per call; batches are ≤ a few
    // hundred entries so this stays well under a millisecond budget)
    const bm25Raw = scoreBm25(buildBm25Index(entries.map(e => e.content)), queryRaw);
    const bm25Norm = normalizeBm25Scores(bm25Raw);

    const totalWeight =
        w.topic + w.emotion + w.time + w.importance + w.touch + w.semantic + w.bm25;

    const results: ScoredMemory[] = entries.map((entry, i) => {
        const weighted =
            w.topic * topicScore(queryTokens, queryRaw, entry) +
            w.emotion * (hasQueryEmotion ? emotionScore(qv, qa, entry) : 0) +
            w.time * timeScore(entry, now) +
            w.importance * importanceScore(entry) +
            w.touch * touchScore(entry) +
            w.semantic * semanticScore(ctx.queryEmbedding, entry) +
            w.bm25 * bm25Norm[i];

        let score = (weighted / totalWeight) * 100;

        const literalHit = isLiteralHit(queryRaw, entry);
        if (literalHit) score += LITERAL_HIT_BONUS;
        if (entry.resolved) score *= RESOLVED_DEMOTE_FACTOR;

        return { entry, score, literalHit };
    });

    results.sort((a, b) => b.score - a.score);
    return results;
}
