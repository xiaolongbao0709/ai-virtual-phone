import { loadCharacters } from "./character-storage";
import { normalizeBilingualTextInput, splitBilingualText } from "./bilingual-text";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { getChatMessagePreview, loadChatMessages, loadChatSessions, type ChatMessage, type ChatSession } from "./chat-storage";
import {
  CHECKPHONE_APP_SPECS,
  type CheckPhoneAssetsPayload,
  type CheckPhoneBilibiliPayload,
  type CheckPhoneBrowserPayload,
  type CheckPhoneDouyinComment,
  type CheckPhoneChatPayload,
  type CheckPhoneDouyinPayload,
  type CheckPhoneDouyinTone,
  type CheckPhoneDoubanActivityType,
  type CheckPhoneDoubanPayload,
  type CheckPhoneEmailPayload,
  type CheckPhoneInstagramPayload,
  type CheckPhoneRedditPayload,
  type CheckPhoneSteamPayload,
  type CheckPhoneTakeoutCategory,
  type CheckPhoneTakeoutPayload,
  type CheckPhoneXPayload,
  type CheckPhoneYoutubePayload,
  CHECKPHONE_DOCK_APP_IDS,
  CHECKPHONE_FIXED_APP_IDS,
  getCheckPhonePromptTags,
  type CheckPhoneMessagesPayload,
  type CheckPhoneMessageThread,
  type CheckPhoneMusicPayload,
  type CheckPhoneNotesPayload,
  type CheckPhonePhonePayload,
  type CheckPhonePhotoItem,
  type CheckPhonePhotosPayload,
  type CheckPhoneReadingPayload,
  type CheckPhoneShoppingPayload,
  type CheckPhoneTelegramPayload,
  type CheckPhoneWeiboPayload,
  type CheckPhoneXiaohongshuPayload,
  CHECKPHONE_OPTIONAL_POOL_APP_IDS,
  CHECKPHONE_OPTIONAL_SELECTION_COUNT,
  CHECKPHONE_TOP_APP_COUNT,
  formatCheckPhoneOptionalPoolText,
  isCheckPhoneAppId,
  type CheckPhoneAppId,
  type CheckPhoneManifest,
} from "./checkphone-config";
import { formatChatUiTime } from "./chat-time";
import {
  normalizeJsonTypography,
  parseJsonWithRepair,
  sanitizeGenericJsonCandidate,
  stripJsonWrapperNoise,
} from "./checkphone-json-repair";
import type { LLMMessage } from "./llm-prompt-assembler";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { getAllPosts, loadMomentComments } from "./moments-storage";
import {
  canCharacterSeeMomentPost,
  getVisibleMomentCommentsForCharacter,
  getVisibleMomentLikesForCharacter,
} from "./character-world-storage";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import {
  loadApiConfigs,
  loadBindingConfig,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { DEFAULT_CHECKPHONE_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";
import { loadCheckPhoneSettings } from "./checkphone-settings";
import { prepareShortTermContext } from "./short-term-assembler";
import { loadPhoneSnapshot } from "./checkphone-storage";

function buildCheckPhoneBilingualInstruction(enabled: boolean, customPrompt?: string): string {
  const prompt = resolveBilingualPrompt(enabled, customPrompt, DEFAULT_CHECKPHONE_BILINGUAL_PROMPT);
  if (!prompt) return "";
  return [
    "<checkphone_bilingual_text_instruction>",
    prompt,
    "</checkphone_bilingual_text_instruction>",
  ].join("\n");
}

function resolveCheckPhoneConfigs(characterId: string): {
  apiConfig: ApiConfig | null;
  preset: PresetConfig | null;
  worldBooks: WorldBookConfig[];
  regexes: RegexConfig[];
} {
  const binding = resolveBinding(loadBindingConfig(), characterId, "checkphone");
  const apiConfigs = loadApiConfigs();
  const presets = loadPresets();
  const allWorldBooks = loadWorldBooks();
  const allRegexes = loadRegexes();

  const apiConfig = apiConfigs.find((item) => item.id === binding.apiConfigId) ?? apiConfigs[0] ?? null;
  const preset = presets.find((item) => item.id === binding.presetId) ?? presets[0] ?? null;
  const worldBooks = (binding.worldBookIds ?? [])
    .map((id) => allWorldBooks.find((item) => item.id === id))
    .filter(Boolean) as WorldBookConfig[];
  const regexes = (binding.regexIds ?? [])
    .map((id) => allRegexes.find((item) => item.id === id))
    .filter(Boolean) as RegexConfig[];

  return { apiConfig, preset, worldBooks, regexes };
}

async function buildCheckPhoneManifestMessages(
  characterId: string,
  preset: PresetConfig | null,
  worldBooks: WorldBookConfig[],
  regexes: RegexConfig[],
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) throw new Error("角色不存在");

  const userIdentity = resolveUserIdentity(characterId, "checkphone");
  const settings = loadCheckPhoneSettings();
  const memConfig = loadMemoryConfig();
  const { recentBlocks, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "checkphone", {
    userName: userIdentity?.name ?? "用户",
    history: [],
  });

  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
  ]);

  return assemblePromptPayload({
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "checkphone",
    appTags: getCheckPhonePromptTags("manifest"),
    scheduleSummary: buildCalendarScheduleMarker("character", characterId, getWeekStartIso(new Date())),
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks,
    unifiedRecentItems,
    checkPhoneBilingualInstruction: buildCheckPhoneBilingualInstruction(
      settings.bilingualTranslationEnabled,
      settings.bilingualTranslationPrompt,
    ),
  });
}

const CHECKPHONE_COMMON_TEXT_FIELD_KEYS = [
  "headerTitle",
  "headerSubtitle",
  "displayName",
  "summary",
  "title",
  "subtitle",
  "body",
  "text",
  "preview",
  "imageDescription",
  "note",
  "author",
  "authorName",
  "authorBadge",
  "sender",
  "name",
  "handle",
  "bio",
  "tagLabel",
  "relationLabel",
  "recentLabel",
  "timeLabel",
  "updatedLabel",
  "durationLabel",
  "progressLabel",
  "chapterLabel",
  "quote",
  "coverIcon",
  "mediaIcon",
  "previewIcon",
  "albumTitle",
  "searchHint",
  "urlLabel",
  "snippet",
  "categoryLabel",
  "locationLabel",
  "shotAtLabel",
  "description",
  "moodLabel",
  "listeningMood",
  "monthlyMinutesLabel",
  "topArtistLabel",
  "heatLabel",
  "curatorNote",
  "totalLabel",
  "totalAmount",
  "deltaLabel",
  "deltaAmount",
  "periodLabel",
  "bankLabel",
  "maskedNumber",
  "balance",
  "detail",
  "accentLabel",
  "transcript",
];

function parseCheckPhoneJson(
  rawOutput: string,
  options?: { textFieldKeys?: string[]; sanitizeCandidate?: (text: string) => string },
) {
  const textFieldKeys = Array.from(
    new Set([...(options?.textFieldKeys ?? []), ...CHECKPHONE_COMMON_TEXT_FIELD_KEYS]),
  );
  return parseJsonWithRepair(rawOutput, {
    textFieldKeys,
    sanitizeCandidate: options?.sanitizeCandidate,
  });
}

function sanitizeReadingJsonCandidate(text: string): string {
  let source = normalizeJsonTypography(stripJsonWrapperNoise(text));

  // Fix duplicated quotes around whole string values:
  // "quote": ""xxx""
  source = source.replace(/(:\s*)""([^"\n]+)""/g, '$1"$2"');

  // Fix cases like: "quote": "上号":广义上...
  source = source.replace(/(:\s*)"([^"\n]+)"\s*:\s*([^"\n]+)"/g, (_m, prefix, head, tail) => {
    return `${prefix}"${head}: ${tail}"`;
  });

  // Fix early-closed strings in long text fields:
  // "summary": "答案是42"。人生指南……
  source = source.replace(
    /("(?:headerSubtitle|summary|quote|note|body|progressLabel|title)"\s*:\s*)"([^"\n]*)"([^"\n]*?)",/g,
    (_m, prefix, head, tail) => `${prefix}"${head}${tail}",`,
  );

  // Fix text fields that start with an extra quoted phrase:
  // "body": ""轻轻松松"。好难……
  source = source.replace(
    /("(?:headerSubtitle|summary|quote|note|body|progressLabel|title)"\s*:\s*)""([^"\n]+)"([^"\n]*?)",/g,
    (_m, prefix, head, tail) => `${prefix}"${head}${tail}",`,
  );

  // Fix missing title key lines inside book objects:
  // "id": "book_2",
  // "夜航西飞",
  // "author": "..."
  source = source.replace(
    /(\n\s*"id"\s*:\s*"[^"]+"\s*,\n)(\s*)"([^"\n]+)"\s*,(\n\s*"author"\s*:)/g,
    '$1$2"title": "$3",$4',
  );

  return source;
}

function sanitizeMusicJsonCandidate(text: string): string {
  return sanitizeGenericJsonCandidate(text, {
    textFieldKeys: [
      "headerTitle",
      "nickname",
      "listeningMood",
      "monthlyMinutesLabel",
      "topArtistLabel",
      "title",
      "artist",
      "albumTitle",
      "coverIcon",
      "durationLabel",
      "note",
      "innerThought",
      "subtitle",
      "curatorNote",
    ],
  });
}

function sanitizeWeiboJsonCandidate(text: string): string {
  return sanitizeGenericJsonCandidate(text, {
    textFieldKeys: [
      "headerTitle",
      "headerSubtitle",
      "name",
      "handle",
      "bio",
      "authorName",
      "authorBadge",
      "body",
      "mediaIcon",
      "title",
      "heatLabel",
      "summary",
      "tagLabel",
      "text",
      "timeLabel",
    ],
  });
}

function uniqueAppIds(ids: string[]): CheckPhoneAppId[] {
  const seen = new Set<CheckPhoneAppId>();
  const result: CheckPhoneAppId[] = [];
  for (const id of ids) {
    if (!isCheckPhoneAppId(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeManifest(characterId: string, payload: unknown): CheckPhoneManifest | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const optionalRaw = Array.isArray(record.optionalAppIds) ? record.optionalAppIds.map(String) : [];
  const topRaw = Array.isArray(record.topAppIds) ? record.topAppIds.map(String) : [];

  const optional = uniqueAppIds(optionalRaw).filter((id) => CHECKPHONE_OPTIONAL_POOL_APP_IDS.includes(id));
  for (const id of CHECKPHONE_OPTIONAL_POOL_APP_IDS) {
    if (optional.length >= CHECKPHONE_OPTIONAL_SELECTION_COUNT) break;
    if (!optional.includes(id)) optional.push(id);
  }
  if (optional.length !== CHECKPHONE_OPTIONAL_SELECTION_COUNT) return null;

  const allowedTop = new Set<CheckPhoneAppId>([...CHECKPHONE_FIXED_APP_IDS, ...optional]);
  const top = uniqueAppIds(topRaw).filter((id) => allowedTop.has(id));
  const dedupedTop = [
    ...CHECKPHONE_FIXED_APP_IDS.filter((id) => top.includes(id)),
    ...CHECKPHONE_FIXED_APP_IDS.filter((id) => !top.includes(id)),
    ...top.filter((id) => !CHECKPHONE_FIXED_APP_IDS.includes(id)),
  ];
  for (const id of optional) {
    if (!dedupedTop.includes(id)) dedupedTop.push(id);
  }
  const normalizedTop = dedupedTop.slice(0, CHECKPHONE_TOP_APP_COUNT);
  if (normalizedTop.length !== CHECKPHONE_TOP_APP_COUNT) return null;

  const now = new Date().toISOString();
  return {
    characterId,
    dockAppIds: [...CHECKPHONE_DOCK_APP_IDS],
    fixedAppIds: [...CHECKPHONE_FIXED_APP_IDS],
    optionalAppIds: optional,
    topAppIds: normalizedTop,
    allAppIds: [...normalizedTop, ...CHECKPHONE_DOCK_APP_IDS],
    generatedAt: now,
    updatedAt: now,
  };
}

export async function generateCheckPhoneManifest(
  characterId: string,
): Promise<{ manifest: CheckPhoneManifest | null; error?: string; debugRawOutput?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { manifest: null, error: "未找到可用的 API 配置", debugRawOutput: "" };

  try {
    const messages = await buildCheckPhoneManifestMessages(characterId, preset, worldBooks, regexes);
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_manifest" },
    );

    if (!rawOutput?.trim()) return { manifest: null, error: "LLM 返回为空", debugRawOutput: rawOutput ?? "" };
    const { parsed } = parseCheckPhoneJson(rawOutput);
    const manifest = normalizeManifest(characterId, parsed);
    if (!manifest) {
      return { manifest: null, error: "无法解析桌面安装清单", debugRawOutput: rawOutput };
    }
    return { manifest, debugRawOutput: rawOutput };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { manifest: null, error: message, debugRawOutput: "" };
  }
}

export async function previewCheckPhonePromptPayload(
  characterId: string,
  targetAppId: CheckPhoneAppId | "manifest",
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) throw new Error("未找到可用的 API 配置");
  const character = loadCharacters().find((item) => item.id === characterId);
  const snapshot = targetAppId === "manifest"
    ? null
    : await loadPhoneSnapshot(characterId, targetAppId);
  const snapshotSummary = targetAppId === "chat"
    ? [
        formatRealChatSnapshotForPrompt(buildRealCheckPhoneChatPayload(characterId)),
        snapshot?.payload ? "\n[上次完整快照摘要]\n" + formatSnapshotSummary(snapshot.payload) : "",
      ].filter(Boolean).join("\n")
    : snapshot?.payload
      ? formatSnapshotSummary(snapshot.payload)
      : "";
  const messages = targetAppId === "manifest"
    ? await buildCheckPhoneManifestMessages(characterId, preset, worldBooks, regexes)
    : await buildCheckPhoneAppMessages(characterId, targetAppId, preset, worldBooks, regexes, {
        snapshotSummary,
        lastRefreshAt: snapshot?.updatedAt ?? "",
      });
  return {
    messages: previewMessagesForApi(apiConfig, preset, messages),
    characterName: `查手机:${character?.name ?? characterId}`,
    model: apiConfig.defaultModel,
    presetName: preset?.name ?? "默认预设",
  };
}

export function formatCheckPhoneManifestSummary(manifest: CheckPhoneManifest): string {
  const topLabels = manifest.topAppIds.map((id) => CHECKPHONE_APP_SPECS[id].label).join("、");
  const optionalLabels = manifest.optionalAppIds.map((id) => CHECKPHONE_APP_SPECS[id].label).join("、");
  return [
    `DOCK：${CHECKPHONE_DOCK_APP_IDS.map((id) => CHECKPHONE_APP_SPECS[id].label).join("、")}`,
    `上方固定：${CHECKPHONE_FIXED_APP_IDS.map((id) => CHECKPHONE_APP_SPECS[id].label).join("、")}`,
    `可选安装：${optionalLabels}`,
    `桌面顺序：${topLabels}`,
  ].join("\n");
}

export const CHECKPHONE_MANIFEST_OPTIONAL_POOL_TEXT = formatCheckPhoneOptionalPoolText();

function formatSnapshotSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.notes)) {
    return record.notes
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const note = item as Record<string, unknown>;
        const title = typeof note.title === "string" ? note.title.trim() : "";
        const preview = typeof note.preview === "string" ? note.preview.trim() : "";
        return [title, preview].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 6)
      .join("\n");
  }
  if (Array.isArray(record.emails)) {
    return record.emails
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const email = item as Record<string, unknown>;
        const senderName = typeof email.senderName === "string" ? email.senderName.trim() : "";
        const subject = typeof email.subject === "string" ? email.subject.trim() : "";
        const preview = typeof email.preview === "string" ? email.preview.trim() : "";
        return [[senderName, subject].filter(Boolean).join(" · "), preview].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 8)
      .join("\n");
  }
  if (Array.isArray(record.orders)) {
    return record.orders
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const order = item as Record<string, unknown>;
        const shopName = typeof order.shopName === "string" ? order.shopName.trim() : "";
        const scenario = typeof order.scenario === "string" ? order.scenario.trim() : "";
        return [shopName, scenario].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 8)
      .join("\n");
  }
  if (Array.isArray(record.threads)) {
    return record.threads
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const thread = item as Record<string, unknown>;
        const sender = typeof thread.sender === "string" ? thread.sender.trim() : "";
        const preview = typeof thread.preview === "string" ? thread.preview.trim() : "";
        return [sender, preview].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 6)
      .join("\n");
  }
  if (record.profile && Array.isArray(record.recentlyPlayed) && Array.isArray(record.wishlist) && Array.isArray(record.library)) {
    const profile = record.profile as Record<string, unknown>;
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    const recentSummary = record.recentlyPlayed
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const game = item as Record<string, unknown>;
        const title = typeof game.title === "string" ? game.title.trim() : "";
        const status = typeof game.status === "string" ? game.status.trim() : "";
        return [title, status].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 4);
    return [name, ...recentSummary].filter(Boolean).join("\n");
  }
  if (Array.isArray(record.watchHistory) && Array.isArray(record.favorites)) {
    const historySummary = record.watchHistory
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const video = item as Record<string, unknown>;
        const title = typeof video.title === "string" ? video.title.trim() : "";
        const feeling = typeof video.feeling === "string" ? video.feeling.trim() : "";
        return [title, feeling].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 4);
    return historySummary.filter(Boolean).join("\n");
  }
  if (Array.isArray(record.watchHistory) && Array.isArray(record.watchLater) && Array.isArray(record.likedVideos)) {
    const historySummary = record.watchHistory
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const video = item as Record<string, unknown>;
        const title = typeof video.title === "string" ? video.title.trim() : "";
        const feeling = typeof video.feeling === "string" ? video.feeling.trim() : "";
        return [title, feeling].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 4);
    return historySummary.filter(Boolean).join("\n");
  }
  if (record.profile && Array.isArray(record.posts) && Array.isArray(record.replies) && Array.isArray(record.likes)) {
    const profile = record.profile as Record<string, unknown>;
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    const postSummary = record.posts
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const post = item as Record<string, unknown>;
        const body = typeof post.body === "string" ? post.body.trim() : "";
        return body.split(/\r?\n/)[0]?.trim() || "";
      })
      .filter(Boolean)
      .slice(0, 4);
    return [name, ...postSummary].filter(Boolean).join("\n");
  }
  if (record.profile && Array.isArray(record.posts) && Array.isArray(record.comments)) {
    const profile = record.profile as Record<string, unknown>;
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    const postSummary = record.posts
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const post = item as Record<string, unknown>;
        const title = typeof post.title === "string" ? post.title.trim() : "";
        const innerThought = typeof post.innerThought === "string" ? post.innerThought.trim() : "";
        return [title, innerThought].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 4);
    return [name, ...postSummary].filter(Boolean).join("\n");
  }
  if (record.profile && Array.isArray(record.posts)) {
    const profile = record.profile as Record<string, unknown>;
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    const postSummary = record.posts
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const post = item as Record<string, unknown>;
        const caption = typeof post.caption === "string" ? post.caption.trim() : "";
        return caption.split(/\r?\n/)[0]?.trim() || "";
      })
      .filter(Boolean)
      .slice(0, 4);
    return [name, ...postSummary].filter(Boolean).join("\n");
  }
  if (Array.isArray(record.threads) && record.threads.some((item) => item && typeof item === "object" && "title" in (item as Record<string, unknown>))) {
    return record.threads
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const thread = item as Record<string, unknown>;
        const title = typeof thread.title === "string" ? thread.title.trim() : "";
        const messages = Array.isArray(thread.messages) ? thread.messages : [];
        const last = messages[messages.length - 1];
        const preview = last && typeof last === "object" && typeof (last as Record<string, unknown>).text === "string"
          ? ((last as Record<string, unknown>).text as string).trim()
          : "";
        return [title, preview].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 8)
      .join("\n");
  }
  if (Array.isArray(record.myGroups) && Array.isArray(record.repliedTopics) && Array.isArray(record.publishedTopics)) {
    const groupSummary = record.myGroups
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const entry = item as Record<string, unknown>;
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        const latestUpdate = typeof entry.latestUpdate === "string" ? entry.latestUpdate.trim() : "";
        return [name, latestUpdate].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 3);
    const topicSummary = record.repliedTopics
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const entry = item as Record<string, unknown>;
        const title = typeof entry.title === "string" ? entry.title.trim() : "";
        const groupName = typeof entry.groupName === "string" ? entry.groupName.trim() : "";
        return [title, groupName].filter(Boolean).join(" · ");
      })
      .filter(Boolean)
      .slice(0, 3);
    return [...groupSummary, ...topicSummary].filter(Boolean).join("\n");
  }
  if (Array.isArray(record.threads)) {
    return record.threads
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const thread = item as Record<string, unknown>;
        const sender = typeof thread.sender === "string" ? thread.sender.trim() : "";
        const preview = typeof thread.preview === "string" ? thread.preview.trim() : "";
        return [sender, preview].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 8)
      .join("\n");
  }
  if (record.profile && Array.isArray(record.works) && Array.isArray(record.savedVideos) && Array.isArray(record.likedVideos)) {
    const videoSummary = [...record.works, ...record.savedVideos, ...record.likedVideos]
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const video = item as Record<string, unknown>;
        const title = typeof video.title === "string" ? video.title.trim() : "";
        const caption = typeof video.caption === "string" ? video.caption.trim() : "";
        return [title, caption].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 6);
    return videoSummary.join("\n");
  }
  if (Array.isArray(record.history) || Array.isArray(record.bookmarks)) {
    const historySummary = Array.isArray(record.history)
      ? record.history
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const entry = item as Record<string, unknown>;
            const title = typeof entry.title === "string" ? entry.title.trim() : "";
            const content = typeof entry.content === "string" ? entry.content.trim() : "";
            return [title, content].filter(Boolean).join("：");
          })
          .filter(Boolean)
          .slice(0, 4)
      : [];
    const bookmarkSummary = Array.isArray(record.bookmarks)
      ? record.bookmarks
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const entry = item as Record<string, unknown>;
            const title = typeof entry.title === "string" ? entry.title.trim() : "";
            const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
            return [title, reason].filter(Boolean).join("：");
          })
          .filter(Boolean)
          .slice(0, 3)
      : [];
    return [...historySummary, ...bookmarkSummary].join("\n");
  }
  if (Array.isArray(record.albums) || Array.isArray(record.photos)) {
    const albumSummary = Array.isArray(record.albums)
      ? record.albums
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const album = item as Record<string, unknown>;
            const title = typeof album.title === "string" ? album.title.trim() : "";
            const moodLabel = typeof album.moodLabel === "string" ? album.moodLabel.trim() : "";
            return [title, moodLabel].filter(Boolean).join(" · ");
          })
          .filter(Boolean)
          .slice(0, 4)
      : [];
    const photoSummary = Array.isArray(record.photos)
      ? record.photos
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const photo = item as Record<string, unknown>;
            const title = typeof photo.title === "string" ? photo.title.trim() : "";
            const description = typeof photo.description === "string" ? photo.description.trim() : "";
            return [title, description].filter(Boolean).join("：");
          })
          .filter(Boolean)
          .slice(0, 4)
      : [];
    return [...albumSummary, ...photoSummary].join("\n");
  }
  if (
    Array.isArray(record.conversations) &&
    Array.isArray(record.groups) &&
    Array.isArray(record.momentsFeed) &&
    Array.isArray(record.contacts)
  ) {
    const conversationSummary = record.conversations
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const thread = item as Record<string, unknown>;
        const name = typeof thread.name === "string" ? thread.name.trim() : "";
        const preview = typeof thread.preview === "string" ? thread.preview.trim() : "";
        return [name, preview].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 4);
    const momentSummary = record.momentsFeed
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const post = item as Record<string, unknown>;
        const authorLabel = typeof post.authorLabel === "string" ? post.authorLabel.trim() : "";
        const body = typeof post.body === "string" ? post.body.trim() : "";
        return [authorLabel, body].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 3);
    return [...conversationSummary, ...momentSummary].join("\n");
  }
  if (record.headline && Array.isArray(record.accounts) && Array.isArray(record.activities)) {
    const headline = record.headline && typeof record.headline === "object" ? record.headline as Record<string, unknown> : null;
    const headlineBits = headline
      ? [
          typeof headline.totalLabel === "string" ? headline.totalLabel.trim() : "",
          typeof headline.periodLabel === "string" ? headline.periodLabel.trim() : "",
        ].filter(Boolean).join(" / ")
      : "";
    const accountSummary = Array.isArray(record.accounts)
      ? record.accounts
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const account = item as Record<string, unknown>;
            const bankLabel = typeof account.bankLabel === "string" ? account.bankLabel.trim() : "";
            const title = typeof account.title === "string" ? account.title.trim() : "";
            const balance = typeof account.balance === "string" ? account.balance.trim() : "";
            return [[bankLabel, title].filter(Boolean).join(" "), balance].filter(Boolean).join("：");
          })
          .filter(Boolean)
          .slice(0, 4)
      : [];
    const activitySummary = Array.isArray(record.activities)
      ? record.activities
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const activity = item as Record<string, unknown>;
            const title = typeof activity.title === "string" ? activity.title.trim() : "";
            const amount = typeof activity.amount === "string" ? activity.amount.trim() : "";
            return [title, amount].filter(Boolean).join("：");
          })
          .filter(Boolean)
          .slice(0, 4)
      : [];
    return [headlineBits, ...accountSummary, ...activitySummary].filter(Boolean).join("\n");
  }
  if (Array.isArray(record.recents) && Array.isArray(record.contacts) && Array.isArray(record.voicemails)) {
    const recentSummary = record.recents
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const call = item as Record<string, unknown>;
        const name = typeof call.name === "string" ? call.name.trim() : "";
        const summary = typeof call.summary === "string" ? call.summary.trim() : "";
        const innerThought = typeof call.innerThought === "string" ? call.innerThought.trim() : "";
        return [name, summary || innerThought].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 4);
    const voicemailSummary = record.voicemails
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const vm = item as Record<string, unknown>;
        const name = typeof vm.name === "string" ? vm.name.trim() : "";
        const transcript = typeof vm.transcript === "string" ? vm.transcript.trim() : "";
        const preview = transcript.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
        return [name, preview].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 2);
    return [...recentSummary, ...voicemailSummary].join("\n");
  }
  if (
    record.stats &&
    Array.isArray(record.recentlyViewed) &&
    Array.isArray(record.savedItems) &&
    Array.isArray(record.cartItems) &&
    Array.isArray(record.orders)
  ) {
    const stats = record.stats && typeof record.stats === "object" ? record.stats as Record<string, unknown> : null;
    const statsBits = stats
      ? [
          typeof stats.pendingCount === "number" ? `待收货 ${stats.pendingCount}` : "",
          typeof stats.cartCount === "number" ? `购物车 ${stats.cartCount}` : "",
          typeof stats.savedCount === "number" ? `收藏 ${stats.savedCount}` : "",
        ].filter(Boolean).join(" / ")
      : "";
    const viewedSummary = Array.isArray(record.recentlyViewed)
      ? record.recentlyViewed
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const product = item as Record<string, unknown>;
            const title = typeof product.title === "string" ? product.title.trim() : "";
            const priceLabel = typeof product.priceLabel === "string" ? product.priceLabel.trim() : "";
            return [title, priceLabel].filter(Boolean).join("：");
          })
          .filter(Boolean)
          .slice(0, 3)
      : [];
    const orderSummary = Array.isArray(record.orders)
      ? record.orders
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const order = item as Record<string, unknown>;
            const summary = typeof order.summary === "string" ? order.summary.trim() : "";
            const statusLabel = typeof order.statusLabel === "string" ? order.statusLabel.trim() : "";
            return [summary, statusLabel].filter(Boolean).join(" · ");
          })
          .filter(Boolean)
          .slice(0, 3)
      : [];
    return [statsBits, ...viewedSummary, ...orderSummary].filter(Boolean).join("\n");
  }
  if (
    record.profile &&
    Array.isArray(record.homeNotes) &&
    Array.isArray(record.myNotes) &&
    Array.isArray(record.messageThreads)
  ) {
    const profile = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
    const profileBits = profile
      ? [
          typeof profile.name === "string" ? profile.name.trim() : "",
          typeof profile.bio === "string" ? profile.bio.trim() : "",
        ].filter(Boolean).join(" · ")
      : "";
    const noteSummary = (Array.isArray(record.homeNotes) ? record.homeNotes : [])
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const note = item as Record<string, unknown>;
        const title = typeof note.title === "string" ? note.title.trim() : "";
        const body = typeof note.body === "string" ? note.body.trim() : "";
        return [title, body].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 4);
    const threadSummary = (Array.isArray(record.messageThreads) ? record.messageThreads : [])
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const thread = item as Record<string, unknown>;
        const name = typeof thread.name === "string" ? thread.name.trim() : "";
        const messages = Array.isArray(thread.messages) ? thread.messages : [];
        const last = messages[messages.length - 1];
        const preview =
          last && typeof last === "object" && typeof (last as Record<string, unknown>).text === "string"
            ? ((last as Record<string, unknown>).text as string).trim()
            : "";
        return [name, preview].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 3);
    return [profileBits, ...noteSummary, ...threadSummary].filter(Boolean).join("\n");
  }
  if (
    record.profile &&
    Array.isArray(record.currentBooks) &&
    Array.isArray(record.highlights) &&
    Array.isArray(record.libraryBooks) &&
    Array.isArray(record.notes)
  ) {
    const profile = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
    const profileBits = profile
      ? [
          typeof profile.status === "string" ? profile.status.trim() : typeof profile.summary === "string" ? profile.summary.trim() : "",
          typeof profile.updatedLabel === "string" ? profile.updatedLabel.trim() : "",
        ].filter(Boolean).join(" · ")
      : "";
    const bookSummary = (Array.isArray(record.currentBooks) ? record.currentBooks : [])
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const book = item as Record<string, unknown>;
        const title = typeof book.title === "string" ? book.title.trim() : "";
        const progressLabel = typeof book.progressLabel === "string" ? book.progressLabel.trim() : "";
        return [title, progressLabel].filter(Boolean).join(" · ");
      })
      .filter(Boolean)
      .slice(0, 3);
    const noteSummary = (Array.isArray(record.notes) ? record.notes : [])
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const note = item as Record<string, unknown>;
        const title = typeof note.title === "string" ? note.title.trim() : "";
        const body = typeof note.body === "string" ? note.body.trim() : "";
        return [title, body].filter(Boolean).join("：");
      })
      .filter(Boolean)
      .slice(0, 3);
    return [profileBits, ...bookSummary, ...noteSummary].filter(Boolean).join("\n");
  }
  return "";
}

function resolveCheckPhoneDisplayName(
  authorType: "user" | "character" | "npc",
  authorId: string,
  authorName: string | undefined,
  userName: string,
  activeCharacterId: string,
): string {
  if (authorName?.trim()) return authorName.trim();
  if (authorType === "user") return userName;
  if (authorType === "npc") return authorId;
  if (authorId === activeCharacterId) {
    return loadCharacters().find((item) => item.id === activeCharacterId)?.name ?? "对方";
  }
  return loadCharacters().find((item) => item.id === authorId)?.name ?? authorId;
}

function normalizeEntityName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeVisibleChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((msg) => {
    if (msg.mediaType === "tool_call" || msg.mediaType === "tool_result" || msg.mediaType === "memory_write_request" || msg.mediaType === "tool_notice") return false;
    if (msg.origin === "reading_discuss" || msg.mediaType === "reading_discuss") return false;
    if (msg.role === "system") return false;
    const preview = getChatMessagePreview(msg).trim();
    return !!preview;
  });
}

function getCheckPhoneRealChatText(message: ChatMessage): string {
  if (message.mediaType === "sticker") {
    const labelFromData = typeof message.mediaData?.label === "string" ? message.mediaData.label.trim() : "";
    const labelFromContent = message.content.match(/\[表情包[：:]([^\]]+)\]/)?.[1]?.trim() ?? "";
    const label = labelFromData || labelFromContent;
    return label ? `[表情包:${label}]` : "[表情]";
  }
  return getChatMessagePreview(message).trim() || message.content.trim();
}

function extractDirectConversation(
  session: ChatSession | undefined,
  characterId: string,
  userName: string,
): CheckPhoneChatPayload["conversations"] {
  if (!session) return [];
  const visibleMessages = normalizeVisibleChatMessages(loadChatMessages(session.id));
  if (visibleMessages.length === 0) return [];
  const latest = visibleMessages[visibleMessages.length - 1];
  return [
    {
      id: `real_conv_${session.id}`,
      name: userName || "用户",
      preview: getCheckPhoneRealChatText(latest),
      timeLabel: formatChatUiTime(latest.createdAt),
      muted: session.isMuted === true,
      pinned: session.isPinned === true,
      tagLabel: "真实会话",
      messages: visibleMessages.slice(-10).map((msg) => ({
        id: msg.id,
        text: getCheckPhoneRealChatText(msg),
        timeLabel: formatChatUiTime(msg.createdAt),
        direction: msg.role === "user" ? "incoming" : "outgoing",
      })),
    },
  ];
}

function extractRealGroups(
  sessions: ChatSession[],
  characterId: string,
  userName: string,
): CheckPhoneChatPayload["groups"] {
  const chars = loadCharacters();
  return sessions
    .filter((session) => session.isGroup && session.participantIds?.includes(characterId))
    .map((session) => {
      const visibleMessages = normalizeVisibleChatMessages(loadChatMessages(session.id));
      if (visibleMessages.length === 0) return null;
      const latest = visibleMessages[visibleMessages.length - 1];
      const memberCount = Math.max((session.participantIds?.length ?? 0) + (session.isSpectator ? 0 : 1), 2);
      return {
        id: `real_group_${session.id}`,
        name: session.groupName?.trim() || "群聊",
        preview: getCheckPhoneRealChatText(latest),
        timeLabel: formatChatUiTime(latest.createdAt),
        muted: session.isMuted === true,
        memberCountLabel: `${memberCount}`,
        activityLabel: formatChatUiTime(latest.createdAt),
        messages: visibleMessages.slice(-10).map((msg) => {
          const senderName =
            msg.role === "user"
              ? userName
              : msg.senderCharacterId
                ? chars.find((item) => item.id === msg.senderCharacterId)?.name ?? msg.senderName ?? "成员"
                : msg.senderName ?? chars.find((item) => item.id === characterId)?.name ?? "成员";
          const outgoing = msg.role === "assistant" && (!msg.senderCharacterId || msg.senderCharacterId === characterId);
          return {
            id: msg.id,
            authorLabel: senderName,
            text: getCheckPhoneRealChatText(msg),
            timeLabel: formatChatUiTime(msg.createdAt),
            direction: outgoing ? "outgoing" : "incoming",
          };
        }),
      };
    })
    .filter(Boolean) as CheckPhoneChatPayload["groups"];
}

function extractRealMoments(characterId: string, userName: string): CheckPhoneChatPayload["momentsFeed"] {
  const posts = getAllPosts()
    .filter((post) =>
      (post.authorType === "user" || (post.authorType === "character" && post.authorId === characterId)) &&
      canCharacterSeeMomentPost(post, characterId)
    )
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return posts.map((post) => {
    const comments = getVisibleMomentCommentsForCharacter(post, characterId, loadMomentComments(post.id));
    const likes = getVisibleMomentLikesForCharacter(post, characterId, post.likes);
    const authorLabel = resolveCheckPhoneDisplayName(post.authorType, post.authorId, undefined, userName, characterId);
    return {
      id: `real_moment_${post.id}`,
      authorLabel,
      authorAccent:
        post.authorType === "user"
          ? "真实动态"
          : "朋友圈",
      timeLabel: formatChatUiTime(post.createdAt),
      body: post.content.trim(),
      mediaLabel: post.photoUrl || post.photoDescription ? "有图" : "文字",
      photoUrl: post.photoUrl,
      photoDescription: post.photoDescription,
      likeCountLabel: `${likes.length} 赞`,
      commentCountLabel: `${comments.length} 评论`,
      comments: comments.slice(0, 8).map((comment) => ({
        id: comment.id,
        authorLabel: resolveCheckPhoneDisplayName(
          comment.authorType,
          comment.authorId,
          comment.authorName,
          userName,
          characterId,
        ),
        timeLabel: formatChatUiTime(comment.createdAt),
        text: comment.content.trim(),
        replyToLabel: comment.replyToAuthorName
          || (comment.replyToAuthorType === "user" ? userName : undefined)
          || undefined,
      })),
    };
  });
}

