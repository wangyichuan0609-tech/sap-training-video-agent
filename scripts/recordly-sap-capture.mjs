#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(scriptDirectory);
const controlDirectory = path.join(os.tmpdir(), "recordly-sap-capture-control");

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

function findElectronRuntime(recordlyDirectory, options) {
	const candidates = [
		options["electron-exe"],
		process.env.RECORDLY_ELECTRON_EXE,
		path.join(recordlyDirectory, "node_modules", "electron", "dist", "electron.exe"),
	].filter(Boolean);
	return (
		candidates
			.map(String)
			.map((candidate) => path.resolve(candidate))
			.find(existsSync) || null
	);
}

function wait(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForResponse(responsePath, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(await readFile(responsePath, "utf8"));
		} catch (error) {
			if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) lastError = error;
		}
		await wait(50);
	}
	throw lastError || new Error(`Timed out waiting for Recordly after ${timeoutMs} ms.`);
}

async function sendControlRequest(command, options) {
	const recordlyDirectory = path.resolve(
		String(options["recordly-dir"] || path.join(workspaceRoot, "recordly")),
	);
	const electronPath = findElectronRuntime(recordlyDirectory, options);
	if (!electronPath) throw new Error("No runnable Recordly Electron binary was found.");

	const timeoutMs = Number(options["timeout-ms"] || 120_000);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000) {
		throw new Error("--timeout-ms must be between 1000 and 180000.");
	}
	const allowedOptions = new Set([
		"electron-exe",
		"recordly-dir",
		"timeout-ms",
		"diagnostics",
	]);
	const request = { command };
	if (command === "start") {
		allowedOptions.add("output");
		allowedOptions.add("run-json");
		if (typeof options.output !== "string" || !options.output.trim()) {
			throw new Error("start requires --output=<absolute .webm path>.");
		}
		request.outputPath = path.resolve(options.output);
		if (options["run-json"] !== undefined) {
			if (typeof options["run-json"] !== "string" || !options["run-json"].trim()) {
				throw new Error("--run-json requires a run.json path.");
			}
			request.runJsonPath = path.resolve(options["run-json"]);
		}
	}
	const unsupported = Object.keys(options).filter((key) => !allowedOptions.has(key));
	if (unsupported.length > 0) {
		throw new Error(
			`Unsupported option(s): ${unsupported.map((key) => `--${key}`).join(", ")}`,
		);
	}

	await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
	const requestPath = path.join(
		controlDirectory,
		`request-${process.pid}-${Date.now()}-${randomUUID()}.json`,
	);
	const responsePath = `${requestPath}.response.json`;
	await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});

	const child = spawn(
		electronPath,
		[recordlyDirectory, `--recordly-sap-capture-control=${requestPath}`],
		{
			cwd: recordlyDirectory,
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		},
	);
	child.unref();

	try {
		const response = await waitForResponse(responsePath, timeoutMs);
		if (!response?.ok) throw new Error(response?.error || "Recordly rejected the request.");
		return response.result;
	} finally {
		await Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })]);
	}
}

async function updateDiagnostics(filePath, command, requestedAt, result) {
	const resolvedPath = path.resolve(String(filePath));
	await mkdir(path.dirname(resolvedPath), { recursive: true });
	let document = { version: 1 };
	try {
		document = JSON.parse(await readFile(resolvedPath, "utf8"));
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (command === "start") {
		document = {
			version: 1,
			startedAt: requestedAt,
			status: result,
		};
	} else if (command === "stop") {
		document.stoppedAt = new Date().toISOString();
		document.completed = result;
	}
	const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
	await rm(resolvedPath, { force: true });
	await rename(temporaryPath, resolvedPath);
}

async function main() {
	const { options, positional } = parseArgs(process.argv.slice(2));
	const command = positional[0];
	if (!new Set(["start", "status", "stop"]).has(command)) {
		throw new Error(
			"Usage: node scripts/recordly-sap-capture.mjs <start|status|stop> [--output=<absolute .webm path>]",
		);
	}
	if (positional.length !== 1) throw new Error("Only one command may be specified.");
	const requestedAt = new Date().toISOString();
	const result = await sendControlRequest(command, options);
	if (options.diagnostics && command !== "status") {
		await updateDiagnostics(options.diagnostics, command, requestedAt, result);
	}
	console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
