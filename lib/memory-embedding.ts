// lib/memory-embedding.ts
// Embedding generation + vector/keyword search for memory retrieval.

import type { ApiConfig } from "./settings-types";
import type { MemoryEntry, MemorySearchResult, MemoryStatus } from "./memory-types";
import { determineBaseUrl, buildRequestHeaders } from "./api-helpers";
import { loadMemoryConfig, touchMemoryReadState } from "./memory-storage";

// ── Provider → Embedding Model Mapping ──

export function getEmbeddingModelForProvider(provider: string): string | null {
    switch (provider) {
        case "OpenAI": return "text-embedding-3-small";
        case "SiliconFlow": return "BAAI/bge-large-zh-v1.5";
        case "TogetherAI": return "BAAI/bge-large-en-v1.5";
        case "Zhipu": return "embedding-2";
        default: return null;
    }
}

/** 常见向量模型命名特征（embedding-3 / text-embedding-* / bge-* / m3e / gte 等） */
const EMBEDDING_MODEL_NAME_RE = /embed|bge-|m3e|text2vec|\be5\b|\bgte\b/i;

export function isEmbeddingModelName(model: string | undefined): boolean {
    return Boolean(model && EMBEDDING_MODEL_NAME_RE.test(model));
}

/** 解析该配置应使用的向量模型：默认模型名看起来像向量模型就直接用
 *  （自定义服务商、以及智谱 embedding-3 等新模型因此可配），否则回退
 *  按服务商的内置映射（老用户绑普通对话配置的行为不变）。 */
export function resolveEmbeddingModel(apiConfig: Pick<ApiConfig, "provider" | "defaultModel">): string | null {
    const model = apiConfig.defaultModel?.trim();
    if (model && isEmbeddingModelName(model)) return model;
    return getEmbeddingModelForProvider(apiConfig.provider);
}

// ── Embedding API ──

export async function generateEmbedding(
    text: string,
    apiConfig: ApiConfig,
    options: { throwOnError?: boolean } = {}
): Promise<number[] | null> {
    const fail = (message: string): null => {
        if (options.throwOnError) throw new Error(message);
        console.warn("[MemoryEmbedding]", message);
        return null;
    };

    const embeddingModel = resolveEmbeddingModel(apiConfig);
    if (!embeddingModel) return fail("该配置无可用向量模型（默认模型名不像向量模型，服务商也无内置映射）");
    if (!apiConfig.apiKey) return fail("缺少 API Key");

    const baseUrl = determineBaseUrl(apiConfig);
    if (!baseUrl) return fail("缺少 Base URL");

    const url = baseUrl.endsWith("/embeddings")
        ? baseUrl
        : `${baseUrl.replace(/\/$/, "")}/embeddings`;

    const headers = buildRequestHeaders(apiConfig, baseUrl);

    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: embeddingModel,
                input: text,
            }),
        });
        if (!res.ok) {
            return fail(`API 错误 ${res.status}: ${await res.text()}`);
        }
        const data = await res.json();
        const embedding = data?.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
            return fail("接口未返回向量数据");
        }
        return embedding;
    } catch (err) {
        if (options.throwOnError) throw err;
        console.warn("[MemoryEmbedding] fetch error:", err);
        return null;
    }
}


// ── Vector math ──

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

// ── Memory status + recency helpers ──

function normalizeImportance(importance: number | undefined): number {
    if (!Number.isFinite(importance)) return 0;
    return Math.max(0, Math.min(1, importance));
}

function getMemoryStatus(entry: MemoryEntry): MemoryStatus {
    const status = entry.metadata?.status;
    if (status === "active" || status === "sleeping" || status === "archived") {
        return status;
    }
    return "active";
}

function statusAwareSemanticScore(entry: MemoryEntry, semanticScore: number): number {
    const status = getMemoryStatus(entry);
    if (status === "sleeping") {
        return semanticScore * 0.75;
    }
    return semanticScore;
}

