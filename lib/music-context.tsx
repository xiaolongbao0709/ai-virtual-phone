// lib/music-context.tsx — Global music playback state & <audio> management
"use client";

import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { MusicTrack } from "./music-storage";
import { getAudioBlob, markTrackPlayed } from "./music-storage";
import { findPlayableMatch, getNeteaseLyrics, getNeteasePlayUrl, getNeteasePlayInfo, getNeteaseSongDetail } from "./music-service";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { registerMusicControlBridge } from "./music-control-bridge";
import { refreshListenTogetherStateFromStorage, syncListenTogetherTrack } from "./listen-together";

// ── Types ──

export type PlayMode = "sequence" | "shuffle" | "repeat-one";

export type MusicState = {
    currentTrack: MusicTrack | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    playMode: PlayMode;
    queue: MusicTrack[];
    volume: number;
    showFullPlayer: boolean;
    floatDismissed: boolean;
};

export type MusicActions = {
    playTrack: (track: MusicTrack) => void;
    playUrl: (url: string, track: MusicTrack) => void; // play from URL (online streams)
    pause: () => void;
    resume: () => void;
    togglePlay: () => void;
    next: () => void;
    prev: () => void;
    seek: (time: number) => void;
    setPlayMode: (mode: PlayMode) => void;
    setQueue: (tracks: MusicTrack[]) => void;
    removeFromQueue: (trackId: string) => void;
    setVolume: (vol: number) => void;
    stop: () => void;
    dismissFloat: () => void;
    openFullPlayer: () => void;
    closeFullPlayer: () => void;
};

type MusicContextValue = MusicState & MusicActions;
export type MusicControlsValue = Omit<MusicContextValue, "currentTime">;

const MusicContext = createContext<MusicContextValue | null>(null);
const MusicControlsContext = createContext<MusicControlsValue | null>(null);

export function useMusicPlayer(): MusicContextValue {
    const ctx = useContext(MusicContext);
    if (!ctx) throw new Error("useMusicPlayer must be used within <MusicProvider>");
    return ctx;
}

// Optional: use in components that may render outside provider
export function useMusicPlayerOptional(): MusicContextValue | null {
    return useContext(MusicContext);
}

export function useMusicControls(): MusicControlsValue {
    const ctx = useContext(MusicControlsContext);
    if (!ctx) throw new Error("useMusicControls must be used within <MusicProvider>");
    return ctx;
}

export function useMusicControlsOptional(): MusicControlsValue | null {
    return useContext(MusicControlsContext);
}

// ── Queue persistence ──

const QUEUE_STORAGE_KEY = "ai_phone_music_queue_v1";
registerKvMigration(QUEUE_STORAGE_KEY);
const QUEUE_MAX_SIZE = 200;

/** 最近一次播放请求是用户操作还是角色操作；syncListenTogetherTrack 消费后自动归位 user。 */
let nextMusicSourceHint: "user" | "char" = "user";

export function setNextMusicSourceHint(source: "user" | "char"): void {
  nextMusicSourceHint = source;
}

function consumeMusicSourceHint(): "user" | "char" {
  const source = nextMusicSourceHint;
  nextMusicSourceHint = "user";
  return source;
}

function loadPersistedQueue(): MusicTrack[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(QUEUE_STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.slice(0, QUEUE_MAX_SIZE) : [];
    } catch { return []; }
}

function persistQueue(q: MusicTrack[]): void {
    try { kvSet(QUEUE_STORAGE_KEY, JSON.stringify(q.slice(0, QUEUE_MAX_SIZE))); } catch { /* ignore */ }
}

// ── Provider ──

