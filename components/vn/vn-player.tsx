"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Clock, EyeOff, Play, Pause, Volume2, Eye, ChevronDown, Send, MessageSquare, BookOpen, Archive, MapPin, RotateCcw, ListOrdered, Plus, Trash2, ChevronRight, Loader2 } from "lucide-react";
import { BilingualTextBlock } from "@/components/chat/message-bubble";
import {
  createOrGetVnSession,
  loadVnMessages,
  loadVnMessagesForChapter,
  pushVnMessage,
  updateChapterStartMessageId,
  archiveChapter,
  updateChapterSummary,
  deleteVnMessage,
  deleteVnMessagesFrom,
  editVnMessage,
  updateVnMessageFrameAudio,
  updateChapterBeats,
  setActiveBeatIndex,
  loadVnConfig,
} from "@/lib/vn-storage";
import type { VnFrameAudio, VnMessage } from "@/lib/vn-types";
import { generateVnCompletion, summarizeVnChapter } from "@/lib/vn-engine";
import { parseVnResponse, packageUserInput, packageMultiActions } from "@/lib/vn-parser";
import { resolveVnAssetMap, loadVnScenes, getVnSceneLayout, getVnSpriteLayout } from "@/lib/vn-asset-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { VnFrame, VnOptions, VnBeat } from "@/lib/vn-types";
import { splitBilingualText } from "@/lib/bilingual-text";
import { playAudioBlobViaMediaElement, resolveVoiceConfig, synthesizeSpeech, unlockAudioPlayback } from "@/lib/tts-service";

interface VnPlayerProps {
  characterId: string;
  chapterIndex: number;
  onClose: () => void;
  onChapterEnd: () => void;
  vnTheme?: string;
}

type AssetLoadStatus = "ready" | "failed";

function tagFramesWithMessage(frames: VnFrame[], message: VnMessage): VnFrame[] {
  return frames.map((frame, index) => ({
    ...frame,
    sourceMessageId: message.id,
    sourceFrameIndex: index,
    sourceRole: message.role,
    sourceCreatedAt: message.createdAt,
    voiceAudio: message.frameAudio?.[index],
  }));
}

function buildFramesFromMessages(messages: VnMessage[]): { frames: VnFrame[]; lastOptions: VnOptions | null } {
  const frames: VnFrame[] = [];
  let lastOptions: VnOptions | null = null;
  for (const message of messages) {
    const parsed = parseVnResponse(message.rawContent);
    frames.push(...tagFramesWithMessage(parsed.frames, message));
    if (message.role === "assistant") lastOptions = parsed.options;
  }
  return { frames, lastOptions };
}

