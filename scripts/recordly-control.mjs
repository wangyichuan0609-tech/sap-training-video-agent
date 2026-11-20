#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertCompiledContract, assertPublishableRun, reviewedPreviewEvidence } from "./publication-contract.mjs";

const MANUAL_HELP_EXIT_CODE = 2;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(scriptDirectory);

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

async function sha256File(filePath) {
	const hash = createHash("sha256");
	hash.update(await readFile(filePath));
	return hash.digest("hex");
}

async function writeJsonAtomic(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
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

function assertAllowedOptions(options, allowed) {
	const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
	if (unexpected.length > 0) {
		throw new Error(`Unsupported option(s): ${unexpected.map((key) => `--${key}`).join(", ")}`);
	}
}

function requireTextOption(options, key) {
	const value = options[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required.`);
	return value.trim();
}

function findElectronRuntime(recordlyDirectory, options) {
	const candidates = [
		options["electron-exe"],
		process.env.RECORDLY_ELECTRON_EXE,
		path.join(recordlyDirectory, "node_modules", "electron", "dist", "electron.exe"),
	].filter(Boolean);
	for (const candidate of candidates) {
		const absolutePath = path.resolve(String(candidate));
		if (existsSync(absolutePath)) return absolutePath;
	}
	return null;
}

async function writeManualHelp({
	projectPath,
	outputPath,
	contractPath,
	focusedContractPath,
	phase,
	reason,
	recordlyDirectory,
}) {
	const manualHelpPath = `${outputPath}.manual-help.json`;
	const payload = {
		schemaVersion: 1,
		status: "manual-help-required",
		reason,
		projectPath,
		outputPath,
		contractPath,
		recordlyDirectory,
		steps: [
			"Let the Agent open the generated .recordly file in the visible Recordly app; do not rebuild or re-record SAP.",
			"Review the focused project first: target bounds, crop/letterbox mapping, Caption bottom placement, audio timing, Cursor policy, and the exact one-second dwell.",
			"For the full project choose MP4, source quality, 30 fps, and 16:9. Export to the requested output path.",
			phase === "focused"
				? `Run media validation: node scripts/validate-final-video.mjs --input=\"${outputPath}\" --project=\"${projectPath}\" --contract=\"${contractPath}\" --gate=focused; after the Agent visually reviews that same MP4, rerun with --visual-review=passed.`
				: `Run final validation: node scripts/validate-final-video.mjs --input=\"${outputPath}\" --project=\"${projectPath}\" --contract=\"${contractPath}\" --gate=final --focused-contract=\"${focusedContractPath}\". Add --run-json only for the authoritative run.json.`,
			"Do not publish and do not silently fall back to another production pipeline while manual-help remains.",
		],
	};
	await writeJsonAtomic(manualHelpPath, payload);
	console.error(`MANUAL_HELP_REQUIRED: ${reason}`);
	console.error(`Manual-help contract: ${manualHelpPath}`);
	return manualHelpPath;
}

