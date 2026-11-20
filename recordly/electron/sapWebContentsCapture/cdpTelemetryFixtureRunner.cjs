"use strict";

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const http = require("node:http");
const ts = require("typescript");
const { app, BrowserWindow } = require("electron");

const argumentPrefix = "--cdp-telemetry-fixture=";
const argument = process.argv.find((value) => value.startsWith(argumentPrefix));
const worldName = "recordly.sap.telemetry.v1";
const bindingName = "__recordlySapTelemetryV1";
const collectorStateKey = "__recordlySapTelemetryCollectorV1";

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

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

function wait(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTrustedFrame(frame) {
	try {
		const parsed = new URL(frame.url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function childDocument(pathname) {
	const generation = pathname === "/after-stop" ? "post-stop" : "captured";
	return `<!doctype html>
	<html>
		<head>
			<meta charset="utf-8" />
			<title>OOPIF ${generation}</title>
			<style>
				body { margin: 24px; font: 16px sans-serif; }
				button, input { display: block; margin: 12px 0; width: 260px; height: 36px; }
			</style>
		</head>
		<body>
			<h2>OOPIF ${generation}</h2>
			<button id="frame-click">OOPIF Action</button>
			<label for="frame-input">OOPIF Value</label>
			<input id="frame-input" autocomplete="off" />
			<label for="frame-password">OOPIF Password</label>
			<input id="frame-password" name="business-secret" type="password" autocomplete="current-password" />
			<p id="frame-result">click:false input:false key:false passwordKey:false</p>
			<script>
				const state = { click: false, input: false, key: false, passwordKey: false };
				const render = () => {
					document.getElementById("frame-result").textContent =
						"click:" + state.click + " input:" + state.input +
						" key:" + state.key + " passwordKey:" + state.passwordKey;
				};
				document.getElementById("frame-click").addEventListener("click", (event) => {
					state.click = event.isTrusted;
					render();
				});
				document.getElementById("frame-input").addEventListener("input", (event) => {
					state.input = event.isTrusted;
					render();
				});
				document.getElementById("frame-input").addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						state.key = event.isTrusted;
						render();
					}
				});
				document.getElementById("frame-password").addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						state.passwordKey = event.isTrusted;
						render();
					}
				});
			</script>
		</body>
	</html>`;
}

async function waitForFrame(bridge, predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		await bridge.waitForFramesReady(1_000);
		const frame = bridge.getFrames().find(predicate);
		if (frame) return frame;
		await wait(25);
	}
	throw new Error("Timed out waiting for the expected fixture frame.");
}

async function isolatedWorldTypes(bridge, frame) {
	const world = await bridge.send(
		"Page.createIsolatedWorld",
		{
			frameId: frame.frameId,
			worldName,
			grantUniveralAccess: false,
		},
		frame.sessionId,
	);
	if (!Number.isInteger(world.executionContextId)) {
		throw new Error(`No isolated context was created for frame ${frame.frameId}.`);
	}
	const response = await bridge.send(
		"Runtime.evaluate",
		{
			expression: `({ collectorType: typeof globalThis[${JSON.stringify(
				collectorStateKey,
			)}], bindingType: typeof globalThis[${JSON.stringify(bindingName)}] })`,
			contextId: world.executionContextId,
			returnByValue: true,
			awaitPromise: true,
		},
		frame.sessionId,
	);
	return {
		contextId: world.executionContextId,
		collectorType: response.result?.value?.collectorType,
		bindingType: response.result?.value?.bindingType,
	};
}

async function run() {
	if (!argument) throw new Error("Missing CDP telemetry fixture input.");
	const inputPath = argument.slice(argumentPrefix.length);
	const input = JSON.parse(await fsPromises.readFile(inputPath, "utf8"));
	app.commandLine.appendSwitch("site-per-process");
	app.setPath("userData", input.userDataPath);
	await app.whenReady();

	let mainServer;
	let childServer;
	let window;
	try {
		childServer = http.createServer((request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(childDocument(new URL(request.url, "http://fixture.local").pathname));
		});
		const childPort = await listen(childServer);
		const childOrigin = `http://localhost:${childPort}`;

		mainServer = http.createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(`<!doctype html>
			<html>
				<head>
					<meta charset="utf-8" />
					<title>Main telemetry document</title>
					<style>
						body { margin: 20px; font: 16px sans-serif; }
						button, input { display: block; margin: 8px 0; width: 220px; height: 32px; }
						#bootstrap-frame { width: 1px; height: 1px; border: 0; }
						#business-frame { display: block; margin: 28px 0 0 260px; width: 620px; height: 380px; border: 2px solid #345; }
					</style>
				</head>
				<body>
					<button id="main-click">Main Action</button>
					<label for="main-input">Main Value</label>
					<input id="main-input" autocomplete="off" />
					<label for="main-password">Main Password</label>
					<input id="main-password" name="fixture-token" type="password" autocomplete="current-password" />
					<p id="main-result">click:false input:false key:false passwordKey:false</p>
					<iframe id="bootstrap-frame" src="about:blank"></iframe>
					<iframe id="business-frame" src="${childOrigin}/business"></iframe>
					<script>
						const state = { click: false, input: false, key: false, passwordKey: false };
						const render = () => {
							document.getElementById("main-result").textContent =
								"click:" + state.click + " input:" + state.input +
								" key:" + state.key + " passwordKey:" + state.passwordKey;
						};
						document.getElementById("main-click").addEventListener("click", (event) => {
							state.click = event.isTrusted;
							render();
						});
						document.getElementById("main-input").addEventListener("input", (event) => {
							state.input = event.isTrusted;
							render();
						});
						document.getElementById("main-input").addEventListener("keydown", (event) => {
							if (event.key === "Enter") {
								state.key = event.isTrusted;
								render();
							}
						});
						document.getElementById("main-password").addEventListener("keydown", (event) => {
							if (event.key === "Enter") {
								state.passwordKey = event.isTrusted;
								render();
							}
						});
					</script>
				</body>
			</html>`);
		});
		const mainPort = await listen(mainServer);
		const mainOrigin = `http://127.0.0.1:${mainPort}`;

		window = new BrowserWindow({
			show: false,
			width: 1_100,
			height: 900,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				backgroundThrottling: false,
			},
		});
		await window.loadURL(`${mainOrigin}/shell`);

		const { executeSapWebContentsAction } = require("../sapWebContentsControl/controller.ts");
		const { acquireCdpFrameBridge } = require("../sapWebContentsControl/cdpFrameBridge.ts");
		const { CdpTelemetryRuntime } = require("./cdpTelemetryRuntime.ts");
		const { createMonotonicSessionClock, RawActionTimeline } = require("./timeline.ts");

		const discoveryLease = await acquireCdpFrameBridge(
			window.webContents,
			"cdp-telemetry-fixture-discovery",
		);
		await discoveryLease.bridge.waitForFramesReady(5_000);
		const discoveredFrames = discoveryLease.bridge.getFrames();
		const frameCount = discoveredFrames.length;
		const oopifFrameCount = discoveredFrames.filter((frame) => frame.sessionId).length;
		const bootstrapFrameCount = discoveredFrames.filter(
			(frame) => frame.url === "about:blank" || frame.url === "",
		).length;
		discoveryLease.release();

		const iframeRect = await window.webContents.executeJavaScript(
			`(() => {
				const rect = document.getElementById("business-frame").getBoundingClientRect();
				return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
			})()`,
			true,
		);
		const clock = createMonotonicSessionClock();
		const timeline = new RawActionTimeline(
			"cdp-telemetry-fixture-session",
			window.webContents.id,
			clock,
		);
		const batches = [];
		const fatalErrors = [];
		const runtime = new CdpTelemetryRuntime({
			webContents: window.webContents,
			sessionId: timeline.sessionId,
			clock,
			onBatch: (payload) => {
				batches.push(payload);
				timeline.addBrowserBatch(payload);
			},
			onFatal: (error) => fatalErrors.push(error.message),
		});
		await runtime.start();

		const actions = [
			{ action: "click", selector: { by: "id", value: "main-click" } },
			{
				action: "type",
				selector: { by: "id", value: "main-input" },
				text: "Main fixture value",
			},
			{
				action: "press",
				selector: { by: "id", value: "main-input" },
				key: "Enter",
			},
			{
				action: "type",
				selector: { by: "id", value: "main-password" },
				secretFilePath: input.mainSecretPath,
			},
			{
				action: "press",
				selector: { by: "id", value: "main-password" },
				key: "Enter",
			},
			{ action: "click", selector: { by: "id", value: "frame-click" } },
			{
				action: "type",
				selector: { by: "id", value: "frame-input" },
				text: "OOPIF fixture value",
			},
			{
				action: "press",
				selector: { by: "id", value: "frame-input" },
				key: "Enter",
			},
			{
				action: "type",
				selector: { by: "id", value: "frame-password" },
				secretFilePath: input.childSecretPath,
			},
			{
				action: "press",
				selector: { by: "id", value: "frame-password" },
				key: "Enter",
			},
		];
		for (const action of actions) await executeSapWebContentsAction(window, action);
		const trustedState = await executeSapWebContentsAction(window, { action: "state" });
		const trustedResults = {
			main:
				trustedState.frames?.find((frame) => frame.url?.startsWith(mainOrigin))
					?.visibleResult ?? "",
			child:
				trustedState.frames?.find((frame) => frame.url?.startsWith(childOrigin))
					?.visibleResult ?? "",
		};
		await wait(150);

		const eventCountBeforeStop = timeline.snapshot().length;
		await runtime.stop();
		const eventCountAfterStop = timeline.snapshot().length;

		const cleanupLease = await acquireCdpFrameBridge(
			window.webContents,
			"cdp-telemetry-fixture-cleanup",
		);
		const bindingCallsAfterStop = [];
		const unsubscribe = cleanupLease.bridge.subscribe((event) => {
			if (event.method === "Runtime.bindingCalled" && event.params.name === bindingName) {
				bindingCallsAfterStop.push({ sessionId: event.sessionId });
			}
		});
		await cleanupLease.bridge.waitForFramesReady(5_000);
		const cleanupChecks = [];
		for (const frame of cleanupLease.bridge.getFrames().filter(isTrustedFrame)) {
			const types = await isolatedWorldTypes(cleanupLease.bridge, frame);
			let bindingCallHadException;
			if (types.bindingType === "function") {
				const probe = await cleanupLease.bridge.send(
					"Runtime.evaluate",
					{
						expression: `globalThis[${JSON.stringify(bindingName)}]("cleanup-probe")`,
						contextId: types.contextId,
						returnByValue: true,
						awaitPromise: true,
					},
					frame.sessionId,
				);
				bindingCallHadException = Boolean(probe.exceptionDetails);
			}
			cleanupChecks.push({
				frameId: frame.frameId,
				sessionId: frame.sessionId,
				origin: frame.origin,
				isMainFrame: !frame.parentFrameId,
				collectorType: types.collectorType,
				bindingType: types.bindingType,
				bindingCallHadException,
			});
		}
		await wait(100);

		await window.webContents.executeJavaScript(
			`document.getElementById("business-frame").src = ${JSON.stringify(
				`${childOrigin}/after-stop`,
			)};`,
			true,
		);
		const postNavigationFrame = await waitForFrame(
			cleanupLease.bridge,
			(frame) => frame.url === `${childOrigin}/after-stop`,
			5_000,
		);
		const postNavigationTypes = await isolatedWorldTypes(
			cleanupLease.bridge,
			postNavigationFrame,
		);
		const postNavigationCheck = {
			frameId: postNavigationFrame.frameId,
			sessionId: postNavigationFrame.sessionId,
			url: postNavigationFrame.url,
			origin: postNavigationFrame.origin,
			collectorType: postNavigationTypes.collectorType,
			bindingType: postNavigationTypes.bindingType,
		};

		const postStopActions = [
			{ action: "click", selector: { by: "id", value: "main-click" } },
			{
				action: "type",
				selector: { by: "id", value: "main-input" },
				text: "Main after stop",
			},
			{
				action: "press",
				selector: { by: "id", value: "main-input" },
				key: "Enter",
			},
			{ action: "click", selector: { by: "id", value: "frame-click" } },
			{
				action: "type",
				selector: { by: "id", value: "frame-input" },
				text: "OOPIF after stop",
			},
			{
				action: "press",
				selector: { by: "id", value: "frame-input" },
				key: "Enter",
			},
		];
		for (const action of postStopActions) {
			await executeSapWebContentsAction(window, action);
		}
		await wait(150);
		const eventCountAfterPostStopActions = timeline.snapshot().length;
		unsubscribe();
		cleanupLease.release();

		await fsPromises.writeFile(
			input.outputPath,
			`${JSON.stringify(
				{
					frameCount,
					oopifFrameCount,
					bootstrapFrameCount,
					origins: { main: mainOrigin, child: childOrigin },
					iframeRect,
					trustedResults,
					batches,
					document: timeline.toDocument(),
					fatalErrors,
					eventCountBeforeStop,
					eventCountAfterStop,
					eventCountAfterPostStopActions,
					cleanupChecks,
					postNavigationCheck,
					bindingCallsAfterStop: bindingCallsAfterStop.length,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
	} finally {
		if (window && !window.isDestroyed()) window.destroy();
		await Promise.all([
			mainServer ? close(mainServer) : Promise.resolve(),
			childServer ? close(childServer) : Promise.resolve(),
		]);
		app.quit();
	}
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
			// The parent process reports the Electron exit and any missing fixture output.
		}
	}
	app.exit(1);
});
