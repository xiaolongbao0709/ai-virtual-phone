// lib/mascot-memory-store.ts
// 小卷三层记忆存储引擎：核心记忆(core) + 长期记忆(long_term) + 短期记忆(上下文)
//
// 设计原则：
// - 核心记忆：仅用户显式操作写入，永久保留，最高权重
// - 长期记忆：AI 自动 + 用户手动，跨会话保留，可增删改
// - 存储：IndexedDB，独立于聊天记录，按 related_to 隔离

const DB_NAME = "AiPhoneMascotDB";
const DB_VERSION = 4; // v4: + mascot_memories store (replaces old "memory" single-entry store)
const STORE_NAME = "mascot_memories";

// ── 类型 ──

export type MascotMemoryLayer = "core" | "long_term";

export type MascotMemoryItem = {
  entry_id: string;         // 唯一 ID，格式: mem_YYYYMMDD_xxxx
  layer: MascotMemoryLayer;
  content: string;          // 记忆内容
  tags: string[];           // 分类标签，如 ["偏好", "饮食"]
  related_to: string;       // "default"=关于用户本身，或角色名=关于该角色
  created_at: number;       // Unix 毫秒时间戳
  last_accessed_at: number;
  access_count: number;
  source: "auto" | "user";  // auto=AI 自动识别写入, user=用户手动写入
  confidence: number;       // 0~1，自动写入时的置信度
};

export type MemorySearchResult = MascotMemoryItem & {
  relevance?: string;       // 搜索时附加的匹配说明
};

export type MemorySummaryResult = {
  newEntries: MascotMemoryItem[];
  updatedEntries: MascotMemoryItem[];
  deletedEntryIds: string[];
};

// ── 工具函数 ──

function generateEntryId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `mem_${date}_${rand}`;
}

function nowMs(): number {
  return Date.now();
}

// ── DB 操作 ──

function openMemoryStore(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB 不可用"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // 保留旧的 chat store
      if (!db.objectStoreNames.contains("chat")) {
        db.createObjectStore("chat");
      }
      // 新记忆 store（替换旧的 "memory" store）
      if (db.objectStoreNames.contains("memory")) {
        db.deleteObjectStore("memory");
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "entry_id" });
        store.createIndex("layer", "layer", { unique: false });
        store.createIndex("related_to", "related_to", { unique: false });
        store.createIndex("created_at", "created_at", { unique: false });
        store.createIndex("layer_related", ["layer", "related_to"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: "readonly" | "readwrite",
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>
): Promise<T> {
  const db = await openMemoryStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    try {
      const result = fn(store);
      if (result instanceof IDBRequest || ("onsuccess" in (result as object))) {
        const req = result as IDBRequest;
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } else {
        resolve(result as T);
      }
    } catch (err) {
      reject(err);
    }
  });
}

// ── 公开 API ──

/** 写入/更新一条记忆 */
export async function upsertMemory(item: Omit<MascotMemoryItem, "entry_id" | "created_at" | "last_accessed_at" | "access_count"> & { entry_id?: string }): Promise<MascotMemoryItem> {
  const now = nowMs();
  const entry: MascotMemoryItem = {
    entry_id: item.entry_id || generateEntryId(),
    layer: item.layer,
    content: item.content,
    tags: item.tags || [],
    related_to: item.related_to || "default",
    created_at: item.entry_id ? now : now, // 保留原始创建时间？
    last_accessed_at: now,
    access_count: 0,
    source: item.source,
    confidence: item.confidence ?? (item.source === "user" ? 1.0 : 0.8),
  };

  // 如果是新条目（没有 entry_id），检查去重
  if (!item.entry_id) {
    const existing = await searchMemories({ layer: item.layer, relatedTo: item.related_to });
    const dup = existing.find(e =>
      e.content.trim().toLowerCase() === item.content.trim().toLowerCase()
    );
    if (dup) {
      // 去重合并：更新时间戳和信心值
      return await upsertMemory({
        entry_id: dup.entry_id,
        layer: dup.layer,
        content: item.content,
        tags: [...new Set([...dup.tags, ...item.tags])],
        related_to: dup.related_to,
        source: dup.source,
        confidence: Math.max(dup.confidence, item.confidence ?? 0.8),
      });
    }
  }

  // 对于更新，保留原有的 created_at 和 access_count
  if (item.entry_id) {
    try {
      const old = await getMemoryById(item.entry_id);
      if (old) {
        entry.created_at = old.created_at;
        entry.access_count = old.access_count + 1;
      }
    } catch { /* 旧条目不存在，当新条目处理 */ }
  }

  return withStore("readwrite", (store) => {
    return new Promise((resolve, reject) => {
      const req = store.put(entry);
      req.onsuccess = () => resolve(entry);
      req.onerror = () => reject(req.error);
    });
  });
}

/** 按 entry_id 读取单条记忆 */
export async function getMemoryById(entryId: string): Promise<MascotMemoryItem | null> {
  try {
    return await withStore("readonly", (store) => store.get(entryId));
  } catch {
    return null;
  }
}

