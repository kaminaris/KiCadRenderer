/*
 * This file is ported from KiCad source files:
 *   pcbnew/connectivity/connectivity_items.h
 *   pcbnew/connectivity/connectivity_items.cpp
 *
 * Copyright (C) 2013-2018 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { DYNAMIC_RTREE } from './DynamicRtree';

export const INT_MAX = Number.MAX_SAFE_INTEGER;

/**
 * A set of copper layers, implemented as a bitset over the 32 copper layers
 * (F_Cu..B_Cu). Mirrors KiCad's LSet (pcbnew/lset.h), restricted to the
 * copper schema the connectivity port tracks. Layer bit i corresponds to
 * PCB_LAYER_ID i (F_Cu=0 ... B_Cu=31).
 */
export class LSET {
	private m_mask: bigint = 0n;

	constructor(masks?: bigint) {
		if (masks !== undefined) {
			this.m_mask = masks;
		}
	}

	/** All 32 copper layers. Mirrors LSET::AllCuMask(). */
	AllCuMask(): LSET {
		// Low 32 bits set.
		return new LSET((1n << 32n) - 1n);
	}

	/** Internal copper layers (In1..In30 = bits 1..30). */
	InternalCuMask(): LSET {
		return new LSET(((1n << 30n) - 1n) << 1n);
	}

	/** Outer copper layers (F_Cu + B_Cu = bits 0 and 31). */
	OuterCuMask(): LSET {
		return new LSET((1n << 0n) | (1n << 31n));
	}

	operatorAnd(other: LSET): LSET {
		return new LSET(this.m_mask & other.m_mask);
	}

	and(other: LSET): LSET {
		return this.operatorAnd(other);
	}

	operatorOr(other: LSET): LSET {
		return new LSET(this.m_mask | other.m_mask);
	}

	or(other: LSET): LSET {
		return this.operatorOr(other);
	}

	HasLayers(): boolean {
		return this.m_mask !== 0n;
	}

	/** True if the set contains the given layer. */
	Contains(aLayer: CN_LAYER): boolean {
		if (aLayer < 0 || aLayer >= COPPER_LAYER_COUNT) {
			return false;
		}
		return (this.m_mask & (1n << BigInt(aLayer))) !== 0n;
	}

	/** Removes the given layer from the set. */
	RmLayerSet(aLayer: CN_LAYER): void {
		if (aLayer >= 0 && aLayer < COPPER_LAYER_COUNT) {
			this.m_mask &= ~(1n << BigInt(aLayer));
		}
	}

	/** Sets the given layer in the set. */
	SetLayer(aLayer: CN_LAYER): void {
		if (aLayer >= 0 && aLayer < COPPER_LAYER_COUNT) {
			this.m_mask |= 1n << BigInt(aLayer);
		}
	}

	/** Runs `fn` for every layer present in the set, lowest first. */
	RunOnLayers(fn: (layer: number) => void): void {
		for (let i = 0; i < COPPER_LAYER_COUNT; i++) {
			if (this.m_mask & (1n << BigInt(i))) {
				fn(i);
			}
		}
	}

	/** The layers present in the set, ascending. Mirrors LSET::Seq(). */
	Seq(): number[] {
		const seq: number[] = [];
		this.RunOnLayers(layer => seq.push(layer));
		return seq;
	}

	/**
	 * Copper layers contained in this set, in KiCad's CuStack() order
	 * (internal layers In1..In30 first, then B_Cu, then F_Cu).
	 */
	CuStack(): number[] {
		const seq: number[] = [];

		for (let i = 1; i <= 30; i++) {
			if (this.m_mask & (1n << BigInt(i))) {
				seq.push(i);
			}
		}
		if (this.m_mask & (1n << BigInt(PCB_LAYER_ID.B_Cu))) {
			seq.push(PCB_LAYER_ID.B_Cu);
		}
		if (this.m_mask & (1n << BigInt(PCB_LAYER_ID.F_Cu))) {
			seq.push(PCB_LAYER_ID.F_Cu);
		}

		return seq;
	}

	ToBigInt(): bigint {
		return this.m_mask;
	}

	Clone(): LSET {
		return new LSET(this.m_mask);
	}

	IsEmpty(): boolean {
		return this.m_mask === 0n;
	}
}

