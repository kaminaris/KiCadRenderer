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

/** One drill hit: a position and the drill diameter. Port of the relevant
 *  fields of `HOLE_INFO` (gendrill_excellon_writer.h) — `shape`/`end`
 *  mirror `m_Hole_Shape`/the oblong hole's computed end point, needed so
 *  the Excellon writer can emit a real start+`G85`+end slot sequence
 *  instead of two independent round holes. */
export interface DRILL_HIT {
	position: Vec2;
	drillSize: number;
	shape: 'round' | 'oblong';
	/** Oblong holes only — the slot's other end. */
	end?: Vec2;
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
		this.m_hits.push({ position: aPosition.copy(), drillSize: aDrillSize, shape: 'round', owner: aOwner });
	}

	/** Adds a slot (oblong hole): one hit carrying both ends, matching real
	 *  KiCad's `HOLE_INFO` (a single record with `m_Hole_Shape=1`, not two
	 *  independent round holes) — the Excellon writer needs both ends to
	 *  emit the real start+`G85`+end sequence. */
	AddSlot(aStart: Vec2, aEnd: Vec2, aWidth: number, aOwner = ''): void {
		this.m_hits.push({ position: aStart.copy(), end: aEnd.copy(), drillSize: aWidth, shape: 'oblong', owner: aOwner });
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
