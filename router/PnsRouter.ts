/*
 * Ported from KiCad source:
 *   pcbnew/router/pns_router.h
 *   pcbnew/router/pns_router.cpp
 *
 * Copyright (C) 2013-2014 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Top-level interactive router. This class owns the collision world
 * (RouterNode), the current route-in-progress, and the high-level
 * StartRouting / Move / FixRoute / Cancel cycle. It is a deliberate
 * simplification of real KiCad's PNS_ROUTER: it does not clone worlds for
 * every shove attempt or implement the full placer/dragger split, but it
 * exposes the same public shape and composes the existing router pieces
 * (RouterNode, PnsDragger, PnsHull, PnsWalkaround, PnsOptimizer,
 * RouterGeometry) in one place.
 */

import { Vec2 } from '../math/Vec2';
import type { LayeredBoardScene } from '../paint/BoardPainter';
import { RouterNode, RouterObstacle } from './RouterNode';
import { PNS_LINE } from './PnsNode';
import { buildInitialTrace, mergeCollinear } from './PnsDragger';
import { buildClearanceHull } from './PnsHull';
import { walkaroundHull, pathLength } from './PnsWalkaround';
import { simplifyWalkedPath } from './PnsOptimizer';
import { shoveObstacleLineCascade, ShoveCascadeCollision, computeViaPushForce } from './PnsShove';

/** Router behavior mode. */
export type PnsRouterMode = 'highlight' | 'shove' | 'walkaround';

/** Corner style for the head of a route. */
export type PnsCornerMode = '45' | '90' | 'free';

/** Top-level router settings. */
export interface PNS_ROUTER_SETTINGS {
	mode: PnsRouterMode;
	cornerMode: PnsCornerMode;
	/** Remove redundant collinear points on commit. */
	removeRedundantTracks: boolean;
	/** Allow committing a route that still violates clearance. */
	allowDrcViolations: boolean;
	/** Real KiCad's `Settings().ShoveVias()` — when false, shove mode
	 *  treats a colliding via like an obstacle it can't move (matches
	 *  `SHOVE::pushOrShoveVia`'s own `if (!ShoveVias()) return SH_TRY_WALK`
	 *  early-out; this simplification just reports no shove available for
	 *  that path rather than falling back to walkaround). Defaults to
	 *  real KiCad's own default (on). */
	shoveVias: boolean;
}

/** Result of a routing move: candidate path and collision state. */
export interface PNS_ROUTE_RESULT {
	line: PNS_LINE;
	/** True if the raw head collides and no shove/walkaround resolved it. */
	collides: boolean;
	/** Shove/walkaround was applied to produce this path. */
	detoured: boolean;
}

/** One committed track segment. */
export interface PNS_COMMITTED_SEGMENT {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	width: number;
	layer: string;
	netId: number | null;
}

/** One obstacle moved to make room for a route — either a track segment
 *  reshaped by `PnsShove.ts`'s line-shove geometry, or a via pushed aside
 *  by `computeViaPushForce()`'s port of `SHOVE::onCollidingVia()` (see
 *  `KicadRenderSession.shoveVia()` for how a `'via'` entry gets applied —
 *  it reuses the existing via-drag fanout/reflow machinery, not new
 *  segment geometry computed here). */
export type PNS_SHOVED_ITEM =
	| { kind: 'track'; obstacle: RouterObstacle; segments: { x1: number; y1: number; x2: number; y2: number }[] }
	| { kind: 'via'; viaId: string; pushForce: { x: number; y: number } };

/** Result of fixing a route. */
export interface PNS_ROUTE_COMMIT {
	segments: PNS_COMMITTED_SEGMENT[];
	/** Existing tracks/vias that were shoved to make room. */
	shoved: PNS_SHOVED_ITEM[];
}

/** Clearance resolver signature. */
export type PnsClearanceResolver = (netA: number | null, netB: number | null) => number;

/** Default flat clearance when no resolver is supplied. */
const DEFAULT_CLEARANCE_MM = 0.2;

/**
 * Top-level interactive router. Build once per board, call setWorld() when
 * the board changes, then startRouting() / move() / fixRoute() / cancelRoute()
 * for each routing gesture.
 */
export class PNS_ROUTER {
	private node: RouterNode | null = null;
	private settings: PNS_ROUTER_SETTINGS;
	private line: PNS_LINE | null = null;
	private startPoint: Vec2 | null = null;
	private layer = 'F.Cu';
	private width = 0.25;
	private netId: number | null = null;
	private clearanceResolver: PnsClearanceResolver = () => DEFAULT_CLEARANCE_MM;

