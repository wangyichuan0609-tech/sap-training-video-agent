import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertPublishableOperation } from "./operation-evidence.mjs";
import { structuredPlan } from "./operation-plan.mjs";

const isSha256 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const planHash = (contract) => contract.inputs?.teachingPlan?.sha256 ?? contract.inputs?.storyboard?.sha256;

// Artifact rule versions include the entry point and its local rule modules.
export async function ruleSetSha256(entryUrl, ...modules) {
	const urls = [new URL(entryUrl), ...modules.map((name) => new URL(name, entryUrl))];
	const hashes = await Promise.all(urls.map(async (url) => digest(await readFile(url))));
	return digest(JSON.stringify(hashes));
}

export function runSourceSha256(run) {
	// Validation updates these output sections in place after the compile.
	const { publication, video, ...inputs } = run;
	const { status, output, resolution, frameRate, duration, sizeBytes, sha256, playbackRate, verification, ...sourceVideo } = video ?? {};
	const { ffprobe, fullDecode, avDurationDelta, timeline, ...sourceVerification } = verification ?? {};
	if (Object.keys(sourceVerification).length) sourceVideo.verification = sourceVerification;
	if (Object.keys(sourceVideo).length) inputs.video = sourceVideo;
	const { finalMp4Generated, finalMp4Path, sha256: outputHash, validation, ...sourcePublication } = publication ?? {};
	const { ffprobe: probe, fullDecode: decode, focusedPreview, timeline: checkedTimeline, ...sourceValidation } = validation ?? {};
	if (Object.keys(sourceValidation).length) sourcePublication.validation = sourceValidation;
	if (Object.keys(sourcePublication).length) inputs.publication = sourcePublication;
	return digest(JSON.stringify(inputs));
}

export async function assertPublishableRun(contract, requestedPath) {
	const declared = contract.inputs?.runJson?.path;
	assert(typeof declared === "string" && path.basename(declared).toLowerCase() === "run.json",
		"Full publication requires an authoritative run.json in the compile contract.");
	const absolute = path.resolve(declared);
	assert(!requestedPath || path.resolve(requestedPath) === absolute,
		"--run-json must match the authoritative run.json in the compile contract.");
	const run = JSON.parse(await readFile(absolute, "utf8"));
	assert((run.run || path.basename(path.dirname(absolute))) === contract.run,
		"Authoritative run identity differs from the compile contract.");
	if (contract.inputs.runJson.sourceSha256 !== undefined) {
		assert.equal(runSourceSha256(run), contract.inputs.runJson.sourceSha256,
			"Run inputs changed after compilation; rebuild the contract before publication.");
	}
	let timeline;
	if (structuredPlan(run.operation)) {
		const log = contract.inputs.actionLog;
		const bytes = await readFile(log.path);
		assert.equal(digest(bytes), log.sha256, "Action evidence changed after compilation.");
		timeline = JSON.parse(bytes);
	}
	assertPublishableOperation(run, { timeline, durationMs: contract.inputs.rawMaster?.media?.durationMs });
	return run;
}

export function assertCompiledContract(contract, contractPath, expectedMode) {
	assert(contract.mode === expectedMode && (!contract.compileMode || contract.compileMode === "final"),
		`Expected a final-cut ${expectedMode} contract: ${contractPath}`);
	assert(typeof contract.run === "string" && contract.run.trim(), `Missing Recordly run identity: ${contractPath}`);
	assert(contract.publicationGate?.compile === "passed" && Array.isArray(contract.manualHelp) && !contract.manualHelp.length,
		`Recordly compile gate has not passed cleanly: ${contractPath}`);
	assert(isSha256(contract.inputs?.runJson?.sha256) && isSha256(planHash(contract)) &&
		isSha256(contract.inputs?.recordlyVideoSha256), `Invalid Recordly input hashes: ${contractPath}`);
}

