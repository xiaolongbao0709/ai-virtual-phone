import type { DwellingFurniture, DwellingLayout, DwellingMarker, DwellingPosition } from "./dwelling-storage";
import { loadDwellingLayout } from "./dwelling-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
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
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";

// ── Resolve configs (same pattern as story-engine) ──

function resolveDwellingConfigs(characterId: string) {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "dwelling");

    const apiConfigs = loadApiConfigs();
    const apiConfig = apiConfigs.find(c => c.id === slot.apiConfigId) ?? apiConfigs[0];

    const presets = loadPresets();
    let preset = slot.presetId ? presets.find(p => p.id === slot.presetId) ?? null : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? null;

    const allWbs = loadWorldBooks();
    const worldBooks = (slot.worldBookIds || []).map(id => allWbs.find(w => w.id === id)).filter(Boolean) as WorldBookConfig[];

    const allRegexes = loadRegexes();
    const regexes = (slot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as RegexConfig[];

    return { apiConfig, preset, worldBooks, regexes };
}

// ── Build prompt messages via preset assembler ──

async function buildDwellingMessages(
    characterId: string,
    preset: PresetConfig | null,
    worldBooks: WorldBookConfig[],
    regexes: RegexConfig[],
    appTags: string[],
    dwellingContext?: string,
    macros?: { dwellingRoom?: string; dwellingFurniture?: string; dwellingItem?: string; dwellingItemPreview?: string },
): Promise<LLMMessage[]> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const userIdentity = resolveUserIdentity(characterId, "dwelling");
    const memConfig = loadMemoryConfig();
    const { recentBlocks, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "dwelling", {
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
        appId: "dwelling",
        appTags,
        scheduleSummary: buildCalendarScheduleMarker("character", characterId, getWeekStartIso(new Date())),
        coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
        longTermMemories: memories ? formatLongTermMemories(memories) : "",
        worldBookActivationContext: wbActivationContext,
        recentBlocks,
        unifiedRecentItems,
        dwellingContext,
        dwellingRoom: macros?.dwellingRoom,
        dwellingFurniture: macros?.dwellingFurniture,
        dwellingItem: macros?.dwellingItem,
        dwellingItemPreview: macros?.dwellingItemPreview,
    });
}

// ── Valid positions for dedup ─────────────────

const ALL_POSITIONS: DwellingPosition[] = [
    "top-left", "top-center", "top-right",
    "center-left", "center", "center-right",
    "bottom-left", "bottom-center", "bottom-right",
];

function deduplicatePositions(rooms: DwellingLayout["rooms"]): void {
    for (const room of rooms) {
        const used = new Set<string>();
        for (const f of room.furniture) {
            if (!ALL_POSITIONS.includes(f.position)) f.position = "center";
            if (used.has(f.position)) {
                const free = ALL_POSITIONS.find(p => !used.has(p));
                if (free) f.position = free;
            }
            used.add(f.position);
        }
    }
}

// ── Marker sanitize + position fallback ───────

/** 标注点安全范围：避开顶部玻璃栏区和底部引言区 */
const MARKER_X_MIN = 0.08, MARKER_X_MAX = 0.92;
const MARKER_Y_MIN = 0.24, MARKER_Y_MAX = 0.82;

const POSITION_MARKERS: Record<DwellingPosition, DwellingMarker> = {
    "top-left": { x: 0.26, y: 0.3 }, "top-center": { x: 0.5, y: 0.26 }, "top-right": { x: 0.74, y: 0.3 },
    "center-left": { x: 0.24, y: 0.5 }, "center": { x: 0.5, y: 0.48 }, "center-right": { x: 0.76, y: 0.5 },
    "bottom-left": { x: 0.27, y: 0.7 }, "bottom-center": { x: 0.5, y: 0.72 }, "bottom-right": { x: 0.73, y: 0.7 },
};

function clampMarker(m: DwellingMarker): DwellingMarker {
    return {
        x: Math.min(MARKER_X_MAX, Math.max(MARKER_X_MIN, m.x)),
        y: Math.min(MARKER_Y_MAX, Math.max(MARKER_Y_MIN, m.y)),
    };
}

