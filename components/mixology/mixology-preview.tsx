"use client";

// 独家特调 · 材料预览：那几类"要眼见为实"的材料，编辑器与详情页共用同一套试穿——
// 小票喂示例数据渲染，装饰套在样例正文上，尾调进沙盒跑，滤网拿样文试洗，
// 机括摆进一块假的对局画面里，界面能拖能点、钩子能当场跑一遍看它还回来什么。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, Copy, Play, X } from "lucide-react";
import { MixProseView } from "./prose-view";
import { MixRichText } from "./rich-text";
import { MixTicketFrame } from "./ticket-frame";
import { MixMechanismPanel } from "./mechanism-panel";
import { scopeMixCss } from "@/lib/mixology/css-scope";
import { MIX_HOOK_LABELS, type MixHook } from "@/lib/mixology/mechanism-protocol";
import { disposeMixSandboxesForMaterial, runMixHook } from "@/lib/mixology/mechanism-runtime";
import { applyMixFilterRules } from "@/lib/mixology/prose";
import { MIX_CRAFT_PROMPTS } from "@/lib/mixology/crafting-guides";
import { MIX_KIND_LABELS, mixEncoreRenderHtml, type MixFilterRule, type MixMaterial, type MixMaterialKind, type MixPanelLayout, type MixState } from "@/lib/mixology/types";

/** 装饰预览用的样例正文：覆盖五种正文标记，方便作者一眼看全 */
const GARNISH_SAMPLE = [
    "【便利店 · 打烊前十分钟】",
    "他把最后一排关东煮的竹签码齐，抬眼看见你还站在门口没走。",
    "「伞带了吗。」不是问句，是陈述。*每次都这样，明知故问。*",
    "外头的雨把整条街敲得发亮，~只剩这一盏灯还醒着~。",
].join("\n");

export type MixPreviewTarget =
    | { kind: "ticket"; html: string; raw: string }
    | { kind: "garnish"; css: string }
    | { kind: "encore"; html: string; raw?: string }
    | { kind: "canvas"; html: string; cover?: string }
    | { kind: "filter"; rules: MixFilterRule[] }
    | { kind: "mechanism"; name: string; html: string; layout: MixPanelLayout; script: string };

/**
 * 预览内容本体：各类材料的"眼见为实"。
 * guide=false 是详情页（看别人的作品）：收掉「先去某个框里写」这类写作指引——
 * 看的人手边没有编辑器，那些话只会让人摸不着头脑。
 */
