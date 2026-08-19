export type DataModuleId =
  | "chat"
  | "settings"
  | "characters"
  | "desktop"
  | "memory"
  | "social"
  | "apps"
  | "resource_hub"
  | "creative"
  | "cache";

export type IconVariant = "action" | "success" | "warning" | "danger" | "teal";

export type IndexedDbSource = {
  type: "indexeddb";
  dbName: string;
  stores?: string[];
  label?: string;
};

export type KvSource = {
  type: "kv";
  keys?: string[];
  prefixes?: string[];
  includeAll?: boolean;
  /** Keys/prefixes to exclude when includeAll is set (used by the KV catch-all). */
  excludeKeys?: string[];
  excludePrefixes?: string[];
  label?: string;
};

export type LocalStorageSource = {
  type: "localStorage";
  keys?: string[];
  prefixes?: string[];
  includeAll?: boolean;
  // Keys/prefixes to exclude even when includeAll is set. Used by the catch-all
  // "cache" module so it never touches keys owned by other modules (notably the
  // migration flags, whose deletion could shadow IndexedDB data on reload).
  excludeKeys?: string[];
  excludePrefixes?: string[];
  label?: string;
};

export type DataSource = IndexedDbSource | KvSource | LocalStorageSource;

export type DataModuleDefinition = {
  id: DataModuleId;
  label: string;
  description: string;
  variant: IconVariant;
  critical?: boolean;
  large?: boolean;
  sources: DataSource[];
};

export type StoreRecordBackup = {
  key?: unknown;
  value: unknown;
};

export type StoreIndexBackup = {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
};

export type StoreBackup = {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  // Index definitions, so a restore into a fresh browser can recreate them.
  // Older backups lack this field; those restore index-less stores as before.
  indexes?: StoreIndexBackup[];
  records: StoreRecordBackup[];
};

export type IndexedDbSourceBackup = {
  type: "indexeddb";
  dbName: string;
  stores: StoreBackup[];
  /** 导出时打不开数据库（被浏览器清除/损坏/被占用）——有值即表示这份数据不完整 */
  error?: string;
};

export type KvSourceBackup = {
  type: "kv";
  records: { key: string; value: string }[];
};

export type LocalStorageSourceBackup = {
  type: "localStorage";
  records: { key: string; value: string }[];
};

export type SourceBackup = IndexedDbSourceBackup | KvSourceBackup | LocalStorageSourceBackup;

export type ModulePayload = {
  moduleId: DataModuleId;
  sources: SourceBackup[];
};

export type ModuleStats = {
  moduleId: DataModuleId;
  label: string;
  description: string;
  variant: IconVariant;
  records: number;
  bytes: number;
  percent: number;
  critical: boolean;
  large: boolean;
  details?: SourceDetailStats[];
};

export type SourceDetailStats = {
  id: string;
  label: string;
  records: number;
  bytes: number;
};

export type DataSnapshot = {
  totalBytes: number;
  totalRecords: number;
  modules: ModuleStats[];
  storage?: {
    usage?: number;
    quota?: number;
    persisted?: boolean;
  };
  createdAt: string;
};

export type BackupManifest = {
  format: "ai-phone-backup";
  /** 1 = media inlined as base64; 2 = media stored as separate binary entries (media/<ref>.bin). */
  version: 1 | 2;
  createdAt: string;
  origin: string;
  modules: Array<{
    id: DataModuleId;
    label: string;
    records: number;
    bytes: number;
  }>;
  totalBytes: number;
  totalRecords: number;
  /** True when images/multimedia were stripped to keep the backup small. */
  mediaExcluded?: boolean;
};

export type BackupEnvelope = {
  manifest: BackupManifest;
  modules: ModulePayload[];
};

export type ImportOptions = {
  overwrite?: boolean;
};

export type ImportResult = {
  added: number;
  skipped: number;
  overwritten: number;
  errors: string[];
};

export type ClearResult = {
  removed: number;
  errors: string[];
};
