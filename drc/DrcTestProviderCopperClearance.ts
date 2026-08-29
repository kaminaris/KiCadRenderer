/*
 * DRC_TEST_PROVIDER_COPPER_CLEARANCE — scoped port of pcbnew/drc/
 * drc_test_provider_copper_clearance.cpp's `testTrackClearances()` +
 * `testSingleLayerItemAgainstItem()` (trace/via clearance),
 * `testPadClearances()` + `testPadAgainstItem()` (pad-vs-pad clearance
 * only — real KiCad's own `testPadAgainstItem()` explicitly excludes
 * track/arc/via/shape/textbox targets, deferring those to the other
 * providers), `testGraphicClearances()`'s `testCopperGraphic` half
 * (copper-graphic-vs-{pad,other-graphic} clearance), and a scoped
 * `testItemAgainstZone()` (copper-item-vs-zone-fill clearance, using the
 * already-computed zone fill polygons in `LayeredBoardScene.zoneFills` —
 * see `testItemAgainstZones()`'s own doc comment for its scope cuts),
 * confirmed against the real source at apps/kicad/pcbnew/drc/
 * drc_test_provider_copper_clearance.cpp (1424 lines total — see file end
 * for what's still missing). This is the first real DRC
 * violation-producing check in the app — "trace/pad/copper-graphic too
 * close to another trace/pad/via/graphic" — built on `DrcRtree` (spatial
 * index) and `DrcEngine` (constraint resolution), both already-ported
 * prerequisites.
 *
 * Real KiCad's shared `m_CopperItemRTreeCache` holds tracks/vias/pads AND
 * copper graphics together, so `testTrackClearances()`'s own item-vs-item
 * test already checks a track against a copper graphic through that
 * shared tree (it isn't graphic-exclusive) — this port's `COPPER_KINDS`
 * includes `'graphic'` for the same reason, so `testTrackClearances()`
 * gets that same coverage for free; `testGraphicClearances()` below only
 * needs the reverse direction (graphic vs pad/other-graphics).
 *
 * Deliberately scoped down from the real provider, each noted at point
 * of use:
 * - `testZonesToZones()` (zone-vs-zone) and `testTeardropClearances()`
 *   are NOT ported. `testKnockoutTextAgainstZone()`'s shorting-detection
 *   half of `testItemAgainstZone()` also isn't — see
 *   `testItemAgainstZones()`'s own doc comment for the rest of that
 *   function's scope cuts.
 * - Footprint fields (`PCB_FIELD_T` — reference/value text placed on a
 *   copper layer) aren't tested — only `PCB_SHAPE_T`/`PCB_BARCODE_T`-
 *   equivalent painted `'graphic'` items are.
 * - The same-footprint compound-shape exclusion (`testCopperGraphic`'s
 *   own "graphics are often compound shapes so ignore collisions between
 *   shapes in a single footprint" filter) isn't ported — same
 *   footprint-id-tracking limitation as the pad exemption below.
 * - Hole clearance (both functions' `testHoles` blocks) isn't ported.
 * - The track:track crossing special case (`DRCE_TRACKS_CROSSING`,
 *   same-net tracks whose centerlines cross) isn't ported.
 * - Free-pad (unconnected-pad-in-footprint) same-net exemption tracking
 *   (`freePadsUsageMap`) isn't ported — a free pad is treated like any
 *   other pad.
 * - `SameLogicalPadAs()`/net-tie-group exemptions (`testPadAgainstItem()`'s
 *   own same-footprint pad-number/net-tie-group waivers) aren't ported —
 *   `PaintedItem` doesn't surface a pad-number/footprint-id a caller could
 *   match on. The same-net skip below already covers the overwhelmingly
 *   common case (two pads of one component sharing a net don't need
 *   clearance checking); only the rarer multi-physical-pad-same-number
 *   case (e.g. an SOT-223 tab pad) is affected.
 * - Net-tie exclusion (`IsNetTieExclusion()`) isn't ported — no net-tie
 *   concept exists in this port yet.
 * - `actual` (the measured clearance distance, used in the violation
 *   message "clearance 0.2mm; actual 0.05mm") isn't computed — only
 *   collision (yes/no) + a location, since `SHAPE_COLLISION`'s ported
 *   `Collide()` doesn't return a distance value (see `ShapeCollision.ts`'s
 *   own `CollisionResult` shape).
 * - Real KiCad's thread-pool parallelism/progress reporting/cancellation
 *   aren't applicable to this port.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */
import type { LayeredBoardScene, PaintedItem, ZoneFillRegion } from '../paint/BoardPainter';
import type { DrcEngine } from '@kicad-model/src/pcb/drc/DrcEngine';
import { DrcRtree } from './DrcRtree';
import { SHAPE } from '../geometry/Shape';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SHAPE_LINE_CHAIN } from '../geometry/ShapeLineChain';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { Vec2 } from '../math/Vec2';
import { SHAPE_COLLISION } from '../geometry/ShapeCollision';

export interface CopperClearanceViolation {
	/** Port of `DRCE_CLEARANCE` — the pair that's too close. */
	itemA: PaintedItem;
	itemB: PaintedItem;
	layer: string;
	/** Required clearance, mm. */
	clearance: number;
	/** Approximate collision location, mm (see file header — not the exact
	 *  nearest-point real KiCad's `actual`/`pos` pair would give). */
	location: Vec2;
}

/** Port of `BoardAdapter.toShape()`'s switch, duplicated here narrowly
 *  rather than depending on the whole `CN_ITEM_PARENT`-implementing
 *  `BoardAdapter` class (this provider only needs the shape). */
function toShape(item: PaintedItem): SHAPE {
	const s = item.shape;
	switch (s.type) {
		case 'rect':
			return new SHAPE_RECT(new Vec2(s.x, s.y), new Vec2(s.w, s.h));
		case 'circle':
			return new SHAPE_CIRCLE(new Vec2(s.cx, s.cy), s.r);
		case 'segment':
			return new SHAPE_SEGMENT(new Vec2(s.x1, s.y1), new Vec2(s.x2, s.y2), s.width);
		case 'polygon':
		default: {
			if (s.type === 'polygon' && s.points.length > 0) {
				const ps = new SHAPE_POLY_SET();
				ps.AddOutline(new SHAPE_LINE_CHAIN(s.points.map(p => new Vec2(p.x, p.y)), true));
				return ps;
			}
			return new SHAPE_RECT(new Vec2(0, 0), new Vec2(0, 0));
		}
	}
}

// Real KiCad's shared `m_CopperItemRTreeCache` holds tracks/vias/pads AND
// copper graphics (PCB_SHAPE_T/PCB_BARCODE_T on a copper layer) together —
// `testTrackClearances()`'s own item-vs-item test isn't graphic-exclusive,
// so a track DOES get checked against a copper graphic through the shared
// tree; `testGraphicClearances()` then only needs the reverse direction
// (graphic vs pad/other-graphics), excluding track/via since those pairs
// were already covered from the track side.
const COPPER_KINDS = new Set<PaintedItem['kind']>(['track', 'via', 'pad', 'graphic']);

function isCopperGraphic(item: PaintedItem): boolean {
	return item.kind === 'graphic' && item.layer.endsWith('.Cu');
}

/** Builds one `DrcRtree` per copper layer from every copper-kind painted
 *  item present on it. Shared by both providers below. */
function buildLayerTrees(scene: LayeredBoardScene): Map<string, DrcRtree<PaintedItem>> {
	const trees = new Map<string, DrcRtree<PaintedItem>>();
	for (const layer of scene.copperLayerStack) {
		const tree = new DrcRtree<PaintedItem>();
		for (const item of scene.layerBuckets.get(layer) ?? []) {
			if (!COPPER_KINDS.has(item.kind)) continue;
			tree.insert(item, 0, toShape(item));
		}
		trees.set(layer, tree);
	}
	return trees;
}

/**
 * Shared clearance/collision core for `testSingleLayerItemAgainstItem()`
 * and `testPadAgainstItem()` — real KiCad keeps these as two separate
 * (near-identical) functions because each has its own extra exemption
 * logic (see file header); this port shares the common collide-and-report
 * path since neither ported subset actually diverges from it.
 *
 * The dynamic per-pair clearance this needs (from `DrcEngine`,
 * net-dependent) doesn't fit `DrcRtree.queryColliding()`'s fixed-clearance
 * contract (real KiCad's own version splits this the same way — a
 * broad-phase bbox widen by `m_DRCMaxClearance`, then an exact per-pair
 * `EvalRules()` call inside the visitor — but this port's simpler
 * `DrcRtree` doesn't expose that split), so callers walk each layer's
 * indexed items directly (via `DrcRtree.onLayer()`, itself
 * `SHAPE_INDEX_LIST`-backed) instead of calling `queryColliding()`.
 */
