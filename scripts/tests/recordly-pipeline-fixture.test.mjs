#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ruleSetSha256 } from "../publication-contract.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(path.dirname(scriptDirectory));

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: workspaceRoot,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed\n${result.error?.stack || ""}\n${result.stdout || ""}\n${result.stderr || ""}`,
		);
	}
	return result.stdout;
}

async function json(pathname, value) {
	await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const root = await mkdtemp(path.join(os.tmpdir(), "recordly-pipeline-fixture-"));
try {
	const capture = path.join(root, "capture");
	const recordly = path.join(root, "recordly");
	const audio = path.join(recordly, "audio");
	await mkdir(capture, { recursive: true });
	await mkdir(audio, { recursive: true });
	const rawMaster = path.join(capture, "raw-master.mp4");
	run("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=1920x1080:rate=30",
		"-t",
		"6",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-an",
		"-y",
		rawMaster,
	]);

	const targetInput = {
		id: "search-field",
		controlType: "Input",
		x: 120,
		y: 90,
		width: 360,
		height: 48,
		coordinateSpace: "viewport",
	};
	const targetButton = {
		id: "execute-button",
		controlType: "Button",
		x: 1460,
		y: 860,
		width: 180,
		height: 52,
		coordinateSpace: "viewport",
	};
	await json(path.join(capture, "action-log.json"), {
		captureGeometry: {
			viewport: { width: 1920, height: 1080 },
			contentRect: { x: 0, y: 0, width: 1920, height: 1080 },
		},
		actions: [
			{ id: "action-search", sourceTimeMs: 500, sourceEndTimeMs: 1400, target: targetInput },
			{ id: "action-wait", sourceTimeMs: 2600, sourceEndTimeMs: 3500 },
			{ id: "action-execute", sourceTimeMs: 5500, sourceEndTimeMs: 5900, target: targetButton },
		],
	});
	await json(`${rawMaster}.cursor.json`, {
		version: 2,
		samples: [
			{ timeMs: 100, cx: 0.1, cy: 0.1, interactionType: "move", cursorType: "arrow" },
			{ timeMs: 500, cx: 0.2, cy: 0.1, interactionType: "click", cursorType: "text" },
			{ timeMs: 2800, cx: 0.4, cy: 0.4, interactionType: "move", cursorType: "arrow" },
			{ timeMs: 5500, cx: 0.8, cy: 0.8, interactionType: "click", cursorType: "pointer" },
			{ timeMs: 5800, cx: 0.82, cy: 0.82, interactionType: "mouseup", cursorType: "pointer" },
		],
	});
	await json(path.join(capture, "recording-diagnostics.json"), { status: "completed" });

	const teachingPlanPath = path.join(recordly, "teaching-plan.json");
	const teachingPlan = {
		schemaVersion: 1,
		connectZooms: true,
		businessGoal: "完成一次只读 SAP 查询。",
		learnerOutcome: "学员能够搜索条件并执行查询。",
		knowledgePoints: ["找到 Search", "输入条件", "确认结果"],
		scenes: [
			{
				id: "search",
				teachingClass: "A",
				objective: "输入搜索条件",
				actionIds: ["action-search"],
				sourceStartMs: 0,
				sourceEndMs: 2200,
				narration: "首先输入查询条件。",
				stagePrompt: { text: "设置查询条件", durationMs: 1_200, delayMs: 0 },
				visualBeats: [
					{
						id: "search-target",
						actionId: "action-search",
						zoomReason: "Search 是查询条件入口。",
						zoomAnchorDelayMs: 0,
						zoomHoldToSceneEnd: true,
						candidate: { highlight: true, cursor: true, zoom: true, behavior: "focus" },
						visualIntent: { highlight: true, cursor: true, zoom: true, behavior: "focus" },
					},
				],
			},
			{
				id: "loading",
				teachingClass: "C",
				category: "loading",
				sourceStartMs: 2200,
				sourceEndMs: 2600,
			},
			{
				id: "required-wait",
				teachingClass: "C",
				disposition: "speed",
				actionIds: ["action-wait"],
				sourceStartMs: 2600,
				sourceEndMs: 5000,
			},
			{
				id: "execute",
				teachingClass: "B",
				objective: "执行并查看结果",
				actionIds: ["action-execute"],
				sourceStartMs: 5400,
				sourceEndMs: 5900,
				narration: "执行后确认结果已经显示。",
				visualBeats: [
					{
						id: "execute-target",
						actionId: "action-execute",
						candidate: { highlight: true, cursor: true, zoom: false, behavior: "switch" },
						visualIntent: { highlight: true, cursor: true, zoom: false, behavior: "switch" },
					},
				],
			},
		],
	};
	await json(teachingPlanPath, teachingPlan);
	await json(path.join(root, "run.json"), {
		run: "fixture-run",
		capture: {
			rawMaster: "capture/raw-master.mp4",
			actionLog: "capture/action-log.json",
			cursor: "capture/raw-master.mp4.cursor.json",
			recordingDiagnostics: "capture/recording-diagnostics.json",
		},
		video: { teachingPlan: "recordly/teaching-plan.json" },
	});

	const roughPath = path.join(recordly, "fixture.rough.recordly");
	run(process.execPath, [
		path.join(workspaceRoot, "scripts", "build-recordly-project.mjs"),
		root,
		"--mode=rough",
		`--output=${roughPath}`,
	]);
	const roughProject = JSON.parse(await readFile(roughPath, "utf8"));
	const roughContract = JSON.parse(await readFile(`${roughPath}.contract.json`, "utf8"));
	assert.equal(roughProject.editor.audioRegions.length, 0);
	assert.equal(roughProject.editor.autoCaptions.length, 0);
	assert.ok(roughProject.editor.clipRegions.length > 3);
	assert.equal(roughContract.scenes.find((scene) => scene.id === "required-wait").source.speed, 2.5);
	assert.ok(roughProject.editor.clipRegions.some((clip) => clip.speed === 1));
	assert.equal(roughProject.editor.connectZooms, true);
	assert.equal(roughProject.editor.zoomInDurationMs, 550);
	assert.equal(roughProject.editor.zoomInEasing, "smooth");
	assert.equal(roughProject.editor.zoomRegions.length, 1);
	assert.equal(
		roughContract.visualBeats.find((beat) => beat.id === "search-target").visualIntent.zoom,
		true,
	);
	assert.ok(
		roughProject.editor.annotationRegions.every((region) => !region.id.startsWith("stage-prompt-")),
	);
	assert.equal(roughContract.scenes.find((scene) => scene.id === "required-wait").disposition, "speed");
	assert.equal(roughContract.scenes.find((scene) => scene.id === "loading").disposition, "remove");
	assert.equal(roughContract.inputs.rawMaster.media.hasAudio, false);
	assert.ok(roughContract.inputs.cursor.mappedSamples >= 2);
	assert.ok(
		roughContract.visualBeats.find((beat) => beat.id === "execute-target").timeline.startMs > 0,
	);

	const planManifestPath = path.join(recordly, "tts-manifest.plan.json");
	run(process.execPath, [
		path.join(workspaceRoot, "scripts", "generate-recordly-tts.mjs"),
		root,
		"--plan-only",
		`--output=${planManifestPath}`,
	]);
	const planManifest = JSON.parse(await readFile(planManifestPath, "utf8"));
	assert.equal(planManifest.status, "planned");
	assert.equal(planManifest.scenes.length, 2);
	assert.match(planManifest.scenes[0].plan.cacheKey, /^[0-9a-f]{64}$/);
	assert.equal(planManifest.scenes[0].plan.speed, 0.95);

	const cacheDirectory = path.join(root, "workspace-tts-cache");
	await mkdir(cacheDirectory, { recursive: true });
	for (const scene of planManifest.scenes) {
		const wavPath = path.join(cacheDirectory, `${scene.plan.cacheKey}.wav`);
		run("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=24000:cl=mono",
			"-t",
			"0.5",
			"-c:a",
			"pcm_s16le",
			"-y",
			wavPath,
		]);
	}
	const cacheBytesBefore = new Map();
	for (const scene of planManifest.scenes) {
		const wavPath = path.join(cacheDirectory, `${scene.plan.cacheKey}.wav`);
		cacheBytesBefore.set(scene.sceneId, await readFile(wavPath));
	}
	const ttsManifestPath = path.join(recordly, "tts-manifest.json");
	run(process.execPath, [
		path.join(workspaceRoot, "scripts", "generate-recordly-tts.mjs"),
		root,
		`--cache-dir=${cacheDirectory}`,
		`--output=${ttsManifestPath}`,
	]);
	const ttsManifest = JSON.parse(await readFile(ttsManifestPath, "utf8"));
	assert.equal(ttsManifest.status, "completed");
	assert.equal(ttsManifest.scenes.length, 2);
	assert.ok(ttsManifest.scenes.every((scene) => scene.cacheStatus === "hit"));
	assert.ok(ttsManifest.scenes.every((scene) => scene.audioPath.endsWith(".wav")));
	for (const scene of planManifest.scenes) {
		const wavPath = path.join(cacheDirectory, `${scene.plan.cacheKey}.wav`);
		assert.ok(cacheBytesBefore.get(scene.sceneId).equals(await readFile(wavPath)));
	}
	run(process.execPath, [
		path.join(workspaceRoot, "scripts", "generate-recordly-tts.mjs"),
		root,
		`--cache-dir=${cacheDirectory}`,
		`--output=${ttsManifestPath}`,
	]);
	for (const scene of planManifest.scenes) {
		const wavPath = path.join(cacheDirectory, `${scene.plan.cacheKey}.wav`);
		assert.ok(cacheBytesBefore.get(scene.sceneId).equals(await readFile(wavPath)));
	}
	const repeatedTtsManifest = JSON.parse(await readFile(ttsManifestPath, "utf8"));
	assert.ok(repeatedTtsManifest.scenes.every((scene) => scene.cacheStatus === "hit"));
	repeatedTtsManifest.scenes[0].durationMs = 999_999;
	await json(ttsManifestPath, repeatedTtsManifest);
	const finalPath = path.join(recordly, "fixture.final.recordly");
	run(process.execPath, [
		path.join(workspaceRoot, "scripts", "build-recordly-project.mjs"),
		root,
		"--mode=final",
		`--tts-manifest=${ttsManifestPath}`,
		`--output=${finalPath}`,
	]);
	const finalProject = JSON.parse(await readFile(finalPath, "utf8"));
	const finalContract = JSON.parse(await readFile(`${finalPath}.contract.json`, "utf8"));
	assert.equal(finalProject.editor.audioRegions.length, 2);
	assert.equal(finalProject.editor.autoCaptions.length, 2);
	assert.ok(finalProject.editor.clipRegions.some((clip) => clip.id === "clip-search-stable-freeze"));
	assert.ok(finalProject.editor.clipRegions.every((clip) => clip.speed <= 2.5));
	assert.ok(finalProject.editor.annotationRegions.some((region) => region.id === "stable-freeze-search"));
	assert.equal(
		finalProject.editor.zoomRegions.find((region) => region.id === "zoom-search-search-target").endMs,
		finalContract.scenes.find((scene) => scene.id === "search").timeline.endMs,
	);
	assert.equal(finalContract.compileMode, "final");
	assert.equal(finalContract.inputs.compilerSha256, await ruleSetSha256(
		new URL("../build-recordly-project.mjs", import.meta.url), "./recordly-narration.mjs", "./publication-contract.mjs",
	));
	assert.equal(finalContract.publicationGate.finalCut, "passed");
	assert.equal(finalContract.policies.editing.maxNonTeachingSpeed, 2.5);
	assert.equal(finalContract.policies.editing.maxStableFreezeMs, 2_000);
	assert.ok(finalContract.inputs.teachingPlan);
	assert.equal(finalContract.inputs.storyboard, undefined);
	assert.ok(finalContract.visualBeats.every((beat) => beat.visualIntent.typing === false));
	assert.ok(finalProject.editor.annotationRegions.every((region) => !region.id.startsWith("typing-")));
	assert.ok(finalContract.inputs.audio.every((item) => item.durationSource === "ffprobe"));
	assert.ok(finalContract.inputs.audio.every((item) => item.durationMs < 1_000));

	const previewPath = path.join(recordly, "risk-preview.recordly");
	run(process.execPath, [path.join(workspaceRoot, "scripts", "build-recordly-project.mjs"),
		root, "--mode=final", "--risk-scenes=required-wait,search", `--output=${previewPath}`]);
	const preview = JSON.parse(await readFile(`${previewPath}.contract.json`, "utf8"));
	assert.equal(preview.mode, "focused-preview");
	assert.deepEqual(preview.scenes.map((scene) => scene.id), ["search", "loading", "required-wait"]);

	console.log("recordly pipeline fixture: passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
