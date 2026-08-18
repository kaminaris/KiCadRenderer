import { Vec2 } from '../math/Vec2';
import { Angle } from '../math/Angle';
import { Matrix3 } from '../math/Matrix3';
import { type EmbeddedImage, Renderer } from '../render/Renderer';
import { styleForLayer, colorForLayer, boardBackgroundColor, boardOutlineAreaColor, viaHoleWallColor, viaHoleColor, pointCrossColor, zoneFillAlpha, withAlpha } from './LayerColors';
import { layerPaintOrder } from './LayerOrder';
import { computeStrokeTextGeometry, drawStrokeTextGeometry, getStrokeTextBounds, type StrokeTextGeometry } from './TextPaint';
import { PaintedShape, shapeToBBox, bboxesIntersect } from './PaintedShape';
import { buildBoardOutlineRingsMm, fromClipperPath, toClipperPath } from './BoardZoneFill';
import { getClipperEngine } from './ClipperEngine';
import { EndType, JoinType } from '@clipper2-ts/offset';
import { embeddedImageInfo } from './EmbeddedImage';
import { getBoardBarcodeEncoding } from './BarcodeEncoder';

// KicadBoard/KicadElementFootprint/etc. are only available once the
// @kicad-io submodule is resolved via the @kicad-io/* path alias in the
// consuming app — typed loosely (any) here so this module has no hard
// compile-time dependency on the exact submodule layout, matching how
// api/src/Modules/Bom/Service/KiCad.Service.ts treats element results.

export interface PaintedItem {
	id: string;
	layer: string;
	kind: 'pad' | 'track' | 'via' | 'footprint-ref' | 'footprint' | 'zone' | 'graphic' | 'image';
	// Precise shape for hit-testing; bbox is derived from it and used only
	// as a broad-phase filter (see paint/HitTest.ts). Zones don't
	// participate in hit-testing for the spike (large fills would dominate
	// every click) — shape is a loose bbox-only placeholder for those.
	shape: PaintedShape;
	bbox: { x: number; y: number; w: number; h: number };
	hitTestable: boolean;
	element: any;
	netId?: number | null;
	netName?: string | null;
	/** Zone geometry belongs to one of Pcbnew's primary display modes. */
	zoneDisplayMode?: ZoneDisplayMode;
	// Captures whatever geometry this item needs to redraw itself — built
	// once, replayed every frame against the current camera transform. See
	// LayeredBoardScene.paint() below for how highlight color is threaded
	// through without rebuilding this closure. displayMode is only consulted
	// by pad/via/track items — see paint()'s modeForKind and ItemDisplayMode.
	draw: (renderer: Renderer, color: string, displayMode?: ItemDisplayMode) => void;
}

/**
 * Everything needed to redraw a board, grouped by layer. Built ONCE per
 * data load (see BoardPainter.build) — panning, zooming, toggling layer
 * visibility, changing opacity, or selecting an item all just re-run
 * paint() against this same data, never re-walk the parsed element tree.
 */
export interface LayeredBoardScene {
	/** Layers actually present on this board, in paint order (bottom to top). */
	layersPresent: string[];
	layerBuckets: Map<string, PaintedItem[]>;
	/** All hit-testable items, concatenated in paint order (so HitTest's
	 * reverse-iteration "topmost wins" stays correct across layers). */
	hitTestItems: PaintedItem[];
	/** One entry per (zone, expanded copper layer) — see ZoneFillRegion. */
	zoneFills: ZoneFillRegion[];
	/** Closed Edge.Cuts geometry, normalized to body rings.  This is painted
	 * as KiCad's low-opacity "Board Area Shadow" before every regular board
	 * layer; even-odd rendering preserves slots and internal cutouts. */
	boardBodyRings: Vec2[][];
	/** Copper layers in PHYSICAL stack order (F.Cu first, B.Cu last, exactly
	 *  as declared in the board's own `(layers ...)` table — KiCad writes
	 *  that table in stack order, not the render/paint order layersPresent
	 *  uses). BoardRatsnest needs this to know which internal layers a
	 *  through/blind/buried via's plated barrel actually spans. */
	copperLayerStack: string[];
	/** Every layer name declared in the board's own `(layers ...)` table
	 *  (any type — copper or technical), regardless of whether anything is
	 *  drawn on it yet. layersPresent is unioned with this (see build()) so
	 *  a freshly created/blank board's Appearance panel lists its full
	 *  enabled layer set immediately, matching real KiCad, instead of only
	 *  the handful of layers that happen to already have content — kept
	 *  here so the incremental per-footprint update paths
	 *  (updateFootprintItems/removeFootprintItems) can recompute
	 *  layersPresent without re-deriving this from the board AST each time. */
	declaredLayers: string[];
}

/** A copper pour's authored OUTLINE (not the thermal-relief-carved fill
 * geometry from getFilledPolygons) on one copper layer — used by
 * BoardRatsnest to treat same-net pads/vias/tracks inside the pour as
 * electrically joined by it, the same way real KiCad's connectivity engine
 * tests a pad against a zone's outline rather than its fractured fill (the
 * fill has a clearance gap punched around every pad, so testing a pad's
 * center against IT would wrongly report "not connected" for the exact
 * pads the pour exists to join — see BoardRatsnest.ts). */
export interface ZoneFillRegion {
	netId: number;
	layer: string;
	points: { x: number; y: number }[];
}

export interface LayerVisibilityState {
	visible: boolean;
	opacity: number;
}

/** Pcbnew's two primary zone-display actions. */
export type ZoneDisplayMode = 'filled' | 'outline';

/** Pcbnew's "Sketch Pads/Vias/Tracks" actions — filled copper vs. a stroke-
 *  only boundary, so DRC clearance/annular-ring gaps are easier to eyeball. */
export type ItemDisplayMode = 'filled' | 'outline';

/** World-mm stroke width for outline/"sketch" display modes — matches this
 *  file's existing npthOutlineColor stroke convention (buildPad). */
const SKETCH_STROKE_WIDTH = 0.05;

/**
 * KiCad lifts the active PCB layer above the ordinary board stack while
 * keeping editor overlays above it.  The scene retains its canonical order;
 * this derives the transient draw order needed for the active view.
 */
export function boardPaintOrder(layersPresent: readonly string[], activeLayer: string | null): string[] {
	// PadNumbers must stay the topmost layer unconditionally (see
	// BoardPainter.paint()'s dedicated always-on-top handling for it) — the
	// active-layer promotion below exists to bring copper/silkscreen to the
	// front for highlighting, and without this exclusion it would instead
	// promote the active layer ABOVE PadNumbers, burying every pad number/
	// net name under that layer's own fills whenever a layer is selected
	// (i.e. always, since some layer is always active).
	//
	// Vias get the identical treatment, for the identical reason: real
	// KiCad's PCB_DRAW_PANEL_GAL::SetTopLayer (pcb_draw_panel_gal.cpp)
	// unconditionally calls view->SetTopLayer(LAYER_VIA_THROUGH) — vias sit
	// in the view's permanent "always on top" set, completely independent
	// of the SAME function's separate "bring the active F.*/B.* layer to
	// the front" step for tracks/pads. Letting the active-layer promotion
	// below carry 'Vias' along with it (its previous behavior) meant
	// switching your active layer to F.Cu or B.Cu — which is normally true
	// almost the entire time you're editing a board — silently buried every
	// via under that layer's own tracks, a real reported bug ("tracks
	// render over vias"), not a stated simplification.
	const hasLabels = layersPresent.includes('PadNumbers');
	const hasVias = layersPresent.includes('Vias');
	const rest = layersPresent.filter(layer => layer !== 'PadNumbers' && layer !== 'Vias');
	const ordered = (!activeLayer || !rest.includes(activeLayer))
		? [...rest]
		: [...rest.filter(layer => layer !== activeLayer), activeLayer];
	const withVias = hasVias ? [...ordered, 'Vias'] : ordered;
	return hasLabels ? [...withVias, 'PadNumbers'] : withVias;
}

/** Options for BoardPainter.build() — kept off the hot paint() path. */
export interface BoardPaintOptions {
	/**
	 * When true, draw each pad's number centered on the pad (KiCad
	 * footprint-editor / pad-netname overlay style). Defaults to true,
	 * matching real KiCad's own default board-view behavior.
	 */
	showPadNumbers?: boolean;
	/** When true, draw each pad's net name alongside its number (stacked
	 *  as a 2-line block when both are on). Defaults to true. */
	showNetNames?: boolean;
}

export function defaultLayerState(layersPresent: string[]): Map<string, LayerVisibilityState> {
	const state = new Map<string, LayerVisibilityState>();
	for (const layer of layersPresent) {
		const style = styleForLayer(layer);
		state.set(layer, { visible: true, opacity: style.opacity });
	}
	return state;
}

/**
 * Builds a LayeredBoardScene from a parsed board — pure data, no drawing.
 * Separated from paint() so toggling a layer checkbox or changing opacity
 * never re-walks @kicad-io's element tree, only re-runs the (cheap) draw
 * closures already built here.
 */
export class BoardPainter {
	options: BoardPaintOptions = { showPadNumbers: true, showNetNames: true };

	/** The `activeLayer` argument of the CURRENT/most recent paint() call —
	 *  stashed here so buildVia's draw closure (built once, well before any
	 *  particular paint() call, at build() time) can read whichever layer
	 *  is active AT DRAW TIME. Real KiCad's own via rendering isn't a
	 *  single fixed-color draw either: PCB_PAINTER::draw(PCB_VIA*, aLayer)
	 *  runs once per copper layer the via spans, each pass using THAT
	 *  layer's own color, and whichever pass ends up on top visually
	 *  depends on the SAME active-layer promotion tracks/pads get (see
	 *  boardPaintOrder's doc comment) — switching your active layer to
	 *  B.Cu is what makes a real KiCad via's ring flip to B.Cu's blue. This
	 *  app draws each via as a single circle rather than a stack of
	 *  per-layer passes, so this field is the simplification that gets the
	 *  same user-visible result (ring color follows the active layer, when
	 *  the via actually touches it) without the full multi-pass machinery. */
	protected activePaintLayer: string | null = null;

	build(board: any): LayeredBoardScene {
		const layerBuckets = new Map<string, PaintedItem[]>();
		const pushItem = (item: PaintedItem) => {
			const bucket = layerBuckets.get(item.layer);
			if (bucket) {
				bucket.push(item);
			}
			else {
				layerBuckets.set(item.layer, [item]);
			}
		};

		const globalLayers = this.getGlobalLayerNames(board);

		const segments = board.rootElement.findChildrenByClass(getSegmentClass());
		for (const segment of segments) {
			for (const item of this.buildTrack(segment, board)) {
				pushItem(item);
			}
		}

		if (getTrackArcClass()) {
			const trackArcs = board.rootElement.findChildrenByClass(getTrackArcClass());
			for (const arc of trackArcs) {
				for (const item of this.buildTrackArc(arc, board)) {
					pushItem(item);
				}
			}
		}

		const zones = board.rootElement.findChildrenByClass(getZoneClass());
		for (const zone of zones) {
			for (const item of this.buildZone(zone)) {
				pushItem(item);
			}
		}

		const footprints = board.rootElement.findChildrenByClass(getFootprintClass());
		for (const footprint of footprints) {
			for (const item of this.buildFootprint(footprint, globalLayers, board)) {
				pushItem(item);
			}
		}

		const vias = board.rootElement.findChildrenByClass(getViaClass());
		for (const via of vias) {
			for (const item of this.buildVia(via, board)) {
				pushItem(item);
			}
		}

		if (getImageClass()) {
			const boardVersion = getBoardVersion(board.rootElement);
			const images = board.rootElement.findChildrenByClass(getImageClass());
			for (const image of images) {
				const item = this.buildBoardImage(image, boardVersion);
				if (item) pushItem(item);
			}
		}

		if (getTargetClass()) {
			const targets = board.rootElement.findChildrenByClass(getTargetClass());
			for (const target of targets) {
				const item = this.buildTarget(target);
				if (item) pushItem(item);
			}
		}

		if (getPointClass()) {
			const points = board.rootElement.findChildrenByClass(getPointClass());
			for (const point of points) {
				const item = this.buildPoint(point);
				if (item) pushItem(item);
			}
		}

		if (getBarcodeClass()) {
			for (const barcode of board.rootElement.findChildrenByClass(getBarcodeClass())) {
				const item = this.buildBarcode(barcode);
				if (item) pushItem(item);
			}
		}

		// Board-level graphics can live on any active layer (not only Edge.Cuts).
		// Keeping Edge.Cuts in this ordinary graphic pass also makes a newly
		// placed board outline behave just like the original imported one.
		const graphicLines = board.rootElement.findChildrenByClass(getGrLineClass());
		for (const line of graphicLines) {
			pushItem(this.buildGrLine(line));
		}
		if (getGrVectorClass()) {
			for (const vector of board.rootElement.findChildrenByClass(getGrVectorClass())) {
				pushItem(this.buildGrLine(vector));
			}
		}

		const graphicArcs = board.rootElement.findChildrenByClass(getGrArcClass());
		for (const arc of graphicArcs) {
			const item = this.buildGrArc(arc);
			if (item) {
				pushItem(item);
			}
		}

		const graphicRects = board.rootElement.findChildrenByClass(getGrRectClass());
		for (const rect of graphicRects) {
			pushItem(this.buildGrRect(rect));
		}

		const graphicCircles = board.rootElement.findChildrenByClass(getGrCircleClass());
		for (const circle of graphicCircles) {
			pushItem(this.buildGrCircle(circle));
		}

		const graphicPolygons = board.rootElement.findChildrenByClass(getGrPolyClass());
		for (const polygon of graphicPolygons) {
			const item = this.buildGrPoly(polygon);
			if (item) pushItem(item);
		}

		const graphicCurves = board.rootElement.findChildrenByClass(getGrCurveClass());
		for (const curve of graphicCurves) {
			const item = this.buildGrCurve(curve);
			if (item) pushItem(item);
		}
		if (getGrEllipseClass()) {
			for (const ellipse of board.rootElement.findChildrenByClass(getGrEllipseClass())) {
				const item = this.buildEllipse(ellipse, false);
				if (item) pushItem(item);
			}
		}
		if (getGrEllipseArcClass()) {
			for (const ellipse of board.rootElement.findChildrenByClass(getGrEllipseArcClass())) {
				const item = this.buildEllipse(ellipse, true);
				if (item) pushItem(item);
			}
		}

		if (getDimensionClass()) {
			const dimensions = board.rootElement.findChildrenByClass(getDimensionClass());
			for (const dim of dimensions) {
				for (const item of this.buildDimension(dim)) {
					pushItem(item);
				}
			}
		}

		// Board-level standalone text annotations (as opposed to a
		// footprint's own fp_text, handled in buildFootprint). This only
		// looks at DIRECT children of the board root, so a dimension's own
		// gr_text (nested inside the dimension element, already handled by
		// buildDimension above) is never picked up twice here.
		if (getGrTextClass()) {
			const texts = board.rootElement.findChildrenByClass(getGrTextClass());
			for (const text of texts) {
				const item = this.buildTextElement(text, null);
				if (item) {
					pushItem(item);
				}
			}
		}
		if (getGrTextBoxClass()) {
			const textBoxes = board.rootElement.findChildrenByClass(getGrTextBoxClass());
			for (const textBox of textBoxes) {
				const item = this.buildGrTextBox(textBox);
				if (item) pushItem(item);
			}
		}
		if (getTableClass()) {
			for (const table of board.rootElement.findChildrenByClass(getTableClass())) {
				for (const item of this.buildTable(table)) pushItem(item);
			}
		}

		// Union with the board's own declared layer table (not just layers
		// that happen to have content yet) — see declaredLayers' doc comment.
		const layersPresent = layerPaintOrder.filter(l => layerBuckets.has(l) || globalLayers.includes(l));
		const hitTestItems: PaintedItem[] = [];
		for (const layer of layersPresent) {
			for (const item of layerBuckets.get(layer) ?? []) {
				if (item.hitTestable) {
					hitTestItems.push(item);
				}
			}
		}

		const copperLayerStack = globalLayers.filter(l => l.endsWith('.Cu'));
		const zoneFills = this.buildZoneFills(zones, copperLayerStack);

		const boardBodyRings = this.buildBoardBodyRings(board);

		return { layersPresent, layerBuckets, hitTestItems, zoneFills, boardBodyRings, copperLayerStack, declaredLayers: globalLayers };
	}

	protected buildBoardBodyRings(board: any): Vec2[][] {
		return buildBoardOutlineRingsMm(board)
			.filter(ring => ring.length >= 3)
			.map(ring => ring.map(point => new Vec2(point.x, point.y)));
	}

	/** One ZoneFillRegion per (zone, copper layer it pours onto) — see that
	 *  interface's doc comment for why this uses the authored outline
	 *  (getPolygon) rather than the thermal-relief-carved fill geometry. */
	protected buildZoneFills(zones: any[], copperLayers: string[]): ZoneFillRegion[] {
		const regions: ZoneFillRegion[] = [];
		for (const zone of zones) {
			const netId = typeof zone.getNetId === 'function' ? zone.getNetId() : null;
			if (netId === null || netId <= 0) {
				continue;
			}
			const outline = typeof zone.getPolygon === 'function' ? zone.getPolygon() : [];
			if (outline.length < 3) {
				continue;
			}
			const requested: string[] = typeof zone.getLayers === 'function' ? zone.getLayers() : [];
			const layers = requested.flatMap(layer => layer === '*.Cu' ? copperLayers : [layer])
				.filter(layer => layer.endsWith('.Cu'));
			for (const layer of layers) {
				regions.push({ netId, layer, points: outline });
			}
		}
		return regions;
	}

	/**
	 * Incrementally rebuilds ONE footprint's own PaintedItems in an
	 * already-built scene, without re-walking the rest of the board — used
	 * for continuous drag/rotate/flip, where re-running build() (which
	 * re-decodes stroke-font text and recomputes pad matrices for every
	 * OTHER unchanged footprint too) on every animation frame is the
	 * dominant cost regardless of how little actually moved. Mutates
	 * scene.layerBuckets/hitTestItems/layersPresent in place; does NOT
	 * touch ratsnest (see KicadRenderSession.refreshBoardRatsnest — that
	 * stays a deliberate, separate, less-frequent recompute).
	 */
	updateFootprintItems(scene: LayeredBoardScene, board: any, footprint: any): void {
		this.removeFootprintItems(scene, footprint);

		const globalLayers = this.getGlobalLayerNames(board);
		for (const item of this.buildFootprint(footprint, globalLayers, board)) {
			const bucket = scene.layerBuckets.get(item.layer);
			if (bucket) {
				bucket.push(item);
			}
			else {
				scene.layerBuckets.set(item.layer, [item]);
			}
			if (item.hitTestable) {
				scene.hitTestItems.push(item);
			}
		}

		// Cheap (a few dozen possible layers, not board-size-dependent) —
		// covers the rare case a flip empties or (re)populates a layer. Also
		// unioned with declaredLayers (see its doc comment) so an emptied-out
		// declared layer stays listed instead of disappearing from the
		// Appearance panel.
		scene.layersPresent = layerPaintOrder.filter(l => (scene.layerBuckets.get(l)?.length ?? 0) > 0 || scene.declaredLayers.includes(l));
		// A footprint may own Edge.Cuts geometry (for example a connector
		// footprint defining a notch).  Keep the body shadow in lockstep while
		// that footprint is moved, rotated, or flipped.
		scene.boardBodyRings = this.buildBoardBodyRings(board);
	}

