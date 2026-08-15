import { Vec2 } from '../math/Vec2';
import {
	Angle
}               from '../math/Angle';
import {
	Matrix3
}               from '../math/Matrix3';
import {
	EmbeddedImage, Renderer
}               from '../render/Renderer';
import {
	schColors, schematicBackgroundColor, schematicLayerOrder
}               from './SchematicColors';
import {
	computeStrokeTextGeometry, drawStrokeTextGeometry, getStrokeTextBounds, measureStrokeTextSize
}               from './TextPaint';
import {
	PaintedShape, shapeToBBox, distanceToSegment, polygonEdgeDistance, bboxesIntersect
}               from './PaintedShape';
import {
	arcToPolyline, circleToRing, KicadStrokeLineType, strokeDashedPolyline
}               from './StrokeDash';
import {
	defaultWksItems, defaultWksSetup, expandTextVars, resolveWksAnchor, withinWksMargin, wksPaperSizes
}               from './DrawingSheet';

// Real KiCad pin-label constants (eeschema's DefaultValues, confirmed via
// kicanvas's SCH_PAINTER::draw(LIB_PIN*, ...) port — kicanvas is an
// open-source KiCad-file renderer that documents itself as reproducing
// KiCad's own C++ painting logic line-for-line). These are fixed mm values,
// NOT scaled by the pin's own text size — an earlier version of this file
// scaled the clearance by text size, which left small transistor-style
// labels (0.508mm) overlapping the symbol body since the scaled gap shrank
// along with the text.
const pinThickness = 0.1524; // DefaultValues.line_width
const pinTextMargin = 0.6096 * 0.15; // 24 mils * DefaultValues.text_offset_ratio

// Same "no hard-coded @kicad-io import path at module scope" pattern as
// BoardPainter.ts — the parser itself (KicadParser's own internal nodeMap)
// already produces correctly-typed instances for every schematic tag with
// zero setup; these registered classes are only needed so THIS module can
// pass a concrete class reference to findChildrenByClass()/instanceof
// checks, not to tell the parser what to do.

export interface SchPaintedItem {
	id: string;
	layer: string;
	kind: 'wire' | 'bus' | 'junction' | 'no-connect' | 'symbol-graphic' | 'pin' | 'label' | 'sheet' | 'table' | 'image' | 'text' | 'frame' | 'symbol' | 'dangling';
	shape: PaintedShape;
	bbox: { x: number; y: number; w: number; h: number };
	hitTestable: boolean;
	element: any;
	// Overrides colorForKind(kind) for this specific item — several text
	// roles (pin name vs pin number vs reference vs sheet filename) share
	// kind:'text' but need different base colors; paint() still substitutes
	// the highlight color over this when the item is selected.
	defaultColor?: string;
	draw: (renderer: Renderer, color: string) => void;
	/**
	 * kind:'symbol' only — the placed instance's Reference designator (e.g.
	 * "CBST1"), so a caller doing click-to-select/drag editing can identify
	 * which placement was hit without re-parsing the element tree itself.
	 */
	refDesignator?: string;
	/** kind:'label' — net/label text (global/local label name). */
	labelName?: string;
	/** kind:'label' — 'global' | 'local' | 'hierarchical'. */
	labelKind?: string;
	/** kind:'label' for symbol instance fields (Reference/Value/…) — the field's own stored name. */
	fieldName?: string;
	/** kind:'label' for symbol instance fields — the field's own origin to use for drag-start calculations. */
	fieldOrigin?: { x: number; y: number; rotation?: number };
	/**
	 * Overrides which id paint() checks against highlightedIds/
	 * netHighlightedIds — for a purely-visual duplicate item (e.g. a symbol
	 * field's `:text`-suffixed twin, kept hitTestable:false so it keeps
	 * rendering even when the Labels selection filter is off) that should
	 * still highlight in lockstep with its hit-testable sibling instead of
	 * always drawing in its default color and masking the sibling's own
	 * highlight underneath it. Defaults to `id`.
	 */
	highlightId?: string;
}

/** A hierarchical sheet reference — surfaced separately from the painted
 * `sheet` box/text items so a caller (the demo, the Angular viewer) can
 * implement "click a sheet to descend into it" navigation without having to
 * re-walk the parsed element tree or know @kicad-io's Sheetname/Sheetfile
 * property-name convention itself. `file` is the raw relative path as
 * stored in the file (e.g. "IMU.kicad_sch") — resolving it against the
 * CURRENT schematic's own directory is the caller's job, since this module
 * has no notion of where a file came from. */
export interface SchematicSheetRef {
	uuid: string;
	name: string;
	file: string;
	bbox: { x: number; y: number; w: number; h: number };
}

export interface SchematicScene {
	layersPresent: string[];
	layerBuckets: Map<string, SchPaintedItem[]>;
	hitTestItems: SchPaintedItem[];
	sheets: SchematicSheetRef[];
}

export interface SchLayerVisibilityState {
	visible: boolean;
	opacity: number;
}

/** Caller-supplied context the parsed schematic itself doesn't carry — the
 * file/sheet identity needed to fill in the drawing-sheet's FILENAME/
 * SHEETPATH/sheet-number text variables. This module has no notion of where
 * a file came from (same reasoning as SchematicSheetRef's `file` being a
 * raw, un-resolved relative path) — the caller (demo/Angular viewer) knows
 * the real path/breadcrumb, build() just needs to be told. */
export interface SchematicDocInfo {
	filename?: string;
	sheetPath?: string;
	sheetNumber?: number;
	sheetCount?: number;
	/** When false, skip Sheet/File/Title page frame. Defaults to true. */
	showDrawingSheet?: boolean;
	/**
	 * When true, keep the current camera zoom/pan after reload (e.g. local
	 * rewire on drag). Default false — first open still auto-fits.
	 */
	preserveView?: boolean;
}

export function defaultSchLayerState(layersPresent: string[]): Map<string, SchLayerVisibilityState> {
	const state = new Map<string, SchLayerVisibilityState>();
	for (const layer of layersPresent) {
		state.set(layer, { visible: true, opacity: 1 });
	}
	return state;
}

/**
 * Builds a SchematicScene from a parsed .kicad_sch — pure data, mirrors
 * BoardPainter's build()/paint() split for the same reason (toggling a
 * layer checkbox or reselecting shouldn't re-walk the parsed element tree).
 *
 * Scope for this first pass (explicitly NOT attempted yet, flagged rather
 * than silently skipped): multi-sheet hierarchy is not auto-loaded — a
 * `sheet` element renders as its own rectangle + name/file text + pins,
 * but the CHILD schematic file it references is not fetched/rendered
 * (this demo loads one file's text at a time, same scope boundary as the
 * PCB spike never resolving footprint library files). Pin graphic
 * "shape" decorations (inverted bubble, clock triangle, etc.) are not
 * implemented yet — every pin currently renders as a plain line. DeMorgan
 * alternate body style (style 2) is not selected — only style 1 (or
 * style-less single-representation symbols) is ever shown.
 */
export class SchematicPainter {
	/** Title-block/page vars (`${REVISION}`, `${TITLE}`, ...) for the CURRENT
	 *  build() call — populated by prepareTextVars() before any builder runs,
	 *  consumed via expandText(). Re-set (not merged) on every build() call,
	 *  so stale state from a previous document never leaks into the next. */
	protected textVars: Record<string, string> = {};
	/** Reference designator → {FIELDNAME: value} for every symbol instance
	 *  placed on the CURRENT sheet, keyed uppercase-field like the file's own
	 *  property names — powers `${REFDES:FIELD}` (e.g. `${R3:VALUE}`). Only
	 *  the current sheet is indexed (not the whole hierarchy) since build()
	 *  only ever sees one schematic's worth of AST at a time. */
	protected symbolFieldsByRef: Map<string, Record<string, string>> = new Map();

	/**
	 * Lightweight sheet-only extraction — parses just enough to list a
	 * schematic's direct child sheets, without building any paint items for
	 * wires/symbols/labels/etc. Building a full hierarchy tree means parsing
	 * and walking EVERY descendant schematic just to discover ITS children;
	 * running the full build() for each one (most of which are never
	 * displayed) would be pure waste.
	 */
	extractSheets(schematic: any): SchematicSheetRef[] {
		const root = schematic.rootElement;
		const sheets: SchematicSheetRef[] = [];
		if (getSheetClass()) {
			for (const sheet of root.findChildrenByClass(getSheetClass())) {
				const ref = this.extractSheetRef(sheet);
				if (ref) {
					sheets.push(ref);
				}
			}
		}
		return sheets;
	}

	/**
	 * Find a placed symbol instance by its Reference designator (e.g.
	 * "CBST1") in an already-parsed document — used by the editor to
	 * move/rotate a specific symbol (KicadRenderSession.moveSymbolByRef)
	 * without re-parsing the whole schematic text.
	 */
	findSymbolInstanceByReference(schematic: any, reference: string): any | null {
		const root = schematic.rootElement;
		if (!getSymbolClass()) {
			return null;
		}
		for (const instance of root.findChildrenByClass(getSymbolClass())) {
			if (typeof instance.getReference === 'function' && instance.getReference() === reference) {
				return instance;
			}
		}
		return null;
	}

