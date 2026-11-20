export interface CaptureStartContext {
	system: "DEV" | "QAS";
	origin: string;
	client: string;
	recoveryPage?: { title: string; visibleText: string };
}
export function readCaptureStartContext(outputPath: string, explicitRunPath?: string): Promise<CaptureStartContext>;
