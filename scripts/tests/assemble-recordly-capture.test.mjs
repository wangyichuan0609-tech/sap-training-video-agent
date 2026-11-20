#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { commitOutputs } from "../assemble-recordly-capture.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(path.dirname(scriptDirectory));
const OUTPUT_NAMES = [
	"raw-master.mp4",
	"action-log.json",
	"raw-master.mp4.cursor.json",
	"recording-diagnostics.json",
];

function execute(command, args) {
	return spawnSync(command, args, {
		cwd: workspaceRoot,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
}

function run(command, args) {
	const result = execute(command, args);
	if (result.error || result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed\n${result.error?.stack || ""}\n${result.stdout || ""}\n${result.stderr || ""}`,
		);
	}
	return result.stdout;
}

async function json(filePath, value) {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256(filePath) {
	return createHash("sha256")
		.update(await readFile(filePath))
		.digest("hex")
		.toUpperCase();
}

async function hashes(paths) {
	return Object.fromEntries(
		await Promise.all(
			paths.map(async (filePath) => [filePath, await sha256(filePath)]),
		),
	);
}

async function createCommitFixture(directory) {
	const stagingDirectory = path.join(directory, "staging");
	const outputDirectory = path.join(directory, "output");
	await Promise.all([
		mkdir(stagingDirectory, { recursive: true }),
		mkdir(outputDirectory, { recursive: true }),
	]);
	for (const name of OUTPUT_NAMES) {
		await Promise.all([
			writeFile(path.join(stagingDirectory, name), `new:${name}`, "utf8"),
			writeFile(path.join(outputDirectory, name), `old:${name}`, "utf8"),
		]);
	}
	return { stagingDirectory, outputDirectory };
}

async function assertCommitContents(
	outputDirectory,
	prefix,
	names = OUTPUT_NAMES,
) {
	for (const name of names) {
		assert.equal(
			await readFile(path.join(outputDirectory, name), "utf8"),
			`${prefix}:${name}`,
		);
	}
}

async function createSegment(
	directory,
	{ color, sessionId, sourceWebContentsId, targetX, schemaVersion = 1 },
) {
	await mkdir(directory, { recursive: true });
	const rawMaster = path.join(directory, "raw-master.mp4");
	run("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`color=c=${color}:size=1920x1080:rate=30:duration=1`,
		"-map",
		"0:v:0",
		"-an",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-r",
		"30",
		"-movflags",
		"+faststart",
		"-y",
		rawMaster,
	]);
	const target = {
		targetId: `target-${sessionId}`,
		selector: `#target-${sessionId}`,
		controlType: "button",
		name: `Target ${sessionId}`,
		text: `Target ${sessionId}`,
		cursorType: "pointer",
		rect: { x: targetX, y: 300, width: 180, height: 60 },
		point: { x: targetX + 90, y: 330 },
		normalizedPoint: { x: (targetX + 90) / 1920, y: 330 / 1080 },
	};
	const trustedFrame = {
		documentId: "child-frame:1",
		url: "https://child.example.test",
		frame: {
			frameId: "child-frame",
			parentFrameId: "main-frame",
			origin: "https://child.example.test",
			isMainFrame: false,
		},
		viewport: {
			width: 1920,
			height: 1080,
			devicePixelRatio: 1,
			scrollX: 0,
			scrollY: 0,
		},
	};
	await json(path.join(directory, "action-log.json"), {
		schemaVersion,
		source:
			schemaVersion === 2
				? "Recordly built-in SAP Browser CDP isolated-world collector"
				: "Recordly built-in SAP Browser DOM collector",
		sourceClock: "capture-session-monotonic",
		sessionId,
		sourceWebContentsId,
		eventCount: 2,
		timeline: [
			{
				eventId: `${sessionId}:fixture:0`,
				type: "focus",
				sourceTimeMs: 100,
				...(schemaVersion === 2 ? trustedFrame : {}),
				target,
			},
			{
				eventId: `${sessionId}:fixture:1`,
				type: "click",
				sourceTimeMs: 500,
				...(schemaVersion === 2 ? trustedFrame : {}),
				target,
			},
		],
		captureGeometry: {
			viewport: {
				width: 1920,
				height: 1080,
				devicePixelRatio: 1,
				scrollX: 0,
				scrollY: 0,
			},
			contentRect: { x: 0, y: 0, width: 1920, height: 1080 },
		},
	});
	await json(path.join(directory, "raw-master.mp4.cursor.json"), {
		version: 3,
		mode: "browser-action-timeline",
		sourceClock: "capture-session-monotonic",
		samples: [
			{
				timeMs: 100,
				cx: targetX / 1920,
				cy: 0.3,
				interactionType: "move",
				cursorType: "pointer",
			},
			{
				timeMs: 500,
				cx: (targetX + 90) / 1920,
				cy: 330 / 1080,
				interactionType: "click",
				cursorType: "pointer",
			},
		],
	});
	await json(path.join(directory, "recording-diagnostics.json"), {
		version: 1,
		status: { phase: "recording", sessionId, sourceWebContentsId },
		completed: {
			sessionId,
			sourceWebContentsId,
			normalization: {
				probe: {
					codec: "h264",
					pixelFormat: "yuv420p",
					frameRate: 30,
					durationSeconds: 1,
					width: 1920,
					height: 1080,
					audioStreamCount: 0,
				},
			},
		},
	});
	return {
		rawMaster,
		actionLog: path.join(directory, "action-log.json"),
		cursor: path.join(directory, "raw-master.mp4.cursor.json"),
		diagnostics: path.join(directory, "recording-diagnostics.json"),
	};
}

const root = await mkdtemp(
	path.join(os.tmpdir(), "recordly-capture-assembler-"),
);
try {
	const capture = path.join(root, "capture");
	const segmentOneDirectory = path.join(capture, "segments", "001");
	const segmentTwoDirectory = path.join(capture, "segments", "002");
	const segmentThreeDirectory = path.join(capture, "segments", "004");
	const segmentFourDirectory = path.join(capture, "segments", "005");
	const segmentOne = await createSegment(segmentOneDirectory, {
		color: "red",
		sessionId: "11111111-1111-4111-8111-111111111111",
		sourceWebContentsId: 7,
		targetX: 200,
	});
	const segmentTwo = await createSegment(segmentTwoDirectory, {
		color: "blue",
		sessionId: "22222222-2222-4222-8222-222222222222",
		sourceWebContentsId: 7,
		targetX: 1_300,
		schemaVersion: 2,
	});
	const segmentThree = await createSegment(segmentThreeDirectory, {
		color: "green",
		sessionId: "33333333-3333-4333-8333-333333333333",
		sourceWebContentsId: 7,
		targetX: 800,
		schemaVersion: 2,
	});
	const segmentFour = await createSegment(segmentFourDirectory, {
		color: "yellow",
		sessionId: "44444444-4444-4444-8444-444444444444",
		sourceWebContentsId: 8,
		targetX: 1_000,
		schemaVersion: 2,
	});
	const sourcePaths = [
		...Object.values(segmentOne),
		...Object.values(segmentTwo),
		...Object.values(segmentThree),
	];
	const sourceHashesBefore = await hashes(sourcePaths);

	// Seed the canonical paths with segment 001, matching a stopped partial run.
	await mkdir(capture, { recursive: true });
	await Promise.all([
		copyFile(segmentOne.rawMaster, path.join(capture, "raw-master.mp4")),
		copyFile(segmentOne.actionLog, path.join(capture, "action-log.json")),
		copyFile(
			segmentOne.cursor,
			path.join(capture, "raw-master.mp4.cursor.json"),
		),
		copyFile(
			segmentOne.diagnostics,
			path.join(capture, "recording-diagnostics.json"),
		),
	]);

	const manifestPath = path.join(root, "assembly-manifest.json");
	const manifest = {
		schemaVersion: 1,
		outputDirectory: "capture",
		segments: [
			{
				index: 1,
				sessionId: "11111111-1111-4111-8111-111111111111",
				sourceWebContentsId: 7,
				archiveDirectory: "capture/segments/001",
				artifacts: {
					rawMaster: {
						path: "capture/segments/001/raw-master.mp4",
						sha256: await sha256(segmentOne.rawMaster),
					},
					actionLog: {
						path: "capture/segments/001/action-log.json",
						sha256: await sha256(segmentOne.actionLog),
					},
					cursor: {
						path: "capture/segments/001/raw-master.mp4.cursor.json",
						sha256: await sha256(segmentOne.cursor),
					},
					diagnostics: {
						path: "capture/segments/001/recording-diagnostics.json",
						sha256: await sha256(segmentOne.diagnostics),
					},
				},
			},
			{
				index: 2,
				sessionId: "22222222-2222-4222-8222-222222222222",
				sourceWebContentsId: 7,
				archiveDirectory: "capture/segments/002",
				artifacts: {
					rawMaster: {
						path: "capture/segments/002/raw-master.mp4",
						sha256: await sha256(segmentTwo.rawMaster),
					},
					actionLog: {
						path: "capture/segments/002/action-log.json",
						sha256: await sha256(segmentTwo.actionLog),
					},
					cursor: {
						path: "capture/segments/002/raw-master.mp4.cursor.json",
						sha256: await sha256(segmentTwo.cursor),
					},
					diagnostics: {
						path: "capture/segments/002/recording-diagnostics.json",
						sha256: await sha256(segmentTwo.diagnostics),
					},
				},
			},
		],
	};
	await json(manifestPath, manifest);
	const assembler = path.join(
		workspaceRoot,
		"scripts",
		"assemble-recordly-capture.mjs",
	);
	const result = JSON.parse(
		run(process.execPath, [assembler, `--manifest=${manifestPath}`]),
	);
	assert.equal(result.status, "completed");
	assert.equal(result.segmentCount, 2);
	assert.equal(result.sourceWebContentsId, 7);
	assert.ok(result.totalDurationMs >= 1_900 && result.totalDurationMs <= 2_100);

	const actionLog = JSON.parse(
		await readFile(path.join(capture, "action-log.json"), "utf8"),
	);
	const cursor = JSON.parse(
		await readFile(path.join(capture, "raw-master.mp4.cursor.json"), "utf8"),
	);
	const diagnostics = JSON.parse(
		await readFile(path.join(capture, "recording-diagnostics.json"), "utf8"),
	);
	assert.equal(actionLog.schemaVersion, 3);
	assert.equal(
		actionLog.source,
		"Recordly deterministic mixed-provenance capture assembly",
	);
	assert.deepEqual(actionLog.provenance, {
		mode: "mixed-per-event",
		eventField: "assemblyProvenance",
		inputActionLogSchemaVersions: [1, 2],
		legacyFrameIdentity: "unavailable",
		cdpFrameIdentity: "trusted",
	});
	assert.equal(actionLog.sourceClock, "capture-session-monotonic");
	assert.equal(actionLog.eventCount, 4);
	assert.deepEqual(actionLog.sourceSessionIds, [
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
	]);
	assert.equal(actionLog.timeline[2].sourceTimeMs, 1_100);
	assert.equal(actionLog.timeline[3].sourceTimeMs, 1_500);
	assert.equal(actionLog.timeline[0].frame, undefined);
	assert.equal(actionLog.timeline[0].documentId, undefined);
	assert.deepEqual(actionLog.timeline[0].assemblyProvenance, {
		segmentIndex: 1,
		sessionId: "11111111-1111-4111-8111-111111111111",
		actionLogSchemaVersion: 1,
		actionLogSource: "Recordly built-in SAP Browser DOM collector",
		frameIdentityTrust: "unavailable-legacy-v1",
	});
	assert.equal(actionLog.timeline[2].documentId, "child-frame:1");
	assert.deepEqual(actionLog.timeline[2].frame, {
		frameId: "child-frame",
		parentFrameId: "main-frame",
		origin: "https://child.example.test",
		isMainFrame: false,
	});
	assert.deepEqual(actionLog.timeline[2].assemblyProvenance, {
		segmentIndex: 2,
		sessionId: "22222222-2222-4222-8222-222222222222",
		actionLogSchemaVersion: 2,
		actionLogSource:
			"Recordly built-in SAP Browser CDP isolated-world collector",
		frameIdentityTrust: "trusted-cdp-v2",
	});
	assert.equal(actionLog.assembly.version, 2);
	assert.equal(actionLog.assembly.provenanceMode, "mixed-per-event");
	assert.deepEqual(actionLog.assembly.inputActionLogSchemaVersions, [1, 2]);
	assert.equal(actionLog.assembly.legacyInputSegmentCount, 1);
	assert.equal(actionLog.assembly.trustedDocumentCount, 1);
	assert.deepEqual(
		actionLog.assembly.segments.map(
			(segment) => segment.actionLogSchemaVersion,
		),
		[1, 2],
	);
	assert.equal(
		new Set(actionLog.timeline.map((event) => event.eventId)).size,
		4,
	);
	assert.ok(
		actionLog.timeline.every(
			(event, index) =>
				index === 0 ||
				event.sourceTimeMs >= actionLog.timeline[index - 1].sourceTimeMs,
		),
	);
	assert.deepEqual(
		cursor.samples.map((sample) => sample.timeMs),
		[100, 500, 1_100, 1_500],
	);
	assert.equal(cursor.sourceClock, "capture-session-monotonic");
	assert.equal(diagnostics.mode, "deterministic-multi-segment-assembly");
	assert.equal(diagnostics.outputs.actionLog.eventCount, 4);
	assert.equal(diagnostics.outputs.actionLog.schemaVersion, 3);
	assert.equal(
		diagnostics.outputs.actionLog.source,
		"Recordly deterministic mixed-provenance capture assembly",
	);
	assert.equal(diagnostics.outputs.actionLog.provenanceMode, "mixed-per-event");
	assert.equal(diagnostics.outputs.cursor.sampleCount, 4);
	assert.deepEqual(await hashes(sourcePaths), sourceHashesBefore);

	const canonicalPaths = [
		path.join(capture, "raw-master.mp4"),
		path.join(capture, "action-log.json"),
		path.join(capture, "raw-master.mp4.cursor.json"),
		path.join(capture, "recording-diagnostics.json"),
	];
	const firstOutputHashes = await hashes(canonicalPaths);

	// The run.json shape used by production resolves the same archived evidence.
	await json(path.join(root, "run.json"), {
		run: "assembly-fixture",
		capture: {
			segmentEvidence: manifest.segments,
			rawMaster: "capture/raw-master.mp4",
			actionLog: "capture/action-log.json",
			cursor: "capture/raw-master.mp4.cursor.json",
			recordingDiagnostics: "capture/recording-diagnostics.json",
		},
		video: { teachingPlan: "recordly/teaching-plan.json" },
	});
	run(process.execPath, [assembler, root]);
	assert.deepEqual(await hashes(canonicalPaths), firstOutputHashes);

	// Ordered evidence-directory mode is deterministic too.
	run(process.execPath, [
		assembler,
		segmentOneDirectory,
		segmentTwoDirectory,
		`--output-dir=${capture}`,
	]);
	assert.deepEqual(await hashes(canonicalPaths), firstOutputHashes);

	// Uniform CDP inputs retain the native schema v2 contract. A gap in logical
	// segment indices remains valid for a recovery run that excludes failed takes.
	const pureV2Manifest = {
		schemaVersion: 1,
		outputDirectory: "capture-v2",
		segments: [
			{
				...structuredClone(manifest.segments[1]),
				index: 1,
			},
			{
				index: 4,
				sessionId: "33333333-3333-4333-8333-333333333333",
				sourceWebContentsId: 7,
				archiveDirectory: "capture/segments/004",
				artifacts: {
					rawMaster: {
						path: "capture/segments/004/raw-master.mp4",
						sha256: await sha256(segmentThree.rawMaster),
					},
					actionLog: {
						path: "capture/segments/004/action-log.json",
						sha256: await sha256(segmentThree.actionLog),
					},
					cursor: {
						path: "capture/segments/004/raw-master.mp4.cursor.json",
						sha256: await sha256(segmentThree.cursor),
					},
					diagnostics: {
						path: "capture/segments/004/recording-diagnostics.json",
						sha256: await sha256(segmentThree.diagnostics),
					},
				},
			},
		],
	};
	const pureV2ManifestPath = path.join(root, "pure-v2-manifest.json");
	await json(pureV2ManifestPath, pureV2Manifest);
	run(process.execPath, [assembler, `--manifest=${pureV2ManifestPath}`]);
	const pureV2ActionLog = JSON.parse(
		await readFile(path.join(root, "capture-v2", "action-log.json"), "utf8"),
	);
	assert.equal(pureV2ActionLog.schemaVersion, 2);
	assert.equal(
		pureV2ActionLog.source,
		"Recordly built-in SAP Browser CDP isolated-world collector",
	);
	assert.equal(pureV2ActionLog.provenance, undefined);
	assert.equal(pureV2ActionLog.assembly.provenanceMode, "uniform");
	assert.deepEqual(pureV2ActionLog.assembly.inputActionLogSchemaVersions, [2]);
	assert.deepEqual(
		pureV2ActionLog.assembly.segments.map((segment) => segment.index),
		[1, 4],
	);
	assert.ok(
		pureV2ActionLog.timeline.every(
			(event) => event.assemblyProvenance === undefined && event.frame,
		),
	);
	// Legacy manifests remain on the original single-WebContents contract.
	assert.equal(pureV2ActionLog.sourceWebContentsId, 7);
	assert.equal(pureV2ActionLog.sourceRuntimeInstances, undefined);
	assert.equal(pureV2ActionLog.runtimeProvenance, undefined);
	assert.equal(pureV2ActionLog.assembly.version, 2);

	// A clean Recordly restart may reuse the same numeric WebContents id. The
	// opt-in runtimeEpoch contract treats the two bindings as distinct instances
	// only when an exact ordered recovery boundary is declared.
	const runtimeEpochManifest = structuredClone(pureV2Manifest);
	runtimeEpochManifest.outputDirectory = "capture-runtime-epochs";
	runtimeEpochManifest.segments[0].runtimeEpoch = 1;
	runtimeEpochManifest.segments[1].runtimeEpoch = 2;
	runtimeEpochManifest.runtimeRecoveryBoundaries = [
		{
			sequence: 1,
			kind: "recordly-runtime-restart",
			afterSegmentIndex: 1,
			beforeSegmentIndex: 4,
			fromRuntimeEpoch: 1,
			toRuntimeEpoch: 2,
		},
	];
	const runtimeEpochManifestPath = path.join(
		root,
		"runtime-epoch-manifest.json",
	);
	await json(runtimeEpochManifestPath, runtimeEpochManifest);
	const runtimeEpochResult = JSON.parse(
		run(process.execPath, [
			assembler,
			`--manifest=${runtimeEpochManifestPath}`,
		]),
	);
	assert.equal(runtimeEpochResult.sourceWebContentsId, null);
	assert.deepEqual(
		runtimeEpochResult.sourceRuntimeInstances.map((instance) => ({
			runtimeEpoch: instance.runtimeEpoch,
			sourceWebContentsId: instance.sourceWebContentsId,
			instanceKey: instance.instanceKey,
		})),
		[
			{
				runtimeEpoch: 1,
				sourceWebContentsId: 7,
				instanceKey: "runtime-epoch:1:web-contents:7",
			},
			{
				runtimeEpoch: 2,
				sourceWebContentsId: 7,
				instanceKey: "runtime-epoch:2:web-contents:7",
			},
		],
	);
	const runtimeEpochActionLog = JSON.parse(
		await readFile(
			path.join(root, "capture-runtime-epochs", "action-log.json"),
			"utf8",
		),
	);
	assert.equal(runtimeEpochActionLog.sourceWebContentsId, null);
	assert.equal(runtimeEpochActionLog.assembly.version, 3);
	assert.deepEqual(
		runtimeEpochActionLog.sourceRuntimeInstances,
		runtimeEpochActionLog.runtimeProvenance.instances,
	);
	assert.deepEqual(runtimeEpochActionLog.runtimeProvenance.recoveryBoundaries, [
		{
			sequence: 1,
			kind: "recordly-runtime-restart",
			afterSegmentIndex: 1,
			beforeSegmentIndex: 4,
			fromRuntimeEpoch: 1,
			toRuntimeEpoch: 2,
			fromRuntimeInstanceKey: "runtime-epoch:1:web-contents:7",
			toRuntimeInstanceKey: "runtime-epoch:2:web-contents:7",
		},
	]);
	assert.deepEqual(
		runtimeEpochActionLog.assembly.segments.map((segment) => ({
			index: segment.index,
			runtimeEpoch: segment.runtimeEpoch,
			runtimeInstanceKey: segment.runtimeInstanceKey,
			recoveryBoundaryBefore: segment.recoveryBoundaryBefore,
		})),
		[
			{
				index: 1,
				runtimeEpoch: 1,
				runtimeInstanceKey: "runtime-epoch:1:web-contents:7",
				recoveryBoundaryBefore: undefined,
			},
			{
				index: 4,
				runtimeEpoch: 2,
				runtimeInstanceKey: "runtime-epoch:2:web-contents:7",
				recoveryBoundaryBefore: 1,
			},
		],
	);
	assert.notEqual(
		runtimeEpochActionLog.assembly.assemblyId,
		pureV2ActionLog.assembly.assemblyId,
	);

	// An epoch transition without its exact boundary record is unannounced.
	const missingBoundaryManifest = structuredClone(runtimeEpochManifest);
	missingBoundaryManifest.outputDirectory = "capture-missing-boundary";
	delete missingBoundaryManifest.runtimeRecoveryBoundaries;
	const missingBoundaryManifestPath = path.join(
		root,
		"missing-runtime-boundary-manifest.json",
	);
	await json(missingBoundaryManifestPath, missingBoundaryManifest);
	const missingBoundary = execute(process.execPath, [
		assembler,
		`--manifest=${missingBoundaryManifestPath}`,
	]);
	assert.notEqual(missingBoundary.status, 0);
	assert.match(
		missingBoundary.stderr,
		/runtimeRecoveryBoundaries must contain exactly 1 ordered record/u,
	);

	// One runtime epoch cannot silently contain two different WebContents ids.
	const differentIdSameEpochManifest = {
		schemaVersion: 1,
		outputDirectory: "capture-different-id-same-epoch",
		segments: [
			{
				...structuredClone(pureV2Manifest.segments[0]),
				runtimeEpoch: 1,
			},
			{
				index: 5,
				sessionId: "44444444-4444-4444-8444-444444444444",
				sourceWebContentsId: 8,
				runtimeEpoch: 1,
				archiveDirectory: "capture/segments/005",
				artifacts: {
					rawMaster: {
						path: "capture/segments/005/raw-master.mp4",
						sha256: await sha256(segmentFour.rawMaster),
					},
					actionLog: {
						path: "capture/segments/005/action-log.json",
						sha256: await sha256(segmentFour.actionLog),
					},
					cursor: {
						path: "capture/segments/005/raw-master.mp4.cursor.json",
						sha256: await sha256(segmentFour.cursor),
					},
					diagnostics: {
						path: "capture/segments/005/recording-diagnostics.json",
						sha256: await sha256(segmentFour.diagnostics),
					},
				},
			},
		],
	};
	const differentIdSameEpochManifestPath = path.join(
		root,
		"different-id-same-runtime-epoch-manifest.json",
	);
	await json(differentIdSameEpochManifestPath, differentIdSameEpochManifest);
	const differentIdSameEpoch = execute(process.execPath, [
		assembler,
		`--manifest=${differentIdSameEpochManifestPath}`,
	]);
	assert.notEqual(differentIdSameEpoch.status, 0);
	assert.match(
		differentIdSameEpoch.stderr,
		/runtimeEpoch 1 contains multiple sourceWebContentsId values/u,
	);

	// Boundary order and epoch continuity are strict; neither record nor epoch
	// sequences may be skipped.
	const malformedBoundaryManifest = structuredClone(runtimeEpochManifest);
	malformedBoundaryManifest.outputDirectory = "capture-malformed-boundary";
	malformedBoundaryManifest.runtimeRecoveryBoundaries[0].sequence = 2;
	const malformedBoundaryManifestPath = path.join(
		root,
		"malformed-runtime-boundary-manifest.json",
	);
	await json(malformedBoundaryManifestPath, malformedBoundaryManifest);
	const malformedBoundary = execute(process.execPath, [
		assembler,
		`--manifest=${malformedBoundaryManifestPath}`,
	]);
	assert.notEqual(malformedBoundary.status, 0);
	assert.match(
		malformedBoundary.stderr,
		/does not match ordered runtime transition/u,
	);

	const skippedEpochManifest = structuredClone(runtimeEpochManifest);
	skippedEpochManifest.outputDirectory = "capture-skipped-epoch";
	skippedEpochManifest.segments[1].runtimeEpoch = 3;
	skippedEpochManifest.runtimeRecoveryBoundaries[0].toRuntimeEpoch = 3;
	const skippedEpochManifestPath = path.join(
		root,
		"skipped-runtime-epoch-manifest.json",
	);
	await json(skippedEpochManifestPath, skippedEpochManifest);
	const skippedEpoch = execute(process.execPath, [
		assembler,
		`--manifest=${skippedEpochManifestPath}`,
	]);
	assert.notEqual(skippedEpoch.status, 0);
	assert.match(skippedEpoch.stderr, /skips an epoch/u);

	const recordlyDirectory = path.join(root, "recordly");
	await mkdir(recordlyDirectory, { recursive: true });
	await json(path.join(recordlyDirectory, "teaching-plan.json"), {
		schemaVersion: 1,
		businessGoal: "验证多段录制合并。",
		learnerOutcome: "学员能够看到连续的真实操作。",
		knowledgePoints: ["第一段", "安全恢复", "第二段"],
		scenes: [
			{
				id: "segment-one",
				teachingClass: "B",
				actionIds: ["11111111-1111-4111-8111-111111111111:fixture:1"],
				sourceStartMs: 0,
				sourceEndMs: 900,
			},
			{
				id: "segment-two",
				teachingClass: "B",
				actionIds: ["22222222-2222-4222-8222-222222222222:fixture:1"],
				sourceStartMs: 1_000,
				sourceEndMs: 1_900,
			},
		],
	});
	const roughProject = path.join(
		recordlyDirectory,
		"assembly-fixture.rough.recordly",
	);
	run(process.execPath, [
		path.join(workspaceRoot, "scripts", "build-recordly-project.mjs"),
		root,
		"--mode=rough",
		`--output=${roughProject}`,
	]);
	const rough = JSON.parse(await readFile(roughProject, "utf8"));
	const roughContract = JSON.parse(
		await readFile(`${roughProject}.contract.json`, "utf8"),
	);
	assert.equal(rough.videoPath, path.join(capture, "raw-master.mp4"));
	assert.ok(rough.editor.clipRegions.length >= 2);
	assert.ok(roughContract.inputs.cursor.mappedSamples >= 2);

	// Schema v2 frame identity is trusted evidence, not opaque metadata.
	const invalidFrameActionLog = JSON.parse(
		await readFile(segmentTwo.actionLog, "utf8"),
	);
	invalidFrameActionLog.timeline[0].frame.origin = "https://other.example.test";
	const invalidFrameActionLogPath = path.join(
		root,
		"invalid-frame-action-log.json",
	);
	await json(invalidFrameActionLogPath, invalidFrameActionLog);
	const invalidFrameManifest = structuredClone(manifest);
	invalidFrameManifest.segments[1].artifacts.actionLog = {
		path: "invalid-frame-action-log.json",
		sha256: await sha256(invalidFrameActionLogPath),
	};
	const invalidFrameManifestPath = path.join(
		root,
		"invalid-frame-manifest.json",
	);
	await json(invalidFrameManifestPath, invalidFrameManifest);
	const invalidFrame = execute(process.execPath, [
		assembler,
		`--manifest=${invalidFrameManifestPath}`,
	]);
	assert.notEqual(invalidFrame.status, 0);
	assert.match(invalidFrame.stderr, /trusted frame origin/u);
	assert.deepEqual(await hashes(canonicalPaths), firstOutputHashes);

	// A bad declared hash fails before commit and leaves all canonical outputs intact.
	const invalidManifest = structuredClone(manifest);
	invalidManifest.segments[1].artifacts.rawMaster.sha256 = "0".repeat(64);
	const invalidManifestPath = path.join(root, "invalid-manifest.json");
	await json(invalidManifestPath, invalidManifest);
	const failed = execute(process.execPath, [
		assembler,
		`--manifest=${invalidManifestPath}`,
	]);
	assert.notEqual(failed.status, 0);
	assert.match(failed.stderr, /SHA256 mismatch/u);
	assert.deepEqual(await hashes(canonicalPaths), firstOutputHashes);

	// Backup cleanup is post-commit and best-effort: a cleanup failure must not
	// roll back canonical files that were already installed successfully.
	const cleanupFixture = await createCommitFixture(
		path.join(root, "commit-cleanup-failure"),
	);
	let injectedCleanupFailure = false;
	const cleanupCommit = await commitOutputs(
		cleanupFixture.stagingDirectory,
		cleanupFixture.outputDirectory,
		{
			existsSync,
			rename,
			rm: async (filePath, options) => {
				if (
					!injectedCleanupFailure &&
					path.basename(filePath) === "backup-0-raw-master.mp4"
				) {
					injectedCleanupFailure = true;
					throw new Error("fixture backup cleanup failure");
				}
				return rm(filePath, options);
			},
		},
	);
	assert.equal(cleanupCommit.cleanupErrors.length, 1);
	assert.match(cleanupCommit.cleanupErrors[0].message, /cleanup failure/u);
	await assertCommitContents(cleanupFixture.outputDirectory, "new");
	assert.equal(
		await readFile(
			path.join(cleanupFixture.stagingDirectory, "backup-0-raw-master.mp4"),
			"utf8",
		),
		"old:raw-master.mp4",
	);

	// An install failure with a healthy filesystem restores every original.
	const healthyRollbackFixture = await createCommitFixture(
		path.join(root, "commit-healthy-rollback"),
	);
	await assert.rejects(
		commitOutputs(
			healthyRollbackFixture.stagingDirectory,
			healthyRollbackFixture.outputDirectory,
			{
				existsSync,
				rename: async (from, to) => {
					if (
						path.dirname(from) === healthyRollbackFixture.stagingDirectory &&
						path.basename(from) === "recording-diagnostics.json" &&
						path.dirname(to) === healthyRollbackFixture.outputDirectory
					) {
						throw new Error("fixture install failure");
					}
					return rename(from, to);
				},
				rm,
			},
		),
		/fixture install failure/u,
	);
	await assertCommitContents(healthyRollbackFixture.outputDirectory, "old");

	// Rollback itself is all-settled across outputs. One forced restore failure
	// is reported with the install error, while other originals are restored and
	// the unrestored original remains preserved in staging.
	const failedRollbackFixture = await createCommitFixture(
		path.join(root, "commit-rollback-failure"),
	);
	let rollbackError;
	try {
		await commitOutputs(
			failedRollbackFixture.stagingDirectory,
			failedRollbackFixture.outputDirectory,
			{
				existsSync,
				rename: async (from, to) => {
					if (
						path.dirname(from) === failedRollbackFixture.stagingDirectory &&
						path.basename(from) === "recording-diagnostics.json" &&
						path.dirname(to) === failedRollbackFixture.outputDirectory
					) {
						throw new Error("fixture install failure");
					}
					if (
						path.basename(from) === "backup-2-raw-master.mp4.cursor.json" &&
						path.dirname(to) === failedRollbackFixture.outputDirectory
					) {
						throw new Error("fixture cursor restore failure");
					}
					return rename(from, to);
				},
				rm,
			},
		);
	} catch (error) {
		rollbackError = error;
	}
	assert.ok(rollbackError instanceof AggregateError);
	assert.equal(rollbackError.preserveStagingDirectory, true);
	assert.match(rollbackError.message, /fixture install failure/u);
	assert.match(rollbackError.message, /fixture cursor restore failure/u);
	await assertCommitContents(failedRollbackFixture.outputDirectory, "old", [
		"raw-master.mp4",
		"action-log.json",
		"recording-diagnostics.json",
	]);
	assert.equal(
		existsSync(
			path.join(
				failedRollbackFixture.outputDirectory,
				"raw-master.mp4.cursor.json",
			),
		),
		false,
	);
	const preservedCursorBackup = path.join(
		failedRollbackFixture.stagingDirectory,
		"backup-2-raw-master.mp4.cursor.json",
	);
	assert.equal(existsSync(preservedCursorBackup), true);
	assert.equal(
		await readFile(preservedCursorBackup, "utf8"),
		"old:raw-master.mp4.cursor.json",
	);

	console.log("recordly capture assembler: passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
