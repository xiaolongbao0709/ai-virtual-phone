// lib/mascot-memory.ts
// 小卷长期记忆：记录用户偏好、最近话题、讨论过的角色，注入到系统提示词

const DB_NAME = "AiPhoneMascotDB";
const DB_VERSION = 3; // v3: + memory store
const STORE_NAME = "memory";
const MEMORY_KEY = "v1";

// ── 类型 ──

export type MascotMemoryEntry = {
  version: 1;
  lastUpdated: string;
  recentTopics: string[];        // 最近 5 个讨论话题
  charactersDiscussed: string[];  // 讨论过的角色名
  preferences: string[];          // 用户明确表达的偏好
  interactionCount: number;
};

const DEFAULT_MEMORY: MascotMemoryEntry = {
  version: 1,
  lastUpdated: new Date().toISOString(),
  recentTopics: [],
  charactersDiscussed: [],
  preferences: [],
  interactionCount: 0,
};

// ── DB 操作 ──

function openMemoryDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB 不可用"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("chat")) {
        db.createObjectStore("chat");
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readMemory(): Promise<MascotMemoryEntry> {
  try {
    const db = await openMemoryDb();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(MEMORY_KEY);
        req.onsuccess = () => {
          const data = req.result;
          if (data && data.version === 1) {
            resolve(data as MascotMemoryEntry);
          } else {
            resolve({ ...DEFAULT_MEMORY });
          }
        };
        req.onerror = () => resolve({ ...DEFAULT_MEMORY });
      } catch {
        resolve({ ...DEFAULT_MEMORY });
      }
    });
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

async function writeMemory(entry: MascotMemoryEntry): Promise<void> {
  try {
    const db = await openMemoryDb();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(entry, MEMORY_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve(); // 静默失败
      } catch {
        resolve();
      }
    });
  } catch {
    // 静默失败
  }
}

// ── 公开 API ──

/** 读取当前记忆 */
export async function getMascotMemory(): Promise<MascotMemoryEntry> {
  return await readMemory();
}

/** 清除全部记忆 */
export async function clearMascotMemory(): Promise<void> {
  await writeMemory({ ...DEFAULT_MEMORY });
}

/** 根据用户消息更新记忆（由聊天 store 在每轮结束后调用） */
export async function updateMascotMemory(userMessage: string): Promise<void> {
  const msg = userMessage.trim();
  if (!msg || msg.length < 6) return; // 太短不记

  const memory = await readMemory();
  const now = new Date().toISOString();

  memory.lastUpdated = now;
  memory.interactionCount += 1;

  // ── 话题识别 ──
  const topics = detectTopics(msg);
  for (const t of topics) {
    if (!memory.recentTopics.includes(t)) {
      memory.recentTopics.unshift(t);
    }
  }
  memory.recentTopics = memory.recentTopics.slice(0, 5);

  // ── 偏好提取 ──
  const prefs = extractPreferences(msg);
  for (const p of prefs) {
    if (!memory.preferences.includes(p)) {
      memory.preferences.push(p);
    }
  }
  memory.preferences = memory.preferences.slice(0, 5);

  // ── 角色名提取 ──
  const chars = extractCharacterNames(msg);
  for (const c of chars) {
    if (!memory.charactersDiscussed.includes(c)) {
      memory.charactersDiscussed.push(c);
    }
  }
  memory.charactersDiscussed = memory.charactersDiscussed.slice(0, 8);

  await writeMemory(memory);
}

// ── 话题检测 ──

