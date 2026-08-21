/*
 * Ported from KiCad source:
 *   pcbnew/board_design_settings.h — GetClearance()
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Netclass-aware clearance resolution: the effective clearance between two
 * board items is the maximum of their netclass clearances (and any local
 * overrides), mirroring KiCad's BOARD_DESIGN_SETTINGS::GetClearance. All
 * dimensions in mm.
 */

import { NETCLASS, NETINFO_LIST } from './netinfo';

/**
 * A minimal surface for an item that can carry a net + a local clearance
 * override (pad, track, via, zone).
 */
export interface CLEARANCE_ITEM {
	GetNetCode(): number;
	// Optional local clearance override (0 = none).
	GetLocalClearance?(): number;
}

/**
 * Resolves the clearance between `aA` and `aB` using their netclasses'
 * default clearances, the largest wins (KiCad's GetClearance behaviour), with
 * local overrides taking precedence over the netclass value.
 */
export function ResolveClearance(
	aA: CLEARANCE_ITEM | null,
	aB: CLEARANCE_ITEM | null,
	aNetInfo: NETINFO_LIST,
	aBoardDefault: number
): number {
	let clearance = aBoardDefault;

	if (aA) {
		const nc = aNetInfo.GetNetItem(aA.GetNetCode())?.GetNetClass();
		const ncClearance = nc && nc !== undefined ? nc.GetClearance() : clearance;
		clearance = Math.max(clearance, ncClearance);
		const local = aA.GetLocalClearance ? aA.GetLocalClearance() : 0;
		if (local) {
			clearance = Math.max(clearance, local);
		}
	}

	if (aB) {
		const nc = aNetInfo.GetNetItem(aB.GetNetCode())?.GetNetClass();
		const ncClearance = nc && nc !== undefined ? nc.GetClearance() : clearance;
		clearance = Math.max(clearance, ncClearance);
		const local = aB.GetLocalClearance ? aB.GetLocalClearance() : 0;
		if (local) {
			clearance = Math.max(clearance, local);
		}
	}

	return clearance;
}

/**
 * The clearance of a single item against a board default (no pair).
 */
export function ResolveItemClearance(
	aItem: CLEARANCE_ITEM | null,
	aNetInfo: NETINFO_LIST,
	aBoardDefault: number
): number {
	return ResolveClearance(aItem, null, aNetInfo, aBoardDefault);
}

/** Convenience: the default clearance of a given net's netclass. */
export function NetClassClearance(aNetInfo: NETINFO_LIST, aNetCode: number, aFallback: number): number {
	const nc: NETCLASS | undefined = aNetInfo.GetNetItem(aNetCode)?.GetNetClass();
	return nc ? nc.GetClearance() : aFallback;
}
