/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_arc.h
 *   libs/kimath/src/geometry/shape_arc.cpp
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
 *  connectivity layer sometimes passes plain point objects). */
function toPoint(p: Vec2 | { x: number; y: number }): Vec2 {
	if (p instanceof Vec2 || typeof (p as Vec2).sub === 'function') {
		return p as Vec2;
	}
	return new Vec2(p.x, p.y);
}

/**
 * Represents an arc.  Holds the start and end points, the center, and whether
 * the arc is clockwise.
 *
 * KiCad's SHAPE_ARC stores m_start, m_end, m_center and computes everything
 * from those three; the midpoint flag and rotation direction are inferred.
 * Mirrors KiCad's SHAPE_ARC (shape_arc.h/.cpp).
 */
export class SHAPE_ARC extends SHAPE {
	protected m_start: Vec2;
	protected m_end: Vec2;
	protected m_center: Vec2;
	// Stores whether the arc is clockwise. Kept for parity.
	protected m_clockwise = false;
	// Set when the arc was created from three points at construct time.
	protected m_midPoint: Vec2;
	protected m_arcPointsDirty = true;

	/** Computes the circumcenter of the three given points. */
	static CircleCenterFrom3Pt(aStart: Vec2, aMid: Vec2, aEnd: Vec2): Vec2 {		const x1 = aStart.x, y1 = aStart.y;
		const x2 = aMid.x, y2 = aMid.y;
		const x3 = aEnd.x, y3 = aEnd.y;

		const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
		if (Math.abs(d) < 1e-12) {
			// Colinear points — degenerate. Use the midpoint.
			return aMid;
		}

		const x1y1 = x1 * x1 + y1 * y1;
		const x2y2 = x2 * x2 + y2 * y2;
		const x3y3 = x3 * x3 + y3 * y3;

		const cx = (x1y1 * (y2 - y3) + x2y2 * (y3 - y1) + x3y3 * (y1 - y2)) / d;
		const cy = (x1y1 * (x3 - x2) + x2y2 * (x1 - x3) + x3y3 * (x2 - x1)) / d;

		return new Vec2(cx, cy);
	}

	/**
	 * Constructs an arc from a chord (start..end) and the rotation angle
	 * (degrees) applied to the chord direction. Mirrors
	 * SHAPE_ARC::FromTwoPointsAndAngle (aRotation of the chord produces a
	 * 2*aRotation arc).
	 */
	static FromTwoPointsAndAngle(aStart: Vec2, aEnd: Vec2, aRotationDeg: number): SHAPE_ARC {
		const chord = aEnd.sub(aStart);
		const len = chord.magnitude;
		if (len < 1e-12) {
			return new SHAPE_ARC(aStart, aStart, aStart);
		}
		const rot = (aRotationDeg * Math.PI) / 180;
		const half = Math.abs(rot) < 1e-9 ? Math.PI / 2 : rot; // avoid div by 0
		const sign = aRotationDeg < 0 ? -1 : 1;

		// For a chord length L and arc subtending angle 2*rot, the radius is
		// R = L / (2 sin(rot)) and the center sits at distance R*cos(rot) from
		// the chord midpoint along the perpendicular.
		const r = len / (2 * Math.sin(Math.abs(half)));
		const centerDist = r * Math.cos(Math.abs(half));
		const aChord = Math.atan2(chord.y, chord.x);
		const mid = aStart.add(aEnd).multiply(0.5);
		const center = new Vec2(
			mid.x - Math.sin(aChord) * centerDist * sign,
			mid.y + Math.cos(aChord) * centerDist * sign
		);
		// The arc midpoint is on the chord bisector toward the center: sagitta
		// = r - centerDist.
		const sagitta = r - centerDist;
		const arcMid = new Vec2(
			mid.x - Math.sin(aChord) * sagitta * sign,
			mid.y + Math.cos(aChord) * sagitta * sign
		);
		return new SHAPE_ARC(aStart, arcMid, aEnd);
	}

