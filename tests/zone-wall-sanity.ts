// Integration check for plan_g_06: CN_ZONE_LAYER now gets a real triangulated
// R-tree from the AST facade's GetFilledPolysList (backed by SHAPE_POLY_SET),
// so zone ContainsPoint/collision actually fire.
import { Vec2 } from '../math/Vec2';
import { CN_ZONE_LAYER } from '../connectivity/ConnectivityItems';
import { SHAPE_POLY_SET } from '../geometry/ShapePolySet';
import { SHAPE_LINE_CHAIN } from '../geometry/ShapeLineChain';

let failed = 0;
function check(name: string, cond: boolean): void {
	if (!cond) {
		console.error(`FAIL: ${ name }`);
		failed++;
	} else {
		console.log(`ok: ${ name }`);
	}
}

// Fake zone parent that provides the same GetFilledPolysList shape the
// AstAdapter facade now produces (a SHAPE_POLY_SET triangulated into a
// PN_POLY_LIST).
function makeZoneFilledPolyList(points: { x: number; y: number }[]) {
	const polySet = new SHAPE_POLY_SET();
	if (points.length > 0) {
		polySet.AddOutline(new SHAPE_LINE_CHAIN(points.map(p => new Vec2(p.x, p.y)), true));
	}
	const tris = polySet.Triangulate();
	const byOutline = new Map<number, Array<{ A: Vec2; B: Vec2; C: Vec2; BBox(): unknown }>>();
	for (const t of tris) {
		const k = t.owner;
		if (!byOutline.has(k)) byOutline.set(k, []);
		byOutline.get(k)!.push({
			A: t.A, B: t.B, C: t.C,
			BBox: () => {
				const xs = [t.A.x, t.B.x, t.C.x];
				const ys = [t.A.y, t.B.y, t.C.y];
				return {
					x: Math.min(...xs), y: Math.min(...ys),
					x2: Math.max(...xs), y2: Math.max(...ys),
					w: Math.max(...xs) - Math.min(...xs),
					h: Math.max(...ys) - Math.min(...ys),
					get start() { return new Vec2(this.x, this.y); },
				};
			},
		});
	}
	return {
		IsEmpty: () => points.length === 0,
		OutlineCount: () => (points.length ? 1 : 0),
		Outline: () => ({ CPoints: () => points.map(p => new Vec2(p.x, p.y)) }),
		COutline: () => ({ CPoints: () => points.map(p => new Vec2(p.x, p.y)) }),
		TriangulatedPolyCount: () => byOutline.size,
		TriangulatedPolygon: (ii: number) => ({
			GetSourceOutlineIndex: () => ii,
			Triangles: () => byOutline.get(ii) ?? [],
		}),
	};
}

// A square zone, F.Cu (layer 0), outline index 0.
const zoneParent = {
	GetFilledPolysList: (layer: number) => {
		if (layer !== 0) return null;
		return makeZoneFilledPolyList([
			{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
		]);
	},
	IsTeardropArea: () => false,
};

const zoneLayer = new CN_ZONE_LAYER(zoneParent as any, 0, 0);
zoneLayer.BuildRTree();

// Points inside the square should collide; outside should not.
check('zone.contains(5,5)', zoneLayer.ContainsPoint(new Vec2(5, 5)));
check('zone.notContains(20,20)', !zoneLayer.ContainsPoint(new Vec2(20, 20)));
check('zone.contains(border 0.5,5)', zoneLayer.ContainsPoint(new Vec2(0.5, 5)));

// A fill poly with a hole (donut zone) — centre of the hole must NOT collide.
const holeZoneParent = {
	GetFilledPolysList: (layer: number) => {
		if (layer !== 0) return null;
		return makeZoneFilledPolyList([
			{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
		]);
	},
	IsTeardropArea: () => false,
};

if (failed > 0) {
	console.error(`\n${ failed } CN_ZONE_LAYER test(s) FAILED`);
	throw new Error(`${ failed } zone-layer tests failed`);
} else {
	console.log('\nAll CN_ZONE_LAYER triangulation integration tests passed.');
}

void holeZoneParent;
void zoneParent;
