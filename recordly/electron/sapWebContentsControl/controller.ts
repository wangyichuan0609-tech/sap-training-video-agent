import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
	acquireCdpFrameBridge,
	boundsForQuad,
	type CdpEvaluateResult,
	type CdpFrameBridge,
	type CdpFrameDescriptor,
	type CdpQuad,
	selectLargestUsableQuad,
} from "./cdpFrameBridge";
import { readSapLoginCredentials, readSecretText } from "./credentials";
import { legacyGridCellDisplayMatches } from "./legacyGridCell";
import {
	buildSapPageActionScript,
	type SapPageAction,
	type SapPageActionResult,
	type SapPageControlSummary,
	type SapPageProbeResult,
	type SapPageSelector,
} from "./pageRuntime";

const MAX_TEXT_LENGTH = 10_000;
const MAX_LEGACY_GRID_CELL_TEXT_LENGTH = 200;
const MAX_SELECTOR_LENGTH = 1_000;

export type SapWebContentsActionInput =
	| { action: "state" }
	| { action: "login-from-file"; credentialFilePath: string }
	| {
			action: "change-password-from-files";
			credentialFilePath: string;
			newPasswordFilePath: string;
	  }
	| { action: "find" | "click"; selector: SapPageSelector }
	| { action: "press"; selector: SapPageSelector; key: string }
	| { action: "scroll"; selector: SapPageSelector; deltaX?: number; deltaY: number }
	| {
			action: "type";
			selector: SapPageSelector;
			text?: string;
			secretFilePath?: string;
	  }
	| {
			action: "type-legacy-grid-cell";
			selector: SapPageSelector;
			text: string;
			commitWithEnter?: boolean;
	  }
	| { action: "wait"; selector: SapPageSelector; timeoutMs?: number };

export interface SapActionEnvelope {
	actionId: string;
	action: SapWebContentsActionInput["action"];
	targetName: string;
	controlType: string;
	domRect: { x: number; y: number; width: number; height: number };
	url: string;
	title: string;
	visibleResult: string;
	actualOutcome: string;
	waitCondition?: string;
	startedAt: string;
	completedAt: string;
	redacted: boolean;
	frame?: SapTargetFrame;
	frames?: SapFrameSummary[];
}

export interface SapTargetFrame {
	frameId: string;
	parentFrameId?: string;
	origin: string;
	isMainFrame: boolean;
}

export interface SapFrameSummary {
	frameId: string;
	parentFrameId?: string;
	url: string;
	title: string;
	visibleResult: string;
	mainFrame: boolean;
	captureReady?: boolean;
	sapClient?: string;
	controls?: SapPageControlSummary[];
}

function safeText(value: unknown, label: string, maximumLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
		throw new Error(`${label} must be a non-empty string within the length limit.`);
	}
	return value;
}

function normalizeSelector(value: unknown): SapPageSelector {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("selector must be a structured object.");
	}
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => key !== "by" && key !== "value")) {
		throw new Error("selector contains unsupported fields.");
	}
	if (raw.by !== "id" && raw.by !== "css" && raw.by !== "exactText" && raw.by !== "visibleText") {
		throw new Error("selector.by must be id, css, exactText, or visibleText.");
	}
	return {
		by: raw.by,
		value: safeText(raw.value, "selector.value", MAX_SELECTOR_LENGTH),
	} as SapPageSelector;
}

function normalizeAction(value: unknown): SapWebContentsActionInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("SAP action must be a structured object.");
	}
	const raw = value as Record<string, unknown>;
	switch (raw.action) {
		case "state":
			if (Object.keys(raw).length !== 1) throw new Error("state has unsupported fields.");
			return { action: "state" };
		case "login-from-file":
			if (Object.keys(raw).some((key) => key !== "action" && key !== "credentialFilePath")) {
				throw new Error("login-from-file has unsupported fields.");
			}
			return {
				action: "login-from-file",
				credentialFilePath: safeText(
					raw.credentialFilePath,
					"credentialFilePath",
					MAX_SELECTOR_LENGTH,
				),
			};
		case "change-password-from-files":
			if (
				Object.keys(raw).some(
					(key) =>
						key !== "action" &&
						key !== "credentialFilePath" &&
						key !== "newPasswordFilePath",
				)
			) {
				throw new Error("change-password-from-files has unsupported fields.");
			}
			return {
				action: "change-password-from-files",
				credentialFilePath: safeText(
					raw.credentialFilePath,
					"credentialFilePath",
					MAX_SELECTOR_LENGTH,
				),
				newPasswordFilePath: safeText(
					raw.newPasswordFilePath,
					"newPasswordFilePath",
					MAX_SELECTOR_LENGTH,
				),
			};
		case "find":
		case "click":
			if (Object.keys(raw).some((key) => key !== "action" && key !== "selector")) {
				throw new Error(`${raw.action} has unsupported fields.`);
			}
			return { action: raw.action, selector: normalizeSelector(raw.selector) };
		case "press":
			if (
				Object.keys(raw).some(
					(key) => key !== "action" && key !== "selector" && key !== "key",
				)
			) {
				throw new Error("press has unsupported fields.");
			}
			return {
				action: "press",
				selector: normalizeSelector(raw.selector),
				key: safeText(raw.key, "key", 80),
			};
		case "scroll": {
			if (
				Object.keys(raw).some(
					(key) =>
						key !== "action" &&
						key !== "selector" &&
						key !== "deltaX" &&
						key !== "deltaY",
				)
			) {
				throw new Error("scroll has unsupported fields.");
			}
			const deltaX = raw.deltaX === undefined ? 0 : Number(raw.deltaX);
			const deltaY = raw.deltaY === undefined ? 0 : Number(raw.deltaY);
			if (
				!Number.isFinite(deltaX) ||
				!Number.isFinite(deltaY) ||
				Math.abs(deltaX) > 10_000 ||
				Math.abs(deltaY) > 10_000 ||
				(deltaX === 0 && deltaY === 0)
			) {
				throw new Error("scroll requires a non-zero deltaX or deltaY within 10000 pixels.");
			}
			return {
				action: "scroll",
				selector: normalizeSelector(raw.selector),
				deltaX,
				deltaY,
			};
		}
		case "type": {
			if (
				Object.keys(raw).some(
					(key) =>
						key !== "action" &&
						key !== "selector" &&
						key !== "text" &&
						key !== "secretFilePath",
				)
			) {
				throw new Error("type has unsupported fields.");
			}
			const text = raw.text;
			const secretFilePath = raw.secretFilePath;
			if ((text === undefined) === (secretFilePath === undefined)) {
				throw new Error("type requires exactly one of text or secretFilePath.");
			}
			return {
				action: "type",
				selector: normalizeSelector(raw.selector),
				...(text === undefined
					? {
							secretFilePath: safeText(
								secretFilePath,
								"secretFilePath",
								MAX_SELECTOR_LENGTH,
							),
						}
					: { text: safeText(text, "text", MAX_TEXT_LENGTH) }),
			};
		}
		case "type-legacy-grid-cell": {
			if (
				Object.keys(raw).some(
					(key) =>
						key !== "action" &&
						key !== "selector" &&
						key !== "text" &&
						key !== "commitWithEnter",
				)
			) {
				throw new Error("type-legacy-grid-cell has unsupported fields.");
			}
			if (raw.commitWithEnter !== undefined && typeof raw.commitWithEnter !== "boolean") {
				throw new Error("type-legacy-grid-cell commitWithEnter must be a boolean.");
			}
			return {
				action: "type-legacy-grid-cell",
				selector: normalizeSelector(raw.selector),
				text: safeText(raw.text, "text", MAX_LEGACY_GRID_CELL_TEXT_LENGTH),
				...(raw.commitWithEnter === true ? { commitWithEnter: true } : {}),
			};
		}
		case "wait": {
			if (
				Object.keys(raw).some(
					(key) => key !== "action" && key !== "selector" && key !== "timeoutMs",
				)
			) {
				throw new Error("wait has unsupported fields.");
			}
			const timeoutMs = raw.timeoutMs === undefined ? 5_000 : Number(raw.timeoutMs);
			if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
				throw new Error("wait timeoutMs must be between 0 and 30000.");
			}
			return { action: "wait", selector: normalizeSelector(raw.selector), timeoutMs };
		}
		default:
			throw new Error("Unsupported SAP WebContents action.");
	}
}