export const KICAD_T = {
	NOT_USED: -1,
	TYPE_NOT_INIT: 0,
	PCB_T: 1,
	PCB_FOOTPRINT_T: 3,
	PCB_PAD_T: 4,
	PCB_SHAPE_T: 5,
	PCB_TRACE_T: 10,
	PCB_VIA_T: 11,
	PCB_ARC_T: 12,
	PCB_ZONE_T: 22,
	// Schematic item types (from kicad/include/types.h KICAD_T).
	SCH_ITEM_LOCATE_REFERENCE_T: 12,
	SCH_ITEM_LOCATE_VALUE_T: 13,
	SCH_SYMBOL_T: 16,
	SCH_PIN_T: 15,
	SCH_COMPONENT_T: 16,
	SCH_LINE_T: 20,
	SCH_RECTANGLE_T: 21,
	SCH_CIRCLE_T: 22,
	SCH_ARC_T: 23,
	SCH_BEZIER_T: 24,
	SCH_POLYLINE_T: 25,
	SCH_TEXT_T: 26,
	SCH_LABEL_T: 27,
	SCH_GLOBAL_LABEL_T: 28,
	SCH_HIER_LABEL_T: 29,
	SCH_SHEET_T: 32,
	SCH_SHEET_PIN_T: 33,
	SCH_JUNCTION_T: 34,
	SCH_NO_CONNECT_T: 35,
	SCH_CONNECTOR_T: 36,
	SCH_WIRE_T: 20,
	SCH_BUS_T: 40,
	SCH_BUS_WIRE_ENTRY_T: 41,
	SCH_BUS_BUS_ENTRY_T: 42,
	SCH_BITMAP_T: 43,
	SCH_SYMBOL_PIN_T: 44,
	SCH_SHEET_FIELD_T: 45,
	SCH_ITEM_LIST_T: 46,
	SCH_MARKER_T: 52,
} as const;

export type KICAD_T_VALUE = (typeof KICAD_T)[keyof typeof KICAD_T];

export const PAD_ATTRIB = {
	PTH: 0,
	SMD: 1,
	CONN: 2,
	NPTH: 3,
} as const;

export type PAD_ATTRIB_VALUE = (typeof PAD_ATTRIB)[keyof typeof PAD_ATTRIB];

/**
 * KiCad copper layer identifiers (pcbnew/layer_id.h). Copper layers are
 * contiguous: F_Cu=0 ... B_Cu=31, with internal layers In1..In30 in between.
 * (Technical layers — Edge_Cuts, silkscreen, etc. — are not represented here
 * because the connectivity port only tracks copper; see comments at the bit
 * helpers.)
 */
export const PCB_LAYER_ID = {
	F_Cu: 0,
	In1_Cu: 1,
	In2_Cu: 2,
	In3_Cu: 3,
	In4_Cu: 4,
	In5_Cu: 5,
	In6_Cu: 6,
	In7_Cu: 7,
	In8_Cu: 8,
	In9_Cu: 9,
	In10_Cu: 10,
	In11_Cu: 11,
	In12_Cu: 12,
	In13_Cu: 13,
	In14_Cu: 14,
	In15_Cu: 15,
	In16_Cu: 16,
	In17_Cu: 17,
	In18_Cu: 18,
	In19_Cu: 19,
	In20_Cu: 20,
	In21_Cu: 21,
	In22_Cu: 22,
	In23_Cu: 23,
	In24_Cu: 24,
	In25_Cu: 25,
	In26_Cu: 26,
	In27_Cu: 27,
	In28_Cu: 28,
	In29_Cu: 29,
	In30_Cu: 30,
	B_Cu: 31,
} as const;

export type PCB_LAYER_ID_VALUE = (typeof PCB_LAYER_ID)[keyof typeof PCB_LAYER_ID];

/** Number of copper layers in KiCad's schema. */
export const COPPER_LAYER_COUNT = 32;

export type CN_LAYER = number;

/**
 * Minimal interface for the board item that owns a CN_ITEM. Downstream code
 * supplies objects matching this shape; the index signature permits the
 * type-specific casts KiCad uses in AnchorCount()/GetAnchor() without
 * hard-wiring full KiCad board types into this module.
 */
export interface CN_ITEM_PARENT {
	Type(): KICAD_T_VALUE | number;
	GetNetCode(): number;
	GetNetname(): string;
	GetBoundingBox(): BBox;
	HitTest?(aPoint: Vec2, aAccuracy?: number): boolean;
	[key: string]: any;
}

/**
 * Minimal shape interface used by CN_ZONE_LAYER's spatial index. In KiCad
 * this is SHAPE; here it is simplified to bounding-box and collide queries.
 */
export interface CN_SHAPE {
	BBox(): BBox;
	Collide(other: CN_SHAPE | Vec2, accuracy?: number): boolean;
}

/**
 * Minimal triangle shape used by CN_ZONE_LAYER's R-tree. In KiCad this is
 * SHAPE_POLY_SET::TRIANGULATED_POLYGON::TRI.
 */
export class CN_TRI implements CN_SHAPE {
	constructor(
		public a: Vec2,
		public b: Vec2,
		public c: Vec2
	) {}

	BBox(): BBox {
		return BBox.fromPoints([this.a, this.b, this.c]);
	}

	Collide(other: CN_SHAPE | Vec2, _accuracy?: number): boolean {
		if (other instanceof Vec2) {
			return this.pointInTriangle(other);
		}

		// Broad-phase bbox intersection for shape-vs-triangle. A downstream
		// adapter may override CN_ZONE_LAYER.Collide for a more exact test.
		return (
			this.BBox().containsPoint(other.BBox().start) ||
			this.BBox().containsPoint(other.BBox().end) ||
			other.BBox().containsPoint(this.BBox().start) ||
			other.BBox().containsPoint(this.BBox().end)
		);
	}

