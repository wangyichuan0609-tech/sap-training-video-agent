import type { WebContents } from "electron";

export type CdpSessionId = string | undefined;
export type CdpPoint = { x: number; y: number };
export type CdpRect = { x: number; y: number; width: number; height: number };
export type CdpQuad = [number, number, number, number, number, number, number, number];

export interface CdpProtocolEvent {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

export interface CdpFrameDescriptor {
	frameId: string;
	parentFrameId?: string;
	sessionId?: string;
	targetId?: string;
	url: string;
	origin: string;
	defaultContextId?: number;
	generation: number;
	isSessionRoot: boolean;
}

export interface CdpEvaluateOptions {
	awaitPromise?: boolean;
	returnByValue?: boolean;
	userGesture?: boolean;
}

export interface CdpEvaluateResult {
	result: {
		type: string;
		subtype?: string;
		className?: string;
		value?: unknown;
		objectId?: string;
		description?: string;
	};
	exceptionDetails?: {
		text?: string;
		exception?: { description?: string; value?: unknown };
	};
}

interface MutableFrameDescriptor extends CdpFrameDescriptor {
	loaderId?: string;
}

interface TargetSession {
	sessionId: string;
	targetId: string;
	parentSessionId?: string;
	rootFrameId?: string;
}

interface ContextRecord {
	contextId: number;
	frameId: string;
	sessionId?: string;
	isDefault: boolean;
}

interface FrameTreeNode {
	frame: {
		id: string;
		parentId?: string;
		loaderId?: string;
		url?: string;
		securityOrigin?: string;
	};
	childFrames?: FrameTreeNode[];
}

interface BridgeEntry {
	bridge: CdpFrameBridge;
	owners: Map<symbol, string>;
	idleTimer?: ReturnType<typeof setTimeout>;
}

export interface CdpFrameBridgeLease {
	bridge: CdpFrameBridge;
	release(): void;
}

const bridgeEntries = new WeakMap<WebContents, BridgeEntry>();
const ROOT_SESSION_KEY = "<root>";
const IDLE_DETACH_MS = 2_000;

function sessionKey(sessionId: CdpSessionId): string {
	return sessionId ?? ROOT_SESSION_KEY;
}

function contextKey(sessionId: CdpSessionId, contextId: number): string {
	return `${sessionKey(sessionId)}:${contextId}`;
}

function originForUrl(value: string): string {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
	} catch {
		return "";
	}
}

function isAllowedDocumentUrl(value: string): boolean {
	return originForUrl(value).length > 0;
}