function buildRealCheckPhoneChatPayload(characterId: string): CheckPhoneChatPayload {
  const sessions = loadChatSessions();
  const userName = resolveUserIdentity(characterId, "checkphone")?.name ?? "用户";
  const directSession = sessions.find((session) => !session.isGroup && session.contactId === characterId);
  const conversations = extractDirectConversation(directSession, characterId, userName);
  const groups = extractRealGroups(sessions, characterId, userName);
  const momentsFeed = extractRealMoments(characterId, userName);
  return {
    headerTitle: "聊天",
    headerSubtitle: "真实互动与补充内容",
    conversations,
    groups,
    momentsFeed,
    contacts: [],
  };
}

function formatRealChatSnapshotForPrompt(realPayload: CheckPhoneChatPayload): string {
  const conversationLines = realPayload.conversations.map((item) => `- 会话 ${item.name}｜${item.preview}`);
  const groupLines = realPayload.groups.map((item) => `- 群聊 ${item.name}｜${item.preview}`);
  const momentLines = realPayload.momentsFeed.map((item) => `- 朋友圈 ${item.authorLabel}｜${item.body}`);
  const contactLines = realPayload.contacts.map((item) => `- 联系人 ${item.name}｜${item.tagLabel}｜${item.note}`);
  return [
    "[真实会话]",
    conversationLines.length > 0 ? conversationLines.join("\n") : "- 无",
    "",
    "[真实群聊]",
    groupLines.length > 0 ? groupLines.join("\n") : "- 无",
    "",
    "[真实朋友圈]",
    momentLines.length > 0 ? momentLines.join("\n") : "- 无",
    "",
    "[真实联系人]",
    contactLines.length > 0 ? contactLines.join("\n") : "- 无",
  ].join("\n");
}

function mergeChatPayload(
  realPayload: CheckPhoneChatPayload,
  supplemental: Partial<CheckPhoneChatPayload> | null,
  characterId: string,
): CheckPhoneChatPayload {
  const characters = loadCharacters();
  const characterName = characters.find((item) => item.id === characterId)?.name ?? "";
  const userName = resolveUserIdentity(characterId, "checkphone")?.name ?? "用户";
  // 只拦用户名（防伪造）和角色自己的名字（防自聊）；其他角色卡不再一刀切拉黑，
  // 否则生成的同世界配角（也是角色卡）永远进不了补充会话/动态/联系人
  const blockedNpcOnlyNames = new Set<string>(
    [normalizeEntityName(userName), normalizeEntityName(characterName)].filter(Boolean),
  );
  const realConversationNames = new Set(realPayload.conversations.map((item) => normalizeEntityName(item.name)).filter(Boolean));
  const realGroupNames = new Set(realPayload.groups.map((item) => normalizeEntityName(item.name)).filter(Boolean));
  const mergeBy = <T extends { id: string }>(base: T[], extra: T[], keyFn?: (item: T) => string) => {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const item of [...base, ...extra]) {
      const key = keyFn ? keyFn(item) : item.id;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  };

  return {
    headerTitle: realPayload.headerTitle,
    headerSubtitle: realPayload.headerSubtitle,
    conversations: mergeBy(
      realPayload.conversations,
      (supplemental?.conversations ?? []).filter((item) => {
        const name = normalizeEntityName(item.name);
        return !!name && !blockedNpcOnlyNames.has(name) && !realConversationNames.has(name);
      }),
      (item) => normalizeEntityName(item.name) || item.id,
    ).slice(0, 10),
    groups: mergeBy(
      realPayload.groups,
      (supplemental?.groups ?? []).filter((item) => {
        const groupName = normalizeEntityName(item.name);
        if (groupName && realGroupNames.has(groupName)) return false;
        const preview = normalizeEntityName(item.preview);
        if (preview.includes(normalizeEntityName(userName))) return false;
        return !item.messages.some((message) => {
          const author = normalizeEntityName(message.authorLabel);
          const text = normalizeEntityName(message.text);
          return author === normalizeEntityName(userName) || text.includes(normalizeEntityName(userName));
        });
      }),
      (item) => normalizeEntityName(item.name) || item.id,
    ).slice(0, 8),
    momentsFeed: mergeBy(
      realPayload.momentsFeed,
      (supplemental?.momentsFeed ?? []).filter(
        (item) => {
          const author = normalizeEntityName(item.authorLabel);
          return !!author && !blockedNpcOnlyNames.has(author);
        },
      ),
      (item) => `${item.id}::${item.authorLabel}::${item.body}`,
    ).slice(0, 8),
    contacts: mergeBy(
      [],
      (supplemental?.contacts ?? []).filter((item) => {
        const name = normalizeEntityName(item.name);
        return !!name && !blockedNpcOnlyNames.has(name);
      }),
      (item) => normalizeEntityName(item.name) || item.id,
    ).slice(0, 12),
  };
}

async function buildCheckPhoneAppMessages(
  characterId: string,
  appId: CheckPhoneAppId,
  preset: PresetConfig | null,
  worldBooks: WorldBookConfig[],
  regexes: RegexConfig[],
  options?: { snapshotSummary?: string; lastRefreshAt?: string },
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) throw new Error("角色不存在");

  const userIdentity = resolveUserIdentity(characterId, "checkphone");
  const settings = loadCheckPhoneSettings();
  const memConfig = loadMemoryConfig();
  const { recentBlocks, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "checkphone", {
    userName: userIdentity?.name ?? "用户",
    history: [],
  });

  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
  ]);

  return assemblePromptPayload({
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "checkphone",
    appTags: getCheckPhonePromptTags(appId),
    scheduleSummary: buildCalendarScheduleMarker("character", characterId, getWeekStartIso(new Date())),
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks,
    unifiedRecentItems,
    phoneAppId: appId,
    phoneAppLabel: CHECKPHONE_APP_SPECS[appId].label,
    phoneSnapshotSummary: options?.snapshotSummary ?? "",
    phoneLastRefreshAt: options?.lastRefreshAt ?? "",
    checkPhoneBilingualInstruction: buildCheckPhoneBilingualInstruction(
      settings.bilingualTranslationEnabled,
      settings.bilingualTranslationPrompt,
    ),
  });
}

function normalizeNotesPayload(payload: unknown): CheckPhoneNotesPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const notesRaw = Array.isArray(record.notes) ? record.notes : [];
  const notes = notesRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const note = item as Record<string, unknown>;
      const id = typeof note.id === "string" && note.id.trim() ? note.id.trim() : "";
      const title = typeof note.title === "string" ? note.title.trim() : "";
      const body = typeof note.body === "string" ? note.body.trim() : "";
      const imageDescription = typeof note.imageDescription === "string" ? note.imageDescription.trim() : "";
      const tagLabel = typeof note.tagLabel === "string" ? note.tagLabel.trim() : "";
      const preview = deriveNotePreview(body);
      const updatedLabel = typeof note.updatedLabel === "string" ? note.updatedLabel.trim() : "";
      const pinned = note.pinned === true;
      if (!id || !title || !preview || !body || !updatedLabel) return null;
      return { id, title, preview, body, imageDescription, tagLabel, updatedLabel, pinned, tone: "ivory" as const };
    })
    .filter(Boolean) as CheckPhoneNotesPayload["notes"];

  return {
    headerTitle: "备忘录",
    headerSubtitle: "最近写下的碎片",
    notes: notes.slice(0, 9),
  };
}

function deriveNotePreview(body: string): string {
  return body
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 48) ?? "";
}

function parseNotesPinned(value: string | undefined): boolean {
  return value?.trim() === "是";
}

function parseNotesBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const matches = [...source.matchAll(/^#\s*备忘录(\d+)\s*$/gm)];
  if (matches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #备忘录N 分区" };
  }

  const notes = matches.map((current, index) => {
    const next = matches[index + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? source.length;
    const fields = parseTakeoutTaggedFields(source.slice(start, end).trim());
    const order = String(index + 1);
    return {
      id: `note_${order}`,
      title: fields["标题"] || "",
      updatedLabel: fields["时间"] || "",
      pinned: parseNotesPinned(fields["置顶"]),
      tagLabel: fields["标签"] || "",
      imageDescription: fields["图片描述"] || "",
      body: fields["正文"] || "",
    };
  });

  return {
    parsed: { notes },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

function parseBlockBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "是" || normalized === "true" || normalized === "yes";
}

function normalizeEmailPayload(payload: unknown): CheckPhoneEmailPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const emailsRaw = Array.isArray(record.emails) ? record.emails : Array.isArray(record.mails) ? record.mails : [];
  const emails = emailsRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const email = item as Record<string, unknown>;
      const id = typeof email.id === "string" && email.id.trim() ? email.id.trim() : "";
      const senderName = typeof email.senderName === "string" ? email.senderName.trim() : "";
      const senderAddress = typeof email.senderAddress === "string" ? email.senderAddress.trim() : "";
      const subject = typeof email.subject === "string" ? email.subject.trim() : "";
      const timeLabel = typeof email.timeLabel === "string" ? email.timeLabel.trim() : "";
      const body = typeof email.body === "string" ? email.body.trim() : "";
      const recipientLabel = typeof email.recipientLabel === "string" ? email.recipientLabel.trim() : "";
      const attachmentLabel =
        typeof email.attachmentLabel === "string" && email.attachmentLabel.trim() ? email.attachmentLabel.trim() : undefined;
      const unread = email.unread === true;
      const starred = email.starred === true;
      if (!id || !senderName || !senderAddress || !subject || !timeLabel || !body || !recipientLabel) return null;
      return {
        id,
        senderName,
        senderAddress,
        subject,
        preview: buildEmailPreview(body),
        timeLabel,
        body,
        recipientLabel,
        unread,
        starred,
        attachmentLabel,
      };
    })
    .filter(Boolean) as CheckPhoneEmailPayload["emails"];

  return {
    headerTitle: "邮箱",
    headerSubtitle: "最近的收件箱",
    emails: emails.slice(0, 18),
  };
}

function parseEmailBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const matches = [...source.matchAll(/^#\s*邮件(\d+)\s*$/gm)];
  if (matches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #邮件N 分区" };
  }

  const emails = matches.map((current, index) => {
    const next = matches[index + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? source.length;
    const fields = parseTakeoutTaggedFields(source.slice(start, end).trim());
    const order = String(index + 1);
    return {
      id: `mail_${order}`,
      senderName: fields["发件人"] || "",
      senderAddress: fields["邮箱"] || "",
      subject: fields["主题"] || "",
      timeLabel: fields["时间"] || "",
      body: fields["正文"] || "",
      recipientLabel: fields["收件人"] || "",
      unread: parseBlockBoolean(fields["未读"]),
      starred: parseBlockBoolean(fields["星标"]),
      attachmentLabel: fields["附件"] || undefined,
    };
  });

  return {
    parsed: { emails },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

const CHECKPHONE_TAKEOUT_CATEGORIES: CheckPhoneTakeoutCategory[] = [
  "美食",
  "饮品",
  "商超",
  "药品",
  "其他",
];

function parseTakeoutAmount(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[¥￥元,\s]/g, "").trim();
  return Number(normalized);
}

function parseTakeoutTaggedFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = stripJsonWrapperNoise(block).replace(/\r/g, "").split("\n");
  let currentKey = "";
  let buffer: string[] = [];

  const flush = () => {
    if (!currentKey) return;
    fields[currentKey] = buffer.join("\n").trim();
    currentKey = "";
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      flush();
      currentKey = match[1]?.trim() || "";
      buffer = [match[2] ?? ""];
      continue;
    }
    if (!currentKey) continue;
    buffer.push(line);
  }

  flush();
  return fields;
}

function parseBlockInteger(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[,，\s]/g, "");
  const match = normalized.match(/(-?\d+(?:\.\d+)?)([kK千wW万亿]?)/);
  if (!match) return Number.NaN;
  const numericValue = Number(match[1]);
  const unit = match[2] || "";
  const multiplier =
    unit === "k" || unit === "K" || unit === "千"
      ? 1000
      : unit === "w" || unit === "W" || unit === "万"
        ? 10000
        : unit === "亿"
          ? 100000000
          : 1;
  return Math.round(numericValue * multiplier);
}

function parseBlockList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\n,，、/|]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractTopLevelTaggedBlocks(source: string, label: string): Array<{ order: string; fields: Record<string, string> }> {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...source.matchAll(new RegExp(`^#\\s*${escaped}(\\d+)\\s*$`, "gm"))];
  const allHeadings = [...source.matchAll(/^#\s*\S.*$/gm)];
  return matches.map((current, index) => {
    const start = (current.index ?? 0) + current[0].length;
    const next = allHeadings.find((match) => (match.index ?? 0) > (current.index ?? 0));
    const end = next?.index ?? source.length;
    return {
      order: current[1] || String(index + 1),
      fields: parseTakeoutTaggedFields(source.slice(start, end).trim()),
    };
  });
}

function parseTakeoutBlockPayload(text: string): {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
} {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) {
    return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };
  }

  const sectionMatches = [...source.matchAll(/^#\s*(美食|饮品|商超|药品|其他)\s*$/gm)];
  if (sectionMatches.length === 0) {
    return {
      parsed: null,
      sanitizedCandidate: source,
      parseMode: "failed",
      parseError: "未找到外卖分类分区",
    };
  }
  const orders = sectionMatches.flatMap((sectionMatch, sectionIndex) => {
    const category = (sectionMatch[1] || "").trim() as CheckPhoneTakeoutCategory;
    const sectionStart = (sectionMatch.index ?? 0) + sectionMatch[0].length;
    const sectionEnd = sectionMatches[sectionIndex + 1]?.index ?? source.length;
    const sectionBody = source.slice(sectionStart, sectionEnd).trim();
    const postMatches = [...sectionBody.matchAll(/^##\s*订单(\d+)\s*$/gm)];
    return postMatches.map((current, index) => {
      const next = postMatches[index + 1];
      const start = (current.index ?? 0) + current[0].length;
      const end = next?.index ?? sectionBody.length;
      const block = sectionBody.slice(start, end).trim();
      const fields = parseTakeoutTaggedFields(block);

      const itemIndexes = [...new Set(
        Object.keys(fields)
          .map((key) => key.match(/^商品(\d+)(?:图标)?$/)?.[1] ?? "")
          .filter(Boolean),
      )]
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);

      const items = itemIndexes
        .map((itemIndex) => {
          const name = fields[`商品${itemIndex}`]?.trim() || "";
          const icon = fields[`商品${itemIndex}图标`]?.trim() || "";
          if (!name || !icon) return null;
          return { name, icon };
        })
        .filter(Boolean);

      return {
        id: `takeout_${category}_${current[1] || index + 1}`,
        shopName: fields["店铺"] || "",
        category,
        createdAt: fields["时间"] || "",
        icon: fields["图标"] || "",
        status: fields["状态"] || "",
        amount: parseTakeoutAmount(fields["金额"]),
        items,
        note: fields["备注"] || undefined,
        scenario: fields["情境"] || "",
        innerVoice: fields["心声"] || "",
        review: fields["评价"] || undefined,
      };
    });
  });

  if (orders.length === 0) {
    return {
      parsed: null,
      sanitizedCandidate: source,
      parseMode: "failed",
      parseError: "未找到 ##订单 编号块",
    };
  }

  const parsed = {
    headerTitle: "外卖",
    headerSubtitle: "最近吃了什么",
    orders,
  };

  return {
    parsed,
    sanitizedCandidate: JSON.stringify(parsed, null, 2),
    parseMode: "sanitized",
  };
}

function normalizeTakeoutPayload(payload: unknown): CheckPhoneTakeoutPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));

  const orders = (Array.isArray(record.orders) ? record.orders : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const shopName = typeof item.shopName === "string" ? item.shopName.trim() : "";
      const category =
        typeof item.category === "string" && CHECKPHONE_TAKEOUT_CATEGORIES.includes(item.category as CheckPhoneTakeoutCategory)
          ? (item.category as CheckPhoneTakeoutCategory)
          : null;
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const icon = typeof item.icon === "string" ? item.icon.trim() : "";
      const status = typeof item.status === "string" ? item.status.trim() : "";
      const amount = typeof item.amount === "number" ? item.amount : Number(item.amount);
      const items = (Array.isArray(item.items) ? item.items : [])
        .map((value) => {
          if (typeof value === "string") {
            const name = value.trim();
            return name ? { name, icon } : null;
          }
          if (!value || typeof value !== "object") return null;
          const record = value as Record<string, unknown>;
          const name = typeof record.name === "string" ? record.name.trim() : "";
          const itemIcon = typeof record.icon === "string" ? record.icon.trim() : "";
          if (!name || !itemIcon) return null;
          return { name, icon: itemIcon };
        })
        .filter(Boolean);
      const note = typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined;
      const scenario = typeof item.scenario === "string" ? item.scenario.trim() : "";
      const innerVoice = typeof item.innerVoice === "string" ? item.innerVoice.trim() : "";
      const review = typeof item.review === "string" && item.review.trim() ? item.review.trim() : undefined;
      if (
        !id ||
        !shopName ||
        !category ||
        !createdAt ||
        !isIsoTimestamp(createdAt) ||
        !icon ||
        !status ||
        !Number.isFinite(amount) ||
        items.length === 0 ||
        !scenario ||
        !innerVoice
      ) {
        return null;
      }
      return {
        id,
        shopName,
        category,
        createdAt,
        icon,
        status,
        amount: Math.max(0, Number(amount)),
        items,
        note,
        scenario,
        innerVoice,
        review,
      };
    })
    .filter(Boolean) as CheckPhoneTakeoutPayload["orders"];

  const seenIds = new Set<string>();
  for (const order of orders) {
    if (seenIds.has(order.id)) return null;
    seenIds.add(order.id);
  }

  return {
    headerTitle:
      typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "外卖",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "最近点了什么",
    orders: orders.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 24),
  };
}

function diagnoseTakeoutNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.orders)) return "orders 不是数组";
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  const seen = new Set<string>();
  for (let index = 0; index < record.orders.length; index += 1) {
    const entry = record.orders[index];
    if (!entry || typeof entry !== "object") return `orders[${index}] 不是对象`;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `orders[${index}].id 缺失`;
    if (seen.has(id)) return `orders 存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.shopName !== "string" || !item.shopName.trim()) return `orders[${index}].shopName 缺失`;
    if (typeof item.category !== "string" || !CHECKPHONE_TAKEOUT_CATEGORIES.includes(item.category as CheckPhoneTakeoutCategory)) {
      return `orders[${index}].category 非法`;
    }
    if (typeof item.createdAt !== "string" || !isIsoTimestamp(item.createdAt.trim())) return `orders[${index}].createdAt 非法`;
    if (typeof item.icon !== "string" || !item.icon.trim()) return `orders[${index}].icon 缺失`;
    if (typeof item.status !== "string" || !item.status.trim()) return `orders[${index}].status 缺失`;
    if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) return `orders[${index}].amount 非法`;
    if (!Array.isArray(item.items) || item.items.length === 0) return `orders[${index}].items 为空`;
    for (let itemIndex = 0; itemIndex < item.items.length; itemIndex += 1) {
      const orderItem = item.items[itemIndex];
      if (typeof orderItem === "string" && orderItem.trim()) continue;
      if (!orderItem || typeof orderItem !== "object") return `orders[${index}].items[${itemIndex}] 非法`;
      const orderItemRecord = orderItem as Record<string, unknown>;
      if (typeof orderItemRecord.name !== "string" || !orderItemRecord.name.trim()) {
        return `orders[${index}].items[${itemIndex}].name 缺失`;
      }
      if (typeof orderItemRecord.icon !== "string" || !orderItemRecord.icon.trim()) {
        return `orders[${index}].items[${itemIndex}].icon 缺失`;
      }
    }
    if (typeof item.scenario !== "string" || !item.scenario.trim()) return `orders[${index}].scenario 缺失`;
    if (typeof item.innerVoice !== "string" || !item.innerVoice.trim()) return `orders[${index}].innerVoice 缺失`;
  }
  return "结构存在字段缺失、枚举非法或重复id";
}

function parseSteamNumericField(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[¥￥元小时,\s]/g, "").trim();
  const wanMatch = normalized.match(/^(-?\d+(?:\.\d+)?)万$/);
  if (wanMatch) return Math.round(Number(wanMatch[1]) * 10000);
  return Number(normalized);
}

function parseSteamProgressField(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  return Number(value.replace(/[％%\s]/g, "").replace(/^百分之/, "").trim());
}

function clampSteamProgressPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function parseSteamBlockPayload(text: string): {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
} {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) {
    return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };
  }

  const sections = [...source.matchAll(/^#\s*(最近在玩|愿望单|游戏库)\s*$/gm)];
  if (sections.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到游戏库分区" };
  }

  const firstSectionIndex = sections[0]?.index ?? 0;
  const profileBlock = source.slice(0, firstSectionIndex).trim();
  const profileFields = parseTakeoutTaggedFields(profileBlock);

  const parseSectionGames = (sectionName: "最近在玩" | "愿望单" | "游戏库") => {
    const sectionIndex = sections.findIndex((match) => (match[1] || "").trim() === sectionName);
    if (sectionIndex < 0) return [];
    const current = sections[sectionIndex];
    const start = (current.index ?? 0) + current[0].length;
    const end = sections[sectionIndex + 1]?.index ?? source.length;
    const body = source.slice(start, end).trim();
    const gameMatches = [...body.matchAll(/^##\s*游戏(\d+)\s*$/gm)];
    return gameMatches.map((gameMatch, index) => {
      const next = gameMatches[index + 1];
      const blockStart = (gameMatch.index ?? 0) + gameMatch[0].length;
      const blockEnd = next?.index ?? body.length;
      const fields = parseTakeoutTaggedFields(body.slice(blockStart, blockEnd).trim());
      const gameId = `steam_${sectionName}_${gameMatch[1] || index + 1}`;
      if (sectionName === "最近在玩") {
        return {
          id: gameId,
          title: fields["游戏名"] || "",
          icon: fields["图标"] || "",
          genre: fields["类型"] || "",
          totalHours: parseSteamNumericField(fields["总时长"]),
          recentHours: parseSteamNumericField(fields["近两周时长"]),
          progressPercent: parseSteamProgressField(fields["进度"]),
          lastPlayedAt: fields["上次游玩"] || "",
          status: fields["状态"] || "",
          note: fields["感想"] || "",
        };
      }
      if (sectionName === "愿望单") {
        return {
          id: gameId,
          title: fields["游戏名"] || "",
          icon: fields["图标"] || "",
          genre: fields["类型"] || "",
          price: parseSteamNumericField(fields["价格"]),
          reason: fields["想玩原因"] || "",
        };
      }
      return {
        id: gameId,
        title: fields["游戏名"] || "",
        icon: fields["图标"] || "",
        genre: fields["类型"] || "",
        totalHours: parseSteamNumericField(fields["总时长"]),
        progressPercent: parseSteamProgressField(fields["进度"]),
        lastPlayedAt: fields["上次游玩"] || "",
        status: fields["状态"] || "",
        note: fields["感想"] || "",
      };
    });
  };

  const parsed = {
    headerTitle: "游戏库",
    profile: {
      name: profileFields["昵称"] || "",
      handle: profileFields["账号"] || "",
      bio: profileFields["简介"] || "",
    },
    recentlyPlayed: parseSectionGames("最近在玩"),
    wishlist: parseSectionGames("愿望单"),
    library: parseSectionGames("游戏库"),
  };

  return {
    parsed,
    sanitizedCandidate: JSON.stringify(parsed, null, 2),
    parseMode: "sanitized",
  };
}

function normalizeSteamPayload(payload: unknown): CheckPhoneSteamPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const profileRecord = record.profile && typeof record.profile === "object" ? (record.profile as Record<string, unknown>) : null;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  if (!profileRecord) return null;

  const profile = {
    name: typeof profileRecord.name === "string" ? normalizeRedditMultilineText(profileRecord.name) : "",
    handle: typeof profileRecord.handle === "string" ? normalizeRedditMultilineText(profileRecord.handle) : "",
    bio: typeof profileRecord.bio === "string" ? normalizeRedditMultilineText(profileRecord.bio) : "",
  };
  if (!profile.name || !profile.handle || !profile.bio) return null;

  const recentlyPlayed = (Array.isArray(record.recentlyPlayed) ? record.recentlyPlayed : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const icon = typeof item.icon === "string" ? item.icon.trim() : "";
      const genre = typeof item.genre === "string" ? item.genre.trim() : "";
      const totalHours = typeof item.totalHours === "number" ? item.totalHours : Number(item.totalHours);
      const recentHours = typeof item.recentHours === "number" ? item.recentHours : Number(item.recentHours);
      const progressPercent = parseSteamProgressField(item.progressPercent ?? item.progress);
      const lastPlayedAt = typeof item.lastPlayedAt === "string" ? item.lastPlayedAt.trim() : "";
      const status = typeof item.status === "string" ? item.status.trim() : "";
      const note = typeof item.note === "string" ? item.note.trim() : "";
      if (!id || !title || !icon || !genre || !Number.isFinite(totalHours) || !Number.isFinite(recentHours) || !Number.isFinite(progressPercent) || !lastPlayedAt || !isIsoTimestamp(lastPlayedAt) || !status || !note) return null;
      return {
        id,
        title,
        icon,
        genre,
        totalHours: Math.max(0, totalHours),
        recentHours: Math.max(0, recentHours),
        progressPercent: clampSteamProgressPercent(progressPercent),
        lastPlayedAt,
        status,
        note,
      };
    })
    .filter(Boolean) as CheckPhoneSteamPayload["recentlyPlayed"];

  const wishlist = (Array.isArray(record.wishlist) ? record.wishlist : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const icon = typeof item.icon === "string" ? item.icon.trim() : "";
      const genre = typeof item.genre === "string" ? item.genre.trim() : "";
      const price = typeof item.price === "number" ? item.price : Number(item.price);
      const reason = typeof item.reason === "string" ? item.reason.trim() : "";
      if (!id || !title || !icon || !genre || !Number.isFinite(price) || !reason) return null;
      return { id, title, icon, genre, price: Math.max(0, price), reason };
    })
    .filter(Boolean) as CheckPhoneSteamPayload["wishlist"];

  const library = (Array.isArray(record.library) ? record.library : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const icon = typeof item.icon === "string" ? item.icon.trim() : "";
      const genre = typeof item.genre === "string" ? item.genre.trim() : "";
      const totalHours = typeof item.totalHours === "number" ? item.totalHours : Number(item.totalHours);
      const progressPercent = parseSteamProgressField(item.progressPercent ?? item.progress);
      const lastPlayedAt = typeof item.lastPlayedAt === "string" ? item.lastPlayedAt.trim() : "";
      const status = typeof item.status === "string" ? item.status.trim() : "";
      const note = typeof item.note === "string" ? item.note.trim() : "";
      if (!id || !title || !icon || !genre || !Number.isFinite(totalHours) || !Number.isFinite(progressPercent) || !lastPlayedAt || !isIsoTimestamp(lastPlayedAt) || !status || !note) return null;
      return {
        id,
        title,
        icon,
        genre,
        totalHours: Math.max(0, totalHours),
        progressPercent: clampSteamProgressPercent(progressPercent),
        lastPlayedAt,
        status,
        note,
      };
    })
    .filter(Boolean) as CheckPhoneSteamPayload["library"];

  const uniqueIds = new Set<string>();
  for (const item of [...recentlyPlayed, ...wishlist, ...library]) {
    if (uniqueIds.has(item.id)) return null;
    uniqueIds.add(item.id);
  }

  return {
    headerTitle:
      typeof record.headerTitle === "string" && record.headerTitle.trim() && record.headerTitle.trim() !== "Steam"
        ? record.headerTitle.trim()
        : "游戏库",
    profile,
    recentlyPlayed: recentlyPlayed.sort((a, b) => Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt)),
    wishlist: wishlist.slice(0, 12),
    library: library.sort((a, b) => Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt)).slice(0, 16),
  };
}

function diagnoseSteamNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  if (!record.profile || typeof record.profile !== "object") return "profile 缺失";
  const profile = record.profile as Record<string, unknown>;
  if (typeof profile.name !== "string" || !profile.name.trim()) return "profile.name 缺失";
  if (typeof profile.handle !== "string" || !profile.handle.trim()) return "profile.handle 缺失";
  if (typeof profile.bio !== "string" || !profile.bio.trim()) return "profile.bio 缺失";
  if (!Array.isArray(record.recentlyPlayed)) return "recentlyPlayed 不是数组";
  if (!Array.isArray(record.wishlist)) return "wishlist 不是数组";
  if (!Array.isArray(record.library)) return "library 不是数组";
  const seen = new Set<string>();
  for (let index = 0; index < record.recentlyPlayed.length; index += 1) {
    const item = record.recentlyPlayed[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `recentlyPlayed[${index}] 不是对象`;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `recentlyPlayed[${index}].id 缺失`;
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.totalHours !== "number" || !Number.isFinite(item.totalHours)) return `recentlyPlayed[${index}].totalHours 非法`;
    if (typeof item.recentHours !== "number" || !Number.isFinite(item.recentHours)) return `recentlyPlayed[${index}].recentHours 非法`;
    if (typeof item.progressPercent !== "number" || !Number.isFinite(item.progressPercent)) return `recentlyPlayed[${index}].progressPercent 非法`;
  }
  for (let index = 0; index < record.wishlist.length; index += 1) {
    const item = record.wishlist[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `wishlist[${index}] 不是对象`;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `wishlist[${index}].id 缺失`;
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.price !== "number" || !Number.isFinite(item.price)) return `wishlist[${index}].price 非法`;
  }
  for (let index = 0; index < record.library.length; index += 1) {
    const item = record.library[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `library[${index}] 不是对象`;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `library[${index}].id 缺失`;
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.totalHours !== "number" || !Number.isFinite(item.totalHours)) return `library[${index}].totalHours 非法`;
    if (typeof item.progressPercent !== "number" || !Number.isFinite(item.progressPercent)) return `library[${index}].progressPercent 非法`;
  }
  return "结构存在字段缺失、时间非法或重复id";
}

function parseBilibiliNumericField(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[,\s次播放]/g, "").trim();
  const wanMatch = normalized.match(/^(-?\d+(?:\.\d+)?)万$/);
  if (wanMatch) return Math.round(Number(wanMatch[1]) * 10000);
  return Number(normalized);
}

function parseBilibiliBlockPayload(text: string): {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
} {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const sections = [...source.matchAll(/^#\s*(观看记录|收藏)\s*$/gm)];
  if (sections.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 B站分区" };
  }

  const parseSectionVideos = (sectionName: "观看记录" | "收藏") => {
    const sectionIndex = sections.findIndex((match) => (match[1] || "").trim() === sectionName);
    if (sectionIndex < 0) return [];
    const current = sections[sectionIndex];
    const start = (current.index ?? 0) + current[0].length;
    const end = sections[sectionIndex + 1]?.index ?? source.length;
    const body = source.slice(start, end).trim();
    const matches = [...body.matchAll(/^##\s*视频(\d+)\s*$/gm)];
    return matches.map((currentMatch, index) => {
      const next = matches[index + 1];
      const blockStart = (currentMatch.index ?? 0) + currentMatch[0].length;
      const blockEnd = next?.index ?? body.length;
      const fields = parseTakeoutTaggedFields(body.slice(blockStart, blockEnd).trim());
      const id = `bili_${sectionName}_${currentMatch[1] || index + 1}`;
      if (sectionName === "观看记录") {
        return {
          id,
          title: fields["标题"] || "",
          upName: fields["UP主"] || "",
          icon: fields["图标"] || "",
          visualDescription: fields["画面描述"] || "",
          createdAt: fields["时间"] || "",
          durationLabel: fields["时长"] || "",
          playCount: parseBilibiliNumericField(fields["播放量"]),
          progressLabel: fields["看到哪了"] || "",
          stateNote: fields["当时状态"] || "",
          feeling: fields["感受"] || "",
        };
      }
      return {
        id,
        title: fields["标题"] || "",
        upName: fields["UP主"] || "",
        icon: fields["图标"] || "",
        visualDescription: fields["画面描述"] || "",
        createdAt: fields["时间"] || "",
        durationLabel: fields["时长"] || "",
        playCount: parseBilibiliNumericField(fields["播放量"]),
        saveReason: fields["收藏原因"] || "",
        feeling: fields["感受"] || "",
      };
    });
  };

  const parsed = {
    headerTitle: "B站",
    headerSubtitle: "最近看了什么，为什么留下它们",
    watchHistory: parseSectionVideos("观看记录"),
    favorites: parseSectionVideos("收藏"),
  };

  return {
    parsed,
    sanitizedCandidate: JSON.stringify(parsed, null, 2),
    parseMode: "sanitized",
  };
}

function normalizeBilibiliPayload(payload: unknown): CheckPhoneBilibiliPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));

  const watchHistory = (Array.isArray(record.watchHistory) ? record.watchHistory : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const upName = typeof item.upName === "string" ? item.upName.trim() : "";
      const icon = typeof item.icon === "string" ? item.icon.trim() : "";
      const visualDescription = typeof item.visualDescription === "string" ? item.visualDescription.trim() : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const durationLabel = typeof item.durationLabel === "string" ? item.durationLabel.trim() : "";
      const playCount = typeof item.playCount === "number" ? item.playCount : Number(item.playCount);
      const progressLabel = typeof item.progressLabel === "string" ? item.progressLabel.trim() : "";
      const stateNote = typeof item.stateNote === "string" ? item.stateNote.trim() : "";
      const feeling = typeof item.feeling === "string" ? item.feeling.trim() : "";
      if (!id || !title || !upName || !icon || !visualDescription || !createdAt || !isIsoTimestamp(createdAt) || !durationLabel || !Number.isFinite(playCount) || !progressLabel || !stateNote || !feeling) return null;
      return { id, title, upName, icon, visualDescription, createdAt, durationLabel, playCount: Math.max(0, Math.round(playCount)), progressLabel, stateNote, feeling };
    })
    .filter(Boolean) as CheckPhoneBilibiliPayload["watchHistory"];

  const favorites = (Array.isArray(record.favorites) ? record.favorites : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const upName = typeof item.upName === "string" ? item.upName.trim() : "";
      const icon = typeof item.icon === "string" ? item.icon.trim() : "";
      const visualDescription = typeof item.visualDescription === "string" ? item.visualDescription.trim() : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const durationLabel = typeof item.durationLabel === "string" ? item.durationLabel.trim() : "";
      const playCount = typeof item.playCount === "number" ? item.playCount : Number(item.playCount);
      const saveReason = typeof item.saveReason === "string" ? item.saveReason.trim() : "";
      const feeling = typeof item.feeling === "string" ? item.feeling.trim() : "";
      if (!id || !title || !upName || !icon || !visualDescription || !createdAt || !isIsoTimestamp(createdAt) || !durationLabel || !Number.isFinite(playCount) || !saveReason || !feeling) return null;
      return { id, title, upName, icon, visualDescription, createdAt, durationLabel, playCount: Math.max(0, Math.round(playCount)), saveReason, feeling };
    })
    .filter(Boolean) as CheckPhoneBilibiliPayload["favorites"];

  const seen = new Set<string>();
  for (const item of [...watchHistory, ...favorites]) {
    if (seen.has(item.id)) return null;
    seen.add(item.id);
  }

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "B站",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "最近看了什么，为什么留下它们",
    watchHistory: watchHistory.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    favorites: favorites.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

function diagnoseBilibiliNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.watchHistory)) return "watchHistory 不是数组";
  if (!Array.isArray(record.favorites)) return "favorites 不是数组";
  const seen = new Set<string>();
  for (let index = 0; index < record.watchHistory.length; index += 1) {
    const item = record.watchHistory[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `watchHistory[${index}] 不是对象`;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `watchHistory[${index}].id 缺失`;
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.visualDescription !== "string" || !item.visualDescription.trim()) return `watchHistory[${index}].visualDescription 缺失`;
    if (typeof item.playCount !== "number" || !Number.isFinite(item.playCount)) return `watchHistory[${index}].playCount 非法`;
  }
  for (let index = 0; index < record.favorites.length; index += 1) {
    const item = record.favorites[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `favorites[${index}] 不是对象`;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `favorites[${index}].id 缺失`;
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.visualDescription !== "string" || !item.visualDescription.trim()) return `favorites[${index}].visualDescription 缺失`;
    if (typeof item.playCount !== "number" || !Number.isFinite(item.playCount)) return `favorites[${index}].playCount 非法`;
  }
  return "结构存在字段缺失、时间非法或重复id";
}

type RedditBlockParseResult = {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
};

function parseRedditNumericField(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[,\s]/g, "").trim();
  const wanMatch = normalized.match(/^(-?\d+(?:\.\d+)?)万$/);
  if (wanMatch) return Math.round(Number(wanMatch[1]) * 10000);
  return Number(normalized);
}

function normalizeRedditMultilineText(value: string): string {
  return value.replace(/\\r\\n|\\n|\\r/g, "\n").trim();
}

function parseRedditSectionBlocks(source: string, sectionMatches: RegExpMatchArray[], sectionNames: string[], blockLabel: "帖子" | "评论") {
  const sectionIndex = sectionMatches.findIndex((match) => sectionNames.includes((match[1] || "").trim()));
  if (sectionIndex < 0) return [];
  const current = sectionMatches[sectionIndex];
  const start = (current.index ?? 0) + current[0].length;
  const end = sectionMatches[sectionIndex + 1]?.index ?? source.length;
  const body = source.slice(start, end).trim();
  const matches = [...body.matchAll(new RegExp(`^##\\s*${blockLabel}(\\d+)\\s*$`, "gm"))];
  return matches.map((currentMatch, index) => {
    const next = matches[index + 1];
    const blockStart = (currentMatch.index ?? 0) + currentMatch[0].length;
    const blockEnd = next?.index ?? body.length;
    return {
      number: Number(currentMatch[1] || index + 1),
      fields: parseTakeoutTaggedFields(body.slice(blockStart, blockEnd).trim()),
    };
  });
}

