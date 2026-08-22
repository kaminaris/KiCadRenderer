/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_collision.h
 *   libs/kimath/src/geometry/shape_collision.cpp
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A single function object that computes collision (intersection) between two
 * SHAPE primitives, optionally including a clearance. Mirrors KiCad's
 * SHAPE_COLLISION (the engine behind BOARD_ITEM::Collide()).
 *
 * Coordinates are in mm (matching the rest of the geometry module).
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SHAPE, setShapeCollisionCtor } from './Shape';
import { SHAPE_TYPE } from './Shape';
import { SHAPE_SEGMENT } from './ShapeSegment';
import { SHAPE_RECT } from './ShapeRect';
import { SHAPE_CIRCLE } from './ShapeCircle';
import { SHAPE_ARC } from './ShapeArc';
import { SHAPE_LINE_CHAIN, pointToSegmentDistance, closestPointOnSegment } from './ShapeLineChain';
import { SHAPE_POLY_SET } from './ShapePolySet';

export interface CollisionResult {
	intersecting: boolean;
	location: Vec2;
	trackVerificationDone: boolean;
}

/**
 * Computes whether `aShapeA` and `aShapeB` collide within `aClearance`, and
 * where. Mirrors KiCad's SHAPE_COLLISION::Collide().
 */
export class SHAPE_COLLISION {
	constructor(
		private aClearance: number,
		private aAccuracy: number = 0,
		private aNeedLocation: boolean = false
	) {}

	Collide(aShapeA: SHAPE, aShapeB: SHAPE): CollisionResult {
		const result: CollisionResult = {
			intersecting: false,
			location: new Vec2(),
			trackVerificationDone: false,
		};

		const ta = aShapeA.Type();
		const tb = aShapeB.Type();

		// BBox broad-phase. If the boxes (grown by clearance/accuracy) don't
		// overlap there cannot be a collision.
		const ba = aShapeA.BBox(this.aClearance + this.aAccuracy);
		const bb = aShapeB.BBox(this.aClearance + this.aAccuracy);

		if (!bBoxIntersects(ba, bb)) {
			return result;
		}

		// SEGMENT-SEGMENT
		if (ta === SHAPE_TYPE.SEGMENT && tb === SHAPE_TYPE.SEGMENT) {
			return this.collideSegmentSegment(aShapeA as SHAPE_SEGMENT, aShapeB as SHAPE_SEGMENT, result);
		}

		// SEGMENT-SHAPE (rect/circle/line) and symmetric
		if (ta === SHAPE_TYPE.SEGMENT) {
			return this.collideShapeWithSegment(aShapeB, aShapeA as SHAPE_SEGMENT, result);
		}

		if (tb === SHAPE_TYPE.SEGMENT) {
			return this.collideShapeWithSegment(aShapeA, aShapeB as SHAPE_SEGMENT, result);
		}

		// Both circles
		if (ta === SHAPE_TYPE.CIRCLE && tb === SHAPE_TYPE.CIRCLE) {
			const c1 = aShapeA as SHAPE_CIRCLE;
			const c2 = aShapeB as SHAPE_CIRCLE;
			const d = c1.GetCenter().sub(c2.GetCenter()).magnitude;
			if (d <= c1.GetRadius() + c2.GetRadius() + this.aClearance) {
				result.intersecting = true;
				if (this.aNeedLocation) {
					result.location = c1.GetCenter().add(c2.GetCenter()).multiply(0.5);
				}
			}
			return result;
		}

		// Circle vs rect (and symmetric) — via/round pad over a rect pad/zone.
		if (ta === SHAPE_TYPE.CIRCLE && tb === SHAPE_TYPE.RECT) {
			return this.collideCircleRect(aShapeA as SHAPE_CIRCLE, aShapeB as SHAPE_RECT, result);
		}
		if (ta === SHAPE_TYPE.RECT && tb === SHAPE_TYPE.CIRCLE) {
			return this.collideCircleRect(aShapeB as SHAPE_CIRCLE, aShapeA as SHAPE_RECT, result);
		}

		// Rect vs rect.
		if (ta === SHAPE_TYPE.RECT && tb === SHAPE_TYPE.RECT) {
			return this.collideRectRect(aShapeA as SHAPE_RECT, aShapeB as SHAPE_RECT, result);
		}

		// Primitives vs poly set: test every polygon outline segment.
		if (ta === SHAPE_TYPE.POLY_SET || tb === SHAPE_TYPE.POLY_SET) {
			return this.collideWithPolySet(
				ta === SHAPE_TYPE.POLY_SET ? (aShapeA as SHAPE_POLY_SET) : (aShapeB as SHAPE_POLY_SET),
				ta === SHAPE_TYPE.POLY_SET ? aShapeB : aShapeA,
				result
			);
		}

		// Fall back to a distance-based test using the two shapes' Distance().
		// (For point containment this is enough; for odd pairs it is a
		// conservative estimate.)
		const clearance = this.aClearance + this.aAccuracy;
		if (this.shapeDistance(aShapeA, aShapeB) <= clearance) {
			result.intersecting = true;
			if (this.aNeedLocation) {
				const ca = aShapeA.GetCentre();
				const cb = aShapeB.GetCentre();
				result.location = ca.add(cb).multiply(0.5);
			}
		}

		return result;
	}

