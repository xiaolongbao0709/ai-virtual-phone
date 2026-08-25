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
    syncAllWeixinBotRuntimesToCloud,
} from "@/lib/weixin-cloud-sync";
import { deployPersonalPushCloud, isPersonalPushCloudActive } from "@/lib/personal-push-cloud";
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

async function callSupabaseAdmin<T>(payload: Record<string, unknown>): Promise<T> {
    const res = await fetch("/api/supabase-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({})) as T & { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `管理接口返回 HTTP ${res.status}`);
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
    const [busy, setBusy] = useState<"organizations" | "deploy" | null>(null);
    const [resultDialog, setResultDialog] = useState<{ title: string; text: string } | null>(null);
    const [progress, setProgress] = useState("");

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
                if (data.organizations.length === 0) throw new Error("该 Supabase 账号下没有可用组织。");
                setOrganizations(data.organizations);
                setSelectedOrganizationSlug(data.organizations.length === 1 ? data.organizations[0].slug : "");
                setSelectedRef("");
            }
            setScopeBackup(true);
            setScopeWeixin(true);
            setScopePush(true);
            setDialogOpen(true);
        } catch (err) {
            setResultDialog({ title: "部署失败", text: err instanceof Error ? err.message : String(err) });
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
                <p className="text-[calc(11px*var(--app-text-scale,1))] font-medium text-gray-400">生成 Access Token 后复制粘贴；只用一次，不保存</p>
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
                            <p className="menu-desc !mt-0" style={{ wordBreak: "break-word" }}>{resultDialog.text}</p>
                        </div>
                        <div className="modal-footer">
                            <button type="button" className="ui-btn ui-btn-primary" onClick={() => setResultDialog(null)}>
                                知道了
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
