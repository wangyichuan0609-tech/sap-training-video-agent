export interface CapturePermissionRequest {
	permission: string;
	mediaTypes: readonly string[] | undefined;
	rendererMatched: boolean;
}

export interface CaptureRendererLoadLatch<T extends object> {
	readonly isLoaded: boolean;
	markLoaded: () => void;
	matches: (candidate: T | null) => boolean;
}

export function createCaptureRendererLoadLatch<T extends object>(
	expectedRenderer: T,
): CaptureRendererLoadLatch<T> {
	let loaded = false;
	return {
		get isLoaded() {
			return loaded;
		},
		markLoaded: () => {
			loaded = true;
		},
		matches: (candidate) => candidate === expectedRenderer && loaded,
	};
}

export function shouldGrantCapturePermissionRequest(request: CapturePermissionRequest): boolean {
	if (!request.rendererMatched || request.mediaTypes?.includes("audio")) {
		return false;
	}

	if (request.permission === "display-capture") {
		return (
			!request.mediaTypes ||
			request.mediaTypes.length === 0 ||
			(request.mediaTypes.length === 1 && request.mediaTypes[0] === "video")
		);
	}

	return (
		request.permission === "media" &&
		(!request.mediaTypes ||
			(request.mediaTypes.length === 1 && request.mediaTypes[0] === "video"))
	);
}
