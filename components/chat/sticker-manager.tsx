"use client";

import { memo, useCallback, useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Trash2, Plus, Smile, ImagePlus, Check, ChevronDown, ChevronRight, Info, Pencil, Sticker, Layers } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    loadStickerPacks,
    createStickerPack,
    deleteStickerPack,
    addStickerToPack,
    addStickersToPack,
    addStickerByUrlToPack,
    checkStickerBlob,
    updateStickerPackInfo,
    STICKER_PACK_NAME_MAX,
    STICKER_PACK_NOTE_MAX,
    renameStickerInPack,
    removeStickerFromPack,
    getPackAssignments,
    togglePackAssignment,
    resolvePackStickerMap,
    getCharacterPackIds,
    type StickerItem,
    type StickerPack,
} from "@/lib/custom-sticker-storage";
import { loadChatContacts } from "@/lib/chat-storage";
import { PageShell } from "@/components/ui/page-shell";
import { ConfirmDialog } from "@/components/ui/modal";

export function StickerManager({ onBack }: { onBack: () => void }) {
    const contactIds = new Set(loadChatContacts().map(c => c.characterId));
    const characters = loadCharacters().filter(c => contactIds.has(c.id));
    const [packs, setPacks] = useState<StickerPack[]>([]);
    const [editingPack, setEditingPack] = useState<StickerPack | null>(null);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [deletingPackId, setDeletingPackId] = useState<string | null>(null);

    const refresh = () => setPacks(loadStickerPacks());
    useEffect(() => { refresh(); }, []);

    const handleConfirmDeletePack = async () => {
        if (!deletingPackId) return;
        await deleteStickerPack(deletingPackId);
        setDeletingPackId(null);
        refresh();
    };

    if (editingPack) {
        return (
            <PackEditor
                pack={editingPack}
                onBack={() => { setEditingPack(null); refresh(); }}
            />
        );
    }

    return (
        <PageShell title="表情包管理" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="px-5 pt-4 pb-8 h-full overflow-y-auto">
                <div className="grid grid-cols-2 gap-4">
                    {packs.map((pack, i) => {
                        const assignedIds = getPackAssignments(pack.id);
                        const assignedNames = characters.filter(c => assignedIds.includes(c.id)).map(c => c.name);
                        
                        // Pick a dynamic gradient based on index so the grid looks vibrant
                        const gradients = [
                            "from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 text-teal-600",
                            "from-orange-100 to-amber-100 dark:from-orange-900/30 dark:to-amber-900/30 text-orange-600",
                            "from-blue-100 to-indigo-100 dark:from-blue-900/30 dark:to-indigo-900/30 text-indigo-600",
                            "from-pink-100 to-rose-100 dark:from-pink-900/30 dark:to-rose-900/30 text-rose-600",
                        ];
                        const gClass = gradients[i % gradients.length];
                        const [bgGrad, textColor] = [gClass.split(" text-")[0], "text-" + gClass.split(" text-")[1]];

                        return (
                        <div key={pack.id} className="relative group">
                            <button
                                onClick={() => setEditingPack(pack)}
                                className="w-full bg-[var(--c-card)] rounded-[22px] p-4 pb-5 flex flex-col items-start gap-4 cursor-pointer text-left transition-transform duration-200 active:scale-[0.96] border-none"
                                style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.025), inset 0 1px 0 rgba(255,255,255,0.4)" }}
                            >
                                <div className={`w-[48px] h-[48px] rounded-2xl bg-gradient-to-br ${bgGrad} flex items-center justify-center shrink-0 shadow-inner`}>
                                    <Sticker size={24} className={textColor} />
                                </div>
                                
                                <div className="flex flex-col w-full gap-0.5">
                                    <span className="ts-16 text-[var(--c-text-title)] font-bold truncate max-w-full leading-tight">{pack.name}</span>
                                    <span className="ts-12 text-[var(--c-text)] opacity-70">{pack.stickers.length === 0 ? "空相册" : `${pack.stickers.length} 个表情`}</span>
                                    {pack.note?.trim() && (
                                        <span className="ts-11 text-[var(--c-text)] opacity-50 truncate mt-1">{pack.note.trim()}</span>
                                    )}
                                </div>

                                {assignedNames.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mt-auto max-w-full w-full">
                                        {assignedNames.slice(0, 2).map(name => (
                                            <span key={name} className="px-2 py-0.5 rounded-md ts-10 font-medium truncate max-w-[full]" style={{ background: "color-mix(in srgb, var(--c-icon) 8%, transparent)", color: "var(--c-text)" }}>{name}</span>
                                        ))}
                                        {assignedNames.length > 2 && (
                                            <span className="px-1.5 py-0.5 rounded-md ts-10 font-bold" style={{ background: "color-mix(in srgb, var(--c-icon) 8%, transparent)", color: "var(--c-text)" }}>+{assignedNames.length - 2}</span>
                                        )}
                                    </div>
                                )}
                            </button>
                            <button
                                type="button"
                                aria-label={`删除表情包组 ${pack.name}`}
                                onClick={() => setDeletingPackId(pack.id)}
                                className="absolute top-2 right-2 w-7 h-7 bg-white/60 dark:bg-black/40 backdrop-blur-md rounded-full flex items-center justify-center text-[var(--c-danger)] opacity-100 transition-opacity z-10 shadow-sm"
                            ><Trash2 size={14} /></button>
                        </div>
                        );
                    })}
                    
                    {/* Add tile */}
                    <button
                        onClick={() => setShowCreateDialog(true)}
                        className="w-full min-h-[160px] bg-transparent rounded-[22px] flex flex-col items-center justify-center gap-3 cursor-pointer transition-transform duration-200 active:scale-[0.96] border-[1.5px] border-dashed border-[var(--c-card-border)] opacity-60 hover:opacity-100"
                    >
                        <div className="w-[46px] h-[46px] rounded-full bg-[var(--c-card)] shadow-sm flex items-center justify-center text-[var(--c-icon)]">
                            <Plus size={24} />
                        </div>
                        <span className="ts-14 font-medium text-[var(--c-text)]">新建图集</span>
                    </button>
                </div>
            </div>

            {showCreateDialog && createPortal(
                <CreatePackDialog
                    characters={characters}
                    onConfirm={(pack) => {
                        setShowCreateDialog(false);
                        refresh();
                        setEditingPack(pack);
                    }}
                    onCancel={() => setShowCreateDialog(false)}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}

            {deletingPackId && createPortal(
                <ConfirmDialog
                    title="删除表情包组"
                    message="删除后所有表情将被清除，确定要删除吗？"
                    variant="danger"
                    confirmLabel="删除"
                    onConfirm={handleConfirmDeletePack}
                    onCancel={() => setDeletingPackId(null)}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}
        </PageShell>
    );
}

