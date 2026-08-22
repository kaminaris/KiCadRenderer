/*
 * Ported from KiCad source:
 *   eeschema/netlist_exporter_generic.cpp (concept)
 *   eeschema/connection_graph.cpp (driver-based net naming)
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Schematic-to-netlist extractor: given schematic components (with ref/value/
 * footprint, pins at positions and electrical types) plus the wires/labels/
 * power flags, resolve each pin's net. Net naming is driver-based: for each
 * connected wire cluster, the name is chosen by ranking pin electrical types
 * and power flags, mirroring KiCad's CONNECTION_SUBGRAPH driver resolution.
 * Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { NETLIST, NETLIST_COMPONENT, NETLIST_PIN, buildNetlist } from './netlist';
import { NET_LABEL, POWER_FLAG, WIRE, expandBusLabel, isBusLabel, mapBusPinToMember } from './SchematicNetlist';
import { PIN_TYPE, resolveNetDriver, pinDriverPriority } from '../geometry/PinInfo';
import { symbolReference, symbolValue, symbolFootprint, symbolDatasheet } from './SymbolElement';
import { KicadElementSymbol } from '@kicad-io/KicadElementSymbol';
import { KicadElementPin } from '@kicad-io/KicadElementPin';
import { KicadElementLibSymbols } from '@kicad-io/KicadElementLibSymbols';

/** A schematic component pin, with its electrical type. */
export interface SCH_PIN {
	number: string;
	position: Vec2;
	type: PIN_TYPE;
}

/** A schematic component instance (for extraction). */
export interface SCH_COMPONENT {
	reference: string;
	value: string;
	footprint: string;
	datasheet: string;
	// Pins: each with a number, position and electrical type.
	pins: SCH_PIN[];
}

/**
 * Builds a NETLIST from schematic components + wires + labels + power flags.
 * For each pin, finds the wire(s) that contain its position and assigns the
 * resolved net name; power flags propagate their value name; bus labels are
 * left for the caller (a single bus pin expands via expandBusLabel).
 *
 * Driver-based net naming: for each connected wire cluster, the net name is
 * chosen by ranking pin electrical types (output/power_out/open_collector/
 * open_emitter/bidirectional highest, then power_in, then input/passive) and
 * power flags. This mirrors KiCad's CONNECTION_SUBGRAPH driver ranking and
 * ERC net-driver resolution.
 */
