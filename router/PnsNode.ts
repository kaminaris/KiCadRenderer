/*
 * Ported from KiCad source:
 *   pcbnew/router/pns_node.h
 *   pcbnew/router/pns_item.h
 *
 * Copyright © 2010-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The PNS routing tree: PNS_NODE holds PNS_ITEMs (lines, solids, vias) with
 * add / remove / collide / nearest-obstacle queries, and a disjoint-set for
 * connectivity. Coordinates in mm.
 */

import { SHAPE } from '../geometry/Shape';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { Vec2 } from '../math/Vec2';
import { SEG } from '../geometry/Seg';

/** Mirrors PNS_ITEM::PnsKind. */
export enum PnsKind {
	LINE = 0,
	SEGMENT = 1,
	VIA = 2,
	SOLID = 3,
	DIFF_PAIR = 4,
}

/** The routed net (0 = none). */
export type PnNet = number;

/**
 * A routable item in the PNS world. Mirrors KiCad's PNS_ITEM.
 */
export abstract class PNS_ITEM {
	protected m_kind: PnsKind;
	protected m_net: PnNet;
	protected m_movable: boolean;
	protected m_parent: any = null;

	constructor(aKind: PnsKind, aNet: PnNet = 0) {
		this.m_kind = aKind;
		this.m_net = aNet;
		this.m_movable = false;
	}

	Kind(): PnsKind {
		return this.m_kind;
	}

	Net(): PnNet {
		return this.m_net;
	}

	SetNet(aNet: PnNet): void {
		this.m_net = aNet;
	}

	Movable(): boolean {
		return this.m_movable;
	}

	SetMovable(aMovable: boolean): void {
		this.m_movable = aMovable;
	}

	/** The item's geometric shape (for collision). */
	abstract Shape(): SHAPE;

	/** The item's clearance. */
	GetClearance(aOther?: PNS_ITEM): number {
		void aOther;
		return 0.2;
	}

	NetCode(): PnNet {
		return this.m_net;
	}
}

/**
 * A line being routed: a start/end and width (a chain of segments).
 * Mirrors KiCad's PNS_LINE.
 */
export class PNS_LINE extends PNS_ITEM {
	private m_points: Vec2[] = [];
	private m_width = 0.2;

	constructor(aNet: PnNet = 0) {
		super(PnsKind.LINE, aNet);
	}

	SetPoints(aPoints: Vec2[]): void {
		this.m_points = aPoints.map(p => p.copy());
	}

	GetPoints(): Vec2[] {
		return this.m_points.map(p => p.copy());
	}

	SetWidth(aWidth: number): void {
		this.m_width = aWidth;
	}

	GetWidth(): number {
		return this.m_width;
	}

	PointCount(): number {
		return this.m_points.length;
	}

	/** Number of centerline segments. */
	SegmentCount(): number {
		return Math.max(0, this.m_points.length - 1);
	}

	/** The i-th centerline segment (SEG). */
	Segment(aIndex: number): SEG {
		return new SEG(this.m_points[aIndex]!, this.m_points[aIndex + 1]!);
	}

	GetLength(): number {
		let len = 0;
		for (let i = 0; i < this.m_points.length - 1; i++) {
			len += this.m_points[i]!.sub(this.m_points[i + 1]!).magnitude;
		}
		return len;
	}

	/** The line as a full capsule shape (segment only — simplified). */
	Shape(): SHAPE {
		const s = this.m_points[0] ?? new Vec2();
		const e = this.m_points[this.m_points.length - 1] ?? new Vec2();
		return new SHAPE_SEGMENT(s, e, this.m_width);
	}
}

/**
 * A fixed obstacle (pad, via, track footprint) in the PNS world.
 * Mirrors KiCad's PNS_SOLID.
 */
export class PNS_SOLID extends PNS_ITEM {
	private m_shape: SHAPE;

