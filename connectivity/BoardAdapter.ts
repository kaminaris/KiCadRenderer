/*
 * This file is a bridge between project's scene model (PaintedItem, LayeredBoardScene)
 * and KiCad's CN_ITEM_PARENT interface used by the connectivity algorithm.
 *
 * Copyright (C) 2024 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */

import { Vec2 } from "../math/Vec2";
import { BBox } from "../math/BBox";
import {
	CN_ITEM_PARENT,
	CN_SHAPE,
	KICAD_T,
	LSET,
	PCB_LAYER_ID,
	PAD_ATTRIB,
} from "./ConnectivityItems";
import { SHAPE } from "../geometry/Shape";
import { SHAPE_RECT } from "../geometry/ShapeRect";
import { SHAPE_CIRCLE } from "../geometry/ShapeCircle";
import { SHAPE_SEGMENT } from "../geometry/ShapeSegment";
import { SHAPE_LINE_CHAIN } from "../geometry/ShapeLineChain";
import { SHAPE_POLY_SET } from "../geometry/ShapePolySet";
import { pointInPolygon } from "../geometry/polygon";
import type { PaintedItem, LayeredBoardScene } from "../paint/BoardPainter";
import { type PaintedShape } from "../paint/PaintedShape";

/**
 * Maps a copper layer name to the KiCad copper layer index (layer_id.h):
 * F.Cu=0, InN.Cu=N (1..30), B.Cu=31.
 */
export function layerIndexOf(layer: string): number {
	if (layer === "F.Cu") {
		return PCB_LAYER_ID.F_Cu;
	}
	if (layer === "B.Cu") {
		return PCB_LAYER_ID.B_Cu;
	}
	// Internal layers: InN.Cu -> N (1..30). Non-copper or unrecognised names
	// map to a copper fallback of 1 so the ported LSET still places them on
	// some copper layer.
	const m = /^In(\d+)\.Cu$/.exec(layer);
	if (m) {
		const n = parseInt(m[1]!, 10);
		if (n >= 1 && n <= 30) {
			return n;
		}
	}
	return 1;
}

export function layerMaskOf(layer: string): bigint {
	if (layer === "F.Cu") {
		return 1n << 0n;
	}
	if (layer === "B.Cu") {
		return 1n << 31n;
	}
	const m = /^In(\d+)\.Cu$/.exec(layer);
	if (m) {
		const n = parseInt(m[1]!, 10);
		if (n >= 1 && n <= 30) {
			return 1n << BigInt(n);
		}
	}
	return 0n;
}

export class BoardAdapter implements CN_ITEM_PARENT {
	private m_paintedItem: PaintedItem;
	private m_scene: LayeredBoardScene;

	constructor(item: PaintedItem, scene: LayeredBoardScene) {
		this.m_paintedItem = item;
		this.m_scene = scene;
	}

	Type(): number {
		switch (this.m_paintedItem.kind) {
			case 'pad':
				return KICAD_T.PCB_PAD_T;
			case 'track':
				return KICAD_T.PCB_TRACE_T;
			case 'via':
				return KICAD_T.PCB_VIA_T;
			case 'zone':
				return KICAD_T.PCB_ZONE_T;
			case 'footprint':
			case 'footprint-ref':
				return KICAD_T.PCB_FOOTPRINT_T;
			default:
				return KICAD_T.PCB_SHAPE_T;
		}
	}

	GetNetCode(): number {
		return this.m_paintedItem.netId ?? -1;
	}

	GetNetname(): string {
		return this.m_paintedItem.netName ?? "";
	}

	GetBoundingBox(): BBox {
		return new BBox(
			this.m_paintedItem.bbox.x,
			this.m_paintedItem.bbox.y,
			this.m_paintedItem.bbox.w,
			this.m_paintedItem.bbox.h
		);
	}

	HitTest(aPoint: Vec2, aAccuracy?: number): boolean {
		return this.toShape().Contains(aPoint, aAccuracy ?? 0.15);
	}

