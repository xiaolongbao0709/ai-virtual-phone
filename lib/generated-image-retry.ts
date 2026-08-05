import { saveChatImageToIndexedDB } from "./chat-asset-storage";
import { syncChatGeneratedImagePromptText, updateChatMessage, type ChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { generatedImageFilename, generateImageFromConfiguredApi } from "./image-generation-service";
import { loadImageGenerationSettings, resolveUserIdentity } from "./settings-storage";
import { updateMomentPost } from "./moments-storage";
import type { MomentPost } from "./moments-types";

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// 从角色人设弱提取性别（仅当未填写「生图形象」时的回退，命中即加入描述）
function guessGenderFromPersona(persona: string): string | null {
    if (/女|她|姐|妹|妻|母|公主|女王|lady|girl|woman|female/i.test(persona)) return "女生";
    if (/男|他|哥|弟|夫|父|王子|少爷|lord|boy|man|male/i.test(persona)) return "男生";
    return null;
}

// 收集参与合影的「你」和各个角色的外观描述，拼成中文串交给生图服务翻译后注入 prompt。
// characterIds: 参与合影的角色 id 列表（群聊=participantIds，单聊=[contactId]）
export function buildParticipantAppearancePrompt(characterIds: string[]): string {
    const parts: string[] = [];

    // 1) 「你」（当前用户身份）
    const identity = resolveUserIdentity();
    const userBits: string[] = [];
    if (identity?.gender && identity.gender !== "保密") {
        userBits.push(identity.gender === "女" ? "女生" : identity.gender === "男" ? "男生" : identity.gender);
    }
    if (identity?.appearance?.trim()) userBits.push(identity.appearance.trim());
    if (userBits.length) parts.push(`你（${userBits.join("，")}）`);

    // 2) 各角色
    const chars = loadCharacters();
    for (const cid of characterIds) {
        const c = chars.find((x) => x.id === cid);
        if (!c) continue;
        const bits: string[] = [];
        if (c.appearance?.trim()) {
            bits.push(c.appearance.trim());
        } else {
            const g = guessGenderFromPersona(c.persona || "");
            if (g) bits.push(g);
        }
        parts.push(bits.length ? `${c.name}（${bits.join("，")}）` : `${c.name}`);
    }

    if (!parts.length) return "";
    return `画面中的人物设定：${parts.join("；")}。请按各自外貌与性别绘制，清晰区分不同人物的特征。`;
}

function dispatchChatMessagesUpdated(sessionId: string, message: ChatMessage): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("chat-messages-updated", {
        detail: { sessionId, message },
    }));
}

function dispatchMomentsUpdated(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("moments-updated"));
}

export function createPendingChatGeneratedImageData(
    mediaData: ChatMessage["mediaData"] | undefined,
    description?: string,
): ChatMessage["mediaData"] {
    const label = (description || mediaData?.label || "").trim();
    return {
        ...mediaData,
        label,
        imageGenerationStatus: "pending",
        imageGenerationError: undefined,
    };
}

export function isPendingChatGeneratedImageMessage(message: Pick<ChatMessage, "mediaType" | "mediaData">): boolean {
    return message.mediaType === "image" && message.mediaData?.imageGenerationStatus === "pending";
}

