#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
	const options = { remove: [], require: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (!value.startsWith("--")) throw new Error(`Unexpected positional argument: ${value}`);
		const equalIndex = value.indexOf("=");
		const key = value.slice(2, equalIndex >= 0 ? equalIndex : undefined);
		let optionValue = equalIndex >= 0 ? value.slice(equalIndex + 1) : argv[index + 1];
		if (equalIndex < 0) {
			if (!optionValue || optionValue.startsWith("--")) throw new Error(`--${key} requires a value.`);
			index += 1;
		}
		if (key === "remove" || key === "require") options[key].push(optionValue);
		else options[key] = optionValue;
	}
	const allowed = new Set(["source", "output", "runtime-node-modules", "remove", "require"]);
	const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
	if (unexpected.length > 0) {
		throw new Error(`Unsupported option(s): ${unexpected.map((key) => `--${key}`).join(", ")}`);
	}
	return options;
}

function requiredPath(value, label) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
	return path.resolve(value.trim());
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function safeTemporaryDirectory(temporaryRoot, temporaryDirectory) {
	const root = path.resolve(temporaryRoot);
	const directory = path.resolve(temporaryDirectory);
	const relative = path.relative(root, directory);
	return (
		Boolean(relative) &&
		!relative.startsWith("..") &&
		!path.isAbsolute(relative) &&
		path.basename(directory).startsWith("recordly-cover-")
	);
}

function renderFirstSlideWithPowerPoint(candidatePath, outputPath) {
	const command = String.raw`
$ErrorActionPreference = 'Stop'
$candidate = $env:RECORDLY_COVER_CANDIDATE
$output = $env:RECORDLY_COVER_OUTPUT
$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Open($candidate, $true, $true, $false)
  $presentation.Slides.Item(1).Export($output, 'PNG', 1920, 1080)
  Write-Output $powerPoint.Version
} finally {
  if ($null -ne $presentation) { $presentation.Close() }
  if ($null -ne $powerPoint) { $powerPoint.Quit() }
}
`;
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(command, "utf16le").toString("base64"),
		],
		{
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 8 * 1024 * 1024,
			env: {
				...process.env,
				RECORDLY_COVER_CANDIDATE: candidatePath,
				RECORDLY_COVER_OUTPUT: outputPath,
			},
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`PowerPoint slide export failed with exit code ${result.status}: ${[result.stderr, result.stdout]
				.filter(Boolean)
				.join("\n")
				.trim()}`,
		);
	}
	return result.stdout.trim();
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const sourcePath = requiredPath(options.source, "--source");
	const outputPath = requiredPath(options.output, "--output");
	if (!existsSync(sourcePath)) throw new Error(`Source PPTX does not exist: ${sourcePath}`);
	if (path.extname(sourcePath).toLowerCase() !== ".pptx") {
		throw new Error(`Cover source must be a PPTX: ${sourcePath}`);
	}
	if (path.extname(outputPath).toLowerCase() !== ".png") {
		throw new Error(`Cover output must be a PNG: ${outputPath}`);
	}
	if (existsSync(outputPath)) {
		throw new Error(`Cover output already exists; choose a new path: ${outputPath}`);
	}
	const runtimeNodeModules = requiredPath(
		options["runtime-node-modules"] || process.env.CODEX_WORKSPACE_NODE_MODULES,
		"--runtime-node-modules or CODEX_WORKSPACE_NODE_MODULES",
	);
	const artifactToolPath = path.join(
		runtimeNodeModules,
		"@oai",
		"artifact-tool",
		"dist",
		"artifact_tool.mjs",
	);
	if (!existsSync(artifactToolPath)) {
		throw new Error(`@oai/artifact-tool is unavailable under: ${runtimeNodeModules}`);
	}
	const { FileBlob, PresentationFile } = await import(pathToFileURL(artifactToolPath).href);
	const temporaryRoot = path.resolve(os.tmpdir());
	const temporaryDirectory = path.resolve(
		await mkdtemp(path.join(temporaryRoot, "recordly-cover-")),
	);
	if (!safeTemporaryDirectory(temporaryRoot, temporaryDirectory)) {
		throw new Error(`Refusing to use an unsafe temporary cover directory: ${temporaryDirectory}`);
	}
	try {
		const presentation = await PresentationFile.importPptx(await FileBlob.load(sourcePath));
		const snapshot = await presentation.inspect({
			kind: "slide,textbox,shape,image,layout",
			include: "id,slideIndex,name,position,text,textPreview",
			exclude: "comments",
			maxChars: 50_000,
		});
		const records = snapshot.ndjson
			.split(/\r?\n/u)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		for (const text of options.remove) {
			const matches = records.filter(
				(item) =>
					item.slideIndex === 0 &&
					(item.kind === "textbox" || item.kind === "shape") &&
					typeof (item.text ?? item.textPreview) === "string" &&
					(item.text ?? item.textPreview).includes(text),
			);
			if (matches.length !== 1) {
				throw new Error(`Expected one first-slide object containing ${JSON.stringify(text)}, found ${matches.length}.`);
			}
			presentation.resolve(matches[0].id).text.replace(text, "\u00a0");
		}
		const after = await presentation.inspect({
			kind: "slide,textbox,shape,image",
			include: "id,slideIndex,name,position,text,textPreview",
			exclude: "comments",
			maxChars: 50_000,
		});
		const afterRecords = after.ndjson
			.split(/\r?\n/u)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		for (const text of options.remove) {
			const remains = afterRecords.some(
				(item) =>
					item.slideIndex === 0 &&
					typeof (item.text ?? item.textPreview) === "string" &&
					(item.text ?? item.textPreview).includes(text),
			);
			if (remains) throw new Error(`Removed cover text is still present: ${text}`);
		}
		for (const text of options.require) {
			const present = afterRecords.some(
				(item) =>
					item.slideIndex === 0 &&
					typeof (item.text ?? item.textPreview) === "string" &&
					(item.text ?? item.textPreview).includes(text),
			);
			if (!present) throw new Error(`Required cover text is missing: ${text}`);
		}
		const candidatePath = path.join(temporaryDirectory, "cover-candidate.pptx");
		await (await PresentationFile.exportPptx(presentation)).save(candidatePath);
		await mkdir(path.dirname(outputPath), { recursive: true });
		const powerPointVersion = renderFirstSlideWithPowerPoint(candidatePath, outputPath);
		const output = await readFile(outputPath);
		if (output.length < 24 || output.toString("ascii", 1, 4) !== "PNG") {
			throw new Error(`PowerPoint did not create a valid PNG: ${outputPath}`);
		}
		const width = output.readUInt32BE(16);
		const height = output.readUInt32BE(20);
		if (width !== 1920 || height !== 1080) {
			throw new Error(`Cover PNG must be 1920x1080, received ${width}x${height}.`);
		}
		console.log(
			JSON.stringify(
				{
					status: "completed",
					source: sourcePath,
					output: outputPath,
					sha256: sha256(output),
					width,
					height,
					removedText: options.remove,
					requiredText: options.require,
					powerPointVersion,
				},
				null,
				2,
			),
		);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exitCode = 1;
});
