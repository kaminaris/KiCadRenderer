import { ClipType } from '@clipper2-ts/engine';
import { FillRule, Path, Paths, Point64Of, PointInPolygon, PointInPolygonResult } from '@clipper2-ts/core';
import { EndType, JoinType } from '@clipper2-ts/offset';
import { Angle } from '../math/Angle';
import { Matrix3 } from '../math/Matrix3';
import { Vec2 } from '../math/Vec2';
import { LayeredBoardScene, PaintedItem } from './BoardPainter';
import { getClipperEngine } from './ClipperEngine';
import { PaintedShape } from './PaintedShape';

/**
 * A scoped, faithful translation of real KiCad's zone_filler.cpp pipeline —
 * ported to the Clipper2-TS engine (shared/clipper2-ts) rather than a
 * closed-form approximation, per this project's standing "code parity"
 * preference (see the harmonic-munching-trinket plan).
 *
 * Steps mirrored from zone_filler.cpp (ZONE_FILLER::fillSingleZone) and
 * ZONE::BuildSmoothedPoly:
 *  1. outline = the zone's own authored polygon (skips BuildSmoothedPoly's
 *     corner-smoothing nuance for now — see the deferred list below).
 *  2. Intersect the outline against the board's own physical outline
 *     (Edge.Cuts, assembled into outer-perimeter + cutout regions — see
 *     buildBoardOutlineRegionNm) — matches ZONE::BuildSmoothedPoly's own
 *     `aSmoothedPoly.BooleanIntersection( boardOutline )`, confirmed against
 *     real KiCad source (zone.cpp) rather than assumed.
 *  3. Collect every OTHER-net pad/track/via on the same copper layer as a
 *     polygon ring — reusing the already-built PaintedItem.shape geometry
 *     from BoardPainter instead of re-deriving pad/via/track shapes a
 *     second time from the raw element tree. Track ARCS (length/time-tuning
 *     meanders) get a proper capsule-around-the-swept-arc ring, not a
 *     full-circle exclusion — see trackArcRingMm's doc comment.
 *  4. Inflate each exclusion ring by the zone's clearance (round joins,
 *     matching zone_filler.cpp's own `SHAPE_POLY_SET::Inflate(clearance,
 *     ARC_LOW_DEF, SHAPE_POLY_SET::ROUND_ALL_CORNERS)`).
 *  4b. Two more exclusion sources, both layer-uniform (not zone-specific,
 *     so computed once per board/layer and shared across every zone that
 *     fills that layer — see buildEdgeExclusionsByLayer):
 *      - Board-edge (Edge.Cuts) copper clearance: real KiCad's
 *        knockoutGraphicClearance (zone_filler.cpp) treats every individual
 *        Edge.Cuts graphic item — not the assembled outline as one shape —
 *        as its own knockout, inflated by EDGE_CLEARANCE_CONSTRAINT
 *        (defaulting to board design settings' 0.5mm, DEFAULT_COPPEREDGE
 *        CLEARANCE in include/board_design_settings.h). This is a hard
 *        separation from copper, distinct from step 2's zero-clearance
 *        "clip to inside the board" intersection.
 *      - Keepout zones ("rule areas" with `(keepout (copperpour not_allowed))`)
 *        knock out their own outline with ZERO extra clearance — real
 *        KiCad's own comment on this exact line (zone_filler.cpp's
 *        knockoutZoneClearance): "Keepouts use outline with no clearance".
 *     Both are therefore already fully-sized rings by the time they reach
 *     computeFillFromRings — passed through as `extraExclusionRingsMm`,
 *     which (unlike step 3's rings) does NOT go through the clearanceMm
 *     inflate in step 4, since that inflate is only for pad/track/via
 *     same-pass electrical clearance.
 *  5. Union the inflated exclusions together, then Difference them out of
 *     the outline for the final fill.
 *  6. Fracture: bridge every hole ring into its enclosing outer ring via a
 *     keyhole cut, so the result is simple (hole-free) polygons — confirmed
 *     against real KiCad source (pcbnew/zone_filler.cpp calls
 *     `aFillPolys.Fracture()` right before every `filled_polygons` write;
 *     libs/kimath/.../shape_poly_set.cpp's SHAPE_POLY_SET::Fracture is the
 *     algorithm) that this is required, not optional: both this app's own
 *     rendering (BoardPainter.buildZone calls multiPolygon() once per
 *     filled_polygon entry, independently — a hole ring stored as its own
 *     entry would render as an extra SOLID blob, not a gap) and real KiCad
 *     reopening an exported file expect hole-free polygons here. The bridge
 *     technique itself is a straightforward reimplementation of the same
 *     idea (connect each hole's leftmost point to the nearest visible point
 *     on its enclosing outline) rather than a line-by-line translation of
 *     FractureEdgeSlow's pointer-linked-list internals, which have no
 *     natural TS equivalent (same reasoning as engine.ts's MaxHeap standing
 *     in for std::priority_queue).
 *
 * Split into two layers on purpose: `computeFillFromRings` is pure Clipper2
 * math over plain serializable data (no live scene/element references) —
 * safe to run inside a Web Worker, which is exactly what it's for (see
 * apps/kicad-viewer/src/worker/zone-fill.worker.ts). `computeZoneFillForLayer`
 * /`computeZoneFill` are the main-thread convenience wrappers that pull the
 * plain data out of a live LayeredBoardScene/board first.
 *
 * Deliberately deferred (each needs infrastructure this pass doesn't have —
 * not simplified approximations, just not attempted yet):
 *  - Thermal-relief spokes (needs spoke-polygon generation + a hit-test
 *    reconnect step against the exclusion holes).
 *  - Same-net multi-zone priority interaction (needs whole-board zone
 *    iteration + a priority field).
 *  - Island removal (needs board connectivity data — BoardRatsnest.ts's
 *    union-find is the natural extension point for this later).
 *  - Min-width pruning.
 *  - The real EDGE_CLEARANCE_CONSTRAINT/CopperEdgeClearance value comes from
 *    a project's DRC rules / board design settings (.kicad_pro), which this
 *    app doesn't parse yet — DEFAULT_EDGE_CLEARANCE_MM below is real KiCad's
 *    own stock default (DEFAULT_COPPEREDGECLEARANCE), not an invented one,
 *    and every entry point accepts an override so wiring up the real
 *    project value later doesn't change this module's shape.
 */

