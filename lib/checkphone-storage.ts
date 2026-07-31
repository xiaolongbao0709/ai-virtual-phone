import Dexie from "dexie";
import { CHECKPHONE_APP_SPECS, type CheckPhoneAppId, type CheckPhoneManifest, type CheckPhoneSnapshot } from "./checkphone-config";
import { kvGet, kvRemove, kvSet, registerDynamicPrefix } from "./kv-db";
import { formatPromptTimestamp } from "./prompt-time";

type CheckPhoneManifestRow = CheckPhoneManifest;
type CheckPhoneSnapshotRow = CheckPhoneSnapshot;
export type CheckPhoneProjectionEntry = {
  id: string;
  appId: CheckPhoneAppId;
  timestamp: string;
  content: string;
};

const CHECKPHONE_EVENT_PREFIX = "ai_phone_checkphone_events_";
const MAX_CHECKPHONE_EVENTS_PER_CHARACTER = 120;

registerDynamicPrefix(CHECKPHONE_EVENT_PREFIX);

class CheckPhoneDatabase extends Dexie {
  manifests!: Dexie.Table<CheckPhoneManifestRow, string>;
  snapshots!: Dexie.Table<CheckPhoneSnapshotRow, string>;

  constructor() {
    super("AiPhoneCheckPhoneDB");
    this.version(1).stores({
      manifests: "characterId, updatedAt",
    });
    this.version(2).stores({
      manifests: "characterId, updatedAt",
      snapshots: "id, characterId, appId, updatedAt, [characterId+appId]",
    });
  }
}

const db = new CheckPhoneDatabase();
const manifestCache = new Map<string, CheckPhoneManifest>();
const snapshotCache = new Map<string, CheckPhoneSnapshot>();
let hydrated = false;

function projectionStorageKey(characterId: string): string {
  return `${CHECKPHONE_EVENT_PREFIX}${characterId}`;
}

function cleanEventText(value: unknown, maxLength: number): string {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function loadProjectionEventsByKey(key: string): CheckPhoneProjectionEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is CheckPhoneProjectionEntry =>
        entry
        && typeof entry.id === "string"
        && typeof entry.appId === "string"
        && entry.appId in CHECKPHONE_APP_SPECS
        && typeof entry.timestamp === "string"
        && typeof entry.content === "string"
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

function saveProjectionEventsByKey(key: string, entries: CheckPhoneProjectionEntry[]): void {
  if (typeof window === "undefined") return;
  const compacted = [...entries]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-MAX_CHECKPHONE_EVENTS_PER_CHARACTER);
  kvSet(key, JSON.stringify(compacted));
}

function recordCheckPhoneSnapshotEvent(snapshot: CheckPhoneSnapshot): void {
  const characterId = cleanEventText(snapshot.characterId, 160);
  if (!characterId) return;
  const spec = CHECKPHONE_APP_SPECS[snapshot.appId];
  if (!spec) return;

  const timestamp = snapshot.updatedAt || snapshot.generatedAt || new Date().toISOString();
  const formattedTime = formatPromptTimestamp(timestamp);
  const label = cleanEventText(spec.shortLabel || spec.label, 40) || snapshot.appId;
  const entry: CheckPhoneProjectionEntry = {
    id: `checkphone_${snapshot.appId}_${Date.parse(timestamp) || Date.now()}`,
    appId: snapshot.appId,
    timestamp,
    content: `${formattedTime ? `[查手机 ${formattedTime}]` : "[查手机]"} {{user}}偷窥了{{char}}的手机的${label}APP。`,
  };

  const key = projectionStorageKey(characterId);
  const current = loadProjectionEventsByKey(key);
  saveProjectionEventsByKey(key, [entry, ...current.filter(item => item.id !== entry.id)]);
}

export async function hydrateCheckPhoneStorage(): Promise<void> {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const [rows, snapshots] = await Promise.all([
      db.manifests.toArray(),
      db.snapshots.toArray(),
    ]);
    for (const row of rows) {
      manifestCache.set(row.characterId, row);
    }
    for (const row of snapshots) {
      snapshotCache.set(row.id, row);
    }
  } catch (error) {
    console.warn("[CheckPhoneStorage] hydrate error:", error);
  }
}

