import { pointInPolygonCoords as pointInPolygon } from '../geometry/polygon';
import { pnsWalkaround } from './PnsWalkaround';
import { buildClearanceHull } from './PnsHull';
import { segmentSegmentDistance } from '../geometry/ShapeCollision';
import { closestPointOnSegment } from '../geometry/ShapeLineChain';
import { Vec2 } from '../math/Vec2';

type Pt = { x: number; y: number };

/**
 * Direct algorithmic port of real KiCad's push-and-shove core —
 * `SHOVE::checkShoveDirection()`, `SHOVE::shoveLineToHullSet()`, and
 * `SHOVE::ShoveObstacleLine()` in pcbnew/router/pns_shove.cpp (Copyright
 * (C) 2013-2017 CERN, Copyright The KiCad Developers; GNU GPL v3+, see
 * <https://www.gnu.org/licenses/>). Ported by explicit user decision
 * (2026-08-28) to treat this session's "copy 1:1" instruction as
 * superseding the router's earlier narrower GPL-derivative scope (see
 * PnsWalkaround.ts's own header for that history) — this is a genuine
 * translation of KiCad's algorithm and control flow, not an independent
 * approximation, adapted from `SHAPE_LINE_CHAIN`/`LINE`/`SEGMENT` to
 * plain point arrays + width, the same adaptation `PnsWalkaround.ts`
 * already made for the walkaround primitives this file builds on.
 *
 * This is `pns_shove.cpp`'s single-obstacle shove geometry ONLY — a
 * ~2650-line file's ~350-line geometric core. Deliberately NOT ported
 * (each a real, separate, much larger piece of the real `SHOVE` class):
 * - Node-versioning/springback (`NODE* aNode` cloning,
 *   `pushSpringback()`/`reduceSpringback()`/`RewindSpringbackTo()`)
 *   — confirmed (2026-08-28) this is a non-issue for THIS architecture,
 *   not a missing feature: real KiCad needs springback because its
 *   `SHOVE::Run()` mutates a live, shared `NODE` tree incrementally as it
 *   walks the line stack, so a late failure requires undoing earlier
 *   mutations already applied to that speculative tree. This port's
 *   `shoveObstacleLineCascade()`/`PnsRouter.planShoveForPath()` never
 *   mutate anything — they compute an entire multi-step plan against an
 *   immutable `RouterNode` snapshot and return either the WHOLE plan or
 *   `null`; the caller only ever applies a fully-computed, already-
 *   validated plan to the real AST in one atomic commit
 *   (`KicadRenderSession.shoveTrackSegment`/`shoveVia`). There is no
 *   intermediate state to roll back from, by construction — the
 *   snapshot-then-atomic-commit design achieves what springback exists
 *   to guarantee (a failed shove attempt never leaves the board
 *   half-shoved) through a different mechanism, not a smaller one.
 * - The REAL line-stack/cascade orchestration (`Run()`, `shoveMainLoop()`,
 *   `shoveIteration()`, `pushLineStack()`/`popLineStack()`, all stateful
 *   methods walking a `NODE`-tree/line-stack this pure-function port has
 *   no equivalent for) isn't ported. `shoveObstacleLineCascade()` below
 *   is a bounded, simplified STAND-IN — a plain iterative "shove, then
 *   if that collides with something else shove IT too, up to a depth
 *   limit" loop, not a literal translation of the real orchestration's
 *   control flow: it always cascades in the single direction the first
 *   collision was found, never re-processing an earlier line in the
 *   stack the way real KiCad's `pushLineStack()` can, and simply reports
 *   failure (returns `null`) if the depth limit is hit without resolving
 *   — which, per the point above, is a complete, correct outcome for
 *   this design, not a springback substitute standing in for a missing
 *   rollback.
 * - Via handling: `pushOrShoveVia()`/`onCollidingVia()` themselves ARE
 *   ported (see `computeViaPushForce()` below and
 *   `KicadRenderSession.shoveVia()`, 2026-08-28) by reusing this app's
 *   pre-existing via-drag connectivity/reflow machinery
 *   (`viaDragFanout`/`dragViaChain`/`commitViaDrag`) — NOT by building a
 *   new `NODE`/`JOINT` system, which turned out to be unnecessary once
 *   actually investigated. Still not ported: `onReverseCollidingVia()`'s
 *   via-ends-a-line case, `fixupViaCollisions()`, `patchTadpoleVia()`,
 *   and cascading a via-push into a further obstacle (single-level only,
 *   matching the plain-segment cascade's own scope).
 * - Arc segments (`aCurLine.CLine().IsArcSegment()`'s extra hull
 *   clearance) — not shove-specific: this whole interactive router (drag,
 *   walkaround, via-drag fanout) treats `TrackArc` as out of scope
 *   consistently, so arc support would need to be a router-wide addition,
 *   not a shove-only patch.
 * - `permitAdjustingEndpoints`'s hull-snapped-endpoint extension
 *   (`shoveLineToHullSet()`'s `minDistP` closure) isn't ported — always
 *   runs as if `aPermitAdjustingStart`/`aPermitAdjustingEnd` are false.
 * - `path.SelfIntersecting()` isn't ported — same rationale
 *   `PnsWalkaround.ts` gives for skipping it (candidate paths here are
 *   short and don't self-intersect in practice).
 * - `checkShoveDirection()`'s real `SHAPE_LINE_CHAIN::POINT_INSIDE_TRACKER`
 *   (built to handle a pair of open polylines robustly, including
 *   self-intersecting combinations) is approximated here as a plain
 *   even-odd point-in-polygon test over the closed ring formed by
 *   [obstacle path, reversed shoved path] — exact for the common case,
 *   less robust than the real tracker for degenerate/self-intersecting
 *   combined geometry.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-3.0-or-later.
 */