// KiCad's own internal unit is integer nanometers (confirmed via this app's
// existing BoardPainter comment on zone outline width) — Clipper2 itself is
// built around integer coordinates for sweep-algorithm robustness, so this
// mirrors that convention exactly rather than inventing a different scale.
const NM_PER_MM = 1_000_000;

export type MmPoint = { x: number; y: number };
export type MmPath = MmPoint[];

function toClipperPath(points: MmPath): Path {
	return points.map(p => Point64Of(p.x * NM_PER_MM, p.y * NM_PER_MM));
}

function fromClipperPath(path: Path): MmPath {
	return path.map(p => ({ x: p.x / NM_PER_MM, y: p.y / NM_PER_MM }));
}

/** Tessellates a circle (round pad/via copper, or an Edge.Cuts gr_circle
 *  board cutout) into a polygon ring, world-mm. */
function tessellateCircleMm(cx: number, cy: number, r: number, segments = 48): MmPath {
	const points: MmPath = [];
	for (let i = 0; i < segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
	}
	return points;
}

/** Samples an arc's centerline (world-mm) between startAngle and endAngle
 *  (radians, same convention as @kicad-io's getArcCenterRadiusAngles — used
 *  as-is for rendering elsewhere in BoardPainter, so this follows suit
 *  rather than guessing a different direction/wraparound convention). */
function arcCenterlineMm(cx: number, cy: number, r: number, startAngle: number, endAngle: number, segments = 24): MmPath {
	const points: MmPath = [];
	for (let i = 0; i <= segments; i++) {
		const a = startAngle + (endAngle - startAngle) * i / segments;
		points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
	}
	return points;
}

/** Thickens an arbitrary open polyline (world-mm) into a capsule ring by
 *  routing it through the ported ClipperOffset (round joins, round caps) —
 *  the same technique used for both a straight track segment (a 2-point
 *  polyline) and a curved track arc (an N-point sampled polyline), so a
 *  meander/length-tuning pattern's arcs get a properly curved capsule
 *  instead of either a straight-line approximation or (the bug this
 *  replaces) a full-circle exclusion covering the arc's entire circle. */
function polylineCapsuleRingMm(points: MmPath, width: number): MmPath {
	if (points.length === 0) return [];
	if (points.length === 1) return tessellateCircleMm(points[0]!.x, points[0]!.y, width / 2);
	const pathNm = toClipperPath(points);
	const capsule = getClipperEngine().inflatePaths([pathNm], (width / 2) * NM_PER_MM, JoinType.Round, EndType.Round);
	return capsule[0] ? fromClipperPath(capsule[0]) : [];
}

/** A track arc's own copper shape — real KiCad's PCB_TRACK::TransformShapeToPolygon
 *  produces a capsule around the swept arc, not the arc's full circle.
 *  BoardPainter's PaintedItem for a track arc stores only {cx, cy, r} (a
 *  full-circle 'circle' PaintedShape, since a proper sweep-aware shape type
 *  doesn't exist yet — see BoardPainter.buildTrackArc's own doc comment
 *  about the same limitation for hit-testing), so this reaches into the
 *  live @kicad-io element (already carried on every PaintedItem) for the
 *  real start/end angles instead of trusting the full-circle PaintedShape. */
