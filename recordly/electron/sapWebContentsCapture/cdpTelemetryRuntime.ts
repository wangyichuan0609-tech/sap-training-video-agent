import type { WebContents } from "electron";
import { acquireCdpFrameBridge } from "../sapWebContentsControl/cdpFrameBridge";
import type { MonotonicSessionClock, RawActionEvent, RawActionRect } from "./timeline";

const WORLD_NAME = "recordly.sap.telemetry.v1";
const BINDING_NAME = "__recordlySapTelemetryV1";
const COLLECTOR_STATE_KEY = "__recordlySapTelemetryCollectorV1";
const PAYLOAD_VERSION = 1;
const MAX_BINDING_PAYLOAD_BYTES = 64 * 1024;
const MAX_PENDING_BINDINGS = 2_000;
const BINDING_QUARANTINE_TIMEOUT_MS = 500;
const ROOT_VIEWPORT_CACHE_MS = 100;
const FRAME_DISCOVERY_TIMEOUT_MS = 2_000;

type CdpEvent = {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
};

type FrameDescriptor = {
	frameId: string;
	parentFrameId?: string;
	sessionId?: string;
	targetId?: string;
	url: string;
	origin: string;
	defaultContextId?: number;
	generation: number;
	isSessionRoot: boolean;
};

type CdpFrameBridgeShape = {
	send<T = Record<string, unknown>>(
		method: string,
		params?: Record<string, unknown>,
		sessionId?: string,
	): Promise<T>;
	subscribe(listener: (event: CdpEvent) => void): () => void;
	getFrames(): readonly FrameDescriptor[];
	getFrame(frameId: string): FrameDescriptor | undefined;
	mapFramePointToRoot(
		frameId: string,
		point: { x: number; y: number },
	): Promise<{ x: number; y: number }> | { x: number; y: number };
	mapFrameRectToRoot(
		frameId: string,
		rect: RawActionRect,
	): Promise<RawActionRect> | RawActionRect;
	isFrameCandidateAvailable(frameId: string): Promise<boolean> | boolean;
	waitForFramesReady(timeoutMs?: number): Promise<void>;
	assertHealthy(): void;
};

type BridgeLease = {
	bridge: CdpFrameBridgeShape;
	release(): void;
};

type IsolatedContext = {
	contextId: number;
	sessionId?: string;
	frameId: string;
	documentId: string;
	lastSequence: number;
};

type InstalledScript = {
	sessionId?: string;
	identifier: string;
};

type RootViewport = {
	width: number;
	height: number;
	devicePixelRatio: number;
	scrollX: number;
	scrollY: number;
};

type LocalTelemetryTarget = {
	targetId?: unknown;
	selector?: unknown;
	controlType?: unknown;
	name?: unknown;
	text?: unknown;
	cursorType?: unknown;
	rect: RawActionRect;
	point: { x: number; y: number };
};

type LocalTelemetryEvent = {
	type: RawActionEvent["type"];
	viewport: {
		width: number;
		height: number;
		devicePixelRatio: number;
		scrollX: number;
		scrollY: number;
	};
	target?: LocalTelemetryTarget;
	navigationType?: unknown;
	sourceEventType?: unknown;
	key?: {
		key?: unknown;
		code?: unknown;
		repeat?: unknown;
		ctrlKey?: unknown;
		metaKey?: unknown;
		altKey?: unknown;
		shiftKey?: unknown;
	};
};

type PreparedBinding = {
	context: IsolatedContext;
	frame: FrameDescriptor;
	event: LocalTelemetryEvent;
	sourceTimeMs: number;
};

type ParsedBinding = {
	contextId: number;
	sessionId?: string;
	payload: ReturnType<typeof parseBindingPayload>;
	sourceTimeMs: number;
};

type QuarantinedBinding = ParsedBinding & {
	ready: Promise<PreparedBinding>;
	resolve: (prepared: PreparedBinding) => void;
	reject: (error: Error) => void;
};

type BindingQuarantine = {
	bindings: QuarantinedBinding[];
	timer: ReturnType<typeof setTimeout>;
};

export type CdpTelemetryRuntimeOptions = {
	webContents: WebContents;
	sessionId: string;
	clock: MonotonicSessionClock;
	onBatch: (payload: unknown) => void | Promise<void>;
	onFatal: (error: Error) => void;
};

type RuntimeDependencies = {
	acquireBridge: (webContents: WebContents, owner: string) => Promise<BridgeLease>;
};

const EVENT_TYPES = new Set<RawActionEvent["type"]>([
	"click",
	"tab-switch",
	"input",
	"change",
	"focus",
	"keydown",
	"keyup",
	"navigation",
]);

