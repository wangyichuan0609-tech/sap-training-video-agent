"use strict";

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const http = require("node:http");
const ts = require("typescript");
const { app, BrowserWindow } = require("electron");

const argumentPrefix = "--cdp-frame-fixture=";
const argument = process.argv.find((value) => value.startsWith(argumentPrefix));

require.extensions[".ts"] = (module, filename) => {
	const source = fs.readFileSync(filename, "utf8");
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2020,
			module: ts.ModuleKind.CommonJS,
			esModuleInterop: true,
			moduleResolution: ts.ModuleResolutionKind.NodeJs,
		},
		fileName: filename,
	});
	module._compile(compiled.outputText, filename);
};

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, () => {
			server.removeListener("error", reject);
			resolve(server.address().port);
		});
	});
}

function childDocument(pathname) {
	if (pathname === "/reloaded") {
		return `<!doctype html>
		<html><head><title>Reloaded Business Frame</title></head>
		<body><button id="after-navigation">After Navigation</button></body></html>`;
	}
	if (pathname === "/late") {
		return `<!doctype html>
		<html><head><title>Late Business Frame</title></head>
		<body><button id="late-target">Late Target</button></body></html>`;
	}
	if (pathname === "/stale") {
		return `<!doctype html>
		<html><head><title>Stale Business Frame</title></head>
		<body><button id="frame-click">Hidden Duplicate Action</button></body></html>`;
	}
	if (pathname === "/transformed") {
		return `<!doctype html>
		<html><head><title>Transformed Business Frame</title></head>
		<body><button id="transformed-target">Transformed Target</button></body></html>`;
	}
	if (pathname === "/nested") {
		return `<!doctype html>
		<html><head><title>Nested Business Frame</title></head>
		<body>
			<button id="nested-click">Nested Action</button>
			<p id="nested-result">nested:false</p>
			<script>
				document.getElementById("nested-click").addEventListener("click", (event) => {
					document.getElementById("nested-result").textContent =
						"nested:" + event.isTrusted;
				});
			</script>
		</body></html>`;
	}
	return `<!doctype html>
	<html>
		<head><title>Business Frame</title></head>
		<body>
			<button id="frame-click">Child Action</button>
			<button id="child-duplicate">Duplicate</button>
			<label for="frame-input">Frame Input</label>
			<input id="frame-input" value="Legacy-42" />
			<span
				id="legacy-grid-cell"
				role="textbox"
				tabindex="0"
				aria-label="Legacy Grid Cell"
				style="display:inline-block;width:180px;height:24px;border:1px solid black"
			></span>
			<button id="navigate-frame">Navigate Frame</button>
			<p id="result">click:false input:false inputCount:0 changeCount:0 key:false keyTrusted:true keyCount:0 value: wheel:false wheelCount:0 scroll:false scrollCount:0</p>
			<p id="legacy-grid-result">gridClick:false gridFocus:false gridKeyTrusted:true gridKeyCount:0 gridCommitted:false gridDisplay:</p>
			<div id="scroll-box" style="width:500px;height:70px;overflow:auto;border:1px solid black">
				<div style="height:320px">Scrollable Business Content</div>
			</div>
			<iframe id="nested-frame" src="/nested" style="width:500px;height:100px"></iframe>
			<script>
				const result = document.getElementById("result");
				const input = document.getElementById("frame-input");
				const legacyGridCell = document.getElementById("legacy-grid-cell");
				const legacyGridResult = document.getElementById("legacy-grid-result");
				const scrollBox = document.getElementById("scroll-box");
				const state = {
					click: false,
					inputTrusted: true,
					inputCount: 0,
					changeTrusted: true,
					changeCount: 0,
					value: input.value,
					key: false,
					f4: false,
					keyTrusted: true,
					keyCount: 0,
					wheelTrusted: true,
					wheelCount: 0,
					scrollTrusted: true,
					scrollCount: 0,
				};
				const legacyGridState = {
					clickTrusted: false,
					focusTrusted: false,
					keyTrusted: true,
					keyCount: 0,
					pressTrusted: true,
					pressCount: 0,
					committed: false,
					buffer: "",
					eventOrder: [],
				};
				const renderLegacyGrid = () => {
					legacyGridResult.textContent =
						"gridClick:" + legacyGridState.clickTrusted +
						" gridFocus:" + legacyGridState.focusTrusted +
						" gridKeyTrusted:" + legacyGridState.keyTrusted +
						" gridKeyCount:" + legacyGridState.keyCount +
						" gridPressTrusted:" + legacyGridState.pressTrusted +
						" gridPressCount:" + legacyGridState.pressCount +
						" gridCommitted:" + legacyGridState.committed +
						" gridEventOrder:" + legacyGridState.eventOrder.join(",") +
						" gridDisplay:" + legacyGridCell.textContent;
				};
				const render = () => {
					result.textContent =
						"click:" + state.click +
						" input:" + (state.inputCount > 0 && state.inputTrusted) +
						" inputCount:" + state.inputCount +
						" changeCount:" + state.changeCount +
						" changeTrusted:" + state.changeTrusted +
						" value:" + state.value +
						" key:" + state.key +
						" f4:" + state.f4 +
						" keyTrusted:" + state.keyTrusted +
						" keyCount:" + state.keyCount +
						" wheel:" + (state.wheelCount > 0 && state.wheelTrusted) +
						" wheelCount:" + state.wheelCount +
						" scroll:" + (state.scrollCount > 0 && state.scrollTrusted) +
						" scrollCount:" + state.scrollCount;
				};
				document.getElementById("frame-click").addEventListener("click", (event) => {
					state.click = event.isTrusted;
					render();
				});
				input.addEventListener("input", (event) => {
					state.inputTrusted = state.inputTrusted && event.isTrusted;
					state.inputCount += 1;
					state.value = input.value;
					render();
				});
				input.addEventListener("change", (event) => {
					state.changeTrusted = state.changeTrusted && event.isTrusted;
					state.changeCount += 1;
					render();
				});
				input.addEventListener("keydown", (event) => {
					state.keyTrusted = state.keyTrusted && event.isTrusted;
					state.keyCount += 1;
					if (event.key === "Enter") {
						state.key = event.isTrusted;
						render();
					}
					if (event.key === "F4") {
						state.f4 = event.isTrusted;
						render();
					}
				});
				legacyGridCell.addEventListener("click", (event) => {
					legacyGridState.clickTrusted = event.isTrusted;
					renderLegacyGrid();
				});
				legacyGridCell.addEventListener("focus", (event) => {
					legacyGridState.focusTrusted = event.isTrusted;
					renderLegacyGrid();
				});
				legacyGridCell.addEventListener("keydown", (event) => {
					legacyGridState.keyTrusted = legacyGridState.keyTrusted && event.isTrusted;
					legacyGridState.keyCount += 1;
					legacyGridState.eventOrder.push("down:" + event.key);
					renderLegacyGrid();
				});
				legacyGridCell.addEventListener("keypress", (event) => {
					legacyGridState.pressTrusted =
						legacyGridState.pressTrusted && event.isTrusted;
					legacyGridState.pressCount += 1;
					legacyGridState.eventOrder.push("press:" + event.key);
					if (/^[A-Za-z0-9]$/.test(event.key)) {
						legacyGridState.buffer += event.key;
						legacyGridCell.textContent = legacyGridState.buffer;
						event.preventDefault();
					}
					if (event.key === "Enter") {
						legacyGridState.committed = event.isTrusted;
						legacyGridCell.textContent =
							legacyGridState.buffer === "U"
								? "U Stock Transfer"
								: legacyGridState.buffer;
						event.preventDefault();
					}
					renderLegacyGrid();
				});
				legacyGridCell.addEventListener("keyup", (event) => {
					legacyGridState.eventOrder.push("up:" + event.key);
					renderLegacyGrid();
				});
				scrollBox.addEventListener("wheel", (event) => {
					state.wheelTrusted = state.wheelTrusted && event.isTrusted;
					state.wheelCount += 1;
					render();
				});
				scrollBox.addEventListener("scroll", (event) => {
					state.scrollTrusted =
						state.scrollTrusted && event.isTrusted && scrollBox.scrollTop > 0;
					state.scrollCount += 1;
					render();
				});
				document.getElementById("navigate-frame").addEventListener("click", (event) => {
					if (event.isTrusted) location.href = "/reloaded";
				});
			</script>
		</body>
	</html>`;
}

