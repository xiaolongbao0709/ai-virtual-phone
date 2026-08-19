"use client";

// 独家特调 · 材料编辑器：八类材料的自建/编辑表单（底部弹层里渲染）。
// Phase ③ 先给够用的表单闭环，创作工坊阶段再上专业编辑体验。

import { useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Plus, Trash2 } from "lucide-react";
import type {
    MixCharacterCard,
    MixFilterRule,
    MixMaterial,
    MixMaterialKind,
    MixTextMaterial,
    MixTicketVar,
} from "@/lib/mixology/types";
import { createMixId, formatMixTags, MIX_KIND_LABELS, MIX_PANEL_DEFAULT_LAYOUT, MIX_TAG_MAX, mixKindHasCover, mixPanelLayoutOf, parseMixTags } from "@/lib/mixology/types";
import { applyMixFilterRules } from "@/lib/mixology/prose";
import { MixPreviewInline, MixStructureSheet } from "./mixology-preview";

const OPENING_SEPARATOR = "\n---\n";

/** 每类材料点进来先说清楚：这是干什么的、写完落在提示词哪一段 */
const KIND_GUIDE: Record<MixMaterialKind, { what: string; where: string }> = {
    character: {
        what: "这里写角色资料：身份、外貌、性格、所处世界、与玩家的初始关系，以及开场白与示例对话。",
        where: "进入「角色资料」「世界与剧情」「示例对话」三段。",
    },
    persona: {
        what: "这里写用户人设：{{user}} 是谁——身份、性格、外貌，以及与{{char}}之间那段关系里你这一侧的设定。",
        where: "进入「用户资料」段；填了名字就替换全部 {{user}}。",
    },
    base: {
        what: "这里写扮演总纲：如何入戏、能否代替玩家发言、是否允许冲突与负面情绪。约束态度，不涉及文笔。",
        where: "进入提示词首段。",
    },
    flavor: {
        what: "这里写文风：句式长短、叙述视角、侧重动作还是心理。仅约束写法，不承载角色设定。",
        where: "进入「文风」段。",
    },
    glass: {
        what: "这里写正文输出要求：每轮的段落数量、叙述节奏与收笔方式。正文标记规则（「」对白、* * 心声、【】场景、~ ~ 强调）由系统内置在本段开头，不必重复写。",
        where: "接在内置的正文标记规则之后。",
    },
    strength: {
        what: "这里写最高优先级要求：一到两条最需要被贯彻的规则。因排在全部对话之后、生成之前，模型对其服从度最高；条目越多越互相稀释。",
        where: "排在全部对话之后、生成之前，模型最难忽略。",
    },
    ticket: {
        what: "这里写状态栏：每轮附带的一张数据卡，好感度、当前心情、随身物品等由创作者自定。契约决定模型报告什么，渲染代码决定卡片如何呈现。",
        where: "契约进提示词；渲染代码只在界面执行。",
    },
    garnish: {
        what: "这里写界面样式：正文配色、对白字体、气泡形态，以 CSS 编写。写 body / html / :root 等同于「整个对局画面」。",
        where: "不进提示词，只改呈现，不占上下文。",
    },
    encore: {
        what: "这里写小剧场：正文之外的加演，例如朋友圈动态、一段监控录像。契约决定 AI 何时写什么，渲染代码决定它长什么样；契约留空则为纯静态小品。",
        where: "契约进提示词；渲染代码只在界面执行。",
    },
    mechanism: {
        what: "一段在沙盒里跑的逻辑，加一块常驻在对局画面上的界面。两半共用同一份存储，可以只写一半。",
        where: "不进提示词，跑在断网的沙盒里。",
    },
    filter: {
        what: "这里写滤网：一组正则替换规则，自动清洗 AI 正文里的怪癖。每条可选「仅显示」（只在渲染时替换，改规则对全部历史立即生效）或「进上下文」（入库前清洗，只对新回复生效）。",
        where: "不进提示词，只清洗正文。",
    },
};

/**
 * 作者要在框里再分小标题时该用哪一级。
 * 应用自己占了 # 与 ##（段标题与框标题），三级往下全留给作者。
 * 不进提示词的几种材料（外观/机括/滤网）不显示这行。
 */
const HEADING_NOTE = "要在框里加小标题，用 ### 开头（# 和 ## 已被应用占用）。";
const HEADING_NOTE_KINDS: MixMaterialKind[] = ["character", "persona", "base", "flavor", "glass", "strength", "ticket", "encore"];