export function MusicProvider({ children }: { children: ReactNode }) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const blobUrlRef = useRef<string | null>(null);

    const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playMode, setPlayMode] = useState<PlayMode>("sequence");
    const [queue, setQueueRaw] = useState<MusicTrack[]>(() => loadPersistedQueue());
    const [volume, setVolumeState] = useState(0.8);
    const [showFullPlayer, setShowFullPlayer] = useState(false);
    const [floatDismissed, setFloatDismissed] = useState(false);

    // KV hydrates asynchronously; re-read the persisted listen-together room once mounted.
    useEffect(() => {
        refreshListenTogetherStateFromStorage();
    }, []);

    // Persist queue on change.
    useEffect(() => {
        persistQueue(queue);
    }, [queue]);

    /** Wrapped setQueue with max size enforcement */
    const setQueue = useCallback((tracks: MusicTrack[]) => {
        setQueueRaw(tracks.slice(0, QUEUE_MAX_SIZE));
    }, []);

    // Initialize audio element once
    useEffect(() => {
        const audio = new Audio();
        audio.volume = 0.8;
        audioRef.current = audio;

        audio.addEventListener("timeupdate", () => {
            setCurrentTime(audio.currentTime);
        });
        audio.addEventListener("loadedmetadata", () => {
            setDuration(audio.duration || 0);
        });
        audio.addEventListener("ended", () => {
            handleTrackEnd();
        });
        audio.addEventListener("pause", () => setIsPlaying(false));
        audio.addEventListener("play", () => setIsPlaying(true));

        return () => {
            audio.pause();
            audio.src = "";
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleTrackEnd = useCallback(() => {
        setCurrentTrack(prev => {
            setQueueRaw(q => {
                if (q.length === 0) return q;

                // Find current index
                const idx = prev ? q.findIndex(t => t.id === prev.id) : -1;

                let nextTrack: MusicTrack | null = null;
                // Read playMode from DOM to avoid stale closure
                const mode = playModeRef.current;

                if (mode === "repeat-one") {
                    nextTrack = prev;
                } else if (mode === "shuffle") {
                    const randomIdx = Math.floor(Math.random() * q.length);
                    nextTrack = q[randomIdx];
                } else {
                    // sequence
                    const nextIdx = idx + 1;
                    if (nextIdx < q.length) {
                        nextTrack = q[nextIdx];
                    }
                }

                if (nextTrack) {
                    // Defer to avoid state conflicts
                    setTimeout(() => loadAndPlay(nextTrack!), 0);
                }
                return q;
            });
            return prev;
        });
    }, []);

    const playModeRef = useRef(playMode);
    useEffect(() => { playModeRef.current = playMode; }, [playMode]);

    const cleanupBlobUrl = useCallback(() => {
        if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
        }
    }, []);

    const loadAndPlay = useCallback(async (track: MusicTrack) => {
        const audio = audioRef.current;
        if (!audio) return;

        cleanupBlobUrl();
        audio.pause();

        // Netease tracks: fetch play URL from API
        if (track.id.startsWith("netease_")) {
            const nid = parseInt(track.id.replace("netease_", ""), 10);
            const playUrl = await getNeteasePlayUrl(nid);
            if (!playUrl) return;
            audio.src = playUrl;
        } else {
            // Local tracks: load blob from IndexedDB
            const blob = await getAudioBlob(track.id);
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            blobUrlRef.current = url;
            audio.src = url;
            const playedAt = new Date().toISOString();
            void markTrackPlayed(track.id, playedAt).catch(() => undefined);
            track = { ...track, lastPlayedAt: playedAt };
        }

        setCurrentTrack(track);
        setCurrentTime(0);
        syncListenTogetherTrack(track, consumeMusicSourceHint());

        try {
            await audio.play();
        } catch {
            // Autoplay blocked — user interaction needed
        }
    }, [cleanupBlobUrl]);

    const playTrack = useCallback((track: MusicTrack) => {
        setFloatDismissed(false);
        loadAndPlay(track);
    }, [loadAndPlay]);

    /** Play from a direct URL (for online streaming) */
    const playUrl = useCallback((url: string, track: MusicTrack) => {
        const audio = audioRef.current;
        if (!audio) return;
        setFloatDismissed(false);
        cleanupBlobUrl();
        audio.pause();
        audio.src = url;
        setCurrentTrack(track);
        setCurrentTime(0);
        syncListenTogetherTrack(track, consumeMusicSourceHint());
        audio.play().catch(() => {});
    }, [cleanupBlobUrl]);

    const pause = useCallback(() => {
        audioRef.current?.pause();
    }, []);

    const resume = useCallback(() => {
        audioRef.current?.play().catch(() => {});
    }, []);

    const togglePlay = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    }, []);

    const next = useCallback(() => {
        if (queue.length === 0 || !currentTrack) return;
        const idx = queue.findIndex(t => t.id === currentTrack.id);
        let nextIdx: number;
        if (playMode === "shuffle") {
            nextIdx = Math.floor(Math.random() * queue.length);
        } else {
            nextIdx = (idx + 1) % queue.length;
        }
        loadAndPlay(queue[nextIdx]);
    }, [queue, currentTrack, playMode, loadAndPlay]);

    const prev = useCallback(() => {
        if (queue.length === 0 || !currentTrack) return;
        const audio = audioRef.current;
        // If more than 3s into the song, restart it
        if (audio && audio.currentTime > 3) {
            audio.currentTime = 0;
            return;
        }
        const idx = queue.findIndex(t => t.id === currentTrack.id);
        let prevIdx: number;
        if (playMode === "shuffle") {
            prevIdx = Math.floor(Math.random() * queue.length);
        } else {
            prevIdx = (idx - 1 + queue.length) % queue.length;
        }
        loadAndPlay(queue[prevIdx]);
    }, [queue, currentTrack, playMode, loadAndPlay]);

    const seek = useCallback((time: number) => {
        const audio = audioRef.current;
        const maxDuration = Number.isFinite(audio?.duration) && audio!.duration > 0
            ? audio!.duration
            : duration;
        const clamped = Math.max(0, Math.min(time, maxDuration > 0 ? maxDuration : time));
        setCurrentTime(clamped);
        if (audio) audio.currentTime = clamped;
    }, [duration]);

    const setVolume = useCallback((vol: number) => {
        const clamped = Math.max(0, Math.min(1, vol));
        setVolumeState(clamped);
        if (audioRef.current) audioRef.current.volume = clamped;
    }, []);

    const stop = useCallback(() => {
        const audio = audioRef.current;
        if (audio) {
            audio.pause();
            audio.currentTime = 0;
        }
        cleanupBlobUrl();
        setCurrentTrack(null);
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setShowFullPlayer(false);
    }, [cleanupBlobUrl]);

    const removeFromQueue = useCallback((trackId: string) => {
        setQueueRaw(prev => {
            const next = prev.filter(t => t.id !== trackId);
            persistQueue(next);
            return next;
        });
    }, []);

    const dismissFloat = useCallback(() => {
        audioRef.current?.pause();
        setFloatDismissed(true);
    }, []);

    const openFullPlayer = useCallback(() => { setFloatDismissed(false); setShowFullPlayer(true); }, []);
    const closeFullPlayer = useCallback(() => setShowFullPlayer(false), []);

    const playResolvedTrack = useCallback(async (track: MusicTrack): Promise<{ ok: boolean; message: string; track?: MusicTrack }> => {
        setFloatDismissed(false);
        setQueueRaw(prev => prev.some(item => item.id === track.id) ? prev : [track, ...prev]);

        if (track.id.startsWith("netease_")) {
            const nid = parseInt(track.id.replace("netease_", ""), 10);
            const info = await getNeteasePlayInfo(nid);
            const url = info.url;
            if (!url) return { ok: false, message: info.reason || "没有找到可播放的音乐" };
            const [detail, lyrics] = await Promise.all([
                getNeteaseSongDetail(nid).catch(() => null),
                getNeteaseLyrics(nid).catch(() => ""),
            ]);
            const resolvedTrack: MusicTrack = {
                ...track,
                title: detail?.name || track.title,
                artist: detail?.artists || track.artist,
                coverUrl: detail?.coverUrl || track.coverUrl,
                lyrics: lyrics || track.lyrics,
            };
            playUrl(url, resolvedTrack);
            return { ok: true, message: `正在播放「${resolvedTrack.title}」`, track: resolvedTrack };
        }

        playTrack(track);
        return { ok: true, message: `正在播放「${track.title}」`, track };
    }, [playTrack, playUrl]);

    const playByQuery = useCallback(async (query: string, artist?: string): Promise<{ ok: boolean; message: string; track?: MusicTrack }> => {
        const found = await findPlayableMatch(query, artist);
        if (!found) return { ok: false, message: "没有找到可播放的音乐" };
        const { result, playUrl: onlineUrl } = found;
        if (result.source === "local" && result.localTrack) {
            return playResolvedTrack(result.localTrack);
        }
        if (result.source === "netease" && result.neteaseResult && onlineUrl) {
            const r = result.neteaseResult;
            const [detail, lyrics] = await Promise.all([
                getNeteaseSongDetail(r.id).catch(() => null),
                getNeteaseLyrics(r.id).catch(() => ""),
            ]);
            const track: MusicTrack = {
                id: `netease_${r.id}`,
                title: detail?.name || r.name,
                artist: detail?.artists || r.artists,
                duration: r.duration / 1000,
                coverUrl: detail?.coverUrl || r.coverUrl,
                lyrics,
                liked: false,
                addedAt: new Date().toISOString(),
            };
            setFloatDismissed(false);
            setQueueRaw(prev => prev.some(item => item.id === track.id) ? prev : [track, ...prev]);
            playUrl(onlineUrl, track);
            return { ok: true, message: `正在播放「${track.title}」`, track };
        }
        return { ok: false, message: "没有找到可播放的音乐" };
    }, [playResolvedTrack, playUrl]);

    const addToQueue = useCallback(async (
        tracksToAdd: MusicTrack[],
        options?: { replace?: boolean; playFirst?: boolean },
    ): Promise<{ ok: boolean; message: string; queue: MusicTrack[] }> => {
        const cleanTracks = tracksToAdd.filter(track => track.id && track.title);
        if (cleanTracks.length === 0) return { ok: false, message: "没有可加入播放列表的歌曲", queue };

        const base = options?.replace ? [] : queue;
        const seen = new Set(base.map(track => track.id));
        const merged = [...base];
        for (const track of cleanTracks) {
            if (seen.has(track.id)) continue;
            seen.add(track.id);
            merged.push(track);
        }
        const nextQueue = merged.slice(0, QUEUE_MAX_SIZE);
        setQueueRaw(nextQueue);

        if (options?.playFirst) {
            await playResolvedTrack(cleanTracks[0]);
        }

        return {
            ok: true,
            message: options?.replace ? `已替换播放列表，共 ${cleanTracks.length} 首` : `已加入播放列表，共 ${cleanTracks.length} 首`,
            queue: nextQueue.length > 0 ? nextQueue : cleanTracks,
        };
    }, [playResolvedTrack, queue]);

    useEffect(() => {
        registerMusicControlBridge({
            getState: () => ({
                currentTrack,
                isPlaying,
                currentTime,
                duration,
                playMode,
                queue,
                volume,
            }),
            playTrack: playResolvedTrack,
            playByQuery,
            addToQueue,
            pause,
            resume,
            stop,
            next,
            prev,
            setPlayMode,
        });
        return () => registerMusicControlBridge(null);
    }, [
        currentTrack, isPlaying, currentTime, duration, playMode, queue, volume,
        playResolvedTrack, playByQuery, addToQueue, pause, resume, stop, next, prev, setPlayMode,
    ]);

    const controlsValue = useMemo<MusicControlsValue>(() => ({
        currentTrack, isPlaying, duration, playMode, queue, volume, showFullPlayer, floatDismissed,
        playTrack, playUrl, pause, resume, togglePlay, next, prev, seek,
        setPlayMode, setQueue, removeFromQueue, setVolume, stop, dismissFloat, openFullPlayer, closeFullPlayer,
    }), [
        currentTrack, isPlaying, duration, playMode, queue, volume, showFullPlayer, floatDismissed,
        playTrack, playUrl, pause, resume, togglePlay, next, prev, seek,
        setQueue, removeFromQueue, setVolume, stop, dismissFloat, openFullPlayer, closeFullPlayer,
    ]);

    const value = useMemo<MusicContextValue>(() => ({
        ...controlsValue,
        currentTime,
    }), [controlsValue, currentTime]);

    return (
        <MusicControlsContext.Provider value={controlsValue}>
            <MusicContext.Provider value={value}>
                {children}
            </MusicContext.Provider>
        </MusicControlsContext.Provider>
    );
}