function getReadCount(entry: MemoryEntry): number {
    const count = Number(entry.metadata?.readCount ?? 0);
    return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function getLastReadAt(entry: MemoryEntry): string | null {
    const value = entry.metadata?.lastReadAt;
    return typeof value === "string" && value.trim() ? value : null;
}

export function computeMemoryRecencyScore(
    entry: MemoryEntry,
    now: number = Date.now(),
    options?: { halfLifeHours?: number; readBoost?: number }
): number {
    const config = loadMemoryConfig();
    const halfLifeHours = options?.halfLifeHours ?? config.recallHalfLifeHours ?? 24;
    const readBoost = options?.readBoost ?? config.recallReadBoost ?? 0.7;
    const lastReadAt = getLastReadAt(entry) ?? entry.updatedAt ?? entry.createdAt;
    const lastReadMs = new Date(lastReadAt).getTime();
    if (!Number.isFinite(lastReadMs)) {
        return 0;
    }
    const ageHours = Math.max(0, (now - lastReadMs) / 3600000);
    const decay = Math.exp(-(Math.log(2) / Math.max(halfLifeHours, 1)) * ageHours);
    const readCountBoost = 1 + readBoost * getReadCount(entry);
    return Math.max(0, Math.min(1, decay * readCountBoost));
}

export function scoreMemoryEntry(
    entry: MemoryEntry,
    semanticScore: number,
    now: number = Date.now()
): number {
    const config = loadMemoryConfig();
    const vectorWeight = Number.isFinite(config.recallAlpha) ? config.recallAlpha : 0.55;
    const importanceWeight = Number.isFinite(config.recallBeta) ? config.recallBeta : 0.25;
    const recencyWeight = Number.isFinite(config.recallGamma) ? config.recallGamma : 0.20;

    const normalizedSemantic = Math.max(0, Math.min(1, statusAwareSemanticScore(entry, semanticScore)));
    const normalizedImportance = normalizeImportance(entry.importance);
    const recencyScore = computeMemoryRecencyScore(entry, now);

    return vectorWeight * normalizedSemantic
        + importanceWeight * normalizedImportance
        + recencyWeight * recencyScore;
}

// ── Search ──

export async function searchMemories(
    query: string,
    memories: MemoryEntry[],
    apiConfig: ApiConfig | null,
    topK: number
): Promise<MemorySearchResult[]> {
    if (memories.length === 0) return [];

    const activeMemories = memories.filter(entry => getMemoryStatus(entry) !== "archived");
    if (activeMemories.length === 0) return [];

    const now = Date.now();
    const semanticMap = new Map<string, number>();

    // Try vector search if the config resolves to an embedding model
    if (apiConfig && resolveEmbeddingModel(apiConfig)) {
        const queryEmbedding = await generateEmbedding(query, apiConfig);
        if (queryEmbedding) {
            const withEmbeddings = activeMemories.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                for (const entry of withEmbeddings) {
                    semanticMap.set(entry.id, cosineSimilarity(queryEmbedding, entry.embedding!));
                }
            }
        }
    }

    if (semanticMap.size === 0) {
        const keywordResults = keywordSearch(query, activeMemories, topK);
        return keywordResults.map(result => ({
            entry: result.entry,
            score: scoreMemoryEntry(result.entry, result.score, now),
        }));
    }

    const scored = activeMemories.map(entry => ({
        entry,
        score: scoreMemoryEntry(entry, semanticMap.get(entry.id) ?? 0, now),
    }));

    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, topK);
    for (const result of topResults) {
        void touchMemoryReadState(result.entry.id);
    }
    return topResults;
}

// ── Keyword fallback ──

export function keywordSearch(
    query: string,
    memories: MemoryEntry[],
    topK: number
): MemorySearchResult[] {
    const queryTokens = extractTokens(query);
    if (queryTokens.length === 0) {
        // Return most recent
        return memories.slice(-topK).reverse().map(entry => ({ entry, score: 0.5 }));
    }

    const scored: MemorySearchResult[] = memories.map(entry => {
        const entryTokens = extractTokens(entry.content);
        if (entryTokens.length === 0) return { entry, score: 0 };
        let matched = 0;
        for (const qt of queryTokens) {
            if (entryTokens.some(et => et.includes(qt) || qt.includes(et))) {
                matched++;
            }
        }
        return { entry, score: matched / queryTokens.length };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(r => r.score > 0);
}

/** Extract tokens: split on punctuation/whitespace, plus CJK bigrams */
function extractTokens(text: string): string[] {
    const lower = text.toLowerCase();
    // Latin words
    const words = lower.match(/[a-zA-Z0-9]+/g) || [];
    // CJK bigrams
    const cjk = lower.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]+/g) || [];
    const bigrams: string[] = [];
    for (const seg of cjk) {
        for (let i = 0; i < seg.length - 1; i++) {
            bigrams.push(seg.slice(i, i + 2));
        }
        if (seg.length === 1) bigrams.push(seg);
    }
    return [...words, ...bigrams];
}

/** Check keyword overlap ratio between two texts */
export function keywordOverlapRatio(textA: string, textB: string): number {
    const tokensA = new Set(extractTokens(textA));
    const tokensB = new Set(extractTokens(textB));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokensA) {
        if (tokensB.has(t)) overlap++;
    }
    return overlap / Math.min(tokensA.size, tokensB.size);
}