	constructor(settings?: Partial<PNS_ROUTER_SETTINGS>) {
		this.settings = {
			mode: 'walkaround',
			cornerMode: '45',
			removeRedundantTracks: true,
			allowDrcViolations: false,
			shoveVias: true,
			...settings,
		};
	}

	/** Replace the active settings (mode, corner style, flags). */
	setSettings(settings: Partial<PNS_ROUTER_SETTINGS>): void {
		this.settings = { ...this.settings, ...settings };
	}

	getSettings(): PNS_ROUTER_SETTINGS {
		return { ...this.settings };
	}

	/**
	 * Set the clearance resolver. Defaults to a flat 0.2 mm. Called with the
	 * candidate net and the obstacle net; net-class-aware callers should
	 * resolve the larger of the two nets' clearances here.
	 */
	setClearanceResolver(resolver: PnsClearanceResolver): void {
		this.clearanceResolver = resolver;
	}

	/**
	 * (Re)build the collision world from the current painted board scene.
	 * Call whenever the board's copper changes (route start, commit, via
	 * placement, etc.).
	 */
	setWorld(scene: LayeredBoardScene, copperLayers: readonly string[]): void {
		this.node = RouterNode.fromScene(scene, copperLayers);
	}

	/** True if a route is currently in progress. */
	isRouting(): boolean {
		return this.line !== null;
	}

	/**
	 * Start a new route. `start` should already be snapped to the desired
	 * anchor (pad/via/track endpoint); `netId` may be null for a net-less
	 * start.
	 */
	startRouting(start: Vec2, layer: string, width: number, netId: number | null): void {
		this.startPoint = start.copy();
		this.layer = layer;
		this.width = width;
		this.netId = netId;
		this.line = new PNS_LINE(netId ?? 0);
		this.line.SetNet(netId ?? 0);
		this.line.SetWidth(width);
		this.line.SetPoints([start.copy()]);
	}

	/**
	 * Move the route's free end to `cursor`. Returns the candidate line and
	 * whether it is in collision. In 'walkaround'/'shove' modes the router
	 * tries to detour around obstacles; in 'highlight' mode it only reports
	 * collision.
	 */
	move(cursor: Vec2): PNS_ROUTE_RESULT {
		if (!this.line || !this.startPoint) {
			throw new Error('PNS_ROUTER.move() called without an active route');
		}

		const straight = this.buildHead(this.startPoint, cursor);
		if (!this.node) {
			this.line.SetPoints(straight.map(p => p.copy()));
			return { line: this.line, collides: false, detoured: false };
		}

		const clearanceFn = this.clearanceResolver;
		if (!this.pathCollides(straight)) {
			this.line.SetPoints(straight.map(p => p.copy()));
			return { line: this.line, collides: false, detoured: false };
		}

		if (this.settings.mode === 'walkaround') {
			const walked = this.walkAroundObstacles(this.startPoint, cursor, straight);
			if (walked) {
				this.line.SetPoints(walked.map(p => p.copy()));
				return { line: this.line, collides: false, detoured: true };
			}
		}
		else if (this.settings.mode === 'shove') {
			// Shove is applied at commit time for the whole path; during move
			// we just report whether a shove is possible.
			const shovable = this.planShoveForPath(straight) !== null;
			if (shovable) {
				this.line.SetPoints(straight.map(p => p.copy()));
				return { line: this.line, collides: false, detoured: true };
			}
		}

		this.line.SetPoints(straight.map(p => p.copy()));
		return { line: this.line, collides: true, detoured: false };
	}

