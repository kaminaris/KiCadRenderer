/*
 * Ported from KiCad source:
 *   pcbnew/exporters/gendrill_excellon_writer.cpp — EXCELLON_WRITER
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Generates a board's Excellon drill file from a DRILL_LAYOUT — scoped
 * port of `EXCELLON_WRITER::createDrillFile()`/`writeEXCELLONHeader()`/
 * `writeCoordinates()` (confirmed against the real source at apps/kicad/
 * pcbnew/exporters/gendrill_excellon_writer.cpp). This REPLACES an
 * earlier version of this file that emitted a fixed `G71`/`G85` pair in
 * the HEADER for every file regardless of hole type — real KiCad's
 * header only ever has `G05` (drill mode); `G85` is a PER-HOLE command
 * that only appears on an oblong (slot) hole's own line, immediately
 * followed by that hole's end coordinate, which the previous version
 * never emitted (oblong holes were never distinguished from round ones
 * at all — `AddSlot()` faked a slot as two independent round holes).
 *
 * Format (DECIMAL_FORMAT, metric, non-minimal header — matches real
 * KiCad's own default file shape):
 *   M48
 *   ; DRILL file ...
 *   ; FORMAT={...}
 *   FMAT,2
 *   METRIC
 *   T1C0.600     (one line per distinct drill diameter)
 *   ...
 *   %            end of header
 *   G90          absolute mode
 *   G05          drill mode
 *   T1           select tool (only emitted when the tool actually changes)
 *   X10.5Y-20.3  a round hole hit
 *   X5Y5G85X8Y5  an oblong hole: start, G85, end — ALL ON ONE LINE for the
 *                first coordinate + G85, then the end coordinate is its
 *                own X..Y.. (matches real KiCad's line-splice exactly:
 *                start-line's trailing newline is stripped, "G85" appended,
 *                then the end coordinate line follows)
 *   G05          (after each oblong hole, back to drill mode)
 *   M30          end of file
 *
 * Deliberately scoped down from the real writer, each noted at point of
 * use:
 * - Plated/non-plated hole grouping, blind/buried via layer-pair
 *   splitting (`DRILL_SPAN`, `writeBackdrillLayerPairFile()`, multiple
 *   drill files per layer pair) aren't ported — this always emits one
 *   file for every hit in the given `DRILL_LAYOUT`.
 * - `m_useRouteModeForOval` (routing an oblong hole via `G00`/`M15`/`G01`/
 *   `M16` instead of the `G85` canned cycle) isn't ported — always uses
 *   the `G85` form.
 * - X2 attributes (`TF.FileFunction`/`TF.GenerationSoftware`/hole
 *   attributes via `writeHoleAttribute()`) aren't ported.
 * - Only `DECIMAL_FORMAT` zero-suppression is ported (real KiCad's
 *   default) — `SUPPRESS_LEADING`/`SUPPRESS_TRAILING`/`KEEP_ZEROS` aren't.
 * - Mirroring (`m_mirror`) and a non-zero `m_offset` aren't ported.
 */

import { DRILL_LAYOUT, DRILL_HIT } from './DrillGrid';

/** A drill-output hit grouped under one tool size. */
interface ToolGroup {
	toolNumber: number;
	diameter: number;
	hits: DRILL_HIT[];
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

/** Port of `writeCoordinates()`'s `DECIMAL_FORMAT` case: fixed-precision,
 *  trailing zeros stripped, but a trailing "." always keeps one zero
 *  after it. */
function fmtCoord(n: number, p: number): string {
	let s = n.toFixed(p);
	while (s.endsWith('0')) s = s.slice(0, -1);
	if (s.endsWith('.')) s += '0';
	return s;
}

/** Port of the tool-list line's own format string (`"T{}C{:.{}f}"`,
 *  createDrillFile()) — fixed precision, NOT trimmed (unlike
 *  `writeCoordinates()`'s per-hole `X../Y..` lines, which do trim —
 *  these are two different real KiCad format calls, not the same one). */
const fmtTool = (n: number, p: number): string => n.toFixed(p);

/**
 * Generates the Excellon drill file content for a drill layout and writes it
 * to `aSink` line by line. Scoped port of `EXCELLON_WRITER` (see file
 * header for exact scope).
 */
export function writeExcellon(
	aDrills: DRILL_LAYOUT,
	aSink: ExcellonSink,
	aOptions: Partial<EXCELLON_OPTIONS> = {}
): void {
	const p = aOptions.precision ?? 3;
	const mode = aOptions.absolute ?? true;

	// Group hits by distinct drill diameter -> tool number (sorted ascending,
	// matching KiCad's tool ordering). Round and oblong holes of the same
	// diameter share one tool, matching real KiCad's `diam = min(x, y)`
	// tool-sizing rule for oblong holes.
	const sizeToTool = new Map<number, number>();
	const groups: ToolGroup[] = [];
	for (const size of aDrills.UniqueDrillSizes()) {
		sizeToTool.set(size, groups.length + 1);
		groups.push({ toolNumber: groups.length + 1, diameter: size, hits: [] });
	}
	for (const hit of aDrills.Hits()) {
		const size = aDrills.UniqueDrillSizes().find(s => Math.abs(hit.drillSize - s) < 1e-9);
		if (size === undefined) continue;
		groups[sizeToTool.get(size)! - 1]!.hits.push(hit);
	}

	// Header. Port of writeEXCELLONHeader() — the non-minimal comment/
	// attribute lines are dropped (see file header), FMAT/METRIC/tool
	// list/`%` end-of-header are kept since they're what a real Excellon
	// parser actually needs.
	aSink('M48');
	aSink('FMAT,2');
	aSink('METRIC');
	for (const g of groups) {
		aSink(`T${ g.toolNumber }C${ fmtTool(g.diameter, p) }`);
	}
	aSink('%');
	aSink(mode ? 'G90' : 'G91'); // absolute vs incremental
	aSink('G05'); // drill mode (port: real header never emits G71/G85 here)

	// Round holes first, then oblong — matches real KiCad's own two-pass
	// order (`createDrillFile()`'s "read the hole list... oblong holes
	// will be created later" comment).
	let toolReference = -2;
	for (const g of groups) {
		for (const hit of g.hits) {
			if (hit.shape !== 'round') continue;
			if (toolReference !== g.toolNumber) {
				toolReference = g.toolNumber;
				aSink(`T${ g.toolNumber }`);
			}
			aSink(`X${ fmtCoord(hit.position.x, p) }Y${ fmtCoord(hit.position.y, p) }`);
		}
	}

	toolReference = -2;
	for (const g of groups) {
		for (const hit of g.hits) {
			if (hit.shape !== 'oblong' || !hit.end) continue;
			if (toolReference !== g.toolNumber) {
				toolReference = g.toolNumber;
				aSink(`T${ g.toolNumber }`);
			}
			// Port of the G85-oblong branch: start coordinate + "G85"
			// appended to the SAME line, then the end coordinate on its own
			// line, then back to drill mode.
			aSink(`X${ fmtCoord(hit.position.x, p) }Y${ fmtCoord(hit.position.y, p) }G85`);
			aSink(`X${ fmtCoord(hit.end.x, p) }Y${ fmtCoord(hit.end.y, p) }`);
			aSink('G05');
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
		lines.push(`${ count } hole${ count === 1 ? '' : 's' }: ⌀${ fmtTool(size, 3) } mm`);
	}
	lines.push(`Total: ${ aDrills.HoleCount() } holes`);
	return lines;
}
