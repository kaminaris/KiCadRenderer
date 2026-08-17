type Pt = { x: number; y: number };

/**
 * Literal port of real KiCad's walkaround-result simplification —
 * `OPTIMIZER::mergeFull`/`mergeStep` and the `CornerCost`/
 * `BuildInitialTrace` helpers they depend on (pcbnew/router/
 * pns_optimizer.cpp, libs/kimath/src/geometry/direction_45.cpp —
 * Copyright CERN/KiCad Developers, GPLv3+). Real KiCad's own
 * `LINE_PLACER::rhWalkBase` runs this (as `OPTIMIZER::MERGE_SEGMENTS`) on
 * every walkaround result before picking between cw/ccw — a raw
 * `walkaroundHull()` result faithfully hugs every vertex of whatever
 * obstacle hull it had to pass, which is correct but not minimal (this was
 * the visible gap between this router's "hugs the whole top of the
 * octagon" output and real KiCad's clean 2-bend trapezoid for the same
 * obstacle — see [[kicad-viewer-interactive-router-port]]). This is that
 * missing simplification pass.
 *
 * Ported scope: just the MERGE_SEGMENTS strategy (the one real KiCad
 * actually applies for this purpose). The other strategies (MERGE_OBTUSE,
 * SMART_PADS, FANOUT_CLEANUP, diff-pair merging, the interactive-drag-only
 * corner-count/area/topology constraints) belong to a different part of
 * this app's scope (pad fanout cleanup, differential pairs, live-drag
 * behavior) — not ported.
 */

/** `DIRECTION_45::BuildInitialTrace` for `CORNER_MODE::MITERED_45` (the
 *  only mode this app's '45' corner setting uses) — exact port of
 *  direction_45.cpp:24-103's w/h/sw/sh construction. `startDiagonal`
 *  chooses which of the two valid mitered paths between `from`/`to` to
 *  build: true puts the 45° leg first (this already matches this app's
 *  existing `BoardPointerController.miterPath`/`buildRoutePath`); false
 *  puts the straight leg first — the alternate posture the optimizer needs
 *  to try when looking for a shorter/lower-cost bypass. */
export function buildInitialTrace45(from: Pt, to: Pt, startDiagonal: boolean): Pt[] {
	const dx = to.x - from.x, dy = to.y - from.y;
	const w = Math.abs(dx), h = Math.abs(dy);
	if (w < 1e-9 || h < 1e-9 || Math.abs(w - h) < 1e-9) {
		return [from, to];
	}
	const sw = Math.sign(dx), sh = Math.sign(dy);
	const mp = startDiagonal
		? (w > h ? { x: h * sw, y: h * sh } : { x: w * sw, y: w * sh })
		: (w > h ? { x: (w - h) * sw, y: 0 } : { x: 0, y: (h - w) * sh });
	return [from, { x: from.x + mp.x, y: from.y + mp.y }, to];
}

/** `DIRECTION_45`'s 8-octant classification + `Angle()`/`CornerCost`
 *  pairing (direction45.h's `AngleType` enum, pns_optimizer.cpp:44-56's
 *  `COST_ESTIMATOR::CornerCost(SEG,SEG)`) — real KiCad quantizes every
 *  segment direction into 8 compass octants and costs the transition
 *  between two consecutive segments by how many octant-steps apart they
 *  are: 1 step (45°, a gentle diagonal chamfer) is cheap, all the way up
 *  to 4 steps (180°, a straight reversal) being the most expensive. Since
 *  every segment this router ever produces is axis-aligned or exactly 45°
 *  (see PnsHull.ts's octagon-only hulls, and PnsWalkaround.test.ts's
 *  45°-invariant regression test), this octant math is exact for our
 *  paths, not an approximation. */
function directionOctant(dx: number, dy: number): number {
	const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
	return ((oct % 8) + 8) % 8;
}

