import type { PaintedShape } from '../paint/PaintedShape';
import { shapeToBBox } from '../paint/PaintedShape';

type Pt = { x: number; y: number };

/**
 * Clearance-hull generator for PnsWalkaround.ts — the polygon the walk
 * actually hugs. This is a literal, careful port of real KiCad's own hull
 * builders in pcbnew/router/pns_utils.cpp (`OctagonalHull`, `ConvexHull` +
 * `MoveDiagonal`, `SegmentHull`, and the `BuildHullForPrimitiveShape`
 * dispatch), not an independent approximation.
 *
 * This replaces an earlier version of this file that built smooth,
 * many-point hulls (a tessellated circle/capsule, a Clipper2 polygon
 * offset). That approach was not just buggy in its edge cases — it was
 * never what real KiCad does at all. Real KiCad's router hulls are ALWAYS
 * low-poly (4-8 points): a plain rect, or a rect/circle with 45°-chamfered
 * corners, or (for arbitrary convex pad outlines) a bounding-box octagon
 * whose 4 diagonal chamfer lines are pulled in to just clear the polygon's
 * own vertices. Fewer points means far fewer graph-traversal edge cases in
 * PnsWalkaround's vertex walk — see [[kicad-viewer-interactive-router-port]]
 * for the debugging history that led here (three separate walkaround bugs
 * surfaced against the old smooth-hull approach; the user's explicit
 * instruction after the third was "just copy this entire thing from
 * kicad").
 *
 * All KiCad source below works in integer nanometers and rounds
 * intermediate values (KiROUND); this port works in float mm throughout
 * (matching the rest of this codebase) and skips that rounding — floats
 * don't need it for exactness the way KiCad's fixed-point geometry does.
 */

/** Direct port of OctagonalHull (pns_utils.cpp:40-68): a rectangle
 *  `aP0`+`aSize`, outward-inflated by `aClearance`, with each corner cut by
 *  a 45° chamfer of length `aChamfer` (aChamfer=0 collapses to a plain
 *  4-point rect — every `if (aChamfer)` block below is skipped). */
function octagonalHull(p0x: number, p0y: number, sizeX: number, sizeY: number, clearance: number, chamfer: number): Pt[] {
	const pts: Pt[] = [];
	pts.push({ x: p0x - clearance, y: p0y - clearance + chamfer });
	if (chamfer) {
		pts.push({ x: p0x - clearance + chamfer, y: p0y - clearance });
	}
	pts.push({ x: p0x + sizeX + clearance - chamfer, y: p0y - clearance });
	if (chamfer) {
		pts.push({ x: p0x + sizeX + clearance, y: p0y - clearance + chamfer });
	}
	pts.push({ x: p0x + sizeX + clearance, y: p0y + sizeY + clearance - chamfer });
	if (chamfer) {
		pts.push({ x: p0x + sizeX + clearance - chamfer, y: p0y + sizeY + clearance });
	}
	pts.push({ x: p0x - clearance + chamfer, y: p0y + sizeY + clearance });
	if (chamfer) {
		pts.push({ x: p0x - clearance, y: p0y + sizeY + clearance - chamfer });
	}
	return pts;
}

/** Circle hull (BuildHullForPrimitiveShape's SH_CIRCLE case): an octagon
 *  whose chamfer is sized so the corner cuts approximate the circle's own
 *  curvature (`2*(1-1/√2)*(r+cl)`). `r` here is already the FINAL combined
 *  radius (raw circle radius + clearance + candidate half-width) — the
 *  OctagonalHull `aClearance` parameter is just an additional uniform bbox
 *  inflation, commutative with pre-inflating the box directly, so folding
 *  it into `r` up front and inflating by 0 here is exactly equivalent to
 *  real KiCad's `OctagonalHull(center-(r,r), (2r,2r), cl, chamfer)` with
 *  clearance passed separately. */
