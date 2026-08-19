"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, createContext, type CSSProperties, type ReactNode } from "react";
import { Activity, Check, ChevronRight, Clock, Database, FileText, Fingerprint, Globe, HardDrive, Image, Info, KeyRound, Laptop, Layers, Link2, Loader2, LogOut, MessageSquare, Mic, SlidersHorizontal, UserCircle, Wrench, X } from "lucide-react";
import { ConfirmDialog } from "./ui/modal";
import { useAccount } from "@/lib/account-context";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";
import { changeAccountPassword } from "@/lib/account-client";
import { ApiSettings } from "./settings/api-settings";
import { VoiceSettings } from "./settings/voice-settings";
import { ImageGenerationSettings } from "./settings/image-generation-settings";
import { PresetManager } from "./settings/preset-manager";
import { WorldBookManager } from "./settings/worldbook-manager";
import { RegexManager } from "./settings/regex-manager";
import { DataManagement } from "./settings/data-management";
import { UserIdentitySettings } from "./settings/user-identity";
import { AboutDeclaration } from "./settings/about-declaration";
import { BindingManager } from "./settings/binding-manager";
import { WeixinSettings } from "./settings/weixin-settings";
import { ToolboxSettings } from "./settings/toolbox-settings";
import { ModerationCenter } from "./settings/moderation-center";
import { AgentComputerSettings } from "./settings/agent-computer-settings";
import { fetchIsAdmin } from "@/lib/moderation-client";
import { PageShell } from "./ui/page-shell";
import { CardGrid, FeaturedCard, type CardItem, type FeaturedCardItem } from "./ui/card-grid";
import { Toggle } from "./ui/form";
import { loadChatAppSettings, saveChatAppSettings } from "@/lib/chat-storage";
import { loadKeepAlive, saveKeepAlive } from "@/lib/weixin-storage";
import { BINDING_ACCENTS, CONTENT_APP_ACCENTS } from "@/lib/ui-accent-colors";

export const SettingsContext = createContext<{
    setSubpageTitle: (title: string | null) => void;
    setOverrideBack: (action: (() => void) | null) => void;
    setSubpageRightAction: (page: string, action: ReactNode | null) => void;
}>({ setSubpageTitle: () => { }, setOverrideBack: () => { }, setSubpageRightAction: () => { } });

type SettingsPageProps = {
    onClose: () => void;
    onNotice: (msg: string) => void;
};

type SubPage =
    | "main"
    | "api"
    | "voice"
    | "imageGeneration"
    | "presets"
    | "worldbook"
    | "regex"
    | "data"
    | "binding"
    | "identity"
    | "weixin"
    | "toolbox"
    | "agentComputer"
    | "moderation"
    | "about";

const SETTINGS_MENU = [
    { id: "api", icon: HardDrive, label: "API 设置", desc: "大模型接口", iconColor: BINDING_ACCENTS.api },
    { id: "voice", icon: Mic, label: "语音 API", desc: "语音合成", iconColor: BINDING_ACCENTS.voice },
    { id: "imageGeneration", icon: Image, label: "图像生成 API", desc: "模型、参考图与提示词", iconColor: CONTENT_APP_ACCENTS.moments },
    { id: "presets", icon: Fingerprint, label: "预设", desc: "角色预设", iconColor: BINDING_ACCENTS.preset },
    { id: "worldbook", icon: Globe, label: "世界书", desc: "世界观设定", iconColor: BINDING_ACCENTS.worldBook },
    { id: "regex", icon: Database, label: "正则规则", desc: "文本替换", iconColor: BINDING_ACCENTS.regex },
    { id: "data", icon: Layers, label: "数据管理", desc: "导入导出", iconColor: BINDING_ACCENTS.api },
    { id: "binding", icon: Link2, label: "配置绑定", desc: "管理全局默认、角色与应用的配置绑定关系", iconColor: BINDING_ACCENTS.identity },
    { id: "weixin", icon: MessageSquare, label: "微信接入", desc: "iLink Bot", iconColor: CONTENT_APP_ACCENTS.chat },
    { id: "toolbox", icon: Wrench, label: "聊天工具箱", desc: "外部工具调用", iconColor: BINDING_ACCENTS.voice },
    { id: "agentComputer", icon: Laptop, label: "角色电脑", desc: "云端小电脑（自部署）", iconColor: BINDING_ACCENTS.memory },
    { id: "identity", icon: UserCircle, label: "用户身份", desc: "个人信息", iconColor: BINDING_ACCENTS.identity },
    { id: "about", icon: Info, label: "关于与声明", desc: "版本与协议", iconColor: BINDING_ACCENTS.memory },
] as const;

