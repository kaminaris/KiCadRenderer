import { Vec2 } from '../math/Vec2';

/**
 * Direct, scoped port of real KiCad's DIRECTION_45
 * (libs/kimath/include/geometry/direction45.h) — represents a route
 * heading/corner angle rounded to one of 8 compass octants (or UNDEFINED
 * for a zero-length vector). Only the members dragSegment45 actually calls
 * are ported: Left()/Right() (±45° or ±90°, depending on corner mode),
 * isObtuseOrHalfFull (the only Angle() classification dragSegment45 uses),
 * toVector(). The Y-flip in fromVector matches the original exactly (KiCad
 * treats "north" as up, i.e. negative-Y, while world Y grows downward) —
 * kept only for fidelity to the upstream octant numbering; the algorithm's
 * correctness never depends on which octant is labeled "north", only on
 * consistent relative rotation.
 */
const enum Dir { N = 0, NE = 1, E = 2, SE = 3, S = 4, SW = 5, W = 6, NW = 7, UNDEFINED = -1 }

export class Direction45 {
	private constructor(private readonly dir: Dir, private readonly is90: boolean) {}

	static fromVector(vx: number, vy: number, is90: boolean): Direction45 {
		if (vx === 0 && vy === 0) {
			return new Direction45(Dir.UNDEFINED, is90);
		}
		const flippedY = -vy;
		let mag = 360 - (180 / Math.PI * Math.atan2(flippedY, vx)) + 90;
		if (mag >= 360) mag -= 360;
		if (mag < 0) mag += 360;
		let dir = Math.floor((mag + 22.5) / 45);
		if (dir >= 8) dir -= 8;
		if (dir < 0) dir += 8;
		return new Direction45(dir as Dir, is90);
	}

	static fromSegment(a: Vec2, b: Vec2, is90: boolean): Direction45 {
		return Direction45.fromVector(b.x - a.x, b.y - a.y, is90);
	}

	get isDefined(): boolean { return this.dir !== Dir.UNDEFINED; }

	equals(other: Direction45): boolean { return this.dir === other.dir; }

	right(): Direction45 {
		if (this.dir === Dir.UNDEFINED) return this;
		const step = this.is90 ? 2 : 1;
		return new Direction45(((this.dir + step) % 8) as Dir, this.is90);
	}

	left(): Direction45 {
		if (this.dir === Dir.UNDEFINED) return this;
		const step = this.is90 ? 2 : 1;
		return new Direction45(((this.dir + 8 - step) % 8) as Dir, this.is90);
	}

	/** dragSegment45's only use of DIRECTION_45::Angle() is the bitmask
	 *  check `Angle(other) & (ANG_OBTUSE | ANG_HALF_FULL)` — true when the
	 *  two headings are one octant-step apart (an obtuse corner) or exactly
	 *  opposite (d===4, a 180° reversal). ANG_UNDEFINED (either side
	 *  undefined) is never in that mask, so it's false here too. */
	isObtuseOrHalfFull(other: Direction45): boolean {
		if (this.dir === Dir.UNDEFINED || other.dir === Dir.UNDEFINED) {
			return false;
		}
		const d = Math.abs(this.dir - other.dir);
		return d === 1 || d === 7 || d === 4;
	}

	/** DIRECTION_45::IsObtuse — strictly ANG_OBTUSE (one octant-step apart),
	 *  unlike isObtuseOrHalfFull's bitmask which also accepts a straight
	 *  180° reversal. dragCornerInternal uses this exact strict form to
	 *  decide whether a candidate continuation reads as a smooth bend off
	 *  the segment before it, not dragSegment45's looser test. */
	isObtuse(other: Direction45): boolean {
		if (this.dir === Dir.UNDEFINED || other.dir === Dir.UNDEFINED) {
			return false;
		}
		const d = Math.abs(this.dir - other.dir);
		return d === 1 || d === 7;
	}

	/** DIRECTION_45::IsDiagonal — true for the 4 diagonal octants (odd dir
	 *  index: NE/SE/SW/NW). */
	isDiagonal(): boolean {
		return this.dir !== Dir.UNDEFINED && (this.dir % 2) === 1;
	}

	toVector(): Vec2 {
		switch (this.dir) {
			case Dir.N: return new Vec2(0, -1);
			case Dir.S: return new Vec2(0, 1);
			case Dir.E: return new Vec2(1, 0);
			case Dir.W: return new Vec2(-1, 0);
			case Dir.NE: return new Vec2(1, -1);
			case Dir.NW: return new Vec2(-1, -1);
			case Dir.SE: return new Vec2(1, 1);
			case Dir.SW: return new Vec2(-1, 1);
			default: return new Vec2(0, 0);
		}
	}
}

