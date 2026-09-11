// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // Use user-editable prompt template from config, with placeholder substitution
    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    // Call LLM for summarization — compatible with all providers
    // label 用于在「底层调用大模型日志」中标识这是记忆总结调用
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3, label: `记忆总结·${characterName}` },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const summary = result.content;

    // Generate embedding for the summary (only if vector recall is enabled)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const emb = await generateEmbedding(summary, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    // Save as long-term memory
    const now = new Date().toISOString();
    const longTermEntry: MemoryEntry = {
        id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource as MemoryEntry["sourceApp"],
        type: "long_term",
        content: summary,
        embedding,
        importance: 0.8,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedEvents: allEntries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(longTermEntry);

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → 1 long-term memory`);
    return { success: true };
}