export function buildSchematicNetlist(
	aComponents: SCH_COMPONENT[],
	aWires: WIRE[],
	aLabels: NET_LABEL[],
	aFlags: POWER_FLAG[] = []
): NETLIST {
	const nets = resolveNetnamesWithDrivers(aWires, aLabels, aFlags, aComponents);

	// Convert component pins to netlist pins by mapping pin position -> net.
	const comps: NETLIST_COMPONENT[] = aComponents.map(c => {
		const pins: NETLIST_PIN[] = c.pins.map(pin => {
			let net = netAtPosition(nets, aWires, pin.position);
			if (isBusLabel(net)) {
				net = memberNetForPin(net, pin.position, aWires);
			}
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

/**
 * Resolves net names with driver-based precedence. Power flags are treated as
 * POWER_OUT drivers. Pin electrical types rank via resolveNetDriver. Labels
 * provide fallback names when no driver is present.
 */
function resolveNetnamesWithDrivers(
	aWires: WIRE[],
	aLabels: NET_LABEL[],
	aFlags: POWER_FLAG[],
	aComponents: SCH_COMPONENT[]
): Map<string, string> {
	if (aWires.length === 0) {
		return new Map();
	}

	// Union-find over wires by shared endpoints / T-junctions.
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		let root = id;
		while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
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
	}

	for (let i = 0; i < aWires.length; i++) {
		const a = aWires[i]!;
		for (let j = i + 1; j < aWires.length; j++) {
			const b = aWires[j]!;
			if (
				pointEquals(a.start, b.start) || pointEquals(a.start, b.end) ||
				pointEquals(a.end, b.start) || pointEquals(a.end, b.end) ||
				onSegmentL(a.start, b.start, b.end) || onSegmentL(a.end, b.start, b.end) ||
				onSegmentL(b.start, a.start, a.end) || onSegmentL(b.end, a.start, a.end)
			) {
				union(a.id, b.id);
			}
		}
	}

	// Map root -> wire ids.
	const wiresByRoot = new Map<string, string[]>();
	for (const w of aWires) {
		const root = find(w.id);
		if (!wiresByRoot.has(root)) wiresByRoot.set(root, []);
		wiresByRoot.get(root)!.push(w.id);
	}

	// Collect candidate names and pin drivers per root.
	interface RootInfo {
		labels: string[];
		flags: string[];
		pins: Array<{ type: PIN_TYPE; name: string; ref: string; number: string }>;
	}
	const infoByRoot = new Map<string, RootInfo>();
	for (const root of wiresByRoot.keys()) {
		infoByRoot.set(root, { labels: [], flags: [], pins: [] });
	}

	for (const label of aLabels) {
		for (const w of aWires) {
			if (onSegmentL(label.point, w.start, w.end)) {
				infoByRoot.get(find(w.id))!.labels.push(label.name);
				break;
			}
		}
	}

	for (const flag of aFlags) {
		for (const w of aWires) {
			if (onSegmentL(flag.point, w.start, w.end)) {
				infoByRoot.get(find(w.id))!.flags.push(flag.name);
				break;
			}
		}
	}

	for (const comp of aComponents) {
		for (const pin of comp.pins) {
			for (const w of aWires) {
				if (onSegmentL(pin.position, w.start, w.end)) {
					infoByRoot.get(find(w.id))!.pins.push({
						type: pin.type,
						name: `${comp.reference}-${pin.number}`,
						ref: comp.reference,
						number: pin.number,
					});
					break;
				}
			}
		}
	}

	// Choose a name per root.
	const nameByRoot = new Map<string, string>();
	for (const [root, info] of infoByRoot) {
		// Build driver candidates: power flags first (POWER_OUT), then pins.
		const driverCandidates: Array<{ type: PIN_TYPE; index: number }> = [];
		for (const _flagName of info.flags) {
			driverCandidates.push({ type: PIN_TYPE.POWER_OUT, index: -1 });
		}
		for (const _pin of info.pins) {
			driverCandidates.push({ type: _pin.type, index: -1 });
		}

		const driver = resolveNetDriver(driverCandidates);

		if (driver && pinDriverPriority(driver.type) > 0) {
			// Power flag names have highest priority.
			if (info.flags.length > 0) {
				nameByRoot.set(root, info.flags[0]!);
				continue;
			}

			// Otherwise, prefer an explicit label if present; otherwise use the
			// driver pin's reference as the net name (KiCad net naming convention
			// when no label exists).
			const driverPin = info.pins.find(p => p.type === driver.type);
			nameByRoot.set(root, info.labels[0] ?? driverPin?.name ?? `Net-${root}`);
		} else {
			// No driver: use the first label, or a generated name.
			nameByRoot.set(root, info.labels[0] ?? info.flags[0] ?? `Net-${root}`);
		}
	}

	const result = new Map<string, string>();
	for (const w of aWires) {
		result.set(w.id, nameByRoot.get(find(w.id)) ?? '');
	}
	return result;
}

function pointEquals(a: Vec2, b: Vec2): boolean {
	return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
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

/** Maps a bus net name to the member net for `aPosition` along the bus wire
 *  it sits on. Fallback: the first expanded member. */
function memberNetForPin(aBusName: string, aPosition: Vec2, aWires: WIRE[]): string {
	const members = expandBusLabel(aBusName);
	if (!members || members.length === 0) {
		return aBusName;
	}
	// Find the bus wire containing the pin.
	for (const w of aWires) {
		if (onSegmentL(aPosition, w.start, w.end)) {
			const member = mapBusPinToMember(aPosition, w, aBusName);
			if (member) {
				return member;
			}
			break;
		}
	}
	return members[0]!;
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
	const libSymbols = findLibSymbols(rootElement);

	for (const c of children) {
		const name = c?.name;
		if (name === 'wire' || name === 'bus') {
			wires.push(...wireFromPtsElement(c, wires.length));
		} else if (name === 'symbol') {
			comps.push(componentFromSymbol(c, libSymbols));
			if (isPowerSymbol(c)) {
				// A power symbol's value names a flag at the symbol's pin.
				const pin = firstPinPosition(c, libSymbols);
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

function findLibSymbols(rootElement: any): KicadElementLibSymbols | null {
	if (!rootElement?.children) return null;
	for (const c of rootElement.children) {
		if (c instanceof KicadElementLibSymbols) {
			return c;
		}
	}
	return null;
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

function componentFromSymbol(el: any, libSymbols: KicadElementLibSymbols | null): SCH_COMPONENT {
	const reference = symbolReference(el);
	const value = symbolValue(el);
	const footprint = symbolFootprint(el);
	const datasheet = symbolDatasheet(el);
	const pins: SCH_PIN[] = [];

	// Resolve the library definition for placed instances.
	const defs = resolveSymbolDef(el, libSymbols);
	const origin = el.getOrigin?.() ?? { x: 0, y: 0, rotation: 0 };
	const mirror = typeof el.getMirror === 'function' ? el.getMirror() : null;

	const seen = new Set<string>();
	for (const def of defs) {
		if (!(def instanceof KicadElementSymbol)) continue;
		const libPins = collectPinsFromSymbol(def);
		for (const pin of libPins) {
			const { number } = pin.getPin();
			if (seen.has(number)) continue;
			seen.add(number);
			const pos = pin.getOrigin();
			const world = transformLocalToWorld(
				new Vec2(pos.x, pos.y),
				new Vec2(origin.x, origin.y),
				origin.rotation ?? 0,
				mirror
			);
			const et = pin.getType().electricalType;
			pins.push({ number, position: world, type: electricalTypeToPinType(et) });
		}
	}

	return { reference, value, footprint, datasheet, pins };
}

/** Collect every pin from a library symbol, including its unit sub-symbols. */
function collectPinsFromSymbol(symbol: KicadElementSymbol): KicadElementPin[] {
	const out: KicadElementPin[] = [];
	for (const pin of symbol.findChildrenByClass(KicadElementPin)) {
		out.push(pin);
	}
	for (const layer of symbol.getLayers()) {
		if (layer instanceof KicadElementSymbol) {
			for (const pin of layer.findChildrenByClass(KicadElementPin)) {
				out.push(pin);
			}
		}
	}
	return out;
}

function resolveSymbolDef(instance: any, libSymbols: KicadElementLibSymbols | null): KicadElementSymbol[] {
	if (!libSymbols) return [];
	const libId = typeof instance.getLibId === 'function' ? instance.getLibId() : undefined;
	if (!libId) return [];
	const libName = (typeof instance.getLibName === 'function' ? instance.getLibName() : undefined) ?? libId;
	const def = libSymbols.findSymbolByName(libName);
	if (!(def instanceof KicadElementSymbol)) return [];

	// If the definition is derived (extends), resolve the base symbol.
	if (def.isDerived()) {
		const baseName = def.getExtends();
		if (baseName) {
			const base = libSymbols.findSymbolByName(baseName);
			if (base instanceof KicadElementSymbol) return [base];
		}
	}

	return [def];
}

function transformLocalToWorld(local: Vec2, origin: Vec2, rotation: number, mirror: 'x' | 'y' | null): Vec2 {
	let x = local.x;
	let y = local.y;
	if (mirror === 'x') x = -x;
	if (mirror === 'y') y = -y;
	const rad = (rotation * Math.PI) / 180;
	const rx = x * Math.cos(rad) - y * Math.sin(rad);
	const ry = x * Math.sin(rad) + y * Math.cos(rad);
	return new Vec2(origin.x + rx, origin.y + ry);
}

function electricalTypeToPinType(et: string): PIN_TYPE {
	switch (et) {
		case 'input': return PIN_TYPE.INPUT;
		case 'output': return PIN_TYPE.OUTPUT;
		case 'bidirectional': return PIN_TYPE.BIDIRECTIONAL;
		case 'tri_state': return PIN_TYPE.TRI_STATE;
		case 'passive': return PIN_TYPE.PASSIVE;
		case 'free': return PIN_TYPE.FREE;
		case 'unspecified': return PIN_TYPE.UNSPECIFIED;
		case 'power_in': return PIN_TYPE.POWER_IN;
		case 'power_out': return PIN_TYPE.POWER_OUT;
		case 'open_collector': return PIN_TYPE.OPEN_COLLECTOR;
		case 'open_emitter': return PIN_TYPE.OPEN_EMITTER;
		case 'no_connect': return PIN_TYPE.NOCONNECT;
		default: return PIN_TYPE.UNSPECIFIED;
	}
}

function isPowerSymbol(el: any): boolean {
	return /^#PWR|^#FLG|^~$/.test(String(symbolReference(el))) ||
		(el.power ?? false) === true;
}

function valueOf(el: any): string {
	return String(symbolValue(el));
}

function firstPinPosition(el: any, libSymbols: KicadElementLibSymbols | null): Vec2 | null {
	const defs = resolveSymbolDef(el, libSymbols);
	const origin = el.getOrigin?.() ?? { x: 0, y: 0, rotation: 0 };
	const mirror = typeof el.getMirror === 'function' ? el.getMirror() : null;

	for (const def of defs) {
		if (!(def instanceof KicadElementSymbol)) continue;
		const pins = collectPinsFromSymbol(def);
		const first = pins[0];
		if (!first) continue;
		const pos = first.getOrigin();
		return transformLocalToWorld(new Vec2(pos.x, pos.y), new Vec2(origin.x, origin.y), origin.rotation ?? 0, mirror);
	}
	return null;
}
