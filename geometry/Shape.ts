/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape.h
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { Matrix3 } from '../math/Matrix3';

// SHAPE_COLLISION is registered lazily by ShapeCollision.ts (see
// setShapeCollisionCtor) to avoid a circular module-init dependency:
// Shape -> ShapeCollision -> ShapePolySet -> (extends) Shape.
let shapeCollisionCtor: ((clearance: number, accuracy?: number, needLocation?: boolean) => {
	Collide(a: SHAPE, b: SHAPE): { intersecting: boolean; location: Vec2 };
}) | null = null;

/** Internal — called once by ShapeCollision.ts after it is fully defined. */
export function setShapeCollisionCtor(
	ctor: (clearance: number, accuracy?: number, needLocation?: boolean) => {
		Collide(a: SHAPE, b: SHAPE): { intersecting: boolean; location: Vec2 };
	}
): void {
	shapeCollisionCtor = ctor;
}

/** Mirrors SHAPE::{GetType() returns} / SHAPE::Type. */
export enum SHAPE_TYPE {
	SEGMENT = 0,
	RECT,
	CIRCLE,
	POLY_SET,
	ARC,
	COMPOUND,
	TRIANGLE,
}

/**
 * Shape outline around a shape.
 * Mirrors SHAPE_LINE_CHAIN::FORMAT.
 */
export type SHAPE_FORMAT = 'DEFAULT' | 'POSTSCRIPT';

/**
 * Base class for all 2D shapes.
 * Mirrors KiCad's SHAPE (libs/kimath/include/geometry/shape.h).
 *
 * This is the canonical geometric type the rest of the renderer should use
 * for hit-testing and collision. Positions are in mm (matching the rest of
 * this codebase).
 */
export abstract class SHAPE {
	type: SHAPE_TYPE;

	constructor(aType: SHAPE_TYPE) {
		this.type = aType;
	}

	/** Returns the type of the shape. */
	Type(): SHAPE_TYPE {
		return this.type;
	}

	/** Returns the bounding box (in "world space") of the shape. */
	abstract BBox(aClearance?: number): BBox;

	/** Returns true if the shape is "valid" (has non-degenerate geometry). */
	Valid(): boolean {
		return true;
	}

	/** Returns the center of the shape. */
	abstract GetCentre(): Vec2;

	/** Returns the point that, on a line, would be the "end point". */
	abstract GetEnd(): Vec2;

	/** Returns the point that, on a line, would be the "start point". */
	abstract GetStart(): Vec2;

	/** Returns true if this shape is a "solid" shape (always true for most). */
	IsSolid(): boolean {
		return true;
	}

	/**
	 * Move the shape by the given offset.
	 * Mirrors KiCad's SHAPE::Move.
	 */
	Move(aOffset: Vec2): void {
		this.MoveBy(aOffset);
	}

	/** Move the shape by the given offset (internal, per-shape). */
	protected abstract MoveBy(aOffset: Vec2): void;

	/**
	 * Mirror the shape along the horizontal (X) axis at aMirrorPoint.
	 * Mirrors KiCad's SHAPE::Mirror horizontal.
	 */
	MirrorHorizontal(aMirrorPoint: number): void {
		const s = this.GetStart();
		const sl = new Vec2(s.x, -s.y + 2 * aMirrorPoint);
		const e = this.GetEnd();
		const el = new Vec2(e.x, -e.y + 2 * aMirrorPoint);
		const delta = el.sub(sl);
		this.MoveBy(delta);
	}

	/**
	 * Mirror the shape along the vertical (Y) axis at aMirrorPoint.
	 * Mirrors KiCad's SHAPE::Mirror vertical.
	 */
	MirrorVertical(aMirrorPoint: number): void {
		const s = this.GetStart();
		const sl = s;
		const e = this.GetEnd();
		const delta = new Vec2(-(e.x - s.x), 0);
		this.MoveBy(delta);
		// Kicad mirrors about the X value, so the horizontal position shifts
		// by 2*(aMirrorPoint - s.x)
		this.MoveBy(new Vec2(2 * (aMirrorPoint - sl.x), 0));
	}

	/**
	 * Rotate the shape by aAngle around aCenter.
	 * Mirrors KiCad's SHAPE::Rotate.
	 */
	abstract Rotate(aAngle: number, aCenter: Vec2): void;

	/**
	 * Returns true if the point is inside the shape.
	 */
	Contains(aP: Vec2, aClearance?: number): boolean {
		return this.CollidePoint(aP, aClearance ?? 0);
	}

	/** Collide a point. Mirrors SHAPE::Collide(VECTOR2I). */
	abstract CollidePoint(aP: Vec2, aClearance: number): boolean;

	/**
	 * Collide another shape within a clearance.
	 * Mirrors KiCad's SHAPE::Collide(other, clearance) — routed through the
	 * SHAPE_COLLISION engine (registered lazily to avoid a module cycle).
	 */
	Collide(aOther: SHAPE, aClearance = 0): boolean {
		if (!shapeCollisionCtor) {
			// Not yet registered (module not loaded) — fall back to a
			// conservative distance test.
			return this.Distance(aOther.GetCentre()) <= aClearance;
		}
		const sc = shapeCollisionCtor(aClearance);
		return sc.Collide(this, aOther).intersecting;
	}

	/**
	 * Returns the closest distance from the given point to the shape.
	 * Mirrors SHAPE::Distance(VECTOR2I).
	 */
	abstract Distance(aP: Vec2): number;
}
