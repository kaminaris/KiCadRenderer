import { Vec2 } from '../math/Vec2';
import type { LayeredBoardScene } from './BoardPainter';
import { buildCopperGraph, distance, type CopperGraph } from './BoardCopperGraph';

export interface BoardRatsnestLine {
	from: Vec2;
	to: Vec2;
	netId: number;
}

/** Builds a lightweight KiCad-style ratsnest from buildCopperGraph's
 * point-level connectivity (paint/BoardCopperGraph.ts): the remaining
 * disconnected components ("islands") of each net are joined with a plain
 * O(n²) MST, which is sufficient for the board sizes handled by the web
 * editor.
 *
 * `netFilter`, when given, skips every item whose net isn't in the set —
 * used during a footprint drag to recompute ratsnest for just the nets that
 * moved (see KicadRenderSession's incremental board-rebuild path) instead
 * of the whole board every frame. */
export function buildBoardRatsnest(scene: LayeredBoardScene, netFilter?: ReadonlySet<number>, graph?: CopperGraph): BoardRatsnestLine[] {
	const { nodes, find } = graph ?? buildCopperGraph(scene, netFilter);

	const result: BoardRatsnestLine[] = [];
	const netIds = new Set(nodes.map(node => node.netId));
	for (const netId of netIds) {
		const componentMap = new Map<number, number[]>();
		for (let index = 0; index < nodes.length; index++) {
			if (nodes[index]!.netId !== netId) continue;
			const root = find(index);
			const members = componentMap.get(root) ?? [];
			members.push(index);
			componentMap.set(root, members);
		}
		const components = [...componentMap.values()];
		if (components.length < 2) continue;
		const edges: { a: number; b: number; from: Vec2; to: Vec2; length: number }[] = [];
		for (let a = 0; a < components.length; a++) {
			for (let b = a + 1; b < components.length; b++) {
				let best: { from: Vec2; to: Vec2; length: number } | null = null;
				for (const ai of components[a]!) for (const bi of components[b]!) {
					const length = distance(nodes[ai]!.point, nodes[bi]!.point);
					if (!best || length < best.length) best = { from: nodes[ai]!.point, to: nodes[bi]!.point, length };
				}
				if (best) edges.push({ a, b, ...best });
			}
		}
		edges.sort((a, b) => a.length - b.length);
		const componentParent = components.map((_, index) => index);
		let addedForNet = 0;
		const componentFind = (index: number): number => componentParent[index] === index
			? index : (componentParent[index] = componentFind(componentParent[index]!));
		for (const edge of edges) {
			const a = componentFind(edge.a), b = componentFind(edge.b);
			if (a === b) continue;
			componentParent[b] = a;
			result.push({ from: edge.from, to: edge.to, netId });
			addedForNet++;
			if (addedForNet >= components.length - 1) break;
		}
	}
	return result;
}
