"use client";

// 独家特调 · 对局画面：角色封面打底 + 三段蒙版，AI 正文无气泡全宽、
// 玩家右侧气泡、小票全宽卡；全程无任何标签徽章，保沉浸。
// 装饰材料的 CSS 以 <style> 注入本画面容器（认 .mix-* 官方语义类）。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, Copy, History, MoreHorizontal, Pencil, Plus, RotateCcw, Send, Sun, WandSparkles, X } from "lucide-react";
import { continueMix, editMixTurn, generateMixReply, canReplayMixFrom, MIX_REPAIR_EVENT, MIX_STORE_SNAPSHOT_TURNS, mixTurnRawText, recordMixPanelStore, refreshMixOpening, regenerateMixTail, rerollMixReply, runMixEditSync, runMixSessionEnd, truncateMixAfterTurn, type MixRepairEventDetail } from "@/lib/mixology/engine";
import { getMixMaterial, getMixSession, listMixPickables, MIX_CABINET_UPDATED_EVENT, resolveMixRecipeMaterials, saveMixSession } from "@/lib/mixology/storage";
import { applyMixMacros, MIX_DEFAULT_USER_NAME } from "@/lib/mixology/assembler";
import { buildMixConditionContext, pickActiveMixMaterials } from "@/lib/mixology/state";
import { scopeMixCss } from "@/lib/mixology/css-scope";
import { MIX_KIND_LABELS, MIX_SLOT_ORDER, mixEncoreRenderHtml, mixPanelLayoutOf, mixPanelSlotOf, mixSlotEntries, mixTurnEncoreBlocks, mixTurnTicketBlocks, type MixCharacterCard, type MixFilterRule, type MixMaterialKind, type MixMechanismMaterial, type MixPanelLayout, type MixSession, type MixSlotEntry, type MixState, type MixTicketMaterial, type MixTurn } from "@/lib/mixology/types";
import { applyMixFilterRules, mixStreamText } from "@/lib/mixology/prose";
import { MixProseView } from "./prose-view";
import { MixRichText } from "./rich-text";
import { KindGlyph, MixConfirm } from "./mixology-shared";
import { MixTicketFrame } from "./ticket-frame";
import { MixMechanismInline, MixMechanismPanel } from "./mechanism-panel";
import { MixSlotEditor } from "./slot-editor";

/** 当前真正挂着的对局：严格模式的重复挂载靠它区分「真退出」与「假卸载」 */
const liveMixGames = new Set<string>();

type GameProps = {
    sessionId: string;
    onBack: () => void;
    onToast: (message: string) => void;
};

/** 一轮里要渲染的一块（状态栏/小剧场）：皮 + 这一轮的原文 */
type TurnFrame = { key: string; html: string; raw: string };

function AssistantTurn({ turn, ticketFrames, encoreFrames, filterRules, state }: { turn: MixTurn; ticketFrames: TurnFrame[]; encoreFrames: TurnFrame[]; filterRules?: MixFilterRule[]; state?: MixState }) {
    // 展示顺序：状态栏在正文前、小剧场在正文后（与模型的输出顺序一致，无需重排）；
    // 一轮多块时依次上下排开，各块各自的皮各渲染各的
    // 滤网「仅显示」模式在这里生效：存储不动，渲染前替换，历史消息也即时生效
    const shownText = applyMixFilterRules(turn.text, filterRules, "display");
    return (
        <>
            {ticketFrames.map((frame) => (
                <div className="mix-ticket-wrap" key={frame.key}>
                    <MixTicketFrame html={frame.html} raw={frame.raw} state={state} />
                </div>
            ))}
            {shownText ? <MixProseView text={shownText} /> : null}
            {encoreFrames.map((frame) => (
                <div className="mix-encore-turn" key={frame.key}>
                    <MixTicketFrame html={frame.html} raw={frame.raw} state={state} />
                </div>
            ))}
        </>
    );
}

/** 每条消息下方的操作行：复制 / 回溯到这里 / 编辑 */
function TurnActions({
    align,
    disabled,
    canRewind,
    onCopy,
    onRewind,
    onEdit,
}: {
    align: "left" | "right";
    disabled: boolean;
    canRewind: boolean;
    onCopy: () => void;
    onRewind: () => void;
    onEdit: () => void;
}) {
    return (
        <div className="mix-turn-actions" data-align={align}>
            <button type="button" className="mix-turn-act" onClick={onCopy} disabled={disabled} aria-label="复制"><Copy size={13} /></button>
            {canRewind ? (
                <button type="button" className="mix-turn-act" onClick={onRewind} disabled={disabled} aria-label="回溯到这里"><History size={13} /></button>
            ) : null}
            <button type="button" className="mix-turn-act" onClick={onEdit} disabled={disabled} aria-label="编辑"><Pencil size={13} /></button>
        </div>
    );
}

/**
 * 记住的值：顶栏下的一条横条，点开看全部。
 * 没有任何值时整条不存在——没配小票的对局界面不变。
 */
