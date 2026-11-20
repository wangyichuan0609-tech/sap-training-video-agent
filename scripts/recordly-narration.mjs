import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const batchAction = path.join(workspaceRoot, "actions", "tts", "cosyvoice_batch.py");

export function narrationText(scene) {
	const candidates = [
		typeof scene.narration === "string" ? scene.narration : scene.narration?.text,
		scene.narrationScript,
		scene.script,
	];
	const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
	return value ? value.trim() : null;
}

export function narrationUnits(scenes) {
	const units = [];
	const ids = new Set();
	for (const scene of scenes) {
		if (!scene || typeof scene.id !== "string" || !scene.id.trim()) {
			throw new Error("Every teaching-plan Scene must have a non-empty id.");
		}
		if (ids.has(scene.id)) throw new Error(`Duplicate teaching-plan Scene id: ${scene.id}`);
		ids.add(scene.id);
		const text = narrationText(scene);
		if (!text) continue;
		const unit = { id: scene.id, text };
		const requestedSpeed = scene.ttsSpeed ?? scene.narrationSpeed;
		if (requestedSpeed != null) {
			unit.speed = Number(requestedSpeed);
			if (!Number.isFinite(unit.speed) || unit.speed <= 0) {
				throw new Error(`Scene ${scene.id} has an invalid TTS speed: ${requestedSpeed}`);
			}
		}
		units.push(unit);
	}
	return units;
}

export async function runCosyVoiceBatch(mode, items, python) {
	const pythonPaths = [
		python,
		process.env.COSYVOICE_PYTHON,
		path.join(workspaceRoot, ".venv-cosyvoice", "Scripts", "python.exe"),
	];
	const executable = pythonPaths.filter(Boolean).map((candidate) => path.resolve(String(candidate))).find(existsSync) ?? "python";
	const prefix = path.join(tmpdir(), `recordly-cosyvoice-${randomUUID()}`);
	const input = `${prefix}.input.json`;
	const output = `${prefix}.output.json`;
	try {
		await writeFile(input, JSON.stringify(items), "utf8");
		const result = spawnSync(executable, [batchAction, `--mode=${mode}`, `--input=${input}`, `--output=${output}`], {
			cwd: workspaceRoot, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`CosyVoice ${mode} failed: ${result.stderr || result.stdout}`);
		return JSON.parse(await readFile(output, "utf8"));
	} finally {
		await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
	}
}

// The Python plan mode computes current language, reference, pronunciation and synthesis
// signatures without importing the inference model or generating audio.
export async function planNarration(units, python) {
	const results = units.length ? await runCosyVoiceBatch("plan", units, python) : [];
	const plans = new Map(results.map(({ id, plan }) => [id, plan]));
	for (const unit of units) {
		if (!/^[0-9a-f]{64}$/i.test(plans.get(unit.id)?.cacheKey ?? "")) {
			throw new Error(`CosyVoice returned no valid cache plan for ${unit.id}`);
		}
	}
	return plans;
}

export async function matchManifestNarration(scenes, manifest, python) {
	const units = narrationUnits(scenes);
	if (manifest.provider !== "CosyVoice") throw new Error("The TTS manifest must use CosyVoice.");
	const entries = new Map(manifest.scenes.map((entry) => [entry.sceneId, entry]));
	if (entries.size !== manifest.scenes.length || entries.size !== units.length) {
		throw new Error("The narrated Scenes changed. Refresh the TTS manifest with generate-recordly-tts.mjs.");
	}
	const plans = await planNarration(units, python);
	for (const { id, text } of units) {
		const entry = entries.get(id);
		if (!entry || entry.narration !== text || entry.cacheKey !== plans.get(id).cacheKey || entry.plan?.cacheKey !== entry.cacheKey) {
			throw new Error(`Speech inputs changed or are unverified for Scene ${id}. Refresh the TTS manifest with generate-recordly-tts.mjs.`);
		}
	}
	return entries;
}
