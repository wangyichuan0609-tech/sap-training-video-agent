#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { assertCompiledContract, assertPublishableRun, assertRenderInputs, reviewedPreviewEvidence, ruleSetSha256 } from "./publication-contract.mjs";

function parseArgs(argv) {
	const options = {};
	const positional = [];
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (!value.startsWith("--")) {
			positional.push(value);
			continue;
		}
		const equalIndex = value.indexOf("=");
		if (equalIndex >= 0) {
			options[value.slice(2, equalIndex)] = value.slice(equalIndex + 1);
			continue;
		}
		const key = value.slice(2);
		const next = argv[index + 1];
		if (next && !next.startsWith("--")) {
			options[key] = next;
			index += 1;
		} else {
			options[key] = true;
		}
	}
	return { options, positional };
}

function run(command, args, label) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error) throw new Error(`${label}: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
		throw new Error(`${label} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
	}
	return result.stdout;
}

async function sha256File(filePath) {
	const hash = createHash("sha256");
	hash.update(await readFile(filePath));
	return hash.digest("hex");
}

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	try {
		await rename(temporaryPath, filePath);
	} catch (error) {
		if (existsSync(filePath)) {
			await unlink(filePath);
			await rename(temporaryPath, filePath);
			return;
		}
		throw error;
	}
}

