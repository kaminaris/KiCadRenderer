/*
 * Ported from KiCad source:
 *   eeschema/netlist_exporter_* / netcode concept, CONNECTION_SUBGRAPH code
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Net-code assignment: given a set of resolved netnames, assigns a stable
 * integer net code to each (sorted by name), returning a NETCODED_LIST. This
 * is the subgraph-code/assignment half of netlist generation. Codes start at
 * net 0 = "not connected".
 */

/** A net code -> netname entry. */
export interface NETCODED_ENTRY {
	code: number;
	name: string;
}

/**
 * Assigns net codes to the given net names deterministically (sorted by
 * name); returns the ordered list plus a name->code map. Mirrors KiCad's net
 * code assignment (net 0 reserved).
 */
export function assignNetCodes(aNetNames: string[]): {
	list: NETCODED_ENTRY[];
	map: Map<string, number>;
} {
	// Unique, sorted.
	const unique = [...new Set(aNetNames.filter(n => n !== ''))].sort();
	const map = new Map<string, number>();
	const list: NETCODED_ENTRY[] = [];

	let code = 1; // net 0 = not connected
	for (const name of unique) {
		map.set(name, code);
		list.push({ code, name });
		code++;
	}
	return { list, map };
}

/**
 * A resolved net-code list, mirroring KiCad's NETCODE / net names indexed by
 * code.
 */
export class NETCODE_LIST {
	private m_code: string[] = []; // name per code (index = code)
	private m_map = new Map<string, number>(); // name -> code

	/** Builds the list from a set of net names. */
	Build(aNetNames: string[]): void {
		const { list, map } = assignNetCodes(aNetNames);
		this.m_map = map;
		this.m_code = [''];
		for (const e of list) {
			this.m_code[e.code] = e.name;
		}
	}

	/** The net name for a code ('' for 0 = not connected). */
	GetNetname(aCode: number): string {
		return this.m_code[aCode] ?? '';
	}

	/** The net code for a name, or 0. */
	GetCode(aNetname: string): number {
		return this.m_map.get(aNetname) ?? 0;
	}

	GetNetCode(aNetname: string): number {
		return this.GetCode(aNetname);
	}

	/** The highest assigned code. */
	GetMaxCode(): number {
		return this.m_code.length - 1;
	}

	GetNetCount(): number {
		return this.GetMaxCode();
	}
}