	IsOnCopperLayer(): boolean {
		switch (this.m_paintedItem.kind) {
			case 'pad':
			case 'track':
			case 'via':
			case 'zone':
				return true;
			case 'graphic':
				return this.m_paintedItem.layer.endsWith('.Cu');
			default:
				return false;
		}
	}

	IsConnected(): boolean {
		const net = this.GetNetCode();
		return net !== null && net !== undefined && net > 0;
	}

	GetLayerSet(): LSET {
		// Vias span the whole copper stack; everything else gets the mask of
		// its single layer. Internal layers are not representable in the
		// ported LSET (only F.Cu=0 / B.Cu=2) — see layerMaskOf.
		if (this.m_paintedItem.kind === 'via') {
			return new LSET().AllCuMask();
		}
		return new LSET(layerMaskOf(this.m_paintedItem.layer));
	}

	/** Returns a CN_SHAPE wrapper over the painted shape for the connectivity
	 * collision tests (the ported equivalent of KiCad's GetEffectiveShape).
	 * Uses the canonical SHAPE_* geometry so collision goes through
	 * SHAPE_COLLISION (SHAPE satisfies CN_SHAPE structurally). */
	GetEffectiveShape(_layer?: number, _flashing?: number): CN_SHAPE {
		return this.toShape() as unknown as CN_SHAPE;
	}

	/** Converts the painted shape to the canonical SHAPE_* model. */
	toShape(): SHAPE {
		const s = this.m_paintedItem.shape;

		switch (s.type) {
			case 'rect':
				return new SHAPE_RECT(new Vec2(s.x, s.y), new Vec2(s.w, s.h));
			case 'circle':
				return new SHAPE_CIRCLE(new Vec2(s.cx, s.cy), s.r);
			case 'segment':
				return new SHAPE_SEGMENT(new Vec2(s.x1, s.y1), new Vec2(s.x2, s.y2), s.width);
			case 'polygon':
			default: {
				if (s.type === 'polygon' && s.points.length > 0) {
					const ps = new SHAPE_POLY_SET();
					ps.AddOutline(
						new SHAPE_LINE_CHAIN(s.points.map(p => new Vec2(p.x, p.y)), true)
					);
					return ps;
				}
				return new SHAPE_RECT(new Vec2(0, 0), new Vec2(0, 0));
			}
		}
	}

	GetLayer(): number {
		return layerIndexOf(this.m_paintedItem.layer);
	}

	GetWidth(): number {
		const shape = this.m_paintedItem.shape;
		if (shape.type === 'segment') {
			return shape.width;
		}
		return 0;
	}

	GetStart(): Vec2 {
		const shape = this.m_paintedItem.shape;
		if (shape.type === 'segment') {
			return new Vec2(shape.x1, shape.y1);
		}
		if (shape.type === 'circle') {
			return new Vec2(shape.cx, shape.cy);
		}
		return new Vec2(
			this.m_paintedItem.bbox.x + this.m_paintedItem.bbox.w / 2,
			this.m_paintedItem.bbox.y + this.m_paintedItem.bbox.h / 2
		);
	}

	GetEnd(): Vec2 {
		const shape = this.m_paintedItem.shape;
		if (shape.type === 'segment') {
			return new Vec2(shape.x2, shape.y2);
		}
		return this.GetStart();
	}

	GetPosition(): Vec2 {
		return this.GetStart();
	}

	GetIsFree(): boolean {
		const net = this.GetNetCode();
		return net === 0 || net < 0;
	}

	GetAttribute(): number {
		// Scene pads are per-layer items without an attribute; SMD is the
		// common case and produces a single-layer CN_ITEM, which is the
		// correct behavior for the per-layer pad items we build from.
		return PAD_ATTRIB.SMD;
	}

