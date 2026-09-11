import type {
  ClearResult,
  DataSource,
  IndexedDbSource,
  IndexedDbSourceBackup,
  KvSource,
  KvSourceBackup,
  LocalStorageSource,
  LocalStorageSourceBackup,
  SourceBackup,
  StoreIndexBackup,
  StoreRecordBackup,
} from "./types";
import {
  deserializeStorageString,
  deserializeValue,
  estimateValueBytes,
  serializeStorageString,
  serializeValue,
  type MediaCollector,
  type MediaResolver,
} from "./serializers";
import { kvEntries, kvGet, kvRemove, kvSetAsync } from "../kv-db";

type SourceStats = {
  records: number;
  bytes: number;
  details?: Array<{ id: string; label: string; records: number; bytes: number }>;
};

const MEMORY_DB_NAME = "ai_phone_memory_db_v1";
const MEMORY_STORE_NAME = "memories";
const MEMORY_INDEX_SPECS: StoreIndexBackup[] = [
  { name: "by_character", keyPath: "characterId", unique: false, multiEntry: false },
  { name: "by_character_type", keyPath: ["characterId", "type"], unique: false, multiEntry: false },
  { name: "by_character_created", keyPath: ["characterId", "createdAt"], unique: false, multiEntry: false },
];

function hasIndexedDb(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function getMissingKnownStoreIndexes(dbName: string, store: IDBObjectStore): StoreIndexBackup[] {
  if (dbName !== MEMORY_DB_NAME || store.name !== MEMORY_STORE_NAME) return [];
  return MEMORY_INDEX_SPECS.filter((index) => !store.indexNames.contains(index.name));
}

function ensureKnownStoreIndexes(dbName: string, store: IDBObjectStore): void {
  for (const index of getMissingKnownStoreIndexes(dbName, store)) {
    store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
  }
}

function matchesKey(key: string, source: { keys?: string[]; prefixes?: string[]; includeAll?: boolean; excludeKeys?: string[]; excludePrefixes?: string[] }): boolean {
  if (source.excludeKeys?.includes(key)) return false;
  if (source.excludePrefixes?.some((prefix) => key.startsWith(prefix))) return false;
  if (source.includeAll) return true;
  if (source.keys?.includes(key)) return true;
  return source.prefixes?.some((prefix) => key.startsWith(prefix)) ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getArrayMergeKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const field of ["id", "key", "characterId", "bookId"]) {
    const raw = value[field];
    if (typeof raw === "string" && raw.trim()) return `${field}:${raw}`;
    if (typeof raw === "number" && Number.isFinite(raw)) return `${field}:${raw}`;
  }
  return null;
}

function tryMergeJsonArrayByKey(existingRaw: string, incomingRaw: string): string | null {
  let existing: unknown;
  let incoming: unknown;
  try {
    existing = JSON.parse(existingRaw);
    incoming = JSON.parse(incomingRaw);
  } catch {
    return null;
  }

  if (!Array.isArray(existing) || !Array.isArray(incoming)) return null;
  if (incoming.length === 0) return null;

  const merged = [...existing];
  const indexByKey = new Map<string, number>();
  for (let index = 0; index < merged.length; index += 1) {
    const key = getArrayMergeKey(merged[index]);
    if (key) indexByKey.set(key, index);
  }

  let changed = false;
  for (const item of incoming) {
    const key = getArrayMergeKey(item);
    if (!key) return null;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(item);
      changed = true;
      continue;
    }
    const before = JSON.stringify(merged[existingIndex]);
    const after = JSON.stringify(item);
    if (before !== after) {
      merged[existingIndex] = item;
      changed = true;
    }
  }

  return changed ? JSON.stringify(merged) : null;
}

function isEffectivelyEmptyJson(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.values(value).every(isEffectivelyEmptyJson);
  return false;
}