	/**
	 * Removal half of updateFootprintItems, split out for
	 * KicadRenderSession.beginBoardDragPreview — a live drag draws the
	 * footprint through a separate per-frame preview path (see
	 * buildFootprintPreviewItems) instead of baking it back into this scene
	 * on every frame, so the static scene just needs it GONE for the
	 * duration of the drag, with no immediate re-add. Mutates
	 * scene.layerBuckets/hitTestItems/layersPresent in place.
	 */
	removeFootprintItems(scene: LayeredBoardScene, footprint: any): void {
		const origin = footprint.getOrigin();
		const footprintId: string = footprint.getUuid() ?? `fp:${ origin.x },${ origin.y }`;
		const belongsToFootprint = (id: string) => id === footprintId || id.startsWith(`${ footprintId }:`);

		for (const [layer, items] of scene.layerBuckets) {
			if (items.some(it => belongsToFootprint(it.id))) {
				scene.layerBuckets.set(layer, items.filter(it => !belongsToFootprint(it.id)));
			}
		}
		scene.hitTestItems = scene.hitTestItems.filter(it => !belongsToFootprint(it.id));
		scene.layersPresent = layerPaintOrder.filter(l => (scene.layerBuckets.get(l)?.length ?? 0) > 0 || scene.declaredLayers.includes(l));
	}

	/**
	 * Builds a footprint's own PaintedItems without touching any scene — the
	 * live drag-preview path (KicadRenderSession.updateBoardDragPreview)
	 * calls this every frame and draws the result through the cheap
	 * per-frame dynamic buffer instead of baking it into the static one.
	 */
	buildFootprintPreviewItems(board: any, footprint: any): PaintedItem[] {
		return this.buildFootprint(footprint, this.getGlobalLayerNames(board), board);
	}

	/**
	 * removeFootprintItems' generic sibling for a plain id set — used by a
	 * track-body drag (KicadRenderSession.beginTrackDragPreview) to pull the
	 * original assembled line's segments out of the static scene for the
	 * duration of the drag, exactly like removeFootprintItems does for a
	 * footprint: the live shape is already drawn separately (there, a
	 * per-frame preview path; here, the route-style editPreview overlay
	 * BoardPointerController already builds from dragSegment45's result), so
	 * leaving the untouched, still-selected originals in the static scene
	 * would draw two copies of the same track — the stationary highlighted
	 * original underneath the moving preview. No footprint-prefix matching
	 * needed here (unlike removeFootprintItems, a segment id never owns
	 * child items), so this is exact-id membership only. Mutates
	 * scene.layerBuckets/hitTestItems/layersPresent in place, same contract
	 * as removeFootprintItems.
	 */
	removeItemsByIds(scene: LayeredBoardScene, ids: ReadonlySet<string>): void {
		if (ids.size === 0) {
			return;
		}
		for (const [layer, items] of scene.layerBuckets) {
			if (items.some(it => ids.has(it.id))) {
				scene.layerBuckets.set(layer, items.filter(it => !ids.has(it.id)));
			}
		}
		scene.hitTestItems = scene.hitTestItems.filter(it => !ids.has(it.id));
		scene.layersPresent = layerPaintOrder.filter(l => (scene.layerBuckets.get(l)?.length ?? 0) > 0 || scene.declaredLayers.includes(l));
	}

	/**
	 * Draws a scene built by build(). Cheap: just replays already-built draw
	 * closures per visible layer, in order, with that layer's opacity — no
	 * parsing, no element-tree walking, safe to call every frame.
	 */
	paint(
		scene: LayeredBoardScene,
		renderer: Renderer,
		layerState: Map<string, LayerVisibilityState>,
		activeLayer: string | null = null,
		zoneDisplayMode: ZoneDisplayMode = 'filled',
		highlightedIds: Set<string> = new Set(),
		itemDisplayModes: { pad: ItemDisplayMode; via: ItemDisplayMode; track: ItemDisplayMode } =
			{ pad: 'filled', via: 'filled', track: 'filled' },
		/** Pcbnew's "Highlight Net" — items on this net draw in the highlight
		 *  color; every OTHER item that has a net (copper: pads/tracks/vias/
		 *  zones) is dimmed instead, so the highlighted net visually pops
		 *  without hiding board context (silkscreen/edge-cuts have no net and
		 *  stay at full opacity either way). */
		highlightedNetId: number | null = null,
		/** World-space visible rect — when given, items whose bbox falls
		 *  entirely outside it are skipped. Omit to draw everything (e.g. the
		 *  WebGL tessellation pass, which must stay complete since it isn't
		 *  redone on every pan/zoom — see KicadRenderSession.render). */
		viewBBox?: { x: number; y: number; w: number; h: number }
	): void {
		this.activePaintLayer = activeLayer;
		// Pcbnew renders the special LAYER_BOARD_OUTLINE_AREA first, below all
		// real layers.  Use one even-odd multi-polygon so nested Edge.Cuts
		// rings remain transparent cutouts instead of becoming filled islands.
		if (scene.boardBodyRings.length > 0) {
			renderer.setOpacity?.(1);
			renderer.beginBatch?.();
			renderer.multiPolygon(scene.boardBodyRings, { fillColor: boardOutlineAreaColor });
			renderer.endBatch?.();
		}
		// Collected during the main per-layer pass below, then redrawn once
		// more at the very end (see after the loop) — a highlighted/selected
		// track needs to visually sit above EVERY other item on its copper
		// layer, including a pad, not just other tracks. build() pushes
		// tracks before footprints/pads into each layer's bucket, so in
		// submission order a pad always wins over a track on the same spot;
		// that's the right default (pads should normally read as the more
		// prominent feature), but it also means a selected track can vanish
		// under an overlapping pad with no visual feedback at all. Real
		// KiCad's own GAL view solves this the same way: selected items
		// render in their own top-most Z pass, independent of their normal
		// item-type ordering.
		const highlightOverlay: { item: PaintedItem; color: string; mode: ItemDisplayMode }[] = [];
		for (const layer of boardPaintOrder(scene.layersPresent, activeLayer)) {
			// Pad number/net name overlays aren't a real KiCad layer — they
			// track their own pad's visibility (gated by showPadNumbers/
			// showNetNames at build time, see BoardPainter.options) and must
			// stay fully readable no matter which layer is active or
			// dimmed/hidden by high-contrast mode, exactly like real KiCad's
			// own pad-text painting. Skip the normal per-layer
			// visible/opacity gate for this one synthetic bucket only.
			const isPadLabelLayer = layer === 'PadNumbers';
			const state = layerState.get(layer);
			if (!isPadLabelLayer && (!state || !state.visible)) {
				continue;
			}
			// A declared-but-empty layer (see declaredLayers' doc comment) has
			// no bucket at all yet — nothing to draw, just move on.
			const items = scene.layerBuckets.get(layer);
			if (!items) {
				continue;
			}
			const baseColor = styleForLayer(layer).color;

			renderer.setOpacity?.(isPadLabelLayer ? 1 : state!.opacity);
			// Batched per-layer purely to match the existing call structure —
			// what "batch" actually means is backend-specific now:
			// Canvas2dRenderer still commits per-layer (opacity is baked into
			// its fillStyle-alpha at commit time via globalAlpha), while
			// WebGLRenderer bakes opacity into each vertex's own alpha
			// channel and keeps accumulating across ALL layers, only
			// actually drawing once the caller calls renderer.flush() after
			// every layer is done — see demo/main.ts's render().
			renderer.beginBatch?.();
			for (const item of items) {
				if (item.zoneDisplayMode && item.zoneDisplayMode !== zoneDisplayMode) {
					continue;
				}
				if (viewBBox && !bboxesIntersect(item.bbox, viewBBox)) {
					continue;
				}
				const highlighted = highlightedIds.has(item.id);
				if (item.kind === 'footprint') {
					// The synthetic footprint item has no normal visual of its own,
					// but its union bbox makes whole-footprint selection visible even
					// when the click landed on non-hit-testable silkscreen geometry.
					if (highlighted) {
						renderer.rect(new Vec2(item.bbox.x, item.bbox.y), item.bbox.w, item.bbox.h,
							{ strokeColor: '#ffcc00', strokeWidth: 0.18 });
					}
					continue;
				}
				const netHighlighted = highlightedNetId !== null && item.netId === highlightedNetId;
				let color: string;
				if (highlighted || netHighlighted) {
					color = '#ffcc00';
				}
				else if (highlightedNetId !== null && item.netId != null && item.netId > 0) {
					color = withAlpha(baseColor, 0.2);
				}
				else {
					color = baseColor;
				}
				const mode = item.kind === 'pad' ? itemDisplayModes.pad
					: item.kind === 'via' ? itemDisplayModes.via
					: item.kind === 'track' ? itemDisplayModes.track
					: 'filled';
				item.draw(renderer, color, mode);
				if (highlighted) {
					highlightOverlay.push({ item, color, mode });
				}
			}
			renderer.endBatch?.();
		}
		// Redraw every explicitly-highlighted item once more, after every
		// normal layer has already been submitted — see highlightOverlay's
		// doc comment above. Submission order is what determines on-top-ness
		// for both backends here (Canvas2D commits per-layer as it goes;
		// WebGL accumulates every layer's vertices into one buffer and only
		// actually draws on the caller's later flush() — either way, later
		// submission wins), so this final pass is enough on its own, no
		// separate depth/z mechanism needed.
		if (highlightOverlay.length > 0) {
			renderer.beginBatch?.();
			for (const { item, color, mode } of highlightOverlay) {
				item.draw(renderer, color, mode);
			}
			renderer.endBatch?.();
		}
	}

	protected getGlobalLayerNames(board: any): string[] {
		const layersEl = board.rootElement.findFirstChildByClass(getLayersClass());
		if (!layersEl) {
			return [];
		}
		return (layersEl.layers ?? []).map((l: any) => l.name);
	}

	protected buildTrack(segment: any, board: any): PaintedItem[] {
		const { start, end } = segment.getStartEnd();
		const layer = getCopperItemLayer(segment);
		const width = segment.getWidth ? segment.getWidth() : 0.25;
		const id = segment.getUuid() ?? `track:${ start.x },${ start.y }-${ end.x },${ end.y }`;
		const shape: PaintedShape = { type: 'segment', x1: start.x, y1: start.y, x2: end.x, y2: end.y, width };

		const items: PaintedItem[] = [{
			id, layer, kind: 'track', shape, bbox: shapeToBBox(shape), hitTestable: true, element: segment,
			netId: typeof segment.getNetId === 'function' ? segment.getNetId() : null,
			netName: typeof segment.getNetName === 'function' ? segment.getNetName() : null,
			draw: (renderer, color, displayMode) => {
				if (displayMode === 'outline') {
					// "Sketch Tracks" — the track's actual copper boundary (a
					// capsule the current fill hides), not a thin centerline.
					const dx = end.x - start.x, dy = end.y - start.y;
					const len = Math.hypot(dx, dy);
					const half = width / 2;
					const nx = len > 0 ? -dy / len * half : 0;
					const ny = len > 0 ? dx / len * half : half;
					renderer.polygon([
						new Vec2(start.x + nx, start.y + ny), new Vec2(end.x + nx, end.y + ny),
						new Vec2(end.x - nx, end.y - ny), new Vec2(start.x - nx, start.y - ny),
					], { strokeColor: color, strokeWidth: SKETCH_STROKE_WIDTH });
					return;
				}
				renderer.line([new Vec2(start.x, start.y), new Vec2(end.x, end.y)], { strokeColor: color, strokeWidth: width });
			},
		}];
		const maskLayer = getSolderMaskLayer(segment, layer);
		if (maskLayer) {
			const maskWidth = Math.max(0, width + getTrackMaskExpansion(segment, board) * 2);
			items.push(this.buildTrackMaskItem(id, maskLayer, start, end, maskWidth, segment));
		}
		return items;
	}

