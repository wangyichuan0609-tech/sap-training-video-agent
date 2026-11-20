import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CDP_TELEMETRY_COLLECTOR_SOURCE } from "./cdpTelemetryRuntime";

const assetDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(assetDirectory, "..", "..", "public");

describe("SAP WebContents capture renderer assets", () => {
	it("uses a video-only tab MediaStream and never requests desktop capture", async () => {
		const renderer = await fs.readFile(
			path.join(publicDirectory, "recordly-sap-capture.html"),
			"utf8",
		);

		expect(renderer).toContain('chromeMediaSource: "tab"');
		expect(renderer).toContain("activeStream.getAudioTracks().length !== 0");
		expect(renderer).toContain("chromeMediaSourceId: request.streamId");
		expect(renderer).toContain("minWidth: VIDEO_WIDTH");
		expect(renderer).toContain("maxWidth: VIDEO_WIDTH");
		expect(renderer).toContain("minHeight: VIDEO_HEIGHT");
		expect(renderer).toContain("maxHeight: VIDEO_HEIGHT");
		expect(renderer).toContain("const VIDEO_FRAME_RATE = 30");
		expect(renderer).toContain("const VIDEO_BITS_PER_SECOND = 8_000_000");
		expect(renderer).toContain("new MediaRecorder");
		expect(renderer).not.toContain("getDisplayMedia");
		expect(renderer).not.toContain("desktopCapturer");
	});

	it("exposes only the fixed capture IPC bridge from its dedicated preload", async () => {
		const preload = await fs.readFile(path.join(assetDirectory, "preload.cjs"), "utf8");

		expect(preload).toContain('exposeInMainWorld(\n\t"recordlySapCapture"');
		expect(preload).not.toContain('exposeInMainWorld("electronAPI"');
		expect(preload).not.toContain("sendSync");
	});

	it("ships one isolated-world CDP collector and no executable preload collector", async () => {
		const sapBrowser = await fs.readFile(
			path.resolve(assetDirectory, "..", "sapBrowser.ts"),
			"utf8",
		);
		await expect(
			fs.access(path.join(assetDirectory, "telemetryPreload.cjs")),
		).rejects.toThrow();

		expect(sapBrowser).not.toContain("telemetryPreload.cjs");
		expect(CDP_TELEMETRY_COLLECTOR_SOURCE).toContain('kind: "browser-event"');
		expect(CDP_TELEMETRY_COLLECTOR_SOURCE).toContain('document, "keydown"');
		expect(CDP_TELEMETRY_COLLECTOR_SOURCE).toContain('document, "keyup"');
		expect(CDP_TELEMETRY_COLLECTOR_SOURCE).toContain('"tab-switch"');
		expect(CDP_TELEMETRY_COLLECTOR_SOURCE).toContain('sensitive ? "redacted"');
		expect(() => new Function(CDP_TELEMETRY_COLLECTOR_SOURCE)).not.toThrow();
		expect(CDP_TELEMETRY_COLLECTOR_SOURCE).not.toContain("ipcRenderer");
		expect(CDP_TELEMETRY_COLLECTOR_SOURCE).not.toContain("chrome.runtime");
	});
});