function tryReplaceEmptyJsonValue(existingRaw: string, incomingRaw: string): string | null {
  let existing: unknown;
  let incoming: unknown;
  try {
    existing = JSON.parse(existingRaw);
    incoming = JSON.parse(incomingRaw);
  } catch {
    return null;
  }
  if (!isEffectivelyEmptyJson(existing) || isEffectivelyEmptyJson(incoming)) return null;
  return incomingRaw;
}

// Delete a whole IndexedDB database (used to clean up orphaned legacy DBs).
// Resolves regardless of outcome; never throws.
export function deleteDatabase(dbName: string): Promise<void> {
  return new Promise((resolve) => {
    if (!hasIndexedDb()) return resolve();
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function openDb(
  dbName: string,
  version?: number,
  upgrade?: (db: IDBDatabase, tx: IDBTransaction | null) => void,
  opts: { blockedGraceMs?: number; deadlineMs?: number } = {},
): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return null;
  return new Promise((resolve) => {
    const request = version ? indexedDB.open(dbName, version) : indexedDB.open(dbName);
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (db: IDBDatabase | null) => {
      if (settled) {
        // 超时放弃之后连接才姗姗来迟：没人用了，关掉防泄漏。
        db?.close();
        return;
      }
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve(db);
    };
    // 排在一个被 blocked 的升级请求后面的 open 不会收到任何事件，只会无限挂起，
    // 需要总体超时兜底（IDBOpenDBRequest 无法取消，迟到的连接由 settle 关闭）。
    if (opts.deadlineMs && opts.deadlineMs > 0) {
      deadlineTimer = setTimeout(() => settle(null), opts.deadlineMs);
    }
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction);
    request.onsuccess = () => settle(request.result);
    request.onerror = () => settle(null);
    // blocked ≠ 失败：持有旧连接的页面随时可能松手（Dexie 等库收到 versionchange
    // 会自动关闭），之后 success 照常触发。立刻放弃会让「应用自己开着库」这种
    // 最常见的场景整库导入失败（恢复内容不全），所以给一个宽限窗口，等不到再放弃。
    request.onblocked = () => {
      const grace = opts.blockedGraceMs ?? 0;
      if (grace <= 0) return settle(null);
      if (!blockedTimer) blockedTimer = setTimeout(() => settle(null), grace);
    };
  });
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function formatImportError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object") {
    const maybe = error as { name?: unknown; message?: unknown };
    const name = typeof maybe.name === "string" ? maybe.name : "Error";
    const message = typeof maybe.message === "string" ? maybe.message : "";
    return message ? `${name}: ${message}` : name;
  }
  return String(error);
}

function getStoreNames(db: IDBDatabase, source: IndexedDbSource): string[] {
  const all = Array.from(db.objectStoreNames);
  return source.stores?.filter((store) => all.includes(store)) ?? all;
}

