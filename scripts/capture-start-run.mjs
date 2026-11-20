import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertOperationPlan, structuredPlan } from "./operation-plan.mjs";

// Both the command-line entry point and the Electron recorder use the same run.
export async function readCaptureStartContext(outputPath, explicitRunPath) {
	let directory = path.dirname(path.resolve(outputPath));
	while (path.basename(directory).toLowerCase() !== "capture" && path.dirname(directory) !== directory) {
		directory = path.dirname(directory);
	}
	const canonical = path.basename(directory).toLowerCase() === "capture"
		? path.join(path.dirname(directory), "run.json") : undefined;
	const manifest = explicitRunPath ? path.resolve(explicitRunPath) : canonical;
	if (!manifest || path.basename(manifest).toLowerCase() !== "run.json") {
		throw new Error("Capture needs <run>/capture/... or --run-json=<run>/run.json.");
	}
	const relative = path.relative(path.dirname(manifest), path.resolve(outputPath));
	if ((canonical && path.relative(canonical, manifest) !== "") || !relative ||
		relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
		throw new Error("Capture output and run.json must belong to the same run.");
	}
	const run = JSON.parse((await readFile(manifest, "utf8")).replace(/^\uFEFF/u, ""));
	return captureStartContext(run, path.dirname(manifest));
}

async function recordedSegmentOrigin(segment, runDirectory) {
	const log = segment.artifacts?.actionLog;
	const declaredPath = typeof log === "string" ? log : log?.path;
	if (typeof declaredPath !== "string" || !declaredPath.trim() ||
		typeof segment.sessionId !== "string" || !Number.isInteger(segment.sourceWebContentsId)) {
		throw new Error("Resume needs the previous segment's action log, sessionId and sourceWebContentsId.");
	}
	const logPath = path.resolve(runDirectory, declaredPath);
	const relative = path.relative(runDirectory, logPath);
	if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
		throw new Error("The recovery action log must belong to the same run.");
	}
	const bytes = await readFile(logPath);
	if (log.sha256 && createHash("sha256").update(bytes).digest("hex") !== log.sha256.toLowerCase()) {
		throw new Error("The previous segment's action log changed.");
	}
	const document = JSON.parse(bytes.toString("utf8"));
	if (document.sessionId !== segment.sessionId || document.sourceWebContentsId !== segment.sourceWebContentsId ||
		!Array.isArray(document.timeline) || !document.timeline.length) {
		throw new Error("The previous segment has no matching recorded action timeline.");
	}
	const origins = new Set(document.timeline.filter((event) => event.frame?.isMainFrame !== false)
		.map((event) => new URL(event.url).origin));
	if (origins.size !== 1) throw new Error("The previous segment does not establish a unique SAP origin.");
	return [...origins][0];
}

async function captureStartContext(run, runDirectory) {
	if (run?.operation?.completed === true) throw new Error("The SAP operation is already complete.");
	const capture = run.capture ?? {};
	const evidence = capture.segmentEvidence ?? [];
	const segments = capture.segments ?? [];
	if (!Array.isArray(evidence) || !Array.isArray(segments)) throw new Error("Invalid capture segment history.");
	const resume = evidence.length > 0 || segments.length > 0 || Boolean(capture.recoveryPage);
	if (!resume && !structuredPlan(run.operation)) {
		throw new Error("First capture needs a structured operation.plan with slide references and expected results.");
	}
	assertOperationPlan(run);
	const { system, client, origin } = run?.environment ?? {};
	if (!["DEV", "QAS"].includes(system) || typeof client !== "string" || !/^\d{3}$/u.test(client)) {
		throw new Error("run.json requires a verified DEV/QAS environment.system and three-digit environment.client.");
	}
	let recordedOrigin;
	let recoveryPage;
	if (resume) {
		// Older single-segment runs recorded the same session fields directly on capture.
		const previous = evidence.at(-1) ?? (segments.length ? {
			...capture, safeRecoveryPoint: run.safeRecoveryPoint, artifacts: { actionLog: capture.actionLog },
		} : null);
		const point = run.safeRecoveryPoint;
		const page = capture.recoveryPage;
		const marker = typeof page?.visibleText === "string" ? page.visibleText.trim().replace(/\s+/gu, " ") : "";
		if (!previous || !["completed", "failed", "interrupted"].includes(previous.status) ||
			typeof point !== "string" || !point.trim() || previous.safeRecoveryPoint !== point ||
			typeof page?.title !== "string" || !page.title.trim() ||
			!marker || /^(ok|yes|no|save|cancel|close|back|next|continue|submit|confirm|open search|返回|取消|保存|确定|确认|关闭|提交|继续|下一步)$/iu.test(marker) ||
			page.title.trim().toLowerCase() === marker.toLowerCase()) {
			throw new Error("Resume needs the previous segment's confirmed safeRecoveryPoint and capture.recoveryPage {title, visibleText} from that business page.");
		}
		recordedOrigin = await recordedSegmentOrigin(previous, runDirectory);
		recoveryPage = { title: page.title.trim(), visibleText: marker };
	}
	const expected = origin ?? recordedOrigin;
	let target;
	try { target = new URL(expected); } catch { /* Use a non-sensitive error below. */ }
	if (!target || target.protocol !== "https:" || target.origin !== String(expected).replace(/\/$/u, "") ||
		(recordedOrigin && target.origin !== recordedOrigin)) {
		throw new Error("Use environment.origin from the verified DEV/QAS connection (HTTPS origin only) and the same origin as the previous segment.");
	}
	return { system, origin: target.origin, client, ...(recoveryPage ? { recoveryPage } : {}) };
}