function trackArcRingMm(element: any, fallbackShape: { cx: number; cy: number; r: number }): MmPath | null {
	if (typeof element?.getArcCenterRadiusAngles !== 'function') {
		return tessellateCircleMm(fallbackShape.cx, fallbackShape.cy, fallbackShape.r);
	}
	const { centerX, centerY, radius, startAngle, endAngle } = element.getArcCenterRadiusAngles();
	const width = typeof element.getWidth === 'function' ? element.getWidth() : 0.25;
	const centerline = arcCenterlineMm(centerX, centerY, radius, startAngle, endAngle);
	return polylineCapsuleRingMm(centerline, width);
}

/** Reduces an already-built PaintedItem's shape to a copper-outline ring,
 *  world-mm — reuses BoardPainter's own pad/via/track geometry instead of
 *  re-deriving it from the raw @kicad-io element tree. Track arcs are
 *  handled separately by the caller (trackArcRingMm) since a proper arc
 *  ring needs the live element's real sweep angles, not just this
 *  PaintedShape. */
function shapeToRingMm(shape: PaintedShape): MmPath | null {
	switch (shape.type) {
		case 'circle':
			return tessellateCircleMm(shape.cx, shape.cy, shape.r);
		case 'polygon':
			return shape.points;
		case 'rect':
			return [
				{ x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y },
				{ x: shape.x + shape.w, y: shape.y + shape.h }, { x: shape.x, y: shape.y + shape.h },
			];
		case 'segment':
			return polylineCapsuleRingMm([{ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }], shape.width);
	}
}

/**
 * Which PaintedItem kinds are copper-fill obstacles. Includes 'graphic':
 * real KiCad's knockoutGraphicClearance (zone_filler.cpp) excludes copper
 * from underneath EVERY footprint/board graphic item on the fill's layer —
 * not just pads/tracks/vias — covering footprint Reference/Value text,
 * every other footprint graphical item (fp_line/fp_rect/fp_circle/fp_arc/
 * fp_poly — including copper-layer "logo" artwork like a board's OSHW/
 * manufacturer mark baked in as fp_poly, which has no net and would
 * otherwise get silently overfilled), and standalone board Drawings
 * (gr_line/gr_poly/etc.). This is unconditional on net: a copper graphic
 * with no net (net 0) can never be "same net" as any zone (real KiCad
 * forces sameNet=false whenever either side has no net), so it's always an
 * obstacle regardless of the zone's own net — collectExclusionRingsMm's
 * existing same-net skip already encodes this correctly for a graphic that
 * DOES carry a matching net. Deliberately excludes 'footprint' — that's a
 * synthetic whole-footprint hit-test bbox with no real geometry, not an
 * actual copper shape (see BoardPainter.paint's 'footprint' kind comment).
 */
function isObstacleKind(kind: PaintedItem['kind']): boolean {
	return kind === 'pad' || kind === 'via' || kind === 'track' || kind === 'graphic';
}

// ---------------------------------------------------------------------------
// Board outline (Edge.Cuts) assembly
// ---------------------------------------------------------------------------

function pointsClose(a: MmPoint, b: MmPoint, tolerance: number): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

/** Chains open 2+-point polylines (from gr_line/gr_arc Edge.Cuts elements)
 *  into closed loops by matching endpoints within `tolerance` — the same
 *  idea as real KiCad's ConvertOutlineToPolygon (pcbnew/convert_shape_list_
 *  to_polygon.cpp), reimplemented with plain nearest-match search instead
 *  of its nanoflann KD-tree (board outlines are a few dozen segments at
 *  most, not worth the extra dependency for this). A chain that never
 *  closes (a malformed or partial Edge.Cuts drawing) is dropped rather than
 *  fed into the boolean pipeline as garbage geometry. */
function assembleClosedLoops(edges: MmPath[], tolerance = 0.01): MmPath[] {
	const remaining = edges.filter(e => e.length >= 2).map(e => e.slice());
	const loops: MmPath[] = [];

	while (remaining.length > 0) {
		const chain = remaining.shift()!;
		let extended = true;
		while (extended) {
			extended = false;
			const last = chain[chain.length - 1]!;
			if (chain.length > 2 && pointsClose(last, chain[0]!, tolerance)) break;

			for (let i = 0; i < remaining.length; i++) {
				const edge = remaining[i]!;
				const a = edge[0]!, b = edge[edge.length - 1]!;
				if (pointsClose(a, last, tolerance)) {
					chain.push(...edge.slice(1));
					remaining.splice(i, 1);
					extended = true;
					break;
				}
				if (pointsClose(b, last, tolerance)) {
					chain.push(...edge.slice(0, -1).reverse());
					remaining.splice(i, 1);
					extended = true;
					break;
				}
			}
		}

		const last = chain[chain.length - 1]!;
		if (chain.length >= 3 && pointsClose(last, chain[0]!, tolerance)) loops.push(chain);
	}
	return loops;
}

type Transform = (p: MmPoint) => MmPoint;
const identityTransform: Transform = p => p;