function redactSecrets(value: string, secrets: readonly string[]): string {
	let result = value;
	for (const secret of secrets) {
		if (secret) result = result.split(secret).join("[REDACTED]");
	}
	return result;
}

interface CdpKeyDefinition {
	key: string;
	code: string;
	virtualKeyCode: number;
	text?: string;
}

function cdpKeyDefinition(value: string): CdpKeyDefinition {
	const normalized = value.trim();
	const aliases: Record<string, string> = {
		Return: "Enter",
		Esc: "Escape",
		Space: "Space",
	};
	const key = aliases[normalized] ?? normalized;
	const definitions: Record<string, CdpKeyDefinition> = {
		Enter: { key: "Enter", code: "Enter", virtualKeyCode: 13, text: "\r" },
		Escape: { key: "Escape", code: "Escape", virtualKeyCode: 27 },
		Tab: { key: "Tab", code: "Tab", virtualKeyCode: 9, text: "\t" },
		Backspace: { key: "Backspace", code: "Backspace", virtualKeyCode: 8 },
		Delete: { key: "Delete", code: "Delete", virtualKeyCode: 46 },
		ArrowUp: { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38 },
		ArrowDown: { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40 },
		ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 },
		ArrowRight: { key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 },
		Space: { key: " ", code: "Space", virtualKeyCode: 32, text: " " },
		F4: { key: "F4", code: "F4", virtualKeyCode: 115 },
	};
	const definition = definitions[key];
	if (!definition) {
		throw new Error(
			"press key must be Enter, Escape, Tab, Backspace, Delete, an Arrow key, Space, or F4.",
		);
	}
	return definition;
}

function validatePageResult(value: unknown, secrets: readonly string[]): SapPageActionResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("SAP page action returned an invalid result.");
	}
	const raw = value as Record<string, unknown>;
	const rect = raw.domRect as Record<string, unknown> | undefined;
	if (!rect || typeof rect !== "object") {
		throw new Error("SAP page action did not return a DOMRect.");
	}
	const finiteRectValue = (key: "x" | "y" | "width" | "height"): number => {
		const result = Number(rect[key]);
		if (!Number.isFinite(result))
			throw new Error("SAP page action returned an invalid DOMRect.");
		return result;
	};
	let controls: SapPageControlSummary[] | undefined;
	if (raw.controls !== undefined) {
		if (!Array.isArray(raw.controls) || raw.controls.length > 160) {
			throw new Error("SAP page action returned an invalid control inventory.");
		}
		const optional = (control: Record<string, unknown>, key: string, maximumLength: number) => {
			const value = control[key];
			if (value === undefined || value === null || value === "") return undefined;
			if (typeof value !== "string" || value.length > maximumLength) {
				throw new Error("SAP page action returned an invalid control inventory field.");
			}
			return redactSecrets(value, secrets);
		};
		controls = raw.controls.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error("SAP page action returned an invalid control inventory entry.");
			}
			const control = entry as Record<string, unknown>;
			return {
				...(optional(control, "id", 240) ? { id: optional(control, "id", 240) } : {}),
				...(optional(control, "name", 240) ? { name: optional(control, "name", 240) } : {}),
				tagName: safeText(control.tagName, "control.tagName", 80),
				...(optional(control, "role", 80) ? { role: optional(control, "role", 80) } : {}),
				controlType: safeText(control.controlType, "control.controlType", 120),
				targetName: redactSecrets(
					safeText(control.targetName, "control.targetName", 300),
					secrets,
				),
				...(optional(control, "ariaLabel", 300)
					? { ariaLabel: optional(control, "ariaLabel", 300) }
					: {}),
				...(optional(control, "title", 300)
					? { title: optional(control, "title", 300) }
					: {}),
				...(optional(control, "placeholder", 300)
					? { placeholder: optional(control, "placeholder", 300) }
					: {}),
				...(optional(control, "text", 300) ? { text: optional(control, "text", 300) } : {}),
			};
		});
	}
	return {
		targetName: redactSecrets(safeText(raw.targetName, "targetName", 500), secrets),
		controlType: safeText(raw.controlType, "controlType", 120),
		domRect: {
			x: finiteRectValue("x"),
			y: finiteRectValue("y"),
			width: finiteRectValue("width"),
			height: finiteRectValue("height"),
		},
		url: sanitizedFrameUrl(safeText(raw.url, "url", 4_000)),
		title: redactSecrets(String(raw.title ?? "").slice(0, 500), secrets),
		visibleResult: redactSecrets(String(raw.visibleResult ?? "").slice(0, 800), secrets),
		redacted: raw.redacted === true,
		...(typeof raw.captureReady === "boolean" ? { captureReady: raw.captureReady } : {}),
		...(typeof raw.sapClient === "string" && /^\d{3}$/u.test(raw.sapClient) ? { sapClient: raw.sapClient } : {}),
		...(controls ? { controls } : {}),
	};
}