function checkPair(
	item: PaintedItem, shape: SHAPE, other: PaintedItem, otherShape: SHAPE, layer: string,
	engine: DrcEngine, reported: Set<string>, violations: CopperClearanceViolation[]
): void {
	if (other === item) return;

	// Same net: no clearance required between electrically-tied copper.
	if (other.netId != null && other.netId === item.netId) return;

	// UUID/id-ordered dedup so an (item, other) / (other, item) pair isn't
	// reported twice (real KiCad: `item->m_Uuid > other->m_Uuid`).
	const pairKey = item.id < other.id ? `${ item.id }|${ other.id }` : `${ other.id }|${ item.id }`;
	if (reported.has(pairKey)) return;

	const clearanceIU = engine.netclassClearance(item.netId ?? -1, other.netId ?? -1);
	if (clearanceIU <= 0) return;

	const clearanceMm = clearanceIU / 1e6; // pcbIuScale: 1mm = 1e6 IU

	const collider = new SHAPE_COLLISION(clearanceMm, 0, true);
	const result = collider.Collide(shape, otherShape);

	if (result.intersecting) {
		reported.add(pairKey);
		violations.push({ itemA: item, itemB: other, layer, clearance: clearanceMm, location: result.location });
	}
}

/**
 * Port of `testTrackClearances()` (see file header for scope). For every
 * track/via, checks clearance against every different-net copper item on
 * the same layer.
 */
export function testTrackClearances(scene: LayeredBoardScene, engine: DrcEngine): CopperClearanceViolation[] {
	const violations: CopperClearanceViolation[] = [];
	const trees = buildLayerTrees(scene);
	const reported = new Set<string>();

	for (const layer of scene.copperLayerStack) {
		const entries = trees.get(layer)?.onLayer(0);
		if (!entries) continue;

		for (const item of scene.layerBuckets.get(layer) ?? []) {
			if (item.kind !== 'track' && item.kind !== 'via') continue;

			const shape = toShape(item);
			for (const entry of entries) {
				checkPair(item, shape, entry.parent, entry.shape, layer, engine, reported, violations);
			}
		}
	}

	return violations;
}

/**
 * Port of `testPadClearances()` (see file header for scope — pad-vs-pad
 * only; real KiCad's own `testPadAgainstItem()` defers track/via/graphic
 * targets to the other providers, so this excludes them the same way).
 */
export function testPadClearances(scene: LayeredBoardScene, engine: DrcEngine): CopperClearanceViolation[] {
	const violations: CopperClearanceViolation[] = [];
	const trees = buildLayerTrees(scene);
	const reported = new Set<string>();

	for (const layer of scene.copperLayerStack) {
		const entries = trees.get(layer)?.onLayer(0)?.filter(e => e.parent.kind === 'pad');
		if (!entries) continue;

		for (const item of scene.layerBuckets.get(layer) ?? []) {
			if (item.kind !== 'pad') continue;

			const shape = toShape(item);
			for (const entry of entries) {
				checkPair(item, shape, entry.parent, entry.shape, layer, engine, reported, violations);
			}
		}
	}

	return violations;
}

/**
 * Port of `testGraphicClearances()`'s `testCopperGraphic` half only (see
 * file header — the `testGraphicAgainstZone` half needs zones, not
 * ported). For every copper-layer graphic shape, checks clearance against
 * pads and other copper graphics on the same layer — track/via targets
 * are excluded since `testTrackClearances()` already covers that
 * direction through the shared per-layer tree.
 */
export function testGraphicClearances(scene: LayeredBoardScene, engine: DrcEngine): CopperClearanceViolation[] {
	const violations: CopperClearanceViolation[] = [];
	const trees = buildLayerTrees(scene);
	const reported = new Set<string>();

	for (const layer of scene.copperLayerStack) {
		const entries = trees.get(layer)?.onLayer(0)
			?.filter(e => e.parent.kind === 'pad' || isCopperGraphic(e.parent));
		if (!entries) continue;

		for (const item of scene.layerBuckets.get(layer) ?? []) {
			if (!isCopperGraphic(item)) continue;

			const shape = toShape(item);
			for (const entry of entries) {
				checkPair(item, shape, entry.parent, entry.shape, layer, engine, reported, violations);
			}
		}
	}

	return violations;
}