	private collideSegmentSegment(a: SHAPE_SEGMENT, b: SHAPE_SEGMENT, result: CollisionResult): CollisionResult {
		const d = segmentSegmentDistance(a.GetSeg().A, a.GetSeg().B, b.GetSeg().A, b.GetSeg().B);
		// (wA + wB)/2 + clearance
		const threshold = (a.GetWidth() + b.GetWidth()) / 2 + this.aClearance;
		if (d <= threshold) {
			result.intersecting = true;
			if (this.aNeedLocation) {
				result.location = closestPointOnSegment(
					closestPointOnSegment(b.GetSeg().A, a.GetSeg().A, a.GetSeg().B),
					a.GetSeg().A,
					a.GetSeg().B
				);
			}
		}
		return result;
	}

	private collideShapeWithSegment(shape: SHAPE, seg: SHAPE_SEGMENT, result: CollisionResult): CollisionResult {
		const threshold = seg.GetWidth() / 2 + this.aClearance;

		if (shape.Type() === SHAPE_TYPE.CIRCLE) {
			const c = shape as SHAPE_CIRCLE;
			const d = pointToSegmentDistance(c.GetCenter(), seg.GetSeg().A, seg.GetSeg().B);
			if (d <= c.GetRadius() + threshold) {
				result.intersecting = true;
				if (this.aNeedLocation) {
					result.location = seg.NearestPoint(c.GetCenter());
				}
			}
			return result;
		}

		if (shape.Type() === SHAPE_TYPE.RECT) {
			const rect = shape as SHAPE_RECT;
			// Distance from rect (max(0,dx),max(0,dy)) to the segment.
			const d = rectDistanceToSegment(rect, seg.GetSeg().A, seg.GetSeg().B);
			if (d <= threshold) {
				result.intersecting = true;
				if (this.aNeedLocation) {
					result.location = seg.GetCentre();
				}
			}
			return result;
		}

		if (shape.Type() === SHAPE_TYPE.POLY_SET) {
			const d = shape.Distance(seg.GetCentre());
			if (d <= threshold) {
				result.intersecting = true;
				if (this.aNeedLocation) {
					result.location = seg.GetCentre();
				}
			}
			return result;
		}

		// Fall back
		const d = shape.Distance(seg.GetCentre());
		if (d <= threshold) {
			result.intersecting = true;
		}
		return result;
	}

	private collideCircleRect(c: SHAPE_CIRCLE, r: SHAPE_RECT, result: CollisionResult): CollisionResult {
		// A circle collides the rect if it overlaps the rect (its center's
		// distance to the rect's closest point is within its radius) — via/
		// round pad over a rect pad.
		const clearance = this.aClearance + this.aAccuracy;
		const rx = r.GetStart().x, ry = r.GetStart().y, rw = r.GetW(), rh = r.GetH();
		const cx = c.GetCenter().x, cy = c.GetCenter().y, rad = c.GetRadius();
		// Closest point on the rect (may be inside → distance 0).
		const px = Math.max(rx, Math.min(cx, rx + rw));
		const py = Math.max(ry, Math.min(cy, ry + rh));
		const d = Math.hypot(cx - px, cy - py);
		if (d <= rad + clearance) {
			result.intersecting = true;
			if (this.aNeedLocation) {
				result.location = new Vec2(px, py);
			}
		}
		return result;
	}

	private collideRectRect(a: SHAPE_RECT, b: SHAPE_RECT, result: CollisionResult): CollisionResult {
		const clearance = this.aClearance + this.aAccuracy;
		const ax = a.GetStart().x, ay = a.GetStart().y, aw = a.GetW(), ah = a.GetH();
		const bx = b.GetStart().x, by = b.GetStart().y, bw = b.GetW(), bh = b.GetH();
		const overlapX = ax < bx + bw && bx < ax + aw;
		const overlapY = ay < by + bh && by < ay + ah;
		if (overlapX && overlapY) {
			result.intersecting = true;
			if (this.aNeedLocation) {
				result.location = a.GetCentre().add(b.GetCentre()).multiply(0.5);
			}
			return result;
		}
		// Otherwise check gap along the nearest axis (edge-to-edge distance).
		const gapX = Math.max(0, Math.max(bx - (ax + aw), ax - (bx + bw)));
		const gapY = Math.max(0, Math.max(by - (ay + ah), ay - (by + bh)));
		if (Math.min(gapX, gapY) <= clearance) {
			result.intersecting = true;
			if (this.aNeedLocation) {
				result.location = a.GetCentre().add(b.GetCentre()).multiply(0.5);
			}
		}
		return result;
	}

