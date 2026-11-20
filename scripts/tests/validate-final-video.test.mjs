import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { reviewedPreviewEvidence, runSourceSha256 } from "../publication-contract.mjs";

const validator = fileURLToPath(new URL("../validate-final-video.mjs", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file, value) => writeFile(file, JSON.stringify(value));
function run(command, args, env = process.env) {
	return spawnSync(command, args, { encoding: "utf8", windowsHide: true, env });
}
function succeeded(result) {
	assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

test("focused review reuses validation only for unchanged media and validation inputs", async (t) => {
	const root = path.resolve(await mkdtemp(path.join(os.tmpdir(), "recordly-validation-test-")));
	try {
		const mediaPath = path.join(root, "preview.mp4");
		const projectPath = path.join(root, "focused.recordly");
		const contractPath = `${projectPath}.contract.json`;
		const runPath = path.join(root, "run.json");
		const runData = { run: "validation-fixture", operation: { completed: true, plan: ["Confirm the saved result"] }, blocker: null };
		await json(runPath, runData);
		const cursorPath = path.join(root, "cursor.json");
		await writeFile(cursorPath, "[]");
		const wavPath = path.join(root, "scene.wav");
		await writeFile(wavPath, "fixture input");
		const masterPath = path.join(root, "source.mp4");
		await writeFile(masterPath, "raw fixture");
		const projectBytes = JSON.stringify({ editor: {
			audioRegions: [{ id: "audio", startMs: 0, endMs: 800 }],
			autoCaptions: [{ id: "caption", text: "测试字幕", startMs: 0, endMs: 800 }],
		} });
		await writeFile(projectPath, projectBytes);
		const compiled = {
			mode: "focused-preview", run: "validation-fixture", projectPath,
			projectSha256: sha256(projectBytes), manualHelp: [],
			scenes: [{ id: "scene", disposition: "keep", previewTelemetrySha256: "f".repeat(64) }],
			inputs: { runJson: { path: runPath, sha256: sha256(JSON.stringify(runData)), sourceSha256: runSourceSha256(runData) },
				teachingPlan: { sha256: "b".repeat(64) }, recordlyVideoPath: masterPath, recordlyVideoSha256: sha256("raw fixture"),
				actionLog: { sha256: "e".repeat(64) }, cursor: { path: cursorPath, sha256: sha256("[]") },
				audio: [{ sceneId: "scene", path: wavPath, sha256: sha256("fixture input"), durationMs: 800 }] },
			publicationGate: { compile: "passed", focusedPreview: "pending", publishable: false },
		};
		await json(contractPath, compiled);
		succeeded(run("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i",
			"color=c=black:s=1920x1080:r=30", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
			"-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", mediaPath]));
		const args = [validator, `--input=${mediaPath}`, `--project=${projectPath}`, `--contract=${contractPath}`, "--gate=focused"];
		// The review command must work without either media executable on PATH.
		const withoutMediaTools = { ...process.env, PATH: root, Path: root };
		const review = (extra = []) => run(process.execPath, [...args, "--visual-review=passed", ...extra], withoutMediaTools);
		await t.test("review cannot precede automated validation", () => {
			const result = review();
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /must pass automated media validation/);
		});
		succeeded(run(process.execPath, args));
		const pending = JSON.parse(await readFile(contractPath, "utf8"));
		const mediaBytes = await readFile(mediaPath);
		const sidecarPath = `${mediaPath}.validation.json`;
		const sidecarBytes = await readFile(sidecarPath);
		assert.equal(pending.validation.timeline.status, "passed");
		assert.match(pending.validation.reviewBindingSha256, /^[0-9a-f]{64}$/);

		await t.test("review records only the visual result and keeps automated evidence intact", async () => {
			const result = review();
			succeeded(result);
			assert.equal(JSON.parse(result.stdout).mediaValidation, "reused");
			const reviewed = JSON.parse(await readFile(contractPath, "utf8"));
			assert.equal(reviewed.publicationGate.focusedPreview, "passed");
			assert.equal(reviewed.publicationGate.publishable, false);
			assert.deepEqual(reviewed.validation, pending.validation);
			assert.ok(Number.isFinite(Date.parse(reviewed.focusedPreviewReview.reviewedAt)));
			assert.deepEqual(await readFile(sidecarPath), sidecarBytes);
			assert.deepEqual(await readFile(mediaPath), mediaBytes);
			assert.equal(await readFile(projectPath, "utf8"), projectBytes);
		});
		await t.test("a changed MP4 of the same size cannot reuse validation", async () => {
			await json(contractPath, pending);
			const changed = Buffer.from(mediaBytes);
			changed[changed.length - 1] ^= 1;
			await writeFile(mediaPath, changed);
			const result = review();
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /exact MP4 and SHA256/);
			await writeFile(mediaPath, mediaBytes);
		});
		await t.test("a changed project cannot reuse validation", async () => {
			await writeFile(projectPath, `${projectBytes}\n`);
			const result = review();
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /project changed after compilation/);
			await writeFile(projectPath, projectBytes);
		});
		await t.test("changed contract, changed tolerances, and old evidence require automated validation", async () => {
			const changed = structuredClone(pending);
			changed.inputs.teachingPlan.sha256 = "d".repeat(64);
			await json(contractPath, changed);
			for (const [contract, extra] of [[changed, []], [pending, ["--av-tolerance-ms=300"]],
				[pending, ["--timeline-tolerance-ms=100"]],
				[{ ...pending, validation: { ...pending.validation, reviewBindingSha256: undefined } }, []]]) {
				await json(contractPath, contract);
				const result = review(extra);
				assert.notEqual(result.status, 0);
				assert.match(result.stderr, /Rerun automated validation/);
			}
			await json(contractPath, pending);
		});
		await t.test("changed shared validator rules invalidate an otherwise identical visual review", async () => {
			for (const name of ["validate-final-video.mjs", "publication-contract.mjs", "operation-plan.mjs", "operation-evidence.mjs"]) {
				await copyFile(path.join(path.dirname(validator), name), path.join(root, name));
			}
			await appendFile(path.join(root, "publication-contract.mjs"), "\n// Modified fixture rules\n");
			const result = run(process.execPath, [path.join(root, "validate-final-video.mjs"), ...args.slice(1), "--visual-review=passed"], withoutMediaTools);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /Rerun automated validation/);
		});
		await t.test("full publication still requires media tools and complete validation", async () => {
			succeeded(review());
			const finalContractPath = path.join(root, "final.contract.json");
			await json(finalContractPath, { ...compiled, mode: "full" });
			const finalArgs = [validator, `--input=${mediaPath}`, `--project=${projectPath}`,
				`--contract=${finalContractPath}`, "--gate=final", `--focused-contract=${contractPath}`];
			const foreignRun = path.join(root, "other", "run.json");
			assert.match(run(process.execPath, [...finalArgs, `--run-json=${foreignRun}`], withoutMediaTools).stderr, /authoritative run.json/);
			await json(runPath, { ...runData, operation: { ...runData.operation, completed: false } });
			assert.notEqual(run(process.execPath, finalArgs, withoutMediaTools).status, 0);
			await json(runPath, runData);
			await writeFile(wavPath, "different audio");
			assert.match(run(process.execPath, finalArgs, withoutMediaTools).stderr, /Render input changed/);
			await writeFile(wavPath, "fixture input");
			const missingTools = run(process.execPath, finalArgs, withoutMediaTools);
			assert.notEqual(missingTools.status, 0);
			assert.match(missingTools.stderr, /ffprobe/);
			succeeded(run(process.execPath, [...finalArgs, `--run-json=${runPath}`]));
			assert.equal(runSourceSha256(JSON.parse(await readFile(runPath, "utf8"))), runSourceSha256(runData));
			assert.equal(JSON.parse(await readFile(finalContractPath, "utf8")).publicationGate.publishable, true);
			assert.equal(JSON.parse(await readFile(sidecarPath, "utf8")).verification.fullDecode, "passed");
			assert.deepEqual(await readFile(mediaPath), mediaBytes);
		});
		await t.test("only reviewed scene audio and telemetry affect the preview binding", async () => {
			const focused = JSON.parse(await readFile(contractPath, "utf8"));
			const full = structuredClone(focused);
			full.mode = "full";
			full.scenes.push({ id: "later", disposition: "keep", previewTelemetrySha256: "9".repeat(64) });
			full.inputs.audio.push({ sceneId: "later", sha256: "a".repeat(64), durationMs: 700 });
			full.inputs.actionLog.sha256 = "8".repeat(64);
			full.inputs.cursor.sha256 = "7".repeat(64);
			reviewedPreviewEvidence(focused, full);
			full.scenes[0].endCard = { imageSha256: "8".repeat(64) };
			assert.throws(() => reviewedPreviewEvidence(focused, full), /End card image/);
			delete full.scenes[0].endCard;
			full.scenes[0].previewTelemetrySha256 = "6".repeat(64);
			assert.throws(() => reviewedPreviewEvidence(focused, full), /cursor for reviewed Scene/);
			full.scenes[0].previewTelemetrySha256 = focused.scenes[0].previewTelemetrySha256;
			full.inputs.audio[0].sha256 = "5".repeat(64);
			assert.throws(() => reviewedPreviewEvidence(focused, full), /Audio for a reviewed Scene/);
			delete focused.scenes[0].previewTelemetrySha256;
			full.inputs.audio[0].sha256 = focused.inputs.audio[0].sha256;
			assert.throws(() => reviewedPreviewEvidence(focused, full), /cursor for reviewed Scene/);
		});
		await t.test("the export command rejects skipped validation", () => {
			const exporter = fileURLToPath(new URL("../recordly-control.mjs", import.meta.url));
			const result = run(process.execPath, [exporter, "export", "--skip-validation"]);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /Unsupported.*skip-validation/);
		});
	} finally {
		assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
		assert.ok(path.basename(root).startsWith("recordly-validation-test-"));
		await rm(root, { recursive: true, force: true });
	}
});
