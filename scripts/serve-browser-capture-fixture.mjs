#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.RECORDLY_FIXTURE_PORT ?? "4175", 10);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(scriptDir, "..", "fixtures", "browser-capture");
const indexPath = path.join(fixtureRoot, "index.html");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new Error("RECORDLY_FIXTURE_PORT must be a valid TCP port");
}

const server = createServer(async (request, response) => {
	const requestUrl = new URL(request.url ?? "/", `http://${host}:${port}`);
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { Allow: "GET, HEAD" });
		response.end();
		return;
	}
	if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
		response.writeHead(404);
		response.end("Not found");
		return;
	}

	const fileStat = await stat(indexPath);
	response.writeHead(200, {
		"Cache-Control": "no-store",
		"Content-Length": fileStat.size,
		"Content-Type": "text/html; charset=utf-8",
	});
	if (request.method === "HEAD") {
		response.end();
		return;
	}
	createReadStream(indexPath).pipe(response);
});

server.listen(port, host, () => {
	process.stdout.write(`Recordly fixture: http://${host}:${port}/\n`);
});
