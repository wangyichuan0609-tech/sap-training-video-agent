#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(scriptDirectory);
const FRAME_RATE = 30;
const FRAME_MS = 1_000 / FRAME_RATE;
const MEDIA_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const LEGACY_ACTION_LOG_SCHEMA_VERSION = 1;
const ACTION_LOG_SCHEMA_VERSION = 2;
const MIXED_ACTION_LOG_SCHEMA_VERSION = 3;
const ACTION_LOG_SOURCE_CLOCK = "capture-session-monotonic";
const LEGACY_ACTION_LOG_SOURCE = "Recordly built-in SAP Browser DOM collector";
const ACTION_LOG_SOURCE =
	"Recordly built-in SAP Browser CDP isolated-world collector";
const MIXED_ACTION_LOG_SOURCE =
	"Recordly deterministic mixed-provenance capture assembly";
const ASSEMBLY_PROVENANCE_FIELD = "assemblyProvenance";
const ACTION_EVENT_TYPES = new Set([
	"click",
	"tab-switch",
	"input",
	"change",
	"focus",
	"keydown",
	"keyup",
	"navigation",
]);
const OUTPUT_NAMES = [
	"raw-master.mp4",
	"action-log.json",
	"raw-master.mp4.cursor.json",
	"recording-diagnostics.json",
];

function fail(message) {
	throw new Error(message);
}

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

async function readJson(filePath) {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		throw new Error(
			`Cannot read JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function writeJson(filePath, value) {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256File(filePath) {
	const hash = createHash("sha256");
	hash.update(await readFile(filePath));
	return hash.digest("hex").toUpperCase();
}

function sha256Text(value) {
	return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function isSha256(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value);
}

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function roundMilliseconds(value) {
	return Math.round(value * 1_000) / 1_000;
}

function parseRate(value) {
	if (typeof value !== "string") return null;
	const [numerator, denominator] = value.split("/").map(Number);
	if (
		!Number.isFinite(numerator) ||
		!Number.isFinite(denominator) ||
		denominator === 0
	)
		return null;
	return numerator / denominator;
}

function runCommand(command, args, label) {
	const result = spawnSync(command, args, {
		cwd: workspaceRoot,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
		timeout: MEDIA_TIMEOUT_MS,
	});
	if (result.error) throw new Error(`${label}: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = [result.stderr, result.stdout]
			.filter(Boolean)
			.join("\n")
			.trim();
		throw new Error(
			`${label} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`,
		);
	}
	return result.stdout;
}

