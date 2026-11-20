import type { CaptureStartContext } from "../../../scripts/capture-start-run.mjs";
import type { SapFrameSummary } from "../sapWebContentsControl/controller";

const normalize = (text: string | undefined) => (text ?? "").trim().replace(/\s+/gu, " ");
const homeTitle = /^(?:Home|Fiori Home|SAP Fiori Launchpad|首页|主页面|主页)$/iu;

// This value stays in memory and is compared again immediately before requesting the media stream.
export function capturePageIdentity(target: CaptureStartContext, href: string, frames: readonly SapFrameSummary[]) {
	const url = new URL(href);
	const main = frames.find((frame) => frame.mainFrame);
	if (!main || url.origin !== target.origin || main.url !== target.origin || url.username || url.password) {
		throw new Error("The SAP BrowserWindow is outside this run's verified DEV/QAS origin.");
	}
	const clients = [...url.searchParams.getAll("sap-client"), ...frames.flatMap((frame) =>
		frame.url === target.origin && frame.sapClient ? [frame.sapClient] : [])];
	if (!clients.length || clients.some((client) => client !== target.client)) {
		throw new Error("The current SAP page does not verify the run's client.");
	}
	if (frames.some((frame) => frame.captureReady !== true)) {
		throw new Error("The SAP page is loading, busy, or shows an authentication challenge.");
	}
	const recovery = target.recoveryPage;
	if (recovery) {
		const matches = frames.filter((frame) => frame.url === target.origin &&
			normalize(frame.title) === normalize(recovery.title) && frame.controls?.some((control) =>
				[control.targetName, control.ariaLabel, control.title, control.text].some(
					(label) => normalize(label) === normalize(recovery.visibleText),
				)));
		if (matches.length !== 1) throw new Error("The live SAP page does not confirm the recorded recovery title and visible control.");
		return JSON.stringify([url.href, main.frameId, matches[0].frameId, matches[0].title]);
	}
	const homeRoute = /^#Shell-home(?:[?&].*)?$/iu.test(url.hash) ||
		(!url.hash && /\/(?:flp\/?|FioriLaunchpad\.html)$/iu.test(url.pathname));
	const shell = main.controls?.some(({ id }) => id === "sf" || id?.startsWith("searchFieldInShell-") || id === "shellAppTitle");
	if (!homeRoute || !homeTitle.test(normalize(main.title)) || !shell) {
		throw new Error("First capture requires the authenticated Fiori Home route, Home title and visible launchpad shell.");
	}
	return JSON.stringify([url.href, main.frameId, main.title]);
}