function StateBar({ state }: { state: MixState }) {
    const [open, setOpen] = useState(false);
    const items = Object.entries(state);
    if (!items.length) return null;
    return (
        <div className="mix-state-bar" data-open={open ? "true" : undefined}>
            <button type="button" className="mix-state-strip" onClick={() => setOpen((v) => !v)}>
                {items.slice(0, 3).map(([name, value]) => (
                    <span className="mix-state-chip" key={name}>
                        <i>{name}</i>
                        <b>{String(value)}</b>
                    </span>
                ))}
                {items.length > 3 ? <span className="mix-state-more">+{items.length - 3}</span> : null}
            </button>
            {open ? (
                <div className="mix-state-panel">
                    {items.map(([name, value]) => (
                        <div className="mix-state-row" key={name}>
                            <span>{name}</span>
                            <b>{String(value)}</b>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function MixologyGame({ sessionId, onBack, onToast }: GameProps) {
    const [session, setSession] = useState<MixSession | null>(() => getMixSession(sessionId));
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    /**
     * 正在写的那一段。模型每吐一小段就回调一次，一个 token 重渲染一次太浪费，
     * 所以先攒在 ref 里，按帧合批推给界面。
     */
    const [live, setLive] = useState("");
    const liveRef = useRef("");
    const liveFrameRef = useRef(0);
    const busyRef = useRef(false);
    const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
    /**
     * 编辑弹层的键盘适配（iOS）：弹层高、输入框更高，键盘一出 WebKit 会滚动整页
     * 去追光标，把弹层标题顶出屏幕（偶发，取决于光标位置与时序）。两手处理：
     * ① 给遮罩垫 padding-bottom = 键盘高度，弹层整体抬到键盘上方（78% 上限
     *    按剩余高度算，整个弹层都在可视区里，iOS 就没有追光标的理由）；
     * ② 页面还是被蹭走的话（visualViewport 偏移/window 滚动），立刻拉回。
     */
    const editMaskRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!editing || typeof window === "undefined") return;
        const vv = window.visualViewport;
        let raf = 0;
        const sync = () => {
            raf = 0;
            const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
            const mask = editMaskRef.current;
            if (mask) mask.style.paddingBottom = inset > 40 ? `${inset}px` : "";
            if (window.scrollY || (vv && vv.offsetTop > 1)) window.scrollTo(0, 0);
        };
        const request = () => { if (!raf) raf = requestAnimationFrame(sync); };
        sync();
        vv?.addEventListener("resize", request);
        vv?.addEventListener("scroll", request);
        window.addEventListener("scroll", request);
        return () => {
            if (raf) cancelAnimationFrame(raf);
            vv?.removeEventListener("resize", request);
            vv?.removeEventListener("scroll", request);
            window.removeEventListener("scroll", request);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 只关心开/关，别在每次敲字时重挂监听
    }, [Boolean(editing)]);
    const [confirm, setConfirm] = useState<{ type: "rewind" | "edit"; turnId: string } | null>(null);
    const [recipeOpen, setRecipeOpen] = useState(false);
    /** 局内的叠层编辑：排序 / 生效条件 / 移除，和吧台同一套编辑器 */
    const [slotEdit, setSlotEdit] = useState<MixMaterialKind | null>(null);
    const [slotPick, setSlotPick] = useState<MixMaterialKind | null>(null);
    const [wheelIndex, setWheelIndex] = useState(0);
    /**
     * 酒柜外部变更计数：小卷（吉祥物工具）改完材料会广播这个事件，对局里的
     * 画布/小票/装饰都是渲染时从酒柜现取的，靠它促使下面两个 useMemo 重取——
     * 否则开着的对局要退出重进才能看到小卷刚写的开场画布。
     */
    const [cabinetTick, setCabinetTick] = useState(0);
    useEffect(() => {
        const bump = () => setCabinetTick((t) => t + 1);
        window.addEventListener(MIX_CABINET_UPDATED_EVENT, bump);
        return () => window.removeEventListener(MIX_CABINET_UPDATED_EVENT, bump);
    }, []);
    /**
     * 状态栏补写提示：补写是流式结束后追加的一次模型往返，屏幕上没有任何
     * 东西在动——引擎广播事件，这里挂一个半透明小 toast 告诉用户在补什么。
     */
    const [repairNote, setRepairNote] = useState<string | null>(null);
    useEffect(() => {
        const onRepair = (event: Event) => {
            const detail = (event as CustomEvent<MixRepairEventDetail>).detail;
            if (!detail || detail.sessionId !== sessionId) return;
            setRepairNote(detail.done ? null : detail.name ?? "");
        };
        window.addEventListener(MIX_REPAIR_EVENT, onRepair);
        return () => window.removeEventListener(MIX_REPAIR_EVENT, onRepair);
    }, [sessionId]);
    // 兜底：这轮怎么收场的都别让 toast 挂着（引擎侧异常路径已在 finally 里收过一道）
    useEffect(() => { if (!busy) setRepairNote(null); }, [busy]);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const wheelRef = useRef<HTMLDivElement | null>(null);
    /**
     * 滚动落点：还没开口的局停在扉页顶上（开场画布要从头看），聊过的局停在最新一条上。
     * free = 用户自己翻过了，别再拽他。
     */
    const stickRef = useRef<"top" | "bottom" | "free">("bottom");

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

    // 封面 / 小票渲染代码 / 装饰 CSS：按方案槽位从酒柜现取
    const assets = useMemo(() => {
        if (!session) return { cover: "", tickets: [] as { id: string; html: string }[], garnishCss: "", aiEncores: [] as { id: string; html: string }[], encoreStatics: [] as { id: string; html: string }[], canvasHtml: "", filterRules: undefined as MixFilterRule[] | undefined };
        // 渲染侧同样吃生效条件：夜里才生效的装饰、到点才演的小剧场，靠的就是这一步
        const { entries } = resolveMixRecipeMaterials(session.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
        const character = active.character?.[0] ?? null;
        // 小票/尾调是多块并行：条件命中的全部在场，每件各自成块各渲染各的
        const tickets = (active.ticket ?? [])
            .filter((m): m is MixTicketMaterial => m.kind === "ticket")
            .map((m) => ({ id: m.id, html: m.renderHtml?.trim() ?? "" }))
            .filter((t) => t.html);
        const encoreMats = (active.encore ?? []).filter((m) => m.kind === "encore");
        // 写了契约 = AI 小剧场（按轮渲染）；没写契约 = 静态小品（挂在对话末尾）
        const aiEncores: { id: string; html: string }[] = [];
        const encoreStatics: { id: string; html: string }[] = [];
        for (const m of encoreMats) {
            if (m.kind !== "encore") continue;
            const html = mixEncoreRenderHtml(m).trim();
            if (!html) continue;
            (m.contract?.trim() ? aiEncores : encoreStatics).push({ id: m.id, html });
        }
        // 装饰与滤网是累加型：条件命中的几件按顺序叠加 / 串联
        const garnishCss = (active.garnish ?? [])
            .map((m) => (m.kind === "garnish" ? m.css.trim() : ""))
            .filter(Boolean)
            .join("\n\n");
        const filterRules = (active.filter ?? []).flatMap((m) => (m.kind === "filter" ? m.rules : []));
        return {
            cover: character?.cover ?? "",
            tickets,
            garnishCss,
            filterRules: filterRules.length ? filterRules : undefined,
            aiEncores,
            encoreStatics,
            // 开场画布：对局里作为故事扉页躺在滚动区最顶上，往上翻可见
            // 开场画布：作者会在里面写 {{user}} / {{char}}，而画布是原样进 iframe 的，
            // 不经过提示词装配，所以在这里替换掉，否则玩家看到的是字面的「{{user}}」
            canvasHtml: character?.kind === "character"
                ? applyMixMacros(
                    (character as MixCharacterCard).canvas?.trim() ?? "",
                    session.charName,
                    session.userName || MIX_DEFAULT_USER_NAME,
                    session.state,
                    { escapeHtml: true },
                )
                : "",
        };
    }, [session, cabinetTick]);

    /**
     * 条件命中、且写了界面的机括：这些是要常驻在对局画面上的界面。
     * 不设数量上限——每件一个 iframe，多开吃内存是玩家自己的选择，
     * 真糊满屏幕还有「一键收起」的逃生口。
     * 摆放取材料自己写的那份；玩家在这一局里拖动过的，以拖过的为准。
     */
    const panels = useMemo(() => {
        if (!session) return [] as { material: MixMechanismMaterial; layout: MixPanelLayout }[];
        const { entries } = resolveMixRecipeMaterials(session.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
        return (active.mechanism ?? [])
            .filter((m): m is MixMechanismMaterial => m.kind === "mechanism" && Boolean(m.panelHtml?.trim()))
            .map((material) => {
                const base = mixPanelLayoutOf(material);
                if (!base) return null;
                const moved = session.panelBox?.[material.id];
                return { material, layout: moved ? { ...base, ...moved } : base };
            })
            .filter((item): item is { material: MixMechanismMaterial; layout: MixPanelLayout } => item !== null);
    }, [session, cabinetTick]);

    /**
     * 按挂点分组：float 走悬浮层（老形态），header/inputbar-* 由宿主画按钮开合，
     * flow-* 作为内嵌卡进滚动流。按钮与容器都是宿主画的，沙盒只管格子里的内容。
     */
    const slotGroups = useMemo(() => {
        const groups = {
            float: [] as typeof panels,
            header: [] as typeof panels,
            "inputbar-left": [] as typeof panels,
            "inputbar-right": [] as typeof panels,
            "flow-top": [] as typeof panels,
            "flow-bottom": [] as typeof panels,
        };
        for (const item of panels) groups[mixPanelSlotOf(item.layout)].push(item);
        return groups;
    }, [panels]);

    /**
     * 回传轮数：默认不限（全部历史都发给模型），玩家在修改方案弹窗里调了才裁。
     * 只裁请求内容，存储与界面回放完整；随对局保存。
     */
    const [histOpen, setHistOpen] = useState(false);
    const setHistoryLimit = useCallback((limit: number | undefined) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        const next: MixSession = { ...current };
        if (limit && limit > 0) next.historyLimit = Math.floor(limit);
        else delete next.historyLimit;
        saveMixSession(next);
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** 按钮位面板的开合，按局记忆；关着的不渲染（要留住的状态放机括存储桶） */
    const dockOpen = session?.panelOpen ?? {};
    const toggleDock = useCallback((materialId: string) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        const next = { ...(current.panelOpen ?? {}) };
        next[materialId] = !next[materialId];
        saveMixSession({ ...current, panelOpen: next });
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /**
     * 机括界面的逃生口。摆放完全交给创作者之后，理论上存在"一块面板糊满整个屏幕、
     * 连输入框都点不到"的材料——不靠限制排版来防，靠这里一键收掉、一键归位。
     */
    const [panelsHidden, setPanelsHidden] = useState(false);

    /** 把这一局里拖过的摆放全部丢掉，退回材料自己写的那份 */
    const resetPanelBoxes = useCallback(() => {
        const current = getMixSession(sessionId);
        if (!current?.panelBox) return;
        const next = { ...current };
        delete next.panelBox;
        saveMixSession(next);
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** 玩家把面板拖过/拉过之后记在这一局里，不回写材料 */
    const handlePanelBox = useCallback((materialId: string, box: { x: number; y: number; w: number; h: number }) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        const previous = current.panelBox?.[materialId];
        if (previous && previous.x === box.x && previous.y === box.y && previous.w === box.w && previous.h === box.h) return;
        saveMixSession({ ...current, panelBox: { ...(current.panelBox ?? {}), [materialId]: { ...(previous ?? {}), ...box } } });
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** 界面写自己的存储 */
    const handlePanelStore = useCallback((materialId: string, store: Record<string, string>) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        // 手改记在当前这一轮上：日后编辑早先某轮重画时，走到这里会再盖一次
        saveMixSession(recordMixPanelStore(current, materialId, store));
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /** 界面写记住的值 */
    const handlePanelState = useCallback((patch: Record<string, string | number>) => {
        const current = getMixSession(sessionId);
        if (!current) return;
        saveMixSession({ ...current, state: { ...(current.state ?? {}), ...patch } });
        setSession(getMixSession(sessionId));
    }, [sessionId]);

    /**
     * 把记住的值挂成对局根节点上的 CSS 变量，装饰里可以直接用：
     *   .mix-game { background: hsl(calc(var(--mix-state-好感度) * 2) 40% 12%); }
     * 变量名里的空白和引号会被换成下划线，避免拼出非法的自定义属性名。
     */
    const stateCssVars = useMemo(() => {
        const vars: Record<string, string> = {};
        for (const [name, value] of Object.entries(session?.state ?? {})) {
            const safe = name.trim().replace(/[\s"'\\;:{}()]/g, "_");
            if (safe) vars[`--mix-state-${safe}`] = String(value);
        }
        return vars as CSSProperties;
    }, [session?.state]);

    /** 上一次 scroll 事件时的位置：撒手判定靠它识别滚动方向 */
    const lastTopRef = useRef(0);

    /** 按当前落点滚一次 */
    const applyStick = useCallback(() => {
        const el = scrollRef.current;
        if (!el || stickRef.current === "free") return;
        el.scrollTop = stickRef.current === "top" ? 0 : el.scrollHeight;
        lastTopRef.current = el.scrollTop;
    }, []);

    /**
     * 进对局定一次落点：没人开过口的局停在扉页顶上（开场画布要从头看），聊过的停在最新一条上。
     * 只认 sessionId——定完就撒手，后面翻页（free）和发言（bottom）都能改它，这里不再回头覆盖。
     * 以前这个 effect 还挂着 busy 和 turns.length：一发言 busy 先翻 true，而用户那一轮要等
     * 落杯前钩子跑完才落库，这一拍读到的还是「没人开过口」，于是把人拽回了扉页顶上。
     *
     * 用 useLayoutEffect 在首帧绘制前就把落点钉好，配合入场幕布（entering）：
     * 滚动区里的小票/小剧场/画布 iframe 都是异步量高的，头几百毫秒内容会连着长高几次，
     * 当着用户的面就是「点进去闪好几下」。幕布期间不可见、每次报高都在幕后重新落位，
     * 揭幕那一刻已经停在正确位置。
     */
    const [entering, setEntering] = useState(true);
    useLayoutEffect(() => {
        setEntering(true);
        const entered = getMixSession(sessionId);
        stickRef.current = (entered?.turns ?? []).some((turn) => turn.role === "user") ? "bottom" : "top";
        applyStick();
        const timer = window.setTimeout(() => {
            applyStick();
            setEntering(false);
        }, 400);
        return () => window.clearTimeout(timer);
    }, [sessionId, applyStick]);

    /** 内容长高了（新一轮到达、生成态切换、流式又写出一段）按当前落点再落一次 */
    useEffect(() => {
        applyStick();
    }, [session?.turns.length, busy, live, applyStick]);

    /**
     * 滚动区里的沙盒 iframe——开场画布、每轮的小票与小剧场、末尾的静态小品——高度都是
     * 里面量好再 postMessage 报上来的：挂载那一刻它们只有几十像素，等报上真实高度，
     * 下面的内容整体被推下去。Chrome 有 scroll anchoring 会自己补偿，iOS Safari 没有，
     * 滚动位置原地不动，于是就停在中间——既不贴顶也不贴底。
     *
     * 这里直接听两种画布的高度消息，比给每个组件挂 onHeight 稳：
     * 一是小票/小剧场那几个框本来就没有回调，二是 RichFrame 的 onHeight 是在 setHeight
     * 之后同步调的，那一刻新高度还没提交进 DOM，落点会按旧的 scrollHeight 算，等于白落。
     * 隔两帧再落，确保 React 提交完、浏览器也重新布局过。
     */
    useEffect(() => {
        const onFrameResize = (event: MessageEvent) => {
            const data = event.data as Record<string, unknown> | null;
            if (!data || data.type !== "resize") return;
            if (data.source !== "mix-rich-frame" && data.source !== "mix-ticket-frame") return;
            requestAnimationFrame(() => requestAnimationFrame(applyStick));
        };
        window.addEventListener("message", onFrameResize);
        return () => window.removeEventListener("message", onFrameResize);
    }, [applyStick]);

    /**
     * 用户自己翻页了就撒手，别在画布撑高时把他拽回去。
     * 「翻页」只认真实手势（滚轮/触摸/按压），不认 scroll 事件本身——
     * iframe 报高会让 scrollHeight 在钉底之后又变大，等 scroll 回调执行时
     * gapBottom 已经是新长出来的那截，按距离判定会把这误当成用户翻走，
     * 从此不再跟底，人就停在半路。没有手势的偏离一律视为内容重排，立刻拉回。
     */
    const gestureAtRef = useRef(0);
    const markGesture = useCallback(() => { gestureAtRef.current = Date.now(); }, []);
    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const prevTop = lastTopRef.current;
        lastTopRef.current = el.scrollTop;
        if (stickRef.current === "free") return;
        const gapTop = el.scrollTop;
        const gapBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const stuck = stickRef.current === "top" ? gapTop <= 8 : gapBottom <= 8;
        if (stuck) return;
        // 用户意图两条通路缺一不可：
        // ① 手势（滚轮/触摸/按压，1.6s 覆盖惯性尾巴）——但手指落在小票/小剧场/画布的
        //    iframe 上时触摸事件被沙盒吃掉、不冒泡，外层什么都收不到；
        // ② 方向启发兜住 ① 的盲区：贴底时 scrollTop 变小（在往上挪）、贴顶时变大，
        //    只有用户滚动才会朝"背离锚点"的方向动——内容重排只会把落点甩远，不会反向。
        const movedAway = stickRef.current === "bottom"
            ? el.scrollTop < prevTop - 1
            : el.scrollTop > prevTop + 1;
        if (movedAway || Date.now() - gestureAtRef.current < 1600) stickRef.current = "free";
        else applyStick();
    }, [applyStick]);

    useEffect(() => () => abortRef.current?.abort(), []);

    // 进对局：还没开口的局用当前角色卡重取开场白。
    // 开场白是建局时写死进 turns[0] 的一条消息，作者改完卡回来本来看不到新的那句；
    // 已经聊过的局不动（refreshMixOpening 自己判），那是真实历史。
    useEffect(() => {
        const res = refreshMixOpening(sessionId);
        if (res?.changed) {
            setSession(res.session);
            onToast("开场白已更新为角色卡最新的一版。");
        }
    }, [sessionId, onToast]);

    // 退出对局：跑一次收摊钩子并收掉这一局的全部沙盒，别让它们挂在页面上。
    // 延后一拍再判：开发期的严格模式会「挂载 → 立刻卸载 → 再挂载」，
    // 直接在清理函数里收摊会在刚进对局时就把这一局收掉。
    useEffect(() => {
        liveMixGames.add(sessionId);
        return () => {
            liveMixGames.delete(sessionId);
            window.setTimeout(() => {
                if (!liveMixGames.has(sessionId)) void runMixSessionEnd(sessionId);
            }, 0);
        };
    }, [sessionId]);

    /**
     * 界面以玩家身份发一句话：走的是和输入框一模一样的路径，不是特权通道。
     * 声明放在「对局不存在」的提前返回之前——Hook 的调用顺序不能随渲染变；
     * 真正的实现在下面挂到 sayRef 上，传给界面的这个函数身份始终不变。
     */
    const sayRef = useRef<(text: string) => void>(() => {});
    const handlePanelSay = useCallback((text: string) => { sayRef.current(text); }, []);

    if (!session) {
        return (
            <div className="mix-game">
                <div className="mix-game-header">
                    <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="返回"><ChevronLeft size={20} /></button>
                    <div className="mix-game-title">对局不存在</div>
                    <span style={{ width: 32 }} />
                </div>
            </div>
        );
    }

    const run = async (action: (signal: AbortSignal, commit: () => void, onDelta: (chunk: string) => void) => Promise<unknown>) => {
        if (busy) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true);
        busyRef.current = true;
        liveRef.current = "";
        setLive("");
        const commit = () => setSession(getMixSession(sessionId));
        const onDelta = (chunk: string) => {
            liveRef.current += chunk;
            if (liveFrameRef.current) return;
            liveFrameRef.current = window.requestAnimationFrame(() => {
                liveFrameRef.current = 0;
                setLive(liveRef.current);
            });
        };
        try {
            const pending = action(controller.signal, commit, onDelta);
            // 重说/回溯那几条在第一个 await 之前就落库了，立刻回读让界面先变；
            // 发送那条的落库晚于这一拍（落杯前钩子是异步的），由引擎回调 commit 补上
            commit();
            await pending;
            commit();
        } catch (error) {
            commit();
            const message = error instanceof Error ? error.message : "生成失败，请重试。";
            if (!controller.signal.aborted) onToast(message);
        } finally {
            if (liveFrameRef.current) {
                window.cancelAnimationFrame(liveFrameRef.current);
                liveFrameRef.current = 0;
            }
            liveRef.current = "";
            setLive("");
            busyRef.current = false;
            setBusy(false);
        }
    };

    const handleSend = () => {
        const text = input.trim();
        if (!text) return;
        setInput("");
        // 一开口就把落点钉到底：用户那一轮要等落杯前钩子跑完才落库，
        // 这中间界面还是「没人开过口」的样子，不钉住就会被拽回扉页顶上
        stickRef.current = "bottom";
        void run((signal, commit, onDelta) => generateMixReply(sessionId, text, signal, commit, onDelta));
    };

    sayRef.current = (text: string) => {
        if (busyRef.current) return;
        stickRef.current = "bottom";
        void run((signal, commit, onDelta) => generateMixReply(sessionId, text, signal, commit, onDelta));
    };

    const copyTurn = (turn: MixTurn) => {
        const done = () => onToast("已复制");
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(turn.text).then(done, () => onToast("复制失败"));
            return;
        }
        const ta = document.createElement("textarea");
        ta.value = turn.text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch { onToast("复制失败"); }
        document.body.removeChild(ta);
    };

    const laterCount = (turnId: string) => {
        const idx = session.turns.findIndex((t) => t.id === turnId);
        return idx < 0 ? 0 : session.turns.length - idx - 1;
    };

    /**
     * 回溯到某一轮时机括能退到什么程度：
     * exact = 那一轮留着快照，精确退回；oldest = 比保留窗口还早，只能退到现存最早的那份；
     * none = 一份快照都没有（更新前的老对局），机括不动。
     * 后两种要在弹窗里说明白，别让玩家以为机括也跟着回到了当时。
     */
    const mechanismRewindKind = (turnId: string): "exact" | "oldest" | "none" => {
        const idx = session.turns.findIndex((t) => t.id === turnId);
        if (idx < 0) return "exact";
        if (session.turns.slice(0, idx + 1).some((t) => t.mechanismStore)) return "exact";
        return session.turns.some((t) => t.mechanismStore) ? "oldest" : "none";
    };

    /** 本局有没有机括：没有就别拿这段说明打扰玩家 */
    const hasMechanism = () => mixSlotEntries(session.recipe.slots, "mechanism")
        .some((e) => getMixMaterial(e.materialId)?.kind === "mechanism");

    const mechanismRewindHint = (turnId: string) => {
        if (!hasMechanism()) return null;
        const kind = mechanismRewindKind(turnId);
        if (kind === "exact") return null;
        return (
            <>
                <br />
                {kind === "oldest"
                    ? `机括存档仅保留最近 ${MIX_STORE_SNAPSHOT_TURNS} 轮，此轮已超出，机括数据将回退至现存最早的存档。`
                    : "此轮无机括存档，机括数据不会回退。"}
            </>
        );
    };

    /**
     * 保存这一条编辑会不会连带删掉后文。
     * 玩家发言：后面的回复是冲着旧发言写的，要删掉重新生成。
     * 角色回复：后面每一轮都能按原文重画时一条不删；重画不了才截断
     *（它们的记住的值与机括存储都是从这一轮累积算出来的，重算不了就只能作废）。
     */
    const editWillTruncate = (turnId: string) => {
        const idx = session.turns.findIndex((t) => t.id === turnId);
        if (idx < 0 || idx === session.turns.length - 1) return false;
        if (session.turns[idx].role === "user") return true;
        return !canReplayMixFrom(session, idx);
    };

    const doRewind = (turnId: string) => {
        try {
            truncateMixAfterTurn(sessionId, turnId);
            setSession(getMixSession(sessionId));
        } catch (error) {
            onToast(error instanceof Error ? error.message : "回溯失败");
        }
    };

    const saveEdit = () => {
        if (!editing) return;
        const target = session.turns.find((t) => t.id === editing.id);
        setEditing(null);
        try {
            editMixTurn(sessionId, editing.id, editing.draft);
            setSession(getMixSession(sessionId));
        } catch (error) {
            onToast(error instanceof Error ? error.message : "保存失败");
            return;
        }
        // 编辑的是玩家发言：直接续生成新回复；编辑角色回复则到此为止
        if (target?.role === "user") {
            void run((signal, _commit, onDelta) => regenerateMixTail(sessionId, signal, onDelta));
            return;
        }
        // 编辑的是角色回复且本局带钩子机括：把新原文交给机括重新收数，不问、不弹窗。
        // 机括的标记行只有它自己的钩子认得，不重跑就会留在正文里裸奔；而"要不要重跑"
        // 从来不是玩家该决定的事——编辑完就该是编辑后的样子。
        // 回滚基准由引擎自己找（前一轮的快照），这里不做判断。
        if (target?.role === "assistant") doEditSync(editing.id);
    };

    const doEditSync = (turnId: string) => {
        void runMixEditSync(sessionId, turnId).then((mode) => {
            setSession(getMixSession(sessionId));
            // 追加要说一声：这一轮太旧、快照已不在，机括那儿会被记成两笔
            onToast(mode === "replayed" ? "已按编辑后的内容重跑这一轮及之后各轮。"
                : mode === "appended" ? "已重跑这一轮（这一轮太旧，重画不了后文，已截断）。"
                : "重跑失败，这一轮没有变化。");
        });
    };

    /**
     * 换料：改本局方案快照的槽位，下一轮装配时生效。
     * 生效条件仍然只在吧台改方案时设置，这里只管加进去和拿出来。
     */
    /**
     * 换装前给历史轮盖戳。小票/小剧场是「每轮存原文 + 渲染代码现取」，局中换件后
     * 新代码解析不了旧格式的原文——所以在换装这一刻，把还没盖过戳的旧轮标上
     * 现役件的 id，并把它的渲染皮快照进对局档案（retiredRender）。此后这些轮
     * 永远按当时的皮回放，旧件从酒柜删掉也不受影响；新轮不盖戳、跟当前件走。
     * 原地编辑材料不经过这里，「同一件改版全局换皮」的特性保留。
     */
    const stampRetiringSkin = (base: MixSession, kind: "ticket" | "encore"): MixSession => {
        const { entries } = resolveMixRecipeMaterials(base.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(base));
        const mats = (active[kind] ?? []).filter((m) => m.kind === kind);
        if (!mats.length) return base;
        // 老格式的轮（单块无归属、没盖过戳）这一刻盖上第一件的戳；多块格式的轮块自带归属，不用戳
        const first = mats[0];
        let touched = false;
        const turns = base.turns.map((t) => {
            if (t.role !== "assistant") return t;
            if (kind === "ticket") {
                if (t.ticketRaws?.length || !t.ticketRaw || t.ticketId) return t;
                touched = true;
                return { ...t, ticketId: first.id };
            }
            if (t.encoreRaws?.length || !t.encoreRaw || t.encoreId) return t;
            touched = true;
            return { ...t, encoreId: first.id };
        });
        // 只快照真被历史轮引用的件的皮——谁退役谁的旧轮都得有皮可回放，没被引用的不占档案
        const referenced = new Set<string>();
        for (const t of turns) {
            if (t.role !== "assistant") continue;
            const blocks = kind === "ticket" ? mixTurnTicketBlocks(t) : mixTurnEncoreBlocks(t);
            for (const block of blocks) {
                if (block.id) referenced.add(block.id);
            }
        }
        const retired: Record<string, string> = { ...base.retiredRender };
        let snapped = false;
        for (const mat of mats) {
            if (!referenced.has(mat.id)) continue;
            const html = kind === "ticket"
                ? (mat.kind === "ticket" ? mat.renderHtml?.trim() ?? "" : "")
                : (mat.kind === "encore" && mat.contract?.trim() ? mixEncoreRenderHtml(mat).trim() : "");
            if (!html) continue;
            retired[mat.id] = html;
            snapped = true;
        }
        if (!touched && !snapped) return base;
        return { ...base, turns: touched ? turns : base.turns, retiredRender: snapped ? retired : base.retiredRender };
    };

    /** 写回槽位；next 为空就把这一格清掉 */
    const writeSlot = (kind: MixMaterialKind, next: MixSlotEntry[]) => {
        const base = kind === "ticket" || kind === "encore" ? stampRetiringSkin(session, kind) : session;
        const slots = { ...base.recipe.slots };
        if (next.length) slots[kind] = next;
        else delete slots[kind];
        const updated: MixSession = { ...base, recipe: { ...base.recipe, slots }, updatedAt: Date.now() };
        saveMixSession(updated);
        setSession(getMixSession(sessionId));
    };

    /** 局内换材料：和吧台一样是「加进去 / 拿出来」，不是整格替换，免得一点就把叠好的几件压成一件 */
    const toggleSlotItem = (kind: MixMaterialKind, materialId: string) => {
        const entries = mixSlotEntries(session.recipe.slots, kind);
        const at = entries.findIndex((e) => e.materialId === materialId);
        if (at >= 0) {
            writeSlot(kind, entries.filter((_, i) => i !== at));
            onToast("已移出，下一轮生效。");
            return;
        }
        // 追加在末尾：叠放是按顺序依次生效的，新加的排在已有的后面
        writeSlot(kind, [...entries, { materialId }]);
        onToast("已加入，下一轮生效。");
    };

    const clearSlot = (kind: MixMaterialKind) => {
        writeSlot(kind, []);
        setSlotPick(null);
        onToast("已清空这一格，下一轮生效。");
    };

    // 本局小票里勾了「记住」的项：叠层编辑器里变量条件的可选项。
    // 每次渲染现算——小票就几件，比为它多背一个 memo 依赖划算
    const slotVarNames: string[] = [];
    for (const entry of mixSlotEntries(session.recipe.slots, "ticket")) {
        const mat = getMixMaterial(entry.materialId);
        if (mat?.kind !== "ticket") continue;
        for (const item of mat.vars ?? []) {
            const name = item.name.trim();
            if (name && !slotVarNames.includes(name)) slotVarNames.push(name);
        }
    }

    /**
     * 按块取皮：块的供稿材料还在场就用它现在的皮（原地改版全局换皮的特性保留）；
     * 不在场了优先用对局档案里的退役快照，档案缺失（老数据）再找酒柜里同 id 的
     * 材料，都没有才退回这一格现役第一件的皮。没归属的块直接用第一件。
     */
    const blockSkin = (
        kind: "ticket" | "encore",
        id: string | undefined,
        actives: { id: string; html: string }[],
    ): string | undefined => {
        const fallback = actives[0]?.html;
        if (!id) return fallback;
        const live = actives.find((a) => a.id === id);
        if (live) return live.html;
        const archived = session.retiredRender?.[id];
        if (archived) return archived;
        const mat = getMixMaterial(id);
        if (kind === "ticket" && mat?.kind === "ticket") {
            // 材料还在但明说没皮（契约型无渲染）：这块不上屏，不硬套别件的皮
            return mat.renderHtml?.trim() ? mat.renderHtml : undefined;
        }
        if (kind === "encore" && mat?.kind === "encore") {
            const html = mixEncoreRenderHtml(mat).trim();
            return html || undefined;
        }
        // 材料已删又没快照的老轮：退回第一件的皮，至少有得看
        return fallback;
    };
    const turnTicketFrames = (turn: MixTurn): TurnFrame[] =>
        mixTurnTicketBlocks(turn)
            .map((block, i) => ({ key: `t${i}`, html: blockSkin("ticket", block.id, assets.tickets) ?? "", raw: block.raw }))
            .filter((f) => f.html && f.raw);
    const turnEncoreFrames = (turn: MixTurn): TurnFrame[] =>
        mixTurnEncoreBlocks(turn)
            .map((block, i) => ({ key: `e${i}`, html: blockSkin("encore", block.id, assets.aiEncores) ?? "", raw: block.raw }))
            .filter((f) => f.html && f.raw);

    const lastTurn = session.turns[session.turns.length - 1];
    const canReroll = !busy && lastTurn?.role === "assistant" && session.turns.length > 1;

    /** 背景观感微调：蒙版提亮（0=原样，100=无蒙版）与封面模糊，按局保存 */
    const [bgTuneOpen, setBgTuneOpen] = useState(false);
    const bgTune = session.bgTune ?? { mask: 0, blur: 0 };
    const setBgTune = (next: { mask: number; blur: number }) => {
        const updated: MixSession = { ...session, bgTune: next };
        saveMixSession(updated);
        setSession(updated);
    };
    const bgStyle: CSSProperties & Record<string, string> = {
        ...(assets.cover ? { backgroundImage: `url(${assets.cover})` } : {}),
        "--mix-bg-mask": String(Math.max(0, 1 - bgTune.mask / 100)),
        // 负亮度 = 蒙版全开之外再压一层匀黑（-40 → 0.4），比默认三段蒙版更暗
        "--mix-bg-dim": String(Math.max(0, -bgTune.mask) / 100),
        "--mix-bg-blur": `${bgTune.blur}px`,
    };

    return (
        <div className="mix-game mix-garnish-scope" style={stateCssVars}>
            {/* 装饰是可分享材料里唯一直接进主文档的代码，注入前先收口到本画面 */}
            {assets.garnishCss ? <style>{scopeMixCss(assets.garnishCss)}</style> : null}
            <div className="mix-game-bg" style={bgStyle} />
            <div className="mix-game-header">
                <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="返回"><ChevronLeft size={20} /></button>
                <div className="mix-game-title">{session.charName}</div>
                {slotGroups.header.map(({ material, layout }) => (
                    <button
                        key={material.id}
                        type="button"
                        className="mix-icon-btn mix-slot-btn"
                        data-on={dockOpen[material.id] ? "true" : undefined}
                        onClick={() => toggleDock(material.id)}
                        aria-label={material.name}
                        title={material.name}
                    >
                        {layout.icon || "◈"}
                    </button>
                ))}
                <button type="button" className="mix-icon-btn" onClick={() => setBgTuneOpen((v) => !v)} aria-label="背景观感" title="背景观感">
                    <Sun size={19} />
                </button>
                <button type="button" className="mix-icon-btn" onClick={() => setRecipeOpen(true)} disabled={busy} aria-label="修改方案" title="修改方案">
                    <MoreHorizontal size={20} />
                </button>
            </div>
            {bgTuneOpen ? (
                <>
                    <div className="mix-bgtune-mask" onClick={() => setBgTuneOpen(false)} />
                    <div className="mix-bgtune">
                        <label className="mix-bgtune-row">
                            <span>蒙版亮度</span>
                            <input
                                type="range"
                                min={-40}
                                max={100}
                                step={1}
                                value={bgTune.mask}
                                onChange={(e) => setBgTune({ ...bgTune, mask: Number(e.target.value) })}
                            />
                        </label>
                        <label className="mix-bgtune-row">
                            <span>背景模糊</span>
                            <input
                                type="range"
                                min={0}
                                max={20}
                                step={1}
                                value={bgTune.blur}
                                onChange={(e) => setBgTune({ ...bgTune, blur: Number(e.target.value) })}
                            />
                        </label>
                        <button type="button" className="mix-bgtune-reset" onClick={() => setBgTune({ mask: 0, blur: 0 })}>恢复默认</button>
                    </div>
                </>
            ) : null}
            <StateBar state={session.state ?? {}} />
            {!panelsHidden && slotGroups.header.some(({ material }) => dockOpen[material.id]) ? (
                <div className="mix-dock-drop" data-from="header">
                    {slotGroups.header.filter(({ material }) => dockOpen[material.id]).map(({ material, layout }) => (
                        <MixMechanismInline
                            key={material.id}
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            plateDefault={layout.plate !== false}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                        />
                    ))}
                </div>
            ) : null}
            <div
                className="mix-game-scroll"
                ref={scrollRef}
                data-entering={entering ? "true" : undefined}
                onScroll={handleScroll}
                onWheel={markGesture}
                onTouchStart={markGesture}
                onTouchMove={markGesture}
                onPointerDown={markGesture}
            >
                {assets.canvasHtml ? (
                    <div className="mix-game-canvas">
                        <MixRichText text={assets.canvasHtml} />
                    </div>
                ) : null}
                {slotGroups["flow-top"].map(({ material, layout }) => (
                    <div className="mix-flow-panel" data-at="top" key={material.id}>
                        <MixMechanismInline
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            plateDefault={layout.plate !== false}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                        />
                    </div>
                ))}
                {session.turns.map((turn, idx) => {
                    const isLast = idx === session.turns.length - 1;
                    const actions = (
                        <TurnActions
                            align={turn.role === "user" ? "right" : "left"}
                            disabled={busy}
                            canRewind={!isLast}
                            onCopy={() => copyTurn(turn)}
                            onRewind={() => setConfirm({ type: "rewind", turnId: turn.id })}
                            onEdit={() => setEditing({ id: turn.id, draft: mixTurnRawText(turn) })}
                            key={`act-${turn.id}`}
                        />
                    );
                    return turn.role === "user" ? (
                        <div className="mix-user-turn" data-with-actions="true" key={turn.id}>
                            <div className="mix-user-bubble">{turn.text}</div>
                            {actions}
                        </div>
                    ) : (
                        <div className="mix-assistant-turn" key={turn.id}>
                            <AssistantTurn turn={turn} ticketFrames={turnTicketFrames(turn)} encoreFrames={turnEncoreFrames(turn)} filterRules={assets.filterRules} state={turn.state} />
                            {actions}
                        </div>
                    );
                })}
                {busy ? (() => {
                    // 流式过程中同样过一遍「仅显示」滤网，写出来的样子和落库后一致
                    const shown = applyMixFilterRules(mixStreamText(live), assets.filterRules, "display");
                    return shown ? (
                        <div className="mix-live-turn">
                            <MixProseView text={shown} />
                        </div>
                    ) : (
                        <div className="mix-game-thinking" aria-label="生成中">
                            <span /><span /><span />
                        </div>
                    );
                })() : null}
                {slotGroups["flow-bottom"].map(({ material, layout }) => (
                    <div className="mix-flow-panel" data-at="bottom" key={material.id}>
                        <MixMechanismInline
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            plateDefault={layout.plate !== false}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                        />
                    </div>
                ))}
                {assets.encoreStatics.map((item) => (
                    <div className="mix-encore-inline" key={item.id}>
                        <MixRichText text={item.html} />
                    </div>
                ))}
            </div>
            {slotGroups.float.length && !panelsHidden ? (
                <div className="mix-panel-layer">
                    {slotGroups.float.map(({ material, layout }) => (
                        <MixMechanismPanel
                            key={material.id}
                            materialId={material.id}
                            name={material.name}
                            layout={layout}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                            onBox={handlePanelBox}
                        />
                    ))}
                </div>
            ) : null}
            {!panelsHidden && [...slotGroups["inputbar-left"], ...slotGroups["inputbar-right"]].some(({ material }) => dockOpen[material.id]) ? (
                <div className="mix-dock-drop" data-from="input">
                    {[...slotGroups["inputbar-left"], ...slotGroups["inputbar-right"]].filter(({ material }) => dockOpen[material.id]).map(({ material, layout }) => (
                        <MixMechanismInline
                            key={material.id}
                            materialId={material.id}
                            name={material.name}
                            html={material.panelHtml ?? ""}
                            state={session.state ?? {}}
                            store={session.mechanismStore?.[material.id] ?? {}}
                            plateDefault={layout.plate !== false}
                            onStore={handlePanelStore}
                            onState={handlePanelState}
                            onSay={handlePanelSay}
                        />
                    ))}
                </div>
            ) : null}
            {repairNote !== null ? (
                <div className="mix-repair-toast" role="status">
                    <span className="mix-repair-dots" aria-hidden="true"><i /><i /><i /></span>
                    {repairNote ? `「${repairNote}」状态栏补写中` : "状态栏补写中"}
                </div>
            ) : null}
            <div className="mix-game-inputbar">
                {slotGroups["inputbar-left"].map(({ material, layout }) => (
                    <button
                        key={material.id}
                        type="button"
                        className="mix-icon-btn mix-slot-btn"
                        data-on={dockOpen[material.id] ? "true" : undefined}
                        onClick={() => toggleDock(material.id)}
                        aria-label={material.name}
                        title={material.name}
                    >
                        {layout.icon || "◈"}
                    </button>
                ))}
                <button
                    type="button"
                    className="mix-icon-btn"
                    onClick={() => void run((signal, _commit, onDelta) => rerollMixReply(sessionId, signal, onDelta))}
                    disabled={!canReroll}
                    aria-label="重说"
                    title="重说"
                >
                    <RotateCcw size={18} />
                </button>
                <textarea
                    className="mix-game-input"
                    rows={1}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                    placeholder={busy ? "调制中…" : "说点什么…"}
                    disabled={busy}
                />
                <button
                    type="button"
                    className="mix-icon-btn"
                    onClick={() => void run((signal, _commit, onDelta) => continueMix(sessionId, signal, onDelta))}
                    disabled={busy}
                    aria-label="继续生成"
                    title="继续生成"
                >
                    <WandSparkles size={18} />
                </button>
                {slotGroups["inputbar-right"].map(({ material, layout }) => (
                    <button
                        key={material.id}
                        type="button"
                        className="mix-icon-btn mix-slot-btn"
                        data-on={dockOpen[material.id] ? "true" : undefined}
                        onClick={() => toggleDock(material.id)}
                        aria-label={material.name}
                        title={material.name}
                    >
                        {layout.icon || "◈"}
                    </button>
                ))}
                <button type="button" className="mix-send-btn" onClick={handleSend} disabled={busy || !input.trim()} aria-label="发送">
                    <Send size={16} />
                </button>
            </div>

            {/* 修改方案：换本局的槽位材料 */}
            {recipeOpen ? (
                <div className="mix-sheet-mask" onClick={() => setRecipeOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">修改方案</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setRecipeOpen(false)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-struct-note">只改这一局，下一轮生成时生效，已写出的内容不变；不影响吧台里保存的方案。</div>
                            <div className="mix-panel-ops">
                                {panels.length ? (
                                    <>
                                        <button type="button" className="mix-dock-chip" data-on={panelsHidden ? "true" : undefined} onClick={() => setPanelsHidden((v) => !v)}>
                                            {panelsHidden ? "显示机括界面" : "暂时收起机括界面"}
                                        </button>
                                        <button type="button" className="mix-dock-chip" onClick={() => { resetPanelBoxes(); onToast("机括界面已归位。"); }}>
                                            界面归位
                                        </button>
                                    </>
                                ) : null}
                                <button
                                    type="button"
                                    className="mix-dock-chip"
                                    data-on={session.historyLimit || histOpen ? "true" : undefined}
                                    onClick={() => setHistOpen((v) => !v)}
                                >
                                    {session.historyLimit ? `回传近 ${session.historyLimit} 轮` : "回传全部历史"}
                                </button>
                            </div>
                            {histOpen ? (
                                <div className="mix-histlimit">
                                    <span>回传轮数</span>
                                    <input
                                        type="range"
                                        min={2}
                                        max={60}
                                        step={1}
                                        value={session.historyLimit ?? 60}
                                        onChange={(e) => setHistoryLimit(Number(e.target.value))}
                                    />
                                    <b>{session.historyLimit ?? "不限"}</b>
                                    <button type="button" className="mix-dock-chip" onClick={() => setHistoryLimit(undefined)}>不限</button>
                                </div>
                            ) : null}
                            <div className="mix-bar-hint">左右滑动切换槽位 · 点击槽位整理材料、顺序与生效条件</div>
                            <div className="mix-wheel" ref={wheelRef} onScroll={handleWheelScroll}>
                                {MIX_SLOT_ORDER.map((kind) => {
                                    const stack = mixSlotEntries(session.recipe.slots, kind);
                                    const mat = stack[0] ? getMixMaterial(stack[0].materialId) : null;
                                    const extra = stack.length - 1;
                                    const locked = kind === "character";
                                    return (
                                        <div
                                            className="mix-slot"
                                            data-filled={mat ? "true" : undefined}
                                            data-locked={locked ? "true" : undefined}
                                            key={kind}
                                            onClick={() => { if (!locked) setSlotEdit(kind); }}
                                        >
                                            <div className="mix-slot-kind">
                                                <b>{MIX_KIND_LABELS[kind]}</b>
                                                {locked ? <i>本局不可换</i> : <i>可留空</i>}
                                            </div>
                                            <div className="mix-slot-body">
                                                {mat ? (
                                                    <>
                                                        {mat.cover ? (
                                                            // eslint-disable-next-line @next/next/no-img-element
                                                            <img className="mix-slot-cover" src={mat.cover} alt={mat.name} />
                                                        ) : (
                                                            <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                        )}
                                                        <div className="mix-slot-name">{mat.name}{extra > 0 ? ` +${extra}` : ""}</div>
                                                        {mat.hook ? <div className="mix-slot-hook">{mat.hook}</div> : null}
                                                    </>
                                                ) : locked ? (
                                                    <>
                                                        <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                        <div className="mix-slot-name">{session.charName}</div>
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
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 局内叠层编辑：与吧台同一套（排序 / 生效条件 / 移除），改动即存、下一轮生效 */}
            {slotEdit ? (
                <MixSlotEditor
                    kind={slotEdit}
                    entries={mixSlotEntries(session.recipe.slots, slotEdit)}
                    resolve={(id) => getMixMaterial(id)}
                    varNames={slotVarNames}
                    onChange={(next) => writeSlot(slotEdit, next)}
                    onPickMore={() => setSlotPick(slotEdit)}
                    onClose={() => setSlotEdit(null)}
                />
            ) : null}

            {slotPick ? (
                <div className="mix-sheet-mask" onClick={() => setSlotPick(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">
                                {MIX_KIND_LABELS[slotPick]} · 已放 {mixSlotEntries(session.recipe.slots, slotPick).length} 件
                            </div>
                            <button type="button" className="mix-icon-btn" onClick={() => setSlotPick(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-bar-hint">点一下加入或移出 · 叠了多件按从上到下的顺序依次生效</div>
                            <div className="mix-mat-list">
                                {mixSlotEntries(session.recipe.slots, slotPick).length ? (
                                    <div className="mix-mat-row" onClick={() => clearSlot(slotPick)}>
                                        <div className="mix-mat-row-glyph"><X size={18} /></div>
                                        <div className="mix-mat-info">
                                            <div className="mix-mat-name"><span>不用这味 · 清空槽位</span></div>
                                        </div>
                                    </div>
                                ) : null}
                                {listMixPickables(slotPick).map((m) => (
                                    <div className="mix-mat-row" data-kind={m.kind} onClick={() => toggleSlotItem(slotPick, m.id)} key={m.id}>
                                        <div className="mix-mat-row-glyph"><KindGlyph kind={m.kind} size={22} /></div>
                                        <div className="mix-mat-info">
                                            <div className="mix-mat-name">
                                                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
                                                {(() => {
                                                    const at = mixSlotEntries(session.recipe.slots, slotPick).findIndex((e: MixSlotEntry) => e.materialId === m.id);
                                                    // 叠了多件时标出它排第几，顺序就是生效顺序
                                                    return at >= 0 ? <span className="mix-mat-badge">已放{mixSlotEntries(session.recipe.slots, slotPick).length > 1 ? ` · 第 ${at + 1} 件` : ""}</span> : null;
                                                })()}
                                            </div>
                                            {m.hook ? <div className="mix-mat-hook">{m.hook}</div> : null}
                                        </div>
                                    </div>
                                ))}
                                {listMixPickables(slotPick).length === 0 ? (
                                    <div className="mix-comment-empty">酒柜里还没有{MIX_KIND_LABELS[slotPick]}——去酒柜页自建一件。</div>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 编辑消息：大弹窗，assistant 轮编辑的是含格式块的原始输出 */}
            {editing ? (() => {
                const editingTurn = session.turns.find((t) => t.id === editing.id);
                return (
                    <div className="mix-sheet-mask" ref={editMaskRef} onClick={() => setEditing(null)}>
                        <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                            <div className="mix-sheet-head">
                                <div className="mix-sheet-title">编辑消息</div>
                                <button type="button" className="mix-icon-btn" onClick={() => setEditing(null)} aria-label="关闭"><X size={18} /></button>
                            </div>
                            <div className="mix-sheet-body">
                                {editingTurn?.role === "assistant" ? (
                                    <div className="mix-struct-note">
                                        这里是这一轮的<b>原始输出</b>——[状态栏]/[小剧场] 块也在里面。
                                        模型输出掉了格式可以在这儿手动修，保存后会重新解析渲染。
                                    </div>
                                ) : null}
                                <textarea
                                    className="mix-textarea mix-edit-large"
                                    value={editing.draft}
                                    onChange={(e) => setEditing({ id: editing.id, draft: e.target.value })}
                                />
                                <div className="mix-turn-edit-actions">
                                    <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setEditing(null)}>取消</button>
                                    <button
                                        type="button"
                                        className="mix-pill-btn"
                                        onClick={() => {
                                            if (editWillTruncate(editing.id)) setConfirm({ type: "edit", turnId: editing.id });
                                            else saveEdit();
                                        }}
                                    >
                                        保存{editingTurn?.role === "user" ? "并重新生成" : ""}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })() : null}

            {confirm ? (
                <MixConfirm
                    title={confirm.type === "rewind" ? "回溯到这条消息？" : "保存修改？"}
                    body={confirm.type === "rewind"
                        ? <>这条消息之后的 {laterCount(confirm.turnId)} 条内容将被删除。{mechanismRewindHint(confirm.turnId)}</>
                        : `保存后，这条消息之后的 ${laterCount(confirm.turnId)} 条内容将被删除${session.turns.find((t) => t.id === confirm.turnId)?.role === "user" ? "，并重新生成回复" : ""}。`}
                    confirmText={confirm.type === "rewind" ? "回溯" : "保存"}
                    tone="danger"
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        const target = confirm;
                        setConfirm(null);
                        if (target.type === "rewind") doRewind(target.turnId);
                        else saveEdit();
                    }}
                />
            ) : null}

        </div>
    );
}
