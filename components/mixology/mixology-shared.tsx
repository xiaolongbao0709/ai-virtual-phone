"use client";

// 独家特调 · 共享 UI 小件：材料卡 / 种类图标 / 详情字段渲染。
// 酒柜（本地）与酒单/大厅（官网）两边共用，保持一套视觉语言。

import type { ReactNode } from "react";
import {
    BookOpen,
    CircleUserRound,
    Cog,
    Feather,
    Filter,
    Flame,
    GlassWater,
    Music4,
    ReceiptText,
    Sparkles,
    UserRound,
} from "lucide-react";
import type { MixCharacterCard, MixMaterial, MixMaterialKind } from "@/lib/mixology/types";
import { MIX_KIND_LABELS, MIX_PANEL_DEFAULT_LAYOUT, mixEncoreRenderHtml, mixKindHasCover, mixKindRunsActiveCode, mixPanelLayoutOf, mixPanelLayoutSummary, normalizeMixTags } from "@/lib/mixology/types";
import { applyMixMacros, MIX_DEFAULT_USER_NAME } from "@/lib/mixology/assembler";
import { MixPreviewInline } from "./mixology-preview";
import { MixRichText } from "./rich-text";

const KIND_ICONS: Record<MixMaterialKind, typeof UserRound> = {
    character: UserRound,
    persona: CircleUserRound,
    base: BookOpen,
    flavor: Feather,
    glass: GlassWater,
    strength: Flame,
    ticket: ReceiptText,
    garnish: Sparkles,
    encore: Music4,
    filter: Filter,
    mechanism: Cog,
};

export function KindGlyph({ kind, size = 26 }: { kind: MixMaterialKind; size?: number }) {
    const Icon = KIND_ICONS[kind];
    return <Icon size={size} strokeWidth={1.6} />;
}

/**
 * 作者小头像：没有头像就用名字首字的圆片。线上详情、酒柜详情、创作者资料入口共用。
 * name 必须传"旁边实际显示的那个名字"（自己没起笔名就是「我」，别人没署名就是「匿名调酒师」），
 * 圆片里的字才不会和名字对不上。
 */
export function AuthorAvatar({ name, avatar, size = 32 }: { name?: string; avatar?: string; size?: number }) {
    const display = (name ?? "").trim() || "我";
    if (avatar) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img className="mix-avatar" src={avatar} alt={display} style={{ width: size, height: size }} />;
    }
    return <span className="mix-avatar-fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}>{display.slice(0, 1)}</span>;
}

export function formatMixTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 卡面上的标签：只占一行，装不下的用省略号收掉——完整标签在详情弹窗里看。
 * 用行内 span 而不是 inline-block，text-overflow 才能在裁到一半的标签上落省略号。
 */
function TagLine({ tags, className }: { tags?: string[]; className: string }) {
    // 规整一遍再渲染：导入的 JSON 里什么都可能有，别让脏数据把卡片渲染搞崩
    const list = normalizeMixTags(tags);
    if (!list.length) return null;
    return (
        <div className={className}>
            {list.map((tag) => (
                <span className="mix-tag" key={tag}>{tag}</span>
            ))}
        </div>
    );
}

/**
 * 详情弹窗里的完整标签：换行摊开，不省略。
 * 不带「标签」小标题——标签自己长得就像标签，再加一行字反而多余。
 */
export function MixTagList({ tags }: { tags?: string[] }) {
    const list = normalizeMixTags(tags);
    if (!list.length) return null;
    return (
        <div className="mix-detail-field">
            <div className="mix-tag-list">
                {list.map((tag) => (
                    <span className="mix-tag" key={tag}>{tag}</span>
                ))}
            </div>
        </div>
    );
}

