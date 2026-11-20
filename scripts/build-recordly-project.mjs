#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { matchManifestNarration, narrationText } from "./recordly-narration.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ruleSetSha256, runSourceSha256 } from "./publication-contract.mjs";

const PROJECT_VERSION = 2;
const MAX_NON_TEACHING_SPEED = 2.5;
const MAX_STABLE_FREEZE_MS = 2_000;
const MAX_PRE_ACTION_HOLD_MS = 2_500;
const RESULT_DWELL_MS = 1_300;
const RESULT_SELECTION_PRE_ACTION_HOLD_MS = 2_500;
const RESULT_CLICK_EVIDENCE_MS = 450;
const FREEZE_SPEED = 0.001;
const FRAME_MS = 1000 / 30;

// The editor timeline is a teaching timeline, not a wall-clock replay. Keep
// real interaction windows at 1x and only compress source spans that contain
// no meaningful browser action or cursor movement.
const ACTION_GROUP_GAP_MS = 350;
const NATURAL_IDLE_GAP_MS = 800;
// Retain only a short real page interval around long gaps. Narration may
// stretch that interval when needed, but silent waits must stay compact.
const MAX_IDLE_DISPLAY_MS = 700;
const ACTION_WINDOW_BEFORE_MS = 500;
const ACTION_WINDOW_AFTER_MS = 800;
const NAVIGATION_WINDOW_AFTER_MS = 1_300;
const INPUT_WINDOW_AFTER_MS = 900;
const MIN_VISUAL_EFFECT_MS = 600;
const ACTION_SUPPORT_RADIUS_MS = 1_500;
const NON_TEACHING_IDLE_SPEED = 2.25;
const ZOOM_IN_LEAD_MS = 900;
const ZOOM_OUT_EARLY_START_MS = 800;
const ZOOM_ANCHOR_DELAY_MS = 800;

// A ZoomRegion is deliberately longer than the source action window. Recordly
// evaluates the camera transition around the region, so a short action window
// must not be reused as a short camera animation.
const ZOOM_IN_DURATION_MS = 550;
const ZOOM_OUT_DURATION_MS = 550;
const CONNECTED_ZOOM_DURATION_MS = 1_900;
const ZOOM_REGION_HOLD_MS = 1_000;
const FIRST_SCENE_CONTEXT_MS = 800;
const ZOOM_TARGET_MAX_DISTANCE = 0.08;

// Captions are a stable output-layer element.  Keep one global anchor for all
// generated teaching projects instead of moving a cue around to avoid a
// transient control.  The video composition must leave the bottom safe area
// readable; caption placement is not a per-scene teaching decision.
const CAPTION_BOTTOM_OFFSET_PERCENT = 0;
const CAPTION_TOP_OFFSET_PERCENT = 4;
const CAPTION_FONT_SIZE_PX = 20;

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

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function roundMs(value) {
	return Math.max(0, Math.round(value));
}

function clamp(value, minimum, maximum) {
	return Math.min(maximum, Math.max(minimum, value));
}

function mergeCursorHiddenSourceRegions(regions) {
	const merged = [];
	const sorted = regions
		.filter((region) => finiteNumber(region?.startMs) && finiteNumber(region?.endMs))
		.map((region) => ({
			startMs: Math.min(region.startMs, region.endMs),
			endMs: Math.max(region.startMs, region.endMs),
		}))
		.filter((region) => region.endMs > region.startMs)
		.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
	for (const region of sorted) {
		const previous = merged[merged.length - 1];
		if (previous && region.startMs <= previous.endMs) {
			previous.endMs = Math.max(previous.endMs, region.endMs);
		} else {
			merged.push({ ...region });
		}
	}
	return merged;
}

function declaredPath(value) {
	if (typeof value === "string" && value.trim()) return value;
	if (value && typeof value === "object" && typeof value.path === "string" && value.path.trim()) {
		return value.path;
	}
	return null;
}

