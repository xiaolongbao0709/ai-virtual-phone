import { DATA_MODULES } from "./data-management/modules";
import type { DataModuleDefinition, IndexedDbSource, KvSource, LocalStorageSource } from "./data-management/types";

export type LocalDataListInput = {
    path?: string;
    limit?: number;
    offset?: number;
};

export type LocalDataReadInput = {
    path: string;
    limit?: number;
    offset?: number;
    fields?: string[];
    select?: string[];
};

export type LocalDataSearchInput = {
    path?: string;
    query: string;
    limit?: number;
    offset?: number;
    fields?: string[];
    select?: string[];
};

export type LocalDataRecordInput = {
    path: string;
    key: string;
    fields?: string[];
    select?: string[];
};

export type LocalDataFieldsInput = {
    path: string;
    sample?: number;
};

type DirectoryEntry = {
    name: string;
    path: string;
    kind: "directory" | "file" | "indexeddb-store" | "record";
    description?: string;
    records?: number;
    key?: string;
    preview?: string;
};

type SourcePath =
    | { kind: "root" }
    | { kind: "module"; module: DataModuleDefinition }
    | { kind: "sourceRoot"; module: DataModuleDefinition; sourceType: "indexeddb" | "kv" | "localStorage" }
    | { kind: "indexeddb"; module: DataModuleDefinition; source: IndexedDbSource; dbName: string }
    | { kind: "indexeddbStore"; module: DataModuleDefinition; source: IndexedDbSource; dbName: string; storeName: string }
    | { kind: "kvFile"; module: DataModuleDefinition; source: KvSource; key: string }
    | { kind: "localStorageFile"; module: DataModuleDefinition; source: LocalStorageSource; key: string };

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const MAX_SEARCH_SCAN = 3000;
const MAX_PREVIEW_LENGTH = 500;
const MAX_STRING_LENGTH = 4000;
const DEFAULT_FIELD_SAMPLE = 5;
const MAX_FIELD_SAMPLE = 50;

function normalizeLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(num)));
}

function normalizeOffset(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.floor(num));
}

function normalizeSample(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_FIELD_SAMPLE;
    return Math.max(1, Math.min(MAX_FIELD_SAMPLE, Math.floor(num)));
}

function normalizePath(path?: string): string {
    const raw = (path || "/").trim();
    const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
    return withSlash.length > 1 ? withSlash.replace(/\/+$/u, "") : "/";
}

function splitPath(path?: string): string[] {
    const normalized = normalizePath(path);
    if (normalized === "/") return [];
    return normalized.split("/").filter(Boolean).map(segment => {
        try { return decodeURIComponent(segment); } catch { return segment; }
    });
}

function encodeSegment(value: string): string {
    return encodeURIComponent(value);
}

function jsonFileName(key: string): string {
    return `${encodeSegment(key)}.json`;
}

function keyFromJsonFileName(fileName: string): string {
    return fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
}

function matchesKey(key: string, source: {
    keys?: string[];
    prefixes?: string[];
    includeAll?: boolean;
    excludeKeys?: string[];
    excludePrefixes?: string[];
}): boolean {
    if (source.excludeKeys?.includes(key)) return false;
    if (source.excludePrefixes?.some(prefix => key.startsWith(prefix))) return false;
    if (source.includeAll) return true;
    if (source.keys?.includes(key)) return true;
    return source.prefixes?.some(prefix => key.startsWith(prefix)) ?? false;
}