	build(schematic: any, docInfo?: SchematicDocInfo): SchematicScene {
		const layerBuckets = new Map<string, SchPaintedItem[]>();
		const pushItem = (item: SchPaintedItem) => {
			const bucket = layerBuckets.get(item.layer);
			if (bucket) {
				bucket.push(item);
			}
			else {
				layerBuckets.set(item.layer, [item]);
			}
		};

		const root = schematic.rootElement;
		const schematicVersion = Number(root.findFirstChildByName?.('version')?.value) || 0;
		const libSymbols = getLibSymbolsClass() ? root.findFirstChildByClass(getLibSymbolsClass()) : null;
		this.prepareTextVars(root, docInfo);

		if (getRuleAreaClass()) {
			for (const ruleArea of root.findChildrenByClass(getRuleAreaClass())) {
				const item = this.buildRuleArea(ruleArea);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getWireClass()) {
			for (const wire of root.findChildrenByClass(getWireClass())) {
				const item = this.buildWireLike(wire, 'Wires', schColors.wire);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getBusClass()) {
			for (const bus of root.findChildrenByClass(getBusClass())) {
				const item = this.buildBus(bus);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getBusEntryClass()) {
			for (const entry of root.findChildrenByClass(getBusEntryClass())) {
				const item = this.buildBusEntry(entry);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getJunctionClass()) {
			for (const junction of root.findChildrenByClass(getJunctionClass())) {
				pushItem(this.buildJunction(junction));
			}
		}
		if (getNoConnectClass()) {
			for (const nc of root.findChildrenByClass(getNoConnectClass())) {
				pushItem(this.buildNoConnect(nc));
			}
		}
		if (getSymbolClass() && libSymbols) {
			for (const instance of root.findChildrenByClass(getSymbolClass())) {
				for (const item of this.buildSymbolInstance(instance, libSymbols)) {
					pushItem(item);
				}
			}
		}
		// Standalone schematic-level graphic items — drawn directly on the
		// sheet via eeschema's own "Add rectangle/circle/arc/line/text"
		// tools, NOT nested inside a symbol. Confirmed gap: these use the
		// SAME tag names (rectangle/circle/arc/polyline/text) as symbol
		// body graphics, so the already-registered classes work, but
		// nothing previously read them at the schematic ROOT — only
		// buildSymbolInstance()'s subunit-scoped search found them, so a
		// free-floating title text or dashed grouping rectangle rendered as
		// nothing at all. findChildrenByClass() is a SHALLOW (direct
		// children only) search (confirmed by reading KicadElement's own
		// implementation), so this can't double-count a rect/text that's
		// actually nested several levels down inside lib_symbols.
		if (getRectClass()) {
			for (const rect of root.findChildrenByClass(getRectClass())) {
				pushItem(this.buildSchRect(rect));
			}
		}
		if (getSymCircleClass()) {
			for (const circle of root.findChildrenByClass(getSymCircleClass())) {
				pushItem(this.buildSchCircle(circle));
			}
		}
		if (getSymArcClass()) {
			for (const arc of root.findChildrenByClass(getSymArcClass())) {
				const item = this.buildSchArc(arc);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getPolylineClass()) {
			for (const poly of root.findChildrenByClass(getPolylineClass())) {
				pushItem(this.buildSchPolyline(poly));
			}
		}
		if (getBezierClass()) {
			for (const bezier of root.findChildrenByClass(getBezierClass())) {
				const item = this.buildSchBezier(bezier);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getImageClass()) {
			for (const image of root.findChildrenByClass(getImageClass())) {
				const item = this.buildSchImage(image, schematicVersion);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getTextClass()) {
			for (const text of root.findChildrenByClass(getTextClass())) {
				const item = this.buildSchText(text);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getTextBoxClass()) {
			for (const textBox of root.findChildrenByClass(getTextBoxClass())) {
				const item = this.buildSchTextBox(textBox);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getGlobalLabelClass()) {
			for (const label of root.findChildrenByClass(getGlobalLabelClass())) {
				for (const item of this.buildGlobalLabel(label)) {
					pushItem(item);
				}
			}
		}
		if (getHierLabelClass()) {
			for (const label of root.findChildrenByClass(getHierLabelClass())) {
				for (const item of this.buildHierLabel(label)) {
					pushItem(item);
				}
			}
		}
		// Plain local labels ("net name" labels) have no registered @kicad-io
		// class (confirmed gap) — read generically by tag name instead.
		for (const label of root.findChildrenByName('label')) {
			const item = this.buildLocalLabel(label);
			if (item) {
				pushItem(item);
			}
		}
		if (getNetclassFlagClass()) {
			for (const flag of root.findChildrenByClass(getNetclassFlagClass())) {
				for (const item of this.buildNetclassFlag(flag)) {
					pushItem(item);
				}
			}
		}
		if (getTableClass()) {
			for (const table of root.findChildrenByClass(getTableClass())) {
				for (const item of this.buildTable(table)) {
					pushItem(item);
				}
			}
		}
		const sheets: SchematicSheetRef[] = [];
		if (getSheetClass()) {
			for (const sheet of root.findChildrenByClass(getSheetClass())) {
				for (const item of this.buildSheet(sheet)) {
					pushItem(item);
				}
				const ref = this.extractSheetRef(sheet);
				if (ref) {
					sheets.push(ref);
				}
			}
		}

		if (docInfo?.showDrawingSheet !== false) {
			for (const item of this.buildDrawingSheet(root, docInfo)) {
				pushItem(item);
			}
		}

		// Must run last — reads the fully-populated Wires/Pins/Junctions/
		// NoConnects/Labels buckets to find point coincidences.
		for (const item of this.buildDanglingFlags(layerBuckets)) {
			pushItem(item);
		}

		const layersPresent = schematicLayerOrder.filter(l => layerBuckets.has(l));
		const hitTestItems: SchPaintedItem[] = [];
		for (const layer of layersPresent) {
			for (const item of layerBuckets.get(layer)!) {
				if (item.hitTestable) {
					hitTestItems.push(item);
				}
			}
		}

		return { layersPresent, layerBuckets, hitTestItems, sheets };
	}

	/** Pulls the (Sheetname, Sheetfile) pair + box bbox out of a `sheet`
	 * element for hierarchy navigation — separate from buildSheet()'s own
	 * property loop since that one is building PAINT items (with visibility/
	 * hidden-property filtering) and this needs the raw Sheetfile value
	 * regardless of whether it's set to render. */
	protected extractSheetRef(sheet: any): SchematicSheetRef | null {
		const atEl = getAtClass() ? sheet.findFirstChildByClass(getAtClass()) : null;
		const sizeEl = getSizeClass() ? sheet.findFirstChildByClass(getSizeClass()) : null;
		const x = atEl?.x ?? 0, y = atEl?.y ?? 0;
		const w = sizeEl?.width ?? 10, h = sizeEl?.height ?? 10;
		const uuid = sheet.getUuid() ?? `sheet:${ x },${ y }`;

		let name = '';
		let file = '';
		if (typeof sheet.getProperties === 'function') {
			for (const prop of sheet.getProperties()) {
				if (prop.propertyName === 'Sheetname') {
					name = prop.propertyValue ?? '';
				}
				else if (prop.propertyName === 'Sheetfile') {
					file = prop.propertyValue ?? '';
				}
			}
		}
		if (!file) {
			return null;
		}
		return { uuid, name: name || file, file, bbox: { x, y, w, h } };
	}

	/**
	 * Populates `this.textVars`/`this.symbolFieldsByRef` for the document
	 * currently being built() — MUST run before any text-building method
	 * that calls expandText(), including buildDrawingSheet() itself (which
	 * used to compute its own local copy of the title-block vars; this is
	 * that same logic, just hoisted so plain text/text-box/symbol-field text
	 * elsewhere on the sheet can resolve `${TITLE}`/`${REVISION}`/etc too,
	 * not only the title-block template).
	 */
	protected prepareTextVars(root: any, docInfo?: SchematicDocInfo): void {
		const paperEl = typeof root.findFirstChildByName === 'function' ? root.findFirstChildByName('paper') : null;
		const paperName = (paperEl?.attributes?.[0]?.value as string) ?? 'A4';
		const titleBlockEl = typeof root.findFirstChildByName === 'function' ?
			root.findFirstChildByName('title_block') : null;
		this.textVars = {
			PAPER: paperName,
			KICAD_VERSION: 'BOMManager2',
			'#': String(docInfo?.sheetNumber ?? 1),
			'##': String(docInfo?.sheetCount ?? 1),
			SHEETPATH: docInfo?.sheetPath ?? '/',
			FILENAME: docInfo?.filename ?? '',
			ISSUE_DATE: typeof titleBlockEl?.getDate === 'function' ? titleBlockEl.getDate() : '',
			REVISION: typeof titleBlockEl?.getRev === 'function' ? titleBlockEl.getRev() : '',
			TITLE: typeof titleBlockEl?.getTitle === 'function' ? titleBlockEl.getTitle() : '',
			COMPANY: typeof titleBlockEl?.getCompany === 'function' ? titleBlockEl.getCompany() : '',
			COMMENT1: typeof titleBlockEl?.getComment === 'function' ? titleBlockEl.getComment(1) : '',
			COMMENT2: typeof titleBlockEl?.getComment === 'function' ? titleBlockEl.getComment(2) : '',
			COMMENT3: typeof titleBlockEl?.getComment === 'function' ? titleBlockEl.getComment(3) : '',
			COMMENT4: typeof titleBlockEl?.getComment === 'function' ? titleBlockEl.getComment(4) : ''
		};

		this.symbolFieldsByRef = new Map();
		if (getSymbolClass() && typeof root.findChildrenByClass === 'function') {
			for (const instance of root.findChildrenByClass(getSymbolClass())) {
				const ref = typeof instance.getReference === 'function' ? String(instance.getReference() ?? '').trim() :
					'';
				if (!ref || typeof instance.getProperties !== 'function') {
					continue;
				}
				const fields: Record<string, string> = {};
				for (const prop of instance.getProperties()) {
					if (prop.propertyName && prop.propertyValue != null) {
						fields[String(prop.propertyName).toUpperCase()] = String(prop.propertyValue);
					}
				}
				this.symbolFieldsByRef.set(ref, fields);
			}
		}
	}

	/** `${VAR}`/`${REFDES:FIELD}` expansion against the vars prepareTextVars()
	 *  just built for this document — the one shared entry point every
	 *  builder that wants variable expansion should call, so the resolver
	 *  context (and its scope decisions — see expandText's call sites) stays
	 *  in one place. Deliberately NOT applied to label names, pin names, or
	 *  symbol body graphic text (library-fixed/identity text, not free-form
	 *  annotation) — see buildSchText/buildSchTextBox/the symbol field-text
	 *  loop for where it IS applied. */
	protected expandText(raw: string, extraVars?: Record<string, string>): string {
		const vars = extraVars ? { ...this.textVars, ...extraVars } : this.textVars;
		return expandTextVars(raw, vars, this.symbolFieldsByRef);
	}

	/**
	 * The page frame / title block ("drawing sheet") — ports kicanvas's
	 * DrawingSheetPainter (viewers/drawing-sheet/painter.ts) against KiCad's
	 * BUILT-IN default layout (DEFAULT_WKS_ITEMS — see DrawingSheet.ts for
	 * why this doesn't parse a real .kicad_wks file). Confirmed gap: this
	 * renderer drew schematic content on an otherwise bare canvas — no page
	 * border, corner ruler ticks, or title block (Sheet/File/Title/Size/
	 * Date/Rev/KiCad-version) the way real KiCad and kicanvas both do.
	 */
	protected buildDrawingSheet(root: any, docInfo?: SchematicDocInfo): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];

		const paperEl = typeof root.findFirstChildByName === 'function' ? root.findFirstChildByName('paper') : null;
		const paperName = (paperEl?.attributes?.[0]?.value as string) ?? 'A4';
		const paperSize = wksPaperSizes[paperName] ?? wksPaperSizes['A4']!;
		const sheetSize = new Vec2(paperSize[0], paperSize[1]);

		const setup = defaultWksSetup;
		let uid = 0;

		for (const wksItem of defaultWksItems) {
			if (wksItem.kind === 'line') {
				for (let i = 0; i < wksItem.repeat; i++) {
					const offset = new Vec2(wksItem.incrx * i, wksItem.incry * i);
					const start = resolveWksAnchor(sheetSize, setup, wksItem.startAnchor, wksItem.start.add(offset));
					const end = resolveWksAnchor(sheetSize, setup, wksItem.endAnchor, wksItem.end.add(offset));
					// Real KiCad constrains EVERY line iteration (including the
					// first) to the margin box, not just repeats — confirmed via
					// kicanvas's LinePainter, which never passes constrain=false.
					if (!withinWksMargin(sheetSize, setup, start) || !withinWksMargin(sheetSize, setup, end)) {
						break;
					}
					const id = `wks-line:${ uid++ }`;
					const shape: PaintedShape = {
						type: 'polygon',
						points: [{ x: start.x, y: start.y }, { x: end.x, y: end.y }]
					};
					items.push({
						id,
						layer: 'Frame',
						kind: 'frame',
						shape,
						bbox: shapeToBBox(shape),
						hitTestable: false,
						element: null,
						defaultColor: schColors.frame,
						draw: (renderer, color) => renderer.line(
							[start, end], { strokeColor: color, strokeWidth: setup.lineWidthMm })
					});
				}
			}
			else if (wksItem.kind === 'rect') {
				for (let i = 0; i < wksItem.repeat; i++) {
					const offset = new Vec2(wksItem.incrx * i, wksItem.incry * i);
					const start = resolveWksAnchor(sheetSize, setup, wksItem.startAnchor, wksItem.start.add(offset));
					const end = resolveWksAnchor(sheetSize, setup, wksItem.endAnchor, wksItem.end.add(offset));
					// Rects only constrain REPEATS (i>0) — the first rect always
					// draws even if its corners sit outside the margin box (the
					// page-outline and title-block rects both legitimately do).
					if (i > 0 && (!withinWksMargin(sheetSize, setup, start) || !withinWksMargin(
						sheetSize, setup, end))) {
						break;
					}
					const corners = [
						new Vec2(start.x, start.y), new Vec2(end.x, start.y),
						new Vec2(end.x, end.y), new Vec2(start.x, end.y)
					];
					const id = `wks-rect:${ uid++ }`;
					const shape: PaintedShape = { type: 'polygon', points: corners.map(p => ({ x: p.x, y: p.y })) };
					items.push({
						id,
						layer: 'Frame',
						kind: 'frame',
						shape,
						bbox: shapeToBBox(shape),
						hitTestable: false,
						element: null,
						defaultColor: schColors.frame,
						draw: (renderer, color) => drawStrokeOutline(
							renderer, [...corners, corners[0]!], setup.lineWidthMm, 'solid', color)
					});
				}
			}
			else {
				for (let i = 0; i < wksItem.repeat; i++) {
					const offset = new Vec2(wksItem.incrx * i, wksItem.incry * i);
					const pos = resolveWksAnchor(sheetSize, setup, wksItem.anchor, wksItem.pos.add(offset));
					if (!withinWksMargin(sheetSize, setup, pos)) {
						break;
					}
					let raw = wksItem.text;
					// Ruler labels ("1", "A", ...) increment their single
					// character per repeat rather than re-reading the same
					// literal text — ports TbTextPainter's incrlabel handling.
					if (wksItem.incrlabel && raw.length === 1) {
						const incr = wksItem.incrlabel * i;
						const code = raw.charCodeAt(0);
						raw = (code >= 48 && code <= 57)
							? String(incr + code - 48)
							: String.fromCharCode(code + incr);
					}
					const resolved = this.expandText(raw);
					if (!resolved) {
						continue;
					}
					const anchor = {
						x: wksItem.hAlign === 'left' ? 0 : wksItem.hAlign === 'right' ? 1 : 0.5,
						y: wksItem.vAlign === 'top' ? 0 : wksItem.vAlign === 'bottom' ? 1 : 0.5
					};
					// Real KiCad's stroke font has no separate bold glyph set —
					// "bold" is purely a thicker stroke (ports EDAText's
					// get_bold_thickness/get_normal_thickness: size/5 for bold,
					// size/8 for normal, both against the nominal font size, not
					// the rendered string width).
					const strokeWidthMm = wksItem.bold ? wksItem.sizeMm / 5 : wksItem.sizeMm / 8;
					const geometry = computeStrokeTextGeometry(
						resolved, pos, wksItem.sizeMm, 0, false, strokeWidthMm, anchor);
					const id = `wks-text:${ uid++ }`;
					const bbox = { x: pos.x - 10, y: pos.y - 2, w: 20, h: 4 };
					items.push({
						id,
						layer: 'Frame',
						kind: 'frame',
						shape: { type: 'rect', ...bbox },
						bbox,
						hitTestable: false,
						element: null,
						defaultColor: schColors.frame,
						draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
					});
				}
			}
		}

		return items;
	}

	paint(
		scene: SchematicScene,
		renderer: Renderer,
		layerState: Map<string, SchLayerVisibilityState>,
		highlightedIds: Set<string> = new Set(),
		netHighlightedIds: Set<string> = new Set(),
		/** World-space visible rect — when given, items whose bbox falls
		 *  entirely outside it are skipped. Omit to draw everything (e.g. the
		 *  WebGL tessellation pass — see BoardPainter.paint's identical param). */
		viewBBox?: { x: number; y: number; w: number; h: number }
	): void {
		for (const layer of scene.layersPresent) {
			const state = layerState.get(layer);
			if (!state || !state.visible) {
				continue;
			}
			renderer.setOpacity?.(state.opacity);
			renderer.beginBatch?.();
			for (const item of scene.layerBuckets.get(layer)!) {
				if (viewBBox && !bboxesIntersect(item.bbox, viewBBox)) {
					continue;
				}
				let color: string;
				const highlightId = item.highlightId ?? item.id;
				if (highlightedIds.has(highlightId)) {
					color = '#ffcc00';
				}
				else if (netHighlightedIds.has(highlightId)) {
					color = '#ff44ff';
				}
				else {
					color = item.defaultColor ?? colorForKind(item.kind);
				}
				item.draw(renderer, color);
			}
			renderer.endBatch?.();
		}
	}

	// ---- Wires / buses / junctions / no-connects ----

	protected buildWireLike(wire: any, layer: string, color: string): SchPaintedItem | null {
		const points: { x: number; y: number }[] = typeof wire.getPoints === 'function' ? wire.getPoints() : [];
		if (points.length < 2) {
			return null;
		}
		const [start, end] = points;
		// Wires and buses carry the same `(stroke ...)` object as the other
		// schematic graphics.  Previously this path ignored it and always sent
		// one solid line to the renderer, which made valid `dash`, `dot`,
		// `dash_dot`, and `dash_dot_dot` wires indistinguishable from solid ones.
		// Keep the effective width in the painted shape too, so hit testing and
		// the visible stroke agree (a zero-width KiCad stroke means the default
		// pen width, not an invisible line).
		const stroke = typeof wire.getStroke === 'function'
			? wire.getStroke()
			: { width: 0.15, type: 'solid' as KicadStrokeLineType };
		const width = stroke.width || 0.15;
		const lineType = (stroke.type ?? 'default') as KicadStrokeLineType;
		const shape: PaintedShape = { type: 'segment', x1: start.x, y1: start.y, x2: end.x, y2: end.y, width };
		const id = wire.getUuid() ?? `wire:${ start.x },${ start.y }-${ end.x },${ end.y }`;
		return {
			id, layer, kind: 'wire', shape, bbox: shapeToBBox(shape), hitTestable: true, element: wire,
			defaultColor: wire.getStrokeColorOverride?.() ?? color,
			draw: (renderer, drawColor) => {
				drawStrokeOutline(
					renderer, [new Vec2(start.x, start.y), new Vec2(end.x, end.y)], width, lineType, drawColor);
			}
		};
	}

	protected buildBus(bus: any): SchPaintedItem | null {
		const item = this.buildWireLike(bus, 'Wires', schColors.bus);
		if (!item) {
			return null;
		}
		// Buses draw thicker than ordinary wires.  Preserve their stroke type
		// while applying the bus-specific default width.
		const stroke = typeof bus.getStroke === 'function'
			? bus.getStroke()
			: { width: 0.3, type: 'solid' as KicadStrokeLineType };
		const width = stroke.width || 0.3;
		const lineType = (stroke.type ?? 'default') as KicadStrokeLineType;
		const s = item.shape as { x1: number; y1: number; x2: number; y2: number };
		const shape: PaintedShape = { ...item.shape, width } as PaintedShape;
		return {
			...item, shape, kind: 'bus', bbox: shapeToBBox(shape), draw: (renderer, color) => {
				drawStrokeOutline(renderer, [new Vec2(s.x1, s.y1), new Vec2(s.x2, s.y2)], width, lineType, color);
			}
		};
	}

	protected buildBusEntry(entry: any): SchPaintedItem | null {
		const origin = typeof entry.getOrigin === 'function' ? entry.getOrigin() : null;
		const size = typeof entry.getSize === 'function' ? entry.getSize() : null;
		if (!origin || !size) {
			return null;
		}
		const x1 = origin.x, y1 = origin.y;
		const x2 = origin.x + size.width, y2 = origin.y + size.height;
		const stroke = typeof entry.getStroke === 'function'
			? entry.getStroke()
			: { width: 0.15, type: 'solid' as KicadStrokeLineType };
		const width = stroke.width || 0.15;
		const lineType = (stroke.type ?? 'default') as KicadStrokeLineType;
		const id = entry.getUuid?.() ?? `bus_entry:${ x1 },${ y1 }`;
		const shape: PaintedShape = { type: 'segment', x1, y1, x2, y2, width };
		return {
			id, layer: 'Wires', kind: 'wire', shape, bbox: shapeToBBox(shape), hitTestable: true, element: entry,
			defaultColor: entry.getStrokeColorOverride?.() ?? colorForKind('wire'),
			draw: (renderer, color) => {
				drawStrokeOutline(renderer, [new Vec2(x1, y1), new Vec2(x2, y2)], width, lineType, color);
			}
		};
	}

	protected buildJunction(junction: any): SchPaintedItem {
		const origin = junction.getOrigin();
		// A junction's own (diameter …) of 0 means "use the default size",
		// same width:0 convention used everywhere else in this codebase —
		// matches real KiCad's own JUNCTION_DIAMETER_DEFAULT fallback.
		const storedDiameter = typeof junction.getDiameter === 'function' ? junction.getDiameter() : 0;
		const radius = storedDiameter > 0 ? storedDiameter / 2 : 0.4;
		const shape: PaintedShape = { type: 'circle', cx: origin.x, cy: origin.y, r: radius };
		const id = junction.getUuid() ?? `junction:${ origin.x },${ origin.y }`;
		return {
			id,
			layer: 'Junctions',
			kind: 'junction',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: true,
			element: junction,
			defaultColor: junction.getColorOverride?.() ?? undefined,
			draw: (renderer, color) => {
				renderer.circle(new Vec2(origin.x, origin.y), radius, { fillColor: color });
			}
		};
	}

	protected buildNoConnect(nc: any): SchPaintedItem {
		const origin = nc.getOrigin();
		const half = 0.9;
		const shape: PaintedShape = { type: 'rect', x: origin.x - half, y: origin.y - half, w: half * 2, h: half * 2 };
		const id = nc.getUuid() ?? `nc:${ origin.x },${ origin.y }`;
		return {
			id, layer: 'NoConnects', kind: 'no-connect', shape, bbox: shape, hitTestable: true, element: nc,
			draw: (renderer, color) => {
				const width = 0.3;
				renderer.line(
					[new Vec2(origin.x - half, origin.y - half), new Vec2(origin.x + half, origin.y + half)],
					{ strokeColor: color, strokeWidth: width }
				);
				renderer.line(
					[new Vec2(origin.x - half, origin.y + half), new Vec2(origin.x + half, origin.y - half)],
					{ strokeColor: color, strokeWidth: width }
				);
			}
		};
	}

	// ---- Standalone schematic-level graphic items ----
	//
	// A `rectangle`/`circle`/`arc`/`polyline`/`text` at the SCHEMATIC ROOT
	// (not nested inside a lib_symbol) is a free-floating annotation drawn
	// directly on the sheet — e.g. a title text or a dashed rectangle
	// grouping a functional block. These use the exact same @kicad-io
	// classes as symbol body graphics (same tag names), but unlike those,
	// root-level coordinates are ALREADY in world/sheet space — no
	// flippedTransform (the symbol-library Y-flip + instance matrix) is
	// needed or correct here, same as wires/junctions/labels are handled
	// directly without it.

	protected buildSchRect(rect: any): SchPaintedItem {
		const { start, end } = rect.getStartEnd();
		const corners = [
			new Vec2(start.x, start.y), new Vec2(end.x, start.y),
			new Vec2(end.x, end.y), new Vec2(start.x, end.y)
		];
		const { width, type: lineType } = typeof rect.getStroke === 'function' ? rect.getStroke() :
			{ width: 0.15, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof rect.getFill === 'function' ? rect.getFill() : 'none';
		const id = rect.getUuid() ?? `sch-rect:${ start.x },${ start.y }`;
		// filled/closed/strokeWidth drive shapeContainsPoint's edge-only hit
		// test for an unfilled rect (see PaintedShape.ts) — without this an
		// unfilled "group these parts" annotation box permanently steals
		// clicks from anything visually inside it, which is exactly the bug
		// this fixes (real KiCad hit-tests only the 4 edges for an unfilled
		// rectangle too — EDA_SHAPE::hitTest's SHAPE_T::RECTANGLE case).
		const shape: PaintedShape = {
			type: 'polygon', points: corners.map(p => ({ x: p.x, y: p.y })),
			filled: fillType !== 'none', closed: true, strokeWidth: width
		};
		return {
			id,
			layer: 'Graphics',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: true,
			element: rect,
			defaultColor: rect.getStrokeColorOverride?.() ?? schColors.graphic,
			draw: (renderer, color) => {
				const fillColor = symbolFillColor(fillType, color, rect.getFillColorOverride?.() ?? undefined);
				if (fillColor) {
					renderer.polygon(corners, { fillColor });
				}
				drawStrokeOutline(renderer, [...corners, corners[0]!], width, lineType, color);
			}
		};
	}

	protected buildSchCircle(circle: any): SchPaintedItem {
		const center = circle.getCenter();
		const radius = typeof circle.getRadius === 'function' ? circle.getRadius() : 0;
		const { width, type: lineType } = typeof circle.getStroke === 'function' ? circle.getStroke() :
			{ width: 0.15, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof circle.getFill === 'function' ? circle.getFill() : 'none';
		const id = circle.getUuid() ?? `sch-circle:${ center.x },${ center.y }`;
		// Standalone schematic circles are annotation outlines.  Keep their
		// picker permeable even when a file omits/normalizes the fill child;
		// otherwise the enclosing disk steals clicks from objects inside it.
		const shape: PaintedShape = {
			type: 'circle', cx: center.x, cy: center.y, r: radius, filled: false, strokeWidth: width
		};
		return {
			id,
			layer: 'Graphics',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: true,
			element: circle,
			defaultColor: circle.getStrokeColorOverride?.() ?? schColors.graphic,
			draw: (renderer, color) => {
				const worldCenter = new Vec2(center.x, center.y);
				const fillColor = symbolFillColor(fillType, color, circle.getFillColorOverride?.() ?? undefined);
				if (fillColor) {
					renderer.circle(worldCenter, radius, { fillColor });
				}
				if (lineType === 'solid' || lineType === 'default') {
					renderer.circle(worldCenter, radius, { strokeColor: color, strokeWidth: width || 0.1 });
				}
				else {
					drawStrokeOutline(renderer, circleToRing(worldCenter, radius), width, lineType, color);
				}
			}
		};
	}

	protected buildSchArc(arc: any): SchPaintedItem | null {
		if (typeof arc.getArcCenterRadiusAngles !== 'function') {
			return null;
		}
		let local: { centerX: number; centerY: number; radius: number; startAngle: number; endAngle: number };
		try {
			local = arc.getArcCenterRadiusAngles(false);
		}
		catch {
			return null;
		}
		const { width, type: lineType } = typeof arc.getStroke === 'function' ? arc.getStroke() :
			{ width: 0.15, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof arc.getFill === 'function' ? arc.getFill() : 'none';
		const id = arc.getUuid() ?? `sch-arc:${ local.centerX },${ local.centerY }`;
		// An arc must not use its enclosing circle as the hit shape: that makes
		// every point inside the arc selectable and prevents selecting graphics
		// placed underneath it.  Use the sampled arc outline so the shared
		// unfilled-shape hit test only accepts the visible edge.
		const hitPoints = arcToPolyline(
			new Vec2(local.centerX, local.centerY), local.radius, local.startAngle, local.endAngle)
			.map(point => ({ x: point.x, y: point.y }));
		const shape: PaintedShape = {
			type: 'polygon', points: hitPoints, filled: fillType !== 'none', closed: false, strokeWidth: width
		};
		return {
			id,
			layer: 'Graphics',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: true,
			element: arc,
			defaultColor: arc.getStrokeColorOverride?.() ?? schColors.graphic,
			draw: (renderer, color) => {
				const worldCenter = new Vec2(local.centerX, local.centerY);
				const fillColor = symbolFillColor(fillType, color, arc.getFillColorOverride?.() ?? undefined);
				if (fillColor) {
					// A filled arc is a "pie slice" — the sampled arc points
					// plus the center, closed into a polygon (ports kicanvas's
					// MathArc.to_polygon()). Solder-jumper-style symbols rely
					// on this to render a solid half-moon, not just an outline.
					renderer.polygon(
						[...arcToPolyline(worldCenter, local.radius, local.startAngle, local.endAngle), worldCenter],
						{ fillColor }
					);
				}
				if (lineType === 'solid' || lineType === 'default') {
					renderer.arc(
						worldCenter, local.radius, local.startAngle, local.endAngle,
						{ strokeColor: color, strokeWidth: width || 0.1 }
					);
				}
				else {
					drawStrokeOutline(
						renderer, arcToPolyline(worldCenter, local.radius, local.startAngle, local.endAngle), width,
						lineType, color
					);
				}
			}
		};
	}

	/**
	 * `forceClosed` is for callers whose shape is closed BY TYPE regardless
	 * of whether the file's own point list happens to repeat the first
	 * point (rule areas — SHAPE_T::POLY in real KiCad, always a closed
	 * ring) — a generic standalone polyline (the ordinary case, no
	 * `forceClosed`) can legitimately be open (an arrow, a signal-path
	 * annotation, …), so that case still only closes when the file's own
	 * points already do. Only affects the STROKE pass — `worldPoints`
	 * (used for the fill/hit-test shape) is never mutated, since a repeated
	 * point isn't needed for either of those to be "closed" geometrically.
	 */
	protected buildSchPolyline(poly: any, forceClosed = false): SchPaintedItem {
		const points: { x: number; y: number }[] = typeof poly.getPoints === 'function' ? poly.getPoints() : [];
		const worldPoints = points.map(p => new Vec2(p.x, p.y));
		const { width, type: lineType } = typeof poly.getStroke === 'function' ? poly.getStroke() :
			{ width: 0.15, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof poly.getFill === 'function' ? poly.getFill() : 'none';
		const first = points[0], last = points[points.length - 1];
		const id = poly.getUuid() ?? `sch-poly:${ first?.x },${ first?.y }`;
		const alreadyClosed = points.length > 2 && first && last && first.x === last.x && first.y === last.y;
		const closed = forceClosed || alreadyClosed;
		const strokePoints = (forceClosed && !alreadyClosed && worldPoints.length > 1)
			? [...worldPoints, worldPoints[0]!]
			: worldPoints;
		// filled/closed/strokeWidth drive shapeContainsPoint's edge-only hit
		// test for an unfilled polyline (see PaintedShape.ts and buildSchRect's
		// matching comment) — `closed` reuses the SAME value the fill/stroke
		// decision above already uses, so a shape that's visually treated as
		// closed also gets its wrap-around edge included in the hit-test.
		const shape: PaintedShape = {
			type: 'polygon', points: worldPoints.map(p => ({ x: p.x, y: p.y })),
			filled: fillType !== 'none', closed, strokeWidth: width
		};
		return {
			id,
			layer: 'Graphics',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: true,
			element: poly,
			defaultColor: poly.getStrokeColorOverride?.() ?? schColors.graphic,
			draw: (renderer, color) => {
				const fillColor = closed ?
					symbolFillColor(fillType, color, poly.getFillColorOverride?.() ?? undefined) : undefined;
				if (fillColor) {
					renderer.polygon(worldPoints, { fillColor });
				}
				drawStrokeOutline(renderer, strokePoints, width, lineType, color);
			}
		};
	}

	/** KiCad stores a cubic Bézier as start, control-1, control-2, end. The
	 * renderer has polyline primitives only, so flatten it adaptively before
	 * painting. The 0.05 mm flatness target keeps curves smooth without
	 * burdening ordinary schematic decorations with excess segments. */
	protected buildSchBezier(bezier: any): SchPaintedItem | null {
		const points: { x: number; y: number }[] = typeof bezier.getPoints === 'function' ? bezier.getPoints() : [];
		if (points.length !== 4) {
			return null;
		}
		const curve = cubicBezierToPolyline(
			new Vec2(points[0]!.x, points[0]!.y), new Vec2(points[1]!.x, points[1]!.y),
			new Vec2(points[2]!.x, points[2]!.y), new Vec2(points[3]!.x, points[3]!.y)
		);
		const { width, type: lineType } = typeof bezier.getStroke === 'function' ? bezier.getStroke() :
			{ width: 0.15, type: 'solid' as KicadStrokeLineType };
		const drawWidth = width || 0.15;
		const id = bezier.getUuid() ?? `sch-bezier:${ points[0]!.x },${ points[0]!.y }`;
		const shape: PaintedShape = {
			type: 'polygon', points: curve.map(p => ({ x: p.x, y: p.y })),
			filled: false, closed: false, strokeWidth: drawWidth
		};
		return {
			id,
			layer: 'Graphics',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: true,
			element: bezier,
			defaultColor: bezier.getStrokeColorOverride?.() ?? schColors.graphic,
			draw: (renderer, color) => drawStrokeOutline(renderer, curve, drawWidth, lineType, color)
		};
	}

	/** KiCad embedded images use their encoded resolution (or the 300-PPI
	 * default), then multiply it by `(scale ...)`. Their `(at ...)` point is
	 * the image center. */
	protected buildSchImage(image: any, schematicVersion: number): SchPaintedItem | null {
		const data: string | undefined = typeof image.getData === 'function' ? image.getData() : undefined;
		if (!data) {
			return null;
		}
		const info = embeddedImageInfo(data);
		if (!info) {
			return null;
		}
		const origin = typeof image.getOrigin === 'function' ? image.getOrigin() : { x: 0, y: 0 };
		const scale = typeof image.getScale === 'function' ? image.getScale() : 1;
		// Mirror KiCad's three image-scale eras. Before 20230121 image scale
		// was authored for a fixed 300 PPI. From then until the 20260623 pHYs
		// precision fix it used truncated pixels/cm; newer files use the full
		// encoded resolution. KiCad compensates stored scales while loading;
		// selecting the matching effective PPI produces the same final bounds.
		const effectivePpi = schematicVersion > 0 && schematicVersion <= 20230121
			? 300
			: schematicVersion > 0 && schematicVersion < 20260623
				? info.legacyPpi
				: info.ppi;
		const pixelSizeMm = 25.4 / effectivePpi;
		const width = info.width * pixelSizeMm * (Number.isFinite(scale) ? scale : 1);
		const height = info.height * pixelSizeMm * (Number.isFinite(scale) ? scale : 1);
		if (!(width > 0) || !(height > 0)) {
			return null;
		}
		const x = origin.x - width / 2;
		const y = origin.y - height / 2;
		const id = image.getUuid?.() ?? `sch-image:${ origin.x },${ origin.y }`;
		// Images are opaque to the picker even when their decoded pixels contain
		// transparency: KiCad selects the image by its full rectangular extent.
		const shape: PaintedShape = { type: 'rect', x, y, w: width, h: height, filled: true };
		const embedded: EmbeddedImage = { data, mimeType: info.mimeType };
		return {
			id, layer: 'Images', kind: 'image', shape, bbox: shapeToBBox(shape), hitTestable: true, element: image,
			draw: renderer => renderer.image(embedded, new Vec2(x, y), width, height)
		};
	}

	/**
	 * Rule areas (KiCad 10, multichannel design matching / netclass-by-
	 * region annotation) — confirmed in the user's local KiCad checkout
	 * (eeschema/sch_rule_area.h/.cpp): SCH_RULE_AREA extends SCH_SHAPE
	 * (SHAPE_T::POLY) and is drawn through the EXACT same generic shape-draw
	 * path as any other polyline (sch_painter.cpp's `case SCH_RULE_AREA_T:
	 * draw(static_cast<const SCH_SHAPE*>(aItem), ...)`), just on its own
	 * LAYER_RULE_AREAS color. No separate rendering logic to port — this
	 * delegates straight to buildSchPolyline() (which already handles
	 * fill/dash-stroke correctly, including the width:0 dash fix above) and
	 * only overrides layer/color/id/element. The DNP/exclude-from-sim/BOM/
	 * board flags and the dynamic "which directive labels are attached to
	 * this border" relationship (computed geometrically by real KiCad, not
	 * stored in the file) don't affect the visual outline itself, so aren't
	 * modeled here — this is deliberately outline-only, matching what
	 * "since rule areas aren't rendering" actually needed.
	 */
	protected buildRuleArea(ruleArea: any): SchPaintedItem | null {
		const polyline = typeof ruleArea.getPolyline === 'function' ? ruleArea.getPolyline() : null;
		if (!polyline) {
			return null;
		}
		const base = this.buildSchPolyline(polyline, true);
		const id = polyline.getUuid() ?? base.id;
		// Real KiCad's SCH_RULE_AREA::IsFilledForHitTesting() always returns
		// false regardless of the shape's own fill state (confirmed in the
		// user's local checkout) — a rule area is a permeable region marker,
		// never meant to be solid-clickable even in some hypothetical filled
		// state. Force it explicitly rather than relying on rule areas
		// happening to always be unfilled in every file seen so far.
		const shape: PaintedShape = base.shape.type === 'polygon' ? { ...base.shape, filled: false } : base.shape;
		return {
			// getStrokeColorOverride() reads from `polyline` (the nested child
			// that actually carries the (stroke …) data — base.defaultColor
			// already resolved this the same way), not `ruleArea` itself, so
			// a user-customized border color is respected same as any other
			// shape; still defaults to the distinctive theme red otherwise.
			...base,
			id,
			shape,
			layer: 'RuleAreas',
			defaultColor: polyline.getStrokeColorOverride?.() ?? schColors.ruleArea,
			element: ruleArea
		};
	}

	protected buildSchText(text: any): SchPaintedItem | null {
		const raw: string = text.value ?? '';
		if (!raw) {
			return null;
		}
		const value = this.expandText(raw);
		const origin = text.getOrigin();
		const rotation = origin.rotation ?? 0;
		const worldPos = new Vec2(origin.x, origin.y);
		const { size: textSize, thickness, italic } = readElementFontMetrics(text);
		// text_angle normalizes to 0/90 only, anchor comes straight from
		// the file's own justify unmodified — same real KiCad convention
		// already established for labels (see the block comment above
		// buildLocalLabel()).
		const textAngle = (rotation === 90 || rotation === 270) ? 90 : 0;
		const anchor = typeof text.getAnchorPoint === 'function' ? text.getAnchorPoint() : { x: 0.5, y: 0.5 };
		const geometry = computeStrokeTextGeometry(
			value, worldPos, textSize, textAngle, false, thickness, anchor, italic);
		const id = text.getUuid() ?? `sch-text:${ origin.x },${ origin.y }`;
		const bbox = getStrokeTextBounds(geometry);
		return {
			id, layer: 'Text', kind: 'text', shape: { type: 'rect', ...bbox }, bbox, hitTestable: true, element: text,
			defaultColor: text.getFontColorOverride?.() ?? schColors.note,
			draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
		};
	}

	// ---- Symbols ----

	/**
	 * A placed symbol instance carries no graphics/pins itself — it only
	 * references a library definition (by lib_id) that lives in the
	 * schematic's lib_symbols block. The library def's own sub-unit symbols
	 * (named "<LibName>_<unit>_<style>") get filtered down to unit 0
	 * (shared across every unit) plus the instance's own selected unit —
	 * see getUnitId()'s 0-default vs deconstructSymbolName()'s 1-default,
	 * two different "unit" concepts that are easy to conflate.
	 *
	 * Library geometry is authored in a coordinate system with X mirrored
	 * relative to schematic/world space (an established, documented KiCad
	 * quirk — see WithStartMidEnd's `invert` parameter, already built for
	 * exactly this) — every local point gets that X-flip applied before the
	 * placed instance's own translate/rotate/mirror transform.
	 */
	protected buildSymbolInstance(instance: any, libSymbols: any): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];
		const libId: string | undefined = typeof instance.getLibId === 'function' ? instance.getLibId() : undefined;
		if (!libId) {
			return items;
		}
		// (lib_name "X") overrides which lib_symbols entry this instance's
		// cached definition actually lives under — real KiCad writes this
		// whenever the same lib_id needed more than one independently-cached
		// copy in the file (disambiguated with a numeric suffix, e.g.
		// multiple power:GND placements ending up as "GND_1"/"GND_2"); in
		// that case lib_id's bare name may not exist as a lib_symbols entry
		// at all. Confirmed against a real file where every power:GND
		// instance had (lib_name "GND_1") and lib_symbols had no "power:GND"
		// entry, only "GND_1" — every such symbol silently rendered as
		// nothing before this fell back to lib_id unconditionally.
		const libLookupName = (typeof instance.getLibName === 'function' ? instance.getLibName() : undefined) ?? libId;
		const libDef = typeof libSymbols.findSymbolByName === 'function' ? libSymbols.findSymbolByName(libLookupName) :
			null;
		if (!libDef) {
			return items;
		}

		const origin = instance.getOrigin();
		const mirror = readMirror(instance);
		const instanceMatrix = buildInstanceMatrix(origin.x, origin.y, origin.rotation ?? 0, mirror);
		const instanceId = instance.getUuid() ?? `sym:${ origin.x },${ origin.y }`;
		const placedUnit: number = typeof instance.getUnitId === 'function' ? instance.getUnitId() : 0;
		const instanceRef: string = typeof instance.getReference === 'function' ?
			(String(instance.getReference() ?? '').trim()) : '';
		// Real KiCad's unit count gates the "U1" → "U1A" reference suffix
		// (SCH_SYMBOL::GetRef, `if (aIncludeUnit && GetUnitCount() > 1) ref +=
		// subRef`) — resolved through the same one-level `extends` fallback as
		// relevantSubUnits, since a derived multi-unit part's own libDef has
		// no sub-units of its own to count.
		let unitCountSource = libDef;
		if (
			typeof libDef.isDerived === 'function' &&
			libDef.isDerived() &&
			typeof libDef.getLayers === 'function'
			&& libDef.getLayers().length === 0
		) {
			const base = typeof libSymbols?.findSymbolByName === 'function' ?
				libSymbols.findSymbolByName(libDef.getExtends()) : null;
			if (base) {
				unitCountSource = base;
			}
		}
		const unitCount: number = typeof unitCountSource.getUnitCount === 'function' ? unitCountSource.getUnitCount() :
			1;
		const isDnp = typeof instance.isDnp === 'function'
			? !!instance.isDnp()
			: !!instance.findFirstChildByName?.('dnp')?.value;

		const subUnits = this.relevantSubUnits(libDef, placedUnit, libSymbols);
		// Two passes across ALL sub-units, not one pass per sub-unit: a
		// gate symbol's filled outline (e.g. the AND-gate rectangle/D-shape)
		// and its body markings ("&", ">=1", "1", ...) commonly live in
		// DIFFERENT sub-units (unit 0 "shared" vs. the placed unit), so
		// processing sub-unit-by-sub-unit could push a later sub-unit's
		// filled rect AFTER an earlier sub-unit's text, painting the fill
		// on top and hiding it — confirmed as the actual cause of "no
		// symbols visible on the body" (text was rendering, just underneath
		// the body fill). Building every fill/outline shape first, then
		// every text item, guarantees text always paints on top regardless
		// of which sub-unit either one happens to live in.
		// Rect/circle (the shapes that usually carry the body's opaque
		// fill, e.g. a multi-gate IC's outer rectangle) are built in their
		// OWN pass, before arcs/polylines — a gate's divider line (a
		// polyline) commonly lives in a DIFFERENT sub-unit than the body
		// rect it divides, so pushing them in per-sub-unit document order
		// could still put the divider before the rect and have the rect's
		// fill painted right over it, even after separating out text.
		for (const subUnit of subUnits) {
			if (getRectClass()) {
				for (const rect of subUnit.findChildrenByClass(getRectClass())) {
					items.push(this.buildSymRect(rect, instanceMatrix, instanceId));
				}
			}
			if (getSymCircleClass()) {
				for (const circle of subUnit.findChildrenByClass(getSymCircleClass())) {
					items.push(this.buildSymCircle(circle, instanceMatrix, instanceId));
				}
			}
		}
		for (const subUnit of subUnits) {
			if (getSymArcClass()) {
				for (const arc of subUnit.findChildrenByClass(getSymArcClass())) {
					const item = this.buildSymArc(arc, instanceMatrix, instanceId);
					if (item) {
						items.push(item);
					}
				}
			}
			if (getPolylineClass()) {
				for (const poly of subUnit.findChildrenByClass(getPolylineClass())) {
					items.push(this.buildSymPolyline(poly, instanceMatrix, instanceId));
				}
			}
			if (getBezierClass()) {
				for (const bezier of subUnit.findChildrenByClass(getBezierClass())) {
					const item = this.buildSymBezier(bezier, instanceMatrix, instanceId);
					if (item) {
						items.push(item);
					}
				}
			}
		}
		for (const subUnit of subUnits) {
			if (getTextClass()) {
				for (const text of subUnit.findChildrenByClass(getTextClass())) {
					const item = this.buildSymText(text, instanceMatrix, instanceId);
					if (item) {
						items.push(item);
					}
				}
			}
		}
		for (const subUnit of subUnits) {
			if (getPinClass()) {
				// Prefer the correctly-named API; fall back to the legacy
				// misnamed arePinNamesHidden (which actually checked pin_numbers).
				const pinNumbersHidden = typeof libDef.arePinNumbersHidden === 'function'
					? libDef.arePinNumbersHidden()
					: (typeof libDef.arePinNamesHidden === 'function' ? libDef.arePinNamesHidden() : false);
				const pinNamesEl = typeof libDef.findFirstChildByName === 'function'
					? libDef.findFirstChildByName('pin_names')
					: null;
				const pinNamesHidden = typeof libDef.arePinNameLabelsHidden === 'function'
					? libDef.arePinNameLabelsHidden()
					: pinNamesHiddenFromEl(pinNamesEl);
				// KiCad's real switch between the two pin-name styles: a
				// `pin_names` offset of 0 (explicit in the file) means names
				// render OUTSIDE the body, beside the pin like transistor
				// libraries commonly do; any nonzero offset (including the
				// default 0.508mm used when `pin_names`/`offset` is omitted
				// entirely) means names render INSIDE the body, inset from
				// the pin's inner end by that distance -- the opamp style.
				// This is a real KiCad file-format convention, not a
				// symbol-type heuristic, which is why it was wrong to try to
				// special-case "opamp vs transistor" directly.
				const offsetEl = pinNamesEl && typeof pinNamesEl.findFirstChildByName === 'function' ?
					pinNamesEl.findFirstChildByName('offset') : null;
				const pinNameOffset = readNumericValue(offsetEl, 0.508);

				for (const pin of subUnit.findChildrenByClass(getPinClass())) {
					for (const item of this.buildPin(
						pin, instanceMatrix, instanceId, pinNumbersHidden, pinNamesHidden, pinNameOffset,
						instanceRef || undefined
					)) {
						items.push(item);
					}
				}
			}
		}

		// Reference/Value/Footprint/etc — real per-instance values and
		// positions live on the PLACED instance's own properties, not the
		// library def (same WithProperties + getVisibleProperties pattern
		// already used for footprints). Each field now gets a dedicated
		// hit-testable label item so edit-mode selection/drag can target the
		// field itself while the visible text remains separate and excluded from
		// the symbol-body hit box below.
		if (typeof instance.getVisibleProperties === 'function') {
			const visibleProps = instance.getVisibleProperties();
			for (const name of Object.keys(visibleProps)) {
				// "Description" (and ki_* reserved metadata fields) are
				// informational-only in real KiCad — shown in a tooltip/the
				// properties dialog, never as schematic graphics — even
				// though library authors frequently leave them un-hidden.
				// Power symbols specifically often carry a long Description
				// ("Power symbol creates a global label with name matching
				// pin name...") that would otherwise render as stray text
				// dumped across the sheet.
				// "Description", "Footprint", and "Datasheet" are informational-only
				// or project-configuration fields that real KiCad never renders as
				// schematic graphics — skip them even when the .kicad_sch doesn't
				// explicitly carry (hide yes) on the instance.
				if (name === 'Description' || name === 'Footprint' || name === 'Datasheet' || name.startsWith('ki_')) {
					continue;
				}
				// KiCad never draws power-symbol Value text (e.g. "GND") on the
				// sheet — the net name is conveyed by the graphic / global merge.
				if (libId === 'power:GND' && name === 'Value') {
					continue;
				}
				const prop = visibleProps[name];
				let value: string | undefined = prop.propertyValue;
				if (!value) {
					continue;
				}
				// "U1" → "U1A": the stored Reference property text is always
				// the bare designator (matches real KiCad's own file format —
				// SubReference is display-only, never written to the field
				// itself); only the ON-SCREEN text gets the per-unit letter.
				if (name === 'Reference' && unitCount > 1) {
					value += letterSubReference(placedUnit > 0 ? placedUnit : 1);
				}
				value = this.expandText(value);
				const propOrigin = typeof prop.getOrigin === 'function' ? prop.getOrigin() :
					{ x: 0, y: 0, rotation: 0 };
				const anchor = typeof prop.getAnchorPoint === 'function' ? prop.getAnchorPoint() : { x: 0.5, y: 0.5 };
				const { size: textSize, thickness, italic } = readElementFontMetrics(prop);
				const drawRotationDeg = fieldDrawRotation(propOrigin.rotation ?? 0, origin.rotation ?? 0);
				const textWorld = symbolFieldWorldCenter(
					propOrigin, anchor, value, textSize, origin, mirror
				);
				const geometry = computeStrokeTextGeometry(
					value, textWorld, textSize, drawRotationDeg, false, thickness, { x: 0.5, y: 0.5 }, italic);
				const bbox = getStrokeTextBounds(geometry);
				items.push({
					id: `${ instanceId }:prop:${ name }`, layer: 'Text', kind: 'label',
					shape: { type: 'rect', ...bbox }, bbox, hitTestable: true, element: instance,
					labelName: name, labelKind: 'symbol-field', fieldName: name,
					fieldOrigin: { x: propOrigin.x, y: propOrigin.y, rotation: propOrigin.rotation ?? 0 },
					draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
				});
				items.push({
					id: `${ instanceId }:prop:${ name }:text`, layer: 'Text', kind: 'text',
					shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: instance,
					highlightId: `${ instanceId }:prop:${ name }`,
					draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
				});
			}
		}

		// One hit-testable box per instance covering the symbol's BODY GRAPHICS
		// + PINS only — never the Reference/Value/field text or library
		// markings. Clicking a part's "R1" / "10k" text must not grab or drag
		// the symbol. Individual shapes above are intentionally NOT hitTestable
		// (clicking exactly on one arc segment isn't useful), but a click/drag
		// editor needs SOME way to select "this whole symbol".
		// Deliberately bucketed on the 'Graphics' layer (not 'Symbols') so it
		// sits at the BOTTOM of hit-test priority, below Wires/Junctions/
		// NoConnects/Pins in SCHEMATIC_LAYER_ORDER — this box is large and
		// commonly overlaps a wire stub leaving the pin right at the
		// symbol's edge; without this it would steal clicks from existing
		if (isDnp) {
			// KiCad dims every rendered part of a DNP symbol, including its
			// fields and pins: desaturate the layer color, then mix it 50% toward
			// the schematic background.  Do this at the item-color boundary so
			// fills and strokes receive the same treatment and the selection
			// highlight (applied later by paint()) can still override it.
			for (const item of items) {
				item.defaultColor = dnpDimmedColor(item.defaultColor ?? colorForKind(item.kind));
			}
		}

		// wire/pin-based features (e.g. net-trace-on-click) elsewhere.
		// Callers that need symbol-only picking (edit mode) use
		// hitTestSymbolAtScreen() to ignore those overlays.
		{
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const it of items) {
				// Body + pins only. Exclude ALL text (library markings AND
				// instance field text like Reference/Value) and labels — they
				// must not contribute to the click/drag hit region.
				if (it.kind === 'text' || it.kind === 'label') {
					continue;
				}
				minX = Math.min(minX, it.bbox.x);
				minY = Math.min(minY, it.bbox.y);
				maxX = Math.max(maxX, it.bbox.x + it.bbox.w);
				maxY = Math.max(maxY, it.bbox.y + it.bbox.h);
			}
			if (Number.isFinite(minX) && Number.isFinite(minY)) {
				const refDesignator = typeof instance.getReference === 'function'
					? (instance.getReference() || undefined)
					: undefined;
				// Pad so thin passives (Device:R ≈ 2mm wide) remain clickable
				// when the sheet is zoomed to fit a full layout.
				const pad = 0.635;
				const minSize = 2.54;
				const w = Math.max(maxX - minX, minSize);
				const h = Math.max(maxY - minY, minSize);
				const cx = (minX + maxX) / 2;
				const cy = (minY + maxY) / 2;
				const bbox = {
					x: cx - w / 2 - pad,
					y: cy - h / 2 - pad,
					w: w + pad * 2,
					h: h + pad * 2
				};
				items.push({
					id: `symbol:${ instanceId }`,
					layer: 'Graphics',
					kind: 'symbol',
					shape: { type: 'rect', ...bbox },
					bbox,
					hitTestable: true,
					element: instance,
					refDesignator,
					draw: (renderer, color) => {
						// Invisible hit region normally; when selected the
						// painter passes the highlight color — draw an
						// outline so edit-mode selection is visible (body
						// graphics keep their own ids and wouldn't light up).
						if (color !== '#ffcc00') {
							return;
						}
						renderer.rect(new Vec2(bbox.x, bbox.y), bbox.w, bbox.h, {
							strokeColor: color,
							strokeWidth: 0.25
						});
					}
				});
			}
		}

		if (isDnp) {
			// SCH_SYMBOL::PlotDNP() builds the marker from the body-and-pins
			// bounds, with an asymmetric margin based on how far pins extend
			// beyond the body.  The previous implementation used one symmetric
			// margin derived from the smallest overall dimension; that makes a
			// vertically-pinned capacitor's X much too large and shifts it away
			// from the actual body center.
			const boundsOf = (candidates: SchPaintedItem[]) => {
				let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
				for (const item of candidates) {
					minX = Math.min(minX, item.bbox.x);
					minY = Math.min(minY, item.bbox.y);
					maxX = Math.max(maxX, item.bbox.x + item.bbox.w);
					maxY = Math.max(maxY, item.bbox.y + item.bbox.h);
				}
				return { minX, minY, maxX, maxY };
			};
			const bodyItems = items.filter(item => item.kind === 'symbol-graphic');
			const bodyAndPinsItems = items.filter(item => item.kind === 'symbol-graphic' || item.kind === 'pin');
			const body = boundsOf(bodyItems);
			const pins = boundsOf(bodyAndPinsItems);
			if (Number.isFinite(pins.minX) && Number.isFinite(pins.minY) && pins.maxX > pins.minX && pins.maxY
				> pins.minY) {
				// A malformed/graphic-less library symbol can have no body items;
				// fall back to the body-and-pins box rather than producing NaNs.
				const bodyBounds = Number.isFinite(body.minX) && Number.isFinite(body.minY)
				&& body.maxX > body.minX && body.maxY > body.minY ? body : pins;
				let marginX = Math.max(bodyBounds.minX - pins.minX, pins.maxX - bodyBounds.maxX);
				let marginY = Math.max(bodyBounds.minY - pins.minY, pins.maxY - bodyBounds.maxY);
				// Exact port of SCH_SYMBOL::PlotDNP(): margins are intentionally
				// asymmetric, then cross-coupled so a pin extension in one axis
				// still leaves enough clearance in the other.
				marginX = Math.max(marginX * 0.6, marginY * 0.3);
				marginY = Math.max(marginY * 0.6, marginX * 0.3);
				// Inflate the BODY box, not the body-and-pins box.  KiCad deliberately
				// leaves the marker centered on the body while the pin overhangs only
				// determine the amount of clearance around it.
				const markerX = bodyBounds.minX - marginX;
				const markerY = bodyBounds.minY - marginY;
				const markerW = bodyBounds.maxX - bodyBounds.minX + marginX * 2;
				const markerH = bodyBounds.maxY - bodyBounds.minY + marginY * 2;
				const points = [
					new Vec2(markerX, markerY), new Vec2(markerX + markerW, markerY + markerH),
					new Vec2(markerX + markerW, markerY), new Vec2(markerX, markerY + markerH)
				];
				const markerShape: PaintedShape = { type: 'polygon', points: points.map(p => ({ x: p.x, y: p.y })) };
				items.push({
					id: `dnp-marker:${ instanceId }`, layer: 'Frame', kind: 'symbol-graphic',
					shape: markerShape, bbox: shapeToBBox(markerShape), hitTestable: false, element: instance,
					defaultColor: schColors.dnpMarker,
					draw: (renderer, color) => {
						// KiCad uses 3 × DEFAULT_LINE_WIDTH_MILS (6 mil), i.e.
						// 0.4572 mm, for this marker at every zoom level.
						const strokeWidth = 0.4572;
						renderer.line([points[0]!, points[1]!], { strokeColor: color, strokeWidth });
						renderer.line([points[2]!, points[3]!], { strokeColor: color, strokeWidth });
					}
				});
			}
		}

		return items;
	}

	/** unit 0 = shared across all units (always included); otherwise only
	 * the instance's own selected unit. Same filter for deMorgan style,
	 * defaulting to style 1 (alternate/deMorgan style 2 not selectable yet).
	 *
	 * `libDef` itself may be a DERIVED symbol (`(extends "Base")`, e.g.
	 * 74AHC273 extending 74LS273) — confirmed via the user's local KiCad
	 * checkout (LIB_SYMBOL::IsDerived()/GetParent(), used pervasively
	 * throughout lib_symbol.cpp): a derived symbol has no graphics/pins of
	 * its own at all, only overridden properties, and real KiCad resolves
	 * every drawing/pin query through to the base transparently. Without
	 * this, `getLayers()` on a derived symbol is always empty, and the old
	 * `subUnits.length === 0` fallback (`return [libDef]`) — correct for a
	 * genuinely single-unit symbol with its OWN top-level graphics — instead
	 * returned a symbol with NO graphics at all, rendering nothing. Resolved
	 * one level (matches addLibrarySymbolFromText's own one-level embed —
	 * real-world libraries don't chain `extends`), by name within the SAME
	 * lib_symbols block the placed instance's own libId resolved against. */
	protected relevantSubUnits(libDef: any, placedUnit: number, libSymbols?: any): any[] {
		let graphicsSource = libDef;
		if (typeof libDef.isDerived === 'function' && libDef.isDerived() && typeof libDef.getLayers === 'function'
			&& libDef.getLayers().length === 0) {
			const base = typeof libSymbols?.findSymbolByName === 'function' ?
				libSymbols.findSymbolByName(libDef.getExtends()) : null;
			if (base) {
				graphicsSource = base;
			}
		}
		const subUnits: any[] = typeof graphicsSource.getLayers === 'function' ? graphicsSource.getLayers() : [];
		if (subUnits.length === 0) {
			return [graphicsSource];
		}
		return subUnits.filter((s: any) => {
			if (typeof s.deconstructSymbolName !== 'function') {
				return true;
			}
			const { unit, deMorgan } = s.deconstructSymbolName();
			return (unit === 0 || unit === placedUnit) && (deMorgan === 0 || deMorgan === 1);
		});
	}

	protected buildSymRect(rect: any, instanceMatrix: Matrix3, instanceId: string): SchPaintedItem {
		const { start, end } = rect.getStartEnd();
		const corners = [
			flippedTransform(instanceMatrix, start.x, start.y), flippedTransform(instanceMatrix, end.x, start.y),
			flippedTransform(instanceMatrix, end.x, end.y), flippedTransform(instanceMatrix, start.x, end.y)
		];
		const { width, type: lineType } = typeof rect.getStroke === 'function' ? rect.getStroke() :
			{ width: 0.25, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof rect.getFill === 'function' ? rect.getFill() : 'none';
		const id = rect.getUuid() ?? `sym-rect:${ instanceId }:${ start.x },${ start.y }`;
		const shape: PaintedShape = { type: 'polygon', points: corners.map(p => ({ x: p.x, y: p.y })) };
		return {
			id,
			layer: 'Symbols',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: false,
			element: rect,
			draw: (renderer, color) => {
				const fillColor = symbolFillColor(fillType, color);
				if (fillColor) {
					renderer.polygon(corners, { fillColor });
				}
				drawStrokeOutline(renderer, [...corners, corners[0]!], width, lineType, color);
			}
		};
	}

	protected buildSymCircle(circle: any, instanceMatrix: Matrix3, instanceId: string): SchPaintedItem {
		const center = circle.getCenter();
		const radius = typeof circle.getRadius === 'function' ? circle.getRadius() : 0;
		const worldCenter = flippedTransform(instanceMatrix, center.x, center.y);
		// A pure rotation+mirror (no non-uniform scale) never distorts a
		// circle's radius, so it's safe to reuse unchanged.
		const { width, type: lineType } = typeof circle.getStroke === 'function' ? circle.getStroke() :
			{ width: 0.25, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof circle.getFill === 'function' ? circle.getFill() : 'none';
		const id = circle.getUuid() ?? `sym-circle:${ instanceId }:${ center.x },${ center.y }`;
		const shape: PaintedShape = { type: 'circle', cx: worldCenter.x, cy: worldCenter.y, r: radius };
		return {
			id,
			layer: 'Symbols',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: false,
			element: circle,
			draw: (renderer, color) => {
				const fillColor = symbolFillColor(fillType, color);
				if (fillColor) {
					renderer.circle(worldCenter, radius, { fillColor });
				}
				if (lineType === 'solid' || lineType === 'default') {
					renderer.circle(worldCenter, radius, { strokeColor: color, strokeWidth: width || 0.1 });
				}
				else {
					drawStrokeOutline(renderer, circleToRing(worldCenter, radius), width, lineType, color);
				}
			}
		};
	}

	/**
	 * Uses getArcCenterRadiusAngles(false) — RAW local geometry, no internal
	 * flip — then derives the world center/radius/angles the same robust
	 * way buildPin() derives pin direction: transform actual points (center,
	 * plus a point on the arc at its start/end angle) through the real
	 * flippedTransform + instance matrix, and measure the result. This
	 * avoids having to hand-derive how a Y-flip changes an arc's sweep
	 * direction/angle signs (it does — Y-flip requires a start/end SWAP or
	 * the arc bulges the wrong way, which point-transformation sidesteps
	 * entirely rather than getting subtly wrong).
	 */
	protected buildSymArc(arc: any, instanceMatrix: Matrix3, instanceId: string): SchPaintedItem | null {
		if (typeof arc.getArcCenterRadiusAngles !== 'function') {
			return null;
		}
		let local: { centerX: number; centerY: number; radius: number; startAngle: number; endAngle: number };
		try {
			local = arc.getArcCenterRadiusAngles(false);
		}
		catch {
			return null;
		}
		const worldCenter = flippedTransform(instanceMatrix, local.centerX, local.centerY);
		// Re-deriving world start/end angle from the LOCAL start/end angles
		// (transforming a point at each and calling atan2 again) is NOT
		// enough on its own: flippedTransform's Y-negation is a reflection
		// (applied for every symbol-local coordinate, mirrored instance or
		// not), and a reflection reverses winding — the local sweep
		// direction that correctly passed through mid no longer does once
		// independently-transformed start/end points are naively re-paired
		// by atan2. Confirmed via a real symbol with two mirror-image arcs:
		// one happened to survive the reflection with the right winding by
		// coincidence, the other rendered as the complementary (wrong,
		// "rotated 180°") arc. Fixed by transforming mid too and re-running
		// the same mid-based direction pick in WORLD space, exactly
		// mirroring what getArcCenterRadiusAngles() already does in local
		// space (see WithStartMidEnd.ts).
		const rawPts = typeof arc.getStartMidEnd === 'function' ? arc.getStartMidEnd() : null;
		let worldStartAngle: number, worldEndAngle: number;
		if (rawPts) {
			const worldStartPt = flippedTransform(instanceMatrix, rawPts.start.x, rawPts.start.y);
			const worldMidPt = flippedTransform(instanceMatrix, rawPts.mid.x, rawPts.mid.y);
			const worldEndPt = flippedTransform(instanceMatrix, rawPts.end.x, rawPts.end.y);
			({ startAngle: worldStartAngle, endAngle: worldEndAngle } = arcSweepAngles(
				worldCenter, worldStartPt, worldMidPt, worldEndPt));
		}
		else {
			const worldStart = flippedTransform(
				instanceMatrix, local.centerX + local.radius * Math.cos(local.startAngle),
				local.centerY + local.radius * Math.sin(local.startAngle)
			);
			const worldEnd = flippedTransform(
				instanceMatrix, local.centerX + local.radius * Math.cos(local.endAngle),
				local.centerY + local.radius * Math.sin(local.endAngle)
			);
			worldStartAngle = Math.atan2(worldStart.y - worldCenter.y, worldStart.x - worldCenter.x);
			worldEndAngle = Math.atan2(worldEnd.y - worldCenter.y, worldEnd.x - worldCenter.x);
		}
		// A pure rotation+flip (no non-uniform scale) never distorts a
		// circle's radius, so the local radius carries over unchanged.
		const radius = local.radius;
		const { width, type: lineType } = typeof arc.getStroke === 'function' ? arc.getStroke() :
			{ width: 0.25, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof arc.getFill === 'function' ? arc.getFill() : 'none';
		const id = `sym-arc:${ instanceId }:${ local.centerX },${ local.centerY }`;
		const shape: PaintedShape = { type: 'circle', cx: worldCenter.x, cy: worldCenter.y, r: radius };
		return {
			id,
			layer: 'Symbols',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: false,
			element: arc,
			draw: (renderer, color) => {
				const fillColor = symbolFillColor(fillType, color);
				if (fillColor) {
					// Pie-slice polygon (sampled arc + center) — same approach
					// as buildSchArc(), see its comment for why. Real-world
					// example: Jumper:SolderJumper_2_Bridged's two `(fill
					// (type outline))` arcs, meant to render as solid
					// half-moons on either side of the bridge rectangle.
					renderer.polygon(
						[...arcToPolyline(worldCenter, radius, worldStartAngle, worldEndAngle), worldCenter],
						{ fillColor }
					);
				}
				if (lineType === 'solid' || lineType === 'default') {
					renderer.arc(
						worldCenter, radius, worldStartAngle, worldEndAngle,
						{ strokeColor: color, strokeWidth: width || 0.1 }
					);
				}
				else {
					drawStrokeOutline(
						renderer, arcToPolyline(worldCenter, radius, worldStartAngle, worldEndAngle), width, lineType,
						color
					);
				}
			}
		};
	}

	protected buildSymPolyline(poly: any, instanceMatrix: Matrix3, instanceId: string): SchPaintedItem {
		const points: { x: number; y: number }[] = typeof poly.getPoints === 'function' ? poly.getPoints() : [];
		const worldPoints = points.map(p => flippedTransform(instanceMatrix, p.x, p.y));
		const { width, type: lineType } = typeof poly.getStroke === 'function' ? poly.getStroke() :
			{ width: 0.25, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof poly.getFill === 'function' ? poly.getFill() : 'none';
		const first = points[0], last = points[points.length - 1];
		const id = poly.getUuid() ?? `sym-poly:${ instanceId }:${ first?.x },${ first?.y }`;
		const shape: PaintedShape = { type: 'polygon', points: worldPoints.map(p => ({ x: p.x, y: p.y })) };
		return {
			id,
			layer: 'Symbols',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: false,
			element: poly,
			draw: (renderer, color) => {
				// Fill is gated on fillType alone (matching buildSymArc's own
				// unconditional pattern), NOT on whether the point list
				// happens to repeat its first point — confirmed via a real
				// KiCad symbol (4xxx.kicad_sym's "4073"): the AND-gate body
				// is an arc + a 4-point polyline that DON'T individually
				// close (the polyline's first/last points are the arc's own
				// two endpoints), both `(fill (type background))`, meant to
				// render as ONE compound filled shape. A polygon fill always
				// implicitly closes back to its first point regardless — the
				// old `closed` gate here only ever suppressed fill on data
				// shaped exactly like this real, common case, producing a
				// two-tone body (arc's half correctly filled, polyline's
				// half showing raw canvas background through it).
				const fillColor = symbolFillColor(fillType, color);
				if (fillColor) {
					renderer.polygon(worldPoints, { fillColor });
				}
				drawStrokeOutline(renderer, worldPoints, width, lineType, color);
			}
		};
	}

	/** Root-level KiCad text boxes: a rectangular text area whose stored
	 * rotation affects text layout, while `(at ...) + (size ...)` remain the
	 * axis-aligned rectangle corners (matching SCH_TEXTBOX::GetDrawPos()). */
	protected buildSchTextBox(textBox: any): SchPaintedItem | null {
		const value = this.expandText(textBox.value ?? '');
		const origin = typeof textBox.getOrigin === 'function' ? textBox.getOrigin() : { x: 0, y: 0, rotation: 0 };
		const size = textBox.findFirstChildByName?.('size');
		const width = Number(size?.width ?? size?.attributes?.[0]?.value) || 0;
		const height = Number(size?.height ?? size?.attributes?.[1]?.value) || 0;
		if (!(width > 0) || !(height > 0)) {
			return null;
		}
		const x = origin.x, y = origin.y;
		const margins = textBox.findFirstChildByName?.('margins')?.attributes ?? [];
		const margin = (index: number) => Number(margins[index]?.value) || 0;
		const left = margin(0), top = margin(1), right = margin(2), bottom = margin(3);
		const contentW = Math.max(0, width - left - right);
		const contentH = Math.max(0, height - top - bottom);
		const rotation = origin.rotation ?? 0;
		const vertical = rotation === 90 || rotation === 270;
		const { size: textSize, thickness, italic } = readElementFontMetrics(textBox);
		const anchor = readJustifyAnchor(textBox);
		// SCH_TEXTBOX swaps the alignment axes for vertical text: its ordinary
		// horizontal alignment chooses Y, and vertical alignment chooses X.
		const textPos = vertical
			? new Vec2(x + left + anchor.y * contentW, y + top + (1 - anchor.x) * contentH)
			: new Vec2(x + left + anchor.x * contentW, y + top + anchor.y * contentH);
		const wrappedValue = wrapTableCellText(value, vertical ? contentH : contentW, textSize);
		const textAngle = vertical ? 90 : 0;
		const geometry = value ?
			computeStrokeTextGeometry(wrappedValue, textPos, textSize, textAngle, false, thickness, anchor, italic) :
			null;
		const { width: strokeWidth, type: strokeType } = typeof textBox.getStroke === 'function'
			? textBox.getStroke()
			: { width: 0, type: 'solid' as KicadStrokeLineType };
		// KiCad's `(stroke (width 0))` on a text box means its effective
		// default pen width, rather than an intentionally hidden border.
		const effectiveStrokeWidth = strokeWidth || pinThickness;
		const fillType = typeof textBox.getFill === 'function' ? textBox.getFill() : 'none';
		const fillNode = textBox.findFirstChildByName?.('fill');
		const fillColor = fillType === 'color'
			? fillNode?.getColor?.() ?? schColors.componentBody
			: fillType === 'background' ? schematicBackgroundColor : undefined;
		const strokeNode = textBox.findFirstChildByName?.('stroke');
		// KicadElementStroke.getColor() intentionally falls back to transparent
		// when a color child is absent. For a text box that means “use the
		// Notes-layer color”, not a transparent border.
		const strokeColor = strokeNode?.findFirstChildByName?.('color')?.getColor?.() as string | undefined;
		const id = textBox.getUuid?.() ?? `sch-text-box:${ x },${ y }`;
		// Same hit-test contract as ordinary schematic rectangles: an unfilled
		// text box is selectable by its border only, so it cannot steal clicks
		// from symbols/wires visually inside it. A filled box remains an area.
		const shape: PaintedShape = {
			type: 'rect', x, y, w: width, h: height,
			filled: fillType !== 'none', strokeWidth: effectiveStrokeWidth
		};
		return {
			id, layer: 'Graphics', kind: 'text', shape, bbox: shapeToBBox(shape), hitTestable: true, element: textBox,
			defaultColor: schColors.note,
			draw: (renderer, color) => {
				if (fillColor) {
					renderer.rect(new Vec2(x, y), width, height, { fillColor });
				}
				// Independent from strokeColor/fillColor above (font vs border
				// vs fill are 3 separate overridable colors in the file format)
				// — falls through to the same shared `color` the border already
				// falls back to when no font color is explicitly set.
				if (geometry) {
					drawStrokeTextGeometry(renderer, geometry, textBox.getFontColorOverride?.() ?? color);
				}
				drawStrokeOutline(renderer, [
					new Vec2(x, y), new Vec2(x + width, y), new Vec2(x + width, y + height), new Vec2(x, y + height),
					new Vec2(x, y)
				], effectiveStrokeWidth, strokeType, strokeColor || color);
			}
		};
	}

	protected buildSymBezier(bezier: any, instanceMatrix: Matrix3, instanceId: string): SchPaintedItem | null {
		const points: { x: number; y: number }[] = typeof bezier.getPoints === 'function' ? bezier.getPoints() : [];
		if (points.length !== 4) {
			return null;
		}
		const curve = cubicBezierToPolyline(
			flippedTransform(instanceMatrix, points[0]!.x, points[0]!.y),
			flippedTransform(instanceMatrix, points[1]!.x, points[1]!.y),
			flippedTransform(instanceMatrix, points[2]!.x, points[2]!.y),
			flippedTransform(instanceMatrix, points[3]!.x, points[3]!.y)
		);
		const { width, type: lineType } = typeof bezier.getStroke === 'function' ? bezier.getStroke() :
			{ width: 0.25, type: 'solid' as KicadStrokeLineType };
		const drawWidth = width || 0.25;
		const id = bezier.getUuid() ?? `sym-bezier:${ instanceId }:${ points[0]!.x },${ points[0]!.y }`;
		const shape: PaintedShape = {
			type: 'polygon', points: curve.map(p => ({ x: p.x, y: p.y })),
			filled: false, closed: false, strokeWidth: drawWidth
		};
		return {
			id,
			layer: 'Symbols',
			kind: 'symbol-graphic',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: false,
			element: bezier,
			draw: (renderer, color) => drawStrokeOutline(renderer, curve, drawWidth, lineType, color)
		};
	}

	/**
	 * Symbol body text — IEEE-style logic symbols (AND/OR/etc. gates) draw
	 * their body as a couple of lines PLUS literal text characters ("&",
	 * ">=1", "1", ...) as `(text ...)` elements inside the lib_symbol, not
	 * just rect/circle/arc/polyline. This was a confirmed gap (no `text`
	 * handling existed in this loop at all) — every gate symbol rendered as
	 * a bare outline with no body markings.
	 */
	protected buildSymText(text: any, instanceMatrix: Matrix3, instanceId: string): SchPaintedItem | null {
		const value: string = text.value ?? '';
		if (!value) {
			return null;
		}
		const origin = text.getOrigin();
		const worldPos = flippedTransform(instanceMatrix, origin.x, origin.y);
		// Same "transform actual points, don't hand-derive the angle" pattern
		// as buildPin()/buildSymArc() — robust to any rotate+mirror combo.
		const rad = Angle.degToRad(origin.rotation ?? 0);
		const dirPoint = flippedTransform(instanceMatrix, origin.x + Math.cos(rad), origin.y + Math.sin(rad));
		const worldAngleDeg = (Math.atan2(dirPoint.y - worldPos.y, dirPoint.x - worldPos.x) * 180) / Math.PI;
		const upright = uprightTextAngle(worldAngleDeg);
		const { size: textSize, thickness, italic } = readElementFontMetrics(text);
		const rawAnchor = typeof text.getAnchorPoint === 'function' ? text.getAnchorPoint() : { x: 0.5, y: 0.5 };
		const anchor = { x: upright.flipped ? 1 - rawAnchor.x : rawAnchor.x, y: rawAnchor.y };
		const geometry = computeStrokeTextGeometry(
			value, worldPos, textSize, upright.angleDeg, false, thickness, anchor, italic);
		const id = text.getUuid() ?? `sym-text:${ instanceId }:${ origin.x },${ origin.y }`;
		const bbox = getStrokeTextBounds(geometry);
		return {
			id,
			layer: 'Symbols',
			kind: 'text',
			shape: { type: 'rect', ...bbox },
			bbox,
			hitTestable: false,
			element: text,
			defaultColor: schColors.componentOutline,
			draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
		};
	}

	/**
	 * Pin geometry: `at` is the OUTER (wire-connection) end; the pin's
	 * drawn line runs from there `length` units in the direction of its own
	 * rotation, toward the symbol body. Direction is derived by transforming
	 * TWO local points (the anchor and one unit further along the pin's own
	 * un-flipped rotation) through the same flip+instance matrix and taking
	 * their difference — deliberately avoids hand-deriving how the X-flip
	 * affects a bare rotation angle, since transforming actual points is
	 * unambiguous regardless of how many flips/mirrors are stacked.
	 * Pin name/number text position/size isn't modeled by @kicad-io
	 * (confirmed gap) — using KiCad's own fixed conventional offsets.
	 */
	protected buildPin(
		pin: any, instanceMatrix: Matrix3, instanceId: string, pinNumbersHidden = false, pinNamesHidden = false,
		pinNameOffset = 0.508, refDesignator?: string
	): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];
		const origin = pin.getOrigin();
		const length = typeof pin.getLength === 'function' ? pin.getLength() : 2.54;
		const isHidden = typeof pin.isHidden === 'function' ? pin.isHidden() : false;
		const worldOuter = flippedTransform(instanceMatrix, origin.x, origin.y);
		const id = pin.getUuid() ?? `pin:${ instanceId }:${ origin.x },${ origin.y }`;

		if (isHidden) {
			const shape: PaintedShape = {
				type: 'segment',
				x1: worldOuter.x,
				y1: worldOuter.y,
				x2: worldOuter.x,
				y2: worldOuter.y,
				width: 0
			};
			items.push({
				id, layer: 'Pins', kind: 'pin', shape, bbox: shapeToBBox(shape), hitTestable: false, element: pin,
				refDesignator,
				draw: () => {}
			});
			return items;
		}

		const localDir = Angle.fromDegrees(-(origin.rotation ?? 0)).rotatePoint(new Vec2(1, 0), new Vec2(0, 0));
		const worldDirPoint = flippedTransform(instanceMatrix, origin.x + localDir.x, origin.y + localDir.y);
		const dx = worldDirPoint.x - worldOuter.x, dy = worldDirPoint.y - worldOuter.y;
		const dirLen = Math.hypot(dx, dy) || 1;
		const ux = dx / dirLen, uy = dy / dirLen;
		const worldInner = new Vec2(worldOuter.x + ux * length, worldOuter.y + uy * length);

		const width = 0.15;

		// Pin electrical-type/shape decorations (inverted bubble, clock
		// triangle, low-input/output tri, non-logic X, no-connect X) — ports
		// kicanvas's PinShapeInternals.draw(), itself a port of KiCad's own
		// SCH_PAINTER::draw(LIB_PIN*, ...). `dir` there is the OUTWARD
		// direction (body -> wire) — the opposite of our (ux,uy), which
		// points wire -> body — so it's just their negation here.
		const { electricalType, shape: pinShape } = typeof pin.getType === 'function' ? pin.getType() :
			{ electricalType: 'passive', shape: 'line' };
		const symbolRadius = 0.635; // DefaultValues.pinsymbol_size
		const symbolDiam = symbolRadius * 2;
		const ncRadius = 0.381; // DefaultValues.target_pin_radius
		const dirX = -ux, dirY = -uy;

		let lineEnd = worldInner;
		let bubble: Vec2 | null = null;
		const decorations: Vec2[][] = [];

		if (electricalType === 'no_connect') {
			decorations.push([
				new Vec2(worldOuter.x - ncRadius, worldOuter.y - ncRadius),
				new Vec2(worldOuter.x + ncRadius, worldOuter.y + ncRadius)
			]);
			decorations.push([
				new Vec2(worldOuter.x + ncRadius, worldOuter.y - ncRadius),
				new Vec2(worldOuter.x - ncRadius, worldOuter.y + ncRadius)
			]);
		}
		else {
			const clockNotch = () => {
				decorations.push(dirY === 0
					? [
						new Vec2(worldInner.x, worldInner.y + symbolRadius),
						new Vec2(worldInner.x - dirX * symbolRadius, worldInner.y),
						new Vec2(worldInner.x, worldInner.y - symbolRadius)
					]
					: [
						new Vec2(worldInner.x + symbolRadius, worldInner.y),
						new Vec2(worldInner.x, worldInner.y - dirY * symbolRadius),
						new Vec2(worldInner.x - symbolRadius, worldInner.y)
					]);
			};
			const lowInTri = () => {
				decorations.push(dirY === 0
					? [
						new Vec2(worldInner.x + dirX * symbolDiam, worldInner.y),
						new Vec2(worldInner.x + dirX * symbolDiam, worldInner.y - symbolDiam), worldInner
					]
					: [
						new Vec2(worldInner.x, worldInner.y + dirY * symbolDiam),
						new Vec2(worldInner.x - symbolDiam, worldInner.y + dirY * symbolDiam), worldInner
					]);
			};

			switch (pinShape) {
				case 'inverted':
					bubble = new Vec2(worldInner.x + dirX * symbolRadius, worldInner.y + dirY * symbolRadius);
					lineEnd = new Vec2(worldInner.x + dirX * symbolDiam, worldInner.y + dirY * symbolDiam);
					break;
				case 'inverted_clock':
					bubble = new Vec2(worldInner.x + dirX * symbolRadius, worldInner.y + dirY * symbolRadius);
					lineEnd = new Vec2(worldInner.x + dirX * symbolDiam, worldInner.y + dirY * symbolDiam);
					clockNotch();
					break;
				case 'clock':
					clockNotch();
					break;
				case 'clock_low':
				case 'edge_clock_high':
					clockNotch();
					lowInTri();
					break;
				case 'input_low':
					lowInTri();
					break;
				case 'output_low':
					decorations.push(dirY === 0
						? [
							new Vec2(worldInner.x, worldInner.y - symbolDiam),
							new Vec2(worldInner.x + dirX * symbolDiam, worldInner.y)
						]
						: [
							new Vec2(worldInner.x - symbolDiam, worldInner.y),
							new Vec2(worldInner.x, worldInner.y + dirY * symbolDiam)
						]);
					break;
				case 'non_logic':
					decorations.push([
						new Vec2(
							worldInner.x - (dirX + dirY) * symbolRadius, worldInner.y - (dirY - dirX) * symbolRadius),
						new Vec2(
							worldInner.x + (dirX + dirY) * symbolRadius, worldInner.y + (dirY - dirX) * symbolRadius)
					]);
					decorations.push([
						new Vec2(
							worldInner.x - (dirX - dirY) * symbolRadius, worldInner.y - (dirY + dirX) * symbolRadius),
						new Vec2(
							worldInner.x + (dirX - dirY) * symbolRadius, worldInner.y + (dirY + dirX) * symbolRadius)
					]);
					break;
			}
		}

		const shape: PaintedShape = {
			type: 'segment',
			x1: worldOuter.x,
			y1: worldOuter.y,
			x2: lineEnd.x,
			y2: lineEnd.y,
			width
		};
		items.push({
			id, layer: 'Pins', kind: 'pin', shape, bbox: shapeToBBox(shape), hitTestable: true, element: pin,
			refDesignator,
			draw: (renderer, color) => {
				renderer.line([worldOuter, lineEnd], { strokeColor: color, strokeWidth: width });
				if (bubble) {
					renderer.circle(bubble, symbolRadius, { strokeColor: color, strokeWidth: width });
				}
				for (const deco of decorations) {
					renderer.line(deco, { strokeColor: color, strokeWidth: width });
				}
			}
		});

		const { name, number } = typeof pin.getPin === 'function' ? pin.getPin() : { name: '', number: '' };
		// Check pin_names (hide yes) from the library symbol, and individual
		// pin name = '~' (KiCad convention for a hidden name).
		const namesHidden = pinNamesHidden;
		// Pin name/number font size is per-pin data in the file (each pin's
		// `name`/`number` child carries its own `effects > font > size`) —
		// NOT a fixed KiCad convention. Transistor-style libraries commonly
		// specify a noticeably smaller size (e.g. 0.508mm) than the 1.27mm
		// default other libraries rely on implicitly by omitting it. Real
		// KiCad's own fallback (DefaultValues.pinname_size/pinnum_size) is
		// 1.27mm for BOTH, not number-smaller-than-name.
		const nameTextSize = readPinChildFontSize(pin, 'name', 1.27);
		const numberTextSize = readPinChildFontSize(pin, 'number', 1.27);
		const nameThickness = readPinChildFontThickness(pin, 'name', pinThickness);
		const numberThickness = readPinChildFontThickness(pin, 'number', pinThickness);
		// Which of the 4 cardinal directions the pin points, derived from
		// the already-robustly-computed world direction (ux,uy) rather than
		// re-deriving it from rotation/mirror attributes directly.
		const orientation = pinOrientationFromDir(ux, uy);
		// KiCad draws vertical-pin labels as genuinely rotated 90-degree
		// text (reading bottom-to-top), not by re-flipping horizontal text.
		const textAngle = orientation === 'up' || orientation === 'down' ? 90 : 0;
		if (name && name !== '~' && !namesHidden) {
			let local: Vec2;
			let hAlign: 'left' | 'center' | 'right';
			let vAlign: 'top' | 'center' | 'bottom';
			if (pinNameOffset > 0) {
				// Nonzero pin_names offset (op-amp/LM358 style): name sits
				// INSIDE the body, starting `pinNameOffset` past the pin's
				// inner (body) end. Ports KiCad's PinLabelInternals.place_inside().
				local = new Vec2(pinNameOffset - nameThickness / 2 + length, 0);
				hAlign = 'left';
				vAlign = 'center';
			}
			else {
				// `(pin_names (offset 0))` (transistor/simple-part style):
				// name renders ABOVE the pin, centered along its length.
				// Ports KiCad's PinLabelInternals.place_above().
				local = new Vec2(length / 2, -(pinTextMargin + pinThickness / 2 + nameThickness / 2));
				hAlign = 'center';
				vAlign = 'bottom';
			}
			const oriented = orientPinOffset(local, orientation);
			if (oriented.flipH && hAlign === 'left') {
				hAlign = 'right';
			}
			const namePos = new Vec2(worldOuter.x + oriented.offset.x, worldOuter.y + oriented.offset.y);
			const hAlignAnchor: Record<'left' | 'center' | 'right', number> = { left: 0, center: 0.5, right: 1 };
			const vAlignAnchor: Record<'top' | 'center' | 'bottom', number> = { top: 0, center: 0.5, bottom: 1 };
			const nameAnchor = { x: hAlignAnchor[hAlign], y: vAlignAnchor[vAlign] };
			const geometry = computeStrokeTextGeometry(
				name, namePos, nameTextSize, textAngle, false, undefined, nameAnchor);
			items.push(textItem(`${ id }:name`, 'Text', namePos, nameTextSize, pin, geometry, schColors.pinName));
		}
		if (number && number !== '~' && !pinNumbersHidden) {
			// Number is ALWAYS placed relative to the pin's centered midpoint
			// regardless of the pin_names offset style — above the pin when
			// offset>0 (since the name went inside the body), below it when
			// offset=0 (since the name took the "above" spot instead). Ports
			// KiCad's PinLabelInternals.place_above()/place_below().
			const local = pinNameOffset > 0
				? new Vec2(length / 2, -(pinTextMargin + pinThickness / 2 + numberThickness / 2))
				: new Vec2(length / 2, pinTextMargin + pinThickness / 2 + numberThickness / 2);
			const oriented = orientPinOffset(local, orientation);
			const numberPos = new Vec2(worldOuter.x + oriented.offset.x, worldOuter.y + oriented.offset.y);
			const numberAnchor = { x: 0.5, y: pinNameOffset > 0 ? 1 : 0 };
			const geometry = computeStrokeTextGeometry(
				number, numberPos, numberTextSize, textAngle, false, undefined, numberAnchor);
			items.push(
				textItem(`${ id }:number`, 'Text', numberPos, numberTextSize, pin, geometry, schColors.pinNumber));
		}

		return items;
	}

	// ---- Labels ----
	//
	// Faithfully ported from kicanvas's LabelPainter/GlobalLabelPainter/
	// HierarchicalLabelPainter (src/viewers/schematic/painters/label.ts) and
	// EDAText/SchText (src/kicad/text/{eda-text,sch-text}.ts) — kicanvas
	// documents itself as reproducing KiCad's own C++ painting logic. An
	// earlier version of this file guessed at label geometry (a fixed
	// margin + generic chevron for every label type, plus a home-grown
	// "flip the anchor when the angle normalizes past 180" rule) which was
	// wrong on two counts: (1) real KiCad text_angle is ALSO just normalized
	// to 0/90 (see set_spin_style_from_angle) but WITHOUT ever touching
	// h_align/v_align — apply_effects() runs AFTER that normalization and
	// unconditionally overwrites h_align/v_align with the file's own stored
	// `justify`, so a label rotated 180° already has the CORRECT justify
	// baked into the file by KiCad's own editor; re-deriving a flip on top
	// of that double-flips it. (2) global/hierarchical labels each have
	// their own real text-offset formula and their own real outline shape
	// (a 6-point flag for global labels, a 5-point arrow for hierarchical
	// ones, both varying by `shape`), not a fixed 1mm margin + tiny chevron.

	/** Plain local (net-name) labels have no registered @kicad-io class —
	 * read generically: attributes[0] is the label text, an `(at ...)`
	 * child still parses as a real KicadElementAt regardless. */
	protected buildLocalLabel(label: any): SchPaintedItem | null {
		// KicadElementLabel (typed class) moves its text into .value at parse
		// time, clearing .attributes — attributes[0] only ever held the raw
		// text back when local labels fell through to a generic, untyped
		// KicadElement (pre-typed-class gap). Check .value first.
		const name = (typeof label.value === 'string' && label.value)
			? label.value
			: label.attributes?.[0]?.value as string | undefined;
		if (!name) {
			return null;
		}
		const atEl = getAtClass() ? label.findFirstChildByClass(getAtClass()) : null;
		const x = atEl?.x ?? 0, y = atEl?.y ?? 0, rotation = atEl?.rotation ?? 0;
		const { size: textSize, thickness, italic } = readElementFontMetrics(label);
		// Real KiCad (SCH_LABEL_BASE::GetSchematicTextOffset) lifts a plain
		// net label clear of the wire it's attached to by text_offset_ratio
		// * text_size + the text's own stroke thickness — without this, the
		// label's anchor point IS the wire's connection point, so the text
		// renders right on top of the wire. Confirmed via a real KiCad
		// render: "PIEZO_IN" sat flush against its wire before this fix.
		const clearance = labelClearanceOffset(textSize, thickness, rotation);
		const worldPos = new Vec2(x + clearance.x, y + clearance.y);
		// text_angle normalizes to 0/90 only (never upside-down/backwards at
		// 180/270) — but h_align/v_align come straight from the file's own
		// `justify`, unmodified (see the block comment above).
		const textAngle = (rotation === 90 || rotation === 270) ? 90 : 0;
		const anchor = readJustifyAnchor(label);
		const geometry = computeStrokeTextGeometry(
			name, worldPos, textSize, textAngle, false, thickness, anchor, italic);
		// getUuid() (not an x/y/name-derived id) — matches every other
		// builder's convention, and is load-bearing here specifically:
		// translateElementById's caller (main.ts's drag loop) holds onto the
		// id for the whole gesture, but an x/y-derived id would change on
		// every intermediate scene rebuild as the label moves, breaking the
		// hit-test lookup after the first mousemove step.
		const id = typeof label.getUuid === 'function' && label.getUuid()
			? label.getUuid()
			: `local-label:${ x },${ y }:${ name }`;
		const bbox = getStrokeTextBounds(geometry);
		return {
			id,
			layer: 'Labels',
			kind: 'label',
			shape: { type: 'rect', ...bbox },
			bbox,
			hitTestable: true,
			element: label,
			labelName: name,
			labelKind: 'local',
			defaultColor: label.getFontColorOverride?.() ?? undefined,
			draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
		};
	}

	/**
	 * Global labels — ports GlobalLabelPainter.get_schematic_text_offset()
	 * (text position) + .create_shape() (the 6-point flag outline, a
	 * rectangle with the connection-point end shaped into an arrow/notch
	 * depending on `shape`).
	 */
	protected buildGlobalLabel(label: any): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];
		const name: string = typeof label.getName === 'function' ? label.getName() : '';
		if (!name) {
			return items;
		}
		const origin = label.getOrigin();
		const rotation = origin.rotation ?? 0;
		const shape: string = typeof label.getShape === 'function' ? label.getShape() : 'input';
		const { size: textSize, thickness, italic } = readElementFontMetrics(label);
		const worldOrigin = new Vec2(origin.x, origin.y);
		const { width: textWidth } = measureStrokeTextSize(name, textSize);

		const margin = labelBoxExpansionRatio * textSize; // get_box_expansion()
		let horz = margin;
		if (shape === 'input' || shape === 'bidirectional' || shape === 'tri_state') {
			// Accommodate the triangular tail these three shapes have.
			horz += textSize * 0.75;
		}
		const vert = textSize * 0.0715; // magic number from KiCad, accommodates overbars

		let textOffset: Vec2;
		switch (rotation) {
			case 90:
				textOffset = new Vec2(vert, -horz);
				break;
			case 180:
				textOffset = new Vec2(-horz, vert);
				break;
			case 270:
				textOffset = new Vec2(vert, horz);
				break;
			default:
				textOffset = new Vec2(horz, vert);
				break;
		}
		const worldTextPos = new Vec2(worldOrigin.x + textOffset.x, worldOrigin.y + textOffset.y);
		const textAngle = (rotation === 90 || rotation === 270) ? 90 : 0;
		const anchor = readJustifyAnchor(label);
		const geometry = computeStrokeTextGeometry(
			name, worldTextPos, textSize, textAngle, false, thickness, anchor, italic);
		const id = label.getUuid() ?? `label:${ origin.x },${ origin.y }`;
		const bbox = getStrokeTextBounds(geometry);
		// Same override color drives BOTH the text and its flag/arrow below —
		// real KiCad's label properties dialog has one unified color swatch
		// for a label, not separate text-vs-shape colors (unlike a text box,
		// where border/fill/text genuinely are 3 independent colors).
		const labelColor = label.getFontColorOverride?.() ?? schColors.labelGlobal;
		items.push({
			id: `${ id }:text`,
			layer: 'Labels',
			kind: 'label',
			shape: { type: 'rect', ...bbox },
			bbox,
			hitTestable: false,
			element: label,
			defaultColor: labelColor,
			draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
		});

		const halfSize = textSize / 2 + margin;
		const symbolLength = textWidth + 2 * margin;
		const x = symbolLength + thickness;
		const y = halfSize + thickness;
		const pts: { x: number; y: number }[] = [
			{ x: 0, y: 0 }, { x: 0, y: -y }, { x: -x, y: -y }, { x: -x, y: 0 }, { x: -x, y }, { x: 0, y },
			{ x: 0, y: 0 }
		];
		let offX = 0;
		if (shape === 'input') {
			offX = -halfSize;
			pts[0]!.x += halfSize;
			pts[6]!.x += halfSize;
		}
		else if (shape === 'output') {
			pts[3]!.x -= halfSize;
		}
		else if (shape === 'bidirectional' || shape === 'tri_state') {
			offX = -halfSize;
			pts[0]!.x += halfSize;
			pts[6]!.x += halfSize;
			pts[3]!.x -= halfSize;
		}
		const shapeRotation = rotation + 180;
		const worldPts = pts.map((p) => {
			const rotated = rotateLocalPoint({ x: p.x + offX, y: p.y }, shapeRotation);
			return new Vec2(rotated.x + worldOrigin.x, rotated.y + worldOrigin.y);
		});
		const flagShape: PaintedShape = { type: 'polygon', points: worldPts.map(p => ({ x: p.x, y: p.y })) };
		items.push({
			id: `${ id }:flag`, layer: 'Labels', kind: 'label', shape: flagShape, bbox: shapeToBBox(flagShape),
			hitTestable: true, element: label, defaultColor: labelColor,
			labelName: name, labelKind: 'global',
			draw: (renderer, color) => renderer.line(worldPts, { strokeColor: color, strokeWidth: thickness || 0.15 })
		});
		return items;
	}

	/** Hierarchical labels — ports HierarchicalLabelPainter. Also reused by
	 * buildSheet() for sheet pins, which kicanvas literally synthesizes as
	 * hierarchical labels (rotation flipped 180°, input/output swapped —
	 * see buildSheet()'s pin loop for why). */
	protected buildHierLabel(label: any): SchPaintedItem[] {
		const name: string = typeof label.getName === 'function' ? label.getName() : '';
		if (!name) {
			return [];
		}
		const origin = label.getOrigin();
		const rotation = origin.rotation ?? 0;
		const shape: string = typeof label.getShape === 'function' ? label.getShape() : 'input';
		const { size: textSize, thickness, italic } = readElementFontMetrics(label);
		const anchor = readJustifyAnchor(label);
		const id = label.getUuid() ?? `hlabel:${ origin.x },${ origin.y }`;
		return this.buildHierLabelShape(
			id, name, new Vec2(origin.x, origin.y), rotation, shape, textSize, thickness, anchor.x, label,
			schColors.labelHier,
			true, italic
		);
	}

	/**
	 * Shared geometry for a real hierarchical label AND a sheet pin
	 * synthesized as one — ports HierarchicalLabelPainter.
	 * get_schematic_text_offset() (dist = text_offset_ratio*width + width)
	 * and .create_shape() (the 5-point arrow, shape varying by `shape`).
	 * v_align is ALWAYS forced to center (HierarchicalLabelPainter.
	 * after_apply()), regardless of file justify — only h_align comes from
	 * the file/caller.
	 *
	 * IMPORTANT: KiCad's `schtext.text_width` here is NOT the measured
	 * width of the rendered string — EDAText.text_width is just an alias
	 * for `attributes.size.x`, i.e. the nominal FONT size (the same value
	 * as `textSize` below), regardless of how many characters the label
	 * has. An earlier version of this function used the actual measured
	 * string width instead, which made both the arrow AND the text-offset
	 * distance balloon with label name length — a 4-character name like
	 * "VOUT" produced an arrow 3x+ the correct size, with the text pushed
	 * proportionally far away from it. Real KiCad hierarchical-label arrows
	 * are always the same small fixed size regardless of name length; only
	 * the text itself gets longer.
	 */
	protected buildHierLabelShape(
		id: string, text: string, worldOrigin: Vec2, rotation: number, shape: string,
		textSize: number, thickness: number, hAlign: number, element: any, color: string,
		/** Both real, standalone hierarchical_labels AND buildSheet()'s
		 *  sheet-pin reuse of this shape are independently clickable+
		 *  draggable now — kept as its own parameter (rather than always
		 *  true) since flagHitTestable and labelKind used to be conflated
		 *  via one boolean and that's exactly the coupling that made a
		 *  sheet pin's dangling-detection tag ('sheet-pin', see
		 *  buildDanglingFlags) fragile to change independently of its
		 *  clickability — now they're two explicit parameters instead. */
		flagHitTestable = false,
		/** false for buildSheet()'s sheet-pin reuse — a raw KicadElementPin
		 *  has no (effects (font (italic …))) concept to read one from. */
		italic = false,
		labelKind: 'hier' | 'sheet-pin' = 'hier'
	): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];
		// Real, standalone hier labels can carry a font color override;
		// buildSheet()'s sheet-pin reuse passes a raw KicadElementPin here,
		// which has no (effects (font …)) child at all, so this safely
		// no-ops back to the passed-in theme `color` for that caller.
		const resolvedColor = element.getFontColorOverride?.() ?? color;
		// KiCad's own formula (text_offset_ratio * size + size, ~0.19mm of
		// clearance past the arrow's own edge for a 1.27mm label) is what's
		// ported here, but it renders as a genuinely touching/overlapping
		// gap with our Newstroke port in practice — confirmed by reproducing
		// a real-world case ("H", offset=0.19mm) where the glyph visibly
		// overlapped the arrow. Adding stroke thickness as extra clearance
		// (the same idea local NetLabel's own offset formula already uses)
		// is a pragmatic, small deviation from the byte-exact port to match
		// KiCad's actual VISUAL result rather than a formula that assumes
		// font metrics our stroke font doesn't precisely share. A first
		// attempt added just `thickness` (~0.15mm) and was still touching —
		// bumping to a flat extra half text-size's worth of clearance.
		const dist = textSize * (1 + labelTextOffsetRatio + 0.5) + thickness;

		// A sheet pin's stored rotation/shape match a plain hier label's for
		// the same signal exactly (see moveSheetPinById's doc comment) — but
		// its stored `justify` is the OPPOSITE of what a hier label uses for
		// that same rotation (confirmed against issue10926_1.kicad_sch: "IN"
		// sheet pin has `justify left`, the matching subsheet hier_label has
		// `justify right`, both at rotation 180). That only makes sense if
		// the text sits on the OPPOSITE side of the anchor too — a hier
		// label's text reads away from its wire stub into open canvas; a
		// sheet pin's text reads INTO the sheet box it's attached to, with
		// the small flag/chevron merely marking the exact border point. This
		// rotation is purely a rendering-side, container-relative flip
		// (which way is "inside"), NOT a file-format concept — it does not
		// affect what moveSheetPinById stores.
		const geomRotation = labelKind === 'sheet-pin' ? (rotation + 180) % 360 : rotation;

		let textOffset: Vec2;
		switch (geomRotation) {
			case 90:
				textOffset = new Vec2(0, -dist);
				break;
			case 180:
				textOffset = new Vec2(-dist, 0);
				break;
			case 270:
				textOffset = new Vec2(0, dist);
				break;
			default:
				textOffset = new Vec2(dist, 0);
				break;
		}
		const worldTextPos = new Vec2(worldOrigin.x + textOffset.x, worldOrigin.y + textOffset.y);
		const textAngle = (geomRotation === 90 || geomRotation === 270) ? 90 : 0;
		const anchor = { x: hAlign, y: 0.5 };
		const geometry = computeStrokeTextGeometry(
			text, worldTextPos, textSize, textAngle, false, thickness, anchor, italic);
		const bbox = getStrokeTextBounds(geometry);
		items.push({
			id: `${ id }:text`,
			layer: 'Labels',
			kind: 'label',
			shape: { type: 'rect', ...bbox },
			bbox,
			hitTestable: false,
			element,
			defaultColor: resolvedColor,
			draw: (renderer, drawColor) => drawStrokeTextGeometry(renderer, geometry, drawColor)
		});

		const s = textSize;
		let pts: { x: number; y: number }[];
		switch (shape) {
			case 'output':
				pts = [
					{ x: 0, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 },
					{ x: 0, y: -s / 2 }, { x: 0, y: s / 2 }
				];
				break;
			case 'input':
				pts = [
					{ x: s, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: 0, y: 0 }, { x: s / 2, y: -s / 2 },
					{ x: s, y: -s / 2 }, { x: s, y: s / 2 }
				];
				break;
			case 'bidirectional':
			case 'tri_state':
				pts = [
					{ x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 }, { x: 0, y: 0 },
					{ x: s / 2, y: s / 2 }
				];
				break;
			default: // passive
				pts = [
					{ x: 0, y: s / 2 }, { x: s, y: s / 2 }, { x: s, y: -s / 2 }, { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }
				];
				break;
		}
		const worldPts = pts.map((p) => {
			const rotated = rotateLocalPoint(p, geomRotation);
			return new Vec2(rotated.x + worldOrigin.x, rotated.y + worldOrigin.y);
		});
		const flagShape: PaintedShape = { type: 'polygon', points: worldPts.map(p => ({ x: p.x, y: p.y })) };
		items.push({
			id: `${ id }:flag`, layer: 'Labels', kind: 'label', shape: flagShape, bbox: shapeToBBox(flagShape),
			hitTestable: flagHitTestable, element, defaultColor: resolvedColor,
			// The explicit labelKind param (not derived from flagHitTestable
			// anymore) is what lets context-menu/other label-kind-dispatching
			// code keep treating a sheet pin differently from a real
			// hierarchical_label even though both are now independently
			// clickable+draggable — e.g. renameLabel()/setLabelShape() don't
			// apply to a raw KicadElementPin the way they do a real label,
			// so the right-click menu must still be able to tell them apart.
			labelName: labelKind === 'hier' ? text : undefined, labelKind,
			draw: (renderer, drawColor) => renderer.line(
				worldPts, { strokeColor: drawColor, strokeWidth: thickness || 0.15 })
		});
		return items;
	}

	/**
	 * Directive Label — UI/class name for the `netclass_flag` tag (see
	 * KicadElementNetclassFlag's doc comment). Ports
	 * SCH_DIRECTIVE_LABEL::CreateGraphicShape + SCH_PAINTER::
	 * draw(SCH_DIRECTIVE_LABEL*, ...) from the user's local KiCad checkout:
	 * a short pole from the anchor point to a small glyph at its tip —
	 * hollow circle (round), filled circle (dot), diamond outline, or
	 * rectangle outline, picked by `shape`. Visible properties (Netclass,
	 * and potentially a "Component Class" or other future ones) render as
	 * separate text items, same pattern as buildSheet()'s property loop
	 * below — reused rather than duplicated apart from the sheet-specific
	 * Sheetname/Sheetfile anchor hardcoding, which doesn't apply here.
	 */
	protected buildNetclassFlag(flag: any): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];
		const origin = flag.getOrigin();
		const rotation = origin.rotation ?? 0;
		const shape: string = typeof flag.getShape === 'function' ? flag.getShape() : 'round';
		const pinLength = typeof flag.getPinLength === 'function' ? flag.getPinLength() : 2.54;
		const worldOrigin = new Vec2(origin.x, origin.y);
		const id = flag.getUuid() ?? `netclass_flag:${ origin.x },${ origin.y }`;

		// File rotation (0/90/180/270) -> SPIN_STYLE (RIGHT/UP/LEFT/BOTTOM,
		// per the parser's parseSchText T_at case) -> degrees applied to the
		// shape's own LEFT-pointing local template — ported directly from
		// CreateGraphicShape's spin-style switch (LEFT: no rotation, UP: -90,
		// RIGHT: 180, BOTTOM: +90).
		const shapeRotation = rotation === 0 ? 180 : rotation === 90 ? 270 : rotation === 180 ? 0 : 90;
		const toWorld = (p: { x: number; y: number }): Vec2 => {
			const r = rotateLocalPoint(p, shapeRotation);
			return new Vec2(r.x + worldOrigin.x, r.y + worldOrigin.y);
		};

		const baseSize = 0.508; // m_symbolSize — eeschema's MilsToIU(20), a fixed constant (no file field for it)
		const width = 0.15;
		let hitShape: PaintedShape;
		let draw: (renderer: Renderer, color: string) => void;

		if (shape === 'round' || shape === 'dot') {
			const symbolSize = shape === 'dot' ? baseSize * 0.7 : baseSize;
			const lineStart = toWorld({ x: 0, y: 0 });
			const lineEnd = toWorld({ x: 0, y: pinLength - symbolSize });
			const circleCenter = toWorld({ x: 0, y: pinLength });
			hitShape = { type: 'circle', cx: circleCenter.x, cy: circleCenter.y, r: symbolSize };
			draw = (renderer, color) => {
				renderer.line([lineStart, lineEnd], { strokeColor: color, strokeWidth: width });
				if (shape === 'dot') {
					renderer.circle(circleCenter, symbolSize, { fillColor: color });
				}
				else {
					renderer.circle(circleCenter, symbolSize, { strokeColor: color, strokeWidth: width });
				}
			};
		}
		else {
			const symbolSize = shape === 'rectangle' ? baseSize * 0.8 : baseSize;
			const localPts = shape === 'diamond'
				? [
					{ x: 0, y: 0 }, { x: 0, y: pinLength - symbolSize }, { x: -2 * symbolSize, y: pinLength },
					{ x: 0, y: pinLength + symbolSize }, { x: 2 * symbolSize, y: pinLength },
					{ x: 0, y: pinLength - symbolSize }, { x: 0, y: 0 }
				]
				: [
					{ x: 0, y: 0 }, { x: 0, y: pinLength - symbolSize },
					{ x: -2 * symbolSize, y: pinLength - symbolSize },
					{ x: -2 * symbolSize, y: pinLength + symbolSize }, { x: 2 * symbolSize, y: pinLength + symbolSize },
					{ x: 2 * symbolSize, y: pinLength - symbolSize }, { x: 0, y: pinLength - symbolSize },
					{ x: 0, y: 0 }
				];
			const worldPts = localPts.map(toWorld);
			hitShape = { type: 'polygon', points: worldPts.map(p => ({ x: p.x, y: p.y })) };
			draw = (renderer, color) => renderer.line(worldPts, { strokeColor: color, strokeWidth: width });
		}

		// Same override color drives the pole/glyph AND its property text
		// below — same reasoning as buildGlobalLabel's labelColor (one
		// unified label color in real KiCad's dialog, not per-part colors).
		const flagColor = flag.getFontColorOverride?.() ?? schColors.labelDirective;
		items.push({
			id: `${ id }:flag`, layer: 'Labels', kind: 'label', shape: hitShape, bbox: shapeToBBox(hitShape),
			hitTestable: true, element: flag, labelKind: 'directive', defaultColor: flagColor, draw
		});

		if (typeof flag.getProperties === 'function') {
			for (const prop of flag.getProperties()) {
				const value: string | undefined = prop.propertyValue;
				if (!value || (typeof prop.isHidden === 'function' && prop.isHidden())) {
					continue;
				}
				const propOrigin = typeof prop.getOrigin === 'function' ? prop.getOrigin() :
					{ x: origin.x, y: origin.y, rotation: 0 };
				const worldPos = new Vec2(propOrigin.x, propOrigin.y);
				const { size: textSize, thickness, italic } = readElementFontMetrics(prop);
				const anchor = typeof prop.getAnchorPoint === 'function' ? prop.getAnchorPoint() : { x: 0, y: 1 };
				const geometry = computeStrokeTextGeometry(
					value, worldPos, textSize, propOrigin.rotation ?? 0, false, thickness, anchor, italic);
				const bbox = getStrokeTextBounds(geometry);
				items.push({
					id: `${ id }:prop:${ prop.propertyName }`, layer: 'Text', kind: 'text',
					shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: flag,
					defaultColor: flagColor,
					draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
				});
			}
		}

		return items;
	}

	// ---- Sheets ----

	/** KicadElementSheet lacks WithOrigin/WithSize (confirmed gap) — read
	 * its `at`/`size` children generically. Child schematic content is NOT
	 * loaded/rendered (see class doc comment) — just the sheet's own box,
	 * name, filename, and pin markers. */
	protected buildSheet(sheet: any): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];
		const atEl = getAtClass() ? sheet.findFirstChildByClass(getAtClass()) : null;
		const sizeEl = getSizeClass() ? sheet.findFirstChildByClass(getSizeClass()) : null;
		const x = atEl?.x ?? 0, y = atEl?.y ?? 0;
		const w = sizeEl?.width ?? 10, h = sizeEl?.height ?? 10;
		const id = sheet.getUuid() ?? `sheet:${ x },${ y }`;

		const shape: PaintedShape = { type: 'rect', x, y, w, h };
		items.push({
			id: `${ id }:box`, layer: 'Sheets', kind: 'sheet', shape, bbox: shape, hitTestable: true, element: sheet,
			draw: (renderer, color) => {
				// wDark renders hierarchical-sheet interiors as an opaque near-black
				// panel, distinct from the dark-gray schematic canvas. The color was
				// already part of the theme table but was never passed to rect().
				renderer.rect(new Vec2(x, y), w, h, {
					fillColor: schColors.sheetBackground,
					strokeColor: color,
					strokeWidth: 0.25
				});
			}
		});

		if (typeof sheet.getProperties === 'function') {
			for (const prop of sheet.getProperties()) {
				const value: string | undefined = prop.propertyValue;
				if (!value || (typeof prop.isHidden === 'function' && prop.isHidden())) {
					continue;
				}
				const propOrigin = typeof prop.getOrigin === 'function' ? prop.getOrigin() :
					{ x, y: y - 1, rotation: 0 };
				const worldPos = new Vec2(propOrigin.x, propOrigin.y);
				const isFilename = prop.propertyName === 'Sheetfile';
				const isSheetname = prop.propertyName === 'Sheetname';
				// Real KiCad always positions "Sheetname" ABOVE the sheet box
				// (bottom-anchored) and "Sheetfile" BELOW it (top-anchored) —
				// a fixed convention for these two auto-generated fields,
				// applied UNCONDITIONALLY rather than trusting the file's
				// stored `justify` — kicanvas's own PropertyPainter does the
				// same (it computes property text position/anchor from the
				// property's role, never from stored justify). A first
				// attempt here trusted justify when present and only
				// hardcoded the anchor as a fallback for missing justify;
				// that still overlapped on a real file that apparently
				// stores a justify value which doesn't yield the expected
				// visual result either. Hardcoding both fields' anchors
				// regardless of what's stored is more robust and matches
				// what real KiCad actually renders.
				const anchor = isSheetname
					? { x: 0, y: 1 }
					: isFilename
						? { x: 0, y: 0 }
						: (typeof prop.getAnchorPoint === 'function' ? prop.getAnchorPoint() : { x: 0, y: 1 });
				// readElementFontMetrics falls back to size:1.27 when the
				// property has no (effects (font …)) child at all — same
				// value this previously hardcoded unconditionally — so this
				// is a strict upgrade: real bold/italic/custom-size now
				// apply when present, with an identical fallback otherwise.
				const { size: textSize, thickness, italic } = readElementFontMetrics(prop);
				const geometry = computeStrokeTextGeometry(
					value, worldPos, textSize, propOrigin.rotation ?? 0, false, thickness, anchor, italic);
				const bbox = { x: worldPos.x - 2, y: worldPos.y - 2, w: 4, h: 4 };
				items.push({
					id: `${ id }:prop:${ prop.propertyName }`, layer: 'Text', kind: 'text',
					shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: sheet,
					defaultColor: isFilename ? schColors.sheetFilename : undefined,
					draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
				});
			}
		}

		// Sheet pins reuse KicadElementPin but with an incompatible
		// attribute layout (confirmed gap): attributes[0] is the pin's own
		// NAME (not electrical type), attributes[1] is the electrical-type-
		// like shape string, there's no `shape` child, and name is a raw
		// attribute rather than a child element — getType()/getPin() would
		// misparse this. Position (WithOrigin) still works fine since that
		// mixin is generic.
		//
		// The position and side rotation are stored in the same world
		// coordinate system as the sheet rectangle.  Sheet pins do have one
		// important rendering difference from ordinary hierarchical labels,
		// though: KiCad's SCH_SHEET_PIN::CreateGraphicShape swaps INPUT and
		// OUTPUT before passing the shape to SCH_HIERLABEL.  The swap makes the
		// flag body point into the sheet while its text remains outside.  If
		// the raw electrical shape is used directly, left/top pins visibly
		// render outside the sheet (and right/bottom pins point the wrong way).
		if (getPinClass()) {
			for (const pin of sheet.findChildrenByClass(getPinClass())) {
				const pinName = pin.attributes?.[0]?.value as string | undefined;
				if (!pinName) {
					continue;
				}
				const pinOrigin = typeof pin.getOrigin === 'function' ? pin.getOrigin() : { x, y, rotation: 0 };
				const pinShape = (pin.attributes?.[1]?.value as string) ?? 'passive';
				const sheetPinShape = pinShape === 'input'
					? 'output'
					: pinShape === 'output' ? 'input' : pinShape;
				const { size: pinTextSize, thickness: pinThickness } = readElementFontMetrics(pin);
				const anchor = readJustifyAnchor(pin);
				const markerId = pin.getUuid() ?? `${ id }:pin:${ pinOrigin.x },${ pinOrigin.y }`;
				for (const item of this.buildHierLabelShape(
					markerId, pinName, new Vec2(pinOrigin.x, pinOrigin.y), pinOrigin.rotation ?? 0, sheetPinShape,
					pinTextSize, pinThickness, anchor.x, pin, schColors.sheetLabel,
					true, false, 'sheet-pin'
				)) {
					items.push(item);
				}
			}
		}

		return items;
	}

	// ---- Tables ----

	/** Paint KiCad's root-level `(table ...)` object (KiCad 8+). */
	protected buildTable(table: any): SchPaintedItem[] {
		const cellsRoot = table.findFirstChildByName?.('cells');
		const cells = cellsRoot?.findChildrenByName?.('table_cell') ?? [];
		if (!cells.length) {
			return [];
		}
		const numberChild = (el: any, name: string, fallback = 0): number => {
			const value = el.findFirstChildByName?.(name)?.attributes?.[0]?.value;
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : fallback;
		};
		const yesChild = (el: any, name: string): boolean => {
			const value = el.findFirstChildByName?.(name)?.attributes?.[0]?.value;
			return value === true || value === 'yes';
		};
		const tableId = table.getUuid?.() ?? `table:${ cells[0]!.getUuid?.() ?? 'anonymous' }`;
		const columnCount = Math.max(1, Math.round(numberChild(table, 'column_count', 1)));
		const border = table.findFirstChildByName?.('border');
		const separators = table.findFirstChildByName?.('separators');
		const strokeFor = (owner: any) => {
			const stroke = owner?.findFirstChildByName?.('stroke');
			const width = Number(
				stroke?.getWidth?.() ?? stroke?.findFirstChildByName?.('width')?.attributes?.[0]?.value);
			const colorEl = stroke?.findFirstChildByName?.('color');
			return {
				width: Number.isFinite(width) && width > 0 ? width : pinThickness,
				type: String(stroke?.getType?.() ?? stroke?.findFirstChildByName?.('type')?.attributes?.[0]?.value
					?? 'solid') as KicadStrokeLineType,
				color: colorEl?.getColor?.() as string | undefined
			};
		};
		const borderStroke = strokeFor(border);
		const separatorStroke = strokeFor(separators);
		const strokeColumns = yesChild(separators, 'cols');
		const strokeRows = yesChild(separators, 'rows');
		const strokeExternal = yesChild(border, 'external');
		const strokeHeader = yesChild(border, 'header');

		type TableCell = {
			el: any; value: string; x: number; y: number; w: number; h: number;
			col: number; row: number; colSpan: number; rowSpan: number;
		};
		const parsedCells: TableCell[] = cells.map((cell: any, index: number) => {
			const at = cell.getOrigin?.() ?? cell.findFirstChildByName?.('at') ?? { x: 0, y: 0, rotation: 0 };
			const size = cell.findFirstChildByName?.('size');
			const span = cell.findFirstChildByName?.('span');
			return {
				el: cell,
				value: String(cell.value ?? cell.attributes?.[0]?.value ?? ''),
				x: Number(at.x) || 0,
				y: Number(at.y) || 0,
				w: Number(size?.width ?? size?.attributes?.[0]?.value) || 0,
				h: Number(size?.height ?? size?.attributes?.[1]?.value) || 0,
				col: index % columnCount,
				row: Math.floor(index / columnCount),
				colSpan: Math.max(0, Number(span?.attributes?.[0]?.value) || 1),
				rowSpan: Math.max(0, Number(span?.attributes?.[1]?.value) || 1)
			};
		}).filter((cell: TableCell) => cell.colSpan > 0 && cell.rowSpan > 0 && cell.w > 0 && cell.h > 0);
		if (!parsedCells.length) {
			return [];
		}

		const minX = Math.min(...parsedCells.map(cell => cell.x));
		const minY = Math.min(...parsedCells.map(cell => cell.y));
		const maxX = Math.max(...parsedCells.map(cell => cell.x + cell.w));
		const maxY = Math.max(...parsedCells.map(cell => cell.y + cell.h));
		const bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
		const items: SchPaintedItem[] = [];

		for (const cell of parsedCells) {
			const margins = cell.el.findFirstChildByName?.('margins')?.attributes ?? [];
			const margin = (index: number) => Number(margins[index]?.value) || 0;
			const left = margin(0), right = margin(1), top = margin(2), bottom = margin(3);
			const fill = cell.el.findFirstChildByName?.('fill');
			const fillType = String(
				fill?.getType?.() ?? fill?.findFirstChildByName?.('type')?.attributes?.[0]?.value ?? 'none');
			const colorEl = fill?.findFirstChildByName?.('color');
			const fillColor = fillType === 'color'
				? (colorEl?.getColor?.() ?? schColors.componentBody)
				: fillType === 'background' ? schematicBackgroundColor : undefined;
			if (fillColor) {
				items.push({
					id: `${ tableId }:cell:${ cell.el.getUuid?.() ?? `${ cell.row },${ cell.col }` }:fill`,
					layer: 'Graphics',
					kind: 'table',
					shape: { type: 'rect', x: cell.x, y: cell.y, w: cell.w, h: cell.h },
					bbox: { x: cell.x, y: cell.y, w: cell.w, h: cell.h },
					hitTestable: false,
					element: cell.el,
					draw: renderer => renderer.rect(new Vec2(cell.x, cell.y), cell.w, cell.h, { fillColor })
				});
			}
			if (cell.value) {
				const { size: textSize, thickness, italic } = readElementFontMetrics(cell.el);
				const anchor = readJustifyAnchor(cell.el);
				const contentW = Math.max(0, cell.w - left - right);
				const contentH = Math.max(0, cell.h - top - bottom);
				const position = new Vec2(cell.x + left + anchor.x * contentW, cell.y + top + anchor.y * contentH);
				const rotation = cell.el.getOrigin?.().rotation ?? 0;
				// ${ROW}/${COL}/${ADDR} are only meaningful inside a table
				// cell's own text — real KiCad's help text documents them as
				// 0-based, ADDR = spreadsheet-style column letter + row number
				// (e.g. col 1, row 5 → "B5").
				const cellValue = this.expandText(cell.value, {
					ROW: String(cell.row), COL: String(cell.col), ADDR: `${ columnLetter(cell.col) }${ cell.row }`
				});
				const wrappedValue = wrapTableCellText(cellValue, contentW, textSize);
				const geometry = computeStrokeTextGeometry(
					wrappedValue, position, textSize, rotation, false, thickness, anchor, italic);
				items.push({
					id: `${ tableId }:cell:${ cell.el.getUuid?.() ?? `${ cell.row },${ cell.col }` }:text`,
					layer: 'Graphics',
					kind: 'text',
					shape: { type: 'rect', x: cell.x, y: cell.y, w: cell.w, h: cell.h },
					bbox: { x: cell.x, y: cell.y, w: cell.w, h: cell.h },
					hitTestable: false,
					element: cell.el,
					defaultColor: schColors.note,
					draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color)
				});
			}
		}

		const lines: Array<{ a: Vec2; b: Vec2; stroke: ReturnType<typeof strokeFor> }> = [];
		const addLine = (a: Vec2, b: Vec2, stroke: ReturnType<typeof strokeFor>) => lines.push({ a, b, stroke });
		const rowCount = Math.ceil(cells.length / columnCount);
		for (const cell of parsedCells) {
			if (cell.col + cell.colSpan < columnCount && (strokeColumns || (cell.row === 0 && strokeHeader))) {
				addLine(
					new Vec2(cell.x + cell.w, cell.y), new Vec2(cell.x + cell.w, cell.y + cell.h),
					cell.row === 0 && strokeHeader ? borderStroke : separatorStroke
				);
			}
			if (cell.row + cell.rowSpan < rowCount && (strokeRows || (cell.row === 0 && strokeHeader))) {
				addLine(
					new Vec2(cell.x, cell.y + cell.h), new Vec2(cell.x + cell.w, cell.y + cell.h),
					cell.row === 0 && strokeHeader ? borderStroke : separatorStroke
				);
			}
		}
		if (strokeExternal) {
			addLine(new Vec2(minX, minY), new Vec2(maxX, minY), borderStroke);
			addLine(new Vec2(maxX, minY), new Vec2(maxX, maxY), borderStroke);
			addLine(new Vec2(maxX, maxY), new Vec2(minX, maxY), borderStroke);
			addLine(new Vec2(minX, maxY), new Vec2(minX, minY), borderStroke);
		}
		items.push({
			id: `${ tableId }:borders`,
			layer: 'Graphics',
			kind: 'table',
			shape: { type: 'rect', ...bbox, filled: true },
			bbox,
			hitTestable: true,
			element: table,
			draw: (renderer, color) => {
				for (const line of lines) {
					const lineColor = line.stroke.color || color;
					strokeDashedPolyline([line.a, line.b], line.stroke.width, line.stroke.type, segment =>
						renderer.line(segment, { strokeColor: lineColor, strokeWidth: line.stroke.width })
					);
				}
			}
		});
		return items;
	}

	// ---- Dangling-end indicators (unconnected wire/pin/label markers) ----

	/**
	 * Real KiCad's own SCH_SCREEN::TestDanglingEnds() (confirmed by reading
	 * it in the user's local KiCad checkout) is pure point coincidence — no
	 * net/ERC analysis: an endpoint is "dangling" unless ANOTHER connectable
	 * item's endpoint sits at the exact same point. (A wire T-ing into the
	 * MIDDLE of another wire with no junction dot placed there still counts
	 * as dangling — that's WHY real KiCad makes you drop a junction for a
	 * 3-way/T connection; this mirrors that, deliberately NOT doing a general
	 * segment-containment test.) Built from every already-computed paint
	 * item's own resolved world coordinates — no separate AST walk or
	 * re-transform needed, e.g. buildPin() already did the symbol-instance
	 * math once, so this just reads shape.x1/y1 back off its paint item.
	 *
	 * ONE deliberate, source-verified exception to "exact coincidence only":
	 * a bus entry tapping into a bus at an arbitrary point along its length
	 * does NOT need an exact endpoint/junction there — real KiCad doesn't
	 * require one either (eeschema/sch_bus_entry.cpp's
	 * SCH_BUS_WIRE_ENTRY::UpdateDanglingState does an explicit point-on-
	 * segment test against the bus, unlike the wire-to-wire case). See
	 * liesOnAnyBusSpan() below.
	 *
	 * Markers match real KiCad exactly (same source): a hollow square on a
	 * dangling wire/bus/label end (DANGLING_SYMBOL_SIZE, eeschema/
	 * default_values.h) via drawDanglingIndicator(), a hollow circle on a
	 * dangling pin (TARGET_PIN_RADIUS = 15 mils, eeschema/sch_pin.h) via
	 * drawPinDanglingIndicator() — both eeschema/sch_painter.cpp. No-connect
	 * markers and junctions are occupants only (they satisfy some OTHER
	 * item's coincidence check) — they never carry a dangling flag
	 * themselves; a pin under a no-connect marker is exactly the
	 * "deliberately left open" case that marker exists to silence.
	 */
	protected buildDanglingFlags(layerBuckets: Map<string, SchPaintedItem[]>): SchPaintedItem[] {
		const occupants = new Map<string, number>();
		const bump = (x: number, y: number) => {
			const key = pointKey(x, y);
			occupants.set(key, (occupants.get(key) ?? 0) + 1);
		};

		const wireLike = layerBuckets.get('Wires') ?? [];
		const pins = layerBuckets.get('Pins') ?? [];
		const junctions = layerBuckets.get('Junctions') ?? [];
		const noConnects = layerBuckets.get('NoConnects') ?? [];
		// Global/hier labels contribute 2 items (a non-hitTestable :text item
		// plus a hitTestable :flag item) sharing one element — filtering to
		// hitTestable gives exactly one representative per logical label,
		// same trick buildPlaceSubmenu-adjacent code elsewhere relies on.
		// Sheet pins are the one deliberate exception: buildHierLabelShape's
		// sheet-pin reuse tags its :flag item labelKind:'sheet-pin' while
		// keeping hitTestable:false (a pin isn't independently selectable
		// apart from its sheet) — included here anyway because a sheet pin
		// IS a real electrical connection point, and excluding it from this
		// map meant a wire/label/anything else landing exactly on one could
		// never find it "occupied", so it (and the sheet pin itself) always
		// showed dangling even when genuinely connected.
		const labels = (layerBuckets.get('Labels') ?? [])
			.filter(it => it.kind === 'label' && (it.hitTestable || it.labelKind === 'sheet-pin'));

		for (const item of wireLike) {
			if (item.shape.type !== 'segment') {
				continue;
			}
			bump(item.shape.x1, item.shape.y1);
			bump(item.shape.x2, item.shape.y2);
		}
		for (const item of pins) {
			if (item.shape.type !== 'segment') {
				continue;
			}
			bump(item.shape.x1, item.shape.y1); // x1/y1 is always worldOuter — see buildPin
		}
		for (const item of junctions) {
			if (item.shape.type !== 'circle') {
				continue;
			}
			bump(item.shape.cx, item.shape.cy);
		}
		for (const item of noConnects) {
			bump(item.bbox.x + item.bbox.w / 2, item.bbox.y + item.bbox.h / 2);
		}
		for (const item of labels) {
			const origin = typeof item.element?.getOrigin === 'function' ? item.element.getOrigin() : null;
			if (origin) {
				bump(origin.x, origin.y);
			}
		}

		// <= 1 (not === 1): a point should never be un-occupied by the time
		// this checks it (the item itself always bumped its own point first),
		// but treating "somehow 0" the same as "just myself" is a harmless
		// belt-and-suspenders rather than a silent divide-by-assumption bug.
		const isDangling = (x: number, y: number) => (occupants.get(pointKey(x, y)) ?? 0) <= 1;
		const buses = wireLike.filter(it => it.kind === 'bus' && it.shape.type === 'segment');
		// A bus entry taps a bus at an arbitrary point along its length — real
		// KiCad doesn't require an exact endpoint/junction there (unlike
		// wire-to-wire), just for the point to lie ANYWHERE on the bus's span
		// (eeschema/sch_bus_entry.cpp's SCH_BUS_WIRE_ENTRY::UpdateDanglingState,
		// confirmed in the user's local checkout). Bus entries are the only
		// 'wire'-kind item with getSize() (buildBusEntry uses getOrigin+
		// getSize; plain wires/buses use getPoints) — no separate kind needed
		// to tell them apart.
		const liesOnAnyBusSpan = (x: number, y: number): boolean =>
			buses.some(bus => bus.shape.type === 'segment'
				&& distanceToSegment(x, y, bus.shape.x1, bus.shape.y1, bus.shape.x2, bus.shape.y2)
				< JUNCTION_POINT_EPS);
		// A directive label (netclass_flag) anchored on a rule area's border
		// is considered "connected" to it even with no wire touching either —
		// confirmed in the user's local checkout:
		// SCH_DIRECTIVE_LABEL::IsDangling() (sch_label.cpp) is
		// `m_isDangling && m_connected_rule_areas.empty()`, and
		// SCH_RULE_AREA::RefreshContainedItemsAndDirectives (sch_rule_area.cpp)
		// populates that set via `GetPolyShape().CollideEdge(label's anchor
		// point, nullptr, 5)` — an anchor-vs-polygon-EDGE test, same shape as
		// the bus-entry exception above, just against a (possibly
		// multi-sided) rule area outline instead of a single bus segment.
		const ruleAreaPolygons = (layerBuckets.get('RuleAreas') ?? [])
			.map(it => it.shape)
			.filter((s): s is Extract<PaintedShape, { type: 'polygon' }> => s.type === 'polygon');
		const liesOnAnyRuleAreaBorder = (x: number, y: number): boolean =>
			ruleAreaPolygons.some(shape => polygonEdgeDistance(shape.points, shape.closed, x, y) < JUNCTION_POINT_EPS);
		// A label (local/global/hier/directive — anything SCH_LABEL_BASE-
		// derived in real KiCad) connects to a wire/bus it merely touches
		// anywhere along its span, no junction dot required — unlike
		// wire-to-wire T-connections. Confirmed in the user's local checkout:
		// SCH_LABEL_BASE::UpdateDanglingState (sch_label.cpp) falls through
		// exact-point coincidence to a TestSegmentHit() against every BUS_END
		// then WIRE_END pair after point-coincidence fails. Same shape as the
		// bus-entry-on-bus-span exception above, just against wires too and
		// scoped to labels only (wires keep needing an exact endpoint/
		// junction against each other).
		const wireAndBusSegments = wireLike.filter(it =>
			(it.kind === 'wire' || it.kind === 'bus') && it.shape.type === 'segment');
		const liesOnAnyWireOrBusSpan = (x: number, y: number): boolean =>
			wireAndBusSegments.some(seg => seg.shape.type === 'segment'
				&& distanceToSegment(x, y, seg.shape.x1, seg.shape.y1, seg.shape.x2, seg.shape.y2)
				< JUNCTION_POINT_EPS);
		const flags: SchPaintedItem[] = [];

		for (const item of wireLike) {
			if (item.shape.type !== 'segment') {
				continue;
			}
			const isBusEntry = typeof item.element?.getSize === 'function';
			const color = brightenColor(item.defaultColor ?? colorForKind(item.kind), 0.3);
			if (isDangling(item.shape.x1, item.shape.y1) && !(isBusEntry && liesOnAnyBusSpan(
				item.shape.x1, item.shape.y1))) {
				flags.push(
					danglingSquare(`${ item.id }:dangling:start`, item.shape.x1, item.shape.y1, color, item.element));
			}
			if (isDangling(item.shape.x2, item.shape.y2) && !(isBusEntry && liesOnAnyBusSpan(
				item.shape.x2, item.shape.y2))) {
				flags.push(
					danglingSquare(`${ item.id }:dangling:end`, item.shape.x2, item.shape.y2, color, item.element));
			}
		}
		for (const item of pins) {
			if (item.shape.type !== 'segment' || !isDangling(item.shape.x1, item.shape.y1)) {
				continue;
			}
			const color = brightenColor(colorForKind('pin'), 0.3);
			flags.push(danglingCircle(`${ item.id }:dangling`, item.shape.x1, item.shape.y1, color, item.element));
		}
		for (const item of labels) {
			const origin = typeof item.element?.getOrigin === 'function' ? item.element.getOrigin() : null;
			if (!origin || !isDangling(origin.x, origin.y)) {
				continue;
			}
			if (liesOnAnyWireOrBusSpan(origin.x, origin.y)) {
				continue;
			}
			if (item.labelKind === 'directive' && liesOnAnyRuleAreaBorder(origin.x, origin.y)) {
				continue;
			}
			const color = brightenColor(item.defaultColor ?? colorForKind('label'), 0.3);
			flags.push(danglingSquare(`${ item.id }:dangling`, origin.x, origin.y, color, item.element));
		}

		return flags;
	}
}

// Real KiCad dangling-indicator constants, confirmed in the user's local
// KiCad checkout (not guessed): DANGLING_SYMBOL_SIZE = 12 mils
// (eeschema/default_values.h — "size of the rectangle indicating an
// unconnected wire or label"), converted to the ~half-extent SCH_PAINTER
// actually draws (own stroke half-width + 6 mils); TARGET_PIN_RADIUS = 15
// mils (eeschema/sch_pin.h), a FIXED radius independent of pin width.
const DANGLING_SQUARE_HALF = 0.23; // mm
const DANGLING_CIRCLE_RADIUS = 0.381; // mm — 15 mils
const DANGLING_STROKE_WIDTH = pinThickness;
// 0.001mm — matches the precision real schematic coordinates actually carry.
const JUNCTION_POINT_EPS = 1e-3;

/** Spreadsheet-style 0-based column → letter(s): 0→A, 25→Z, 26→AA, ... —
 *  used by ${ADDR} in table-cell text expansion. */
function columnLetter(col: number): string {
	let n = col;
	let letters = '';
	do {
		letters = String.fromCharCode(65 + (n % 26)) + letters;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return letters;
}

function pointKey(x: number, y: number): string {
	// Quantized to 0.0001mm — absorbs float noise from rotation/mirror
	// transforms without merging any two points a real schematic would
	// actually treat as distinct (KiCad's own grid never goes finer than
	// 0.01mm).
	return `${ Math.round(x * 10000) },${ Math.round(y * 10000) }`;
}

/** Ports COLOR4D::Brightened() — blend toward white by `factor`. Real KiCad
 * brightens dangling indicators specifically so they stay visible when they
 * overlap a same-colored junction dot; matched here for the same reason. */
function brightenColor(rgb: string, factor: number): string {
	const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(rgb);
	if (!m) {
		return rgb;
	}
	const mix = (c: number) => Math.round(c + (255 - c) * factor);
	return `rgb(${ mix(Number(m[1])) }, ${ mix(Number(m[2])) }, ${ mix(Number(m[3])) })`;
}

function danglingSquare(id: string, x: number, y: number, color: string, element: any): SchPaintedItem {
	const half = DANGLING_SQUARE_HALF;
	const shape: PaintedShape = { type: 'rect', x: x - half, y: y - half, w: half * 2, h: half * 2 };
	return {
		id, layer: 'Dangling', kind: 'dangling', shape, bbox: shape, hitTestable: false, element,
		defaultColor: color,
		draw: (renderer, drawColor) => {
			renderer.rect(
				new Vec2(x - half, y - half), half * 2, half * 2,
				{ strokeColor: drawColor, strokeWidth: DANGLING_STROKE_WIDTH }
			);
		}
	};
}

function danglingCircle(id: string, x: number, y: number, color: string, element: any): SchPaintedItem {
	const shape: PaintedShape = { type: 'circle', cx: x, cy: y, r: DANGLING_CIRCLE_RADIUS };
	return {
		id, layer: 'Dangling', kind: 'dangling', shape, bbox: shapeToBBox(shape), hitTestable: false, element,
		defaultColor: color,
		draw: (renderer, drawColor) => {
			renderer.circle(
				new Vec2(x, y), DANGLING_CIRCLE_RADIUS, { strokeColor: drawColor, strokeWidth: DANGLING_STROKE_WIDTH });
		}
	};
}

// KiCad's DefaultValues.label_size_ratio, used by global labels' box
// expansion (the margin around the text inside the flag shape).
const labelBoxExpansionRatio = 0.375;

/** Rotates a local (x,y) point by a world rotation in degrees, using the
 * SAME sign convention already established (and verified against real
 * renders) for pin/label direction elsewhere in this file: local +x at
 * rotation 0 maps to world (1,0); at rotation 90 ("up") it maps to world
 * (0,-1). Schematic-level items (labels, sheets) use this directly — unlike
 * symbol-local geometry (flippedTransform), there's no library Y-flip to
 * compensate for here. */
function rotateLocalPoint(p: { x: number; y: number }, rotationDeg: number): Vec2 {
	const rad = Angle.degToRad(rotationDeg);
	const cos = Math.cos(rad), sin = Math.sin(rad);
	return new Vec2(p.x * cos + p.y * sin, -p.x * sin + p.y * cos);
}

/** Draws a graphic item's outline stroke, honoring its KiCad stroke line
 * type (solid/dash/dot/dash_dot/dash_dot_dot) via strokeDashedPolyline. Pass
 * an already-closed ring (first point repeated at the end) for closed
 * shapes — this never appends a closing point itself, since circleToRing()
 * and the rect/polygon corner lists already do. */
function drawStrokeOutline(
	renderer: Renderer, ring: Vec2[], width: number, lineType: KicadStrokeLineType, color: string): void {
	strokeDashedPolyline(ring, width, lineType, (segment) => {
		renderer.line(segment, { strokeColor: color, strokeWidth: width || 0.1 });
	});
}

/** Flattens a cubic Bézier using de Casteljau subdivision. Affine transforms
 * preserve Bézier curves, so callers may pass either schematic-space or
 * already-transformed symbol-space control points. */
function cubicBezierToPolyline(start: Vec2, control1: Vec2, control2: Vec2, end: Vec2): Vec2[] {
	const points = [start];
	const midpoint = (a: Vec2, b: Vec2) => new Vec2((a.x + b.x) / 2, (a.y + b.y) / 2);
	const flatten = (a: Vec2, b: Vec2, c: Vec2, d: Vec2, depth: number): void => {
		const flatness = Math.max(
			distanceToSegment(b.x, b.y, a.x, a.y, d.x, d.y),
			distanceToSegment(c.x, c.y, a.x, a.y, d.x, d.y)
		);
		if (depth >= 10 || flatness <= 0.05) {
			points.push(d);
			return;
		}
		const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
		const abc = midpoint(ab, bc), bcd = midpoint(bc, cd);
		const split = midpoint(abc, bcd);
		flatten(a, ab, abc, split, depth + 1);
		flatten(split, bcd, cd, d, depth + 1);
	};
	flatten(start, control1, control2, end, 0);
	return points;
}

/** Identifies the image formats KiCad embeds and reads their pixel extent
 * without waiting for browser image decoding. This keeps hit testing and the
 * initial fit-to-page correct even while the actual texture loads. */
function embeddedImageInfo(data: string): {
	width: number;
	height: number;
	mimeType: string;
	ppi: number;
	legacyPpi: number
} | null {
	const byteAt = (index: number) => index < data.length ? data.charCodeAt(index) & 0xff : 0;
	const be16 = (index: number) => (byteAt(index) << 8) | byteAt(index + 1);
	const be32 = (index: number) => ((byteAt(index) * 0x1000000) + (byteAt(index + 1) << 16) + (byteAt(index + 2) << 8)
		+ byteAt(index + 3)) >>> 0;
	const le16 = (index: number) => byteAt(index) | (byteAt(index + 1) << 8);
	// PNG signature + IHDR width/height. KiCad reads pHYs' pixels-per-meter
	// metadata as pixels/cm, then rounds pixels/cm × 2.54 to integer PPI.
	if (data.length >= 24 && byteAt(0) === 0x89 && byteAt(1) === 0x50 && byteAt(2) === 0x4e && byteAt(3) === 0x47) {
		let ppi = 300;
		let legacyPpi = 300;
		let chunk = 8;
		while (chunk + 12 <= data.length) {
			const length = be32(chunk);
			if (length > data.length - chunk - 12) {
				break;
			}
			if (data.slice(chunk + 4, chunk + 8) === 'pHYs' && length >= 9 && byteAt(chunk + 8 + 8) === 1) {
				const pixelsPerMeter = be32(chunk + 8);
				const parsedPpi = Math.round((pixelsPerMeter / 100) * 2.54);
				const parsedLegacyPpi = Math.round(Math.floor(pixelsPerMeter / 100) * 2.54);
				if (parsedPpi > 1) {
					ppi = parsedPpi;
				}
				if (parsedLegacyPpi > 1) {
					legacyPpi = parsedLegacyPpi;
				}
				break;
			}
			chunk += length + 12;
		}
		return { width: be32(16), height: be32(20), mimeType: 'image/png', ppi, legacyPpi };
	}
	// GIF logical screen descriptor.
	if (data.length >= 10 && data.slice(0, 3) === 'GIF') {
		return { width: le16(6), height: le16(8), mimeType: 'image/gif', ppi: 300, legacyPpi: 300 };
	}
	// JPEG dimensions live in a Start Of Frame segment. Skip APP/comment
	// sections until the first supported baseline/progressive SOF marker. A
	// JFIF APP0 segment may also carry the physical pixel density that KiCad
	// exposes as its image PPI.
	if (data.length >= 4 && byteAt(0) === 0xff && byteAt(1) === 0xd8) {
		let index = 2;
		let ppi = 300;
		while (index + 8 < data.length) {
			if (byteAt(index) !== 0xff) {
				index++;
				continue;
			}
			while (byteAt(index) === 0xff) {
				index++;
			}
			const marker = byteAt(index++);
			if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
				continue;
			}
			const length = be16(index);
			if (length < 2 || index + length > data.length) {
				break;
			}
			const segmentData = index + 2;
			if (marker === 0xe0 && length >= 14 && data.slice(segmentData, segmentData + 5) === 'JFIF\0') {
				const unit = byteAt(segmentData + 7);
				const density = be16(segmentData + 8);
				const parsedPpi = unit === 1 ? density : unit === 2 ? Math.round(density * 2.54) : 0;
				if (parsedPpi > 1) {
					ppi = parsedPpi;
				}
			}
			if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker
				<= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
				return { width: be16(index + 5), height: be16(index + 3), mimeType: 'image/jpeg', ppi, legacyPpi: ppi };
			}
			index += length;
		}
	}
	return null;
}

