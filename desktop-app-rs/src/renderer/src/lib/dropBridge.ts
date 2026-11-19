/** Helpers of the Tauri drag-drop bridge (tauriApi.ts), kept pure so they are unit-tested. */

/** A pending drop older than this is stale and never used. */
export const PENDING_DROP_TTL_MS = 5000;

/** True on macOS (guards for non-browser environments). */
export function isMacPlatform(): boolean {
    if (typeof navigator === 'undefined') return false;

    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '';

    return /Mac/i.test(platform);
}

/**
 * Tauri's drag-drop `position` as a CSS-pixel point. wry reports logical (CSS) pixels on macOS
 * (despite the "physical" label) and physical pixels elsewhere, which are divided by the device
 * pixel ratio (1 when it is missing).
 */
export function dropPositionToCss(
    position: { x: number; y: number },
    devicePixelRatio: number | undefined,
    isMac: boolean,
): { x: number; y: number } {
    if (isMac) return { x: position.x, y: position.y };

    const scale = devicePixelRatio && devicePixelRatio > 0 ? devicePixelRatio : 1;

    return { x: position.x / scale, y: position.y / scale };
}

let pendingDrop: { paths: string[]; at: number } | null = null;

/** Remembers the paths of the Tauri drop that is about to be dispatched as a DOM `drop`. */
export function setPendingDrop(paths: readonly string[], now: number = Date.now()): void {
    pendingDrop = { paths: [...paths], at: now };
}

export function clearPendingDrop(): void {
    pendingDrop = null;
}

/** The pending paths when fresh; always consumed (cleared), so they are used at most once. */
export function takePendingDrop(now: number = Date.now()): string[] {
    const pending = pendingDrop;

    pendingDrop = null;

    return pending !== null && now - pending.at < PENDING_DROP_TTL_MS ? pending.paths : [];
}
