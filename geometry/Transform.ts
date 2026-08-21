/*
 * Ported from KiCad source:
 *   common/transform.h
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * TRANSFORM — a 2x2 linear transform used by KiCad to compose board /
 * footprint mirror and rotation (x' = x1*x + y1*y, y' = x2*x + y2*y).
 * Used by the renderer's footprint/board transform composition.
 */

import { Vec2 } from '../math/Vec2';

export class TRANSFORM {
	// First row: x' = x1 * x + y1 * y
	x1 = 1;
	y1 = 0;
	// Second row: y' = x2 * x + y2 * y
	x2 = 0;
	y2 = 1;

	static readonly IDENTITY = new TRANSFORM(1, 0, 0, 1);

	constructor(aX1 = 1, aY1 = 0, aX2 = 0, aY2 = 1) {
		this.x1 = aX1;
		this.y1 = aY1;
		this.x2 = aX2;
		this.y2 = aY2;
	}

	/** Transforms a point by this linear transform. */
	TransformCoordinate(aPoint: Vec2): Vec2 {
		return new Vec2(
			this.x1 * aPoint.x + this.y1 * aPoint.y,
			this.x2 * aPoint.x + this.y2 * aPoint.y
		);
	}

	/** True if this is the identity transform. */
	IsIdentity(): boolean {
		return this.x1 === 1 && this.y1 === 0 && this.x2 === 0 && this.y2 === 1;
	}

	/** The determinant. If != 0 the transform is invertible. */
	GetDeterminant(): number {
		return this.x1 * this.y2 - this.x2 * this.y1;
	}

	/** Composes this transform with `aTransform` (this = this * aTransform). */
	Multiply(aTransform: TRANSFORM): TRANSFORM {
		return new TRANSFORM(
			this.x1 * aTransform.x1 + this.y1 * aTransform.x2,
			this.x1 * aTransform.y1 + this.y1 * aTransform.y2,
			this.x2 * aTransform.x1 + this.y2 * aTransform.x2,
			this.x2 * aTransform.y1 + this.y2 * aTransform.y2
		);
	}

	/** Composes in place: this = this * aTransform. */
	operatorMultiply(aTransform: TRANSFORM): TRANSFORM {
		const r = this.Multiply(aTransform);
		this.x1 = r.x1;
		this.y1 = r.y1;
		this.x2 = r.x2;
		this.y2 = r.y2;
		return this;
	}

	/** Composes in reverse: this = aTransform * this. */
	PreMultiply(aTransform: TRANSFORM): TRANSFORM {
		return aTransform.Multiply(this);
	}

	/** The inverse transform (undefined if singular). */
	Inverse(): TRANSFORM {
		const ovd = this.GetDeterminant();
		if (Math.abs(ovd) < 1e-12) {
			return TRANSFORM.IDENTITY;
		}
		return new TRANSFORM(
			this.y2 / ovd,
			-this.y1 / ovd,
			-this.x2 / ovd,
			this.x1 / ovd
		);
	}

	/** Adds a mirror about the Y axis (flip X), composing it in. */
	AddMirrorY(aMirrorPoint = 0): void {
		const m = new TRANSFORM(-1, 0, 0, 1);
		this.operatorMultiply(m);
		void aMirrorPoint;
	}

	/** Adds a mirror about the X axis (flip Y). */
	AddMirrorX(aMirrorPoint = 0): void {
		const m = new TRANSFORM(1, 0, 0, -1);
		this.operatorMultiply(m);
		void aMirrorPoint;
	}
}