	private pointInTriangle(p: Vec2): boolean {
		const as_x = p.x - this.a.x;
		const as_y = p.y - this.a.y;

		const s_ab = (this.b.x - this.a.x) * as_y - (this.b.y - this.a.y) * as_x > 0;

		if ((this.c.x - this.a.x) * as_y - (this.c.y - this.a.y) * as_x > 0 === s_ab) {
			return false;
		}

		if (
			(this.c.x - this.b.x) * (p.y - this.b.y) -
				(this.c.y - this.b.y) * (p.x - this.b.x) >
				0 !==
			s_ab
		) {
			return false;
		}

		return true;
	}
}

/**
 * CN_RTREE - Implements an R-tree for fast spatial indexing of connectivity
 * items. Non-owning. Ported from pcbnew/connectivity/connectivity_rtree.h,
 * which wraps KIRTREE::DYNAMIC_RTREE (kimath/geometry/rtree/dynamic_rtree.h).
 */
class CN_RTREE<T> {
	private m_tree = new DYNAMIC_RTREE<T>();

	/**
	 * Function Insert()
	 * Inserts an item into the tree. Item's bounding box is taken via its BBox() method.
	 */
	Insert(min: number[], max: number[], item: T): void {
		this.m_tree.Insert(min, max, item);
	}

	/**
	 * Function Remove()
	 * Removes an item from the tree. Removal is done by comparing data references,
	 * attempting to remove a copy of the item will fail.
	 */
	Remove(min: number[], max: number[], item: T): void {
		this.m_tree.Remove(min, max, item);
	}

	/**
	 * Function RemoveAll()
	 * Removes all items from the RTree
	 */
	RemoveAll(): void {
		this.m_tree.RemoveAll();
	}

	/**
	 * Function Query()
	 * Executes a function object aVisitor for each item whose bounding box
	 * intersects with aBounds (on the layer range [aStartLayer, aEndLayer]).
	 */
	Query(
		bbox: BBox,
		startLayer: number,
		endLayer: number,
		visitor: (item: T) => boolean
	): void {
		const start_layer = startLayer === PCB_LAYER_ID.B_Cu ? INT_MAX : startLayer;
		const end_layer = endLayer === PCB_LAYER_ID.B_Cu ? INT_MAX : endLayer;

		const min = [start_layer, bbox.x, bbox.y];
		const max = [end_layer, bbox.x2, bbox.y2];
		this.m_tree.Search(min, max, visitor);
	}
}

/**
 * CN_ANCHOR represents a physical location that can be connected: a pad or a
 * track/arc/via endpoint.
 */
export class CN_ANCHOR {
	// Tag used for unconnected items.
	static readonly TAG_UNCONNECTED = -1;

	private m_pos: Vec2;
	private m_item: CN_ITEM | null;
	private m_tag: number;
	private m_noline: boolean;
	private m_cluster: CN_CLUSTER | null = null;

	constructor(aPos: Vec2, aItem: CN_ITEM | null) {
		this.m_pos = aPos;
		this.m_item = aItem;
		this.m_tag = -1;
		this.m_noline = false;
	}

	Valid(): boolean {
		if (!this.m_item) {
			return false;
		}

		return this.m_item.Valid();
	}

	Dirty(): boolean {
		return !this.Valid() || this.m_item!.Dirty();
	}

	Item(): CN_ITEM | null {
		return this.m_item;
	}

	SetItem(aItem: CN_ITEM | null): void {
		this.m_item = aItem;
	}

	Parent(): CN_ITEM_PARENT {
		if (!this.m_item || !this.m_item.Valid()) {
			throw new Error('CN_ANCHOR::Parent(): invalid item');
		}

		return this.m_item.Parent();
	}

	Pos(): Vec2 {
		return this.m_pos;
	}

	Move(aPos: Vec2): void {
		this.m_pos = this.m_pos.add(aPos);
	}

	Dist(aSecond: CN_ANCHOR): number {
		return this.m_pos.sub(aSecond.Pos()).magnitude;
	}

	/**
	 * @return tag, a common identifier for connected nodes.
	 */
	GetTag(): number {
		return this.m_tag;
	}

	SetTag(aTag: number): void {
		this.m_tag = aTag;
	}

	/**
	 * @return true if this node can be a target for ratsnest lines.
	 */
	GetNoLine(): boolean {
		return this.m_noline;
	}

	SetNoLine(aEnable: boolean): void {
		this.m_noline = aEnable;
	}

	GetCluster(): CN_CLUSTER | null {
		return this.m_cluster;
	}

	SetCluster(aCluster: CN_CLUSTER | null): void {
		this.m_cluster = aCluster;
	}