// KiCad's SCH_TEXT::GetTextOffset ratio (DefaultValues.text_offset_ratio),
// reused here for local net labels' wire clearance.
const labelTextOffsetRatio = 0.15;

/** Reads a label element's own font size/thickness — works for both real
 * registered classes (GlobalLabel/HierLabel, which have a typed getFont()
 * via WithEffects) and the plain `label` tag (an untyped generic
 * KicadElement, confirmed gap — read via findFirstChildByName instead). */
// Real KiCad only auto-derives a pen width FROM bold/size when the item has
// no explicit stroke-width override (common/eda_text.cpp: GetPenSizeForBold
// = size/5, GetPenSizeForNormal = size/8, confirmed in the user's local
// checkout). This app's own pinThickness (0.1524mm, a flat DefaultValues.
// line_width constant) is the pre-existing NORMAL-case fallback here — kept
// as-is rather than switched to the size-derived size/8 formula, to avoid
// changing how every already-working non-bold text item currently renders.
// Only the BOLD case is new: it substitutes the real size/5 formula instead
// of the flat constant, since bold text needs a visibly thicker stroke than
// pinThickness already provides to actually read as "bold" at typical zoom.
function boldPenWidth(sizeMm: number): number {
	return sizeMm / 5;
}

function readElementFontMetrics(el: any): { size: number; thickness: number; bold: boolean; italic: boolean } {
	if (typeof el.getFont === 'function') {
		const font = el.getFont();
		if (font.height > 0) {
			const bold = !!font.bold;
			return {
				size: font.height,
				thickness: font.thickness || (bold ? boldPenWidth(font.height) : pinThickness),
				bold,
				italic: !!font.italic
			};
		}
	}
	const effects = typeof el.findFirstChildByName === 'function' ? el.findFirstChildByName('effects') : null;
	const font = effects && typeof effects.findFirstChildByName === 'function' ? effects.findFirstChildByName('font') :
		null;
	if (font) {
		const size = typeof font.getSize === 'function' ? font.getSize() : null;
		const thickness = typeof font.getThickness === 'function' ? font.getThickness() : 0;
		const bold = typeof font.getBold === 'function' ? !!font.getBold() : false;
		const italic = typeof font.getItalic === 'function' ? !!font.getItalic() : false;
		if (size && size.height > 0) {
			return {
				size: size.height,
				thickness: thickness || (bold ? boldPenWidth(size.height) : pinThickness),
				bold,
				italic
			};
		}
	}
	return { size: 1.27, thickness: pinThickness, bold: false, italic: false };
}

