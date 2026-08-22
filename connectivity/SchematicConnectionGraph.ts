/*
 * Ported from KiCad source:
 *   eeschema/connection_graph.cpp
 *   eeschema/connection_subgraph.cpp
 *   eeschema/netlist_exporter_generic.cpp
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Project-wide schematic connection graph. Builds connection subgraphs across
 * all sheet instances, couples them through hierarchical sheet pins / labels
 * and global labels, assigns subgraph codes, resolves net names with driver
 * ranking, and produces a NETLIST. This is a simplified port of KiCad's
 * CONNECTION_GRAPH / CONNECTION_SUBGRAPH.
 *
 * Simplifications vs. real KiCad:
 *   - No exact schematic-item geometric merging; wires are merged by endpoint
 *     / T-junction as in SchematicNetlist.
 *   - Multi-unit symbols are not filtered by placed unit; all distinct pins are
 *     collected.
 *   - Derived symbol overrides are not merged with their base.
 *   - Sheet instance paths are inferred from file/name; true KiCad UUID-based
 *     instance paths are not parsed from sheet_instances.
 */

import { Vec2 } from '../math/Vec2';
import { NETLIST, NETLIST_COMPONENT, NETLIST_PIN, buildNetlist } from './netlist';
import { WIRE, expandBusLabel, isBusLabel } from './SchematicNetlist';
import { PIN_TYPE, pinDriverPriority } from '../geometry/PinInfo';
import { symbolReference, symbolValue, symbolFootprint, symbolDatasheet } from './SymbolElement';
import { KicadSchematic } from '@kicad-io/Project/KicadSchematic';
import { KicadElementSymbol } from '@kicad-io/KicadElementSymbol';
import { KicadElementPin } from '@kicad-io/KicadElementPin';
import { KicadElementSheet } from '@kicad-io/KicadElementSheet';
import { KicadElementLibSymbols } from '@kicad-io/KicadElementLibSymbols';

/** One placed sheet instance in the project hierarchy. */
export interface SHEET_INSTANCE {
	/** Human-readable instance id, e.g. "/" or "/Channel1/". */
	id: string;
	/** File path of the .kicad_sch file. */
	path: string;
	/** Parsed root element of this sheet. */
	rootElement: any;
	/** Library symbols block for this sheet. */
	libSymbols: KicadElementLibSymbols | null;
	/** Parent instance (null for the root sheet). */
	parent: SHEET_INSTANCE | null;
	/** Direct child sheet instances. */
	children: SHEET_INSTANCE[];
}

/** A node in a connection subgraph: pin, label, flag, sheet pin or hierarchical label. */
export interface CONNECTION_NODE {
	/** Unique within the whole project. */
	id: string;
	sheetId: string;
	kind: 'pin' | 'label' | 'global' | 'flag' | 'sheetpin' | 'hierlabel';
	/** Net / pin / label name. */
	name: string;
	/** World position in mm. */
	position: Vec2;
	/** For schematic symbol pins. */
	pinType?: PIN_TYPE;
	/** For component pins. */
	reference?: string;
	/** For component pins. */
	pinNumber?: string;
}

/** A connection subgraph: one electrically-connected cluster within a sheet instance. */
export class CONNECTION_SUBGRAPH {
	/** Unique subgraph code, assigned after merging across sheets. */
	code = 0;
	nodes: CONNECTION_NODE[] = [];
	/** The sheet instance this subgraph was originally discovered in. */
	sheetId = '';

	/** Best driver-typed node in this subgraph, if any. */
	findDriver(): CONNECTION_NODE | null {
		let best: CONNECTION_NODE | null = null;
		let bestRank = -1;
		for (const n of this.nodes) {
			if (n.kind === 'flag') {
				// Power flags are POWER_OUT drivers.
				if (pinDriverPriority(PIN_TYPE.POWER_OUT) > bestRank) {
					best = n;
					bestRank = pinDriverPriority(PIN_TYPE.POWER_OUT);
				}
			} else if (n.pinType !== undefined) {
				const rank = pinDriverPriority(n.pinType);
				if (rank > bestRank) {
					best = n;
					bestRank = rank;
				}
			}
		}
		return best && bestRank > 0 ? best : null;
	}

	/** All labels / global labels / hierarchical labels / sheet pins in this subgraph. */
	names(): string[] {
		return this.nodes
			.filter(n => n.kind === 'label' || n.kind === 'global' || n.kind === 'hierlabel' || n.kind === 'sheetpin')
			.map(n => n.name);
	}