	/**
	 * The anchor point is dangling if the parent is a track and this anchor point is not
	 * connected to another item ( track, vias pad or zone) or if the parent is a via and
	 * this anchor point is connected to only one track and not to another item.
	 *
	 * @return true if this anchor is dangling.
	 */
	IsDangling(): boolean {
		let accuracy = 0;

		if (!this.m_cluster) {
			return true;
		}

		// the minimal number of items connected to item_ref
		// at this anchor point to decide the anchor is *not* dangling
		let minimal_count = 1;
		let connected_count = this.m_item!.ConnectedItems().length;

		// a via can be removed if connected to only one other item.
		if (this.Parent().Type() === KICAD_T.PCB_VIA_T) {
			return connected_count < 2;
		}

		if (this.m_item!.AnchorCount() === 1) {
			return connected_count < minimal_count;
		}

		const parent = this.Parent();

		if (parent.Type() === KICAD_T.PCB_TRACE_T || parent.Type() === KICAD_T.PCB_ARC_T) {
			accuracy = Math.round(parent.GetWidth() / 2.0);
		} else if (parent.Type() === KICAD_T.PCB_SHAPE_T) {
			accuracy = Math.round(parent.GetWidth() / 2.0);
		}

		// Items with multiple anchors have usually items connected to each anchor.
		// We want only the item count of this anchor point
		connected_count = 0;

		for (const item of this.m_item!.ConnectedItems()) {
			const itemParent = item.Parent();

			if (itemParent.Type() === KICAD_T.PCB_ZONE_T) {
				const zone = itemParent;

				if (zone.HitTestFilledArea(item.GetBoardLayer(), this.Pos(), accuracy)) {
					connected_count++;
				}
			} else if (itemParent.HitTest && itemParent.HitTest(this.Pos(), accuracy)) {
				connected_count++;
			}
		}

		return connected_count < minimal_count;
	}

	/**
	 * @return the count of tracks and vias connected to this anchor.
	 */
	ConnectedItemsCount(): number {
		if (!this.m_cluster) {
			return 0;
		}

		let connected_count = 0;

		for (const item of this.m_item!.ConnectedItems()) {
			const itemParent = item.Parent();

			if (itemParent.Type() === KICAD_T.PCB_ZONE_T) {
				const zone = itemParent;

				if (zone.HitTestFilledArea(item.GetBoardLayer(), this.Pos())) {
					connected_count++;
				}
			} else if (itemParent.HitTest && itemParent.HitTest(this.Pos())) {
				connected_count++;
			}
		}

		return connected_count;
	}
}

/**
 * CN_ITEM represents a BOARD_CONNECTED_ITEM in the connectivity system (ie:
 * a pad, track/arc/via, or zone).
 */
export class CN_ITEM {
	protected m_dirty: boolean;
	protected m_start_layer: number;
	protected m_end_layer: number;
	protected m_bbox: BBox;

	private m_parent: CN_ITEM_PARENT | null;
	private m_connected: CN_ITEM[] = [];
	private m_anchors: CN_ANCHOR[] = [];
	private m_canChangeNet: boolean;
	private m_valid: boolean;

	constructor(aParent: CN_ITEM_PARENT | null, aCanChangeNet: boolean, aAnchorCount = 2) {
		this.m_parent = aParent;
		this.m_canChangeNet = aCanChangeNet;
		this.m_valid = true;
		this.m_dirty = true;
		this.m_start_layer = 0;
		this.m_end_layer = INT_MAX;
		this.m_bbox = new BBox();
	}

	Dump(): void {
		// eslint-disable-next-line no-console
		console.debug('CN_ITEM::Dump valid:', this.Valid(), 'connected:', this.m_connected.length);

		for (const i of this.m_connected) {
			const t = i.Parent();
			// eslint-disable-next-line no-console
			console.debug('  - connected item type:', t?.Type());
		}
	}

	AddAnchor(aPos: Vec2): CN_ANCHOR {
		const anchor = new CN_ANCHOR(aPos, this);
		this.m_anchors.push(anchor);
		return anchor;
	}

	Anchors(): CN_ANCHOR[] {
		return this.m_anchors;
	}

	SetValid(aValid: boolean): void {
		this.m_valid = aValid;
	}

	Valid(): boolean {
		return this.m_valid;
	}

	SetDirty(aDirty: boolean): void {
		this.m_dirty = aDirty;
	}

	Dirty(): boolean {
		return this.m_dirty;
	}

	/**
	 * Set the layers spanned by the item to aStartLayer and aEndLayer.
	 */
	SetLayers(aStartLayer: number, aEndLayer: number): void {
		// B_Cu is nominally layer 2 but we reset it to INT_MAX to ensure that it is
		// always greater than any other layer in the RTree
		if (aStartLayer === PCB_LAYER_ID.B_Cu) {
			aStartLayer = INT_MAX;
		}

		if (aEndLayer === PCB_LAYER_ID.B_Cu) {
			aEndLayer = INT_MAX;
		}

		this.m_start_layer = aStartLayer;
		this.m_end_layer = aEndLayer;
	}

