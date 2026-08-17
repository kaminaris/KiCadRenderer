import { pointInPolygon } from '../paint/PaintedShape';

type Pt = { x: number; y: number };

/**
 * Direct algorithmic port of real KiCad's interactive-router walkaround —
 * `PNS::LINE::Walkaround()` in pcbnew/router/pns_line.cpp of the KiCad
 * source tree (Copyright (C) 2013-2014 CERN, Copyright The KiCad
 * Developers; GNU GPL v3+, see <https://www.gnu.org/licenses/>). Ported by
 * explicit request/decision after this router's earlier hand-derived
 * approximation (a bounding-circle-only walk) kept producing visibly wrong
 * shapes against real obstacle outlines — see
 * [[kicad-viewer-interactive-router-port]] memory for the licensing
 * discussion that authorized this. This file is a GPL-licensed derivative
 * work of KiCad; unlike every other file in this router (all original,
 * KiCad used only as a read-only behavioral reference), this one is a
 * genuine translation of KiCad's own algorithm and control flow, adapted
 * from SHAPE_LINE_CHAIN (a full arc-aware polyline class with its own
 * indexed-split/self-intersection machinery) to plain closed/open point
 * arrays — this router's candidate paths are always short (2-3 points, one
 * corner) and never self-intersect, so the SelfIntersecting() special case
 * for looped tracks is intentionally not ported (dead code for this
 * caller). Variable names (pnew/hnew/vts/v/v_prev/v_next/areNeighbours/
 * appendV/inLast/lastDst) are kept close to the original for traceability
 * against the source file this was translated from.
 */

const EPS = 1e-6;

function ptEq(a: Pt, b: Pt, eps = EPS): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= eps;
}

function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
	const dx = b.x - a.x, dy = b.y - a.y;
	const lenSq = dx * dx + dy * dy;
	if (lenSq < 1e-12) {
		return { x: a.x, y: a.y };
	}
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
	return { x: a.x + t * dx, y: a.y + t * dy };
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
	const n = nearestOnSegment(p, a, b);
	return Math.hypot(p.x - n.x, p.y - n.y);
}

function pointOnClosedPolygonEdge(p: Pt, poly: Pt[], eps = EPS): boolean {
	const n = poly.length;
	for (let i = 0; i < n; i++) {
		if (distToSeg(p, poly[i]!, poly[(i + 1) % n]!) <= eps) {
			return true;
		}
	}
	return false;
}

function segSegIntersection(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
	const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
	const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
	const denom = d1x * d2y - d1y * d2x;
	if (Math.abs(denom) < 1e-12) {
		return null;
	}
	const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
	const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
	if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) {
		return null;
	}
	return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

/** Real KiCad's `HullIntersection` — every point where the (open) path
 *  crosses the (closed) hull boundary. */
function pathHullIntersections(path: Pt[], hull: Pt[]): Pt[] {
	const ips: Pt[] = [];
	const n = hull.length;
	for (let i = 0; i < path.length - 1; i++) {
		for (let j = 0; j < n; j++) {
			const ip = segSegIntersection(path[i]!, path[i + 1]!, hull[j]!, hull[(j + 1) % n]!);
			if (ip) {
				ips.push(ip);
			}
		}
	}
	return ips;
}

/** Real KiCad's `SHAPE_LINE_CHAIN::Split` for an open polyline — inserts
 *  `p` as a new vertex on whichever existing edge contains it, unless a
 *  vertex already sits there. */
function splitOpenPolyline(poly: Pt[], p: Pt): void {
	if (poly.some(q => ptEq(q, p))) {
		return;
	}
	for (let i = 0; i < poly.length - 1; i++) {
		if (distToSeg(p, poly[i]!, poly[i + 1]!) <= EPS) {
			poly.splice(i + 1, 0, p);
			return;
		}
	}
}

/** Same as splitOpenPolyline but for a closed polygon (the hull) — the
 *  last→first wraparound edge counts too. */