function MixPreviewBody({ target, guide = true }: { target: MixPreviewTarget; guide?: boolean }) {
    return (
        <>
        {target.kind === "ticket" ? (
            target.raw.trim() ? (
                <>
                    <div className="mix-detail-label">用「预览示例数据」渲染的效果</div>
                    <div className="mix-ticket-wrap" style={{ marginTop: 8 }}>
                        <MixTicketFrame html={target.html} raw={target.raw} />
                    </div>
                </>
            ) : guide ? (
                <div className="mix-comment-empty">
                    先在「预览示例数据」里写几行示例，
                    <br />
                    这里就能看到小票渲染成什么样。
                </div>
            ) : (
                <div className="mix-comment-empty">作者没留预览示例数据，这张小票要进对局才看得到效果。</div>
            )
        ) : null}

        {target.kind === "garnish" ? (
            <>
                <div className="mix-detail-label">套在样例对局上的效果</div>
                {/* 试穿也走同一套收口，所见即对局里的实际效果。舞台带标题栏与输入栏——
                    外观管的是整个对局画面，只摆正文会让人以为部件类不生效 */}
                <div className="mix-garnish-stage mix-garnish-scope">
                    <style>{scopeMixCss(target.css)}</style>
                    <div className="mix-game-header" style={{ marginTop: 0 }}>
                        <span className="mix-icon-btn" aria-hidden="true"><ChevronLeft size={18} /></span>
                        <div className="mix-game-title">试穿舞台</div>
                        <span className="mix-icon-btn" aria-hidden="true"><Play size={14} /></span>
                    </div>
                    <MixProseView text={GARNISH_SAMPLE} />
                    <div className="mix-user-turn">
                        <div className="mix-user-bubble">我把伞递过去，「一起走？」</div>
                    </div>
                    <div className="mix-game-inputbar" style={{ pointerEvents: "none" }}>
                        <div className="mix-game-input" style={{ opacity: 0.75 }}>发送消息…</div>
                        <span className="mix-send-btn"><Play size={14} /></span>
                    </div>
                </div>
                {guide ? <>
                <div className="mix-detail-label" style={{ marginTop: 14 }}>可用的官方类名</div>
                <div className="mix-detail-value" data-code="true">
                    {[
                        "── 正文语义类 ──",
                        ".mix-prose    正文容器（默认 14px / 行高 1.75）",
                        ".mix-para     普通段落（默认首行缩进 2em，不想缩写 text-indent: 0）",
                        ".mix-scene    场景过场行（【】）",
                        ".mix-dialogue 对白（「」）",
                        ".mix-thought  心声（* *）",
                        ".mix-accent   强调（~ ~）",
                        ".mix-narration 叙述",
                        "",
                        "── 界面部件类 ──",
                        ".mix-game        对局画面根（body / html / :root 也等同于它）",
                        ".mix-game-bg     封面背景层",
                        ".mix-game-header 顶部标题栏（可换装不可藏：返回按钮在里面）",
                        ".mix-game-title  标题文字",
                        ".mix-icon-btn    图标按钮（标题栏与输入栏两侧）",
                        ".mix-game-scroll 对话滚动区",
                        ".mix-user-turn / .mix-user-bubble  玩家轮 / 玩家气泡",
                        ".mix-assistant-turn 每轮 AI 回复的容器",
                        ".mix-turn-act    消息角落的复制/回溯/编辑小按钮",
                        ".mix-game-inputbar 底部输入栏",
                        ".mix-game-input  输入框",
                        ".mix-send-btn    发送按钮",
                        ".mix-state-bar / .mix-state-chip  记住值状态条 / 小芯片",
                        ".mix-ticket-wrap 状态栏卡片外框",
                        ".mix-encore-inline 小剧场容器",
                        ".mix-game-thinking 生成中指示",
                        "",
                        "样式只在对局画面内生效，改不到应用的其他页面",
                    ].join("\n")}
                </div>
                </> : null}
            </>
        ) : null}

        {target.kind === "filter" ? <MixFilterStage rules={target.rules} /> : null}

        {target.kind === "canvas" ? (
            <>
                <div className="mix-detail-label">铺在封面蒙版上的效果</div>
                <div
                    className="mix-canvas-stage"
                    style={target.cover ? { backgroundImage: `url(${target.cover})` } : undefined}
                >
                    <div className="mix-canvas-stage-body">
                        <MixRichText text={target.html} />
                    </div>
                </div>
            </>
        ) : null}

        {target.kind === "mechanism" ? <MixMechanismStage target={target} /> : null}

        {target.kind === "encore" ? (
            <>
                <div className="mix-detail-label">{target.raw?.trim() ? "用「预览示例数据」渲染的效果" : "静态小品的运行效果"}</div>
                <div style={{ marginTop: 8, borderRadius: 12, overflow: "hidden", background: "rgba(255,255,255,0.03)" }}>
                    <MixTicketFrame html={target.html} raw={target.raw ?? ""} />
                </div>
            </>
        ) : null}
        </>
    );
}


/** 滤网试洗的默认样文：星号加长破折号，最常见的两类清洗对象 */
const FILTER_SAMPLE = "**他顿了顿**——「嗯……今天也加班？」";

/**
 * 滤网试洗：贴一段样文，即时看全部规则跑完的结果。
 * 与编辑器里的「试跑」同口径：不分模式、按顺序全部跑一遍，写错的正则自动作废。
 */