	/** The first name-carrying node in this subgraph, preferring global
	 *  labels / sheet pins over plain local labels. */
	firstNameNode(): CONNECTION_NODE | null {
		let first: CONNECTION_NODE | null = null;
		for (const n of this.nodes) {
			if (n.kind === 'global' || n.kind === 'sheetpin' || n.kind === 'hierlabel') {
				return n;
			}
			if (!first && (n.kind === 'label')) {
				first = n;
			}
		}
		return first;
	}

	/** All power flags in this subgraph. */
	flags(): CONNECTION_NODE[] {
		return this.nodes.filter(n => n.kind === 'flag');
	}
}

/** Options for project netlist extraction. */
export interface PROJECT_NETLIST_OPTIONS {
	/** Prefix generated net names with the sheet instance path. */
	prefixInstancePath?: boolean;
}

/**
 * Builds a project-wide NETLIST from a loaded KicadSchematic (root + all child
 * sheets). Hierarchical sheet pins are coupled to child hierarchical labels,
 * global labels are coupled across all instances, and each net receives a
 * stable subgraph code.
 */
export function buildProjectNetlist(
	aSchematic: KicadSchematic,
	aOptions: PROJECT_NETLIST_OPTIONS = {}
): NETLIST {
	const instances = collectSheetInstances(aSchematic, null, '/');
	const subgraphs = buildConnectionGraph(instances);
	const nameByCode = resolveSubgraphNames(subgraphs);

	const allComponents: NETLIST_COMPONENT[] = [];
	const codeByNetName = new Map<string, number>();
	for (const inst of instances) {
		const comps = extractComponents(inst);
		for (const comp of comps) {
			const pins: NETLIST_PIN[] = comp.pins.map(p => {
				const code = findPinSubgraphCode(subgraphs, inst.id, comp.reference, p.number);
				const resolved = code !== null ? nameByCode.get(code) : undefined;
				const baseName = resolved?.name ?? '';
				const net = formatNetName(baseName, inst.id, resolved?.isGlobal ?? false, aOptions.prefixInstancePath ?? true);
				if (code !== null && net) {
					codeByNetName.set(net, code);
				}
				return { number: p.number, net, type: p.type };
			});
			allComponents.push({
				reference: comp.reference,
				value: comp.value,
				footprint: comp.footprint,
				datasheet: comp.datasheet,
				pins,
			});
		}
	}

	const nl = buildNetlist(allComponents);
	for (const net of nl.nets) {
		net.code = codeByNetName.get(net.name);
	}
	return nl;
}

/**
 * Project-level convenience: builds the connection graph for a full
 * KicadSchematic project tree (root + all child sheets). Equivalent to
 * collectSheetInstances + buildConnectionGraph in one call.
 */
export function buildProjectConnectionGraph(aSchematic: KicadSchematic): CONNECTION_SUBGRAPH[] {
	const instances = collectSheetInstances(aSchematic, null, '/');
	return buildConnectionGraph(instances);
}

/**
 * Recursively collects all sheet instances from a loaded KicadSchematic tree.
 */
export function collectSheetInstances(
	aSchematic: KicadSchematic,
	aParent: SHEET_INSTANCE | null,
	aPathPrefix: string
): SHEET_INSTANCE[] {
	const inst: SHEET_INSTANCE = {
		id: aPathPrefix,
		path: aSchematic.path ?? '',
		rootElement: aSchematic.rootElement,
		libSymbols: findLibSymbols(aSchematic.rootElement),
		parent: aParent,
		children: [],
	};
	const out: SHEET_INSTANCE[] = [inst];

	const sheetElements = aSchematic.rootElement?.findChildrenByClass(KicadElementSheet) ?? [];
	for (let i = 0; i < sheetElements.length; i++) {
		const sheetEl = sheetElements[i];
		const child = aSchematic.sheets[i];
		if (!child || !(sheetEl instanceof KicadElementSheet)) continue;
		const name = sheetNameOf(sheetEl);
		const childPrefix = aPathPrefix + name + '/';
		const childInsts = collectSheetInstances(child, inst, childPrefix);
		inst.children.push(childInsts[0]!);
		out.push(...childInsts);
	}
	return out;
}

/**
 * Builds project-wide connection subgraphs. Each subgraph is initially a local
 * cluster inside one sheet instance; cross-sheet edges (global labels and
 * hierarchy) merge them and assign a shared code.
 */