/** 文本类材料（基底/风味/杯型/苦精）的字段名与示例 */
const TEXT_FIELD_COPY: Record<"base" | "flavor" | "glass" | "strength", { label: string; placeholder: string }> = {
    base: {
        label: "扮演总纲",
        placeholder: "例：\n你将完全成为{{char}}，以第一视角活在故事里。\n- 绝不跳出角色，绝不以 AI 自称。\n- 绝不代替{{user}}说话或做决定。\n- 允许出现冲突、拒绝与负面情绪，贴合人设比讨好{{user}}更重要。",
    },
    flavor: {
        label: "文风",
        placeholder: "例：\n克制的短句，多写动作、气味和环境细节，少写心理解说。\n对话之间留白，不把话说满。",
    },
    glass: {
        label: "正文输出要求",
        placeholder: "例：\n以第三人称小说正文输出，每轮 2~4 个自然段，段落之间空一行。\n- 叙述里穿插动作与环境细节，不写成流水账。\n- 在留有余韵处收笔，给{{user}}接话的空间。",
    },
    strength: {
        label: "最高优先级要求",
        placeholder: "一到两条即可，例：\n始终保持{{char}}的克制感，不要替{{user}}总结感受。",
    },
};

/** 封面统一压到 900px 内的 JPEG dataURL，避免 kv 被大图撑爆 */
async function readCoverFile(file: File): Promise<string> {
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
    const max = 900;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale >= 1 && dataUrl.length < 400_000) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
}

type EditorProps = {
    kind: MixMaterialKind;
    initial?: MixMaterial;
    onSave: (material: MixMaterial) => void;
    onCancel: () => void;
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <>
            <label className="mix-form-label">
                {label}
                {hint ? <> · <b>{hint}</b></> : null}
            </label>
            {children}
        </>
    );
}

