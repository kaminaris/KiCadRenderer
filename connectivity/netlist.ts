/*
 * Ported from KiCad source:
 *   netlist_exporter_base.h / eeschema netlist format concepts
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A netlist model + extractor. Given schematic components (each with a ref,
 * value, footprint and a list of pins each carrying a net name), it builds the
 * netlist: the ordered list of nets with their member (reference, pin)
 * entries. This mirrors the shape KiCad's netlist_exporter produces.
 */

/** One pin of a component in the netlist. */
export interface NETLIST_PIN {
	// The pin number.
	number: string;
	// The net name this pin belongs to.
	net: string;
	// Pin function / type (input/output/power...).
	type?: string;
}

/** One component (a schematic symbol instance). */
export interface NETLIST_COMPONENT {
	reference: string;
	value: string;
	footprint: string;
	datasheet: string;
	pins: NETLIST_PIN[];
}

/** One net in the netlist: its name and the member pins. */
export interface NETLIST_NET {
	name: string;
	// (reference, pin number) members.
	members: { reference: string; pinNumber: string }[];
}

/**
 * A netlist: the list of components and the list of nets (with their
 * membership). Mirrors KiCad's NETLIST.
 */
export class NETLIST {
	components: NETLIST_COMPONENT[] = [];
	nets: NETLIST_NET[] = [];

	/** The number of components. */
	GetComponentCount(): number {
		return this.components.length;
	}

	/** The number of nets. */
	GetNetCount(): number {
		return this.nets.length;
	}

	/** The net with the given name, or null. */
	FindNet(aNetName: string): NETLIST_NET | null {
		return this.nets.find(n => n.name === aNetName) ?? null;
	}

	/** The component with the given reference, or null. */
	FindComponent(aReference: string): NETLIST_COMPONENT | null {
		return this.components.find(c => c.reference === aReference) ?? null;
	}
}

/**
 * Builds a netlist from the given components. Each pin's `net` is already
 * resolved (by the caller's connectivity); this groups pins into nets, keeps
 * components ordered by reference, and orders nets by name (matches KiCad's
 * stable netlist output).
 */
export function buildNetlist(aComponents: NETLIST_COMPONENT[]): NETLIST {
	const nl = new NETLIST();

	// Sort components by reference (R1, R2, ..., U1, ...).
	nl.components = [...aComponents].sort((a, b) => compareRefs(a.reference, b.reference));

	// Group pins into nets.
	const netMap = new Map<string, { reference: string; pinNumber: string }[]>();
	for (const comp of nl.components) {
		for (const pin of comp.pins) {
			if (!pin.net) {
				continue;
			}
			const bucket = netMap.get(pin.net) ?? [];
			bucket.push({ reference: comp.reference, pinNumber: pin.number });
			netMap.set(pin.net, bucket);
		}
	}

	nl.nets = [...netMap.entries()]
		.map(([name, members]) => ({ name, members }))
		.sort((a, b) => a.name.localeCompare(b.name));

	return nl;
}

/** Compares component references (with numeric-aware ordering). */
export function compareRefs(a: string, b: string): number {
	const m = /^([A-Za-z]+)(\d*)$/.exec(a);
	const n = /^([A-Za-z]+)(\d*)$/.exec(b);
	if (m && n) {
		if (m[1]! !== n[1]!) {
			return m[1]!.localeCompare(n[1]!);
		}
		const na = m[2] ? parseInt(m[2], 10) : 0;
		const nb = n[2] ? parseInt(n[2], 10) : 0;
		return na - nb;
	}
	return a.localeCompare(b);
}
