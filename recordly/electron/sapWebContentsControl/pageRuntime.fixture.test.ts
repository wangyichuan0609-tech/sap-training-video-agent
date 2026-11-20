import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSapPageActionScript, type SapPageAction } from "./pageRuntime";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const electronPath = path.resolve(
	currentDirectory,
	"../../node_modules/electron/dist/electron.exe",
);
const runnerPath = path.join(currentDirectory, "fixtureRunner.cjs");
const fixturePath = path.resolve(
	currentDirectory,
	"../../fixtures/sap-web-contents-control/index.html",
);

let temporaryDirectory = "";
let results: Array<{ ok: boolean; result?: unknown; error?: string }> = [];

beforeAll(async () => {
	temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-sap-page-fixture-"));
	const inputPath = path.join(temporaryDirectory, "input.json");
	const outputPath = path.join(temporaryDirectory, "output.json");
	const actions: SapPageAction[] = [
		{ kind: "state" },
		{ kind: "find", selector: { by: "exactText", value: "Duplicate" } },
		{ kind: "click", selector: { by: "id", value: "hidden-target" } },
		{ kind: "click", selector: { by: "id", value: "disabled-target" } },
		{ kind: "state" },
		{
			kind: "login",
			user: "fixture-login-user",
			password: "fixture-login-password",
		},
		{
			kind: "change-password",
			user: "fixture-login-user",
			currentPassword: "fixture-login-password",
			newPassword: "fixture-new-password",
		},
		{ kind: "click", selector: { by: "id", value: "prepare-count-ambiguity" } },
		{
			kind: "change-password",
			user: "fixture-login-user",
			currentPassword: "fixture-login-password",
			newPassword: "fixture-new-password",
		},
		{ kind: "click", selector: { by: "id", value: "prepare-button-ambiguity" } },
		{
			kind: "change-password",
			user: "fixture-login-user",
			currentPassword: "fixture-login-password",
			newPassword: "fixture-new-password",
		},
		{ kind: "state" },
	];
	await fs.writeFile(
		inputPath,
		JSON.stringify({
			fixturePath,
			outputPath,
			userDataPath: path.join(temporaryDirectory, "user-data"),
			scripts: actions.map(buildSapPageActionScript),
		}),
		"utf8",
	);

	const environment = { ...process.env };
	delete environment.ELECTRON_RUN_AS_NODE;
	const completed = spawnSync(electronPath, [runnerPath, `--fixture-control=${inputPath}`], {
		cwd: currentDirectory,
		env: environment,
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
	if (completed.status !== 0) {
		throw new Error(
			`Fixture Electron failed (${completed.status}): ${completed.stderr || completed.stdout}`,
		);
	}
	results = JSON.parse(await fs.readFile(outputPath, "utf8"));
}, 40_000);

afterAll(async () => {
	if (temporaryDirectory) {
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
	}
});

describe("SAP page action fixture", () => {
	it("marks a visible sign-in form as unready for capture", () => {
		expect(results[0]).toMatchObject({ ok: true, result: { captureReady: false, sapClient: "460" } });
	});

	it("never returns input values or login secrets", () => {
		const serialized = JSON.stringify(results);
		expect(serialized).not.toContain("fixture-user-value");
		expect(serialized).not.toContain("fixture-password-value");
		expect(serialized).not.toContain("fixture-login-user");
		expect(serialized).not.toContain("fixture-login-password");
		expect(serialized).not.toContain("fixture-new-password");
		expect(results[5]).toMatchObject({ ok: true, result: { redacted: true } });
		expect(results[6]).toMatchObject({
			ok: true,
			result: {
				redacted: true,
				visibleResult: expect.stringContaining("Password Changed; successful clicks: 1"),
			},
		});
	});

	it("fails closed on sensitive-input count and Change Password control ambiguity", () => {
		expect(results[8]).toMatchObject({ ok: false });
		expect(results[8]?.error).toContain("4 visible sensitive inputs");
		expect(results[10]).toMatchObject({ ok: false });
		expect(results[10]?.error).toContain("2 visible Change Password controls");
		expect(results[11]).toMatchObject({
			ok: true,
			result: {
				visibleResult: expect.stringContaining(
					"Prepared button ambiguity; successful clicks: 1",
				),
			},
		});
	});

	it("rejects ambiguous, hidden, and disabled targets", () => {
		expect(results[1]).toMatchObject({ ok: false });
		expect(results[1]?.error).toContain("matched 2 elements");
		expect(results[2]?.error).toContain("Target is hidden");
		expect(results[3]?.error).toContain("Target is disabled");
	});

	it("returns fixed target metadata from the fictitious login", () => {
		expect(results[5]).toMatchObject({
			ok: true,
			result: {
				targetName: "Log On",
				controlType: "button",
				visibleResult: expect.stringContaining("Submitted"),
			},
		});
	});
});