function resolveDeclaredPath(baseDirectory, ...values) {
	for (const value of values) {
		const candidate = declaredPath(value);
		if (candidate) return path.resolve(baseDirectory, candidate);
	}
	return null;
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

function sha256Text(value) {
	return createHash("sha256").update(value).digest("hex");
}

function isSha256(value) {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function runCommand(command, args, label) {
	const result = spawnSync(command, args, {
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

function parseRate(value) {
	if (typeof value !== "string") return null;
	const [numerator, denominator] = value.split("/").map(Number);
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
	return numerator / denominator;
}

function probeMedia(filePath) {
	const output = runCommand(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,duration",
			"-of",
			"json",
			filePath,
		],
		`ffprobe ${filePath}`,
	);
	const data = JSON.parse(output);
	const video = data.streams?.find((stream) => stream.codec_type === "video") ?? null;
	const audio = data.streams?.find((stream) => stream.codec_type === "audio") ?? null;
	const durationSeconds = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
	return {
		durationMs: Number.isFinite(durationSeconds) ? roundMs(durationSeconds * 1000) : null,
		width: finiteNumber(video?.width) ? video.width : null,
		height: finiteNumber(video?.height) ? video.height : null,
		frameRate: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
		videoCodec: video?.codec_name ?? null,
		audioCodec: audio?.codec_name ?? null,
		hasAudio: Boolean(audio),
	};
}

function millisecondsFrom(value, millisecondKeys, secondKeys = []) {
	for (const key of millisecondKeys) {
		if (finiteNumber(value?.[key])) return roundMs(value[key]);
	}
	for (const key of secondKeys) {
		if (finiteNumber(value?.[key])) return roundMs(value[key] * 1000);
	}
	return null;
}

function actionStartMs(action) {
	return millisecondsFrom(
		action,
		["sourceTimeMs", "timestampMs", "timeMs"],
		["sourceTime", "timestampSeconds", "timeSeconds"],
	);
}

function actionEndMs(action) {
	const explicit = millisecondsFrom(
		action,
		["sourceEndTimeMs", "resultStableTimeMs", "visibleResultTimeMs", "outcomeTimeMs", "endTimeMs"],
		["sourceEndTime", "resultStableTime", "visibleResultTime", "outcomeTime", "endTime"],
	);
	if (explicit !== null) return explicit;
	const start = actionStartMs(action);
	if (start === null) return null;
	const duration = millisecondsFrom(action, ["durationMs"], ["duration"]);
	return start + Math.max(1, duration ?? roundMs(FRAME_MS));
}

function normalizeActionLog(payload) {
	const rawActions = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.actions)
			? payload.actions
			: Array.isArray(payload?.timeline)
				? payload.timeline.map((event) => {
						const target = event?.target;
						const rect = target?.rect;
						return {
							...event,
							id: event?.eventId,
							actionId: event?.eventId,
							targetId: target?.targetId,
							targetName: target?.name || target?.text,
							controlType: target?.controlType,
							domTarget:
								rect && typeof rect === "object"
									? {
										coordinateSpace: "viewport",
										x: rect.x,
										y: rect.y,
										width: rect.width,
										height: rect.height,
										point: target.point,
										normalizedPoint: target.normalizedPoint,
									}
									: undefined,
							sourceEndTimeMs: actionStartMs(event) + roundMs(FRAME_MS),
						};
					})
						: null;
	if (!Array.isArray(rawActions) || rawActions.length === 0) {
		fail("capture/action-log.json must contain a non-empty actions or timeline array.");
	}
	const actions = [];
	const byId = new Map();
	for (let index = 0; index < rawActions.length; index += 1) {
		const raw = rawActions[index];
		if (!raw || typeof raw !== "object") fail(`Action log item ${index + 1} must be an object.`);
		const id = raw.id || raw.actionId;
		if (typeof id !== "string" || !id.trim()) fail(`Action log item ${index + 1} has no action id.`);
		if (byId.has(id)) fail(`Duplicate action id: ${id}`);
		const startMs = actionStartMs(raw);
		if (startMs === null) fail(`Action ${id} has no sourceTimeMs.`);
		const normalized = { ...raw, id, sourceTimeMs: startMs, sourceEndTimeMs: actionEndMs(raw) };
		actions.push(normalized);
		byId.set(id, normalized);
	}
	return {
		actions,
		byId,
		captureGeometry: payload?.captureGeometry ?? null,
		source: Array.isArray(payload?.timeline)
			? "browser-action-timeline"
			: payload?.source || "legacy-agent-actions",
	};
}

function normalizeCursorSidecar(payload, captureGeometry, sourceWidth, sourceHeight) {
	const samples = Array.isArray(payload) ? payload : payload?.samples;
	if (!Array.isArray(samples) || samples.length < 2) {
		fail("Cursor sidecar must contain at least two Browser Action Timeline samples.");
	}
	const cursorCoordinateSpace = payload?.coordinateSpace || "viewport";
	const sourceContent =
		cursorCoordinateSpace === "source"
			? null
			: resolveSourceContentRect(captureGeometry, sourceWidth, sourceHeight);
	return samples
		.map((sample, index) => {
			if (!sample || typeof sample !== "object") fail(`Cursor sample ${index + 1} must be an object.`);
			if (!finiteNumber(sample.timeMs) || !finiteNumber(sample.cx) || !finiteNumber(sample.cy)) {
				fail(`Cursor sample ${index + 1} must contain finite timeMs, cx, and cy.`);
			}
			const viewportX = clamp(sample.cx, 0, 1);
			const viewportY = clamp(sample.cy, 0, 1);
			const cx = sourceContent
				? clamp((sourceContent.x + viewportX * sourceContent.width) / sourceWidth, 0, 1)
				: viewportX;
			const cy = sourceContent
				? clamp((sourceContent.y + viewportY * sourceContent.height) / sourceHeight, 0, 1)
				: viewportY;
			return {
				timeMs: roundMs(sample.timeMs),
				cx,
				cy,
				interactionType: sample.interactionType,
				cursorType: sample.cursorType,
			};
		})
		.sort((left, right) => left.timeMs - right.timeMs);
}

function selectScenes(scenes, focusedValue, riskAnchors) {
	if (focusedValue === undefined && riskAnchors === undefined) return scenes;
	if (focusedValue !== undefined && riskAnchors !== undefined) fail("Choose --focused or --risk-scenes, not both.");
	const ids = String(riskAnchors ?? focusedValue)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (ids.length === 0) fail("Focused Preview requires at least one Scene id.");
	const indices = ids.map((id) => scenes.findIndex((scene) => scene.id === id));
	if (indices.some((index) => index < 0)) {
		const missing = ids.filter((_, index) => indices[index] < 0);
		fail(`Focused Scene ids were not found: ${missing.join(", ")}`);
	}
	if (riskAnchors !== undefined) {
		// The Agent chooses which actions and results need review; keep every Scene between them.
		return scenes.slice(Math.min(...indices), Math.max(...indices) + 1);
	}
	for (let index = 1; index < indices.length; index += 1) {
		if (indices[index] !== indices[index - 1] + 1) {
			fail("Focused Preview Scenes must be consecutive and listed in teaching-plan order.");
		}
	}
	return indices.map((index) => scenes[index]);
}

function teachingClass(scene) {
	const value = String(scene.teachingClass || scene.classification || "").toUpperCase();
	if (!new Set(["A", "B", "C"]).has(value)) {
		fail(`Scene ${scene.id} must declare teachingClass A, B, or C.`);
	}
	return value;
}

function sceneDisposition(scene, classification) {
	const declared = scene.disposition || scene.edit?.disposition || null;
	if (declared && !new Set(["keep", "speed", "remove"]).has(declared)) {
		fail(`Scene ${scene.id} has unsupported disposition ${declared}.`);
	}
	const removalCategories = new Set([
		"loading",
		"spinner",
		"exploration",
		"failed-attempt",
		"failure",
		"duplicate",
		"repeated-input",
		"repeated-navigation",
	]);
	const category = scene.category || scene.edit?.category || null;
	if (removalCategories.has(category)) return "remove";
	if (classification === "C") {
		if (declared === "speed" || scene.mustRetain === true || scene.edit?.mustRetain === true) return "speed";
		return "remove";
	}
	return declared || "keep";
}

function sceneActionIds(scene) {
	const raw = Array.isArray(scene.actionIds)
		? scene.actionIds
		: Array.isArray(scene.actions)
			? scene.actions
			: [];
	return raw
		.map((item) => (typeof item === "string" ? item : item?.id || item?.actionId))
		.filter((item) => typeof item === "string" && item.trim());
}

function sceneSourceRange(scene, actionsById) {
	let startMs = millisecondsFrom(scene, ["sourceStartMs"], ["sourceStart"]);
	let endMs = millisecondsFrom(scene, ["sourceEndMs"], ["sourceEnd"]);
	if (startMs === null) startMs = millisecondsFrom(scene.source, ["startMs"], ["start"]);
	if (endMs === null) endMs = millisecondsFrom(scene.source, ["endMs"], ["end"]);
	if (startMs !== null && endMs === null) {
		const durationMs = millisecondsFrom(scene, ["clipDurationMs"], ["clipDuration"]);
		if (durationMs !== null) endMs = startMs + durationMs;
	}
	const ids = sceneActionIds(scene);
	const actions = ids.map((id) => {
		const action = actionsById.get(id);
		if (!action) fail(`Scene ${scene.id} references unknown action ${id}.`);
		return action;
	});
	if (startMs === null && actions.length > 0) startMs = Math.min(...actions.map((action) => action.sourceTimeMs));
	if (endMs === null && actions.length > 0) {
		endMs = Math.max(...actions.map((action) => action.sourceEndTimeMs ?? action.sourceTimeMs + roundMs(FRAME_MS)));
	}
	if (startMs === null || endMs === null || endMs <= startMs) {
		fail(`Scene ${scene.id} has no valid sourceStartMs/sourceEndMs or resolvable action range.`);
	}
	return { startMs, endMs, actions };
}

function resolveSourceContentRect(captureGeometry, sourceWidth, sourceHeight) {
	const viewport = captureGeometry?.viewport;
	if (
		!finiteNumber(viewport?.width) ||
		!finiteNumber(viewport?.height) ||
		viewport.width <= 0 ||
		viewport.height <= 0 ||
		sourceWidth <= 0 ||
		sourceHeight <= 0
	) {
		return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
	}

	const reported = captureGeometry?.contentRect;
	const hasReportedRect =
		reported &&
		finiteNumber(reported.x) &&
		finiteNumber(reported.y) &&
		finiteNumber(reported.width) &&
		finiteNumber(reported.height) &&
		reported.width > 0 &&
		reported.height > 0;
	const reportedRect = hasReportedRect
		? reported
		: { x: 0, y: 0, width: sourceWidth, height: sourceHeight };

	// Browser capture preserves the page's viewport aspect ratio inside the
	// 16:9 Raw Master. When the telemetry reports the full capture surface as
	// contentRect, recover the actual letterboxed page rect so DOM targets and
	// cursor points share one source-space transform.
	const sourceAspect = sourceWidth / sourceHeight;
	const viewportAspect = viewport.width / viewport.height;
	const reportedIsFullFrame =
		Math.abs(reportedRect.x) < 0.5 &&
		Math.abs(reportedRect.y) < 0.5 &&
		Math.abs(reportedRect.width - sourceWidth) < 0.5 &&
		Math.abs(reportedRect.height - sourceHeight) < 0.5;
	if (reportedIsFullFrame && Math.abs(sourceAspect - viewportAspect) > 0.01) {
		const scale = Math.min(sourceWidth / viewport.width, sourceHeight / viewport.height);
		const width = viewport.width * scale;
		const height = viewport.height * scale;
		return {
			x: (sourceWidth - width) / 2,
			y: (sourceHeight - height) / 2,
			width,
			height,
		};
	}

	return reportedRect;
}

function sourceTargetRect(target, captureGeometry, sourceWidth, sourceHeight) {
	const geometryTarget =
		target?.rect && typeof target.rect === "object"
			? { ...target.rect, coordinateSpace: target.coordinateSpace || "viewport" }
			: target;
	if (!geometryTarget || !finiteNumber(geometryTarget.x) || !finiteNumber(geometryTarget.y)) return null;
	if (!finiteNumber(geometryTarget.width) || !finiteNumber(geometryTarget.height)) return null;
	if (geometryTarget.width <= 0 || geometryTarget.height <= 0) return null;
	if (geometryTarget.coordinateSpace === "source") {
		return {
			x: geometryTarget.x,
			y: geometryTarget.y,
			width: geometryTarget.width,
			height: geometryTarget.height,
		};
	}
	if (geometryTarget.coordinateSpace === "normalized") {
		return {
			x: geometryTarget.x * sourceWidth,
			y: geometryTarget.y * sourceHeight,
			width: geometryTarget.width * sourceWidth,
			height: geometryTarget.height * sourceHeight,
		};
	}
	if (geometryTarget.coordinateSpace !== "viewport") return null;
	const viewport = captureGeometry?.viewport;
	if (
		!finiteNumber(viewport?.width) ||
		!finiteNumber(viewport?.height) ||
		viewport.width <= 0 ||
		viewport.height <= 0
	) {
		return null;
	}
	const content = resolveSourceContentRect(captureGeometry, sourceWidth, sourceHeight);
	return {
		x: content.x + (geometryTarget.x * content.width) / viewport.width,
		y: content.y + (geometryTarget.y * content.height) / viewport.height,
		width: (geometryTarget.width * content.width) / viewport.width,
		height: (geometryTarget.height * content.height) / viewport.height,
	};
}

function dataUrl(mimeType, bytes) {
	return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function highlightSvg(width, height, color = "#0a6ed1", strokeWidth = 4, radius = 10) {
	const safeWidth = Math.max(1, Math.round(width));
	const safeHeight = Math.max(1, Math.round(height));
	const inset = Math.max(1, strokeWidth / 2);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}"><rect x="${inset}" y="${inset}" width="${Math.max(1, safeWidth - strokeWidth)}" height="${Math.max(1, safeHeight - strokeWidth)}" rx="${radius}" ry="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/></svg>`;
	return dataUrl("image/svg+xml", Buffer.from(svg, "utf8"));
}

function escapeXml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function endCardSvg({ width, height, kicker, title, lines, note, brand }) {
	const safeWidth = Math.max(1, Math.round(width));
	const safeHeight = Math.max(1, Math.round(height));
	const safeKicker = escapeXml(kicker || "补充说明");
	const safeTitle = escapeXml(title || "培训要点");
	const safeLines = Array.isArray(lines) ? lines.filter((line) => String(line).trim()) : [];
	const safeNote = escapeXml(note || "");
	const safeBrand = escapeXml(brand || "#0a6ed1");
	const lineMarkup = safeLines
		.map((line, index) => {
			const y = 470 + index * 86;
			return `<g><circle cx="240" cy="${y - 10}" r="8" fill="${safeBrand}"/><text x="280" y="${y}" fill="#1d2d3e" font-family="Microsoft YaHei, Arial, sans-serif" font-size="40px">${escapeXml(line)}</text></g>`;
		})
		.join("");
	const noteMarkup = safeNote
		? `<text x="240" y="${safeHeight - 250}" fill="#5b6b7a" font-family="Microsoft YaHei, Arial, sans-serif" font-size="24px">${safeNote}</text>`
		: "";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}"><rect width="${safeWidth}" height="${safeHeight}" fill="#f7f9fb"/><rect width="${safeWidth}" height="22" fill="${safeBrand}"/><rect x="160" y="150" width="1600" height="780" rx="24" fill="#ffffff" stroke="#d9e2ec" stroke-width="2"/><text x="240" y="265" fill="${safeBrand}" font-family="Microsoft YaHei, Arial, sans-serif" font-size="28px" font-weight="700">${safeKicker}</text><text x="240" y="360" fill="#102a43" font-family="Microsoft YaHei, Arial, sans-serif" font-size="58px" font-weight="700">${safeTitle}</text><rect x="240" y="405" width="1440" height="2" fill="#d9e2ec"/>${lineMarkup}${noteMarkup}</svg>`;
	return dataUrl("image/svg+xml", Buffer.from(svg, "utf8"));
}


async function extractStill({ videoPath, sourceTimeMs, outputPath }) {
	if (existsSync(outputPath) && (await stat(outputPath)).size > 0) return outputPath;
	await mkdir(path.dirname(outputPath), { recursive: true });
	const temporaryPath = `${outputPath}.${process.pid}.tmp.png`;
	try {
		runCommand(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-ss",
				(sourceTimeMs / 1000).toFixed(3),
				"-i",
				videoPath,
				"-frames:v",
				"1",
				"-y",
				temporaryPath,
			],
			`FFmpeg stable-frame extraction for ${path.basename(outputPath)}`,
		);
		if (existsSync(outputPath)) await unlink(outputPath);
		await rename(temporaryPath, outputPath);
	} finally {
		if (existsSync(temporaryPath)) await unlink(temporaryPath);
	}
	return outputPath;
}

function annotationStyle() {
	return {
		color: "#ffffff",
		backgroundColor: "transparent",
		fontSize: 30,
		fontFamily: "Arial, sans-serif",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		textAlign: "center",
		borderRadius: 0,
	};
}

function normalizeVisualBeats(scene, actions) {
	if (Array.isArray(scene.visualBeats)) return scene.visualBeats;
	if (scene.visualIntent || scene.target) {
		return [
			{
				id: `${scene.id}-visual-1`,
				actionId: actions[0]?.id ?? null,
				target: scene.target,
				visualIntent: scene.visualIntent,
			},
		];
	}
	return actions
		.filter((action) => action.visualCandidate || action.visualIntent)
		.map((action) => ({
			id: `${scene.id}-${action.id}`,
			actionId: action.id,
			target: action.target || action.domTarget,
			visualIntent: action.visualCandidate || action.visualIntent,
		}));
}

function visualIntentForMode(beat, mode) {
	if (mode === "rough") return beat.candidate || beat.visualIntent || beat.intent || {};
	return beat.visualIntent || beat.intent || beat.candidate || {};
}

function actionType(action) {
	return String(action?.type || action?.eventType || action?.kind || "")
		.trim()
		.toLowerCase()
		.replaceAll("_", "-");
}

function isNavigationAction(action) {
	return new Set(["navigation", "tab-switch", "tabswitch", "tab-change", "tabchange"]).has(
		actionType(action),
	);
}

function isInteractionAction(action) {
	return new Set([
		"click",
		"input",
		"change",
		"keydown",
		"keyup",
		"key",
		"focus",
		"tab-switch",
		"tabswitch",
		"tab-change",
		"tabchange",
	]).has(actionType(action));
}

function resultSelectionText(scene, relatedActions) {
	return [
		scene?.objective,
		scene?.narration,
		scene?.narrationScript,
		scene?.script,
		...relatedActions.flatMap((action) => [
			action?.target?.name,
			action?.target?.text,
			action?.target?.controlType,
			action?.target?.role,
			action?.target?.targetId,
		]),
	]
		.filter((value) => typeof value === "string" && value.trim())
		.join(" ")
		.toLowerCase();
}

function isResultSelectionScene(scene, relatedActions) {
	if (!scene || millisecondsFrom(scene, ["preActionStableSourceTimeMs"], ["preActionStableSourceTime"]) === null) {
		return false;
	}
	if (!relatedActions.some((action) => actionType(action) === "click")) return false;
	const text = resultSelectionText(scene, relatedActions);
	return /(搜索结果|结果中|选择.*应用|search result|result|listitem|menuitem|option|suggestion)/i.test(text);
}

function sceneTimelineActions({ scene, range, allActions }) {
	const explicitIds = new Set(range.actions.map((action) => action.id));
	const hasExplicitActions = explicitIds.size > 0;
	return allActions
		.filter((action) => action.sourceTimeMs >= range.startMs && action.sourceTimeMs <= range.endMs + FRAME_MS)
		.filter((action) => {
			if (explicitIds.has(action.id)) return true;
			if (!hasExplicitActions) return isNavigationAction(action);
			if (isNavigationAction(action)) return true;
			if (!isInteractionAction(action)) return false;
			return range.actions.some(
				(explicit) =>
					Math.abs(action.sourceTimeMs - explicit.sourceTimeMs) <= ACTION_SUPPORT_RADIUS_MS ||
					(action.sourceTimeMs >= explicit.sourceTimeMs &&
						action.sourceTimeMs <= (explicit.sourceEndTimeMs ?? explicit.sourceTimeMs) + ACTION_SUPPORT_RADIUS_MS),
			);
		});
}

function isBoundaryInteraction(action) {
	return new Set([
		"click",
		"input",
		"change",
		"keydown",
		"keyup",
		"key",
		"tab-switch",
		"tabswitch",
		"tab-change",
		"tabchange",
	]).has(actionType(action));
}

function inferTeachingSourceRange({ range, allActions, relatedActions }) {
	if (range.actions.length === 0 || relatedActions.length === 0) return range;
	const relatedIds = new Set(relatedActions.map((action) => action.id));
	const nextUnassignedInteraction = allActions
		.filter(
			(action) =>
				!relatedIds.has(action.id) &&
				isBoundaryInteraction(action) &&
				action.sourceTimeMs >= range.startMs &&
				action.sourceTimeMs <= range.endMs + FRAME_MS,
		)
		.sort((left, right) => left.sourceTimeMs - right.sourceTimeMs)[0];
	if (!nextUnassignedInteraction) return range;
	const relatedBeforeBoundary = relatedActions.filter(
		(action) => action.sourceTimeMs < nextUnassignedInteraction.sourceTimeMs,
	);
	const lastRelatedEndMs = Math.max(
		range.startMs,
		...relatedBeforeBoundary.map(
			(action) => action.sourceEndTimeMs ?? action.sourceTimeMs + roundMs(FRAME_MS),
		),
	);
	const inferredEndMs = Math.min(
		range.endMs,
		lastRelatedEndMs + NAVIGATION_WINDOW_AFTER_MS + ACTION_WINDOW_AFTER_MS,
	);
	if (inferredEndMs <= range.startMs) return range;
	return {
		...range,
		endMs: Math.max(range.startMs + 1, inferredEndMs),
		declaredEndMs: range.endMs,
		endInferred: true,
	};
}

function groupTeachingActions(actions) {
	const sorted = [...actions].sort((left, right) => left.sourceTimeMs - right.sourceTimeMs);
	const groups = [];
	for (const action of sorted) {
		const last = groups[groups.length - 1];
		const actionEndMs = action.sourceEndTimeMs ?? action.sourceTimeMs + roundMs(FRAME_MS);
		if (last && action.sourceTimeMs - last.endMs <= ACTION_GROUP_GAP_MS) {
			last.actions.push(action);
			last.endMs = Math.max(last.endMs, actionEndMs);
			continue;
		}
		groups.push({ startMs: action.sourceTimeMs, endMs: actionEndMs, actions: [action] });
	}
	return groups;
}

function buildTeachingActionWindows({ scene, sourceRange, relatedActions, firstRetainedScene }) {
	if (sceneActionIds(scene).length === 0 || relatedActions.length === 0) return [];
	const groups = groupTeachingActions(relatedActions);
	const windows = groups.map((group, index) => {
		const hasNavigation = group.actions.some(isNavigationAction);
		const hasInput = group.actions.some((action) =>
			new Set(["input", "change", "keydown", "keyup", "key"]).has(actionType(action)),
		);
		const afterMs = hasNavigation
			? NAVIGATION_WINDOW_AFTER_MS
			: hasInput
				? INPUT_WINDOW_AFTER_MS
				: ACTION_WINDOW_AFTER_MS;
		const beforeMs = index === 0 && firstRetainedScene ? FIRST_SCENE_CONTEXT_MS : ACTION_WINDOW_BEFORE_MS;
		return {
			startMs: Math.max(sourceRange.startMs, group.startMs - beforeMs),
			endMs: Math.min(sourceRange.endMs, group.endMs + afterMs),
			actionIds: group.actions.map((action) => action.id),
		};
	});
	const merged = [];
	for (const window of windows) {
		const previous = merged[merged.length - 1];
		if (previous && window.startMs <= previous.endMs + ACTION_GROUP_GAP_MS) {
			previous.endMs = Math.max(previous.endMs, window.endMs);
			previous.actionIds.push(...window.actionIds);
		} else {
			merged.push({ ...window });
		}
	}
	return merged;
}

function appendTeachingClip({
	clipRegions,
	segments,
	sceneId,
	clipIndex,
	timelineStartMs,
	sourceStartMs,
	sourceEndMs,
	speed,
	role,
	actionIds = [],
}) {
	const startMs = roundMs(sourceStartMs);
	const endMs = roundMs(sourceEndMs);
	if (endMs <= startMs) return timelineStartMs;
	const safeSpeed = Math.max(1, speed);
	const displayDurationMs = Math.max(1, roundMs((endMs - startMs) / safeSpeed));
	const timelineEndMs = timelineStartMs + displayDurationMs;
	clipRegions.push({
		id: `clip-${sceneId}-${clipIndex}`,
		startMs: timelineStartMs,
		endMs: timelineEndMs,
		sourceStartMs: startMs,
		speed: safeSpeed,
		muted: true,
		showSourceAudio: false,
	});
	segments.push({
		clipId: `clip-${sceneId}-${clipIndex}`,
		sourceStartMs: startMs,
		sourceEndMs: endMs,
		timelineStartMs,
		timelineEndMs,
		speed: safeSpeed,
		role,
		actionIds,
	});
	return timelineEndMs;
}

function stretchTeachingTimelineForNarration({
	clipRegions,
	teachingTimeline,
	sceneStartMs,
	sceneId,
	minimumDurationMs,
}) {
	let extraMs = Math.max(
		0,
		minimumDurationMs - (teachingTimeline.actionEndMs - sceneStartMs),
	);
	if (extraMs <= 0) return teachingTimeline.actionEndMs;

	let cumulativeShiftMs = 0;
	for (const segment of teachingTimeline.segments) {
		segment.timelineStartMs += cumulativeShiftMs;
		segment.timelineEndMs += cumulativeShiftMs;
		const clip = clipRegions.find((candidate) => candidate.id === segment.clipId);
		if (clip) {
			clip.startMs = segment.timelineStartMs;
			clip.endMs = segment.timelineEndMs;
		}
		if (segment.role !== "compressed-idle" || extraMs <= 0) continue;
		const sourceDurationMs = segment.sourceEndMs - segment.sourceStartMs;
		const currentDisplayMs = segment.timelineEndMs - segment.timelineStartMs;
		const maximumDisplayMs = sourceDurationMs;
		const availableMs = Math.max(0, maximumDisplayMs - currentDisplayMs);
		const addedMs = Math.min(extraMs, availableMs);
		if (addedMs <= 0) continue;
		const nextDisplayMs = currentDisplayMs + addedMs;
		segment.speed = sourceDurationMs / nextDisplayMs;
		segment.timelineEndMs = segment.timelineStartMs + nextDisplayMs;
		if (clip) {
			clip.speed = segment.speed;
			clip.endMs = segment.timelineEndMs;
		}
		cumulativeShiftMs += addedMs;
		extraMs -= addedMs;
	}

	const actionEndMs = sceneStartMs +
		(teachingTimeline.actionEndMs - sceneStartMs) +
		(cumulativeShiftMs);
	teachingTimeline.actionEndMs = roundMs(actionEndMs);
	if (extraMs > 0) {
		fail(
			`Scene ${sceneId} narration needs ${Math.round(extraMs)} ms beyond the available natural idle windows. Add a meaningful result pause or shorten the Narration Script; do not extend a synthetic Freeze.`,
		);
	}
	return teachingTimeline.actionEndMs;
}

function appendTeachingIdleGap({
	clipRegions,
	segments,
	sceneId,
	clipIndex,
	timelineStartMs,
	sourceStartMs,
	sourceEndMs,
}) {
	const gapMs = sourceEndMs - sourceStartMs;
	if (gapMs <= 0) return timelineStartMs;
	if (gapMs <= NATURAL_IDLE_GAP_MS) {
		return appendTeachingClip({
			clipRegions,
			segments,
			sceneId,
			clipIndex,
			timelineStartMs,
			sourceStartMs,
			sourceEndMs,
			speed: 1,
			role: "natural-idle",
		});
	}
	const displayDurationMs = Math.min(MAX_IDLE_DISPLAY_MS, gapMs / NON_TEACHING_IDLE_SPEED);
	const retainedSourceMs = displayDurationMs * NON_TEACHING_IDLE_SPEED;
	return appendTeachingClip({
		clipRegions,
		segments,
		sceneId,
		clipIndex,
		timelineStartMs,
		sourceStartMs: sourceEndMs - retainedSourceMs,
		sourceEndMs,
		speed: NON_TEACHING_IDLE_SPEED,
		role: "compressed-idle",
	});
}

function buildTeachingTimeline({
	clipRegions,
	sceneId,
	sourceRange,
	relatedActions,
	scene,
	firstRetainedScene,
	timelineStartMs,
}) {
	const segments = [];
	const explicitActions = scene.actionIds?.length > 0;
	if (!explicitActions || relatedActions.length === 0) {
		const endMs = appendTeachingClip({
			clipRegions,
			segments,
			sceneId,
			clipIndex: 0,
			timelineStartMs,
			sourceStartMs: sourceRange.startMs,
			sourceEndMs: sourceRange.endMs,
			speed: 1,
			role: "scene",
		});
		return { segments, actionEndMs: endMs };
	}

	const windows = buildTeachingActionWindows({
		scene,
		sourceRange,
		relatedActions,
		firstRetainedScene,
	});
	let cursorMs = timelineStartMs;
	let sourceCursorMs = sourceRange.startMs;
	let clipIndex = 0;
	for (const window of windows) {
		if (window.startMs > sourceCursorMs) {
			cursorMs = appendTeachingIdleGap({
				clipRegions,
				segments,
				sceneId,
				clipIndex: clipIndex++,
				timelineStartMs: cursorMs,
				sourceStartMs: sourceCursorMs,
				sourceEndMs: window.startMs,
			});
		}
		cursorMs = appendTeachingClip({
			clipRegions,
			segments,
			sceneId,
			clipIndex: clipIndex++,
			timelineStartMs: cursorMs,
			sourceStartMs: window.startMs,
			sourceEndMs: window.endMs,
			speed: 1,
			role: "action",
			actionIds: window.actionIds,
		});
		sourceCursorMs = window.endMs;
	}
	if (sourceCursorMs < sourceRange.endMs) {
		cursorMs = appendTeachingIdleGap({
			clipRegions,
			segments,
			sceneId,
			clipIndex: clipIndex++,
			timelineStartMs: cursorMs,
			sourceStartMs: sourceCursorMs,
			sourceEndMs: sourceRange.endMs,
		});
	}
	return { segments, actionEndMs: cursorMs };
}

function mapSourceTimeToSceneTimeline(sourceTimeMs, sceneContract) {
	const source = sceneContract.source;
	const segments = Array.isArray(sceneContract.segments) ? sceneContract.segments : [];
	const bounded = clamp(sourceTimeMs, source.startMs, source.endMs);
	for (const segment of segments) {
		if (bounded >= segment.sourceStartMs && bounded < segment.sourceEndMs) {
			return roundMs(
				segment.timelineStartMs + (bounded - segment.sourceStartMs) / Math.max(1, segment.speed),
			);
		}
	}
	if (segments.length === 0) {
		return roundMs(sceneContract.timeline.startMs + (bounded - source.startMs) / Math.max(1, source.speed || 1));
	}
	let nearest = segments[0];
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const segment of segments) {
		for (const boundary of [
			{ sourceMs: segment.sourceStartMs, timelineMs: segment.timelineStartMs },
			{ sourceMs: segment.sourceEndMs, timelineMs: segment.timelineEndMs },
		]) {
			const distance = Math.abs(bounded - boundary.sourceMs);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = boundary;
			}
		}
	}
	return roundMs(nearest.timelineMs);
}

