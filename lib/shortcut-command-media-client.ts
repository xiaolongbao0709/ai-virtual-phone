const cleanupUrls = new Map<string, string>();

export function registerShortcutCommandMediaCleanup(commandId: string, url: string): void {
    if (!commandId || !url) return;
    cleanupUrls.set(commandId, url);
}

export function cleanupShortcutCommandMedia(commandId: string): void {
    const url = cleanupUrls.get(commandId);
    if (!url) return;
    cleanupUrls.delete(commandId);
    void fetch(url, { method: "DELETE", cache: "no-store" }).catch(() => undefined);
}

export function deleteShortcutCommandMediaUrl(url: string): void {
    if (!url) return;
    void fetch(url, { method: "DELETE", cache: "no-store" }).catch(() => undefined);
}