/** 瀑布卡：本地酒柜与在线酒单共用（stats 行只有在线卡传） */
export function MatCard({
    kind,
    name,
    hook,
    tags,
    cover,
    preview,
    badge,
    author,
    stats,
    onClick,
}: {
    kind: MixMaterialKind;
    name: string;
    hook?: string;
    tags?: string[];
    cover?: string;
    /** 没配封面时压在占位纹上的自动封面（材料自己的渲染缩样）；渲染不出内容就露出占位纹 */
    preview?: ReactNode;
    badge?: string;
    author?: string;
    stats?: string;
    onClick: () => void;
}) {
    // 卡型只看种类，不看有没有配图——否则同一类里配了图的高、没配图的矮，
    // 双列瀑布会参差。视觉类（角色卡/小票/装饰/尾调）一律海报式（缺图时用
    // 同尺寸的占位面），纯文本类（基底/文风/杯型/苦精）一律单列横条。
    if (mixKindHasCover(kind)) {
        return (
            <div className="mix-mat-card" data-kind={kind} data-poster="true" data-live={!cover && preview ? "true" : undefined} onClick={onClick}>
                {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="mix-mat-cover" src={cover} alt={name} />
                ) : preview ? (
                    // 自动封面走文档流：卡片高度=缩样实际高度，不垫占位纹（透明缩样底下不透图标）
                    <div className="mix-poster-flow" aria-hidden="true">{preview}</div>
                ) : (
                    <div className="mix-poster-blank"><KindGlyph kind={kind} size={42} /></div>
                )}
                {author ? <div className="mix-poster-author">@{author}</div> : null}
                {badge ? <div className="mix-poster-badge">{badge}</div> : null}
                <div className="mix-poster-veil">
                    <div className="mix-poster-name">{name}</div>
                    {hook ? <div className="mix-poster-hook">{hook}</div> : null}
                    <TagLine tags={tags} className="mix-poster-tags" />
                    {stats ? <div className="mix-poster-stats">{stats}</div> : null}
                </div>
            </div>
        );
    }

    return (
        <div className="mix-mat-row" data-kind={kind} onClick={onClick}>
            <div className="mix-mat-row-glyph"><KindGlyph kind={kind} size={22} /></div>
            <div className="mix-mat-info">
                <div className="mix-mat-name">
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                    {badge ? <span className="mix-mat-badge">{badge}</span> : null}
                    {/* 带可执行逻辑的种类：点开之前就让人看见 */}
                    {mixKindRunsActiveCode(kind) ? <span className="mix-mat-badge" data-tone="code">含可执行逻辑</span> : null}
                </div>
                {hook ? <div className="mix-mat-hook">{hook}</div> : null}
                <TagLine tags={tags} className="mix-mat-tags" />
                {author || stats ? (
                    <div className="mix-mat-author">{[author ? `@${author}` : null, stats].filter(Boolean).join(" · ")}</div>
                ) : null}
            </div>
        </div>
    );
}

/** 确认弹窗：分享/删除/下架这类不可撤销或对外的操作统一走它 */
export function MixConfirm({
    title,
    body,
    confirmText = "确定",
    tone,
    onConfirm,
    onCancel,
}: {
    title: string;
    body?: ReactNode;
    confirmText?: string;
    tone?: "danger";
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="mix-confirm-mask" onClick={onCancel}>
            <div className="mix-confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
                <div className="mix-confirm-title">{title}</div>
                {body ? <div className="mix-confirm-body">{body}</div> : null}
                <div className="mix-confirm-actions">
                    <button type="button" className="mix-confirm-btn" onClick={onCancel}>取消</button>
                    <button type="button" className="mix-confirm-btn" data-tone={tone ?? "primary"} onClick={onConfirm}>{confirmText}</button>
                </div>
            </div>
        </div>
    );
}

/**
 * 是否封存：只有「从酒单/大厅拿来的别人的角色卡」需要藏正文。
 * 基底、文风、输出格式这些是技法，互相看得见对社区更好，一律照常展示。
 */
export function isSealedMaterial(material: { kind: string; imported?: boolean }): boolean {
    return Boolean(material.imported) && material.kind === "character";
}

/**
 * 别人的角色卡：设定正文不摊开，只留作者写给读者看的那两栏
 *（与应用市场、游戏大厅同规矩）。
 */
export function SealedNote({ hook, canvas, charName }: { hook?: string; canvas?: string; charName?: string }) {
    if (canvas?.trim()) {
        // 详情页没有对局，{{user}} 没有名字可用，退回默认的「你」
        const filled = applyMixMacros(canvas, charName ?? "", MIX_DEFAULT_USER_NAME, undefined, { escapeHtml: true });
        return <div className="mix-canvas-block"><MixRichText text={filled} /></div>;
    }
    return <DetailField label="一句话介绍" value={hook} />;
}

export function DetailField({ label, value, code }: { label: string; value?: string; code?: boolean }) {
    if (!value?.trim()) return null;
    return (
        <div className="mix-detail-field">
            <div className="mix-detail-label">{label}</div>
            <div className="mix-detail-value" data-code={code ? "true" : undefined}>{value}</div>
        </div>
    );
}