// Only audio played by reviewed Scenes belongs to the focused review. A regenerated
// WAV for an unrelated Scene must not invalidate this review.
function selectedAudio(contract, ids) {
	assert(Array.isArray(contract.inputs.audio), "Missing compiled audio inputs.");
	const rows = contract.inputs.audio.filter((item) => ids.has(item.sceneId));
	assert(rows.every((item) => isSha256(item.sha256) && Number.isFinite(item.durationMs) && item.durationMs > 0),
		"Invalid reviewed audio binding.");
	return rows.map(({ sceneId, sha256, durationMs }) => [sceneId, sha256, durationMs]);
}

export async function assertRenderInputs(contract) {
	// Recordly reads these live paths during export. Action geometry is already compiled.
	assert(Array.isArray(contract.inputs.audio), "Missing compiled audio inputs.");
	const master = contract.inputs.rawMaster ?? { path: contract.inputs.recordlyVideoPath, sha256: contract.inputs.recordlyVideoSha256 };
	assert.equal(master.sha256, contract.inputs.recordlyVideoSha256, "Raw Master hashes disagree in compile contract.");
	for (const item of [master, contract.inputs.cursor, ...contract.inputs.audio]) {
		assert(typeof item?.path === "string" && isSha256(item.sha256), "Invalid compiled render input.");
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(item.path)) hash.update(chunk);
		assert.equal(hash.digest("hex"), item.sha256,
			`Render input changed after compilation: ${item.path}`);
	}
}

export function reviewedPreviewEvidence(focused, full) {
	assertCompiledContract(focused, "focused preview", "focused-preview");
	assertCompiledContract(full, "full export", "full");
	const review = focused.focusedPreviewReview;
	assert(focused.publicationGate.focusedPreview === "passed" && focused.validation?.status === "passed" &&
		review?.mediaValidation === "passed" && review.visualReview === "passed" &&
		isSha256(review.mediaSha256) && review.mediaSha256 === focused.validation.sha256 &&
		typeof review.reviewedAt === "string" && Number.isFinite(Date.parse(review.reviewedAt)),
		"Focused Preview must pass media validation and explicit visual review.");
	assert(focused.run === full.run && focused.inputs.runJson.sha256 === full.inputs.runJson.sha256 &&
		planHash(focused) === planHash(full) && focused.inputs.recordlyVideoSha256 === full.inputs.recordlyVideoSha256,
		"Focused Preview and full export must use the same run, teaching plan and Raw Master.");
	assert.equal(focused.inputs.compilerSha256, full.inputs.compilerSha256, "Preview compiler changed.");
	const scenes = focused.scenes?.filter((scene) => scene.disposition !== "remove");
	assert(scenes?.length && Array.isArray(full.scenes), "Missing reviewed Scenes in compile contract.");
	const ids = new Set(scenes.map((scene) => scene.id));
	const matching = full.scenes.filter((scene) => ids.has(scene.id) && scene.disposition !== "remove");
	assert.deepEqual(matching.map((scene) => scene.id), [...ids], "Reviewed Scenes changed.");
	assert.deepEqual(selectedAudio(focused, ids), selectedAudio(full, ids), "Audio for a reviewed Scene changed.");
	assert.deepEqual(scenes.map((scene) => scene.endCard?.imageSha256), matching.map((scene) => scene.endCard?.imageSha256),
		"End card image for a reviewed Scene changed.");
	for (const key of ["cursor", "actionLog"]) {
		assert(isSha256(focused.inputs[key]?.sha256) && isSha256(full.inputs[key]?.sha256),
			`Missing ${key} hash in the compile contract.`);
	}
	const sameSidecars = ["cursor", "actionLog"].every((key) => focused.inputs[key].sha256 === full.inputs[key].sha256);
	if (!sameSidecars) {
		// Legacy contracts have whole-file hashes only. Recompile if either changed.
		for (const [index, scene] of scenes.entries()) {
			assert(isSha256(scene.previewTelemetrySha256) && scene.previewTelemetrySha256 === matching[index].previewTelemetrySha256,
				`Browser actions or cursor for reviewed Scene ${scene.id} changed; rebuild its preview.`);
		}
	}
	return { ...review, run: focused.run, runJsonSha256: focused.inputs.runJson.sha256,
		teachingPlanSha256: planHash(focused), recordlyVideoSha256: focused.inputs.recordlyVideoSha256 };
}