function shouldUseTeachingZoom({
	beat,
	intent,
	target,
	targetRect,
	firstRetainedScene,
	zoomRegions,
	sceneStartMs,
	sceneEndMs,
	startMs,
	sourceWidth,
	sourceHeight,
}) {
	if (intent.zoom !== true || !targetRect) return false;
	const explicitTeachingReason = [
		beat.zoomReason,
		beat.teachingValue,
		intent.zoomReason,
		intent.teachingValue,
		target?.zoomReason,
	]
		.find((value) => typeof value === "string" && value.trim())
		?.trim();
	if (!explicitTeachingReason) return false;
	const focus = {
		cx: (targetRect.x + targetRect.width / 2) / sourceWidth,
		cy: (targetRect.y + targetRect.height / 2) / sourceHeight,
	};
	const repeatsExistingRegion = zoomRegions.some((region) => {
		const distance = Math.hypot(region.focus.cx - focus.cx, region.focus.cy - focus.cy);
		return distance <= ZOOM_TARGET_MAX_DISTANCE && Math.abs(region.endMs - startMs) <= 1_500;
	});
	if (repeatsExistingRegion) return false;
	return sceneEndMs - sceneStartMs > ZOOM_IN_DURATION_MS + ZOOM_REGION_HOLD_MS;
}

