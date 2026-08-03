// components/music/music-artist.tsx — Artist profile page
// Hero portrait, stats, hot songs (playable), album shelf.
"use client";

import { useCallback, useEffect, useState } from "react";
import { useMusicPlayer } from "@/lib/music-context";
import type { MusicTrack } from "@/lib/music-storage";
import {
    getArtistDetail, getArtistTopSongs, getArtistAlbums,
    getNeteasePlayUrl, getNeteaseSongDetail, getNeteaseLyrics,
    type NeteaseArtist, type NeteaseAlbum, type NeteaseSearchResult,
} from "@/lib/music-service";

type Props = {
    artistId: number;
    artistName: string;
    onClose: () => void;
};

function formatFans(value?: number): string {
    if (!value || !Number.isFinite(value)) return "";
    if (value >= 100000000) return `${Math.round(value / 10000000) / 10}亿`;
    if (value >= 10000) return `${Math.round(value / 1000) / 10}万`;
    return String(value);
}

function formatDuration(ms: number): string {
    const s = ms / 1000;
    if (!s || !isFinite(s)) return "--:--";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function MusicArtistPage({ artistId, artistName, onClose }: Props) {
    const player = useMusicPlayer();
    const [artist, setArtist] = useState<NeteaseArtist | null>(null);
    const [topSongs, setTopSongs] = useState<NeteaseSearchResult[]>([]);
    const [albums, setAlbums] = useState<NeteaseAlbum[]>([]);
    const [loading, setLoading] = useState(true);
    const [pendingSongId, setPendingSongId] = useState<number | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        Promise.all([
            getArtistDetail(artistId),
            getArtistTopSongs(artistId),
            getArtistAlbums(artistId, 20),
        ]).then(([detail, songs, albumList]) => {
            if (cancelled) return;
            setArtist(detail);
            setTopSongs(songs);
            setAlbums(albumList);
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [artistId]);

    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), 2200);
        return () => clearTimeout(t);
    }, [toast]);

    const playSong = useCallback(async (song: NeteaseSearchResult) => {
        setPendingSongId(song.id);
        const url = await getNeteasePlayUrl(song.id);
        if (!url) {
            setPendingSongId(null);
            setToast("这首歌暂时无法播放");
            return;
        }
        const [detail, lyrics] = await Promise.all([
            getNeteaseSongDetail(song.id).catch(() => null),
            getNeteaseLyrics(song.id).catch(() => ""),
        ]);
        const track: MusicTrack = {
            id: `netease_${song.id}`,
            title: detail?.name || song.name,
            artist: detail?.artists || song.artists,
            duration: song.duration / 1000,
            coverUrl: detail?.coverUrl || song.coverUrl,
            lyrics,
            liked: false,
            addedAt: new Date().toISOString(),
        };
        if (!player.queue.some(t => t.id === track.id)) {
            player.setQueue([track, ...player.queue]);
        }
        player.playUrl(url, track);
        setPendingSongId(null);
    }, [player]);

    const stats = artist
        ? [
            artist.musicSize ? `歌曲 ${artist.musicSize}` : "",
            artist.albumSize ? `专辑 ${artist.albumSize}` : "",
            artist.fansCount ? `粉丝 ${formatFans(artist.fansCount)}` : "",
        ].filter(Boolean).join(" · ")
        : "";

    return (
        <div className="mart-page">
            {/* Hero */}
            <div className="mart-hero">
                {artist?.cover && <img src={artist.cover} alt="" className="mart-hero-img" />}
                <div className="mart-hero-fade" />
                <div className="mart-nav">
                    <button className="music-player-close" onClick={onClose}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <path d="M15 19 8 12l7-7" />
                        </svg>
                    </button>
                </div>
                <div className="mart-id">
                    <div className="mart-name">{artist?.name || artistName}</div>
                    {stats && <div className="mart-stats">{stats}</div>}
                </div>
            </div>

            <div className="mart-body">
                {loading ? (
                    <div className="mcmt-hint">加载歌手信息...</div>
                ) : (
                    <>
                        {artist?.briefDesc && (
                            <div className="mart-desc">{artist.briefDesc}</div>
                        )}

                        {topSongs.length > 0 && (
                            <>
                                <div className="mart-sec-head">
                                    <h4>热门歌曲</h4>
                                    <span>{topSongs.length} 首</span>
                                </div>
                                <div className="mart-songs">
                                    {topSongs.slice(0, 20).map((song, idx) => {
                                        const isCurrent = player.currentTrack?.id === `netease_${song.id}`;
                                        return (
                                            <button
                                                key={song.id}
                                                className="mart-song"
                                                {...(isCurrent ? { "data-current": "" } : {})}
                                                onClick={() => { void playSong(song); }}
                                            >
                                                <span className="mart-song-idx" {...(idx < 3 ? { "data-top": "" } : {})}>{idx + 1}</span>
                                                <span className="mart-song-info">
                                                    <b>{song.name}</b>
                                                    <i>{song.album || song.artists}</i>
                                                </span>
                                                {pendingSongId === song.id ? (
                                                    <span className="mart-song-dur">…</span>
                                                ) : (
                                                    <span className="mart-song-dur">{formatDuration(song.duration)}</span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        )}

                        {albums.length > 0 && (
                            <>
                                <div className="mart-sec-head">
                                    <h4>专辑</h4>
                                    <span>{albums.length} 张</span>
                                </div>
                                <div className="mart-albums">
                                    {albums.map(album => (
                                        <div key={album.id} className="mart-album">
                                            <div className="mart-album-cover">
                                                {album.coverUrl && <img src={album.coverUrl} alt="" />}
                                            </div>
                                            <div className="mart-album-name">{album.name}</div>
                                            {album.year && <div className="mart-album-year">{album.year}</div>}
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}

                        {topSongs.length === 0 && albums.length === 0 && (
                            <div className="mcmt-hint">没有获取到歌手作品</div>
                        )}
                    </>
                )}
            </div>

            {toast && <div className="music-toast music-toast-err mcmt-toast">{toast}</div>}
        </div>
    );
}
