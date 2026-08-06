// lib/album-engine.ts
// C 自发拍照引擎：解析 [相册] 动作标记 -> 用 C+U 锁脸生图 -> 调 LLM 写第一视角随想 -> 存进该角色的相册。
import {
    resolveBinding,
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadRegexes,
    loadImageGenerationSettings,
    resolveUserIdentity,
    type ApiConfig,
    type PresetConfig,
    type RegexConfig,
    type UserIdentity,
} from "./settings-storage";
import { loadCharacters } from "./character-storage";
import { generateImageFromConfiguredApi } from "./image-generation-service";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { addAlbumPhoto, saveAlbumPhotoImage, type AlbumPhotoType } from "./character-album-store";
import { callLLM } from "./moments-engine";
import { throwIfAborted, isAbortError } from "./abort-utils";
import type { LLMMessage } from "./llm-prompt-assembler";

export type AlbumCapture = { type: AlbumPhotoType; prompt: string };

/** 解析 [相册]type=shared|prompt=...[/相册] 标记 */
export function parseAlbumCaptureResponse(rawText: string): AlbumCapture | null {
    const blockMatch = rawText.match(/\[相册\]\s*([\s\S]*?)\s*\[\/相册\]/i);
    const inner = blockMatch ? blockMatch[1] : rawText;
    const typeMatch = inner.match(/type\s*[=：]\s*(shared|life)/i);
    const type: AlbumPhotoType = typeMatch ? (typeMatch[1].toLowerCase() as AlbumPhotoType) : "shared";
    const promptMatch = inner.match(/prompt\s*[=：]\s*([\s\S]*?)(?:\s*\[\/相册\]|$)/i);
    const prompt = promptMatch
        ? promptMatch[1].trim()
        : inner.replace(/type\s*[=：]\s*(shared|life)/i, "").replace(/\]/g, "").trim();
    if (!prompt) return null;
    return { type, prompt };
}

function resolveCharacterApi(characterId: string): {
    config: ApiConfig | null;
    preset: PresetConfig | null;
    regexes: RegexConfig[];
} {
    const bindings = loadBindingConfig();
    const activeSlot = resolveBinding(bindings, characterId, "moments");
    let config: ApiConfig | null = null;
    if (activeSlot.apiConfigId) {
        config = loadApiConfigs().find(c => c.id === activeSlot.apiConfigId) ?? null;
    }
    const presets = loadPresets();
    let preset = activeSlot.presetId ? presets.find(p => p.id === activeSlot.presetId) ?? null : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? null;
    const regexes = (activeSlot.regexIds || [])
        .map(id => loadRegexes().find(r => r.id === id))
        .filter(Boolean) as RegexConfig[];
    return { config, preset, regexes };
}

/** C 自发拍照主流程：生图 + 写随想 + 存册 */
export async function generateAlbumCapture(
    characterId: string,
    parsed: AlbumCapture,
    signal?: AbortSignal,
): Promise<void> {
    throwIfAborted(signal);
    const settings = loadImageGenerationSettings();
    if (!settings.enabled) {
        console.warn("[Album] Image generation disabled, skip capture");
        return;
    }
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return;
    const userIdentity: UserIdentity | null = resolveUserIdentity();

    // ── 参考图（锁脸）：C 的参考图 + U 的脸 ──
    const charRef = settings.characterReferences[characterId];
    const charRefUrl = charRef?.assetId
        ? await getChatImageFromIndexedDB(charRef.assetId)
        : (character.avatar || null);
    const userRefUrl = userIdentity?.faceLockUrl || userIdentity?.avatarUrl || null;

    const referenceImages: string[] = [];
    if (charRefUrl) referenceImages.push(charRefUrl);
    if (userRefUrl) referenceImages.push(userRefUrl);

    const cName = character.name;
    const uName = userIdentity?.name || "你";
    const participants = [
        { name: cName, action: "" },
        { name: uName, action: "" },
    ];
    const appearanceParts: string[] = [];
    if (character.appearance) appearanceParts.push(`${cName}：${character.appearance}`);
    if (userIdentity?.appearance) appearanceParts.push(`${uName}：${userIdentity.appearance}`);
    const participantAppearance = appearanceParts.length ? appearanceParts.join("；") : undefined;

    // ── 生图 ──
    let blob: Blob | null = null;
    try {
        const generated = await generateImageFromConfiguredApi({
            description: parsed.prompt,
            characterId,
            referenceImages,
            participants,
            participantAppearance,
            signal,
        });
        blob = generated?.blob ?? null;
    } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn("[Album] Image generation failed:", err);
    }
    throwIfAborted(signal);
    if (!blob) return;

    const assetId = await saveAlbumPhotoImage(blob);
    throwIfAborted(signal);

    // ── 写随想（C 第一视角）──
    const caption = await generateAlbumCaption(characterId, cName, uName, parsed, signal);

    await addAlbumPhoto({
        characterId,
        type: parsed.type,
        caption: caption || "",
        prompt: parsed.prompt,
        provider: settings.provider,
        assetId,
        participants: [characterId, "user"],
    });
    console.log(`[Album] Saved ${parsed.type} photo to ${cName}'s album`);
}

async function generateAlbumCaption(
    characterId: string,
    cName: string,
    uName: string,
    parsed: AlbumCapture,
    signal?: AbortSignal,
): Promise<string | null> {
    const { config, preset, regexes } = resolveCharacterApi(characterId);
    if (!config) {
        console.warn("[Album] No API config for caption, skip");
        return null;
    }
    const sceneNote = parsed.type === "shared"
        ? `这是我和${uName}的合照。`
        : `这是我生活里的一个瞬间。`;
    const messages: LLMMessage[] = [
        {
            role: "system",
            content: `你是${cName}。这是你手机相册里的一张照片，请以第一人称（用"我"）写一句对它的随想/感想，1-2句，口语化、像翻看相册时不经意冒出来的碎碎念。只写心情或感触，不要复述画面，不要加引号或前缀。`,
        },
        { role: "user", content: `照片场景：${parsed.prompt}\n${sceneNote}` },
    ];
    try {
        const text = await callLLM(config, preset, messages, cName, regexes, ["album"], uName);
        return text?.trim() || null;
    } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn("[Album] Caption generation failed:", err);
        return null;
    }
}