export function buildConnectionGraph(aInstances: SHEET_INSTANCE[]): CONNECTION_SUBGRAPH[] {
	const allSubgraphs: CONNECTION_SUBGRAPH[] = [];
	const byInstance = new Map<string, CONNECTION_SUBGRAPH[]>();

	for (const inst of aInstances) {
		const local = buildLocalSubgraphs(inst);
		byInstance.set(inst.id, local);
		allSubgraphs.push(...local);
	}

	// Global label coupling: same label name across any instances -> same code.
	const globals = new Map<string, CONNECTION_SUBGRAPH[]>();
	for (const sg of allSubgraphs) {
		for (const n of sg.nodes) {
			if (n.kind === 'global') {
				if (!globals.has(n.name)) globals.set(n.name, []);
				globals.get(n.name)!.push(sg);
			}
		}
	}

	// Hierarchical coupling: parent sheet pin <-> child hierarchical label.
	const couplingEdges: Array<[CONNECTION_SUBGRAPH, CONNECTION_SUBGRAPH]> = [];
	for (const inst of aInstances) {
		for (const child of inst.children) {
			const parentSgs = byInstance.get(inst.id) ?? [];
			const childSgs = byInstance.get(child.id) ?? [];
			couplingEdges.push(...coupleParentToChild(parentSgs, childSgs));
		}
	}

	// Union-find over subgraphs.
	const parent = new Map<CONNECTION_SUBGRAPH, CONNECTION_SUBGRAPH>();
	const find = (sg: CONNECTION_SUBGRAPH): CONNECTION_SUBGRAPH => {
		let root = sg;
		while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
		// path compress
		let cur = sg;
		while (parent.has(cur) && parent.get(cur) !== root) {
			const next = parent.get(cur)!;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	const union = (a: CONNECTION_SUBGRAPH, b: CONNECTION_SUBGRAPH): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};

	for (const sg of allSubgraphs) parent.set(sg, sg);
	for (const group of globals.values()) {
		for (let i = 1; i < group.length; i++) {
			union(group[0]!, group[i]!);
		}
	}
	for (const [a, b] of couplingEdges) {
		union(a, b);
	}

	// Merge subgraphs by root.
	const groups = new Map<CONNECTION_SUBGRAPH, CONNECTION_SUBGRAPH[]>();
	for (const sg of allSubgraphs) {
		const root = find(sg);
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root)!.push(sg);
	}

	let nextCode = 1;
	const merged: CONNECTION_SUBGRAPH[] = [];
	for (const group of groups.values()) {
		const combined = new CONNECTION_SUBGRAPH();
		combined.code = nextCode++;
		combined.sheetId = group[0]!.sheetId;
		for (const sg of group) {
			combined.nodes.push(...sg.nodes);
		}
		merged.push(combined);
	}
	return merged;
}

/** Metadata for a resolved subgraph name. */
export interface SUBGRAPH_NAME {
	name: string;
	/** True when the name comes from a power flag or global label and should
	 *  not be prefixed with a sheet instance path. */
	isGlobal: boolean;
}

/**
 * Resolves final net names for merged subgraphs. Power flags and global labels
 * win; otherwise the highest-priority driver pin wins; otherwise the first
 * label wins; otherwise a generated name based on the code.
 */
export function resolveSubgraphNames(aSubgraphs: CONNECTION_SUBGRAPH[]): Map<number, SUBGRAPH_NAME> {
	const result = new Map<number, SUBGRAPH_NAME>();
	for (const sg of aSubgraphs) {
		const flags = sg.flags();
		if (flags.length > 0) {
			result.set(sg.code, { name: flags[0]!.name, isGlobal: true });
			continue;
		}
		const driver = sg.findDriver();
		if (driver) {
			const label = sg.firstNameNode();
			result.set(sg.code, {
				name: label?.name ?? `Net-${sg.code}`,
				isGlobal: label?.kind === 'global',
			});
			continue;
		}
		const label = sg.firstNameNode();
		if (label) {
			result.set(sg.code, { name: label.name, isGlobal: label.kind === 'global' });
			continue;
		}
		result.set(sg.code, { name: `Net-${sg.code}`, isGlobal: false });
	}
	return result;
}

/**
 * Resolves the net class for each merged subgraph (by code). Power flags and
 * global labels declare a net class (defaulting to "Default"); otherwise the
 * net is in the default net class. Mirrors KiCad's netclass-on-power/label.
 */
