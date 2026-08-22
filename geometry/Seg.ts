/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/seg.h
 *   libs/kimath/src/geometry/seg.cpp
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A 2D line segment with exact distance / intersection / collinearity
 * helpers. Mirrors KiCad's SEG (used everywhere a track/edge segment is
 * reasoned about). Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { Angle } from '../math/Angle';

const EPSILON_MM = 1e-9;

/**
 * A 2D line segment from A to B. Mirrors KiCad's SEG.
 */
export class SEG {
	A: Vec2;
	B: Vec2;

	constructor(aA?: Vec2, aB?: Vec2) {
		this.A = aA ? aA.copy() : new Vec2();
		this.B = aB ? aB.copy() : new Vec2();
	}

	/** Length squared (avoid sqrt). */
	SquaredLength(): number {
		return this.A.sub(this.B).squaredMagnitude;
	}

	/** Euclidean length. */
	Length(): number {
		return this.A.sub(this.B).magnitude;
	}

	/** The segment as a vector B-A. */
	AsVector(): Vec2 {
		return this.B.sub(this.A);
	}

	/** The reverse segment (B..A). */
	Reversed(): SEG {
		return new SEG(this.B, this.A);
	}

	/** Cross product of the two endpoint vectors (2D z-component). */
	Cross(): number {
		return this.A.x * this.B.y - this.A.y * this.B.x;
	}

	/** Cross product of the two endpoint vectors (2D z-component). */
	CrossDot(): number {
		return this.Cross();
	}

	/** Dot product of the two endpoint vectors. */
	Dot(aSeg: SEG): number;
	Dot(aVec: Vec2): number;
	Dot(aOther: SEG | Vec2): number {
		if (aOther instanceof SEG) {
			return this.A.x * aOther.A.x + this.A.y * aOther.A.y;
		}
		return this.A.x * aOther.x + this.A.y * aOther.y;
	}

	IsDiamondShape(aThreshold = 0): boolean {
		void aThreshold;
		return false;
	}

	/** Midpoint of the segment. */
	Midpoint(): Vec2 {
		return this.A.add(this.B).multiply(0.5);
	}

	/** The line angle of the segment (radians). */
	Angle(): Angle {
		return this.B.sub(this.A).angle;
	}

	/** Rotation of the segment as a kicad angle. */
	KicadAngle(): Angle {
		return this.B.sub(this.A).kicadAngle;
	}

	/** Move both endpoints by a translation vector. */
	Translate(aVector: Vec2): SEG {
		return new SEG(this.A.add(aVector), this.B.add(aVector));
	}

	/** Rotate both endpoints around the origin by `aAngle`. */
	RotatedCopy(aAngle: Angle, aCenter = new Vec2()): SEG {
		const rot = (p: Vec2): Vec2 => {
			const d = p.sub(aCenter);
			const c = Math.cos(aAngle.radians);
			const s = Math.sin(aAngle.radians);
			return new Vec2(aCenter.x + d.x * c - d.y * s, aCenter.y + d.x * s + d.y * c);
		};
		return new SEG(rot(this.A), rot(this.B));
	}

	/** True if the two segments are parallel. */
	Parallel(aSeg: SEG): boolean {
		return this.AsVector().cross(aSeg.AsVector()) === 0;
	}

	/** True if the two segments are collinear. */
	Collinear(aSeg: SEG): boolean {
		const cross1 = this.A.sub(this.B).cross(aSeg.A.sub(this.B));
		const cross2 = this.A.sub(this.B).cross(aSeg.B.sub(this.B));
		return cross1 === 0 && cross2 === 0;
	}

	/** True if one segment is collinear and overlaps the other. */
	Overlaps(aSeg: SEG): boolean {
		if (!this.Collinear(aSeg)) {
			return false;
		}
		// Project onto the A-B axis.
		const v = this.AsVector();
		const s1 = projectScalar(this.A, aSeg.A, v);
		const s2 = projectScalar(this.A, aSeg.B, v);
		const s3 = projectScalar(this.A, this.B, v);
		const lo = Math.min(s1, s2);
		const hi = Math.max(s1, s2);
		const tlo = Math.min(s3, 0);
		const thi = Math.max(s3, 0);
		return !(hi < tlo || lo > thi);
	}

	/** True if this segment intersects aSeg (including touching end points). */
	Intersects(aSeg: SEG, aIgnoreEndpoints = false): boolean {
		const ip = new Vec2();
		const r = this.Intersect(aSeg, true, aIgnoreEndpoints, ip);
		if (r < 0) {
			// parallel / collinear: only "intersect" if collinear and overlapping
			return this.Overlaps(aSeg);
		}
		return r === 1;
	}