/** A footprint's own translate+rotate transform (footprint-local mm ->
 *  world mm) — same construction BoardPainter.buildFootprint uses for pads/
 *  graphics, needed here because a footprint's own Edge.Cuts graphics
 *  (fp_line/fp_circle/fp_arc/fp_poly) are stored in footprint-local
 *  coordinates, not world coordinates. */
function footprintTransform(footprint: any): Transform {
	if (typeof footprint.getOrigin !== 'function') return identityTransform;
	const origin = footprint.getOrigin();
	const matrix = Matrix3.translation(origin.x, origin.y).rotateSelf(Angle.fromDegrees(origin.rotation ?? 0));
	return p => {
		const world = matrix.transform(new Vec2(p.x, p.y));
		return { x: world.x, y: world.y };
	};
}

/** Reads one Edge.Cuts graphic element (board-root gr_* or footprint-local
 *  fp_*, both share the same accessor methods) into closedLoops/openEdges,
 *  applying `transform` to every point (identity for board-root graphics,
 *  the owning footprint's placement for fp_* graphics). */
function collectEdgeCutsFromElement(el: any, transform: Transform, closedLoops: MmPath[], openEdges: MmPath[]): void {
	if (typeof el.getLayer !== 'function' || el.getLayer() !== 'Edge.Cuts') return;

	switch (el.name) {
		case 'gr_line': case 'fp_line': {
			if (typeof el.getStartEnd !== 'function') break;
			const { start, end } = el.getStartEnd();
			openEdges.push([transform({ x: start.x, y: start.y }), transform({ x: end.x, y: end.y })]);
			break;
		}
		case 'gr_rect': case 'fp_rect': {
			if (typeof el.getStartEnd !== 'function') break;
			const { start, end } = el.getStartEnd();
			const corners: MmPath = [
				{ x: start.x, y: start.y }, { x: end.x, y: start.y },
				{ x: end.x, y: end.y }, { x: start.x, y: end.y },
			].map(transform);
			for (let i = 0; i < 4; i++) openEdges.push([corners[i]!, corners[(i + 1) % 4]!]);
			break;
		}
		case 'gr_arc': case 'fp_arc': {
			if (typeof el.getArcCenterRadiusAngles !== 'function') break;
			const { centerX, centerY, radius, startAngle, endAngle } = el.getArcCenterRadiusAngles();
			// Sampling in local space then transforming every point (rather
			// than transforming the center and re-deriving world-space
			// angles, as BoardPainter's renderer-facing path does) is exactly
			// equivalent for a rigid transform and simpler here, since all
			// this needs is points, not a re-parameterized arc.
			openEdges.push(arcCenterlineMm(centerX, centerY, radius, startAngle, endAngle).map(transform));
			break;
		}
		case 'gr_circle': case 'fp_circle': {
			if (typeof el.getCenter !== 'function' || typeof el.getEnd !== 'function') break;
			const center = el.getCenter(), end = el.getEnd();
			const r = Math.hypot(end.x - center.x, end.y - center.y);
			closedLoops.push(tessellateCircleMm(center.x, center.y, r).map(transform));
			break;
		}
		case 'gr_poly': case 'fp_poly': {
			if (typeof el.getPoints !== 'function') break;
			const pts = el.getPoints() as MmPath;
			if (pts.length >= 3) closedLoops.push(pts.map(p => transform({ x: p.x, y: p.y })));
			break;
		}
	}
}

/** Reads Edge.Cuts graphics off the board root AND every footprint (duck-
 *  typed, same untyped-`any` philosophy as the rest of this module and
 *  BoardPainter.ts — see that file's own header comment) into closed-loop
 *  rings (still world-mm) and open polylines still needing chaining.
 *
 * Recursing into footprints matters: board cutouts/keepouts are frequently
 * baked into a footprint's own graphics (a USB/battery/board-to-board
 * connector footprint defining the notch it needs, most commonly) rather
 * than drawn as board-root graphics — confirmed against real KiCad source,
 * not assumed: pcbnew/convert_shape_list_to_polygon.cpp's own
 * BuildBoardPolygonOutlines() explicitly walks per-footprint Edge.Cuts
 * graphics (its `fpSegList`/`fpOutlines`) in addition to board-root ones.
 * Missing this meant a footprint-embedded cutout was invisible to the
 * board-outline assembly entirely — not offset by a winding bug, just
 * absent — which could leave `buildBoardOutlineRegionNm` seeing only a
 * disconnected fragment of the real outline. */
function collectEdgeCutsGeometry(board: any): { closedLoops: MmPath[]; openEdges: MmPath[] } {
	const children: any[] = board?.rootElement?.children ?? [];
	const closedLoops: MmPath[] = [];
	const openEdges: MmPath[] = [];

	for (const el of children) {
		if (el.name === 'footprint') {
			const transform = footprintTransform(el);
			for (const child of (el.children ?? []) as any[]) {
				collectEdgeCutsFromElement(child, transform, closedLoops, openEdges);
			}
			continue;
		}
		collectEdgeCutsFromElement(el, identityTransform, closedLoops, openEdges);
	}
	return { closedLoops, openEdges };
}

