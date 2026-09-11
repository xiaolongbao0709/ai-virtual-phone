"use client";

// 独家特调 · 信任模式机括的坑位宿主：给一块 React 不管辖的裸 DOM，
// 把实例登记在这个坑位上的回调依次挂上去；卸载或实例要求重挂时清掉重来。
// 与聊天插件的 ChatPluginSlot 同一思路。

import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import type { MixState } from "@/lib/mixology/types";
import type { MixMechanismStore } from "@/lib/mixology/mechanism-protocol";
import { mixTrustedMounts, mixTrustedVersion, subscribeMixTrusted, type MixTrustedSlotName } from "@/lib/mixology/trusted-runtime";

type Props = {
    sessionId: string;
    materialId: string;
    slot: MixTrustedSlotName;
    turnId?: string;
    text?: string;
    index?: number;
    state: MixState;
    store: MixMechanismStore;
    charName: string;
    userName: string;
    /** prose 坑位：不自己建容器，把这个函数返回的元素（正文容器）交给回调 */
    target?: () => HTMLElement | null;
    className?: string;
};

export const MixTrustedSlot = memo(function MixTrustedSlot({ sessionId, materialId, slot, turnId, text, index, state, store, charName, userName, target, className }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const version = useSyncExternalStore(
        (listener) => subscribeMixTrusted(sessionId, materialId, listener),
        () => mixTrustedVersion(sessionId, materialId),
        () => 0,
    );
    const mounts = mixTrustedMounts(sessionId, materialId, slot);
    const hasMounts = mounts.length > 0;
    // state/store 按内容参与依赖：值没变不重挂，免得每次渲染都把机括画的东西抹掉重画
    const stateKey = JSON.stringify(state);
    const storeKey = JSON.stringify(store);

    useEffect(() => {
        const el = target ? target() : containerRef.current;
        if (!el || !hasMounts) return;
        const disposers: (() => void)[] = [];
        for (const mount of mixTrustedMounts(sessionId, materialId, slot)) {
            try {
                const dispose = mount(el, { turnId, text, index, state: JSON.parse(stateKey), store: JSON.parse(storeKey), charName, userName });
                if (typeof dispose === "function") disposers.push(dispose);
            } catch {
                // 机括画坏了不该拖垮对局页，静默略过这一处
            }
        }
        return () => {
            for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
            if (!target) el.replaceChildren();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, materialId, slot, version, hasMounts, turnId, text, index, stateKey, storeKey, charName, userName]);

    if (target) return null;
    if (!hasMounts) return null;
    return <div ref={containerRef} className={className ?? "mix-trusted-slot"} data-slot={slot} data-material={materialId} />;
});
