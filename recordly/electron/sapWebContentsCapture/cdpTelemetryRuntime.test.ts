import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpTelemetryRuntime } from "./cdpTelemetryRuntime";
import { RawActionTimeline } from "./timeline";

type TestFrame = {
	frameId: string;
	parentFrameId?: string;
	sessionId?: string;
	url: string;
	origin: string;
	defaultContextId: number;
	generation: number;
	isSessionRoot: boolean;
};

type TestEvent = {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
};

class FakeBridge {
	readonly commands: Array<{
		method: string;
		params: Record<string, unknown>;
		sessionId?: string;
	}> = [];
	readonly frames: TestFrame[];
	readonly unavailableFrameIds = new Set<string>();
	onAddScript?: (sessionId: string | undefined) => void | Promise<void>;
	private readonly listeners = new Set<(event: TestEvent) => void>();
	private readonly contextFrames = new Map<string, string>();

	constructor(frames: TestFrame[]) {
		this.frames = frames;
	}

	assertHealthy(): void {}
	async waitForFramesReady(): Promise<void> {}

	subscribe(listener: (event: TestEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: TestEvent): void {
		if (event.method === "Runtime.executionContextCreated") {
			const context = event.params.context;
			if (context && typeof context === "object" && !Array.isArray(context)) {
				const contextId = (context as Record<string, unknown>).id;
				const auxData = (context as Record<string, unknown>).auxData;
				const frameId =
					auxData && typeof auxData === "object" && !Array.isArray(auxData)
						? (auxData as Record<string, unknown>).frameId
						: undefined;
				if (typeof contextId === "number" && typeof frameId === "string") {
					this.contextFrames.set(`${event.sessionId ?? "root"}:${contextId}`, frameId);
				}
			}
		}
		if (event.method === "Runtime.executionContextDestroyed") {
			const contextId = event.params.executionContextId;
			if (typeof contextId === "number") {
				this.contextFrames.delete(`${event.sessionId ?? "root"}:${contextId}`);
			}
		}
		if (event.method === "Runtime.executionContextsCleared") {
			const prefix = `${event.sessionId ?? "root"}:`;
			for (const key of this.contextFrames.keys()) {
				if (key.startsWith(prefix)) this.contextFrames.delete(key);
			}
		}
		if (event.method === "Target.detachedFromTarget") {
			const detachedSessionId = event.params.sessionId;
			if (typeof detachedSessionId === "string") {
				const prefix = `${detachedSessionId}:`;
				for (const key of this.contextFrames.keys()) {
					if (key.startsWith(prefix)) this.contextFrames.delete(key);
				}
			}
		}
		for (const listener of this.listeners) listener(event);
	}

	getFrames(): TestFrame[] {
		return this.frames.map((frame) => ({ ...frame }));
	}

	getFrame(frameId: string): TestFrame | undefined {
		return this.frames.find((frame) => frame.frameId === frameId);
	}

	getFrameForExecutionContext(
		sessionId: string | undefined,
		contextId: number,
	): TestFrame | undefined {
		const frameId = this.contextFrames.get(`${sessionId ?? "root"}:${contextId}`);
		return frameId ? this.getFrame(frameId) : undefined;
	}

	async send<T>(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<T> {
		this.commands.push({ method, params, ...(sessionId ? { sessionId } : {}) });
		if (method === "Page.addScriptToEvaluateOnNewDocument") {
			await this.onAddScript?.(sessionId);
			return { identifier: `script-${sessionId ?? "root"}` } as T;
		}
		if (method === "Page.createIsolatedWorld") {
			const frameId = String(params.frameId);
			const contextId = this.getFrame(frameId)?.defaultContextId ?? 999;
			this.contextFrames.set(`${sessionId ?? "root"}:${contextId}`, frameId);
			return { executionContextId: contextId } as T;
		}
		if (method === "Page.getLayoutMetrics") {
			return {
				cssVisualViewport: {
					clientWidth: 1000,
					clientHeight: 800,
					pageX: 0,
					pageY: 0,
				},
			} as T;
		}
		if (
			method === "Runtime.evaluate" &&
			typeof params.expression === "string" &&
			params.expression.includes(".stop?.()")
		) {
			return { result: { value: { ok: true } } } as T;
		}
		return {} as T;
	}

	async mapFramePointToRoot(
		frameId: string,
		point: { x: number; y: number },
	): Promise<{ x: number; y: number }> {
		return frameId === "child" ? { x: point.x + 300, y: point.y + 200 } : { ...point };
	}

	async mapFrameRectToRoot(
		frameId: string,
		rect: { x: number; y: number; width: number; height: number },
	): Promise<{ x: number; y: number; width: number; height: number }> {
		return frameId === "child" ? { ...rect, x: rect.x + 300, y: rect.y + 200 } : { ...rect };
	}

	isFrameCandidateAvailable(frameId: string): boolean {
		return !this.unavailableFrameIds.has(frameId);
	}
}

function clickPayload(sequence: number): string {
	return JSON.stringify({
		version: 1,
		kind: "browser-event",
		sequence,
		frameId: "spoofed-frame",
		documentId: "spoofed-document",
		origin: "https://attacker.example.test",
		control: { command: "save" },
		event: {
			type: "click",
			viewport: {
				width: 400,
				height: 300,
				devicePixelRatio: 1.25,
				scrollX: 0,
				scrollY: 0,
			},
			target: {
				targetId: "save",
				selector: "#save",
				controlType: "button",
				name: "Save",
				text: "Save",
				cursorType: "pointer",
				rect: { x: 10, y: 20, width: 100, height: 30 },
				point: { x: 15, y: 25 },
			},
		},
	});
}

const TELEMETRY_WORLD = "recordly.sap.telemetry.v1";
const TELEMETRY_BINDING = "__recordlySapTelemetryV1";

function navigationPayload(sequence: number, navigationType = "document"): string {
	return JSON.stringify({
		version: 1,
		kind: "browser-event",
		sequence,
		event: {
			type: "navigation",
			viewport: {
				width: 1000,
				height: 800,
				devicePixelRatio: 1,
				scrollX: 0,
				scrollY: 0,
			},
			navigationType,
		},
	});
}

function bindingEvent(
	contextId: number,
	sequence: number,
	options: { sessionId?: string; navigationType?: string } = {},
): TestEvent {
	return {
		method: "Runtime.bindingCalled",
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		params: {
			name: TELEMETRY_BINDING,
			executionContextId: contextId,
			payload: navigationPayload(sequence, options.navigationType),
		},
	};
}

function contextCreatedEvent(
	contextId: number,
	frameId: string,
	options: {
		name?: string;
		sessionId?: string;
		uniqueId?: string;
		isDefault?: boolean;
	} = {},
): TestEvent {
	return {
		method: "Runtime.executionContextCreated",
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		params: {
			context: {
				id: contextId,
				name: options.name ?? TELEMETRY_WORLD,
				uniqueId: options.uniqueId ?? `document-${contextId}`,
				auxData: { frameId, isDefault: options.isDefault === true },
			},
		},
	};
}

function trustedMainFrame(): TestFrame {
	return {
		frameId: "main",
		url: "https://shell.example.test/home",
		origin: "https://shell.example.test",
		defaultContextId: 10,
		generation: 1,
		isSessionRoot: true,
	};
}

function createRuntimeHarness(bridge: FakeBridge) {
	let nowMs = 100;
	const onBatch = vi.fn();
	const fatal = vi.fn();
	const release = vi.fn();
	const runtime = new CdpTelemetryRuntime(
		{
			webContents: {} as never,
			sessionId: "capture-session",
			clock: {
				nowMs: () => {
					nowMs += 5;
					return nowMs;
				},
			},
			onBatch: (payload) => {
				onBatch(payload);
			},
			onFatal: (error) => fatal(error),
		},
		{
			acquireBridge: async () => ({ bridge, release }) as never,
		} as never,
	);
	return { fatal, onBatch, release, runtime };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("cross-frame CDP telemetry runtime", () => {
	it("ignores a QAS-style about:blank bootstrap context that emits no telemetry", async () => {
		const bridge = new FakeBridge([
			trustedMainFrame(),
			{
				frameId: "qas-bootstrap",
				parentFrameId: "main",
				url: "about:blank",
				origin: "",
				defaultContextId: 77,
				generation: 1,
				isSessionRoot: false,
			},
		]);
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== undefined) return;
			bridge.emit(contextCreatedEvent(77, "qas-bootstrap"));
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		await runtime.start();
		await runtime.stop();

		expect(fatal).not.toHaveBeenCalled();
		expect(onBatch).not.toHaveBeenCalled();
		expect(
			bridge.commands.filter(
				(command) =>
					command.method === "Page.createIsolatedWorld" &&
					command.params.frameId === "qas-bootstrap",
			),
		).toEqual([]);
	});

	it("recovers an empty bootstrap context only after its frame becomes trusted HTTPS", async () => {
		const transientFrame: TestFrame = {
			frameId: "qas-transient",
			parentFrameId: "main",
			url: "",
			origin: "",
			defaultContextId: 77,
			generation: 1,
			isSessionRoot: false,
		};
		const bridge = new FakeBridge([trustedMainFrame(), transientFrame]);
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== undefined) return;
			bridge.emit(contextCreatedEvent(77, "qas-transient"));
			bridge.emit(bindingEvent(77, 0));
			transientFrame.url = "https://qas.example.test/sap/bc/gui/sap/its/webgui";
			transientFrame.origin = "https://qas.example.test";
			transientFrame.generation = 2;
			bridge.emit({
				method: "Page.frameNavigated",
				params: {
					frame: {
						id: transientFrame.frameId,
						parentId: transientFrame.parentFrameId,
						url: transientFrame.url,
						securityOrigin: transientFrame.origin,
					},
				},
			});
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		await runtime.start();
		await vi.waitFor(() => expect(onBatch).toHaveBeenCalledOnce());
		await runtime.stop();

		expect(fatal).not.toHaveBeenCalled();
		expect(onBatch.mock.calls[0][0]).toMatchObject({
			events: [
				expect.objectContaining({
					url: "https://qas.example.test",
					frame: expect.objectContaining({
						frameId: "qas-transient",
						origin: "https://qas.example.test",
					}),
				}),
			],
		});
	});

	it("fails closed if an about:blank bootstrap context emits a binding", async () => {
		vi.useFakeTimers();
		const bridge = new FakeBridge([
			trustedMainFrame(),
			{
				frameId: "qas-bootstrap",
				parentFrameId: "main",
				url: "about:blank",
				origin: "https://shell.example.test",
				defaultContextId: 77,
				generation: 1,
				isSessionRoot: false,
			},
		]);
		let bindingWasQuarantined!: () => void;
		const quarantined = new Promise<void>((resolve) => {
			bindingWasQuarantined = resolve;
		});
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== undefined) return;
			bridge.emit(contextCreatedEvent(77, "qas-bootstrap"));
			bridge.emit(bindingEvent(77, 0));
			bindingWasQuarantined();
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		const startOutcome = runtime.start().then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		await quarantined;
		await vi.advanceTimersByTimeAsync(10_000);
		const startError = await startOutcome;

		expect(fatal).toHaveBeenCalledOnce();
		expect(startError).toMatchObject({
			message:
				"CDP telemetry binding quarantine timed out before its execution context was trusted.",
		});
		expect(onBatch).not.toHaveBeenCalled();
	});

	it("quarantines a runImmediately binding until its isolated context is announced", async () => {
		const bridge = new FakeBridge([trustedMainFrame()]);
		let contextWasAbsentAtBinding = false;
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== undefined) return;
			bridge.emit(bindingEvent(77, 0));
			contextWasAbsentAtBinding =
				bridge.getFrameForExecutionContext(undefined, 77) === undefined;
			bridge.emit(
				contextCreatedEvent(77, "main", {
					uniqueId: "document-run-immediately",
				}),
			);
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		await runtime.start();
		await vi.waitFor(() => expect(onBatch).toHaveBeenCalledOnce());
		await runtime.stop();

		expect(contextWasAbsentAtBinding).toBe(true);
		expect(fatal).not.toHaveBeenCalled();
		const batch = onBatch.mock.calls[0][0] as {
			events: Array<{
				documentId?: string;
				frame?: { frameId?: string };
				navigationType?: string;
			}>;
		};
		expect(batch.events).toEqual([
			expect.objectContaining({
				documentId: "document-run-immediately",
				frame: expect.objectContaining({ frameId: "main" }),
				navigationType: "document",
			}),
		]);
	});

