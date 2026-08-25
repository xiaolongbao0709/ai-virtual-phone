"use client";

// 独家特调 · 槽位编辑：一格里叠了哪几件、各自什么时候出现。
//
// 两层弹层：外层是这一格的清单（排序 / 移除 / 再加一件），
// 点某一件的「什么时候出现」进内层条件编辑。
// 条件只有五种一句话说得清的形式，不做嵌套、不做表达式——
// 真要写逻辑那是另一回事，不该在这里开口子。

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { describeMixCondition } from "@/lib/mixology/state";
import {
    MIX_KIND_LABELS,
    MIX_SLOT_STACK,
    type MixCompareOp,
    type MixCondition,
    type MixMaterial,
    type MixMaterialKind,
    type MixSlotEntry,
} from "@/lib/mixology/types";
import { KindGlyph } from "./mixology-shared";

const COMPARE_OPS: { value: MixCompareOp; label: string }[] = [
    { value: ">", label: "大于" },
    { value: ">=", label: "不小于" },
    { value: "<", label: "小于" },
    { value: "<=", label: "不大于" },
    { value: "=", label: "等于" },
    { value: "!=", label: "不等于" },
];

type ConditionForm = "always" | "turn" | "var" | "keyword" | "chance";

function formOf(when: MixCondition | undefined): ConditionForm {
    return when?.type ?? "always";
}

