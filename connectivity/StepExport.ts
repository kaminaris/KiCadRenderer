/*
 * Ported from KiCad source:
 *   pcbnew/exporters/step/ (facet/solid export concept) — geometry conversion
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 * GPL-2.0-or-later.
 *
 * A coarse STEP-like solid export: triangulates a canonical 2D SHAPE and
 * extrudes it by a height into a list of facets (triangles), then emits them
 * via the FILE_WRITER. This is the geometry half of a 3D/STEP export (a real
 * STEP writer is a separate, much larger piece — not included here).
 */

import { Vec2 } from '../math/Vec2';
import { SHAPE } from '../geometry/Shape';
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { FILE_WRITER } from './ExportWriter';

/** A 3D triangle (facet). */
export interface FACET {
	a: { x: number; y: number; z: number };
	b: { x: number; y: number; z: number };
	c: { x: number; y: number; z: number };
}

/** Extrudes a closed 2D polygon into a prism of facets (top + bottom + sides). */
function extrudePolygon(pts: Vec2[], z: number): FACET[] {
	const facets: FACET[] = [];
	const n = pts.length;
	if (n < 3) {
		return facets;
	}
	// fan triangles for top/bottom
	for (let i = 1; i < n - 1; i++) {
		const p0 = pts[0]!, p1 = pts[i]!, p2 = pts[i + 1]!;
		facets.push(
			{ a: { x: p0.x, y: p0.y, z }, b: { x: p1.x, y: p1.y, z }, c: { x: p2.x, y: p2.y, z } },
			{ a: { x: p0.x, y: p0.y, z: 0 }, b: { x: p2.x, y: p2.y, z: 0 }, c: { x: p1.x, y: p1.y, z: 0 } },
		);
	}
	// side quads -> 2 triangles each
	for (let i = 0; i < n; i++) {
		const p = pts[i]!, q = pts[(i + 1) % n]!;
		facets.push(
			{ a: { x: p.x, y: p.y, z: 0 }, b: { x: q.x, y: q.y, z }, c: { x: p.x, y: p.y, z } },
			{ a: { x: p.x, y: p.y, z: 0 }, b: { x: q.x, y: q.y, z: 0 }, c: { x: q.x, y: q.y, z } },
		);
	}
	return facets;
}

/** Tessellates a canonical 2D SHAPE into a closed polygon ring (mm). */
function shapeToRing(shape: SHAPE): Vec2[] {
	if (shape instanceof SHAPE_CIRCLE) {
		const c = shape;
		const pts: Vec2[] = [];
		const segs = 48;
		for (let i = 0; i < segs; i++) {
			const ang = (i / segs) * Math.PI * 2;
			pts.push(new Vec2(c.GetCenter().x + c.GetRadius() * Math.cos(ang), c.GetCenter().y + c.GetRadius() * Math.sin(ang)));
		}
		return pts;
	}
	if (shape instanceof SHAPE_RECT) {
		const r = shape;
		return [
			new Vec2(r.GetStart().x, r.GetStart().y),
			new Vec2(r.GetStart().x + r.GetW(), r.GetStart().y),
			new Vec2(r.GetStart().x + r.GetW(), r.GetStart().y + r.GetH()),
			new Vec2(r.GetStart().x, r.GetStart().y + r.GetH()),
		];
	}
	if (shape instanceof SHAPE_SEGMENT) {
		// capsule: approximate with the two end semicircles
		const s = shape;
		const r = s.GetWidth() / 2;
		const v = s.GetPointB().sub(s.GetPointA());
		const len = v.magnitude || 1;
		const ux = v.x / len, uy = v.y / len;
		const ax = -uy, ay = ux;
		const base = Math.atan2(uy, ux);
		const segs = 48;
		const pts: Vec2[] = [];
		// start cap
		for (let i = 0; i <= segs / 2; i++) {
			const ang = base + Math.PI / 2 + (Math.PI * i) / (segs / 2);
			pts.push(new Vec2(s.GetPointA().x + r * Math.cos(ang), s.GetPointA().y + r * Math.sin(ang)));
		}
		// end cap
		for (let i = 0; i <= segs / 2; i++) {
			const ang = base - Math.PI / 2 + (Math.PI * i) / (segs / 2);
			pts.push(new Vec2(s.GetPointB().x + r * Math.cos(ang), s.GetPointB().y + r * Math.sin(ang)));
		}
		void ax; void ay;
		return pts;
	}
	if (shape instanceof SHAPE_POLY_SET) {
		const outline = shape.Outline(0);
		const pts: Vec2[] = [];
		for (let i = 0; i < outline.PointCount(); i++) {
			pts.push(outline.Point(i));
		}
		return pts;
	}
	return [];
}

/**
 * Converts a canonical SHAPE into an extruded solid's facets and writes them
 * to the FILE_WRITER (one "facet" line per triangle + the shape id).
 */
export function writeShapeSolid(
	aWriter: FILE_WRITER,
	aId: string,
	aShape: SHAPE,
	aHeight: number
): void {
	const ring = shapeToRing(aShape);
	const facets = extrudePolygon(ring, aHeight);
	aWriter.Printf(`solid %s`, aId);
	for (const f of facets) {
		aWriter.Printf('facet %f %f %f | %f %f %f | %f %f %f',
			f.a.x, f.a.y, f.a.z, f.b.x, f.b.y, f.b.z, f.c.x, f.c.y, f.c.z);
	}
	aWriter.Printf('endsolid %s', aId);
}
