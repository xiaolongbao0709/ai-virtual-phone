"use client";

import React, { useState, useEffect, useRef } from "react";
import type { Character } from "@/lib/character-types";
import { User, MapPin, Sparkles, Navigation, Clock, Undo2 } from "lucide-react";

export type OfflineInviteData = {
    direction: "he_comes" | "i_go";
    place?: string;
    reason?: string;
    onTheWayMessage?: string;
    transitCardMessage?: string;
    arrivedMessage?: string;
    arrivalCardMessage?: string;
    status: "pending" | "on_the_way" | "arrived";
    isEarlyArrived?: boolean;
    /** 提前到达时冻结的剩余分钟数（用于回溯时精准无损断点续存，绝不被磨蹭时间蚕食） */
    frozenRemainingMinutes?: number;
    startTime?: number;
    durationMinutes?: number;
    sourceBatchId?: string;
    /** 初次发起邀约时的地点（如“你身边”；若最初是身边，即使中途改了坐标，到达时标题依然保持“已到达你身边”的情感浪漫） */
    initialPlace?: string;
    /** 卡片情绪视觉主题：default（经典蓝白）| alert（心跳白红·危机/吃醋）| forced（强行动身·暂以白红渲染，未来黑红） */
    theme?: "default" | "alert" | "forced";
    /** 初次发起邀约的批次ID（全场唯一生命之根，永不覆盖） */
    initialBatchId?: string;
    /** 该赴约生命周期中涉及的所有批次ID（包含发起、改地点、在途、到达等） */
    relatedBatchIds?: string[];
    /** 终身到达防重印记：是否已触发并发送过到达小灰字与到达微信消息，防止倒计时或水合重复触发 */
    hasFiredArrivalMessage?: boolean;
};

export function getRemainingMinutes(startTime?: number, durationMinutes: number = 15): number {
    if (!startTime) return 0;
    const elapsedMs = Date.now() - startTime;
    const remainingMs = durationMinutes * 60 * 1000 - elapsedMs;
    return Math.max(0, Math.ceil(remainingMs / 60000));
}

function formatReason(text?: string): string {
    if (!text) return "";
    const trimmed = text.trim();
    if (!trimmed) return "";
    if (/[。！？…~!?”’]$/.test(trimmed)) return trimmed;
    return trimmed + "。";
}

function getModalDescription(invite: OfflineInviteData): string {
    if (invite.status === "arrived") {
        // 到达状态：优先展示角色以第一人称现场亲口所说的私房心语/叮嘱，绝无生硬第三人称旁白
        if (invite.arrivalCardMessage?.trim()) {
            return `“${formatReason(invite.arrivalCardMessage)}”`;
        }
        if (invite.arrivedMessage?.trim()) {
            return `“${formatReason(invite.arrivedMessage)}”`;
        }
        return invite.direction === "he_comes"
            ? "对方已到达约定地点，正在等待与你碰面。"
            : "对方正在约定的地方等候你的到来。";
    }
    if (invite.status === "on_the_way") {
        // 在途状态：优先展示角色以第一人称表达的在途私房心语（5段格式专属），绝不与微信发信重复
        if (invite.transitCardMessage?.trim() && invite.transitCardMessage.trim() !== invite.onTheWayMessage?.trim()) {
            return `“${formatReason(invite.transitCardMessage)}”`;
        }
        if (invite.transitCardMessage?.trim()) {
            return `“${formatReason(invite.transitCardMessage)}”`;
        }
        // 若缺少独立在途心语，退回展示提议初衷，避免与微信聊天框里刚刚发出的动身报备逐字重复
        if (invite.reason?.trim() && invite.reason.trim() !== invite.onTheWayMessage?.trim()) {
            return `“${formatReason(invite.reason)}”`;
        }
        return invite.direction === "he_comes"
            ? "对方正在赶来的路上，请稍作等候。"
            : "对方正在约定的地方等候你的到来。";
    }
    if (invite.reason?.trim()) {
        return `“${formatReason(invite.reason)}”`;
    }
    return invite.direction === "he_comes"
        ? "对方想要来见你，正在等待你的回应。"
        : "对方正在约定的地方等候你的到来。";
}

/** 在途状态搜寻眼眸图标：左右警觉巡视探查动效 */
function SearchingEyeIcon({ className = "", size = 16.5 }: { className?: string; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            {/* 杏仁眼型轮廓 */}
            <path d="M2 13.5C2 13.5 5.5 7.5 12 7.5C18.5 7.5 22 13.5 22 13.5C22 13.5 18.5 19.5 12 19.5C5.5 19.5 2 13.5 2 13.5Z" />
            {/* 灵动眼球/瞳孔：原版纯粹的定睛凝视 ➔ 左右警觉微探搜寻 ➔ 瞬间回锁正中 */}
            <circle cx="12" cy="13.5" r="2.8">
                <animate
                    attributeName="cx"
                    values="12; 12; 10.6; 10.6; 13.4; 13.4; 12; 12"
                    keyTimes="0; 0.45; 0.53; 0.65; 0.73; 0.85; 0.92; 1"
                    dur="4s"
                    repeatCount="indefinite"
                />
            </circle>
            {/* 三根生动翘起的眼睫毛：根部顺应外沿，无丝毫内渗 */}
            <path d="M12 6.6V2.6" />
            <path d="M6.5 8.2L4.2 4.4" />
            <path d="M17.5 8.2L19.8 4.4" />
        </svg>
    );
}

