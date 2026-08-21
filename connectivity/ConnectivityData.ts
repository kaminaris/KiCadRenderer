/*
 * This file is ported from KiCad source files:
 *   pcbnew/connectivity/connectivity_data.h
 *   pcbnew/connectivity/connectivity_data.cpp
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */

import {
	CN_CLUSTER,
	CN_ITEM,
	CN_ANCHOR,
	CN_ZONE_LAYER,
	KICAD_T,
} from "./ConnectivityItems";
import { CN_EDGE, RN_NET, RN_DYNAMIC_LINE } from "./RatsnestData";
import { CN_CONNECTIVITY_ALGO } from "./ConnectivityAlgo";
import { Vec2 } from "../math/Vec2";
import { NETINFO_LIST, NETINFO_ITEM, NETCLASS } from "./netinfo";
import { NetClassClearance } from "./clearance";

export class CONNECTIVITY_DATA {
	private m_connAlgo: CN_CONNECTIVITY_ALGO;
	private m_nets: RN_NET[] = [];
	private m_dirtyNets: boolean[] = [];
	private m_netcodeMap: Map<number, string> = new Map();
	// The board's net list (net code -> name -> netclass). Mirrors
	// CONNECTIVITY_DATA / BOARD::GetNetInfo.
	private m_netInfo = new NETINFO_LIST();
	private m_progressReporter: any = null;
	private m_netSettings: any = null;
	private m_isLocal: boolean = false;
	private m_globalConnectivityData: CONNECTIVITY_DATA | null = null;
	private m_skipRatsnestUpdate: boolean = false;
	// Local (drag) ratsnest lines. Mirrors CONNECTIVITY_DATA::m_dynamicRatsnest.
	private m_dynamicRatsnest: RN_DYNAMIC_LINE[] = [];
	// The dynamic (moving selection) connectivity data. Mirrors
	// CONNECTIVITY_DATA::m_dynamicData.
	private m_dynamicData: CONNECTIVITY_DATA | null = null;

	/**
	 * Mirrors the two CONNECTIVITY_DATA constructors:
	 *   CONNECTIVITY_DATA()
	 *   CONNECTIVITY_DATA( aBoard, aLocalItems, aSkipRatsnestUpdate )
	 */
	constructor(aBoard?: any, aLocalItems?: any[], aSkipRatsnestUpdate: boolean = false) {
		this.m_connAlgo = new CN_CONNECTIVITY_ALGO(this);
		this.m_skipRatsnestUpdate = aSkipRatsnestUpdate;

		if (aBoard && aLocalItems) {
			// Local connectivity: mirrors
			//   CONNECTIVITY_DATA( BOARD* aBoard,
			//                      const std::vector<BOARD_ITEM*>& aLocalItems,
			//                      bool aSkipRatsnestUpdate )
			this.m_isLocal = true;
			this.m_connAlgo.LocalBuild(this, aLocalItems);
			this.m_netSettings = aBoard.GetNetSettings ? aBoard.GetNetSettings() : null;
		}
	}

	Build(aBoard: any, aReporter: any = null): boolean {
		this.m_connAlgo = new CN_CONNECTIVITY_ALGO(this);
		this.m_connAlgo.Build(aBoard, aReporter);

		this.RefreshNetcodeMap(aBoard);

		this.internalRecalculateRatsnest();

		return true;
	}

	LocalBuild(aGlobalConnectivity: CONNECTIVITY_DATA, aLocalItems: any[]): void {
		this.m_isLocal = true;
		this.m_globalConnectivityData = aGlobalConnectivity;
		this.m_connAlgo = new CN_CONNECTIVITY_ALGO(this);
		this.m_connAlgo.LocalBuild(aGlobalConnectivity, aLocalItems);
	}

	/**
	 * Associates the dynamic (moving-selection) connectivity data used by
	 * ComputeLocalRatsnest(). Mirrors the C++ assignment of m_dynamicData
	 * before a drag.
	 */
	SetDynamicConnectivity(aDynamic: CONNECTIVITY_DATA | null): void {
		this.m_dynamicData = aDynamic;
	}

	/** Returns the attached dynamic (moving-selection) connectivity data. */
	GetDynamicConnectivity(): CONNECTIVITY_DATA | null {
		return this.m_dynamicData;
	}

	Add(aItem: any): boolean {
		return this.m_connAlgo.Add(aItem);
	}

	Remove(aItem: any): boolean {
		return this.m_connAlgo.RemoveItem(aItem);
	}

