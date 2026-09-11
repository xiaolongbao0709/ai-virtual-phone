import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { ChatEngineError, previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { assemblePromptPayload, type AssemblerInput, type LLMContentPart, type LLMMessage } from "./llm-prompt-assembler";
import { DEFAULT_XIAOHONGSHU_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { prepareShortTermContext } from "./short-term-assembler";
import {
  loadApiConfigs,
  loadBindingConfig,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig } from "./settings-types";
import {
  addNames,
  loadXiaohongshuState,
  makeXiaohongshuNpcId,
  makeXiaohongshuComment,
  makeXiaohongshuNotification,
} from "./xiaohongshu-storage";
import {
  DEFAULT_XIAOHONGSHU_NPC_IDENTITY_GUARD_PROMPT,
  DEFAULT_XIAOHONGSHU_NPC_FEED_PROMPT,
  DEFAULT_XIAOHONGSHU_NPC_DM_REPLY_PROMPT,
  DEFAULT_XIAOHONGSHU_NPC_COMMENT_REPLY_PROMPT,
  DEFAULT_XIAOHONGSHU_NPC_MORE_COMMENTS_PROMPT,
  DEFAULT_XIAOHONGSHU_NPC_USER_POST_REACTION_PROMPT,
  type ParsedXiaohongshuCharacterActivity,
  type ParsedXiaohongshuCharacterMentionReply,
  type ParsedXiaohongshuCharacterReaction,
  type ParsedXiaohongshuCharacterThreadItem,
  type ParsedXiaohongshuNpcCommentReply,
  type ParsedXiaohongshuNpcDmReply,
  type ParsedXiaohongshuNpcFeed,
  type ParsedXiaohongshuNpcReaction,
  type XiaohongshuComment,
  type XiaohongshuAccount,
  type XiaohongshuNotification,
  type XiaohongshuNote,
  type XiaohongshuNoteType,
  type XiaohongshuSettings,
} from "./xiaohongshu-types";
import { resolveCharacterXiaohongshuDisplayName } from "./xiaohongshu-character-profile";

type ParsedBlock = {
  title: string;
  number: number;
  fields: Record<string, string>;
};

type AssemblerResult = {
  character: Character;
  apiConfig: ApiConfig | null;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  input: AssemblerInput;
};

function buildXiaohongshuBilingualInstruction(settings?: XiaohongshuSettings): string {
  const prompt = resolveBilingualPrompt(
    settings?.bilingualTranslationEnabled !== false,
    settings?.bilingualTranslationPrompt,
    DEFAULT_XIAOHONGSHU_BILINGUAL_PROMPT,
  );
  if (!prompt) return "";
  return [
    "<xiaohongshu_bilingual_text_instruction>",
    prompt,
    "</xiaohongshu_bilingual_text_instruction>",
  ].join("\n");
}

type XiaohongshuNpcMacroContext = {
  userName?: string;
  userXiaohongshuName?: string;
  extraReservedNames?: string[];
};

function cleanReservedName(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function collectXiaohongshuReservedNames(context: XiaohongshuNpcMacroContext = {}): string[] {
  const names: string[] = [];
  const add = (value: unknown) => {
    const name = cleanReservedName(value);
    if (name && !names.includes(name)) names.push(name);
  };

  loadCharacters().forEach((character) => {
    add(character.name);
    add(resolveCharacterXiaohongshuDisplayName(character));
  });

  add(resolveUserIdentity()?.name);
  add(resolveUserIdentity(undefined, "xiaohongshu")?.name);
  add(context.userName);
  add(context.userXiaohongshuName);
  context.extraReservedNames?.forEach(add);

  return names;
}

function formatXiaohongshuReservedNames(context: XiaohongshuNpcMacroContext = {}): string {
  const names = collectXiaohongshuReservedNames(context);
  return names.length > 0 ? names.map(name => `- ${name}`).join("\n") : "- 暂无";
}

function buildDefaultXiaohongshuNpcIdentityGuard(context: XiaohongshuNpcMacroContext = {}): string {
  return DEFAULT_XIAOHONGSHU_NPC_IDENTITY_GUARD_PROMPT.replace(
    /\{\{\s*xiaohongshuReservedNames\s*\}\}/g,
    formatXiaohongshuReservedNames(context),
  );
}

function expandXiaohongshuNpcMacros(text: string, context: XiaohongshuNpcMacroContext = {}): string {
  return text
    .replace(/\{\{\s*xiaohongshuReservedNames\s*\}\}/g, formatXiaohongshuReservedNames(context))
    .replace(/\{\{\s*xiaohongshuNpcIdentityGuard\s*\}\}/g, buildDefaultXiaohongshuNpcIdentityGuard(context));
}

function buildXiaohongshuNpcPrompt(
  settings: XiaohongshuSettings,
  prompt: string,
  context: XiaohongshuNpcMacroContext = {},
): string {
  const guardTemplate = (settings.npcIdentityGuardPrompt ?? "").trim() || DEFAULT_XIAOHONGSHU_NPC_IDENTITY_GUARD_PROMPT;
  const guard = expandXiaohongshuNpcMacros(guardTemplate, context).trim();
  const body = expandXiaohongshuNpcMacros(prompt, context).trim();
  return [guard, body].filter(Boolean).join("\n\n");
}

// 解析层剪枝：保留名单守卫只是提示词约束，模型不听话时仍会产出冒用
// 用户名的"路人"评论（实报）。朋友圈引擎早有同类剪枝，这里对齐口径：
// 命中用户名的生成评论整条丢弃，挂在它下面的楼中楼一并丢弃。
function normalizeXiaohongshuAuthorName(value: unknown): string {
  return cleanReservedName(value).toLowerCase();
}

function buildXiaohongshuUserNameSet(extraNames: string[] = []): Set<string> {
  const names = [
    resolveUserIdentity()?.name,
    resolveUserIdentity(undefined, "xiaohongshu")?.name,
    ...extraNames,
  ].map(normalizeXiaohongshuAuthorName).filter(Boolean);
  return new Set(names);
}

function isXiaohongshuUserAuthorName(authorName: string, userNames: Set<string>): boolean {
  const normalized = normalizeXiaohongshuAuthorName(authorName);
  return normalized !== "" && userNames.has(normalized);
}

function getUserXiaohongshuNamesFromNote(note: XiaohongshuNote): string[] {
  const names = [
    note.source === "user" ? note.authorName : "",
    ...note.comments
      .filter(comment => comment.authorType === "user")
      .map(comment => comment.authorName),
  ].map(cleanReservedName).filter(Boolean);
  return Array.from(new Set(names));
}

function getUserXiaohongshuNamesFromNotes(notes: XiaohongshuNote[]): string[] {
  const names = notes.flatMap(note => getUserXiaohongshuNamesFromNote(note));
  return Array.from(new Set(names));
}

export class XiaohongshuGenerationError extends Error {
  rawOutput: string;
  parseError?: string;

  constructor(message: string, rawOutput = "", parseError?: string) {
    super(message);
    this.name = "XiaohongshuGenerationError";
    this.rawOutput = rawOutput;
    this.parseError = parseError;
  }
}

function parseWithDebug<T>(raw: string, parser: (raw: string) => T, fallbackMessage: string): T {
  try {
    return parser(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : fallbackMessage;
    throw new XiaohongshuGenerationError(fallbackMessage, raw, message);
  }
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanMultiline(value: unknown, maxLength: number): string {
  return cleanText(value, maxLength)
    .replace(/\r\n?/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function parseMetric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const text = String(value ?? "")
    .trim()
    .replace(/[,，\s]/g, "");
  if (!text) return 0;
  const tenThousandMatch = /^(-?\d+(?:\.\d+)?)[wW万](?:(\d+(?:\.\d+)?)(?:[kK千])?)?$/.exec(text);
  if (tenThousandMatch) {
    const main = Number(tenThousandMatch[1]);
    const tail = tenThousandMatch[2] ? Number(tenThousandMatch[2]) : 0;
    if (Number.isFinite(main) && Number.isFinite(tail)) {
      return Math.max(0, Math.round(main * 10000 + tail * 1000));
    }
  }
  const thousandMatch = /^(-?\d+(?:\.\d+)?)[kK千](?:(\d+(?:\.\d+)?)(?:百)?)?$/.exec(text);
  if (thousandMatch) {
    const main = Number(thousandMatch[1]);
    const tail = thousandMatch[2] ? Number(thousandMatch[2]) : 0;
    if (Number.isFinite(main) && Number.isFinite(tail)) {
      return Math.max(0, Math.round(main * 1000 + tail * 100));
    }
  }
  const numeric = Number(text.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  if (/[wW万]/.test(text)) return Math.max(0, Math.round(numeric * 10000));
  if (/[kK千]/.test(text)) return Math.max(0, Math.round(numeric * 1000));
  return Math.max(0, Math.round(numeric));
}

function metricField(fields: Record<string, string> | undefined, names: string[]): unknown {
  if (!fields) return undefined;
  for (const name of names) {
    if (fields[name] !== undefined) return fields[name];
  }
  return undefined;
}

function parseMetricField(fields: Record<string, string> | undefined, names: string[], fallback = 0): number {
  const value = metricField(fields, names);
  return value === undefined || String(value).trim() === "" ? fallback : parseMetric(value);
}

function parseBoolean(value: unknown): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return ["是", "yes", "true", "1", "y", "喜欢", "收藏"].includes(text);
}

function parseTags(value: unknown): string[] {
  return Array.from(new Set(String(value ?? "")
    .split(/[,，、#\s]+/)
    .map(tag => cleanText(tag, 18))
    .filter(Boolean))).slice(0, 6);
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:text|json|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseBlocks(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;
  const lines = stripFences(text).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const blockMatch = /^#\s*([^\d#\[]+?)(\d+)?\s*$/.exec(line);
    if (blockMatch) {
      if (current) blocks.push(current);
      current = {
        title: blockMatch[1].trim(),
        number: Number(blockMatch[2] || "1"),
        fields: {},
      };
      continue;
    }
    if (!current) {
      current = { title: "全局", number: 1, fields: {} };
    }
    const fieldMatch = /^\[([^\]]+)]\s*(.*)$/.exec(line);
    if (fieldMatch) {
      current.fields[fieldMatch[1].trim()] = fieldMatch[2].trim();
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function parseBlockComments(fields: Record<string, string>, noteId: string, source: "npc" | "character" = "npc"): XiaohongshuComment[] {
  const numbers = Object.keys(fields)
    .map(key => /^评论(\d+)作者$/.exec(key)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .sort((a, b) => a - b);
  const userNames = buildXiaohongshuUserNameSet();
  const prunedNumbers = new Set<number>();
  const comments: XiaohongshuComment[] = [];
  for (const number of numbers) {
    const authorName = cleanText(fields[`评论${number}作者`], 60) || "小红书用户";
    const replyTarget = cleanText(fields[`评论${number}回复对象`], 40);
    const replyNumber = /^评论(\d+)$/.exec(replyTarget)?.[1];
    if (isXiaohongshuUserAuthorName(authorName, userNames)) {
      console.warn(`[Xiaohongshu] 剪掉冒用用户名的生成评论: "${authorName}"`);
      prunedNumbers.add(number);
      continue;
    }
    if (replyNumber && prunedNumbers.has(Number(replyNumber))) {
      prunedNumbers.add(number);
      continue;
    }
    const text = cleanMultiline(fields[`评论${number}内容`], 600);
    if (!text) continue;
    comments.push(makeXiaohongshuComment({
      noteId,
      authorType: source,
      authorId: source === "npc" ? makeXiaohongshuNpcId(authorName) : source,
      authorName,
      text,
      replyTo: replyNumber ? undefined : replyTarget || undefined,
      replyToCommentId: replyNumber ? `${noteId}_comment_${replyNumber}` : undefined,
      unread: source === "npc",
    }));
  }
  return comments;
}

/**
 * 解析 [延伸N作者/回复对象/内容] 字段族为角色侧 thread 数组。
 * - 字段名兼容 "延伸N作者"/"延伸N回复对象"/"延伸N内容"
 * - 没有任何延伸字段时返回空数组（apply 端据此回退到"只保留主评论"）
 */
function parseCharacterThreadFields(fields: Record<string, string>): ParsedXiaohongshuCharacterThreadItem[] {
  const numbers = Object.keys(fields)
    .map(key => /^延伸(\d+)作者$/.exec(key)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .sort((a, b) => a - b);
  return numbers.map((number) => {
    const authorName = cleanText(fields[`延伸${number}作者`], 60);
    const replyTo = cleanText(fields[`延伸${number}回复对象`], 60);
    return {
      number,
      authorName,
      text: cleanMultiline(fields[`延伸${number}内容`], 600),
      replyTo: replyTo || undefined,
    };
  }).filter(item => item.text && item.authorName).slice(0, 8);
}

function isCharacterXiaohongshuAuthor(authorName: string, characterDisplayName: string, characterName: string): boolean {
  const normalized = authorName.trim();
  if (!normalized) return false;
  return [characterDisplayName.trim(), characterName.trim()].filter(Boolean).includes(normalized);
}

/**
 * 把角色侧 thread 评论按顺序追加到 note 上：
 * - "主评论" 或缺省 → replyToCommentId = mainCommentId
 * - "延伸N" → replyToCommentId 指向前面已生成的 thread comment
 * - 作者名匹配 character.name 或小红书显示名 → authorType="character"，否则 "npc"
 */
function appendCharacterThreadToNote(args: {
  note: XiaohongshuNote;
  characterDisplayName: string;
  characterName: string;
  characterId: string;
  thread: ParsedXiaohongshuCharacterThreadItem[];
  mainCommentId: string;
  shouldNotifyUser: boolean;
}): {
  note: XiaohongshuNote;
  appended: XiaohongshuComment[];
  notifications: ReturnType<typeof makeXiaohongshuNotification>[];
} {
  const { note, characterDisplayName, characterName, characterId, thread, mainCommentId, shouldNotifyUser } = args;
  const appended: XiaohongshuComment[] = [];
  const numberToId = new Map<number, string>();
  const userNames = buildXiaohongshuUserNameSet(getUserXiaohongshuNamesFromNote(note));
  const prunedNumbers = new Set<number>();
  thread.forEach((item) => {
    const isCharacter = isCharacterXiaohongshuAuthor(item.authorName, characterDisplayName, characterName);
    const replyTarget = (item.replyTo || "").trim();
    const referenceMatch = /^延伸(\d+)$/.exec(replyTarget);
    if (!isCharacter && isXiaohongshuUserAuthorName(item.authorName, userNames)) {
      console.warn(`[Xiaohongshu] 剪掉冒用用户名的楼中楼评论: "${item.authorName}"`);
      prunedNumbers.add(item.number);
      return;
    }
    if (referenceMatch && prunedNumbers.has(Number(referenceMatch[1]))) {
      prunedNumbers.add(item.number);
      return;
    }
    const isMainReply = !replyTarget || /^主评论$/.test(replyTarget);
    const replyToCommentId = isMainReply
      ? mainCommentId
      : referenceMatch
        ? numberToId.get(Number(referenceMatch[1])) || mainCommentId
        : mainCommentId;
    const comment = makeXiaohongshuComment({
      noteId: note.id,
      authorType: isCharacter ? "character" : "npc",
      authorId: isCharacter ? characterId : makeXiaohongshuNpcId(item.authorName),
      authorName: isCharacter ? characterDisplayName : item.authorName,
      text: item.text,
      replyToCommentId,
      unread: shouldNotifyUser,
    });
    appended.push(comment);
    numberToId.set(item.number, comment.id);
  });
  const notifications = shouldNotifyUser
    ? appended
        .filter(comment => comment.authorType === "npc")
        .map(comment => makeXiaohongshuNotification({
          type: "comment" as const,
          noteId: note.id,
          actorName: comment.authorName,
          text: comment.text,
          thumbnailText: note.title,
          unread: true,
        }))
    : [];
  return {
    note: {
      ...note,
      comments: [...note.comments, ...appended],
      commentCount: note.commentCount + appended.length,
      updatedAt: appended.length > 0 ? new Date().toISOString() : note.updatedAt,
    },
    appended,
    notifications,
  };
}

function parseNoteBlock(
  block: ParsedBlock,
  type: "post" | "video",
  index: number,
  source: "npc" | "character" = "npc",
  authorId = "npc",
  feedScope: XiaohongshuNote["feedScope"] = "discover",
): XiaohongshuNote | null {
  const noteId = makeId(type === "video" ? "xhs_video" : "xhs_note");
  const body = cleanMultiline(block.fields["正文"] ?? block.fields["内容"], 3000);
  const title = cleanText(block.fields["标题"], 80) || body.slice(0, 24);
  if (!title && !body) return null;
  const comments = parseBlockComments(block.fields, noteId, source);
  const authorName = cleanText(block.fields["作者"] ?? block.fields["落款"], 60) || "小红书用户";
  return {
    id: noteId,
    type,
    feedScope,
    source,
    authorId: source === "npc" && authorId === "npc" ? makeXiaohongshuNpcId(authorName) : authorId,
    authorName,
    title: title || "未命名笔记",
    body,
    videoDescription: cleanMultiline(block.fields["视频描述"] ?? block.fields["画面描述"], 500) || undefined,
    coverIcon: cleanText(block.fields["图标"], 8) || (type === "video" ? "▶" : "✦"),
    tone: index % 4 === 1 ? "mist" : index % 4 === 2 ? "blush" : index % 4 === 3 ? "graphite" : "ivory",
    tags: parseTags(block.fields["标签"] ?? block.fields["TAG"]),
    likeCount: parseMetricField(block.fields, ["点赞", "点赞数", "赞"]),
    saveCount: parseMetricField(block.fields, ["收藏", "收藏数"]),
    commentCount: parseMetricField(block.fields, ["评论数", "评论量", "评论"], comments.length),
    liked: parseBoolean(block.fields["已赞"]),
    saved: parseBoolean(block.fields["已收藏"]),
    recentLikeNames: [block.fields["点赞用户1"], block.fields["点赞用户2"]].map(name => cleanText(name, 24)).filter(Boolean),
    recentSaveNames: [block.fields["收藏用户1"], block.fields["收藏用户2"]].map(name => cleanText(name, 24)).filter(Boolean),
    comments: comments.map((comment, idx) => ({ ...comment, id: `${noteId}_comment_${idx + 1}` })),
    imageDescription: cleanMultiline(block.fields["图片描述"] ?? block.fields["配图"], 500) || undefined,
    createdAt: new Date(Date.now() - index * 1000 * 60 * 5).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function parseXiaohongshuNpcFeed(raw: string): ParsedXiaohongshuNpcFeed {
  const blocks = parseBlocks(raw);
  const nearbyNotes = blocks
    .filter(block => /附近笔记|同城笔记|附近/.test(block.title) && !/视频/.test(block.title))
    .slice(0, 4)
    .map((block, index) => parseNoteBlock(block, "post", index + 12, "npc", "npc", "nearby"))
    .filter((note): note is XiaohongshuNote => Boolean(note));
  const homeNotes = blocks
    .filter(block => /首页笔记|图文笔记|笔记/.test(block.title) && !/视频|附近|同城/.test(block.title))
    .slice(0, 6)
    .map((block, index) => parseNoteBlock(block, "post", index, "npc"))
    .filter((note): note is XiaohongshuNote => Boolean(note));
  const videoNotes = blocks
    .filter(block => /视频/.test(block.title))
    .slice(0, 6)
    .map((block, index) => parseNoteBlock(block, "video", index + homeNotes.length, "npc"))
    .filter((note): note is XiaohongshuNote => Boolean(note));
  return { homeNotes, videoNotes, nearbyNotes };
}

export function parseXiaohongshuNpcReaction(raw: string, noteId: string): ParsedXiaohongshuNpcReaction {
  const blocks = parseBlocks(raw);
  const interaction = blocks.find(block => /用户笔记互动|互动/.test(block.title)) ?? blocks[0];
  const commentFields = blocks.reduce<Record<string, string>>((acc, block) => ({ ...acc, ...block.fields }), {});
  const comments = parseBlockComments(commentFields, noteId, "npc").map((comment) => ({
    authorName: comment.authorName,
    text: comment.text,
    replyTo: comment.replyTo,
    replyToCommentId: comment.replyToCommentId,
  }));
  const directMessages = blocks
    .filter(block => /私信|消息/.test(block.title))
    .map(block => ({
      name: cleanText(block.fields["名称"] ?? block.fields["作者"], 60) || "小红书用户",
      text: cleanMultiline(block.fields["正文"] ?? block.fields["内容"], 600),
    }))
    .filter(item => item.text)
    .slice(0, 6);
  const followerCount = parseMetric(metricField(interaction?.fields, ["新增关注", "关注", "粉丝"]));
  const followerNames = Array.from(new Set([
    interaction?.fields["关注用户1"],
    interaction?.fields["关注用户2"],
    interaction?.fields["关注用户3"],
    ...Array.from({ length: Math.min(12, followerCount) }, (_, index) => interaction?.fields[`关注用户${index + 1}`]),
  ].map(name => cleanText(name, 60)).filter(Boolean))).slice(0, Math.max(2, followerCount || 0));
  return {
    likeCount: parseMetric(metricField(interaction?.fields, ["点赞", "点赞数", "赞"])),
    saveCount: parseMetric(metricField(interaction?.fields, ["收藏", "收藏数"])),
    recentLikeNames: [interaction?.fields["点赞用户1"], interaction?.fields["点赞用户2"]].map(name => cleanText(name, 24)).filter(Boolean),
    recentSaveNames: [interaction?.fields["收藏用户1"], interaction?.fields["收藏用户2"]].map(name => cleanText(name, 24)).filter(Boolean),
    comments,
    directMessages,
    followerNames,
  };
}

export function parseXiaohongshuNpcCommentReply(raw: string, noteId: string, fallbackReplyToCommentId?: string): ParsedXiaohongshuNpcCommentReply {
  const blocks = parseBlocks(raw);
  const fields = blocks.reduce<Record<string, string>>((acc, block) => ({ ...acc, ...block.fields }), {});
  const numbers = Object.keys(fields)
    .map(key => /^评论(\d+)作者$/.exec(key)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .sort((a, b) => a - b);
  const userNames = buildXiaohongshuUserNameSet();
  const prunedNumbers = new Set<number>();
  const comments: ParsedXiaohongshuNpcCommentReply["comments"] = [];
  for (const number of numbers) {
    if (comments.length >= 4) break;
    const authorName = cleanText(fields[`评论${number}作者`], 60) || "小红书用户";
    const replyValue = cleanText(fields[`评论${number}回复评论ID`] ?? fields[`评论${number}回复对象`], 180);
    const replyNumber = /^评论(\d+)$/.exec(replyValue)?.[1];
    if (isXiaohongshuUserAuthorName(authorName, userNames)) {
      console.warn(`[Xiaohongshu] 剪掉冒用用户名的生成评论: "${authorName}"`);
      prunedNumbers.add(number);
      continue;
    }
    if (replyNumber && prunedNumbers.has(Number(replyNumber))) {
      prunedNumbers.add(number);
      continue;
    }
    const isEmptyReply = !replyValue || /^(无|none|null|-)$/.test(replyValue.toLowerCase()) || /被回复|候选|评论id/i.test(replyValue);
    const replyToCommentId = replyNumber
      ? `${noteId}_comment_${replyNumber}`
      : !isEmptyReply
        ? replyValue
        : fallbackReplyToCommentId;
    const text = cleanMultiline(fields[`评论${number}内容`], 600);
    if (!text) continue;
    comments.push({ authorName, text, replyToCommentId });
  }
  return { comments };
}

export function parseXiaohongshuNpcMoreComments(raw: string): ParsedXiaohongshuNpcCommentReply {
  const blocks = parseBlocks(raw);
  const fields = blocks.reduce<Record<string, string>>((acc, block) => ({ ...acc, ...block.fields }), {});
  const numbers = Object.keys(fields)
    .map(key => /^评论(\d+)作者$/.exec(key)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .sort((a, b) => a - b);
  const userNames = buildXiaohongshuUserNameSet();
  const prunedNumbers = new Set<number>();
  const comments: ParsedXiaohongshuNpcCommentReply["comments"] = [];
  for (const number of numbers) {
    if (comments.length >= 8) break;
    const authorName = cleanText(fields[`评论${number}作者`], 60) || "小红书用户";
    const replyId = cleanText(fields[`评论${number}回复评论ID`], 180);
    const replyTarget = cleanText(fields[`评论${number}回复对象`], 80);
    const replyNumber = /^评论(\d+)$/.exec(replyTarget)?.[1];
    if (isXiaohongshuUserAuthorName(authorName, userNames)) {
      console.warn(`[Xiaohongshu] 剪掉冒用用户名的生成评论: "${authorName}"`);
      prunedNumbers.add(number);
      continue;
    }
    if (replyNumber && prunedNumbers.has(Number(replyNumber))) {
      prunedNumbers.add(number);
      continue;
    }
    const isEmptyReplyId = !replyId || /^(无|none|null|-)$/.test(replyId.toLowerCase()) || /从上下文|真实评论id|被回复|候选|评论id/i.test(replyId);
    const text = cleanMultiline(fields[`评论${number}内容`], 600);
    if (!text) continue;
    comments.push({
      authorName,
      text,
      replyTo: !replyNumber && replyTarget ? replyTarget : undefined,
      replyToCommentId: !isEmptyReplyId
        ? replyId
        : replyNumber
          ? `__generated_comment_${replyNumber}`
          : undefined,
    });
  }
  return { comments };
}

export function parseXiaohongshuNpcDmReply(raw: string): ParsedXiaohongshuNpcDmReply {
  const blocks = parseBlocks(raw).filter(block => /私信|回复|消息/.test(block.title));
  const messages = blocks
    .map(block => cleanMultiline(block.fields["正文"] ?? block.fields["内容"] ?? block.fields["回复"], 600))
    .filter(Boolean)
    .slice(0, 4);
  if (messages.length > 0) return { messages };
  const fallback = cleanMultiline(raw.replace(/^#.*$/gm, "").replace(/^\[[^\]]+]\s*/gm, ""), 600);
  return { messages: fallback ? [fallback] : [] };
}

export function parseXiaohongshuCharacterActivity(raw: string, allowedNoteIds: string[]): ParsedXiaohongshuCharacterActivity {
  const blocks = parseBlocks(raw);
  const comments = blocks
    .filter(block => /评论/.test(block.title))
    .map(block => {
      const thread = parseCharacterThreadFields(block.fields);
      return {
        noteId: cleanText(block.fields["笔记ID"] ?? block.fields["noteId"], 180),
        text: cleanMultiline(block.fields["内容"] ?? block.fields["评论"], 600),
        liked: parseBoolean(block.fields["点赞"]),
        saved: parseBoolean(block.fields["收藏"]),
        thread: thread.length > 0 ? thread : undefined,
      };
    })
    .filter(item => item.noteId && item.text && allowedNoteIds.includes(item.noteId))
    .slice(0, 3);
  const postBlock = blocks.find(block => /发帖|笔记|视频/.test(block.title) && !/评论/.test(block.title));
  const rawPostType = cleanText(postBlock?.fields["类型"] ?? postBlock?.fields["格式"] ?? postBlock?.title, 40).toLowerCase();
  const postType: XiaohongshuNoteType = /视频|video/.test(rawPostType) ? "video" : "post";
  const post = postBlock
    ? {
        type: postType,
        title: cleanText(postBlock.fields["标题"], 80),
        body: cleanMultiline(postBlock.fields["正文"] ?? postBlock.fields["内容"], 3000),
        coverIcon: cleanText(postBlock.fields["图标"], 8) || (postType === "video" ? "▶" : "✦"),
        tags: parseTags(postBlock.fields["标签"] ?? postBlock.fields["TAG"]),
        likeCount: parseMetricField(postBlock.fields, ["点赞", "点赞数", "赞"]),
        saveCount: parseMetricField(postBlock.fields, ["收藏", "收藏数"]),
        commentCount: parseMetricField(postBlock.fields, ["评论数", "评论量", "评论"], parseBlockComments(postBlock.fields, "__character_post__", "npc").length),
        recentLikeNames: [postBlock.fields["点赞用户1"], postBlock.fields["点赞用户2"]].map(name => cleanText(name, 24)).filter(Boolean),
        recentSaveNames: [postBlock.fields["收藏用户1"], postBlock.fields["收藏用户2"]].map(name => cleanText(name, 24)).filter(Boolean),
        imageDescription: postType === "post" ? cleanMultiline(postBlock.fields["图片描述"] ?? postBlock.fields["配图"], 500) || undefined : undefined,
        videoDescription: postType === "video"
          ? cleanMultiline(postBlock.fields["视频描述"] ?? postBlock.fields["视频画面"] ?? postBlock.fields["图片描述"] ?? postBlock.fields["配图"], 500) || undefined
          : undefined,
        comments: parseBlockComments(postBlock.fields, "__character_post__", "npc")
          .map((comment) => ({
            authorName: comment.authorName,
            text: comment.text,
            replyTo: comment.replyTo,
            replyToCommentId: comment.replyToCommentId,
          }))
          .slice(0, 8),
      }
    : undefined;
  return { comments, post: post && (post.title || post.body) ? post : undefined };
}

export function parseXiaohongshuCharacterReaction(raw: string): ParsedXiaohongshuCharacterReaction {
  const blocks = parseBlocks(raw);
  const block = blocks.find(item => /角色互动|互动|评论|回复/.test(item.title)) ?? blocks[0];
  const thread = block ? parseCharacterThreadFields(block.fields) : [];
  return {
    comment: cleanMultiline(block?.fields["评论"] ?? block?.fields["内容"], 600),
    liked: parseBoolean(block?.fields["点赞"]),
    saved: parseBoolean(block?.fields["收藏"]),
    followedAuthor: parseBoolean(block?.fields["关注作者"] ?? block?.fields["关注"]),
    thread: thread.length > 0 ? thread : undefined,
  };
}

export function parseXiaohongshuCharacterMentionReply(raw: string): ParsedXiaohongshuCharacterMentionReply {
  const blocks = parseBlocks(raw);
  const block = blocks.find(item => /角色回复|回复|评论/.test(item.title)) ?? blocks[0];
  const thread = block ? parseCharacterThreadFields(block.fields) : [];
  return {
    comment: cleanMultiline(block?.fields["内容"] ?? block?.fields["评论"], 600),
    thread: thread.length > 0 ? thread : undefined,
  };
}

function formatFollowedAccountsForPrompt(accounts: XiaohongshuAccount[] = []): string {
  const names = accounts
    .filter(account => account.type !== "user")
    .map(account => account.name)
    .filter(Boolean)
    .slice(0, 12);
  if (names.length === 0) return "";
  return [
    "用户当前关注的小红书账号：",
    ...names.map(name => `- ${name}`),
    "生成内容流时，可以适当提高这些账号再次出现的概率，但不要强行全部出现。",
  ].join("\n");
}

function formatNpcFeedUserContext(userIpLocation?: string): string {
  const ipLocation = cleanText(userIpLocation, 60) || "未知";
  return [
    "用户资料上下文：",
    `[用户IP属地]${ipLocation}`,
  ].join("\n");
}

function collectCleanNames(values: unknown[]): string[] {
  const names: string[] = [];
  for (const value of values) {
    const name = cleanText(value, 80);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function getXiaohongshuUserProfileName(): string {
  const state = loadXiaohongshuState();
  return cleanText(state.profile.nickname, 80)
    || cleanText(resolveUserIdentity(undefined, "xiaohongshu")?.name, 80)
    || cleanText(resolveUserIdentity()?.name, 80)
    || "小红书用户";
}

function hasCharacterFollowedUser(characterId: string): boolean {
  if (!characterId) return false;
  return loadXiaohongshuState().socialGraph.followers.some(account =>
    account.type === "character" && account.id === characterId
  );
}

function buildXiaohongshuUserIdentityHint(input: {
  characterId: string;
  userName?: string;
  xiaohongshuNames?: string[];
}): string {
  const userName = cleanText(input.userName, 80)
    || cleanText(resolveUserIdentity(input.characterId, "chat")?.name, 80)
    || cleanText(resolveUserIdentity()?.name, 80)
    || "用户";
  const names = collectCleanNames([
    ...(input.xiaohongshuNames ?? []),
    getXiaohongshuUserProfileName(),
  ]);
  const xiaohongshuNameText = names.length > 0 ? names.join("、") : "未知";
  const followed = hasCharacterFollowedUser(input.characterId);
  const body = followed
    ? [
        "你已关注用户的小红书账号，可以明确识别该账号与用户本人的关系。",
        `用户真实身份：${userName}`,
        `用户小红书昵称/马甲：${xiaohongshuNameText}`,
        "当作者或评论者显示为上述昵称时，按用户本人处理；回复时保持自然，不要生硬暴露系统说明。",
      ]
    : [
        "你当前没有关注该小红书账号。",
        "当前作者或评论者只对你显示为公开小红书昵称；可以根据公开内容、语气、昵称、图片和已有记忆自行判断作者是否熟悉。",
        "不要直接断定对方的现实身份；如果判断不出熟悉关系，就按陌生小红书用户自然回应。",
      ];
  return [
    "<xiaohongshu_user_identity_hint>",
    ...body,
    "</xiaohongshu_user_identity_hint>",
  ].join("\n");
}

function prependXiaohongshuUserIdentityHint(context: string, hint: string): string {
  return [hint.trim(), context.trim()].filter(Boolean).join("\n\n");
}

function resolveGlobalApiConfig(): ApiConfig | null {
  const configs = loadApiConfigs();
  const binding = loadBindingConfig();
  if (binding.globalDefaults.apiConfigId) {
    return configs.find(config => config.id === binding.globalDefaults.apiConfigId) ?? null;
  }
  return configs[0] ?? null;
}

function hasVisionParts(messages: LLMMessage[]): boolean {
  return messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"));
}

function stripVisionParts(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const text = message.content
      .filter((part): part is Extract<LLMContentPart, { type: "text" }> => part.type === "text")
      .map(part => part.text)
      .filter(Boolean)
      .join("\n\n");
    return { ...message, content: text || "[图片已省略：当前模型不支持多模态输入]" };
  });
}

function isVisionUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  const statusLooksRelevant = /api error\s+(400|413|415|422)/i.test(message)
    || /invalid_request|invalid request|invalid_argument|invalid parameters|invalid format|request_too_large|unsupported/i.test(lower)
    || /参数|格式|不支持|请求体/.test(message);
  if (!statusLooksRelevant) return false;
  return [
    "image_url",
    "input_image",
    "image input",
    "image content",
    "image block",
    "image source",
    "inline_data",
    "inlinedata",
    "file_data",
    "mime_type",
    "media_type",
    "unsupported media",
    "unsupported content",
    "unsupported content type",
    "invalid content type",
    "content must be a string",
    "content should be a string",
    "content must be string",
    "expected string",
    "expected a string",
    "expected object",
    "expected array",
    "multimodal",
    "multi-modal",
    "vision",
    "does not support images",
    "doesn't support images",
    "model does not support",
    "not support image",
    "only supports text",
    "text only",
    "request_too_large",
    "图片",
    "图像",
    "视觉",
    "多模态",
    "不支持图片",
    "不支持图像",
    "不支持多模态",
    "参数非法",
    "参数有误",
    "请求体格式错误",
    "当前模型不支持",
  ].some(keyword => lower.includes(keyword.toLowerCase()) || message.includes(keyword));
}

async function sendWithOptionalVisionFallback(
  apiConfig: ApiConfig,
  preset: PresetConfig | null,
  messages: LLMMessage[],
  regexes: RegexConfig[],
  meta: { characterName?: string; userName?: string },
  options: { appId: string; appTags?: string[]; skipOutputRegex?: boolean },
): Promise<string> {
  const attemptedVision = hasVisionParts(messages);
  try {
    return await sendLLMRequest(apiConfig, preset, messages, regexes, meta, options);
  } catch (error) {
    if (!attemptedVision || !isVisionUnsupportedError(error)) throw error;
    console.warn("[Xiaohongshu] Vision request failed, retrying without images:", error);
    return sendLLMRequest(apiConfig, preset, stripVisionParts(messages), regexes, meta, options);
  }
}

function makeVisionMessage(text: string, imageDataUrl?: string | null): LLMMessage {
  if (!imageDataUrl) return { role: "user", content: text, _debugMeta: { marker: "xiaohongshu_context" } };
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } },
    ],
    _debugMeta: { marker: "xiaohongshu_context" },
  };
}

async function resolveNoteImageDataUrl(note: XiaohongshuNote): Promise<string | null> {
  if (!note.imageAssetId) return null;
  try {
    return await getChatImageFromIndexedDB(note.imageAssetId);
  } catch {
    return null;
  }
}

export function formatXiaohongshuFeedContext(notes: XiaohongshuNote[]): string {
  if (notes.length === 0) return "暂无小红书笔记。";
  return notes
    .slice(0, 30)
    .map((note) => {
      const comments = note.comments.slice(0, 8).map((comment, index) => {
        const reply = comment.replyToCommentId
          ? ` 回复${comment.replyToCommentId.replace(/^.*_comment_/, "评论")}`
          : comment.replyTo
            ? ` 回复${comment.replyTo}`
            : "";
        return `  [评论${index + 1}] ${comment.authorName}${reply}：${comment.text}`;
      });
      return [
        `#笔记`,
        `[笔记ID]${note.id}`,
        `[类型]${note.type === "video" ? "视频" : "图文"}`,
        `[作者]${note.authorName}`,
        `[标题]${note.title}`,
        `[正文]${note.body}`,
        note.imageDescription ? `[图片内容]${note.imageDescription}` : note.imageAssetId ? "[图片内容]有真实图片" : "",
        `[TAG]${note.tags.join("、") || "无"}`,
        `[点赞]${note.likeCount}`,
        `[收藏]${note.saveCount}`,
        `[评论数]${note.commentCount}`,
        "已有评论：",
        comments.length ? comments.join("\n") : "  暂无评论",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export function formatXiaohongshuUserPostContext(note: XiaohongshuNote): string {
  return formatXiaohongshuFeedContext([note]);
}

function formatCommentLine(comment: XiaohongshuComment, comments: XiaohongshuComment[]): string {
  const targetName = comment.replyToCommentId
    ? comments.find(item => item.id === comment.replyToCommentId)?.authorName
    : comment.replyTo;
  const reply = targetName ? ` 回复${targetName}` : "";
  return `[评论ID]${comment.id} [作者]${comment.authorName}${reply}：[内容]${comment.text}`;
}

export function formatXiaohongshuCommentContext(
  note: XiaohongshuNote,
  userComment: XiaohongshuComment,
  targetComment?: XiaohongshuComment,
): string {
  const recentComments = note.comments
    .slice(-16)
    .map(comment => formatCommentLine(comment, note.comments));
  return [
    "#笔记",
    `[笔记ID]${note.id}`,
    `[类型]${note.type === "video" ? "视频" : "图文"}`,
    `[作者]${note.authorName}`,
    `[标题]${note.title}`,
    `[正文]${note.body}`,
    note.imageDescription ? `[图片内容]${note.imageDescription}` : note.imageAssetId ? "[图片内容]有真实图片" : "",
    `[TAG]${note.tags.join("、") || "无"}`,
    `[点赞]${note.likeCount}`,
    `[收藏]${note.saveCount}`,
    `[评论数]${note.commentCount}`,
    "",
    targetComment ? "#被回复评论" : "",
    targetComment ? formatCommentLine(targetComment, note.comments) : "",
    "",
    "#当前触发的评论",
    formatCommentLine(userComment, note.comments),
    "",
    "#已有评论",
    recentComments.length ? recentComments.join("\n") : "暂无评论",
  ].filter(Boolean).join("\n");
}

export function formatXiaohongshuMentionContext(
  note: XiaohongshuNote,
  userComment: XiaohongshuComment,
  mentionedCharacter: Character,
  targetComment?: XiaohongshuComment,
): string {
  return [
    `[被@角色]${resolveCharacterXiaohongshuDisplayName(mentionedCharacter)}`,
    "",
    formatXiaohongshuCommentContext(note, userComment, targetComment),
  ].filter(Boolean).join("\n");
}

export function formatXiaohongshuNoteCommentContext(note: XiaohongshuNote): string {
  const comments = note.comments
    .slice(-30)
    .map(comment => formatCommentLine(comment, note.comments));
  return [
    "#笔记",
    `[笔记ID]${note.id}`,
    `[类型]${note.type === "video" ? "视频" : "图文"}`,
    `[来源]${note.source === "user" ? "用户笔记" : note.source === "character" ? "角色笔记" : "NPC笔记"}`,
    `[作者]${note.authorName}`,
    `[标题]${note.title}`,
    `[正文]${note.body}`,
    note.videoDescription ? `[视频内容]${note.videoDescription}` : "",
    note.imageDescription ? `[图片内容]${note.imageDescription}` : note.imageAssetId ? "[图片内容]有真实图片" : "",
    `[TAG]${note.tags.join("、") || "无"}`,
    `[点赞]${note.likeCount}`,
    `[收藏]${note.saveCount}`,
    `[评论数]${note.commentCount}`,
    "",
    "#已有评论",
    comments.length ? comments.join("\n") : "暂无评论",
  ].filter(Boolean).join("\n");
}

export function formatXiaohongshuDmContext(input: {
  threadName: string;
  userName: string;
  messages: XiaohongshuNotification[];
  latestUserText: string;
}): string {
  const history = input.messages
    .slice(-20)
    .map((message) => {
      const speaker = message.direction === "outgoing" ? input.userName : input.threadName;
      return `[${speaker}] ${message.text}`;
    });
  return [
    `[对话对象]${input.threadName}`,
    `[用户昵称]${input.userName}`,
    "",
    "#用户刚发送的私信",
    input.latestUserText,
    "",
    "#历史私信",
    history.length ? history.join("\n") : "暂无历史私信",
  ].join("\n");
}

async function resolveCharacterAssemblerInput(
  characterId: string,
  appTags: string[],
  context: {
    feedContext?: string;
    userPostContext?: string;
    commentContext?: string;
    mentionContext?: string;
  },
  settings?: XiaohongshuSettings,
): Promise<AssemblerResult | null> {
  const character = loadCharacters().find(item => item.id === characterId);
  if (!character) return null;
  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, "xiaohongshu");
  const apiConfig = activeSlot.apiConfigId
    ? loadApiConfigs().find(config => config.id === activeSlot.apiConfigId) ?? null
    : null;
  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find(item => item.id === activeSlot.presetId) ?? null : null;
  if (!preset) preset = presets.find(item => item.builtIn) ?? null;
  const worldBooks = (activeSlot.worldBookIds || [])
    .map(id => loadWorldBooks().find(book => book.id === id))
    .filter(Boolean) as ReturnType<typeof loadWorldBooks>;
  const regexes = (activeSlot.regexIds || [])
    .map(id => loadRegexes().find(regex => regex.id === id))
    .filter(Boolean) as RegexConfig[];
  const userIdentity = resolveUserIdentity(characterId, "chat");
  const prepared = prepareShortTermContext(characterId, "xiaohongshu");
  const memConfig = loadMemoryConfig();
  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(characterId, prepared.wbActivationContext, memConfig).catch(() => []),
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => []),
  ]);
  const input: AssemblerInput = {
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "xiaohongshu",
    appTags,
    longTermMemories: formatLongTermMemories(memories),
    coreMemories: formatCoreMemories(coreMemories),
    worldBookActivationContext: prepared.wbActivationContext,
    recentBlocks: prepared.recentBlocks,
    unifiedRecentItems: prepared.unifiedRecentItems,
    xiaohongshuBilingualInstruction: buildXiaohongshuBilingualInstruction(settings),
    xiaohongshuFeedContext: context.feedContext ?? "",
    xiaohongshuUserPostContext: context.userPostContext ?? "",
    xiaohongshuCommentContext: context.commentContext ?? "",
    xiaohongshuMentionContext: context.mentionContext ?? "",
  };
  return { character, apiConfig, preset, regexes, input };
}

export async function generateXiaohongshuNpcFeed(
  settings: XiaohongshuSettings,
  followedAccounts: XiaohongshuAccount[] = [],
  userIpLocation = "",
  userXiaohongshuName = "",
): Promise<XiaohongshuNote[]> {
  const apiConfig = resolveGlobalApiConfig();
  if (!apiConfig) throw new ChatEngineError("未配置全局默认 API。");
  const prompt = [
    buildXiaohongshuNpcPrompt(
      settings,
      settings.npcFeedPrompt.trim() || DEFAULT_XIAOHONGSHU_NPC_FEED_PROMPT,
      { userXiaohongshuName },
    ),
    formatNpcFeedUserContext(userIpLocation),
    formatFollowedAccountsForPrompt(followedAccounts),
  ].filter(Boolean).join("\n\n");
  const raw = await sendLLMRequest(
    apiConfig,
    null,
    [{ role: "user", content: prompt, _debugMeta: { marker: "xiaohongshu_npc_feed" } }],
    [],
    { characterName: "小红书NPC内容流" },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "npc_feed"], skipOutputRegex: true },
  );
  const parsed = parseWithDebug(raw, parseXiaohongshuNpcFeed, "无法解析小红书内容");
  const notes = [...parsed.homeNotes, ...parsed.videoNotes, ...parsed.nearbyNotes];
  if (notes.length === 0) throw new XiaohongshuGenerationError("没有解析到小红书笔记。", raw);
  return notes;
}

export async function generateXiaohongshuNpcReactionForUserPost(
  note: XiaohongshuNote,
  settings: XiaohongshuSettings,
): Promise<ParsedXiaohongshuNpcReaction> {
  const apiConfig = resolveGlobalApiConfig();
  if (!apiConfig) throw new ChatEngineError("未配置全局默认 API。");
  const userNames = getUserXiaohongshuNamesFromNote(note);
  const context = [
    buildXiaohongshuNpcPrompt(
      settings,
      settings.npcUserPostReactionPrompt.trim() || DEFAULT_XIAOHONGSHU_NPC_USER_POST_REACTION_PROMPT,
      { userXiaohongshuName: userNames[0], extraReservedNames: userNames },
    ),
    "",
    "<user_xiaohongshu_post>",
    formatXiaohongshuUserPostContext(note),
    "</user_xiaohongshu_post>",
    note.imageAssetId && !note.imageDescription ? "该笔记有真实图片；如果你无法看到图片，请只根据标题、正文、TAG 与已有评论生成互动。" : "",
  ].filter(Boolean).join("\n");
  const imageDataUrl = apiConfig.enableImageRecognition ? await resolveNoteImageDataUrl(note) : null;
  const raw = await sendWithOptionalVisionFallback(
    apiConfig,
    null,
    [makeVisionMessage(context, imageDataUrl)],
    [],
    { characterName: "小红书NPC互动" },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "npc_user_post"], skipOutputRegex: true },
  );
  return parseWithDebug(raw, output => parseXiaohongshuNpcReaction(output, note.id), "无法解析小红书互动内容");
}

export async function generateXiaohongshuCharacterActivity(
  characterId: string,
  notes: XiaohongshuNote[],
  settings?: XiaohongshuSettings,
): Promise<ParsedXiaohongshuCharacterActivity | null> {
  const userNames = getUserXiaohongshuNamesFromNotes(notes);
  const context = userNames.length > 0
    ? prependXiaohongshuUserIdentityHint(
        formatXiaohongshuFeedContext(notes),
        buildXiaohongshuUserIdentityHint({ characterId, xiaohongshuNames: userNames }),
      )
    : formatXiaohongshuFeedContext(notes);
  const resolved = await resolveCharacterAssemblerInput(characterId, ["xiaohongshu", "activity"], {
    feedContext: context,
  }, settings);
  if (!resolved?.apiConfig) return null;
  const messages = assemblePromptPayload(resolved.input);
  const raw = await sendLLMRequest(
    resolved.apiConfig,
    resolved.preset,
    messages,
    resolved.regexes,
    { characterName: `小红书:${resolved.character.name}`, userName: resolved.input.userIdentity?.name },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "activity"] },
  );
  return parseWithDebug(raw, output => parseXiaohongshuCharacterActivity(output, notes.map(note => note.id)), "无法解析小红书角色互动内容");
}

export async function generateXiaohongshuCharacterReactionToUserPost(
  characterId: string,
  note: XiaohongshuNote,
  settings?: XiaohongshuSettings,
): Promise<ParsedXiaohongshuCharacterReaction | null> {
  const context = prependXiaohongshuUserIdentityHint(
    formatXiaohongshuUserPostContext(note),
    buildXiaohongshuUserIdentityHint({ characterId, xiaohongshuNames: getUserXiaohongshuNamesFromNote(note) }),
  );
  const resolved = await resolveCharacterAssemblerInput(characterId, ["xiaohongshu", "reaction"], {
    userPostContext: context,
  }, settings);
  if (!resolved?.apiConfig) return null;
  const messages = assemblePromptPayload(resolved.input);
  const imageDataUrl = resolved.apiConfig.enableImageRecognition ? await resolveNoteImageDataUrl(note) : null;
  if (imageDataUrl) {
    messages.push(makeVisionMessage("这是当前小红书笔记配图。请结合预设中的 {{xiaohongshuUserPostContext}} 判断如何评论。", imageDataUrl));
  }
  const raw = await sendWithOptionalVisionFallback(
    resolved.apiConfig,
    resolved.preset,
    messages,
    resolved.regexes,
    { characterName: `小红书:${resolved.character.name}`, userName: resolved.input.userIdentity?.name },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "reaction"] },
  );
  return parseWithDebug(raw, parseXiaohongshuCharacterReaction, "无法解析小红书角色互动内容");
}

export async function generateXiaohongshuNpcReplyToUserComment(
  note: XiaohongshuNote,
  userComment: XiaohongshuComment,
  settings: XiaohongshuSettings,
  targetComment?: XiaohongshuComment,
): Promise<ParsedXiaohongshuNpcCommentReply> {
  const apiConfig = resolveGlobalApiConfig();
  if (!apiConfig) throw new ChatEngineError("未配置全局默认 API。");
  const commentContext = formatXiaohongshuCommentContext(note, userComment, targetComment);
  const userNames = Array.from(new Set([
    ...getUserXiaohongshuNamesFromNote(note),
    userComment.authorType === "user" ? userComment.authorName : "",
    targetComment?.authorType === "user" ? targetComment.authorName : "",
  ].map(cleanReservedName).filter(Boolean)));
  const prompt = [
    buildXiaohongshuNpcPrompt(
      settings,
      settings.npcCommentReplyPrompt.trim() || DEFAULT_XIAOHONGSHU_NPC_COMMENT_REPLY_PROMPT,
      { userXiaohongshuName: userNames[0], extraReservedNames: userNames },
    ),
    "",
    "<xiaohongshu_comment_context>",
    commentContext,
    "</xiaohongshu_comment_context>",
    note.imageAssetId && !note.imageDescription ? "该笔记有真实图片；如果你无法看到图片，请只根据标题、正文、TAG 与评论区上下文生成回复。" : "",
  ].filter(Boolean).join("\n");
  const imageDataUrl = apiConfig.enableImageRecognition ? await resolveNoteImageDataUrl(note) : null;
  const raw = await sendWithOptionalVisionFallback(
    apiConfig,
    null,
    [makeVisionMessage(prompt, imageDataUrl)],
    [],
    { characterName: "小红书NPC评论回复" },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "npc_comment_reply"], skipOutputRegex: true },
  );
  return parseWithDebug(raw, output => parseXiaohongshuNpcCommentReply(output, note.id, userComment.id), "无法解析小红书评论回复");
}

export async function generateXiaohongshuNpcMoreComments(
  note: XiaohongshuNote,
  settings: XiaohongshuSettings,
): Promise<ParsedXiaohongshuNpcCommentReply> {
  const apiConfig = resolveGlobalApiConfig();
  if (!apiConfig) throw new ChatEngineError("未配置全局默认 API。");
  const commentContext = formatXiaohongshuNoteCommentContext(note);
  const userNames = getUserXiaohongshuNamesFromNote(note);
  const prompt = [
    buildXiaohongshuNpcPrompt(
      settings,
      (settings.npcMoreCommentsPrompt ?? "").trim() || DEFAULT_XIAOHONGSHU_NPC_MORE_COMMENTS_PROMPT,
      { userXiaohongshuName: userNames[0], extraReservedNames: userNames },
    ),
    "",
    "<xiaohongshu_note_comment_context>",
    commentContext,
    "</xiaohongshu_note_comment_context>",
    note.imageAssetId && !note.imageDescription ? "该笔记有真实图片；如果你无法看到图片，请只根据标题、正文、TAG 与评论区上下文生成更多评论。" : "",
  ].filter(Boolean).join("\n");
  const imageDataUrl = apiConfig.enableImageRecognition ? await resolveNoteImageDataUrl(note) : null;
  const raw = await sendWithOptionalVisionFallback(
    apiConfig,
    null,
    [makeVisionMessage(prompt, imageDataUrl)],
    [],
    { characterName: "小红书NPC更多评论" },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "npc_more_comments"], skipOutputRegex: true },
  );
  return parseWithDebug(raw, parseXiaohongshuNpcMoreComments, "无法解析小红书评论内容");
}

export async function generateXiaohongshuNpcDmReply(input: {
  threadName: string;
  userName: string;
  messages: XiaohongshuNotification[];
  latestUserText: string;
  settings: XiaohongshuSettings;
}): Promise<ParsedXiaohongshuNpcDmReply> {
  const apiConfig = resolveGlobalApiConfig();
  if (!apiConfig) throw new ChatEngineError("未配置全局默认 API。");
  const prompt = [
    buildXiaohongshuNpcPrompt(
      input.settings,
      (input.settings.npcDmReplyPrompt ?? "").trim() || DEFAULT_XIAOHONGSHU_NPC_DM_REPLY_PROMPT,
      { userXiaohongshuName: input.userName },
    ),
    "",
    "<xiaohongshu_dm_context>",
    formatXiaohongshuDmContext(input),
    "</xiaohongshu_dm_context>",
  ].join("\n");
  const raw = await sendLLMRequest(
    apiConfig,
    null,
    [{ role: "user", content: prompt, _debugMeta: { marker: "xiaohongshu_npc_dm_reply" } }],
    [],
    { characterName: "小红书NPC私信回复", userName: input.userName },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "npc_dm_reply"], skipOutputRegex: true },
  );
  return parseWithDebug(raw, parseXiaohongshuNpcDmReply, "无法解析小红书私信回复");
}