	/**
	 * Set the layers spanned by the item to a single layer aLayer.
	 */
	SetLayer(aLayer: number): void {
		this.SetLayers(aLayer, aLayer);
	}

	/**
	 * Return the contiguous set of layers spanned by the item.
	 */
	StartLayer(): number {
		return this.m_start_layer;
	}

	EndLayer(): number {
		return this.m_end_layer;
	}

	/**
	 * Return the item's layer, for single-layered items only.
	 * N.B. This should only be used inside connectivity as B_Cu
	 * is mapped to a large int
	 */
	Layer(): number {
		return this.StartLayer();
	}

	/**
	 * When using CN_ITEM layers to compare against board items,
	 * use this function which correctly remaps the B_Cu layer
	 */
	GetBoardLayer(): number {
		let layer = this.Layer();

		if (layer === INT_MAX) {
			layer = PCB_LAYER_ID.B_Cu;
		}

		return layer;
	}

	BBox(): BBox {
		if (this.m_dirty && this.m_valid) {
			this.m_bbox = this.m_parent?.GetBoundingBox() ?? new BBox();
			this.m_dirty = false;
		}

		return this.m_bbox;
	}

	Parent(): CN_ITEM_PARENT {
		if (!this.m_parent) {
			throw new Error('CN_ITEM::Parent(): no parent');
		}

		return this.m_parent;
	}

	ConnectedItems(): CN_ITEM[] {
		return this.m_connected;
	}

	ClearConnections(): void {
		this.m_connected = [];
	}

	CanChangeNet(): boolean {
		return this.m_canChangeNet;
	}

	Connect(b: CN_ITEM): void {
		if (this.m_connected.indexOf(b) < 0) {
			this.m_connected.push(b);
		}
	}

	RemoveInvalidRefs(): void {
		this.m_connected = this.m_connected.filter((item) => item.Valid());
	}

	AnchorCount(): number {
		if (!this.m_valid) {
			return 0;
		}

		const type = this.m_parent?.Type() ?? KICAD_T.NOT_USED;

		switch (type) {
			case KICAD_T.PCB_TRACE_T:
			case KICAD_T.PCB_ARC_T:
				return 2; // start and end

			case KICAD_T.PCB_SHAPE_T:
				return this.m_anchors.length;

			default:
				return 1;
		}
	}

	GetAnchor(n: number): Vec2 {
		if (!this.m_valid) {
			return new Vec2();
		}

		const parent = this.m_parent;

		if (!parent) {
			return new Vec2();
		}

		switch (parent.Type()) {
			case KICAD_T.PCB_PAD_T:
				return parent.GetPosition();

			case KICAD_T.PCB_TRACE_T:
			case KICAD_T.PCB_ARC_T:
				if (n === 0) {
					return parent.GetStart();
				} else {
					return parent.GetEnd();
				}

			case KICAD_T.PCB_VIA_T:
				return parent.GetStart();

			case KICAD_T.PCB_SHAPE_T:
				return n < this.m_anchors.length ? this.m_anchors[n]!.Pos() : new Vec2();

			default:
				throw new Error(`CN_ITEM::GetAnchor(): unimplemented for type ${parent.Type()}`);
		}
	}

	Net(): number {
		if (!this.m_parent || !this.m_valid) {
			return -1;
		}

		return this.m_parent.GetNetCode();
	}
}

export class ITEM_MAP_ENTRY {
	private m_items: CN_ITEM[] = [];

	constructor(aItem?: CN_ITEM) {
		if (aItem) {
			this.m_items.push(aItem);
		}
	}

	MarkItemsAsInvalid(): void {
		for (const item of this.m_items) {
			item.SetValid(false);
		}
	}

	Link(aItem: CN_ITEM): void {
		this.m_items.push(aItem);
	}

	GetItems(): CN_ITEM[] {
		return this.m_items;
	}

	/**
	 * Mirrors ITEM_MAP_ENTRY::IsLinked() — true when the entry has at least
	 * one linked item.
	 */
	IsLinked(): boolean {
		return this.m_items.length > 0;
	}
}

/**
 * Represents a single outline of a zone fill on a particular layer.
 * aSubpolyIndex indicates which outline in the fill's polygon set.
 */
export class CN_ZONE_LAYER extends CN_ITEM {
	private m_zone: CN_ITEM_PARENT;
	private m_subpolyIndex: number;
	private m_layer: number;
	private m_outline: Vec2[] = [];
	private m_triangulatedPolys: CN_TRI[][] = [];
	// Ported from connectivity_items.h: CN_ZONE_LAYER uses a 2D
	// KIRTREE::DYNAMIC_RTREE<const SHAPE*, int, 2> directly (not CN_RTREE).
	private m_rTree = new DYNAMIC_RTREE<CN_TRI>(2, 16);