function rateToNumber(value) {
	if (typeof value !== "string") return Number.NaN;
	const [numerator, denominator] = value.split("/").map(Number);
	return denominator ? numerator / denominator : Number.NaN;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function finiteNonNegative(value) {
	return Number.isFinite(value) && value >= 0;
}

function validateProjectTimeline(project, projectPath, mediaDurationSeconds, toleranceMs) {
	const editor = project?.editor && typeof project.editor === "object" ? project.editor : project;
	const audioRegions = Array.isArray(editor?.audioRegions) ? editor.audioRegions : [];
	const captions = Array.isArray(editor?.autoCaptions) ? editor.autoCaptions : [];
	const mediaEndMs = mediaDurationSeconds * 1000;
	const validateRange = (entry, label) => {
		const startMs = Number(entry?.startMs);
		const endMs = Number(entry?.endMs);
		assert(
			finiteNonNegative(startMs) && Number.isFinite(endMs) && endMs > startMs,
			`${label} has an invalid timeline range in ${projectPath}: ${entry?.id || "unknown"}`,
		);
		assert(
			endMs <= mediaEndMs + toleranceMs,
			`${label} ends after the exported media in ${projectPath}: ${entry?.id || "unknown"}`,
		);
		return { startMs, endMs };
	};

	const normalizedAudio = audioRegions.map((entry) => ({ entry, ...validateRange(entry, "Audio region") }));
	const normalizedCaptions = captions.map((entry) => ({ entry, ...validateRange(entry, "Caption") }));

	for (const caption of normalizedCaptions) {
		const matchingAudio = normalizedAudio.find(
			(audio) =>
				Math.abs(audio.startMs - caption.startMs) <= toleranceMs &&
				Math.abs(audio.endMs - caption.endMs) <= toleranceMs,
		);
		assert(
			matchingAudio,
			`Caption ${caption.entry?.id || "unknown"} is not aligned to an audio region within ${toleranceMs} ms.`,
		);
	}

	return {
		status: "passed",
		project: projectPath,
		toleranceMs,
		audioRegionCount: normalizedAudio.length,
		captionCount: normalizedCaptions.length,
		maxTimelineEndMs: Math.max(
			0,
			...normalizedAudio.map((entry) => entry.endMs),
			...normalizedCaptions.map((entry) => entry.endMs),
		),
	};
}

async function updateRunJson(runJsonPath, run, inputPath, validation) {
	const output = path.relative(path.dirname(runJsonPath), inputPath).replaceAll("\\", "/");
	run.video = {
		...(run.video || {}),
		status: "completed",
		output,
		resolution: `${validation.video.width}x${validation.video.height}`,
		frameRate: validation.video.frameRate,
		duration: validation.durationSeconds,
		sizeBytes: validation.sizeBytes,
		sha256: validation.sha256,
		playbackRate: 1,
		verification: {
			...(run.video?.verification || {}),
			ffprobe: "passed",
			fullDecode: "passed",
			avDurationDelta: validation.avDurationDeltaSeconds,
			timeline: validation.timeline?.status ?? "not-provided",
		},
	};
	run.publication = {
		...(run.publication || {}),
		finalMp4Generated: true,
		finalMp4Path: output,
		sha256: validation.sha256,
		validation: {
			...(run.publication?.validation || {}),
			ffprobe: "passed",
			fullDecode: "passed",
			timeline: validation.timeline?.status ?? "not-provided",
			focusedPreview: "passed",
		},
	};
	await writeJsonAtomic(runJsonPath, run);
}

async function updateContract(contract, contractPath, inputPath, validation, gate, focusedPreviewEvidence) {
	contract.validation = {
		status: "passed",
		input: inputPath,
		sha256: validation.sha256,
		sizeBytes: validation.sizeBytes,
		durationSeconds: validation.durationSeconds,
		validatedAt: validation.validatedAt,
		video: validation.video,
		audio: validation.audio,
		avDurationDeltaSeconds: validation.avDurationDeltaSeconds,
		timeline: validation.timeline,
		exportSettings: validation.exportSettings,
		reviewBindingSha256: validation.reviewBindingSha256,
	};
	contract.publicationGate = contract.publicationGate || {};
	if (gate === "focused") {
		contract.focusedPreviewReview = {
			mediaValidation: "passed",
			mediaSha256: validation.sha256,
			visualReview: "pending",
			reviewedAt: null,
		};
		contract.publicationGate.focusedPreview = "media-validated-awaiting-visual-review";
		contract.publicationGate.publishable = false;
	} else {
		if (focusedPreviewEvidence) {
			contract.publicationGate.focusedPreview = "passed";
			contract.focusedPreviewReview = focusedPreviewEvidence;
		}
		contract.publicationGate.fullExport = "passed";
		contract.publicationGate.finalValidation = "passed";
		contract.publicationGate.publishable =
			contract.publicationGate.compile === "passed" &&
			contract.publicationGate.focusedPreview === "passed" &&
			Array.isArray(contract.manualHelp) &&
			contract.manualHelp.length === 0;
	}
	await writeJsonAtomic(contractPath, contract);
	return contract;
}

async function focusedReviewBinding(options) {
	const contractPath = path.resolve(String(options.contract));
	const contract = await readJson(contractPath);
	assertCompiledContract(contract, contractPath, "focused-preview");
	// Only validation/review state changes between automated validation and review.
	const { validation, focusedPreviewReview, publicationGate, ...compiled } = contract;
	const { focusedPreview, publishable, ...compileGate } = publicationGate;
	assert(typeof contract.projectPath === "string", "Focused contract has no project path.");
	const projectPath = path.resolve(String(options.project || contract.projectPath));
	const projectSha256 = await sha256File(projectPath);
	assert(
		projectPath === path.resolve(contract.projectPath) && projectSha256 === contract.projectSha256,
		"Focused project changed after compilation; rebuild its contract and export again.",
	);
	return createHash("sha256").update(JSON.stringify({
		contractPath,
		compiled: { ...compiled, publicationGate: compileGate },
		projectPath,
		projectSha256,
		timelineChecked: Boolean(options.project),
		avToleranceMs: Number(options["av-tolerance-ms"] ?? 250),
		timelineToleranceMs: Number(options["timeline-tolerance-ms"] ?? 50),
		validatorSha256: await ruleSetSha256(import.meta.url, "./publication-contract.mjs"),
	})).digest("hex");
}

async function recordFocusedVisualReview(options, inputPath, inputStats, reviewBindingSha256) {
	assert(!options["run-json"], "--run-json is only valid for final publication.");
	const contractPath = path.resolve(String(options.contract));
	const contract = await readJson(contractPath);
	const validation = contract.validation;
	assert(
		contract.publicationGate?.focusedPreview === "media-validated-awaiting-visual-review" &&
			validation?.status === "passed",
		"Focused Preview must pass automated media validation before visual review can be recorded.",
	);
	assert(
		validation.reviewBindingSha256 === reviewBindingSha256,
		"Focused validation inputs or rules changed, or the validation predates review reuse. Rerun automated validation without --visual-review first.",
	);
	assert(
		path.resolve(String(validation.input || "")) === inputPath &&
			validation.sizeBytes === inputStats.size &&
			validation.sha256 === await sha256File(inputPath),
		"Visual review must use the exact MP4 and SHA256 from the preceding automated media validation.",
	);
	contract.focusedPreviewReview = {
		mediaValidation: "passed",
		mediaSha256: validation.sha256,
		visualReview: "passed",
		reviewedAt: new Date().toISOString(),
	};
	contract.publicationGate.focusedPreview = "passed";
	contract.publicationGate.publishable = false;
	await writeJsonAtomic(contractPath, contract);
	console.log(JSON.stringify({
		status: "passed", input: inputPath, contract: contractPath,
		sha256: validation.sha256, mediaValidation: "reused", visualReview: "passed",
	}, null, 2));
}

async function main() {
	const { options, positional } = parseArgs(process.argv.slice(2));
	const inputValue = options.input || positional[0];
	if (!inputValue) {
		throw new Error(
			"Usage: node scripts/validate-final-video.mjs --input=<mp4> [--project=<project.recordly>] [--run-json=<run.json>] [--contract=<contract.json>] [--gate=focused|final] [--visual-review=passed] [--focused-contract=<focused.contract.json>]",
		);
	}
	const gate = options.gate ?? "final";
	assert(gate === "focused" || gate === "final", "--gate must be focused or final.");
	if (options["run-json"]) assert(gate === "final" && options.contract, "--run-json requires the final publication contract.");
	const visualReview = options["visual-review"];
	const focusedContractValue = options["focused-contract"];
	if (visualReview !== undefined) {
		assert(gate === "focused", "--visual-review is only valid with --gate=focused.");
		assert(options.contract, "--visual-review requires --contract so the review evidence can be recorded.");
		assert(visualReview === "passed", "--visual-review only accepts the explicit value 'passed'.");
	}
	if (focusedContractValue !== undefined) {
		assert(gate === "final", "--focused-contract is only valid with --gate=final.");
		assert(options.contract, "--focused-contract requires --contract so the evidence can be recorded.");
	}
	if (gate === "final" && options.contract) {
		assert(
			focusedContractValue !== undefined,
			"Final publication with --contract requires --focused-contract from the reviewed Focused Preview.",
		);
	}
	const contractPath = options.contract ? path.resolve(String(options.contract)) : null;
	const contractBytes = contractPath ? await readFile(contractPath) : null;
	const contract = contractBytes ? JSON.parse(contractBytes) : null;
	if (contract) {
		assertCompiledContract(contract, contractPath, gate === "focused" ? "focused-preview" : "full");
		const projectPath = path.resolve(String(options.project || contract.projectPath));
		assert(projectPath === path.resolve(contract.projectPath), "Validation project must match the compiled project.");
		options.project = projectPath;
		if (gate === "final") {
			assert(await sha256File(projectPath) === contract.projectSha256, "Full project changed after compilation.");
			await assertPublishableRun(contract, options["run-json"]);
		}
	}
	let focusedPreviewEvidence = null;
	if (focusedContractValue !== undefined) {
		const focusedContractPath = path.resolve(String(focusedContractValue));
		assert(focusedContractPath !== contractPath, "Focused Preview and full export must use different contract files.");
		const focusedBytes = await readFile(focusedContractPath);
		const focused = JSON.parse(focusedBytes.toString("utf8"));
		focusedPreviewEvidence = {
			...reviewedPreviewEvidence(focused, contract),
			sourceContract: focusedContractPath,
			sourceContractSha256: createHash("sha256").update(focusedBytes).digest("hex"),
		};
	}
	const inputPath = path.resolve(String(inputValue));
	assert(existsSync(inputPath), `Final MP4 does not exist: ${inputPath}`);
	const inputStats = await stat(inputPath);
	assert(inputStats.isFile() && inputStats.size > 0, `Final MP4 is empty: ${inputPath}`);
	const reviewBindingSha256 = gate === "focused" && options.contract
		? await focusedReviewBinding(options)
		: null;
	if (visualReview === "passed") {
		await recordFocusedVisualReview(options, inputPath, inputStats, reviewBindingSha256);
		return;
	}

	if (contract) await assertRenderInputs(contract);

	const probeOutput = run(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"format=duration,format_name,start_time:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels,duration,start_time",
			"-of",
			"json",
			inputPath,
		],
		"ffprobe final MP4",
	);
	const probe = JSON.parse(probeOutput);
	const video = probe.streams?.find((stream) => stream.codec_type === "video");
	const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
	assert(video, "Final MP4 has no video stream.");
	assert(audio, "Final MP4 has no audio stream.");
	const frameRate = rateToNumber(video.avg_frame_rate) || rateToNumber(video.r_frame_rate);
	assert(video.codec_name === "h264", `Expected H.264 video, found ${video.codec_name || "unknown"}.`);
	assert(audio.codec_name === "aac", `Expected AAC audio, found ${audio.codec_name || "unknown"}.`);
	assert(
		String(probe.format?.format_name || "")
			.split(",")
			.includes("mp4"),
		`Expected an MP4 container, found ${probe.format?.format_name || "unknown"}.`,
	);
	assert(video.width === 1920 && video.height === 1080, `Expected 1920x1080, found ${video.width}x${video.height}.`);
	assert(Number.isFinite(frameRate) && Math.abs(frameRate - 30) < 0.001, `Expected 30 fps, found ${frameRate}.`);
	const durationSeconds = Number(probe.format?.duration);
	assert(Number.isFinite(durationSeconds) && durationSeconds > 0, "Final MP4 duration is invalid.");
	const videoDurationSeconds = Number(video.duration);
	const audioDurationSeconds = Number(audio.duration);
	const videoStartSeconds = Number(video.start_time ?? 0);
	const audioStartSeconds = Number(audio.start_time ?? 0);
	assert(Number.isFinite(videoDurationSeconds) && videoDurationSeconds > 0, "Video stream duration is invalid.");
	assert(Number.isFinite(audioDurationSeconds) && audioDurationSeconds > 0, "Audio stream duration is invalid.");
	assert(Number.isFinite(videoStartSeconds), "Video stream start PTS is invalid.");
	assert(Number.isFinite(audioStartSeconds), "Audio stream start PTS is invalid.");
	const avDurationDeltaSeconds = Math.abs(videoDurationSeconds - audioDurationSeconds);
	const avStartDeltaSeconds = Math.abs(videoStartSeconds - audioStartSeconds);
	const avToleranceSeconds = Number(options["av-tolerance-ms"] ?? 250) / 1000;
	assert(
		Number.isFinite(avToleranceSeconds) && avToleranceSeconds >= 0,
		"--av-tolerance-ms must be a non-negative number.",
	);
	assert(
		avDurationDeltaSeconds <= avToleranceSeconds,
		`Audio/video duration delta ${avDurationDeltaSeconds.toFixed(3)}s exceeds ${avToleranceSeconds.toFixed(3)}s.`,
	);
	assert(
		avStartDeltaSeconds <= avToleranceSeconds,
		`Audio/video start PTS delta ${avStartDeltaSeconds.toFixed(3)}s exceeds ${avToleranceSeconds.toFixed(3)}s.`,
	);

	let timeline = null;
	if (options.project) {
		const projectPath = path.resolve(String(options.project));
		assert(existsSync(projectPath), `Recordly project does not exist: ${projectPath}`);
		const timelineToleranceMs = Number(options["timeline-tolerance-ms"] ?? 50);
		assert(
			Number.isFinite(timelineToleranceMs) && timelineToleranceMs >= 0,
			"--timeline-tolerance-ms must be a non-negative number.",
		);
		timeline = validateProjectTimeline(
			await readJson(projectPath),
			projectPath,
			durationSeconds,
			timelineToleranceMs,
		);
	}

	const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";
	run(
		"ffmpeg",
		["-hide_banner", "-v", "error", "-i", inputPath, "-f", "null", nullSink],
		"complete FFmpeg decode",
	);

	const validation = {
		schemaVersion: 2,
		status: "passed",
		validatedAt: new Date().toISOString(),
		reviewBindingSha256,
		input: inputPath,
		sha256: await sha256File(inputPath),
		sizeBytes: inputStats.size,
		durationSeconds,
		container: probe.format?.format_name ?? null,
		video: {
			codec: video.codec_name,
			width: video.width,
			height: video.height,
			frameRate,
			durationSeconds: videoDurationSeconds,
			startSeconds: videoStartSeconds,
		},
		audio: {
			codec: audio.codec_name,
			sampleRate: audio.sample_rate ? Number(audio.sample_rate) : null,
			channels: audio.channels ?? null,
			durationSeconds: audioDurationSeconds,
			startSeconds: audioStartSeconds,
		},
		avDurationDeltaSeconds,
		avStartDeltaSeconds,
		avToleranceSeconds,
		timeline,
		playbackRate: 1,
		exportSettings: {
			container: "mp4",
			videoCodec: "h264",
			audioCodec: "aac",
			width: 1920,
			height: 1080,
			frameRate: 30,
			playbackRate: 1,
			quality: "source",
		},
		verification: {
			ffprobe: "passed",
			fullDecode: "passed",
			avTiming: "passed",
			timeline: timeline?.status ?? "not-provided",
		},
	};
	// A full decode can overlap a recompile or a business-state change.
	if (contract) assert((await readFile(contractPath)).equals(contractBytes), "Compile contract changed during validation.");
	if (focusedPreviewEvidence) assert(await sha256File(focusedPreviewEvidence.sourceContract) === focusedPreviewEvidence.sourceContractSha256,
		"Reviewed preview contract changed during validation.");
	const verifiedRun = contract && gate === "final" ? await assertPublishableRun(contract, options["run-json"]) : null;
	const sidecarPath = path.resolve(String(options.output || `${inputPath}.validation.json`));
	await writeJsonAtomic(sidecarPath, validation);
	let updatedContract = null;
	if (contract) {
		updatedContract = await updateContract(
			contract, contractPath,
			inputPath,
			validation,
			gate,
			focusedPreviewEvidence,
		);
	}
	if (options["run-json"]) {
		assert(
			gate === "final" &&
				Boolean(options.contract) &&
				updatedContract?.publicationGate?.publishable === true,
			"run.json can only be marked completed after the final publication contract is publishable.",
		);
		await updateRunJson(path.resolve(String(options["run-json"])), verifiedRun, inputPath, validation);
	}
	if (gate === "final" && updatedContract) {
		assert(
			updatedContract.publicationGate?.publishable === true,
			"Final media passed decode checks but the Recordly publication gate is not publishable.",
		);
	}

	console.log(
		JSON.stringify(
			{
				status: validation.status,
				input: inputPath,
				sidecar: sidecarPath,
				sha256: validation.sha256,
				durationSeconds,
				video: validation.video,
				audio: validation.audio,
				avDurationDeltaSeconds,
				avStartDeltaSeconds,
				timeline,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
});
