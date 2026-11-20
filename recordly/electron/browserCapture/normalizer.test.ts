import { describe, expect, it } from "vitest";
import { buildBrowserCaptureNormalizeArgs, parseBrowserCaptureProbe } from "./normalizer";

describe("Browser Capture normalizer", () => {
	it("builds a video-only H.264 yuv420p CFR 30 command", () => {
		const args = buildBrowserCaptureNormalizeArgs("segment.webm.part", "raw-master.tmp.mp4");
		expect(args).toContain("-an");
		expect(args).toContain("libx264");
		expect(args).toContain(
			"scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p",
		);
		expect(args).toContain("-b:v");
		expect(args).toContain("8M");
		expect(args).toContain("-maxrate");
		expect(args).toContain("-bufsize");
		expect(args.at(-1)).toBe("raw-master.tmp.mp4");
	});

	it("accepts only the required normalized video shape", () => {
		const probe = parseBrowserCaptureProbe(
			JSON.stringify({
				streams: [
					{
						codec_type: "video",
						codec_name: "h264",
						pix_fmt: "yuv420p",
						avg_frame_rate: "30/1",
						duration: "4.25",
						width: 1920,
						height: 1080,
					},
				],
			}),
		);
		expect(probe).toMatchObject({
			codec: "h264",
			pixelFormat: "yuv420p",
			frameRate: 30,
			audioStreamCount: 0,
		});
	});

	it("rejects a non-1080p normalized Raw Master", () => {
		expect(() =>
			parseBrowserCaptureProbe(
				JSON.stringify({
					streams: [
						{
							codec_type: "video",
							codec_name: "h264",
							pix_fmt: "yuv420p",
							avg_frame_rate: "30/1",
							duration: "1",
							width: 3072,
							height: 1920,
						},
					],
				}),
			),
		).toThrow(/1920x1080/);
	});

	it("rejects an audio stream", () => {
		expect(() =>
			parseBrowserCaptureProbe(
				JSON.stringify({
					streams: [
						{
							codec_type: "video",
							codec_name: "h264",
							pix_fmt: "yuv420p",
							avg_frame_rate: "30/1",
							duration: "1",
							width: 1280,
							height: 720,
						},
						{ codec_type: "audio", codec_name: "opus" },
					],
				}),
			),
		).toThrow(/audio stream/i);
	});
});
