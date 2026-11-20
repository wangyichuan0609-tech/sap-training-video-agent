export const SAP_BROWSER_URL_ARGUMENT_PREFIX = "--recordly-sap-url=";

export function normalizeSapBrowserUrl(value: string): string {
	const parsed = new URL(value);
	if (
		parsed.protocol !== "https:" ||
		!parsed.hostname ||
		parsed.username.length > 0 ||
		parsed.password.length > 0
	) {
		throw new Error("Recordly SAP Browser requires an HTTPS URL without embedded credentials.");
	}

	return parsed.href;
}

export function getSapBrowserUrlArgument(commandLine: readonly string[]): string | null {
	const argument = commandLine.find((value) => value.startsWith(SAP_BROWSER_URL_ARGUMENT_PREFIX));
	if (!argument) {
		return null;
	}

	const value = argument.slice(SAP_BROWSER_URL_ARGUMENT_PREFIX.length);
	if (!value) {
		throw new Error("Recordly SAP Browser URL argument is empty.");
	}

	return normalizeSapBrowserUrl(value);
}

export function isAllowedSapBrowserNavigation(targetUrl: string, expectedOrigin: string): boolean {
	try {
		const target = new URL(targetUrl);
		return (
			target.protocol === "https:" &&
			!target.username &&
			!target.password &&
			target.origin === expectedOrigin
		);
	} catch {
		return false;
	}
}
