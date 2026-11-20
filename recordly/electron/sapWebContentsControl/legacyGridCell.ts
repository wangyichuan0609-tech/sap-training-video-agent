function normalizeCellText(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function legacyGridCellDisplayMatches(display: string, expectedCode: string): boolean {
	const normalizedDisplay = normalizeCellText(display);
	const normalizedCode = normalizeCellText(expectedCode);
	if (!normalizedCode || !normalizedDisplay.startsWith(normalizedCode)) return false;
	if (normalizedDisplay.length === normalizedCode.length) return true;
	return !/^[\p{L}\p{N}_]/u.test(normalizedDisplay.slice(normalizedCode.length));
}
