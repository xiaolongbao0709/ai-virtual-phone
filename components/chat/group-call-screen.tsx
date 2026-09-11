"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, getLatestCharacterStateValues } from "@/lib/chat-storage";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import { generateGroupChatCompletion } from "@/lib/group-chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlob, playAudioBlobViaMediaElement, setCallAudioSessionActive } from "@/lib/tts-service";
import { isCallRecordingSupported, resolveCloudSttConfig } from "@/lib/stt-cloud";
import { useHoldToTalk } from "./use-hold-to-talk";
import { suspendKeepAliveForCall, resumeKeepAliveAfterCall } from "@/lib/use-weixin-bridge";
import { BilingualTextBlock } from "./message-bubble";
import { splitBilingualText } from "@/lib/bilingual-text";
import type { Character } from "@/lib/character-types";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { isAndroidBrowser, isIOSDevice } from "./voice-input-platform";
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
    senderName?: string;
    senderCharacterId?: string;
};

function stripBilingualForSpeech(text: string): string {
    return text
        .split("\n")
        .map(line => splitBilingualText(line)?.original || line)
        .join("\n");
}

type GroupCallScreenProps = {
    type: "voice" | "video";
    session: ChatSession;
    characters: Character[];
    onEnd: () => void;
    initiator?: "user" | "character";
    initiatorName?: string; // 发起通话的角色名（initiator="character" 时使用）
};

// ── Component ───────────────────────────────────────

