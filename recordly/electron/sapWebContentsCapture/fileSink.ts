import fs from "node:fs/promises";
import path from "node:path";

export interface CompletedWebmFile {
	outputPath: string;
	partPath: string;
	chunkCount: number;
	bytesWritten: number;
}

function assertWebmOutputPath(outputPath: string): void {
	if (!path.isAbsolute(outputPath)) {
		throw new Error("SAP WebContents capture output path must be absolute.");
	}
	if (path.extname(outputPath).toLowerCase() !== ".webm") {
		throw new Error("SAP WebContents capture output path must end in .webm.");
	}
}

async function assertPathDoesNotExist(filePath: string, label: string): Promise<void> {
	try {
		await fs.access(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}

	throw new Error(`${label} already exists: ${filePath}`);
}

export class AtomicWebmWriter {
	readonly outputPath: string;
	readonly partPath: string;

	private handle: fs.FileHandle | null;
	private nextSequence = 0;
	private byteCount = 0;
	private state: "writing" | "completed" | "aborted" = "writing";

	private constructor(outputPath: string, handle: fs.FileHandle) {
		this.outputPath = outputPath;
		this.partPath = `${outputPath}.part`;
		this.handle = handle;
	}

	static async create(outputPath: string): Promise<AtomicWebmWriter> {
		assertWebmOutputPath(outputPath);
		const normalizedOutputPath = path.resolve(outputPath);
		const partPath = `${normalizedOutputPath}.part`;

		await fs.mkdir(path.dirname(normalizedOutputPath), { recursive: true });
		await assertPathDoesNotExist(normalizedOutputPath, "Capture output");

		let handle: fs.FileHandle;
		try {
			handle = await fs.open(partPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error(`Capture partial file already exists: ${partPath}`);
			}
			throw error;
		}

		return new AtomicWebmWriter(normalizedOutputPath, handle);
	}

	get chunkCount(): number {
		return this.nextSequence;
	}

	get bytesWritten(): number {
		return this.byteCount;
	}

	async writeChunk(sequence: number, data: Uint8Array): Promise<void> {
		if (this.state !== "writing" || !this.handle) {
			throw new Error("Capture output is not writable.");
		}
		if (!Number.isSafeInteger(sequence) || sequence !== this.nextSequence) {
			throw new Error(
				`Capture chunk sequence mismatch: expected ${this.nextSequence}, received ${sequence}.`,
			);
		}
		if (data.byteLength === 0) {
			throw new Error("Capture chunks must not be empty.");
		}

		const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesWritten } = await this.handle.write(
				buffer,
				offset,
				buffer.byteLength - offset,
			);
			if (bytesWritten <= 0) {
				throw new Error("Capture chunk write made no progress.");
			}
			offset += bytesWritten;
		}

		this.nextSequence += 1;
		this.byteCount += buffer.byteLength;
	}

	async complete(): Promise<CompletedWebmFile> {
		if (this.state !== "writing" || !this.handle) {
			throw new Error("Capture output cannot be completed from its current state.");
		}
		if (this.nextSequence === 0 || this.byteCount === 0) {
			throw new Error("Capture output has no media chunks.");
		}

		const handle = this.handle;
		this.handle = null;
		try {
			await handle.sync();
			await handle.close();
			await fs.rename(this.partPath, this.outputPath);
			this.state = "completed";
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error;
		}

		return {
			outputPath: this.outputPath,
			partPath: this.partPath,
			chunkCount: this.nextSequence,
			bytesWritten: this.byteCount,
		};
	}

	async abort(): Promise<void> {
		if (this.state !== "writing") {
			return;
		}

		this.state = "aborted";
		const handle = this.handle;
		this.handle = null;
		if (handle) {
			await handle.close().catch(() => undefined);
		}
	}
}