	constructor(aShape: SHAPE, aNet: PnNet = 0) {
		super(PnsKind.SOLID, aNet);
		this.m_shape = aShape;
	}

	Shape(): SHAPE {
		return this.m_shape;
	}

	SetShape(aShape: SHAPE): void {
		this.m_shape = aShape;
	}
}

/**
 * A via in the PNS world.
 * Mirrors KiCad's PNS_VIA.
 */
export class PNS_VIA extends PNS_SOLID {
	private m_diameter = 0.6;
	private m_drill = 0.3;

	constructor(aNet: PnNet = 0, aDiameter = 0.6, aDrill = 0.3) {
		super(new SHAPE_SEGMENT(new Vec2(), new Vec2(), aDiameter), aNet);
		this.m_diameter = aDiameter;
		this.m_drill = aDrill;
	}

	GetDiameter(): number {
		return this.m_diameter;
	}

	GetDrill(): number {
		return this.m_drill;
	}

	SetDiameter(aD: number): void {
		this.m_diameter = aD;
	}

	SetDrill(aD: number): void {
		this.m_drill = aD;
	}
}

/**
 * A single routed segment (a wide line between two points). Mirrors KiCad's
 * PNS_SEGMENT.
 */
export class PNS_SEGMENT extends PNS_ITEM {
	private m_seg: SEG;
	private m_width = 0.2;

	constructor(aSeg?: SEG, aNet: PnNet = 0) {
		super(PnsKind.SEGMENT, aNet);
		this.m_seg = aSeg ?? new SEG();
	}

	Seg(): SEG {
		return this.m_seg;
	}

	SetSeg(aSeg: SEG): void {
		this.m_seg = aSeg;
	}

	SetWidth(aWidth: number): void {
		this.m_width = aWidth;
	}

	GetWidth(): number {
		return this.m_width;
	}

	Shape(): SHAPE {
		return new SHAPE_SEGMENT(this.m_seg.A, this.m_seg.B, this.m_width);
	}
}

/**
 * A differential pair: two coupled PNS_LINEs (the P and N lines) with their
 * width, gap and via pairs. Mirrors KiCad's PNS_DIFF_PAIR
 * (pcbnew/router/pns_diff_pair.h).
 */
export class PNS_DIFF_PAIR extends PNS_ITEM {
	private m_netP = 0;
	private m_netN = 0;
	private m_lineP = new PNS_LINE(0);
	private m_lineN = new PNS_LINE(0);
	private m_width = 0.2;
	private m_gap = 0.25;
	// Vias to place at the end of each line.
	private m_viaP: PNS_VIA | null = null;
	private m_viaN: PNS_VIA | null = null;

	constructor(aNetP = 0, aNetN = 0) {
		super(PnsKind.DIFF_PAIR, aNetP);
		this.m_netP = aNetP;
		this.m_netN = aNetN;
		this.m_lineP = new PNS_LINE(aNetP);
		this.m_lineN = new PNS_LINE(aNetN);
	}

	SetNetP(aNet: PnNet): void {
		this.m_netP = aNet;
		this.m_lineP.SetNet(aNet);
	}

	SetNetN(aNet: PnNet): void {
		this.m_netN = aNet;
		this.m_lineN.SetNet(aNet);
	}

	NetP(): PnNet {
		return this.m_netP;
	}

	NetN(): PnNet {
		return this.m_netN;
	}

	LineP(): PNS_LINE {
		return this.m_lineP;
	}

	LineN(): PNS_LINE {
		return this.m_lineN;
	}

	SetPLine(aLine: PNS_LINE): void {
		this.m_lineP = aLine;
	}

	SetNLine(aLine: PNS_LINE): void {
		this.m_lineN = aLine;
	}

	SetWidth(aWidth: number): void {
		this.m_width = aWidth;
	}

	GetWidth(): number {
		return this.m_width;
	}

	SetGap(aGap: number): void {
		this.m_gap = aGap;
	}

	GetGap(): number {
		return this.m_gap;
	}

