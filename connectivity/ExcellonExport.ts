/*
 * Ported from KiCad source:
 *   pcbnew/pcb_plot_params.h / plot_brditems_plotter.cpp / plotter.h
 *   pcbnew/drill.cpp — EXCELLON_WRITER (Excellon drill file generator)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Generates the standard Excellon drill file (a board's `*.drl`) from a
 * DRILL_LAYOUT: tool-size definitions, then one G85/G99 hit command per hole,
 * finished with M30. Mirrors KiCad's EXCELLON_WRITER output.
 *
 * Format (Excellon2):
 *   M48          start of the header (tool definitions)
 *   METRIC       units = mm
 *   T1C0.600     tool 1 cuts 0.600 mm (one line per distinct drill diameter)
 *   ...          (T2, T3, ... for the other diameters)
 *   G90          absolute coordinates (G91 = incremental)
 *   G00          rapid positioning
 *   G71          units for coordinates (metric)
 *   G85          canned cycle (slot support)
 *   %            end of the header
 *   T1           select tool 1
 *   X10.0Y20.0   a hit at (10.0, 20.0)
 *   ...
 *   M30          end of file
 */

import { Vec2 } from '../math/Vec2';
import { DRILL_LAYOUT, DRILL_HIT } from './DrillGrid';

/** A drill-output hit grouped under one tool size. */
interface ToolGroup {
	toolNumber: number;
	diameter: number;
	hits: Vec2[];
}

/** Options for the Excellon writer. */
export interface EXCELLON_OPTIONS {
	/** Coordinate precision (decimal places). KiCad defaults to 3 in metric. */
	precision: number;
	/** Use absolute coordinates (G90). */
	absolute: boolean;
}

/** Output buffer type (same as FILE_WRITER's line sink). */
export type ExcellonSink = (line: string) => void;

const fmt = (n: number, p: number): string => {
	const fixed = n.toFixed(p);
	return fixed.indexOf('.') >= 0 ? fixed.replace(/\.?0+$/, '') : fixed;
};

/**
 * Generates the Excellon drill file content for a drill layout and writes it
 * to `aSink` line by line. Mirrors KiCad's EXCELLON_WRITER.
 */
export function writeExcellon(
	aDrills: DRILL_LAYOUT,
	aSink: ExcellonSink,
	aOptions: Partial<EXCELLON_OPTIONS> = {}
): void {
	const p = aOptions.precision ?? 3;
	const mode = aOptions.absolute ?? true;

	// Group hits by distinct drill diameter -> tool number (sorted ascending,
	// matching KiCad's tool ordering).
	const sizeToTool = new Map<number, number>();
	const groups: ToolGroup[] = [];
	for (const size of aDrills.UniqueDrillSizes()) {
		sizeToTool.set(size, groups.length + 1);
		groups.push({ toolNumber: groups.length + 1, diameter: size, hits: [] });
	}
	for (const size of aDrills.UniqueDrillSizes()) {
		for (const hit of aDrills.Hits()) {
			if (Math.abs(hit.drillSize - size) < 1e-9) {
				groups[sizeToTool.get(size)! - 1]!.hits.push(hit.position.copy());
			}
		}
	}

	// Header.
	aSink('M48');
	aSink('METRIC');
	for (const g of groups) {
		aSink(`T${ g.toolNumber }C${ fmt(g.diameter, p) }`);
	}
	aSink(mode ? 'G90' : 'G91'); // absolute vs incremental
	aSink('G00');
	aSink('G71'); // metric coords
	aSink('G85'); // canned cycle slot support
	aSink('%');

	// Hits, grouped by tool.
	for (const g of groups) {
		aSink(`T${ g.toolNumber }`);
		for (const pos of g.hits) {
			aSink(`X${ fmt(pos.x, p) }Y${ fmt(pos.y, p) }`);
		}
	}

	// End of file.
	aSink('M30');
}

/** Convenience: collect all drill hits to a flat list of hole coordinates. */
export function collectDrillHits(aDrills: DRILL_LAYOUT): { x: number; y: number; size: number }[] {
	return aDrills.Hits().map((h: DRILL_HIT) => ({ x: h.position.x, y: h.position.y, size: h.drillSize }));
}

/**
 * The drill map legend: a per-size summary line like "12 holes Ø0.600 mm",
 * plus the total hit count. Mirrors the text legend KiCad plots on the drill
 * map layer (DrillMap.cpp). Returns the legend lines (already formatted).
 */
export function drillMapLegend(aDrills: DRILL_LAYOUT): string[] {
	const lines: string[] = [];
	for (const size of aDrills.UniqueDrillSizes().sort((a, b) => a - b)) {
		const count = aDrills.Hits().filter(h => Math.abs(h.drillSize - size) < 1e-9).length;
		lines.push(`${ count } hole${ count === 1 ? '' : 's' }: \u2300${ fmt(size, 3) } mm`);
	}
	lines.push(`Total: ${ aDrills.HoleCount() } holes`);
	return lines;
}
