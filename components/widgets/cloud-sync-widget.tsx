"use client";

// components/widgets/cloud-sync-widget.tsx
// 桌面组件「云同步」：长按桌面 → 添加组件 里拖出来，点一下弹出同步面板。
//
// 它不是新的一套备份逻辑，就是「设置 → 数据管理 → Cloud Backup」那套功能的桌面快捷入口：
// 同一个 Supabase 配置、同一个 ai-phone-backup 桶、同一个引擎（runCloudBackup /
// listCloudBackups / restoreFromCloudManifest），所以两边看到的备份列表完全一致，
// 不需要再填一次地址和 key。

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloudDownload, CloudUpload, Loader2, RefreshCw, Rocket } from "lucide-react";

import { BottomSheet, ConfirmDialog } from "@/components/ui/modal";
import { CloudServicesSetup } from "@/components/settings/cloud-services-setup";
import { formatBytes } from "@/lib/data-management/backup";
import { isCloudBackupConfigured, loadCloudBackupConfig, type CloudBackupConfig } from "@/lib/cloud-backup/config";
import {
  listCloudBackups,
  loadCloudBackupState,
  restoreFromCloudManifest,
  runCloudBackup,
  type CloudBackupListItem,
  type CloudBackupState,
} from "@/lib/cloud-backup/engine";

type Progress = { percent: number; detail: string };