/**
 * Assembles the board's physical copper-bearing region from Edge.Cuts —
 * outer perimeter(s) minus any cutouts — as a Clipper2 Paths in integer nm.
 * Returns null when the board carries no Edge.Cuts geometry at all (mirrors
 * real KiCad's own `m_brdOutlinesValid` gate: no outline means don't clip
 * anything, rather than clipping everything away).
 *
 * Nested-loop classification (which loop is a cutout vs. a separate outer
 * island) is resolved by Clipper2 itself via an EvenOdd union, rather than
 * hand-rolled containment logic — alternating fill is exactly "outer minus
 * hole" semantics regardless of each individual loop's own winding
 * direction, which chained line/arc segments don't reliably carry.
 */
export function buildBoardOutlineRegionNm(board: any): Paths | null {
	const { closedLoops, openEdges } = collectEdgeCutsGeometry(board);
	const chained = assembleClosedLoops(openEdges);
	const allLoops = [...closedLoops, ...chained].filter(l => l.length >= 3);
	if (allLoops.length === 0) return null;
	return getClipperEngine().booleanOp(ClipType.Union, FillRule.EvenOdd, allLoops.map(toClipperPath), []);
}

// Real KiCad's own stock default (DEFAULT_COPPEREDGECLEARANCE,
// include/board_design_settings.h) — "clearance between copper items and
// edge cuts". The real value is a per-project DRC-rule/design-setting this
// app doesn't parse yet (see this file's header comment); every caller that
// needs it accepts an override so wiring up the real value later is a
// one-line change here, not a signature change.
const DEFAULT_EDGE_CLEARANCE_MM = 0.5;

export interface KeepoutZoneInput {
	outlinePoints: MmPath;
	layers: readonly string[];
}

/**
 * Board-edge copper clearance + keepout-zone ("rule area") exclusions —
 * both apply uniformly across every zone that fills a given copper layer
 * (neither is zone-specific), so this is computed once per board and shared
 * across every zone-fill job, exactly like buildBoardOutlineRegionNm.
 *
 * Confirmed against real KiCad source, not assumed:
 *  - zone_filler.cpp's knockoutGraphicClearance treats every individual
 *    Edge.Cuts graphic item as its own knockout (not the assembled board
 *    outline as one shape), inflated by the edge-clearance gap — a straight
 *    line becomes a capsule (ignoreLineWidths=true, so purely the gap
 *    radius, not gap+linewidth/2), matching polylineCapsuleRingMm's own
 *    per-track-segment technique reused here.
 *  - zone_filler.cpp's knockoutZoneClearance, for a rule-area knockout with
 *    GetDoNotAllowZoneFills(): "Keepouts use outline with no clearance" —
 *    the keepout's own outline is knocked out verbatim, no inflate.
 */
export function buildEdgeExclusionsByLayer(
	board: any,
	copperLayers: readonly string[],
	keepoutZones: readonly KeepoutZoneInput[] = [],
	edgeClearanceMm = DEFAULT_EDGE_CLEARANCE_MM,
): Map<string, MmPath[]> {
	const { closedLoops, openEdges } = collectEdgeCutsGeometry(board);
	const edgeRingsMm: MmPath[] = [];
	if (edgeClearanceMm > 0) {
		for (const loop of closedLoops) {
			const inflated = getClipperEngine().inflatePaths([toClipperPath(loop)], edgeClearanceMm * NM_PER_MM, JoinType.Round, EndType.Polygon);
			for (const path of inflated) edgeRingsMm.push(fromClipperPath(path));
		}
		for (const edge of openEdges) {
			const ring = polylineCapsuleRingMm(edge, edgeClearanceMm * 2);
			if (ring.length >= 3) edgeRingsMm.push(ring);
		}
	}

	const byLayer = new Map<string, MmPath[]>();
	for (const layer of copperLayers) byLayer.set(layer, edgeRingsMm.slice());

	for (const kz of keepoutZones) {
		if (kz.outlinePoints.length < 3) continue;
		const layers = kz.layers
			.flatMap(layer => layer === '*.Cu' ? copperLayers : [layer])
			.filter(layer => layer.endsWith('.Cu'));
		for (const layer of layers) {
			if (!byLayer.has(layer)) byLayer.set(layer, edgeRingsMm.slice());
			byLayer.get(layer)!.push(kz.outlinePoints);
		}
	}
	return byLayer;
}

/** Resolves a scene's real copper-layer stack (or falls back to filtering
 *  layersPresent) — shared by every entry point that expands a zone's
 *  `*.Cu` wildcard against real layers, so this only lives in one place. */
export function resolveCopperLayers(scene: LayeredBoardScene): string[] {
	return scene.copperLayerStack.length > 0
		? scene.copperLayerStack.slice()
		: scene.layersPresent.filter(l => l.endsWith('.Cu'));
}

