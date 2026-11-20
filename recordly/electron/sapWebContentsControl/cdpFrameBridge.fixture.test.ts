import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const electronPath = path.resolve(
	currentDirectory,
	"../../node_modules/electron/dist/electron.exe",
);
const runnerPath = path.join(currentDirectory, "cdpFrameFixtureRunner.cjs");

interface FixtureResult {
	ok: boolean;
	result?: {
		url?: string;
		visibleResult?: string;
		frames?: Array<{
			url?: string;
			mainFrame?: boolean;
			visibleResult?: string;
			controls?: Array<{ id?: string; targetName?: string; controlType?: string }>;
		}>;
		domRect?: { x: number; y: number; width: number; height: number };
		frame?: {
			frameId: string;
			parentFrameId?: string;
			origin: string;
			isMainFrame: boolean;
		};
	};
	error?: string;
}

let temporaryDirectory = "";
let output: {
	results: FixtureResult[];
	frameCount: number;
	oopifFrameCount: number;
	obscuredFrameError: string;
	detachError: string;
};

beforeAll(async () => {
	temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-cdp-frame-fixture-"));
	const inputPath = path.join(temporaryDirectory, "input.json");
	const outputPath = path.join(temporaryDirectory, "output.json");
	await fs.writeFile(
		inputPath,
		JSON.stringify({
			outputPath,
			userDataPath: path.join(temporaryDirectory, "user-data"),
		}),
		"utf8",
	);
	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	const completed = spawnSync(electronPath, [runnerPath, `--cdp-frame-fixture=${inputPath}`], {
		cwd: currentDirectory,
		env: environment,
		encoding: "utf8",
		timeout: 45_000,
		windowsHide: true,
	});
	if (completed.status !== 0) {
		throw new Error(
			`CDP frame fixture failed (${completed.status}): ${completed.stderr || completed.stdout}`,
		);
	}
	output = JSON.parse(await fs.readFile(outputPath, "utf8"));
}, 55_000);