export async function generateXiaohongshuCharacterReplyToUserComment(
  characterId: string,
  note: XiaohongshuNote,
  userComment: XiaohongshuComment,
  targetComment?: XiaohongshuComment,
  settings?: XiaohongshuSettings,
): Promise<ParsedXiaohongshuCharacterReaction | null> {
  const userNames = collectCleanNames([
    ...getUserXiaohongshuNamesFromNote(note),
    userComment.authorType === "user" ? userComment.authorName : "",
    targetComment?.authorType === "user" ? targetComment.authorName : "",
  ]);
  const commentContext = prependXiaohongshuUserIdentityHint(
    formatXiaohongshuCommentContext(note, userComment, targetComment),
    buildXiaohongshuUserIdentityHint({ characterId, xiaohongshuNames: userNames }),
  );
  const resolved = await resolveCharacterAssemblerInput(characterId, ["xiaohongshu", "comment"], {
    commentContext,
  }, settings);
  if (!resolved?.apiConfig) return null;
  const messages = assemblePromptPayload(resolved.input);
  const imageDataUrl = resolved.apiConfig.enableImageRecognition ? await resolveNoteImageDataUrl(note) : null;
  if (imageDataUrl) {
    messages.push(makeVisionMessage("这是当前小红书笔记的配图。请结合预设中的 {{xiaohongshuCommentContext}} 回复用户评论。", imageDataUrl));
  }
  const raw = await sendWithOptionalVisionFallback(
    resolved.apiConfig,
    resolved.preset,
    messages,
    resolved.regexes,
    { characterName: `小红书:${resolved.character.name}`, userName: resolved.input.userIdentity?.name },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "comment"] },
  );
  return parseWithDebug(raw, parseXiaohongshuCharacterReaction, "无法解析小红书角色回复");
}

