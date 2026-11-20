import { describe, expect, it } from "vitest";
import { buildActiveCaptionLayout, flattenCaptionWords } from "./captionLayout";
import { DEFAULT_AUTO_CAPTION_SETTINGS, type CaptionCue } from "./types";

describe("flattenCaptionWords", () => {
	it("forces a break at every cue boundary so each phrase shows on its own", () => {
		const cues: CaptionCue[] = [
			{
				id: "a",
				startMs: 0,
				endMs: 1_000,
				text: "hello world",
				words: [
					{ text: "hello", startMs: 0, endMs: 500 },
					{ text: "world", startMs: 500, endMs: 1_000, leadingSpace: true },
				],
			},
			{
				// back-to-back with cue "a" (no gap) — would previously be re-packed by width
				id: "b",
				startMs: 1_000,
				endMs: 2_000,
				text: "next one",
				words: [
					{ text: "next", startMs: 1_000, endMs: 1_500 },
					{ text: "one", startMs: 1_500, endMs: 2_000, leadingSpace: true },
				],
			},
		];

		const flattened = flattenCaptionWords(cues);
		const firstWordOfSecondCue = flattened.find(
			(word) => word.cueId === "b" && word.cueWordIndex === 0,
		);

		expect(firstWordOfSecondCue?.forcedBreakBefore).toBe(true);
		expect(firstWordOfSecondCue?.leadingSpace).toBe(false);
		// the very first word of the first cue never forces a break
		expect(flattened[0].forcedBreakBefore).toBe(false);
	});

	it("never places adjacent cues on the same multi-row page", () => {
		const cues: CaptionCue[] = [
			{ id: "a", startMs: 0, endMs: 1_000, text: "first phrase" },
			{ id: "b", startMs: 1_000, endMs: 2_000, text: "second phrase" },
		];
		const settings = { ...DEFAULT_AUTO_CAPTION_SETTINGS, maxRows: 2 };
		const buildAt = (timeMs: number) =>
			buildActiveCaptionLayout({
				cues,
				timeMs,
				settings,
				maxWidthPx: 1_000,
				measureText: (text) => text.length * 10,
			});

		expect(
			buildAt(500)?.visibleLines.flatMap((line) => line.words.map((word) => word.cueId)),
		).toEqual(["a", "a"]);
		expect(
			buildAt(1_500)?.visibleLines.flatMap((line) => line.words.map((word) => word.cueId)),
		).toEqual(["b", "b"]);
	});
});
