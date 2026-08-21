/*
 * Ported from KiCad source:
 *   pcbnew/convert_shape_list_to_polygon.cpp
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * Converts a SHAPE (rect / circle / segment / arc / rounded-rect / oval) into
 * a filled SHAPE_POLY_SET, with an optional clearance (expansion). This is the
 * engine behind KiCad's zone-fill clearance, thermal relief, pad effective
 * polygons and DRC. Coordinates in mm.
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE } from './Shape';
import { SHAPE_TYPE } from './Shape';
import { SHAPE_SEGMENT } from './ShapeSegment';
import { SHAPE_RECT } from './ShapeRect';
import { SHAPE_CIRCLE } from './ShapeCircle';
import { SHAPE_ARC } from './ShapeArc';
import { SHAPE_LINE_CHAIN, arcToPolyline } from './ShapeLineChain';
import { SHAPE_POLY_SET } from './ShapePolySet';
import { getClipperEngine } from '../paint/ClipperEngine';
import { ClipType } from '@clipper2-ts/engine';
import { FillRule, Paths, Point64Of } from '@clipper2-ts/core';
import { JoinType, EndType } from '@clipper2-ts/offset';

const NM_PER_MM = 1_000_000;

function toClipper(points: Iterable<Vec2>): Paths {
	const arr: Paths = [];
	let path: (ReturnType<typeof Point64Of>)[] = [];
	for (const p of points) {
		path.push(Point64Of(p.x * NM_PER_MM, p.y * NM_PER_MM));
	}
	if (path.length) {
		arr.push(path as unknown as import('@clipper2-ts/core').Path);
	}
	return arr;
}

function fromClipper(paths: Paths): Vec2[][] {
	return paths.map(p => (p as unknown as Array<{ x: number; y: number }>).map(q => new Vec2(q.x / NM_PER_MM, q.y / NM_PER_MM)));
}

/** Number of segments for a full circle given the error tolerance. */
function circleSegmentCount(aError: number): number {
	const count = Math.round(Math.PI / Math.acos(1 - aError / 1.0));
	return Math.max(12, count);
}

/**
 * Approximates a circle (center, radius) as a polygon in `aPoly`.
 * Mirrors KiCad's TransformCircleToPolygon.
 */
export function TransformCircleToPolygon(aPoly: SHAPE_POLY_SET, aCenter: Vec2, aRadius: number, aError: number): void {
	if (aRadius <= 0) {
		return;
	}
	const segments = circleSegmentCount(aError);
	const outline = new SHAPE_LINE_CHAIN([], true);
	for (let i = 0; i < segments; i++) {
		const ang = (i / segments) * Math.PI * 2;
		outline.Append(new Vec2(aCenter.x + aRadius * Math.cos(ang), aCenter.y + aRadius * Math.sin(ang)));
	}
	aPoly.AddOutline(outline);
}

/**
 * Approximates a rounded rectangle (pos = top-left, size = w/h, cornerRadius)
 * as a polygon. Mirrors KiCad's TransformRoundRectToPolygon.
 */
export function TransformRoundRectToPolygon(
	aPoly: SHAPE_POLY_SET,
	aPos: Vec2,
	aSize: Vec2,
	aCornerRadius: number,
	aError: number
): void {
	const radius = Math.max(0, Math.min(aCornerRadius, Math.min(aSize.x, aSize.y) / 2));
	const w = aSize.x;
	const h = aSize.y;
	const x = aPos.x;
	const y = aPos.y;

	const outline = new SHAPE_LINE_CHAIN([], true);

	// Sample the four rounded corners plus the straight edges.
	const sampleCorner = (cx: number, cy: number, startAng: number, sweepAng: number): void => {
		const segments = circleSegmentCount(aError);
		// quarter corner -> segments/4
		const n = Math.max(2, Math.round(segments / 4));
		for (let i = 0; i <= n; i++) {
			const ang = startAng + (i / n) * sweepAng;
			outline.Append(new Vec2(cx + radius * Math.cos(ang), cy + radius * Math.sin(ang)));
		}
	};

	if (radius > 0) {
		// Top-right corner (radius centered at x+w-r, y+r), 0..90 deg
		sampleCorner(x + w - radius, y + radius, 0, Math.PI / 2);
		// Top-right to bottom-right straight edge is covered by the next corner's start.
		sampleCorner(x + w - radius, y + h - radius, Math.PI / 2, Math.PI / 2);
		sampleCorner(x + radius, y + h - radius, Math.PI, Math.PI / 2);
		sampleCorner(x + radius, y + radius, (3 * Math.PI) / 2, Math.PI / 2);
	} else {
		outline.Append(new Vec2(x, y));
		outline.Append(new Vec2(x + w, y));
		outline.Append(new Vec2(x + w, y + h));
		outline.Append(new Vec2(x, y + h));
	}

	aPoly.AddOutline(outline);
}

