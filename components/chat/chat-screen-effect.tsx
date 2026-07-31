"use client";

// 聊天室全屏特效层：表情雨 / 礼花 / 烟花 / 爱心 / 炸弹 / 骰子。
// 盖在聊天室上层但不拦截任何操作，粒子只用 transform/opacity 动画，播完自动卸载。

import { useEffect, useMemo, type CSSProperties } from "react";
import type { ChatScreenEffectType } from "@/lib/chat-screen-effects";
import { FireworksCanvas, FIREWORKS_DURATION_MS } from "./chat-screen-fireworks";

export type ActiveScreenEffect = {
    /** 每次触发唯一，作为 key 强制重建粒子 */
    runId: string;
    effect: ChatScreenEffectType;
    emojis: string;
    /** 骰子点数：由发送管线/特效钩子掷定并写入旁白，动画播放同一结果 */
    diceFace?: number;
};

const EFFECT_DURATION_MS: Record<ChatScreenEffectType, number> = {
    emoji_rain: 4200,
    confetti: 4200,
    fireworks: FIREWORKS_DURATION_MS,
    hearts: 4200,
    bomb: 2800,
    dice: 3200,
};

const EMOJI_RAIN_COUNT = 32;
const CONFETTI_COUNT = 44;
const HEART_COUNT = 22;
const BOMB_SPARKS = 16;
const CONFETTI_COLORS = ["#ff5f5f", "#ffb03a", "#ffe14d", "#5fd68a", "#4fa8ff", "#b28cff", "#ff8ad4"];
const HEART_EMOJIS = ["💗", "💖", "❤️", "💕"];

// 骰子点位：3x3 宫格（0-8）中每个点数要点亮的格子
const DICE_PIPS: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
};

// 3D 骰子：让指定点数朝向屏幕所需的立方体末态旋转（配合各面的摆放变换）
const DICE_ORIENTATIONS: Record<number, [number, number]> = {
    1: [0, 0],
    2: [-90, 0],
    3: [0, -90],
    4: [0, 90],
    5: [90, 0],
    6: [0, 180],
};
const DICE_FACES = [1, 2, 3, 4, 5, 6];

function splitEmojis(value: string): string[] {
    const list = Array.from(value.trim());
    return list.length > 0 ? list : ["🎉"];
}

type ParticleStyle = CSSProperties & Record<`--${string}`, string>;

function emojiRainParticles(emojis: string): { char: string; style: ParticleStyle }[] {
    const pool = splitEmojis(emojis);
    return Array.from({ length: EMOJI_RAIN_COUNT }, (_, i) => ({
        char: pool[i % pool.length],
        style: {
            left: `${Math.random() * 96}%`,
            fontSize: `${Math.round(22 + Math.random() * 22)}px`,
            animationDelay: `${(Math.random() * 1.4).toFixed(2)}s`,
            animationDuration: `${(2.2 + Math.random() * 1.4).toFixed(2)}s`,
            "--fx-drift": `${Math.round((Math.random() - 0.5) * 90)}px`,
            "--fx-spin": `${Math.round((Math.random() - 0.5) * 240)}deg`,
        },
    }));
}

function confettiParticles(): { color: string; style: ParticleStyle }[] {
    return Array.from({ length: CONFETTI_COUNT }, (_, i) => {
        // 从底部中央向上喷发再散落；水平角度左右均匀分布
        const spread = (i / (CONFETTI_COUNT - 1)) * 2 - 1;
        const jitter = (Math.random() - 0.5) * 0.3;
        const dx = (spread + jitter) * 46;
        return {
            color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
            style: {
                animationDelay: `${(Math.random() * 0.35).toFixed(2)}s`,
                animationDuration: `${(2.4 + Math.random() * 1.2).toFixed(2)}s`,
                "--fx-peak-x": `${(dx * 0.7).toFixed(1)}vw`,
                "--fx-peak-y": `${(-52 - Math.random() * 34).toFixed(1)}vh`,
                "--fx-end-x": `${dx.toFixed(1)}vw`,
                "--fx-spin": `${Math.round(360 + Math.random() * 540)}deg`,
                width: `${Math.round(6 + Math.random() * 5)}px`,
                height: `${Math.round(10 + Math.random() * 6)}px`,
            },
        };
    });
}

function heartParticles(): { char: string; style: ParticleStyle }[] {
    return Array.from({ length: HEART_COUNT }, (_, i) => ({
        char: HEART_EMOJIS[i % HEART_EMOJIS.length],
        style: {
            left: `${6 + Math.random() * 86}%`,
            fontSize: `${Math.round(22 + Math.random() * 26)}px`,
            animationDelay: `${(Math.random() * 1.6).toFixed(2)}s`,
            animationDuration: `${(2.2 + Math.random() * 1.2).toFixed(2)}s`,
            "--fx-drift": `${Math.round((Math.random() - 0.5) * 120)}px`,
            "--fx-spin": `${Math.round((Math.random() - 0.5) * 60)}deg`,
        },
    }));
}