/** Port of `checkShoveDirection()` (pns_shove.cpp:243) — true if the
 *  shoved obstacle path actually moved AWAY from the pushing line's
 *  reference point (`aCheckerPoint`, real KiCad: the pusher's start
 *  point, or its last point when the pusher is itself a reversed drag
 *  head — this port takes the point directly from the caller since it
 *  doesn't model that reversed-head case) rather than into it. */
export function checkShoveDirection(checkerPoint: Pt, obstaclePath: Pt[], shovedPath: Pt[]): boolean {
	const ring = [...obstaclePath, ...[...shovedPath].reverse()];
	const inside = pointInPolygon(ring, checkerPoint.x, checkerPoint.y);
	return !inside;
}

/**
 * Port of `shoveLineToHullSet()` (pns_shove.cpp:328) — re-walks
 * `obstaclePath` around every hull in `hulls` in sequence, trying all 4
 * winding/traversal-order combinations real KiCad tries, and accepts the
 * first result that: still starts/ends at the obstacle's original
 * endpoints, passes `checkShoveDirection()`, and doesn't collide with the
 * pusher (via the caller-supplied `collidesWithPusher` predicate — kept
 * external rather than importing this router's collision world directly,
 * matching `PnsWalkaround.ts`'s `walkaroundHull()` convention).
 */
export function shoveLineToHullSet(
	pusherCheckerPoint: Pt,
	obstaclePath: Pt[],
	hulls: Pt[][],
	collidesWithPusher: (path: Pt[]) => boolean,
): Pt[] | null {
	if (obstaclePath.length < 2) return null;
	const obsStart = obstaclePath[0]!;
	const obsEnd = obstaclePath[obstaclePath.length - 1]!;

	for (let attempt = 0; attempt < 4; attempt++) {
		const invertTraversal = attempt >= 2;
		const clockwise = attempt % 2 === 1;

		let path: Pt[] = obstaclePath;
		let failWalk = false;

		for (let i = 0; i < hulls.length; i++) {
			const hull = hulls[invertTraversal ? hulls.length - 1 - i : i]!;
			const next = pnsWalkaround(path, hull, clockwise);
			if (!next) {
				failWalk = true;
				break;
			}
			path = next;
		}

		if (failWalk) continue;

		// Port of the vFirst/vLast + endpoint-preservation checks: hull
		// walking only bulges the path's middle, so a valid result must
		// still start and end at the original obstacle's own endpoints.
		const pathStart = path[0]!;
		const pathEnd = path[path.length - 1]!;
		if (!ptEq(pathStart, obsStart) || !ptEq(pathEnd, obsEnd)) continue;

		if (!checkShoveDirection(pusherCheckerPoint, obstaclePath, path)) continue;

		if (collidesWithPusher(path)) continue;

		return path;
	}

	return null;
}

function ptEq(a: Pt, b: Pt, eps = 1e-6): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= eps;
}

