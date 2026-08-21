/*
 * Shared number formatting for S-expression output, matching how KiCad formats
 * coordinates/dimensions in its file serializers (trailing zeros trimmed,
 * e.g. 1 -> "1", 1.5 -> "1.5").
 */

/**
 * Formats a number the way KiCad writes mm dimensions: trims trailing zeros
 * but keeps integer values integral.
 */
export function fmtN(v: number, aPrecision = 6): string {
	if (!Number.isFinite(v)) {
		return '0';
	}
	const r = Number(v.toFixed(aPrecision));
	return String(r);
}
