import type { CaptionWordState } from "./captionLayout";
import { DEFAULT_AUTO_CAPTION_SETTINGS } from "./types";
import type { CaptionPlacement } from "./types";

export const CAPTION_FONT_WEIGHT = 400;
export const CAPTION_LINE_HEIGHT = 1.32;
export const DEFAULT_CAPTION_TOP_OFFSET = 4;

const DEFAULT_CAPTION_REFERENCE_WIDTH = 1920 * (DEFAULT_AUTO_CAPTION_SETTINGS.maxWidth / 100);

export function getCaptionTargetWidth(containerWidth: number, maxWidthPercent: number) {
	return Math.max(1, containerWidth * (maxWidthPercent / 100));
}

export function getCaptionScaledFontSize(
	fontSize: number,
	containerWidth: number,
	maxWidthPercent: number,
) {
	return Math.max(
		14,
		fontSize *
			(getCaptionTargetWidth(containerWidth, maxWidthPercent) /
				DEFAULT_CAPTION_REFERENCE_WIDTH),
	);
}

export function getCaptionPadding(fontSize: number) {
	return {
		x: fontSize * 1.1,
		y: fontSize * 0.78,
	};
}

export function getCaptionScaledRadius(radius: number, fontSize: number) {
	const baseline = Math.max(1, DEFAULT_AUTO_CAPTION_SETTINGS.fontSize);
	return Math.max(0, radius * (fontSize / baseline));
}

export function getCaptionTextMaxWidth(
	containerWidth: number,
	maxWidthPercent: number,
	fontSize: number,
) {
	const padding = getCaptionPadding(fontSize);
	return Math.max(
		fontSize * 4,
		getCaptionTargetWidth(containerWidth, maxWidthPercent) - padding.x * 2,
	);
}

export function getCaptionWordVisualState(_hasWordTimings: boolean, _state: CaptionWordState) {
	// Per-word "spoken" highlighting is disabled: word-level timings from the
	// transcriber are unreliable, so captions render as a single uniform block.
	return {
		isInactive: false,
		opacity: 1,
	};
}

export function getCaptionCenterY(
	height: number,
	boxHeight: number,
	placement: CaptionPlacement | undefined,
	bottomOffset: number,
	topOffset = DEFAULT_CAPTION_TOP_OFFSET,
	centerYPercent?: number,
) {
	if (Number.isFinite(centerYPercent)) {
		const safeCenterYPercent = Math.min(92, Math.max(8, centerYPercent as number));
		return (height * safeCenterYPercent) / 100;
	}
	if (placement === "top") {
		return (height * topOffset) / 100 + boxHeight / 2;
	}
	return height - (height * bottomOffset) / 100 - boxHeight / 2;
}