/**
 * Approximates an oval (a wide segment) as a polygon. Mirrors KiCad's
 * TransformOvalToPolygon: a segment of the given width inflated to a poly.
 */
export function TransformOvalToPolygon(
	aPoly: SHAPE_POLY_SET,
	aStart: Vec2,
	aEnd: Vec2,
	aWidth: number,
	aError: number
): void {
	if (aWidth <= 0) {
		return;
	}
	TransformSegmentToPolygon(aPoly, aStart, aEnd, aWidth, aError);
}

/**
 * Converts a segment (capsule) into a polygon: a rectangle inflated at the
 * ends into two semicircles (round caps). Mirrors KiCad's
 * TransformSegmentToPolygon.
 */
export function TransformSegmentToPolygon(
	aPoly: SHAPE_POLY_SET,
	aStart: Vec2,
	aEnd: Vec2,
	aWidth: number,
	aError: number
): void {
	if (aWidth <= 0) {
		return;
	}
	const r = aWidth / 2;
	const v = aEnd.sub(aStart);
	const len = v.magnitude;

	if (len < 1e-12) {
		TransformCircleToPolygon(aPoly, aStart, r, aError);
		return;
	}

	const ux = v.x / len;
	const uy = v.y / len;

	const outline = new SHAPE_LINE_CHAIN([], true);
	const halfSegs = Math.max(2, Math.round(circleSegmentCount(aError) / 2));

	// Robust capsule construction: two end semicircles (+-90deg around the
	// axis) joined at the two caps, producing a round-ended rectangle.
	const baseAng = Math.atan2(uy, ux);
	// Start cap: center aStart, angles [baseAng+pi/2 .. baseAng+3pi/2]
	for (let i = 0; i <= halfSegs; i++) {
		const ang = baseAng + Math.PI / 2 + (Math.PI * i) / halfSegs;
		outline.Append(new Vec2(aStart.x + r * Math.cos(ang), aStart.y + r * Math.sin(ang)));
	}
	// End cap: center aEnd, angles [baseAng-pi/2 .. baseAng+pi/2]
	for (let i = 0; i <= halfSegs; i++) {
		const ang = baseAng - Math.PI / 2 + (Math.PI * i) / halfSegs;
		outline.Append(new Vec2(aEnd.x + r * Math.cos(ang), aEnd.y + r * Math.sin(ang)));
	}

	aPoly.AddOutline(outline);
}

/**
 * Converts an arc into a polygon by sampling the arc centerline and inflating
 * it by the width (round ends). Mirrors KiCad's TransformArcToPolygon.
 */
export function TransformArcToPolygon(
	aPoly: SHAPE_POLY_SET,
	aStart: Vec2,
	aMid: Vec2,
	aEnd: Vec2,
	aWidth: number,
	aError: number
): void {
	const arc = new SHAPE_ARC(aStart, aMid, aEnd);
	const polyline = arcToPolyline(arc, 0, circleSegmentCount(aError));

	const subjects: Paths = [];
	for (let i = 0; i < polyline.length - 1; i++) {
		subjects.push(toClipper([polyline[i]!, polyline[i + 1]!])[0]!);
	}

	const inflated = getClipperEngine().inflatePaths(
		subjects,
		(aWidth / 2) * NM_PER_MM,
		JoinType.Round,
		EndType.Round
	);
	replacePolyset(aPoly, inflated);
}

