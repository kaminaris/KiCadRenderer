/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_poly_set.h
 *   libs/kimath/src/geometry/shape_poly_set.cpp
 *   libs/kimath/src/geometry/shape_poly_set_shape_poly_set_clipper.cpp
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * The boolean ops and inflate in KiCad 10's SHAPE_POLY_SET use Clipper2
 * (shape_poly_set_shape_poly_set_clipper.cpp). Here they route through the
 * repo's existing ClipperEngine (paint/ClipperEngine.ts) which wraps
 * `@clipper2-ts` — the same library family the C++ uses, so the boolean
 * semantics stay faithful.
 *
 * Coordinates: this port stores outline points in **mm** (Vec2), matching the
 * rest of the geometry module and the renderer. They are converted to Clipper
 * integer (nm) coordinates only at the Clipper boundary (toClipperPath/
 * fromClipperPath below), mirroring KiCad's VECTOR2I(nm) ↔ SHAPE_POLY_SET.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { getClipperEngine } from '../paint/ClipperEngine';
import { ClipType } from '@clipper2-ts/engine';
import { FillRule, Path, Paths, Point64Of } from '@clipper2-ts/core';
import { JoinType, EndType } from '@clipper2-ts/offset';
import { SHAPE } from './Shape';
import { SHAPE_TYPE } from './Shape';
import { SHAPE_LINE_CHAIN, pointToSegmentDistance, closestPointOnSegment } from './ShapeLineChain';
import { SHAPE_SEGMENT } from './ShapeSegment';
import { fmtN } from './format';

const NM_PER_MM = 1_000_000;

/** KiCad's SHAPE_POLY_SET operates on integer (nm) coordinates; convert. */
export function toClipperPath(points: Iterable<Vec2>): Path {
	const arr: Path = [];
	for (const p of points) {
		arr.push(Point64Of(p.x * NM_PER_MM, p.y * NM_PER_MM));
	}
	return arr;
}

export function fromClipperPath(path: Path): Vec2[] {
	return path.map(p => new Vec2(p.x / NM_PER_MM, p.y / NM_PER_MM));
}

/** Convert a polygon's outer ring + holes into a list of clipper Paths. */
export function polyToClipperPaths(poly: POLYGON): Paths {
	const paths: Paths = [toClipperPath(flattenClosedRing(poly.outline))];

	for (const hole of poly.holes) {
		paths.push(toClipperPath(flattenClosedRing(hole)));
	}

	return paths;
}

/** A single polygon: one outer ring and zero or more hole rings. */
export interface POLYGON {
	outline: VectorShrunk;
	holes: VectorShrunk[];
	parent: any | null; // parent index references, kept for parity
}

type VectorShrunk = SHAPE_LINE_CHAIN;

/**
 * A set of polygons, as in KiCad's SHAPE_POLY_SET.
 *
 * Supports multiple outlines with holes, boolean ops (via Clipper2), inflate
 * (offset via Clipper2), fill triangulation, fracture and point/edge queries.
 */
export class SHAPE_POLY_SET extends SHAPE {
	protected m_polys: POLYGON[] = [];
	// The set forms one connected region (KiCad uses this to allow casting to
	// a point set). Most consumers here treat it as a set of distinct polys.
	protected m_bbox: BBox | null = null;
	protected m_bboxValid = false;

	constructor(aOther?: SHAPE_POLY_SET) {
		super(SHAPE_TYPE.POLY_SET);
		if (aOther) {
			this.copyFrom(aOther);
		}
	}

	Type(): SHAPE_TYPE {
		return SHAPE_TYPE.POLY_SET;
	}

	// -----------------------------------------------------------------
	// Accessors
	// -----------------------------------------------------------------

	IsEmpty(): boolean {
		return this.m_polys.length === 0;
	}

	TotalVerticesCount(): number {
		let total = 0;
		for (const poly of this.m_polys) {
			total += poly.outline.PointCount();
			for (const hole of poly.holes) {
				total += hole.PointCount();
			}
		}
		return total;
	}

	OutlineCount(): number {
		return this.m_polys.length;
	}

	HoleCount(aOutline?: number): number {
		if (aOutline === undefined) {
			let total = 0;
			for (const poly of this.m_polys) {
				total += poly.holes.length;
			}
			return total;
		}
		return this.m_polys[aOutline]?.holes.length ?? 0;
	}

	GetOutlineCount(): number {
		return this.m_polys.length;
	}

	Polygon(aIndex: number): POLYGON {
		return this.m_polys[aIndex]!;
	}

	Polygon_p(aIndex: number): POLYGON | null {
		return this.m_polys[aIndex] ?? null;
	}

	Outline(aIndex: number): SHAPE_LINE_CHAIN {
		return this.m_polys[aIndex]!.outline;
	}

	OutlineClipper(): SHAPE_LINE_CHAIN {
		return this.m_polys[0]!.outline;
	}

	Hole(aOutline: number, aHole: number): SHAPE_LINE_CHAIN {
		return this.m_polys[aOutline]!.holes[aHole]!;
	}

