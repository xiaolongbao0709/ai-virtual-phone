"use client";

// 独家特调 · 正文渲染：按正文语义协议把 AI 原文渲染成带官方语义类的段落。
// 装饰材料的 CSS 只需要认这些类名就能上色：
//   .mix-prose 正文容器 / .mix-para 普通段 / .mix-scene 场景过场行
//   .mix-dialogue 对白 / .mix-thought 心声 / .mix-accent 强调 / .mix-narration 叙述
//   .mix-say-btn 对白后面的机括按钮（材料声明了 dialogueButton 才有）
//   .mix-html-block 正文里的 HTML 片段（沙盒框） / .mix-code 代码块

import { useMemo, type ReactNode } from "react";
import { Bookmark, Heart, Languages, Play, Quote, Sparkles, Star, StickyNote, Volume2 } from "lucide-react";
import { parseMixProse, type MixProseParagraph } from "@/lib/mixology/prose";
import { MixRichText } from "./rich-text";

/**
 * 对白按钮的内置矢量图标：材料的 icon 写这些名字就画成与特调同色系的线性图标，
 * 不写名字则当 emoji / 单字原样显示。
 */
const DIALOGUE_ICONS: Record<string, (size: number) => ReactNode> = {
    speaker: (size) => <Volume2 size={size} strokeWidth={2} />,
    play: (size) => <Play size={size} strokeWidth={2} />,
    translate: (size) => <Languages size={size} strokeWidth={2} />,
    note: (size) => <StickyNote size={size} strokeWidth={2} />,
    bookmark: (size) => <Bookmark size={size} strokeWidth={2} />,
    star: (size) => <Star size={size} strokeWidth={2} />,
    heart: (size) => <Heart size={size} strokeWidth={2} />,
    quote: (size) => <Quote size={size} strokeWidth={2} />,
    spark: (size) => <Sparkles size={size} strokeWidth={2} />,
};

export { MIX_DIALOGUE_ICON_NAMES } from "@/lib/mixology/types";

export function renderMixDialogueIcon(icon: string, size = 12): ReactNode {
    const named = DIALOGUE_ICONS[icon.trim().toLowerCase()];
    return named ? named(size) : icon;
}

/** 一件声明了对白按钮的机括：宿主替它在每句对白后画一颗图标 */
export type MixDialogueAction = { key: string; icon: string; title?: string };

export type MixProseDialogue = {
    actions: MixDialogueAction[];
    /** 各按钮的状态，键为 `${action.key}|${segmentId}` */
    states?: Record<string, string>;
    /** 这段正文的 id 前缀（一般是轮次 id），拼进每句对白的 segmentId 里，跨轮不重复 */
    idPrefix: string;
    onTap: (actionKey: string, segmentId: string, text: string) => void;
};

function renderParagraph(paragraph: MixProseParagraph, key: number, dialogue?: MixProseDialogue) {
    // HTML 片段：沙盒框就地渲染（与开场画布、尾调同一个框）；代码块：等宽显示
    if (paragraph.type === "html") {
        return <div className="mix-html-block" key={key}><MixRichText text={paragraph.html} /></div>;
    }
    if (paragraph.type === "code") {
        return (
            <pre className="mix-code" data-lang={paragraph.lang || undefined} key={key}>
                <code>{paragraph.code}</code>
            </pre>
        );
    }
    if (paragraph.type === "scene") {
        return (
            <p className="mix-scene" key={key}>
                <span aria-hidden="true">— </span>
                {paragraph.text}
                <span aria-hidden="true"> —</span>
            </p>
        );
    }
    return (
        <p className="mix-para" key={key}>
            {paragraph.segments.map((segment, i) => {
                // 对白/心声里嵌着 ~强调~：外层类不变，强调以 .mix-accent 子 span 嵌套渲染
                const quoted = segment.type === "dialogue";
                const body = segment.inner ? (
                    <span className={`mix-${segment.type}`} key={i}>
                        {quoted ? "「" : null}
                        {segment.inner.map((run, j) =>
                            run.type === "accent"
                                ? <span className="mix-accent" key={j}>{run.text}</span>
                                : run.text,
                        )}
                        {quoted ? "」" : null}
                    </span>
                ) : (
                    <span className={`mix-${segment.type}`} key={i}>{segment.text}</span>
                );
                if (!quoted || !dialogue?.actions.length) return body;
                // 对白后面跟机括的按钮：文字去掉「」递给机括
                const segmentId = `${dialogue.idPrefix}${key}-${i}`;
                const said = segment.text.replace(/^「/, "").replace(/」$/, "");
                return (
                    <span key={i}>
                        {body}
                        {dialogue.actions.map((action) => (
                            <button
                                type="button"
                                className="mix-say-btn"
                                key={action.key}
                                title={action.title}
                                aria-label={action.title || "对白按钮"}
                                data-state={dialogue.states?.[`${action.key}|${segmentId}`] || undefined}
                                onClick={() => dialogue.onTap(action.key, segmentId, said)}
                            >
                                {renderMixDialogueIcon(action.icon)}
                            </button>
                        ))}
                    </span>
                );
            })}
        </p>
    );
}

export function MixProseView({ text, dialogue, streaming }: { text: string; dialogue?: MixProseDialogue; streaming?: boolean }) {
    const paragraphs = useMemo(() => parseMixProse(text, { streaming }), [text, streaming]);
    return (
        <div className="mix-prose">
            {paragraphs.map((paragraph, i) => renderParagraph(paragraph, i, dialogue))}
        </div>
    );
}
