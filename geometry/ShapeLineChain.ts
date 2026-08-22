/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_line_chain.h
 *   libs/kimath/src/geometry/shape_line_chain.{h,cpp}
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
import { SHAPE } from './Shape';
import { SHAPE_TYPE } from './Shape';
import { SHAPE_ARC } from './ShapeArc';

/**
 * This class represents a polyline.  It stores a set of points in a vector,
 * and can return a bounding box, the closest point to a given point, etc.
 * Mirrors KiCad's SHAPE_LINE_CHAIN.
 */
export class SHAPE_LINE_CHAIN extends SHAPE {
	protected m_points: Vec2[] = [];
	protected m_closed = false;
	protected m_width = 0;
	protected m_bbox: BBox | null = null;
	protected m_bboxValid = false;

	// Sum of the arc lengths. Kept in sync with the points. (Not used for
	// anything geometric in this port beyond parity.)
	protected m_totalLength = 0;

	constructor(aPoints?: Iterable<Vec2>, aClosed = false) {
		super(SHAPE_TYPE.POLY_SET);
		if (aPoints) {
			this.m_points = [...aPoints];
		}
		this.m_closed = aClosed;
		this.m_bboxValid = false;
	}

	Type(): SHAPE_TYPE {
		return SHAPE_TYPE.SEGMENT === this.type ? this.type : SHAPE_TYPE.POLY_SET;
	}

	override Valid(): boolean {
		return this.m_points.length >= 2;
	}

	/** Returns the number of points in the chain. */
	PointCount(): number {
		return this.m_points.length;
	}

	/** Returns the number of segments in the chain. */
	SegmentCount(): number {
		const closed = this.m_points.length > 0 && this.m_closed;
		return Math.max(this.m_points.length - (closed ? 0 : 1), 0);
	}

	/** True if the chain is closed. */
	IsClosed(): boolean {
		return this.m_closed;
	}

	GetClosed(): boolean {
		return this.m_closed;
	}

	/** Sets the closed state. */
	SetClosed(aClosed: boolean): void {
		this.m_closed = aClosed;
		this.m_bboxValid = false;
	}

	SetWidth(aWidth: number): void {
		this.m_width = aWidth;
	}

	/** Serializes to the `(points (xy x y) (xy x y) ...)` S-expr used by KiCad
	 *  writers (plot/gerber/zone filled-poly points). Points in mm. */
	FormatCluster(): string {
		const fmtCoord = (v: number): string => {
			const n = Math.round(v * 1e6) / 1e6;
			return Object.is(n, -0) ? '0' : String(n);
		};
		const pts: string[] = [];
		for (const p of this.m_points) {
			pts.push(`(xy ${ fmtCoord( p.x ) } ${ fmtCoord( p.y ) })`);
		}
		return `(points ${ pts.join(' ') })`;
	}

	/** Returns this chain's width (the stroked line width). */
	GetWidth(): number {
		return this.m_width;
	}

	/** Clears all points. */
	Clear(): void {
		this.m_points = [];
		this.m_bboxValid = false;
	}

	/**
	 * Returns a copy (deep) of this chain.
	 */
	Clone(): SHAPE_LINE_CHAIN {
		const chain = new SHAPE_LINE_CHAIN([...this.m_points], this.m_closed);
		chain.m_width = this.m_width;
		return chain;
	}

	/** Clears the point cache (marks bounding box dirty). */
	ResetCache(): void {
		this.m_bboxValid = false;
	}

	/** Returns the current point at the end of the chain. */
	CLastPoint(): Vec2 {
		return this.m_points[this.m_points.length - 1]!;
	}

	/** Returns the current point at the start of the chain. */
	CPoint(aIndex: number): Vec2 {
		return this.m_points[aIndex]!;
	}

	/** Returns a pointer to the point at the given index (read/write). */
	Point(aIndex: number): Vec2 {
		if (aIndex === this.m_points.length) {
			if (this.m_closed) {
				return this.m_points[0]!;
			}
		}
		return this.m_points[aIndex]!;
	}

	PointCountPoints(): number {
		return this.m_points.length;
	}

	/** Returns the p-th point of the chain. */
	GetPoint(aIndex: number): Vec2 {
		return this.Point(aIndex);
	}

	GetSegment(aIndex: number): { A: Vec2; B: Vec2 } {
		const n = this.m_points.length;
		if (this.m_closed) {
			return { A: this.m_points[aIndex % n]!, B: this.m_points[(aIndex + 1) % n]! };
		}
		return { A: this.m_points[aIndex]!, B: this.m_points[aIndex + 1]! };
	}

	/** Const-like reference to the points array (returned as a copy). */
	CLine(): Vec2[] {
		return [...this.m_points];
	}

