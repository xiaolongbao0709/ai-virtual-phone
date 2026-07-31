"use client";

// 聊天插件管理页：安装（粘贴/选文件）/ 启停 / 设置 / 卸载 / 错误日志 / 安全模式。
// 入口：聊天设置 →「扩展插件」。UI 使用 app 统一的 page-menu / menu-group / menu-item 设计语言。
// 方案 B（无沙箱直接执行）：安装非官方来源插件前给一次明确的风险确认。

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, FileText, Puzzle, ScrollText, Settings2, Download } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { Toggle } from "@/components/ui/form";
import type { ChatPluginSettingField, InstalledChatPlugin } from "@/lib/chat-plugin-types";
import {
    CHAT_PLUGINS_CHANGED_EVENT,
    CHAT_PLUGIN_ERROR_EVENT,
    clearChatPluginErrors,
    loadChatPluginErrors,
    loadChatPlugins,
    setChatPluginEnabled,
    uninstallChatPlugin,
    updateChatPluginSettings,
} from "@/lib/chat-plugin-storage";
import { installChatPluginFromCode } from "@/lib/chat-plugin-loader";
import { getChatPluginRuntime, isChatPluginSafeMode, setChatPluginSafeMode } from "@/lib/chat-plugin-runtime";
import { ChatPluginSlot } from "@/components/chat/chat-plugin-slot";
import { CHAT_PLUGIN_FULL_DOC } from "@/lib/chat-plugin-docs";

const INSTALL_WARNING = "插件将与应用本身拥有相同的能力（包括访问你的 API 配置与全部聊天数据）。只安装你信任来源的插件。确认安装吗？";

function iconWrap(color: string) {
    return { background: `color-mix(in srgb, ${color} 15%, transparent)`, color } as const;
}

