// lib/mixology/audio-player.ts
// 独家特调 · 宿主侧的音频播放。
//
// 机括的界面跑在沙盒 iframe 里，对白按钮却是宿主画的：玩家的那一下点击落在宿主文档上，
// iframe 拿不到这次手势，iOS Safari 会拦掉它随后的 audio.play()。所以播放由宿主来做——
// 点击时先在手势里把宿主的 <audio> 解锁（prime），机括合成完把音频递上来（mix.play），
// 宿主用这只已解锁的元素放。同一时刻只放一段，再放会先停上一段。

type PlayHooks = { onStart?: () => void; onEnd?: () => void; onError?: (message: string) => void };

let shared: HTMLAudioElement | null = null;
let unlocked = false;
let currentUrl = "";
let currentHooks: PlayHooks | null = null;

function element(): HTMLAudioElement {
    if (!shared) {
        shared = new Audio();
        shared.preload = "auto";
        shared.setAttribute("playsinline", "true");
    }
    return shared;
}

/** 一段极短的静音 wav：解锁用 */
function silentWavUrl(): string {
    const header = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
        0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
        0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x08, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    return URL.createObjectURL(new Blob([header], { type: "audio/wav" }));
}

/** 在用户手势里调：解锁宿主的播放元素。重复调无害 */
export function primeMixAudio(): void {
    if (typeof window === "undefined" || unlocked) return;
    const audio = element();
    // 正在放东西就别打断了：既然在放，说明早就解锁了
    if (!audio.paused && currentUrl) { unlocked = true; return; }
    const url = silentWavUrl();
    audio.muted = true;
    audio.src = url;
    const done = () => {
        try { audio.pause(); audio.currentTime = 0; } catch { /* ignore */ }
        audio.muted = false;
        URL.revokeObjectURL(url);
        unlocked = true;
    };
    audio.play().then(done, () => { audio.muted = false; URL.revokeObjectURL(url); });
}

function finish(kind: "end" | "error", message?: string): void {
    const hooks = currentHooks;
    currentHooks = null;
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = ""; }
    if (kind === "end") hooks?.onEnd?.();
    else hooks?.onError?.(message ?? "播放失败");
}

/** 停掉正在放的那段（没在放就什么都不做） */
export function stopMixAudio(): void {
    const audio = shared;
    if (!audio || !currentUrl) return;
    try { audio.pause(); } catch { /* ignore */ }
    audio.onended = null;
    audio.onerror = null;
    finish("end");
}

/** 放一段音频（Blob）。会先停掉上一段；onStart 在真正开始出声时回调 */
export function playMixAudio(blob: Blob, hooks: PlayHooks): void {
    stopMixAudio();
    const audio = element();
    const url = URL.createObjectURL(blob);
    currentUrl = url;
    currentHooks = hooks;
    audio.muted = false;
    audio.src = url;
    audio.onended = () => { if (currentUrl === url) finish("end"); };
    audio.onerror = () => { if (currentUrl === url) finish("error", "音频无法解码或播放"); };
    audio.play().then(
        () => { if (currentUrl === url) hooks.onStart?.(); },
        (err: unknown) => {
            if (currentUrl !== url) return;
            const name = err instanceof Error ? err.name : "";
            finish("error", name === "NotAllowedError" ? "浏览器拦住了播放，再点一次" : "播放失败");
        },
    );
}