	/** Returns the i-th segment as a SEG-style pair (read/exact accessor). */
	CSegment(aIndex: number): { A: Vec2; B: Vec2 } {
		return this.GetSegment(aIndex);
	}

	/** Alias for PointCount matching KiCad's GetPointCount. */
	GetPointCount(): number {
		return this.m_points.length;
	}

	/** Alias for BBox (KiCad's SHAPE_LINE_CHAIN::GetBBox). */
	GetBBox(aClearance = 0): BBox {
		return this.BBox(aClearance);
	}

	/** Number of arc segments (always 0 in this simplified chain). */
	GetArcCount(): number {
		return 0;
	}

	/** Index of the segment whose midpoint is closest to `aP`. */
	GetNearestSegmentIndexToPoint(aP: Vec2): number {
		return this.GetSegmentFindClosestPointTo(aP);
	}

	/** Returns the segment whose midpoint is nearest to `aP`. */
	GetSegmentFindClosestPointTo(aP: Vec2): number {
		let bestI = 0;
		let bestDistSq = Infinity;
		for (let i = 0; i < this.SegmentCount(); i++) {
			const seg = this.GetSegment(i);
			const mid = seg.A.add(seg.B).multiply(0.5);
			const d = aP.sub(mid).squaredMagnitude;
			if (d < bestDistSq) {
				bestDistSq = d;
				bestI = i;
			}
		}
		return bestI;
	}

	/** True if `aP` is one of the chain's points. */
	HasPoint(aP: Vec2): boolean {
		return this.IndexOfPoint(aP) >= 0;
	}

	/** Index of `aP` in the chain, or -1. */
	IndexOfPoint(aP: Vec2): number {
		for (let i = 0; i < this.m_points.length; i++) {
			if (this.m_points[i]!.equals(aP)) {
				return i;
			}
		}
		return -1;
	}

	/** Insert a point at `aIndex`. */
	Insert(aIndex: number, aPoint: Vec2): void {
		this.m_points.splice(aIndex, 0, aPoint);
		this.m_bboxValid = false;
	}

	/** Remove the point at `aIndex`. */
	Remove(aIndex: number): void {
		this.m_points.splice(aIndex, 1);
		this.m_bboxValid = false;
	}

	/**
	 * Removes the last point.
	 */
	RemoveLast(): void {
		if (this.m_points.length > 0) {
			this.m_points.pop();
		}
		this.m_bboxValid = false;
	}

	/**
	 * Appends a new point to the chain.
	 */
	Append(aX: number, aY: number): void;
	Append(aP: Vec2): void;
	Append(aXOrP: number | Vec2, aY?: number): void {
		if (typeof aXOrP === 'number') {
			this.m_points.push(new Vec2(aXOrP, aY ?? 0));
		} else {
			this.m_points.push(aXOrP);
		}
		this.m_bboxValid = false;
	}

	/**
	 * Appends a segment (two points) to the chain.
	 */
	AppendSegment(aSeg: { A: Vec2; B: Vec2 }): void {
		this.Append(aSeg.B);
	}

	/** Returns the bounding box of the chain. */
	BBox(aClearance = 0): BBox {
		if (!this.m_bboxValid) {
			this.recomputeBBox();
			if (aClearance === 0) {
				this.m_bboxValid = true;
			}
		}
		if (aClearance === 0) {
			return (this.m_bbox ?? new BBox()).copy();
		}
		return (this.m_bbox ?? new BBox()).grow(aClearance);
	}