	protected buildTrackMaskItem(
		id: string, layer: string, start: { x: number; y: number }, end: { x: number; y: number },
		width: number, element: any,
	): PaintedItem {
		const shape: PaintedShape = { type: 'segment', x1: start.x, y1: start.y, x2: end.x, y2: end.y, width };
		return {
			id: `${ id }:${ layer }`, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape),
			hitTestable: false, element,
			draw: (renderer, color) => renderer.line(
				[new Vec2(start.x, start.y), new Vec2(end.x, end.y)], { strokeColor: color, strokeWidth: width },
			),
		};
	}

	/** A curved copper track — segment's arc counterpart (e.g. rounded
	 *  corners on a length-tuning/meander pattern). Not hit-testable yet:
	 *  same limitation buildGrArc already has — PaintedShape has no
	 *  sweep-aware arc variant, so a 'circle' hit-shape would wrongly accept
	 *  clicks anywhere on the full ring, not just the drawn arc. */
	protected buildTrackArc(arc: any, board: any): PaintedItem[] {
		if (typeof arc.getArcCenterRadiusAngles !== 'function') {
			return [];
		}
		const { centerX, centerY, radius, startAngle, endAngle } = arc.getArcCenterRadiusAngles();
		const layer = getCopperItemLayer(arc);
		const width = typeof arc.getWidth === 'function' ? arc.getWidth() : 0.25;
		const id = arc.getUuid() ?? `track-arc:${ layer }:${ centerX },${ centerY }`;
		// filled: false keeps hit-testing to a ring around the arc's radius
		// (matching SchematicPainter.buildSchCircle's same fix) — without it
		// the whole disc the arc lies on would steal clicks from anything
		// drawn inside it, and clicking anywhere in that disc (not just near
		// the visible curve) would select the arc.
		const shape: PaintedShape = { type: 'circle', cx: centerX, cy: centerY, r: radius, filled: false, strokeWidth: width };

		const items: PaintedItem[] = [{
			id, layer, kind: 'track', shape, bbox: shapeToBBox(shape), hitTestable: true, element: arc,
			netId: typeof arc.getNetId === 'function' ? arc.getNetId() : null,
			netName: typeof arc.getNetName === 'function' ? arc.getNetName() : null,
			draw: (renderer, color) => {
				renderer.arc(new Vec2(centerX, centerY), radius, startAngle, endAngle, { strokeColor: color, strokeWidth: width });
			},
		}];
		const maskLayer = getSolderMaskLayer(arc, layer);
		if (maskLayer) {
			const maskWidth = Math.max(0, width + getTrackMaskExpansion(arc, board) * 2);
			items.push({
				id: `${ id }:${ maskLayer }`, layer: maskLayer, kind: 'graphic', shape,
				bbox: shapeToBBox(shape), hitTestable: false, element: arc,
				draw: (renderer, color) => renderer.arc(
					new Vec2(centerX, centerY), radius, startAngle, endAngle,
					{ strokeColor: color, strokeWidth: maskWidth },
				),
			});
		}
		return items;
	}

	protected buildZone(zone: any): PaintedItem[] {
		const items: PaintedItem[] = [];
		const zoneId = zone.getUuid() ?? 'zone';
		const netId = typeof zone.getNetId === 'function' ? zone.getNetId() : null;
		const netName = typeof zone.getNetName === 'function' ? zone.getNetName() : null;
		const filledPolygons: { layer: string; points: { x: number; y: number }[] }[] =
			typeof zone.getFilledPolygons === 'function' ? zone.getFilledPolygons() : [];
		const outline: { x: number; y: number }[] = typeof zone.getPolygon === 'function' ? zone.getPolygon() : [];
		const layers: string[] = typeof zone.getLayers === 'function' ? zone.getLayers() :
			[...new Set(filledPolygons.map(polygon => polygon.layer))];
		// Pcbnew uses `m_outlineWidth` for both the perimeter and hatch lines,
		// initialized to one PCB internal unit (1 nm).  KiCad's GAL rasterizer
		// promotes that to a thin display stroke.  Our renderers take world-mm
		// widths, so use their smallest reliably visible equivalent rather than
		// the zone's `min_thickness` copper width.
		const displayOutlineWidth = 0.025;
		const hatch = typeof zone.findFirstChildByName === 'function'
			? zone.findFirstChildByName('hatch') : undefined;
		const hatchStyle = String(hatch?.attributes?.[0]?.value ?? 'edge');
		const hatchPitch = Number(hatch?.attributes?.[1]?.value);
		const edgeHatches = hatchStyle === 'edge'
			? buildZoneEdgeHatches(outline, Number.isFinite(hatchPitch) && hatchPitch > 0 ? hatchPitch : 0.5)
			: [];

		// Outline mode displays the authored zone boundary, not the derived
		// edge of a fill. Real KiCad always shows a zone's hatched outline
		// when it has no computed fill on a layer regardless of the global
		// Filled/Outline display setting — there's nothing to show AS
		// filled — so this only gets tagged 'outline' (i.e. hidden while
		// the global mode is 'filled', per BoardPainter.paint's
		// zoneDisplayMode filter) on a layer that DOES have a fill; an
		// unfilled layer's outline item is left untagged so it always paints.
		if (outline.length >= 3) {
			const filledLayers = new Set(filledPolygons.map(fp => fp.layer));
			const points = outline.map(point => new Vec2(point.x, point.y));
			const bbox = boundsOfPoints(outline);
			// hitTestable:true with an UNFILLED closed polygon shape — same
			// edge-only pattern as buildRuleArea (PaintedShape's `filled ===
			// false` branch) — so a zone is selectable by clicking near its
			// border without its (often board-spanning) bbox swallowing every
			// click over the components/traces it encloses. The fill items
			// below stay hitTestable:false per their own doc comment.
			for (const layer of layers) {
				const isFilled = filledLayers.has(layer);
				items.push({
					id: `${ zoneId }:${ layer }:outline`, layer, kind: 'zone',
					shape: { type: 'polygon', points: outline, filled: false, closed: true, strokeWidth: displayOutlineWidth },
					bbox, hitTestable: true, element: zone,
					zoneDisplayMode: isFilled ? 'outline' : undefined, netId, netName,
					draw: (renderer, color) => {
						renderer.polygon(points, { strokeColor: color, strokeWidth: displayOutlineWidth });
						for (const [start, end] of edgeHatches) {
							renderer.line([start, end], { strokeColor: color, strokeWidth: displayOutlineWidth });
						}
					},
				});
				// Real KiCad ALSO strokes the zone's own authored boundary at
				// FULL opacity on top of a filled layer — PCB_PAINTER::draw
				// (ZONE*) runs the outline as a separate pass from the fill,
				// same net/layer color but with alpha forced to 1.0
				// (`color.WithAlpha(1.0)`), independent of the fill pass's own
				// zone-opacity multiplier (`color.a *= m_zoneOpacity`). So a
				// filled zone's border reads as a crisp, undimmed line even
				// though its copper pour is translucent. Untagged (unlike the
				// hatched item above) so it always paints regardless of
				// zoneDisplayMode — real KiCad's Filled/Outline toggle only
				// ever gates the FILL polygon, never this border.
				if (isFilled) {
					items.push({
						id: `${ zoneId }:${ layer }:border`, layer, kind: 'zone',
						shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: zone,
						netId, netName,
						draw: (renderer, color) => {
							renderer.polygon(points, { strokeColor: color, strokeWidth: displayOutlineWidth });
						},
					});
				}
			}
		}

		filledPolygons.forEach((fp, idx) => {
			if (fp.points.length < 3) {
				return;
			}
			const points = fp.points.map(p => new Vec2(p.x, p.y));
			const bbox = boundsOfPoints(fp.points);
			items.push({
				id: `${ zoneId }:${ fp.layer }:fill:${ idx }`,
				layer: fp.layer,
				kind: 'zone',
				shape: { type: 'rect', ...bbox },
				bbox,
				// Zone fills are large by definition — including them in
				// hit-testing would make them win almost every click over
				// the actual components/traces on top of them.
				hitTestable: false,
				element: zone,
				zoneDisplayMode: 'filled', netId, netName,
				draw: (renderer, color) => {
					// multiPolygon(), not polygon() — a zone fill (copper
					// pour) is frequently concave (it weaves around
					// keepouts, other pads, board edges), and polygon()'s
					// fan-triangulation-from-the-first-vertex only produces
					// correct coverage for CONVEX shapes. Passing it as a
					// single-ring multiPolygon routes it through the
					// stencil-based fill instead, which is correct for any
					// polygon shape, convex or not (see multiPolygon's own
					// implementation comment for why).
					//
					// Zones bake in their own fixed translucency (real
					// copper — tracks, pads, vias — is fully opaque; it's
					// specifically area/pour fills that KiCad renders
					// translucent) instead of relying on the layer's own
					// opacity, which is now 1.0 by default.
					renderer.multiPolygon([points], { fillColor: withAlpha(color, zoneFillAlpha) });
				},
			});
		});

		return items;
	}

	protected buildFootprint(footprint: any, globalLayers: string[], board: any): PaintedItem[] {
		const items: PaintedItem[] = [];
		const origin = footprint.getOrigin();
		const footprintId = footprint.getUuid() ?? `fp:${ origin.x },${ origin.y }`;
		const footprintLayer: string = typeof footprint.getLayer === 'function' ? footprint.getLayer() : 'F.Cu';
		const isBack = footprintLayer.startsWith('B.');

		// Footprint-to-world transform: translate then rotate — matches
		// kicanvas's FootprintPainter (Matrix3.translation(pos).rotate_self(rotation)),
		// which every child item (pads, text, graphics) is drawn relative to.
		const footprintMatrix = Matrix3.translation(origin.x, origin.y)
			.rotateSelf(Angle.fromDegrees(origin.rotation ?? 0));

		let pads: any[] = [];
		try {
			pads = footprint.findChildrenByClass(getPadClass());
		}
		catch {
			// A parser gap on one footprint (e.g. an unsupported pad attribute)
			// should not take down the whole board render.
			return items;
		}

		// Some footprints (e.g. a high-current mounting-hole pad ringed by
		// several small thermal/via pads, all listed under the same pad
		// "1") mix one big pad with several small ones in arbitrary file
		// order. Since items within a layer bucket paint in array order,
		// drawing the big pad AFTER a small one buries that small pad's
		// hole under the big pad's opaque fill. Sorting biggest-first (so
		// big pads are always laid down before small ones, regardless of
		// file order) means a small pad is never drawn before something
		// that would cover it.
		const padsBySizeDesc = [...pads].sort((a, b) => {
			const sizeA = a.getSize(), sizeB = b.getSize();
			return (sizeB.width * sizeB.height) - (sizeA.width * sizeA.height);
		});
		for (const pad of padsBySizeDesc) {
			for (const item of this.buildPad(pad, footprintMatrix, origin.rotation ?? 0, footprint, footprintId, globalLayers, board)) {
				items.push(item);
			}
		}

		// Every non-hidden property (Reference, Value, and any custom ones a
		// footprint carries) gets its own position/layer in the file — read
		// that directly instead of only special-casing Reference and
		// guessing its layer from the footprint's side.
		if (typeof footprint.getVisibleProperties === 'function') {
			const visibleProps = footprint.getVisibleProperties();
			for (const name of Object.keys(visibleProps)) {
				const prop = visibleProps[name];
				const value: string | undefined = prop.propertyValue;
				if (!value) {
					continue;
				}
				const propOrigin = typeof prop.getOrigin === 'function' ? prop.getOrigin() : { x: 0, y: 0, rotation: 0 };
				const propLayer: string = typeof prop.getLayer === 'function' ? prop.getLayer() : (isBack ? 'B.SilkS' : 'F.SilkS');
				const font = typeof prop.getFont === 'function' ? prop.getFont() : { height: 1 };
				const textSize = font.height || 1;
				const textWorld = footprintMatrix.transform(new Vec2(propOrigin.x, propOrigin.y));
				const textAngle = footprintTextDrawAngle(prop, origin.rotation ?? 0);
				// KiCad's real default (no explicit justify element) is
				// center/middle-anchored, not left/top — getAnchorPoint()
				// (via WithJustify) already encodes that default.
				const anchor = typeof prop.getAnchorPoint === 'function' ? prop.getAnchorPoint() : { x: 0, y: 0 };
				// Glyph geometry decoded ONCE here (build time), not inside
				// draw() — this text is static, so redoing the Newstroke
				// decode on every repaint was pure waste and, measured on a
				// text-heavy board, the majority of per-frame cost.
				const geometry = computeStrokeTextGeometry(value, textWorld, textSize, textAngle, isBack, undefined, anchor);
				items.push({
					id: `${ footprintId }:prop:${ name }`,
					layer: propLayer,
					kind: 'footprint-ref',
					shape: { type: 'rect', x: textWorld.x - textSize, y: textWorld.y - textSize, w: textSize * 2, h: textSize * 2 },
					bbox: { x: textWorld.x - textSize, y: textWorld.y - textSize, w: textSize * 2, h: textSize * 2 },
					hitTestable: false,
					element: footprint,
					draw: (renderer, color) => {
						drawStrokeTextGeometry(renderer, geometry, color);
					},
				});
			}
		}

		// Footprint graphic outlines (courtyard/fab/silkscreen/etc. shapes
		// drawn as part of the footprint itself, not the reference text) —
		// these were entirely missing before, which is most of why rendered
		// footprints looked like bare pad clusters instead of real parts.
		if (typeof footprint.findChildrenByClass === 'function') {
			if (getPointClass()) {
				for (const point of footprint.findChildrenByClass(getPointClass())) {
					const item = this.buildPoint(point, footprintMatrix, footprintId);
					if (item) items.push(item);
				}
			}
			if (getImageClass()) {
				const boardVersion = getBoardVersion(board.rootElement);
				for (const image of footprint.findChildrenByClass(getImageClass())) {
					const item = this.buildBoardImage(image, boardVersion, footprintMatrix, footprintId);
					if (item) items.push(item);
				}
			}
			if (getFpLineClass()) {
				for (const line of footprint.findChildrenByClass(getFpLineClass())) {
					items.push(this.buildFpLine(line, footprintMatrix, footprintId));
				}
			}
			if (getFpRectClass()) {
				for (const rect of footprint.findChildrenByClass(getFpRectClass())) {
					items.push(this.buildFpRect(rect, footprintMatrix, footprintId));
				}
			}
			if (getFpCircleClass()) {
				for (const circle of footprint.findChildrenByClass(getFpCircleClass())) {
					items.push(this.buildFpCircle(circle, footprintMatrix, footprintId));
				}
			}
			if (getFpArcClass()) {
				for (const arc of footprint.findChildrenByClass(getFpArcClass())) {
					const item = this.buildFpArc(arc, footprintMatrix, origin.rotation ?? 0, footprintId);
					if (item) {
						items.push(item);
					}
				}
			}
			if (getFpPolyClass()) {
				for (const poly of footprint.findChildrenByClass(getFpPolyClass())) {
					const item = this.buildFpPoly(poly, footprintMatrix, footprintId);
					if (item) {
						items.push(item);
					}
				}
			}
			// Free-standing footprint text (pin-function labels, "${REFERENCE}"
			// variable placeholders, etc.) — a completely different element
			// from the Reference/Value `property` fields handled above, and
			// was entirely unrendered before this.
			if (getFpTextClass()) {
				for (const text of footprint.findChildrenByClass(getFpTextClass())) {
					const item = this.buildTextElement(text, footprintMatrix, footprintId, origin.rotation ?? 0);
					if (item) {
						items.push(item);
					}
				}
			}
			if (getFpCurveClass()) {
				for (const curve of footprint.findChildrenByClass(getFpCurveClass())) {
					const item = this.buildCurve(curve, footprintMatrix, footprintId);
					if (item) items.push(item);
				}
			}
			if (getFpEllipseClass()) {
				for (const ellipse of footprint.findChildrenByClass(getFpEllipseClass())) {
					const item = this.buildEllipse(ellipse, false, footprintMatrix, footprintId);
					if (item) items.push(item);
				}
			}
			if (getFpEllipseArcClass()) {
				for (const ellipse of footprint.findChildrenByClass(getFpEllipseArcClass())) {
					const item = this.buildEllipse(ellipse, true, footprintMatrix, footprintId);
					if (item) items.push(item);
				}
			}
			if (getFpTextBoxClass()) {
				for (const textBox of footprint.findChildrenByClass(getFpTextBoxClass())) {
					const item = this.buildPcbTextBox(textBox, footprintMatrix, footprintId, origin.rotation ?? 0, false);
					if (item) items.push(item);
				}
			}
			if (getTableClass()) {
				for (const table of footprint.findChildrenByClass(getTableClass())) {
					items.push(...this.buildTable(table, footprintMatrix, footprintId, origin.rotation ?? 0));
				}
			}
		}

		// KiCad does not select a footprint through an axis-aligned union of
		// its rendering bboxes. FOOTPRINT::GetBoundingHull() constructs a
		// convex hull from its pads and drawings, explicitly excluding fields
		// (Reference/Value/custom properties). Mirror that here: a property
		// positioned far away must never make the empty space between it and
		// the component selectable.
		const hullPoints = convexHull(footprintHullPoints(items));
		const fallbackHull = hullPoints.length >= 3 ? hullPoints : [
			{ x: origin.x - 1, y: origin.y - 1 },
			{ x: origin.x + 1, y: origin.y - 1 },
			{ x: origin.x + 1, y: origin.y + 1 },
			{ x: origin.x - 1, y: origin.y + 1 },
		];
		const shape: PaintedShape = { type: 'polygon', points: fallbackHull };
		items.unshift({
			id: footprintId,
			layer: footprintLayer,
			kind: 'footprint',
			shape,
			bbox: shapeToBBox(shape),
			hitTestable: true,
			element: footprint,
			draw: () => {},
		});

		return items;
	}

	/**
	 * Renders a gr_text/fp_text element. Two real KiCad text-rendering
	 * concerns show up here that plain "draw the string" doesn't handle:
	 *
	 * 1. Custom (non-Newstroke) fonts — KiCad ships a `render_cache` with
	 *    the ALREADY-COMPUTED absolute-coordinate glyph outlines whenever a
	 *    text uses a font our vector StrokeFont can't reproduce (bold,
	 *    italic, or a real TTF face like "Century Gothic" — as seen on this
	 *    board's connector pinout silkscreen labels). When present, that
	 *    cache is authoritative and is used directly instead of trying to
	 *    stroke-render the string ourselves; being pre-transformed, it needs
	 *    no footprint-matrix or origin math applied.
	 * 2. "Knockout" text — silkscreen has one color, so KiCad fakes reversed
	 *    (light-on-dark) text by filling a background swatch behind the
	 *    glyphs and cutting the glyph shapes out of it. Approximated here as
	 *    a plain rect behind the glyphs, painted in the board background
	 *    color — not KiCad's exact rounded-margin swatch, but visibly
	 *    correct (readable light text on a filled patch) rather than absent.
	 */
	protected buildTextElement(textEl: any, footprintMatrix: Matrix3 | null, footprintId?: string, footprintRotation = 0): PaintedItem | null {
		if (!textEl.value) {
			return null;
		}
		if (typeof textEl.isHidden === 'function' && textEl.isHidden()) {
			return null;
		}
		const layer: string = typeof textEl.getLayer === 'function' ? textEl.getLayer() : 'F.SilkS';
		const isBack = layer.startsWith('B.');
		const knockout = isKnockoutLayer(textEl);
		const rawId = textEl.getUuid() ?? `text:${ layer }:${ textEl.value }`;
		// Namespaced under footprintId when this is a footprint's own fp_text
		// (footprintMatrix non-null) — see buildFpLine's doc comment. Board-
		// level standalone gr_text (footprintId undefined) has no owner to
		// namespace under and keeps its bare id.
		const id = footprintId ? `${ footprintId }:${ rawId }` : rawId;

		const cacheRings = getRenderCacheRings(textEl);
		if (cacheRings) {
			const worldRings = cacheRings.map(ring => ring.map(p => new Vec2(p.x, p.y)));
			const bbox = boundsOfPoints(worldRings.flat().map(p => ({ x: p.x, y: p.y })));
			return {
				id, layer, kind: 'graphic', shape: { type: 'rect', ...bbox }, bbox, hitTestable: true, element: textEl,
				draw: (renderer, color) => {
					if (knockout) {
						const margin = 0.3;
						renderer.rect(
							new Vec2(bbox.x - margin, bbox.y - margin), bbox.w + margin * 2, bbox.h + margin * 2,
							{ fillColor: color },
						);
						renderer.multiPolygon(worldRings, { fillColor: boardBackgroundColor });
					}
					else {
						renderer.multiPolygon(worldRings, { fillColor: color });
					}
				},
			};
		}

		// No render_cache — plain Newstroke-renderable text.
		const origin = typeof textEl.getOrigin === 'function' ? textEl.getOrigin() : { x: 0, y: 0, rotation: 0 };
		const worldPos = footprintMatrix ? footprintMatrix.transform(new Vec2(origin.x, origin.y)) : new Vec2(origin.x, origin.y);
		const angleDeg = footprintMatrix
			? footprintTextDrawAngle(textEl, footprintRotation)
			: origin.rotation ?? 0;
		const font = typeof textEl.getFont === 'function' ? textEl.getFont() : { height: 1 };
		const textSize = font.height || 1;
		const value = textEl.value;
		const anchor = typeof textEl.getAnchorPoint === 'function' ? textEl.getAnchorPoint() : { x: 0, y: 0 };
		const geometry = computeStrokeTextGeometry(value, worldPos, textSize, angleDeg, isBack, undefined, anchor);
		const bbox = getStrokeTextBounds(geometry);

		return {
			id, layer, kind: 'graphic', shape: { type: 'rect', ...bbox }, bbox, hitTestable: true, element: textEl,
			draw: (renderer, color) => {
				if (knockout) {
					const margin = textSize * 0.4;
					renderer.rect(
						new Vec2(bbox.x - margin, bbox.y - margin), bbox.w + margin * 2, bbox.h + margin * 2,
						{ fillColor: color },
					);
					drawStrokeTextGeometry(renderer, geometry, boardBackgroundColor);
				}
				else {
					drawStrokeTextGeometry(renderer, geometry, color);
				}
			},
		};
	}

	protected buildFpLine(line: any, footprintMatrix: Matrix3, footprintId: string): PaintedItem {
		const { start, end } = line.getStartEnd();
		const layer = line.getLayer();
		const width = typeof line.getStroke === 'function' ? line.getStroke().width : 0.1;
		const worldStart = footprintMatrix.transform(new Vec2(start.x, start.y));
		const worldEnd = footprintMatrix.transform(new Vec2(end.x, end.y));
		// Namespaced under footprintId — see updateFootprintItems' doc comment:
		// a bare line.getUuid() (real boards assign one to almost every
		// graphic) doesn't match footprintId's own prefix, so the incremental
		// drag rebuild's cleanup pass never removes the old-position copy —
		// exactly what produced the "ghostly copies" left behind on every
		// dragged frame.
		const id = `${ footprintId }:${ line.getUuid() ?? `fp-line:${ layer }:${ start.x },${ start.y }-${ end.x },${ end.y }` }`;
		const shape: PaintedShape = { type: 'segment', x1: worldStart.x, y1: worldStart.y, x2: worldEnd.x, y2: worldEnd.y, width };

		return {
			// Not selectable outside the footprint editor, same as
			// buildFpRect/buildFpCircle/buildFpPoly below — real KiCad's
			// PCB_SELECTION_TOOL::Selectable() rejects every footprint-owned
			// PCB_SHAPE_T (line/rect/circle/arc/poly) when
			// !m_isFootprintEditor (pcb_selection_tool.cpp), only pads/fields/
			// text stay individually pickable. Clicking silkscreen/fab
			// graphics should resolve to the whole-footprint synthetic hit
			// item instead, matching real KiCad.
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: line,
			draw: (renderer, color) => {
				renderer.line([worldStart, worldEnd], { strokeColor: color, strokeWidth: width || 0.1 });
			},
		};
	}

	protected buildFpRect(rect: any, footprintMatrix: Matrix3, footprintId: string): PaintedItem {
		const { start, end } = rect.getStartEnd();
		const layer = rect.getLayer();
		const width = typeof rect.getStroke === 'function' ? rect.getStroke().width : 0.1;
		// A footprint rectangle rotates with the footprint, so it can't stay
		// an axis-aligned rect in world space once rotation is non-zero —
		// transform all four corners and draw/hit-test as a polygon, same
		// approach as rotated pads.
		const localCorners = [
			new Vec2(start.x, start.y), new Vec2(end.x, start.y),
			new Vec2(end.x, end.y), new Vec2(start.x, end.y),
		];
		const worldCorners = localCorners.map(p => footprintMatrix.transform(p));
		// Namespaced under footprintId — see buildFpLine's doc comment.
		const id = `${ footprintId }:${ rect.getUuid() ?? `fp-rect:${ layer }:${ start.x },${ start.y }` }`;
		const shape: PaintedShape = { type: 'polygon', points: worldCorners.map(p => ({ x: p.x, y: p.y })) };

		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: rect,
			draw: (renderer, color) => {
				renderer.polygon(worldCorners, { strokeColor: color, strokeWidth: width || 0.1 });
			},
		};
	}

	protected buildFpCircle(circle: any, footprintMatrix: Matrix3, footprintId: string): PaintedItem {
		const center = circle.getCenter();
		const end = circle.getEnd();
		const localRadius = Math.hypot(end.x - center.x, end.y - center.y);
		const layer = circle.getLayer();
		const width = typeof circle.getStroke === 'function' ? circle.getStroke().width : 0.1;
		const worldCenter = footprintMatrix.transform(new Vec2(center.x, center.y));
		// Footprint rotation doesn't distort a circle's radius (uniform
		// scale-free rotation), so the local radius carries over unchanged.
		// Namespaced under footprintId — see buildFpLine's doc comment.
		const id = `${ footprintId }:${ circle.getUuid() ?? `fp-circle:${ layer }:${ center.x },${ center.y }` }`;
		const shape: PaintedShape = { type: 'circle', cx: worldCenter.x, cy: worldCenter.y, r: localRadius };

		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: circle,
			draw: (renderer, color) => {
				renderer.circle(worldCenter, localRadius, { strokeColor: color, strokeWidth: width || 0.1 });
			},
		};
	}

	protected buildFpArc(arc: any, footprintMatrix: Matrix3, footprintRotationDeg: number, footprintId: string): PaintedItem | null {
		if (typeof arc.getArcCenterRadiusAngles !== 'function') {
			return null;
		}
		// centerX/Y/radius/startAngle/endAngle here are all computed purely
		// from the arc's own LOCAL (footprint-relative, unrotated) start/mid/
		// end points — the center needs the footprint transform applied like
		// any other point, and the two angles (in radians) need the
		// footprint's rotation added on top, since a matrix transforms points,
		// not free-floating angle values.
		let arcGeometry: { centerX: number; centerY: number; radius: number; startAngle: number; endAngle: number };
		try {
			arcGeometry = arc.getArcCenterRadiusAngles();
		}
		catch {
			// Degenerate (collinear start/mid/end) arc data — skip it rather
			// than aborting the whole footprint's render over one bad shape.
			return null;
		}
		const { centerX, centerY, radius, startAngle, endAngle } = arcGeometry;
		const layer = arc.getLayer();
		const width = typeof arc.getStroke === 'function' ? arc.getStroke().width : 0.1;
		const worldCenter = footprintMatrix.transform(new Vec2(centerX, centerY));
		const rotationRad = Angle.degToRad(footprintRotationDeg);
		// Namespaced under footprintId — see buildFpLine's doc comment.
		const id = `${ footprintId }:${ arc.getUuid() ?? `fp-arc:${ layer }:${ centerX },${ centerY }` }`;
		const shape: PaintedShape = { type: 'circle', cx: worldCenter.x, cy: worldCenter.y, r: radius };

		return {
			// Not selectable outside the footprint editor — see buildFpLine's
			// doc comment.
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: arc,
			draw: (renderer, color) => {
				renderer.arc(
					worldCenter, radius,
					startAngle + rotationRad, endAngle + rotationRad,
					{ strokeColor: color, strokeWidth: width || 0.1 },
				);
			},
		};
	}

	/** Footprint-local filled geometry used for logos, branding, and complex
	 * silkscreen/copper artwork. multiPolygon keeps concave outlines correct
	 * on both Canvas2D and WebGL rather than relying on fan triangulation. */
	protected buildFpPoly(poly: any, footprintMatrix: Matrix3, footprintId: string): PaintedItem | null {
		const points: Array<{ x: number; y: number }> = typeof poly.getPoints === 'function' ? poly.getPoints() : [];
		if (points.length < 3) {
			return null;
		}
		const layer = typeof poly.getLayer === 'function' ? poly.getLayer() : 'F.SilkS';
		const strokeWidth = typeof poly.getStroke === 'function' ? poly.getStroke().width : 0;
		const fill = typeof poly.getSimpleChildValue === 'function' ? poly.getSimpleChildValue('fill') : undefined;
		const filled = fill === true || fill === 'yes' || fill === 'solid';
		const worldPoints = points.map(point => footprintMatrix.transform(new Vec2(point.x, point.y)));
		const shape: PaintedShape = { type: 'polygon', points: worldPoints.map(point => ({ x: point.x, y: point.y })) };
		// Namespaced under footprintId — see buildFpLine's doc comment.
		const id = `${ footprintId }:${ poly.getUuid?.() ?? `fp-poly:${ layer }:${ points[0]!.x },${ points[0]!.y }` }`;
		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: poly,
			draw: (renderer, color) => renderer.multiPolygon([worldPoints], {
				fillColor: filled ? color : undefined,
				strokeColor: strokeWidth > 0 ? color : undefined,
				strokeWidth: strokeWidth || undefined,
			}),
		};
	}

	protected buildPad(
		pad: any, footprintMatrix: Matrix3, footprintRotationDeg: number,
		footprint: any, footprintId: string, globalLayers: string[], board: any
	): PaintedItem[] {
		const padOrigin = pad.getOrigin();
		const size = pad.getSize();
		const id = `${ footprintId }:pad:${ pad.padNumber }`;
		const padRotationDeg = padOrigin.rotation ?? 0;

		// Pad transform: translate to the pad's position (in the footprint's
		// already-rotated frame), then UN-rotate by the footprint's own
		// rotation before applying the pad's own rotation. KiCad stores each
		// pad's rotation as an absolute angle (not relative to the parent
		// footprint) in the file, so simply inheriting the footprint's
		// rotation for the pad's shape would double-apply it — this cancel-
		// then-reapply sequence is a direct port of kicanvas's PadPainter,
		// which gets this right. Getting this wrong is exactly what made
		// rotated pads (e.g. U5) render in the wrong orientation.
		const padMatrix = Matrix3.translation(padOrigin.x, padOrigin.y)
			.rotateSelf(Angle.fromDegrees(-footprintRotationDeg))
			.rotateSelf(Angle.fromDegrees(padRotationDeg));
		const fullMatrix = footprintMatrix.multiply(padMatrix);
		const worldCenter = fullMatrix.transform(new Vec2(0, 0));

		// Copper pad flashes share their copper-layer buckets.  The same pad
		// can additionally flash on solder mask, paste, and the other
		// technical layers; those are emitted separately below using their
		// own aperture margins, just as PAD::ViewGetLayers() does in Pcbnew.
		const padLayers: string[] = typeof pad.getLayers === 'function' ? pad.getLayers(globalLayers) : ['F.Cu'];
		const buckets: string[] = [];
		if (padLayers.includes('F.Cu')) {
			buckets.push('F.Cu');
		}
		if (padLayers.includes('B.Cu')) {
			buckets.push('B.Cu');
		}
		const items: PaintedItem[] = [];

		// NPTH pads have no copper at all — they're a bare mechanical hole,
		// not a plated connection, so coloring them like a normal copper pad
		// (which is what happened before) is actively misleading. Any pad
		// WITH a drill (NPTH or a plated thru_hole) also physically has a
		// hole through its middle that a solid-filled shape hides — punch it
		// the same way via holes already are.
		const isNpth = pad.padType === 'np_thru_hole';
		const drill = typeof pad.getDrill === 'function' ? pad.getDrill() : null;
		const npthOutlineColor = 'rgb(194, 194, 194)';
		// An oval drill (`(drill oval W H)`) is a slot, not a round hole, and
		// rotates WITH the pad — same fullMatrix as the pad shape itself.
		// getDrill() only distinguishes oval-vs-circle by whether `height`
		// was present in the file at all (a plain circular drill never has
		// one), which is what @kicad-io's own parser uses to tell them apart.
		const isOvalDrill = !!drill && drill.height !== undefined && drill.height !== drill.width;
		const ovalDrillWorldPoints = isOvalDrill
			? roundedRectLocalPoints(drill!.width, drill!.height!, Math.min(drill!.width, drill!.height!) / 2).map(p => fullMatrix.transform(p))
			: null;
		const drillRadius = !isOvalDrill && drill && drill.width > 0 ? drill.width / 2 : 0;
		const punchHole = (renderer: Renderer) => {
			if (ovalDrillWorldPoints) {
				renderer.polygon(ovalDrillWorldPoints, { fillColor: boardBackgroundColor });
			}
			else if (drillRadius > 0) {
				renderer.circle(worldCenter, drillRadius, { fillColor: boardBackgroundColor });
			}
		};

		if (pad.shape === 'circle') {
			const shape: PaintedShape = { type: 'circle', cx: worldCenter.x, cy: worldCenter.y, r: size.width / 2 };
			for (const layer of buckets) {
				items.push({
					id: `${ id }:${ layer }`, layer, kind: 'pad', shape, bbox: shapeToBBox(shape), hitTestable: true, element: pad,
					netId: typeof pad.getNetId === 'function' ? pad.getNetId() : null,
					netName: typeof pad.getNetName === 'function' ? pad.getNetName() : null,
					draw: (renderer, color, displayMode) => {
						if (displayMode === 'outline') {
							renderer.circle(worldCenter, size.width / 2, { strokeColor: isNpth ? npthOutlineColor : color, strokeWidth: SKETCH_STROKE_WIDTH });
							return;
						}
						if (isNpth) {
							renderer.circle(worldCenter, size.width / 2, { fillColor: boardBackgroundColor, strokeColor: npthOutlineColor, strokeWidth: 0.05 });
							punchHole(renderer);
						}
						else {
							renderer.circle(worldCenter, size.width / 2, { fillColor: color });
							punchHole(renderer);
						}
					},
				});
			}
		}
		else if (pad.shape === 'custom') {
			const ringsLocal = getCustomPadLocalRings(pad);
			if (ringsLocal.length === 0) {
				// No primitives — fall back to anchor rect so the pad is still visible.
				const localCorners = [
					new Vec2(-size.width / 2, -size.height / 2),
					new Vec2(size.width / 2, -size.height / 2),
					new Vec2(size.width / 2, size.height / 2),
					new Vec2(-size.width / 2, size.height / 2),
				];
				const worldCorners = localCorners.map(p => fullMatrix.transform(p));
				const shape: PaintedShape = { type: 'polygon', points: worldCorners.map(p => ({ x: p.x, y: p.y })) };
				for (const layer of buckets) {
					items.push({
						id: `${ id }:${ layer }`, layer, kind: 'pad', shape, bbox: shapeToBBox(shape), hitTestable: true, element: pad,
						netId: typeof pad.getNetId === 'function' ? pad.getNetId() : null,
						netName: typeof pad.getNetName === 'function' ? pad.getNetName() : null,
						draw: (renderer, color, displayMode) => {
							if (displayMode === 'outline') {
								renderer.polygon(worldCorners, { strokeColor: isNpth ? npthOutlineColor : color, strokeWidth: SKETCH_STROKE_WIDTH });
								return;
							}
							if (isNpth) {
								renderer.polygon(worldCorners, { fillColor: boardBackgroundColor, strokeColor: npthOutlineColor, strokeWidth: 0.05 });
								punchHole(renderer);
							}
							else {
								renderer.polygon(worldCorners, { fillColor: color });
								punchHole(renderer);
							}
						},
					});
				}
			}
			else {
				for (let ri = 0; ri < ringsLocal.length; ri++) {
					const worldCorners = ringsLocal[ri]!.map(p => fullMatrix.transform(p));
					const shape: PaintedShape = { type: 'polygon', points: worldCorners.map(p => ({ x: p.x, y: p.y })) };
					for (const layer of buckets) {
						items.push({
							id: `${ id }:poly${ ri }:${ layer }`, layer, kind: 'pad', shape, bbox: shapeToBBox(shape), hitTestable: true, element: pad,
							netId: typeof pad.getNetId === 'function' ? pad.getNetId() : null,
							netName: typeof pad.getNetName === 'function' ? pad.getNetName() : null,
							draw: (renderer, color, displayMode) => {
								if (displayMode === 'outline') {
									renderer.polygon(worldCorners, { strokeColor: isNpth ? npthOutlineColor : color, strokeWidth: SKETCH_STROKE_WIDTH });
									return;
								}
								if (isNpth) {
									renderer.polygon(worldCorners, { fillColor: boardBackgroundColor, strokeColor: npthOutlineColor, strokeWidth: 0.05 });
									punchHole(renderer);
								}
								else {
									renderer.polygon(worldCorners, { fillColor: color });
									punchHole(renderer);
								}
							},
						});
					}
				}
			}
		}
		else {
			// roundrect gets its actual rounded corners (KiCad's roundrect_rratio
			// is a fraction of the SHORTER side); oval is the same rounding
			// pushed to the max (radius = half the shorter side, i.e. a full
			// "stadium" shape — two semicircle ends). rect/trapezoid still fall
			// back to a sharp-cornered rectangle — real trapezoid geometry is a
			// further-out concern.
			let localCorners: Vec2[];
			if (pad.shape === 'roundrect' || pad.shape === 'oval') {
				const rratio = pad.shape === 'oval'
					? 0.5
					: (typeof pad.getSimpleChildValue === 'function'
						? (pad.getSimpleChildValue('roundrect_rratio') as number | undefined ?? 0)
						: 0);
				const radius = rratio * Math.min(size.width, size.height);
				localCorners = roundedRectLocalPoints(size.width, size.height, radius);
			}
			else {
				localCorners = [
					new Vec2(-size.width / 2, -size.height / 2),
					new Vec2(size.width / 2, -size.height / 2),
					new Vec2(size.width / 2, size.height / 2),
					new Vec2(-size.width / 2, size.height / 2),
				];
			}
			// Rotation is transformed through the full footprint+pad matrix
			// rather than drawn axis-aligned — what made every rotated pad
			// render in the wrong orientation before this was fixed.
			const worldCorners = localCorners.map(p => fullMatrix.transform(p));
			const shape: PaintedShape = { type: 'polygon', points: worldCorners.map(p => ({ x: p.x, y: p.y })) };

			for (const layer of buckets) {
				items.push({
					id: `${ id }:${ layer }`, layer, kind: 'pad', shape, bbox: shapeToBBox(shape), hitTestable: true, element: pad,
					netId: typeof pad.getNetId === 'function' ? pad.getNetId() : null,
					netName: typeof pad.getNetName === 'function' ? pad.getNetName() : null,
					draw: (renderer, color, displayMode) => {
						if (displayMode === 'outline') {
							renderer.polygon(worldCorners, { strokeColor: isNpth ? npthOutlineColor : color, strokeWidth: SKETCH_STROKE_WIDTH });
							return;
						}
						if (isNpth) {
							renderer.polygon(worldCorners, { fillColor: boardBackgroundColor, strokeColor: npthOutlineColor, strokeWidth: 0.05 });
							punchHole(renderer);
						}
						else {
							renderer.polygon(worldCorners, { fillColor: color });
							punchHole(renderer);
						}
					},
				});
			}
		}

		items.push(...this.buildPadTechnicalItems(
			pad, footprint, board, fullMatrix, id, size, padLayers,
		));

		if (this.options.showPadNumbers || this.options.showNetNames) {
			const labelItem = this.buildPadNumber(
				pad, worldCenter, size, footprintRotationDeg, padRotationDeg, id,
			);
			if (labelItem) {
				items.push(labelItem);
			}
		}

		return items;
	}

	/**
	 * Emits a pad's non-copper flashes.  Copper is represented by the normal
	 * pad items above; Pcbnew gives each of these technical layers its own
	 * aperture, including the mask/paste expansion selected by the board,
	 * footprint, or pad settings.
	 */
	protected buildPadTechnicalItems(
		pad: any, footprint: any, board: any, fullMatrix: Matrix3,
		padId: string, size: { width: number; height: number }, padLayers: string[],
	): PaintedItem[] {
		const items: PaintedItem[] = [];
		const technicalLayers = [...new Set(padLayers.filter(isPadTechnicalLayer))];
		for (const layer of technicalLayers) {
			const margin = getPadTechnicalMargin(pad, footprint, board, padLayers, size, layer);
			const apertureWidth = Math.max(0, size.width + margin.x * 2);
			const apertureHeight = Math.max(0, size.height + margin.y * 2);
			if (apertureWidth <= 0 || apertureHeight <= 0) {
				continue;
			}

			const id = `${ padId }:${ layer }`;
			const common = { id, layer, kind: 'graphic' as const, hitTestable: false, element: pad };
			if (pad.shape === 'custom') {
				const rings = offsetCustomPadLocalRings(getCustomPadLocalRings(pad), margin)
					.map(ring => ring.map(point => fullMatrix.transform(point)));
				if (rings.length === 0) {
					continue;
				}
				const shape: PaintedShape = { type: 'polygon', points: rings[0]!.map(point => ({ x: point.x, y: point.y })) };
				items.push({
					...common, shape, bbox: shapeToBBox(shape),
					draw: (renderer, color) => renderer.multiPolygon(rings, { fillColor: color }),
				});
				continue;
			}

			if (pad.shape === 'circle' && Math.abs(apertureWidth - apertureHeight) < 1e-9) {
				const center = fullMatrix.transform(new Vec2(0, 0));
				const shape: PaintedShape = { type: 'circle', cx: center.x, cy: center.y, r: apertureWidth / 2 };
				items.push({
					...common, shape, bbox: shapeToBBox(shape),
					draw: (renderer, color) => renderer.circle(center, apertureWidth / 2, { fillColor: color }),
				});
				continue;
			}

			let radius = 0;
			if (pad.shape === 'oval') {
				radius = Math.min(apertureWidth, apertureHeight) / 2;
			}
			else if (pad.shape === 'roundrect') {
				const ratio = Number(readChildValue(pad, 'roundrect_rratio') ?? 0);
				radius = Math.max(0, Math.min(apertureWidth, apertureHeight) * ratio);
			}
			const localPoints = radius > 0
				? roundedRectLocalPoints(apertureWidth, apertureHeight, radius)
				: [
					new Vec2(-apertureWidth / 2, -apertureHeight / 2),
					new Vec2(apertureWidth / 2, -apertureHeight / 2),
					new Vec2(apertureWidth / 2, apertureHeight / 2),
					new Vec2(-apertureWidth / 2, apertureHeight / 2),
				];
			const worldPoints = localPoints.map(point => fullMatrix.transform(point));
			const shape: PaintedShape = { type: 'polygon', points: worldPoints.map(point => ({ x: point.x, y: point.y })) };
			items.push({
				...common, shape, bbox: shapeToBBox(shape),
				draw: (renderer, color) => renderer.polygon(worldPoints, { fillColor: color }),
			});
		}
		return items;
	}

	/** PCB_RENDER_SETTINGS::MAX_FONT_SIZE (pcb_painter.cpp) — 10mm, a hard
	 *  cap regardless of how large the pad is. */
	protected static readonly MAX_PAD_LABEL_FONT_SIZE = 10;

	/**
	 * Pad number / net name overlay — a direct port of real KiCad's
	 * PCB_PAINTER::draw(const PAD*, int) netname-layer branch
	 * (pcbnew/pcb_painter.cpp), not an approximation, so sizing/fit matches
	 * KiCad exactly instead of drifting off on oddly-shaped or rotated
	 * pads. Skips the CUSTOM-shape "number box" and the 45°-rotation bloat
	 * clamp (both rare edge cases this app's pad model doesn't need) but
	 * otherwise follows the same math line-for-line. Drawn on the synthetic
	 * PadNumbers layer, which BoardPainter.paint() always renders at full
	 * opacity regardless of the active/high-contrast layer.
	 */
	protected buildPadNumber(
		pad: any,
		worldCenter: Vec2,
		size: { width: number; height: number },
		footprintRotationDeg: number,
		padRotationDeg: number,
		padId: string,
	): PaintedItem | null {
		const padNumber = this.options.showPadNumbers ? String(pad.padNumber ?? '') : '';
		const netName: string = this.options.showNetNames && typeof pad.getNetName === 'function'
			? (pad.getNetName() ?? '') : '';
		const showNumber = !!padNumber && padNumber !== '~';
		const showNet = !!netName;
		if (!showNumber && !showNet) {
			return null;
		}

		// padsize.x/y below is pcb_painter.cpp's `padsize` (the pad's own
		// bounding box) — real KiCad also swaps to the local X axis and
		// rotates -90° when the pad is taller than wide ("Keep the size
		// ratio for the font, but make it smaller"); textRotated captures
		// that plus undoing the footprint's own rotation so the label stays
		// upright in world space, same as this function did before.
		let padsizeX = size.width;
		let padsizeY = size.height;
		let textRotated = -footprintRotationDeg;
		if (padsizeX < padsizeY * 0.95) {
			textRotated += 90;
			[padsizeX, padsizeY] = [padsizeY, padsizeX];
		}
		while (padRotationDeg + textRotated > 90) {
			textRotated -= 180;
		}
		while (padRotationDeg + textRotated <= -90) {
			textRotated += 180;
		}

		// double maxSize = PCB_RENDER_SETTINGS::MAX_FONT_SIZE; double size = padsize.y; if (size > maxSize) size = maxSize;
		let boxSize = Math.min(padsizeY, BoardPainter.MAX_PAD_LABEL_FONT_SIZE);

		// "Divide the space... The magic numbers are defined experimentally
		// for a better look." (both number AND net name shown at once).
		let numberY = 0, netY = 0;
		if (showNumber && showNet) {
			boxSize = boxSize / 2.5;
			netY = boxSize / 1.4;
			numberY = boxSize / 1.7;
		}

		// Xscale_for_stroked_font — this renderer's stroke text has no
		// separate x/y glyph scale (unlike KiCad's GAL SetGlyphSize), so
		// applied uniformly here as the closest equivalent: KiCad's own
		// comment already calls this "a smaller text size to handle
		// interline, pen size" as much as the per-engine font metric.
		const STROKE_XSCALE = 0.9;

		let netFontSize = 0;
		if (showNet) {
			// double tsize = 1.5 * padsize.x / max(PrintableCharCount(netname)+1, 5);
			let tsize = 1.5 * padsizeX / Math.max(netName.length + 1, 5);
			tsize = Math.min(tsize, boxSize);
			tsize *= 0.85;
			if (pad.shape === 'circle' || pad.shape === 'oval') {
				tsize *= 0.9;
			}
			netFontSize = tsize * STROKE_XSCALE;
			netY = showNumber ? Math.min(tsize * 1.4, netY) : 0;
		}

		let numberFontSize = 0;
		if (showNumber) {
			// double tsize = 1.5 * padsize.x / max(PrintableCharCount(padNumber), 3);
			let tsize = 1.5 * padsizeX / Math.max(padNumber.length, 3);
			tsize = Math.min(tsize, boxSize);
			tsize *= 0.85;
			tsize = Math.min(tsize, boxSize);
			numberFontSize = tsize * STROKE_XSCALE;
			numberY = showNet ? -numberY : 0;
		}

		if (numberFontSize <= 0 && netFontSize <= 0) {
			return null;
		}

		// KiCad draws each line via GAL Translate(position)+Rotate(worldAngle)
		// then a local (0, Y) text offset — StrokeGlyph.transform()'s own
		// rotation (x=y0*sin+x0*cos, y=y0*cos-x0*sin, see TextPaint.ts) is
		// the same convention, so replicate it here to place each line's
		// world-space anchor before handing off to computeStrokeTextGeometry.
		const worldAngle = padRotationDeg + textRotated;
		const angleRad = worldAngle * Math.PI / 180;
		const sin = Math.sin(angleRad), cos = Math.cos(angleRad);
		const offsetPoint = (localY: number): Vec2 =>
			new Vec2(worldCenter.x + localY * sin, worldCenter.y + localY * cos);

		const parts: { geometry: StrokeTextGeometry }[] = [];
		let half = 0;
		if (showNumber && numberFontSize > 0) {
			const strokeWidth = numberFontSize / 6;
			const geometry = computeStrokeTextGeometry(
				padNumber, offsetPoint(numberY), numberFontSize, worldAngle, false, strokeWidth, { x: 0.5, y: 0.5 },
			);
			parts.push({ geometry });
			half = Math.max(half, numberFontSize);
		}
		if (showNet && netFontSize > 0) {
			const strokeWidth = netFontSize / 6;
			const geometry = computeStrokeTextGeometry(
				netName, offsetPoint(netY), netFontSize, worldAngle, false, strokeWidth, { x: 0.5, y: 0.5 },
			);
			parts.push({ geometry });
			half = Math.max(half, netFontSize);
		}
		if (parts.length === 0) {
			return null;
		}
		half += Math.max(Math.abs(numberY), Math.abs(netY));
		const bbox = { x: worldCenter.x - half, y: worldCenter.y - half, w: half * 2, h: half * 2 };

		return {
			id: `${ padId }:number`,
			layer: 'PadNumbers',
			kind: 'graphic',
			shape: { type: 'rect', ...bbox },
			bbox,
			hitTestable: false,
			element: pad,
			draw: (renderer, color) => {
				for (const part of parts) {
					drawStrokeTextGeometry(renderer, part.geometry, color);
				}
			},
		};
	}

	protected buildVia(via: any, board: any): PaintedItem[] {
		const origin = via.getOrigin();
		const size = via.getSize();
		const drill = typeof via.getDrill === 'function' ? via.getDrill() : { width: 0 };
		const outerRadius = size.width / 2;
		// A hole radius >= the pad radius would be nonsensical (parser gap
		// or zero-size drill) — fall back to a visually reasonable ring.
		const holeRadius = drill.width > 0 && drill.width < size.width
			? drill.width / 2
			: outerRadius * 0.5;
		const id = via.getUuid() ?? `via:${ origin.x },${ origin.y }`;
		const shape: PaintedShape = { type: 'circle', cx: origin.x, cy: origin.y, r: outerRadius };

		const items: PaintedItem[] = [{
			id, layer: 'Vias', kind: 'via', shape, bbox: shapeToBBox(shape), hitTestable: true, element: via,
			netId: typeof via.getNetId === 'function' ? via.getNetId() : null,
			netName: typeof via.getNetName === 'function' ? via.getNetName() : null,
			draw: (renderer, color, displayMode) => {
				// The outer ring is normally colored by the via's own (front)
				// copper layer, matching real KiCad's PCB_RENDER_SETTINGS::
				// GetColor — IsViaCopperLayer resolves straight to the
				// underlying copper layer's own color, same as a track or pad
				// on that layer, NOT a flat "via" swatch. But when the
				// per-item pass in paint() above has already overridden
				// `color` for a selection/net highlight (the
				// `highlighted || netHighlighted` branch), that override has
				// to win instead, exactly like every other item kind — this
				// is that case, detected by comparing against the plain
				// 'Vias' bucket color nothing else ever produces.
				const viaLayers = typeof via.getLayers === 'function' ? via.getLayers() : [];
				const isOverridden = color !== styleForLayer('Vias').color;
				const normalLayer = this.activePaintLayer && viaLayers.includes(this.activePaintLayer)
					? this.activePaintLayer
					: (viaLayers[0] ?? 'F.Cu');
				const ringColor = isOverridden ? color : colorForLayer(normalLayer);
				if (displayMode === 'outline') {
					renderer.circle(new Vec2(origin.x, origin.y), outerRadius, { strokeColor: ringColor, strokeWidth: SKETCH_STROKE_WIDTH });
					renderer.circle(new Vec2(origin.x, origin.y), holeRadius, { strokeColor: ringColor, strokeWidth: SKETCH_STROKE_WIDTH });
					return;
				}
				// A real via is 3 concentric layers, not a plain punched disc:
				// the copper annular ring (colored per copper layer, above), a
				// thin plated barrel wall, then the drilled bore itself — see
				// LayerColors' viaHoleWallColor/viaHoleColor doc comment for
				// where these fixed (never net-colored) values come from. The
				// wall ring's thickness is a cosmetic fraction of the annular
				// ring's own width (real KiCad scales its actual copper-
				// plating thickness by an internal visibility multiplier this
				// app has no equivalent board-stackup value for).
				const wallRadius = holeRadius + (outerRadius - holeRadius) * 0.25;
				renderer.circle(new Vec2(origin.x, origin.y), outerRadius, { fillColor: ringColor });
				renderer.circle(new Vec2(origin.x, origin.y), wallRadius, { fillColor: viaHoleWallColor });
				renderer.circle(new Vec2(origin.x, origin.y), holeRadius, { fillColor: viaHoleColor });
			},
		}];
		const label = this.buildViaLabel(via, new Vec2(origin.x, origin.y), size.width, id);
		if (label) {
			items.push(label);
		}
		const viaLayers = getElementLayers(via);
		const maskMargin = getBoardMaskExpansion(board);
		for (const layer of getViaMaskLayers(via, board, viaLayers)) {
			const radius = Math.max(0, outerRadius + maskMargin);
			if (radius <= 0) {
				continue;
			}
			const maskShape: PaintedShape = { type: 'circle', cx: origin.x, cy: origin.y, r: radius };
			items.push({
				id: `${ id }:${ layer }`, layer, kind: 'graphic', shape: maskShape, bbox: shapeToBBox(maskShape),
				hitTestable: false, element: via,
				draw: (renderer, color) => renderer.circle(new Vec2(origin.x, origin.y), radius, { fillColor: color }),
			});
		}
		return items;
	}

	/** Via net-name overlay — real KiCad's PCB_PAINTER::draw(const PCB_VIA*,
	 *  int) IsNetnameLayer branch, simplified to the THROUGH-via case only
	 *  (this app's board model has no blind/buried/microvia support, so the
	 *  showLayers/topLayer-bottomLayer half of that branch — which would
	 *  print a "3-6" style layer-span number below the net name — never
	 *  applies here: a via only ever shows its net name). Every other item
	 *  kind that carries a net (pads, tracks) already surfaces it as an
	 *  overlay; a via silently not doing the same was the one glaring
	 *  inconsistency in an otherwise KiCad-faithful render — reported as
	 *  "for the longest time we had simplified circle[s]". Rides the same
	 *  always-on-top PadNumbers synthetic layer pad numbers use (see
	 *  buildPadNumber's doc comment) — a via label is the same category of
	 *  overlay, gated by the same showNetNames toggle. */
	protected buildViaLabel(via: any, origin: Vec2, outerDiameter: number, viaId: string): PaintedItem | null {
		if (!this.options.showNetNames || typeof via.getNetName !== 'function') {
			return null;
		}
		const netName: string = via.getNetName() ?? '';
		if (!netName) {
			return null;
		}
		// double maxSize = PCB_RENDER_SETTINGS::MAX_FONT_SIZE; double size = aVia->GetWidth(currentLayer); if (size > maxSize) size = maxSize;
		const size = Math.min(outerDiameter, BoardPainter.MAX_PAD_LABEL_FONT_SIZE);
		// double tsize = 1.5 * size / std::max(PrintableCharCount(netname), minCharCnt); minCharCnt is 3 here (showLayers is always false).
		let tsize = 1.5 * size / Math.max(netName.length, 3);
		tsize = Math.min(tsize, size);
		tsize *= 0.75;
		// Same stroke-font X-scale correction buildPadNumber applies — see
		// its own doc comment for why (this renderer's stroke text has no
		// separate x/y glyph scale, unlike KiCad's GAL SetGlyphSize).
		const fontSize = tsize * 0.9;
		if (fontSize <= 0) {
			return null;
		}
		const strokeWidth = fontSize / 6;
		const geometry = computeStrokeTextGeometry(netName, origin, fontSize, 0, false, strokeWidth, { x: 0.5, y: 0.5 });
		const half = fontSize;
		const bbox = { x: origin.x - half, y: origin.y - half, w: half * 2, h: half * 2 };
		return {
			id: `${ viaId }:netname`,
			layer: 'PadNumbers',
			kind: 'graphic',
			shape: { type: 'rect', ...bbox },
			bbox,
			hitTestable: false,
			element: via,
			draw: (renderer, color) => {
				drawStrokeTextGeometry(renderer, geometry, color);
			},
		};
	}

	protected buildGrLine(line: any): PaintedItem {
		const { start, end } = line.getStartEnd();
		const layer = line.getLayer();
		const width = typeof line.getStroke === 'function' ? line.getStroke().width : 0.1;
		const id = line.getUuid() ?? `gr:${ layer }:${ start.x },${ start.y }-${ end.x },${ end.y }`;
		const shape: PaintedShape = { type: 'segment', x1: start.x, y1: start.y, x2: end.x, y2: end.y, width };

		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: line,
			draw: (renderer, color) => {
				renderer.line([new Vec2(start.x, start.y), new Vec2(end.x, end.y)], { strokeColor: color, strokeWidth: width || 0.1 });
			},
		};
	}

	protected buildGrArc(arc: any): PaintedItem | null {
		if (typeof arc.getArcCenterRadiusAngles !== 'function') {
			return null;
		}
		const { centerX, centerY, radius, startAngle, endAngle } = arc.getArcCenterRadiusAngles();
		const layer = arc.getLayer();
		const width = typeof arc.getStroke === 'function' ? arc.getStroke().width : 0.1;
		const id = arc.getUuid() ?? `gr-arc:${ layer }:${ centerX },${ centerY }`;
		// filled: false — same reasoning as buildTrackArc's own comment.
		const shape: PaintedShape = { type: 'circle', cx: centerX, cy: centerY, r: radius, filled: false, strokeWidth: width };

		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: arc,
			draw: (renderer, color) => {
				renderer.arc(new Vec2(centerX, centerY), radius, startAngle, endAngle, { strokeColor: color, strokeWidth: width || 0.1 });
			},
		};
	}

	protected buildGrRect(rect: any): PaintedItem {
		const { start, end } = rect.getStartEnd();
		const layer = rect.getLayer();
		const width = typeof rect.getStroke === 'function' ? rect.getStroke().width : 0.1;
		const id = rect.getUuid() ?? `gr-rect:${ layer }:${ start.x },${ start.y }`;
		const x = Math.min(start.x, end.x);
		const y = Math.min(start.y, end.y);
		const w = Math.abs(end.x - start.x);
		const h = Math.abs(end.y - start.y);
		// Board-side `(fill yes|no)` is a plain attribute (unlike schematic's
		// nested `(fill (type ...))`), so getSimpleChildValue reads it
		// directly — mirrors buildFpPoly's own fill check. Without `filled`
		// here PaintedShape's hit-test defaults an unfilled outline (e.g. a
		// board edge drawn on Edge.Cuts) to whole-area hit-testing, which
		// silently ate every click inside the outline instead of only near
		// its border, matching the same bug fixed on the schematic side
		// (see PaintedShape.ts's shapeContainsPoint doc comment).
		const fill = typeof rect.getSimpleChildValue === 'function' ? rect.getSimpleChildValue('fill') : undefined;
		const filled = fill === true || fill === 'yes' || fill === 'solid';
		const shape: PaintedShape = { type: 'rect', x, y, w, h, filled, strokeWidth: width };

		return {
			id, layer, kind: 'graphic', shape, bbox: shape, hitTestable: true, element: rect,
			draw: (renderer, color) => {
				// Edge cuts (and most gr_rect graphics) are an outline, not a
				// filled shape — a board outline being solid-filled would
				// paint over everything else on that layer.
				renderer.rect(new Vec2(x, y), w, h, {
					fillColor: filled ? color : undefined,
					strokeColor: color, strokeWidth: width || 0.1
				});
			},
		};
	}

