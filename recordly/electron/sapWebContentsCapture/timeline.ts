import type { CursorInteractionType, CursorVisualType } from "../ipc/types";

export const RAW_ACTION_TIMELINE_SCHEMA_VERSION = 2;
export const RAW_ACTION_TIMELINE_SOURCE_CLOCK = "capture-session-monotonic" as const;

export type RawActionEventType =
	| "click"
	| "tab-switch"
	| "input"
	| "change"
	| "focus"
	| "keydown"
	| "keyup"
	| "navigation";

export type RawActionRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type RawActionPoint = {
	x: number;
	y: number;
};

export type RawActionViewport = {
	width: number;
	height: number;
	devicePixelRatio: number;
	scrollX: number;
	scrollY: number;
};

export type RawActionFrame = {
	frameId: string;
	parentFrameId?: string;
	origin: string;
	isMainFrame: boolean;
};

export type RawActionTarget = {
	targetId?: string;
	selector?: string;
	controlType?: string;
	name?: string;
	text?: string;
	cursorType?: CursorVisualType;
	rect: RawActionRect;
	point: RawActionPoint;
	normalizedPoint: RawActionPoint;
};

export type RawActionEvent = {
	eventId: string;
	type: RawActionEventType;
	sourceTimeMs: number;
	documentId?: string;
	url?: string;
	frame?: RawActionFrame;
	text?: string;
	target?: RawActionTarget;
	viewport?: RawActionViewport;
	navigationType?: string;
	sourceEventType?: string;
	key?: {
		key?: string;
		code?: string;
		repeat?: boolean;
		ctrlKey?: boolean;
		metaKey?: boolean;
		altKey?: boolean;
		shiftKey?: boolean;
	};
};

export type CursorSample = {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType: CursorInteractionType;
	cursorType?: CursorVisualType;
};

export type RawActionTimelineDocument = {
	schemaVersion: typeof RAW_ACTION_TIMELINE_SCHEMA_VERSION;
	source: "Recordly built-in SAP Browser CDP isolated-world collector";
	sourceClock: typeof RAW_ACTION_TIMELINE_SOURCE_CLOCK;
	sessionId: string;
	sourceWebContentsId: number;
	eventCount: number;
	timeline: RawActionEvent[];
	captureGeometry?: {
		viewport?: RawActionViewport;
		contentRect: { x: number; y: number; width: number; height: number };
	};
};

export type CursorSidecarDocument = {
	version: 3;
	mode: "browser-action-timeline";
	sourceClock: typeof RAW_ACTION_TIMELINE_SOURCE_CLOCK;
	samples: CursorSample[];
};

export interface MonotonicSessionClock {
	nowMs(): number;
}

export function createMonotonicSessionClock(
	nowNs: () => bigint = () => process.hrtime.bigint(),
): MonotonicSessionClock {
	const startedAtNs = nowNs();
	return {
		nowMs: () => Math.max(0, Number(nowNs() - startedAtNs) / 1_000_000),
	};
}

function assertPlainObject(
	value: unknown,
	label: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
}

function safeText(value: unknown, label: string, maximumLength: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
	if (!normalized || normalized.length > maximumLength) {
		throw new Error(`${label} must contain 1-${maximumLength} visible characters.`);
	}
	return normalized;
}

function optionalText(value: unknown, label: string, maximumLength: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return safeText(value, label, maximumLength);
}

function finiteNumber(value: unknown, label: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new Error(`${label} must be a finite number >= ${minimum}.`);
	}
	return value;
}

function normalizeRect(value: unknown, label: string): RawActionRect {
	assertPlainObject(value, label);
	return {
		x: finiteNumber(value.x, `${label}.x`),
		y: finiteNumber(value.y, `${label}.y`),
		width: finiteNumber(value.width, `${label}.width`, 0.01),
		height: finiteNumber(value.height, `${label}.height`, 0.01),
	};
}

function normalizePoint(value: unknown, label: string): RawActionPoint {
	assertPlainObject(value, label);
	return {
		x: finiteNumber(value.x, `${label}.x`),
		y: finiteNumber(value.y, `${label}.y`),
	};
}

function normalizeViewport(value: unknown): RawActionViewport {
	assertPlainObject(value, "viewport");
	return {
		width: finiteNumber(value.width, "viewport.width", 1),
		height: finiteNumber(value.height, "viewport.height", 1),
		devicePixelRatio: finiteNumber(
			value.devicePixelRatio ?? 1,
			"viewport.devicePixelRatio",
			0.1,
		),
		scrollX: finiteNumber(value.scrollX ?? 0, "viewport.scrollX"),
		scrollY: finiteNumber(value.scrollY ?? 0, "viewport.scrollY"),
	};
}

function normalizeCursorType(value: unknown): CursorVisualType | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const allowed: readonly CursorVisualType[] = [
		"arrow",
		"text",
		"pointer",
		"crosshair",
		"open-hand",
		"closed-hand",
		"resize-ew",
		"resize-ns",
		"not-allowed",
	];
	if (!allowed.includes(value as CursorVisualType))
		throw new Error("target.cursorType is invalid.");
	return value as CursorVisualType;
}

