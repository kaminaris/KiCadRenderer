// Sanity test for the geometry (kimath) parity port primitives.
// Run with: node <transpiled> or via the app's TS setup.
import { Vec2 } from '../math/Vec2';
import { BBox } from '../math/BBox';
import { SHAPE_SEGMENT } from '../geometry/ShapeSegment';
import { SHAPE_RECT } from '../geometry/ShapeRect';
import { SHAPE_CIRCLE } from '../geometry/ShapeCircle';
import { SHAPE_LINE_CHAIN } from '../geometry/ShapeLineChain';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SHAPE_COLLISION } from '../geometry/ShapeCollision';
import { SHAPE_COMPOUND } from '../geometry/ShapeCompound';
import { SHAPE_INDEX_LIST } from '../geometry/ShapeIndexList';
import { ConvertToPolygon } from '../geometry/ConvertToPolygon';
import { SHAPE_ARC } from '../geometry/ShapeArc';

let failed = 0;
function check(name: string, cond: boolean): void {
	if (!cond) {
		console.error(`FAIL: ${ name }`);
		failed++;
	} else {
		console.log(`ok: ${ name }`);
	}
}

// SHAPE_SEGMENT
{
	const seg = new SHAPE_SEGMENT(new Vec2(0, 0), new Vec2(10, 0), 2);
	check('seg.bounds includes midpoint', seg.BBox().x <= -1 && seg.BBox().x2 >= 11);
	check('seg.collides on line', seg.CollidePoint(new Vec2(5, 0), 0));
	check('seg.collides within width', seg.CollidePoint(new Vec2(5, 0.99), 0));
	check('seg.distance to side', Math.abs(seg.Distance(new Vec2(5, 10)) - (10 - 1)) < 1e-9);
}

// SHAPE_RECT
{
	const rect = new SHAPE_RECT(new Vec2(1, 2), new Vec2(4, 6));
	check('rect.bounds', rect.BBox().w === 4 && rect.BBox().h === 6);
	check('rect.contains inside', rect.CollidePoint(new Vec2(3, 5), 0));
	check('rect.outside', !rect.CollidePoint(new Vec2(10, 10), 0));
	check('rect.distance 0 inside', rect.Distance(new Vec2(3, 5)) === 0);
}

// SHAPE_CIRCLE
{
	const c = new SHAPE_CIRCLE(new Vec2(0, 0), 5);
	check('circle.contains', c.CollidePoint(new Vec2(4, 0), 0));
	check('circle.outside', !c.CollidePoint(new Vec2(6, 0), 0));
	check('circle.distance', Math.abs(c.Distance(new Vec2(10, 0)) - 5) < 1e-9);
}

// SHAPE_LINE_CHAIN
{
	const chain = new SHAPE_LINE_CHAIN([new Vec2(0, 0), new Vec2(10, 0), new Vec2(10, 10)], false);
	check('chain.count', chain.PointCount() === 3);
	check('chain.seast.cnt', chain.SegmentCount() === 2);
	check('chain.distance to seg', Math.abs(chain.Distance(new Vec2(5, 5)) - 5) < 1e-9);
	const closed = new SHAPE_LINE_CHAIN([new Vec2(0, 0), new Vec2(10, 0), new Vec2(10, 10)], true);
	check('closed.seacnt', closed.SegmentCount() === 3);
	check('chain.valid', chain.Valid());
}

