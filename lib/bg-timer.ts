// lib/bg-timer.ts
// Background-safe timers using a Web Worker heartbeat.
// Falls back to native setInterval/setTimeout when Worker is unavailable.

let worker: Worker | null = null;
const callbacks = new Map<string, () => void>();
let idCounter = 0;

function ensureWorker(): Worker | null {
    if (worker) return worker;
    if (typeof window === "undefined" || typeof Worker === "undefined") return null;
    try {
        worker = new Worker("/timer-worker.js");
        worker.onmessage = (e) => {
            if (e.data.type === "tick") {
                const cb = callbacks.get(e.data.id);
                if (cb) cb();
            }
        };
        worker.onerror = () => { worker = null; };
        return worker;
    } catch {
        return null;
    }
}

/** setInterval that survives background tab throttling. Returns a stop function. */
export function bgSetInterval(callback: () => void, ms: number): () => void {
    const w = ensureWorker();
    const id = `bgi_${++idCounter}`;

    if (w) {
        callbacks.set(id, callback);
        w.postMessage({ type: "start-interval", id, ms });
        return () => {
            callbacks.delete(id);
            w.postMessage({ type: "stop", id });
        };
    }

    // Fallback: native setInterval
    const nativeId = setInterval(callback, ms);
    return () => clearInterval(nativeId);
}

/** setTimeout that survives background tab throttling. Returns a cancel function. */
export function bgSetTimeout(callback: () => void, ms: number): () => void {
    const w = ensureWorker();
    const id = `bgt_${++idCounter}`;

    if (w) {
        callbacks.set(id, () => {
            callbacks.delete(id); // auto-cleanup after one fire
            callback();
        });
        w.postMessage({ type: "start-timeout", id, ms });
        return () => {
            callbacks.delete(id);
            w.postMessage({ type: "stop", id });
        };
    }

    // Fallback: native setTimeout
    const nativeId = setTimeout(callback, ms);
    return () => clearTimeout(nativeId);
}

/** Promise delay backed by the worker timer, with optional abort support. */
export function bgDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        let cancel: () => void = () => {};
        const onAbort = () => {
            cancel();
            reject(new DOMException("Aborted", "AbortError"));
        };
        cancel = bgSetTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Clean up the worker (call on app teardown). */
export function bgTimerCleanup(): void {
    if (worker) {
        worker.postMessage({ type: "stop-all" });
        worker.terminate();
        worker = null;
    }
    callbacks.clear();
}