export async function generateXiaohongshuCharacterMentionReply(
  characterId: string,
  note: XiaohongshuNote,
  userComment: XiaohongshuComment,
  targetComment?: XiaohongshuComment,
  settings?: XiaohongshuSettings,
): Promise<ParsedXiaohongshuCharacterMentionReply | null> {
  const character = loadCharacters().find(item => item.id === characterId);
  if (!character) return null;
  const userNames = collectCleanNames([
    ...getUserXiaohongshuNamesFromNote(note),
    userComment.authorType === "user" ? userComment.authorName : "",
    targetComment?.authorType === "user" ? targetComment.authorName : "",
  ]);
  const mentionContext = prependXiaohongshuUserIdentityHint(
    formatXiaohongshuMentionContext(note, userComment, character, targetComment),
    buildXiaohongshuUserIdentityHint({ characterId, xiaohongshuNames: userNames }),
  );
  const resolved = await resolveCharacterAssemblerInput(characterId, ["xiaohongshu", "mention"], {
    mentionContext,
  }, settings);
  if (!resolved?.apiConfig) return null;
  const messages = assemblePromptPayload(resolved.input);
  const imageDataUrl = resolved.apiConfig.enableImageRecognition ? await resolveNoteImageDataUrl(note) : null;
  if (imageDataUrl) {
    messages.push(makeVisionMessage("这是当前小红书笔记的配图。请结合预设中的 {{xiaohongshuMentionContext}} 回复 @ 评论。", imageDataUrl));
  }
  const raw = await sendWithOptionalVisionFallback(
    resolved.apiConfig,
    resolved.preset,
    messages,
    resolved.regexes,
    { characterName: `小红书:${resolved.character.name}`, userName: resolved.input.userIdentity?.name },
    { appId: "xiaohongshu", appTags: ["xiaohongshu", "mention"] },
  );
  return parseWithDebug(raw, parseXiaohongshuCharacterMentionReply, "无法解析小红书@回复");
}

