/*
 * Ported from KiCad source:
 *   pcbnew/tools/pcb_editor_control.cpp (draw zone outline)
 *   pcbnew/zone_manager / zone_editor — zone outline -> fill flow
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The zone editing gesture: collect a closed outline polygon (click corners,
 * move preview, re-click to add, Esc/last-revert to adjust), then Commit() to
 * hand the outline to a fill/zonesink. Mirrors the draw-zone-outline tool.
 * HTML-adapted; pure state, mutation via an injection surface.
 *
 * Units: mm.
 */

import { Vec2 } from '../math/Vec2';

/** The zone-outline gesture state. */
export type ZonePhase = 'idle' | 'drawing';

/** Injection surface for committing/refreshing a zone. */
export interface ZoneSink {
	/** Commit an outline (closed, in mm), returning the zone's id. */
	addZoneOutline(points: Vec2[], layer: string): string | null;
	/** Request a fill for a committed zone (async in the session). */
	fillZone(zoneId: string): Promise<boolean> | boolean;
}

/**
 * The zone-outline drawing tool. Click adds a corner; a double/Enter fix
 * closes and commits the outline; the preview shows the live segment to the
 * cursor. Cancelling with Esc keeps the committed zones (KiCad behaviour).
 */
export class ZONE_TOOL {
	private sink: ZoneSink;
	private phase: ZonePhase = 'idle';
	private outline: Vec2[] = [];
	private cursor: Vec2 | null = null;
	private layer = 'F.Cu';

	constructor(aSink: ZoneSink) {
		this.sink = aSink;
	}

	/** Starts drawing a new zone outline on `aLayer`. */
	Begin(layer: string): void {
		this.layer = layer;
		this.outline = [];
		this.cursor = null;
		this.phase = 'drawing';
	}

	IsDrawing(): boolean {
		return this.phase === 'drawing';
	}

	/** The outline corners accumulated so far. */
	Points(): Vec2[] {
		return this.outline;
	}

	/** The live preview point (the cursor position). */
	Preview(): Vec2 | null {
		return this.cursor;
	}

	/** Moves the preview cursor (does not add a corner). */
	Move(aPoint: Vec2): void {
		this.cursor = aPoint.copy();
	}

	/**
	 * Adds a corner. If `aClose` is true (double-click/Enter), the outline is
	 * treated as closed and committed immediately; otherwise the corner is
	 * appended and drawing continues. Returns the committed zone id when it
	 * just closed, else null.
	 */
	Click(aPoint: Vec2, aClose = false): string | null {
		if (this.phase !== 'drawing') {
			return null;
		}
		this.outline.push(aPoint.copy());
		if (aClose && this.outline.length >= 3) {
			return this.closeAndCommit();
		}
		return null;
	}

	/** Closes and commits the current outline (min 3 points). */
	Finish(): string | null {
		if (this.phase !== 'drawing' || this.outline.length < 3) {
			this.phase = 'idle';
			return null;
		}
		return this.closeAndCommit();
	}

	/**
	 * Removes the last corner (KiCad right-click / Backspace during outline).
	 * Back to idle if the outline is empty.
	 */
	UndoLast(): void {
		this.outline.pop();
		if (this.outline.length === 0) {
			this.phase = 'idle';
		}
	}

	/** Cancels the outline gesture (nothing committed). */
	Cancel(): void {
		this.phase = 'idle';
		this.outline = [];
		this.cursor = null;
	}

	private closeAndCommit(): string | null {
		this.phase = 'idle';
		this.cursor = null;
		const id = this.sink.addZoneOutline(this.outline, this.layer);
		if (id != null) {
			const res = this.sink.fillZone(id);
			if (res instanceof Promise) {
				res.catch(() => { /* fill failure surfaced by the sink */ });
			}
		}
		return id;
	}
}