	private collideWithPolySet(poly: SHAPE_POLY_SET, other: SHAPE, result: CollisionResult): CollisionResult {		// A shape collides with the poly set if its center/points are inside
		// the fill OR it comes within clearance of any outline segment.
		const clearance = this.aClearance + this.aAccuracy;

		// (1) Point-inside tests against the fill (exact, with holes).
		const testPoints = shapeSamplePoints(other);
		for (const p of testPoints) {
			if (poly.Contains(p, clearance)) {
				result.intersecting = true;
				if (this.aNeedLocation) {
					result.location = p;
				}
				return result;
			}
		}

		// (2) Distance from `other` to any outline segment <= clearance.
		const d = poly.Distance(other.GetCentre());
		if (d <= clearance + shapeExtentRadius(other)) {
			result.intersecting = true;
			if (this.aNeedLocation) {
				result.location = other.GetCentre();
			}
			return result;
		}

		return result;
	}

	private shapeDistance(a: SHAPE, b: SHAPE): number {
		// Conservative: distance between the bounding circles' edges (center
		// distance minus both extents). Used only for the fallback path — a
		// conservative estimate that correctly reports 0 when the two shapes'
		// bounding circles overlap.
		const ca = a.GetCentre();
		const cb = b.GetCentre();
		const centerDist = ca.sub(cb).magnitude;
		const ra = shapeExtentRadius(a);
		const rb = shapeExtentRadius(b);
		return Math.max(0, centerDist - ra - rb);
	}
}

function bBoxIntersects(a: BBox, b: BBox): boolean {
	return a.x <= b.x2 && b.x <= a.x2 && a.y <= b.y2 && b.y <= a.y2;
}

/** Minimum distance between two segments. */
export function segmentSegmentDistance(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): number {
	// Check for intersection.
	if (segmentsIntersect(p1, p2, p3, p4)) {
		return 0;
	}
	// Otherwise distance between the closest endpoints-to-other-segment.
	return Math.min(
		pointToSegmentDistance(p1, p3, p4),
		pointToSegmentDistance(p2, p3, p4),
		pointToSegmentDistance(p3, p1, p2),
		pointToSegmentDistance(p4, p1, p2)
	);
}

function segmentsIntersect(a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2): boolean {
	const d1x = b1.x - a1.x, d1y = b1.y - a1.y;
	const d2x = b2.x - a2.x, d2y = b2.y - a2.y;
	const denom = d1x * d2y - d1y * d2x;
	if (denom === 0) {
		return false; // parallel
	}
	const t = ((a2.x - a1.x) * d2y - (a2.y - a1.y) * d2x) / denom;
	const u = ((a2.x - a1.x) * d1y - (a2.y - a1.y) * d1x) / denom;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Distance from `p` to the (closed) rectangle edge path. */
function rectDistanceToSegment(rect: SHAPE_RECT, a: Vec2, b: Vec2): number {
	const corners = [
		rect.GetStart(),
		new Vec2(rect.GetStart().x + rect.GetW(), rect.GetStart().y),
		new Vec2(rect.GetStart().x + rect.GetW(), rect.GetStart().y + rect.GetH()),
		new Vec2(rect.GetStart().x, rect.GetStart().y + rect.GetH()),
	];
	let d = Infinity;
	for (let i = 0; i < 4; i++) {
		d = Math.min(d, segmentSegmentDistance(corners[i]!, corners[(i + 1) % 4]!, a, b));
	}
	// Also the distance from both segment endpoints to the rect interior.
	d = Math.min(
		d,
		Math.abs(Math.max(0, Math.max(rect.GetStart().x - a.x, a.x - (rect.GetStart().x + rect.GetW())))),
		Math.abs(Math.max(0, Math.max(rect.GetStart().y - a.y, a.y - (rect.GetStart().y + rect.GetH()))))
	);
	return d;
}

/** Sample representative points of a shape for poly-set containment tests. */
function shapeSamplePoints(s: SHAPE): Vec2[] {
	switch (s.Type()) {
		case SHAPE_TYPE.SEGMENT: {
			const seg = s as SHAPE_SEGMENT;
			return [seg.GetSeg().A, seg.GetSeg().B];
		}
		case SHAPE_TYPE.RECT: {
			const r = s as SHAPE_RECT;
			return [r.GetStart(), r.GetEnd(), r.GetCentre()];
		}
		case SHAPE_TYPE.CIRCLE: {
			const c = s as SHAPE_CIRCLE;
			return [c.GetCenter()];
		}
		case SHAPE_TYPE.ARC: {
			const a = s as SHAPE_ARC;
			return [a.GetStart(), a.GetEnd(), a.GetMidPoint()];
		}
		default:
			return [s.GetCentre()];
	}
}

function shapeExtentRadius(s: SHAPE): number {
	const b = s.BBox();
	return new Vec2(b.w / 2, b.h / 2).magnitude;
}

// Register the collision engine into SHAPE (lazily resolved) after this
// module is fully defined, so SHAPE.Collide() works without a circular
// module-init dependency.
setShapeCollisionCtor((clearance: number, accuracy?: number, needLocation?: boolean) =>
	new SHAPE_COLLISION(clearance, accuracy, needLocation)
);
