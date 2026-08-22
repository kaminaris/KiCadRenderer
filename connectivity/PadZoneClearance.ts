/*
 * Ported from KiCad source:
 *   pcbnew/pad.cpp / pcbnew/via.h (clearance-to-zone) — distance helpers
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Pad/via-to-zone clearance helpers: the minimum clearance (distance) between
 * a pad or via's effective copper shape and a zone's filled polygon outline,
 * and a pad's-vs-zone connection clearance resolved via PadClearances. These
 * feed DRC and fan-out checks. Dimensions in mm.
 */

import { SHAPE } from '../geometry/Shape';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SEG } from '../geometry/Seg';
import { Vec2 } from '../math/Vec2';
import { PAD_CLEARANCES, effectiveZoneConnection } from './PadClearances';
import { ZONE_CONNECTION } from './PadClearances';

/**
 * The minimum distance between a pad/via's copper shape and a zone outline.
 * Mirrors PAD/PCB_VIA's clearance-to-zone distance (a shape-to-polyset
 * distance, using the zone's boundary).
 */
export function padToZoneClearance(aPadShape: SHAPE, aZone: SHAPE_POLY_SET): number {
	// For a circle/segment pad, use the shape center-to-zone distance minus the
	// shape radius for a conservative result.
	const center = aPadShape.GetCentre();
	let d = aZone.Distance(center);
	// Subtract an extent estimate so the result is edge-to-edge.
	d -= shapeExtentRadius(aPadShape);
	return Math.max(0, d);
}

/**
 * The minimum distance from a pad or via (center) to a zone outline.
 */
export function viaToZoneClearance(aViaCenter: Vec2, aViaRadius: number, aZone: SHAPE_POLY_SET): number {
	const d = aZone.Distance(aViaCenter);
	return Math.max(0, d - aViaRadius);
}

/**
 * Whether a pad (by its connection mode) connects to a zone at all.
 * Mirrors ZONE_FILLER: FULL + THERMAL connect; NONE does not.
 */
export function padConnectsToZone(aClearances: PAD_CLEARANCES, aIsThruHole: boolean): boolean {
	const mode = effectiveZoneConnection(aClearances, aIsThruHole);
	return mode !== ZONE_CONNECTION.NONE;
}

/** The distance from a line segment to a zone outline (centerline). */
export function segmentToZoneClearance(aSeg: SEG, aZone: SHAPE_POLY_SET): number {
	return aZone.DistanceToSegment(aSeg);
}

function shapeExtentRadius(aShape: SHAPE): number {
	const b = aShape.BBox();
	return Math.max(b.w, b.h) / 2;
}

/**
 * The minimum distance from a track to a via's drill hole (annular clearance),
 * mirroring DRC "track via hole clearance". `aSeg` is the track centerline,
 * `aDrill` the via hole diameter.
 */
export function trackToViaDrillClearance(
	aSeg: SEG,
	aDrillRadius: number,
	aViaCenter: { x: number; y: number }
): number {
	// distance from via center to the segment, minus the drill radius.
	const d = segmentPointDistance(aSeg, aViaCenter);
	return Math.max(0, d - aDrillRadius);
}

function segmentPointDistance(aSeg: SEG, p: { x: number; y: number }): number {
	const ax = aSeg.A.x, ay = aSeg.A.y, bx = aSeg.B.x, by = aSeg.B.y;
	const dx = bx - ax, dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let t = 0;
	if (lenSq > 1e-12) {
		t = ((p.x - ax) * dx + (p.y - ay) * dy) / lenSq;
		t = Math.max(0, Math.min(1, t));
	}
	const px = ax + t * dx, py = ay + t * dy;
	return Math.hypot(p.x - px, p.y - py);
}