/** 强制到达锁定眼眸图标：睁大聚焦动效 */
function LockedEyeIcon({ className = "", size = 16.5 }: { className?: string; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            style={{ overflow: "visible" }}
        >
            <g style={{ transformOrigin: "12px 13.5px" }}>
                {/* 睁大至 1.18 倍定格 0.65 秒后平缓回弹 */}
                <animateTransform
                    attributeName="transform"
                    type="scale"
                    values="1; 1.18; 1.18; 1; 1"
                    keyTimes="0; 0.05; 0.25; 0.41; 1"
                    dur="3.2s"
                    repeatCount="indefinite"
                />
                {/* 杏仁眼型轮廓 */}
                <path d="M2 13.5C2 13.5 5.5 7.5 12 7.5C18.5 7.5 22 13.5 22 13.5C22 13.5 18.5 19.5 12 19.5C5.5 19.5 2 13.5 2 13.5Z" />
                {/* 三根生动翘起的眼睫毛：根部顺应外沿，无丝毫内渗 */}
                <path d="M12 6.6V2.6" />
                <path d="M6.5 8.2L4.2 4.4" />
                <path d="M17.5 8.2L19.8 4.4" />

                {/* 灵动瞳孔：瞬间收敛至 2.1 ➔ 死死定格锁定 0.65秒 ➔ 缓缓舒展回 2.8 ➔ 待机巡视 */}
                <circle cx="12" cy="13.5" r="2.8">
                    <animate
                        attributeName="r"
                        values="2.8; 2.1; 2.1; 2.8; 2.8"
                        keyTimes="0; 0.05; 0.25; 0.41; 1"
                        dur="3.2s"
                        repeatCount="indefinite"
                    />
                    <animate
                        attributeName="cx"
                        values="12; 12; 12; 11.2; 11.2; 12.8; 12.8; 12"
                        keyTimes="0; 0.25; 0.45; 0.58; 0.70; 0.82; 0.94; 1"
                        dur="3.2s"
                        repeatCount="indefinite"
                    />
                </circle>
            </g>
        </svg>
    );
}

/** 闭目眼眸图标：微弯闭目与垂睫动效 */
function ClosedEyelashEyeIcon({ className = "", size = 16.5 }: { className?: string; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            {/* 优雅微弯的闭目眼睑弧线 */}
            <path d="M2 11.5C2 11.5 5.5 16.5 12 16.5C18.5 16.5 22 11.5 22 11.5" />
            {/* 三根生动垂下的眼睫毛 */}
            <path d="M12 16.5V21" />
            <path d="M7 14.8L4.5 18.8" />
            <path d="M17 14.8L19.5 18.8" />
        </svg>
    );
}

/** 律动心电波形图标：波形起伏与舒张心率动效 */
function HeartbeatWaveIcon({ className = "", size = 16 }: { className?: string; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            style={{ overflow: "visible" }}
        >
            <g style={{ transformOrigin: "12px 12px" }}>
                {/* 伴随波形爆发的 Lub-Dub 双拍心悸鼓动（前 0.6 秒完成跳动，后 0.8 秒舒张） */}
                <animateTransform
                    attributeName="transform"
                    type="scale"
                    values="1; 1.25; 0.96; 1.16; 1; 1"
                    keyTimes="0; 0.11; 0.18; 0.27; 0.43; 1"
                    dur="1.4s"
                    repeatCount="indefinite"
                />
                {/* 动态波形变轨：前 0.6 秒爆发 QRS 冲顶与抚平，后 0.8 秒保持平稳呼吸基线 */}
                <path d="M2 12H6L7.5 11.5L9 12.5L10.5 12L12 12L13.5 12L15 12L16.5 12L18 12H22">
                    <animate
                        attributeName="d"
                        values="
                            M2 12H6L7.5 11.5L9 12.5L10.5 12L12 12L13.5 12L15 12L16.5 12L18 12H22;
                            M2 12H5L6.8 9.5L8.5 17L11 3.5L13.5 19.5L15.2 8.5L16.5 13.5L18 12H22;
                            M2 12H6L7.5 13L9.5 10L11.5 15.5L13.5 8L15.5 14L17 11.5L18.5 12H22;
                            M2 12H6L8 12L10 11.5L12 12.5L14 11.8L16 12.2L18 12H22;
                            M2 12H6L7.5 11.5L9 12.5L10.5 12L12 12L13.5 12L15 12L16.5 12L18 12H22
                        "
                        keyTimes="0; 0.13; 0.27; 0.43; 1"
                        dur="1.4s"
                        repeatCount="indefinite"
                    />
                </path>
            </g>
        </svg>
    );
}