export function resolveSubgraphNetClasses(aSubgraphs: CONNECTION_SUBGRAPH[]): Map<number, string> {
	const result = new Map<number, string>();
	for (const sg of aSubgraphs) {
		const flags = sg.flags();
		if (flags.length > 0) {
			result.set(sg.code, powerFlagNetClass(flags[0]!.name));
			continue;
		}
		const first = sg.firstNameNode();
		if (first && (first.kind === 'global' || first.kind === 'sheetpin')) {
			result.set(sg.code, labelNetClass(first.name));
			continue;
		}
		result.set(sg.code, 'Default');
	}
	return result;
}

/** The net class a power flag's net belongs to (best-effort: "Default"). */
function powerFlagNetClass(aName: string): string {
	const upper = aName.toUpperCase();
	if (upper === 'GND' || upper === 'VCC' || upper === 'VDD' || upper === 'VSS' || upper === 'VEE') {
		return 'Default';
	}
	return 'Default';
}

/** The net class for a label net (best-effort: "Default"). */
function labelNetClass(_aName: string): string {
	return 'Default';
}

/** Builds local connection subgraphs inside a single sheet instance. */
function buildLocalSubgraphs(aInst: SHEET_INSTANCE): CONNECTION_SUBGRAPH[] {
	const items = extractConnectionItems(aInst);
	const wires = extractWires(aInst.rootElement);

	// First union wires by geometric connection (shared endpoints / T-junctions).
	const wireParent = new Map<string, string>();
	const wireFind = (id: string): string => {
		let root = id;
		while (wireParent.has(root) && wireParent.get(root) !== root) root = wireParent.get(root)!;
		let cur = id;
		while (wireParent.has(cur) && wireParent.get(cur) !== root) {
			const next = wireParent.get(cur)!;
			wireParent.set(cur, root);
			cur = next;
		}
		return root;
	};
	const wireUnion = (a: string, b: string): void => {
		const ra = wireFind(a);
		const rb = wireFind(b);
		if (ra !== rb) wireParent.set(ra, rb);
	};

	for (const w of wires) {
		if (!wireParent.has(w.id)) wireParent.set(w.id, w.id);
	}
	for (let i = 0; i < wires.length; i++) {
		const a = wires[i]!;
		for (let j = i + 1; j < wires.length; j++) {
			const b = wires[j]!;
			if (
				pointEquals(a.start, b.start) || pointEquals(a.start, b.end) ||
				pointEquals(a.end, b.start) || pointEquals(a.end, b.end) ||
				onSegment(a.start, b.start, b.end) || onSegment(a.end, b.start, b.end) ||
				onSegment(b.start, a.start, a.end) || onSegment(b.end, a.start, a.end)
			) {
				wireUnion(a.id, b.id);
			}
		}
	}

	// Each node starts as its own set.
	const parent = new Map<CONNECTION_NODE, CONNECTION_NODE>();
	const find = (n: CONNECTION_NODE): CONNECTION_NODE => {
		let root = n;
		while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
		let cur = n;
		while (parent.has(cur) && parent.get(cur) !== root) {
			const next = parent.get(cur)!;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	const union = (a: CONNECTION_NODE, b: CONNECTION_NODE): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};

	for (const n of items) parent.set(n, n);

	// Connect nodes that share a wire group.
	const nodesByWireRoot = new Map<string, CONNECTION_NODE[]>();
	for (const n of items) {
		for (const w of wires) {
			if (onSegment(n.position, w.start, w.end)) {
				const root = wireFind(w.id);
				if (!nodesByWireRoot.has(root)) nodesByWireRoot.set(root, []);
				nodesByWireRoot.get(root)!.push(n);
				break;
			}
		}
	}
	for (const group of nodesByWireRoot.values()) {
		for (let i = 1; i < group.length; i++) {
			union(group[0]!, group[i]!);
		}
	}

	// Merge by root.
	const groups = new Map<CONNECTION_NODE, CONNECTION_NODE[]>();
	for (const n of items) {
		const root = find(n);
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root)!.push(n);
	}

	const out: CONNECTION_SUBGRAPH[] = [];
	for (const group of groups.values()) {
		const sg = new CONNECTION_SUBGRAPH();
		sg.sheetId = aInst.id;
		sg.nodes = group;
		out.push(sg);
	}
	return out;
}

