/*
 * Model-backed incremental connectivity controller.
 *
 * Holds a persistent CONNECTIVITY_DATA over a kicad-model Board (bridged
 * through a LayeredBoardScene — the same scene BoardPainter.buildFromModel
 * produces) so that the expensive full CN_CONNECTIVITY_ALGO::Build +
 * searchConnections (on a dense board this is the ~40s single-threaded full
 * search) runs ONCE at load, and every edit afterwards re-searches only the
 * dirty nets. This mirrors KiCad's own incremental model: CONNECTIVITY_DATA
 * Update()/RecalculateRatsnest() → CN_CONNECTIVITY_ALGO::searchConnections()
 * iterates only the flagged dirty items (see ConnectivityAlgo.searchConnections).
 *
 * Copyright (C) 2024 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 */
import type { LayeredBoardScene, PaintedItem } from '../paint/BoardPainter';
import type { BoardRatsnestLine } from '../paint/legacy/BoardRatsnest';
import { CONNECTIVITY_DATA } from './ConnectivityData';
import { BoardAdapter } from './BoardAdapter';
import { LSET } from './ConnectivityItems';
import { flattenRatsnestEdges } from './KicadRatsnest';

/**
 * Incremental connectivity over a model Board. The scene is the bridge from
 * the model items to the CN_ITEM_PARENT adapters the algo expects; each
 * model-feedable item is keyed so edits can be applied incrementally.
 */
export class BoardConnectivity {
	private connData: CONNECTIVITY_DATA;
	private adapterByItem = new Map<unknown, BoardAdapter>();
	private itemNetCode = new Map<unknown, number>();
	private readonly netIds: Set<number> | undefined;

	constructor(netIds?: Set<number>) {
		this.connData = new CONNECTIVITY_DATA();
		this.netIds = netIds;
	}

	/** Full (re)build over a model-backed scene. This is the one expensive
	 * pass; call it once at load or when the board structure changes broadly. */
	rebuild(scene: LayeredBoardScene): void {
		this.connData = new CONNECTIVITY_DATA();
		this.adapterByItem.clear();
		this.itemNetCode.clear();

		const pads: BoardAdapter[] = [];
		const tracks: BoardAdapter[] = [];
		const vias: BoardAdapter[] = [];
		const zones: BoardAdapter[] = [];

		for (const item of scene.hitTestItems) {
			if (!shouldProcess(item)) {
				continue;
			}
			const adapter = new BoardAdapter(item, scene);
			if (item.element) {
				this.adapterByItem.set(item.element, adapter);
			}
			if (item.netId) {
				this.adapterByItem.set(item.element, adapter);
				this.itemNetCode.set(item.element, item.netId);
			}
			switch (item.kind) {
				case 'pad':
					pads.push(adapter);
					break;
				case 'track':
					tracks.push(adapter);
					break;
				case 'via':
					vias.push(adapter);
					break;
				case 'zone':
					zones.push(adapter);
					break;
			}
		}
		const footprints = pads.map((pad) => ({
			GetAttributes: () => 0,
			Pads: () => [pad],
		}));

		this.connData.Build({
			Zones: () => zones,
			Tracks: () => tracks,
			Footprints: () => footprints,
			Drawings: () => [],
			GetEnabledLayers: () => new LSET().AllCuMask(),
			GetNetInfo: () => [],
		});
	}

	/** An item was added/moved/resized/re-netted. Marks the affected net(s)
	 * dirty and re-runs the incremental search + ratsnest, which processes
	 * only the dirty net's items (see CN_CONNECTIVITY_ALGO.searchConnections). */
	notifyChanged(item: unknown): boolean {
		const adapter = this.adapterByItem.get(item);
		if (!adapter) {
			return false;
		}
		this.connData.Update(adapter);
		this.connData.RecalculateRatsnest();
		return true;
	}

	/** Item removed from the board. */
	notifyRemoved(item: unknown): boolean {
		const adapter = this.adapterByItem.get(item);
		if (!adapter) {
			return false;
		}
		const changed = this.connData.Remove(adapter);
		this.connData.RecalculateRatsnest();
		return changed;
	}

	/** Flatten the current per-net MST airwires. */
	ratsnest(): BoardRatsnestLine[] {
		return flattenRatsnestEdges(this.connData, this.netIds);
	}

	/** The last known net code for a model item (for net-scoped queries). */
	netOf(item: unknown): number {
		return this.itemNetCode.get(item) ?? 0;
	}
}

function shouldProcess(item: PaintedItem): boolean {
	return !!item.netId && item.netId > 0 &&
		(item.kind === 'pad' || item.kind === 'track' || item.kind === 'via' || item.kind === 'zone');
}