function MixFilterStage({ rules }: { rules: MixFilterRule[] }) {
    const [sample, setSample] = useState(FILTER_SAMPLE);
    const result = useMemo(
        () => applyMixFilterRules(applyMixFilterRules(sample, rules, "context"), rules, "display"),
        [sample, rules],
    );
    return (
        <>
            <div className="mix-detail-label">贴一段样文，看规则跑完的结果</div>
            <textarea
                className="mix-textarea"
                style={{ minHeight: 72, marginTop: 8 }}
                value={sample}
                onChange={(e) => setSample(e.target.value)}
            />
            {sample ? <div className="mix-filter-result">{result || "（全部被清空了）"}</div> : null}
        </>
    );
}

/** 机括试摆用的假对局：正文与角色名都写死，只是给面板一个真实比例的舞台 */
const MECH_SAMPLE = [
    "【打烊后的吧台】",
    "他把最后一只杯子倒扣在架上，没有回头。",
    "「你今天话很少。」",
].join("\n");
const MECH_CHAR = "程既白";
const MECH_USER = "阿澜";
/** 试跑钩子时喂进去的示例文本 */
const MECH_SAY = "我把杯子推回去，「今天不想说话。」";
const MECH_REPLY = "【吧台】\n他没接话，只是把灯调暗了两档。\n「那就坐着。」";
/** 试摆用的假对局 id：与真对局的沙盒互不相干 */
const MECH_SESSION = "mixpreview";
const MECH_MATERIAL = "mixpreview-mech";

