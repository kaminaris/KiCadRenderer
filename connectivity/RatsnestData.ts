/*
 * This file is ported from KiCad source files:
 *   pcbnew/ratsnest/ratsnest_data.h
 *   pcbnew/ratsnest/ratsnest_data.cpp
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */

import { Vec2 } from '../math/Vec2';
import { delaunator } from '../math/Delaunator';
import {
	CN_ANCHOR,
	CN_CLUSTER,
	CN_ITEM,
	CN_ZONE_LAYER,
} from './ConnectivityItems';

/**
 * Compare two anchors by position (x, then y). Mirrors KiCad's CN_PTR_CMP.
 */
function anchorPosCompare(a: CN_ANCHOR, b: CN_ANCHOR): number {
	const pa = a.Pos();
	const pb = b.Pos();
	if (pa.x === pb.x) {
		return pa.y - pb.y;
	}
	return pa.x - pb.x;
}

/**
 * RN_DYNAMIC_LINE — a single dynamic (drag/live) ratsnest line.
 * Mirrors connectivity_data.h:
 *   struct RN_DYNAMIC_LINE { int netCode; VECTOR2I a, b; };
 */
export interface RN_DYNAMIC_LINE {
	netCode: number;
	a: Vec2;
	b: Vec2;
}

/**
 * CN_EDGE represents a point-to-point connection, whether realized or
 * unrealized (ie: tracks or a ratsnest line).
 */
export class CN_EDGE {
	private m_source: CN_ANCHOR | null = null;
	private m_target: CN_ANCHOR | null = null;
	private m_weight = 0;
	private m_visible = true;

	constructor(source?: CN_ANCHOR, target?: CN_ANCHOR, weight = 0) {
		if (source) {
			this.m_source = source;
		}
		if (target) {
			this.m_target = target;
		}
		this.m_weight = weight;
		this.m_visible = true;
	}

	/**
	 * This sort operator provides a sort-by-weight for the ratsnest operation.
	 */
	compareWeight(other: CN_EDGE): number {
		return this.m_weight - other.m_weight;
	}

	/**
	 * Comparison operator for stable sorting.
	 *
	 * Comparison order:
	 * 1. Compare source nodes by position (x, then y)
	 * 2. Then compare by weight
	 * 3. Then by visibility
	 * 4. If everything is equal, return 0 for stable ordering
	 */
	stableSortCompare(other: CN_EDGE): number {
		const thisPos = this.GetSourcePos();
		const otherPos = other.GetSourcePos();

		if (thisPos.x !== otherPos.x) {
			return thisPos.x - otherPos.x;
		}
		if (thisPos.y !== otherPos.y) {
			return thisPos.y - otherPos.y;
		}
		if (this.m_weight !== other.m_weight) {
			return this.m_weight - other.m_weight;
		}
		if (this.m_visible !== other.m_visible) {
			return this.m_visible && !other.m_visible ? -1 : 1;
		}
		return 0;
	}

	GetSourceNode(): CN_ANCHOR | null {
		return this.m_source;
	}

	GetTargetNode(): CN_ANCHOR | null {
		return this.m_target;
	}

	SetSourceNode(node: CN_ANCHOR | null): void {
		this.m_source = node;
	}

	SetTargetNode(node: CN_ANCHOR | null): void {
		this.m_target = node;
	}

	RemoveInvalidRefs(): void {
		if (this.m_source && !this.m_source.Valid()) {
			this.m_source = null;
		}
		if (this.m_target && !this.m_target.Valid()) {
			this.m_target = null;
		}
	}

	SetWeight(weight: number): void {
		this.m_weight = weight;
	}

	GetWeight(): number {
		return this.m_weight;
	}

	SetVisible(visible: boolean): void {
		this.m_visible = visible;
	}

	IsVisible(): boolean {
		return this.m_visible;
	}

	GetSourcePos(): Vec2 {
		return this.m_source ? this.m_source.Pos() : new Vec2();
	}

	GetTargetPos(): Vec2 {
		return this.m_target ? this.m_target.Pos() : new Vec2();
	}

	GetLength(): number {
		if (!this.m_source || !this.m_target) {
			return 0;
		}
		return this.m_target.Pos().sub(this.m_source.Pos()).magnitude;
	}
}

/**
 * Disjoint-set / union-find used by Kruskal's MST. Ported verbatim from
 * ratsnest_data.cpp.
 */
class disjoint_set {
	private m_data: number[] = [];
	private m_depth: number[] = [];

