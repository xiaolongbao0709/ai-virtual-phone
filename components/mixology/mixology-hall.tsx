"use client";

// 独家特调 · 酒材页（在线材料）与配方页（在线配方）：
// 双列瀑布 / 宽卡列表 + 详情弹层（入柜·点赞·评论楼中楼）。官网专用，
// 未配后端（自部署）或表未建时按「还没开张」处理，不打扰本地玩法。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Heart, Inbox, Loader2, Pencil, Trash2, Wine, X } from "lucide-react";
import { fetchCurrentAccount } from "@/lib/account-client";
import {
    deleteHallComment,
    fetchHallComments,
    fetchHallMaterial,
    backfillHallThumb,
    fetchHallMaterials,
    fetchHallRecipe,
    fetchHallRecipes,
    markHallSaved,
    postHallComment,
    removeHallEntry,
    toggleHallLike,
    type MixHallComment,
    type MixHallMaterial,
    type MixHallRecipe,
    type MixHallRecipePart,
    type MixHallType,
} from "@/lib/mixology/hall-client";
import {
    clearMixPublishedByCloudId,
    findMixMaterialByPublishedId,
    findMixRecipeByPublishedId,
    getMixMaterial,
    listMixBuiltins,
    markMixMaterialSynced,
    markMixRecipeSynced,
    saveMixMaterial,
    saveMixRecipe,
} from "@/lib/mixology/storage";
import {
    MIX_KIND_LABELS,
    mixKindHasCover,
    type MixCharacterCard,
    type MixMaterial,
    type MixMaterialKind,
    type MixRecipe,
    mixKindRunsActiveCode,
    type MixCondition,
    type MixSlotEntry,
} from "@/lib/mixology/types";
import { AuthorAvatar, MatCard, MaterialDetail, MixConfirm, MixTagList, SealedNote } from "./mixology-shared";

type HallMode = "menu" | "hall";

function statsLine(entry: { likeCount: number; saveCount: number; commentCount: number }): string {
    return `♥ ${entry.likeCount} · 入柜 ${entry.saveCount} · 评论 ${entry.commentCount}`;
}

/**
 * 拍图管线版本：拍法变了（比如折叠区从摊开改为保持收起）就 +1。
 * 版本变化后，「我的发布」会把自己名下已有封面的存量条目也重拍一轮，
 * 否则旧管线拍的封面永远和酒柜的实时缩样对不上。哪些条目已按当前版本
 * 拍过记在 localStorage 里，避免每次进「我的发布」都重复拍。
 */
const THUMB_PIPELINE_VERSION = 4;
const THUMB_REDO_KEY = "mix-thumb-redone";

function loadThumbRedone(): Set<string> {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(THUMB_REDO_KEY) ?? "") as { v?: number; ids?: unknown };
        if (parsed?.v === THUMB_PIPELINE_VERSION && Array.isArray(parsed.ids)) return new Set(parsed.ids.map(String));
    } catch { /* 没存过或格式不对：当作全部没按当前版本拍过 */ }
    return new Set();
}

function saveThumbRedone(ids: Set<string>): void {
    try {
        window.localStorage.setItem(THUMB_REDO_KEY, JSON.stringify({ v: THUMB_PIPELINE_VERSION, ids: [...ids].slice(-500) }));
    } catch { /* 私隐模式等存不进就算了：重拍是幂等的，大不了下次再拍一遍 */ }
}


// ── 评论区（楼中楼） ──
// 酒材/配方详情用，也导出给酒柜详情用（本地材料带 publishedId / 导入件时能看同一条评论流）