async function exportIndexedDbSource(
  source: IndexedDbSource,
  collector?: MediaCollector,
  excludeMedia = false,
): Promise<IndexedDbSourceBackup> {
  const db = await openDb(source.dbName);
  if (!db) {
    // 打不开 ≠ 没数据：无版本 open 对不存在的库会新建空库并成功返回，
    // 走到这里说明是真报错（被浏览器清除中/损坏/被占用）。必须带出错误，
    // 否则会打出一个"看起来成功、实际缺整库"的备份（用户实报踩坑）。
    return { type: "indexeddb", dbName: source.dbName, stores: [], error: `无法打开数据库 ${source.dbName}（可能已被浏览器清除或损坏）` };
  }

  try {
    const storeNames = getStoreNames(db, source);
    const stores: IndexedDbSourceBackup["stores"] = [];

    for (const storeName of storeNames) {
      const transaction = db.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      // Capture index definitions synchronously — store.index() throws once the
      // transaction has finished (it auto-commits after the cursor drains).
      const indexes = Array.from(store.indexNames).map((indexName) => {
        const index = store.index(indexName);
        return {
          name: index.name,
          keyPath: index.keyPath as string | string[],
          unique: index.unique,
          multiEntry: index.multiEntry,
        };
      });
      const records: StoreRecordBackup[] = [];
      const rawRecords: StoreRecordBackup[] = [];
      const request = store.openCursor();

      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          rawRecords.push({ key: cursor.primaryKey, value: cursor.value });
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });

      // 逐条序列化，并立刻松开原始记录的引用。游标必须先排空（IDB 事务里不能 await），
      // 但排空之后没理由让原始值和序列化结果两份同时活着——大库导出时这份多余的拷贝
      // 就是压垮移动端的最后一根稻草。原地置空，顺序不变，边走边还内存。
      for (let index = 0; index < rawRecords.length; index += 1) {
        const record = rawRecords[index];
        rawRecords[index] = undefined as unknown as StoreRecordBackup;
        records.push({
          key: await serializeValue(record.key),
          value: await serializeValue(record.value, collector, { excludeMedia }),
        });
      }

      stores.push({
        name: store.name,
        keyPath: store.keyPath as string | string[] | null,
        autoIncrement: store.autoIncrement,
        indexes,
        records,
      });
    }

    return { type: "indexeddb", dbName: source.dbName, stores };
  } finally {
    db.close();
  }
}

async function readKvRecords(source: KvSource): Promise<{ key: string; value: string }[]> {
  // 读不到真实存储时必须失败，绝不静默退回内存缓存：KV 水合失败时缓存可能是
  // 空的/不完整的，退回缓存会生成一份「导出成功」但缺数据的备份——用户换设备
  // 导入后才发现历史没了。宁可备份报错，也不产出表面正常的残缺 ZIP。
  const byKey = new Map<string, { key: string; value: string }>();
  const db = await openDb("AiPhoneKvDB");
  if (!db) {
    throw new Error("本机数据库（AiPhoneKvDB）打不开，为避免生成不完整的备份已中止。请重启浏览器后重试。");
  }
  try {
    // 库刚建、还没有 entries 表 = 这台设备确实没写过 KV 数据，不算读取失败
    if (Array.from(db.objectStoreNames).includes("entries")) {
      const transaction = db.transaction("entries", "readonly");
      const request = transaction.objectStore("entries").openCursor();
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const record = cursor.value as { key: string; value: string };
          if (matchesKey(record.key, source)) byKey.set(record.key, record);
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
  } catch (error) {
    throw new Error(`本机数据读取失败，为避免生成不完整的备份已中止（${error instanceof Error ? error.message : String(error)}）。请重试。`);
  } finally {
    db.close();
  }

  // 内存缓存仍然要并进来：kvSet 是先写缓存再异步落盘，缓存可能比 IndexedDB 新
  for (const record of kvEntries()) {
    if (matchesKey(record.key, source)) byKey.set(record.key, record);
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

async function exportKvSource(source: KvSource, collector?: MediaCollector): Promise<KvSourceBackup> {
  const records = await readKvRecords(source);
  if (!collector) return { type: "kv", records };
  for (let index = 0; index < records.length; index += 1) {
    records[index] = { ...records[index], value: await serializeStorageString(records[index].value, collector) };
  }
  return { type: "kv", records };
}

async function exportLocalStorageSource(source: LocalStorageSource, collector?: MediaCollector): Promise<LocalStorageSourceBackup> {
  if (typeof window === "undefined") return { type: "localStorage", records: [] };
  const records: { key: string; value: string }[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !matchesKey(key, source)) continue;
    const value = window.localStorage.getItem(key);
    if (value !== null) records.push({ key, value: await serializeStorageString(value, collector) });
  }
  return { type: "localStorage", records };
}

export async function exportSource(source: DataSource, collector?: MediaCollector, excludeMedia = false): Promise<SourceBackup> {
  if (source.type === "indexeddb") return exportIndexedDbSource(source, collector, excludeMedia);
  if (source.type === "kv") return exportKvSource(source, collector);
  return exportLocalStorageSource(source, collector);
}

export async function inspectSource(source: DataSource): Promise<SourceStats> {
  if (source.type === "indexeddb") {
    const db = await openDb(source.dbName);
    if (!db) return { records: 0, bytes: 0, details: [] };

    try {
      const storeNames = getStoreNames(db, source);
      const details: SourceStats["details"] = [];
      let records = 0;
      let bytes = 0;

      for (const storeName of storeNames) {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.openCursor();
        let storeRecords = 0;
        let storeBytes = 0;

        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve();
              return;
            }
            storeRecords += 1;
            storeBytes += estimateValueBytes(cursor.primaryKey) + estimateValueBytes(cursor.value);
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });

        records += storeRecords;
        bytes += storeBytes;
        details?.push({
          id: `${source.dbName}/${storeName}`,
          label: `${source.label ?? source.dbName} / ${storeName}`,
          records: storeRecords,
          bytes: storeBytes,
        });
      }

      return { records, bytes, details };
    } finally {
      db.close();
    }
  }

  const payload = await exportSource(source) as KvSourceBackup | LocalStorageSourceBackup;
  let bytes = 0;
  for (const record of payload.records) {
    bytes += new Blob([record.key, record.value]).size;
  }
  return {
    records: payload.records.length,
    bytes,
    details: [{
      id: source.type === "kv" ? `kv/${source.label ?? "selected"}` : `localStorage/${source.label ?? "selected"}`,
      label: source.label ?? (source.type === "kv" ? "键值数据" : "localStorage"),
      records: payload.records.length,
      bytes,
    }],
  };
}