	constructor(size: number) {
		this.m_data = new Array(size);
		this.m_depth = new Array(size).fill(0);
		for (let i = 0; i < size; i++) {
			this.m_data[i] = i;
		}
	}

	find(val: number): number {
		let root = val;
		while (this.m_data[root] !== root) {
			root = this.m_data[root]!;
		}
		// Compress the path
		while (this.m_data[val] !== val) {
			const tmp = this.m_data[val]!;
			this.m_data[val] = root;
			val = tmp;
		}
		return root;
	}

	unite(val1: number, val2: number): boolean {
		val1 = this.find(val1);
		val2 = this.find(val2);
		if (val1 !== val2) {
			if (this.m_depth[val1]! < this.m_depth[val2]!) {
				this.m_data[val1] = val2;
			}
			else {
				this.m_data[val2] = val1;
				if (this.m_depth[val1] === this.m_depth[val2]) {
					this.m_depth[val1] = (this.m_depth[val1] ?? 0) + 1;
				}
			}
			return true;
		}
		return false;
	}
}

/**
 * Internal triangulator state. Keeps the set of all nodes for a net and
 * produces the Delaunay candidate edge set for the MST.
 */
class TRIANGULATOR_STATE {
	private m_allNodes: CN_ANCHOR[] = [];

	Clear(): void {
		this.m_allNodes = [];
	}

	AddNode(node: CN_ANCHOR): void {
		this.m_allNodes.push(node);
	}

