#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	copyFile,
	link,
	mkdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { narrationUnits, planNarration, runCosyVoiceBatch } from "./recordly-narration.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(scriptDirectory);

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

async function sha256File(filePath) {
	const hash = createHash("sha256");
	hash.update(await readFile(filePath));
	return hash.digest("hex");
}

function runCommand(command, args, label) {
	const result = spawnSync(command, args, {
		cwd: workspaceRoot,
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

function probeDurationMs(filePath) {
	const output = runCommand(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			filePath,
		],
		`ffprobe narration ${filePath}`,
	).trim();
	const seconds = Number(output);
	if (!Number.isFinite(seconds) || seconds <= 0) fail(`Narration WAV duration is invalid: ${filePath}`);
	return Math.max(1, Math.round(seconds * 1000));
}

async function trimTrailingSilence(filePath) {
	const temporaryPath = `${filePath}.${process.pid}.trim.wav`;
	try {
		runCommand(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				filePath,
				"-af",
				"silenceremove=stop_periods=-1:stop_duration=0.08:stop_threshold=-45dB",
				"-c:a",
				"pcm_s16le",
				"-y",
				temporaryPath,
			],
			`FFmpeg trailing-silence trim ${filePath}`,
		);
		if (!(await stat(temporaryPath)).size) fail(`Trailing-silence trim produced an empty WAV: ${filePath}`);
		await unlink(filePath);
		await rename(temporaryPath, filePath);
	} finally {
		if (existsSync(temporaryPath)) await unlink(temporaryPath);
	}
}

function declaredPath(value) {
	if (typeof value === "string" && value.trim()) return value;
	if (value && typeof value === "object" && typeof value.path === "string" && value.path.trim()) {
		return value.path;
	}
	return null;
}

function resolveFrom(baseDirectory, value) {
	const normalized = declaredPath(value);
	return normalized ? path.resolve(baseDirectory, normalized) : null;
}

function safeFileStem(value) {
	const stem = String(value).replaceAll(/[^a-zA-Z0-9._-]/g, "-").replaceAll(/-+/g, "-");
	return stem.replaceAll(/^-|-$/g, "") || "scene";
}

function parseRedo(value) {
	if (!value) return new Set();
	return new Set(
		String(value)
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

async function materializeAudio(cachePath, runAudioPath) {
	await mkdir(path.dirname(runAudioPath), { recursive: true });
	if (existsSync(runAudioPath)) {
		if ((await sha256File(runAudioPath)) === (await sha256File(cachePath))) return "existing";
		await unlink(runAudioPath);
	}
	try {
		await link(cachePath, runAudioPath);
		return "hardlink";
	} catch {
		await copyFile(cachePath, runAudioPath);
		return "copy";
	}
}

async function main() {
	const { options, positional } = parseArgs(process.argv.slice(2));
	if (!positional[0]) {
		fail(
			"Usage: node scripts/generate-recordly-tts.mjs <run-directory-or-run.json> [--plan=<teaching-plan.json>] [--output=<tts-manifest.json>] [--cache-dir=<directory>] [--python=<python.exe>] [--redo=<scene-id,...|all>] [--plan-only]",
		);
	}

	const inputPath = path.resolve(positional[0]);
	const inputStats = await stat(inputPath);
	const runJsonPath = inputStats.isDirectory() ? path.join(inputPath, "run.json") : inputPath;
	if (path.basename(runJsonPath).toLowerCase() !== "run.json") {
		fail(`Expected a run directory or run.json, received: ${inputPath}`);
	}
	const runDirectory = path.dirname(runJsonPath);
	const run = await readJson(runJsonPath);
	const runName = run.run || path.basename(runDirectory);
	const planPath = options.plan
		? path.resolve(String(options.plan))
		: resolveFrom(runDirectory, run.video?.teachingPlan) ||
			resolveFrom(runDirectory, run.teachingPlan) ||
			path.join(runDirectory, "recordly", "teaching-plan.json");
	if (!existsSync(planPath)) fail(`Agent teaching plan does not exist: ${planPath}`);
	const teachingPlan = await readJson(planPath);
	if (!Array.isArray(teachingPlan.scenes) || teachingPlan.scenes.length === 0) {
		fail(`Agent teaching plan has no Scenes: ${planPath}`);
	}

	const units = narrationUnits(teachingPlan.scenes);
	if (units.length === 0) fail("Agent teaching plan contains no Narration Script text.");

	const outputPath = path.resolve(
		options.output ||
			path.join(
				runDirectory,
				"recordly",
				options["plan-only"] ? "tts-manifest.plan.json" : "tts-manifest.json",
			),
	);
	const planById = await planNarration(units, options.python);

	const planSha256 = await sha256File(planPath);
	const runSha256 = await sha256File(runJsonPath);
	if (options["plan-only"]) {
		await writeJsonAtomic(outputPath, {
			schemaVersion: 1,
			status: "planned",
			createdAt: new Date().toISOString(),
			run: runName,
			runJson: { path: runJsonPath, sha256: runSha256 },
			teachingPlan: { path: planPath, sha256: planSha256 },
			provider: "CosyVoice",
			scenes: units.map((unit) => ({
				sceneId: unit.id,
				narration: unit.text,
				plan: planById.get(unit.id),
			})),
		});
		console.log(JSON.stringify({ status: "planned", manifest: outputPath, scenes: units.length }, null, 2));
		return;
	}

	const cacheRoot = path.resolve(String(options["cache-dir"] || path.join(workspaceRoot, "assets", "tts-cache")));
	const runAudioDirectory = path.join(runDirectory, "recordly", "audio");
	await mkdir(cacheRoot, { recursive: true });
	await mkdir(runAudioDirectory, { recursive: true });
	const redo = parseRedo(options.redo);
	const generationItems = [];
	const cacheStatusById = new Map();
	for (const unit of units) {
		const plan = planById.get(unit.id);
		const cachePath = path.join(cacheRoot, `${plan.cacheKey}.wav`);
		const force = redo.has("all") || redo.has(unit.id);
		if (force && existsSync(cachePath)) await unlink(cachePath);
		if (existsSync(cachePath) && (await stat(cachePath)).size > 0) {
			cacheStatusById.set(unit.id, "hit");
			continue;
		}
		generationItems.push({
			id: unit.id,
			text: unit.text,
			...(unit.speed === undefined ? {} : { speed: unit.speed }),
			output: cachePath,
		});
		cacheStatusById.set(unit.id, "generated");
	}

	if (generationItems.length > 0) {
		const generationResults = await runCosyVoiceBatch("generate", generationItems, options.python);
		const generatedPlanById = new Map(generationResults.map((item) => [item.id, item.plan]));
		for (const item of generationItems) {
			const generatedPlan = generatedPlanById.get(item.id);
			if (generatedPlan?.cacheKey !== planById.get(item.id)?.cacheKey) {
				fail(`CosyVoice inputs changed between planning and generation for ${item.id}`);
			}
		}
	}

	const manifestScenes = [];
	for (const unit of units) {
		const plan = planById.get(unit.id);
		const cachePath = path.join(cacheRoot, `${plan.cacheKey}.wav`);
		if (!existsSync(cachePath) || (await stat(cachePath)).size <= 0) {
			fail(`CosyVoice cache WAV is missing after generation: ${cachePath}`);
		}
		// A cache object is immutable once materialized. Trim only newly generated
		// audio; a cache hit must never shorten an already accepted WAV again.
		if (cacheStatusById.get(unit.id) === "generated") {
			await trimTrailingSilence(cachePath);
		}
		const runAudioPath = path.join(
			runAudioDirectory,
			`${safeFileStem(unit.id)}-${plan.cacheKey.slice(0, 12)}.wav`,
		);
		const materialization = await materializeAudio(cachePath, runAudioPath);
		const durationMs = probeDurationMs(runAudioPath);
		const audioSha256 = await sha256File(runAudioPath);
		manifestScenes.push({
			sceneId: unit.id,
			narration: unit.text,
			finalTtsText: plan.finalTtsText,
			cacheKey: plan.cacheKey,
			cacheStatus: cacheStatusById.get(unit.id),
			cachePath,
			audioPath: path.relative(runDirectory, runAudioPath).replaceAll("\\", "/"),
			audioSha256,
			durationMs,
			materialization,
			plan,
		});
	}

	const manifest = {
		schemaVersion: 1,
		status: "completed",
		createdAt: new Date().toISOString(),
		run: runName,
		runJson: { path: runJsonPath, sha256: runSha256 },
		teachingPlan: { path: planPath, sha256: planSha256 },
		provider: "CosyVoice",
		cache: { scope: "workspace", root: cacheRoot },
		scenes: manifestScenes,
	};
	await writeJsonAtomic(outputPath, manifest);
	console.log(
		JSON.stringify(
			{
				status: "completed",
				manifest: outputPath,
				scenes: manifestScenes.length,
				cacheHits: manifestScenes.filter((scene) => scene.cacheStatus === "hit").length,
				generated: generationItems.length,
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