// SHAPE_POLY_SET
{
	const ps = new SHAPE_POLY_SET();
	// Add an L-shaped / square outline
	const outline = new SHAPE_LINE_CHAIN(
		[new Vec2(0, 0), new Vec2(10, 0), new Vec2(10, 10), new Vec2(0, 10)],
		true
	);
	ps.AddOutline(outline);

	check('polyset.outlineCount', ps.OutlineCount() === 1);
	check('polyset.contains centroid', ps.Contains(new Vec2(5, 5)));
	check('polyset.notContains corner-out', !ps.Contains(new Vec2(15, 5)));
	check('polyset.bbox', ps.BBox().x === 0 && ps.BBox().x2 === 10);

	// Add a hole
	ps.AddHole(
		new SHAPE_LINE_CHAIN([new Vec2(2, 2), new Vec2(4, 2), new Vec2(4, 4), new Vec2(2, 4)], true),
		0
	);
	check('polyset.holeCount', ps.HoleCount(0) === 1);
	check('polyset.contains outside hole', ps.Contains(new Vec2(1, 1)));
	check('polyset.notContains inside hole', !ps.Contains(new Vec2(3, 3)));

	// Triangulation covers the polygon area
	const tris = ps.Triangulate();
	check('polyset.triangulate.someTris', tris.length > 0);
	let totalArea = 0;
	for (const t of tris) {
		totalArea += Math.abs(0.5 * crossTri(t.A, t.B, t.C));
	}
	// Square area 100 minus hole area 4 = 96
	check('polyset.triangulate.area', Math.abs(totalArea - 96) < 3); // within a 2-unit seam sliver
}

// SHAPE_POLY_SET boolean (union of two overlapping squares)
{
	const sq = (x0: number, y0: number, x1: number, y1: number): SHAPE_POLY_SET => {
		const p = new SHAPE_POLY_SET();
		p.AddOutline(new SHAPE_LINE_CHAIN(
			[new Vec2(x0, y0), new Vec2(x1, y0), new Vec2(x1, y1), new Vec2(x0, y1)],
			true
		));
		return p;
	};
	const a = sq(0, 0, 10, 10);
	const b = sq(5, 5, 15, 15);
	a.BooleanAdd(b);
	check('polyset.union.outlineCount', a.OutlineCount() === 1);
	// Union bbox spans 0..15 in both axes
	check('polyset.union.bbox', a.BBox().x === 0 && a.BBox().x2 === 15 && a.BBox().y2 === 15);
	check('polyset.union.contains overlap-center', a.Contains(new Vec2(7.5, 7.5)));
}

function crossTri(a: Vec2, b: Vec2, c: Vec2): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// SHAPE_COLLISION
{
	const collision = new SHAPE_COLLISION(0);

	// Crossing perpendicular segments collide
	const s1 = new SHAPE_SEGMENT(new Vec2(0, 0), new Vec2(10, 0), 1);
	const seg2 = new SHAPE_SEGMENT(new Vec2(5, -5), new Vec2(5, 5), 1);
	const col = collision.Collide(s1, seg2);
	check('collision.segcross', col.intersecting);

	// Parallel, far apart segments do not collide
	const far = new SHAPE_SEGMENT(new Vec2(0, 0), new Vec2(10, 0), 1);
	const far2 = new SHAPE_SEGMENT(new Vec2(0, 100), new Vec2(10, 100), 1);
	check('collision.segfar-not', !collision.Collide(far, far2).intersecting);

	// Circle vs segment within clearance
	const c1 = new SHAPE_CIRCLE(new Vec2(5, 0.9), 1);
	check('collision.circle-seg-close', collision.Collide(c1, s1).intersecting);
	const c2 = new SHAPE_CIRCLE(new Vec2(5, 100), 1);
	check('collision.circle-seg-far-not', !collision.Collide(c2, s1).intersecting);

	// Specialize the segments for the poly-set collide test
	const poly = new SHAPE_POLY_SET();
	poly.AddOutline(new SHAPE_LINE_CHAIN(
		[new Vec2(0, 0), new Vec2(10, 0), new Vec2(10, 10), new Vec2(0, 10)],
		true
	));
	// Segment crossing into the poly area
	const segIn = new SHAPE_SEGMENT(new Vec2(5, -1), new Vec2(5, 1), 0.5);
	check('collision.poly-seg', collision.Collide(poly, segIn).intersecting);
	// Segment far away
	const segOut = new SHAPE_SEGMENT(new Vec2(5, 30), new Vec2(5, 40), 0.5);
	check('collision.poly-seg-far-not', !collision.Collide(poly, segOut).intersecting);
}

