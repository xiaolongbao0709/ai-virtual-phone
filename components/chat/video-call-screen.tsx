"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, getLatestCharacterStateValues } from "@/lib/chat-storage";
import type { StateValue } from "@/lib/chat-storage";
import { parseStateValues, mergeStateValues } from "@/lib/state-value-parser";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlob } from "@/lib/tts-service";
import { suspendKeepAliveForCall, resumeKeepAliveAfterCall } from "@/lib/use-weixin-bridge";
import { BilingualTextBlock } from "./message-bubble";
import { splitBilingualText } from "@/lib/bilingual-text";
import type { Character } from "@/lib/character-types";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { CallSttWarningDialog, hideCallSttWarningPermanently, isCallSttWarningHidden } from "./call-stt-warning-dialog";
import { isAndroidBrowser } from "./voice-input-platform";
import { CallVolumeControl } from "./call-volume-control";
import { startIncomingCallVibration } from "@/lib/call-vibration";

// ── Types ───────────────────────────────────────────

type CallState =
    | "CONNECTING"
    | "IDLE"
    | "USER_SPEAKING"
    | "PROCESSING"
    | "AI_SPEAKING"
    | "ENDED";

type SubtitleEntry = {
    id: string;
    role: "user" | "assistant";
    text: string;
};

type VideoCallScreenProps = {
    session: ChatSession;
    character: Character;
    onEnd: () => void;
    onConnect?: () => void;
    initiator?: "user" | "character";
};

function stripBilingualForSpeech(text: string): string {
    return text
        .split("\n")
        .map(line => splitBilingualText(line)?.original || line)
        .join("\n");
}

// ── Component ───────────────────────────────────────

