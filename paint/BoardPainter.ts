import { Vec2 } from '../math/Vec2';
import { Angle } from '../math/Angle';
import { Matrix3 } from '../math/Matrix3';
import { Renderer } from '../render/Renderer';
import { styleForLayer, boardBackgroundColor, zoneFillAlpha, withAlpha } from './LayerColors';
import { layerPaintOrder } from './LayerOrder';
import { computeStrokeTextGeometry, drawStrokeTextGeometry } from './TextPaint';
import { PaintedShape, shapeToBBox, bboxesIntersect } from './PaintedShape';

// KicadBoard/KicadElementFootprint/etc. are only available once the
// @kicad-io submodule is resolved via the @kicad-io/* path alias in the
// consuming app — typed loosely (any) here so this module has no hard
// compile-time dependency on the exact submodule layout, matching how
// api/src/Modules/Bom/Service/KiCad.Service.ts treats element results.

export interface PaintedItem {
	id: string;
	layer: string;
	kind: 'pad' | 'track' | 'via' | 'footprint-ref' | 'footprint' | 'zone' | 'graphic';
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
	/** Copper layers in PHYSICAL stack order (F.Cu first, B.Cu last, exactly
	 *  as declared in the board's own `(layers ...)` table — KiCad writes
	 *  that table in stack order, not the render/paint order layersPresent
	 *  uses). BoardRatsnest needs this to know which internal layers a
	 *  through/blind/buried via's plated barrel actually spans. */
	copperLayerStack: string[];
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
	if (!activeLayer || !layersPresent.includes(activeLayer)) {
		return [...layersPresent];
	}
	return [...layersPresent.filter(layer => layer !== activeLayer), activeLayer];
}