/**
 * How far, and in which direction, to lift a label's text off of the wire
 * endpoint it's anchored to — ports KiCad's
 * SCH_LABEL_BASE::GetSchematicTextOffset(): a fixed clearance (a ratio of
 * the label's own text size, plus its stroke thickness) applied
 * perpendicular to the label's reading direction — always "up" for a
 * horizontal label, always "left" for a vertical one, regardless of which
 * way (0/180 or 90/270) the label itself reads.
 */
function labelClearanceOffset(textSize: number, thickness: number, rotationDeg: number): Vec2 {
	const dist = labelTextOffsetRatio * textSize + thickness;
	const normalized = ((rotationDeg % 180) + 180) % 180;
	const isVertical = Math.abs(normalized - 90) < 1;
	return isVertical ? new Vec2(-dist, 0) : new Vec2(0, -dist);
}

function textItem(
	id: string, layer: string, worldPos: Vec2, textSize: number, element: any,
	geometry: ReturnType<typeof computeStrokeTextGeometry>, defaultColor: string
): SchPaintedItem {
	const bbox = getStrokeTextBounds(geometry);
	return {
		id, layer, kind: 'text', shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element, defaultColor,
		draw: (renderer, drawColor) => drawStrokeTextGeometry(renderer, geometry, drawColor)
	};
}

