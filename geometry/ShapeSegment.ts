/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_segment.h
 *   libs/kimath/src/geometry/shape_segment.cpp
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SHAPE } from './Shape';
import { SHAPE_TYPE } from './Shape';
import { pointToSegmentDistance, closestPointOnSegment } from './ShapeLineChain';
import { fmtN } from './format';

/**
 * Represents a line segment with a width (a 2D capsule).
 * Mirrors KiCad's SHAPE_SEGMENT (libs/kimath/include/geometry/shape_segment.h).
 */
export class SHAPE_SEGMENT extends SHAPE {
	private m_seg: { A: Vec2; B: Vec2 };
	private m_width: number;

	constructor(aA = new Vec2(), aB = new Vec2(), aWidth = 0) {
		super(SHAPE_TYPE.SEGMENT);
		this.m_seg = { A: aA, B: aB };
		this.m_width = aWidth;
	}

	Type(): SHAPE_TYPE {
		return SHAPE_TYPE.SEGMENT;
	}

	SetWidth(aWidth: number): void {
		this.m_width = aWidth;
	}

	SetSeg(aA: Vec2, aB: Vec2): void {
		this.m_seg = { A: aA, B: aB };
	}

	GetWidth(): number {
		return this.m_width;
	}

	GetSeg(): { A: Vec2; B: Vec2 } {
		return this.m_seg;
	}

	GetPointA(): Vec2 {
		return this.m_seg.A;
	}

	GetPointB(): Vec2 {
		return this.m_seg.B;
	}

	BBox(aClearance = 0): BBox {
		const r = this.m_width / 2 + aClearance;
		const minX = Math.min(this.m_seg.A.x, this.m_seg.B.x) - r;
		const minY = Math.min(this.m_seg.A.y, this.m_seg.B.y) - r;
		const maxX = Math.max(this.m_seg.A.x, this.m_seg.B.x) + r;
		const maxY = Math.max(this.m_seg.A.y, this.m_seg.B.y) + r;
		return BBox.fromPoints([new Vec2(minX, minY), new Vec2(maxX, maxY)]);
	}

	GetCentre(): Vec2 {
		return this.m_seg.A.add(this.m_seg.B).multiply(0.5);
	}

	GetEnd(): Vec2 {
		return this.m_seg.B;
	}

	GetStart(): Vec2 {
		return this.m_seg.A;
	}

	protected MoveBy(aOffset: Vec2): void {
		this.m_seg = { A: this.m_seg.A.add(aOffset), B: this.m_seg.B.add(aOffset) };
	}

	Rotate(aAngle: number, aCenter: Vec2): void {
		this.m_seg = {
			A: rotatePoint(this.m_seg.A, aCenter, aAngle),
			B: rotatePoint(this.m_seg.B, aCenter, aAngle),
		};
	}

	GetLength(): number {
		return this.m_seg.A.sub(this.m_seg.B).magnitude;
	}

	CollidePoint(aP: Vec2, aClearance: number): boolean {
		return pointToSegmentDistance(aP, this.m_seg.A, this.m_seg.B) <= this.m_width / 2 + aClearance;
	}

	Distance(aP: Vec2): number {
		return Math.max(0, pointToSegmentDistance(aP, this.m_seg.A, this.m_seg.B) - this.m_width / 2);
	}

	NearestPoint(aP: Vec2): Vec2 {
		return closestPointOnSegment(aP, this.m_seg.A, this.m_seg.B);
	}

	/** S-expression text, mirroring KiCad's `(segment (start x y) (end x y) (width w))`. */
	Format(): string {
		return `(segment (start ${ fmtN( this.m_seg.A.x ) } ${ fmtN( this.m_seg.A.y ) })`
			+ ` (end ${ fmtN( this.m_seg.B.x ) } ${ fmtN( this.m_seg.B.y ) })`
			+ ` (width ${ fmtN( this.m_width ) }))`;
	}
}

export function rotatePoint(p: Vec2, center: Vec2, angle: number): Vec2 {
	const d = p.sub(center);
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return new Vec2(center.x + d.x * c - d.y * s, center.y + d.x * s + d.y * c);
}