export interface ZoneClearanceViolation {
	/** Port of `DRCE_CLEARANCE` between a copper item and a zone pour. */
	item: PaintedItem;
	/** The zone fill's net, if any (real KiCad: `ZONE::GetNetCode()`). */
	zoneNetId: number | null;
	layer: string;
	/** Required clearance, mm. */
	clearance: number;
	/** Approximate collision location, mm (see file header — not the exact
	 *  nearest-point real KiCad's `actual`/`pos` pair would give). */
	location: Vec2;
}

/** Builds one `SHAPE_POLY_SET` per `ZoneFillRegion` (a zone's already-
 *  computed filled-copper polygon — see `BoardZoneFill.ts`'s own real
 *  clipping pipeline, which is what produces `points` — this provider
 *  only needs to turn that into a collidable shape, not recompute a fill). */
function zoneShape(region: ZoneFillRegion): SHAPE_POLY_SET {
	const ps = new SHAPE_POLY_SET();
	ps.AddOutline(new SHAPE_LINE_CHAIN(region.points.map(p => new Vec2(p.x, p.y)), true));
	return ps;
}

/**
 * Scoped port of `testItemAgainstZone()` (drc_test_provider_copper_
 * clearance.cpp, line 366) — for every copper item on a layer with a
 * zone fill, checks clearance against that zone's already-filled
 * polygon (`LayeredBoardScene.zoneFills`, one entry per electrically-
 * continuous filled island — see `ZoneFillRegion`'s own doc comment).
 *
 * Deliberately scoped down from the real function, each noted here since
 * this provider isn't part of the shared `checkPair()`/`CopperClearanceViolation`
 * path (a zone fill region has no stable id/uuid to key a `PaintedItem`-
 * shaped violation on):
 * - Net-tie pad exclusion (`allowedNetTiePads`) isn't ported — no net-tie
 *   concept exists in this port yet.
 * - Knockout-text-vs-multiple-zones shorting detection
 *   (`testKnockoutTextAgainstZone()`) isn't ported.
 * - Hole clearance (the `testHoles` block) isn't ported.
 * - The `PAD_ATTRIB::PTH`-plated-hole flashed-pad exception isn't
 *   ported — a pad not flashed on this layer is skipped entirely rather
 *   than still being tested for hole-to-zone clearance.
 * - No per-zone spatial rtree (`m_CopperZoneRTreeCache`) — a flat
 *   per-region `SHAPE_POLY_SET` collision test is used instead, which is
 *   fine at the "handful of fill regions per layer" scale this app
 *   operates at but wouldn't scale to real KiCad's own zone-heavy boards
 *   without one.
 */
export function testItemAgainstZones(scene: LayeredBoardScene, engine: DrcEngine): ZoneClearanceViolation[] {
	const violations: ZoneClearanceViolation[] = [];

	const zonesByLayer = new Map<string, ZoneFillRegion[]>();
	for (const region of scene.zoneFills) {
		let list = zonesByLayer.get(region.layer);
		if (!list) zonesByLayer.set(region.layer, list = []);
		list.push(region);
	}

	for (const layer of scene.copperLayerStack) {
		const regions = zonesByLayer.get(layer);
		if (!regions || regions.length === 0) continue;

		const regionShapes = regions.map(region => ({ region, shape: zoneShape(region) }));

		for (const item of scene.layerBuckets.get(layer) ?? []) {
			if (!COPPER_KINDS.has(item.kind)) continue;

			const itemShape = toShape(item);

			for (const { region, shape } of regionShapes) {
				if (region.netId != null && item.netId != null && region.netId === item.netId) continue;

				const clearanceIU = engine.netclassClearance(item.netId ?? -1, region.netId ?? -1);
				if (clearanceIU <= 0) continue;

				const clearanceMm = clearanceIU / 1e6; // pcbIuScale: 1mm = 1e6 IU
				const collider = new SHAPE_COLLISION(clearanceMm, 0, true);
				const result = collider.Collide(itemShape, shape);

				if (result.intersecting) {
					violations.push({ item, zoneNetId: region.netId, layer, clearance: clearanceMm, location: result.location });
				}
			}
		}
	}

	return violations;
}
