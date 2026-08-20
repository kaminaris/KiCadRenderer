import { Vec2 } from '../math/Vec2';
import { distanceToSegment, pointInPolygon, shapesOverlap } from './PaintedShape';
import type { PaintedShape } from './PaintedShape';
import type { LayeredBoardScene, PaintedItem } from './BoardPainter';

const CONNECT_EPSILON_MM = 0.02;
const CONNECT_GRID_CELL_MM = 2;

export interface CopperGraphNode {
	point: Vec2;
	layer: string;
	netId: number;
	/** The PaintedItem this node belongs to — lets a caller resolve "which
	 *  nodes did a walk touch" back to real, selectable paint ids. A via
	 *  contributes one node per bridged layer, all sharing the same itemId
	 *  (it's one physical via); a through-hole pad similarly contributes
	 *  one node per copper layer it appears on. */
	itemId: string;
	itemKind: 'track' | 'pad' | 'via';
}

export interface CopperGraphSegment {
	a: number;
	b: number;
	layer: string;
	netId: number;
	width: number;
}

export interface CopperGraph {
	nodes: CopperGraphNode[];
	segments: CopperGraphSegment[];
	/** Union-find root query — two nodes are on the same electrical island
	 *  iff find(a) === find(b). */
	find(index: number): number;
	/** Every node index directly touching a given node index — same
	 *  physical point (same net+layer, within 0.02mm), the opposite end of
	 *  the same segment, a via's tap on another bridged layer, or a
	 *  zone-fill pour join. One physical touch = one union() call during
	 *  graph construction = one adjacency edge, so this is exactly as
	 *  precise as the touching-copper rules buildCopperGraph already
	 *  encodes — no separate detection pass. Used by
	 *  KicadRenderSession.expandBoardConnection's point-by-point walk;
	 *  find() alone only answers "same island", not "how many hops away". */
	adjacent(index: number): number[];
}

/**
 * Builds the board's point-level copper connectivity graph: nodes at every
 * track/arc endpoint, pad center, and via per-layer tap, joined by a
 * union-find wherever copper actually touches. Copper connectivity is
 * layer-aware: same-coordinate F.Cu/B.Cu tracks are not joined unless a
 * through pad or via explicitly unions those layer nodes.
 *
 * Shared by buildBoardRatsnest (paint/BoardRatsnest.ts — only needs the
 * final island grouping, via find(), to MST-join disconnected components
 * into airwires) and KicadRenderSession.expandBoardConnection (needs the
 * full node/segment adjacency for its point-by-point "Select/Expand
 * Connection" walk). Extracted from what was previously the first half of
 * buildBoardRatsnest — a mechanical move, not a rewrite of the connectivity
 * rules themselves.
 *
 * `netFilter`, when given, skips every item whose net isn't in the set —
 * used during a footprint drag to recompute ratsnest for just the nets that
 * moved (see KicadRenderSession's incremental board-rebuild path) instead
 * of the whole board every frame. Still does one O(scene size) pass to find
 * those items (a cheap property-read + Set.has per item), just skips the
 * expensive union-find/nearest-neighbor work for everything else.
 */
