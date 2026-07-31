import type { DwellingRoom } from "./dwelling-storage";
import { loadDwellingImageEnabled } from "./dwelling-storage";
import { loadImageGenerationSettings } from "./settings-storage";
import { generateImageFromConfiguredApi } from "./image-generation-service";

// ── Availability ──────────────────────────────

export type DwellingImageAvailability = {
    /** 全局生图配置齐全且已开启 */
    configured: boolean;
    /** 栖所独立生图开关 */
    dwellingEnabled: boolean;
    /** 二者同时满足才真正生图 */
    available: boolean;
};

export function getDwellingImageAvailability(): DwellingImageAvailability {
    const s = loadImageGenerationSettings();
    const configured = Boolean(s.enabled && s.apiKey.trim() && s.baseUrl.trim() && s.model.trim());
    const dwellingEnabled = loadDwellingImageEnabled();
    return { configured, dwellingEnabled, available: configured && dwellingEnabled };
}

// ── Room image generation ─────────────────────

/** 统一风格后缀：保证各房间图色调一致、匹配栖所暗色 UI */
const DWELLING_IMAGE_STYLE_SUFFIX =
    "电影感室内空间摄影，广角镜头拍摄整个房间，低照度暗调，光影层次丰富，氛围沉静高级，构图简洁干净，画面中没有任何人物、动物和文字，真实材质细节";

function buildRoomImagePrompt(room: DwellingRoom): string {
    const labels = (room.furniture || []).map(f => f.label).filter(Boolean);
    const base = room.imagePrompt?.trim()
        || `${room.name}的室内场景，${labels.join("、")}自然分布在画面中`;
    const mustLine = labels.length
        ? `画面中必须同时出现以下家具，缺一不可：${labels.join("、")}；采用能看到整个房间的广角视角，禁止只拍某件家具的局部特写。`
        : "";
    const details = (room.furniture || [])
        .map(f => {
            const names = (f.items || []).map(i => i.name).filter(Boolean).slice(0, 3);
            return names.length ? `${f.label}上有${names.join("、")}` : "";
        })
        .filter(Boolean)
        .join("；");
    const detailLine = details
        ? `画面细节参考（从中挑选有画面感的自然呈现，小物件只需模糊暗示，画面中不要出现任何可读的文字、字母或数字）：${details}。`
        : "";
    return `${base}。${mustLine}${detailLine}${DWELLING_IMAGE_STYLE_SUFFIX}`;
}

export type DwellingRoomImageResult = { assetId: string | null; error?: string };

const inflightByRoom = new Map<string, Promise<DwellingRoomImageResult>>();

function roomKey(characterId: string, roomId: string) { return `${characterId}_${roomId}`; }

export function isDwellingRoomImageGenerating(characterId: string, roomId: string): boolean {
    return inflightByRoom.has(roomKey(characterId, roomId));
}

/** 生图请求硬超时兜底：网络切换/切后台可能让请求永远挂起（用户随时可手动停止） */
const ROOM_IMAGE_TIMEOUT_MS = 600_000;

/** 用户主动停止时的错误标记（UI 据此显示"已停止"而非"失败"） */
export const DWELLING_IMAGE_CANCELED_ERROR = "已停止生成";

const inflightControllers = new Map<string, { controller: AbortController; userCanceled: boolean }>();

/** 手动停止某个房间的生图请求 */
export function cancelDwellingRoomImage(characterId: string, roomId: string): void {
    const entry = inflightControllers.get(roomKey(characterId, roomId));
    if (entry) {
        entry.userCanceled = true;
        entry.controller.abort();
    }
}

/**
 * 为房间生成主视觉图。图像 blob 由 generateImageFromConfiguredApi 存入媒体库，
 * 返回 mediaRef（assetId）；把它写回布局并保存由调用方负责。
 * 同一房间的并发调用会合并到同一次请求。
 */
export async function generateDwellingRoomImage(
    characterId: string,
    room: DwellingRoom,
): Promise<DwellingRoomImageResult> {
    const key = roomKey(characterId, room.id);
    const existing = inflightByRoom.get(key);
    if (existing) return existing;

    const run = (async (): Promise<DwellingRoomImageResult> => {
        const controller = new AbortController();
        const entry = { controller, userCanceled: false };
        inflightControllers.set(key, entry);
        const timer = setTimeout(() => controller.abort(), ROOM_IMAGE_TIMEOUT_MS);
        try {
            const availability = getDwellingImageAvailability();
            if (!availability.available) return { assetId: null, error: "生图未开启" };
            const result = await generateImageFromConfiguredApi({
                description: buildRoomImagePrompt(room),
                signal: controller.signal,
            });
            if (!result) return { assetId: null, error: "生图未配置或已关闭" };
            return { assetId: result.mediaRef };
        } catch (e) {
            if (controller.signal.aborted) {
                return { assetId: null, error: entry.userCanceled ? DWELLING_IMAGE_CANCELED_ERROR : "生成超时，请重试" };
            }
            const msg = e instanceof Error ? e.message : "生成失败";
            return { assetId: null, error: msg };
        } finally {
            clearTimeout(timer);
            inflightByRoom.delete(key);
            inflightControllers.delete(key);
        }
    })();

    inflightByRoom.set(key, run);
    return run;
}