function splitClosedPolygon(poly: Pt[], p: Pt): void {
	if (poly.some(q => ptEq(q, p))) {
		return;
	}
	const n = poly.length;
	for (let i = 0; i < n; i++) {
		if (distToSeg(p, poly[i]!, poly[(i + 1) % n]!) <= EPS) {
			poly.splice(i + 1, 0, p);
			return;
		}
	}
}

type VertexType = 'inside' | 'outside' | 'on-edge';

interface Vertex {
	type: VertexType;
	isHull: boolean;
	pos: Pt;
	neighbours: Vertex[];
	indexp: number;
	indexh: number;
	visited: boolean;
}

/** `areNeighbours` from the source — true iff x/y are adjacent indices in
 *  a linear (non-cyclic) 0..max-1 range. */
function areNeighbours(x: number, y: number, max: number): boolean {
	return (x > 0 && x - 1 === y) || (x < max - 1 && x + 1 === y);
}

/**
 * Ported `LINE::Walkaround`. `path` must have at least 2 points (the leg
 * being routed); `hull` is the obstacle's closed clearance polygon (see
 * PnsHull.ts). `cw` selects which way around the hull to walk — callers
 * try both and keep whichever succeeds / is shorter, matching real KiCad's
 * WP_CW/WP_CCW/WP_SHORTEST policies (see pns_walkaround.cpp). Returns null
 * on any of the source's own failure paths (start point buried inside the
 * hull, the graph search getting stuck, or the safety iteration limit).
 */