// SHAPE_COMPOUND (union of shapes)
{
	const a = new SHAPE_RECT(new Vec2(0, 0), new Vec2(4, 4));
	const b = new SHAPE_CIRCLE(new Vec2(8, 8), 2);
	const comp = new SHAPE_COMPOUND([a, b]);
	check('compound.contains member a', comp.Contains(new Vec2(2, 2)));
	check('compound.contains member b', comp.Contains(new Vec2(8, 8)));
	check('compound.notContains gap', !comp.Contains(new Vec2(6, 6)));
	check('compound.bbox covers both', comp.BBox().x === 0 && comp.BBox().x2 === 10 && comp.BBox().y2 === 10);
	check('compound.distance to member', Math.abs(comp.Distance(new Vec2(8, 12)) - 2) < 1e-9);
}

// SHAPE_INDEX_LIST (AABB range queries)
{
	const idx = new SHAPE_INDEX_LIST<SHAPE_RECT>();
	const r0 = new SHAPE_RECT(new Vec2(0, 0), new Vec2(2, 2));
	const r1 = new SHAPE_RECT(new Vec2(4, 4), new Vec2(2, 2));
	const r2 = new SHAPE_RECT(new Vec2(8, 8), new Vec2(2, 2));
	idx.Add(r0);
	idx.Add(r1);
	idx.Add(r2);
	check('indexlist.size', idx.Size() === 3);
	// Query a box overlapping r1 only
	const hits = idx.QueryBox(new BBox(3.5, 3.5, 4, 4), 0);
	check('indexlist.query finds r1', hits.length === 1 && hits[0] === r1);
	// Clearance query catches a nearby shape
	const hits2 = idx.QueryBox(new BBox(3.6, 3.6, 0, 0), 0.5);
	check('indexlist.query clearance', hits2.includes(r1) && !hits2.includes(r2));
	// Remove
	idx.Remove(r1);
	check('indexlist.remove', idx.Size() === 2);
	check('indexlist.bbox union', idx.BBox().x === 0 && idx.BBox().x2 === 10 && idx.BBox().y2 === 10);
}

// ConvertToPolygon (shape -> filled polygon with clearance)
{
	// A circle of radius 5 with clearance becomes a polygon containing ~25 area-ish.
	const c = new SHAPE_CIRCLE(new Vec2(0, 0), 5);
	const poly = ConvertToPolygon(c, 0, 0.01);
	let area = 0;
	for (const t of poly.Triangulate()) {
		area += Math.abs(0.5 * (t.A.x * (t.B.y - t.C.y) + t.B.x * (t.C.y - t.A.y) + t.C.x * (t.A.y - t.B.y)));
	}
	// circle area = pi*25 ~= 78.54
	check('convert.circle area', Math.abs(area - Math.PI * 25) < 3);

	// Rounded rect (corner radius) has area between the plain rect and the rounded rect.
	const rr = ConvertToPolygon(new SHAPE_RECT(new Vec2(0, 0), new Vec2(4, 4)), 0, 0.01);
	let rrArea = 0;
	for (const t of rr.Triangulate()) {
		rrArea += Math.abs(0.5 * (t.A.x * (t.B.y - t.C.y) + t.B.x * (t.C.y - t.A.y) + t.C.x * (t.A.y - t.B.y)));
	}
	check('convert.rect area 16', Math.abs(rrArea - 16) < 0.5);
}

// SHAPE_ARC (3-point)
{
	const arc = new SHAPE_ARC(new Vec2(0, 0), new Vec2(10, 0), new Vec2(0, -10));
	// Circumcenter of (0,0),(10,0),(0,-10) is (5,-5), radius = sqrt(50).
	check('arc.center', Math.abs(arc.GetCenter().x - 5) < 1e-6 && Math.abs(arc.GetCenter().y + 5) < 1e-6);
	check('arc.radius', Math.abs(arc.GetRadius() - Math.sqrt(50)) < 1e-6);
}

if (failed > 0) {
	console.error(`\n${ failed } test(s) FAILED`);
	throw new Error(`${ failed } geometry tests failed`);
} else {
	console.log('\nAll geometry primitive tests passed.');
}