interface Seg { a: Vec2; b: Vec2 }

/** Two lines, each extended to infinity through its own two points —
 *  real KiCad's SEG::IntersectLines. Null when parallel (including
 *  coincident, which dragSegment45 never needs to distinguish here). */
function intersectLinesInfinite(l1: Seg, l2: Seg): Vec2 | null {
	const d1x = l1.b.x - l1.a.x, d1y = l1.b.y - l1.a.y;
	const d2x = l2.b.x - l2.a.x, d2y = l2.b.y - l2.a.y;
	const denom = d1x * d2y - d1y * d2x;
	if (Math.abs(denom) < 1e-9) {
		return null;
	}
	const t = ((l2.a.x - l1.a.x) * d2y - (l2.a.y - l1.a.y) * d2x) / denom;
	return new Vec2(l1.a.x + d1x * t, l1.a.y + d1y * t);
}

/** Bounded segment-segment intersection (both segments' own real extents,
 *  not extended) — real KiCad's SEG::Intersect. Null when the segments
 *  don't actually cross within both their lengths. */
function intersectSegmentsBounded(s1: Seg, s2: Seg): Vec2 | null {
	const d1x = s1.b.x - s1.a.x, d1y = s1.b.y - s1.a.y;
	const d2x = s2.b.x - s2.a.x, d2y = s2.b.y - s2.a.y;
	const denom = d1x * d2y - d1y * d2x;
	if (Math.abs(denom) < 1e-9) {
		return null;
	}
	const t = ((s2.a.x - s1.a.x) * d2y - (s2.a.y - s1.a.y) * d2x) / denom;
	const u = ((s2.a.x - s1.a.x) * d1y - (s2.a.y - s1.a.y) * d1x) / denom;
	if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) {
		return null;
	}
	return new Vec2(s1.a.x + d1x * t, s1.a.y + d1y * t);
}

function pathLength(points: Vec2[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
	}
	return total;
}

