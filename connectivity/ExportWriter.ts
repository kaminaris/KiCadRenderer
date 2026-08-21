/*
 * Ported from KiCad source:
 *   pcbnew/exporters/export_*.cpp (XYZ positions, BOM) concepts
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A tiny file/export abstraction plus two exporters:
 *  - XYZ (pick-and-place) positions from board footprints/pads.
 *  - BOM (bill of materials) from a netlist (components grouped by value/ref).
 * Coordinates in mm.
 */

import { NETLIST } from './netlist';

/** A file-like writer (line emitter) used by exporters. */
export class FILE_WRITER {
	private m_lines: string[] = [];

	Print(aLine: string): void {
		this.m_lines.push(aLine);
	}

	Printf(aFormat: string, ...args: (string | number)[]): void {
		// Minimal printf for %s / %d / %f.
		let i = 0;
		const out = aFormat.replace(/%[sd]/g, () => String(args[i++]))
			.replace(/%[-]?\.?[0-9]*f/g, (m) => {
				const num = args[i] as number | undefined;
				if (typeof num === 'number') {
					i++;
				}
				const width = /%[-]?\.?([0-9]*)?f/.exec(m);
				const prec = width?.[1] ? parseInt(width[1], 10) : 6;
				return (typeof num === 'number' ? num : 0).toFixed(prec);
			});
		this.m_lines.push(out);
	}

	ToString(): string {
		return this.m_lines.join('\n') + '\n';
	}

	Clear(): void {
		this.m_lines = [];
	}

	GetLineCount(): number {
		return this.m_lines.length;
	}
}

/** One pick-and-place entry. */
export interface XYZ_PLACEMENT {
	reference: string;
	value: string;
	footprint: string;
	x: number;
	y: number;
	rotationDeg: number;
	layer: string;
}

/**
 * Emits an XYZ pick-and-place file for the given placements. Mirrors KiCad's
 * export_xyz / pick-and-place format.
 */
export function writeXyzPlacement(aPlaces: XYZ_PLACEMENT[], aWriter: FILE_WRITER): void {
	aWriter.Print('Ref Des;Value;Footprint;X (mm);Y (mm);Rotation;Layer');
	for (const p of aPlaces) {
		aWriter.Printf('%s;%s;%s;%.4f;%.4f;%.2f;%s',
			p.reference, p.value, p.footprint, p.x, p.y, p.rotationDeg, p.layer);
	}
}

/**
 * Builds an XYZ placement list from a list of (reference, value, footprint,
 * x, y, rot, layer) tuples — a plain board walk.
 */
export function placementsFromTuples(
	rows: Array<[string, string, string, number, number, number, string]>
): XYZ_PLACEMENT[] {
	return rows.map(r => ({
		reference: r[0]!, value: r[1]!, footprint: r[2]!,
		x: r[3]!, y: r[4]!, rotationDeg: r[5]!, layer: r[6]!,
	}));
}

/** One BOM line: a component value with its reference list + count. */
export interface BOM_ENTRY {
	value: string;
	footprint: string;
	references: string[];
}

/**
 * Emits a BOM (bill of materials) grouped by value+footprint from a NETLIST.
 * Mirrors KiCad's generic BOM exporter output ordering.
 */
export function writeBom(aNetlist: NETLIST, aWriter: FILE_WRITER): void {
	const groups = new Map<string, BOM_ENTRY>();
	for (const c of aNetlist.components) {
		const key = `${ c.value }\u0000${ c.footprint }`;
		const g = groups.get(key) ?? { value: c.value, footprint: c.footprint, references: [] };
		g.references.push(c.reference);
		groups.set(key, g);
	}

	// Sort by value then footprint for stable output.
	const entries = [...groups.values()].sort((a, b) =>
		a.value.localeCompare(b.value) || a.footprint.localeCompare(b.footprint)
	);

	aWriter.Print('Value;Footprint;Count;References');
	for (const e of entries) {
		e.references.sort();
		aWriter.Printf('%s;%s;%d;%s', e.value, e.footprint, e.references.length, e.references.join(','));
	}
}