	constructor(aParent: CN_ITEM_PARENT, aLayer: number, aSubpolyIndex: number) {
		super(aParent, false);

		this.m_zone = aParent;
		this.m_subpolyIndex = aSubpolyIndex;
		this.m_layer = aLayer;

		const fillPoly = this.m_zone.GetFilledPolysList(aLayer);

		if (fillPoly && aSubpolyIndex < fillPoly.OutlineCount()) {
			this.m_outline = fillPoly.Outline(aSubpolyIndex).CPoints();
		}

		this.SetLayers(aLayer, aLayer);
	}

	BuildRTree(): void {
		if (this.m_zone.IsTeardropArea()) {
			return;
		}

		this.m_triangulatedPolys = [];
		this.m_rTree.RemoveAll();

		const fillPoly = this.m_zone.GetFilledPolysList(this.m_layer);

		if (!fillPoly) {
			return;
		}

		for (let ii = 0; ii < fillPoly.TriangulatedPolyCount(); ii++) {
			const triangleSet = fillPoly.TriangulatedPolygon(ii);

			if (triangleSet.GetSourceOutlineIndex() !== this.m_subpolyIndex) {
				continue;
			}

			// Deep copy the triangulated polygon. The copy constructor copies the vertex storage
			// and updates all TRI parent pointers to reference our owned copy. This ensures the
			// triangles remain valid even if the zone is refilled on another thread.
			const tris: CN_TRI[] = [];

			for (const tri of triangleSet.Triangles()) {
				tris.push(new CN_TRI(tri.A, tri.B, tri.C));
			}

			this.m_triangulatedPolys.push(tris);
		}

		for (const triPoly of this.m_triangulatedPolys) {
			for (const tri of triPoly) {
				const bbox = tri.BBox();
				const mmin: [number, number] = [bbox.x, bbox.y];
				const mmax: [number, number] = [bbox.x2, bbox.y2];

				this.m_rTree.Insert(mmin, mmax, tri);
			}
		}
	}

	SubpolyIndex(): number {
		return this.m_subpolyIndex;
	}

	GetLayer(): number {
		return this.m_layer;
	}

	ContainsPoint(p: Vec2): boolean {
		if (this.m_outline.length === 0) {
			return false;
		}

		if (this.m_zone.IsTeardropArea()) {
			return this.outlineCollidePoint(p);
		}

		const mmin: [number, number] = [p.x, p.y];
		const mmax: [number, number] = [p.x, p.y];
		let collision = false;

		const visitor = (tri: CN_TRI): boolean => {
			if (tri.Collide(p)) {
				collision = true;
				return false;
			}

			return true;
		};

		this.m_rTree.Search(mmin, mmax, visitor);

		return collision;
	}

	override AnchorCount(): number {
		if (!this.Valid() || !this.HasValidOutline()) {
			return 0;
		}

		return this.GetOutline().length > 0 ? 1 : 0;
	}

	override GetAnchor(_n: number): Vec2 {
		if (!this.Valid() || !this.HasValidOutline()) {
			return new Vec2();
		}

		return this.GetOutline()[0]!;
	}

	HasValidOutline(): boolean {
		return this.m_outline.length > 0;
	}

	GetOutline(): Vec2[] {
		return this.m_outline;
	}

	OutlinePointCount(): number {
		return this.m_outline.length;
	}

	OutlinePoint(aIndex: number): Vec2 {
		return this.m_outline[aIndex]!;
	}

	Collide(aRefShape: CN_SHAPE): boolean {
		if (this.m_outline.length === 0) {
			return false;
		}

		if (this.m_zone.IsTeardropArea()) {
			return this.outlineCollideShape(aRefShape);
		}

		const bbox = aRefShape.BBox();
		const mmin: [number, number] = [bbox.x, bbox.y];
		const mmax: [number, number] = [bbox.x2, bbox.y2];
		let collision = false;

		const visitor = (tri: CN_TRI): boolean => {
			if (aRefShape.Collide(tri)) {
				collision = true;
				return false;
			}

			return true;
		};

		this.m_rTree.Search(mmin, mmax, visitor);

		return collision;
	}

	HasSingleConnection(): boolean {
		let count = 0;

		for (const item of this.ConnectedItems()) {
			if (item.Valid()) {
				count++;
			}

			if (count > 1) {
				break;
			}
		}

		return count === 1;
	}

	private outlineCollidePoint(p: Vec2): boolean {
		// Point-in-polygon test for teardrop / outline-only collision mode.
		let inside = false;

		for (let i = 0, j = this.m_outline.length - 1; i < this.m_outline.length; j = i++) {
			const pi = this.m_outline[i]!;
			const pj = this.m_outline[j]!;

			const intersect =
				pi.y > p.y !== pj.y > p.y &&
				p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;

			if (intersect) {
				inside = !inside;
			}
		}

		return inside;
	}

	private outlineCollideShape(shape: CN_SHAPE): boolean {
		// Conservative outline-vs-shape collision used for teardrop areas.
		const bbox = shape.BBox();

		if (!this.outlineBBox().containsPoint(bbox.start) && !this.outlineBBox().containsPoint(bbox.end)) {
			return false;
		}

		return this.outlineCollidePoint(bbox.center);
	}

