"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const START_CHANNEL = "recordly:sap-web-contents-capture:renderer-start";
const STOP_CHANNEL = "recordly:sap-web-contents-capture:renderer-stop";
const STARTED_CHANNEL = "recordly:sap-web-contents-capture:renderer-started";
const CHUNK_CHANNEL = "recordly:sap-web-contents-capture:renderer-chunk";
const STOPPED_CHANNEL = "recordly:sap-web-contents-capture:renderer-stopped";
const FAILED_CHANNEL = "recordly:sap-web-contents-capture:renderer-failed";

function addListener(channel, callback) {
	if (typeof callback !== "function") {
		throw new TypeError("Capture listener must be a function.");
	}

	const listener = (_event, payload) => callback(payload);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
	"recordlySapCapture",
	Object.freeze({
		onStart: (callback) => addListener(START_CHANNEL, callback),
		onStop: (callback) => addListener(STOP_CHANNEL, callback),
		didStart: (sessionId, mimeType) =>
			ipcRenderer.invoke(STARTED_CHANNEL, { sessionId, mimeType }),
		writeChunk: (sessionId, sequence, data) =>
			ipcRenderer.invoke(CHUNK_CHANNEL, { sessionId, sequence, data }),
		didStop: (sessionId) => ipcRenderer.invoke(STOPPED_CHANNEL, { sessionId }),
		didFail: (sessionId, reason) =>
			ipcRenderer.invoke(FAILED_CHANNEL, {
				sessionId,
				reason: typeof reason === "string" ? reason.slice(0, 2000) : "Capture failed.",
			}),
	}),
);
