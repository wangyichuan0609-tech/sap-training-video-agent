import fs from "node:fs/promises";
import path from "node:path";
import {
	CURSOR_SAMPLE_INTERVAL_MS,
	CURSOR_TELEMETRY_VERSION,
	MAX_CURSOR_SAMPLES,
} from "../constants";
import {
	activeCursorSamples,
	currentCursorVisualType,
	cursorCaptureAccumulatedPausedMs,
	cursorCaptureInterval,
	cursorCapturePauseStartedAtMs,
	cursorCaptureStartTimeMs,
	isCursorCaptureActive,
	linuxCursorScreenPoint,
	pendingCursorSamples,
	selectedSource,
	selectedWindowBounds,
	setActiveCursorSamples,
	setCursorCaptureAccumulatedPausedMs,
	setCursorCaptureInterval,
	setCursorCapturePauseStartedAtMs,
	setPendingCursorSamples,
} from "../state";
import type { CursorInteractionType, CursorTelemetryPoint, CursorVisualType } from "../types";
import { getScreen, getTelemetryPathForVideo, parseJsonWithByteOrderMark } from "../utils";

const RAW_MASTER_WIDTH = 1920;
const RAW_MASTER_HEIGHT = 1080;

type BrowserCaptureGeometry = {
	viewport?: {
		width?: unknown;
		height?: unknown;
	};
	contentRect?: {
		x?: unknown;
		y?: unknown;
		width?: unknown;
		height?: unknown;
	};
};

function finitePositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveBrowserCaptureContentRect(
	captureGeometry: BrowserCaptureGeometry | null | undefined,
	sourceWidth = RAW_MASTER_WIDTH,
	sourceHeight = RAW_MASTER_HEIGHT,
) {
	const viewport = captureGeometry?.viewport;
	if (
		!finitePositiveNumber(viewport?.width) ||
		!finitePositiveNumber(viewport?.height) ||
		!finitePositiveNumber(sourceWidth) ||
		!finitePositiveNumber(sourceHeight)
	) {
		return null;
	}

	const reported = captureGeometry?.contentRect;
	const reportedX = reported?.x;
	const reportedY = reported?.y;
	const reportedWidth = reported?.width;
	const reportedHeight = reported?.height;
	const hasReportedRect =
		typeof reportedX === "number" &&
		Number.isFinite(reportedX) &&
		typeof reportedY === "number" &&
		Number.isFinite(reportedY) &&
		finitePositiveNumber(reportedWidth) &&
		finitePositiveNumber(reportedHeight);
	const reportedRect = hasReportedRect
		? {
				x: reportedX as number,
				y: reportedY as number,
				width: reportedWidth as number,
				height: reportedHeight as number,
		  }
		: { x: 0, y: 0, width: sourceWidth, height: sourceHeight };

	const reportedIsFullFrame =
		Math.abs(reportedRect.x) < 0.5 &&
		Math.abs(reportedRect.y) < 0.5 &&
		Math.abs(reportedRect.width - sourceWidth) < 0.5 &&
		Math.abs(reportedRect.height - sourceHeight) < 0.5;
	const sourceAspect = sourceWidth / sourceHeight;
	const viewportAspect = (viewport.width as number) / (viewport.height as number);
	if (reportedIsFullFrame && Math.abs(sourceAspect - viewportAspect) > 0.01) {
		const scale = Math.min(sourceWidth / (viewport.width as number), sourceHeight / (viewport.height as number));
		const width = (viewport.width as number) * scale;
		const height = (viewport.height as number) * scale;
		return {
			x: (sourceWidth - width) / 2,
			y: (sourceHeight - height) / 2,
			width,
			height,
		};
	}

	return reportedRect;
}

