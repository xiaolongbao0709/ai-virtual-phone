"use client";

// 表情包搜索联想：输入时按名称模糊匹配本地表情包，横向列表浮在输入框正上方，
// 点击直接发送（复用 onSendSticker 的 sticker 消息通道），发送后由父组件清空输入。
// 数据源 = 内置表情包（sticker-data，emoji 兜底）+ 当前会话角色绑定的自定义贴纸包（IndexedDB 解析出 url）。

import { useEffect, useMemo, useRef, useState } from "react";
import { STICKER_PACKS } from "@/lib/sticker-data";
import { loadStickerPacksForCharacters, resolvePackStickerMap } from "@/lib/custom-sticker-storage";

export type StickerSearchItem = {
  key: string;
  name: string;
  /** 自定义贴纸解析出的图片地址（dataUrl / externalUrl） */
  url?: string;
  /** 内置表情的 emoji 兜底显示 */
  emoji?: string;
};

type StickerSearchSuggestProps = {
  /** 当前输入框的原始文本 */
  query: string;
  /** 会话相关的角色 id（单聊=[contactId]，群聊=participantIds） */
  characterIds: string[];
  /** 发送：与 ChatTextInputBar 的 onSendSticker 一致（name, url?） */
  onSend: (name: string, url?: string) => void;
  /** 关闭联想（发送后 / ESC / 失焦由父组件控制，这里只负责发送后收起） */
  onClose: () => void;
};

const DEBOUNCE_MS = 300;
const MAX_RESULTS = 12;

export function StickerSearchSuggest({ query, characterIds, onSend, onClose }: StickerSearchSuggestProps) {
  // ── 防抖：输入停止 300ms 后再匹配 ──
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // ── 加载自定义贴纸（按会话角色绑定的包），解析出 name → url ──
  const [customItems, setCustomItems] = useState<StickerSearchItem[]>([]);
  const loadSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++loadSeqRef.current;
    let cancelled = false;
    (async () => {
      const packs = loadStickerPacksForCharacters(characterIds).filter((pack) => pack.stickers.length > 0);
      const urlByName: Record<string, string> = {};
      for (const pack of packs) {
        const map = await resolvePackStickerMap(pack);
        for (const [name, url] of Object.entries(map)) {
          if (url) urlByName[name] = url;
        }
      }
      if (cancelled) return;
      const items: StickerSearchItem[] = [];
      for (const pack of packs) {
        for (const sticker of pack.stickers) {
          items.push({ key: `custom:${pack.id}:${sticker.id}`, name: sticker.name, url: urlByName[sticker.name] });
        }
      }
      setCustomItems(items);
    })();
    return () => {
      cancelled = true;
      // 只清理最后一次加载，避免竞态时旧结果覆盖新结果
      if (loadSeqRef.current === seq) setCustomItems([]);
    };
  }, [characterIds]);

  // ── 内置表情包（emoji 兜底） ──
  const builtinItems = useMemo<StickerSearchItem[]>(
    () =>
      STICKER_PACKS.flatMap((pack) =>
        pack.stickers.map((sticker) => ({ key: `builtin:${sticker.name}`, name: sticker.name, emoji: sticker.emoji })),
      ),
    [],
  );

  // ── 模糊匹配 + 排序（前缀优先，再包含；同名去重，自定义优先） ──
  const results = useMemo(() => {
    const q = debouncedQuery.toLowerCase();
    if (!q) return [];
    const rank = (name: string): number => {
      const n = name.toLowerCase();
      if (n === q) return 0;
      if (n.startsWith(q)) return 1;
      if (n.includes(q)) return 2;
      return -1;
    };
    const scored = [...customItems, ...builtinItems]
      .map((item) => ({ item, rank: rank(item.name) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.item.name.length - b.item.name.length);
    const seen = new Set<string>();
    const out: StickerSearchItem[] = [];
    for (const { item } of scored) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      out.push(item);
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }, [debouncedQuery, builtinItems, customItems]);

  if (!debouncedQuery || results.length === 0) return null;

  return (
    <div
      className="sticker-search-suggest"
      style={{ position: "absolute", left: 0, right: 0, bottom: "100%", zIndex: 60, marginBottom: 6 }}
      // 阻止 mousedown 默认行为：点击列表项时不触发 textarea 失焦，避免列表在 click 前被 blur 关掉
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        className="flex items-stretch gap-2 overflow-x-auto px-3 py-2.5 rounded-2xl hide-scrollbar"
        style={{
          background: "color-mix(in srgb, var(--c-card) 96%, transparent)",
          border: "1px solid var(--c-card-border)",
          boxShadow: "0 8px 28px rgba(0,0,0,0.12)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          maxWidth: "100%",
        }}
      >
        {results.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              onSend(item.name, item.url);
              onClose();
            }}
            className="shrink-0 flex flex-col items-center gap-1 px-2.5 py-2 rounded-xl bg-transparent border-none cursor-pointer transition-transform active:scale-95"
            style={{ minWidth: 64 }}
            title={item.name}
          >
            <span className="w-14 h-14 flex items-center justify-center overflow-hidden">
              {item.url ? (
                <img src={item.url} alt={item.name} className="w-14 h-14 object-contain" draggable={false} />
              ) : item.emoji ? (
                <span className="text-[32px] leading-none">{item.emoji}</span>
              ) : (
                <span className="ts-11 text-[var(--c-text)] w-full text-center truncate">{item.name}</span>
              )}
            </span>
            <span className="ts-11 text-[var(--c-text)] opacity-75 max-w-[64px] truncate leading-tight">{item.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
