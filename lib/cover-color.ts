// lib/cover-color.ts — Extract ambient colors from album cover art
// Used by the full-screen player to tint its flowing background per track.

export type CoverPalette = [string, string, string];

/** Fallback aurora palette when the cover can't be sampled (CORS, no cover, error). */
export const DEFAULT_COVER_PALETTE: CoverPalette = [
    "rgba(88, 116, 196, 0.55)",
    "rgba(122, 96, 202, 0.42)",
    "rgba(66, 134, 160, 0.38)",
];

const paletteCache = new Map<string, CoverPalette>();

/** Clamp channel brightness so ambient blobs stay moody on the dark ground. */
function tone(r: number, g: number, b: number, alpha: number): string {
    const max = Math.max(r, g, b, 1);
    // Normalize very bright covers down, lift very dark ones slightly
    const target = 170;
    const scale = max > target ? target / max : max < 60 ? 1.6 : 1;
    const c = (v: number) => Math.round(Math.min(255, v * scale));
    return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${alpha})`;
}

/**
 * Sample three ambient colors from a cover image.
 * Requires the image host to allow anonymous CORS (Netease CDN does);
 * resolves with the default palette on any failure.
 */
export function extractCoverPalette(coverUrl?: string | null): Promise<CoverPalette> {
    if (typeof window === "undefined" || !coverUrl) return Promise.resolve(DEFAULT_COVER_PALETTE);
    const cached = paletteCache.get(coverUrl);
    if (cached) return Promise.resolve(cached);

    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        const finish = (palette: CoverPalette) => {
            paletteCache.set(coverUrl, palette);
            resolve(palette);
        };
        img.onerror = () => finish(DEFAULT_COVER_PALETTE);
        img.onload = () => {
            try {
                const size = 24;
                const canvas = document.createElement("canvas");
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d");
                if (!ctx) { finish(DEFAULT_COVER_PALETTE); return; }
                ctx.drawImage(img, 0, 0, size, size);
                const { data } = ctx.getImageData(0, 0, size, size);
                // Average three horizontal bands → top / middle / bottom hues
                const bands: [number, number, number, number][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
                for (let y = 0; y < size; y++) {
                    const band = Math.min(2, Math.floor((y / size) * 3));
                    for (let x = 0; x < size; x++) {
                        const i = (y * size + x) * 4;
                        bands[band][0] += data[i];
                        bands[band][1] += data[i + 1];
                        bands[band][2] += data[i + 2];
                        bands[band][3]++;
                    }
                }
                const alphas = [0.55, 0.42, 0.38];
                finish(bands.map((b, i) =>
                    tone(b[0] / b[3], b[1] / b[3], b[2] / b[3], alphas[i]),
                ) as CoverPalette);
            } catch {
                // Canvas tainted (no CORS) or decode failure
                finish(DEFAULT_COVER_PALETTE);
            }
        };
        img.src = coverUrl;
    });
}
