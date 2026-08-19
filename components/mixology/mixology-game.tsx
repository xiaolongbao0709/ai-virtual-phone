"use client";

// 独家特调 · 对局画面：角色封面打底 + 三段蒙版，AI 正文无气泡全宽、
// 玩家右侧气泡、小票全宽卡；全程无任何标签徽章，保沉浸。
// 装饰材料的 CSS 以 <style> 注入本画面容器（认 .mix-* 官方语义类）。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, Copy, History, MoreHorizontal, Pencil, Plus, RotateCcw, Send, WandSparkles, X } from "lucide-react";
import { continueMix, editMixTurn, generateMixReply, mixTurnRawText, refreshMixOpening, regenerateMixTail, rerollMixReply, runMixSessionEnd, truncateMixAfterTurn } from "@/lib/mixology/engine";
import { getMixMaterial, getMixSession, listMixPickables, resolveMixRecipeMaterials, saveMixSession } from "@/lib/mixology/storage";
import { applyMixMacros, MIX_DEFAULT_USER_NAME } from "@/lib/mixology/assembler";
import { buildMixConditionContext, pickActiveMixMaterials } from "@/lib/mixology/state";
import { scopeMixCss } from "@/lib/mixology/css-scope";
import { MIX_KIND_LABELS, MIX_SLOT_MAX, MIX_SLOT_ORDER, mixEncoreRenderHtml, mixPanelLayoutOf, mixSlotEntries, type MixCharacterCard, type MixFilterRule, type MixMaterialKind, type MixMechanismMaterial, type MixPanelLayout, type MixSession, type MixSlotEntry, type MixState, type MixTurn } from "@/lib/mixology/types";
import { applyMixFilterRules, mixStreamText } from "@/lib/mixology/prose";
import { MixProseView } from "./prose-view";
import { MixRichText } from "./rich-text";
import { KindGlyph, MixConfirm } from "./mixology-shared";
import { MixTicketFrame } from "./ticket-frame";
import { MixMechanismPanel } from "./mechanism-panel";

/** 当前真正挂着的对局：严格模式的重复挂载靠它区分「真退出」与「假卸载」 */
/** 同时活动的常驻界面上限：每件一个 iframe，手机上多开吃内存，屏幕也摆不下 */
const MIX_PANEL_MAX = 3;

const liveMixGames = new Set<string>();

type GameProps = {
    sessionId: string;
    onBack: () => void;
    onToast: (message: string) => void;
};