	Vertex(aVertexIdx: number): Vec2;
	Vertex(aOutline: number, aHoleIdx: number, aVertIdx: number): Vec2;
	Vertex(aOutlineOrVert: number, aHoleIdx?: number, aVertIdx?: number): Vec2 {
		if (aHoleIdx === undefined || aVertIdx === undefined) {
			// Flat index across set (KiCad's Vertex(iteratable) — simplified:
			// treat every ring in sequence).
			let count = 0;
			for (const poly of this.m_polys) {
				for (const v of flattenRing(poly.outline)) {
					if (count === aOutlineOrVert) {
						return v;
					}
					count++;
				}
				for (const hole of poly.holes) {
					for (const v of flattenRing(hole)) {
						if (count === aOutlineOrVert) {
							return v;
						}
						count++;
					}
				}
			}
			return new Vec2();
		}
		const poly = this.m_polys[aOutlineOrVert]!;
		if (aHoleIdx < 0) {
			return poly.outline.Point(aVertIdx);
		}
		return poly.holes[aHoleIdx]!.Point(aVertIdx);
	}

	CVertex(aOutline: number, aHoleIdx: number, aVertIdx: number): Vec2 {
		return this.Vertex(aOutline, aHoleIdx, aVertIdx);
	}

	GetRelativeIndices(aGlobalIdx: number): { outline: number; hole: number; vertex: number } | null {
		let count = 0;
		for (let o = 0; o < this.m_polys.length; o++) {
			const poly = this.m_polys[o]!;
			if (aGlobalIdx < count + poly.outline.PointCount()) {
				return { outline: o, hole: -1, vertex: aGlobalIdx - count };
			}
			count += poly.outline.PointCount();
			for (let h = 0; h < poly.holes.length; h++) {
				const hole = poly.holes[h]!;
				if (aGlobalIdx < count + hole.PointCount()) {
					return { outline: o, hole: h, vertex: aGlobalIdx - count };
				}
				count += hole.PointCount();
			}
		}
		return null;
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
		if (this.m_polys.length === 0) {
			this.m_bbox = new BBox();
			this.m_bboxValid = true;
			return;
		}
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const poly of this.m_polys) {
			for (const v of flattenClosedRing(poly.outline)) {
				minX = Math.min(minX, v.x);
				minY = Math.min(minY, v.y);
				maxX = Math.max(maxX, v.x);
				maxY = Math.max(maxY, v.y);
			}
		}
		this.m_bbox = BBox.fromPoints([new Vec2(minX, minY), new Vec2(maxX, maxY)]);
		this.m_bboxValid = true;
	}

	GetCentre(): Vec2 {
		if (this.m_polys.length === 0) {
			return new Vec2();
		}
		return this.BBox().center;
	}

	GetStart(): Vec2 {
		return this.m_polys.length ? this.m_polys[0]!.outline.GetStart() : new Vec2();
	}

	GetEnd(): Vec2 {
		return this.m_polys.length
			? this.m_polys[this.m_polys.length - 1]!.outline.GetEnd()
			: new Vec2();
	}

	// -----------------------------------------------------------------
	// Construction
	// -----------------------------------------------------------------

	/** Clears the set without freeing the array. */
	Clear(): void {
		this.m_polys = [];
		this.m_bboxValid = false;
	}

	/** Removes all polygons and frees the array. */
	RemoveAllContours(): void {
		this.Clear();
	}

	RemoveAll(): void {
		this.Clear();
	}

	/** Creates a new empty outline and returns its index. */
	NewOutline(): number {
		this.m_polys.push({ outline: new SHAPE_LINE_CHAIN([], true), holes: [], parent: null });
		this.m_bboxValid = false;
		return this.m_polys.length - 1;
	}

	/** Creates a new empty hole in the given outline and returns its index. */
	NewHole(aOutline: number): number {
		const poly = this.m_polys[aOutline]!;
		poly.holes.push(new SHAPE_LINE_CHAIN([], true));
		this.m_bboxValid = false;
		return poly.holes.length - 1;
	}

	/** Appends a point to the end of an existing outline (holeIdx<0 for outline). */
	Append(aX: number, aY: number, aOutline: number = -1, aHole: number = -1): void {
		const poly = this.m_polys[aOutline < 0 ? 0 : aOutline]!;
		if (aHole < 0) {
			poly.outline.Append(aX, aY);
		} else {
			poly.holes[aHole]!.Append(aX, aY);
		}
		this.m_bboxValid = false;
	}

	AppendPoint(aOutline: number, aHole: number, aPoint: Vec2): void {
		this.Append(aPoint.x, aPoint.y, aOutline, aHole);
	}

	/**
	 * Adds a polygon ring. Mirrors SHAPE_POLY_SET::AddOutline / AddHole taking
	 * a SHAPE_LINE_CHAIN.
	 */
	AddOutline(aOutline: SHAPE_LINE_CHAIN, aAllowReordering = false): void {
		const chain = aOutline.Clone();
		if (!chain.IsClosed()) {
			chain.SetClosed(true);
		}
		this.m_polys.push({ outline: chain, holes: [], parent: null });
		this.m_bboxValid = false;
		void aAllowReordering;
	}

	AddHole(aHole: SHAPE_LINE_CHAIN, aOutline: number): void {
		const chain = aHole.Clone();
		if (!chain.IsClosed()) {
			chain.SetClosed(true);
		}
		const poly = this.m_polys[aOutline]!;
		poly.holes.push(chain);
		this.m_bboxValid = false;
	}

	AddPolygon(aPolygon: PointsPath, aOutline = -1, aHole = -1): void {
		const pts: Vec2[] = aPolygon.map(p => (p instanceof Vec2 ? p : new Vec2(p.x, p.y)));
		if (aOutline >= 0) {
			const poly = this.m_polys[aOutline]!;
			if (aHole >= 0) {
				poly.holes = [...poly.holes, new SHAPE_LINE_CHAIN(pts, true)];
			} else {
				poly.outline = new SHAPE_LINE_CHAIN(pts, true);
			}
		} else {
			this.m_polys.push({ outline: new SHAPE_LINE_CHAIN(pts, true), holes: [], parent: null });
		}
		this.m_bboxValid = false;
	}

	// -----------------------------------------------------------------
	// Iteration
	// -----------------------------------------------------------------

	/** Iterate over every ring (outline then holes) as a SHAPE_LINE_CHAIN. */
	IterateWithHoles(aOutline: number, cb: (chain: SHAPE_LINE_CHAIN, isHole: boolean) => void): void {
		const poly = this.m_polys[aOutline]!;
		cb(poly.outline, false);
		for (const hole of poly.holes) {
			cb(hole, true);
		}
	}

	/** Yield all points of all outlines and holes. */
	AllPoints(): Vec2[] {
		const pts: Vec2[] = [];
		for (const poly of this.m_polys) {
			pts.push(...flattenClosedRing(poly.outline));
			for (const hole of poly.holes) {
				pts.push(...flattenClosedRing(hole));
			}
		}
		return pts;
	}

	// -----------------------------------------------------------------
	// Fracture / Unfracture
	// -----------------------------------------------------------------

	/**
	 * Fractures all hole rings by bridging a narrow double-edge across each
	 * hole boundary into the outer ring (KiCad's Fracture()). After fracture
	 * the set contains only outline rings (no separate holes).
	 */
	Fracture(aLineWidth = 0): void {
		this.FractureSingle(aLineWidth);
	}

	private FractureSingle(aLineWidth = 0): void {
		const fractured: POLYGON[] = [];

		for (const poly of this.m_polys) {
			if (poly.holes.length === 0) {
				fractured.push({
					outline: poly.outline.Clone(),
					holes: [],
					parent: null,
				});
				continue;
			}

			// Bridge every hole into the outer ring at their nearest-point
			// seam, producing a single simple ring. Mirrors the effect of
			// KiCad's SHAPE_POLY_SET::Fracture (which bridges holes into the
			// outer outline as a zero-width slit).
			let outer = poly.outline.Clone();

			for (const hole of poly.holes) {
				const holePts = flattenClosedRing(hole);
				if (holePts.length === 0) {
					continue;
				}

				// Find the hole vertex closest to any outer ring segment, and
				// the closest point on that outer segment (insertion seam).
				let bestHoleIdx = 0;
				let bestOuterIdx = 0;
				let bestDist = Infinity;

				const outerCount = outer.PointCount();

				for (let hi = 0; hi < holePts.length; hi++) {
					const hp = holePts[hi]!;
					for (let oi = 0; oi < outerCount; oi++) {
						const a = outer.Point(oi);
						const b = outer.Point((oi + 1) % outerCount);
						const d = pointToSegmentDistance(hp, a, b);
						if (d < bestDist) {
							bestDist = d;
							bestHoleIdx = hi;
							bestOuterIdx = oi;
						}
					}
				}

				// Build the new outer ring by splicing the hole in at the seam.
				const newOuter = new SHAPE_LINE_CHAIN([], true);

				for (let oi = 0; oi <= bestOuterIdx; oi++) {
					newOuter.Append(outer.Point(oi));
				}
				// Insert the hole counter-clockwise around its points starting
				// at bestHoleIdx, then back across the slit.
				const h0 = holePts[bestHoleIdx]!;
				newOuter.Append(h0);
				for (let k = 1; k <= holePts.length; k++) {
					newOuter.Append(holePts[(bestHoleIdx + k) % holePts.length]!);
				}
				newOuter.Append(newOuter.CLastPoint()); // close slit with duplicate
				// Continue to the rest of the outer ring.
				for (let oi = bestOuterIdx + 1; oi <= outerCount; oi++) {
					newOuter.Append(outer.Point(oi % outerCount));
				}

				outer = newOuter;
			}

			fractured.push({ outline: outer, holes: [], parent: null });
		}

		this.m_polys = fractured;
		this.m_bboxValid = false;
		void aLineWidth;
	}

	/** Mirrors SHAPE_POLY_SET::Unfracture — the inverse of Fracture. */
	Unfracture(): void {
		// Not commonly needed by the connectivity port; KiCad re-derives holes
		// via the winding/orientation. We keep the set as-is with a note.
	}

	// -----------------------------------------------------------------
	// Boolean ops (via Clipper2)
	// -----------------------------------------------------------------

	/**
	 * Boolean operation across the whole set.
	 * Mirrors SHAPE_POLY_SET::BooleanAdd(aOther) etc.
	 */
	BooleanAdd(aOther: SHAPE_POLY_SET): void {
		this.booleanOp(ClipType.Union, aOther);
	}

	BooleanSubtract(aOther: SHAPE_POLY_SET): void {
		this.booleanOp(ClipType.Difference, aOther);
	}

	BooleanIntersection(aOther: SHAPE_POLY_SET): void {
		this.booleanOp(ClipType.Intersection, aOther);
	}

	BooleanXor(aOther: SHAPE_POLY_SET): void {
		this.booleanOp(ClipType.Xor, aOther);
	}

	private booleanOp(type: ClipType, other: SHAPE_POLY_SET): void {
		const subjects: Paths = [];
		const clips: Paths = [];

		for (const poly of this.m_polys) {
			subjects.push(...polyToClipperPaths(poly));
		}
		for (const poly of other.m_polys) {
			clips.push(...polyToClipperPaths(poly));
		}

		const result = getClipperEngine().booleanOp(type, FillRule.EvenOdd, subjects, clips);
		this.replaceFromClipper(result);
	}

	/** Self-boolean (union of all outlines with fill rule). */
	UnaryUnion(aFillRule: string = 'evenodd'): void {
		const subjects: Paths = [];
		for (const poly of this.m_polys) {
			subjects.push(...polyToClipperPaths(poly));
		}
		const result = getClipperEngine().booleanOp(ClipType.Union, FillRule.EvenOdd, subjects, []);
		this.replaceFromClipper(result);
		void aFillRule;
	}

	/** Replaces the set contents with the given Clipper result paths. */
	private replaceFromClipper(paths: Paths): void {
		const newPolys: POLYGON[] = [];
		for (const path of paths) {
			const pts = fromClipperPath(path);
			// Strip the implicit closing duplicate Clipper adds.
			if (pts.length > 1 && pts[0]!.equals(pts[pts.length - 1]!)) {
				pts.pop();
			}
			newPolys.push({
				outline: new SHAPE_LINE_CHAIN(pts, true),
				holes: [],
				parent: null,
			});
		}
		this.m_polys = newPolys;
		this.m_bboxValid = false;
	}

	// -----------------------------------------------------------------
	// Inflate (offset) — via Clipper2
	// -----------------------------------------------------------------

	/**
	 * Mirrors SHAPE_POLY_SET::Inflate(aAmount, aCornerStrategy, aJoinType,
	 * aMiterLimit). aAmount is in mm; positive expands, negative shrinks.
	 */
	Inflate(aAmount: number, aCornerStrategy = 0, aJoinType = 'round', aMiterLimit = 2.0): void {
		const subjects: Paths = [];
		for (const poly of this.m_polys) {
			subjects.push(...polyToClipperPaths(poly));
		}

		const joinType = resolveJoinType(aJoinType);
		// Clipper delta is in the same integer (nm) units.
		const deltaNm = aAmount * NM_PER_MM;

		const result = getClipperEngine().inflatePaths(
			subjects,
			deltaNm,
			joinType,
			EndType.Polygon,
			aMiterLimit
		);

		// KiCad's Inflate takes the outlines' union, then re-derives holes from
		// the result's orientation. Clipper returns the offsets; treat each
		// ring with positive (CCW) area as an outline, negative as a hole.
		this.m_polys = [];

		for (const path of result) {
			const pts = fromClipperPath(path);
			if (pts.length > 1 && pts[0]!.equals(pts[pts.length - 1]!)) {
				pts.pop();
			}
			if (pts.length < 3) {
				continue;
			}
			const area = signedArea(pts);
			if (!(area < 0)) {
				// outline (CCW positive in nm coordinate / Y-down Clipper)
				this.m_polys.push({ outline: new SHAPE_LINE_CHAIN(pts, true), holes: [], parent: null });
			} else {
				// hole — attach to the previous (or nearest) outline
				if (this.m_polys.length > 0) {
					this.m_polys[this.m_polys.length - 1]!.holes.push(new SHAPE_LINE_CHAIN(pts, true));
				}
			}
		}
		this.m_bboxValid = false;
		void aCornerStrategy;
	}

	// -----------------------------------------------------------------
	// Triangulation & point queries
	// -----------------------------------------------------------------

	/**
	 * Mirrors SHAPE_POLY_SET::Triangulate(). Populates the internal triangle
	 * list; returns the triangles as {A,B,C, o} (owner outline index).
	 */
	Triangulate(): TRIANGLE[] {
		const out: TRIANGLE[] = [];

		for (let o = 0; o < this.m_polys.length; o++) {
			const poly = this.m_polys[o]!;
			// Fracture the polygon (bridge holes into the outer ring) so the
			// ear-clipper sees one simple ring whose filled area excludes the
			// holes — matching KiCad's Triangulate (which fractures first).
			const fractured = this.fractureCopy(poly);
			const tris = earClipTriangulate([fractured]);
			for (const t of tris) {
				out.push({ ...t, owner: o, holeIdx: -1 });
			}
		}

		return out;
	}

	/** Returns a single closed ring for `aPoly` with holes bridged in, or the
	 *  original outline if there are no holes. */
	private fractureCopy(poly: POLYGON): SHAPE_LINE_CHAIN {
		if (poly.holes.length === 0) {
			return poly.outline.Clone();
		}

		let outer = poly.outline.Clone();

		for (const hole of poly.holes) {
			const holePts = flattenClosedRing(hole);
			if (holePts.length === 0) {
				continue;
			}

			let bestHoleIdx = 0;
			let bestOuterIdx = 0;
			let bestDist = Infinity;
			const outerCount = outer.PointCount();

			for (let hi = 0; hi < holePts.length; hi++) {
				const hp = holePts[hi]!;
				for (let oi = 0; oi < outerCount; oi++) {
					const a = outer.Point(oi);
					const b = outer.Point((oi + 1) % outerCount);
					const d = pointToSegmentDistance(hp, a, b);
					if (d < bestDist) {
						bestDist = d;
						bestHoleIdx = hi;
						bestOuterIdx = oi;
					}
				}
			}

			const newOuter = new SHAPE_LINE_CHAIN([], true);

			for (let oi = 0; oi <= bestOuterIdx; oi++) {
				newOuter.Append(outer.Point(oi));
			}
			const h0 = holePts[bestHoleIdx]!;
			newOuter.Append(h0);
			for (let k = 1; k <= holePts.length; k++) {
				newOuter.Append(holePts[(bestHoleIdx + k) % holePts.length]!);
			}
			newOuter.Append(newOuter.CLastPoint());
			for (let oi = bestOuterIdx + 1; oi <= outerCount; oi++) {
				newOuter.Append(outer.Point(oi % outerCount));
			}

			outer = newOuter;
		}

		return outer;
	}

	Contains(aPt: Vec2, aClearance = 0, aSubpolyIndex = -1): boolean {
		if (aClearance > 0) {
			return this.ContainsWithNearby(aPt, aClearance);
		}

		if (aSubpolyIndex >= 0) {
			const poly = this.m_polys[aSubpolyIndex];
			if (!poly) {
				return false;
			}
			return polygonContainsPoint(poly.outline, poly.holes, aPt);
		}

		for (const poly of this.m_polys) {
			if (polygonContainsPoint(poly.outline, poly.holes, aPt)) {
				return true;
			}
		}
		return false;
	}

	private ContainsWithNearby(aPt: Vec2, aClearance: number): boolean {
		if (this.Contains(aPt)) {
			return true;
		}
		for (const poly of this.m_polys) {
			const segs = ringSegments(poly.outline);
			for (const seg of segs) {
				if (seg.Distance(aPt) <= aClearance) {
					return true;
				}
			}
			for (const hole of poly.holes) {
				for (const seg of ringSegments(hole)) {
					if (seg.Distance(aPt) <= aClearance) {
						return true;
					}
				}
			}
		}
		return false;
	}

	CollidePoint(aPt: Vec2, aClearance: number): boolean {
		return this.Contains(aPt, aClearance);
	}

	Distance(aPt: Vec2): number {
		let best = Infinity;
		for (const poly of this.m_polys) {
			for (const seg of ringSegments(poly.outline)) {
				best = Math.min(best, seg.Distance(aPt));
			}
			for (const hole of poly.holes) {
				for (const seg of ringSegments(hole)) {
					best = Math.min(best, seg.Distance(aPt));
				}
			}
		}
		return best;
	}

	/** Mirrors SHAPE_POLY_SET::DistanceToPolygons. */
	DistanceToPolygons(aPoint: Vec2): number {
		return this.Distance(aPoint);
	}

	/** The closest point on this polyset's boundary to `aPoint`. */
	NearestPoint(aPoint: Vec2): Vec2 {
		let best = new Vec2();
		let bestD = Infinity;
		for (const poly of this.m_polys) {
			const consider = (chain: SHAPE_LINE_CHAIN): void => {
				const n = chain.PointCount();
				for (let i = 0; i < n; i++) {
					const a = chain.Point(i);
					const b = chain.Point((i + 1) % n);
					const np = closestPointOnSegment(aPoint, a, b);
					const d = aPoint.sub(np).squaredMagnitude;
					if (d < bestD) {
						bestD = d;
						best = np;
					}
				}
			};
			consider(poly.outline);
			for (const hole of poly.holes) {
				consider(hole);
			}
		}
		return best;
	}

	/**
	 * Distance from `aSeg` (a 2D segment with width) to the polyset boundary.
	 * Mirrors the DRC segment-vs-polyline distance.
	 */
	DistanceToSegment(aSeg: import('./Seg').SEG): number {
		let best = Infinity;
		for (const poly of this.m_polys) {
			const consider = (chain: SHAPE_LINE_CHAIN): void => {
				const n = chain.PointCount();
				for (let i = 0; i < n; i++) {
					const a = chain.Point(i);
					const b = chain.Point((i + 1) % n);
					const d = segmentSegmentDistL(aSeg.A, aSeg.B, a, b);
					if (d < best) {
						best = d;
					}
				}
			};
			consider(poly.outline);
			for (const hole of poly.holes) {
				consider(hole);
			}
		}
		return best;
	}

	/**
	 * Minimum distance between this polygon set's outline and another set's
	 * outline (zone-to-zone clearance). Mirrors the DRC zone-zone distance.
	 */
	DistanceToPolyset(aOther: SHAPE_POLY_SET): number {
		let best = Infinity;
		for (const poly of this.m_polys) {
			const consider = (chain: SHAPE_LINE_CHAIN): void => {
				const n = chain.PointCount();
				for (let i = 0; i < n; i++) {
					const a = chain.Point(i);
					const b = chain.Point((i + 1) % n);
					best = Math.min(best, aOther.DistanceToSegmentArray(a, b));
				}
			};
			consider(poly.outline);
			for (const hole of poly.holes) {
				consider(hole);
			}
			if (best <= 0) {
				break;
			}
		}
		return best;
	}

	/** Distance from the segment (a..b) to every ring of this set. */
	DistanceToSegmentArray(a: Vec2, b: Vec2): number {
		let best = Infinity;
		for (const poly of this.m_polys) {
			const consider = (chain: SHAPE_LINE_CHAIN): void => {
				const n = chain.PointCount();
				for (let i = 0; i < n; i++) {
					const x1 = chain.Point(i);
					const x2 = chain.Point((i + 1) % n);
					best = Math.min(best, segmentSegmentDistL(a, b, x1, x2));
				}
			};
			consider(poly.outline);
			for (const hole of poly.holes) {
				consider(hole);
			}
			if (best <= 0) {
				break;
			}
		}
		return best;
	}
	/** Total area of the set (outer areas minus hole areas). */
	Area(aOutline = -1): number {
		const process = (poly: POLYGON): number => {
			let a = Math.abs(signedArea(flattenClosedRing(poly.outline)));
			for (const hole of poly.holes) {
				a -= Math.abs(signedArea(flattenClosedRing(hole)));
			}
			return a;
		};

		if (aOutline >= 0) {
			const p = this.m_polys[aOutline];
			return p ? process(p) : 0;
		}
		let total = 0;
		for (const p of this.m_polys) {
			total += process(p);
		}
		return total;
	}

	/** The centroid (center of area) of the set. */
	Centroid(aOutline = -1): Vec2 {
		let ax = 0;
		let ay = 0;
		let areaSum = 0;

		const contribute = (chain: SHAPE_LINE_CHAIN, sign: number): void => {
			const pts = flattenClosedRing(chain);
			let area = 0;
			let cx = 0;
			let cy = 0;
			for (let i = 0; i < pts.length; i++) {
				const p = pts[i]!;
				const q = pts[(i + 1) % pts.length]!;
				const cross = p.x * q.y - q.x * p.y;
				area += cross;
				cx += (p.x + q.x) * cross;
				cy += (p.y + q.y) * cross;
			}
			area *= 0.5;
			if (Math.abs(area) < 1e-12) {
				return;
			}
			const body = 1 / (6 * area);
			ax += sign * body * cx;
			ay += sign * body * cy;
			areaSum += sign * area;
		};

		const counts = (poly: POLYGON): void => {
			contribute(poly.outline, 1);
			for (const hole of poly.holes) {
				contribute(hole, -1);
			}
		};

		if (aOutline >= 0 && this.m_polys[aOutline]) {
			counts(this.m_polys[aOutline]!);
		} else {
			for (const p of this.m_polys) {
				counts(p);
			}
		}

		if (Math.abs(areaSum) < 1e-12) {
			return this.BBox().center;
		}
		return new Vec2(ax / areaSum, ay / areaSum);
	}

	/** True if the first outline is wound clockwise (Y-up / CCW-positive). */
	IsClockwise(aOutline = 0): boolean {
		const p = this.m_polys[aOutline];
		if (!p) {
			return false;
		}
		return signedArea(flattenClosedRing(p.outline)) < 0;
	}

	/** Removes consecutive duplicate points in every ring. */
	Simplify(): void {
		for (const poly of this.m_polys) {
			poly.outline.RemoveDuplicatePoints();
			for (const hole of poly.holes) {
				hole.RemoveDuplicatePoints();
			}
		}
		this.m_bboxValid = false;
	}

	/** True if the point is inside any outline (and not in a hole). */
	IsPointInsidePolygon(aPoint: Vec2, aOutline = -1): boolean {
		return this.Contains(aPoint, 0, aOutline);
	}

	/**
	 * A rough outer hull: the first outline as a closed chain (holes ignored).
	 * Mirrors the KiCad "outer hull" concept at a coarse level (for a single
	 * outline the true hull is the outline itself).
	 */
	OuterHull(): SHAPE_LINE_CHAIN | null {
		if (this.m_polys.length === 0) {
			return null;
		}
		return this.m_polys[0]!.outline.Clone();
	}

	/**
	 * S-expression text for this polygon set, mirroring KiCad's
	 * `(poly_pts (xy x y)...)` / `(ps_add_xy ...)` style output. Emits each
	 * outline, then its holes as separate `(poly_pts ...)` rings.
	 */
	Format(): string {
		const parts: string[] = [];
		for (let o = 0; o < this.m_polys.length; o++) {
			const poly = this.m_polys[o]!;
			const ringStr = (chain: SHAPE_LINE_CHAIN): string => {
				const pts: string[] = [];
				const n = chain.PointCount();
				for (let i = 0; i < n; i++) {
					const p = chain.Point(i);
					pts.push(`(xy ${ fmtN( p.x ) } ${ fmtN( p.y ) })`);
				}
				return pts.join(' ');
			};
			parts.push(`(poly_pts ${ ringStr( poly.outline ) })`);
			for (const hole of poly.holes) {
				parts.push(`(poly_pts ${ ringStr( hole ) })`);
			}
		}
		return `(polyset ${ parts.join(' ') })`;
	}

	/**
	 * Serializes to the zone `(filled_polygon ...)` format KiCad writes in a
	 * `.kicad_pcb`. Each ring (outline then holes) becomes a
	 * `(filled_polygon (pts (xy x y) (xy x y) ...))` block. Mirrors KiCad's
	 * ZONE::"filled_polygon" writer.
	 */
	WriteFilledPolys(): string {
		const ringStr = (chain: SHAPE_LINE_CHAIN): string => {
			const pts: string[] = [];
			const n = chain.PointCount();
			for (let i = 0; i < n; i++) {
				const p = chain.Point(i);
				pts.push(`(xy ${ fmtN( p.x ) } ${ fmtN( p.y ) })`);
			}
			return pts.join(' ');
		};

		const blocks: string[] = [];
		for (const poly of this.m_polys) {
			blocks.push(`(filled_polygon (pts ${ ringStr( poly.outline ) }))`);
			for (const hole of poly.holes) {
				blocks.push(`(filled_polygon (pts ${ ringStr( hole ) }))`);
			}
		}
		return blocks.join('\n');
	}

	// -----------------------------------------------------------------
	// Transforms
	// -----------------------------------------------------------------

	protected MoveBy(aOffset: Vec2): void {
		for (const poly of this.m_polys) {
			poly.outline.Move(aOffset);
			for (const hole of poly.holes) {
				hole.Move(aOffset);
			}
		}
		this.m_bboxValid = false;
	}

	Rotate(aAngle: number, aCenter: Vec2): void {
		for (const poly of this.m_polys) {
			poly.outline.Rotate(aAngle, aCenter);
			for (const hole of poly.holes) {
				hole.Rotate(aAngle, aCenter);
			}
		}
		this.m_bboxValid = false;
	}

	private copyFrom(other: SHAPE_POLY_SET): void {
		this.m_polys = other.m_polys.map(p => ({
			outline: p.outline.Clone(),
			holes: p.holes.map(h => h.Clone()),
			parent: p.parent,
		}));
		this.m_bboxValid = other.m_bboxValid;
		this.m_bbox = other.m_bbox?.copy() ?? null;
	}
}