function normalizeTarget(value: unknown): RawActionTarget | undefined {
	if (value === undefined || value === null) return undefined;
	assertPlainObject(value, "target");
	const rect = normalizeRect(value.rect, "target.rect");
	const point = normalizePoint(value.point, "target.point");
	const normalizedPoint = normalizePoint(value.normalizedPoint, "target.normalizedPoint");
	if (normalizedPoint.x > 1 || normalizedPoint.y > 1) {
		throw new Error("target.normalizedPoint must be within the viewport.");
	}
	return {
		targetId: optionalText(value.targetId, "target.targetId", 200),
		selector: optionalText(value.selector, "target.selector", 800),
		controlType: optionalText(value.controlType, "target.controlType", 120),
		name: optionalText(value.name, "target.name", 300),
		text: optionalText(value.text, "target.text", 300),
		cursorType: normalizeCursorType(value.cursorType),
		rect,
		point,
		normalizedPoint,
	};
}

function normalizeKey(value: unknown): RawActionEvent["key"] {
	if (value === undefined || value === null) return undefined;
	assertPlainObject(value, "key");
	return {
		key: optionalText(value.key, "key.key", 80),
		code: optionalText(value.code, "key.code", 80),
		repeat: value.repeat === true,
		ctrlKey: value.ctrlKey === true,
		metaKey: value.metaKey === true,
		altKey: value.altKey === true,
		shiftKey: value.shiftKey === true,
	};
}

function sanitizeUrl(value: unknown): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = new URL(safeText(value, "url", 4096));
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Only HTTP(S) URLs are accepted in the action timeline.");
	}
	parsed.username = "";
	parsed.password = "";
	parsed.search = "";
	parsed.hash = "";
	return parsed.origin;
}

function normalizeFrame(value: unknown): RawActionFrame | undefined {
	if (value === undefined || value === null) return undefined;
	assertPlainObject(value, "frame");
	const frameId = safeText(value.frameId, "frame.frameId", 240);
	const parentFrameId = optionalText(value.parentFrameId, "frame.parentFrameId", 240);
	const origin = sanitizeUrl(value.origin);
	if (!origin) throw new Error("frame.origin is required.");
	if (typeof value.isMainFrame !== "boolean") {
		throw new Error("frame.isMainFrame must be a boolean.");
	}
	if (value.isMainFrame === Boolean(parentFrameId)) {
		throw new Error("frame parent identity does not match frame.isMainFrame.");
	}
	return {
		frameId,
		...(parentFrameId ? { parentFrameId } : {}),
		origin,
		isMainFrame: value.isMainFrame,
	};
}

const EVENT_TYPES = new Set<RawActionEventType>([
	"click",
	"tab-switch",
	"input",
	"change",
	"focus",
	"keydown",
	"keyup",
	"navigation",
]);

function normalizeEvent(value: unknown): RawActionEvent {
	assertPlainObject(value, "timeline event");
	const type = value.type;
	if (!EVENT_TYPES.has(type as RawActionEventType)) {
		throw new Error(`Unsupported timeline event type: ${String(type)}.`);
	}
	const viewport = value.viewport === undefined ? undefined : normalizeViewport(value.viewport);
	const target = normalizeTarget(value.target);
	const frame = normalizeFrame(value.frame);
	const documentId = optionalText(value.documentId, "documentId", 160);
	const url = sanitizeUrl(value.url);
	if (frame && !documentId) throw new Error("Frame telemetry requires a documentId.");
	if (frame && url && frame.origin !== url) {
		throw new Error("Frame telemetry URL must match the trusted frame origin.");
	}
	if (
		viewport &&
		target &&
		(target.rect.x + target.rect.width > viewport.width + 2 ||
			target.rect.y + target.rect.height > viewport.height + 2 ||
			target.point.x > viewport.width ||
			target.point.y > viewport.height)
	) {
		throw new Error("Timeline target geometry falls outside the declared viewport.");
	}
	return {
		eventId: safeText(value.eventId, "eventId", 240),
		type: type as RawActionEventType,
		sourceTimeMs: finiteNumber(value.sourceTimeMs, "sourceTimeMs"),
		documentId,
		url,
		frame,
		text: optionalText(value.text, "text", 300),
		target,
		viewport,
		navigationType: optionalText(value.navigationType, "navigationType", 80),
		sourceEventType: optionalText(value.sourceEventType, "sourceEventType", 80),
		key: normalizeKey(value.key),
	};
}