	GetConnectionPoints(): Vec2[] {
		const shape = this.m_paintedItem.shape;
		switch (shape.type) {
			case 'segment':
				return [new Vec2(shape.x1, shape.y1), new Vec2(shape.x2, shape.y2)];
			case 'circle':
				return [new Vec2(shape.cx, shape.cy)];
			case 'polygon':
				return shape.points.map(p => new Vec2(p.x, p.y));
			case 'rect':
				return [
					new Vec2(shape.x, shape.y),
					new Vec2(shape.x + shape.w, shape.y),
					new Vec2(shape.x + shape.w, shape.y + shape.h),
					new Vec2(shape.x, shape.y + shape.h),
				];
		}
		return [];
	}

	ForEachUniqueLayer(fn: (layer: number) => void): void {
		fn(this.GetLayer());
	}

	Padstack(): { ForEachUniqueLayer: (fn: (layer: number) => void) => void } {
		return { ForEachUniqueLayer: (fn: (layer: number) => void) => fn(this.GetLayer()) };
	}

	ShapePos(layer: number): Vec2 {
		return this.GetPosition();
	}

	/** Vias are treated as through-hole (span the whole copper stack) for
	 * now — the scene doesn't retain blind/buried via end layers. */
	TopLayer(): number {
		return PCB_LAYER_ID.F_Cu;
	}

	BottomLayer(): number {
		return PCB_LAYER_ID.B_Cu;
	}

	IsTeardropArea(): boolean {
		return false;
	}

	GetFilledPolysList(layer: number): PN_POLY_LIST | null {
		if (this.m_paintedItem.kind !== 'zone') {
			return null;
		}

		const zone = this.m_scene.zoneFills.find(z => z.layer === this.m_paintedItem.layer);
		if (!zone) {
			return null;
		}

		const outlines = zone.points as { x: number; y: number }[];

		return {
			IsEmpty: () => !outlines || outlines.length === 0,
			OutlineCount: () => (outlines ? 1 : 0),
			Outline: (index: number) => ({ CPoints: () => outlines.map(p => new Vec2(p.x, p.y)) }),
			COutline: (index: number) => ({ CPoints: () => outlines.map(p => new Vec2(p.x, p.y)) }),
			TriangulatedPolyCount: () => 0,
			TriangulatedPolygon: (_i: number) => ({ GetSourceOutlineIndex: () => 0, Triangles: () => [] }),
		};
	}

	HitTestFilledArea(layer: number, point: Vec2, accuracy: number): boolean {
		const zone = this.m_scene.zoneFills.find(z => z.layer === this.m_paintedItem.layer);
		if (!zone) {
			return false;
		}
		return pointInPolygon(point, zone.points, accuracy);
	}

	GetDuplicatePadNumbersAreJumpers(): boolean {
		return false;
	}

	/**
	 * Mirrors PAD::IsFreePad(): a pad whose parent is not a footprint. Scene
	 * pad items are per-layer items with no footprint parent, so they count
	 * as free pads (excluded from CN_CLUSTER's origin-pad ranking).
	 */
	IsFreePad(): boolean {
		return this.m_paintedItem.kind !== 'pad' || this.GetParentFootprint() === null;
	}

	GetParentFootprint(): PaintedItem | null {
		return this.m_paintedItem.kind === 'pad' ? null : this.m_paintedItem;
	}

	GetNumber(): string {
		const element = this.m_paintedItem.element;
		return element?.Reference?.Value ?? "";
	}
}

export interface PN_POLY_LIST {
	IsEmpty(): boolean;
	OutlineCount(): number;
	Outline(index: number): PN_POLY_LINE;
	COutline(index: number): PN_POLY_LINE;
	TriangulatedPolyCount(): number;
	TriangulatedPolygon(index: number): TriangulatedPolygon;
}

export interface PN_POLY_LINE {
	CPoints(): Vec2[];
}

export interface TriangulatedPolygon {
	GetSourceOutlineIndex(): number;
	Triangles(): CN_TRI[];
}

export interface CN_TRI {
	A: Vec2;
	B: Vec2;
	C: Vec2;
	BBox(): BBox;
}
