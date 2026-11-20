import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSapBrowserWindow } from "../sapBrowser";
import {
	getSapWebContentsCaptureStatus,
	startSapWebContentsCapture,
	stopSapWebContentsCapture,
} from "./controller";

const CONTROL_ARGUMENT_PREFIX = "--recordly-sap-capture-control=";
export const SAP_CAPTURE_CONTROL_DIRECTORY = path.join(os.tmpdir(), "recordly-sap-capture-control");

function isContained(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
	return (
		relative.length > 0 &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function getControlRequestPath(commandLine: readonly string[]): string | null {
	const argument = commandLine.find((candidate) => candidate.startsWith(CONTROL_ARGUMENT_PREFIX));
	if (!argument) return null;

	const requestPath = path.resolve(argument.slice(CONTROL_ARGUMENT_PREFIX.length));
	if (
		!isContained(SAP_CAPTURE_CONTROL_DIRECTORY, requestPath) ||
		!path.basename(requestPath).startsWith("request-") ||
		!requestPath.endsWith(".json")
	) {
		throw new Error("SAP capture control request is outside the private control directory.");
	}
	return requestPath;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await fs.rm(filePath, { force: true });
	await fs.rename(temporaryPath, filePath);
}

function assertExactKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
		throw new Error("SAP capture control request contains unsupported fields.");
	}
}

export function hasSapCaptureControlArgument(commandLine: readonly string[]): boolean {
	return commandLine.some((argument) => argument.startsWith(CONTROL_ARGUMENT_PREFIX));
}

export async function processSapCaptureControlArgument(
	commandLine: readonly string[],
): Promise<boolean> {
	let requestPath: string | null = null;
	try {
		requestPath = getControlRequestPath(commandLine);
		if (!requestPath) return false;

		await fs.mkdir(SAP_CAPTURE_CONTROL_DIRECTORY, { recursive: true, mode: 0o700 });
		const responsePath = `${requestPath}.response.json`;
		try {
			const parsed = JSON.parse(await fs.readFile(requestPath, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("SAP capture control request must be a JSON object.");
			}
			const raw = parsed as Record<string, unknown>;
			let result: unknown;
			switch (raw.command) {
				case "start": {
					assertExactKeys(raw, ["command", "outputPath", "runJsonPath"]);
					if (typeof raw.outputPath !== "string" || !raw.outputPath.trim()) {
						throw new Error("SAP capture start requires outputPath.");
					}
					if (raw.runJsonPath !== undefined && (typeof raw.runJsonPath !== "string" || !raw.runJsonPath.trim())) {
						throw new Error("SAP capture runJsonPath must be a run.json path.");
					}
					const sapWindow = getSapBrowserWindow();
					if (!sapWindow) {
						throw new Error("No current Recordly SAP BrowserWindow is open.");
					}
					result = await startSapWebContentsCapture(sapWindow, raw.outputPath, raw.runJsonPath);
					break;
				}
				case "status":
					assertExactKeys(raw, ["command"]);
					result = getSapWebContentsCaptureStatus();
					break;
				case "stop":
					assertExactKeys(raw, ["command"]);
					result = await stopSapWebContentsCapture();
					break;
				default:
					throw new Error("Unsupported SAP capture control command.");
			}
			await writeJsonAtomic(responsePath, { ok: true, result });
		} catch (error) {
			await writeJsonAtomic(responsePath, {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return true;
	} finally {
		if (requestPath) await fs.rm(requestPath, { force: true });
	}
}