	/**
	 * Commit the route at `end`. Returns the segments to add and any existing
	 * tracks that should be shoved. In 'highlight' mode with collisions, this
	 * returns null unless allowDrcViolations is true.
	 */
	fixRoute(end: Vec2): PNS_ROUTE_COMMIT | null {
		if (!this.line || !this.startPoint) {
			return null;
		}

		const result = this.move(end);
		const points = result.line.GetPoints();
		if (points.length < 2) {
			this.cancelRoute();
			return null;
		}

		if (result.collides && !this.settings.allowDrcViolations) {
			return null;
		}

		const commit: PNS_ROUTE_COMMIT = { segments: [], shoved: [] };

		// Build segments from the path.
		const finalPoints = this.settings.removeRedundantTracks
			? mergeCollinear(points)
			: points;
		for (let i = 0; i < finalPoints.length - 1; i++) {
			const a = finalPoints[i]!;
			const b = finalPoints[i + 1]!;
			if (a.x === b.x && a.y === b.y) continue;
			commit.segments.push({
				x1: a.x, y1: a.y, x2: b.x, y2: b.y,
				width: this.width, layer: this.layer, netId: this.netId,
			});
		}

		// In shove mode, compute shoved obstacles for the whole path.
		if (this.settings.mode === 'shove' && this.node) {
			for (let i = 0; i < points.length - 1; i++) {
				const a = points[i]!;
				const b = points[i + 1]!;
				const shove = this.planShoveForPath([a, b]);
				if (shove) {
					commit.shoved.push(...shove);
				}
			}
		}


		this.cancelRoute();
		return commit;
	}

	/** Cancel the current route without committing anything. */
	cancelRoute(): void {
		this.line = null;
		this.startPoint = null;
	}

	/**
	 * Access the underlying collision world. Exposed so callers can do
	 * one-off clearance queries (e.g. anchor-snap net filtering).
	 */
	getNode(): RouterNode | null {
		return this.node;
	}

	/** The net currently being routed, or null. */
	currentNet(): number | null {
		return this.netId;
	}

	/** The active layer. */
	currentLayer(): string {
		return this.layer;
	}

	/** The active track width. */
	currentWidth(): number {
		return this.width;
	}

	/** Build the unconstrained 45/90/free head from `from` to `to`. */
	private buildHead(from: Vec2, to: Vec2): Vec2[] {
		const mode = this.settings.cornerMode;
		if (mode === 'free') {
			return [from.copy(), to.copy()];
		}
		return buildInitialTrace(from, to, mode).map(p => p.copy());
	}

	/** True if any segment of `path` collides with a different-net obstacle. */
	private pathCollides(path: Vec2[]): boolean {
		if (!this.node) return false;
		const half = this.width / 2;
		for (let i = 0; i < path.length - 1; i++) {
			const a = path[i]!;
			const b = path[i + 1]!;
			const hit = this.node.firstSegmentCollision(
				a.x, a.y, b.x, b.y, this.width, this.layer, this.netId,
				this.clearanceResolver
			);
			if (hit) return true;
		}
		return false;
	}