// ---------------------------------------------------------------------------
// Core fill pipeline
// ---------------------------------------------------------------------------

/**
 * The pure Clipper2 pipeline for one zone on one layer — every input is
 * plain serializable data (no live scene/element references), so this is
 * safe to run inside a Web Worker (see zone-fill.worker.ts). Everything
 * else in this file exists to gather these plain inputs from a live app
 * session on the main thread.
 */
export function computeFillFromRings(
	outlinePoints: MmPath,
	exclusionRingsMm: MmPath[],
	clearanceMm: number,
	boardOutlineNm?: Paths | null,
	// Already fully-sized exclusion rings (board-edge clearance, keepout
	// zone outlines — see buildEdgeExclusionsByLayer) that must NOT go
	// through the clearanceMm inflate below a second time: that inflate is
	// only for step-3's pad/track/via same-pass electrical clearance.
	extraExclusionRingsMm?: MmPath[],
): Paths /* world-mm point rings — always simple (hole-free) polygons after
	fracture, one per disjoint fill region */ {
	if (outlinePoints.length < 3) return [];

	const engine = getClipperEngine();
	let outlineRingsNm: Paths = [toClipperPath(outlinePoints)];
	if (boardOutlineNm && boardOutlineNm.length > 0) {
		outlineRingsNm = engine.booleanOp(ClipType.Intersection, FillRule.NonZero, outlineRingsNm, boardOutlineNm);
		if (outlineRingsNm.length === 0) return []; // zone doesn't overlap the board at all
	}

	const hasClearanceObstacles = exclusionRingsMm.length > 0;
	const hasExtraExclusions = (extraExclusionRingsMm?.length ?? 0) > 0;

	let fillNm: Paths;
	if (!hasClearanceObstacles && !hasExtraExclusions) {
		// No obstacles — still route the outline through a Union-with-itself
		// so self-intersections in an authored (possibly hand-drawn) outline
		// get the same cleanup real KiCad's fill always applies.
		fillNm = engine.booleanOp(ClipType.Union, FillRule.NonZero, outlineRingsNm, []);
	}
	else {
		const inflatedNm = hasClearanceObstacles
			? engine.inflatePaths(exclusionRingsMm.map(toClipperPath), clearanceMm * NM_PER_MM, JoinType.Round, EndType.Polygon)
			: [];
		const preformedNm = (extraExclusionRingsMm ?? []).map(toClipperPath);
		const unionExclusionsNm = engine.booleanOp(ClipType.Union, FillRule.NonZero, [...inflatedNm, ...preformedNm], []);
		fillNm = engine.booleanOp(ClipType.Difference, FillRule.NonZero, outlineRingsNm, unionExclusionsNm);
	}
	return fractureFillResult(fillNm).map(fromClipperPath);
}

/**
 * Extracts one layer's obstacle geometry as plain exclusion rings (world-mm)
 * from a live scene — the one piece of this pipeline that genuinely needs
 * the live LayeredBoardScene (PaintedItem.shape/element), everything past
 * this point is plain data. Cheap (just reading already-built shapes and
 * light trig, no Clipper2 booleans yet), so there's no benefit to running
 * it off the main thread — see this file's header comment on the
 * main-thread/worker split.
 */
export function collectExclusionRingsMm(scene: LayeredBoardScene, layer: string, zoneNetId: number | null): MmPath[] {
	const bucket = scene.layerBuckets.get(layer) ?? [];
	const exclusionRingsMm: MmPath[] = [];
	for (const item of bucket) {
		if (!isObstacleKind(item.kind)) continue;
		// Same-net copper flows together with the pour — only a DIFFERENT
		// (or absent) net is an obstacle the fill must clear around.
		if (item.netId != null && zoneNetId != null && item.netId === zoneNetId) continue;
		const ring = item.kind === 'track' && item.shape.type === 'circle'
			? trackArcRingMm(item.element, item.shape)
			: shapeToRingMm(item.shape);
		if (ring && ring.length >= 3) exclusionRingsMm.push(ring);
	}
	return exclusionRingsMm;
}

/**
 * Computes one zone's fill region on a single copper layer.
 *
 * `scene` must already have pads/vias/tracks built into its layerBuckets for
 * `layer` (BoardPainter.build() populates these before zones when the
 * caller opts into live fill — see that file's build-order comment) — this
 * function only reads the scene, it never mutates it.
 */
export function computeZoneFillForLayer(
	outlinePoints: MmPath,
	zoneNetId: number | null,
	layer: string,
	scene: LayeredBoardScene,
	clearanceMm: number,
	boardOutlineNm?: Paths | null,
	extraExclusionRingsMm?: MmPath[],
): Paths {
	const exclusionRingsMm = collectExclusionRingsMm(scene, layer, zoneNetId);
	return computeFillFromRings(outlinePoints, exclusionRingsMm, clearanceMm, boardOutlineNm, extraExclusionRingsMm);
}