/**
 * KiCad table cells are text boxes: their text wraps to the usable cell width
 * (after margins), unlike ordinary schematic text. Measure against the same
 * stroke font used to paint the result so wrapping stays correct for narrow
 * glyphs, wide glyphs, and escaped KiCad characters alike.
 */
function wrapTableCellText(value: string, maxWidthMm: number, textSizeMm: number): string {
	if (!(maxWidthMm > 0) || !value) {
		return value;
	}
	const fits = (text: string) => measureStrokeTextSize(text, textSizeMm).width <= maxWidthMm + 1e-6;
	const lines: string[] = [];
	for (const sourceLine of value.split('\n')) {
		if (!sourceLine.trim()) {
			lines.push('');
			continue;
		}
		let line = '';
		for (const word of sourceLine.trim().split(/\s+/)) {
			const candidate = line ? `${ line } ${ word }` : word;
			if (fits(candidate)) {
				line = candidate;
				continue;
			}
			if (line) {
				lines.push(line);
				line = '';
			}
			// KiCad also prevents a single unbroken token from overflowing a
			// cell. Split it at glyph boundaries when there is no whitespace
			// opportunity (URLs, reference designators, generated variables).
			let fragment = '';
			for (const char of Array.from(word)) {
				const expanded = fragment + char;
				if (fragment && !fits(expanded)) {
					lines.push(fragment);
					fragment = char;
				}
				else {
					fragment = expanded;
				}
			}
			line = fragment;
		}
		lines.push(line);
	}
	return lines.join('\n');
}

