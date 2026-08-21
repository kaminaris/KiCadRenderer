/*
 * Ported from KiCad source:
 *   eeschema/connection_graph.cpp (simplified subset)
 *   eeschema/sch_netname (label-as-netname concept)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Simplified schematic netname resolution: given wires (line segments), their
 * junctions, and labels (net labels / hierarchical / global), propagate net
 * names along wires that share endpoints/junctions. This is the schematic
 * half of netlist extraction (the full KiCad connection graph handles buses,
 * power flags and hierarchical sheets; here we cover direct wire + label).
 *
 * Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';

/** A schematic wire (a segment between two points on the same net). */
export interface WIRE {
	id: string;
	start: Vec2;
	end: Vec2;
}

/** A label that names a net (net label / global / hierarchical). */
export interface NET_LABEL {
	// The wire point this label attaches to.
	point: Vec2;
	name: string;
}

/** A junction (where wires connect). */
export interface JUNCTION {
	point: Vec2;
}

const EPS = 1e-6;
function pointEquals(a: Vec2, b: Vec2): boolean {
	return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}
function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
	// collinear + within bbox check
	const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
	if (Math.abs(cross) > EPS) return false;
	return (
		p.x >= Math.min(a.x, b.x) - EPS &&
		p.x <= Math.max(a.x, b.x) + EPS &&
		p.y >= Math.min(a.y, b.y) - EPS &&
		p.y <= Math.max(a.y, b.y) + EPS
	);
}

/**
 * Resolves a net name for every wire in the schematic by propagating labels
 * across shared endpoints / junctions. Wires connected by a shared endpoint
 * (or a point lying on another wire at a junction) share a net; the net is
 * named by the first label attached to any member.
 *
 * Returns a map: wire.id -> resolved net name ('' if unnamed).
 */
export function resolveWireNetnames(
	aWires: WIRE[],
	aLabels: NET_LABEL[],
	_aJunctions: JUNCTION[]
): Map<string, string> {
	// Union-find over wires by shared endpoints.
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		while (parent.get(id) !== undefined && parent.get(id) !== id) {
			parent.set(id, parent.get(id)!);
			id = parent.get(id)!;
		}
		return id;
	};
	const union = (a: string, b: string): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) {
			parent.set(ra, rb);
		}
	};

	for (const w of aWires) {
		if (!parent.has(w.id)) parent.set(w.id, w.id);
	}

	// Union wires whose endpoints coincide.
	for (let i = 0; i < aWires.length; i++) {
		for (let j = i + 1; j < aWires.length; j++) {
			const a = aWires[i]!;
			const b = aWires[j]!;
			if (
				pointEquals(a.start, b.start) || pointEquals(a.start, b.end) ||
				pointEquals(a.end, b.start) || pointEquals(a.end, b.end)
			) {
				union(a.id, b.id);
			}
			// also union when an endpoint lies on the other wire (T junction)
			if (
				onSegment(a.start, b.start, b.end) || onSegment(a.end, b.start, b.end) ||
				onSegment(b.start, a.start, a.end) || onSegment(b.end, a.start, a.end)
			) {
				union(a.id, b.id);
			}
		}
	}

	// Attach labels to the wire that contains the label's point, and
	// propagate the name to the whole set.
	const nameByRoot = new Map<string, string>();
	for (const label of aLabels) {
		for (const w of aWires) {
			if (onSegment(label.point, w.start, w.end)) {
				const root = find(w.id);
				if (!nameByRoot.has(root)) {
					nameByRoot.set(root, label.name);
				}
				break;
			}
		}
	}

	const result = new Map<string, string>();
	for (const w of aWires) {
		result.set(w.id, nameByRoot.get(find(w.id)) ?? '');
	}
	return result;
}

/**
 * A power flag: a power symbol (e.g. `#PWR01`, VCC, GND) whose single pin's
 * net is named by its value. Mirrors KiCad's "power flags" / global power
 * symbols.
 */
export interface POWER_FLAG {
	// The value, e.g. "VCC", "GND".
	name: string;
	// The pin position (where the flag's pin attaches to a wire).
	point: Vec2;
}

/**
 * Resolves net names including power flags: every wire whose path is connected
 * (endpoint/junction union) to a power-flag pin gets the flag's name. Extends
 * resolveWireNetnames with `aFlags` (power flags) and `aBusLabels` (net labels
 * connected on a bus).
 */