function almostEqual(a: Vec2, b: Vec2): boolean {
	return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

/** Drops consecutive duplicate points — real KiCad's SHAPE_LINE_CHAIN::
 *  Simplify does more (also collapses collinear runs), but dragSegment45's
 *  own candidates are already built from guide-line intersections that
 *  rarely produce spurious collinear middle points; de-duplication is what
 *  actually matters here (a zero-length stub surviving into the committed
 *  track would otherwise need a separate cleanup pass). */
function simplify(points: Vec2[]): Vec2[] {
	const result: Vec2[] = [];
	for (const point of points) {
		if (result.length === 0 || !almostEqual(result[result.length - 1]!, point)) {
			result.push(point);
		}
	}
	return result;
}

/**
 * Direct port of real KiCad's LINE::dragSegment45
 * (pcbnew/router/pns_line.cpp:1182-1349) — drags the body of segment
 * `segmentIndex` of `points` toward `target`, keeping the dragged segment
 * on its OWN original heading (it slides parallel to itself) while the two
 * neighboring corners reflow to follow it, constrained to 45°/90°
 * increments per `cornerMode`. At either end of the line (no real neighbor
 * segment) or where a neighbor happens to be exactly collinear with the
 * drag direction, a zero-length placeholder segment is inserted first (real
 * KiCad's own technique) so the same prev/next reconciliation logic applies
 * uniformly — its guide becomes the drag direction's own Left()/Right().
 * Four candidate solutions (2×2 choices of which guide each end uses) are
 * tried; the shortest one wins, exactly matching the upstream `best_len`
 * search. Real KiCad never calls this in free-angle mode (asserts instead,
 * pns_line.cpp:852-855) — there is deliberately no free-angle branch here
 * either. Not ported: snapToNeighbourSegments' minor "smooth into a nearby
 * same-heading neighbor two hops away" refinement (pns_line.cpp:1137-1180,
 * gated by SmoothDraggedSegments' snap threshold) — a stated
 * simplification; the core reflow/shortest-of-4 behavior is unaffected.
 */
export function dragSegment45(points: readonly Vec2[], segmentIndex: number, target: Vec2, cornerMode: '45' | '90'): Vec2[] {
	const is90 = cornerMode === '90';
	const path = points.map(p => new Vec2(p.x, p.y));
	let index = segmentIndex;

	// Ensure a real (possibly zero-length) previous and next segment exist —
	// inserting a duplicate point at the line's own start/end gives dir_prev/
	// dir_next an UNDEFINED direction there, which the guide construction
	// below treats as "use the drag direction's own Left()/Right()".
	if (index === 0) {
		path.splice(0, 0, path[0]!);
		index++;
	}
	if (index === path.length - 2) {
		path.splice(path.length - 1, 0, path[path.length - 1]!);
	}

	const dragged: Seg = { a: path[index]!, b: path[index + 1]! };
	const dragDir = Direction45.fromSegment(dragged.a, dragged.b, is90);

	let sPrev: Seg = { a: path[index - 1]!, b: path[index]! };
	let sNext: Seg = { a: path[index + 1]!, b: path[index + 2]! };
	let dirPrev = Direction45.fromSegment(sPrev.a, sPrev.b, is90);
	let dirNext = Direction45.fromSegment(sNext.a, sNext.b, is90);

	if (dirPrev.equals(dragDir)) {
		dirPrev = dirPrev.left();
		path.splice(index, 0, path[index]!);
		index++;
	}
	else if (!dirPrev.isDefined) {
		dirPrev = dragDir.left();
	}
	if (dirNext.equals(dragDir)) {
		dirNext = dirNext.right();
		path.splice(index + 1, 0, path[index + 1]!);
	}
	else if (!dirNext.isDefined) {
		dirNext = dragDir.right();
	}

	sPrev = { a: path[index - 1]!, b: path[index]! };
	sNext = { a: path[index + 1]!, b: path[index + 2]! };
	const draggedNow: Seg = { a: path[index]!, b: path[index + 1]! };

	const guideA: [Seg, Seg] = segmentIndex === 0
		? [{ a: draggedNow.a, b: addVec(draggedNow.a, dragDir.right().toVector()) },
			{ a: draggedNow.a, b: addVec(draggedNow.a, dragDir.left().toVector()) }]
		: dirPrev.isObtuseOrHalfFull(dragDir)
			? [{ a: sPrev.a, b: addVec(sPrev.a, dragDir.left().toVector()) },
				{ a: sPrev.a, b: addVec(sPrev.a, dragDir.right().toVector()) }]
			: [{ a: draggedNow.a, b: addVec(draggedNow.a, dirPrev.toVector()) },
				{ a: draggedNow.a, b: addVec(draggedNow.a, dirPrev.toVector()) }];

	const guideB: [Seg, Seg] = segmentIndex === points.length - 2
		? [{ a: draggedNow.b, b: addVec(draggedNow.b, dragDir.right().toVector()) },
			{ a: draggedNow.b, b: addVec(draggedNow.b, dragDir.left().toVector()) }]
		: dirNext.isObtuseOrHalfFull(dragDir)
			? [{ a: sNext.b, b: addVec(sNext.b, dragDir.left().toVector()) },
				{ a: sNext.b, b: addVec(sNext.b, dragDir.right().toVector()) }]
			: [{ a: draggedNow.b, b: addVec(draggedNow.b, dirNext.toVector()) },
				{ a: draggedNow.b, b: addVec(draggedNow.b, dirNext.toVector()) }];

	const sCurrent: Seg = { a: target, b: addVec(target, dragDir.toVector()) };

	let bestLen = Infinity;
	let best: Vec2[] | null = null;

	for (let i = 0; i < 2; i++) {
		for (let j = 0; j < 2; j++) {
			const ip1 = intersectLinesInfinite(sCurrent, guideA[i]!);
			const ip2 = intersectLinesInfinite(sCurrent, guideB[j]!);
			if (!ip1 || !ip2) {
				continue;
			}
			const s1: Seg = { a: sPrev.a, b: ip1 };
			const s3: Seg = { a: ip2, b: sNext.b };

			let candidate: Vec2[];
			const crossNext = intersectSegmentsBounded(s1, sNext);
			const crossPrev = intersectSegmentsBounded(s3, sPrev);
			const crossSelf = intersectSegmentsBounded(s1, s3);
			if (crossNext) {
				candidate = [s1.a, crossNext, sNext.b];
			}
			else if (crossPrev) {
				candidate = [sPrev.a, crossPrev, s3.b];
			}
			else if (crossSelf) {
				candidate = [sPrev.a, crossSelf, sNext.b];
			}
			else {
				candidate = [sPrev.a, ip1, ip2, sNext.b];
			}

			const len = pathLength(candidate);
			if (len < bestLen) {
				bestLen = len;
				best = candidate;
			}
		}
	}

	if (!best) {
		return points.map(p => new Vec2(p.x, p.y));
	}

	// Splice `best` in place of the [sPrev.a .. sNext.b] span (indices
	// index-1 .. index+2 of the working `path`), matching the real code's
	// Replace(0,1,best) / Replace(-2,-1,best) / Replace(aIndex,aIndex+1,best)
	// dispatch — here uniformly expressed as "replace the whole
	// prev-dragged-next span" since sPrev.a/sNext.b are already that span's
	// fixed outer ends.
	const result = [...path.slice(0, index - 1), ...best, ...path.slice(index + 3)];
	return simplify(result);
}

function addVec(a: Vec2, b: Vec2): Vec2 {
	return new Vec2(a.x + b.x, a.y + b.y);
}

/**
 * Direct, narrowly-scoped port of real KiCad's OPTIMIZER::mergeColinear
 * (pcbnew/router/pns_optimizer.cpp:584-604) — the MERGE_COLINEAR pass of
 * the post-drag optimizer (pns_dragger.cpp:569-618), gated there by
 * SmoothDraggedSegments() exactly like it's gated at this app's call site
 * (BoardPointerController's track-body commit handler). Only drops a vertex
 * between two ADJACENT segments that are already exactly collinear (both
 * lie on the same line, matching SEG::Collinear's own endpoint-distance
 * check) — deliberately NOT the MERGE_SEGMENTS/mergeFull pass
 * (this codebase's simplifyWalkedPath) real KiCad also runs post-drag: that
 * one searches for the largest possible bypass across several segments,
 * which is exactly what collapsed the user's intentional drag bend back to
 * a near-straight line or nothing (see the onMouseUp comment this replaces
 * — a previously-shipped, then-reverted use of simplifyWalkedPath for this
 * same call site). Adjacent-only collinear merging can't do that: it never
 * looks past the immediate neighbor, so the two fixed outer ends of the
 * dragged line are never candidates for a direct shortcut.
 */
export function mergeCollinear(points: readonly Vec2[]): Vec2[] {
	if (points.length < 3) {
		return points.map(p => new Vec2(p.x, p.y));
	}
	const result: Vec2[] = [points[0]!];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = result[result.length - 1]!;
		const curr = points[i]!;
		const next = points[i + 1]!;
		const v1x = curr.x - prev.x, v1y = curr.y - prev.y;
		const v2x = next.x - curr.x, v2y = next.y - curr.y;
		// Zero-length segments never merge — mirrors mergeColinear's own
		// SquaredLength()===0 skip (abutting duplicate points) — note this
		// means KEEPING curr (falling through to the push below), not
		// dropping it.
		const zeroLength = (v1x === 0 && v1y === 0) || (v2x === 0 && v2y === 0);
		const cross = v1x * v2y - v1y * v2x;
		if (!zeroLength && Math.abs(cross) < 1e-6) {
			continue; // curr sits exactly on the prev->next line — drop it.
		}
		result.push(curr);
	}
	result.push(points[points.length - 1]!);
	return result;
}

