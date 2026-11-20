import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomicWebmWriter } from "./fileSink";

const temporaryDirectories: string[] = [];

async function makeOutputPath(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-sap-capture-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "capture.webm");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			fs.rm(directory, {
				recursive: true,
				force: true,
			}),
		),
	);
});

describe("AtomicWebmWriter", () => {
	it("writes ordered chunks to .part and atomically publishes the completed WebM", async () => {
		const outputPath = await makeOutputPath();
		const writer = await AtomicWebmWriter.create(outputPath);

		await expect(fs.stat(`${outputPath}.part`)).resolves.toBeDefined();
		await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });

		await writer.writeChunk(0, Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]));
		await writer.writeChunk(1, Uint8Array.from([0x42, 0x86, 0x81]));
		const result = await writer.complete();

		expect(result).toEqual({
			outputPath,
			partPath: `${outputPath}.part`,
			chunkCount: 2,
			bytesWritten: 7,
		});
		await expect(fs.readFile(outputPath)).resolves.toEqual(
			Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81]),
		);
		await expect(fs.stat(`${outputPath}.part`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects an out-of-order chunk and preserves the partial file", async () => {
		const outputPath = await makeOutputPath();
		const writer = await AtomicWebmWriter.create(outputPath);

		await expect(writer.writeChunk(1, Uint8Array.from([1]))).rejects.toThrow(
			"expected 0, received 1",
		);
		await writer.abort();

		await expect(fs.stat(`${outputPath}.part`)).resolves.toBeDefined();
		await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("requires a new absolute .webm output path", async () => {
		await expect(AtomicWebmWriter.create("capture.webm")).rejects.toThrow("must be absolute");

		const outputPath = await makeOutputPath();
		await fs.writeFile(outputPath, "existing");
		await expect(AtomicWebmWriter.create(outputPath)).rejects.toThrow("already exists");
		await expect(AtomicWebmWriter.create(`${outputPath}.mp4`)).rejects.toThrow(
			"must end in .webm",
		);
	});
});