function parseRedditBlockPayload(text: string): RedditBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const sectionMatches = [...source.matchAll(/^#\s*(Posts|Comments|发帖|评论)\s*$/gm)];
  if (sectionMatches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #Posts / #Comments 分区" };
  }

  const firstSectionIndex = sectionMatches[0]?.index ?? 0;
  const profileFields = parseTakeoutTaggedFields(source.slice(0, firstSectionIndex).trim());
  const profile = {
    name: normalizeRedditMultilineText(profileFields["昵称"] || ""),
    handle: normalizeRedditMultilineText(profileFields["用户名"] || ""),
    bio: normalizeRedditMultilineText(profileFields["简介"] || ""),
    followers: parseRedditNumericField(profileFields["粉丝"]),
    postKarma: parseRedditNumericField(profileFields["Post Karma"] || profileFields["帖子 Karma"] || profileFields["Karma"]),
    commentKarma: parseRedditNumericField(profileFields["Comment Karma"] || profileFields["评论 Karma"]),
    cakeDay: profileFields["Cake Day"] || "",
  };

  const posts = parseRedditSectionBlocks(source, sectionMatches, ["Posts", "发帖"], "帖子").map((entry) => ({
    id: `reddit_post_${entry.number}`,
    communityName: normalizeRedditMultilineText(entry.fields["社区"] || ""),
    title: normalizeRedditMultilineText(entry.fields["标题"] || ""),
    body: normalizeRedditMultilineText(entry.fields["正文"] || ""),
    createdAt: entry.fields["时间"] || "",
    upvoteCount: parseRedditNumericField(entry.fields["赞同量"]),
    commentCount: parseRedditNumericField(entry.fields["评论量"]),
    viewCount: parseRedditNumericField(entry.fields["浏览量"]),
    innerThought: normalizeRedditMultilineText(entry.fields["内心想法"] || entry.fields["Innerthought"] || entry.fields["InnerThought"] || entry.fields["感受"] || ""),
  }));

  const comments = parseRedditSectionBlocks(source, sectionMatches, ["Comments", "评论"], "评论").map((entry) => ({
    id: `reddit_comment_${entry.number}`,
    communityName: normalizeRedditMultilineText(entry.fields["社区"] || ""),
    postTitle: normalizeRedditMultilineText(entry.fields["原帖标题"] || entry.fields["标题"] || ""),
    body: normalizeRedditMultilineText(entry.fields["正文"] || ""),
    createdAt: entry.fields["时间"] || "",
    upvoteCount: parseRedditNumericField(entry.fields["赞同量"]),
    viewCount: parseRedditNumericField(entry.fields["浏览量"]),
    innerThought: normalizeRedditMultilineText(entry.fields["内心想法"] || entry.fields["Innerthought"] || entry.fields["InnerThought"] || entry.fields["感受"] || ""),
  }));

  const parsed = {
    headerTitle: "Reddit",
    headerSubtitle: "Posts, Comments, About",
    profile,
    posts,
    comments,
  };

  return {
    parsed,
    sanitizedCandidate: JSON.stringify(parsed, null, 2),
    parseMode: "sanitized",
  };
}

function normalizeRedditPayload(payload: unknown): CheckPhoneRedditPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const profileRecord = record.profile && typeof record.profile === "object" ? (record.profile as Record<string, unknown>) : null;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  if (!profileRecord) return null;

  const profile = {
    name: typeof profileRecord.name === "string" ? profileRecord.name.trim() : "",
    handle: typeof profileRecord.handle === "string" ? profileRecord.handle.trim() : "",
    bio: typeof profileRecord.bio === "string" ? profileRecord.bio.trim() : "",
    followers: typeof profileRecord.followers === "number" ? profileRecord.followers : Number(profileRecord.followers),
    postKarma: typeof profileRecord.postKarma === "number" ? profileRecord.postKarma : Number(profileRecord.postKarma),
    commentKarma: typeof profileRecord.commentKarma === "number" ? profileRecord.commentKarma : Number(profileRecord.commentKarma),
    cakeDay: typeof profileRecord.cakeDay === "string" ? profileRecord.cakeDay.trim() : "",
  };
  if (!profile.name || !profile.handle || !profile.bio || !Number.isFinite(profile.followers) || !Number.isFinite(profile.postKarma) || !Number.isFinite(profile.commentKarma) || !profile.cakeDay || !isIsoTimestamp(profile.cakeDay)) return null;

  const posts = (Array.isArray(record.posts) ? record.posts : [])
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `reddit_post_${index + 1}`;
      const communityName = typeof item.communityName === "string" ? normalizeRedditMultilineText(item.communityName) : "";
      const title = typeof item.title === "string" ? normalizeRedditMultilineText(item.title) : "";
      const body = typeof item.body === "string" ? normalizeRedditMultilineText(item.body) : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const upvoteCount = typeof item.upvoteCount === "number" ? item.upvoteCount : Number(item.upvoteCount);
      const commentCount = typeof item.commentCount === "number" ? item.commentCount : Number(item.commentCount);
      const viewCount = typeof item.viewCount === "number" ? item.viewCount : Number(item.viewCount);
      const innerThought = typeof item.innerThought === "string" ? normalizeRedditMultilineText(item.innerThought) : "";
      if (!id || !communityName || !title || !body || !createdAt || !isIsoTimestamp(createdAt) || !Number.isFinite(upvoteCount) || !Number.isFinite(commentCount) || !Number.isFinite(viewCount) || !innerThought) return null;
      return {
        id,
        communityName,
        title,
        body,
        createdAt,
        upvoteCount: Math.max(0, Math.round(upvoteCount)),
        commentCount: Math.max(0, Math.round(commentCount)),
        viewCount: Math.max(0, Math.round(viewCount)),
        innerThought,
      };
    })
    .filter(Boolean) as CheckPhoneRedditPayload["posts"];

  const comments = (Array.isArray(record.comments) ? record.comments : [])
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `reddit_comment_${index + 1}`;
      const communityName = typeof item.communityName === "string" ? normalizeRedditMultilineText(item.communityName) : "";
      const postTitle = typeof item.postTitle === "string" ? normalizeRedditMultilineText(item.postTitle) : "";
      const body = typeof item.body === "string" ? normalizeRedditMultilineText(item.body) : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const upvoteCount = typeof item.upvoteCount === "number" ? item.upvoteCount : Number(item.upvoteCount);
      const viewCount = typeof item.viewCount === "number" ? item.viewCount : Number(item.viewCount);
      const innerThought = typeof item.innerThought === "string" ? normalizeRedditMultilineText(item.innerThought) : "";
      if (!id || !communityName || !postTitle || !body || !createdAt || !isIsoTimestamp(createdAt) || !Number.isFinite(upvoteCount) || !Number.isFinite(viewCount) || !innerThought) return null;
      return {
        id,
        communityName,
        postTitle,
        body,
        createdAt,
        upvoteCount: Math.max(0, Math.round(upvoteCount)),
        viewCount: Math.max(0, Math.round(viewCount)),
        innerThought,
      };
    })
    .filter(Boolean) as CheckPhoneRedditPayload["comments"];

  if (posts.length === 0 || comments.length === 0) return null;

  const seen = new Set<string>();
  for (const item of [...posts, ...comments]) {
    if (seen.has(item.id)) return null;
    seen.add(item.id);
  }

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "Reddit",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "Posts, Comments, About",
    profile: {
      ...profile,
      followers: Math.max(0, Math.round(profile.followers)),
      postKarma: Math.max(0, Math.round(profile.postKarma)),
      commentKarma: Math.max(0, Math.round(profile.commentKarma)),
    },
    posts: posts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    comments: comments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

function diagnoseRedditNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  if (!record.profile || typeof record.profile !== "object") return "profile 缺失";
  const profile = record.profile as Record<string, unknown>;
  if (typeof profile.name !== "string" || !profile.name.trim()) return "profile.name 缺失";
  if (typeof profile.handle !== "string" || !profile.handle.trim()) return "profile.handle 缺失";
  if (typeof profile.bio !== "string" || !profile.bio.trim()) return "profile.bio 缺失";
  if (typeof profile.followers !== "number" || !Number.isFinite(profile.followers)) return "profile.followers 非法";
  if (typeof profile.postKarma !== "number" || !Number.isFinite(profile.postKarma)) return "profile.postKarma 非法";
  if (typeof profile.commentKarma !== "number" || !Number.isFinite(profile.commentKarma)) return "profile.commentKarma 非法";
  if (typeof profile.cakeDay !== "string" || !isIsoTimestamp(profile.cakeDay.trim())) return "profile.cakeDay 非法";
  if (!Array.isArray(record.posts)) return "posts 不是数组";
  if (!Array.isArray(record.comments)) return "comments 不是数组";
  const seen = new Set<string>();
  for (let index = 0; index < record.posts.length; index += 1) {
    const item = record.posts[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `posts[${index}] 不是对象`;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `posts[${index}].id 缺失`;
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.communityName !== "string" || !item.communityName.trim()) return `posts[${index}].communityName 缺失`;
    if (typeof item.title !== "string" || !item.title.trim()) return `posts[${index}].title 缺失`;
    if (typeof item.body !== "string" || !item.body.trim()) return `posts[${index}].body 缺失`;
    if (typeof item.createdAt !== "string" || !isIsoTimestamp(item.createdAt.trim())) return `posts[${index}].createdAt 非法`;
    if (typeof item.upvoteCount !== "number" || !Number.isFinite(item.upvoteCount)) return `posts[${index}].upvoteCount 非法`;
    if (typeof item.commentCount !== "number" || !Number.isFinite(item.commentCount)) return `posts[${index}].commentCount 非法`;
    if (typeof item.viewCount !== "number" || !Number.isFinite(item.viewCount)) return `posts[${index}].viewCount 非法`;
    if (typeof item.innerThought !== "string" || !item.innerThought.trim()) return `posts[${index}].innerThought 缺失`;
  }
  for (let index = 0; index < record.comments.length; index += 1) {
    const item = record.comments[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `comments[${index}] 不是对象`;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `comments[${index}].id 缺失`;
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.communityName !== "string" || !item.communityName.trim()) return `comments[${index}].communityName 缺失`;
    if (typeof item.postTitle !== "string" || !item.postTitle.trim()) return `comments[${index}].postTitle 缺失`;
    if (typeof item.body !== "string" || !item.body.trim()) return `comments[${index}].body 缺失`;
    if (typeof item.createdAt !== "string" || !isIsoTimestamp(item.createdAt.trim())) return `comments[${index}].createdAt 非法`;
    if (typeof item.upvoteCount !== "number" || !Number.isFinite(item.upvoteCount)) return `comments[${index}].upvoteCount 非法`;
    if (typeof item.viewCount !== "number" || !Number.isFinite(item.viewCount)) return `comments[${index}].viewCount 非法`;
    if (typeof item.innerThought !== "string" || !item.innerThought.trim()) return `comments[${index}].innerThought 缺失`;
  }
  return "结构存在字段缺失、时间非法或重复id";
}

type XBlockParseResult = {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
};

function parseXNumericField(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[,\s]/g, "").trim();
  const wanMatch = normalized.match(/^(-?\d+(?:\.\d+)?)万$/);
  if (wanMatch) return Math.round(Number(wanMatch[1]) * 10000);
  return Number(normalized);
}

const X_EXAMPLE_HANDLES = new Set([
  "@qiye_x",
  "@xxxxx",
  "@xxxx",
  "@x_user",
  "@user",
  "@profile",
  "@char_specific_handle",
  "@liked_author_handle",
]);

function isXExampleHandle(handle: string): boolean {
  return X_EXAMPLE_HANDLES.has(handle.toLowerCase()) || /根据角色|示例|专属账号/.test(handle);
}

function deriveXHandleFromName(name: string): string {
  const trimmed = name.trim();
  const latin = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  if (latin) return `@${latin}`;

  const compact = Array.from(trimmed)
    .filter((char) => /[\p{L}\p{N}]/u.test(char))
    .join("")
    .slice(0, 12);
  return compact ? `@${compact}` : "@profile";
}

function normalizeXHandle(rawHandle: string, profileName: string, characterName = ""): string {
  const normalized = rawHandle.trim() ? (rawHandle.trim().startsWith("@") ? rawHandle.trim() : `@${rawHandle.trim()}`) : "";
  if (normalized && !isXExampleHandle(normalized)) return normalized;
  return deriveXHandleFromName(profileName || characterName);
}

function normalizeXExternalHandle(rawHandle: string, displayName: string): string {
  const normalized = rawHandle.trim() ? (rawHandle.trim().startsWith("@") ? rawHandle.trim() : `@${rawHandle.trim()}`) : "";
  if (normalized && !isXExampleHandle(normalized)) return normalized;
  return deriveXHandleFromName(displayName);
}

function parseXBlockPayload(text: string): XBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const sectionMatches = [...source.matchAll(/^#\s*(帖子|回复|媒体|喜欢)\s*$/gm)];
  if (sectionMatches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #帖子 / #回复 / #喜欢 分区" };
  }

  const firstSectionIndex = sectionMatches[0]?.index ?? 0;
  const profileFields = parseTakeoutTaggedFields(source.slice(0, firstSectionIndex).trim());
  const profile = {
    name: profileFields["昵称"] || "",
    handle: profileFields["用户名"] || "",
    bio: profileFields["简介"] || "",
    location: profileFields["地点"] || undefined,
    joinedAt: profileFields["加入时间"] || profileFields["加入"] || undefined,
    followingCount: parseXNumericField(profileFields["关注"]),
    followerCount: parseXNumericField(profileFields["粉丝"]),
  };

  const parseSectionBlocks = (sectionName: "帖子" | "回复" | "媒体" | "喜欢") => {
    const sectionIndex = sectionMatches.findIndex((match) => (match[1] || "").trim() === sectionName);
    if (sectionIndex < 0) return [];
    const current = sectionMatches[sectionIndex];
    const start = (current.index ?? 0) + current[0].length;
    const end = sectionMatches[sectionIndex + 1]?.index ?? source.length;
    const body = source.slice(start, end).trim();
    const matches = [...body.matchAll(/^##\s*(帖子|回复|媒体|喜欢)(\d+)\s*$/gm)];
    return matches.map((currentMatch, index) => {
      const next = matches[index + 1];
      const blockStart = (currentMatch.index ?? 0) + currentMatch[0].length;
      const blockEnd = next?.index ?? body.length;
      return {
        number: Number(currentMatch[2] || index + 1),
        fields: parseTakeoutTaggedFields(body.slice(blockStart, blockEnd).trim()),
      };
    });
  };

  const posts = parseSectionBlocks("帖子").map((entry) => ({
    id: `x_post_${entry.number}`,
    body: entry.fields["正文"] || "",
    mediaDescription: entry.fields["媒体描述"] || undefined,
    createdAt: entry.fields["时间"] || "",
    replyCount: parseXNumericField(entry.fields["回复量"]),
    repostCount: parseXNumericField(entry.fields["转发量"]),
    likeCount: parseXNumericField(entry.fields["点赞量"]),
    viewCount: parseXNumericField(entry.fields["浏览量"]),
    note: entry.fields["感受"] || "",
  }));

  const replies = parseSectionBlocks("回复").map((entry) => ({
    id: `x_reply_${entry.number}`,
    targetName: entry.fields["回复对象"] || "",
    targetSnippet: entry.fields["原帖摘要"] || "",
    body: entry.fields["正文"] || "",
    createdAt: entry.fields["时间"] || "",
    replyCount: parseXNumericField(entry.fields["回复量"]),
    repostCount: parseXNumericField(entry.fields["转发量"]),
    likeCount: parseXNumericField(entry.fields["点赞量"]),
    viewCount: parseXNumericField(entry.fields["浏览量"]),
    note: entry.fields["感受"] || "",
  }));

  const media = parseSectionBlocks("媒体").map((entry) => ({
    id: `x_media_${entry.number}`,
    body: entry.fields["正文"] || "",
    mediaDescription: entry.fields["媒体描述"] || "",
    createdAt: entry.fields["时间"] || "",
    replyCount: parseXNumericField(entry.fields["回复量"]),
    repostCount: parseXNumericField(entry.fields["转发量"]),
    likeCount: parseXNumericField(entry.fields["点赞量"]),
    viewCount: parseXNumericField(entry.fields["浏览量"]),
    note: entry.fields["感受"] || "",
  }));

  const likes = parseSectionBlocks("喜欢").map((entry) => ({
    id: `x_like_${entry.number}`,
    authorName: entry.fields["作者"] || "",
    authorHandle: entry.fields["作者用户名"] || entry.fields["作者账号"] || "",
    body: entry.fields["正文"] || "",
    mediaDescription: entry.fields["媒体描述"] || undefined,
    createdAt: entry.fields["时间"] || "",
    replyCount: parseXNumericField(entry.fields["回复量"]),
    repostCount: parseXNumericField(entry.fields["转发量"]),
    likeCount: parseXNumericField(entry.fields["点赞量"]),
    viewCount: parseXNumericField(entry.fields["浏览量"]),
    likeReason: entry.fields["喜欢原因"] || "",
  }));

  const parsed = {
    headerTitle: "X",
    headerSubtitle: "帖子、回复与喜欢",
    profile,
    posts,
    replies,
    media,
    likes,
  };

  return {
    parsed,
    sanitizedCandidate: JSON.stringify(parsed, null, 2),
    parseMode: "sanitized",
  };
}

function normalizeXPayload(payload: unknown, characterName = ""): CheckPhoneXPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const profileRecord = record.profile && typeof record.profile === "object" ? (record.profile as Record<string, unknown>) : null;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  if (!profileRecord) return null;

  const profileName = typeof profileRecord.name === "string" ? profileRecord.name.trim() : "";
  const profile = {
    name: profileName,
    handle: normalizeXHandle(typeof profileRecord.handle === "string" ? profileRecord.handle : "", profileName, characterName),
    bio: typeof profileRecord.bio === "string" ? profileRecord.bio.trim() : "",
    location:
      typeof profileRecord.location === "string" && profileRecord.location.trim()
        ? profileRecord.location.trim()
        : undefined,
    joinedAt:
      typeof profileRecord.joinedAt === "string" && profileRecord.joinedAt.trim()
        ? profileRecord.joinedAt.trim()
        : undefined,
    followingCount: typeof profileRecord.followingCount === "number" ? profileRecord.followingCount : Number(profileRecord.followingCount),
    followerCount: typeof profileRecord.followerCount === "number" ? profileRecord.followerCount : Number(profileRecord.followerCount),
  };
  if (!profile.name || !profile.handle || !profile.bio || !Number.isFinite(profile.followingCount) || !Number.isFinite(profile.followerCount)) return null;

  const normalizeMetric = (value: unknown) => {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.round(num)) : Number.NaN;
  };

  const posts = (Array.isArray(record.posts) ? record.posts : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const body = typeof item.body === "string" ? item.body.trim() : "";
      const mediaDescription = typeof item.mediaDescription === "string" ? item.mediaDescription.trim() : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const replyCount = normalizeMetric(item.replyCount);
      const repostCount = normalizeMetric(item.repostCount);
      const likeCount = normalizeMetric(item.likeCount);
      const viewCount = normalizeMetric(item.viewCount);
      const note = typeof item.note === "string" ? item.note.trim() : "";
      if (!id || !body || !createdAt || !isIsoTimestamp(createdAt) || !Number.isFinite(replyCount) || !Number.isFinite(repostCount) || !Number.isFinite(likeCount) || !Number.isFinite(viewCount) || !note) return null;
      return { id, body, mediaDescription: mediaDescription || undefined, createdAt, replyCount, repostCount, likeCount, viewCount, note };
    })
    .filter(Boolean) as CheckPhoneXPayload["posts"];

  const replies = (Array.isArray(record.replies) ? record.replies : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const targetName = typeof item.targetName === "string" ? item.targetName.trim() : "";
      const targetSnippet = typeof item.targetSnippet === "string" ? item.targetSnippet.trim() : "";
      const body = typeof item.body === "string" ? item.body.trim() : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const replyCount = normalizeMetric(item.replyCount);
      const repostCount = normalizeMetric(item.repostCount);
      const likeCount = normalizeMetric(item.likeCount);
      const viewCount = normalizeMetric(item.viewCount);
      const note = typeof item.note === "string" ? item.note.trim() : "";
      if (!id || !targetName || !targetSnippet || !body || !createdAt || !isIsoTimestamp(createdAt) || !Number.isFinite(replyCount) || !Number.isFinite(repostCount) || !Number.isFinite(likeCount) || !Number.isFinite(viewCount) || !note) return null;
      return { id, targetName, targetSnippet, body, createdAt, replyCount, repostCount, likeCount, viewCount, note };
    })
    .filter(Boolean) as CheckPhoneXPayload["replies"];

  const media = (Array.isArray(record.media) ? record.media : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const body = typeof item.body === "string" ? item.body.trim() : "";
      const mediaDescription = typeof item.mediaDescription === "string" ? item.mediaDescription.trim() : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const replyCount = normalizeMetric(item.replyCount);
      const repostCount = normalizeMetric(item.repostCount);
      const likeCount = normalizeMetric(item.likeCount);
      const viewCount = normalizeMetric(item.viewCount);
      const note = typeof item.note === "string" ? item.note.trim() : "";
      if (!id || !body || !mediaDescription || !createdAt || !isIsoTimestamp(createdAt) || !Number.isFinite(replyCount) || !Number.isFinite(repostCount) || !Number.isFinite(likeCount) || !Number.isFinite(viewCount) || !note) return null;
      return { id, body, mediaDescription, createdAt, replyCount, repostCount, likeCount, viewCount, note };
    })
    .filter(Boolean) as CheckPhoneXPayload["media"];

  const likes = (Array.isArray(record.likes) ? record.likes : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const authorName = typeof item.authorName === "string" ? item.authorName.trim() : "";
      const authorHandle = normalizeXExternalHandle(typeof item.authorHandle === "string" ? item.authorHandle : "", authorName);
      const body = typeof item.body === "string" ? item.body.trim() : "";
      const mediaDescription = typeof item.mediaDescription === "string" ? item.mediaDescription.trim() : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const replyCount = normalizeMetric(item.replyCount);
      const repostCount = normalizeMetric(item.repostCount);
      const likeCount = normalizeMetric(item.likeCount);
      const viewCount = normalizeMetric(item.viewCount);
      const likeReason = typeof item.likeReason === "string" ? item.likeReason.trim() : "";
      if (!id || !authorName || !authorHandle || !body || !createdAt || !isIsoTimestamp(createdAt) || !Number.isFinite(replyCount) || !Number.isFinite(repostCount) || !Number.isFinite(likeCount) || !Number.isFinite(viewCount) || !likeReason) return null;
      return { id, authorName, authorHandle, body, mediaDescription: mediaDescription || undefined, createdAt, replyCount, repostCount, likeCount, viewCount, likeReason };
    })
    .filter(Boolean) as CheckPhoneXPayload["likes"];

  const seen = new Set<string>();
  for (const item of [...posts, ...replies, ...media, ...likes]) {
    if (seen.has(item.id)) return null;
    seen.add(item.id);
  }

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "X",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "帖子、回复与喜欢",
    profile: {
      ...profile,
      followingCount: Math.max(0, Math.round(profile.followingCount)),
      followerCount: Math.max(0, Math.round(profile.followerCount)),
    },
    posts: posts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    replies: replies.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    media: media.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    likes: likes.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

function diagnoseXNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  if (!record.profile || typeof record.profile !== "object") return "profile 缺失";
  const profile = record.profile as Record<string, unknown>;
  if (typeof profile.name !== "string" || !profile.name.trim()) return "profile.name 缺失";
  if (typeof profile.handle !== "string" || !profile.handle.trim()) return "profile.handle 缺失";
  if (typeof profile.bio !== "string" || !profile.bio.trim()) return "profile.bio 缺失";
  if (typeof profile.followingCount !== "number" || !Number.isFinite(profile.followingCount)) return "profile.followingCount 非法";
  if (typeof profile.followerCount !== "number" || !Number.isFinite(profile.followerCount)) return "profile.followerCount 非法";
  if (!Array.isArray(record.posts)) return "posts 不是数组";
  if (!Array.isArray(record.replies)) return "replies 不是数组";
  if ("media" in record && !Array.isArray(record.media)) return "media 不是数组";
  if (!Array.isArray(record.likes)) return "likes 不是数组";
  const seen = new Set<string>();
  for (const [sectionName, entries] of [
    ["posts", record.posts],
    ["replies", record.replies],
    ["media", Array.isArray(record.media) ? record.media : []],
    ["likes", record.likes],
  ] as const) {
    for (let index = 0; index < entries.length; index += 1) {
      const item = entries[index] as Record<string, unknown>;
      if (!item || typeof item !== "object") return `${sectionName}[${index}] 不是对象`;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id) return `${sectionName}[${index}].id 缺失`;
      if (seen.has(id)) return `存在重复 id: ${id}`;
      seen.add(id);
      if (typeof item.createdAt !== "string" || !isIsoTimestamp(item.createdAt.trim())) return `${sectionName}[${index}].createdAt 非法`;
      if (typeof item.replyCount !== "number" || !Number.isFinite(item.replyCount)) return `${sectionName}[${index}].replyCount 非法`;
      if (typeof item.repostCount !== "number" || !Number.isFinite(item.repostCount)) return `${sectionName}[${index}].repostCount 非法`;
      if (typeof item.likeCount !== "number" || !Number.isFinite(item.likeCount)) return `${sectionName}[${index}].likeCount 非法`;
      if (typeof item.viewCount !== "number" || !Number.isFinite(item.viewCount)) return `${sectionName}[${index}].viewCount 非法`;
      if (sectionName === "likes") {
        if (typeof item.authorHandle !== "string" || !item.authorHandle.trim()) return `likes[${index}].authorHandle 缺失`;
      }
    }
  }
  return "结构存在字段缺失、时间非法或重复id";
}

type YoutubeBlockParseResult = {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
};

function parseYoutubeNumericField(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[,\s次播放订阅者]/g, "").trim();
  const wanMatch = normalized.match(/^(-?\d+(?:\.\d+)?)万$/);
  if (wanMatch) return Math.round(Number(wanMatch[1]) * 10000);
  return Number(normalized);
}

