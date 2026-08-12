// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;

    // ── Ombre Brain 扩展元数据（全部可选，旧数据缺省时按默认值处理）──
    tags?: string[];             // 标签（≤64 个，每个 ≤128 字符）
    domain?: string[];           // 主题域（≤16 个）
    valence?: number;            // 情感效价 0-1（消极→积极），默认 0.5
    arousal?: number;            // 情感唤醒 0-1（平静→激动），默认 0.5
    lastActive?: string;         // 最后激活时间（ISO），缺省取 updatedAt
    activationCount?: number;    // 被召回次数（影响衰减与 touch 评分）
    pinned?: boolean;            // 钉选：不参与衰减归档
    protected?: boolean;         // 保护：同 pinned，importance 视为满值
    resolved?: boolean;          // 已放下：排序降权 ×0.3，关键词命中仍可召回
    digested?: boolean;          // 已消化：加速淡化
    dontSurface?: boolean;       // 不再主动浮现（可被显式搜索）
    archived?: boolean;          // 已归档（软删除，不参与常规检索）
    deletedAt?: string;          // 软删除时间（ISO）
    whyRemembered?: string;      // 为什么记得（自由文本，≤500 字符）
    meaning?: string[];          // 意义列表（≤50 条）
};

/** Ombre Brain 评分维度权重（breath 检索核心） */
export type MemoryScoringWeights = {
    topic: number;       // 主题相关（模糊匹配）
    emotion: number;     // 情感共振（valence/arousal 欧氏距离）
    time: number;        // 时间近度（指数衰减）
    importance: number;  // 重要度
    touch: number;       // 召回频率
    semantic: number;    // 语义相似（embedding 余弦）
    bm25: number;        // 关键词匹配（BM25）
};

export const DEFAULT_SCORING_WEIGHTS: MemoryScoringWeights = {
    topic: 4.0,
    emotion: 2.0,
    time: 1.5,
    importance: 1.0,
    touch: 1.0,
    semantic: 2.5,
    bm25: 1.5,
};

/** 字面命中（查询串原样出现）→ 排序加分并强制召回 */
export const LITERAL_HIT_BONUS = 25;
/** resolved 桶排序降权系数 */
export const RESOLVED_DEMOTE_FACTOR = 0.3;
/** semantic 维度生效的余弦相似度阈值 */
export const SEMANTIC_THRESHOLD = 0.65;
/** 时间近度衰减系数：e^(-0.02 × days) */
export const TIME_DECAY_RATE = 0.02;
/** 时间涟漪：touch 后 ±48h 邻居 activation_count 增量与上限 */
export const RIPPLE_WINDOW_HOURS = 48;
export const RIPPLE_INCREMENT = 0.3;
export const RIPPLE_MAX_NEIGHBORS = 5;
/** touch 评分归一化上限（召回次数） */
export const TOUCH_NORMALIZE_CAP = 10;

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    decayEnabled: boolean;                  // OB 衰减引擎：低分记忆自动归档（软删除）
    decayArchiveThreshold: number;          // 衰减得分低于该值移入归档（0-1）
    writeAdmissionEnabled: boolean;         // OB 写入门卫：自动写入前做重复率检测
    writeAdmissionDupThreshold: number;     // 重复率超过该值拒绝写入（0-1）
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 100-200字
- 不要包含格式标记
- 在总结正文之后，另起一行输出一行元数据（仅此一行允许格式）：
[META] valence=0到1的情感效价 arousal=0到1的情感唤醒 importance=0到1的重要度 tags=逗号分隔的3-6个中文标签

总结：`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    decayEnabled: true,
    decayArchiveThreshold: 0.15,
    writeAdmissionEnabled: true,
    writeAdmissionDupThreshold: 0.85,
};
