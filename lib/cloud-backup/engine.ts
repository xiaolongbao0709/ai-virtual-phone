import { buildSingleSourcePayload, getBackupModules } from "../data-management/backup";
import { importSource } from "../data-management/idb";
import { createMediaCollector, utf8Bytes, type MediaResolver } from "../data-management/serializers";
import type { DataModuleId, ModulePayload } from "../data-management/types";
import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { sha256BlobHex, sha256TextHex } from "../sha256-stream";
import type { CloudBackupConfig } from "./config";
import { ensureBucket, getObject, listObjects, putObject, removeObject } from "./storage-client";

/**
 * Source-level incremental cloud backup.
 *
 * Layout in the ai-phone-backup bucket:
 *   modules/<moduleId>/<sha256>.json.gz   — one module's payload, keyed by content
 *                                            hash → unchanged modules are never re-uploaded
 *   media/<sha256>.bin or media/<sha256>.<part>.bin
 *                                          — extracted media blobs, chunked when large
 *   manifests/<ts>.json                    — points at the object for each module (commit point)
 *   manifests/quarantine-<ts>.json         — a backup flagged as a size/record anomaly
 *
 * Safety: if a new backup is much smaller / has far fewer records than the last
 * healthy one, it is written as a quarantine manifest and the healthy manifests
 * are NOT rotated out — the previous good backups are always preserved.
 */

const STATE_KEY = "ai_phone_cloud_backup_state_v1";
registerKvMigration(STATE_KEY);

// A backup is "anomalous" if it shrank past these vs the last healthy backup.
const ANOMALY_BYTES_RATIO = 0.5;
const ANOMALY_RECORDS_RATIO = 0.5;

// Stay under Supabase Storage's per-file upload limit (free tier ~50MB). A module
// whose gzipped payload exceeds this is split into several part objects.
const MAX_OBJECT_BYTES = 40 * 1024 * 1024;
// An object uploaded by another tab/device may not have a manifest yet. Never
// garbage-collect recent unreferenced objects; this closes the upload→manifest
// race without requiring a distributed lock service in the user's project.
const GC_GRACE_MS = 24 * 60 * 60 * 1000;

function sliceBlob(blob: Blob, max: number): Blob[] {
  if (blob.size <= max) return [blob];
  const parts: Blob[] = [];
  for (let offset = 0; offset < blob.size; offset += max) {
    parts.push(blob.slice(offset, offset + max));
  }
  return parts;
}

export type CloudBackupManifestMedia = {
  ref: string;
  bytes: number;
  parts: string[]; // object path(s) inside the bucket (chunked if the media is large)
};

export type CloudBackupManifestModule = {
  id: DataModuleId;
  label: string;
  records: number;
  bytes: number;
  hash: string;
  parts: string[]; // object path(s) inside the bucket (chunked if the module is large)
  mediaRefs?: string[]; // content hashes of this module's media objects
  /** v2: independently restorable source payloads; v1 used module-level parts. */
  sources?: CloudBackupManifestSource[];
};

export type CloudBackupManifestSource = {
  index: number;
  label: string;
  records: number;
  bytes: number;
  hash: string;
  parts: string[];
  mediaRefs?: string[];
};

export type CloudBackupManifest = {
  format: "ai-phone-cloud-backup";
  version: 1 | 2;
  createdAt: string;
  origin: string;
  totalBytes: number;
  totalRecords: number;
  combinedHash: string; // hash of all module hashes → cheap change detection
  anomaly?: boolean;
  modules: CloudBackupManifestModule[];
  media?: CloudBackupManifestMedia[];
};

export type CloudBackupState = {
  lastManifestName?: string;
  lastCreatedAt?: string;
  lastTotalBytes?: number;
  lastTotalRecords?: number;
  lastCombinedHash?: string;
  // baseline for anomaly detection: the most recent HEALTHY backup
  healthyBytes?: number;
  healthyRecords?: number;
  lastError?: string;
  lastResult?: "ok" | "skipped" | "anomaly" | "error";
};

