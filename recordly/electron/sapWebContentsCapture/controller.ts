import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
	app,
	BrowserWindow,
	type IpcMainInvokeEvent,
	ipcMain,
	session,
	type WebContents,
} from "electron";
import { getPackagedRendererBaseUrl } from "../rendererServer";
import { readCaptureStartContext, type CaptureStartContext } from "../../../scripts/capture-start-run.mjs";
import { executeSapWebContentsAction } from "../sapWebContentsControl/controller";
import {
	normalizeBrowserCapturePart,
	type BrowserCaptureNormalizeResult,
} from "../browserCapture/normalizer";
import { type CdpTelemetryRuntime, startCdpTelemetryRuntime } from "./cdpTelemetryRuntime";
import { enterSapWebContentsCaptureMode } from "./cursorPolicy";
import { AtomicWebmWriter, type CompletedWebmFile } from "./fileSink";
import { getBoundTabMediaSourceId } from "./sourceBinding";
import { capturePageIdentity } from "./startPage";
import {
	createMonotonicSessionClock,
	RawActionTimeline,
	type MonotonicSessionClock,
	type RawActionTimelineDocument,
} from "./timeline";

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10 * 60 * 1000;
const TIMESLICE_MS = 250;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

const RENDERER_START_CHANNEL = "recordly:sap-web-contents-capture:renderer-start";
const RENDERER_STOP_CHANNEL = "recordly:sap-web-contents-capture:renderer-stop";
const RENDERER_STARTED_CHANNEL = "recordly:sap-web-contents-capture:renderer-started";
const RENDERER_CHUNK_CHANNEL = "recordly:sap-web-contents-capture:renderer-chunk";
const RENDERER_STOPPED_CHANNEL = "recordly:sap-web-contents-capture:renderer-stopped";
const RENDERER_FAILED_CHANNEL = "recordly:sap-web-contents-capture:renderer-failed";

const CONTROL_START_CHANNEL = "recordly:sap-web-contents-capture:start";
const CONTROL_STOP_CHANNEL = "recordly:sap-web-contents-capture:stop";
const CONTROL_STATUS_CHANNEL = "recordly:sap-web-contents-capture:status";

export type SapWebContentsCapturePhase =
	| "idle"
	| "starting"
	| "recording"
	| "stopping"
	| "completed"
	| "failed";

export interface SapWebContentsCapturePermissionEvent {
	kind: "check" | "request";
	permission: string;
	mediaTypes: string[];
	webContentsMatched: boolean;
	rendererLoaded: boolean;
	currentUrlMatched: boolean;
	requestingUrlMatched: boolean | null;
	isMainFrame: boolean;
	granted: boolean;
}

export interface SapWebContentsCapturePermissionTrace {
	events: SapWebContentsCapturePermissionEvent[];
}

export interface SapWebContentsCaptureStatus {
	phase: SapWebContentsCapturePhase;
	verifiedStart?: Pick<CaptureStartContext, "origin" | "client" | "system"> & { page: "fiori-home" | "recovery" };
	sessionId: string | null;
	outputPath: string | null;
	partPath: string | null;
	sourceWebContentsId: number | null;
	captureWebContentsId: number | null;
	mimeType: string | null;
	chunkCount: number;
	bytesWritten: number;
	permissionTrace: SapWebContentsCapturePermissionTrace;
	error: string | null;
}

export interface CompletedSapWebContentsCapture extends CompletedWebmFile {
	sessionId: string;
	sourceWebContentsId: number;
	captureWebContentsId: number;
	mimeType: string;
	rawMasterPath: string;
	actionLogPath: string;
	cursorPath: string;
	normalization: BrowserCaptureNormalizeResult;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	isSettled: () => boolean;
}

interface ActiveCapture {
	sessionId: string;
	verifiedStart: NonNullable<SapWebContentsCaptureStatus["verifiedStart"]>;
	sourceWebContents: WebContents;
	captureWindow: BrowserWindow;
	writer: AtomicWebmWriter;
	phase: "starting" | "recording" | "stopping";
	mimeType: string | null;
	rendererStarted: boolean;
	permissionTrace: SapWebContentsCapturePermissionTrace;
	started: Deferred<SapWebContentsCaptureStatus>;
	completion: Deferred<CompletedSapWebContentsCapture> | null;
	clock: MonotonicSessionClock;
	timeline: RawActionTimeline;
	telemetry: CdpTelemetryRuntime | null;
	failureInProgress: boolean;
	removeSourceListeners: (() => void) | null;
}

