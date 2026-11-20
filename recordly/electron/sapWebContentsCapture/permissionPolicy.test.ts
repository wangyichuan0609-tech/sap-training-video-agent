import { describe, expect, it } from "vitest";
import {
	createCaptureRendererLoadLatch,
	shouldGrantCapturePermissionRequest,
} from "./permissionPolicy";

describe("SAP WebContents capture permission policy", () => {
	it("authorizes only the expected renderer after its load completes", () => {
		const expected = {};
		const other = {};
		const latch = createCaptureRendererLoadLatch(expected);

		expect(latch.matches(expected)).toBe(false);
		latch.markLoaded();
		expect(latch.isLoaded).toBe(true);
		expect(latch.matches(expected)).toBe(true);
		expect(latch.matches(other)).toBe(false);
	});

	it("allows bound display capture without audio", () => {
		expect(
			shouldGrantCapturePermissionRequest({
				permission: "display-capture",
				mediaTypes: undefined,
				rendererMatched: true,
			}),
		).toBe(true);
	});

	it("rejects display capture from another renderer or with audio", () => {
		expect(
			shouldGrantCapturePermissionRequest({
				permission: "display-capture",
				mediaTypes: undefined,
				rendererMatched: false,
			}),
		).toBe(false);
		expect(
			shouldGrantCapturePermissionRequest({
				permission: "display-capture",
				mediaTypes: ["audio"],
				rendererMatched: true,
			}),
		).toBe(false);
	});

	it("keeps ordinary media permission video-only", () => {
		expect(
			shouldGrantCapturePermissionRequest({
				permission: "media",
				mediaTypes: ["video"],
				rendererMatched: true,
			}),
		).toBe(true);
		expect(
			shouldGrantCapturePermissionRequest({
				permission: "media",
				mediaTypes: ["video", "audio"],
				rendererMatched: true,
			}),
		).toBe(false);
	});
});
