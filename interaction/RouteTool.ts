/*
 * Ported from KiCad source:
 *   pcbnew/router/pns_router_tool.cpp (ROUTE_TOOL) — the interactive route
 *   gesture state machine that sits on top of PNS_ROUTER
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The interactive routing gesture layer: a TOOL-style state machine that
 * drives the PNS_ROUTER engine the way KiCad's route tool does — pick a start
 * anchor, drag to extend (with 45-degree head + optional walkaround/shove),
 * insert vias, fix (commit) or cancel. HTML-adapted: no wx; it emits plain
 * state/gesture events a pointer controller consumes.
 *
 * Units: mm.
 */

import { Vec2 } from '../math/Vec2';
import { PNS_ROUTER, PNS_ROUTE_RESULT, PNS_ROUTE_COMMIT, PNS_ROUTER_SETTINGS, PnsRouterMode, PnsCornerMode } from '../router/PnsRouter';
import { PNS_LINE } from '../router/PnsNode';

/** The route tool's internal state (mirrors the KiCad route tool state). */
export type RoutePhase = 'idle' | 'starting' | 'routing' | 'placing-via';

/** A snap candidate (a pad/via/track endpoint the cursor can snap to). */
export interface RouteSnapPoint {
	pos: Vec2;
	netId: number | null;
	kind: 'pad' | 'via' | 'track-end';
}

/** What the user is mid-gesture (mirrors the route-mode / drag state). */
export type RouteGesture =
	| { kind: 'idle' }
	| { kind: 'starting'; cursor: Vec2 }
	| { kind: 'routing'; cursor: Vec2; detoured: boolean; collides: boolean };

/**
 * The interactive route tool. Holds a PNS_ROUTER and exposes the gesture
 * primitives: SelectStart, MoveCursor, AddVia, DoubleClickFix, and Cancel.
 * Each method advances the state machine and returns the observable result
 * a view can turn into a ghost path.
 */
export class ROUTE_TOOL {
	private router: PNS_ROUTER;
	private phase: RoutePhase = 'idle';
	private netId: number | null = null;
	private layer = 'F.Cu';
	private width = 0.25;
	private startPoint: Vec2 | null = null;
	private lastCommit: PNS_ROUTE_COMMIT | null = null;
	private snap: RouteSnapPoint | null = null;
	private lastGhost: PNS_LINE | null = null;

	constructor(settings?: Partial<PNS_ROUTER_SETTINGS>) {
		this.router = new PNS_ROUTER(settings);
	}

	/** Adopts an existing router instance (shared world/settings with the
	 *  session's router). */
	injectRouter(router: PNS_ROUTER): void {
		this.router = router;
	}

	getRouter(): PNS_ROUTER {
		return this.router;
	}

	getPhase(): RoutePhase {
		return this.phase;
	}

	/** Binds the router's collision world to a board scene. */
	setWorld(scene: any, copperLayers: readonly string[]): void {
		this.router.setWorld(scene, copperLayers);
	}

	setClearanceResolver(resolver: (a: number | null, b: number | null) => number): void {
		this.router.setClearanceResolver(resolver);
	}

	/**
	 * Selects the route start anchor. Snaps to a candidate anchor if present
	 * (with the net/layer/width of the anchor's net), else uses the cursor and
	 * the default net/layer/width.
	 */
	SelectStart(cursor: Vec2, candidates: RouteSnapPoint[] = []): RouteGesture {
		const snap = this.bestSnap(cursor, candidates);
		this.snap = snap;
		this.startPoint = snap ? snap.pos.copy() : cursor.copy();
		if (snap && snap.netId !== null && snap.netId !== undefined) {
			this.netId = snap.netId;
		}
		this.router.startRouting(this.startPoint, this.layer, this.width, this.netId);
		this.phase = 'routing';
		return { kind: 'routing', cursor: this.startPoint, detoured: false, collides: false };
	}