export function CommentThread({
    type,
    targetId,
    myId,
    onToast,
    onCountChange,
    requestConfirm,
}: {
    type: MixHallType;
    targetId: string;
    myId: string;
    onToast: (message: string) => void;
    onCountChange: (delta: number) => void;
    requestConfirm: (payload: { title: string; body?: ReactNode; confirmText: string; tone?: "danger"; run: () => void }) => void;
}) {
    const [comments, setComments] = useState<MixHallComment[]>([]);
    const [loading, setLoading] = useState(true);
    const [input, setInput] = useState("");
    const [replyTo, setReplyTo] = useState<MixHallComment | null>(null);
    const [busy, setBusy] = useState(false);
    const [deletingIds, setDeletingIds] = useState<string[]>([]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchHallComments(type, targetId)
            .then((list) => { if (!cancelled) setComments(list); })
            .catch(() => { /* 评论加载失败不打断详情 */ })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [type, targetId]);

    const handlePost = async () => {
        const content = input.trim();
        if (!content || busy) return;
        setBusy(true);
        try {
            const comment = await postHallComment(type, targetId, content, replyTo?.id);
            setComments((prev) => [...prev, comment]);
            setInput("");
            setReplyTo(null);
            onCountChange(1);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "评论失败");
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (comment: MixHallComment) => {
        setDeletingIds((prev) => [...prev, comment.id]);
        try {
            const deletedIds = await deleteHallComment(comment.id);
            setComments((prev) => prev.filter((c) => !deletedIds.includes(c.id)));
            onCountChange(-deletedIds.length);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "删除失败");
        } finally {
            setDeletingIds((prev) => prev.filter((id) => id !== comment.id));
        }
    };

    const onConfirmDelete = (comment: MixHallComment) => {
        const hasReplies = comments.some((c) => c.parentId === comment.id);
        requestConfirm({
            title: "删除这条评论？",
            body: hasReplies ? <>它下面的回复会一起删掉。</> : undefined,
            confirmText: "删除",
            tone: "danger",
            run: () => void handleDelete(comment),
        });
    };

    const topLevel = comments.filter((c) => !c.parentId);
    const childrenOf = (id: string) => comments.filter((c) => c.parentId === id);
    const nameOf = (id?: string) => comments.find((c) => c.id === id)?.authorName;

    const renderComment = (comment: MixHallComment, depth: number) => {
        const deleting = deletingIds.includes(comment.id);
        return (
            <div className="mix-comment" data-depth={depth > 0 ? "1" : undefined} data-deleting={deleting ? "true" : undefined} key={comment.id}>
                <div className="mix-comment-head">
                    <span className="mix-comment-author">{comment.authorName}</span>
                    {depth > 0 && comment.parentId && nameOf(comment.parentId) ? (
                        <span className="mix-comment-replyto">回复 {nameOf(comment.parentId)}</span>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <button type="button" className="mix-comment-op" onClick={() => setReplyTo(comment)} disabled={deleting}>回复</button>
                    {comment.authorId === myId ? (
                        <button type="button" className="mix-comment-op" onClick={() => onConfirmDelete(comment)} disabled={deleting}>
                            {deleting ? <><Loader2 size={11} className="mix-spin" />删除中</> : "删除"}
                        </button>
                    ) : null}
                </div>
                <div className="mix-comment-content">{comment.content}</div>
                {childrenOf(comment.id).map((child) => renderComment(child, depth + 1))}
            </div>
        );
    };

    return (
        <div className="mix-comments">
            <div className="mix-detail-label" style={{ marginTop: 16 }}>评论{comments.length ? ` · ${comments.length}` : ""}</div>
            {loading ? (
                <div className="mix-comment-empty mix-loading-inline"><Loader2 size={14} className="mix-spin" />评论加载中…</div>
            ) : topLevel.length === 0 ? (
                <div className="mix-comment-empty">还没有人评论，坐下聊两句？</div>
            ) : (
                topLevel.map((comment) => renderComment(comment, 0))
            )}
            {replyTo ? (
                <div className="mix-comment-replying">
                    正在回复 {replyTo.authorName}
                    <button type="button" className="mix-comment-op" onClick={() => setReplyTo(null)}>取消</button>
                </div>
            ) : null}
            <div className="mix-comment-inputrow">
                <input
                    className="mix-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handlePost(); }}
                    placeholder={replyTo ? `回复 ${replyTo.authorName}…` : "说点什么…"}
                    disabled={busy}
                />
                <button type="button" className="mix-pill-btn" onClick={() => void handlePost()} disabled={busy || !input.trim()}>
                    {busy ? <><Loader2 size={13} className="mix-spin" />发送中</> : "发送"}
                </button>
            </div>
        </div>
    );
}

// ── 主组件 ──

export function MixologyHall({
    mode,
    kind = "character",
    scope = "all",
    onToast,
    onImported,
    reloadToken = 0,
    onLoadingChange,
    onEditLocal,
}: {
    mode: HallMode;
    /** 酒材页当前 TAG：由壳层的固定 TAG 行控制（menu 模式用） */
    kind?: MixMaterialKind;
    /** 大厅（全部）/ 我的发布：由头部的切换胶囊控制 */
    scope?: "all" | "mine";
    onToast: (message: string) => void;
    onImported: () => void;
    /** 父层的手动刷新令牌：数值变化即重新拉取 */
    reloadToken?: number;
    /** 拉取状态回报给父层（驱动头部刷新图标旋转） */
    onLoadingChange?: (loading: boolean) => void;
    /** 自己发布的作品点「编辑」：已拉回本地，请壳层跳到酒柜并打开这件的编辑页 */
    onEditLocal?: (materialId: string) => void;
}) {
    const [materials, setMaterials] = useState<MixHallMaterial[]>([]);
    const [recipes, setRecipes] = useState<MixHallRecipe[]>([]);
    const [loading, setLoading] = useState(true);
    const [notReady, setNotReady] = useState<string | null>(null);
    const [detailMaterial, setDetailMaterial] = useState<MixHallMaterial | null>(null);
    const [detailRecipe, setDetailRecipe] = useState<MixHallRecipe | null>(null);
    // 官方出厂件详情（本地直读，不走线上）
    const [officialDetail, setOfficialDetail] = useState<MixMaterial | null>(null);
    const [busy, setBusy] = useState(false);
    const [likePending, setLikePending] = useState<string[]>([]);
    const [myId, setMyId] = useState("");
    // 弹层宿主：.mix-body 是滚动容器（position:relative），弹层若留在其内部，
    // inset:0 锚的是滚动坐标系——列表滚动后弹窗会"不贴底"。portal 到应用根层。
    const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
    useEffect(() => { setOverlayHost(document.querySelector<HTMLElement>(".mixology-app")); }, []);
    const inOverlay = (node: ReactNode) => (overlayHost ? createPortal(node, overlayHost) : null);
    const [confirm, setConfirm] = useState<{
        title: string;
        body?: ReactNode;
        confirmText: string;
        tone?: "danger";
        run: () => void;
    } | null>(null);
    const mountedRef = useRef(true);
    // 已拉取列表的会话内缓存（key = mode:kind:scope）：切 TAG/范围来回逛不重复回源，
    // 点头部刷新（reloadToken 变化）或下架后整体作废
    const listCacheRef = useRef(new Map<string, { materials: MixHallMaterial[]; recipes: MixHallRecipe[]; notReady: string | null }>());
    const lastReloadRef = useRef(reloadToken);
    // 最新一次 load 的缓存键：快速切 TAG 时几个请求同时在飞，晚到的过期响应
    // 不许上屏（否则小票页会被后到的文风列表盖掉），只写进会话缓存留着切回去用
    const activeKeyRef = useRef("");

    useEffect(() => {
        mountedRef.current = true;
        void fetchCurrentAccount()
            .then((res) => { if (mountedRef.current && res.account) setMyId(res.account.id); })
            .catch(() => { /* 未登录/自部署：匿名浏览态 */ });
        return () => { mountedRef.current = false; };
    }, []);

    /**
     * 给自己发布的存量条目补封面。
     * 缩略图是后来才有的东西，之前上架的条目云端 cover 是空的，坐在大厅里
     * 永远等不到——而作者本地就有整份材料，进「我的发布」时顺手拍一张补上去。
     * 拍图管线升过版本后（THUMB_PIPELINE_VERSION），已有封面的条目也重拍一轮：
     * 旧管线拍的图（比如摊开折叠区那版）不重拍就永远和酒柜的实时缩样对不上。
     * 只补自己的、只补拍得出图的（小票/尾调且留了示例数据）；一个个来不并发，
     * 单个失败跳过，全程不打扰玩家。补完就地更新列表与会话缓存，不重新回源。
     */
    const backfillThumbs = useCallback(async (entries: MixHallMaterial[], cacheKey: string) => {
        const redone = loadThumbRedone();
        const pending = entries.filter((e) => (e.kind === "ticket" || e.kind === "encore") && (!e.cover || !redone.has(e.id)));
        if (!pending.length) return;
        const done = new Map<string, string>();
        let redoneChanged = false;
        for (const entry of pending) {
            const local = findMixMaterialByPublishedId(entry.id);
            if (!local) continue;
            try {
                const cover = await backfillHallThumb(entry.id, local);
                if (cover) {
                    done.set(entry.id, cover);
                    redone.add(entry.id);
                    redoneChanged = true;
                }
            } catch {
                // 补不上就算了：条目照旧显示图标，下次进来再试
            }
            if (!mountedRef.current) return;
        }
        if (redoneChanged) saveThumbRedone(redone);
        if (!done.size || !mountedRef.current) return;
        const patch = (list: MixHallMaterial[]) =>
            list.map((e) => (done.has(e.id) ? { ...e, cover: done.get(e.id) as string } : e));
        setMaterials(patch);
        const cached = listCacheRef.current.get(cacheKey);
        if (cached) listCacheRef.current.set(cacheKey, { ...cached, materials: patch(cached.materials) });
    }, []);

    const load = useCallback(async () => {
        if (lastReloadRef.current !== reloadToken) {
            listCacheRef.current.clear();
            lastReloadRef.current = reloadToken;
        }
        const cacheKey = `${mode}:${kind}:${scope}`;
        // 键里带上刷新令牌：点过头部刷新后，刷新前发出的同名请求也算过期
        const loadKey = `${reloadToken}:${cacheKey}`;
        activeKeyRef.current = loadKey;
        // 这次请求回来时还是不是当前画面：卸载了不算，用户已切走/刷新过也不算
        const fresh = () => mountedRef.current && activeKeyRef.current === loadKey;
        const cached = listCacheRef.current.get(cacheKey);
        if (cached) {
            setMaterials(cached.materials);
            setRecipes(cached.recipes);
            setNotReady(cached.notReady);
            setLoading(false);
            return;
        }
        setLoading(true);
        setNotReady(null);
        try {
            if (mode === "menu") {
                const { entries, setupRequired } = await fetchHallMaterials(kind, scope === "mine");
                const notReadyText = setupRequired ? "酒材页的后厨还没开张（共享表未创建）。" : null;
                // 过期响应也进会话缓存（切回那个 TAG 能秒开）；头部刷新清过缓存的话不回填旧数据
                if (lastReloadRef.current === reloadToken) {
                    listCacheRef.current.set(cacheKey, { materials: entries, recipes: [], notReady: notReadyText });
                    if (scope === "mine") void backfillThumbs(entries, cacheKey);
                }
                if (!fresh()) return;
                setMaterials(entries);
                if (notReadyText) setNotReady(notReadyText);
            } else {
                const { entries, setupRequired } = await fetchHallRecipes(scope === "mine");
                const notReadyText = setupRequired ? "配方页还没开张（共享表未创建）。" : null;
                if (lastReloadRef.current === reloadToken) {
                    listCacheRef.current.set(cacheKey, { materials: [], recipes: entries, notReady: notReadyText });
                }
                if (!fresh()) return;
                setRecipes(entries);
                if (notReadyText) setNotReady(notReadyText);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "暂时连不上后厨。";
            const permanent = /missing_supabase_env/.test(message);
            const text = permanent ? "酒材页和配方页只在官网营业——本地部署没有联网后端。" : message;
            // 未配后端是会话内永久状态：缓存住，自部署环境切 TAG 不反复空打；
            // 瞬时网络错误不缓存，下次切换自动重试
            if (permanent && lastReloadRef.current === reloadToken) {
                listCacheRef.current.set(cacheKey, { materials: [], recipes: [], notReady: text });
            }
            if (!fresh()) return;
            setNotReady(text);
        } finally {
            if (fresh()) setLoading(false);
        }
    // reloadToken 只作触发器，值本身不参与请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, kind, scope, reloadToken]);

    useEffect(() => { void load(); }, [load]);

    useEffect(() => { onLoadingChange?.(loading); }, [loading, onLoadingChange]);

    const patchEntry = (type: MixHallType, id: string, patch: Record<string, unknown>) => {
        if (type === "material") {
            setMaterials((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
            setDetailMaterial((prev) => (prev?.id === id ? { ...prev, ...patch } as MixHallMaterial : prev));
        } else {
            setRecipes((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
            setDetailRecipe((prev) => (prev?.id === id ? { ...prev, ...patch } as MixHallRecipe : prev));
        }
        // 写穿会话缓存：点赞/入柜/评论数的变化在切 TAG 回来后不回退
        for (const cached of listCacheRef.current.values()) {
            if (type === "material") cached.materials = cached.materials.map((e) => (e.id === id ? { ...e, ...patch } as MixHallMaterial : e));
            else cached.recipes = cached.recipes.map((e) => (e.id === id ? { ...e, ...patch } as MixHallRecipe : e));
        }
    };

    const handleLike = async (type: MixHallType, id: string) => {
        const key = `${type}:${id}`;
        if (likePending.includes(key)) return;
        setLikePending((prev) => [...prev, key]);
        try {
            const { liked, likeCount } = await toggleHallLike(type, id);
            patchEntry(type, id, { likedByMe: liked, likeCount });
        } catch (error) {
            onToast(error instanceof Error ? error.message : "点赞失败");
        } finally {
            setLikePending((prev) => prev.filter((k) => k !== key));
        }
    };

    const openMaterial = async (entry: MixHallMaterial) => {
        setDetailMaterial({ ...entry, payload: undefined });
        try {
            const full = await fetchHallMaterial(entry.id);
            setDetailMaterial((prev) => (prev?.id === entry.id ? full : prev));
        } catch (error) {
            setDetailMaterial(null);
            onToast(error instanceof Error ? error.message : "详情加载失败");
        }
    };

    const openRecipe = async (entry: MixHallRecipe) => {
        setDetailRecipe({ ...entry, parts: undefined });
        try {
            const full = await fetchHallRecipe(entry.id);
            setDetailRecipe((prev) => (prev?.id === entry.id ? full : prev));
        } catch (error) {
            setDetailRecipe(null);
            onToast(error instanceof Error ? error.message : "详情加载失败");
        }
    };

    /**
     * 把自己发布的材料拉回本地。
     * 关键在于「拉回来的是自己的作品，不是别人的复制品」：不打 imported、
     * 重新接上 publishedId，于是编辑/导出/更新上架这套按钮全部照常可用，
     * 改完点更新会覆盖回同一条云端条目，而不是另发一条。
     * 返回本地件 id，供调用方接着打开编辑器。
     */
    const pullBackMaterial = (entry: MixHallMaterial): string | null => {
        const payload = entry.payload as MixMaterial | null | undefined;
        if (!payload) return null;
        // 柜里已经有关联着这条云端条目的原件：用那一件，别拉出第二份同名材料
        const linked = findMixMaterialByPublishedId(entry.id);
        if (linked) return linked.id;
        // 否则按云端条目 id 落地。用条目 id 而不是新的本地 id，是为了让这一步可重复：
        // 早先被当成「别人的作品」入柜的那份（imported，id 即条目 id）会被就地修正，
        // 引用了这个 id 的配方也不会因此断链。
        const { publishedId: _p, publishedAt: _a, author: _au, authorAvatar: _av, imported: _i, ...rest } = payload;
        saveMixMaterial({ ...rest, id: entry.id } as MixMaterial);
        // saveMixMaterial 会重打 updatedAt，这里再把 publishedAt 对齐，
        // 否则刚拉回来就显示「有未上架修改」
        markMixMaterialSynced(entry.id, entry.id);
        return entry.id;
    };

    const importMaterial = async (entry: MixHallMaterial) => {
        if (!entry.payload || busy) return;
        // 自己发布的：走拉回，不走入柜——入柜会把它变成别人的作品，从此不能编辑
        if (myId && entry.authorId === myId) {
            const localId = pullBackMaterial(entry);
            if (!localId) return;
            onImported();
            onToast(`「${entry.name}」已回到酒柜，可以直接编辑。`);
            return;
        }
        setBusy(true);
        try {
            const { saveCount } = await markHallSaved("material", entry.id);
            const { publishedId: _p, publishedAt: _a, ...rest } = entry.payload as MixMaterial;
            const material = { ...rest, id: entry.id, author: entry.authorName, authorAvatar: entry.authorAvatar || undefined, imported: true } as MixMaterial;
            saveMixMaterial(material);
            patchEntry("material", entry.id, { savedByMe: true, saveCount });
            onImported();
            onToast(`「${entry.name}」已入柜。`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "入柜失败");
        } finally {
            setBusy(false);
        }
    };

    /** 「编辑」：先把自己的作品拉回本地，再让壳层跳到酒柜的编辑页 */
    const editOwnMaterial = async (entry: MixHallMaterial) => {
        if (busy) return;
        setBusy(true);
        try {
            // 列表项没有 payload，详情才有；点进来的是详情，但补一道保险
            const full = entry.payload ? entry : await fetchHallMaterial(entry.id);
            const localId = pullBackMaterial(full);
            if (!localId) { onToast("这件材料的内容没能取回来。"); return; }
            onImported();
            setDetailMaterial(null);
            onEditLocal?.(localId);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "取回失败");
        } finally {
            setBusy(false);
        }
    };

    /** 连料入柜：云端件按酒材条目 id 存柜（与酒材页入柜同一身份），官方件直接用本地出厂版，下架件跳过 */
    const importRecipe = async (entry: MixHallRecipe) => {
        if (!entry.parts?.length || busy) return;
        const characterPart = entry.parts.find((p) => p.kind === "character");
        if (!characterPart || characterPart.gone || (!characterPart.builtin && !characterPart.material)) {
            onToast("角色卡已从酒材页下架，这杯配方没法入柜。");
            return;
        }
        // 自己发布的配方拉回来，同样要还原成「自己的作品」，否则删了本地就再也改不了
        const mine = Boolean(myId) && entry.authorId === myId;
        setBusy(true);
        try {
            const { saveCount } = mine ? { saveCount: entry.saveCount } : await markHallSaved("recipe", entry.id);
            const slots: Partial<Record<MixMaterialKind, MixSlotEntry[]>> = {};
            // 一格可能叠了多件，按线上顺序依次落格；作者设的生效条件跟着一起带过来
            const pushSlot = (kind: MixMaterialKind, materialId: string, when?: MixCondition) => {
                const list = slots[kind] ?? [];
                list.push(when ? { materialId, when } : { materialId });
                slots[kind] = list;
            };
            let missing = 0;
            for (const part of entry.parts) {
                if (!part || !part.kind || !MIX_KIND_LABELS[part.kind]) continue;
                if (part.builtin) {
                    // 官方出厂件人人本地都有，直接指过去
                    pushSlot(part.kind, part.id, part.when);
                    continue;
                }
                if (part.gone || !part.material || typeof part.material !== "object") {
                    missing += 1;
                    continue;
                }
                // 这一味在柜里已经是「我自己的作品」（本人发布后拉回来的，或本来就是我写的）：
                // 保留原件，不要用一份 imported 的副本盖掉——那等于把自己的材料变成别人的
                const localSame = findMixMaterialByPublishedId(part.id) ?? getMixMaterial(part.id);
                if (localSame && !localSame.imported) {
                    pushSlot(part.kind, localSame.id, part.when);
                    continue;
                }
                const { publishedId: _p, publishedAt: _a, ...clean } = part.material;
                saveMixMaterial({ ...clean, id: part.id, kind: part.kind, author: part.authorName || entry.authorName, authorAvatar: part.authorAvatar || undefined, imported: true } as MixMaterial);
                pushSlot(part.kind, part.id, part.when);
                // 给这味酒材也记一次入柜（材料作者拿到数据）；失败不打断整杯导入
                void markHallSaved("material", part.id).catch(() => { /* 尽力而为 */ });
            }
            // 柜里已经有关联着这条云端条目的原件时就覆盖它，别拉出第二杯同名配方
            const linked = mine ? findMixRecipeByPublishedId(entry.id) : null;
            const recipe: MixRecipe = {
                id: linked?.id ?? entry.id,
                name: entry.name,
                slots,
                createdAt: linked?.createdAt ?? Date.now(),
                updatedAt: Date.now(),
                ...(mine ? {} : { author: entry.authorName, authorAvatar: entry.authorAvatar || undefined, imported: true }),
            };
            saveMixRecipe(recipe);
            // 自己的配方：接回云端关联，改完能直接更新同一条，而不是另发一条
            if (mine) markMixRecipeSynced(recipe.id, entry.id);
            patchEntry("recipe", entry.id, mine ? {} : { savedByMe: true, saveCount });
            onImported();
            onToast(missing > 0
                ? `「${entry.name}」已${mine ? "回到吧台" : "入柜"}，但 ${missing} 味材料已下架，这杯会缺味。`
                : mine
                    ? `「${entry.name}」已回到吧台，可以直接改。`
                    : `「${entry.name}」已连料入柜，去吧台看看。`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "导入失败");
        } finally {
            setBusy(false);
        }
    };

    const handleRemove = async (type: MixHallType, id: string, name: string) => {
        if (busy) return;
        setBusy(true);
        onToast("正在下架…");
        try {
            await removeHallEntry(type, id);
            if (type === "material") {
                setMaterials((prev) => prev.filter((e) => e.id !== id));
                setDetailMaterial(null);
            } else {
                setRecipes((prev) => prev.filter((e) => e.id !== id));
                setDetailRecipe(null);
            }
            // 同步本地记账：清掉对应本地件的发布关联，「已上架」徽章立刻消失
            clearMixPublishedByCloudId(type, id);
            // 下架改变了列表内容，会话缓存整体作废
            listCacheRef.current.clear();
            onImported();
            onToast(`「${name}」已下架。`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "下架失败");
        } finally {
            setBusy(false);
        }
    };

    const likeButton = (type: MixHallType, entry: { id: string; likedByMe?: boolean; likeCount: number }) => (
        <button
            type="button"
            className="mix-like-btn"
            data-on={entry.likedByMe ? "true" : undefined}
            data-pending={likePending.includes(`${type}:${entry.id}`) ? "true" : undefined}
            onClick={() => void handleLike(type, entry.id)}
            disabled={likePending.includes(`${type}:${entry.id}`)}
            aria-label="点赞"
        >
            <Heart size={15} fill={entry.likedByMe ? "currentColor" : "none"} />
            {entry.likeCount}
        </button>
    );

    // ── 渲染 ──

    function renderBody() {
        if (loading) {
            return (
                <div className="mix-empty" style={{ paddingTop: 60 }}>
                    <Loader2 size={28} strokeWidth={1.6} className="mix-spin" />
                    调酒师正在开灯…
                </div>
            );
        }
        // 官方出厂件：置顶在酒材页对应 TAG 下（本地直读，未开张/自部署也能看）
        const official = mode === "menu" && scope === "all" ? listMixBuiltins(kind) : [];
        const officialCards = official.map((m) => (
            <MatCard
                kind={m.kind}
                name={m.name}
                hook={m.hook}
                tags={m.tags}
                cover={mixKindHasCover(m.kind) ? m.cover : undefined}
                badge="官方"
                onClick={() => setOfficialDetail(m)}
                key={m.id}
            />
        ));
        if (notReady) {
            return (
                <>
                    {official.length > 0 ? (
                        <div className={mixKindHasCover(kind) ? "mix-waterfall" : "mix-mat-list"}>{officialCards}</div>
                    ) : null}
                    <div className="mix-empty" style={{ paddingTop: official.length > 0 ? 24 : 60 }}>
                        <Wine size={36} strokeWidth={1.4} />
                        {notReady}
                        <br />
                        本地的吧台和酒柜不受影响，先自己调一杯。
                    </div>
                </>
            );
        }
        if (mode === "menu") {
            if (materials.length === 0 && official.length === 0) {
                return (
                    <div className="mix-empty">
                        <Inbox size={32} strokeWidth={1.4} />
                        {scope === "mine" ? `你还没发布过${MIX_KIND_LABELS[kind]}——` : `还没有人分享${MIX_KIND_LABELS[kind]}——`}
                        <br />
                        在酒柜里打开自己的材料，点「分享到酒材页」。
                    </div>
                );
            }
            return (
                <div className={mixKindHasCover(kind) ? "mix-waterfall" : "mix-mat-list"}>
                    {officialCards}
                    {materials.map((entry) => (
                        <MatCard
                            kind={entry.kind}
                            name={entry.name}
                            hook={entry.hook}
                            tags={entry.tags}
                            // 云端老条目可能还存着换制前上传的封面，非角色卡一律不认
                            cover={mixKindHasCover(entry.kind) ? entry.cover : undefined}
                            author={entry.authorName}
                            stats={statsLine(entry)}
                            onClick={() => void openMaterial(entry)}
                            key={entry.id}
                        />
                    ))}
                </div>
            );
        }
        if (recipes.length === 0) {
            return (
                <div className="mix-empty" style={{ paddingTop: 60 }}>
                    <Wine size={32} strokeWidth={1.4} />
                    {scope === "mine" ? "你还没分享过配方——" : "还没有人分享配方——"}
                    <br />
                    在吧台给自己的特调点「分享」。
                </div>
            );
        }
        return (
            <div style={{ paddingTop: 14 }}>
                {recipes.map((entry) => (
                    <div className="mix-recipe-card" key={entry.id} onClick={() => void openRecipe(entry)}>
                        {entry.cover ? <div className="mix-recipe-bg" style={{ backgroundImage: `url(${entry.cover})` }} /> : null}
                        <div className="mix-recipe-main">
                            <div className="mix-recipe-name">{entry.name}</div>
                            <div className="mix-recipe-parts">
                                {entry.charName || "特调"}
                                {entry.partNames.length ? ` · ${entry.partNames.join(" · ")}` : ""}
                            </div>
                            <div className="mix-mat-stats">
                                @{entry.authorName} · {statsLine(entry)} · 浏览 {entry.viewCount}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <>
            {renderBody()}

            {/* 官方出厂件详情：本地内容，无点赞/评论/入柜——吧台槽位里直接可选 */}
            {officialDetail ? inOverlay(
                <div className="mix-sheet-mask" onClick={() => setOfficialDetail(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">
                                {officialDetail.name}
                                <span className="mix-mat-badge" style={{ marginLeft: 6 }}>官方</span>
                            </div>
                            <button type="button" className="mix-icon-btn" onClick={() => setOfficialDetail(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-mat-stats" style={{ marginTop: 2 }}>
                                {MIX_KIND_LABELS[officialDetail.kind]} · 官方出厂件 · 吧台槽位里直接可选，无需入柜
                            </div>
                            <div style={{ marginTop: 8 }}>
                                <MixTagList tags={officialDetail.tags} />
                                <MaterialDetail material={officialDetail} />
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 材料详情 */}
            {detailMaterial ? inOverlay(
                <div className="mix-sheet-mask" onClick={() => setDetailMaterial(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        {detailMaterial.kind === "character" && detailMaterial.cover ? (
                            <div className="mix-sheet-backdrop" style={{ backgroundImage: `url(${detailMaterial.cover})` }} />
                        ) : null}
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{detailMaterial.name}</div>
                            {likeButton("material", detailMaterial)}
                            {/* 自己发布的：随时能改。本地那份删了也不要紧，点这里会先取回来再进编辑页 */}
                            {detailMaterial.authorId === myId ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => { void editOwnMaterial(detailMaterial); }}
                                    disabled={busy}
                                    aria-label="编辑"
                                    title="取回本地并编辑"
                                >
                                    <Pencil size={16} />
                                </button>
                            ) : null}
                            {detailMaterial.authorId === myId ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "从酒材页下架？",
                                        body: <>「{detailMaterial.name}」将从酒材页撤下，别人看不到也拿不到了。<br />已经入柜的人手里那份不受影响。</>,
                                        confirmText: "下架",
                                        tone: "danger",
                                        run: () => void handleRemove("material", detailMaterial.id, detailMaterial.name),
                                    })}
                                    aria-label="下架"
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetailMaterial(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-author-row" style={{ marginTop: 4 }}>
                                <AuthorAvatar name={detailMaterial.authorName} avatar={detailMaterial.authorAvatar} />
                                <span className="mix-author-name">@{detailMaterial.authorName}</span>
                                <span className="mix-mat-stats">{MIX_KIND_LABELS[detailMaterial.kind]} · 浏览 {detailMaterial.viewCount} · 评论 {detailMaterial.commentCount}</span>
                            </div>
                            {detailMaterial.payload ? (
                                <>
                                    <div style={{ marginTop: 8 }}>
                                        <MixTagList tags={detailMaterial.tags} />
                                        {detailMaterial.kind === "character"
                                            ? <SealedNote
                                                hook={detailMaterial.hook}
                                                canvas={(detailMaterial.payload as MixCharacterCard).canvas}
                                                charName={(detailMaterial.payload as MixCharacterCard).charName}
                                            />
                                            : <MaterialDetail material={detailMaterial.payload} />}
                                    </div>
                                    <button
                                        type="button"
                                        className="mix-brew-btn"
                                        onClick={() => {
                                            // 自己写的机括不用再警告自己一遍
                                            if (!mixKindRunsActiveCode(detailMaterial.kind) || detailMaterial.authorId === myId) {
                                                void importMaterial(detailMaterial);
                                                return;
                                            }
                                            // 机括会在你的对局里按轮执行——入柜前得让人知道自己在装什么
                                            const trusted = detailMaterial.kind === "mechanism" && (detailMaterial.payload as { trusted?: boolean }).trusted === true;
                                            setConfirm({
                                                title: trusted ? "这件机括是信任模式，会直接在页面里运行" : "这件机括会执行代码",
                                                body: trusted ? (
                                                    <>「{detailMaterial.name}」的代码<b>不进沙盒，直接在你的对局页面里运行</b>：它能画进正文、能自己联网，也能读写这台小手机上的数据。<br />这和安装聊天插件是同一级别的信任。只在你信任作者时入柜。</>
                                                ) : (
                                                    <>「{detailMaterial.name}」带的是<b>会在你的对局里按轮执行的代码</b>：它能改写你发出去的话、改写你看到的正文、以你的身份发言。<br />代码跑在没有网络、碰不到应用本体的沙盒里，但对话内容它看得到。<br />只在你信任作者时入柜。</>
                                                ),
                                                confirmText: "我知道，入柜",
                                                run: () => void importMaterial(detailMaterial),
                                            });
                                        }}
                                        disabled={busy}
                                    >
                                        {busy ? <Loader2 size={16} className="mix-spin" /> : <CornerDownRight size={16} />}
                                        {busy
                                            ? "处理中…"
                                            : detailMaterial.authorId === myId
                                                ? "取回酒柜"
                                                : detailMaterial.savedByMe ? "再次入柜" : "加入酒柜"}
                                    </button>
                                </>
                            ) : (
                                <div className="mix-comment-empty mix-loading-inline"><Loader2 size={14} className="mix-spin" />细节加载中…</div>
                            )}
                            <CommentThread
                                type="material"
                                targetId={detailMaterial.id}
                                myId={myId}
                                onToast={onToast}
                                onCountChange={(delta) => patchEntry("material", detailMaterial.id, { commentCount: Math.max(0, detailMaterial.commentCount + delta) })}
                                requestConfirm={setConfirm}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 配方详情 */}
            {detailRecipe ? inOverlay(
                <div className="mix-sheet-mask" onClick={() => setDetailRecipe(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{detailRecipe.name}</div>
                            {likeButton("recipe", detailRecipe)}
                            {detailRecipe.authorId === myId ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "从配方页下架？",
                                        body: <>「{detailRecipe.name}」将从配方页撤下，别人看不到也导不了了。<br />已经导入的人手里那份不受影响。</>,
                                        confirmText: "下架",
                                        tone: "danger",
                                        run: () => void handleRemove("recipe", detailRecipe.id, detailRecipe.name),
                                    })}
                                    aria-label="下架"
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetailRecipe(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-author-row" style={{ marginTop: 4 }}>
                                <AuthorAvatar name={detailRecipe.authorName} avatar={detailRecipe.authorAvatar} />
                                <span className="mix-author-name">@{detailRecipe.authorName}</span>
                                <span className="mix-mat-stats">浏览 {detailRecipe.viewCount} · 评论 {detailRecipe.commentCount}</span>
                            </div>
                            {detailRecipe.intro ? <div className="mix-detail-value" style={{ marginTop: 10 }}>{detailRecipe.intro}</div> : null}
                            {detailRecipe.parts ? (() => {
                                const parts = detailRecipe.parts.filter((p): p is MixHallRecipePart => Boolean(p) && Boolean(p.kind) && Boolean(MIX_KIND_LABELS[p.kind]));
                                const goneCount = parts.filter((p) => p.gone).length;
                                const characterPart = parts.find((p) => p.kind === "character");
                                const characterOk = Boolean(characterPart && !characterPart.gone && (characterPart.builtin || characterPart.material));
                                const importable = parts.length - goneCount;
                                // 配方里夹了几件机括：入柜确认要单独说清楚
                                const mechanismCount = parts.filter((p) => !p.gone && mixKindRunsActiveCode(p.kind)).length;
                                // 其中信任模式的机括不进沙盒，得单独点名
                                const trustedNames = parts
                                    .filter((p) => !p.gone && p.kind === "mechanism" && (p.material as { trusted?: boolean } | null | undefined)?.trusted === true)
                                    .map((p) => p.name);
                                return (
                                    <>
                                        <div className="mix-detail-label" style={{ marginTop: 12 }}>这杯里有</div>
                                        <div className="mix-detail-value">
                                            {parts
                                                .map((p) => `${MIX_KIND_LABELS[p.kind]} · ${p.name}${p.builtin ? "（官方件）" : p.gone ? "（已下架）" : p.authorName ? `（@${p.authorName}）` : ""}`)
                                                .join("\n")}
                                        </div>
                                        <button
                                            type="button"
                                            className="mix-brew-btn"
                                            onClick={() => setConfirm({
                                                title: trustedNames.length > 0 ? "这杯里有信任模式的机括" : "连料入柜？",
                                                body: <>
                                                    会把「{detailRecipe.name}」以及里面的 <b>{importable} 味材料</b>一并放进你的酒柜（官方件直接用本地出厂版），之后在吧台就能开局。
                                                    {goneCount > 0 ? <><br />{goneCount} 味材料已从酒材页下架，这杯会缺味。</> : null}
                                                    {trustedNames.length > 0 ? (
                                                        <><br /><br />{trustedNames.map((n) => `「${n}」`).join("、")}是<b>信任模式的机括，不进沙盒，直接在你的对局页面里运行</b>：它能画进正文、能自己联网，也能读写这台小手机上的数据。这和安装聊天插件是同一级别的信任。</>
                                                    ) : null}
                                                    {mechanismCount > trustedNames.length ? (
                                                        <><br /><br />{trustedNames.length > 0 ? "另有" : "其中"} <b>{mechanismCount - trustedNames.length} 件是机括</b>：会在你的对局里按轮执行代码，能改写你发出去的话、你看到的正文，也能以你的身份发言。代码跑在没有网络、碰不到应用本体的沙盒里。</>
                                                    ) : null}
                                                    {mechanismCount > 0 ? <><br />只在你信任作者时入柜。</> : null}
                                                </>,
                                                confirmText: mechanismCount > 0 ? "我知道，入柜" : "入柜",
                                                run: () => void importRecipe(detailRecipe),
                                            })}
                                            disabled={busy || !characterOk}
                                        >
                                            {busy ? <Loader2 size={16} className="mix-spin" /> : <CornerDownRight size={16} />}
                                            {busy ? "处理中…" : !characterOk ? "角色卡已下架，无法入柜" : detailRecipe.savedByMe ? "再次导入" : "连料入柜"}
                                        </button>
                                    </>
                                );
                            })() : (
                                <div className="mix-comment-empty mix-loading-inline"><Loader2 size={14} className="mix-spin" />细节加载中…</div>
                            )}
                            <CommentThread
                                type="recipe"
                                targetId={detailRecipe.id}
                                myId={myId}
                                onToast={onToast}
                                onCountChange={(delta) => patchEntry("recipe", detailRecipe.id, { commentCount: Math.max(0, detailRecipe.commentCount + delta) })}
                                requestConfirm={setConfirm}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {confirm ? inOverlay(
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}
        </>
    );
}