export function GroupCallScreen({ type, session, characters, onEnd, initiator = "user", initiatorName }: GroupCallScreenProps) {
    // 同 voice-call-screen：iOS 保留 Web Speech 免提 + Web Audio 播放；
    // 其余设备改按住说话 + 云端转写，播放走媒体元素。没配识别时回落旧行为。
    const iosDeviceRef = useRef(isIOSDevice());
    const iosDevice = iosDeviceRef.current;
    const holdToTalkRef = useRef(
        !iosDeviceRef.current && isCallRecordingSupported() && resolveCloudSttConfig() !== null,
    );
    const holdToTalk = holdToTalkRef.current;
    const androidTextInputOnlyRef = useRef(isAndroidBrowser() && !holdToTalkRef.current);
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    const playCallAudio = iosDevice ? playAudioBlob : playAudioBlobViaMediaElement;
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const [callState, setCallState] = useState<CallState>("CONNECTING");
    const hasConnectedRef = useRef(false);
    const [callDuration, setCallDuration] = useState(0);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [interimText, setInterimText] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [inputMode, setInputMode] = useState<"voice" | "text">(() => androidTextInputOnly ? "text" : "voice");
    const [typedText, setTypedText] = useState("");
    // Track who is currently speaking (for video mode highlight)
    const [speakingCharId, setSpeakingCharId] = useState<string | null>(null);

    const sttRef = useRef<STTSession | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const callStartRef = useRef<number>(0);
    const stateRef = useRef<string>("CONNECTING");
    const interimTextRef = useRef<string>("");
    const subtitleScrollRef = useRef<HTMLDivElement>(null);
    const messagesRef = useRef<ChatMessage[]>([]);
    const userNameRef = useRef<string>("你");
    const userAvatarRef = useRef<string | null>(null);

    const isVideo = type === "video";
    const callTypeLabel = isVideo ? "视频通话" : "语音通话";

    // Pause WeChat keep-alive while the call holds the mic/audio; restore on exit.
    useEffect(() => {
        suspendKeepAliveForCall();
        return () => { resumeKeepAliveAfterCall(); };
    }, []);

    // ── Resolve per-participant video backgrounds from IndexedDB ──
    const [resolvedBgs, setResolvedBgs] = useState<Record<string, string>>({});
    useEffect(() => {
        const bgMap = session.groupVideoBackgrounds;
        if (!bgMap || Object.keys(bgMap).length === 0) { setResolvedBgs({}); return; }
        let cancelled = false;
        (async () => {
            const { getChatImageFromIndexedDB } = await import("@/lib/chat-asset-storage");
            const result: Record<string, string> = {};
            await Promise.all(Object.entries(bgMap).map(async ([key, val]) => {
                if (!val) return;
                if (val.startsWith("data:") || val.startsWith("http")) { result[key] = val; return; }
                const url = await getChatImageFromIndexedDB(val);
                if (url) result[key] = url;
            }));
            if (!cancelled) setResolvedBgs(result);
        })();
        return () => { cancelled = true; };
    }, [session.groupVideoBackgrounds]);

    // ── Resolve single voice background ──
    const [voiceBgResolved, setVoiceBgResolved] = useState<string | null>(null);
    useEffect(() => {
        if (!session.voiceBackground) { setVoiceBgResolved(null); return; }
        if (session.voiceBackground.startsWith("data:") || session.voiceBackground.startsWith("http")) {
            setVoiceBgResolved(session.voiceBackground); return;
        }
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.voiceBackground!).then(url => { if (url) setVoiceBgResolved(url); });
        });
    }, [session.voiceBackground]);

    // Keep refs in sync
    useEffect(() => { stateRef.current = callState; }, [callState]);

    // 来电等待接听：循环振动（开关在聊天主页，iOS 网页不支持自动无效果）
    useEffect(() => {
        if (initiator !== "character" || callState !== "CONNECTING") return;
        const stop = startIncomingCallVibration();
        return stop;
    }, [initiator, callState]);
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);

    // Scroll subtitles to bottom
    useEffect(() => {
        if (subtitleScrollRef.current) {
            subtitleScrollRef.current.scrollTop = subtitleScrollRef.current.scrollHeight;
        }
    }, [subtitles, interimText]);

    // ── Call timer ───────────────────────────────────
    useEffect(() => {
        if (callState === "CONNECTING" || callState === "ENDED") return;
        if (!callStartRef.current) callStartRef.current = Date.now();
        timerRef.current = setInterval(() => {
            setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
        }, 1000);
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [callState]);

    // ── Init ─────────────────────────────────────────
    useEffect(() => {
        cancelFollowUp(session.id);
        const ui = resolveUserIdentity(undefined, "group_chat");
        userNameRef.current = ui?.name || "你";
        userAvatarRef.current = ui?.avatarUrl || null;
        messagesRef.current = loadChatMessages(session.id);

        const lastMsg = messagesRef.current[messagesRef.current.length - 1];
        const initRole = initiator === "character" ? "assistant" : "user";
        if (!lastMsg || !(lastMsg.content.includes(`发起了${callTypeLabel}`))) {
            const callMsg = `[我向群聊发起了${callTypeLabel}]`;
            const initCharId = initiator === "character" ? characters.find(c => c.name === initiatorName)?.id : undefined;
            const sysMsg = pushChatMessage({
                sessionId: session.id, role: initRole, content: callMsg,
                ...(initCharId ? { senderCharacterId: initCharId, senderName: initiatorName } : {}),
            });
            messagesRef.current = [...messagesRef.current, sysMsg];
        }

        let connectTimer: NodeJS.Timeout | undefined;
        if (initiator !== "character") {
            connectTimer = setTimeout(() => setCallState("IDLE"), 3000);
        }
        return () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (timerRef.current) clearInterval(timerRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
            case "IDLE": return isMuted && !holdToTalk ? "已静音" : (holdToTalk && inputMode === "voice" ? "按住麦克风说话" : "通话中");
            case "USER_SPEAKING": return holdToTalk ? "松开发送" : "正在聆听...";
            case "PROCESSING": return holdToTalk && holdInput.recState === "transcribing" ? "识别中..." : "对方正在思考...";
            case "AI_SPEAKING": return "对方正在说话...";
            case "ENDED": return "通话已结束";
        }
    };

    // ── Conversation turn ────────────────────────────
    const runConversationTurn = useCallback(async (userText?: string) => {
        if (userText) {
            const userMsg = pushChatMessage({
                sessionId: session.id, role: "user", content: userText,
            });
            messagesRef.current = [...messagesRef.current, userMsg];
            setSubtitles(prev => [...prev, { id: userMsg.id, role: "user", text: userText }]);
        }

        setCallState("PROCESSING");
        setInterimText("");

        try {
            const results = await generateGroupChatCompletion(session, messagesRef.current, undefined, {
                appTags: ["group_chat", isVideo ? "video" : "voice"],
                disableTools: true,
            });
            if (stateRef.current === "ENDED") return;

            for (const r of results) {
                if (stateRef.current === "ENDED") return;

                const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(
                    r.responseText,
                    getLatestCharacterStateValues(r.characterId),
                );
                const textParts = parts.filter(p => !p.mediaType && p.content.trim());
                const displayText = textParts.map(p => p.content).join("\n");
                const speechText = stripBilingualForSpeech(displayText);

                if (!displayText && !(statusPanel || innerMonologue)) continue;

                const aiMsg = pushChatMessage({
                    sessionId: session.id, role: "assistant",
                    content: displayText,
                    statusPanel: statusPanel || undefined,
                    // 自定义状态栏渲染戳：不盖的话 custom 模式下 [状态栏] 原文按 markdown 渲染
                    statusRegionMode: statusPanel && isCustomStatusRegionActive(getStatusRegionConfig(session.id))
                        ? ("custom" as const)
                        : undefined,
                    innerMonologue: innerMonologue || undefined,
                    stateValues: stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues,
                    senderCharacterId: r.characterId,
                    senderName: r.characterName,
                });
                messagesRef.current = [...messagesRef.current, aiMsg];

                setSubtitles(prev => [...prev, {
                    id: aiMsg.id, role: "assistant",
                    text: displayText,
                    senderName: r.characterName,
                    senderCharacterId: r.characterId,
                }]);

                // TTS with this character's own voice config
                setCallState("AI_SPEAKING");
                setSpeakingCharId(r.characterId);
                const voiceConfig = resolveVoiceConfig(r.characterId);
                if (voiceConfig && speechText.trim()) {
                    try {
                        const audioBlob = await synthesizeSpeech(speechText, voiceConfig);
                        if (stateRef.current === "ENDED") return;
                        if (audioBlob) {
                            const { promise, abort } = playCallAudio(audioBlob);
                            audioAbortRef.current = abort;
                            await promise;
                            audioAbortRef.current = null;
                        }
                    } catch (e) {
                        console.warn("[GroupCall] TTS failed:", e);
                    }
                }
                setSpeakingCharId(null);
            }

            if (stateRef.current !== "ENDED") setCallState("IDLE");
        } catch (error: any) {
            console.error("[GroupCall] Error:", error);
            if (stateRef.current !== "ENDED") {
                setSubtitles(prev => [...prev, {
                    id: `err-${Date.now()}`, role: "assistant",
                    text: `⚠️ ${error?.message || "发送失败"}`,
                }]);
                setCallState("IDLE");
            }
        }
    }, [isVideo, session, playCallAudio]);

    // ── Auto-listen ──────────────────────────────────
    const startListening = useCallback(() => {
        if (holdToTalk) return; // 按住说话模式不用 Web Speech 自动监听
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        setInterimText("");
        interimTextRef.current = "";

        const stt = createSTTSession({
            onInterim: (text) => {
                setInterimText(text);
                interimTextRef.current = text;
                if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
            },
            onFinal: (text) => {
                sttRef.current = null;
                if (text.trim()) runConversationTurn(text.trim());
                else { setInterimText(""); setCallState("IDLE"); }
            },
            onError: (error) => {
                console.warn("[GroupCall] STT error:", error);
                sttRef.current = null;
                setInterimText("");
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") setCallState("IDLE");
            },
            onNoSpeech: () => {
                sttRef.current = null;
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
    }, [androidTextInputOnly, holdToTalk, runConversationTurn, characters]);

    useEffect(() => {
        if (holdToTalk) return; // 按住说话模式无自动监听
        if (inputMode === "text" && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
            setInterimText("");
        }
        if (!androidTextInputOnly && inputMode === "voice" && callState === "IDLE" && !isMuted) {
            const timer = setTimeout(() => {
                if (stateRef.current === "IDLE") startListening();
            }, 500);
            return () => clearTimeout(timer);
        }
        if (isMuted && sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
    }, [androidTextInputOnly, holdToTalk, callState, isMuted, inputMode, startListening]);

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

    // 按住说话（非 iOS）：按下录音，松开转写后走对话轮。群聊无单角色绑定，
    // 识别配置取第一个可用的 OpenAI 兼容语音配置。
    const holdInput = useHoldToTalk({
        canStart: () => stateRef.current === "IDLE",
        onRecordingStart: () => {
            setInterimText("");
            if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
        },
        onTranscribeStart: () => {
            if (stateRef.current === "USER_SPEAKING") setCallState("PROCESSING");
        },
        onTranscript: (text) => { void runConversationTurn(text); },
        onError: (message) => {
            setSubtitles(prev => [...prev, { id: `stt-err-${Date.now()}`, role: "assistant", text: `⚠️ ${message}` }]);
            if (stateRef.current === "USER_SPEAKING" || stateRef.current === "PROCESSING") {
                setCallState("IDLE");
            }
        },
    });

    // ── Hangup ──────────────────────────────────────
    const handleHangup = useCallback(() => {
        setCallState("ENDED");
        if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
        if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
        if (window.speechSynthesis) window.speechSynthesis.cancel();

        pushChatMessage({
            sessionId: session.id, role: "user",
            content: `[我挂断了群${callTypeLabel}](时长 ${formatTime(callDuration)})`,
        });

        setTimeout(() => onEnd(), 1500);
    }, [session.id, callDuration, onEnd, callTypeLabel]);

    // 通话音频会话 + 卸载兜底：不经挂断键退出时释放识别与在途播放，
    // 防止识别自动重启循环在后台无限自我重启、麦克风永不归还（详见 voice-call-screen）。
    useEffect(() => {
        setCallAudioSessionActive(true);
        return () => {
            stateRef.current = "ENDED";
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
            setCallAudioSessionActive(false);
        };
    }, []);

    // ── Control buttons (shared between voice and video) ──
    const renderTextInputPanel = (floating = false) => {
        if (inputMode !== "text" || callState === "CONNECTING" || callState === "ENDED") return null;
        return (
            <form
                className={`call-text-input-panel ${floating ? "videocall-text-input-panel gcall-video-text-input-panel" : "voicecall-text-input-panel gcall-text-input-panel"}`}
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
        );
    };

    const renderControls = () => {
        if (callState !== "ENDED" && callState !== "CONNECTING") {
            if (holdToTalk) {
                return (
                    <>
                        {/* 输入方式切换（按住说话模式不需要持续开麦，静音位改放 Aa 切换） */}
                        <button
                            onClick={handleInputModeToggle}
                            className={`ui-call-btn ${isVideo ? "ui-call-btn-sm" : ""} ui-call-btn-muted`}
                            aria-label={inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                        >
                            {inputMode === "voice" ? (
                                <span className="ui-call-input-text-icon">Aa</span>
                            ) : (
                                <svg width={isVideo ? 22 : 24} height={isVideo ? 22 : 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                    <line x1="12" y1="19" x2="12" y2="22" />
                                </svg>
                            )}
                        </button>

                        {/* 按住说话主按钮（文字模式下点按切回语音） */}
                        <button
                            className={`ui-call-mic ${isVideo ? "" : "ui-call-mic-lg"}`}
                            style={{ touchAction: "none" }}
                            data-state={
                                inputMode === "text" ? "text"
                                    : holdInput.recState === "recording" ? "speaking"
                                    : callState === "IDLE" ? "idle"
                                    : "busy"
                            }
                            aria-label={inputMode === "text" ? "切换到语音输入" : "按住说话"}
                            title={inputMode === "text" ? "切换到语音输入" : "按住说话"}
                            {...(inputMode === "voice" ? holdInput.pressHandlers : { onClick: handleInputModeToggle })}
                        >
                            {inputMode === "text" ? (
                                <span className="ui-call-input-text-icon">Aa</span>
                            ) : (
                                <svg width={isVideo ? 28 : 32} height={isVideo ? 28 : 32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                    <line x1="12" y1="19" x2="12" y2="22" />
                                </svg>
                            )}
                        </button>

                        <button onClick={handleHangup} className={`ui-call-btn ${isVideo ? "ui-call-btn-sm" : ""} ui-call-btn-danger`} aria-label="挂断">
                            <svg width={isVideo ? 22 : 24} height={isVideo ? 22 : 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                    </>
                );
            }
            if (androidTextInputOnly) {
                return (
                    <button onClick={handleHangup} className={`ui-call-btn ${isVideo ? "ui-call-btn-sm" : ""} ui-call-btn-danger`} aria-label="挂断">
                        <svg width={isVideo ? 22 : 24} height={isVideo ? 22 : 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                            <line x1="23" y1="1" x2="1" y2="23" />
                        </svg>
                    </button>
                );
            }

            return (
                <>
                    <button
                        onClick={() => setIsMuted(!isMuted)}
                        className={`ui-call-btn ${isVideo ? "ui-call-btn-sm" : ""} ui-call-btn-muted`}
                        {...(isMuted ? { "data-checked": "" } : {})}
                    >
                        {isMuted ? (
                            <svg width={isVideo ? 22 : 24} height={isVideo ? 22 : 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="1" y1="1" x2="23" y2="23" />
                                <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.15" />
                                <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                            </svg>
                        ) : (
                            <svg width={isVideo ? 22 : 24} height={isVideo ? 22 : 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" y1="19" x2="12" y2="22" />
                            </svg>
                        )}
                    </button>

                    <button
                        onClick={handleInputModeToggle}
                        className={`ui-call-mic ${isVideo ? "" : "ui-call-mic-lg"}`}
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
                            <svg width={isVideo ? 28 : 32} height={isVideo ? 28 : 32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" y1="19" x2="12" y2="22" />
                            </svg>
                        )}
                    </button>

                    <button onClick={handleHangup} className={`ui-call-btn ${isVideo ? "ui-call-btn-sm" : ""} ui-call-btn-danger`}>
                        <svg width={isVideo ? 22 : 24} height={isVideo ? 22 : 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                            <line x1="23" y1="1" x2="1" y2="23" />
                        </svg>
                    </button>
                </>
            );
        }
        if (callState === "CONNECTING" && initiator === "character") {
            return (
                <>
                    <button
                        onClick={() => {
                            pushChatMessage({
                                sessionId: session.id, role: "user",
                                content: `[我拒绝了群${callTypeLabel}]`,
                            });
                            onEnd();
                        }}
                        className="ui-call-btn ui-call-btn-danger"
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                            <line x1="23" y1="1" x2="1" y2="23" />
                        </svg>
                    </button>
                    <button onClick={() => setCallState("IDLE")} className="ui-call-btn ui-call-btn-success">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                        </svg>
                    </button>
                </>
            );
        }
        if (callState === "CONNECTING") {
            return (
                <button
                    onClick={() => {
                        pushChatMessage({
                            sessionId: session.id, role: "user",
                            content: `[我取消了群${callTypeLabel}]`,
                        });
                        onEnd();
                    }}
                    className="ui-call-btn ui-call-btn-danger"
                >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                        <line x1="23" y1="1" x2="1" y2="23" />
                    </svg>
                </button>
            );
        }
        return <div className="ts-14 opacity-70">通话已结束</div>;
    };

    // ── VIDEO MODE RENDER ───────────────────────────
    if (isVideo) {
        // Grid: participants + self-cam — auto layout to fit screen
        const totalSlots = characters.length + 1; // +1 for self
        // Decide columns: 1 col for ≤2, 2 cols for ≤6, 3 cols for more
        const cols = totalSlots <= 2 ? 1 : totalSlots <= 6 ? 2 : 3;

        return (
            <div className="gcall-video-root voicecall-controls call-keyboard-shift" style={keyboardOffsetStyle}>
                <CallVolumeControl />
                {/* Video grid */}
                <div
                    className="flex-1 min-h-0 grid gap-[2px] overflow-hidden"
                    data-cols={cols}
                >
                    {/* Each character's video tile */}
                    {characters.map(char => {
                        const isSpeaking = speakingCharId === char.id;
                        const tileBg = resolvedBgs[char.id];
                        return (
                            <div key={char.id} className="gcall-video-tile"
                                style={tileBg ? { backgroundImage: `url(${tileBg})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
                            >
                                {!tileBg && (char.avatar ? (
                                    <img
                                        src={char.avatar}
                                        alt={char.name}
                                        className={`w-full h-full object-cover transition-opacity duration-300 ${callState === "CONNECTING" ? "gcall-video-avatar-dim" : "gcall-video-avatar-bright"}`}
                                    />
                                ) : (
                                    <div className="gcall-video-tile-fallback">
                                        <span className="ts-40 opacity-60">{char.name?.[0] || "?"}</span>
                                    </div>
                                ))}
                                <div className="gcall-video-tile-name videocall-name">{char.name}</div>
                                {isSpeaking && <div className="gcall-video-speaking-ring" />}
                            </div>
                        );
                    })}

                    {/* Self-cam tile */}
                    <div className="gcall-video-tile-self"
                        style={resolvedBgs["self"] ? { backgroundImage: `url(${resolvedBgs["self"]})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
                    >
                        {!resolvedBgs["self"] && (userAvatarRef.current ? (
                            <img
                                src={userAvatarRef.current}
                                alt={userNameRef.current}
                                className="w-full h-full object-cover"
                            />
                        ) : (
                            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity={0.5}>
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                <circle cx="12" cy="7" r="4" />
                            </svg>
                        ))}
                        <div className="gcall-video-tile-name videocall-name">{userNameRef.current}</div>
                    </div>
                </div>

                {/* Top info overlay */}
                <div className="absolute top-0 left-0 right-0 z-10 gcall-topbar gcall-topbar-video">
                    <div className="gcall-topbar-title videocall-name">
                        群{callTypeLabel} ({characters.length + 1}人)
                    </div>
                    <div
                        className="gcall-topbar-sub videocall-name"
                        {...(callState === "CONNECTING" || callState === "PROCESSING" ? { "data-anim": "" } : {})}
                    >
                        {callState !== "CONNECTING" && callState !== "ENDED" ? `${formatTime(callDuration)} · ` : ""}
                        {stateLabel()}
                    </div>
                </div>

                {/* Subtitle overlay at bottom */}
                <div className="call-subtitles-log call-subtitles-log-video" ref={subtitleScrollRef}>
                    {subtitles.map((sub) => (
                        <div
                            key={sub.id}
                            className="call-subtitle"
                            data-role={sub.role}
                        >
                            {sub.senderName && <div className="call-subtitle-sender">{sub.senderName}</div>}
                            <BilingualTextBlock text={sub.text} mode="plain" className="call-subtitle-bilingual" defaultExpanded={session.collapseBilingualTranslation !== false ? false : true} />
                        </div>
                    ))}
                    {interimText && callState === "USER_SPEAKING" && (
                        <div className="call-subtitle" data-interim="">{interimText}</div>
                    )}
                </div>

                {renderTextInputPanel(true)}

                {/* Bottom controls with gradient */}
                <div className="videocall-controls-gradient">
                    {renderControls()}
                </div>
            </div>
        );
    }

    // ── VOICE MODE RENDER ───────────────────────────
    return (
        <div className="gcall-root call-bg-default call-keyboard-shift"
            {...(inputMode === "text" && callState !== "CONNECTING" && callState !== "ENDED" ? { "data-text-input": "" } : {})}
            style={voiceBgResolved ? { ...keyboardOffsetStyle, background: `url(${voiceBgResolved}) center/cover no-repeat` } : keyboardOffsetStyle}
        >
            <div className="call-overlay" {...(voiceBgResolved ? { "data-has-image": "" } : {})} />

            <CallVolumeControl />

            <div className="gcall-body voicecall-controls">
                {/* Top bar */}
                <div className="gcall-topbar">
                    <div className="gcall-topbar-title">群语音通话 ({characters.length + 1}人)</div>
                    <div
                        className="gcall-topbar-sub"
                        {...(callState === "CONNECTING" || callState === "PROCESSING" ? { "data-anim": "" } : {})}
                    >
                        {callState !== "CONNECTING" && callState !== "ENDED" ? `${formatTime(callDuration)} · ` : ""}
                        {stateLabel()}
                    </div>
                </div>

                {/* Participant grid */}
                <div className="gcall-grid">
                    {characters.map(char => {
                        const isSpeaking = speakingCharId === char.id;
                        return (
                            <div key={char.id} className="gcall-tile" {...(isSpeaking ? { "data-speaking": "" } : {})}>
                                <div className="gcall-tile-avatar">
                                    {char.avatar ? (
                                        <img src={char.avatar} alt={char.name} />
                                    ) : (
                                        <span className="gcall-tile-initial">{char.name?.[0] || "?"}</span>
                                    )}
                                </div>
                                <div className="gcall-tile-name">{char.name}</div>
                                <div className="gcall-wave-bars">
                                    <div className="gcall-wave-bar" />
                                    <div className="gcall-wave-bar" />
                                    <div className="gcall-wave-bar" />
                                </div>
                            </div>
                        );
                    })}

                    {/* User self tile */}
                    <div
                        className="gcall-tile"
                        {...(callState === "USER_SPEAKING" ? { "data-speaking": "" } : {})}
                    >
                        <div className="gcall-tile-avatar">
                            {userAvatarRef.current ? (
                                <img src={userAvatarRef.current} alt={userNameRef.current} />
                            ) : (
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity={0.5}>
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                    <circle cx="12" cy="7" r="4" />
                                </svg>
                            )}
                        </div>
                        <div className="gcall-tile-name">{userNameRef.current}</div>
                        <div className="gcall-wave-bars">
                            <div className="gcall-wave-bar" />
                            <div className="gcall-wave-bar" />
                            <div className="gcall-wave-bar" />
                        </div>
                    </div>
                </div>

                {/* Subtitle overlay */}
                <div className="gcall-subtitle-overlay" ref={subtitleScrollRef}>
                    <div className="gcall-subtitle-spacer" aria-hidden="true" />
                    {subtitles.map((sub) => (
                        <div key={sub.id} className="gcall-subtitle-bubble" data-role={sub.role}>
                            {sub.senderName && <div className="gcall-subtitle-sender">{sub.senderName}</div>}
                            <BilingualTextBlock text={sub.text} mode="plain" className="call-subtitle-bilingual" defaultExpanded={session.collapseBilingualTranslation !== false ? false : true} />
                        </div>
                    ))}
                    {interimText && callState === "USER_SPEAKING" && (
                        <div className="gcall-subtitle-bubble" data-interim="">{interimText}</div>
                    )}
                </div>

                {renderTextInputPanel(false)}

                {/* Controls bar */}
                <div className="gcall-controls-bar">
                    {renderControls()}
                </div>
            </div>

            {/* Connecting ring animation */}
            {callState === "CONNECTING" && (
                <div className="gcall-connecting-ring">
                    <div className="gcall-ring-circle" />
                    <div className="gcall-ring-circle gcall-ring-circle-delay" />
                </div>
            )}
        </div>
    );
}
