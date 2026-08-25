"use client";

// 独家特调 · App 主壳：酒材/配方（官网在线共享页）/ 吧台（单槽轮盘调配）/
// 酒柜（十类材料 TAG + 瀑布与列表）/ 对局（酒局记录）。
// 视觉：近黑 + 紫罗兰 + 琥珀金的暗色酒吧质感，见 styles/mixology.css。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    Archive,
    ChevronLeft,
    Copy,
    Download,
    GlassWater,
    ImageDown,
    Martini,
    MoreHorizontal,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    Share2,
    SlidersHorizontal,
    Trash2,
    Upload,
    Users,
    Wine,
    X,
} from "lucide-react";
import {
    clearMixMaterialPublished,
    clearMixRecipePublished,
    deleteMixMaterial,
    deleteMixRecipe,
    deleteMixSession,
    getMixBuiltin,
    getMixMaterial,
    isMixBuiltinId,
    listMixPickables,
    MIX_CABINET_UPDATED_EVENT,
    loadMixCabinet,
    loadMixProfile,
    loadMixRecipes,
    loadMixSessions,
    markMixMaterialSynced,
    markMixRecipeSynced,
    saveMixMaterial,
    saveMixProfile,
    saveMixRecipe,
    type MixProfile,
} from "@/lib/mixology/storage";
import { runMixSessionStart, startMixSession } from "@/lib/mixology/engine";
import { disposeMixSandboxesForMaterial } from "@/lib/mixology/mechanism-runtime";
import { mixKindRunsActiveCode } from "@/lib/mixology/types";
import {
    createMixId,
    MIX_KIND_LABELS,
    MIX_KIND_SECTION_LABELS,
    MIX_SLOT_ORDER,
    mixCloudState,
    mixKindHasCover,
    type MixCharacterCard,
    type MixMaterial,
    type MixMaterialKind,
    type MixRecipe,
    type MixSession,
    mixSlotEntries,
    mixSlotFirstId,
    type MixSlotEntry,
} from "@/lib/mixology/types";
import { fetchCurrentAccount } from "@/lib/account-client";
import { MixHallGoneError, shareHallMaterial, shareHallRecipe, updateHallMaterial, updateHallRecipe } from "@/lib/mixology/hall-client";
import { exportMixMaterial, exportMixMaterialPng, exportMixRecipeFile, importMixRecipePack, parseMixMaterialsFromJson, parseMixMaterialsFromPng, parseMixRecipeFile } from "@/lib/mixology/transfer";
import { MixMaterialEditor } from "./mixology-editor";
import { MixMatAutoCover, mixMatHasAutoCover } from "./mixology-preview";
import { MixologyGame } from "./mixology-game";
import { CommentThread, MixologyHall } from "./mixology-hall";
import { AuthorAvatar, KindGlyph, MatCard, MaterialDetail, MixConfirm, MixTagList, SealedNote, formatMixTime } from "./mixology-shared";
import { MixSlotEditor } from "./slot-editor";
import { describeMixCondition } from "@/lib/mixology/state";

/** 头像统一压成 192px JPEG dataURL 的小圆图，随发布上云也不占地方 */
async function readAvatarFile(file: File): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("图片解码失败"));
        el.src = dataUrl;
    });
    const size = 192;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const scale = Math.max(size / img.width, size / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    canvas.getContext("2d")?.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
}

type MixTab = "menu" | "hall" | "bar" | "cabinet" | "games";

// ── 主组件 ──