/** 条件编辑：五选一，每种就一行填空 */
function ConditionSheet({
    kind,
    materialName,
    when,
    varNames,
    onSave,
    onClose,
}: {
    kind: MixMaterialKind;
    materialName: string;
    when: MixCondition | undefined;
    varNames: string[];
    onSave: (next: MixCondition | undefined) => void;
    onClose: () => void;
}) {
    const [form, setForm] = useState<ConditionForm>(() => formOf(when));
    const [turnAfter, setTurnAfter] = useState(() => (when?.type === "turn" ? String(when.after) : "10"));
    const [varName, setVarName] = useState(() => (when?.type === "var" ? when.name : varNames[0] ?? ""));
    const [varOp, setVarOp] = useState<MixCompareOp>(() => (when?.type === "var" ? when.op : ">"));
    const [varValue, setVarValue] = useState(() => (when?.type === "var" ? when.value : ""));
    const [words, setWords] = useState(() => (when?.type === "keyword" ? when.words.join("、") : ""));
    const [within, setWithin] = useState(() => (when?.type === "keyword" ? String(when.within ?? 1) : "1"));
    const [percent, setPercent] = useState(() => (when?.type === "chance" ? String(when.percent) : "30"));

    const commit = () => {
        if (form === "always") { onSave(undefined); return; }
        if (form === "turn") {
            const after = Math.max(0, Math.floor(Number(turnAfter) || 0));
            onSave({ type: "turn", after });
            return;
        }
        if (form === "var") {
            const name = varName.trim();
            if (!name || !varValue.trim()) return;
            onSave({ type: "var", name, op: varOp, value: varValue.trim() });
            return;
        }
        if (form === "keyword") {
            const list = words.split(/[、,，\s]+/).map((w) => w.trim()).filter(Boolean);
            if (!list.length) return;
            const scope = Math.max(1, Math.floor(Number(within) || 1));
            onSave({ type: "keyword", words: list, within: scope > 1 ? scope : undefined });
            return;
        }
        const p = Math.max(0, Math.min(100, Math.floor(Number(percent) || 0)));
        onSave({ type: "chance", percent: p });
    };

    const canSave = form !== "var" || Boolean(varName.trim() && varValue.trim());

    return (
        <div className="mix-sheet-mask" onClick={onClose}>
            <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="mix-sheet-head">
                    <div className="mix-sheet-title">什么时候出现</div>
                    <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
                </div>
                <div className="mix-sheet-body">
                    <div className="mix-cond-target">{MIX_KIND_LABELS[kind]} · {materialName}</div>

                    <label className="mix-cond-opt" data-on={form === "always" ? "true" : undefined}>
                        <input type="radio" checked={form === "always"} onChange={() => setForm("always")} />
                        <span>一直出现</span>
                    </label>

                    <label className="mix-cond-opt" data-on={form === "turn" ? "true" : undefined}>
                        <input type="radio" checked={form === "turn"} onChange={() => setForm("turn")} />
                        <span>
                            聊到第
                            <input
                                className="mix-cond-num"
                                inputMode="numeric"
                                value={turnAfter}
                                onFocus={() => setForm("turn")}
                                onChange={(e) => setTurnAfter(e.target.value)}
                            />
                            轮之后
                        </span>
                    </label>

                    <label className="mix-cond-opt" data-on={form === "var" ? "true" : undefined}>
                        <input type="radio" checked={form === "var"} onChange={() => setForm("var")} disabled={!varNames.length} />
                        <span>
                            当
                            {varNames.length ? (
                                <select
                                    className="mix-cond-sel"
                                    value={varName}
                                    onFocus={() => setForm("var")}
                                    onChange={(e) => { setForm("var"); setVarName(e.target.value); }}
                                >
                                    {varNames.map((name) => <option value={name} key={name}>{name}</option>)}
                                </select>
                            ) : (
                                <em className="mix-cond-hint">（先在小票里勾选要记住的项）</em>
                            )}
                            {varNames.length ? (
                                <>
                                    <select
                                        className="mix-cond-sel"
                                        value={varOp}
                                        onFocus={() => setForm("var")}
                                        onChange={(e) => { setForm("var"); setVarOp(e.target.value as MixCompareOp); }}
                                    >
                                        {COMPARE_OPS.map((op) => <option value={op.value} key={op.value}>{op.label}</option>)}
                                    </select>
                                    <input
                                        className="mix-cond-val"
                                        value={varValue}
                                        placeholder="值"
                                        onFocus={() => setForm("var")}
                                        onChange={(e) => setVarValue(e.target.value)}
                                    />
                                </>
                            ) : null}
                        </span>
                    </label>

                    <label className="mix-cond-opt" data-on={form === "keyword" ? "true" : undefined}>
                        <input type="radio" checked={form === "keyword"} onChange={() => setForm("keyword")} />
                        <span>
                            提到
                            <input
                                className="mix-cond-text"
                                value={words}
                                placeholder="雨、雪（顿号分隔）"
                                onFocus={() => setForm("keyword")}
                                onChange={(e) => setWords(e.target.value)}
                            />
                            的时候（看最近
                            <input
                                className="mix-cond-num"
                                inputMode="numeric"
                                value={within}
                                onFocus={() => setForm("keyword")}
                                onChange={(e) => setWithin(e.target.value)}
                            />
                            轮）
                        </span>
                    </label>

                    <label className="mix-cond-opt" data-on={form === "chance" ? "true" : undefined}>
                        <input type="radio" checked={form === "chance"} onChange={() => setForm("chance")} />
                        <span>
                            随机
                            <input
                                className="mix-cond-num"
                                inputMode="numeric"
                                value={percent}
                                onFocus={() => setForm("chance")}
                                onChange={(e) => setPercent(e.target.value)}
                            />
                            % 的时候
                        </span>
                    </label>

                    <div className="mix-form-footer">
                        <button type="button" className="mix-ghost-btn" onClick={onClose}>取消</button>
                        <button type="button" className="mix-brew-btn" onClick={commit} disabled={!canSave}>确定</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function MixSlotEditor({
    kind,
    entries,
    resolve,
    varNames,
    onChange,
    onPickMore,
    onClose,
}: {
    kind: MixMaterialKind;
    entries: MixSlotEntry[];
    /** 按 id 取材料实体（取不到说明酒柜里已被删） */
    resolve: (id: string) => MixMaterial | null;
    /** 可选的「记住」项，供变量条件用 */
    varNames: string[];
    onChange: (next: MixSlotEntry[]) => void;
    onPickMore: () => void;
    onClose: () => void;
}) {
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const stackMode = MIX_SLOT_STACK[kind];

    const move = (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= entries.length) return;
        const next = [...entries];
        [next[index], next[target]] = [next[target], next[index]];
        onChange(next);
    };

    const remove = (index: number) => onChange(entries.filter((_, i) => i !== index));

    const setWhen = (index: number, when: MixCondition | undefined) => {
        onChange(entries.map((entry, i) => {
            if (i !== index) return entry;
            const { when: _drop, ...rest } = entry;
            return when ? { ...rest, when } : rest;
        }));
        setEditingIndex(null);
    };

    const editing = editingIndex !== null ? entries[editingIndex] : undefined;
    const editingName = editing ? resolve(editing.materialId)?.name ?? "已删除的材料" : "";

    return (
        <>
            <div className="mix-sheet-mask" onClick={onClose}>
                <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                    <div className="mix-sheet-head">
                        <div className="mix-sheet-title">这一格的{MIX_KIND_LABELS[kind]}</div>
                        <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
                    </div>
                    <div className="mix-sheet-body">
                        <div className="mix-struct-note">
                            {kind === "ticket" || kind === "encore"
                                ? "这一格里条件满足的会全部上场，每件各自成块——一轮可以同时带多个状态栏/小剧场，按下面的顺序排列。"
                                : stackMode === "concat"
                                    ? "这一格里条件满足的会全部生效，按下面的顺序依次叠加。"
                                    : "这一格从上往下找，用第一件条件满足的；其余的这一轮不出场。"}
                        </div>

                        <div className="mix-stack-list">
                            {entries.map((entry, index) => {
                                const material = resolve(entry.materialId);
                                return (
                                    <div className="mix-stack-row" key={`${entry.materialId}-${index}`}>
                                        <div className="mix-stack-order">{index + 1}</div>
                                        <div className="mix-stack-glyph"><KindGlyph kind={kind} size={20} /></div>
                                        <div className="mix-stack-main">
                                            <div className="mix-stack-name" data-gone={material ? undefined : "true"}>
                                                {material?.name ?? "这件材料已不在酒柜里"}
                                            </div>
                                            <button
                                                type="button"
                                                className="mix-stack-when"
                                                onClick={() => setEditingIndex(index)}
                                            >
                                                {describeMixCondition(entry.when)}
                                            </button>
                                        </div>
                                        <div className="mix-stack-ops">
                                            <button type="button" className="mix-icon-btn" onClick={() => move(index, -1)} disabled={index === 0} aria-label="上移"><ArrowUp size={15} /></button>
                                            <button type="button" className="mix-icon-btn" onClick={() => move(index, 1)} disabled={index === entries.length - 1} aria-label="下移"><ArrowDown size={15} /></button>
                                            <button type="button" className="mix-icon-btn" onClick={() => remove(index)} aria-label="移除"><Trash2 size={15} /></button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <button type="button" className="mix-stack-add" onClick={onPickMore}>
                            <Plus size={16} />
                            再加一件
                        </button>
                    </div>
                </div>
            </div>

            {editing ? (
                <ConditionSheet
                    kind={kind}
                    materialName={editingName}
                    when={editing.when}
                    varNames={varNames}
                    onSave={(next) => setWhen(editingIndex!, next)}
                    onClose={() => setEditingIndex(null)}
                />
            ) : null}
        </>
    );
}