	private recomputeBBox(): void {
		if (this.m_points.length === 0) {
			this.m_bbox = new BBox();
			return;
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const p of this.m_points) {
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
		if (this.m_width > 0) {
			const hw = this.m_width / 2;
			minX -= hw; minY -= hw; maxX += hw; maxY += hw;
		}
		this.m_bbox = BBox.fromPoints([
			new Vec2(minX, minY),
			new Vec2(maxX, maxY),
		]);
	}

	GetCentre(): Vec2 {
		if (this.m_points.length === 0) {
			return new Vec2();
		}
		const b = this.BBox();
		return b.center;
	}

	GetEnd(): Vec2 {
		if (this.m_points.length === 0) {
			return new Vec2();
		}
		return this.m_points[this.m_points.length - 1]!;
	}

	GetStart(): Vec2 {
		if (this.m_points.length === 0) {
			return new Vec2();
		}
		return this.m_points[0]!;
	}

	protected MoveBy(aOffset: Vec2): void {
		this.m_points = this.m_points.map(p => p.add(aOffset));
		this.m_bboxValid = false;
	}

	Rotate(aAngle: number, aCenter: Vec2): void {
		this.m_points = this.m_points.map(p => {
			const d = p.sub(aCenter);
			const c = Math.cos(aAngle);
			const s = Math.sin(aAngle);
			return new Vec2(
				aCenter.x + d.x * c - d.y * s,
				aCenter.y + d.x * s + d.y * c
			);
		});
		this.m_bboxValid = false;
	}

	/**
	 * Mirrors SHAPE_LINE_CHAIN::Collide(VECTOR2I aP, int aClearance).
	 */
	CollidePoint(aP: Vec2, aClearance: number): boolean {
		return this.Distance(aP) <= aClearance;
	}

	/**
	 * Mirrors SHAPE_LINE_CHAIN::Distance(VECTOR2I aP).
	 * Distance from aP to the chain (treating it as a polyline; the width is
	 * not added here — KiCad subtracts the width in some callers).
	 */
	Distance(aP: Vec2): number {
		const n = this.m_points.length;
		if (n === 0) {
			return Infinity;
		}
		if (n === 1) {
			return aP.sub(this.m_points[0]!).magnitude;
		}
		let best = Infinity;
		for (let i = 0; i < this.SegmentCount(); i++) {
			const seg = this.GetSegment(i);
			best = Math.min(best, pointToSegmentDistance(aP, seg.A, seg.B));
		}
		return best;
	}

	/**
	 * Mirrors SHAPE_LINE_CHAIN::NearestPoint(VECTOR2I aP) — returns the point
	 * on the chain (or its ending), not the index.
	 */
	NearestPoint(aP: Vec2): Vec2 {
		const idx = this.NearestSegment(aP);
		if (idx < 0) {
			return new Vec2();
		}
		const seg = this.GetSegment(idx);
		return closestPointOnSegment(aP, seg.A, seg.B);
	}

	/** Index of the segment nearest to aP. */
	NearestSegment(aP: Vec2): number {
		let bestI = -1;
		let bestD = Infinity;
		for (let i = 0; i < this.SegmentCount(); i++) {
			const seg = this.GetSegment(i);
			const d = pointToSegmentDistance(aP, seg.A, seg.B);
			if (d < bestD) {
				bestD = d;
				bestI = i;
			}
		}
		return bestI;
	}

	/** Returns the index of the point nearest to aP. */
	NearestPointIndex(aP: Vec2): number {
		let bestI = 0;
		let bestD = Infinity;
		for (let i = 0; i < this.m_points.length; i++) {
			const d = aP.sub(this.m_points[i]!).squaredMagnitude;
			if (d < bestD) {
				bestD = d;
				bestI = i;
			}
		}
		return bestI;
	}

	// -------------------------------------------------------------------
	// Chain transformations / helpers
	// -------------------------------------------------------------------

	/** If the chain is closed, returns the points; otherwise returns points + first point. */
	ClosedPoints(): Vec2[] {
		if (this.m_closed && this.m_points.length > 0) {
			return [...this.m_points, this.m_points[0]!];
		}
		return [...this.m_points];
	}

	/** Flips (reverses) the order of the points. */
	Reverse(): void {
		this.m_points.reverse();
		this.m_bboxValid = false;
	}

	/**
	 * Appends an arc (as a sampled polyline) to the chain.
	 * Mirrors the effect of appending an SHAPE_ARC segment to a
	 * SHAPE_LINE_CHAIN. `aArc` is the arc to append and `aWidth` its
	 * effective line width (KiCad samples with a chord tolerance).
	 */
	AppendArc(aArc: SHAPE_ARC, aWidth = 0): void {
		const pts = arcToPolyline(aArc, aWidth, 128);
		for (let i = 0; i < pts.length; i++) {
			this.Append(pts[i]!);
		}
	}

	/**
	 * Removes colinear consecutive points. Mirrors
	 * SHAPE_LINE_CHAIN::RemoveColinearPoints(aC): aC=false keeps the curve
	 * simple by removing interior colinear points; aC=true also removes points
	 * with a duplicate neighbour. We implement the common (aC=false) case.
	 */
	RemoveColinearPoints(aMinLength = 0): void {
		if (this.m_points.length <= 2) {
			return;
		}

		const n = this.m_points.length;
		const keep = new Array<boolean>(n).fill(true);

		for (let i = 1; i < n - 1; i++) {
			const prev = this.m_points[i - 1]!;
			const curr = this.m_points[i]!;
			const next = this.m_points[i + 1]!;
			if (curr.sub(prev).magnitude >= aMinLength && isColinear(prev, curr, next)) {
				keep[i] = false;
			}
		}

		this.m_points = this.m_points.filter((_, i) => keep[i]);
		this.m_bboxValid = false;
	}

	/** Removes consecutive duplicate points. */
	RemoveDuplicatePoints(): void {
		const pts: Vec2[] = [];
		for (const p of this.m_points) {
			if (pts.length === 0 || !pts[pts.length - 1]!.equals(p)) {
				pts.push(p);
			}
		}
		this.m_points = pts;
		this.m_bboxValid = false;
	}

	/** Simplifies the chain (drop dupes and colinear runs). */
	Simplify(aRemoveColinear = true): void {
		this.RemoveDuplicatePoints();
		if (aRemoveColinear) {
			this.RemoveColinearPoints();
		}
	}

	/** The index `aIndex` wrapped into [0, n). */
	private wrapIndex(aIndex: number, n: number): number {
		const m = aIndex % n;
		return m < 0 ? m + n : m;
	}

	/**
	 * Splits the chain at `aStart`..`aEnd` (point indices) into a new chain.
	 * Mirrors SHAPE_LINE_CHAIN::Slice.
	 */
	Slice(aStart: number, aEnd: number): SHAPE_LINE_CHAIN {
		const pts: Vec2[] = [];
		const n = this.m_points.length;
		const count = aEnd - aStart + 1;
		for (let i = 0; i < count; i++) {
			pts.push(this.m_points[(aStart + i + n) % n]!);
		}
		return new SHAPE_LINE_CHAIN(pts, false);
	}
}

/**
 * Samples an arc into an open polyline of points from start -> end, following
 * the arc's sweep. Mirrors KiCad's SHAPE_LINE_CHAIN arc tessellation (used
 * wherever a rounded/arc geometry must be turned into vertices).
 */
export function arcToPolyline(aArc: SHAPE_ARC, _aWidth = 0, aMaxSegments = 128): Vec2[] {
	const center = aArc.GetCenter();
	const r = aArc.GetRadius();
	const start = aArc.GetStart();
	const end = aArc.GetEnd();
	const mid = aArc.GetMidPoint();
	const pts: Vec2[] = [start.copy()];

	if (r <= 0) {
		pts.push(end.copy());
		return pts;
	}

	const angOf = (p: Vec2): number => Math.atan2(p.y - center.y, p.x - center.x);
	const aStart = angOf(start);
	const aMid = angOf(mid);
	const aEnd = angOf(end);

	// KiCad arcs always traverse from start -> end through mid (<= 180 deg).
	// Compute a signed sweep from start to end whose direction matches the
	// start->mid direction.
	let sweep = aEnd - aStart;
	// Normalize to (-pi, pi].
	while (sweep > Math.PI) sweep -= 2 * Math.PI;
	while (sweep <= -Math.PI) sweep += 2 * Math.PI;

	// Align with the actual direction from start to mid.
	const dirMid = aMid - aStart;
	if (sweep * dirMid < 0 && Math.abs(sweep) > 1e-9) {
		// take the complementary sweep
		sweep = aEnd - aStart > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
	}

	const segments = Math.max(2, Math.min(aMaxSegments, Math.ceil(Math.abs(sweep) / 0.05)));
	for (let i = 1; i < segments; i++) {
		const ang = aStart + (i / segments) * sweep;
		pts.push(new Vec2(center.x + r * Math.cos(ang), center.y + r * Math.sin(ang)));
	}
	pts.push(end.copy());
	return pts;
}


/** Distance from point P to the segment (A,B). */
export function pointToSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const lenSq = abx * abx + aby * aby;
	let t = 0;
	if (lenSq > 0) {
		t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
		t = Math.max(0, Math.min(1, t));
	}
	const projx = a.x + t * abx;
	const projy = a.y + t * aby;
	return new Vec2(projx, projy).sub(p).magnitude;
}

/** Closest point on segment (A,B) to P. */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
	const abx = b.x - a.x;
	const aby = b.y - a.y;
	const lenSq = abx * abx + aby * aby;
	let t = 0;
	if (lenSq > 0) {
		t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
		t = Math.max(0, Math.min(1, t));
	}
	return new Vec2(a.x + t * abx, a.y + t * aby);
}

/** True if points a, b, c are colinear (within an epsilon cross product). */
export function isColinear(a: Vec2, b: Vec2, c: Vec2): boolean {
	const v1x = b.x - a.x;
	const v1y = b.y - a.y;
	const v2x = c.x - b.x;
	const v2y = c.y - b.y;
	const cross = v1x * v2y - v1y * v2x;
	// Square-magnitude-normalized tolerance.
	const len1 = v1x * v1x + v1y * v1y;
	const len2 = v2x * v2x + v2y * v2y;
	const denom = Math.sqrt(len1 * len2) || 1;
	return Math.abs(cross) / denom <= 1e-9;
}