/** Options for BoardPainter.build() — kept off the hot paint() path. */
export interface BoardPaintOptions {
	/**
	 * When true, draw each pad's number centered on the pad (KiCad
	 * footprint-editor / pad-netname overlay style). Default false so the
	 * board viewer stays uncluttered; Footprint Generator opts in.
	 */
	showPadNumbers?: boolean;
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
	options: BoardPaintOptions = { showPadNumbers: false };

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
			pushItem(this.buildTrack(segment));
		}

		if (getTrackArcClass()) {
			const trackArcs = board.rootElement.findChildrenByClass(getTrackArcClass());
			for (const arc of trackArcs) {
				const item = this.buildTrackArc(arc);
				if (item) {
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
			for (const item of this.buildFootprint(footprint, globalLayers)) {
				pushItem(item);
			}
		}

		const vias = board.rootElement.findChildrenByClass(getViaClass());
		for (const via of vias) {
			for (const item of this.buildVia(via)) {
				pushItem(item);
			}
		}

		// Board-level graphics can live on any active layer (not only Edge.Cuts).
		// Keeping Edge.Cuts in this ordinary graphic pass also makes a newly
		// placed board outline behave just like the original imported one.
		const graphicLines = board.rootElement.findChildrenByClass(getGrLineClass());
		for (const line of graphicLines) {
			pushItem(this.buildGrLine(line));
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

		const layersPresent = layerPaintOrder.filter(l => layerBuckets.has(l));
		const hitTestItems: PaintedItem[] = [];
		for (const layer of layersPresent) {
			for (const item of layerBuckets.get(layer)!) {
				if (item.hitTestable) {
					hitTestItems.push(item);
				}
			}
		}

		const copperLayerStack = globalLayers.filter(l => l.endsWith('.Cu'));
		const zoneFills = this.buildZoneFills(zones, copperLayerStack);

		return { layersPresent, layerBuckets, hitTestItems, zoneFills, copperLayerStack };
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
		for (const item of this.buildFootprint(footprint, globalLayers)) {
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
		// covers the rare case a flip empties or (re)populates a layer.
		scene.layersPresent = layerPaintOrder.filter(l => (scene.layerBuckets.get(l)?.length ?? 0) > 0);
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
		scene.layersPresent = layerPaintOrder.filter(l => (scene.layerBuckets.get(l)?.length ?? 0) > 0);
	}

	/**
	 * Builds a footprint's own PaintedItems without touching any scene — the
	 * live drag-preview path (KicadRenderSession.updateBoardDragPreview)
	 * calls this every frame and draws the result through the cheap
	 * per-frame dynamic buffer instead of baking it into the static one.
	 */
	buildFootprintPreviewItems(board: any, footprint: any): PaintedItem[] {
		return this.buildFootprint(footprint, this.getGlobalLayerNames(board));
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
		for (const layer of boardPaintOrder(scene.layersPresent, activeLayer)) {
			const state = layerState.get(layer);
			if (!state || !state.visible) {
				continue;
			}
			const items = scene.layerBuckets.get(layer)!;
			const baseColor = styleForLayer(layer).color;

			renderer.setOpacity?.(state.opacity);
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

	protected buildTrack(segment: any): PaintedItem {
		const { start, end } = segment.getStartEnd();
		const layer = segment.getLayer();
		const width = segment.getWidth ? segment.getWidth() : 0.25;
		const id = segment.getUuid() ?? `track:${ start.x },${ start.y }-${ end.x },${ end.y }`;
		const shape: PaintedShape = { type: 'segment', x1: start.x, y1: start.y, x2: end.x, y2: end.y, width };

		return {
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
		};
	}

	/** A curved copper track — segment's arc counterpart (e.g. rounded
	 *  corners on a length-tuning/meander pattern). Not hit-testable yet:
	 *  same limitation buildGrArc already has — PaintedShape has no
	 *  sweep-aware arc variant, so a 'circle' hit-shape would wrongly accept
	 *  clicks anywhere on the full ring, not just the drawn arc. */
	protected buildTrackArc(arc: any): PaintedItem | null {
		if (typeof arc.getArcCenterRadiusAngles !== 'function') {
			return null;
		}
		const { centerX, centerY, radius, startAngle, endAngle } = arc.getArcCenterRadiusAngles();
		const layer = arc.getLayer();
		const width = typeof arc.getWidth === 'function' ? arc.getWidth() : 0.25;
		const id = arc.getUuid() ?? `track-arc:${ layer }:${ centerX },${ centerY }`;
		const shape: PaintedShape = { type: 'circle', cx: centerX, cy: centerY, r: radius };

		return {
			id, layer, kind: 'track', shape, bbox: shapeToBBox(shape), hitTestable: false, element: arc,
			netId: typeof arc.getNetId === 'function' ? arc.getNetId() : null,
			netName: typeof arc.getNetName === 'function' ? arc.getNetName() : null,
			draw: (renderer, color) => {
				renderer.arc(new Vec2(centerX, centerY), radius, startAngle, endAngle, { strokeColor: color, strokeWidth: width });
			},
		};
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
			for (const layer of layers) {
				items.push({
					id: `${ zoneId }:${ layer }:outline`, layer, kind: 'zone',
					shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: zone,
					zoneDisplayMode: filledLayers.has(layer) ? 'outline' : undefined, netId, netName,
					draw: (renderer, color) => {
						renderer.polygon(points, { strokeColor: color, strokeWidth: displayOutlineWidth });
						for (const [start, end] of edgeHatches) {
							renderer.line([start, end], { strokeColor: color, strokeWidth: displayOutlineWidth });
						}
					},
				});
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

	protected buildFootprint(footprint: any, globalLayers: string[]): PaintedItem[] {
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
			for (const item of this.buildPad(pad, footprintMatrix, origin.rotation ?? 0, footprint, footprintId, globalLayers)) {
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
				// Absolute-angle-in-file convention applies to property text
				// too (same reasoning as pads) — the rendered angle is the
				// property's own angle, not footprint rotation + property angle.
				const textAngle = propOrigin.rotation ?? 0;
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
					const item = this.buildTextElement(text, footprintMatrix, footprintId);
					if (item) {
						items.push(item);
					}
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
	protected buildTextElement(textEl: any, footprintMatrix: Matrix3 | null, footprintId?: string): PaintedItem | null {
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
		const angleDeg = origin.rotation ?? 0;
		const font = typeof textEl.getFont === 'function' ? textEl.getFont() : { height: 1 };
		const textSize = font.height || 1;
		const value = textEl.value;
		const bbox = { x: worldPos.x - textSize, y: worldPos.y - textSize, w: textSize * 2, h: textSize * 2 };
		const anchor = typeof textEl.getAnchorPoint === 'function' ? textEl.getAnchorPoint() : { x: 0, y: 0 };
		const geometry = computeStrokeTextGeometry(value, worldPos, textSize, angleDeg, isBack, undefined, anchor);

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
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: line,
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
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: arc,
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
		footprint: any, footprintId: string, globalLayers: string[]
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

		// Pads are part of their copper layer in real KiCad (no separate
		// "Pads" layer exists — see the screenshot the layer list came
		// from), so route into F.Cu/B.Cu directly. build() appends
		// footprints (and their pads) after tracks/zones for the same
		// layer, so pads still paint on top within that bucket.
		const padLayers: string[] = typeof pad.getLayers === 'function' ? pad.getLayers(globalLayers) : ['F.Cu'];
		const buckets: string[] = [];
		if (padLayers.includes('F.Cu')) {
			buckets.push('F.Cu');
		}
		if (padLayers.includes('B.Cu')) {
			buckets.push('B.Cu');
		}
		if (buckets.length === 0) {
			buckets.push('F.Cu');
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

		if (this.options.showPadNumbers) {
			const numberItem = this.buildPadNumber(
				pad, worldCenter, size, footprintRotationDeg, padRotationDeg, id,
			);
			if (numberItem) {
				items.push(numberItem);
			}
		}

		return items;
	}

	/**
	 * Pad number overlay — ports kicanvas/KiCad pcb_painter pad-netname
	 * sizing: fit font to the pad's shorter axis (cap 10mm), rotate 90° when
	 * the pad is taller than wide, then keep the label upright. Drawn on the
	 * synthetic PadNumbers layer above copper.
	 */
	protected buildPadNumber(
		pad: any,
		worldCenter: Vec2,
		size: { width: number; height: number },
		footprintRotationDeg: number,
		padRotationDeg: number,
		padId: string,
	): PaintedItem | null {
		const number = String(pad.padNumber ?? '');
		if (!number || number === '~') {
			return null;
		}

		// Orth size / orientation — same rules as kicanvas PadPainter.
		let maxWidth = size.width;
		let maxFontSize = size.height;
		let textRotated = -footprintRotationDeg;
		if (size.width < size.height * 0.95) {
			textRotated += 90;
			maxWidth = size.height;
			maxFontSize = size.width;
		}
		maxFontSize = Math.min(maxFontSize, 10);

		// Keep label upright in world space (worldAngle = padRot + textRotated).
		while (padRotationDeg + textRotated > 90) {
			textRotated -= 180;
		}
		while (padRotationDeg + textRotated <= -90) {
			textRotated += 180;
		}

		// Shrink to fit character count along the long axis (KiCad: width/max(len,3)).
		const fitWidth = maxWidth / Math.max(number.length, 3);
		let fontSize = Math.min(maxFontSize, fitWidth) * 0.95;
		// Tiny pads (e.g. 0402) — keep a readable floor without exploding past the pad.
		const minReadable = Math.min(0.25, Math.max(maxFontSize, maxWidth) * 0.55);
		fontSize = Math.max(fontSize, minReadable);
		if (fontSize <= 0) {
			return null;
		}

		const worldAngle = padRotationDeg + textRotated;
		const strokeWidth = fontSize / 8;
		const geometry = computeStrokeTextGeometry(
			number, worldCenter, fontSize, worldAngle, false, strokeWidth, { x: 0.5, y: 0.5 },
		);
		const half = fontSize;
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
				drawStrokeTextGeometry(renderer, geometry, color);
			},
		};
	}

	protected buildVia(via: any): PaintedItem[] {
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

		return [{
			id, layer: 'Vias', kind: 'via', shape, bbox: shapeToBBox(shape), hitTestable: true, element: via,
			netId: typeof via.getNetId === 'function' ? via.getNetId() : null,
			netName: typeof via.getNetName === 'function' ? via.getNetName() : null,
			draw: (renderer, color, displayMode) => {
				if (displayMode === 'outline') {
					renderer.circle(new Vec2(origin.x, origin.y), outerRadius, { strokeColor: color, strokeWidth: SKETCH_STROKE_WIDTH });
					renderer.circle(new Vec2(origin.x, origin.y), holeRadius, { strokeColor: color, strokeWidth: SKETCH_STROKE_WIDTH });
					return;
				}
				// Vias are drilled through-holes — draw the annular copper
				// ring, then punch the hole by drawing the board background
				// color on top, instead of a solid filled disc.
				renderer.circle(new Vec2(origin.x, origin.y), outerRadius, { fillColor: color });
				renderer.circle(new Vec2(origin.x, origin.y), holeRadius, { fillColor: boardBackgroundColor });
			},
		}];
	}

	protected buildGrLine(line: any): PaintedItem {
		const { start, end } = line.getStartEnd();
		const layer = line.getLayer();
		const width = typeof line.getStroke === 'function' ? line.getStroke().width : 0.1;
		const id = line.getUuid() ?? `gr:${ layer }:${ start.x },${ start.y }-${ end.x },${ end.y }`;
		const shape: PaintedShape = { type: 'segment', x1: start.x, y1: start.y, x2: end.x, y2: end.y, width };

		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: line,
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
		const shape: PaintedShape = { type: 'circle', cx: centerX, cy: centerY, r: radius };

		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: false, element: arc,
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
		const shape: PaintedShape = { type: 'rect', x, y, w, h };

		return {
			id, layer, kind: 'graphic', shape, bbox: shape, hitTestable: true, element: rect,
			draw: (renderer, color) => {
				// Edge cuts (and most gr_rect graphics) are an outline, not a
				// filled shape — a board outline being solid-filled would
				// paint over everything else on that layer.
				renderer.rect(new Vec2(x, y), w, h, { strokeColor: color, strokeWidth: width || 0.1 });
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
		const strokeWidth = 0.1;
		const arrowLength = 1.27;

		if (points.length >= 2) {
			const [p1, p2] = points;
			// The dimension line's two endpoints, offset from the measured
			// points by `height` along the perpendicular direction.
			let lineStart: Vec2, lineEnd: Vec2;
			if (dimType === 'orthogonal') {
				lineStart = orientation === 1 ? new Vec2(p1.x + height, p1.y) : new Vec2(p1.x, p1.y + height);
				lineEnd = orientation === 1 ? new Vec2(p2.x + height, p2.y) : new Vec2(p2.x, p2.y + height);
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
			}

			const segments: [Vec2, Vec2][] = [
				[new Vec2(p1.x, p1.y), lineStart],
				[new Vec2(p2.x, p2.y), lineEnd],
				[lineStart, lineEnd],
				...arrowheadSegments(lineStart, lineEnd, arrowLength),
				...arrowheadSegments(lineEnd, lineStart, arrowLength),
			];
			const bbox = boundsOfPoints([p1, p2, { x: lineStart.x, y: lineStart.y }, { x: lineEnd.x, y: lineEnd.y }]);
			items.push({
				id: `${ id }:line`, layer, kind: 'graphic',
				shape: { type: 'rect', ...bbox }, bbox, hitTestable: false, element: dim,
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
				hitTestable: false, element: dim,
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
		const shape: PaintedShape = { type: 'circle', cx: center.x, cy: center.y, r: radius };

		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: circle,
			draw: (renderer, color) => {
				renderer.circle(new Vec2(center.x, center.y), radius, { strokeColor: color, strokeWidth: width || 0.1 });
			},
		};
	}

	/** Pcbnew `gr_text_box`: a start/end rectangle with optional border and
	 * multiline text laid out inside its four margins. */
	protected buildGrTextBox(textBox: any): PaintedItem | null {
		if (!textBox.value || typeof textBox.getStartEnd !== 'function') return null;
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
		const textPosition = new Vec2(x + marginLeft + contentWidth * justify.x, y + marginTop + contentHeight * justify.y);
		const geometry = computeStrokeTextGeometry(textBox.value, textPosition, textSize, 0, isBack, font.thickness || 0.15, justify);
		const border = textBox.getSimpleChildValue?.('border') !== false;
		const strokeWidth = typeof textBox.getStroke === 'function' ? textBox.getStroke().width : 0.1;
		const id = textBox.getUuid?.() ?? `gr-text-box:${ layer }:${ x },${ y }`;
		const bbox = { x, y, w: width, h: height };
		return {
			id, layer, kind: 'graphic', shape: { type: 'rect', ...bbox }, bbox, hitTestable: true, element: textBox,
			draw: (renderer, color) => {
				if (border) renderer.rect(new Vec2(x, y), width, height, { strokeColor: color, strokeWidth: strokeWidth || 0.1 });
				drawStrokeTextGeometry(renderer, geometry, color);
			},
		};
	}

	protected buildGrPoly(polygon: any): PaintedItem | null {
		const points: Array<{ x: number; y: number }> = typeof polygon.getPoints === 'function' ? polygon.getPoints() : [];
		if (points.length < 3) return null;
		const layer = polygon.getLayer();
		const width = typeof polygon.getStroke === 'function' ? polygon.getStroke().width : 0.1;
		const id = polygon.getUuid() ?? `gr-poly:${ layer }:${ points[0]!.x },${ points[0]!.y }`;
		const shape: PaintedShape = { type: 'polygon', points: points.map(point => ({ x: point.x, y: point.y })) };
		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: polygon,
			draw: (renderer, color) => renderer.line(
				[...points.map(point => new Vec2(point.x, point.y)), new Vec2(points[0]!.x, points[0]!.y)],
				{ strokeColor: color, strokeWidth: width || 0.1 }),
		};
	}

	protected buildGrCurve(curve: any): PaintedItem | null {
		const points: Array<{ x: number; y: number }> = typeof curve.getPoints === 'function' ? curve.getPoints() : [];
		if (points.length !== 4) return null;
		const layer = curve.getLayer();
		const width = typeof curve.getStroke === 'function' ? curve.getStroke().width : 0.1;
		const id = curve.getUuid() ?? `gr-curve:${ layer }:${ points[0]!.x },${ points[0]!.y }`;
		const shapePoints = cubicBezierToPolyline(points.map(point => new Vec2(point.x, point.y)) as [Vec2, Vec2, Vec2, Vec2]);
		const shape: PaintedShape = { type: 'polygon', points: shapePoints.map(point => ({ x: point.x, y: point.y })) };
		return {
			id, layer, kind: 'graphic', shape, bbox: shapeToBBox(shape), hitTestable: true, element: curve,
			draw: (renderer, color) => renderer.line(shapePoints, { strokeColor: color, strokeWidth: width || 0.1 }),
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

// Lazily require the @kicad-io classes so this module doesn't need a
// hard-coded relative path baked in at author time — the consuming app
// (which has the @kicad-io/* path alias configured) passes real instances
// in; these helpers only need the *classes* for findChildrenByClass()
// lookups, resolved from the same module the caller already imported.
let _Footprint: any, _Segment: any, _Via: any, _Pad: any, _Zone: any, _Layers: any, _GrLine: any, _GrArc: any, _GrRect: any, _GrCircle: any, _GrPoly: any, _GrCurve: any;
let _FpLine: any, _FpRect: any, _FpCircle: any, _FpArc: any, _FpPoly: any, _Dimension: any, _GrText: any, _GrTextBox: any, _FpText: any, _TrackArc: any;
export function registerKicadIoClasses(classes: {
	Footprint: any; Segment: any; Via: any; Pad: any; Zone: any;
	Layers: any; GrLine: any; GrArc: any; GrRect: any; GrCircle: any; GrPoly: any; GrCurve: any;
	FpLine?: any; FpRect?: any; FpCircle?: any; FpArc?: any; FpPoly?: any; Dimension?: any; GrText?: any; GrTextBox?: any; FpText?: any;
	TrackArc?: any;
}): void {
	_Footprint = classes.Footprint;
	_Segment = classes.Segment;
	_Via = classes.Via;
	_Pad = classes.Pad;
	_Zone = classes.Zone;
	_Layers = classes.Layers;
	_GrLine = classes.GrLine;
	_GrArc = classes.GrArc;
	_GrRect = classes.GrRect;
	_GrCircle = classes.GrCircle;
	_GrPoly = classes.GrPoly;
	_GrCurve = classes.GrCurve;
	_FpLine = classes.FpLine;
	_FpRect = classes.FpRect;
	_FpCircle = classes.FpCircle;
	_FpArc = classes.FpArc;
	_FpPoly = classes.FpPoly;
	_Dimension = classes.Dimension;
	_GrText = classes.GrText;
	_GrTextBox = classes.GrTextBox;
	_FpText = classes.FpText;
	_TrackArc = classes.TrackArc;
}
function getFootprintClass() { return _Footprint; }
function getSegmentClass() { return _Segment; }
function getViaClass() { return _Via; }
function getPadClass() { return _Pad; }
function getZoneClass() { return _Zone; }
function getLayersClass() { return _Layers; }
function getGrLineClass() { return _GrLine; }
function getGrArcClass() { return _GrArc; }
function getGrRectClass() { return _GrRect; }
function getGrCircleClass() { return _GrCircle; }
function getGrPolyClass() { return _GrPoly; }
function getGrCurveClass() { return _GrCurve; }
function getFpLineClass() { return _FpLine; }
function getFpRectClass() { return _FpRect; }
function getFpCircleClass() { return _FpCircle; }
function getFpArcClass() { return _FpArc; }
function getFpPolyClass() { return _FpPoly; }
function getDimensionClass() { return _Dimension; }
function getGrTextClass() { return _GrText; }
function getGrTextBoxClass() { return _GrTextBox; }
function getFpTextClass() { return _FpText; }
function getTrackArcClass() { return _TrackArc; }

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