	/**
	 * Iteratively walk around every obstacle the candidate path collides with,
	 * mirroring real KiCad's WALKAROUND::Route().
	 */
	private walkAroundObstacles(from: Vec2, to: Vec2, initialPath: Vec2[]): Vec2[] | null {
		if (!this.node) return null;

		const half = this.width / 2;
		const straightLength = Math.hypot(to.x - from.x, to.y - from.y);
		const maxLength = Math.max(straightLength * 8, half * 40);
		const rectOnly = this.settings.cornerMode === '90';
		const simplify = (path: { x: number; y: number }[]): { x: number; y: number }[] =>
			simplifyWalkedPath(path, (a, b) =>
				!!this.node!.firstSegmentCollision(a.x, a.y, b.x, b.y, this.width, this.layer, this.netId, this.clearanceResolver)
			);

		let currentPath: { x: number; y: number }[] = initialPath.map(p => ({ x: p.x, y: p.y }));
		const MAX_ITERATIONS = 25;

		for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
			let firstHit: RouterObstacle | null = null;
			let hitIndex = -1;
			for (let i = 0; i < currentPath.length - 1; i++) {
				const a = currentPath[i]!;
				const b = currentPath[i + 1]!;
				const hit = this.node.firstSegmentCollision(
					a.x, a.y, b.x, b.y, this.width, this.layer, this.netId, this.clearanceResolver
				);
				if (hit) {
					firstHit = hit;
					hitIndex = i;
					break;
				}
			}
			if (!firstHit) {
				// All clear after simplification.
				const simplified = simplify(currentPath);
				return simplified.map(p => new Vec2(p.x, p.y));
			}

			const required = this.clearanceResolver(this.netId, firstHit.netId);
			const hull = buildClearanceHull(firstHit.shape, required + half, rectOnly);
			const walked = walkaroundHull(currentPath, hull);
			if (!walked) {
				return null;
			}

			const optimized = simplify(walked);
			if (pathLength(optimized) > maxLength) {
				return null;
			}
			if (optimized.length === currentPath.length &&
				optimized.every((p, i) => p.x === currentPath[i]!.x && p.y === currentPath[i]!.y)) {
				// No progress - bail to avoid looping.
				return null;
			}
			currentPath = optimized;
		}
		return null;
	}

	/**
	 * Plans a shove for a single straight segment. Returns every obstacle
	 * moved (in cascade order — see `PnsShove.ts`'s `shoveObstacleLineCascade()`)
	 * and each one's new segment chain if a shove is possible, null otherwise.
	 * Still a bounded, node-versioning/springback-free simplification of the
	 * full `SHOVE` class — see `PnsShove.ts`'s own header for the full scope
	 * of what real KiCad's `SHOVE::Run()` does that this doesn't. A via
	 * obstacle is a single-item result on its own (never cascaded into a
	 * further obstacle — see `computeViaPushForce()`'s own doc comment);
	 * only a track-segment obstacle cascades.
	 */
	private planShoveForPath(path: Vec2[]): PNS_SHOVED_ITEM[] | null {
		if (!this.node || path.length < 2) return null;

		const pusherCheckerPoint = path[0]!;

		for (let i = 0; i < path.length - 1; i++) {
			const a = path[i]!;
			const b = path[i + 1]!;
			const hit = this.node.firstSegmentCollision(
				a.x, a.y, b.x, b.y, this.width, this.layer, this.netId, this.clearanceResolver
			);
			if (!hit) {
				continue;
			}

			if (hit.kind === 'via' && hit.shape.type === 'circle') {
				if (!this.settings.shoveVias) {
					continue;
				}
				const required = this.clearanceResolver(this.netId, hit.netId);
				const pushForce = computeViaPushForce(
					[{ a, b, width: this.width }], { x: hit.shape.cx, y: hit.shape.cy }, hit.shape.r, required);
				if (!pushForce) {
					continue;
				}
				return [{ kind: 'via', viaId: hit.id, pushForce }];
			}

			if (hit.kind !== 'track' || hit.shape.type !== 'segment') {
				continue;
			}

			const obstacle = hit.shape;
			const required = this.clearanceResolver(this.netId, hit.netId);

			// Maps a cascade move's obstacle id back to the full RouterObstacle
			// (needed for `.element` on commit) — populated as a side effect of
			// `findCollision` below discovering each subsequent obstacle.
			const obstaclesById = new Map<string, RouterObstacle>([[hit.id, hit]]);

			// Adapter into RouterNode's spatial index for the cascade's own
			// "what does this now-shoved obstacle collide with next" query.
			// Only a plain track segment is something this simplification
			// knows how to cascade into (matches the single-obstacle case's
			// existing `kind !== 'track'` bail-out) — anything else (a pad,
			// via, keepout) stops the cascade rather than trying to move it.
			const findCollision = (
				candidatePath: { x: number; y: number }[],
				excludeIds: readonly string[],
			): ShoveCascadeCollision | null => {
				for (let j = 1; j < candidatePath.length; j++) {
					const p1 = candidatePath[j - 1]!;
					const p2 = candidatePath[j]!;
					const found = this.node!.firstSegmentCollision(
						p1.x, p1.y, p2.x, p2.y, obstacle.width, hit.layer, hit.netId, this.clearanceResolver, excludeIds
					);
					if (!found) continue;
					if (found.kind !== 'track' || found.shape.type !== 'segment') return null;
					obstaclesById.set(found.id, found);
					return { id: found.id, path: [{ x: found.shape.x1, y: found.shape.y1 }, { x: found.shape.x2, y: found.shape.y2 }], width: found.shape.width };
				}
				return null;
			};

			const cascade = shoveObstacleLineCascade(
				[{ a, b, width: this.width }],
				pusherCheckerPoint,
				{ id: hit.id, path: [{ x: obstacle.x1, y: obstacle.y1 }, { x: obstacle.x2, y: obstacle.y2 }], width: obstacle.width },
				required,
				findCollision,
			);
			if (!cascade) {
				return null;
			}

			return cascade.map((move): PNS_SHOVED_ITEM => {
				const segments: { x1: number; y1: number; x2: number; y2: number }[] = [];
				for (let j = 1; j < move.shovedPath.length; j++) {
					const p1 = move.shovedPath[j - 1]!;
					const p2 = move.shovedPath[j]!;
					segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
				}
				return { kind: 'track', obstacle: obstaclesById.get(move.id)!, segments };
			});
		}
		return null;
	}
}

export default PNS_ROUTER;
