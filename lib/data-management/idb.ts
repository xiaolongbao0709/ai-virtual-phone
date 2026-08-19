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

async function openDb(dbName: string, version?: number, upgrade?: (db: IDBDatabase, tx: IDBTransaction | null) => void): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return null;
  return new Promise((resolve) => {
    const request = version ? indexedDB.open(dbName, version) : indexedDB.open(dbName);
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
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
  const byKey = new Map<string, { key: string; value: string }>();
  const db = await openDb("AiPhoneKvDB");
  if (db && Array.from(db.objectStoreNames).includes("entries")) {
    try {
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
    } catch {
      // Fall back to cache-only below.
    } finally {
      db.close();
    }
  }

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
  });
  return db;
}

export async function importSource(payload: SourceBackup, overwrite = false, resolver?: MediaResolver): Promise<{ added: number; skipped: number; overwritten: number; errors: string[] }> {
  const result = { added: 0, skipped: 0, overwritten: 0, errors: [] as string[] };

  if (payload.type === "localStorage") {
    for (const record of payload.records) {
      const exists = window.localStorage.getItem(record.key) !== null;
      if (exists && !overwrite) {
        result.skipped += 1;
        continue;
      }
      const value = await deserializeStorageString(record.value, resolver);
      window.localStorage.setItem(record.key, value);
      if (exists) result.overwritten += 1;
      else result.added += 1;
    }
    return result;
  }

  if (payload.type === "kv") {
    try {
      for (const record of payload.records) {
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
      }
    } catch (error) {
      result.errors.push(String(error));
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