/** Ports LIB_SYMBOL::LetterSubReference (lib_symbol.cpp) — the per-unit
 * letter real KiCad appends to a multi-unit symbol's displayed reference
 * ("U1" unit 1 → "U1A", unit 2 → "U1B", ...). Base-26 "spreadsheet column"
 * style: 1..26 → A..Z, 27 → AA, 28 → AB, etc. (26-unit parts are rare but
 * the wraparound is cheap to keep faithful to the source). `unit` must be
 * >= 1 — real KiCad's own caller-side guard (SCHEMATIC_SETTINGS::
 * SubReference's `if (aUnit < 1) return`) is the caller's job here too. */
function letterSubReference(unit: number, initialLetter = 'A'): string {
	let suffix = '';
	let u = unit;
	do {
		const rem = (u - 1) % 26;
		suffix = String.fromCharCode(initialLetter.charCodeAt(0) + rem) + suffix;
		// C++'s `(aUnit - u) / 26` is INTEGER division (aUnit is `int`) —
		// JS's `/` is floating-point and, for unit=1 (rem=0), never reaches
		// exactly 0 this way (0.0384..., 0.0015..., asymptotic forever: a
		// genuine infinite loop, not just a slow one). Math.floor replicates
		// C++'s truncation for these always-non-negative operands.
		u = Math.floor((u - rem) / 26);
	} while (u > 0);
	return suffix;
}