export type CloudBackupRunResult = {
  status: "ok" | "skipped" | "anomaly";
  uploadedModules: number;
  totalBytes: number;
  totalRecords: number;
  manifestName: string;
};

export function loadCloudBackupState(): CloudBackupState {
  try {
    const raw = kvGet(STATE_KEY);
    return raw ? (JSON.parse(raw) as CloudBackupState) : {};
  } catch {
    return {};
  }
}

function saveCloudBackupState(state: CloudBackupState): void {
  kvSet(STATE_KEY, JSON.stringify(state));
}

// ── crypto / compression helpers (native, no deps) ──

async function gzipBlob(blob: Blob): Promise<Blob> {
  if (typeof CompressionStream === "undefined") return blob;
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

async function gunzipBlob(blob: Blob): Promise<string> {
  if (typeof DecompressionStream === "undefined") return await blob.text();
  try {
    const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  } catch {
    // Stored uncompressed on a browser without CompressionStream.
    return await blob.text();
  }
}

function legacyMediaPath(ref: string): string {
  return `media/${ref}.bin`;
}

function mediaPartPath(ref: string, index: number): string {
  return `media/${ref}.${index}.bin`;
}

async function listExistingMedia(config: CloudBackupConfig, healthy?: CloudBackupManifest | null): Promise<Map<string, string[]>> {
  const existing = new Map<string, string[]>();
  const addParts = (ref: string, parts: string[]) => {
    if (!ref || parts.length === 0 || existing.has(ref)) return;
    existing.set(ref, parts);
  };

  for (const item of healthy?.media ?? []) {
    addParts(item.ref, item.parts ?? []);
  }
  for (const mod of healthy?.modules ?? []) {
    for (const ref of mod.mediaRefs ?? []) {
      if (!existing.has(ref)) addParts(ref, [legacyMediaPath(ref)]);
    }
  }

  const listed = await listObjects(config, "media/", 2000).catch(() => []);
  for (const object of listed) {
    const name = object.name;
    const legacy = /^([a-f0-9]{64})\.bin$/i.exec(name);
    if (legacy) {
      addParts(legacy[1], [`media/${name}`]);
    }
  }
  // Never infer a complete chunked upload from an uncommitted directory
  // listing: a failed prior run may have uploaded only the first N chunks. Only
  // a healthy manifest can prove the complete ordered part list. Single .bin
  // objects are atomic and safe to reuse from the listing above.
  return existing;
}

async function uploadMediaObject(
  config: CloudBackupConfig,
  ref: string,
  blob: Blob,
  onChunk?: (index: number, total: number) => void,
): Promise<string[]> {
  const slices = sliceBlob(blob, MAX_OBJECT_BYTES);
  const paths: string[] = [];
  for (let index = 0; index < slices.length; index += 1) {
    onChunk?.(index, slices.length);
    const path = slices.length === 1 ? legacyMediaPath(ref) : mediaPartPath(ref, index);
    await putObject(config, path, slices[index], "application/octet-stream");
    paths.push(path);
  }
  return paths;
}

// ── manifest listing ──

function manifestNameToCreatedAt(name: string): string {
  return name.replace(/^manifests\//, "").replace(/^quarantine-/, "").replace(/\.json$/, "");
}

export async function listCloudManifests(config: CloudBackupConfig): Promise<{ name: string; quarantine: boolean }[]> {
  const objects = await listObjects(config, "manifests/", 200);
  return objects
    .map((o) => ({ name: `manifests/${o.name}`, quarantine: o.name.startsWith("quarantine-") }))
    .filter((m) => m.name.endsWith(".json"))
    .sort((a, b) => manifestNameToCreatedAt(b.name).localeCompare(manifestNameToCreatedAt(a.name)));
}

export type CloudBackupListItem = {
  name: string;
  createdAt: string;
  totalBytes: number;
  totalRecords: number;
  quarantine: boolean;
  /** Present when the manifest was listed but cannot be read or validated. */
  error?: string;
};

function manifestNameToIso(name: string): string {
  const stamp = manifestNameToCreatedAt(name);
  const match = /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/.exec(stamp);
  return match ? `${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}` : new Date(0).toISOString();
}

/** List backups with metadata for the restore UI (newest first). */
export async function listCloudBackups(config: CloudBackupConfig): Promise<CloudBackupListItem[]> {
  const manifests = await listCloudManifests(config);
  const items: CloudBackupListItem[] = [];
  for (const m of manifests) {
    try {
      const manifest = await loadManifest(config, m.name);
      if (!manifest) throw new Error("清单对象不存在");
      items.push({
        name: m.name,
        createdAt: manifest.createdAt,
        totalBytes: manifest.totalBytes,
        totalRecords: manifest.totalRecords,
        quarantine: m.quarantine || Boolean(manifest.anomaly),
      });
    } catch (error) {
      items.push({
        name: m.name,
        createdAt: manifestNameToIso(m.name),
        totalBytes: 0,
        totalRecords: 0,
        quarantine: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return items;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isObjectPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((path) => typeof path === "string" && path.length > 0);
}

function isRestorablePayload(value: unknown, moduleId: DataModuleId): value is ModulePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ModulePayload>;
  if (payload.moduleId !== moduleId || !Array.isArray(payload.sources) || payload.sources.length === 0) return false;
  return payload.sources.every((source) => {
    if (!source || typeof source !== "object") return false;
    if (source.type === "kv" || source.type === "localStorage") return Array.isArray(source.records);
    return source.type === "indexeddb" && typeof source.dbName === "string" && Array.isArray(source.stores);
  });
}

function validateManifest(manifest: Partial<CloudBackupManifest>): manifest is CloudBackupManifest {
  if (
    manifest.format !== "ai-phone-cloud-backup"
    || (manifest.version !== 1 && manifest.version !== 2)
    || typeof manifest.createdAt !== "string"
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || !isFiniteNonNegative(manifest.totalBytes)
    || !isFiniteNonNegative(manifest.totalRecords)
    || typeof manifest.combinedHash !== "string"
    || !Array.isArray(manifest.modules)
  ) return false;

  return manifest.modules.every((mod) => {
    if (
      !mod || typeof mod !== "object"
      || typeof mod.id !== "string"
      || typeof mod.label !== "string"
      || !isFiniteNonNegative(mod.records)
      || !isFiniteNonNegative(mod.bytes)
      || typeof mod.hash !== "string"
      || !isObjectPathList(mod.parts)
    ) return false;
    if (manifest.version === 1) return mod.parts.length > 0;
    return Array.isArray(mod.sources) && mod.sources.length > 0 && mod.sources.every((source) => (
      source
      && typeof source === "object"
      && Number.isInteger(source.index)
      && source.index >= 0
      && typeof source.label === "string"
      && isFiniteNonNegative(source.records)
      && isFiniteNonNegative(source.bytes)
      && typeof source.hash === "string"
      && isObjectPathList(source.parts)
      && source.parts.length > 0
    ));
  });
}

async function loadManifest(config: CloudBackupConfig, name: string): Promise<CloudBackupManifest | null> {
  const blob = await getObject(config, name);
  if (!blob) return null;
  try {
    const manifest = JSON.parse(await blob.text()) as Partial<CloudBackupManifest>;
    if (!validateManifest(manifest)) {
      throw new Error("字段不完整或版本不受支持");
    }
    return manifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`云端备份清单 ${name} 已损坏：${detail}`);
  }
}

async function latestHealthyManifest(config: CloudBackupConfig): Promise<CloudBackupManifest | null> {
  const list = await listCloudManifests(config);
  for (const item of list) {
    if (item.quarantine) continue;
    const manifest = await loadManifest(config, item.name).catch(() => null);
    if (manifest && !manifest.anomaly) return manifest;
  }
  return null;
}

// ── the backup run ──

/** Progress callback payload for cloud backup/restore (percent is 0-100). */
export type CloudProgress = { percent: number; detail: string };

export type CloudBackupOptions = {
  moduleIds?: DataModuleId[];
  force?: boolean;
  excludeMedia?: boolean;
  onProgress?: (p: CloudProgress) => void;
};

let cloudOperationRunning: "backup" | "restore" | null = null;

async function withCloudOperationLock<T>(kind: "backup" | "restore", task: () => Promise<T>): Promise<T> {
  if (cloudOperationRunning) throw new Error("已有云端备份或恢复正在运行，请等待它完成。");
  cloudOperationRunning = kind;
  try {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return await task();
    return await locks.request(
      "ai-phone-cloud-backup-v1",
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error("另一个页面正在进行云端备份或恢复，请稍后再试。");
        return task();
      },
    );
  } finally {
    cloudOperationRunning = null;
  }
}

/** One lock covers manual + scheduled runs in this realm and navigator.locks
 * extends it across tabs on the same origin. Cross-device safety is provided by
 * the GC grace period below. */
export async function runCloudBackup(
  config: CloudBackupConfig,
  options: CloudBackupOptions = {},
): Promise<CloudBackupRunResult> {
  try {
    return await withCloudOperationLock("backup", () => runCloudBackupInternal(config, options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = loadCloudBackupState();
    saveCloudBackupState({ ...state, lastResult: "error", lastError: message });
    throw error;
  }
}

async function runCloudBackupInternal(
  config: CloudBackupConfig,
  options: CloudBackupOptions,
): Promise<CloudBackupRunResult> {
  const onProgress = options.onProgress ?? (() => {});
  await ensureBucket(config);

  // Streaming build: handle ONE module at a time (read → stringify → hash →
  // compress → upload → release). Holding every module's objects + JSON strings
  // at once (the old approach) doubled/tripled the library size in memory and
  // got the page killed/reloaded by mobile WebKit on large (200MB+) libraries.
  const modules = getBackupModules(options.moduleIds);
  const state = loadCloudBackupState();

  // Last HEALTHY backup (cloud truth first): reuse its module parts + anomaly baseline.
  const healthy = await latestHealthyManifest(config).catch(() => null);
  const existing = new Map<string, string[]>();
  for (const mod of healthy?.modules ?? []) {
    if (mod.parts?.length) existing.set(`${mod.id}|${mod.hash}`, mod.parts);
    for (const source of mod.sources ?? []) {
      if (source.parts?.length) existing.set(`${mod.id}|${source.hash}`, source.parts);
    }
  }

  const uploadedModuleIds = new Set<DataModuleId>();
  let totalBytes = 0;
  let totalRecords = 0;
  const moduleHashes: string[] = [];
  const manifestModules: CloudBackupManifestModule[] = [];
  const manifestMedia = new Map<string, CloudBackupManifestMedia>();

  // Media is content-addressed and shared across modules/backups.
  // List what's already uploaded once so unchanged media is never re-sent.
  const existingMedia = await listExistingMedia(config, healthy);

  const totalSources = Math.max(1, modules.reduce((sum, module) => sum + module.sources.length, 0));
  let completedSources = 0;
  for (let i = 0; i < modules.length; i += 1) {
    const dataModule = modules[i];
    const label = dataModule.label;
    const sourceManifests: CloudBackupManifestSource[] = [];
    const moduleMediaRefs = new Set<string>();
    const sourceHashes: string[] = [];
    let moduleBytes = 0;
    let moduleRecords = 0;

    for (let sourceIndex = 0; sourceIndex < dataModule.sources.length; sourceIndex += 1) {
      const sourceLabel = dataModule.sources[sourceIndex].label ?? `数据源 ${sourceIndex + 1}`;
      const spanStart = 2 + (completedSources / totalSources) * 90;
      const span = 90 / totalSources;
      onProgress({ percent: spanStart, detail: `读取 ${label} · ${sourceLabel}…` });

      const collector = createMediaCollector();
      const built = await buildSingleSourcePayload(dataModule, sourceIndex, { excludeMedia: options.excludeMedia }, collector);
      if (built.warnings.length > 0) throw new Error(built.warnings.join("；"));
      let json: string | null = JSON.stringify(built.payload);
      built.payload = null as unknown as typeof built.payload;
      const hash = await sha256TextHex(json);
      const mediaBytes = Array.from(collector.media.values()).reduce((sum, blob) => sum + blob.size, 0);
      const bytes = utf8Bytes(json) + mediaBytes;

      let parts = existing.get(`${dataModule.id}|${hash}`);
      if (!parts || parts.length === 0) {
        onProgress({ percent: spanStart + span * 0.3, detail: `压缩 ${label} · ${sourceLabel}…` });
        const sourceBlob = new Blob([json], { type: "application/json" });
        json = null;
        const gz = await gzipBlob(sourceBlob);
        const slices = sliceBlob(gz, MAX_OBJECT_BYTES);
        parts = [];
        for (let k = 0; k < slices.length; k += 1) {
          onProgress({ percent: spanStart + span * (0.4 + 0.5 * (k / slices.length)), detail: `上传 ${label} · ${sourceLabel} · 分片 ${k + 1}/${slices.length}` });
          const object = `modules/${dataModule.id}/${hash}.${k}.gz`;
          await putObject(config, object, slices[k], "application/gzip");
          parts.push(object);
        }
        uploadedModuleIds.add(dataModule.id);
      } else {
        json = null;
      }

      const mediaRefs = Array.from(collector.media.keys());
      for (let mediaIndex = 0; mediaIndex < mediaRefs.length; mediaIndex += 1) {
        const ref = mediaRefs[mediaIndex];
        moduleMediaRefs.add(ref);
        const blob = collector.media.get(ref)!;
        let mediaParts = existingMedia.get(ref);
        if (!mediaParts || mediaParts.length === 0) {
          mediaParts = await uploadMediaObject(config, ref, blob, (chunkIndex, chunkTotal) => {
            onProgress({
              percent: spanStart + span * 0.92,
              detail: chunkTotal > 1
                ? `上传 ${label} 媒体 ${mediaIndex + 1}/${mediaRefs.length} · 分片 ${chunkIndex + 1}/${chunkTotal}`
                : `上传 ${label} 媒体 ${mediaIndex + 1}/${mediaRefs.length}`,
            });
          });
          existingMedia.set(ref, mediaParts);
          uploadedModuleIds.add(dataModule.id);
        }
        manifestMedia.set(ref, { ref, bytes: blob.size, parts: mediaParts });
      }

      sourceManifests.push({ index: sourceIndex, label: sourceLabel, records: built.records, bytes, hash, parts, mediaRefs });
      sourceHashes.push(`${sourceIndex}:${hash}`);
      moduleBytes += bytes;
      moduleRecords += built.records;
      completedSources += 1;
    }

    const hash = await sha256TextHex(sourceHashes.join("|"));
    totalBytes += moduleBytes;
    totalRecords += moduleRecords;
    moduleHashes.push(`${dataModule.id}:${hash}`);
    manifestModules.push({
      id: dataModule.id,
      label,
      records: moduleRecords,
      bytes: moduleBytes,
      hash,
      parts: [],
      mediaRefs: Array.from(moduleMediaRefs),
      sources: sourceManifests,
    });
  }

  const combinedHash = await sha256TextHex(moduleHashes.join("|"));

  // Change detection: nothing changed since last backup → skip (unless forced).
  // (With streaming, unchanged modules were already reused from the cloud — no
  // uploads happened — so skipping here leaves no orphan objects.)
  if (!options.force && state.lastCombinedHash && state.lastCombinedHash === combinedHash && uploadedModuleIds.size === 0) {
    saveCloudBackupState({ ...state, lastResult: "skipped", lastError: undefined });
    return { status: "skipped", uploadedModules: 0, totalBytes, totalRecords, manifestName: state.lastManifestName ?? "" };
  }

  // Anomaly check vs the last HEALTHY backup (prefer cloud truth, fall back to local).
  const baseBytes = healthy?.totalBytes ?? state.healthyBytes ?? 0;
  const baseRecords = healthy?.totalRecords ?? state.healthyRecords ?? 0;
  const anomaly = (baseBytes > 0 && totalBytes < baseBytes * ANOMALY_BYTES_RATIO)
    || (baseRecords > 0 && totalRecords < baseRecords * ANOMALY_RECORDS_RATIO);

  // 5. Write the manifest (commit point). Anomalous backups go to quarantine and
  //    never rotate out the healthy ones.
  onProgress({ percent: 96, detail: "写入备份清单…" });
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const manifest: CloudBackupManifest = {
    format: "ai-phone-cloud-backup",
    version: 2,
    createdAt,
    origin: typeof window !== "undefined" ? window.location.origin : "",
    totalBytes,
    totalRecords,
    combinedHash,
    anomaly: anomaly || undefined,
    modules: manifestModules,
    media: Array.from(manifestMedia.values()),
  };
  const manifestName = anomaly ? `manifests/quarantine-${stamp}.json` : `manifests/${stamp}.json`;
  await putObject(config, manifestName, JSON.stringify(manifest), "application/json");

  // 6. Rotation + GC only when this backup is healthy.
  if (!anomaly) {
    onProgress({ percent: 98, detail: "清理旧备份…" });
    // The manifest above is the commit point. Retention cleanup is best-effort:
    // a transient listing/delete failure must not report a completed backup as
    // failed or make the scheduler immediately repeat the whole upload.
    await rotateAndGc(config, config.keepCount, manifestName).catch((error) => {
      console.warn("[CloudBackup] rotation/GC failed after commit:", error);
    });
  }
  onProgress({ percent: 100, detail: "完成" });

  saveCloudBackupState({
    lastManifestName: manifestName,
    lastCreatedAt: createdAt,
    lastTotalBytes: totalBytes,
    lastTotalRecords: totalRecords,
    lastCombinedHash: anomaly ? state.lastCombinedHash : combinedHash,
    healthyBytes: anomaly ? state.healthyBytes : totalBytes,
    healthyRecords: anomaly ? state.healthyRecords : totalRecords,
    lastResult: anomaly ? "anomaly" : "ok",
    lastError: undefined,
  });

  return {
    status: anomaly ? "anomaly" : "ok",
    uploadedModules: uploadedModuleIds.size,
    totalBytes,
    totalRecords,
    manifestName,
  };
}

/** Keep the latest `keep` healthy manifests; delete older manifests + any module
 *  object no longer referenced by a retained manifest. */
async function rotateAndGc(config: CloudBackupConfig, keep: number, justWritten: string): Promise<void> {
  const all = await listCloudManifests(config);
  const healthy = all.filter((m) => !m.quarantine);
  const retained = healthy.slice(0, Math.max(2, keep));
  const retainedNames = new Set(retained.map((m) => m.name));
  retainedNames.add(justWritten);

  // First prove that every retained manifest is readable and collect all of its
  // references. Never delete an older manifest before that proof: a transient
  // read failure must not turn rotation into data loss.
  const referenced = new Set<string>();
  const referencedMediaPaths = new Set<string>();
  for (const name of retainedNames) {
    const manifest = await loadManifest(config, name).catch(() => null);
    if (!manifest) return;
    const mediaByRef = new Map((manifest.media ?? []).map((item) => [item.ref, item.parts ?? []] as const));
    for (const media of manifest.media ?? []) {
      (media.parts ?? []).forEach((path) => referencedMediaPaths.add(path));
    }
    manifest.modules.forEach((mod) => {
      (mod.parts ?? []).forEach((path) => referenced.add(path));
      (mod.sources ?? []).forEach((source) => {
        (source.parts ?? []).forEach((path) => referenced.add(path));
      });
      (mod.mediaRefs ?? []).forEach((ref) => {
        if (mediaByRef.has(ref)) return;
        referencedMediaPaths.add(legacyMediaPath(ref));
      });
    });
  }
  if (referenced.size === 0) return; // safety: never GC if we couldn't read references

  // The retained set is now known-good. Delete manifests we no longer keep
  // (older healthy + every quarantine) before sweeping their orphaned objects.
  for (const m of all) {
    if (!retainedNames.has(m.name)) {
      await removeObject(config, m.name).catch(() => undefined);
    }
  }

  // Delete module objects nobody references anymore.
  const moduleObjects = await listObjectsRecursive(config, "modules/");
  for (const object of moduleObjects) {
    if (!referenced.has(object.path) && isPastGcGrace(object.updatedAt)) {
      await removeObject(config, object.path).catch(() => undefined);
    }
  }

  // Delete orphaned media — only when references were read in full and the listing
  // isn't truncated (deleting a user's image by mistake is unacceptable).
  const MEDIA_LIST_LIMIT = 2000;
  const mediaObjects = await listObjects(config, "media/", MEDIA_LIST_LIMIT).catch(() => []);
  if (mediaObjects.length >= MEDIA_LIST_LIMIT) return; // truncated → skip to stay safe
  for (const o of mediaObjects) {
    const path = `media/${o.name}`;
    if (!referencedMediaPaths.has(path) && isPastGcGrace(o.updatedAt)) {
      await removeObject(config, `media/${o.name}`).catch(() => undefined);
    }
  }
}

/** modules/ is nested (modules/<id>/<hash>.json.gz); list one level of folders then their files. */
function isPastGcGrace(updatedAt?: string): boolean {
  if (!updatedAt) return false; // unknown age: keep it
  const updated = Date.parse(updatedAt);
  return Number.isFinite(updated) && Date.now() - updated >= GC_GRACE_MS;
}

async function listObjectsRecursive(config: CloudBackupConfig, prefix: string): Promise<Array<{ path: string; updatedAt?: string }>> {
  const top = await listObjects(config, prefix, 500);
  const out: Array<{ path: string; updatedAt?: string }> = [];
  for (const entry of top) {
    if (entry.name.endsWith("/") || entry.size === 0) {
      const inner = await listObjects(config, `${prefix}${entry.name.replace(/\/$/, "")}/`, 500);
      for (const f of inner) out.push({ path: `${prefix}${entry.name.replace(/\/$/, "")}/${f.name}`, updatedAt: f.updatedAt });
    } else {
      out.push({ path: `${prefix}${entry.name}`, updatedAt: entry.updatedAt });
    }
  }
  return out;
}

/** Restore: download a manifest's module objects and import them back. */
export async function restoreFromCloudManifest(
  config: CloudBackupConfig,
  manifestName: string,
  options: { overwrite?: boolean; moduleIds?: DataModuleId[]; onProgress?: (p: CloudProgress) => void } = {},
): Promise<{ added: number; skipped: number; overwritten: number; errors: string[] }> {
  return withCloudOperationLock("restore", () => restoreFromCloudManifestInternal(config, manifestName, options));
}

async function restoreFromCloudManifestInternal(
  config: CloudBackupConfig,
  manifestName: string,
  options: { overwrite?: boolean; moduleIds?: DataModuleId[]; onProgress?: (p: CloudProgress) => void },
): Promise<{ added: number; skipped: number; overwritten: number; errors: string[] }> {
  const onProgress = options.onProgress ?? (() => {});
  onProgress({ percent: 1, detail: "读取备份清单…" });
  const manifest = await loadManifest(config, manifestName);
  if (!manifest) throw new Error("找不到该备份清单。");
  const selected = options.moduleIds && options.moduleIds.length > 0 ? new Set(options.moduleIds) : null;
  const total = { added: 0, skipped: 0, overwritten: 0, errors: [] as string[] };

  const mediaByRef = new Map((manifest.media ?? []).map((item) => [item.ref, item] as const));

  // Pull each media binary on demand, one at a time (low peak memory). Old cloud
  // backups have no media map, so they fall back to media/<ref>.bin.
  const invalidMedia = new Set<string>();
  const resolver: MediaResolver = async (ref) => {
    if (invalidMedia.has(ref)) return null;
    const media = mediaByRef.get(ref);
    const paths = media?.parts && media.parts.length > 0 ? media.parts : [legacyMediaPath(ref)];
    const blobs: Blob[] = [];
    for (const path of paths) {
      const part = await getObject(config, path);
      if (!part) {
        invalidMedia.add(ref);
        return null;
      }
      blobs.push(part);
    }
    const combined = new Blob(blobs);
    if (await sha256BlobHex(combined) !== ref) {
      invalidMedia.add(ref);
      return null;
    }
    return combined;
  };

  // Progress is weighted by module bytes: downloading ≈70% of a module's share,
  // importing the records the remaining ≈30%.
  const selectedModules = manifest.modules.filter((m) => !selected || selected.has(m.id));
  const restoreTotalBytes = Math.max(1, selectedModules.reduce((s, m) => s + (m.bytes || 1), 0));
  let restoreDoneBytes = 0;
  const restorePercent = (fraction: number) => 2 + Math.min(97, 97 * (restoreDoneBytes + fraction) / restoreTotalBytes);

  for (const mod of manifest.modules) {
    if (selected && !selected.has(mod.id)) continue;
    const units = mod.sources && mod.sources.length > 0
      ? mod.sources.map((source) => ({ label: `${mod.label} · ${source.label}`, bytes: source.bytes || 1, hash: source.hash, parts: source.parts ?? [] }))
      : [{ label: mod.label, bytes: mod.bytes || 1, hash: mod.hash, parts: mod.parts ?? [] }];

    for (const unit of units) {
      const paths = unit.parts;
      if (paths.length === 0) {
        total.errors.push(`${unit.label}: 备份缺少对象`);
        restoreDoneBytes += unit.bytes;
        continue;
      }
      const blobs: Blob[] = [];
      let missing = false;
      for (let i = 0; i < paths.length; i += 1) {
        onProgress({ percent: restorePercent((i / paths.length) * unit.bytes * 0.7), detail: `下载 ${unit.label} · 分片 ${i + 1}/${paths.length}` });
        const blob = await getObject(config, paths[i]);
        if (!blob) { missing = true; break; }
        blobs.push(blob);
      }
      if (missing) {
        total.errors.push(`${unit.label}: 云端对象缺失`);
        restoreDoneBytes += unit.bytes;
        continue;
      }
      let payload: ModulePayload;
      try {
        const json = await gunzipBlob(new Blob(blobs));
        if (await sha256TextHex(json) !== unit.hash) throw new Error("完整性校验失败");
        const parsed = JSON.parse(json) as unknown;
        if (!isRestorablePayload(parsed, mod.id)) throw new Error("数据结构不匹配");
        payload = parsed;
      } catch {
        total.errors.push(`${unit.label}: 解析或完整性校验失败`);
        restoreDoneBytes += unit.bytes;
        continue;
      }
      for (let sourceIndex = 0; sourceIndex < payload.sources.length; sourceIndex += 1) {
        onProgress({ percent: restorePercent(unit.bytes * (0.7 + 0.3 * (sourceIndex / payload.sources.length))), detail: `写入 ${unit.label}…` });
        const result = await importSource(payload.sources[sourceIndex], Boolean(options.overwrite), resolver);
        total.added += result.added;
        total.skipped += result.skipped;
        total.overwritten += result.overwritten;
        total.errors.push(...result.errors);
      }
      restoreDoneBytes += unit.bytes;
    }
  }
  if (invalidMedia.size > 0) {
    total.errors.push(`${invalidMedia.size} 个媒体对象缺失或损坏，部分图片/文件可能丢失`);
  }
  onProgress({ percent: 100, detail: "完成" });
  return total;
}