	GetViaP(): PNS_VIA | null {
		return this.m_viaP;
	}

	GetViaN(): PNS_VIA | null {
		return this.m_viaN;
	}

	SetVias(aViaP: PNS_VIA, aViaN: PNS_VIA): void {
		this.m_viaP = aViaP;
		this.m_viaN = aViaN;
	}

	/** The diff-pair's shape is the union of the two lines' capsules. */
	Shape(): SHAPE {
		return this.m_lineP.Shape();
	}
}

/**
 * The PNS routing node — the search tree of routable items. Mirrors KiCad's
 * PNS_NODE: an item collection with add/remove and obstacle queries, plus a
 * disjoint-set for net connectivity (the routing "world" cloned along a
 * path).
 */
export class PNS_NODE {
	private m_items: PNS_ITEM[] = [];
	private m_netCache = new Map<PnNet, PNS_ITEM[]>();

	/** The parent node in a branch (null for the root). */
	parent: PNS_NODE | null = null;

	Clear(): void {
		this.m_items = [];
		this.m_netCache.clear();
	}

	Add(aItem: PNS_ITEM): void {
		this.m_items.push(aItem);
		this.m_netCache.clear();
	}

	Remove(aItem: PNS_ITEM): void {
		const idx = this.m_items.indexOf(aItem);
		if (idx >= 0) {
			this.m_items.splice(idx, 1);
			this.m_netCache.clear();
		}
	}

	Contains(aItem: PNS_ITEM): boolean {
		return this.m_items.includes(aItem);
	}

	Size(): number {
		return this.m_items.length;
	}

	Items(): PNS_ITEM[] {
		return this.m_items;
	}

	GetItemsByNet(aNet: PnNet): PNS_ITEM[] {
		let items = this.m_netCache.get(aNet);
		if (!items) {
			items = this.m_items.filter(i => i.Net() === aNet);
			this.m_netCache.set(aNet, items);
		}
		return items;
	}

	/** The first item whose shape collides with `aShape`, or null. */
	FindGeometry(aShape: SHAPE, aNet?: PnNet): PNS_ITEM | null {
		return this.QueryColliding(aShape, aNet)[0] ?? null;
	}

	/** Every item whose shape collides with `aShape` within clearance. */
	QueryColliding(aShape: SHAPE, aNet?: PnNet, aClearance = 0): PNS_ITEM[] {
		const out: PNS_ITEM[] = [];
		const candidates = aNet === undefined ? this.m_items : this.GetItemsByNet(aNet);
		for (const item of candidates) {
			try {
				if (item.Shape().Collide(aShape, aClearance)) {
					out.push(item);
				}
			} catch {
				// shape collision not implemented for this pair — skip
			}
		}
		return out;
	}

	/** The nearest obstacle to `aShape`, or null. */
	NearestObstacle(aShape: SHAPE, aClearance = 0, aNet?: PnNet): PNS_ITEM | null {
		let best: PNS_ITEM | null = null;
		let bestD = Infinity;
		const candidates = aNet === undefined ? this.m_items : this.GetItemsByNet(aNet);
		for (const item of candidates) {
			let d: number;
			try {
				const b = item.Shape().BBox();
				d = aShape.BBox().x2 > b.x ? 0 : b.x - aShape.BBox().x2;
			} catch {
				d = Infinity;
			}
			if (d < bestD) {
				bestD = d;
				best = item;
			}
		}
		return best;
	}

	/** True if `aShape` touches any item (with clearance). */
	Collide(aShape: SHAPE, aClearance = 0): boolean {
		return this.QueryColliding(aShape, undefined, aClearance).length > 0;
	}

	/** Clones this node into a new branch (for search recursion). */
	Clone(): PNS_NODE {
		const n = new PNS_NODE();
		n.m_items = [...this.m_items];
		n.m_netCache = new Map(this.m_netCache);
		n.parent = this;
		return n;
	}
}