function parseYoutubeSectionEntries(sectionBody: string) {
  const matches = [...sectionBody.matchAll(/^##\s*(视频|频道)(\d+)\s*$/gm)];
  return matches.map((currentMatch, index) => {
    const next = matches[index + 1];
    const blockStart = (currentMatch.index ?? 0) + currentMatch[0].length;
    const blockEnd = next?.index ?? sectionBody.length;
    return {
      kind: currentMatch[1] === "频道" ? "channel" : "video",
      number: Number(currentMatch[2] || index + 1),
      fields: parseTakeoutTaggedFields(sectionBody.slice(blockStart, blockEnd).trim()),
    };
  });
}

function parseYoutubeBlockPayload(text: string): YoutubeBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const sections = [...source.matchAll(/^#\s*(观看记录|稍后观看|赞过的视频|赞过视频|订阅)\s*$/gm)];
  if (sections.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 YouTube 分区" };
  }

  const parseSectionBlocks = (...sectionNames: string[]) => {
    const sectionIndex = sections.findIndex((match) => sectionNames.includes((match[1] || "").trim()));
    if (sectionIndex < 0) return [];
    const current = sections[sectionIndex];
    const start = (current.index ?? 0) + current[0].length;
    const end = sections[sectionIndex + 1]?.index ?? source.length;
    return parseYoutubeSectionEntries(source.slice(start, end).trim());
  };

  const watchHistory = parseSectionBlocks("观看记录")
    .filter((entry) => entry.kind === "video")
    .map((entry) => ({
      id: `youtube_history_${entry.number}`,
      title: entry.fields["标题"] || "",
      channelName: entry.fields["频道"] || "",
      icon: entry.fields["图标"] || "",
      createdAt: entry.fields["时间"] || "",
      durationLabel: entry.fields["时长"] || "",
      playCount: parseYoutubeNumericField(entry.fields["播放量"]),
      progressLabel: entry.fields["看到哪了"] || "",
      stateNote: entry.fields["当时状态"] || "",
      feeling: entry.fields["感受"] || "",
    }));

  const watchLater = parseSectionBlocks("稍后观看")
    .filter((entry) => entry.kind === "video")
    .map((entry) => ({
      id: `youtube_watch_later_${entry.number}`,
      title: entry.fields["标题"] || "",
      channelName: entry.fields["频道"] || "",
      icon: entry.fields["图标"] || "",
      createdAt: entry.fields["时间"] || "",
      durationLabel: entry.fields["时长"] || "",
      playCount: parseYoutubeNumericField(entry.fields["播放量"]),
      stateNote: entry.fields["当时状态"] || entry.fields["稍后原因"] || "",
      feeling: entry.fields["感受"] || "",
    }));

  const likedVideos = parseSectionBlocks("赞过的视频", "赞过视频")
    .filter((entry) => entry.kind === "video")
    .map((entry) => ({
      id: `youtube_liked_${entry.number}`,
      title: entry.fields["标题"] || "",
      channelName: entry.fields["频道"] || "",
      icon: entry.fields["图标"] || "",
      createdAt: entry.fields["时间"] || "",
      durationLabel: entry.fields["时长"] || "",
      playCount: parseYoutubeNumericField(entry.fields["播放量"]),
      stateNote: entry.fields["当时状态"] || entry.fields["喜欢原因"] || "",
      feeling: entry.fields["感受"] || "",
    }));

  const parsed = {
    headerTitle: "YouTube",
    headerSubtitle: "History, Watch later, Liked videos",
    watchHistory,
    watchLater,
    likedVideos,
  };

  return {
    parsed,
    sanitizedCandidate: JSON.stringify(parsed, null, 2),
    parseMode: "sanitized",
  };
}

function normalizeYoutubePayload(payload: unknown): CheckPhoneYoutubePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  const profileRecord = record.profile && typeof record.profile === "object" ? (record.profile as Record<string, unknown>) : null;
  const profile = profileRecord
    ? {
        name: typeof profileRecord.name === "string" ? profileRecord.name.trim() : "",
        handle: typeof profileRecord.handle === "string" ? profileRecord.handle.trim() : "",
        bio: typeof profileRecord.bio === "string" ? profileRecord.bio.trim() : "",
        lastActiveAt: typeof profileRecord.lastActiveAt === "string" ? profileRecord.lastActiveAt.trim() : "",
      }
    : undefined;

  const normalizeVideo = (entry: unknown, fallbackId: string, options?: { requireProgress?: boolean }) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : fallbackId;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const channelName = typeof item.channelName === "string" ? item.channelName.trim() : "";
    const icon = typeof item.icon === "string" && item.icon.trim() ? item.icon.trim() : undefined;
    const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
    const durationLabel = typeof item.durationLabel === "string" ? item.durationLabel.trim() : "";
    const playCount = typeof item.playCount === "number" ? item.playCount : Number(item.playCount);
    const progressLabel = typeof item.progressLabel === "string" ? item.progressLabel.trim() : "";
    const stateNote = typeof item.stateNote === "string"
      ? item.stateNote.trim()
      : typeof item.saveReason === "string"
        ? item.saveReason.trim()
        : "";
    const feeling = typeof item.feeling === "string" ? item.feeling.trim() : "";
    if (!id || !title || !channelName || !createdAt || !isIsoTimestamp(createdAt) || !durationLabel || !Number.isFinite(playCount) || !stateNote || !feeling) return null;
    if (options?.requireProgress && !progressLabel) return null;
    return {
      id,
      title,
      channelName,
      icon,
      createdAt,
      durationLabel,
      playCount: Math.max(0, Math.round(playCount)),
      progressLabel,
      stateNote,
      feeling,
    };
  };

  const watchHistory = (Array.isArray(record.watchHistory) ? record.watchHistory : [])
    .map((entry, index) => normalizeVideo(entry, `youtube_history_${index + 1}`, { requireProgress: true }))
    .filter(Boolean) as CheckPhoneYoutubePayload["watchHistory"];

  const watchLater = (Array.isArray(record.watchLater) ? record.watchLater : [])
    .map((entry, index) => normalizeVideo(entry, `youtube_watch_later_${index + 1}`))
    .filter(Boolean) as CheckPhoneYoutubePayload["watchLater"];

  const likedVideos = (Array.isArray(record.likedVideos) ? record.likedVideos : Array.isArray(record.likes) ? record.likes : [])
    .map((entry, index) => normalizeVideo(entry, `youtube_liked_${index + 1}`))
    .filter(Boolean) as CheckPhoneYoutubePayload["likedVideos"];

  if (watchHistory.length === 0 || watchLater.length === 0 || likedVideos.length === 0) return null;

  const seen = new Set<string>();
  for (const item of [...watchHistory, ...watchLater, ...likedVideos]) {
    if (seen.has(item.id)) return null;
    seen.add(item.id);
  }

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "YouTube",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "History, Watch later, Liked videos",
    profile,
    watchHistory: watchHistory.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    watchLater: watchLater.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    likedVideos: likedVideos.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

function diagnoseYoutubeNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  if (!Array.isArray(record.watchHistory)) return "watchHistory 不是数组";
  if (!Array.isArray(record.watchLater)) return "watchLater 不是数组";
  if (!Array.isArray(record.likedVideos)) return "likedVideos 不是数组";

  const diagnoseVideo = (item: Record<string, unknown>, label: string) => {
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `${label}.id 缺失`;
    if (typeof item.title !== "string" || !item.title.trim()) return `${label}.title 缺失`;
    if (typeof item.channelName !== "string" || !item.channelName.trim()) return `${label}.channelName 缺失`;
    if (typeof item.createdAt !== "string" || !isIsoTimestamp(item.createdAt.trim())) return `${label}.createdAt 非法`;
    if (typeof item.durationLabel !== "string" || !item.durationLabel.trim()) return `${label}.durationLabel 缺失`;
    if (typeof item.playCount !== "number" || !Number.isFinite(item.playCount)) return `${label}.playCount 非法`;
    if (typeof item.stateNote !== "string" || !item.stateNote.trim()) return `${label}.stateNote 缺失`;
    if (typeof item.feeling !== "string" || !item.feeling.trim()) return `${label}.feeling 缺失`;
    return null;
  };

  const seen = new Set<string>();
  for (let index = 0; index < record.watchHistory.length; index += 1) {
    const item = record.watchHistory[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `watchHistory[${index}] 不是对象`;
    const issue = diagnoseVideo(item, `watchHistory[${index}]`);
    if (issue) return issue;
    const id = (item.id as string).trim();
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.progressLabel !== "string" || !item.progressLabel.trim()) return `watchHistory[${index}].progressLabel 缺失`;
  }
  for (let index = 0; index < record.watchLater.length; index += 1) {
    const item = record.watchLater[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `watchLater[${index}] 不是对象`;
    const issue = diagnoseVideo(item, `watchLater[${index}]`);
    if (issue) return issue;
    const id = (item.id as string).trim();
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
  }
  for (let index = 0; index < record.likedVideos.length; index += 1) {
    const item = record.likedVideos[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `likedVideos[${index}] 不是对象`;
    const issue = diagnoseVideo(item, `likedVideos[${index}]`);
    if (issue) return issue;
    const id = (item.id as string).trim();
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
  }
  return "结构存在字段缺失、时间非法或重复id";
}

type InstagramBlockParseResult = {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
};

function parseInstagramNumericField(value: string | undefined): number {
  if (!value) return Number.NaN;
  const normalized = value.replace(/[,\s]/g, "").trim();
  const wanMatch = normalized.match(/^(-?\d+(?:\.\d+)?)万$/);
  if (wanMatch) return Math.round(Number(wanMatch[1]) * 10000);
  return Number(normalized);
}

function parseInstagramComments(
  fields: Record<string, string>,
  postNumber: number,
): CheckPhoneInstagramPayload["posts"][number]["comments"] {
  const indexes = [...new Set(
    Object.keys(fields)
      .map((key) => key.match(/^评论(\d+)(用户名|内容|时间)$/)?.[1] ?? "")
      .filter(Boolean),
  )]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  const comments: CheckPhoneInstagramPayload["posts"][number]["comments"] = [];
  for (const index of indexes) {
    const authorName = fields[`评论${index}用户名`]?.trim() || "";
    const text = fields[`评论${index}内容`]?.trim() || "";
    const createdAt = fields[`评论${index}时间`]?.trim() || "";
    if (!authorName || !text || !createdAt) continue;
    comments.push({
      id: `ig_post_${postNumber}_comment_${index}`,
      authorName,
      text,
      createdAt,
      likeCount: parseInstagramNumericField(fields[`评论${index}点赞量`]),
    });
  }
  return comments;
}

function parseInstagramHighlights(sectionBody: string): CheckPhoneInstagramPayload["highlights"] {
  const highlightMatches = [...sectionBody.matchAll(/^##\s*精选(?:动态)?(\d+)\s*$/gm)];
  const highlights: CheckPhoneInstagramPayload["highlights"] = [];

  for (let index = 0; index < highlightMatches.length; index += 1) {
    const current = highlightMatches[index];
    const next = highlightMatches[index + 1];
    if (!current || current.index === undefined) continue;
    const number = Number(current[1] || index + 1);
    const start = current.index + current[0].length;
    const end = next?.index ?? sectionBody.length;
    const fields = parseDouyinTaggedFields(sectionBody.slice(start, end).trim());
    const title = fields["标题"]?.trim() || "";
    const coverIcon = fields["图标"]?.trim() || "";
    const description = fields["内容"]?.trim() || fields["描述"]?.trim() || "";
    if (!title || !coverIcon || !description) continue;
    highlights.push({
      id: `ig_highlight_${number}`,
      title,
      coverIcon,
      description,
    });
  }

  return highlights;
}

function parseInstagramBlockPayload(text: string): InstagramBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const postSectionMatches = [...source.matchAll(/^#\s*帖子\s*$/gm)];
  if (postSectionMatches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #帖子 分区" };
  }
  const highlightSectionMatches = [...source.matchAll(/^#\s*精选动态\s*$/gm)];

  const postSectionIndex = postSectionMatches[0]?.index ?? 0;
  const highlightSection = highlightSectionMatches[0];
  const highlightSectionIndex = highlightSection?.index;
  const firstSectionIndex = Math.min(postSectionIndex, highlightSectionIndex ?? postSectionIndex);
  const profileFields = parseDouyinTaggedFields(source.slice(0, firstSectionIndex).trim());
  const profile = {
    name: profileFields["昵称"] || "",
    username: profileFields["用户名"] || "",
    bio: profileFields["简介"] || "",
    followingCount: parseInstagramNumericField(profileFields["关注"]),
    followerCount: parseInstagramNumericField(profileFields["粉丝"]),
  };

  const highlights = highlightSectionIndex === undefined
    ? []
    : parseInstagramHighlights(source.slice(
      highlightSectionIndex + (highlightSection?.[0].length ?? 0),
      postSectionIndex,
    ).trim());

  const sectionBody = source.slice(postSectionIndex + postSectionMatches[0][0].length).trim();
  const postMatches = [...sectionBody.matchAll(/^##\s*帖子(\d+)\s*$/gm)];
  const posts: CheckPhoneInstagramPayload["posts"] = [];

  for (let index = 0; index < postMatches.length; index += 1) {
    const current = postMatches[index];
    const next = postMatches[index + 1];
    if (!current || current.index === undefined) continue;
    const number = Number(current[1] || index + 1);
    const start = current.index + current[0].length;
    const end = next?.index ?? sectionBody.length;
    const fields = parseDouyinTaggedFields(sectionBody.slice(start, end).trim());
    posts.push({
      id: `ig_post_${number}`,
      coverIcon: fields["图标"] || "",
      imageDescription: fields["画面描述"] || undefined,
      createdAt: fields["发帖时间"] || fields["时间"] || "",
      location: fields["地点"] || undefined,
      caption: fields["正文"] || "",
      likeCount: parseInstagramNumericField(fields["点赞量"]),
      commentCount: parseInstagramNumericField(fields["评论量"]),
      shareCount: parseInstagramNumericField(fields["分享量"]),
      comments: parseInstagramComments(fields, number),
    });
  }

  const parsed = {
    headerTitle: "Instagram",
    headerSubtitle: "主页与帖子",
    profile,
    highlights,
    posts,
  };

  return {
    parsed,
    sanitizedCandidate: JSON.stringify(parsed, null, 2),
    parseMode: "sanitized",
  };
}

function normalizeInstagramPayload(payload: unknown): CheckPhoneInstagramPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const profileRecord = record.profile && typeof record.profile === "object" ? (record.profile as Record<string, unknown>) : null;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  if (!profileRecord) return null;

  const profile = {
    name: typeof profileRecord.name === "string" ? profileRecord.name.trim() : "",
    username: typeof profileRecord.username === "string" ? profileRecord.username.trim() : "",
    bio: typeof profileRecord.bio === "string" ? profileRecord.bio.trim() : "",
    followingCount: typeof profileRecord.followingCount === "number" ? profileRecord.followingCount : Number(profileRecord.followingCount),
    followerCount: typeof profileRecord.followerCount === "number" ? profileRecord.followerCount : Number(profileRecord.followerCount),
  };
  if (!profile.name || !profile.username || !profile.bio || !Number.isFinite(profile.followingCount) || !Number.isFinite(profile.followerCount)) return null;

  const posts = (Array.isArray(record.posts) ? record.posts : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const coverIcon = typeof item.coverIcon === "string" ? item.coverIcon.trim() : "";
      const imageDescription = typeof item.imageDescription === "string" ? item.imageDescription.trim() : "";
      const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
      const location = typeof item.location === "string" ? item.location.trim() : "";
      const caption = typeof item.caption === "string" ? item.caption.trim() : "";
      const likeCount = typeof item.likeCount === "number" ? item.likeCount : Number(item.likeCount);
      const commentCount = typeof item.commentCount === "number" ? item.commentCount : Number(item.commentCount);
      const shareCount = typeof item.shareCount === "number" ? item.shareCount : Number(item.shareCount);
      const comments = (Array.isArray(item.comments) ? item.comments : [])
        .map((commentEntry) => {
          if (!commentEntry || typeof commentEntry !== "object") return null;
          const comment = commentEntry as Record<string, unknown>;
          const commentId = typeof comment.id === "string" ? comment.id.trim() : "";
          const authorName = typeof comment.authorName === "string" ? comment.authorName.trim() : "";
          const text = typeof comment.text === "string" ? comment.text.trim() : "";
          const commentCreatedAt = typeof comment.createdAt === "string" ? comment.createdAt.trim() : "";
          const commentLikeCount = typeof comment.likeCount === "number" ? comment.likeCount : Number(comment.likeCount);
          if (!commentId || !authorName || !text || !commentCreatedAt || !isIsoTimestamp(commentCreatedAt)) return null;
          return {
            id: commentId,
            authorName,
            text,
            createdAt: commentCreatedAt,
            likeCount: Number.isFinite(commentLikeCount) ? Math.max(0, Math.round(commentLikeCount)) : undefined,
          };
        })
        .filter(Boolean) as CheckPhoneInstagramPayload["posts"][number]["comments"];
      if (!id || !coverIcon || !createdAt || !isIsoTimestamp(createdAt) || !caption || !Number.isFinite(likeCount)) return null;
      return {
        id,
        coverIcon,
        imageDescription: imageDescription || undefined,
        createdAt,
        location: location || undefined,
        caption,
        likeCount: Math.max(0, Math.round(likeCount)),
        commentCount: Number.isFinite(commentCount) ? Math.max(0, Math.round(commentCount)) : comments.length,
        shareCount: Number.isFinite(shareCount) ? Math.max(0, Math.round(shareCount)) : 0,
        comments: comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
      };
    })
    .filter(Boolean) as CheckPhoneInstagramPayload["posts"];

  const seen = new Set<string>();
  for (const item of posts) {
    if (seen.has(item.id)) return null;
    seen.add(item.id);
    for (const comment of item.comments) {
      if (seen.has(comment.id)) return null;
      seen.add(comment.id);
    }
  }

  const explicitHighlights = (Array.isArray(record.highlights) ? record.highlights : [])
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `ig_highlight_${index + 1}`;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const coverIcon = typeof item.coverIcon === "string" ? item.coverIcon.trim() : "";
      const description = typeof item.description === "string" ? item.description.trim() : "";
      if (!title || !coverIcon || !description) return null;
      return {
        id,
        title,
        coverIcon,
        description,
      };
    })
    .filter(Boolean) as CheckPhoneInstagramPayload["highlights"];

  const fallbackHighlights: CheckPhoneInstagramPayload["highlights"] = posts.slice(0, 5).map((post, index) => ({
    id: `ig_highlight_fallback_${index + 1}`,
    title: post.imageDescription?.split(/\s+/)[0] || post.location || "post",
    coverIcon: post.coverIcon,
    description: post.imageDescription || post.caption,
  }));

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "Instagram",
    headerSubtitle: typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "主页与帖子",
    profile,
    highlights: (explicitHighlights.length ? explicitHighlights : fallbackHighlights).slice(0, 5),
    posts: posts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

function diagnoseInstagramNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  if (!record.profile || typeof record.profile !== "object") return "profile 缺失";
  const profile = record.profile as Record<string, unknown>;
  if (typeof profile.name !== "string" || !profile.name.trim()) return "profile.name 缺失";
  if (typeof profile.username !== "string" || !profile.username.trim()) return "profile.username 缺失";
  if (typeof profile.bio !== "string" || !profile.bio.trim()) return "profile.bio 缺失";
  if (typeof profile.followingCount !== "number" || !Number.isFinite(profile.followingCount)) return "profile.followingCount 非法";
  if (typeof profile.followerCount !== "number" || !Number.isFinite(profile.followerCount)) return "profile.followerCount 非法";
  if (!Array.isArray(record.posts)) return "posts 不是数组";
  const seen = new Set<string>();
  for (let index = 0; index < record.posts.length; index += 1) {
    const item = record.posts[index] as Record<string, unknown>;
    if (!item || typeof item !== "object") return `posts[${index}] 不是对象`;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return `posts[${index}].id 缺失`;
    if (seen.has(id)) return `存在重复 id: ${id}`;
    seen.add(id);
    if (typeof item.coverIcon !== "string" || !item.coverIcon.trim()) return `posts[${index}].coverIcon 缺失`;
    if (typeof item.createdAt !== "string" || !isIsoTimestamp(item.createdAt.trim())) return `posts[${index}].createdAt 非法`;
    if (typeof item.caption !== "string" || !item.caption.trim()) return `posts[${index}].caption 缺失`;
    if (typeof item.likeCount !== "number" || !Number.isFinite(item.likeCount)) return `posts[${index}].likeCount 非法`;
    if (!Array.isArray(item.comments)) return `posts[${index}].comments 不是数组`;
  }
  return "结构存在字段缺失、时间非法或重复id";
}

function buildEmailPreview(body: string): string {
  const previewSource = splitBilingualText(body)?.original ?? normalizeBilingualTextInput(body);
  const lines = previewSource
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  const preview = lines.join(" ");
  return preview.length > 120 ? `${preview.slice(0, 117).trimEnd()}...` : preview;
}

function normalizeDouyinPayload(payload: unknown, characterName = ""): CheckPhoneDouyinPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const profileRaw = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
  if (!profileRaw) return null;

  const profileName = typeof profileRaw.name === "string" ? profileRaw.name.trim() : "";
  const handle = typeof profileRaw.handle === "string" ? profileRaw.handle.trim() : "";
  const bio = typeof profileRaw.bio === "string" ? profileRaw.bio.trim() : "";
  const likesTotal = normalizeOptionalDouyinCount(profileRaw.likesTotal);
  const mutualFollowCount = normalizeOptionalDouyinCount(profileRaw.mutualFollowCount);
  const followingCount = normalizeOptionalDouyinCount(profileRaw.followingCount);
  const followerCount = normalizeOptionalDouyinCount(profileRaw.followerCount);
  if (!profileName) {
    return null;
  }

  const normalizedCharacterName = characterName.trim();
  const replaceCharacterName = (name: string) => {
    const trimmed = name.trim();
    if (!normalizedCharacterName || !trimmed) return name;
    const unprefixedName = trimmed.replace(/^@+/, "");
    return trimmed === normalizedCharacterName || unprefixedName === normalizedCharacterName
      ? profileName
      : name;
  };

  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  const normalizeComment = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const authorName = typeof item.authorName === "string" ? replaceCharacterName(item.authorName.trim()) : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
    const replyTo =
      typeof item.replyTo === "string" && item.replyTo.trim()
        ? replaceCharacterName(item.replyTo.trim())
        : undefined;
    const replyToCommentId =
      typeof item.replyToCommentId === "string" && item.replyToCommentId.trim()
        ? item.replyToCommentId.trim()
        : undefined;
    if (!id || !authorName || !text || !createdAt || !isIsoTimestamp(createdAt)) return null;
    return { id, authorName, text, createdAt, replyTo, replyToCommentId };
  };

  const normalizeVideo = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const authorName = typeof item.authorName === "string" ? replaceCharacterName(item.authorName.trim()) : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const caption = typeof item.caption === "string" ? item.caption.trim() : "";
    const videoDescription =
      typeof item.videoDescription === "string" ? item.videoDescription.trim() : "";
    const coverIcon = typeof item.coverIcon === "string" ? item.coverIcon.trim() : "";
    const tone =
      item.tone === "ivory" || item.tone === "mist" || item.tone === "blush" || item.tone === "graphite"
        ? item.tone
        : null;
    const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
    const playCount = normalizeOptionalDouyinCount(item.playCount);
    const likeCount = normalizeOptionalDouyinCount(item.likeCount);
    const commentCount = normalizeOptionalDouyinCount(item.commentCount);
    const saveCount = normalizeOptionalDouyinCount(item.saveCount);
    const comments = (Array.isArray(item.comments) ? item.comments : [])
      .map((comment) => normalizeComment(comment))
      .filter(Boolean) as CheckPhoneDouyinPayload["works"][number]["comments"];

    if (
      !id ||
      !title ||
      !caption ||
      !tone ||
      !createdAt ||
      !isIsoTimestamp(createdAt)
    ) {
      return null;
    }

    const uniqueCommentIds = new Set<string>();
    const uniqueComments = comments.filter((comment) => {
      if (uniqueCommentIds.has(comment.id)) return false;
      uniqueCommentIds.add(comment.id);
      return true;
    });

    return {
      id,
      ...(authorName ? { authorName } : {}),
      title,
      caption,
      ...(videoDescription ? { videoDescription } : {}),
      ...(coverIcon ? { coverIcon } : {}),
      tone,
      createdAt,
      ...(playCount === undefined ? {} : { playCount }),
      ...(likeCount === undefined ? {} : { likeCount }),
      commentCount: commentCount ?? uniqueComments.length,
      ...(saveCount === undefined ? {} : { saveCount }),
      comments: uniqueComments.slice(0, 16),
    };
  };

  const works = (Array.isArray(record.works) ? record.works : [])
    .map((item) => normalizeVideo(item))
    .filter(Boolean) as CheckPhoneDouyinPayload["works"];
  const savedVideos = (Array.isArray(record.savedVideos) ? record.savedVideos : [])
    .map((item) => normalizeVideo(item))
    .filter(Boolean) as CheckPhoneDouyinPayload["savedVideos"];
  const likedVideos = (Array.isArray(record.likedVideos) ? record.likedVideos : [])
    .map((item) => normalizeVideo(item))
    .filter(Boolean) as CheckPhoneDouyinPayload["likedVideos"];

  const uniqueVideoIds = new Set<string>();
  const keepUniqueVideos = <T extends CheckPhoneDouyinPayload["works"]>(videos: T): T =>
    videos.filter((video) => {
      if (uniqueVideoIds.has(video.id)) return false;
      uniqueVideoIds.add(video.id);
      return true;
    }) as T;

  const uniqueWorks = keepUniqueVideos(works);
  const uniqueSavedVideos = keepUniqueVideos(savedVideos);
  const uniqueLikedVideos = keepUniqueVideos(likedVideos);
  if (uniqueWorks.length + uniqueSavedVideos.length + uniqueLikedVideos.length === 0) {
    return null;
  }

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "抖音",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "作品、收藏与喜欢",
    profile: {
      name: profileName,
      handle,
      bio,
      ...(likesTotal === undefined ? {} : { likesTotal }),
      ...(mutualFollowCount === undefined ? {} : { mutualFollowCount }),
      ...(followingCount === undefined ? {} : { followingCount }),
      ...(followerCount === undefined ? {} : { followerCount }),
    },
    works: uniqueWorks
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 12),
    savedVideos: uniqueSavedVideos
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 12),
    likedVideos: uniqueLikedVideos
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 12),
  };
}

type DouyinBlockParseResult = {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
};

function parseDouyinBlockPayload(text: string): DouyinBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) {
    return {
      parsed: null,
      sanitizedCandidate: "",
      parseMode: "failed",
      parseError: "LLM 返回为空",
    };
  }

  const sectionMatches = [...source.matchAll(/^#\s*(作品|喜欢|收藏)\s*$/gm)];
  if (sectionMatches.length === 0) {
    return {
      parsed: null,
      sanitizedCandidate: source,
      parseMode: "failed",
      parseError: "未找到 #作品 / #喜欢 / #收藏 分区",
    };
  }

  const firstSectionIndex = sectionMatches[0]?.index ?? 0;
  const profileBlock = source.slice(0, firstSectionIndex).trim();
  const profileFields = parseDouyinTaggedFields(profileBlock);

  const profile = {
    name: profileFields["昵称"] || "",
    handle: profileFields["抖音号"] || "",
    bio: profileFields["简介"] || "",
    likesTotal: parseDouyinNumericField(profileFields["获赞"]),
    mutualFollowCount: parseDouyinNumericField(profileFields["互关"]),
    followingCount: parseDouyinNumericField(profileFields["关注"]),
    followerCount: parseDouyinNumericField(profileFields["粉丝"]),
  };

  const sectionMap: Record<string, "works" | "likedVideos" | "savedVideos"> = {
    作品: "works",
    喜欢: "likedVideos",
    收藏: "savedVideos",
  };

  const result: Record<string, unknown> = {
    headerTitle: "抖音",
    headerSubtitle: "作品、收藏与喜欢",
    profile,
    works: [],
    likedVideos: [],
    savedVideos: [],
  };

  const toneCycles: Record<"works" | "likedVideos" | "savedVideos", CheckPhoneDouyinTone[]> = {
    works: ["graphite", "mist", "ivory", "blush"],
    likedVideos: ["blush", "mist", "graphite", "ivory"],
    savedVideos: ["mist", "ivory", "graphite", "blush"],
  };

  for (let sectionIndex = 0; sectionIndex < sectionMatches.length; sectionIndex += 1) {
    const current = sectionMatches[sectionIndex];
    const next = sectionMatches[sectionIndex + 1];
    if (!current || current.index === undefined) continue;
    const sectionName = current[1];
    const targetKey = sectionMap[sectionName];
    if (!targetKey) continue;
    const start = current.index + current[0].length;
    const end = next?.index ?? source.length;
    const sectionBody = source.slice(start, end).trim();
    const posts = parseDouyinSectionPosts(sectionBody, targetKey, toneCycles[targetKey]);
    result[targetKey] = posts;
  }

  return {
    parsed: result,
    sanitizedCandidate: JSON.stringify(result, null, 2),
    parseMode: "sanitized",
  };
}

function parseDouyinTaggedFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = block.split("\n");
  let currentKey = "";
  let buffer: string[] = [];

  const flush = () => {
    if (!currentKey) return;
    fields[currentKey] = buffer.join("\n").trim();
    currentKey = "";
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      flush();
      currentKey = match[1]?.trim() || "";
      buffer = [match[2] ?? ""];
      continue;
    }
    if (!currentKey) continue;
    if (!line.trim()) {
      buffer.push("");
      continue;
    }
    buffer.push(line);
  }

  flush();
  return fields;
}

function parseDouyinNumericField(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== "string") return Number.NaN;
  const compact = value.replace(/[,，\s]/g, "").trim();
  const match = compact.match(/^(-?\d+(?:\.\d+)?)([kKwW千萬万])?/);
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return Number.NaN;
  const unit = match[2];
  if (unit === "k" || unit === "K" || unit === "千") return Math.round(amount * 1000);
  if (unit === "w" || unit === "W" || unit === "万" || unit === "萬") return Math.round(amount * 10000);
  return amount;
}

function normalizeOptionalDouyinCount(value: unknown): number | undefined {
  const parsed = parseDouyinNumericField(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : undefined;
}

function parseDouyinSectionPosts(
  sectionBody: string,
  targetKey: "works" | "likedVideos" | "savedVideos",
  tones: CheckPhoneDouyinTone[],
): CheckPhoneDouyinPayload["works"] {
  const matches = [...sectionBody.matchAll(/^##\s*帖子(\d+)\s*$/gm)];
  if (matches.length === 0) return [];

  const items: CheckPhoneDouyinPayload["works"] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    if (!current || current.index === undefined) continue;
    const number = Number(current[1] || index + 1);
    const start = current.index + current[0].length;
    const end = next?.index ?? sectionBody.length;
    const block = sectionBody.slice(start, end).trim();
    const fields = parseDouyinTaggedFields(block);
    const authorName = fields["博主"] || fields["作者"] || "";
    const title = fields["帖子标题"] || "";
    const caption = fields["帖子正文"] || "";
    const videoDescription = fields["视频描述"] || "";
    const coverIcon = fields["图标"] || "";
    const createdAt = fields["发帖时间"] || fields["时间"] || "";
    const playCount = parseDouyinNumericField(fields["播放量"]);
    const likeCount = parseDouyinNumericField(fields["点赞量"]);
    const commentCount = parseDouyinNumericField(fields["评论量"]);
    const saveCount = parseDouyinNumericField(fields["收藏量"]);

    const comments = parseDouyinBlockComments(fields, `${targetKey}_${number}`);

    items.push({
      id: `dy_${targetKey}_${number}`,
      ...(authorName ? { authorName } : {}),
      title,
      caption,
      ...(videoDescription ? { videoDescription } : {}),
      ...(coverIcon ? { coverIcon } : {}),
      tone: tones[index % tones.length] ?? "mist",
      createdAt,
      playCount,
      likeCount,
      commentCount: Number.isFinite(commentCount) ? Math.max(0, Math.round(commentCount)) : comments.length,
      saveCount,
      comments,
    });
  }
  return items;
}

function parseDouyinBlockComments(
  fields: Record<string, string>,
  prefix: string,
): CheckPhoneDouyinComment[] {
  const commentIndexes = [...new Set(
    Object.keys(fields)
      .map((key) => key.match(/^评论(\d+)(用户名|内容|时间)$/)?.[1] ?? "")
      .filter(Boolean),
  )]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const authorByIndex = new Map(
    commentIndexes.map((index) => [index, fields[`评论${index}用户名`]?.trim() || ""]),
  );
  const availableIndexes = new Set(commentIndexes);

  const comments: CheckPhoneDouyinComment[] = [];
  for (const index of commentIndexes) {
    const authorName = fields[`评论${index}用户名`]?.trim() || "";
    const text = fields[`评论${index}内容`]?.trim() || "";
    const createdAt = fields[`评论${index}时间`]?.trim() || "";
    if (!authorName || !text || !createdAt) continue;
    const replyTarget = fields[`评论${index}回复对象`]?.trim() || "";
    const replyTargetIndex = Number(
      replyTarget.match(/^评论\s*(\d+)$/)?.[1] ?? replyTarget.match(/^(\d+)$/)?.[1] ?? NaN,
    );
    const replyToCommentId =
      Number.isFinite(replyTargetIndex) &&
      replyTargetIndex > 0 &&
      replyTargetIndex < index &&
      availableIndexes.has(replyTargetIndex)
        ? `${prefix}_comment_${replyTargetIndex}`
        : undefined;
    const replyTo =
      replyToCommentId && Number.isFinite(replyTargetIndex)
        ? authorByIndex.get(replyTargetIndex) || undefined
        : undefined;
    comments.push({
      id: `${prefix}_comment_${index}`,
      authorName,
      text,
      createdAt,
      ...(replyTo ? { replyTo } : {}),
      ...(replyToCommentId ? { replyToCommentId } : {}),
    });
  }
  return comments;
}

export async function generateCheckPhoneDouyin(
  characterId: string,
  previousPayload?: CheckPhoneDouyinPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneDouyinPayload | null; summary: string; error?: string; debugRawOutput?: string; debugSanitizedOutput?: string; debugParseMode?: "raw" | "sanitized" | "failed"; debugParseError?: string; debugNormalizeError?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "douyin", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const characterName = loadCharacters().find((item) => item.id === characterId)?.name ?? "";
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName },
      { skipOutputRegex: true, appId: "checkphone_douyin" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseDouyinBlockPayload(rawOutput);
    const payload = normalizeDouyinPayload(parsed, characterName);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析抖音内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseDouyinNormalizeFailure(parsed) : undefined,
      };
    }
    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

export async function generateCheckPhoneInstagram(
  characterId: string,
  previousPayload?: CheckPhoneInstagramPayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneInstagramPayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugSanitizedOutput?: string;
  debugParseMode?: "raw" | "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "instagram", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_instagram" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseInstagramBlockPayload(rawOutput);
    const payload = normalizeInstagramPayload(parsed);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析 Instagram 内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseInstagramNormalizeFailure(parsed) : undefined,
      };
    }

    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

function diagnoseDouyinNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  const profile = record.profile && typeof record.profile === "object" ? (record.profile as Record<string, unknown>) : null;
  if (!profile) return "缺少 profile 对象";
  if (typeof profile.name !== "string" || !profile.name.trim()) return "profile.name 缺失";

  const validTone = (value: unknown) =>
    value === "ivory" || value === "mist" || value === "blush" || value === "graphite";
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));

  const diagnoseVideoList = (label: string, input: unknown): string | null => {
    if (!Array.isArray(input)) return `${label} 不是数组`;
    for (let index = 0; index < input.length; index += 1) {
      const entry = input[index];
      if (!entry || typeof entry !== "object") return `${label}[${index}] 不是对象`;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id) return `${label}[${index}].id 缺失`;
      if (typeof item.title !== "string" || !item.title.trim()) return `${label}[${index}].title 缺失`;
      if (typeof item.caption !== "string" || !item.caption.trim()) return `${label}[${index}].caption 缺失`;
      if (!validTone(item.tone)) return `${label}[${index}].tone 非法`;
      if (typeof item.createdAt !== "string" || !isIsoTimestamp(item.createdAt.trim())) return `${label}[${index}].createdAt 非法`;
      if (!Array.isArray(item.comments)) return `${label}[${index}].comments 不是数组`;
      for (let commentIndex = 0; commentIndex < item.comments.length; commentIndex += 1) {
        const comment = item.comments[commentIndex];
        if (!comment || typeof comment !== "object") return `${label}[${index}].comments[${commentIndex}] 不是对象`;
        const commentRecord = comment as Record<string, unknown>;
        const commentId = typeof commentRecord.id === "string" ? commentRecord.id.trim() : "";
        if (!commentId) return `${label}[${index}].comments[${commentIndex}].id 缺失`;
        if (typeof commentRecord.authorName !== "string" || !commentRecord.authorName.trim()) {
          return `${label}[${index}].comments[${commentIndex}].authorName 缺失`;
        }
        if (typeof commentRecord.text !== "string" || !commentRecord.text.trim()) {
          return `${label}[${index}].comments[${commentIndex}].text 缺失`;
        }
        if (typeof commentRecord.createdAt !== "string" || !isIsoTimestamp(commentRecord.createdAt.trim())) {
          return `${label}[${index}].comments[${commentIndex}].createdAt 非法`;
        }
      }
    }
    return null;
  };

  return (
    diagnoseVideoList("works", record.works) ||
    diagnoseVideoList("savedVideos", record.savedVideos) ||
    diagnoseVideoList("likedVideos", record.likedVideos) ||
    "没有可展示的有效帖子"
  );
}

function normalizeTelegramPayload(payload: unknown): CheckPhoneTelegramPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));

  const normalizeLastStatus = (value: unknown): CheckPhoneTelegramPayload["threads"][number]["lastStatus"] => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (normalized === "sent" || normalized === "read" || normalized === "none") return normalized;
    return undefined;
  };

  const normalizeMessageType = (value: unknown): CheckPhoneTelegramPayload["threads"][number]["messages"][number]["messageType"] => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (normalized === "voice" || normalized === "thinking" || normalized === "text") return normalized;
    return "text";
  };

  const normalizeMessage = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const authorName = typeof item.authorName === "string" ? item.authorName.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
    const direction = item.direction === "incoming" || item.direction === "outgoing" ? item.direction : null;
    const messageType = normalizeMessageType(item.messageType);
    const replyTitle = typeof item.replyTitle === "string" && item.replyTitle.trim() ? item.replyTitle.trim() : undefined;
    const replyText = typeof item.replyText === "string" && item.replyText.trim() ? item.replyText.trim() : undefined;
    const voiceDuration = typeof item.voiceDuration === "string" && item.voiceDuration.trim() ? item.voiceDuration.trim() : undefined;
    const voiceTranscript = typeof item.voiceTranscript === "string" && item.voiceTranscript.trim() ? item.voiceTranscript.trim() : undefined;
    if (!id || !authorName || !createdAt || !isIsoTimestamp(createdAt) || !direction) return null;
    if (!text && messageType !== "voice") return null;
    if (messageType === "voice" && !voiceDuration && !text) return null;
    return { id, authorName, text, createdAt, direction, messageType, replyTitle, replyText, voiceDuration, voiceTranscript };
  };

  const threads = (Array.isArray(record.threads) ? record.threads : Array.isArray(record.chats) ? record.chats : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const kind =
        item.kind === "saved" || item.kind === "direct" || item.kind === "group" || item.kind === "channel"
          ? item.kind
          : null;
      const handle = typeof item.handle === "string" && item.handle.trim() ? item.handle.trim() : undefined;
      const about = typeof item.about === "string" && item.about.trim() ? item.about.trim() : undefined;
      const avatarLabel = typeof item.avatarLabel === "string" && item.avatarLabel.trim() ? item.avatarLabel.trim() : undefined;
      const unreadCount = typeof item.unreadCount === "number"
        ? item.unreadCount
        : item.unreadCount == null
          ? 0
          : Number(item.unreadCount);
      const messages = (Array.isArray(item.messages) ? item.messages : [])
        .map((message) => normalizeMessage(message))
        .filter(Boolean) as CheckPhoneTelegramPayload["threads"][number]["messages"];
      if (!id || !title || !kind || !Number.isFinite(unreadCount) || messages.length === 0) return null;
      return {
        id,
        title,
        kind,
        handle,
        about,
        avatarLabel,
        verified: item.verified === true,
        online: item.online === true,
        isBot: item.isBot === true,
        lastStatus: normalizeLastStatus(item.lastStatus),
        unreadCount: Math.max(0, Math.round(unreadCount)),
        pinned: item.pinned === true,
        muted: item.muted === true,
        messages: messages.slice(0, 18),
      };
    })
    .filter(Boolean) as CheckPhoneTelegramPayload["threads"];

  return {
    headerTitle: "Telegram",
    headerSubtitle: "Chats",
    threads: threads.slice(0, 12),
  };
}

function parseTelegramKind(value: string | undefined): CheckPhoneTelegramPayload["threads"][number]["kind"] | "" {
  const normalized = value?.trim();
  if (normalized === "saved" || normalized === "direct" || normalized === "group" || normalized === "channel") return normalized;
  return "";
}

function parseTelegramLastStatus(value: string | undefined): CheckPhoneTelegramPayload["threads"][number]["lastStatus"] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sent" || normalized === "read" || normalized === "none") return normalized;
  return undefined;
}

function parseTelegramMessageType(value: string | undefined): CheckPhoneTelegramPayload["threads"][number]["messages"][number]["messageType"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "voice" || normalized === "thinking" || normalized === "text") return normalized;
  return "text";
}

function parseTelegramDirection(value: string | undefined): CheckPhoneTelegramPayload["threads"][number]["messages"][number]["direction"] {
  return value?.trim() === "outgoing" ? "outgoing" : "incoming";
}

function parseTelegramBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const matches = [...source.matchAll(/^#\s*会话(\d+)\s*$/gm)];
  if (matches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #会话N 分区" };
  }

  const threads = matches.map((current, index) => {
    const next = matches[index + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? source.length;
    const fields = parseTakeoutTaggedFields(source.slice(start, end).trim());
    const messageNumbers = Object.keys(fields)
      .map((key) => key.match(/^消息(\d+)正文$/)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    const threadId = `tg_thread_${index + 1}`;
    return {
      id: threadId,
      title: fields["标题"] || "",
      kind: parseTelegramKind(fields["类型"]) || "direct",
      handle: fields["账号"] || undefined,
      about: fields["简介"] || undefined,
      avatarLabel: fields["头像"] || undefined,
      verified: parseBlockBoolean(fields["认证"]),
      online: parseBlockBoolean(fields["在线"]),
      isBot: parseBlockBoolean(fields["机器人"]),
      lastStatus: parseTelegramLastStatus(fields["已读状态"]),
      unreadCount: Number(fields["未读"] || 0),
      pinned: parseBlockBoolean(fields["置顶"]),
      muted: parseBlockBoolean(fields["静音"]),
      messages: messageNumbers.map((number) => ({
        id: `${threadId}_msg_${number}`,
        authorName: fields[`消息${number}作者`] || "",
        messageType: parseTelegramMessageType(fields[`消息${number}类型`]),
        direction: parseTelegramDirection(fields[`消息${number}方向`]),
        createdAt: fields[`消息${number}时间`] || "",
        text: fields[`消息${number}正文`] || "",
        replyTitle: fields[`消息${number}引用标题`] || undefined,
        replyText: fields[`消息${number}引用正文`] || undefined,
        voiceDuration: fields[`消息${number}语音时长`] || undefined,
        voiceTranscript: fields[`消息${number}语音转写`] || undefined,
      })),
    };
  });

  return {
    parsed: { threads },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

export async function generateCheckPhoneNotes(
  characterId: string,
  previousPayload?: CheckPhoneNotesPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneNotesPayload | null; summary: string; error?: string; debugRawOutput?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "notes", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_notes" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "" };
    const { parsed } = parseNotesBlockPayload(rawOutput);
    const payload = normalizeNotesPayload(parsed);
    if (!payload) return { payload: null, summary: "", error: "无法解析备忘录内容", debugRawOutput: rawOutput };
    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugRawOutput: rawOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "" };
  }
}

export async function generateCheckPhoneEmail(
  characterId: string,
  previousPayload?: CheckPhoneEmailPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneEmailPayload | null; summary: string; error?: string; debugRawOutput?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "email", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_email" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "" };
    const { parsed } = parseEmailBlockPayload(rawOutput);
    const payload = normalizeEmailPayload(parsed);
    if (!payload) return { payload: null, summary: "", error: "无法解析邮箱内容", debugRawOutput: rawOutput };
    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugRawOutput: rawOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "" };
  }
}

export async function generateCheckPhoneTakeout(
  characterId: string,
  previousPayload?: CheckPhoneTakeoutPayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneTakeoutPayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugSanitizedOutput?: string;
  debugParseMode?: "raw" | "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "takeout", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_takeout" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseTakeoutBlockPayload(rawOutput);
    const payload = normalizeTakeoutPayload(parsed);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析外卖内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseTakeoutNormalizeFailure(parsed) : undefined,
      };
    }
    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