function hasIndexedDb(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function hasLocalStorage(): boolean {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

async function openDb(dbName: string): Promise<IDBDatabase | null> {
    if (!hasIndexedDb()) return null;
    return new Promise((resolve) => {
        const request = indexedDB.open(dbName);
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

function getModule(id: string): DataModuleDefinition | undefined {
    return DATA_MODULES.find(module => module.id === id);
}

function sourceGroups(module: DataModuleDefinition): Array<"indexeddb" | "kv" | "localStorage"> {
    const groups = new Set<"indexeddb" | "kv" | "localStorage">();
    for (const source of module.sources) groups.add(source.type);
    return Array.from(groups);
}

function parseSourcePath(path?: string): SourcePath | { kind: "missing"; message: string } {
    const segments = splitPath(path);
    if (segments.length === 0) return { kind: "root" };

    const module = getModule(segments[0]);
    if (!module) return { kind: "missing", message: `资料模块不存在：/${segments[0]}` };
    if (segments.length === 1) return { kind: "module", module };

    const sourceType = segments[1];
    if (sourceType !== "indexeddb" && sourceType !== "kv" && sourceType !== "localStorage") {
        return { kind: "missing", message: `资料源不存在：/${segments[0]}/${sourceType}` };
    }
    if (segments.length === 2) return { kind: "sourceRoot", module, sourceType };

    if (sourceType === "indexeddb") {
        const dbName = segments[2];
        const source = module.sources.find((item): item is IndexedDbSource =>
            item.type === "indexeddb" && item.dbName === dbName
        );
        if (!source) return { kind: "missing", message: `IndexedDB 不在该模块中：${dbName}` };
        if (segments.length === 3) return { kind: "indexeddb", module, source, dbName };
        return { kind: "indexeddbStore", module, source, dbName, storeName: segments[3] };
    }

    const fileName = segments[2];
    const key = keyFromJsonFileName(fileName);
    if (sourceType === "kv") {
        const source = module.sources.find((item): item is KvSource => item.type === "kv" && matchesKey(key, item));
        if (!source) return { kind: "missing", message: `KV 文件不在该模块中：${key}` };
        return { kind: "kvFile", module, source, key };
    }

    const source = module.sources.find((item): item is LocalStorageSource => item.type === "localStorage" && matchesKey(key, item));
    if (!source) return { kind: "missing", message: `localStorage 文件不在该模块中：${key}` };
    return { kind: "localStorageFile", module, source, key };
}

async function countStore(dbName: string, storeName: string): Promise<number> {
    const db = await openDb(dbName);
    if (!db || !Array.from(db.objectStoreNames).includes(storeName)) return 0;
    try {
        const transaction = db.transaction(storeName, "readonly");
        return await runRequest(transaction.objectStore(storeName).count());
    } catch {
        return 0;
    } finally {
        db.close();
    }
}

async function readKvRecords(source: KvSource): Promise<Array<{ key: string; value: string }>> {
    const db = await openDb("AiPhoneKvDB");
    if (!db || !Array.from(db.objectStoreNames).includes("entries")) return [];
    try {
        const transaction = db.transaction("entries", "readonly");
        const records = await runRequest<Array<{ key: string; value: string }>>(transaction.objectStore("entries").getAll());
        return records.filter(record => matchesKey(record.key, source));
    } catch {
        return [];
    } finally {
        db.close();
    }
}

function readLocalStorageRecords(source: LocalStorageSource): Array<{ key: string; value: string }> {
    if (!hasLocalStorage()) return [];
    const records: Array<{ key: string; value: string }> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key || !matchesKey(key, source)) continue;
        const value = window.localStorage.getItem(key);
        if (value !== null) records.push({ key, value });
    }
    return records;
}

function tryParseJson(value: string): unknown {
    try { return JSON.parse(value); } catch { return value; }
}

function isSensitiveKey(key: string): boolean {
    return /api[_-]?key|token|authorization|password|secret|cookie|bearer/i.test(key);
}

function sanitizeValue(value: unknown, keyHint = "", depth = 0): unknown {
    if (depth > 8) return "[max depth omitted]";
    if (value instanceof Blob) {
        return { type: "Blob", mimeType: value.type || "application/octet-stream", size: value.size };
    }
    if (typeof value === "string") {
        if (isSensitiveKey(keyHint) && value.trim()) return "***";
        if (/^data:(image|audio|video|application)\//i.test(value)) {
            const mime = value.slice(5, value.indexOf(";") > 0 ? value.indexOf(";") : Math.min(value.length, 80));
            return `[data URL omitted: ${mime || "unknown"}, ${value.length} chars]`;
        }
        if (value.length > MAX_STRING_LENGTH) return `${value.slice(0, MAX_STRING_LENGTH)}\n...(${value.length - MAX_STRING_LENGTH} chars truncated)`;
        return value;
    }
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map(item => sanitizeValue(item, keyHint, depth + 1));

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        output[key] = sanitizeValue(child, key, depth + 1);
    }
    return output;
}

function normalizeFields(input?: { fields?: string[]; select?: string[] }): string[] {
    const raw = [...(input?.fields || []), ...(input?.select || [])];
    const fields: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        if (!trimmed || fields.includes(trimmed)) continue;
        fields.push(trimmed);
    }
    return fields;
}

function getFieldValue(value: unknown, fieldPath: string): unknown {
    const parts = fieldPath.split(".").filter(Boolean);
    let current = value;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current)) {
            const index = Number(part);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
            current = current[index];
            continue;
        }
        if (typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

function setProjectedValue(target: Record<string, unknown>, fieldPath: string, value: unknown): void {
    const parts = fieldPath.split(".").filter(Boolean);
    if (parts.length === 0) return;
    let current: Record<string, unknown> = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        const existing = current[part];
        if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
            current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
}

function projectValue(value: unknown, fields: string[]): unknown {
    if (fields.length === 0) return sanitizeValue(value);
    if (Array.isArray(value)) return value.map(item => projectValue(item, fields));
    const target: Record<string, unknown> = {};
    for (const field of fields) {
        const selected = getFieldValue(value, field);
        if (selected !== undefined) setProjectedValue(target, field, sanitizeValue(selected, field));
    }
    return target;
}

function preview(value: unknown): string {
    let text: string;
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        text = String(value);
    }
    return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}...` : text;
}

function keyToText(key: IDBValidKey): string {
    if (key instanceof Date) return key.toISOString();
    if (Array.isArray(key)) return JSON.stringify(key);
    return String(key);
}

function parseRecordKey(key: string): IDBValidKey {
    try {
        const parsed = JSON.parse(key) as unknown;
        if (typeof parsed === "string" || typeof parsed === "number" || Array.isArray(parsed)) {
            return parsed as IDBValidKey;
        }
    } catch {
        // Plain string key.
    }
    return key;
}

function valueMatchesQuery(value: unknown, query: string): boolean {
    if (!query.trim()) return true;
    const lower = query.toLowerCase();
    try {
        return JSON.stringify(value).toLowerCase().includes(lower);
    } catch {
        return String(value).toLowerCase().includes(lower);
    }
}

function fieldValueType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (value instanceof Blob) return "blob";
    return typeof value;
}

function collectFieldStats(
    value: unknown,
    stats: Map<string, { types: Set<string>; count: number; preview?: string }>,
    prefix = "",
    depth = 0,
): void {
    if (depth > 4 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 3)) {
            collectFieldStats(item, stats, prefix, depth + 1);
        }
        return;
    }
    if (typeof value !== "object" || value instanceof Blob) return;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const sanitized = sanitizeValue(child, key);
        const existing = stats.get(path) || { types: new Set<string>(), count: 0, preview: undefined };
        existing.types.add(fieldValueType(child));
        existing.count += 1;
        if (existing.preview === undefined) existing.preview = preview(sanitized);
        stats.set(path, existing);
        if (typeof child === "object" && child !== null && !Array.isArray(child) && !(child instanceof Blob)) {
            collectFieldStats(child, stats, path, depth + 1);
        }
    }
}

function formatFieldStats(
    path: string,
    sampleCount: number,
    stats: Map<string, { types: Set<string>; count: number; preview?: string }>,
) {
    return {
        path: normalizePath(path),
        sampleCount,
        fields: Array.from(stats.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, info]) => ({
                name,
                types: Array.from(info.types),
                count: info.count,
                preview: info.preview,
            })),
    };
}

async function readIndexedDbSample(path: Extract<SourcePath, { kind: "indexeddbStore" }>, sample: number): Promise<unknown[]> {
    const db = await openDb(path.dbName);
    if (!db) throw new Error(`无法打开 IndexedDB：${path.dbName}`);
    if (!Array.from(db.objectStoreNames).includes(path.storeName)) {
        db.close();
        throw new Error(`对象仓库不存在：${path.storeName}`);
    }
    try {
        const transaction = db.transaction(path.storeName, "readonly");
        const store = transaction.objectStore(path.storeName);
        const values: unknown[] = [];
        const request = store.openCursor();
        await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || values.length >= sample) {
                    resolve();
                    return;
                }
                values.push(cursor.value);
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
        return values;
    } finally {
        db.close();
    }
}

async function readIndexedDbStore(path: Extract<SourcePath, { kind: "indexeddbStore" }>, input: LocalDataReadInput) {
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);
    const fields = normalizeFields(input);
    const db = await openDb(path.dbName);
    if (!db) throw new Error(`无法打开 IndexedDB：${path.dbName}`);
    if (!Array.from(db.objectStoreNames).includes(path.storeName)) {
        db.close();
        throw new Error(`对象仓库不存在：${path.storeName}`);
    }

    try {
        const transaction = db.transaction(path.storeName, "readonly");
        const store = transaction.objectStore(path.storeName);
        const records: Array<{ key: string; value: unknown }> = [];
        let skipped = 0;
        const request = store.openCursor();
        await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || records.length >= limit) {
                    resolve();
                    return;
                }
                if (skipped < offset) {
                    skipped += 1;
                    cursor.continue();
                    return;
                }
                records.push({
                    key: keyToText(cursor.primaryKey),
                    value: projectValue(cursor.value, fields),
                });
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
        return {
            path: normalizePath(input.path),
            type: "indexeddb-store",
            dbName: path.dbName,
            storeName: path.storeName,
            offset,
            limit,
            fields: fields.length > 0 ? fields : undefined,
            records,
            nextOffset: records.length === limit ? offset + records.length : null,
        };
    } finally {
        db.close();
    }
}

function paginateArray(items: unknown[], limit: number, offset: number, fields: string[]): { value: unknown[]; nextOffset: number | null; total: number } {
    const sliced = items.slice(offset, offset + limit);
    return {
        value: sliced.map(item => projectValue(item, fields)),
        nextOffset: offset + sliced.length < items.length ? offset + sliced.length : null,
        total: items.length,
    };
}

async function readKeyValueFile(kind: "kv" | "localStorage", key: string, raw: string | null, input: LocalDataReadInput) {
    if (raw === null) throw new Error(`${kind} 文件不存在：${key}`);
    const parsed = tryParseJson(raw);
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);
    const fields = normalizeFields(input);
    if (Array.isArray(parsed)) {
        const paged = paginateArray(parsed, limit, offset, fields);
        return {
            path: normalizePath(input.path),
            type: kind,
            key,
            offset,
            limit,
            fields: fields.length > 0 ? fields : undefined,
            total: paged.total,
            value: paged.value,
            nextOffset: paged.nextOffset,
        };
    }
    return {
        path: normalizePath(input.path),
        type: kind,
        key,
        fields: fields.length > 0 ? fields : undefined,
        value: projectValue(parsed, fields),
    };
}

async function searchIndexedDbStore(path: Extract<SourcePath, { kind: "indexeddbStore" }>, input: LocalDataSearchInput) {
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);
    const fields = normalizeFields(input);
    const db = await openDb(path.dbName);
    if (!db) return [];
    if (!Array.from(db.objectStoreNames).includes(path.storeName)) {
        db.close();
        return [];
    }

    try {
        const transaction = db.transaction(path.storeName, "readonly");
        const store = transaction.objectStore(path.storeName);
        const records: Array<{ source: string; path: string; key: string; preview: string; value: unknown }> = [];
        let matchedBeforeOffset = 0;
        let scanned = 0;
        const request = store.openCursor();
        await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || records.length >= limit || scanned >= MAX_SEARCH_SCAN) {
                    resolve();
                    return;
                }
                scanned += 1;
                const sanitized = sanitizeValue(cursor.value);
                if (valueMatchesQuery(sanitized, input.query)) {
                    if (matchedBeforeOffset < offset) {
                        matchedBeforeOffset += 1;
                    } else {
                        records.push({
                            source: `${path.dbName}.${path.storeName}`,
                            path: normalizePath(input.path),
                            key: keyToText(cursor.primaryKey),
                            preview: preview(sanitized),
                            value: projectValue(cursor.value, fields),
                        });
                    }
                }
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
        return records;
    } finally {
        db.close();
    }
}

function searchKeyValueRecord(
    sourceLabel: string,
    basePath: string,
    key: string,
    raw: string,
    query: string,
    limit: number,
    fields: string[],
): Array<{ source: string; path: string; key: string; index?: number; preview: string; value: unknown }> {
    const parsed = tryParseJson(raw);
    const results: Array<{ source: string; path: string; key: string; index?: number; preview: string; value: unknown }> = [];
    if (Array.isArray(parsed)) {
        for (let index = 0; index < parsed.length && results.length < limit; index += 1) {
            const sanitized = sanitizeValue(parsed[index]);
            if (!valueMatchesQuery(sanitized, query)) continue;
            results.push({
                source: sourceLabel,
                path: `${basePath}/${jsonFileName(key)}`,
                key,
                index,
                preview: preview(sanitized),
                value: projectValue(parsed[index], fields),
            });
        }
        return results;
    }

    const sanitized = sanitizeValue(parsed, key);
    if (valueMatchesQuery(sanitized, query)) {
        results.push({
            source: sourceLabel,
            path: `${basePath}/${jsonFileName(key)}`,
            key,
            preview: preview(sanitized),
            value: projectValue(parsed, fields),
        });
    }
    return results;
}

async function listIndexedDbStores(module: DataModuleDefinition, source: IndexedDbSource): Promise<DirectoryEntry> {
    const db = await openDb(source.dbName);
    let records = 0;
    if (db) {
        try {
            for (const storeName of Array.from(db.objectStoreNames)) {
                records += await countStore(source.dbName, storeName);
            }
        } finally {
            db.close();
        }
    }
    return {
        name: source.dbName,
        path: `/${module.id}/indexeddb/${encodeSegment(source.dbName)}`,
        kind: "directory",
        records,
    };
}

export async function listLocalDataDirectory(input: LocalDataListInput = {}): Promise<unknown> {
    const path = parseSourcePath(input.path);
    if (path.kind === "missing") throw new Error(path.message);

    if (path.kind === "root") {
        return {
            path: "/",
            entries: DATA_MODULES.map(module => ({
                name: module.id,
                path: `/${module.id}`,
                kind: "directory" as const,
                description: `${module.label}：${module.description}`,
            })),
        };
    }

    if (path.kind === "module") {
        return {
            path: `/${path.module.id}`,
            module: path.module.label,
            entries: sourceGroups(path.module).map(group => ({
                name: group,
                path: `/${path.module.id}/${group}`,
                kind: "directory" as const,
            })),
        };
    }

    if (path.kind === "sourceRoot") {
        if (path.sourceType === "indexeddb") {
            const sources = path.module.sources.filter((source): source is IndexedDbSource => source.type === "indexeddb");
            return {
                path: normalizePath(input.path),
                entries: await Promise.all(sources.map(source => listIndexedDbStores(path.module, source))),
            };
        }
        if (path.sourceType === "kv") {
            const records = (await Promise.all(path.module.sources
                .filter((source): source is KvSource => source.type === "kv")
                .map(readKvRecords))).flat();
            return {
                path: normalizePath(input.path),
                entries: records.map(record => ({
                    name: `${record.key}.json`,
                    path: `/${path.module.id}/kv/${jsonFileName(record.key)}`,
                    kind: "file" as const,
                    preview: preview(sanitizeValue(tryParseJson(record.value), record.key)),
                })),
            };
        }
        const records = path.module.sources
            .filter((source): source is LocalStorageSource => source.type === "localStorage")
            .flatMap(readLocalStorageRecords);
        return {
            path: normalizePath(input.path),
            entries: records.map(record => ({
                name: `${record.key}.json`,
                path: `/${path.module.id}/localStorage/${jsonFileName(record.key)}`,
                kind: "file" as const,
                preview: preview(sanitizeValue(tryParseJson(record.value), record.key)),
            })),
        };
    }

    if (path.kind === "indexeddb") {
        const db = await openDb(path.dbName);
        if (!db) throw new Error(`无法打开 IndexedDB：${path.dbName}`);
        try {
            const sourceStores = path.source.stores;
            const storeNames = Array.from(db.objectStoreNames)
                .filter(storeName => !sourceStores || sourceStores.includes(storeName));
            const entries: DirectoryEntry[] = [];
            for (const storeName of storeNames) {
                entries.push({
                    name: storeName,
                    path: `/${path.module.id}/indexeddb/${encodeSegment(path.dbName)}/${encodeSegment(storeName)}`,
                    kind: "indexeddb-store",
                    records: await countStore(path.dbName, storeName),
                });
            }
            return { path: normalizePath(input.path), entries };
        } finally {
            db.close();
        }
    }

    if (path.kind === "indexeddbStore") {
        const read = await readIndexedDbStore(path, {
            path: normalizePath(input.path),
            limit: input.limit ?? DEFAULT_LIMIT,
            offset: input.offset ?? 0,
        });
        return {
            path: normalizePath(input.path),
            type: "indexeddb-store",
            entries: read.records.map(record => ({
                name: record.key,
                path: normalizePath(input.path),
                kind: "record" as const,
                key: record.key,
                preview: preview(record.value),
            })),
            nextOffset: read.nextOffset,
        };
    }

    return readLocalDataFile({ path: normalizePath(input.path), limit: input.limit, offset: input.offset });
}

export async function readLocalDataFile(input: LocalDataReadInput): Promise<unknown> {
    const path = parseSourcePath(input.path);
    if (path.kind === "missing") throw new Error(path.message);
    if (path.kind === "indexeddbStore") return readIndexedDbStore(path, input);
    if (path.kind === "kvFile") {
        const records = await readKvRecords(path.source);
        const record = records.find(item => item.key === path.key);
        return readKeyValueFile("kv", path.key, record?.value ?? null, input);
    }
    if (path.kind === "localStorageFile") {
        const raw = hasLocalStorage() ? window.localStorage.getItem(path.key) : null;
        return readKeyValueFile("localStorage", path.key, raw, input);
    }
    return listLocalDataDirectory({ path: input.path, limit: input.limit, offset: input.offset });
}

export async function readLocalDataRecord(input: LocalDataRecordInput): Promise<unknown> {
    const path = parseSourcePath(input.path);
    if (path.kind === "missing") throw new Error(path.message);
    if (path.kind !== "indexeddbStore") {
        throw new Error("读取单条记录只支持 IndexedDB store 路径；KV/localStorage 请用读取资料文件。");
    }
    const db = await openDb(path.dbName);
    if (!db) throw new Error(`无法打开 IndexedDB：${path.dbName}`);
    if (!Array.from(db.objectStoreNames).includes(path.storeName)) {
        db.close();
        throw new Error(`对象仓库不存在：${path.storeName}`);
    }
    const fields = normalizeFields(input);
    try {
        const transaction = db.transaction(path.storeName, "readonly");
        const value = await runRequest(transaction.objectStore(path.storeName).get(parseRecordKey(input.key)));
        if (value === undefined) throw new Error(`记录不存在：${input.key}`);
        return {
            path: normalizePath(input.path),
            key: input.key,
            fields: fields.length > 0 ? fields : undefined,
            value: projectValue(value, fields),
        };
    } finally {
        db.close();
    }
}

export async function inspectLocalDataFields(input: LocalDataFieldsInput): Promise<unknown> {
    const path = parseSourcePath(input.path);
    if (path.kind === "missing") throw new Error(path.message);
    const sample = normalizeSample(input.sample);
    const stats = new Map<string, { types: Set<string>; count: number; preview?: string }>();
    let sampleValues: unknown[] = [];

    if (path.kind === "indexeddbStore") {
        sampleValues = await readIndexedDbSample(path, sample);
    } else if (path.kind === "kvFile") {
        const records = await readKvRecords(path.source);
        const record = records.find(item => item.key === path.key);
        if (!record) throw new Error(`KV 文件不存在：${path.key}`);
        const parsed = tryParseJson(record.value);
        sampleValues = Array.isArray(parsed) ? parsed.slice(0, sample) : [parsed];
    } else if (path.kind === "localStorageFile") {
        const raw = hasLocalStorage() ? window.localStorage.getItem(path.key) : null;
        if (raw === null) throw new Error(`localStorage 文件不存在：${path.key}`);
        const parsed = tryParseJson(raw);
        sampleValues = Array.isArray(parsed) ? parsed.slice(0, sample) : [parsed];
    } else {
        throw new Error("查看资料字段需要指定 KV/localStorage JSON 文件或 IndexedDB store 路径。");
    }

    for (const value of sampleValues) collectFieldStats(value, stats);
    return formatFieldStats(input.path, sampleValues.length, stats);
}

async function searchPath(path: SourcePath, input: LocalDataSearchInput, remaining: number) {
    if (remaining <= 0) return [];
    const fields = normalizeFields(input);
    if (path.kind === "indexeddbStore") return searchIndexedDbStore(path, { ...input, limit: remaining, offset: 0 });
    if (path.kind === "kvFile") {
        const records = await readKvRecords(path.source);
        const record = records.find(item => item.key === path.key);
        return record ? searchKeyValueRecord("kv", `/${path.module.id}/kv`, record.key, record.value, input.query, remaining, fields) : [];
    }
    if (path.kind === "localStorageFile") {
        const raw = hasLocalStorage() ? window.localStorage.getItem(path.key) : null;
        return raw ? searchKeyValueRecord("localStorage", `/${path.module.id}/localStorage`, path.key, raw, input.query, remaining, fields) : [];
    }

    const modules = path.kind === "root"
        ? DATA_MODULES
        : path.kind === "module" || path.kind === "sourceRoot" || path.kind === "indexeddb"
            ? [path.module]
            : [];
    const results: unknown[] = [];

    for (const module of modules) {
        const sources = path.kind === "indexeddb"
            ? [path.source]
            : module.sources.filter(source => {
                if (path.kind !== "sourceRoot") return true;
                return source.type === path.sourceType;
            });
        for (const source of sources) {
            if (results.length >= remaining) break;
            if (source.type === "kv") {
                const records = await readKvRecords(source);
                for (const record of records) {
                    if (results.length >= remaining) break;
                    results.push(...searchKeyValueRecord("kv", `/${module.id}/kv`, record.key, record.value, input.query, remaining - results.length, fields));
                }
            } else if (source.type === "localStorage") {
                for (const record of readLocalStorageRecords(source)) {
                    if (results.length >= remaining) break;
                    results.push(...searchKeyValueRecord("localStorage", `/${module.id}/localStorage`, record.key, record.value, input.query, remaining - results.length, fields));
                }
            } else if (source.type === "indexeddb") {
                const db = await openDb(source.dbName);
                if (!db) continue;
                try {
                    const storeNames = Array.from(db.objectStoreNames)
                        .filter(storeName => !source.stores || source.stores.includes(storeName));
                    for (const storeName of storeNames) {
                        if (results.length >= remaining) break;
                        const storePath: Extract<SourcePath, { kind: "indexeddbStore" }> = {
                            kind: "indexeddbStore",
                            module,
                            source,
                            dbName: source.dbName,
                            storeName,
                        };
                        const found = await searchIndexedDbStore(storePath, {
                            ...input,
                            path: `/${module.id}/indexeddb/${encodeSegment(source.dbName)}/${encodeSegment(storeName)}`,
                            limit: remaining - results.length,
                            offset: 0,
                        });
                        results.push(...found);
                    }
                } finally {
                    db.close();
                }
            }
        }
    }
    return results;
}

export async function searchLocalDataRecords(input: LocalDataSearchInput): Promise<unknown> {
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);
    const path = parseSourcePath(input.path);
    if (path.kind === "missing") throw new Error(path.message);
    const results = await searchPath(path, { ...input, limit: limit + offset }, limit + offset);
    return {
        path: normalizePath(input.path),
        query: input.query,
        offset,
        limit,
        results: results.slice(offset, offset + limit),
        nextOffset: offset + limit < results.length ? offset + limit : null,
    };
}