	private outlineBBox(): BBox {
		return BBox.fromPoints(this.m_outline);
	}
}

/**
 * A connected component; stores the items that form one electrically connected
 * cluster.
 */
export class CN_CLUSTER {
	private m_conflicting: boolean;
	private m_originNet: number;
	private m_originPad: CN_ITEM | null;
	private m_items: CN_ITEM[] = [];
	private m_netRanks: Map<number, number> = new Map();

	constructor() {
		this.m_originPad = null;
		this.m_originNet = -1;
		this.m_conflicting = false;
	}

	HasValidNet(): boolean {
		return this.m_originNet > 0;
	}

	OriginNet(): number {
		return this.m_originNet;
	}

	OriginNetName(): string {
		if (!this.m_originPad || !this.m_originPad.Valid()) {
			return '<none>';
		} else {
			return this.m_originPad.Parent().GetNetname();
		}
	}

	Contains(aItem: CN_ITEM): boolean {
		return this.m_items.indexOf(aItem) >= 0;
	}

	ContainsParent(aItem: CN_ITEM_PARENT): boolean {
		return (
			this.m_items.find((item) => item.Valid() && item.Parent() === aItem) !== undefined
		);
	}

	Dump(): void {
		for (const item of this.m_items) {
			const parent = item.Parent();
			// eslint-disable-next-line no-console
			console.debug(
				' - item :',
				item,
				'bitem :',
				parent,
				'type :',
				parent.Type(),
				'inet :',
				parent.GetNetname()
			);
			item.Dump();
		}
	}

	Size(): number {
		return this.m_items.length;
	}

	IsOrphaned(): boolean {
		return this.m_originPad === null;
	}

	IsConflicting(): boolean {
		return this.m_conflicting;
	}

	Add(item: CN_ITEM): void {
		this.m_items.push(item);

		const netCode = item.Net();

		if (netCode <= 0) {
			return;
		}

		if (this.m_originNet <= 0) {
			this.m_originNet = netCode;
			this.m_netRanks.set(this.m_originNet, 0);
		}

		const itemParent = item.Parent();

		if (itemParent.Type() === KICAD_T.PCB_PAD_T && !itemParent.IsFreePad()) {
			let rank: number;
			const it = this.m_netRanks.get(netCode);

			if (it === undefined) {
				this.m_netRanks.set(netCode, 1);
				rank = 1;
			} else {
				this.m_netRanks.set(netCode, it + 1);
				rank = it + 1;
			}

			const originRank = this.m_netRanks.get(this.m_originNet) ?? 0;

			if (!this.m_originPad || rank > originRank) {
				this.m_originPad = item;
				this.m_originNet = netCode;
			}

			if (this.m_originPad && item.Net() !== this.m_originNet) {
				this.m_conflicting = true;
			}
		}
	}

	*[Symbol.iterator](): Iterator<CN_ITEM> {
		for (const item of this.m_items) {
			yield item;
		}
	}
}

/**
 * A list/owner of CN_ITEM objects, backed by a spatial index for fast
 * nearest-neighbor queries.
 */
export class CN_LIST {
	private m_items: CN_ITEM[] = [];
	private m_dirty = false;
	private m_hasInvalid = false;
	private m_index = new CN_RTREE<CN_ITEM>();

	constructor() {
		this.m_dirty = false;
		this.m_hasInvalid = false;
	}

	begin(): Iterable<CN_ITEM> {
		return this.m_items;
	}

	Clear(): void {
		for (const item of this.m_items) {
			// TypeScript has no deterministic destructor. The original C++ deletes the
			// item here; downstream code should drop references to let GC reclaim it.
			item.SetValid(false);
		}

		this.m_items = [];
		this.m_index.RemoveAll();
	}

	*[Symbol.iterator](): Iterator<CN_ITEM> {
		for (const item of this.m_items) {
			yield item;
		}
	}

	operatorIndex(aIndex: number): CN_ITEM {
		return this.m_items[aIndex]!;
	}

	FindNearby(aItem: CN_ITEM, aFunc: (item: CN_ITEM) => boolean): void {
		this.m_index.Query(aItem.BBox(), aItem.StartLayer(), aItem.EndLayer(), aFunc);
	}

	SetHasInvalid(aInvalid = true): void {
		this.m_hasInvalid = aInvalid;
	}

	SetDirty(aDirty = true): void {
		this.m_dirty = aDirty;
	}

	IsDirty(): boolean {
		return this.m_dirty;
	}

	RemoveInvalidItems(aGarbage: CN_ITEM[]): void {
		if (!this.m_hasInvalid) {
			return;
		}

		const remaining: CN_ITEM[] = [];

		for (const item of this.m_items) {
			if (item.Valid()) {
				remaining.push(item);
			} else {
				aGarbage.push(item);
			}
		}

		this.m_items = remaining;

		for (const item of aGarbage) {
			const bbox = item.BBox();
			const min = [item.StartLayer(), bbox.x, bbox.y];
			const max = [item.EndLayer(), bbox.x2, bbox.y2];
			this.m_index.Remove(min, max, item);
		}

		this.m_hasInvalid = false;
	}

