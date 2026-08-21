import { Vec2 } from '../math/Vec2';
import { delaunator } from '../math/Delaunator';
import type { LayeredBoardScene } from './BoardPainter';
import { buildCopperGraph, type CopperGraph } from './BoardCopperGraph';

export interface BoardRatsnestLine {
	from: Vec2;
	to: Vec2;
	netId: number;
}

type Anchor = { x: number; y: number; island: number };

export function buildRatsnestFromAnchors(anchorsByNet: Map<number, Anchor[]>, bench = false): BoardRatsnestLine[] {
	const result: BoardRatsnestLine[] = [];

	for (const [netId, anchors] of anchorsByNet) {
		if (anchors.length < 2) continue;

		const tStart = bench ? performance.now() : 0;

		// Zero-length candidates between different islands at one position.
		const interIslandSamePositionEdges: { a: number; b: number }[] = [];
		{
			const byPosition = new Map<string, number[]>();
			for (let i = 0; i < anchors.length; i++) {
				const key = `${ anchors[i]!.x }\u0000${ anchors[i]!.y }`;
				const list = byPosition.get(key) ?? [];
				list.push(i);
				byPosition.set(key, list);
			}
			for (const list of byPosition.values()) {
				if (list.length < 2) continue;
				for (let a = 0; a < list.length; a++) {
					for (let b = a + 1; b < list.length; b++) {
						const ia = list[a]!, ib = list[b]!;
						if (anchors[ia]!.island !== anchors[ib]!.island) {
							interIslandSamePositionEdges.push({ a: ia, b: ib });
						}
					}
				}
			}
		}

		// Delaunay candidate edges over the distinct anchor positions.
		const triangulation = delaunator(anchors.map(p => ({ x: p.x, y: p.y })));
		const delaunayEdges: { a: number; b: number }[] = [];
		if (triangulation.triangles.length > 0) {
			const seen = new Set<string>();
			for (let i = 0; i < triangulation.triangles.length; i += 3) {
				const i0 = triangulation.triangles[i]!;
				const i1 = triangulation.triangles[i + 1]!;
				const i2 = triangulation.triangles[i + 2]!;
				pushUndirectedEdge(seen, delaunayEdges, i0, i1);
				pushUndirectedEdge(seen, delaunayEdges, i1, i2);
				pushUndirectedEdge(seen, delaunayEdges, i2, i0);
			}
		} else if (anchors.length >= 2) {
			const sorted = anchors.map((anchor, index) => ({ index, ...anchor }));
			sorted.sort((a, b) => a.x - b.x || a.y - b.y);
			for (let i = 0; i < sorted.length - 1; i++) {
				delaunayEdges.push({ a: sorted[i]!.index, b: sorted[i + 1]!.index });
			}
		}

		const allEdges = dedupeEdges([
			...delaunayEdges,
			...interIslandSamePositionEdges,
		]);
		allEdges.sort((e1, e2) => {
			const la = lengthBetween(anchors[e1.a]!, anchors[e1.b]!);
			const lb = lengthBetween(anchors[e2.a]!, anchors[e2.b]!);
			return la - lb;
		});

		const maxIsland = anchors.reduce((m, a) => Math.max(m, a.island), -Infinity);
		const islandParent = new Array(maxIsland + 1).fill(0).map((_, i) => i);
		const islandFind = (index: number): number => {
			while (islandParent[index] !== index) {
				islandParent[index] = islandParent[islandParent[index]!]!;
				index = islandParent[index]!;
			}
			return index;
		};
		const union = (a: number, b: number): void => {
			const ra = islandFind(a), rb = islandFind(b);
			if (ra !== rb) islandParent[rb] = ra;
		};

		let addedForNet = 0;
		for (const edge of allEdges) {
			const aIsland = anchors[edge.a]!.island;
			const bIsland = anchors[edge.b]!.island;
			if (islandFind(aIsland) === islandFind(bIsland)) continue;
			union(aIsland, bIsland);
			result.push({
				from: new Vec2(anchors[edge.a]!.x, anchors[edge.a]!.y),
				to: new Vec2(anchors[edge.b]!.x, anchors[edge.b]!.y),
				netId,
			});
			addedForNet++;
			if (addedForNet >= islandParent.length - 1) break;
		}

		if (bench) {
			console.debug(`ratsnest: net ${ netId } anchors=${ anchors.length } edges=${ allEdges.length } mst=${ addedForNet } dt=${ (performance.now() - tStart).toFixed(2) }ms`);
		}
	}

	return result;
}

export function benchBuildBoardRatsnest(scene: LayeredBoardScene, netFilter?: ReadonlySet<number>, graph?: CopperGraph): BoardRatsnestLine[] {
	const { nodes, find } = graph ?? buildCopperGraph(scene, netFilter);

	const netToNodeIndices = new Map<number, number[]>();
	for (let index = 0; index < nodes.length; index++) {
		const netId = nodes[index]!.netId;
		if (netId == null || netId <= 0) continue;
		if (netFilter && !netFilter.has(netId)) continue;
		const bucket = netToNodeIndices.get(netId) ?? [];
		bucket.push(index);
		netToNodeIndices.set(netId, bucket);
	}

	const anchorsByNet = new Map<number, Anchor[]>();
	for (const [netId, netNodeIndices] of netToNodeIndices) {
		const islandByNode = new Map<number, number>();
		const islands: number[][] = [];
		for (const index of netNodeIndices) {
			const root = find(index);
			let islandIndex = islandByNode.get(root);
			if (islandIndex === undefined) {
				islandIndex = islands.length;
				islands.push([]);
				islandByNode.set(root, islandIndex);
			}
			islands[islandIndex]!.push(index);
		}
		if (islands.length < 2) continue;

		const anchors: Anchor[] = [];
		const positionToAnchor = new Map<string, number>();
		for (let islandIndex = 0; islandIndex < islands.length; islandIndex++) {
			for (const nodeIndex of islands[islandIndex]!) {
				const point = nodes[nodeIndex]!.point;
				const key = `${ islandIndex }\u0000${ point.x }\u0000${ point.y }`;
				if (positionToAnchor.has(key)) continue;
				positionToAnchor.set(key, anchors.length);
				anchors.push({ x: point.x, y: point.y, island: islandIndex });
			}
		}
		if (anchors.length < 2) continue;
		anchorsByNet.set(netId, anchors);
	}

	return buildRatsnestFromAnchors(anchorsByNet, true);
}

function lengthBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.hypot(dx, dy);
}

function dedupeEdges(edges: { a: number; b: number }[]): { a: number; b: number }[] {
	const seen = new Set<string>();
	const result: { a: number; b: number }[] = [];
	for (const edge of edges) {
		const key = edge.a < edge.b
			? `${ edge.a }\u0000${ edge.b }`
			: `${ edge.b }\u0000${ edge.a }`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(edge);
	}
	return result;
}

function pushUndirectedEdge(seen: Set<string>, list: { a: number; b: number }[], a: number, b: number): void {
	const key = a < b ? `${ a }\u0000${ b }` : `${ b }\u0000${ a }`;
	if (seen.has(key)) return;
	seen.add(key);
	list.push({ a, b });
}