function eventTargetKey(event: RawActionEvent): string {
	const target = event.target;
	return (
		target?.targetId ||
		target?.selector ||
		`${target?.name || ""}:${target?.controlType || ""}:${target?.normalizedPoint.x ?? ""}:${target?.normalizedPoint.y ?? ""}`
	);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function cursorSamplesForTimeline(events: readonly RawActionEvent[]): CursorSample[] {
	const samples: CursorSample[] = [];
	let previousPoint = { x: 0.5, y: 0.5 };
	let previousTargetKey = "";
	let previousTimeMs = -1;
	const push = (
		timeMs: number,
		point: RawActionPoint,
		interactionType: CursorInteractionType,
		cursorType?: CursorVisualType,
	) => {
		const normalizedTimeMs = Math.max(previousTimeMs + 1, Math.round(Math.max(0, timeMs)));
		samples.push({
			timeMs: normalizedTimeMs,
			cx: clamp(point.x, 0, 1),
			cy: clamp(point.y, 0, 1),
			interactionType,
			...(cursorType ? { cursorType } : {}),
		});
		previousTimeMs = normalizedTimeMs;
	};

	for (const event of events) {
		if (
			!["click", "tab-switch", "focus", "input", "change", "keydown", "keyup"].includes(
				event.type,
			)
		) {
			continue;
		}
		const target = event.target;
		if (!target) continue;
		const point = target.normalizedPoint;
		const targetKey = eventTargetKey(event);
		const sameTarget =
			targetKey === previousTargetKey ||
			(Math.abs(point.x - previousPoint.x) < 0.002 &&
				Math.abs(point.y - previousPoint.y) < 0.002);
		if (!sameTarget) {
			push(Math.max(0, event.sourceTimeMs - 1_400), previousPoint, "move", target.cursorType);
			push(Math.max(0, event.sourceTimeMs - 1_000), point, "move", target.cursorType);
		} else if (event.type !== "click" && event.type !== "tab-switch") {
			push(event.sourceTimeMs, point, "move", target.cursorType);
		}

		if (event.type === "click" || event.type === "tab-switch") {
			push(event.sourceTimeMs, point, "click", target.cursorType);
			push(event.sourceTimeMs + 80, point, "mouseup", target.cursorType);
		}
		previousPoint = point;
		previousTargetKey = targetKey;
	}

	return samples;
}

export class RawActionTimeline {
	private readonly events: RawActionEvent[] = [];
	private readonly eventIds = new Set<string>();
	private mainEventSequence = 0;

	constructor(
		readonly sessionId: string,
		readonly sourceWebContentsId: number,
		private readonly clock: MonotonicSessionClock,
	) {}

	addBrowserBatch(payload: unknown): { accepted: number; duplicate: boolean } {
		assertPlainObject(payload, "telemetry batch");
		if (payload.sessionId !== this.sessionId) throw new Error("Telemetry sessionId mismatch.");
		if (payload.schemaVersion !== RAW_ACTION_TIMELINE_SCHEMA_VERSION) {
			throw new Error(
				`Telemetry schemaVersion must be ${RAW_ACTION_TIMELINE_SCHEMA_VERSION}.`,
			);
		}
		if (payload.sourceClock !== RAW_ACTION_TIMELINE_SOURCE_CLOCK) {
			throw new Error("Telemetry sourceClock must be capture-session-monotonic.");
		}
		if (
			!Array.isArray(payload.events) ||
			payload.events.length === 0 ||
			payload.events.length > 2_000
		) {
			throw new Error("Telemetry batch must contain 1-2000 events.");
		}
		const normalized = payload.events.map(normalizeEvent);
		const duplicateCount = normalized.filter((event) =>
			this.eventIds.has(event.eventId),
		).length;
		if (duplicateCount === normalized.length) return { accepted: 0, duplicate: true };
		if (duplicateCount > 0)
			throw new Error("Telemetry retry mixes accepted and new event IDs.");
		for (const event of normalized) {
			this.eventIds.add(event.eventId);
			this.events.push(event);
		}
		return { accepted: normalized.length, duplicate: false };
	}

	addNavigation(navigationType: string, url?: string): void {
		const sourceTimeMs = this.clock.nowMs();
		const eventId = `${this.sessionId}:main-navigation:${this.mainEventSequence}`;
		this.mainEventSequence += 1;
		this.eventIds.add(eventId);
		this.events.push({
			eventId,
			type: "navigation",
			sourceTimeMs,
			url: sanitizeUrl(url),
			navigationType: safeText(navigationType, "navigationType", 80),
		});
	}

	snapshot(): RawActionEvent[] {
		return this.events
			.map((event, index) => ({ event, index }))
			.sort(
				(left, right) =>
					left.event.sourceTimeMs - right.event.sourceTimeMs || left.index - right.index,
			)
			.map(({ event }) => ({ ...event }));
	}

	toDocument(
		captureGeometry?: RawActionTimelineDocument["captureGeometry"],
	): RawActionTimelineDocument {
		return {
			schemaVersion: RAW_ACTION_TIMELINE_SCHEMA_VERSION,
			source: "Recordly built-in SAP Browser CDP isolated-world collector",
			sourceClock: RAW_ACTION_TIMELINE_SOURCE_CLOCK,
			sessionId: this.sessionId,
			sourceWebContentsId: this.sourceWebContentsId,
			eventCount: this.events.length,
			timeline: this.snapshot(),
			...(captureGeometry ? { captureGeometry } : {}),
		};
	}

	toCursorSidecar(): CursorSidecarDocument {
		return {
			version: 3,
			mode: "browser-action-timeline",
			sourceClock: RAW_ACTION_TIMELINE_SOURCE_CLOCK,
			samples: cursorSamplesForTimeline(this.snapshot()),
		};
	}
}
