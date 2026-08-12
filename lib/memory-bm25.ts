// lib/memory-bm25.ts
// Okapi BM25 keyword ranking for memory retrieval (Ombre Brain port).
// Full BM25 formula — no simplification. Only the tokenizer differs from the
// Python original (jieba → hybrid CJK tokenizer below).

// ── Tokenizer ──
// Hybrid strategy for Chinese without jieba:
//   1. Latin/digit runs → whole words (lowercased)
//   2. CJK runs → unigrams + bigrams (bigrams approximate jieba words;
//      unigrams guarantee recall for single-char terms like 猫/家)
// Both query and documents use the same tokenizer, so matching is consistent.
// This is the standard client-side approach; ranking quality is close to
// jieba-based BM25 for retrieval purposes because IDF automatically down-weights
// meaningless bigrams (they appear everywhere → low IDF).

export function tokenizeForBm25(text: string): string[] {
    const lower = text.toLowerCase();
    const tokens: string[] = [];
    // Latin words & numbers
    const words = lower.match(/[a-z0-9]+/g);
    if (words) tokens.push(...words);
    // CJK runs → unigrams + bigrams
    const cjkRuns = lower.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]+/g);
    if (cjkRuns) {
        for (const run of cjkRuns) {
            for (let i = 0; i < run.length; i++) {
                tokens.push(run[i]);
                if (i < run.length - 1) tokens.push(run.slice(i, i + 2));
            }
        }
    }
    return tokens;
}

// ── Okapi BM25 ──

const K1 = 1.5;
const B = 0.75;

export type Bm25Index = {
    /** term → document frequency */
    df: Map<string, number>;
    /** per-document term frequency maps */
    docTf: Map<string, number>[];
    /** per-document token counts */
    docLen: number[];
    avgDocLen: number;
    docCount: number;
};

/** Build a BM25 index over document bodies (one string per document). */
export function buildBm25Index(docs: string[]): Bm25Index {
    const df = new Map<string, number>();
    const docTf: Map<string, number>[] = [];
    const docLen: number[] = [];
    let totalLen = 0;

    for (const doc of docs) {
        const tokens = tokenizeForBm25(doc);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
        docTf.push(tf);
        docLen.push(tokens.length);
        totalLen += tokens.length;
    }

    return {
        df,
        docTf,
        docLen,
        avgDocLen: docs.length > 0 ? totalLen / docs.length : 0,
        docCount: docs.length,
    };
}

/**
 * Score every document in the index against the query.
 * Returns raw BM25 scores (unbounded, >= 0), aligned with the doc order
 * used to build the index. Standard Okapi BM25:
 *   score = Σ IDF(q) · tf·(k1+1) / (tf + k1·(1-b+b·len/avgLen))
 *   IDF   = ln( (N - df + 0.5) / (df + 0.5) + 1 )
 */
export function scoreBm25(index: Bm25Index, query: string): number[] {
    const scores = new Array<number>(index.docCount).fill(0);
    if (index.docCount === 0 || index.avgDocLen === 0) return scores;

    const queryTerms = new Set(tokenizeForBm25(query));
    for (const term of queryTerms) {
        const df = index.df.get(term);
        if (!df) continue;
        const idf = Math.log((index.docCount - df + 0.5) / (df + 0.5) + 1);
        for (let i = 0; i < index.docCount; i++) {
            const tf = index.docTf[i].get(term);
            if (!tf) continue;
            const denom = tf + K1 * (1 - B + (B * index.docLen[i]) / index.avgDocLen);
            scores[i] += idf * ((tf * (K1 + 1)) / denom);
        }
    }
    return scores;
}

/** Normalize raw BM25 scores to 0-1 by dividing by the batch max (0 if all zero). */
export function normalizeBm25Scores(raw: number[]): number[] {
    let max = 0;
    for (const s of raw) if (s > max) max = s;
    if (max <= 0) return raw.map(() => 0);
    return raw.map(s => s / max);
}