function numberValue(value: unknown, label: string): number {
	const result = Number(value);
	if (!Number.isFinite(result)) throw new Error(`${label} is not finite.`);
	return result;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asQuad(value: unknown, label: string): CdpQuad {
	if (!Array.isArray(value) || value.length !== 8) {
		throw new Error(`${label} did not return one DOM quad.`);
	}
	return value.map((item) => numberValue(item, label)) as CdpQuad;
}

function quadArea(quad: CdpQuad): number {
	let area = 0;
	for (let index = 0; index < 4; index += 1) {
		const next = (index + 1) % 4;
		area += quad[index * 2] * quad[next * 2 + 1] - quad[next * 2] * quad[index * 2 + 1];
	}
	return Math.abs(area) / 2;
}

function assertAxisAligned(quad: CdpQuad): void {
	const tolerance = 0.75;
	if (
		Math.abs(quad[1] - quad[3]) > tolerance ||
		Math.abs(quad[2] - quad[4]) > tolerance ||
		Math.abs(quad[5] - quad[7]) > tolerance ||
		Math.abs(quad[6] - quad[0]) > tolerance
	) {
		throw new Error("A transformed iframe cannot be mapped safely.");
	}
	if (quadArea(quad) < 1) throw new Error("The iframe content quad has no clickable area.");
}

function quadBounds(quad: CdpQuad): CdpRect {
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	const left = Math.min(...xs);
	const top = Math.min(...ys);
	const right = Math.max(...xs);
	const bottom = Math.max(...ys);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export class CdpFrameBridge {
	private readonly frames = new Map<string, MutableFrameDescriptor>();
	private readonly sessions = new Map<string, TargetSession>();
	private readonly contexts = new Map<string, ContextRecord>();
	private readonly listeners = new Set<(event: CdpProtocolEvent) => void>();
	private readonly pendingTargetSetups = new Set<Promise<void>>();
	private startPromise: Promise<void> | null = null;
	private ownsAttachment = false;
	private intentionalDetach = false;
	private failure: Error | null = null;

	constructor(private readonly webContents: WebContents) {}

	private readonly onDebuggerMessage = (
		_event: unknown,
		method: string,
		params: unknown,
		sessionId?: string,
	): void => {
		const normalizedParams = asRecord(params);
		try {
			this.updateRegistry(method, normalizedParams, sessionId);
		} catch (error) {
			this.fail(error);
		}
		const protocolEvent: CdpProtocolEvent = {
			method,
			params: normalizedParams,
			...(sessionId ? { sessionId } : {}),
		};
		this.broadcast(protocolEvent);
	};

	private readonly onDebuggerDetach = (_event: unknown, reason: string): void => {
		this.ownsAttachment = false;
		this.clearRegistry();
		if (!this.intentionalDetach) {
			const error = new Error(`The shared SAP CDP debugger detached unexpectedly: ${reason}`);
			this.fail(error);
			this.broadcast({ method: "Inspector.detached", params: { reason } });
		}
	};

	async start(): Promise<void> {
		if (this.failure) throw this.failure;
		if (this.ownsAttachment) return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.startInternal().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	private async startInternal(): Promise<void> {
		if (this.webContents.isDestroyed()) {
			throw new Error("The SAP WebContents was destroyed before CDP could attach.");
		}
		if (this.webContents.debugger.isAttached()) {
			throw new Error(
				"The SAP WebContents debugger is attached outside the shared CDP bridge.",
			);
		}

		this.intentionalDetach = false;
		this.webContents.debugger.attach("1.3");
		this.ownsAttachment = true;
		this.webContents.debugger.on("message", this.onDebuggerMessage);
		this.webContents.debugger.on("detach", this.onDebuggerDetach);
		try {
			await this.enableSession(undefined);
			await this.refreshFrameTree(undefined);
			await this.waitForFramesReady();
		} catch (error) {
			this.detachOwnedDebugger();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.startPromise) {
			try {
				await this.startPromise;
			} catch {
				// startInternal already detached after a setup failure.
			}
		}
		this.detachOwnedDebugger();
		this.failure = null;
	}

	private detachOwnedDebugger(): void {
		this.intentionalDetach = true;
		this.webContents.debugger.removeListener("message", this.onDebuggerMessage);
		this.webContents.debugger.removeListener("detach", this.onDebuggerDetach);
		if (
			this.ownsAttachment &&
			!this.webContents.isDestroyed() &&
			this.webContents.debugger.isAttached()
		) {
			this.webContents.debugger.detach();
		}
		this.ownsAttachment = false;
		this.clearRegistry();
		this.intentionalDetach = false;
	}

	assertHealthy(): void {
		if (this.failure) throw this.failure;
		if (
			!this.ownsAttachment ||
			this.webContents.isDestroyed() ||
			!this.webContents.debugger.isAttached()
		) {
			throw new Error("The shared SAP CDP bridge is not attached.");
		}
	}

	async waitForFramesReady(timeoutMs = 1_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const pending = [...this.pendingTargetSetups];
			if (pending.length > 0) await Promise.all(pending);
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (this.pendingTargetSetups.size === 0) {
				this.assertHealthy();
				return;
			}
		}
		throw new Error("Timed out while attaching existing child frame CDP sessions.");
	}

	async send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<T> {
		this.assertHealthy();
		return this.webContents.debugger.sendCommand(method, params, sessionId) as Promise<T>;
	}

	subscribe(listener: (event: CdpProtocolEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getFrames(): CdpFrameDescriptor[] {
		return [...this.frames.values()].map(({ loaderId: _loaderId, ...frame }) => ({ ...frame }));
	}

	getFrame(frameId: string): CdpFrameDescriptor | undefined {
		const frame = this.frames.get(frameId);
		if (!frame) return undefined;
		const { loaderId: _loaderId, ...result } = frame;
		return { ...result };
	}

	getFrameForExecutionContext(
		sessionId: CdpSessionId,
		contextId: number,
	): CdpFrameDescriptor | undefined {
		const context = this.contexts.get(contextKey(sessionId, contextId));
		return context ? this.getFrame(context.frameId) : undefined;
	}

	getReadyFrames(): CdpFrameDescriptor[] {
		return this.getFrames().filter(
			(frame) => frame.defaultContextId !== undefined && isAllowedDocumentUrl(frame.url),
		);
	}

	async isFrameCandidateAvailable(frameId: string): Promise<boolean> {
		const frame = this.requireActionableFrame(frameId);
		let currentSessionId = frame.sessionId;
		const visited = new Set<string>();
		while (currentSessionId) {
			if (visited.has(currentSessionId)) {
				throw new Error("CDP target session ancestry is cyclic.");
			}
			visited.add(currentSessionId);
			const target = this.sessions.get(currentSessionId);
			if (!target?.rootFrameId) {
				throw new Error("The OOPIF session has no current root frame.");
			}
			if (!(await this.frameOwnerAvailable(target.rootFrameId, target.parentSessionId))) {
				return false;
			}
			currentSessionId = target.parentSessionId;
		}
		return true;
	}

	async evaluateInFrame(
		frameId: string,
		expression: string,
		options: CdpEvaluateOptions = {},
	): Promise<CdpEvaluateResult> {
		const frame = this.requireActionableFrame(frameId);
		const response = await this.send<CdpEvaluateResult>(
			"Runtime.evaluate",
			{
				expression,
				contextId: frame.defaultContextId,
				awaitPromise: options.awaitPromise ?? true,
				returnByValue: options.returnByValue ?? true,
				userGesture: options.userGesture ?? false,
			},
			frame.sessionId,
		);
		if (response.exceptionDetails) {
			throw new Error(
				response.exceptionDetails.exception?.description ||
					String(response.exceptionDetails.exception?.value ?? "") ||
					response.exceptionDetails.text ||
					"Frame evaluation failed.",
			);
		}
		return response;
	}

	async mapFramePointToRoot(frameId: string, point: CdpPoint): Promise<CdpPoint> {
		const frame = this.requireActionableFrame(frameId);
		let sessionPoint = point;
		if (!frame.isSessionRoot) {
			const viewport = await this.frameViewport(frame);
			const geometry = await this.frameOwnerGeometry(frame.frameId, frame.sessionId);
			const xRatio = point.x / viewport.width;
			const yRatio = point.y / viewport.height;
			this.assertRatios(xRatio, yRatio);
			await this.assertFrameOwnerHit(geometry.backendNodeId, frame.sessionId, xRatio, yRatio);
			sessionPoint = this.mapPointIntoQuad(geometry.content, xRatio, yRatio);
		}
		return this.mapSessionPointToRoot(frame.sessionId, sessionPoint);
	}

	async mapFrameRectToRoot(frameId: string, rect: CdpRect): Promise<CdpRect> {
		const points = await Promise.all([
			this.mapFramePointToRoot(frameId, { x: rect.x, y: rect.y }),
			this.mapFramePointToRoot(frameId, { x: rect.x + rect.width, y: rect.y }),
			this.mapFramePointToRoot(frameId, { x: rect.x + rect.width, y: rect.y + rect.height }),
			this.mapFramePointToRoot(frameId, { x: rect.x, y: rect.y + rect.height }),
		]);
		const quad: CdpQuad = [
			points[0].x,
			points[0].y,
			points[1].x,
			points[1].y,
			points[2].x,
			points[2].y,
			points[3].x,
			points[3].y,
		];
		return quadBounds(quad);
	}

	async mapSessionQuadToRoot(sessionId: CdpSessionId, quad: CdpQuad): Promise<CdpQuad> {
		let mapped = [...quad] as CdpQuad;
		let currentSessionId = sessionId;
		const visited = new Set<string>();
		while (currentSessionId) {
			if (visited.has(currentSessionId))
				throw new Error("CDP target session ancestry is cyclic.");
			visited.add(currentSessionId);
			const target = this.sessions.get(currentSessionId);
			if (!target?.rootFrameId) {
				throw new Error("The OOPIF session has no current root frame.");
			}
			const childFrame = this.requireActionableFrame(target.rootFrameId);
			const viewport = await this.frameViewport(childFrame);
			const geometry = await this.frameOwnerGeometry(
				target.rootFrameId,
				target.parentSessionId,
			);
			const centerX = (mapped[0] + mapped[2] + mapped[4] + mapped[6]) / 4;
			const centerY = (mapped[1] + mapped[3] + mapped[5] + mapped[7]) / 4;
			const centerXRatio = centerX / viewport.width;
			const centerYRatio = centerY / viewport.height;
			this.assertRatios(centerXRatio, centerYRatio);
			await this.assertFrameOwnerHit(
				geometry.backendNodeId,
				target.parentSessionId,
				centerXRatio,
				centerYRatio,
			);
			const next = [] as number[];
			for (let index = 0; index < 8; index += 2) {
				const xRatio = mapped[index] / viewport.width;
				const yRatio = mapped[index + 1] / viewport.height;
				this.assertRatios(xRatio, yRatio);
				const point = this.mapPointIntoQuad(geometry.content, xRatio, yRatio);
				next.push(point.x, point.y);
			}
			mapped = next as CdpQuad;
			currentSessionId = target.parentSessionId;
		}
		return mapped;
	}

	private async mapSessionPointToRoot(
		sessionId: CdpSessionId,
		point: CdpPoint,
	): Promise<CdpPoint> {
		const quad = await this.mapSessionQuadToRoot(sessionId, [
			point.x,
			point.y,
			point.x,
			point.y,
			point.x,
			point.y,
			point.x,
			point.y,
		]);
		return { x: quad[0], y: quad[1] };
	}

	private requireActionableFrame(frameId: string): MutableFrameDescriptor {
		this.assertHealthy();
		const frame = this.frames.get(frameId);
		if (!frame) throw new Error("The target frame detached before the action completed.");
		if (!isAllowedDocumentUrl(frame.url)) {
			throw new Error("The target frame is not an allowed HTTP(S) document.");
		}
		if (frame.defaultContextId === undefined) {
			throw new Error("The target frame has no current default execution context.");
		}
		return frame;
	}

	private async enableSession(sessionId: CdpSessionId): Promise<void> {
		await this.sendUnchecked("Page.enable", {}, sessionId);
		await this.sendUnchecked("Runtime.enable", {}, sessionId);
		await this.sendUnchecked("DOM.enable", {}, sessionId);
		await this.sendUnchecked(
			"Target.setAutoAttach",
			{ autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
			sessionId,
		);
	}

	private async refreshFrameTree(sessionId: CdpSessionId): Promise<void> {
		const response = await this.sendUnchecked<{ frameTree?: FrameTreeNode }>(
			"Page.getFrameTree",
			{},
			sessionId,
		);
		if (response.frameTree) this.ingestFrameTree(response.frameTree, sessionId, true);
	}

	private async sendUnchecked<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown>,
		sessionId?: string,
	): Promise<T> {
		if (!this.ownsAttachment || this.webContents.isDestroyed()) {
			throw new Error("The shared SAP CDP bridge detached during setup.");
		}
		return this.webContents.debugger.sendCommand(method, params, sessionId) as Promise<T>;
	}

	private updateRegistry(
		method: string,
		params: Record<string, unknown>,
		sessionId: CdpSessionId,
	): void {
		if (method === "Target.attachedToTarget") {
			const setup = this.handleAttachedTarget(params, sessionId);
			let tracked: Promise<void>;
			tracked = setup
				.catch((error) => this.fail(error))
				.finally(() => this.pendingTargetSetups.delete(tracked));
			this.pendingTargetSetups.add(tracked);
			return;
		}
		if (method === "Target.detachedFromTarget") {
			const detachedSessionId = String(params.sessionId ?? "");
			if (detachedSessionId) this.removeSession(detachedSessionId);
			return;
		}
		if (method === "Page.frameAttached") {
			const frameId = String(params.frameId ?? "");
			const parentFrameId = String(params.parentFrameId ?? "");
			if (frameId) this.upsertFrame(frameId, sessionId, { parentFrameId });
			return;
		}
		if (method === "Page.frameNavigated") {
			const frame = asRecord(params.frame);
			const frameId = String(frame.id ?? "");
			if (frameId) {
				this.upsertFrame(frameId, sessionId, {
					parentFrameId: typeof frame.parentId === "string" ? frame.parentId : undefined,
					loaderId: typeof frame.loaderId === "string" ? frame.loaderId : undefined,
					url: typeof frame.url === "string" ? frame.url : "",
					origin:
						typeof frame.securityOrigin === "string"
							? frame.securityOrigin
							: originForUrl(String(frame.url ?? "")),
				});
			}
			return;
		}
		if (method === "Page.frameDetached") {
			const frameId = String(params.frameId ?? "");
			if (frameId) this.removeFrame(frameId);
			return;
		}
		if (method === "Runtime.executionContextCreated") {
			this.upsertExecutionContext(asRecord(params.context), sessionId);
			return;
		}
		if (method === "Runtime.executionContextDestroyed") {
			const executionContextId = Number(params.executionContextId);
			if (Number.isInteger(executionContextId)) {
				this.removeContext(sessionId, executionContextId);
			}
			return;
		}
		if (method === "Runtime.executionContextsCleared") {
			this.clearContextsForSession(sessionId);
		}
	}

	private async handleAttachedTarget(
		params: Record<string, unknown>,
		parentSessionId: CdpSessionId,
	): Promise<void> {
		const attachedSessionId = String(params.sessionId ?? "");
		const targetInfo = asRecord(params.targetInfo);
		const targetId = String(targetInfo.targetId ?? "");
		const type = String(targetInfo.type ?? "");
		if (!attachedSessionId || !targetId) {
			throw new Error("CDP attached a target without a session or target identity.");
		}
		if (type !== "iframe") {
			await this.sendUnchecked("Target.detachFromTarget", { sessionId: attachedSessionId });
			return;
		}
		this.sessions.set(attachedSessionId, {
			sessionId: attachedSessionId,
			targetId,
			...(parentSessionId ? { parentSessionId } : {}),
		});
		await this.enableSession(attachedSessionId);
		await this.refreshFrameTree(attachedSessionId);
	}

	private ingestFrameTree(
		node: FrameTreeNode,
		sessionId: CdpSessionId,
		isSessionRoot: boolean,
	): void {
		const frame = node.frame;
		this.upsertFrame(frame.id, sessionId, {
			parentFrameId: frame.parentId,
			loaderId: frame.loaderId,
			url: frame.url ?? "",
			origin: frame.securityOrigin ?? originForUrl(frame.url ?? ""),
			isSessionRoot,
		});
		if (sessionId && isSessionRoot) {
			const target = this.sessions.get(sessionId);
			if (target) target.rootFrameId = frame.id;
		}
		for (const child of node.childFrames ?? []) this.ingestFrameTree(child, sessionId, false);
	}

	private upsertFrame(
		frameId: string,
		sessionId: CdpSessionId,
		patch: Partial<MutableFrameDescriptor>,
	): void {
		const previous = this.frames.get(frameId);
		const target = sessionId ? this.sessions.get(sessionId) : undefined;
		const url = patch.url ?? previous?.url ?? "";
		const loaderChanged =
			previous !== undefined &&
			previous.loaderId !== undefined &&
			patch.loaderId !== undefined &&
			patch.loaderId !== previous.loaderId;
		const urlChanged =
			previous !== undefined &&
			previous.url.length > 0 &&
			patch.url !== undefined &&
			patch.url !== previous.url;
		const next: MutableFrameDescriptor = {
			frameId,
			...((patch.parentFrameId ?? previous?.parentFrameId)
				? { parentFrameId: patch.parentFrameId ?? previous?.parentFrameId }
				: {}),
			...(sessionId ? { sessionId } : {}),
			...(target?.targetId ? { targetId: target.targetId } : {}),
			url,
			origin: patch.origin ?? previous?.origin ?? originForUrl(url),
			...(previous?.defaultContextId !== undefined
				? { defaultContextId: previous.defaultContextId }
				: {}),
			generation: (previous?.generation ?? 0) + (loaderChanged || urlChanged ? 1 : 0),
			isSessionRoot: patch.isSessionRoot ?? previous?.isSessionRoot ?? false,
			loaderId: patch.loaderId ?? previous?.loaderId,
		};
		if (loaderChanged || urlChanged) delete next.defaultContextId;
		this.frames.set(frameId, next);
		if (sessionId && next.isSessionRoot && target) target.rootFrameId = frameId;
	}

	private upsertExecutionContext(
		context: Record<string, unknown>,
		sessionId: CdpSessionId,
	): void {
		const contextId = Number(context.id);
		const auxiliary = asRecord(context.auxData);
		const frameId = typeof auxiliary.frameId === "string" ? auxiliary.frameId : "";
		if (!Number.isInteger(contextId) || !frameId) return;
		const isDefault = auxiliary.isDefault === true;
		this.contexts.set(contextKey(sessionId, contextId), {
			contextId,
			frameId,
			...(sessionId ? { sessionId } : {}),
			isDefault,
		});
		this.upsertFrame(frameId, sessionId, {});
		if (isDefault) {
			const frame = this.frames.get(frameId);
			if (frame) frame.defaultContextId = contextId;
		}
	}

	private removeContext(sessionId: CdpSessionId, contextId: number): void {
		const key = contextKey(sessionId, contextId);
		const context = this.contexts.get(key);
		this.contexts.delete(key);
		if (context?.isDefault) {
			const frame = this.frames.get(context.frameId);
			if (frame?.defaultContextId === contextId) delete frame.defaultContextId;
		}
	}

	private clearContextsForSession(sessionId: CdpSessionId): void {
		for (const context of [...this.contexts.values()]) {
			if (context.sessionId === sessionId) this.removeContext(sessionId, context.contextId);
		}
	}

	private removeFrame(frameId: string): void {
		const descendants = [...this.frames.values()]
			.filter((frame) => frame.parentFrameId === frameId)
			.map((frame) => frame.frameId);
		for (const childId of descendants) this.removeFrame(childId);
		for (const context of [...this.contexts.values()]) {
			if (context.frameId === frameId)
				this.removeContext(context.sessionId, context.contextId);
		}
		this.frames.delete(frameId);
	}

	private removeSession(sessionId: string): void {
		for (const frame of [...this.frames.values()]) {
			if (frame.sessionId === sessionId) this.removeFrame(frame.frameId);
		}
		this.sessions.delete(sessionId);
		this.clearContextsForSession(sessionId);
	}

	private clearRegistry(): void {
		this.frames.clear();
		this.sessions.clear();
		this.contexts.clear();
		this.pendingTargetSetups.clear();
	}

	private fail(error: unknown): void {
		if (!this.failure) {
			this.failure = error instanceof Error ? error : new Error(String(error));
		}
	}

	private broadcast(event: CdpProtocolEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				this.fail(error);
			}
		}
	}

	private async frameViewport(
		frame: Pick<CdpFrameDescriptor, "frameId">,
	): Promise<{ width: number; height: number }> {
		const response = await this.evaluateInFrame(
			frame.frameId,
			"({ width: window.innerWidth, height: window.innerHeight })",
			{ returnByValue: true },
		);
		const value = asRecord(response.result.value);
		const width = numberValue(value.width, "Frame viewport width");
		const height = numberValue(value.height, "Frame viewport height");
		if (width <= 0 || height <= 0) throw new Error("The frame viewport has no visible area.");
		return { width, height };
	}

	private async frameOwnerGeometry(
		frameId: string,
		parentSessionId: CdpSessionId,
	): Promise<{ backendNodeId: number; content: CdpQuad }> {
		const owner = await this.send<{ backendNodeId?: number }>(
			"DOM.getFrameOwner",
			{ frameId },
			parentSessionId,
		);
		const backendNodeId = Number(owner.backendNodeId);
		if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
			throw new Error("The child frame owner could not be resolved.");
		}
		const box = await this.send<{ model?: { content?: unknown } }>(
			"DOM.getBoxModel",
			{ backendNodeId },
			parentSessionId,
		);
		const content = asQuad(box.model?.content, "Frame owner box model");
		assertAxisAligned(content);
		return { backendNodeId, content };
	}

	private async assertFrameOwnerHit(
		backendNodeId: number,
		parentSessionId: CdpSessionId,
		xRatio: number,
		yRatio: number,
	): Promise<void> {
		const resolved = await this.send<{ object?: { objectId?: string } }>(
			"DOM.resolveNode",
			{ backendNodeId },
			parentSessionId,
		);
		const objectId = resolved.object?.objectId;
		if (!objectId) throw new Error("The child frame owner has no live DOM object.");
		try {
			const response = await this.send<CdpEvaluateResult>(
				"Runtime.callFunctionOn",
				{
					objectId,
					functionDeclaration: `function (xRatio, yRatio) {
						const rect = this.getBoundingClientRect();
						const document = this.ownerDocument;
						const hit = document.elementFromPoint(
							rect.left + rect.width * xRatio,
							rect.top + rect.height * yRatio
						);
						return Boolean(hit && (hit === this || this.contains(hit)));
					}`,
					arguments: [{ value: xRatio }, { value: yRatio }],
					returnByValue: true,
				},
				parentSessionId,
			);
			if (response.exceptionDetails || response.result.value !== true) {
				throw new Error("The child frame is obscured at the target point.");
			}
		} finally {
			await this.send("Runtime.releaseObject", { objectId }, parentSessionId).catch(
				() => undefined,
			);
		}
	}

	private async frameOwnerAvailable(
		frameId: string,
		parentSessionId: CdpSessionId,
	): Promise<boolean> {
		const owner = await this.send<{ backendNodeId?: number }>(
			"DOM.getFrameOwner",
			{ frameId },
			parentSessionId,
		);
		const backendNodeId = Number(owner.backendNodeId);
		if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
			throw new Error("The child frame owner could not be resolved.");
		}
		const resolved = await this.send<{ object?: { objectId?: string } }>(
			"DOM.resolveNode",
			{ backendNodeId },
			parentSessionId,
		);
		const objectId = resolved.object?.objectId;
		if (!objectId) throw new Error("The child frame owner has no live DOM object.");
		try {
			const response = await this.send<CdpEvaluateResult>(
				"Runtime.callFunctionOn",
				{
					objectId,
					functionDeclaration: `function () {
						const document = this.ownerDocument;
						const view = document && document.defaultView;
						if (!this.isConnected || !view) return false;
						const rect = this.getBoundingClientRect();
						const style = view.getComputedStyle(this);
						if (
							this.hidden ||
							this.closest("[inert]") ||
							style.display === "none" ||
							style.visibility === "hidden" ||
							style.visibility === "collapse" ||
							style.contentVisibility === "hidden" ||
							style.pointerEvents === "none" ||
							rect.width <= 0 ||
							rect.height <= 0
						) return false;
						for (let element = this; element; element = element.parentElement) {
							const ancestorStyle = view.getComputedStyle(element);
							const opacity = Number.parseFloat(ancestorStyle.opacity || "1");
							if (Number.isFinite(opacity) && opacity <= 0) return false;
						}
						return (
							rect.right > 0 &&
							rect.bottom > 0 &&
							rect.left < view.innerWidth &&
							rect.top < view.innerHeight
						);
					}`,
					returnByValue: true,
				},
				parentSessionId,
			);
			if (response.exceptionDetails) {
				throw new Error("The child frame owner availability check failed.");
			}
			return response.result.value === true;
		} finally {
			await this.send("Runtime.releaseObject", { objectId }, parentSessionId).catch(
				() => undefined,
			);
		}
	}

	private assertRatios(xRatio: number, yRatio: number): void {
		if (
			!Number.isFinite(xRatio) ||
			!Number.isFinite(yRatio) ||
			xRatio < 0 ||
			xRatio > 1 ||
			yRatio < 0 ||
			yRatio > 1
		) {
			throw new Error("The target point is outside the child frame viewport.");
		}
	}

	private mapPointIntoQuad(content: CdpQuad, xRatio: number, yRatio: number): CdpPoint {
		return {
			x: content[0] + (content[2] - content[0]) * xRatio,
			y: content[1] + (content[7] - content[1]) * yRatio,
		};
	}
}