type StoreSpec = {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes?: StoreIndexBackup[];
};

// Recreate the indexes the backup declared (e.g. Dexie's bookId / compound indexes)
// on a store. Without them, indexed queries throw SchemaError after restoring into
// a browser where the owning app never created the schema itself.
function applySpecIndexes(store: IDBObjectStore, spec: StoreSpec): void {
  for (const idx of spec.indexes ?? []) {
    if (store.indexNames.contains(idx.name)) continue;
    try {
      store.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
    } catch {
      // An incompatible existing schema shouldn't abort the record restore.
    }
  }
}

// Create every needed object store for a DB in a SINGLE version bump. Bumping the
// version once per store (the old behaviour) pushed a freshly-restored DB far above
// the version the app opens it at (e.g. reading-db's 5 stores → v6 vs the app's v3),
// which then failed with "lower version than existing". One bump caps the gap at +1
// so the app's own open just upgrades over it.
async function ensureStores(dbName: string, specs: StoreSpec[]): Promise<IDBDatabase | null> {
  let db = await openDb(dbName);
  if (!db) return null;
  const existing = new Set(Array.from(db.objectStoreNames));
  const missing = specs.filter((s) => !existing.has(s.name));
  // Only repair the memory store when its indexes are actually missing.
  // Always bumping the DB version can be blocked by a live memory-page
  // connection, which makes restore skip the real memory records.
  let knownIndexRepairNeeded = false;
  if (dbName === MEMORY_DB_NAME && existing.has(MEMORY_STORE_NAME)) {
    try {
      const tx = db.transaction(MEMORY_STORE_NAME, "readonly");
      knownIndexRepairNeeded = getMissingKnownStoreIndexes(dbName, tx.objectStore(MEMORY_STORE_NAME)).length > 0;
    } catch {
      knownIndexRepairNeeded = true;
    }
  }

  // Existing stores that lack indexes the backup declares need an upgrade pass too
  // (repairs DBs left index-less by restores made before indexes were backed up).
  let indexRepairNeeded = false;
  const presentWithIndexes = specs.filter((s) => existing.has(s.name) && (s.indexes?.length ?? 0) > 0);
  if (presentWithIndexes.length > 0) {
    try {
      const tx = db.transaction(presentWithIndexes.map((s) => s.name), "readonly");
      indexRepairNeeded = presentWithIndexes.some((s) =>
        s.indexes!.some((idx) => !tx.objectStore(s.name).indexNames.contains(idx.name)));
    } catch {
      indexRepairNeeded = false;
    }
  }

  if (missing.length === 0 && !knownIndexRepairNeeded && !indexRepairNeeded) return db;

  const nextVersion = db.version + 1;
  db.close();
  db = await openDb(dbName, nextVersion, (upgradeDb, upgradeTx) => {
    for (const spec of specs) {
      let store: IDBObjectStore;
      if (!upgradeDb.objectStoreNames.contains(spec.name)) {
        store = spec.keyPath === null
          ? upgradeDb.createObjectStore(spec.name, { autoIncrement: spec.autoIncrement })
          : upgradeDb.createObjectStore(spec.name, { keyPath: spec.keyPath, autoIncrement: spec.autoIncrement });
      } else {
        if (!upgradeTx) continue;
        store = upgradeTx.objectStore(spec.name);
      }
      applySpecIndexes(store, spec);
      ensureKnownStoreIndexes(dbName, store);
    }
  }, { blockedGraceMs: 15_000 });
  // 升级被占用/失败时退回无版本打开：能写进已存在的 store 就写，缺失的 store
  // 由导入侧逐个上报。整库直接放弃（旧行为）= 用户看到「恢复完成」但整块数据没了。
  // 这个回退 open 会排在仍然 blocked 的升级请求后面，必须带总体超时。
  if (!db) db = await openDb(dbName, undefined, undefined, { deadlineMs: 3_000 });
  return db;
}