export function mapViewportCursorTelemetrySamples(
	rawSamples: unknown,
	captureGeometry: BrowserCaptureGeometry | null | undefined,
	sourceWidth = RAW_MASTER_WIDTH,
	sourceHeight = RAW_MASTER_HEIGHT,
): CursorTelemetryPoint[] {
	const normalizedSamples = normalizeCursorTelemetrySamples(rawSamples);
	const coordinateSpace =
		rawSamples && typeof rawSamples === "object" && !Array.isArray(rawSamples)
			? (rawSamples as { coordinateSpace?: unknown }).coordinateSpace
			: undefined;
	if (coordinateSpace === "source") return normalizedSamples;

	const viewport = captureGeometry?.viewport;
	const contentRect = resolveBrowserCaptureContentRect(captureGeometry, sourceWidth, sourceHeight);
	if (
		!contentRect ||
		!finitePositiveNumber(viewport?.width) ||
		!finitePositiveNumber(viewport?.height)
	) {
		return normalizedSamples;
	}

	return normalizedSamples.map((sample) => ({
		...sample,
		cx: clamp((contentRect.x + sample.cx * contentRect.width) / sourceWidth, 0, 1),
		cy: clamp((contentRect.y + sample.cy * contentRect.height) / sourceHeight, 0, 1),
	}));
}

export async function loadCursorTelemetryForVideo(videoPath: string) {
	const telemetryPath = getTelemetryPathForVideo(videoPath);
	const content = await fs.readFile(telemetryPath, "utf-8");
	const parsed = parseJsonWithByteOrderMark<unknown>(content);
	let captureGeometry: BrowserCaptureGeometry | null = null;
	try {
		const actionLogPath = path.join(path.dirname(videoPath), "action-log.json");
		const actionLogContent = await fs.readFile(actionLogPath, "utf-8");
		const actionLog = parseJsonWithByteOrderMark<{
			captureGeometry?: BrowserCaptureGeometry;
		}>(actionLogContent);
		captureGeometry = actionLog.captureGeometry ?? null;
	} catch {
		// Ordinary Recordly recordings do not have a Browser Action Timeline sidecar.
	}

	return mapViewportCursorTelemetrySamples(parsed, captureGeometry);
}

export function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export function normalizeCursorTelemetrySamples(rawSamples: unknown): CursorTelemetryPoint[] {
	const samples = Array.isArray(rawSamples)
		? rawSamples
		: Array.isArray((rawSamples as { samples?: unknown[] } | null | undefined)?.samples)
			? ((rawSamples as { samples: unknown[] }).samples ?? [])
			: [];
	const boundedSamples = samples.slice(0, MAX_CURSOR_SAMPLES);

	return boundedSamples
		.filter((sample: unknown) => Boolean(sample && typeof sample === "object"))
		.map((sample: unknown) => {
			const point = sample as Partial<CursorTelemetryPoint>;
			return {
				timeMs:
					typeof point.timeMs === "number" && Number.isFinite(point.timeMs)
						? Math.max(0, point.timeMs)
						: 0,
				cx:
					typeof point.cx === "number" && Number.isFinite(point.cx)
						? clamp(point.cx, 0, 1)
						: 0.5,
				cy:
					typeof point.cy === "number" && Number.isFinite(point.cy)
						? clamp(point.cy, 0, 1)
						: 0.5,
				interactionType:
					point.interactionType === "click" ||
					point.interactionType === "double-click" ||
					point.interactionType === "right-click" ||
					point.interactionType === "middle-click" ||
					point.interactionType === "move" ||
					point.interactionType === "mouseup"
						? point.interactionType
						: undefined,
				cursorType:
					point.cursorType === "arrow" ||
					point.cursorType === "text" ||
					point.cursorType === "pointer" ||
					point.cursorType === "crosshair" ||
					point.cursorType === "open-hand" ||
					point.cursorType === "closed-hand" ||
					point.cursorType === "resize-ew" ||
					point.cursorType === "resize-ns" ||
					point.cursorType === "not-allowed"
						? point.cursorType
						: undefined,
			};
		})
		.sort((a, b) => a.timeMs - b.timeMs);
}

export async function writeCursorTelemetry(videoPath: string, samples: unknown) {
	const telemetryPath = getTelemetryPathForVideo(videoPath);
	const normalizedSamples = normalizeCursorTelemetrySamples(samples);

	if (normalizedSamples.length === 0) {
		await fs.rm(telemetryPath, { force: true });
		return normalizedSamples;
	}

	await fs.writeFile(
		telemetryPath,
		JSON.stringify({ version: CURSOR_TELEMETRY_VERSION, samples: normalizedSamples }, null, 2),
		"utf-8",
	);

	return normalizedSamples;
}