function getFrameVoiceKey(frame: VnFrame | null | undefined): string | null {
  if (!frame?.sourceMessageId || frame.sourceFrameIndex == null) return null;
  return `${frame.sourceMessageId}:${frame.sourceFrameIndex}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("音频转换失败"));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export function VnPlayer({ characterId, chapterIndex, onClose, onChapterEnd, vnTheme }: VnPlayerProps) {
  const [allFrames, setAllFrames] = useState<VnFrame[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [currentScene, setCurrentScene] = useState("");
  const [currentSprite, setCurrentSprite] = useState("");
  const [hideDialogue, setHideDialogue] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [currentOptions, setCurrentOptions] = useState<VnOptions | null>(null);
  const [inputText, setInputText] = useState("");
  const [inputMode, setInputMode] = useState<"dialogue" | "narration">("dialogue");
  const [pendingActions, setPendingActions] = useState<{ type: "dialogue" | "narration" | "scene_switch"; text: string }[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [showScenePicker, setShowScenePicker] = useState(false);
  const [showReplayConfirm, setShowReplayConfirm] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayFrames, setReplayFrames] = useState<VnFrame[]>([]);
  const [replayIdx, setReplayIdx] = useState(0);
  const [assetMap, setAssetMap] = useState<Record<string, string>>({});
  const [assetLoadStatus, setAssetLoadStatus] = useState<Record<string, AssetLoadStatus>>({});
  const [renderedScene, setRenderedScene] = useState("");
  const [assetsReady, setAssetsReady] = useState(false);
  const [showBeatsPanel, setShowBeatsPanel] = useState(false);
  const [bilingualTranslationEnabled, setBilingualTranslationEnabled] = useState(() => loadVnConfig("bilingualTranslationEnabled") !== "0");
  const [collapseBilingualTranslation, setCollapseBilingualTranslation] = useState(() => loadVnConfig("collapseBilingualTranslation") !== "0");
  const [editingBeatTitle, setEditingBeatTitle] = useState("");
  const [editingBeatDesc, setEditingBeatDesc] = useState("");
  const [, forceUpdate] = useState(0);
  const [ctxMenuMsgId, setCtxMenuMsgId] = useState<string | null>(null);
  const [ctxMenuY, setCtxMenuY] = useState(0);
  const [ctxMenuX, setCtxMenuX] = useState(0);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [voiceAutoEnabled, setVoiceAutoEnabled] = useState(false);
  const [voiceBusyKey, setVoiceBusyKey] = useState<string | null>(null);
  const [voicePlayingKey, setVoicePlayingKey] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const typingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isGeneratingRef = useRef(false);
  const mountedRef = useRef(true);
  const imageLoadingRef = useRef<Set<string>>(new Set());
  const voiceEnabledAtRef = useRef(Number.POSITIVE_INFINITY);
  const autoVoicePlayedKeysRef = useRef<Set<string>>(new Set());
  const currentVoiceFrameKeyRef = useRef<string | null>(null);
  const activeVoicePlaybackRef = useRef<{ key: string; abort: () => void } | null>(null);
  const frame = allFrames[frameIdx] || null;
  const defaultTranslationExpanded = collapseBilingualTranslation ? false : true;

  const session = createOrGetVnSession(characterId);
  const isArchived = session.chapters[chapterIndex]?.archived ?? false;

  const userName = useMemo(() => resolveUserIdentity(characterId, "vn")?.name ?? "我", [characterId]);
  const availableScenes = useMemo(() => loadVnScenes(characterId), [characterId]);
  const sceneAssetNames = useMemo(() => new Set(availableScenes.map((scene) => scene.name)), [availableScenes]);
  const getTypingSourceText = useCallback((nextFrame: VnFrame | null | undefined) => {
    if (!nextFrame?.speaker || !bilingualTranslationEnabled) return nextFrame?.text || "";
    return splitBilingualText(nextFrame.text)?.original || nextFrame.text;
  }, [bilingualTranslationEnabled]);

  const applyFrameAudioToState = useCallback((messageId: string, frameIndex: number, audio: VnFrameAudio) => {
    const patch = (targetFrame: VnFrame) => (
      targetFrame.sourceMessageId === messageId && targetFrame.sourceFrameIndex === frameIndex
        ? { ...targetFrame, voiceAudio: audio }
        : targetFrame
    );
    setAllFrames((prev) => prev.map(patch));
    setReplayFrames((prev) => prev.map(patch));
  }, []);

  const playVoiceBlob = useCallback(async (key: string, blob: Blob) => {
    activeVoicePlaybackRef.current?.abort();
    // Media-element path: VN auto-voice plays with no user gesture nearby, where
    // resuming a suspended AudioContext is often rejected (notably on Android
    // unless a keep-alive audio happened to hold the session open).
    const playback = playAudioBlobViaMediaElement(blob);
    activeVoicePlaybackRef.current = { key, abort: playback.abort };
    setVoicePlayingKey(key);
    try {
      await playback.promise;
    } finally {
      if (activeVoicePlaybackRef.current?.key === key) activeVoicePlaybackRef.current = null;
      setVoicePlayingKey((current) => current === key ? null : current);
    }
  }, []);

  const synthesizeFrameVoice = useCallback(async (
    targetFrame: VnFrame,
    options?: { play?: boolean; alertOnMissingConfig?: boolean; auto?: boolean },
  ) => {
    const key = getFrameVoiceKey(targetFrame);
    // 无 speaker = 旁白帧，只读不配音
    if (!key || !targetFrame.speaker || targetFrame.sourceRole !== "assistant" || !targetFrame.text.trim()) return;
    const messageId = targetFrame.sourceMessageId;
    const frameIndex = targetFrame.sourceFrameIndex;
    if (!messageId || frameIndex == null) return;

    const speechText = getTypingSourceText(targetFrame).trim();
    if (!speechText) return;

    const cached = targetFrame.voiceAudio;
    if (cached?.audioDataUrl && cached.synthesizedFromText === speechText) {
      if (options?.play) {
        const blob = await dataUrlToBlob(cached.audioDataUrl);
        await playVoiceBlob(key, blob);
      }
      return;
    }

    const voiceConfig = resolveVoiceConfig(characterId, "vn");
    if (!voiceConfig || !voiceConfig.enableTTS) {
      if (options?.alertOnMissingConfig) {
        alert("请先在设置 - 绑定中为漫卷配置并启用语音 API。");
      }
      return;
    }

    setVoiceBusyKey(key);
    try {
      const blob = await synthesizeSpeech(speechText, voiceConfig);
      if (!blob) return;
      const audioDataUrl = await blobToDataUrl(blob);
      const audio: VnFrameAudio = {
        audioDataUrl,
        synthesizedFromText: speechText,
        updatedAt: new Date().toISOString(),
      };
      updateVnMessageFrameAudio(messageId, frameIndex, audio);
      applyFrameAudioToState(messageId, frameIndex, audio);
      if (options?.play) {
        if (!options.auto || currentVoiceFrameKeyRef.current === key) {
          await playVoiceBlob(key, blob);
        }
      }
    } catch (error) {
      console.warn("[VN] voice synthesis failed:", error);
      if (options?.alertOnMissingConfig) {
        const msg = error instanceof Error ? error.message : String(error || "未知错误");
        alert(`语音合成失败: ${msg}`);
      }
    } finally {
      setVoiceBusyKey((current) => current === key ? null : current);
    }
  }, [applyFrameAudioToState, characterId, getTypingSourceText, playVoiceBlob]);

  const handleVoiceToggle = useCallback(() => {
    unlockAudioPlayback();
    setVoiceAutoEnabled((enabled) => {
      const next = !enabled;
      if (next) {
        voiceEnabledAtRef.current = Date.now();
        autoVoicePlayedKeysRef.current.clear();
      } else {
        voiceEnabledAtRef.current = Number.POSITIVE_INFINITY;
        activeVoicePlaybackRef.current?.abort();
        activeVoicePlaybackRef.current = null;
        setVoicePlayingKey(null);
      }
      return next;
    });
  }, []);

  // ── Load existing messages and build frames ──
  useLayoutEffect(() => {
    setAssetsReady(false);
    const messages = loadVnMessagesForChapter(session.id, chapterIndex);
    const { frames, lastOptions } = buildFramesFromMessages(messages);
    setAllFrames(frames);
    if (frames.length > 0) {
      // Find last frame with text (skip empty scene-switch frames)
      let displayIdx = frames.length - 1;
      while (displayIdx > 0 && !frames[displayIdx].text) displayIdx--;

      setFrameIdx(displayIdx);
      setDisplayedText(frames[displayIdx].text);

      // Scan backwards for latest bg/sprite
      let bg = "";
      let sprite = "";
      for (let i = frames.length - 1; i >= 0; i--) {
        if (!bg && frames[i].bg) bg = frames[i].bg!;
        if (!sprite && frames[i].sprite) sprite = frames[i].sprite!;
        if (bg && sprite) break;
      }
      if (bg) setCurrentScene(bg);
      if (sprite) setCurrentSprite(sprite);

      // Show last text frame in dialogue box; user clicks to advance into input mode
      setWaitingForInput(false);
      setCurrentOptions(lastOptions);
    } else {
      setWaitingForInput(true);
    }

    // Resolve assets
    const allBgs = new Set<string>();
    const allSprites = new Set<string>();
    for (const f of frames) {
      if (f.bg) allBgs.add(f.bg);
      if (f.sprite) allSprites.add(f.sprite);
    }
    for (const scene of availableScenes) {
      if (scene.name) allBgs.add(scene.name);
    }
    if (allBgs.size === 0 && allSprites.size === 0) setAssetsReady(true);
    let cancelled = false;
    Promise.all([
      resolveVnAssetMap([...allBgs], "scene", characterId),
      resolveVnAssetMap([...allSprites], "sprite", characterId),
    ]).then(([sceneMap, spriteMap]) => {
      if (cancelled) return;
      setAssetMap((prev) => ({ ...prev, ...sceneMap, ...spriteMap }));
      setAssetsReady(true);
    });
    return () => { cancelled = true; };
  }, [session.id, chapterIndex, availableScenes, characterId]);

  // ── Resolve asset name to CSS background ──
  const resolveSceneBg = useCallback((name: string | undefined, useImage = true): React.CSSProperties => {
    if (!name) return {};
    if (assetMap[name] && useImage) {
      return {
        backgroundImage: `url(${assetMap[name]})`,
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
      };
    }
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    const h = (hash >>> 0) % 360;
    return { backgroundImage: `linear-gradient(180deg, hsl(${h}, 25%, 20%) 0%, hsl(${h}, 30%, 8%) 100%)` };
  }, [assetMap]);

  const resolveSpriteBg = useCallback((name: string | undefined): React.CSSProperties => {
    if (!name) return {};
    if (assetMap[name]) return { backgroundImage: `url(${assetMap[name]})` };
    return {};
  }, [assetMap]);

  // ── Typewriter ──
  const startTyping = useCallback((text: string) => {
    setDisplayedText("");
    setIsTyping(true);
    let i = 0;
    const tick = () => {
      if (i < text.length) {
        setDisplayedText(text.slice(0, i + 1));
        i++;
        typingRef.current = setTimeout(tick, 40);
      } else {
        setIsTyping(false);
      }
    };
    tick();
  }, []);

  const skipTyping = useCallback(() => {
    if (typingRef.current) clearTimeout(typingRef.current);
    typingRef.current = null;
    if (frame) {
      setDisplayedText(frame.text);
      setIsTyping(false);
    }
  }, [frame]);

  // ── Frame Navigation ──
  const goToFrame = useCallback((idx: number) => {
    if (idx >= allFrames.length) {
      // If generating, stay on last frame (don't show input)
      if (!isArchived && !isGeneratingRef.current) setWaitingForInput(true);
      return;
    }
    const next = allFrames[idx];
    if (next.bg && next.bg !== currentScene) {
      setCurrentScene(next.bg);
    }
    if (next.sprite && next.sprite !== currentSprite) {
      setCurrentSprite(next.sprite);
    }
    setFrameIdx(idx);
    // Skip empty frames (shouldn't normally appear)
    if (!next.text) {
      if (idx + 1 < allFrames.length) {
        // Process next frame on next tick to avoid stack overflow
        requestAnimationFrame(() => goToFrame(idx + 1));
      } else {
        setWaitingForInput(true);
      }
      return;
    }
    startTyping(getTypingSourceText(next));
  }, [allFrames, currentScene, currentSprite, startTyping, isArchived, getTypingSourceText]);

  const advance = useCallback(() => {
    if (showArchiveConfirm || waitingForInput) return;
    if (isTyping) {
      skipTyping();
    } else {
      goToFrame(frameIdx + 1);
    }
  }, [isTyping, skipTyping, goToFrame, frameIdx, showArchiveConfirm, waitingForInput]);

  // ── Replay advance ──
  const replayFrame = isReplaying ? replayFrames[replayIdx] : null;

  const advanceReplay = useCallback(() => {
    if (!isReplaying) return;
    if (isTyping) {
      if (typingRef.current) clearTimeout(typingRef.current);
      typingRef.current = null;
      setDisplayedText(getTypingSourceText(replayFrames[replayIdx]));
      setIsTyping(false);
      return;
    }
    // Find next frame with text
    let nextIdx = replayIdx + 1;
    while (nextIdx < replayFrames.length && !replayFrames[nextIdx].text) {
      const f = replayFrames[nextIdx];
      if (f.bg) setCurrentScene(f.bg);
      if (f.sprite) setCurrentSprite(f.sprite);
      nextIdx++;
    }
    if (nextIdx >= replayFrames.length) {
      // Replay done — exit, restore normal state
      setIsReplaying(false);
      setReplayFrames([]);
      setReplayIdx(0);
      // Restore to last text frame of allFrames
      let lastIdx = allFrames.length - 1;
      while (lastIdx > 0 && !allFrames[lastIdx].text) lastIdx--;
      setFrameIdx(lastIdx);
      setDisplayedText(getTypingSourceText(allFrames[lastIdx]));
      // Restore bg/sprite
      let bg = "", sp = "";
      for (let i = allFrames.length - 1; i >= 0; i--) {
        if (!bg && allFrames[i].bg) bg = allFrames[i].bg!;
        if (!sp && allFrames[i].sprite) sp = allFrames[i].sprite!;
        if (bg && sp) break;
      }
      if (bg) setCurrentScene(bg);
      if (sp) setCurrentSprite(sp);
      setWaitingForInput(false);
      return;
    }
    const next = replayFrames[nextIdx];
    if (next.bg) setCurrentScene(next.bg);
    if (next.sprite) setCurrentSprite(next.sprite);
    setReplayIdx(nextIdx);
    startTyping(getTypingSourceText(next));
  }, [isReplaying, replayFrames, replayIdx, isTyping, allFrames, startTyping, getTypingSourceText]);

  // Track mounted state for async image decode callbacks.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      imageLoadingRef.current.clear();
      activeVoicePlaybackRef.current?.abort();
      activeVoicePlaybackRef.current = null;
    };
  }, []);

  useEffect(() => {
    currentVoiceFrameKeyRef.current = !isReplaying ? getFrameVoiceKey(frame) : null;
  }, [frame, isReplaying]);

  useEffect(() => {
    if (!voiceAutoEnabled || isReplaying || waitingForInput || !frame) return;
    const key = getFrameVoiceKey(frame);
    if (!key || frame.sourceRole !== "assistant" || !frame.text.trim()) return;
    const createdAt = new Date(frame.sourceCreatedAt || "").getTime();
    if (!Number.isFinite(createdAt) || createdAt < voiceEnabledAtRef.current) return;
    if (autoVoicePlayedKeysRef.current.has(key)) return;
    autoVoicePlayedKeysRef.current.add(key);
    void synthesizeFrameVoice(frame, { play: true, auto: true });
  }, [
    frame,
    frameIdx,
    isReplaying,
    synthesizeFrameVoice,
    voiceAutoEnabled,
    waitingForInput,
  ]);

  // Preload images when assetMap updates, then reveal scenes only after decode.
  useEffect(() => {
    for (const url of Object.values(assetMap)) {
      if (!url || assetLoadStatus[url] || imageLoadingRef.current.has(url)) continue;
      imageLoadingRef.current.add(url);
      const img = new Image();
      const mark = (status: AssetLoadStatus) => {
        imageLoadingRef.current.delete(url);
        if (!mountedRef.current) return;
        setAssetLoadStatus((prev) => prev[url] ? prev : { ...prev, [url]: status });
      };
      img.onload = () => {
        if (typeof img.decode === "function") {
          img.decode().then(() => mark("ready")).catch(() => mark("ready"));
        } else {
          mark("ready");
        }
      };
      img.onerror = () => mark("failed");
      img.src = url;
    }
  }, [assetMap, assetLoadStatus]);

  const currentSceneUrl = currentScene ? assetMap[currentScene] : "";
  const currentSceneAssetStatus = currentSceneUrl ? assetLoadStatus[currentSceneUrl] : undefined;
  const currentSceneHasUploadedAsset = currentScene ? sceneAssetNames.has(currentScene) : false;

  useEffect(() => {
    if (!currentScene) {
      setRenderedScene("");
      return;
    }

    if (currentSceneUrl) {
      if (currentSceneAssetStatus === "ready" || currentSceneAssetStatus === "failed") {
        setRenderedScene(currentScene);
      }
      return;
    }

    if (!currentSceneHasUploadedAsset || assetsReady) {
      setRenderedScene(currentScene);
    }
  }, [assetsReady, currentScene, currentSceneAssetStatus, currentSceneHasUploadedAsset, currentSceneUrl]);

  // Keep ref in sync
  useEffect(() => { isGeneratingRef.current = isGenerating; }, [isGenerating]);

  // ── Auto Mode ──
  useEffect(() => {
    if (autoMode && !isTyping && !showArchiveConfirm && !waitingForInput) {
      autoRef.current = setTimeout(() => advance(), 2000);
    }
    return () => { if (autoRef.current) clearTimeout(autoRef.current); };
  }, [autoMode, isTyping, showArchiveConfirm, waitingForInput, advance]);

  // ── Submit user input ──
  const handleSubmit = useCallback(async (text: string, type: "dialogue" | "narration" | "choice") => {
    if (!text.trim() || isGenerating) return;

    setIsGenerating(true);
    setWaitingForInput(false);
    setCurrentOptions(null);

    // Package and save user message
    const packaged = packageUserInput(text.trim(), type, { speaker: userName });
    const userMsg = pushVnMessage({
      sessionId: session.id,
      role: "user",
      rawContent: packaged,
      chapterIndex,
    });

    // Update start message ID if this is the first message
    updateChapterStartMessageId(session.id, chapterIndex, userMsg.id);

    // Parse user's frames and add to display
    const userParsed = parseVnResponse(packaged);
    const userFrames = tagFramesWithMessage(userParsed.frames, userMsg);
    const newFrames = [...allFrames, ...userFrames];
    setAllFrames(newFrames);

    // Show user's last frame in dialogue box while generating
    if (userFrames.length > 0) {
      const lastUserFrameIdx = newFrames.length - 1;
      setFrameIdx(lastUserFrameIdx);
      const f = newFrames[lastUserFrameIdx];
      if (f.bg) setCurrentScene(f.bg);
      if (f.sprite) setCurrentSprite(f.sprite);
      setDisplayedText(getTypingSourceText(f));
    }

    try {
      // Get all messages in session (cross-chapter context)
      const allMessages = loadVnMessages(session.id);
      const result = await generateVnCompletion(characterId, allMessages);

      // Save AI response
      const aiMsg = pushVnMessage({
        sessionId: session.id,
        role: "assistant",
        rawContent: result.rawText,
        chapterIndex,
      });

      // Update start message ID if needed
      updateChapterStartMessageId(session.id, chapterIndex, aiMsg.id);

      // Add AI frames
      const aiFrames = tagFramesWithMessage(result.frames, aiMsg);
      const updatedFrames = [...newFrames, ...aiFrames];
      setAllFrames(updatedFrames);
      setCurrentOptions(result.options);

      // Resolve any new assets
      const newBgs = new Set<string>();
      const newSprites = new Set<string>();
      for (const f of aiFrames) {
        if (f.bg && !assetMap[f.bg]) newBgs.add(f.bg);
        if (f.sprite && !assetMap[f.sprite]) newSprites.add(f.sprite);
      }
      if (newBgs.size > 0 || newSprites.size > 0) {
        const [sceneMap, spriteMap] = await Promise.all([
          resolveVnAssetMap([...newBgs], "scene", characterId),
          resolveVnAssetMap([...newSprites], "sprite", characterId),
        ]);
        setAssetMap((prev) => ({ ...prev, ...sceneMap, ...spriteMap }));
      }

      // Start playing AI frames
      const aiStartIdx = newFrames.length;
      if (aiFrames.length > 0) {
        setFrameIdx(aiStartIdx);
        const f = aiFrames[0];
        if (f.bg) setCurrentScene(f.bg);
        if (f.sprite) setCurrentSprite(f.sprite);
        startTyping(getTypingSourceText(f));
      } else {
        setWaitingForInput(true);
      }
    } catch (err) {
      console.error("VN generation error:", err);
      setWaitingForInput(true);
    } finally {
      setIsGenerating(false);
      setInputText("");
    }
  }, [allFrames, assetMap, characterId, chapterIndex, isGenerating, session.id, startTyping, getTypingSourceText, userName]);

  // Add text to pending
  const handleTextSubmit = useCallback(() => {
    if (!inputText.trim()) return;
    setPendingActions((prev) => [...prev, { type: inputMode, text: inputText.trim() }]);
    setInputText("");
  }, [inputText, inputMode]);

  // Choice sends immediately (no accumulation)
  const handleChoiceSelect = useCallback((choice: string) => {
    handleSubmit(choice, "choice");
  }, [handleSubmit]);

  // Scene switch: visual transition + add to pending
  const handleSceneSwitch = useCallback((sceneName: string) => {
    setShowScenePicker(false);
    if (!assetMap[sceneName]) {
      void resolveVnAssetMap([sceneName], "scene", characterId).then((sceneMap) => {
        if (Object.keys(sceneMap).length > 0) {
          setAssetMap((prev) => ({ ...prev, ...sceneMap }));
        }
      });
    }
    if (sceneName !== currentScene) {
      setCurrentScene(sceneName);
    }
    setPendingActions((prev) => [...prev, { type: "scene_switch" as const, text: sceneName }]);
  }, [assetMap, characterId, currentScene]);

  // Remove a pending action
  const handleRemovePending = useCallback((index: number) => {
    setPendingActions((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Send all pending actions as one message
  const handleSendAll = useCallback(async () => {
    if (pendingActions.length === 0 || isGenerating) return;
    const packaged = packageMultiActions(pendingActions, userName);
    setPendingActions([]);
    // Reuse handleSubmit-like logic but with pre-packaged content
    setIsGenerating(true);
    setWaitingForInput(false);
    setCurrentOptions(null);

    const userMsg = pushVnMessage({
      sessionId: session.id,
      role: "user",
      rawContent: packaged,
      chapterIndex,
    });
    updateChapterStartMessageId(session.id, chapterIndex, userMsg.id);

    const userParsed = parseVnResponse(packaged);
    const userTextFrames = tagFramesWithMessage(userParsed.frames, userMsg).filter((f) => f.text);
    const newFrames = [...allFrames, ...userTextFrames];
    setAllFrames(newFrames);

    // Play user frames from first, then hold on last
    if (userTextFrames.length > 0) {
      const firstIdx = allFrames.length;
      setFrameIdx(firstIdx);
      const f = userTextFrames[0];
      if (f.bg) setCurrentScene(f.bg);
      if (f.sprite) setCurrentSprite(f.sprite);
      if (userTextFrames.length === 1) {
        // Single frame — show statically
        setDisplayedText(getTypingSourceText(f));
        setIsTyping(false);
      } else {
        startTyping(getTypingSourceText(f));
      }
    }

    try {
      const allMessages = loadVnMessages(session.id);
      const result = await generateVnCompletion(characterId, allMessages);
      const aiMsg = pushVnMessage({ sessionId: session.id, role: "assistant", rawContent: result.rawText, chapterIndex });
      updateChapterStartMessageId(session.id, chapterIndex, userMsg.id);

      const aiFrames = tagFramesWithMessage(result.frames, aiMsg);
      const updatedFrames = [...newFrames, ...aiFrames];
      setAllFrames(updatedFrames);
      setCurrentOptions(result.options);

      const newBgs = new Set<string>();
      const newSprites = new Set<string>();
      for (const f of aiFrames) {
        if (f.bg && !assetMap[f.bg]) newBgs.add(f.bg);
        if (f.sprite && !assetMap[f.sprite]) newSprites.add(f.sprite);
      }
      if (newBgs.size > 0 || newSprites.size > 0) {
        const [sceneMap, spriteMap] = await Promise.all([
          resolveVnAssetMap([...newBgs], "scene", characterId),
          resolveVnAssetMap([...newSprites], "sprite", characterId),
        ]);
        setAssetMap((prev) => ({ ...prev, ...sceneMap, ...spriteMap }));
      }

      const aiStartIdx = newFrames.length;
      if (aiFrames.length > 0) {
        setFrameIdx(aiStartIdx);
        const f = aiFrames[0];
        if (f.bg) setCurrentScene(f.bg);
        if (f.sprite) setCurrentSprite(f.sprite);
        startTyping(getTypingSourceText(f));
      } else {
        setWaitingForInput(true);
      }
    } catch (err) {
      console.error("VN generation error:", err);
      setWaitingForInput(true);
    } finally {
      setIsGenerating(false);
      setInputText("");
    }
  }, [pendingActions, userName, isGenerating, allFrames, assetMap, characterId, chapterIndex, session.id, startTyping, getTypingSourceText]);

  // ── History message actions ──
  const rebuildFrames = useCallback(() => {
    const msgs = loadVnMessagesForChapter(session.id, chapterIndex);
    const { frames } = buildFramesFromMessages(msgs);
    setAllFrames(frames);
    if (frames.length > 0) {
      let idx = frames.length - 1;
      while (idx > 0 && !frames[idx].text) idx--;
      setFrameIdx(idx);
      setDisplayedText(getTypingSourceText(frames[idx]));
      let bg = "", sp = "";
      for (let i = frames.length - 1; i >= 0; i--) {
        if (!bg && frames[i].bg) bg = frames[i].bg!;
        if (!sp && frames[i].sprite) sp = frames[i].sprite!;
        if (bg && sp) break;
      }
      if (bg) setCurrentScene(bg);
      if (sp) setCurrentSprite(sp);
      setWaitingForInput(false);
    } else {
      setWaitingForInput(true);
    }
  }, [session.id, chapterIndex]);

  const handleMsgDelete = useCallback((msgId: string) => {
    deleteVnMessage(msgId);
    setCtxMenuMsgId(null);
    rebuildFrames();
  }, [rebuildFrames]);

  const handleMsgDeleteFrom = useCallback((msgId: string) => {
    deleteVnMessagesFrom(session.id, msgId);
    setCtxMenuMsgId(null);
    rebuildFrames();
  }, [session.id, rebuildFrames]);

  const handleMsgEditStart = useCallback((msg: VnMessage) => {
    setEditingMsgId(msg.id);
    setEditingContent(msg.rawContent);
    setCtxMenuMsgId(null);
  }, []);

  const handleMsgEditSave = useCallback(() => {
    if (!editingMsgId || !editingContent.trim()) { setEditingMsgId(null); setEditingContent(""); return; }
    editVnMessage(editingMsgId, editingContent.trim());
    setEditingMsgId(null);
    setEditingContent("");
    rebuildFrames();
  }, [editingMsgId, editingContent, rebuildFrames]);

  const handleMsgRetry = useCallback(async (msgId: string) => {
    const msgs = loadVnMessagesForChapter(session.id, chapterIndex);
    const msgIdx = msgs.findIndex((m) => m.id === msgId);
    if (msgIdx === -1 || msgs[msgIdx].role !== "assistant") return;
    deleteVnMessagesFrom(session.id, msgId);
    setCtxMenuMsgId(null);
    setHistoryOpen(false);
    rebuildFrames();
    setIsGenerating(true);
    setWaitingForInput(false);
    try {
      const allMessages = loadVnMessages(session.id);
      const result = await generateVnCompletion(characterId, allMessages);
      const aiMsg = pushVnMessage({ sessionId: session.id, role: "assistant", rawContent: result.rawText, chapterIndex });
      rebuildFrames();
      // Play new AI frames
      const newMsgs = loadVnMessagesForChapter(session.id, chapterIndex);
      const { frames } = buildFramesFromMessages(newMsgs);
      setAllFrames(frames);
      setCurrentOptions(result.options);
      const aiFrames = tagFramesWithMessage(result.frames, aiMsg);
      if (aiFrames.length > 0) {
        const startIdx = frames.length - aiFrames.length;
        setFrameIdx(startIdx);
        const f = aiFrames[0];
        if (f.bg) setCurrentScene(f.bg);
        if (f.sprite) setCurrentSprite(f.sprite);
        startTyping(getTypingSourceText(f));
      }
    } catch (err) {
      console.error("VN retry error:", err);
      setWaitingForInput(true);
    } finally {
      setIsGenerating(false);
    }
  }, [session.id, chapterIndex, characterId, rebuildFrames, startTyping, getTypingSourceText]);

  const longPressYRef = useRef(0);
  const longPressXRef = useRef(0);
  const vnShellRef = useRef<HTMLDivElement>(null);
  const handleMsgLongPressStart = useCallback((msgId: string, x: number, y: number) => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressXRef.current = x;
    longPressYRef.current = y;
    longPressTimer.current = setTimeout(() => { setCtxMenuMsgId(msgId); setCtxMenuX(longPressXRef.current); setCtxMenuY(longPressYRef.current); longPressTimer.current = null; }, 500);
  }, []);

  const handleMsgLongPressEnd = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  // ── Beats ──
  const currentChapter = session.chapters[chapterIndex];
  const beats = currentChapter?.beats ?? [];
  const activeBeatIdx = currentChapter?.activeBeatIndex ?? 0;

  const handleAddBeat = useCallback(() => {
    if (!editingBeatTitle.trim()) return;
    const beat: VnBeat = {
      id: `beat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: editingBeatTitle.trim(),
      description: editingBeatDesc.trim() || undefined,
    };
    const newBeats = [...beats, beat];
    updateChapterBeats(session.id, chapterIndex, newBeats);
    setEditingBeatTitle("");
    setEditingBeatDesc("");
    forceUpdate((n) => n + 1);
  }, [editingBeatTitle, editingBeatDesc, beats, session.id, chapterIndex]);

  const handleDeleteBeat = useCallback((beatId: string) => {
    const newBeats = beats.filter((b) => b.id !== beatId);
    updateChapterBeats(session.id, chapterIndex, newBeats);
    if (activeBeatIdx >= newBeats.length && newBeats.length > 0) {
      setActiveBeatIndex(session.id, chapterIndex, newBeats.length - 1);
    }
    forceUpdate((n) => n + 1);
  }, [beats, session.id, chapterIndex, activeBeatIdx]);

  const handleSetActiveBeat = useCallback((idx: number) => {
    setActiveBeatIndex(session.id, chapterIndex, idx);
    forceUpdate((n) => n + 1);
  }, [session.id, chapterIndex]);

  // ── Derived ──
  const history = allFrames.slice(0, frameIdx + 1);
  const historyMessages = useMemo(() => loadVnMessagesForChapter(session.id, chapterIndex), [session.id, chapterIndex, allFrames.length]); // re-derive when frames change
  const isNarration = !frame?.speaker;
  const renderedSceneUrl = renderedScene ? assetMap[renderedScene] : "";
  const canUseRenderedSceneImage = renderedSceneUrl ? assetLoadStatus[renderedSceneUrl] === "ready" : true;
  const sceneStyle = resolveSceneBg(renderedScene, canUseRenderedSceneImage);
  const spriteStyle = resolveSpriteBg(currentSprite);
  const sceneVisualReady = !currentScene || Boolean(renderedScene);
  const currentDialogueText = frame?.speaker ? (isTyping ? displayedText : frame.text) : displayedText;
  const replayDialogueText = replayFrame?.speaker ? (isTyping ? displayedText : replayFrame.text) : displayedText;
  const renderFrameVoiceButton = (targetFrame: VnFrame | null | undefined) => {
    const key = getFrameVoiceKey(targetFrame);
    // 旁白帧（无 speaker）不提供配音按钮
    if (!targetFrame || !key || !targetFrame.speaker || targetFrame.sourceRole !== "assistant" || !targetFrame.text.trim()) return null;
    const speechText = getTypingSourceText(targetFrame).trim();
    const hasCurrentAudio = Boolean(
      targetFrame.voiceAudio?.audioDataUrl &&
      targetFrame.voiceAudio.synthesizedFromText === speechText,
    );
    const busy = voiceBusyKey === key;
    const playing = voicePlayingKey === key;
    return (
      <button
        type="button"
        className="vn-frame-voice-btn"
        data-ready={hasCurrentAudio ? "true" : undefined}
        data-playing={playing ? "true" : undefined}
        aria-label={hasCurrentAudio ? "播放语音" : "合成语音"}
        title={hasCurrentAudio ? "播放语音" : "合成语音"}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          unlockAudioPlayback();
          void synthesizeFrameVoice(targetFrame, { play: true, alertOnMissingConfig: true });
        }}
      >
        {busy ? <Loader2 className="vn-frame-voice-spin" size={13} /> : <Volume2 size={13} />}
      </button>
    );
  };

  return (
    <div className="vn-shell" ref={vnShellRef} data-vn-theme={vnTheme || "default"} onClick={() => {
      if (historyOpen || showArchiveConfirm || showReplayConfirm || showScenePicker || showBeatsPanel) return;
      if (isReplaying) { advanceReplay(); return; }
      if (waitingForInput && !isArchived) { setWaitingForInput(false); return; }
      if (!hideDialogue) advance();
    }}>
      {/* ── Scene Background ── */}
      {(() => {
        const sl = renderedScene ? getVnSceneLayout(renderedScene) : {};
        const stx = (sl.x ?? 50) - 50;
        const sty = (sl.y ?? 50) - 50;
        const ssc = (sl.scale ?? 100) / 100;
        return (
          <div
            className="vn-scene"
            style={{ ...sceneStyle,
              backgroundPosition: "center center",
              transform: `translate(${stx}%, ${sty}%) scale(${ssc})`,
            }}
          />
        );
      })()}
      {currentScene && !sceneVisualReady && (
        <div className="vn-scene-loading" aria-hidden="true">
          <span>场景加载中</span>
        </div>
      )}

      {/* ── Character Sprite ── */}
      {currentSprite && (() => {
        const spl = getVnSpriteLayout(currentSprite, characterId);
        const tx = (spl.x ?? 50) - 50;   // 50=center, 0=left, 100=right
        const ty = (spl.y ?? 100) - 100;  // 100=bottom, 50=up
        const sc = (spl.scale ?? 100) / 100;
        return (
          <div
            className="vn-sprite"
            style={{ ...spriteStyle,
              backgroundSize: "contain",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "center bottom",
              transform: `translate(${tx}%, ${ty}%) scale(${sc})`,
              transformOrigin: "center bottom",
            }}
          />
        );
      })()}

      {/* ── Atmospheric Overlay ── */}
      <div className="vn-atmosphere" />

      {/* ── Top Bar ── */}
      <div className="vn-topbar" onClick={(e) => e.stopPropagation()}>
        <div className="vn-topbar-safe-area" />
        <div className="vn-topbar-content">
        <button className="vn-topbar-btn" onClick={onClose}>
          <ArrowLeft size={20} />
        </button>
        <div className="vn-topbar-right">
          {!isArchived && (
            <button className="vn-topbar-btn" onClick={() => setShowBeatsPanel(true)} title="情节控制">
              <ListOrdered size={18} />
            </button>
          )}
          {!isArchived && (
            <button className="vn-topbar-btn" onClick={() => setShowScenePicker(true)} title="切换场景">
              <MapPin size={18} />
            </button>
          )}
          <button className="vn-topbar-btn" onClick={() => setHistoryOpen(true)} title="回顾">
            <Clock size={18} />
          </button>
          {!isArchived && (
            <button className="vn-topbar-btn" onClick={() => setShowArchiveConfirm(true)} title="归档章节">
              <Archive size={18} />
            </button>
          )}
        </div>
        </div>
      </div>

      {/* ── Dialogue Box: replay / playing / input ── */}
      {!showArchiveConfirm && !showReplayConfirm && assetsReady && sceneVisualReady && (isReplaying ? replayFrame : (frame || waitingForInput)) && (
        <div
          className={`vn-dialogue ${hideDialogue && !waitingForInput && !isReplaying ? "vn-dialogue-hidden" : ""}`}
        >
          <div className="vn-dialogue-inner" onClick={(e) => { if (waitingForInput && !isReplaying) e.stopPropagation(); }}>
            {/* ── Replay mode ── */}
            {isReplaying && replayFrame && (
              <>
                {renderFrameVoiceButton(replayFrame)}
                {replayFrame.speaker && <div className="vn-name">{replayFrame.speaker}</div>}
                <div className={`vn-text ${!replayFrame.speaker ? "vn-text-narration" : ""}`}>
                  {replayFrame.speaker && bilingualTranslationEnabled ? (
                    <BilingualTextBlock text={replayDialogueText} mode="plain" defaultExpanded={defaultTranslationExpanded} />
                  ) : (
                    replayDialogueText
                  )}
                </div>
                {!isTyping && (
                  <div className="vn-advance"><ChevronDown size={16} /></div>
                )}
              </>
            )}

            {/* ── Normal playing mode ── */}
            {!isReplaying && !waitingForInput && frame && (
              <>
                {renderFrameVoiceButton(frame)}
                {frame.speaker && <div className="vn-name">{frame.speaker}</div>}
                <div className={`vn-text ${isNarration ? "vn-text-narration" : ""}`}>
                  {frame.speaker && bilingualTranslationEnabled ? (
                    <BilingualTextBlock text={currentDialogueText} mode="plain" defaultExpanded={defaultTranslationExpanded} />
                  ) : (
                    currentDialogueText
                  )}
                </div>
                {!isTyping && !isGenerating && (
                  <div className="vn-advance"><ChevronDown size={16} /></div>
                )}
                {isGenerating && (
                  <div className="vn-advance" style={{ animation: "vn-pulse-loading 1.5s ease-in-out infinite", fontSize: "calc(11px*var(--app-text-scale,1))", letterSpacing: "0.1em" }}>
                    生成中...
                  </div>
                )}
              </>
            )}

            {/* ── Input mode ── */}
            {!isReplaying && waitingForInput && !isGenerating && (
              <>
                <div className="vn-name">
                  {userName}
                </div>

                {/* Choices from AI */}
                {currentOptions && currentOptions.choices.length > 0 && pendingActions.length === 0 && (
                  <div className="vn-options">
                    {currentOptions.choices.map((choice, i) => (
                      <button key={i} className="vn-option-btn" onClick={() => handleChoiceSelect(choice)}>
                        {choice}
                      </button>
                    ))}
                  </div>
                )}

                {/* Pending actions list */}
                {pendingActions.length > 0 && (
                  <div className="vn-pending">
                    {pendingActions.map((a, i) => (
                      <div key={i} className="vn-pending-item" data-type={a.type}>
                        <span className="vn-pending-tag">
                          {a.type === "dialogue" ? "对话" : a.type === "narration" ? "旁白" : "场景"}
                        </span>
                        <span className="vn-pending-text">{a.text}</span>
                        <button className="vn-pending-del" onClick={() => handleRemovePending(i)}>&times;</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Mode toggle + text input */}
                <div className="vn-input-mode">
                  <button
                    className="vn-mode-btn"
                    data-active={inputMode === "dialogue" ? "true" : undefined}
                    onClick={() => setInputMode("dialogue")}
                  >
                    <MessageSquare size={10} style={{ marginRight: 4, display: "inline" }} />
                    对话
                  </button>
                  <button
                    className="vn-mode-btn"
                    data-active={inputMode === "narration" ? "true" : undefined}
                    onClick={() => setInputMode("narration")}
                  >
                    <BookOpen size={10} style={{ marginRight: 4, display: "inline" }} />
                    旁白
                  </button>
                </div>
                <div className="vn-input-row">
                  <textarea
                    ref={inputRef}
                    className="vn-input-field"
                    placeholder={inputMode === "dialogue" ? "说些什么..." : "描述一个动作或场景..."}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => {}}
                    rows={1}
                  />
                  <button className="vn-send-btn" disabled={!inputText.trim()} onClick={handleTextSubmit} title="添加">
                    +
                  </button>
                  <button
                    className="vn-send-btn"
                    disabled={pendingActions.length === 0}
                    onClick={handleSendAll}
                    title="发送"
                    style={pendingActions.length > 0 ? { background: "rgba(160,140,240,0.3)", color: "rgba(255,255,255,0.9)" } : undefined}
                  >
                    <Send size={14} />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Control Bar ── */}
      {!showArchiveConfirm && !waitingForInput && !isReplaying && (
        <div className="vn-controls" onClick={(e) => e.stopPropagation()}>
          <button className="vn-ctrl-btn" onClick={() => setHideDialogue(!hideDialogue)} data-active={hideDialogue ? "true" : undefined} title="隐藏">
            {hideDialogue ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
          <button className="vn-ctrl-btn" onClick={() => setAutoMode(!autoMode)} data-active={autoMode ? "true" : undefined} title="自动">
            {autoMode ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            className="vn-ctrl-btn"
            onClick={handleVoiceToggle}
            data-active={voiceAutoEnabled ? "true" : undefined}
            title={voiceAutoEnabled ? "关闭语音" : "开启语音"}
            aria-pressed={voiceAutoEnabled}
            aria-label={voiceAutoEnabled ? "关闭漫卷语音" : "开启漫卷语音"}
          >
            <Volume2 size={15} />
          </button>
          <button className="vn-ctrl-btn" onClick={() => setShowReplayConfirm(true)} title="回放">
            <RotateCcw size={15} />
          </button>
        </div>
      )}

      {/* ── History Panel (message-level) ── */}
      {historyOpen && (
        <div className="vn-history-overlay" onClick={() => { setHistoryOpen(false); setCtxMenuMsgId(null); }}>
          <div className="vn-history-panel" onClick={(e) => { e.stopPropagation(); setCtxMenuMsgId(null); }}>
            <button className="vn-history-close" onClick={() => setHistoryOpen(false)}>
              <ArrowRight size={16} />
            </button>
            {historyMessages.map((msg) => {
              const roleLabel = msg.role === "user" ? "用户" : msg.role === "assistant" ? "AI" : "系统";
              // Parse for display preview
              const parsed = parseVnResponse(msg.rawContent);
              const frames = parsed.frames.filter((f) => f.text);

              return (
                <div
                  key={msg.id}
                  className="vn-history-msg"
                  data-role={msg.role}
                  onPointerDown={(e) => handleMsgLongPressStart(msg.id, e.clientX, e.clientY)}
                  onPointerUp={handleMsgLongPressEnd}
                  onPointerLeave={handleMsgLongPressEnd}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenuX(e.clientX); setCtxMenuY(e.clientY); setCtxMenuMsgId(msg.id); }}
                >
                  <div className="vn-history-msg-role">{roleLabel}</div>
                  {editingMsgId === msg.id ? (
                    <div className="vn-history-msg-edit">
                      <textarea
                        autoFocus
                        value={editingContent}
                        onChange={(e) => setEditingContent(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleMsgEditSave(); }
                          if (e.key === "Escape") { setEditingMsgId(null); setEditingContent(""); }
                        }}
                      />
                      <div className="vn-history-msg-edit-actions">
                        <button className="vn-history-msg-edit-btn" onClick={() => { setEditingMsgId(null); setEditingContent(""); }}>取消</button>
                        <button className="vn-history-msg-edit-btn" data-save="true" onClick={handleMsgEditSave}>保存</button>
                      </div>
                    </div>
                  ) : (
                    <div className="vn-history-msg-text">
                      {frames.length > 0 ? frames.map((f, fi) => (
                        <div key={fi} className={f.speaker ? "vn-hmsg-dialogue" : "vn-hmsg-narration"}>
                          {f.speaker && <span className="vn-hmsg-speaker">{f.speaker}</span>}
                          {f.speaker && bilingualTranslationEnabled ? (
                            <div className="vn-hmsg-bilingual">
                              <BilingualTextBlock text={f.text} mode="plain" defaultExpanded={defaultTranslationExpanded} />
                            </div>
                          ) : (
                            <span>{f.text}</span>
                          )}
                        </div>
                      )) : msg.rawContent.slice(0, 100)}
                    </div>
                  )}
                  {ctxMenuMsgId === msg.id && editingMsgId !== msg.id && (() => {
                    const menu = (
                      <div className="vn-ctx-menu" style={{ left: ctxMenuX, top: ctxMenuY, transform: "translateX(-50%)" }} onClick={(e) => e.stopPropagation()}>
                        <button className="vn-ctx-btn" onClick={() => handleMsgEditStart(msg)}>编辑</button>
                        {msg.role === "assistant" && (
                          <button className="vn-ctx-btn vn-ctx-btn-danger" onClick={() => handleMsgRetry(msg.id)}>重试</button>
                        )}
                        <button className="vn-ctx-btn vn-ctx-btn-danger" onClick={() => handleMsgDelete(msg.id)}>删除</button>
                        <button className="vn-ctx-btn vn-ctx-btn-danger" onClick={() => handleMsgDeleteFrom(msg.id)}>删除以下</button>
                      </div>
                    );
                    return vnShellRef.current ? createPortal(menu, vnShellRef.current) : menu;
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Scene Picker Panel ── */}
      {showScenePicker && (
        <div className="vn-history-overlay" onClick={() => setShowScenePicker(false)}>
          <div className="vn-scene-picker" onClick={(e) => e.stopPropagation()}>
            <button className="vn-history-close" onClick={() => setShowScenePicker(false)}>
              <ArrowRight size={16} />
            </button>
            <div className="vn-scene-picker-title">切换场景</div>
            {availableScenes.length === 0 ? (
              <div className="vn-scene-picker-empty">暂无场景，请在资源库中上传</div>
            ) : (
              availableScenes.map((scene) => (
                <button
                  key={scene.id}
                  className="vn-scene-picker-item"
                  data-active={currentScene === scene.name ? "true" : undefined}
                  onClick={() => handleSceneSwitch(scene.name)}
                >
                  <div className="vn-scene-picker-dot" />
                  <span className="vn-scene-picker-name">{scene.name}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── Beats Panel ── */}
      {showBeatsPanel && (
        <div className="vn-history-overlay" style={{ background: "transparent", backdropFilter: "none", WebkitBackdropFilter: "none" }} onClick={() => setShowBeatsPanel(false)}>
          <div className="vn-beats-panel" onClick={(e) => e.stopPropagation()}>
            <button className="vn-history-close" onClick={() => setShowBeatsPanel(false)}>
              <ArrowRight size={16} />
            </button>
            <div className="vn-beats-title">情节控制</div>
            {beats.length > 0 && (
              <div className="vn-beat-progress">
                {beats.filter((_, i) => i < activeBeatIdx).length}/{beats.length} 已完成
              </div>
            )}

            {/* Beat list */}
            {beats.map((beat, i) => (
              <div
                key={beat.id}
                className="vn-beat-item"
                data-active={i === activeBeatIdx ? "true" : undefined}
                data-done={i < activeBeatIdx ? "true" : undefined}
                onClick={() => handleSetActiveBeat(i)}
              >
                <div className="vn-beat-marker">
                  {i < activeBeatIdx ? "✓" : i === activeBeatIdx ? <ChevronRight size={10} /> : i + 1}
                </div>
                <div className="vn-beat-body">
                  <div className="vn-beat-name">{beat.title}</div>
                  {beat.description && <div className="vn-beat-desc">{beat.description}</div>}
                </div>
                <button className="vn-beat-del" onClick={(e) => { e.stopPropagation(); handleDeleteBeat(beat.id); }}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}

            {/* Add new beat */}
            <div className="vn-beat-add">
              <input
                className="vn-beat-input"
                placeholder="节点名称"
                value={editingBeatTitle}
                onChange={(e) => setEditingBeatTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddBeat(); }}
              />
              <input
                className="vn-beat-input"
                placeholder="描述（可选）"
                value={editingBeatDesc}
                onChange={(e) => setEditingBeatDesc(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddBeat(); }}
              />
              <button className="vn-beat-add-btn" onClick={handleAddBeat} disabled={!editingBeatTitle.trim()}>
                <Plus size={12} /> 添加节点
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Archive Confirm Screen ── */}
      {showArchiveConfirm && (
        <div className="vn-end" onClick={(e) => e.stopPropagation()}>
          <div className="vn-end-line" />
          <div className="vn-end-text">
            {isArchiving ? "归档中..." : "是否决定完结该章节并归档？"}
          </div>
          <div className="vn-end-line" />
          {!isArchiving && (
            <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
              <button className="vn-end-btn" onClick={() => setShowArchiveConfirm(false)}>
                返回
              </button>
              <button
                className="vn-end-btn"
                style={{ background: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.85)" }}
                onClick={async () => {
                  setIsArchiving(true);
                  archiveChapter(session.id, chapterIndex);
                  // Auto-summarize for cross-module memory
                  try {
                    const msgs = loadVnMessagesForChapter(session.id, chapterIndex);
                    if (msgs.length > 0) {
                      const summary = await summarizeVnChapter(characterId, msgs);
                      updateChapterSummary(session.id, chapterIndex, summary);
                    }
                  } catch (err) {
                    console.warn("[VN] Auto-summarize failed:", err);
                  }
                  // Small delay so the user sees the archiving state
                  await new Promise((r) => setTimeout(r, 600));
                  setIsArchiving(false);
                  setShowArchiveConfirm(false);
                  onChapterEnd();
                }}
              >
                确认
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Replay Confirm Screen ── */}
      {showReplayConfirm && (
        <div className="vn-end" onClick={(e) => e.stopPropagation()}>
          <div className="vn-end-line" />
          <div className="vn-end-text">是否确认章节回放？</div>
          <div className="vn-end-line" />
          <div style={{ display: "flex", gap: 16, marginTop: 16 }}>
            <button className="vn-end-btn" onClick={() => setShowReplayConfirm(false)}>
              返回
            </button>
            <button
              className="vn-end-btn"
              style={{ background: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.85)" }}
              onClick={() => {
                setShowReplayConfirm(false);
                setAutoMode(false);
                setWaitingForInput(false);
                // Build replay frames from chapter messages
                const msgs = loadVnMessagesForChapter(session.id, chapterIndex);
                const frames = buildFramesFromMessages(msgs).frames.filter(f => f.text);
                if (frames.length === 0) {
                  setShowReplayConfirm(false);
                  return;
                }
                setReplayFrames(frames);
                setReplayIdx(0);
                setIsReplaying(true);
                // Apply first frame
                const first = frames[0];
                if (first.bg) setCurrentScene(first.bg);
                if (first.sprite) setCurrentSprite(first.sprite);
                startTyping(getTypingSourceText(first));
              }}
            >
              确认
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