function short(value: string, max = 220): string {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * 机括试摆。
 * 上半是一块按对局画面比例画的舞台，面板就按它自己写的摆放落在上面——能拖、能点、
 * 界面调 mix.setStore / mix.say 都当真处理，作者看得见它到底落在哪、有多大。
 * 下半是钩子试跑：喂一份示例数据进沙盒跑一遍，把还回来的东西原样摊开。
 * 存储是同一份——钩子写完界面立刻能看见，这正是机括两半配合的样子。
 */
function MixMechanismStage({ target }: { target: Extract<MixPreviewTarget, { kind: "mechanism" }> }) {
    /**
     * 舞台按对局画面的真实长宽比来画。写死一个比例的话，同一份百分比摆放在这里和在
     * 对局里落到的位置就不是一回事——「预览和实际不一样」多半出在这。
     */
    const shellRef = useRef<HTMLDivElement | null>(null);
    const [ratio, setRatio] = useState("9 / 19.5");
    useEffect(() => {
        const app = shellRef.current?.closest(".mixology-app") ?? (typeof document !== "undefined" ? document.querySelector(".mixology-app") : null);
        const rect = app?.getBoundingClientRect();
        if (rect?.width && rect.height) setRatio(`${Math.round(rect.width)} / ${Math.round(rect.height)}`);
    }, []);
    const [store, setStore] = useState<Record<string, string>>({});
    const [state, setState] = useState<MixState>({});
    const [box, setBox] = useState<Partial<MixPanelLayout> | null>(null);
    const [said, setSaid] = useState<string[]>([]);
    const [turn, setTurn] = useState(0);
    const [running, setRunning] = useState<MixHook | "">("");
    const [result, setResult] = useState<{ hook: MixHook; lines: string[] } | null>(null);

    // 代码改了就把旧沙盒收掉，否则跑的还是上一版
    useEffect(() => {
        disposeMixSandboxesForMaterial(MECH_MATERIAL);
        return () => disposeMixSandboxesForMaterial(MECH_MATERIAL);
    }, [target.script]);

    const layout = useMemo(() => ({ ...target.layout, ...(box ?? {}) }), [target.layout, box]);

    const fire = useCallback(async (hook: MixHook) => {
        if (!target.script.trim()) return;
        setRunning(hook);
        const payload = {
            hook,
            turnCount: turn,
            state,
            store,
            charName: MECH_CHAR,
            userName: MECH_USER,
            text: hook === "beforeSend" ? MECH_SAY : hook === "afterReply" ? MECH_REPLY : undefined,
            ticketRaw: hook === "afterReply" ? "好感度：61\n地点：吧台" : undefined,
            encoreRaw: undefined,
        };
        const out = await runMixHook(MECH_SESSION, MECH_MATERIAL, target.script, hook, payload);
        const lines: string[] = [];
        if (typeof out.text === "string") lines.push(`正文改写\n${short(out.text, 400)}`);
        if (out.note) lines.push(`临时提示 · ${out.note.length} 字\n${short(out.note, 600)}`);
        if (out.state) lines.push(`记住的值 · ${Object.entries(out.state).map(([k, v]) => `${k}=${v}`).join("、")}`);
        if (out.store) {
            lines.push(`存储 · ${Object.entries(out.store).map(([k, v]) => `${k}（${v.length} 字）`).join("、") || "已清空"}`);
            setStore(out.store);
        }
        if (out.state) setState((prev) => ({ ...prev, ...out.state }));
        if (!lines.length) lines.push("没有返回。");
        setResult({ hook, lines });
        setRunning("");
        if (hook === "afterReply") setTurn((n) => n + 1);
    }, [target.script, turn, state, store]);

    const hasPanel = target.html.trim().length > 0;

    return (
        <>
            {hasPanel ? (
            <>
            <div className="mix-detail-label">界面</div>
            <div className="mix-mech-stage" ref={shellRef} style={{ aspectRatio: ratio }}>
                <div className="mix-mech-bar">{MECH_CHAR}</div>
                <div className="mix-mech-prose"><MixProseView text={MECH_SAMPLE} /></div>
                <div className="mix-mech-input" />
                <div className="mix-panel-layer">
                    {target.html.trim() ? (
                        <MixMechanismPanel
                            materialId={MECH_MATERIAL}
                            name={target.name || "机括"}
                            layout={layout}
                            html={target.html}
                            state={state}
                            store={store}
                            onStore={(_id, next) => setStore(next)}
                            onState={(patch) => setState((prev) => ({ ...prev, ...patch }))}
                            onSay={(text) => setSaid((prev) => [...prev.slice(-2), text])}
                            onBox={(_id, next) => setBox(next)}
                        />
                    ) : null}
                </div>
            </div>
            {box ? (
                <div className="mix-mech-hint">
                    已拖动过 · <button type="button" className="mix-mech-reset" onClick={() => setBox(null)}>归位</button>
                </div>
            ) : null}
            </>
            ) : null}

            <div className="mix-detail-label" style={hasPanel ? { marginTop: 14 } : undefined}>钩子 · 第 {turn} 轮</div>
            <div className="mix-dock-row">
                {(Object.keys(MIX_HOOK_LABELS) as MixHook[]).map((hook) => (
                    <button
                        type="button"
                        className="mix-dock-chip"
                        key={hook}
                        disabled={!target.script.trim() || Boolean(running)}
                        data-on={result?.hook === hook ? "true" : undefined}
                        onClick={() => void fire(hook)}
                    >
                        {running === hook ? "跑…" : MIX_HOOK_LABELS[hook]}
                    </button>
                ))}
                <button type="button" className="mix-dock-chip" onClick={() => { setStore({}); setState({}); setSaid([]); setTurn(0); setResult(null); }}>
                    重置
                </button>
            </div>
            {!target.script.trim() ? <div className="mix-mech-hint">没写钩子逻辑。</div> : null}
            {result ? (
                <div className="mix-detail-value" data-code="true">
                    {result.lines.join("\n\n")}
                </div>
            ) : null}

            {Object.keys(store).length || Object.keys(state).length || said.length ? (
                <>
                    <div className="mix-detail-label" style={{ marginTop: 14 }}>现在的状态</div>
                    <div className="mix-detail-value" data-code="true">
                        {[
                            `存储 · ${Object.keys(store).length ? Object.entries(store).map(([k, v]) => `${k} = ${short(v, 90)}`).join("\n     ") : "空"}`,
                            `记住的值 · ${Object.keys(state).length ? Object.entries(state).map(([k, v]) => `${k}=${v}`).join("、") : "空"}`,
                            said.length ? `界面说过 · ${said.map((t) => short(t, 90)).join("\n     ")}` : "",
                        ].filter(Boolean).join("\n")}
                    </div>
                </>
            ) : null}
        </>
    );
}

/** 取一个能代表"内容变了"的键：用来给刷新做去抖，避免每敲一个字就重建沙盒 */
function previewKey(target: MixPreviewTarget): string {
    switch (target.kind) {
        case "ticket": return `t${target.html}${target.raw}`;
        case "garnish": return `g${target.css}`;
        case "encore": return `e${target.html}${target.raw ?? ""}`;
        case "canvas": return `c${target.html}${target.cover ?? ""}`;
        case "filter": return `f${JSON.stringify(target.rules)}`;
        case "mechanism": return `m${target.html}${target.script}${JSON.stringify(target.layout)}`;
    }
}

/**
 * 就地展开的预览：按钮点一下在下面直接铺开，不再弹窗。
 * 弹窗盖在整页上，作者一边改一边看时得反复开关，还容易根本没注意到它弹出来了。
 */
export function MixPreviewInline({
    label,
    target,
    disabled,
    guide,
}: {
    label: string;
    target: MixPreviewTarget;
    disabled?: boolean;
    /** false = 详情页语境：预览里不出现"先去某个框里写"这类编辑器指引 */
    guide?: boolean;
}) {
    const [open, setOpen] = useState(false);
    // 展开后是一直看得见的，若每次按键都重建 srcDoc，iframe 会不停闪。
    // 停手 400ms 再跟上：既是活的预览，也不闪。
    const [shown, setShown] = useState<MixPreviewTarget | null>(null);
    const latest = useRef(target);
    latest.current = target;
    const panelRef = useRef<HTMLDivElement | null>(null);
    const key = previewKey(target);

    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => setShown(latest.current), 400);
        return () => window.clearTimeout(timer);
    }, [open, key]);

    // 按钮可能正好在视口最下缘，展开的东西在屏幕外——那又变成"没注意到"了
    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => {
            panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 60);
        return () => window.clearTimeout(timer);
    }, [open]);

    // 内容被清空时收起，免得留一块空面板
    useEffect(() => {
        if (disabled && open) setOpen(false);
    }, [disabled, open]);

    return (
        <div className="mix-preview-inline">
            <button
                type="button"
                className="mix-pill-btn"
                data-open={open ? "true" : undefined}
                aria-expanded={open}
                onClick={() => {
                    if (!open) setShown(latest.current);
                    setOpen((prev) => !prev);
                }}
                disabled={disabled}
            >
                <Play size={13} style={{ verticalAlign: "-2px" }} /> {label}
                <ChevronDown size={13} className="mix-preview-caret" style={{ verticalAlign: "-2px" }} />
            </button>
            {open && shown ? (
                <div className="mix-preview-panel" ref={panelRef}>
                    <MixPreviewBody target={shown} guide={guide} />
                </div>
            ) : null}
        </div>
    );
}

