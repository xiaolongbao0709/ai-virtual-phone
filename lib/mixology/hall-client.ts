"use client";

// 独家特调 · 酒单/大厅客户端：走站内 /api/mixology/*（官网专用；
// 自部署没配 Supabase 时接口返回 503/setupRequired，界面按未开张处理）。

import { loadMixProfile } from "./storage";
import type { MixCondition, MixMaterial, MixMaterialKind } from "./types";
import { captureMixMatThumb } from "./mat-thumb";

function stripLocalOnly(material: MixMaterial): MixMaterial {
    const { publishedId: _publishedId, publishedAt: _publishedAt, ...rest } = material;
    // 只有角色卡收封面：小票/装饰/尾调早改成渲染缩样当海报了，
    // 老材料身上残留的 cover 字段不跟着上架（不清这里的话删掉重传都还带着旧图）
    if (material.kind !== "character") delete (rest as { cover?: string }).cover;
    return rest as MixMaterial;
}

/**
 * 上架条目的封面字段。
 * 角色卡用作者自己配的图；小票/尾调没有配图这回事，改为把渲染结果现拍一张
 * 很小的 WebP 缩略图——大厅列表不下发 payload，渲染不出样子，只能靠这张图。
 * 拍不成就退回空串：条目照常上架，列表退回图标占位。
 */
async function hallCover(material: MixMaterial): Promise<string> {
    if (material.kind === "character") return material.cover ?? "";
    return await captureMixMatThumb(material);
}

function authorFields(): { authorName: string; authorAvatar: string } {
    const profile = loadMixProfile();
    return { authorName: profile.name ?? "", authorAvatar: profile.avatar ?? "" };
}

export type MixHallType = "material" | "recipe";
export type MixHallEntryBase = {
    id: string; name: string; authorId: string; authorName: string; authorAvatar: string; cover: string;
    likeCount: number; saveCount: number; viewCount: number; commentCount: number;
    likedByMe?: boolean; savedByMe?: boolean; createdAt: string; updatedAt: string;
};
export type MixHallMaterial = MixHallEntryBase & { kind: MixMaterialKind; hook: string; tags: string[]; payload?: MixMaterial | null };
export type MixHallRecipePart = {
    id: string; kind: MixMaterialKind; name: string; builtin?: boolean; gone?: boolean; material?: MixMaterial | null;
    authorName?: string; authorAvatar?: string; when?: MixCondition;
};
export type MixHallRecipe = MixHallEntryBase & { intro: string; charName: string; partNames: string[]; parts?: MixHallRecipePart[] };
export type MixHallComment = {
    id: string; targetType: MixHallType; targetId: string; parentId?: string; authorId: string; authorName: string; content: string; createdAt: string;
};

type HallListResponse = { ok: boolean; entries?: unknown[]; setupRequired?: boolean; error?: string };
type HallEntryResponse = { ok: boolean; entry?: unknown; error?: string };
type HallReactionResponse = { ok: boolean; liked?: boolean; saved?: boolean; likeCount?: number; saveCount?: number; error?: string };
type HallCommentsResponse = { ok: boolean; comments?: MixHallComment[]; comment?: MixHallComment; deletedIds?: string[]; error?: string };

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(input, { ...init, credentials: "include", signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
        return data as T;
    } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw new Error("请求超时，请稍后再试。");
        throw err;
    } finally {
        window.clearTimeout(timeout);
    }
}

export async function fetchHallMaterials(kind?: MixMaterialKind, mine?: boolean): Promise<{ entries: MixHallMaterial[]; setupRequired: boolean }> {
    const query = `${kind ? `&kind=${kind}` : ""}${mine ? "&mine=1" : ""}`;
    const data = await fetchJson<HallListResponse>(
        `/api/mixology/hall-list?type=material${query}`,
        mine ? { cache: "no-store" } : undefined,
    );
    return { entries: (data.entries ?? []) as MixHallMaterial[], setupRequired: Boolean(data.setupRequired) };
}

export async function fetchHallMaterial(id: string): Promise<MixHallMaterial> {
    const data = await fetchJson<HallEntryResponse>(`/api/mixology/hall?type=material&id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!data.entry) throw new Error("材料详情加载失败");
    return data.entry as MixHallMaterial;
}

export async function fetchHallRecipes(mine?: boolean): Promise<{ entries: MixHallRecipe[]; setupRequired: boolean }> {
    const data = await fetchJson<HallListResponse>(
        `/api/mixology/hall-list?type=recipe${mine ? "&mine=1" : ""}`,
        mine ? { cache: "no-store" } : undefined,
    );
    return { entries: (data.entries ?? []) as MixHallRecipe[], setupRequired: Boolean(data.setupRequired) };
}

export async function fetchHallRecipe(id: string): Promise<MixHallRecipe> {
    const data = await fetchJson<HallEntryResponse>(`/api/mixology/hall?type=recipe&id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!data.entry) throw new Error("配方详情加载失败");
    return data.entry as MixHallRecipe;
}