/** 搜索/检索记忆 */
export async function searchMemories(params: {
  layer?: MascotMemoryLayer;
  relatedTo?: string;
  tags?: string[];
  keyword?: string;
  limit?: number;
  minConfidence?: number;
  timeRange?: { start?: number; end?: number };
}): Promise<MemorySearchResult[]> {
  const { layer, relatedTo, tags, keyword, limit = 20, minConfidence, timeRange } = params;

  try {
    const db = await openMemoryStore();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);

      let req: IDBRequest;
      if (layer && relatedTo) {
        const idx = store.index("layer_related");
        req = idx.getAll(IDBKeyRange.only([layer, relatedTo]));
      } else if (layer) {
        const idx = store.index("layer");
        req = idx.getAll(layer);
      } else if (relatedTo) {
        const idx = store.index("related_to");
        req = idx.getAll(relatedTo);
      } else {
        req = store.getAll();
      }

      req.onsuccess = () => {
        let results: MascotMemoryItem[] = req.result || [];

        // 后过滤
        if (keyword) {
          const kw = keyword.toLowerCase();
          results = results.filter(e =>
            e.content.toLowerCase().includes(kw) ||
            e.tags.some(t => t.toLowerCase().includes(kw))
          );
        }

        if (tags && tags.length > 0) {
          results = results.filter(e =>
            tags.some(t => e.tags.some(et => et.toLowerCase() === t.toLowerCase()))
          );
        }

        if (minConfidence !== undefined) {
          results = results.filter(e => e.confidence >= minConfidence);
        }

        if (timeRange) {
          if (timeRange.start) results = results.filter(e => e.created_at >= timeRange.start!);
          if (timeRange.end) results = results.filter(e => e.created_at <= timeRange.end!);
        }

        // 按 access_count * confidence 排序（越高越靠前）
        results.sort((a, b) => {
          const scoreA = a.access_count * a.confidence;
          const scoreB = b.access_count * b.confidence;
          if (scoreB !== scoreA) return scoreB - scoreA;
          return b.last_accessed_at - a.last_accessed_at;
        });

        results = results.slice(0, limit);

        // 更新访问时间（fire and forget）
        updateAccessTimes(results.map(r => r.entry_id)).catch(() => {});

        // 附加匹配说明
        const enriched: MemorySearchResult[] = results.map(r => {
          let relevance = "";
          if (keyword) {
            const idx = r.content.toLowerCase().indexOf(keyword.toLowerCase());
            if (idx >= 0) {
              const start = Math.max(0, idx - 10);
              const end = Math.min(r.content.length, idx + keyword.length + 20);
              relevance = `…${r.content.slice(start, end)}…`;
            }
          }
          return { ...r, relevance: relevance || r.content.slice(0, 50) };
        });

        resolve(enriched);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** 按 entry_id 删除记忆 */
export async function deleteMemory(entryId: string): Promise<boolean> {
  try {
    await withStore("readwrite", (store) => store.delete(entryId));
    return true;
  } catch {
    return false;
  }
}

/** 批量删除（按查询条件） */
export async function deleteMemories(params: {
  layer?: MascotMemoryLayer;
  relatedTo?: string;
  keyword?: string;
}): Promise<number> {
  const results = await searchMemories({ ...params, limit: 1000 });
  let deleted = 0;
  for (const r of results) {
    if (await deleteMemory(r.entry_id)) deleted++;
  }
  return deleted;
}

/** 清空全部记忆（或指定 layer） */
export async function clearAllMemories(layer?: MascotMemoryLayer): Promise<number> {
  return deleteMemories({ layer });
}

/** 获取记忆统计 */
export async function getMemoryStats(): Promise<{
  total: number;
  coreCount: number;
  longTermCount: number;
  byRelatedTo: Record<string, number>;
  lastUpdated: number | null;
}> {
  const all = await searchMemories({ limit: 10000 });
  const byRelatedTo: Record<string, number> = {};
  let coreCount = 0;
  let longTermCount = 0;
  let lastUpdated: number | null = null;

  for (const m of all) {
    if (m.layer === "core") coreCount++;
    else longTermCount++;
    byRelatedTo[m.related_to] = (byRelatedTo[m.related_to] || 0) + 1;
    if (lastUpdated === null || m.last_accessed_at > lastUpdated) {
      lastUpdated = m.last_accessed_at;
    }
  }

  return {
    total: all.length,
    coreCount,
    longTermCount,
    byRelatedTo,
    lastUpdated,
  };
}

/** 导出全部记忆为 JSON */
export async function exportMemories(): Promise<MascotMemoryItem[]> {
  return searchMemories({ limit: 10000 });
}

/** 导入记忆（合并模式：相同 content 的去重） */
export async function importMemories(items: MascotMemoryItem[]): Promise<number> {
  let imported = 0;
  for (const item of items) {
    await upsertMemory({
      layer: item.layer,
      content: item.content,
      tags: item.tags || [],
      related_to: item.related_to || "default",
      source: item.source,
      confidence: item.confidence,
    });
    imported++;
  }
  return imported;
}

// ── 内部辅助 ──

async function updateAccessTimes(entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  const now = nowMs();
  try {
    const db = await openMemoryStore();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const id of entryIds) {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const entry = getReq.result as MascotMemoryItem | undefined;
        if (entry) {
          entry.last_accessed_at = now;
          entry.access_count += 1;
          store.put(entry);
        }
      };
    }
    await new Promise<void>((resolve) => { tx.oncomplete = () => resolve(); });
  } catch { /* 静默 */ }
}