function pointEquals(a: Vec2, b: Vec2): boolean {
	return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

/** Extracts all connection-relevant nodes from a sheet instance. */
function extractConnectionItems(aInst: SHEET_INSTANCE): CONNECTION_NODE[] {
	const out: CONNECTION_NODE[] = [];
	let nextId = 0;
	const add = (kind: CONNECTION_NODE['kind'], name: string, position: Vec2, extras: Partial<CONNECTION_NODE> = {}) => {
		out.push({ id: `${aInst.id}:${nextId++}`, sheetId: aInst.id, kind, name, position, ...extras });
	};

	const children = aInst.rootElement?.children ?? [];
	for (const c of children) {
		if (c.name === 'symbol' && c instanceof KicadElementSymbol) {
			const ref = symbolReference(c);
			const defs = resolveSymbolDef(c, aInst.libSymbols);
			const origin = c.getOrigin?.() ?? { x: 0, y: 0, rotation: 0 };
			const mirror = typeof c.getMirror === 'function' ? c.getMirror() : null;
			const seen = new Set<string>();
			for (const def of defs) {
				if (!(def instanceof KicadElementSymbol)) continue;
				for (const pin of collectPinsFromSymbol(def)) {
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
					add('pin', number, world, {
						pinType: electricalTypeToPinType(et),
						reference: ref,
						pinNumber: number,
					});
				}
			}
		} else if (c.name === 'label') {
			const name = c.getName?.() ?? c.text ?? c.getText?.() ?? '';
			const pos = c.getOrigin?.() ?? { x: 0, y: 0 };
			if (name) add('label', name, new Vec2(pos.x, pos.y));
		} else if (c.name === 'global_label') {
			const name = c.getName?.() ?? c.text ?? c.getText?.() ?? '';
			const pos = c.getOrigin?.() ?? { x: 0, y: 0 };
			if (name) add('global', name, new Vec2(pos.x, pos.y));
		} else if (c.name === 'hierarchical_label') {
			const name = c.getName?.() ?? c.text ?? c.getText?.() ?? '';
			const pos = c.getOrigin?.() ?? { x: 0, y: 0 };
			if (name) add('hierlabel', name, new Vec2(pos.x, pos.y));
		} else if (c.name === 'sheet' && c instanceof KicadElementSheet) {
			for (const pin of c.findChildrenByClass(KicadElementPin)) {
				const name = pin.getPin().name;
				const pos = pin.getOrigin();
				add('sheetpin', name, new Vec2(pos.x, pos.y));
			}
		}
	}

	// Power symbols generate flags at their pin position.
	for (const c of children) {
		if (c.name === 'symbol' && isPowerSymbol(c)) {
			const defs = resolveSymbolDef(c, aInst.libSymbols);
			const origin = c.getOrigin?.() ?? { x: 0, y: 0, rotation: 0 };
			const mirror = typeof c.getMirror === 'function' ? c.getMirror() : null;
			for (const def of defs) {
				if (!(def instanceof KicadElementSymbol)) continue;
				const pins = collectPinsFromSymbol(def);
				const first = pins[0];
				if (!first) continue;
				const pos = first.getOrigin();
				const world = transformLocalToWorld(
					new Vec2(pos.x, pos.y),
					new Vec2(origin.x, origin.y),
					origin.rotation ?? 0,
					mirror
				);
				const value = symbolValue(c);
				add('flag', String(value), world);
				break;
			}
		}
	}

	return out;
}

/** Extracts wires from a root element. */
function extractWires(rootElement: any): WIRE[] {
	const out: WIRE[] = [];
	let idx = 0;
	for (const c of rootElement?.children ?? []) {
		if (c?.name === 'wire' || c?.name === 'bus') {
			const pts = c.getPts?.() ?? c.pts ?? [];
			for (let i = 0; i < pts.length - 1; i++) {
				out.push({
					id: `w${idx++}_${i}`,
					start: new Vec2(pts[i]!.x, pts[i]!.y),
					end: new Vec2(pts[i + 1]!.x, pts[i + 1]!.y),
				});
			}
		}
	}
	return out;
}

/** Extracts components for the final netlist output. */
function extractComponents(aInst: SHEET_INSTANCE): Array<Omit<NETLIST_COMPONENT, 'pins'> & { pins: Array<{ number: string; type?: string }> }> {
	const out: Array<Omit<NETLIST_COMPONENT, 'pins'> & { pins: Array<{ number: string; type?: string }> }> = [];
	for (const c of aInst.rootElement?.children ?? []) {
		if (c.name !== 'symbol' || !(c instanceof KicadElementSymbol)) continue;
		const reference = symbolReference(c);
		const value = symbolValue(c);
		const footprint = symbolFootprint(c);
		const datasheet = symbolDatasheet(c);
		const pins: Array<{ number: string; type?: string }> = [];
		const defs = resolveSymbolDef(c, aInst.libSymbols);
		const seen = new Set<string>();
		for (const def of defs) {
			if (!(def instanceof KicadElementSymbol)) continue;
			for (const pin of collectPinsFromSymbol(def)) {
				const { number } = pin.getPin();
				if (seen.has(number)) continue;
				seen.add(number);
				pins.push({ number, type: pin.getType().electricalType });
			}
		}
		out.push({ reference, value, footprint, datasheet, pins });
	}
	return out;
}

/** Couples parent sheet pins to child hierarchical labels (and bus members). */
function coupleParentToChild(
	aParentSgs: CONNECTION_SUBGRAPH[],
	aChildSgs: CONNECTION_SUBGRAPH[]
): Array<[CONNECTION_SUBGRAPH, CONNECTION_SUBGRAPH]> {
	const edges: Array<[CONNECTION_SUBGRAPH, CONNECTION_SUBGRAPH]> = [];

	// Build name -> subgraphs maps for both sides.
	const parentByName = new Map<string, CONNECTION_SUBGRAPH[]>();
	const childByName = new Map<string, CONNECTION_SUBGRAPH[]>();
	for (const sg of aParentSgs) {
		for (const n of sg.nodes) {
			if (n.kind === 'sheetpin') {
				if (!parentByName.has(n.name)) parentByName.set(n.name, []);
				parentByName.get(n.name)!.push(sg);
			}
		}
	}
	for (const sg of aChildSgs) {
		for (const n of sg.nodes) {
			if (n.kind === 'hierlabel') {
				if (!childByName.has(n.name)) childByName.set(n.name, []);
				childByName.get(n.name)!.push(sg);
			}
		}
	}

	for (const [name, pSgs] of parentByName) {
		// Bus label: expand and couple member by member.
		if (isBusLabel(name)) {
			const members = expandBusLabel(name);
			if (members && members.length > 0) {
				for (const member of members) {
					const cSgs = childByName.get(member);
					if (cSgs) {
						for (const p of pSgs) {
							for (const c of cSgs) {
								edges.push([p, c]);
							}
						}
					}
				}
			}
			continue;
		}

		const cSgs = childByName.get(name);
		if (!cSgs) continue;
		for (const p of pSgs) {
			for (const c of cSgs) {
				edges.push([p, c]);
			}
		}
	}
	return edges;
}

/** Finds the subgraph code for a given component pin. */
function findPinSubgraphCode(
	aSubgraphs: CONNECTION_SUBGRAPH[],
	aSheetId: string,
	aReference: string,
	aPinNumber: string
): number | null {
	for (const sg of aSubgraphs) {
		for (const n of sg.nodes) {
			if (
				n.sheetId === aSheetId &&
				n.kind === 'pin' &&
				n.reference === aReference &&
				n.pinNumber === aPinNumber
			) {
				return sg.code;
			}
		}
	}
	return null;
}

function formatNetName(aBaseName: string, aSheetId: string, aIsGlobal: boolean, aPrefix: boolean): string {
	if (!aBaseName) return '';
	if (!aPrefix || aIsGlobal) return aBaseName;
	const prefix = aSheetId.replace(/\//g, '_').replace(/^_+|_+$/g, '');
	if (!prefix) return aBaseName;
	return `${prefix}_${aBaseName}`;
}

function sheetNameOf(aSheet: KicadElementSheet): string {
	const props = aSheet.getProperties?.() ?? [];
	const nameProp = props.find((p: any) => p.propertyName === 'Sheetname');
	return nameProp?.propertyValue ?? 'sheet';
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
	return /^#PWR|^#FLG|^~$/.test(String(el.reference ?? '')) ||
		(el.power ?? false) === true;
}

function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
	const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
	if (Math.abs(cross) > 1e-6) return false;
	return (
		p.x >= Math.min(a.x, b.x) - 1e-6 &&
		p.x <= Math.max(a.x, b.x) + 1e-6 &&
		p.y >= Math.min(a.y, b.y) - 1e-6 &&
		p.y <= Math.max(a.y, b.y) + 1e-6
	);
}

