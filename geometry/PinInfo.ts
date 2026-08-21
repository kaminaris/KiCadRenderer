/*
 * Ported from KiCad source:
 *   eeschema/pin_type.h
 *   eeschema/lib_pin.h (PIN_SHAPE)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Pin electrical types and pin shapes for schematic symbol pins. These drive
 * ERC and netlist-driver ranking.
 */

/** Mirrors eeschema/pin_type.h ELECTRICAL_PINTYPE. */
export enum PIN_TYPE {
	INPUT = 0,
	OUTPUT = 1,
	BIDIRECTIONAL = 2,
	TRI_STATE = 3,
	PASSIVE = 4,
	FREE = 5,
	UNSPECIFIED = 6,
	POWER_IN = 7,
	POWER_OUT = 8,
	OPEN_COLLECTOR = 9,
	OPEN_EMITTER = 10,
	NOCONNECT = 11,
}

/** Mirrors the pin shapes in eeschema/lib_pin.h. */
export enum PIN_SHAPE {
	LINE = 0,
	INVISIBLE = 1,
	INVERTED = 2,
	CLOCK = 3,
	INVERTED_CLOCK = 4,
	INPUT_LOW = 5,
	CLOCK_LOW = 6,
	OUTPUT_LOW = 7,
	EDGE_CLOCK_HIGH = 8,
	NON_LOGIC = 9,
}

/** Maps a PIN_TYPE to KiCad's token string (netlist/ERC). */
export function pinTypeName(aType: PIN_TYPE): string {
	switch (aType) {
		case PIN_TYPE.INPUT: return 'input';
		case PIN_TYPE.OUTPUT: return 'output';
		case PIN_TYPE.BIDIRECTIONAL: return 'bidirectional';
		case PIN_TYPE.TRI_STATE: return 'tri_state';
		case PIN_TYPE.PASSIVE: return 'passive';
		case PIN_TYPE.FREE: return 'free';
		case PIN_TYPE.UNSPECIFIED: return 'unspecified';
		case PIN_TYPE.POWER_IN: return 'power_in';
		case PIN_TYPE.POWER_OUT: return 'power_out';
		case PIN_TYPE.OPEN_COLLECTOR: return 'open_collector';
		case PIN_TYPE.OPEN_EMITTER: return 'open_emitter';
		case PIN_TYPE.NOCONNECT: return 'no_connect';
		default: return 'unspecified';
	}
}

/** The pin shape token. */
export function pinShapeName(aShape: PIN_SHAPE): string {
	switch (aShape) {
		case PIN_SHAPE.LINE: return 'line';
		case PIN_SHAPE.INVISIBLE: return 'invisible';
		case PIN_SHAPE.INVERTED: return 'inverted';
		case PIN_SHAPE.CLOCK: return 'clock';
		case PIN_SHAPE.INVERTED_CLOCK: return 'inverted_clock';
		case PIN_SHAPE.INPUT_LOW: return 'input_low';
		case PIN_SHAPE.CLOCK_LOW: return 'clock_low';
		case PIN_SHAPE.OUTPUT_LOW: return 'output_low';
		case PIN_SHAPE.EDGE_CLOCK_HIGH: return 'edge_clock_high';
		case PIN_SHAPE.NON_LOGIC: return 'non_logic';
		default: return 'line';
	}
}

/**
 * Whether a pin type is a "driver" (can set a net): output / power_out /
 * open_collector / open_emitter / bidirectional. Mirrors ERC driver ranking.
 */
export function isDriverType(aType: PIN_TYPE): boolean {
	return (
		aType === PIN_TYPE.OUTPUT ||
		aType === PIN_TYPE.POWER_OUT ||
		aType === PIN_TYPE.OPEN_COLLECTOR ||
		aType === PIN_TYPE.OPEN_EMITTER ||
		aType === PIN_TYPE.BIDIRECTIONAL
	);
}

/**
 * A driver-priority rank for ERC / netlist, mirroring KiCad's
 * CONNECTION_SUBGRAPH driver ranking: higher wins. Input/passive lowest;
 * output / power_out / drivers high.
 */
export function pinDriverPriority(aType: PIN_TYPE): number {
	switch (aType) {
		case PIN_TYPE.OUTPUT:
		case PIN_TYPE.POWER_OUT:
		case PIN_TYPE.OPEN_COLLECTOR:
		case PIN_TYPE.OPEN_EMITTER:
		case PIN_TYPE.BIDIRECTIONAL:
			return 2;
		case PIN_TYPE.POWER_IN:
			return 1;
		case PIN_TYPE.INPUT:
		case PIN_TYPE.PASSIVE:
		case PIN_TYPE.FREE:
		case PIN_TYPE.UNSPECIFIED:
		case PIN_TYPE.TRI_STATE:
			return 0;
		default:
			return 0;
	}
}

/**
 * Resolves the "driver" of a net from its pins: the highest-priority
 * driver-typed pin, or null if none drives. Mirrors ERC's net-driver check.
 */
export function resolveNetDriver(
	aPins: { type: PIN_TYPE }[]
): { type: PIN_TYPE; index: number } | null {
	let best: { type: PIN_TYPE; index: number } | null = null;
	let bestRank = -1;
	for (let i = 0; i < aPins.length; i++) {
		const t = aPins[i]!.type;
		const rank = pinDriverPriority(t);
		if (rank > bestRank) {
			best = { type: t, index: i };
			bestRank = rank;
		}
	}
	// Only a driver-typed pin (rank > 0) can be the net driver.
	return best && bestRank > 0 ? best : null;
}