export function MaterialDetail({ material }: { material: MixMaterial }) {
    if (material.kind === "character") {
        const card = material as MixCharacterCard;
        return (
            <>
                <DetailField label="一句话介绍" value={card.hook} />
                <DetailField label="基础信息" value={card.baseInfo} />
                <DetailField label="性格" value={card.personality} />
                <DetailField label="外貌" value={card.appearance} />
                <DetailField label="背景" value={card.background} />
                <DetailField label="世界观" value={card.worldview} />
                <DetailField label="初始认知" value={card.cognition} />
                <DetailField label="关系与身份" value={card.relations} />
                <DetailField label="当前剧情" value={card.plot} />
                <DetailField label="附加设定" value={card.extra} />
                <DetailField label="开场白" value={card.openings.map((o, i) => `${card.openings.length > 1 ? `〔${i + 1}〕` : ""}${o}`).join("\n\n")} />
            </>
        );
    }
    if (material.kind === "persona") {
        return (
            <>
                <DetailField label="一句话介绍" value={material.hook} />
                <DetailField label="你的名字" value={material.userName} />
                <DetailField label="用户人设" value={material.content} />
            </>
        );
    }
    if (material.kind === "ticket") {
        return (
            <>
                <DetailField label="一句话介绍" value={material.hook} />
                {/* 详情页先看效果再看字段：用作者留的示例数据就地渲染一遍 */}
                <MixPreviewInline
                    label="预览小票"
                    guide={false}
                    target={{ kind: "ticket", html: material.renderHtml, raw: material.previewRaw ?? "" }}
                    disabled={!material.renderHtml?.trim()}
                />
                <DetailField label="输出契约" value={material.contract} />
                <DetailField label="渲染代码" value={material.renderHtml} code />
            </>
        );
    }
    if (material.kind === "garnish") {
        return (
            <>
                <DetailField label="一句话介绍" value={material.hook} />
                <MixPreviewInline
                    label="试穿看看"
                    guide={false}
                    target={{ kind: "garnish", css: material.css }}
                    disabled={!material.css?.trim()}
                />
                <DetailField label="外观 CSS" value={material.css} code />
            </>
        );
    }
    if (material.kind === "encore") {
        const encoreHtml = mixEncoreRenderHtml(material);
        return (
            <>
                <DetailField label="一句话介绍" value={material.hook} />
                <MixPreviewInline
                    label="跑一下"
                    guide={false}
                    target={{ kind: "encore", html: encoreHtml, raw: material.previewRaw }}
                    disabled={!encoreHtml.trim()}
                />
                <DetailField label="输出契约" value={material.contract} />
                <DetailField label="渲染代码" value={encoreHtml} code />
            </>
        );
    }
    if (material.kind === "filter") {
        return (
            <>
                <DetailField label="一句话介绍" value={material.hook} />
                <MixPreviewInline
                    label="试跑规则"
                    guide={false}
                    target={{ kind: "filter", rules: material.rules }}
                    disabled={!material.rules.length}
                />
                <DetailField
                    label={`清洗规则 · ${material.rules.length} 条`}
                    value={material.rules
                        .map((r, i) => `${i + 1}.（${r.mode === "display" ? "仅显示" : "进上下文"}）/${r.find}/ → ${r.replace || "（删除）"}`)
                        .join("\n")}
                    code
                />
            </>
        );
    }
    if (material.kind === "mechanism") {
        const layout = mixPanelLayoutOf(material);
        return (
            <>
                <DetailField label="一句话介绍" value={material.hook} />
                {/* 试摆跑在与编辑器同一块假对局舞台上：界面能拖能点，钩子能当场跑一遍 */}
                <MixPreviewInline
                    label="试摆一下"
                    guide={false}
                    target={{
                        kind: "mechanism",
                        name: material.name,
                        html: material.panelHtml ?? "",
                        layout: layout ?? MIX_PANEL_DEFAULT_LAYOUT,
                        script: material.script ?? "",
                    }}
                    disabled={!material.panelHtml?.trim() && !material.script?.trim()}
                />
                <DetailField label="钩子逻辑" value={material.script} code />
                {layout ? <DetailField label="界面摆放" value={mixPanelLayoutSummary(layout)} /> : null}
                <DetailField label="界面代码" value={material.panelHtml} code />
            </>
        );
    }
    return (
        <>
            <DetailField label="一句话介绍" value={material.hook} />
            <DetailField label={`${MIX_KIND_LABELS[material.kind]}内容`} value={material.content} />
        </>
    );
}