export function stopCursorCapture() {
	if (cursorCaptureInterval) {
		clearTimeout(cursorCaptureInterval);
		setCursorCaptureInterval(null);
	}
}

export function resetCursorCaptureClock() {
	setCursorCaptureAccumulatedPausedMs(0);
	setCursorCapturePauseStartedAtMs(null);
}

export function isCursorCapturePaused() {
	return cursorCapturePauseStartedAtMs !== null;
}

export function pauseCursorCapture(pausedAtMs: number) {
	if (cursorCapturePauseStartedAtMs !== null) {
		return;
	}

	setCursorCapturePauseStartedAtMs(pausedAtMs);
}

export function pauseCursorCaptureAtBoundary(pausedAtMs: number) {
	if (cursorCapturePauseStartedAtMs !== null) {
		return;
	}

	const pausedElapsedMs = getCursorCaptureElapsedMs(pausedAtMs);
	setActiveCursorSamples(
		activeCursorSamples.filter((sample) => sample.timeMs <= pausedElapsedMs),
	);
	setCursorCapturePauseStartedAtMs(pausedAtMs);
}

export function resumeCursorCapture(resumedAtMs: number) {
	if (cursorCapturePauseStartedAtMs === null) {
		return;
	}

	const pauseDurationMs = Math.max(0, resumedAtMs - cursorCapturePauseStartedAtMs);
	setCursorCaptureAccumulatedPausedMs(cursorCaptureAccumulatedPausedMs + pauseDurationMs);
	setCursorCapturePauseStartedAtMs(null);
}

export function getCursorCaptureElapsedMs(nowMs = Date.now()) {
	if (!Number.isFinite(cursorCaptureStartTimeMs) || cursorCaptureStartTimeMs <= 0) {
		return 0;
	}

	const safeNowMs = Math.max(cursorCaptureStartTimeMs, nowMs);
	const activePauseDurationMs =
		cursorCapturePauseStartedAtMs === null
			? 0
			: Math.max(0, safeNowMs - cursorCapturePauseStartedAtMs);

	return Math.max(
		0,
		safeNowMs -
			cursorCaptureStartTimeMs -
			Math.max(0, cursorCaptureAccumulatedPausedMs) -
			activePauseDurationMs,
	);
}

export function getNormalizedCursorPoint() {
	const fallbackCursor = getScreen().getCursorScreenPoint();
	const linuxCursorCache = process.platform === "linux" ? linuxCursorScreenPoint : null;
	const isLinuxCacheFresh = !!linuxCursorCache && Date.now() - linuxCursorCache.updatedAt <= 1000;

	const primarySf =
		process.platform !== "darwin" ? getScreen().getPrimaryDisplay().scaleFactor || 1 : 1;

	const cursor = isLinuxCacheFresh
		? { x: linuxCursorCache.x / primarySf, y: linuxCursorCache.y / primarySf }
		: fallbackCursor;

	const windowBounds = selectedSource?.id?.startsWith("window:") ? selectedWindowBounds : null;
	if (windowBounds) {
		const sf =
			process.platform === "win32" || process.platform === "darwin"
				? 1
				: getScreen().getDisplayNearestPoint({
						x: windowBounds.x / primarySf,
						y: windowBounds.y / primarySf,
					}).scaleFactor || 1;
		const width = Math.max(1, windowBounds.width / sf);
		const height = Math.max(1, windowBounds.height / sf);

		return {
			cx: clamp((cursor.x - windowBounds.x / sf) / width, 0, 1),
			cy: clamp((cursor.y - windowBounds.y / sf) / height, 0, 1),
		};
	}

	const sourceDisplayId = Number(selectedSource?.display_id);
	const sourceDisplay = Number.isFinite(sourceDisplayId)
		? (getScreen()
				.getAllDisplays()
				.find((display) => display.id === sourceDisplayId) ?? null)
		: null;
	const display = sourceDisplay ?? getScreen().getDisplayNearestPoint(cursor);
	const bounds = display.bounds;
	const width = Math.max(1, bounds.width);
	const height = Math.max(1, bounds.height);

	const cx = clamp((cursor.x - bounds.x) / width, 0, 1);
	const cy = clamp((cursor.y - bounds.y) / height, 0, 1);
	return { cx, cy };
}

