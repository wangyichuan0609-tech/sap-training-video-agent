import { BrowserWindow, session, type WebContents } from "electron";
import { isAllowedSapBrowserNavigation, normalizeSapBrowserUrl } from "./sapBrowserPolicy";

const SAP_BROWSER_TITLE = "Recordly SAP Browser";

let sapBrowserWindow: BrowserWindow | null = null;
let creatingSapBrowserWindow = false;

export function isCreatingSapBrowserWindow(): boolean {
	return creatingSapBrowserWindow;
}

export function getSapBrowserWindow(): BrowserWindow | null {
	return sapBrowserWindow && !sapBrowserWindow.isDestroyed() ? sapBrowserWindow : null;
}

export function isSapBrowserWebContents(contents: WebContents): boolean {
	return getSapBrowserWindow()?.webContents === contents;
}

function configureSapNavigation(window: BrowserWindow, expectedOrigin: string): void {
	const allow = (url: string) => isAllowedSapBrowserNavigation(url, expectedOrigin);

	window.webContents.on("will-navigate", (event, url) => {
		if (!allow(url)) {
			event.preventDefault();
		}
	});
	window.webContents.on("will-redirect", (event, url) => {
		if (!allow(url)) {
			event.preventDefault();
		}
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export async function openSapBrowserWindow(value: string): Promise<BrowserWindow> {
	const sapUrl = normalizeSapBrowserUrl(value);
	const expectedOrigin = new URL(sapUrl).origin;
	const existing = getSapBrowserWindow();

	if (existing) {
		if (existing.isMinimized()) {
			existing.restore();
		}
		existing.show();
		existing.moveTop();
		existing.focus();
		if (existing.webContents.getURL() !== sapUrl) {
			await existing.loadURL(sapUrl);
		}
		return existing;
	}

	creatingSapBrowserWindow = true;
	try {
		sapBrowserWindow = new BrowserWindow({
			title: SAP_BROWSER_TITLE,
			width: 1440,
			height: 900,
			minWidth: 1024,
			minHeight: 700,
			show: false,
			autoHideMenuBar: true,
			backgroundColor: "#ffffff",
			webPreferences: {
				session: session.defaultSession,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				backgroundThrottling: false,
				spellcheck: false,
			},
		});
	} finally {
		creatingSapBrowserWindow = false;
	}

	const window = sapBrowserWindow;
	configureSapNavigation(window, expectedOrigin);
	window.once("ready-to-show", () => {
		window.show();
		window.moveTop();
		window.focus();
	});
	window.webContents.on("page-title-updated", (event, title) => {
		event.preventDefault();
		window.setTitle(title ? `${SAP_BROWSER_TITLE} — ${title}` : SAP_BROWSER_TITLE);
	});
	window.on("closed", () => {
		if (sapBrowserWindow === window) {
			sapBrowserWindow = null;
		}
	});

	await window.loadURL(sapUrl);
	return window;
}