/**
 * Port of `ShoveObstacleLine()`'s plain-segment case (pns_shove.cpp:521 —
 * the `shoveLineFromLoneVia()` lone-via branch isn't ported, see file
 * header). Builds one clearance hull per segment of the PUSHING line
 * (`pusherSegments`), inflated by `clearance + obstacleWidth/2` exactly
 * like real KiCad's `SEGMENT::Hull(clearance, walkaroundThickness)`
 * (`pns_utils.cpp`'s `cl = aClearance + aWalkaroundThickness / 2`), then
 * re-walks the obstacle's path around that whole hull set. Retries up to
 * 3 times with progressively larger hull expansion on failure, matching
 * the real function's own `cHullFailureExpansionFactor` retry loop
 * (`extraHullExpansion`, real KiCad: 1000 IU per retry — this port's
 * expansion step is in mm, scaled down accordingly).
 */
export function shoveObstacleLine(
	pusherSegments: { a: Pt; b: Pt; width: number }[],
	pusherCheckerPoint: Pt,
	obstaclePath: Pt[],
	obstacleWidth: number,
	clearance: number,
	collidesWithPusher: (path: Pt[]) => boolean,
): Pt[] | null {
	const cHullFailureExpansionMm = 0.01; // real KiCad: 1000 IU (~0.01mm at 1e5 IU/mm)
	let extraExpansion = 0;

	for (let attempt = 0; attempt < 3; attempt++) {
		const hulls: Pt[][] = pusherSegments.map(seg =>
			buildClearanceHull(
				{ type: 'segment', x1: seg.a.x, y1: seg.a.y, x2: seg.b.x, y2: seg.b.y, width: seg.width },
				clearance + extraExpansion + obstacleWidth / 2,
			)
		);

		const result = shoveLineToHullSet(pusherCheckerPoint, obstaclePath, hulls, collidesWithPusher);
		if (result) return result;

		extraExpansion += cHullFailureExpansionMm;
	}

	return null;
}

/** One obstacle moved by `shoveObstacleLineCascade()`. */
export interface ShoveCascadeMove {
	id: string;
	shovedPath: Pt[];
}

/** What a cascade caller's world lookup needs to report back per query —
 *  the colliding obstacle's own id/path/width, everything
 *  `shoveObstacleLine()` needs to try shoving IT in turn. */
export interface ShoveCascadeCollision {
	id: string;
	path: Pt[];
	width: number;
}

/**
 * Bounded, simplified stand-in for real KiCad's line-stack cascade
 * (`SHOVE::Run()`/`shoveMainLoop()`/`shoveIteration()`,
 * `pushLineStack()`/`popLineStack()`) — NOT a literal translation of
 * those (they're stateful methods walking a `NODE`-tree/line-stack this
 * pure-function port has no equivalent for; see this file's own header).
 * This is a plain iterative loop: shove the first obstacle, and if the
 * result still collides with something else, try shoving THAT obstacle
 * too, up to `maxDepth` obstacles total, each move excluding every
 * obstacle already moved earlier in the same cascade from its own
 * collision checks (they're being relocated too, so their ORIGINAL
 * position shouldn't block a later move in the same cascade).
 *
 * `findCollision(path, excludeIds)` is the caller's live-world lookup,
 * used to find what a just-shoved result now collides with (kept
 * external — same reasoning as `shoveObstacleLine()`'s own
 * `collidesWithPusher` callback — so this file stays decoupled from
 * `RouterNode` specifically). Each cascade step's own pusher-only
 * collision check (real KiCad's `l.Collide(&aCurLine, ...)`) is computed
 * internally instead, from `currentPusherSegments` directly — it must
 * NOT be the same "collides with anything" query `findCollision` runs,
 * or a shove that correctly moves an obstacle out of the PUSHER's way
 * but into a DIFFERENT obstacle's way (exactly the case this cascade
 * exists to handle) would be rejected before ever reaching the recursion
 * step below.
 */
