let browserCaptureModeActive = false;

export function activateBrowserCaptureMode() {
	browserCaptureModeActive = true;
}

export function isBrowserCaptureModeActive() {
	return browserCaptureModeActive;
}