export function buildCopperGraph(scene: LayeredBoardScene, netFilter?: ReadonlySet<number>): CopperGraph {
	const nodes: CopperGraphNode[] = [];
	const segments: CopperGraphSegment[] = [];
	const parent: number[] = [];
	const adjacency: number[][] = [];
	const addNode = (point: Vec2, layer: string, netId: number, itemId: string, itemKind: CopperGraphNode['itemKind']): number => {
		const index = nodes.length;
		nodes.push({ point, layer, netId, itemId, itemKind });
		parent.push(index);
		adjacency.push([]);
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
		// Guarded, unlike a bare union-find union: the touching-copper pass
		// below tests every node against every segment on its net+layer (not
		// spatially bucketed by position), so a segment's own endpoint is
		// always distance-0 from itself — union(a, a) and repeated union(a,
		// b) calls for an already-connected pair are both routine, harmless
		// no-ops for a plain union-find, but would otherwise leave spurious
		// self-loops/duplicate edges in the adjacency list, inflating
		// expandBoardConnection's junction "branch count" and causing it to
		// stop expanding partway through a plain straight run of track.
		if (a !== b && !adjacency[a]!.includes(b)) {
			adjacency[a]!.push(b);
			adjacency[b]!.push(a);
		}
		const ra = find(a), rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	};

	const copperLayers = scene.copperLayerStack.length > 0
		? scene.copperLayerStack
		: scene.layersPresent.filter(layer => layer.endsWith('.Cu'));
	const padNodes = new Map<any, number[]>();
	// Same-net, same-layer pads whose own copper shapes physically overlap
	// (e.g. a footprint's big annular "via ring" pad overlapping a ring of
	// smaller contact pads around it — MountingHole_*_Pad_Via footprints on
	// a real board did exactly this) are ONE continuous piece of copper,
	// not two isolated islands needing a track/zone to bridge them — see
	// the overlap-union pass below, after the main loop populates this.
	const padShapesByNetLayer = new Map<string, { index: number; shape: PaintedShape; element: any }[]>();
	// Iterates every layer-bucket item, not just scene.hitTestItems — track
	// ARCS (length-tuning/meander rounded corners) are deliberately not
	// hit-testable (see buildTrackArc's doc comment) but still need to
	// participate in connectivity, so hitTestItems alone would silently
	// treat every meander as a chain of disconnected islands.
	for (const items of scene.layerBuckets.values()) {
	for (const item of items) {
		const netId = item.netId ?? null;
		if (netId === null || netId <= 0) continue;
		if (netFilter && !netFilter.has(netId)) continue;
		if (item.kind === 'track' && item.shape.type === 'segment') {
			const a = addNode(new Vec2(item.shape.x1, item.shape.y1), item.layer, netId, item.id, 'track');
			const b = addNode(new Vec2(item.shape.x2, item.shape.y2), item.layer, netId, item.id, 'track');
			union(a, b);
			segments.push({ a, b, layer: item.layer, netId, width: item.shape.width });
		}
		else if (item.kind === 'track' && item.shape.type === 'circle'
			&& typeof item.element?.getStartMidEnd === 'function') {
			// A track arc's endpoints are its real connection points (the
			// rendered shape is a full-circle placeholder — see buildTrackArc)
			// — getStartMidEnd() gives those directly, no trig round-trip.
			const { start, end } = item.element.getStartMidEnd();
			const width = typeof item.element.getWidth === 'function' ? item.element.getWidth() : 0.25;
			const a = addNode(new Vec2(start.x, start.y), item.layer, netId, item.id, 'track');
			const b = addNode(new Vec2(end.x, end.y), item.layer, netId, item.id, 'track');
			union(a, b);
			segments.push({ a, b, layer: item.layer, netId, width });
		}
		else if (item.kind === 'pad' && item.layer.endsWith('.Cu')) {
			const index = addNode(centerOf(item), item.layer, netId, item.id, 'pad');
			const siblings = padNodes.get(item.element) ?? [];
			for (const sibling of siblings) union(index, sibling);
			siblings.push(index);
			padNodes.set(item.element, siblings);
			const key = bucketKey(netId, item.layer);
			const shapeBucket = padShapesByNetLayer.get(key) ?? [];
			shapeBucket.push({ index, shape: item.shape, element: item.element });
			padShapesByNetLayer.set(key, shapeBucket);
		}
		else if (item.kind === 'via') {
			const requested: string[] = typeof item.element?.getLayers === 'function'
				? item.element.getLayers() : ['F.Cu', 'B.Cu'];
			// A via's plated barrel physically touches every copper layer
			// between its two named layers, not just those two — a normal
			// through via names only "F.Cu"/"B.Cu" yet still bridges every
			// internal plane in between (this was the root cause of an
			// internal power plane like In3.Cu looking entirely unconnected:
			// through-vias never got a node on it). Blind/buried vias name
			// their real (non-F/B) endpoints, so this still correctly limits
			// them to just the layers they actually span.
			const explicit = requested.flatMap(layer => layer === '*.Cu' ? copperLayers : [layer])
				.filter(layer => copperLayers.includes(layer));
			const indices = explicit.map(layer => copperLayers.indexOf(layer)).filter(i => i >= 0);
			const layers = indices.length >= 2
				? copperLayers.slice(Math.min(...indices), Math.max(...indices) + 1)
				: explicit;
			const viaNodes = layers.map(layer => addNode(centerOf(item), layer, netId, item.id, 'via'));
			for (let i = 1; i < viaNodes.length; i++) union(viaNodes[0]!, viaNodes[i]!);
		}
	}
	}

	// Pad-to-pad shape overlap: two DIFFERENT pads of the same net/layer
	// whose own copper shapes physically touch are one continuous piece of
	// copper — real KiCad's own connectivity engine does real shape
	// collision, not just point tests, for exactly this reason (a
	// footprint's own pads are ordinary board copper to it, same as any
	// other item). This app's own pad handling above only ever unions
	// different LAYERS of the SAME pad element (a thru-hole pad's own F.Cu/
	// B.Cu taps) — two DIFFERENT pads (even of the same footprint) were
	// never tested against each other at all, so a deliberately-overlapping
	// pad pattern (an annular "via ring" pad overlapping a ring of smaller
	// contact pads around it, both same net) showed a spurious ratsnest
	// airwire between them despite being solid, continuous, already-
	// connected copper. O(n²) per net+layer bucket, same complexity class
	// as the existing node/segment touching pass just below — pad counts
	// sharing one net on one layer are small in practice (this bug's own
	// real-board repro case was 9), so this stays cheap.
	for (const bucket of padShapesByNetLayer.values()) {
		for (let i = 0; i < bucket.length; i++) {
			for (let j = i + 1; j < bucket.length; j++) {
				if (bucket[i]!.element === bucket[j]!.element) continue; // already unioned via padNodes above
				if (shapesOverlap(bucket[i]!.shape, bucket[j]!.shape)) {
					union(bucket[i]!.index, bucket[j]!.index);
				}
			}
		}
	}

	// Join touching copper on the same layer, including T-branches whose
	// endpoint lands in the middle of an existing track. The former
	// node-by-every-node / node-by-every-segment pass was the dominant cost
	// when refreshing a dense net's ratsnest during a drag. The same net/layer
	// is now additionally spatially hashed, so a node only tests nearby
	// candidates while preserving the exact distance tests below.
	const nodeBuckets = new Map<string, number[]>();
	const nodeGrid = new Map<string, number[]>();
	const segmentGrid = new Map<string, number[]>();
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index]!;
		const key = bucketKey(node.netId, node.layer);
		const bucket = nodeBuckets.get(key) ?? [];
		bucket.push(index);
		nodeBuckets.set(key, bucket);
		const cell = gridCell(nodes[index]!.point.x, nodes[index]!.point.y);
		pushGridEntry(nodeGrid, gridKey(key, cell.x, cell.y), index);
	}
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!;
		const key = bucketKey(segment.netId, segment.layer);
		const a = nodes[segment.a]!.point;
		const b = nodes[segment.b]!.point;
		const reach = segment.width / 2 + CONNECT_EPSILON_MM;
		const min = gridCell(Math.min(a.x, b.x) - reach, Math.min(a.y, b.y) - reach);
		const max = gridCell(Math.max(a.x, b.x) + reach, Math.max(a.y, b.y) + reach);
		for (let x = min.x; x <= max.x; x++) {
			for (let y = min.y; y <= max.y; y++) {
				pushGridEntry(segmentGrid, gridKey(key, x, y), index);
			}
		}
	}
	const seenSegments = new Uint32Array(segments.length);
	let segmentVisit = 0;
	for (const [key, bucketNodes] of nodeBuckets) {
		for (const nodeIndex of bucketNodes) {
			const node = nodes[nodeIndex]!;
			const cell = gridCell(node.point.x, node.point.y);
			for (let x = cell.x - 1; x <= cell.x + 1; x++) {
				for (let y = cell.y - 1; y <= cell.y + 1; y++) {
					for (const otherIndex of nodeGrid.get(gridKey(key, x, y)) ?? []) {
						if (otherIndex <= nodeIndex) continue;
						if (distance(nodes[nodeIndex]!.point, nodes[otherIndex]!.point) <= CONNECT_EPSILON_MM) {
							union(nodeIndex, otherIndex);
						}
					}
				}
			}
			segmentVisit++;
			for (const segmentIndex of segmentGrid.get(gridKey(key, cell.x, cell.y)) ?? []) {
				if (seenSegments[segmentIndex] === segmentVisit) continue;
				seenSegments[segmentIndex] = segmentVisit;
				const segment = segments[segmentIndex]!;
				const a = nodes[segment.a]!.point, b = nodes[segment.b]!.point;
				if (distanceToSegment(node.point.x, node.point.y, a.x, a.y, b.x, b.y) <= segment.width / 2 + CONNECT_EPSILON_MM) {
					// Union to whichever of the segment's own two endpoint
					// nodes this point actually coincides with — unioning to
					// segment.a unconditionally (regardless of which end the
					// touching point is really at) created a spurious
					// adjacency edge to a node one hop further away than the
					// real touch, inflating isTrackStop's branch-count check
					// at ordinary 2-degree joints and truncating
					// assembleTrackLine/expandBoardConnection's walk almost
					// at random depending on which way each segment happened
					// to be authored in the file (root-caused against a real
					// user board where dragging a track body silently
					// stopped the assembled line mid-chain). A touch that
					// lands in the segment's true middle (neither end) is a
					// genuine T-branch, so it unions to both ends — the
					// through-track stays one electrical island either way,
					// but the branch tap is now a real 3-way point instead of
					// being silently merged into whichever end happened to
					// be "a".
					const distA = distance(node.point, a), distB = distance(node.point, b);
					if (distA <= CONNECT_EPSILON_MM) {
						union(nodeIndex, segment.a);
					}
					else if (distB <= CONNECT_EPSILON_MM) {
						union(nodeIndex, segment.b);
					}
					else {
						union(nodeIndex, segment.a);
						union(nodeIndex, segment.b);
					}
				}
			}
		}
	}

	// Zone-fill connectivity: a copper pour joins every same-net pad/via/
	// track on the layer(s) it pours onto, exactly like touching copper —
	// this is the dominant connection for a GND/power plane, which is
	// usually poured rather than individually traced to every pad. Tested
	// against the zone's own bucket-matched nodes only (cheap: nodeBuckets
	// is already keyed by net+layer), using its authored outline rather
	// than the fractured fill geometry — see ZoneFillRegion's doc comment.
	for (const fill of scene.zoneFills) {
		if (netFilter && !netFilter.has(fill.netId)) continue;
		const key = bucketKey(fill.netId, fill.layer);
		const bucketNodes = nodeBuckets.get(key);
		if (!bucketNodes) continue;
		let first: number | null = null;
		for (const nodeIndex of bucketNodes) {
			const point = nodes[nodeIndex]!.point;
			if (!pointInPolygon(fill.points, point.x, point.y)) continue;
			if (first === null) first = nodeIndex;
			else union(first, nodeIndex);
		}
	}

	return { nodes, segments, find, adjacent: index => adjacency[index] ?? [] };
}

/** Net+layer bucket key — a Unicode NUL separator so no netId/layer-name
 *  combination can ever collide with another (a plain "-" or space could,
 *  in principle, for a pathological layer name). */
function bucketKey(netId: number, layer: string): string {
	return String(netId) + '\u0000' + layer;
}

function gridCell(x: number, y: number): { x: number; y: number } {
	return { x: Math.floor(x / CONNECT_GRID_CELL_MM), y: Math.floor(y / CONNECT_GRID_CELL_MM) };
}

function gridKey(bucket: string, x: number, y: number): string {
	return `${ bucket }\u0000${ x }\u0000${ y }`;
}

function pushGridEntry(grid: Map<string, number[]>, key: string, index: number): void {
	const entries = grid.get(key);
	if (entries) entries.push(index);
	else grid.set(key, [index]);
}

function centerOf(item: PaintedItem): Vec2 {
	return new Vec2(item.bbox.x + item.bbox.w / 2, item.bbox.y + item.bbox.h / 2);
}

export function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}
