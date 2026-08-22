/*
 * Ported from KiCad source:
 *   pcbnew/tools/pcb_editor_control.cpp (measure)
 *   gerbview/tools/measurement_tool.cpp (MEASUREMENT_TOOL)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The measurement tool: click for the first point, move to preview, click
 * again to finalize, and the tool reports distance (mm) plus the delta-x/y
 * and angle. Cancels with Esc. HTML-adapted (no wx); emits plain state.
 *
 * Units: mm, degrees.
 */

import { Vec2 } from '../math/Vec2';

/** The measure tool state. */
export type MeasurePhase = 'idle' | 'first-point' | 'measuring';

/** A live measurement result. */
export interface MeasureResult {
	start: Vec2;
	end: Vec2;
	/** Euclidean distance between the two points (mm). */
	distance: number;
	/** Signed delta X / delta Y (mm). */
	dx: number;
	dy: number;
	/** The angle of the measurement line (degrees, 0 = +X axis). */
	angleDeg: number;
}

/**
 * The measure tool. First click fixes the start; mouse moves preview the end;
 * a second click finalizes (emitting the result); Esc resets to idle.
 */
export class MEASURE_TOOL {
	private phase: MeasurePhase = 'idle';
	private start: Vec2 | null = null;
	private end: Vec2 | null = null;

	/** Resets to idle (no active measurement). */
	Reset(): void {
		this.phase = 'idle';
		this.start = null;
		this.end = null;
	}

	GetPhase(): MeasurePhase {
		return this.phase;
	}

	/**
	 * A click at `aPoint`. First click (idle/first-point) fixes the start and
	 * enters 'measuring' (waiting for the end click). If already 'measuring'
	 * and `aFinalize` is true, emits the result and returns to idle.
	 */
	Click(aPoint: Vec2, aFinalize = false): MeasureResult | null {
		if (this.phase === 'idle') {
			this.start = aPoint.copy();
			this.end = aPoint.copy();
			this.phase = 'first-point';
			return null;
		}
		if (this.phase === 'first-point') {
			this.start = aPoint.copy();
			this.end = aPoint.copy();
			this.phase = 'measuring';
			return null;
		}
		// 'measuring'
		if (!aFinalize) {
			return null;
		}
		this.end = aPoint.copy();
		const result = this.compute();
		this.phase = 'idle';
		return result;
	}

	/** Moves the free (end) point during a measurement preview. */
	Move(aPoint: Vec2): MeasureResult | null {
		if (this.phase !== 'measuring') {
			return null;
		}
		this.end = aPoint.copy();
		return this.compute();
	}

	/** The current measurement, or null if none active yet. */
	Current(): MeasureResult | null {
		return this.start && this.end ? this.compute() : null;
	}

	/** Whether there is a measurement in progress. */
	IsMeasuring(): boolean {
		return this.phase === 'measuring';
	}

	private compute(): MeasureResult {
		const s = this.start!;
		const e = this.end!;
		const dx = e.x - s.x;
		const dy = e.y - s.y;
		const distance = Math.hypot(dx, dy);
		const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
		return { start: s.copy(), end: e.copy(), distance, dx, dy, angleDeg };
	}
}