export async function generateCheckPhoneTelegram(
  characterId: string,
  previousPayload?: CheckPhoneTelegramPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneTelegramPayload | null; summary: string; error?: string; debugRawOutput?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "telegram", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_telegram" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "" };
    const { parsed } = parseTelegramBlockPayload(rawOutput);
    const payload = normalizeTelegramPayload(parsed);
    if (!payload) return { payload: null, summary: "", error: "无法解析 Telegram 内容", debugRawOutput: rawOutput };
    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugRawOutput: rawOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "" };
  }
}

export async function generateCheckPhoneSteam(
  characterId: string,
  previousPayload?: CheckPhoneSteamPayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneSteamPayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugSanitizedOutput?: string;
  debugParseMode?: "raw" | "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "steam", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_steam" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseSteamBlockPayload(rawOutput);
    const payload = normalizeSteamPayload(parsed);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析游戏库内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseSteamNormalizeFailure(parsed) : undefined,
      };
    }

    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

export async function generateCheckPhoneReddit(
  characterId: string,
  previousPayload?: CheckPhoneRedditPayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneRedditPayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugSanitizedOutput?: string;
  debugParseMode?: "raw" | "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "reddit", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_reddit" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseRedditBlockPayload(rawOutput);
    const payload = normalizeRedditPayload(parsed);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析 Reddit 内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseRedditNormalizeFailure(parsed) : undefined,
      };
    }

    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

export async function generateCheckPhoneX(
  characterId: string,
  previousPayload?: CheckPhoneXPayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneXPayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugSanitizedOutput?: string;
  debugParseMode?: "raw" | "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const characterName = loadCharacters().find((item) => item.id === characterId)?.name;
    const messages = await buildCheckPhoneAppMessages(characterId, "x", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName },
      { skipOutputRegex: true, appId: "checkphone_x" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseXBlockPayload(rawOutput);
    const payload = normalizeXPayload(parsed, characterName);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析 X 内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseXNormalizeFailure(parsed) : undefined,
      };
    }

    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

export async function generateCheckPhoneYoutube(
  characterId: string,
  previousPayload?: CheckPhoneYoutubePayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneYoutubePayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugSanitizedOutput?: string;
  debugParseMode?: "raw" | "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "youtube", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_youtube" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseYoutubeBlockPayload(rawOutput);
    const payload = normalizeYoutubePayload(parsed);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析 YouTube 内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseYoutubeNormalizeFailure(parsed) : undefined,
      };
    }

    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

export async function generateCheckPhoneBilibili(
  characterId: string,
  previousPayload?: CheckPhoneBilibiliPayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneBilibiliPayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugSanitizedOutput?: string;
  debugParseMode?: "raw" | "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "bilibili", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_bilibili" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseBilibiliBlockPayload(rawOutput);
    const payload = normalizeBilibiliPayload(parsed);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析 B站 内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseBilibiliNormalizeFailure(parsed) : undefined,
      };
    }

    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

function normalizeMessagesPayload(payload: unknown): CheckPhoneMessagesPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const threadsRaw = Array.isArray(record.threads) ? record.threads : [];
  const threads = threadsRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const thread = item as Record<string, unknown>;
      const id = typeof thread.id === "string" && thread.id.trim() ? thread.id.trim() : "";
      const sender = typeof thread.sender === "string" ? thread.sender.trim() : "";
      const timeLabel = typeof thread.timeLabel === "string" ? thread.timeLabel.trim() : "";
      const unread = thread.unread === true;
      const muted = thread.muted === true;
      const normalizedKind = typeof thread.kind === "string" ? thread.kind.trim() : "";
      const messagesRaw = Array.isArray(thread.messages) ? thread.messages : [];
      const messages = messagesRaw
        .map((msg) => {
          if (!msg || typeof msg !== "object") return null;
          const entry = msg as Record<string, unknown>;
          const messageId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
          const text = typeof entry.text === "string" ? entry.text.trim() : "";
          const messageTime = typeof entry.timeLabel === "string" && entry.timeLabel.trim() ? entry.timeLabel.trim() : timeLabel;
          const direction = entry.direction === "outgoing" ? "outgoing" : entry.direction === "incoming" ? "incoming" : null;
          if (!messageId || !text || !messageTime || !direction) return null;
          return { id: messageId, text, timeLabel: messageTime, direction };
        })
        .filter(Boolean) as CheckPhoneMessagesPayload["threads"][number]["messages"];

      const preview = messages[messages.length - 1]?.text ?? "";
      if (!id || !sender || !preview || !timeLabel || messages.length === 0) return null;
      return { id, sender, preview, timeLabel, unread, muted, kind: normalizedKind || "service", messages };
    })
    .filter(Boolean) as CheckPhoneMessagesPayload["threads"];

  if (threads.length < 1) return null;
  const featuredThreadId =
    typeof record.featuredThreadId === "string" && threads.some((thread) => thread.id === record.featuredThreadId)
      ? record.featuredThreadId
      : threads[0]?.id;

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "信息",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "通知与短信",
    featuredThreadId,
    threads,
  };
}

function diagnoseMessagesNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  const threads = Array.isArray(record.threads) ? record.threads : [];
  if (threads.length < 1) return `threads 数量不足: ${threads.length}`;

  for (let index = 0; index < threads.length; index += 1) {
    const item = threads[index];
    if (!item || typeof item !== "object") return `threads[${index}] 不是对象`;
    const thread = item as Record<string, unknown>;
    if (typeof thread.id !== "string" || !thread.id.trim()) return `threads[${index}].id 缺失`;
    if (typeof thread.sender !== "string" || !thread.sender.trim()) return `threads[${index}].sender 缺失`;
    if (typeof thread.timeLabel !== "string" || !thread.timeLabel.trim()) return `threads[${index}].timeLabel 缺失`;
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    if (messages.length < 1) return `threads[${index}].messages 数量不足: ${messages.length}`;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (!message || typeof message !== "object") return `threads[${index}].messages[${messageIndex}] 不是对象`;
      const entry = message as Record<string, unknown>;
      if (typeof entry.text !== "string" || !entry.text.trim()) return `threads[${index}].messages[${messageIndex}].text 缺失`;
      if (typeof entry.timeLabel !== "string" || !entry.timeLabel.trim()) return `threads[${index}].messages[${messageIndex}].timeLabel 缺失`;
      if (entry.direction !== "incoming" && entry.direction !== "outgoing") return `threads[${index}].messages[${messageIndex}].direction 非法`;
    }
  }

  return "结构存在字段缺失或方向非法";
}

export async function generateCheckPhoneMessages(
  characterId: string,
  previousPayload?: CheckPhoneMessagesPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneMessagesPayload | null; summary: string; error?: string; debugRawOutput?: string; debugSanitizedOutput?: string; debugParseMode?: "raw" | "sanitized" | "failed"; debugParseError?: string; debugNormalizeError?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "messages", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_messages" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseMessagesBlockPayload(rawOutput);
    const payload = normalizeMessagesPayload(parsed);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析信息内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseMessagesNormalizeFailure(parsed) : undefined,
      };
    }
    return {
      payload,
      summary: formatSnapshotSummary(payload),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

function normalizeBrowserPayload(payload: unknown): CheckPhoneBrowserPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const historyRaw = Array.isArray(record.history) ? record.history : [];
  const bookmarksRaw = Array.isArray(record.bookmarks) ? record.bookmarks : [];

  const history = historyRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
      const title = typeof entry.title === "string" ? entry.title.trim() : "";
      const urlLabel = typeof entry.urlLabel === "string" ? entry.urlLabel.trim() : "";
      const createdAt = typeof entry.createdAt === "string" ? entry.createdAt.trim() : "";
      const content = typeof entry.content === "string" ? entry.content.trim() : "";
      const context = typeof entry.context === "string" ? entry.context.trim() : "";
      const innerThought = typeof entry.innerThought === "string" ? entry.innerThought.trim() : "";
      if (!id || !title || !urlLabel || !createdAt || !content) return null;
      return { id, title, urlLabel, createdAt, content, context, innerThought };
    })
    .filter(Boolean) as CheckPhoneBrowserPayload["history"];

  const bookmarks = bookmarksRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
      const title = typeof entry.title === "string" ? entry.title.trim() : "";
      const urlLabel = typeof entry.urlLabel === "string" ? entry.urlLabel.trim() : "";
      const categoryLabel = typeof entry.categoryLabel === "string" ? entry.categoryLabel.trim() : "";
      const content = typeof entry.content === "string" ? entry.content.trim() : "";
      const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
      if (!id || !title || !urlLabel || !categoryLabel) return null;
      return { id, title, urlLabel, categoryLabel, content, reason };
    })
    .filter(Boolean) as CheckPhoneBrowserPayload["bookmarks"];

  if (history.length === 0 && bookmarks.length === 0) return null;

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "浏览器",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim() ? record.headerSubtitle.trim() : "历史记录与收藏夹",
    history: history.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    bookmarks,
  };
}

function extractBrowserSection(source: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^#\\s*${escaped}\\s*$`, "m"));
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const next = source.slice(start).match(/^#(?!#)\s*\S.*$/m);
  const end = next?.index === undefined ? source.length : start + next.index;
  return source.slice(start, end).trim();
}

function parseBrowserEntryBlocks(section: string, label: string): Array<{ order: string; fields: Record<string, string> }> {
  const matches = [...section.matchAll(new RegExp(`^##\\s*${label}(\\d+)\\s*$`, "gm"))];
  return matches.map((current, index) => {
    const next = matches[index + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? section.length;
    return {
      order: current[1] || String(index + 1),
      fields: parseTakeoutTaggedFields(section.slice(start, end).trim()),
    };
  });
}

function parseBrowserBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };
  const historySection = extractBrowserSection(source, "历史记录");
  const bookmarksSection = extractBrowserSection(source, "收藏夹");
  if (!historySection && !bookmarksSection) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #历史记录 或 #收藏夹 分区" };
  }
  const history = parseBrowserEntryBlocks(historySection, "记录")
    .map(({ order, fields }) => ({
      id: `history${order}`,
      title: fields["标题"] || "",
      urlLabel: fields["网址"] || "",
      createdAt: fields["时间"] || new Date().toISOString(),
      content: fields["内容"] || "",
      context: fields["情境"] || "",
      innerThought: fields["内心"] || "",
    }))
    .filter((item) => item.title && item.urlLabel);
  const bookmarks = parseBrowserEntryBlocks(bookmarksSection, "收藏")
    .map(({ order, fields }) => ({
      id: `bookmark${order}`,
      title: fields["标题"] || "",
      urlLabel: fields["网址"] || "",
      categoryLabel: fields["分类"] || "收藏",
      content: fields["内容"] || "",
      reason: fields["收藏原因"] || "",
    }))
    .filter((item) => item.title && item.urlLabel);
  const parsed = {
    headerTitle: "浏览器",
    headerSubtitle: "历史记录与收藏夹",
    history,
    bookmarks,
  };
  return { parsed, sanitizedCandidate: source, parseMode: "sanitized" };
}

export async function generateCheckPhoneBrowser(
  characterId: string,
  previousPayload?: CheckPhoneBrowserPayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneBrowserPayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugSanitizedOutput?: string;
  debugParseMode?: "raw" | "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "browser", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_browser" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseBrowserBlockPayload(rawOutput);
    const payload = normalizeBrowserPayload(parsed);
    if (!payload) {
      return {
        payload: null,
        summary: "",
        error: "无法解析浏览器内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
      };
    }
    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

function slugifyCheckPhoneId(value: string, fallback: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return ascii || fallback;
}

function createUniqueCheckPhoneId(base: string, used: Set<string>, fallback: string): string {
  const normalizedBase = slugifyCheckPhoneId(base, fallback);
  let candidate = normalizedBase;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${normalizedBase}_${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function parsePhotosBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "是" || normalized === "精选";
}

function derivePhotoTone(
  title: string,
  locationLabel: string,
  description: string,
  albumIndex: number,
  photoIndex: number,
): CheckPhonePhotoItem["tone"] {
  const source = `${title} ${locationLabel} ${description}`;
  if (/(夜|黑|暗|影|深|雨夜|车窗|霓虹|隧道)/.test(source)) return photoIndex % 2 === 0 ? "shadow" : "graphite";
  if (/(雪|白|雾|纸|晨|窗纱|玻璃|月光|云)/.test(source)) return photoIndex % 2 === 0 ? "mist" : "silver";
  const cycle: CheckPhonePhotoItem["tone"][] = ["mist", "silver", "graphite", "shadow"];
  return cycle[(albumIndex + photoIndex) % cycle.length];
}

function parsePhotoEntryBlocks(
  section: string,
  headingPattern: RegExp = /^##\s*照片(\d+)\s*$/gm,
): Array<{ order: string; fields: Record<string, string> }> {
  const matches = [...section.matchAll(headingPattern)];
  return matches.map((current, index) => {
    const next = matches[index + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? section.length;
    return {
      order: current[1] || String(index + 1),
      fields: parseTakeoutTaggedFields(section.slice(start, end).trim()),
    };
  });
}

function parsePhotoAlbumBlocks(section: string): Array<{ order: string; fields: Record<string, string>; photos: Array<{ order: string; fields: Record<string, string> }> }> {
  const matches = [...section.matchAll(/^#\s*相簿(\d+)\s*$/gm)];
  return matches.map((current, index) => {
    const next = matches[index + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? section.length;
    const block = section.slice(start, end).trim();
    const firstPhotoMatch = block.match(/^##\s*照片\d+\s*$/m);
    const albumMetaBlock = firstPhotoMatch ? block.slice(0, firstPhotoMatch.index ?? 0).trim() : block;
    return {
      order: current[1] || String(index + 1),
      fields: parseTakeoutTaggedFields(albumMetaBlock),
      photos: parsePhotoEntryBlocks(block, /^##\s*照片(\d+)\s*$/gm),
    };
  });
}

function parsePhotosBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };
  let albumEntries = parsePhotoAlbumBlocks(source);

  // Backward compatibility for the previous nested format:
  // #相簿 -> ##相簿N -> ###照片N
  if (albumEntries.length === 0) {
    const legacySectionMatch = source.match(/^#\s*相簿\s*$/m);
    if (legacySectionMatch) {
      const start = (legacySectionMatch.index ?? 0) + legacySectionMatch[0].length;
      const legacySection = source.slice(start).trim();
      const legacyMatches = [...legacySection.matchAll(/^##\s*相簿(\d+)\s*$/gm)];
      albumEntries = legacyMatches.map((current, index) => {
        const next = legacyMatches[index + 1];
        const blockStart = (current.index ?? 0) + current[0].length;
        const blockEnd = next?.index ?? legacySection.length;
        const block = legacySection.slice(blockStart, blockEnd).trim();
        const firstPhotoMatch = block.match(/^###\s*照片\d+\s*$/m);
        const albumMetaBlock = firstPhotoMatch ? block.slice(0, firstPhotoMatch.index ?? 0).trim() : block;
        return {
          order: current[1] || String(index + 1),
          fields: parseTakeoutTaggedFields(albumMetaBlock),
          photos: parsePhotoEntryBlocks(block, /^###\s*照片(\d+)\s*$/gm),
        };
      });
    }
  }

  if (albumEntries.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #相簿N 分区" };
  }

  const albums = albumEntries.map((entry) => ({
    order: entry.order,
    title: entry.fields["名称"] || "",
    moodLabel: entry.fields["说明"] || "",
    photos: entry.photos.map((photo) => ({
      order: photo.order,
      title: photo.fields["标题"] || "",
      shotAtLabel: photo.fields["时间"] || "",
      locationLabel: photo.fields["地点"] || "",
      description: photo.fields["描述"] || "",
      previewIcon: photo.fields["预览符号"] || "",
      featured: parsePhotosBoolean(photo.fields["精选"]),
    })),
  }));

  return {
    parsed: {
      headerTitle: "相册",
      albums,
    },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

function normalizePhotosPayload(payload: unknown): CheckPhonePhotosPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const albumsRaw = Array.isArray(record.albums) ? record.albums : [];
  const usedAlbumIds = new Set<string>();
  const usedPhotoIds = new Set<string>();
  const albums: CheckPhonePhotosPayload["albums"] = [];
  const photos: CheckPhonePhotosPayload["photos"] = [];
  let featuredPhotoId = "";

  albumsRaw.forEach((item, albumIndex) => {
    if (!item || typeof item !== "object") return;
    const album = item as Record<string, unknown>;
    const title = typeof album.title === "string" ? album.title.trim() : "";
    const moodLabel = typeof album.moodLabel === "string" ? album.moodLabel.trim() : "";
    const photosRaw = Array.isArray(album.photos) ? album.photos : [];
    if (!title || photosRaw.length === 0) return;

    const albumId = createUniqueCheckPhoneId(title, usedAlbumIds, `album_${albumIndex + 1}`);
    const albumPhotos: CheckPhonePhotosPayload["photos"] = [];

    photosRaw.forEach((photoItem, photoIndex) => {
      if (!photoItem || typeof photoItem !== "object") return;
      const photo = photoItem as Record<string, unknown>;
      const photoTitle = typeof photo.title === "string" ? photo.title.trim() : "";
      const shotAtLabel = typeof photo.shotAtLabel === "string" ? photo.shotAtLabel.trim() : "";
      const locationLabel = typeof photo.locationLabel === "string" ? photo.locationLabel.trim() : "";
      const description = typeof photo.description === "string" ? photo.description.trim() : "";
      const previewIcon = typeof photo.previewIcon === "string" ? photo.previewIcon.trim() : "";
      const featured = photo.featured === true;
      if (!photoTitle || !shotAtLabel || !locationLabel || !description || !previewIcon) return;

      const photoId = createUniqueCheckPhoneId(photoTitle, usedPhotoIds, `photo_${albumIndex + 1}_${photoIndex + 1}`);
      const normalizedPhoto: CheckPhonePhotosPayload["photos"][number] = {
        id: photoId,
        albumId,
        title: photoTitle,
        shotAtLabel,
        locationLabel,
        description,
        previewIcon,
        tone: derivePhotoTone(photoTitle, locationLabel, description, albumIndex, photoIndex),
      };
      albumPhotos.push(normalizedPhoto);
      photos.push(normalizedPhoto);
      if (!featuredPhotoId && featured) featuredPhotoId = photoId;
    });

    if (albumPhotos.length === 0) return;
    albums.push({
      id: albumId,
      title,
      coverPhotoId: albumPhotos[0].id,
      count: albumPhotos.length,
      updatedLabel: albumPhotos[0].shotAtLabel,
      moodLabel: moodLabel || albumPhotos[0].locationLabel,
    });
  });

  if (albums.length === 0 || photos.length === 0) return null;
  if (!featuredPhotoId) featuredPhotoId = photos[0]?.id ?? "";

  return {
    headerTitle: "相册",
    headerSubtitle: "最近的碎片",
    featuredPhotoId: featuredPhotoId || undefined,
    albums: albums.slice(0, 6),
    photos: photos.slice(0, 24),
  };
}

export async function generateCheckPhonePhotos(
  characterId: string,
  previousPayload?: CheckPhonePhotosPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhonePhotosPayload | null; summary: string; error?: string; debugRawOutput?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "photos", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_photos" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "" };
    const { parsed } = parsePhotosBlockPayload(rawOutput);
    const payload = normalizePhotosPayload(parsed);
    if (!payload) return { payload: null, summary: "", error: "无法解析相册内容", debugRawOutput: rawOutput };
    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugRawOutput: rawOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "" };
  }
}

function parseChatSupplementalMessages(
  fields: Record<string, string>,
  prefix: string,
  allowAuthor: boolean,
): Array<{ id: string; text: string; timeLabel: string; direction: "incoming" | "outgoing"; authorLabel?: string }> {
  return Object.keys(fields)
    .map((key) => key.match(/^消息(\d+)正文$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
    .map((number) => {
      const direction = fields[`消息${number}方向`] === "outgoing" ? "outgoing" : "incoming";
      const authorLabel = allowAuthor ? fields[`消息${number}作者`] || undefined : undefined;
      return {
        id: `${prefix}_message_${number}`,
        text: fields[`消息${number}正文`] || "",
        timeLabel: fields[`消息${number}时间`] || "",
        direction,
        authorLabel,
      };
    });
}

function parseChatMomentComments(
  fields: Record<string, string>,
  prefix: string,
): CheckPhoneChatPayload["momentsFeed"][number]["comments"] {
  const commentNumbers = Object.keys(fields)
    .map((key) => key.match(/^评论(\d+)作者$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  const authorByNumber = new Map(
    commentNumbers.map((number) => [number, fields[`评论${number}作者`] || ""]),
  );

  return commentNumbers.map((number) => {
    const replyTarget = fields[`评论${number}回复对象`]?.trim() || "";
    const replyTargetNumber = Number(replyTarget.match(/^评论(\d+)$/)?.[1] || 0);
    const replyToLabel =
      replyTargetNumber > 0 && replyTargetNumber < number
        ? authorByNumber.get(replyTargetNumber) || undefined
        : undefined;

    return {
      id: `${prefix}_comment_${number}`,
      authorLabel: fields[`评论${number}作者`] || "",
      timeLabel: fields[`评论${number}时间`] || "",
      text: fields[`评论${number}内容`] || "",
      replyToLabel,
    };
  });
}

function parseChatBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const supplementalConversations = extractTopLevelTaggedBlocks(source, "补充会话").map((entry) => ({
    id: `supp_conv_${entry.order}`,
    name: entry.fields["名称"] || "",
    muted: parseBlockBoolean(entry.fields["静音"]),
    pinned: parseBlockBoolean(entry.fields["置顶"]),
    tagLabel: entry.fields["标签"] || "补充会话",
    messages: parseChatSupplementalMessages(entry.fields, `supp_conv_${entry.order}`, false),
  }));
  const supplementalGroups = extractTopLevelTaggedBlocks(source, "补充群聊").map((entry) => ({
    id: `supp_group_${entry.order}`,
    name: entry.fields["名称"] || "",
    muted: parseBlockBoolean(entry.fields["静音"]),
    memberCountLabel: entry.fields["人数"] || "多人",
    activityLabel: entry.fields["活跃"] || "最近活跃",
    messages: parseChatSupplementalMessages(entry.fields, `supp_group_${entry.order}`, true),
  }));
  const supplementalMoments = extractTopLevelTaggedBlocks(source, "补充动态").map((entry) => ({
    id: `supp_moment_${entry.order}`,
    authorLabel: entry.fields["作者"] || "",
    authorAccent: entry.fields["标记"] || "最近动态",
    timeLabel: entry.fields["时间"] || "",
    body: entry.fields["正文"] || "",
    mediaLabel: entry.fields["媒体"] || "动态",
    photoDescription: entry.fields["媒体"] || undefined,
    likeCountLabel: entry.fields["点赞"] || "0 赞",
    commentCountLabel: entry.fields["评论数"] || "0 评论",
    comments: parseChatMomentComments(entry.fields, `supp_moment_${entry.order}`),
  }));
  const supplementalContacts = extractTopLevelTaggedBlocks(source, "补充联系人").map((entry) => ({
    id: `supp_contact_${entry.order}`,
    name: entry.fields["名称"] || "",
    tagLabel: entry.fields["标签"] || "联系人",
    relationLabel: entry.fields["关系"] || "关系",
    recentLabel: entry.fields["最近"] || "",
    note: entry.fields["备注"] || "",
  }));

  if (supplementalConversations.length + supplementalGroups.length + supplementalMoments.length + supplementalContacts.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到聊天补充块" };
  }

  return {
    parsed: { supplementalConversations, supplementalGroups, supplementalMoments, supplementalContacts },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

function normalizeChatPayload(payload: unknown): Partial<CheckPhoneChatPayload> | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const conversationSource = Array.isArray(record.supplementalConversations)
    ? record.supplementalConversations
    : Array.isArray(record.conversations)
      ? record.conversations
      : Array.isArray(record.threads)
        ? record.threads
        : [];
  const groupSource = Array.isArray(record.supplementalGroups)
    ? record.supplementalGroups
    : Array.isArray(record.groups)
      ? record.groups
      : Array.isArray(record.groupThreads)
        ? record.groupThreads
        : [];
  const momentSource = Array.isArray(record.supplementalMoments)
    ? record.supplementalMoments
    : Array.isArray(record.momentsFeed)
      ? record.momentsFeed
      : Array.isArray(record.moments)
        ? record.moments
        : [];
  const contactSource = Array.isArray(record.supplementalContacts)
    ? record.supplementalContacts
    : Array.isArray(record.contacts)
      ? record.contacts
      : [];

  const normalizeBubble = (item: unknown, allowAuthor = false) => {
    if (!item || typeof item !== "object") return null;
    const bubble = item as Record<string, unknown>;
    const id = typeof bubble.id === "string" && bubble.id.trim() ? bubble.id.trim() : "";
    const text = typeof bubble.text === "string" ? bubble.text.trim() : "";
    const timeLabel = typeof bubble.timeLabel === "string" ? bubble.timeLabel.trim() : "";
    const direction = bubble.direction === "outgoing" ? "outgoing" : bubble.direction === "incoming" ? "incoming" : null;
    const authorLabel = allowAuthor && typeof bubble.authorLabel === "string" && bubble.authorLabel.trim() ? bubble.authorLabel.trim() : undefined;
    if (!id || !text || !timeLabel || !direction) return null;
    return { id, text, timeLabel, direction, authorLabel };
  };

  const conversations = conversationSource
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const thread = item as Record<string, unknown>;
      const id = typeof thread.id === "string" && thread.id.trim() ? thread.id.trim() : "";
      const name = typeof thread.name === "string" ? thread.name.trim() : "";
      const tagLabel = typeof thread.tagLabel === "string" && thread.tagLabel.trim() ? thread.tagLabel.trim() : "会话";
      const muted = thread.muted === true;
      const pinned = thread.pinned === true;
      const messages = (Array.isArray(thread.messages) ? thread.messages : [])
        .map((entry) => normalizeBubble(entry))
        .filter(Boolean) as CheckPhoneChatPayload["conversations"][number]["messages"];
      const slicedMessages = messages.slice(0, 10);
      const lastMessage = slicedMessages[slicedMessages.length - 1];
      if (!id || !name || !tagLabel || slicedMessages.length === 0 || !lastMessage) return null;
      return {
        id,
        name,
        preview: lastMessage.text,
        timeLabel: lastMessage.timeLabel,
        muted,
        pinned,
        tagLabel,
        messages: slicedMessages,
      };
    })
    .filter(Boolean) as CheckPhoneChatPayload["conversations"];

  const groups = groupSource
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const group = item as Record<string, unknown>;
      const id = typeof group.id === "string" && group.id.trim() ? group.id.trim() : "";
      const name = typeof group.name === "string" ? group.name.trim() : "";
      const memberCountLabel =
        typeof group.memberCountLabel === "string" && group.memberCountLabel.trim() ? group.memberCountLabel.trim() : "多人";
      const activityLabel =
        typeof group.activityLabel === "string" && group.activityLabel.trim() ? group.activityLabel.trim() : "最近活跃";
      const muted = group.muted === true;
      const messages = (Array.isArray(group.messages) ? group.messages : [])
        .map((entry) => normalizeBubble(entry, true))
        .filter(Boolean) as CheckPhoneChatPayload["groups"][number]["messages"];
      const slicedMessages = messages.slice(0, 10);
      const lastMessage = slicedMessages[slicedMessages.length - 1];
      if (!id || !name || !memberCountLabel || !activityLabel || slicedMessages.length === 0 || !lastMessage) return null;
      return {
        id,
        name,
        preview: lastMessage.text,
        timeLabel: lastMessage.timeLabel,
        muted,
        memberCountLabel,
        activityLabel,
        messages: slicedMessages,
      };
    })
    .filter(Boolean) as CheckPhoneChatPayload["groups"];

  const momentsFeed = momentSource
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const post = item as Record<string, unknown>;
      const id = typeof post.id === "string" && post.id.trim() ? post.id.trim() : "";
      const authorLabel = typeof post.authorLabel === "string" ? post.authorLabel.trim() : "";
      const authorAccent = typeof post.authorAccent === "string" && post.authorAccent.trim() ? post.authorAccent.trim() : "最近动态";
      const timeLabel = typeof post.timeLabel === "string" ? post.timeLabel.trim() : "";
      const body = typeof post.body === "string" ? post.body.trim() : "";
      const mediaLabel = typeof post.mediaLabel === "string" && post.mediaLabel.trim() ? post.mediaLabel.trim() : "动态";
      const photoUrl = typeof post.photoUrl === "string" && post.photoUrl.trim() ? post.photoUrl.trim() : undefined;
      const photoDescription =
        typeof post.photoDescription === "string" && post.photoDescription.trim() ? post.photoDescription.trim() : undefined;
      const likeCountLabel = typeof post.likeCountLabel === "string" && post.likeCountLabel.trim() ? post.likeCountLabel.trim() : "0 赞";
      const commentCountLabel = typeof post.commentCountLabel === "string" && post.commentCountLabel.trim() ? post.commentCountLabel.trim() : "0 评论";
      const comments = (Array.isArray(post.comments) ? post.comments : [])
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const comment = entry as Record<string, unknown>;
          const commentId = typeof comment.id === "string" && comment.id.trim() ? comment.id.trim() : "";
          const commentAuthor = typeof comment.authorLabel === "string" ? comment.authorLabel.trim() : "";
          const commentTime = typeof comment.timeLabel === "string" ? comment.timeLabel.trim() : "";
          const text = typeof comment.text === "string" ? comment.text.trim() : "";
          const replyToLabel =
            typeof comment.replyToLabel === "string" && comment.replyToLabel.trim() ? comment.replyToLabel.trim() : undefined;
          if (!commentId || !commentAuthor || !commentTime || !text) return null;
          return { id: commentId, authorLabel: commentAuthor, timeLabel: commentTime, text, replyToLabel };
        })
        .filter(Boolean) as CheckPhoneChatPayload["momentsFeed"][number]["comments"];
      if (!id || !authorLabel || !timeLabel || !body) return null;
      return {
        id,
        authorLabel,
        authorAccent,
        timeLabel,
        body,
        mediaLabel,
        photoUrl,
        photoDescription,
        likeCountLabel,
        commentCountLabel,
        comments: comments.slice(0, 8),
      };
    })
    .filter(Boolean) as CheckPhoneChatPayload["momentsFeed"];

  const contacts = contactSource
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const contact = item as Record<string, unknown>;
      const id = typeof contact.id === "string" && contact.id.trim() ? contact.id.trim() : "";
      const name = typeof contact.name === "string" ? contact.name.trim() : "";
      const tagLabel = typeof contact.tagLabel === "string" && contact.tagLabel.trim() ? contact.tagLabel.trim() : "联系人";
      const relationLabel =
        typeof contact.relationLabel === "string" && contact.relationLabel.trim() ? contact.relationLabel.trim() : "关系";
      const recentLabel = typeof contact.recentLabel === "string" && contact.recentLabel.trim() ? contact.recentLabel.trim() : "";
      const note = typeof contact.note === "string" ? contact.note.trim() : "";
      if (!id || !name || !tagLabel || !relationLabel || !recentLabel || !note) return null;
      return { id, name, tagLabel, relationLabel, recentLabel, note };
    })
    .filter(Boolean) as CheckPhoneChatPayload["contacts"];

  const uniqueIds = (items: Array<{ id: string }>) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
    }
    return true;
  };

  if (!uniqueIds(conversations) || !uniqueIds(groups) || !uniqueIds(momentsFeed) || !uniqueIds(contacts)) {
    return null;
  }

  return {
    conversations: conversations.slice(0, 6),
    groups: groups.slice(0, 5),
    momentsFeed: momentsFeed.slice(0, 6),
    contacts: contacts.slice(0, 8),
  };
}

export async function generateCheckPhoneChat(
  characterId: string,
  previousPayload?: CheckPhoneChatPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneChatPayload | null; summary: string; error?: string; debugRawOutput?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "" };

  try {
    const realPayload = buildRealCheckPhoneChatPayload(characterId);
    const realSnapshotSummary = formatRealChatSnapshotForPrompt(realPayload);
    const messages = await buildCheckPhoneAppMessages(characterId, "chat", preset, worldBooks, regexes, {
      snapshotSummary: [
        realSnapshotSummary,
        previousPayload ? "\n[上次完整快照摘要]\n" + formatSnapshotSummary(previousPayload) : "",
      ].filter(Boolean).join("\n"),
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_chat" },
    );

    if (!rawOutput?.trim()) {
      return {
        payload: realPayload,
        summary: formatSnapshotSummary(realPayload),
        error: "LLM 返回为空，已回退为真实数据",
        debugRawOutput: rawOutput ?? "",
      };
    }
    const { parsed } = parseChatBlockPayload(rawOutput);
    const normalized = normalizeChatPayload(parsed);
    if (!normalized) {
      return {
        payload: realPayload,
        summary: formatSnapshotSummary(realPayload),
        error: "无法解析补充聊天内容，已回退为真实数据",
        debugRawOutput: rawOutput,
      };
    }
    const merged = mergeChatPayload(realPayload, normalized, characterId);
    return {
      payload: merged,
      summary: formatSnapshotSummary(merged),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    const realPayload = buildRealCheckPhoneChatPayload(characterId);
    return { payload: realPayload, summary: formatSnapshotSummary(realPayload), error: message, debugRawOutput: "" };
  }
}

function normalizeAssetsPayload(payload: unknown): CheckPhoneAssetsPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const headlineRaw = record.headline && typeof record.headline === "object" ? record.headline as Record<string, unknown> : null;
  const totalLabel =
    headlineRaw && typeof headlineRaw.totalLabel === "string" && headlineRaw.totalLabel.trim()
      ? headlineRaw.totalLabel.trim()
      : "总资产";
  const periodLabel =
    headlineRaw && typeof headlineRaw.periodLabel === "string" && headlineRaw.periodLabel.trim()
      ? headlineRaw.periodLabel.trim()
      : "账户与近期流水";

  const accountsRaw = Array.isArray(record.accounts) ? record.accounts : [];
  const activitiesRaw = Array.isArray(record.activities) ? record.activities : [];

  const accounts = accountsRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const account = item as Record<string, unknown>;
      const id = typeof account.id === "string" && account.id.trim() ? account.id.trim() : "";
      const title = typeof account.title === "string" ? account.title.trim() : "";
      const kind = account.kind;
      const normalizedKind =
        kind === "cash" || kind === "savings" || kind === "investment" || kind === "credit"
          ? kind
          : null;
      const bankLabel = typeof account.bankLabel === "string" ? account.bankLabel.trim() : "";
      const maskedNumber = typeof account.maskedNumber === "string" ? account.maskedNumber.trim() : "";
      const cardStyle = account.cardStyle;
      const normalizedCardStyle =
        cardStyle === "obsidian" || cardStyle === "graphite" || cardStyle === "silver"
          ? cardStyle
          : null;
      const balance = typeof account.balance === "string" ? account.balance.trim() : "";
      const note = typeof account.note === "string" ? account.note.trim() : "";
      const accentLabelRaw = typeof account.accentLabel === "string" ? account.accentLabel.trim() : "";
      const accentLabel =
        accentLabelRaw === "常用" ||
        accentLabelRaw === "备用" ||
        accentLabelRaw === "储备" ||
        accentLabelRaw === "增值" ||
        accentLabelRaw === "信用"
          ? accentLabelRaw
          : null;
      if (!id || !title || !normalizedKind || !bankLabel || !maskedNumber || !normalizedCardStyle || !balance || !note || !accentLabel) return null;
      return { id, title, kind: normalizedKind, bankLabel, maskedNumber, cardStyle: normalizedCardStyle, balance, note, accentLabel };
    })
    .filter(Boolean) as CheckPhoneAssetsPayload["accounts"];

  const uniqueAccountIds = new Set<string>();
  for (const account of accounts) {
    if (uniqueAccountIds.has(account.id)) return null;
    uniqueAccountIds.add(account.id);
  }

  const activities = activitiesRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const activity = item as Record<string, unknown>;
      const id = typeof activity.id === "string" && activity.id.trim() ? activity.id.trim() : "";
      const title = typeof activity.title === "string" ? activity.title.trim() : "";
      const amount = typeof activity.amount === "string" ? activity.amount.trim() : "";
      const category = typeof activity.category === "string" ? activity.category.trim() : "";
      const createdAt = typeof activity.createdAt === "string" ? activity.createdAt.trim() : "";
      const accountId = typeof activity.accountId === "string" ? activity.accountId.trim() : "";
      const detail = typeof activity.detail === "string" ? activity.detail.trim() : "";
      if (!id || !title || !amount || !category || !createdAt || !accountId || !detail) return null;
      if (Number.isNaN(new Date(createdAt).getTime())) return null;
      if (!uniqueAccountIds.has(accountId)) return null;
      return { id, title, amount, category, createdAt, accountId, detail };
    })
    .filter(Boolean) as CheckPhoneAssetsPayload["activities"];

  const uniqueActivityIds = new Set<string>();
  for (const activity of activities) {
    if (uniqueActivityIds.has(activity.id)) return null;
    uniqueActivityIds.add(activity.id);
  }

  return {
    headerTitle: "资产",
    headerSubtitle: "账户与近期变动",
    headline: { totalLabel, periodLabel },
    accounts: accounts.slice(0, 6),
    activities: activities
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 24),
  };
}