const TOPIC_PATTERNS: Array<[RegExp, string]> = [
  [/角色卡|人设|人物|persona|性格|外貌|设定/, "角色卡"],
  [/世界书|worldbook|词条|lorebook/, "世界书"],
  [/预设|preset|回复风格/, "预设"],
  [/正则|regex|替换规则/, "正则"],
  [/CSS|样式|界面|主题|皮肤/, "CSS/样式"],
  [/生图|图片|锁脸|照片|画风|图片生成|生成图/, "生图"],
  [/朋友圈|moment|动态|发帖/, "朋友圈"],
  [/相册|album/, "相册"],
  [/聊天|对话|回复|语气|说话/, "聊天/对话"],
  [/模板|指令/, "指令/模板"],
  [/导航|页面|功能|入口|在哪/, "功能导航"],
  [/小说|剧情|故事|VN|visual.?novel/, "剧情/小说"],
  [/创建|新增|添加|做个|帮我写|帮我弄/, "创建"],
  [/修改|改一下|调整|优化/, "修改/优化"],
];

function detectTopics(msg: string): string[] {
  const found: string[] = [];
  for (const [re, label] of TOPIC_PATTERNS) {
    if (re.test(msg) && !found.includes(label)) {
      found.push(label);
    }
  }
  return found.length > 0 ? found : ["闲聊"];
}

// ── 偏好提取 ──

const PREF_PATTERNS: RegExp[] = [
  /我(喜欢|偏好|倾向|比较喜欢|想要|希望)(.{2,20}?)(?:[。，,!\s]|$)/g,
  /不(喜欢|想要|太想要)(.{2,20}?)(?:[。，,!\s]|$)/g,
  /(偏好|倾向|风格)(?:是|：|:)(.{2,20}?)(?:[。，,!\s]|$)/g,
];

function extractPreferences(msg: string): string[] {
  const prefs: string[] = [];
  for (const pattern of PREF_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(msg)) !== null) {
      const text = match[0].replace(/[。，,!\s]+$/, "").trim();
      if (text.length >= 4 && text.length <= 30) {
        prefs.push(text);
      }
    }
    pattern.lastIndex = 0;
  }
  return prefs;
}

// ── 角色名提取 ──

function extractCharacterNames(msg: string): string[] {
  const names: string[] = [];
  // 中文名（2-3 个汉字）
  const namePattern = /[\u4e00-\u9fff]{2,3}/g;
  const commonWords = new Set([
    "我们", "他们", "你们", "这个", "那个", "什么", "怎么", "一个",
    "可以", "不是", "没有", "现在", "然后", "如果", "因为", "所以",
    "喜欢", "想要", "希望", "觉得", "应该", "已经", "还是", "或者",
    "角色", "人物", "世界", "预设", "正则", "样式", "相册", "朋友",
    "首页", "主页", "桌面", "聊天", "设置", "工具", "小卷", "创建",
    "修改", "调整", "添加", "删除", "打开", "关闭", "帮我", "麻烦",
  ]);
  let match: RegExpExecArray | null;
  while ((match = namePattern.exec(msg)) !== null) {
    const name = match[0];
    if (!commonWords.has(name) && !names.includes(name)) {
      names.push(name);
    }
  }
  return names.slice(0, 5);
}

// ── 生成记忆提示词 ──

/** 生成注入到系统提示词的记忆片段（无内容时返回空字符串） */
export async function generateMemoryPrompt(): Promise<string> {
  const memory = await readMemory();

  // 无实质内容时不注入
  if (memory.recentTopics.length === 0 && memory.preferences.length === 0 && memory.charactersDiscussed.length === 0) {
    return "";
  }

  const lines: string[] = ["===== 关于用户的长期记忆 ====="];

  if (memory.recentTopics.length > 0) {
    lines.push(`最近讨论的话题：${memory.recentTopics.join("、")}`);
  }
  if (memory.charactersDiscussed.length > 0) {
    lines.push(`讨论过的角色：${memory.charactersDiscussed.join("、")}`);
  }
  if (memory.preferences.length > 0) {
    lines.push(`用户偏好：${memory.preferences.join("；")}`);
  }

  lines.push("（请参考以上信息，让对话更有连续性和针对性。不要一次性全部复述出来，自然地融入回答。）");

  return lines.join("\n");
}