/** `(mirror x)` / `(mirror y)` — now a registered KicadElementMirror
 * (KicadElementLiteral.value), preferred first; the attribute/children
 * fallback stays for any unregistered/legacy-shaped element that slips
 * through, same defensive spirit as this file's other readers. */
function readMirror(instance: any): 'x' | 'y' | null {
	const mirrorEl = typeof instance.findFirstChildByName === 'function' ? instance.findFirstChildByName('mirror') :
		null;
	if (mirrorEl) {
		const value = String(mirrorEl.value ?? '');
		if (value === 'x' || value === 'y') {
			return value;
		}
		for (const attr of mirrorEl.attributes) {
			const v = String(attr.value);
			if (v === 'x' || v === 'y') {
				return v as 'x' | 'y';
			}
		}
		for (const child of mirrorEl.children) {
			if (child.name === 'x' || child.name === 'y') {
				return child.name as 'x' | 'y';
			}
		}
	}
	return null;
}

/**
 * `(pin_names … hide)` may be a bare attribute (KiCad 8) or a `(hide yes)`
 * child (KiCad 9/10). Painter falls back here when the symbol API is absent.
 */
function pinNamesHiddenFromEl(pinNamesEl: any): boolean {
	if (!pinNamesEl) {
		return false;
	}
	const hideEl = typeof pinNamesEl.findFirstChildByName === 'function'
		? pinNamesEl.findFirstChildByName('hide')
		: null;
	if (hideEl) {
		return hideEl.value === true || hideEl.value === 'yes';
	}
	if (Array.isArray(pinNamesEl.attributes)) {
		return pinNamesEl.attributes.some(
			(a: { value: string | number | boolean }) => a.value === 'hide' || a.value === true
		);
	}
	return false;
}

/** Reads a generic single-literal element's value (e.g. `(offset 0.508)`),
 * falling back when the element is absent or unparsable — same generic
 * attributes/children fallback pattern as readMirror() since these small
 * leaf tags aren't always registered @kicad-io classes with typed accessors. */