export function shoveObstacleLineCascade(
	pusherSegments: { a: Pt; b: Pt; width: number }[],
	pusherCheckerPoint: Pt,
	firstObstacle: { id: string; path: Pt[]; width: number },
	clearance: number,
	findCollision: (candidatePath: Pt[], excludeIds: readonly string[]) => ShoveCascadeCollision | null,
	maxDepth = 3,
): ShoveCascadeMove[] | null {
	const moves: ShoveCascadeMove[] = [];
	const movedIds: string[] = [];
	let currentPusherSegments = pusherSegments;
	let currentPusherCheckerPoint = pusherCheckerPoint;
	let obstacle = firstObstacle;

	for (let depth = 0; depth < maxDepth; depth++) {
		movedIds.push(obstacle.id);

		// Port of `l.Collide(&aCurLine, ...)` inside `shoveLineToHullSet()` —
		// checked against the CURRENT pusher's own segments only (real
		// KiCad's own scope for this check), not the whole world; a
		// collision with some OTHER obstacle is exactly what should make it
		// through here so the cascade can go shove that one next.
		const pusherWidth = currentPusherSegments[0]?.width ?? 0;
		const collidesWithPusher = (candidatePath: Pt[]): boolean => {
			const minDist = pusherWidth / 2 + obstacle.width / 2 + clearance;
			for (const seg of currentPusherSegments) {
				for (let j = 1; j < candidatePath.length; j++) {
					const dist = segmentSegmentDistance(
						new Vec2(candidatePath[j - 1]!.x, candidatePath[j - 1]!.y),
						new Vec2(candidatePath[j]!.x, candidatePath[j]!.y),
						new Vec2(seg.a.x, seg.a.y), new Vec2(seg.b.x, seg.b.y),
					);
					if (dist < minDist - 1e-9) return true;
				}
			}
			return false;
		};

		const shoved = shoveObstacleLine(
			currentPusherSegments, currentPusherCheckerPoint, obstacle.path, obstacle.width, clearance,
			collidesWithPusher,
		);
		if (!shoved) return null;

		moves.push({ id: obstacle.id, shovedPath: shoved });

		const next = findCollision(shoved, movedIds);
		if (!next) return moves;

		// The just-shoved line becomes the pusher for the next cascade step
		// (real KiCad: the newly-repositioned line is pushed onto the same
		// line stack and re-processed exactly like any other pusher).
		currentPusherSegments = pathToSegments(shoved, obstacle.width);
		currentPusherCheckerPoint = shoved[0]!;
		obstacle = next;
	}

	return null; // exceeded maxDepth without resolving — matches real KiCad
	// giving up and reverting the whole attempt (springback) once it can't
	// find a clean resolution; this port just reports failure instead.
}

function pathToSegments(path: Pt[], width: number): { a: Pt; b: Pt; width: number }[] {
	const segments: { a: Pt; b: Pt; width: number }[] = [];
	for (let i = 1; i < path.length; i++) {
		segments.push({ a: path[i - 1]!, b: path[i]!, width });
	}
	return segments;
}

/**
 * Direct port of `SHOVE::onCollidingVia()`'s line-vs-via MTV computation
 * (pns_shove.cpp) — only the `aCurrent->OfKind(LINE_T)` pusher branch (the
 * `SOLID_T`/pad-pusher branch is marked `TODO` even in real KiCad, and
 * never applies here since this router never shoves anything via a pad).
 * The `currentLine->EndsWithVia()` sub-case (a via-ended pusher takes
 * priority via a separate via-vs-via clearance check) is also not
 * ported — this router's pusher is always a plain track segment, never a
 * line ending in its own via, matching this file's own established
 * "plain-segment case only" scope (see this file's header).
 *
 * For each pusher segment, finds the nearest point to `viaCenter`
 * (`closestPointOnSegment`, already used elsewhere in this router) and
 * checks whether the gap to the via's edge is less than the required
 * clearance (own half-width + via radius + clearance). Returns the push
 * vector — from that nearest point toward the via center, scaled to close
 * the gap exactly — for whichever pusher segment collides hardest
 * (largest required push), or null if nothing collides. Matches real
 * KiCad's own MTV convention: just enough push to clear the collision, not
 * an arbitrary amount.
 */
export function computeViaPushForce(
	pusherSegments: { a: Pt; b: Pt; width: number }[],
	viaCenter: Pt, viaRadius: number, clearance: number,
): Pt | null {
	let best: Pt | null = null;
	let bestMagnitude = 0;

	for (const seg of pusherSegments) {
		const nearest = closestPointOnSegment(
			new Vec2(viaCenter.x, viaCenter.y), new Vec2(seg.a.x, seg.a.y), new Vec2(seg.b.x, seg.b.y));
		const dx = viaCenter.x - nearest.x;
		const dy = viaCenter.y - nearest.y;
		const dist = Math.hypot(dx, dy);
		const required = seg.width / 2 + viaRadius + clearance;
		const gap = required - dist;
		if (gap <= 0) continue;

		const dir = dist > 1e-9 ? { x: dx / dist, y: dy / dist } : { x: 0, y: 1 };
		if (gap > bestMagnitude) {
			bestMagnitude = gap;
			best = { x: dir.x * gap, y: dir.y * gap };
		}
	}
	return best;
}
