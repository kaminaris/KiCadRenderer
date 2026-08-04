import { Vec2 } from '../math/Vec2';
import { Angle } from '../math/Angle';
import { Matrix3 } from '../math/Matrix3';
import { Renderer } from '../render/Renderer';
import { schColors, schematicLayerOrder } from './SchematicColors';
import { computeStrokeTextGeometry, drawStrokeTextGeometry, measureStrokeTextSize } from './TextPaint';
import { PaintedShape, shapeToBBox, distanceToSegment, polygonEdgeDistance } from './PaintedShape';
import { arcToPolyline, circleToRing, KicadStrokeLineType, strokeDashedPolyline } from './StrokeDash';
import {
	defaultWksItems, defaultWksSetup, expandWksTextVars, resolveWksAnchor, withinWksMargin, wksPaperSizes,
} from './DrawingSheet';

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
	kind: 'wire' | 'bus' | 'junction' | 'no-connect' | 'symbol-graphic' | 'pin' | 'label' | 'sheet' | 'text' | 'frame' | 'symbol' | 'dangling';
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
		const libSymbols = getLibSymbolsClass() ? root.findFirstChildByClass(getLibSymbolsClass()) : null;

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
		if (getTextClass()) {
			for (const text of root.findChildrenByClass(getTextClass())) {
				const item = this.buildSchText(text);
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

		const titleBlockEl = typeof root.findFirstChildByName === 'function' ? root.findFirstChildByName('title_block') : null;
		const vars: Record<string, string> = {
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
			COMMENT4: typeof titleBlockEl?.getComment === 'function' ? titleBlockEl.getComment(4) : '',
		};

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
					const shape: PaintedShape = { type: 'polygon', points: [{ x: start.x, y: start.y }, { x: end.x, y: end.y }] };
					items.push({
						id, layer: 'Frame', kind: 'frame', shape, bbox: shapeToBBox(shape), hitTestable: false, element: null,
						defaultColor: schColors.frame,
						draw: (renderer, color) => renderer.line([start, end], { strokeColor: color, strokeWidth: setup.lineWidthMm }),
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
					if (i > 0 && (!withinWksMargin(sheetSize, setup, start) || !withinWksMargin(sheetSize, setup, end))) {
						break;
					}
					const corners = [
						new Vec2(start.x, start.y), new Vec2(end.x, start.y),
						new Vec2(end.x, end.y), new Vec2(start.x, end.y),
					];
					const id = `wks-rect:${ uid++ }`;
					const shape: PaintedShape = { type: 'polygon', points: corners.map(p => ({ x: p.x, y: p.y })) };
					items.push({
						id, layer: 'Frame', kind: 'frame', shape, bbox: shapeToBBox(shape), hitTestable: false, element: null,
						defaultColor: schColors.frame,
						draw: (renderer, color) => drawStrokeOutline(renderer, [...corners, corners[0]!], setup.lineWidthMm, 'solid', color),
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
					const resolved = expandWksTextVars(raw, vars);
					if (!resolved) {
						continue;
					}
					const anchor = {
						x: wksItem.hAlign === 'left' ? 0 : wksItem.hAlign === 'right' ? 1 : 0.5,
						y: wksItem.vAlign === 'top' ? 0 : wksItem.vAlign === 'bottom' ? 1 : 0.5,
					};
					// Real KiCad's stroke font has no separate bold glyph set —
				// "bold" is purely a thicker stroke (ports EDAText's
				// get_bold_thickness/get_normal_thickness: size/5 for bold,
				// size/8 for normal, both against the nominal font size, not
				// the rendered string width).
				const strokeWidthMm = wksItem.bold ? wksItem.sizeMm / 5 : wksItem.sizeMm / 8;
				const geometry = computeStrokeTextGeometry(resolved, pos, wksItem.sizeMm, 0, false, strokeWidthMm, anchor);
					const id = `wks-text:${ uid++ }`;
					const bbox = { x: pos.x - 10, y: pos.y - 2, w: 20, h: 4 };
					items.push({
						id, layer: 'Frame', kind: 'frame', shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: null,
						defaultColor: schColors.frame,
						draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color),
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
		highlightedIds: Set<string> = new Set()
	): void {
		for (const layer of scene.layersPresent) {
			const state = layerState.get(layer);
			if (!state || !state.visible) {
				continue;
			}
			renderer.setOpacity?.(state.opacity);
			renderer.beginBatch?.();
			for (const item of scene.layerBuckets.get(layer)!) {
				const color = highlightedIds.has(item.id) ? '#ffcc00' : (item.defaultColor ?? colorForKind(item.kind));
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
		const width = 0.15;
		const shape: PaintedShape = { type: 'segment', x1: start.x, y1: start.y, x2: end.x, y2: end.y, width };
		const id = wire.getUuid() ?? `wire:${ start.x },${ start.y }-${ end.x },${ end.y }`;
		return {
			id, layer, kind: 'wire', shape, bbox: shapeToBBox(shape), hitTestable: true, element: wire,
			defaultColor: readWireStrokeColor(wire) ?? color,
			draw: (renderer, drawColor) => {
				renderer.line([new Vec2(start.x, start.y), new Vec2(end.x, end.y)], { strokeColor: drawColor, strokeWidth: width });
			},
		};
	}

	protected buildBus(bus: any): SchPaintedItem | null {
		const item = this.buildWireLike(bus, 'Wires', schColors.bus);
		if (!item) {
			return null;
		}
		// Buses draw thicker than ordinary wires — same geometry, different kind/width.
		return { ...item, kind: 'bus', draw: (renderer, color) => {
			const s = item.shape as { x1: number; y1: number; x2: number; y2: number };
			renderer.line([new Vec2(s.x1, s.y1), new Vec2(s.x2, s.y2)], { strokeColor: color, strokeWidth: 0.3 });
		} };
	}

	protected buildBusEntry(entry: any): SchPaintedItem | null {
		const origin = typeof entry.getOrigin === 'function' ? entry.getOrigin() : null;
		const size = typeof entry.getSize === 'function' ? entry.getSize() : null;
		if (!origin || !size) {
			return null;
		}
		const x1 = origin.x, y1 = origin.y;
		const x2 = origin.x + size.width, y2 = origin.y + size.height;
		const stroke = typeof entry.getStroke === 'function' ? entry.getStroke() : { width: 0 };
		const width = stroke.width || 0.15;
		const id = entry.getUuid?.() ?? `bus_entry:${ x1 },${ y1 }`;
		const shape: PaintedShape = { type: 'segment', x1, y1, x2, y2, width };
		return {
			id, layer: 'Wires', kind: 'wire', shape, bbox: shapeToBBox(shape), hitTestable: true, element: entry,
			draw: (renderer, color) => {
				renderer.line([new Vec2(x1, y1), new Vec2(x2, y2)], { strokeColor: color, strokeWidth: width });
			},
		};
	}

	protected buildJunction(junction: any): SchPaintedItem {
		const origin = junction.getOrigin();
		const radius = 0.4;
		const shape: PaintedShape = { type: 'circle', cx: origin.x, cy: origin.y, r: radius };
		const id = junction.getUuid() ?? `junction:${ origin.x },${ origin.y }`;
		return {
			id, layer: 'Junctions', kind: 'junction', shape, bbox: shapeToBBox(shape), hitTestable: true, element: junction,
			draw: (renderer, color) => {
				renderer.circle(new Vec2(origin.x, origin.y), radius, { fillColor: color });
			},
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
				renderer.line([new Vec2(origin.x - half, origin.y - half), new Vec2(origin.x + half, origin.y + half)], { strokeColor: color, strokeWidth: width });
				renderer.line([new Vec2(origin.x - half, origin.y + half), new Vec2(origin.x + half, origin.y - half)], { strokeColor: color, strokeWidth: width });
			},
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
			new Vec2(end.x, end.y), new Vec2(start.x, end.y),
		];
		const { width, type: lineType } = typeof rect.getStroke === 'function' ? rect.getStroke() : { width: 0.15, type: 'solid' as KicadStrokeLineType };
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
			filled: fillType !== 'none', closed: true, strokeWidth: width,
		};
		return {
			id, layer: 'Graphics', kind: 'symbol-graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: rect,
			defaultColor: schColors.graphic,
			draw: (renderer, color) => {
				const fillColor = symbolFillColor(fillType, color);
				if (fillColor) {
					renderer.polygon(corners, { fillColor });
				}
				drawStrokeOutline(renderer, [...corners, corners[0]!], width, lineType, color);
			},
		};
	}

	protected buildSchCircle(circle: any): SchPaintedItem {
		const center = circle.getCenter();
		const radius = typeof circle.getRadius === 'function' ? circle.getRadius() : 0;
		const { width, type: lineType } = typeof circle.getStroke === 'function' ? circle.getStroke() : { width: 0.15, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof circle.getFill === 'function' ? circle.getFill() : 'none';
		const id = circle.getUuid() ?? `sch-circle:${ center.x },${ center.y }`;
		const shape: PaintedShape = {
			type: 'circle', cx: center.x, cy: center.y, r: radius, filled: fillType !== 'none', strokeWidth: width,
		};
		return {
			id, layer: 'Graphics', kind: 'symbol-graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: circle,
			defaultColor: schColors.graphic,
			draw: (renderer, color) => {
				const worldCenter = new Vec2(center.x, center.y);
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
			},
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
		const { width, type: lineType } = typeof arc.getStroke === 'function' ? arc.getStroke() : { width: 0.15, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof arc.getFill === 'function' ? arc.getFill() : 'none';
		const id = arc.getUuid() ?? `sch-arc:${ local.centerX },${ local.centerY }`;
		const shape: PaintedShape = { type: 'circle', cx: local.centerX, cy: local.centerY, r: local.radius };
		return {
			id, layer: 'Graphics', kind: 'symbol-graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: arc,
			defaultColor: schColors.graphic,
			draw: (renderer, color) => {
				const worldCenter = new Vec2(local.centerX, local.centerY);
				const fillColor = symbolFillColor(fillType, color);
				if (fillColor) {
					// A filled arc is a "pie slice" — the sampled arc points
					// plus the center, closed into a polygon (ports kicanvas's
					// MathArc.to_polygon()). Solder-jumper-style symbols rely
					// on this to render a solid half-moon, not just an outline.
					renderer.polygon([...arcToPolyline(worldCenter, local.radius, local.startAngle, local.endAngle), worldCenter], { fillColor });
				}
				if (lineType === 'solid' || lineType === 'default') {
					renderer.arc(worldCenter, local.radius, local.startAngle, local.endAngle, { strokeColor: color, strokeWidth: width || 0.1 });
				}
				else {
					drawStrokeOutline(renderer, arcToPolyline(worldCenter, local.radius, local.startAngle, local.endAngle), width, lineType, color);
				}
			},
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
		const { width, type: lineType } = typeof poly.getStroke === 'function' ? poly.getStroke() : { width: 0.15, type: 'solid' as KicadStrokeLineType };
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
			filled: fillType !== 'none', closed, strokeWidth: width,
		};
		return {
			id, layer: 'Graphics', kind: 'symbol-graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: poly,
			defaultColor: schColors.graphic,
			draw: (renderer, color) => {
				const fillColor = closed ? symbolFillColor(fillType, color) : undefined;
				if (fillColor) {
					renderer.polygon(worldPoints, { fillColor });
				}
				drawStrokeOutline(renderer, strokePoints, width, lineType, color);
			},
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
			...base, id, shape, layer: 'RuleAreas', defaultColor: schColors.ruleArea, element: ruleArea,
		};
	}

	protected buildSchText(text: any): SchPaintedItem | null {
		const value: string = text.value ?? '';
		if (!value) {
			return null;
		}
		const origin = text.getOrigin();
		const rotation = origin.rotation ?? 0;
		const worldPos = new Vec2(origin.x, origin.y);
		const font = typeof text.getFont === 'function' ? text.getFont() : { width: 0, height: 0 };
		const textSize = font.height || 1.27;
		// text_angle normalizes to 0/90 only, anchor comes straight from
		// the file's own justify unmodified — same real KiCad convention
		// already established for labels (see the block comment above
		// buildLocalLabel()).
		const textAngle = (rotation === 90 || rotation === 270) ? 90 : 0;
		const anchor = typeof text.getAnchorPoint === 'function' ? text.getAnchorPoint() : { x: 0.5, y: 0.5 };
		const geometry = computeStrokeTextGeometry(value, worldPos, textSize, textAngle, false, undefined, anchor);
		const id = text.getUuid() ?? `sch-text:${ origin.x },${ origin.y }`;
		const bbox = { x: worldPos.x - textSize, y: worldPos.y - textSize, w: textSize * 2, h: textSize * 2 };
		return {
			id, layer: 'Text', kind: 'text', shape: { type: 'rect', ...bbox }, bbox, hitTestable: true, element: text,
			defaultColor: schColors.note,
			draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color),
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
		const libDef = typeof libSymbols.findSymbolByName === 'function' ? libSymbols.findSymbolByName(libId) : null;
		if (!libDef) {
			return items;
		}

		const origin = instance.getOrigin();
		const mirror = readMirror(instance);
		const instanceMatrix = buildInstanceMatrix(origin.x, origin.y, origin.rotation ?? 0, mirror);
		const instanceId = instance.getUuid() ?? `sym:${ origin.x },${ origin.y }`;
		const placedUnit: number = typeof instance.getUnitId === 'function' ? instance.getUnitId() : 0;

		const subUnits = this.relevantSubUnits(libDef, placedUnit);
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
				const offsetEl = pinNamesEl && typeof pinNamesEl.findFirstChildByName === 'function' ? pinNamesEl.findFirstChildByName('offset') : null;
				const pinNameOffset = readNumericValue(offsetEl, 0.508);

				for (const pin of subUnit.findChildrenByClass(getPinClass())) {
					for (const item of this.buildPin(pin, instanceMatrix, instanceId, pinNumbersHidden, pinNamesHidden, pinNameOffset)) {
						items.push(item);
					}
				}
			}
		}

		// Reference/Value/Footprint/etc — real per-instance values and
		// positions live on the PLACED instance's own properties, not the
		// library def (same WithProperties + getVisibleProperties pattern
		// already used for footprints). These are drawn as (non-hitTestable)
		// text items; they are deliberately EXCLUDED from the symbol hit box
		// below, so clicking a part's "R1"/"10k" text never selects the part.
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
				const value: string | undefined = prop.propertyValue;
				if (!value) {
					continue;
				}
				const propOrigin = typeof prop.getOrigin === 'function' ? prop.getOrigin() : { x: 0, y: 0, rotation: 0 };
				const anchor = typeof prop.getAnchorPoint === 'function' ? prop.getAnchorPoint() : { x: 0.5, y: 0.5 };
				const { size: textSize } = readElementFontMetrics(prop);
				const drawRotationDeg = fieldDrawRotation(propOrigin.rotation ?? 0, origin.rotation ?? 0);
				const textWorld = symbolFieldWorldCenter(
					propOrigin, anchor, value, textSize, origin, mirror
				);
				const geometry = computeStrokeTextGeometry(value, textWorld, textSize, drawRotationDeg, false, undefined, { x: 0.5, y: 0.5 });
				const half = Math.max(textSize, 1.27);
				const bbox = { x: textWorld.x - half, y: textWorld.y - half, w: half * 2, h: half * 2 };
				items.push({
					id: `${ instanceId }:prop:${ name }`, layer: 'Text', kind: 'text',
					shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: instance,
					draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color),
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
					h: h + pad * 2,
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
							strokeWidth: 0.25,
						});
					},
				});
			}
		}

		return items;
	}

	/** unit 0 = shared across all units (always included); otherwise only
	 * the instance's own selected unit. Same filter for deMorgan style,
	 * defaulting to style 1 (alternate/deMorgan style 2 not selectable yet). */
	protected relevantSubUnits(libDef: any, placedUnit: number): any[] {
		const subUnits: any[] = typeof libDef.getLayers === 'function' ? libDef.getLayers() : [];
		if (subUnits.length === 0) {
			return [libDef];
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
			flippedTransform(instanceMatrix, end.x, end.y), flippedTransform(instanceMatrix, start.x, end.y),
		];
		const { width, type: lineType } = typeof rect.getStroke === 'function' ? rect.getStroke() : { width: 0.25, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof rect.getFill === 'function' ? rect.getFill() : 'none';
		const id = rect.getUuid() ?? `sym-rect:${ instanceId }:${ start.x },${ start.y }`;
		const shape: PaintedShape = { type: 'polygon', points: corners.map(p => ({ x: p.x, y: p.y })) };
		return {
			id, layer: 'Symbols', kind: 'symbol-graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: rect,
			draw: (renderer, color) => {
				const fillColor = symbolFillColor(fillType, color);
				if (fillColor) {
					renderer.polygon(corners, { fillColor });
				}
				drawStrokeOutline(renderer, [...corners, corners[0]!], width, lineType, color);
			},
		};
	}

	protected buildSymCircle(circle: any, instanceMatrix: Matrix3, instanceId: string): SchPaintedItem {
		const center = circle.getCenter();
		const radius = typeof circle.getRadius === 'function' ? circle.getRadius() : 0;
		const worldCenter = flippedTransform(instanceMatrix, center.x, center.y);
		// A pure rotation+mirror (no non-uniform scale) never distorts a
		// circle's radius, so it's safe to reuse unchanged.
		const { width, type: lineType } = typeof circle.getStroke === 'function' ? circle.getStroke() : { width: 0.25, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof circle.getFill === 'function' ? circle.getFill() : 'none';
		const id = circle.getUuid() ?? `sym-circle:${ instanceId }:${ center.x },${ center.y }`;
		const shape: PaintedShape = { type: 'circle', cx: worldCenter.x, cy: worldCenter.y, r: radius };
		return {
			id, layer: 'Symbols', kind: 'symbol-graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: circle,
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
			},
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
			({ startAngle: worldStartAngle, endAngle: worldEndAngle } = arcSweepAngles(worldCenter, worldStartPt, worldMidPt, worldEndPt));
		}
		else {
			const worldStart = flippedTransform(instanceMatrix, local.centerX + local.radius * Math.cos(local.startAngle), local.centerY + local.radius * Math.sin(local.startAngle));
			const worldEnd = flippedTransform(instanceMatrix, local.centerX + local.radius * Math.cos(local.endAngle), local.centerY + local.radius * Math.sin(local.endAngle));
			worldStartAngle = Math.atan2(worldStart.y - worldCenter.y, worldStart.x - worldCenter.x);
			worldEndAngle = Math.atan2(worldEnd.y - worldCenter.y, worldEnd.x - worldCenter.x);
		}
		// A pure rotation+flip (no non-uniform scale) never distorts a
		// circle's radius, so the local radius carries over unchanged.
		const radius = local.radius;
		const { width, type: lineType } = typeof arc.getStroke === 'function' ? arc.getStroke() : { width: 0.25, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof arc.getFill === 'function' ? arc.getFill() : 'none';
		const id = `sym-arc:${ instanceId }:${ local.centerX },${ local.centerY }`;
		const shape: PaintedShape = { type: 'circle', cx: worldCenter.x, cy: worldCenter.y, r: radius };
		return {
			id, layer: 'Symbols', kind: 'symbol-graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: arc,
			draw: (renderer, color) => {
				const fillColor = symbolFillColor(fillType, color);
				if (fillColor) {
					// Pie-slice polygon (sampled arc + center) — same approach
					// as buildSchArc(), see its comment for why. Real-world
					// example: Jumper:SolderJumper_2_Bridged's two `(fill
					// (type outline))` arcs, meant to render as solid
					// half-moons on either side of the bridge rectangle.
					renderer.polygon([...arcToPolyline(worldCenter, radius, worldStartAngle, worldEndAngle), worldCenter], { fillColor });
				}
				if (lineType === 'solid' || lineType === 'default') {
					renderer.arc(worldCenter, radius, worldStartAngle, worldEndAngle, { strokeColor: color, strokeWidth: width || 0.1 });
				}
				else {
					drawStrokeOutline(renderer, arcToPolyline(worldCenter, radius, worldStartAngle, worldEndAngle), width, lineType, color);
				}
			},
		};
	}

	protected buildSymPolyline(poly: any, instanceMatrix: Matrix3, instanceId: string): SchPaintedItem {
		const points: { x: number; y: number }[] = typeof poly.getPoints === 'function' ? poly.getPoints() : [];
		const worldPoints = points.map(p => flippedTransform(instanceMatrix, p.x, p.y));
		const { width, type: lineType } = typeof poly.getStroke === 'function' ? poly.getStroke() : { width: 0.25, type: 'solid' as KicadStrokeLineType };
		const fillType = typeof poly.getFill === 'function' ? poly.getFill() : 'none';
        const first = points[0], last = points[points.length - 1];
		const id = poly.getUuid() ?? `sym-poly:${ instanceId }:${ first?.x },${ first?.y }`;
		const shape: PaintedShape = { type: 'polygon', points: worldPoints.map(p => ({ x: p.x, y: p.y })) };
		const closed = points.length > 2 && first && last && first.x === last.x && first.y === last.y;
		return {
			id, layer: 'Symbols', kind: 'symbol-graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: poly,
			draw: (renderer, color) => {
				const fillColor = closed ? symbolFillColor(fillType, color) : undefined;
				if (fillColor) {
					renderer.polygon(worldPoints, { fillColor });
				}
				drawStrokeOutline(renderer, worldPoints, width, lineType, color);
			},
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
		const font = typeof text.getFont === 'function' ? text.getFont() : { width: 0, height: 0 };
		const textSize = font.height || 1.27;
		const rawAnchor = typeof text.getAnchorPoint === 'function' ? text.getAnchorPoint() : { x: 0.5, y: 0.5 };
		const anchor = { x: upright.flipped ? 1 - rawAnchor.x : rawAnchor.x, y: rawAnchor.y };
		const geometry = computeStrokeTextGeometry(value, worldPos, textSize, upright.angleDeg, false, undefined, anchor);
		const id = text.getUuid() ?? `sym-text:${ instanceId }:${ origin.x },${ origin.y }`;
		const bbox = { x: worldPos.x - textSize, y: worldPos.y - textSize, w: textSize * 2, h: textSize * 2 };
		return {
			id, layer: 'Symbols', kind: 'text', shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: text,
			defaultColor: schColors.componentOutline,
			draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color),
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
	protected buildPin(pin: any, instanceMatrix: Matrix3, instanceId: string, pinNumbersHidden = false, pinNamesHidden = false, pinNameOffset = 0.508): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];
		const origin = pin.getOrigin();
		const length = typeof pin.getLength === 'function' ? pin.getLength() : 2.54;
		const isHidden = typeof pin.isHidden === 'function' ? pin.isHidden() : false;
		const worldOuter = flippedTransform(instanceMatrix, origin.x, origin.y);
		const id = pin.getUuid() ?? `pin:${ instanceId }:${ origin.x },${ origin.y }`;

		if (isHidden) {
			// Hidden is a DRAWING preference (KiCad's own "show hidden pins"
			// toggle) — the pin is still electrically real, most commonly on
			// power symbols (GND/VCC/...), where a wire landing exactly on
			// this point is the single most common non-dangling connection
			// in a typical schematic. Without this, buildDanglingFlags()
			// would never see this point as occupied (it only reads back
			// already-built paint items, not the AST) and would wrongly flag
			// every wire touching a power symbol as dangling. A zero-length,
			// invisible, non-hit-testable segment is enough to carry the
			// position through — nothing else consumes the 'Pins' bucket.
			const shape: PaintedShape = { type: 'segment', x1: worldOuter.x, y1: worldOuter.y, x2: worldOuter.x, y2: worldOuter.y, width: 0 };
			items.push({
				id, layer: 'Pins', kind: 'pin', shape, bbox: shapeToBBox(shape), hitTestable: false, element: pin,
				draw: () => {},
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
		const { electricalType, shape: pinShape } = typeof pin.getType === 'function' ? pin.getType() : { electricalType: 'passive', shape: 'line' };
		const symbolRadius = 0.635; // DefaultValues.pinsymbol_size
		const symbolDiam = symbolRadius * 2;
		const ncRadius = 0.381; // DefaultValues.target_pin_radius
		const dirX = -ux, dirY = -uy;

		let lineEnd = worldInner;
		let bubble: Vec2 | null = null;
		const decorations: Vec2[][] = [];

		if (electricalType === 'no_connect') {
			decorations.push([new Vec2(worldOuter.x - ncRadius, worldOuter.y - ncRadius), new Vec2(worldOuter.x + ncRadius, worldOuter.y + ncRadius)]);
			decorations.push([new Vec2(worldOuter.x + ncRadius, worldOuter.y - ncRadius), new Vec2(worldOuter.x - ncRadius, worldOuter.y + ncRadius)]);
		}
		else {
			const clockNotch = () => {
				decorations.push(dirY === 0
					? [new Vec2(worldInner.x, worldInner.y + symbolRadius), new Vec2(worldInner.x - dirX * symbolRadius, worldInner.y), new Vec2(worldInner.x, worldInner.y - symbolRadius)]
					: [new Vec2(worldInner.x + symbolRadius, worldInner.y), new Vec2(worldInner.x, worldInner.y - dirY * symbolRadius), new Vec2(worldInner.x - symbolRadius, worldInner.y)]);
			};
			const lowInTri = () => {
				decorations.push(dirY === 0
					? [new Vec2(worldInner.x + dirX * symbolDiam, worldInner.y), new Vec2(worldInner.x + dirX * symbolDiam, worldInner.y - symbolDiam), worldInner]
					: [new Vec2(worldInner.x, worldInner.y + dirY * symbolDiam), new Vec2(worldInner.x - symbolDiam, worldInner.y + dirY * symbolDiam), worldInner]);
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
						? [new Vec2(worldInner.x, worldInner.y - symbolDiam), new Vec2(worldInner.x + dirX * symbolDiam, worldInner.y)]
						: [new Vec2(worldInner.x - symbolDiam, worldInner.y), new Vec2(worldInner.x, worldInner.y + dirY * symbolDiam)]);
					break;
				case 'non_logic':
					decorations.push([
						new Vec2(worldInner.x - (dirX + dirY) * symbolRadius, worldInner.y - (dirY - dirX) * symbolRadius),
						new Vec2(worldInner.x + (dirX + dirY) * symbolRadius, worldInner.y + (dirY - dirX) * symbolRadius),
					]);
					decorations.push([
						new Vec2(worldInner.x - (dirX - dirY) * symbolRadius, worldInner.y - (dirY + dirX) * symbolRadius),
						new Vec2(worldInner.x + (dirX - dirY) * symbolRadius, worldInner.y + (dirY + dirX) * symbolRadius),
					]);
					break;
			}
		}

		const shape: PaintedShape = { type: 'segment', x1: worldOuter.x, y1: worldOuter.y, x2: lineEnd.x, y2: lineEnd.y, width };
		items.push({
			id, layer: 'Pins', kind: 'pin', shape, bbox: shapeToBBox(shape), hitTestable: true, element: pin,
			draw: (renderer, color) => {
				renderer.line([worldOuter, lineEnd], { strokeColor: color, strokeWidth: width });
				if (bubble) {
					renderer.circle(bubble, symbolRadius, { strokeColor: color, strokeWidth: width });
				}
				for (const deco of decorations) {
					renderer.line(deco, { strokeColor: color, strokeWidth: width });
				}
			},
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
			const geometry = computeStrokeTextGeometry(name, namePos, nameTextSize, textAngle, false, undefined, nameAnchor);
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
			const geometry = computeStrokeTextGeometry(number, numberPos, numberTextSize, textAngle, false, undefined, numberAnchor);
			items.push(textItem(`${ id }:number`, 'Text', numberPos, numberTextSize, pin, geometry, schColors.pinNumber));
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
		const { size: textSize, thickness } = readElementFontMetrics(label);
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
		const geometry = computeStrokeTextGeometry(name, worldPos, textSize, textAngle, false, undefined, anchor);
		// getUuid() (not an x/y/name-derived id) — matches every other
		// builder's convention, and is load-bearing here specifically:
		// translateElementById's caller (main.ts's drag loop) holds onto the
		// id for the whole gesture, but an x/y-derived id would change on
		// every intermediate scene rebuild as the label moves, breaking the
		// hit-test lookup after the first mousemove step.
		const id = typeof label.getUuid === 'function' && label.getUuid()
			? label.getUuid()
			: `local-label:${ x },${ y }:${ name }`;
		const bbox = { x: worldPos.x - textSize * 3, y: worldPos.y - textSize, w: textSize * 6, h: textSize * 2 };
		return {
			id, layer: 'Labels', kind: 'label', shape: { type: 'rect', ...bbox }, bbox, hitTestable: true, element: label,
			labelName: name, labelKind: 'local',
			draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color),
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
		const { size: textSize, thickness } = readElementFontMetrics(label);
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
			case 90: textOffset = new Vec2(vert, -horz); break;
			case 180: textOffset = new Vec2(-horz, vert); break;
			case 270: textOffset = new Vec2(vert, horz); break;
			default: textOffset = new Vec2(horz, vert); break;
		}
		const worldTextPos = new Vec2(worldOrigin.x + textOffset.x, worldOrigin.y + textOffset.y);
		const textAngle = (rotation === 90 || rotation === 270) ? 90 : 0;
		const anchor = readJustifyAnchor(label);
		const geometry = computeStrokeTextGeometry(name, worldTextPos, textSize, textAngle, false, undefined, anchor);
		const id = label.getUuid() ?? `label:${ origin.x },${ origin.y }`;
		const bbox = { x: worldTextPos.x - textSize * 3, y: worldTextPos.y - textSize, w: textSize * 6, h: textSize * 2 };
		items.push({
			id: `${ id }:text`, layer: 'Labels', kind: 'label', shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: label,
			defaultColor: schColors.labelGlobal,
			draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color),
		});

		const halfSize = textSize / 2 + margin;
		const symbolLength = textWidth + 2 * margin;
		const x = symbolLength + thickness;
		const y = halfSize + thickness;
		const pts: { x: number; y: number }[] = [
			{ x: 0, y: 0 }, { x: 0, y: -y }, { x: -x, y: -y }, { x: -x, y: 0 }, { x: -x, y }, { x: 0, y }, { x: 0, y: 0 },
		];
		let offX = 0;
		if (shape === 'input') {
			offX = -halfSize; pts[0]!.x += halfSize; pts[6]!.x += halfSize;
		}
		else if (shape === 'output') {
			pts[3]!.x -= halfSize;
		}
		else if (shape === 'bidirectional' || shape === 'tri_state') {
			offX = -halfSize; pts[0]!.x += halfSize; pts[6]!.x += halfSize; pts[3]!.x -= halfSize;
		}
		const shapeRotation = rotation + 180;
		const worldPts = pts.map((p) => {
			const rotated = rotateLocalPoint({ x: p.x + offX, y: p.y }, shapeRotation);
			return new Vec2(rotated.x + worldOrigin.x, rotated.y + worldOrigin.y);
		});
		const flagShape: PaintedShape = { type: 'polygon', points: worldPts.map(p => ({ x: p.x, y: p.y })) };
		items.push({
			id: `${ id }:flag`, layer: 'Labels', kind: 'label', shape: flagShape, bbox: shapeToBBox(flagShape),
			hitTestable: true, element: label, defaultColor: schColors.labelGlobal,
			labelName: name, labelKind: 'global',
			draw: (renderer, color) => renderer.line(worldPts, { strokeColor: color, strokeWidth: thickness || 0.15 }),
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
		const { size: textSize, thickness } = readElementFontMetrics(label);
		const anchor = readJustifyAnchor(label);
		const id = label.getUuid() ?? `hlabel:${ origin.x },${ origin.y }`;
		return this.buildHierLabelShape(
			id, name, new Vec2(origin.x, origin.y), rotation, shape, textSize, thickness, anchor.x, label, schColors.labelHier,
			true
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
		/** True for a real, standalone hierarchical_label (selectable, like a
		 *  global label's own flag). False for buildSheet()'s sheet-pin reuse
		 *  of this same shape — a sheet pin isn't independently selectable
		 *  apart from the sheet itself. */
		flagHitTestable = false
	): SchPaintedItem[] {
		const items: SchPaintedItem[] = [];
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

		let textOffset: Vec2;
		switch (rotation) {
			case 90: textOffset = new Vec2(0, -dist); break;
			case 180: textOffset = new Vec2(-dist, 0); break;
			case 270: textOffset = new Vec2(0, dist); break;
			default: textOffset = new Vec2(dist, 0); break;
		}
		const worldTextPos = new Vec2(worldOrigin.x + textOffset.x, worldOrigin.y + textOffset.y);
		const textAngle = (rotation === 90 || rotation === 270) ? 90 : 0;
		const anchor = { x: hAlign, y: 0.5 };
		const geometry = computeStrokeTextGeometry(text, worldTextPos, textSize, textAngle, false, undefined, anchor);
		const bbox = { x: worldTextPos.x - textSize * 3, y: worldTextPos.y - textSize, w: textSize * 6, h: textSize * 2 };
		items.push({
			id: `${ id }:text`, layer: 'Labels', kind: 'label', shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element,
			defaultColor: color,
			draw: (renderer, drawColor) => drawStrokeTextGeometry(renderer, geometry, drawColor),
		});

		const s = textSize;
		let pts: { x: number; y: number }[];
		switch (shape) {
			case 'output':
				pts = [{ x: 0, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 }, { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }];
				break;
			case 'input':
				pts = [{ x: s, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: 0, y: 0 }, { x: s / 2, y: -s / 2 }, { x: s, y: -s / 2 }, { x: s, y: s / 2 }];
				break;
			case 'bidirectional':
			case 'tri_state':
				pts = [{ x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 }, { x: 0, y: 0 }, { x: s / 2, y: s / 2 }];
				break;
			default: // passive
				pts = [{ x: 0, y: s / 2 }, { x: s, y: s / 2 }, { x: s, y: -s / 2 }, { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }];
				break;
		}
		const worldPts = pts.map((p) => {
			const rotated = rotateLocalPoint(p, rotation);
			return new Vec2(rotated.x + worldOrigin.x, rotated.y + worldOrigin.y);
		});
		const flagShape: PaintedShape = { type: 'polygon', points: worldPts.map(p => ({ x: p.x, y: p.y })) };
		items.push({
			id: `${ id }:flag`, layer: 'Labels', kind: 'label', shape: flagShape, bbox: shapeToBBox(flagShape),
			hitTestable: flagHitTestable, element, defaultColor: color,
			// flagHitTestable is only ever false for buildSheet()'s sheet-pin
			// reuse of this shape (buildHierLabel's own call always passes
			// true) — tagging that case 'sheet-pin' (rather than leaving
			// labelKind undefined) lets buildDanglingFlags() recognize a
			// sheet pin as a real connection point without making it
			// independently clickable, which stays intentionally false.
			labelName: flagHitTestable ? text : undefined, labelKind: flagHitTestable ? 'hier' : 'sheet-pin',
			draw: (renderer, drawColor) => renderer.line(worldPts, { strokeColor: drawColor, strokeWidth: thickness || 0.15 }),
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
					{ x: 0, y: pinLength - symbolSize }, { x: 0, y: 0 },
				]
				: [
					{ x: 0, y: 0 }, { x: 0, y: pinLength - symbolSize }, { x: -2 * symbolSize, y: pinLength - symbolSize },
					{ x: -2 * symbolSize, y: pinLength + symbolSize }, { x: 2 * symbolSize, y: pinLength + symbolSize },
					{ x: 2 * symbolSize, y: pinLength - symbolSize }, { x: 0, y: pinLength - symbolSize }, { x: 0, y: 0 },
				];
			const worldPts = localPts.map(toWorld);
			hitShape = { type: 'polygon', points: worldPts.map(p => ({ x: p.x, y: p.y })) };
			draw = (renderer, color) => renderer.line(worldPts, { strokeColor: color, strokeWidth: width });
		}

		items.push({
			id: `${ id }:flag`, layer: 'Labels', kind: 'label', shape: hitShape, bbox: shapeToBBox(hitShape),
			hitTestable: true, element: flag, labelKind: 'directive', defaultColor: schColors.labelDirective, draw,
		});

		if (typeof flag.getProperties === 'function') {
			for (const prop of flag.getProperties()) {
				const value: string | undefined = prop.propertyValue;
				if (!value || (typeof prop.isHidden === 'function' && prop.isHidden())) {
					continue;
				}
				const propOrigin = typeof prop.getOrigin === 'function' ? prop.getOrigin() : { x: origin.x, y: origin.y, rotation: 0 };
				const worldPos = new Vec2(propOrigin.x, propOrigin.y);
				const { size: textSize } = readElementFontMetrics(prop);
				const anchor = typeof prop.getAnchorPoint === 'function' ? prop.getAnchorPoint() : { x: 0, y: 1 };
				const geometry = computeStrokeTextGeometry(value, worldPos, textSize, propOrigin.rotation ?? 0, false, undefined, anchor);
				const bbox = { x: worldPos.x - textSize * 3, y: worldPos.y - textSize, w: textSize * 6, h: textSize * 2 };
				items.push({
					id: `${ id }:prop:${ prop.propertyName }`, layer: 'Text', kind: 'text',
					shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: flag,
					draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color),
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
			id: `${ id }:box`, layer: 'Sheets', kind: 'sheet', shape, bbox: shape, hitTestable: false, element: sheet,
			draw: (renderer, color) => {
				renderer.rect(new Vec2(x, y), w, h, { strokeColor: color, strokeWidth: 0.25 });
			},
		});

		if (typeof sheet.getProperties === 'function') {
			for (const prop of sheet.getProperties()) {
				const value: string | undefined = prop.propertyValue;
				if (!value || (typeof prop.isHidden === 'function' && prop.isHidden())) {
					continue;
				}
				const propOrigin = typeof prop.getOrigin === 'function' ? prop.getOrigin() : { x, y: y - 1, rotation: 0 };
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
				const textSize = 1.27;
				const geometry = computeStrokeTextGeometry(value, worldPos, textSize, propOrigin.rotation ?? 0, false, undefined, anchor);
				const bbox = { x: worldPos.x - 2, y: worldPos.y - 2, w: 4, h: 4 };
				items.push({
					id: `${ id }:prop:${ prop.propertyName }`, layer: 'Text', kind: 'text',
					shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: sheet,
					defaultColor: isFilename ? schColors.sheetFilename : undefined,
					draw: (renderer, color) => drawStrokeTextGeometry(renderer, geometry, color),
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
		// Real KiCad (SCH_PAINTER's sheet-pin handling, ported from
		// kicanvas's SchematicSheetPainter) doesn't draw sheet pins as a
		// circle + plain text at all — it synthesizes a full hierarchical
		// label from each pin and paints THAT, with the rotation flipped
		// 180° and input/output swapped: a pin's own orientation/shape
		// describes the signal as seen from INSIDE the child sheet, but the
		// flag drawn on the PARENT sheet's box needs to point the opposite
		// way and read as the opposite direction.
		if (getPinClass()) {
			for (const pin of sheet.findChildrenByClass(getPinClass())) {
				const pinName = pin.attributes?.[0]?.value as string | undefined;
				if (!pinName) {
					continue;
				}
				const pinOrigin = typeof pin.getOrigin === 'function' ? pin.getOrigin() : { x, y, rotation: 0 };
				const pinShape = (pin.attributes?.[1]?.value as string) ?? 'passive';
				const flippedRotation = ((pinOrigin.rotation ?? 0) + 180) % 360;
				const flippedShape = pinShape === 'input' ? 'output' : pinShape === 'output' ? 'input' : pinShape;
				const { size: pinTextSize, thickness: pinThickness } = readElementFontMetrics(pin);
				const anchor = readJustifyAnchor(pin);
				const markerId = pin.getUuid() ?? `${ id }:pin:${ pinOrigin.x },${ pinOrigin.y }`;
				for (const item of this.buildHierLabelShape(
					markerId, pinName, new Vec2(pinOrigin.x, pinOrigin.y), flippedRotation, flippedShape,
					pinTextSize, pinThickness, anchor.x, pin, schColors.sheetLabel
				)) {
					items.push(item);
				}
			}
		}

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
				&& distanceToSegment(x, y, bus.shape.x1, bus.shape.y1, bus.shape.x2, bus.shape.y2) < JUNCTION_POINT_EPS);
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
		const flags: SchPaintedItem[] = [];

		for (const item of wireLike) {
			if (item.shape.type !== 'segment') {
				continue;
			}
			const isBusEntry = typeof item.element?.getSize === 'function';
			const color = brightenColor(item.defaultColor ?? colorForKind(item.kind), 0.3);
			if (isDangling(item.shape.x1, item.shape.y1) && !(isBusEntry && liesOnAnyBusSpan(item.shape.x1, item.shape.y1))) {
				flags.push(danglingSquare(`${ item.id }:dangling:start`, item.shape.x1, item.shape.y1, color, item.element));
			}
			if (isDangling(item.shape.x2, item.shape.y2) && !(isBusEntry && liesOnAnyBusSpan(item.shape.x2, item.shape.y2))) {
				flags.push(danglingSquare(`${ item.id }:dangling:end`, item.shape.x2, item.shape.y2, color, item.element));
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
			renderer.rect(new Vec2(x - half, y - half), half * 2, half * 2,
				{ strokeColor: drawColor, strokeWidth: DANGLING_STROKE_WIDTH });
		},
	};
}

function danglingCircle(id: string, x: number, y: number, color: string, element: any): SchPaintedItem {
	const shape: PaintedShape = { type: 'circle', cx: x, cy: y, r: DANGLING_CIRCLE_RADIUS };
	return {
		id, layer: 'Dangling', kind: 'dangling', shape, bbox: shapeToBBox(shape), hitTestable: false, element,
		defaultColor: color,
		draw: (renderer, drawColor) => {
			renderer.circle(new Vec2(x, y), DANGLING_CIRCLE_RADIUS, { strokeColor: drawColor, strokeWidth: DANGLING_STROKE_WIDTH });
		},
	};
}

/** KiCad 9 permits an explicit `(stroke … (color r g b a))` on wires. */
function readWireStrokeColor(wire: any): string | null {
	const stroke = typeof wire?.findFirstChildByName === 'function' ? wire.findFirstChildByName('stroke') : null;
	const color = typeof stroke?.findFirstChildByName === 'function' ? stroke.findFirstChildByName('color') : null;
	const values = Array.isArray(color?.attributes) ? color.attributes.map((a: any) => Number(a?.value)) : [];
	if (values.length < 3 || values.slice(0, 3).some((value: number) => !Number.isFinite(value))) return null;
	const [r, g, b, alpha = 1] = values;
	return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.max(0, Math.min(1, alpha))})`;
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
function drawStrokeOutline(renderer: Renderer, ring: Vec2[], width: number, lineType: KicadStrokeLineType, color: string): void {
	strokeDashedPolyline(ring, width, lineType, (segment) => {
		renderer.line(segment, { strokeColor: color, strokeWidth: width || 0.1 });
	});
}

// KiCad's SCH_TEXT::GetTextOffset ratio (DefaultValues.text_offset_ratio),
// reused here for local net labels' wire clearance.
const labelTextOffsetRatio = 0.15;

/** Reads a label element's own font size/thickness — works for both real
 * registered classes (GlobalLabel/HierLabel, which have a typed getFont()
 * via WithEffects) and the plain `label` tag (an untyped generic
 * KicadElement, confirmed gap — read via findFirstChildByName instead). */
function readElementFontMetrics(el: any): { size: number; thickness: number } {
	if (typeof el.getFont === 'function') {
		const font = el.getFont();
		if (font.height > 0) {
			return { size: font.height, thickness: font.thickness || pinThickness };
		}
	}
	const effects = typeof el.findFirstChildByName === 'function' ? el.findFirstChildByName('effects') : null;
	const font = effects && typeof effects.findFirstChildByName === 'function' ? effects.findFirstChildByName('font') : null;
	if (font) {
		const size = typeof font.getSize === 'function' ? font.getSize() : null;
		const thickness = typeof font.getThickness === 'function' ? font.getThickness() : 0;
		if (size && size.height > 0) {
			return { size: size.height, thickness: thickness || pinThickness };
		}
	}
	return { size: 1.27, thickness: pinThickness };
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

function textItem(id: string, layer: string, worldPos: Vec2, textSize: number, element: any, geometry: ReturnType<typeof computeStrokeTextGeometry>, defaultColor: string): SchPaintedItem {
	const bbox = { x: worldPos.x - textSize, y: worldPos.y - textSize, w: textSize * 2, h: textSize * 2 };
	return {
		id, layer, kind: 'text', shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element, defaultColor,
		draw: (renderer, drawColor) => drawStrokeTextGeometry(renderer, geometry, drawColor),
	};
}

/** `(mirror x)` / `(mirror y)` has no registered @kicad-io class (confirmed
 * gap) — falls back to a generic KicadElement whose single literal
 * attribute is still readable directly. */
function readMirror(instance: any): 'x' | 'y' | null {
	const mirrorEl = typeof instance.findFirstChildByName === 'function' ? instance.findFirstChildByName('mirror') : null;
	if (mirrorEl) {
		for (const attr of mirrorEl.attributes) {
			const v = String(attr.value);
			if (v === 'x' || v === 'y') return v as 'x' | 'y';
		}
		for (const child of mirrorEl.children) {
			if (child.name === 'x' || child.name === 'y') return child.name as 'x' | 'y';
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
	const effects = child && typeof child.findFirstChildByName === 'function' ? child.findFirstChildByName('effects') : null;
	const font = effects && typeof effects.findFirstChildByName === 'function' ? effects.findFirstChildByName('font') : null;
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
	const effects = child && typeof child.findFirstChildByName === 'function' ? child.findFirstChildByName('effects') : null;
	const font = effects && typeof effects.findFirstChildByName === 'function' ? effects.findFirstChildByName('font') : null;
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
		case 'right': return { offset: local, flipH: false };
		case 'left': return { offset: new Vec2(-local.x, local.y), flipH: true };
		case 'up': return { offset: new Vec2(local.y, -local.x), flipH: false };
		case 'down': return { offset: new Vec2(local.y, local.x), flipH: true };
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
	const justifyEl = effects && typeof effects.findFirstChildByName === 'function' ? effects.findFirstChildByName('justify') : null;
	const justify = justifyEl && typeof justifyEl.getJustify === 'function' ? justifyEl.getJustify() : null;
	if (!justify) {
		return { x: 0.5, y: 0.5 };
	}
	let x = 0.5, y = 0.5;
	switch (justify.horizontal) {
		case 'left': x = 0; break;
		case 'middle': x = 0.5; break;
		case 'right': x = 1; break;
	}
	switch (justify.vertical) {
		case 'top': y = 0; break;
		case 'middle': y = 0.5; break;
		case 'bottom': y = 1; break;
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
 * to world position. Mirror is applied innermost (before rotation) since it
 * flips the symbol's own body orientation, independent of where the whole
 * assembly then gets rotated/placed — matches real KiCad's placement model. */
function buildInstanceMatrix(x: number, y: number, rotationDeg: number, mirror: 'x' | 'y' | null): Matrix3 {
	// multiply_self does LEFT-multiplication (this = b * this), so building
	// from bottom up: start with translation T, rotate_self gives R*T, then
	// multiply by scaling gives S*R*T (scale innermost → rotate → translate).
	// For row-vector transform(v) = v * M, this gives: ((v * S) * R) + t.
	//
	// KiCad naming: (mirror x) = mirror about X-axis = negate Y in schematic
	// (Y-down) coordinates; (mirror y) = mirror about Y-axis = negate X.
	let matrix = Matrix3.translation(x, y).rotateSelf(Angle.fromDegrees(rotationDeg));
	if (mirror === 'x') {
		matrix = matrix.multiply(Matrix3.scaling(1, -1));
	}
	else if (mirror === 'y') {
		matrix = matrix.multiply(Matrix3.scaling(-1, 1));
	}
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
function arcSweepAngles(center: Vec2, startPt: Vec2, midPt: Vec2, endPt: Vec2): { startAngle: number; endAngle: number } {
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
function symbolFillColor(fillType: string, strokeColor: string): string | undefined {
	switch (fillType) {
		case 'outline': return strokeColor;
		case 'background':
		case 'color': return schColors.componentBody;
		default: return undefined;
	}
}

function colorForKind(kind: SchPaintedItem['kind']): string {
	switch (kind) {
		case 'wire': return schColors.wire;
		case 'bus': return schColors.bus;
		case 'junction': return schColors.junction;
		case 'no-connect': return schColors.noConnect;
		case 'symbol-graphic': return schColors.componentOutline;
		case 'pin': return schColors.pin;
		case 'label': return schColors.labelLocal;
		case 'sheet': return schColors.sheet;
		case 'text': return schColors.reference;
		case 'frame': return schColors.frame;
		case 'dangling': return schColors.wire;
		default: return schColors.componentOutline;
	}
}

// Lazily-resolved class registry — see the file-level comment for why this
// doesn't need to (and shouldn't) hard-code an @kicad-io import path.
let _Wire: any, _Bus: any, _BusEntry: any, _Junction: any, _NoConnect: any, _Symbol: any, _LibSymbols: any;
let _GlobalLabel: any, _HierLabel: any, _Sheet: any, _Pin: any, _NetclassFlag: any, _RuleArea: any;
let _Rect: any, _SymCircle: any, _SymArc: any, _Polyline: any, _At: any, _Size: any, _Text: any;

export function registerSchematicIoClasses(classes: {
	Wire?: any; Bus?: any; BusEntry?: any; Junction?: any; NoConnect?: any; Symbol?: any; LibSymbols?: any;
	GlobalLabel?: any; HierLabel?: any; Sheet?: any; Pin?: any; NetclassFlag?: any; RuleArea?: any;
	Rect?: any; SymCircle?: any; SymArc?: any; Polyline?: any; At?: any; Size?: any; Text?: any;
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
	_Pin = classes.Pin;
	_NetclassFlag = classes.NetclassFlag;
	_RuleArea = classes.RuleArea;
	_Rect = classes.Rect;
	_SymCircle = classes.SymCircle;
	_SymArc = classes.SymArc;
	_Polyline = classes.Polyline;
	_At = classes.At;
	_Size = classes.Size;
	_Text = classes.Text;
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
function getPinClass() { return _Pin; }
function getNetclassFlagClass() { return _NetclassFlag; }
function getRuleAreaClass() { return _RuleArea; }
function getRectClass() { return _Rect; }
function getSymCircleClass() { return _SymCircle; }
function getSymArcClass() { return _SymArc; }
function getPolylineClass() { return _Polyline; }
function getAtClass() { return _At; }
function getSizeClass() { return _Size; }
function getTextClass() { return _Text; }
