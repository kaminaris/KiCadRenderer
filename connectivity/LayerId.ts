/*
 * Ported from KiCad source:
 *   libs/kimath/include/... layer_id.h (pcbnew) — technical layer ids
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The non-copper (technical) layer identifiers and helpers. The copper layers
 * live in ConnectivityItems.PCB_LAYER_ID (F_Cu..B_Cu, 0..31); technical
 * layers follow at 33+ per KiCad's layer_id.h.
 */

/** Copper layer count (0..31 in ConnectivityItems). */
export const COPPER_LAYER_COUNT_TECH = 32;

/** The first technical layer id (KiCad: after B_Cu=31 and the reserved 32). */
export const FIRST_TECHNICAL_LAYER = 33;

/** Technical (non-copper) PCB layer identifiers, mirroring layer_id.h. */
export const TECHNICAL_LAYER = {
	Edge_Cuts: 33,
	Margin: 34,
	F_Mask: 35,
	B_Mask: 36,
	F_Paste: 37,
	B_Paste: 38,
	F_SilkS: 39,
	B_SilkS: 40,
	F_Adhes: 41,
	B_Adhes: 42,
	F_CrtYd: 43,
	B_CrtYd: 44,
	F_Fab: 45,
	B_Fab: 46,
	Dwgs_User: 47,
	Cmts_User: 48,
	Eco1_User: 49,
	Eco2_User: 50,
} as const;

export type TECHNICAL_LAYER_VALUE = (typeof TECHNICAL_LAYER)[keyof typeof TECHNICAL_LAYER];

/** True if `aLayerId` is one of the copper layers (0..31). */
export function IsCuLayer(aLayerId: number): boolean {
	return aLayerId >= 0 && aLayerId < COPPER_LAYER_COUNT_TECH;
}

/** True if `aLayerId` is a technical (non-copper) layer. */
export function IsNonCuLayer(aLayerId: number): boolean {
	return aLayerId >= FIRST_TECHNICAL_LAYER;
}

/** The copper layer name for a copper layer id (F_Cu / InN.Cu / B_Cu). */
export function LayerName(aLayerId: number): string {
	if (aLayerId === 0) {
		return 'F.Cu';
	}
	if (aLayerId === 31) {
		return 'B.Cu';
	}
	if (aLayerId >= 1 && aLayerId <= 30) {
		return `In${ aLayerId }.Cu`;
	}

	switch (aLayerId) {
		case TECHNICAL_LAYER.Edge_Cuts:
			return 'Edge.Cuts';
		case TECHNICAL_LAYER.F_Mask:
			return 'F.Mask';
		case TECHNICAL_LAYER.B_Mask:
			return 'B.Mask';
		case TECHNICAL_LAYER.F_Paste:
			return 'F.Paste';
		case TECHNICAL_LAYER.B_Paste:
			return 'B.Paste';
		case TECHNICAL_LAYER.F_SilkS:
			return 'F.SilkS';
		case TECHNICAL_LAYER.B_SilkS:
			return 'B.SilkS';
		case TECHNICAL_LAYER.F_Fab:
			return 'F.Fab';
		case TECHNICAL_LAYER.B_Fab:
			return 'B.Fab';
		default:
			return `Layer${ aLayerId }`;
	}
}

/** Maps a KiCad layer name back to its id (copper + known technical). */
export function LayerIdOf(aName: string): number {
	switch (aName) {
		case 'F.Cu':
			return 0;
		case 'B.Cu':
			return 31;
		case 'Edge.Cuts':
			return TECHNICAL_LAYER.Edge_Cuts;
		case 'F.Mask':
			return TECHNICAL_LAYER.F_Mask;
		case 'B.Mask':
			return TECHNICAL_LAYER.B_Mask;
		case 'F.Paste':
			return TECHNICAL_LAYER.F_Paste;
		case 'B.Paste':
			return TECHNICAL_LAYER.B_Paste;
		case 'F.SilkS':
			return TECHNICAL_LAYER.F_SilkS;
		case 'B.SilkS':
			return TECHNICAL_LAYER.B_SilkS;
		case 'F.Fab':
			return TECHNICAL_LAYER.F_Fab;
		case 'B.Fab':
			return TECHNICAL_LAYER.B_Fab;
		default: {
			const m = /^In(\d+)\.Cu$/.exec(aName);
			if (m) {
				const n = parseInt(m[1]!, 10);
				if (n >= 1 && n <= 30) {
					return n;
				}
			}
			return -1;
		}
	}
}