function readNumericValue(el: any, fallback: number): number {
	if (!el) {
		return fallback;
	}
	// KicadElementOffset (the actual registered class for `(offset N)`)
	// exposes the number as its own `.offset` property, not `.value` or a
	// raw attribute — confirmed by inspecting the parsed element directly;
	// `.value`/`.attributes[0]` (this file's usual generic-element fallback,
	// e.g. readMirror()) are checked too for any tag that DOES fall back to
	// a plain untyped KicadElement.
	if (typeof el.offset === 'number') {
		return el.offset;
	}
	if (typeof el.value === 'number') {
		return el.value;
	}
	if (Array.isArray(el.attributes) && el.attributes.length > 0) {
		const raw = el.attributes[0].value;
		const n = typeof raw === 'number' ? raw : parseFloat(raw);
		if (!isNaN(n)) {
			return n;
		}
	}
	return fallback;
}

/** Reads a pin's `name`/`number` child's own `effects > font > size` — this
 * is real per-pin file data (KicadElementFont.getSize(), a typed accessor on
 * the actual parsed instance), not a fixed KiCad convention. Falls back to
 * the caller's default when the pin doesn't specify one (common for
 * libraries that just rely on the schematic's global default text size). */
function readPinChildFontSize(pin: any, childName: 'name' | 'number', fallback: number): number {
	const child = typeof pin.findFirstChildByName === 'function' ? pin.findFirstChildByName(childName) : null;
	const effects = child && typeof child.findFirstChildByName === 'function' ? child.findFirstChildByName('effects') :
		null;
	const font = effects && typeof effects.findFirstChildByName === 'function' ? effects.findFirstChildByName('font') :
		null;
	if (font && typeof font.getSize === 'function') {
		const size = font.getSize();
		if (size.height > 0) {
			return size.height;
		}
	}
	return fallback;
}

/** Same as readPinChildFontSize() but for the font's stroke thickness —
 * KiCad's own pin-label placement formula (see buildPin()) factors in half
 * the text's stroke thickness, not just its height, when computing the
 * clearance from the pin line. */
function readPinChildFontThickness(pin: any, childName: 'name' | 'number', fallback: number): number {
	const child = typeof pin.findFirstChildByName === 'function' ? pin.findFirstChildByName(childName) : null;
	const effects = child && typeof child.findFirstChildByName === 'function' ? child.findFirstChildByName('effects') :
		null;
	const font = effects && typeof effects.findFirstChildByName === 'function' ? effects.findFirstChildByName('font') :
		null;
	if (font && typeof font.getThickness === 'function') {
		const thickness = font.getThickness();
		if (thickness > 0) {
			return thickness;
		}
	}
	return fallback;
}

type PinOrientation = 'right' | 'left' | 'up' | 'down';

/** Which of the 4 cardinal directions a pin points, derived from the
 * world-space unit direction (outer/wire end -> inner/body end) that
 * buildPin() already computes robustly via point-transformation. Mirrors
 * KiCad's own angle_to_orientation() (sch_painter.cpp), just derived from a
 * direction vector instead of a raw rotation attribute. */
function pinOrientationFromDir(ux: number, uy: number): PinOrientation {
	if (Math.abs(ux) >= Math.abs(uy)) {
		return ux >= 0 ? 'right' : 'left';
	}
	return uy >= 0 ? 'down' : 'up';
}

/**
 * Rotates a LOCAL offset (computed as if the pin pointed "right", i.e.
 * toward the body in the +x direction) into world space based on the pin's
 * actual orientation — a direct port of KiCad's
 * PinLabelInternals.orient_label() (sch_painter.cpp). This is NOT a generic
 * perpendicular-vector rotation: KiCad deliberately keeps "above the pin"
 * text on the same physical (screen) side for BOTH left- and right-pointing
 * horizontal pins (only the along-pin component flips sign) — a plain
 * perp-of-direction formula gets this wrong for left-pointing pins.
 * `flipH` tells the caller to mirror a "left"-aligned anchor to "right" so
 * text anchored at the pin's own connection point still reads correctly.
 */
function orientPinOffset(local: Vec2, orientation: PinOrientation): { offset: Vec2; flipH: boolean } {
	switch (orientation) {
		case 'right':
			return { offset: local, flipH: false };
		case 'left':
			return { offset: new Vec2(-local.x, local.y), flipH: true };
		case 'up':
			return { offset: new Vec2(local.y, -local.x), flipH: false };
		case 'down':
			return { offset: new Vec2(local.y, local.x), flipH: true };
	}
}

/**
 * Reads an element's `effects > justify` as a normalized {x,y} anchor
 * fraction (left/middle/right -> 0/0.5/1, top/middle/bottom -> 0/0.5/1),
 * mirrored if `justify ... mirror` is set.
 *
 * KicadElementGlobalLabel and KicadElementHierarchicalLabel do NOT include
 * the WithJustify mixin (confirmed by reading their @kicad-io source
 * directly) — they have position/UUID but no getAnchorPoint()/getJustify()
 * of their own. The PARSER still produces a real, correctly-typed
 * KicadElementJustify instance for the nested `justify` tag regardless
 * (KicadParser's tag->class nodeMap is independent of what mixins the
 * PARENT tag's class happens to use) — this just navigates to it manually
 * and reads ITS OWN typed accessor instead of relying on a convenience
 * wrapper method the parent class doesn't have.
 *
 * This was a real, confirmed bug: falling back to a hardcoded {x:0,y:0}
 * (rather than reading the child at all) meant every global/hierarchical
 * label anchor was silently always "left/top" regardless of the file's
 * actual `justify` — a label rotated 180° with `(justify right)` (KiCad's
 * own correct convention for that orientation, meant to keep text reading
 * toward the connection point) instead rendered as if left-justified,
 * sending the text shooting off in the WRONG direction, away from its own
 * flag/arrow shape entirely. Also fixed the no-justify-at-all default to
 * middle/middle (0.5/0.5), matching WithJustify.getJustify()'s own real
 * default — the old {x:0,y:0} fallback didn't match that either.
 */
function readJustifyAnchor(el: any): { x: number; y: number } {
	if (typeof el.getAnchorPoint === 'function') {
		return el.getAnchorPoint();
	}
	const effects = typeof el.findFirstChildByName === 'function' ? el.findFirstChildByName('effects') : null;
	const justifyEl = effects && typeof effects.findFirstChildByName === 'function' ?
		effects.findFirstChildByName('justify') : null;
	const justify = justifyEl && typeof justifyEl.getJustify === 'function' ? justifyEl.getJustify() : null;
	if (!justify) {
		return { x: 0.5, y: 0.5 };
	}
	let x = 0.5, y = 0.5;
	switch (justify.horizontal) {
		case 'left':
			x = 0;
			break;
		case 'middle':
			x = 0.5;
			break;
		case 'right':
			x = 1;
			break;
	}
	switch (justify.vertical) {
		case 'top':
			y = 0;
			break;
		case 'middle':
			y = 0.5;
			break;
		case 'bottom':
			y = 1;
			break;
	}
	if (justify.mirrored) {
		x = 1 - x;
	}
	return { x, y };
}

/** Keeps text readable (never upside-down) regardless of the direction of
 * whatever it's attached to — angles beyond +-90 degrees from horizontal
 * get flipped 180 degrees. `flipped` tells the caller to also mirror the
 * text's anchor so it stays positioned on the same physical side. */
function uprightTextAngle(angleDeg: number): { angleDeg: number; flipped: boolean } {
	const normalized = ((angleDeg + 180) % 360 + 360) % 360 - 180; // (-180, 180]
	if (normalized > 90 || normalized <= -90) {
		return { angleDeg: normalized > 0 ? normalized - 180 : normalized + 180, flipped: true };
	}
	return { angleDeg: normalized, flipped: false };
}

/** Placed-instance transform: local point -> rotate -> mirror -> translate
 * to world position. Rotation is applied innermost (before mirror) — matches
 * real KiCad's placement model, where the file format's `(at x y rot)` sets
 * the base transform first and a following `(mirror x/y)` composes on top of
 * it (see sch_io_kicad_sexpr_parser.cpp's SetTransform-then-SetOrientation
 * sequence, and SCH_SYMBOL::SetOrientation's `new = mirror * old` combine).
 * Confirmed against real KiCad's TRANSFORM::TransformCoordinate for several
 * rotation values — mirror-then-rotate (the old order here) silently matches
 * KiCad only at rotation 0 and disagrees at 90/270, which is why plain
 * rectangles/rotationless symbols never showed the bug but rotated pin
 * layouts (e.g. a vertical switch) rendered mirrored across the wrong axis. */
function buildInstanceMatrix(x: number, y: number, rotationDeg: number, mirror: 'x' | 'y' | null): Matrix3 {
	// multiply_self does LEFT-multiplication (this = b * this), so building
	// from bottom up: start with translation T, multiply by scaling gives
	// S*T, then multiply by rotation gives R*S*T (scale innermost → rotate →
	// translate). For row-vector transform(v) = v * M, this gives:
	// ((v * S) * R) + t — i.e. mirror is applied to the local point first,
	// then rotation, then translation.
	//
	// KiCad naming: (mirror x) = mirror about X-axis = negate Y in schematic
	// (Y-down) coordinates; (mirror y) = mirror about Y-axis = negate X.
	let matrix = Matrix3.translation(x, y);
	if (mirror === 'x') {
		matrix = matrix.multiply(Matrix3.scaling(1, -1));
	}
	else if (mirror === 'y') {
		matrix = matrix.multiply(Matrix3.scaling(-1, 1));
	}
	matrix = matrix.multiply(Matrix3.rotation(Angle.fromDegrees(rotationDeg)));
	return matrix;
}

/**
 * Applies the symbol-library Y-flip then the placed-instance transform, for
 * any raw local (x,y) coordinate pair. Real KiCad symbol libraries are
 * authored with Y increasing UPWARD (math convention); the schematic sheet
 * (like the PCB) uses Y increasing DOWNWARD — negating Y is what converts
 * between the two. An earlier version of this negated X instead, based on
 * WithStartMidEnd's `invert` parameter (used for symbol arcs) — that
 * parameter turned out to solve a different, narrower problem than "convert
 * library-local to world" in general; empirically, negating X made every
 * symbol (ground flags, pin text, whole bodies) render upside down and
 * mirrored, which is the unmistakable signature of the flip being on the
 * wrong axis.
 */
function flippedTransform(instanceMatrix: Matrix3, localX: number, localY: number): Vec2 {
	return instanceMatrix.transform(new Vec2(localX, -localY));
}

/** Given a circle's center and three points on it (start/mid/end), returns
 * a {startAngle,endAngle} pair such that sweeping FORWARD (increasing
 * angle — matching canvas's own default arc() direction) from startAngle to
 * endAngle passes through mid. Mirrors the same mid-based direction
 * selection kicad-io's getArcCenterRadiusAngles() uses in LOCAL space (see
 * WithStartMidEnd.ts for the full reasoning) — needed AGAIN here in WORLD
 * space because flippedTransform's Y-negation is a reflection and reverses
 * winding, so re-deriving world angles from independently-transformed
 * start/end points (without re-checking against mid) silently picks the
 * wrong one of the two possible arcs for roughly half of all symbol arcs. */
function arcSweepAngles(center: Vec2, startPt: Vec2, midPt: Vec2, endPt: Vec2): {
	startAngle: number;
	endAngle: number
} {
	const angleOf = (p: Vec2) => Math.atan2(p.y - center.y, p.x - center.x);
	const rawStart = angleOf(startPt);
	const rawMid = angleOf(midPt);
	const rawEnd = angleOf(endPt);
	const normalize = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
	const forward = (from: number, to: number) => normalize(to - from);
	const forwardToMid = forward(rawStart, rawMid);
	const forwardToEnd = forward(rawStart, rawEnd);
	if (forwardToMid < forwardToEnd) {
		return { startAngle: rawStart, endAngle: rawStart + forwardToEnd };
	}
	return { startAngle: rawEnd, endAngle: rawEnd + (2 * Math.PI - forwardToEnd) };
}

/**
 * Symbol field (Reference/Value/etc.) position + rotation — ports kicanvas's
 * SCH_FIELD handling (viewers/schematic/painter.ts PropertyPainter +
 * kicad/text/sch-field.ts SchField), which is NOT a simple "use the file
 * position/justify directly" case once the symbol itself is rotated.
 *
 * KiCad always draws fields either upright (0°) or vertical (90°) — never
 * upside-down or backwards — via a keep-upright lookup (fieldDrawRotation
 * below). When that flips the field's OWN raw rotation to a different draw
 * angle, the file's stored (world-space) position and justify no longer
 * describe where the text should land directly: they were authored in the
 * field's ORIGINAL (pre-flip) frame. KiCad's real fix (and kicanvas's port
 * of it) is to de-rotate the stored position back into the symbol's local
 * frame, build the justified text box there, then re-apply the symbol's
 * actual rotation/mirror transform to that box and draw the RESULT centered
 * — never re-applying justify a second time in world space.
 *
 * Confirmed as a real, previously-unhandled gap: a 90°-rotated diode's
 * "D24"/"DSK320" reference/value fields, both stored with `justify right`,
 * rendered squarely on top of the symbol body instead of clear of it — the
 * previous code applied `right` directly against the WORLD x-axis, but for
 * this rotation the file's `right` justify actually maps to an EFFECTIVE
 * left-justify once flipped upright (verified against this exact file:
 * (at 95.25 33.02 90) symbol, (at 97.79 32.0674 90) (justify right)
 * property — hand-derivation of KiCad's own matrix math below gives a final
 * draw center of (97.79 + textWidth/2, 32.0674), i.e. the file's X becomes
 * the text's LEFT edge, not its right edge).
 */
function symbolFieldWorldCenter(
	propOrigin: { x: number; y: number; rotation?: number },
	anchor: { x: number; y: number },
	value: string,
	textSize: number,
	symbolOrigin: { x: number; y: number; rotation?: number },
	symbolMirror: 'x' | 'y' | null
): Vec2 {
	const symbolRotation = symbolOrigin.rotation ?? 0;
	const propRotation = propOrigin.rotation ?? 0;
	// Rotation+mirror only, no translation — the "M" role below always
	// operates on offsets from the symbol origin, added back at the end.
	const rotMatrix = buildInstanceMatrix(0, 0, symbolRotation, symbolMirror);

	const worldOffset = new Vec2(propOrigin.x - symbolOrigin.x, propOrigin.y - symbolOrigin.y);
	// De-rotate the stored world offset into the symbol's local (pre-
	// rotation, pre-mirror) frame. KiCad's own symbol transform matrix bakes
	// in a Y-flip even at rotation 0 (the library-Y-up vs schematic-Y-down
	// convention) — flippedTransform already encodes exactly that
	// convention (same one used for every symbol-local body-graphic
	// coordinate elsewhere in this file), so its inverse is reused here
	// rather than a plain Matrix3 rotation inverse.
	const invRotated = rotMatrix.inverse().transform(worldOffset);
	const posLocal = new Vec2(invRotated.x, -invRotated.y);

	// Center of the justified text box, as an offset from propOrigin, in
	// the field's own (un-rotated) local frame — same "anchor fraction of
	// measured width/height" relationship used everywhere else in this
	// file's anchor math, just solved for the box CENTER instead of a
	// stroke-shift target.
	const { width, height } = measureStrokeTextSize(value, textSize);
	const shift = { x: (0.5 - anchor.x) * width, y: (0.5 - anchor.y) * height };

	// Rotate that shift by the field's OWN raw (as-authored) rotation
	// around posLocal, then apply KiCad's explicit "symbols have flipped Y"
	// mirror step, then forward-transform through the symbol's actual
	// rotation/mirror — ports SchField.bounding_box's begin/end handling,
	// simplified to operate on the box's center directly (the only value a
	// centered final draw actually needs) rather than both corners.
	const rotatedShift = rotateLocalPoint(shift, propRotation);
	const mirroredPoint = new Vec2(posLocal.x + rotatedShift.x, posLocal.y - rotatedShift.y);
	const worldRel = flippedTransform(rotMatrix, mirroredPoint.x, mirroredPoint.y);

	return new Vec2(symbolOrigin.x + worldRel.x, symbolOrigin.y + worldRel.y);
}

/** KiCad never draws a symbol field upside-down or backwards — only upright
 * (0°) or vertical (90°). Ports SchField.draw_rotation: when the symbol
 * itself is rotated by an odd multiple of 90° (90 or 270), a field's own
 * raw 0°/180° rotation flips to 90°, and its own raw 90°/270° flips to 0°;
 * otherwise the field's raw rotation is used as-is. */
function fieldDrawRotation(propRotationDeg: number, symbolRotationDeg: number): number {
	const normalizedSymbol = ((symbolRotationDeg % 360) + 360) % 360;
	const symbolIsOddQuarterTurn = normalizedSymbol === 90 || normalizedSymbol === 270;
	if (!symbolIsOddQuarterTurn) {
		return propRotationDeg;
	}
	return (propRotationDeg === 0 || propRotationDeg === 180) ? 90 : 0;
}

/**
 * Real KiCad fill types aren't "on/off" — `outline` fills with the SAME
 * color as the shape's own stroke (used for solid body markings like the
 * two half-circles of a bridged solder-jumper symbol), `background`/`color`
 * fill with the component body color, and `none` doesn't fill at all. A
 * previous version always used the body-fill color for any non-'none' fill,
 * which rendered `outline`-filled shapes with the wrong (translucent body)
 * color instead of a solid outline-colored fill — confirmed against a real
 * symbol (Jumper:SolderJumper_2_Bridged) whose two arcs are meant to render
 * as solid-colored half-moons, not body-tinted ones. `strokeColor` is the
 * item's own already-resolved draw color (which already accounts for
 * selection highlighting), reused here rather than a fixed theme constant
 * so a highlighted outline-filled shape highlights consistently on both its
 * fill and its stroke. */
/**
 * `customColor` is only consulted for the 'color' case, and only by
 * schematic-ROOT shape builders (buildSchRect etc.) which pass
 * element.getFillColorOverride?.() — symbol-BODY graphics never pass it, so
 * they keep resolving 'color' to the shared theme body color exactly as
 * before (a library symbol's body fill is meant to follow the theme
 * uniformly, not whatever arbitrary color some third-party library author
 * baked into one specific shape).
 */
function symbolFillColor(fillType: string, strokeColor: string, customColor?: string): string | undefined {
	switch (fillType) {
		case 'outline':
			return strokeColor;
		case 'background':
			return schColors.componentBody;
		case 'color':
			return customColor ?? schColors.componentBody;
		default:
			return undefined;
	}
}

/** KiCad's DNP dimming path: desaturate the item color, then blend it 50%
 * toward the schematic background.  Schematic theme colors are normally
 * `rgb(...)`, but accepting hex here keeps custom symbol/field colors from
 * silently bypassing the DNP treatment. */
function dnpDimmedColor(value: string): string {
	let r: number, g: number, b: number;
	const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
	if (rgb) {
		r = Number(rgb[1]);
		g = Number(rgb[2]);
		b = Number(rgb[3]);
	}
	else {
		const hex = /^#([\da-f]{6})$/i.exec(value);
		if (!hex) {
			return value;
		}
		const n = Number.parseInt(hex[1]!, 16);
		r = (n >> 16) & 0xff;
		g = (n >> 8) & 0xff;
		b = n & 0xff;
	}
	const gray = 0.299 * r + 0.587 * g + 0.114 * b;
	const bg = [40, 44, 52];
	const mix = (channel: number, background: number) => Math.round((channel + background) / 2);
	return `rgb(${ mix(gray, bg[0]!) }, ${ mix(gray, bg[1]!) }, ${ mix(gray, bg[2]!) })`;
}

function colorForKind(kind: SchPaintedItem['kind']): string {
	switch (kind) {
		case 'wire':
			return schColors.wire;
		case 'bus':
			return schColors.bus;
		case 'junction':
			return schColors.junction;
		case 'no-connect':
			return schColors.noConnect;
		case 'symbol-graphic':
			return schColors.componentOutline;
		case 'pin':
			return schColors.pin;
		case 'label':
			return schColors.labelLocal;
		case 'sheet':
			return schColors.sheet;
		case 'table':
			return schColors.note;
		case 'image':
			return schColors.note;
		case 'text':
			return schColors.reference;
		case 'frame':
			return schColors.frame;
		case 'dangling':
			return schColors.wire;
		default:
			return schColors.componentOutline;
	}
}

// Lazily-resolved class registry — see the file-level comment for why this
// doesn't need to (and shouldn't) hard-code an @kicad-io import path.
let _Wire: any, _Bus: any, _BusEntry: any, _Junction: any, _NoConnect: any, _Symbol: any, _LibSymbols: any;
let _GlobalLabel: any, _HierLabel: any, _Sheet: any, _Table: any, _Image: any, _Pin: any, _NetclassFlag: any,
	_RuleArea: any;
let _Rect: any, _SymCircle: any, _SymArc: any, _Polyline: any, _Bezier: any, _At: any, _Size: any, _Text: any,
	_TextBox: any;

export function registerSchematicIoClasses(classes: {
	Wire?: any;
	Bus?: any;
	BusEntry?: any;
	Junction?: any;
	NoConnect?: any;
	Symbol?: any;
	LibSymbols?: any;
	GlobalLabel?: any;
	HierLabel?: any;
	Sheet?: any;
	Table?: any;
	Image?: any;
	Pin?: any;
	NetclassFlag?: any;
	RuleArea?: any;
	Rect?: any;
	SymCircle?: any;
	SymArc?: any;
	Polyline?: any;
	Bezier?: any;
	At?: any;
	Size?: any;
	Text?: any;
	TextBox?: any;
}): void {
	_Wire = classes.Wire;
	_Bus = classes.Bus;
	_BusEntry = classes.BusEntry;
	_Junction = classes.Junction;
	_NoConnect = classes.NoConnect;
	_Symbol = classes.Symbol;
	_LibSymbols = classes.LibSymbols;
	_GlobalLabel = classes.GlobalLabel;
	_HierLabel = classes.HierLabel;
	_Sheet = classes.Sheet;
	_Table = classes.Table;
	_Image = classes.Image;
	_Pin = classes.Pin;
	_NetclassFlag = classes.NetclassFlag;
	_RuleArea = classes.RuleArea;
	_Rect = classes.Rect;
	_SymCircle = classes.SymCircle;
	_SymArc = classes.SymArc;
	_Polyline = classes.Polyline;
	_Bezier = classes.Bezier;
	_At = classes.At;
	_Size = classes.Size;
	_Text = classes.Text;
	_TextBox = classes.TextBox;
}

function getWireClass() { return _Wire; }

function getBusClass() { return _Bus; }

function getBusEntryClass() { return _BusEntry; }

function getJunctionClass() { return _Junction; }

function getNoConnectClass() { return _NoConnect; }

function getSymbolClass() { return _Symbol; }

function getLibSymbolsClass() { return _LibSymbols; }

function getGlobalLabelClass() { return _GlobalLabel; }

function getHierLabelClass() { return _HierLabel; }

function getSheetClass() { return _Sheet; }

function getTableClass() { return _Table; }

function getImageClass() { return _Image; }

function getPinClass() { return _Pin; }

function getNetclassFlagClass() { return _NetclassFlag; }

function getRuleAreaClass() { return _RuleArea; }

function getRectClass() { return _Rect; }

function getSymCircleClass() { return _SymCircle; }

function getSymArcClass() { return _SymArc; }

function getPolylineClass() { return _Polyline; }

function getBezierClass() { return _Bezier; }

function getAtClass() { return _At; }

function getSizeClass() { return _Size; }

function getTextClass() { return _Text; }

function getTextBoxClass() { return _TextBox; }