function addHighlight({ annotationRegions, sceneId, beatId, startMs, endMs, targetRect, sourceWidth, sourceHeight, color }) {
	const padding = 4;
	const x = clamp(targetRect.x - padding, 0, sourceWidth - 1);
	const y = clamp(targetRect.y - padding, 0, sourceHeight - 1);
	const width = clamp(targetRect.width + padding * 2, 1, sourceWidth - x);
	const height = clamp(targetRect.height + padding * 2, 1, sourceHeight - y);
	const image = highlightSvg(width, height, color);
	annotationRegions.push({
		id: `highlight-${sceneId}-${beatId}`,
		startMs,
		endMs,
		type: "image",
		content: image,
		imageContent: image,
		position: { x: (x / sourceWidth) * 100, y: (y / sourceHeight) * 100 },
		size: { width: (width / sourceWidth) * 100, height: (height / sourceHeight) * 100 },
		style: annotationStyle(),
		zIndex: 10,
		trackIndex: 1,
	});
}

async function addStableFreeze({
	clipRegions,
	annotationRegions,
	videoPath,
	stillDirectory,
	sceneId,
	timelineStartMs,
	durationMs,
	sourceAnchorMs,
	sourceFloorMs,
}) {
	if (durationMs <= 0) return timelineStartMs;
	if (durationMs > MAX_STABLE_FREEZE_MS) {
		fail(
			`Scene ${sceneId} requires ${durationMs} ms of stable Freeze, above the ${MAX_STABLE_FREEZE_MS} ms limit. Shorten Narration instead of extending the Freeze.`,
		);
	}
	const sourceSpanMs = Math.max(1, durationMs * FREEZE_SPEED);
	const sourceStartMs = Math.max(sourceFloorMs, sourceAnchorMs - sourceSpanMs);
	clipRegions.push({
		id: `clip-${sceneId}-stable-freeze`,
		startMs: timelineStartMs,
		endMs: timelineStartMs + durationMs,
		sourceStartMs,
		speed: FREEZE_SPEED,
		muted: true,
		showSourceAudio: false,
	});
	const signature = sha256Text(`${videoPath}\0${sourceAnchorMs}`).slice(0, 12);
	const stillPath = path.join(stillDirectory, `${sceneId}-${signature}.png`);
	await extractStill({ videoPath, sourceTimeMs: sourceAnchorMs, outputPath: stillPath });
	const image = dataUrl("image/png", await readFile(stillPath));
	annotationRegions.push({
		id: `stable-freeze-${sceneId}`,
		startMs: timelineStartMs,
		endMs: timelineStartMs + durationMs,
		type: "image",
		content: image,
		imageContent: image,
		position: { x: 0, y: 0 },
		size: { width: 100, height: 100 },
		style: annotationStyle(),
		zIndex: 1,
		trackIndex: 0,
	});
	return timelineStartMs + durationMs;
}