afterAll(async () => {
	if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("shared CDP frame control", () => {
	it("returns only normalized HTTP(S) origins and never exposes URL tokens", () => {
		const serialized = JSON.stringify(output);
		expect(serialized).not.toContain("fixture-url-token");
		expect(serialized).not.toContain("fixture-fragment");
		for (const action of output.results) {
			const url = action.result?.url;
			if (!url) continue;
			expect(url).toBe(new URL(url).origin);
		}
		for (const frame of output.results[0]?.result?.frames ?? []) {
			if (!frame.url) continue;
			expect(frame.url).toBe(new URL(frame.url).origin);
		}
	});

	it("discovers main, delayed, and cross-site OOPIF documents", () => {
		expect(output.frameCount).toBeGreaterThanOrEqual(5);
		expect(output.oopifFrameCount).toBeGreaterThanOrEqual(1);
		expect(output.results[0], JSON.stringify(output, null, 2)).toMatchObject({ ok: true });
		expect(output.results[0]?.result?.frames?.some((frame) => frame.mainFrame)).toBe(true);
		expect(
			output.results[0]?.result?.frames?.every((frame) => frame.url?.startsWith("http://")),
		).toBe(true);
		expect(
			output.results[0]?.result?.frames?.some((frame) =>
				frame.controls?.some((control) => control.id === "frame-input"),
			),
		).toBe(true);
		expect(output.results[1], JSON.stringify(output, null, 2)).toMatchObject({ ok: true });
	});

	it("uses globally unique resolution and top-level mapped DOM geometry", () => {
		expect(output.results[2]).toMatchObject({ ok: true });
		const rect = output.results[2]?.result?.domRect;
		expect(rect?.x).toBeGreaterThan(0);
		expect(rect?.y).toBeGreaterThan(0);
		expect(rect?.width).toBeGreaterThan(0);
		expect(rect?.height).toBeGreaterThan(0);
		expect(output.results[2]?.result?.frame).toMatchObject({
			origin: expect.stringMatching(/^http:\/\//),
			isMainFrame: false,
		});
		expect(output.results[2]?.result?.frame?.parentFrameId).toBeTruthy();
	});

	it("ignores an offscreen stale frame without weakening foreground obstruction checks", () => {
		expect(output.results[2], JSON.stringify(output, null, 2)).toMatchObject({ ok: true });
		expect(output.results[3], JSON.stringify(output, null, 2)).toMatchObject({ ok: true });
		expect(output.obscuredFrameError).toContain(
			"The child frame is obscured at the target point.",
		);
	});

	it("delivers trusted click and key input while typing in the child realm", () => {
		expect(output.results[3]).toMatchObject({ ok: true });
		expect(output.results[4]).toMatchObject({ ok: true });
		expect(output.results[5]).toMatchObject({ ok: true });
		const afterTypeAndScroll = output.results[6]?.result?.frames?.find((frame) =>
			frame.visibleResult?.includes("value:Typed Frame Value"),
		)?.visibleResult;
		expect(afterTypeAndScroll, JSON.stringify(output, null, 2)).toContain("click:true");
		expect(afterTypeAndScroll).toContain("input:true inputCount:26");
		expect(afterTypeAndScroll).toContain("changeCount:0 changeTrusted:true");
		expect(afterTypeAndScroll).toContain(
			"value:Typed Frame Value key:false f4:false keyTrusted:true keyCount:27",
		);
		expect(afterTypeAndScroll).not.toContain("Legacy-42");
		expect(afterTypeAndScroll).toContain("wheel:true wheelCount:1");
		expect(afterTypeAndScroll).toMatch(/scroll:true scrollCount:[1-9]\d*/);
		expect(output.results[7]).toMatchObject({ ok: true });
		const afterF4 = output.results[8]?.result?.frames?.find((frame) =>
			frame.visibleResult?.includes("value:Typed Frame Value"),
		)?.visibleResult;
		expect(afterF4).toContain("input:true inputCount:26");
		expect(afterF4).toContain("changeCount:0 changeTrusted:true");
		expect(afterF4).toContain(
			"value:Typed Frame Value key:false f4:true keyTrusted:true keyCount:28",
		);
		expect(output.results[9]).toMatchObject({ ok: true });
		const afterEnter = output.results[10]?.result?.frames?.find((frame) =>
			frame.visibleResult?.includes("value:Typed Frame Value"),
		)?.visibleResult;
		expect(afterEnter).toContain("input:true inputCount:26");
		expect(afterEnter).toContain("changeCount:1 changeTrusted:true");
		expect(afterEnter).toContain(
			"value:Typed Frame Value key:true f4:true keyTrusted:true keyCount:29",
		);
		expect(afterEnter).toContain("wheel:true wheelCount:1");
		expect(afterEnter).toMatch(/scroll:true scrollCount:[1-9]\d*/);
	});

	it("uses globally unique resolution and rejects unsafe geometry", () => {
		expect(output.results[11]).toMatchObject({ ok: false });
		expect(output.results[11]?.error).toContain("matched 2 elements across all frames");
		expect(output.results[12]).toMatchObject({ ok: false });
		expect(output.results[12]?.error).toContain("transformed iframe cannot be mapped safely");
	});

	it("maps trusted input through a same-origin nested frame inside the OOPIF", () => {
		expect(output.results[13]).toMatchObject({ ok: true });
		expect(output.results[14]).toMatchObject({ ok: true });
		expect(
			output.results[15]?.result?.frames?.some((frame) =>
				frame.visibleResult?.includes("nested:true"),
			),
		).toBe(true);
	});

	it("uses only trusted key events for an explicit legacy grid-cell action", () => {
		expect(output.results[16]).toMatchObject({ ok: false });
		expect(output.results[16]?.error).toContain(
			"requires a non-editable span[role='textbox'] target",
		);
		expect(output.results[17], JSON.stringify(output, null, 2)).toMatchObject({ ok: true });
		const afterGridInput = output.results[18]?.result?.frames?.find((frame) =>
			frame.visibleResult?.includes("gridDisplay:U Stock Transfer"),
		)?.visibleResult;
		expect(afterGridInput, JSON.stringify(output, null, 2)).toContain("gridClick:true");
		expect(afterGridInput).toContain("gridFocus:true");
		expect(afterGridInput).toContain("gridKeyTrusted:true");
		expect(afterGridInput).toContain("gridKeyCount:2");
		expect(afterGridInput).toContain("gridPressTrusted:true");
		expect(afterGridInput).toContain("gridPressCount:2");
		expect(afterGridInput).toContain("gridCommitted:true");
		expect(afterGridInput).toContain(
			"gridEventOrder:down:U,press:U,up:U,down:Enter,press:Enter,up:Enter",
		);
	});

	it("re-resolves the execution context after an OOPIF navigation", () => {
		expect(output.results[19]).toMatchObject({ ok: true });
		expect(output.results[20]).toMatchObject({ ok: true });
		expect(output.results[21]?.result?.visibleResult).toContain("After Navigation");
	});

	it("fails closed when the shared debugger detaches", () => {
		expect(output.detachError).toContain("detached unexpectedly");
	});
});
