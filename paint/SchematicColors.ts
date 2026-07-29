// Colors from the user's wDark (Schematic only) theme.
export const schematicBackgroundColor = 'rgb(40, 44, 52)';

export const schColors = {
	wire: 'rgb(152, 195, 121)',
	bus: 'rgb(97, 175, 239)',
	junction: 'rgb(152, 195, 121)',
	noConnect: 'rgb(97, 175, 239)',
	componentOutline: 'rgb(224, 108, 117)',
	componentBody: 'rgb(84, 88, 98)',
	pin: 'rgb(224, 108, 117)',
	pinName: 'rgb(152, 195, 121)',
	pinNumber: 'rgb(224, 108, 117)',
	reference: 'rgb(86, 182, 194)',
	value: 'rgb(86, 182, 194)',
	fields: 'rgb(86, 182, 194)',
	labelLocal: 'rgb(229, 192, 123)',
	labelGlobal: 'rgb(224, 108, 117)',
	labelHier: 'rgb(198, 120, 221)',
	sheet: 'rgb(198, 120, 221)',
	sheetBackground: 'rgb(0, 0, 0)',
	sheetFields: 'rgb(132, 0, 132)',
	sheetFilename: 'rgb(198, 120, 221)',
	sheetLabel: 'rgb(198, 120, 221)',
	note: 'rgb(97, 175, 239)',
	// Standalone schematic-level "graphic item" annotations (rectangle/
	// circle/arc/polyline drawn directly on the sheet via eeschema's own
	// drawing tools — NOT symbol body graphics, which live nested inside
	// lib_symbols and use componentOutline/componentBody instead).
	graphic: 'rgb(160, 160, 160)',
	// The page frame / title block ("drawing sheet") — matches real KiCad's
	// default worksheet theme color (a light cyan/teal).
	frame: 'rgb(78, 191, 206)',
} as const;

// Coarse category buckets for the schematic layer-toggle UI, bottom-to-top
// paint order — schematics have nowhere near PCB's real layer-stack
// complexity, so this is a small fixed set rather than something derived
// from file data. 'Frame' is last (drawn on top) — matches real KiCad
// drawing the worksheet as the topmost overlay.
export const schematicLayerOrder: string[] = [
	'Sheets', 'Graphics', 'Wires', 'Junctions', 'NoConnects', 'Symbols', 'Pins', 'Labels', 'Text', 'Frame',
];
