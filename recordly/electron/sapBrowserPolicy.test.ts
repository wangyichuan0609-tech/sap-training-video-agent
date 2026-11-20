import { describe, expect, it } from "vitest";
import {
	getSapBrowserUrlArgument,
	isAllowedSapBrowserNavigation,
	normalizeSapBrowserUrl,
} from "./sapBrowserPolicy";

const sapUrl =
	"https://sap-qas.example.invalid:44381/sap/bc/ui2/flp?saml2=disabled&sap-client=460#Shell-home";

describe("Recordly SAP Browser URL policy", () => {
	it("accepts and preserves an exact HTTPS SAP URL", () => {
		expect(normalizeSapBrowserUrl(sapUrl)).toBe(sapUrl);
		expect(getSapBrowserUrlArgument(["electron.exe", `--recordly-sap-url=${sapUrl}`])).toBe(
			sapUrl,
		);
	});

	it.each([
		"http://sap.example.test/",
		"https://user:password@sap.example.test/",
		"file:///C:/sap.html",
		"not-a-url",
	])("rejects an unsafe SAP Browser URL: %s", (value) => {
		expect(() => normalizeSapBrowserUrl(value)).toThrow();
	});

	it("returns null when the launch argument is absent", () => {
		expect(getSapBrowserUrlArgument(["electron.exe", "."])).toBeNull();
	});

	it("allows only same-origin HTTPS navigation inside the SAP Browser", () => {
		const expectedOrigin = "https://sap-qas.example.invalid:44381";
		expect(
			isAllowedSapBrowserNavigation(
				"https://sap-qas.example.invalid:44381/sap/bc/ui2/flp#Shell-home",
				expectedOrigin,
			),
		).toBe(true);
		expect(
			isAllowedSapBrowserNavigation(
				"https://sap-qas.example.invalid/sap/bc/ui2/flp",
				expectedOrigin,
			),
		).toBe(false);
		expect(isAllowedSapBrowserNavigation("https://example.com/", expectedOrigin)).toBe(false);
	});
});