export function VideoCallScreen({ session, character, onEnd, onConnect, initiator = "user" }: VideoCallScreenProps) {
    const androidTextInputOnlyRef = useRef(isAndroidBrowser());
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const [callState, setCallState] = useState<CallState>("CONNECTING");
    const hasConnectedRef = useRef(false);
    const [callDuration, setCallDuration] = useState(0);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [interimText, setInterimText] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [isSpeakerMuted, setIsSpeakerMuted] = useState(false);
    const [inputMode, setInputMode] = useState<"voice" | "text">(() => androidTextInputOnly ? "text" : "voice");
    const [typedText, setTypedText] = useState("");
    const [bgImageResolved, setBgImageResolved] = useState<string | null>(null);
    const [cameraEnabled, setCameraEnabled] = useState(false);
    const [cameraFacingMode, setCameraFacingMode] = useState<"user" | "environment">("user");
    const [cameraError, setCameraError] = useState<string | null>(null);
    const [pipSwapped, setPipSwapped] = useState(false);
    const [showSttWarning, setShowSttWarning] = useState(false);

    const sttRef = useRef<STTSession | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const subtitlesScrollRef = useRef<HTMLDivElement | null>(null);
    const callStartRef = useRef<number>(0);
    const stateRef = useRef<string>("CONNECTING");
    const interimTextRef = useRef<string>("");
    const sttWarningShownRef = useRef(false);
    const messagesRef = useRef<ChatMessage[]>([]);
    const cameraStreamRef = useRef<MediaStream | null>(null);
    const cameraEnabledRef = useRef<boolean>(false);
    const videoElRef = useRef<HTMLVideoElement | null>(null);
    const isSpeakerMutedRef = useRef<boolean>(false);
    const _initUi = resolveUserIdentity(session.contactId, "chat");
    const userNameRef = useRef<string>(_initUi?.name || "你");
    const userAvatarRef = useRef<string | null>(_initUi?.avatarUrl || null);

    useEffect(() => { stateRef.current = callState; }, [callState]);

    // 来电等待接听：循环振动（开关在聊天主页，iOS 网页不支持自动无效果）
    useEffect(() => {
        if (initiator !== "character" || callState !== "CONNECTING") return;
        const stop = startIncomingCallVibration();
        return stop;
    }, [initiator, callState]);

    // Pause WeChat keep-alive while the call holds the mic/audio; restore on exit.
    useEffect(() => {
        suspendKeepAliveForCall();
        return () => { resumeKeepAliveAfterCall(); };
    }, []);
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);
    useEffect(() => { cameraEnabledRef.current = cameraEnabled; }, [cameraEnabled]);

    const showSttCompatibilityWarning = useCallback(() => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttWarningShownRef.current || isCallSttWarningHidden()) return;
        sttWarningShownRef.current = true;
        setShowSttWarning(true);
    }, [androidTextInputOnly]);

    const handleNeverShowSttWarning = useCallback(() => {
        hideCallSttWarningPermanently();
        setShowSttWarning(false);
    }, []);

    useEffect(() => {
        const el = subtitlesScrollRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < 60) {
            window.requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
        }
    }, [subtitles.length, interimText]);
    useEffect(() => {
        isSpeakerMutedRef.current = isSpeakerMuted;
        if (isSpeakerMuted && audioAbortRef.current) {
            audioAbortRef.current();
            audioAbortRef.current = null;
        }
    }, [isSpeakerMuted]);

    useEffect(() => {
        if (!cameraError) return;
        const timer = window.setTimeout(() => setCameraError(null), 3500);
        return () => window.clearTimeout(timer);
    }, [cameraError]);

    const stopCameraStream = useCallback(() => {
        const stream = cameraStreamRef.current;
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
            cameraStreamRef.current = null;
        }
        if (videoElRef.current) {
            videoElRef.current.srcObject = null;
        }
    }, []);

    const startCameraStream = useCallback(async (facingMode: "user" | "environment") => {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
            setCameraError("当前环境不支持摄像头");
            return false;
        }
        // 安卓必须先释放旧流：摄像头被旧 track 占用时，请求另一颗摄像头会失败，
        // 或在 ideal 模式下被静默降级回前置（看起来"切不动"）。
        stopCameraStream();
        try {
            let stream: MediaStream;
            try {
                // exact 优先：切换语义明确，拿不到目标摄像头时真正报错而非静默回退
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { exact: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } },
                    audio: false,
                });
            } catch {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } },
                    audio: false,
                });
            }
            cameraStreamRef.current = stream;
            if (videoElRef.current) {
                videoElRef.current.srcObject = stream;
                videoElRef.current.play().catch(() => {});
            }
            return true;
        } catch (err) {
            console.warn("[VideoCall] getUserMedia failed:", err);
            setCameraError("无法访问摄像头");
            return false;
        }
    }, [stopCameraStream]);

    const handleCameraToggle = useCallback(async () => {
        if (cameraEnabled) {
            stopCameraStream();
            setCameraEnabled(false);
            return;
        }
        const ok = await startCameraStream(cameraFacingMode);
        if (ok) setCameraEnabled(true);
    }, [cameraEnabled, cameraFacingMode, startCameraStream, stopCameraStream]);

    const handleSwitchFacing = useCallback(async () => {
        if (!cameraEnabled) {
            setCameraError("请先打开摄像头");
            return;
        }
        const next: "user" | "environment" = cameraFacingMode === "user" ? "environment" : "user";
        const ok = await startCameraStream(next);
        if (ok) setCameraFacingMode(next);
        else {
            setCameraError("无法切换摄像头");
            await startCameraStream(cameraFacingMode);
        }
    }, [cameraEnabled, cameraFacingMode, startCameraStream]);

    const captureCameraFrame = useCallback((): string | null => {
        const video = videoElRef.current;
        if (!cameraEnabledRef.current || !video || !video.videoWidth || !video.videoHeight) return null;
        try {
            const canvas = document.createElement("canvas");
            const targetWidth = 640;
            const targetHeight = Math.round((video.videoHeight / video.videoWidth) * targetWidth);
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
            return canvas.toDataURL("image/jpeg", 0.7);
        } catch (err) {
            console.warn("[VideoCall] frame capture failed:", err);
            return null;
        }
    }, []);

    // ── Resolve videoBackground from IndexedDB ──────

    useEffect(() => {
        if (!session.videoBackground) {
            setBgImageResolved(null);
            return;
        }
        if (session.videoBackground.startsWith("data:") || session.videoBackground.startsWith("http")) {
            setBgImageResolved(session.videoBackground);
            return;
        }
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.videoBackground!).then(dataUrl => {
                if (dataUrl) setBgImageResolved(dataUrl);
            });
        });
    }, [session.videoBackground]);

    // ── Call timer ───────────────────────────────────

    useEffect(() => {
        if (callState === "CONNECTING" || callState === "ENDED") return;
        if (!callStartRef.current) callStartRef.current = Date.now();

        timerRef.current = setInterval(() => {
            setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
        }, 1000);

        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [callState]);

    // ── Connecting animation ─────────────────────────

    useEffect(() => {
        cancelFollowUp(session.id);

        const ui = resolveUserIdentity(session.contactId, "chat");
        userNameRef.current = ui?.name || "你";
        userAvatarRef.current = ui?.avatarUrl || null;

        messagesRef.current = loadChatMessages(session.id);

        const lastMsg = messagesRef.current[messagesRef.current.length - 1];
        const initRole = initiator === "character" ? "assistant" : "user";
        if (!lastMsg || !(lastMsg.content.includes("发起了视频通话"))) {
            const callMsg = initiator === "character"
                ? `[我向${userNameRef.current}发起了视频通话]`
                : `[我向${character.name}发起了视频通话]`;
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: initRole,
                content: callMsg,
            });
            messagesRef.current = [...messagesRef.current, sysMsg];
        }

        // User-initiated: auto-connect after 3s fake dial
        // Character-initiated: wait for user to accept
        let connectTimer: NodeJS.Timeout | undefined;
        if (initiator !== "character") {
            connectTimer = setTimeout(() => setCallState("IDLE"), 3000);
        }

        return () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (timerRef.current) clearInterval(timerRef.current);
            stopCameraStream();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track first connect
    useEffect(() => {
        if (callState !== "CONNECTING" && !hasConnectedRef.current) {
            hasConnectedRef.current = true;
        }
    }, [callState]);

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    const stateLabel = (): string => {
        switch (callState) {
            case "CONNECTING": return initiator === "character" ? "来电..." : "正在呼叫...";
            case "IDLE": return isMuted ? "已静音" : "视频通话中";
            case "USER_SPEAKING": return "正在聆听...";
            case "PROCESSING": return "对方正在思考...";
            case "AI_SPEAKING": return "对方正在说话...";
            case "ENDED": return "通话已结束";
        }
    };

    // ── AI response processing ──

    const processAIResponse = useCallback((aiResponseText: string): { cleanParts: string[]; stateValues: StateValue[] } => {
        const previousState = getLatestCharacterStateValues(session.contactId);

        const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(aiResponseText, previousState);

        // Filter out non-chat action types
        const chatParts = parts.filter(p =>
            !p.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(p.mediaType)
        );

        if (chatParts.length === 0 && (statusPanel || innerMonologue)) {
            const aiMsg = pushChatMessage({
                sessionId: session.id, role: "assistant", content: "",
                statusPanel,
                innerMonologue, stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
            });
            messagesRef.current = [...messagesRef.current, aiMsg];
        } else {
            const newMsgs = chatParts.map((part, idx) =>
                pushChatMessage({
                    sessionId: session.id, role: "assistant", content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    statusPanel: idx === 0 && statusPanel ? statusPanel : undefined,
                    innerMonologue: idx === 0 && innerMonologue ? innerMonologue : undefined,
                    stateValues: idx === 0 && stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues: idx === 0 ? freshStateValues : undefined,
                })
            );
            messagesRef.current = [...messagesRef.current, ...newMsgs];
        }

        const cleanParts = chatParts
            .filter(p => !p.mediaType && p.content.trim())
            .map(p => p.content);

        return { cleanParts, stateValues };
    }, [session.id, session.contactId]);

    // ── Full conversation turn ──────────────────────

    const runConversationTurn = useCallback(async (userText?: string) => {
        if (userText) {
            const userMsg = pushChatMessage({ sessionId: session.id, role: "user", content: userText });
            messagesRef.current = [...messagesRef.current, userMsg];
            setSubtitles(prev => [...prev, { id: userMsg.id, role: "user", text: userText }]);
        }
        setCallState("PROCESSING");
        setInterimText("");

        try {
            const frame = captureCameraFrame();
            const aiResponseText = flattenCompletionResult(await generateChatCompletion(session, messagesRef.current, {
                appTags: ["chat", "video"],
                attachedImages: frame ? [frame] : undefined,
            }));
            if (stateRef.current === "ENDED") return;

            const { cleanParts } = processAIResponse(aiResponseText);
            const displayText = cleanParts.join("\n");
            const speechText = stripBilingualForSpeech(displayText);

            if (!displayText) { setCallState("IDLE"); return; }

            setSubtitles(prev => [...prev, { id: `ai-${Date.now()}`, role: "assistant", text: displayText }]);
            setCallState("AI_SPEAKING");

            const voiceConfig = resolveVoiceConfig(session.contactId);
            if (voiceConfig && !isSpeakerMutedRef.current) {
                try {
                    const audioBlob = await synthesizeSpeech(speechText, voiceConfig);
                    if (stateRef.current === "ENDED") return;
                    if (audioBlob && !isSpeakerMutedRef.current) {
                        const { promise, abort } = playAudioBlob(audioBlob);
                        audioAbortRef.current = abort;
                        await promise;
                        audioAbortRef.current = null;
                    }
                } catch (e) { console.warn("[VideoCall] TTS failed:", e); }
            }

            if (stateRef.current !== "ENDED") setCallState("IDLE");
        } catch (error: any) {
            if (stateRef.current !== "ENDED") {
                setSubtitles(prev => [...prev, { id: `err-${Date.now()}`, role: "assistant", text: `⚠️ ${error?.message || "发送失败"}` }]);
                setCallState("IDLE");
            }
        }
    }, [session, processAIResponse, captureCameraFrame]);

    // ── Auto-listen ────────────────────────────────

    const startListening = useCallback(() => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setInterimText(""); interimTextRef.current = "";

        const stt = createSTTSession({
            onInterim: (text) => {
                setInterimText(text); interimTextRef.current = text;
                if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
            },
            onFinal: (text) => {
                sttRef.current = null;
                if (text.trim()) runConversationTurn(text.trim());
                else { setInterimText(""); setCallState("IDLE"); }
            },
            onError: () => {
                sttRef.current = null; setInterimText("");
                showSttCompatibilityWarning();
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") setCallState("IDLE");
            },
            onNoSpeech: () => {
                sttRef.current = null;
                showSttCompatibilityWarning();
                if (stateRef.current === "IDLE" || stateRef.current === "USER_SPEAKING") {
                    setTimeout(() => { if (stateRef.current === "IDLE") startListening(); }, 300);
                }
            },
            onEnd: () => {
                sttRef.current = null;
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    const fallback = interimTextRef.current;
                    if (fallback.trim()) runConversationTurn(fallback.trim());
                    else { setInterimText(""); setCallState("IDLE"); }
                }
            },
        }, "zh-CN");

        sttRef.current = stt;
        if (stt.isSupported) stt.start();
        else {
            sttRef.current = null;
            showSttCompatibilityWarning();
        }
    }, [androidTextInputOnly, runConversationTurn, session.contactId, showSttCompatibilityWarning]);

    useEffect(() => {
        if (inputMode === "text" && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
            setInterimText("");
        }
        if (!androidTextInputOnly && inputMode === "voice" && callState === "IDLE" && !isMuted) {
            const timer = setTimeout(() => { if (stateRef.current === "IDLE") startListening(); }, 500);
            return () => clearTimeout(timer);
        }
        if (isMuted && sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
    }, [androidTextInputOnly, callState, isMuted, inputMode, startListening]);

    const handleInputModeToggle = useCallback(() => {
        if (androidTextInputOnly) {
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
        } else {
            setInputMode("voice");
        }
    }, [androidTextInputOnly, inputMode]);

    const handleTextSubmit = useCallback(() => {
        const text = typedText.trim();
        if (!text || callState !== "IDLE") return;
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setTypedText("");
        runConversationTurn(text);
    }, [typedText, callState, runConversationTurn]);

    // ── Hangup ──────────────────────────────────────

    const handleHangup = useCallback(() => {
        setCallState("ENDED");
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
        stopCameraStream();
        if (window.speechSynthesis) window.speechSynthesis.cancel();

        const endMsg = pushChatMessage({
            sessionId: session.id, role: "user",
            content: `[我挂断了视频通话]`,
            mediaData: { callDuration: formatTime(callDuration) },
        });
        messagesRef.current = [...messagesRef.current, endMsg];
        setTimeout(() => onEnd(), 1500);
    }, [session.id, callDuration, onEnd, stopCameraStream]);

    // ── Render ──────────────────────────────────────

    return (
        <div className="absolute inset-0 z-[100] flex flex-col bg-black text-white overflow-hidden call-keyboard-shift" style={keyboardOffsetStyle}>
            <CallVolumeControl />
            {/* Full-screen blurred background (character avatar) */}
            <div
                className="videocall-bg-blur"
                style={{
                    backgroundImage: bgImageResolved
                        ? `url(${bgImageResolved})`
                        : character.avatar
                            ? `url(${character.avatar})`
                            : "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
                }}
            />

            {/* Main center view (character avatar by default, swaps with self when clicked) */}
            <div className="absolute inset-0 flex items-center justify-center z-[1]">
                {pipSwapped ? (
                    cameraEnabled ? (
                        <video
                            autoPlay
                            playsInline
                            muted
                            ref={(el) => {
                                videoElRef.current = el;
                                if (el && cameraStreamRef.current && el.srcObject !== cameraStreamRef.current) {
                                    el.srcObject = cameraStreamRef.current;
                                    el.play().catch(() => {});
                                }
                            }}
                            className="w-full h-full object-cover"
                        />
                    ) : userAvatarRef.current ? (
                        <img src={userAvatarRef.current} alt={userNameRef.current} className="w-full h-full object-cover" style={{ opacity: 0.85 }} />
                    ) : (
                        <div className="w-[150px] h-[150px] rounded-full bg-[#333] flex items-center justify-center">
                            <span className="ts-60 text-[var(--c-icon)]">{userNameRef.current?.[0] || "?"}</span>
                        </div>
                    )
                ) : character.avatar ? (
                    <img
                        src={character.avatar}
                        alt={character.name}
                        className="w-full h-full object-cover transition-opacity duration-500 ease-in-out"
                        style={{
                            opacity: callState === "CONNECTING" ? 0.5 : 0.85,
                        }}
                    />
                ) : (
                    <div className="w-[150px] h-[150px] rounded-full bg-[#333] flex items-center justify-center">
                        <span className="ts-60 text-[var(--c-icon)]">{character.name?.[0] || "?"}</span>
                    </div>
                )}
            </div>

            {/* PIP corner (self by default, character when swapped) — click to swap */}
            <button
                type="button"
                className="videocall-self-cam"
                onClick={() => setPipSwapped((v) => !v)}
                aria-label="切换大小画面"
                title="点击切换大小画面"
            >
                {pipSwapped ? (
                    character.avatar ? (
                        <img src={character.avatar} alt={character.name} className="w-full h-full object-cover" />
                    ) : (
                        <span className="ts-18 text-[var(--c-icon)]">{character.name?.[0] || "?"}</span>
                    )
                ) : cameraEnabled ? (
                    <video
                        autoPlay
                        playsInline
                        muted
                        ref={(el) => { if (el && el !== videoElRef.current) { videoElRef.current = el; if (cameraStreamRef.current) { el.srcObject = cameraStreamRef.current; el.play().catch(() => {}); } } }}
                        className="w-full h-full object-cover"
                    />
                ) : userAvatarRef.current ? (
                    <img src={userAvatarRef.current} alt={userNameRef.current} className="w-full h-full object-cover" />
                ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--c-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                    </svg>
                )}
            </button>

            {/* Top info bar */}
            <div className="relative z-10 gcall-topbar gcall-topbar-video">
                <div className="gcall-topbar-title videocall-name">
                    {character.name}
                </div>
                <div
                    className="gcall-topbar-sub videocall-name"
                    {...(callState === "CONNECTING" || callState === "PROCESSING" ? { "data-anim": "" } : {})}
                >
                    {callState !== "CONNECTING" && callState !== "ENDED" ? `${formatTime(callDuration)} · ` : ""}
                    {stateLabel()}
                </div>
            </div>

            {/* Subtitle log — scrollable */}
            <div
                ref={subtitlesScrollRef}
                className="call-subtitles-log"
            >
                {subtitles.map((sub) => (
                    <div
                        key={sub.id}
                        className="call-subtitle"
                        data-role={sub.role}
                    >
                        <BilingualTextBlock text={sub.text} mode="plain" className="call-subtitle-bilingual" defaultExpanded={session.collapseBilingualTranslation !== false ? false : true} />
                    </div>
                ))}
                {interimText && callState === "USER_SPEAKING" && (
                    <div
                        className="call-subtitle"
                        data-interim=""
                    >
                        {interimText}
                    </div>
                )}
            </div>

            {cameraError && (
                <div className="videocall-toast" role="status" aria-live="polite">{cameraError}</div>
            )}

            {inputMode === "text" && callState !== "CONNECTING" && callState !== "ENDED" && (
                <form
                    className={`call-text-input-panel videocall-text-input-panel${androidTextInputOnly ? " videocall-text-input-panel-android" : ""}`}
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleTextSubmit();
                    }}
                >
                    <div className="call-text-input-shell">
                        <input
                            value={typedText}
                            onChange={e => setTypedText(e.target.value)}
                            className="call-text-input"
                            placeholder={callState === "IDLE" ? "输入你想说的话..." : "稍等对方说完..."}
                            disabled={callState !== "IDLE"}
                        />
                        <button
                            type="submit"
                            className="call-text-send-btn"
                            disabled={!typedText.trim() || callState !== "IDLE"}
                            aria-label="发送"
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 19V5" />
                                <path d="M5 12l7-7 7 7" />
                            </svg>
                        </button>
                    </div>
                </form>
            )}

            {/* Bottom controls */}
            <div className={callState !== "ENDED" && callState !== "CONNECTING" && !androidTextInputOnly ? "videocall-controls-gradient videocall-controls-grid" : "videocall-controls-gradient"}>
                {callState !== "ENDED" && callState !== "CONNECTING" ? androidTextInputOnly ? (
                    /* 安卓纯文字模式：去掉的只有依赖语音识别的按钮（麦克风静音、语音/文字切换）；
                       摄像头开关、切换前后摄像头、扬声器静音在安卓完全可用，保留。 */
                    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 26, width: "100%" }}>
                        <button
                            onClick={handleCameraToggle}
                            className="ui-call-btn ui-call-btn-sm ui-call-btn-muted"
                            {...(cameraEnabled ? { "data-checked": "" } : {})}
                            aria-label={cameraEnabled ? "关闭摄像头" : "打开摄像头"}
                            title={cameraEnabled ? "摄像头开启" : "摄像头关闭"}
                        >
                            {cameraEnabled ? (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M23 7l-7 5 7 5V7z" />
                                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                                </svg>
                            ) : (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                    <path d="M16 16V8a2 2 0 0 0-2-2h-8" />
                                    <path d="M2 7v10a2 2 0 0 0 2 2h11" />
                                    <path d="M23 7l-7 5 7 5V7z" />
                                </svg>
                            )}
                        </button>
                        <button
                            onClick={handleHangup}
                            className="ui-call-btn ui-call-btn-sm ui-call-btn-danger"
                            aria-label="挂断"
                        >
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                        <button
                            onClick={handleSwitchFacing}
                            className="ui-call-btn ui-call-btn-sm ui-call-btn-muted"
                            disabled={!cameraEnabled}
                            aria-label="切换前后摄像头"
                            title={cameraEnabled ? "切换前后摄像头" : "需先开启摄像头"}
                        >
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 4v6h-6" />
                                <path d="M1 20v-6h6" />
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                            </svg>
                        </button>
                    </div>
                ) : (
                    <>
                        {/* Row 1: mic mute / mic interrupt / camera toggle */}
                        <button
                            onClick={() => setIsMuted(!isMuted)}
                            className="ui-call-btn ui-call-btn-sm ui-call-btn-muted"
                            {...(isMuted ? { "data-checked": "" } : {})}
                            aria-label={isMuted ? "取消静音麦克风" : "静音麦克风"}
                            title={isMuted ? "麦克风已静音" : "麦克风开启"}
                        >
                            {isMuted ? (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.15" />
                                    <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                                </svg>
                            ) : (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                    <line x1="12" y1="19" x2="12" y2="22" />
                                </svg>
                            )}
                        </button>

                        <button
                            onClick={handleInputModeToggle}
                            className="ui-call-mic"
                            data-state={
                                inputMode === "text" ? "text"
                                    : callState === "USER_SPEAKING" ? "speaking"
                                    : callState === "IDLE" ? (isMuted ? "idle-muted" : "idle")
                                    : "busy"
                            }
                            aria-label={androidTextInputOnly ? "文字输入" : inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                            title={androidTextInputOnly ? "安卓浏览器使用文字输入" : inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                        >
                            {inputMode === "text" ? (
                                <span className="ui-call-input-text-icon">Aa</span>
                            ) : (
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                    <line x1="12" y1="19" x2="12" y2="22" />
                                </svg>
                            )}
                        </button>

                        <button
                            onClick={handleCameraToggle}
                            className="ui-call-btn ui-call-btn-sm ui-call-btn-muted"
                            {...(cameraEnabled ? { "data-checked": "" } : {})}
                            aria-label={cameraEnabled ? "关闭摄像头" : "打开摄像头"}
                            title={cameraEnabled ? "摄像头开启" : "摄像头关闭"}
                        >
                            {cameraEnabled ? (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M23 7l-7 5 7 5V7z" />
                                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                                </svg>
                            ) : (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="1" y1="1" x2="23" y2="23" />
                                    <path d="M16 16V8a2 2 0 0 0-2-2h-8" />
                                    <path d="M2 7v10a2 2 0 0 0 2 2h11" />
                                    <path d="M23 7l-7 5 7 5V7z" />
                                </svg>
                            )}
                        </button>

                        {/* Row 2: speaker mute / hangup / switch cam */}
                        <button
                            onClick={() => setIsSpeakerMuted((v) => !v)}
                            className="ui-call-btn ui-call-btn-sm ui-call-btn-muted"
                            {...(isSpeakerMuted ? { "data-checked": "" } : {})}
                            aria-label={isSpeakerMuted ? "取消扬声器静音" : "静音扬声器"}
                            title={isSpeakerMuted ? "扬声器已静音" : "扬声器开启"}
                        >
                            {isSpeakerMuted ? (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                    <line x1="23" y1="9" x2="17" y2="15" />
                                    <line x1="17" y1="9" x2="23" y2="15" />
                                </svg>
                            ) : (
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                                </svg>
                            )}
                        </button>

                        <button
                            onClick={handleHangup}
                            className="ui-call-btn ui-call-btn-sm ui-call-btn-danger"
                            aria-label="挂断"
                        >
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>

                        <button
                            onClick={handleSwitchFacing}
                            className="ui-call-btn ui-call-btn-sm ui-call-btn-muted"
                            disabled={!cameraEnabled}
                            aria-label="切换前后摄像头"
                            title={cameraEnabled ? "切换前后摄像头" : "需先开启摄像头"}
                        >
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 4v6h-6" />
                                <path d="M1 20v-6h6" />
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                            </svg>
                        </button>
                    </>
                ) : callState === "CONNECTING" && initiator === "character" ? (
                    /* Incoming call: accept + decline */
                    <>
                        <button
                            onClick={() => {
                                pushChatMessage({ sessionId: session.id, role: "user", content: `[我拒绝了视频通话]` });
                                onEnd();
                            }}
                            className="ui-call-btn ui-call-btn-danger"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                        <button
                            onClick={() => setCallState("IDLE")}
                            className="ui-call-btn ui-call-btn-success"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                            </svg>
                        </button>
                    </>
                ) : callState === "CONNECTING" ? (
                    /* User-initiated: show cancel only */
                    <button
                        onClick={() => {
                            pushChatMessage({ sessionId: session.id, role: "user", content: `[我取消了视频通话]` });
                            onEnd();
                        }}
                        className="ui-call-btn ui-call-btn-danger"
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                            <line x1="23" y1="1" x2="1" y2="23" />
                        </svg>
                    </button>
                ) : (
                    <div className="ts-14 opacity-70">通话已结束</div>
                )}
            </div>

            {!androidTextInputOnly && showSttWarning && (
                <CallSttWarningDialog
                    onClose={() => setShowSttWarning(false)}
                    onNeverShow={handleNeverShowSttWarning}
                />
            )}

        </div>
    );
}