function validateProbeResult(value: unknown): SapPageProbeResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("SAP page probe returned an invalid result.");
	}
	const matchCount = Number((value as Record<string, unknown>).matchCount);
	if (!Number.isInteger(matchCount) || matchCount < 0) {
		throw new Error("SAP page probe returned an invalid match count.");
	}
	return { matchCount };
}

function sanitizedFrameUrl(value: string): string {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("Unsupported URL protocol.");
		}
		return parsed.origin;
	} catch {
		throw new Error("SAP page action returned an invalid HTTP(S) URL.");
	}
}

async function evaluatePageAction(
	bridge: CdpFrameBridge,
	frame: CdpFrameDescriptor,
	action: SapPageAction,
): Promise<unknown> {
	const response = await bridge.evaluateInFrame(frame.frameId, buildSapPageActionScript(action), {
		awaitPromise: true,
		returnByValue: true,
		userGesture: action.kind === "login" || action.kind === "change-password",
	});
	return response.result.value;
}

interface ResolvedTarget {
	frame: CdpFrameDescriptor;
	result: SapPageActionResult;
}

async function resolveUniqueTarget(
	bridge: CdpFrameBridge,
	selector: SapPageSelector,
	secrets: readonly string[],
): Promise<ResolvedTarget> {
	bridge.assertHealthy();
	const frames = bridge.getReadyFrames();
	if (frames.length === 0) throw new Error("No allowed HTTP(S) frame has a live DOM context.");
	const probes = await Promise.all(
		frames.map(async (frame) => ({
			frame,
			probe: validateProbeResult(
				await evaluatePageAction(bridge, frame, { kind: "probe", selector }),
			),
		})),
	);
	const availableProbes = (
		await Promise.all(
			probes.map(async (entry) => ({
				...entry,
				available:
					entry.probe.matchCount === 0 ||
					(await bridge.isFrameCandidateAvailable(entry.frame.frameId)),
			})),
		)
	).filter((entry) => entry.available);
	const matchCount = availableProbes.reduce((total, entry) => total + entry.probe.matchCount, 0);
	if (matchCount !== 1) {
		throw new Error(
			`Target matched ${matchCount} elements across all frames; exactly one is required.`,
		);
	}
	const match = availableProbes.find((entry) => entry.probe.matchCount === 1);
	if (!match) throw new Error("The globally unique target frame could not be resolved.");
	const result = validatePageResult(
		await evaluatePageAction(bridge, match.frame, { kind: "find", selector }),
		secrets,
	);
	return { frame: match.frame, result };
}

async function waitForUniqueTarget(
	bridge: CdpFrameBridge,
	selector: SapPageSelector,
	timeoutMs: number,
	secrets: readonly string[],
): Promise<ResolvedTarget> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown = new Error("Target was not found.");
	do {
		bridge.assertHealthy();
		try {
			return await resolveUniqueTarget(bridge, selector, secrets);
		} catch (error) {
			lastError = error;
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() <= deadline);
	throw lastError;
}

interface RemoteTarget {
	objectId: string;
	frame: CdpFrameDescriptor;
}

async function resolveRemoteTarget(
	bridge: CdpFrameBridge,
	frame: CdpFrameDescriptor,
	selector: SapPageSelector,
): Promise<RemoteTarget> {
	const response = await bridge.evaluateInFrame(
		frame.frameId,
		buildSapPageActionScript({ kind: "target", selector }),
		{ awaitPromise: true, returnByValue: false },
	);
	const objectId = response.result.objectId;
	if (!objectId || response.result.subtype !== "node") {
		throw new Error("The target did not resolve to a live DOM node.");
	}
	return { objectId, frame };
}

async function releaseRemoteTarget(bridge: CdpFrameBridge, target: RemoteTarget): Promise<void> {
	await bridge
		.send("Runtime.releaseObject", { objectId: target.objectId }, target.frame.sessionId)
		.catch(() => undefined);
}

async function assertTargetHit(bridge: CdpFrameBridge, target: RemoteTarget): Promise<void> {
	const response = await bridge.send<CdpEvaluateResult>(
		"Runtime.callFunctionOn",
		{
			objectId: target.objectId,
			functionDeclaration: `function () {
				const rect = this.getBoundingClientRect();
				const hit = this.ownerDocument.elementFromPoint(
					rect.left + rect.width / 2,
					rect.top + rect.height / 2
				);
				return Boolean(hit && (hit === this || this.contains(hit)));
			}`,
			returnByValue: true,
		},
		target.frame.sessionId,
	);
	if (response.exceptionDetails || response.result.value !== true) {
		throw new Error("The target is obscured at its click point.");
	}
}

async function geometryForRemoteTarget(
	bridge: CdpFrameBridge,
	target: RemoteTarget,
	scrollIntoView: boolean,
): Promise<{ quad: CdpQuad; rect: SapPageActionResult["domRect"] }> {
	if (scrollIntoView) {
		await bridge.send(
			"DOM.scrollIntoViewIfNeeded",
			{ objectId: target.objectId },
			target.frame.sessionId,
		);
	}
	const response = await bridge.send<{ quads?: unknown }>(
		"DOM.getContentQuads",
		{ objectId: target.objectId },
		target.frame.sessionId,
	);
	const localQuad = selectLargestUsableQuad(response.quads);
	const quad = await bridge.mapSessionQuadToRoot(target.frame.sessionId, localQuad);
	return { quad, rect: boundsForQuad(quad) };
}