/** 取家具标注点：优先 LLM 输出的 marker，旧数据/缺失时按九宫格 position 兜底 */
export function resolveFurnitureMarker(f: DwellingFurniture): DwellingMarker {
    const m = f.marker;
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) return clampMarker(m);
    return POSITION_MARKERS[f.position] ?? POSITION_MARKERS.center;
}

function sanitizeLayoutExtras(rooms: DwellingLayout["rooms"]): void {
    for (const room of rooms) {
        if (typeof room.en === "string") room.en = room.en.trim().toUpperCase().slice(0, 24) || undefined;
        else room.en = undefined;
        if (typeof room.imagePrompt === "string") room.imagePrompt = room.imagePrompt.trim() || undefined;
        else room.imagePrompt = undefined;
        for (const f of room.furniture) {
            if (typeof f.en === "string") f.en = f.en.trim().toUpperCase().slice(0, 24) || undefined;
            else f.en = undefined;
            const m = f.marker as unknown;
            if (m && typeof m === "object"
                && Number.isFinite((m as DwellingMarker).x) && Number.isFinite((m as DwellingMarker).y)) {
                f.marker = clampMarker(m as DwellingMarker);
            } else {
                f.marker = undefined;
            }
        }
    }
}

// ── Strip markdown fences + parse JSON ────────

function extractJSON(text: string): unknown | null {
    let s = text.trim();

    // Strip thinking / reasoning tags
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
    s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "").trim();

    // Try markdown fence first
    const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
    }

    // Try parsing as-is
    try { return JSON.parse(s); } catch { /* fall through */ }

    // Try to find the outermost { ... } or [ ... ]
    const braceStart = s.indexOf("{");
    const bracketStart = s.indexOf("[");
    const start = braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart) ? braceStart : bracketStart;
    if (start >= 0) {
        const openChar = s[start];
        const closeChar = openChar === "{" ? "}" : "]";
        // Find matching close from the end
        const end = s.lastIndexOf(closeChar);
        if (end > start) {
            try { return JSON.parse(s.slice(start, end + 1)); } catch { /* fall through */ }
        }
    }

    console.warn("[Dwelling] Failed to extract JSON from LLM output:", s.slice(0, 500));
    return null;
}

// ── Format existing layout as compact context text ──

export function formatDwellingContext(layout: DwellingLayout, updatedAt: string): string {
    const ts = updatedAt.slice(0, 16).replace("T", " ");
    const lines = [`[房屋布局 ${ts} 更新]`];
    for (const room of layout.rooms) {
        const parts: string[] = [];
        for (const f of room.furniture) {
            const items = f.items.map(i => {
                const detail = i.preview ? `${i.name}(${i.preview})` : i.name;
                return detail;
            }).join("、");
            parts.push(`${f.label}：${items}`);
        }
        lines.push(`◆ ${room.name}\n  ${parts.join("\n  ")}`);
    }
    return lines.join("\n");
}

// ── Generate room layout ──────────────────────

export type DwellingRefreshMode = "full" | "items";