export function pnsWalkaround(path: Pt[], hull: Pt[], cw: boolean, onFail?: (reason: string, info?: Record<string, unknown>) => void): Pt[] | null {
	// Real KiCad simplifies the line before walking it (LINE_PLACER::
	// rhWalkBase: "initTrack.Line().Simplify();") — collapses consecutive
	// duplicate points. Without this, a path whose last two points are
	// identical (which THIS function itself can produce — see the
	// "destination buried" early-termination near the bottom, which can
	// append a point equal to the path's own existing last point when that
	// point already sits exactly on the hull it's terminating against; a
	// walkAroundObstacles caller re-walking that result around a further
	// obstacle hands it straight back in here) creates two distinct
	// vertex-graph nodes at the same position: whichever one the hull
	// happens to merge into its own graph (by array-scan order) is
	// reachable, but the OTHER one — the actual vertex the main loop's exit
	// condition (`v.indexp !== pnew.length - 1`) is looking for — never is,
	// since none of the on-edge transition branches below select a vertex
	// with indexh === -1. The walk then has no way to terminate and cycles
	// the hull boundary forever (confirmed against a real user report: a
	// well-formed 8-point octagon hull, hitting the 1000-iteration cap on
	// both windings, purely because of this duplicate-point degeneracy —
	// see [[kicad-viewer-interactive-router-port]]).
	const deduped: Pt[] = [];
	for (const p of path) {
		if (!deduped.length || !ptEq(deduped[deduped.length - 1]!, p)) {
			deduped.push(p);
		}
	}
	path = deduped;
	if (path.length < 2 || hull.length < 3) {
		onFail?.('degenerate path/hull');
		return null;
	}
	const pFirst = path[0]!;
	const inFirst = pointInPolygon(hull, pFirst.x, pFirst.y) && !pointOnClosedPolygonEdge(pFirst, hull);
	if (inFirst) {
		onFail?.('start point buried inside obstacle hull');
		return null;
	}

	const pnew: Pt[] = path.map(p => ({ x: p.x, y: p.y }));
	let hnew: Pt[] = hull.map(p => ({ x: p.x, y: p.y }));

	const intersections = pathHullIntersections(pnew, hnew);
	for (const ip of intersections) {
		splitOpenPolyline(pnew, ip);
		splitClosedPolygon(hnew, ip);
	}
	for (const p of pnew) {
		if (pointOnClosedPolygonEdge(p, hnew) && !hnew.some(q => ptEq(q, p))) {
			splitClosedPolygon(hnew, p);
		}
	}

	if (!cw) {
		hnew = hnew.slice().reverse();
	}

	const vts: Vertex[] = [];
	const findVertex = (pos: Pt): Vertex | undefined => vts.find(v => ptEq(v.pos, pos));

	for (let i = 0; i < pnew.length; i++) {
		const p = pnew[i]!;
		const onEdge = pointOnClosedPolygonEdge(p, hnew);
		const inside = pointInPolygon(hnew, p.x, p.y);
		vts.push({
			type: inside && !onEdge ? 'inside' : onEdge ? 'on-edge' : 'outside',
			isHull: false, pos: p, neighbours: [], indexp: i, indexh: -1, visited: false,
		});
	}
	for (let i = 0; i < pnew.length - 1; i++) {
		vts[i]!.neighbours.push(vts[i + 1]!);
	}
	for (let i = 1; i < pnew.length; i++) {
		vts[i]!.neighbours.push(vts[i - 1]!);
	}

	for (let i = 0; i < hnew.length; i++) {
		const hp = hnew[i]!;
		const existing = findVertex(hp);
		if (existing) {
			existing.isHull = true;
			existing.indexh = i;
		}
		else {
			vts.push({ type: 'on-edge', isHull: true, pos: hp, neighbours: [], indexp: -1, indexh: i, visited: false });
		}
	}
	for (let i = 0; i < hnew.length; i++) {
		const vc = findVertex(hnew[i]!);
		const vn = findVertex(hnew[(i + 1) % hnew.length]!);
		if (vc && vn) {
			vc.neighbours.push(vn);
		}
	}

	const pathLast = path[path.length - 1]!;
	const inLast = pointInPolygon(hnew, pathLast.x, pathLast.y) && !pointOnClosedPolygonEdge(pathLast, hnew);
	let lastDst = Infinity;

	let v: Vertex | undefined = vts[0];
	let vPrev: Vertex | undefined;
	const out: Pt[] = [];
	let appendV = true;
	let iterLimit = 1000;
	const trace: { x: number; y: number; type: VertexType; indexh: number; indexp: number; isHull: boolean }[] = [];

	walk: while (v && v.indexp !== pnew.length - 1) {
		iterLimit--;
		trace.push({ x: v.pos.x, y: v.pos.y, type: v.type, indexh: v.indexh, indexp: v.indexp, isHull: v.isHull });
		if (trace.length > 20) {
			trace.shift();
		}
		if (iterLimit <= 0) {
			onFail?.('graph traversal iteration limit (1000)', {
				intersectionCount: intersections.length,
				pnewLen: pnew.length, hnewLen: hnew.length,
				pFirstType: vts[0]?.type, pLastOnHull: inLast,
				lastTrace: trace,
			});
			return null;
		}
		if (v.visited) {
			break;
		}
		out.push(v.pos);

		let vNext: Vertex | undefined;

		if (v.type === 'outside') {
			let fallback: Vertex | undefined;
			for (const vn of v.neighbours) {
				if (areNeighbours(vn.indexp, v.indexp, pnew.length) && vn.type !== 'inside') {
					if (!vn.visited) {
						vNext = vn;
						break;
					}
					else if (vn !== vPrev) {
						fallback = vn;
					}
				}
			}
			if (!vNext) {
				vNext = fallback;
			}
			if (!vNext) {
				onFail?.('no outside/on-edge neighbour to continue from (outside vertex)');
				return null;
			}
		}
		else if (v.type === 'on-edge') {
			for (const vn of v.neighbours) {
				if (vn.type === 'outside' && !vn.visited) {
					vNext = vn;
					break;
				}
			}
			if (!vNext) {
				for (const vn of v.neighbours) {
					if (vn.type === 'on-edge' && !vn.isHull
						&& areNeighbours(vn.indexp, v.indexp, pnew.length)
						&& vn.indexh === (v.indexh + 1) % hnew.length) {
						vNext = vn;
						break;
					}
				}
			}
			if (!vNext) {
				for (const vn of v.neighbours) {
					if (vn.type === 'on-edge' && vn.indexh === (v.indexh + 1) % hnew.length) {
						vNext = vn;
						break;
					}
				}
				if (vNext) {
					for (const vt of vts) {
						if (vt.isHull) {
							vt.visited = false;
						}
					}
				}
				if (inLast && vNext) {
					const d = (vNext.pos.x - pathLast.x) ** 2 + (vNext.pos.y - pathLast.y) ** 2;
					if (d < lastDst) {
						lastDst = d;
					}
					else {
						// The real destination sits INSIDE this obstacle (inLast) and
						// we've now passed the closest hull approach to it — walking
						// further would just circle the whole hull and come back to
						// the start. Real KiCad stops here: append the point on this
						// hull edge nearest the true destination and terminate the
						// WHOLE walk (not just this branch) — matching the source's
						// own `break` here, which exits the enclosing while loop, not
						// a for-loop (this is the one spot in this port where an
						// earlier translation pass mis-scoped that break, causing an
						// infinite hull-circling loop whenever a route's endpoint
						// landed inside the obstacle it was walking around — see
						// [[kicad-viewer-interactive-router-port]] memory).
						out.push(nearestOnSegment(pathLast, v.pos, vNext.pos));
						appendV = false;
						break walk;
					}
				}
			}
		}

		v.visited = true;
		vPrev = v;
		v = vNext;
		if (!v) {
			onFail?.('no continuation vertex found (on-edge vertex)');
			return null;
		}
	}

	if (appendV && v) {
		out.push(v.pos);
	}
	return out;
}

