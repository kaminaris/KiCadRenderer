/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_circle.h
 *   libs/kimath/src/geometry/shape_circle.cpp
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

/** Coerces a point that may arrive as a plain `{x,y}` into a Vec2 (the
 *  connectivity layer sometimes hands shapes plain point objects). */
export function toVec2(p: { x: number; y: number } | Vec2): Vec2 {
	if (p instanceof Vec2 || typeof (p as Vec2).sub === 'function') {
		return p as Vec2;
	}
	return new Vec2(p.x, p.y);
}

/**
 * Represents a circle (filled disc), not an outline.
 * Mirrors KiCad's SHAPE_CIRCLE (libs/kimath/include/geometry/shape_circle.h).
 */
export class SHAPE_CIRCLE extends SHAPE {
	private m_center: Vec2;
	private m_radius: number;

	constructor(aCenter = new Vec2(), aRadius = 0) {
		super(SHAPE_TYPE.CIRCLE);
		this.m_center = toVec2(aCenter as Vec2);
		this.m_radius = aRadius;
	}

	Type(): SHAPE_TYPE {
		return SHAPE_TYPE.CIRCLE;
	}

	SetCenter(aCenter: Vec2): void {
		this.m_center = aCenter;
	}

	SetRadius(aRadius: number): void {
		this.m_radius = aRadius;
	}

	GetCenter(): Vec2 {
		return this.m_center;
	}

	GetRadius(): number {
		return this.m_radius;
	}

	GetCentre(): Vec2 {
		return this.m_center;
	}

	GetEnd(): Vec2 {
		return this.m_center;
	}

	GetStart(): Vec2 {
		return this.m_center;
	}

	BBox(aClearance = 0): BBox {
		const r = this.m_radius + aClearance;
		return BBox.fromPoints([
			new Vec2(this.m_center.x - r, this.m_center.y - r),
			new Vec2(this.m_center.x + r, this.m_center.y + r),
		]);
	}

	protected MoveBy(aOffset: Vec2): void {
		this.m_center = this.m_center.add(aOffset);
	}

	Rotate(aAngle: number, aCenter: Vec2): void {
		const d = this.m_center.sub(aCenter);
		const c = Math.cos(aAngle);
		const s = Math.sin(aAngle);
		this.m_center = new Vec2(
			aCenter.x + d.x * c - d.y * s,
			aCenter.y + d.x * s + d.y * c
		);
	}

	CollidePoint(aP: Vec2, aClearance: number): boolean {
		return toVec2(aP).sub(this.m_center).magnitude <= this.m_radius + aClearance;
	}

	Distance(aP: Vec2): number {
		return Math.max(0, toVec2(aP).sub(this.m_center).magnitude - this.m_radius);
	}

	/** S-expression text: `(circle (center x y) (radius r))`. */
	Format(): string {
		return `(circle (center ${ fmtN( this.m_center.x ) } ${ fmtN( this.m_center.y ) })`
			+ ` (radius ${ fmtN( this.m_radius ) }))`;
	}
}
