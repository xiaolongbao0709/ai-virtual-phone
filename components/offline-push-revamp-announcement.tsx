"use client";

import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";

import { kvGet, kvSet } from "@/lib/kv-db";

const NOTICE_KEY = "offline_push_revamp_notice_2026_08_v1";

export function OfflinePushRevampAnnouncement() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (kvGet(NOTICE_KEY) === "acknowledged") return;
    const timer = window.setTimeout(() => setOpen(true), 420);
    return () => window.clearTimeout(timer);
  }, []);

  if (!open) return null;

  const acknowledge = () => {
    kvSet(NOTICE_KEY, "acknowledged");
    setOpen(false);
  };

  return (
    <div className="modal-overlay" data-ui="modal">
      <section
        className="modal-dialog offline-push-revamp-notice"
        data-ui="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="offline-push-revamp-title"
        aria-describedby="offline-push-revamp-description"
      >
        <div className="offline-push-revamp-icon" aria-hidden="true">
          <BellRing size={23} strokeWidth={1.8} />
        </div>
        <div className="modal-header">
          <h2 className="modal-title" id="offline-push-revamp-title">离线推送服务调整通知</h2>
        </div>
        <div className="modal-body" id="offline-push-revamp-description">
          <p>
            近期离线推送与定时消息产生的服务器调用量大幅增长，已经超出本站共享云服务额度，可能造成离线回复延迟或定时消息无法按时送达。
          </p>
          <p>
            为恢复稳定并避免共享额度再次耗尽，离线推送正在改为支持部署到你自己的 Supabase。普通在线聊天和本地数据不受影响。
          </p>
        </div>
        <div className="modal-footer offline-push-revamp-actions">
          <button type="button" className="ui-btn ui-btn-primary" onClick={acknowledge} autoFocus>
            我知道了
          </button>
        </div>
      </section>
    </div>
  );
}
