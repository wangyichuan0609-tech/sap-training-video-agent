import { describe, expect, it } from "vitest";
import { legacyGridCellDisplayMatches } from "./legacyGridCell";

describe("legacy SAP grid cell display matching", () => {
	it("accepts an exact code or a complete token-boundary display prefix", () => {
		expect(legacyGridCellDisplayMatches("U", "U")).toBe(true);
		expect(legacyGridCellDisplayMatches("U Stock Transfer", "U")).toBe(true);
		expect(legacyGridCellDisplayMatches("ZMU1 - Stock Transp. Order", "ZMU1")).toBe(true);
		expect(legacyGridCellDisplayMatches("  ZMU1   Stock Transp. Order  ", "ZMU1")).toBe(true);
	});

	it("rejects empty, partial-token, and non-prefix displays", () => {
		expect(legacyGridCellDisplayMatches("", "U")).toBe(false);
		expect(legacyGridCellDisplayMatches("U", "")).toBe(false);
		expect(legacyGridCellDisplayMatches("U1 Stock Transfer", "U")).toBe(false);
		expect(legacyGridCellDisplayMatches("ZMU10 Stock Transp. Order", "ZMU1")).toBe(false);
		expect(legacyGridCellDisplayMatches("Stock Transfer U", "U")).toBe(false);
	});
});