	ClearDirtyFlags(): void {
		for (const item of this.m_items) {
			item.SetDirty(false);
		}

		this.SetDirty(false);
	}

	Size(): number {
		return this.m_items.length;
	}

	Add(pad: CN_ITEM_PARENT): CN_ITEM | null {
		if (!pad.IsOnCopperLayer()) {
			return null;
		}

		const item = new CN_ITEM(pad, false, 1);

		const uniqueAnchors = new Map<string, Vec2>();
		pad.Padstack().ForEachUniqueLayer((aLayer: number) => {
			const pos = pad.ShapePos(aLayer);
			uniqueAnchors.set(`${pos.x},${pos.y}`, pos);
		});

		for (const anchor of uniqueAnchors.values()) {
			item.AddAnchor(anchor);
		}

		item.SetLayers(PCB_LAYER_ID.F_Cu, PCB_LAYER_ID.B_Cu);

		switch (pad.GetAttribute()) {
			case PAD_ATTRIB.SMD:
			case PAD_ATTRIB.NPTH:
			case PAD_ATTRIB.CONN: {
				const lmsk = pad.GetLayerSet().CuStack();

				if (lmsk.length > 0) {
					item.SetLayer(lmsk[0]!);
				}

				break;
			}

			default:
				break;
		}

		this.addItemtoTree(item);
		this.m_items.push(item);

		// Re-mark dirty after tree insertion since BBox() clears the dirty flag
		item.SetDirty(true);
		this.SetDirty();
		return item;
	}

	AddTrack(track: CN_ITEM_PARENT): CN_ITEM {
		const item = new CN_ITEM(track, true);
		this.m_items.push(item);
		item.AddAnchor(track.GetStart());
		item.AddAnchor(track.GetEnd());
		item.SetLayer(track.GetLayer());
		this.addItemtoTree(item);

		// Re-mark dirty after tree insertion since BBox() clears the dirty flag
		item.SetDirty(true);
		this.SetDirty();
		return item;
	}

	AddArc(aArc: CN_ITEM_PARENT): CN_ITEM {
		const item = new CN_ITEM(aArc, true);
		this.m_items.push(item);
		item.AddAnchor(aArc.GetStart());
		item.AddAnchor(aArc.GetEnd());
		item.SetLayer(aArc.GetLayer());
		this.addItemtoTree(item);

		// Re-mark dirty after tree insertion since BBox() clears the dirty flag
		item.SetDirty(true);
		this.SetDirty();
		return item;
	}

	AddVia(via: CN_ITEM_PARENT): CN_ITEM {
		const item = new CN_ITEM(via, !via.GetIsFree(), 1);

		this.m_items.push(item);
		item.AddAnchor(via.GetStart());

		item.SetLayers(via.TopLayer(), via.BottomLayer());
		this.addItemtoTree(item);

		// Re-mark dirty after tree insertion since BBox() clears the dirty flag
		item.SetDirty(true);
		this.SetDirty();
		return item;
	}

	AddZone(zone: CN_ITEM_PARENT, aLayer: number): CN_ITEM[] {
		const polys = zone.GetFilledPolysList(aLayer);
		const rv: CN_ITEM[] = [];

		if (!polys) {
			return rv;
		}

		for (let j = 0; j < polys.OutlineCount(); j++) {
			const zitem = new CN_ZONE_LAYER(zone, aLayer, j);

			zitem.BuildRTree();

			const outline = zone.GetFilledPolysList(aLayer).COutline(j);
			for (const pt of outline.CPoints()) {
				zitem.AddAnchor(pt);
			}

			rv.push(this.AddZoneLayer(zitem) as CN_ZONE_LAYER);
		}

		return rv;
	}

	AddZoneLayer(zitem: CN_ZONE_LAYER): CN_ZONE_LAYER {
		this.m_items.push(zitem);
		this.addItemtoTree(zitem);

		// Re-mark dirty after tree insertion since BBox() clears the dirty flag
		zitem.SetDirty(true);
		this.SetDirty();
		return zitem;
	}

	AddShape(shape: CN_ITEM_PARENT): CN_ITEM {
		const item = new CN_ITEM(shape, true);
		this.m_items.push(item);

		for (const point of shape.GetConnectionPoints()) {
			item.AddAnchor(point);
		}

		item.SetLayer(shape.GetLayer());
		this.addItemtoTree(item);

		// Re-mark dirty after tree insertion since BBox() clears the dirty flag
		item.SetDirty(true);
		this.SetDirty();
		return item;
	}

	protected addItemtoTree(item: CN_ITEM): void {
		const bbox = item.BBox();
		const min = [item.StartLayer(), bbox.x, bbox.y];
		const max = [item.EndLayer(), bbox.x2, bbox.y2];
		this.m_index.Insert(min, max, item);
	}
}