function runValidator({
	outputPath,
	projectPath,
	contractPath,
	runJsonPath,
	focusedContractPath,
	phase,
}) {
	const validatorPath = path.join(scriptDirectory, "validate-final-video.mjs");
	const args = [validatorPath, `--input=${outputPath}`, `--project=${projectPath}`];
	if (contractPath)
		args.push(
			`--contract=${contractPath}`,
			`--gate=${phase === "focused" ? "focused" : "final"}`,
		);
	if (runJsonPath && phase !== "focused") args.push(`--run-json=${runJsonPath}`);
	if (focusedContractPath && phase !== "focused") {
		args.push(`--focused-contract=${focusedContractPath}`);
	}
	const result = spawnSync(process.execPath, args, {
		cwd: workspaceRoot,
		encoding: "utf8",
		windowsHide: true,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`Final video validator failed with exit code ${result.status}.`);
}

async function launchSmokeExport({
	electronPath,
	recordlyDirectory,
	projectPath,
	outputPath,
	timeoutMs,
}) {
	const temporaryRoot = path.resolve(os.tmpdir());
	const smokeRoot = path.resolve(
		await mkdtemp(path.join(temporaryRoot, "recordly-smoke-export-")),
	);
	const relativeSmokeRoot = path.relative(temporaryRoot, smokeRoot);
	if (
		!relativeSmokeRoot ||
		relativeSmokeRoot.startsWith("..") ||
		path.isAbsolute(relativeSmokeRoot) ||
		!path.basename(smokeRoot).startsWith("recordly-smoke-export-")
	) {
		throw new Error(`Refusing to use an unsafe temporary export directory: ${smokeRoot}`);
	}
	const smokeUserDataDir = path.join(smokeRoot, "user-data");
	const smokeProjectPath = path.join(smokeRoot, `project-${randomUUID()}.recordly`);
	await mkdir(smokeUserDataDir, { recursive: true });
	await copyFile(projectPath, smokeProjectPath);
	try {
		await new Promise((resolve, reject) => {
			const child = spawn(electronPath, [`--user-data-dir=${smokeUserDataDir}`, recordlyDirectory], {
				cwd: recordlyDirectory,
				env: {
					...process.env,
					// Export a disposable project copy because Recordly normalizes and
					// autosaves every opened project. The compiled project and its
					// contract must remain byte-for-byte bound after export.
					RECORDLY_BROWSER_CAPTURE_PORT: "0",
					RECORDLY_SMOKE_EXPORT: "1",
					RECORDLY_SMOKE_EXPORT_PROJECT: smokeProjectPath,
					RECORDLY_SMOKE_EXPORT_OUTPUT: outputPath,
					RECORDLY_SMOKE_EXPORT_ENCODING_MODE: "quality",
					RECORDLY_SMOKE_EXPORT_PIPELINE: "modern",
					RECORDLY_SMOKE_EXPORT_BACKEND: "auto",
					RECORDLY_SMOKE_EXPORT_QUALITY: "source",
					RECORDLY_SMOKE_EXPORT_FPS: "30",
				},
				stdio: "inherit",
				windowsHide: false,
			});
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`Recordly automated export timed out after ${timeoutMs} ms.`));
			}, timeoutMs);
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				clearTimeout(timeout);
				if (code === 0) resolve();
				else
					reject(
						new Error(
							`Recordly exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`,
						),
					);
			});
		});
	} finally {
		await rm(smokeRoot, { recursive: true, force: true });
	}
}

