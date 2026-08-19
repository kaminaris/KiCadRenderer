import { KicadParser } from '@kicad-io/KicadParser';
import { repairLegacyMalformedZoneText } from './utils';

export function parseText(text: string) {
	return new KicadParser().parse(text);
}

export function parseBoardText(text: string) {
	return new KicadParser().parse(repairLegacyMalformedZoneText(text));
}
