// lib/mixology/storage.ts
// 独家特调 · 本地存取：酒柜（材料）/ 特调方案 / 对局，全部走 kv-db。
// 官方出厂件（基底/杯型）不落酒柜：按 id 从出厂工厂直读（人人可用、永远最新），
// 在酒材页作为官方条目展示，吧台槽位选择时与酒柜材料并排可选。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type {
    MixMaterial,
    MixMaterialKind,
    MixRecipe,
    MixSession,
    MixSlotEntry,
} from "./types";
import { MIX_SLOT_ORDER, mixSlotEntries, normalizeMixSlots } from "./types";
import {
    MIX_BUILTIN_BASE_ID,
    MIX_BUILTIN_GLASS_ID,
    createBuiltinBase,
    createBuiltinGlass,
} from "./builtin";

const CABINET_KEY = "mixology_cabinet_v1";
const RECIPES_KEY = "mixology_recipes_v1";
const SESSIONS_KEY = "mixology_sessions_v1";
const BUILTIN_VERSION_KEY = "mixology_builtin_version_v1";
const PROFILE_KEY = "mixology_profile_v1";

registerKvMigration(CABINET_KEY);
registerKvMigration(RECIPES_KEY);
registerKvMigration(SESSIONS_KEY);
registerKvMigration(BUILTIN_VERSION_KEY);
registerKvMigration(PROFILE_KEY);

/**
 * 酒柜被外部改写（小卷工具）后的广播事件：已打开的特调 App 据此重读列表。
 * App 自己的操作不用它——那些路径本来就会调 refresh。
 */
export const MIX_CABINET_UPDATED_EVENT = "mix-cabinet-updated";

/** 官方件不可删除、不可改名（内容永远是当前出厂版） */
export const MIX_BUILTIN_IDS: readonly string[] = [
    MIX_BUILTIN_BASE_ID,
    MIX_BUILTIN_GLASS_ID,
];

export function isMixBuiltinId(id: string): boolean {
    return MIX_BUILTIN_IDS.includes(id);
}

/** 出厂件工厂直读：不落库，每次现造，天然随版本更新 */
export function listMixBuiltins(kind?: MixMaterialKind): MixMaterial[] {
    const factory: MixMaterial[] = [createBuiltinBase(), createBuiltinGlass()];
    return kind ? factory.filter((m) => m.kind === kind) : factory;
}

export function getMixBuiltin(id: string): MixMaterial | null {
    if (!isMixBuiltinId(id)) return null;
    return listMixBuiltins().find((m) => m.id === id) ?? null;
}

function readJson<T>(key: string, fallback: T): T {
    const raw = kvGet(key);
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return (parsed ?? fallback) as T;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    kvSet(key, JSON.stringify(value));
}

// ---------- 创作者资料 ----------

/** 发布到酒材/配方页时用的署名与头像（都选填；名字留空时线上回退到账号昵称） */
export type MixProfile = {
    name?: string;
    /** 头像 dataURL（压缩后的小图） */
    avatar?: string;
};

export function loadMixProfile(): MixProfile {
    const stored = readJson<MixProfile>(PROFILE_KEY, {});
    if (!stored || typeof stored !== "object") return {};
    return {
        name: typeof stored.name === "string" && stored.name.trim() ? stored.name.trim() : undefined,
        avatar: typeof stored.avatar === "string" && stored.avatar ? stored.avatar : undefined,
    };
}

export function saveMixProfile(profile: MixProfile): void {
    writeJson(PROFILE_KEY, {
        name: profile.name?.trim() || undefined,
        avatar: profile.avatar || undefined,
    });
}

// ---------- 酒柜（材料） ----------

export function loadMixCabinet(): MixMaterial[] {
    const stored = readJson<MixMaterial[]>(CABINET_KEY, []);
    const list = Array.isArray(stored) ? stored : [];
    // 迁移：老版本把出厂件种进了酒柜——现在出厂件工厂直读、酒材页展示，从柜里剔掉
    const next = list.filter((m) => !isMixBuiltinId(m.id));
    if (next.length !== list.length) writeJson(CABINET_KEY, next);
    return next;
}

export function listMixMaterials(kind: MixMaterialKind): MixMaterial[] {
    return loadMixCabinet()
        .filter((m) => m.kind === kind)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 吧台/对局的槽位候选：官方出厂件在前 + 酒柜材料在后 */
export function listMixPickables(kind: MixMaterialKind): MixMaterial[] {
    return [...listMixBuiltins(kind), ...listMixMaterials(kind)];
}

export function getMixMaterial(id: string): MixMaterial | null {
    return getMixBuiltin(id) ?? loadMixCabinet().find((m) => m.id === id) ?? null;
}

/** 新增或整体覆盖一件材料（id 相同即覆盖） */
export function saveMixMaterial(material: MixMaterial): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === material.id);
    const stamped = { ...material, updatedAt: Date.now() };
    // 只有角色卡收封面：其余种类的列表海报由渲染缩样自动生成，
    // 老材料/导入文件残留的 cover 在落库这道总闸口洗掉，不再跟着材料到处走
    if (stamped.kind !== "character") delete (stamped as { cover?: string }).cover;
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(CABINET_KEY, list);
}

/**
 * 云端同步成功后的记账：写 publishedId 并把 publishedAt 对齐当前 updatedAt。
 * 不能走 saveMixMaterial（它会重打 updatedAt，材料就永远显示"有未上架修改"）。
 */
export function markMixMaterialSynced(id: string, publishedId: string): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], publishedId, publishedAt: list[idx].updatedAt };
    writeJson(CABINET_KEY, list);
}