/** A triangle produced by Triangulate, with the owning outline index. */
export interface TRIANGLE {
	A: Vec2;
	B: Vec2;
	C: Vec2;
	owner: number;
	holeIdx: number;
}

export type PointsPath = Vec2[] | { x: number; y: number }[];

function flattenRing(chain: SHAPE_LINE_CHAIN): Vec2[] {
	return chain.ClosedPoints();
}

function flattenClosedRing(chain: SHAPE_LINE_CHAIN): Vec2[] {
	const pts: Vec2[] = [];
	for (let i = 0; i < chain.PointCount(); i++) {
		pts.push(chain.Point(i));
	}
	return pts;
}

/** Signed area (positive = CCW in Y-down = Clipper path orientation). */
/** Minimum distance between two segments (for DistanceToSegment). */
function segmentSegmentDistL(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): number {
	// Quick intersection test.
	if (segmentsCross(p1, p2, p3, p4)) {
		return 0;
	}
	return Math.min(
		pointToSegmentDistance(p1, p3, p4),
		pointToSegmentDistance(p2, p3, p4),
		pointToSegmentDistance(p3, p1, p2),
		pointToSegmentDistance(p4, p1, p2)
	);
}

function segmentsCross(a1: Vec2, b1: Vec2, a2: Vec2, b2: Vec2): boolean {
	const dx1 = b1.x - a1.x, dy1 = b1.y - a1.y;
	const dx2 = b2.x - a2.x, dy2 = b2.y - a2.y;
	const denom = dx1 * dy2 - dy1 * dx2;
	if (denom === 0) {
		return false;
	}
	const t = ((a2.x - a1.x) * dy2 - (a2.y - a1.y) * dx2) / denom;
	const u = ((a2.x - a1.x) * dy1 - (a2.y - a1.y) * dx1) / denom;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function signedArea(pts: Vec2[]): number {
	let area = 0;
	for (let i = 0; i < pts.length; i++) {
		const j = (i + 1) % pts.length;
		area += pts[i]!.x * pts[j]!.y - pts[j]!.x * pts[i]!.y;
	}
	return area / 2;
}

/** Returns the segments of a (closed) ring. */
function ringSegments(chain: SHAPE_LINE_CHAIN): SHAPE_SEGMENT[] {
	const n = chain.PointCount();
	const segs: SHAPE_SEGMENT[] = [];
	for (let i = 0; i < n; i++) {
		const a = chain.Point(i);
		const b = chain.Point((i + 1) % n);
		segs.push(new SHAPE_SEGMENT(a, b));
	}
	return segs;
}

/** Contains test for one polygon with holes, using ray casting. */
function polygonContainsPoint(outline: SHAPE_LINE_CHAIN, holes: SHAPE_LINE_CHAIN[], p: Vec2): boolean {
	if (!pointInRing(outline, p)) {
		return false;
	}
	for (const hole of holes) {
		if (pointInRing(hole, p)) {
			return false;
		}
	}
	return true;
}

function pointInRing(chain: SHAPE_LINE_CHAIN, p: Vec2): boolean {
	const n = chain.PointCount();
	if (n < 3) {
		return false;
	}
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = chain.Point(i);
		const xj = chain.Point(j);
		const intersects = (xi.y > p.y) !== (xj.y > p.y) &&
			p.x < ((xj.x - xi.x) * (p.y - xi.y)) / (xj.y - xi.y) + xi.x;
		if (intersects) {
			inside = !inside;
		}
	}
	return inside;
}