// ── 提示词结构速查 ──
// 让作者知道自己写的东西最终落在提示词的哪一段、和别的材料怎么排队。

const STRUCTURE_ROWS: { section: string; from: string; kind?: string }[] = [
    { section: "（固定开场说明）", from: "系统自带，声明这是角色扮演、越靠后优先级越高" },
    { section: "# 扮演总纲", from: "基底（叠多件时每件一个 ##，标题取材料名）", kind: "base" },
    { section: "# 角色资料", from: "角色卡，每个框一个 ##：角色名 / 基础信息 / 性格 / 外貌 / 背景", kind: "character" },
    { section: "# 用户资料", from: "面具，每个框一个 ##：名字 / 用户人设（写了才有这一段）", kind: "persona" },
    { section: "# 世界与剧情", from: "角色卡，每个框一个 ##：世界观 / 对{{user}}的初始认知 / 关系与身份 / 当前剧情 / 附加设定", kind: "character" },
    { section: "# 文风", from: "风味（叠多件时每件一个 ##，标题取材料名）", kind: "flavor" },
    { section: "# 正文输出要求", from: "两个 ##：内置的正文标记规则（在前）+ 杯型内容（在后）", kind: "glass" },
    { section: "# 状态栏", from: "格式说明在前，小票的「输出契约」是一个 ##，壳为 [状态栏]...[/状态栏]", kind: "ticket" },
    { section: "# 小剧场", from: "格式说明在前，尾调的「输出契约」是一个 ##，壳为 [小剧场]...[/小剧场]", kind: "encore" },
    { section: "# 示例对话", from: "角色卡：示例对话", kind: "character" },
    { section: "# 输出格式检查", from: "系统自带的收尾核对清单（带状态栏/小剧场时出现）" },
];

