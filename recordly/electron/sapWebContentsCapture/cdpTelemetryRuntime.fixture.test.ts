import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawActionEvent, RawActionTimelineDocument } from "./timeline";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const electronPath = path.resolve(
	currentDirectory,
	"../../node_modules/electron/dist/electron.exe",
);
const runnerPath = path.join(currentDirectory, "cdpTelemetryFixtureRunner.cjs");
const mainSecret = "main-fixture-password-6f1d8c";
const childSecret = "oopif-fixture-token-3a7e92";

type CleanupCheck = {
	frameId: string;
	sessionId?: string;
	origin: string;
	isMainFrame: boolean;
	collectorType: string;
	bindingType: string;
	bindingCallHadException?: boolean;
};

type FixtureOutput = {
	frameCount: number;
	oopifFrameCount: number;
	bootstrapFrameCount: number;
	origins: { main: string; child: string };
	iframeRect: { x: number; y: number; width: number; height: number };
	trustedResults: { main: string; child: string };
	batches: Array<{
		schemaVersion: number;
		sourceClock: string;
		sessionId: string;
		events: RawActionEvent[];
	}>;
	document: RawActionTimelineDocument;
	fatalErrors: string[];
	eventCountBeforeStop: number;
	eventCountAfterStop: number;
	eventCountAfterPostStopActions: number;
	cleanupChecks: CleanupCheck[];
	postNavigationCheck: {
		frameId: string;
		sessionId?: string;
		url: string;
		origin: string;
		collectorType: string;
		bindingType: string;
	};
	bindingCallsAfterStop: number;
};

let temporaryDirectory = "";
let outputPath = "";
let rawOutput = "";
let output: FixtureOutput;

beforeAll(async () => {
	temporaryDirectory = await fs.mkdtemp(
		path.join(os.tmpdir(), "recordly-cdp-telemetry-fixture-"),
	);
	const inputPath = path.join(temporaryDirectory, "input.json");
	outputPath = path.join(temporaryDirectory, "output.json");
	const mainSecretPath = path.join(temporaryDirectory, "main-secret.txt");
	const childSecretPath = path.join(temporaryDirectory, "child-secret.txt");
	await Promise.all([
		fs.writeFile(mainSecretPath, mainSecret, "utf8"),
		fs.writeFile(childSecretPath, childSecret, "utf8"),
	]);
	await fs.writeFile(
		inputPath,
		JSON.stringify({
			outputPath,
			userDataPath: path.join(temporaryDirectory, "user-data"),
			mainSecretPath,
			childSecretPath,
		}),
		"utf8",
	);
	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	const completed = spawnSync(
		electronPath,
		[runnerPath, `--cdp-telemetry-fixture=${inputPath}`],
		{
			cwd: currentDirectory,
			env: environment,
			encoding: "utf8",
			timeout: 75_000,
			windowsHide: true,
		},
	);
	if (completed.status !== 0) {
		let fixtureFailure = "";
		try {
			fixtureFailure = await fs.readFile(outputPath, "utf8");
		} catch {
			// The process output below remains the primary failure evidence.
		}
		throw new Error(
			`CDP telemetry fixture failed (${completed.status}): ${
				fixtureFailure || completed.stderr || completed.stdout
			}`,
		);
	}
	rawOutput = await fs.readFile(outputPath, "utf8");
	output = JSON.parse(rawOutput);
}, 85_000);

afterAll(async () => {
	if (temporaryDirectory) {
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
	}
});

function eventsForOrigin(origin: string): RawActionEvent[] {
	return output.document.timeline.filter((event) => event.frame?.origin === origin);
}

