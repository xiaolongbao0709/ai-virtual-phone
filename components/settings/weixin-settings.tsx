"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, Wifi, WifiOff, AlertCircle, MessageSquare, Loader2, RefreshCw, Cloud, CloudUpload, ChevronDown, PlayCircle } from "lucide-react";
import QRCode from "qrcode";
import {
    loadWeixinBots,
    addExclusiveWeixinBot,
    updateWeixinBot,
    removeWeixinBot,
    type WeixinBotConfig,
} from "@/lib/weixin-storage";
import {
    isWeixinCloudSupabaseReady,
    fetchWeixinCloudAssistantHeartbeat,
    setWeixinCloudAssistantScheduled,
    loadWeixinCloudSyncConfig,
    syncAllWeixinBotRuntimesToCloud,
    syncWeixinBotRuntimeToCloud,
    testWeixinCloudAssistantOnce,
    type WeixinCloudAssistantHeartbeat,
    type WeixinCloudSyncConfig,
} from "@/lib/weixin-cloud-sync";
import { getWeixinBotStatus } from "@/lib/use-weixin-bridge";
import { getWeixinCloudDeployedAt, loadWeixinCloudScheduled, saveWeixinCloudScheduled } from "@/lib/cloud-deploy-status";
import { getLoginQrCode, pollQrCodeStatus, type QrLoginStatus } from "@/lib/weixin-bridge";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { Toggle, Select } from "@/components/ui/form";
import { ConfirmDialog, ContentDialog } from "@/components/ui/modal";
import { Alert } from "@/components/ui/feedback";

type AddStep = "select-character" | "scanning" | "done";

function formatCloudSyncBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCloudSyncTime(value?: string): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function WeixinSettings({ onOpenCloudServices }: { onOpenCloudServices?: () => void } = {}) {
    const [bots, setBots] = useState<WeixinBotConfig[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [statusTick, setStatusTick] = useState(0);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [cloudSyncConfig, setCloudSyncConfig] = useState<WeixinCloudSyncConfig>(loadWeixinCloudSyncConfig);
    const [cloudSyncingId, setCloudSyncingId] = useState<string | null>(null);
    const [cloudSyncNotice, setCloudSyncNotice] = useState<{ ok: boolean; text: string } | null>(null);
    const [cloudScheduledOn, setCloudScheduledOn] = useState(() => loadWeixinCloudScheduled());
    const [cloudAssistantBusy, setCloudAssistantBusy] = useState<string | null>(null);
    const [showCloudAssistantNotes, setShowCloudAssistantNotes] = useState(false);
    const [cloudAssistantNotice, setCloudAssistantNotice] = useState<{ ok: boolean; text: string } | null>(null);
    const [cloudHeartbeat, setCloudHeartbeat] = useState<WeixinCloudAssistantHeartbeat | null>(null);
    const [cloudHeartbeatCheckedAt, setCloudHeartbeatCheckedAt] = useState<string | null>(null);

    // 添加流程
    const [addStep, setAddStep] = useState<AddStep | null>(null);
    const [newCharacterId, setNewCharacterId] = useState("");
    const [addError, setAddError] = useState("");

    // QR 码状态
    const [qrImgUrl, setQrImgUrl] = useState("");
    const [qrStatus, setQrStatus] = useState<QrLoginStatus | "loading">("loading");
    const qrAbort = useRef<AbortController | null>(null);

    useEffect(() => {
        setBots(loadWeixinBots());
        setCharacters(loadCharacters());
        setCloudSyncConfig(loadWeixinCloudSyncConfig());
    }, []);

    useEffect(() => {
        const refresh = () => {
            setBots(loadWeixinBots());
            setStatusTick(t => t + 1);
        };
        window.addEventListener("weixin-status-changed", refresh);
        window.addEventListener("weixin-config-changed", refresh);
        return () => {
            window.removeEventListener("weixin-status-changed", refresh);
            window.removeEventListener("weixin-config-changed", refresh);
        };
    }, []);

    // 清理 QR 轮询
    useEffect(() => {
        return () => { qrAbort.current?.abort(); };
    }, []);

    const notifyChange = () => {
        window.dispatchEvent(new CustomEvent("weixin-config-changed"));
    };

    const handleSyncRuntime = async (botId: string) => {
        if (cloudSyncingId) return;
        setCloudSyncNotice(null);
        setCloudSyncingId(botId);
        try {
            const result = await syncWeixinBotRuntimeToCloud(botId);
            setCloudSyncConfig(loadWeixinCloudSyncConfig());
            setCloudSyncNotice({
                ok: true,
                text: `已同步「${result.snapshot.character.name}」运行包：${result.snapshot.stats.messageCount} 条消息，${formatCloudSyncBytes(result.bytes)}。`,
            });
        } catch (err) {
            setCloudSyncNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
            setCloudSyncingId(null);
        }
    };

    const refreshCloudHeartbeat = async () => {
        const heartbeat = await fetchWeixinCloudAssistantHeartbeat();
        setCloudHeartbeat(heartbeat);
        setCloudHeartbeatCheckedAt(new Date().toISOString());
        return heartbeat;
    };

    const handleTestCloudAssistant = async () => {
        if (cloudAssistantBusy) return;
        setCloudAssistantNotice(null);
        setCloudAssistantBusy("test");
        try {
            const result = await testWeixinCloudAssistantOnce();
            await refreshCloudHeartbeat().catch(() => null);
            setCloudAssistantNotice({
                ok: true,
                text: result.error
                    ? `云函数已运行，但轮询报错：${result.error}`
                    : "云端测试成功！云函数已正常轮询微信消息。定时 SQL 执行后即可 24 小时自动回复。",
            });
        } catch (err) {
            setCloudAssistantNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
            setCloudAssistantBusy(null);
        }
    };

    const handleSetCloudSchedule = async (enabled: boolean) => {
        if (cloudAssistantBusy) return;
        setCloudAssistantNotice(null);
        setCloudAssistantBusy(enabled ? "enable" : "disable");
        try {
            if (enabled) {
                const results = await syncAllWeixinBotRuntimesToCloud();
                if (results.length === 0) {
                    setCloudAssistantNotice({ ok: false, text: "没有可同步的已启用微信 Bot，请先添加并启用微信 Bot。" });
                    return;
                }
                setCloudSyncConfig(loadWeixinCloudSyncConfig());
            }
            await setWeixinCloudAssistantScheduled(enabled);
            saveWeixinCloudScheduled(enabled);
            setCloudScheduledOn(enabled);
            setCloudAssistantNotice({
                ok: true,
                text: enabled
                    ? "云端轮询已开启，每 10 秒一次。刚开启时微信恢复在线可能需要几分钟，之后回复稳定在 10～60 秒。"
                    : "云端轮询已停用，不再消耗任何配额，随时可再打开，无需重新部署。",
            });
        } catch (err) {
            setCloudAssistantNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
            setCloudAssistantBusy(null);
        }
    };

    const handleRefreshCloudHeartbeat = async () => {
        if (cloudAssistantBusy) return;
        setCloudAssistantNotice(null);
        setCloudAssistantBusy("heartbeat");
        try {
            const heartbeat = await refreshCloudHeartbeat();
            if (!heartbeat) {
                setCloudAssistantNotice({ ok: false, text: "还没有读到云端心跳。请确认云函数已部署、定时 SQL 已执行，稍等半分钟再刷新。" });
            }
        } catch (err) {
            setCloudAssistantNotice({ ok: false, text: err instanceof Error ? err.message : String(err) });
        } finally {
            setCloudAssistantBusy(null);
        }
    };

    const handleToggle = (id: string, enabled: boolean) => {
        updateWeixinBot(id, { enabled });
        setBots(loadWeixinBots());
        notifyChange();
    };

    const handleDelete = (id: string) => {
        removeWeixinBot(id);
        setBots(loadWeixinBots());
        notifyChange();
    };

    const cancelAdd = () => {
        qrAbort.current?.abort();
        setAddStep(null);
        setNewCharacterId("");
        setAddError("");
        setQrImgUrl("");
        setQrStatus("loading");
    };

    // 将 qrcode_img_content 转为可显示的 data URL
    const resolveQrImage = async (raw: string): Promise<string> => {
        // 已经是 data URI
        if (raw.startsWith("data:")) return raw;
        // 是 base64 图片数据（无前缀）
        if (!raw.startsWith("http") && raw.length > 100) return `data:image/png;base64,${raw}`;
        // 是 URL：需要生成二维码图片（用户用微信扫这个 URL）
        return QRCode.toDataURL(raw, { width: 280, margin: 2 });
    };

    // 开始扫码流程
    const startQrLogin = async () => {
        setAddError("");
        if (!newCharacterId) { setAddError("请选择角色"); return; }

        setAddStep("scanning");
        setQrStatus("loading");

        try {
            const qr = await getLoginQrCode();
            if (!qr.qrcode || !qr.qrcode_img_content) {
                throw new Error("获取二维码失败");
            }
            const imgUrl = await resolveQrImage(qr.qrcode_img_content);
            setQrImgUrl(imgUrl);
            setQrStatus("wait");

            // 开始轮询扫码状态
            qrAbort.current?.abort();
            const ctrl = new AbortController();
            qrAbort.current = ctrl;

            while (!ctrl.signal.aborted) {
                await new Promise(r => setTimeout(r, 2000));
                if (ctrl.signal.aborted) break;

                try {
                    const status = await pollQrCodeStatus(qr.qrcode);
                    setQrStatus(status.status);

                    if (status.status === "confirmed" && status.bot_token) {
                        // 登录成功！保存 bot 配置
                        const char = characters.find(c => c.id === newCharacterId);
                        addExclusiveWeixinBot({
                            characterId: newCharacterId,
                            botToken: status.bot_token,
                            enabled: true,
                            nickname: char?.name,
                        });
                        setBots(loadWeixinBots());
                        notifyChange();
                        setAddStep("done");
                        return;
                    }

                    if (status.status === "expired") {
                        setAddError("二维码已过期，请重试");
                        setAddStep("select-character");
                        return;
                    }
                } catch {
                    // 单次轮询失败，继续
                }
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setAddError(`登录失败: ${msg}`);
            setAddStep("select-character");
        }
    };

    const statusDot = (id: string) => {
        void statusTick;
        const s = getWeixinBotStatus(id);
        if (s.status === "running") return <Wifi size={14} className="text-green-500" />;
        if (s.status === "error") return <AlertCircle size={14} className="text-red-500" />;
        return <WifiOff size={14} className="text-[var(--c-text-muted)]" />;
    };

    const statusLabel = (id: string) => {
        void statusTick;
        const bot = bots.find(item => item.id === id);
        if (cloudSyncConfig.enabled && bot?.enabled) return "本地助手同步：小手机负责同步消息，本地电脑负责自动回复";
        const s = getWeixinBotStatus(id);
        if (s.status === "running") return "运行中";
        if (s.status === "error") return s.message ?? "错误";
        return "已停止";
    };

    const boundCharacterIds = new Set(bots.map(b => b.characterId));
    const availableCharacters = characters.filter(
        c => !boundCharacterIds.has(c.id) || c.id === newCharacterId
    );
    const cloudSupabaseReady = isWeixinCloudSupabaseReady();
    const weixinCloudDeployed = Boolean(getWeixinCloudDeployedAt()) || Boolean(cloudHeartbeat?.lastRunAt);

    const qrStatusText: Record<string, string> = {
        loading: "正在获取二维码…",
        wait: "请用微信扫描二维码",
        scaned: "已扫描，请在微信上确认登录",
        confirmed: "登录成功！",
        expired: "二维码已过期",
    };

    return (
        <div className="flex flex-col gap-[24px] h-full">
            <div className="flex justify-between items-center gap-3">
                <p className="settings-menu-section-title">WeChat Bots</p>
                {!addStep && (
                    <button
                        className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[18px] bg-black px-3 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                        onClick={() => { setAddStep("select-character"); setAddError(""); }}
                    >
                        <Plus size={14} strokeWidth={1.8} />
                        添加微信 Bot
                    </button>
                )}
            </div>

            {cloudSyncNotice && (
                <Alert variant={cloudSyncNotice.ok ? "success" : "danger"}>{cloudSyncNotice.text}</Alert>
            )}

            {/* 微信云端助手 */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-start gap-3">
                    <div className="ui-icon-circle shrink-0"><Cloud size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1">
                        <span className="menu-label font-medium">微信云端助手</span>
                        <span className="menu-desc !mt-0">
                            部署到你自己的 Supabase，无需电脑常开，云端每 10 秒自动回复。
                        </span>
                    </div>
                </div>

                <div className="flex flex-col gap-3 mt-4">
                    <div className="flex items-center gap-3">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${weixinCloudDeployed ? "bg-green-500" : "bg-black/20"}`} />
                        <span className="menu-label flex-1">{weixinCloudDeployed ? "已部署" : "未部署"}</span>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline shrink-0 whitespace-nowrap !gap-1.5 !px-3 !text-[12px]"
                            onClick={() => onOpenCloudServices?.()}
                        >
                            <CloudUpload size={14} /> {weixinCloudDeployed ? "重新部署" : "去部署"}
                        </button>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="flex-1 flex flex-col">
                            <span className="menu-label">云端轮询</span>
                            <span className="menu-desc !mt-0">开着才会自动回复；关掉零配额消耗</span>
                        </div>
                        {cloudAssistantBusy === "enable" || cloudAssistantBusy === "disable"
                            ? <Loader2 size={18} className="animate-spin shrink-0" />
                            : (
                                <Toggle
                                    checked={cloudScheduledOn}
                                    onChange={v => void handleSetCloudSchedule(v)}
                                    disabled={!cloudSupabaseReady || Boolean(cloudAssistantBusy)}
                                />
                            )}
                    </div>

                    <button
                        type="button"
                        className="ui-btn ui-btn-outline w-full justify-center"
                        disabled={!cloudSupabaseReady || Boolean(cloudAssistantBusy)}
                        onClick={() => void handleTestCloudAssistant()}
                    >
                        {cloudAssistantBusy === "test"
                            ? <><Loader2 size={15} className="animate-spin" /> 测试中…</>
                            : <><PlayCircle size={15} /> 云端测试一次</>}
                    </button>

                    {/* 云端心跳状态行 */}
                    <div className="flex items-center gap-2">
                        <span
                            className={`h-2 w-2 shrink-0 rounded-full ${
                                cloudHeartbeat?.lastError
                                    ? "bg-red-500"
                                    : cloudHeartbeat?.lastRunAt && Date.now() - new Date(cloudHeartbeat.lastRunAt).getTime() < 60_000
                                        ? "bg-green-500"
                                        : "bg-black/20"
                            }`}
                        />
                        <span className="menu-desc !mt-0 flex-1">
                            {cloudHeartbeat?.lastRunAt
                                ? `云端最近轮询：${formatCloudSyncTime(cloudHeartbeat.lastRunAt)}${cloudHeartbeat.lastError ? `（错误：${cloudHeartbeat.lastError}）` : ""}`
                                : cloudHeartbeatCheckedAt
                                    ? "未读到云端心跳"
                                    : "云端心跳：尚未检查"}
                        </span>
                        <button
                            type="button"
                            className="ui-link-btn shrink-0"
                            data-variant="muted"
                            disabled={!cloudSupabaseReady || Boolean(cloudAssistantBusy)}
                            onClick={() => void handleRefreshCloudHeartbeat()}
                            title="刷新云端心跳"
                        >
                            {cloudAssistantBusy === "heartbeat" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        </button>
                    </div>

                    {cloudAssistantNotice && (
                        <Alert variant={cloudAssistantNotice.ok ? "success" : "danger"}>{cloudAssistantNotice.text}</Alert>
                    )}

                    <button
                        type="button"
                        className="flex h-11 w-full items-center justify-between rounded-[14px] border border-black/10 bg-black/[0.035] px-3 text-left text-[13px] font-semibold text-[var(--c-text)] transition-colors hover:bg-black/[0.055] active:scale-[0.99] focus:outline-none"
                        onClick={() => setShowCloudAssistantNotes(v => !v)}
                        aria-expanded={showCloudAssistantNotes}
                    >
                        <span>{showCloudAssistantNotes ? "收起使用说明" : "展开使用说明"}</span>
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/80 shadow-sm">
                            <ChevronDown
                                size={17}
                                className={`transition-transform ${showCloudAssistantNotes ? "rotate-180" : ""}`}
                            />
                        </span>
                    </button>
                    {showCloudAssistantNotes && (
                        <div className="flex flex-col gap-2 rounded-[18px] bg-black/[0.03] p-3">
                            <span className="menu-desc !mt-0">· 冷启动：刚部署或停用较久后重新开启时，微信侧要几分钟才把 Bot 恢复为在线，期间回复慢、可能显示「暂无法连接」；停用期间收到的消息不会补发。让定时任务一直跑着就不会再遇到。</span>
                            <span className="menu-desc !mt-0">· 与本地助手共用同一套逻辑和防重复锁，可同时开启互为备份。</span>
                            <span className="menu-desc !mt-0">· 对方发来的图片：在 API 设置开启「图像识别」后角色可以看到并回应（遵循聊天信息页的传入图片数），图片也会同步回小手机显示；语音和文件暂以文字占位提示。</span>
                            <span className="menu-desc !mt-0">· 角色发出的媒体：支持生图照片（遵循小手机「图像生成」设置）、表情包与语音（遵循语音配置），与本地助手一致。</span>
                            <span className="menu-desc !mt-0">· 微信 token 过期后仍需回到小手机重新扫码。</span>
                            <span className="menu-desc !mt-0">· 角色、API、预设等变更后，记得重新同步运行包。</span>
                            <span className="menu-desc !mt-0">· 停用：关掉上方「云端轮询」开关即可，停用后零配额消耗。</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Bot 列表 */}
            {bots.length > 0 && (
                <div className="flex flex-col gap-2">
                    {bots.map(bot => {
                        const char = characters.find(c => c.id === bot.characterId);
                        const status = getWeixinBotStatus(bot.id);
                        return (
                            <div key={bot.id} className="ui-group-card !flex-row !items-center">
                                <div className="flex-1 flex flex-col gap-1">
                                    <div className="flex items-center gap-[6px]">
                                        {statusDot(bot.id)}
                                        <span className="menu-label">{char?.name ?? bot.nickname ?? bot.characterId}</span>
                                    </div>
                                    <span className={`menu-desc !mt-0 ${status.status === "running" ? "text-green-500" : status.status === "error" ? "text-red-500" : ""}`}>
                                        {statusLabel(bot.id)}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 shrink-0">
                                    <button
                                        className="ui-link-btn"
                                        data-variant="muted"
                                        onClick={() => void handleSyncRuntime(bot.id)}
                                        disabled={!cloudSupabaseReady || Boolean(cloudSyncingId)}
                                        title="同步本地助手运行包"
                                    >
                                        {cloudSyncingId === bot.id ? <Loader2 size={14} className="animate-spin" /> : <CloudUpload size={14} />}
                                    </button>
                                    <button className="ui-link-btn" data-variant="muted" onClick={() => setConfirmDeleteId(bot.id)}>
                                        <Trash2 size={14} />
                                    </button>
                                    <Toggle checked={bot.enabled} onChange={v => handleToggle(bot.id, v)} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 空状态 */}
            {bots.length === 0 && !addStep && (
                <div className="ui-empty mt-2">
                    <div className="ui-icon-circle"><MessageSquare size={24} /></div>
                    <span className="menu-label font-semibold">暂无微信 Bot</span>
                    <span className="menu-desc max-w-[240px]">通过 iLink 协议让 AI 角色以真实微信号回复消息。</span>
                    <button className="ui-btn ui-btn-primary" onClick={() => { setAddStep("select-character"); setAddError(""); }}>
                        <Plus size={16} /> 添加 Bot
                    </button>
                </div>
            )}

            {/* 添加弹窗 */}
            {addStep && (
                <ContentDialog
                    title={addStep === "done" ? "添加成功" : "添加微信 Bot"}
                    confirmLabel={addStep === "select-character" ? "扫码登录" : addStep === "done" ? "完成" : ""}
                    cancelLabel={addStep === "done" ? "" : "取消"}
                    onConfirm={() => {
                        if (addStep === "select-character") startQrLogin();
                        else cancelAdd();
                    }}
                    onCancel={cancelAdd}
                >
                    {addStep === "select-character" && (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">选择角色</label>
                                <Select value={newCharacterId} onChange={e => setNewCharacterId(e.target.value)}>
                                    <option value="">请选择…</option>
                                    {availableCharacters.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
                                </Select>
                            </div>
                            {addError && <Alert variant="danger">{addError}</Alert>}
                        </div>
                    )}
                    {addStep === "scanning" && (
                        <div className="flex flex-col items-center gap-3">
                            <span className="menu-label font-semibold">{characters.find(c => c.id === newCharacterId)?.name}</span>
                            <div className="w-48 h-48 rounded-lg bg-white flex items-center justify-center overflow-hidden">
                                {qrImgUrl ? (
                                    <img src={qrImgUrl} alt="微信登录二维码" className="w-full h-full object-contain" />
                                ) : (
                                    <Loader2 size={28} className="animate-spin opacity-30" />
                                )}
                            </div>
                            <span className={`menu-desc !mt-0 ${qrStatus === "scaned" ? "text-amber-500 font-medium" : ""}`}>
                                {qrStatusText[qrStatus] ?? "等待中…"}
                            </span>
                            {qrStatus === "expired" && (
                                <button className="ui-btn flex items-center gap-1" onClick={startQrLogin}>
                                    <RefreshCw size={12} /> 刷新二维码
                                </button>
                            )}
                        </div>
                    )}
                    {addStep === "done" && (
                        <div className="flex flex-col items-center gap-2">
                            <span className="menu-label font-semibold text-green-500">登录成功！</span>
                            <span className="menu-desc">{characters.find(c => c.id === newCharacterId)?.name} 的微信 Bot 已启用</span>
                        </div>
                    )}
                </ContentDialog>
            )}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除此 Bot 配置？聊天记录不会删除。"
                    confirmLabel="确认删除"
                    icon={AlertCircle}
                    variant="danger"
                    onConfirm={() => { handleDelete(confirmDeleteId); setConfirmDeleteId(null); }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
