// lib/mascot-memory.ts
// 小卷长期记忆：三层模型（核心记忆 / 长期记忆 / 短期记忆），注入到系统提示词
//
// v2 升级：
// - 底层存储迁移到 mascot-memory-store.ts（IndexedDB 三层模型）
// - 保留旧 API 向后兼容（getMascotMemory / updateMascotMemory / clearMascotMemory）
// - generateMemoryPrompt() 升级为三层格式：核心记忆 → 长期记忆 → 近期上下文
// - 新增记忆 CRUD 便捷 API（供记忆工具套件调用）

import {
  upsertMemory,
  searchMemories,
  getMemoryById,
  deleteMemory,
  deleteMemories,
  clearAllMemories,
  getMemoryStats,
  exportMemories,
  importMemories,
  type MascotMemoryItem,
  type MascotMemoryLayer,
  type MemorySearchResult,
} from "./mascot-memory-store";

// 重新导出存储层的类型
export type { MascotMemoryItem, MascotMemoryLayer, MemorySearchResult };

// ── 向后兼容类型（v1 API） ──

export type MascotMemoryEntry = {
  version: 1;
  lastUpdated: string;
  recentTopics: string[];        // 最近 5 个讨论话题
  charactersDiscussed: string[];  // 讨论过的角色名
  preferences: string[];          // 用户明确表达的偏好
  interactionCount: number;
};

export type { MascotMemoryItem as MemoryItem, MascotMemoryLayer as MemoryLayer };

const DEFAULT_MEMORY: MascotMemoryEntry = {
  version: 1,
  lastUpdated: new Date().toISOString(),
  recentTopics: [],
  charactersDiscussed: [],
  preferences: [],
  interactionCount: 0,
};

// ── 向旧 API 提供兼容内存缓存 ──

let _legacyCache: MascotMemoryEntry = { ...DEFAULT_MEMORY, lastUpdated: new Date().toISOString() };

/** v1 兼容：读取旧格式记忆（从新 store 反向填充） */
export async function getMascotMemory(): Promise<MascotMemoryEntry> {
  try {
    const longTerm = await searchMemories({ layer: "long_term", limit: 100 });
    const topics: string[] = [];
    const prefs: string[] = [];
    const chars: string[] = [];

    for (const m of longTerm) {
      if (m.tags.includes("话题")) topics.push(m.content.slice(0, 30));
      if (m.tags.includes("偏好")) prefs.push(m.content);
    }

    // 从旧缓存补充
    if (topics.length === 0) topics.push(..._legacyCache.recentTopics);
    if (prefs.length === 0) prefs.push(..._legacyCache.preferences);

    _legacyCache = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      recentTopics: topics.slice(0, 5),
      charactersDiscussed: chars.slice(0, 8),
      preferences: prefs.slice(0, 5),
      interactionCount: _legacyCache.interactionCount,
    };
    return _legacyCache;
  } catch {
    return { ..._legacyCache };
  }
}

/** v1 兼容：清除全部记忆 */
export async function clearMascotMemory(): Promise<void> {
  await clearAllMemories();
  _legacyCache = { ...DEFAULT_MEMORY };
}

/** v1 兼容：根据用户消息更新记忆（由聊天 store 在每轮结束后调用） */
export async function updateMascotMemory(userMessage: string): Promise<void> {
  const msg = userMessage.trim();
  if (!msg || msg.length < 6) return;

  _legacyCache.lastUpdated = new Date().toISOString();
  _legacyCache.interactionCount += 1;

  // ── 话题识别 ──
  const topics = detectTopics(msg);
  for (const t of topics) {
    if (!_legacyCache.recentTopics.includes(t)) {
      _legacyCache.recentTopics.unshift(t);
    }
  }
  _legacyCache.recentTopics = _legacyCache.recentTopics.slice(0, 5);

  // ── 偏好提取 ──
  const prefs = extractPreferences(msg);
  for (const p of prefs) {
    if (!_legacyCache.preferences.includes(p)) {
      _legacyCache.preferences.push(p);
    }
  }
  _legacyCache.preferences = _legacyCache.preferences.slice(0, 5);

  // ── 角色名提取 ──
  const chars = extractCharacterNames(msg);
  for (const c of chars) {
    if (!_legacyCache.charactersDiscussed.includes(c)) {
      _legacyCache.charactersDiscussed.push(c);
    }
  }
  _legacyCache.charactersDiscussed = _legacyCache.charactersDiscussed.slice(0, 8);

  // ── 自动写入长期记忆（偏好类、事实类高置信度信息）──
  for (const p of prefs) {
    await upsertMemory({
      layer: "long_term",
      content: p,
      tags: ["偏好", "自动"],
      related_to: "default",
      source: "auto",
      confidence: 0.7,
    });
  }
}