export async function generateAndApplyChatGeneratedImage(
    message: ChatMessage,
    characterId?: string,
    options?: { signal?: AbortSignal; description?: string; participantIds?: string[] },
): Promise<ChatMessage> {
    const previousDescription = message.mediaData?.label?.trim() || "";
    const description = (options?.description ?? previousDescription).trim();
    if (!description) throw new Error("缺少图片描述，无法重新生成");
    if (previousDescription && previousDescription !== description) {
        syncChatGeneratedImagePromptText(message.id, previousDescription, description);
    }

    // 参与者：群聊传 participantIds，单聊传 [contactId]
    const participantIds = options?.participantIds && options.participantIds.length
        ? options.participantIds
        : (characterId ? [characterId] : []);
    const participantAppearance = buildParticipantAppearancePrompt(participantIds) || undefined;

    try {
        // 聊天流程中触发的生图：强制 enabled=true（与测试生图按钮行为一致）。
        // 用户已通过 [照片:] 指令明确要求生图，不应因前端开关未打开而静默失败。
        const settings = { ...loadImageGenerationSettings(), enabled: true };
        console.log("[IMG-CHAT] 开始生图 v17", {
            description: description.slice(0, 80),
            provider: settings.provider,
            hasNaiKey: Boolean(settings.novelai?.apiKey?.trim()),
            naiModel: settings.novelai?.model,
            naiKeyLen: settings.novelai?.apiKey?.length || 0,
            hasParticipantAppearance: Boolean(participantAppearance),
        });
        const generated = await generateImageFromConfiguredApi({
            description,
            characterId,
            participantAppearance,
            useReferenceImage: message.mediaData?.useReferenceImage === true,
            signal: options?.signal,
            settings,
        });
        if (!generated) {
            console.error("[IMG-CHAT] generateImageFromConfiguredApi 返回 null — 配置不完整?", {
                provider: settings.provider,
                hasNaiKey: Boolean(settings.novelai?.apiKey?.trim()),
                hasOaiKey: Boolean(settings.apiKey?.trim()),
                enabled: settings.enabled,
            });
            throw new Error("生图配置未启用或不完整");
        }

        const fileName = generatedImageFilename(description, generated.mimeType);
        console.log("[IMG-CHAT] 生图成功", { fileName, mimeType: generated.mimeType, b64Len: generated.dataUrl.length });
        const previousData = message.mediaData ?? {};
        const nextData: ChatMessage["mediaData"] = {
            ...previousData,
            label: description,
            fileType: "image",
            fileName,
            imageGenerationMediaRef: generated.mediaRef,
            imageGenerationPrompt: generated.prompt,
            imageGenerationUsedReference: generated.usedReferenceImage,
            imageGenerationStatus: "generated",
            imageGenerationError: undefined,
        };
        const updated = updateChatMessage(message.id, {
            content: fileName,
            mediaType: "media_file",
            mediaUrl: generated.dataUrl,
            mediaData: nextData,
        });
        if (!updated) throw new Error("原消息不存在，无法替换图片");
        dispatchChatMessagesUpdated(updated.sessionId, updated);
        return updated;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error("[IMG-CHAT] 生图失败", { error: errMsg, messageId: message.id, description: description.slice(0, 80) });
        const failed = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                imageGenerationStatus: "failed",
                imageGenerationError: errorToMessage(error),
            },
        });
        if (failed) dispatchChatMessagesUpdated(failed.sessionId, failed);
        throw error;
    }
}

export async function retryChatGeneratedImage(
    message: ChatMessage,
    characterId?: string,
    nextDescription?: string,
): Promise<ChatMessage> {
    return generateAndApplyChatGeneratedImage(message, characterId, { description: nextDescription });
}

export async function retryMomentGeneratedPhoto(post: MomentPost, nextDescription?: string): Promise<MomentPost> {
    const description = (nextDescription ?? post.photoDescription)?.trim();
    if (!description) throw new Error("缺少图片描述，无法重新生成");

    const momentParticipantIds = post.authorType === "character" && post.authorId ? [post.authorId] : [];
    const momentAppearance = buildParticipantAppearancePrompt(momentParticipantIds) || undefined;

    try {
        const generated = await generateImageFromConfiguredApi({
            description,
            characterId: post.authorType === "character" ? post.authorId : undefined,
            participantAppearance: momentAppearance,
            useReferenceImage: post.photoUseReferenceImage === true,
            settings: { ...loadImageGenerationSettings(), enabled: true },
        });
        if (!generated) throw new Error("生图配置未启用或不完整");

        const assetId = await saveChatImageToIndexedDB(generated.blob);
        const updated = updateMomentPost(post.id, {
            photoUrl: `asset://${assetId}`,
            photoDescription: description,
            photoGenerationStatus: "generated",
            photoGenerationPrompt: generated.prompt,
            photoGenerationError: undefined,
        });
        if (!updated) throw new Error("原朋友圈不存在，无法替换图片");
        dispatchMomentsUpdated();
        return updated;
    } catch (error) {
        updateMomentPost(post.id, {
            photoDescription: description,
            photoGenerationStatus: "failed",
            photoGenerationError: errorToMessage(error),
        });
        dispatchMomentsUpdated();
        throw error;
    }
}