function parseAssetAccountKind(value: string | undefined): CheckPhoneAssetsPayload["accounts"][number]["kind"] | "" {
  const normalized = value?.trim();
  if (normalized === "流动" || normalized === "现金" || normalized === "日常" || normalized === "cash") return "cash";
  if (normalized === "储蓄" || normalized === "储备" || normalized === "savings") return "savings";
  if (normalized === "投资" || normalized === "增值" || normalized === "investment") return "investment";
  if (normalized === "信用" || normalized === "credit") return "credit";
  return "";
}

function deriveAssetCardStyle(
  kind: CheckPhoneAssetsPayload["accounts"][number]["kind"],
): CheckPhoneAssetsPayload["accounts"][number]["cardStyle"] {
  if (kind === "cash") return "obsidian";
  if (kind === "credit") return "graphite";
  return "silver";
}

function normalizeAssetAccentLabel(value: string | undefined): CheckPhoneAssetsPayload["accounts"][number]["accentLabel"] {
  const normalized = value?.trim();
  if (normalized === "常用" || normalized === "备用" || normalized === "储备" || normalized === "增值" || normalized === "信用") {
    return normalized;
  }
  return "备用";
}

function parseAssetsBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const accountMatches = [...source.matchAll(/^#\s*账户(\d+)\s*$/gm)];
  const activityMatches = [...source.matchAll(/^#\s*流水(\d+)\s*$/gm)];
  if (accountMatches.length === 0 && activityMatches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #账户N 或 #流水N 分区" };
  }

  const blockEnd = (currentIndex: number, allMatches: RegExpMatchArray[]) => {
    const next = allMatches.find((match) => (match.index ?? 0) > currentIndex);
    return next?.index ?? source.length;
  };
  const allMatches = [...accountMatches, ...activityMatches].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const accountNameToId = new Map<string, string>();
  const accounts = accountMatches.map((current, index) => {
    const start = (current.index ?? 0) + current[0].length;
    const fields = parseTakeoutTaggedFields(source.slice(start, blockEnd(current.index ?? 0, allMatches)).trim());
    const order = String(index + 1);
    const kind = parseAssetAccountKind(fields["类型"]) || "cash";
    const title = fields["名称"] || "";
    const id = `asset_account_${order}`;
    if (title) accountNameToId.set(title, id);
    return {
      id,
      title,
      kind,
      bankLabel: fields["机构"] || "",
      maskedNumber: fields["尾号"] ? `•••• ${fields["尾号"].replace(/\D/g, "").slice(-4)}` : "",
      cardStyle: deriveAssetCardStyle(kind),
      balance: fields["余额"] || "",
      note: fields["备注"] || "",
      accentLabel: normalizeAssetAccentLabel(fields["标记"]),
    };
  });

  const firstAccountId = accounts[0]?.id ?? "";
  const activities = activityMatches.map((current, index) => {
    const start = (current.index ?? 0) + current[0].length;
    const fields = parseTakeoutTaggedFields(source.slice(start, blockEnd(current.index ?? 0, allMatches)).trim());
    const order = String(index + 1);
    const accountName = fields["账户"] || "";
    return {
      id: `asset_activity_${order}`,
      title: fields["标题"] || "",
      amount: fields["金额"] || "",
      category: fields["分类"] || "",
      createdAt: fields["时间"] || "",
      accountId: accountNameToId.get(accountName) || firstAccountId,
      detail: fields["详情"] || "",
    };
  });

  return {
    parsed: {
      headline: { totalLabel: "总资产", periodLabel: "账户与近期流水" },
      accounts,
      activities,
    },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

export async function generateCheckPhoneAssets(
  characterId: string,
  previousPayload?: CheckPhoneAssetsPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneAssetsPayload | null; summary: string; error?: string; debugRawOutput?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "assets", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_assets" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "" };
    const { parsed } = parseAssetsBlockPayload(rawOutput);
    const payload = normalizeAssetsPayload(parsed);
    if (!payload) return { payload: null, summary: "", error: "无法解析资产内容", debugRawOutput: rawOutput };
    return {
      payload,
      summary: formatSnapshotSummary(payload),
      debugRawOutput: rawOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "" };
  }
}

function normalizePhonePayload(payload: unknown): CheckPhonePhonePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));

  const contacts = (Array.isArray(record.contacts) ? record.contacts : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const contact = item as Record<string, unknown>;
      const id = typeof contact.id === "string" && contact.id.trim() ? contact.id.trim() : "";
      const name = typeof contact.name === "string" ? contact.name.trim() : "";
      const tagLabel = typeof contact.tagLabel === "string" ? contact.tagLabel.trim() : "";
      const note = typeof contact.note === "string" ? contact.note.trim() : "";
      const accentLabel = typeof contact.accentLabel === "string" && contact.accentLabel.trim() ? contact.accentLabel.trim() : tagLabel;
      if (!id || !name || !tagLabel || !note) return null;
      return { id, name, tagLabel, note, accentLabel };
    })
    .filter(Boolean) as CheckPhonePhonePayload["contacts"];

  const contactIds = new Set<string>();
  for (const contact of contacts) {
    if (contactIds.has(contact.id)) return null;
    contactIds.add(contact.id);
  }

  const recents = (Array.isArray(record.recents) ? record.recents : Array.isArray(record.calls) ? record.calls : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const call = item as Record<string, unknown>;
      const id = typeof call.id === "string" && call.id.trim() ? call.id.trim() : "";
      const name = typeof call.name === "string" ? call.name.trim() : "";
      const createdAt = typeof call.createdAt === "string" ? call.createdAt.trim() : "";
      const durationLabel = typeof call.durationLabel === "string" ? call.durationLabel.trim() : "";
      const direction = call.direction;
      const normalizedDirection =
        direction === "incoming" || direction === "outgoing" || direction === "missed"
          ? direction
          : null;
      const summary = typeof call.summary === "string" ? call.summary.trim() : "";
      const innerThought = typeof call.innerThought === "string" ? call.innerThought.trim() : "";
      if (!id || !name || !createdAt || !isIsoTimestamp(createdAt) || !durationLabel || !normalizedDirection || !summary || !innerThought) return null;
      return { id, name, createdAt, durationLabel, direction: normalizedDirection, summary, innerThought };
    })
    .filter(Boolean) as CheckPhonePhonePayload["recents"];

  const recentIds = new Set<string>();
  for (const call of recents) {
    if (recentIds.has(call.id)) return null;
    recentIds.add(call.id);
  }

  const voicemails = (Array.isArray(record.voicemails) ? record.voicemails : Array.isArray(record.voiceMails) ? record.voiceMails : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const vm = item as Record<string, unknown>;
      const id = typeof vm.id === "string" && vm.id.trim() ? vm.id.trim() : "";
      const name = typeof vm.name === "string" ? vm.name.trim() : "";
      const createdAt = typeof vm.createdAt === "string" ? vm.createdAt.trim() : "";
      const durationLabel = typeof vm.durationLabel === "string" ? vm.durationLabel.trim() : "";
      const transcript = typeof vm.transcript === "string" ? vm.transcript.trim() : "";
      if (!id || !name || !createdAt || !isIsoTimestamp(createdAt) || !durationLabel || !transcript) return null;
      return { id, name, createdAt, durationLabel, transcript };
    })
    .filter(Boolean) as CheckPhonePhonePayload["voicemails"];

  const voicemailIds = new Set<string>();
  for (const voicemail of voicemails) {
    if (voicemailIds.has(voicemail.id)) return null;
    voicemailIds.add(voicemail.id);
  }

  if (recents.length < 1 && contacts.length < 1 && voicemails.length < 1) return null;

  return {
    headerTitle: typeof record.headerTitle === "string" && record.headerTitle.trim() ? record.headerTitle.trim() : "电话",
    headerSubtitle:
      typeof record.headerSubtitle === "string" && record.headerSubtitle.trim()
        ? record.headerSubtitle.trim()
        : "最近联络与未接来电",
    recents: recents
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 12),
    contacts: contacts.slice(0, 10),
    voicemails: voicemails
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 6),
  };
}

export type PhoneBlockParseResult = {
  parsed: unknown | null;
  sanitizedCandidate: string;
  parseMode: "sanitized" | "failed";
  parseError?: string;
};

function parsePhoneDirection(value: string): CheckPhonePhonePayload["recents"][number]["direction"] | "" {
  const trimmed = value.trim();
  if (trimmed === "来电" || trimmed.toLowerCase() === "incoming") return "incoming";
  if (trimmed === "去电" || trimmed.toLowerCase() === "outgoing") return "outgoing";
  if (trimmed === "未接" || trimmed === "未接来电" || trimmed.toLowerCase() === "missed") return "missed";
  return "";
}

function parsePhoneSectionBlocks(
  source: string,
  sectionMatches: RegExpMatchArray[],
  sectionName: "最近通话" | "联系人" | "语音信箱",
) {
  const sectionIndex = sectionMatches.findIndex((match) => {
    const name = (match[1] || "").trim();
    return name === sectionName || (sectionName === "联系人" && name === "常用联系人");
  });
  if (sectionIndex < 0) return [];
  const current = sectionMatches[sectionIndex];
  const start = (current.index ?? 0) + current[0].length;
  const end = sectionMatches[sectionIndex + 1]?.index ?? source.length;
  const body = source.slice(start, end).trim();
  const label = sectionName === "最近通话" ? "通话" : sectionName === "联系人" ? "联系人" : "留言";
  const matches = [...body.matchAll(new RegExp(`^##\\s*${label}(\\d+)\\s*$`, "gm"))];
  return matches.map((currentMatch, index) => {
    const next = matches[index + 1];
    const blockStart = (currentMatch.index ?? 0) + currentMatch[0].length;
    const blockEnd = next?.index ?? body.length;
    return {
      number: Number(currentMatch[1] || index + 1),
      fields: parseTakeoutTaggedFields(body.slice(blockStart, blockEnd).trim()),
    };
  });
}

function parsePhoneBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const sectionMatches = [...source.matchAll(/^#\s*(最近通话|联系人|常用联系人|语音信箱)\s*$/gm)];
  if (sectionMatches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 #最近通话 / #联系人 / #语音信箱 分区" };
  }

  const recents = parsePhoneSectionBlocks(source, sectionMatches, "最近通话").map((entry) => ({
    id: `call_${entry.number}`,
    name: entry.fields["姓名"] || "",
    createdAt: entry.fields["时间"] || "",
    durationLabel: entry.fields["时长"] || "",
    direction: parsePhoneDirection(entry.fields["方向"] || ""),
    summary: entry.fields["内容"] || "",
    innerThought: entry.fields["内心"] || "",
  }));

  const contacts = parsePhoneSectionBlocks(source, sectionMatches, "联系人").map((entry) => ({
    id: `contact_${entry.number}`,
    name: entry.fields["姓名"] || "",
    tagLabel: entry.fields["标签"] || "",
    note: entry.fields["备注"] || "",
    accentLabel: entry.fields["标记"] || "",
  }));

  const voicemails = parsePhoneSectionBlocks(source, sectionMatches, "语音信箱").map((entry) => ({
    id: `vm_${entry.number}`,
    name: entry.fields["姓名"] || "",
    createdAt: entry.fields["时间"] || "",
    durationLabel: entry.fields["时长"] || "",
    transcript: entry.fields["转写"] || "",
  }));

  const parsed = {
    headerTitle: "电话",
    headerSubtitle: "最近联络与未接来电",
    recents,
    contacts,
    voicemails,
  };

  return { parsed, sanitizedCandidate: source, parseMode: "sanitized" };
}

function parseMessagesBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase().trim() === "true";
}

function parseMessagesDirection(value: string | undefined): "incoming" | "outgoing" | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["incoming", "来电", "对方", "对面", "发送人"].includes(normalized)) return "incoming";
  if (["outgoing", "outcoming", "去电", "自己", "本人", "我"].includes(normalized)) return "outgoing";
  return null;
}

function parseMessagesBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };
  const body = source.replace(/^#\s*线程\s*$/m, "").trim();
  const threadMatches = [...body.matchAll(/^##\s*线程(\d+)\s*$/gm)];
  if (threadMatches.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到 ##线程 分区" };
  }
  const threads = threadMatches.map((currentMatch, index) => {
    const next = threadMatches[index + 1];
    const start = (currentMatch.index ?? 0) + currentMatch[0].length;
    const end = next?.index ?? body.length;
    const fields = parseTakeoutTaggedFields(body.slice(start, end).trim());
    const messageEntries: Record<number, Record<string, string>> = {};
    for (const key of Object.keys(fields)) {
      const match = key.match(/^消息(\d+)(.+)$/);
      if (!match) continue;
      const idx = Number(match[1]);
      const fieldName = match[2];
      if (!messageEntries[idx]) messageEntries[idx] = {};
      messageEntries[idx][fieldName] = fields[key];
    }
    const messages = Object.entries(messageEntries)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([idx, entry]) => {
        const text = entry["正文"] || entry["text"] || "";
        const timeLabel = entry["时间"] || "";
        const direction = parseMessagesDirection(entry["发送方"] || entry["方向"] || entry["direction"]) ?? "incoming";
        return {
          id: `${currentMatch[1] || index + 1}-msg${idx}`,
          text,
          timeLabel,
          direction,
        };
      })
      .filter((item) => item.text);
    return {
      id: fields["线程ID"] || `thread${currentMatch[1] || index + 1}`,
      sender: fields["发送人"] || "",
      preview: messages[messages.length - 1]?.text || "",
      timeLabel: fields["时间"] || "",
      kind: typeof fields["类型"] === "string" && fields["类型"].trim() ? fields["类型"].trim() : "service",
      unread: parseMessagesBoolean(fields["未读"]),
      muted: parseMessagesBoolean(fields["静音"]),
      messages,
    };
  }).filter((thread) => thread.sender && thread.messages.length > 0);
  const parsed = {
    headerTitle: "信息",
    headerSubtitle: "通知与短信",
    featuredThreadId: threads[0]?.id ?? "",
    threads,
  };
  return { parsed, sanitizedCandidate: source, parseMode: "sanitized" };
}

export async function generateCheckPhonePhone(
  characterId: string,
  previousPayload?: CheckPhonePhonePayload | null,
  previousUpdatedAt?: string,
) : Promise<{ payload: CheckPhonePhonePayload | null; summary: string; error?: string; debugRawOutput?: string; debugSanitizedOutput?: string; debugParseMode?: "raw" | "sanitized" | "failed"; debugParseError?: string; debugNormalizeError?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "phone", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_phone" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parsePhoneBlockPayload(rawOutput);
    const normalized = normalizePhonePayload(parsed);
    if (!normalized) {
      return {
        payload: null,
        summary: "",
        error: "无法解析电话内容",
        debugRawOutput: rawOutput,
        debugSanitizedOutput: sanitizedCandidate,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnosePhoneNormalizeFailure(parsed) : undefined,
      };
    }
    return {
      payload: normalized,
      summary: formatSnapshotSummary(normalized),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

function diagnosePhoneNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;
  const contacts = Array.isArray(record.contacts) ? record.contacts : [];
  const recents = Array.isArray(record.recents) ? record.recents : Array.isArray(record.calls) ? record.calls : [];
  const voicemails = Array.isArray(record.voicemails) ? record.voicemails : Array.isArray(record.voiceMails) ? record.voiceMails : [];

  if (contacts.length + recents.length + voicemails.length < 1) return "没有解析到任何电话内容";

  const contactIds = new Set<string>();
  for (let index = 0; index < contacts.length; index += 1) {
    const item = contacts[index];
    if (!item || typeof item !== "object") return `contacts[${index}] 不是对象`;
    const recordItem = item as Record<string, unknown>;
    const id = typeof recordItem.id === "string" ? recordItem.id.trim() : "";
    if (!id) return `contacts[${index}].id 缺失`;
    if (contactIds.has(id)) return `contacts 存在重复 id: ${id}`;
    contactIds.add(id);
    if (typeof recordItem.name !== "string" || !recordItem.name.trim()) return `contacts[${index}].name 缺失`;
    if (typeof recordItem.tagLabel !== "string" || !recordItem.tagLabel.trim()) return `contacts[${index}].tagLabel 缺失`;
    if (typeof recordItem.note !== "string" || !recordItem.note.trim()) return `contacts[${index}].note 缺失`;
  }

  const validDirection = (value: unknown) => value === "incoming" || value === "outgoing" || value === "missed";
  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  const recentIds = new Set<string>();
  for (let index = 0; index < recents.length; index += 1) {
    const item = recents[index];
    if (!item || typeof item !== "object") return `recents[${index}] 不是对象`;
    const recordItem = item as Record<string, unknown>;
    const id = typeof recordItem.id === "string" ? recordItem.id.trim() : "";
    if (!id) return `recents[${index}].id 缺失`;
    if (recentIds.has(id)) return `recents 存在重复 id: ${id}`;
    recentIds.add(id);
    if (typeof recordItem.name !== "string" || !recordItem.name.trim()) return `recents[${index}].name 缺失`;
    if (typeof recordItem.createdAt !== "string" || !isIsoTimestamp(recordItem.createdAt.trim())) return `recents[${index}].createdAt 非法`;
    if (typeof recordItem.durationLabel !== "string" || !recordItem.durationLabel.trim()) return `recents[${index}].durationLabel 缺失`;
    if (!validDirection(recordItem.direction)) return `recents[${index}].direction 非法`;
    if (typeof recordItem.summary !== "string" || !recordItem.summary.trim()) return `recents[${index}].summary 缺失`;
    if (typeof recordItem.innerThought !== "string" || !recordItem.innerThought.trim()) return `recents[${index}].innerThought 缺失`;
  }

  const voicemailIds = new Set<string>();
  for (let index = 0; index < voicemails.length; index += 1) {
    const item = voicemails[index];
    if (!item || typeof item !== "object") return `voicemails[${index}] 不是对象`;
    const recordItem = item as Record<string, unknown>;
    const id = typeof recordItem.id === "string" ? recordItem.id.trim() : "";
    if (!id) return `voicemails[${index}].id 缺失`;
    if (voicemailIds.has(id)) return `voicemails 存在重复 id: ${id}`;
    voicemailIds.add(id);
    if (typeof recordItem.name !== "string" || !recordItem.name.trim()) return `voicemails[${index}].name 缺失`;
    if (typeof recordItem.createdAt !== "string" || !isIsoTimestamp(recordItem.createdAt.trim())) return `voicemails[${index}].createdAt 非法`;
    if (typeof recordItem.durationLabel !== "string" || !recordItem.durationLabel.trim()) return `voicemails[${index}].durationLabel 缺失`;
    if (typeof recordItem.transcript !== "string" || !recordItem.transcript.trim()) return `voicemails[${index}].transcript 缺失`;
  }

  return "结构存在字段缺失、枚举非法或重复id";
}

function normalizeShoppingProduct(
  item: unknown,
  defaults?: Partial<Pick<CheckPhoneShoppingPayload["recentlyViewed"][number], "merchantLabel" | "tagLabel" | "subtitle" | "detail">>,
): CheckPhoneShoppingPayload["recentlyViewed"][number] | null {
  if (!item || typeof item !== "object") return null;
  const product = item as Record<string, unknown>;
  const id = typeof product.id === "string" && product.id.trim() ? product.id.trim() : "";
  const title = typeof product.title === "string" ? product.title.trim() : "";
  const merchantLabel = typeof product.merchantLabel === "string" && product.merchantLabel.trim()
    ? product.merchantLabel.trim()
    : (defaults?.merchantLabel ?? "STORE");
  const priceLabel = typeof product.priceLabel === "string" ? product.priceLabel.trim() : "";
  const tagLabel = typeof product.tagLabel === "string" && product.tagLabel.trim()
    ? product.tagLabel.trim()
    : (defaults?.tagLabel ?? "商品");
  const subtitle = typeof product.subtitle === "string" && product.subtitle.trim()
    ? product.subtitle.trim()
    : (defaults?.subtitle ?? "");
  const detail = typeof product.detail === "string" && product.detail.trim()
    ? product.detail.trim()
    : (defaults?.detail ?? subtitle);
  const previewIcon = typeof product.previewIcon === "string" ? product.previewIcon.trim() : "";
  const tone = product.tone;
  const normalizedTone =
    tone === "ivory" || tone === "mist" || tone === "blush" || tone === "graphite"
      ? tone
      : null;
  if (!id || !title || !merchantLabel || !priceLabel || !tagLabel || !previewIcon || !normalizedTone) {
    return null;
  }
  return {
    id,
    title,
    merchantLabel,
    priceLabel,
    tagLabel,
    subtitle: subtitle || detail || title,
    detail: detail || subtitle || title,
    previewIcon,
    tone: normalizedTone,
  };
}

function deriveShoppingTone(index: number): CheckPhoneShoppingPayload["recentlyViewed"][number]["tone"] {
  const tones: CheckPhoneShoppingPayload["recentlyViewed"][number]["tone"][] = ["ivory", "mist", "blush", "graphite"];
  return tones[index % tones.length] ?? "ivory";
}

function parseShoppingProductFields(
  fields: Record<string, string>,
  id: string,
  tagLabel: string,
  index: number,
): CheckPhoneShoppingPayload["recentlyViewed"][number] {
  const subtitle = fields["说明"] || fields["详情"] || fields["名称"] || "";
  return {
    id,
    title: fields["名称"] || "",
    merchantLabel: fields["店铺"] || "",
    priceLabel: fields["价格"] || "",
    tagLabel,
    subtitle,
    detail: fields["详情"] || subtitle,
    previewIcon: fields["图标"] || "",
    tone: deriveShoppingTone(index),
  };
}

function extractShoppingTopLevelBlocks(source: string, label: string): Array<{ order: string; fields: Record<string, string> }> {
  const matches = [...source.matchAll(new RegExp(`^#\\s*${label}(\\d+)\\s*$`, "gm"))];
  const allHeadings = [...source.matchAll(/^#\s*\S.*$/gm)];
  return matches.map((current, index) => {
    const start = (current.index ?? 0) + current[0].length;
    const next = allHeadings.find((match) => (match.index ?? 0) > (current.index ?? 0));
    const end = next?.index ?? source.length;
    return {
      order: String(index + 1),
      fields: parseTakeoutTaggedFields(source.slice(start, end).trim()),
    };
  });
}

function parseShoppingOrderItems(
  fields: Record<string, string>,
  orderId: string,
  merchantLabel: string,
  statusLabel: string,
): CheckPhoneShoppingPayload["orders"][number]["items"] {
  const itemNumbers = Object.keys(fields)
    .map((key) => key.match(/^商品(\d+)名称$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);

  return itemNumbers.map((number, index) => {
    const prefix = `商品${number}`;
    const title = fields[`${prefix}名称`] || "";
    const subtitle = fields[`${prefix}说明`] || fields[`${prefix}详情`] || title;
    return {
      id: `${orderId}_item_${number}`,
      title,
      merchantLabel,
      priceLabel: fields[`${prefix}价格`] || "",
      quantityLabel: fields[`${prefix}数量`] || "× 1",
      subtitle,
      detail: fields[`${prefix}详情`] || subtitle,
      previewIcon: fields[`${prefix}图标`] || "",
      tone: deriveShoppingTone(index),
    };
  });
}

export function parseShoppingBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const recentlyViewed = extractShoppingTopLevelBlocks(source, "最近浏览").map((entry, index) =>
    parseShoppingProductFields(entry.fields, `view_${entry.order}`, "最近浏览", index),
  );
  const recommendations = extractShoppingTopLevelBlocks(source, "推荐").map((entry, index) =>
    parseShoppingProductFields(entry.fields, `rec_${entry.order}`, "为你推荐", index),
  );
  const savedItems = extractShoppingTopLevelBlocks(source, "收藏").map((entry, index) =>
    parseShoppingProductFields(entry.fields, `saved_${entry.order}`, "收藏", index),
  );
  const cartItems = extractShoppingTopLevelBlocks(source, "购物车").map((entry, index) => ({
    ...parseShoppingProductFields(entry.fields, `cart_${entry.order}`, "购物车", index),
    quantityLabel: entry.fields["数量"] || "× 1",
  }));
  const orders = extractShoppingTopLevelBlocks(source, "订单").map((entry) => {
    const id = `order_${entry.order}`;
    const statusLabel = entry.fields["状态"] || "";
    const merchantLabel = entry.fields["店铺"] || "";
    return {
      id,
      statusLabel,
      timeLabel: entry.fields["时间"] || "",
      totalLabel: entry.fields["总价"] || "",
      merchantLabel,
      summary: entry.fields["摘要"] || "",
      note: entry.fields["备注"] || entry.fields["摘要"] || "",
      items: parseShoppingOrderItems(entry.fields, id, merchantLabel, statusLabel),
    };
  });

  if (recentlyViewed.length + recommendations.length + savedItems.length + cartItems.length + orders.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到购物块" };
  }

  return {
    parsed: { recentlyViewed, recommendations, savedItems, cartItems, orders },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

export function normalizeShoppingPayload(payload: unknown): CheckPhoneShoppingPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const statsRaw = record.stats && typeof record.stats === "object" ? record.stats as Record<string, unknown> : null;
  const recentlyViewed = (Array.isArray(record.recentlyViewed) ? record.recentlyViewed : Array.isArray(record.viewedItems) ? record.viewedItems : [])
    .map((item) => normalizeShoppingProduct(item))
    .filter(Boolean) as CheckPhoneShoppingPayload["recentlyViewed"];
  const recommendations = (Array.isArray(record.recommendations) ? record.recommendations : Array.isArray(record.recommendedItems) ? record.recommendedItems : [])
    .map((item) => normalizeShoppingProduct(item, { tagLabel: "为你推荐" }))
    .filter(Boolean) as CheckPhoneShoppingPayload["recommendations"];
  const savedItems = (Array.isArray(record.savedItems) ? record.savedItems : Array.isArray(record.favorites) ? record.favorites : [])
    .map((item) => normalizeShoppingProduct(item, { tagLabel: "收藏" }))
    .filter(Boolean) as CheckPhoneShoppingPayload["savedItems"];
  const cartItems = (Array.isArray(record.cartItems) ? record.cartItems : Array.isArray(record.cart) ? record.cart : [])
    .map((item) => {
      const normalized = normalizeShoppingProduct(item, { tagLabel: "购物车" });
      if (!normalized || !item || typeof item !== "object") return null;
      const product = item as Record<string, unknown>;
      const quantityLabel =
        typeof product.quantityLabel === "string" && product.quantityLabel.trim()
          ? product.quantityLabel.trim()
          : typeof product.quantity === "number"
            ? `× ${product.quantity}`
            : typeof product.quantity === "string" && product.quantity.trim()
              ? `× ${product.quantity.trim()}`
              : "× 1";
      return { ...normalized, quantityLabel };
    })
    .filter(Boolean) as CheckPhoneShoppingPayload["cartItems"];
  const orders = (Array.isArray(record.orders) ? record.orders : Array.isArray(record.orderList) ? record.orderList : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const order = item as Record<string, unknown>;
      const id = typeof order.id === "string" && order.id.trim() ? order.id.trim() : "";
      const statusLabel = typeof order.statusLabel === "string" ? order.statusLabel.trim() : "";
      const timeLabel = typeof order.timeLabel === "string" ? order.timeLabel.trim() : "";
      const totalLabel = typeof order.totalLabel === "string" ? order.totalLabel.trim() : "";
      const merchantLabel = typeof order.merchantLabel === "string" ? order.merchantLabel.trim() : "";
      const summary = typeof order.summary === "string" ? order.summary.trim() : "";
      const note =
        typeof order.note === "string" && order.note.trim()
          ? order.note.trim()
          : typeof order.detail === "string" && order.detail.trim()
            ? order.detail.trim()
            : "";
      const items = (Array.isArray(order.items) ? order.items : Array.isArray(order.products) ? order.products : [])
        .map((entry) => {
          const normalized = normalizeShoppingProduct(entry, {
            merchantLabel: merchantLabel || "STORE",
            tagLabel: statusLabel || "订单商品",
            detail: note || summary,
          });
          if (!normalized || !entry || typeof entry !== "object") return null;
          const row = entry as Record<string, unknown>;
          const quantityLabel =
            typeof row.quantityLabel === "string" && row.quantityLabel.trim()
              ? row.quantityLabel.trim()
              : typeof row.quantity === "number"
                ? `× ${row.quantity}`
                : typeof row.quantity === "string" && row.quantity.trim()
                  ? `× ${row.quantity.trim()}`
                  : "× 1";
          return { ...normalized, quantityLabel };
        })
        .filter(Boolean) as CheckPhoneShoppingPayload["orders"][number]["items"];
      if (!id || !statusLabel || !timeLabel || !totalLabel || !merchantLabel || !summary || items.length === 0) return null;
      return {
        id,
        statusLabel,
        timeLabel,
        totalLabel,
        merchantLabel,
        summary,
        note: note || summary,
        items: items.slice(0, 4),
      };
    })
    .filter(Boolean) as CheckPhoneShoppingPayload["orders"];

  const uniqueSectionIds = (items: Array<{ id: string }>) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
    }
    return true;
  };

  const effectiveOrders = orders.slice(0, 8);
  if (
    !uniqueSectionIds(recentlyViewed) ||
    !uniqueSectionIds(recommendations) ||
    !uniqueSectionIds(savedItems) ||
    !uniqueSectionIds(cartItems) ||
    !uniqueSectionIds(effectiveOrders)
  ) {
    return null;
  }

  const pendingCountRaw = statsRaw
    ? (typeof statsRaw.pendingCount === "number" ? statsRaw.pendingCount : Number(statsRaw.pendingCount))
    : NaN;
  const cartCountRaw = statsRaw
    ? (typeof statsRaw.cartCount === "number" ? statsRaw.cartCount : Number(statsRaw.cartCount))
    : NaN;
  const savedCountRaw = statsRaw
    ? (typeof statsRaw.savedCount === "number" ? statsRaw.savedCount : Number(statsRaw.savedCount))
    : NaN;
  const pendingCount = Number.isFinite(pendingCountRaw)
    ? Math.max(0, Math.round(pendingCountRaw))
    : effectiveOrders.filter((order) => /待|配送|运输|收货/.test(order.statusLabel)).length;
  const cartCount = Number.isFinite(cartCountRaw)
    ? Math.max(0, Math.round(cartCountRaw))
    : cartItems.length;
  const savedCount = Number.isFinite(savedCountRaw)
    ? Math.max(0, Math.round(savedCountRaw))
    : savedItems.length;

  return {
    headerTitle: "购物",
    headerSubtitle: "最近的订单与心动",
    searchHint: "搜索商品",
    stats: {
      pendingCount,
      cartCount,
      savedCount,
    },
    recentlyViewed: recentlyViewed.slice(0, 12),
    recommendations: recommendations.slice(0, 10),
    savedItems: savedItems.slice(0, 10),
    cartItems: cartItems.slice(0, 6),
    orders: effectiveOrders,
  };
}

export async function generateCheckPhoneShopping(
  characterId: string,
  previousPayload?: CheckPhoneShoppingPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneShoppingPayload | null; summary: string; error?: string; rawOutput?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", rawOutput: "" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "shopping", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_shopping" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", rawOutput: rawOutput ?? "" };
    const { parsed } = parseShoppingBlockPayload(rawOutput);
    const normalized = normalizeShoppingPayload(parsed);
    if (!normalized) return { payload: null, summary: "", error: "无法解析购物内容", rawOutput };
    return {
      payload: normalized,
      summary: formatSnapshotSummary(normalized),
      rawOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, rawOutput: "" };
  }
}

function deriveMusicTone(index: number): CheckPhoneMusicPayload["recentTracks"][number]["tone"] {
  const tones: CheckPhoneMusicPayload["recentTracks"][number]["tone"][] = ["obsidian", "graphite", "silver", "mist"];
  return tones[index % tones.length] ?? "obsidian";
}

function extractMusicBlocks(source: string, label: string): Array<{ order: string; fields: Record<string, string> }> {
  const matches = [...source.matchAll(new RegExp(`^#\\s*${label}(\\d+)\\s*$`, "gm"))];
  const allHeadings = [...source.matchAll(/^#\s*\S.*$/gm)];
  return matches.map((current, index) => {
    const start = (current.index ?? 0) + current[0].length;
    const next = allHeadings.find((match) => (match.index ?? 0) > (current.index ?? 0));
    const end = next?.index ?? source.length;
    return {
      order: String(index + 1),
      fields: parseTakeoutTaggedFields(source.slice(start, end).trim()),
    };
  });
}

function parseMusicTrackFields(
  fields: Record<string, string>,
  id: string,
  liked: boolean,
  index: number,
): CheckPhoneMusicPayload["recentTracks"][number] {
  return {
    id,
    title: fields["歌名"] || "",
    artist: fields["歌手"] || "",
    albumTitle: fields["专辑"] || "",
    coverIcon: fields["图标"] || "",
    tone: deriveMusicTone(index),
    durationLabel: fields["时长"] || "",
    note: fields["内心"] || fields["备注"] || "",
    liked: liked || parseBlockBoolean(fields["喜欢"]),
  };
}

function parseMusicBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const firstSection = source.search(/^#\s*\S.*$/m);
  const profileFields = parseTakeoutTaggedFields(firstSection >= 0 ? source.slice(0, firstSection).trim() : source);
  const recentTracks = extractMusicBlocks(source, "最近播放").map((entry, index) =>
    parseMusicTrackFields(entry.fields, `recent_track_${entry.order}`, false, index),
  );
  const likedTracks = extractMusicBlocks(source, "收藏歌曲").map((entry, index) =>
    parseMusicTrackFields(entry.fields, `liked_track_${entry.order}`, true, index + recentTracks.length),
  );
  const trackTitleToId = new Map<string, string>();
  for (const track of [...recentTracks, ...likedTracks]) {
    if (track.title && !trackTitleToId.has(track.title)) trackTitleToId.set(track.title, track.id);
  }
  const playlists = extractMusicBlocks(source, "歌单").map((entry, index) => {
    const trackIds = Object.keys(entry.fields)
      .map((key) => key.match(/^歌曲(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b)
      .map((number) => trackTitleToId.get(entry.fields[`歌曲${number}`] || ""))
      .filter(Boolean) as string[];
    return {
      id: `playlist_${entry.order}`,
      title: entry.fields["名称"] || "",
      subtitle: entry.fields["副标题"] || "",
      coverIcon: entry.fields["图标"] || "",
      tone: deriveMusicTone(index + recentTracks.length + likedTracks.length),
      trackIds,
      saved: parseBlockBoolean(entry.fields["收藏"]),
      curatorNote: entry.fields["内心"] || entry.fields["说明"] || "",
    };
  });

  if (recentTracks.length + likedTracks.length + playlists.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到音乐块" };
  }

  return {
    parsed: {
      profile: {
        nickname: profileFields["昵称"] || "",
        listeningMood: profileFields["听歌状态"] || "最近的循环方式",
        monthlyMinutesLabel: profileFields["本月时长"] || "本月听歌",
        topArtistLabel: profileFields["偏爱歌手"] || "最近偏爱",
      },
      nowPlayingTrackId: recentTracks[0]?.id || likedTracks[0]?.id || "",
      recentTracks,
      likedTracks,
      playlists,
    },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

function normalizeMusicPayload(payload: unknown): CheckPhoneMusicPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  const normalizeTrack = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const authorName = typeof item.authorName === "string" ? item.authorName.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const artist = typeof item.artist === "string" ? item.artist.trim() : "";
    const albumTitle = typeof item.albumTitle === "string" ? item.albumTitle.trim() : "";
    const coverIcon = typeof item.coverIcon === "string" ? item.coverIcon.trim() : "";
    const tone =
      item.tone === "obsidian" || item.tone === "graphite" || item.tone === "silver" || item.tone === "mist"
        ? item.tone
        : "obsidian";
    const durationLabel = typeof item.durationLabel === "string" ? item.durationLabel.trim() : "";
    const note = typeof item.note === "string" && item.note.trim()
      ? item.note.trim()
      : typeof item.innerThought === "string"
        ? item.innerThought.trim()
        : "";
    if (!id || !title || !artist || !albumTitle || !coverIcon || !durationLabel || !note) return null;
    return {
      id,
      ...(authorName ? { authorName } : {}),
      title,
      artist,
      albumTitle,
      coverIcon,
      tone,
      durationLabel,
      note,
      liked: item.liked === true,
    };
  };

  const normalizePlaylist = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const subtitle = typeof item.subtitle === "string" ? item.subtitle.trim() : "";
    const coverIcon = typeof item.coverIcon === "string" ? item.coverIcon.trim() : "";
    const tone =
      item.tone === "obsidian" || item.tone === "graphite" || item.tone === "silver" || item.tone === "mist"
        ? item.tone
        : "graphite";
    const curatorNote = typeof item.curatorNote === "string" && item.curatorNote.trim()
      ? item.curatorNote.trim()
      : typeof item.innerThought === "string"
        ? item.innerThought.trim()
        : "";
    const trackIds = (Array.isArray(item.trackIds) ? item.trackIds : [])
      .map((value) => String(value).trim())
      .filter(Boolean)
      .slice(0, 24);
    if (!id || !title || !subtitle || !coverIcon || !curatorNote) return null;
    return {
      id,
      title,
      subtitle,
      coverIcon,
      tone,
      trackIds,
      saved: item.saved === true,
      curatorNote,
    };
  };

  const profileRaw = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
  const nickname = typeof profileRaw?.nickname === "string" ? profileRaw.nickname.trim() : "";
  const listeningMood = typeof profileRaw?.listeningMood === "string" && profileRaw.listeningMood.trim() ? profileRaw.listeningMood.trim() : "最近的循环方式";
  const monthlyMinutesLabel = typeof profileRaw?.monthlyMinutesLabel === "string" && profileRaw.monthlyMinutesLabel.trim() ? profileRaw.monthlyMinutesLabel.trim() : "本月听歌";
  const topArtistLabel = typeof profileRaw?.topArtistLabel === "string" && profileRaw.topArtistLabel.trim() ? profileRaw.topArtistLabel.trim() : "最近偏爱";

  const recentTracks = (Array.isArray(record.recentTracks) ? record.recentTracks : Array.isArray(record.historyTracks) ? record.historyTracks : [])
    .map(normalizeTrack)
    .filter(Boolean) as CheckPhoneMusicPayload["recentTracks"];
  const likedTracks = (Array.isArray(record.likedTracks) ? record.likedTracks : Array.isArray(record.favorites) ? record.favorites : [])
    .map(normalizeTrack)
    .filter(Boolean) as CheckPhoneMusicPayload["likedTracks"];
  const playlists = (Array.isArray(record.playlists) ? record.playlists : Array.isArray(record.playlistCards) ? record.playlistCards : [])
    .map(normalizePlaylist)
    .filter(Boolean) as CheckPhoneMusicPayload["playlists"];

  const dedupeIds = (items: Array<{ id: string }>) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
    }
    return true;
  };

  const validTrackIds = new Set([...recentTracks, ...likedTracks].map((track) => track.id));
  const nowPlayingTrackId =
    typeof record.nowPlayingTrackId === "string" && record.nowPlayingTrackId.trim()
      ? record.nowPlayingTrackId.trim()
      : recentTracks[0]?.id || likedTracks[0]?.id || "";

  if (!dedupeIds(recentTracks) || !dedupeIds(likedTracks) || !dedupeIds(playlists)) {
    return null;
  }
  const normalizedPlaylists = playlists.map((playlist) => ({
    ...playlist,
    trackIds: playlist.trackIds.filter((id) => validTrackIds.has(id)),
  }));

  return {
    headerTitle: "音乐",
    profile: {
      nickname,
      listeningMood,
      monthlyMinutesLabel,
      topArtistLabel,
    },
    nowPlayingTrackId: validTrackIds.has(nowPlayingTrackId) ? nowPlayingTrackId : undefined,
    recentTracks: recentTracks.slice(0, 16),
    likedTracks: likedTracks.slice(0, 14),
    playlists: normalizedPlaylists.slice(0, 10),
  };
}

export async function generateCheckPhoneMusic(
  characterId: string,
  previousPayload?: CheckPhoneMusicPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneMusicPayload | null; summary: string; error?: string; debugRawOutput?: string; debugParseMode?: "raw" | "sanitized" | "failed"; debugParseError?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "music", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_music" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, parseMode, parseError } = parseMusicBlockPayload(rawOutput);
    const normalized = normalizeMusicPayload(parsed);
    if (!normalized) {
      return {
        payload: null,
        summary: "",
        error: "无法解析音乐内容",
        debugRawOutput: rawOutput,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
      };
    }
    return {
      payload: normalized,
      summary: formatSnapshotSummary(normalized),
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

function deriveDoubanTone(index: number) {
  const tones = ["linen", "mist", "graphite", "blush"] as const;
  return tones[index % tones.length] ?? "linen";
}

const DOUBAN_ACTIVITY_TYPE_MAP: Record<string, CheckPhoneDoubanActivityType> = {
  "发帖": "post",
  "广播": "post",
  "影评": "movie_review",
  "短评": "movie_review",
  "电影": "movie_review",
  "书评": "book_review",
  "图书": "book_review",
  "日记": "diary",
  "听过": "listened",
  "音乐": "listened",
  "想看": "want_watch",
  "想读": "want_read",
};

const DOUBAN_ACTIVITY_LABELS: Record<CheckPhoneDoubanActivityType, { action: string; category: string }> = {
  post: { action: "发帖", category: "广播" },
  movie_review: { action: "影评", category: "电影" },
  book_review: { action: "书评", category: "图书" },
  diary: { action: "日记", category: "日记" },
  listened: { action: "听过", category: "音乐" },
  want_watch: { action: "想看", category: "电影" },
  want_read: { action: "想读", category: "图书" },
};

function normalizeDoubanActivityType(value: string | undefined): CheckPhoneDoubanActivityType {
  return DOUBAN_ACTIVITY_TYPE_MAP[(value || "").trim()] ?? "post";
}

function parseDoubanTopicComments(
  fields: Record<string, string>,
  topicId: string,
): NonNullable<CheckPhoneDoubanPayload["repliedTopics"]>[number]["comments"] {
  return Object.keys(fields)
    .map((key) => key.match(/^评论(\d+)作者$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
    .map((number) => ({
      id: `${topicId}_comment_${number}`,
      authorName: fields[`评论${number}作者`] || "",
      text: fields[`评论${number}内容`] || "",
      createdAt: fields[`评论${number}时间`] || "",
      replyTo: fields[`评论${number}回复`] || undefined,
    }));
}

function parseDoubanTopicFields(
  fields: Record<string, string>,
  id: string,
): NonNullable<CheckPhoneDoubanPayload["repliedTopics"]>[number] {
  return {
    id,
    groupName: fields["小组"] || "",
    title: fields["标题"] || "",
    authorName: fields["作者"] || "",
    body: fields["正文"] || "",
    createdAt: fields["时间"] || "",
    likeCount: parseBlockInteger(fields["点赞"]),
    saveCount: parseBlockInteger(fields["收藏"]),
    repostCount: parseBlockInteger(fields["转发"]),
    comments: parseDoubanTopicComments(fields, id),
  };
}

function parseDoubanActivityFields(
  fields: Record<string, string>,
  id: string,
): CheckPhoneDoubanPayload["activities"][number] {
  const type = normalizeDoubanActivityType(fields["类型"]);
  const fallback = DOUBAN_ACTIVITY_LABELS[type];
  const rating = parseBlockInteger(fields["评分"]);
  return {
    id,
    type,
    actionLabel: fields["动作"] || fallback.action,
    categoryLabel: fields["分类"] || fallback.category,
    title: fields["标题"] || fields["条目"] || "",
    body: fields["正文"] || "",
    createdAt: fields["时间"] || "",
    subjectName: fields["条目"] || undefined,
    subjectMeta: fields["条目信息"] || undefined,
    coverIcon: fields["图标"] || undefined,
    rating: Number.isFinite(rating) ? rating : undefined,
    reactionCount: parseBlockInteger(fields["回应"]),
    commentCount: parseBlockInteger(fields["评论"]),
  };
}

function parseDoubanBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const activityBlocks = extractTopLevelTaggedBlocks(source, "动态");
  if (activityBlocks.length > 0) {
    const firstActivityIndex = source.search(/^#动态\d+/m);
    const profileFields = parseDouyinTaggedFields(firstActivityIndex >= 0 ? source.slice(0, firstActivityIndex).trim() : source);
    const profile = {
      name: profileFields["昵称"] || "",
      bio: profileFields["简介"] || "",
      location: profileFields["城市"] || undefined,
      joinedAt: profileFields["加入时间"] || undefined,
      followingCount: parseBlockInteger(profileFields["关注"]),
      followerCount: parseBlockInteger(profileFields["被关注"]),
      wantWatchCount: parseBlockInteger(profileFields["想看"]),
      wantReadCount: parseBlockInteger(profileFields["想读"]),
    };
    const activities = activityBlocks.map((entry) => parseDoubanActivityFields(entry.fields, `douban_activity_${entry.order}`));
    return {
      parsed: { profile, activities },
      sanitizedCandidate: source,
      parseMode: "sanitized",
    };
  }

  const myGroups = extractTopLevelTaggedBlocks(source, "小组").map((entry, index) => ({
    id: `group_${entry.order}`,
    name: entry.fields["名称"] || "",
    coverIcon: entry.fields["图标"] || "",
    tone: deriveDoubanTone(index),
    memberCount: parseBlockInteger(entry.fields["成员数"]),
    latestUpdate: entry.fields["最近更新"] || "",
    updatedAt: entry.fields["更新时间"] || "",
  }));
  const repliedTopics = extractTopLevelTaggedBlocks(source, "回复帖子").map((entry) =>
    parseDoubanTopicFields(entry.fields, `replied_topic_${entry.order}`),
  );
  const publishedTopics = extractTopLevelTaggedBlocks(source, "发布帖子").map((entry) =>
    parseDoubanTopicFields(entry.fields, `published_topic_${entry.order}`),
  );

  if (myGroups.length + repliedTopics.length + publishedTopics.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到豆瓣块" };
  }

  return {
    parsed: { myGroups, repliedTopics, publishedTopics },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

function normalizeDoubanPayload(payload: unknown): CheckPhoneDoubanPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));

  const normalizeComment = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const authorName = typeof item.authorName === "string" ? item.authorName.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
    const replyTo = typeof item.replyTo === "string" && item.replyTo.trim() ? item.replyTo.trim() : undefined;
    if (!id || !authorName || !text || !createdAt || !isIsoTimestamp(createdAt)) return null;
    return { id, authorName, text, createdAt, replyTo };
  };

  const normalizeGroup = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const coverIcon = typeof item.coverIcon === "string" ? item.coverIcon.trim() : "";
    const tone =
      item.tone === "linen" || item.tone === "mist" || item.tone === "graphite" || item.tone === "blush"
        ? item.tone
        : "linen";
    const memberCount = typeof item.memberCount === "number" ? item.memberCount : Number(item.memberCount);
    const latestUpdate = typeof item.latestUpdate === "string" ? item.latestUpdate.trim() : "";
    const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt.trim() : "";
    if (!id || !name || !coverIcon || !Number.isFinite(memberCount) || !latestUpdate || !updatedAt || !isIsoTimestamp(updatedAt)) {
      return null;
    }
    return {
      id,
      name,
      coverIcon,
      tone,
      memberCount: Math.max(0, Math.round(memberCount)),
      latestUpdate,
      updatedAt,
    };
  };

  const normalizeTopic = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const groupName = typeof item.groupName === "string" ? item.groupName.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const authorName = typeof item.authorName === "string" ? item.authorName.trim() : "";
    const body = typeof item.body === "string" ? item.body.trim() : "";
    const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
    const likeCount = typeof item.likeCount === "number" ? item.likeCount : Number(item.likeCount);
    const saveCount = typeof item.saveCount === "number" ? item.saveCount : Number(item.saveCount);
    const repostCount = typeof item.repostCount === "number" ? item.repostCount : Number(item.repostCount);
    const comments = (Array.isArray(item.comments) ? item.comments : [])
      .map((comment) => normalizeComment(comment))
        .filter(Boolean) as NonNullable<CheckPhoneDoubanPayload["repliedTopics"]>[number]["comments"];
    if (
      !id ||
      !groupName ||
      !title ||
      !authorName ||
      !body ||
      !createdAt ||
      !isIsoTimestamp(createdAt) ||
      !Number.isFinite(likeCount) ||
      !Number.isFinite(saveCount) ||
      !Number.isFinite(repostCount)
    ) {
      return null;
    }
    return {
      id,
      groupName,
      title,
      authorName,
      body,
      createdAt,
      likeCount: Math.max(0, Math.round(likeCount)),
      saveCount: Math.max(0, Math.round(saveCount)),
      repostCount: Math.max(0, Math.round(repostCount)),
      comments: comments.slice(0, 10),
    };
  };

  const normalizeActivity = (entry: unknown, fallbackIndex: number) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `douban_activity_${fallbackIndex + 1}`;
    const type = normalizeDoubanActivityType(typeof item.type === "string" ? item.type : undefined);
    const fallback = DOUBAN_ACTIVITY_LABELS[type];
    const actionLabel = typeof item.actionLabel === "string" && item.actionLabel.trim() ? item.actionLabel.trim() : fallback.action;
    const categoryLabel = typeof item.categoryLabel === "string" && item.categoryLabel.trim() ? item.categoryLabel.trim() : fallback.category;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const body = typeof item.body === "string" ? item.body.trim() : "";
    const createdAt = typeof item.createdAt === "string" ? item.createdAt.trim() : "";
    const subjectName = typeof item.subjectName === "string" && item.subjectName.trim() ? item.subjectName.trim() : undefined;
    const subjectMeta = typeof item.subjectMeta === "string" && item.subjectMeta.trim() ? item.subjectMeta.trim() : undefined;
    const coverIcon = typeof item.coverIcon === "string" && item.coverIcon.trim() ? item.coverIcon.trim() : undefined;
    const rating = typeof item.rating === "number" ? item.rating : Number(item.rating);
    const reactionCount = typeof item.reactionCount === "number" ? item.reactionCount : Number(item.reactionCount);
    const commentCount = typeof item.commentCount === "number" ? item.commentCount : Number(item.commentCount);
    if (!id || !title || !body || !createdAt || !isIsoTimestamp(createdAt)) return null;
    return {
      id,
      type,
      actionLabel,
      categoryLabel,
      title,
      body,
      createdAt,
      subjectName,
      subjectMeta,
      coverIcon,
      rating: Number.isFinite(rating) ? Math.min(5, Math.max(1, Math.round(rating))) : undefined,
      reactionCount: Number.isFinite(reactionCount) ? Math.max(0, Math.round(reactionCount)) : 0,
      commentCount: Number.isFinite(commentCount) ? Math.max(0, Math.round(commentCount)) : 0,
    };
  };

  const myGroups = (Array.isArray(record.myGroups) ? record.myGroups : Array.isArray(record.groups) ? record.groups : [])
    .map((entry) => normalizeGroup(entry))
    .filter(Boolean) as NonNullable<CheckPhoneDoubanPayload["myGroups"]>;
  const repliedTopics = (Array.isArray(record.repliedTopics) ? record.repliedTopics : Array.isArray(record.repliedPosts) ? record.repliedPosts : [])
    .map((entry) => normalizeTopic(entry))
    .filter(Boolean) as NonNullable<CheckPhoneDoubanPayload["repliedTopics"]>;
  const publishedTopics = (Array.isArray(record.publishedTopics) ? record.publishedTopics : Array.isArray(record.myTopics) ? record.myTopics : [])
    .map((entry) => normalizeTopic(entry))
    .filter(Boolean) as NonNullable<CheckPhoneDoubanPayload["publishedTopics"]>;

  const legacyActivities = [
    ...publishedTopics.map((item) => ({
      id: `legacy_${item.id}`,
      type: "post" as CheckPhoneDoubanActivityType,
      actionLabel: "发帖",
      categoryLabel: "小组",
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
      subjectName: item.groupName,
      coverIcon: "✎",
      reactionCount: item.likeCount,
      commentCount: item.comments.length,
    })),
    ...repliedTopics.map((item) => ({
      id: `legacy_${item.id}`,
      type: "post" as CheckPhoneDoubanActivityType,
      actionLabel: "回帖",
      categoryLabel: "小组",
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
      subjectName: item.groupName,
      coverIcon: "💬",
      reactionCount: item.likeCount,
      commentCount: item.comments.length,
    })),
    ...myGroups.map((item) => ({
      id: `legacy_${item.id}`,
      type: "post" as CheckPhoneDoubanActivityType,
      actionLabel: "关注小组",
      categoryLabel: "小组",
      title: item.name,
      body: item.latestUpdate,
      createdAt: item.updatedAt,
      coverIcon: item.coverIcon,
      reactionCount: item.memberCount,
      commentCount: 0,
    })),
  ];

  const activities = (Array.isArray(record.activities) ? record.activities : [])
    .map((entry, index) => normalizeActivity(entry, index))
    .filter(Boolean) as CheckPhoneDoubanPayload["activities"];

  const normalizedActivities = (activities.length ? activities : legacyActivities)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 16);

  const profileRecord = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
  const profileName = profileRecord && typeof profileRecord.name === "string" ? profileRecord.name.trim() : "";
  const profileBio = profileRecord && typeof profileRecord.bio === "string" ? profileRecord.bio.trim() : "";
  const joinedAt = profileRecord && typeof profileRecord.joinedAt === "string" && profileRecord.joinedAt.trim() ? profileRecord.joinedAt.trim() : undefined;
  const followingCount = profileRecord && typeof profileRecord.followingCount === "number" ? profileRecord.followingCount : Number(profileRecord?.followingCount);
  const followerCount = profileRecord && typeof profileRecord.followerCount === "number" ? profileRecord.followerCount : Number(profileRecord?.followerCount);
  const wantWatchCount = profileRecord && typeof profileRecord.wantWatchCount === "number" ? profileRecord.wantWatchCount : Number(profileRecord?.wantWatchCount);
  const wantReadCount = profileRecord && typeof profileRecord.wantReadCount === "number" ? profileRecord.wantReadCount : Number(profileRecord?.wantReadCount);

  const profile = {
    name: profileName || "豆友",
    bio: profileBio || "生活、电影和书籍。",
    location: profileRecord && typeof profileRecord.location === "string" && profileRecord.location.trim() ? profileRecord.location.trim() : undefined,
    joinedAt: joinedAt && isIsoTimestamp(joinedAt) ? joinedAt : undefined,
    followingCount: Number.isFinite(followingCount) ? Math.max(0, Math.round(followingCount)) : 0,
    followerCount: Number.isFinite(followerCount) ? Math.max(0, Math.round(followerCount)) : 0,
    wantWatchCount: Number.isFinite(wantWatchCount) ? Math.max(0, Math.round(wantWatchCount)) : 0,
    wantReadCount: Number.isFinite(wantReadCount) ? Math.max(0, Math.round(wantReadCount)) : 0,
  };

  const dedupeIds = (items: Array<{ id: string }>) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
    }
    return true;
  };

  if (
    !dedupeIds(myGroups) ||
    !dedupeIds(repliedTopics) ||
    !dedupeIds(publishedTopics) ||
    !dedupeIds(normalizedActivities)
  ) {
    return null;
  }

  if (normalizedActivities.length === 0) return null;

  return {
    headerTitle: "我的",
    headerSubtitle: "动态",
    profile,
    activities: normalizedActivities,
    myGroups: myGroups.slice(0, 10),
    repliedTopics: repliedTopics.slice(0, 8),
    publishedTopics: publishedTopics.slice(0, 8),
  };
}

