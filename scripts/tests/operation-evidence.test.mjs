import assert from "node:assert/strict";
import test from "node:test";
import { assertOperationPlan } from "../operation-plan.mjs";
import { assertPublishableOperation, summarizeTimeline } from "../operation-evidence.mjs";

const event = { eventId: "click-1", type: "click", sourceTimeMs: 200 };
const recorded = { timeline: [event], durationMs: 1500 };
function makeRun() {
	return { sourcePptx: { slideCount: 3 }, blocker: null, operation: {
		completed: true, planVersion: 2, plan: [{
			id: "save", sourceSlide: 3, action: "Save", expectedResult: "A document number is visible",
			status: "completed", observation: { visibleResult: "New document confirmed on the page", eventIds: ["click-1"], sourceTimeMs: 1100 }
		}]
	} };
}

test("publication needs the visible result and a real event or frame for each required step", () => {
	const run = makeRun();
	assert.doesNotThrow(() => assertPublishableOperation(run, recorded));
	const step = run.operation.plan[0];
	step.status = "uncertain";
	assert.throws(() => assertPublishableOperation(run, recorded), /confirmed visible result/);
	step.status = "completed";
	step.observation.eventIds = ["invented"];
	assert.throws(() => assertPublishableOperation(run, recorded), /unknown capture event/);
	step.observation.eventIds = [];
	assert.doesNotThrow(() => assertPublishableOperation(run, recorded));
	step.observation.sourceTimeMs = 1500;
	assert.throws(() => assertPublishableOperation(run, recorded), /invalid Raw Master/);
	delete step.observation.sourceTimeMs;
	assert.throws(() => assertPublishableOperation(run, recorded), /event or a visible result frame/);
});

test("PPT source, input role and active blockers survive the handoff", () => {
	const run = makeRun();
	const step = run.operation.plan[0];
	step.inputs = [{field: "Plant", value: "0007", kind: "example"}];
	assert.doesNotThrow(() => assertOperationPlan(run));
	step.sourceSlide = 6;
	assert.throws(() => assertOperationPlan(run), /sourceSlide/);
	step.sourceSlide = 1;
	step.inputs[0].kind = "arbitrary";
	assert.throws(() => assertOperationPlan(run), /required\/example/);
	const legacy = {operation: {completed: true, plan: ["View the list"]}};
	assert.doesNotThrow(() => assertPublishableOperation(legacy));
	assert.throws(() => assertPublishableOperation({...legacy, blocker: "Pending SAP error"}), /unresolved blocker/);
	legacy.operation.completed = false;
	assert.throws(() => assertPublishableOperation(legacy), /no confirmed completion/);
});

test("the action digest groups adjacent input while keeping commands, frames and raw references", () => {
	const row = (type, i, key, segmentIndex = 1) => ({type, eventId: `e${i}`, sourceTimeMs: i * 100,
		key: {key}, target: {targetId: "org", name: "Plant"}, assemblyProvenance: {segmentIndex}});
	const rows = [row("keydown", 1, "X"), row("input", 2), row("keyup", 3, "X"), row("keydown", 4, "Enter"),
		row("keyup", 5, "Enter"), row("input", 6), row("input", 7, undefined, 2),
		{...row("input", 8, undefined, 2), frame: {frameId: "app-iframe"}}, row("click", 9),
		row("keydown", 10, "Tab"), row("keyup", 11, "Tab"), row("keydown", 12, "Tab"), row("keyup", 13, "Tab")];
	const groups = summarizeTimeline({timeline: rows});
	assert.deepEqual(groups.map(g => [g.kind, g.count]),
		[["edit",3],["Enter",2],["edit",1],["edit",1],["edit",1],["click",1],["Tab",2],["Tab",2]]);
	assert.deepEqual([groups[0].firstEventId, groups[0].lastEventId, groups[0].startMs], ["e1","e3",100]);
	assert.ok(!JSON.stringify(groups).includes('"X"'));
});
