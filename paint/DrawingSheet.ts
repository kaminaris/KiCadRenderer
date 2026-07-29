import { Vec2 } from '../math/Vec2';
import { unescapeKicadString } from './KicadStringEscapes';

/*
	KiCad's page frame / title block ("drawing sheet", .kicad_wks) — every
	.kicad_sch/.kicad_pcb implicitly uses KiCad's BUILT-IN default layout
	unless a project overrides it with a custom .kicad_wks file (which this
	renderer doesn't fetch/parse — same scope boundary as not resolving
	child sheet files automatically). This is a direct, literal transcription
	of KiCad's own default_drawing_sheet.kicad_wks (confirmed against
	kicanvas's bundled copy, src/kicad/default_drawing_sheet.kicad_wks) as
	plain data, since we always render the default layout rather than
	parsing a real .kicad_wks S-expression file.
*/

export type WksAnchor = 'ltcorner' | 'rbcorner' | 'lbcorner' | 'rtcorner';
export type WksHAlign = 'left' | 'center' | 'right';
export type WksVAlign = 'top' | 'center' | 'bottom';

export interface WksLineItem {
	kind: 'line';
	start: Vec2; startAnchor: WksAnchor;
	end: Vec2; endAnchor: WksAnchor;
	repeat: number; incrx: number; incry: number;
}

export interface WksRectItem {
	kind: 'rect';
	start: Vec2; startAnchor: WksAnchor;
	end: Vec2; endAnchor: WksAnchor;
	repeat: number; incrx: number; incry: number;
}

export interface WksTextItem {
	kind: 'text';
	text: string; pos: Vec2; anchor: WksAnchor;
	hAlign: WksHAlign; vAlign: WksVAlign;
	bold: boolean; sizeMm: number;
	repeat: number; incrx: number; incry: number; incrlabel: number;
}

export type WksItem = WksLineItem | WksRectItem | WksTextItem;

export interface WksSetup {
	textSizeMm: number;
	lineWidthMm: number;
	leftMargin: number; rightMargin: number; topMargin: number; bottomMargin: number;
}

export const defaultWksSetup: WksSetup = {
	textSizeMm: 1.5, lineWidthMm: 0.15,
	leftMargin: 10, rightMargin: 10, topMargin: 10, bottomMargin: 10,
};

function line(
	sx: number, sy: number, ex: number, ey: number,
	opts: { startAnchor?: WksAnchor; endAnchor?: WksAnchor; repeat?: number; incrx?: number; incry?: number } = {}
): WksLineItem {
	return {
		kind: 'line',
		start: new Vec2(sx, sy), startAnchor: opts.startAnchor ?? 'rbcorner',
		end: new Vec2(ex, ey), endAnchor: opts.endAnchor ?? 'rbcorner',
		repeat: opts.repeat ?? 1, incrx: opts.incrx ?? 0, incry: opts.incry ?? 0,
	};
}

function rect(
	sx: number, sy: number, ex: number, ey: number,
	opts: { startAnchor?: WksAnchor; endAnchor?: WksAnchor; repeat?: number; incrx?: number; incry?: number } = {}
): WksRectItem {
	return {
		kind: 'rect',
		start: new Vec2(sx, sy), startAnchor: opts.startAnchor ?? 'rbcorner',
		end: new Vec2(ex, ey), endAnchor: opts.endAnchor ?? 'rbcorner',
		repeat: opts.repeat ?? 1, incrx: opts.incrx ?? 0, incry: opts.incry ?? 0,
	};
}

function text(
	str: string, x: number, y: number,
	opts: {
		anchor?: WksAnchor; hAlign?: WksHAlign; vAlign?: WksVAlign; bold?: boolean; sizeMm?: number;
		repeat?: number; incrx?: number; incry?: number; incrlabel?: number;
	} = {}
): WksTextItem {
	return {
		kind: 'text', text: str, pos: new Vec2(x, y), anchor: opts.anchor ?? 'rbcorner',
		hAlign: opts.hAlign ?? 'left', vAlign: opts.vAlign ?? 'center',
		bold: opts.bold ?? false, sizeMm: opts.sizeMm ?? defaultWksSetup.textSizeMm,
		repeat: opts.repeat ?? 1, incrx: opts.incrx ?? 0, incry: opts.incry ?? 0, incrlabel: opts.incrlabel ?? 0,
	};
}

