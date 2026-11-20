import { describe, expect, it } from "vitest";
import {
	createMonotonicSessionClock,
	cursorSamplesForTimeline,
	RawActionTimeline,
	type RawActionEvent,
} from "./timeline";

function event(
	eventId: string,
	sourceTimeMs: number,
	type: RawActionEvent["type"],
): RawActionEvent {
	return {
		eventId,
		type,
		sourceTimeMs,
		url: "https://sap.example.test/sap",
		viewport: {
			width: 1440,
			height: 900,
			devicePixelRatio: 1,
			scrollX: 0,
			scrollY: 0,
		},
		target: {
			targetId: "tab-items",
			selector: "[data-sap-ui=tab-items]",
			controlType: "tab",
			name: "Items",
			text: "Items",
			cursorType: "pointer",
			rect: { x: 100, y: 200, width: 120, height: 40 },
			point: { x: 160, y: 220 },
			normalizedPoint: { x: 160 / 1440, y: 220 / 900 },
		},
	};
}

describe("Recordly SAP browser raw action timeline", () => {
	it("uses the capture session monotonic clock without wall-clock fields", () => {
		let nowNs = 10_000_000_000n;
		const clock = createMonotonicSessionClock(() => {
			const value = nowNs;
			nowNs += 2_000_000n;
			return value;
		});
		const timeline = new RawActionTimeline("session-1", 42, clock);
		timeline.addBrowserBatch({
			schemaVersion: 2,
			sourceClock: "capture-session-monotonic",
			sessionId: "session-1",
			events: [event("click-1", 30, "click")],
		});

		const document = timeline.toDocument();
		expect(document.sourceClock).toBe("capture-session-monotonic");
		expect(document.timeline[0]).toMatchObject({ eventId: "click-1", sourceTimeMs: 30 });
		expect(document.timeline[0]).not.toHaveProperty("wallTimeMs");
		expect(timeline.toCursorSidecar().samples.length).toBeGreaterThanOrEqual(2);
	});

	it("sorts browser and main-process events by session source time", () => {
		const timeline = new RawActionTimeline("session-2", 7, { nowMs: () => 20 });
		timeline.addBrowserBatch({
			schemaVersion: 2,
			sourceClock: "capture-session-monotonic",
			sessionId: "session-2",
			events: [event("click-2", 80, "click"), event("key-1", 40, "keydown")],
		});
		timeline.addNavigation("did-navigate", "https://sap.example.test/next");

		expect(timeline.snapshot().map((item) => item.eventId)).toEqual([
			"session-2:main-navigation:0",
			"key-1",
			"click-2",
		]);
	});

	it("rejects mixed duplicate batches while accepting an all-duplicate retry", () => {
		const timeline = new RawActionTimeline("session-3", 8, { nowMs: () => 0 });
		const payload = {
			schemaVersion: 2,
			sourceClock: "capture-session-monotonic",
			sessionId: "session-3",
			events: [event("click-3", 1, "click")],
		};
		expect(timeline.addBrowserBatch(payload)).toEqual({ accepted: 1, duplicate: false });
		expect(timeline.addBrowserBatch(payload)).toEqual({ accepted: 0, duplicate: true });
		expect(() =>
			timeline.addBrowserBatch({
				schemaVersion: 2,
				sourceClock: "capture-session-monotonic",
				sessionId: "session-3",
				events: [event("click-3", 1, "click"), event("click-4", 2, "click")],
			}),
		).toThrow("mixes accepted and new");
	});

	it("creates cursor movement and click samples from tab-switch events", () => {
		const samples = cursorSamplesForTimeline([event("tab-1", 1_500, "tab-switch")]);
		expect(samples.map((sample) => sample.interactionType)).toEqual([
			"move",
			"move",
			"click",
			"mouseup",
		]);
		expect(samples.every((sample) => sample.cx >= 0 && sample.cx <= 1)).toBe(true);
	});

	it("retains trusted frame identity and rejects a mismatched frame origin", () => {
		const timeline = new RawActionTimeline("session-4", 9, { nowMs: () => 0 });
		const childEvent = {
			...event("frame-click", 15, "click"),
			documentId: "child-frame:3",
			url: "https://child.example.test/path?secret=removed",
			frame: {
				frameId: "child-frame",
				parentFrameId: "main-frame",
				origin: "https://child.example.test/private",
				isMainFrame: false,
			},
		};
		timeline.addBrowserBatch({
			schemaVersion: 2,
			sourceClock: "capture-session-monotonic",
			sessionId: "session-4",
			events: [childEvent],
		});

		expect(timeline.snapshot()[0]).toMatchObject({
			documentId: "child-frame:3",
			url: "https://child.example.test",
			frame: {
				frameId: "child-frame",
				parentFrameId: "main-frame",
				origin: "https://child.example.test",
				isMainFrame: false,
			},
		});
		expect(() =>
			timeline.addBrowserBatch({
				schemaVersion: 2,
				sourceClock: "capture-session-monotonic",
				sessionId: "session-4",
				events: [
					{
						...childEvent,
						eventId: "spoofed-origin",
						frame: { ...childEvent.frame, origin: "https://other.example.test" },
					},
				],
			}),
		).toThrow("must match the trusted frame origin");
	});
});
