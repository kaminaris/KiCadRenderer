import assert from 'assert';
import { delaunator } from '../math/Delaunator';
import { buildBoardRatsnest } from '../paint/legacy/BoardRatsnest';
import type { CopperGraph } from '../paint/legacy/BoardCopperGraph';
import { buildCopperGraph } from '../paint/legacy/BoardCopperGraph';
import { buildZoneFillIndex } from '../paint/ZoneFillIndex';
import { pointInPolygon } from '../paint/PaintedShape';
import { Vec2 } from '../math/Vec2';

// Regression tests for the Delaunay-based ratsnest MST.
//
// Two properties are checked:
//  1. The Delaunay MST must produce the SAME connectedness as the previous
//     complete-graph component MST — identical airwire count and total
//     airline length per net (both are minimum spanning trees of the island
//     graph, so total length is invariant).
//  2. The (full graph + netFilter) splice path must emit only the filtered
//     nets' lines, so the incremental drag refresh never touches other nets.

interface IslandDef { points: [number, number][]; }

function buildGraph(netIslands: Record<number, IslandDef[]>): { graph: CopperGraph; scene: any } {
	const nodes: { point: Vec2; layer: string; netId: number; itemId: string; itemKind: any }[] = [];
	const islandRootOfNode: number[] = [];
	const netKeys = Object.keys(netIslands).map(Number).sort((a, b) => a - b);
	for (const nid of netKeys) {
		for (const island of netIslands[nid]) {
			const root = nodes.length;
			for (const [x, y] of island.points) {
				nodes.push({ point: new Vec2(x, y), layer: 'F.Cu', netId: nid, itemId: 'i' + nodes.length, itemKind: 'pad' });
				islandRootOfNode.push(root);
			}
		}
	}
	const graph: CopperGraph = { nodes, segments: [], find: i => islandRootOfNode[i]!, adjacent: () => [] };
	return { graph, scene: {} as any };
}

const hyp = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

function referenceCompleteGraphMST(graph: CopperGraph): { netId: number; length: number; count: number }[] {
	const { nodes, find } = graph;
	const out: { netId: number; length: number; count: number }[] = [];
	const netIds = new Set(nodes.map(n => n.netId));
	for (const netId of netIds) {
		const componentMap = new Map<number, number[]>();
		for (let index = 0; index < nodes.length; index++) {
			if (nodes[index]!.netId !== netId) continue;
			const members = componentMap.get(find(index)) ?? [];
			members.push(index);
			componentMap.set(find(index), members);
		}
		const components = [...componentMap.values()];
		if (components.length < 2) continue;
		const edges: { a: number; b: number; length: number }[] = [];
		for (let a = 0; a < components.length; a++) {
			for (let b = a + 1; b < components.length; b++) {
				let best: { length: number } | null = null;
				for (const ai of components[a]!) for (const bi of components[b]!) {
					const p = nodes[ai]!.point, q = nodes[bi]!.point;
					const length = hyp(p.x, p.y, q.x, q.y);
					if (!best || length < best.length) best = { length };
				}
				if (best) edges.push({ a, b, ...best });
			}
		}
		edges.sort((x, y) => x.length - y.length);
		const cp = components.map((_, index) => index);
		const cf = (i: number): number => (cp[i] === i ? i : (cp[i] = cf(cp[i]!)));
		let total = 0, count = 0;
		for (const e of edges) {
			const ra = cf(e.a), rb = cf(e.b);
			if (ra === rb) continue;
			cp[rb] = ra;
			total += e.length;
			count++;
			if (count >= components.length - 1) break;
		}
		out.push({ netId, length: total, count });
	}
	return out;
}

function compareWithReference(netIslands: Record<number, IslandDef[]>): void {
	const { graph, scene } = buildGraph(netIslands);
	const newLines = buildBoardRatsnest(scene, undefined, graph);

	const byNetNew = new Map<number, { count: number; len: number }>();
	for (const l of newLines) {
		const e = byNetNew.get(l.netId) ?? { count: 0, len: 0 };
		e.count++; e.len += hyp(l.from.x, l.from.y, l.to.x, l.to.y);
		byNetNew.set(l.netId, e);
	}
	const byNetRef = new Map<number, { count: number; len: number }>();
	for (const r of referenceCompleteGraphMST(graph)) byNetRef.set(r.netId, { count: r.count, len: r.length });

	const nets = new Set([...byNetNew.keys(), ...byNetRef.keys()]);
	for (const net of nets) {
		const n = byNetNew.get(net) ?? { count: 0, len: 0 };
		const r = byNetRef.get(net) ?? { count: 0, len: 0 };
		assert.strictEqual(n.count, r.count, `net ${net} airwire count`);
		assert.ok(Math.abs(n.len - r.len) < 1e-6, `net ${net} total length`);
	}
}

