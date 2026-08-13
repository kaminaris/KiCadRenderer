import { Vec2 } from '../math/Vec2';
import { distanceToSegment } from './PaintedShape';
import type { LayeredBoardScene, PaintedItem } from './BoardPainter';

export interface BoardRatsnestLine {
	from: Vec2;
	to: Vec2;
	netId: number;
}

interface CopperNode {
	point: Vec2;
	layer: string;
	netId: number;
}

interface CopperSegment {
	a: number;
	b: number;
	layer: string;
	netId: number;
	width: number;
}

/** Builds a lightweight KiCad-style ratsnest. Copper connectivity is
 * layer-aware: same-coordinate F.Cu/B.Cu tracks are not joined unless a
 * through pad or via explicitly unions those layer nodes. The remaining
 * disconnected components of each net are joined with a plain O(n²) MST,
 * which is sufficient for the board sizes handled by the web editor.
 *
 * `netFilter`, when given, skips every item whose net isn't in the set —
 * used during a footprint drag to recompute ratsnest for just the nets that
 * moved (see KicadRenderSession's incremental board-rebuild path) instead
 * of the whole board every frame. Still does one O(scene size) pass to find
 * those items (a cheap property-read + Set.has per item), just skips the
 * expensive union-find/nearest-neighbor/MST work for everything else. */
export function buildBoardRatsnest(scene: LayeredBoardScene, netFilter?: ReadonlySet<number>): BoardRatsnestLine[] {
	const nodes: CopperNode[] = [];
	const segments: CopperSegment[] = [];
	const parent: number[] = [];
	const addNode = (point: Vec2, layer: string, netId: number): number => {
		const index = nodes.length;
		nodes.push({ point, layer, netId });
		parent.push(index);
		return index;
	};
	const find = (index: number): number => {
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]!]!;
			index = parent[index]!;
		}
		return index;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a), rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	};

	const copperLayers = scene.layersPresent.filter(layer => layer.endsWith('.Cu'));
	const padNodes = new Map<any, number[]>();
	for (const item of scene.hitTestItems) {
		const netId = item.netId ?? null;
		if (netId === null || netId <= 0) continue;
		if (netFilter && !netFilter.has(netId)) continue;
		if (item.kind === 'track' && item.shape.type === 'segment') {
			const a = addNode(new Vec2(item.shape.x1, item.shape.y1), item.layer, netId);
			const b = addNode(new Vec2(item.shape.x2, item.shape.y2), item.layer, netId);
			union(a, b);
			segments.push({ a, b, layer: item.layer, netId, width: item.shape.width });
		}
		else if (item.kind === 'pad' && item.layer.endsWith('.Cu')) {
			const index = addNode(centerOf(item), item.layer, netId);
			const siblings = padNodes.get(item.element) ?? [];
			for (const sibling of siblings) union(index, sibling);
			siblings.push(index);
			padNodes.set(item.element, siblings);
		}
		else if (item.kind === 'via') {
			const requested: string[] = typeof item.element?.getLayers === 'function'
				? item.element.getLayers() : ['F.Cu', 'B.Cu'];
			const layers = requested.flatMap(layer => layer === '*.Cu' ? copperLayers : [layer])
				.filter(layer => layer.endsWith('.Cu'));
			const viaNodes = layers.map(layer => addNode(centerOf(item), layer, netId));
			for (let i = 1; i < viaNodes.length; i++) union(viaNodes[0]!, viaNodes[i]!);
		}
	}

	// Join touching copper on the same layer, including T-branches whose
	// endpoint lands in the middle of an existing track. Bucket by net/layer
	// first so unrelated nets never turn this into a whole-board O(N²) pass.
	const nodeBuckets = new Map<string, number[]>();
	const segmentBuckets = new Map<string, CopperSegment[]>();
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index]!;
		const key = `${ node.netId }\u0000${ node.layer }`;
		const bucket = nodeBuckets.get(key) ?? [];
		bucket.push(index);
		nodeBuckets.set(key, bucket);
	}
	for (const segment of segments) {
		const key = `${ segment.netId }\u0000${ segment.layer }`;
		const bucket = segmentBuckets.get(key) ?? [];
		bucket.push(segment);
		segmentBuckets.set(key, bucket);
	}
	for (const [key, bucketNodes] of nodeBuckets) {
		for (let i = 0; i < bucketNodes.length; i++) {
			const nodeIndex = bucketNodes[i]!;
			for (let j = i + 1; j < bucketNodes.length; j++) {
				const otherIndex = bucketNodes[j]!;
				if (distance(nodes[nodeIndex]!.point, nodes[otherIndex]!.point) <= 0.02) {
					union(nodeIndex, otherIndex);
				}
			}
			for (const segment of segmentBuckets.get(key) ?? []) {
				const node = nodes[nodeIndex]!;
				const a = nodes[segment.a]!.point, b = nodes[segment.b]!.point;
				if (distanceToSegment(node.point.x, node.point.y, a.x, a.y, b.x, b.y) <= segment.width / 2 + 0.02) {
					union(nodeIndex, segment.a);
				}
			}
		}
	}

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

function centerOf(item: PaintedItem): Vec2 {
	return new Vec2(item.bbox.x + item.bbox.w / 2, item.bbox.y + item.bbox.h / 2);
}

function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}
