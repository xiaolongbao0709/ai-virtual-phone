// lib/floating-dock-store.ts
// Lightweight global store for coordinating floating tools (Prompt Viewer & Quick Action)
// in edge-docking and horizontal-expanding modes.

export type DockSide = "left" | "right";

export type FloatingDockPosition = {
    left: number;
    top: number;
    dockSide?: DockSide;
};

export type ActiveFloatingTool = "none" | "quick-action" | "prompt-viewer";
export type PrimaryFloatingTool = "quick-action" | "prompt-viewer";

const PRIMARY_TOOL_STORAGE_KEY = "phone_primary_floating_tool";
const ANCHOR_STORAGE_KEY = "phone_floating_dock_anchor";

function getInitialPrimaryTool(): PrimaryFloatingTool {
    if (typeof window === "undefined") return "quick-action";
    try {
        const stored = localStorage.getItem(PRIMARY_TOOL_STORAGE_KEY);
        if (stored === "prompt-viewer" || stored === "quick-action") return stored;
    } catch {
        // ignore
    }
    return "quick-action";
}

function getInitialAnchor(): FloatingDockPosition | null {
    if (typeof window === "undefined") return null;
    try {
        const stored = localStorage.getItem(ANCHOR_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (typeof parsed?.left === "number" && typeof parsed?.top === "number") {
                return parsed;
            }
        }
    } catch {
        // ignore
    }
    return null;
}

export type FloatingDockState = {
    /** Whether the floating dock is currently docked/snapped to the edge */
    isDocked: boolean;
    /** Whether the dock is expanded horizontally showing both tools for selection */
    isExpanded: boolean;
    /** Which side of the screen the dock is docked on ("left" | "right") */
    dockSide: DockSide;
    /** Position anchor of the primary floating ball */
    anchorPosition: FloatingDockPosition | null;
    /** Which tool currently has its window/panel open */
    activeTool: ActiveFloatingTool;
    /** Which tool was most recently opened/used and serves as the single docked ball */
    primaryTool: PrimaryFloatingTool;
};

const _initialAnchor = getInitialAnchor();
let _dockState: FloatingDockState = {
    isDocked: true,
    isExpanded: false,
    dockSide: _initialAnchor?.dockSide || "right",
    anchorPosition: _initialAnchor,
    activeTool: "none",
    primaryTool: getInitialPrimaryTool(),
};

const _listeners = new Set<() => void>();
let _autoCollapseTimer: ReturnType<typeof setTimeout> | null = null;

function notifyListeners() {
    _listeners.forEach(fn => fn());
}

export function getFloatingDockState(): FloatingDockState {
    return _dockState;
}

export function subscribeFloatingDockState(fn: () => void): () => void {
    _listeners.add(fn);
    return () => {
        _listeners.delete(fn);
    };
}

/** Set position anchor of the primary dock button (syncs position and dockSide to paired buttons) */
export function setFloatingDockAnchor(pos: FloatingDockPosition | null): void {
    const nextDockSide = pos?.dockSide || _dockState.dockSide;
    if (
        _dockState.anchorPosition?.left === pos?.left &&
        _dockState.anchorPosition?.top === pos?.top &&
        _dockState.dockSide === nextDockSide
    ) {
        return;
    }
    if (pos) {
        try {
            localStorage.setItem(ANCHOR_STORAGE_KEY, JSON.stringify(pos));
        } catch {
            // ignore
        }
    }
    _dockState = {
        ..._dockState,
        dockSide: nextDockSide,
        anchorPosition: pos,
    };
    notifyListeners();
}

/** Explicitly update the dock side ("left" | "right") */
export function setFloatingDockSide(side: DockSide): void {
    if (_dockState.dockSide === side) return;
    _dockState = {
        ..._dockState,
        dockSide: side,
    };
    notifyListeners();
}

/** Set the active open tool ("none" | "quick-action" | "prompt-viewer") */
export function setActiveFloatingTool(tool: ActiveFloatingTool): void {
    clearCollapseTimer();
    const nextPrimary = tool === "none" ? _dockState.primaryTool : tool;
    if (tool !== "none") {
        try {
            localStorage.setItem(PRIMARY_TOOL_STORAGE_KEY, tool);
        } catch {
            // ignore
        }
    }
    if (_dockState.activeTool === tool && _dockState.primaryTool === nextPrimary) return;
    _dockState = {
        ..._dockState,
        activeTool: tool,
        primaryTool: nextPrimary,
        isDocked: true,
        isExpanded: false,
    };
    notifyListeners();
}

/** Clear any pending auto-collapse timer */
function clearCollapseTimer() {
    if (_autoCollapseTimer) {
        clearTimeout(_autoCollapseTimer);
        _autoCollapseTimer = null;
    }
}

/** Expand the dock: slide out from edge and horizontally arrange balls */
export function expandFloatingDock(): void {
    clearCollapseTimer();
    _dockState = {
        ..._dockState,
        isDocked: false,
        isExpanded: true,
        activeTool: "none",
    };
    notifyListeners();

    // Auto-collapse after 5 seconds of no user interaction
    _autoCollapseTimer = setTimeout(() => {
        collapseFloatingDock();
    }, 5000);
}

/** Collapse the dock back to edge-docked half-hidden state */
export function collapseFloatingDock(): void {
    clearCollapseTimer();
    if (_dockState.isDocked && !_dockState.isExpanded && _dockState.activeTool === "none") return;
    _dockState = {
        ..._dockState,
        isDocked: true,
        isExpanded: false,
        activeTool: "none",
    };
    notifyListeners();
}

/** Mark dock as temporarily undocked (e.g. when panel/popover is actively open) */
export function setFloatingDockActive(): void {
    clearCollapseTimer();
    _dockState = {
        ..._dockState,
        isDocked: false,
        isExpanded: false,
    };
    notifyListeners();
}

/** Reset to default docked state */
export function resetFloatingDock(): void {
    clearCollapseTimer();
    _dockState = {
        isDocked: true,
        isExpanded: false,
        dockSide: "right",
        anchorPosition: null,
        activeTool: "none",
        primaryTool: getInitialPrimaryTool(),
    };
    notifyListeners();
}