	/**
	 * Constructs an arc from start, end and a center, deriving the midpoint on
	 * the circle between them (the shorter way). Mirrors
	 * SHAPE_ARC( aStart, aEnd, aCenter ) used by track/PCB_ARC handling.
	 */
	static FromStartEndAndCenter(aStart: Vec2, aEnd: Vec2, aCenter: Vec2): SHAPE_ARC {
		const a0 = Math.atan2(aStart.y - aCenter.y, aStart.x - aCenter.x);
		const a1 = Math.atan2(aEnd.y - aCenter.y, aEnd.x - aCenter.x);
		let sweep = a1 - a0;
		while (sweep > Math.PI) sweep -= 2 * Math.PI;
		while (sweep <= -Math.PI) sweep += 2 * Math.PI;
		const r = aStart.sub(aCenter).magnitude;
		const midAng = a0 + sweep / 2;
		const mid = new Vec2(aCenter.x + r * Math.cos(midAng), aCenter.y + r * Math.sin(midAng));
		return new SHAPE_ARC(aStart, mid, aEnd);
	}

	/**
	 * Construct from center, start, mid-angle (degrees), giving end.
	 * Mirrors SHAPE_ARC( aCenter, aStart, aMidpointAngle ).
	 */
	constructor(aCenter: Vec2, aStart: Vec2, aMidpointAngle: number, aWidth?: number);
	/**
	 * Construct from start, mid, end (three points).
	 * Mirrors SHAPE_ARC( aStart, aMid, aEnd, aWidth ).
	 */
	constructor(aCenterOrStart: Vec2, aStartOrMid: Vec2, aEndOrAngle: Vec2 | number, aWidth?: number);
	constructor(aCenterOrStart: Vec2, aStartOrMid: Vec2, aEndOrAngle: Vec2 | number, aWidth = 0) {
		super(SHAPE_TYPE.ARC);

		if (typeof aEndOrAngle === 'number') {
			// (center, start, midpointAngle)
			const centerAny = aCenterOrStart as { x: number; y: number } | Vec2;
			const center = toPoint(centerAny);
			const start = toPoint(aStartOrMid as Vec2);
			const midAngle = aEndOrAngle;
			this.m_center = center;
			this.m_start = start;
			const radius = start.sub(center).magnitude;
			// The midpoint is at the given angle from the center.
			const midAngRad = (midAngle * Math.PI) / 180;
			this.m_midPoint = new Vec2(
				center.x + radius * Math.cos(midAngRad),
				center.y + radius * Math.sin(midAngRad)
			);
			this.m_end = this.CalcEndFromCenter(midAngle);
			this.setCW();
			this.m_width = aWidth;
		} else {
			// (start, mid, end)
			const start = toPoint(aCenterOrStart);
			const mid = toPoint(aStartOrMid);
			const end = toPoint(aEndOrAngle as Vec2);
			this.m_start = start;
			this.m_midPoint = mid;
			this.m_end = end;
			this.m_center = SHAPE_ARC.CircleCenterFrom3Pt(start, mid, end);
			this.setCW();
			this.m_width = aWidth;
		}
		this.m_arcPointsDirty = true;
	}

	protected m_width = 0;

	private setCW(): void {
		// Compute orientation: cross product of (mid-start) x (end-mid).
		const v1 = this.m_midPoint.sub(this.m_start);
		const v2 = this.m_end.sub(this.m_midPoint);
		const cross = v1.x * v2.y - v1.y * v2.x;
		// If cross < 0 the arc is clockwise in KiCad's (Y-down) coordinates;
		// keep parity by storing the raw sign.
		this.m_clockwise = cross < 0;
	}

	private CalcEndFromCenter(_midAngleDeg: number): Vec2 {
		// Not needed for typical usage; approximate by mirroring start about the
		// line through center & midpoint.
		const toMid = this.m_midPoint.sub(this.m_center).normalize();
		const toStart = this.m_start.sub(this.m_center);
		// Reflect start across the center->mid line.
		const dot = toStart.x * toMid.x + toStart.y * toMid.y;
		const proj = new Vec2(toMid.x * dot, toMid.y * dot);
		const refl = toStart.multiply(2).sub(proj);
		return this.m_center.add(refl);
	}

