import { showCursor } from "../cursorHider";
import { activateBrowserCaptureMode } from "../browserCapture/runtime";
import { stopWindowBoundsCapture } from "../ipc/cursor/bounds";
import { stopInteractionCapture } from "../ipc/cursor/interaction";
import { stopNativeCursorMonitor } from "../ipc/cursor/monitor";
import { stopCursorCapture } from "../ipc/cursor/telemetry";
import {
	setActiveCursorSamples,
	setIsCursorCaptureActive,
	setPendingCursorSamples,
} from "../ipc/state";

/**
 * A SAP run is driven exclusively by the current SAP WebContents. Its timeline
 * must never contain foreground desktop-mouse telemetry.
 */
export function enterSapWebContentsCaptureMode(): void {
	activateBrowserCaptureMode();
	setIsCursorCaptureActive(false);
	stopCursorCapture();
	stopInteractionCapture();
	stopWindowBoundsCapture();
	stopNativeCursorMonitor();
	setActiveCursorSamples([]);
	setPendingCursorSamples([]);
	showCursor();
}