// ── Create Pack Dialog (centered modal) ──

function CreatePackDialog({
    characters,
    onConfirm,
    onCancel,
}: {
    characters: Character[];
    onConfirm: (pack: StickerPack) => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const [selectedCharIds, setSelectedCharIds] = useState<string[]>([]);

    const handleToggle = (charId: string) => {
        setSelectedCharIds(prev =>
            prev.includes(charId) ? prev.filter(id => id !== charId) : [...prev, charId]
        );
    };

    const handleCreate = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const pack = createStickerPack(trimmed, note.trim());
        for (const charId of selectedCharIds) {
            togglePackAssignment(pack.id, charId);
        }
        onConfirm(pack);
    };

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onCancel}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3 className="modal-title">创建表情包组</h3>
                </div>

                <div className="modal-body">
                    <div className="flex flex-col gap-4 text-left w-full">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">名称</label>
                            <input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="例如：可爱猫猫"
                                className="ui-input"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">备注（可选）</label>
                            <textarea
                                value={note}
                                onChange={e => setNote(e.target.value)}
                                placeholder="例如：由某某老师整理分享，目前还差 20 个表情待整理"
                                className="ui-input min-h-[88px] resize-y"
                                maxLength={STICKER_PACK_NOTE_MAX}
                                rows={3}
                            />
                        </div>

                        {characters.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">应用角色</label>
                                <div className="flex flex-wrap gap-2">
                                    {characters.map(c => (
                                        <button
                                            key={c.id}
                                            onClick={() => handleToggle(c.id)}
                                            className="ui-chip"
                                            {...(selectedCharIds.includes(c.id) ? { "data-selected": "" } : {})}
                                        >
                                            {c.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="ui-btn ui-btn-ghost" onClick={onCancel}>取消</button>
                    <button
                        className="ui-btn ui-btn-primary"
                        onClick={handleCreate}
                        disabled={!name.trim()}
                    >
                        创建
                    </button>
                </div>
            </div>
        </div>
    );
}

type StickerCardProps = {
    sticker: StickerItem;
    imageUrl?: string;
    isEditing: boolean;
    editingValue: string;
    onStartEdit: (sticker: StickerItem) => void;
    onEditingValueChange: (value: string) => void;
    onCommitName: (stickerId: string) => void;
    onRemove: (sticker: StickerItem) => Promise<void>;
};

const StickerCard = memo(function StickerCard({
    sticker,
    imageUrl,
    isEditing,
    editingValue,
    onStartEdit,
    onEditingValueChange,
    onCommitName,
    onRemove,
}: StickerCardProps) {
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [removing, setRemoving] = useState(false);

    const handleConfirmRemove = async () => {
        if (removing) return;
        setRemoving(true);
        try {
            await onRemove(sticker);
            setShowDeleteConfirm(false);
        } finally {
            setRemoving(false);
        }
    };

    return (
        <div className="flex flex-col items-center gap-2 relative group cursor-pointer">
            <div className="w-full aspect-square rounded-[20px] overflow-hidden bg-black/5 dark:bg-white/5 flex items-center justify-center relative p-1 transition-transform group-active:scale-95">
                {imageUrl ? (
                    <img src={imageUrl} alt={sticker.name} className="w-full h-full object-contain drop-shadow-sm" />
                ) : (
                    <span className="ts-12 font-medium text-[var(--c-text)] opacity-40">...</span>
                )}
                <button
                    type="button"
                    aria-label={`删除表情 ${sticker.name}`}
                    onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                    className="absolute top-1.5 right-1.5 w-6 h-6 bg-white/60 dark:bg-black/40 backdrop-blur-md rounded-full flex items-center justify-center text-[var(--c-danger)] opacity-100 transition-opacity z-10 shadow-sm"
                ><Trash2 size={12} /></button>
            </div>
            <div className="w-full px-1">
                {isEditing ? (
                    <input
                        className="ts-13 font-medium text-center text-[var(--c-text-title)] bg-transparent border-b-2 border-[var(--c-icon-active)] outline-none max-w-full p-0 w-full"
                        value={editingValue}
                        onChange={e => onEditingValueChange(e.target.value)}
                        onBlur={() => onCommitName(sticker.id)}
                        onKeyDown={e => { if (e.key === "Enter") onCommitName(sticker.id); }}
                        autoFocus
                        autoComplete="off"
                    />
                ) : (
                    <span
                        className="ts-13 text-[var(--c-text)] font-medium truncate w-full block text-center transition-colors hover:text-[var(--c-icon-active)] select-none"
                        onClick={() => onStartEdit(sticker)}
                    >{sticker.name}</span>
                )}
            </div>

            {showDeleteConfirm && createPortal(
                <ConfirmDialog
                    title="删除表情"
                    message="确定要删除这个表情吗？"
                    variant="danger"
                    confirmLabel={removing ? "删除中" : "删除"}
                    overlayClassName="sticker-delete-confirm-overlay"
                    dialogClassName="sticker-delete-confirm-dialog"
                    onConfirm={handleConfirmRemove}
                    onCancel={() => { if (!removing) setShowDeleteConfirm(false); }}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}
        </div>
    );
});

// ── Pack Editor (sub-page) ──

function PackEditor({ pack, onBack }: { pack: StickerPack; onBack: () => void }) {
    const characters = loadCharacters();
    const [currentPack, setCurrentPack] = useState(pack);
    const [urlMap, setUrlMap] = useState<Record<string, string>>({});
    const [assignedCharIds, setAssignedCharIds] = useState<string[]>([]);
    const [showAddDialog, setShowAddDialog] = useState(false);
    const [showBatchDialog, setShowBatchDialog] = useState(false);
    const [packNameDraft, setPackNameDraft] = useState(pack.name);
    const [packNoteDraft, setPackNoteDraft] = useState(pack.note ?? "");
    // 改名进标题栏、备注默认折叠：把两块常驻编辑区收起来，别挤表情格子。
    // 交互设计来自社区 #149（V2），实现按当前存储层（updateStickerPackInfo）重接
    const [isEditingPackName, setIsEditingPackName] = useState(false);
    const [isNoteExpanded, setIsNoteExpanded] = useState(false);
    const [showNoteInfo, setShowNoteInfo] = useState(false);

    const refreshPack = useCallback(() => {
        const fresh = loadStickerPacks().find(p => p.id === pack.id);
        if (fresh) {
            setCurrentPack(fresh);
            resolvePackStickerMap(fresh).then((nameMap) => {
                const next: Record<string, string> = {};
                fresh.stickers.forEach(sticker => {
                    const url = nameMap[sticker.name];
                    if (url) next[sticker.id] = url;
                });
                setUrlMap(next);
            });
        }
    }, [pack.id]);

    const refreshAssignments = () => {
        setAssignedCharIds(getPackAssignments(pack.id));
    };

    useEffect(() => {
        refreshPack();
        refreshAssignments();
    }, [refreshPack]);

    const handleStickerAdded = () => {
        setShowAddDialog(false);
        refreshPack();
    };

    const [editingNameId, setEditingNameId] = useState<string | null>(null);
    const [editingNameValue, setEditingNameValue] = useState("");

    const handleStartNameEdit = useCallback((sticker: StickerItem) => {
        setEditingNameId(sticker.id);
        setEditingNameValue(sticker.name);
    }, []);

    const handleNameCommit = useCallback((stickerId: string) => {
        const trimmed = editingNameValue.trim();
        if (trimmed) {
            renameStickerInPack(pack.id, stickerId, trimmed);
            refreshPack();
        }
        setEditingNameId(null);
    }, [editingNameValue, pack.id, refreshPack]);

    const handleRemoveSticker = useCallback(async (sticker: StickerItem) => {
        await removeStickerFromPack(pack.id, sticker.id);
        setCurrentPack(prev => ({
            ...prev,
            stickers: prev.stickers.filter(item => item.id !== sticker.id),
        }));
        setUrlMap(prev => {
            if (!prev[sticker.id]) return prev;
            const next = { ...prev };
            delete next[sticker.id];
            return next;
        });
        if (editingNameId === sticker.id) {
            setEditingNameId(null);
            setEditingNameValue("");
        }
    }, [editingNameId, pack.id]);

    const handleToggleChar = (charId: string) => {
        togglePackAssignment(pack.id, charId);
        refreshAssignments();
    };

    const handlePackNameSave = () => {
        const trimmedName = packNameDraft.trim();
        if (!trimmedName) return;
        updateStickerPackInfo(pack.id, { name: trimmedName });
        setPackNameDraft(trimmedName);
        setIsEditingPackName(false);
        refreshPack();
    };

    const handleNoteSave = () => {
        const trimmedNote = packNoteDraft.trim();
        updateStickerPackInfo(pack.id, { note: trimmedNote });
        setPackNoteDraft(trimmedNote);
        refreshPack();
    };

    const noteChanged = packNoteDraft.trim() !== (currentPack.note ?? "");

    return (
        <PageShell
            title={isEditingPackName ? (
                <input
                    autoFocus
                    type="text"
                    value={packNameDraft}
                    maxLength={STICKER_PACK_NAME_MAX}
                    onChange={e => setPackNameDraft(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") handlePackNameSave();
                        if (e.key === "Escape") {
                            setPackNameDraft(currentPack.name);
                            setIsEditingPackName(false);
                        }
                    }}
                    className="ui-input h-9 w-full min-w-0 px-2 text-center font-bold"
                    aria-label="图集名称"
                />
            ) : currentPack.name}
            onBack={onBack}
            rightAction={
                <button
                    type="button"
                    onClick={isEditingPackName ? handlePackNameSave : () => { setPackNameDraft(currentPack.name); setIsEditingPackName(true); }}
                    aria-label={isEditingPackName ? "保存图集名称" : "编辑图集名称"}
                    className="w-10 h-10 flex items-center justify-center rounded-full text-[var(--c-icon)] active:scale-95 transition-transform bg-transparent border-none cursor-pointer"
                >
                    {isEditingPackName ? <Check size={20} /> : <Pencil size={18} />}
                </button>
            }
            className="absolute inset-0 z-[100]"
        >
            <div className="flex flex-col h-full bg-[var(--c-page-body-bg)]">
                {/* 备注：默认折叠成一行，点开才出编辑区（改名挪去了标题栏的铅笔按钮） */}
                <div className="px-6 pt-4 pb-1 shrink-0">
                    <button
                        type="button"
                        onClick={() => setIsNoteExpanded(prev => !prev)}
                        aria-expanded={isNoteExpanded}
                        className="w-full flex items-center justify-between px-1 py-1.5 text-left text-[var(--c-text)] bg-transparent border-none cursor-pointer"
                    >
                        <span className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[calc(12px*var(--app-text-scale,1))] font-bold opacity-60 uppercase tracking-[0.1em] shrink-0">备注</span>
                            <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => { e.stopPropagation(); setShowNoteInfo(true); }}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setShowNoteInfo(true); } }}
                                className="flex items-center justify-center text-[var(--c-icon)] opacity-50 active:opacity-100 transition-opacity shrink-0"
                                aria-label="备注说明"
                            >
                                <Info size={14} />
                            </span>
                            {!isNoteExpanded && currentPack.note?.trim() ? (
                                <span className="ts-11 opacity-50 truncate">{currentPack.note.trim()}</span>
                            ) : null}
                        </span>
                        {isNoteExpanded ? <ChevronDown size={17} className="shrink-0" /> : <ChevronRight size={17} className="shrink-0" />}
                    </button>
                    {isNoteExpanded && (
                        <div className="flex flex-col gap-2 px-1 pt-1">
                            <textarea
                                value={packNoteDraft}
                                maxLength={STICKER_PACK_NOTE_MAX}
                                onChange={e => setPackNoteDraft(e.target.value)}
                                placeholder="备注这套表情包的来源、整理进度等（可选）"
                                className="ui-input min-h-[72px] resize-y"
                                rows={2}
                            />
                            <div className="flex items-center justify-between">
                                <span className="ts-11 text-[var(--c-text)] opacity-50">{packNoteDraft.length}/{STICKER_PACK_NOTE_MAX}</span>
                                <button type="button" onClick={handleNoteSave} disabled={!noteChanged} className="ui-btn ui-btn-primary ts-12">保存</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Character assignment section */}
                <div className="px-6 pt-4 pb-2 shrink-0">
                    <div className="text-[calc(12px*var(--app-text-scale,1))] font-bold text-[var(--c-text)] opacity-60 uppercase mb-3 px-1 tracking-[0.1em]">智能角色绑定</div>
                    <div className="flex flex-wrap gap-2.5 px-1">
                        {characters.map(c => {
                            const active = assignedCharIds.includes(c.id);
                            return (
                                <button
                                    key={c.id}
                                    onClick={() => handleToggleChar(c.id)}
                                    className="ui-chip"
                                    {...(active ? { "data-selected": "" } : {})}
                                >
                                    {c.name}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Sticker grid canvas */}
                <div className="flex-1 mt-4 bg-[var(--c-card)] rounded-t-[32px] p-6 shadow-[0_-8px_32px_rgba(0,0,0,0.02)] border-t border-[var(--c-card-border)]/30 min-h-0 overflow-y-auto">
                    <div className="flex items-center justify-between mb-5 px-1">
                        <div className="text-[calc(18px*var(--app-text-scale,1))] font-bold text-[var(--c-text-title)]">表情库 <span className="text-[var(--c-text)] opacity-50 font-medium ml-1 text-base">{currentPack.stickers.length}</span></div>
                        <button
                            type="button"
                            onClick={() => setShowBatchDialog(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full ts-12 font-semibold active:scale-95 transition-transform"
                            style={{ background: "color-mix(in srgb, var(--c-icon-active) 12%, transparent)", color: "var(--c-icon-active)" }}
                        >
                            <Layers size={14} /> 批量导入
                        </button>
                    </div>
                    
                    <div className="grid grid-cols-3 gap-x-4 gap-y-6 pb-20">
                        {currentPack.stickers.map(s => (
                            <StickerCard
                                key={s.id}
                                sticker={s}
                                imageUrl={urlMap[s.id]}
                                isEditing={editingNameId === s.id}
                                editingValue={editingNameValue}
                                onStartEdit={handleStartNameEdit}
                                onEditingValueChange={setEditingNameValue}
                                onCommitName={handleNameCommit}
                                onRemove={handleRemoveSticker}
                            />
                        ))}
                        {/* Add tile */}
                        <div className="flex flex-col items-center">
                            <button
                                onClick={() => setShowAddDialog(true)}
                                className="w-full aspect-square rounded-[20px] bg-transparent border-[1.5px] border-dashed border-[var(--c-icon)]/30 flex flex-col items-center justify-center gap-1.5 text-[var(--c-icon)] cursor-pointer opacity-80 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5 transition-all active:scale-95"
                            >
                                <Plus size={26} strokeWidth={2}/>
                                <span className="ts-11 font-medium">添加</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {showAddDialog && createPortal(
                <AddStickerDialog
                    packId={pack.id}
                    onDone={handleStickerAdded}
                    onCancel={() => setShowAddDialog(false)}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}

            {showBatchDialog && createPortal(
                <BatchAddStickerDialog
                    packId={pack.id}
                    onDone={() => { setShowBatchDialog(false); refreshPack(); }}
                    onCancel={() => setShowBatchDialog(false)}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}

            {showNoteInfo && createPortal(
                <ConfirmDialog
                    title="备注说明"
                    message="备注仅供自己整理使用，不会进入提示词——角色和助手小卷都看不到。"
                    confirmLabel="我知道了"
                    cancelLabel=""
                    onConfirm={() => setShowNoteInfo(false)}
                    onCancel={() => setShowNoteInfo(false)}
                />,
                document.querySelector(".phone-shell") ?? document.body
            )}

        </PageShell>
    );
}

// ── Add Sticker Dialog ──

function AddStickerDialog({
    packId,
    onDone,
    onCancel,
}: {
    packId: string;
    onDone: () => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [fileError, setFileError] = useState<string | null>(null);
    const selectedFile = useRef<File | null>(null);

    const hasImage = !!previewSrc;
    const canSubmit = !!name.trim() && hasImage && !fileError;

    const handleFileChange = () => {
        const f = fileInputRef.current?.files?.[0];
        if (!f) return;
        const err = checkStickerBlob(f);
        setFileError(err);
        if (err) {
            selectedFile.current = null;
            setPreviewSrc(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }
        selectedFile.current = f;
        setUrl("");
        const reader = new FileReader();
        reader.onload = () => setPreviewSrc(reader.result as string);
        reader.readAsDataURL(f);
    };

    const handleUrlBlur = () => {
        const trimmed = url.trim();
        if (trimmed) {
            selectedFile.current = null;
            setFileError(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
            setPreviewSrc(trimmed);
        }
    };

    const handleAdd = async () => {
        if (!canSubmit || adding) return;
        setAdding(true);
        if (selectedFile.current) {
            try {
                await addStickerToPack(packId, name.trim(), selectedFile.current);
            } catch {
                setFileError("添加失败，请换一张图片重试");
                setAdding(false);
                return;
            }
        } else if (url.trim()) {
            addStickerByUrlToPack(packId, name.trim(), url.trim());
        }
        onDone();
    };

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onCancel}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h3 className="modal-title">添加表情</h3>
                </div>

                <div className="modal-body">
                    <div className="flex flex-col gap-4 text-left w-full">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">名称</label>
                            <input
                                type="text"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="AI会用此名称发送表情"
                                className="ui-input"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">图片URL</label>
                            <input
                                type="text"
                                value={url}
                                onChange={e => setUrl(e.target.value)}
                                onBlur={handleUrlBlur}
                                placeholder="输入图片URL"
                                className="ui-input"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={handleFileChange}
                            />
                            {previewSrc ? (
                                <div
                                    className="w-full h-[120px] rounded-[var(--ui-radius)] border border-[var(--c-input-border)] bg-[var(--c-input)] flex items-center justify-center cursor-pointer"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <img src={previewSrc} alt="preview" className="max-w-full max-h-full object-contain" />
                                </div>
                            ) : (
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    className="w-full h-[120px] rounded-[var(--ui-radius)] border border-dashed border-[var(--c-input-border)] bg-[var(--c-input)] flex flex-col items-center justify-center gap-2 text-[var(--c-icon)] cursor-pointer"
                                >
                                    <ImagePlus size={28} />
                                    <span className="ts-13">选择图片</span>
                                </button>
                            )}
                            {fileError && <span className="ts-11 ml-1" style={{ color: "var(--c-danger)" }}>{fileError}</span>}
                        </div>
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="ui-btn ui-btn-ghost" onClick={onCancel}>取消</button>
                    <button
                        className="ui-btn ui-btn-primary"
                        onClick={handleAdd}
                        disabled={!canSubmit || adding}
                    >
                        添加
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Batch Add Sticker Dialog（一屏列表 + 逐个改名 + 查重）──

type BatchRow = {
    id: string;
    source: "file" | "url";
    file?: File;
    url: string;
    name: string;
};

const BATCH_STICKER_URL_RE = /https?:\/\/[^\s，。；;]+/i;

function getStickerBaseName(filename: string): string {
    return filename.replace(/\.[^.]+$/, "").trim() || "表情";
}

function normalizeBatchStickerUrl(rawUrl: string): string | null {
    const cleaned = rawUrl.trim().replace(/[，。；;]+$/g, "");
    try {
        const parsed = new URL(cleaned);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

function getStickerNameFromUrl(url: string, index: number): string {
    try {
        const pathName = new URL(url).pathname;
        const filename = decodeURIComponent(pathName.split("/").filter(Boolean).pop() || "");
        return getStickerBaseName(filename) || `表情${index + 1}`;
    } catch {
        return `表情${index + 1}`;
    }
}

function parseBatchStickerUrlRows(text: string): Array<{ name: string; url: string }> {
    return text
        .split(/\r?\n/)
        .map((line, index) => {
            const trimmed = line.trim();
            if (!trimmed) return null;
            const match = trimmed.match(BATCH_STICKER_URL_RE);
            if (!match || match.index === undefined) return null;
            const url = normalizeBatchStickerUrl(match[0]);
            if (!url) return null;
            const label = trimmed.slice(0, match.index).trim().replace(/[:：\s]+$/g, "");
            return {
                name: label || getStickerNameFromUrl(url, index),
                url,
            };
        })
        .filter((row): row is { name: string; url: string } => Boolean(row));
}

function BatchAddStickerDialog({
    packId,
    onDone,
    onCancel,
}: {
    packId: string;
    onDone: () => void;
    onCancel: () => void;
}) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [rows, setRows] = useState<BatchRow[]>([]);
    const [urlText, setUrlText] = useState("");
    const [urlError, setUrlError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [progress, setProgress] = useState(0);

    // 该组已有的表情名（用于查重），与已创建的 objectURL（卸载时统一释放）
    const existingNames = useRef<Set<string>>(new Set());
    const urlsRef = useRef<string[]>([]);
    useEffect(() => {
        const p = loadStickerPacks().find(x => x.id === packId);
        existingNames.current = new Set((p?.stickers ?? []).map(s => s.name.trim().toLowerCase()));
    }, [packId]);
    useEffect(() => () => { urlsRef.current.forEach(u => URL.revokeObjectURL(u)); }, []);

    const addFiles = (files: FileList | null) => {
        if (!files) return;
        const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
        const next: BatchRow[] = imgs.map((file, i) => {
            const url = URL.createObjectURL(file);
            urlsRef.current.push(url);
            return {
                id: `row_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
                source: "file" as const,
                file,
                url,
                name: getStickerBaseName(file.name),
            };
        });
        setRows(prev => [...prev, ...next]);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const addUrls = () => {
        const parsed = parseBatchStickerUrlRows(urlText);
        if (parsed.length === 0) {
            setUrlError("没有识别到可用的图片URL");
            return;
        }
        setRows(prev => [
            ...prev,
            ...parsed.map((row, i) => ({
                id: `urlrow_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
                source: "url" as const,
                url: row.url,
                name: row.name,
            })),
        ]);
        setUrlText("");
        setUrlError(null);
    };

    const setRowName = (id: string, name: string) => setRows(prev => prev.map(r => r.id === id ? { ...r, name } : r));
    const removeRow = (id: string) => setRows(prev => prev.filter(r => r.id !== id));
    const resetToFilenames = () => setRows(prev => prev.map((r, i) => ({
        ...r,
        name: r.source === "file" && r.file ? getStickerBaseName(r.file.name) : getStickerNameFromUrl(r.url, i),
    })));
    const numberNames = () => setRows(prev => prev.map((r, i) => ({ ...r, name: `表情${i + 1}` })));

    // 名称查重：本批内 + 与已有表情
    const nameCounts = useMemo(() => {
        const m = new Map<string, number>();
        rows.forEach(r => { const k = r.name.trim().toLowerCase(); if (k) m.set(k, (m.get(k) ?? 0) + 1); });
        return m;
    }, [rows]);

    const rowError = (r: BatchRow): string | null => {
        const t = r.name.trim();
        if (!t) return "名称不能为空";
        const k = t.toLowerCase();
        if (existingNames.current.has(k)) return "与已有表情重名";
        if ((nameCounts.get(k) ?? 0) > 1) return "本批重名";
        if (r.file) return checkStickerBlob(r.file);
        return null;
    };

    const readyCount = rows.filter(r => !rowError(r)).length;
    const allValid = rows.length > 0 && readyCount === rows.length;

    const handleSubmit = async () => {
        if (!allValid || adding) return;
        setAdding(true);
        setProgress(0);
        const fileRows = rows.filter((r): r is BatchRow & { file: File } => r.source === "file" && Boolean(r.file));
        const urlRows = rows.filter(r => r.source === "url");
        const total = rows.length;
        if (fileRows.length > 0) {
            await addStickersToPack(
                packId,
                fileRows.map(r => ({ name: r.name.trim(), blob: r.file })),
                (done) => setProgress(Math.round((done / total) * 100)),
            );
        }
        urlRows.forEach((row, i) => {
            addStickerByUrlToPack(packId, row.name.trim(), row.url);
            setProgress(Math.round(((fileRows.length + i + 1) / total) * 100));
        });
        setAdding(false);
        onDone();
    };

    return (
        <div className="modal-overlay sticker-batch-import-overlay" data-ui="modal" onClick={adding ? undefined : onCancel}>
            <div className="modal-dialog sticker-batch-import-dialog" onClick={e => e.stopPropagation()} style={{ width: "min(440px, 92vw)" }}>
                <div className="modal-header">
                    <h3 className="modal-title">批量添加表情{rows.length > 0 ? ` · ${rows.length}` : ""}</h3>
                </div>

                <div className="modal-body">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={e => addFiles(e.target.files)}
                    />

                    <div className="flex flex-col gap-3 text-left w-full">
                        {rows.length === 0 ? (
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="w-full h-[118px] rounded-[var(--ui-radius)] border border-dashed border-[var(--c-input-border)] bg-[var(--c-input)] flex flex-col items-center justify-center gap-2 text-[var(--c-icon)] cursor-pointer"
                            >
                                <ImagePlus size={30} />
                                <span className="ts-13 font-medium">选择多张图片</span>
                                <span className="ts-11 opacity-60">或在下方粘贴URL列表</span>
                            </button>
                        ) : (
                            <div className="flex items-center flex-wrap gap-2">
                                <button className="ui-chip" onClick={() => fileInputRef.current?.click()}>+ 继续选择</button>
                                <button className="ui-chip" onClick={resetToFilenames}>用来源命名</button>
                                <button className="ui-chip" onClick={numberNames}>按序号</button>
                            </div>
                        )}

                        <div className="flex flex-col gap-1.5">
                            <label className="menu-desc ml-1">批量URL</label>
                            <textarea
                                value={urlText}
                                onChange={e => { setUrlText(e.target.value); setUrlError(null); }}
                                placeholder={"贴贴：https://example.com/a.jpg\n可爱 https://example.com/b.gif"}
                                className="ui-input"
                                rows={4}
                                style={{ resize: "vertical", minHeight: 88 }}
                            />
                            <div className="flex items-center justify-between gap-2">
                                <span className="ts-11 opacity-60">每行一个，支持“名称：URL”或“名称 URL”</span>
                                <button type="button" className="ui-chip" onClick={addUrls} disabled={adding || !urlText.trim()}>添加URL</button>
                            </div>
                            {urlError && <span className="ts-11 ml-1" style={{ color: "var(--c-danger)" }}>{urlError}</span>}
                        </div>

                        {rows.length > 0 ? (
                            <div className="flex flex-col gap-2 max-h-[36vh] overflow-y-auto pr-1 -mr-1">
                                {rows.map(r => {
                                    const err = rowError(r);
                                    return (
                                        <div key={r.id} className="flex items-center gap-3">
                                            <div className="w-12 h-12 shrink-0 rounded-xl overflow-hidden bg-black/5 dark:bg-white/10 flex items-center justify-center">
                                                <img src={r.url} alt="" className="w-full h-full object-contain" />
                                            </div>
                                            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                                                <input
                                                    className="ui-input"
                                                    style={err ? { borderColor: "var(--c-danger)" } : undefined}
                                                    value={r.name}
                                                    onChange={e => setRowName(r.id, e.target.value)}
                                                    onFocus={e => e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" })}
                                                    placeholder="表情名称"
                                                    autoComplete="off"
                                                />
                                                <span className="ts-11 ml-1" style={{ color: err ? "var(--c-danger)" : "var(--c-text)" }}>
                                                    {err || (r.source === "url" ? "URL图片" : "本地图片")}
                                                </span>
                                            </div>
                                            <button
                                                type="button"
                                                aria-label="移除"
                                                onClick={() => removeRow(r.id)}
                                                className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-[var(--c-danger)] bg-black/5 dark:bg-white/10"
                                            ><Trash2 size={14} /></button>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="ui-btn ui-btn-ghost" onClick={onCancel} disabled={adding}>取消</button>
                    <button
                        className="ui-btn ui-btn-primary"
                        onClick={handleSubmit}
                        disabled={!allValid || adding}
                    >
                        {adding ? `添加中 ${progress}%` : rows.length > 0 ? `全部添加 (${readyCount}/${rows.length})` : "全部添加"}
                    </button>
                </div>
            </div>
        </div>
    );
}