export async function shareHallMaterial(material: MixMaterial): Promise<MixHallMaterial> {
    const data = await fetchJson<HallEntryResponse>("/api/mixology/hall", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "material", kind: material.kind, name: material.name, hook: material.hook ?? "", cover: await hallCover(material), tags: material.tags ?? [], payload: stripLocalOnly(material), ...authorFields() }),
    });
    if (!data.entry) throw new Error("分享失败");
    return data.entry as MixHallMaterial;
}

export type MixHallRecipeShareInput = {
    name: string; intro?: string; cover?: string; charName?: string; partNames: string[];
    parts: Array<Pick<MixHallRecipePart, "id" | "kind" | "name" | "builtin">>;
};

export async function shareHallRecipe(input: MixHallRecipeShareInput): Promise<MixHallRecipe> {
    const data = await fetchJson<HallEntryResponse>("/api/mixology/hall", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "recipe", ...input, ...authorFields() }),
    });
    if (!data.entry) throw new Error("分享失败");
    return data.entry as MixHallRecipe;
}

export class MixHallGoneError extends Error {}

async function putHall(body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch("/api/mixology/hall", {
            method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok === false) {
            if (data?.gone) throw new MixHallGoneError(data?.error || "内容已下架");
            throw new Error(data?.error || `HTTP ${response.status}`);
        }
        return (data as { entry?: unknown }).entry;
    } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw new Error("请求超时，请稍后再试。");
        throw err;
    } finally { window.clearTimeout(timeout); }
}

export async function updateHallMaterial(publishedId: string, material: MixMaterial): Promise<MixHallMaterial> {
    return await putHall({ type: "material", id: publishedId, kind: material.kind, name: material.name, hook: material.hook ?? "", cover: await hallCover(material), tags: material.tags ?? [], payload: stripLocalOnly(material), ...authorFields() }) as MixHallMaterial;
}
export async function updateHallRecipe(publishedId: string, input: MixHallRecipeShareInput): Promise<MixHallRecipe> {
    return await putHall({ type: "recipe", id: publishedId, ...input, ...authorFields() }) as MixHallRecipe;
}
/**
 * 给已上架的条目补一张缩略图（存量条目上架时还没有拍图这回事）。
 * 只写封面、不动更新时间，所以补封面不会把老条目顶到大厅最前面。
 * 拍不出来就不发请求，返回空串。
 */
export async function backfillHallThumb(publishedId: string, material: MixMaterial): Promise<string> {
    const cover = await captureMixMatThumb(material);
    if (!cover) return "";
    const res = await fetchJson<{ ok: boolean; cover?: string; error?: string }>("/api/mixology/hall", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "material", id: publishedId, action: "thumb", cover }),
    });
    if (!res.ok) throw new Error(res.error || "补封面失败");
    return res.cover ?? "";
}

export async function removeHallEntry(type: MixHallType, id: string): Promise<void> {
    await fetchJson<{ ok: boolean }>("/api/mixology/hall", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, id }) });
}
export async function toggleHallLike(type: MixHallType, id: string): Promise<{ liked: boolean; likeCount: number }> {
    const data = await fetchJson<HallReactionResponse>("/api/mixology/hall", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, id, action: "toggle_like" }) });
    return { liked: Boolean(data.liked), likeCount: data.likeCount ?? 0 };
}
export async function markHallSaved(type: MixHallType, id: string): Promise<{ saveCount: number }> {
    const data = await fetchJson<HallReactionResponse>("/api/mixology/hall", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, id, action: "save" }) });
    return { saveCount: data.saveCount ?? 0 };
}
export async function fetchHallComments(type: MixHallType, targetId: string): Promise<MixHallComment[]> {
    const data = await fetchJson<HallCommentsResponse>(`/api/mixology/comments?type=${type}&targetId=${encodeURIComponent(targetId)}`, { cache: "no-store" });
    return data.comments ?? [];
}
export async function postHallComment(type: MixHallType, targetId: string, content: string, parentId?: string): Promise<MixHallComment> {
    const data = await fetchJson<HallCommentsResponse>("/api/mixology/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, targetId, content, parentId }) });
    if (!data.comment) throw new Error("评论失败");
    return data.comment;
}
export async function deleteHallComment(commentId: string): Promise<string[]> {
    const data = await fetchJson<HallCommentsResponse>("/api/mixology/comments", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ commentId }) });
    return data.deletedIds ?? [];
}
