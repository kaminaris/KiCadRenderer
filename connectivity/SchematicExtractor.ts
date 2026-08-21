/*
 * Ported from KiCad source:
 *   eeschema/netlist_exporter_generic.cpp (concept)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Schematic-to-netlist extractor: given schematic components (with ref/value/
 * footprint and pins at positions) plus the wires/labels/power flags, resolve
 * each pin's net (via resolveWireNetnamesWithFlags) and build a NETLIST using
 * the connectivity/netlist.ts model. Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { NETLIST, NETLIST_COMPONENT, NETLIST_PIN, buildNetlist } from './netlist';
import { NET_LABEL, POWER_FLAG, WIRE, resolveWireNetnamesWithFlags, expandBusLabel, isBusLabel } from './SchematicNetlist';

/** A schematic component instance (for extraction). */
export interface SCH_COMPONENT {
	reference: string;
	value: string;
	footprint: string;
	datasheet: string;
	// Pins: each with a number and its board/schematic position.
	pins: { number: string; position: Vec2 }[];
}

/**
 * Builds a NETLIST from schematic components + wires + labels + power flags.
 * For each pin, finds the wire(s) that contain its position and assigns the
 * resolved net name; power flags propagate their value name; bus labels are
 * left for the caller (a single bus pin expands via expandBusLabel).
 */
export function buildSchematicNetlist(
	aComponents: SCH_COMPONENT[],
	aWires: WIRE[],
	aLabels: NET_LABEL[],
	aFlags: POWER_FLAG[] = []
): NETLIST {
	const nets = resolveWireNetnamesWithFlags(aWires, aLabels, aFlags, []);

	// Convert component pins to netlist pins by mapping pin position -> net.
	const comps: NETLIST_COMPONENT[] = aComponents.map(c => {
		const pins: NETLIST_PIN[] = c.pins.map(pin => {
			const net = netAtPosition(nets, aWires, pin.position);
			return { number: pin.number, net };
		});
		return {
			reference: c.reference,
			value: c.value,
			footprint: c.footprint,
			datasheet: c.datasheet,
			pins,
		};
	});

	// Reuse connectivity/netlist.buildNetlist (groups + sorts).
	return buildNetlist(comps);
}

/** The net of a position: the resolved name of the wire containing it. */
function netAtPosition(nets: Map<string, string>, wires: WIRE[], p: Vec2): string {
	for (const w of wires) {
		if (onSegmentL(p, w.start, w.end)) {
			return nets.get(w.id) ?? '';
		}
	}
	return '';
}

function onSegmentL(p: Vec2, a: Vec2, b: Vec2): boolean {
	const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
	if (Math.abs(cross) > 1e-6) return false;
	return (
		p.x >= Math.min(a.x, b.x) - 1e-6 &&
		p.x <= Math.max(a.x, b.x) + 1e-6 &&
		p.y >= Math.min(a.y, b.y) - 1e-6 &&
		p.y <= Math.max(a.y, b.y) + 1e-6
	);
}

export { expandBusLabel, isBusLabel };

/**
 * Builds a netlist directly from a parsed `.kicad_sch` root element (the
 * `@kicad-io` AST). Walks the root's children: `symbol` (with its pins and
 * Reference property) -> components, `wire` (a `(wire (pts ...))` polyline)
 * -> wires, `label`/`hierarchical_label`/`global_label` -> net labels,
 * `net_tie`/power symbols -> power flags. Best-effort — mirrors the rough
 * KiCad schema without a full board-package walker.
 */
export function buildSchematicNetlistFromRoot(rootElement: any): NETLIST {
	const wires: WIRE[] = [];
	const labels: NET_LABEL[] = [];
	const flags: POWER_FLAG[] = [];
	const comps: SCH_COMPONENT[] = [];

	const children = rootElement?.children ?? [];

	for (const c of children) {
		const name = c?.name;
		if (name === 'wire' || name === 'bus') {
			wires.push(...wireFromPtsElement(c, wires.length));
		} else if (name === 'symbol') {
			comps.push(componentFromSymbol(c));
			if (isPowerSymbol(c)) {
				// A power symbol's value names a flag at the symbol's pin.
				const pin = firstPinPosition(c);
				if (pin) {
					flags.push({ name: valueOf(c), point: pin });
				}
			}
		} else if (name === 'label' || name === 'global_label' || name === 'hierarchical_label') {
			const t = c.text ?? c.getText?.() ?? '';
			const pos = c.getOrigin?.() ?? { x: 0, y: 0 };
			if (t) {
				labels.push({ name: t, point: new Vec2(pos.x, pos.y) });
			}
		}
	}

	return buildSchematicNetlist(comps, wires, labels, flags);
}

function wireFromPtsElement(el: any, baseIndex: number): WIRE[] {
	const out: WIRE[] = [];
	const pts = el.getPts?.() ?? el.pts ?? [];
	for (let i = 0; i < pts.length - 1; i++) {
		out.push({
			id: `w${ baseIndex }_${ i }`,
			start: new Vec2(pts[i]!.x, pts[i]!.y),
			end: new Vec2(pts[i + 1]!.x, pts[i + 1]!.y),
		});
	}
	return out;
}

function componentFromSymbol(el: any): SCH_COMPONENT {
	const reference = el.getReference?.() ?? el.Reference?.Value ?? el.reference ?? '';
	const value = el.getValue?.() ?? el.Value?.Value ?? el.value ?? '';
	const footprint = el.getFootprint?.() ?? '';
	const datasheet = el.datasheet ?? '';
	const pins: { number: string; position: Vec2 }[] = [];
	// Symbol pins live in the library symbol's `pins` child.
	for (const pin of el.pins ?? []) {
		const num = pin.number ?? pin.pin_number ?? '';
		const pos = pin.getOrigin?.() ?? pin.at ?? { x: 0, y: 0 };
		pins.push({ number: String(num), position: new Vec2(pos.x, pos.y) });
	}
	return { reference, value, footprint, datasheet, pins };
}

function isPowerSymbol(el: any): boolean {
	return /^#PWR|^#FLG|^~$/.test(String(el.reference ?? '')) ||
		(el.power ?? false) === true;
}

function valueOf(el: any): string {
	return String(el.getValue?.() ?? el.Value?.Value ?? el.value ?? '');
}

function firstPinPosition(el: any): Vec2 | null {
	const pin = (el.pins ?? [])[0];
	if (!pin) return null;
	const pos = pin.getOrigin?.() ?? pin.at ?? null;
	return pos ? new Vec2(pos.x, pos.y) : null;
}