export async function generateDwellingLayout(
    characterId: string,
    mode: DwellingRefreshMode = "full",
    signal?: AbortSignal,
): Promise<{ layout: DwellingLayout | null; error?: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) return { layout: null, error: "未找到可用的 API 配置" };

    // Load existing layout for context injection
    const oldCached = await loadDwellingLayout(characterId);
    const dwellingContext = oldCached ? formatDwellingContext(oldCached.layout, oldCached.updatedAt) : undefined;

    // items mode requires existing layout
    if (mode === "items" && !oldCached) mode = "full";

    const appTags = ["dwelling", mode === "items" ? "items" : "full"];

    try {
        const llmMessages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, appTags, dwellingContext);

        const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
            characterName: loadCharacters().find(c => c.id === characterId)?.name,
        }, {
            appId: "dwelling",
            appTags,
        });

        if (!rawOutput) return { layout: null, error: "LLM 返回为空" };

        const parsed = extractJSON(rawOutput);
        if (!parsed || typeof parsed !== "object") {
            return { layout: null, error: "无法解析 LLM 返回的 JSON" };
        }

        const obj = parsed as Record<string, unknown>;
        if (!Array.isArray(obj.rooms) || obj.rooms.length === 0) {
            return { layout: null, error: "LLM 返回格式不正确（缺少 rooms）" };
        }

        let layout = obj as DwellingLayout;
        // Ensure every room has furniture array, every furniture has items array
        for (const room of layout.rooms) {
            if (!Array.isArray(room.furniture)) room.furniture = [];
            for (const f of room.furniture) {
                if (!Array.isArray(f.items)) f.items = [];
            }
        }

        // Items mode: merge new items into old layout structure
        if (mode === "items" && oldCached) {
            const oldLayout = structuredClone(oldCached.layout);
            const newItemsMap = new Map<string, typeof layout.rooms[0]["furniture"][0]["items"]>();
            for (const room of layout.rooms) {
                for (const f of room.furniture) {
                    newItemsMap.set(`${room.id}_${f.id}`, f.items);
                }
            }
            for (const room of oldLayout.rooms) {
                for (const f of room.furniture) {
                    const newItems = newItemsMap.get(`${room.id}_${f.id}`);
                    if (newItems) f.items = newItems;
                }
            }
            layout = oldLayout;
        }

        deduplicatePositions(layout.rooms);
        sanitizeLayoutExtras(layout.rooms);

        return { layout };
    } catch (e) {
        const msg = e instanceof Error ? e.message : "生成失败";
        return { layout: null, error: msg };
    }
}

// ── Generate HTML for a single item ──

export async function generateItemHtml(
    characterId: string,
    roomName: string,
    furnitureLabel: string,
    itemName: string,
    itemPreview: string,
): Promise<{ html: string | null; error?: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) return { html: null, error: "未找到可用的 API 配置" };
    const appTags = ["dwelling", "explore"];

    try {
        const llmMessages = await buildDwellingMessages(
            characterId, preset, worldBooks, regexes,
            appTags,
            undefined,
            { dwellingRoom: roomName, dwellingFurniture: furnitureLabel, dwellingItem: itemName, dwellingItemPreview: itemPreview },
        );
        const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
            characterName: loadCharacters().find(c => c.id === characterId)?.name,
        }, {
            appId: "dwelling",
            appTags,
        });

        return { html: rawOutput || null };
    } catch (e) {
        const msg = e instanceof Error ? e.message : "生成失败";
        return { html: null, error: msg };
    }
}

export async function previewDwellingPromptPayload(
    characterId: string,
    mode: DwellingRefreshMode | "explore" = "full",
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未找到可用的 API 配置");
    const character = loadCharacters().find(c => c.id === characterId);
    const cached = await loadDwellingLayout(characterId);
    const dwellingContext = cached ? formatDwellingContext(cached.layout, cached.updatedAt) : undefined;
    const appTags = mode === "explore"
        ? ["dwelling", "explore"]
        : ["dwelling", mode === "items" ? "items" : "full"];
    const llmMessages = mode === "explore"
        ? await buildDwellingMessages(
            characterId,
            preset,
            worldBooks,
            regexes,
            appTags,
            undefined,
            {
                dwellingRoom: cached?.layout.rooms[0]?.name ?? "房间",
                dwellingFurniture: cached?.layout.rooms[0]?.furniture[0]?.label ?? "家具",
                dwellingItem: cached?.layout.rooms[0]?.furniture[0]?.items[0]?.name ?? "物品",
                dwellingItemPreview: cached?.layout.rooms[0]?.furniture[0]?.items[0]?.preview ?? "物品外观与细节",
            },
        )
        : await buildDwellingMessages(characterId, preset, worldBooks, regexes, appTags, dwellingContext);

    return {
        messages: previewMessagesForApi(apiConfig, preset, llmMessages),
        characterName: `栖所:${character?.name ?? characterId}`,
        model: apiConfig.defaultModel,
        presetName: preset?.name ?? "默认预设",
    };
}
