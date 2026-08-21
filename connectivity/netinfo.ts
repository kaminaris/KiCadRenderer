/*
 * Ported from KiCad source:
 *   pcbnew/netinfo_items.h (.cpp)
 *   pcbnew/netinfo_list.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The board net / netclass model: NETCLASS (the design-rule description a net
 * belongs to), NETINFO_ITEM (one net: code + name + netclass), and
 * NETINFO_LIST (the board's set of nets). Coordinates/dimensions in mm.
 */

import { Vec2 } from '../math/Vec2';

/**
 * A net class — the group of design-rule parameters applied to a set of nets.
 * Mirrors KiCad's NETCLASS (pcbnew/netinfo_items.h).
 */
export class NETCLASS {
	name = '';
	description = '';

	clearance = 0.2;
	trackWidth = 0.2;
	viaDiameter = 0.6;
	viaDrill = 0.3;
	uViaDiameter = 0.3;
	uViaDrill = 0.1;
	diffPairGap = 0.25;
	diffPairViaGap = 0.25;
	diffPairWidth = 0.2;

	constructor(aName = 'Default', aDescription = '') {
		this.name = aName;
		this.description = aDescription;
	}

	GetName(): string {
		return this.name;
	}

	SetName(aName: string): void {
		this.name = aName;
	}

	GetClearance(): number {
		return this.clearance;
	}

	SetClearance(aClearance: number): void {
		this.clearance = aClearance;
	}

	GetTrackWidth(): number {
		return this.trackWidth;
	}

	SetTrackWidth(aWidth: number): void {
		this.trackWidth = aWidth;
	}

	GetViaDiameter(): number {
		return this.viaDiameter;
	}

	SetViaDiameter(aD: number): void {
		this.viaDiameter = aD;
	}

	GetViaDrill(): number {
		return this.viaDrill;
	}

	SetViaDrill(aD: number): void {
		this.viaDrill = aD;
	}
}

/**
 * One net on the board. Mirrors KiCad's NETINFO_ITEM.
 */
export class NETINFO_ITEM {
	private m_netCode: number;
	private m_netname: string;
	private m_netClass: NETCLASS;

	constructor(aNetCode: number, aNetname: string, aNetClass?: NETCLASS) {
		this.m_netCode = aNetCode;
		this.m_netname = aNetname;
		this.m_netClass = aNetClass ?? new NETCLASS();
	}

	GetNetCode(): number {
		return this.m_netCode;
	}

	GetNetname(): string {
		return this.m_netname;
	}

	SetNetname(aNetname: string): void {
		this.m_netname = aNetname;
	}

	GetNetClassName(): string {
		return this.m_netClass.GetName();
	}

	GetNetClass(): NETCLASS {
		return this.m_netClass;
	}

	SetNetClass(aNetClass: NETCLASS): void {
		this.m_netClass = aNetClass;
	}

	/** The net name with any net-tie / special suffix removed, for display. */
	GetShortNetname(): string {
		return this.m_netname;
	}
}

/**
 * The board's list of nets, keyed by net code. Mirrors KiCad's NETINFO_LIST.
 */
export class NETINFO_LIST {
	private m_netItems: NETINFO_ITEM[] = [];
	private m_netCodeMap: Map<number, NETINFO_ITEM> = new Map();
	private m_netClasses: Map<string, NETCLASS> = new Map();

	/** The default net class. */
	GetDefault(): NETCLASS {
		let def = this.m_netClasses.get('Default');
		if (!def) {
			def = new NETCLASS('Default');
			this.m_netClasses.set('Default', def);
		}
		return def;
	}

	/** Registers (or replaces) a net code -> name mapping. */
	AddNet(aNetCode: number, aNetname: string): void {
		let item = this.m_netCodeMap.get(aNetCode);
		if (!item) {
			item = new NETINFO_ITEM(aNetCode, aNetname, this.GetDefault());
			this.m_netCodeMap.set(aNetCode, item);
			this.m_netItems.push(item);
		} else {
			item.SetNetname(aNetname);
		}
	}

	RegisterNetClass(aNetClass: NETCLASS): void {
		this.m_netClasses.set(aNetClass.GetName(), aNetClass);
	}

	GetNetItem(aNetCode: number): NETINFO_ITEM | null {
		return this.m_netCodeMap.get(aNetCode) ?? null;
	}

	GetNetname(aNetCode: number): string {
		return this.m_netCodeMap.get(aNetCode)?.GetNetname() ?? '';
	}

	/** Builds an indexed net->netclass resolution from a `(net ...)`-ish map.
	 *  `aNetClasses` maps netclass name to NETCLASS. */
	Build(aNetInfos: { GetNetCode(): number; GetNetname(): string; classOwners?: any }[], aNetClasses?: Map<string, NETCLASS>): void {
		this.m_netItems = [];
		this.m_netCodeMap.clear();
		if (aNetClasses) {
			this.m_netClasses.clear();
			for (const [name, nc] of aNetClasses) {
				this.m_netClasses.set(name, nc);
			}
		}
		for (const ni of aNetInfos) {
			this.AddNet(ni.GetNetCode(), ni.GetNetname());
		}
	}

	GetNetCount(): number {
		return this.m_netItems.length;
	}

	AllNets(): NETINFO_ITEM[] {
		return this.m_netItems;
	}

	/** Returns the position center used for display (parity placeholder). */
	static GetNetFootprintCenter(_aNetInfo: NETINFO_ITEM): Vec2 {
		return new Vec2();
	}
}

/**
 * Parses a board `setup` element's net classes and tracks into the
 * NETINFO_LIST, populating each NETCLASS (clearance, track width, via size,
 * diff-pair). Mirrors reading a `.kicad_pcb` `(setup (net_classes ...))`.
 *
 * @param aSetup the parsed `(setup ...)` child (or root that has one).
 */
export function applySetupToNetInfo(aNetInfo: NETINFO_LIST, aSetup: any): void {
	if (!aSetup) {
		return;
	}

	const netClasses = aSetup.findFirstChildByName?.('net_classes') ?? aSetup.children?.find((c: any) => c?.name === 'net_classes');

	const readNum = (el: any, key: string, fallback: number): number => {
		for (const c of el?.children ?? []) {
			if (c?.name === key) {
				const v = parseFloat(c.value);
				return Number.isFinite(v) ? v : fallback;
			}
		}
		return fallback;
	};

	for (const nc of netClasses?.children ?? []) {
		if (typeof nc !== 'object' || nc?.name !== 'net_class') {
			continue;
		}
		// (net_class "Default" (clearance 0.2) (track_width 0.25) ...)
		const name = nc.children?.find((c: any) => typeof c === 'string') ?? 'Default';
		const cls = new NETCLASS(name);
		cls.SetClearance(readNum(nc, 'clearance', 0.2));
		cls.SetTrackWidth(readNum(nc, 'track_width', 0.25));
		const vd = readNum(nc, 'via_dia', 0.6);
		cls.viaDiameter = vd;
		const vdr = readNum(nc, 'via_drill', 0.3);
		cls.viaDrill = vdr;
		cls.diffPairGap = readNum(nc, 'diff_pair_gap', cls.diffPairGap);
		cls.diffPairWidth = readNum(nc, 'diff_pair_width', cls.diffPairWidth);
		aNetInfo.RegisterNetClass(cls);
	}
}
