/*
 * Ported from KiCad's BOX2I / BOX2D (libs/kimath/include/math/box2.h).
 *
 * This codebase works in mm (doubles), so this is a BOX2I-named adapter over
 * the existing `BBox` primitive, exposing KiCad's BOX2 method names so ported
 * code reads 1:1. Mirrors KiCad's BOX2I (which is BOX2<T,anIntType>).
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';

/**
 * A KiCad-named bounding box (BOX2I-equivalent) wrapping BBox.
 */
export class BOX2 {
	protected b: BBox;

	constructor(aBBox?: BBox) {
		this.b = aBBox ? aBBox.copy() : new BBox();
	}

	Copy(): BOX2 {
		return new BOX2(this.b);
	}

	SetOrigin(aPos: Vec2): void {
		this.b.x = aPos.x;
		this.b.y = aPos.y;
	}

	SetPosition(aPos: Vec2): void {
		this.b.x = aPos.x;
		this.b.y = aPos.y;
	}

	GetPosition(): Vec2 {
		return new Vec2(this.b.x, this.b.y);
	}

	GetOrigin(): Vec2 {
		return new Vec2(this.b.x, this.b.y);
	}

	SetSize(aSize: Vec2): void {
		this.b.w = aSize.x;
		this.b.h = aSize.y;
	}

	GetSize(): Vec2 {
		return new Vec2(this.b.w, this.b.h);
	}

	GetCenter(): Vec2 {
		return this.b.center;
	}

	GetLeft(): number {
		return this.b.x;
	}

	GetRight(): number {
		return this.b.x2;
	}

	GetTop(): number {
		return this.b.y;
	}

	GetBottom(): number {
		return this.b.y2;
	}

	IsIntersects(aOther: BOX2): boolean {
		return boxIntersectsBox(this.b, aOther.b);
	}

	Intersects(aOther: BOX2): boolean {
		return this.IsIntersects(aOther);
	}

	Contains(aPoint: Vec2): boolean {
		return (
			aPoint.x >= this.b.x &&
			aPoint.x <= this.b.x2 &&
			aPoint.y >= this.b.y &&
			aPoint.y <= this.b.y2
		);
	}

	ContainsBox(aOther: BOX2): boolean {
		return (
			this.b.x <= aOther.b.x &&
			this.b.x2 >= aOther.b.x2 &&
			this.b.y <= aOther.b.y &&
			this.b.y2 >= aOther.b.y2
		);
	}

	Normalize(): void {
		if (this.b.w < 0) {
			this.b.x += this.b.w;
			this.b.w *= -1;
		}
		if (this.b.h < 0) {
			this.b.y += this.b.h;
			this.b.h *= -1;
		}
	}

	Merge(aOther: BOX2): BOX2 {
		const out = new BOX2(this.b);
		out.MergeBox(aOther);
		return out;
	}

	MergeBox(aOther: BOX2): void {
		if (!aOther.IsSizePositive()) {
			return;
		}
		const minX = Math.min(this.b.x, aOther.b.x);
		const minY = Math.min(this.b.y, aOther.b.y);
		const maxX = Math.max(this.b.x2, aOther.b.x2);
		const maxY = Math.max(this.b.y2, aOther.b.y2);
		this.b = BBox.fromPoints([new Vec2(minX, minY), new Vec2(maxX, maxY)]);
	}

	IsEmpty(): boolean {
		return this.b.w <= 0 || this.b.h <= 0;
	}

	GetArea(): number {
		return this.b.w * this.b.h;
	}

	IsSizePositive(): boolean {
		return this.b.w > 0 && this.b.h > 0;
	}

	/** The underlying BBox. */
	BBox(): BBox {
		return this.b.copy();
	}
}

function boxIntersectsBox(a: BBox, b: BBox): boolean {
	return a.x <= b.x2 && b.x <= a.x2 && a.y <= b.y2 && b.y <= a.y2;
}
