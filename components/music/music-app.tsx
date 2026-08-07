// components/music/music-app.tsx — Music App main page (immersive, no PageShell)
"use client";

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import {
    loadAllTracks, saveTrack, deleteTrack,
    generateTrackId, parseFilename, getAudioDuration,
    type MusicTrack,
} from "@/lib/music-storage";
import { useMusicControls, type MusicControlsValue } from "@/lib/music-context";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import {
    isNeteaseConfigured, loadMusicApiConfig, saveMusicApiConfig,
    searchNetease, getNeteasePlayInfo, getNeteaseLyrics, getNeteaseSongDetail,
    testNeteaseConnection, getQrKey, getQrImage, checkQrStatus, checkLoginStatus,
    getUserPlaylists, getPlaylistTracks, saveNeteaseCookie, clearNeteaseCookie,
    getDailyRecommendSongs, getHotSearchDetail, getPersonalizedPlaylists,
    getRecommendResource, getToplists, getUserRecordWithCounts,
    getPlaylistDetail, getUserDetail, subscribePlaylist,
    type NeteaseHotSearch, type NeteaseSearchResult,
    type NeteasePlaylist, type NeteaseToplist, type MusicApiConfig,
    type NeteasePlaylistDetail, type NeteaseUserDetail, type NeteasePlayRecord,
} from "@/lib/music-service";
import { clearMusicCloudSyncData } from "@/lib/chat-engine";
import MusicCommentsPage from "./music-comments";
import {
    loadMusicBg, saveMusicBg, clearMusicBg, fileToCompressedDataUrl, appBgStyle,
    MUSIC_BG_EVENT, type MusicBgConfig, type MusicPlayerBgMode,
} from "@/lib/music-bg";

type Props = { onClose: () => void };
type TabId = "recommend" | "mine" | "search" | "local";