	Update(aItem: any): boolean {
		this.m_connAlgo.RemoveItem(aItem);
		return this.Add(aItem);
	}

	ClearRatsnest(): void {
		this.m_nets = [];
		this.m_dirtyNets = [];
		this.m_connAlgo.Clear();
	}

	GetNetCount(): number {
		return this.m_connAlgo.NetCount();
	}

	/** Mirrors CONNECTIVITY_DATA::GetRatsnestForNet(). */
	GetRatsnestForNet(aNet: number): RN_NET | null {
		if (aNet < 0 || aNet >= this.m_nets.length) {
			return null;
		}

		return this.m_nets[aNet] ?? null;
	}

	PropagateNets(aCommit: any = null): void {
		this.m_connAlgo.PropagateNets(aCommit);
	}

	RecalculateRatsnest(aCommit: any = null): void {
		this.internalRecalculateRatsnest(aCommit);
	}

	/** Mirrors CONNECTIVITY_DATA::updateRatsnest() — recompute all dirty nets
	 * with nodes, then optimize edge ends. Single-threaded port of KiCad's
	 * parallel task loops; same iteration order. */
	private updateRatsnest(): void {
		// Start with net 1 as net 0 is reserved for not-connected.
		// Nets without nodes are also ignored.
		const dirtyNets: RN_NET[] = [];

		for (let i = 1; i < this.m_nets.length; i++) {
			const net = this.m_nets[i]!;

			if (net.IsDirty() && net.GetNodeCount() > 0) {
				dirtyNets.push(net);
			}
		}

		for (const net of dirtyNets) {
			net.UpdateNet();
		}

		for (const net of dirtyNets) {
			net.OptimizeRNEdges();
		}
	}

	/** Mirrors CONNECTIVITY_DATA::addRatsnestCluster(). */
	private addRatsnestCluster(aCluster: CN_CLUSTER): void {
		const rnNet = this.m_nets[aCluster.OriginNet()]!;
		rnNet.AddCluster(aCluster);
	}

	internalRecalculateRatsnest(aCommit: any = null): void {
		if (this.m_skipRatsnestUpdate) {
			return;
		}

		this.m_connAlgo.PropagateNets(aCommit);

		const lastNet = this.m_connAlgo.NetCount();

		if (lastNet >= this.m_nets.length) {
			const prevSize = this.m_nets.length;
			this.m_nets.length = lastNet + 1;

			for (let i = prevSize; i < this.m_nets.length; i++) {
				this.m_nets[i] = new RN_NET(i);
			}
		}
		else {
			for (let ii = lastNet; ii < this.m_nets.length; ++ii) {
				this.m_nets[ii]?.Clear();
			}
		}

		const clusters = this.m_connAlgo.GetClusters();

		for (let net = 0; net < lastNet; net++) {
			if (this.m_connAlgo.IsNetDirty(net)) {
				this.m_nets[net]?.Clear();
			}
		}

		for (const c of clusters) {
			const net = c.OriginNet();

			// Don't add intentionally-kept zone islands to the ratsnest
			if (c.IsOrphaned() && c.Size() === 1) {
				let first: CN_ITEM | null = null;
				for (const it of c) {
					first = it;
					break;
				}

				if (first instanceof CN_ZONE_LAYER) {
					continue;
				}
			}

			if (this.m_connAlgo.IsNetDirty(net)) {
				this.addRatsnestCluster(c);
			}
		}

		this.m_connAlgo.ClearDirtyFlags();

		if (!this.m_skipRatsnestUpdate) {
			this.updateRatsnest();
		}
	}

	/** Mirrors CONNECTIVITY_DATA::GetRatsnestForItems(). */
	GetRatsnestForItems(aItems: any[]): CN_EDGE[] {
		const nets = new Set<number>();
		const edges: CN_EDGE[] = [];
		const itemSet = new Set<any>();

		for (const item of aItems) {
			if (item.Type() === KICAD_T.PCB_FOOTPRINT_T) {
				for (const pad of item.Pads()) {
					nets.add(pad.GetNetCode());
					itemSet.add(pad);
				}
			}
			else if (item.IsConnected()) {
				itemSet.add(item);
				nets.add(item.GetNetCode());
			}
		}

		for (const netcode of nets) {
			const net = this.GetRatsnestForNet(netcode);

			if (!net) {
				continue;
			}

			for (const edge of net.GetEdges()) {
				const srcNode = edge.GetSourceNode();
				const dstNode = edge.GetTargetNode();

				if (!srcNode || srcNode.Dirty() || !dstNode || dstNode.Dirty()) {
					continue;
				}

				const srcParent = srcNode.Parent();
				const dstParent = dstNode.Parent();

				const srcFound = itemSet.has(srcParent);
				const dstFound = itemSet.has(dstParent);

				if (srcFound && dstFound) {
					edges.push(edge);
				}
			}
		}

		return edges;
	}