/** One (zone, layer) unit of work for the Clipper2 pipeline — plain,
 *  structured-clone-safe data, ready to `postMessage` to a Web Worker (see
 *  zone-fill.worker.ts). `zoneUuid` round-trips through so results can be
 *  regrouped back by zone after the worker returns them, since jobs for
 *  different zones/layers can complete in any order. */
export interface ZoneFillJob {
	zoneUuid: string;
	layer: string;
	outlinePoints: MmPath;
	exclusionRingsMm: MmPath[];
	clearanceMm: number;
	boardOutlineNm: Paths | null;
	extraExclusionRingsMm: MmPath[];
}

/**
 * Builds the full, plain-data job list for filling one or more zones —
 * the main-thread-only extraction step (reads the live scene/zone objects)
 * that a caller runs once before handing the jobs to a worker. `zones` only
 * needs the handful of fields actually read here, not a real KicadElementZone
 * instance, so a caller can pass plain objects built from one.
 */
export function buildZoneFillJobs(
	zones: readonly { uuid: string; outlinePoints: MmPath; netId: number | null; layers: readonly string[]; clearanceMm: number }[],
	scene: LayeredBoardScene,
	boardOutlineNm: Paths | null,
	// Board-edge clearance + keepout-zone exclusions, per copper layer — see
	// buildEdgeExclusionsByLayer. Layer-uniform, so a caller computes this
	// once per board and it gets attached to every job for that layer.
	extraExclusionsByLayer?: Map<string, MmPath[]>,
): ZoneFillJob[] {
	const copperLayers = resolveCopperLayers(scene);

	const jobs: ZoneFillJob[] = [];
	for (const zone of zones) {
		if (zone.outlinePoints.length < 3) continue;
		const layers = zone.layers
			.flatMap(layer => layer === '*.Cu' ? copperLayers : [layer])
			.filter(layer => layer.endsWith('.Cu'));
		for (const layer of layers) {
			jobs.push({
				zoneUuid: zone.uuid,
				layer,
				outlinePoints: zone.outlinePoints,
				exclusionRingsMm: collectExclusionRingsMm(scene, layer, zone.netId),
				clearanceMm: zone.clearanceMm,
				boardOutlineNm,
				extraExclusionRingsMm: extraExclusionsByLayer?.get(layer) ?? [],
			});
		}
	}
	return jobs;
}

/** Runs one job's pipeline — the worker's per-message entry point, exported
 *  here so the worker file itself stays a thin postMessage/onmessage shim. */
export function runZoneFillJob(job: ZoneFillJob): { zoneUuid: string; layer: string; points: MmPath }[] {
	const fills = computeFillFromRings(job.outlinePoints, job.exclusionRingsMm, job.clearanceMm, job.boardOutlineNm, job.extraExclusionRingsMm);
	return fills.filter(ring => ring.length >= 3).map(points => ({ zoneUuid: job.zoneUuid, layer: job.layer, points }));
}

// --- Fracture: bridge hole rings into their enclosing outer ring ----------
// See this file's header comment for why this step exists.

function leftmostIndex(ring: Path): number {
	let idx = 0;
	for (let i = 1; i < ring.length; i++) {
		const p = ring[i]!, best = ring[idx]!;
		if (p.x < best.x || (p.x === best.x && p.y < best.y)) idx = i;
	}
	return idx;
}

/** Splices `hole` into `outline` via a keyhole cut: from the hole's
 *  leftmost vertex, cast a ray in -X and bridge to the nearest point on
 *  whichever edge of `outline` it first crosses (which may itself be an
 *  earlier-merged hole's boundary — still valid, since that's now part of
 *  the accumulated simple polygon). */
function bridgeHoleInto(outline: Path, hole: Path): Path {
	const hStart = leftmostIndex(hole);
	const holePt = hole[hStart]!;

	let bestX = -Infinity;
	let bestEdgeIdx = -1;
	let bestPoint: { x: number; y: number } | null = null;
	for (let i = 0; i < outline.length; i++) {
		const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
		const yMin = Math.min(a.y, b.y), yMax = Math.max(a.y, b.y);
		if (holePt.y < yMin || holePt.y > yMax || yMin === yMax) continue;
		const t = (holePt.y - a.y) / (b.y - a.y);
		const x = a.x + t * (b.x - a.x);
		if (x <= holePt.x && x > bestX) {
			bestX = x;
			bestEdgeIdx = i;
			bestPoint = { x, y: holePt.y };
		}
	}
	if (bestEdgeIdx === -1 || !bestPoint) {
		// No visible outline edge found (degenerate geometry) — drop the
		// hole rather than corrupt the outline with a bad splice.
		return outline;
	}

	const holeRing: Path = [];
	for (let i = 0; i < hole.length; i++) holeRing.push(hole[(hStart + i) % hole.length]!);
	holeRing.push(hole[hStart]!); // close back to the start

	const result: Path = [];
	for (let i = 0; i <= bestEdgeIdx; i++) result.push(outline[i]!);
	result.push(bestPoint);
	result.push(...holeRing);
	result.push(bestPoint);
	for (let i = bestEdgeIdx + 1; i < outline.length; i++) result.push(outline[i]!);
	return result;
}