/** Indexed by octant-step distance 0..4 — real KiCad's exact values
 *  (ANG_STRAIGHT=5, ANG_OBTUSE=10, ANG_RIGHT=30, ANG_ACUTE=50,
 *  ANG_HALF_FULL=60). */
const CORNER_COST_BY_OCTANT_STEP = [5, 10, 30, 50, 60];

function turnCost(a: Pt, b: Pt, c: Pt): number {
	const d1 = directionOctant(b.x - a.x, b.y - a.y);
	const d2 = directionOctant(c.x - b.x, c.y - b.y);
	const step = Math.min(Math.abs(d1 - d2), 8 - Math.abs(d1 - d2));
	return CORNER_COST_BY_OCTANT_STEP[step] ?? 100;
}

function cornerCost(path: Pt[]): number {
	let total = 0;
	for (let i = 1; i < path.length - 1; i++) {
		total += turnCost(path[i - 1]!, path[i]!, path[i + 1]!);
	}
	return total;
}

function pointsEqual(a: Pt, b: Pt, eps = 1e-9): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= eps;
}

/** `OPTIMIZER::mergeStep` — for a given `step` (how many segments to try
 *  bypassing in one shot), scans every position and, on the first spot
 *  where a direct mitered-45 "bypass" between the span's endpoints is both
 *  collision-free and strictly cheaper (`CornerCost`) than what's there
 *  now, replaces that whole span with the bypass and returns immediately
 *  (greedy — matches the source exactly, including trying both
 *  `BuildInitialTrace` postures and keeping whichever of the two is
 *  cheaper). */
function mergeStep(path: Pt[], step: number, collides: (a: Pt, b: Pt) => boolean): Pt[] | null {
	const nSegs = path.length - 1;
	const costOrig = cornerCost(path);
	for (let n = 0; n <= nSegs - step - 1; n++) {
		const spanStart = path[n]!;
		const spanEnd = path[n + step + 1]!;
		let picked: Pt[] | null = null;
		let pickedCost = Infinity;
		for (const startDiagonal of [false, true]) {
			const bypass = buildInitialTrace45(spanStart, spanEnd, startDiagonal);
			let ok = true;
			for (let i = 1; i < bypass.length && ok; i++) {
				if (collides(bypass[i - 1]!, bypass[i]!)) {
					ok = false;
				}
			}
			if (!ok) {
				continue;
			}
			const candidate = [...path.slice(0, n), ...bypass, ...path.slice(n + step + 2)];
			const cost = cornerCost(candidate);
			if (cost < costOrig && cost < pickedCost) {
				picked = candidate;
				pickedCost = cost;
			}
		}
		if (picked) {
			return picked;
		}
	}
	return null;
}

/** `OPTIMIZER::mergeFull` — repeatedly tries the LARGEST possible bypass
 *  span first (most aggressive simplification), re-trying the same span
 *  size after every success (the path just got shorter, so a
 *  same-or-bigger shortcut might now reach further), falling back to
 *  smaller spans only once a size stops finding anything. `collides`
 *  should check a candidate segment against the full obstacle world (not
 *  just the one hull the path was originally walked around) — a
 *  simplification is only valid if it stays clear of everything, matching
 *  real KiCad's own `checkColliding` (which queries the whole `NODE`). */
export function simplifyWalkedPath(inputPath: Pt[], collides: (a: Pt, b: Pt) => boolean): Pt[] {
	let current: Pt[] = [];
	for (const p of inputPath) {
		if (!current.length || !pointsEqual(current[current.length - 1]!, p)) {
			current.push(p);
		}
	}
	if (current.length < 3) {
		return current;
	}
	let step = current.length - 2;
	while (step >= 1) {
		const nSegs = current.length - 1;
		const maxStep = nSegs - 2;
		if (step > maxStep) {
			step = maxStep;
		}
		if (step < 1) {
			break;
		}
		const merged = mergeStep(current, step, collides);
		if (merged) {
			current = merged;
			continue;
		}
		step--;
	}
	return current;
}