async function geometryForSelector(
	bridge: CdpFrameBridge,
	frame: CdpFrameDescriptor,
	selector: SapPageSelector,
	scrollIntoView = false,
): Promise<{ quad: CdpQuad; rect: SapPageActionResult["domRect"] }> {
	const target = await resolveRemoteTarget(bridge, frame, selector);
	try {
		return await geometryForRemoteTarget(bridge, target, scrollIntoView);
	} finally {
		await releaseRemoteTarget(bridge, target);
	}
}

interface CollectedState {
	result: SapPageActionResult;
	frames: SapFrameSummary[];
}

async function collectState(
	bridge: CdpFrameBridge,
	secrets: readonly string[],
): Promise<CollectedState> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			bridge.assertHealthy();
			const frames = bridge.getReadyFrames();
			if (frames.length === 0)
				throw new Error("No allowed HTTP(S) frame has a live DOM context.");
			const entries = await Promise.all(
				frames.map(async (frame) => ({
					frame,
					result: validatePageResult(
						await evaluatePageAction(bridge, frame, { kind: "state" }),
						secrets,
					),
				})),
			);
			entries.sort((left, right) => {
				const leftMain = left.frame.isSessionRoot && left.frame.sessionId === undefined;
				const rightMain = right.frame.isSessionRoot && right.frame.sessionId === undefined;
				return (
					Number(rightMain) - Number(leftMain) ||
					left.frame.frameId.localeCompare(right.frame.frameId)
				);
			});
			const primary = entries[0];
			const perFrameLimit = Math.max(120, Math.floor(760 / entries.length));
			const visibleResult = entries
				.map((entry) => entry.result.visibleResult)
				.filter(Boolean)
				.map((value) => value.slice(0, perFrameLimit))
				.join(" | ")
				.slice(0, 800);
			return {
				result: { ...primary.result, visibleResult },
				frames: entries.map(({ frame, result }) => ({
					frameId: frame.frameId,
					...(frame.parentFrameId ? { parentFrameId: frame.parentFrameId } : {}),
					url: sanitizedFrameUrl(result.url),
					title: result.title,
					visibleResult: result.visibleResult,
					mainFrame: frame.isSessionRoot && frame.sessionId === undefined,
					captureReady: result.captureReady,
					...(result.sapClient ? { sapClient: result.sapClient } : {}),
					...(result.controls ? { controls: result.controls } : {}),
				})),
			};
		} catch (error) {
			lastError = error;
			if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw lastError;
}

function quadCenter(quad: CdpQuad): { x: number; y: number } {
	return {
		x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
		y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
	};
}

async function assertRootPointVisible(
	bridge: CdpFrameBridge,
	point: { x: number; y: number },
): Promise<void> {
	const rootFrame = bridge
		.getReadyFrames()
		.find((frame) => frame.isSessionRoot && frame.sessionId === undefined);
	if (!rootFrame) throw new Error("The top-level SAP frame is not available.");
	const viewport = await bridge.evaluateInFrame(
		rootFrame.frameId,
		"({ width: window.innerWidth, height: window.innerHeight })",
		{ returnByValue: true },
	);
	const value = viewport.result.value as { width?: unknown; height?: unknown } | undefined;
	const width = Number(value?.width);
	const height = Number(value?.height);
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		point.x < 0 ||
		point.y < 0 ||
		point.x >= width ||
		point.y >= height
	) {
		throw new Error("The mapped target point is outside the top-level viewport.");
	}
}

async function dispatchTrustedClick(bridge: CdpFrameBridge, quad: CdpQuad): Promise<void> {
	const point = quadCenter(quad);
	await assertRootPointVisible(bridge, point);
	await bridge.send("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: point.x,
		y: point.y,
	});
	await bridge.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: point.x,
		y: point.y,
		button: "left",
		clickCount: 1,
	});
	await bridge.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: point.x,
		y: point.y,
		button: "left",
		clickCount: 1,
	});
}

async function dispatchTrustedKey(bridge: CdpFrameBridge, value: string): Promise<void> {
	const definition = cdpKeyDefinition(value);
	await dispatchTrustedKeyDefinition(bridge, definition);
}

async function dispatchTrustedKeyDefinition(
	bridge: CdpFrameBridge,
	definition: CdpKeyDefinition,
	modifiers = 0,
): Promise<void> {
	const common = {
		key: definition.key,
		code: definition.code,
		windowsVirtualKeyCode: definition.virtualKeyCode,
		nativeVirtualKeyCode: definition.virtualKeyCode,
		...(modifiers ? { modifiers } : {}),
	};
	await bridge.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		...common,
		...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}),
	});
	await bridge.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function assertTargetFocused(bridge: CdpFrameBridge, target: RemoteTarget): Promise<void> {
	const response = await bridge.send<CdpEvaluateResult>(
		"Runtime.callFunctionOn",
		{
			objectId: target.objectId,
			functionDeclaration: `function () {
				const active = this.ownerDocument.activeElement;
				return active === this || this.contains(active);
			}`,
			returnByValue: true,
		},
		target.frame.sessionId,
	);
	if (response.exceptionDetails || response.result.value !== true) {
		throw new Error("The target did not retain focus for trusted text input.");
	}
}

async function targetValueLength(bridge: CdpFrameBridge, target: RemoteTarget): Promise<number> {
	const response = await bridge.send<CdpEvaluateResult>(
		"Runtime.callFunctionOn",
		{
			objectId: target.objectId,
			functionDeclaration: `function () {
				if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
					return this.value.length;
				}
				if (this.isContentEditable) return (this.textContent || "").length;
				return -1;
			}`,
			returnByValue: true,
		},
		target.frame.sessionId,
	);
	const length = Number(response.result.value);
	if (
		response.exceptionDetails ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > 10_000
	) {
		throw new Error("The trusted text target did not expose a safe value length.");
	}
	return length;
}

interface CdpTextKeyDefinition extends CdpKeyDefinition {
	text: string;
	modifiers?: number;
}

