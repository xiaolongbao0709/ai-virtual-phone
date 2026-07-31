"use client";

// 全屏特效管理：底部全宽弹层，两个 Tab——「表情雨」自定义触发词规则；
// 「全屏特效」内置玩法（烟花/爱心/礼花/炸弹/骰子）。全局配置，所有会话共用。

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import {
    BUILTIN_SCREEN_EFFECTS,
    createChatScreenEffectRule,
    loadBuiltinScreenEffectSettings,
    loadChatScreenEffectRules,
    resetChatScreenEffectRules,
    saveBuiltinScreenEffectSettings,
    saveChatScreenEffectRules,
    type BuiltinScreenEffectSetting,
    type BuiltinScreenEffectType,
    type ChatScreenEffectRule,
} from "@/lib/chat-screen-effects";
import { ChatScreenEffectOverlay, type ActiveScreenEffect } from "./chat-screen-effect";

export function ScreenEffectSettingsModal({ onClose }: { onClose: () => void }) {
    const [tab, setTab] = useState<"rain" | "builtin">("rain");
    const [rules, setRules] = useState<ChatScreenEffectRule[]>(() => loadChatScreenEffectRules());
    const [builtins, setBuiltins] = useState<Record<BuiltinScreenEffectType, BuiltinScreenEffectSetting>>(
        () => loadBuiltinScreenEffectSettings(),
    );
    const [preview, setPreview] = useState<ActiveScreenEffect | null>(null);

    const updateRules = (next: ChatScreenEffectRule[]) => {
        setRules(next);
        saveChatScreenEffectRules(next);
    };
    const patchRule = (id: string, patch: Partial<ChatScreenEffectRule>) => {
        updateRules(rules.map(rule => (rule.id === id ? { ...rule, ...patch } : rule)));
    };
    const patchBuiltin = (type: BuiltinScreenEffectType, patch: Partial<BuiltinScreenEffectSetting>) => {
        const next = { ...builtins, [type]: { ...builtins[type], ...patch } };
        setBuiltins(next);
        saveBuiltinScreenEffectSettings(next);
    };
    const playPreview = (effect: ActiveScreenEffect["effect"], emojis: string) => {
        setPreview({ runId: `preview_${Date.now()}`, effect, emojis });
    };

    return (
        <div className="modal-overlay modal-overlay-bottom" onClick={onClose}>
            <div className="modal-sheet screen-fx-sheet" onClick={e => e.stopPropagation()}>
                <span className="screen-fx-grabber" aria-hidden="true" />
                <div className="screen-fx-titles">
                    <h2 className="screen-fx-title">全屏特效</h2>
                    <p className="screen-fx-subtitle">消息包含触发词即自动播放，全部会话通用</p>
                </div>

                <div className="screen-fx-tabs" role="tablist">
                    <button role="tab" aria-selected={tab === "rain"} {...(tab === "rain" ? { "data-active": "" } : {})} onClick={() => setTab("rain")}>
                        表情雨
                    </button>
                    <button role="tab" aria-selected={tab === "builtin"} {...(tab === "builtin" ? { "data-active": "" } : {})} onClick={() => setTab("builtin")}>
                        全屏特效
                    </button>
                </div>

                <div className="screen-fx-list">
                    {tab === "rain" ? (
                        <>
                            <p className="screen-fx-note">触发词可用逗号分隔多个，从上到下取第一个命中</p>
                            {rules.length === 0 && <p className="screen-fx-note">还没有规则，点下方按钮添加</p>}
                            {rules.map(rule => (
                                <div key={rule.id} className="screen-fx-card" {...(rule.enabled ? { "data-enabled": "" } : {})}>
                                    <label className="screen-fx-field">
                                        <span>触发词</span>
                                        <input
                                            type="text"
                                            value={rule.keyword}
                                            onChange={e => patchRule(rule.id, { keyword: e.target.value.slice(0, 60) })}
                                            placeholder="如：生日快乐"
                                        />
                                    </label>
                                    <label className="screen-fx-field">
                                        <span>下落表情</span>
                                        <input
                                            type="text"
                                            value={rule.emojis}
                                            onChange={e => patchRule(rule.id, { emojis: e.target.value.slice(0, 16) })}
                                            placeholder="如：🎂🎉"
                                        />
                                    </label>
                                    <div className="screen-fx-card-actions">
                                        <button className="screen-fx-pill-btn" onClick={() => playPreview("emoji_rain", rule.emojis)}>
                                            预览
                                        </button>
                                        <button className="screen-fx-icon-btn" aria-label="删除规则" onClick={() => updateRules(rules.filter(r => r.id !== rule.id))}>
                                            <Trash2 size={17} />
                                        </button>
                                        <Toggle checked={rule.enabled} onChange={c => patchRule(rule.id, { enabled: c })} />
                                    </div>
                                </div>
                            ))}
                            <button className="screen-fx-add-btn" onClick={() => updateRules([...rules, createChatScreenEffectRule()])}>
                                <Plus size={17} /> 添加规则
                            </button>
                        </>
                    ) : (
                        <>
                            <p className="screen-fx-note">在表情面板「特效」栏点击发送，或单独发一条只含图标的消息触发；图标夹在文字里不触发</p>
                            {BUILTIN_SCREEN_EFFECTS.map(effect => (
                                <div key={effect.type} className="screen-fx-card" {...(builtins[effect.type].enabled ? { "data-enabled": "" } : {})}>
                                    <div className="screen-fx-card-row">
                                        <span className="screen-fx-icon">{effect.icon}</span>
                                        <span className="screen-fx-name">{effect.name}</span>
                                        <button className="screen-fx-pill-btn" onClick={() => playPreview(effect.type, "")}>
                                            预览
                                        </button>
                                        <Toggle
                                            checked={builtins[effect.type].enabled}
                                            onChange={c => patchBuiltin(effect.type, { enabled: c })}
                                        />
                                    </div>
                                </div>
                            ))}
                        </>
                    )}
                </div>

                <div className="screen-fx-footer">
                    {tab === "rain" && (
                        <button className="screen-fx-reset-link" onClick={() => setRules(resetChatScreenEffectRules())}>
                            恢复默认规则
                        </button>
                    )}
                    <button className="screen-fx-cta" onClick={onClose}>完成</button>
                </div>
            </div>
            <ChatScreenEffectOverlay active={preview} onDone={() => setPreview(null)} />
        </div>
    );
}
