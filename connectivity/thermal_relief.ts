/*
 * Ported from KiCad source:
 *   pcbnew/zone_filler.cpp (AddThermalReliefPadPolygon / thermal relief spokes)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Generates the thermal-relief copper spokes that connect a pad to a zone
 * fill. For a pad of radius R with a thermal gap `gap`, the pad is surrounded
 * by a gap ring at radius (R + gap), and `count` (default 4) rectangular
 * spokes at the cardinal directions bridge the pad to the fill. Dimensions in
 * mm.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SHAPE_LINE_CHAIN } from '../geometry/ShapeLineChain';

/**
 * Builds a circle (as a polygon ring) used for the pad's thermal shape.
 */
function circleRing(center: Vec2, r: number, segments = 48): Vec2[] {
	const pts: Vec2[] = [];
	for (let i = 0; i < segments; i++) {
		const a = (i / segments) * Math.PI * 2;
		pts.push(new Vec2(center.x + r * Math.cos(a), center.y + r * Math.sin(a)));
	}
	return pts;
}

/**
 * Returns the 4 (or `count`) thermal-relief spoke polygons for a round pad at
 * `aCenter` of radius `aRadius`, thermal gap `aGap`, spoke width `aSpokeWidth`.
 * Mirrors the effect of KiCad's AddThermalReliefPadPolygon (round pad).
 */
export function BuildThermalReliefSpokes(
	aCenter: Vec2,
	aRadius: number,
	aGap: number,
	aSpokeWidth: number,
	aCount = 4
): SHAPE_POLY_SET {
	const poly = new SHAPE_POLY_SET();
	if (aCount < 1) {
		return poly;
	}

	// The gap ring radius (KiCad bridges from the pad edge through the gap to
	// the fill; the spokes span from the pad radius to radius+gap).
	const outerR = aRadius + aGap;
	const innerR = aRadius;
	const spokeLen = outerR - innerR;
	const halfW = aSpokeWidth / 2;

	for (let i = 0; i < aCount; i++) {
		const ang = (i / aCount) * Math.PI * 2;
		const dx = Math.cos(ang);
		const dy = Math.sin(ang);

		// Spoke is a rectangle from innerR to outerR along the radial
		// direction, centered on the ray, width = aSpokeWidth.
		const perpX = -dy;
		const perpY = dx;

		const rings: Vec2[] = [];
		const c1 = new Vec2(
			aCenter.x + (innerR + spokeLen) * dx + perpX * halfW,
			aCenter.y + (innerR + spokeLen) * dy + perpY * halfW
		);
		const c2 = new Vec2(
			aCenter.x + (innerR + spokeLen) * dx - perpX * halfW,
			aCenter.y + (innerR + spokeLen) * dy - perpY * halfW
		);
		const c3 = new Vec2(
			aCenter.x + innerR * dx - perpX * halfW,
			aCenter.y + innerR * dy - perpY * halfW
		);
		const c4 = new Vec2(
			aCenter.x + innerR * dx + perpX * halfW,
			aCenter.y + innerR * dy + perpY * halfW
		);
		rings.push(c1, c2, c3, c4);
		poly.AddOutline(new SHAPE_LINE_CHAIN(rings, true));
	}

	return poly;
}

/**
 * The pad's own "hole" in the gap ring for a round pad: a circle at radius
 * R+gap used as the relief (knockout) polygon, returned as a SHAPE_RECT-based
 * bounding square for simple consumers; the relief ring itself is a circle
 * polygon.
 */
export function BuildThermalReliefRing(
	aCenter: Vec2,
	aRadius: number,
	aGap: number,
	aSegments = 48
): SHAPE_POLY_SET {
	const poly = new SHAPE_POLY_SET();
	const r = aRadius + aGap;
	poly.AddOutline(new SHAPE_LINE_CHAIN(circleRing(aCenter, r, aSegments), true));
	return poly;
}

/** A `SHAPE_RECT` square around the pad+gap used for thermal knockout bbox. */
export function ThermalReliefBBox(aCenter: Vec2, aRadius: number, aGap: number): SHAPE_RECT {
	const r = aRadius + aGap;
	return new SHAPE_RECT(new Vec2(aCenter.x - r, aCenter.y - r), new Vec2(r * 2, r * 2));
}

/**
 * Builds the full thermal-relief geometry for a round/oval/rect pad:
 * a SHAPE_POLY_SET containing the relief spokes (the copper connections) for
 * a ZONE_CONNECTION.THERMAL pad. Mirrors the canonical
 * ZONE_FILLER::AddThermalReliefPadPolygon for the round case.
 */
export function buildThermalReliefForRoundPad(
	aCenter: Vec2,
	aRadius: number,
	aGap: number,
	aSpokeWidth: number,
	aSpokeCount = 4
): SHAPE_POLY_SET {
	return BuildThermalReliefSpokes(aCenter, aRadius, aGap, aSpokeWidth, aSpokeCount);
}