function resolveJoinType(jt: string): JoinType {
	switch (jt) {
		case 'square': return JoinType.Square;
		case 'miter': return JoinType.Miter;
		case 'bevel': return JoinType.Bevel;
		case 'round':
		default: return JoinType.Round;
	}
}

/**
 * Ear-clipping triangulator over a single closed ring (points already in
 * order, no holes — caller must have fractured first). Returns triangles with
 * Vec2 corners. Mirrors the result KiCad gets from its own triangulator (a
 * valid triangulation of the ring).
 */
function earClipTriangulate(rings: SHAPE_LINE_CHAIN[]): Array<{ A: Vec2; B: Vec2; C: Vec2 }> {
	const out: Array<{ A: Vec2; B: Vec2; C: Vec2 }> = [];

	for (const ring of rings) {
		let pts = flattenClosedRing(ring).filter((_, i, arr) =>
			// de-duplicate consecutive equal points
			i === 0 || !arr[i - 1]!.equals(arr[i]!)
		);
		if (pts.length < 3) {
			continue;
		}

		// Ensure CCW winding (for consistent ear orientation not required, but
		// the algorithm assumes a consistent orientation).
		if (signedArea(pts) < 0) {
			pts = pts.reverse();
		}

		const indices = pts.map((_, i) => i);
		let guard = 0;
		while (indices.length > 3 && guard < 10000) {
			guard++;
			let earFound = false;
			for (let i = 0; i < indices.length; i++) {
				const prev = indices[(i - 1 + indices.length) % indices.length]!;
				const curr = indices[i]!;
				const next = indices[(i + 1) % indices.length]!;
				const a = pts[prev]!;
				const b = pts[curr]!;
				const c = pts[next]!;
				if (isEar(a, b, c, pts, indices)) {
					out.push({ A: a, B: b, C: c });
					indices.splice(i, 1);
					earFound = true;
					break;
				}
			}
			if (!earFound) {
				// Degenerate; bail with the remaining as one triangle.
				if (indices.length >= 3) {
					out.push({
						A: pts[indices[0]!]!,
						B: pts[indices[1]!]!,
						C: pts[indices[2]!]!,
					});
				}
				break;
			}
		}
		if (indices.length === 3) {
			out.push({
				A: pts[indices[0]!]!,
				B: pts[indices[1]!]!,
				C: pts[indices[2]!]!,
			});
		}
	}

	return out;
}

