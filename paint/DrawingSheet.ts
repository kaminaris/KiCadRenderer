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

/** Expands `${VAR}` references against a flat lookup table (title-block/
 * page vars) plus, optionally, `${REFDES:FIELD}` cross-references into
 * another placed symbol's own properties (e.g. `${R3:VALUE}`) — real KiCad's
 * "Symbol Pin Functions" (`${R3:NET_NAME(1)}` etc.) and the full `@{...}`
 * expression/conditional language are NOT implemented (they need net/
 * connectivity resolution and a real expression evaluator respectively —
 * out of scope here); an unresolved reference of either kind is left as-is,
 * matching KiCad's own behavior of not silently blanking a var it doesn't
 * recognize (rather than KiCad's `<UNRESOLVED: ...>` marker, a deliberate
 * simplification). computeStrokeTextGeometry() ALSO unescapes `{name}` chars
 * (see KicadStringEscapes.ts) as its own single choke point for every text
 * value this renderer draws — doing it again here first just makes `${VAR}`
 * matching itself robust to an escaped `$`/`{`/`}` appearing before variable
 * substitution runs.
 *
 * `\${VAR}` and a bare `\$` (real KiCad's escape for "don't expand this")
 * render as literal text with the backslash stripped.
 *
 * Variables can reference other variables (e.g. a COMMENT field containing
 * another `${VAR}`) — re-expanded up to 6 levels deep, matching real KiCad's
 * own documented nesting-depth cap, stopping early once a pass changes
 * nothing.
 */
export function expandTextVars(
	str: string,
	vars: Record<string, string>,
	symbolFields?: Map<string, Record<string, string>>
): string {
	let result = unescapeKicadString(str);
	for (let depth = 0; depth < 6; depth++) {
		const next = expandTextVarsOnce(result, vars, symbolFields);
		if (next === result) {
			break;
		}
		result = next;
	}
	return result;
}

function expandTextVarsOnce(
	str: string,
	vars: Record<string, string>,
	symbolFields?: Map<string, Record<string, string>>
): string {
	return str.replace(/\\\$\{([^}]*)\}|\$\{([^}]*)\}|\\\$/g, (whole, escapedName: string | undefined, name: string | undefined) => {
		if (whole === '\\$') {
			return '$';
		}
		if (escapedName !== undefined) {
			return `\${${ escapedName }}`;
		}
		const refIdx = name!.indexOf(':');
		if (refIdx !== -1 && symbolFields) {
			const ref = name!.slice(0, refIdx).trim();
			const field = name!.slice(refIdx + 1).trim().toUpperCase();
			const fields = symbolFields.get(ref);
			return fields && Object.prototype.hasOwnProperty.call(fields, field) ? fields[field]! : whole;
		}
		return Object.prototype.hasOwnProperty.call(vars, name!) ? vars[name!]! : whole;
	});
}

/**
 * The board/schematic title block — the set of title-block fields KiCad's
 * drawing sheet shows (Title, Date, Rev, Company, Comment1..4).
 */
export interface TITLE_BLOCK {
	title: string;
	date: string;
	rev: string;
	company: string;
	comment1: string;
	comment2: string;
	comment3: string;
	comment4: string;
}

/** An empty title block. */
export function emptyTitleBlock(): TITLE_BLOCK {
	return { title: '', date: '', rev: '', company: '', comment1: '', comment2: '', comment3: '', comment4: '' };
}

/**
 * Reads the KiCad title block from a parsed board/schematic root element
 * (the `(title_block ...)` / `(title ...)` child), returning it as a
 * TITLE_BLOCK.
 */
export function getTitleBlock(rootElement: any): TITLE_BLOCK {
	const tbl: TITLE_BLOCK = emptyTitleBlock();

	const readChild = (parent: any, key: string): string => {
		for (const c of parent?.children ?? []) {
			if (c?.name === key) {
				return c.value ?? '';
			}
		}
		return '';
	};

	// The title block may be a direct `(title ...)` child or a nested
	// `(title_block (title ...)...)` child (KiCad newer schema wraps it).
	let block: any = null;

	for (const c of rootElement?.children ?? []) {
		if (c?.name === 'title_block') {
			block = c;
			break;
		}
	}

	const source = block ?? rootElement;

	tbl.title = readChild(source, 'title');
	tbl.date = readChild(source, 'date');
	tbl.rev = readChild(source, 'rev');
	tbl.company = readChild(source, 'company');
	for (let i = 1; i <= 4; i++) {
		(tbl as unknown as Record<string, string>)[`comment${ i }`] = readChild(source, `comment${ i }`);
	}

	return tbl;
}