export function getHookCursorScreenPoint(
	event:
		| {
				x?: number;
				y?: number;
				data?: { x?: number; y?: number; screenX?: number; screenY?: number };
				screenX?: number;
				screenY?: number;
		  }
		| null
		| undefined,
): { x: number; y: number } | null {
	const rawX = event?.x ?? event?.data?.x ?? event?.screenX ?? event?.data?.screenX;
	const rawY = event?.y ?? event?.data?.y ?? event?.screenY ?? event?.data?.screenY;

	if (
		typeof rawX !== "number" ||
		!Number.isFinite(rawX) ||
		typeof rawY !== "number" ||
		!Number.isFinite(rawY)
	) {
		return null;
	}

	return { x: rawX, y: rawY };
}

export function pushCursorSample(
	cx: number,
	cy: number,
	timeMs: number,
	interactionType: CursorInteractionType = "move",
	cursorType?: CursorVisualType,
) {
	activeCursorSamples.push({
		timeMs: Math.max(0, timeMs),
		cx,
		cy,
		interactionType,
		cursorType: cursorType ?? currentCursorVisualType,
	} as CursorTelemetryPoint);

	if (activeCursorSamples.length > MAX_CURSOR_SAMPLES) {
		activeCursorSamples.shift();
	}
}

export function sampleCursorPoint() {
	const point = getNormalizedCursorPoint();
	pushCursorSample(point.cx, point.cy, getCursorCaptureElapsedMs(), "move");
}

export async function persistPendingCursorTelemetry(videoPath: string) {
	const telemetryPath = getTelemetryPathForVideo(videoPath);
	if (pendingCursorSamples.length > 0) {
		await fs.writeFile(
			telemetryPath,
			JSON.stringify(
				{ version: CURSOR_TELEMETRY_VERSION, samples: pendingCursorSamples },
				null,
				2,
			),
			"utf-8",
		);
	}
	setPendingCursorSamples([]);
}

export function snapshotCursorTelemetryForPersistence() {
	if (activeCursorSamples.length === 0) {
		return;
	}

	if (pendingCursorSamples.length === 0) {
		setPendingCursorSamples([...activeCursorSamples]);
		return;
	}

	const lastPendingTimeMs = pendingCursorSamples[pendingCursorSamples.length - 1]?.timeMs ?? -1;
	setPendingCursorSamples([
		...pendingCursorSamples,
		...activeCursorSamples.filter((sample) => sample.timeMs > lastPendingTimeMs),
	]);
}

export function startCursorSampling() {
	stopCursorCapture();

	// Use recursive setTimeout with drift compensation instead of setInterval.
	// Under CPU load setInterval bunches or skips callbacks, creating large gaps
	// in telemetry data.  This approach measures wall-clock drift each tick and
	// adjusts the next delay so samples stay close to the target interval.
	let nextExpectedMs = Date.now() + CURSOR_SAMPLE_INTERVAL_MS;

	const tick = () => {
		if (isCursorCaptureActive && !isCursorCapturePaused()) {
			sampleCursorPoint();
		}

		const now = Date.now();
		const drift = now - nextExpectedMs;
		nextExpectedMs += CURSOR_SAMPLE_INTERVAL_MS;

		// If we fell behind by more than one full interval, reset the baseline
		// so we don't try to "catch up" with a burst of rapid samples.
		if (drift > CURSOR_SAMPLE_INTERVAL_MS) {
			nextExpectedMs = now + CURSOR_SAMPLE_INTERVAL_MS;
		}

		const delay = Math.max(1, nextExpectedMs - now);
		setCursorCaptureInterval(setTimeout(tick, delay));
	};

	setCursorCaptureInterval(setTimeout(tick, CURSOR_SAMPLE_INTERVAL_MS));
}

export { CURSOR_SAMPLE_INTERVAL_MS } from "../constants";
// Re-export for consumers that use it from this module
export { getTelemetryPathForVideo } from "../utils";
