import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequest, ChatEngineError } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { parseStoryResponse } from "./story-parser";
import { STORY_PARSER_VERSION } from "./story-parser";
import { loadStoryMessages, replaceStoryMessages, type StoryMessage } from "./story-storage";
import type { ChatMessage } from "./chat-storage";
import { MacroEngine } from "./macro-engine";

const DEFAULT_STORY_FOLD_TAGS = "think,thinking,summary";
const DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS = "think,thinking";

export type StoryGenerationResult = {
  rawText: string;
  renderedText: string;
  storySummary: string;
  regexSignature: string;
  parserVersion: number;
  promptMessages: LLMMessage[];
  model: string;
  presetName: string;
};

export type StoryPreviewResult = {
  messages: LLMMessage[];
  characterName: string;
  model: string;
  presetName: string;
};

function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripContextExcludedTags(text: string, excludedTags?: string): string {
  const tags = Array.from(new Set((excludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS).split(",").map(t => t.trim()).filter(Boolean)));
  if (tags.length === 0) return text;

  const tagAlternation = tags.map(escapeTagName).join("|");
  const rx = new RegExp(`<(${tagAlternation})>[\\s\\S]*?<\\/\\1>`, "gi");
  return text.replace(rx, "").replace(/\n{3,}/g, "\n\n").trim();
}

function toHistoryMessage(message: StoryMessage, contextExcludedTags?: string): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: stripContextExcludedTags(message.rawContent, contextExcludedTags),
    status: "sent",
    createdAt: message.createdAt,
  };
}

function resolveStoryConfigs(characterId: string): {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
  regexSignature: string;
  summaryTag: string;
} {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, "story");
  if (!activeSlot.apiConfigId) {
    throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> 绑定管理 -> 剧情 to assign one.`);
  }

  const apiConfig = loadApiConfigs().find((config) => config.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new ChatEngineError(`API Configuration not found for ${character.name}.`);
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find((item) => item.id === activeSlot.presetId) || null : null;
  if (!preset) {
    preset = presets.find((item) => item.builtIn) ?? null;
  }

  const allRegexes = loadRegexes();
  const charBinding = bindings.characterBindings.find((item) => item.characterId === characterId);
  const storyOverrideRegexIds = charBinding?.appOverrides.story?.regexIds;
  const regexIds = storyOverrideRegexIds && storyOverrideRegexIds.length > 0
    ? storyOverrideRegexIds
    : activeSlot.regexIds || [];
  const regexes = regexIds
    .map((id) => allRegexes.find((regex) => regex.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map((id) => allWorldBooks.find((worldBook) => worldBook.id === id))
    .filter(Boolean) as WorldBookConfig[];
  const summaryTag = preset?.story_summary_tag?.trim() || "summary";

  return {
    apiConfig,
    preset,
    regexes,
    worldBooks,
    regexSignature: [...regexes.map((regex) => `${regex.id}:${regex.updatedAt}`), `summary:${summaryTag}`].join("|"),
    summaryTag,
  };
}

export function getStoryRenderSignature(characterId: string): { regexSignature: string; parserVersion: number; regexes: RegexConfig[] } {
  const { regexSignature, regexes } = resolveStoryConfigs(characterId);
  return {
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    regexes,
  };
}

export async function generateStoryCompletion(
  characterId: string,
  history: StoryMessage[],
  options?: { sessionFoldTags?: string; sessionContextExcludedTags?: string; signal?: AbortSignal },
): Promise<StoryGenerationResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const { apiConfig, preset, regexes, worldBooks, regexSignature, summaryTag } = resolveStoryConfigs(characterId);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, effectiveContextExcludedTags);

  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character.name, userIdentity?.name ?? "用户");

  const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
    characterName: character.name,
  }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal });

  const parsed = parseStoryResponse(rawOutput, regexes, {
    summaryTag,
    foldTags: effectiveFoldTags,
    macroEngine,
    activeTags: ["story"],
  });
  return {
    rawText: parsed.rawText,
    renderedText: parsed.renderedText,
    storySummary: parsed.summaryText,
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    promptMessages: llmMessages,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

async function buildStoryPromptMessages(
  characterId: string,
  history: StoryMessage[],
  preset: PresetConfig | null,
  regexes: RegexConfig[],
  worldBooks: WorldBookConfig[],
  contextExcludedTags: string = DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS,
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const userIdentity = resolveUserIdentity(characterId, "story");
  const historyMessages = history.map((message) => toHistoryMessage(message, contextExcludedTags));
  const memConfig = loadMemoryConfig();
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "story", {
    userName: userIdentity?.name ?? "用户",
    history: historyMessages,
  });

  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
  ]);

  const now = new Date();

  return assemblePromptPayload({
    character,
    history: truncatedHistory,
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "story",
    scheduleSummary: buildCalendarScheduleMarker("character", characterId, getWeekStartIso(now)),
    currentSchedule: getCurrentCalendarScheduleForPrompt("character", characterId, now),
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks,
    unifiedRecentItems,
  });
}

export async function previewStoryPromptPayload(
  characterId: string,
  history: StoryMessage[],
  options?: { sessionContextExcludedTags?: string },
): Promise<StoryPreviewResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }
  const { apiConfig, preset, regexes, worldBooks } = resolveStoryConfigs(characterId);
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, effectiveContextExcludedTags);
  return {
    messages: previewMessagesForApi(apiConfig, preset, llmMessages),
    characterName: character.name,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

export function rebuildStorySessionRenderCache(characterId: string, sessionId: string, options?: { sessionFoldTags?: string }): StoryMessage[] {
  const { regexSignature, parserVersion } = getStoryRenderSignature(characterId);
  const { regexes, summaryTag } = resolveStoryConfigs(characterId);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;

  const character = loadCharacters().find((c) => c.id === characterId);
  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character?.name ?? "", userIdentity?.name ?? "用户");

  const rebuilt = loadStoryMessages(sessionId).map((message) => {
    if (message.role !== "assistant") {
      return {
        ...message,
        renderedContent: message.renderedContent || message.rawContent,
        regexSignature,
        parserVersion,
      };
    }
    const parsed = parseStoryResponse(message.rawContent, regexes, {
      summaryTag,
      foldTags: effectiveFoldTags,
      macroEngine,
      activeTags: ["story"],
    });
    return {
      ...message,
      renderedContent: parsed.renderedText,
      storySummary: parsed.summaryText || message.storySummary,
      regexSignature,
      parserVersion,
    };
  });
  replaceStoryMessages(sessionId, rebuilt);
  return rebuilt;
}