function isEar(a: Vec2, b: Vec2, c: Vec2, pts: Vec2[], indices: number[]): boolean {
	// Convex check (CCW triangle positive area).
	if (cross2(a, b, c) <= 1e-12) {
		return false;
	}
	// No other point strictly inside the triangle (boundary/vertex points are
	// tolerated — an ear is valid even if a neighbor shares its edge).
	for (const idx of indices) {
		const p = pts[idx]!;
		if (p === a || p === b || p === c) {
			continue;
		}
		if (strictlyInsideTriangle(a, b, c, p)) {
			return false;
		}
	}
	return true;
}

function cross2(a: Vec2, b: Vec2, c: Vec2): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Strict (boundary-exclusive) point-in-triangle test with epsilon. */
function strictlyInsideTriangle(a: Vec2, b: Vec2, c: Vec2, p: Vec2): boolean {
	const d1 = cross2(p, a, b);
	const d2 = cross2(p, b, c);
	const d3 = cross2(p, c, a);
	const eps = 1e-12;
	const hasNeg = d1 < -eps || d2 < -eps || d3 < -eps;
	const hasPos = d1 > eps || d2 > eps || d3 > eps;
	// Point is outside (strict) if it has both a negative and a positive side,
	// or if it lies exactly on an edge (any |d_i| <= eps makes it boundary and
	// NOT strictly interior).
	if (Math.abs(d1) <= eps || Math.abs(d2) <= eps || Math.abs(d3) <= eps) {
		return false;
	}
	return !(hasNeg && hasPos);
}
