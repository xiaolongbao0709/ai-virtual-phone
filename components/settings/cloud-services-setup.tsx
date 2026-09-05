"use client";

// 云服务统一部署（三合一）：备份桶 / 微信接入 / 离线推送在此一站配置。
// 交互：中央黑色按钮直达 Supabase 令牌页 → 粘贴 Access Token 点确认 →
// 弹窗选择 Supabase 组织与部署范围 → 自动创建专用项目并完成：
// 取回项目地址与 service_role key（写入原云备份配置存储）、
// 建桶、部署微信/推送云函数并自动执行定时任务 SQL。
// Token 与取回的 key 经站点代理透传，不存储不记录。

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Check, CloudUpload, ExternalLink, Loader2, MessageSquare, Satellite } from "lucide-react";
import {
    isCloudBackupConfigured,
    loadCloudBackupConfig,
    normalizeBackupUrl,
    saveCloudBackupConfig,
} from "@/lib/cloud-backup/config";
import { testCloudBackupConnection } from "@/lib/cloud-backup/storage-client";
import {
    buildWeixinCloudAssistantCronSql,
    deployWeixinCloudFunction,
    ensureWeixinCloudCronSecret,
    probeWeixinCloudDeployed,
    syncAllWeixinBotRuntimesToCloud,
} from "@/lib/weixin-cloud-sync";
import { connectPersonalPushCloud, deployPersonalPushCloud, isPersonalPushCloudActive } from "@/lib/personal-push-cloud";
import { ensurePersonalPushSubscription, getOfflinePushState, markAccountPushSubscribed } from "@/lib/push-client";
import { getWeixinCloudDeployedAt, markWeixinCloudDeployed, savePushCloudScheduled, saveWeixinCloudScheduled } from "@/lib/cloud-deploy-status";
import { Input, Select } from "@/components/ui/form";

const SUPABASE_TOKENS_URL = "https://supabase.com/dashboard/account/tokens";

/** 设置页「云服务部署」独立条目的整页形态。 */
export function CloudServicesPage() {
    return (
        <div className="page-menu">
            <div className="menu-group" style={{ padding: "18px 16px" }}>
                <CloudServicesSetup />
            </div>
        </div>
    );
}

type OrganizationOption = { id: string; slug: string; name: string };