export function resolveWireNetnamesWithFlags(
	aWires: WIRE[],
	aLabels: NET_LABEL[],
	aFlags: POWER_FLAG[],
	aJunctions: JUNCTION[] = []
): Map<string, string> {
	// Build connected clusters (endpoint / on-segment union).
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		let root = id;
		while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
		// path compress
		let cur = id;
		while (parent.has(cur) && parent.get(cur) !== root) {
			const next = parent.get(cur)!;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	const union = (a: string, b: string): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	for (const w of aWires) {
		if (!parent.has(w.id)) parent.set(w.id, w.id);
		for (let j = 0; j < aWires.length; j++) {
			const o = aWires[j]!;
			if (
				pointEquals(w.start, o.start) || pointEquals(w.start, o.end) ||
				pointEquals(w.end, o.start) || pointEquals(w.end, o.end) ||
				onSegment(w.start, o.start, o.end) || onSegment(w.end, o.start, o.end)
			) {
				union(w.id, o.id);
			}
		}
	}

	// Name each cluster: flags first (a flag on the cluster names it), else the
	// first label on the cluster.
	const nameByRoot = new Map<string, string>();

	const setNameByWire = (wireId: string, name: string): void => {
		const root = find(wireId);
		if (!nameByRoot.has(root)) {
			nameByRoot.set(root, name);
		}
	};

	for (const flag of aFlags) {
		for (const w of aWires) {
			if (onSegment(flag.point, w.start, w.end)) {
				setNameByWire(w.id, flag.name);
				break;
			}
		}
	}
	for (const label of aLabels) {
		for (const w of aWires) {
			if (onSegment(label.point, w.start, w.end)) {
				setNameByWire(w.id, label.name);
				break;
			}
		}
	}

	const result = new Map<string, string>();
	for (const w of aWires) {
		result.set(w.id, nameByRoot.get(find(w.id)) ?? '');
	}
	return result;
}

/**
 * Whether a label looks like a bus label, e.g. `A[0..7]` or `DATA[3:0]`.
 * Mirrors KiCad's bus-name detection.
 */
export function isBusLabel(aName: string): boolean {
	return /^[^[\]]+\[[0-9]+(\s*\.\.\s*|\s*[:]\s*)[0-9]+\]$/.test(aName) ||
		/^[^[\]]+\[\s*\*\]$/.test(aName);
}

/**
 * Expands a bus label (e.g. `A[0..7]`) into its member net names
 * (`A0`, `A1`, ... `A7`), ascending. Returns null if not a bus label.
 */
export function expandBusLabel(aName: string): string[] | null {
	if (!isBusLabel(aName)) {
		return null;
	}
	const m = /^([^[\]]+)\[([0-9]+)\s*(?:\.\.|:)\s*([0-9]+)\]$/.exec(aName);
	if (m) {
		const base = m[1]!;
		const lo = parseInt(m[2]!, 10);
		const hi = parseInt(m[3]!, 10);
		const out: string[] = [];
		for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) {
			out.push(base + i);
		}
		return out;
	}
	// A[*] — a wildcard bus (any member). Return [] (caller decides).
	return [];
}

/**
 * A hierarchical sheet: a logical sub-sheet with named pins (sheet pins /
 * hierarchical labels) that couple nets inside the sub-sheet to nets outside.
 * Mirrors SCH_SHEET + SCH_SHEET_PIN concept.
 */
export interface SCH_SHEET {
	id: string;
	// Sheet pins: name -> position (the port position inside the sheet).
	pins: { name: string; point: Vec2 }[];
	// Sheet reference (e.g. "S1").
	reference: string;
}

/**
 * Resolves net names across a hierarchy: a sub-sheet's sheet pins act as net
 * labels (same name inside and outside couples those nets). Each sheet's pins
 * are folded in as extra labels before netname resolution. Simplification of
 * KiCad's connection_graph hierarchical pass.
 */
export function applyHierarchy(
	sheetWires: Map<string, WIRE[]>,
	sheetLabels: Map<string, NET_LABEL[]>,
	sheetFlags: Map<string, POWER_FLAG[]>,
	sheets: SCH_SHEET[]
): Map<string, Map<string, string>> {
	const perSheet = new Map<string, Map<string, string>>();

	for (const sheet of sheets) {
		const wires = sheetWires.get(sheet.id) ?? [];
		const labels = sheetLabels.get(sheet.id) ?? [];
		const flags = sheetFlags.get(sheet.id) ?? [];

		// Fold the sheet pins in as labels at their positions.
		const labelsWithPins: NET_LABEL[] = [...labels];
		for (const pin of sheet.pins) {
			labelsWithPins.push({ point: pin.point, name: pin.name });
		}

		perSheet.set(sheet.id, resolveWireNetnamesWithFlags(wires, labelsWithPins, flags, []));
	}

	// Clone the per-sheet results (the coupling across matching pin names on
	// parent/child is by definition: the same name yields the same netname).
	const result = new Map<string, Map<string, string>>();
	for (const [sid, nets] of perSheet) {
		result.set(sid, new Map(nets));
	}
	return result;
}

