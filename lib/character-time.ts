export type CharacterTimeContext = {
  systemTime: string;
  systemWeekday: string;
  systemTimeZone: string;
  characterTime: string;
  characterWeekday: string;
  characterTimeZone: string;
  timeContext: string;
  hasDifference: boolean;
};

export type GroupTimeMember = {
  name: string;
  timeZone?: string | null;
};

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

type DateParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function readTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getSystemTimeZone(): string {
  return readTimeZone();
}

export function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timeZone = value.trim();
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return undefined;
  }
}

function getDateParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values: Partial<DateParts> = {};
  for (const part of formatter.formatToParts(date)) {
    if (
      part.type === "year"
      || part.type === "month"
      || part.type === "day"
      || part.type === "hour"
      || part.type === "minute"
      || part.type === "second"
    ) {
      values[part.type] = part.value;
    }
  }
  return {
    year: values.year || "0000",
    month: values.month || "01",
    day: values.day || "01",
    hour: values.hour || "00",
    minute: values.minute || "00",
    second: values.second || "00",
  };
}

export function formatZonedPromptTimestamp(date: Date, timeZone: string, includeTimeZone = false): string {
  const parts = getDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${includeTimeZone ? ` ${timeZone}` : ""}`;
}

export function formatZonedChineseDateTime(date: Date, timeZone: string): string {
  const parts = getDateParts(date, timeZone);
  return `${Number(parts.year)}年${Number(parts.month)}月${Number(parts.day)}日${parts.hour}:${parts.minute}`;
}

export function getZonedWeekday(date: Date, timeZone: string): string {
  try {
    const label = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
    return label || WEEKDAYS[0];
  } catch {
    return WEEKDAYS[date.getDay()];
  }
}

export function hasTimeZoneDifference(date: Date, characterTimeZone: string, systemTimeZone = getSystemTimeZone()): boolean {
  const systemParts = getDateParts(date, systemTimeZone);
  const characterParts = getDateParts(date, characterTimeZone);
  return systemParts.year !== characterParts.year
    || systemParts.month !== characterParts.month
    || systemParts.day !== characterParts.day
    || systemParts.hour !== characterParts.hour
    || systemParts.minute !== characterParts.minute;
}

export type VirtualClockConfig = {
  virtualClockAnchor?: string;
  virtualClockSetAt?: string;
  virtualClockMode?: "flowing" | "frozen";
};

/**
 * Resolve the effective "now" based on virtual clock settings.
 * - flowing: virtual anchor + (real elapsed since setAt)
 * - frozen: always returns anchor
 * - no config: returns real now
 */
export function resolveVirtualNow(config?: VirtualClockConfig | null): Date {
  if (!config?.virtualClockAnchor) return new Date();
  const anchor = new Date(config.virtualClockAnchor);
  if (isNaN(anchor.getTime())) return new Date();

  if (config.virtualClockMode === "frozen") return anchor;

  const setAt = config.virtualClockSetAt ? new Date(config.virtualClockSetAt) : null;
  if (!setAt || isNaN(setAt.getTime())) return anchor;
  const elapsed = Date.now() - setAt.getTime();
  return new Date(anchor.getTime() + Math.max(0, elapsed));
}

/** Convert a real stored timestamp to its session's virtual-clock representation. */
export function resolveVirtualTimestamp(date: Date, config?: VirtualClockConfig | null): Date {
  if (!config?.virtualClockAnchor || !config.virtualClockSetAt) return date;
  const anchor = new Date(config.virtualClockAnchor);
  const setAt = new Date(config.virtualClockSetAt);
  if (isNaN(anchor.getTime()) || isNaN(setAt.getTime())) return date;

  // Frozen clocks do not advance after the point at which they were set.
  const effectiveRealTime = config.virtualClockMode === "frozen"
    ? Math.min(date.getTime(), setAt.getTime())
    : date.getTime();
  return new Date(anchor.getTime() + (effectiveRealTime - setAt.getTime()));
}

export function buildCharacterTimeContext(timeZone?: string | null, now = new Date()): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  const systemTime = formatZonedChineseDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const hasDifference = normalizedTimeZone ? hasTimeZoneDifference(now, normalizedTimeZone, systemTimeZone) : false;

  if (!normalizedTimeZone || !hasDifference) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: `当前系统时间：${systemTime}，${systemWeekday}`,
      hasDifference: false,
    };
  }

  const characterTime = formatZonedChineseDateTime(now, normalizedTimeZone);
  const characterWeekday = getZonedWeekday(now, normalizedTimeZone);
  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime,
    characterWeekday,
    characterTimeZone: normalizedTimeZone,
    timeContext: [
      `当前系统时间：${systemTime} ${systemTimeZone}，${systemWeekday}`,
      `角色本地时间：${characterTime} ${normalizedTimeZone}，${characterWeekday}`,
      "判断角色作息、问候、深夜/清晨/工作时间时，优先使用角色本地时间。",
    ].join("\n"),
    hasDifference: true,
  };
}

export function buildGroupTimeContext(members: GroupTimeMember[], now = new Date()): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  const systemTime = formatZonedChineseDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const rows = members
    .map(member => {
      const timeZone = normalizeTimeZone(member.timeZone);
      if (!timeZone || !hasTimeZoneDifference(now, timeZone, systemTimeZone)) return null;
      return `${member.name}：${formatZonedChineseDateTime(now, timeZone)} ${timeZone}，${getZonedWeekday(now, timeZone)}`;
    })
    .filter((row): row is string => Boolean(row));

  if (rows.length === 0) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: `当前系统时间：${systemTime}，${systemWeekday}`,
      hasDifference: false,
    };
  }

  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime: "",
    characterWeekday: "",
    characterTimeZone: "",
    timeContext: [
      `当前系统时间：${systemTime} ${systemTimeZone}，${systemWeekday}`,
      "群成员本地时间：",
      ...rows,
      "判断每个角色作息、问候、深夜/清晨/工作时间时，优先使用该角色自己的本地时间。",
    ].join("\n"),
    hasDifference: true,
  };
}
