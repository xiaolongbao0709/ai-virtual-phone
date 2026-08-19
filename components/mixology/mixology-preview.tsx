"use client";

// 独家特调 · 创作工坊预览：那几类"要眼见为实"的材料，在编辑器里就地试穿——
// 小票喂示例数据渲染，装饰套在样例正文上，尾调进沙盒跑，
// 机括摆进一块假的对局画面里，界面能拖能点、钩子能当场跑一遍看它还回来什么。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Play, X } from "lucide-react";
import { MixProseView } from "./prose-view";
import { MixRichText } from "./rich-text";
import { MixTicketFrame } from "./ticket-frame";
import { MixMechanismPanel } from "./mechanism-panel";
import { scopeMixCss } from "@/lib/mixology/css-scope";
import { MIX_HOOK_LABELS, type MixHook } from "@/lib/mixology/mechanism-protocol";
import { disposeMixSandboxesForMaterial, runMixHook } from "@/lib/mixology/mechanism-runtime";
import type { MixPanelLayout, MixState } from "@/lib/mixology/types";

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
    | { kind: "mechanism"; name: string; html: string; layout: MixPanelLayout; script: string };

/** 预览内容本体：四类材料各自的"眼见为实" */
function MixPreviewBody({ target }: { target: MixPreviewTarget }) {
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
            ) : (
                <div className="mix-comment-empty">
                    先在「预览示例数据」里写几行示例，
                    <br />
                    这里就能看到小票渲染成什么样。
                </div>
            )
        ) : null}

        {target.kind === "garnish" ? (
            <>
                <div className="mix-detail-label">套在样例正文上的效果</div>
                {/* 试穿也走同一套收口，所见即对局里的实际效果 */}
                <div className="mix-garnish-stage mix-garnish-scope">
                    <style>{scopeMixCss(target.css)}</style>
                    <MixProseView text={GARNISH_SAMPLE} />
                    <div className="mix-user-turn">
                        <div className="mix-user-bubble">我把伞递过去，「一起走？」</div>
                    </div>
                </div>
                <div className="mix-detail-label" style={{ marginTop: 14 }}>可用的官方类名</div>
                <div className="mix-detail-value" data-code="true">
                    {[
                        ".mix-prose    正文容器（默认 14px / 行高 1.75）",
                        ".mix-para     普通段落（默认首行缩进 2em，不想缩写 text-indent: 0）",
                        ".mix-scene    场景过场行（【】）",
                        ".mix-dialogue 对白（「」）",
                        ".mix-thought  心声（* *）",
                        ".mix-accent   强调（~ ~）",
                        ".mix-narration 叙述",
                        ".mix-user-bubble 玩家气泡",
                        ".mix-ticket-wrap 小票外框",
                        "",
                        "body / html / :root  等同于整个对局画面",
                        "样式只在对局画面内生效，改不到应用的其他页面",
                    ].join("\n")}
                </div>
            </>
        ) : null}

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
}: {
    label: string;
    target: MixPreviewTarget;
    disabled?: boolean;
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
                    <MixPreviewBody target={shown} />
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
