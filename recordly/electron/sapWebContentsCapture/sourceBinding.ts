import type { WebContents } from "electron";

export function getBoundTabMediaSourceId(
	sourceWebContents: Pick<WebContents, "getMediaSourceId">,
	requestWebContents: WebContents,
): string {
	return sourceWebContents.getMediaSourceId(requestWebContents);
}