export async function previewXiaohongshuPromptPayload(
  characterId: string,
  mode: "activity" | "reaction" | "comment" | "mention",
  notes: XiaohongshuNote[],
  settings?: XiaohongshuSettings,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const firstNote = notes[0];
  const latestComment = firstNote?.comments.slice(-1)[0];
  const character = loadCharacters().find(item => item.id === characterId);
  const withIdentityHint = (context: string, names: string[]) => prependXiaohongshuUserIdentityHint(
    context,
    buildXiaohongshuUserIdentityHint({ characterId, xiaohongshuNames: names }),
  );
  const context = mode === "activity"
    ? {
        feedContext: getUserXiaohongshuNamesFromNotes(notes).length > 0
          ? withIdentityHint(formatXiaohongshuFeedContext(notes), getUserXiaohongshuNamesFromNotes(notes))
          : formatXiaohongshuFeedContext(notes),
      }
    : mode === "reaction"
      ? { userPostContext: firstNote ? withIdentityHint(formatXiaohongshuUserPostContext(firstNote), getUserXiaohongshuNamesFromNote(firstNote)) : "暂无小红书笔记。" }
      : mode === "mention"
        ? {
            mentionContext: firstNote && latestComment && character
              ? withIdentityHint(formatXiaohongshuMentionContext(firstNote, latestComment, character), collectCleanNames([
                  ...getUserXiaohongshuNamesFromNote(firstNote),
                  latestComment.authorType === "user" ? latestComment.authorName : "",
                ]))
              : "暂无可回复的 @ 评论。",
          }
        : {
            commentContext: firstNote && latestComment
              ? withIdentityHint(formatXiaohongshuCommentContext(firstNote, latestComment), collectCleanNames([
                  ...getUserXiaohongshuNamesFromNote(firstNote),
                  latestComment.authorType === "user" ? latestComment.authorName : "",
                ]))
              : "暂无可回复的小红书评论。",
          };
  const resolved = await resolveCharacterAssemblerInput(
    characterId,
    ["xiaohongshu", mode],
    context,
    settings,
  );
  if (!resolved?.apiConfig) throw new ChatEngineError("未配置小红书 API。");
  const messages = assemblePromptPayload(resolved.input);
  if (firstNote && mode !== "activity") {
    const imageDataUrl = resolved.apiConfig.enableImageRecognition ? await resolveNoteImageDataUrl(firstNote) : null;
    if (imageDataUrl) {
      messages.push(makeVisionMessage("这是当前小红书笔记配图。请结合预设中的小红书上下文判断如何回应。", imageDataUrl));
    }
  }
  return {
    messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, messages),
    characterName: `小红书:${resolved.character.name}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "默认预设",
  };
}

export function applyNpcReaction(note: XiaohongshuNote, reaction: ParsedXiaohongshuNpcReaction): {
  note: XiaohongshuNote;
  notifications: ReturnType<typeof makeXiaohongshuNotification>[];
} {
  const shouldNotifyUser = note.source === "user";
  const baseCommentIndex = note.comments.length;
  const comments = reaction.comments
    .filter(comment => comment.text)
    .map((comment, index) => {
      const parsedReplyIndex = /^.*_comment_(\d+)$/.exec(comment.replyToCommentId || "")?.[1];
      const replyToCommentId = parsedReplyIndex
        ? `${note.id}_comment_${baseCommentIndex + Number(parsedReplyIndex)}`
        : comment.replyToCommentId;
      return {
        ...makeXiaohongshuComment({
          noteId: note.id,
          authorType: "npc",
          authorId: "npc",
          authorName: comment.authorName,
          text: comment.text,
          replyTo: comment.replyTo,
          replyToCommentId,
          unread: true,
        }),
        id: `${note.id}_comment_${baseCommentIndex + index + 1}`,
      };
    });
  const updated: XiaohongshuNote = {
    ...note,
    likeCount: note.likeCount + reaction.likeCount,
    saveCount: note.saveCount + reaction.saveCount,
    recentLikeNames: addNames(note.recentLikeNames, reaction.recentLikeNames),
    recentSaveNames: addNames(note.recentSaveNames, reaction.recentSaveNames),
    comments: [...note.comments, ...comments],
    commentCount: note.commentCount + comments.length,
    updatedAt: new Date().toISOString(),
  };
  const notifications = shouldNotifyUser ? [
    reaction.likeCount > 0 ? makeXiaohongshuNotification({
      type: "like",
      noteId: note.id,
      actorName: reaction.recentLikeNames[0] || "小红书用户",
      text: `${reaction.recentLikeNames.join("、") || "有人"}等${reaction.likeCount}人赞了你的笔记`,
      count: reaction.likeCount,
      thumbnailText: note.title,
      unread: true,
    }) : null,
    reaction.saveCount > 0 ? makeXiaohongshuNotification({
      type: "save",
      noteId: note.id,
      actorName: reaction.recentSaveNames[0] || "小红书用户",
      text: `${reaction.recentSaveNames.join("、") || "有人"}等${reaction.saveCount}人收藏了你的笔记`,
      count: reaction.saveCount,
      thumbnailText: note.title,
      unread: true,
    }) : null,
    ...comments.map(comment => makeXiaohongshuNotification({
      type: "comment" as const,
      noteId: note.id,
      actorName: comment.authorName,
      text: comment.text,
      thumbnailText: note.title,
      unread: true,
    })),
    ...reaction.directMessages.map(message => makeXiaohongshuNotification({
      type: "dm" as const,
      noteId: note.id,
      actorName: message.name,
      text: message.text,
      thumbnailText: note.title,
      direction: "incoming" as const,
      threadId: `dm:${message.name}`,
      threadName: message.name,
      unread: true,
    })),
  ].filter((item): item is ReturnType<typeof makeXiaohongshuNotification> => Boolean(item)) : [];
  return { note: updated, notifications };
}

export function applyCharacterReaction(note: XiaohongshuNote, character: Character, reaction: ParsedXiaohongshuCharacterReaction): {
  note: XiaohongshuNote;
  notifications: ReturnType<typeof makeXiaohongshuNotification>[];
  mainComment: XiaohongshuComment;
  threadComments: XiaohongshuComment[];
} {
  const shouldNotifyUser = note.source === "user";
  const displayName = resolveCharacterXiaohongshuDisplayName(character);
  const comment = makeXiaohongshuComment({
    noteId: note.id,
    authorType: "character",
    authorId: character.id,
    authorName: displayName,
    text: reaction.comment,
    unread: shouldNotifyUser,
  });
  const likeIncrement = reaction.liked && !note.recentLikeNames.includes(displayName) ? 1 : 0;
  const saveIncrement = reaction.saved && !note.recentSaveNames.includes(displayName) ? 1 : 0;
  let updated: XiaohongshuNote = {
    ...note,
    likeCount: note.likeCount + likeIncrement,
    saveCount: note.saveCount + saveIncrement,
    recentLikeNames: reaction.liked ? addNames(note.recentLikeNames, [displayName]) : note.recentLikeNames,
    recentSaveNames: reaction.saved ? addNames(note.recentSaveNames, [displayName]) : note.recentSaveNames,
    comments: comment.text ? [...note.comments, comment] : note.comments,
    commentCount: note.commentCount + (comment.text ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  let threadNotifications: ReturnType<typeof makeXiaohongshuNotification>[] = [];
  let threadComments: XiaohongshuComment[] = [];
  if (comment.text && reaction.thread && reaction.thread.length > 0) {
    const result = appendCharacterThreadToNote({
      note: updated,
      characterDisplayName: displayName,
      characterName: character.name,
      characterId: character.id,
      thread: reaction.thread,
      mainCommentId: comment.id,
      shouldNotifyUser,
    });
    updated = result.note;
    threadNotifications = result.notifications;
    threadComments = result.appended;
  }
  const notifications = shouldNotifyUser ? [
    reaction.liked ? makeXiaohongshuNotification({
      type: "like",
      noteId: note.id,
      actorName: displayName,
      text: `${displayName} 赞了你的笔记`,
      count: 1,
      thumbnailText: note.title,
      unread: true,
    }) : null,
    reaction.saved ? makeXiaohongshuNotification({
      type: "save",
      noteId: note.id,
      actorName: displayName,
      text: `${displayName} 收藏了你的笔记`,
      count: 1,
      thumbnailText: note.title,
      unread: true,
    }) : null,
    comment.text ? makeXiaohongshuNotification({
      type: "comment",
      noteId: note.id,
      actorName: displayName,
      text: comment.text,
      thumbnailText: note.title,
      unread: true,
    }) : null,
  ].filter((item): item is ReturnType<typeof makeXiaohongshuNotification> => Boolean(item)) : [];
  return { note: updated, notifications: [...notifications, ...threadNotifications], mainComment: comment, threadComments };
}

export function applyNpcCommentReply(note: XiaohongshuNote, reaction: ParsedXiaohongshuNpcCommentReply, fallbackReplyToCommentId: string): {
  note: XiaohongshuNote;
  notifications: ReturnType<typeof makeXiaohongshuNotification>[];
} {
  const shouldNotifyUser = note.source === "user";
  const comments = reaction.comments
    .filter(comment => comment.text)
    .map(comment => makeXiaohongshuComment({
      noteId: note.id,
      authorType: "npc",
      authorId: "npc",
      authorName: comment.authorName,
      text: comment.text,
      replyTo: comment.replyTo,
      replyToCommentId: comment.replyToCommentId || fallbackReplyToCommentId,
      unread: true,
    }));
  const updated: XiaohongshuNote = {
    ...note,
    comments: [...note.comments, ...comments],
    commentCount: note.commentCount + comments.length,
    updatedAt: new Date().toISOString(),
  };
  const notifications = shouldNotifyUser ? comments.map(comment => makeXiaohongshuNotification({
    type: "comment" as const,
    noteId: note.id,
    actorName: comment.authorName,
    text: comment.text,
    thumbnailText: note.title,
    unread: true,
  })) : [];
  return { note: updated, notifications };
}

export function applyNpcMoreComments(note: XiaohongshuNote, reaction: ParsedXiaohongshuNpcCommentReply): XiaohongshuNote {
  const baseCommentIndex = note.comments.length;
  const comments = reaction.comments
    .filter(comment => comment.text)
    .map((comment, index) => {
      const generatedReplyIndex = /^__generated_comment_(\d+)$/.exec(comment.replyToCommentId || "")?.[1];
      return {
        ...makeXiaohongshuComment({
          noteId: note.id,
          authorType: "npc",
          authorId: makeXiaohongshuNpcId(comment.authorName),
          authorName: comment.authorName,
          text: comment.text,
          replyTo: comment.replyTo,
          replyToCommentId: generatedReplyIndex
            ? `${note.id}_comment_${baseCommentIndex + Number(generatedReplyIndex)}`
            : comment.replyToCommentId,
        }),
        id: `${note.id}_comment_${baseCommentIndex + index + 1}`,
      };
    });
  return {
    ...note,
    comments: [...note.comments, ...comments],
    commentCount: note.commentCount + comments.length,
    updatedAt: new Date().toISOString(),
  };
}

export function applyCharacterCommentReply(note: XiaohongshuNote, character: Character, reaction: ParsedXiaohongshuCharacterReaction, replyToCommentId: string): {
  note: XiaohongshuNote;
  notifications: ReturnType<typeof makeXiaohongshuNotification>[];
  mainComment: XiaohongshuComment;
  threadComments: XiaohongshuComment[];
} {
  const shouldNotifyUser = note.source === "user";
  const displayName = resolveCharacterXiaohongshuDisplayName(character);
  const comment = makeXiaohongshuComment({
    noteId: note.id,
    authorType: "character",
    authorId: character.id,
    authorName: displayName,
    text: reaction.comment,
    replyToCommentId,
    unread: shouldNotifyUser,
  });
  const likeIncrement = reaction.liked && !note.recentLikeNames.includes(displayName) ? 1 : 0;
  const saveIncrement = reaction.saved && !note.recentSaveNames.includes(displayName) ? 1 : 0;
  let updated: XiaohongshuNote = {
    ...note,
    likeCount: note.likeCount + likeIncrement,
    saveCount: note.saveCount + saveIncrement,
    recentLikeNames: reaction.liked ? addNames(note.recentLikeNames, [displayName]) : note.recentLikeNames,
    recentSaveNames: reaction.saved ? addNames(note.recentSaveNames, [displayName]) : note.recentSaveNames,
    comments: comment.text ? [...note.comments, comment] : note.comments,
    commentCount: note.commentCount + (comment.text ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  let threadNotifications: ReturnType<typeof makeXiaohongshuNotification>[] = [];
  let threadComments: XiaohongshuComment[] = [];
  if (comment.text && reaction.thread && reaction.thread.length > 0) {
    const result = appendCharacterThreadToNote({
      note: updated,
      characterDisplayName: displayName,
      characterName: character.name,
      characterId: character.id,
      thread: reaction.thread,
      mainCommentId: comment.id,
      shouldNotifyUser,
    });
    updated = result.note;
    threadNotifications = result.notifications;
    threadComments = result.appended;
  }
  const notifications = shouldNotifyUser ? [
    reaction.liked ? makeXiaohongshuNotification({
      type: "like",
      noteId: note.id,
      actorName: displayName,
      text: `${displayName} 赞了这篇笔记`,
      count: 1,
      thumbnailText: note.title,
      unread: true,
    }) : null,
    reaction.saved ? makeXiaohongshuNotification({
      type: "save",
      noteId: note.id,
      actorName: displayName,
      text: `${displayName} 收藏了这篇笔记`,
      count: 1,
      thumbnailText: note.title,
      unread: true,
    }) : null,
    comment.text ? makeXiaohongshuNotification({
      type: "comment",
      noteId: note.id,
      actorName: displayName,
      text: comment.text,
      thumbnailText: note.title,
      unread: true,
    }) : null,
  ].filter((item): item is ReturnType<typeof makeXiaohongshuNotification> => Boolean(item)) : [];
  return { note: updated, notifications: [...notifications, ...threadNotifications], mainComment: comment, threadComments };
}

/**
 * 应用 Activity 里"角色评论别人帖子"的单条评论 + 可选延伸 thread。
 * - 主评论永远是角色本人评论
 * - 如果 thread 存在，把延伸评论按楼中楼关系挂在主评论下
 * - 返回新增的所有评论（主评论 + thread 评论）供调用方记录记忆/通知
 */
export function applyCharacterActivityComment(args: {
  note: XiaohongshuNote;
  character: Character;
  text: string;
  liked: boolean;
  saved: boolean;
  thread?: ParsedXiaohongshuCharacterThreadItem[];
}): {
  note: XiaohongshuNote;
  mainComment: XiaohongshuComment;
  threadComments: XiaohongshuComment[];
  notifications: ReturnType<typeof makeXiaohongshuNotification>[];
} {
  const { note, character, text, liked, saved, thread } = args;
  const displayName = resolveCharacterXiaohongshuDisplayName(character);
  const shouldNotifyUser = note.source === "user";
  const mainComment = makeXiaohongshuComment({
    noteId: note.id,
    authorType: "character",
    authorId: character.id,
    authorName: displayName,
    text,
    unread: shouldNotifyUser,
  });
  let updated: XiaohongshuNote = {
    ...note,
    likeCount: note.likeCount + (liked && !note.recentLikeNames.includes(displayName) ? 1 : 0),
    saveCount: note.saveCount + (saved && !note.recentSaveNames.includes(displayName) ? 1 : 0),
    recentLikeNames: liked ? addNames(note.recentLikeNames, [displayName]) : note.recentLikeNames,
    recentSaveNames: saved ? addNames(note.recentSaveNames, [displayName]) : note.recentSaveNames,
    comments: [...note.comments, mainComment],
    commentCount: note.commentCount + 1,
    updatedAt: new Date().toISOString(),
  };
  let threadComments: XiaohongshuComment[] = [];
  let threadNotifications: ReturnType<typeof makeXiaohongshuNotification>[] = [];
  if (thread && thread.length > 0) {
    const result = appendCharacterThreadToNote({
      note: updated,
      characterDisplayName: displayName,
      characterName: character.name,
      characterId: character.id,
      thread,
      mainCommentId: mainComment.id,
      shouldNotifyUser,
    });
    updated = result.note;
    threadComments = result.appended;
    threadNotifications = result.notifications;
  }
  const mainNotifications = shouldNotifyUser ? [
    liked && !note.recentLikeNames.includes(displayName) ? makeXiaohongshuNotification({
      type: "like" as const,
      noteId: note.id,
      actorName: displayName,
      text: `${displayName} 赞了你的笔记`,
      count: 1,
      thumbnailText: note.title,
      unread: true,
    }) : null,
    saved && !note.recentSaveNames.includes(displayName) ? makeXiaohongshuNotification({
      type: "save" as const,
      noteId: note.id,
      actorName: displayName,
      text: `${displayName} 收藏了你的笔记`,
      count: 1,
      thumbnailText: note.title,
      unread: true,
    }) : null,
    makeXiaohongshuNotification({
      type: "comment" as const,
      noteId: note.id,
      actorName: displayName,
      text,
      thumbnailText: note.title,
      unread: true,
    }),
  ].filter((item): item is ReturnType<typeof makeXiaohongshuNotification> => Boolean(item)) : [];
  return {
    note: updated,
    mainComment,
    threadComments,
    notifications: [...mainNotifications, ...threadNotifications],
  };
}

export function applyCharacterMentionReply(note: XiaohongshuNote, character: Character, reaction: ParsedXiaohongshuCharacterMentionReply, replyToCommentId: string): {
  note: XiaohongshuNote;
  notifications: ReturnType<typeof makeXiaohongshuNotification>[];
  mainComment: XiaohongshuComment;
  threadComments: XiaohongshuComment[];
} {
  const shouldNotifyUser = note.source === "user";
  const displayName = resolveCharacterXiaohongshuDisplayName(character);
  const comment = makeXiaohongshuComment({
    noteId: note.id,
    authorType: "character",
    authorId: character.id,
    authorName: displayName,
    text: reaction.comment,
    replyToCommentId,
    unread: shouldNotifyUser,
  });
  let updated: XiaohongshuNote = {
    ...note,
    comments: comment.text ? [...note.comments, comment] : note.comments,
    commentCount: note.commentCount + (comment.text ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  let threadNotifications: ReturnType<typeof makeXiaohongshuNotification>[] = [];
  let threadComments: XiaohongshuComment[] = [];
  if (comment.text && reaction.thread && reaction.thread.length > 0) {
    const result = appendCharacterThreadToNote({
      note: updated,
      characterDisplayName: displayName,
      characterName: character.name,
      characterId: character.id,
      thread: reaction.thread,
      mainCommentId: comment.id,
      shouldNotifyUser,
    });
    updated = result.note;
    threadNotifications = result.notifications;
    threadComments = result.appended;
  }
  const notifications = shouldNotifyUser ? [
    comment.text ? makeXiaohongshuNotification({
      type: "comment",
      noteId: note.id,
      actorName: displayName,
      text: comment.text,
      thumbnailText: note.title,
      unread: true,
    }) : null,
  ].filter((item): item is ReturnType<typeof makeXiaohongshuNotification> => Boolean(item)) : [];
  return { note: updated, notifications: [...notifications, ...threadNotifications], mainComment: comment, threadComments };
}
