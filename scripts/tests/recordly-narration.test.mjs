import assert from "node:assert/strict";
import test from "node:test";
import { matchManifestNarration, narrationUnits, planNarration } from "../recordly-narration.mjs";

test("a visual edit reuses the original manifest only for the same CosyVoice inputs", async () => {
	const scenes = [
		{ id: "field", narration: { text: "确认 SAP 字段。" }, ttsSpeed: 0.9 },
		{ id: "result", script: "Review the result." },
		{ id: "wait", script: "" },
	];
	const units = narrationUnits(scenes);
	const plans = await planNarration(units);
	const manifest = {
		provider: "CosyVoice",
		scenes: units.map(({ id, text }) => ({
			sceneId: id, narration: text, cacheKey: plans.get(id).cacheKey, plan: plans.get(id),
		})),
	};
	const visualEdit = [
		{ ...scenes[1], sourceEndMs: 3500 },
		{ ...scenes[0], zoom: 1.5, sourceStartMs: 2500 },
		{ id: "another-silent-scene" },
	];
	const reused = await matchManifestNarration(visualEdit, manifest);
	assert.equal(reused.get("field"), manifest.scenes[0]);
	assert.equal(reused.get("result"), manifest.scenes[1]);
	assert.equal(plans.get("result").segments[0].speed, 1);

	for (const field of [
		{ ...scenes[0], ttsSpeed: 0.95 },
		{ ...scenes[0], narration: "确认另一个字段。" },
		{ ...scenes[0], id: "renamed" },
		{ ...scenes[0], narration: "" },
	]) {
		await assert.rejects(matchManifestNarration([field, scenes[1]], manifest), /Refresh the TTS manifest/);
	}
	const priorReference = structuredClone(manifest);
	priorReference.scenes[0].cacheKey = priorReference.scenes[0].plan.cacheKey = "0".repeat(64);
	await assert.rejects(matchManifestNarration(visualEdit, priorReference), /unverified for Scene field/);
});