/**
	 * Dimensions are NOT their own layer in KiCad — a dimension is tagged
	 * with a real layer (Dwgs.User/User.4/etc, same as any other graphic)
	 * and must render on it, sorted with everything else on that layer.
	 * Previously every dimension was dumped into a synthetic "Dimensions"
	 * bucket regardless of its actual `(layer ...)`, which silently
	 * discarded that field.
	 *
	 * Geometry: a dimension's two `pts` are the measured points, not the
	 * drawn dimension line — the actual line is offset from them by
	 * `height`, perpendicular to the measurement direction, connected to the
	 * measured points by extension lines, with arrowheads at both ends. The
	 * measurement direction itself depends on `type`:
	 *  - 'orthogonal': locked to an axis via `orientation` (0 = horizontal
	 *    measurement, offset applied in Y; 1 = vertical, offset in X).
	 *  - 'aligned' (and anything else): follows the actual p1→p2 direction,
	 *    offset along ITS perpendicular — these don't carry an `orientation`
	 *    at all. Treating every dimension as orthogonal (this module's
	 *    previous behavior) only coincidentally looked right for aligned
	 *    dimensions whose two points happened to share an X or Y coordinate,
	 *    and was wrong for any genuinely diagonal aligned dimension.
	 * The text keeps its own recorded position from the file's gr_text
	 * rather than being recomputed.
	 */
	protected buildDimension(dim: any): PaintedItem[] {
		const layer = typeof dim.getLayer === 'function' ? dim.getLayer() : 'Dwgs.User';
		const points: { x: number; y: number }[] = typeof dim.getPoints === 'function' ? dim.getPoints() : [];
		const height: number = typeof dim.getHeight === 'function' ? (dim.getHeight() ?? 0) : 0;
		const dimType: string = typeof dim.getDimensionType === 'function' ? dim.getDimensionType() : 'orthogonal';
		const orientation: number = typeof dim.getOrientation === 'function' ? (dim.getOrientation() ?? 0) : 0;
		const items: PaintedItem[] = [];
		const id = dim.getUuid() ?? `dim:${ points[0]?.x },${ points[0]?.y }`;
		const strokeWidth = typeof dim.getLineThickness === 'function' ? dim.getLineThickness() : 0.1;
		const arrowLength = typeof dim.getArrowLength === 'function' ? dim.getArrowLength() : 1.27;
		const arrowDirection = typeof dim.getArrowDirection === 'function' ? dim.getArrowDirection() : 'outward';
		// Gap between the measured point and where the extension line starts
		// drawing, and how far the extension line continues PAST the
		// crossbar — real KiCad's PCB_DIM_ALIGNED::updateGeometry /
		// PCB_DIM_ORTHOGONAL::updateGeometry (pcb_dimension.cpp), ported
		// here as "offset/overshoot along the same perpendicular direction
		// the crossbar itself is already offset along" rather than
		// replicating VECTOR2I::Resize's sign handling verbatim.
		const extensionOffset = typeof dim.getExtensionOffset === 'function' ? dim.getExtensionOffset() : 0.5;
		const extensionOvershoot = typeof dim.getExtensionHeight === 'function' ? dim.getExtensionHeight() : 0.5;

		if (points.length >= 2) {
			const [p1, p2] = points;
			// The dimension line's two endpoints, offset from the measured
			// points by `height` along the perpendicular direction.
			let lineStart: Vec2, lineEnd: Vec2;
			let extDirX: number, extDirY: number;
			const signHeight = height < 0 ? -1 : 1;
			if (dimType === 'orthogonal') {
				lineStart = orientation === 1 ? new Vec2(p1.x + height, p1.y) : new Vec2(p1.x, p1.y + height);
				lineEnd = orientation === 1 ? new Vec2(p2.x + height, p2.y) : new Vec2(p2.x, p2.y + height);
				extDirX = orientation === 1 ? signHeight : 0;
				extDirY = orientation === 1 ? 0 : signHeight;
			}
			else {
				const dx = p2.x - p1.x, dy = p2.y - p1.y;
				const dist = Math.hypot(dx, dy) || 1;
				// Perpendicular to the p1->p2 direction, matching the
				// orthogonal case's sign convention (positive height offsets
				// the same rotational sense as "offset in Y" for a purely
				// horizontal orthogonal dimension).
				const nx = -dy / dist, ny = dx / dist;
				lineStart = new Vec2(p1.x + nx * height, p1.y + ny * height);
				lineEnd = new Vec2(p2.x + nx * height, p2.y + ny * height);
				extDirX = nx * signHeight;
				extDirY = ny * signHeight;
			}

			const ext1Start = new Vec2(p1.x + extDirX * extensionOffset, p1.y + extDirY * extensionOffset);
			const ext1End = new Vec2(lineStart.x + extDirX * extensionOvershoot, lineStart.y + extDirY * extensionOvershoot);
			const ext2Start = new Vec2(p2.x + extDirX * extensionOffset, p2.y + extDirY * extensionOffset);
			const ext2End = new Vec2(lineEnd.x + extDirX * extensionOvershoot, lineEnd.y + extDirY * extensionOvershoot);

			// Outward (default): arrowhead tips sit AT the crossbar ends,
			// splayed away from the opposite end — real KiCad's default.
			// Inward: same tip position, legs splayed the other way (drawn
			// by reflecting the "away from" point through the tip — see
			// arrowheadSegments' own doc comment for why swapping tip/
			// awayFrom isn't equivalent to this).
			const arrows = arrowDirection === 'inward'
				? [
					...arrowheadSegments(lineStart, new Vec2(2 * lineStart.x - lineEnd.x, 2 * lineStart.y - lineEnd.y), arrowLength),
					...arrowheadSegments(lineEnd, new Vec2(2 * lineEnd.x - lineStart.x, 2 * lineEnd.y - lineStart.y), arrowLength),
				]
				: [
					...arrowheadSegments(lineStart, lineEnd, arrowLength),
					...arrowheadSegments(lineEnd, lineStart, arrowLength),
				];
			const segments: [Vec2, Vec2][] = [
				[ext1Start, ext1End],
				[ext2Start, ext2End],
				[lineStart, lineEnd],
				...arrows,
			];
			const bbox = boundsOfPoints([
				p1, p2, { x: lineStart.x, y: lineStart.y }, { x: lineEnd.x, y: lineEnd.y },
				{ x: ext1End.x, y: ext1End.y }, { x: ext2End.x, y: ext2End.y },
			]);
			// Hit-tests the actual drawn path (extension line 1 -> crossbar ->
			// extension line 2), not the loose bbox — an open (unfilled)
			// polyline so a click only registers near a real drawn segment,
			// matching how a bare gr_line/gr_rect already gets selected
			// (`shapeContainsPoint`'s edge-only branch for `filled: false`).
			// `element` stays the whole dimension (not just this one segment
			// chain) so a click anywhere on the line assembly selects/moves
			// the WHOLE dimension, text included — see translateElementGeometry's
			// KicadElementDimension branch, which is what keeps the text
			// riding along.
			items.push({
				id: `${ id }:line`, layer, kind: 'graphic',
				shape: {
					type: 'polygon',
					// Traces the actual drawn path: extension 1 (with its own
					// gap+overshoot) -> crossbar -> extension 2. `ext1End`/
					// `ext2End` sit just past `lineStart`/`lineEnd` (the
					// overshoot), so the short backtrack from there to the
					// crossbar's own start/end is a few tenths of a mm at
					// most — harmless for hit-testing, not a stray diagonal
					// through empty space.
					points: [
						{ x: ext1Start.x, y: ext1Start.y }, { x: ext1End.x, y: ext1End.y },
						{ x: lineStart.x, y: lineStart.y }, { x: lineEnd.x, y: lineEnd.y },
						{ x: ext2End.x, y: ext2End.y }, { x: ext2Start.x, y: ext2Start.y },
					],
					closed: false, filled: false, strokeWidth,
				},
				bbox, hitTestable: true, element: dim,
				draw: (renderer, color) => {
					for (const [a, b] of segments) {
						renderer.line([a, b], { strokeColor: color, strokeWidth });
					}
				},
			});
		}

		const textEl = (typeof dim.findFirstChildByClass === 'function' && getGrTextClass())
			? dim.findFirstChildByClass(getGrTextClass())
			: null;
		if (textEl?.value) {
			const textOrigin = typeof textEl.getOrigin === 'function' ? textEl.getOrigin() : { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0, rotation: 0 };
			const font = typeof textEl.getFont === 'function' ? textEl.getFont() : { height: 1 };
			const textSize = font.height || 1;
			const textWorld = new Vec2(textOrigin.x, textOrigin.y);
			// Dimension labels virtually never carry an explicit justify
			// element in the file — getAnchorPoint() correctly defaults that
			// to center/middle, which is what real KiCad does too. Without
			// this, every dimension's text renders anchored to its left
			// edge instead of centered on its recorded point.
			const anchor = typeof textEl.getAnchorPoint === 'function' ? textEl.getAnchorPoint() : { x: 0, y: 0 };
			const geometry = computeStrokeTextGeometry(textEl.value, textWorld, textSize, textOrigin.rotation ?? 0, false, undefined, anchor);
			items.push({
				id: `${ id }:text`, layer, kind: 'graphic',
				shape: { type: 'rect', x: textWorld.x - textSize, y: textWorld.y - textSize, w: textSize * 2, h: textSize * 2 },
				bbox: { x: textWorld.x - textSize, y: textWorld.y - textSize, w: textSize * 2, h: textSize * 2 },
				// `element` is the TEXT sub-node itself, not the whole
				// dimension — real KiCad lets you grab just the label and
				// drag it independently of the measured geometry (manual
				// text-position mode); pointing this at `textEl` means the
				// existing generic getOrigin/setOrigin drag path
				// (translateElementGeometry) already does exactly that with
				// no dimension-specific code, since it only touches this one
				// child's own origin.
				hitTestable: true, element: textEl,
				draw: (renderer, color) => {
					drawStrokeTextGeometry(renderer, geometry, color);
				},
			});
		}

		return items;
	}

	protected buildGrCircle(circle: any): PaintedItem {
		const center = circle.getCenter();
		const end = circle.getEnd();
		const radius = Math.hypot(end.x - center.x, end.y - center.y);
		const layer = circle.getLayer();
		const width = typeof circle.getStroke === 'function' ? circle.getStroke().width : 0.1;
		const id = circle.getUuid() ?? `gr-circle:${ layer }:${ center.x },${ center.y }`;
		// See buildGrRect's doc comment — same fill-detection/hit-test fix.
		const fill = typeof circle.getSimpleChildValue === 'function' ? circle.getSimpleChildValue('fill') : undefined;
		const filled = fill === true || fill === 'yes' || fill === 'solid';
		const shape: PaintedShape = { type: 'circle', cx: center.x, cy: center.y, r: radius, filled, strokeWidth: width };

		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: circle,
			draw: (renderer, color) => {
				renderer.circle(new Vec2(center.x, center.y), radius, {
					fillColor: filled ? color : undefined,
					strokeColor: color, strokeWidth: width || 0.1
				});
			},
		};
	}

	/** Pcbnew `gr_text_box`: a start/end rectangle with optional border and
	 * multiline text laid out inside its four margins. */
	protected buildGrTextBox(textBox: any): PaintedItem | null {
		return this.buildPcbTextBox(textBox, null);
	}

	/** Shared PCB_TEXTBOX renderer for gr_text_box, fp_text_box and the text
	 * part of a table cell.  Box coordinates are in the owning footprint's
	 * library frame when a matrix is provided. */
	protected buildPcbTextBox(
		textBox: any, footprintMatrix: Matrix3 | null, footprintId?: string,
		footprintRotation = 0, hitTestable = true, forceBorder?: boolean,
	): PaintedItem | null {
		if (typeof textBox.getStartEnd !== 'function') return null;
		const { start, end } = textBox.getStartEnd();
		const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
		const width = Math.abs(end.x - start.x), height = Math.abs(end.y - start.y);
		if (width <= 0 || height <= 0) return null;
		const layer = typeof textBox.getLayer === 'function' ? textBox.getLayer() : 'F.SilkS';
		const isBack = layer.startsWith('B.');
		const font = typeof textBox.getFont === 'function' ? textBox.getFont() : { height: 1, thickness: 0.15 };
		const textSize = font.height || 1;
		const margins = textBox.findFirstChildByName?.('margins')?.attributes ?? [];
		const marginLeft = Number(margins[0]?.value) || 0;
		const marginTop = Number(margins[1]?.value) || marginLeft;
		const marginRight = Number(margins[2]?.value) || marginLeft;
		const marginBottom = Number(margins[3]?.value) || marginTop;
		const contentWidth = Math.max(0, width - marginLeft - marginRight);
		const contentHeight = Math.max(0, height - marginTop - marginBottom);
		const justify = typeof textBox.getAnchorPoint === 'function' ? textBox.getAnchorPoint() : { x: 0, y: 0.5 };
		const localAngle = Number(readChildValue(textBox, 'angle') ?? 0);
		const angleRad = localAngle * Math.PI / 180;
		const center = new Vec2(x + width / 2, y + height / 2);
		const rotate = (point: Vec2) => rotateAround(point, center, angleRad);
		const toWorld = (point: Vec2) => footprintMatrix ? footprintMatrix.transform(point) : point;
		const worldCorners = [
			new Vec2(x, y), new Vec2(x + width, y), new Vec2(x + width, y + height), new Vec2(x, y + height),
		].map(rotate).map(toWorld);
		const localTextPosition = rotate(new Vec2(
			x + marginLeft + contentWidth * justify.x,
			y + marginTop + contentHeight * justify.y,
		));
		const textPosition = toWorld(localTextPosition);
		const textAngle = localAngle + footprintRotation;
		const geometry = textBox.value
			? computeStrokeTextGeometry(textBox.value, textPosition, textSize, textAngle, isBack, font.thickness || 0.15, justify)
			: null;
		const border = forceBorder ?? textBox.getSimpleChildValue?.('border') !== false;
		const strokeWidth = typeof textBox.getStroke === 'function' ? textBox.getStroke().width : 0.1;
		const rawId = textBox.getUuid?.() ?? `text-box:${ layer }:${ x },${ y }`;
		const id = footprintId ? `${ footprintId }:${ rawId }` : rawId;
		const bbox = boundsOfPoints(worldCorners.map(point => ({ x: point.x, y: point.y })));
		return {
			id, layer, kind: 'graphic', shape: { type: 'polygon', points: worldCorners.map(point => ({ x: point.x, y: point.y })) }, bbox, hitTestable, element: textBox,
			draw: (renderer, color) => {
				if (border) renderer.polygon(worldCorners, { strokeColor: color, strokeWidth: strokeWidth || 0.1 });
				if (geometry) drawStrokeTextGeometry(renderer, geometry, color);
			},
		};
	}

	/** PCB_TABLE is a container: cells provide the text boxes, while this
	 * method adds the table-owned outer border and internal separators. */
	protected buildTable(table: any, footprintMatrix: Matrix3 | null = null, footprintId?: string, footprintRotation = 0): PaintedItem[] {
		const cellsRoot = table.findFirstChildByName?.('cells');
		const cells = cellsRoot?.findChildrenByName?.('table_cell') ?? [];
		if (!cells.length) return [];
		const layer = typeof table.getLayer === 'function' ? table.getLayer() : 'F.SilkS';
		const tableId = table.getUuid?.() ?? `table:${ cells[0]?.getUuid?.() ?? 'anonymous' }`;
		const id = footprintId ? `${ footprintId }:${ tableId }` : tableId;
		const columnCount = Math.max(1, Math.round(Number(readChildValue(table, 'column_count') ?? 1)));
		const border = table.findFirstChildByName?.('border');
		const separators = table.findFirstChildByName?.('separators');
		const enabled = (owner: any, name: string) => readChildValue(owner, name) === true || readChildValue(owner, name) === 'yes';
		const strokeWidth = (owner: any) => Number(owner?.findFirstChildByName?.('stroke')?.getWidth?.() ?? 0.1) || 0.1;
		const borderWidth = strokeWidth(border);
		const separatorWidth = strokeWidth(separators);
		const toWorld = (point: Vec2) => footprintMatrix ? footprintMatrix.transform(point) : point;
		const items: PaintedItem[] = [];
		const cellData: Array<{ cell: any; start: Vec2; end: Vec2; row: number; col: number }> = [];
		for (let index = 0; index < cells.length; index++) {
			const cell = cells[index]!;
			if (typeof cell.getStartEnd !== 'function') continue;
			const { start, end } = cell.getStartEnd();
			cellData.push({ cell, start: new Vec2(start.x, start.y), end: new Vec2(end.x, end.y), row: Math.floor(index / columnCount), col: index % columnCount });
			const textItem = this.buildPcbTextBox(cell, footprintMatrix, footprintId, footprintRotation, false, false);
			if (textItem) items.push(textItem);
		}
		if (!cellData.length) return items;
		const lineSegments: Array<{ a: Vec2; b: Vec2; width: number }> = [];
		const addLine = (a: Vec2, b: Vec2, width: number) => lineSegments.push({ a: toWorld(a), b: toWorld(b), width });
		const minX = Math.min(...cellData.map(data => Math.min(data.start.x, data.end.x)));
		const minY = Math.min(...cellData.map(data => Math.min(data.start.y, data.end.y)));
		const maxX = Math.max(...cellData.map(data => Math.max(data.start.x, data.end.x)));
		const maxY = Math.max(...cellData.map(data => Math.max(data.start.y, data.end.y)));
		const rowCount = Math.ceil(cells.length / columnCount);
		for (const data of cellData) {
			const x1 = Math.min(data.start.x, data.end.x), y1 = Math.min(data.start.y, data.end.y);
			const x2 = Math.max(data.start.x, data.end.x), y2 = Math.max(data.start.y, data.end.y);
			const span = data.cell.findFirstChildByName?.('span')?.attributes ?? [];
			const colSpan = Math.max(1, Number(span[0]?.value) || 1);
			const rowSpan = Math.max(1, Number(span[1]?.value) || 1);
			if (data.col + colSpan < columnCount && (enabled(separators, 'cols') || (data.row === 0 && enabled(border, 'header')))) {
				addLine(new Vec2(x2, y1), new Vec2(x2, y2), data.row === 0 && enabled(border, 'header') ? borderWidth : separatorWidth);
			}
			if (data.row + rowSpan < rowCount && (enabled(separators, 'rows') || (data.row === 0 && enabled(border, 'header')))) {
				addLine(new Vec2(x1, y2), new Vec2(x2, y2), data.row === 0 && enabled(border, 'header') ? borderWidth : separatorWidth);
			}
		}
		if (enabled(border, 'external')) {
			addLine(new Vec2(minX, minY), new Vec2(maxX, minY), borderWidth);
			addLine(new Vec2(maxX, minY), new Vec2(maxX, maxY), borderWidth);
			addLine(new Vec2(maxX, maxY), new Vec2(minX, maxY), borderWidth);
			addLine(new Vec2(minX, maxY), new Vec2(minX, minY), borderWidth);
		}
		const corners = [new Vec2(minX, minY), new Vec2(maxX, minY), new Vec2(maxX, maxY), new Vec2(minX, maxY)].map(toWorld);
		const bbox = boundsOfPoints(corners.map(point => ({ x: point.x, y: point.y })));
		items.push({
			id: `${ id }:borders`, layer, kind: 'graphic', shape: { type: 'polygon', points: corners.map(point => ({ x: point.x, y: point.y })) }, bbox,
			hitTestable: !footprintId, element: table,
			draw: (renderer, color) => {
				for (const line of lineSegments) renderer.line([line.a, line.b], { strokeColor: color, strokeWidth: line.width });
			},
		});
		return items;
	}

	/** Pcbnew reference images are centered on `(at ...)`, kept on their
	 * associated board layer, and sized from encoded pixels at image PPI. */
	protected buildBoardImage(image: any, boardVersion: number, footprintMatrix: Matrix3 | null = null, footprintId?: string): PaintedItem | null {
		const data: string | undefined = typeof image.getData === 'function' ? image.getData() : undefined;
		if (!data) return null;
		const info = embeddedImageInfo(data);
		if (!info) return null;
		const origin = typeof image.getOrigin === 'function' ? image.getOrigin() : { x: 0, y: 0 };
		const scale = typeof image.getScale === 'function' ? image.getScale() : 1;
		const effectivePpi = boardVersion > 0 && boardVersion < 20260623 ? info.legacyPpi : info.ppi;
		const pixelSizeMm = 25.4 / effectivePpi;
		const imageScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
		const width = info.width * pixelSizeMm * imageScale;
		const height = info.height * pixelSizeMm * imageScale;
		if (!(width > 0) || !(height > 0)) return null;
		const x = origin.x - width / 2;
		const y = origin.y - height / 2;
		const localCorners: [Vec2, Vec2, Vec2, Vec2] = [
			new Vec2(x, y), new Vec2(x + width, y), new Vec2(x + width, y + height), new Vec2(x, y + height),
		];
		const corners = (footprintMatrix ? localCorners.map(point => footprintMatrix.transform(point)) : localCorners) as [Vec2, Vec2, Vec2, Vec2];
		const layer = typeof image.getLayer === 'function' ? image.getLayer() || 'F.Cu' : 'F.Cu';
		const rawId = image.getUuid?.() ?? `image:${ layer }:${ origin.x },${ origin.y }`;
		const id = footprintId ? `${ footprintId }:${ rawId }` : rawId;
		const shape: PaintedShape = footprintMatrix
			? { type: 'polygon', points: corners.map(point => ({ x: point.x, y: point.y })), filled: true }
			: { type: 'rect', x, y, w: width, h: height, filled: true };
		const embedded: EmbeddedImage = { data, mimeType: info.mimeType };
		return {
			id, layer, kind: 'image', shape, bbox: shapeToBBox(shape), hitTestable: !footprintId, element: image,
			draw: renderer => renderer.image(embedded, new Vec2(x, y), width, height, footprintMatrix ? corners : undefined),
		};
	}

	/** Mirrors PCB_BARCODE::ComputeBarcode/rescaleSymbolPoly: Zint supplies a
	 * local rectangle list, which Pcbnew independently scales on each axis to
	 * the saved `(size ...)` and centers at `(at ...)`. */
	protected buildBarcode(barcode: any): PaintedItem | null {
		const type = String(barcode.getBarcodeType?.() ?? barcode.getSimpleChildValue?.('type') ?? 'qr').toLowerCase();
		if (type !== 'code39' && type !== 'code128' && type !== 'datamatrix' && type !== 'qr' && type !== 'microqr') {
			return null;
		}
		const text = String(barcode.getBarcodeText?.() ?? barcode.findFirstChildByName?.('text')?.value ?? '');
		if (!text) return null;
		const errorCorrection = String(barcode.getErrorCorrection?.() ?? barcode.getSimpleChildValue?.('ecc_level') ?? 'L').toUpperCase();
		const encoding = getBoardBarcodeEncoding({
			type, text, errorCorrection: errorCorrection === 'M' || errorCorrection === 'Q' || errorCorrection === 'H' ? errorCorrection : 'L',
		});
		if (!encoding || encoding.width <= 0 || encoding.height <= 0) return null;
		const origin = barcode.getOrigin?.() ?? { x: 0, y: 0, rotation: 0 };
		const size = barcode.getSize?.() ?? { width: 40, height: 40 };
		const width = Math.max(0.01, Number(size.width) || 40);
		const height = Math.max(0.01, Number(size.height) || 40);
		const scaleX = width / encoding.width;
		const scaleY = height / encoding.height;
		const angle = (Number(origin.rotation) || 0) * Math.PI / 180;
		const sin = Math.sin(angle), cos = Math.cos(angle);
		const transform = (x: number, y: number) => new Vec2(
			origin.x + x * cos + y * sin,
			origin.y - x * sin + y * cos,
		);
		const rectangles = encoding.rectangles.map(rect => {
			const x = (rect.x + rect.width / 2 - encoding.width / 2) * scaleX;
			const y = (rect.y + rect.height / 2 - encoding.height / 2) * scaleY;
			const halfWidth = rect.width * scaleX / 2;
			const halfHeight = rect.height * scaleY / 2;
			return [transform(x - halfWidth, y - halfHeight), transform(x + halfWidth, y - halfHeight), transform(x + halfWidth, y + halfHeight), transform(x - halfWidth, y + halfHeight)] as [Vec2, Vec2, Vec2, Vec2];
		});
		const layer = barcode.getLayer?.() || 'F.SilkS';
		const rawId = barcode.getUuid?.() ?? `barcode:${ layer }:${ origin.x },${ origin.y }`;
		const symbolCorners = rectangles.flat();
		if (!symbolCorners.length) return null;
		const symbolBBox = boundsOfPoints(symbolCorners.map(point => ({ x: point.x, y: point.y })));
		const textHeight = Math.max(0.01, Number(barcode.getTextHeight?.() ?? barcode.getSimpleChildValue?.('text_height') ?? 1));
		const textVisible = !(barcode.isTextHidden?.() ?? barcode.getSimpleChildValue?.('hide') === true);
		const textAnchor = transform(0, height / 2 + 1 + textHeight / 2);
		const textGeometry = textVisible
			? computeStrokeTextGeometry(text, textAnchor, textHeight, Number(origin.rotation) || 0, layer.startsWith('B.'), textHeight / 6, { x: 0.5, y: 0.5 })
			: null;
		const textBBox = textGeometry ? getStrokeTextBounds(textGeometry) : null;
		const fullBBox = textBBox ? boundsOfPoints([
			{ x: symbolBBox.x, y: symbolBBox.y }, { x: symbolBBox.x + symbolBBox.w, y: symbolBBox.y + symbolBBox.h },
			{ x: textBBox.x, y: textBBox.y }, { x: textBBox.x + textBBox.w, y: textBBox.y + textBBox.h },
		]) : symbolBBox;
		const knockout = barcode.isKnockout?.() ?? barcode.getSimpleChildValue?.('knockout') === true;
		const margins = barcode.getMargins?.() ?? { x: 0, y: 0 };
		const minMargin = Math.ceil(Math.min(width, height)) / 10;
		const marginX = Math.max(Number(margins.x) || 0, minMargin);
		const marginY = Math.max(Number(margins.y) || 0, minMargin);
		const bbox = knockout
			? { x: fullBBox.x - marginX, y: fullBBox.y - marginY, w: fullBBox.w + marginX * 2, h: fullBBox.h + marginY * 2 }
			: fullBBox;
		return {
			id: rawId, layer, kind: 'graphic', shape: { type: 'rect', ...bbox }, bbox, hitTestable: true, element: barcode,
			draw: (renderer, color) => {
				if (knockout) renderer.rect(new Vec2(bbox.x, bbox.y), bbox.w, bbox.h, { fillColor: color });
				for (const rectangle of rectangles) renderer.polygon(rectangle, { fillColor: knockout ? boardBackgroundColor : color });
				if (textGeometry) drawStrokeTextGeometry(renderer, textGeometry, knockout ? boardBackgroundColor : color);
			},
		};
	}

	/** Direct port of PCB_PAINTER::draw(const PCB_TARGET*): its two cross
	 * strokes and center ring share one selectable target bounding box. */
	protected buildTarget(target: any): PaintedItem | null {
		const origin = typeof target.getOrigin === 'function' ? target.getOrigin() : { x: 0, y: 0 };
		const size = Number(typeof target.getSize === 'function' ? target.getSize() : readChildValue(target, 'size') ?? 5);
		const width = Number(typeof target.getWidth === 'function' ? target.getWidth() : readChildValue(target, 'width') ?? 0.2);
		if (!(size > 0) || !(width >= 0)) return null;
		const isX = typeof target.getShape === 'function' ? target.getShape() === 'x' : target.attributes?.[0]?.value === 'x';
		const arm = isX ? (2 * size) / 3 : size / 2;
		const radius = isX ? size / 2 : size / 3;
		const rotate = isX ? Math.PI / 4 : 0;
		const endpoint = (sign: number) => new Vec2(
			origin.x + sign * arm * Math.cos(rotate),
			origin.y + sign * arm * Math.sin(rotate),
		);
		const perpendicular = (sign: number) => new Vec2(
			origin.x - sign * arm * Math.sin(rotate),
			origin.y + sign * arm * Math.cos(rotate),
		);
		const center = new Vec2(origin.x, origin.y);
		const layer = typeof target.getLayer === 'function' ? target.getLayer() || 'Edge.Cuts' : 'Edge.Cuts';
		const id = target.getUuid?.() ?? `target:${ layer }:${ origin.x },${ origin.y }`;
		const shape: PaintedShape = { type: 'rect', x: origin.x - size / 2, y: origin.y - size / 2, w: size, h: size };
		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: target,
			draw: (renderer, color) => {
				renderer.line([endpoint(-1), endpoint(1)], { strokeColor: color, strokeWidth: width });
				renderer.line([perpendicular(-1), perpendicular(1)], { strokeColor: color, strokeWidth: width });
				renderer.circle(center, radius, { strokeColor: color, strokeWidth: width });
			},
		};
	}

	/** PCB_PAINTER::draw(const PCB_POINT*): a magenta X on the synthetic
	 * points overlay, plus a ring taking the point's own board-layer color. */
	protected buildPoint(point: any, footprintMatrix?: Matrix3, footprintId?: string): PaintedItem | null {
		const local = typeof point.getOrigin === 'function' ? point.getOrigin() : { x: 0, y: 0 };
		const size = Number(typeof point.getSize === 'function' ? point.getSize() : readChildValue(point, 'size') ?? 1);
		if (!(size > 0)) return null;
		const half = size / 2;
		const center = footprintMatrix
			? footprintMatrix.transform(new Vec2(local.x, local.y))
			: new Vec2(local.x, local.y);
		// PCB_PAINTER translates to a point's board position before drawing its
		// X, so a footprint rotation moves the point but does not rotate marker.
		const a = new Vec2(center.x - half, center.y - half);
		const b = new Vec2(center.x + half, center.y + half);
		const c = new Vec2(center.x + half, center.y - half);
		const d = new Vec2(center.x - half, center.y + half);
		const layer = typeof point.getLayer === 'function' ? point.getLayer() || 'F.Fab' : 'F.Fab';
		const rawId = point.getUuid?.() ?? `point:${ layer }:${ local.x },${ local.y }`;
		const id = footprintId ? `${ footprintId }:${ rawId }` : rawId;
		const shape: PaintedShape = { type: 'rect', x: center.x - half, y: center.y - half, w: size, h: size };
		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: point,
			draw: (renderer, color) => {
				const crossColor = color === '#ffcc00' ? color : pointCrossColor;
				renderer.line([a, b], { strokeColor: crossColor, strokeWidth: 0.05 });
				renderer.line([c, d], { strokeColor: crossColor, strokeWidth: 0.05 });
				renderer.circle(center, size / 4, { strokeColor: color, strokeWidth: 0.05 });
			},
		};
	}

	protected buildGrPoly(polygon: any): PaintedItem | null {
		const points: Array<{ x: number; y: number }> = typeof polygon.getPoints === 'function' ? polygon.getPoints() : [];
		if (points.length < 3) return null;
		const layer = polygon.getLayer();
		const width = typeof polygon.getStroke === 'function' ? polygon.getStroke().width : 0.1;
		const id = polygon.getUuid() ?? `gr-poly:${ layer }:${ points[0]!.x },${ points[0]!.y }`;
		// See buildGrRect's doc comment — same fill-detection/hit-test fix.
		const fill = typeof polygon.getSimpleChildValue === 'function' ? polygon.getSimpleChildValue('fill') : undefined;
		const filled = fill === true || fill === 'yes' || fill === 'solid';
		const shape: PaintedShape = {
			type: 'polygon', points: points.map(point => ({ x: point.x, y: point.y })),
			filled, closed: true, strokeWidth: width
		};
		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: polygon,
			draw: (renderer, color) => filled
				? renderer.multiPolygon([points.map(point => new Vec2(point.x, point.y))], { fillColor: color, strokeColor: color, strokeWidth: width || 0.1 })
				: renderer.line(
					[...points.map(point => new Vec2(point.x, point.y)), new Vec2(points[0]!.x, points[0]!.y)],
					{ strokeColor: color, strokeWidth: width || 0.1 }),
		};
	}

	protected buildGrCurve(curve: any): PaintedItem | null {
		return this.buildCurve(curve, null);
	}

	protected buildCurve(curve: any, footprintMatrix: Matrix3 | null, footprintId?: string): PaintedItem | null {
		const points: Array<{ x: number; y: number }> = typeof curve.getPoints === 'function' ? curve.getPoints() : [];
		if (points.length !== 4) return null;
		const layer = curve.getLayer();
		const width = typeof curve.getStroke === 'function' ? curve.getStroke().width : 0.1;
		const rawId = curve.getUuid() ?? `curve:${ layer }:${ points[0]!.x },${ points[0]!.y }`;
		const id = footprintId ? `${ footprintId }:${ rawId }` : rawId;
		const shapePoints = cubicBezierToPolyline(points.map(point => new Vec2(point.x, point.y)) as [Vec2, Vec2, Vec2, Vec2]);
		const worldPoints = footprintMatrix ? shapePoints.map(point => footprintMatrix.transform(point)) : shapePoints;
		// A gr_curve is an open bezier stroke, never a closed fillable area
		// (matches buildSchBezier's identical always-unfilled treatment) —
		// still needs `filled: false` explicit so hit-testing stays edge-only
		// instead of PaintedShape's filled-by-default fallback.
		const shape: PaintedShape = { type: 'polygon', points: worldPoints.map(point => ({ x: point.x, y: point.y })), filled: false, closed: false, strokeWidth: width };
		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: !footprintId, element: curve,
			draw: (renderer, color) => renderer.line(worldPoints, { strokeColor: color, strokeWidth: width || 0.1 }),
		};
	}

	protected buildEllipse(ellipse: any, isArc: boolean, footprintMatrix: Matrix3 | null = null, footprintId?: string): PaintedItem | null {
		const centerEl = ellipse.findFirstChildByName?.('center');
		const center = new Vec2(Number(centerEl?.x ?? centerEl?.attributes?.[0]?.value), Number(centerEl?.y ?? centerEl?.attributes?.[1]?.value));
		const major = readChildNumber(ellipse, 'major_radius') ?? 0;
		const minor = readChildNumber(ellipse, 'minor_radius') ?? 0;
		if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !(major > 0) || !(minor > 0)) return null;
		const rotation = (readChildNumber(ellipse, 'rotation_angle') ?? 0) * Math.PI / 180;
		const start = isArc ? (readChildNumber(ellipse, 'start_angle') ?? 0) * Math.PI / 180 : 0;
		let end = isArc ? (readChildNumber(ellipse, 'end_angle') ?? 360) * Math.PI / 180 : Math.PI * 2;
		if (isArc && end <= start) end += Math.PI * 2;
		const localPoints = ellipsePolyline(center, major, minor, rotation, start, end, isArc ? 48 : 64);
		const points = footprintMatrix ? localPoints.map(point => footprintMatrix.transform(point)) : localPoints;
		const layer = ellipse.getLayer?.() || 'F.SilkS';
		const width = ellipse.getStroke?.().width || 0.1;
		const rawId = ellipse.getUuid?.() ?? `ellipse:${ layer }:${ center.x },${ center.y }`;
		const id = footprintId ? `${ footprintId }:${ rawId }` : rawId;
		const fill = ellipse.getSimpleChildValue?.('fill');
		const filled = !isArc && (fill === true || fill === 'yes' || fill === 'solid');
		const shape: PaintedShape = { type: 'polygon', points: points.map(point => ({ x: point.x, y: point.y })), filled, closed: !isArc, strokeWidth: width };
		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: !footprintId, element: ellipse,
			draw: (renderer, color) => filled
				? renderer.polygon(points, { fillColor: color, strokeColor: color, strokeWidth: width })
				: renderer.line(isArc ? points : [...points, points[0]!], { strokeColor: color, strokeWidth: width }),
		};
	}
}