function collectorBootstrap(bindingName: string, stateKey: string, payloadVersion: number): void {
	let documentUrl: URL;
	try {
		documentUrl = new URL(location.href);
	} catch {
		return;
	}
	if (
		(documentUrl.protocol !== "http:" && documentUrl.protocol !== "https:") ||
		!documentUrl.hostname ||
		documentUrl.origin === "null"
	) {
		return;
	}

	const globalObject = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = globalObject[stateKey] as
		| { version?: number; active?: boolean; stop?: () => { ok: boolean } }
		| undefined;
	if (existing?.version === payloadVersion && existing.active === true) return;
	existing?.stop?.();

	const binding = globalObject[bindingName];
	if (typeof binding !== "function") {
		throw new Error("Recordly telemetry binding is unavailable.");
	}

	let accepting = true;
	let sequence = 0;
	let historyState:
		| {
				pushState: History["pushState"];
				replaceState: History["replaceState"];
				wrappedPushState: History["pushState"];
				wrappedReplaceState: History["replaceState"];
		  }
		| undefined;

	const normalizedText = (value: unknown, maximumLength = 300): string =>
		String(value ?? "")
			.replace(new RegExp("[\\u0000-\\u001f\\u007f]", "gu"), " ")
			.replace(/\s+/gu, " ")
			.trim()
			.slice(0, maximumLength);
	const finite = (value: unknown, fallback = 0): number =>
		typeof value === "number" && Number.isFinite(value) ? value : fallback;
	const rounded = (value: number): number => Math.round(value * 1000) / 1000;
	const clamp = (value: number, minimum: number, maximum: number): number =>
		Math.min(maximum, Math.max(minimum, value));
	const viewport = () => ({
		width: Math.max(1, finite(window.innerWidth, document.documentElement.clientWidth)),
		height: Math.max(1, finite(window.innerHeight, document.documentElement.clientHeight)),
		devicePixelRatio: Math.max(0.1, finite(window.devicePixelRatio, 1)),
		scrollX: Math.max(0, finite(window.scrollX)),
		scrollY: Math.max(0, finite(window.scrollY)),
	});
	const isElement = (value: EventTarget | null): value is Element => value instanceof Element;
	const resolveControl = (event: Event): Element | null => {
		const path = typeof event.composedPath === "function" ? event.composedPath() : [];
		for (const candidate of path) {
			if (!isElement(candidate)) continue;
			return (
				candidate.closest(
					'button,input,textarea,select,a,[role="button"],[role="link"],[role="tab"],[role="textbox"],[role="searchbox"],[role="combobox"],[tabindex],ui5-button,ui5-input,ui5-textarea,ui5-select,ui5-tab',
				) || candidate
			);
		}
		return isElement(event.target) ? event.target : null;
	};
	const isSensitive = (control: Element): boolean => {
		const inputType = normalizedText(control.getAttribute("type"), 40).toLowerCase();
		if (inputType === "password") return true;
		const autocomplete = normalizedText(control.getAttribute("autocomplete"), 80).toLowerCase();
		if (autocomplete.includes("password") || autocomplete.includes("one-time-code"))
			return true;
		const identity = [
			control.getAttribute("name"),
			control.getAttribute("id"),
			control.getAttribute("aria-label"),
			control.getAttribute("title"),
			control.getAttribute("placeholder"),
		]
			.map((value) => normalizedText(value, 120).toLowerCase())
			.join(" ");
		return /(?:pass(?:word)?|passwd|passcode|pwd|secret|token|credential|otp|one[\s_-]*time|verification|验证码|密码|口令|动态码|安全码)/iu.test(
			identity,
		);
	};
	const cssEscape = (value: string): string =>
		globalThis.CSS?.escape
			? globalThis.CSS.escape(value)
			: value.replace(/([\\"\n\r\t\f])/gu, "\\$1");
	const targetId = (control: Element, sensitive: boolean): string => {
		if (sensitive) return "";
		for (const candidate of [
			control.getAttribute("data-recordly-target"),
			control.getAttribute("data-sap-ui"),
			control.getAttribute("id"),
		]) {
			const result = normalizedText(candidate, 200);
			if (result) return result;
		}
		return "";
	};
	const selector = (control: Element, sensitive: boolean): string => {
		if (sensitive) return "";
		const id = targetId(control, false);
		if (id) {
			if (control.getAttribute("data-sap-ui") === id) {
				return `[data-sap-ui="${cssEscape(id)}"]`;
			}
			if (control.id === id) return `#${cssEscape(id)}`;
			return `[data-recordly-target="${cssEscape(id)}"]`;
		}
		const segments: string[] = [];
		let current: Element | null = control;
		for (let depth = 0; current && depth < 5; depth += 1) {
			const tag = current.localName.toLowerCase() || "element";
			const siblings = current.parentElement
				? [...current.parentElement.children].filter(
						(candidate) => candidate.localName === tag,
					)
				: [];
			const index = siblings.indexOf(current);
			segments.unshift(
				`${tag}${siblings.length > 1 && index >= 0 ? `:nth-of-type(${index + 1})` : ""}`,
			);
			current = current.parentElement;
		}
		return segments.join(" > ");
	};
	const controlName = (control: Element, sensitive: boolean): string => {
		if (sensitive) return "credential field";
		for (const candidate of [
			control.getAttribute("aria-label"),
			control.getAttribute("title"),
			control.getAttribute("placeholder"),
			control.textContent,
		]) {
			const result = normalizedText(candidate);
			if (result) return result;
		}
		return "unnamed control";
	};
	const controlType = (control: Element): string => {
		const role = normalizedText(control.getAttribute("role"), 64).toLowerCase();
		if (role) return role;
		const tag = control.localName.toLowerCase() || "control";
		if (tag === "input") {
			return `input:${normalizedText(control.getAttribute("type") || "text", 40).toLowerCase()}`;
		}
		return tag.slice(0, 64);
	};
	const cursorType = (control: Element): string => {
		const cursor = normalizedText(getComputedStyle(control).cursor, 40).toLowerCase();
		if (cursor === "pointer") return "pointer";
		if (cursor === "text" || cursor === "vertical-text") return "text";
		if (cursor === "crosshair") return "crosshair";
		if (cursor === "grab") return "open-hand";
		if (cursor === "grabbing") return "closed-hand";
		if (["ew-resize", "e-resize", "w-resize", "col-resize"].includes(cursor)) {
			return "resize-ew";
		}
		if (["ns-resize", "n-resize", "s-resize", "row-resize"].includes(cursor)) {
			return "resize-ns";
		}
		if (cursor === "not-allowed" || cursor === "no-drop") return "not-allowed";
		return "arrow";
	};
	const targetSnapshot = (control: Element, event: Event, sensitive: boolean) => {
		const currentViewport = viewport();
		const domRect = control.getBoundingClientRect();
		const left = clamp(finite(domRect.left), 0, currentViewport.width);
		const top = clamp(finite(domRect.top), 0, currentViewport.height);
		const right = clamp(finite(domRect.right), 0, currentViewport.width);
		const bottom = clamp(finite(domRect.bottom), 0, currentViewport.height);
		if (right - left < 0.01 || bottom - top < 0.01) return undefined;
		const rect = {
			x: rounded(left),
			y: rounded(top),
			width: rounded(right - left),
			height: rounded(bottom - top),
		};
		const pointer = event as MouseEvent;
		const hasPointer =
			Number.isFinite(pointer.clientX) &&
			Number.isFinite(pointer.clientY) &&
			(pointer.clientX !== 0 || pointer.clientY !== 0);
		const point = {
			x: rounded(
				clamp(
					hasPointer ? pointer.clientX : rect.x + rect.width / 2,
					0,
					currentViewport.width,
				),
			),
			y: rounded(
				clamp(
					hasPointer ? pointer.clientY : rect.y + rect.height / 2,
					0,
					currentViewport.height,
				),
			),
		};
		const id = targetId(control, sensitive);
		const stableSelector = selector(control, sensitive);
		const name = controlName(control, sensitive);
		return {
			...(id ? { targetId: id } : {}),
			...(stableSelector ? { selector: stableSelector } : {}),
			controlType: controlType(control),
			name,
			text: sensitive ? "credential field" : normalizedText(control.textContent || name),
			cursorType: cursorType(control),
			rect,
			point,
		};
	};
	const emit = (event: Record<string, unknown>): void => {
		if (!accepting) return;
		const payload = JSON.stringify({
			version: payloadVersion,
			kind: "browser-event",
			sequence,
			event,
		});
		sequence += 1;
		(binding as (payload: string) => void)(payload);
	};
	const recordControlEvent = (event: Event): void => {
		const control = resolveControl(event);
		if (!control) return;
		const sensitive = isSensitive(control);
		const isTab =
			event.type === "click" &&
			(control.getAttribute("role")?.toLowerCase() === "tab" ||
				control.localName.toLowerCase() === "ui5-tab");
		const type = event.type === "focusin" ? "focus" : isTab ? "tab-switch" : event.type;
		if (sensitive && (type === "input" || type === "change")) return;
		const target = targetSnapshot(control, event, sensitive);
		emit({
			type,
			viewport: viewport(),
			...(target ? { target } : {}),
			...(isTab ? { sourceEventType: "click" } : {}),
		});
	};
	const recordKeyEvent = (event: KeyboardEvent): void => {
		const control = resolveControl(event);
		const sensitive = control ? isSensitive(control) : false;
		const target = control ? targetSnapshot(control, event, sensitive) : undefined;
		emit({
			type: event.type,
			viewport: viewport(),
			...(target ? { target } : {}),
			key: {
				key: sensitive ? "redacted" : normalizedText(event.key, 80),
				code: sensitive ? "redacted" : normalizedText(event.code, 80),
				repeat: event.repeat === true,
				ctrlKey: event.ctrlKey === true,
				metaKey: event.metaKey === true,
				altKey: event.altKey === true,
				shiftKey: event.shiftKey === true,
			},
		});
	};
	const recordNavigation = (navigationType: string): void =>
		emit({ type: "navigation", viewport: viewport(), navigationType });
	const onPopState = (): void => recordNavigation("popstate");
	const onHashChange = (): void => recordNavigation("hashchange");
	const onPageHide = (): void => recordNavigation("pagehide");
	const listenerEntries: Array<[EventTarget, string, EventListener]> = [
		[document, "focusin", recordControlEvent],
		[document, "input", recordControlEvent],
		[document, "click", recordControlEvent],
		[document, "change", recordControlEvent],
		[document, "keydown", recordKeyEvent as EventListener],
		[document, "keyup", recordKeyEvent as EventListener],
		[window, "popstate", onPopState],
		[window, "hashchange", onHashChange],
		[window, "pagehide", onPageHide],
	];
	for (const [target, type, listener] of listenerEntries) {
		target.addEventListener(type, listener, true);
	}

	const originalPushState = history.pushState;
	const originalReplaceState = history.replaceState;
	const wrappedPushState: History["pushState"] = function (this: History, ...args): void {
		originalPushState.apply(this, args);
		recordNavigation("pushState");
	};
	const wrappedReplaceState: History["replaceState"] = function (this: History, ...args): void {
		originalReplaceState.apply(this, args);
		recordNavigation("replaceState");
	};
	historyState = {
		pushState: originalPushState,
		replaceState: originalReplaceState,
		wrappedPushState,
		wrappedReplaceState,
	};
	history.pushState = wrappedPushState;
	history.replaceState = wrappedReplaceState;

	const stop = (): { ok: boolean } => {
		if (!accepting) return { ok: true };
		accepting = false;
		for (const [target, type, listener] of listenerEntries) {
			target.removeEventListener(type, listener, true);
		}
		if (historyState) {
			if (history.pushState === historyState.wrappedPushState) {
				history.pushState = historyState.pushState;
			}
			if (history.replaceState === historyState.wrappedReplaceState) {
				history.replaceState = historyState.replaceState;
			}
		}
		historyState = undefined;
		delete globalObject[stateKey];
		return { ok: true };
	};

	Object.defineProperty(globalObject, stateKey, {
		value: Object.freeze({ version: payloadVersion, active: true, stop }),
		configurable: true,
		enumerable: false,
		writable: false,
	});
	recordNavigation("document");
}

export const CDP_TELEMETRY_COLLECTOR_SOURCE = `(${collectorBootstrap.toString()})(${JSON.stringify(
	BINDING_NAME,
)},${JSON.stringify(COLLECTOR_STATE_KEY)},${PAYLOAD_VERSION});`;

function contextKey(sessionId: string | undefined, contextId: number): string {
	return `${sessionId ?? "root"}:${contextId}`;
}

function sessionKey(sessionId: string | undefined): string {
	return sessionId ?? "root";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTransientBootstrapFrame(frame: Pick<FrameDescriptor, "url">): boolean {
	if (typeof frame.url !== "string" || !frame.url.trim()) return true;
	try {
		const parsed = new URL(frame.url);
		return (
			parsed.protocol === "about:" &&
			(parsed.pathname === "blank" || parsed.pathname === "srcdoc")
		);
	} catch {
		return false;
	}
}

function trustedHttpOrigin(frame: Pick<FrameDescriptor, "frameId" | "origin" | "url">): string {
	const invalidOrigin = () =>
		new Error(
			`CDP telemetry frame ${frame.frameId} has an invalid or untrusted HTTP(S) origin.`,
		);
	if (typeof frame.origin !== "string" || !frame.origin.trim()) throw invalidOrigin();
	try {
		const parsed = new URL(frame.origin);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalidOrigin();
		parsed.username = "";
		parsed.password = "";
		parsed.pathname = "/";
		parsed.search = "";
		parsed.hash = "";
		if (!parsed.hostname || parsed.origin === "null") throw invalidOrigin();
		const documentUrl = new URL(frame.url);
		if (
			(documentUrl.protocol !== "http:" && documentUrl.protocol !== "https:") ||
			!documentUrl.hostname ||
			documentUrl.origin !== parsed.origin
		) {
			throw invalidOrigin();
		}
		return parsed.origin;
	} catch {
		throw invalidOrigin();
	}
}

function hasTrustedOrigin(frame: Pick<FrameDescriptor, "frameId" | "origin" | "url">): boolean {
	try {
		trustedHttpOrigin(frame);
		return true;
	} catch {
		return false;
	}
}

function asObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new Error(`${label} must be a finite number >= ${minimum}.`);
	}
	return value;
}

function optionalString(value: unknown, maximumLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(new RegExp("[\\u0000-\\u001f\\u007f]", "gu"), " ").trim();
	if (!normalized) return undefined;
	return normalized.slice(0, maximumLength);
}

function parseLocalTarget(value: unknown): LocalTelemetryTarget | undefined {
	if (value === undefined || value === null) return undefined;
	const target = asObject(value, "telemetry target");
	const rect = asObject(target.rect, "telemetry target rect");
	const point = asObject(target.point, "telemetry target point");
	return {
		targetId: target.targetId,
		selector: target.selector,
		controlType: target.controlType,
		name: target.name,
		text: target.text,
		cursorType: target.cursorType,
		rect: {
			x: finiteNumber(rect.x, "telemetry target rect.x"),
			y: finiteNumber(rect.y, "telemetry target rect.y"),
			width: finiteNumber(rect.width, "telemetry target rect.width", 0.01),
			height: finiteNumber(rect.height, "telemetry target rect.height", 0.01),
		},
		point: {
			x: finiteNumber(point.x, "telemetry target point.x"),
			y: finiteNumber(point.y, "telemetry target point.y"),
		},
	};
}

function parseLocalEvent(value: unknown): LocalTelemetryEvent {
	const event = asObject(value, "telemetry event");
	if (!EVENT_TYPES.has(event.type as RawActionEvent["type"])) {
		throw new Error(`Unsupported CDP telemetry event type: ${String(event.type)}.`);
	}
	const viewport = asObject(event.viewport, "telemetry viewport");
	const key =
		event.key === undefined || event.key === null
			? undefined
			: asObject(event.key, "telemetry key");
	return {
		type: event.type as RawActionEvent["type"],
		viewport: {
			width: finiteNumber(viewport.width, "telemetry viewport.width", 1),
			height: finiteNumber(viewport.height, "telemetry viewport.height", 1),
			devicePixelRatio: finiteNumber(
				viewport.devicePixelRatio,
				"telemetry viewport.devicePixelRatio",
				0.1,
			),
			scrollX: finiteNumber(viewport.scrollX, "telemetry viewport.scrollX"),
			scrollY: finiteNumber(viewport.scrollY, "telemetry viewport.scrollY"),
		},
		target: parseLocalTarget(event.target),
		navigationType: event.navigationType,
		sourceEventType: event.sourceEventType,
		key: key
			? {
					key: key.key,
					code: key.code,
					repeat: key.repeat,
					ctrlKey: key.ctrlKey,
					metaKey: key.metaKey,
					altKey: key.altKey,
					shiftKey: key.shiftKey,
				}
			: undefined,
	};
}

function parseBindingPayload(value: unknown): {
	sequence: number;
	event: LocalTelemetryEvent;
} {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_BINDING_PAYLOAD_BYTES) {
		throw new Error("CDP telemetry binding payload is missing or too large.");
	}
	const payload = asObject(JSON.parse(value), "telemetry binding payload");
	if (payload.version !== PAYLOAD_VERSION || payload.kind !== "browser-event") {
		throw new Error("CDP telemetry binding rejected a non-telemetry envelope.");
	}
	return {
		sequence: finiteNumber(payload.sequence, "telemetry sequence"),
		event: parseLocalEvent(payload.event),
	};
}

function clipRect(rect: RawActionRect, viewport: RootViewport): RawActionRect | undefined {
	const left = Math.max(0, rect.x);
	const top = Math.max(0, rect.y);
	const right = Math.min(viewport.width, rect.x + rect.width);
	const bottom = Math.min(viewport.height, rect.y + rect.height);
	if (right - left < 0.01 || bottom - top < 0.01) return undefined;
	return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export class CdpTelemetryRuntime {
	private lease: BridgeLease | null = null;
	private bridge: CdpFrameBridgeShape | null = null;
	private unsubscribe: (() => void) | null = null;
	private accepting = false;
	private stopping = false;
	private failed = false;
	private failure: Error | null = null;
	private cleanupComplete = false;
	private eventSequence = 0;
	private pendingBindings = 0;
	private processing: Promise<void> = Promise.resolve();
	private readonly configuredSessions = new Set<string>();
	private readonly configuringSessions = new Map<string, Promise<void>>();
	private readonly scripts: InstalledScript[] = [];
	private readonly bindingSessions = new Map<string, string | undefined>();
	private readonly contexts = new Map<string, IsolatedContext>();
	private readonly bindingQuarantines = new Map<string, BindingQuarantine>();
	private rootViewportCache:
		| { expiresAtMs: number; promise: Promise<Omit<RootViewport, "devicePixelRatio">> }
		| undefined;

	constructor(
		private readonly options: CdpTelemetryRuntimeOptions,
		private readonly dependencies: RuntimeDependencies = {
			acquireBridge: acquireCdpFrameBridge as RuntimeDependencies["acquireBridge"],
		},
	) {}

	async start(): Promise<void> {
		if (this.lease) throw new Error("CDP telemetry runtime is already started.");
		this.lease = await this.dependencies.acquireBridge(
			this.options.webContents,
			"sap-capture-telemetry",
		);
		this.bridge = this.lease.bridge;
		try {
			this.bridge.assertHealthy();
			this.unsubscribe = this.bridge.subscribe((event) => this.handleBridgeEvent(event));
			this.accepting = true;
			await this.bridge.waitForFramesReady(FRAME_DISCOVERY_TIMEOUT_MS);
			await this.configureSession(undefined);
			await this.armKnownFrames();
			await this.waitForStartupQuarantine();
			if (this.failure) throw this.failure;
			const trustedFrames = this.bridge.getFrames().filter(hasTrustedOrigin);
			if (
				trustedFrames.some(
					(frame) =>
						![...this.contexts.values()].some(
							(context) => context.frameId === frame.frameId,
						),
				)
			) {
				throw new Error("CDP telemetry did not arm every trusted frame.");
			}
			if (
				![...this.contexts.values()].some(
					(context) => !this.bridge?.getFrame(context.frameId)?.parentFrameId,
				)
			) {
				throw new Error(
					"CDP telemetry did not arm an isolated collector in the main frame.",
				);
			}
		} catch (error) {
			await this.dispose();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.bridge || !this.lease) return;
		if (this.stopping) {
			await this.processing;
			return;
		}
		this.stopping = true;
		try {
			this.bridge.assertHealthy();
			if (this.bindingQuarantines.size > 0) {
				this.fail(
					new Error(
						"CDP telemetry stopped with a quarantined binding whose execution context was never trusted.",
					),
				);
				throw this.failure;
			}
			const contexts = [...this.contexts.values()];
			await Promise.all(
				contexts.map(async (context) => {
					const result = await this.bridge?.send<{
						result?: { value?: { ok?: boolean } };
					}>(
						"Runtime.evaluate",
						{
							expression: `globalThis[${JSON.stringify(COLLECTOR_STATE_KEY)}]?.stop?.()`,
							contextId: context.contextId,
							returnByValue: true,
							awaitPromise: true,
						},
						context.sessionId,
					);
					if (result?.result?.value?.ok !== true) {
						throw new Error(
							`CDP telemetry collector did not stop in frame ${context.frameId}.`,
						);
					}
				}),
			);
			this.accepting = false;
			await this.processing;
			if (this.failure) throw this.failure;
			await this.removeInstalledScripts();
			this.cleanupComplete = true;
		} finally {
			await this.dispose();
		}
	}

	async dispose(): Promise<void> {
		this.accepting = false;
		if (this.bindingQuarantines.size > 0) {
			const error =
				this.failure ??
				new Error(
					"CDP telemetry disposed with a quarantined binding whose execution context was never trusted.",
				);
			if (!this.failure) {
				this.failed = true;
				this.failure = error;
			}
			this.rejectAllQuarantines(error);
		}
		await this.processing.catch(() => undefined);
		if (this.bridge && !this.cleanupComplete) {
			await Promise.allSettled(
				[...this.contexts.values()].map((context) =>
					this.bridge?.send(
						"Runtime.evaluate",
						{
							expression: `globalThis[${JSON.stringify(COLLECTOR_STATE_KEY)}]?.stop?.()`,
							contextId: context.contextId,
							returnByValue: true,
							awaitPromise: true,
						},
						context.sessionId,
					),
				),
			);
			await this.removeInstalledScripts().catch(() => undefined);
			this.cleanupComplete = true;
		}
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contexts.clear();
		this.configuredSessions.clear();
		this.configuringSessions.clear();
		this.bindingSessions.clear();
		const lease = this.lease;
		this.lease = null;
		this.bridge = null;
		lease?.release();
	}

	private fail(error: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.failure = error instanceof Error ? error : new Error(errorMessage(error));
		this.accepting = false;
		this.rejectAllQuarantines(this.failure);
		if (!this.stopping) this.options.onFatal(this.failure);
	}

	private handleBridgeEvent(event: CdpEvent): void {
		if (!this.bridge || this.failed) return;
		try {
			if (event.method === "Inspector.detached") {
				throw new Error(
					`The shared SAP CDP debugger detached during telemetry: ${optionalString(event.params.reason, 300) ?? "unknown reason"}.`,
				);
			}
			if (event.method === "Runtime.executionContextCreated") {
				this.rememberExecutionContext(event);
				return;
			}
			if (event.method === "Runtime.executionContextDestroyed") {
				const contextId = event.params.executionContextId;
				if (typeof contextId === "number") {
					const key = contextKey(event.sessionId, contextId);
					if (this.bindingQuarantines.has(key)) {
						throw new Error(
							"CDP telemetry execution context was destroyed with a quarantined binding pending.",
						);
					}
					this.contexts.delete(key);
				}
				return;
			}
			if (event.method === "Runtime.executionContextsCleared") {
				if (this.hasQuarantineForSession(event.sessionId)) {
					throw new Error(
						"CDP telemetry execution contexts were cleared with a quarantined binding pending.",
					);
				}
				for (const [key, context] of this.contexts) {
					if (context.sessionId === event.sessionId) this.contexts.delete(key);
				}
				return;
			}
			if (event.method === "Runtime.bindingCalled") {
				if (event.params.name !== BINDING_NAME) return;
				if (!this.accepting) return;
				this.acceptBinding(event);
				return;
			}
			if (event.method === "Target.attachedToTarget") {
				const childSessionId = event.params.sessionId;
				const targetInfo = asObject(event.params.targetInfo, "CDP targetInfo");
				if (typeof childSessionId === "string" && targetInfo.type === "iframe") {
					void this.armAttachedSession(childSessionId).catch((error) => this.fail(error));
				}
				return;
			}
			if (event.method === "Target.detachedFromTarget") {
				const detachedSessionId = event.params.sessionId;
				if (typeof detachedSessionId === "string") {
					if (this.hasQuarantineForSession(detachedSessionId)) {
						throw new Error(
							"CDP telemetry target detached with a quarantined binding pending.",
						);
					}
					this.forgetSession(detachedSessionId);
				}
				return;
			}
			if (event.method === "Page.frameAttached" || event.method === "Page.frameNavigated") {
				queueMicrotask(() => {
					if (!this.bridge || !this.accepting) return;
					void this.armKnownFrames().catch((error) => this.fail(error));
				});
			}
		} catch (error) {
			this.fail(error);
		}
	}

	private rememberExecutionContext(event: CdpEvent): void {
		const context = asObject(event.params.context, "CDP execution context");
		const rawContextId = context.id;
		if (context.name !== WORLD_NAME) {
			if (
				typeof rawContextId === "number" &&
				Number.isFinite(rawContextId) &&
				this.bindingQuarantines.has(contextKey(event.sessionId, rawContextId))
			) {
				throw new Error(
					"CDP telemetry binding came from an untrusted execution context world.",
				);
			}
			return;
		}
		const contextId = finiteNumber(rawContextId, "CDP execution context ID");
		const auxData = asObject(context.auxData, "CDP execution context auxData");
		const frameId = optionalString(auxData.frameId, 240);
		if (!frameId)
			throw new Error("Recordly isolated telemetry context has no trusted frame ID.");
		const frame = this.bridge?.getFrame(frameId);
		if (!frame)
			throw new Error(`Recordly isolated telemetry context has unknown frame ${frameId}.`);
		if (frame.sessionId !== event.sessionId) {
			throw new Error(
				`Recordly isolated telemetry context does not belong to frame ${frameId}'s trusted session.`,
			);
		}
		if (isTransientBootstrapFrame(frame)) return;
		trustedHttpOrigin(frame);
		const key = contextKey(event.sessionId, contextId);
		const existing = this.contexts.get(key);
		if (existing && existing.frameId !== frameId) {
			throw new Error("CDP telemetry execution context changed its trusted frame identity.");
		}
		this.contexts.set(key, {
			contextId,
			sessionId: event.sessionId,
			frameId,
			documentId:
				optionalString(context.uniqueId, 160) ??
				`${frame.frameId}:${String(frame.generation)}`,
			lastSequence: existing?.lastSequence ?? -1,
		});
		this.drainQuarantine(key);
	}

	private async configureSession(sessionId: string | undefined): Promise<void> {
		const bridge = this.bridge;
		if (!bridge) throw new Error("CDP telemetry bridge is unavailable.");
		const key = sessionKey(sessionId);
		if (this.configuredSessions.has(key)) return;
		const existing = this.configuringSessions.get(key);
		if (existing) return existing;
		const configuring = (async () => {
			bridge.assertHealthy();
			await bridge.send(
				"Runtime.addBinding",
				{ name: BINDING_NAME, executionContextName: WORLD_NAME },
				sessionId,
			);
			this.bindingSessions.set(key, sessionId);
			const script = await bridge.send<{ identifier?: string }>(
				"Page.addScriptToEvaluateOnNewDocument",
				{
					source: CDP_TELEMETRY_COLLECTOR_SOURCE,
					worldName: WORLD_NAME,
					includeCommandLineAPI: false,
					runImmediately: true,
				},
				sessionId,
			);
			if (!script.identifier) {
				throw new Error(
					"CDP telemetry could not register its isolated-world document script.",
				);
			}
			this.scripts.push({ sessionId, identifier: script.identifier });
			this.configuredSessions.add(key);
		})().finally(() => this.configuringSessions.delete(key));
		this.configuringSessions.set(key, configuring);
		return configuring;
	}

	private async ensureFrameCollector(frame: FrameDescriptor): Promise<void> {
		const bridge = this.bridge;
		if (!bridge || !this.accepting || !hasTrustedOrigin(frame)) return;
		await this.configureSession(frame.sessionId);
		if ([...this.contexts.values()].some((context) => context.frameId === frame.frameId))
			return;
		const isolatedWorld = await bridge.send<{ executionContextId?: number }>(
			"Page.createIsolatedWorld",
			{
				frameId: frame.frameId,
				worldName: WORLD_NAME,
				grantUniveralAccess: false,
			},
			frame.sessionId,
		);
		const contextId = isolatedWorld.executionContextId;
		if (!Number.isFinite(contextId)) {
			throw new Error(
				`CDP telemetry could not create an isolated world for frame ${frame.frameId}.`,
			);
		}
		const trustedContextId = Number(contextId);
		const currentFrame = bridge.getFrame(frame.frameId);
		if (!currentFrame) {
			throw new Error(`CDP telemetry frame ${frame.frameId} detached while being armed.`);
		}
		if (
			currentFrame.generation !== frame.generation ||
			currentFrame.sessionId !== frame.sessionId
		) {
			await this.ensureFrameCollector(currentFrame);
			return;
		}
		const key = contextKey(frame.sessionId, trustedContextId);
		this.contexts.set(key, {
			contextId: trustedContextId,
			sessionId: frame.sessionId,
			frameId: frame.frameId,
			documentId: `${frame.frameId}:${String(frame.generation)}`,
			lastSequence: -1,
		});
		this.drainQuarantine(key);
		await bridge.send(
			"Runtime.evaluate",
			{
				expression: CDP_TELEMETRY_COLLECTOR_SOURCE,
				contextId: trustedContextId,
				returnByValue: true,
				awaitPromise: false,
			},
			frame.sessionId,
		);
	}

	private async armKnownFrames(): Promise<void> {
		const bridge = this.bridge;
		if (!bridge || !this.accepting) return;
		const frames = bridge.getFrames().filter(hasTrustedOrigin);
		const sessions = new Set<string | undefined>(frames.map((frame) => frame.sessionId));
		await Promise.all([...sessions].map((sessionId) => this.configureSession(sessionId)));
		await Promise.all(frames.map((frame) => this.ensureFrameCollector(frame)));
	}

	private async armAttachedSession(sessionId: string): Promise<void> {
		const bridge = this.bridge;
		if (!bridge) return;
		await bridge.waitForFramesReady(FRAME_DISCOVERY_TIMEOUT_MS);
		if (!this.accepting) return;
		const frames = bridge
			.getFrames()
			.filter((frame) => frame.sessionId === sessionId && hasTrustedOrigin(frame));
		if (frames.length === 0) {
			throw new Error("CDP telemetry could not arm a dynamically attached iframe target.");
		}
		await this.configureSession(sessionId);
		await Promise.all(frames.map((frame) => this.ensureFrameCollector(frame)));
	}

	private quarantineBinding(binding: ParsedBinding): Promise<PreparedBinding> {
		const key = contextKey(binding.sessionId, binding.contextId);
		let resolve!: (prepared: PreparedBinding) => void;
		let reject!: (error: Error) => void;
		const ready = new Promise<PreparedBinding>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const quarantined: QuarantinedBinding = {
			...binding,
			ready,
			resolve,
			reject,
		};
		const existing = this.bindingQuarantines.get(key);
		if (existing) {
			existing.bindings.push(quarantined);
			return ready;
		}
		const timer = setTimeout(() => {
			this.fail(
				new Error(
					"CDP telemetry binding quarantine timed out before its execution context was trusted.",
				),
			);
		}, BINDING_QUARANTINE_TIMEOUT_MS);
		this.bindingQuarantines.set(key, { bindings: [quarantined], timer });
		return ready;
	}

	private drainQuarantine(key: string): void {
		const quarantine = this.bindingQuarantines.get(key);
		if (!quarantine) return;
		this.bindingQuarantines.delete(key);
		clearTimeout(quarantine.timer);
		const context = this.contexts.get(key);
		if (!context) {
			const error = new Error(
				"CDP telemetry binding came from an untrusted execution context.",
			);
			for (const binding of quarantine.bindings) binding.reject(error);
			throw error;
		}
		for (let index = 0; index < quarantine.bindings.length; index += 1) {
			const binding = quarantine.bindings[index];
			try {
				binding.resolve(this.prepareBinding(binding, context));
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(errorMessage(error));
				for (let pending = index; pending < quarantine.bindings.length; pending += 1) {
					quarantine.bindings[pending].reject(normalized);
				}
				throw normalized;
			}
		}
	}

	private rejectAllQuarantines(error: Error): void {
		const quarantines = [...this.bindingQuarantines.values()];
		this.bindingQuarantines.clear();
		for (const quarantine of quarantines) {
			clearTimeout(quarantine.timer);
			for (const binding of quarantine.bindings) binding.reject(error);
		}
	}

	private hasQuarantineForSession(sessionId: string | undefined): boolean {
		return [...this.bindingQuarantines.values()].some((quarantine) =>
			quarantine.bindings.some((binding) => binding.sessionId === sessionId),
		);
	}

	private async waitForStartupQuarantine(): Promise<void> {
		while (this.bindingQuarantines.size > 0) {
			const pending = [...this.bindingQuarantines.values()].flatMap((quarantine) =>
				quarantine.bindings.map((binding) => binding.ready.then(() => undefined)),
			);
			await Promise.all(pending);
			if (this.failure) throw this.failure;
		}
	}

	private acceptBinding(event: CdpEvent): void {
		if (this.pendingBindings >= MAX_PENDING_BINDINGS) {
			throw new Error("CDP telemetry binding queue exceeded its safety limit.");
		}
		const binding: ParsedBinding = {
			contextId: finiteNumber(event.params.executionContextId, "binding executionContextId"),
			sessionId: event.sessionId,
			payload: parseBindingPayload(event.params.payload),
			sourceTimeMs: this.options.clock.nowMs(),
		};
		this.pendingBindings += 1;
		let ready: Promise<PreparedBinding>;
		try {
			const context = this.contexts.get(contextKey(binding.sessionId, binding.contextId));
			ready = context
				? Promise.resolve(this.prepareBinding(binding, context))
				: this.quarantineBinding(binding);
		} catch (error) {
			this.pendingBindings -= 1;
			throw error;
		}
		const previous = this.processing;
		this.processing = Promise.all([previous, ready])
			.then(([, prepared]) => this.processBinding(prepared))
			.catch((error) => this.fail(error))
			.finally(() => {
				this.pendingBindings -= 1;
			});
	}

	private prepareBinding(binding: ParsedBinding, context: IsolatedContext): PreparedBinding {
		if (!this.bridge) throw new Error("CDP telemetry bridge is unavailable.");
		const key = contextKey(binding.sessionId, binding.contextId);
		if (this.contexts.get(key) !== context) {
			throw new Error("CDP telemetry binding came from an untrusted execution context.");
		}
		const payload = binding.payload;
		if (
			!Number.isSafeInteger(payload.sequence) ||
			payload.sequence !== context.lastSequence + 1
		) {
			throw new Error(
				"CDP telemetry event sequence is missing, duplicated, or out of order.",
			);
		}
		context.lastSequence = payload.sequence;
		const frame = this.bridge.getFrame(context.frameId);
		if (!frame) throw new Error(`CDP telemetry frame ${context.frameId} is no longer trusted.`);
		if (frame.sessionId !== context.sessionId) {
			throw new Error(`CDP telemetry frame ${context.frameId} changed its trusted session.`);
		}
		const origin = trustedHttpOrigin(frame);
		return {
			context: { ...context },
			frame: { ...frame, origin },
			event: payload.event,
			sourceTimeMs: binding.sourceTimeMs,
		};
	}

	private async processBinding(prepared: PreparedBinding): Promise<void> {
		if (!this.bridge || this.failed) return;
		if (!(await this.bridge.isFrameCandidateAvailable(prepared.frame.frameId))) return;
		const trustedEvent = await this.toTrustedEvent(
			prepared.frame,
			prepared.context,
			prepared.event,
			prepared.sourceTimeMs,
		);
		await this.options.onBatch({
			schemaVersion: 2,
			sourceClock: "capture-session-monotonic",
			sessionId: this.options.sessionId,
			events: [trustedEvent],
		});
	}

	private async toTrustedEvent(
		frame: FrameDescriptor,
		context: IsolatedContext,
		event: LocalTelemetryEvent,
		sourceTimeMs: number,
	): Promise<RawActionEvent> {
		const origin = trustedHttpOrigin(frame);
		const viewport = await this.rootViewport(event.viewport.devicePixelRatio);
		const trusted: RawActionEvent = {
			eventId: `${this.options.sessionId}:cdp:${this.eventSequence}`,
			type: event.type,
			sourceTimeMs,
			documentId: context.documentId,
			url: origin,
			frame: {
				frameId: frame.frameId,
				...(frame.parentFrameId ? { parentFrameId: frame.parentFrameId } : {}),
				origin,
				isMainFrame: !frame.parentFrameId,
			},
			viewport,
			...(optionalString(event.navigationType, 80)
				? { navigationType: optionalString(event.navigationType, 80) }
				: {}),
			...(optionalString(event.sourceEventType, 80)
				? { sourceEventType: optionalString(event.sourceEventType, 80) }
				: {}),
		};
		this.eventSequence += 1;
		if (event.key) {
			trusted.key = {
				key: optionalString(event.key.key, 80),
				code: optionalString(event.key.code, 80),
				repeat: event.key.repeat === true,
				ctrlKey: event.key.ctrlKey === true,
				metaKey: event.key.metaKey === true,
				altKey: event.key.altKey === true,
				shiftKey: event.key.shiftKey === true,
			};
		}
		if (event.target) {
			const [mappedRect, mappedPoint] = await Promise.all([
				this.bridge?.mapFrameRectToRoot(frame.frameId, event.target.rect),
				this.bridge?.mapFramePointToRoot(frame.frameId, event.target.point),
			]);
			if (!mappedRect || !mappedPoint) {
				throw new Error(`CDP telemetry could not map frame ${frame.frameId} geometry.`);
			}
			const rect = clipRect(mappedRect, viewport);
			if (rect) {
				const point = {
					x: clamp(mappedPoint.x, 0, viewport.width),
					y: clamp(mappedPoint.y, 0, viewport.height),
				};
				trusted.target = {
					...(optionalString(event.target.targetId, 200)
						? { targetId: optionalString(event.target.targetId, 200) }
						: {}),
					...(optionalString(event.target.selector, 800)
						? { selector: optionalString(event.target.selector, 800) }
						: {}),
					...(optionalString(event.target.controlType, 120)
						? { controlType: optionalString(event.target.controlType, 120) }
						: {}),
					...(optionalString(event.target.name, 300)
						? { name: optionalString(event.target.name, 300) }
						: {}),
					...(optionalString(event.target.text, 300)
						? { text: optionalString(event.target.text, 300) }
						: {}),
					...(optionalString(event.target.cursorType, 40)
						? { cursorType: optionalString(event.target.cursorType, 40) as never }
						: {}),
					rect,
					point,
					normalizedPoint: {
						x: clamp(point.x / viewport.width, 0, 1),
						y: clamp(point.y / viewport.height, 0, 1),
					},
				};
			}
		}
		return trusted;
	}

	private async rootViewport(devicePixelRatio: number): Promise<RootViewport> {
		const bridge = this.bridge;
		if (!bridge) throw new Error("CDP telemetry bridge is unavailable.");
		const nowMs = this.options.clock.nowMs();
		if (!this.rootViewportCache || this.rootViewportCache.expiresAtMs < nowMs) {
			this.rootViewportCache = {
				expiresAtMs: nowMs + ROOT_VIEWPORT_CACHE_MS,
				promise: bridge
					.send<Record<string, unknown>>("Page.getLayoutMetrics")
					.then((result) => {
						const rawViewport =
							(result.cssVisualViewport as Record<string, unknown> | undefined) ??
							(result.visualViewport as Record<string, unknown> | undefined) ??
							(result.cssLayoutViewport as Record<string, unknown> | undefined) ??
							(result.layoutViewport as Record<string, unknown> | undefined);
						const viewport = asObject(rawViewport, "CDP root viewport");
						return {
							width: finiteNumber(viewport.clientWidth, "CDP root viewport width", 1),
							height: finiteNumber(
								viewport.clientHeight,
								"CDP root viewport height",
								1,
							),
							scrollX: finiteNumber(viewport.pageX ?? 0, "CDP root viewport pageX"),
							scrollY: finiteNumber(viewport.pageY ?? 0, "CDP root viewport pageY"),
						};
					}),
			};
		}
		return { ...(await this.rootViewportCache.promise), devicePixelRatio };
	}

	private async removeInstalledScripts(): Promise<void> {
		const bridge = this.bridge;
		if (!bridge) return;
		const scripts = this.scripts.splice(0);
		const bindings = [...this.bindingSessions.values()];
		this.bindingSessions.clear();
		const results = await Promise.allSettled([
			...scripts.map(({ identifier, sessionId }) =>
				bridge.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId),
			),
			...bindings.map((sessionId) =>
				bridge.send("Runtime.removeBinding", { name: BINDING_NAME }, sessionId),
			),
		]);
		const rejection = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (rejection) throw rejection.reason;
	}

	private forgetSession(sessionId: string): void {
		this.configuredSessions.delete(sessionKey(sessionId));
		this.configuringSessions.delete(sessionKey(sessionId));
		this.bindingSessions.delete(sessionKey(sessionId));
		for (const [key, context] of this.contexts) {
			if (context.sessionId === sessionId) this.contexts.delete(key);
		}
		for (let index = this.scripts.length - 1; index >= 0; index -= 1) {
			if (this.scripts[index].sessionId === sessionId) this.scripts.splice(index, 1);
		}
	}
}

export async function startCdpTelemetryRuntime(
	options: CdpTelemetryRuntimeOptions,
): Promise<CdpTelemetryRuntime> {
	const runtime = new CdpTelemetryRuntime(options);
	await runtime.start();
	return runtime;
}
