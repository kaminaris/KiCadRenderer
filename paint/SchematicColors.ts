// Colors from the user's wDark (Schematic only) theme — a third-party
// scheme (github.com/pointhi/kicad-color-schemes), confirmed as the user's
// actually-active eeschema color_theme (not a KiCad-bundled default) by
// reading their own installed copy directly: Documents/KiCad/10.0/3rdparty/
// colors/com_github_pointhi_kicad-color-schemes_wdark/wdark.json. Every
// value below is transcribed from that file's own `schematic` section
// (`background` -> our schematicBackgroundColor, `wire` -> wire, etc.) —
// don't invent a value for a new entry without checking that file first;
// two entries added without checking it (labelDirective, ruleArea) shipped
// with a guessed orange that didn't match the user's real KiCad at all
// (confirmed both by rule_area's value being genuinely different AND by the
// user's own visual report: "rendered red... viewer shows orange").
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
	// wDark's own `netclass_flag` key — a deliberately muted dark gray, NOT
	// a bright/distinct color like the 3 net-naming label kinds above (a
	// directive label is a "meta" annotation, not part of the actual net).
	labelDirective: 'rgb(72, 72, 72)',
	// wDark's own `rule_area` key.
	ruleArea: 'rgb(255, 0, 0)',
	sheet: 'rgb(198, 120, 221)',
	sheetBackground: 'rgb(0, 0, 0)',
	sheetFields: 'rgb(132, 0, 132)',
	sheetFilename: 'rgb(198, 120, 221)',
	sheetLabel: 'rgb(198, 120, 221)',
	note: 'rgb(97, 175, 239)',
	// Standalone schematic-level "graphic item" annotations (rectangle/
	// circle/arc/polyline drawn directly on the sheet via eeschema's own
	// drawing tools — NOT symbol body graphics, which live nested inside
	// lib_symbols and use componentOutline/componentBody instead). Real
	// KiCad draws these on LAYER_NOTES when unspecified (confirmed in
	// sch_painter.cpp's getRenderColor: a root-level, non-symbol-child
	// SCH_SHAPE with no explicit stroke color falls back to
	// GetLayerColor(LAYER_NOTES)) — same color as `note` below, not its own
	// distinct value.
	graphic: 'rgb(97, 175, 239)',
	// The page frame / title block ("drawing sheet") — wDark's own
	// `worksheet` key. NOT the light cyan/teal a previous version of this
	// file guessed — that never matched wDark, only "looked plausibly
	// KiCad-ish."
	frame: 'rgb(127, 132, 142)',
} as const;

// Coarse category buckets for the schematic layer-toggle UI, bottom-to-top
// paint order — schematics have nowhere near PCB's real layer-stack
// complexity, so this is a small fixed set rather than something derived
// from file data. 'Frame' is last (drawn on top) — matches real KiCad
// drawing the worksheet as the topmost overlay.
export const schematicLayerOrder: string[] = [
	'Sheets', 'RuleAreas', 'Graphics', 'Wires', 'Junctions', 'NoConnects', 'Symbols', 'Pins', 'Labels', 'Text', 'Frame', 'Dangling',
];