/** Approximate a KiCad cubic graphic (`gr_curve`) using the same control
 * points stored in its native S-expression.  Renderer has no cubic primitive,
 * so a short fixed tessellation keeps Canvas2D/WebGL output consistent. */
function cubicBezierToPolyline(points: [Vec2, Vec2, Vec2, Vec2], steps = 32): Vec2[] {
	const [p0, p1, p2, p3] = points;
	const result: Vec2[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		result.push(new Vec2(
			u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
			u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
		));
	}
	return result;
}

/**
 * Two short line segments forming a narrow "V" arrowhead at `tip`, opening
 * back towards `awayFrom` — used for dimension-line arrowheads (KiCad's
 * "outward"-pointing style: the point sits at the dimension line's end).
 */
function arrowheadSegments(tip: Vec2, awayFrom: Vec2, length: number): [Vec2, Vec2][] {
	const dx = tip.x - awayFrom.x;
	const dy = tip.y - awayFrom.y;
	const dist = Math.hypot(dx, dy);
	if (dist < 1e-6) {
		return [];
	}
	const ux = dx / dist, uy = dy / dist;
	const angleRad = (20 * Math.PI) / 180;
	const legs: [Vec2, Vec2][] = [];
	for (const sign of [1, -1]) {
		const cos = Math.cos(angleRad), sin = Math.sin(angleRad) * sign;
		const bx = -ux, by = -uy;
		const rx = bx * cos - by * sin;
		const ry = bx * sin + by * cos;
		legs.push([tip, new Vec2(tip.x + rx * length, tip.y + ry * length)]);
	}
	return legs;
}