// Delaunator basic triangulation of a square + center -> 4 triangles.
{
	const r = delaunator([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
	assert.strictEqual(r.triangles.length / 3, 4, 'square+center triangulates to 4 triangles');
}
// Collinear / degenerate -> empty triangulation (callers chain instead).
assert.strictEqual(delaunator([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]).triangles.length, 0, 'collinear returns empty');

// Equivalence with the old complete-graph MST, across representative cases.
compareWithReference({ 1: [{ points: [[0, 0], [0.2, 0]] }, { points: [[10, 0]] }, { points: [[5, 9]] }] });
compareWithReference({
	1: [{ points: [[0, 0]] }, { points: [[1, 0]] }, { points: [[2, 0]] }, { points: [[5, 0]] }],
	2: [{ points: [[0, 5]] }, { points: [[0, 9]] }],
});
// Dense meshed islands.
{
	const islands: IslandDef[] = [];
	for (let i = 0; i < 40; i++) {
		islands.push({ points: [[(i % 8) * 10, Math.floor(i / 8) * 12], [(i % 8) * 10 + 1, Math.floor(i / 8) * 12]] });
	}
	compareWithReference({ 1: islands });
}

// (full graph + netFilter) splice path: only filtered nets' lines, correct counts.
{
	const islands: IslandDef[] = [];
	const net: Record<number, IslandDef[]> = { 1: islands, 2: [], 3: [] };
	for (let i = 0; i < 10; i++) islands.push({ points: [[i * 3, 0], [i * 3, 2]] });
	for (let i = 0; i < 8; i++) net[2]!.push({ points: [[5, 50 + i]] });
	for (let i = 0; i < 5; i++) net[3]!.push({ points: [[80, 50 + i * 2]] });
	const { graph, scene } = buildGraph(net);
	const lines = buildBoardRatsnest(scene, new Set([1, 3]), graph);
	const lineNets = new Set(lines.map(l => l.netId));
	assert.ok(lineNets.has(1) && lineNets.has(3), 'filtered nets produced');
	assert.ok(!lineNets.has(2), 'non-filtered net excluded');
	assert.strictEqual(lines.filter(l => l.netId === 1).length, 9, 'net1 airwire count with full graph + filter');
	assert.strictEqual(lines.filter(l => l.netId === 3).length, 4, 'net3 airwire count with full graph + filter');
}

// --- Fix 1: ZoneFillIndex containsPoint must exactly match pointInPolygon ---
{
	const rnd = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
	const compare = (poly: { x: number; y: number }[], samples: number, label: string): void => {
		const idx = buildZoneFillIndex(poly);
		const r = rnd(123);
		let mm = 0;
		for (let i = 0; i < samples; i++) {
			const x = r() * 40 - 5, y = r() * 40 - 5;
			const expected = pointInPolygon(poly, x, y);
			const got = idx ? idx.containsPoint(x, y) : pointInPolygon(poly, x, y);
			if (expected !== got) mm++;
		}
		assert.ok(mm === 0, `${ label }: containsPoint matches pointInPolygon (${ mm } mismatches)`);
		assert.ok(idx !== null, `${ label }: zone index built`);
	};
	compare([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }], 6000, 'concave L');
	const star: { x: number; y: number }[] = [];
	for (let i = 0; i < 60; i++) { const a = (i / 60) * Math.PI * 2; const rad = i % 2 === 0 ? 30 : 12; star.push({ x: 50 + rad * Math.cos(a), y: 50 + rad * Math.sin(a) }); }
	compare(star, 12000, '60-vertex concave star');
}

// --- Fix 1: zone connectivity (pads in pour connect, notch/outside isolated) ---
{
	const fill = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }];
	const pads = [
		{ id: 'p1', x: 2, y: 2 }, { id: 'p2', x: 8, y: 2 }, { id: 'p3', x: 7, y: 7 }, { id: 'p4', x: 2, y: 8 },
	];
	const bucket: any[] = [];
	for (const p of pads) {
		bucket.push({
			id: p.id, kind: 'pad', netId: 7, layer: 'F.Cu', element: { uuid: p.id, parent: undefined, padNumber: '1' },
			bbox: { x: p.x - 0.5, y: p.y - 0.5, w: 1, h: 1 }, shape: { type: 'rect', x: p.x - 0.5, y: p.y - 0.5, w: 1, h: 1, filled: true },
		});
	}
	const scene = { copperLayerStack: ['F.Cu', 'B.Cu'], layersPresent: ['F.Cu', 'B.Cu'], layerBuckets: new Map([['F.Cu', bucket]]), zoneFills: [{ netId: 7, layer: 'F.Cu', points: fill }], hitTest: bucket };
	const g = buildCopperGraph(scene);
	const p1root = g.find(g.nodes.findIndex(n => n.itemId === 'p1')!);
	assert.ok(g.find(g.nodes.findIndex(n => n.itemId === 'p2')!) === p1root, 'L pour: p2 same island as p1');
	assert.ok(g.find(g.nodes.findIndex(n => n.itemId === 'p4')!) === p1root, 'L pour: p4 same island as p1');
	assert.ok(g.find(g.nodes.findIndex(n => n.itemId === 'p3')!) !== p1root, 'L pour: p3 (notch) isolated');
}

console.log('ratsnest tests passed');