export function MixologyApp({ onClose }: { onClose: () => void }) {
    const [tab, setTab] = useState<MixTab>("bar");
    const [cabinet, setCabinet] = useState<MixMaterial[]>(() => loadMixCabinet());
    const [recipes, setRecipes] = useState<MixRecipe[]>(() => loadMixRecipes());
    const [sessions, setSessions] = useState<MixSession[]>(() => loadMixSessions());
    const [cabinetKind, setCabinetKind] = useState<MixMaterialKind>("character");
    // 酒材/配方页手动刷新：令牌触发子组件重拉，loading 驱动头部图标旋转
    const [hallReload, setHallReload] = useState(0);
    const [hallLoading, setHallLoading] = useState(false);
    // 大厅（全部）/ 我的发布：头部刷新按钮左侧的滑动切换，两个在线页共用
    const [hallScope, setHallScope] = useState<"all" | "mine">("all");
    // 酒材页当前 TAG：状态在壳层，TAG 行渲染在滚动容器之外（真固定，不随橡皮筋回弹）
    const [hallKind, setHallKind] = useState<MixMaterialKind>("character");
    // 自己的账号 id：酒柜详情里的评论区用它判断"哪条评论可删"
    const [myId, setMyId] = useState("");
    // 创作者资料：发布到酒材/配方页时的署名与头像（酒柜头部可编辑）
    const [profile, setProfile] = useState<MixProfile>(() => loadMixProfile());
    const [profileOpen, setProfileOpen] = useState(false);
    const [profileName, setProfileName] = useState("");
    const [profileAvatar, setProfileAvatar] = useState("");
    const avatarFileRef = useRef<HTMLInputElement | null>(null);
    const [detail, setDetail] = useState<MixMaterial | null>(null);
    const [editor, setEditor] = useState<{ kind: MixMaterialKind; initial?: MixMaterial } | null>(null);
    const [barTab, setBarTab] = useState<"create" | "mine">("create");
    const [recipeMenu, setRecipeMenu] = useState<MixRecipe | null>(null);
    const [confirm, setConfirm] = useState<{
        title: string;
        body?: ReactNode;
        confirmText: string;
        tone?: "danger";
        run: () => void;
    } | null>(null);
    const [barSlots, setBarSlots] = useState<Partial<Record<MixMaterialKind, MixSlotEntry[]>>>({});
    /**
     * 吧台的"改搭配存回原杯"模式：装载导入配方时记下原杯，存杯直接覆写它
     * （保留 imported 标记与署名）。导入的配方内容动不了，但用哪件材料随便换。
     */
    const [barEditing, setBarEditing] = useState<MixRecipe | null>(null);
    const [slotPicker, setSlotPicker] = useState<MixMaterialKind | null>(null);
    const [slotEditor, setSlotEditor] = useState<MixMaterialKind | null>(null);
    const [nameSheetOpen, setNameSheetOpen] = useState(false);
    const [recipeName, setRecipeName] = useState("");
    const [openingPicker, setOpeningPicker] = useState<MixRecipe | null>(null);
    const [playing, setPlaying] = useState<string | null>(null);
    const [toast, setToast] = useState("");
    const [wheelIndex, setWheelIndex] = useState(0);
    const wheelRef = useRef<HTMLDivElement | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((message: string) => {
        setToast(message);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 2200);
    }, []);

    /** 常驻型 toast：上传这类要等一会儿的动作挂着不消失，结束时用定时 toast 顶掉 */
    const showStickyToast = useCallback((message: string) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = null;
        setToast(message);
    }, []);

    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

    useEffect(() => {
        let cancelled = false;
        void fetchCurrentAccount()
            .then((res) => { if (!cancelled && res.account) setMyId(res.account.id); })
            .catch(() => { /* 未登录/自部署：匿名浏览态 */ });
        return () => { cancelled = true; };
    }, []);

    const refresh = useCallback(() => {
        setCabinet(loadMixCabinet());
        setRecipes(loadMixRecipes());
        setSessions(loadMixSessions());
    }, []);

    // 小卷工具直写酒柜/配方后广播这个事件——不监听的话，App 开着时
    // 助手替用户建好的材料要等下一次自发操作才会出现在列表里
    useEffect(() => {
        const onExternalUpdate = () => refresh();
        window.addEventListener(MIX_CABINET_UPDATED_EVENT, onExternalUpdate);
        return () => window.removeEventListener(MIX_CABINET_UPDATED_EVENT, onExternalUpdate);
    }, [refresh]);

    /**
     * 从酒材页/大厅点「编辑」进来：那边已经把自己的作品取回本地了，
     * 这里负责切到酒柜、切到它所在的 TAG，并直接打开编辑页（仍带着云端关联）。
     */
    const openLocalEditor = useCallback((materialId: string) => {
        const material = getMixMaterial(materialId);
        if (!material) { showToast("没找到这件材料。"); return; }
        refresh();
        setTab("cabinet");
        setCabinetKind(material.kind);
        setEditor({ kind: material.kind, initial: material });
    }, [refresh, showToast]);

    const cabinetFiltered = useMemo(
        () => cabinet.filter((m) => m.kind === cabinetKind),
        [cabinet, cabinetKind],
    );

    /** 吧台每格已放的材料实体（一格可能叠了多件，按顺序取全） */
    const slotMaterials = useMemo(() => {
        const map: Partial<Record<MixMaterialKind, MixMaterial[]>> = {};
        for (const kind of MIX_SLOT_ORDER) {
            const list: MixMaterial[] = [];
            for (const entry of mixSlotEntries(barSlots, kind)) {
                const found = getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId) ?? null;
                if (found && found.kind === kind) list.push(found);
            }
            if (list.length) map[kind] = list;
        }
        return map;
    }, [barSlots, cabinet]);

    /** 本杯小票里勾了「记住」的项：变量条件的可选项就是这些 */
    const barVarNames = useMemo(() => {
        const names: string[] = [];
        for (const material of slotMaterials.ticket ?? []) {
            if (material.kind !== "ticket") continue;
            for (const item of material.vars ?? []) {
                const name = item.name.trim();
                if (name && !names.includes(name)) names.push(name);
            }
        }
        return names;
    }, [slotMaterials]);

    const handleWheelScroll = useCallback(() => {
        const el = wheelRef.current;
        if (!el) return;
        const center = el.scrollLeft + el.clientWidth / 2;
        let best = 0;
        let bestDist = Infinity;
        Array.from(el.children).forEach((child, i) => {
            const c = child as HTMLElement;
            const mid = c.offsetLeft + c.offsetWidth / 2;
            const dist = Math.abs(mid - center);
            if (dist < bestDist) { bestDist = dist; best = i; }
        });
        setWheelIndex(best);
    }, []);

    const handleBrew = () => {
        if (!mixSlotEntries(barSlots, "character").length) {
            showToast("先给第一槽挑一张角色卡。");
            return;
        }
        // 存回原杯模式：不弹起名，直接覆写被装载的那杯（imported 与署名原样保留）
        if (barEditing) {
            saveMixRecipe({ ...barEditing, slots: { ...barSlots }, updatedAt: Date.now() });
            setBarSlots({});
            setBarEditing(null);
            refresh();
            setBarTab("mine");
            showToast(`「${barEditing.name}」的搭配已更新。`);
            return;
        }
        const character = slotMaterials.character?.[0];
        setRecipeName(character ? `${character.name}特调` : "我的特调");
        setNameSheetOpen(true);
    };

    const handleSaveRecipe = () => {
        const name = recipeName.trim();
        if (!name) {
            showToast("给这杯特调起个名字。");
            return;
        }
        const recipe: MixRecipe = {
            id: createMixId("mixrec"),
            name,
            slots: { ...barSlots },
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        saveMixRecipe(recipe);
        setNameSheetOpen(false);
        setBarSlots({});
        refresh();
        setBarTab("mine");
        showToast(`「${name}」已入方案。`);
    };

    const handleStartRecipe = (recipe: MixRecipe) => {
        const characterId = mixSlotFirstId(recipe.slots, "character");
        const card = characterId ? getMixMaterial(characterId) : null;
        if (!card || card.kind !== "character") {
            showToast("这杯特调的角色卡已不在酒柜里。");
            return;
        }
        if (card.openings.length > 1) {
            setOpeningPicker(recipe);
            return;
        }
        startWithOpening(recipe, 0);
    };

    const startWithOpening = (recipe: MixRecipe, openingIndex: number) => {
        try {
            const session = startMixSession(recipe, { openingIndex });
            // 开局钩子在后台补一笔（初始化机括的存储与记住的值），不挡跳转
            void runMixSessionStart(session.id);
            setOpeningPicker(null);
            refresh();
            setPlaying(session.id);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "开局失败");
        }
    };

    const [sharing, setSharing] = useState(false);
    const importFileRef = useRef<HTMLInputElement | null>(null);
    const editorFileRef = useRef<HTMLInputElement | null>(null);
    // 换 key 强制重挂编辑器：表单各字段只在挂载时按 initial 初始化一次
    const [editorSeq, setEditorSeq] = useState(0);

    /**
     * 编辑器里的「上传替换」：用文件内容替掉表单，但身份与云端关联留在原件上——
     * id 不变，保存后覆盖同一条；已上架的那条也还认得它，点更新仍是覆盖而不是另发。
     */
    const handleEditorReplace = async (file: File | undefined) => {
        if (!file || !editor) return;
        try {
            const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
            const materials = isPng
                ? parseMixMaterialsFromPng(await file.arrayBuffer())
                : parseMixMaterialsFromJson(await file.text());
            // 一件都认不出时解析函数自己会抛错，所以走到这里 materials 一定非空
            const picked = materials.find((m) => m.kind === editor.kind);
            if (!picked) {
                const kinds = [...new Set(materials.map((m) => MIX_KIND_LABELS[m.kind]))];
                showToast(`这个文件里没有${MIX_KIND_LABELS[editor.kind]}，只有${kinds.join("、")}。`);
                return;
            }
            const keep = editor.initial;
            setEditor({
                kind: editor.kind,
                initial: keep
                    ? {
                        ...picked,
                        id: keep.id,
                        createdAt: keep.createdAt,
                        publishedId: keep.publishedId,
                        publishedAt: keep.publishedAt,
                        author: keep.author,
                        authorAvatar: keep.authorAvatar,
                    } as MixMaterial
                    : picked,
            });
            setEditorSeq((n) => n + 1);
            showToast(`表单已换成「${picked.name}」的内容，还没保存。`);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "读取失败");
        }
    };

    const handleImportFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            const isPng = file.type === "image/png" || /\.png$/i.test(file.name);
            if (!isPng) {
                // 配方文件（整杯打包）：配方与材料按他人作品落库——搭配可换、内容不可改、不能发布
                const pack = parseMixRecipeFile(await file.text());
                if (pack) {
                    showToast(importMixRecipePack(pack));
                    refresh();
                    return;
                }
            }
            const materials = isPng
                ? parseMixMaterialsFromPng(await file.arrayBuffer())
                : parseMixMaterialsFromJson(await file.text());
            materials.forEach(saveMixMaterial);
            refresh();
            showToast(materials.length > 1 ? `已导入 ${materials.length} 件材料。` : `「${materials[0].name}」已入柜。`);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "导入失败");
        }
    };

    const handleShareMaterial = async (material: MixMaterial) => {
        if (sharing) return;
        setSharing(true);
        showStickyToast(`「${material.name}」上传中…`);
        try {
            if (material.publishedId) {
                await updateHallMaterial(material.publishedId, material);
                markMixMaterialSynced(material.id, material.publishedId);
                refresh();
                showToast(`酒材页上的「${material.name}」已更新。`);
            } else {
                const entry = await shareHallMaterial(material);
                // 记住线上身份，之后改了本地就能推更新，也不会重复发布出一堆同名卡
                markMixMaterialSynced(material.id, entry.id);
                refresh();
                showToast(`「${material.name}」已分享到酒材页。`);
            }
        } catch (error) {
            if (error instanceof MixHallGoneError) {
                clearMixMaterialPublished(material.id);
                refresh();
                showToast("它已经从酒材页下架了，可以重新分享一次。");
            } else {
                showToast(error instanceof Error ? error.message : "分享失败");
            }
        } finally {
            setSharing(false);
        }
    };

    /**
     * 配方分享计划：配方线上只存"槽位引用"，材料各自以酒材页条目为身份。
     * - 官方出厂件：人人本地都有，builtin 引用，不上架；
     * - 从酒材页入柜的别人材料（id 就是线上 id）：直接引用；
     * - 自己的材料：没上架的要先上架（toPublish），改过没同步的要先推更新（toSync）；
     * - 旧版"随配方连料入柜"的材料线上没有条目，没法引用（blockers）。
     */
    const planShareRecipe = (recipe: MixRecipe) => {
        // 保留「条目 ↔ 材料」的配对：分享出去时顺序与生效条件都要跟着走
        const pairs = MIX_SLOT_ORDER
            .flatMap((k) => mixSlotEntries(recipe.slots, k)
                .map((entry) => {
                    const material = getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId) ?? null;
                    return material ? { entry, material } : null;
                }))
            .filter((pair): pair is { entry: MixSlotEntry; material: MixMaterial } => Boolean(pair));
        const materials = pairs.map((pair) => pair.material);
        const character = materials.find((m) => m.kind === "character");
        const own = materials.filter((m) => !isMixBuiltinId(m.id) && !m.imported);
        return {
            pairs,
            materials,
            character: character && character.kind === "character" ? character : null,
            toPublish: own.filter((m) => !m.publishedId),
            toSync: own.filter((m) => mixCloudState(m) === "dirty"),
            blockers: materials.filter((m) => m.imported && !m.id.startsWith("mxi_")),
        };
    };

    const handleShareRecipe = async (recipe: MixRecipe) => {
        if (sharing) return;
        const plan = planShareRecipe(recipe);
        if (!plan.character) {
            showToast("这杯特调缺角色卡，没法分享。");
            return;
        }
        setSharing(true);
        showStickyToast(`「${recipe.name}」上传中…`);
        try {
            // 第一步：把自己的材料推上云端——没上架的上架，改过的同步（云端丢失就重新上架）
            for (const material of plan.materials) {
                if (isMixBuiltinId(material.id) || material.imported) continue;
                if (!material.publishedId || mixCloudState(material) === "dirty") {
                    showStickyToast(`「${material.name}」上传中…`);
                }
                if (!material.publishedId) {
                    const entry = await shareHallMaterial(material);
                    markMixMaterialSynced(material.id, entry.id);
                } else if (mixCloudState(material) === "dirty") {
                    try {
                        await updateHallMaterial(material.publishedId, material);
                        markMixMaterialSynced(material.id, material.publishedId);
                    } catch (error) {
                        if (!(error instanceof MixHallGoneError)) throw error;
                        const entry = await shareHallMaterial(material);
                        markMixMaterialSynced(material.id, entry.id);
                    }
                }
            }
            // 第二步：拿到最新的 publishedId 映射，拼出引用数组
            const fresh = loadMixCabinet();
            // 顺序 = pairs 的顺序（按槽位、格内自上而下），生效条件随件带上
            const parts = plan.pairs.map(({ entry, material }) => {
                const when = entry.when;
                const base = isMixBuiltinId(material.id)
                    ? { id: material.id, kind: material.kind, name: material.name, builtin: true as const }
                    : material.imported
                        ? { id: material.id, kind: material.kind, name: material.name }
                        : { id: fresh.find((m) => m.id === material.id)?.publishedId ?? material.publishedId ?? material.id, kind: material.kind, name: material.name };
                return when ? { ...base, when } : base;
            });
            showStickyToast(`「${recipe.name}」配方上传中…`);
            const character = plan.character;
            const input = {
                name: recipe.name,
                cover: character.cover ?? "",
                charName: character.charName,
                partNames: plan.materials.filter((m) => m.kind !== "character").map((m) => m.name).slice(0, 8),
                parts,
            };
            if (recipe.publishedId) {
                await updateHallRecipe(recipe.publishedId, input);
                markMixRecipeSynced(recipe.id, recipe.publishedId);
                refresh();
                showToast(`配方页上的「${recipe.name}」已更新，材料已同步。`);
            } else {
                const entry = await shareHallRecipe(input);
                markMixRecipeSynced(recipe.id, entry.id);
                refresh();
                showToast(`「${recipe.name}」已分享到配方页。`);
            }
        } catch (error) {
            if (error instanceof MixHallGoneError) {
                clearMixRecipePublished(recipe.id);
                refresh();
                showToast("它已经从配方页下架了，可以重新分享一次。");
            } else {
                refresh(); // 材料可能已部分上架成功，把徽章刷出来
                showToast(error instanceof Error ? error.message : "分享失败");
            }
        } finally {
            setSharing(false);
        }
    };

    const handleDeleteMaterial = (material: MixMaterial) => {
        if (!deleteMixMaterial(material.id)) {
            showToast("官方出厂件不能删除。");
            return;
        }
        setDetail(null);
        refresh();
        showToast(`「${material.name}」已移出酒柜。`);
    };

    // ── 对局画面全屏接管 ──
    if (playing) {
        return (
            <div className="mixology-app">
                <MixologyGame
                    sessionId={playing}
                    onBack={() => { setPlaying(null); refresh(); }}
                    onToast={showToast}
                />
                {confirm ? (
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}

            {toast ? <div className="mix-toast">{toast}</div> : null}
            </div>
        );
    }

    const openingCardId = openingPicker ? mixSlotFirstId(openingPicker.slots, "character") : undefined;
    const openingCard = openingCardId ? getMixMaterial(openingCardId) : null;

    // 酒柜详情里的评论区：自己发布过的（publishedId）或从酒材页整件入柜的
    // （imported 且 id 就是线上 id，前缀 mxi_）能对上线上条目；随配方连料入柜的
    // 材料 id 是作者本地 id，线上没有对应条目，不显示评论区。
    const detailHallId = detail
        ? detail.publishedId ?? (detail.imported && detail.id.startsWith("mxi_") ? detail.id : null)
        : null;

    return (
        <div className="mixology-app">
            <div className="mix-header">
                <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="关闭"><ChevronLeft size={20} /></button>
                <div className="mix-header-title">独家<em>特调</em></div>
                {tab === "cabinet" ? (
                    <>
                        <button
                            type="button"
                            className="mix-profile-chip"
                            onClick={() => {
                                setProfileName(profile.name ?? "");
                                setProfileAvatar(profile.avatar ?? "");
                                setProfileOpen(true);
                            }}
                            title="创作者资料：发布到酒材/配方页时的署名与头像"
                        >
                            <AuthorAvatar name={profile.name || "我"} avatar={profile.avatar} size={32} />
                            <span className="mix-profile-name">{profile.name || "起个笔名"}</span>
                            <Pencil size={12} />
                        </button>
                        <button type="button" className="mix-icon-btn" onClick={() => importFileRef.current?.click()} aria-label="导入材料" title="从文件导入"><Upload size={17} /></button>
                    </>
                ) : null}
                {tab === "menu" || tab === "hall" ? (
                    <>
                        <div className="mix-scope-toggle" role="tablist" aria-label="范围切换">
                            <button type="button" data-active={hallScope === "all" ? "true" : undefined} onClick={() => setHallScope("all")}>大厅</button>
                            <button type="button" data-active={hallScope === "mine" ? "true" : undefined} onClick={() => setHallScope("mine")}>我的发布</button>
                        </div>
                        <button
                            type="button"
                            className="mix-icon-btn"
                            onClick={() => setHallReload((n) => n + 1)}
                            disabled={hallLoading}
                            aria-label="刷新"
                            title="刷新"
                        >
                            <RefreshCw size={17} className={hallLoading ? "mix-spin" : undefined} />
                        </button>
                    </>
                ) : null}
            </div>

            {/* TAG 行在滚动容器之外：真固定，橡皮筋回弹只作用下面的内容区 */}
            {tab === "menu" || tab === "cabinet" ? (
                <div className="mix-topbar">
                    <div className="mix-chip-row">
                        {MIX_SLOT_ORDER.map((kind) => {
                            const active = (tab === "menu" ? hallKind : cabinetKind) === kind;
                            return (
                                <button
                                    type="button"
                                    className="mix-chip"
                                    data-two-line="true"
                                    data-active={active ? "true" : undefined}
                                    onClick={() => (tab === "menu" ? setHallKind(kind) : setCabinetKind(kind))}
                                    key={kind}
                                >
                                    <span>{MIX_KIND_LABELS[kind]}</span>
                                    <small>{MIX_KIND_SECTION_LABELS[kind]}</small>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            <div className="mix-body" data-fill={tab === "bar" && barTab === "create" ? "true" : undefined}>
                {tab === "menu" ? (
                    <MixologyHall mode="menu" kind={hallKind} scope={hallScope} onToast={showToast} onImported={refresh} reloadToken={hallReload} onLoadingChange={setHallLoading} onEditLocal={openLocalEditor} />
                ) : null}

                {tab === "hall" ? (
                    <MixologyHall mode="hall" scope={hallScope} onToast={showToast} onImported={refresh} reloadToken={hallReload} onLoadingChange={setHallLoading} onEditLocal={openLocalEditor} />
                ) : null}

                {tab === "bar" ? (
                    <>
                        <div className="mix-subtabs">
                            <button type="button" data-active={barTab === "create" ? "true" : undefined} onClick={() => setBarTab("create")}>创建配方</button>
                            <button type="button" data-active={barTab === "mine" ? "true" : undefined} onClick={() => setBarTab("mine")}>
                                我的配方{recipes.length ? ` · ${recipes.length}` : ""}
                            </button>
                        </div>
                    {barTab === "create" ? (
                    <div className="mix-bar-stage" data-centered="true">
                        {barEditing ? (
                            <div className="mix-bar-hint" style={{ color: "var(--mix-gold)" }}>
                                正在改「{barEditing.name}」的搭配，存杯将存回这杯 ·{" "}
                                <span style={{ textDecoration: "underline", cursor: "pointer" }} onClick={() => { setBarEditing(null); setBarSlots({}); }}>放弃</span>
                            </div>
                        ) : null}
                        <div className="mix-bar-hint">左右滑动切换槽位 · 点击槽位选材料 · 一格可以叠多件</div>
                        <div className="mix-wheel" ref={wheelRef} onScroll={handleWheelScroll}>
                            {MIX_SLOT_ORDER.map((kind) => {
                                const stack = slotMaterials[kind] ?? [];
                                const chosen = stack[0];
                                const extra = stack.length - 1;
                                return (
                                    <div
                                        className="mix-slot"
                                        data-filled={chosen ? "true" : undefined}
                                        key={kind}
                                        // 空格子直接进选料（少点一下）；已有料的进这一格的编辑，能叠、能排序、能设条件
                                        onClick={() => (chosen ? setSlotEditor(kind) : setSlotPicker(kind))}
                                    >
                                        <div className="mix-slot-kind">
                                            <b>{MIX_KIND_LABELS[kind]}</b>
                                            {kind === "character"
                                                ? <i className="mix-slot-required">必选</i>
                                                : <i>可留空</i>}
                                        </div>
                                        <div className="mix-slot-body">
                                            {chosen ? (
                                                <>
                                                    {chosen.kind === "character" && chosen.cover ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img className="mix-slot-cover" src={chosen.cover} alt={chosen.name} />
                                                    ) : (
                                                        <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                    )}
                                                    <div className="mix-slot-name">{chosen.name}{extra > 0 ? ` +${extra}` : ""}</div>
                                                    {stack.length > 1 ? (
                                                        <div className="mix-slot-stack">
                                                            {mixSlotEntries(barSlots, kind).map((entry, i) => {
                                                                const mat = stack[i];
                                                                if (!mat) return null;
                                                                return (
                                                                    <span className="mix-slot-stack-item" key={`${entry.materialId}-${i}`}>
                                                                        {mat.name}
                                                                        <i>{describeMixCondition(entry.when)}</i>
                                                                    </span>
                                                                );
                                                            })}
                                                        </div>
                                                    ) : chosen.hook ? (
                                                        <div className="mix-slot-hook">{chosen.hook}</div>
                                                    ) : null}
                                                    {stack.length === 1 && mixSlotEntries(barSlots, kind)[0]?.when ? (
                                                        <div className="mix-slot-when">{describeMixCondition(mixSlotEntries(barSlots, kind)[0].when)}</div>
                                                    ) : null}
                                                </>
                                            ) : (
                                                <>
                                                    <div className="mix-slot-plus"><Plus size={26} /></div>
                                                    <div className="mix-slot-empty-text">从酒柜里挑一件{MIX_KIND_LABELS[kind]}</div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="mix-wheel-dots">
                            {MIX_SLOT_ORDER.map((kind, i) => (
                                <span className="mix-wheel-dot" data-active={i === wheelIndex ? "true" : undefined} key={kind} />
                            ))}
                        </div>
                        <button type="button" className="mix-brew-btn" onClick={handleBrew} disabled={!mixSlotEntries(barSlots, "character").length}>
                            <Martini size={17} />调 配
                        </button>
                    </div>
                    ) : recipes.length === 0 ? (
                            <div className="mix-empty" style={{ paddingTop: 70 }}>
                                <Wine size={32} strokeWidth={1.4} />
                                还没有保存过特调——
                                <br />
                                去「创建配方」配齐材料，按下「调配」。
                            </div>
                        ) : (
                            recipes.map((recipe) => {
                                const recipeCardId = mixSlotFirstId(recipe.slots, "character");
                                const card = recipeCardId ? cabinet.find((m) => m.id === recipeCardId) : null;
                                const parts = MIX_SLOT_ORDER
                                    .filter((k) => k !== "character")
                                    .flatMap((k) => mixSlotEntries(recipe.slots, k)
                                        .map((entry) => (getMixBuiltin(entry.materialId) ?? cabinet.find((m) => m.id === entry.materialId))?.name))
                                    .filter(Boolean);
                                // 配方的云端徽章：自己改过搭配、或任一自有材料没上架/没同步，都算"有未上架修改"
                                const cloudBadge = (() => {
                                    if (recipe.imported || !recipe.publishedId) return null;
                                    const partsDirty = MIX_SLOT_ORDER.some((k) => mixSlotEntries(recipe.slots, k).some((entry) => {
                                        if (isMixBuiltinId(entry.materialId)) return false;
                                        const m = cabinet.find((x) => x.id === entry.materialId);
                                        return Boolean(m) && !m!.imported && mixCloudState(m!) !== "synced";
                                    }));
                                    return mixCloudState(recipe) === "dirty" || partsDirty ? "有未上架修改" : "已上架";
                                })();
                                return (
                                    <div className="mix-recipe-card" key={recipe.id}>
                                        {card?.cover ? <div className="mix-recipe-bg" style={{ backgroundImage: `url(${card.cover})` }} /> : null}
                                        <div className="mix-recipe-main">
                                            <div className="mix-recipe-name">
                                                {recipe.name}
                                                {cloudBadge ? <span className="mix-cloud-badge" data-dirty={cloudBadge === "已上架" ? undefined : "true"}>{cloudBadge}</span> : null}
                                            </div>
                                            <div className="mix-recipe-parts">
                                                {card ? card.name : "（角色卡缺失）"}
                                                {parts.length ? ` · ${parts.join(" · ")}` : " · 素杯"}
                                            </div>
                                        </div>
                                        <div className="mix-recipe-actions">
                                            <button
                                                type="button"
                                                className="mix-round-btn"
                                                data-tone="gold"
                                                onClick={() => handleStartRecipe(recipe)}
                                                aria-label="开始对局"
                                                title="开始"
                                            >
                                                <Play size={17} fill="currentColor" />
                                            </button>
                                            <button
                                                type="button"
                                                className="mix-round-btn"
                                                onClick={() => setRecipeMenu(recipe)}
                                                aria-label="更多操作"
                                                title="更多"
                                            >
                                                <MoreHorizontal size={18} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </>
                ) : null}

                {tab === "cabinet" ? (
                    <>
                        {cabinetFiltered.length === 0 ? (
                            <div className="mix-empty">
                                <Archive size={32} strokeWidth={1.4} />
                                这一格还空着——
                                <br />
                                点右下角 ＋ 自建一件{MIX_KIND_LABELS[cabinetKind]}。
                            </div>
                        ) : (
                            <div className={mixKindHasCover(cabinetKind) ? "mix-waterfall" : "mix-mat-list"}>
                                {cabinetFiltered.map((material) => (
                                    <MatCard
                                        kind={material.kind}
                                        name={material.name}
                                        hook={material.hook}
                                        tags={material.tags}
                                        cover={material.kind === "character" ? material.cover : undefined}
                                        preview={mixMatHasAutoCover(material) ? <MixMatAutoCover material={material} /> : undefined}
                                        badge={isMixBuiltinId(material.id)
                                            ? "官方"
                                            : material.imported || mixCloudState(material) === "local"
                                                ? undefined
                                                : mixCloudState(material) === "dirty" ? "有未上架修改" : "已上架"}
                                        author={!isMixBuiltinId(material.id) ? material.author : undefined}
                                        onClick={() => setDetail(material)}
                                        key={material.id}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                ) : null}

                {tab === "games" ? (
                    <>
                        <div className="mix-section-title" style={{ marginTop: 14 }}>酒局<small>{sessions.length ? `${sessions.length} 场` : ""}</small></div>
                        {sessions.length === 0 ? (
                            <div className="mix-empty">
                                <Martini size={32} strokeWidth={1.4} />
                                还没开过局——
                                <br />
                                去吧台调一杯，按「开始」。
                            </div>
                        ) : (
                            sessions.map((session) => {
                                const sessionCardId = mixSlotFirstId(session.recipe.slots, "character");
                                const card = sessionCardId ? cabinet.find((m) => m.id === sessionCardId) : null;
                                return (
                                    <div className="mix-session-row" key={session.id} onClick={() => setPlaying(session.id)}>
                                        {card?.cover ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img className="mix-session-ava" src={card.cover} alt={session.charName} />
                                        ) : (
                                            <div className="mix-session-ava-fallback">{session.charName.slice(0, 1)}</div>
                                        )}
                                        <div className="mix-session-info">
                                            <div className="mix-session-name">{session.charName} · {session.recipe.name}</div>
                                            <div className="mix-session-sub">{session.turns.length} 条 · {formatMixTime(session.updatedAt)}</div>
                                        </div>
                                        <button
                                            type="button"
                                            className="mix-icon-btn"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setConfirm({
                                                    title: "删除这场酒局？",
                                                    body: <>「{session.charName} · {session.recipe.name}」的 {session.turns.length} 条对话会一起消失，无法找回。</>,
                                                    confirmText: "删除",
                                                    tone: "danger",
                                                    run: () => { deleteMixSession(session.id); refresh(); },
                                                });
                                            }}
                                            aria-label="删除对局"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                );
                            })
                        )}
                    </>
                ) : null}
            </div>

            {/* 悬浮创建按钮：必须在滚动容器之外，否则列表滚动后按钮会跟着内容坐标漂移 */}
            {tab === "cabinet" ? (
                <button
                    type="button"
                    className="mix-fab"
                    onClick={() => setEditor({ kind: cabinetKind })}
                    aria-label={`自建一件${MIX_KIND_LABELS[cabinetKind]}`}
                    title={`自建一件${MIX_KIND_LABELS[cabinetKind]}`}
                >
                    <Plus size={24} />
                </button>
            ) : null}

            <div className="mix-nav">
                <button type="button" className="mix-nav-btn" data-active={tab === "menu" ? "true" : undefined} onClick={() => setTab("menu")}>
                    <Wine size={19} strokeWidth={1.8} />酒材
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "hall" ? "true" : undefined} onClick={() => setTab("hall")}>
                    <Users size={19} strokeWidth={1.8} />配方
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "bar" ? "true" : undefined} onClick={() => setTab("bar")}>
                    <Martini size={19} strokeWidth={1.8} />吧台
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "cabinet" ? "true" : undefined} onClick={() => setTab("cabinet")}>
                    <Archive size={19} strokeWidth={1.8} />酒柜
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "games" ? "true" : undefined} onClick={() => setTab("games")}>
                    <GlassWater size={19} strokeWidth={1.8} />对局
                </button>
            </div>

            {/* 材料详情 */}
            {detail ? (
                <div className="mix-sheet-mask" onClick={() => setDetail(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        {detail.kind === "character" && detail.cover ? (
                            <div className="mix-sheet-backdrop" style={{ backgroundImage: `url(${detail.cover})` }} />
                        ) : null}
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">
                                {detail.name}
                                {isMixBuiltinId(detail.id) ? <span className="mix-mat-badge" style={{ marginLeft: 6 }}>官方</span> : null}
                                {!isMixBuiltinId(detail.id) && !detail.imported && mixCloudState(detail) !== "local" ? (
                                    <span className="mix-cloud-badge" data-dirty={mixCloudState(detail) === "dirty" ? "true" : undefined}>
                                        {mixCloudState(detail) === "dirty" ? "有未上架修改" : "已上架"}
                                    </span>
                                ) : null}
                            </div>
                            {!detail.imported ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => {
                                        // 复制＝断开云端关联的新件：基于原件继续改，不影响已上架的版本
                                        const { publishedId: _p, publishedAt: _a, imported: _i, ...rest } = detail;
                                        const now = Date.now();
                                        const dup = { ...rest, id: createMixId("mixmat"), name: `${detail.name} 副本`, createdAt: now, updatedAt: now } as MixMaterial;
                                        saveMixMaterial(dup);
                                        setDetail(null);
                                        refresh();
                                        showToast(`已复制为「${dup.name}」，不关联云端。`);
                                    }}
                                    aria-label="复制一份（不关联云端）"
                                    title="复制一份（不关联云端）"
                                >
                                    <Copy size={16} />
                                </button>
                            ) : null}
                            {/* 导入的别人的作品（全部种类）：不能导出、不能编辑、不能二次发布——只能删除或入柜再取。
                                与应用市场同规矩；正文封存仅角色卡（isSealedMaterial），但操作限制对所有导入件生效 */}
                            {!detail.imported ? (
                                <>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => { void exportMixMaterial(detail).catch((err) => showToast(err instanceof Error ? err.message : "导出失败")); }}
                                        aria-label="导出 JSON"
                                        title="导出 JSON"
                                    >
                                        <Download size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => { void exportMixMaterialPng(detail).catch((err) => showToast(err instanceof Error ? err.message : "导出失败")); }}
                                        aria-label="导出 PNG 卡"
                                        title="导出 PNG 卡（图即是卡）"
                                    >
                                        <ImageDown size={16} />
                                    </button>
                                </>
                            ) : null}
                            {!isMixBuiltinId(detail.id) && !detail.imported ? (
                                <>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setConfirm(detail.publishedId ? {
                                            title: "更新酒材页上的版本？",
                                            body: <>会把「{detail.name}」在酒材页上的内容替换成现在这一份。<br />点赞、入柜数与评论都会保留。</>,
                                            confirmText: "更新",
                                            run: () => { const t = detail; setDetail(null); void handleShareMaterial(t); },
                                        } : {
                                            title: mixKindRunsActiveCode(detail.kind) ? "把这件机括发出去？" : "分享到酒材页？",
                                            body: mixKindRunsActiveCode(detail.kind) ? (
                                                <>「{detail.name}」将出现在酒材页上，别人下载后<b>它的代码会在对方的对局里按轮执行</b>——能改写对方发出去的话、改写看到的正文、以对方的身份发言。<br />请确认这份代码是你自己写的、你清楚它做了什么。</>
                                            ) : (
                                                <>「{detail.name}」将出现在酒材页上，<b>其他人能看到它的完整内容</b>，也能加进自己的酒柜。<br />不想公开就先别发。</>
                                            ),
                                            confirmText: "分享",
                                            run: () => { const t = detail; setDetail(null); void handleShareMaterial(t); },
                                        })}
                                        disabled={sharing}
                                        aria-label={detail.publishedId ? "更新酒材页上的版本" : "分享到酒材页"}
                                        title={detail.publishedId ? "更新酒材页上的版本" : "分享到酒材页"}
                                    >
                                        {detail.publishedId ? <RefreshCw size={16} /> : <Share2 size={16} />}
                                    </button>
                                    <button type="button" className="mix-icon-btn" onClick={() => { setEditor({ kind: detail.kind, initial: detail }); setDetail(null); }} aria-label="编辑"><Pencil size={16} /></button>
                                </>
                            ) : null}
                            {!isMixBuiltinId(detail.id) ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "删除这件材料？",
                                        body: <>
                                            「{detail.name}」将从酒柜里移除，用到它的特调会缺一味。
                                            <br />
                                            {detail.imported ? "之后可以再去酒材页入柜一次。" : "这一步不能撤销，只删本地，已上架的版本不受影响。"}
                                        </>,
                                        confirmText: "删除",
                                        tone: "danger",
                                        run: () => handleDeleteMaterial(detail),
                                    })}
                                    aria-label="删除"
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetail(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-author-row" style={{ marginTop: 2 }}>
                                {detail.imported ? (
                                    <>
                                        <AuthorAvatar name={detail.author || "匿名调酒师"} avatar={detail.authorAvatar} />
                                        <span className="mix-author-name">@{detail.author || "匿名调酒师"}</span>
                                    </>
                                ) : (
                                    <>
                                        <AuthorAvatar name={profile.name || "我"} avatar={profile.avatar} />
                                        <span className="mix-author-name">{profile.name || "我"}</span>
                                        <span className="mix-mat-stats">发布时以创作者资料为准</span>
                                    </>
                                )}
                            </div>
                            <MixTagList tags={detail.tags} />
                            {/* 与酒材页同一套展示：角色卡点开看门面（画布/一句话介绍），设定正文进「编辑」看 */}
                            {detail.kind === "character" ? (
                                <SealedNote hook={detail.hook} canvas={(detail as MixCharacterCard).canvas} charName={(detail as MixCharacterCard).charName} />
                            ) : (
                                <MaterialDetail material={detail} />
                            )}
                            {detailHallId ? (
                                <CommentThread
                                    type="material"
                                    targetId={detailHallId}
                                    myId={myId}
                                    onToast={showToast}
                                    onCountChange={() => { /* 酒柜不落地线上评论数 */ }}
                                    requestConfirm={setConfirm}
                                />
                            ) : null}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 创作者资料编辑 */}
            {profileOpen ? (
                <div className="mix-sheet-mask" onClick={() => setProfileOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">创作者资料</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setProfileOpen(false)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-struct-note" style={{ marginTop: 4 }}>
                                发布或更新到酒材页/配方页时，条目会展示这里的头像和笔名。笔名留空则用账号昵称。
                            </div>
                            <label className="mix-form-label">头像</label>
                            <div className="mix-cover-picker">
                                <AuthorAvatar name={profileName || profile.name || "我"} avatar={profileAvatar} size={88} />
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <button type="button" className="mix-pill-btn" onClick={() => avatarFileRef.current?.click()}>选择图片</button>
                                    {profileAvatar ? (
                                        <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setProfileAvatar("")}>移除</button>
                                    ) : null}
                                </div>
                                <input
                                    ref={avatarFileRef}
                                    type="file"
                                    accept="image/*"
                                    style={{ display: "none" }}
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        e.target.value = "";
                                        if (!file) return;
                                        void readAvatarFile(file)
                                            .then(setProfileAvatar)
                                            .catch(() => showToast("头像读取失败，换一张试试。"));
                                    }}
                                />
                            </div>
                            <label className="mix-form-label">笔名</label>
                            <input
                                className="mix-input"
                                value={profileName}
                                onChange={(e) => setProfileName(e.target.value)}
                                placeholder="发布时的署名，留空用账号昵称"
                                maxLength={24}
                            />
                            <div className="mix-form-footer">
                                <button type="button" className="mix-ghost-btn" onClick={() => setProfileOpen(false)}>取消</button>
                                <button
                                    type="button"
                                    className="mix-brew-btn"
                                    onClick={() => {
                                        const next: MixProfile = { name: profileName.trim() || undefined, avatar: profileAvatar || undefined };
                                        saveMixProfile(next);
                                        setProfile(next);
                                        setProfileOpen(false);
                                        showToast("创作者资料已保存，之后的发布/更新都用它。");
                                    }}
                                >
                                    保存
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 编辑器 */}
            {editor ? (
                <div className="mix-sheet-mask">
                    <div className="mix-sheet" style={{ maxHeight: "92%" }}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{editor.initial ? "编辑" : "自建"}{MIX_KIND_LABELS[editor.kind]}</div>
                            {/* 上传替换：改现成的件时先问一声，表单里已经有内容了 */}
                            <button
                                type="button"
                                className="mix-icon-btn"
                                onClick={() => {
                                    if (!editor.initial) { editorFileRef.current?.click(); return; }
                                    setConfirm({
                                        title: "用文件替换表单内容？",
                                        body: <>会把「{editor.initial.name}」现在填的内容整份换成文件里的那一份（JSON 或 PNG 卡都行）。<br />换完还没保存，看一眼不对可以直接关掉不存。<br />已上架的关联不会丢，保存后点更新仍是覆盖同一条。</>,
                                        confirmText: "选择文件",
                                        run: () => editorFileRef.current?.click(),
                                    });
                                }}
                                aria-label="上传替换"
                                title="上传文件替换表单内容（JSON / PNG 卡）"
                            >
                                <Upload size={17} />
                            </button>
                            <button type="button" className="mix-icon-btn" onClick={() => setEditor(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <MixMaterialEditor
                                key={`${editor.kind}-${editorSeq}`}
                                kind={editor.kind}
                                initial={editor.initial}
                                onSave={(material) => {
                                    // 编辑器不经手发布记账字段，保存时从原件带回来，别把云端关联弄丢；
                                    // updatedAt 会被重打，所以保存后自然进入"有未上架修改"态
                                    saveMixMaterial(editor.initial?.publishedId
                                        ? { ...material, publishedId: editor.initial.publishedId, publishedAt: editor.initial.publishedAt }
                                        : material);
                                    // 机括改完，正在跑的沙盒里还是老代码——收掉，下次调用重建
                                    if (material.kind === "mechanism") disposeMixSandboxesForMaterial(material.id);
                                    setEditor(null);
                                    refresh();
                                    showToast(`「${material.name}」已入柜。`);
                                }}
                                onCancel={() => setEditor(null)}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 吧台选材 */}
            {slotEditor ? (
                <MixSlotEditor
                    kind={slotEditor}
                    entries={mixSlotEntries(barSlots, slotEditor)}
                    resolve={(id) => getMixBuiltin(id) ?? cabinet.find((m) => m.id === id) ?? null}
                    varNames={barVarNames}
                    onChange={(next) => setBarSlots((prev) => {
                        const merged = { ...prev };
                        if (next.length) merged[slotEditor] = next;
                        else delete merged[slotEditor];
                        return merged;
                    })}
                    onPickMore={() => setSlotPicker(slotEditor)}
                    onClose={() => setSlotEditor(null)}
                />
            ) : null}

            {slotPicker ? (
                <div className="mix-sheet-mask" onClick={() => setSlotPicker(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">挑一件{MIX_KIND_LABELS[slotPicker]}</div>
                            {slotPicker !== "character" && mixSlotEntries(barSlots, slotPicker).length ? (
                                <button
                                    type="button"
                                    className="mix-pill-btn"
                                    data-tone="ghost"
                                    onClick={() => {
                                        setBarSlots((prev) => {
                                            const next = { ...prev };
                                            delete next[slotPicker];
                                            return next;
                                        });
                                        setSlotPicker(null);
                                    }}
                                >
                                    不加这味
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setSlotPicker(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            {listMixPickables(slotPicker).length === 0 ? (
                                <div className="mix-empty">
                                    <Archive size={30} strokeWidth={1.4} />
                                    酒柜里还没有{MIX_KIND_LABELS[slotPicker]}——
                                    <br />
                                    去酒柜页点 ＋ 自建一件。
                                </div>
                            ) : (
                                <div className={mixKindHasCover(slotPicker) ? "mix-waterfall" : "mix-mat-list"}>
                                    {listMixPickables(slotPicker).map((material) => (
                                        <MatCard
                                            kind={material.kind}
                                            name={material.name}
                                            hook={material.hook}
                                            tags={material.tags}
                                            cover={material.kind === "character" ? material.cover : undefined}
                                            preview={mixMatHasAutoCover(material) ? <MixMatAutoCover material={material} /> : undefined}
                                            badge={isMixBuiltinId(material.id) ? "官方" : undefined}
                                            onClick={() => {
                                                setBarSlots((prev) => {
                                                    const current = mixSlotEntries(prev, slotPicker);
                                                    // 已经在这一格里就不重复加
                                                    if (current.some((e) => e.materialId === material.id)) return prev;
                                                    return { ...prev, [slotPicker]: [...current, { materialId: material.id }] };
                                                });
                                                setSlotPicker(null);
                                            }}
                                            key={material.id}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 命名并保存特调 */}
            {nameSheetOpen ? (
                <div className="mix-sheet-mask" onClick={() => setNameSheetOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">给这杯特调命名</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setNameSheetOpen(false)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <input className="mix-input" value={recipeName} onChange={(e) => setRecipeName(e.target.value)} placeholder="特调名" />
                            <div className="mix-detail-label" style={{ margin: "12px 2px 6px" }}>这杯里有</div>
                            <div className="mix-detail-value">
                                {MIX_SLOT_ORDER.filter((k) => slotMaterials[k]?.length)
                                    .map((k) => `${MIX_KIND_LABELS[k]} · ${(slotMaterials[k] ?? []).map((m) => m.name).join(" + ")}`)
                                    .join("\n")}
                            </div>
                            <div className="mix-form-footer">
                                <button type="button" className="mix-ghost-btn" onClick={() => setNameSheetOpen(false)}>再想想</button>
                                <button type="button" className="mix-brew-btn" onClick={handleSaveRecipe}>存入方案</button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 特调更多操作 */}
            {recipeMenu ? (
                <div className="mix-sheet-mask" onClick={() => setRecipeMenu(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{recipeMenu.name}</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setRecipeMenu(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-author-row" style={{ margin: "2px 0 8px" }}>
                                {recipeMenu.imported ? (
                                    <>
                                        <AuthorAvatar name={recipeMenu.author || "匿名调酒师"} avatar={recipeMenu.authorAvatar} />
                                        <span className="mix-author-name">@{recipeMenu.author || "匿名调酒师"}</span>
                                    </>
                                ) : (
                                    <>
                                        <AuthorAvatar name={profile.name || "我"} avatar={profile.avatar} />
                                        <span className="mix-author-name">{profile.name || "我"}</span>
                                        <span className="mix-mat-stats">发布时以创作者资料为准</span>
                                    </>
                                )}
                            </div>
                            <button
                                type="button"
                                className="mix-action-row"
                                onClick={() => {
                                    setBarSlots({ ...recipeMenu.slots });
                                    // 导入的配方：进"存回原杯"模式——材料内容动不了，但换用哪件随便
                                    setBarEditing(recipeMenu.imported ? recipeMenu : null);
                                    setBarTab("create");
                                    setRecipeMenu(null);
                                    showToast(recipeMenu.imported ? "已装回吧台——换好材料点存杯，直接存回这杯。" : "已装回吧台，可以微调。");
                                }}
                            >
                                <SlidersHorizontal size={17} />
                                <span>装载到吧台<i>{recipeMenu.imported ? "换用哪件材料可以改，存杯存回这杯" : "把这杯的材料放回槽位，改一改再存"}</i></span>
                            </button>
                            {recipeMenu.imported ? null : (
                            <button
                                type="button"
                                className="mix-action-row"
                                onClick={() => {
                                    const target = recipeMenu;
                                    setRecipeMenu(null);
                                    void exportMixRecipeFile(target)
                                        .then(() => showToast("配方文件已导出：整杯打包，含引用的全部非官方材料。"))
                                        .catch((error) => showToast(error instanceof Error ? error.message : "导出失败"));
                                }}
                            >
                                <Download size={17} />
                                <span>导出文件<i>整杯打包成 JSON，可发资源市场或私下分享</i></span>
                            </button>
                            )}
                            {recipeMenu.imported ? null : (
                            <button
                                type="button"
                                className="mix-action-row"
                                onClick={() => {
                                    const { publishedId: _p, publishedAt: _a, imported: _i, ...rest } = recipeMenu;
                                    const now = Date.now();
                                    const dup: MixRecipe = { ...rest, id: createMixId("mixrec"), name: `${recipeMenu.name} 副本`, createdAt: now, updatedAt: now };
                                    saveMixRecipe(dup);
                                    setRecipeMenu(null);
                                    refresh();
                                    showToast(`已复制为「${dup.name}」，不关联云端。`);
                                }}
                            >
                                <Copy size={17} />
                                <span>复制配方<i>生成一杯不关联云端的新配方，基于它继续改</i></span>
                            </button>
                            )}
                            {recipeMenu.imported ? null : (
                            <button
                                type="button"
                                className="mix-action-row"
                                disabled={sharing}
                                onClick={() => {
                                    const target = recipeMenu;
                                    const plan = planShareRecipe(target);
                                    if (!plan.character) {
                                        showToast("这杯特调缺角色卡，没法分享。");
                                        return;
                                    }
                                    if (plan.blockers.length > 0) {
                                        showToast(`「${plan.blockers[0].name}」是旧版随配方导入的材料，云端没有条目，换成酒材页上的版本再分享。`);
                                        return;
                                    }
                                    setRecipeMenu(null);
                                    const syncNotes = (
                                        <>
                                            {plan.toPublish.length > 0 ? (
                                                <><br /><b>{plan.toPublish.length} 味材料会先上架到酒材页</b>（完整内容公开、可被单独入柜）：{plan.toPublish.map((m) => m.name).join("、")}。</>
                                            ) : null}
                                            {plan.toSync.length > 0 ? (
                                                <><br />{plan.toSync.length} 味已上架材料的本地修改会同步到云端：{plan.toSync.map((m) => m.name).join("、")}。</>
                                            ) : null}
                                        </>
                                    );
                                    setConfirm(target.publishedId ? {
                                        title: "更新配方页上的版本？",
                                        body: <>会把「{target.name}」在配方页上的搭配替换成现在这一份。<br />点赞、入柜数与评论都会保留。{syncNotes}</>,
                                        confirmText: "更新",
                                        run: () => void handleShareRecipe(target),
                                    } : {
                                        title: "分享到配方页？",
                                        body: <>「{target.name}」发布的是<b>搭配与引用</b>，材料内容以酒材页上各自的条目为准，别人可以一键连料入柜。{syncNotes}</>,
                                        confirmText: "分享",
                                        run: () => void handleShareRecipe(target),
                                    });
                                }}
                            >
                                {recipeMenu.publishedId ? <RefreshCw size={17} /> : <Share2 size={17} />}
                                <span>
                                    {recipeMenu.publishedId ? "更新配方页上的版本" : "分享到配方页"}
                                    <i>{recipeMenu.publishedId ? "用现在这一份替换掉配方页上的旧版，社交数据保留" : "连同材料一起发布，别人可以连料入柜"}</i>
                                </span>
                            </button>
                            )}
                            <button
                                type="button"
                                className="mix-action-row"
                                data-tone="danger"
                                onClick={() => {
                                    const target = recipeMenu;
                                    setRecipeMenu(null);
                                    setConfirm({
                                        title: "删除这杯特调？",
                                        body: <>只删「{target.name}」这个搭配，里面的材料还留在酒柜里。</>,
                                        confirmText: "删除",
                                        tone: "danger",
                                        run: () => {
                                            deleteMixRecipe(target.id);
                                            refresh();
                                            showToast("这杯特调已倒掉。");
                                        },
                                    });
                                }}
                            >
                                <Trash2 size={17} />
                                <span>删除这杯<i>材料还在酒柜里，只删配方本身</i></span>
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 开场白选择 */}
            {openingPicker && openingCard?.kind === "character" ? (
                <div className="mix-sheet-mask" onClick={() => setOpeningPicker(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">选一段开场</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setOpeningPicker(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            {(openingCard as MixCharacterCard).openings.map((opening, i) => (
                                <button type="button" className="mix-opening-option" key={i} onClick={() => startWithOpening(openingPicker, i)}>
                                    {opening.length > 120 ? `${opening.slice(0, 120)}…` : opening}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            ) : null}

            <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json,image/png,.png"
                style={{ display: "none" }}
                onChange={(e) => { void handleImportFile(e.target.files?.[0]); e.target.value = ""; }}
            />

            {/* 编辑器里的上传替换用的是另一个 input：它不入柜，只替表单 */}
            <input
                ref={editorFileRef}
                type="file"
                accept="application/json,.json,image/png,.png"
                style={{ display: "none" }}
                onChange={(e) => { void handleEditorReplace(e.target.files?.[0]); e.target.value = ""; }}
            />

            {confirm ? (
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}

            {toast ? <div className="mix-toast">{toast}</div> : null}
        </div>
    );
}