function circleHull(cx: number, cy: number, r: number): Pt[] {
	const chamfer = 2.0 * (1 - Math.SQRT1_2) * r;
	return octagonalHull(cx - r, cy - r, 2 * r, 2 * r, 0, chamfer);
}

/** Rect hull (BuildHullForPrimitiveShape's SH_RECT case): a plain
 *  OctagonalHull with chamfer=0. */
function rectHull(x: number, y: number, w: number, h: number, gap: number): Pt[] {
	return octagonalHull(x, y, w, h, gap, 0);
}

/** Segment hull (SegmentHull, pns_utils.cpp:181-286) for a track/via
 *  obstacle: an 8-point octagonal capsule hugging the segment. `r` is
 *  already the final combined radius (obstacle's own half-width +
 *  clearance + candidate half-width — real KiCad's `d`), matching this
 *  file's existing circleHull/capsule calling convention.
 *
 *  Real KiCad's SegmentHull also special-cases near-zero-length and
 *  near-45°-aligned very short segments (a "kink threshold" correction,
 *  lines 198-248) — a tessellation-artifact fixup for segments that come
 *  from flattening an arc, not something a simple 2-point straight track
 *  segment can hit. Skipped here; the zero-length case (`a === b`) is kept
 *  since a degenerate track segment is a real possibility. */
function segmentHull(x1: number, y1: number, x2: number, y2: number, r: number): Pt[] {
	const dx = x2 - x1, dy = y2 - y1;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) {
		return circleHull(x1, y1, r);
	}
	const x = (2.0 / (1.0 + Math.SQRT2)) * r;
	const dr = r;
	const xr2 = x / 2;
	// dir.Perpendicular() / dir.Resize(n) — direction rotated 90° and
	// rescaled to length n. Absolute rotation sense doesn't matter here:
	// PnsWalkaround tries both windings of every hull it's given.
	const p0 = { x: (-dy / len) * dr, y: (dx / len) * dr };
	const ds = { x: (-dy / len) * xr2, y: (dx / len) * xr2 };
	const pd = { x: (dx / len) * xr2, y: (dy / len) * xr2 };
	const dp = { x: (dx / len) * dr, y: (dy / len) * dr };
	return [
		{ x: x2 + p0.x + pd.x, y: y2 + p0.y + pd.y },
		{ x: x2 + dp.x + ds.x, y: y2 + dp.y + ds.y },
		{ x: x2 + dp.x - ds.x, y: y2 + dp.y - ds.y },
		{ x: x2 - p0.x + pd.x, y: y2 - p0.y + pd.y },
		{ x: x1 - p0.x - pd.x, y: y1 - p0.y - pd.y },
		{ x: x1 - dp.x - ds.x, y: y1 - dp.y - ds.y },
		{ x: x1 - dp.x + ds.x, y: y1 - dp.y + ds.y },
		{ x: x1 + p0.x - pd.x, y: y1 + p0.y - pd.y },
	];
}

/**
 * Convex-polygon hull (ConvexHull + MoveDiagonal, pns_utils.cpp:289-353)
 * for an arbitrary convex outline (a real footprint pad's exported
 * polygon). An octagon: 4 axis-aligned edges at the polygon's own
 * clearance-inflated bounding box, plus 4 diagonal (45°) chamfer edges
 * pulled in to sit exactly `gap` outward from the polygon's own extremal
 * vertex in each diagonal direction.
 *
 * Real KiCad builds each diagonal as an initial 45° line anchored at the
 * (already clearance-expanded) bbox corner, then calls `MoveDiagonal` to
 * translate it based on the polygon's nearest vertex to that line
 * (`SHAPE_LINE_CHAIN::NearestPoint`, which uses `SEG::LineDistance` — an
 * unsigned distance to the infinite line). Because the initial line sits
 * entirely outside the polygon, every vertex is on the same side of it, so
 * "nearest vertex to a line placed beyond all of them" is exactly the
 * vertex with the largest projection toward that line's direction — i.e.
 * this reduces to a standard outward support-line offset, which is what's
 * implemented directly below (verified by hand against a symmetric test
 * case: a square hulled at clearance 0.5 chamfers each corner at exactly
 * perpendicular distance 0.5 from that corner's vertex). Diagonal lines
 * come in two parallel families: x+y=const (cutting the max-corner and
 * min-corner) and x-y=const (cutting the other two corners); the 8
 * vertices are the intersections of each axis-aligned edge with its two
 * neighboring diagonal edges, in the same order as real KiCad's own
 * `octagon.Append()` sequence.
 */