function AssistantTurn({ turn, ticketHtml, encoreHtml, filterRules, state }: { turn: MixTurn; ticketHtml?: string; encoreHtml?: string; filterRules?: MixFilterRule[]; state?: MixState }) {
    // 展示顺序：状态栏在正文前、小剧场在正文后（与模型的输出顺序一致，无需重排）
    // 滤网「仅显示」模式在这里生效：存储不动，渲染前替换，历史消息也即时生效
    const shownText = applyMixFilterRules(turn.text, filterRules, "display");
    return (
        <>
            {ticketHtml && turn.ticketRaw ? (
                <div className="mix-ticket-wrap">
                    <MixTicketFrame html={ticketHtml} raw={turn.ticketRaw} state={state} />
                </div>
            ) : null}
            {shownText ? <MixProseView text={shownText} /> : null}
            {encoreHtml && turn.encoreRaw ? (
                <div className="mix-encore-turn">
                    <MixTicketFrame html={encoreHtml} raw={turn.encoreRaw} state={state} />
                </div>
            ) : null}
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
    const [confirm, setConfirm] = useState<{ type: "rewind" | "edit"; turnId: string } | null>(null);
    const [recipeOpen, setRecipeOpen] = useState(false);
    const [slotPick, setSlotPick] = useState<MixMaterialKind | null>(null);
    const [wheelIndex, setWheelIndex] = useState(0);
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
        if (!session) return { cover: "", ticketHtml: undefined as string | undefined, garnishCss: "", encoreTurnHtml: undefined as string | undefined, encoreStaticHtml: "", canvasHtml: "", filterRules: undefined as MixFilterRule[] | undefined };
        // 渲染侧同样吃生效条件：夜里才生效的装饰、到点才演的小剧场，靠的就是这一步
        const { entries } = resolveMixRecipeMaterials(session.recipe);
        const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
        const character = active.character?.[0] ?? null;
        const ticket = active.ticket?.[0] ?? null;
        const encore = active.encore?.[0] ?? null;
        // 装饰与滤网是累加型：条件命中的几件按顺序叠加 / 串联
        const garnishCss = (active.garnish ?? [])
            .map((m) => (m.kind === "garnish" ? m.css.trim() : ""))
            .filter(Boolean)
            .join("\n\n");
        const filterRules = (active.filter ?? []).flatMap((m) => (m.kind === "filter" ? m.rules : []));
        const encoreMat = encore?.kind === "encore" ? encore : null;
        const encoreRender = encoreMat ? mixEncoreRenderHtml(encoreMat).trim() : "";
        const encoreHasContract = Boolean(encoreMat?.contract?.trim());
        return {
            cover: character?.cover ?? "",
            ticketHtml: ticket?.kind === "ticket" ? ticket.renderHtml : undefined,
            garnishCss,
            filterRules: filterRules.length ? filterRules : undefined,
            // 写了契约 = AI 小剧场（按轮渲染）；没写契约 = 静态小品（挂在对话末尾）
            encoreTurnHtml: encoreHasContract && encoreRender ? encoreRender : undefined,
            encoreStaticHtml: !encoreHasContract ? encoreRender : "",
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
    }, [session]);

    /**
     * 条件命中、且写了界面的机括：这些是要常驻在对局画面上的界面。
     * 上限 3 件——每件一个 iframe，手机上多开吃内存。
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
            .filter((item): item is { material: MixMechanismMaterial; layout: MixPanelLayout } => item !== null)
            .slice(0, MIX_PANEL_MAX);
    }, [session]);

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
        saveMixSession({ ...current, mechanismStore: { ...(current.mechanismStore ?? {}), [materialId]: store } });
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

    /** 按当前落点滚一次 */
    const applyStick = useCallback(() => {
        const el = scrollRef.current;
        if (!el || stickRef.current === "free") return;
        el.scrollTop = stickRef.current === "top" ? 0 : el.scrollHeight;
    }, []);

    /**
     * 进对局定一次落点：没人开过口的局停在扉页顶上（开场画布要从头看），聊过的停在最新一条上。
     * 只认 sessionId——定完就撒手，后面翻页（free）和发言（bottom）都能改它，这里不再回头覆盖。
     * 以前这个 effect 还挂着 busy 和 turns.length：一发言 busy 先翻 true，而用户那一轮要等
     * 落杯前钩子跑完才落库，这一拍读到的还是「没人开过口」，于是把人拽回了扉页顶上。
     */
    useEffect(() => {
        const entered = getMixSession(sessionId);
        stickRef.current = (entered?.turns ?? []).some((turn) => turn.role === "user") ? "bottom" : "top";
        applyStick();
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

    /** 用户自己翻页了就撒手，别在画布撑高时把他拽回去 */
    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el || stickRef.current === "free") return;
        const gapTop = el.scrollTop;
        const gapBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const stuck = stickRef.current === "top" ? gapTop <= 8 : gapBottom <= 8;
        if (!stuck) stickRef.current = "free";
    }, []);

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
        }
    };

    /**
     * 换料：改本局方案快照的槽位，下一轮装配时生效。
     * 生效条件仍然只在吧台改方案时设置，这里只管加进去和拿出来。
     */
    /** 写回槽位；next 为空就把这一格清掉 */
    const writeSlot = (kind: MixMaterialKind, next: MixSlotEntry[]) => {
        const slots = { ...session.recipe.slots };
        if (next.length) slots[kind] = next;
        else delete slots[kind];
        const updated: MixSession = { ...session, recipe: { ...session.recipe, slots }, updatedAt: Date.now() };
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
        if (entries.length >= MIX_SLOT_MAX) {
            onToast(`一格最多放 ${MIX_SLOT_MAX} 件，先移出一件。`);
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

    const lastTurn = session.turns[session.turns.length - 1];
    const canReroll = !busy && lastTurn?.role === "assistant" && session.turns.length > 1;

    return (
        <div className="mix-game mix-garnish-scope" style={stateCssVars}>
            {/* 装饰是可分享材料里唯一直接进主文档的代码，注入前先收口到本画面 */}
            {assets.garnishCss ? <style>{scopeMixCss(assets.garnishCss)}</style> : null}
            <div className="mix-game-bg" style={assets.cover ? { backgroundImage: `url(${assets.cover})` } : undefined} />
            <div className="mix-game-header">
                <button type="button" className="mix-icon-btn" onClick={onBack} aria-label="返回"><ChevronLeft size={20} /></button>
                <div className="mix-game-title">{session.charName}</div>
                <button type="button" className="mix-icon-btn" onClick={() => setRecipeOpen(true)} disabled={busy} aria-label="修改方案" title="修改方案">
                    <MoreHorizontal size={20} />
                </button>
            </div>
            <StateBar state={session.state ?? {}} />
            <div className="mix-game-scroll" ref={scrollRef} onScroll={handleScroll}>
                {assets.canvasHtml ? (
                    <div className="mix-game-canvas">
                        <MixRichText text={assets.canvasHtml} />
                    </div>
                ) : null}
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
                            <AssistantTurn turn={turn} ticketHtml={assets.ticketHtml} encoreHtml={assets.encoreTurnHtml} filterRules={assets.filterRules} state={turn.state} />
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
                {assets.encoreStaticHtml ? (
                    <div className="mix-encore-inline">
                        <MixRichText text={assets.encoreStaticHtml} />
                    </div>
                ) : null}
            </div>
            {panels.length && !panelsHidden ? (
                <div className="mix-panel-layer">
                    {panels.map(({ material, layout }) => (
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
            <div className="mix-game-inputbar">
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
                            {panels.length ? (
                                <div className="mix-panel-ops">
                                    <button type="button" className="mix-dock-chip" data-on={panelsHidden ? "true" : undefined} onClick={() => setPanelsHidden((v) => !v)}>
                                        {panelsHidden ? "显示机括界面" : "暂时收起机括界面"}
                                    </button>
                                    <button type="button" className="mix-dock-chip" onClick={() => { resetPanelBoxes(); onToast("机括界面已归位。"); }}>
                                        界面归位
                                    </button>
                                </div>
                            ) : null}
                            <div className="mix-bar-hint">左右滑动切换槽位 · 点击槽位换材料</div>
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
                                            onClick={() => { if (!locked) setSlotPick(kind); }}
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

            {slotPick ? (
                <div className="mix-sheet-mask" onClick={() => setSlotPick(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">
                                {MIX_KIND_LABELS[slotPick]} · 已放 {mixSlotEntries(session.recipe.slots, slotPick).length}/{MIX_SLOT_MAX}
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
                    <div className="mix-sheet-mask" onClick={() => setEditing(null)}>
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
                                            if (laterCount(editing.id) > 0) setConfirm({ type: "edit", turnId: editing.id });
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
                        ? `这条消息之后的 ${laterCount(confirm.turnId)} 条内容将被删除。`
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