// ── v2 新增 API（供记忆工具套件调用）──

/** 搜索记忆 */
export async function searchMascotMemories(params: {
  keyword?: string;
  layer?: MascotMemoryLayer;
  relatedTo?: string;
  tags?: string[];
  limit?: number;
  timeRange?: { start?: number; end?: number };
}): Promise<MemorySearchResult[]> {
  return searchMemories({
    keyword: params.keyword,
    layer: params.layer,
    relatedTo: params.relatedTo,
    tags: params.tags,
    limit: params.limit || 20,
  });
}

/** 写入记忆 */
export async function writeMascotMemory(params: {
  layer: MascotMemoryLayer;
  content: string;
  tags?: string[];
  relatedTo?: string;
  source?: "auto" | "user";
  confidence?: number;
}): Promise<MascotMemoryItem> {
  return upsertMemory({
    layer: params.layer,
    content: params.content,
    tags: params.tags || [],
    related_to: params.relatedTo || "default",
    source: params.source || "auto",
    confidence: params.confidence ?? (params.source === "user" ? 1.0 : 0.8),
  });
}

/** 更新记忆 */
export async function updateMascotMemoryEntry(params: {
  entryId: string;
  content?: string;
  tags?: string[];
  layer?: MascotMemoryLayer;
}): Promise<MascotMemoryItem | null> {
  const existing = await getMemoryById(params.entryId);
  if (!existing) return null;

  return upsertMemory({
    entry_id: params.entryId,
    layer: params.layer || existing.layer,
    content: params.content ?? existing.content,
    tags: params.tags ?? existing.tags,
    related_to: existing.related_to,
    source: existing.source,
    confidence: existing.confidence,
  });
}

/** 删除记忆 */
export async function deleteMascotMemory(entryId?: string, query?: string): Promise<number> {
  if (entryId) {
    return (await deleteMemory(entryId)) ? 1 : 0;
  }
  if (query) {
    return deleteMemories({ keyword: query });
  }
  return 0;
}

/** 沉淀记忆：从聊天记录中提取长期记忆条目（由 LLM 总结的结果直接写入） */
export async function summarizeMemories(entries: Array<{
  layer: MascotMemoryLayer;
  content: string;
  tags: string[];
  relatedTo?: string;
}>): Promise<MascotMemoryItem[]> {
  const results: MascotMemoryItem[] = [];
  for (const e of entries) {
    const item = await upsertMemory({
      layer: e.layer,
      content: e.content,
      tags: e.tags,
      related_to: e.relatedTo || "default",
      source: "auto",
      confidence: 0.85,
    });
    results.push(item);
  }
  return results;
}

/** 获取记忆统计 */
export async function getMascotMemoryStats() {
  return getMemoryStats();
}

/** 导出全部记忆 */
export async function exportMascotMemories() {
  return exportMemories();
}

/** 导入记忆 */
export async function importMascotMemories(items: MascotMemoryItem[]) {
  return importMemories(items);
}

// ── 话题检测 ──

const TOPIC_PATTERNS: Array<[RegExp, string]> = [
  [/角色卡|人设|人物|persona|性格|外貌|设定/, "角色卡"],
  [/世界书|worldbook|词条|lorebook/, "世界书"],
  [/预设|preset|回复风格/, "预设"],
  [/正则|regex|替换规则/, "正则"],
  [/CSS|样式|界面|主题|皮肤/, "CSS/样式"],
  [/生图|图片|锁脸|照片|画风|图片生成|生成图/, "生图"],
  [/朋友圈|moment|动态|发帖/, "朋友圈"],
  [/相册|album/, "相册"],
  [/聊天|对话|回复|语气|说话/, "聊天/对话"],
  [/模板|指令/, "指令/模板"],
  [/导航|页面|功能|入口|在哪/, "功能导航"],
  [/小说|剧情|故事|VN|visual.?novel/, "剧情/小说"],
  [/创建|新增|添加|做个|帮我写|帮我弄/, "创建"],
  [/修改|改一下|调整|优化/, "修改/优化"],
  [/记忆|memory|记住|忘了|记得/, "记忆"],
];

function detectTopics(msg: string): string[] {
  const found: string[] = [];
  for (const [re, label] of TOPIC_PATTERNS) {
    if (re.test(msg) && !found.includes(label)) {
      found.push(label);
    }
  }
  return found.length > 0 ? found : ["闲聊"];
}

// ── 偏好提取 ──

const PREF_PATTERNS: RegExp[] = [
  /我(喜欢|偏好|倾向|比较喜欢|想要|希望)(.{2,20}?)(?:[。，,!\s]|$)/g,
  /不(喜欢|想要|太想要)(.{2,20}?)(?:[。，,!\s]|$)/g,
  /(偏好|倾向|风格)(?:是|：|:)(.{2,20}?)(?:[。，,!\s]|$)/g,
];

