"use client";

import { useState, useEffect, useCallback, useContext } from "react";
import { Plus, User, Trash2, FileEdit, AlertCircle, Camera, Link, X, Check } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import { loadUserIdentities, saveUserIdentities } from "@/lib/settings-storage";
import { Input } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/modal";

export type UserIdentity = {
    id: string;
    name: string;
    avatarUrl?: string;
    bio: string;
    gender: string;
    age: string;
    occupation: string;
    customSettings: string;
    appearance?: string; // 生图形象：用于 AI 生图时描述"你"长什么样（性别/发型/衣着等）
};

const DEFAULT_IDENTITIES: UserIdentity[] = [
    {
        id: "identity-1",
        name: "李斯特",
        bio: "一个普通的上班族，喜欢在周末去咖啡馆看书。",
        gender: "男",
        age: "26",
        occupation: "程序员",
        customSettings: "性格温和，说话带有一点理性逻辑。",
    },
    {
        id: "identity-2",
        name: "匿名用户",
        bio: "神秘的过客。",
        gender: "保密",
        age: "未知",
        occupation: "自由职业者",
        customSettings: "说话简短，带有神秘色彩。",
    }
];

function fileToDataUrl(file: File, maxSize = 400, quality = 0.8): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/webp", quality));
            };
            img.onerror = reject;
            img.src = reader.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export function UserIdentitySettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [identities, setIdentitiesRaw] = useState<UserIdentity[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewIdentity, setIsNewIdentity] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    useEffect(() => {
        const saved = loadUserIdentities();
        if (saved.length > 0) {
            setIdentitiesRaw(saved);
        } else {
            setIdentitiesRaw(DEFAULT_IDENTITIES);
            saveUserIdentities(DEFAULT_IDENTITIES);
        }
    }, []);

    const setIdentities = useCallback((next: UserIdentity[]) => {
        setIdentitiesRaw(next);
        saveUserIdentities(next);
    }, []);

    const addIdentity = useCallback(() => {
        const newIdentity: UserIdentity = {
            id: `identity-${Date.now()}`,
            name: "新身份",
            bio: "",
            gender: "保密",
            age: "",
            occupation: "",
            customSettings: "",
        };
        const next = [newIdentity, ...identities];
        setIdentities(next);
        setIsNewIdentity(true);
        setEditingId(newIdentity.id);
    }, [identities, setIdentities]);

    useEffect(() => {
        setSubpageRightAction("identity",
            <button
                onClick={addIdentity}
                className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
            >
                <Plus size={15} strokeWidth={1.8} />
                <span>新增身份</span>
            </button>
        );
        return () => setSubpageRightAction("identity", null);
    }, [addIdentity, setSubpageRightAction]);

    const updateIdentity = (id: string, updates: Partial<UserIdentity>) => {
        setIdentities(identities.map(i => i.id === id ? { ...i, ...updates } : i));
    };

    const removeIdentity = (id: string) => {
        const next = identities.filter(i => i.id !== id);
        setIdentities(next);
        if (editingId === id) {
            setEditingId(null);
            setIsNewIdentity(false);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">User Identity</h2>
            </div>

            {identities.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <User size={24} />
                    </div>
                    <span className="menu-label font-semibold">没有身份卡片</span>
                    <span className="menu-desc max-w-[240px]">
                        在此管理您的个人身份信息，以便 AI 能够更好地了解您。
                    </span>
                    <button onClick={addIdentity} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> 添加身份
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {identities.map(identity => (
                        <div
                            key={identity.id}
                            className="ui-config-card min-w-0 cursor-pointer overflow-hidden"
                            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                            role="button"
                            tabIndex={0}
                            aria-label={`编辑 ${identity.name || "身份"}`}
                            onClick={() => setEditingId(identity.id)}
                            onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setEditingId(identity.id);
                                }
                            }}
                        >
                            <div className="min-w-0 flex flex-col gap-1">
                                <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{identity.name || "未命名身份"}</span>
                                <span className="menu-desc truncate">{identity.occupation || identity.bio || identity.gender || "未填写身份信息"}</span>
                            </div>
                            <div className="flex items-end justify-between gap-2">
                                {identity.avatarUrl ? (
                                    <img src={identity.avatarUrl} alt={identity.name} className="h-9 w-9 rounded-full object-cover shrink-0" />
                                ) : (
                                    <div className="h-9 w-9 rounded-full bg-[var(--c-page-body-bg)] text-[var(--c-icon)] grid place-items-center shrink-0">
                                        <User size={18} />
                                    </div>
                                )}

                                <div className="flex gap-2 shrink-0 items-center">
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setEditingId(identity.id);
                                        }}
                                        className="ui-link-btn"
                                    >
                                        <FileEdit size={18} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setConfirmDeleteId(identity.id);
                                        }}
                                        className="ui-link-btn"
                                        data-variant="danger"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editingId && (
                <div className="modal-overlay modal-overlay-bottom">
                    <div className="modal-sheet" data-ui="modal-sheet">
                        <div className="modal-header" data-ui="modal-header">
                            <button onClick={() => { if (isNewIdentity && editingId) removeIdentity(editingId); setIsNewIdentity(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-muted"><X size={18} /></button>
                            <span className="modal-header-title">{isNewIdentity ? "添加身份" : "编辑身份"}</span>
                            <button onClick={() => { setIsNewIdentity(false); setEditingId(null); }} className="modal-header-btn modal-header-btn-action"><Check size={18} /></button>
                        </div>

                        <div className="modal-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                            {(() => {
                                const identity = identities.find(c => c.id === editingId);
                                if (!identity) return null;
                                return (
                                    <>
                                        {/* Avatar upload + URL */}
                                        <div className="flex flex-col items-center gap-2">
                                            <div
                                                onClick={() => {
                                                    const input = document.createElement("input");
                                                    input.type = "file";
                                                    input.accept = "image/*";
                                                    input.onchange = async () => {
                                                        const file = input.files?.[0];
                                                        if (!file) return;
                                                        try {
                                                            const dataUrl = await fileToDataUrl(file);
                                                            updateIdentity(identity.id, { avatarUrl: dataUrl });
                                                        } catch { /* ignore */ }
                                                    };
                                                    input.click();
                                                }}
                                                className="ui-avatar-upload"
                                            >
                                                {identity.avatarUrl ? (
                                                    <>
                                                        <img src={identity.avatarUrl} alt="" className="w-full h-full object-cover" />
                                                        <div className="absolute bottom-0 left-0 right-0 flex justify-center ui-avatar-upload-overlay">
                                                            <Camera size={14} color="#fff" />
                                                        </div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <User size={28} className="text-[var(--c-icon-active)]" />
                                                        <span className="ts-10 mt-[2px] text-[var(--c-icon-active)]">点击上传</span>
                                                    </>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-[6px] w-full max-w-[280px]">
                                                <Link size={14} className="shrink-0 text-[var(--c-text)]" />
                                                <Input
                                                    type="text"
                                                    value={identity.avatarUrl?.startsWith("data:") ? "" : (identity.avatarUrl || "")}
                                                    onChange={(e) => updateIdentity(identity.id, { avatarUrl: e.target.value })}
                                                    placeholder="或粘贴图片URL..."
                                                    className="flex-1 ts-12 px-[10px] py-[6px]"
                                                />
                                            </div>
                                        </div>

                                        <div className="flex gap-3">
                                            <div className="flex flex-col gap-1 flex-1 min-w-0">
                                                <label className="menu-desc ml-1">名字 (Name)</label>
                                                <Input
                                                    type="text"
                                                    value={identity.name}
                                                    onChange={(e) => updateIdentity(identity.id, { name: e.target.value })}
                                                    placeholder="您希望AI怎么称呼您..."
                                                    className="font-medium"
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1 w-[90px] shrink-0">
                                                <label className="menu-desc ml-1">性别</label>
                                                <select
                                                    value={identity.gender}
                                                    onChange={(e) => updateIdentity(identity.id, { gender: e.target.value })}
                                                    className="ui-select"
                                                >
                                                    <option value="保密">保密</option>
                                                    <option value="男">男</option>
                                                    <option value="女">女</option>
                                                    <option value="其他">其他</option>
                                                </select>
                                            </div>
                                        </div>

                                        <div className="flex gap-3">
                                            <div className="flex flex-col gap-1 flex-1 min-w-0">
                                                <label className="menu-desc ml-1">年龄 (Age)</label>
                                                <input
                                                    type="text"
                                                    value={identity.age}
                                                    onChange={(e) => updateIdentity(identity.id, { age: e.target.value })}
                                                    placeholder="例如: 24, 未知"
                                                    className="ui-input"
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1 flex-1 min-w-0">
                                                <label className="menu-desc ml-1">职业 (Occupation)</label>
                                                <input
                                                    type="text"
                                                    value={identity.occupation}
                                                    onChange={(e) => updateIdentity(identity.id, { occupation: e.target.value })}
                                                    placeholder="例如: 学生, 自由职业"
                                                    className="ui-input"
                                                />
                                            </div>
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">简介 (Bio)</label>
                                            <textarea
                                                value={identity.bio}
                                                onChange={(e) => updateIdentity(identity.id, { bio: e.target.value })}
                                                placeholder="简单描述一下自己，这会作为AI了解您的基础背景..."
                                                rows={3}
                                                className="ui-textarea"
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">生图形象 (Appearance)</label>
                                            <textarea
                                                value={identity.appearance || ""}
                                                onChange={(e) => updateIdentity(identity.id, { appearance: e.target.value })}
                                                placeholder="用于 AI 生图时描述「你」长什么样（性别/发型/衣着/气质）。例如：女生，黑色长发及肩，常穿浅色连衣裙。留空则仅按上方性别生成。"
                                                rows={2}
                                                className="ui-textarea"
                                            />
                                        </div>

                                        <div className="flex flex-col gap-1">
                                            <label className="menu-desc ml-1">自定义设定 (Custom Settings)</label>
                                            <textarea
                                                value={identity.customSettings}
                                                onChange={(e) => updateIdentity(identity.id, { customSettings: e.target.value })}
                                                placeholder="更深度的性格爱好描述，对话的特殊要求等..."
                                                rows={4}
                                                className="ui-textarea"
                                            />
                                        </div>
                                    </>
                                )
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除身份卡片后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeIdentity(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
