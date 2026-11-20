import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCaptureStartContext, type CaptureStartContext } from "../../../scripts/capture-start-run.mjs";
import type { SapFrameSummary } from "../sapWebContentsControl/controller";
import { capturePageIdentity } from "./startPage";

const environment: CaptureStartContext = { system: "QAS", client: "460", origin: "https://qas.example.invalid" };
const homeUrl = environment.origin + "/sap/bc/ui2/flp?sap-client=460#Shell-home";
const home: SapFrameSummary = {
	frameId: "root", mainFrame: true, title: "Home", visibleResult: "", url: environment.origin, captureReady: true,
	controls: [{ id: "sf", targetName: "Open Search", tagName: "button", controlType: "button" }],
};
const recoveryPage = { title: "Purchase Order", visibleText: "Item 4711" };

describe("live Recordly capture source", () => {
	it("requires visible launchpad controls, the Home route and the agreed client", () => {
		const check = (url: string, frame = home) => capturePageIdentity(environment, url, [frame]);
		expect(check(homeUrl)).not.toEqual(check(homeUrl, { ...home, frameId: "replacement" }));
		expect(() => check(homeUrl.replace("qas.", "other."))).toThrow(/origin/);
		expect(() => check(homeUrl.replace("460", "000"))).toThrow(/client/);
		expect(() => check(homeUrl, { ...home, sapClient: "000" })).toThrow(/client/);
		expect(() => check(homeUrl.replace("#Shell-home", "#PurchaseOrder-display"))).toThrow(/Home/);
		expect(() => check(homeUrl, { ...home, controls: [] })).toThrow(/Home/);
		expect(() => check(homeUrl, { ...home, title: "Log On" })).toThrow(/Home/);
		expect(() => check(homeUrl, { ...home, captureReady: false })).toThrow(/authentication/);
		expect(() => check(homeUrl.replace("?sap-client=460", ""), { ...home, sapClient: "460" })).not.toThrow();
	});
	it("matches the recovery title and exact label in the same verified frame and rejects a challenge anywhere", () => {
		const child = { ...home, mainFrame: false, frameId: "child", title: recoveryPage.title,
			controls: [{ id: "item", tagName: "button", controlType: "button", targetName: recoveryPage.visibleText }] };
		const check = (...frames: SapFrameSummary[]) => capturePageIdentity({ ...environment, recoveryPage },
			homeUrl.replace("#Shell-home", "#PurchaseOrder-display"), frames);
		expect(() => check(home, child)).not.toThrow();
		expect(() => check(home, { ...child, sapClient: "000" })).toThrow(/client/);
		expect(() => check(home, { ...child, title: "Other" })).toThrow(/recovery/);
		expect(() => check(home, { ...child, controls: home.controls })).toThrow(/recovery/);
		expect(() => check(home, { ...child, url: "https://other.invalid" })).toThrow(/recovery/);
		expect(() => check(home, child, { ...child, frameId: "login", captureReady: false })).toThrow(/authentication/);
	});
});

describe("capture manifest", () => {
	let directory: string;
	let output: string;
	const operation = { planVersion: 2, plan: [{ id: "open", sourceSlide: 1, action: "Open", expectedResult: "Visible", status: "pending" }] };
	const write = async (run: object) => {
		await writeFile(path.join(directory, "run.json"), JSON.stringify(run));
		return readCaptureStartContext(output);
	};
	beforeEach(async () => {
		directory = await mkdtemp(path.join(os.tmpdir(), "recordly-start-fixture-"));
		await mkdir(path.join(directory, "capture"));
		output = path.join(directory, "capture", "segment.webm");
	});
	afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
	it("only starts new work with a structured plan and verified DEV/QAS connection", async () => {
		await expect(write({ operation, environment })).resolves.toEqual(environment);
		await expect(write({ operation: { plan: ["Open"] }, environment })).rejects.toThrow(/structured/);
		await expect(write({ operation: { ...operation, plan: [] }, environment })).rejects.toThrow(/plan/);
		await expect(write({ operation: { ...operation, completed: true }, environment })).rejects.toThrow(/complete/);
		await expect(write({ operation, environment: { ...environment, system: "PRD" } })).rejects.toThrow(/DEV\/QAS/);
		await expect(write({ operation, environment: { ...environment, origin: undefined } })).rejects.toThrow(/origin/);
		await expect(readCaptureStartContext(output, path.join(directory, "other", "run.json"))).rejects.toThrow(/same run/);
	});
	it("only resumes a legacy plan from the same observed segment, origin and recovery point", async () => {
		const log = { sessionId: "prev", sourceWebContentsId: 2, timeline: [{ url: environment.origin }] };
		await writeFile(path.join(directory, "capture", "action-log.json"), JSON.stringify(log));
		const segment = { status: "interrupted", safeRecoveryPoint: "At item 4711", sessionId: "prev", sourceWebContentsId: 2,
			artifacts: { actionLog: "capture/action-log.json" } };
		const capture = { segmentEvidence: [segment], recoveryPage };
		const run = { environment: { system: "QAS", client: "460" }, operation: { plan: ["Open"] }, capture,
			safeRecoveryPoint: segment.safeRecoveryPoint };
		await expect(write(run)).resolves.toEqual({ ...environment, recoveryPage });
		const shortMarker = { ...recoveryPage, visibleText: "已收货" };
		await expect(write({ ...run, capture: { ...capture, recoveryPage: shortMarker } })).resolves.toEqual({ ...environment, recoveryPage: shortMarker });
		await expect(write({ ...run, environment: { ...environment, origin: "https://another.invalid" } })).rejects.toThrow(/origin/);
		await expect(write({ ...run, safeRecoveryPoint: "A different step" })).rejects.toThrow(/safeRecoveryPoint/);
		await expect(write({ ...run, capture: { ...capture, recoveryPage: { ...recoveryPage, visibleText: "Save" } } })).rejects.toThrow(/safeRecoveryPoint/);
		await expect(write({ ...run, capture: { ...capture, segmentEvidence: [{ ...segment, sessionId: "other" }] } })).rejects.toThrow(/timeline/);
	});
});
