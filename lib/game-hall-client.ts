"use client";

import type { GameComment, GameTemplate } from "./game-types";

type GameHallListResponse = { ok: boolean; games?: GameTemplate[]; error?: string };
type GameHallStateResponse = { ok: boolean; likedIds?: string[]; favoriteIds?: string[]; error?: string };
type GameHallMutationResponse = { ok: boolean; game?: GameTemplate; id?: string; liked?: boolean; favorited?: boolean; likeCount?: number; favoriteCount?: number; error?: string };
type GameHallCommentsResponse = { ok: boolean; comments?: GameComment[]; comment?: GameComment; deletedIds?: string[]; gameId?: string; commentCount?: number; error?: string };
type GameHallAssetResponse = { ok: boolean; url?: string; path?: string; error?: string };

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
  return data as T;
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(input, { ...init, credentials: "include", signal: controller.signal });
    return await readJson<T>(response);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw new Error("请求超时，请检查 Supabase 网络连接。");
    throw err;
  } finally { window.clearTimeout(timeout); }
}

export async function fetchGameHallTemplates(_userId?: string): Promise<GameTemplate[]> {
  const [list, state] = await Promise.all([
    fetchJson<GameHallListResponse>("/api/game-hall/list"),
    fetchJson<GameHallStateResponse>("/api/game-hall/state", { cache: "no-store" })
      .catch(() => ({ ok: true, likedIds: [], favoriteIds: [] } as GameHallStateResponse)),
  ]);
  const liked = new Set(state.likedIds ?? []);
  const favorited = new Set(state.favoriteIds ?? []);
  return (list.games ?? []).map(game => ({ ...game, likedByMe: liked.has(game.id), favoritedByMe: favorited.has(game.id) }));
}

export async function fetchGameHallTemplate(gameId: string): Promise<GameTemplate> {
  const data = await fetchJson<GameHallMutationResponse>(`/api/game-hall/games?id=${encodeURIComponent(gameId)}`, { cache: "no-store" });
  if (!data.game) throw new Error(data.error || "游戏详情加载失败");
  return data.game;
}

export async function fetchInstalledGameHallTemplates(): Promise<GameTemplate[]> {
  const data = await fetchJson<GameHallListResponse>("/api/game-hall/games?installed=1", { cache: "no-store" });
  return data.games ?? [];
}

export async function publishGameTemplate(input: GameTemplate): Promise<GameTemplate> {
  const data = await fetchJson<GameHallMutationResponse>("/api/game-hall/games", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!data.game) throw new Error(data.error || "游戏发布失败");
  return data.game;
}
export async function updateGameTemplate(input: GameTemplate): Promise<GameTemplate> {
  const data = await fetchJson<GameHallMutationResponse>("/api/game-hall/games", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!data.game) throw new Error(data.error || "游戏修改失败");
  return data.game;
}
export async function deleteGameTemplate(input: { id: string; authorId: string }): Promise<string> {
  const data = await fetchJson<GameHallMutationResponse>("/api/game-hall/games", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return data.id || input.id;
}
export async function toggleGameLike(input: { gameId: string; userId: string }): Promise<{ game?: GameTemplate; liked: boolean; likeCount: number }> {
  const data = await fetchJson<GameHallMutationResponse>("/api/game-hall/games", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: input.gameId, userId: input.userId, action: "toggle_like" }) });
  return { game: data.game, liked: Boolean(data.liked), likeCount: Number(data.likeCount ?? data.game?.likeCount ?? 0) };
}
export async function setGameFavorite(input: { gameId: string; userId: string; favorited: boolean }): Promise<{ game?: GameTemplate; favorited: boolean; favoriteCount: number }> {
  const data = await fetchJson<GameHallMutationResponse>("/api/game-hall/games", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: input.gameId, userId: input.userId, action: input.favorited ? "favorite" : "unfavorite" }) });
  return { game: data.game, favorited: Boolean(data.favorited), favoriteCount: Number(data.favoriteCount ?? data.game?.favoriteCount ?? 0) };
}
export async function fetchGameComments(gameId: string): Promise<GameComment[]> {
  const data = await fetchJson<GameHallCommentsResponse>(`/api/game-hall/comments?gameId=${encodeURIComponent(gameId)}`, { cache: "no-store" });
  return data.comments ?? [];
}
export async function postGameComment(input: { gameId: string; parentId?: string; authorId: string; authorName: string; authorAvatar: string; content: string }): Promise<{ comment: GameComment; commentCount: number }> {
  const data = await fetchJson<GameHallCommentsResponse>("/api/game-hall/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!data.comment) throw new Error(data.error || "评论发布失败");
  return { comment: data.comment, commentCount: Number(data.commentCount ?? 0) };
}
export async function deleteGameComment(input: { commentId: string }): Promise<{ gameId: string; deletedIds: string[]; commentCount: number }> {
  const data = await fetchJson<GameHallCommentsResponse>("/api/game-hall/comments", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return { gameId: data.gameId || "", deletedIds: data.deletedIds ?? [input.commentId], commentCount: Number(data.commentCount ?? 0) };
}
export async function uploadGameHallAsset(input: { file: Blob; filename: string; kind: "cover" | "avatar" }): Promise<{ url: string; path: string }> {
  const formData = new FormData(); formData.append("file", input.file, input.filename); formData.append("kind", input.kind);
  const data = await fetchJson<GameHallAssetResponse>("/api/game-hall/assets", { method: "POST", body: formData });
  if (!data.url) throw new Error(data.error || "图片上传失败");
  return { url: data.url, path: data.path || "" };
}
