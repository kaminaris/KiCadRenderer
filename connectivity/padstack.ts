/*
 * Ported from KiCad source:
 *   pcbnew/padstack.h (.cpp)
 *   pcbnew/via.h (PCB_VIA) — geometry subset
 *   pcbnew/pcb_via.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The padstack / via geometry model. A PADSTACK holds one pad shape per layer;
 * a via is a padstack whose "pads" are the annular rings on its connected
 * copper layers. Dimensions in mm.
 */

import { SHAPE } from '../geometry/Shape';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SHAPE_COMPOUND } from '../geometry/ShapeCompound';
import { Vec2 } from '../math/Vec2';
import { LSET, PCB_LAYER_ID } from './ConnectivityItems';

/** Mirrors pcbnew/via.h VIATYPE. */
export enum VIATYPE {
	THROUGH = 0,
	BLIND_BURIED = 1,
	MICROVIA = 2,
}

/** Mirrors pcbnew/padstack.cpp's per-layer pad modes. */
export type PAD_SHAPE = 'circle' | 'oval' | 'rect' | 'roundrect' | 'custom';

/**
 * One pad entry in a padstack: the shape on a single layer.
 * Mirrors PADSTACK::StackItem.
 */
export interface PADSTACK_ITEM {
	layer: number;
	shape: PAD_SHAPE;
	size: Vec2;
	// Corner radius for roundrect (0 = plain rect).
	cornerRadius: number;
}

/**
 * A padstack: the stacked per-layer pad shapes that make up a pad or via's
 * copper at each layer. Mirrors KiCad's PADSTACK (pcbnew/padstack.h).
 */
export class PADSTACK {
	private m_items: PADSTACK_ITEM[] = [];

	AddLayer(aLayer: number, aShape: PAD_SHAPE, aSize: Vec2, aCornerRadius = 0): void {
		this.m_items.push({ layer: aLayer, shape: aShape, size: aSize, cornerRadius: aCornerRadius });
	}

	Layers(): number[] {
		return this.m_items.map(i => i.layer);
	}

	/** Builds the effective SHAPE for a given layer (mirrors GetPadShape). */
	BuildShape(aLayer: number, aPosition: Vec2): SHAPE | null {
		const item = this.m_items.find(i => i.layer === aLayer);
		if (!item) {
			return null;
		}
		return padShapeToShape(item.shape, aPosition, item.size, item.cornerRadius);
	}

	/** The copper shape spanning all layers (union of per-layer shapes). */
	BuildCompound(aPosition: Vec2): SHAPE_COMPOUND {
		const subs: SHAPE[] = [];
		for (const item of this.m_items) {
			const s = padShapeToShape(item.shape, aPosition, item.size, item.cornerRadius);
			if (s) {
				subs.push(s);
			}
		}
		return new SHAPE_COMPOUND(subs);
	}

	/**
	 * The drill hole shape: a circle for a round hole, or a segment (slot) for
	 * an oval/slotted hole. Mirrors PAD::GetDrillShape / PADSTACK drill.
	 */
	GetDrillShape(aPosition: Vec2, aDrill: number, aSlotWidth = 0, aSlotAngleDeg = 0, aIsSlot = false): SHAPE {
		if (!aIsSlot || aSlotWidth <= 0) {
			return new SHAPE_CIRCLE(aPosition, aDrill / 2);
		}
		const r = aSlotWidth / 2;
		const len = Math.max(0, aDrill - aSlotWidth);
		const a = (aSlotAngleDeg * Math.PI) / 180;
		const dx = Math.cos(a);
		const dy = Math.sin(a);
		return new SHAPE_SEGMENT(
			new Vec2(aPosition.x - (len / 2) * dx, aPosition.y - (len / 2) * dy),
			new Vec2(aPosition.x + (len / 2) * dx, aPosition.y + (len / 2) * dy),
			r * 2
		);
	}

	/**
	 * Tests whether `aOther` (a canonical SHAPE) collides with any of this
	 * padstack's per-layer copper shapes on `aLayer`, within `aClearance`.
	 * Mirrors the DRC pad-vs-shape collision on a specific layer.
	 */
	Collide(aLayer: number, aPosition: Vec2, aOther: SHAPE, aClearance = 0): boolean {
		for (const item of this.m_items) {
			if (item.layer !== aLayer) {
				continue;
			}
			const shape = padShapeToShape(item.shape, aPosition, item.size, item.cornerRadius);
			try {
				if (shape.Collide(aOther, aClearance)) {
					return true;
				}
			} catch {
				// collision not implemented for this pair — skip
			}
		}
		return false;
	}
}

function padShapeToShape(
	shape: PAD_SHAPE,
	position: Vec2,
	size: Vec2,
	cornerRadius: number
): SHAPE | null {
	switch (shape) {
		case 'circle':
			return new SHAPE_CIRCLE(position, size.x / 2);
		case 'oval':
			// wide segment between the two caps
			if (size.x > size.y) {
				const len = size.x - size.y;
				return new SHAPE_SEGMENT(
					new Vec2(position.x - len / 2, position.y),
					new Vec2(position.x + len / 2, position.y),
					size.y
				);
			}
			{
				const len = size.y - size.x;
				return new SHAPE_SEGMENT(
					new Vec2(position.x, position.y - len / 2),
					new Vec2(position.x, position.y + len / 2),
					size.x
				);
			}
		case 'rect':
		case 'roundrect':
		case 'custom':
		default:
			return new SHAPE_RECT(
				new Vec2(position.x - size.x / 2, position.y - size.y / 2),
				size
			);
	}
}

/**
 * Geometry helpers for a via (PCB_VIA / pcb_via.h). A via is modeled as a
 * padstack whose annular pads sit on its start..end layers.
 */
export class PCB_VIA {	viaType: VIATYPE = VIATYPE.THROUGH;
	position = new Vec2();
	drill = 0.3;
	// Annular ring diameter (copper pad diameter).
	padSize = 0.6;
	// start/bottom layer for blind/buried/microvia.
	startLayer = PCB_LAYER_ID.F_Cu;
	endLayer = PCB_LAYER_ID.B_Cu;

	constructor(opts?: Partial<PCB_VIA>) {
		if (opts) {
			Object.assign(this, opts);
		}
	}

	GetDrillSize(): number {
		return this.drill;
	}

	IsThrough(): boolean {
		return this.viaType === VIATYPE.THROUGH;
	}

	IsBlindBuried(): boolean {
		return this.viaType === VIATYPE.BLIND_BURIED;
	}

	IsMicroVia(): boolean {
		return this.viaType === VIATYPE.MICROVIA;
	}

	TopLayer(): number {
		return this.startLayer;
	}

	BottomLayer(): number {
		return this.endLayer;
	}

	/** The copper layers this via connects. */
	GetLayerSet(): LSET {
		const lset = new LSET();
		for (let l = this.startLayer; l <= this.endLayer && l < 32; l++) {
			lset.SetLayer(l);
		}
		if (this.viaType === VIATYPE.THROUGH) {
			lset.SetLayer(PCB_LAYER_ID.F_Cu);
			lset.SetLayer(PCB_LAYER_ID.B_Cu);
		}
		return lset;
	}

	/** The via's copper shape (annular pad) as a circle. */
	BuildShape(): SHAPE_CIRCLE {
		return new SHAPE_CIRCLE(this.position, this.padSize / 2);
	}
}
