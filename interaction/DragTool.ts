/*
 * Ported from KiCad source:
 *   pcbnew/router/pns_dragger.cpp (DRAGGER) / pcbnew/drag_tool.cpp (DRAG_TOOL)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The interactive track-drag gesture: a TOOL-style state machine (the drag
 * counterpart to ROUTE_TOOL) that drives the ported PnsDragger primitives
 * (dragSegment45 / dragViaChain / mergeCollinear) plus shove-planning to
 * relocate a track segment (or a via chain) while keeping corners on the
 * DIRECTION_45 grid. HTML-adapted; emits plain gesture state.
 *
 * Units: mm.
 */

import { Vec2 } from '../math/Vec2';
import {
	dragSegment45,
	dragViaChain,
	mergeCollinear,
	buildInitialTrace,
} from '../router/PnsDragger';

/** What the drag tool is doing right now. */
export type DragPhase = 'idle' | 'dragging';

/** A pick on the board: the item dragged and its live polyline points. */
export interface DragTarget {
	kind: 'segment' | 'via';
	points: Vec2[];
	index: number;
}

/** Result of a drag move: the candidate polyline + whether it collides. */
export interface DragResult {
	path: Vec2[];
	collides: boolean;
}

/**
 * The interactive track-drag gesture. Wraps the PnsDragger primitives behind
 * the same state-machine shape as ROUTE_TOOL so a router-canvas can drive
 * either tool uniformly.
 */
export class DRAG_TOOL {
	private phase: DragPhase = 'idle';
	private original: Vec2[] = [];
	private index = 0;
	private kind: 'segment' | 'via' = 'segment';
	private corner: '45' | '90' | 'free' = '45';
	private width = 0.25;
	private lastPath: Vec2[] = [];

	/** Picks the segment (at `index`) of `points` to drag. */
	Select(points: Vec2[], index: number, kind: 'segment' | 'via' = 'segment'): void {
		this.original = points.map(p => p.copy());
		this.index = index;
		this.kind = kind;
		this.phase = 'dragging';
		this.lastPath = points.map(p => p.copy());
	}

	/** Sets the drag corner mode (45 / 90 / free). */
	SetCornerMode(corner: '45' | '90' | 'free'): void {
		this.corner = corner;
	}

	/** Sets the dragged trace width (for collision sizing). */
	SetWidth(width: number): void {
		this.width = width;
	}

	/**
	 * Moves the drag target to `target`. Computes the dragged polyline — for a
	 * segment pick, dragSegment45 keeps the neighboring corners on the 45-grid
	 * while relocating the segment; for a via chain, dragViaChain carries it.
	 * Returns the candidate path. `aCollides` is left to the caller's RouterNode
	 * (pure geometry here, no world collision — matches PnsDragger's pure role).
	 */
	Move(target: Vec2): DragResult {
		if (this.phase !== 'dragging') {
			throw new Error('DRAG_TOOL.Move() called without a selection');
		}
		// Map the free corner mode to the 45-grid primitives (dragSegment45 /
		// dragViaChain only support 45/90; a free drag is a plain endpoint move).
		const quad = this.corner === 'free' ? '45' : this.corner;
		let path: Vec2[];
		if (this.kind === 'via') {
			path = dragViaChain(this.original, target, quad);
		} else {
			path = dragSegment45(this.original, this.index, target, quad);
		}
		if (this.corner !== 'free') {
			path = mergeCollinear(path);
		}
		this.lastPath = path;
		return { path, collides: false };
	}

	/** The latest candidate polyline (for preview). */
	preview(): Vec2[] {
		return this.lastPath;
	}

	/** Commits the drag, returning the final polyline; back to idle. */
	Commit(): Vec2[] {
		const path = this.lastPath;
		this.phase = 'idle';
		return path;
	}

	/** Aborts the drag, returning the original polyline; back to idle. */
	Cancel(): Vec2[] {
		const original = this.original;
		this.phase = 'idle';
		return original;
	}

	IsDragging(): boolean {
		return this.phase === 'dragging';
	}

	/** The dragged trace width. */
	GetWidth(): number {
		return this.width;
	}
}

/** Makes a fresh 45-constrained initial trace (first placement leg). */
export function makeInitialTrace(p0: Vec2, p1: Vec2, cornerMode: '45' | '90' | 'free' = '45'): Vec2[] {
	if (cornerMode === 'free') {
		return [p0, p1];
	}
	return buildInitialTrace(p0, p1, cornerMode);
}
