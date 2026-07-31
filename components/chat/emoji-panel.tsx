"use client";

import { useState, useEffect } from "react";
import { loadStickerPacksForCharacters, resolvePackStickerMap, type StickerPack } from "@/lib/custom-sticker-storage";
import { BUILTIN_SCREEN_EFFECTS, loadBuiltinScreenEffectSettings } from "@/lib/chat-screen-effects";

// ── Emoji categories ─────────────────────────────

const EMOJI_CATEGORIES: { name: string; emojis: string[] }[] = [
    {
        name: "常用",
        emojis: [
            "😀", "😂", "🤣", "😊", "😍", "🥰", "😘", "😜", "🤔", "😏",
            "😅", "😭", "😤", "🥺", "😳", "🤗", "😴", "🤮", "👍", "👎",
            "👏", "🙏", "💪", "❤️", "💔", "🔥", "✨", "🎉", "😎", "🤡",
        ],
    },
    {
        name: "表情",
        emojis: [
            "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😉",
            "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😋", "😛",
            "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨",
            "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥", "😌", "😔",
            "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🥵", "🥶",
            "🥴", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "😟", "😕",
        ],
    },
    {
        name: "手势",
        emojis: [
            "👋", "🤚", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🫰",
            "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎",
            "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏",
            "💪", "🫶", "🫂", "💅", "🖐️", "🫴", "🫳",
        ],
    },
    {
        name: "爱心",
        emojis: [
            "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💕",
            "💞", "💓", "💗", "💖", "💘", "💝", "💔", "❤️‍🔥", "💋", "🫀",
        ],
    },
    {
        name: "动物",
        emojis: [
            "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
            "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🦄", "🐝",
            "🦋", "🐌", "🐛", "🐞", "🐙", "🐠", "🐬", "🐳", "🦈", "🐊",
        ],
    },
    {
        name: "食物",
        emojis: [
            "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍑",
            "🍒", "🥝", "🍅", "🥑", "🍕", "🍔", "🍟", "🌭", "🍿", "🧁",
            "🍩", "🍪", "🎂", "🍰", "🍫", "🍬", "☕", "🍵", "🧋", "🍺",
        ],
    },
];

// ── Props ─────────────────────────────

interface EmojiPanelProps {
    onSelect: (emoji: string) => void;
    /** 点击「特效」栏的特效表情：以该文本为消息内容直接发送并播放全屏特效 */
    onEffectSend?: (text: string) => void;
}