export function MixStructureSheet({ highlight, onClose }: { highlight?: string; onClose: () => void }) {
    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-head">
                    <div className="mix-sheet-title">提示词结构</div>
                    <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
                </div>
                <div className="mix-sheet-body">
                    <div className="mix-struct-note">
                        <b>编辑器里的框标题，就是提示词里的标题。</b>没填的框整段消失；
                        文本里的 <code>{"{{char}}"}</code> / <code>{"{{user}}"}</code> 会换成角色名和你填的名字。
                    </div>

                    <div className="mix-detail-label" style={{ marginTop: 14 }}>系统提示词（对话历史之前）</div>
                    <div className="mix-struct-list">
                        {STRUCTURE_ROWS.map((row) => (
                            <div className="mix-struct-row" data-on={highlight && row.kind === highlight ? "true" : undefined} key={row.section}>
                                <div className="mix-struct-section">{row.section}</div>
                                <div className="mix-struct-from">← {row.from}</div>
                            </div>
                        ))}
                    </div>

                    <div className="mix-struct-divider">［ 对话历史 ］</div>

                    <div className="mix-struct-list">
                        <div className="mix-struct-row" data-on={highlight === "strength" ? "true" : undefined}>
                            <div className="mix-struct-section">【最高优先级要求】</div>
                            <div className="mix-struct-from">← 苦精（唯一放在历史之后的部分，离生成最近、最难被忘）</div>
                        </div>
                    </div>

                    <div className="mix-struct-divider">［ 本轮生成 ］</div>

                    <div className="mix-detail-label" style={{ marginTop: 16 }}>不进提示词的部分</div>
                    <div className="mix-struct-note" data-on={highlight === "filter" ? "true" : undefined}>
                        <b>外观</b>的 CSS、<b>小票与尾调</b>的渲染代码、<b>开场画布</b>、<b>滤网</b>的规则都只在界面里执行，
                        写多长都不占上下文。<b>开场白</b>作为对局的第一条角色消息单独送出，也不在系统提示词里。
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── 制作说明 ──
// 每类材料一份写好的委托词：复制发给任意 AI，末尾补一句自己的想法，
// 拿回来的内容按【框名】逐段贴回编辑器。文案本体在 lib/mixology/crafting-guides.ts。

export function MixCraftSheet({ kind, onClose }: { kind: MixMaterialKind; onClose: () => void }) {
    const prompt = MIX_CRAFT_PROMPTS[kind];
    const [copied, setCopied] = useState(false);

    const copy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(prompt);
        } catch {
            // 剪贴板 API 不可用（旧内核 / 非安全上下文）：退回选区复制
            const box = document.createElement("textarea");
            box.value = prompt;
            box.style.position = "fixed";
            box.style.opacity = "0";
            document.body.appendChild(box);
            box.select();
            try { document.execCommand("copy"); } finally { box.remove(); }
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
    }, [prompt]);

    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-head">
                    <div className="mix-sheet-title">发给 AI 的制作说明 · {MIX_KIND_LABELS[kind]}</div>
                    <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
                </div>
                <div className="mix-sheet-body">
                    <div className="mix-struct-note">
                        下面是一份写好的<b>委托词</b>：整段复制发给任意 AI（豆包、DeepSeek、ChatGPT 都行），
                        在末尾<b>【我的想法】</b>处补上你的点子，AI 就会按编辑器的框逐段产出内容，逐框贴回来即可。
                    </div>
                    <button type="button" className="mix-craft-copy" data-done={copied ? "true" : undefined} onClick={() => void copy()}>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        {copied ? "已复制，去发给 AI 吧" : "复制委托词"}
                    </button>
                    <div className="mix-craft-text">{prompt}</div>
                </div>
            </div>
        </div>
    );
}