export async function acquireCdpFrameBridge(
	webContents: WebContents,
	owner: string,
): Promise<CdpFrameBridgeLease> {
	if (!owner.trim()) throw new Error("A CDP bridge owner name is required.");
	let entry = bridgeEntries.get(webContents);
	if (!entry) {
		entry = {
			bridge: new CdpFrameBridge(webContents),
			owners: new Map(),
		};
		bridgeEntries.set(webContents, entry);
	}
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}
	const token = Symbol(owner);
	entry.owners.set(token, owner);
	try {
		await entry.bridge.start();
	} catch (error) {
		entry.owners.delete(token);
		throw error;
	}
	let released = false;
	return {
		bridge: entry.bridge,
		release() {
			if (released) return;
			released = true;
			entry?.owners.delete(token);
			if (entry && entry.owners.size === 0 && !entry.idleTimer) {
				entry.idleTimer = setTimeout(() => {
					entry!.idleTimer = undefined;
					if (entry!.owners.size === 0) void entry!.bridge.stop();
				}, IDLE_DETACH_MS);
				entry.idleTimer.unref?.();
			}
		},
	};
}

export function selectLargestUsableQuad(quads: unknown): CdpQuad {
	if (!Array.isArray(quads)) throw new Error("The target did not expose DOM content quads.");
	const candidates = quads
		.map((quad, index) => asQuad(quad, `Target DOM quad ${index + 1}`))
		.filter((quad) => quadArea(quad) >= 1)
		.sort((left, right) => quadArea(right) - quadArea(left));
	if (candidates.length === 0) throw new Error("The target has no visible clickable DOM quad.");
	return candidates[0];
}

export function boundsForQuad(quad: CdpQuad): CdpRect {
	return quadBounds(quad);
}