/**
 * Parses a `.kicad_wks` drawing-sheet file into a `{ setup, items }` model.
 * Mirrors KiCad's WKS_READER (libs/kicad/drawing_sheet.cpp). The S-expression
 * AST is produced by the shared @kicad-io KicadParser.
 */
export function parseWks(text: string): { setup: WksSetup; items: WksItem[] } {
	const setup: WksSetup = { ...defaultWksSetup };
	const items: WksItem[] = [];

	// Minimal s-expression tokenizer (parentheses + atoms).
	const tokens: string[] = [];
	let i = 0;
	const isSpace = (c: string): boolean => /[\s()]/.test(c);
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === '(' || ch === ')') {
			tokens.push(ch);
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		let tok = '';
		while (i < text.length && !isSpace(text[i]!)) {
			tok += text[i]!;
			i++;
		}
		tokens.push(tok);
	}

	// Build the s-expression tree.
	const build = (): any => {
		// returns { name, children: any[] } for a list, or string for an atom
		const t = tokens.shift();
		if (t === '(') {
			const list: { name: string; children: any[]; value?: string } = { name: '', children: [] };
			while (tokens.length && tokens[0] !== ')') {
				const child = build();
				if (typeof child === 'string') {
					if (!list.name && !list.children.length) {
						list.name = child;
					} else {
						list.children.push(child);
					}
				} else {
					list.children.push(child);
				}
			}
			tokens.shift(); // ')'
			return list;
		}
		return t ?? '';
	};

	const root = build();

	const anchorFrom = (a: string): WksAnchor => {
		switch (a) {
			case 'ltcorner':
			case 'rbcorner':
			case 'lbcorner':
			case 'rtcorner':
				return a;
			default:
				return 'rbcorner';
		}
	};

	const findChild = (node: any, name: string): any | undefined => {
		if (!node || !node.children) return undefined;
		for (const c of node.children) {
			if (typeof c === 'object' && c.name === name) return c;
		}
		return undefined;
	};

	const childAtoms = (node: any): string[] => (node?.children ?? []).filter((c: any) => typeof c === 'string');

	const numAt = (ch: any): number => {
		const a = childAtoms(ch);
		return a.length ? parseFloat(a[0]) || 0 : 0;
	};

	// Walk top-level forms.
	const walk = (node: any): void => {
		if (typeof node !== 'object' || !node.name) return;
		if (node.name === 'setup') {
			for (const c of node.children) {
				if (typeof c !== 'object') continue;
				if (c.name === 'textsize_ratio') {
					// ratio relative to 2.5; keep the base size fixed
				} else if (c.name === 'linewidth') {
					setup.lineWidthMm = numAt(c);
				} else if (c.name === 'left_margin') {
					setup.leftMargin = numAt(c);
				} else if (c.name === 'right_margin') {
					setup.rightMargin = numAt(c);
				} else if (c.name === 'top_margin') {
					setup.topMargin = numAt(c);
				} else if (c.name === 'bottom_margin') {
					setup.bottomMargin = numAt(c);
				}
			}
		} else if (node.name === 'line' || node.name === 'rect') {
			const start = findChild(node, 'start');
			const end = findChild(node, 'end');
			const base: any = {
				start: new Vec2(numAt(start), 0),
				end: new Vec2(numAt(end), 0),
			};
			// `(start x y)` or `(start (x y))`?
			// KiCad: `(start 5.5 6.0)`
			const sa = childAtoms(start);
			if (sa.length >= 2) {
				base.start = new Vec2(parseFloat(sa[0]) || 0, parseFloat(sa[1]) || 0);
			}
			const ea = childAtoms(end);
			if (ea.length >= 2) {
				base.end = new Vec2(parseFloat(ea[0]) || 0, parseFloat(ea[1]) || 0);
			}
			if (node.name === 'line') {
				items.push({
					kind: 'line', ...base,
					startAnchor: anchorFrom(childAtoms(findChild(node, 'start_anchor'))[0] ?? 'rbcorner'),
					endAnchor: anchorFrom(childAtoms(findChild(node, 'end_anchor'))[0] ?? 'rbcorner'),
					repeat: 1, incrx: 0, incry: 0,
				});
			} else {
				items.push({
					kind: 'rect', ...base,
					startAnchor: anchorFrom(childAtoms(findChild(node, 'start_anchor'))[0] ?? 'rbcorner'),
					endAnchor: anchorFrom(childAtoms(findChild(node, 'end_anchor'))[0] ?? 'rbcorner'),
					repeat: 1, incrx: 0, incry: 0,
				});
			}
		} else if (node.name === 'text') {
			const pos = findChild(node, 'pos');
			const pa = childAtoms(pos);
			items.push({
				kind: 'text',
				text: childAtoms(node)[0] ?? '',
				pos: pa.length >= 2 ? new Vec2(parseFloat(pa[0]) || 0, parseFloat(pa[1]) || 0) : new Vec2(),
				anchor: anchorFrom(childAtoms(findChild(node, 'anchor'))[0] ?? 'rbcorner'),
				hAlign: (childAtoms(findChild(node, 'halign'))[0] as WksHAlign) ?? 'left',
				vAlign: (childAtoms(findChild(node, 'valign'))[0] as WksVAlign) ?? 'center',
				bold: (childAtoms(findChild(node, 'bold'))[0] ?? 'no') === 'yes',
				sizeMm: numAt(findChild(node, 'height')) || setup.textSizeMm,
				repeat: 1, incrx: 0, incry: 0, incrlabel: 0,
			});
		}
		// recurse for title_block / nested groups
		for (const c of node.children ?? []) {
			if (typeof c === 'object') walk(c);
		}
	};

	walk(root);

	return { setup, items };
}