// prettier-ignore
export const defaultWksItems: WksItem[] = [
	// Page outline — the paper edge itself (0,0) to (width,height). Real
	// KiCad computes this from -margin offsets that happen to cancel out to
	// exactly the page bounds for the default (equal) margins; hardcoded
	// directly here since our margins are always the DEFAULT_WKS_SETUP
	// constants, never parsed from a real .kicad_wks.
	rect(0, 0, 0, 0, { startAnchor: 'ltcorner', endAnchor: 'rbcorner' }),
	// Rect around the title block.
	rect(110, 34, 2, 2),
	// Double-line border just inside the page edge (margin box, repeated
	// once more 2mm further in).
	rect(0, 0, 0, 0, { startAnchor: 'ltcorner', repeat: 2, incrx: 2, incry: 2 }),
	// Top edge ruler ticks + numbers.
	line(50, 2, 50, 0, { startAnchor: 'ltcorner', endAnchor: 'ltcorner', repeat: 30, incrx: 50 }),
	text('1', 25, 1, { anchor: 'ltcorner', sizeMm: 1.3, repeat: 100, incrx: 50, incrlabel: 1 }),
	// Bottom edge ruler ticks + numbers.
	line(50, 2, 50, 0, { startAnchor: 'lbcorner', endAnchor: 'lbcorner', repeat: 30, incrx: 50 }),
	text('1', 25, 1, { anchor: 'lbcorner', sizeMm: 1.3, repeat: 100, incrx: 50, incrlabel: 1 }),
	// Left edge ruler ticks + letters.
	line(0, 50, 2, 50, { startAnchor: 'ltcorner', endAnchor: 'ltcorner', repeat: 30, incry: 50 }),
	text('A', 1, 25, { anchor: 'ltcorner', sizeMm: 1.3, hAlign: 'center', repeat: 100, incry: 50, incrlabel: 1 }),
	// Right edge ruler ticks + letters.
	line(0, 50, 2, 50, { startAnchor: 'rtcorner', endAnchor: 'rtcorner', repeat: 30, incry: 50 }),
	text('A', 1, 25, { anchor: 'rtcorner', sizeMm: 1.3, hAlign: 'center', repeat: 100, incry: 50, incrlabel: 1 }),
	// Title block contents.
	text('Date: ${ISSUE_DATE}', 87, 6.9),
	line(110, 5.5, 2, 5.5),
	text('${KICAD_VERSION}', 109, 4.1),
	line(110, 8.5, 2, 8.5),
	text('Rev: ${REVISION}', 24, 6.9, { bold: true }),
	text('Size: ${PAPER}', 109, 6.9),
	text('Id: ${#}/${##}', 24, 4.1),
	line(110, 12.5, 2, 12.5),
	text('Title: ${TITLE}', 109, 10.7, { sizeMm: 2, bold: true }),
	text('File: ${FILENAME}', 109, 14.3),
	line(110, 18.5, 2, 18.5),
	text('Sheet: ${SHEETPATH}', 109, 17),
	text('${COMPANY}', 109, 20, { bold: true }),
	text('${COMMENT1}', 109, 23),
	text('${COMMENT2}', 109, 26),
	text('${COMMENT3}', 109, 29),
	text('${COMMENT4}', 109, 32),
	line(90, 8.5, 90, 5.5),
	line(26, 8.5, 26, 2),
];

/** Resolves a WKS item's corner-relative local point into an absolute
 * position on the page — ports kicanvas's offset_point() (mirrored
 * lb/rt corners flip one axis of the stored local point, matching how
 * KiCad's own drawing-sheet editor measures from whichever corner is
 * closest). */
export function resolveWksAnchor(sheetSize: Vec2, setup: WksSetup, anchor: WksAnchor, point: Vec2): Vec2 {
	const topLeft = new Vec2(setup.leftMargin, setup.topMargin);
	const topRight = new Vec2(sheetSize.x - setup.rightMargin, setup.topMargin);
	const bottomLeft = new Vec2(setup.leftMargin, sheetSize.y - setup.bottomMargin);
	const bottomRight = new Vec2(sheetSize.x - setup.rightMargin, sheetSize.y - setup.bottomMargin);
	switch (anchor) {
		case 'ltcorner': return topLeft.add(point);
		case 'rbcorner': return bottomRight.sub(point);
		case 'lbcorner': return bottomLeft.add(new Vec2(point.x, -point.y));
		case 'rtcorner': return topRight.add(new Vec2(-point.x, point.y));
	}
}

/** True if `p` sits within the margin box (inclusive) — repeated ruler
 * ticks/labels stop generating once they'd fall past the page edge, rather
 * than needing an exact hardcoded repeat count. */
export function withinWksMargin(sheetSize: Vec2, setup: WksSetup, p: Vec2): boolean {
	const left = setup.leftMargin, top = setup.topMargin;
	const right = sheetSize.x - setup.rightMargin, bottom = sheetSize.y - setup.bottomMargin;
	return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
}

// KiCad's standard paper sizes, in mm (landscape/default orientation) —
// ports common.ts's PaperSize table.
export const wksPaperSizes: Record<string, [number, number]> = {
	User: [431.8, 279.4],
	A0: [1189, 841],
	A1: [841, 594],
	A2: [594, 420],
	A3: [420, 297],
	A4: [297, 210],
	A5: [210, 148],
	A: [279.4, 215.9],
	B: [431.8, 279.4],
	C: [558.8, 431.8],
	D: [863.6, 558.8],
	E: [1117.6, 863.6],
	USLetter: [279.4, 215.9],
	USLegal: [355.6, 215.9],
	USLedger: [431.8, 279.4],
};

/** Expands `${VAR}` references against a flat lookup table — simpler than
 * KiCad's own cross-reference-capable resolver (which can chase
 * `${uuid:FIELD}` symbol references and detects cycles) since drawing-sheet
 * text only ever references the fixed set of vars built by the caller.
 * An unresolved `${VAR}` is left as-is, matching KiCad's own behavior of
 * not silently blanking a var it doesn't recognize. Note: computeStrokeTextGeometry()
 * ALSO unescapes `{name}` chars (see KicadStringEscapes.ts) as its own single
 * choke point for every text value this renderer draws — doing it again here
 * first just makes `${VAR}` matching itself robust to an escaped `$`/`{`/`}`
 * appearing before variable substitution runs. */
export function expandWksTextVars(str: string, vars: Record<string, string>): string {
	const unescaped = unescapeKicadString(str);
	return unescaped.replace(/\$\{(.+?)\}/g, (whole, name: string) => {
		return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole;
	});
}