/**
 * Direct port of real KiCad's DIRECTION_45::BuildInitialTrace
 * (libs/kimath/src/geometry/direction_45.cpp) — connects p0 to p1 with a
 * single 45°/90° elbow: whichever axis has the larger delta gets a straight
 * run, plus (45° mode only) a diagonal run to close the remaining gap, or
 * (90° mode) a plain right-angle turn using the full delta on one axis. Only
 * the MITERED_45/MITERED_90 cases are ported — this app has no rounded-
 * corner mode to match, unlike upstream's ROUNDED_45/ROUNDED_90. Falls
 * straight through to a plain 2-point line when p0/p1 already share an axis
 * or sit on an exact 45° diagonal (upstream's own shortcut, avoids
 * precision issues from filleting a already-clean line).
 *
 * `startDiagonal` picks which end of the elbow the diagonal segment sits at
 * (45° mode) or which axis runs first (90° mode) — mirrors upstream's own
 * parameter. Used directly by dragSegment45 (mid-segment drag) and as the
 * per-candidate primitive inside dragViaChain below (via-drag's port of
 * dragCornerInternal, which tries both `startDiagonal` values at each
 * backward-search step).
 */
export function buildInitialTrace(p0: Vec2, p1: Vec2, cornerMode: '45' | '90', startDiagonal = false): Vec2[] {
	const dx = p1.x - p0.x, dy = p1.y - p0.y;
	const w = Math.abs(dx), h = Math.abs(dy);
	const sw = Math.sign(dx), sh = Math.sign(dy);
	const is90 = cornerMode === '90';

	if (w === 0 || h === 0 || (!is90 && h === w)) {
		return [p0, p1];
	}

	let bend: Vec2;
	if (is90) {
		bend = startDiagonal === (h >= w) ? new Vec2(w * sw, 0) : new Vec2(0, sh * h);
	}
	else if (w > h) {
		bend = startDiagonal ? new Vec2(sw * h, sh * h) : new Vec2((w - h) * sw, 0);
	}
	else {
		bend = startDiagonal ? new Vec2(sw * w, sh * w) : new Vec2(0, sh * (h - w));
	}
	return [p0, new Vec2(p0.x + bend.x, p0.y + bend.y), p1];
}