async function addStableFrameOverlay({
	annotationRegions,
	videoPath,
	stillDirectory,
	sceneId,
	startMs,
	durationMs,
	sourceAnchorMs,
}) {
	if (durationMs <= 0) return null;
	const signature = sha256Text(`${videoPath}\0${sourceAnchorMs}`).slice(0, 12);
	const stillPath = path.join(stillDirectory, `${sceneId}-${signature}.png`);
	await extractStill({ videoPath, sourceTimeMs: sourceAnchorMs, outputPath: stillPath });
	const image = dataUrl("image/png", await readFile(stillPath));
	annotationRegions.push({
		id: `stable-frame-overlay-${sceneId}`,
		startMs,
		endMs: startMs + durationMs,
		type: "image",
		content: image,
		imageContent: image,
		position: { x: 0, y: 0 },
		size: { width: 100, height: 100 },
		style: annotationStyle(),
		zIndex: 2,
		trackIndex: 0,
	});
	return {
		startMs,
		endMs: startMs + durationMs,
		sourceTimeMs: sourceAnchorMs,
	};
}

async function resolveNarrationAudio({ scene, manifestByScene, manifestDirectory, runDirectory }) {
	const narration = narrationText(scene);
	if (!narration) return null;
	const entry = manifestByScene.get(scene.id);
	if (!entry) fail(`TTS manifest has no WAV for narrated Scene ${scene.id}.`);
	if (entry.narration !== narration) {
		fail(`TTS manifest Narration does not match the Agent teaching plan for Scene ${scene.id}.`);
	}
	const declaredAudio = declaredPath(entry.audioPath);
	if (!declaredAudio) fail(`TTS manifest Scene ${scene.id} has no audioPath.`);
	const candidates = [path.resolve(runDirectory, declaredAudio), path.resolve(manifestDirectory, declaredAudio)];
	const audioPath = candidates.find((candidate) => existsSync(candidate));
	if (!audioPath) fail(`TTS WAV is missing for Scene ${scene.id}: ${candidates[0]}`);
	if (path.extname(audioPath).toLowerCase() !== ".wav") fail(`TTS audio must be WAV: ${audioPath}`);
	const sha256 = await sha256File(audioPath);
	if (!isSha256(entry.audioSha256) || entry.audioSha256 !== sha256) {
		fail(`TTS WAV hash does not match its manifest for Scene ${scene.id}.`);
	}
	const durationMs = probeMedia(audioPath).durationMs;
	if (!finiteNumber(durationMs) || durationMs <= 0) fail(`Cannot measure TTS WAV duration for Scene ${scene.id}.`);
	return { narration, audioPath, sha256, durationMs, cacheKey: entry.cacheKey ?? null, plan: entry.plan ?? null };
}