function formatTime(value?: string): string {
  if (!value) return "无记录";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

/** 面板挂到手机壳里，避免浮层跑到手机外面去 */
function portalTarget(): Element {
  return document.querySelector(".phone-shell") ?? document.body;
}

export function CloudSyncWidget({ preview }: { preview?: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CloudBackupState>({});
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    setState(loadCloudBackupState());
    setConfigured(isCloudBackupConfigured(loadCloudBackupConfig()));
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="wg-cloud-sync"
        onClick={preview ? undefined : () => setOpen(true)}
        title="云同步"
      >
        <span className="wg-cloud-sync-icon"><CloudUpload size={20} /></span>
        <span className="wg-cloud-sync-text">
          <span className="wg-cloud-sync-title">云同步</span>
          <span className="wg-cloud-sync-sub">
            {!configured ? "未配置" : state.lastCreatedAt ? formatTime(state.lastCreatedAt) : "点击同步"}
          </span>
        </span>
      </button>
      {open && !preview && createPortal(
        <CloudSyncPanel onClose={() => setOpen(false)} />,
        portalTarget(),
      )}
    </>
  );
}

function CloudSyncPanel({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<CloudBackupConfig | null>(null);
  const [items, setItems] = useState<CloudBackupListItem[]>([]);
  const [listing, setListing] = useState(false);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<CloudBackupListItem | null>(null);
  const [restartHint, setRestartHint] = useState(false);
  // 「重新部署 / 去部署」：不跳去设置页，直接把云服务部署那套 UI 内嵌进本面板——
  // 功能与「设置 → 数据管理 → Cloud Backup」完全同一套（同一个 CloudServicesSetup
  // 组件、同一份 ai_phone_cloud_backup_config_v1），所以两边配的是一份东西。
  const [showDeploy, setShowDeploy] = useState(false);

  const refresh = useCallback(async (cfg: CloudBackupConfig) => {
    setListing(true);
    try {
      setItems(await listCloudBackups(cfg));
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "读取云端备份列表失败。" });
      setItems([]);
    } finally {
      setListing(false);
    }
  }, []);

  useEffect(() => {
    const cfg = loadCloudBackupConfig();
    setConfig(cfg);
    if (isCloudBackupConfigured(cfg)) void refresh(cfg);
  }, [refresh]);

  const ready = Boolean(config && isCloudBackupConfigured(config));

  // 部署页可能刚写入/换掉了云备份配置（取回 service_role key、换设备重连），
  // 关掉它时重读配置并顺手刷新备份列表，回到面板就是新连接下的数据。
  const refreshDeployState = async () => {
    const fresh = loadCloudBackupConfig();
    setConfig(fresh);
    if (isCloudBackupConfigured(fresh)) await refresh(fresh);
  };

  const closeDeploy = async () => {
    setShowDeploy(false);
    await refreshDeployState();
  };

  const doBackup = async () => {
    if (!config || busy) return;
    setBusy("backup");
    setNotice(null);
    try {
      // 与设置页的「立即备份」完全一致：强制跑一次、完整含图片（云端分片上传）
      const result = await runCloudBackup(config, { force: true, excludeMedia: false, onProgress: setProgress });
      if (result.status === "anomaly") {
        setNotice({ ok: false, text: "数据明显变小，已存为待复核备份，之前的备份都保留着。" });
      } else if (result.status === "skipped") {
        setNotice({ ok: true, text: "数据没有变化，已跳过本次备份。" });
      } else {
        setNotice({ ok: true, text: `已备份：${result.uploadedModules} 个模块 · ${formatBytes(result.totalBytes)}` });
      }
      await refresh(config);
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "备份失败。" });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const doRestore = async (item: CloudBackupListItem) => {
    if (!config || busy) return;
    setPending(null);
    setBusy("restore");
    setNotice(null);
    try {
      // 合并写入：同 ID 以云端为准，本机独有的数据保留（与设置页恢复同一语义）
      const result = await restoreFromCloudManifest(config, item.name, { overwrite: true, onProgress: setProgress });
      const restored = result.added + result.overwritten;
      if (restored === 0 && result.errors.length > 0) throw new Error(result.errors[0]);
      if (result.errors.length > 0) console.warn("[CloudSyncWidget] restore errors:", result.errors);
      setNotice({
        ok: true,
        text: `已同步：新增 ${result.added}，覆盖 ${result.overwritten}，跳过 ${result.skipped}`
          + (result.errors.length > 0 ? `，${result.errors.length} 项出错` : ""),
      });
      setRestartHint(true);
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "同步失败。" });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <>
      <BottomSheet title="云同步" onClose={busy ? () => {} : onClose}>
        {!ready ? (
          <div className="menu-group">
            <div className="menu-item data-readonly-item">
              <div className="menu-label-group">
                <span className="menu-label">还没有配置云端存储</span>
                <span className="menu-desc">
                  请先到「设置 → 数据管理 → Cloud Backup」把你的 Supabase 部署好。配好之后这里会自动读取，不用再填一次。
                </span>
              </div>
            </div>
            <div className="wg-cloud-panel-actions">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                onClick={() => setShowDeploy(true)}
              >
                <Rocket size={16} /> 去部署
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="wg-cloud-panel-actions">
              <button
                type="button"
                className={`ui-btn ui-btn-primary ${busy === "backup" ? "is-busy" : ""}`}
                onClick={() => void doBackup()}
                disabled={Boolean(busy)}
              >
                {busy === "backup"
                  ? <><Loader2 size={16} className="animate-spin" /> 备份中…</>
                  : <><CloudUpload size={16} /> 备份上去</>}
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-outline"
                onClick={() => config && void refresh(config)}
                disabled={Boolean(busy) || listing}
              >
                {listing
                  ? <><Loader2 size={16} className="animate-spin" /> 读取中…</>
                  : <><RefreshCw size={16} /> 刷新列表</>}
              </button>
              {/* 与设置 → 数据管理 → Cloud Backup 的「重新部署 / 去部署」同源：
                  内嵌同一套部署 UI，不跳转 */}
              <button
                type="button"
                className="ui-btn ui-btn-outline"
                onClick={() => setShowDeploy(true)}
                disabled={Boolean(busy)}
              >
                <Rocket size={16} /> 重新部署
              </button>
            </div>

            {progress && (
              <div className="data-cloud-progress" role="status">
                <div className="data-cloud-progress-track">
                  <div className="data-cloud-progress-fill" style={{ width: `${Math.min(100, Math.round(progress.percent))}%` }} />
                </div>
                <span className="data-cloud-progress-text">{progress.detail} · {Math.round(progress.percent)}%</span>
              </div>
            )}

            {notice && (
              <div className={`data-cloud-result ${notice.ok ? "" : "is-err"}`} role="status">{notice.text}</div>
            )}

            <div className="data-cloud-status">
              点一份备份即可同步下来。恢复是合并写入：同一条数据以云端为准，本机独有的内容会保留。
            </div>

            <div className="menu-group">
              {listing && items.length === 0 ? (
                <div className="menu-item data-readonly-item">
                  <span className="menu-desc"><Loader2 size={14} className="animate-spin" /> 读取云端备份…</span>
                </div>
              ) : items.length === 0 ? (
                <div className="menu-item data-readonly-item">
                  <span className="menu-desc">云端还没有备份，先点「备份上去」。</span>
                </div>
              ) : items.map((item) => (
                <div key={item.name} className="menu-item data-readonly-item">
                  <div className="menu-label-group">
                    <span className="menu-label">
                      {formatTime(item.createdAt)}
                      {item.error ? " · 清单损坏" : item.quarantine ? " · 待复核" : ""}
                    </span>
                    <span className="menu-desc">
                      {item.error ?? `${formatBytes(item.totalBytes)} · ${item.totalRecords} 项`}
                    </span>
                  </div>
                  <div className="menu-right data-inline-actions">
                    <button
                      type="button"
                      className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                      onClick={() => setPending(item)}
                      disabled={Boolean(busy) || Boolean(item.error)}
                    >
                      <CloudDownload size={14} /> 同步下来
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </BottomSheet>

      {pending && (
        <ConfirmDialog
          title="从云端同步这份备份？"
          message={`备份时间：${formatTime(pending.createdAt)}\n同一条数据会以云端为准覆盖本机，本机独有的内容保留。`}
          confirmLabel="同步"
          variant="action"
          onConfirm={() => void doRestore(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {showDeploy && createPortal(
        // 内嵌云服务部署（与设置里同一套 UI）。单独 portal 到手机壳里、而不是套在
        // 上面的 BottomSheet 内部：抽屉那层 .modal-sheet 带入场 transform，
        // 固定定位的后代会以它为基准，嵌进去会错位。
        <BottomSheet title="云服务部署" onClose={() => void closeDeploy()}>
          <CloudServicesSetup onConfigChanged={() => void refreshDeployState()} />
        </BottomSheet>,
        portalTarget(),
      )}

      {restartHint && (
        <ConfirmDialog
          title="同步完成，请重新载入"
          // 恢复是直写 IndexedDB 的，各模块的内存缓存不会回灌。留在当前页面继续用，
          // 旧缓存会把刚同步回来的数据重新覆盖掉（与设置页恢复后的提示同一原因）。
          message="数据已经写进本机，但当前页面还在用同步前的旧缓存运行。请立刻重新载入，否则继续使用可能让旧缓存把刚同步的数据覆盖掉。"
          confirmLabel="重新载入"
          cancelLabel=""
          variant="action"
          onConfirm={() => window.location.reload()}
          onCancel={() => setRestartHint(false)}
        />
      )}
    </>
  );
}