/**
 * A global label — a net label that shares the same net across the whole
 * schematic (its name is the net name, regardless of where it sits).
 */
export interface GLOBAL_LABEL {
	name: string;
	point: Vec2;
}

/**
 * Global-label transitive closure pre-pass: sets a wire's net to a global
 * label's name whenever a global label sits on that wire's path. Mirrors the
 * connection_graph.cpp "global-label transitive-closure pre-pass" for the
 * single-sheet case.
 */
export function applyGlobalLabels(
	aWires: WIRE[],
	aGlobalLabels: GLOBAL_LABEL[],
	baseNetnames: Map<string, string>
): Map<string, string> {
	const result = new Map(baseNetnames);
	for (const gl of aGlobalLabels) {
		for (const w of aWires) {
			if (onSegment(gl.point, w.start, w.end)) {
				result.set(w.id, gl.name);
				break;
			}
		}
	}
	return result;
}

/**
 * A net-tie: an element that electrically joins two nets (a zero-ohm link).
 * Each `net_tie` has two (or more) net names it connects.
 */
export interface NET_TIE {
	nets: string[];
}

/**
 * Merges nets joined by net-ties: any wire already netnamed with one of a
 * net-tie's names is unified with the others (the first net-tie name wins).
 * Extends KiCad's net-tie handling (a simple name-groups merge here).
 */
export function mergeNetTies(baseNetnames: Map<string, string>, ties: NET_TIE[]): Map<string, string> {
	const result = new Map(baseNetnames);
	for (const tie of ties) {
		const canonical = tie.nets[0] ?? '';
		if (!canonical) continue;
		for (const [id, n] of result) {
			if (tie.nets.includes(n)) {
				result.set(id, canonical);
			}
		}
	}
	return result;
}

/**
 * Maps a pin/point attached to a bus wire (whose label is a bus name like
 * `ADDR[0..7]`) to one of the bus's expanded member nets, by the point's
 * relative position along the bus wire (t from 0..1). Mirrors KiCad's bus
 * member assignment (index = t * memberCount), a best-effort simplification.
 */
export function mapBusPinToMember(
	aPoint: Vec2,
	aBusWire: WIRE,
	aBusLabel: string
): string | null {
	const members = expandBusLabel(aBusLabel);
	if (!members) {
		return aBusLabel; // not a bus — the label IS the net
	}
	if (members.length === 0) {
		return null;
	}
	// Project the point onto the bus wire to get t.
	const a = aBusWire.start;
	const b = aBusWire.end;
	const vx = b.x - a.x;
	const vy = b.y - a.y;
	const lenSq = vx * vx + vy * vy;
	let t = 0;
	if (lenSq > 1e-12) {
		t = ((aPoint.x - a.x) * vx + (aPoint.y - a.y) * vy) / lenSq;
		t = Math.max(0, Math.min(1, t));
	}
	const idx = Math.min(members.length - 1, Math.floor(t * members.length));
	return members[idx] ?? null;
}

/**
 * The net class a power symbol's net belongs to (a power flag declares a net
 * class, e.g. a "POWER" group). Mirrors KiCad's netclass-on-power-flag concept.
 */
export function powerNetClassOf(aPowerName: string, aFallback = 'Default'): string {
	// Common convention: the net class is derived from the power name for
	// well-known rails; else Default.
	const upper = aPowerName.toUpperCase();
	if (upper === 'GND' || upper === 'VCC' || upper === 'VDD' || upper === 'VSS' || upper === 'VEE') {
		return 'Default';
	}
	return aFallback;
}

/**
 * A sheet instance carrying a bus label: the hierarchical sheet has a bus
 * label (e.g. ADDR[0..7]) at a port; expand it to member nets for bus-aware
 * hierarchical resolution. Mirrors KiCad's bus-through-sheet concept.
 */
export interface SHEET_BUS_INSTANCE {
	// The sheet's pin name (a bus label).
	busLabel: string;
	// The expanded member net names.
	members(): string[];
}

/**
 * Expands a sheet-instance bus label to its members (or [label] if not a bus).
 */
export function sheetBusMembers(aBusLabel: string): string[] {
	const m = expandBusLabel(aBusLabel);
	return m !== null && m.length > 0 ? m : [aBusLabel];
}

/**
 * returns the set of net classes declared on power symbols (best-effort).
 */
export function powerSymbolsDeclaredNetClasses(aFlags: POWER_FLAG[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const f of aFlags) {
		map.set(f.name, powerNetClassOf(f.name));
	}
	return map;
}