export default function MusicApp({ onClose }: Props) {
    const [tracks, setTracks] = useState<MusicTrack[]>([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState<TabId>("local");
    const [hasNetease, setHasNetease] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showCssEditor, setShowCssEditor] = useState(false);
    const [customCss, setCustomCss] = useState("");
    const [activePlaylist, setActivePlaylist] = useState<NeteasePlaylist | null>(null);
    const [dailyView, setDailyView] = useState<NeteaseSearchResult[] | null>(null);
    const [playlists, setPlaylists] = useState<NeteasePlaylist[]>([]);
    const [playlistsLoading, setPlaylistsLoading] = useState(true);
    const [musicToast, setMusicToast] = useState<string | null>(null);
    const [pendingPlayTrackId, setPendingPlayTrackId] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const musicToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const musicLoadingFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [bgCfg, setBgCfg] = useState<MusicBgConfig>(() => loadMusicBg());
    const player = useMusicControls();

    useEffect(() => {
        const handleBgChange = () => setBgCfg(loadMusicBg());
        window.addEventListener(MUSIC_BG_EVENT, handleBgChange);
        return () => window.removeEventListener(MUSIC_BG_EVENT, handleBgChange);
    }, []);

    // kv cache hydrates asynchronously — re-read the custom background until settled
    useEffect(() => {
        const timers = [300, 1200, 3000].map(ms => setTimeout(() => {
            setBgCfg(prev => {
                const fresh = loadMusicBg();
                return JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh;
            });
        }, ms));
        return () => timers.forEach(clearTimeout);
    }, []);

    useEffect(() => {
        loadAllTracks().then(t => { setTracks(t); setLoading(false); });
        const neteaseOk = isNeteaseConfigured();
        setHasNetease(neteaseOk);
        if (neteaseOk) setTab("recommend");
        setCustomCss(kvGet("music-custom-css") || "");
        // Load cached playlists immediately, then refresh from API
        if (neteaseOk) {
            try {
                const cached = kvGet("music-playlists-cache");
                if (cached) { setPlaylists(JSON.parse(cached)); setPlaylistsLoading(false); }
            } catch { /* ignore */ }
            getUserPlaylists().then(p => {
                setPlaylists(p);
                setPlaylistsLoading(false);
                if (p.length > 0) kvSet("music-playlists-cache", JSON.stringify(p));
            });
        } else {
            setPlaylistsLoading(false);
        }
    }, []);

    useEffect(() => {
        const handleLibraryUpdated = () => {
            void loadAllTracks().then(setTracks);
        };
        window.addEventListener("music-library-updated", handleLibraryUpdated);
        return () => window.removeEventListener("music-library-updated", handleLibraryUpdated);
    }, []);

    const clearMusicToast = useCallback(() => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        musicLoadingFallbackRef.current = null;
        setMusicToast(null);
        setPendingPlayTrackId(null);
    }, []);

    const showMusicToast = useCallback((text: string, duration = 2000) => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        musicLoadingFallbackRef.current = null;
        setPendingPlayTrackId(null);
        setMusicToast(text);
        if (duration > 0) {
            musicToastTimerRef.current = setTimeout(() => {
                setMusicToast(null);
                musicToastTimerRef.current = null;
            }, duration);
        }
    }, []);

    const beginMusicLoadingToast = useCallback((trackId: string) => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        setPendingPlayTrackId(trackId);
        setMusicToast("加载音乐中...");
        musicLoadingFallbackRef.current = setTimeout(() => {
            setMusicToast(null);
            setPendingPlayTrackId(null);
            musicLoadingFallbackRef.current = null;
        }, 8000);
    }, []);

    useEffect(() => {
        if (!pendingPlayTrackId || player.currentTrack?.id !== pendingPlayTrackId) return;
        clearMusicToast();
    }, [clearMusicToast, pendingPlayTrackId, player.currentTrack?.id]);

    useEffect(() => () => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
    }, []);

    // ── Upload handler ──
    const handleUpload = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        const newTracks: MusicTrack[] = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
            const audioExts = ["mp3", "m4a", "aac", "ogg", "wav", "flac", "wma", "opus", "webm"];
            if (!file.type.startsWith("audio/") && !audioExts.includes(ext)) continue;
            const { title, artist } = parseFilename(file.name);
            const duration = await getAudioDuration(file);
            const track: MusicTrack = { id: generateTrackId(), title, artist, duration, liked: false, addedAt: new Date().toISOString() };
            await saveTrack(track, file);
            newTracks.push(track);
        }
        if (newTracks.length > 0) setTracks(prev => [...newTracks, ...prev]);
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handlePlay = (track: MusicTrack) => {
        // Add this single track to front of queue (if not already in it)
        if (!player.queue.some(t => t.id === track.id)) {
            player.setQueue([track, ...player.queue]);
        }
        player.playTrack(track);
    };

    const handleDelete = async (trackId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        await deleteTrack(trackId);
        setTracks(prev => prev.filter(t => t.id !== trackId));
        if (player.currentTrack?.id === trackId) player.stop();
    };

    /** Convert NeteaseSearchResult → MusicTrack */
    const toMusicTrack = useCallback((r: NeteaseSearchResult, extra?: { lyrics?: string; coverUrl?: string; name?: string; artists?: string }): MusicTrack => ({
        id: `netease_${r.id}`,
        title: extra?.name || r.name,
        artist: extra?.artists || r.artists,
        duration: r.duration / 1000,
        coverUrl: extra?.coverUrl || r.coverUrl,
        lyrics: extra?.lyrics,
        liked: false,
        addedAt: new Date().toISOString(),
    }), []);

    /** Play a single Netease song — append to queue */
    const handlePlayNetease = useCallback(async (result: NeteaseSearchResult) => {
        const trackId = `netease_${result.id}`;
        beginMusicLoadingToast(trackId);
        const info = await getNeteasePlayInfo(result.id);
        if (!info.url) {
            showMusicToast(info.reason || "加载失败，请稍后重试", 2600);
            return;
        }
        const detail = await getNeteaseSongDetail(result.id);
        const lyrics = await getNeteaseLyrics(result.id);
        const track = toMusicTrack(result, { lyrics, coverUrl: detail?.coverUrl, name: detail?.name, artists: detail?.artists });
        // Prepend to existing queue
        if (!player.queue.some(t => t.id === track.id)) {
            player.setQueue([track, ...player.queue]);
        }
        player.playUrl(info.url, track);
        if (info.trial) showMusicToast("VIP 歌曲，当前播放 30 秒试听", 2600);
    }, [beginMusicLoadingToast, player, showMusicToast, toMusicTrack]);

    /** Play all tracks from a playlist — replace queue */
    const handlePlayAllNetease = useCallback(async (results: NeteaseSearchResult[]) => {
        if (results.length === 0) return;
        const queue = results.map(r => toMusicTrack(r));
        player.setQueue(queue);

        beginMusicLoadingToast(`netease_${results[0].id}`);
        let playable: { song: NeteaseSearchResult; url: string; index: number; trial: boolean } | null = null;
        let firstReason = "";
        for (let i = 0; i < results.length; i++) {
            const song = results[i];
            const info = await getNeteasePlayInfo(song.id);
            if (info.url) {
                playable = { song, url: info.url, index: i, trial: info.trial };
                break;
            }
            if (!firstReason && info.reason) firstReason = info.reason;
        }

        if (!playable) {
            showMusicToast(firstReason || "歌单内暂无可播放歌曲", 2600);
            return;
        }

        beginMusicLoadingToast(`netease_${playable.song.id}`);
        const detail = await getNeteaseSongDetail(playable.song.id);
        const lyrics = await getNeteaseLyrics(playable.song.id);
        const track = toMusicTrack(playable.song, { lyrics, coverUrl: detail?.coverUrl, name: detail?.name, artists: detail?.artists });
        player.playUrl(playable.url, track);
        if (playable.index > 0) showMusicToast(`已跳过 ${playable.index} 首不可播放歌曲`);
        else if (playable.trial) showMusicToast("VIP 歌曲，当前播放 30 秒试听", 2600);
    }, [beginMusicLoadingToast, player, showMusicToast, toMusicTrack]);

    const formatTime = (s: number) => {
        if (!s || !isFinite(s)) return "--:--";
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, "0")}`;
    };

    const onSettingsSaved = () => {
        const neteaseOk = isNeteaseConfigured();
        setHasNetease(neteaseOk);
        if (neteaseOk) {
            setTab("recommend");
            // API address may have changed — clear old cache and reload playlists
            kvRemove("music-playlists-cache");
            setPlaylistsLoading(true);
            setPlaylists([]);
            setActivePlaylist(null);
            getUserPlaylists().then(p => {
                setPlaylists(p);
                setPlaylistsLoading(false);
                if (p.length > 0) kvSet("music-playlists-cache", JSON.stringify(p));
            }).catch(() => setPlaylistsLoading(false));
        } else {
            setTab("local");
            kvRemove("music-playlists-cache");
            setPlaylists([]);
            setPlaylistsLoading(false);
        }
    };

    return (
        <div className="music-app" style={appBgStyle(bgCfg)}>
            {customCss && <SessionCustomCSS css={customCss} scope=".music-app" />}
            {musicToast && (
                <div className="music-toast-overlay">
                    <div className="music-toast-chip">
                        {musicToast === "加载音乐中..." ? (
                            <span className="ui-loading-toast-content">
                                <span className="ui-loading-spinner" />
                                <span>{musicToast}</span>
                            </span>
                        ) : musicToast}
                    </div>
                </div>
            )}

            {/* Header */}
            <div className="music-header">
                <div className="music-header-left">
                    <button className="music-header-action" onClick={() => {
                        if (dailyView) { setDailyView(null); }
                        else if (activePlaylist) { setActivePlaylist(null); }
                        else { onClose(); }
                    }} title="返回">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                </div>
                <div className="music-header-title">
                    {dailyView ? "每日推荐" : activePlaylist && tab === "recommend" ? "歌单详情" : tab === "recommend" ? "" : tab === "search" ? "搜索" : tab === "mine" ? "我的" : "本地音乐"}
                </div>
                <div className="music-header-right">
                    <button className="music-header-action" onClick={() => setShowSettings(true)} title="设置">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Tab content */}
            {tab === "recommend" && hasNetease && (dailyView ? (
                <DailySongsPage
                    songs={dailyView}
                    player={player}
                    formatTime={formatTime}
                    onPlayNetease={handlePlayNetease}
                    onPlayAll={handlePlayAllNetease}
                />
            ) : activePlaylist ? (
                <PlaylistsTab
                    player={player}
                    formatTime={formatTime}
                    onPlayNetease={handlePlayNetease}
                    onPlayAll={handlePlayAllNetease}
                    activePlaylist={activePlaylist}
                    setActivePlaylist={setActivePlaylist}
                    playlists={playlists}
                    loading={playlistsLoading}
                    onToast={showMusicToast}
                />
            ) : (
                <RecommendTab
                    formatTime={formatTime}
                    onPlayNetease={handlePlayNetease}
                    onPlayAll={handlePlayAllNetease}
                    onGoSearch={() => setTab("search")}
                    onOpenDaily={setDailyView}
                    onOpenPlaylist={setActivePlaylist}
                />
            ))}

            {tab === "mine" && hasNetease && (
                <MineTab
                    player={player}
                    formatTime={formatTime}
                    onPlayNetease={handlePlayNetease}
                    onPlayAll={handlePlayAllNetease}
                    activePlaylist={activePlaylist}
                    setActivePlaylist={setActivePlaylist}
                    playlists={playlists}
                    loading={playlistsLoading}
                    onToast={showMusicToast}
                />
            )}

            {tab === "local" && (
                <>
                    {/* Header Action: Upload Area inside the tab - Removed inline version */}
                    <input ref={fileInputRef} type="file" accept="audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac" multiple hidden onChange={(e) => handleUpload(e.target.files)} />

                    {/* Song list */}
                    {loading ? (
                        <div className="music-empty"><div className="music-empty-text">加载中...</div></div>
                    ) : tracks.length === 0 ? (
                        <div className="music-empty"><div className="music-empty-icon">♪</div><div className="music-empty-text">还没有音乐</div></div>
                    ) : (
                        <SongList tracks={tracks} player={player} formatTime={formatTime} onDelete={handleDelete} onPlay={handlePlay} />
                    )}
                </>
            )}

            {tab === "search" && hasNetease && (
                <OnlineSearchTab player={player} formatTime={formatTime} onPlayNetease={handlePlayNetease} />
            )}

            {/* Floating buttons */}
            {tab === "local" && (
                <>
                    <button
                        className="music-fab-add"
                        onClick={() => setShowCssEditor(true)}
                        title="自定义样式"
                        style={{ bottom: player.currentTrack ? "calc(202px + env(safe-area-inset-bottom, 0px))" : "calc(146px + env(safe-area-inset-bottom, 0px))" }}
                    >
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
                            <path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75z" />
                        </svg>
                    </button>
                    <button
                        className="music-fab-add"
                        onClick={() => fileInputRef.current?.click()}
                        title="添加本地音乐"
                        style={{ bottom: player.currentTrack ? "calc(146px + env(safe-area-inset-bottom, 0px))" : "calc(90px + env(safe-area-inset-bottom, 0px))" }}
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                </>
            )}

            {/* Bottom dock: mini player + tab bar share one glass slab */}
            <div className="music-bottom-dock">
            {player.currentTrack && (
                <div className="music-now-bar" onClick={player.openFullPlayer}>
                    <div className="music-birds">
                        <img src="/birds/小鸟1.png" className="music-bird bird-1" alt="bird" />
                        <img src="/birds/小鸟2.png" className="music-bird bird-2" alt="bird" />
                        <img src="/birds/小鸟3.png" className="music-bird bird-3" alt="bird" />
                        <img src="/birds/小鸟4.png" className="music-bird bird-4" alt="bird" />
                    </div>
                    <div className="music-now-bar-cover" {...(player.isPlaying ? { "data-playing": "" } : {})}>
                        {player.currentTrack.coverUrl ? (
                            <img src={player.currentTrack.coverUrl} alt="" />
                        ) : (
                            <div className="music-now-bar-cover-placeholder">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--c-music-accent)" strokeWidth="1.2">
                                    <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                </svg>
                            </div>
                        )}
                    </div>
                    <div className="music-now-bar-info">
                        <div className="music-now-bar-title">{player.currentTrack.title}</div>
                        <div className="music-now-bar-artist">{player.currentTrack.artist}</div>
                    </div>
                    <div className="music-now-bar-controls">
                        <button className="music-now-bar-btn" onClick={(e) => { e.stopPropagation(); player.prev(); }}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                        </button>
                        <button className="music-now-bar-btn" onClick={(e) => { e.stopPropagation(); player.togglePlay(); }}>
                            {player.isPlaying ? (
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
                            ) : (
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                            )}
                        </button>
                        <button className="music-now-bar-btn" onClick={(e) => { e.stopPropagation(); player.next(); }}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" /></svg>
                        </button>
                    </div>
                </div>
            )}

            {/* Bottom tab bar */}
            <div className="music-tabbar">
                {hasNetease && (
                    <button className="music-tabbar-item" {...(tab === "recommend" ? { "data-active": "" } : {})} onClick={() => { setTab("recommend"); setActivePlaylist(null); setDailyView(null); }}>
                        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5V21h-6v-6h-6v6H3z" /></svg>
                        <span>推荐</span>
                    </button>
                )}
                {hasNetease && (
                    <button className="music-tabbar-item" {...(tab === "search" ? { "data-active": "" } : {})} onClick={() => setTab("search")}>
                        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                        <span>搜索</span>
                    </button>
                )}
                {hasNetease && (
                    <button className="music-tabbar-item" {...(tab === "mine" ? { "data-active": "" } : {})} onClick={() => { setTab("mine"); setActivePlaylist(null); }}>
                        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5" /></svg>
                        <span>我的</span>
                    </button>
                )}
                <button className="music-tabbar-item" {...(tab === "local" ? { "data-active": "" } : {})} onClick={() => { setTab("local"); setActivePlaylist(null); }}>
                    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                    <span>本地</span>
                </button>
            </div>
            </div>

            {/* Settings Modal */}
            {showSettings && (
                <div className="music-settings-modal-overlay" onClick={() => setShowSettings(false)}>
                    <div className="music-settings-modal-dialog" onClick={(e) => e.stopPropagation()}>
                        <MusicSettingsTab onBack={() => setShowSettings(false)} onSaved={onSettingsSaved} />
                    </div>
                </div>
            )}

            {/* CSS Editor Modal */}
            {showCssEditor && (
                <div className="music-settings-modal-overlay" onClick={() => setShowCssEditor(false)}>
                    <div className="music-settings-modal-dialog" onClick={(e) => e.stopPropagation()}>
                        <MusicCssEditor onClose={() => setShowCssEditor(false)} onSave={setCustomCss} />
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Recommend Tab (home) ──

function greetingByHour(): { hello: string; sub: string } {
    const h = new Date().getHours();
    if (h < 5) return { hello: "夜深了", sub: "适合戴上耳机的时刻" };
    if (h < 11) return { hello: "早上好", sub: "用一首歌开启今天" };
    if (h < 14) return { hello: "中午好", sub: "午后小憩，来点轻音乐" };
    if (h < 18) return { hello: "下午好", sub: "为你准备了新的推荐" };
    if (h < 23) return { hello: "晚上好", sub: "今晚想听点什么" };
    return { hello: "夜深了", sub: "适合戴上耳机的时刻" };
}

function RecommendTab({ formatTime, onPlayNetease, onPlayAll, onGoSearch, onOpenDaily, onOpenPlaylist }: {
    formatTime: (s: number) => string;
    onPlayNetease: (r: NeteaseSearchResult) => void;
    onPlayAll: (results: NeteaseSearchResult[]) => void;
    onGoSearch: () => void;
    onOpenDaily: (songs: NeteaseSearchResult[]) => void;
    onOpenPlaylist: (playlist: NeteasePlaylist) => void;
}) {
    const [dailySongs, setDailySongs] = useState<NeteaseSearchResult[]>(() => readMusicCache("music-recommend-daily", []));
    const [playlists, setPlaylists] = useState<NeteasePlaylist[]>(() => readMusicCache("music-recommend-playlists", []));
    const [hotSearches, setHotSearches] = useState<NeteaseHotSearch[]>(() => readMusicCache("music-recommend-hot-search", []));
    const [toplists, setToplists] = useState<NeteaseToplist[]>(() => readMusicCache("music-recommend-toplists", []));
    const [loading, setLoading] = useState(dailySongs.length + playlists.length + hotSearches.length === 0);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        Promise.all([
            getDailyRecommendSongs(),
            getRecommendResource().then(items => items.length > 0 ? items : getPersonalizedPlaylists(12)),
            getHotSearchDetail(),
            getToplists(),
        ]).then(([daily, recPlaylists, hot, charts]) => {
            if (cancelled) return;
            setDailySongs(daily);
            setPlaylists(recPlaylists);
            setHotSearches(hot);
            setToplists(charts);
            writeMusicCache("music-recommend-daily", daily);
            writeMusicCache("music-recommend-playlists", recPlaylists);
            writeMusicCache("music-recommend-hot-search", hot);
            writeMusicCache("music-recommend-toplists", charts);
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, []);

    const hasRecommendContent = dailySongs.length + playlists.length + hotSearches.length + toplists.length > 0;
    const greeting = greetingByHour();
    const today = new Date();
    const dailyCover = dailySongs[0]?.coverUrl;

    return (
        <div className="music-discovery">
            {/* Greeting + search entry */}
            <div className="music-greet">
                <div className="music-greet-hello">{greeting.hello}</div>
                <div className="music-greet-sub">{dailySongs.length > 0 ? `根据你的口味，今天更新了 ${dailySongs.length} 首推荐` : greeting.sub}</div>
                <button className="music-search-pill" onClick={onGoSearch}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                    <span>{hotSearches[0]?.keyword || "搜索歌曲、歌手、歌单"}</span>
                </button>
            </div>

            {loading && !hasRecommendContent ? (
                <div className="music-empty"><div className="music-empty-text">加载推荐中...</div></div>
            ) : (
                <>
                    {/* Daily recommendation hero card — opens the daily page */}
                    {dailySongs.length > 0 && (
                        <div className="music-daily-card" onClick={() => onOpenDaily(dailySongs)}>
                            {dailyCover && <img src={dailyCover} alt="" className="music-daily-bg" />}
                            <div className="music-daily-mask" />
                            <div className="music-daily-inner">
                                <span className="music-daily-date">每日推荐 · {today.getMonth() + 1} / {today.getDate()}</span>
                                <div>
                                    <div className="music-daily-title">今天为你选了 {dailySongs.length} 首</div>
                                    <div className="music-daily-sub">{dailySongs[0]?.name}{dailySongs[0]?.artists ? ` — ${dailySongs[0].artists}` : ""} 等</div>
                                </div>
                            </div>
                            <button
                                className="music-daily-play"
                                onClick={(e) => { e.stopPropagation(); onPlayAll(dailySongs); }}
                                title="播放全部"
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                            </button>
                        </div>
                    )}

                    {/* Recommended playlists — horizontal rail */}
                    {playlists.length > 0 && (
                        <MusicSection title="为你推荐的歌单" action="更多灵感">
                            <div className="music-rail">
                                {playlists.slice(0, 10).map(pl => (
                                    <div key={pl.id} className="music-rail-card" onClick={() => onOpenPlaylist(pl)}>
                                        <div className="music-rail-cover">
                                            <img src={pl.coverUrl} alt="" />
                                            {(pl.playCount ?? 0) > 0 && (
                                                <span className="music-rail-count">▶ {formatMusicCount(pl.playCount!)}</span>
                                            )}
                                        </div>
                                        <div className="music-rail-name">{pl.name}</div>
                                    </div>
                                ))}
                            </div>
                        </MusicSection>
                    )}

                    {/* Top charts */}
                    {toplists.length > 0 && (
                        <MusicSection title="排行榜" action="每天更新">
                            <div className="music-chart-grid">
                                {toplists.slice(0, 4).map(chart => (
                                    <button key={chart.id} className="music-chart-card" onClick={() => onOpenPlaylist(chart)}>
                                        <img src={chart.coverUrl} alt="" className="music-chart-cover" />
                                        <div className="music-chart-info">
                                            <div className="music-chart-name">{chart.name}</div>
                                            {chart.tracks?.slice(0, 3).map((track, idx) => (
                                                <div key={idx} className="music-chart-track">
                                                    <em>{idx + 1}</em> {track.first}{track.second ? ` - ${track.second}` : ""}
                                                </div>
                                            ))}
                                        </div>
                                        {chart.updateFrequency && <span className="music-chart-freq">{chart.updateFrequency}</span>}
                                    </button>
                                ))}
                            </div>
                        </MusicSection>
                    )}

                    {/* Hot searches */}
                    {hotSearches.length > 0 && (
                        <MusicSection title="热搜" action="实时">
                            <div className="music-hot-list">
                                {hotSearches.slice(0, 8).map((item, idx) => (
                                    <button key={`${item.keyword}-${idx}`} className="music-hot-item" onClick={() => searchNetease(item.keyword, 1).then(result => result[0] && onPlayNetease(result[0]))}>
                                        <span className="music-hot-rank" {...(idx < 3 ? { "data-top": "" } : {})}>{idx + 1}</span>
                                        <span className="music-hot-word">{item.keyword}</span>
                                        {item.content && <span className="music-hot-desc">{item.content}</span>}
                                    </button>
                                ))}
                            </div>
                        </MusicSection>
                    )}
                </>
            )}
        </div>
    );
}

// ── Daily Recommendation Page (second-level, like a playlist) ──
function DailySongsPage({ songs, player, formatTime, onPlayNetease, onPlayAll }: {
    songs: NeteaseSearchResult[];
    player: MusicControlsValue;
    formatTime: (s: number) => string;
    onPlayNetease: (r: NeteaseSearchResult) => void;
    onPlayAll: (results: NeteaseSearchResult[]) => void;
}) {
    const today = new Date();
    return (
        <div className="music-playlist-detail">
            <div className="music-pl-hero">
                <div className="music-pl-hero-cover">
                    {songs[0]?.coverUrl && <img src={songs[0].coverUrl} alt="" />}
                    <span className="music-rail-count">{today.getMonth() + 1} / {today.getDate()}</span>
                </div>
                <div className="music-pl-hero-info">
                    <div className="music-pl-hero-name">每日推荐</div>
                    <div className="music-pl-hero-meta">
                        <span>根据你的口味生成</span>
                        <span>{songs.length} 首</span>
                    </div>
                    <div className="music-pl-hero-tags"><span>每天 6:00 更新</span></div>
                </div>
            </div>
            <div className="music-playlist-detail-header">
                <button className="music-playlist-play-all" onClick={() => onPlayAll(songs)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                    <span>播放全部</span>
                    <i>{songs.length}首</i>
                </button>
            </div>
            <div className="music-list">
                {songs.map((r, idx) => {
                    const isCurrent = player.currentTrack?.id === `netease_${r.id}`;
                    return (
                        <div key={r.id} className="music-song" {...(isCurrent ? { "data-playing": "" } : {})} style={{ animationDelay: `${Math.min(idx * 0.03, 0.4)}s` }} onClick={() => onPlayNetease(r)}>
                            {isCurrent && player.isPlaying ? (
                                <span className="music-song-idx"><span className="music-wave music-queue-wave">{[0, 1, 2].map(i => <span key={i} className="music-wave-bar" style={{ animationDelay: `${i * 0.15}s` }} />)}</span></span>
                            ) : (
                                <span className="music-song-idx">{idx + 1}</span>
                            )}
                            <div className="music-song-info">
                                <div className="music-song-title">{r.name}</div>
                                <div className="music-song-artist">{r.artists}{r.album ? ` · ${r.album}` : ""}</div>
                            </div>
                            <div className="music-song-duration">{formatTime(r.duration / 1000)}</div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ── Mine Tab ──
function MineTab({ player, formatTime, onPlayNetease, onPlayAll, activePlaylist, setActivePlaylist, playlists, loading, onToast }: {
    player: MusicControlsValue;
    formatTime: (s: number) => string;
    onPlayNetease: (r: NeteaseSearchResult) => void;
    onPlayAll: (results: NeteaseSearchResult[]) => void;
    activePlaylist: NeteasePlaylist | null;
    setActivePlaylist: (pl: NeteasePlaylist | null) => void;
    playlists: NeteasePlaylist[];
    loading: boolean;
    onToast: (text: string) => void;
}) {
    const [weekRecords, setWeekRecords] = useState<NeteasePlayRecord[]>(() => readMusicCache("music-user-week-records", []));
    const [userDetail, setUserDetail] = useState<NeteaseUserDetail | null>(() => readMusicCache("music-user-detail", null));

    useEffect(() => {
        let cancelled = false;
        const cfg = loadMusicApiConfig();
        if (cfg.baseUrl.trim()) {
            getUserRecordWithCounts(1).then(records => {
                if (cancelled) return;
                setWeekRecords(records);
                writeMusicCache("music-user-week-records", records);
            });
            getUserDetail().then(detail => {
                if (cancelled || !detail) return;
                setUserDetail(detail);
                writeMusicCache("music-user-detail", detail);
            });
        }
        return () => { cancelled = true; };
    }, []);

    if (activePlaylist) {
        return (
            <PlaylistsTab
                player={player}
                formatTime={formatTime}
                onPlayNetease={onPlayNetease}
                onPlayAll={onPlayAll}
                activePlaylist={activePlaylist}
                setActivePlaylist={setActivePlaylist}
                playlists={playlists}
                loading={loading}
                onToast={onToast}
            />
        );
    }

    // ── Week report derived from play records (hours are an estimate) ──
    const totalPlays = weekRecords.reduce((sum, r) => sum + r.playCount, 0);
    const estimatedHours = weekRecords.reduce((sum, r) => sum + r.playCount * (r.song.duration / 1000), 0) / 3600;
    const artistCounts = new Map<string, number>();
    for (const r of weekRecords) {
        const first = (r.song.artists || "").split("/")[0];
        if (first) artistCounts.set(first, (artistCounts.get(first) || 0) + r.playCount);
    }
    const topArtist = [...artistCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const topSongs = weekRecords.slice(0, 7);
    const maxPlay = Math.max(1, ...topSongs.map(r => r.playCount));
    const recentTracks = weekRecords.map(r => r.song);

    const profileMeta = [
        userDetail?.level ? `Lv.${userDetail.level}` : "",
        userDetail?.listenSongs ? `累计听歌 ${userDetail.listenSongs.toLocaleString()} 首` : "",
        userDetail?.createDays ? `村龄 ${Math.round(userDetail.createDays / 365 * 10) / 10} 年` : "",
    ].filter(Boolean).join(" · ");

    return (
        <div className="music-discovery">
            {/* Profile header */}
            {userDetail && (
                <div className="music-me-head">
                    <div className="music-me-ava">
                        {userDetail.avatarUrl ? <img src={userDetail.avatarUrl} alt="" /> : <span>{userDetail.nickname.slice(0, 1)}</span>}
                    </div>
                    <div className="music-me-id">
                        <b>{userDetail.nickname}</b>
                        {profileMeta && <span>{profileMeta}</span>}
                    </div>
                </div>
            )}

            {/* Week listening report */}
            {topSongs.length > 0 && (
                <div className="music-week-card">
                    <div className="music-week-eyebrow">听歌周报</div>
                    <div className="music-week-big">
                        本周听了 <em>{totalPlays}</em> 次{estimatedHours >= 0.1 ? <>，约 <em>{Math.round(estimatedHours * 10) / 10}</em> 小时</> : null}
                    </div>
                    {topArtist && <div className="music-week-sub">最常听：{topArtist}</div>}
                    <div className="music-week-bars">
                        {topSongs.map(r => (
                            <div
                                key={r.song.id}
                                className="music-week-bar"
                                title={`${r.song.name} · ${r.playCount}次`}
                                onClick={() => onPlayNetease(r.song)}
                            >
                                <i style={{ height: `${Math.max(12, Math.round(r.playCount / maxPlay * 100))}%` }} />
                                <span>{r.song.name.slice(0, 4)}</span>
                            </div>
                        ))}
                    </div>
                    <div className="music-week-note">时长按播放次数 × 歌曲长度估算</div>
                </div>
            )}

            {recentTracks.length > 0 && (
                <MusicSection title="最近一周在听" action={`${recentTracks.length} 首`}>
                    <div className="music-list music-list-compact">
                        {recentTracks.slice(0, 8).map((song, idx) => (
                            <NeteaseSongRow key={song.id} song={song} index={idx} formatTime={formatTime} onPlay={onPlayNetease} />
                        ))}
                    </div>
                </MusicSection>
            )}

            {playlists.length > 0 ? (
                <MusicSection title="我的歌单" action={`${playlists.length} 个`}>
                    <PlaylistGrid playlists={playlists} onOpen={setActivePlaylist} />
                </MusicSection>
            ) : loading ? (
                <div className="music-empty"><div className="music-empty-text">加载歌单...</div></div>
            ) : (
                <div className="music-empty"><div className="music-empty-text">没有云端歌单，请先在设置中登录网易云账号</div></div>
            )}

        </div>
    );
}

function MusicSection({ title, action, children }: { title: string; action?: string; children: ReactNode }) {
    return (
        <section className="music-section">
            <div className="music-section-head">
                <h3>{title}</h3>
                {action && <span>{action}</span>}
            </div>
            {children}
        </section>
    );
}

function PlaylistGrid({ playlists, onOpen }: { playlists: NeteasePlaylist[]; onOpen: (playlist: NeteasePlaylist) => void }) {
    return (
        <div className="music-playlist-grid">
            {playlists.map(pl => (
                <div key={pl.id} className="music-playlist-card" onClick={() => onOpen(pl)}>
                    <div className="music-playlist-cover">
                        <img src={pl.coverUrl} alt="" />
                        <span className="music-playlist-count">{formatMusicCount(pl.trackCount)}</span>
                    </div>
                    <div className="music-playlist-name">{pl.name}</div>
                </div>
            ))}
        </div>
    );
}

function NeteaseSongRow({ song, index, formatTime, onPlay }: {
    song: NeteaseSearchResult;
    index: number;
    formatTime: (s: number) => string;
    onPlay: (song: NeteaseSearchResult) => void;
}) {
    return (
        <div className="music-song" style={{ animationDelay: `${Math.min(index * 0.04, 0.5)}s` }} onClick={() => onPlay(song)}>
            <div className="music-song-cover">
                {song.coverUrl ? <img src={song.coverUrl} alt="" /> : (
                    <div className="music-song-cover-placeholder">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                    </div>
                )}
            </div>
            <div className="music-song-info">
                <div className="music-song-title">{song.name}</div>
                <div className="music-song-artist">{song.artists}{song.album ? ` · ${song.album}` : ""}</div>
            </div>
            <div className="music-song-duration">{formatTime(song.duration / 1000)}</div>
        </div>
    );
}

// ── Song List (local) ──
function SongList({ tracks, player, formatTime, onDelete, onPlay }: {
    tracks: MusicTrack[];
    player: MusicControlsValue;
    formatTime: (s: number) => string;
    onDelete: (id: string, e: React.MouseEvent) => void;
    onPlay: (t: MusicTrack) => void;
}) {
    const [deleteTarget, setDeleteTarget] = useState<MusicTrack | null>(null);

    return (
        <div className="music-list">
            {tracks.map((track, idx) => {
                const isCurrent = player.currentTrack?.id === track.id;
                return (
                    <div key={track.id} className="music-song" {...(isCurrent ? { "data-playing": "" } : {})} style={{ animationDelay: `${Math.min(idx * 0.04, 0.5)}s` }} onClick={() => onPlay(track)}>
                        <div className="music-song-cover">
                            {track.coverUrl ? <img src={track.coverUrl} alt="" /> : (
                                <div className="music-song-cover-placeholder">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                                </div>
                            )}
                            {isCurrent && player.isPlaying && (
                                <div className="music-song-playing-overlay">
                                    <div className="music-wave">{[0, 1, 2, 3].map(i => <span key={i} className="music-wave-bar" style={{ animationDelay: `${i * 0.15}s` }} />)}</div>
                                </div>
                            )}
                        </div>
                        <div className="music-song-info">
                            <div className="music-song-title">{track.title}</div>
                            <div className="music-song-artist">{track.artist}</div>
                        </div>
                        <div className="music-song-duration">{formatTime(track.duration)}</div>
                        <div className="music-song-actions">
                            <button className="music-song-action-btn" data-danger="" onClick={(e) => { e.stopPropagation(); setDeleteTarget(track); }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                            </button>
                        </div>
                    </div>
                );
            })}

            {/* Delete confirm modal */}
            {deleteTarget && (
                <div className="music-settings-modal-overlay" onClick={() => setDeleteTarget(null)}>
                    <div className="music-settings-modal-dialog music-confirm-dialog" onClick={e => e.stopPropagation()}>
                        <div className="music-settings-header"><h2>删除确认</h2></div>
                        <div className="music-settings-body">
                            <div className="music-confirm-text">确定删除「{deleteTarget.title}」吗？</div>
                            <div className="music-settings-actions">
                                <button className="music-settings-btn" onClick={() => setDeleteTarget(null)}>取消</button>
                                <button className="music-settings-btn music-settings-btn-danger" onClick={(e) => { onDelete(deleteTarget.id, e); setDeleteTarget(null); }}>删除</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}

// ── Online Search Tab ──
function OnlineSearchTab({ player, formatTime, onPlayNetease }: {
    player: MusicControlsValue;
    formatTime: (s: number) => string;
    onPlayNetease: (r: NeteaseSearchResult) => void;
}) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<NeteaseSearchResult[]>([]);
    const [searching, setSearching] = useState(false);

    const doSearch = async () => {
        if (!query.trim()) return;
        setSearching(true);
        try {
            const r = await searchNetease(query.trim());
            setResults(r);
        } catch { /* ignore */ }
        setSearching(false);
    };

    return (
        <div className="music-search-tab">
            <div className="music-search-bar">
                <input
                    className="music-search-input"
                    placeholder="搜索歌曲、歌手..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && doSearch()}
                />
                <button className="music-search-btn" onClick={doSearch} disabled={searching} title="搜索">
                    {searching ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="music-spin">
                            <line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
                        </svg>
                    ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                    )}
                </button>
            </div>

            {results.length > 0 ? (
                <div className="music-list">
                    {results.map((r, idx) => (
                        <div key={r.id} className="music-song" style={{ animationDelay: `${Math.min(idx * 0.04, 0.5)}s` }} onClick={() => onPlayNetease(r)}>
                            <div className="music-song-cover">
                                {r.coverUrl ? <img src={r.coverUrl} alt="" /> : (
                                    <div className="music-song-cover-placeholder">
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                                    </div>
                                )}
                            </div>
                            <div className="music-song-info">
                                <div className="music-song-title">{r.name}</div>
                                <div className="music-song-artist">{r.artists}{r.album ? ` · ${r.album}` : ""}</div>
                            </div>
                            <div className="music-song-duration">{formatTime(r.duration / 1000)}</div>
                        </div>
                    ))}
                </div>
            ) : searching ? (
                <div className="music-empty"><div className="music-empty-text">搜索中...</div></div>
            ) : (
                <div className="music-empty">
                    <div className="music-empty-icon">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                    </div>
                    <div className="music-empty-text">搜索网易云音乐</div>
                </div>
            )}
        </div>
    );
}

// ── Playlists Tab ──
function PlaylistsTab({ player, formatTime, onPlayNetease, onPlayAll, activePlaylist, setActivePlaylist, playlists, loading, onToast }: {
    player: MusicControlsValue;
    formatTime: (s: number) => string;
    onPlayNetease: (r: NeteaseSearchResult) => void;
    onPlayAll: (results: NeteaseSearchResult[]) => void;
    activePlaylist: NeteasePlaylist | null;
    setActivePlaylist: (pl: NeteasePlaylist | null) => void;
    playlists: NeteasePlaylist[];
    loading: boolean;
    onToast: (text: string) => void;
}) {
    const [tracks, setTracks] = useState<NeteaseSearchResult[]>([]);
    const [loadingTracks, setLoadingTracks] = useState(false);
    const [detail, setDetail] = useState<NeteasePlaylistDetail | null>(null);
    const [isSubscribed, setIsSubscribed] = useState(false);
    const [subDelta, setSubDelta] = useState(0);
    const [subscribing, setSubscribing] = useState(false);
    const [showComments, setShowComments] = useState(false);

    // Fetch rich playlist meta (play count / tags / description)
    useEffect(() => {
        setShowComments(false);
        setSubDelta(0);
        setIsSubscribed(false);
        if (!activePlaylist) {
            setDetail(null);
            return;
        }
        let cancelled = false;
        const cacheKey = `music-playlist-detail-${activePlaylist.id}`;
        const cached = readMusicCache<NeteasePlaylistDetail | null>(cacheKey, null);
        if (cached) {
            setDetail(cached);
            setIsSubscribed(!!cached.subscribed);
        }
        getPlaylistDetail(activePlaylist.id).then(d => {
            if (cancelled || !d) return;
            setDetail(d);
            setIsSubscribed(!!d.subscribed);
            setSubDelta(0);
            writeMusicCache(cacheKey, d);
        });
        return () => { cancelled = true; };
    }, [activePlaylist]);

    const handleCollect = async () => {
        if (!activePlaylist || subscribing) return;
        const next = !isSubscribed;
        setSubscribing(true);
        const result = await subscribePlaylist(activePlaylist.id, next);
        setSubscribing(false);
        onToast(result.message);
        if (result.ok) {
            setIsSubscribed(next);
            setSubDelta(d => d + (next ? 1 : -1));
        }
    };

    // Clear tracks when navigating back to playlist list
    useEffect(() => {
        if (!activePlaylist) {
            setTracks([]);
            return;
        }

        let cancelled = false;
        const cacheKey = `music-playlist-tracks-${activePlaylist.id}`;
        try {
            const cached = kvGet(cacheKey);
            if (cached) { setTracks(JSON.parse(cached)); setLoadingTracks(false); }
            else { setLoadingTracks(true); }
        } catch { setLoadingTracks(true); }

        getPlaylistTracks(activePlaylist.id).then((nextTracks) => {
            if (cancelled) return;
            setTracks(nextTracks);
            setLoadingTracks(false);
            if (nextTracks.length > 0) kvSet(cacheKey, JSON.stringify(nextTracks));
        }).catch(() => {
            if (!cancelled) setLoadingTracks(false);
        });

        return () => { cancelled = true; };
    }, [activePlaylist]);

    const openPlaylist = async (pl: NeteasePlaylist) => {
        setActivePlaylist(pl);
    };

    // Showing tracks inside a playlist
    if (activePlaylist) {
        const playCountText = detail?.playCount ? formatMusicCount(detail.playCount) : "";
        return (
            <>
            <div className="music-playlist-detail">
                {/* Hero header with rich meta */}
                <div className="music-pl-hero">
                    <div className="music-pl-hero-cover">
                        <img src={detail?.coverUrl || activePlaylist.coverUrl} alt="" />
                        {playCountText && <span className="music-rail-count">▶ {playCountText}</span>}
                    </div>
                    <div className="music-pl-hero-info">
                        <div className="music-pl-hero-name">{activePlaylist.name}</div>
                        <div className="music-pl-hero-meta">
                            {(detail?.creator || activePlaylist.creator) && <span>{detail?.creator || activePlaylist.creator}</span>}
                            <span>{detail?.trackCount || activePlaylist.trackCount} 首</span>
                        </div>
                        {(detail?.tags?.length ?? 0) > 0 && (
                            <div className="music-pl-hero-tags">
                                {detail!.tags!.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}
                            </div>
                        )}
                    </div>
                </div>
                {detail?.description && (
                    <div className="music-pl-hero-desc">{detail.description}</div>
                )}
                <div className="music-playlist-detail-header">
                    {tracks.length > 0 && (
                        <button className="music-playlist-play-all" onClick={() => onPlayAll(tracks)}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                            <span>播放全部</span>
                            <i>{tracks.length}首</i>
                        </button>
                    )}
                    <button
                        className="music-pl-chip"
                        {...(isSubscribed ? { "data-on": "" } : {})}
                        onClick={handleCollect}
                        disabled={subscribing}
                        title={isSubscribed ? "取消收藏" : "收藏歌单"}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill={isSubscribed ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z" /></svg>
                        {detail?.subscribedCount ? formatMusicCount(detail.subscribedCount + subDelta) : (isSubscribed ? "已收藏" : "收藏")}
                    </button>
                    <button className="music-pl-chip" onClick={() => setShowComments(true)} title="查看评论">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L4 21l1.5-4.3A8.5 8.5 0 1 1 21 12z" /></svg>
                        {detail?.commentCount ? formatMusicCount(detail.commentCount) : "评论"}
                    </button>
                </div>
                {loadingTracks ? (
                    <div className="music-empty"><div className="music-empty-text">加载中...</div></div>
                ) : (
                    <div className="music-list">
                        {tracks.map((r, idx) => {
                            const isCurrent = player.currentTrack?.id === `netease_${r.id}`;
                            return (
                            <div key={r.id} className="music-song" {...(isCurrent ? { "data-playing": "" } : {})} style={{ animationDelay: `${Math.min(idx * 0.03, 0.4)}s` }} onClick={() => onPlayNetease(r)}>
                                {isCurrent && player.isPlaying ? (
                                    <span className="music-song-idx"><span className="music-wave music-queue-wave">{[0, 1, 2].map(i => <span key={i} className="music-wave-bar" style={{ animationDelay: `${i * 0.15}s` }} />)}</span></span>
                                ) : (
                                    <span className="music-song-idx">{idx + 1}</span>
                                )}
                                <div className="music-song-info">
                                    <div className="music-song-title">{r.name}</div>
                                    <div className="music-song-artist">{r.artists}{r.album ? ` · ${r.album}` : ""}</div>
                                </div>
                                <div className="music-song-duration">{formatTime(r.duration / 1000)}</div>
                            </div>
                            );
                        })}
                    </div>
                )}

            </div>

            {/* Playlist comments overlay — outside the scroll container */}
            {showComments && (
                <MusicCommentsPage
                    songId={activePlaylist.id}
                    resType={2}
                    title={activePlaylist.name}
                    artist={detail?.creator || activePlaylist.creator || "歌单"}
                    coverUrl={detail?.coverUrl || activePlaylist.coverUrl}
                    onClose={() => setShowComments(false)}
                />
            )}
            </>
        );
    }

    // Playlist grid
    return (
        <div className="music-playlists">
            {loading ? (
                <div className="music-empty"><div className="music-empty-text">加载歌单...</div></div>
            ) : playlists.length === 0 ? (
                <div className="music-empty">
                    <div className="music-empty-icon">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round"><rect x="2" y="3" width="20" height="18" rx="2" /><path d="M8 12h8M8 16h5" /></svg>
                    </div>
                    <div className="music-empty-text">没有歌单</div>
                    <div className="music-empty-text" style={{ fontSize: "calc(11px*var(--app-text-scale,1))", opacity: 0.5 }}>请先在设置中登录网易云账号</div>
                </div>
            ) : (
                <div className="music-playlist-grid">
                    {playlists.map(pl => (
                        <div key={pl.id} className="music-playlist-card" onClick={() => openPlaylist(pl)}>
                            <div className="music-playlist-cover">
                                <img src={pl.coverUrl} alt="" />
                                <span className="music-playlist-count">{pl.trackCount}</span>
                            </div>
                            <div className="music-playlist-name">{pl.name}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Settings Tab ──
function MusicSettingsTab({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
    const [config, setConfig] = useState<MusicApiConfig>(() => loadMusicApiConfig());
    const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
    const [testing, setTesting] = useState(false);

    // QR login state
    const [qrImg, setQrImg] = useState<string | null>(null);
    const [qrKey, setQrKey] = useState<string | null>(null);
    const [qrStatus, setQrStatus] = useState<string>("");
    const [qrPolling, setQrPolling] = useState(false);
    const [loginNickname, setLoginNickname] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Custom background state (app pages + player each have their own image)
    const [bg, setBg] = useState<MusicBgConfig>(() => loadMusicBg());
    const [bgMsg, setBgMsg] = useState<string | null>(null);
    const [bgUrlDraft, setBgUrlDraft] = useState(() => {
        const cfg = loadMusicBg();
        return cfg.image.startsWith("data:") ? "" : cfg.image;
    });
    const [playerUrlDraft, setPlayerUrlDraft] = useState(() => {
        const cfg = loadMusicBg();
        return cfg.playerImage.startsWith("data:") ? "" : cfg.playerImage;
    });
    const bgFileRef = useRef<HTMLInputElement>(null);
    const playerFileRef = useRef<HTMLInputElement>(null);

    const applyBg = (next: MusicBgConfig) => {
        const result = saveMusicBg(next);
        setBgMsg(result.ok ? null : result.message);
        if (result.ok) setBg(next);
    };

    const handleBgUpload = async (files: FileList | null, target: "app" | "player") => {
        const file = files?.[0];
        if (!file) return;
        try {
            const dataUrl = await fileToCompressedDataUrl(file);
            if (target === "app") {
                applyBg({ ...bg, image: dataUrl });
                setBgUrlDraft("");
            } else {
                applyBg({ ...bg, playerImage: dataUrl, playerMode: "custom" });
                setPlayerUrlDraft("");
            }
        } catch (e) {
            setBgMsg(e instanceof Error ? e.message : "图片处理失败");
        }
        if (bgFileRef.current) bgFileRef.current.value = "";
        if (playerFileRef.current) playerFileRef.current.value = "";
    };

    const handleBgUrl = (target: "app" | "player") => {
        const url = (target === "app" ? bgUrlDraft : playerUrlDraft).trim();
        if (!url) return;
        if (!/^https?:\/\//.test(url)) { setBgMsg("请输入 http(s) 图片链接"); return; }
        const secure = url.replace(/^http:\/\//, "https://");
        if (target === "app") applyBg({ ...bg, image: secure });
        else applyBg({ ...bg, playerImage: secure, playerMode: "custom" });
    };

    const handleBgClear = () => {
        clearMusicBg();
        setBg(loadMusicBg());
        setBgUrlDraft("");
        setPlayerUrlDraft("");
        setBgMsg(null);
    };

    const setPlayerMode = (mode: MusicPlayerBgMode) => {
        applyBg({ ...bg, playerMode: mode });
    };

    // Check login status on mount when API is configured
    useEffect(() => {
        const base = config.baseUrl.trim();
        if (!base) return;
        checkLoginStatus(base).then(s => {
            if (s.loggedIn && s.nickname) {
                setLoginNickname(s.nickname);
            }
        });
    }, [config.baseUrl]);

    // Cleanup polling on unmount
    useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

    const handleSave = () => {
        const nextConfig = { ...config, baseUrl: config.baseUrl.trim(), enabled: true };
        saveMusicApiConfig(nextConfig);
        setConfig(nextConfig);
        onSaved();
        onBack();
    };

    const handleTest = async () => {
        if (!config.baseUrl.trim()) return;
        setTesting(true);
        setTestResult(null);
        const result = await testNeteaseConnection(config.baseUrl.trim());
        setTestResult(result);
        setTesting(false);
    };

    const startQrLogin = async () => {
        const base = config.baseUrl.trim();
        if (!base) return;
        setQrStatus("获取二维码...");
        setQrImg(null);
        if (pollRef.current) clearInterval(pollRef.current);

        const key = await getQrKey(base);
        if (!key) { setQrStatus("获取二维码失败"); return; }
        setQrKey(key);

        const img = await getQrImage(base, key);
        if (!img) { setQrStatus("生成二维码失败"); return; }
        setQrImg(img);
        setQrStatus("请用网易云音乐 App 扫码");
        setQrPolling(true);

        pollRef.current = setInterval(async () => {
            const res = await checkQrStatus(base, key);
            if (res.code === 803) {
                // Authorized — save auth cookie for subsequent API calls
                if (res.cookie) saveNeteaseCookie(res.cookie);
                const nextConfig = { ...config, baseUrl: base, enabled: true };
                saveMusicApiConfig(nextConfig);
                setConfig(nextConfig);
                if (pollRef.current) clearInterval(pollRef.current);
                setQrPolling(false);
                setQrImg(null);
                setQrStatus("");
                setLoginNickname(res.nickname || "已登录");
                onSaved();
            } else if (res.code === 802) {
                setQrStatus("已扫码，请在手机上确认");
            } else if (res.code === 800) {
                if (pollRef.current) clearInterval(pollRef.current);
                setQrPolling(false);
                setQrImg(null);
                setQrStatus("二维码已过期，请重新获取");
            }
            // 801 = waiting, do nothing
        }, 2000);
    };

    const handleLogout = () => {
        if (pollRef.current) clearInterval(pollRef.current);
        setQrPolling(false);
        setQrImg(null);
        setQrKey(null);
        setQrStatus("");
        setLoginNickname(null);
        clearNeteaseCookie();
        clearMusicCloudSyncData();
        onSaved();
    };

    return (
        <div className="music-settings">
            <div className="music-settings-header">
                <h2>设置</h2>
                <button className="music-settings-close" onClick={onBack}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
            </div>

            <div className="music-settings-body">
                <div className="music-settings-section">
                    <div className="music-settings-label">网易云 API 地址</div>
                    <div className="music-settings-hint">默认使用公共服务，也可以改成自己的 NeteaseCloudMusicApi 地址</div>
                    <input
                        className="music-settings-input"
                        placeholder="https://your-api.vercel.app"
                        value={config.baseUrl}
                        onChange={(e) => setConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                    />
                </div>

                <div className="music-settings-actions">
                    <button className="music-settings-btn" onClick={handleTest} disabled={testing || !config.baseUrl.trim()}>
                        {testing ? "测试中..." : "测试连接"}
                    </button>
                    <button className="music-settings-btn music-settings-btn-primary" onClick={handleSave}>
                        保存
                    </button>
                </div>

                {testResult && (
                    <div className={`music-settings-result ${testResult.ok ? "music-settings-result-ok" : "music-settings-result-err"}`}>
                        {testResult.ok ? "✓ " : "✗ "}{testResult.message}
                    </div>
                )}

                {/* QR Login Section */}
                {config.baseUrl.trim() && (
                    <div className="music-settings-section music-qr-section">
                        <div className="music-settings-label">网易云账号登录</div>
                        <div className="music-settings-hint">登录后可播放 VIP 歌曲（需扫码）</div>

                        {loginNickname ? (
                            <div className="music-qr-logged">
                                <span className="music-qr-nickname">{loginNickname}</span>
                                <span className="music-qr-badge">已登录</span>
                            </div>
                        ) : (
                            <>
                                <div className="music-settings-actions" style={{ marginTop: '8px' }}>
                                    <button
                                        className="music-settings-btn"
                                        onClick={startQrLogin}
                                        disabled={qrPolling}
                                    >
                                        {qrPolling ? "等待扫码中..." : "扫码登录"}
                                    </button>
                                </div>

                                {qrImg && (
                                    <div className="music-qr-wrap">
                                        <img src={qrImg} alt="QR Code" className="music-qr-img" />
                                    </div>
                                )}
                            </>
                        )}

                        {qrStatus && <div className="music-qr-status">{qrStatus}</div>}
                    </div>
                )}

                {loginNickname && (
                    <div className="music-settings-actions" style={{ marginTop: 20 }}>
                        <button
                            className="music-settings-btn"
                            onClick={handleLogout}
                        >
                            退出登录
                        </button>
                    </div>
                )}

                {/* Custom backgrounds: app pages + player page */}
                <div className="music-settings-section music-qr-section">
                    <div className="music-settings-label">App 页面背景</div>
                    <div className="music-settings-hint">首页/歌单/我的等页面的背景图，上传或粘贴链接即时生效</div>

                    {bg.image && (
                        <div className="music-bg-preview" style={{ backgroundImage: `url("${bg.image}")` }}>
                            <span style={{ opacity: bg.dim / 100 }} />
                        </div>
                    )}

                    <input ref={bgFileRef} type="file" accept="image/*" hidden onChange={e => { void handleBgUpload(e.target.files, "app"); }} />
                    <div className="music-settings-actions" style={{ marginTop: 8 }}>
                        <button className="music-settings-btn" onClick={() => bgFileRef.current?.click()}>上传图片</button>
                        {bg.image && <button className="music-settings-btn" onClick={() => applyBg({ ...bg, image: "" })}>清除此图</button>}
                    </div>

                    <div className="music-settings-actions">
                        <input
                            className="music-settings-input"
                            placeholder="https:// 图片链接"
                            value={bgUrlDraft}
                            onChange={e => setBgUrlDraft(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && handleBgUrl("app")}
                        />
                        <button className="music-settings-btn" style={{ flex: "0 0 76px" }} onClick={() => handleBgUrl("app")} disabled={!bgUrlDraft.trim()}>使用</button>
                    </div>

                    {bg.image && (
                        <>
                            <div className="music-settings-row" style={{ marginTop: 4 }}>
                                <span className="music-settings-label">背景暗化 {bg.dim}%</span>
                            </div>
                            <input
                                type="range"
                                className="music-bg-range"
                                min={20}
                                max={85}
                                value={bg.dim}
                                onChange={e => applyBg({ ...bg, dim: parseInt(e.target.value, 10) })}
                            />
                        </>
                    )}
                </div>

                <div className="music-settings-section music-qr-section">
                    <div className="music-settings-label">播放页背景</div>
                    <div className="music-settings-hint">全屏播放页可以单独设置背景</div>

                    <div className="music-bg-modes">
                        <button className="music-bg-mode" {...(bg.playerMode === "cover" ? { "data-on": "" } : {})} onClick={() => setPlayerMode("cover")}>封面取色</button>
                        <button className="music-bg-mode" {...(bg.playerMode === "follow" ? { "data-on": "" } : {})} onClick={() => setPlayerMode("follow")}>跟随App背景</button>
                        <button className="music-bg-mode" {...(bg.playerMode === "custom" ? { "data-on": "" } : {})} onClick={() => setPlayerMode("custom")}>独立图片</button>
                    </div>

                    {bg.playerMode === "custom" && (
                        <>
                            {bg.playerImage && (
                                <div className="music-bg-preview" style={{ backgroundImage: `url("${bg.playerImage}")` }}>
                                    <span style={{ opacity: bg.playerDim / 100 }} />
                                </div>
                            )}

                            <input ref={playerFileRef} type="file" accept="image/*" hidden onChange={e => { void handleBgUpload(e.target.files, "player"); }} />
                            <div className="music-settings-actions" style={{ marginTop: 8 }}>
                                <button className="music-settings-btn" onClick={() => playerFileRef.current?.click()}>上传图片</button>
                                {bg.playerImage && <button className="music-settings-btn" onClick={() => applyBg({ ...bg, playerImage: "" })}>清除此图</button>}
                            </div>

                            <div className="music-settings-actions">
                                <input
                                    className="music-settings-input"
                                    placeholder="https:// 图片链接"
                                    value={playerUrlDraft}
                                    onChange={e => setPlayerUrlDraft(e.target.value)}
                                    onKeyDown={e => e.key === "Enter" && handleBgUrl("player")}
                                />
                                <button className="music-settings-btn" style={{ flex: "0 0 76px" }} onClick={() => handleBgUrl("player")} disabled={!playerUrlDraft.trim()}>使用</button>
                            </div>

                            {bg.playerImage && (
                                <>
                                    <div className="music-settings-row" style={{ marginTop: 4 }}>
                                        <span className="music-settings-label">背景暗化 {bg.playerDim}%</span>
                                    </div>
                                    <input
                                        type="range"
                                        className="music-bg-range"
                                        min={20}
                                        max={85}
                                        value={bg.playerDim}
                                        onChange={e => applyBg({ ...bg, playerDim: parseInt(e.target.value, 10) })}
                                    />
                                </>
                            )}
                        </>
                    )}

                    {(bg.image || bg.playerImage) && (
                        <div className="music-settings-actions" style={{ marginTop: 8 }}>
                            <button className="music-settings-btn" onClick={handleBgClear}>全部恢复默认背景</button>
                        </div>
                    )}
                    {bgMsg && <div className="music-qr-status">{bgMsg}</div>}
                </div>
            </div>
        </div>
    );
}

function readMusicCache<T>(key: string, fallback: T): T {
    try {
        const raw = kvGet(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "data" in parsed) return parsed.data as T;
        return parsed as T;
    } catch {
        return fallback;
    }
}

function writeMusicCache<T>(key: string, data: T): void {
    try {
        kvSet(key, JSON.stringify({ data, updatedAt: Date.now() }));
    } catch { /* ignore */ }
}

function formatMusicCount(value: number): string {
    if (!Number.isFinite(value)) return "0";
    if (value >= 100000000) return `${Math.round(value / 10000000) / 10}亿`;
    if (value >= 10000) return `${Math.round(value / 1000) / 10}万`;
    return String(value);
}

// ── CSS Editor ──
import { MUSIC_CSS_EXAMPLE } from "@/lib/css-examples";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";

function MusicCssEditor({ onClose, onSave }: { onClose: () => void; onSave: (css: string) => void }) {
    const [css, setCss] = useState(() => kvGet("music-custom-css") || "");

    const handleSave = () => {
        const trimmed = css.trim();
        if (trimmed) kvSet("music-custom-css", trimmed);
        else kvRemove("music-custom-css");
        onSave(trimmed);
        window.dispatchEvent(new CustomEvent("music-css-change", { detail: trimmed }));
        onClose();
    };

    return (
        <div className="music-settings">
            <div className="music-settings-header">
                <h2>自定义样式</h2>
                <button className="music-settings-close" onClick={onClose}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
            </div>
            <div className="music-settings-body">
                <div className="music-settings-hint">输入 CSS 代码，覆盖音乐页面任意样式</div>
                <textarea
                    className="music-settings-input"
                    style={{ height: 280, resize: "none", fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace", fontSize: "calc(13px*var(--app-text-scale,1))", lineHeight: 1.6, padding: "12px 14px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                    value={css}
                    onChange={e => setCss(e.target.value)}
                    placeholder="/* 在此输入自定义 CSS... */"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                />
                <div className="music-settings-actions">
                    <CSSSchemeBar target="music" currentCSS={css} onLoad={setCss} btnStyle={{
                      border: "1px solid var(--c-music-surface-solid, rgba(255,255,255,0.12))",
                      background: "var(--c-music-surface, rgba(255,255,255,0.06))",
                      color: "var(--c-music-text, #e0d8f0)",
                    }} modalVars={{
                      panel: "var(--c-music-bg, #0c0a1a)",
                      border: "var(--c-music-surface-solid, rgba(255,255,255,0.12))",
                      text: "var(--c-music-text, #e0d8f0)",
                      textDim: "var(--c-music-accent, #b49de8)",
                      input: "var(--c-music-surface, rgba(255,255,255,0.06))",
                      inputBorder: "var(--c-music-surface-solid, rgba(255,255,255,0.12))",
                      accent: "var(--c-music-accent, #b49de8)",
                    }} />
                    <button className="music-settings-btn" onClick={() => setCss(MUSIC_CSS_EXAMPLE)}>示例</button>
                    <button className="music-settings-btn" onClick={() => setCss("")}>清空</button>
                    <button className="music-settings-btn music-settings-btn-primary" onClick={handleSave}>保存</button>
                </div>
            </div>
        </div>
    );
}