/**
 * 半宽缩样容器：内容按两倍宽渲染再 scale(0.5)，视觉上等于手机全宽比例。
 * transform 不改布局高度，这里用 ResizeObserver 量内层实际高度、给外层
 * 一半——卡片高度就跟着渲染内容走，矮小票出矮卡，长装饰出长卡。
 */
function HalfScale({ children }: { children: ReactNode }) {
    const innerRef = useRef<HTMLDivElement | null>(null);
    const [height, setHeight] = useState(120);
    useEffect(() => {
        const el = innerRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => setHeight(Math.max(60, Math.ceil(el.offsetHeight / 2))));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return (
        <div style={{ position: "relative", height, overflow: "hidden" }}>
            <div ref={innerRef} style={{ position: "absolute", top: 0, left: 0, width: "200%", transform: "scale(0.5)", transformOrigin: "0 0" }}>
                {children}
            </div>
        </div>
    );
}

/**
 * 瀑布卡的自动封面：没配封面的小票/装饰/尾调，用自己的渲染效果缩样当海报——
 * 这几类材料"长什么样"本来就该由渲染代码说话，不必再让作者传一张图。
 * 卡片高度跟随缩样实际高度（HalfScale 量高）；渲染不出来（缺示例数据、
 * 缺代码）时返回 null。角色卡除外：它的封面是人物立绘，画布缩样代替不了。
 */
/** 这件材料能不能渲染出自动封面：MatCard 据此决定走缩样流还是占位纹 */
export function mixMatHasAutoCover(material: MixMaterial): boolean {
    if (material.kind === "ticket") return Boolean(material.renderHtml?.trim() && material.previewRaw?.trim());
    if (material.kind === "encore") {
        if (!mixEncoreRenderHtml(material).trim()) return false;
        return !(material.contract?.trim() && !material.previewRaw?.trim());
    }
    if (material.kind === "garnish") return Boolean(material.css.trim());
    return false;
}

export function MixMatAutoCover({ material }: { material: MixMaterial }) {
    if (material.kind === "ticket") {
        const html = material.renderHtml?.trim() ?? "";
        const raw = material.previewRaw?.trim() ?? "";
        if (!html || !raw) return null;
        return <HalfScale><MixTicketFrame html={html} raw={raw} /></HalfScale>;
    }
    if (material.kind === "encore") {
        const html = mixEncoreRenderHtml(material).trim();
        if (!html) return null;
        const raw = material.previewRaw?.trim() ?? "";
        // AI 供稿型没留示例数据就渲染不出内容，别摆一张空壳
        if (material.contract?.trim() && !raw) return null;
        return <HalfScale><MixTicketFrame html={html} raw={raw} /></HalfScale>;
    }
    if (material.kind === "garnish") {
        if (!material.css.trim()) return null;
        return (
            <HalfScale>
                <div className="mix-garnish-stage mix-garnish-scope" style={{ margin: 0, border: "none", borderRadius: 0 }}>
                    <style>{scopeMixCss(material.css)}</style>
                    <MixProseView text={GARNISH_SAMPLE} />
                </div>
            </HalfScale>
        );
    }
    return null;
}