/**
 * Local-space (unrotated, centered on origin) point ring for a rounded
 * rectangle, approximating each corner arc with a handful of straight
 * segments. Reused as an ordinary polygon so it flows through the same
 * matrix-transform + polygon-fill/hit-test path as every other pad shape —
 * no dedicated "roundrect" shape type needed.
 */
function roundedRectLocalPoints(width: number, height: number, radius: number, segmentsPerCorner = 6): Vec2[] {
	const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
	if (r <= 0) {
		return [
			new Vec2(-width / 2, -height / 2), new Vec2(width / 2, -height / 2),
			new Vec2(width / 2, height / 2), new Vec2(-width / 2, height / 2),
		];
	}

	const hw = width / 2, hh = height / 2;
	// Corner centers, walked clockwise starting top-left, each corner arc
	// swept from 180°/270°/0°/90° through a quarter turn.
	const corners: { cx: number; cy: number; startDeg: number }[] = [
		{ cx: -hw + r, cy: -hh + r, startDeg: 180 },
		{ cx: hw - r, cy: -hh + r, startDeg: 270 },
		{ cx: hw - r, cy: hh - r, startDeg: 0 },
		{ cx: -hw + r, cy: hh - r, startDeg: 90 },
	];

	const points: Vec2[] = [];
	for (const corner of corners) {
		for (let i = 0; i <= segmentsPerCorner; i++) {
			const deg = corner.startDeg + (90 * i) / segmentsPerCorner;
			const rad = (deg * Math.PI) / 180;
			points.push(new Vec2(corner.cx + r * Math.cos(rad), corner.cy + r * Math.sin(rad)));
		}
	}
	return points;
}

