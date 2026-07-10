"use client";

import { useState, useEffect, useCallback } from "react";
import { Upload, Plus, Trash2, Download, FileJson, ImageIcon, UserRound, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { GlassCard, EmptyState } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/modal";
import {
  loadCharacters,
  saveCharacters,
  createCharacter,
  exportCharacterAsJson,
  exportCharacterAsPng,
  parseCharacterFromJson,
  parseCharacterFromAnyPng,
  isSillyTavernCharacterCard,
  CHAR_BLOCKED_FIELDS,
  type CharacterImportData,
} from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

export default function CharacterPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: number; failed: number; blocked: string[] } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Character | null>(null);

  const refresh = useCallback(() => {
    setCharacters(loadCharacters());
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleFileSelect = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".png,.json";
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;

      setImporting(true);
      setImportResult(null);

      let success = 0;
      let failed = 0;
      const blocked: string[] = [];

      for (let i = 0; i < files.length; i++) {
        try {
          const buffer = await files[i].arrayBuffer();
          const isPng = files[i].type === "image/png" || files[i].name.toLowerCase().endsWith(".png");
          const isJson = files[i].type === "application/json" || files[i].name.toLowerCase().endsWith(".json");

          let importData: CharacterImportData | null = null;
          if (isPng) {
            importData = parseCharacterFromAnyPng(buffer);
          } else if (isJson) {
            const text = new TextDecoder().decode(buffer);
            importData = parseCharacterFromJson(text);
          }

          if (importData) {
            const existing = loadCharacters();
            const newChar = createCharacter(importData);
            saveCharacters([...existing, newChar]);
            success++;
          } else {
            failed++;
            console.error("Import failed for:", files[i].name);
          }
        } catch (e) {
          if (e instanceof Error && e.message === CHAR_BLOCKED_FIELDS) {
            blocked.push(files[i].name);
          } else {
            console.error("Import error for", files[i].name, ":", e);
            failed++;
          }
        }
      }

      setImportResult({ success, failed, blocked: blocked.length > 0 ? blocked : [] });
      setImporting(false);
      refresh();
    };
    input.click();
  };

  const handleDelete = (char: Character) => {
    setDeleteTarget(char);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const updated = characters.filter((c) => c.id !== deleteTarget.id);
    saveCharacters(updated);
    refresh();
    setDeleteTarget(null);
  };

  const formatImportMessage = () => {
    if (!importResult) return "";
    const parts: string[] = [];
    if (importResult.success > 0) parts.push(`成功导入 ${importResult.success} 个角色`);
    if (importResult.failed > 0) parts.push(`${importResult.failed} 个文件导入失败（格式不支持或数据损坏）`);
    if (importResult.blocked.length > 0) parts.push(`${importResult.blocked.length} 个文件因包含不受支持的字段被阻止`);
    return parts.join("，");
  };

  return (
    <PageShell
      title="角色中心"
      rightAction={
        <Button variant="primary" onClick={handleFileSelect} disabled={importing}>
          {importing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          <span style={{ marginLeft: 6 }}>导入角色卡</span>
        </Button>
      }
    >
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Import result feedback */}
        {importResult && (importResult.success > 0 || importResult.failed > 0 || importResult.blocked.length > 0) && (
          <Alert variant={importResult.success > 0 && importResult.failed === 0 && importResult.blocked.length === 0 ? "success" : "warning"}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {importResult.success > 0 ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
              <span>{formatImportMessage()}</span>
            </div>
            {importResult.blocked.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                {importResult.blocked.map((name, i) => <div key={i}>- {name}</div>)}
              </div>
            )}
          </Alert>
        )}

        {/* Supported formats info */}
        <GlassCard variant="section">
          <div style={{ padding: 12, fontSize: 13, opacity: 0.8 }}>
            <strong>支持导入的格式：</strong>
            <ul style={{ margin: "8px 0 0 16px", lineHeight: 1.8 }}>
              <li>float 原生 PNG/JSON 角色卡</li>
              <li>SillyTavern 酒馆角色卡（.png）</li>
              <li>RisuAI / 其他 V2 兼容角色卡（.png）</li>
            </ul>
          </div>
        </GlassCard>

        {/* Character list */}
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
            <Loader2 size={32} className="animate-spin" />
          </div>
        ) : characters.length === 0 ? (
          <EmptyState
            icon={UserRound}
            message="还没有角色，点击右上角导入角色卡"
            action={
              <Button variant="primary" onClick={handleFileSelect}>
                <Upload size={16} style={{ marginRight: 6 }} />导入角色卡
              </Button>
            }
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {characters.map((char) => (
              <GlassCard key={char.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
                  {/* Avatar */}
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: "50%",
                      overflow: "hidden",
                      flexShrink: 0,
                      background: "#7a6080",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: 20,
                      fontWeight: "bold",
                    }}
                  >
                    {char.avatar ? (
                      <img src={char.avatar} alt={char.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      char.name.charAt(0) || "?"
                    )}
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{char.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>
                      微信: {char.wechatID || "未设置"}
                      {char.tags && char.tags.length > 0 && " · " + char.tags.join(", ")}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="ui-icon-btn"
                      onClick={() => exportCharacterAsJson(char)}
                      title="导出 JSON"
                    >
                      <FileJson size={18} />
                    </button>
                    <button
                      type="button"
                      className="ui-icon-btn"
                      onClick={() => exportCharacterAsPng(char)}
                      title="导出 PNG 角色卡"
                    >
                      <ImageIcon size={18} />
                    </button>
                    <button
                      type="button"
                      className="ui-icon-btn"
                      onClick={() => handleDelete(char)}
                      title="删除角色"
                      style={{ color: "var(--danger)" }}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <ConfirmDialog
          title="删除角色"
          confirmLabel="删除"
          confirmVariant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        >
          确定要删除角色 <strong>{deleteTarget.name}</strong> 吗？此操作无法撤销。
        </ConfirmDialog>
      )}
    </PageShell>
  );
}