function resolveStaticBinary(moduleName) {
	try {
		const recordlyRequire = createRequire(
			path.join(workspaceRoot, "recordly", "package.json"),
		);
		const loaded = recordlyRequire(moduleName);
		const candidate =
			typeof loaded === "string"
				? loaded
				: typeof loaded?.path === "string"
					? loaded.path
					: typeof loaded?.default === "string"
						? loaded.default
						: typeof loaded?.default?.path === "string"
							? loaded.default.path
							: null;
		return candidate && existsSync(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

function resolveMediaTools(options) {
	const ffmpeg = String(
		options.ffmpeg ||
			process.env.RECORDLY_FFMPEG_EXE ||
			resolveStaticBinary("ffmpeg-static") ||
			"ffmpeg",
	);
	const ffprobe = String(
		options.ffprobe ||
			process.env.RECORDLY_FFPROBE_EXE ||
			resolveStaticBinary("ffprobe-static") ||
			"ffprobe",
	);
	return { ffmpeg, ffprobe };
}

function probeMedia(ffprobe, filePath) {
	const stdout = runCommand(
		ffprobe,
		[
			"-v",
			"error",
			"-show_entries",
			"stream=index,codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,duration:format=duration",
			"-of",
			"json",
			filePath,
		],
		`ffprobe ${filePath}`,
	);
	const payload = JSON.parse(stdout);
	const streams = Array.isArray(payload.streams) ? payload.streams : [];
	const videos = streams.filter((stream) => stream.codec_type === "video");
	const audioStreamCount = streams.filter(
		(stream) => stream.codec_type === "audio",
	).length;
	if (videos.length !== 1)
		fail(`${filePath} must contain exactly one video stream.`);
	const video = videos[0];
	const durationSeconds = Number(payload.format?.duration ?? video.duration);
	const frameRate =
		parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
	const probe = {
		codec: video.codec_name ?? null,
		pixelFormat: video.pix_fmt ?? null,
		width: Number(video.width),
		height: Number(video.height),
		frameRate,
		durationMs: roundMilliseconds(durationSeconds * 1_000),
		audioStreamCount,
	};
	if (probe.codec !== "h264")
		fail(
			`${filePath} codec must be H.264, received ${probe.codec || "unknown"}.`,
		);
	if (probe.pixelFormat !== "yuv420p") {
		fail(
			`${filePath} pixel format must be yuv420p, received ${probe.pixelFormat || "unknown"}.`,
		);
	}
	if (probe.width !== 1920 || probe.height !== 1080) {
		fail(
			`${filePath} must be 1920x1080, received ${probe.width}x${probe.height}.`,
		);
	}
	if (
		!finiteNumber(probe.frameRate) ||
		Math.abs(probe.frameRate - FRAME_RATE) > 0.02
	) {
		fail(
			`${filePath} must be CFR 30 fps, received ${probe.frameRate || "unknown"}.`,
		);
	}
	if (!finiteNumber(probe.durationMs) || probe.durationMs <= 0)
		fail(`${filePath} has no valid duration.`);
	if (audioStreamCount !== 0) fail(`${filePath} must be video-only.`);
	return probe;
}

function declaredArtifact(value, fallbackPath) {
	if (typeof value === "string" && value.trim())
		return { path: value, sha256: null };
	if (
		value &&
		typeof value === "object" &&
		typeof value.path === "string" &&
		value.path.trim()
	) {
		return { path: value.path, sha256: value.sha256 ?? null };
	}
	return fallbackPath ? { path: fallbackPath, sha256: null } : null;
}

function normalizeArtifact(
	baseDirectory,
	value,
	fallbackPath,
	label,
	required = true,
	alternativeBaseDirectory = null,
) {
	const declared = declaredArtifact(value, fallbackPath);
	if (!declared) {
		if (required) fail(`${label} is not declared.`);
		return null;
	}
	if (declared.sha256 !== null && !isSha256(declared.sha256))
		fail(`${label} has an invalid SHA256.`);
	const candidates = path.isAbsolute(declared.path)
		? [path.resolve(declared.path)]
		: [
				path.resolve(baseDirectory, declared.path),
				...(alternativeBaseDirectory
					? [path.resolve(alternativeBaseDirectory, declared.path)]
					: []),
			];
	return {
		path: candidates.find(existsSync) || candidates[0],
		expectedSha256: declared.sha256 ? declared.sha256.toUpperCase() : null,
	};
}

function evidenceFromDirectory(directory, index) {
	return {
		index,
		archiveDirectory: directory,
		artifacts: {
			segment: existsSync(path.join(directory, "segment.webm"))
				? { path: "segment.webm" }
				: null,
			rawMaster: { path: "raw-master.mp4" },
			actionLog: { path: "action-log.json" },
			cursor: { path: "raw-master.mp4.cursor.json" },
			diagnostics: { path: "recording-diagnostics.json" },
		},
	};
}

async function loadAssemblyInput(options, positional) {
	const allowedOptions = new Set([
		"manifest",
		"output-dir",
		"ffmpeg",
		"ffprobe",
	]);
	const unsupported = Object.keys(options).filter(
		(key) => !allowedOptions.has(key),
	);
	if (unsupported.length > 0)
		fail(
			`Unsupported option(s): ${unsupported.map((key) => `--${key}`).join(", ")}`,
		);
	if (options.manifest) {
		if (positional.length > 0)
			fail("Do not combine --manifest with positional inputs.");
		const manifestPath = path.resolve(String(options.manifest));
		const manifest = await readJson(manifestPath);
		if (!Array.isArray(manifest.segments))
			fail("Assembly manifest must contain a segments array.");
		const baseDirectory = manifest.baseDirectory
			? path.resolve(path.dirname(manifestPath), String(manifest.baseDirectory))
			: path.dirname(manifestPath);
		const outputDirectory = options["output-dir"] || manifest.outputDirectory;
		if (!outputDirectory)
			fail("Assembly manifest requires outputDirectory or --output-dir.");
		return {
			baseDirectory,
			outputDirectory: path.resolve(baseDirectory, String(outputDirectory)),
			segments: manifest.segments,
			runtimeRecoveryBoundaries: manifest.runtimeRecoveryBoundaries ?? null,
			source: manifestPath,
		};
	}

	if (positional.length === 1) {
		const inputPath = path.resolve(positional[0]);
		const inputStat = await stat(inputPath);
		const runJsonPath = inputStat.isDirectory()
			? path.join(inputPath, "run.json")
			: inputPath;
		if (
			existsSync(runJsonPath) &&
			path.basename(runJsonPath).toLowerCase() === "run.json"
		) {
			const run = await readJson(runJsonPath);
			if (!Array.isArray(run.capture?.segmentEvidence)) {
				fail(`${runJsonPath} has no capture.segmentEvidence array.`);
			}
			const runDirectory = path.dirname(runJsonPath);
			return {
				baseDirectory: runDirectory,
				outputDirectory: path.resolve(
					runDirectory,
					String(options["output-dir"] || "capture"),
				),
				segments: run.capture.segmentEvidence,
				runtimeRecoveryBoundaries:
					run.capture.runtimeRecoveryBoundaries ?? null,
				source: runJsonPath,
			};
		}
	}

	if (positional.length < 2) {
		fail(
			"Usage: node scripts/assemble-recordly-capture.mjs <run-directory-or-run.json> | --manifest=<manifest.json> | <segment-dir-1> <segment-dir-2> [--output-dir=<capture>]",
		);
	}
	const directories = positional.map((value) => path.resolve(value));
	for (const directory of directories) {
		if (!(await stat(directory)).isDirectory())
			fail(`Segment evidence path is not a directory: ${directory}`);
	}
	const commonParent = path.dirname(directories[0]);
	if (
		!directories.every((directory) => path.dirname(directory) === commonParent)
	) {
		fail("Ordered segment directories must share one parent directory.");
	}
	const inferredOutput =
		path.basename(commonParent).toLowerCase() === "segments"
			? path.dirname(commonParent)
			: null;
	if (!options["output-dir"] && !inferredOutput)
		fail("Segment directory mode requires --output-dir.");
	return {
		baseDirectory: process.cwd(),
		outputDirectory: path.resolve(
			String(options["output-dir"] || inferredOutput),
		),
		segments: directories.map((directory, index) =>
			evidenceFromDirectory(directory, index + 1),
		),
		runtimeRecoveryBoundaries: null,
		source: "ordered-segment-directories",
	};
}

async function normalizeSegment(baseDirectory, evidence, position) {
	if (!evidence || typeof evidence !== "object")
		fail(`Segment ${position + 1} evidence must be an object.`);
	const index = evidence.index ?? position + 1;
	if (!Number.isInteger(index) || index < 1)
		fail(`Segment ${position + 1} has an invalid index.`);
	const archiveDirectory = evidence.archiveDirectory
		? path.resolve(baseDirectory, String(evidence.archiveDirectory))
		: baseDirectory;
	const artifacts = evidence.artifacts || evidence;
	const segment = normalizeArtifact(
		baseDirectory,
		artifacts.segment,
		existsSync(path.join(archiveDirectory, "segment.webm"))
			? "segment.webm"
			: null,
		`Segment ${index} WebM`,
		false,
		archiveDirectory,
	);
	return {
		index,
		declaredSessionId: evidence.sessionId ?? null,
		declaredSourceWebContentsId: evidence.sourceWebContentsId ?? null,
		hasRuntimeEpoch: Object.hasOwn(evidence, "runtimeEpoch"),
		runtimeEpoch: evidence.runtimeEpoch,
		archiveDirectory,
		artifacts: {
			segment,
			rawMaster: normalizeArtifact(
				baseDirectory,
				artifacts.rawMaster,
				"raw-master.mp4",
				`Segment ${index} Raw Master`,
				true,
				archiveDirectory,
			),
			actionLog: normalizeArtifact(
				baseDirectory,
				artifacts.actionLog,
				"action-log.json",
				`Segment ${index} action log`,
				true,
				archiveDirectory,
			),
			cursor: normalizeArtifact(
				baseDirectory,
				artifacts.cursor,
				"raw-master.mp4.cursor.json",
				`Segment ${index} cursor sidecar`,
				true,
				archiveDirectory,
			),
			diagnostics: normalizeArtifact(
				baseDirectory,
				artifacts.diagnostics,
				"recording-diagnostics.json",
				`Segment ${index} diagnostics`,
				true,
				archiveDirectory,
			),
		},
	};
}

async function validateArtifact(artifact, label) {
	if (!artifact) return null;
	const fileStat = await stat(artifact.path);
	if (!fileStat.isFile() || fileStat.size <= 0)
		fail(`${label} is missing or empty: ${artifact.path}`);
	const sha256 = await sha256File(artifact.path);
	if (artifact.expectedSha256 && artifact.expectedSha256 !== sha256) {
		fail(
			`${label} SHA256 mismatch: expected ${artifact.expectedSha256}, received ${sha256}.`,
		);
	}
	return { ...artifact, sha256, bytes: fileStat.size };
}

function plainObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function visibleString(value, label, maximumLength) {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > maximumLength ||
		/[\u0000-\u001f\u007f]/u.test(value)
	) {
		fail(`${label} must contain 1-${maximumLength} visible characters.`);
	}
	return value;
}

function strictHttpOrigin(value, label) {
	const text = visibleString(value, label, 4_096);
	let parsed;
	try {
		parsed = new URL(text);
	} catch {
		fail(`${label} must be a valid HTTP(S) origin.`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		fail(`${label} must be an HTTP(S) origin.`);
	}
	if (
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		text !== parsed.origin
	) {
		fail(
			`${label} must be a sanitized origin without credentials, path, query, or hash.`,
		);
	}
	return parsed.origin;
}

function validateViewport(viewport, label) {
	if (!plainObject(viewport)) fail(`${label} must be an object.`);
	for (const [key, minimum] of [
		["width", 1],
		["height", 1],
		["devicePixelRatio", 0.1],
		["scrollX", 0],
		["scrollY", 0],
	]) {
		if (!finiteNumber(viewport[key]) || viewport[key] < minimum) {
			fail(`${label}.${key} must be a finite number >= ${minimum}.`);
		}
	}
	return viewport;
}

function validateCaptureGeometry(segment, captureGeometry) {
	if (!plainObject(captureGeometry)) {
		fail(`Segment ${segment.index} action log has no valid captureGeometry.`);
	}
	const viewport = validateViewport(
		captureGeometry.viewport,
		`Segment ${segment.index} captureGeometry.viewport`,
	);
	const contentRect = captureGeometry.contentRect;
	if (!plainObject(contentRect)) {
		fail(
			`Segment ${segment.index} captureGeometry.contentRect must be an object.`,
		);
	}
	for (const [key, minimum] of [
		["x", 0],
		["y", 0],
		["width", 0.01],
		["height", 0.01],
	]) {
		if (!finiteNumber(contentRect[key]) || contentRect[key] < minimum) {
			fail(
				`Segment ${segment.index} captureGeometry.contentRect.${key} must be a finite number >= ${minimum}.`,
			);
		}
	}
	if (
		contentRect.x + contentRect.width > 1_920 + 2 ||
		contentRect.y + contentRect.height > 1_080 + 2
	) {
		fail(`Segment ${segment.index} captureGeometry exceeds the Raw Master.`);
	}
	return { viewport, contentRect };
}

function validateTargetGeometry(segment, event, captureViewport) {
	if (event.viewport !== undefined) {
		const viewport = validateViewport(
			event.viewport,
			`Segment ${segment.index} event ${event.eventId} viewport`,
		);
		if (
			viewport.width !== captureViewport.width ||
			viewport.height !== captureViewport.height ||
			viewport.devicePixelRatio !== captureViewport.devicePixelRatio
		) {
			fail(
				`Segment ${segment.index} event ${event.eventId} viewport does not match captureGeometry.`,
			);
		}
	}
	if (event.target === undefined) return;
	if (!plainObject(event.target)) {
		fail(
			`Segment ${segment.index} event ${event.eventId} target must be an object.`,
		);
	}
	const { rect, point, normalizedPoint } = event.target;
	if (
		!plainObject(rect) ||
		!plainObject(point) ||
		!plainObject(normalizedPoint)
	) {
		fail(
			`Segment ${segment.index} event ${event.eventId} target geometry is incomplete.`,
		);
	}
	for (const [label, value, minimum] of [
		["rect.x", rect.x, 0],
		["rect.y", rect.y, 0],
		["rect.width", rect.width, 0.01],
		["rect.height", rect.height, 0.01],
		["point.x", point.x, 0],
		["point.y", point.y, 0],
		["normalizedPoint.x", normalizedPoint.x, 0],
		["normalizedPoint.y", normalizedPoint.y, 0],
	]) {
		if (!finiteNumber(value) || value < minimum) {
			fail(
				`Segment ${segment.index} event ${event.eventId} target.${label} is invalid.`,
			);
		}
	}
	if (normalizedPoint.x > 1 || normalizedPoint.y > 1) {
		fail(
			`Segment ${segment.index} event ${event.eventId} normalized target is outside the viewport.`,
		);
	}
	const viewport = event.viewport ?? captureViewport;
	if (
		rect.x + rect.width > viewport.width + 2 ||
		rect.y + rect.height > viewport.height + 2 ||
		point.x > viewport.width ||
		point.y > viewport.height
	) {
		fail(
			`Segment ${segment.index} event ${event.eventId} target is outside the declared viewport.`,
		);
	}
}

function validateVersionTwoFrameIdentity(segment, actionLog, event) {
	if (event.frame === undefined) {
		if (event.documentId !== undefined) {
			fail(
				`Segment ${segment.index} event ${event.eventId} has a documentId without trusted frame identity.`,
			);
		}
		if (
			event.type !== "navigation" ||
			!event.eventId.startsWith(`${actionLog.sessionId}:main-navigation:`)
		) {
			fail(
				`Segment ${segment.index} schema v2 event ${event.eventId} has no trusted frame identity.`,
			);
		}
		if (event.url !== undefined) {
			strictHttpOrigin(
				event.url,
				`Segment ${segment.index} event ${event.eventId} URL`,
			);
		}
		return null;
	}
	if (!plainObject(event.frame)) {
		fail(
			`Segment ${segment.index} event ${event.eventId} frame must be an object.`,
		);
	}
	const frameId = visibleString(
		event.frame.frameId,
		`Segment ${segment.index} event ${event.eventId} frameId`,
		240,
	);
	const parentFrameId =
		event.frame.parentFrameId === undefined
			? null
			: visibleString(
					event.frame.parentFrameId,
					`Segment ${segment.index} event ${event.eventId} parentFrameId`,
					240,
				);
	if (frameId === parentFrameId) {
		fail(
			`Segment ${segment.index} event ${event.eventId} frame cannot parent itself.`,
		);
	}
	if (typeof event.frame.isMainFrame !== "boolean") {
		fail(
			`Segment ${segment.index} event ${event.eventId} frame.isMainFrame must be boolean.`,
		);
	}
	if (event.frame.isMainFrame === Boolean(parentFrameId)) {
		fail(
			`Segment ${segment.index} event ${event.eventId} parent identity conflicts with isMainFrame.`,
		);
	}
	const origin = strictHttpOrigin(
		event.frame.origin,
		`Segment ${segment.index} event ${event.eventId} frame origin`,
	);
	const url = strictHttpOrigin(
		event.url,
		`Segment ${segment.index} event ${event.eventId} URL`,
	);
	if (url !== origin) {
		fail(
			`Segment ${segment.index} event ${event.eventId} URL does not match its trusted frame origin.`,
		);
	}
	const documentId = visibleString(
		event.documentId,
		`Segment ${segment.index} event ${event.eventId} documentId`,
		160,
	);
	return {
		documentId,
		frame: {
			frameId,
			...(parentFrameId ? { parentFrameId } : {}),
			origin,
			isMainFrame: event.frame.isMainFrame,
		},
	};
}

function validateTimeline(segment, actionLog, durationMs) {
	if (
		!actionLog ||
		typeof actionLog !== "object" ||
		!Array.isArray(actionLog.timeline)
	) {
		fail(`Segment ${segment.index} action log must contain a timeline array.`);
	}
	if (
		actionLog.schemaVersion !== LEGACY_ACTION_LOG_SCHEMA_VERSION &&
		actionLog.schemaVersion !== ACTION_LOG_SCHEMA_VERSION
	) {
		fail(
			`Segment ${segment.index} action log schemaVersion must be ${LEGACY_ACTION_LOG_SCHEMA_VERSION} or ${ACTION_LOG_SCHEMA_VERSION}.`,
		);
	}
	const expectedSource =
		actionLog.schemaVersion === ACTION_LOG_SCHEMA_VERSION
			? ACTION_LOG_SOURCE
			: LEGACY_ACTION_LOG_SOURCE;
	if (actionLog.source !== expectedSource) {
		fail(
			`Segment ${segment.index} action log source does not match schemaVersion ${actionLog.schemaVersion}.`,
		);
	}
	if (actionLog.sourceClock !== ACTION_LOG_SOURCE_CLOCK) {
		fail(
			`Segment ${segment.index} action log sourceClock must be ${ACTION_LOG_SOURCE_CLOCK}.`,
		);
	}
	if (typeof actionLog.sessionId !== "string" || !actionLog.sessionId.trim()) {
		fail(`Segment ${segment.index} action log has no sessionId.`);
	}
	if (
		!Number.isInteger(actionLog.sourceWebContentsId) ||
		actionLog.sourceWebContentsId < 1
	) {
		fail(
			`Segment ${segment.index} action log has an invalid sourceWebContentsId.`,
		);
	}
	if (
		segment.declaredSessionId &&
		segment.declaredSessionId !== actionLog.sessionId
	) {
		fail(
			`Segment ${segment.index} sessionId does not match its evidence declaration.`,
		);
	}
	if (
		segment.declaredSourceWebContentsId !== null &&
		segment.declaredSourceWebContentsId !== actionLog.sourceWebContentsId
	) {
		fail(
			`Segment ${segment.index} sourceWebContentsId does not match its evidence declaration.`,
		);
	}
	if (
		actionLog.eventCount !== undefined &&
		actionLog.eventCount !== actionLog.timeline.length
	) {
		fail(`Segment ${segment.index} eventCount does not match its timeline.`);
	}
	const captureGeometry = validateCaptureGeometry(
		segment,
		actionLog.captureGeometry,
	);
	let previousTimeMs = -1;
	const eventIds = new Set();
	const documentFrames = new Map();
	for (
		let eventIndex = 0;
		eventIndex < actionLog.timeline.length;
		eventIndex += 1
	) {
		const event = actionLog.timeline[eventIndex];
		if (!event || typeof event !== "object")
			fail(`Segment ${segment.index} event ${eventIndex + 1} is invalid.`);
		if (Object.hasOwn(event, ASSEMBLY_PROVENANCE_FIELD)) {
			fail(
				`Segment ${segment.index} event ${event.eventId || eventIndex + 1} uses reserved field ${ASSEMBLY_PROVENANCE_FIELD}.`,
			);
		}
		if (typeof event.eventId !== "string" || !event.eventId.trim()) {
			fail(`Segment ${segment.index} event ${eventIndex + 1} has no eventId.`);
		}
		if (!event.eventId.startsWith(`${actionLog.sessionId}:`)) {
			fail(
				`Segment ${segment.index} event ${event.eventId} is not scoped to its capture session.`,
			);
		}
		if (!ACTION_EVENT_TYPES.has(event.type)) {
			fail(
				`Segment ${segment.index} event ${event.eventId} has unsupported type ${String(event.type)}.`,
			);
		}
		if (eventIds.has(event.eventId))
			fail(`Segment ${segment.index} has duplicate eventId ${event.eventId}.`);
		eventIds.add(event.eventId);
		if (!finiteNumber(event.sourceTimeMs) || event.sourceTimeMs < 0) {
			fail(
				`Segment ${segment.index} event ${event.eventId} has an invalid sourceTimeMs.`,
			);
		}
		if (event.sourceTimeMs < previousTimeMs) {
			fail(
				`Segment ${segment.index} events are not monotonic at ${event.eventId}.`,
			);
		}
		if (event.sourceTimeMs > durationMs + FRAME_MS * 2) {
			fail(
				`Segment ${segment.index} event ${event.eventId} is after its Raw Master duration.`,
			);
		}
		validateTargetGeometry(segment, event, captureGeometry.viewport);
		if (actionLog.schemaVersion === ACTION_LOG_SCHEMA_VERSION) {
			const identity = validateVersionTwoFrameIdentity(
				segment,
				actionLog,
				event,
			);
			if (identity) {
				const frameKey = canonicalJson(identity.frame);
				const previousFrameKey = documentFrames.get(identity.documentId);
				if (previousFrameKey && previousFrameKey !== frameKey) {
					fail(
						`Segment ${segment.index} document ${identity.documentId} changes trusted frame identity.`,
					);
				}
				documentFrames.set(identity.documentId, frameKey);
			}
		} else if (event.frame !== undefined || event.documentId !== undefined) {
			fail(
				`Segment ${segment.index} schema v1 event ${event.eventId} contains unsupported frame identity.`,
			);
		}
		previousTimeMs = event.sourceTimeMs;
	}
	return {
		sessionId: actionLog.sessionId,
		sourceWebContentsId: actionLog.sourceWebContentsId,
		schemaVersion: actionLog.schemaVersion,
		source: actionLog.source,
		documentFrames,
	};
}

function validateCursor(segment, cursor, actionLog, durationMs) {
	if (!cursor || typeof cursor !== "object" || !Array.isArray(cursor.samples)) {
		fail(
			`Segment ${segment.index} cursor sidecar must contain a samples array.`,
		);
	}
	if (cursor.version !== 3 || cursor.mode !== "browser-action-timeline") {
		fail(
			`Segment ${segment.index} cursor sidecar must use version 3 browser-action-timeline mode.`,
		);
	}
	if (cursor.sourceClock !== ACTION_LOG_SOURCE_CLOCK) {
		fail(
			`Segment ${segment.index} cursor sourceClock must be ${ACTION_LOG_SOURCE_CLOCK}.`,
		);
	}
	if (cursor.sourceClock !== actionLog.sourceClock) {
		fail(
			`Segment ${segment.index} cursor sourceClock does not match its action log.`,
		);
	}
	let previousTimeMs = -1;
	for (
		let sampleIndex = 0;
		sampleIndex < cursor.samples.length;
		sampleIndex += 1
	) {
		const sample = cursor.samples[sampleIndex];
		if (
			!sample ||
			typeof sample !== "object" ||
			!finiteNumber(sample.timeMs) ||
			!finiteNumber(sample.cx) ||
			!finiteNumber(sample.cy)
		) {
			fail(
				`Segment ${segment.index} cursor sample ${sampleIndex + 1} is invalid.`,
			);
		}
		if (sample.timeMs < previousTimeMs) {
			fail(`Segment ${segment.index} cursor samples are not monotonic.`);
		}
		if (sample.timeMs < 0 || sample.timeMs > durationMs + FRAME_MS * 2) {
			fail(
				`Segment ${segment.index} cursor sample ${sampleIndex + 1} is outside its Raw Master.`,
			);
		}
		if (sample.cx < 0 || sample.cx > 1 || sample.cy < 0 || sample.cy > 1) {
			fail(
				`Segment ${segment.index} cursor sample ${sampleIndex + 1} is outside normalized coordinates.`,
			);
		}
		previousTimeMs = sample.timeMs;
	}
}

function validateDiagnostics(segment, diagnostics, binding) {
	if (!diagnostics || typeof diagnostics !== "object")
		fail(`Segment ${segment.index} diagnostics are invalid.`);
	const records = [diagnostics.status, diagnostics.completed].filter(
		(value) =>
			value &&
			typeof value === "object" &&
			(value.sessionId || value.sourceWebContentsId),
	);
	if (records.length === 0)
		fail(`Segment ${segment.index} diagnostics contain no capture binding.`);
	for (const record of records) {
		if (record.sessionId !== binding.sessionId) {
			fail(
				`Segment ${segment.index} diagnostics sessionId does not match its action log.`,
			);
		}
		if (record.sourceWebContentsId !== binding.sourceWebContentsId) {
			fail(
				`Segment ${segment.index} diagnostics sourceWebContentsId does not match its action log.`,
			);
		}
	}
	if (!diagnostics.completed)
		fail(
			`Segment ${segment.index} diagnostics do not contain a completed capture.`,
		);
}

async function inspectSegment(segment, tools) {
	const validatedArtifacts = {};
	for (const [name, artifact] of Object.entries(segment.artifacts)) {
		validatedArtifacts[name] = await validateArtifact(
			artifact,
			`Segment ${segment.index} ${name}`,
		);
	}
	const probe = probeMedia(tools.ffprobe, validatedArtifacts.rawMaster.path);
	const [actionLog, cursor, diagnostics] = await Promise.all([
		readJson(validatedArtifacts.actionLog.path),
		readJson(validatedArtifacts.cursor.path),
		readJson(validatedArtifacts.diagnostics.path),
	]);
	const binding = validateTimeline(segment, actionLog, probe.durationMs);
	validateCursor(segment, cursor, actionLog, probe.durationMs);
	validateDiagnostics(segment, diagnostics, binding);
	return {
		...segment,
		artifacts: validatedArtifacts,
		probe,
		actionLog,
		cursor,
		diagnostics,
		...binding,
	};
}

function validateRuntimeRecoveryProvenance(
	segments,
	declaredRecoveryBoundaries,
) {
	const runtimeEpochCount = segments.filter(
		(segment) => segment.hasRuntimeEpoch,
	).length;
	if (runtimeEpochCount === 0) {
		if (
			declaredRecoveryBoundaries !== null &&
			declaredRecoveryBoundaries !== undefined &&
			(!Array.isArray(declaredRecoveryBoundaries) ||
				declaredRecoveryBoundaries.length > 0)
		) {
			fail(
				"runtimeRecoveryBoundaries require every segment to declare runtimeEpoch.",
			);
		}
		return null;
	}
	if (runtimeEpochCount !== segments.length) {
		fail(
			"runtimeEpoch is opt-in for the whole assembly; every segment must declare it.",
		);
	}
	for (const segment of segments) {
		if (!Number.isInteger(segment.runtimeEpoch) || segment.runtimeEpoch < 1) {
			fail(`Segment ${segment.index} runtimeEpoch must be a positive integer.`);
		}
	}

	const epochRecords = new Map();
	const transitions = [];
	for (let position = 0; position < segments.length; position += 1) {
		const segment = segments[position];
		let epochRecord = epochRecords.get(segment.runtimeEpoch);
		if (!epochRecord) {
			epochRecord = {
				runtimeEpoch: segment.runtimeEpoch,
				sourceWebContentsId: segment.sourceWebContentsId,
				segmentIndices: [],
			};
			epochRecords.set(segment.runtimeEpoch, epochRecord);
		} else if (
			epochRecord.sourceWebContentsId !== segment.sourceWebContentsId
		) {
			fail(
				`runtimeEpoch ${segment.runtimeEpoch} contains multiple sourceWebContentsId values.`,
			);
		}
		epochRecord.segmentIndices.push(segment.index);
		if (position === 0) continue;
		const previous = segments[position - 1];
		if (segment.runtimeEpoch < previous.runtimeEpoch) {
			fail("runtimeEpoch values must be monotonic in assembly order.");
		}
		if (segment.runtimeEpoch === previous.runtimeEpoch) continue;
		if (segment.runtimeEpoch !== previous.runtimeEpoch + 1) {
			fail(
				`runtimeEpoch transition ${previous.runtimeEpoch} -> ${segment.runtimeEpoch} skips an epoch.`,
			);
		}
		transitions.push({
			sequence: transitions.length + 1,
			afterSegmentIndex: previous.index,
			beforeSegmentIndex: segment.index,
			fromRuntimeEpoch: previous.runtimeEpoch,
			toRuntimeEpoch: segment.runtimeEpoch,
		});
	}

	if (
		declaredRecoveryBoundaries !== null &&
		declaredRecoveryBoundaries !== undefined &&
		!Array.isArray(declaredRecoveryBoundaries)
	) {
		fail("runtimeRecoveryBoundaries must be an array.");
	}
	const boundaries = declaredRecoveryBoundaries ?? [];
	if (boundaries.length !== transitions.length) {
		fail(
			`runtimeRecoveryBoundaries must contain exactly ${transitions.length} ordered record(s) for the declared runtimeEpoch transitions.`,
		);
	}
	const allowedBoundaryFields = new Set([
		"sequence",
		"kind",
		"afterSegmentIndex",
		"beforeSegmentIndex",
		"fromRuntimeEpoch",
		"toRuntimeEpoch",
	]);
	const normalizedBoundaries = boundaries.map((boundary, position) => {
		if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) {
			fail(`runtimeRecoveryBoundaries[${position}] must be an object.`);
		}
		const unknownFields = Object.keys(boundary).filter(
			(key) => !allowedBoundaryFields.has(key),
		);
		if (unknownFields.length > 0) {
			fail(
				`runtimeRecoveryBoundaries[${position}] has unsupported field(s): ${unknownFields.join(", ")}.`,
			);
		}
		const expected = transitions[position];
		const normalized = {
			sequence: boundary.sequence,
			kind: boundary.kind,
			afterSegmentIndex: boundary.afterSegmentIndex,
			beforeSegmentIndex: boundary.beforeSegmentIndex,
			fromRuntimeEpoch: boundary.fromRuntimeEpoch,
			toRuntimeEpoch: boundary.toRuntimeEpoch,
		};
		if (
			normalized.sequence !== expected.sequence ||
			normalized.kind !== "recordly-runtime-restart" ||
			normalized.afterSegmentIndex !== expected.afterSegmentIndex ||
			normalized.beforeSegmentIndex !== expected.beforeSegmentIndex ||
			normalized.fromRuntimeEpoch !== expected.fromRuntimeEpoch ||
			normalized.toRuntimeEpoch !== expected.toRuntimeEpoch
		) {
			fail(
				`runtimeRecoveryBoundaries[${position}] does not match ordered runtime transition ${expected.fromRuntimeEpoch} -> ${expected.toRuntimeEpoch} between segments ${expected.afterSegmentIndex} and ${expected.beforeSegmentIndex}.`,
			);
		}
		return normalized;
	});

	const instances = [...epochRecords.values()].map((record) => ({
		instanceKey: `runtime-epoch:${record.runtimeEpoch}:web-contents:${record.sourceWebContentsId}`,
		...record,
	}));
	const instanceByEpoch = new Map(
		instances.map((instance) => [instance.runtimeEpoch, instance]),
	);
	return {
		contractVersion: 1,
		mode: "explicit-runtime-epochs",
		instanceKeyFields: ["runtimeEpoch", "sourceWebContentsId"],
		instances,
		recoveryBoundaries: normalizedBoundaries.map((boundary) => ({
			...boundary,
			fromRuntimeInstanceKey: instanceByEpoch.get(boundary.fromRuntimeEpoch)
				.instanceKey,
			toRuntimeInstanceKey: instanceByEpoch.get(boundary.toRuntimeEpoch)
				.instanceKey,
		})),
	};
}

function sourceBindingFields(binding) {
	if (!binding.runtimeProvenance) {
		return { sourceWebContentsId: binding.sourceWebContentsId };
	}
	return {
		sourceWebContentsId: binding.sourceWebContentsId,
		sourceRuntimeInstances: binding.runtimeProvenance.instances,
	};
}

function validateSegments(segments, declaredRecoveryBoundaries) {
	if (segments.length < 2)
		fail(
			"At least two completed segment evidence entries are required for assembly.",
		);
	const indices = new Set();
	const sessions = new Set();
	const rawMasterHashes = new Set();
	const eventIds = new Set();
	const documentFrames = new Map();
	const geometry = canonicalJson(segments[0].actionLog.captureGeometry ?? null);
	const sourceClock = segments[0].actionLog.sourceClock;
	const cursorMode = segments[0].cursor.mode ?? null;
	const cursorVersion = segments[0].cursor.version ?? null;
	for (let position = 0; position < segments.length; position += 1) {
		const segment = segments[position];
		if (
			indices.has(segment.index) ||
			(position > 0 && segment.index <= segments[position - 1].index)
		) {
			fail(
				"Segment evidence indices must be unique and strictly increasing in assembly order.",
			);
		}
		indices.add(segment.index);
		if (sessions.has(segment.sessionId))
			fail(
				`Capture session ${segment.sessionId} is repeated; refusing replay.`,
			);
		sessions.add(segment.sessionId);
		if (rawMasterHashes.has(segment.artifacts.rawMaster.sha256)) {
			fail(
				`Segment ${segment.index} repeats an existing Raw Master; refusing replay.`,
			);
		}
		rawMasterHashes.add(segment.artifacts.rawMaster.sha256);
		if (canonicalJson(segment.actionLog.captureGeometry ?? null) !== geometry) {
			fail("All segments must use the same captureGeometry.");
		}
		if (segment.actionLog.sourceClock !== sourceClock)
			fail("All action logs must use the same sourceClock.");
		if (
			(segment.cursor.mode ?? null) !== cursorMode ||
			(segment.cursor.version ?? null) !== cursorVersion
		) {
			fail("All cursor sidecars must use the same version and mode.");
		}
		for (const event of segment.actionLog.timeline) {
			if (eventIds.has(event.eventId))
				fail(`Duplicate eventId across segments: ${event.eventId}.`);
			eventIds.add(event.eventId);
		}
	}
	const runtimeProvenance = validateRuntimeRecoveryProvenance(
		segments,
		declaredRecoveryBoundaries,
	);
	const sourceWebContentsId = runtimeProvenance
		? runtimeProvenance.instances.length === 1
			? runtimeProvenance.instances[0].sourceWebContentsId
			: null
		: segments[0].sourceWebContentsId;
	if (!runtimeProvenance) {
		for (const segment of segments) {
			if (segment.sourceWebContentsId !== sourceWebContentsId) {
				fail(
					"All segments must remain bound to the same SAP sourceWebContentsId.",
				);
			}
		}
	}
	for (const segment of segments) {
		for (const [documentId, frameKey] of segment.documentFrames) {
			const scopedDocumentId = runtimeProvenance
				? `${segment.runtimeEpoch}:${documentId}`
				: documentId;
			const previousFrameKey = documentFrames.get(scopedDocumentId);
			if (previousFrameKey && previousFrameKey !== frameKey) {
				fail(
					runtimeProvenance
						? `Trusted document ${documentId} changes frame identity within its runtime instance.`
						: `Trusted document ${documentId} changes frame identity across segments.`,
				);
			}
			documentFrames.set(scopedDocumentId, frameKey);
		}
	}
	return {
		sourceWebContentsId,
		runtimeProvenance,
		sourceClock,
		cursorMode,
		cursorVersion,
		documentFrames,
	};
}

const EVENT_TIME_KEYS_MS = [
	"sourceTimeMs",
	"sourceEndTimeMs",
	"resultStableTimeMs",
	"visibleResultTimeMs",
	"outcomeTimeMs",
	"endTimeMs",
];
const EVENT_TIME_KEYS_SECONDS = [
	"sourceTime",
	"sourceEndTime",
	"resultStableTime",
	"visibleResultTime",
	"outcomeTime",
	"endTime",
];

function offsetEvent(event, offsetMs) {
	const shifted = { ...event };
	for (const key of EVENT_TIME_KEYS_MS) {
		if (finiteNumber(shifted[key]))
			shifted[key] = roundMilliseconds(shifted[key] + offsetMs);
	}
	for (const key of EVENT_TIME_KEYS_SECONDS) {
		if (finiteNumber(shifted[key]))
			shifted[key] = roundMilliseconds(shifted[key] + offsetMs / 1_000);
	}
	return shifted;
}

function displayPath(outputDirectory, filePath) {
	return (
		path.relative(outputDirectory, filePath).replaceAll("\\", "/") ||
		path.basename(filePath)
	);
}

function createMergedDocuments(segments, binding, outputDirectory) {
	let offsetMs = 0;
	const timeline = [];
	const samples = [];
	const segmentRecords = [];
	const runtimeInstanceByEpoch = new Map(
		(binding.runtimeProvenance?.instances ?? []).map((instance) => [
			instance.runtimeEpoch,
			instance,
		]),
	);
	const recoveryBoundaryByBeforeSegment = new Map(
		(binding.runtimeProvenance?.recoveryBoundaries ?? []).map((boundary) => [
			boundary.beforeSegmentIndex,
			boundary,
		]),
	);
	const inputSchemaVersions = [
		...new Set(segments.map((segment) => segment.schemaVersion)),
	].sort((left, right) => left - right);
	const hasMixedProvenance = inputSchemaVersions.length > 1;
	for (const segment of segments) {
		const segmentOffsetMs = offsetMs;
		for (const event of segment.actionLog.timeline) {
			const shiftedEvent = offsetEvent(event, segmentOffsetMs);
			timeline.push(
				hasMixedProvenance
					? {
							...shiftedEvent,
							[ASSEMBLY_PROVENANCE_FIELD]: {
								segmentIndex: segment.index,
								sessionId: segment.sessionId,
								actionLogSchemaVersion: segment.schemaVersion,
								actionLogSource: segment.source,
								frameIdentityTrust:
									segment.schemaVersion === ACTION_LOG_SCHEMA_VERSION
										? shiftedEvent.frame
											? "trusted-cdp-v2"
											: "not-applicable-main-navigation-v2"
										: "unavailable-legacy-v1",
							},
						}
					: shiftedEvent,
			);
		}
		for (const sample of segment.cursor.samples) {
			samples.push({
				...sample,
				timeMs: Math.round(sample.timeMs + segmentOffsetMs),
			});
		}
		const artifactRecords = {};
		for (const [name, artifact] of Object.entries(segment.artifacts)) {
			if (!artifact) continue;
			artifactRecords[name] = {
				path: displayPath(outputDirectory, artifact.path),
				sha256: artifact.sha256,
				bytes: artifact.bytes,
			};
		}
		segmentRecords.push({
			index: segment.index,
			sessionId: segment.sessionId,
			sourceWebContentsId: segment.sourceWebContentsId,
			...(binding.runtimeProvenance
				? {
						runtimeEpoch: segment.runtimeEpoch,
						runtimeInstanceKey: runtimeInstanceByEpoch.get(segment.runtimeEpoch)
							.instanceKey,
						...(recoveryBoundaryByBeforeSegment.has(segment.index)
							? {
									recoveryBoundaryBefore: recoveryBoundaryByBeforeSegment.get(
										segment.index,
									).sequence,
								}
							: {}),
					}
				: {}),
			actionLogSchemaVersion: segment.schemaVersion,
			actionLogSource: segment.source,
			actionLogSourceClock: segment.actionLog.sourceClock,
			trustedDocumentCount: segment.documentFrames.size,
			sourceStartMs: roundMilliseconds(segmentOffsetMs),
			sourceEndMs: roundMilliseconds(
				segmentOffsetMs + segment.probe.durationMs,
			),
			durationMs: segment.probe.durationMs,
			probe: segment.probe,
			artifacts: artifactRecords,
		});
		offsetMs = roundMilliseconds(offsetMs + segment.probe.durationMs);
	}
	for (let index = 1; index < timeline.length; index += 1) {
		if (timeline[index].sourceTimeMs < timeline[index - 1].sourceTimeMs) {
			fail(
				`Merged event timeline is not monotonic at ${timeline[index].eventId}.`,
			);
		}
	}
	for (let index = 1; index < samples.length; index += 1) {
		if (samples[index].timeMs < samples[index - 1].timeMs)
			fail("Merged cursor timeline is not monotonic.");
	}
	if (timeline.length === 0) fail("Merged action timeline is empty.");
	if (samples.length < 2)
		fail("Merged cursor timeline must contain at least two samples.");
	const identity = {
		...sourceBindingFields(binding),
		...(binding.runtimeProvenance
			? { runtimeProvenance: binding.runtimeProvenance }
			: {}),
		segments: segmentRecords.map((segment) => ({
			index: segment.index,
			sessionId: segment.sessionId,
			...(binding.runtimeProvenance
				? {
						runtimeEpoch: segment.runtimeEpoch,
						runtimeInstanceKey: segment.runtimeInstanceKey,
						...(segment.recoveryBoundaryBefore
							? {
									recoveryBoundaryBefore: segment.recoveryBoundaryBefore,
								}
							: {}),
					}
				: {}),
			actionLogSchemaVersion: segment.actionLogSchemaVersion,
			actionLogSource: segment.actionLogSource,
			actionLogSourceClock: segment.actionLogSourceClock,
			durationMs: segment.durationMs,
			rawMasterSha256: segment.artifacts.rawMaster.sha256,
			actionLogSha256: segment.artifacts.actionLog.sha256,
			cursorSha256: segment.artifacts.cursor.sha256,
			diagnosticsSha256: segment.artifacts.diagnostics.sha256,
		})),
	};
	const assemblySha256 = sha256Text(canonicalJson(identity));
	const assemblyId = `recordly-assembly:${assemblySha256}`;
	const assembly = {
		version: binding.runtimeProvenance ? 3 : 2,
		assemblyId,
		segmentCount: segments.length,
		provenanceMode: hasMixedProvenance ? "mixed-per-event" : "uniform",
		inputActionLogSchemaVersions: inputSchemaVersions,
		legacyInputSegmentCount: segments.filter(
			(segment) => segment.schemaVersion === LEGACY_ACTION_LOG_SCHEMA_VERSION,
		).length,
		trustedDocumentCount: binding.documentFrames.size,
		totalDurationMs: offsetMs,
		sourceSessions: segments.map((segment) => segment.sessionId),
		...(binding.runtimeProvenance
			? { runtimeProvenance: binding.runtimeProvenance }
			: {}),
		segments: segmentRecords,
	};
	const outputSchemaVersion = hasMixedProvenance
		? MIXED_ACTION_LOG_SCHEMA_VERSION
		: segments[0].schemaVersion;
	const outputSource = hasMixedProvenance
		? MIXED_ACTION_LOG_SOURCE
		: segments[0].source;
	const actionLog = {
		schemaVersion: outputSchemaVersion,
		source: outputSource,
		sourceClock: ACTION_LOG_SOURCE_CLOCK,
		sessionId: assemblyId,
		sourceSessionIds: assembly.sourceSessions,
		...sourceBindingFields(binding),
		...(binding.runtimeProvenance
			? { runtimeProvenance: binding.runtimeProvenance }
			: {}),
		eventCount: timeline.length,
		timeline,
		...(segments[0].actionLog.captureGeometry
			? { captureGeometry: segments[0].actionLog.captureGeometry }
			: {}),
		...(hasMixedProvenance
			? {
					provenance: {
						mode: "mixed-per-event",
						eventField: ASSEMBLY_PROVENANCE_FIELD,
						inputActionLogSchemaVersions: inputSchemaVersions,
						legacyFrameIdentity: "unavailable",
						cdpFrameIdentity: "trusted",
					},
				}
			: {}),
		assembly,
	};
	const cursor = {
		version: binding.cursorVersion,
		mode: binding.cursorMode,
		sourceClock: ACTION_LOG_SOURCE_CLOCK,
		...(segments[0].cursor.coordinateSpace
			? { coordinateSpace: segments[0].cursor.coordinateSpace }
			: {}),
		samples,
		assembly: {
			assemblyId,
			segmentCount: segments.length,
			totalDurationMs: offsetMs,
			sourceSessions: assembly.sourceSessions,
		},
	};
	return { actionLog, cursor, assembly, assemblyId, totalDurationMs: offsetMs };
}

function ffconcatPath(filePath) {
	const normalized = path.resolve(filePath).replaceAll("\\", "/");
	if (/[\r\n]/u.test(normalized))
		fail(`Media path contains a newline: ${filePath}`);
	return `'${normalized.replaceAll("'", "'\\''")}'`;
}

function concatenateRawMasters(ffmpeg, inputs, concatPath, outputPath) {
	const manifest = [
		"ffconcat version 1.0",
		...inputs.map((input) => `file ${ffconcatPath(input)}`),
		"",
	].join("\n");
	return writeFile(concatPath, manifest, "utf8").then(() => {
		runCommand(
			ffmpeg,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-fflags",
				"+genpts",
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				concatPath,
				"-map",
				"0:v:0",
				"-an",
				"-c:v",
				"copy",
				"-map_metadata",
				"-1",
				"-avoid_negative_ts",
				"make_zero",
				"-movflags",
				"+faststart",
				outputPath,
			],
			"FFmpeg Raw Master assembly",
		);
	});
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

async function rollbackOutputRecord(record, operations) {
	const rollbackErrors = [];
	let replacementRemoved = !record.installed;
	if (record.installed) {
		try {
			await operations.rm(record.final, { force: true });
			replacementRemoved = true;
		} catch (error) {
			rollbackErrors.push(
				new Error(
					`Cannot remove installed ${record.name}: ${errorText(error)}`,
					{ cause: error },
				),
			);
		}
	}
	if (record.hadOriginal && replacementRemoved) {
		try {
			await operations.rename(record.backup, record.final);
		} catch (error) {
			rollbackErrors.push(
				new Error(
					`Cannot restore original ${record.name}: ${errorText(error)}`,
					{ cause: error },
				),
			);
		}
	} else if (record.hadOriginal && !replacementRemoved) {
		rollbackErrors.push(
			new Error(
				`Original ${record.name} remains preserved at ${record.backup} because the installed replacement could not be removed.`,
			),
		);
	}
	if (rollbackErrors.length > 0) {
		throw new AggregateError(
			rollbackErrors,
			`Rollback failed for ${record.name}: ${rollbackErrors.map(errorText).join("; ")}`,
		);
	}
}

export async function commitOutputs(
	stagingDirectory,
	outputDirectory,
	operations = { existsSync, rename, rm },
) {
	const records = OUTPUT_NAMES.map((name, index) => ({
		name,
		staged: path.join(stagingDirectory, name),
		final: path.join(outputDirectory, name),
		backup: path.join(stagingDirectory, `backup-${index}-${name}`),
		hadOriginal: false,
		installed: false,
	}));
	try {
		for (const record of records) {
			if (operations.existsSync(record.final)) {
				await operations.rename(record.final, record.backup);
				record.hadOriginal = true;
			}
			await operations.rename(record.staged, record.final);
			record.installed = true;
		}
	} catch (error) {
		const rollbackResults = await Promise.allSettled(
			[...records]
				.reverse()
				.map((record) => rollbackOutputRecord(record, operations)),
		);
		const rollbackErrors = rollbackResults.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (rollbackErrors.length > 0) {
			const rollbackSummary = rollbackErrors.map(errorText).join("; ");
			const combinedError = new AggregateError(
				[error, ...rollbackErrors],
				`Output installation failed: ${errorText(error)}. Rollback also failed: ${rollbackSummary}`,
				{ cause: error },
			);
			combinedError.preserveStagingDirectory = true;
			throw combinedError;
		}
		throw error;
	}

	const cleanupResults = await Promise.allSettled(
		records
			.filter((record) => record.hadOriginal)
			.map((record) => operations.rm(record.backup, { force: true })),
	);
	return {
		cleanupErrors: cleanupResults.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		),
	};
}

async function main() {
	const { options, positional } = parseArgs(process.argv.slice(2));
	const input = await loadAssemblyInput(options, positional);
	const tools = resolveMediaTools(options);
	const normalizedSegments = await Promise.all(
		input.segments.map((segment, index) =>
			normalizeSegment(input.baseDirectory, segment, index),
		),
	);
	const inspectedSegments = [];
	for (const segment of normalizedSegments)
		inspectedSegments.push(await inspectSegment(segment, tools));
	const binding = validateSegments(
		inspectedSegments,
		input.runtimeRecoveryBoundaries,
	);
	await mkdir(input.outputDirectory, { recursive: true });
	const outputPaths = OUTPUT_NAMES.map((name) =>
		path.resolve(input.outputDirectory, name),
	);
	for (const segment of inspectedSegments) {
		for (const artifact of Object.values(segment.artifacts)) {
			if (artifact && outputPaths.includes(path.resolve(artifact.path))) {
				fail(
					`Canonical output overlaps segment evidence; archive the segment first: ${artifact.path}`,
				);
			}
		}
	}
	const lockPath = path.join(
		input.outputDirectory,
		".recordly-capture-assembly.lock",
	);
	let lockHandle;
	try {
		lockHandle = await open(lockPath, "wx");
		await lockHandle.writeFile(`${process.pid}\n`, "utf8");
	} catch (error) {
		if (error?.code === "EEXIST")
			fail(`Another Recordly capture assembly is active: ${lockPath}`);
		throw error;
	}
	const stagingDirectory = path.join(
		input.outputDirectory,
		`.recordly-capture-assembly-${process.pid}-${randomUUID()}`,
	);
	let preserveStagingDirectory = false;
	try {
		await mkdir(stagingDirectory, { recursive: false });
		const merged = createMergedDocuments(
			inspectedSegments,
			binding,
			input.outputDirectory,
		);
		const stagedRawMaster = path.join(stagingDirectory, "raw-master.mp4");
		await concatenateRawMasters(
			tools.ffmpeg,
			inspectedSegments.map((segment) => segment.artifacts.rawMaster.path),
			path.join(stagingDirectory, "concat.ffconcat"),
			stagedRawMaster,
		);
		const outputProbe = probeMedia(tools.ffprobe, stagedRawMaster);
		const durationToleranceMs = Math.max(
			100,
			FRAME_MS * inspectedSegments.length,
		);
		if (
			Math.abs(outputProbe.durationMs - merged.totalDurationMs) >
			durationToleranceMs
		) {
			fail(
				`Assembled Raw Master duration ${outputProbe.durationMs} ms does not match segment total ${merged.totalDurationMs} ms.`,
			);
		}
		const rawMasterSha256 = await sha256File(stagedRawMaster);
		await writeJson(
			path.join(stagingDirectory, "action-log.json"),
			merged.actionLog,
		);
		await writeJson(
			path.join(stagingDirectory, "raw-master.mp4.cursor.json"),
			merged.cursor,
		);
		const actionLogSha256 = await sha256File(
			path.join(stagingDirectory, "action-log.json"),
		);
		const cursorSha256 = await sha256File(
			path.join(stagingDirectory, "raw-master.mp4.cursor.json"),
		);
		const diagnostics = {
			version: 2,
			status: "completed",
			mode: "deterministic-multi-segment-assembly",
			assemblyId: merged.assemblyId,
			...sourceBindingFields(binding),
			...(binding.runtimeProvenance
				? { runtimeProvenance: binding.runtimeProvenance }
				: {}),
			segmentCount: inspectedSegments.length,
			totalDurationMs: merged.totalDurationMs,
			segments: merged.assembly.segments,
			outputs: {
				rawMaster: {
					path: "raw-master.mp4",
					sha256: rawMasterSha256,
					probe: outputProbe,
				},
				actionLog: {
					path: "action-log.json",
					sha256: actionLogSha256,
					eventCount: merged.actionLog.eventCount,
					schemaVersion: merged.actionLog.schemaVersion,
					source: merged.actionLog.source,
					provenanceMode: merged.assembly.provenanceMode,
				},
				cursor: {
					path: "raw-master.mp4.cursor.json",
					sha256: cursorSha256,
					sampleCount: merged.cursor.samples.length,
				},
			},
		};
		await writeJson(
			path.join(stagingDirectory, "recording-diagnostics.json"),
			diagnostics,
		);
		const commit = await commitOutputs(stagingDirectory, input.outputDirectory);
		for (const cleanupError of commit.cleanupErrors) {
			console.warn(
				`Installed canonical outputs, but could not remove an obsolete backup: ${errorText(cleanupError)}`,
			);
		}
		const diagnosticsSha256 = await sha256File(
			path.join(input.outputDirectory, "recording-diagnostics.json"),
		);
		console.log(
			JSON.stringify(
				{
					status: "completed",
					assemblyId: merged.assemblyId,
					segmentCount: inspectedSegments.length,
					...sourceBindingFields(binding),
					totalDurationMs: merged.totalDurationMs,
					outputDirectory: input.outputDirectory,
					outputs: {
						rawMaster: { path: "raw-master.mp4", sha256: rawMasterSha256 },
						actionLog: { path: "action-log.json", sha256: actionLogSha256 },
						cursor: {
							path: "raw-master.mp4.cursor.json",
							sha256: cursorSha256,
						},
						diagnostics: {
							path: "recording-diagnostics.json",
							sha256: diagnosticsSha256,
						},
					},
				},
				null,
				2,
			),
		);
	} catch (error) {
		preserveStagingDirectory = error?.preserveStagingDirectory === true;
		if (preserveStagingDirectory) {
			console.error(
				`Rollback was incomplete; preserved backup evidence at ${stagingDirectory}`,
			);
		}
		throw error;
	} finally {
		if (!preserveStagingDirectory) {
			try {
				await rm(stagingDirectory, { recursive: true, force: true });
			} catch (error) {
				console.warn(
					`Canonical outputs are settled, but staging cleanup failed: ${errorText(error)}`,
				);
			}
		}
		await lockHandle.close();
		await rm(lockPath, { force: true });
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const isDirectExecution =
	invokedPath !== null &&
	(process.platform === "win32"
		? invokedPath.toLowerCase() === modulePath.toLowerCase()
		: invokedPath === modulePath);

if (isDirectExecution) {
	main().catch((error) => {
		console.error(errorText(error));
		process.exitCode = 1;
	});
}
