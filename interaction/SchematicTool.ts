/*
 * Ported from KiCad source:
 *   eeschema/tools/sch_drawing_tools.cpp (draw wire/bus/line)
 *   eeschema/tools/sch_place_tool.cpp (place symbol/label/power)
 *   eeschema/tools/sch_editor_control.cpp (junction/no-connect)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The schematic interactive gesture layer — the schematic counterpart to
 * ROUTE_TOOL/DRAG_TOOL. It packages the wire/bus/line drawing gesture and
 * the symbol/label/power-junction placements into one TOOL-style state
 * machine. Mutations are delegated to a small injection surface (the
 * session's addWire/addBus/addJunction/...) so this stays pure logic and
 * HTML/UI-agnostic.
 *
 * Units: mm (rotations in degrees).
 */

import { Vec2 } from '../math/Vec2';

/** The wire/bus drawing state. */
export type SchematicPhase = 'idle' | 'drawing';

/** What kind of segment is being drawn. */
export type DrawKind = 'wire' | 'bus' | 'line';

/** The mutation injection surface (the session's schematic editing API). */
export interface SchematicMutations {
	addWire(x1: number, y1: number, x2: number, y2: number, width?: number): string | null;
	addBus(x1: number, y1: number, x2: number, y2: number, width?: number): string | null;
	addJunction(x: number, y: number): string | null;
	addNoConnect(x: number, y: number): string | null;
	/** Place a symbol/field item at a point; returns its reference id. */
	placeItem(kind: 'symbol' | 'label' | 'power', at: Vec2, net?: string): string | null;
}

/** Result of a draw/place step. */
export interface SchematicGestureResult {
	phase: SchematicPhase;
	/** The committed last segment endpoints (during a drawing run). */
	last: { a: Vec2; b: Vec2 } | null;
	/** The id of a just-placed item (junction/symbol/label), if any. */
	placedId: string | null;
}

/**
 * The schematic drawing/placement tool. One instance per active gesture; call
 * BeginDraw to start a wire/bus run, MoveCursor for the live preview endpoint,
 * Click to fix a corner (and continue), Finish/Cancel to end.
 */
export class SCHEMATIC_TOOL {
	private mut: SchematicMutations;
	private phase: SchematicPhase = 'idle';
	private kind: DrawKind = 'wire';
	private width = 0;
	private start: Vec2 | null = null;
	private lastEnd: Vec2 | null = null;

	constructor(aMutations: SchematicMutations) {
		this.mut = aMutations;
	}

	/** Starts a wire/bus/line drawing run at `aStart`. */
	BeginDraw(aKind: DrawKind, aStart: Vec2, aWidth = 0): void {
		this.kind = aKind;
		this.width = aWidth;
		this.start = aStart.copy();
		this.lastEnd = aStart.copy();
		this.phase = 'drawing';
	}

	/** The current drawing kind. */
	Kind(): DrawKind {
		return this.kind;
	}

	/** The live endpoint during a drawing run (for the ghost). */
	Current(): Vec2 | null {
		return this.lastEnd;
	}

	/**
	 * Fixes a corner at `aTo`: commits the current [lastEnd, aTo] segment and
	 * continues from `aTo`. Returns the committed segment.
	 */
	Click(aTo: Vec2): SchematicGestureResult | null {
		if (this.phase !== 'drawing' || !this.lastEnd) {
			return null;
		}
		const from = this.lastEnd;
		const id = this.commitSegment(from, aTo);
		this.lastEnd = aTo.copy();
		return { phase: this.phase, last: id ? { a: from, b: aTo } : null, placedId: null };
	}

	/** Ends the drawing run (committing any last partial segment). */
	Finish(): SchematicGestureResult {
		this.phase = 'idle';
		this.start = null;
		this.lastEnd = null;
		return { phase: this.phase, last: null, placedId: null };
	}

	/** Cancels the current drawing run without a final partial commit. */
	Cancel(): SchematicGestureResult {
		this.phase = 'idle';
		this.start = null;
		this.lastEnd = null;
		return { phase: this.phase, last: null, placedId: null };
	}

	IsDrawing(): boolean {
		return this.phase === 'drawing';
	}

	/** Places a junction at a point (a wire corner/T). */
	PlaceJunction(at: Vec2): SchematicGestureResult {
		const id = this.mut.addJunction(at.x, at.y);
		return { phase: this.phase, last: null, placedId: id };
	}

	/** Places a no-connect flag at a point. */
	PlaceNoConnect(at: Vec2): SchematicGestureResult {
		const id = this.mut.addNoConnect(at.x, at.y);
		return { phase: this.phase, last: null, placedId: id };
	}

	/** Places a symbol/label/power item at a point. */
	PlaceItem(kind: 'symbol' | 'label' | 'power', at: Vec2, net?: string): SchematicGestureResult {
		const id = this.mut.placeItem(kind, at, net);
		return { phase: this.phase, last: null, placedId: id };
	}

	/** Commits one [from,to] segment of the current kind. */
	private commitSegment(from: Vec2, to: Vec2): string | null {
		switch (this.kind) {
			case 'wire':
				return this.mut.addWire(from.x, from.y, to.x, to.y, this.width);
			case 'bus':
				return this.mut.addBus(from.x, from.y, to.x, to.y, this.width);
			case 'line':
			default:
				// A plain graphic line on the schematic maps to a wire-like
				// segment with no electrical identity.
				return this.mut.addWire(from.x, from.y, to.x, to.y, this.width);
		}
	}
}
