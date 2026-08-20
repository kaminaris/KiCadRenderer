import { KicadParser } from '@kicad-io/KicadParser';
import { repairLegacyMalformedZoneText } from './utils';

/** Parse a generic KiCad S-expression string into the AST used by the
 *  renderer and helpers. This is a thin wrapper around @kicad-io/KicadParser
 *  so callers don't need a direct dependency on the parser package. */
export function parseText(text: string) {
	return new KicadParser().parse(text);
}

/** Parse board text while applying legacy zone outline repairs first.
 *  Older zone-tool output used a malformed `( ( pts ...))` pattern; this
 *  function ensures those are migrated before parsing so downstream code
 *  receives a normalized AST. */
export function parseBoardText(text: string) {
	return new KicadParser().parse(repairLegacyMalformedZoneText(text));
}
