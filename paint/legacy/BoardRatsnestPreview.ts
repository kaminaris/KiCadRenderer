import type { BoardRatsnestLine } from './BoardRatsnest';
import { Vec2 } from '../../math/Vec2';

/**
 * Cheap, per-frame greedy MST builder for drag-preview ratsnest lines.
 * Not as robust as the full Delaunay+Kruskal path used by buildBoardRatsnest,
 * but fast and suitable for immediate visual feedback while dragging.
 */
export function buildGreedyRatsnest(scene: any, netIds?: Set<number>): BoardRatsnestLine[] {
	const result: BoardRatsnestLine[] = [];
	if (!scene || !scene.hitTestItems) return result;
	const anchorsByNet = new Map<number, { x: number; y: number }[]>();
	for (const item of scene.hitTestItems) {
		if (item.kind !== 'pad' || item.netId == null) continue;
		if (netIds && !netIds.has(item.netId)) continue;
		const center = { x: item.bbox.x + item.bbox.w / 2, y: item.bbox.y + item.bbox.h / 2 };
		const arr = anchorsByNet.get(item.netId) ?? [];
		// avoid duplicates at identical coordinates
		if (!arr.some(p => p.x === center.x && p.y === center.y)) {
			arr.push(center);
			anchorsByNet.set(item.netId, arr);
		}
	}

	for (const [netId, anchors] of anchorsByNet.entries()) {
		if (anchors.length < 2) continue;
		// Prim-style greedy MST (O(n^2) but fine for small previews)
		const used = new Array<boolean>(anchors.length).fill(false);
		used[0] = true;
		let usedCount = 1;
		while (usedCount < anchors.length) {
			let bestDist = Infinity;
			let bestU = -1, bestV = -1;
			for (let i = 0; i < anchors.length; i++) {
				if (!used[i]) continue;
				for (let j = 0; j < anchors.length; j++) {
					if (used[j]) continue;
					const dx = anchors[i].x - anchors[j].x;
					const dy = anchors[i].y - anchors[j].y;
					const d = dx * dx + dy * dy;
					if (d < bestDist) {
						bestDist = d;
						bestU = i;
						bestV = j;
					}
				}
			}
			if (bestU === -1) break;
			used[bestV] = true;
			usedCount++;
			result.push({ from: new Vec2(anchors[bestU].x, anchors[bestU].y), to: new Vec2(anchors[bestV].x, anchors[bestV].y), netId });
		}
	}
	return result;
}