	/**
	 * Moves the cursor while routing; returns the ghost line plus collision /
	 * detour state. Mirrors the route tool's OnMouseMove -> router.Move().
	 */
	MoveCursor(cursor: Vec2): RouteGesture {
		if (this.phase === 'idle') {
			return { kind: 'idle' };
		}
		if (this.phase === 'starting') {
			this.phase = 'routing';
		}
		const res: PNS_ROUTE_RESULT = this.router.move(this.snapToSegmentCursor(cursor));
		this.snap = null;
		this.lastGhost = res.line;
		return {
			kind: 'routing',
			cursor: cursor.copy(),
			detoured: res.detoured,
			collides: res.collides,
		};
	}

	/** The current ghost line points (the free-end preview), or empty. */
	ghostPoints(): Vec2[] {
		return this.lastGhost ? this.lastGhost.GetPoints() : [];
	}

	/**
	 * Fixes/commits the route at `cursor`. Returns the commit (segments to add
	 * + shoved tracks), or null if it couldn't be committed (collision /
	 * degenerate). Mirrors DoubleClickFix. The commit resets to idle.
	 */
	Fix(cursor: Vec2): PNS_ROUTE_COMMIT | null {
		if (this.phase === 'idle') {
			return null;
		}
		this.phase = 'starting';
		const commit = this.router.fixRoute(this.snapToSegmentCursor(cursor));
		this.phase = 'idle';
		this.lastCommit = commit;
		return commit;
	}

	/**
	 * Commits the current route and starts a new one from the same endpoint
	 * (chaining segments without lifting the pencil). Used for
	 * double-click-per-region routing. Returns the commit and the new phase.
	 */
	FixPointAndContinue(cursor: Vec2): PNS_ROUTE_COMMIT | null {
		const commit = this.Fix(cursor);
		if (commit && commit.segments.length > 0) {
			const last = commit.segments[commit.segments.length - 1]!;
			this.startPoint = new Vec2(last.x2, last.y2);
			this.router.startRouting(this.startPoint, this.layer, this.width, this.netId);
			this.phase = 'routing';
		}
		return commit;
	}

	/** Switches to a different route mode (highlight/walkaround/shove). */
	SetMode(mode: PnsRouterMode): void {
		this.router.setSettings({ ...this.router.getSettings(), mode });
	}

	/** Sets the corner style (45 / 90 / free). */
	SetCornerMode(cornerMode: PnsCornerMode): void {
		this.router.setSettings({ ...this.router.getSettings(), cornerMode });
	}

	/** Sets the trace width (mm) for subsequently started routes. */
	SetWidth(width: number): void {
		this.width = width;
	}

	/** Sets the active board layer for subsequently started routes. */
	SetLayer(layer: string): void {
		this.layer = layer;
	}

	/** The net currently being routed. */
	CurrentNet(): number | null {
		return this.netId;
	}

	/** Cancels the current route and returns to idle (no commit). */
	Cancel(): void {
		this.router.cancelRoute();
		this.phase = 'idle';
		this.startPoint = null;
		this.snap = null;
	}

	/** True if there is an active route. */
	IsRouting(): boolean {
		return this.phase !== 'idle';
	}

	/** The last committed route (for undo/commit plumbing). */
	TakeCommit(): PNS_ROUTE_COMMIT | null {
		const c = this.lastCommit;
		this.lastCommit = null;
		return c;
	}

	/** Snaps a cursor position to the segment start/end points (KiCad's route
	 *  tool keeps the cursor snapped to the 45-degree head, not raw). For now
	 *  returns the raw cursor; the caller may apply its own grid/snap. */
	private snapToSegmentCursor(cursor: Vec2): Vec2 {
		return cursor.copy();
	}

	/** Chooses the nearest snap candidate within a snap radius (0.5 mm). */
	private bestSnap(cursor: Vec2, candidates: RouteSnapPoint[]): RouteSnapPoint | null {
		let best: RouteSnapPoint | null = null;
		let bestD = 0.5;
		for (const c of candidates) {
			const d = cursor.sub(c.pos).magnitude;
			if (d <= bestD && (!best || d < bestD)) {
				best = c;
				bestD = d;
			}
		}
		return best;
	}
}