async function main() {
	const { options, positional } = parseArgs(process.argv.slice(2));
	if (!positional[0] || !new Set(["rough", "final"]).has(options.mode)) {
		fail(
			"Usage: node scripts/build-recordly-project.mjs <run-directory-or-run.json> --mode=rough|final [--plan=<teaching-plan.json>] [--tts-manifest=<tts-manifest.json>] [--output=<project.recordly>] [--focused=<consecutive-scene-ids> | --risk-scenes=<action-and-result-scene-ids>]",
		);
	}
	const compileMode = options.mode;
	const inputPath = path.resolve(positional[0]);
	const inputStats = await stat(inputPath);
	const runJsonPath = inputStats.isDirectory() ? path.join(inputPath, "run.json") : inputPath;
	if (path.basename(runJsonPath).toLowerCase() !== "run.json") {
		fail(`Expected a run directory or run.json, received: ${inputPath}`);
	}
	const runDirectory = path.dirname(runJsonPath);
	const run = await readJson(runJsonPath);
	const runName = run.run || path.basename(runDirectory);

	const rawMasterPath = resolveDeclaredPath(
		runDirectory,
		options.source,
		run.capture?.rawMaster,
		run.capture?.rawMasterPath,
		run.artifacts?.rawMaster,
		"capture/raw-master.mp4",
	);
	const actionLogPath = resolveDeclaredPath(
		runDirectory,
		options["action-log"],
		run.capture?.actionLog,
		run.artifacts?.actionLog,
		"capture/action-log.json",
	);
	const cursorPath = resolveDeclaredPath(
		runDirectory,
		options.cursor,
		run.capture?.cursor,
		run.artifacts?.cursor,
		`${rawMasterPath}.cursor.json`,
	);
	const diagnosticsPath = resolveDeclaredPath(
		runDirectory,
		options.diagnostics,
		run.capture?.recordingDiagnostics,
		run.artifacts?.recordingDiagnostics,
		"capture/recording-diagnostics.json",
	);
	const planPath = options.plan
		? path.resolve(String(options.plan))
		: options.storyboard
			? path.resolve(String(options.storyboard))
			: resolveDeclaredPath(
					runDirectory,
					run.video?.teachingPlan,
					run.teachingPlan,
					"recordly/teaching-plan.json",
				);
	for (const [label, filePath] of [
		["Raw Master", rawMasterPath],
		["Action log", actionLogPath],
		["Cursor sidecar", cursorPath],
		["Agent teaching plan", planPath],
	]) {
		if (!filePath || !existsSync(filePath)) fail(`${label} does not exist: ${filePath}`);
	}
	const expectedCursorPath = `${rawMasterPath}.cursor.json`;
	if (path.resolve(cursorPath) !== path.resolve(expectedCursorPath)) {
		fail(`Recordly loads Cursor telemetry beside videoPath; expected ${expectedCursorPath}, received ${cursorPath}.`);
	}

	const rawMasterInfo = probeMedia(rawMasterPath);
	if (!rawMasterInfo.videoCodec || !finiteNumber(rawMasterInfo.durationMs) || rawMasterInfo.durationMs <= 0) {
		fail(`Raw Master has no valid video stream or duration: ${rawMasterPath}`);
	}
	if (rawMasterInfo.hasAudio) fail("Raw Master must be video-only; narration audio belongs to Recordly Final Cut.");
	const sourceWidth = rawMasterInfo.width ?? 1920;
	const sourceHeight = rawMasterInfo.height ?? 1080;
	const actionLogPayload = await readJson(actionLogPath);
	const actionLog = normalizeActionLog(actionLogPayload);
	const cursorPayload = await readJson(cursorPath);
	const cursorSamples = normalizeCursorSidecar(
		cursorPayload,
		actionLog.captureGeometry,
		sourceWidth,
		sourceHeight,
	);
	const teachingPlan = await readJson(planPath);
	if (typeof teachingPlan.businessGoal !== "string" || !teachingPlan.businessGoal.trim()) {
		fail("Agent teaching plan must contain a non-empty businessGoal.");
	}
	if (typeof teachingPlan.learnerOutcome !== "string" || !teachingPlan.learnerOutcome.trim()) {
		fail("Agent teaching plan must contain a non-empty learnerOutcome.");
	}
	if (
		!Array.isArray(teachingPlan.knowledgePoints) ||
		teachingPlan.knowledgePoints.length < 3 ||
		teachingPlan.knowledgePoints.length > 5
	) {
		fail("Agent teaching plan must contain 3-5 knowledgePoints.");
	}
	if (!Array.isArray(teachingPlan.scenes) || teachingPlan.scenes.length === 0) {
		fail("Agent teaching plan must contain at least one Scene.");
	}
	const seenSceneIds = new Set();
	for (const scene of teachingPlan.scenes) {
		if (!scene || typeof scene.id !== "string" || !scene.id.trim()) {
			fail("Every teaching-plan Scene must have a non-empty id.");
		}
		if (seenSceneIds.has(scene.id)) fail(`Duplicate teaching-plan Scene id: ${scene.id}`);
		seenSceneIds.add(scene.id);
	}
	const selectedScenes = selectScenes(teachingPlan.scenes, options.focused, options["risk-scenes"]);
	const focusSlug = options.focused !== undefined || options["risk-scenes"] !== undefined
		? `focused-${selectedScenes.map((scene) => scene.id).join("-").replaceAll(/[^a-zA-Z0-9._-]/g, "-")}`
		: null;
	const outputPath = path.resolve(
		options.output ||
			path.join(
				runDirectory,
				"recordly",
				`${runName}.${compileMode}${focusSlug ? `.${focusSlug}` : ""}.recordly`,
			),
	);
	const contractPath = `${outputPath}.contract.json`;
	const outputDirectory = path.dirname(outputPath);
	const stillDirectory = path.join(outputDirectory, "stills");
	await mkdir(outputDirectory, { recursive: true });

	const teachingPlanSha256 = await sha256File(planPath);
	let ttsManifestPath = null;
	let ttsManifestSha256 = null;
	let manifestByScene = new Map();
	if (compileMode === "final") {
		ttsManifestPath = options["tts-manifest"]
			? path.resolve(String(options["tts-manifest"]))
			: resolveDeclaredPath(
					runDirectory,
					run.video?.ttsManifest,
					run.ttsManifest,
					"recordly/tts-manifest.json",
				);
		if (!ttsManifestPath || !existsSync(ttsManifestPath)) {
			fail(`Final Cut requires a completed TTS manifest: ${ttsManifestPath}`);
		}
		const ttsManifest = await readJson(ttsManifestPath);
		if (ttsManifest.status !== "completed" || !Array.isArray(ttsManifest.scenes)) {
			fail(`Final Cut requires a completed TTS manifest: ${ttsManifestPath}`);
		}
		if (ttsManifest.run && ttsManifest.run !== runName) {
			fail(`TTS manifest belongs to run ${ttsManifest.run}, expected ${runName}.`);
		}
		if (!isSha256(ttsManifest.teachingPlan?.sha256)) fail("TTS manifest is missing its source teaching plan hash.");
		manifestByScene = await matchManifestNarration(teachingPlan.scenes, ttsManifest, options.python);
		ttsManifestSha256 = await sha256File(ttsManifestPath);
	}

	const warnings = [];
	if (sourceWidth !== 1920 || sourceHeight !== 1080) {
		warnings.push({
			code: "SOURCE_NOT_1920X1080",
			message: `Raw Master is ${sourceWidth}x${sourceHeight}; final publication still requires 1920x1080.`,
		});
	}
	const clipRegions = [];
	const zoomRegions = [];
	const annotationRegions = [];
	const audioRegions = [];
	const autoCaptions = [];
	const sceneContracts = [];
	const audioInputs = [];
	const visualBeatContracts = [];
	const cursorHiddenSourceRegions = [];
	const keptSceneContracts = [];
	let timelineCursorMs = 0;
	let previousSourceEndMs = -1;
	let retainedSceneOrdinal = 0;

	for (const scene of selectedScenes) {
		const classification = teachingClass(scene);
		const disposition = sceneDisposition(scene, classification);
		if (disposition === "remove") {
			sceneContracts.push({
				id: scene.id,
				teachingClass: classification,
				disposition,
				objective: scene.objective ?? null,
				actionIds: sceneActionIds(scene),
			});
			continue;
		}
		const declaredRange = sceneSourceRange(scene, actionLog.byId);
		if (declaredRange.startMs < previousSourceEndMs) {
			fail(`Retained Scene ${scene.id} overlaps or reorders the preceding retained Scene.`);
		}
		if (declaredRange.endMs > rawMasterInfo.durationMs + 50) {
			fail(`Scene ${scene.id} ends after the Raw Master duration.`);
		}
		const relatedActions = sceneTimelineActions({
			scene,
			range: declaredRange,
			allActions: actionLog.actions,
		});
		const range = inferTeachingSourceRange({
			range: declaredRange,
			allActions: actionLog.actions,
			relatedActions,
		});
		if (range.endMs <= range.startMs) fail(`Scene ${scene.id} has no usable source range after editing.`);
		const timelineActions = relatedActions.filter(
			(action) => action.sourceTimeMs <= range.endMs + FRAME_MS,
		);
		previousSourceEndMs = range.endMs;
		let speed = 1;
		if (disposition === "speed") {
			speed = finiteNumber(scene.speed)
				? scene.speed
				: finiteNumber(scene.edit?.speed)
					? scene.edit.speed
					: MAX_NON_TEACHING_SPEED;
			if (speed < 1 || speed > MAX_NON_TEACHING_SPEED) {
				fail(`Scene ${scene.id} speed must be between 1x and ${MAX_NON_TEACHING_SPEED}x.`);
			}
		}
		const sceneStartMs = timelineCursorMs;
		const declaredPreActionStableSourceMs = millisecondsFrom(
			scene,
			["preActionStableSourceTimeMs"],
			["preActionStableSourceTime"],
		);
		const declaredPreActionHoldMs = millisecondsFrom(
			scene,
			["preActionHoldMs"],
			["preActionHold"],
		);
		const resultSelectionHoldMs = isResultSelectionScene(scene, timelineActions)
			? RESULT_SELECTION_PRE_ACTION_HOLD_MS
			: 0;
		const preActionHoldMs = Math.max(0, declaredPreActionHoldMs ?? 0, resultSelectionHoldMs);
		if (preActionHoldMs > MAX_PRE_ACTION_HOLD_MS) {
			fail(
				`Scene ${scene.id} requires ${preActionHoldMs} ms of pre-action stable display, above the ${MAX_PRE_ACTION_HOLD_MS} ms limit.`,
			);
		}
		if (preActionHoldMs > 0 && declaredPreActionStableSourceMs === null) {
			fail(`Scene ${scene.id} declares preActionHoldMs without preActionStableSourceTimeMs.`);
		}
		let actionTimelineStartMs = sceneStartMs;
		if (preActionHoldMs > 0) {
			actionTimelineStartMs = await addStableFreeze({
				clipRegions,
				annotationRegions,
				videoPath: rawMasterPath,
				stillDirectory,
				sceneId: `${scene.id}-pre-action`,
				timelineStartMs: sceneStartMs,
				durationMs: preActionHoldMs,
				sourceAnchorMs: clamp(
					declaredPreActionStableSourceMs,
					0,
					rawMasterInfo.durationMs,
				),
				sourceFloorMs: Math.min(range.startMs, declaredPreActionStableSourceMs),
			});
		}
		const teachingTimeline = buildTeachingTimeline({
			clipRegions,
			sceneId: scene.id,
			sourceRange: range,
			relatedActions: timelineActions,
			scene,
			firstRetainedScene: retainedSceneOrdinal === 0,
			timelineStartMs: actionTimelineStartMs,
		});
		let actionEndTimelineMs = teachingTimeline.actionEndMs;
		let displayDurationMs = Math.max(1, actionEndTimelineMs - sceneStartMs);
		let resultClickEvidence = null;
		if (resultSelectionHoldMs > 0 && declaredPreActionStableSourceMs !== null) {
			const resultClickAction = timelineActions.find((action) => actionType(action) === "click");
			if (resultClickAction) {
				const mappingContract = {
					source: { startMs: range.startMs, endMs: range.endMs },
					segments: teachingTimeline.segments,
					timeline: { startMs: sceneStartMs },
				};
				const clickTimelineMs = mapSourceTimeToSceneTimeline(
					resultClickAction.sourceTimeMs,
					mappingContract,
				);
				const clickEvidenceEndMs = Math.min(
					actionEndTimelineMs,
					clickTimelineMs + RESULT_CLICK_EVIDENCE_MS,
				);
				if (clickEvidenceEndMs > clickTimelineMs) {
					resultClickEvidence = await addStableFrameOverlay({
						annotationRegions,
						videoPath: rawMasterPath,
						stillDirectory,
						sceneId: scene.id,
						startMs: clickTimelineMs,
						durationMs: clickEvidenceEndMs - clickTimelineMs,
						sourceAnchorMs: declaredPreActionStableSourceMs,
					});
				}
			}
		}

		let narrationAudio = null;
		const narration = narrationText(scene);
		if (compileMode === "final") {
			if (classification === "A" && !narration) {
				fail(`Final Cut requires Narration Script text for A-class Scene ${scene.id}.`);
			}
			narrationAudio = await resolveNarrationAudio({
				scene,
				manifestByScene,
				manifestDirectory: path.dirname(ttsManifestPath),
				runDirectory,
			});
			if (narrationAudio) {
				actionEndTimelineMs = stretchTeachingTimelineForNarration({
					clipRegions,
					teachingTimeline,
					sceneStartMs,
					sceneId: scene.id,
					// Use retained real SAP idle windows to cover the measured narration
					// duration before considering any intentional teaching freeze. This
					// keeps output timing driven by the source timeline, not a synthetic
					// still frame added just because TTS ran slightly longer.
					minimumDurationMs: narrationAudio.durationMs,
				});
				displayDurationMs = Math.max(1, actionEndTimelineMs - sceneStartMs);
			}
		}
		const observationHoldMs = Math.max(
			0,
			millisecondsFrom(
				scene,
				["observationHoldMs", "resultObservationHoldMs"],
				["observationHold", "resultObservationHold"],
			) ?? 0,
		);
		const dwellMs =
			compileMode === "final"
				? Math.max(
					observationHoldMs,
					classification !== "C" && scene.dwellAfterResult !== false ? RESULT_DWELL_MS : 0,
				  )
				: 0;
		const audioExtensionMs = narrationAudio
			? Math.max(0, narrationAudio.durationMs - displayDurationMs)
			: 0;
		const stableFreezeMs = Math.max(dwellMs, audioExtensionMs);
		let sceneEndMs = actionEndTimelineMs;
		if (compileMode === "final" && stableFreezeMs > 0) {
			const declaredStableMs = millisecondsFrom(
				scene,
				["resultStableSourceTimeMs", "stableFrameSourceTimeMs"],
				["resultStableSourceTime", "stableFrameSourceTime"],
			);
			const stableSourceMs = clamp(
				declaredStableMs ?? range.endMs - roundMs(FRAME_MS),
				range.startMs,
				Math.max(range.startMs, range.endMs - 1),
			);
			sceneEndMs = await addStableFreeze({
				clipRegions,
				annotationRegions,
				videoPath: rawMasterPath,
				stillDirectory,
				sceneId: scene.id,
				timelineStartMs: actionEndTimelineMs,
				durationMs: stableFreezeMs,
				sourceAnchorMs: stableSourceMs,
				sourceFloorMs: range.startMs,
			});
		}
		if (narrationAudio) {
			audioRegions.push({
				id: `audio-${scene.id}`,
				startMs: sceneStartMs,
				endMs: sceneStartMs + narrationAudio.durationMs,
				audioPath: narrationAudio.audioPath,
				volume: 1,
				normalize: false,
				trackIndex: 0,
			});
			autoCaptions.push({
				id: `caption-${scene.id}`,
				startMs: sceneStartMs,
				endMs: sceneStartMs + narrationAudio.durationMs,
				text: narrationAudio.narration,
			});
			audioInputs.push({
				sceneId: scene.id,
				path: narrationAudio.audioPath,
				sha256: narrationAudio.sha256,
				durationMs: narrationAudio.durationMs,
				cacheKey: narrationAudio.cacheKey,
				durationSource: "ffprobe",
			});
		}

		const beats = normalizeVisualBeats(scene, range.actions);
		const sceneContract = {
			id: scene.id,
			previewTelemetrySha256: sha256Text(JSON.stringify({
				range: [range.startMs, range.endMs],
				geometry: actionLog.captureGeometry,
				actions: timelineActions,
				visualActions: beats.map((beat) => (beat.actionId ? actionLog.byId.get(beat.actionId) : range.actions[0]) ?? null),
				cursor: cursorSamples.filter((sample) => sample.timeMs >= range.startMs && sample.timeMs <= range.endMs),
				before: cursorSamples.findLast((sample) => sample.timeMs < range.startMs),
				after: cursorSamples.find((sample) => sample.timeMs > range.endMs),
			})),
			teachingClass: classification,
			disposition,
			objective: scene.objective ?? null,
			actionIds: range.actions.map((action) => action.id),
			source: {
				startMs: range.startMs,
				endMs: range.endMs,
				declaredEndMs: range.declaredEndMs ?? range.endMs,
				speed,
			},
			segments: teachingTimeline.segments,
				timeline: {
					startMs: sceneStartMs,
					contentStartMs: actionTimelineStartMs,
					actionEndMs: actionEndTimelineMs,
					endMs: sceneEndMs,
					preActionHoldMs,
					preActionHoldReason:
						resultSelectionHoldMs > (declaredPreActionHoldMs ?? 0)
							? "result-selection-observation"
							: null,
					preActionStableSourceTimeMs: declaredPreActionStableSourceMs,
					resultClickEvidence,
					observationHoldMs,
					observationHoldSource: observationHoldMs > 0 ? "teaching-plan" : null,
					stableFreezeMs,
				mode: "讲师分段时间轴",
			},
			narrationScript: narration,
			audioPath: narrationAudio?.audioPath ?? null,
			audioDurationMs: narrationAudio?.durationMs ?? 0,
		};
		if (scene.endCard && typeof scene.endCard === "object") {
			cursorHiddenSourceRegions.push({ startMs: range.startMs, endMs: range.endMs });
		}
		if (scene.endCard && typeof scene.endCard === "object") {
			const declaredImagePath =
				typeof scene.endCard.imagePath === "string" && scene.endCard.imagePath.trim()
					? scene.endCard.imagePath.trim()
					: null;
			const resolvedImagePath = declaredImagePath
				? path.resolve(path.dirname(planPath), declaredImagePath)
				: null;
			if (resolvedImagePath && !existsSync(resolvedImagePath)) {
				fail(`End-card image does not exist for Scene ${scene.id}: ${resolvedImagePath}`);
			}
			if (resolvedImagePath && path.extname(resolvedImagePath).toLowerCase() !== ".png") {
				fail(`End-card image must be PNG for Scene ${scene.id}: ${resolvedImagePath}`);
			}
			const endCardImage = resolvedImagePath
				? dataUrl("image/png", await readFile(resolvedImagePath))
				: endCardSvg({
						width: sourceWidth,
						height: sourceHeight,
						kicker: scene.endCard.kicker,
						title: scene.endCard.title,
						lines: scene.endCard.lines,
						note: scene.endCard.note,
						brand: teachingPlan.brand || "#0a6ed1",
					});
			annotationRegions.push({
				id: `end-card-${scene.id}`,
				startMs: sceneStartMs,
				endMs: sceneEndMs,
				type: "image",
				content: endCardImage,
				imageContent: endCardImage,
				position: { x: 0, y: 0 },
				size: { width: 100, height: 100 },
				style: annotationStyle(),
				zIndex: 20,
				trackIndex: 3,
			});
			sceneContract.endCard = {
				imagePath: resolvedImagePath,
				imageSha256: resolvedImagePath ? await sha256File(resolvedImagePath) : null,
				kicker: scene.endCard.kicker ?? null,
				title: scene.endCard.title ?? null,
				lines: Array.isArray(scene.endCard.lines) ? scene.endCard.lines : [],
				note: scene.endCard.note ?? null,
			};
		}
		sceneContracts.push(sceneContract);
		keptSceneContracts.push(sceneContract);

		const captureGeometry =
			scene.captureGeometry || teachingPlan.captureGeometry || actionLog.captureGeometry || run.capture?.geometry;
		const captionPlacement = scene.captionPlacement === "top" ? "top" : "bottom";
		sceneContract.captionPlacement = captionPlacement;
		sceneContract.captionCenterYPercent = null;
		const captionCue = autoCaptions.find((cue) => cue.id === `caption-${scene.id}`);
		if (captionCue) captionCue.placement = captionPlacement;
		for (let beatIndex = 0; beatIndex < beats.length; beatIndex += 1) {
			const beat = beats[beatIndex];
			const beatId = beat.id || `visual-${beatIndex + 1}`;
			const action = beat.actionId ? actionLog.byId.get(beat.actionId) : range.actions[0];
			if (beat.actionId && !action) fail(`Scene ${scene.id} visual beat references unknown action ${beat.actionId}.`);
			const sourceStartMs =
				millisecondsFrom(beat, ["sourceStartMs", "sourceTimeMs"], ["sourceStart", "sourceTime"]) ??
				action?.sourceTimeMs ??
				range.startMs;
			const sourceEndMs =
				millisecondsFrom(beat, ["sourceEndMs"], ["sourceEnd"]) ??
				action?.sourceEndTimeMs ??
				Math.min(range.endMs, sourceStartMs + 1_000);
			const startMs = mapSourceTimeToSceneTimeline(sourceStartMs, sceneContract);
			const mappedEndMs = Math.max(
				startMs + 1,
				mapSourceTimeToSceneTimeline(Math.max(sourceStartMs + 1, sourceEndMs), sceneContract),
			);
			const endMs = Math.min(
				sceneEndMs,
				Math.max(startMs + MIN_VISUAL_EFFECT_MS, mappedEndMs),
			);
			const intent = visualIntentForMode(beat, compileMode);
			if (intent.cursor !== true) {
				const hiddenStartMs = clamp(
					Math.min(sourceStartMs, sourceEndMs),
					0,
					rawMasterInfo.durationMs,
				);
				const hiddenEndMs = clamp(
					Math.max(sourceStartMs, sourceEndMs),
					hiddenStartMs,
					rawMasterInfo.durationMs,
				);
				if (hiddenEndMs > hiddenStartMs) {
					cursorHiddenSourceRegions.push({ startMs: hiddenStartMs, endMs: hiddenEndMs });
				}
			}
			const target = beat.target || action?.target || action?.domTarget || null;
			const targetRect = sourceTargetRect(target, captureGeometry, sourceWidth, sourceHeight);
			if ((intent.highlight === true || intent.zoom === true) && !targetRect) {
				warnings.push({
					code: "VISUAL_TARGET_UNRESOLVED",
					sceneId: scene.id,
					beatId,
					message: "Highlight/Zoom candidate omitted because the DOM target cannot be transformed to Raw Master coordinates.",
				});
			}
			if (intent.highlight === true && targetRect) {
				addHighlight({
					annotationRegions,
					sceneId: scene.id,
					beatId,
					startMs,
					endMs,
					targetRect,
					sourceWidth,
					sourceHeight,
					color: teachingPlan.brand || "#0a6ed1",
				});
			}
			const useTeachingZoom = shouldUseTeachingZoom({
				beat,
				intent,
				target,
				targetRect,
				firstRetainedScene: retainedSceneOrdinal === 0,
				zoomRegions,
				sceneStartMs,
				sceneEndMs,
				startMs,
				sourceWidth,
				sourceHeight,
			});
			if (useTeachingZoom) {
				const zoomAnchorDelayMs = finiteNumber(beat.zoomAnchorDelayMs)
					? clamp(beat.zoomAnchorDelayMs, 0, 2_000)
					: ZOOM_ANCHOR_DELAY_MS;
				const zoomStartMs = Math.min(sceneEndMs, startMs + zoomAnchorDelayMs);
				const defaultZoomEndMs = Math.min(
					sceneEndMs,
					zoomStartMs +
						ZOOM_IN_DURATION_MS +
						ZOOM_REGION_HOLD_MS +
						ZOOM_OUT_EARLY_START_MS -
						ZOOM_IN_LEAD_MS,
				);
				const zoomEndMs = beat.zoomHoldToSceneEnd === true ? sceneEndMs : defaultZoomEndMs;
				const minimumZoomRegionMs =
					ZOOM_IN_DURATION_MS + ZOOM_REGION_HOLD_MS + ZOOM_OUT_EARLY_START_MS - ZOOM_IN_LEAD_MS;
				if (zoomEndMs - zoomStartMs >= minimumZoomRegionMs) {
					zoomRegions.push({
						id: `zoom-${scene.id}-${beatId}`,
						startMs: zoomStartMs,
						endMs: zoomEndMs,
						depth: [1, 2, 3, 4, 5, 6].includes(beat.zoomDepth) ? beat.zoomDepth : 2,
						focus: {
							cx: clamp((targetRect.x + targetRect.width / 2) / sourceWidth, 0, 1),
							cy: clamp((targetRect.y + targetRect.height / 2) / sourceHeight, 0, 1),
						},
						mode: compileMode === "rough" ? "auto" : "manual",
					});
				} else {
					warnings.push({
						code: "ZOOM_WINDOW_TOO_SHORT",
						sceneId: scene.id,
						beatId,
						message: "Teaching Zoom omitted because the retained Scene has no room for a smooth transition and hold.",
					});
				}
			}
			visualBeatContracts.push({
				id: beatId,
				sceneId: scene.id,
				actionId: action?.id ?? null,
				targetId: target?.id ?? target?.targetId ?? null,
				behavior: intent.behavior ?? "clear",
				visualIntent: {
					highlight: intent.highlight === true && Boolean(targetRect),
					cursor: intent.cursor === true,
					zoom: useTeachingZoom,
					typing: false,
				},
				source: { startMs: sourceStartMs, endMs: sourceEndMs },
				timeline: { startMs, endMs },
				target: target ?? null,
			});
		}
		timelineCursorMs = sceneEndMs;
		retainedSceneOrdinal += 1;
	}

	if (keptSceneContracts.length === 0) fail("Agent teaching plan retained no Scenes after A/B/C editing.");
	const mappedCursorSamples = cursorSamples
		.map((sample) => {
			const scene = keptSceneContracts.find(
				(candidate) => sample.timeMs >= candidate.source.startMs && sample.timeMs <= candidate.source.endMs,
			);
			if (!scene) return null;
			return { ...sample, sourceTimeMs: sample.timeMs, timeMs: mapSourceTimeToSceneTimeline(sample.timeMs, scene) };
		})
		.filter(Boolean);
	if (mappedCursorSamples.length < 2) {
		fail("Retained Rough Cut contains fewer than two mapped Browser cursor samples.");
	}
	const normalizedCursorHiddenSourceRegions = mergeCursorHiddenSourceRegions(
		cursorHiddenSourceRegions,
	);

	const editor = {
		wallpaper: "",
		shadowIntensity: 0,
		backgroundBlur: 0,
		zoomMotionBlur: 0,
		connectZooms: teachingPlan.connectZooms === true,
		zoomInDurationMs: ZOOM_IN_DURATION_MS,
		zoomInOverlapMs: 500,
		zoomOutDurationMs: ZOOM_OUT_DURATION_MS,
		connectedZoomGapMs: 1_500,
		connectedZoomDurationMs: CONNECTED_ZOOM_DURATION_MS,
		zoomInEasing: "smooth",
		zoomOutEasing: "smooth",
		connectedZoomEasing: "smooth",
		zoomSmoothness: 0.95,
		zoomClassicMode: false,
		showCursor: true,
		cursorHiddenSourceRegions: normalizedCursorHiddenSourceRegions,
		loopCursor: false,
		cursorStyle: "windows11",
		// Keep the pointer readable without letting the Windows hand cover a
		// neighboring SAP button at normal 1080p playback size.
		cursorSize: finiteNumber(teachingPlan.cursorSize)
			? clamp(teachingPlan.cursorSize, 1.15, 1.4)
			: 1.25,
		cursorSmoothing: 1.25,
		cursorSpringStiffnessMultiplier: 0.8,
		cursorSpringDampingMultiplier: 1.25,
		cursorSpringMassMultiplier: 1.15,
		cursorMotionBlur: 0,
		cursorClickBounce: 0.6,
		cursorClickBounceDuration: 450,
		cursorSway: 0,
		cursorClickEffect: "ripple",
		cursorClickEffectColor: teachingPlan.brand || "#0a6ed1",
		cursorClickEffectScale: 0.65,
		cursorClickEffectOpacity: 0.65,
		cursorClickEffectDurationMs: 650,
		borderRadius: 0,
		padding: { top: 0, bottom: 0, left: 0, right: 0, linked: true },
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		zoomRegions,
		trimRegions: [],
		clipRegions,
		speedRegions: [],
		annotationRegions,
		audioRegions,
		autoCaptions,
		autoCaptionSettings: {
			enabled: compileMode === "final",
			timebase: "timeline",
			timelineQuickAdd: false,
			language: "zh",
			fontFamily: '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
			fontSize: CAPTION_FONT_SIZE_PX,
			bottomOffset: CAPTION_BOTTOM_OFFSET_PERCENT,
			topOffset: CAPTION_TOP_OFFSET_PERCENT,
			maxWidth: 80,
			maxRows: 2,
			animationStyle: "none",
			boxRadius: 8,
			textColor: "#FFFFFF",
			inactiveTextColor: "#E7EEF7",
			backgroundOpacity: 0.72,
		},
		aspectRatio: "16:9",
		exportEncodingMode: "quality",
		exportBackendPreference: "auto",
		exportPipelineModel: "modern",
		exportQuality: "source",
		mp4FrameRate: 30,
		exportFormat: "mp4",
		gifFrameRate: 15,
		gifLoop: true,
		gifSizePreset: "medium",
	};
	const project = {
		version: PROJECT_VERSION,
		projectId: `${runName}-${compileMode}${focusSlug ? `-${focusSlug}` : ""}`,
		videoPath: rawMasterPath,
		editor,
	};
	await writeJsonAtomic(outputPath, project);

	const runSha256 = await sha256File(runJsonPath);
	const rawMasterSha256 = await sha256File(rawMasterPath);
	const actionLogSha256 = await sha256File(actionLogPath);
	const cursorSha256 = await sha256File(cursorPath);
	const projectSha256 = await sha256File(outputPath);
	const contract = {
		schemaVersion: 2,
		status: `ready-for-recordly-${compileMode}`,
		createdAt: new Date().toISOString(),
		run: runName,
		mode: focusSlug ? "focused-preview" : "full",
		compileMode,
		projectPath: outputPath,
		projectSha256,
		recordlyProjectVersion: PROJECT_VERSION,
		inputs: {
			runJson: { path: runJsonPath, sha256: runSha256, sourceSha256: runSourceSha256(run) },
			compilerSha256: await ruleSetSha256(import.meta.url, "./recordly-narration.mjs", "./publication-contract.mjs"),
			teachingPlan: { path: planPath, sha256: teachingPlanSha256 },
			rawMaster: { path: rawMasterPath, sha256: rawMasterSha256, media: rawMasterInfo },
			actionLog: { path: actionLogPath, sha256: actionLogSha256, actions: actionLog.actions.length },
			cursor: {
				path: cursorPath,
				sha256: cursorSha256,
				sourceSamples: cursorSamples.length,
				mappedSamples: mappedCursorSamples.length,
			},
			recordingDiagnostics:
				diagnosticsPath && existsSync(diagnosticsPath)
					? { path: diagnosticsPath, sha256: await sha256File(diagnosticsPath) }
					: null,
			ttsManifest:
				compileMode === "final"
					? { path: ttsManifestPath, sha256: ttsManifestSha256 }
					: null,
			audio: audioInputs,
			recordlyVideoPath: rawMasterPath,
			recordlyVideoSha256: rawMasterSha256,
		},
		teachingPlan: {
			businessGoal: teachingPlan.businessGoal,
			learnerOutcome: teachingPlan.learnerOutcome,
			knowledgePoints: teachingPlan.knowledgePoints,
		},
		scenes: sceneContracts,
		visualBeats: visualBeatContracts,
		policies: {
			editing: {
				maxNonTeachingSpeed: MAX_NON_TEACHING_SPEED,
				maxStableFreezeMs: MAX_STABLE_FREEZE_MS,
				maxPreActionHoldMs: MAX_PRE_ACTION_HOLD_MS,
				maxIdleDisplayMs: MAX_IDLE_DISPLAY_MS,
				resultDwellMs: RESULT_DWELL_MS,
				observationHoldSource: "teaching-plan.scene.observationHoldMs",
			},
			caption: {
				source: "Narration Script",
				timing: "ffprobe-measured-wav-duration",
				timebase: "timeline",
			},
			wholeVideoPlaybackRate: 1,
		},
		cursor: {
			mode: actionLog.source === "browser-action-timeline" ? "browser-action-timeline" : "legacy-session-telemetry",
			showCursor: true,
			hiddenSourceRegions: normalizedCursorHiddenSourceRegions,
			sidecarPath: cursorPath,
			sourceSamples: cursorSamples.length,
			mappedSamples: mappedCursorSamples.length,
		},
		export: {
			format: "mp4",
			codec: "h264",
			audioCodec: "aac",
			width: 1920,
			height: 1080,
			frameRate: 30,
			quality: "source",
		},
		warnings,
		manualHelp: [],
		publicationGate: {
			compile: "passed",
			roughCut: "passed",
			finalCut: compileMode === "final" ? "passed" : "pending",
			focusedPreview: compileMode === "final" && focusSlug ? "ready-for-export" : "pending",
			fullExport: "pending",
			finalValidation: "pending",
			publishable: false,
		},
	};
	await writeJsonAtomic(contractPath, contract);
	console.log(
		JSON.stringify(
			{
				status: contract.status,
				mode: compileMode,
				project: outputPath,
				contract: contractPath,
				retainedScenes: keptSceneContracts.length,
				removedScenes: sceneContracts.filter((scene) => scene.disposition === "remove").length,
				durationMs: timelineCursorMs,
				warnings: warnings.length,
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
