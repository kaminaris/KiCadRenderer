/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_compound.h
 *   libs/kimath/src/geometry/shape_compound.cpp
 *
 * Copyright (C) 2020 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A SHAPE that is the logical union of a set of child SHAPEs — used for a
 * pad's effective shape (a pad can be made of several primitive shapes), for
 * drill/flashing overlays, etc. Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SHAPE } from './Shape';
import { SHAPE_TYPE } from './Shape';

/**
 * A shape that is the union of several sub-shapes.
 * Mirrors KiCad's SHAPE_COMPOUND.
 */
export class SHAPE_COMPOUND extends SHAPE {
	private m_shapes: SHAPE[] = [];
	private m_bbox: BBox | null = null;
	private m_bboxValid = false;

	constructor(aShapes?: SHAPE[]) {
		super(SHAPE_TYPE.COMPOUND);
		if (aShapes) {
			this.m_shapes = [...aShapes];
		}
	}

	Type(): SHAPE_TYPE {
		return SHAPE_TYPE.COMPOUND;
	}

	AddShape(aShape: SHAPE): void {
		this.m_shapes.push(aShape);
		this.m_bboxValid = false;
	}

	GetSubshapes(): SHAPE[] {
		return this.m_shapes;
	}

	Shapes(): SHAPE[] {
		return this.m_shapes;
	}

	ChildrenCount(): number {
		return this.m_shapes.length;
	}

	BBox(aClearance = 0): BBox {
		if (!this.m_bboxValid) {
			this.recomputeBBox();
		}
		if (aClearance === 0) {
			return (this.m_bbox ?? new BBox()).copy();
		}
		return (this.m_bbox ?? new BBox()).grow(aClearance);
	}

	private recomputeBBox(): void {
		if (this.m_shapes.length === 0) {
			this.m_bbox = new BBox();
			this.m_bboxValid = true;
			return;
		}
		const boxes = this.m_shapes.map(s => s.BBox());
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const b of boxes) {
			minX = Math.min(minX, b.x);
			minY = Math.min(minY, b.y);
			maxX = Math.max(maxX, b.x2);
			maxY = Math.max(maxY, b.y2);
		}
		this.m_bbox = BBox.fromPoints([new Vec2(minX, minY), new Vec2(maxX, maxY)]);
		this.m_bboxValid = true;
	}

	GetCentre(): Vec2 {
		return this.BBox().center;
	}

	GetStart(): Vec2 {
		return this.m_shapes.length ? this.m_shapes[0]!.GetStart() : new Vec2();
	}

	GetEnd(): Vec2 {
		return this.m_shapes.length ? this.m_shapes[0]!.GetEnd() : new Vec2();
	}

	/** True if the point is inside any member shape (a union). */
	Contains(aPoint: Vec2, aClearance = 0): boolean {
		for (const s of this.m_shapes) {
			if (s.Contains(aPoint, aClearance)) {
				return true;
			}
		}
		return false;
	}

	/** True if the point collides (within clearance) with any member. */
	CollidePoint(aPoint: Vec2, aClearance: number): boolean {
		return this.Contains(aPoint, aClearance);
	}

	/** Distance to the closest member shape. */
	Distance(aPoint: Vec2): number {
		let best = Infinity;
		for (const s of this.m_shapes) {
			best = Math.min(best, s.Distance(aPoint));
		}
		return best;
	}

	protected MoveBy(aOffset: Vec2): void {
		for (const s of this.m_shapes) {
			s.Move(aOffset);
		}
		this.m_bboxValid = false;
	}

	Rotate(aAngle: number, aCenter: Vec2): void {
		for (const s of this.m_shapes) {
			s.Rotate(aAngle, aCenter);
		}
		this.m_bboxValid = false;
	}
}