interface CaptureControlOptions {
	getSapBrowserWindow: () => BrowserWindow | null;
	isControlSender: (sender: WebContents) => boolean;
}

let activeCapture: ActiveCapture | null = null;
let startInProgress = false;
let rendererHandlersRegistered = false;
let controlHandlersRegistered = false;
let creatingCaptureWindow = false;
let lastStatus: SapWebContentsCaptureStatus = {
	phase: "idle",
	sessionId: null,
	outputPath: null,
	partPath: null,
	sourceWebContentsId: null,
	captureWebContentsId: null,
	mimeType: null,
	chunkCount: 0,
	bytesWritten: 0,
	permissionTrace: { events: [] },
	error: null,
};

export function isCreatingSapWebContentsCaptureWindow(): boolean {
	return creatingCaptureWindow;
}

export function isSapWebContentsCaptureWebContents(webContents: WebContents | null): boolean {
	return Boolean(
		webContents &&
			!webContents.isDestroyed() &&
			activeCapture &&
			!activeCapture.captureWindow.isDestroyed() &&
			activeCapture.captureWindow.webContents === webContents,
	);
}

function createDeferred<T>(): Deferred<T> {
	let resolvePromise: (value: T) => void = () => undefined;
	let rejectPromise: (error: Error) => void = () => undefined;
	let settled = false;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	void promise.catch(() => undefined);

	return {
		promise,
		resolve: (value) => {
			if (settled) return;
			settled = true;
			resolvePromise(value);
		},
		reject: (error) => {
			if (settled) return;
			settled = true;
			rejectPromise(error);
		},
		isSettled: () => settled,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getCaptureAssetPath(fileName: "preload.cjs"): string {
	return path.join(app.getAppPath(), "electron", "sapWebContentsCapture", fileName);
}

function sameDocument(first: string, second: string): boolean {
	try {
		const firstUrl = new URL(first);
		const secondUrl = new URL(second);
		firstUrl.hash = "";
		secondUrl.hash = "";
		return firstUrl.href === secondUrl.href;
	} catch {
		return false;
	}
}

function configureCaptureWindowNavigation(window: BrowserWindow, rendererUrl: string): void {
	window.webContents.on("will-navigate", (event, targetUrl) => {
		if (!sameDocument(targetUrl, rendererUrl)) {
			event.preventDefault();
		}
	});
	window.webContents.on("will-redirect", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function statusFor(
	capture: ActiveCapture,
	error: string | null = null,
): SapWebContentsCaptureStatus {
	return {
		phase: capture.phase,
		verifiedStart: capture.verifiedStart,
		sessionId: capture.sessionId,
		outputPath: capture.writer.outputPath,
		partPath: capture.writer.partPath,
		sourceWebContentsId: capture.sourceWebContents.id,
		captureWebContentsId: capture.captureWindow.webContents.id,
		mimeType: capture.mimeType,
		chunkCount: capture.writer.chunkCount,
		bytesWritten: capture.writer.bytesWritten,
		permissionTrace: {
			events: capture.permissionTrace.events.map((event) => ({ ...event })),
		},
		error,
	};
}

function setCurrentStatus(capture: ActiveCapture): SapWebContentsCaptureStatus {
	lastStatus = statusFor(capture);
	return lastStatus;
}

function destroyCaptureWindowSoon(window: BrowserWindow): void {
	setTimeout(() => {
		if (!window.isDestroyed()) {
			window.destroy();
		}
	}, 50);
}

async function failCapture(capture: ActiveCapture, error: Error): Promise<void> {
	if (activeCapture !== capture || capture.failureInProgress) {
		return;
	}
	capture.failureInProgress = true;

	removeSourceListeners(capture);
	const telemetry = capture.telemetry;
	capture.telemetry = null;
	await telemetry?.dispose().catch(() => undefined);
	await persistTimelineArtifacts(capture).catch(() => undefined);
	activeCapture = null;
	lastStatus = {
		...statusFor(capture, error.message),
		phase: "failed",
	};
	capture.started.reject(error);
	capture.completion?.reject(error);
	await capture.writer.abort();
	if (!capture.captureWindow.isDestroyed()) {
		capture.captureWindow.destroy();
	}
}

function asPayload(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid SAP capture renderer payload.");
	}
	return value as Record<string, unknown>;
}

function requireActiveCapture(
	event: IpcMainInvokeEvent,
	payload: unknown,
): { capture: ActiveCapture; values: Record<string, unknown> } {
	const capture = activeCapture;
	const values = asPayload(payload);
	if (
		!capture ||
		event.sender !== capture.captureWindow.webContents ||
		values.sessionId !== capture.sessionId
	) {
		throw new Error("SAP capture renderer identity does not match the active session.");
	}
	return { capture, values };
}

function captureArtifactPaths(outputPath: string): {
	rawMasterPath: string;
	actionLogPath: string;
	cursorPath: string;
} {
	const directory = path.dirname(outputPath);
	const rawMasterPath = path.join(directory, "raw-master.mp4");
	return {
		rawMasterPath,
		actionLogPath: path.join(directory, "action-log.json"),
		cursorPath: `${rawMasterPath}.cursor.json`,
	};
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await fs.rm(filePath, { force: true });
	await fs.rename(temporaryPath, filePath);
}

async function persistTimelineArtifacts(
	capture: ActiveCapture,
	normalization?: BrowserCaptureNormalizeResult,
): Promise<{ actionLogPath: string; cursorPath: string }> {
	const paths = captureArtifactPaths(capture.writer.outputPath);
	const viewport = capture.timeline.snapshot().find((event) => event.viewport)?.viewport;
	const captureGeometry: RawActionTimelineDocument["captureGeometry"] = normalization
		? {
				viewport,
				contentRect: {
					x: 0,
					y: 0,
					width: normalization.probe.width,
					height: normalization.probe.height,
				},
			}
		: undefined;
	await Promise.all([
		writeJsonAtomic(paths.actionLogPath, capture.timeline.toDocument(captureGeometry)),
		writeJsonAtomic(paths.cursorPath, capture.timeline.toCursorSidecar()),
	]);
	return paths;
}

function removeSourceListeners(capture: ActiveCapture): void {
	const remove = capture.removeSourceListeners;
	capture.removeSourceListeners = null;
	remove?.();
}

async function armSourceTelemetry(capture: ActiveCapture): Promise<void> {
	if (capture.sourceWebContents.isDestroyed()) {
		throw new Error("The SAP BrowserWindow closed before browser telemetry was armed.");
	}
	if (capture.telemetry) return;
	capture.telemetry = await startCdpTelemetryRuntime({
		webContents: capture.sourceWebContents,
		sessionId: capture.sessionId,
		clock: capture.clock,
		onBatch: (payload) => {
			if (activeCapture !== capture) {
				throw new Error("CDP telemetry arrived outside its active capture session.");
			}
			capture.timeline.addBrowserBatch(payload);
		},
		onFatal: (error) => {
			if (activeCapture === capture) void failCapture(capture, error);
		},
	});
}

async function stopSourceTelemetry(capture: ActiveCapture): Promise<void> {
	const telemetry = capture.telemetry;
	if (!telemetry) throw new Error("The SAP browser CDP telemetry collector is not armed.");
	await telemetry.stop();
	capture.telemetry = null;
}

function toUint8Array(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	throw new Error("SAP capture chunk data must be binary.");
}

async function completeCapture(capture: ActiveCapture): Promise<CompletedSapWebContentsCapture> {
	const file = await capture.writer.complete();
	const mimeType = capture.mimeType;
	if (!mimeType) {
		throw new Error("SAP capture renderer did not report its WebM MIME type.");
	}
	const paths = captureArtifactPaths(file.outputPath);
	const normalization = await normalizeBrowserCapturePart(file.outputPath, paths.rawMasterPath);
	await persistTimelineArtifacts(capture, normalization);
	removeSourceListeners(capture);

	const result: CompletedSapWebContentsCapture = {
		...file,
		sessionId: capture.sessionId,
		sourceWebContentsId: capture.sourceWebContents.id,
		captureWebContentsId: capture.captureWindow.webContents.id,
		mimeType,
		rawMasterPath: paths.rawMasterPath,
		actionLogPath: paths.actionLogPath,
		cursorPath: paths.cursorPath,
		normalization,
	};
	activeCapture = null;
	lastStatus = {
		...statusFor(capture),
		phase: "completed",
	};
	capture.completion?.resolve(result);
	destroyCaptureWindowSoon(capture.captureWindow);
	return result;
}

function ensureRendererIpcHandlers(): void {
	if (rendererHandlersRegistered) return;
	rendererHandlersRegistered = true;

	ipcMain.handle(RENDERER_STARTED_CHANNEL, async (event, payload: unknown) => {
		const { capture, values } = requireActiveCapture(event, payload);
		if (capture.phase !== "starting" || capture.rendererStarted) {
			throw new Error("SAP capture renderer reported an invalid start transition.");
		}
		const mimeType = values.mimeType;
		if (typeof mimeType !== "string" || !mimeType.toLowerCase().startsWith("video/webm")) {
			const error = new Error("SAP capture renderer did not start a WebM recorder.");
			await failCapture(capture, error);
			throw error;
		}

		capture.mimeType = mimeType;
		capture.rendererStarted = true;
		setCurrentStatus(capture);
		return { ok: true };
	});

	ipcMain.handle(RENDERER_CHUNK_CHANNEL, async (event, payload: unknown) => {
		const { capture, values } = requireActiveCapture(event, payload);
		const sequence = values.sequence;
		if (!capture.rendererStarted) {
			throw new Error("SAP capture renderer sent a chunk outside the recording phase.");
		}
		if (typeof sequence !== "number") {
			throw new Error("SAP capture chunk sequence is missing.");
		}
		const data = toUint8Array(values.data);
		if (data.byteLength === 0 || data.byteLength > MAX_CHUNK_BYTES) {
			throw new Error("SAP capture chunk size is outside the allowed range.");
		}

		try {
			await capture.writer.writeChunk(sequence, data);
			if (capture.phase === "starting") {
				capture.phase = "recording";
				await armSourceTelemetry(capture);
				capture.started.resolve(setCurrentStatus(capture));
			}
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(errorMessage(error));
			await failCapture(capture, failure);
			throw failure;
		}

		if (capture.phase === "recording") {
			setCurrentStatus(capture);
		}
		return { ok: true };
	});

	ipcMain.handle(RENDERER_STOPPED_CHANNEL, async (event, payload: unknown) => {
		const { capture } = requireActiveCapture(event, payload);
		if (capture.phase !== "stopping") {
			throw new Error("SAP capture renderer stopped before a stop request.");
		}
		try {
			return await completeCapture(capture);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(errorMessage(error));
			await failCapture(capture, failure);
			throw failure;
		}
	});

	ipcMain.handle(RENDERER_FAILED_CHANNEL, async (event, payload: unknown) => {
		const { capture, values } = requireActiveCapture(event, payload);
		const reason =
			typeof values.reason === "string" && values.reason.trim()
				? values.reason.trim().slice(0, 2000)
				: "SAP capture renderer failed.";
		await failCapture(capture, new Error(reason));
		return { ok: true };
	});
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: NodeJS.Timeout | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function getSapWebContentsCaptureStatus(): SapWebContentsCaptureStatus {
	return activeCapture ? setCurrentStatus(activeCapture) : { ...lastStatus };
}

export async function startSapWebContentsCapture(
	sapWindow: BrowserWindow,
	outputPath: string,
	runJsonPath?: string,
): Promise<SapWebContentsCaptureStatus> {
	if (activeCapture || startInProgress) {
		throw new Error("A SAP WebContents capture is already active.");
	}
	startInProgress = true;
	try {
		const target = await readCaptureStartContext(outputPath, runJsonPath);
		return await startVerifiedCapture(sapWindow, outputPath, target);
	} finally {
		startInProgress = false;
	}
}

async function startVerifiedCapture(
	sapWindow: BrowserWindow, outputPath: string, target: CaptureStartContext,
): Promise<SapWebContentsCaptureStatus> {
	ensureRendererIpcHandlers();
	if (sapWindow.isDestroyed() || sapWindow.webContents.isDestroyed()) {
		throw new Error("The Recordly SAP BrowserWindow is not available.");
	}
	const source = sapWindow.webContents;
	const href = source.getURL();
	if (new URL(href).origin !== target.origin) {
		throw new Error("The SAP BrowserWindow is outside this run's verified DEV/QAS origin.");
	}
	const assertSameDocument = () => {
		if (source.isDestroyed() || source.isLoading() || source.getURL() !== href) {
			throw new Error("The SAP page changed or is still loading. Check the live page before capture.");
		}
	};
	const readIdentity = async () => {
		assertSameDocument();
		const state = await executeSapWebContentsAction(sapWindow, { action: "state" });
		assertSameDocument();
		return capturePageIdentity(target, href, state.frames ?? []);
	};
	const initialPage = await readIdentity();
	const rendererBaseUrl = getPackagedRendererBaseUrl();
	if (!rendererBaseUrl) {
		throw new Error("The Recordly loopback renderer server is not ready.");
	}
	const rendererUrl = new URL("/recordly-sap-capture.html", rendererBaseUrl).href;
	// getMediaSourceId is scoped to its registered requester. Keep the hidden
	// requester in Recordly's default session, matching the SAP source window.
	const captureSession = session.defaultSession;
	let captureWindow: BrowserWindow;
	creatingCaptureWindow = true;
	try {
		captureWindow = new BrowserWindow({
			width: 16,
			height: 16,
			show: false,
			paintWhenInitiallyHidden: true,
			skipTaskbar: true,
			webPreferences: {
				preload: getCaptureAssetPath("preload.cjs"),
				session: captureSession,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: true,
				backgroundThrottling: false,
				spellcheck: false,
			},
		});
	} finally {
		creatingCaptureWindow = false;
	}

	configureCaptureWindowNavigation(captureWindow, rendererUrl);
	let writer: AtomicWebmWriter;
	try {
		await Promise.all([captureWindow.loadURL(rendererUrl), new Promise((resolve) => setTimeout(resolve, 350))]);
		if (await readIdentity() !== initialPage) {
			throw new Error("The SAP start page changed during capture preparation.");
		}
		writer = await AtomicWebmWriter.create(outputPath);
	} catch (error) {
		if (!captureWindow.isDestroyed()) captureWindow.destroy();
		throw error;
	}
	enterSapWebContentsCaptureMode();
	const permissionTrace: SapWebContentsCapturePermissionTrace = { events: [] };

	const sessionId = randomUUID();
	const clock = createMonotonicSessionClock();
	const capture: ActiveCapture = {
		sessionId,
		verifiedStart: {
			system: target.system, origin: target.origin, client: target.client,
			page: target.recoveryPage ? "recovery" : "fiori-home",
		},
		sourceWebContents: sapWindow.webContents,
		captureWindow,
		writer,
		phase: "starting",
		mimeType: null,
		rendererStarted: false,
		permissionTrace,
		started: createDeferred<SapWebContentsCaptureStatus>(),
		completion: null,
		clock,
		timeline: new RawActionTimeline(sessionId, sapWindow.webContents.id, clock),
		telemetry: null,
		failureInProgress: false,
		removeSourceListeners: null,
	};
	activeCapture = capture;
	setCurrentStatus(capture);

	const onDidNavigate = (_event: Electron.Event, url: string) => {
		if (activeCapture !== capture) return;
		try {
			capture.timeline.addNavigation("did-navigate", url);
		} catch {
			// SAP navigation policy already restricts this WebContents to HTTP(S).
		}
	};
	const onDidNavigateInPage = (_event: Electron.Event, url: string) => {
		if (activeCapture !== capture) return;
		try {
			capture.timeline.addNavigation("did-navigate-in-page", url);
		} catch {
			// The browser collector remains the source of DOM-level navigation evidence.
		}
	};
	sapWindow.webContents.on("did-navigate", onDidNavigate);
	sapWindow.webContents.on("did-navigate-in-page", onDidNavigateInPage);
	capture.removeSourceListeners = () => {
		sapWindow.webContents.removeListener("did-navigate", onDidNavigate);
		sapWindow.webContents.removeListener("did-navigate-in-page", onDidNavigateInPage);
	};

	const rendererGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
		void failCapture(
			capture,
			new Error(`SAP capture renderer exited unexpectedly (${details.reason}).`),
		);
	};
	captureWindow.webContents.once("render-process-gone", rendererGone);
	captureWindow.webContents.once("destroyed", () => {
		if (activeCapture === capture) {
			void failCapture(capture, new Error("SAP capture renderer was destroyed."));
		}
	});
	sapWindow.webContents.once("destroyed", () => {
		if (activeCapture === capture) {
			void failCapture(
				capture,
				new Error("The SAP BrowserWindow was closed during capture."),
			);
		}
	});

	try {
		assertSameDocument();
		const streamId = getBoundTabMediaSourceId(sapWindow.webContents, captureWindow.webContents);
		if (!streamId) {
			throw new Error("Electron did not return a SAP WebContents media source ID.");
		}
		captureWindow.webContents.send(RENDERER_START_CHANNEL, {
			sessionId: capture.sessionId,
			streamId,
			timesliceMs: TIMESLICE_MS,
		});
		return await withTimeout(
			capture.started.promise,
			START_TIMEOUT_MS,
			"SAP WebContents capture did not produce its first media chunk in time.",
		);
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(errorMessage(error));
		await failCapture(capture, failure);
		throw failure;
	}
}

export async function stopSapWebContentsCapture(): Promise<CompletedSapWebContentsCapture> {
	const capture = activeCapture;
	if (!capture || capture.phase !== "recording") {
		throw new Error("No recording SAP WebContents capture is active.");
	}

	capture.phase = "stopping";
	capture.completion = createDeferred<CompletedSapWebContentsCapture>();
	setCurrentStatus(capture);

	try {
		await stopSourceTelemetry(capture);
		capture.captureWindow.webContents.send(RENDERER_STOP_CHANNEL, {
			sessionId: capture.sessionId,
		});
		return await withTimeout(
			capture.completion.promise,
			STOP_TIMEOUT_MS,
			"SAP WebContents capture did not stop in time.",
		);
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(errorMessage(error));
		await failCapture(capture, failure);
		throw failure;
	}
}

export async function shutdownSapWebContentsCapture(): Promise<void> {
	const capture = activeCapture;
	if (!capture) return;
	if (capture.phase === "recording") {
		await stopSapWebContentsCapture().catch(() => undefined);
		return;
	}
	await failCapture(capture, new Error("Recordly exited before SAP capture completed."));
}

export function registerSapWebContentsCaptureControl(options: CaptureControlOptions): void {
	ensureRendererIpcHandlers();
	if (controlHandlersRegistered) return;
	controlHandlersRegistered = true;

	const assertControlSender = (event: IpcMainInvokeEvent): void => {
		if (!options.isControlSender(event.sender)) {
			throw new Error("SAP WebContents capture control is restricted to the Recordly UI.");
		}
	};

	ipcMain.handle(CONTROL_START_CHANNEL, async (event, outputPath: unknown) => {
		assertControlSender(event);
		if (typeof outputPath !== "string") {
			throw new Error("SAP WebContents capture output path is required.");
		}
		const sapWindow = options.getSapBrowserWindow();
		if (!sapWindow) {
			throw new Error("Open the Recordly SAP Browser before starting capture.");
		}
		return startSapWebContentsCapture(sapWindow, outputPath);
	});
	ipcMain.handle(CONTROL_STOP_CHANNEL, async (event) => {
		assertControlSender(event);
		return stopSapWebContentsCapture();
	});
	ipcMain.handle(CONTROL_STATUS_CHANNEL, (event) => {
		assertControlSender(event);
		return getSapWebContentsCaptureStatus();
	});
}
