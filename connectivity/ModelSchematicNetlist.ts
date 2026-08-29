/*
 * Model → netlist bridge for eeschema.
 *
 * Like BoardConnectivity bridges the PCB model to the connectivity port, this
 * feeds the typed `kicad-model` Schematic (positions in IU/nm) into the
 * render's schematic netlist extractor (which operates in mm). Symbol pins are
 * transformed from symbol-local coordinates into world coordinates via the
 * placed symbol's rotation/mirror, mirroring SCH_SYMBOL's transform.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */
import type { Schematic } from '@kicad-model/src/schematic/Schematic';
import type { SchematicSymbol } from '@kicad-model/src/schematic/SchematicSymbol';
import type { SchLabelBase } from '@kicad-model/src/schematic/SchLabel';
import { SCH_SYMBOL_T, SCH_LINE_T, SCH_LABEL_T, SCH_GLOBAL_LABEL_T, SCH_HIER_LABEL_T } from '@kicad-model/src/core/types';
import { ElectricalPinType } from '@kicad-model/src/schematic/types';
import { Vec2 } from '../math/Vec2';
import { NETLIST } from './netlist';
import { WIRE, NET_LABEL, POWER_FLAG } from './SchematicNetlist';
import { SCH_COMPONENT, SCH_PIN, buildSchematicNetlist } from './SchematicExtractor';
import { PIN_TYPE } from '../geometry/PinInfo';
import { iuToMM, schIuScale } from '@kicad-model/src/core/IuScale';

const MM = (iu: number) => iuToMM(schIuScale, iu);

/**
 * Build a netlist from a typed Schematic. Pins are resolved to world
 * coordinates by applying the placed symbol's transform to each library pin.
 * Power symbols (#PWR/#FLG/~) contribute a POWER_FLAG at their first pin.
 */
export function buildSchematicNetlistFromModel(sch: Schematic): NETLIST {
	const comps: SCH_COMPONENT[] = [];
	const wires: WIRE[] = [];
	const labels: NET_LABEL[] = [];
	const flags: POWER_FLAG[] = [];

	let wireIdx = 0;
	for (const screen of sch.allScreens()) {
		for (const item of screen.items) {
			if (item.type === SCH_LINE_T) {
				const w = item as unknown as { points: { x: number; y: number }[]; start: { x: number; y: number }; end: { x: number; y: number } };
				const pts = w.points && w.points.length ? w.points : [w.start, w.end];
				for (let i = 0; i < pts.length - 1; i++) {
					wires.push({
						id: `w${ wireIdx++ }`,
						start: new Vec2(MM(pts[i]!.x), MM(pts[i]!.y)),
						end: new Vec2(MM(pts[i + 1]!.x), MM(pts[i + 1]!.y)),
					});
				}
			} else if (item.type === SCH_SYMBOL_T) {
				const sym = item as SchematicSymbol;
				const comp = componentFromSymbol(sym);
				comps.push(comp);
				if (isPowerSymbol(sym)) {
					const first = comp.pins[0];
					if (first) flags.push({ name: sym.getValue() || sym.getReference(), point: first.position });
				}
			} else if (item.type === SCH_LABEL_T || item.type === SCH_GLOBAL_LABEL_T || item.type === SCH_HIER_LABEL_T) {
				const lb = item as unknown as SchLabelBase;
				const t = lb.getText();
				if (t) {
					const pos = lb.getPosition();
					labels.push({ name: t, point: new Vec2(MM(pos.x), MM(pos.y)) });
				}
			}
		}
	}

	return buildSchematicNetlist(comps, wires, labels, flags);
}

function isPowerSymbol(sym: SchematicSymbol): boolean {
	const ref = sym.getReference();
	return /^#PWR|^#FLG|^~$/.test(ref) || (sym.libSymbol?.isPower === true);
}

/** Map a placed symbol to a render SCH_COMPONENT, transforming pin positions. */
function componentFromSymbol(sym: SchematicSymbol): SCH_COMPONENT {
	const reference = sym.getReference();
	const value = sym.getValue();
	const footprint = sym.getField(2)?.getText() ?? '';
	const datasheet = sym.getField(3)?.getText() ?? '';
	const pins: SCH_PIN[] = [];

	for (const pin of sym.pins) {
		const et = electricalTypeToPinType(pin.electricalType);
		const pos = pinWorldPosition(sym, pin);
		pins.push({ number: pin.number, position: pos, type: et });
	}

	return { reference, value, footprint, datasheet, pins };
}

/** Transform a symbol-local pin position into world coordinates (mirror then
 *  rotate about the instance origin, matching KiCad's SCH_SYMBOL transform). */
function pinWorldPosition(sym: SchematicSymbol, pin: { getPosition(): { x: number; y: number } }): Vec2 {
	const pinPos = pin.getPosition();
	let x = MM(pinPos.x);
	let y = MM(pinPos.y);
	if (sym.transform.mirrorX) x = -x;
	const a = sym.transform.a, b = sym.transform.b, c = sym.transform.c, d = sym.transform.d;
	const rx = x * a + y * c;
	const ry = x * b + y * d;
	const symbolPos = sym.getPosition();
	return new Vec2(MM(symbolPos.x) + rx, MM(symbolPos.y) + ry);
}

/** ElectricalPinType -> render PIN_TYPE (mirror of the extractor's name map). */
function electricalTypeToPinType(t: ElectricalPinType): PIN_TYPE {
	switch (t) {
		case ElectricalPinType.PT_INPUT: return PIN_TYPE.INPUT;
		case ElectricalPinType.PT_OUTPUT: return PIN_TYPE.OUTPUT;
		case ElectricalPinType.PT_BIDI: return PIN_TYPE.BIDIRECTIONAL;
		case ElectricalPinType.PT_TRISTATE: return PIN_TYPE.TRI_STATE;
		case ElectricalPinType.PT_PASSIVE: return PIN_TYPE.PASSIVE;
		case ElectricalPinType.PT_NIC: return PIN_TYPE.FREE;
		case ElectricalPinType.PT_UNSPECIFIED: return PIN_TYPE.UNSPECIFIED;
		case ElectricalPinType.PT_POWER_IN: return PIN_TYPE.POWER_IN;
		case ElectricalPinType.PT_POWER_OUT: return PIN_TYPE.POWER_OUT;
		case ElectricalPinType.PT_OPENCOLLECTOR: return PIN_TYPE.OPEN_COLLECTOR;
		case ElectricalPinType.PT_OPENEMITTER: return PIN_TYPE.OPEN_EMITTER;
		case ElectricalPinType.PT_NC: return PIN_TYPE.NOCONNECT;
		default: return PIN_TYPE.UNSPECIFIED;
	}
}
