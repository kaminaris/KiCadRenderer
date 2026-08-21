/*
 * Ported from KiCad source:
 *   pcbnew/fp_shape.h (FP_SHAPE) — footprint-editor shape primitives
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The footprint-editor (CELL) shape primitives: fp_line / fp_rect / fp_circle /
 * fp_arc / fp_poly / fp_bezier. These are the standalone graphical shapes a
 * footprint body is built from. Coordinates in mm (footprint-local before the
 * footprint transform is applied).
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SHAPE } from './Shape';
import { SHAPE_SEGMENT } from './ShapeSegment';
import { SHAPE_RECT } from './ShapeRect';
import { SHAPE_CIRCLE } from './ShapeCircle';
import { SHAPE_POLY_SET } from './ShapePolySet';
import { SHAPE_LINE_CHAIN } from './ShapeLineChain';
import { BEZIER } from './bezier';

/** Mirrors FP_SHAPE's type (SHAPE_T). */
export enum FP_SHAPE_TYPE {
	SEGMENT = 0,
	ARC = 1,
	CIRCLE = 2,
	RECT = 3,
	POLY = 4,
	BEZIER = 5,
	ELLIPSE = 6,
}

/**
 * One footprint-editor shape primitive. Mirrors KiCad's FP_SHAPE.
 */
export class FP_SHAPE {
	type: FP_SHAPE_TYPE = FP_SHAPE_TYPE.SEGMENT;
	layer = 'F.Cu';
	start = new Vec2();
	end = new Vec2();
	// For arc: the center and mid-point.
	center: Vec2 | null = null;
	mid: Vec2 | null = null;
	// For poly/bezier: the point list (poly) or control points (bezier).
	points: Vec2[] = [];
	width = 0.15;
	// Mirror / rotate (footprint-local transform hints).
	flipped = false;
	rotationDeg = 0;

	constructor(aType: FP_SHAPE_TYPE = FP_SHAPE_TYPE.SEGMENT) {
		this.type = aType;
	}

	TypeName(): string {
		switch (this.type) {
			case FP_SHAPE_TYPE.SEGMENT:
				return 'fp_line';
			case FP_SHAPE_TYPE.ARC:
				return 'fp_arc';
			case FP_SHAPE_TYPE.CIRCLE:
				return 'fp_circle';
			case FP_SHAPE_TYPE.RECT:
				return 'fp_rect';
			case FP_SHAPE_TYPE.POLY:
				return 'fp_poly';
			case FP_SHAPE_TYPE.BEZIER:
				return 'fp_bezier';
			case FP_SHAPE_TYPE.ELLIPSE:
				return 'fp_ellipse';
			default:
				return 'fp_line';
		}
	}

	/** The shape's effective geometry as a canonical SHAPE. */
	Shape(): SHAPE {
		switch (this.type) {
			case FP_SHAPE_TYPE.SEGMENT:
				return new SHAPE_SEGMENT(this.start, this.end, this.width);
			case FP_SHAPE_TYPE.CIRCLE:
				return new SHAPE_CIRCLE(this.start, this.start.sub(this.end).magnitude);
			case FP_SHAPE_TYPE.RECT: {
				const e = this.end;
				const s = this.start;
				return new SHAPE_RECT(new Vec2(Math.min(s.x, e.x), Math.min(s.y, e.y)),
					new Vec2(Math.abs(e.x - s.x), Math.abs(e.y - s.y)));
			}
			case FP_SHAPE_TYPE.POLY:
			case FP_SHAPE_TYPE.BEZIER: {
				const ps = new SHAPE_POLY_SET();
				if (this.type === FP_SHAPE_TYPE.BEZIER) {
					const bez = new BEZIER(this.points[0] ?? this.start, this.points[1] ?? this.start,
						this.points[2] ?? this.end, this.points[3] ?? this.end);
					ps.AddOutline(new SHAPE_LINE_CHAIN(bez.Sample(32), true));
				} else if (this.points.length >= 2) {
					ps.AddOutline(new SHAPE_LINE_CHAIN(this.points.map(p => p.copy()), true));
				}
				return ps;
			}
			default:
				return new SHAPE_SEGMENT(this.start, this.end, this.width);
		}
	}

	/** Bounding box of the primitive. */
	BBox(): BBox {
		return this.Shape().BBox();
	}

	/** Begin/end positions (geometry helpers for the connectivity/paint). */
	GetStart(): Vec2 {
		return this.start.copy();
	}

	GetEnd(): Vec2 {
		return this.end.copy();
	}
}