export function pathLength(points: Pt[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
	}
	return total;
}

/** Convenience wrapper matching real KiCad's WP_SHORTEST policy — tries
 *  both winding directions around the hull and keeps whichever succeeds,
 *  preferring the shorter path if both do. `path` (not just a bare from/to
 *  pair) so this composes with BoardPointerController's iterative multi-
 *  obstacle walk (walkAroundObstacles) — each step re-walks the CURRENT
 *  best path, which already has bends from earlier obstacles, around the
 *  next one it hits, exactly like real KiCad's own WALKAROUND::Route()
 *  iteration loop (pns_walkaround.cpp) keeps re-walking the same evolving
 *  LINE.
 *
 *  `simplify`, when given, is applied to EACH winding's raw result before
 *  the length comparison — matching real KiCad's `rhWalkBase`, which runs
 *  `OPTIMIZER::Optimize(..., MERGE_SEGMENTS, ...)` on both `wr.lines[WP_CW]`
 *  and `wr.lines[WP_CCW]` before picking the shorter one (simplification
 *  can change which winding ends up shorter, so it has to happen first,
 *  not after). Callers pass `PnsOptimizer.simplifyWalkedPath` bound to
 *  their own obstacle-collision check; omitted here (rather than importing
 *  PnsOptimizer directly) to keep this file's only obstacle-world
 *  knowledge being the one hull it's asked to walk around. */
export function walkaroundHull(
	path: Pt[], hull: Pt[],
	onFail?: (reason: string, info?: Record<string, unknown>) => void,
	simplify?: (path: Pt[]) => Pt[],
): Pt[] | null {
	const cwRaw = pnsWalkaround(path, hull, true, (reason, info) => onFail?.(`cw: ${ reason }`, info));
	const ccwRaw = pnsWalkaround(path, hull, false, (reason, info) => onFail?.(`ccw: ${ reason }`, info));
	const cwResult = cwRaw && simplify ? simplify(cwRaw) : cwRaw;
	const ccwResult = ccwRaw && simplify ? simplify(ccwRaw) : ccwRaw;
	if (cwResult && ccwResult) {
		return pathLength(cwResult) <= pathLength(ccwResult) ? cwResult : ccwResult;
	}
	return cwResult ?? ccwResult ?? null;
}