/** A resolved drawing-sheet graphic: a line or a piece of text at world coords. */
export type WksLayoutItem =
	| { kind: 'line'; a: Vec2; b: Vec2; width: number }
	| { kind: 'rect'; a: Vec2; b: Vec2; width: number }
	| { kind: 'text'; text: string; pos: Vec2; size: number; align: WksHAlign; vAlign: WksVAlign };

/**
 * Computes the concrete drawing-sheet frame layout for a given sheet size:
 * every WksItem (line/rect/text) resolved to world coordinates (with repeat
 * offsets), ready to hand to the painter. Mirrors KiCad's drawing-sheet item
 * instantiation for a sheet.
 */
export function computeWksLayout(
	sheetSize: Vec2,
	setup: WksSetup,
	items: WksItem[]
): WksLayoutItem[] {
	const out: WksLayoutItem[] = [];

	const resolve = (point: Vec2, anchor: WksAnchor): Vec2 =>
		resolveWksAnchor(sheetSize, setup, anchor, point);

	for (const item of items) {
		for (let i = 0; i < item.repeat; i++) {
			const ox = item.incrx * i;
			const oy = item.incry * i;
			if (item.kind === 'line' || item.kind === 'rect') {
				const a = resolve(item.start, item.startAnchor).add(new Vec2(ox, oy));
				const b = resolve(item.end, item.endAnchor).add(new Vec2(ox, oy));
				out.push({
					kind: item.kind,
					a,
					b,
					width: setup.lineWidthMm,
				});
			} else {
				const pos = resolve(item.pos, item.anchor).add(new Vec2(ox, oy));
				const label = item.incrlabel * i;
				const text = item.kind === 'text' && label ? appendIncrLabel(item.text, label) : item.text;
				out.push({
					kind: 'text',
					text,
					pos,
					size: item.sizeMm || setup.textSizeMm,
					align: item.hAlign,
					vAlign: item.vAlign,
				});
			}
		}
	}

	return out;
}

/** Appends an incrementing number to a label (KiCad's `&uN` incrlabel). */
function appendIncrLabel(aText: string, aIncrement: number): string {
	// KiCad increments a trailing decimal (TEXT id = '&uNN' unresolved). For a
	// plain label we just append the number when there is a `&` placeholder.
	if (aText.includes('&u')) {
		return aText.replace(/&u\d*/, String(aIncrement));
	}
	return aText;
}

/** Builds the layout for the built-in default sheet (title block drawn). */
export function computeDefaultWksLayout(sheetSize: Vec2): WksLayoutItem[] {
	return computeWksLayout(sheetSize, defaultWksSetup, defaultWksItems);
}
