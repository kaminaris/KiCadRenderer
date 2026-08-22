/*
 * Ported from KiCad source:
 *   eeschema/lib_symbol.cpp (LIB_SYMBOL::Shape) / lib_item.h (LIB_ITEM)
 *   eeschema/sch_shape.cpp (SCH_SHAPE) — schematic symbol body -> geometry
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Converts a schematic symbol body item (rectangle/circle/arc/line/poly/bezier)
 * into a canonical SHAPE, and a full symbol body into a SHAPE_COMPOUND. These
 * mirror KiCad's LIB_ITEM::GetShape() on the schematic side (distinct from the
 * footprint-editor fp_* primitives, which are FP_SHAPE).
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE } from './Shape';
import { SHAPE_SEGMENT } from './ShapeSegment';
import { SHAPE_CIRCLE } from './ShapeCircle';
import { SHAPE_RECT } from './ShapeRect';
import { SHAPE_ARC } from './ShapeArc';
import { SHAPE_LINE_CHAIN } from './ShapeLineChain';
import { SHAPE_POLY_SET } from './ShapePolySet';
import { SCH_RECTANGLE, SCH_CIRCLE, SCH_ARC } from './SchGeometry';

/** Type tag for a schematic symbol graphic item. */
export enum LIB_ITEM_TYPE {
	LINE = 0,
	RECT = 1,
	CIRCLE = 2,
	ARC = 3,
	POLY = 4,
	BEZIER = 5,
}

/** A schematic symbol body item (mirrors LIB_ITEM / SCH_SHAPE). */
export class LIB_ITEM {
	type: LIB_ITEM_TYPE = LIB_ITEM_TYPE.LINE;
	start = new Vec2();
	end = new Vec2();
	// For arc.
	mid = new Vec2();
	// For poly/bezier.
	points: Vec2[] = [];
	width = 0.15;

	constructor(aType: LIB_ITEM_TYPE = LIB_ITEM_TYPE.LINE) {
		this.type = aType;
	}
}

/**
 * Converts one schematic symbol body item to its canonical SHAPE.
 * Mirrors LIB_ITEM::Shape().
 */
export function libItemToShape(aItem: LIB_ITEM): SHAPE {
	switch (aItem.type) {
		case LIB_ITEM_TYPE.LINE:
		case LIB_ITEM_TYPE.BEZIER: {
			// Cursor (bezier) is drawn as a polyline from its control points.
			const pts = aItem.points.length > 0 ? aItem.points : [aItem.start, aItem.end];
			if (pts.length <= 1) {
				return new SHAPE_SEGMENT(aItem.start, aItem.end, aItem.width);
			}
			const chain = new SHAPE_LINE_CHAIN(pts);
			chain.SetClosed(false);
			return new SHAPE_POLY_SET();
		}
		case LIB_ITEM_TYPE.RECT:
			return new SHAPE_RECT(
				new Vec2(Math.min(aItem.start.x, aItem.end.x), Math.min(aItem.start.y, aItem.end.y)),
				new Vec2(
					Math.abs(aItem.end.x - aItem.start.x),
					Math.abs(aItem.end.y - aItem.start.y)
				)
			);
		case LIB_ITEM_TYPE.CIRCLE:
			return new SHAPE_CIRCLE(aItem.start, aItem.start.sub(aItem.end).magnitude);
		case LIB_ITEM_TYPE.ARC:
			return new SHAPE_ARC(aItem.start, aItem.mid, aItem.end);
		default:
			return new SHAPE_SEGMENT(aItem.start, aItem.end, aItem.width);
	}
}

/**
 * Builds the compound representing a symbol body (all graphic items, no
 * fields). Mirrors LIB_SYMBOL's set of shapes on the schematic side.
 */
export function libBodyToCompound(aItems: LIB_ITEM[]): SHAPE[] {
	return aItems.map(libItemToShape);
}

/** Convenience: a symbol item from a SCH_RECTANGLE/SCH_CIRCLE/SCH_ARC. */
export function fromSchRectangle(a: SCH_RECTANGLE): LIB_ITEM {
	const it = new LIB_ITEM(LIB_ITEM_TYPE.RECT);
	it.start = a.GetStart();
	it.end = a.GetEnd();
	return it;
}

export function fromSchCircle(a: SCH_CIRCLE): LIB_ITEM {
	const it = new LIB_ITEM(LIB_ITEM_TYPE.CIRCLE);
	it.start = a.GetCenter();
	it.end = new Vec2(a.GetCenter().x + a.GetRadius(), a.GetCenter().y);
	return it;
}

export function fromSchArc(a: SCH_ARC): LIB_ITEM {
	const it = new LIB_ITEM(LIB_ITEM_TYPE.ARC);
	it.start = a.GetStart();
	it.end = a.GetEnd();
	it.mid = a.GetMid();
	return it;
}