async function main() {
	const { options, positional } = parseArgs(process.argv.slice(2));
	assertAllowedOptions(
		options,
		new Set([
			"project",
			"output",
			"contract",
			"run-json",
			"phase",
			"focused-contract",
			"recordly-dir",
			"timeout-ms",
			"electron-exe",
			"overwrite",
		]),
	);
	if (positional.length > 1) {
		throw new Error(`Unexpected positional argument(s): ${positional.slice(1).join(", ")}`);
	}
	const command = positional[0] || "export";
	if (command !== "export") {
		throw new Error(
			"Usage: recordly-control.mjs export --project=<project.recordly> --output=<output.mp4> [--phase=focused|full]. Internal SAP capture uses scripts/recordly-sap-capture.mjs.",
		);
	}
	const projectPath = path.resolve(requireTextOption(options, "project"));
	const outputPath = path.resolve(requireTextOption(options, "output"));
	const contractPath = options.contract
		? path.resolve(String(options.contract))
		: `${projectPath}.contract.json`;
	const runJsonPath = options["run-json"] ? path.resolve(String(options["run-json"])) : null;
	const requestedPhase = options.phase ?? "full";
	if (requestedPhase !== "focused" && requestedPhase !== "full") {
		throw new Error("--phase must be focused or full.");
	}
	const phase = requestedPhase;
	const focusedContractPath = options["focused-contract"]
		? path.resolve(String(options["focused-contract"]))
		: null;
	const recordlyDirectory = path.resolve(
		String(options["recordly-dir"] || path.join(workspaceRoot, "recordly")),
	);
	const timeoutMs = Number(options["timeout-ms"] || 30 * 60 * 1000);
	if (!existsSync(projectPath))
		throw new Error(`Recordly project does not exist: ${projectPath}`);
	if (!existsSync(recordlyDirectory))
		throw new Error(`Recordly source directory does not exist: ${recordlyDirectory}`);
	if (focusedContractPath && !existsSync(focusedContractPath)) {
		throw new Error(`Focused Preview contract does not exist: ${focusedContractPath}`);
	}
	if (runJsonPath && phase === "focused") throw new Error("--run-json is only valid for full publication.");
	if (focusedContractPath && phase === "focused") {
		throw new Error("--focused-contract is only valid with --phase=full.");
	}
	if (phase === "full" && !focusedContractPath) {
		throw new Error(
			"Full Recordly export requires --focused-contract from the passed Focused Preview.",
		);
	}
	const project = await readJson(projectPath);
	if (project.version !== 2 || !project.videoPath || !project.editor) {
		throw new Error(`Recordly project schema is invalid: ${projectPath}`);
	}
	if (!existsSync(contractPath)) {
		throw new Error(`Recordly compile contract does not exist: ${contractPath}`);
	}
	const contract = await readJson(contractPath);
	const expectedMode = phase === "focused" ? "focused-preview" : "full";
	assertCompiledContract(contract, contractPath, expectedMode);
	if (path.resolve(String(contract.projectPath || "")) !== projectPath) {
		throw new Error("Recordly contract is not bound to the project being exported.");
	}
	if ((await sha256File(projectPath)) !== contract.projectSha256) {
		throw new Error("Recordly project changed after its contract was compiled.");
	}
	if (phase === "full") {
		const focusedContract = await readJson(focusedContractPath);
		reviewedPreviewEvidence(focusedContract, contract);
		await assertPublishableRun(contract, runJsonPath);
	}
	if (existsSync(outputPath) && !options.overwrite) {
		throw new Error(
			`Output already exists; pass --overwrite to replace this exact file: ${outputPath}`,
		);
	}
	if (existsSync(outputPath) && options.overwrite) await unlink(outputPath);
	if (existsSync(`${outputPath}.report.json`) && options.overwrite)
		await unlink(`${outputPath}.report.json`);
	await mkdir(path.dirname(outputPath), { recursive: true });

	const electronPath = findElectronRuntime(recordlyDirectory, options);
	if (!electronPath) {
		await writeManualHelp({
			projectPath,
			outputPath,
			contractPath,
			focusedContractPath,
			phase,
			recordlyDirectory,
			reason: "The installed Recordly source has an internal smoke-export automation hook, but no runnable Electron binary was found. AI-operated visible Recordly UI is the required gate for this run.",
		});
		process.exitCode = MANUAL_HELP_EXIT_CODE;
		return;
	}

	try {
		await launchSmokeExport({
			electronPath,
			recordlyDirectory,
			projectPath,
			outputPath,
			timeoutMs,
		});
		if ((await sha256File(projectPath)) !== contract.projectSha256) {
			throw new Error("Recordly source project changed during export.");
		}
		if (!existsSync(outputPath) || (await stat(outputPath)).size <= 0) {
			const reportPath = `${outputPath}.report.json`;
			const report = existsSync(reportPath)
				? await readFile(reportPath, "utf8")
				: "no report";
			throw new Error(`Recordly did not produce the requested MP4. Export report: ${report}`);
		}
	} catch (error) {
		await writeManualHelp({
			projectPath,
			outputPath,
			contractPath,
			focusedContractPath,
			phase,
			recordlyDirectory,
			reason: error instanceof Error ? error.message : String(error),
		});
		process.exitCode = MANUAL_HELP_EXIT_CODE;
		return;
	}

	runValidator({ outputPath, projectPath, contractPath, runJsonPath, focusedContractPath, phase });
	const completionStatus = phase === "focused" ? "media-validated-awaiting-visual-review" : "completed";
	console.log(
		JSON.stringify(
			{
				status: completionStatus,
				phase,
				project: projectPath,
				output: outputPath,
				validation: "passed",
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
