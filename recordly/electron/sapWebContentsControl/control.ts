import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSapBrowserWindow } from "../sapBrowser";
import { executeSapWebContentsAction } from "./controller";

const CONTROL_ARGUMENT_PREFIX = "--recordly-sap-control=";
export const SAP_WEB_CONTENTS_CONTROL_DIRECTORY = path.join(
	os.tmpdir(),
	"recordly-sap-web-contents-control",
);

function isContained(rootPath: string, candidatePath: string): boolean {
	const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
	return (
		relative.length > 0 &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function getRequestPath(commandLine: readonly string[]): string | null {
	const argument = commandLine.find((value) => value.startsWith(CONTROL_ARGUMENT_PREFIX));
	if (!argument) return null;
	const requestPath = path.resolve(argument.slice(CONTROL_ARGUMENT_PREFIX.length));
	if (
		!isContained(SAP_WEB_CONTENTS_CONTROL_DIRECTORY, requestPath) ||
		!path.basename(requestPath).startsWith("request-") ||
		!requestPath.endsWith(".json")
	) {
		throw new Error("SAP WebContents control request is outside the private directory.");
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

export function hasSapWebContentsControlArgument(commandLine: readonly string[]): boolean {
	return commandLine.some((value) => value.startsWith(CONTROL_ARGUMENT_PREFIX));
}

export async function processSapWebContentsControlArgument(
	commandLine: readonly string[],
): Promise<boolean> {
	let requestPath: string | null = null;
	try {
		requestPath = getRequestPath(commandLine);
		if (!requestPath) return false;

		await fs.mkdir(SAP_WEB_CONTENTS_CONTROL_DIRECTORY, { recursive: true, mode: 0o700 });
		const responsePath = `${requestPath}.response.json`;
		try {
			const parsed = JSON.parse(await fs.readFile(requestPath, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("SAP WebContents control request must be a JSON object.");
			}
			const raw = parsed as Record<string, unknown>;
			if (
				raw.command !== "execute" ||
				Object.keys(raw).some((key) => key !== "command" && key !== "action")
			) {
				throw new Error("Unsupported SAP WebContents control request.");
			}
			const sapWindow = getSapBrowserWindow();
			if (!sapWindow) throw new Error("No current Recordly SAP BrowserWindow is open.");
			const result = await executeSapWebContentsAction(sapWindow, raw.action);
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