function smartRegionForCurrentTimeZone(): "americas" | "emea" | "apac" {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (/^(America|Atlantic)\//.test(zone)) return "americas";
    if (/^(Europe|Africa)\//.test(zone)) return "emea";
    return "apac";
}

function projectRefFromUrl(value: string): string {
    try {
        return new URL(normalizeBackupUrl(value)).hostname.split(".")[0] || "";
    } catch {
        return "";
    }
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function readableResponseDetail(raw: string): string {
    let parsed: unknown;
    try {
        parsed = raw ? JSON.parse(raw) : null;
    } catch {
        parsed = null;
    }

    const fromUnknown = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.map(fromUnknown).filter(Boolean).join("；");
        if (!value || typeof value !== "object") return "";
        const data = value as Record<string, unknown>;
        return ["error", "message", "detail", "details", "hint", "code"]
            .map(key => fromUnknown(data[key]))
            .filter(Boolean)
            .join("；");
    };

    return (fromUnknown(parsed) || raw)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\bsbp_[a-z0-9_-]{8,}\b/gi, "sbp_[已隐藏]")
        .replace(/\bsb_secret_[a-z0-9_-]{8,}\b/gi, "sb_secret_[已隐藏]")
        .replace(/\beyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, "[JWT 已隐藏]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600);
}

async function callSupabaseAdmin<T>(payload: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
        res = await fetch("/api/supabase-admin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error([
            "无法连接本站的云服务部署接口，请检查当前网络后重试。",
            detail ? `浏览器原始提示：${detail}` : "浏览器没有返回更多错误信息。",
        ].join("\n"));
    }

    const raw = await res.text().catch(() => "");
    let data: (T & { ok?: boolean; error?: unknown }) | null = null;
    try {
        data = raw ? JSON.parse(raw) as T & { ok?: boolean; error?: unknown } : null;
    } catch {
        data = null;
    }
    if (!res.ok || data?.ok === false) {
        const detail = data && typeof data.error === "string"
            ? data.error
            : readableResponseDetail(raw);
        throw new Error(detail || [
            "云服务部署接口没有返回可识别的错误内容。",
            `本站接口状态：HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
        ].join("\n"));
    }
    if (!data) {
        throw new Error("云服务部署接口返回了空内容，请稍后重试。");
    }
    return data;
}

export function CloudServicesSetup({ onConfigChanged }: { onConfigChanged?: () => void }) {
    const [cloudReady, setCloudReady] = useState(false);
    const [pushActive, setPushActive] = useState(false);
    const [weixinDeployed, setWeixinDeployed] = useState(false);
    const [token, setToken] = useState("");
    const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
    const [selectedOrganizationSlug, setSelectedOrganizationSlug] = useState("");
    const [selectedRef, setSelectedRef] = useState("");
    const [scopeBackup, setScopeBackup] = useState(true);
    const [scopeWeixin, setScopeWeixin] = useState(true);
    const [scopePush, setScopePush] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [busy, setBusy] = useState<"organizations" | "deploy" | "connect" | null>(null);
    const [resultDialog, setResultDialog] = useState<{ title: string; text: string } | null>(null);
    const [progress, setProgress] = useState("");
    // 换设备重连：填部署时的项目地址 + service_role key，探测既有云服务并恢复本机状态
    const [connectOpen, setConnectOpen] = useState(false);
    const [connectUrl, setConnectUrl] = useState("");
    const [connectKey, setConnectKey] = useState("");

    useEffect(() => {
        setCloudReady(isCloudBackupConfigured(loadCloudBackupConfig()));
        setPushActive(isPersonalPushCloudActive());
        setWeixinDeployed(Boolean(getWeixinCloudDeployedAt()));
    }, []);

    const configuredUrl = normalizeBackupUrl(loadCloudBackupConfig().url);

    const refreshStatus = () => {
        setCloudReady(isCloudBackupConfigured(loadCloudBackupConfig()));
        setPushActive(isPersonalPushCloudActive());
        setWeixinDeployed(Boolean(getWeixinCloudDeployedAt()));
        onConfigChanged?.();
    };

    const openScopeDialog = async () => {
        if (busy) return;
        setResultDialog(null);
        setBusy("organizations");
        try {
            const config = loadCloudBackupConfig();
            const configuredRef = projectRefFromUrl(config.url);
            const managedRef = config.managedProjectRef === configuredRef ? configuredRef : "";
            if (managedRef) {
                // 本应用创建过的专用项目允许原地重新部署；旧版手填/误选项目没有标记，
                // 一律走新建流程，绝不把这次发布写回已有业务库。
                setSelectedRef(managedRef);
                setOrganizations([]);
                setSelectedOrganizationSlug(config.managedOrganizationSlug || "");
            } else {
                const data = await callSupabaseAdmin<{ organizations: OrganizationOption[] }>({ action: "organizations", token });
                if (data.organizations.length === 0) {
                    throw new Error([
                        "Supabase 已接受这个 Access Token，但在它可访问的范围内没有返回任何组织。",
                        token.trim().toLowerCase().startsWith("sbp_fc")
                            ? "这是细粒度 Token：请在 Supabase 令牌页把目标组织加入授权范围，并开启 Organizations 的读取权限。"
                            : "请确认当前 Supabase 账号已加入至少一个组织；如果刚创建 Token，可稍等片刻后再试。",
                    ].join("\n"));
                }
                setOrganizations(data.organizations);
                setSelectedOrganizationSlug(data.organizations.length === 1 ? data.organizations[0].slug : "");
                setSelectedRef("");
            }
            setScopeBackup(true);
            setScopeWeixin(true);
            setScopePush(true);
            setDialogOpen(true);
        } catch (err) {
            setResultDialog({ title: "Access Token 验证失败", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setBusy(null);
        }
    };

    const waitForProjectReady = async (projectRef: string): Promise<void> => {
        for (let attempt = 0; attempt < 90; attempt += 1) {
            const data = await callSupabaseAdmin<{ status: string }>({ action: "project_status", token, projectRef });
            if (data.status === "ACTIVE_HEALTHY") return;
            if (["INACTIVE", "REMOVED", "PAUSED"].includes(data.status)) {
                throw new Error(`新项目初始化停止（${data.status}），请到 Supabase Dashboard 查看。`);
            }
            await wait(2_000);
        }
        throw new Error("新项目仍在初始化。项目已经创建，请稍后再次点击部署继续。");
    };

    const waitForBackupStorageReady = async (): Promise<void> => {
        let lastError = "Storage 尚未就绪";
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const bucket = await testCloudBackupConnection(loadCloudBackupConfig());
            if (bucket.ok) return;
            lastError = bucket.error || lastError;
            // 新项目可能先报告 ACTIVE_HEALTHY，Storage 的 tenant 配置稍后才就绪。
            // 只重试这个明确的初始化窗口；密钥/权限等真实错误立即反馈。
            if (!/TenantNotFound|Missing tenant config for tenant/i.test(lastError)) {
                throw new Error(`备份桶创建失败：${lastError}`);
            }
            await wait(2_000);
        }
        throw new Error(`备份桶创建失败：${lastError}。项目已创建，请稍后再次点击部署继续。`);
    };

    const runDeploy = async () => {
        if (busy || (!selectedRef && !selectedOrganizationSlug) || (!scopeBackup && !scopeWeixin && !scopePush)) return;
        setResultDialog(null);
        setBusy("deploy");
        const done: string[] = [];
        try {
            let projectRef = selectedRef;
            if (!projectRef) {
                setProgress("创建专用项目…");
                const created = await callSupabaseAdmin<{ projectRef: string }>({
                    action: "create_project",
                    token,
                    organizationSlug: selectedOrganizationSlug,
                    regionCode: smartRegionForCurrentTimeZone(),
                });
                projectRef = created.projectRef;
                setSelectedRef(projectRef);
                // 先记住已创建的项目，网络中断或初始化超时时可继续，不会再创建第二个。
                saveCloudBackupConfig({
                    ...loadCloudBackupConfig(),
                    url: `https://${projectRef}.supabase.co`,
                    key: "",
                    managedProjectRef: projectRef,
                    managedOrganizationSlug: selectedOrganizationSlug,
                });
            }

            setProgress("等待项目初始化…");
            await waitForProjectReady(projectRef);

            // 在建桶、微信函数和推送函数中的任何写入发生前做总闸检查。
            setProgress("确认独立项目…");
            await callSupabaseAdmin({ action: "assert_dedicated_project", token, projectRef });
            await callSupabaseAdmin({
                action: "run_sql",
                token,
                projectRef,
                sql: `create table if not exists public.ai_phone_cloud_meta (
                    id text primary key,
                    schema_version integer not null default 1,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now()
                );
                insert into public.ai_phone_cloud_meta (id, schema_version, updated_at)
                values ('personal-cloud', 3, now())
                on conflict (id) do update set schema_version = excluded.schema_version, updated_at = excluded.updated_at;`,
            });

            // 取回密钥，写入原云备份配置（保留自动备份等既有设置项）
            setProgress("取回项目密钥…");
            const keys = await callSupabaseAdmin<{ serviceRoleKey: string }>({ action: "api_keys", token, projectRef });
            saveCloudBackupConfig({
                ...loadCloudBackupConfig(),
                url: `https://${projectRef}.supabase.co`,
                key: keys.serviceRoleKey,
                managedProjectRef: projectRef,
                managedOrganizationSlug: selectedOrganizationSlug || loadCloudBackupConfig().managedOrganizationSlug,
            });

            if (scopeBackup) {
                setProgress("创建备份桶…");
                await waitForBackupStorageReady();
                done.push("云备份");
            }

            if (scopeWeixin) {
                setProgress("部署微信云函数…");
                // 部署不依赖 Bot：没有 Bot 时函数空转待命，建 Bot 后运行包自动同步。
                // 这里只是顺手把已有 Bot 的运行包传上去，失败不阻塞部署。
                await syncAllWeixinBotRuntimesToCloud().catch(() => []);
                const cronSecret = await ensureWeixinCloudCronSecret();
                await deployWeixinCloudFunction(token);
                setProgress("写入微信定时任务…");
                await callSupabaseAdmin({
                    action: "run_sql",
                    token,
                    projectRef,
                    sql: buildWeixinCloudAssistantCronSql(cronSecret),
                });
                markWeixinCloudDeployed();
                saveWeixinCloudScheduled(true);
                done.push("微信接入");
            }

            if (scopePush) {
                setProgress("部署离线推送…");
                const pushWasEnabled = await getOfflinePushState() === "on";
                await deployPersonalPushCloud(token);
                if (pushWasEnabled) {
                    const subscription = await ensurePersonalPushSubscription();
                    if (!subscription.ok) {
                        throw new Error(`离线推送已部署，但本设备订阅迁移失败：${subscription.error || "未知错误"}。请到推送设置里重新开启离线推送。`);
                    }
                } else {
                    markAccountPushSubscribed(false);
                }
                savePushCloudScheduled(true);
                done.push("离线推送");
            }

            setToken("");
            setDialogOpen(false);
            setResultDialog({ title: "部署完成", text: `${done.join("、")} 已就绪` });
        } catch (err) {
            setDialogOpen(false);
            setResultDialog({ title: "部署失败", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setProgress("");
            setBusy(null);
            refreshStatus();
        }
    };

    const openConnectDialog = () => {
        if (busy) return;
        const config = loadCloudBackupConfig();
        setConnectUrl(normalizeBackupUrl(config.url));
        setConnectKey(config.key || "");
        setConnectOpen(true);
    };

    /** 换设备重连：零 Access Token、零重新部署。逐项探测既有云服务并恢复本机状态。 */
    const runConnect = async () => {
        if (busy) return;
        setBusy("connect");
        const lines: string[] = [];
        try {
            // ① 云备份：测通即写入配置（保留自动备份等既有设置项）
            setProgress("连接云备份…");
            const nextConfig = {
                ...loadCloudBackupConfig(),
                url: normalizeBackupUrl(connectUrl),
                key: connectKey.trim(),
            };
            const test = await testCloudBackupConnection(nextConfig);
            if (!test.ok) throw new Error(`云备份连接失败：${test.error}`);
            saveCloudBackupConfig(nextConfig);
            lines.push("云备份：已连接 ✓");

            // ② 离线推送：健康检查通过就地恢复状态，并迁移本设备的推送订阅
            setProgress("探测离线推送…");
            try {
                const push = await connectPersonalPushCloud();
                if (push.status === "connected") {
                    const pushWasEnabled = await getOfflinePushState() === "on";
                    if (pushWasEnabled) {
                        const subscription = await ensurePersonalPushSubscription();
                        if (!subscription.ok) {
                            lines.push(`离线推送：已连接 ✓（但本设备订阅注册失败：${subscription.error || "未知错误"}，请到推送设置里重新开启）`);
                        } else {
                            lines.push("离线推送：已连接 ✓");
                        }
                    } else {
                        markAccountPushSubscribed(false);
                        lines.push("离线推送：已连接 ✓（本设备推送未开启，需要时到推送设置里打开）");
                    }
                    if (push.note) lines.push(`　注意：${push.note}`);
                } else {
                    lines.push(`离线推送：未检测到部署${push.error ? `（${push.error}）` : ""}，如需使用请走上方部署流程`);
                }
            } catch (err) {
                lines.push(`离线推送：探测失败（${err instanceof Error ? err.message : String(err)}）`);
            }

            // ③ 微信接入：备份桶里有 cron 密钥即为部署过
            setProgress("探测微信接入…");
            try {
                if (await probeWeixinCloudDeployed()) {
                    markWeixinCloudDeployed();
                    saveWeixinCloudScheduled(true);
                    lines.push("微信接入：已连接 ✓");
                } else {
                    lines.push("微信接入：未检测到部署，如需使用请走上方部署流程");
                }
            } catch (err) {
                lines.push(`微信接入：探测失败（${err instanceof Error ? err.message : String(err)}）`);
            }

            setConnectOpen(false);
            setResultDialog({ title: "连接完成", text: lines.join("\n") });
        } catch (err) {
            setConnectOpen(false);
            setResultDialog({
                title: "连接失败",
                text: [err instanceof Error ? err.message : String(err), ...lines].join("\n"),
            });
        } finally {
            setProgress("");
            setBusy(null);
            refreshStatus();
        }
    };

    const scopeRow = (
        label: string,
        checked: boolean,
        onChange: (v: boolean) => void,
        deployed: boolean,
    ) => (
        <label className="flex items-center gap-3 rounded-[14px] bg-black/[0.03] px-3 py-2.5">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span className="menu-label flex-1">{label}</span>
            {deployed && <span className="text-[11px] font-semibold text-green-600">已部署</span>}
        </label>
    );

    const statusCard = (
        icon: ReactNode,
        label: string,
        deployed: boolean,
        deployedText: string,
    ) => (
        <div className="flex items-center gap-3 rounded-[16px] bg-black/[0.03] px-3.5 py-3">
            <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white shadow-sm"
                style={{ color: deployed ? "var(--c-success, #16a34a)" : "var(--c-text-sub, #999)" } as CSSProperties}
            >
                {icon}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="menu-label">{label}</span>
                <span className="menu-desc !mt-0 min-w-0 truncate">{deployed ? deployedText : "未部署"}</span>
            </div>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${deployed ? "bg-green-500" : "bg-black/15"}`} />
        </div>
    );

    return (
        <div className="flex flex-col gap-4">
            {/* 中央主按钮：直达令牌页 */}
            <div className="flex flex-col items-center justify-center gap-2 pt-1">
                <button
                    type="button"
                    className="inline-flex items-center justify-center gap-1.5 rounded-[20px] bg-black px-6 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                    onClick={() => window.open(SUPABASE_TOKENS_URL, "_blank", "noopener")}
                >
                    <ExternalLink size={15} strokeWidth={1.8} />
                    打开 Supabase 令牌页
                </button>
                <p className="text-center text-[calc(11px*var(--app-text-scale,1))] font-medium leading-relaxed text-gray-400">
                    生成 Access Token 后复制粘贴；只用一次，不保存<br />
                    sbp_fc… 细粒度 Token 需要授权目标组织及部署权限
                </p>
            </div>

            {/* token 输入 + 圆形确认钮 */}
            <div className="flex items-center gap-2">
                <Input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="sbp_… Access Token"
                    spellCheck={false}
                    className="flex-1 min-w-0"
                />
                <button
                    type="button"
                    aria-label="确认并选择 Supabase 组织与部署范围"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-white shadow-sm transition-all hover:bg-gray-800 active:scale-95 disabled:opacity-30 focus:outline-none"
                    onClick={() => void openScopeDialog()}
                    disabled={Boolean(busy) || !token.trim()}
                >
                    {busy === "organizations" ? <Loader2 size={17} className="animate-spin" /> : <Check size={18} strokeWidth={2.2} />}
                </button>
            </div>

            {/* 换设备重连：云端服务还活着，只是本机丢了连接标记——不需要重新部署 */}
            <button
                type="button"
                className="self-center text-[calc(12px*var(--app-text-scale,1))] font-semibold text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:opacity-40"
                onClick={openConnectDialog}
                disabled={Boolean(busy)}
            >
                已经部署过？换了设备只需重新连接 →
            </button>

            {/* 三项状态 */}
            <div className="flex flex-col gap-2">
                {statusCard(<CloudUpload size={17} strokeWidth={1.9} />, "云备份", cloudReady, `已部署 · ${configuredUrl.replace(/^https?:\/\//, "").replace(/\.supabase\.co$/, "")}`)}
                {statusCard(<MessageSquare size={17} strokeWidth={1.9} />, "微信接入", weixinDeployed, "云函数与定时任务已部署")}
                {statusCard(<Satellite size={17} strokeWidth={1.9} />, "离线推送", pushActive, "已部署到你的 Supabase")}
            </div>

            {/* 结果弹窗（成功/失败统一） */}
            {resultDialog && (
                <div className="modal-overlay" data-ui="modal" onClick={() => setResultDialog(null)}>
                    <div
                        className="modal-dialog"
                        role="alertdialog"
                        aria-modal="true"
                        aria-label={resultDialog.title}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-body flex flex-col gap-2">
                            <h3 className="modal-title">{resultDialog.title}</h3>
                            <p className="menu-desc !mt-0" style={{ wordBreak: "break-word", whiteSpace: "pre-line" }}>{resultDialog.text}</p>
                        </div>
                        <div className="modal-footer">
                            <button type="button" className="ui-btn ui-btn-primary" onClick={() => setResultDialog(null)}>
                                知道了
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 换设备重连弹窗 */}
            {connectOpen && (
                <div className="modal-overlay" data-ui="modal" onClick={() => { if (busy !== "connect") setConnectOpen(false); }}>
                    <div
                        className="modal-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label="连接已有云服务"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-body flex flex-col gap-3">
                            <h3 className="modal-title">连接已有云服务</h3>
                            <div className="menu-desc !mt-0 rounded-[14px] bg-black/[0.03] px-3 py-2.5">
                                云端的项目、函数和数据都还在，换设备只是本机丢了连接。填部署时的项目地址和
                                service_role key（Supabase 控制台 Settings → API 可查），一键探测并接上，
                                不需要 Access Token，也不会重新部署。
                            </div>
                            <label className="flex flex-col gap-1">
                                <span className="menu-desc !mt-0">Supabase 项目地址</span>
                                <Input
                                    value={connectUrl}
                                    onChange={(e) => setConnectUrl(e.target.value)}
                                    placeholder="https://xxxx.supabase.co"
                                    spellCheck={false}
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="menu-desc !mt-0">service_role key</span>
                                <Input
                                    type="password"
                                    value={connectKey}
                                    onChange={(e) => setConnectKey(e.target.value)}
                                    placeholder="eyJ…"
                                    spellCheck={false}
                                />
                            </label>
                        </div>
                        <div className="modal-footer">
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline"
                                onClick={() => setConnectOpen(false)}
                                disabled={busy === "connect"}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className={`ui-btn ui-btn-primary ${busy === "connect" ? "is-busy" : ""}`}
                                onClick={() => void runConnect()}
                                disabled={Boolean(busy) || !connectUrl.trim() || !connectKey.trim()}
                            >
                                {busy === "connect"
                                    ? <><Loader2 size={15} className="animate-spin" /> {progress || "连接中…"}</>
                                    : "探测并连接"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 部署范围弹窗 */}
            {dialogOpen && (
                <div className="modal-overlay" data-ui="modal" onClick={() => { if (busy !== "deploy") setDialogOpen(false); }}>
                    <div
                        className="modal-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label="创建个人云项目并选择部署范围"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-body flex flex-col gap-3">
                            <h3 className="modal-title">部署个人云</h3>
                            {!selectedRef ? (
                                <div className="menu-desc !mt-0 rounded-[14px] bg-black/[0.03] px-3 py-2.5">
                                    将新建独立的「AI Phone Personal Cloud」项目，不会写入任何已有项目。
                                </div>
                            ) : (
                                <div className="menu-desc !mt-0 rounded-[14px] bg-black/[0.03] px-3 py-2.5">
                                    将更新此前由 AI Phone 创建的专用项目。
                                </div>
                            )}
                            {!selectedRef && (
                                <label className="flex flex-col gap-1">
                                    <span className="menu-desc !mt-0">创建到哪个 Supabase 组织</span>
                                    <Select value={selectedOrganizationSlug} onChange={(e) => setSelectedOrganizationSlug(e.target.value)}>
                                        <option value="" disabled>请选择…</option>
                                        {organizations.map(org => (
                                            <option key={org.slug} value={org.slug}>
                                                {org.name || org.slug}
                                            </option>
                                        ))}
                                    </Select>
                                </label>
                            )}
                            {scopeRow("云备份", scopeBackup, setScopeBackup, cloudReady)}
                            {scopeRow("微信接入", scopeWeixin, setScopeWeixin, weixinDeployed)}
                            {scopeRow("离线推送", scopePush, setScopePush, pushActive)}
                        </div>
                        <div className="modal-footer">
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline"
                                onClick={() => setDialogOpen(false)}
                                disabled={busy === "deploy"}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className={`ui-btn ui-btn-primary ${busy === "deploy" ? "is-busy" : ""}`}
                                onClick={() => void runDeploy()}
                                disabled={Boolean(busy) || (!selectedRef && !selectedOrganizationSlug) || (!scopeBackup && !scopeWeixin && !scopePush)}
                            >
                                {busy === "deploy"
                                    ? <><Loader2 size={15} className="animate-spin" /> {progress || "部署中…"}</>
                                    : selectedRef ? "开始部署" : "创建并部署"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