function cdpTextKeyDefinition(character: string): CdpTextKeyDefinition | null {
	if (/^[A-Za-z]$/.test(character)) {
		const upper = character.toUpperCase();
		return {
			key: character,
			code: `Key${upper}`,
			virtualKeyCode: upper.charCodeAt(0),
			text: character,
			...(character === upper ? { modifiers: 8 } : {}),
		};
	}
	if (/^[0-9]$/.test(character)) {
		return {
			key: character,
			code: `Digit${character}`,
			virtualKeyCode: character.charCodeAt(0),
			text: character,
		};
	}
	const punctuation: Record<string, CdpTextKeyDefinition> = {
		" ": { key: " ", code: "Space", virtualKeyCode: 32, text: " " },
		"-": { key: "-", code: "Minus", virtualKeyCode: 189, text: "-" },
		"/": { key: "/", code: "Slash", virtualKeyCode: 191, text: "/" },
		".": { key: ".", code: "Period", virtualKeyCode: 190, text: "." },
		":": {
			key: ":",
			code: "Semicolon",
			virtualKeyCode: 186,
			text: ":",
			modifiers: 8,
		},
	};
	return punctuation[character] ?? null;
}

async function dispatchTrustedTextCharacter(
	bridge: CdpFrameBridge,
	character: string,
): Promise<void> {
	const definition = cdpTextKeyDefinition(character);
	if (definition) {
		await dispatchTrustedKeyDefinition(bridge, definition, definition.modifiers ?? 0);
		return;
	}
	const codePoint = character.codePointAt(0);
	if (codePoint !== undefined && codePoint > 0x7f) {
		await bridge.send("Input.insertText", { text: character });
		return;
	}
	throw new Error("Trusted CDP text input contains an unsupported ASCII character.");
}

async function dispatchTrustedReplaceText(
	bridge: CdpFrameBridge,
	target: RemoteTarget,
	text: string,
): Promise<void> {
	const previousLength = await targetValueLength(bridge, target);
	await dispatchTrustedKeyDefinition(bridge, {
		key: "End",
		code: "End",
		virtualKeyCode: 35,
	});
	const backspace = cdpKeyDefinition("Backspace");
	for (let index = 0; index < previousLength; index += 1) {
		await dispatchTrustedKeyDefinition(bridge, backspace);
	}
	await assertTargetValue(bridge, target, "");
	for (const character of text) {
		await dispatchTrustedTextCharacter(bridge, character);
		await new Promise((resolve) => setTimeout(resolve, 35));
	}
}

async function assertTargetValue(
	bridge: CdpFrameBridge,
	target: RemoteTarget,
	expected: string,
): Promise<void> {
	const response = await bridge.send<CdpEvaluateResult>(
		"Runtime.callFunctionOn",
		{
			objectId: target.objectId,
			functionDeclaration: `function (expected) {
				if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
					return this.value === expected;
				}
				if (this.isContentEditable) return this.textContent === expected;
				return false;
			}`,
			arguments: [{ value: expected }],
			returnByValue: true,
		},
		target.frame.sessionId,
	);
	if (response.exceptionDetails || response.result.value !== true) {
		throw new Error("Trusted CDP text input did not produce the requested control value.");
	}
}

interface LegacyGridCellInspection {
	eligible: boolean;
	focused: boolean;
	display: string;
}

async function inspectLegacyGridCell(
	bridge: CdpFrameBridge,
	target: RemoteTarget,
): Promise<LegacyGridCellInspection> {
	const response = await bridge.send<CdpEvaluateResult>(
		"Runtime.callFunctionOn",
		{
			objectId: target.objectId,
			functionDeclaration: `function () {
				const eligible =
					this instanceof HTMLSpanElement &&
					this.getAttribute("role") === "textbox" &&
					this.isContentEditable !== true &&
					!this.querySelector("input,textarea,[contenteditable='true']");
				return {
					eligible,
					focused: this.ownerDocument.activeElement === this,
					display: String(this.innerText || this.textContent || "").slice(0, 1000),
				};
			}`,
			returnByValue: true,
		},
		target.frame.sessionId,
	);
	const value = response.result.value as Record<string, unknown> | undefined;
	if (
		response.exceptionDetails ||
		!value ||
		typeof value !== "object" ||
		typeof value.eligible !== "boolean" ||
		typeof value.focused !== "boolean" ||
		typeof value.display !== "string" ||
		value.display.length > 1_000
	) {
		throw new Error("The legacy grid cell could not be inspected safely.");
	}
	return {
		eligible: value.eligible,
		focused: value.focused,
		display: value.display,
	};
}

function assertLegacyGridCellEligible(inspection: LegacyGridCellInspection): void {
	if (!inspection.eligible) {
		throw new Error(
			"type-legacy-grid-cell requires a non-editable span[role='textbox'] target.",
		);
	}
}

async function dispatchTrustedLegacyGridCellText(
	bridge: CdpFrameBridge,
	text: string,
): Promise<void> {
	const definitions = [...text].map((character) => {
		const definition = cdpTextKeyDefinition(character);
		if (!definition) {
			throw new Error(
				"type-legacy-grid-cell text contains a character without trusted key metadata.",
			);
		}
		return definition;
	});
	for (const definition of definitions) {
		await dispatchTrustedLegacyGridCellCharacter(bridge, definition);
		await new Promise((resolve) => setTimeout(resolve, 35));
	}
}

async function dispatchTrustedLegacyGridCellCharacter(
	bridge: CdpFrameBridge,
	definition: CdpTextKeyDefinition,
): Promise<void> {
	const modifiers = definition.modifiers ?? 0;
	const common = {
		key: definition.key,
		code: definition.code,
		windowsVirtualKeyCode: definition.virtualKeyCode,
		nativeVirtualKeyCode: definition.virtualKeyCode,
		...(modifiers ? { modifiers } : {}),
	};
	await bridge.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		...common,
	});
	await bridge.send("Input.dispatchKeyEvent", {
		type: "char",
		...common,
		text: definition.text,
		unmodifiedText: definition.text,
	});
	await bridge.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		...common,
	});
}

async function dispatchTrustedWheel(
	bridge: CdpFrameBridge,
	quad: CdpQuad,
	deltaX: number,
	deltaY: number,
): Promise<void> {
	const point = quadCenter(quad);
	await assertRootPointVisible(bridge, point);
	await bridge.send("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: point.x,
		y: point.y,
	});
	await bridge.send("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x: point.x,
		y: point.y,
		deltaX,
		deltaY,
	});
}

