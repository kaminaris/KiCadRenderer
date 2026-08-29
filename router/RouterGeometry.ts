import { type PaintedShape } from '../paint/PaintedShape';
import { distanceToSegmentCoords as distanceToSegment, polygonEdgeDistanceCoords as polygonEdgeDistance, pointInPolygonCoords as pointInPolygon } from '../geometry/polygon';

/** Standard segment-segment orientation test (used only for the crossing
 *  check below — real routing shapes are thin bands around these lines, so
 *  "the centerlines cross" already implies near-zero clearance regardless
 *  of exact width). */
function segmentsIntersect(ax1: number, ay1: number, ax2: number, ay2: number, bx1: number, by1: number, bx2: number, by2: number): boolean {
	const d1 = (bx2 - bx1) * (ay1 - by1) - (by2 - by1) * (ax1 - bx1);
	const d2 = (bx2 - bx1) * (ay2 - by1) - (by2 - by1) * (ax2 - bx1);
	const d3 = (ax2 - ax1) * (by1 - ay1) - (ay2 - ay1) * (bx1 - ax1);
	const d4 = (ax2 - ax1) * (by2 - ay1) - (ay2 - ay1) * (bx2 - ax1);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Minimum distance between two line segments' CENTERLINES (no width
 *  baked in — callers subtract each shape's own half-width/radius). Crossing
 *  segments return 0; otherwise the minimum of the four endpoint-to-
 *  opposite-segment distances, the standard closed-form result for two
 *  finite segments (their true closest approach is always either a crossing
 *  point or one segment's endpoint against the other). */
export function segmentToSegmentDistance(
	ax1: number, ay1: number, ax2: number, ay2: number,
	bx1: number, by1: number, bx2: number, by2: number,
): number {
	if (segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2)) {
		return 0;
	}
	return Math.min(
		distanceToSegment(ax1, ay1, bx1, by1, bx2, by2),
		distanceToSegment(ax2, ay2, bx1, by1, bx2, by2),
		distanceToSegment(bx1, by1, ax1, ay1, ax2, ay2),
		distanceToSegment(bx2, by2, ax1, ay1, ax2, ay2),
	);
}

/** Corner points of a PaintedShape as a closed polygon — 'rect'/'polygon'
 *  return their own points, 'circle'/'segment' return null (handled by
 *  their own dedicated distance formulas instead, since a polygon
 *  approximation of a circle would either miss clearance near the curve or
 *  need many segments to be accurate). */
function shapeAsPolygon(shape: PaintedShape): { x: number; y: number }[] | null {
	if (shape.type === 'rect') {
		return [
			{ x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y },
			{ x: shape.x + shape.w, y: shape.y + shape.h }, { x: shape.x, y: shape.y + shape.h },
		];
	}
	if (shape.type === 'polygon') {
		return shape.points;
	}
	return null;
}

/** Edge-to-edge gap (world mm) between a candidate SEGMENT centerline
 *  (caller's own half-width already subtracted by the router, not here —
 *  this returns the gap between the two shapes' own outlines) and an
 *  arbitrary obstacle shape. Never negative-clamped here — a negative
 *  result (overlap) is meaningful to callers comparing against a required
 *  clearance. */
export function segmentToShapeGap(x1: number, y1: number, x2: number, y2: number, shape: PaintedShape): number {
	switch (shape.type) {
		case 'circle':
			return distanceToSegment(shape.cx, shape.cy, x1, y1, x2, y2) - shape.r;
		case 'segment':
			return segmentToSegmentDistance(x1, y1, x2, y2, shape.x1, shape.y1, shape.x2, shape.y2) - shape.width / 2;
		case 'rect':
		case 'polygon': {
			const points = shapeAsPolygon(shape)!;
			if (points.length < 2) {
				return Infinity;
			}
			// A segment fully inside the polygon never crosses an edge, so the
			// edge-distance loop alone would wrongly report "far away" — probe
			// both endpoints (cheap, and sufficient: routing candidates are
			// short relative to typical pad/zone polygons, so a midpoint
			// crossing without either endpoint inside is not a realistic case
			// this phase needs to handle precisely).
			if (pointInPolygon(points, x1, y1) || pointInPolygon(points, x2, y2)) {
				return -1;
			}
			let min = Infinity;
			for (let i = 0; i < points.length; i++) {
				const a = points[i]!;
				const b = points[(i + 1) % points.length]!;
				min = Math.min(min, segmentToSegmentDistance(x1, y1, x2, y2, a.x, a.y, b.x, b.y));
			}
			return min;
		}
	}
}

/** Edge-to-edge gap between a candidate CIRCLE (a via) and an obstacle
 *  shape — same semantics as segmentToShapeGap. */
export function circleToShapeGap(cx: number, cy: number, r: number, shape: PaintedShape): number {
	switch (shape.type) {
		case 'circle':
			return Math.hypot(cx - shape.cx, cy - shape.cy) - r - shape.r;
		case 'segment':
			return distanceToSegment(cx, cy, shape.x1, shape.y1, shape.x2, shape.y2) - shape.width / 2 - r;
		case 'rect':
		case 'polygon': {
			const points = shapeAsPolygon(shape)!;
			if (points.length < 2) {
				return Infinity;
			}
			if (pointInPolygon(points, cx, cy)) {
				return -r;
			}
			return polygonEdgeDistance(points, true, cx, cy) - r;
		}
	}
}

/** Walkaround geometry (obstacle hull construction + the actual hull-
 *  hugging algorithm) moved to PnsHull.ts/PnsWalkaround.ts — a direct port
 *  of real KiCad's own walkaround, replacing the bounding-circle
 *  approximation this file used to provide (boundingCircle/
 *  externalTangentPoints/circleWalkaroundPath), which produced a
 *  same-radius-regardless-of-shape curve instead of hugging the obstacle's
 *  actual outline. See those two files' doc comments. */