/** Bridges every hole into its own enclosing outer ring, holes processed
 *  leftmost-first (matching SHAPE_POLY_SET::Fracture's own merge order). */
function fractureRegion(outer: Path, holes: Path[]): Path {
	let outline = outer;
	const ordered = holes.slice().sort((a, b) => a[leftmostIndex(a)]!.x - b[leftmostIndex(b)]!.x);
	for (const hole of ordered) outline = bridgeHoleInto(outline, hole);
	return outline;
}

/**
 * Groups a flat Clipper2 result into (outer, its holes) pairs and fractures
 * each into one simple polygon.
 *
 * Classifies "is this ring an outer boundary or a hole" by geometric
 * NESTING DEPTH (how many other rings physically contain a point of it) —
 * even depth = outer, odd depth = hole — rather than trusting each ring's
 * own Area() sign. Clipper2's own boolean-op output does consistently sign
 * outer/hole rings (confirmed by this file's own engine tests), but nesting
 * parity is the more fundamental, sign-independent definition of a
 * polygon-with-holes (the same definition a canonical outline+holes
 * representation like KiCad's own SHAPE_POLY_SET uses internally) — this
 * stays correct even where a chain of Boolean ops (outline ∩ boardOutline,
 * then ∖ exclusions) might not preserve a simple "positive area = outer"
 * read on every intermediate ring. */
function fractureFillResult(rings: Paths): Paths {
	if (rings.length <= 1) return rings;

	const depth = rings.map((ring, i) => {
		const testPt = ring[0]!;
		let d = 0;
		for (let j = 0; j < rings.length; j++) {
			if (j !== i && PointInPolygon(testPt, rings[j]!) !== PointInPolygonResult.IsOutside) d++;
		}
		return d;
	});

	const outerIndices = rings.map((_, i) => i).filter(i => depth[i]! % 2 === 0);
	const holeIndices = rings.map((_, i) => i).filter(i => depth[i]! % 2 === 1);

	const holesByOuter = new Map<number, Path[]>();
	for (const holeIdx of holeIndices) {
		// Owner = the containing outer ring with the greatest depth (the
		// immediate enclosing outer, not some further-out ancestor).
		let ownerIdx = -1, ownerDepth = -1;
		for (const outerIdx of outerIndices) {
			if (depth[outerIdx]! < depth[holeIdx]!
				&& PointInPolygon(rings[holeIdx]![0]!, rings[outerIdx]!) !== PointInPolygonResult.IsOutside
				&& depth[outerIdx]! > ownerDepth) {
				ownerDepth = depth[outerIdx]!;
				ownerIdx = outerIdx;
			}
		}
		if (ownerIdx === -1) continue; // orphaned hole (shouldn't happen) — drop
		if (!holesByOuter.has(ownerIdx)) holesByOuter.set(ownerIdx, []);
		holesByOuter.get(ownerIdx)!.push(rings[holeIdx]!);
	}
	return outerIndices.map(i => fractureRegion(rings[i]!, holesByOuter.get(i) ?? []));
}

/**
 * Computes fill regions for every copper layer a zone actually pours onto
 * (expanding `*.Cu` against the board's real copper stack, same expansion
 * BoardPainter.buildZoneFills already does for the outline-only ratsnest
 * region) — ready to hand straight to KicadElementZone.setFilledPolygons().
 *
 * `boardOutlineNm`, when given, clips every layer's fill to the board's
 * Edge.Cuts outline — pass the result of a SINGLE `buildBoardOutlineRegionNm`
 * call shared across every zone being filled (the board shape doesn't vary
 * per zone or per layer, so recomputing it inside this function per call
 * would just redo the same Edge.Cuts assembly once per zone for no reason).
 */
export function computeZoneFill(
	outlinePoints: MmPath,
	zoneNetId: number | null,
	requestedLayers: readonly string[],
	scene: LayeredBoardScene,
	clearanceMm: number,
	boardOutlineNm?: Paths | null,
	extraExclusionRingsMm?: MmPath[],
): { layer: string; points: MmPath }[] {
	const copperLayers = resolveCopperLayers(scene);
	const layers = requestedLayers
		.flatMap(layer => layer === '*.Cu' ? copperLayers : [layer])
		.filter(layer => layer.endsWith('.Cu'));

	const result: { layer: string; points: MmPath }[] = [];
	for (const layer of layers) {
		for (const ring of computeZoneFillForLayer(outlinePoints, zoneNetId, layer, scene, clearanceMm, boardOutlineNm, extraExclusionRingsMm)) {
			if (ring.length >= 3) result.push({ layer, points: ring });
		}
	}
	return result;
}