function boundsOfPoints(points: { x: number; y: number }[]): { x: number; y: number; w: number; h: number } {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Matches KiCad's `hatch edge <pitch>` zone-border style.  Pcbnew generates
 * short 45° strokes which start on the perimeter and run into the zone,
 * rather than hatching the entire area.  Its exact implementation lives in
 * SHAPE_POLY_SET; this equivalent keeps the strokes inside a simple parsed
 * zone polygon and works before any fill has been calculated.
 */
function buildZoneEdgeHatches(
	outline: readonly { x: number; y: number }[],
	pitch: number,
): Array<[Vec2, Vec2]> {
	const points = outline.length > 1
		&& outline[0]!.x === outline[outline.length - 1]!.x
		&& outline[0]!.y === outline[outline.length - 1]!.y
		? outline.slice(0, -1)
		: outline;
	if (points.length < 3 || !Number.isFinite(pitch) || pitch <= 0) {
		return [];
	}

	// The sign selects the normal pointing into the polygon, regardless of
	// whether the KiCad file walks this contour clockwise or counter-clockwise.
	let twiceArea = 0;
	for (let index = 0; index < points.length; index++) {
		const a = points[index]!;
		const b = points[(index + 1) % points.length]!;
		twiceArea += a.x * b.y - b.x * a.y;
	}
	const interiorOnLeft = twiceArea > 0;
	const hatches: Array<[Vec2, Vec2]> = [];

	for (let index = 0; index < points.length; index++) {
		const start = points[index]!;
		const end = points[(index + 1) % points.length]!;
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const length = Math.hypot(dx, dy);
		if (length < pitch * 0.25) {
			continue;
		}
		const tx = dx / length;
		const ty = dy / length;
		const nx = interiorOnLeft ? -ty : ty;
		const ny = interiorOnLeft ? tx : -tx;
		// A 45° vector formed from the inward normal and the reverse edge
		// tangent gives the same edge-whisker direction used by Pcbnew.
		const diagonalX = (nx - tx) / Math.SQRT2;
		const diagonalY = (ny - ty) / Math.SQRT2;

		for (let distance = pitch * 0.5; distance < length; distance += pitch) {
			const hatchStart = new Vec2(start.x + tx * distance, start.y + ty * distance);
			let hatchLength = pitch;
			let hatchEnd = new Vec2(
				hatchStart.x + diagonalX * hatchLength,
				hatchStart.y + diagonalY * hatchLength,
			);
			// Concave vertices can place a nominally inward 45° endpoint beyond
			// another edge. Shorten it to retain KiCad's contained edge hatch.
			if (!pointIsInsidePolygon(hatchEnd, points)) {
				for (let iteration = 0; iteration < 8; iteration++) {
					hatchLength *= 0.5;
					const candidate = new Vec2(
						hatchStart.x + diagonalX * hatchLength,
						hatchStart.y + diagonalY * hatchLength,
					);
					if (pointIsInsidePolygon(candidate, points)) {
						hatchEnd = candidate;
						break;
					}
				}
			}
			if (pointIsInsidePolygon(hatchEnd, points) && hatchLength >= pitch * 0.125) {
				hatches.push([hatchStart, hatchEnd]);
			}
		}
	}
	return hatches;
}

function pointIsInsidePolygon(point: { x: number; y: number }, polygon: readonly { x: number; y: number }[]): boolean {
	let inside = false;
	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		const a = polygon[index]!;
		const b = polygon[previous]!;
		if ((a.y > point.y) !== (b.y > point.y)
			&& point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}
	return inside;
}

/** KiCad's FOOTPRINT::GetBoundingHull() uses pad/drawing geometry but skips
 * fields. Keep the same selection boundary rather than using display-text
 * bboxes, which can sit many millimetres from their footprint. */
function footprintHullPoints(items: PaintedItem[]): { x: number; y: number }[] {
	const points: { x: number; y: number }[] = [];
	for (const item of items) {
		if (item.kind === 'footprint-ref') {
			continue;
		}
		switch (item.shape.type) {
			case 'rect':
				points.push(
					{ x: item.shape.x, y: item.shape.y },
					{ x: item.shape.x + item.shape.w, y: item.shape.y },
					{ x: item.shape.x + item.shape.w, y: item.shape.y + item.shape.h },
					{ x: item.shape.x, y: item.shape.y + item.shape.h },
				);
				break;
			case 'segment': {
				const dx = item.shape.x2 - item.shape.x1;
				const dy = item.shape.y2 - item.shape.y1;
				const length = Math.hypot(dx, dy) || 1;
				const offsetX = (-dy / length) * item.shape.width / 2;
				const offsetY = (dx / length) * item.shape.width / 2;
				points.push(
					{ x: item.shape.x1 + offsetX, y: item.shape.y1 + offsetY },
					{ x: item.shape.x1 - offsetX, y: item.shape.y1 - offsetY },
					{ x: item.shape.x2 + offsetX, y: item.shape.y2 + offsetY },
					{ x: item.shape.x2 - offsetX, y: item.shape.y2 - offsetY },
				);
				break;
			}
			case 'circle':
				for (let i = 0; i < 16; i++) {
					const angle = (i * 2 * Math.PI) / 16;
					points.push({ x: item.shape.cx + item.shape.r * Math.cos(angle), y: item.shape.cy + item.shape.r * Math.sin(angle) });
				}
				break;
			case 'polygon':
				points.push(...item.shape.points);
				break;
		}
	}
	return points;
}

/** Monotonic-chain convex hull, equivalent to the hull KiCad builds from
 * transformed footprint pads and drawings before accurate footprint picking. */
function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
	const sorted = [...points]
		.sort((a, b) => a.x - b.x || a.y - b.y)
		.filter((point, index, all) => index === 0 || point.x !== all[index - 1]!.x || point.y !== all[index - 1]!.y);
	if (sorted.length <= 2) {
		return sorted;
	}
	const cross = (origin: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
		(a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
	const lower: { x: number; y: number }[] = [];
	for (const point of sorted) {
		while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) {
			lower.pop();
		}
		lower.push(point);
	}
	const upper: { x: number; y: number }[] = [];
	for (const point of [...sorted].reverse()) {
		while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) {
			upper.pop();
		}
		upper.push(point);
	}
	lower.pop();
	upper.pop();
	return lower.concat(upper);
}