describe("real Electron cross-frame CDP telemetry", () => {
	it("collects schema v2 events from the main document and a real cross-site OOPIF", () => {
		expect(output.frameCount).toBeGreaterThanOrEqual(3);
		expect(output.oopifFrameCount).toBeGreaterThanOrEqual(1);
		expect(output.bootstrapFrameCount).toBeGreaterThanOrEqual(1);
		expect(output.fatalErrors).toEqual([]);
		expect(output.batches.length).toBeGreaterThan(0);
		expect(
			output.batches.every(
				(batch) =>
					batch.schemaVersion === 2 &&
					batch.sourceClock === "capture-session-monotonic" &&
					batch.sessionId === "cdp-telemetry-fixture-session" &&
					batch.events.length === 1,
			),
		).toBe(true);
		expect(output.document).toMatchObject({
			schemaVersion: 2,
			source: "Recordly built-in SAP Browser CDP isolated-world collector",
			sourceClock: "capture-session-monotonic",
			sessionId: "cdp-telemetry-fixture-session",
			eventCount: output.document.timeline.length,
		});

		const mainEvents = eventsForOrigin(output.origins.main);
		const oopifEvents = eventsForOrigin(output.origins.child);
		for (const events of [mainEvents, oopifEvents]) {
			const types = new Set(events.map((event) => event.type));
			for (const type of ["click", "input", "keydown", "keyup"] as const) {
				expect(types.has(type)).toBe(true);
			}
		}
		expect(mainEvents.some((event) => event.frame?.isMainFrame)).toBe(true);
		expect(
			oopifEvents.some(
				(event) => event.frame?.isMainFrame === false && Boolean(event.frame.parentFrameId),
			),
		).toBe(true);
		expect(output.trustedResults.main).toContain(
			"click:true input:true key:true passwordKey:true",
		);
		expect(output.trustedResults.child).toContain(
			"click:true input:true key:true passwordKey:true",
		);
	});

	it("stamps trusted document identity and maps OOPIF geometry into root coordinates", () => {
		for (const event of output.document.timeline) {
			expect(event.documentId).toBeTruthy();
			expect(event.url).toBe(event.frame?.origin);
			expect([output.origins.main, output.origins.child]).toContain(event.frame?.origin);
			expect(event.frame?.frameId).toBeTruthy();
		}

		const childTargets = eventsForOrigin(output.origins.child)
			.map((event) => event.target)
			.filter((target): target is NonNullable<RawActionEvent["target"]> => Boolean(target));
		expect(childTargets.length).toBeGreaterThan(0);
		for (const target of childTargets) {
			expect(target.rect.x).toBeGreaterThanOrEqual(output.iframeRect.x - 2);
			expect(target.rect.y).toBeGreaterThanOrEqual(output.iframeRect.y - 2);
			expect(target.rect.x + target.rect.width).toBeLessThanOrEqual(
				output.iframeRect.x + output.iframeRect.width + 2,
			);
			expect(target.rect.y + target.rect.height).toBeLessThanOrEqual(
				output.iframeRect.y + output.iframeRect.height + 2,
			);
			expect(target.point.x).toBeGreaterThanOrEqual(target.rect.x);
			expect(target.point.y).toBeGreaterThanOrEqual(target.rect.y);
			expect(target.normalizedPoint.x).toBeGreaterThanOrEqual(0);
			expect(target.normalizedPoint.x).toBeLessThanOrEqual(1);
			expect(target.normalizedPoint.y).toBeGreaterThanOrEqual(0);
			expect(target.normalizedPoint.y).toBeLessThanOrEqual(1);
		}
	});

	it("redacts credential fields and never writes either secret to fixture output", () => {
		expect(rawOutput).not.toContain(mainSecret);
		expect(rawOutput).not.toContain(childSecret);
		const credentialEvents = output.document.timeline.filter(
			(event) => event.target?.controlType === "input:password",
		);
		expect(credentialEvents.length).toBeGreaterThan(0);
		expect(credentialEvents.some((event) => event.frame?.origin === output.origins.main)).toBe(
			true,
		);
		expect(credentialEvents.some((event) => event.frame?.origin === output.origins.child)).toBe(
			true,
		);
		for (const event of credentialEvents) {
			expect(event.type).not.toBe("input");
			expect(event.type).not.toBe("change");
			expect(event.target).toMatchObject({
				name: "credential field",
				text: "credential field",
			});
			expect(event.target).not.toHaveProperty("targetId");
			expect(event.target).not.toHaveProperty("selector");
			if (event.key) {
				expect(event.key.key).toBe("redacted");
				expect(event.key.code).toBe("redacted");
			}
		}
	});

	it("removes collectors and bindings, including from a newly navigated OOPIF document", () => {
		expect(output.cleanupChecks.length).toBeGreaterThanOrEqual(2);
		expect(output.cleanupChecks.some((check) => check.isMainFrame)).toBe(true);
		expect(output.cleanupChecks.some((check) => Boolean(check.sessionId))).toBe(true);
		for (const check of output.cleanupChecks) {
			expect(check.collectorType).toBe("undefined");
			expect(["undefined", "function"]).toContain(check.bindingType);
		}
		// Chromium can leave an inert binding function in the old context. The
		// cleanup contract is that it emits no binding call and is absent from a
		// newly navigated document below.
		expect(output.bindingCallsAfterStop).toBe(0);
		expect(output.postNavigationCheck).toMatchObject({
			url: `${output.origins.child}/after-stop`,
			origin: output.origins.child,
			collectorType: "undefined",
			bindingType: "undefined",
		});
		expect(output.eventCountBeforeStop).toBeGreaterThan(0);
		expect(output.eventCountAfterStop).toBe(output.eventCountBeforeStop);
		expect(output.eventCountAfterPostStopActions).toBe(output.eventCountBeforeStop);
	});
});
