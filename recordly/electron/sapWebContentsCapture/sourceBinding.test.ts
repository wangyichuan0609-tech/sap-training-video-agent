import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { getBoundTabMediaSourceId } from "./sourceBinding";

describe("getBoundTabMediaSourceId", () => {
	it("binds the SAP WebContents stream ID to the hidden capture renderer", () => {
		const captureWebContents = { id: 27 } as WebContents;
		const getMediaSourceId = vi.fn(() => "web-contents-media-source-id");

		const result = getBoundTabMediaSourceId({ getMediaSourceId }, captureWebContents);

		expect(result).toBe("web-contents-media-source-id");
		expect(getMediaSourceId).toHaveBeenCalledOnce();
		expect(getMediaSourceId).toHaveBeenCalledWith(captureWebContents);
	});
});
