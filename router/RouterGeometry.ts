import { type PaintedShape, distanceToSegment, polygonEdgeDistance, pointInPolygon } from '../paint/PaintedShape';

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

/**
 * Shove — reroutes an existing straight track segment around a newly
 * placed one instead of leaving it colliding, preserving both of the
 * obstacle's own original endpoints exactly (so whatever it connects to —
 * a pad, a via, another segment — stays connected). Real KiCad's shove is
 * topology-aware (it can cascade through an entire chain of segments and
 * spring back the whole attempt on failure); this is the single-segment,
 * single-cascade-level version this phase scopes to (see [[router phase 4
 * scope note]] in BoardPointerController) — it only ever reshapes the ONE
 * obstacle segment actually in the way, into up to 5 sub-segments:
 * original-start → (unchanged lead-in) → jog → shifted-parallel-middle →
 * jog → (unchanged lead-out) → original-end. Returns null when the
 * obstacle is degenerate (zero length) or the new route's conflict window
 * covers the obstacle's entire length (no room left to keep any of the
 * original line, so a jog can't preserve both endpoints) — callers fall
 * back to walkaround/highlight-collision in that case.
 */
export function shoveTrackPath(
	ox1: number, oy1: number, ox2: number, oy2: number, obstacleHalfWidth: number,
	nx1: number, ny1: number, nx2: number, ny2: number, newHalfWidth: number,
	requiredClearance: number,
): { x: number; y: number }[] | null {
	const dx = ox2 - ox1, dy = oy2 - oy1;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) {
		return null;
	}
	const ux = dx / len, uy = dy / len;
	const perpX = -uy, perpY = ux;

	// Along-obstacle window the new route conflicts with, padded so the jog
	// clears with room to spare, clamped to the obstacle's own extent.
	const proj = (x: number, y: number) => (x - ox1) * ux + (y - oy1) * uy;
	const pad = obstacleHalfWidth * 2 + requiredClearance;
	let tEnter = Math.min(proj(nx1, ny1), proj(nx2, ny2)) - pad;
	let tExit = Math.max(proj(nx1, ny1), proj(nx2, ny2)) + pad;
	tEnter = Math.max(0, Math.min(len, tEnter));
	tExit = Math.max(0, Math.min(len, tExit));
	if (tExit - tEnter < 1e-3) {
		return null;
	}

	const totalHalf = obstacleHalfWidth + newHalfWidth;
	const enterPoint = { x: ox1 + ux * tEnter, y: oy1 + uy * tEnter };
	const exitPoint = { x: ox1 + ux * tExit, y: oy1 + uy * tExit };
	const midT = (tEnter + tExit) / 2;
	const midX = ox1 + ux * midT, midY = oy1 + uy * midT;

	// Shove away from the new route, not toward it — whichever perpendicular
	// direction is already farther from the new segment's centerline.
	const distPlus = distanceToSegment(midX + perpX, midY + perpY, nx1, ny1, nx2, ny2);
	const distMinus = distanceToSegment(midX - perpX, midY - perpY, nx1, ny1, nx2, ny2);
	const sign = distPlus >= distMinus ? 1 : -1;

	let shove = totalHalf + requiredClearance;
	let shiftedEnter = { x: enterPoint.x + sign * perpX * shove, y: enterPoint.y + sign * perpY * shove };
	let shiftedExit = { x: exitPoint.x + sign * perpX * shove, y: exitPoint.y + sign * perpY * shove };
	for (let attempt = 0; attempt < 12; attempt++) {
		const gap = segmentToSegmentDistance(shiftedEnter.x, shiftedEnter.y, shiftedExit.x, shiftedExit.y, nx1, ny1, nx2, ny2) - totalHalf;
		if (gap >= requiredClearance) {
			break;
		}
		shove += totalHalf * 0.5 + requiredClearance * 0.5 + 0.05;
		shiftedEnter = { x: enterPoint.x + sign * perpX * shove, y: enterPoint.y + sign * perpY * shove };
		shiftedExit = { x: exitPoint.x + sign * perpX * shove, y: exitPoint.y + sign * perpY * shove };
	}

	const path: { x: number; y: number }[] = [{ x: ox1, y: oy1 }];
	if (tEnter > 1e-6) {
		path.push(enterPoint);
	}
	path.push(shiftedEnter, shiftedExit);
	if (tExit < len - 1e-6) {
		path.push(exitPoint);
	}
	path.push({ x: ox2, y: oy2 });
	return path;
}

/** Walkaround geometry (obstacle hull construction + the actual hull-
 *  hugging algorithm) moved to PnsHull.ts/PnsWalkaround.ts — a direct port
 *  of real KiCad's own walkaround, replacing the bounding-circle
 *  approximation this file used to provide (boundingCircle/
 *  externalTangentPoints/circleWalkaroundPath), which produced a
 *  same-radius-regardless-of-shape curve instead of hugging the obstacle's
 *  actual outline. See those two files' doc comments. */