	/** Mirrors CONNECTIVITY_DATA::GetRatsnestForPad(). */
	GetRatsnestForPad(aPad: any): CN_EDGE[] {
		const edges: CN_EDGE[] = [];
		const net = this.GetRatsnestForNet(aPad.GetNetCode());

		if (!net) {
			return edges;
		}

		for (const edge of net.GetEdges()) {
			const srcNode = edge.GetSourceNode();
			const dstNode = edge.GetTargetNode();

			if (!srcNode || srcNode.Dirty()) {
				continue;
			}

			if (!dstNode || dstNode.Dirty()) {
				continue;
			}

			if (srcNode.Parent() === aPad || dstNode.Parent() === aPad) {
				edges.push(edge);
			}
		}

		return edges;
	}

	GetUnconnectedCount(): number {
		let count = 0;
		for (const cluster of this.m_connAlgo.GetClusters()) {
			if (cluster.OriginNet() < 0) {
				count++;
			}
		}
		return count;
	}

	// ---------------------------------------------------------------------
	// Local (drag) ratsnest — mirrors connectivity_data.cpp methods.
	// ---------------------------------------------------------------------

	/**
	 * Mirrors CONNECTIVITY_DATA::ClearLocalRatsnest(). Un-hides every anchor
	 * in the item map and clears the dynamic (drag) line list.
	 */
	ClearLocalRatsnest(): void {
		this.m_connAlgo.ForEachAnchor((anchor: CN_ANCHOR) => {
			anchor.SetNoLine(false);
		});

		this.m_dynamicRatsnest = [];
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::HideLocalRatsnest(). Clears the dynamic
	 * (drag) line list but leaves anchor no-line flags untouched.
	 */
	HideLocalRatsnest(): void {
		this.m_dynamicRatsnest = [];
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::BlockRatsnestItems(). Marks all anchors of
	 * the given items as no-line so they are excluded from the (recomputed)
	 * static ratsnest during a drag.
	 */
	BlockRatsnestItems(aItems: any[]): void {
		for (const item of aItems) {
			for (const [mapItem, entry] of this.m_connAlgo.ItemMap().entries()) {
				if (mapItem === item) {
					for (const cnitem of entry.GetItems()) {
						for (const anchor of cnitem.Anchors()) {
							anchor.SetNoLine(true);
						}
					}
				}
			}
		}
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::ComputeLocalRatsnest(). Computes the
	 * dynamic ratsnest for the moving selection: the closest pairs between
	 * the moving (dynamic) nets and the static (board) nets, plus the
	 * internal airwires between the moving items themselves.
	 *
	 * C++ signature:
	 *   ComputeLocalRatsnest( aItems, aDynamicData, aInternalOffset = 0 )
	 * — the out-param aDynamicData is returned here (TS convention).
	 */
	ComputeLocalRatsnest(aItems: any[], aInternalOffset: number = 0): RN_DYNAMIC_LINE[] {
		this.m_dynamicRatsnest = [];
		const aDynamicData: RN_DYNAMIC_LINE[] = [];

		if (!this.m_dynamicData) {
			return aDynamicData;
		}

		const dynamicNets: RN_NET[] = (this.m_dynamicData as any).m_nets ?? [];

		// Net 1 is the first real net; net 0 is reserved for not-connected.
		const lim = Math.min(this.m_nets.length, dynamicNets.length);

		for (let net = 1; net < lim; net++) {
			const dynamicNet = dynamicNets[net];

			if (!dynamicNet || dynamicNet.GetNodeCount() === 0) {
				continue;
			}

			// Nets identical in the two databases have no dynamic lines.
			const staticNet = this.m_nets[net];

			if (!staticNet || staticNet.GetNodeCount() === dynamicNet.GetNodeCount()) {
				continue;
			}

			const pair = staticNet.NearestBicoloredPair(dynamicNet);

			if (pair) {
				// Port of the C++ (void)0-origin guard:
				//   if( pos1 != VECTOR2I(0,0) || pos2 != VECTOR2I(0,0) )
				const isZero =
					(pair.pos1.x === 0 && pair.pos1.y === 0) &&
					(pair.pos2.x === 0 && pair.pos2.y === 0);

				if (!isZero) {
					this.m_dynamicRatsnest.push({ netCode: net, a: pair.pos1, b: pair.pos2 });
					aDynamicData.push({ netCode: net, a: pair.pos1, b: pair.pos2 });
				}
			}
		}

		// Internal ratsnest for the moving part: hide the anchors of the
		// moving items (footprints → their pads; otherwise the item itself)
		// so GetRatsnestForItems returns only the internal airwires of the
		// moving set.
		for (const item of aItems) {
			if (item.Type?.() === KICAD_T.PCB_FOOTPRINT_T) {
				for (const pad of item.Pads()) {
					this.BlockRatsnestItems([pad]);
				}
			}
			else {
				this.BlockRatsnestItems([item]);
			}
		}

		for (const edge of this.GetRatsnestForItems(aItems)) {
			const nodeA = edge.GetSourceNode();
			const nodeB = edge.GetTargetNode();

			if (!nodeA || !nodeB) {
				continue;
			}

			const a = nodeA.Parent().GetPosition().add(new Vec2(aInternalOffset, aInternalOffset));
			const b = nodeB.Parent().GetPosition().add(new Vec2(aInternalOffset, aInternalOffset));

			this.m_dynamicRatsnest.push({ netCode: nodeA.Parent().GetNetCode(), a, b });
			aDynamicData.push({ netCode: nodeA.Parent().GetNetCode(), a, b });
		}

		return aDynamicData;
	}

	/**
	 * Returns the current dynamic (drag) ratsnest lines (m_dynamicRatsnest).
	 */
	GetLocalRatsnest(): RN_DYNAMIC_LINE[] {
		return this.m_dynamicRatsnest;
	}

	// ---------------------------------------------------------------------
	// C++ query helpers — mirrors connectivity_data.cpp
	// ---------------------------------------------------------------------

	/**
	 * Mirrors CONNECTIVITY_DATA::Move( const VECTOR2I& aDelta ).
	 * Moves every connectivity anchor by aDelta. As in KiCad, this does NOT
	 * move the RTree bounding boxes — it is only valid for the dynamic
	 * ratsnest, not further connectivity rebuilds.
	 */
	Move(aDelta: Vec2): void {
		this.m_connAlgo.Move(aDelta);
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::GetNetItems( int aNetCode, const KICAD_T aTypes[] ).
	 * Returns all connected board items belonging to aNetCode whose type is
	 * in aTypes (null / empty = all types).
	 */
	GetNetItems(aNetCode: number, aTypes?: number[]): any[] {
		const items: any[] = [];

		for (const [mapItem, entry] of this.m_connAlgo.ItemMap().entries()) {
			if (!entry.IsLinked()) {
				continue;
			}

			if (mapItem.GetNetCode?.() !== aNetCode) {
				continue;
			}

			if (aTypes && aTypes.length > 0 && !aTypes.includes(mapItem.Type())) {
				continue;
			}

			items.push(mapItem);
		}

		return items;
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::GetConnectedItemsAtAnchor().
	 * Returns the connected items that share aNet's node at aAnchor.
	 */
	GetConnectedItemsAtAnchor(aItem: any, aAnchor: Vec2, aTypes?: number[]): any[] {
		const list: any[] = [];

		if (!aItem || aItem.GetNetCode?.() <= 0) {
			return list;
		}

		const rnNet = this.GetRatsnestForNet(aItem.GetNetCode());

		if (!rnNet) {
			return list;
		}

		for (const node of rnNet.GetNodesAtAnchor(aItem, aAnchor)) {
			if (!node.Valid()) {
				continue;
			}

			const connectedItem: any = node.Parent();

			if (connectedItem === aItem) {
				continue;
			}

			if (connectedItem.GetNetCode() !== aItem.GetNetCode()) {
				continue;
			}

			if (aTypes && aTypes.length > 0 && !aTypes.includes(connectedItem.Type())) {
				continue;
			}

			list.push(connectedItem);
		}

		return list;
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::GetConnectedItems( const BOARD_CONNECTED_ITEM* aItem, const KICAD_T aTypes[] ).
	 * Equivalent to GetConnectedItemsAtAnchor at the item's own position.
	 */
	GetConnectedItems(aItem: any, aTypes?: number[]): any[] {
		return this.GetConnectedItemsAtAnchor(aItem, aItem.GetPosition(), aTypes);
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::GetConnectedPads( const BOARD_CONNECTED_ITEM* aItem ).
	 */
	GetConnectedPads(aItem: any): any[] {
		return this.GetConnectedItems(aItem, [KICAD_T.PCB_PAD_T]);
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::GetConnectedTracks( const BOARD_CONNECTED_ITEM* aItem ).
	 */
	GetConnectedTracks(aItem: any): any[] {
		return this.GetConnectedItems(aItem, [KICAD_T.PCB_TRACE_T, KICAD_T.PCB_ARC_T, KICAD_T.PCB_VIA_T]);
	}

	/**
	 * Mirrors CONNECTIVITY_DATA::NearestUnconnectedTargets().
	 * Returns up to aMaxCount positions reachable via unmade (airwire) edges
	 * from aRef's net, sorted by distance from aPos.
	 */
	NearestUnconnectedTargets(aRef: any, aPos: Vec2, aMaxCount: number = -1): Vec2[] {
		const targets: Vec2[] = [];

		if (!aRef || aRef.GetNetCode?.() <= 0) {
			return targets;
		}

		const rnNet = this.GetRatsnestForNet(aRef.GetNetCode());

		if (!rnNet) {
			return targets;
		}

		for (const node of rnNet.GetNodes()) {
			if (!node.Valid()) {
				continue;
			}

			const item: any = node.Parent();

			if (item === aRef) {
				continue;
			}

			if (node.GetNoLine()) {
				continue;
			}

			targets.push(node.Pos());
		}

		targets.sort((a, b) => a.sub(aPos).magnitude - b.sub(aPos).magnitude);

		if (aMaxCount >= 0 && targets.length > aMaxCount) {
			targets.length = aMaxCount;
		}

		return targets;
	}

	SetProgressReporter(aReporter: any): void {
		this.m_progressReporter = aReporter;
		this.m_connAlgo.SetProgressReporter(aReporter);
	}

	RefreshNetcodeMap(aBoard: any): void {
		this.m_netcodeMap.clear();
		const netInfo = aBoard.GetNetInfo ? aBoard.GetNetInfo() : [];
		const list: { GetNetCode(): number; GetNetname(): string }[] = [];
		for (const net of netInfo) {
			this.m_netcodeMap.set(net.GetNetCode(), net.GetNetname());
			list.push({ GetNetCode: () => net.GetNetCode(), GetNetname: () => net.GetNetname() });
		}
		this.m_netInfo.Build(list);
	}

	/** The board's net list (net code -> name -> netclass). */
	GetNetInfo(): NETINFO_LIST {
		return this.m_netInfo;
	}

	/** Returns the net item for a net code, or null. */
	GetNetItem(aNetCode: number): NETINFO_ITEM | null {
		return this.m_netInfo.GetNetItem(aNetCode);
	}

	/** Returns the net name for a net code. */
	GetNetname(aNetCode: number): string {
		return this.m_netInfo.GetNetname(aNetCode);
	}

	/**
	 * The effective clearance of an item (a local override or its netclass
	 * default), falling back to `aFallback`.
	 */
	GetItemClearance(aItem: any, aFallback = 0.2): number {
		const local = aItem?.GetLocalClearance?.();
		if (typeof local === 'number' && local !== 0) {
			return local;
		}
		const net = aItem?.GetNetCode?.();
		if (typeof net === 'number' && net > 0) {
			return NetClassClearance(this.m_netInfo, net, aFallback);
		}
		return aFallback;
	}

	/** The default netclass (for pads/tracks with no explicit netclass). */
	GetDefaultNetClass(): NETCLASS {
		return this.m_netInfo.GetDefault();
	}

	GetNetSettings(): any {
		return this.m_netSettings;
	}

	/** Mirrors CONNECTIVITY_DATA::MarkItemNetAsDirty(). */
	MarkItemNetAsDirty(aItem: any): void {
		if (aItem.Type() === KICAD_T.PCB_FOOTPRINT_T) {
			for (const pad of aItem.Pads()) {
				this.m_connAlgo.MarkNetAsDirty(pad.GetNetCode());
			}
		}

		if (aItem.IsConnected()) {
			this.m_connAlgo.MarkNetAsDirty(aItem.GetNetCode());
		}
	}

	/** Mirrors CONNECTIVITY_DATA::RemoveInvalidRefs(). */
	RemoveInvalidRefs(): void {
		this.m_connAlgo.RemoveInvalidRefs();

		for (const rnNet of this.m_nets) {
			rnNet?.RemoveInvalidRefs();
		}
	}

	GetClusters(): CN_CLUSTER[] {
		return this.m_connAlgo.GetClusters();
	}

	GetConnectivityAlgo(): CN_CONNECTIVITY_ALGO {
		return this.m_connAlgo;
	}
}