/**
 * 按云端条目 id 反查本地件。
 * 用在「把自己发布的作品拉回本地」：柜里已经有关联着这条云端条目的原件时，
 * 直接用那一件，不要再拉一份出来变成两件同名材料。
 */
export function findMixMaterialByPublishedId(cloudId: string): MixMaterial | null {
    return loadMixCabinet().find((m) => m.publishedId === cloudId) ?? null;
}

/** 云端条目已下架/丢失时清掉本地的发布关联，回到"未上架"态 */
export function clearMixMaterialPublished(id: string): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const { publishedId: _publishedId, publishedAt: _publishedAt, ...rest } = list[idx];
    list[idx] = rest as MixMaterial;
    writeJson(CABINET_KEY, list);
}

/** 删除材料（官方件拒删）。返回是否真的删了。 */
export function deleteMixMaterial(id: string): boolean {
    if (isMixBuiltinId(id)) return false;
    const list = loadMixCabinet();
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return false;
    writeJson(CABINET_KEY, next);
    return true;
}

// ---------- 特调方案 ----------

/** 早期一格只放一件、槽位存的是材料 id 字符串；读盘时统一成新形状（有序清单） */
function migrateRecipeSlots<T extends { slots?: unknown }>(item: T): T {
    return { ...item, slots: normalizeMixSlots(item.slots as never) };
}

export function loadMixRecipes(): MixRecipe[] {
    const stored = readJson<MixRecipe[]>(RECIPES_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        .map(migrateRecipeSlots)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixRecipe(id: string): MixRecipe | null {
    return loadMixRecipes().find((r) => r.id === id) ?? null;
}

export function saveMixRecipe(recipe: MixRecipe): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === recipe.id);
    const stamped = { ...recipe, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(RECIPES_KEY, list);
}

export function deleteMixRecipe(id: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    writeJson(RECIPES_KEY, list.filter((r) => r.id !== id));
}

/** 同 markMixMaterialSynced：配方云端同步成功后的记账 */
export function markMixRecipeSynced(id: string, publishedId: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], publishedId, publishedAt: list[idx].updatedAt };
    writeJson(RECIPES_KEY, list);
}

/** 同 findMixMaterialByPublishedId：按云端条目 id 反查本地配方 */
export function findMixRecipeByPublishedId(cloudId: string): MixRecipe | null {
    return loadMixRecipes().find((r) => r.publishedId === cloudId) ?? null;
}

/** 云端配方条目已下架/丢失时清掉本地发布关联 */
export function clearMixRecipePublished(id: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const { publishedId: _publishedId, publishedAt: _publishedAt, ...rest } = list[idx];
    list[idx] = rest as MixRecipe;
    writeJson(RECIPES_KEY, list);
}

/**
 * 按云端条目 id 反查本地件并清掉发布关联——在「我的发布」里下架成功后调用，
 * 让酒柜/配方列表的「已上架」徽章立刻消失，而不是等下次更新时撞 404。
 */
export function clearMixPublishedByCloudId(type: "material" | "recipe", cloudId: string): void {
    if (type === "material") {
        const material = loadMixCabinet().find((m) => m.publishedId === cloudId);
        if (material) clearMixMaterialPublished(material.id);
    } else {
        const recipe = readJson<MixRecipe[]>(RECIPES_KEY, []).find((r) => r.publishedId === cloudId);
        if (recipe) clearMixRecipePublished(recipe.id);
    }
}

// ---------- 对局 ----------

export function loadMixSessions(): MixSession[] {
    const stored = readJson<MixSession[]>(SESSIONS_KEY, []);
    return (Array.isArray(stored) ? stored : [])
        // 对局里存的是开局时的方案快照，同样要迁
        .map((session) => ({ ...session, recipe: migrateRecipeSlots(session.recipe) }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixSession(id: string): MixSession | null {
    return loadMixSessions().find((s) => s.id === id) ?? null;
}

export function saveMixSession(session: MixSession): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    const idx = list.findIndex((s) => s.id === session.id);
    const stamped = { ...session, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(SESSIONS_KEY, list);
}

export function deleteMixSession(id: string): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    writeJson(SESSIONS_KEY, list.filter((s) => s.id !== id));
}

/**
 * 按方案槽位取材料实体（出厂件走工厂直读）。一格可能叠了多件，按顺序全部取出；
 * 取不到的（材料被删）静默跳过并记进 missing。这里不判生效条件——条件要看对局现场，
 * 由引擎在装配前逐条判定。
 */
export function resolveMixRecipeMaterials(
    recipe: MixRecipe,
): {
    materials: Partial<Record<MixMaterialKind, MixMaterial[]>>;
    entries: Partial<Record<MixMaterialKind, { entry: MixSlotEntry; material: MixMaterial }[]>>;
    missing: MixMaterialKind[];
} {
    const cabinet = loadMixCabinet();
    const materials: Partial<Record<MixMaterialKind, MixMaterial[]>> = {};
    const entries: Partial<Record<MixMaterialKind, { entry: MixSlotEntry; material: MixMaterial }[]>> = {};
    const missing: MixMaterialKind[] = [];
    for (const kind of MIX_SLOT_ORDER) {
        const slotEntries = mixSlotEntries(recipe.slots, kind);
        if (!slotEntries.length) continue;
        const resolved: { entry: MixSlotEntry; material: MixMaterial }[] = [];
        for (const entry of slotEntries) {
            const found = getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId) ?? null;
            if (found && found.kind === kind) resolved.push({ entry, material: found });
            else if (!missing.includes(kind)) missing.push(kind);
        }
        if (resolved.length) {
            entries[kind] = resolved;
            materials[kind] = resolved.map((r) => r.material);
        }
    }
    return { materials, entries, missing };
}