function convexHull(points: Pt[], gap: number): Pt[] {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	let maxSum = -Infinity, minSum = Infinity, maxDiff = -Infinity, minDiff = Infinity;
	for (const p of points) {
		minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
		const sum = p.x + p.y, diff = p.x - p.y;
		maxSum = Math.max(maxSum, sum); minSum = Math.min(minSum, sum);
		maxDiff = Math.max(maxDiff, diff); minDiff = Math.min(minDiff, diff);
	}
	minX -= gap; maxX += gap; minY -= gap; maxY += gap;
	const diag = gap * Math.SQRT2;
	// x+y = cTR cuts the (maxX,maxY) corner; x+y = cBL cuts (minX,minY).
	const cTR = maxSum + diag, cBL = minSum - diag;
	// x-y = cBR cuts the (maxX,minY) corner; x-y = cTL cuts (minX,maxY).
	const cBR = maxDiff + diag, cTL = minDiff - diag;
	return [
		{ x: minX, y: cBL - minX },
		{ x: cBL - minY, y: minY },
		{ x: cBR + minY, y: minY },
		{ x: maxX, y: maxX - cBR },
		{ x: maxX, y: cTR - maxX },
		{ x: cTR - maxY, y: maxY },
		{ x: cTL + maxY, y: maxY },
		{ x: minX, y: minX - cTL },
	];
}

/** Builds the closed clearance-hull polygon a walkaround should hug for
 *  `shape`, expanded by `gap` (the caller's already-summed clearance +
 *  candidate line half-width — real KiCad's combined `cl`). Always returns
 *  a polygon with at least 3 points.
 *
 *  `simplifyToRect`, when true, replaces the shape-specific octagon/segment/
 *  convex hull with a plain axis-aligned rectangle sized to the shape's own
 *  bbox inflated by `gap` — real KiCad's `WALKAROUND::singleStep()`
 *  (pns_walkaround.cpp:162-169) does exactly this ("Rounded corners don't
 *  make sense when routing orthogonally") whenever the active corner
 *  posture is 90°-only (`MITERED_90`/`ROUNDED_90`): it takes the normal
 *  octagonal hull's own bbox and turns that into a 4-point rect, so a
 *  walkaround in 90°-corner mode can never introduce a 45° chamfer bend.
 *  Mathematically exact here too — a hull's bbox is always identical to the
 *  shape's own bbox inflated by `gap` (chamfering only cuts corners, it
 *  never extends past the bbox), so there's no need to build the real hull
 *  first just to throw its shape away. */
export function buildClearanceHull(shape: PaintedShape, gap: number, simplifyToRect = false): Pt[] {
	if (simplifyToRect) {
		const bbox = shapeToBBox(shape);
		return rectHull(bbox.x, bbox.y, bbox.w, bbox.h, gap);
	}
	switch (shape.type) {
		case 'circle':
			return circleHull(shape.cx, shape.cy, shape.r + gap);
		case 'segment':
			return segmentHull(shape.x1, shape.y1, shape.x2, shape.y2, shape.width / 2 + gap);
		case 'rect':
			return rectHull(shape.x, shape.y, shape.w, shape.h, gap);
		case 'polygon':
			return convexHull(shape.points, gap);
	}
}
