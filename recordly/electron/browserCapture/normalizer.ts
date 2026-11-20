import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NORMALIZE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;

export type BrowserCaptureMediaProbe = {
	codec: string;
	pixelFormat: string;
	frameRate: number;
	durationSeconds: number;
	width: number;
	height: number;
	audioStreamCount: number;
};

export type BrowserCaptureNormalizeResult = {
	outputPath: string;
	probe: BrowserCaptureMediaProbe;
	inputBytes: number;
	outputBytes: number;
};

function parseFrameRate(value: unknown): number {
	if (typeof value !== "string") return 0;
	const [numeratorRaw, denominatorRaw] = value.split("/");
	const numerator = Number(numeratorRaw);
	const denominator = Number(denominatorRaw);
	return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
		? numerator / denominator
		: 0;
}

function positiveNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function buildBrowserCaptureNormalizeArgs(inputPath: string, outputPath: string): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-fflags",
		"+genpts",
		"-i",
		inputPath,
		"-map",
		"0:v:0",
				"-an",
				"-vf",
				"scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p",
				"-c:v",
				"libx264",
				"-preset",
				"medium",
				"-b:v",
				"8M",
				"-maxrate",
				"8M",
				"-bufsize",
				"16M",
		"-movflags",
		"+faststart",
		"-f",
		"mp4",
		outputPath,
	];
}

export function parseBrowserCaptureProbe(stdout: string): BrowserCaptureMediaProbe {
	const parsed = JSON.parse(stdout) as {
		streams?: Array<{
			codec_type?: unknown;
			codec_name?: unknown;
			pix_fmt?: unknown;
			avg_frame_rate?: unknown;
			r_frame_rate?: unknown;
			duration?: unknown;
			width?: unknown;
			height?: unknown;
		}>;
		format?: { duration?: unknown };
	};
	const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
	const video = streams.find((stream) => stream.codec_type === "video");
	if (!video) throw new Error("Normalized Raw Master has no video stream.");

	const probe: BrowserCaptureMediaProbe = {
		codec: typeof video.codec_name === "string" ? video.codec_name : "",
		pixelFormat: typeof video.pix_fmt === "string" ? video.pix_fmt : "",
		frameRate: parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate),
		durationSeconds: positiveNumber(video.duration) || positiveNumber(parsed.format?.duration),
		width: Math.round(positiveNumber(video.width)),
		height: Math.round(positiveNumber(video.height)),
		audioStreamCount: streams.filter((stream) => stream.codec_type === "audio").length,
	};

	if (probe.codec !== "h264")
		throw new Error(`Raw Master codec is ${probe.codec || "unknown"}, not H.264.`);
	if (probe.pixelFormat !== "yuv420p") {
		throw new Error(
			`Raw Master pixel format is ${probe.pixelFormat || "unknown"}, not yuv420p.`,
		);
	}
	if (Math.abs(probe.frameRate - 30) > 0.02) {
		throw new Error(
			`Raw Master frame rate is ${probe.frameRate || "unknown"}, not CFR 30 fps.`,
		);
	}
	if (probe.audioStreamCount !== 0) {
		throw new Error("Raw Master unexpectedly contains an audio stream.");
	}
	if (probe.width !== 1920 || probe.height !== 1080) {
		throw new Error(
			`Raw Master dimensions are ${probe.width || "unknown"}x${probe.height || "unknown"}, not 1920x1080.`,
		);
	}
	if (probe.durationSeconds <= 0 || probe.width <= 0 || probe.height <= 0) {
		throw new Error("Raw Master media dimensions or duration are invalid.");
	}
	return probe;
}

export async function normalizeBrowserCapturePart(
	inputPath: string,
	outputPath: string,
): Promise<BrowserCaptureNormalizeResult> {
	const inputStat = await fs.stat(inputPath);
	if (!inputStat.isFile() || inputStat.size <= 0) {
		throw new Error("Browser capture segment is empty.");
	}

	const outputDirectory = path.dirname(outputPath);
	const temporaryPath = path.join(
		outputDirectory,
		`${path.basename(outputPath, path.extname(outputPath))}.${process.pid}.${Date.now()}.tmp.mp4`,
	);
	await fs.mkdir(outputDirectory, { recursive: true });
	await fs.rm(temporaryPath, { force: true });

	try {
		const { getFfmpegBinaryPath, getFfprobeBinaryPath } = await import("../ipc/ffmpeg/binary");
		await execFileAsync(
			getFfmpegBinaryPath(),
			buildBrowserCaptureNormalizeArgs(inputPath, temporaryPath),
			{ timeout: NORMALIZE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
		);

		const probeResult = await execFileAsync(
			getFfprobeBinaryPath(),
			[
				"-v",
				"error",
				"-show_entries",
				"stream=codec_type,codec_name,pix_fmt,avg_frame_rate,r_frame_rate,duration,width,height:format=duration",
				"-of",
				"json",
				temporaryPath,
			],
			{ timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
		);
		const probe = parseBrowserCaptureProbe(probeResult.stdout);
		const outputStat = await fs.stat(temporaryPath);
		if (!outputStat.isFile() || outputStat.size <= 0) {
			throw new Error("FFmpeg produced an empty Raw Master.");
		}

		await fs.rm(outputPath, { force: true });
		await fs.rename(temporaryPath, outputPath);
		return {
			outputPath,
			probe,
			inputBytes: inputStat.size,
			outputBytes: outputStat.size,
		};
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}
