"use strict";

const fs = require("node:fs/promises");
const { app, BrowserWindow } = require("electron");

const argumentPrefix = "--fixture-control=";
const argument = process.argv.find((value) => value.startsWith(argumentPrefix));

async function run() {
	if (!argument) throw new Error("Missing fixture control input.");
	const inputPath = argument.slice(argumentPrefix.length);
	const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
	app.setPath("userData", input.userDataPath);
	await app.whenReady();

	const window = new BrowserWindow({
		show: false,
		width: 900,
		height: 700,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			backgroundThrottling: false,
		},
	});
	await window.loadFile(input.fixturePath, { query: { "sap-client": "460" } });
	const results = [];
	for (const script of input.scripts) {
		try {
			results.push({ ok: true, result: await window.webContents.executeJavaScript(script) });
		} catch (error) {
			results.push({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	await fs.writeFile(input.outputPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
	window.destroy();
	app.quit();
}

run().catch(async (error) => {
	if (argument) {
		try {
			const input = JSON.parse(
				await fs.readFile(argument.slice(argumentPrefix.length), "utf8"),
			);
			await fs.writeFile(
				input.outputPath,
				`${JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) })}\n`,
				"utf8",
			);
		} catch {
			// The parent process will report the missing output.
		}
	}
	app.exit(1);
});
