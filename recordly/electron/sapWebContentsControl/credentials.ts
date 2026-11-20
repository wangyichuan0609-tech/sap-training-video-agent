import fs from "node:fs/promises";
import path from "node:path";

const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MAX_SECRET_FILE_BYTES = 16 * 1024;

export interface SapLoginCredentials {
	url: URL;
	client: string;
	user: string;
	password: string;
}

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function parseKeyValueText(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const entry = /^([^:=]+?)\s*[=:]\s*(.*)$/.exec(line);
		if (!entry) {
			throw new Error("Credential file contains an invalid line.");
		}
		const key = entry[1].trim().toLowerCase();
		if (!new Set(["url", "client", "user", "password"]).has(key)) {
			throw new Error("Credential file contains an unsupported key.");
		}
		// biome-ignore lint/suspicious/noPrototypeBuiltins: ES2020 does not include Object.hasOwn.
		if (Object.prototype.hasOwnProperty.call(values, key)) {
			throw new Error("Credential file contains a duplicate key.");
		}
		values[key] = unquote(entry[2].trim());
	}
	return values;
}

function parseJsonText(text: string): Record<string, string> {
	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Credential JSON must be an object.");
	}
	const values: Record<string, string> = {};
	for (const [rawKey, rawValue] of Object.entries(parsed)) {
		const key = rawKey.toLowerCase();
		if (!new Set(["url", "client", "user", "password"]).has(key)) {
			throw new Error("Credential JSON contains an unsupported key.");
		}
		if (typeof rawValue !== "string") {
			throw new Error("Credential JSON values must be strings.");
		}
		// biome-ignore lint/suspicious/noPrototypeBuiltins: ES2020 does not include Object.hasOwn.
		if (Object.prototype.hasOwnProperty.call(values, key)) {
			throw new Error("Credential JSON contains a duplicate key.");
		}
		values[key] = rawValue;
	}
	return values;
}

export function parseSapLoginCredentials(text: string): SapLoginCredentials {
	const trimmed = text.trim();
	const values = trimmed.startsWith("{") ? parseJsonText(trimmed) : parseKeyValueText(text);
	for (const key of ["url", "client", "user", "password"] as const) {
		if (!values[key]) throw new Error(`Credential file is missing ${key}.`);
	}

	let url: URL;
	try {
		url = new URL(values.url);
	} catch {
		throw new Error("Credential URL is invalid.");
	}
	if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
		throw new Error("Credential URL must be HTTPS without embedded credentials.");
	}
	if (!/^\d{3}$/.test(values.client)) {
		throw new Error("Credential Client must contain exactly three digits.");
	}
	const urlClient = url.searchParams.get("sap-client");
	if (urlClient && urlClient !== values.client) {
		throw new Error("Credential URL sap-client does not match Client.");
	}

	return {
		url,
		client: values.client,
		user: values.user,
		password: values.password,
	};
}

async function readSmallFile(
	filePath: string,
	maximumBytes: number,
	label: string,
): Promise<string> {
	if (!path.isAbsolute(filePath)) {
		throw new Error(`${label} path must be absolute.`);
	}
	const stats = await fs.stat(filePath);
	if (!stats.isFile() || stats.size <= 0 || stats.size > maximumBytes) {
		throw new Error(`${label} must be a non-empty regular file within the size limit.`);
	}
	return fs.readFile(filePath, "utf8");
}

export async function readSapLoginCredentials(filePath: string): Promise<SapLoginCredentials> {
	return parseSapLoginCredentials(
		await readSmallFile(filePath, MAX_CREDENTIAL_FILE_BYTES, "Credential file"),
	);
}

export async function readSecretText(filePath: string): Promise<string> {
	const value = (await readSmallFile(filePath, MAX_SECRET_FILE_BYTES, "Secret file")).replace(
		/[\r\n]+$/,
		"",
	);
	if (!value) throw new Error("Secret file is empty.");
	return value;
}