export async function generateCheckPhoneDouban(
  characterId: string,
  previousPayload?: CheckPhoneDoubanPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneDoubanPayload | null; summary: string; error?: string; debugRawOutput?: string; debugParseMode?: "raw" | "sanitized" | "failed"; debugParseError?: string; debugNormalizeError?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "douban", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_douban" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, parseMode, parseError } = parseDoubanBlockPayload(rawOutput);
    const normalized = normalizeDoubanPayload(parsed);
    if (!normalized) {
      return {
        payload: null,
        summary: "",
        error: "无法解析豆瓣内容",
        debugRawOutput: rawOutput,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? diagnoseDoubanNormalizeFailure(parsed) : undefined,
      };
    }
    return {
      payload: normalized,
      summary: formatSnapshotSummary(normalized),
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

function diagnoseDoubanNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;

  const myGroups = Array.isArray(record.myGroups) ? record.myGroups : Array.isArray(record.groups) ? record.groups : [];
  const repliedTopics = Array.isArray(record.repliedTopics) ? record.repliedTopics : Array.isArray(record.repliedPosts) ? record.repliedPosts : [];
  const publishedTopics = Array.isArray(record.publishedTopics) ? record.publishedTopics : Array.isArray(record.myTopics) ? record.myTopics : [];
  const activities = Array.isArray(record.activities) ? record.activities : [];

  const isIsoTimestamp = (value: string) => !Number.isNaN(Date.parse(value));
  const validTone = (value: unknown) =>
    value === "linen" || value === "mist" || value === "graphite" || value === "blush";

  const findDuplicateId = (items: unknown[]) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const id = typeof (item as Record<string, unknown>).id === "string" ? ((item as Record<string, unknown>).id as string).trim() : "";
      if (!id) continue;
      if (seen.has(id)) return id;
      seen.add(id);
    }
    return null;
  };

  const duplicateGroupId = findDuplicateId(myGroups);
  if (duplicateGroupId) return `myGroups 存在重复 id: ${duplicateGroupId}`;
  const duplicateRepliedId = findDuplicateId(repliedTopics);
  if (duplicateRepliedId) return `repliedTopics 存在重复 id: ${duplicateRepliedId}`;
  const duplicatePublishedId = findDuplicateId(publishedTopics);
  if (duplicatePublishedId) return `publishedTopics 存在重复 id: ${duplicatePublishedId}`;
  const duplicateActivityId = findDuplicateId(activities);
  if (duplicateActivityId) return `activities 存在重复 id: ${duplicateActivityId}`;

  if (activities.length > 0) {
    for (let index = 0; index < activities.length; index += 1) {
      const item = activities[index];
      if (!item || typeof item !== "object") return `activities[${index}] 不是对象`;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" || !entry.id.trim()) return `activities[${index}].id 缺失`;
      if (typeof entry.title !== "string" || !entry.title.trim()) return `activities[${index}].title 缺失`;
      if (typeof entry.body !== "string" || !entry.body.trim()) return `activities[${index}].body 缺失`;
      if (typeof entry.createdAt !== "string" || !entry.createdAt.trim() || !isIsoTimestamp(entry.createdAt)) {
        return `activities[${index}].createdAt 非法`;
      }
      if (!Number.isFinite(typeof entry.reactionCount === "number" ? entry.reactionCount : Number(entry.reactionCount))) {
        return `activities[${index}].reactionCount 非法`;
      }
      if (!Number.isFinite(typeof entry.commentCount === "number" ? entry.commentCount : Number(entry.commentCount))) {
        return `activities[${index}].commentCount 非法`;
      }
    }
  }

  for (let index = 0; index < myGroups.length; index += 1) {
    const item = myGroups[index];
    if (!item || typeof item !== "object") return `myGroups[${index}] 不是对象`;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id.trim()) return `myGroups[${index}].id 缺失`;
    if (typeof entry.name !== "string" || !entry.name.trim()) return `myGroups[${index}].name 缺失`;
    if (typeof entry.coverIcon !== "string" || !entry.coverIcon.trim()) return `myGroups[${index}].coverIcon 缺失`;
    if (!validTone(entry.tone)) return `myGroups[${index}].tone 非法`;
    if (!Number.isFinite(typeof entry.memberCount === "number" ? entry.memberCount : Number(entry.memberCount))) {
      return `myGroups[${index}].memberCount 非法`;
    }
    if (typeof entry.latestUpdate !== "string" || !entry.latestUpdate.trim()) return `myGroups[${index}].latestUpdate 缺失`;
    if (typeof entry.updatedAt !== "string" || !entry.updatedAt.trim() || !isIsoTimestamp(entry.updatedAt)) {
      return `myGroups[${index}].updatedAt 非法`;
    }
  }

  const inspectTopic = (items: unknown[], label: "repliedTopics" | "publishedTopics") => {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || typeof item !== "object") return `${label}[${index}] 不是对象`;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" || !entry.id.trim()) return `${label}[${index}].id 缺失`;
      if (typeof entry.groupName !== "string" || !entry.groupName.trim()) return `${label}[${index}].groupName 缺失`;
      if (typeof entry.title !== "string" || !entry.title.trim()) return `${label}[${index}].title 缺失`;
      if (typeof entry.authorName !== "string" || !entry.authorName.trim()) return `${label}[${index}].authorName 缺失`;
      if (typeof entry.body !== "string" || !entry.body.trim()) return `${label}[${index}].body 缺失`;
      if (typeof entry.createdAt !== "string" || !entry.createdAt.trim() || !isIsoTimestamp(entry.createdAt)) {
        return `${label}[${index}].createdAt 非法`;
      }
      if (!Number.isFinite(typeof entry.likeCount === "number" ? entry.likeCount : Number(entry.likeCount))) {
        return `${label}[${index}].likeCount 非法`;
      }
      if (!Number.isFinite(typeof entry.saveCount === "number" ? entry.saveCount : Number(entry.saveCount))) {
        return `${label}[${index}].saveCount 非法`;
      }
      if (!Number.isFinite(typeof entry.repostCount === "number" ? entry.repostCount : Number(entry.repostCount))) {
        return `${label}[${index}].repostCount 非法`;
      }
      if (!Array.isArray(entry.comments)) return `${label}[${index}].comments 缺失`;
      const commentIds = new Set<string>();
      for (let commentIndex = 0; commentIndex < entry.comments.length; commentIndex += 1) {
        const comment = entry.comments[commentIndex];
        if (!comment || typeof comment !== "object") return `${label}[${index}].comments[${commentIndex}] 不是对象`;
        const commentEntry = comment as Record<string, unknown>;
        const commentId = typeof commentEntry.id === "string" ? commentEntry.id.trim() : "";
        if (!commentId) return `${label}[${index}].comments[${commentIndex}].id 缺失`;
        if (commentIds.has(commentId)) return `${label}[${index}].comments 存在重复 id: ${commentId}`;
        commentIds.add(commentId);
        if (typeof commentEntry.authorName !== "string" || !commentEntry.authorName.trim()) {
          return `${label}[${index}].comments[${commentIndex}].authorName 缺失`;
        }
        if (typeof commentEntry.text !== "string" || !commentEntry.text.trim()) {
          return `${label}[${index}].comments[${commentIndex}].text 缺失`;
        }
        if (typeof commentEntry.createdAt !== "string" || !commentEntry.createdAt.trim() || !isIsoTimestamp(commentEntry.createdAt)) {
          return `${label}[${index}].comments[${commentIndex}].createdAt 非法`;
        }
        if (
          commentEntry.replyTo !== undefined &&
          (typeof commentEntry.replyTo !== "string" || !commentEntry.replyTo.trim())
        ) {
          return `${label}[${index}].comments[${commentIndex}].replyTo 非法`;
        }
      }
    }
    return null;
  };

  const repliedIssue = inspectTopic(repliedTopics, "repliedTopics");
  if (repliedIssue) return repliedIssue;
  const publishedIssue = inspectTopic(publishedTopics, "publishedTopics");
  if (publishedIssue) return publishedIssue;

  return "结构存在字段缺失、枚举非法或重复 id";
}

function deriveXiaohongshuTone(index: number): CheckPhoneXiaohongshuPayload["homeNotes"][number]["tone"] {
  const tones: CheckPhoneXiaohongshuPayload["homeNotes"][number]["tone"][] = ["ivory", "mist", "blush", "graphite"];
  return tones[index % tones.length] ?? "ivory";
}