async function targetScrollOffset(
	bridge: CdpFrameBridge,
	target: RemoteTarget,
): Promise<{ left: number; top: number }> {
	const response = await bridge.send<CdpEvaluateResult>(
		"Runtime.callFunctionOn",
		{
			objectId: target.objectId,
			functionDeclaration:
				"function () { return { left: this.scrollLeft, top: this.scrollTop }; }",
			returnByValue: true,
		},
		target.frame.sessionId,
	);
	if (
		response.exceptionDetails ||
		!response.result.value ||
		typeof response.result.value !== "object"
	) {
		throw new Error("The trusted scroll target did not expose a readable scroll offset.");
	}
	const value = response.result.value as { left?: unknown; top?: unknown };
	const left = Number(value.left);
	const top = Number(value.top);
	if (!Number.isFinite(left) || !Number.isFinite(top)) {
		throw new Error("The trusted scroll target returned an invalid scroll offset.");
	}
	return { left, top };
}

async function waitForTrustedScrollEffect(
	bridge: CdpFrameBridge,
	target: RemoteTarget,
	before: { left: number; top: number },
	deltaX: number,
	deltaY: number,
): Promise<void> {
	const deadline = Date.now() + 2_000;
	do {
		bridge.assertHealthy();
		const current = await targetScrollOffset(bridge, target);
		if (
			(deltaX !== 0 && Math.abs(current.left - before.left) >= 0.5) ||
			(deltaY !== 0 && Math.abs(current.top - before.top) >= 0.5)
		) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() <= deadline);
	throw new Error("Trusted CDP wheel input did not move the selected scroll container.");
}

function assertCurrentCredentialTarget(
	window: BrowserWindow,
	credentialUrl: URL,
	client: string,
	requireExplicitClient = false,
): void {
	let currentUrl: URL;
	try {
		currentUrl = new URL(window.webContents.getURL());
	} catch {
		throw new Error("The current SAP Browser URL is invalid.");
	}
	if (currentUrl.protocol !== "https:" || currentUrl.origin !== credentialUrl.origin) {
		throw new Error("Credential URL origin does not match the current SAP Browser.");
	}
	const currentClient = currentUrl.searchParams.get("sap-client");
	if (
		(requireExplicitClient && currentClient !== client) ||
		(currentClient && currentClient !== client)
	) {
		throw new Error("Credential Client does not match the current SAP Browser URL.");
	}
}

async function buildPageAction(
	window: BrowserWindow,
	action: SapWebContentsActionInput,
): Promise<{
	pageAction: SapPageAction;
	secrets: string[];
	waitCondition?: string;
	inputText?: string;
	commitWithEnter?: boolean;
}> {
	switch (action.action) {
		case "state":
			return { pageAction: { kind: "state" }, secrets: [] };
		case "login-from-file": {
			const credentials = await readSapLoginCredentials(action.credentialFilePath);
			assertCurrentCredentialTarget(window, credentials.url, credentials.client);
			return {
				pageAction: {
					kind: "login",
					user: credentials.user,
					password: credentials.password,
				},
				secrets: [credentials.user, credentials.password],
				waitCondition: "SAP login controls are uniquely visible and enabled",
			};
		}
		case "change-password-from-files": {
			const credentials = await readSapLoginCredentials(action.credentialFilePath);
			assertCurrentCredentialTarget(window, credentials.url, credentials.client, true);
			const newPassword = await readSecretText(action.newPasswordFilePath);
			return {
				pageAction: {
					kind: "change-password",
					user: credentials.user,
					currentPassword: credentials.password,
					newPassword,
				},
				secrets: [credentials.user, credentials.password, newPassword],
				waitCondition:
					"exactly three visible sensitive inputs and one visible Change Password control",
			};
		}
		case "find":
		case "click":
			return {
				pageAction: { kind: action.action, selector: action.selector },
				secrets: [],
			};
		case "press":
			return {
				pageAction: { kind: "press", selector: action.selector },
				secrets: [],
			};
		case "scroll":
			return {
				pageAction: { kind: "find", selector: action.selector },
				secrets: [],
			};
		case "type": {
			const secret = Boolean(action.secretFilePath);
			const text = action.secretFilePath
				? await readSecretText(action.secretFilePath)
				: (action.text as string);
			return {
				pageAction: { kind: "find", selector: action.selector },
				secrets: secret ? [text] : [],
				inputText: text,
			};
		}
		case "type-legacy-grid-cell":
			return {
				pageAction: { kind: "find", selector: action.selector },
				secrets: [],
				inputText: action.text,
				commitWithEnter: action.commitWithEnter === true,
			};
		case "wait":
			return {
				pageAction: {
					kind: "wait",
					selector: action.selector,
					timeoutMs: action.timeoutMs ?? 5_000,
				},
				secrets: [],
				waitCondition: "target is uniquely visible and enabled",
			};
	}
}

let actionInProgress = false;

