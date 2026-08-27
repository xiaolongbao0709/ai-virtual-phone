import { loadChatAppSettings } from "./chat-storage";

export type NativeBatteryInfo = {
    level: number;
    charging: boolean;
};

export type NativeNetworkInfo = {
    type: "wifi" | "cellular" | "offline" | "other" | "unknown";
};

export type NativeLocationInfo = {
    latitude: number;
    longitude: number;
    placemark: string | null;
};

export type NativeDeviceBridge = {
    getBatteryInfo: () => Promise<NativeBatteryInfo>;
    getNetworkType: () => Promise<NativeNetworkInfo>;
    getLocation: () => Promise<NativeLocationInfo>;
    getUsageToday: () => Promise<{ seconds: number }>;
};

declare global {
    interface Window {
        NativeDevice?: NativeDeviceBridge;
    }
}

const NATIVE_DEVICE_TIMEOUT_MS = 4_000;
const locationPermissionDeniedSessions = new Set<string>();

function withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("native_device_timeout")), NATIVE_DEVICE_TIMEOUT_MS);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null && "message" in error) {
        const message = (error as { message?: unknown }).message;
        return typeof message === "string" ? message : "";
    }
    return "";
}

function isPermissionDenied(error: unknown): boolean {
    return errorMessage(error) === "permission_denied";
}

async function readBattery(): Promise<NativeBatteryInfo | null> {
    if (!(typeof window !== "undefined" && window.NativeDevice)) return null;
    if (typeof window.NativeDevice.getBatteryInfo !== "function") return null;
    try {
        return await withTimeout(window.NativeDevice.getBatteryInfo());
    } catch {
        return null;
    }
}

async function readNetwork(): Promise<NativeNetworkInfo | null> {
    if (!(typeof window !== "undefined" && window.NativeDevice)) return null;
    if (typeof window.NativeDevice.getNetworkType !== "function") return null;
    try {
        return await withTimeout(window.NativeDevice.getNetworkType());
    } catch {
        return null;
    }
}

async function readLocation(sessionId: string): Promise<NativeLocationInfo | null> {
    if (locationPermissionDeniedSessions.has(sessionId)) return null;
    if (!(typeof window !== "undefined" && window.NativeDevice)) return null;
    if (typeof window.NativeDevice.getLocation !== "function") return null;

    let request: Promise<NativeLocationInfo>;
    try {
        request = window.NativeDevice.getLocation();
    } catch (error) {
        if (isPermissionDenied(error)) locationPermissionDeniedSessions.add(sessionId);
        return null;
    }

    const trackedRequest = request.catch(error => {
        if (isPermissionDenied(error)) locationPermissionDeniedSessions.add(sessionId);
        throw error;
    });

    try {
        return await withTimeout(trackedRequest);
    } catch {
        return null;
    }
}

function normalizeBatteryInfo(value: NativeBatteryInfo | null): NativeBatteryInfo | null {
    if (!value || typeof value !== "object") return null;
    if (typeof value.level !== "number" || !Number.isFinite(value.level)) return null;
    if (typeof value.charging !== "boolean") return null;
    return {
        level: Math.round(Math.max(0, Math.min(100, value.level))),
        charging: value.charging,
    };
}

function normalizeNetworkInfo(value: NativeNetworkInfo | null): NativeNetworkInfo | null {
    if (!value || typeof value !== "object") return null;
    const allowed = new Set<NativeNetworkInfo["type"]>(["wifi", "cellular", "offline", "other", "unknown"]);
    return allowed.has(value.type) ? { type: value.type } : null;
}

function normalizeLocationInfo(value: NativeLocationInfo | null): NativeLocationInfo | null {
    if (!value || typeof value !== "object") return null;
    if (typeof value.latitude !== "number" || !Number.isFinite(value.latitude)) return null;
    if (typeof value.longitude !== "number" || !Number.isFinite(value.longitude)) return null;
    if (value.latitude < -90 || value.latitude > 90 || value.longitude < -180 || value.longitude > 180) return null;
    const placemark = typeof value.placemark === "string" ? value.placemark.trim() : null;
    return {
        latitude: value.latitude,
        longitude: value.longitude,
        placemark: placemark || null,
    };
}

function formatNetworkType(type: NativeNetworkInfo["type"]): string {
    switch (type) {
        case "wifi": return "Wi-Fi";
        case "cellular": return "蜂窝网络";
        case "offline": return "离线";
        case "other": return "其他网络";
        default: return "未知网络";
    }
}

/**
 * Reads only the device signals the user explicitly enabled and turns them
 * into a small, natural-language prompt hint. Nothing is persisted here.
 */
export async function getNativeDevicePromptContext(sessionId: string): Promise<string> {
    const settings = loadChatAppSettings();
    const reads: Promise<NativeBatteryInfo | NativeNetworkInfo | NativeLocationInfo | null>[] = [];
    const readKinds: Array<"battery" | "network" | "location"> = [];

    if (settings.nativeDeviceBatteryEnabled === true) {
        readKinds.push("battery");
        reads.push(readBattery());
    }
    if (settings.nativeDeviceNetworkEnabled === true) {
        readKinds.push("network");
        reads.push(readNetwork());
    }
    if (settings.nativeDeviceLocationEnabled === true) {
        readKinds.push("location");
        reads.push(readLocation(sessionId));
    }
    if (reads.length === 0) return "";

    const results = await Promise.allSettled(reads);
    const lines: string[] = [];
    results.forEach((result, index) => {
        if (result.status !== "fulfilled" || !result.value) return;
        const kind = readKinds[index];
        if (kind === "battery") {
            const battery = normalizeBatteryInfo(result.value as NativeBatteryInfo);
            if (battery) lines.push(`用户当前手机电量 ${battery.level}%，${battery.charging ? "正在充电" : "未在充电"}`);
        } else if (kind === "network") {
            const network = normalizeNetworkInfo(result.value as NativeNetworkInfo);
            if (network) lines.push(`用户当前网络类型为 ${formatNetworkType(network.type)}`);
        } else {
            const location = normalizeLocationInfo(result.value as NativeLocationInfo);
            if (!location) return;
            const description = location.placemark
                || `纬度 ${location.latitude.toFixed(4)}，经度 ${location.longitude.toFixed(4)}`;
            lines.push(`用户当前位置大致在：${description}`);
        }
    });

    if (lines.length === 0) return "";
    return [
        "以下是用户主动允许你感知的当前设备线索。它们只是背景信息：仅在对话自然相关时提及，不要机械复述或追问未提供的细节。",
        ...lines.map(line => `- ${line}`),
    ].join("\n");
}