/** 长按头像/卡片温存微粒子系统（爱心与光尘微粒） */
function AvatarHugParticles({ active }: { active: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let animationFrameId: number;

        // 粒子池
        const particles: Array<{
            x: number;
            y: number;
            vx: number;
            vy: number;
            size: number;
            alpha: number;
            decay: number;
            color: string;
            type: "heart" | "star" | "dot";
            rotation: number;
            vRot: number;
        }> = [];

        let lastSpawn = 0;

        const resize = () => {
            if (canvas.parentElement) {
                const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
                const width = canvas.parentElement.offsetWidth;
                const height = canvas.parentElement.offsetHeight;
                canvas.width = width * dpr;
                canvas.height = height * dpr;
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.scale(dpr, dpr);
            }
        };
        resize();

        const spawnParticles = () => {
            const width = canvas.parentElement ? canvas.parentElement.offsetWidth : 315;
            const centerX = width / 2;
            const centerY = 62; // 头像中心垂直坐标
            const types: ("heart" | "star" | "dot")[] = ["heart", "star", "dot", "dot"];
            const colors = ["244, 114, 182", "232, 122, 144", "251, 191, 36", "253, 207, 224"];

            // 每次仅生成 1 颗温和向四周漫溢的光尘（极低功耗，轻柔飘逸）
            const angle = Math.random() * Math.PI * 2;
            const dist = 32 + Math.random() * 6; // 从头像轮廓起跑
            const speed = 0.4 + Math.random() * 0.7; // 温和向四周扩散
            particles.push({
                x: centerX + Math.cos(angle) * dist,
                y: centerY + Math.sin(angle) * dist,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: 3.5 + Math.random() * 4,
                alpha: 0.85,
                decay: 0.012 + Math.random() * 0.008,
                color: colors[Math.floor(Math.random() * colors.length)],
                type: types[Math.floor(Math.random() * types.length)],
                rotation: Math.random() * Math.PI * 2,
                vRot: (Math.random() - 0.5) * 0.05,
            });
        };

        const render = (time: number) => {
            const width = canvas.parentElement ? canvas.parentElement.offsetWidth : 315;
            const height = canvas.parentElement ? canvas.parentElement.offsetHeight : 500;
            ctx.clearRect(0, 0, width, height);

            // 激活期间定期发射粒子
            if (active && time - lastSpawn > 140) {
                spawnParticles();
                lastSpawn = time;
            }

            // 绘制向四周漫溢散开的微粒子
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.x += p.vx;
                p.y += p.vy;
                p.rotation += p.vRot;
                p.alpha -= p.decay;

                if (p.alpha <= 0) {
                    particles.splice(i, 1);
                    continue;
                }

                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rotation);
                ctx.fillStyle = `rgba(${p.color}, ${p.alpha})`;

                if (p.type === "heart") {
                    const s = p.size * 0.45;
                    ctx.beginPath();
                    ctx.moveTo(0, s * 0.3);
                    ctx.bezierCurveTo(-s, -s * 0.6, -s * 1.8, s * 0.6, 0, s * 1.8);
                    ctx.bezierCurveTo(s * 1.8, s * 0.6, s, -s * 0.6, 0, s * 0.3);
                    ctx.fill();
                } else if (p.type === "star") {
                    const s = p.size * 0.6;
                    ctx.beginPath();
                    ctx.moveTo(0, -s);
                    ctx.quadraticCurveTo(0, 0, s, 0);
                    ctx.quadraticCurveTo(0, 0, 0, s);
                    ctx.quadraticCurveTo(0, 0, -s, 0);
                    ctx.quadraticCurveTo(0, 0, 0, -s);
                    ctx.fill();
                } else {
                    ctx.beginPath();
                    ctx.arc(0, 0, p.size * 0.35, 0, Math.PI * 2);
                    ctx.fill();
                }

                ctx.restore();
            }

            if (active || particles.length > 0) {
                animationFrameId = requestAnimationFrame(render);
            }
        };

        animationFrameId = requestAnimationFrame(render);

        return () => {
            cancelAnimationFrame(animationFrameId);
        };
    }, [active]);

    return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-10" />;
}

interface OfflineInviteModalProps {
    invite: OfflineInviteData;
    character?: Character | null;
    onAccept: () => void;
    onDecline: () => void;
    onMinimize: () => void;
    onEarlyArrive?: () => void;
}