	/**
	 * Computes the intersection point. Mirrors SEG::Intersect:
	 * returns 0 if no collision, 1 if collision and ip gets the point,
	 * -1 if the segments are collinear (ip is the bound point).
	 */
	Intersect(aSeg: SEG, aIgnoreCollinear = true, aIgnoreEndpoints = false, ip?: Vec2): number {
		const d0000 = 0;
		const dx = this.B.x - this.A.x;
		const dy = this.B.y - this.A.y;
		const dax = aSeg.B.x - aSeg.A.x;
		const day = aSeg.B.y - aSeg.A.y;
		const s = (-dy * (this.A.x - aSeg.A.x) + dx * (this.A.y - aSeg.A.y)) /
			(-dax * dy + dx * day);
		const t = (dax * (this.A.y - aSeg.A.y) - day * (this.A.x - aSeg.A.x)) /
			(-dax * dy + dx * day);

		if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
			if (aIgnoreEndpoints && (s === 0 || s === 1 || t === 0 || t === 1)) {
				return 0;
			}
			if (ip) {
				ip.x = this.A.x + t * dx;
				ip.y = this.A.y + t * dy;
			}
			void d0000;
			return 1;
		}
		if (this.Overlaps(aSeg)) {
			if (aIgnoreCollinear) {
				return -1;
			}
			if (ip) {
				// bound point: the nearest endpoint of aSeg on this segment
				const p = this.NearestPoint(aSeg.A);
				ip.x = p.x;
				ip.y = p.y;
			}
			return -1;
		}
		return 0;
	}

	/** Returns the point on this segment closest to p. */
	NearestPoint(p: Vec2): Vec2 {
		return nearestPointOnSeg(p, this.A, this.B);
	}

	/**
	 * Returns the two points (one on each segment) that are mutually closest.
	 * Mirrors SEG::NearestPoints.
	 */
	NearestPoints(aSeg: SEG): [Vec2, Vec2] {
		const ip = new Vec2();
		const r = this.Intersect(aSeg, false, false, ip);
		if (r === 1) {
			return [ip.copy(), ip.copy()];
		}
		// The closest pair is one of the four endpoint -> other-segment pairs.
		const candidates: Array<[Vec2, Vec2]> = [
			[this.A, nearestPointOnSeg(this.A, aSeg.A, aSeg.B)],
			[this.B, nearestPointOnSeg(this.B, aSeg.A, aSeg.B)],
			[aSeg.A, nearestPointOnSeg(aSeg.A, this.A, this.B)],
			[aSeg.B, nearestPointOnSeg(aSeg.B, this.A, this.B)],
		];
		let bestDistSq = Infinity;
		let best: [Vec2, Vec2] = candidates[0]!;
		for (const [pa, pb] of candidates) {
			const d = pa.sub(pb).squaredMagnitude;
			if (d < bestDistSq) {
				bestDistSq = d;
				best = [pa, pb];
			}
		}
		return best;
	}

	/**
	 * Distance from point p to the segment.
	 * Mirrors SEG::Distance(p).
	 */
	Distance(p: Vec2): number {
		return p.sub(this.NearestPoint(p)).magnitude;
	}

	/**
	 * Distance between two segments.
	 * Mirrors SEG::Distance(other).
	 */
	DistanceSegment(aSeg: SEG): number {
		const [pa, pb] = this.NearestPoints(aSeg);
		return pa.sub(pb).magnitude;
	}

	/** The point at parameter t in [0,1] along the segment (A -> B). */
	PointAt(t: number): Vec2 {
		return this.A.add(this.AsVector().multiply(t));
	}

	/** Point at distance `aPixel` along the segment from A. */
	CentrePointAtCommLen(aPixel: number): Vec2 {
		const len = this.Length();
		if (len <= EPSILON_MM) {
			return this.Midpoint();
		}
		return this.PointAt(aPixel / len);
	}

	/** True if p lies exactly on this segment (including endpoints). */
	Contains(p: Vec2): boolean {
		const d = this.Distance(p);
		return Math.abs(d) < EPSILON_MM;
	}

	/** Bounding box. */
	BBox(): { minX: number; minY: number; maxX: number; maxY: number } {
		return {
			minX: Math.min(this.A.x, this.B.x),
			minY: Math.min(this.A.y, this.B.y),
			maxX: Math.max(this.A.x, this.B.x),
			maxY: Math.max(this.A.y, this.B.y),
		};
	}

	/** True if the segment is a point (zero length). */
	IsPoint(): boolean {
		return this.SquaredLength() < 1e-12;
	}

	/**
	 * Splits this segment at `aPoint` (projected onto it), returning the two
	 * resulting segments. Mirrors KiCad's SEG::Split.
	 */
	Split(aPoint: Vec2): [SEG, SEG] {
		const np = this.NearestPoint(aPoint);
		return [new SEG(this.A, np), new SEG(np, this.B)];
	}
}

function nearestPointOnSeg(p: Vec2, a: Vec2, b: Vec2): Vec2 {
	const v = b.sub(a);
	const lenSq = v.squaredMagnitude;
	if (lenSq < EPSILON_MM) {
		return a.copy();
	}
	const t = Math.max(0, Math.min(1, p.sub(a).dot(v) / lenSq));
	return a.add(v.multiply(t));
}

function projectScalar(a: Vec2, p: Vec2, v: Vec2): number {
	return p.sub(a).dot(v);
}