export function MixMaterialEditor({ kind, initial, onSave, onCancel }: EditorProps) {
    const isCharacter = kind === "character";
    const initialCard = isCharacter && initial?.kind === "character" ? (initial as MixCharacterCard) : null;

    const [name, setName] = useState(initial?.name ?? "");
    const [hook, setHook] = useState(initial?.hook ?? "");
    const [tagsText, setTagsText] = useState(formatMixTags(initial?.tags));
    const [cover, setCover] = useState(initial?.cover ?? "");
    // 角色卡专属
    const [baseInfo, setBaseInfo] = useState(initialCard?.baseInfo ?? "");
    const [personality, setPersonality] = useState(initialCard?.personality ?? "");
    const [appearance, setAppearance] = useState(initialCard?.appearance ?? "");
    const [background, setBackground] = useState(initialCard?.background ?? "");
    const [worldview, setWorldview] = useState(initialCard?.worldview ?? "");
    const [cognition, setCognition] = useState(initialCard?.cognition ?? "");
    const [relations, setRelations] = useState(initialCard?.relations ?? "");
    const [plot, setPlot] = useState(initialCard?.plot ?? "");
    const [extra, setExtra] = useState(initialCard?.extra ?? "");
    const [openingsText, setOpeningsText] = useState(initialCard?.openings.join(OPENING_SEPARATOR) ?? "");
    const [canvas, setCanvas] = useState(initialCard?.canvas ?? "");
    const [examples, setExamples] = useState<{ role: "user" | "char"; text: string }[]>(
        initialCard?.examples ? initialCard.examples.map((e) => ({ ...e })) : [],
    );
    // 文本类 / 小票 / 装饰 / 尾调
    const [content, setContent] = useState(
        initial && "content" in initial ? (initial as MixTextMaterial).content : "",
    );
    const [personaUserName, setPersonaUserName] = useState(initial?.kind === "persona" ? initial.userName ?? "" : "");
    const [contract, setContract] = useState(initial?.kind === "ticket" ? initial.contract : "");
    const [renderHtml, setRenderHtml] = useState(initial?.kind === "ticket" ? initial.renderHtml : "");
    const [previewRaw, setPreviewRaw] = useState(initial?.kind === "ticket" ? initial.previewRaw ?? "" : "");
    const [vars, setVars] = useState<MixTicketVar[]>(initial?.kind === "ticket" ? initial.vars ?? [] : []);
    const [script, setScript] = useState(initial?.kind === "mechanism" ? initial.script ?? "" : "");
    // 摆放不进表单：界面代码里用 mix.move / mix.size / mix.chrome … 自己定。
    // 老材料带着的那份原样保留，免得改一次名字就把人家摆好的位置抹了。
    const keptLayout = initial?.kind === "mechanism" ? initial.layout : undefined;
    const keptDock = initial?.kind === "mechanism" ? initial.dock : undefined;
    const [panelHtml, setPanelHtml] = useState(initial?.kind === "mechanism" ? initial.panelHtml ?? "" : "");

    /**
     * 从契约正文里认出「字段名：说明」这样的行，做成一排可点的候选。
     * 创作者写契约时本来就在列每轮报告什么，这里只是把那些名字捡出来让他点一下，
     * 不用再手打一遍（打错一个字就抽不到值）。
     */
    const contractFieldNames = useMemo(() => {
        const names: string[] = [];
        for (const line of contract.split(/\r?\n/)) {
            const matched = /^\s*[-*·]?\s*([^：:=\s][^：:=]{0,11})\s*[：:=]/.exec(line);
            if (!matched) continue;
            const name = matched[1].trim();
            if (name && !names.includes(name)) names.push(name);
        }
        return names.slice(0, 12);
    }, [contract]);
    const [css, setCss] = useState(initial?.kind === "garnish" ? initial.css : "");
    const [html, setHtml] = useState(initial?.kind === "encore" ? (initial.renderHtml ?? initial.html ?? "") : "");
    const [encoreContract, setEncoreContract] = useState(initial?.kind === "encore" ? initial.contract ?? "" : "");
    const [encorePreviewRaw, setEncorePreviewRaw] = useState(initial?.kind === "encore" ? initial.previewRaw ?? "" : "");
    // 滤网
    const [rules, setRules] = useState<MixFilterRule[]>(
        initial?.kind === "filter" ? initial.rules.map((r) => ({ ...r })) : [],
    );
    const [filterSample, setFilterSample] = useState("");
    // 试跑：所有规则按顺序全部跑一遍（不分模式），看替换效果；正则写错的条目单独标出来
    const filterTest = useMemo(() => {
        const badIndexes: number[] = [];
        rules.forEach((rule, i) => {
            if (!rule.find) return;
            try { new RegExp(rule.find, "g"); } catch { badIndexes.push(i); }
        });
        const result = filterSample
            ? applyMixFilterRules(applyMixFilterRules(filterSample, rules, "context"), rules, "display")
            : "";
        return { badIndexes, result };
    }, [rules, filterSample]);
    const [error, setError] = useState("");
    const [structureOpen, setStructureOpen] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

    // 标签：输入的时候就按最终口径拆好给作者看，免得存下来才发现被掐了
    const tags = useMemo(() => parseMixTags(tagsText), [tagsText]);
    const tagsDropped = useMemo(() => {
        const all = new Set(tagsText.split(/[,，、|｜#＃\s]+/).map((t) => t.trim()).filter(Boolean));
        return Math.max(0, all.size - tags.length);
    }, [tagsText, tags.length]);

    const handleCoverFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            setCover(await readCoverFile(file));
        } catch {
            setError("封面图读取失败，请换一张试试。");
        }
    };

    const handleSave = () => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError("先给这件材料起个名字。");
            return;
        }
        const meta = {
            id: initial?.id ?? createMixId("mixmat"),
            name: trimmedName,
            hook: hook.trim() || undefined,
            author: initial?.author,
            tags: tags.length ? tags : undefined,
            cover: cover || undefined,
            createdAt: initial?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
        };
        if (isCharacter) {
            const openings = openingsText
                .split(/\n\s*---\s*(?:\n|$)/)
                .map((o) => o.trim())
                .filter(Boolean);
            if (!openings.length) {
                setError("至少写一段开场白，开局才有酒可端。");
                return;
            }
            const card: MixCharacterCard = {
                ...meta,
                kind: "character",
                charName: trimmedName,
                baseInfo: baseInfo.trim() || undefined,
                personality: personality.trim() || undefined,
                appearance: appearance.trim() || undefined,
                background: background.trim() || undefined,
                worldview: worldview.trim() || undefined,
                cognition: cognition.trim() || undefined,
                relations: relations.trim() || undefined,
                plot: plot.trim() || undefined,
                extra: extra.trim() || undefined,
                openings,
                examples: examples.filter((e) => e.text.trim()).map((e) => ({ role: e.role, text: e.text.trim() })),
                canvas: canvas.trim() || undefined,
                authorNote: initialCard?.authorNote,
            };
            onSave(card);
            return;
        }
        if (kind === "ticket") {
            if (!contract.trim() || !renderHtml.trim()) {
                setError("小票需要同时写「输出契约」和「渲染代码」。");
                return;
            }
            const cleanVars = vars
                .map((v) => ({ name: v.name.trim(), initial: v.initial?.trim() || undefined }))
                .filter((v, i, all) => v.name && all.findIndex((x) => x.name === v.name) === i);
            onSave({ ...meta, kind: "ticket", contract: contract.trim(), renderHtml, previewRaw: previewRaw.trim() || undefined, vars: cleanVars.length ? cleanVars : undefined });
            return;
        }
        if (kind === "mechanism") {
            onSave({
                ...meta,
                kind: "mechanism",
                script: script.trim() || undefined,
                layout: keptLayout,
                dock: keptDock,
                panelHtml: panelHtml.trim() || undefined,
            });
            return;
        }
        if (kind === "garnish") {
            if (!css.trim()) {
                setError("外观不能是空的，写点 CSS 吧。");
                return;
            }
            onSave({ ...meta, kind: "garnish", css });
            return;
        }
        if (kind === "encore") {
            if (!html.trim()) {
                setError("尾调的渲染代码不能为空。");
                return;
            }
            onSave({
                ...meta,
                kind: "encore",
                contract: encoreContract.trim() || undefined,
                renderHtml: html,
                previewRaw: encorePreviewRaw.trim() || undefined,
            });
            return;
        }
        if (kind === "persona") {
            if (!content.trim()) {
                setError("面具的人设内容不能为空。");
                return;
            }
            onSave({ ...meta, kind: "persona", userName: personaUserName.trim() || undefined, content: content.trim() });
            return;
        }
        if (kind === "filter") {
            const cleaned = rules
                .map((r) => ({ find: r.find.trim(), replace: r.replace, mode: r.mode }))
                .filter((r) => r.find);
            if (!cleaned.length) {
                setError("滤网至少要有一条查找不为空的规则。");
                return;
            }
            const bad = cleaned.findIndex((r) => { try { new RegExp(r.find, "g"); return false; } catch { return true; } });
            if (bad >= 0) {
                setError(`第 ${bad + 1} 条规则的正则写法有误，先在下面试跑区改对再保存。`);
                return;
            }
            onSave({ ...meta, kind: "filter", rules: cleaned });
            return;
        }
        if (!content.trim()) {
            setError(`${MIX_KIND_LABELS[kind]}的内容不能为空。`);
            return;
        }
        onSave({ ...meta, kind, content: content.trim() } as MixTextMaterial);
    };

    const guide = KIND_GUIDE[kind];

    return (
        <div>
            <div className="mix-guide">
                <div className="mix-guide-what">{guide.what}</div>
                <div className="mix-guide-where">{guide.where}</div>
                {HEADING_NOTE_KINDS.includes(kind) ? <div className="mix-guide-level">{HEADING_NOTE}</div> : null}
                <button type="button" className="mix-guide-link" onClick={() => setStructureOpen(true)}>
                    <FileText size={12} />
                    <span>看看完整提示词结构</span>
                </button>
            </div>
            <Field label={isCharacter ? "角色名" : "名称"} hint="必填">
                <input className="mix-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={isCharacter ? "角色叫什么，就是提示词里的 {{char}}" : `给这件${MIX_KIND_LABELS[kind]}起个名，方便自己在吧台认出来`} />
            </Field>
            <Field label="一句话介绍">
                <input className="mix-input" value={hook} onChange={(e) => setHook(e.target.value)} placeholder="一句话说清它的特点，会显示在卡片上" />
            </Field>
            <Field label="标签" hint={`最多 ${MIX_TAG_MAX} 个`}>
                <input
                    className="mix-input"
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    placeholder="用顿号或逗号隔开，例如：现代都市、暗恋、久别重逢"
                />
                {tags.length ? (
                    <div className="mix-tag-list" style={{ marginTop: 8 }}>
                        {tags.map((tag) => (
                            <span className="mix-tag" key={tag}>{tag}</span>
                        ))}
                    </div>
                ) : null}
                {tagsDropped > 0 ? (
                    <div className="mix-form-note">超出 {MIX_TAG_MAX} 个的标签不会保存，已多写 {tagsDropped} 个。</div>
                ) : null}
            </Field>
            {mixKindHasCover(kind) ? (
                <Field label="封面图" hint={isCharacter ? "对局背景，强烈建议配" : undefined}>
                    <div className="mix-cover-picker">
                        {cover ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="mix-cover-preview" src={cover} alt="封面" />
                        ) : (
                            <div className="mix-cover-preview" />
                        )}
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <button type="button" className="mix-pill-btn" onClick={() => fileRef.current?.click()}>选择图片</button>
                            {cover ? (
                                <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setCover("")}>移除</button>
                            ) : null}
                        </div>
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            style={{ display: "none" }}
                            onChange={(e) => { void handleCoverFile(e.target.files?.[0]); e.target.value = ""; }}
                        />
                    </div>
                </Field>
            ) : null}
            {isCharacter ? (
                <>
                    <Field label="基础信息"><textarea className="mix-textarea" value={baseInfo} onChange={(e) => setBaseInfo(e.target.value)} placeholder="例：27 岁 / 183cm / 便利店夜班店员" /></Field>
                    <Field label="性格"><textarea className="mix-textarea" value={personality} onChange={(e) => setPersonality(e.target.value)} placeholder="例：嘴上嫌弃手上诚实，怕麻烦但从不真的拒绝人" /></Field>
                    <Field label="外貌"><textarea className="mix-textarea" value={appearance} onChange={(e) => setAppearance(e.target.value)} placeholder="例：高瘦，总把制服外套袖子卷到手肘，左耳有个旧耳洞" /></Field>
                    <Field label="背景"><textarea className="mix-textarea" value={background} onChange={(e) => setBackground(e.target.value)} placeholder="例：三年前从老家搬来，白天在读夜校，夜班是为了付学费" /></Field>
                    <Field label="世界观"><textarea className="mix-textarea" value={worldview} onChange={(e) => setWorldview(e.target.value)} placeholder="故事发生在什么世界。例：普通现代都市，没有超自然设定" /></Field>
                    <Field label={"对{{user}}的初始认知"}><textarea className="mix-textarea" value={cognition} onChange={(e) => setCognition(e.target.value)} placeholder="开局时角色对你了解到什么程度。例：只知道你是每周来三次的常客，不知道名字" /></Field>
                    <Field label="关系与身份"><textarea className="mix-textarea" value={relations} onChange={(e) => setRelations(e.target.value)} placeholder="玩家可以代入哪些身份、各自什么关系。例：熟客（微妙的默契）/ 新同事（他带你）" /></Field>
                    <Field label="当前剧情"><textarea className="mix-textarea" value={plot} onChange={(e) => setPlot(e.target.value)} placeholder="故事从哪一刻开始。例：雨夜，打烊前十分钟，店里只剩你们两个" /></Field>
                    <Field label="附加设定"><textarea className="mix-textarea" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="配角、私设名词、地点等。例：店长老周只在白班出现；「三号柜」是他们之间的暗号" /></Field>
                    <Field label="开场白" hint="必填，写多个玩家开局可以挑，用单独一行 --- 分隔">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 130 }}
                            value={openingsText}
                            onChange={(e) => setOpeningsText(e.target.value)}
                            placeholder={"故事的第一幕，由角色说出口。\n\n例：\n【便利店 · 打烊前十分钟】\n他把关东煮的竹签码齐，抬眼看你。「今天也加班到这个点？」\n---\n雨夜，他撑着伞站在店门口，像是等了很久。"}
                        />
                    </Field>
                    <Field label="示例对话" hint="文风锚点，不是已发生的剧情">
                        <div className="mix-example-list">
                            {examples.map((example, i) => (
                                <div className="mix-example-row" key={i}>
                                    <button
                                        type="button"
                                        className="mix-example-role"
                                        data-role={example.role}
                                        onClick={() => setExamples((prev) => prev.map((e, idx) => (
                                            idx === i ? { ...e, role: e.role === "user" ? "char" : "user" } : e
                                        )))}
                                    >
                                        {example.role === "user" ? "玩家" : "角色"}
                                    </button>
                                    <textarea
                                        className="mix-textarea"
                                        style={{ minHeight: 56 }}
                                        value={example.text}
                                        onChange={(e) => setExamples((prev) => prev.map((item, idx) => (
                                            idx === i ? { ...item, text: e.target.value } : item
                                        )))}
                                        placeholder={example.role === "user" ? "玩家会怎么说" : "角色该怎么答"}
                                    />
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setExamples((prev) => prev.filter((_, idx) => idx !== i))}
                                        aria-label="删除这轮"
                                    >
                                        <Trash2 size={15} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                className="mix-pill-btn"
                                onClick={() => setExamples((prev) => [
                                    ...prev,
                                    { role: prev.length && prev[prev.length - 1].role === "user" ? "char" : "user", text: "" },
                                ])}
                            >
                                <Plus size={13} style={{ verticalAlign: "-2px" }} /> 加一轮
                            </button>
                        </div>
                    </Field>
                    <Field label="开场画布" hint="选填，HTML；点进卡片时铺在封面蒙版上展示，不进提示词">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 170 }}
                            value={canvas}
                            onChange={(e) => setCanvas(e.target.value)}
                            placeholder={"这张卡的门面页：大标题、诗句、标签、给读者的说明，版面由你排。\n\n例：\n<div style=\"padding:28px 6px;color:#fff;font:14px/2 serif\">\n  <h1 style=\"font-size:34px;letter-spacing:.3em\">晏迟</h1>\n  <p style=\"opacity:.65\">便利店夜班 · 冷白皮</p>\n  <p style=\"margin-top:22px\">「今天也加班到这个点？」</p>\n</div>"}
                        />
                    </Field>
                    <MixPreviewInline
                        label="预览画布"
                        target={{ kind: "canvas", html: canvas, cover }}
                        disabled={!canvas.trim()}
                    />
                </>
            ) : null}
            {kind === "persona" ? (
                <>
                    <Field label="你的名字" hint="选填，角色会这么称呼你；留空则用「你」">
                        <input className="mix-input" value={personaUserName} onChange={(e) => setPersonaUserName(e.target.value)} placeholder="例：阿澈" />
                    </Field>
                    <Field label="用户人设" hint="必填，可用 {{char}} / {{user}}">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 170 }}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder={"例：\n{{user}}：22 岁，插画系学生，寄住江家的故人之女。\n- 表面顺从，实际一直在攒离开的底气。\n- 怕打雷；说谎时会攥紧左手。"}
                        />
                    </Field>
                </>
            ) : null}
            {kind === "base" || kind === "flavor" || kind === "glass" || kind === "strength" ? (
                <Field label={TEXT_FIELD_COPY[kind].label} hint="必填，可用 {{char}} / {{user}}">
                    <textarea
                        className="mix-textarea"
                        style={{ minHeight: 170 }}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={TEXT_FIELD_COPY[kind].placeholder}
                    />
                </Field>
            ) : null}
            {kind === "ticket" ? (
                <>
                    <Field label="输出契约" hint="必填，告诉 AI 每轮报哪些数据、按什么格式报">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 130 }}
                            value={contract}
                            onChange={(e) => setContract(e.target.value)}
                            placeholder={"例：\n每轮结束后报告下面三行，每行一个字段：\n好感度: 0-100 的整数\n心情: 四个字以内\n此刻在想: 一句话"}
                        />
                    </Field>
                    <Field label="渲染代码" hint="必填，HTML+CSS+JS，把上面那段原文画成卡片">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 180 }}
                            value={renderHtml}
                            onChange={(e) => setRenderHtml(e.target.value)}
                            placeholder={"AI 报的原文用 {{RAW}} 直接插入，或在 JS 里读 window.TICKET_RAW。\n\n例：\n<div style=\"padding:12px;border-radius:10px;background:#1c1c26;color:#d9b06a\">\n  <pre>{{RAW}}</pre>\n</div>"}
                        />
                    </Field>
                    <Field label="预览示例数据" hint="随便编一份，用来试渲染效果">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            value={previewRaw}
                            onChange={(e) => setPreviewRaw(e.target.value)}
                            placeholder={"照着上面的契约编一份，例：\n好感度: 62\n心情: 嘴硬\n此刻在想: 想留你再坐一会"}
                        />
                    </Field>
                    <Field label="要记住的项" hint="记住的值会一路留着，可以拿来设材料的「什么时候出现」；抽不到时保留上一轮的值">
                        {contractFieldNames.length ? (
                            <div className="mix-var-suggest">
                                <span>契约里认出这几项：</span>
                                {contractFieldNames.map((name) => {
                                    const added = vars.some((v) => v.name.trim() === name);
                                    return (
                                        <button
                                            type="button"
                                            className="mix-var-chip"
                                            data-on={added ? "true" : undefined}
                                            key={name}
                                            onClick={() => setVars((prev) => (added
                                                ? prev.filter((v) => v.name.trim() !== name)
                                                : [...prev, { name }]))}
                                        >
                                            {name}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                        {vars.length ? (
                            <div className="mix-var-list">
                                {vars.map((item, index) => (
                                    <div className="mix-var-row" key={index}>
                                        <input
                                            className="mix-input"
                                            value={item.name}
                                            placeholder="项目名（和契约里的写法一致）"
                                            onChange={(e) => setVars((prev) => prev.map((v, i) => (i === index ? { ...v, name: e.target.value } : v)))}
                                        />
                                        <input
                                            className="mix-input mix-var-initial"
                                            value={item.initial ?? ""}
                                            placeholder="开局值"
                                            onChange={(e) => setVars((prev) => prev.map((v, i) => (i === index ? { ...v, initial: e.target.value } : v)))}
                                        />
                                        <button
                                            type="button"
                                            className="mix-icon-btn"
                                            onClick={() => setVars((prev) => prev.filter((_, i) => i !== index))}
                                            aria-label="删除"
                                        >
                                            <Trash2 size={15} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="mix-var-empty">还没有要记住的项——上面点一下契约里的字段，或手动添加。</div>
                        )}
                        <button type="button" className="mix-stack-add" onClick={() => setVars((prev) => [...prev, { name: "" }])}>
                            <Plus size={15} /> 手动添加一项
                        </button>
                    </Field>
                    <MixPreviewInline
                        label="预览小票"
                        target={{ kind: "ticket", html: renderHtml, raw: previewRaw }}
                        disabled={!renderHtml.trim()}
                    />
                </>
            ) : null}
            {kind === "mechanism" ? (
                <>
                    <Field label="钩子逻辑" hint="可留空。存储与下面的界面共用一份">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 200 }}
                            value={script}
                            onChange={(e) => setScript(e.target.value)}
                            placeholder={"每个函数收一份 ctx，返回一个对象（不返回就是什么都不改）。\nctx: { turnCount, state, store, charName, userName, text, ticketRaw, encoreRaw }\n可返回: { text, note, state, store }\n\n例：玩家打「/掷骰」时换成一段带结果的指令\nfunction onBeforeSend(ctx) {\n  if (ctx.text !== \"/掷骰\") return;\n  var n = 1 + Math.floor(Math.random() * 20);\n  return { text: \"（我掷出了 \" + n + \" 点）\" };\n}\n\n例：连着三轮好感度上涨就提醒一次\nfunction onAfterReply(ctx) {\n  var up = Number(ctx.store.连涨 || 0);\n  return { store: { 连涨: String(up + 1) } };\n}"}
                        />
                    </Field>
                    <Field label="界面代码" hint="HTML + CSS + JS，在沙盒里跑；画在哪、多大、要不要应用画外壳，都在这里用 window.mix 写">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 160 }}
                            value={panelHtml}
                            onChange={(e) => setPanelHtml(e.target.value)}
                            placeholder={"<div style=\"padding:10px\">这里是常驻面板</div>\n\nwindow.mix\n  move(x, y) / size(w, h)         挪自己、改大小（占对局画面的百分比）\n  design(px)                      按多宽排版，画完整体缩放到面板大小；0 = 跟着面板走\n  fit(px)                         报内容多高\n  chrome(on) / plate(on)          要不要应用画的标题条 / 底板，默认都不画\n  drag(on) / resize(on)           玩家能不能拖、能不能缩放\n  z(n)                            叠放次序 0–9\n  grab()                          在自己画的标题条上 pointerdown 时调，接着由应用接管拖动\n  setStore(obj) / setState(obj)   写存储 / 写记住的值\n  say(text)                       以玩家身份说一句\nwindow.MIX_STATE / window.MIX_STORE  当前的值\nwindow.onMixSync(state, store)       值变了会回调"}
                        />
                    </Field>
                    <MixPreviewInline
                        label="试摆一下"
                        target={{
                            kind: "mechanism",
                            name,
                            html: panelHtml,
                            layout: mixPanelLayoutOf({ layout: keptLayout, dock: keptDock, panelHtml }) ?? MIX_PANEL_DEFAULT_LAYOUT,
                            script,
                        }}
                        disabled={!panelHtml.trim() && !script.trim()}
                    />
                    <div className="mix-struct-note" style={{ marginTop: 10 }}>
                        沙盒里没有网络，跑太久会被掐断。存储一个对局一份，退出再进来还在。
                    </div>
                </>
            ) : null}
            {kind === "garnish" ? (
                <>
                    <Field label="界面 CSS" hint="必填，点下面「试穿看看」有完整类名速查">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 190 }}
                            value={css}
                            onChange={(e) => setCss(e.target.value)}
                            placeholder={"例：\n.mix-dialogue { color: #ffd479; font-weight: 600 }\n.mix-thought  { color: #8d7bf5 }\n.mix-scene    { letter-spacing: .5em }"}
                        />
                    </Field>
                    <MixPreviewInline
                        label="试穿看看"
                        target={{ kind: "garnish", css }}
                        disabled={!css.trim()}
                    />
                </>
            ) : null}
            {kind === "encore" ? (
                <>
                    <Field label="输出契约" hint="选填；写了 AI 才会在对局中输出小剧场，留空则为纯静态小品">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 110 }}
                            value={encoreContract}
                            onChange={(e) => setEncoreContract(e.target.value)}
                            placeholder={"告诉 AI 何时输出、写什么。例：\n仅在剧情出现明显进展或情绪转折时输出：以旁观视角（助理、监控、朋友圈动态等）写一段不超过 80 字的小剧场，第一行标注视角。平淡回合整段省略。"}
                        />
                    </Field>
                    <Field label="渲染代码" hint="必填，HTML/JS；AI 输出经 {{RAW}} 或 window.ENCORE_RAW 注入，静态小品则直接展示">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 180 }}
                            value={html}
                            onChange={(e) => setHtml(e.target.value)}
                            placeholder={"例：\n<div style=\"padding:14px;background:#14111c;border-radius:10px;color:#f2f0f7\">\n  <pre style=\"margin:0;white-space:pre-wrap\">{{RAW}}</pre>\n</div>"}
                        />
                    </Field>
                    <Field label="预览示例数据" hint="选填，模拟 AI 的小剧场输出来试渲染">
                        <textarea className="mix-textarea" data-code="true" value={encorePreviewRaw} onChange={(e) => setEncorePreviewRaw(e.target.value)} />
                    </Field>
                    <MixPreviewInline
                        label="跑一下"
                        target={{ kind: "encore", html, raw: encorePreviewRaw }}
                        disabled={!html.trim()}
                    />
                </>
            ) : null}
            {kind === "filter" ? (
                <>
                    <Field label="清洗规则" hint="从上到下依次执行；查找是 JS 正则（自动带 g），替换可用 $1 引用捕获组，留空即删除">
                        <div className="mix-example-list">
                            {rules.map((rule, i) => (
                                <div className="mix-filter-rule" key={i} data-bad={filterTest.badIndexes.includes(i) ? "true" : undefined}>
                                    <div className="mix-filter-rule-main">
                                        <input
                                            className="mix-input"
                                            data-code="true"
                                            value={rule.find}
                                            onChange={(e) => setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, find: e.target.value } : r)))}
                                            placeholder="查找（正则），例：\*\*|——+"
                                        />
                                        <input
                                            className="mix-input"
                                            data-code="true"
                                            value={rule.replace}
                                            onChange={(e) => setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, replace: e.target.value } : r)))}
                                            placeholder="替换为（留空=删除）"
                                        />
                                        {filterTest.badIndexes.includes(i) ? <div className="mix-filter-rule-bad">正则写法有误，这条不会生效</div> : null}
                                    </div>
                                    <button
                                        type="button"
                                        className="mix-filter-mode"
                                        data-mode={rule.mode}
                                        onClick={() => setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, mode: r.mode === "display" ? "context" : "display" } : r)))}
                                        title="仅显示：存原文，渲染时替换，全部历史即时生效；进上下文：入库前清洗，发回模型的历史也是洗过的，只对新回复生效"
                                    >
                                        {rule.mode === "display" ? "仅显示" : "进上下文"}
                                    </button>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setRules((prev) => prev.filter((_, idx) => idx !== i))}
                                        aria-label="删除这条规则"
                                    >
                                        <Trash2 size={15} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                className="mix-pill-btn"
                                onClick={() => setRules((prev) => [...prev, { find: "", replace: "", mode: "display" }])}
                            >
                                <Plus size={13} style={{ verticalAlign: "-2px" }} /> 加一条规则
                            </button>
                        </div>
                    </Field>
                    <Field label="试跑" hint="贴一段样文，即时看全部规则跑完的结果">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 90 }}
                            value={filterSample}
                            onChange={(e) => setFilterSample(e.target.value)}
                            placeholder={"例：\n**他顿了顿**——「嗯……今天也加班？」"}
                        />
                        {filterSample ? (
                            <div className="mix-filter-result">{filterTest.result || "（全部被清空了）"}</div>
                        ) : null}
                    </Field>
                </>
            ) : null}
            {structureOpen ? <MixStructureSheet highlight={kind} onClose={() => setStructureOpen(false)} /> : null}
            {error ? <div style={{ color: "#e2a3a3", fontSize: 12, marginTop: 12 }}>{error}</div> : null}
            <div className="mix-form-footer">
                <button type="button" className="mix-ghost-btn" onClick={onCancel}>取消</button>
                <button type="button" className="mix-brew-btn" onClick={handleSave}>保存入柜</button>
            </div>
        </div>
    );
}
