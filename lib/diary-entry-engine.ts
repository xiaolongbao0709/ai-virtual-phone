import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { previewMessagesForApi, sendLLMRequest, ChatEngineError } from "./chat-engine";
import { assemblePromptPayload, ensureTrailingUserTurn, type LLMMessage } from "./llm-prompt-assembler";
import { loadBindingConfig, loadApiConfigs, loadPresets, loadWorldBooks, loadRegexes, resolveBinding, resolveUserIdentity } from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { formatDiaryEntryContext, parseDiaryEntryContent, type ParsedDiaryEntry } from "./diary-entry-utils";
import type { DiaryEntry, DiaryEntryTrigger } from "./diary-entry-types";
import { beginDiaryGeneration, endDiaryGeneration } from "./diary-generating-tracker";

type ResolvedDiaryEntryGeneration = {
  character: Character;
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  messages: LLMMessage[];
  userName: string;
};

async function resolveDiaryEntryGeneration(
  characterId: string,
  entries: DiaryEntry[],
): Promise<ResolvedDiaryEntryGeneration> {
  const character = loadCharacters().find(entry => entry.id === characterId);
  if (!character) throw new ChatEngineError("找不到要写日记的角色。");

  const bindings = loadBindingConfig();
  const slot = resolveBinding(bindings, character.id, "diary");
  if (!slot.apiConfigId) {
    throw new ChatEngineError(`未给「日记」绑定 ${character.name} 的 API 配置。`);
  }

  const apiConfig = loadApiConfigs().find(entry => entry.id === slot.apiConfigId);
  if (!apiConfig) throw new ChatEngineError(`找不到 ${character.name} 的 API 配置。`);

  const presets = loadPresets();
  let preset = slot.presetId ? presets.find(entry => entry.id === slot.presetId) ?? null : null;
  if (!preset) preset = presets.find(entry => entry.builtIn) ?? null;

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (slot.worldBookIds || [])
    .map(id => allWorldBooks.find(entry => entry.id === id))
    .filter(Boolean) as WorldBookConfig[];

  const allRegexes = loadRegexes();
  const regexes = (slot.regexIds || [])
    .map(id => allRegexes.find(entry => entry.id === id))
    .filter(Boolean) as RegexConfig[];

  const userIdentity = resolveUserIdentity(character.id, "diary");
  const userName = userIdentity?.name ?? "用户";
  const memConfig = loadMemoryConfig();
  // chatAsHistory：把私聊读成真正的对话历史，user 的发言走 user、角色的发言走
  // assistant，和聊天/剧情一致；而不是全部压进 <shortTermMemory> 的 system 文本里。
  const prepared = prepareShortTermContext(character.id, "diary", {
    userName,
    chatAsHistory: true,
  });
  // 角色写自己的日记只参考角色自己写过的日记，绝不掺进用户手写的「我的日记」——
  // 否则角色写日记很容易变成回应用户日记，而不是像平常一样正常记录自己的生活。
  // 用户日记该不该被角色知道，由聊天时的记忆/近期动态注入负责，与这里无关。
  const ownEntries = entries.filter(entry => entry.authorType !== "user");

  const [memories, coreMemories] = await Promise.all([
    retrieveMemoriesForPrompt(character.id, prepared.wbActivationContext, memConfig).catch(() => []),
    retrieveCoreMemoriesForPrompt(character.id, memConfig).catch(() => []),
  ]);

  const messages = assemblePromptPayload({
    character,
    history: prepared.truncatedHistory,
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "diary",
    appTags: ["diary", "entries"],
    longTermMemories: formatLongTermMemories(memories),
    coreMemories: formatCoreMemories(coreMemories),
    worldBookActivationContext: prepared.wbActivationContext,
    recentBlocks: prepared.recentBlocks,
    unifiedRecentItems: prepared.unifiedRecentItems,
    diaryEntryContext: formatDiaryEntryContext(ownEntries),
  });

  ensureTrailingUserTurn(messages, "请按以上设定和规则，开始写这篇日记。");

  return { character, apiConfig, preset, regexes, messages, userName };
}

export async function generateDiaryEntryForCharacter(
  characterId: string,
  entries: DiaryEntry[],
  _trigger: DiaryEntryTrigger = "manual",
): Promise<ParsedDiaryEntry> {
  // Tracked at the engine so every caller (manual + background timer) shows up
  // in the diary app's "generating" indicator, even across app re-entry.
  beginDiaryGeneration(characterId);
  try {
    const resolved = await resolveDiaryEntryGeneration(characterId, entries);
    const raw = await sendLLMRequest(
      resolved.apiConfig,
      resolved.preset,
      resolved.messages,
      resolved.regexes,
      { characterName: `日记:${resolved.character.name}`, userName: resolved.userName },
      { appId: "diary", appTags: ["diary", "entries"] },
    );
    return parseDiaryEntryContent(raw);
  } finally {
    endDiaryGeneration(characterId);
  }
}

export async function previewDiaryEntryPromptPayload(
  characterId: string,
  entries: DiaryEntry[],
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const resolved = await resolveDiaryEntryGeneration(characterId, entries);
  return {
    messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, resolved.messages),
    characterName: `日记:${resolved.character.name}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "默认预设",
  };
}
