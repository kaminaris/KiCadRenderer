/*
 * Ported from KiCad source:
 *   pcbnew/drill::DRILL_LAYOUT / drill positions (drill.cpp)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Drill-hole positions: the list of (x,y,drillSize) hits generated from a
 * board's pads (thru-hole) and vias, used for the drill file / hit plot.
 * Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';

/** One drill hit: a position and the drill diameter. */
export interface DRILL_HIT {
	position: Vec2;
	drillSize: number;
	// Which pad/via produced this hit (for grouping / G85 fanout).
	owner: string;
}

/**
 * The drill layout: a list of drill hits. Mirrors KiCad's drill layout
 * (DRILL_LAYOUT) — collects pad and via drill holes.
 */
export class DRILL_LAYOUT {
	private m_hits: DRILL_HIT[] = [];

	/** Adds a round drill hole at the given position. */
	AddHole(aPosition: Vec2, aDrillSize: number, aOwner = ''): void {
		this.m_hits.push({ position: aPosition.copy(), drillSize: aDrillSize, owner: aOwner });
	}

	/** Adds a slot (two ends + width) as an oval drill hit. */
	AddSlot(aStart: Vec2, aEnd: Vec2, aWidth: number, aOwner = ''): void {
		// Model a slot as its two endpoints (KiCad writes a G85-slot).
		this.m_hits.push({ position: aStart.copy(), drillSize: aWidth, owner: aOwner });
		this.m_hits.push({ position: aEnd.copy(), drillSize: aWidth, owner: aOwner });
	}

	/** All drill hits. */
	Hits(): DRILL_HIT[] {
		return this.m_hits;
	}

	HoleCount(): number {
		return this.m_hits.length;
	}

	Clear(): void {
		this.m_hits = [];
	}

	/** The unique drill diameters present (for the tool table). */
	UniqueDrillSizes(): number[] {
		const sizes = this.m_hits.map(h => h.drillSize);
		return [...new Set(sizes.map(s => Math.round(s * 1e6)))].map(s => s / 1e6).sort((a, b) => a - b);
	}

	/** True if any hole exists. */
	HasHoles(): boolean {
		return this.m_hits.length > 0;
	}
}