export function ChatPluginManager({ onBack }: { onBack: () => void }) {
    const [plugins, setPlugins] = useState<InstalledChatPlugin[]>(() => loadChatPlugins());
    const [errors, setErrors] = useState(() => loadChatPluginErrors());
    const [safeMode, setSafeMode] = useState(() => isChatPluginSafeMode());
    const [showGuide, setShowGuide] = useState(false);
    const [showErrors, setShowErrors] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [updateHint, setUpdateHint] = useState<{ id: string; ok: boolean; text: string } | null>(null);
    const [updating, setUpdating] = useState(false);
    /** 隐藏文件选择框当前服务的目标："import"（导入面板）或某个插件 id（更新） */
    const fileTargetRef = useRef<string>("import");
    const [settingsOpenId, setSettingsOpenId] = useState<string | null>(null);
    const [docCopied, setDocCopied] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [runtimeState, setRuntimeState] = useState<{ started: boolean; activeIds: string[] }>({ started: false, activeIds: [] });

    useEffect(() => {
        const sync = () => {
            const runtime = getChatPluginRuntime();
            setRuntimeState({ started: runtime.isStarted(), activeIds: runtime.activePluginIds() });
        };
        sync();
        const timer = window.setInterval(sync, 1000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        const refresh = () => setPlugins(loadChatPlugins());
        const refreshErrors = () => setErrors(loadChatPluginErrors());
        window.addEventListener(CHAT_PLUGINS_CHANGED_EVENT, refresh);
        window.addEventListener(CHAT_PLUGIN_ERROR_EVENT, refreshErrors);
        return () => {
            window.removeEventListener(CHAT_PLUGINS_CHANGED_EVENT, refresh);
            window.removeEventListener(CHAT_PLUGIN_ERROR_EVENT, refreshErrors);
        };
    }, []);

    const handleCopyDoc = async () => {
        try {
            await navigator.clipboard.writeText(CHAT_PLUGIN_FULL_DOC);
            setDocCopied(true);
            setTimeout(() => setDocCopied(false), 2000);
        } catch {
            setDocCopied(false);
        }
    };

    const handleInstall = async (code: string) => {
        if (!window.confirm(INSTALL_WARNING)) return;
        setInstalling(true);
        try {
            const result = await installChatPluginFromCode(code);
            if (result.ok) {
                const vers = result.upgraded && result.fromVersion && result.toVersion && result.fromVersion !== result.toVersion
                    ? ` v${result.fromVersion} → v${result.toVersion}`
                    : "";
                setHint({
                    ok: true,
                    text: result.upgraded
                        ? `已升级「${result.name}」${vers}，配置与数据已保留`
                        : `已安装「${result.name}」`,
                });
            } else {
                setHint({ ok: false, text: result.error || "安装失败" });
            }
        } finally {
            setInstalling(false);
        }
    };

    const handlePickFile = (target: string = "import") => {
        fileTargetRef.current = target;
        fileInputRef.current?.click();
    };

    const handleFileChosen = async (file: File | undefined) => {
        if (!file) return;
        const text = await file.text();
        if (fileTargetRef.current === "import") await handleInstall(text);
        else await handleUpdate(fileTargetRef.current, text);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    /** 就地更新：同 id 覆盖安装（配置与数据保留），并校验源码 id 与本插件一致 */
    const handleUpdate = async (id: string, code: string) => {
        if (!code.trim()) return;
        if (!window.confirm(INSTALL_WARNING)) return;
        setUpdating(true);
        try {
            const result = await installChatPluginFromCode(code, { expectedId: id });
            if (result.ok) {
                const vers = result.fromVersion && result.toVersion && result.fromVersion !== result.toVersion
                    ? ` v${result.fromVersion} → v${result.toVersion}`
                    : "";
                setUpdateHint({ id, ok: true, text: `已更新${vers}，配置与数据已保留` });
                window.setTimeout(() => setUpdateHint(cur => (cur?.id === id && cur.ok ? null : cur)), 5000);
            } else {
                setUpdateHint({ id, ok: false, text: result.error || "更新失败" });
            }
        } finally {
            setUpdating(false);
        }
    };

    const handleDelete = (id: string) => {
        if (confirmDeleteId !== id) {
            setConfirmDeleteId(id);
            return;
        }
        uninstallChatPlugin(id);
        setConfirmDeleteId(null);
    };

    const pluginErrors = (pluginId: string) => errors.filter(e => e.pluginId === pluginId && e.level === "error").length;
    const statusText = safeMode
        ? "安全模式 · 插件全部未加载"
        : runtimeState.started
            ? `运行时已启动 · ${runtimeState.activeIds.length} 个插件运行中`
            : "运行时启动中…";
    const statusColor = safeMode ? "#f59e0b" : runtimeState.started ? "var(--c-success)" : "var(--c-icon)";

    return (
        <PageShell title="扩展插件" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu" style={{ paddingBottom: 40 }}>

                {/* 安全模式 */}
                {safeMode && (
                    <div className="menu-group">
                        <div className="menu-item" style={{ cursor: "default" }}>
                            <div className="menu-icon" style={iconWrap("#f59e0b")}>
                                <AlertTriangle size={17} strokeWidth={1.8} />
                            </div>
                            <div className="menu-label-group">
                                <span className="menu-label">安全模式已开启</span>
                                <span className="menu-desc">所有插件已跳过加载。先禁用有问题的插件，再退出安全模式。</span>
                            </div>
                        </div>
                        <button
                            className="menu-item"
                            onClick={() => { setChatPluginSafeMode(false); setSafeMode(false); setHint({ ok: true, text: "已退出安全模式，刷新页面后插件恢复加载" }); }}
                        >
                            <div className="menu-label-group"><span className="menu-label" style={{ color: "#f59e0b" }}>退出安全模式（刷新后生效）</span></div>
                            <div className="menu-right"><ChevronRight size={16} /></div>
                        </button>
                    </div>
                )}

                {/* 已安装插件 */}
                <div>
                    <div className="settings-menu-section-title">已安装插件</div>
                    <span className="menu-desc" style={{ margin: "6px 8px 12px", display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor, flex: "0 0 auto" }} />
                        {statusText}
                    </span>

                    {plugins.length === 0 ? (
                        <div className="menu-group">
                            <div className="ui-empty">
                                <Puzzle size={30} strokeWidth={1.2} />
                                <div>
                                    <div style={{ color: "var(--c-text-title)" }}>还没有安装插件</div>
                                    <div style={{ marginTop: 4, opacity: 0.8 }}>插件可以拦截聊天管线、注入提示词、自由渲染界面——玩法由你创造</div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            {plugins.map(p => {
                                const errorCount = pluginErrors(p.manifest.id);
                                const hasSettings = (p.manifest.settings?.length ?? 0) > 0;
                                const settingsOpen = settingsOpenId === p.manifest.id;
                                const running = p.enabled && !safeMode && runtimeState.activeIds.includes(p.manifest.id);
                                const notRunning = p.enabled && !safeMode && !running;
                                return (
                                    <div className="menu-group" key={p.manifest.id}>
                                        {/* 头部 */}
                                        <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                                            <div className="menu-icon" style={iconWrap("#8b5cf6")}>
                                                <Puzzle size={17} strokeWidth={1.6} />
                                            </div>
                                            <div className="menu-label-group">
                                                <span className="menu-label" style={{ fontWeight: 600 }}>
                                                    {p.manifest.name}
                                                    {p.manifest.version && <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>v{p.manifest.version}</span>}
                                                    {p.manifest.author && <span style={{ opacity: 0.5, fontWeight: 400, marginLeft: 6 }}>{p.manifest.author}</span>}
                                                    {notRunning && <span style={{ color: "var(--c-danger)", fontWeight: 400, marginLeft: 6 }}>未运行</span>}
                                                </span>
                                                {p.manifest.description && <span className="menu-desc">{p.manifest.description}</span>}
                                                {!!p.manifest.permissions?.length && <span className="menu-desc" style={{ opacity: 0.6 }}>声明用途：{p.manifest.permissions.join("、")}</span>}
                                            </div>
                                            <div className="menu-right" style={{ gap: 8 }}>
                                                {hasSettings && (
                                                    <button
                                                        className="ui-btn ui-btn-ghost"
                                                        style={{ padding: 6 }}
                                                        onClick={() => setSettingsOpenId(settingsOpen ? null : p.manifest.id)}
                                                        aria-label="插件设置"
                                                    >
                                                        <Settings2 size={17} strokeWidth={1.6} />
                                                    </button>
                                                )}
                                                <Toggle checked={p.enabled} onChange={(v: boolean) => setChatPluginEnabled(p.manifest.id, v)} />
                                            </div>
                                        </div>

                                        {/* 静态设置表单 */}
                                        {settingsOpen && hasSettings && (
                                            <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14, borderTop: "1px solid color-mix(in srgb, var(--c-card-border) 20%, transparent)" }}>
                                                {p.manifest.settings!.map(field => (
                                                    <PluginSettingRow
                                                        key={`${field.key}:${String(p.settings?.[field.key] ?? "")}`}
                                                        field={field}
                                                        value={p.settings?.[field.key]}
                                                        onChange={(value) => updateChatPluginSettings(p.manifest.id, { [field.key]: value })}
                                                    />
                                                ))}
                                            </div>
                                        )}

                                        {/* 插件自绘设置区（settings.section 坑位）——归属到本插件卡片 */}
                                        <ChatPluginSlot
                                            name="settings.section"
                                            pluginId={p.manifest.id}
                                            className="chat-plugin-settings-section"
                                        />

                                        {/* 更新/卸载的行内提示 */}
                                        {updateHint?.id === p.manifest.id && (
                                            <div style={{ padding: "10px 16px 0" }}>
                                                <span className="menu-desc" style={{ color: updateHint.ok ? "var(--c-success)" : "var(--c-danger)" }}>{updateHint.text}</span>
                                            </div>
                                        )}
                                        {confirmDeleteId === p.manifest.id && (
                                            <div style={{ padding: "10px 16px 0" }}>
                                                <span className="menu-desc" style={{ color: "var(--c-danger)" }}>卸载将清除该插件的配置与数据；只是升级请点「更新」，配置会保留</span>
                                            </div>
                                        )}

                                        {/* 底部：更新 + 卸载，双按钮撑满一排。更新 = 直接选新版 .js 文件 */}
                                        <div style={{ display: "flex", gap: 10, padding: "12px 16px 14px" }}>
                                            <button
                                                className="ui-btn ui-btn-outline"
                                                style={{ flex: 1, minHeight: 40, fontWeight: 600 }}
                                                disabled={updating}
                                                onClick={() => {
                                                    setConfirmDeleteId(null);
                                                    setUpdateHint(null);
                                                    handlePickFile(p.manifest.id);
                                                }}
                                            >
                                                {updating ? "更新中…" : "更新"}
                                            </button>
                                            <button
                                                className={`ui-btn ${confirmDeleteId === p.manifest.id ? "ui-btn-danger" : "ui-btn-outline"}`}
                                                style={{ flex: 1, minHeight: 40, fontWeight: 600, ...(confirmDeleteId === p.manifest.id ? {} : { color: "var(--c-danger)", borderColor: "color-mix(in srgb, var(--c-danger) 45%, transparent)" }) }}
                                                onClick={() => handleDelete(p.manifest.id)}
                                                onBlur={() => setConfirmDeleteId(null)}
                                            >
                                                {confirmDeleteId === p.manifest.id ? "确认卸载" : "卸载"}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* 安装 */}
                <div>
                    <div className="settings-menu-section-title">安装插件</div>
                    <div className="menu-group" style={{ marginTop: 10 }}>
                        <button className="menu-item" disabled={installing} onClick={() => { setHint(null); handlePickFile(); }}>
                            <div className="menu-icon" style={iconWrap("#38bdf8")}>
                                <Download size={17} strokeWidth={1.6} />
                            </div>
                            <div className="menu-label-group"><span className="menu-label">{installing ? "安装中…" : "导入插件"}</span><span className="menu-desc">选择 .js 插件文件</span></div>
                            <div className="menu-right"><ChevronRight size={16} /></div>
                        </button>
                        {hint && (
                            <div style={{ padding: "10px 16px 0" }}>
                                <span className="menu-desc" style={{ color: hint.ok ? "var(--c-success)" : "var(--c-danger)" }}>{hint.text}</span>
                            </div>
                        )}
                        <input ref={fileInputRef} type="file" accept=".js,.mjs,text/javascript" className="hidden" onChange={e => { void handleFileChosen(e.target.files?.[0]); }} />
                    </div>
                </div>

                {/* 运行日志 */}
                <div>
                    <div className="settings-menu-section-title">运行日志</div>
                    <div className="menu-group" style={{ marginTop: 10 }}>
                        <button className="menu-item" onClick={() => setShowErrors(v => !v)}>
                            <div className="menu-icon" style={iconWrap("#94a3b8")}>
                                <ScrollText size={17} strokeWidth={1.6} />
                            </div>
                            <div className="menu-label-group"><span className="menu-label">运行日志</span></div>
                            <div className="menu-right">
                                {errors.length > 0 && <span className="menu-desc mr-1">{errors.length} 条</span>}
                                {showErrors ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </div>
                        </button>
                        {showErrors && (
                            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                                {errors.length === 0 ? (
                                    <span className="menu-desc">暂无日志</span>
                                ) : (
                                    <>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 256, overflowY: "auto" }}>
                                            {[...errors].reverse().map((e, i) => (
                                                <div key={i} style={{ fontSize: 11, lineHeight: 1.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: e.level === "error" ? "var(--c-danger)" : "var(--c-text)", opacity: e.level === "error" ? 1 : 0.65 }}>
                                                    <span style={{ opacity: 0.6 }}>{e.at.slice(5, 19).replace("T", " ")}</span>
                                                    {" "}[{e.pluginId}] {e.where}: {e.message}
                                                </div>
                                            ))}
                                        </div>
                                        <button className="ui-btn ui-btn-ghost" style={{ alignSelf: "flex-start", padding: "6px 12px" }} onClick={() => clearChatPluginErrors()}>清空日志</button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* 制作说明 */}
                <div>
                    <div className="settings-menu-section-title">制作说明</div>
                    <div className="menu-group" style={{ marginTop: 10 }}>
                        <button className="menu-item" onClick={() => setShowGuide(v => !v)}>
                            <div className="menu-icon" style={iconWrap("#f472b6")}>
                                <FileText size={17} strokeWidth={1.6} />
                            </div>
                            <div className="menu-label-group"><span className="menu-label">开发文档</span><span className="menu-desc">复制给 AI 代写插件</span></div>
                            <div className="menu-right">{showGuide ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</div>
                        </button>
                        {showGuide && (
                            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                                <p className="menu-desc" style={{ lineHeight: 1.6 }}>
                                    不会写代码？把下面这份完整文档发给任意 AI，描述你想要的玩法，让它生成插件代码回来安装。
                                    同 id 重复安装视为升级覆盖（保留设置）；插件报错自动记入运行日志，连续失败 5 次自动禁用。
                                </p>
                                <textarea
                                    className="ui-textarea"
                                    value={CHAT_PLUGIN_FULL_DOC}
                                    rows={18}
                                    readOnly
                                    spellCheck={false}
                                    aria-label="插件开发文档全文"
                                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, lineHeight: 1.55 }}
                                />
                                <button className="ui-btn ui-btn-primary" onClick={handleCopyDoc}>{docCopied ? "已复制 ✓" : "复制全文"}</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </PageShell>
    );
}

function PluginSettingRow({ field, value, onChange }: {
    field: ChatPluginSettingField;
    value: unknown;
    onChange: (value: string | number | boolean) => void;
}) {
    const current = value !== undefined ? value : field.default;
    if (field.type === "boolean") {
        return (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div className="menu-label-group">
                    <span className="menu-label">{field.label}</span>
                    {field.description && <span className="menu-desc">{field.description}</span>}
                </div>
                <Toggle checked={current === true} onChange={(v: boolean) => onChange(v)} />
            </div>
        );
    }
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="menu-label">{field.label}</span>
            {field.description && <span className="menu-desc">{field.description}</span>}
            {field.type === "text" && (
                <input className="ui-input" type="text" defaultValue={typeof current === "string" ? current : ""} onBlur={e => onChange(e.target.value)} />
            )}
            {field.type === "number" && (
                <input className="ui-input" type="number" style={{ width: 140 }} defaultValue={typeof current === "number" ? current : 0} onBlur={e => onChange(Number(e.target.value) || 0)} />
            )}
            {field.type === "select" && (
                <select className="ui-select" value={typeof current === "string" ? current : ""} onChange={e => onChange(e.target.value)}>
                    {(field.options ?? []).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                </select>
            )}
        </div>
    );
}
