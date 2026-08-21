/*
 * Ported from KiCad source:
 *   libs/kimath/include/geometry/shape_segment.h (utility)
 *   common/bezier_curves.cpp (BezierSeg / SSeg) — cubic Bezier sampling
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Cubic Bezier curve sampling: given 4 control points, sample the curve into a
 * polyline (mirroring KiCad's schematic/footprint Bezier → polyline
 * conversion). Works in mm.
 */

import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SEG } from './Seg';

/**
 * A cubic Bezier from 4 control points, with polyline sampling. Mirrors
 * KiCad's Bezier geometry used by SCH_BEZIER / fp curves.
 */
export class BEZIER {
	p0: Vec2;
	p1: Vec2;
	p2: Vec2;
	p3: Vec2;

	constructor(aP0: Vec2, aP1: Vec2, aP2: Vec2, aP3: Vec2) {
		this.p0 = aP0;
		this.p1 = aP1;
		this.p2 = aP2;
		this.p3 = aP3;
	}

	/** Evaluates the Bezier at parameter t in [0,1]. */
	Point(t: number): Vec2 {
		const mt = 1 - t;
		const a = mt * mt * mt;
		const b = 3 * mt * mt * t;
		const c = 3 * mt * t * t;
		const d = t * t * t;
		return new Vec2(
			a * this.p0.x + b * this.p1.x + c * this.p2.x + d * this.p3.x,
			a * this.p0.y + b * this.p1.y + c * this.p2.y + d * this.p3.y
		);
	}

	/** Approx chord length (adaptive-ish: uniform sampling). */
	ApproxLength(aSegments = 64): number {
		let len = 0;
		let prev = this.p0;
		for (let i = 1; i <= aSegments; i++) {
			const p = this.Point(i / aSegments);
			len += p.sub(prev).magnitude;
			prev = p;
		}
		return len;
	}

	/** Samples the curve into `aSegments` points, including both endpoints. */
	Sample(aSegments = 32): Vec2[] {
		const out: Vec2[] = [];
		for (let i = 0; i <= aSegments; i++) {
			out.push(this.Point(i / aSegments));
		}
		return out;
	}

	/**
	 * Splits into two Bezier halves at t=0.5 (de Casteljau). Mirrors KiCad's
	 * Bezier splitting used to populate SHAPE_LINE_CHAIN.
	 */
	Split(): [BEZIER, BEZIER] {
		const a = this.mid(this.p0, this.p1);
		const b = this.mid(this.p1, this.p2);
		const c = this.mid(this.p2, this.p3);
		const d = this.mid(a, b);
		const e = this.mid(b, c);
		const f = this.mid(d, e);
		return [new BEZIER(this.p0, a, d, f), new BEZIER(f, e, c, this.p3)];
	}

	private mid(a: Vec2, b: Vec2): Vec2 {
		return a.add(b).multiply(0.5);
	}

	/** Bounding box (of the control polygon, conservative). */
	BBox(): BBox {
		const xs = [this.p0.x, this.p1.x, this.p2.x, this.p3.x];
		const ys = [this.p0.y, this.p1.y, this.p2.y, this.p3.y];
		return BBox.fromPoints([
			new Vec2(Math.min(...xs), Math.min(...ys)),
			new Vec2(Math.max(...xs), Math.max(...ys)),
		]);
	}
}

/**
 * Converts a Bezier into a polyline of points (KiCad's
 * BEZIER_POLY::GetPoly). `aSegments` approximates the curve.
 */
export function bezierToPolyline(aBezier: BEZIER, aSegments = 32): SEG[] {
	const pts = aBezier.Sample(aSegments);
	const segs: SEG[] = [];
	for (let i = 0; i < pts.length - 1; i++) {
		segs.push(new SEG(pts[i]!, pts[i + 1]!));
	}
	return segs;
}