const PAD_TECHNICAL_LAYERS = new Set([
	'F.Mask', 'B.Mask', 'F.Paste', 'B.Paste', 'F.Adhes', 'B.Adhes',
	'F.SilkS', 'B.SilkS', 'Dwgs.User', 'Eco1.User', 'Eco2.User',
]);

function isPadTechnicalLayer(layer: string): boolean {
	return PAD_TECHNICAL_LAYERS.has(layer);
}

/** Reads simple S-expression children that do not need their own parser
 * mixin: e.g. `(solder_mask_margin 0.1)` and `(layers "F.Cu" "F.Mask")`. */
function readChildValue(element: any, name: string): unknown {
	const child = typeof element?.findFirstChildByName === 'function'
		? element.findFirstChildByName(name)
		: undefined;
	return child?.value ?? child?.attributes?.[0]?.value;
}

function readChildNumber(element: any, name: string): number | undefined {
	const value = readChildValue(element, name);
	const numeric = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(numeric) ? numeric : undefined;
}

function getElementLayers(element: any): string[] {
	const child = typeof element?.findFirstChildByName === 'function'
		? element.findFirstChildByName('layers')
		: undefined;
	return child?.attributes?.map((attribute: any) => String(attribute.value)) ?? [];
}

function getCopperItemLayer(element: any): string {
	const layer = typeof element?.getLayer === 'function' ? element.getLayer() : '';
	return layer || getElementLayers(element).find(candidate => candidate.endsWith('.Cu')) || 'F.Cu';
}

function getSolderMaskLayer(element: any, copperLayer: string): 'F.Mask' | 'B.Mask' | null {
	const layers = getElementLayers(element);
	if (layers.includes('F.Mask') && copperLayer === 'F.Cu') return 'F.Mask';
	if (layers.includes('B.Mask') && copperLayer === 'B.Cu') return 'B.Mask';
	return null;
}

function getTrackMaskExpansion(track: any, board: any): number {
	const width = typeof track?.getWidth === 'function' ? track.getWidth() : 0;
	const margin = readChildNumber(track, 'solder_mask_margin') ?? getBoardMaskExpansion(board);
	return Math.max(-width / 2, margin);
}

function getBoardMaskExpansion(board: any): number {
	const setup = typeof board?.rootElement?.findFirstChildByName === 'function'
		? board.rootElement.findFirstChildByName('setup')
		: undefined;
	return readChildNumber(setup, 'pad_to_mask_clearance') ?? 0;
}

function getPadTechnicalMargin(
	pad: any, footprint: any, board: any, padLayers: readonly string[], size: { width: number; height: number }, layer: string,
): { x: number; y: number } {
	const hasCopper = padLayers.some(candidate => candidate.endsWith('.Cu'));
	if (!hasCopper || (!layer.endsWith('.Mask') && !layer.endsWith('.Paste'))) {
		return { x: 0, y: 0 };
	}

	const setup = typeof board?.rootElement?.findFirstChildByName === 'function'
		? board.rootElement.findFirstChildByName('setup')
		: undefined;
	if (layer.endsWith('.Mask')) {
		const margin = readChildNumber(pad, 'solder_mask_margin')
			?? readChildNumber(footprint, 'solder_mask_margin')
			?? readChildNumber(setup, 'pad_to_mask_clearance')
			?? 0;
		const clamped = Math.max(-Math.min(size.width, size.height) / 2, margin);
		return { x: clamped, y: clamped };
	}
	const absolute = readChildNumber(pad, 'solder_paste_margin')
		?? readChildNumber(footprint, 'solder_paste_margin')
		?? readChildNumber(setup, 'pad_to_paste_clearance')
		?? 0;
	const ratio = readChildNumber(pad, 'solder_paste_margin_ratio')
		?? readChildNumber(footprint, 'solder_paste_margin_ratio')
		?? readChildNumber(setup, 'pad_to_paste_clearance_ratio')
		?? 0;
	return {
		x: Math.max(-size.width / 2, absolute + size.width * ratio),
		y: Math.max(-size.height / 2, absolute + size.height * ratio),
	};
}

function readNestedBoolean(element: any, group: string, side: 'front' | 'back'): boolean | undefined {
	const groupElement = typeof element?.findFirstChildByName === 'function'
		? element.findFirstChildByName(group)
		: undefined;
	const value = readChildValue(groupElement, side);
	if (value === undefined) return undefined;
	return value === true || value === 'yes';
}

function getViaMaskLayers(via: any, board: any, layers: readonly string[]): Array<'F.Mask' | 'B.Mask'> {
	const result: Array<'F.Mask' | 'B.Mask'> = [];
	// PCB_VIA::IsTented resolves an optional via-padstack setting against the
	// board setup's `(tenting (front ...) (back ...))` defaults. A tented side
	// has solder mask covering it, so there is no aperture to paint there.
	const frontTented = readNestedBoolean(via, 'tenting', 'front')
		?? readNestedBoolean(board?.rootElement?.findFirstChildByName?.('setup'), 'tenting', 'front')
		?? false;
	const backTented = readNestedBoolean(via, 'tenting', 'back')
		?? readNestedBoolean(board?.rootElement?.findFirstChildByName?.('setup'), 'tenting', 'back')
		?? false;
	if (layers.includes('F.Cu') && !frontTented) result.push('F.Mask');
	if (layers.includes('B.Cu') && !backTented) result.push('B.Mask');
	return result;
}

function ellipsePolyline(center: Vec2, major: number, minor: number, rotation: number, start: number, end: number, steps: number): Vec2[] {
	const points: Vec2[] = [];
	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);
	for (let index = 0; index <= steps; index++) {
		const angle = start + (end - start) * index / steps;
		const x = major * Math.cos(angle);
		const y = minor * Math.sin(angle);
		points.push(new Vec2(center.x + x * cos - y * sin, center.y + x * sin + y * cos));
	}
	return points;
}

// Lazily require the @kicad-io classes so this module doesn't need a
// hard-coded relative path baked in at author time — the consuming app
// (which has the @kicad-io/* path alias configured) passes real instances
// in; these helpers only need the *classes* for findChildrenByClass()
// lookups, resolved from the same module the caller already imported.
let _Footprint: any, _Segment: any, _Via: any, _Pad: any, _Zone: any, _Layers: any, _GrLine: any, _GrVector: any, _GrArc: any, _GrRect: any, _GrCircle: any, _GrPoly: any, _GrCurve: any, _GrEllipse: any, _GrEllipseArc: any;
let _FpLine: any, _FpRect: any, _FpCircle: any, _FpArc: any, _FpPoly: any, _FpCurve: any, _FpEllipse: any, _FpEllipseArc: any, _Dimension: any, _GrText: any, _GrTextBox: any, _FpText: any, _FpTextBox: any, _Table: any, _TrackArc: any, _Image: any, _Target: any, _Point: any, _Barcode: any;
export function registerKicadIoClasses(classes: {
	Footprint: any; Segment: any; Via: any; Pad: any; Zone: any;
	Layers: any; GrLine: any; GrVector?: any; GrArc: any; GrRect: any; GrCircle: any; GrPoly: any; GrCurve: any; GrEllipse?: any; GrEllipseArc?: any;
	FpLine?: any; FpRect?: any; FpCircle?: any; FpArc?: any; FpPoly?: any; FpCurve?: any; FpEllipse?: any; FpEllipseArc?: any; Dimension?: any; GrText?: any; GrTextBox?: any; FpText?: any; FpTextBox?: any; Table?: any;
	TrackArc?: any; Image?: any; Target?: any; Point?: any; Barcode?: any;
}): void {
	_Footprint = classes.Footprint;
	_Segment = classes.Segment;
	_Via = classes.Via;
	_Pad = classes.Pad;
	_Zone = classes.Zone;
	_Layers = classes.Layers;
	_GrLine = classes.GrLine;
	_GrVector = classes.GrVector;
	_GrArc = classes.GrArc;
	_GrRect = classes.GrRect;
	_GrCircle = classes.GrCircle;
	_GrPoly = classes.GrPoly;
	_GrCurve = classes.GrCurve;
	_GrEllipse = classes.GrEllipse;
	_GrEllipseArc = classes.GrEllipseArc;
	_FpLine = classes.FpLine;
	_FpRect = classes.FpRect;
	_FpCircle = classes.FpCircle;
	_FpArc = classes.FpArc;
	_FpPoly = classes.FpPoly;
	_FpCurve = classes.FpCurve;
	_FpEllipse = classes.FpEllipse;
	_FpEllipseArc = classes.FpEllipseArc;
	_Dimension = classes.Dimension;
	_GrText = classes.GrText;
	_GrTextBox = classes.GrTextBox;
	_FpText = classes.FpText;
	_FpTextBox = classes.FpTextBox;
	_Table = classes.Table;
	_TrackArc = classes.TrackArc;
	_Image = classes.Image;
	_Target = classes.Target;
	_Point = classes.Point;
	_Barcode = classes.Barcode;
}
function getFootprintClass() { return _Footprint; }
function getSegmentClass() { return _Segment; }
function getViaClass() { return _Via; }
function getPadClass() { return _Pad; }
function getZoneClass() { return _Zone; }
function getLayersClass() { return _Layers; }
function getGrLineClass() { return _GrLine; }
function getGrVectorClass() { return _GrVector; }
function getGrArcClass() { return _GrArc; }
function getGrRectClass() { return _GrRect; }
function getGrCircleClass() { return _GrCircle; }
function getGrPolyClass() { return _GrPoly; }
function getGrCurveClass() { return _GrCurve; }
function getGrEllipseClass() { return _GrEllipse; }
function getGrEllipseArcClass() { return _GrEllipseArc; }
function getFpLineClass() { return _FpLine; }
function getFpRectClass() { return _FpRect; }
function getFpCircleClass() { return _FpCircle; }
function getFpArcClass() { return _FpArc; }
function getFpPolyClass() { return _FpPoly; }
function getFpCurveClass() { return _FpCurve; }
function getFpEllipseClass() { return _FpEllipse; }
function getFpEllipseArcClass() { return _FpEllipseArc; }
function getDimensionClass() { return _Dimension; }
function getGrTextClass() { return _GrText; }
function getGrTextBoxClass() { return _GrTextBox; }
function getFpTextClass() { return _FpText; }
function getFpTextBoxClass() { return _FpTextBox; }
function getTableClass() { return _Table; }
function getTrackArcClass() { return _TrackArc; }
function getImageClass() { return _Image; }
function getTargetClass() { return _Target; }
function getPointClass() { return _Point; }
function getBarcodeClass() { return _Barcode; }

function getBoardVersion(root: any): number {
	const version = root?.findFirstChildByName?.('version');
	return typeof version?.value === 'number' ? version.value : Number(version?.attributes?.[0]?.value ?? 0);
}

/** Matches PCB_TEXT::GetDrawRotation() for text owned by a footprint. */
function footprintTextDrawAngle(text: any, footprintRotation: number): number {
	const textRotation = typeof text?.getOrigin === 'function' ? text.getOrigin().rotation ?? 0 : 0;
	let rotation = textRotation + footprintRotation;
	const unlocked = typeof text?.findFirstChildByName === 'function'
		? text.findFirstChildByName('unlocked')
		: undefined;

	if (unlocked?.value) {
		return normalizeAngle(rotation);
	}

	while (rotation > 90) {
		rotation -= 180;
	}
	while (rotation <= -90) {
		rotation += 180;
	}
	return rotation;
}

function normalizeAngle(rotation: number): number {
	return ((rotation + 180) % 360 + 360) % 360 - 180;
}

function rotateAround(point: Vec2, center: Vec2, radians: number): Vec2 {
	if (radians === 0) return point;
	const x = point.x - center.x;
	const y = point.y - center.y;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return new Vec2(center.x + x * cos - y * sin, center.y + x * sin + y * cos);
}

/**
 * KiCad custom pads store copper outline(s) under
 * `(primitives (gr_poly (pts …) …))` in pad-local coordinates.
 */
function getCustomPadLocalRings(pad: any): Vec2[][] {
	if (typeof pad.getCustomPolygonPoints === 'function') {
		return (pad.getCustomPolygonPoints() as Array<Array<{ x: number; y: number }>>)
			.filter(r => r.length >= 3)
			.map(r => r.map(p => new Vec2(p.x, p.y)));
	}
	const primitives = typeof pad.findFirstChildByName === 'function'
		? pad.findFirstChildByName('primitives')
		: null;
	if (!primitives?.children) {
		return [];
	}
	const rings: Vec2[][] = [];
	for (const child of primitives.children as any[]) {
		if (child?.name !== 'gr_poly') {
			continue;
		}
		let pts: Array<{ x: number; y: number }> = [];
		if (typeof child.getPoints === 'function') {
			pts = child.getPoints();
		}
		else {
			const ptsEl = typeof child.findFirstChildByName === 'function'
				? child.findFirstChildByName('pts')
				: null;
			if (ptsEl?.children) {
				pts = (ptsEl.children as any[])
					.map((xy: any) => ({ x: xy.x, y: xy.y }))
					.filter((p: { x: number; y: number }) => typeof p.x === 'number' && typeof p.y === 'number');
			}
		}
		if (pts.length >= 3) {
			rings.push(pts.map(p => new Vec2(p.x, p.y)));
		}
	}
	return rings;
}

/**
 * Pcbnew offsets the complete custom-pad polygon before flashing it onto a
 * technical layer. Clipper accepts an isotropic delta, so scale the local
 * axes first when paste settings produce different X/Y margins; scaling back
 * afterwards preserves the requested aperture extents in both directions.
 */
function offsetCustomPadLocalRings(
	rings: Vec2[][], margin: { x: number; y: number },
): Vec2[][] {
	if (rings.length === 0 || (Math.abs(margin.x) < 1e-9 && Math.abs(margin.y) < 1e-9)) {
		return rings;
	}

	const sameDirection = margin.x * margin.y >= 0;
	const scaleX = Math.abs(margin.x);
	const scaleY = Math.abs(margin.y);
	if (!sameDirection || scaleX < 1e-9 || scaleY < 1e-9) {
		return rings;
	}

	const normalized = rings.map(ring => toClipperPath(ring.map(point => ({
		x: point.x / scaleX,
		y: point.y / scaleY,
	}))));
	const deltaNm = Math.sign(margin.x) * 1_000_000;
	return getClipperEngine()
		.inflatePaths(normalized, deltaNm, JoinType.Round, EndType.Polygon)
		.map(fromClipperPath)
		.filter(ring => ring.length >= 3)
		.map(ring => ring.map(point => new Vec2(point.x * scaleX, point.y * scaleY)));
}

/** Second attribute on `(layer "F.SilkS" knockout)` — WithLayer's getLayer()
 * only surfaces the layer name itself, so this reaches into the raw child
 * directly rather than extending that mixin. */
function isKnockoutLayer(el: any): boolean {
	const layerChild = typeof el.findFirstChildByName === 'function' ? el.findFirstChildByName('layer') : null;
	return layerChild?.attributes?.[1]?.value === 'knockout';
}

/**
 * KiCad's `render_cache` stores the fully-resolved glyph outlines (already
 * in absolute board coordinates) for any text using a font our built-in
 * Newstroke vector font can't reproduce. Read generically (no dedicated
 * @kicad-io class needed) since 'polygon'/'pts'/'xy' are already part of the
 * parser's always-on element vocabulary (the same machinery zone fills rely
 * on), not something this module needs to register itself.
 */
function getRenderCacheRings(textEl: any): { x: number; y: number }[][] | null {
	if (typeof textEl.findFirstChildByName !== 'function') {
		return null;
	}
	const cache = textEl.findFirstChildByName('render_cache');
	if (!cache || typeof cache.findChildrenByName !== 'function') {
		return null;
	}
	const polygons = cache.findChildrenByName('polygon');
	const rings: { x: number; y: number }[][] = [];
	for (const poly of polygons) {
		const pts = typeof poly.findFirstChildByName === 'function' ? poly.findFirstChildByName('pts') : null;
		if (!pts) {
			continue;
		}
		const ring = (pts.children as any[])
			.map(xy => ({ x: xy.x, y: xy.y }))
			.filter(p => typeof p.x === 'number' && typeof p.y === 'number');
		if (ring.length >= 3) {
			rings.push(ring);
		}
	}
	return rings.length > 0 ? rings : null;
}