export async function importSource(
  payload: SourceBackup,
  overwrite = false,
  resolver?: MediaResolver,
  onProgress?: (done: number, total: number) => void,
): Promise<{ added: number; skipped: number; overwritten: number; errors: string[] }> {
  const result = { added: 0, skipped: 0, overwritten: 0, errors: [] as string[] };
  const totalRecords = payload.type === "indexeddb"
    ? payload.stores.reduce((sum, store) => sum + store.records.length, 0)
    : payload.records.length;
  let doneRecords = 0;
  const tick = () => {
    doneRecords += 1;
    onProgress?.(doneRecords, totalRecords);
  };

  if (payload.type === "localStorage") {
    for (const record of payload.records) {
      // 单条失败（配额满、单条数据损坏）只损失这一条，剩下的照常导入。
      try {
        const exists = window.localStorage.getItem(record.key) !== null;
        if (exists && !overwrite) {
          result.skipped += 1;
          continue;
        }
        const value = await deserializeStorageString(record.value, resolver);
        window.localStorage.setItem(record.key, value);
        if (exists) result.overwritten += 1;
        else result.added += 1;
      } catch (error) {
        result.errors.push(`localStorage.${record.key}: ${formatImportError(error)}`);
      } finally {
        tick();
      }
    }
    return result;
  }

  if (payload.type === "kv") {
    for (const record of payload.records) {
      // 逐条兜底：以前整个循环包在一个 try 里，第一条出错后剩余记录全部
      // 静默丢弃——正是「恢复内容不全」的来源之一。
      try {
        const incoming = await deserializeStorageString(record.value, resolver);
        const existing = kvGet(record.key);
        const exists = existing !== null;
        if (!exists) {
          await kvSetAsync(record.key, incoming);
          result.added += 1;
          continue;
        }
        if (overwrite) {
          await kvSetAsync(record.key, incoming);
          result.overwritten += 1;
          continue;
        }
        const merged = tryMergeJsonArrayByKey(existing, incoming)
          ?? tryReplaceEmptyJsonValue(existing, incoming);
        if (!merged) {
          result.skipped += 1;
          continue;
        }
        await kvSetAsync(record.key, merged);
        result.overwritten += 1;
      } catch (error) {
        result.errors.push(`kv.${record.key}: ${formatImportError(error)}`);
      } finally {
        tick();
      }
    }
    return result;
  }

  // Create every store the payload needs in ONE version bump, then write each.
  const db = await ensureStores(
    payload.dbName,
    payload.stores.map((s) => ({ name: s.name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: s.indexes })),
  );
  if (!db) {
    result.errors.push(`无法打开 ${payload.dbName}`);
    return result;
  }
  try {
    for (const storePayload of payload.stores) {
      if (!db.objectStoreNames.contains(storePayload.name)) {
        // 升级被其它连接挡住又等不到 → 该 store 建不出来。一次性上报清楚，
        // 而不是对每条记录抛一个 NotFoundError。
        result.errors.push(`${payload.dbName}.${storePayload.name}: 数据库被其它页面占用，无法创建该对象仓库，已跳过 ${storePayload.records.length} 条（请关闭其它标签页后重试）`);
        doneRecords += storePayload.records.length;
        onProgress?.(doneRecords, totalRecords);
        continue;
      }
      for (let recordIndex = 0; recordIndex < storePayload.records.length; recordIndex += 1) {
        let done: Promise<void> | null = null;
        try {
          const record = storePayload.records[recordIndex];
          const key = await deserializeValue(record.key);
          const value = await deserializeValue(record.value, resolver);
          const hasKey = key !== undefined && key !== null;
          const transaction = db.transaction(storePayload.name, "readwrite");
          done = transactionDone(transaction);
          const store = transaction.objectStore(storePayload.name);
          const existing = hasKey ? await runRequest(store.get(key as IDBValidKey)) : undefined;
          if (existing !== undefined && !overwrite) {
            await done;
            result.skipped += 1;
            continue;
          }
          if (store.keyPath === null && hasKey) {
            await runRequest(store.put(value, key as IDBValidKey));
          } else {
            await runRequest(store.put(value));
          }
          await done;
          if (existing !== undefined) result.overwritten += 1;
          else result.added += 1;
        } catch (error) {
          await done?.catch(() => undefined);
          result.errors.push(`${payload.dbName}.${storePayload.name}#${recordIndex + 1}: ${formatImportError(error)}`);
        } finally {
          tick();
        }
      }
    }
  } finally {
    db.close();
  }

  return result;
}