export function OfflineInviteModal({
    invite,
    character,
    onAccept,
    onDecline,
    onMinimize,
    onEarlyArrive,
}: OfflineInviteModalProps) {
    const isHeComes = invite.direction === "he_comes";
    const charName = character?.name || "对方";

    // 状态机：pending（待答应）| on_the_way（在途中）| arrived（已到达）
    const isPending = invite.status === "pending";
    const isOnTheWay = invite.status === "on_the_way";
    const isArrived = invite.status === "arrived";

    const [remainingMins, setRemainingMins] = useState(() =>
        getRemainingMinutes(invite.startTime, invite.durationMinutes || 15),
    );

    useEffect(() => {
        if (!isOnTheWay) return;
        const update = () => {
            const mins = getRemainingMinutes(invite.startTime, invite.durationMinutes || 15);
            setRemainingMins(mins);
        };
        update();
        const timer = setInterval(update, 10000);
        return () => clearInterval(timer);
    }, [isOnTheWay, invite.startTime, invite.durationMinutes]);

    const isForcedTheme = invite.theme === "forced";
    const dialogRef = useRef<HTMLDivElement>(null);

    // 强制到达震动与窗口抖动节律（1-2 微颤）
    useEffect(() => {
        if (!isForcedTheme) return;
        const trigger12Resonance = () => {
            // 1. 触觉震动模式（200ms -> 停 260ms -> 120ms -> 停 100ms -> 120ms）
            try {
                if (typeof window !== "undefined" && "vibrate" in navigator) {
                    navigator.vibrate([200, 260, 120, 100, 120]);
                }
            } catch {}

            // 2. 视效同步：启动 1-2 窗口抖动动画（0.96s，与震感对齐）
            if (dialogRef.current) {
                dialogRef.current.classList.remove("offline-invite-12-pulse");
                void dialogRef.current.offsetWidth;
                dialogRef.current.classList.add("offline-invite-12-pulse");
            }
        };

        // 弹窗开启瞬间立即触发
        trigger12Resonance();

        // 弹窗保持打开期间，每隔 4.5 秒循环一次 1-2 律动
        const interval = setInterval(trigger12Resonance, 4500);

        return () => {
            clearInterval(interval);
            try {
                if (typeof window !== "undefined" && "vibrate" in navigator) {
                    navigator.vibrate(0);
                }
            } catch {}
        };
    }, [isForcedTheme]);

    const isPureAlertTheme = invite.theme === "alert";

    // 紧急赴约微震：对齐心跳波形周期的双拍触感
    useEffect(() => {
        if (!isPureAlertTheme) return;
        const triggerHeartbeatPulse = () => {
            try {
                if (typeof window !== "undefined" && "vibrate" in navigator) {
                    // 对齐 HeartbeatWaveIcon 波峰节律（150ms -> 停 170ms -> 140ms）
                    navigator.vibrate([150, 170, 140]);
                }
            } catch {}
        };

        // 弹窗开启稍作 50ms 缓冲让 SVG 动画起跑，第一记正好咬住 180ms 峰顶
        const initialTimer = setTimeout(triggerHeartbeatPulse, 50);

        // 对齐心跳波形周期（1.4s * 3 = 4.2s）
        const interval = setInterval(triggerHeartbeatPulse, 4200);

        return () => {
            clearTimeout(initialTimer);
            clearInterval(interval);
            try {
                if (typeof window !== "undefined" && "vibrate" in navigator) {
                    navigator.vibrate(0);
                }
            } catch {}
        };
    }, [isPureAlertTheme]);

    // 长按头像或卡片空白处触发温存状态与光晕渐变
    const [isHugging, setIsHugging] = useState(false);

    // 长按温存心跳循环微震（与 1.1s 光环扩散节奏同频）
    useEffect(() => {
        if (!isHugging) return;

        const triggerHugHeartbeat = () => {
            try {
                if (typeof window !== "undefined" && "vibrate" in navigator) {
                    // 拟真心跳触觉节奏（38ms -> 停 70ms -> 28ms）
                    navigator.vibrate([38, 70, 28]);
                }
            } catch {}
        };

        // 按下的刹那第一圈光环漾出，立刻踩响第一记心跳
        triggerHugHeartbeat();

        // 严丝合缝咬合光环 1.1s（1100ms）荡漾周期，光环与手心脉搏完全同频共振
        const pulseInterval = setInterval(triggerHugHeartbeat, 1100);

        return () => {
            clearInterval(pulseInterval);
            try {
                if (typeof window !== "undefined" && "vibrate" in navigator) {
                    navigator.vibrate(0);
                }
            } catch {}
        };
    }, [isHugging]);

    const handlePointerDown = (e: React.PointerEvent) => {
        if (isForcedTheme || isPureAlertTheme) return;
        // 隔离按钮与交互链接：点按功能按钮时走正常点击，不触发长按拥抱
        const target = e.target as HTMLElement | null;
        if (target && target.closest("button, a")) {
            return;
        }
        setIsHugging(true);
    };

    const handlePointerUp = () => {
        if (isHugging) {
            setIsHugging(false);
        }
    };

    return (
        <div
            className={`fixed inset-0 z-50 flex items-center justify-center p-4 ${isForcedTheme ? "bg-black/65 backdrop-blur-md" : "bg-black/45 backdrop-blur-sm"} animate-in fade-in duration-200`}
            data-ui="offline-invite-overlay"
            onClick={onMinimize}
        >
            <div
                ref={dialogRef}
                className={`relative w-full max-w-[315px] rounded-2xl p-5 flex flex-col items-center gap-4 text-center select-none cursor-pointer touch-none transition-all duration-500 ease-out animate-in zoom-in-95 duration-200 overflow-hidden ${
                    isForcedTheme
                        ? "offline-invite-dialog-forced"
                        : isHugging
                        ? "offline-invite-dialog-hug"
                        : "offline-invite-dialog-base"
                }`}
                data-ui="offline-invite-dialog"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onPointerLeave={handlePointerUp}
            >
                {/* 长按温存光晕过渡层（GPU Opacity 平滑渐变） */}
                {!isForcedTheme && (
                    <div
                        className={`pointer-events-none absolute inset-0 rounded-2xl transition-opacity duration-500 ease-out z-0 ${
                            isHugging ? "opacity-100" : "opacity-0"
                        }`}
                        style={{
                            background: "radial-gradient(circle at 50% 28%, #fff0f4 0%, #fff7f9 45%, #ffffff 100%)",
                        }}
                    />
                )}

                {/* 长按温存微粒子层 */}
                <AvatarHugParticles active={isHugging} />

                {/* 右上角返回键（弯箭头） */}
                <button
                    type="button"
                    onClick={onMinimize}
                    className={`absolute top-3.5 right-3.5 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-500 ease-out cursor-pointer active:scale-90 shadow-sm z-20 ${
                        isHugging ? "opacity-0 pointer-events-none scale-90" : "opacity-100 scale-100"
                    } ${
                        isForcedTheme
                            ? "bg-white/10 border border-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                            : "bg-[var(--c-input,rgba(0,0,0,0.05))] hover:bg-[var(--c-input-border,rgba(0,0,0,0.1))] text-[var(--c-icon,#9ca3af)] hover:text-[var(--c-text-title,#111827)]"
                    }`}
                    aria-label={isOnTheWay ? "收起状态" : "稍后处理"}
                    title={isOnTheWay ? "收起状态" : "稍后处理"}
                >
                    <Undo2 size={17} />
                </button>

                {/* 角色头像与状态光晕徽章 */}
                {(() => {
                    const isAlertTheme = invite.theme === "alert" || isForcedTheme;
                    // 紧急与强制主题下的红光外溢光晕样式
                    const badgeBg = isAlertTheme
                        ? "bg-[var(--c-danger,#FF3B30)] shadow-[0_2px_8px_rgba(255,59,48,0.4)]"
                        : isHugging
                        ? "offline-invite-badge-hug"
                        : "bg-[var(--c-primary,#2563eb)] shadow-[0_2px_8px_rgba(37,99,235,0.35)]";
                    const badgeBorder = isAlertTheme ? "border-[var(--c-danger,#FF3B30)]/30" : "border-[var(--c-primary,#2563eb)]/30";
                    const tagStyle = isForcedTheme
                        ? "bg-[var(--c-danger,#FF3B30)]/18 text-[#ff5449] border border-[var(--c-danger,#FF3B30)]/45 shadow-[0_0_14px_rgba(255,59,48,0.25)]"
                        : isAlertTheme
                        ? "bg-[var(--c-danger,#FF3B30)]/10 text-[var(--c-danger,#FF3B30)] border border-[var(--c-danger,#FF3B30)]/20"
                        : isHugging
                        ? "offline-invite-tag-hug"
                        : "bg-[var(--c-primary,#2563eb)]/10 text-[var(--c-primary,#2563eb)] border border-[var(--c-primary,#2563eb)]/20";
                    const accentText = isAlertTheme ? "text-[var(--c-danger,#FF3B30)]" : isHugging ? "text-[#e87994]" : "text-[var(--c-primary,#2563eb)]";
                    const primaryBtn = isForcedTheme
                        ? "bg-[var(--c-danger,#FF3B30)] text-white shadow-[0_4px_18px_rgba(255,59,48,0.5),inset_0_1px_1px_rgba(255,255,255,0.3)] hover:opacity-95"
                        : isAlertTheme
                        ? "bg-[var(--c-danger,#FF3B30)] text-white shadow-[0_4px_16px_rgba(255,59,48,0.38),inset_0_1px_1px_rgba(255,255,255,0.2)] hover:opacity-95"
                        : isHugging
                        ? "offline-invite-btn-hug text-white hover:opacity-95"
                        : "bg-[var(--c-primary,#2563eb)] text-white shadow-[0_4px_16px_rgba(37,99,235,0.35),inset_0_1px_1px_rgba(255,255,255,0.2)] hover:opacity-95";
                    const secondaryBtn = isForcedTheme
                        ? "border border-white/15 bg-white/[0.08] text-gray-200 hover:bg-white/15 hover:text-white"
                        : "border border-[var(--c-border,#d1d5db)] text-[var(--c-text,#4b5563)] hover:bg-[var(--c-input,#f3f4f6)]";

                    return (
                        <>
                            <div className="relative mt-2 w-16 h-16">
                                {/* 长按向四周荡漾的纤细柔粉光环线（纯 CSS GPU 加速） */}
                                {isHugging && (
                                    <div className="pointer-events-none absolute inset-0">
                                        <span className="offline-invite-hug-ring" />
                                        <span className="offline-invite-hug-ring offline-invite-hug-ring-2" />
                                    </div>
                                )}
                                <div
                                    className={`w-full h-full rounded-full overflow-hidden flex items-center justify-center select-none touch-none transition-all duration-500 ease-out relative z-10 ${
                                        isForcedTheme
                                            ? "border-2 border-[var(--c-danger,#FF3B30)]/60 shadow-[0_0_18px_rgba(255,59,48,0.45)] bg-[#25202a]"
                                            : isHugging
                                            ? "offline-invite-avatar-hug bg-[#fff5f7]"
                                            : `border-2 ${badgeBorder} shadow-md bg-[var(--c-input,#f3f4f6)] offline-invite-avatar-base`
                                    }`}
                                    title="长按头像或空白处感受心跳温存"
                                >
                                    {character?.avatar ? (
                                        <img src={character.avatar} alt={charName} className="w-full h-full object-cover pointer-events-none" />
                                    ) : (
                                        <User size={30} className="text-[var(--c-text,#9ca3af)] pointer-events-none" />
                                    )}
                                </div>
                                <div className={`absolute -bottom-1 -right-1 w-6 h-6 rounded-full ${badgeBg} text-white flex items-center justify-center transition-all duration-500 ease-out z-20 ${
                                    isHugging ? "opacity-0 pointer-events-none scale-75" : "opacity-100 scale-100"
                                } ${
                                    isForcedTheme ? "shadow-[0_2px_10px_rgba(255,59,48,0.7)] border border-white/20" : "shadow"
                                }`}>
                                    {isOnTheWay ? (
                                        <Navigation size={12} className="animate-pulse" />
                                    ) : isArrived ? (
                                        <Sparkles size={12} />
                                    ) : (
                                        <MapPin size={13} />
                                    )}
                                </div>
                            </div>

                            {/* 标题与情境标签 */}
                            <div className="flex flex-col items-center gap-1 relative z-10">
                                <div className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium transition-all duration-500 ease-out ${tagStyle}`}>
                                    {invite.theme === "forced" ? (
                                        isOnTheWay ? (
                                            <SearchingEyeIcon size={16.5} className="shrink-0" />
                                        ) : (
                                            <LockedEyeIcon size={16.5} className="shrink-0" />
                                        )
                                    ) : isAlertTheme ? (
                                        <HeartbeatWaveIcon size={16} className="shrink-0" />
                                    ) : (
                                        <Sparkles size={11} className="shrink-0" />
                                    )}
                                    <span>
                                        {isOnTheWay
                                            ? (invite.theme === "forced" ? "你已无法阻拦" : "在途赶来中")
                                            : isArrived
                                            ? (invite.theme === "forced" ? "Ta来了……" : (invite.isEarlyArrived ? "已提前到达" : "已经到达"))
                                            : isHeComes
                                            ? (isAlertTheme ? "紧急赶来" : "奔赴提议")
                                            : (isAlertTheme ? "紧急邀约" : "线下邀约")}
                                    </span>
                                </div>
                                {(() => {
                                    const isOriginByYourSide = invite.initialPlace === "你身边" || (!invite.initialPlace && invite.place === "你身边");
                                    const arrivedPlaceText = isOriginByYourSide
                                        ? "你身边"
                                        : (invite.place ? `「${invite.place}」` : "");
                                    return (
                                        <h3 className={`${isForcedTheme ? "text-white text-[17px] drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]" : "text-[var(--c-text-title,#111827)] text-[16px]"} font-bold mt-1 transition-colors duration-500 ease-out`}>
                                            {isOnTheWay
                                                ? (invite.theme === "forced" ? `${charName} 正直奔你而来` : `${charName} 正在赶来的路上`)
                                                : isArrived
                                                ? `${charName} ${invite.isEarlyArrived ? "已提前到达" : "已到达"}${arrivedPlaceText}`
                                                : isHeComes
                                                ? (isAlertTheme ? `${charName} 紧急提议来见你` : `${charName} 提议来见你`)
                                                : (isAlertTheme ? `${charName} “邀请你”赴约` : `${charName} 邀请你赴约`)}
                                        </h3>
                                    );
                                })()}
                                <div className={`inline-flex items-center justify-center gap-1 text-[11px] ${isForcedTheme ? "text-gray-400" : isHugging ? "text-[#e87994] font-medium" : "text-[var(--c-text,#9ca3af)]"} mt-0.5 transition-all duration-500 ease-out`}>
                                    {isHugging ? (
                                        <span>指尖触碰，心跳正在同步……</span>
                                    ) : (
                                        <>
                                            <span>按右上角</span>
                                            <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full scale-90 ${
                                                isForcedTheme
                                                    ? "bg-white/10 border border-white/10 text-gray-300"
                                                    : "bg-[var(--c-input,#f3f4f6)] text-[var(--c-icon,#9ca3af)]"
                                            }`}>
                                                <Undo2 size={9.5} />
                                            </span>
                                            <span>{isOnTheWay ? "可收起状态" : isArrived ? "可收起通知" : "可稍后处理"}{(!isForcedTheme && !isPureAlertTheme) ? "，长按温存" : ""}</span>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* 说明卡片与在途倒计时 */}
                            <div className={`w-full rounded-xl p-3 text-left flex flex-col gap-1.5 transition-all duration-500 ease-out relative z-10 ${
                                isForcedTheme
                                    ? "bg-white/[0.06] border border-[var(--c-danger,#FF3B30)]/25 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]"
                                    : isHugging
                                    ? "offline-invite-desc-hug"
                                    : "bg-[var(--c-input,#f3f4f6)]/70 border border-[var(--c-input-border,rgba(0,0,0,0.04))]"
                            }`}>
                                {isOnTheWay ? (
                                    <div className={`flex items-center gap-2 text-xs font-semibold ${isForcedTheme ? "text-[#ff5449]" : accentText}`}>
                                        <Clock size={14} className="shrink-0" />
                                        <span>预计约 {remainingMins > 0 ? remainingMins : 1} 分钟后到达</span>
                                    </div>
                                ) : null}

                                {invite.place && (
                                    <div className={`text-xs font-medium flex items-center gap-1 ${isForcedTheme ? "text-gray-100" : "text-[var(--c-text-title,#111827)]"}`}>
                                        <MapPin size={12} className={`${isForcedTheme ? "text-[#ff5449]" : accentText} shrink-0`} />
                                        <span>奔赴地点：{invite.place}</span>
                                    </div>
                                )}

                                <div className={`text-xs leading-relaxed italic line-clamp-3 ${isForcedTheme ? "text-gray-300" : "text-[var(--c-text,#4b5563)]"}`}>
                                    {getModalDescription(invite)}
                                </div>
                            </div>

                            {/* 操作按钮组 */}
                            <div className="flex items-center gap-2.5 w-full mt-1 relative z-10">
                                {isPending ? (
                                    <>
                                        <button
                                            type="button"
                                            onClick={onDecline}
                                            className={`flex-1 py-2.5 px-3 rounded-xl border text-xs font-medium active:scale-95 transition-all duration-500 ease-out cursor-pointer ${secondaryBtn}`}
                                        >
                                            拒绝Ta
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onAccept}
                                            className={`flex-1 py-2.5 px-3 rounded-xl ${primaryBtn} text-xs font-semibold active:scale-95 transition-all duration-500 ease-out cursor-pointer`}
                                        >
                                            {isHeComes ? "答应Ta" : "去见Ta"}
                                        </button>
                                    </>
                                ) : isOnTheWay ? (
                                    <>
                                        <button
                                            type="button"
                                            onClick={onMinimize}
                                            className={`flex-1 py-2.5 px-3 rounded-xl border text-xs font-medium active:scale-95 transition-all duration-500 ease-out cursor-pointer ${secondaryBtn}`}
                                        >
                                            线上继续聊
                                        </button>
                                        <button
                                            type="button"
                                            onClick={onEarlyArrive || onAccept}
                                            className={`flex-1 py-2.5 px-3 rounded-xl ${primaryBtn} text-xs font-semibold active:scale-95 transition-all duration-500 ease-out cursor-pointer`}
                                        >
                                            已经到了
                                        </button>
                                    </>
                                ) : (
                                    /* isArrived */
                                    <button
                                        type="button"
                                        onClick={onAccept}
                                        className={`w-full py-2.5 px-4 rounded-xl ${primaryBtn} text-xs font-semibold active:scale-95 transition-all duration-500 ease-out cursor-pointer`}
                                    >
                                        去见Ta
                                    </button>
                                )}
                            </div>
                        </>
                    );
                })()}
            </div>
        </div>
    );
}

interface OfflineInviteCapsuleProps {
    invite: OfflineInviteData;
    character?: Character | null;
    onClick: () => void;
    onAccept?: () => void;
    isRetrying?: boolean;
}

export function OfflineInviteCapsule({
    invite,
    character,
    onClick,
    onAccept,
    isRetrying = false,
}: OfflineInviteCapsuleProps) {
    const isHeComes = invite.direction === "he_comes";
    const charName = character?.name || "对方";
    const isOnTheWay = invite.status === "on_the_way";
    const isArrived = invite.status === "arrived";

    const [remainingMins, setRemainingMins] = useState(() =>
        getRemainingMinutes(invite.startTime, invite.durationMinutes || 15),
    );

    useEffect(() => {
        if (!isOnTheWay) return;
        const update = () => {
            const mins = getRemainingMinutes(invite.startTime, invite.durationMinutes || 15);
            setRemainingMins(mins);
        };
        update();
        const timer = setInterval(update, 10000);
        return () => clearInterval(timer);
    }, [isOnTheWay, invite.startTime, invite.durationMinutes]);

    const isForcedTheme = invite.theme === "forced";
    const isAlertTheme = invite.theme === "alert" || isForcedTheme;
    const pingDotBg = isAlertTheme ? "bg-[var(--c-danger,#FF3B30)]" : "bg-[var(--c-primary,#2563eb)]";
    const solidDotBg = isAlertTheme
        ? `bg-[var(--c-danger,#FF3B30)] ${isForcedTheme ? "shadow-[0_0_8px_rgba(255,59,48,0.9)]" : ""}`
        : "bg-[var(--c-primary,#2563eb)]";
    const btnBg = isForcedTheme
        ? "bg-[var(--c-danger,#FF3B30)] shadow-[0_2px_12px_rgba(255,59,48,0.6)] hover:opacity-95 text-white"
        : isAlertTheme
        ? "bg-[var(--c-danger,#FF3B30)] shadow-[0_2px_8px_rgba(255,59,48,0.38)] hover:opacity-95 text-white"
        : "bg-[var(--c-primary,#2563eb)] shadow-[0_2px_8px_rgba(37,99,235,0.35)] hover:opacity-90 text-white";
    const actionText = isForcedTheme
        ? "text-[#ff5449]"
        : isAlertTheme
        ? "text-[var(--c-danger,#FF3B30)]"
        : "text-[var(--c-primary,#2563eb)]";

    return (
        <div
            onClick={isRetrying ? undefined : onClick}
            className={`w-fit max-w-[92%] mx-auto px-3.5 py-1.5 rounded-full backdrop-blur-md shadow-md flex items-center gap-2 select-none transition-all ${
                isRetrying ? "cursor-default" : "cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
            } ${
                isForcedTheme
                    ? "offline-invite-capsule-forced"
                    : "bg-[var(--c-panel,#ffffff)]/95 border border-[var(--c-panel-border,rgba(0,0,0,0.12))]"
            }`}
            data-ui="offline-invite-capsule"
            title={isRetrying ? "正在回溯赴约状态……" : "点击查看邀约详情"}
        >
            <span className="relative inline-flex items-center justify-center h-2 w-2 shrink-0">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pingDotBg}`} />
                <span className={`relative inline-flex rounded-full h-2 w-2 ${solidDotBg}`} />
            </span>
            <span className={`text-xs font-medium truncate inline-flex items-center leading-none ${isForcedTheme ? "text-gray-100" : "text-[var(--c-text-title,#111827)]"}`}>
                {isRetrying
                    ? "正在回溯中……"
                    : (isOnTheWay
                        ? `${charName}正在赶来，约剩${remainingMins > 0 ? remainingMins : 1}分钟后到达`
                        : isArrived
                        ? (() => {
                            const isOriginByYourSide = invite.initialPlace === "你身边" || (!invite.initialPlace && invite.place === "你身边");
                            const arrivedPlaceText = isOriginByYourSide
                                ? "你身边"
                                : (invite.place ? (invite.place === "你身边" ? "你身边" : `「${invite.place}」`) : "");
                            const prefix = isAlertTheme ? "" : "✨ ";
                            return `${prefix}${charName} ${invite.isEarlyArrived ? "已提前到达" : "已到达"}${arrivedPlaceText}`;
                        })()
                        : isHeComes
                        ? (isAlertTheme ? `${charName} 紧急提议来见你（待赴约）` : `${charName} 提议来见你（待赴约）`)
                        : (isAlertTheme ? `${charName} 要求你前来赴约` : `${charName} 正在等候你赴约`))
                }
            </span>
            {!isRetrying && (
                onAccept && (isArrived || !isHeComes) ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onAccept();
                        }}
                        className={`text-[11px] font-semibold px-2.5 h-[22px] rounded-full active:scale-95 transition-all shrink-0 cursor-pointer shadow-sm inline-flex items-center justify-center leading-none ${btnBg}`}
                    >
                        去见Ta
                    </button>
                ) : (
                    <span className={`text-[10px] font-semibold shrink-0 inline-flex items-center leading-none ${actionText}`}>
                        {isOnTheWay ? "查看" : isArrived ? "去见Ta" : "处理"}
                    </span>
                )
            )}
        </div>
    );
}
