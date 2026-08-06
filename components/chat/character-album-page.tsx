"use client";

import { useState, useEffect, useCallback } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { Heart, Trash2, ChevronLeft, Image as ImageIcon, Users } from "lucide-react";
import {
    listAlbumByCharacter,
    getAlbumPhotoImage,
    toggleAlbumFavorite,
    removeAlbumPhoto,
    type AlbumPhoto,
} from "@/lib/character-album-store";
import { loadCharacters } from "@/lib/character-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";

export function CharacterAlbumPage({
    characterId,
    characterName,
    onBack,
}: {
    characterId: string;
    characterName: string;
    onBack: () => void;
}) {
    const [photos, setPhotos] = useState<AlbumPhoto[]>([]);
    const [images, setImages] = useState<Record<string, string>>({});
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        const list = await listAlbumByCharacter(characterId);
        setPhotos(list);
        const map: Record<string, string> = {};
        await Promise.all(
            list.map(async (p) => {
                map[p.id] = (await getAlbumPhotoImage(p.assetId)) || "";
            }),
        );
        setImages(map);
        setLoading(false);
    }, [characterId]);

    useEffect(() => {
        void load();
    }, [load]);

    const selected = photos.find((p) => p.id === selectedId) || null;
    const selectedImg = selected ? images[selected.id] || "" : "";

    const nameOf = (id: string): string => {
        if (id === "user") return resolveUserIdentity()?.name || "你";
        return loadCharacters().find((c) => c.id === id)?.name || "某人";
    };

    const handleToggleFav = async (id: string) => {
        await toggleAlbumFavorite(id);
        setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, favorite: !p.favorite } : p)));
    };

    const handleDelete = async (id: string) => {
        await removeAlbumPhoto(id);
        setSelectedId(null);
        void load();
    };

    return (
        <PageShell
            title={`${characterName} 的相册`}
            onBack={onBack}
            className="absolute inset-0 z-[120]"
            rightAction={
                <span className="ts-12 opacity-60 mr-1">{photos.length} 张</span>
            }
        >
            <div className="page-menu" style={{ padding: "12px" }}>
                {loading ? (
                    <div className="ui-empty py-16 flex flex-col items-center gap-2">
                        <ImageIcon size={22} />
                        <span className="menu-desc">加载中…</span>
                    </div>
                ) : photos.length === 0 ? (
                    <div className="ui-empty py-16 flex flex-col items-center gap-2">
                        <ImageIcon size={22} />
                        <span className="menu-desc">还没有照片</span>
                        <span className="menu-desc ts-11 opacity-70 text-center px-6">
                            {characterName} 会在聊天里自发拍下值得留念的瞬间，存到这里。
                        </span>
                    </div>
                ) : (
                    <div
                        className="grid gap-2"
                        style={{ gridTemplateColumns: "repeat(3, 1fr)" }}
                    >
                        {photos.map((p) => (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => setSelectedId(p.id)}
                                className="relative aspect-square overflow-hidden rounded-xl bg-[var(--c-input)]"
                                style={{ border: p.favorite ? "2px solid var(--c-accent)" : "none" }}
                            >
                                {images[p.id] ? (
                                    <img src={images[p.id]} alt="" className="h-full w-full object-cover" />
                                ) : (
                                    <span className="flex h-full w-full items-center justify-center text-[var(--c-icon)]">
                                        <ImageIcon size={20} />
                                    </span>
                                )}
                                {p.type === "shared" && (
                                    <span className="absolute left-1 top-1 rounded bg-black/45 px-1.5 py-0.5 ts-10 text-white">
                                        合照
                                    </span>
                                )}
                                {p.favorite && (
                                    <Heart
                                        size={14}
                                        className="absolute right-1 top-1 text-white"
                                        fill="var(--c-accent)"
                                    />
                                )}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* 大图 modal */}
            {selected && (
                <div className="absolute inset-0 z-[130] flex flex-col bg-black/90">
                    <div className="flex items-center justify-between px-3 py-3 text-white">
                        <button
                            type="button"
                            onClick={() => setSelectedId(null)}
                            className="flex items-center gap-1 ts-13"
                        >
                            <ChevronLeft size={20} /> 返回
                        </button>
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => handleToggleFav(selected.id)}
                                aria-label="收藏"
                                className={selected.favorite ? "text-[var(--c-accent)]" : "opacity-80"}
                            >
                                <Heart size={20} fill={selected.favorite ? "currentColor" : "none"} />
                            </button>
                            <button
                                type="button"
                                onClick={() => handleDelete(selected.id)}
                                aria-label="删除"
                                className="opacity-80"
                            >
                                <Trash2 size={20} />
                            </button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-auto flex flex-col items-center px-4 pb-6">
                        {selectedImg ? (
                            <img
                                src={selectedImg}
                                alt=""
                                className="max-h-[60vh] w-auto rounded-2xl object-contain"
                            />
                        ) : (
                            <div className="flex h-40 w-40 items-center justify-center rounded-2xl bg-white/10 text-white/60">
                                <ImageIcon size={28} />
                            </div>
                        )}
                        <div className="mt-4 w-full max-w-md rounded-2xl bg-white/10 p-4 text-white">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                                <span
                                    className="rounded-full px-2 py-0.5 ts-11"
                                    style={{
                                        background: selected.type === "shared" ? "rgba(255,255,255,.18)" : "rgba(255,255,255,.1)",
                                    }}
                                >
                                    {selected.type === "shared" ? "两人回忆" : "生活圈"}
                                </span>
                                {selected.participants && selected.participants.length > 0 && (
                                    <span className="flex items-center gap-1 ts-11 opacity-80">
                                        <Users size={12} />
                                        {selected.participants.map(nameOf).join("、")}
                                    </span>
                                )}
                            </div>
                            <p className="ts-13 leading-relaxed opacity-90">
                                {selected.caption || "（还没有随想）"}
                            </p>
                            {selected.prompt && (
                                <p className="mt-2 ts-11 opacity-50">画面：{selected.prompt}</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </PageShell>
    );
}
