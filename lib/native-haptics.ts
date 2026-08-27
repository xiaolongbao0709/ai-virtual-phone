export type NativeHapticsBridge = {
    impact: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notify: (kind: "success" | "warning" | "error") => void;
    selection: () => void;
};

declare global {
    interface Window {
        NativeHaptics?: NativeHapticsBridge;
    }
}

export function triggerNativeSelectionHaptic(): void {
    if (!(typeof window !== "undefined" && window.NativeHaptics)) return;
    if (typeof window.NativeHaptics.selection !== "function") return;
    try {
        window.NativeHaptics.selection();
    } catch {
        // Haptics are an optional enhancement and must never affect the UI.
    }
}