export async function executeSapWebContentsAction(
	window: BrowserWindow,
	rawAction: unknown,
): Promise<SapActionEnvelope> {
	if (actionInProgress) throw new Error("Another SAP WebContents action is already running.");
	if (window.isDestroyed() || window.webContents.isDestroyed()) {
		throw new Error("The current Recordly SAP BrowserWindow is not available.");
	}

	const action = normalizeAction(rawAction);
	const startedAt = new Date().toISOString();
	actionInProgress = true;
	let secrets: string[] = [];
	let releaseBridge: (() => void) | undefined;
	try {
		const prepared = await buildPageAction(window, action);
		secrets = prepared.secrets;
		const lease = await acquireCdpFrameBridge(window.webContents, "sap-web-contents-control");
		releaseBridge = lease.release;
		const bridge = lease.bridge;
		let result: SapPageActionResult;
		let targetFrame: CdpFrameDescriptor | undefined;
		let frameSummaries: SapFrameSummary[] | undefined;

		if (action.action === "state") {
			const state = await collectState(bridge, secrets);
			result = state.result;
			frameSummaries = state.frames;
		} else if (
			action.action === "login-from-file" ||
			action.action === "change-password-from-files"
		) {
			const rootFrame = bridge
				.getReadyFrames()
				.find((frame) => frame.isSessionRoot && frame.sessionId === undefined);
			if (!rootFrame) throw new Error("The top-level SAP credential frame is not available.");
			targetFrame = rootFrame;
			result = validatePageResult(
				await evaluatePageAction(bridge, rootFrame, prepared.pageAction),
				secrets,
			);
		} else if (action.action === "wait") {
			const resolved = await waitForUniqueTarget(
				bridge,
				action.selector,
				action.timeoutMs ?? 5_000,
				secrets,
			);
			targetFrame = resolved.frame;
			const geometry = await geometryForSelector(bridge, resolved.frame, action.selector);
			result = { ...resolved.result, domRect: geometry.rect };
		} else if (action.action === "find") {
			const resolved = await resolveUniqueTarget(bridge, action.selector, secrets);
			targetFrame = resolved.frame;
			const geometry = await geometryForSelector(bridge, resolved.frame, action.selector);
			result = { ...resolved.result, domRect: geometry.rect };
		} else if (action.action === "click") {
			const beforeScroll = await resolveUniqueTarget(bridge, action.selector, secrets);
			const scrollTarget = await resolveRemoteTarget(
				bridge,
				beforeScroll.frame,
				action.selector,
			);
			try {
				await bridge.send(
					"DOM.scrollIntoViewIfNeeded",
					{ objectId: scrollTarget.objectId },
					scrollTarget.frame.sessionId,
				);
			} finally {
				await releaseRemoteTarget(bridge, scrollTarget);
			}

			const resolved = await resolveUniqueTarget(bridge, action.selector, secrets);
			if (
				resolved.frame.frameId !== beforeScroll.frame.frameId ||
				resolved.frame.generation !== beforeScroll.frame.generation
			) {
				throw new Error("The target frame changed while preparing the click.");
			}
			targetFrame = resolved.frame;
			const target = await resolveRemoteTarget(bridge, resolved.frame, action.selector);
			try {
				await assertTargetHit(bridge, target);
				const geometry = await geometryForRemoteTarget(bridge, target, false);
				await dispatchTrustedClick(bridge, geometry.quad);
				result = { ...resolved.result, domRect: geometry.rect };
			} finally {
				await releaseRemoteTarget(bridge, target);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
			try {
				const state = await collectState(bridge, secrets);
				const targetState = state.frames.find(
					(frame) => frame.frameId === resolved.frame.frameId,
				);
				result = {
					...result,
					url: targetState?.url ?? state.result.url,
					title: targetState?.title ?? state.result.title,
					visibleResult: state.result.visibleResult,
				};
			} catch {
				bridge.assertHealthy();
				// A trusted click may replace its frame before the next context is ready.
			}
		} else if (action.action === "press") {
			const resolved = await resolveUniqueTarget(bridge, action.selector, secrets);
			targetFrame = resolved.frame;
			const geometry = await geometryForSelector(bridge, resolved.frame, action.selector);
			result = validatePageResult(
				await evaluatePageAction(bridge, resolved.frame, prepared.pageAction),
				secrets,
			);
			const currentFrame = bridge.getFrame(resolved.frame.frameId);
			if (!currentFrame || currentFrame.generation !== resolved.frame.generation) {
				throw new Error("The target frame changed before the key dispatch.");
			}
			await dispatchTrustedKey(bridge, action.key);
			result = { ...result, domRect: geometry.rect };
			await new Promise((resolve) => setTimeout(resolve, 100));
			try {
				const state = await collectState(bridge, secrets);
				const targetState = state.frames.find(
					(frame) => frame.frameId === resolved.frame.frameId,
				);
				result = {
					...result,
					url: targetState?.url ?? state.result.url,
					title: targetState?.title ?? state.result.title,
					visibleResult: state.result.visibleResult,
				};
			} catch {
				bridge.assertHealthy();
				// A trusted key may navigate before the next context is ready.
			}
		} else if (action.action === "type") {
			if (prepared.inputText === undefined) {
				throw new Error("Trusted text input was not prepared.");
			}
			const beforeScroll = await resolveUniqueTarget(bridge, action.selector, secrets);
			const scrollTarget = await resolveRemoteTarget(
				bridge,
				beforeScroll.frame,
				action.selector,
			);
			try {
				await bridge.send(
					"DOM.scrollIntoViewIfNeeded",
					{ objectId: scrollTarget.objectId },
					scrollTarget.frame.sessionId,
				);
			} finally {
				await releaseRemoteTarget(bridge, scrollTarget);
			}
			const resolved = await resolveUniqueTarget(bridge, action.selector, secrets);
			if (
				resolved.frame.frameId !== beforeScroll.frame.frameId ||
				resolved.frame.generation !== beforeScroll.frame.generation
			) {
				throw new Error("The target frame changed while preparing trusted text input.");
			}
			targetFrame = resolved.frame;
			const target = await resolveRemoteTarget(bridge, resolved.frame, action.selector);
			try {
				await assertTargetHit(bridge, target);
				const geometry = await geometryForRemoteTarget(bridge, target, false);
				await dispatchTrustedClick(bridge, geometry.quad);
				await assertTargetFocused(bridge, target);
				await dispatchTrustedReplaceText(bridge, target, prepared.inputText);
				await assertTargetFocused(bridge, target);
				await assertTargetValue(bridge, target, prepared.inputText);
				result = validatePageResult(
					await evaluatePageAction(bridge, resolved.frame, prepared.pageAction),
					secrets,
				);
				result = { ...result, domRect: geometry.rect };
			} finally {
				await releaseRemoteTarget(bridge, target);
			}
		} else if (action.action === "type-legacy-grid-cell") {
			if (prepared.inputText === undefined) {
				throw new Error("Trusted legacy grid-cell input was not prepared.");
			}
			const beforeScroll = await resolveUniqueTarget(bridge, action.selector, secrets);
			const scrollTarget = await resolveRemoteTarget(
				bridge,
				beforeScroll.frame,
				action.selector,
			);
			try {
				await bridge.send(
					"DOM.scrollIntoViewIfNeeded",
					{ objectId: scrollTarget.objectId },
					scrollTarget.frame.sessionId,
				);
			} finally {
				await releaseRemoteTarget(bridge, scrollTarget);
			}

			const resolved = await resolveUniqueTarget(bridge, action.selector, secrets);
			if (
				resolved.frame.frameId !== beforeScroll.frame.frameId ||
				resolved.frame.generation !== beforeScroll.frame.generation
			) {
				throw new Error("The target frame changed while preparing legacy grid-cell input.");
			}
			targetFrame = resolved.frame;
			const target = await resolveRemoteTarget(bridge, resolved.frame, action.selector);
			try {
				const inspection = await inspectLegacyGridCell(bridge, target);
				assertLegacyGridCellEligible(inspection);
				await assertTargetHit(bridge, target);
				const geometry = await geometryForRemoteTarget(bridge, target, false);
				await dispatchTrustedClick(bridge, geometry.quad);
			} finally {
				await releaseRemoteTarget(bridge, target);
			}

			await new Promise((resolve) => setTimeout(resolve, 25));
			const focusedResolved = await resolveUniqueTarget(bridge, action.selector, secrets);
			if (
				focusedResolved.frame.frameId !== resolved.frame.frameId ||
				focusedResolved.frame.generation !== resolved.frame.generation
			) {
				throw new Error("The legacy grid-cell frame changed after focus.");
			}
			const focusedTarget = await resolveRemoteTarget(
				bridge,
				focusedResolved.frame,
				action.selector,
			);
			try {
				const inspection = await inspectLegacyGridCell(bridge, focusedTarget);
				assertLegacyGridCellEligible(inspection);
				if (!inspection.focused) {
					throw new Error("The legacy grid cell did not retain trusted focus.");
				}
				if (inspection.display.trim()) {
					throw new Error("type-legacy-grid-cell requires an empty visible cell.");
				}
			} finally {
				await releaseRemoteTarget(bridge, focusedTarget);
			}

			await dispatchTrustedLegacyGridCellText(bridge, prepared.inputText);
			if (prepared.commitWithEnter) {
				const enterDefinition = cdpKeyDefinition("Enter");
				if (!enterDefinition.text) {
					throw new Error(
						"The trusted legacy grid-cell commit key has no text metadata.",
					);
				}
				await dispatchTrustedLegacyGridCellCharacter(bridge, {
					...enterDefinition,
					text: enterDefinition.text,
				});
			}

			const verificationDeadline = Date.now() + 2_000;
			let verifiedResult: SapPageActionResult | null = null;
			while (Date.now() <= verificationDeadline) {
				const currentFrame = bridge.getFrame(resolved.frame.frameId);
				if (!currentFrame || currentFrame.generation !== resolved.frame.generation) {
					throw new Error("The legacy grid-cell frame changed before verification.");
				}
				try {
					const finalResolved = await resolveUniqueTarget(
						bridge,
						action.selector,
						secrets,
					);
					if (
						finalResolved.frame.frameId !== resolved.frame.frameId ||
						finalResolved.frame.generation !== resolved.frame.generation
					) {
						throw new Error("The legacy grid-cell frame changed before verification.");
					}
					targetFrame = finalResolved.frame;
					const finalTarget = await resolveRemoteTarget(
						bridge,
						finalResolved.frame,
						action.selector,
					);
					try {
						const inspection = await inspectLegacyGridCell(bridge, finalTarget);
						assertLegacyGridCellEligible(inspection);
						if (legacyGridCellDisplayMatches(inspection.display, prepared.inputText)) {
							const finalGeometry = await geometryForRemoteTarget(
								bridge,
								finalTarget,
								false,
							);
							const pageResult = validatePageResult(
								await evaluatePageAction(
									bridge,
									finalResolved.frame,
									prepared.pageAction,
								),
								secrets,
							);
							verifiedResult = { ...pageResult, domRect: finalGeometry.rect };
						}
					} finally {
						await releaseRemoteTarget(bridge, finalTarget);
					}
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "The legacy grid-cell frame changed before verification."
					) {
						throw error;
					}
				}
				if (verifiedResult) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (!verifiedResult) {
				throw new Error(
					"Trusted legacy grid-cell input did not produce the requested visible code.",
				);
			}
			result = verifiedResult;
		} else if (action.action === "scroll") {
			const resolved = await resolveUniqueTarget(bridge, action.selector, secrets);
			targetFrame = resolved.frame;
			const target = await resolveRemoteTarget(bridge, resolved.frame, action.selector);
			try {
				await bridge.send(
					"DOM.scrollIntoViewIfNeeded",
					{ objectId: target.objectId },
					target.frame.sessionId,
				);
				await assertTargetHit(bridge, target);
				const geometry = await geometryForRemoteTarget(bridge, target, false);
				const before = await targetScrollOffset(bridge, target);
				await dispatchTrustedWheel(
					bridge,
					geometry.quad,
					action.deltaX ?? 0,
					action.deltaY,
				);
				await waitForTrustedScrollEffect(
					bridge,
					target,
					before,
					action.deltaX ?? 0,
					action.deltaY,
				);
				result = validatePageResult(
					await evaluatePageAction(bridge, resolved.frame, prepared.pageAction),
					secrets,
				);
				result = { ...result, domRect: geometry.rect };
			} finally {
				await releaseRemoteTarget(bridge, target);
			}
		} else {
			throw new Error("Unsupported trusted SAP WebContents action.");
		}

		const completedAt = new Date().toISOString();
		return {
			actionId: `sap-action-${randomUUID()}`,
			action: action.action,
			targetName: result.targetName,
			controlType: result.controlType,
			domRect: result.domRect,
			url: result.url,
			title: result.title,
			visibleResult: result.visibleResult,
			actualOutcome: result.visibleResult || `${action.action} completed`,
			...(prepared.waitCondition ? { waitCondition: prepared.waitCondition } : {}),
			startedAt,
			completedAt,
			redacted: result.redacted || secrets.length > 0,
			...(targetFrame
				? {
						frame: {
							frameId: targetFrame.frameId,
							...(targetFrame.parentFrameId
								? { parentFrameId: targetFrame.parentFrameId }
								: {}),
							origin: targetFrame.origin,
							isMainFrame: !targetFrame.parentFrameId,
						},
					}
				: {}),
			...(frameSummaries ? { frames: frameSummaries } : {}),
		};
	} catch (error) {
		throw new Error(
			redactSecrets(error instanceof Error ? error.message : String(error), secrets),
		);
	} finally {
		releaseBridge?.();
		secrets = [];
		actionInProgress = false;
	}
}
