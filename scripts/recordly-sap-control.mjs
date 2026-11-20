#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(scriptDirectory);
const controlDirectory = path.join(os.tmpdir(), "recordly-sap-web-contents-control");

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

function selectorFromOptions(options) {
	if (options.selector !== undefined && options["target-text"] !== undefined) {
		throw new Error("Use exactly one of --selector or --target-text.");
	}
	if (options.selector !== undefined) {
		try {
			return JSON.parse(String(options.selector));
		} catch {
			throw new Error("--selector must be valid JSON.");
		}
	}
	if (typeof options["target-text"] === "string" && options["target-text"].trim()) {
		return { by: "visibleText", value: options["target-text"] };
	}
	throw new Error("The action requires --selector=<JSON> or --target-text=<exact text>.");
}

function assertAllowedOptions(options, allowed) {
	const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
	if (unexpected.length > 0) {
		throw new Error(`Unsupported option(s): ${unexpected.map((key) => `--${key}`).join(", ")}`);
	}
}

function buildAction(command, options) {
	const common = new Set(["electron-exe", "recordly-dir", "timeout-ms", "log"]);
	if (command === "state") {
		assertAllowedOptions(options, common);
		return { action: "state" };
	}
	if (command === "login-from-file") {
		common.add("credentials");
		assertAllowedOptions(options, common);
		if (typeof options.credentials !== "string" || !options.credentials.trim()) {
			throw new Error("login-from-file requires --credentials=<absolute path>.");
		}
		return {
			action: "login-from-file",
			credentialFilePath: path.resolve(options.credentials),
		};
	}
	if (command === "change-password-from-files") {
		common.add("credentials");
		common.add("new-password-file");
		assertAllowedOptions(options, common);
		if (typeof options.credentials !== "string" || !options.credentials.trim()) {
			throw new Error("change-password-from-files requires --credentials=<absolute path>.");
		}
		if (
			typeof options["new-password-file"] !== "string" ||
			!options["new-password-file"].trim()
		) {
			throw new Error(
				"change-password-from-files requires --new-password-file=<absolute path>.",
			);
		}
		return {
			action: "change-password-from-files",
			credentialFilePath: path.resolve(options.credentials),
			newPasswordFilePath: path.resolve(options["new-password-file"]),
		};
	}

	common.add("selector");
	common.add("target-text");
	const selector = selectorFromOptions(options);
	if (command === "find" || command === "click") {
		assertAllowedOptions(options, common);
		return { action: command, selector };
	}
	if (command === "press") {
		common.add("key");
		assertAllowedOptions(options, common);
		if (typeof options.key !== "string" || !options.key.trim()) {
			throw new Error("press requires --key=<key name>.");
		}
		return { action: "press", selector, key: options.key };
	}
	if (command === "scroll") {
		common.add("delta-x");
		common.add("delta-y");
		assertAllowedOptions(options, common);
		const deltaX = options["delta-x"] === undefined ? 0 : Number(options["delta-x"]);
		const deltaY = options["delta-y"] === undefined ? 0 : Number(options["delta-y"]);
		if (
			!Number.isFinite(deltaX) ||
			!Number.isFinite(deltaY) ||
			Math.abs(deltaX) > 10_000 ||
			Math.abs(deltaY) > 10_000 ||
			(deltaX === 0 && deltaY === 0)
		) {
			throw new Error(
				"scroll requires a non-zero --delta-x or --delta-y within 10000 pixels.",
			);
		}
		return { action: "scroll", selector, deltaX, deltaY };
	}
	if (command === "wait") {
		common.add("wait-ms");
		assertAllowedOptions(options, common);
		const timeoutMs = Number(options["wait-ms"] || 5_000);
		return { action: "wait", selector, timeoutMs };
	}
	if (command === "type") {
		common.add("value");
		common.add("secret-file");
		assertAllowedOptions(options, common);
		if ((options.value === undefined) === (options["secret-file"] === undefined)) {
			throw new Error("type requires exactly one of --value or --secret-file.");
		}
		return {
			action: "type",
			selector,
			...(options["secret-file"] === undefined
				? { text: String(options.value) }
				: { secretFilePath: path.resolve(String(options["secret-file"])) }),
		};
	}
	if (command === "type-legacy-grid-cell") {
		common.add("value");
		common.add("commit-enter");
		assertAllowedOptions(options, common);
		if (typeof options.value !== "string" || !options.value.trim()) {
			throw new Error("type-legacy-grid-cell requires --value=<business code>.");
		}
		if (options["commit-enter"] !== undefined && options["commit-enter"] !== true) {
			throw new Error("--commit-enter is a flag and does not accept a value.");
		}
		return {
			action: "type-legacy-grid-cell",
			selector,
			text: options.value,
			...(options["commit-enter"] === true ? { commitWithEnter: true } : {}),
		};
	}
	throw new Error("Unsupported SAP control command.");
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

async function sendRequest(action, options) {
	const recordlyDirectory = path.resolve(
		String(options["recordly-dir"] || path.join(workspaceRoot, "recordly")),
	);
	const electronPath = findElectronRuntime(recordlyDirectory, options);
	if (!electronPath) throw new Error("No runnable Recordly Electron binary was found.");
	const timeoutMs = Number(
		options["timeout-ms"] || Math.max(20_000, (action.timeoutMs || 0) + 5_000),
	);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
		throw new Error("--timeout-ms must be between 1000 and 60000.");
	}

	await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
	const requestPath = path.join(
		controlDirectory,
		`request-${process.pid}-${Date.now()}-${randomUUID()}.json`,
	);
	const responsePath = `${requestPath}.response.json`;
	await writeFile(requestPath, `${JSON.stringify({ command: "execute", action }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});

	const child = spawn(
		electronPath,
		[recordlyDirectory, `--recordly-sap-control=${requestPath}`],
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
		if (!response?.ok) throw new Error(response?.error || "Recordly rejected the SAP action.");
		return response.result;
	} finally {
		await Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })]);
	}
}

async function main() {
	const { options, positional } = parseArgs(process.argv.slice(2));
	const command = positional[0];
	if (
		!new Set([
			"state",
			"login-from-file",
			"change-password-from-files",
			"find",
			"click",
			"press",
			"scroll",
			"type",
			"type-legacy-grid-cell",
			"wait",
		]).has(command) ||
		positional.length !== 1
	) {
		throw new Error(
			"Usage: node scripts/recordly-sap-control.mjs <state|login-from-file|change-password-from-files|find|click|press|scroll|type|type-legacy-grid-cell|wait> [options]",
		);
	}
	const action = buildAction(command, options);
	const result = await sendRequest(action, options);
	console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