const realtimeIconStyle = {
    "--icon-color": CONTENT_APP_ACCENTS.calendar,
} as CSSProperties;

const keepAliveIconStyle = {
    "--icon-color": CONTENT_APP_ACCENTS.chat,
} as CSSProperties;

const promptViewerIconStyle = {
    "--icon-color": BINDING_ACCENTS.preset,
} as CSSProperties;

const quickActionIconStyle = {
    "--icon-color": BINDING_ACCENTS.worldBook,
} as CSSProperties;

const accountIconStyle = {
    "--icon-color": BINDING_ACCENTS.identity,
} as CSSProperties;

const passwordIconStyle = {
    "--icon-color": BINDING_ACCENTS.api,
} as CSSProperties;

const logoutIconStyle = {
    "--icon-color": "var(--c-danger)",
} as CSSProperties;

export function PhoneSettingsApp({ onClose, onNotice }: SettingsPageProps) {
    const [currentPage, setCurrentPage] = useState<SubPage>("main");
    const [subpageTitle, setSubpageTitle] = useState<string | null>(null);
    const [subpageRightActions, setSubpageRightActions] = useState<Record<string, ReactNode>>({});
    const [overrideBack, setOverrideBack] = useState<(() => void) | null>(null);
    const [timeAware, setTimeAware] = useState(true);
    const [promptViewerEnabled, setPromptViewerEnabled] = useState(false);
    const [quickActionEnabled, setQuickActionEnabled] = useState(false);
    const [keepAlive, setKeepAlive] = useState(false);
    // 角色电脑：施工中弹窗（返回 / 仍要看看）
    const pageBodyRef = useRef<HTMLDivElement | null>(null);

    // ── 账号：显示当前登录 / 修改密码 / 退出登录 ──
    const selfHostedMode = isSelfHostedModeEnabled();
    const { account, logout } = useAccount();
    const [pwdModalOpen, setPwdModalOpen] = useState(false);
    const [oldPwd, setOldPwd] = useState("");
    const [newPwd, setNewPwd] = useState("");
    const [confirmPwd, setConfirmPwd] = useState("");
    const [pwdBusy, setPwdBusy] = useState(false);
    const [pwdError, setPwdError] = useState("");
    const [confirmLogout, setConfirmLogout] = useState(false);
    const [accountSheetOpen, setAccountSheetOpen] = useState(false);

    // ── 管理中心入口：仅 role=admin 的账号可见 ──
    const [isAdmin, setIsAdmin] = useState(false);
    useEffect(() => {
        if (selfHostedMode || !account) return;
        let cancelled = false;
        void fetchIsAdmin().then(result => { if (!cancelled) setIsAdmin(result); });
        return () => { cancelled = true; };
    }, [selfHostedMode, account]);

    const closePwdModal = () => {
        if (pwdBusy) return;
        setPwdModalOpen(false);
        setOldPwd("");
        setNewPwd("");
        setConfirmPwd("");
        setPwdError("");
    };

    const handleChangePassword = async () => {
        if (pwdBusy) return;
        if (!oldPwd || !newPwd) { setPwdError("请填写当前密码和新密码。"); return; }
        if (newPwd.length < 6) { setPwdError("新密码至少需要 6 位。"); return; }
        if (newPwd !== confirmPwd) { setPwdError("两次输入的新密码不一致。"); return; }
        setPwdBusy(true);
        setPwdError("");
        try {
            const result = await changeAccountPassword({ oldPassword: oldPwd, newPassword: newPwd });
            if (!result.ok) { setPwdError(result.error || "修改失败。"); return; }
            setPwdModalOpen(false);
            setOldPwd("");
            setNewPwd("");
            setConfirmPwd("");
            onNotice("密码已修改");
        } finally {
            setPwdBusy(false);
        }
    };

    const handleCopyUsername = () => {
        if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(account.username).then(() => onNotice("用户名已复制"));
        } else {
            onNotice(`用户名：${account.username}`);
        }
    };

    const defaultTitle = currentPage === "main"
        ? "设置"
        : currentPage === "api" || currentPage === "voice" || currentPage === "imageGeneration" || currentPage === "presets" || currentPage === "worldbook" || currentPage === "regex" || currentPage === "identity"
            ? ""
            : currentPage === "moderation"
                ? "管理中心"
                : SETTINGS_MENU.find(m => m.id === currentPage)?.label || "设置";
    const title = subpageTitle || defaultTitle;

    const setSubpageRightAction = useCallback((page: string, action: ReactNode | null) => {
        setSubpageRightActions(prev => {
            if (action === null) {
                const next = { ...prev };
                delete next[page];
                return next;
            }
            return { ...prev, [page]: action };
        });
    }, []);

    const handleBack = () => {
        if (overrideBack) {
            overrideBack();
        } else if (currentPage !== "main") {
            setCurrentPage("main");
            setSubpageTitle(null);
            setOverrideBack(null);
        } else {
            onClose();
        }
    };

    const makeCardItem = (item: typeof SETTINGS_MENU[number]): CardItem => ({
        id: item.id,
        icon: item.icon,
        label: item.label,
        desc: item.desc,
        iconColor: item.iconColor,
        onClick: () => {
            // 施工中：角色电脑先弹提示，可选择仍要看看
            setCurrentPage(item.id as SubPage);
        },
    });

    const handleTimeAwareChange = useCallback((next: boolean) => {
        setTimeAware(next);
        saveChatAppSettings({ ...loadChatAppSettings(), timeAware: next });
        onNotice(next ? "已开启全局真实时间感知" : "已关闭全局真实时间感知");
    }, [onNotice]);

    const handlePromptViewerChange = useCallback((next: boolean) => {
        setPromptViewerEnabled(next);
        saveChatAppSettings({ ...loadChatAppSettings(), promptViewerEnabled: next });
        onNotice(next ? "已开启提示词查看器" : "已关闭提示词查看器");
    }, [onNotice]);

    const handleQuickActionChange = useCallback((next: boolean) => {
        setQuickActionEnabled(next);
        saveChatAppSettings({ ...loadChatAppSettings(), quickActionEnabled: next });
        onNotice(next ? "已开启快捷操作" : "已关闭快捷操作");
    }, [onNotice]);

    const handleKeepAliveChange = useCallback((next: boolean) => {
        setKeepAlive(next);
        saveKeepAlive(next);
        // use-weixin-bridge 监听这个事件来起停保活（与微信 Bot 的启用状态无关）
        window.dispatchEvent(new CustomEvent("weixin-config-changed"));
        onNotice(next ? "已开启后台保活" : "已关闭后台保活");
    }, [onNotice]);

    const imageGenerationItem = SETTINGS_MENU.find(i => i.id === "imageGeneration")!;
    const imageGenerationFeaturedItem: FeaturedCardItem = {
        id: imageGenerationItem.id,
        icon: imageGenerationItem.icon,
        label: imageGenerationItem.label,
        desc: imageGenerationItem.desc,
        iconColor: imageGenerationItem.iconColor,
        onClick: () => setCurrentPage("imageGeneration"),
    };

    const agentComputerItem = SETTINGS_MENU.find(i => i.id === "agentComputer")!;
    const agentComputerFeaturedItem: FeaturedCardItem = {
        id: agentComputerItem.id,
        icon: agentComputerItem.icon,
        label: agentComputerItem.label,
        desc: agentComputerItem.desc,
        iconColor: agentComputerItem.iconColor,
        onClick: () => setCurrentPage("agentComputer"),
    };

    const bindingItem = SETTINGS_MENU.find(i => i.id === "binding")!;
    const bindingFeaturedItem: FeaturedCardItem = {
        id: bindingItem.id,
        icon: bindingItem.icon,
        label: bindingItem.label,
        desc: bindingItem.desc,
        iconColor: bindingItem.iconColor,
        onClick: () => setCurrentPage("binding"),
    };

    const renderSubPage = () => {
        switch (currentPage) {
            case "api":
                return <ApiSettings />;
            case "voice":
                return <VoiceSettings />;
            case "imageGeneration":
                return <ImageGenerationSettings />;
            case "presets":
                return <PresetManager isActive />;
            case "worldbook":
                return <WorldBookManager isActive />;
            case "regex":
                return <RegexManager isActive />;
            case "data":
                return <DataManagement onNotice={onNotice} />;
            case "binding":
                return <BindingManager />;
            case "weixin":
                return <WeixinSettings onOpenDataManagement={() => setCurrentPage("data")} />;
            case "toolbox":
                return <ToolboxSettings />;
            case "agentComputer":
                return <AgentComputerSettings onNotice={onNotice} />;
            case "moderation":
                return <ModerationCenter onNotice={onNotice} />;
            case "identity":
                return <UserIdentitySettings />;
            case "about":
                return <AboutDeclaration />;
            default:
                return null;
        }
    };

    useLayoutEffect(() => {
        pageBodyRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }, [currentPage]);

    // Check for pending mascot navigation mode on mount (stored by desktop-shell)
    useEffect(() => {
        const pending = sessionStorage.getItem("mascot-settings-mode");
        if (pending) {
            sessionStorage.removeItem("mascot-settings-mode");
            if (SETTINGS_MENU.some(m => m.id === pending)) {
                setCurrentPage(pending as SubPage);
            }
        }
    }, []);

    useEffect(() => {
        const settings = loadChatAppSettings();
        setTimeAware(settings.timeAware !== false);
        setPromptViewerEnabled(settings.promptViewerEnabled === true);
        setQuickActionEnabled(settings.quickActionEnabled === true);
        setKeepAlive(loadKeepAlive());
    }, []);

    // Listen for mascot navigation mode (e.g. jump to worldbook/regex tab)
    useEffect(() => {
        const onMode = (e: Event) => {
            const { mode } = (e as CustomEvent).detail ?? {};
            if (mode && SETTINGS_MENU.some(m => m.id === mode)) {
                setCurrentPage(mode as SubPage);
            }
        };
        window.addEventListener("mascot-navigate-mode", onMode);
        return () => window.removeEventListener("mascot-navigate-mode", onMode);
    }, []);

    // Listen for internal settings tab navigation (e.g. mascot "修改绑定" button)
    useEffect(() => {
        const onNav = (e: Event) => {
            const { page } = (e as CustomEvent).detail ?? {};
            if (page) setCurrentPage(page as SubPage);
        };
        window.addEventListener("settings-navigate", onNav);
        return () => window.removeEventListener("settings-navigate", onNav);
    }, []);

    return (
        <SettingsContext.Provider value={{ setSubpageTitle, setOverrideBack, setSubpageRightAction }}>
            <PageShell title={title} onBack={handleBack} rightAction={currentPage !== "main" ? subpageRightActions[currentPage] : undefined} bodyRef={pageBodyRef}>
                {currentPage === "main" && (
                    <div className="page-menu settings-main-menu">
                        {!selfHostedMode && (
                            <button type="button" className="settings-account-card" onClick={() => setAccountSheetOpen(true)}>
                                <span className="settings-account-avatar">{account.username.slice(0, 1).toUpperCase()}</span>
                                <span className="settings-account-copy">
                                    <span className="settings-account-name">{account.displayName || account.username}</span>
                                    <span className="settings-account-sub">账号、密码与登录</span>
                                </span>
                                <ChevronRight size={18} className="settings-account-chevron" />
                            </button>
                        )}
                        <CardGrid
                            label="API Config"
                            labelClassName="settings-menu-section-title"
                            items={SETTINGS_MENU.filter(item => ["api", "voice"].includes(item.id)).map(makeCardItem)}
                        />
                        <div className="settings-data-rules-section">
                            <h3 className="settings-menu-section-title">Data & Rules</h3>
                            <div className="mt-[10px] flex flex-col gap-3">
                                <CardGrid
                                    items={SETTINGS_MENU.filter(item => ["presets", "worldbook", "regex", "data"].includes(item.id)).map(makeCardItem)}
                                />
                                <FeaturedCard item={bindingFeaturedItem} />
                            </div>
                        </div>
                        <div className="settings-image-generation-section">
                            <h3 className="settings-menu-section-title">Image Generation</h3>
                            <div className="mt-[10px]">
                                <FeaturedCard item={imageGenerationFeaturedItem} />
                            </div>
                        </div>
                        <div>
                            <CardGrid
                                label="Connections"
                                labelClassName="settings-menu-section-title"
                                items={SETTINGS_MENU.filter(item => ["weixin", "toolbox"].includes(item.id)).map(makeCardItem)}
                            />
                            <div className="mt-[10px]">
                                <FeaturedCard item={agentComputerFeaturedItem} />
                            </div>
                        </div>
                        <div className="settings-realtime-section">
                            <h3 className="settings-menu-section-title">Runtime</h3>
                            <div className="app-card card-featured settings-toggle-card">
                                <span className="card-icon" style={realtimeIconStyle}>
                                    <Clock size={22} strokeWidth={1.75} />
                                </span>
                                <div className="card-featured-body">
                                    <div className="card-featured-label">真实时间感知</div>
                                    <div className="card-featured-desc">控制全局历史事件流中是否注入时间戳</div>
                                </div>
                                <Toggle checked={timeAware} onChange={handleTimeAwareChange} className="settings-toggle-control" />
                            </div>
                            <div className="app-card card-featured settings-toggle-card">
                                <span className="card-icon" style={keepAliveIconStyle}>
                                    <Activity size={22} strokeWidth={1.75} />
                                </span>
                                <div className="card-featured-body">
                                    <div className="card-featured-label">后台保活</div>
                                    <div className="card-featured-desc">切到后台时尽量保持网页运行，主动消息与轮询不中断</div>
                                </div>
                                <Toggle checked={keepAlive} onChange={handleKeepAliveChange} className="settings-toggle-control" />
                            </div>
                        </div>
                        {isAdmin ? (
                            <div className="settings-moderation-section">
                                <h3 className="settings-menu-section-title">Moderation</h3>
                                <div className="app-card card-featured settings-toggle-card" role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => setCurrentPage("moderation")}>
                                    <span className="card-icon" style={accountIconStyle}>
                                        <SlidersHorizontal size={22} strokeWidth={1.75} />
                                    </span>
                                    <div className="card-featured-body">
                                        <div className="card-featured-label">管理中心</div>
                                        <div className="card-featured-desc">举报队列、应用审核与用户封禁</div>
                                    </div>
                                    <ChevronRight size={18} className="settings-account-chevron" />
                                </div>
                            </div>
                        ) : null}
                        <div className="settings-tools-section">
                            <h3 className="settings-menu-section-title">Tools</h3>
                            <div className="menu-group settings-tools-menu">
                                <div className="menu-item settings-tools-menu-item">
                                    <span className="card-icon" style={promptViewerIconStyle}>
                                        <FileText size={22} strokeWidth={1.75} />
                                    </span>
                                    <span className="settings-tools-menu-copy">
                                        <span className="menu-label appearance-menu-item-label">提示词查看器</span>
                                        <span className="menu-desc settings-tools-menu-desc">开启后显示悬浮按钮，可查看当前提示词</span>
                                    </span>
                                    <span className="menu-right settings-tools-menu-toggle">
                                        <Toggle checked={promptViewerEnabled} onChange={handlePromptViewerChange} className="settings-toggle-control" />
                                    </span>
                                </div>
                                <div className="menu-item settings-tools-menu-item">
                                    <span className="card-icon" style={quickActionIconStyle}>
                                        <SlidersHorizontal size={22} strokeWidth={1.75} />
                                    </span>
                                    <span className="settings-tools-menu-copy">
                                        <span className="menu-label appearance-menu-item-label">快捷操作</span>
                                        <span className="menu-desc settings-tools-menu-desc">快速切换 API 与世界书</span>
                                    </span>
                                    <span className="menu-right settings-tools-menu-toggle">
                                        <Toggle checked={quickActionEnabled} onChange={handleQuickActionChange} className="settings-toggle-control" />
                                    </span>
                                </div>
                            </div>
                        </div>
                        <CardGrid
                            label="User"
                            labelClassName="settings-menu-section-title"
                            items={SETTINGS_MENU.filter(item => ["identity", "about"].includes(item.id)).map(makeCardItem)}
                        />
                        {accountSheetOpen && (
                            <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setAccountSheetOpen(false)}>
                                <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                    <div className="modal-header" data-ui="modal-header">
                                        <button className="modal-header-btn modal-header-btn-muted" onClick={() => setAccountSheetOpen(false)}><X size={18} /></button>
                                        <h3 className="modal-title">账号</h3>
                                        <span style={{ width: 44 }} />
                                    </div>
                                    <div className="modal-body modal-body-tight" data-ui="modal-body">
                                        <div className="menu-group">
                                            <div className="menu-item settings-tools-menu-item">
                                                <span className="card-icon" style={accountIconStyle}>
                                                    <UserCircle size={22} strokeWidth={1.75} />
                                                </span>
                                                <span className="settings-tools-menu-copy">
                                                    <span className="menu-label appearance-menu-item-label">当前账号</span>
                                                    <span className="menu-desc settings-tools-menu-desc">@{account.username}</span>
                                                </span>
                                                <span className="menu-right">
                                                    <button className="ui-btn ui-btn-outline py-1 px-3 ts-12" style={{ whiteSpace: "nowrap" }} onClick={handleCopyUsername}>复制</button>
                                                </span>
                                            </div>
                                            <button type="button" className="menu-item settings-tools-menu-item w-full text-left" onClick={() => { setAccountSheetOpen(false); setPwdModalOpen(true); }}>
                                                <span className="card-icon" style={passwordIconStyle}>
                                                    <KeyRound size={22} strokeWidth={1.75} />
                                                </span>
                                                <span className="settings-tools-menu-copy">
                                                    <span className="menu-label appearance-menu-item-label">修改密码</span>
                                                    <span className="menu-desc settings-tools-menu-desc">需验证当前密码</span>
                                                </span>
                                                <span className="menu-right"><ChevronRight size={17} className="settings-account-chevron" /></span>
                                            </button>
                                            <button type="button" className="menu-item settings-tools-menu-item w-full text-left" onClick={() => { setAccountSheetOpen(false); setConfirmLogout(true); }}>
                                                <span className="card-icon" style={logoutIconStyle}>
                                                    <LogOut size={22} strokeWidth={1.75} />
                                                </span>
                                                <span className="settings-tools-menu-copy">
                                                    <span className="menu-label appearance-menu-item-label" style={{ color: "var(--c-danger)" }}>退出登录</span>
                                                    <span className="menu-desc settings-tools-menu-desc">退出后需重新输入用户名和密码</span>
                                                </span>
                                                <span className="menu-right"><ChevronRight size={17} className="settings-account-chevron" /></span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {pwdModalOpen && (
                            <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={closePwdModal}>
                                <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                    <div className="modal-header" data-ui="modal-header">
                                        <button className="modal-header-btn modal-header-btn-muted" onClick={closePwdModal} disabled={pwdBusy}><X size={18} /></button>
                                        <h3 className="modal-title">修改密码</h3>
                                        <button className="modal-header-btn modal-header-btn-action" onClick={() => void handleChangePassword()} disabled={pwdBusy}>
                                            {pwdBusy ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
                                        </button>
                                    </div>
                                    <div className="modal-body" data-ui="modal-body">
                                        <div className="flex flex-col gap-3 px-1">
                                            <input type="password" className="ui-input" placeholder="当前密码" autoComplete="current-password"
                                                value={oldPwd} onChange={event => setOldPwd(event.target.value)} />
                                            <input type="password" className="ui-input" placeholder="新密码（至少 6 位）" autoComplete="new-password"
                                                value={newPwd} onChange={event => setNewPwd(event.target.value)} />
                                            <input type="password" className="ui-input" placeholder="确认新密码" autoComplete="new-password"
                                                value={confirmPwd} onChange={event => setConfirmPwd(event.target.value)} />
                                            {pwdError ? <p className="ts-12" style={{ color: "var(--c-danger)" }}>{pwdError}</p> : null}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {confirmLogout && (
                            <ConfirmDialog
                                title="退出登录"
                                message={`当前账号 @${account.username}。退出后需要重新输入用户名和密码才能登录，密码无法找回，请确认已牢记。`}
                                icon={LogOut}
                                variant="danger"
                                confirmLabel="退出登录"
                                onConfirm={() => { setConfirmLogout(false); void logout(); }}
                                onCancel={() => setConfirmLogout(false)}
                            />
                        )}
                    </div>
                )}

                {currentPage !== "main" && (
                    // shrink-0：page-body 是 flex 容器，包裹层默认可压缩——内容超一屏时会被压到
                    // 恰好一屏高、卡片从中溢出，底部 padding 落不到内容末尾，最后一张卡贴死滚动边界
                    //（iOS 底部工具栏/安全区一盖就"没放下又滚不动"）。尾部留白 = 原 pb-8 + 安全区。
                    <div className="block min-h-full shrink-0 p-4 box-border" style={{ paddingBottom: "calc(32px + env(safe-area-inset-bottom, 0px))" }}>
                        {renderSubPage()}
                    </div>
                )}
            </PageShell>
        </SettingsContext.Provider>
    );
}