/**
 * Direct port of real KiCad's dragCornerInternal (pcbnew/router/pns_line.cpp)
 * for the "dragging the far end" case only (LINE::dragCorner45's
 * `aIndex == m_line.SegmentCount()` branch — the only one via-drag needs,
 * since a via always sits at the end of its fanout's assembled line, never
 * in the middle). `originPoints` is the connected line's as-drawn points,
 * ORDERED FAR-ANCHOR-FIRST: index 0 is the fixed pad/junction/other via at
 * the far end, the last index is the via's CURRENT (pre-drag) position,
 * about to move to `target`.
 *
 * Unlike a single BuildInitialTrace call anchored at the near segment's far
 * point (this port's own first, simpler approach — see viaDragFanout's doc
 * comment for the "weird C shape" bug report that traced back to it), this
 * walks BACKWARD from the segment nearest the via, trying both elbow
 * orientations at each step: first preferring whichever keeps that
 * segment's ORIGINAL heading, then whichever forms an OBTUSE (smooth) angle
 * with the segment before it. If neither choice at this anchor reads as
 * smooth, the anchor moves one more segment back and tries again —
 * absorbing however many trailing segments turn out to be needed to avoid a
 * sharp reversal/zigzag. Only the points from that anchor onward get
 * replaced; everything closer to the far end is returned untouched.
 *
 * Direction comparisons (equals/isObtuse) are octant-only and never consult
 * the 90°-step flag — real KiCad's own d_start/d_prev/dirs[j] all construct
 * DIRECTION_45 with its default a90=false too, even inside 90° corner mode,
 * since Angle()/IsObtuse() don't read m_90deg (only Left()/Right() do,
 * which this algorithm never calls) — so the `false` passed to fromSegment
 * below matches upstream exactly, not just "close enough".
 */
export function dragViaChain(originPoints: Vec2[], target: Vec2, cornerMode: '45' | '90'): Vec2[] {
	if (originPoints.length <= 1) {
		return buildInitialTrace(originPoints[0] ?? target, target, cornerMode);
	}
	if (originPoints.length === 2) {
		const dir = Direction45.fromSegment(originPoints[0]!, originPoints[1]!, false);
		return buildInitialTrace(originPoints[0]!, target, cornerMode, dir.isDiagonal());
	}

	const segCount = originPoints.length - 1;
	let picked: Vec2[] | null = null;
	let iPicked = -1;

	for (let i = segCount - 1; i >= 0 && !picked; i--) {
		const pStart = originPoints[i]!;
		const dStart = Direction45.fromSegment(pStart, originPoints[i + 1]!, false);
		const dPrev = i > 0 ? Direction45.fromSegment(originPoints[i - 1]!, pStart, false) : null;

		const candidates: { path: Vec2[]; dir: Direction45 }[] = [];
		for (const startDiagonal of [false, true]) {
			const path = buildInitialTrace(pStart, target, cornerMode, startDiagonal);
			if (path.length < 2) {
				continue;
			}
			candidates.push({ path, dir: Direction45.fromSegment(path[0]!, path[1]!, false) });
		}

		for (const candidate of candidates) {
			if (candidate.dir.equals(dStart)) {
				picked = candidate.path;
				iPicked = i;
				break;
			}
		}
		if (picked) {
			break;
		}

		if (dPrev) {
			for (const candidate of candidates) {
				if (candidate.dir.isObtuse(dPrev)) {
					picked = candidate.path;
					iPicked = i;
					break;
				}
			}
		}
	}

	if (picked) {
		return [...originPoints.slice(0, iPicked + 1), ...picked.slice(1)];
	}

	const dirLast = Direction45.fromSegment(
		originPoints[originPoints.length - 2]!, originPoints[originPoints.length - 1]!, false);
	return buildInitialTrace(originPoints[0]!, target, cornerMode, dirLast.isDiagonal());
}