	/**
	 * Checks if all nodes in aNodes lie on a single line. Requires the nodes to
	 * have unique coordinates!
	 */
	private areNodesColinear(nodes: CN_ANCHOR[]): boolean {
		if (nodes.length <= 2) {
			return true;
		}
		const p0 = nodes[0]!.Pos();
		const v0 = nodes[1]!.Pos().sub(p0);
		for (let i = 2; i < nodes.length; i++) {
			const v1 = nodes[i]!.Pos().sub(p0);
			// Cross product of 2D vectors
			if (v0.x * v1.y - v0.y * v1.x !== 0) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Build the candidate edge set for the MST. Uses the existing delaunator
	 * port (../math/Delaunator) which matches KiCad's bundled mapbox/delaunator.
	 */
	Triangulate(mstEdges: CN_EDGE[]): void {
		const anchors: CN_ANCHOR[] = [];
		const anchorChains: CN_ANCHOR[][] = [];

		// Sort by position and deduplicate identical coordinates for the
		// triangulator, while keeping a chain of all anchors at each position
		// (they may be on different layers / clusters).
		const sorted = [...this.m_allNodes].sort(anchorPosCompare);
		let prev: CN_ANCHOR | null = null;

		for (const n of sorted) {
			if (!prev || prev.Pos().x !== n.Pos().x || prev.Pos().y !== n.Pos().y) {
				anchors.push(n);
				anchorChains.push([]);
			}
			anchorChains[anchors.length - 1]!.push(n);
			prev = n;
		}

		const addEdge = (src: CN_ANCHOR, dst: CN_ANCHOR): void => {
			mstEdges.push(new CN_EDGE(src, dst, src.Dist(dst)));
		};

		if (anchors.length === 0) {
			return;
		}
		else if (anchors.length === 1) {
			// The anchors all share the same position. Add zero-weight edges
			// between successive anchors so overlapping layers collapse.
			for (let i = 1; i < sorted.length; i++) {
				mstEdges.push(new CN_EDGE(sorted[i - 1]!, sorted[i]!, 0));
			}
			return;
		}
		else if (this.areNodesColinear(anchors)) {
			// All nodes are on the same line - there's no triangulation for such
			// set. Sort along any coordinate and chain the nodes together.
			for (let i = 0; i < anchors.length - 1; i++) {
				addEdge(anchors[i]!, anchors[i + 1]!);
			}
		}
		else {
			const result = delaunator(
				anchors.map((a) => ({ x: a.Pos().x, y: a.Pos().y })),
			);
			const triangles = result.triangles;
			const halfedges = result.halfedges;

			for (let i = 0; i < triangles.length; i += 3) {
				addEdge(anchors[triangles[i]!]!, anchors[triangles[i + 1]!]!);
				addEdge(anchors[triangles[i + 1]!]!, anchors[triangles[i + 2]!]!);
				addEdge(anchors[triangles[i + 2]!]!, anchors[triangles[i]!]!);
			}

			for (let i = 0; i < halfedges.length; i++) {
				if (halfedges[i] === -1) {
					continue;
				}
				addEdge(anchors[triangles[i]!]!, anchors[triangles[halfedges[i]!]!]);
			}
		}

		// Add zero-weight edges between anchors that share the same position but
		// belong to different clusters, so the MST keeps them connected.
		for (const chain of anchorChains) {
			if (chain.length < 2) {
				continue;
			}
			chain.sort((a, b) => {
				const ca = a.GetCluster();
				const cb = b.GetCluster();
				if (ca === cb) return 0;
				if (!ca) return -1;
				if (!cb) return 1;
				return ca === cb ? 0 : (ca < cb ? -1 : 1);
			});
			for (let j = 1; j < chain.length; j++) {
				const prevNode = chain[j - 1]!;
				const curNode = chain[j]!;
				const weight = prevNode.GetCluster() !== curNode.GetCluster() ? 1 : 0;
				mstEdges.push(new CN_EDGE(prevNode, curNode, weight));
			}
		}
	}
}

/**
 * Describe ratsnest for a single net.
 */
export class RN_NET {
	private m_net: number;
	private m_nodes: CN_ANCHOR[] = [];
	private m_boardEdges: CN_EDGE[] = [];
	private m_rnEdges: CN_EDGE[] = [];
	private m_clusters: CN_CLUSTER[] = [];
	private m_dirty = true;
	private m_triangulator = new TRIANGULATOR_STATE();

	constructor(aNet: number) {
		this.m_net = aNet;
	}

	IsDirty(): boolean {
		return this.m_dirty;
	}

	UpdateNet(_connAlgo?: any): void {
		// Accept optional connectivity algo param for parity with callers.
		this.compute();
		this.m_dirty = false;
	}

	RemoveInvalidRefs(): void {
		for (const edge of this.m_rnEdges) {
			edge.RemoveInvalidRefs();
		}
		for (const edge of this.m_boardEdges) {
			edge.RemoveInvalidRefs();
		}
		this.m_rnEdges = this.m_rnEdges.filter(
			(edge) => edge.GetSourceNode() && edge.GetTargetNode(),
		);
		this.m_boardEdges = this.m_boardEdges.filter(
			(edge) => edge.GetSourceNode() && edge.GetTargetNode(),
		);
	}

	/**
	 * Find optimal ends of RNEdges. The MST will have found the closest
	 * anchors, but when zones are involved we might have points closer than
	 * the anchors.
	 *
	 * This implementation is a structural port; the zone-outline closest-point
	 * refinement relies on KiCad's SHAPE_LINE_CHAIN::ClosestSegmentsFast which
	 * is not available in this codebase. Zone anchor positions are kept as the
	 * first outline point (matching the legacy viewer's behavior).
	 */
	OptimizeRNEdges(): void {
		// TODO: port zone-anchor optimization once the boundary shape model is
		// in place. The MST already produces topologically correct airwires.
	}

	Clear(): void {
		this.m_rnEdges = [];
		this.m_boardEdges = [];
		this.m_nodes = [];
		this.m_dirty = true;
	}

	GetNodeCount(): number {
		return this.m_nodes.length;
	}

	/**
	 * Mirrors RN_NET::GetNodes() — returns all anchors in this net.
	 */
	GetNodes(): CN_ANCHOR[] {
		return this.m_nodes;
	}

	/**
	 * Mirrors RN_NET::GetNodesAtAnchor() — returns all anchors of `aItem`
	 * located at exactly `aAnchor`. (The C++ has `assert(node->Valid())`
	 * which is a no-op in release builds; not replicated.)
	 */
	GetNodesAtAnchor(aItem: any, aAnchor: Vec2): CN_ANCHOR[] {
		const rv: CN_ANCHOR[] = [];

		for (const node of this.m_nodes) {
			if (node.Parent() === aItem && node.Pos().x === aAnchor.x && node.Pos().y === aAnchor.y) {
				rv.push(node);
			}
		}

		return rv;
	}

	GetEdges(): CN_EDGE[] {
		this.m_rnEdges.sort((a, b) => a.stableSortCompare(b));
		return this.m_rnEdges;
	}

	/**
	 * Returns the closest pair of points between this net and another net.
	 * Used for cross-net (bicolored) ratsnest queries.
	 */
	NearestBicoloredPair(otherNet: RN_NET): { pos1: Vec2; pos2: Vec2 } | null {
		let bestDistSq = Number.POSITIVE_INFINITY;
		let bestPos1: Vec2 | null = null;
		let bestPos2: Vec2 | null = null;

		const consider = (nodeA: CN_ANCHOR, nodeB: CN_ANCHOR) => {
			if (nodeA.GetNoLine() || nodeB.GetNoLine()) {
				return;
			}
			const diff = nodeA.Pos().sub(nodeB.Pos());
			const distSq = diff.x * diff.x + diff.y * diff.y;
			if (distSq < bestDistSq) {
				bestDistSq = distSq;
				bestPos1 = nodeA.Pos();
				bestPos2 = nodeB.Pos();
			}
		};

		const sortedB = [...this.m_nodes].sort(anchorPosCompare);

		for (const nodeA of otherNet.m_nodes) {
			if (nodeA.GetNoLine()) {
				continue;
			}
			// lower_bound by x
			let lo = 0;
			let hi = sortedB.length;
			while (lo < hi) {
				const mid = Math.floor((lo + hi) / 2);
				if (sortedB[mid]!.Pos().x < nodeA.Pos().x) {
					lo = mid + 1;
				}
				else {
					hi = mid;
				}
			}
			// Forward sweep
			for (let i = lo; i < sortedB.length; i++) {
				const nodeB = sortedB[i]!;
				if (nodeB.GetNoLine()) {
					continue;
				}
				const dx = nodeA.Pos().x - nodeB.Pos().x;
				if (dx * dx > bestDistSq) {
					break;
				}
				consider(nodeA, nodeB);
			}
			// Backward sweep
			for (let i = lo - 1; i >= 0; i--) {
				const nodeB = sortedB[i]!;
				if (nodeB.GetNoLine()) {
					continue;
				}
				const dx = nodeA.Pos().x - nodeB.Pos().x;
				if (dx * dx > bestDistSq) {
					break;
				}
				consider(nodeA, nodeB);
			}
		}

		if (bestPos1 && bestPos2) {
			return { pos1: bestPos1, pos2: bestPos2 };
		}
		return null;
	}

	AddCluster(cluster: CN_CLUSTER): void {
		let firstAnchor: CN_ANCHOR | null = null;

		this.m_clusters.push(cluster);

		for (const item of cluster) {
			const anchors = item.Anchors();
			let nAnchors = item instanceof CN_ZONE_LAYER ? 1 : anchors.length;
			if (nAnchors > anchors.length) {
				nAnchors = anchors.length;
			}

			for (let i = 0; i < nAnchors; i++) {
				const anchor = anchors[i]!;
				anchor.SetCluster(cluster);
				this.m_nodes.push(anchor);

				if (firstAnchor) {
					if (firstAnchor !== anchor) {
						this.m_boardEdges.push(new CN_EDGE(firstAnchor, anchor, 0));
					}
				}
				else {
					firstAnchor = anchor;
				}
			}
		}
	}

	Clusters(): CN_CLUSTER[] {
		return this.m_clusters;
	}

	private compute(): void {
		// Special cases do not need complicated algorithms (actually, it does
		// not work well with the Delaunay triangulator)
		if (this.m_nodes.length <= 2) {
			this.m_rnEdges = [];

			if (this.m_boardEdges.length === 0 && this.m_nodes.length === 2) {
				const [source, target] = this.m_nodes;
				source!.SetTag(0);
				target!.SetTag(1);
				this.m_rnEdges.push(new CN_EDGE(source, target));
			}
			else {
				for (const node of this.m_nodes) {
					node.SetTag(0);
				}
			}
			return;
		}

		this.m_triangulator.Clear();
		for (const n of this.m_nodes) {
			this.m_triangulator.AddNode(n);
		}

		const triangEdges: CN_EDGE[] = [];

		this.m_triangulator.Triangulate(triangEdges);

		for (const e of this.m_boardEdges) {
			triangEdges.push(new CN_EDGE(e.GetSourceNode()!, e.GetTargetNode()!, e.GetWeight()));
		}

		triangEdges.sort((a, b) => a.compareWeight(b));

		this.kruskalMST(triangEdges);
	}

	private kruskalMST(edges: CN_EDGE[]): void {
		const dset = new disjoint_set(this.m_nodes.length);

		this.m_rnEdges = [];

		let i = 0;
		for (const node of this.m_nodes) {
			node.SetTag(i++);
		}

		for (const tmp of edges) {
			const source = tmp.GetSourceNode();
			const target = tmp.GetTargetNode();

			if (!source || source.Dirty() || !target || target.Dirty()) {
				continue;
			}

			if (dset.unite(source.GetTag(), target.GetTag())) {
				if (tmp.GetWeight() > 0) {
					this.m_rnEdges.push(tmp);
				}
			}
		}
	}
}
