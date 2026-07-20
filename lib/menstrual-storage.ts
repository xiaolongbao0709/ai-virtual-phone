export type MenstrualRecord = {
  id: string;
  startDate: string;
  endDate: string;
};

export type MenstrualConfig = {
  cycleLength: number;
  periodLength: number;
  periodCareEnabled: boolean;
  periodCareCharacterIds: string[];
  periodCareLeadDays: 1 | 2 | 3;
};

export type MenstrualPeriodCareEvent = {
  cycleKey: string;
  context: string;
};

export type MenstrualSummary = {
  latest: MenstrualRecord | null;
  currentPeriodStartDate: string | null;
  todayStarted: boolean;
  todayFinished: boolean;
  isPeriodActive: boolean;
  todayState: { type: string; shortLabel: string } | null;
};

const CONFIG_KEY = "menstrual-config-v1";
const RECORDS_KEY = "menstrual-records-v1";
const TRIGGERED_KEY_PREFIX = "menstrual-triggered-";

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJSON<T>(key: string, fallback: T): T {
  if (!storageAvailable()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  if (!storageAvailable()) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function getDefaultConfig(): MenstrualConfig {
  return {
    cycleLength: 28,
    periodLength: 5,
    periodCareEnabled: false,
    periodCareCharacterIds: [],
    periodCareLeadDays: 1,
  };
}

export function loadMenstrualConfig(): MenstrualConfig {
  return readJSON<MenstrualConfig>(CONFIG_KEY, getDefaultConfig());
}

export function saveMenstrualConfig(config: MenstrualConfig): MenstrualConfig {
  const next = { ...getDefaultConfig(), ...config };
  writeJSON(CONFIG_KEY, next);
  return next;
}

export function loadMenstrualRecords(): MenstrualRecord[] {
  return readJSON<MenstrualRecord[]>(RECORDS_KEY, []);
}

export function deleteMenstrualRecord(id: string): MenstrualRecord[] {
  const next = loadMenstrualRecords().filter(record => record.id !== id);
  writeJSON(RECORDS_KEY, next);
  return next;
}

export function startCurrentPeriod(selectedDate: string): MenstrualConfig {
  const config = loadMenstrualConfig();
  const records = loadMenstrualRecords();
  const nextRecords = [
    ...records,
    { id: `record-${Date.now()}`, startDate: selectedDate, endDate: selectedDate },
  ];
  writeJSON(RECORDS_KEY, nextRecords);
  return config;
}

export function cancelCurrentPeriodStart(selectedDate: string): MenstrualConfig {
  const records = loadMenstrualRecords();
  const filtered = records.filter(record => !(record.startDate === selectedDate && record.endDate === selectedDate));
  if (filtered.length !== records.length) writeJSON(RECORDS_KEY, filtered);
  void selectedDate;
  return loadMenstrualConfig();
}

export function finishCurrentPeriod(selectedDate: string): { saved: boolean; config: MenstrualConfig; records: MenstrualRecord[] } {
  const records = loadMenstrualRecords();
  if (records.length === 0) return { saved: false, config: loadMenstrualConfig(), records };
  const last = records[records.length - 1];
  const updated = records.map(record => record.id === last.id ? { ...record, endDate: selectedDate } : record);
  writeJSON(RECORDS_KEY, updated);
  return { saved: true, config: loadMenstrualConfig(), records: updated };
}

export function cancelFinishCurrentPeriod(selectedDate: string): { restored: boolean; config: MenstrualConfig; records: MenstrualRecord[] } {
  const records = loadMenstrualRecords();
  const restored = records.some(record => record.endDate === selectedDate && record.startDate !== selectedDate);
  if (restored) {
    const updated = records.map(record => record.endDate === selectedDate ? { ...record, endDate: record.startDate } : record);
    writeJSON(RECORDS_KEY, updated);
  }
  void selectedDate;
  return { restored, config: loadMenstrualConfig(), records: restored ? loadMenstrualRecords() : records };
}

export function validateMenstrualSettings(input: { cycleLength: number; periodLength: number }): string | null {
  if (!Number.isFinite(input.cycleLength) || input.cycleLength < 21 || input.cycleLength > 60) {
    return "周期长度需在 21 到 60 天之间";
  }
  if (!Number.isFinite(input.periodLength) || input.periodLength < 2 || input.periodLength > 10) {
    return "经期天数需在 2 到 10 天之间";
  }
  return null;
}

export function buildMenstrualDayMap(
  startDate: string,
  endDate: string,
  records: MenstrualRecord[],
  config: MenstrualConfig,
): Map<string, { type: string; shortLabel: string }> {
  const map = new Map<string, { type: string; shortLabel: string }>();
  const start = startDate;
  const end = endDate;
  void config;
  for (const record of records) {
    if (record.startDate >= start && record.startDate <= end) {
      map.set(record.startDate, { type: "period", shortLabel: "经期" });
    }
    if (record.endDate >= start && record.endDate <= end) {
      map.set(record.endDate, { type: "period", shortLabel: "经期" });
    }
  }
  return map;
}

export function getMenstrualSummary(records: MenstrualRecord[], config: MenstrualConfig, selectedDate: string): MenstrualSummary {
  const latest = records[records.length - 1] ?? null;
  const currentPeriodStartDate = latest?.startDate ?? null;
  const todayStarted = Boolean(latest && latest.startDate === selectedDate);
  const todayFinished = Boolean(latest && latest.endDate === selectedDate);
  const isPeriodActive = Boolean(latest && latest.startDate && latest.endDate >= latest.startDate);
  return {
    latest,
    currentPeriodStartDate,
    todayStarted,
    todayFinished,
    isPeriodActive,
    todayState: latest ? { type: "period", shortLabel: "经期" } : null,
  };
}

export function getMenstrualPeriodCareEvent(records: MenstrualRecord[], config: MenstrualConfig): MenstrualPeriodCareEvent | null {
  if (!records.length) return null;
  const latest = records[records.length - 1];
  if (!latest) return null;
  const cycleKey = `${latest.startDate}:${latest.endDate}`;
  return {
    cycleKey,
    context: `最新经期记录从 ${latest.startDate} 到 ${latest.endDate}，周期长度 ${config.cycleLength} 天，经期长度 ${config.periodLength} 天`,
  };
}

export function hasMenstrualPeriodCareTriggered(characterId: string, cycleKey: string): boolean {
  if (!storageAvailable()) return false;
  const key = `${TRIGGERED_KEY_PREFIX}${characterId}:${cycleKey}`;
  return window.localStorage.getItem(key) === "1";
}

export function saveMenstrualPeriodCareTrigger(input: { characterId: string; sessionId: string; cycleKey: string }): void {
  if (!storageAvailable()) return;
  const key = `${TRIGGERED_KEY_PREFIX}${input.characterId}:${input.cycleKey}`;
  window.localStorage.setItem(key, "1");
}