function bombSparks(): { char: string; style: ParticleStyle }[] {
    return Array.from({ length: BOMB_SPARKS }, (_, i) => {
        const angle = (i / BOMB_SPARKS) * Math.PI * 2 + Math.random() * 0.3;
        const dist = 110 + Math.random() * 120;
        return {
            char: i % 3 === 0 ? "🔥" : "💥",
            style: {
                fontSize: `${Math.round(20 + Math.random() * 18)}px`,
                "--fx-tx": `${Math.round(Math.cos(angle) * dist)}px`,
                "--fx-ty": `${Math.round(Math.sin(angle) * dist)}px`,
            } as ParticleStyle,
        };
    });
}

type EffectParticles = {
    rain?: { char: string; style: ParticleStyle }[];
    confetti?: { color: string; style: ParticleStyle }[];
    fireworks?: boolean;
    hearts?: { char: string; style: ParticleStyle }[];
    bombSparks?: { char: string; style: ParticleStyle }[];
    diceFace?: number;
};

function buildParticles(effect: ChatScreenEffectType, emojis: string, diceFace?: number): EffectParticles {
    switch (effect) {
        case "confetti": return { confetti: confettiParticles() };
        case "fireworks": return { fireworks: true };
        case "hearts": return { hearts: heartParticles() };
        case "bomb": return { bombSparks: bombSparks() };
        case "dice": return { diceFace: diceFace ?? 1 + Math.floor(Math.random() * 6) };
        default: return { rain: emojiRainParticles(emojis) };
    }
}

export function ChatScreenEffectOverlay({ active, onDone }: {
    active: ActiveScreenEffect | null;
    onDone: () => void;
}) {
    // 粒子随机参数在每次 runId 变化时生成一次，动画期间保持稳定
    const particles = useMemo(() => {
        if (!active) return null;
        return buildParticles(active.effect, active.emojis, active.diceFace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active?.runId]);

    useEffect(() => {
        if (!active) return;
        const timer = window.setTimeout(onDone, EFFECT_DURATION_MS[active.effect] ?? 4200);
        return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active?.runId]);

    if (!active || !particles) return null;

    return (
        <div key={active.runId} className="chat-screen-fx" aria-hidden="true" {...(particles.bombSparks ? { "data-shake": "" } : {})}>
            {particles.rain?.map((p, i) => (
                <span key={i} className="chat-screen-fx-emoji" style={p.style}>{p.char}</span>
            ))}
            {particles.confetti?.map((p, i) => (
                <span key={i} className="chat-screen-fx-confetti" style={{ ...p.style, backgroundColor: p.color }} />
            ))}
            {particles.fireworks && (
                <>
                    <span className="chat-screen-fx-night" />
                    <FireworksCanvas />
                </>
            )}
            {particles.hearts?.map((p, i) => (
                <span key={i} className="chat-screen-fx-heart" style={p.style}>{p.char}</span>
            ))}
            {particles.bombSparks && (
                <>
                    <span className="chat-screen-fx-bomb">💣</span>
                    <span className="chat-screen-fx-flash" />
                    {particles.bombSparks.map((p, i) => (
                        <span key={i} className="chat-screen-fx-bomb-spark" style={p.style}>{p.char}</span>
                    ))}
                </>
            )}
            {particles.diceFace && (
                <span className="chat-screen-fx-dice-stage">
                    <span className="chat-screen-fx-dice-shadow" />
                    <span className="chat-screen-fx-dice-drop">
                        <span
                            className="chat-screen-fx-dice-cube"
                            style={{
                                "--dice-rx": `${DICE_ORIENTATIONS[particles.diceFace][0]}deg`,
                                "--dice-ry": `${DICE_ORIENTATIONS[particles.diceFace][1]}deg`,
                            } as ParticleStyle}
                        >
                            {DICE_FACES.map(face => (
                                <span key={face} className="chat-screen-fx-dice-face" data-face={face}>
                                    {Array.from({ length: 9 }, (_, cell) => (
                                        <span
                                            key={cell}
                                            className="chat-screen-fx-dice-pip"
                                            {...(DICE_PIPS[face].includes(cell) ? { "data-on": "" } : {})}
                                        />
                                    ))}
                                </span>
                            ))}
                        </span>
                    </span>
                </span>
            )}
        </div>
    );
}