	Type(): SHAPE_TYPE {
		return SHAPE_TYPE.ARC;
	}

	GetP0(): Vec2 {
		return this.m_start;
	}

	GetP1(): Vec2 {
		return this.m_end;
	}

	GetP2(): Vec2 {
		return this.m_midPoint;
	}

	GetCenter(): Vec2 {
		return this.m_center;
	}

	GetCentre(): Vec2 {
		return this.m_center;
	}

	GetStart(): Vec2 {
		return this.m_start;
	}

	GetEnd(): Vec2 {
		return this.m_end;
	}

	GetMidPoint(): Vec2 {
		return this.m_midPoint;
	}

	GetRadius(): number {
		return this.m_start.sub(this.m_center).magnitude;
	}

	IsClockwise(): boolean {
		return this.m_clockwise;
	}

	SetWidth(aWidth: number): void {
		this.m_width = aWidth;
	}

	GetWidth(): number {
		return this.m_width;
	}

	BBox(aClearance = 0): BBox {
		return this.recomputeBBox().grow(aClearance, aClearance);
	}

	private recomputeBBox(): BBox {
		const r = this.GetRadius();
		let minX = Math.min(this.m_start.x, this.m_end.x);
		let maxX = Math.max(this.m_start.x, this.m_end.x);
		let minY = Math.min(this.m_start.y, this.m_end.y);
		let maxY = Math.max(this.m_start.y, this.m_end.y);

		// Include extremes where the arc passes through the cardinal axes,
		// limited by start/end angles.
		const aStart = Math.atan2(this.m_start.y - this.m_center.y, this.m_start.x - this.m_center.x);
		const aEnd = Math.atan2(this.m_end.y - this.m_center.y, this.m_end.x - this.m_center.x);
		const extendX = (angle: number): boolean => {
			const x = this.m_center.x + r * Math.cos(angle);
			const y = this.m_center.y + r * Math.sin(angle);
			return this.ContainsPointOnArc(new Vec2(x, y));
		};
		for (const ang of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
			if (extendX(ang)) {
				const x = this.m_center.x + r * Math.cos(ang);
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
			}
			if (extendX(ang)) {
				const y = this.m_center.y + r * Math.sin(ang);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}
		void aStart; void aEnd;
		return BBox.fromPoints([new Vec2(minX, minY), new Vec2(maxX, maxY)]);
	}

	/** True if the (unit) angle lies on the arc between start and end. */
	private ContainsPointOnArc(p: Vec2): boolean {
		const aP = Math.atan2(p.y - this.m_center.y, p.x - this.m_center.x);
		const aStart = Math.atan2(this.m_start.y - this.m_center.y, this.m_start.x - this.m_center.x);
		const aEnd = Math.atan2(this.m_end.y - this.m_center.y, this.m_end.x - this.m_center.x);
		// Normalize the arc span.
		let start = aStart;
		let end = aEnd;
		let a = aP;
		// Ensure the sweep is < 2π.
		const sweep = normalizeAngle(end - start);
		// KiCad sweeps clockwise from start to end if clockwise, else CCW.
		if (!this.m_clockwise) {
			// Sweep is (end - start) normalized to [0, 2π).
			const aa = normalizeAngle(a - start);
			return aa <= sweep + 1e-9;
		}
		// clockwise: sweep the other way
		const ccw = normalizeAngle(end - start);
		const aa = normalizeAngle(a - start);
		// clockwise sweep length = 2π - ccw
		return aa >= ccw - 1e-9;
	}

	CollidePoint(aP: Vec2, aClearance: number): boolean {
		return this.Distance(aP) <= aClearance;
	}

	Distance(aP: Vec2): number {
		const r = this.GetRadius();
		const ang = Math.atan2(aP.y - this.m_center.y, aP.x - this.m_center.x);
		const radial = aP.sub(this.m_center).magnitude;
		// Project onto the arc circle.
		const proj = new Vec2(this.m_center.x + r * Math.cos(ang), this.m_center.y + r * Math.sin(ang));
		const radialDist = Math.abs(radial - r);
		if (this.ContainsPointOnArc(proj)) {
			return Math.max(0, radialDist - this.m_width / 2);
		}
		// Otherwise distance to nearest endpoint.
		return Math.max(0, Math.min(aP.sub(this.m_start).magnitude, aP.sub(this.m_end).magnitude) - this.m_width / 2);
	}

	/** The angle of the start point around the center (radians). */
	GetArcAngleStart(): number {
		return Math.atan2(this.m_start.y - this.m_center.y, this.m_start.x - this.m_center.x);
	}

	/** The angle of the end point around the center (radians). */
	GetArcAngleEnd(): number {
		return Math.atan2(this.m_end.y - this.m_center.y, this.m_end.x - this.m_center.x);
	}

	/** Alias for GetArcAngleStart (KiCad also names it GetAngleStart). */
	GetAngleStart(): number {
		return this.GetArcAngleStart();
	}

	/** Alias for GetArcAngleEnd. */
	GetAngleEnd(): number {
		return this.GetArcAngleEnd();
	}

	/** The mid point of the arc (KiCad name). */
	GetArcMid(): Vec2 {
		return this.GetMidPoint();
	}

	/**
	 * Reconstructs the arc from a start angle (radians, around the current
	 * center and radius), sweeping to `aEndAngle`, keeping the given start
	 * point. Mirrors SHAPE_ARC::SetStartEndAngle (best-effort).
	 */
	SetStartEndAngle(aStartAngle: number, aEndAngle: number): void {
		// Recompute end from the same radius at the end angle, and mid at the
		// bisector.
		const r = this.GetRadius();
		this.m_end = new Vec2(
			this.m_center.x + r * Math.cos(aEndAngle),
			this.m_center.y + r * Math.sin(aEndAngle)
		);
		// Determine sweep direction from the (possibly new) mid.
		const midAng = (aStartAngle + aEndAngle) / 2;
		this.m_midPoint = new Vec2(
			this.m_center.x + r * Math.cos(midAng),
			this.m_center.y + r * Math.sin(midAng)
		);
		this.setCW();
	}

	protected MoveBy(aOffset: Vec2): void {
		this.m_start = this.m_start.add(aOffset);
		this.m_end = this.m_end.add(aOffset);
		this.m_center = this.m_center.add(aOffset);
		this.m_midPoint = this.m_midPoint.add(aOffset);
	}

	/** S-expression text: `(arc (start x y) (mid x y) (end x y) (width w))`. */
	Format(): string {
		return `(arc (start ${ fmtN( this.m_start.x ) } ${ fmtN( this.m_start.y ) })`
			+ ` (mid ${ fmtN( this.m_midPoint.x ) } ${ fmtN( this.m_midPoint.y ) })`
			+ ` (end ${ fmtN( this.m_end.x ) } ${ fmtN( this.m_end.y ) })`
			+ ` (width ${ fmtN( this.m_width ) }))`;
	}

	Rotate(aAngle: number, aCenter: Vec2): void {
		const rot = (p: Vec2) => {
			const d = p.sub(aCenter);
			const c = Math.cos(aAngle);
			const s = Math.sin(aAngle);
			return new Vec2(aCenter.x + d.x * c - d.y * s, aCenter.y + d.x * s + d.y * c);
		};
		this.m_start = rot(this.m_start);
		this.m_end = rot(this.m_end);
		this.m_center = rot(this.m_center);
		this.m_midPoint = rot(this.m_midPoint);
	}
}

function normalizeAngle(a: number): number {
	let r = a % (2 * Math.PI);
	if (r < 0) {
		r += 2 * Math.PI;
	}
	return r;
}