export function readPhoneManifestCache(characterId: string): CheckPhoneManifest | null {
  return manifestCache.get(characterId) ?? null;
}

export async function loadPhoneManifest(characterId: string): Promise<CheckPhoneManifest | null> {
  const cached = manifestCache.get(characterId);
  if (cached) return cached;
  try {
    const row = await db.manifests.get(characterId);
    if (row) {
      manifestCache.set(characterId, row);
      return row;
    }
  } catch (error) {
    console.warn("[CheckPhoneStorage] load manifest error:", error);
  }
  return null;
}

export async function savePhoneManifest(manifest: CheckPhoneManifest): Promise<void> {
  manifestCache.set(manifest.characterId, manifest);
  try {
    await db.manifests.put(manifest);
  } catch (error) {
    console.warn("[CheckPhoneStorage] save manifest error:", error);
  }
}

export async function clearPhoneManifest(characterId: string): Promise<void> {
  manifestCache.delete(characterId);
  try {
    await db.manifests.delete(characterId);
  } catch (error) {
    console.warn("[CheckPhoneStorage] clear manifest error:", error);
  }
}

function snapshotKey(characterId: string, appId: CheckPhoneAppId): string {
  return `${characterId}:${appId}`;
}

export function readPhoneSnapshotCache<AppPayload = unknown>(
  characterId: string,
  appId: CheckPhoneAppId,
): CheckPhoneSnapshot<AppPayload> | null {
  return (snapshotCache.get(snapshotKey(characterId, appId)) as CheckPhoneSnapshot<AppPayload> | undefined) ?? null;
}

export async function loadPhoneSnapshot<AppPayload = unknown>(
  characterId: string,
  appId: CheckPhoneAppId,
): Promise<CheckPhoneSnapshot<AppPayload> | null> {
  const key = snapshotKey(characterId, appId);
  const cached = snapshotCache.get(key);
  if (cached) return cached as CheckPhoneSnapshot<AppPayload>;
  try {
    const row = await db.snapshots.get(key);
    if (row) {
      snapshotCache.set(key, row);
      return row as CheckPhoneSnapshot<AppPayload>;
    }
  } catch (error) {
    console.warn("[CheckPhoneStorage] load snapshot error:", error);
  }
  return null;
}

export async function savePhoneSnapshot<AppPayload = unknown>(snapshot: CheckPhoneSnapshot<AppPayload>): Promise<void> {
  snapshotCache.set(snapshot.id, snapshot as CheckPhoneSnapshot);
  try {
    await db.snapshots.put(snapshot as CheckPhoneSnapshot);
  } catch (error) {
    console.warn("[CheckPhoneStorage] save snapshot error:", error);
  }
  recordCheckPhoneSnapshotEvent(snapshot as CheckPhoneSnapshot);
}

export async function clearPhoneSnapshot(characterId: string, appId: CheckPhoneAppId): Promise<void> {
  const key = snapshotKey(characterId, appId);
  snapshotCache.delete(key);
  try {
    await db.snapshots.delete(key);
  } catch (error) {
    console.warn("[CheckPhoneStorage] clear snapshot error:", error);
  }
}

/** 清除某角色查手机（查岗）写入短期记忆的全部记录。 */
export function clearCheckPhoneProjectionEntries(characterId: string): void {
  if (typeof window === "undefined") return;
  kvRemove(projectionStorageKey(characterId));
}

/** 删除某角色查手机记录中的一条。 */
export function removeCheckPhoneProjectionEntry(characterId: string, entryId: string): void {
  if (typeof window === "undefined") return;
  const key = projectionStorageKey(characterId);
  const remaining = loadProjectionEventsByKey(key).filter(entry => entry.id !== entryId);
  if (remaining.length === 0) {
    kvRemove(key);
    return;
  }
  saveProjectionEventsByKey(key, remaining);
}

export function loadCheckPhoneProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string },
): CheckPhoneProjectionEntry[] {
  const entries = loadProjectionEventsByKey(projectionStorageKey(characterId));
  if (!options?.afterTimestamp) return entries;
  return entries.filter(entry => entry.timestamp > options.afterTimestamp!);
}