export function EmojiPanel({ onSelect, onEffectSend }: EmojiPanelProps) {
    const [emojiCategory, setEmojiCategory] = useState(0);
    // 特效栏只显示启用中的内置特效；面板挂载时读取一次即可
    const [enabledEffects] = useState(() => {
        if (!onEffectSend) return [];
        const settings = loadBuiltinScreenEffectSettings();
        return BUILTIN_SCREEN_EFFECTS.filter(effect => settings[effect.type].enabled);
    });
    const effectCategoryIndex = EMOJI_CATEGORIES.length;
    const showEffectTab = enabledEffects.length > 0;

    return (
        <div className="h-[220px] flex flex-col">
            <div className="flex gap-0.5 px-2 py-1 overflow-x-auto shrink-0 hide-scrollbar">
                {showEffectTab && (
                    <button
                        onClick={() => setEmojiCategory(effectCategoryIndex)}
                        className="emoji-category-pill"
                        {...(emojiCategory === effectCategoryIndex ? { "data-active": "" } : {})}
                    >特效</button>
                )}
                {EMOJI_CATEGORIES.map((cat, i) => (
                    <button
                        key={i}
                        onClick={() => setEmojiCategory(i)}
                        className="emoji-category-pill"
                        {...(emojiCategory === i ? { "data-active": "" } : {})}
                    >{cat.name}</button>
                ))}
            </div>
            {emojiCategory === effectCategoryIndex && showEffectTab ? (
                <div className="flex-1 overflow-auto px-2 py-1 grid grid-cols-4 gap-1.5 content-start hide-scrollbar">
                    {enabledEffects.map(effect => (
                        <button
                            key={effect.type}
                            onClick={() => onEffectSend?.(effect.icon)}
                            className="emoji-effect-tile"
                            title={effect.name}
                        >
                            <span className="emoji-effect-tile-icon">{effect.icon}</span>
                            <span className="emoji-effect-tile-name">{effect.name}</span>
                        </button>
                    ))}
                </div>
            ) : (
                <div className="flex-1 overflow-auto px-2 py-1 grid grid-cols-8 gap-0.5 content-start hide-scrollbar">
                    {EMOJI_CATEGORIES[emojiCategory].emojis.map((emoji, i) => (
                        <button
                            key={i}
                            onClick={() => onSelect(emoji)}
                            className="border-none bg-transparent ts-18 cursor-pointer p-0.5 rounded-lg flex items-center justify-center aspect-square"
                        >{emoji}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Sticker Panel ─────────────────────────────

interface StickerPanelProps {
    onSend: (name: string, stickerUrl?: string) => void;
    characterId?: string;
    characterIds?: string[];
}

export function StickerPanel({ onSend, characterId, characterIds }: StickerPanelProps) {
    const [stickerPacks, setStickerPacks] = useState<StickerPack[]>([]);
    const [activePackId, setActivePackId] = useState<string | null>(null);
    const [packUrlMap, setPackUrlMap] = useState<Record<string, string>>({});

    useEffect(() => {
        const ids = characterIds && characterIds.length > 0 ? characterIds : characterId ? [characterId] : [];
        if (ids.length === 0) {
            setStickerPacks([]);
            setActivePackId(null);
            setPackUrlMap({});
            return;
        }
        let cancelled = false;
        const packs = loadStickerPacksForCharacters(ids).filter(pack => pack.stickers.length > 0);
        setStickerPacks(packs);
        setActivePackId(prev => (prev && packs.some(pack => pack.id === prev) ? prev : packs[0]?.id ?? null));
        Promise.all(packs.map(async pack => [pack.id, await resolvePackStickerMap(pack)] as const)).then(entries => {
            if (cancelled) return;
            const next: Record<string, string> = {};
            for (const [packId, map] of entries) {
                for (const [name, url] of Object.entries(map)) {
                    next[`${packId}:${name}`] = url;
                }
            }
            setPackUrlMap(next);
        });
        return () => { cancelled = true; };
    }, [characterId, characterIds]);

    const activePack = stickerPacks.find(pack => pack.id === activePackId) ?? stickerPacks[0] ?? null;

    return (
        <div className="h-[220px] flex flex-col">
            {stickerPacks.length > 0 && (
                <div className="flex gap-0.5 px-2 py-1 overflow-x-auto shrink-0 hide-scrollbar">
                    {stickerPacks.map(pack => (
                        <button
                            key={pack.id}
                            onClick={() => setActivePackId(pack.id)}
                            className="emoji-category-pill"
                            {...(activePack?.id === pack.id ? { "data-active": "" } : {})}
                        >
                            {pack.name}
                        </button>
                    ))}
                </div>
            )}
            <div className="flex-1 overflow-auto p-2 grid grid-cols-5 gap-1 content-start hide-scrollbar">
                {!activePack && (
                    <div className="col-span-5 flex items-center justify-center text-[var(--c-text-muted)] ts-12 py-8">
                        暂无表情包，请在角色设置里上传或绑定。
                    </div>
                )}
                {activePack?.stickers.map(sticker => {
                    const url = packUrlMap[`${activePack.id}:${sticker.name}`];
                    return (
                        <button
                            key={`${activePack.id}:${sticker.id}`}
                            onClick={() => onSend(sticker.name, url)}
                            title={sticker.name}
                            className="border-none bg-transparent cursor-pointer p-1 rounded-lg flex flex-col items-center justify-start gap-0.5 min-h-[62px] min-w-0 overflow-hidden"
                        >
                            <div className="w-9 h-9 flex items-center justify-center shrink-0">
                                {url ? (
                                    <img src={url} alt={sticker.name} className="w-9 h-9 object-contain" />
                                ) : (
                                    <span className="ts-9 text-[var(--c-text)] max-w-full truncate">{sticker.name}</span>
                                )}
                            </div>
                            <span className="ts-9 leading-tight text-[var(--c-text)] opacity-75 w-full text-center truncate">
                                {sticker.name}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