export async function clearSource(source: DataSource): Promise<ClearResult> {
  const result: ClearResult = { removed: 0, errors: [] };

  if (source.type === "localStorage") {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && matchesKey(key, source)) keys.push(key);
    }
    for (const key of keys) {
      window.localStorage.removeItem(key);
      result.removed += 1;
    }
    return result;
  }

  if (source.type === "kv") {
    const records = await readKvRecords(source);
    const db = await openDb("AiPhoneKvDB");
    if (!db || !Array.from(db.objectStoreNames).includes("entries")) return result;
    const removedKeys: string[] = [];
    try {
      const transaction = db.transaction("entries", "readwrite");
      const store = transaction.objectStore("entries");
      for (const record of records) {
        store.delete(record.key);
        removedKeys.push(record.key);
        result.removed += 1;
      }
      await transactionDone(transaction);
      for (const key of removedKeys) {
        kvRemove(key);
      }
    } catch (error) {
      result.errors.push(String(error));
    } finally {
      db.close();
    }
    return result;
  }

  const db = await openDb(source.dbName);
  if (!db) return result;
  try {
    const storeNames = getStoreNames(db, source);
    for (const storeName of storeNames) {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const count = await runRequest(store.count());
      store.clear();
      result.removed += count;
      await transactionDone(transaction);
    }
  } catch (error) {
    result.errors.push(String(error));
  } finally {
    db.close();
  }
  return result;
}
