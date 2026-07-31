"use client";
import { useState, useEffect, useRef } from "react";
import { getSchemes, saveScheme, deleteScheme, type CSSScheme } from "@/lib/css-scheme-storage";
import { Save, FolderOpen, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { CSSImportButton } from "@/components/ui/css-import-button";

/** Semantic color tokens for the modal — pass CSS var() references so they follow the active theme */
type ModalVars = {
  panel?: string;       // modal background
  border?: string;      // borders & dividers
  text?: string;        // primary text
  textDim?: string;     // secondary / placeholder text
  input?: string;       // input background
  inputBorder?: string; // input border
  accent?: string;      // action button
};

const defaults: Required<ModalVars> = {
  panel: "var(--c-panel, #fff)",
  border: "var(--c-card-border, #eee)",
  text: "var(--c-text-title, #1a1a1a)",
  textDim: "var(--c-icon, #999)",
  input: "var(--c-input, #f7f7f7)",
  inputBorder: "var(--c-input-border, #ddd)",
  accent: "var(--c-icon-active, #07c160)",
};

type Props = {
  target: string;
  onLoad: (css: string) => void;
  currentCSS: string;
  btnStyle?: React.CSSProperties;
  modalVars?: ModalVars;
};

const defaultBtn: React.CSSProperties = {
  width: 36, height: 36, borderRadius: 8,
  border: "1px solid var(--c-input-border, #ddd)",
  background: "var(--c-input, #f7f7f7)",
  color: "var(--c-icon, #999)",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  cursor: "pointer", flexShrink: 0, padding: 0,
};

export default function CSSSchemeBar({ target, onLoad, currentCSS, btnStyle, modalVars }: Props) {
  const v = { ...defaults, ...modalVars };
  const [schemes, setSchemes] = useState<CSSScheme[]>([]);
  const [modal, setModal] = useState<"save" | "load" | null>(null);
  const [saveName, setSaveName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => { setSchemes(getSchemes(target)); }, [target]);
  useEffect(() => { if (modal === "save") setTimeout(() => inputRef.current?.focus(), 50); }, [modal]);
  useEffect(() => {
    setPortalTarget(document.querySelector<HTMLElement>(".phone-shell"));
  }, []);

  const btn = { ...defaultBtn, ...btnStyle };

  const handleSave = () => {
    if (!saveName.trim()) return;
    const s = saveScheme(target, saveName.trim(), currentCSS);
    setSchemes(prev => [...prev, s]);
    setSaveName("");
    setModal(null);
  };

  const handleLoad = (s: CSSScheme) => {
    onLoad(s.css);
    setModal(null);
  };

  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const handleDelete = (id: string) => {
    deleteScheme(id);
    setSchemes(prev => prev.filter(x => x.id !== id));
    setConfirmingId(null);
  };

  return (
    <>
      <button
        onClick={() => { setModal("save"); setSaveName(""); }}
        disabled={!currentCSS.trim()}
        title="保存方案"
        style={{ ...btn, opacity: currentCSS.trim() ? 1 : 0.4 }}
      >
        <Save size={15} />
      </button>
      <button
        onClick={() => { setSchemes(getSchemes(target)); setModal("load"); }}
        title="加载方案"
        style={btn}
      >
        <FolderOpen size={15} />
      </button>
      <CSSImportButton onImport={onLoad} buttonStyle={btn} />

      {modal && portalTarget ? createPortal(
        <div
          onClick={() => setModal(null)}
          style={{
            position: "absolute", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 300,
              background: v.panel, borderRadius: 14,
              boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "14px 16px 10px",
              borderBottom: `1px solid ${v.border}`,
            }}>
              <span style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 600, color: v.text }}>
                {modal === "save" ? "保存方案" : "加载方案"}
              </span>
              <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: v.textDim, cursor: "pointer" }}>
                <X size={18} />
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: 16 }}>
              {modal === "save" ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    ref={inputRef}
                    value={saveName}
                    onChange={e => setSaveName(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSave()}
                    placeholder="输入方案名称"
                    style={{
                      flex: 1, minWidth: 0, height: 36, borderRadius: 8, paddingLeft: 10,
                      border: `1px solid ${v.inputBorder}`,
                      background: v.input, color: v.text,
                      fontSize: "calc(14px*var(--app-text-scale,1))", outline: "none",
                    }}
                  />
                  <button
                    onClick={handleSave}
                    disabled={!saveName.trim()}
                    style={{
                      height: 36, padding: "0 16px", borderRadius: 8, border: "none",
                      background: v.accent, color: "#fff",
                      fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                      opacity: saveName.trim() ? 1 : 0.4,
                    }}
                  >
                    保存
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
                  {schemes.length === 0 ? (
                    <div style={{ textAlign: "center", color: v.textDim, fontSize: "calc(13px*var(--app-text-scale,1))", padding: "20px 0" }}>
                      暂无保存的方案
                    </div>
                  ) : schemes.map(s => (
                    <div key={s.id} style={{ display: "flex", flexDirection: "column", flexShrink: 0, borderRadius: 10, border: `1px solid ${v.border}`, background: v.input, overflow: "hidden" }}>
                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          minHeight: 48,
                          padding: "8px 10px 8px 12px",
                          cursor: "pointer",
                        }}
                        onClick={() => confirmingId === s.id ? null : handleLoad(s)}
                      >
                        <span style={{ flex: 1, fontSize: "calc(14px*var(--app-text-scale,1))", color: v.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.name}
                        </span>
                        <button
                          aria-label={`删除方案 ${s.name}`}
                          title="删除方案"
                          onClick={e => { e.stopPropagation(); setConfirmingId(confirmingId === s.id ? null : s.id); }}
                          style={{
                            width: 36, height: 36, borderRadius: 8, border: "none",
                            background: "transparent", color: "var(--c-danger, #fa5151)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            cursor: "pointer", flexShrink: 0,
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {confirmingId === s.id && (
                        <div style={{ display: "flex", flexShrink: 0, borderTop: `1px solid ${v.border}` }}>
                          <button
                            onClick={e => { e.stopPropagation(); setConfirmingId(null); }}
                            style={{ flex: 1, minHeight: 36, padding: "8px 0", background: "transparent", border: "none", color: v.textDim, fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", borderRight: `1px solid ${v.border}` }}
                          >
                            取消
                          </button>
                          <button
                            onClick={e => { e.stopPropagation(); handleDelete(s.id); }}
                            style={{ flex: 1, minHeight: 36, padding: "8px 0", background: "transparent", border: "none", color: "var(--c-danger, #fa5151)", fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer" }}
                          >
                            确定删除
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>,
        portalTarget
      ) : null}
    </>
  );
}
