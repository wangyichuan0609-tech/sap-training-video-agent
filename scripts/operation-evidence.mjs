import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertOperationPlan, structuredPlan } from "./operation-plan.mjs";

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

function timelineEvents(log) {
	const events = Array.isArray(log) ? log : (log?.timeline ?? log?.actions);
	if (!Array.isArray(events)) throw new Error("A recorded action timeline is required.");
	return events;
}

export function assertPublishableOperation(run, { timeline, durationMs } = {}) {
	if (run?.operation?.completed !== true) throw new Error("SAP operation has no confirmed completion.");
	if (run.blocker != null && run.blocker !== false && run.blocker !== "" &&
		!(Array.isArray(run.blocker) && run.blocker.length === 0)) throw new Error("SAP run has an unresolved blocker.");
	assertOperationPlan(run);
	if (!structuredPlan(run.operation)) return;
	const events = new Set(timelineEvents(timeline).map((event) => event.eventId ?? event.id ?? event.actionId).filter(hasText));
	for (const step of run.operation.plan) {
		if (step.required === false && step.status === "skipped") continue;
		const evidence = step.observation;
		if (step.status !== "completed" || !hasText(evidence?.visibleResult)) {
			throw new Error(`Step ${step.id} has no confirmed visible result.`);
		}
		const ids = evidence.eventIds ?? [];
		if (!Array.isArray(ids) || !ids.every((id) => hasText(id) && events.has(id))) {
			throw new Error(`Step ${step.id} references an unknown capture event.`);
		}
		const time = evidence.sourceTimeMs;
		if (time !== undefined && (!Number.isFinite(time) || time < 0 || !Number.isFinite(durationMs) || time >= durationMs)) {
			throw new Error(`Step ${step.id} has an invalid Raw Master frame time.`);
		}
		if (!ids.length && time === undefined) throw new Error(`Step ${step.id} needs an event or a visible result frame.`);
	}
}

const editingEvents = new Set(["input", "change", "keydown", "keyup"]);
const commandKeys = new Set(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]);

export function summarizeTimeline(log) {
	const groups = [];
	let previousType;
	for (const event of timelineEvents(log)) {
		const id = event.eventId ?? event.id ?? event.actionId;
		const time = event.sourceTimeMs;
		if (!hasText(id) || !Number.isFinite(time)) throw new Error("Timeline event lacks its id or sourceTimeMs.");
		const control = event.target;
		const targetId = control?.targetId ?? control?.selector ?? control?.id;
		const key = typeof event.key === "string" ? event.key : event.key?.key;
		const command = (event.type === "keydown" || event.type === "keyup") && commandKeys.has(key);
		const kind = command ? key : editingEvents.has(event.type) ? "edit" : event.type;
		const frameId = event.frame?.frameId;
		const previous = groups.at(-1);
		// A separate Enter/Tab press remains visible even if it immediately follows the first.
		const keyRelease = command && event.type === "keyup" && previousType === "keydown";
		if ((kind === "edit" || keyRelease) && targetId && previous?.kind === kind &&
			previous.targetId === targetId && time >= previous.endMs && time - previous.endMs <= 1500 &&
			previous.segment === event.assemblyProvenance?.segmentIndex && previous.frameId === frameId &&
			previous.documentId === event.documentId) {
			previous.lastEventId = id;
			previous.endMs = time;
			previous.count++;
		} else {
			groups.push({ kind, targetId, control: control?.name || control?.controlType, frameId,
				documentId: event.documentId, segment: event.assemblyProvenance?.segmentIndex,
				startMs: time, endMs: time, firstEventId: id, lastEventId: id, count: 1 });
		}
		previousType = event.type;
	}
	return groups;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const [directory] = process.argv.slice(2);
	if (!directory) throw new Error("Usage: node scripts/operation-evidence.mjs <run-directory>");
	const runDirectory = path.resolve(directory);
	const run = JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8"));
	assertOperationPlan(run);
	const declared = run.capture?.actionLog ?? run.artifacts?.actionLog;
	const logPath = path.resolve(runDirectory, (typeof declared === "string" ? declared : declared?.path) ?? "capture/action-log.json");
	const timeline = JSON.parse(await readFile(logPath, "utf8"));
	console.log(JSON.stringify({ operationPlan: run.operation.plan, actionLog: path.relative(runDirectory, logPath),
		actions: summarizeTimeline(timeline) }, null, 2));
}
