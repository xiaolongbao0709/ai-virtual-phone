export type DiaryEntryTrigger = "manual" | "timer";

export type DiaryEntryAuthorType = "character" | "user";

export type DiaryEntryTodoItem = {
  text: string;
  done: boolean;
};

export type DiaryEntryBlock =
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "correction"; text: string; replacement?: string }
  | { type: "todo"; title?: string; items: DiaryEntryTodoItem[] }
  | { type: "image"; caption?: string; description: string };

export type DiaryEntry = {
  id: string;
  characterId: string;
  characterName: string;
  /** "character"（角色写自己的日记，默认，兼容老数据）| "user"（用户手写，给角色看的日记） */
  authorType: DiaryEntryAuthorType;
  title: string;
  dateLabel: string;
  mood: string;
  weather: string;
  tags: string[];
  /** 仅 authorType === "user" 时有意义：写在日记末尾的署名 */
  signature: string;
  body: string;
  blocks: DiaryEntryBlock[];
  trigger: DiaryEntryTrigger;
  createdAt: string;
  updatedAt: string;
};

export type DiaryEntryInput = {
  characterId: string;
  characterName: string;
  authorType?: DiaryEntryAuthorType;
  title: string;
  dateLabel?: string;
  mood?: string;
  weather?: string;
  tags?: string[];
  signature?: string;
  body: string;
  blocks: DiaryEntryBlock[];
  trigger?: DiaryEntryTrigger;
};

/** 编辑一篇已存在日记时可以改的字段；不传的字段保持原样 */
export type DiaryEntryPatch = Partial<Omit<DiaryEntryInput, "characterId" | "authorType">>;

export type DiaryEntryTimerSettings = {
  enabled: boolean;
  intervalHours: number;
  characterIds: string[];
  lastRunAtByCharacter: Record<string, string>;
};

export const DEFAULT_DIARY_ENTRY_TIMER_SETTINGS: DiaryEntryTimerSettings = {
  enabled: false,
  intervalHours: 24,
  characterIds: [],
  lastRunAtByCharacter: {},
};

// ── 用户写日记后，角色如何回应（手记 App「我的日记」专用） ──────────

export type DiaryReplyMode = "none" | "immediate" | "delay" | "merge";

export type DiaryReplyRule = {
  mode: DiaryReplyMode;
  delayHours: number;
};

/** 角色单独设置：mode 比 DiaryReplyRule 多一个 "inherit"（跟随 default）。
 *  故意不写成 `DiaryReplyRule & { mode: ... }`——交叉类型会把两个 mode 字段
 *  取交集，"inherit" 不在 DiaryReplyMode 里，交出来的类型反而丢了 "inherit"。 */
export type DiaryReplyCharacterRule = {
  mode: DiaryReplyMode | "inherit";
  delayHours: number;
};

export type DiaryReplyRules = {
  default: DiaryReplyRule;
  /** 未出现在这里的角色跟随 default；mode 为 "inherit" 也表示跟随 default */
  characters: Record<string, DiaryReplyCharacterRule>;
};

export const DEFAULT_DIARY_REPLY_RULE: DiaryReplyRule = { mode: "none", delayHours: 24 };

export const DEFAULT_DIARY_REPLY_RULES: DiaryReplyRules = {
  default: DEFAULT_DIARY_REPLY_RULE,
  characters: {},
};