function replacePolyset(poly: SHAPE_POLY_SET, clipperPaths: Paths): void {
	const union = getClipperEngine().booleanOp(ClipType.Union, FillRule.EvenOdd, clipperPaths, []);
	for (const path of union) {
		const pts = fromClipper([path])[0]!;
		if (pts.length > 2) {
			poly.AddOutline(new SHAPE_LINE_CHAIN(pts, true));
		}
	}
}

/**
 * Converts a generic SHAPE into a filled polygon with the given clearance.
 * Mirrors KiCad's ConvertToPolygon / TransformShapeWithClearanceToPolygon
 * (shape-type dispatch).
 *
 * `aClearance` expands the shape outward (mm). `aError` is the tessellation
 * tolerance (mm).
 */
export function TransformShapeWithClearanceToPolygon(
	aShape: SHAPE,
	aPoly: SHAPE_POLY_SET,
	aClearance: number,
	aError: number
): void {
	switch (aShape.Type()) {
		case SHAPE_TYPE.RECT: {
			const r = aShape as SHAPE_RECT;
			const r2 = aClearance;
			const outline = new SHAPE_LINE_CHAIN(
				[
					new Vec2(r.GetStart().x - r2, r.GetStart().y - r2),
					new Vec2(r.GetStart().x + r.GetW() + r2, r.GetStart().y - r2),
					new Vec2(r.GetStart().x + r.GetW() + r2, r.GetStart().y + r.GetH() + r2),
					new Vec2(r.GetStart().x - r2, r.GetStart().y + r.GetH() + r2),
				],
				true
			);
			aPoly.AddOutline(outline);
			return;
		}
		case SHAPE_TYPE.CIRCLE: {
			const c = aShape as SHAPE_CIRCLE;
			TransformCircleToPolygon(aPoly, c.GetCenter(), c.GetRadius() + aClearance, aError);
			return;
		}
		case SHAPE_TYPE.SEGMENT: {
			const s = aShape as SHAPE_SEGMENT;
			TransformOvalToPolygon(aPoly, s.GetStart(), s.GetEnd(), s.GetWidth() + 2 * aClearance, aError);
			return;
		}
		case SHAPE_TYPE.ARC: {
			const a = aShape as SHAPE_ARC;
			TransformArcToPolygon(aPoly, a.GetStart(), a.GetMidPoint(), a.GetEnd(), a.GetWidth() + 2 * aClearance, aError);
			return;
		}
		case SHAPE_TYPE.POLY_SET: {
			const ps = aShape as SHAPE_POLY_SET;
			if (aClearance > 0) {
				ps.Inflate(aClearance);
			}
			for (let i = 0; i < ps.OutlineCount(); i++) {
				aPoly.AddOutline(ps.Outline(i));
			}
			return;
		}
		case SHAPE_TYPE.COMPOUND: {
			for (const sub of (aShape as import('./ShapeCompound').SHAPE_COMPOUND).GetSubshapes()) {
				TransformShapeWithClearanceToPolygon(sub, aPoly, aClearance, aError);
			}
			return;
		}
		default:
			return;
	}
}

/** Dot / connectivity helper type for future polygon QA (stub kept for parity). */
export type ConvertPolygonResult = { polygons: SHAPE_POLY_SET };

/**
 * Convenience wrapper returning a fresh SHAPE_POLY_SET.
 */
export function ConvertToPolygon(aShape: SHAPE, aClearance = 0, aError = 0.0005): SHAPE_POLY_SET {
	const poly = new SHAPE_POLY_SET();
	TransformShapeWithClearanceToPolygon(aShape, poly, aClearance, aError);
	return poly;
}
