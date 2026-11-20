import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getDefaultBorderRadiusPercent,
	legacyBorderRadiusPixelsToPercent,
	normalizeProjectEditor,
	resolveVideoUrl,
} from "./projectPersistence";
import { ADVANCED_VERTICAL_PADDING_MAX, DEFAULT_AUTO_CAPTION_SETTINGS } from "./types";

afterEach(() => vi.unstubAllGlobals());

describe("resolveVideoUrl", () => {
	it("does not send an already renderable URL through the local-path IPC", async () => {
		const getLocalMediaUrl = vi.fn();
		vi.stubGlobal("window", { electronAPI: { getLocalMediaUrl } });

		await expect(resolveVideoUrl("http://127.0.0.1:1234/video?path=test")).resolves.toBe(
			"http://127.0.0.1:1234/video?path=test",
		);
		expect(getLocalMediaUrl).not.toHaveBeenCalled();
	});

	it("normalizes a file URL before requesting a local media URL", async () => {
		const getLocalMediaUrl = vi.fn().mockResolvedValue({
			success: true,
			url: "http://127.0.0.1:1234/video?path=clip",
		});
		vi.stubGlobal("window", { electronAPI: { getLocalMediaUrl } });

		await resolveVideoUrl("file:///Users/demo/My%20Clip.mp4");
		expect(getLocalMediaUrl).toHaveBeenCalledWith("/Users/demo/My Clip.mp4");
	});
});

describe("normalizeProjectEditor", () => {
	it("preserves explicit timeline captions and defaults legacy projects to source time", () => {
		expect(normalizeProjectEditor({}).autoCaptionSettings.timebase).toBe("source");
		expect(
			normalizeProjectEditor({
				autoCaptionSettings: {
					...DEFAULT_AUTO_CAPTION_SETTINGS,
					timebase: "timeline",
				},
			}).autoCaptionSettings.timebase,
		).toBe("timeline");
		expect(
			normalizeProjectEditor({
				autoCaptionSettings: {
					...DEFAULT_AUTO_CAPTION_SETTINGS,
					timebase: "invalid",
				} as never,
			}).autoCaptionSettings.timebase,
		).toBe("source");
	});
	it("ignores retired temporal blur fields when opening an older project", () => {
		const savedEditor = {
			zoomMotionBlur: 0.6,
			zoomTemporalMotionBlur: 0.35,
			zoomMotionBlurSampleCount: 13,
			zoomMotionBlurShutterFraction: 0.94,
		};
		const normalized = normalizeProjectEditor(savedEditor);
		expect(normalized.zoomMotionBlur).toBe(0.6);
		for (const field of ["zoomTemporalMotionBlur", "zoomMotionBlurSampleCount", "zoomMotionBlurShutterFraction"]) {
			expect(normalized).not.toHaveProperty(field);
		}
	});
	it("defaults to 8% on macOS and square corners elsewhere", () => {
		expect(getDefaultBorderRadiusPercent("MacIntel")).toBe(8);
		expect(getDefaultBorderRadiusPercent("Win32")).toBe(0);
		expect(getDefaultBorderRadiusPercent("Linux x86_64")).toBe(0);
	});

	it("clamps radius percentages", () => {
		expect(normalizeProjectEditor({ borderRadius: 75 }).borderRadius).toBe(50);
	});

	it("preserves explicit motion and cursor settings instead of falling back to a preset", () => {
		const editor = normalizeProjectEditor({
			zoomInDurationMs: 1200,
			zoomOutDurationMs: 1000,
			cursorSize: 1.7,
			cursorSmoothing: 0.55,
			cursorSpringStiffnessMultiplier: 1,
			cursorSpringDampingMultiplier: 1,
			cursorSpringMassMultiplier: 1,
			cursorMotionBlur: 0,
			cursorClickBounce: 0.9,
			cursorClickBounceDuration: 320,
		});

		expect(editor).toMatchObject({
			zoomInDurationMs: 1200,
			zoomOutDurationMs: 1000,
			cursorSize: 1.7,
			cursorSmoothing: 0.55,
			cursorMotionBlur: 0,
			cursorClickBounce: 0.9,
			cursorClickBounceDuration: 320,
		});
	});

	it("converts legacy 1080p-relative radius pixels to percentages", () => {
		expect(legacyBorderRadiusPixelsToPercent(54)).toBe(5);
	});

	it("preserves the extended advanced vertical padding range", () => {
		const editor = normalizeProjectEditor({
			padding: {
				top: 240,
				bottom: ADVANCED_VERTICAL_PADDING_MAX,
				left: 22,
				right: 22,
				linked: false,
			},
		});

		expect(editor.padding).toMatchObject({
			top: 240,
			bottom: ADVANCED_VERTICAL_PADDING_MAX,
			left: 22,
			right: 22,
			linked: false,
		});
	});

	it("keeps linked padding clamped to the original range", () => {
		const editor = normalizeProjectEditor({
			padding: {
				top: ADVANCED_VERTICAL_PADDING_MAX,
				bottom: ADVANCED_VERTICAL_PADDING_MAX,
				left: ADVANCED_VERTICAL_PADDING_MAX,
				right: ADVANCED_VERTICAL_PADDING_MAX,
				linked: true,
			},
		});

		expect(editor.padding).toMatchObject({
			top: 100,
			bottom: 100,
			left: 100,
			right: 100,
			linked: true,
		});
	});

	it("migrates legacy webcam radius pixels to percentage roundness", () => {
		const editor = normalizeProjectEditor({
			webcam: {
				cornerRadius: 90,
				width: 40,
				height: 40,
			} as never,
		});

		expect(editor.webcam.roundness).toBeCloseTo(17.36, 1);
		expect(editor.webcam.cornerRadius).toBeUndefined();
	});

	it("uses the legacy webcam size when migrating radius pixels", () => {
		const editor = normalizeProjectEditor({
			webcam: {
				cornerRadius: 90,
				size: 80,
			} as never,
		});

		expect(editor.webcam.width).toBe(80);
		expect(editor.webcam.height).toBe(80);
		expect(editor.webcam.roundness).toBeCloseTo(4.34, 1);
	});
});