function parseSocialComments(fields: Record<string, string>, itemId: string): Array<{ id: string; authorName: string; text: string; replyTo?: string; replyToCommentId?: string }> {
  const commentNumbers = Object.keys(fields)
    .map((key) => key.match(/^评论(\d+)作者$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  const availableNumbers = new Set(commentNumbers);
  return commentNumbers.map((number) => {
    const replyTarget = (fields[`评论${number}回复对象`] || "").trim();
    const replyTargetNumber = Number(replyTarget.match(/^评论\s*(\d+)$/)?.[1] ?? replyTarget.match(/^(\d+)$/)?.[1] ?? NaN);
    const replyToCommentId =
      Number.isFinite(replyTargetNumber) && replyTargetNumber > 0 && replyTargetNumber < number && availableNumbers.has(replyTargetNumber)
        ? `${itemId}_comment_${replyTargetNumber}`
        : undefined;
    return {
      id: `${itemId}_comment_${number}`,
      authorName: fields[`评论${number}作者`] || "",
      text: fields[`评论${number}内容`] || "",
      replyTo: fields[`评论${number}回复`] || undefined,
      replyToCommentId,
    };
  });
}

function parseSocialThreadMessages(
  fields: Record<string, string>,
  threadId: string,
): Array<{ id: string; authorName: string; text: string; timeLabel: string; direction: "incoming" | "outgoing" }> {
  return Object.keys(fields)
    .map((key) => key.match(/^消息(\d+)作者$/)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
    .map((number) => {
      const direction = fields[`消息${number}方向`] === "outgoing" ? "outgoing" : "incoming";
      return {
        id: `${threadId}_message_${number}`,
        authorName: fields[`消息${number}作者`] || "",
        text: fields[`消息${number}正文`] || "",
        timeLabel: fields[`消息${number}时间`] || "",
        direction,
      };
    });
}

function parseXiaohongshuNoteFields(
  fields: Record<string, string>,
  id: string,
  index: number,
): CheckPhoneXiaohongshuPayload["homeNotes"][number] {
  return {
    id,
    authorName: fields["作者"] || "",
    title: fields["标题"] || "",
    body: fields["正文"] || "",
    ...(fields["视频描述"] ? { videoDescription: fields["视频描述"] } : {}),
    coverIcon: fields["图标"] || "",
    tone: deriveXiaohongshuTone(index),
    likeCount: parseXiaohongshuMetric(fields["点赞"]),
    commentCount: parseXiaohongshuMetric(fields["评论数"]),
    saveCount: parseXiaohongshuMetric(fields["收藏"]),
    liked: parseBlockBoolean(fields["已赞"]),
    saved: parseBlockBoolean(fields["已收藏"]),
    tags: parseBlockList(fields["标签"]).slice(0, 4),
    comments: parseSocialComments(fields, id),
  };
}

function parseXiaohongshuThreadType(typeValue?: string, tagLabel?: string): CheckPhoneXiaohongshuPayload["messageThreads"][number]["type"] {
  const raw = (typeValue || "").trim().toLowerCase();
  if (raw === "group" || raw === "群聊" || raw === "群" || raw === "小组" || raw.includes("group")) return "group";
  if (raw === "direct" || raw === "私信" || raw === "单聊" || raw.includes("direct")) return "direct";
  return (tagLabel || "").includes("群") ? "group" : "direct";
}

function parseXiaohongshuBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const firstSection = source.search(/^#\s*\S.*$/m);
  const profileFields = parseTakeoutTaggedFields(firstSection >= 0 ? source.slice(0, firstSection).trim() : source);
  const homeNotes = extractTopLevelTaggedBlocks(source, "首页笔记").map((entry, index) =>
    parseXiaohongshuNoteFields(entry.fields, `home_note_${entry.order}`, index),
  );
  const videoNotes = extractTopLevelTaggedBlocks(source, "视频笔记").map((entry, index) =>
    parseXiaohongshuNoteFields(entry.fields, `video_note_${entry.order}`, index + homeNotes.length),
  );
  const myNotes = extractTopLevelTaggedBlocks(source, "我的笔记").map((entry, index) =>
    parseXiaohongshuNoteFields(entry.fields, `my_note_${entry.order}`, index + homeNotes.length + videoNotes.length),
  );
  const messageThreads = extractTopLevelTaggedBlocks(source, "消息").map((entry) => {
    const type = parseXiaohongshuThreadType(entry.fields["类型"], entry.fields["标签"]);
    const messages = parseSocialThreadMessages(entry.fields, `xhs_thread_${entry.order}`);
    const lastMessage = messages[messages.length - 1];
    return {
      id: `xhs_thread_${entry.order}`,
      name: entry.fields["名称"] || "",
      type,
      unread: lastMessage?.direction === "incoming",
      tagLabel: entry.fields["标签"] || (type === "group" ? "群聊" : "私信"),
      messages,
    };
  });

  if (homeNotes.length + videoNotes.length + myNotes.length + messageThreads.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到小红书块" };
  }

  return {
    parsed: {
      profile: {
        name: profileFields["昵称"] || "",
        bio: profileFields["简介"] || "",
        followingCount: parseXiaohongshuMetric(profileFields["关注"]),
        followerCount: parseXiaohongshuMetric(profileFields["粉丝"]),
        likedAndSavedCount: parseXiaohongshuMetric(profileFields["赞藏"]),
      },
      messageOverview: {
        likesAndSavesCount: parseBlockInteger(profileFields["赞藏通知"]),
        newFollowersCount: parseBlockInteger(profileFields["新增关注"]),
        commentsAndMentionsCount: parseBlockInteger(profileFields["评论提及"]),
      },
      homeNotes,
      videoNotes,
      myNotes,
      messageThreads,
    },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

function normalizeXiaohongshuEngagementCounts(
  likeCount: number,
  commentCount: number,
  saveCount: number,
): { likeCount: number; commentCount: number; saveCount: number } {
  const normalizedCommentCount = Math.max(0, Math.round(commentCount));
  const normalizedLikeCount = Math.max(0, Math.round(likeCount));
  const normalizedSaveCount = Math.max(0, Math.round(saveCount));
  const hasLargeCommentGap =
    normalizedCommentCount > 0 &&
    (
      normalizedLikeCount * 3 < normalizedCommentCount ||
      normalizedSaveCount * 3 < normalizedCommentCount
    );

  if (!hasLargeCommentGap) {
    return {
      likeCount: normalizedLikeCount,
      commentCount: normalizedCommentCount,
      saveCount: normalizedSaveCount,
    };
  }

  const adjustedEngagementCount = normalizedCommentCount * 5;
  return {
    likeCount: adjustedEngagementCount,
    commentCount: normalizedCommentCount,
    saveCount: adjustedEngagementCount,
  };
}

function parseXiaohongshuMetric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number(value);
  const compact = value.replace(/[,，\s]/g, "").trim();
  const match = compact.match(/-?\d+(?:\.\d+)?/);
  if (!match) return Number.NaN;
  const base = Number(match[0]);
  if (!Number.isFinite(base)) return Number.NaN;
  if (/[万wW]/.test(compact)) return Math.round(base * 10000);
  if (/[千kK]/.test(compact)) return Math.round(base * 1000);
  return Math.round(base);
}

function repairXiaohongshuProfileCounts(counts: {
  followingCount: number;
  followerCount: number;
  likedAndSavedCount: number;
}): {
  followingCount: number;
  followerCount: number;
  likedAndSavedCount: number;
} {
  let followingCount = Math.max(0, Math.round(counts.followingCount));
  let followerCount = Math.max(0, Math.round(counts.followerCount));
  let likedAndSavedCount = Math.max(0, Math.round(counts.likedAndSavedCount));
  const minValidCount = 10;

  for (let index = 0; index < 2; index += 1) {
    if (followingCount < minValidCount) {
      followingCount = Math.max(minValidCount, Math.round((followerCount * 0.12 + likedAndSavedCount * 0.006) / 2));
    }
    if (followerCount < minValidCount) {
      followerCount = Math.max(minValidCount, Math.round((followingCount * 8 + likedAndSavedCount / 12) / 2));
    }
    if (likedAndSavedCount < minValidCount) {
      likedAndSavedCount = Math.max(minValidCount, Math.round((followerCount * 18 + followingCount * 40) / 2));
    }
  }

  return { followingCount, followerCount, likedAndSavedCount };
}

function normalizeXiaohongshuPayload(payload: unknown, characterName = ""): CheckPhoneXiaohongshuPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  const normalizeComment = (item: unknown) => {
    if (!item || typeof item !== "object") return null;
    const comment = item as Record<string, unknown>;
    const id = typeof comment.id === "string" && comment.id.trim() ? comment.id.trim() : "";
    const authorName = typeof comment.authorName === "string" ? comment.authorName.trim() : "";
    const text = typeof comment.text === "string" ? comment.text.trim() : "";
    const replyTo = typeof comment.replyTo === "string" && comment.replyTo.trim() ? comment.replyTo.trim() : undefined;
    const replyToCommentId =
      typeof comment.replyToCommentId === "string" && comment.replyToCommentId.trim() ? comment.replyToCommentId.trim() : undefined;
    if (!id || !authorName || !text) return null;
    return { id, authorName, text, replyTo, replyToCommentId };
  };

  const normalizeNote = (item: unknown) => {
    if (!item || typeof item !== "object") return null;
    const note = item as Record<string, unknown>;
    const id = typeof note.id === "string" && note.id.trim() ? note.id.trim() : "";
    const authorName = typeof note.authorName === "string" ? note.authorName.trim() : "";
    const title = typeof note.title === "string" ? note.title.trim() : "";
    const body = typeof note.body === "string" ? note.body.trim() : "";
    const videoDescription =
      typeof note.videoDescription === "string" ? note.videoDescription.trim() : "";
    const coverIcon = typeof note.coverIcon === "string" ? note.coverIcon.trim() : "";
    const tone = note.tone;
    const normalizedTone =
      tone === "ivory" || tone === "mist" || tone === "blush" || tone === "graphite"
        ? tone
        : "ivory";
    const likeCount = typeof note.likeCount === "number" ? note.likeCount : Number(note.likeCount);
    const commentCount = typeof note.commentCount === "number" ? note.commentCount : Number(note.commentCount);
    const saveCount = typeof note.saveCount === "number" ? note.saveCount : Number(note.saveCount);
    const tags = (Array.isArray(note.tags) ? note.tags : [])
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .slice(0, 4);
    const comments = (Array.isArray(note.comments) ? note.comments : [])
      .map((entry) => normalizeComment(entry))
      .filter(Boolean) as CheckPhoneXiaohongshuPayload["homeNotes"][number]["comments"];
    if (
      !id ||
      !authorName ||
      !title ||
      !body ||
      !coverIcon ||
      !Number.isFinite(likeCount) ||
      !Number.isFinite(commentCount) ||
      !Number.isFinite(saveCount) ||
      tags.length === 0
    ) {
      return null;
    }
    const engagementCounts = normalizeXiaohongshuEngagementCounts(likeCount, commentCount, saveCount);
    return {
      id,
      authorName,
      title,
      body,
      ...(videoDescription ? { videoDescription } : {}),
      coverIcon,
      tone: normalizedTone,
      likeCount: engagementCounts.likeCount,
      commentCount: engagementCounts.commentCount,
      saveCount: engagementCounts.saveCount,
      liked: note.liked === true,
      saved: note.saved === true,
      tags,
      comments: comments.slice(0, 10),
    };
  };

  const normalizeThreadMessage = (item: unknown) => {
    if (!item || typeof item !== "object") return null;
    const message = item as Record<string, unknown>;
    const id = typeof message.id === "string" && message.id.trim() ? message.id.trim() : "";
    const authorName = typeof message.authorName === "string" ? message.authorName.trim() : "";
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const timeLabel = typeof message.timeLabel === "string" ? message.timeLabel.trim() : "";
    const direction =
      message.direction === "incoming" || message.direction === "outgoing"
        ? message.direction
        : null;
    if (!id || !authorName || !text || !timeLabel || !direction) return null;
    return { id, authorName, text, timeLabel, direction };
  };

  const normalizeThread = (item: unknown) => {
    if (!item || typeof item !== "object") return null;
    const thread = item as Record<string, unknown>;
    const id = typeof thread.id === "string" && thread.id.trim() ? thread.id.trim() : "";
    const name = typeof thread.name === "string" ? thread.name.trim() : "";
    const type = parseXiaohongshuThreadType(
      typeof thread.type === "string" ? thread.type : undefined,
      typeof thread.tagLabel === "string" ? thread.tagLabel : undefined,
    );
    const tagLabel = typeof thread.tagLabel === "string" && thread.tagLabel.trim() ? thread.tagLabel.trim() : (type === "group" ? "群聊" : "私信");
    const messages = (Array.isArray(thread.messages) ? thread.messages : [])
      .map((entry) => normalizeThreadMessage(entry))
      .filter(Boolean) as CheckPhoneXiaohongshuPayload["messageThreads"][number]["messages"];
    if (!id || !name || !tagLabel || messages.length === 0) return null;
    const unread = messages[messages.length - 1]?.direction === "incoming";
    return { id, name, type, unread, tagLabel, messages: messages.slice(0, 10) };
  };

  const profileRaw = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
  const profileName = typeof profileRaw?.name === "string" ? profileRaw.name.trim() : "";
  const handle = typeof profileRaw?.handle === "string" ? profileRaw.handle.trim() : "";
  const bio = typeof profileRaw?.bio === "string" ? profileRaw.bio.trim() : "";
  const followingCount = profileRaw ? parseXiaohongshuMetric(profileRaw.followingCount) : NaN;
  const followerCount = profileRaw ? parseXiaohongshuMetric(profileRaw.followerCount) : NaN;
  const likedAndSavedCount =
    profileRaw ? parseXiaohongshuMetric(profileRaw.likedAndSavedCount) : NaN;
  if (
    !profileName ||
    !bio ||
    !Number.isFinite(followingCount) ||
    !Number.isFinite(followerCount) ||
    !Number.isFinite(likedAndSavedCount)
  ) {
    return null;
  }

  const homeNotes = (Array.isArray(record.homeNotes) ? record.homeNotes : Array.isArray(record.discoverNotes) ? record.discoverNotes : [])
    .map((entry) => normalizeNote(entry))
    .filter(Boolean) as CheckPhoneXiaohongshuPayload["homeNotes"];
  const videoNotes = (Array.isArray(record.videoNotes) ? record.videoNotes : Array.isArray(record.videos) ? record.videos : [])
    .map((entry) => normalizeNote(entry))
    .filter(Boolean) as CheckPhoneXiaohongshuPayload["videoNotes"];
  const myNotes = (Array.isArray(record.myNotes) ? record.myNotes : Array.isArray(record.notes) ? record.notes : [])
    .map((entry) => normalizeNote(entry))
    .filter(Boolean) as CheckPhoneXiaohongshuPayload["myNotes"];
  const messageThreads = (Array.isArray(record.messageThreads) ? record.messageThreads : Array.isArray(record.threads) ? record.threads : [])
    .map((entry) => normalizeThread(entry))
    .filter(Boolean) as CheckPhoneXiaohongshuPayload["messageThreads"];

  const overviewRaw = record.messageOverview && typeof record.messageOverview === "object"
    ? record.messageOverview as Record<string, unknown>
    : record.messageStats && typeof record.messageStats === "object"
      ? record.messageStats as Record<string, unknown>
      : null;
  const likesAndSavesCount = overviewRaw
    ? (typeof overviewRaw.likesAndSavesCount === "number" ? overviewRaw.likesAndSavesCount : Number(overviewRaw.likesAndSavesCount))
    : NaN;
  const newFollowersCount = overviewRaw
    ? (typeof overviewRaw.newFollowersCount === "number" ? overviewRaw.newFollowersCount : Number(overviewRaw.newFollowersCount))
    : NaN;
  const commentsAndMentionsCount = overviewRaw
    ? (typeof overviewRaw.commentsAndMentionsCount === "number" ? overviewRaw.commentsAndMentionsCount : Number(overviewRaw.commentsAndMentionsCount))
    : NaN;

  const dedupeById = <Item extends { id: string }>(items: Item[]): Item[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  };
  const uniqueHomeNotes = dedupeById(homeNotes);
  const uniqueVideoNotes = dedupeById(videoNotes);
  const uniqueMyNotes = dedupeById(myNotes);
  const uniqueMessageThreads = dedupeById(messageThreads);
  const profileCounts = repairXiaohongshuProfileCounts({ followingCount, followerCount, likedAndSavedCount });
  const replaceCharacterName = (name: string) => {
    const trimmed = name.trim();
    return characterName.trim() && trimmed === characterName.trim() ? profileName : name;
  };
  const replaceNoteAuthors = (notes: CheckPhoneXiaohongshuPayload["homeNotes"]): CheckPhoneXiaohongshuPayload["homeNotes"] =>
    notes.map((note) => ({
      ...note,
      authorName: replaceCharacterName(note.authorName),
      comments: note.comments.map((comment) => ({
        ...comment,
        authorName: replaceCharacterName(comment.authorName),
      })),
    }));
  const replaceThreadAuthors = (threads: CheckPhoneXiaohongshuPayload["messageThreads"]): CheckPhoneXiaohongshuPayload["messageThreads"] =>
    threads.map((thread) => ({
      ...thread,
      name: replaceCharacterName(thread.name),
      messages: thread.messages.map((message) => ({
        ...message,
        authorName: replaceCharacterName(message.authorName),
      })),
    }));

  return {
    headerTitle: "小红书",
    headerSubtitle: "发现今日灵感",
    profile: {
      name: profileName,
      ...(handle ? { handle } : {}),
      bio,
      followingCount: profileCounts.followingCount,
      followerCount: profileCounts.followerCount,
      likedAndSavedCount: profileCounts.likedAndSavedCount,
    },
    homeNotes: replaceNoteAuthors(uniqueHomeNotes.slice(0, 14)),
    videoNotes: replaceNoteAuthors(uniqueVideoNotes.slice(0, 12)),
    myNotes: replaceNoteAuthors(uniqueMyNotes.slice(0, 12)),
    messageOverview: {
      likesAndSavesCount: Number.isFinite(likesAndSavesCount) ? Math.max(0, Math.round(likesAndSavesCount)) : 0,
      newFollowersCount: Number.isFinite(newFollowersCount) ? Math.max(0, Math.round(newFollowersCount)) : 0,
      commentsAndMentionsCount: Number.isFinite(commentsAndMentionsCount) ? Math.max(0, Math.round(commentsAndMentionsCount)) : 0,
    },
    messageThreads: replaceThreadAuthors(uniqueMessageThreads.slice(0, 8)),
  };
}

function deriveWeiboTone(index: number): CheckPhoneWeiboPayload["homePosts"][number]["tone"] {
  const tones: CheckPhoneWeiboPayload["homePosts"][number]["tone"][] = ["ivory", "mist", "graphite", "blush"];
  return tones[index % tones.length] ?? "ivory";
}

function parseWeiboPostFields(
  fields: Record<string, string>,
  id: string,
  index: number,
): CheckPhoneWeiboPayload["homePosts"][number] {
  return {
    id,
    authorName: fields["作者"] || "",
    authorBadge: fields["身份"] || "",
    body: fields["正文"] || "",
    mediaIcon: fields["图标"] || "",
    tone: deriveWeiboTone(index),
    repostCount: parseBlockInteger(fields["转发"]),
    commentCount: parseBlockInteger(fields["评论数"]),
    likeCount: parseBlockInteger(fields["点赞"]),
    comments: parseSocialComments(fields, id),
  };
}

function parseWeiboBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const firstSection = source.search(/^#\s*\S.*$/m);
  const profileFields = parseTakeoutTaggedFields(firstSection >= 0 ? source.slice(0, firstSection).trim() : source);
  const homePosts = extractTopLevelTaggedBlocks(source, "首页微博").map((entry, index) =>
    parseWeiboPostFields(entry.fields, `home_post_${entry.order}`, index),
  );
  const trendingTopics = extractTopLevelTaggedBlocks(source, "热搜").map((entry) => ({
    id: `trend_${entry.order}`,
    title: entry.fields["标题"] || "",
    heatLabel: entry.fields["热度"] || "",
    summary: entry.fields["摘要"] || "",
    relatedPostIds: [],
  }));
  const messageThreads = extractTopLevelTaggedBlocks(source, "消息").map((entry) => {
    const type = entry.fields["类型"] === "group" ? "group" : "direct";
    return {
      id: `weibo_thread_${entry.order}`,
      name: entry.fields["名称"] || "",
      type,
      unread: parseBlockBoolean(entry.fields["未读"]),
      tagLabel: entry.fields["标签"] || (type === "group" ? "群聊" : "私信"),
      messages: parseSocialThreadMessages(entry.fields, `weibo_thread_${entry.order}`),
    };
  });
  const myPosts = extractTopLevelTaggedBlocks(source, "我的微博").map((entry, index) =>
    parseWeiboPostFields(entry.fields, `my_post_${entry.order}`, index + homePosts.length),
  );

  if (homePosts.length + trendingTopics.length + messageThreads.length + myPosts.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到微博块" };
  }

  const mentionsCount = parseBlockInteger(profileFields["提及通知"]);
  const commentsCount = parseBlockInteger(profileFields["评论通知"]);
  const likesCount = parseBlockInteger(profileFields["点赞通知"]);

  return {
    parsed: {
      profile: {
        name: profileFields["昵称"] || "",
        handle: profileFields["账号"] || "",
        bio: profileFields["简介"] || "",
        followingCount: parseBlockInteger(profileFields["关注"]),
        followerCount: parseBlockInteger(profileFields["粉丝"]),
        likedTotal: parseBlockInteger(profileFields["获赞"]),
      },
      messageOverview: {
        mentionsCount: Number.isFinite(mentionsCount) ? mentionsCount : 0,
        commentsCount: Number.isFinite(commentsCount) ? commentsCount : 0,
        likesCount: Number.isFinite(likesCount) ? likesCount : 0,
      },
      homePosts,
      trendingTopics,
      messageThreads,
      myPosts,
    },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

function normalizeWeiboPayload(payload: unknown, characterName?: string): CheckPhoneWeiboPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const characterDisplayName = characterName?.trim() ?? "";
  let weiboProfileName = "";
  const normalizeWeiboName = (value: string): string => {
    const trimmed = value.trim();
    return characterDisplayName && weiboProfileName && trimmed === characterDisplayName ? weiboProfileName : trimmed;
  };

  const normalizeComment = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const authorName = typeof item.authorName === "string" ? normalizeWeiboName(item.authorName) : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const replyTo = typeof item.replyTo === "string" && item.replyTo.trim() ? normalizeWeiboName(item.replyTo) : undefined;
    const replyToCommentId =
      typeof item.replyToCommentId === "string" && item.replyToCommentId.trim() ? item.replyToCommentId.trim() : undefined;
    if (!id || !authorName || !text) return null;
    return { id, authorName, text, replyTo, replyToCommentId };
  };

  const normalizePost = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const authorName = typeof item.authorName === "string" ? normalizeWeiboName(item.authorName) : "";
    const authorBadge = typeof item.authorBadge === "string" ? item.authorBadge.trim() : "";
    const body = typeof item.body === "string" ? item.body.trim() : "";
    const mediaIcon = typeof item.mediaIcon === "string" ? item.mediaIcon.trim() : "";
    const tone =
      item.tone === "ivory" || item.tone === "mist" || item.tone === "graphite" || item.tone === "blush"
        ? item.tone
        : "ivory";
    const repostCount = typeof item.repostCount === "number" ? item.repostCount : Number(item.repostCount);
    const commentCount = typeof item.commentCount === "number" ? item.commentCount : Number(item.commentCount);
    const likeCount = typeof item.likeCount === "number" ? item.likeCount : Number(item.likeCount);
    const comments = (Array.isArray(item.comments) ? item.comments : [])
      .map((comment) => normalizeComment(comment))
      .filter(Boolean) as CheckPhoneWeiboPayload["homePosts"][number]["comments"];
    if (
      !id ||
      !authorName ||
      !authorBadge ||
      !body ||
      !mediaIcon ||
      !Number.isFinite(repostCount) ||
      !Number.isFinite(commentCount) ||
      !Number.isFinite(likeCount)
    ) {
      return null;
    }
    return {
      id,
      authorName,
      authorBadge,
      body,
      mediaIcon,
      tone,
      repostCount: Math.max(0, Math.round(repostCount)),
      commentCount: Math.max(0, Math.round(commentCount)),
      likeCount: Math.max(0, Math.round(likeCount)),
      comments: comments.slice(0, 8),
    };
  };

  const normalizeTopic = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const heatLabel = typeof item.heatLabel === "string" ? item.heatLabel.trim() : "";
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    const relatedPostIds = (Array.isArray(item.relatedPostIds) ? item.relatedPostIds : [])
      .map((value) => String(value).trim())
      .filter(Boolean)
      .slice(0, 6);
    if (!id || !title || !heatLabel || !summary) return null;
    return {
      id,
      title,
      heatLabel,
      summary,
      relatedPostIds,
    };
  };

  const normalizeThreadMessage = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const authorName = typeof item.authorName === "string" ? normalizeWeiboName(item.authorName) : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const timeLabel = typeof item.timeLabel === "string" ? item.timeLabel.trim() : "";
    const direction = item.direction === "incoming" || item.direction === "outgoing" ? item.direction : null;
    if (!id || !authorName || !text || !timeLabel || !direction) return null;
    return { id, authorName, text, timeLabel, direction };
  };

  const normalizeThread = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof item.name === "string" ? normalizeWeiboName(item.name) : "";
    const type = item.type === "direct" || item.type === "group" ? item.type : null;
    const tagLabel = typeof item.tagLabel === "string" && item.tagLabel.trim() ? item.tagLabel.trim() : type === "group" ? "群聊" : "私信";
    const messages = (Array.isArray(item.messages) ? item.messages : [])
      .map((message) => normalizeThreadMessage(message))
      .filter(Boolean) as CheckPhoneWeiboPayload["messageThreads"][number]["messages"];
    if (!id || !name || !type || messages.length < 1) return null;
    return {
      id,
      name,
      type,
      unread: item.unread === true,
      tagLabel,
      messages: messages.slice(0, 10),
    };
  };

  const profileRaw = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
  if (!profileRaw) return null;
  const name = typeof profileRaw.name === "string" ? profileRaw.name.trim() : "";
  const handle = typeof profileRaw.handle === "string" ? profileRaw.handle.trim() : "";
  const bio = typeof profileRaw.bio === "string" ? profileRaw.bio.trim() : "";
  const followingCount = typeof profileRaw.followingCount === "number" ? profileRaw.followingCount : Number(profileRaw.followingCount);
  const followerCount = typeof profileRaw.followerCount === "number" ? profileRaw.followerCount : Number(profileRaw.followerCount);
  const likedTotal = typeof profileRaw.likedTotal === "number" ? profileRaw.likedTotal : Number(profileRaw.likedTotal);
  if (!name || !handle || !bio || !Number.isFinite(followingCount) || !Number.isFinite(followerCount) || !Number.isFinite(likedTotal)) return null;
  weiboProfileName = name;

  const homePosts = (Array.isArray(record.homePosts) ? record.homePosts : Array.isArray(record.feedPosts) ? record.feedPosts : [])
    .map((post) => normalizePost(post))
    .filter(Boolean) as CheckPhoneWeiboPayload["homePosts"];
  const myPosts = (Array.isArray(record.myPosts) ? record.myPosts : Array.isArray(record.profilePosts) ? record.profilePosts : [])
    .map((post) => normalizePost(post))
    .filter(Boolean) as CheckPhoneWeiboPayload["myPosts"];
  const trendingTopics = (Array.isArray(record.trendingTopics) ? record.trendingTopics : Array.isArray(record.hotTopics) ? record.hotTopics : [])
    .map((topic) => normalizeTopic(topic))
    .filter(Boolean) as CheckPhoneWeiboPayload["trendingTopics"];
  const messageThreads = (Array.isArray(record.messageThreads) ? record.messageThreads : Array.isArray(record.threads) ? record.threads : [])
    .map((thread) => normalizeThread(thread))
    .filter(Boolean) as CheckPhoneWeiboPayload["messageThreads"];

  const overviewRaw = record.messageOverview && typeof record.messageOverview === "object"
    ? record.messageOverview as Record<string, unknown>
    : null;
  const mentionsCount = overviewRaw
    ? (typeof overviewRaw.mentionsCount === "number" ? overviewRaw.mentionsCount : Number(overviewRaw.mentionsCount))
    : NaN;
  const commentsCount = overviewRaw
    ? (typeof overviewRaw.commentsCount === "number" ? overviewRaw.commentsCount : Number(overviewRaw.commentsCount))
    : NaN;
  const likesCount = overviewRaw
    ? (typeof overviewRaw.likesCount === "number" ? overviewRaw.likesCount : Number(overviewRaw.likesCount))
    : NaN;

  const dedupeIds = (items: Array<{ id: string }>) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
    }
    return true;
  };

  if (
    !dedupeIds(homePosts) ||
    !dedupeIds(myPosts) ||
    !dedupeIds(trendingTopics) ||
    !dedupeIds(messageThreads)
  ) {
    return null;
  }

  const normalizedTrendingTopics = trendingTopics
    .slice(0, 12)
    .map((topic, index) => ({
      ...topic,
      rank: index + 1,
    }));

  return {
    headerTitle: "微博",
    headerSubtitle: "今天也在刷新的话题",
    profile: {
      name,
      handle,
      bio,
      followingCount: Math.max(0, Math.round(followingCount)),
      followerCount: Math.max(0, Math.round(followerCount)),
      likedTotal: Math.max(0, Math.round(likedTotal)),
    },
    homePosts: homePosts.slice(0, 14),
    trendingTopics: normalizedTrendingTopics,
    messageOverview: {
      mentionsCount: Number.isFinite(mentionsCount) ? Math.max(0, Math.round(mentionsCount)) : 0,
      commentsCount: Number.isFinite(commentsCount) ? Math.max(0, Math.round(commentsCount)) : 0,
      likesCount: Number.isFinite(likesCount) ? Math.max(0, Math.round(likesCount)) : 0,
    },
    messageThreads: messageThreads.slice(0, 8),
    myPosts: myPosts.slice(0, 10),
  };
}

function deriveReadingTone(seed: string): CheckPhoneReadingPayload["currentBooks"][number]["tone"] {
  const tones: CheckPhoneReadingPayload["currentBooks"][number]["tone"][] = ["linen", "mist", "graphite"];
  const hash = Array.from(seed).reduce((total, char) => total + char.charCodeAt(0), 0);
  return tones[hash % tones.length] ?? "linen";
}

function parseReadingBookFields(
  fields: Record<string, string>,
  id: string,
  index: number,
): CheckPhoneReadingPayload["currentBooks"][number] {
  const title = fields["书名"] || "";
  const author = fields["作者"] || "";
  return {
    id,
    title,
    author,
    coverIcon: fields["图标"] || "",
    tone: deriveReadingTone(`${id}:${title}:${author}:${index}`),
    status: fields["状态"] as CheckPhoneReadingPayload["currentBooks"][number]["status"],
    progressLabel: fields["进度"] || "",
    summary: fields["简介"] || "",
    tags: parseBlockList(fields["标签"]).slice(0, 4),
  };
}

function parseReadingBlockPayload(text: string): PhoneBlockParseResult {
  const source = stripJsonWrapperNoise(text).replace(/\r/g, "").trim();
  if (!source) return { parsed: null, sanitizedCandidate: "", parseMode: "failed", parseError: "LLM 返回为空" };

  const firstSection = source.search(/^#\s*\S.*$/m);
  const profileFields = parseTakeoutTaggedFields(firstSection >= 0 ? source.slice(0, firstSection).trim() : source);
  const currentBooks = extractTopLevelTaggedBlocks(source, "在读").map((entry, index) =>
    parseReadingBookFields(entry.fields, `current_book_${entry.order}`, index),
  );
  const libraryBooks = extractTopLevelTaggedBlocks(source, "书架").map((entry, index) =>
    parseReadingBookFields(entry.fields, `library_book_${entry.order}`, index + currentBooks.length),
  );

  const bookTitleToId = new Map<string, string>();
  for (const book of [...currentBooks, ...libraryBooks]) {
    if (book.title && !bookTitleToId.has(book.title)) bookTitleToId.set(book.title, book.id);
  }

  const highlights = extractTopLevelTaggedBlocks(source, "书摘").map((entry) => ({
    id: `highlight_${entry.order}`,
    bookId: bookTitleToId.get(entry.fields["书名"] || "") || "",
    quote: entry.fields["摘录"] || "",
    chapterLabel: entry.fields["章节"] || "",
    note: entry.fields["注记"] || "",
  }));
  const notes = extractTopLevelTaggedBlocks(source, "笔记").map((entry) => ({
    id: `reading_note_${entry.order}`,
    bookId: bookTitleToId.get(entry.fields["书名"] || "") || "",
    title: entry.fields["标题"] || "",
    body: entry.fields["正文"] || "",
    updatedLabel: entry.fields["时间"] || "",
  }));

  if (currentBooks.length + libraryBooks.length + highlights.length + notes.length === 0) {
    return { parsed: null, sanitizedCandidate: source, parseMode: "failed", parseError: "未找到阅读块" };
  }

  return {
    parsed: {
      profile: {
        status: profileFields["阅读状态"] || "最近的阅读痕迹",
        updatedLabel: profileFields["落款时间"] || profileFields["时间"] || "",
      },
      currentBooks,
      libraryBooks,
      highlights,
      notes,
    },
    sanitizedCandidate: source,
    parseMode: "sanitized",
  };
}

function normalizeReadingPayload(payload: unknown): CheckPhoneReadingPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  const profileRaw = record.profile && typeof record.profile === "object" ? record.profile as Record<string, unknown> : null;
  const profileStatus =
    typeof profileRaw?.status === "string" && profileRaw.status.trim()
      ? profileRaw.status.trim()
      : typeof profileRaw?.summary === "string" && profileRaw.summary.trim()
        ? profileRaw.summary.trim()
        : "最近的阅读痕迹";
  const profileUpdatedLabel =
    typeof profileRaw?.updatedLabel === "string" && profileRaw.updatedLabel.trim()
      ? profileRaw.updatedLabel.trim()
      : "";

  const normalizeBook = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const author = typeof item.author === "string" ? item.author.trim() : "";
    const coverIcon = typeof item.coverIcon === "string" ? item.coverIcon.trim() : "";
    const tone = typeof item.tone === "string" && ["linen", "mist", "graphite"].includes(item.tone) ? item.tone as "linen" | "mist" | "graphite" : null;
    const status = typeof item.status === "string" && ["reading", "finished", "wishlist", "paused"].includes(item.status) ? item.status as "reading" | "finished" | "wishlist" | "paused" : null;
    const progressLabel = typeof item.progressLabel === "string" ? item.progressLabel.trim() : "";
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 4) : [];
    if (!id || !title || !author || !coverIcon || !tone || !status || !progressLabel || !summary || tags.length === 0) return null;
    return { id, title, author, coverIcon, tone, status, progressLabel, summary, tags };
  };

  const normalizeHighlight = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const bookId = typeof item.bookId === "string" ? item.bookId.trim() : "";
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    const chapterLabel = typeof item.chapterLabel === "string" ? item.chapterLabel.trim() : "";
    const note = typeof item.note === "string" ? item.note.trim() : "";
    if (!id || !bookId || !quote || !chapterLabel || !note) return null;
    return { id, bookId, quote, chapterLabel, note };
  };

  const normalizeNote = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const bookId = typeof item.bookId === "string" ? item.bookId.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const body = typeof item.body === "string" ? item.body.trim() : "";
    const updatedLabel = typeof item.updatedLabel === "string" ? item.updatedLabel.trim() : "";
    if (!id || !bookId || !title || !body || !updatedLabel) return null;
    return { id, bookId, title, body, updatedLabel };
  };

  const currentBooks = (Array.isArray(record.currentBooks) ? record.currentBooks : Array.isArray(record.readingNow) ? record.readingNow : [])
    .map(normalizeBook)
    .filter(Boolean) as CheckPhoneReadingPayload["currentBooks"];
  const libraryBooks = (Array.isArray(record.libraryBooks) ? record.libraryBooks : Array.isArray(record.bookshelf) ? record.bookshelf : Array.isArray(record.shelfBooks) ? record.shelfBooks : [])
    .map(normalizeBook)
    .filter(Boolean) as CheckPhoneReadingPayload["libraryBooks"];
  const highlights = (Array.isArray(record.highlights) ? record.highlights : Array.isArray(record.quotes) ? record.quotes : [])
    .map(normalizeHighlight)
    .filter(Boolean) as CheckPhoneReadingPayload["highlights"];
  const notes = (Array.isArray(record.notes) ? record.notes : Array.isArray(record.readingNotes) ? record.readingNotes : [])
    .map(normalizeNote)
    .filter(Boolean) as CheckPhoneReadingPayload["notes"];

  const dedupeIds = (items: Array<{ id: string }>) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
    }
    return true;
  };

  const validBookIds = new Set([...currentBooks, ...libraryBooks].map((book) => book.id));
  const linkedHighlights = highlights.filter((item) => validBookIds.has(item.bookId));
  const linkedNotes = notes.filter((item) => validBookIds.has(item.bookId));

  if (
    !dedupeIds(currentBooks) ||
    !dedupeIds(libraryBooks) ||
    !dedupeIds(linkedHighlights) ||
    !dedupeIds(linkedNotes)
  ) {
    return null;
  }

  return {
    headerTitle: "阅读",
    headerSubtitle: "慢一点，读进去",
    profile: {
      status: profileStatus,
      updatedLabel: profileUpdatedLabel,
    },
    currentBooks: currentBooks.slice(0, 4),
    highlights: linkedHighlights.slice(0, 14),
    libraryBooks: libraryBooks.slice(0, 16),
    notes: linkedNotes.slice(0, 10),
  };
}

export async function generateCheckPhoneXiaohongshu(
  characterId: string,
  previousPayload?: CheckPhoneXiaohongshuPayload | null,
  previousUpdatedAt?: string,
): Promise<{
  payload: CheckPhoneXiaohongshuPayload | null;
  summary: string;
  error?: string;
  debugRawOutput?: string;
  debugParseMode?: "sanitized" | "failed";
  debugParseError?: string;
  debugNormalizeError?: string;
}> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "xiaohongshu", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const characterName = loadCharacters().find((item) => item.id === characterId)?.name;
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName },
      { skipOutputRegex: true, appId: "checkphone_xiaohongshu" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, parseMode, parseError } = parseXiaohongshuBlockPayload(rawOutput);
    const normalized = normalizeXiaohongshuPayload(parsed, characterName);
    if (!normalized) {
      return {
        payload: null,
        summary: "",
        error: "无法解析小红书内容",
        debugRawOutput: rawOutput,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError: parsed ? "结构存在字段缺失或格式非法" : undefined,
      };
    }
    return {
      payload: normalized,
      summary: formatSnapshotSummary(normalized),
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

export async function generateCheckPhoneWeibo(
  characterId: string,
  previousPayload?: CheckPhoneWeiboPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneWeiboPayload | null; summary: string; error?: string; debugRawOutput?: string; debugParseMode?: "raw" | "sanitized" | "failed"; debugParseError?: string; debugNormalizeError?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "", debugParseMode: "failed" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "weibo", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_weibo" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, parseMode, parseError } = parseWeiboBlockPayload(rawOutput);
    const characterName = loadCharacters().find((item) => item.id === characterId)?.name;
    const normalized = normalizeWeiboPayload(parsed, characterName);
    if (!normalized) {
      const debugNormalizeError = parsed ? diagnoseWeiboNormalizeFailure(parsed) : undefined;
      return {
        payload: null,
        summary: "",
        error: "无法解析微博内容",
        debugRawOutput: rawOutput,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
        debugNormalizeError,
      };
    }
    return {
      payload: normalized,
      summary: formatSnapshotSummary(normalized),
      debugParseMode: parseMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}

function diagnoseWeiboNormalizeFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "顶层不是对象";
  const record = payload as Record<string, unknown>;

  const profileRaw = record.profile && typeof record.profile === "object" ? (record.profile as Record<string, unknown>) : null;
  if (!profileRaw) return "缺少 profile 对象";
  if (typeof profileRaw.name !== "string" || !profileRaw.name.trim()) return "profile.name 缺失";
  if (typeof profileRaw.handle !== "string" || !profileRaw.handle.trim()) return "profile.handle 缺失";
  if (typeof profileRaw.bio !== "string" || !profileRaw.bio.trim()) return "profile.bio 缺失";
  if (!Number.isFinite(typeof profileRaw.followingCount === "number" ? profileRaw.followingCount : Number(profileRaw.followingCount))) {
    return "profile.followingCount 非法";
  }
  if (!Number.isFinite(typeof profileRaw.followerCount === "number" ? profileRaw.followerCount : Number(profileRaw.followerCount))) {
    return "profile.followerCount 非法";
  }
  if (!Number.isFinite(typeof profileRaw.likedTotal === "number" ? profileRaw.likedTotal : Number(profileRaw.likedTotal))) {
    return "profile.likedTotal 非法";
  }

  const homePosts = Array.isArray(record.homePosts) ? record.homePosts : Array.isArray(record.feedPosts) ? record.feedPosts : [];
  const myPosts = Array.isArray(record.myPosts) ? record.myPosts : Array.isArray(record.profilePosts) ? record.profilePosts : [];
  const trendingTopics = Array.isArray(record.trendingTopics) ? record.trendingTopics : Array.isArray(record.hotTopics) ? record.hotTopics : [];
  const messageThreads = Array.isArray(record.messageThreads) ? record.messageThreads : Array.isArray(record.threads) ? record.threads : [];

  const overviewRaw = record.messageOverview && typeof record.messageOverview === "object" ? (record.messageOverview as Record<string, unknown>) : null;
  if (!overviewRaw) return "缺少 messageOverview";
  if (!Number.isFinite(typeof overviewRaw.mentionsCount === "number" ? overviewRaw.mentionsCount : Number(overviewRaw.mentionsCount))) {
    return "messageOverview.mentionsCount 非法";
  }
  if (!Number.isFinite(typeof overviewRaw.commentsCount === "number" ? overviewRaw.commentsCount : Number(overviewRaw.commentsCount))) {
    return "messageOverview.commentsCount 非法";
  }
  if (!Number.isFinite(typeof overviewRaw.likesCount === "number" ? overviewRaw.likesCount : Number(overviewRaw.likesCount))) {
    return "messageOverview.likesCount 非法";
  }

  return "结构存在字段缺失、枚举非法或重复 id";
}

export async function generateCheckPhoneReading(
  characterId: string,
  previousPayload?: CheckPhoneReadingPayload | null,
  previousUpdatedAt?: string,
): Promise<{ payload: CheckPhoneReadingPayload | null; summary: string; error?: string; debugRawOutput?: string; debugSanitizedOutput?: string; debugParseMode?: "raw" | "sanitized" | "failed"; debugParseError?: string }> {
  const { apiConfig, preset, worldBooks, regexes } = resolveCheckPhoneConfigs(characterId);
  if (!apiConfig) return { payload: null, summary: "", error: "未找到可用的 API 配置", debugRawOutput: "" };

  try {
    const messages = await buildCheckPhoneAppMessages(characterId, "reading", preset, worldBooks, regexes, {
      snapshotSummary: previousPayload ? formatSnapshotSummary(previousPayload) : "",
      lastRefreshAt: previousUpdatedAt ?? "",
    });
    const rawOutput = await sendLLMRequest(
      apiConfig,
      preset,
      messages,
      regexes,
      { characterName: loadCharacters().find((item) => item.id === characterId)?.name },
      { skipOutputRegex: true, appId: "checkphone_reading" },
    );

    if (!rawOutput?.trim()) return { payload: null, summary: "", error: "LLM 返回为空", debugRawOutput: rawOutput ?? "", debugParseMode: "failed" };
    const { parsed, sanitizedCandidate, parseMode, parseError } = parseReadingBlockPayload(rawOutput);
    const normalized = normalizeReadingPayload(parsed);
    if (!normalized) {
      return {
        payload: null,
        summary: "",
        error: "无法解析阅读内容",
        debugRawOutput: rawOutput ?? "",
        debugSanitizedOutput: parseMode === "failed" ? sanitizedCandidate : undefined,
        debugParseMode: parseMode,
        debugParseError: parseError || undefined,
      };
    }
    return {
      payload: normalized,
      summary: formatSnapshotSummary(normalized),
      debugSanitizedOutput: parseMode === "sanitized" ? sanitizedCandidate : undefined,
      debugParseMode: parseMode,
      debugParseError: parseError || undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败";
    return { payload: null, summary: "", error: message, debugRawOutput: "", debugParseMode: "failed", debugParseError: message };
  }
}
