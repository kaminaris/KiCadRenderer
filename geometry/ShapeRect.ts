/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_rect.h
 *   libs/kimath/src/geometry/shape_rect.cpp
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SHAPE } from './Shape';
import { SHAPE_TYPE } from './Shape';
import { fmtN } from './format';

/**
 * Represents a rectangle in 2D space.
 * Mirrors KiCad's SHAPE_RECT (libs/kimath/include/geometry/shape_rect.h).
 */
export class SHAPE_RECT extends SHAPE {
	private m_box: BBox;

	constructor(aPos = new Vec2(), aSize = new Vec2()) {
		super(SHAPE_TYPE.RECT);
		this.m_box = new BBox(aPos.x, aPos.y, aSize.x, aSize.y);
	}

	Type(): SHAPE_TYPE {
		return SHAPE_TYPE.RECT;
	}

	SetPosition(aPos: Vec2): void {
		const size = this.m_box;
		this.m_box = new BBox(aPos.x, aPos.y, size.w, size.h);
	}

	GetPosition(): Vec2 {
		return new Vec2(this.m_box.x, this.m_box.y);
	}

	SetSize(aSize: Vec2): void {
		const pos = this.m_box;
		this.m_box = new BBox(pos.x, pos.y, aSize.x, aSize.y);
	}

	GetSize(): Vec2 {
		return new Vec2(this.m_box.w, this.m_box.h);
	}

	SetW(aW: number): void {
		this.m_box.w = aW;
	}

	SetH(aH: number): void {
		this.m_box.h = aH;
	}

	GetW(): number {
		return this.m_box.w;
	}

	GetH(): number {
		return this.m_box.h;
	}

	GetEnd(): Vec2 {
		return new Vec2(this.m_box.x + this.m_box.w, this.m_box.y + this.m_box.h);
	}

	GetStart(): Vec2 {
		return this.GetPosition();
	}

	GetCentre(): Vec2 {
		return this.m_box.center;
	}

	BBox(aClearance = 0): BBox {
		if (aClearance === 0) {
			return this.m_box.copy();
		}
		return this.m_box.grow(aClearance);
	}

	protected MoveBy(aOffset: Vec2): void {
		this.m_box = new BBox(this.m_box.x + aOffset.x, this.m_box.y + aOffset.y, this.m_box.w, this.m_box.h);
	}

	Rotate(aAngle: number, aCenter: Vec2): void {
		// Rects can only be rotated by multiples of 90 degrees to stay rects.
		this.m_box = this.GetRotatedBox(aAngle, aCenter);
	}

	/** Returns the box rotated around aCenter (for 90° multiples). */
	private GetRotatedBox(aAngle: number, aCenter: Vec2): BBox {
		const cx = this.GetCentre();
		const c = Math.cos(aAngle);
		const s = Math.sin(aAngle);
		const dx = cx.x - aCenter.x;
		const dy = cx.y - aCenter.y;
		const newCx = aCenter.x + dx * c - dy * s;
		const newCy = aCenter.y + dx * s + dy * c;
		// Approximate: KiCad rotates the corners and refits. Use an axis-aligned fit.
		const corners = [
			this.m_box.x, this.m_box.y,
			this.m_box.x + this.m_box.w, this.m_box.y,
			this.m_box.x, this.m_box.y + this.m_box.h,
			this.m_box.x + this.m_box.w, this.m_box.y + this.m_box.h,
		];
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (let i = 0; i < corners.length; i += 2) {
			const px = corners[i]!;
			const py = corners[i + 1]!;
			const ddx = px - aCenter.x;
			const ddy = py - aCenter.y;
			const rx = aCenter.x + ddx * c - ddy * s;
			const ry = aCenter.y + ddx * s + ddy * c;
			minX = Math.min(minX, rx);
			minY = Math.min(minY, ry);
			maxX = Math.max(maxX, rx);
			maxY = Math.max(maxY, ry);
		}
		void newCx; void newCy;
		return BBox.fromPoints([new Vec2(minX, minY), new Vec2(maxX, maxY)]);
	}

	CollidePoint(aP: Vec2, aClearance: number): boolean {
		const x = aP.x, y = aP.y;
		return (
			x + aClearance >= this.m_box.x &&
			x - aClearance <= this.m_box.x + this.m_box.w &&
			y + aClearance >= this.m_box.y &&
			y - aClearance <= this.m_box.y + this.m_box.h
		);
	}

	Distance(aP: Vec2): number {
		const dx = Math.max(0, Math.max(this.m_box.x - aP.x, aP.x - (this.m_box.x + this.m_box.w)));
		const dy = Math.max(0, Math.max(this.m_box.y - aP.y, aP.y - (this.m_box.y + this.m_box.h)));
		return Math.sqrt(dx * dx + dy * dy);
	}

	/** S-expression text: `(rect (start x y) (end x y))`. */
	Format(): string {
		const end = this.GetEnd();
		return `(rect (start ${ fmtN( this.m_box.x ) } ${ fmtN( this.m_box.y ) })`
			+ ` (end ${ fmtN( end.x ) } ${ fmtN( end.y ) }))`;
	}
}
