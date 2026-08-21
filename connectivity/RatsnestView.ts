/*
 * Ported from KiCad source:
 *   pcbnew/ratsnest/ratsnest_viewitem.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * RATSNEST_VIEW_ITEM — the airwire (ratsnest) view model: for each net it
 * holds the list of ratsnest line segments to draw, with visibility /
 * highlight control. The geometry is the output of CONNECTIVITY_DATA (the
 * per-net MST edges), exposed here as the view-level line set.
 */

import { Vec2 } from '../math/Vec2';
import { RN_DYNAMIC_LINE } from './RatsnestData';

/** One ratsnest line to draw: two endpoints + the net it belongs to. */
export interface RATSNEST_LINE {
	a: Vec2;
	b: Vec2;
	net: number;
	// Highlight override (e.g. a net is hovered).
	highlighted: boolean;
}

/**
 * The ratsnest view item. Mirrors KiCad's RATSNEST_VIEW_ITEM:
 * - `SetRatsnestLines( aNetCode, aLines )` stores the lines per net.
 * - `GetNetLines(n)` returns the lines for a net.
 * - View-relevant state (visibility, bounding box) is exposed here.
 */
export class RATSNEST_VIEW_ITEM {
	private m_lines = new Map<number, RATSNEST_LINE[]>();
	// Monotonic tag used to invalidate cached geometry (KiCad parity).
	private m_timeoutTag = 0;

	/** Clears all lines. */
	Clear(): void {
		this.m_lines.clear();
		this.m_timeoutTag++;
	}

	/** Sets the lines for a net, replacing any previous. */
	SetRatsnestLines(aNetCode: number, aLines: Iterable<{ a: Vec2; b: Vec2 }>): void {
		const list: RATSNEST_LINE[] = [];
		for (const l of aLines) {
			list.push({ a: l.a.copy(), b: l.b.copy(), net: aNetCode, highlighted: false });
		}
		this.m_lines.set(aNetCode, list);
		this.m_timeoutTag++;
	}

	/** Sets the whole line set from a list of RN_DYNAMIC_LINE-like edges. */
	SetRatsnest(aLines: RN_DYNAMIC_LINE[]): void {
		this.Clear();
		for (const l of aLines) {
			const net = l.netCode;
			const list = this.m_lines.get(net) ?? [];
			list.push({ a: l.a.copy(), b: l.b.copy(), net, highlighted: false });
			this.m_lines.set(net, list);
		}
	}

	/** The lines for a net (or an empty list). */
	GetNetLines(aNetCode: number): RATSNEST_LINE[] {
		return this.m_lines.get(aNetCode) ?? [];
	}

	/** All nets that have (possibly empty) line sets. */
	Nets(): number[] {
		return [...this.m_lines.keys()];
	}

	/** Every line across all nets. */
	AllLines(): RATSNEST_LINE[] {
		const out: RATSNEST_LINE[] = [];
		for (const list of this.m_lines.values()) {
			out.push(...list);
		}
		return out;
	}

	/** True if a net is highlighted. */
	IsNetHighlighted(aNetCode: number): boolean {
		return this.GetNetLines(aNetCode).some(l => l.highlighted);
	}

	/** Marks a net highlighted / normal. */
	SetNetHighlighted(aNetCode: number, aHighlighted: boolean): void {
		for (const l of this.m_lines.get(aNetCode) ?? []) {
			l.highlighted = aHighlighted;
		}
	}

	/** Bounding box of all lines. */
	GetBBox(): { x: number; y: number; x2: number; y2: number } {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const l of this.AllLines()) {
			minX = Math.min(minX, l.a.x, l.b.x);
			minY = Math.min(minY, l.a.y, l.b.y);
			maxX = Math.max(maxX, l.a.x, l.b.x);
			maxY = Math.max(maxY, l.a.y, l.b.y);
		}
		if (!Number.isFinite(minX)) {
			return { x: 0, y: 0, x2: 0, y2: 0 };
		}
		return { x: minX, y: minY, x2: maxX, y2: maxY };
	}

	/** A monotonically-increasing tag bumped whenever the geometry changes. */
	GetTimeoutTag(): number {
		return this.m_timeoutTag;
	}
}