async function run() {
	if (!argument) throw new Error("Missing CDP frame fixture input.");
	const inputPath = argument.slice(argumentPrefix.length);
	const input = JSON.parse(await fsPromises.readFile(inputPath, "utf8"));
	app.commandLine.appendSwitch("site-per-process");
	app.setPath("userData", input.userDataPath);
	await app.whenReady();

	const childServer = http.createServer((request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(childDocument(new URL(request.url, "http://fixture.local").pathname));
	});
	const childPort = await listen(childServer);
	const childOrigin = `http://localhost:${childPort}`;

	const mainServer = http.createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(`<!doctype html>
		<html>
			<head><title>Shell Frame</title></head>
			<body>
				<h1>Shell</h1>
				<button id="main-duplicate">Duplicate</button>
				<iframe id="business-frame" src="${childOrigin}/business" style="width:700px;height:360px"></iframe>
				<iframe id="stale-frame" src="${childOrigin}/stale" style="position:absolute;left:-99999px;top:-199903px;width:700px;height:360px"></iframe>
				<iframe id="blank-frame" src="about:blank" style="width:20px;height:20px"></iframe>
				<iframe id="transformed-frame" src="${childOrigin}/transformed" style="width:300px;height:80px;transform:rotate(1deg)"></iframe>
				<div id="late-host"></div>
				<script>
					window.addLateFrame = () => {
						if (document.getElementById("late-frame")) return;
						const frame = document.createElement("iframe");
						frame.id = "late-frame";
						frame.src = "${childOrigin}/late";
						frame.style.width = "700px";
						frame.style.height = "120px";
						document.getElementById("late-host").appendChild(frame);
					};
					window.coverLateFrame = () => {
						const frame = document.getElementById("late-frame");
						if (!frame || document.getElementById("fixture-frame-cover")) return;
						const rect = frame.getBoundingClientRect();
						const cover = document.createElement("div");
						cover.id = "fixture-frame-cover";
						Object.assign(cover.style, {
							position: "fixed",
							left: rect.left + "px",
							top: rect.top + "px",
							width: rect.width + "px",
							height: rect.height + "px",
							zIndex: "2147483647",
							background: "rgba(255, 0, 0, 0.25)",
						});
						document.body.appendChild(cover);
					};
					window.uncoverLateFrame = () => {
						document.getElementById("fixture-frame-cover")?.remove();
					};
				</script>
			</body>
		</html>`);
	});
	const mainPort = await listen(mainServer);

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
	await window.loadURL(
		`http://127.0.0.1:${mainPort}/shell?access_token=fixture-url-token#fixture-fragment`,
	);

	const { executeSapWebContentsAction } = require("./controller.ts");
	const { acquireCdpFrameBridge } = require("./cdpFrameBridge.ts");
	const fixtureLease = await acquireCdpFrameBridge(
		window.webContents,
		"cdp-frame-fixture-inspection",
	);
	const rootFrame = fixtureLease.bridge
		.getReadyFrames()
		.find((frame) => frame.isSessionRoot && frame.sessionId === undefined);
	if (!rootFrame) throw new Error("Fixture main frame was not registered.");
	let lateFrameError = "";
	setTimeout(() => {
		void fixtureLease.bridge
			.evaluateInFrame(rootFrame.frameId, "window.addLateFrame()", { returnByValue: true })
			.catch((error) => {
				lateFrameError = error instanceof Error ? error.message : String(error);
			});
	}, 250);
	const actions = [
		{ action: "state" },
		{
			action: "wait",
			selector: { by: "id", value: "late-target" },
			timeoutMs: 5_000,
		},
		{ action: "find", selector: { by: "id", value: "frame-click" } },
		{ action: "click", selector: { by: "id", value: "frame-click" } },
		{
			action: "type",
			selector: { by: "id", value: "frame-input" },
			text: "Typed Frame Value",
		},
		{
			action: "scroll",
			selector: { by: "id", value: "scroll-box" },
			deltaY: 120,
		},
		{ action: "state" },
		{
			action: "press",
			selector: { by: "id", value: "frame-input" },
			key: "F4",
		},
		{ action: "state" },
		{
			action: "press",
			selector: { by: "id", value: "frame-input" },
			key: "Enter",
		},
		{ action: "state" },
		{ action: "find", selector: { by: "exactText", value: "Duplicate" } },
		{ action: "find", selector: { by: "id", value: "transformed-target" } },
		{ action: "find", selector: { by: "id", value: "nested-click" } },
		{ action: "click", selector: { by: "id", value: "nested-click" } },
		{ action: "state" },
		{
			action: "type-legacy-grid-cell",
			selector: { by: "id", value: "frame-input" },
			text: "U",
		},
		{
			action: "type-legacy-grid-cell",
			selector: { by: "id", value: "legacy-grid-cell" },
			text: "U",
			commitWithEnter: true,
		},
		{ action: "state" },
		{ action: "click", selector: { by: "id", value: "navigate-frame" } },
		{
			action: "wait",
			selector: { by: "id", value: "after-navigation" },
			timeoutMs: 5_000,
		},
		{ action: "state" },
	];
	const results = [];
	for (const action of actions) {
		try {
			results.push({ ok: true, result: await executeSapWebContentsAction(window, action) });
		} catch (error) {
			results.push({
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	await fixtureLease.bridge.evaluateInFrame(rootFrame.frameId, "window.coverLateFrame()", {
		returnByValue: true,
	});
	let obscuredFrameError = "";
	try {
		await executeSapWebContentsAction(window, {
			action: "click",
			selector: { by: "id", value: "late-target" },
		});
	} catch (error) {
		obscuredFrameError = error instanceof Error ? error.message : String(error);
	} finally {
		await fixtureLease.bridge.evaluateInFrame(rootFrame.frameId, "window.uncoverLateFrame()", {
			returnByValue: true,
		});
	}

	if (lateFrameError) throw new Error(`Late frame injection failed: ${lateFrameError}`);
	const frames = fixtureLease.bridge.getFrames();
	window.webContents.debugger.detach();
	let detachError = "";
	try {
		fixtureLease.bridge.assertHealthy();
	} catch (error) {
		detachError = error instanceof Error ? error.message : String(error);
	}
	fixtureLease.release();
	await fsPromises.writeFile(
		input.outputPath,
		`${JSON.stringify(
			{
				results,
				frameCount: frames.length,
				oopifFrameCount: frames.filter((frame) => frame.sessionId).length,
				obscuredFrameError,
				detachError,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	window.destroy();
	await Promise.all([
		new Promise((resolve) => mainServer.close(resolve)),
		new Promise((resolve) => childServer.close(resolve)),
	]);
	app.quit();
}

run().catch(async (error) => {
	if (argument) {
		try {
			const input = JSON.parse(
				await fsPromises.readFile(argument.slice(argumentPrefix.length), "utf8"),
			);
			await fsPromises.writeFile(
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