	it("drains quarantined bindings once in source sequence order", async () => {
		const bridge = new FakeBridge([trustedMainFrame()]);
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== undefined) return;
			bridge.emit(bindingEvent(77, 0, { navigationType: "document" }));
			bridge.emit(bindingEvent(77, 1, { navigationType: "hashchange" }));
			bridge.emit(contextCreatedEvent(77, "main"));
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		await runtime.start();
		await vi.waitFor(() => expect(onBatch).toHaveBeenCalledTimes(2));
		await runtime.stop();

		expect(fatal).not.toHaveBeenCalled();
		expect(
			onBatch.mock.calls.map(
				([batch]) =>
					(batch as { events: Array<{ eventId: string; navigationType?: string }> })
						.events[0],
			),
		).toEqual([
			expect.objectContaining({
				eventId: "capture-session:cdp:0",
				navigationType: "document",
			}),
			expect.objectContaining({
				eventId: "capture-session:cdp:1",
				navigationType: "hashchange",
			}),
		]);
	});

	it("fails closed when a quarantined binding starts out of sequence", async () => {
		const bridge = new FakeBridge([trustedMainFrame()]);
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== undefined) return;
			bridge.emit(bindingEvent(77, 1));
			bridge.emit(contextCreatedEvent(77, "main"));
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		await runtime.start().catch(() => undefined);
		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());

		expect(onBatch).not.toHaveBeenCalled();
		expect(fatal.mock.calls[0][0]).toMatchObject({
			message: expect.stringMatching(/sequence.*missing|duplicated|out of order/i),
		});
		await runtime.dispose();
	});

	it("does not let a default-world context unlock a quarantined binding", async () => {
		const bridge = new FakeBridge([trustedMainFrame()]);
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== undefined) return;
			bridge.emit(bindingEvent(77, 0));
			bridge.emit(
				contextCreatedEvent(77, "main", {
					name: "",
					isDefault: true,
				}),
			);
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		await runtime.start().catch(() => undefined);
		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());

		expect(onBatch).not.toHaveBeenCalled();
		expect(fatal.mock.calls[0][0]).toMatchObject({
			message: expect.stringMatching(/untrusted execution context world/i),
		});
		await runtime.dispose();
	});

	it.each([
		[
			"execution contexts are cleared",
			{ method: "Runtime.executionContextsCleared", params: {} } satisfies TestEvent,
		],
		[
			"the pending execution context is destroyed",
			{
				method: "Runtime.executionContextDestroyed",
				params: { executionContextId: 77 },
			} satisfies TestEvent,
		],
	])("fails closed when %s with a binding quarantined", async (_label, lifecycleEvent) => {
		const bridge = new FakeBridge([trustedMainFrame()]);
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== undefined) return;
			bridge.emit(bindingEvent(77, 0));
			bridge.emit(lifecycleEvent);
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		await runtime.start().catch(() => undefined);
		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());

		expect(onBatch).not.toHaveBeenCalled();
		expect(fatal.mock.calls[0][0]).toMatchObject({
			message: expect.stringMatching(/quarantined binding/i),
		});
		await runtime.dispose();
	});

	it("fails closed when a target detaches with a binding quarantined", async () => {
		const bridge = new FakeBridge([
			trustedMainFrame(),
			{
				frameId: "child",
				parentFrameId: "main",
				sessionId: "oopif-session",
				url: "https://app.example.test/order",
				origin: "https://app.example.test",
				defaultContextId: 20,
				generation: 1,
				isSessionRoot: true,
			},
		]);
		bridge.onAddScript = (sessionId) => {
			if (sessionId !== "oopif-session") return;
			bridge.emit(bindingEvent(77, 0, { sessionId }));
			bridge.emit({
				method: "Target.detachedFromTarget",
				params: { sessionId },
			});
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		await runtime.start().catch(() => undefined);
		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());

		expect(onBatch).not.toHaveBeenCalled();
		expect(fatal.mock.calls[0][0]).toMatchObject({
			message: expect.stringMatching(/quarantined binding/i),
		});
		await runtime.dispose();
	});

	it("fails closed when a quarantined binding times out", async () => {
		vi.useFakeTimers();
		const bridge = new FakeBridge([trustedMainFrame()]);
		let signalBindingQuarantined!: () => void;
		const bindingQuarantined = new Promise<void>((resolve) => {
			signalBindingQuarantined = resolve;
		});
		bridge.onAddScript = (sessionId) => {
			if (sessionId === undefined) {
				bridge.emit(bindingEvent(77, 0));
				signalBindingQuarantined();
			}
		};
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);

		const startOutcome = runtime.start().then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		await bindingQuarantined;
		await vi.advanceTimersByTimeAsync(10_000);
		const startError = await startOutcome;

		expect(fatal).toHaveBeenCalledOnce();
		expect(fatal.mock.calls[0][0]).toMatchObject({
			message:
				"CDP telemetry binding quarantine timed out before its execution context was trusted.",
		});
		expect(startError).toMatchObject({
			message:
				"CDP telemetry binding quarantine timed out before its execution context was trusted.",
		});
		expect(onBatch).not.toHaveBeenCalled();
	});

	it("rejects an invalid frame origin before releasing a quarantined binding", async () => {
		const bridge = new FakeBridge([
			trustedMainFrame(),
			{
				frameId: "invalid-child",
				parentFrameId: "main",
				url: "Invalid URL",
				origin: "Invalid URL",
				defaultContextId: 20,
				generation: 1,
				isSessionRoot: false,
			},
		]);
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);
		await runtime.start();

		bridge.emit(bindingEvent(77, 0));
		bridge.emit(contextCreatedEvent(77, "invalid-child"));
		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());

		expect(onBatch).not.toHaveBeenCalled();
		expect(fatal.mock.calls[0][0]).toMatchObject({
			message:
				"CDP telemetry frame invalid-child has an invalid or untrusted HTTP(S) origin.",
		});
		await expect(runtime.stop()).rejects.toThrow(/invalid or untrusted HTTP\(S\) origin/i);
	});

	it.each([
		["data", "data:text/html,<button>unsafe</button>", ""],
		[
			"blob",
			"blob:https://app.example.test/3a31fc6c-d22f-4ca7-ae06-47dfb7dd53b0",
			"https://app.example.test",
		],
	])("rejects a %s isolated context even when it claims an HTTP security origin", async (_scheme, url, origin) => {
		const frameId = "special-scheme-child";
		const bridge = new FakeBridge([
			trustedMainFrame(),
			{
				frameId,
				parentFrameId: "main",
				url,
				origin,
				defaultContextId: 77,
				generation: 1,
				isSessionRoot: false,
			},
		]);
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);
		await runtime.start();

		bridge.emit(contextCreatedEvent(77, frameId));
		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());

		expect(onBatch).not.toHaveBeenCalled();
		expect(fatal.mock.calls[0][0]).toMatchObject({
			message: `CDP telemetry frame ${frameId} has an invalid or untrusted HTTP(S) origin.`,
		});
		await expect(runtime.stop()).rejects.toThrow(/invalid or untrusted HTTP\(S\) origin/i);
	});

	it("stamps trusted frame identity and maps child geometry into root capture coordinates", async () => {
		const bridge = new FakeBridge([
			{
				frameId: "main",
				url: "https://shell.example.test/home",
				origin: "https://shell.example.test",
				defaultContextId: 10,
				generation: 2,
				isSessionRoot: true,
			},
			{
				frameId: "child",
				parentFrameId: "main",
				url: "https://app.example.test/order?secret=removed",
				origin: "https://app.example.test",
				defaultContextId: 20,
				generation: 5,
				isSessionRoot: false,
			},
		]);
		const release = vi.fn();
		let nowMs = 100;
		const timeline = new RawActionTimeline("capture-session", 41, {
			nowMs: () => {
				nowMs += 5;
				return nowMs;
			},
		});
		const fatal = vi.fn();
		const runtime = new CdpTelemetryRuntime(
			{
				webContents: {} as never,
				sessionId: "capture-session",
				clock: {
					nowMs: () => {
						nowMs += 5;
						return nowMs;
					},
				},
				onBatch: (payload) => {
					timeline.addBrowserBatch(payload);
				},
				onFatal: fatal,
			},
			{
				acquireBridge: async () => ({ bridge, release }) as never,
			} as never,
		);
		await runtime.start();
		bridge.emit({
			method: "Runtime.bindingCalled",
			params: {
				name: "__recordlySapTelemetryV1",
				executionContextId: 20,
				payload: clickPayload(0),
			},
		});
		await runtime.stop();

		const events = timeline.snapshot();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			eventId: "capture-session:cdp:0",
			documentId: "child:5",
			url: "https://app.example.test",
			frame: {
				frameId: "child",
				parentFrameId: "main",
				origin: "https://app.example.test",
				isMainFrame: false,
			},
			viewport: { width: 1000, height: 800, devicePixelRatio: 1.25 },
			target: {
				rect: { x: 310, y: 220, width: 100, height: 30 },
				point: { x: 315, y: 225 },
				normalizedPoint: { x: 0.315, y: 0.28125 },
			},
		});
		expect(events[0]).not.toHaveProperty("control");
		expect(events[0].frame?.frameId).not.toBe("spoofed-frame");
		expect(fatal).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledOnce();
		expect(
			bridge.commands.filter(
				(command) =>
					command.method === "Runtime.evaluate" &&
					String(command.params.expression).startsWith("globalThis[") &&
					String(command.params.expression).includes(".stop?.()"),
			),
		).toHaveLength(2);
	});

	it("drops telemetry from a definitely unavailable child frame without failing capture", async () => {
		const bridge = new FakeBridge([
			trustedMainFrame(),
			{
				frameId: "child",
				parentFrameId: "main",
				url: "https://app.example.test/stale",
				origin: "https://app.example.test",
				defaultContextId: 20,
				generation: 1,
				isSessionRoot: false,
			},
		]);
		bridge.unavailableFrameIds.add("child");
		const { fatal, onBatch, runtime } = createRuntimeHarness(bridge);
		await runtime.start();
		bridge.emit({
			method: "Runtime.bindingCalled",
			params: {
				name: "__recordlySapTelemetryV1",
				executionContextId: 20,
				payload: clickPayload(0),
			},
		});
		await runtime.stop();

		expect(onBatch).not.toHaveBeenCalled();
		expect(fatal).not.toHaveBeenCalled();
	});

	it("fails closed for a control envelope sent through the telemetry binding", async () => {
		const bridge = new FakeBridge([
			{
				frameId: "main",
				url: "https://shell.example.test/home",
				origin: "https://shell.example.test",
				defaultContextId: 10,
				generation: 1,
				isSessionRoot: true,
			},
		]);
		const fatal = vi.fn();
		const runtime = new CdpTelemetryRuntime(
			{
				webContents: {} as never,
				sessionId: "capture-session",
				clock: { nowMs: () => 10 },
				onBatch: () => undefined,
				onFatal: fatal,
			},
			{
				acquireBridge: async () => ({ bridge, release: () => undefined }) as never,
			} as never,
		);
		await runtime.start();
		bridge.emit({
			method: "Runtime.bindingCalled",
			params: {
				name: "__recordlySapTelemetryV1",
				executionContextId: 10,
				payload: JSON.stringify({ version: 1, kind: "control", command: "click" }),
			},
		});
		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
		await expect(runtime.stop()).rejects.toThrow("non-telemetry envelope");
	});

	it("arms a dynamically attached OOPIF again after its document context reloads", async () => {
		const bridge = new FakeBridge([
			{
				frameId: "main",
				url: "https://shell.example.test/home",
				origin: "https://shell.example.test",
				defaultContextId: 10,
				generation: 1,
				isSessionRoot: true,
			},
		]);
		const timeline = new RawActionTimeline("capture-session", 41, { nowMs: () => 10 });
		let nowMs = 20;
		const runtime = new CdpTelemetryRuntime(
			{
				webContents: {} as never,
				sessionId: "capture-session",
				clock: {
					nowMs: () => {
						nowMs += 5;
						return nowMs;
					},
				},
				onBatch: (payload) => {
					timeline.addBrowserBatch(payload);
				},
				onFatal: (error) => {
					throw error;
				},
			},
			{
				acquireBridge: async () => ({ bridge, release: () => undefined }) as never,
			} as never,
		);
		await runtime.start();
		bridge.frames.push({
			frameId: "child",
			parentFrameId: "main",
			sessionId: "oopif-session",
			url: "https://app.example.test/order",
			origin: "https://app.example.test",
			defaultContextId: 20,
			generation: 5,
			isSessionRoot: true,
		});
		bridge.emit({
			method: "Target.attachedToTarget",
			params: {
				sessionId: "oopif-session",
				targetInfo: { type: "iframe", targetId: "child-target" },
			},
		});
		await vi.waitFor(() =>
			expect(
				bridge.commands.some(
					(command) =>
						command.method === "Runtime.evaluate" &&
						command.sessionId === "oopif-session" &&
						command.params.contextId === 20,
				),
			).toBe(true),
		);
		bridge.emit({
			method: "Runtime.bindingCalled",
			sessionId: "oopif-session",
			params: {
				name: "__recordlySapTelemetryV1",
				executionContextId: 20,
				payload: clickPayload(0),
			},
		});

		const child = bridge.frames.find((frame) => frame.frameId === "child");
		if (!child) throw new Error("missing test child frame");
		bridge.emit({
			method: "Runtime.executionContextsCleared",
			sessionId: "oopif-session",
			params: {},
		});
		child.defaultContextId = 21;
		child.generation = 6;
		bridge.emit({
			method: "Page.frameNavigated",
			sessionId: "oopif-session",
			params: { frame: { id: "child", url: child.url } },
		});
		await vi.waitFor(() =>
			expect(
				bridge.commands.filter(
					(command) =>
						command.method === "Page.createIsolatedWorld" &&
						command.sessionId === "oopif-session" &&
						command.params.frameId === "child",
				),
			).toHaveLength(2),
		);
		bridge.emit({
			method: "Runtime.bindingCalled",
			sessionId: "oopif-session",
			params: {
				name: "__recordlySapTelemetryV1",
				executionContextId: 21,
				payload: clickPayload(0),
			},
		});
		await runtime.stop();

		expect(timeline.snapshot().map((event) => event.documentId)).toEqual([
			"child:5",
			"child:6",
		]);
	});

	it("fails the active capture immediately when the shared debugger detaches", async () => {
		const bridge = new FakeBridge([
			{
				frameId: "main",
				url: "https://shell.example.test/home",
				origin: "https://shell.example.test",
				defaultContextId: 10,
				generation: 1,
				isSessionRoot: true,
			},
		]);
		const fatal = vi.fn();
		const runtime = new CdpTelemetryRuntime(
			{
				webContents: {} as never,
				sessionId: "capture-session",
				clock: { nowMs: () => 10 },
				onBatch: () => undefined,
				onFatal: fatal,
			},
			{
				acquireBridge: async () => ({ bridge, release: () => undefined }) as never,
			} as never,
		);
		await runtime.start();
		bridge.emit({
			method: "Inspector.detached",
			params: { reason: "target_closed" },
		});

		expect(fatal).toHaveBeenCalledOnce();
		expect(fatal.mock.calls[0][0]).toMatchObject({
			message: expect.stringContaining("target_closed"),
		});
		await runtime.dispose();
	});
});