function extractPreferences(msg: string): string[] {
  const prefs: string[] = [];
  for (const pattern of PREF_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(msg)) !== null) {
      const text = match[0].replace(/[。，,!\s]+$/, "").trim();
      if (text.length >= 4 && text.length <= 30) {
        prefs.push(text);
      }
    }
    pattern.lastIndex = 0;
  }
  return prefs;
}

// ── 角色名提取 ──

function extractCharacterNames(msg: string): string[] {
  const names: string[] = [];
  const namePattern = /[\u4e00-\u9fff]{2,3}/g;
  const commonWords = new Set([
    "我们", "他们", "你们", "这个", "那个", "什么", "怎么", "一个",
    "可以", "不是", "没有", "现在", "然后", "如果", "因为", "所以",
    "喜欢", "想要", "希望", "觉得", "应该", "已经", "还是", "或者",
    "角色", "人物", "世界", "预设", "正则", "样式", "相册", "朋友",
    "首页", "主页", "桌面", "聊天", "设置", "工具", "小卷", "创建",
    "修改", "调整", "添加", "删除", "打开", "关闭", "帮我", "麻烦",
  ]);
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(msg)) !== null) {
    const name = match[0];
    if (!commonWords.has(name) && !names.includes(name)) {
      names.push(name);
    }
  }
  return names.slice(0, 5);
}

// ── 生成记忆提示词（v2：三层模型）──

/** 生成注入到系统提示词的记忆片段（无内容时返回空字符串） */
export async function generateMemoryPrompt(): Promise<string> {
  try {
    const coreMemories = await searchMemories({ layer: "core", limit: 20 });
    const longTermMemories = await searchMemories({ layer: "long_term", limit: 30 });

    const hasCore = coreMemories.length > 0;
    const hasLong = longTermMemories.length > 0;

    if (!hasCore && !hasLong && _legacyCache.recentTopics.length === 0) {
      return "";
    }

    const lines: string[] = [];

    // ── 核心记忆（最高权重，不可遗忘的事实）──
    if (hasCore) {
      lines.push("◇ 核心记忆（永久事实，必须牢记）：");
      for (const m of coreMemories) {
        lines.push(`  - ${m.content}`);
      }
      lines.push("");
    }

    // ── 长期记忆（重要偏好、事件、约定）──
    if (hasLong) {
      lines.push("◇ 长期记忆（重要偏好与事件，可在适当时机自然提及）：");
      // 按置信度降序排列
      const sorted = [...longTermMemories].sort((a, b) => b.confidence - a.confidence);
      const display = sorted.slice(0, 15); // 最多 15 条，控制 token
      for (const m of display) {
        const tagStr = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
        lines.push(`  - ${m.content}${tagStr}`);
      }
      lines.push("");
    }

    // ── 近期上下文（兼容旧格式）──
    if (_legacyCache.recentTopics.length > 0 || _legacyCache.charactersDiscussed.length > 0) {
      lines.push("◇ 近期上下文：");
      if (_legacyCache.recentTopics.length > 0) {
        lines.push(`  最近话题：${_legacyCache.recentTopics.join("、")}`);
      }
      if (_legacyCache.charactersDiscussed.length > 0) {
        lines.push(`  最近角色：${_legacyCache.charactersDiscussed.join("、")}`);
      }
      lines.push("");
    }

    lines.push("（记忆调用规则：1)自然融入对话，不机械复读；2)一次对话主动引用不超过2条；3)不确定时用询问式而非断言式；4)核心记忆不可遗忘，长期记忆按需调用。）");

    return lines.join("\n");
  } catch {
    // fallback 到旧格式
    if (_legacyCache.recentTopics.length === 0 && _legacyCache.preferences.length === 0 && _legacyCache.charactersDiscussed.length === 0) {
      return "";
    }
    const lines: string[] = ["===== 关于用户的长期记忆 ====="];
    if (_legacyCache.recentTopics.length > 0) {
      lines.push(`最近讨论的话题：${_legacyCache.recentTopics.join("、")}`);
    }
    if (_legacyCache.charactersDiscussed.length > 0) {
      lines.push(`讨论过的角色：${_legacyCache.charactersDiscussed.join("、")}`);
    }
    if (_legacyCache.preferences.length > 0) {
      lines.push(`用户偏好：${_legacyCache.preferences.join("；")}`);
    }
    lines.push("（请参考以上信息，让对话更有连续性和针对性。不要一次性全部复述出来，自然地融入回答。）");
    return lines.join("\n");
  }
}
