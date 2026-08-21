/*
 * This file provides the public API for the KiCad-based ratsnest/connectivity
 * engine (shared/kicad-render/connectivity), bridging the renderer's scene
 * model (LayeredBoardScene / PaintedItem) to the connectivity port.
 *
 * The connectivity classes in this folder are 1:1 ports of KiCad's
 * pcbnew/connectivity/*.{h,cpp} — see connectivity/README.md for the
 * porting convention. This file is the ONLY place that knows how to turn a
 * scene into the "board" facade those classes expect; everything below the
 * CONNECTIVITY_DATA boundary is pure KiCad translation.
 *
 * Copyright (C) 2013-2017 CERN
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 */

import type { LayeredBoardScene, PaintedItem } from '../paint/BoardPainter';
import type { BoardRatsnestLine } from '../paint/legacy/BoardRatsnest';
import { LSET } from './ConnectivityItems';
import { CONNECTIVITY_DATA } from './ConnectivityData';
import { BoardAdapter } from './BoardAdapter';
import { buildBoardFacadeFromAst, AstAdapter } from './KicadBoardFacade';
import type { RN_DYNAMIC_LINE } from './RatsnestData';

/**
 * Builds the ratsnest for a whole board from the parsed AST — the
 * C++-faithful path (pads grouped by footprint, arcs as PCB_ARC_T, via
 * layers, populated netinfo). `aBoardRoot` is the session's parsed
 * `(kicad_pcb ...)` root ({ rootElement }).
 */
export function buildKiCadRatsnestFromBoard(
	boardRoot: { rootElement: any },
	scene: LayeredBoardScene,
	netIds?: Set<number>
): BoardRatsnestLine[] {
	try {
		const connData = new CONNECTIVITY_DATA();
		connData.Build(buildBoardFacadeFromAst(boardRoot.rootElement, scene));
		return BuildRatsnestEdges(connData, netIds);
	}
	catch (error) {
		console.error('buildKiCadRatsnestFromBoard error:', error);
		return [];
	}
}

/** Flattens a CONNECTIVITY_DATA's per-net MST edges into the legacy
 * BoardRatsnestLine[] shape the renderer paints. Exported so the session can
 * hold a persistent CONNECTIVITY_DATA and flatten its edges on demand. */
export function flattenRatsnestEdges(
	connData: CONNECTIVITY_DATA,
	netIds?: Set<number>
): BoardRatsnestLine[] {
	return BuildRatsnestEdges(connData, netIds);
}

export function buildKiCadRatsnest(
	scene: LayeredBoardScene,
	netIds?: Set<number>
): BoardRatsnestLine[] {
	try {
		const connData = new CONNECTIVITY_DATA();
		BuildConnectivity(connData, scene);
		return BuildRatsnestEdges(connData, netIds);
	}
	catch (error) {
		console.error('buildKiCadRatsnest error:', error);
		return [];
	}
}

/**
 * Greedy ratsnest is not ported from KiCad (KiCad only has the Delaunay/MST
 * approach — see pcbnew/ratsnest/ratsnest_data.cpp). Kept as an alias so
 * existing callers keep working; remove once nothing references it.
 */
export function buildGreedyRatsnest(
	scene: LayeredBoardScene,
	netIds?: Set<number>
): BoardRatsnestLine[] {
	return buildKiCadRatsnest(scene, netIds);
}

function shouldProcessItem(item: PaintedItem): boolean {
	if (!item.netId || item.netId <= 0) {
		return false;
	}
	return (
		item.kind === 'pad' ||
		item.kind === 'track' ||
		item.kind === 'via' ||
		item.kind === 'zone'
	);
}

/**
 * Builds a board facade from the scene and feeds it to the connectivity
 * engine. The facade is deliberately minimal — just enough for
 * CN_CONNECTIVITY_ALGO::Build() (which iterates Zones/Tracks/Footprints/
 * Drawings and adds each item) — and each scene item is wrapped in a
 * BoardAdapter that presents the CN_ITEM_PARENT / BOARD_ITEM interface.
 *
 * The C++ flow this mirrors is CONNECTIVITY_DATA::Build() →
 * CN_CONNECTIVITY_ALGO::Build() → internalRecalculateRatsnest(), all of
 * which the port implements (see ConnectivityData.ts / ConnectivityAlgo.ts).
 */
function BuildConnectivity(connData: CONNECTIVITY_DATA, scene: LayeredBoardScene): void {
	const pads: BoardAdapter[] = [];
	const tracks: BoardAdapter[] = [];
	const vias: BoardAdapter[] = [];
	const zones: BoardAdapter[] = [];

	for (const item of scene.hitTestItems) {
		if (!shouldProcessItem(item)) {
			continue;
		}

		const adapter = new BoardAdapter(item, scene);

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

	// Each pad gets its own synthetic footprint; the connectivity code only
	// needs footprint.Pads() to reach the pads (the algo's Add() handles
	// FP_JUST_ADDED / parent-footprint guards defensively).
	const footprints = pads.map((pad) => ({
		GetAttributes: () => 0,
		Pads: () => [pad],
	}));

	const board = {
		Zones: () => zones,
		Tracks: () => tracks,
		Footprints: () => footprints,
		Drawings: () => [],
		GetEnabledLayers: () => new LSET().AllCuMask(),
		GetNetInfo: () => [],
	};

	connData.Build(board);
}

/**
 * Flattens the computed RN_NETs (per-net MST airwires) into the same
 * BoardRatsnestLine[] shape the legacy greedy path emits, so the renderer
 * paints both identically.
 */
function BuildRatsnestEdges(
	connData: CONNECTIVITY_DATA,
	netIds?: Set<number>
): BoardRatsnestLine[] {
	const edges: BoardRatsnestLine[] = [];
	const netCount = connData.GetNetCount();

	for (let net = 0; net < netCount; net++) {
		if (netIds && !netIds.has(net)) {
			continue;
		}

		const rnNet = connData.GetRatsnestForNet(net);
		if (!rnNet) {
			continue;
		}

		for (const edge of rnNet.GetEdges()) {
			const src = edge.GetSourceNode();
			const dst = edge.GetTargetNode();

			if (!src || !dst) {
				continue;
			}

			if (src.GetNoLine() || dst.GetNoLine()) {
				continue;
			}

			edges.push({ from: src.Pos(), to: dst.Pos(), netId: net });
		}
	}

	return edges;
}

/** Returns the AST footprint children of a board root, as adapters. */
function footprintAdaptersOf(
	rootElement: any,
	scene: LayeredBoardScene,
	footprintEls: Iterable<any>
): AstAdapter[] {
	const adapters: AstAdapter[] = [];
	for (const fp of footprintEls) {
		adapters.push(new AstAdapter(fp, 'footprint', scene));
	}
	void rootElement;
	return adapters;
}

/**
 * Builds a fresh CONNECTIVITY_DATA over only the given footprint elements
 * (a "local" connectivity mirroring the C++ drag model's dynamic data, which
 * is built over just the moved items). Positions are read live from the AST
 * elements, so after their origins are updated (e.g. by
 * moveFootprintByPaintId / translateBoardSelection) a subsequent
 * `connData.RecalculateRatsnest()` reflects the new positions.
 */
export function buildLocalConnectivityForFootprints(
	rootElement: any,
	scene: LayeredBoardScene,
	footprintEls: Iterable<any>
): CONNECTIVITY_DATA {
	const footprints = footprintAdaptersOf(rootElement, scene, footprintEls);

	const localBoard = {
		Zones: () => [],
		Tracks: () => [],
		Footprints: () => footprints,
		Drawings: () => [],
		GetEnabledLayers: () => new LSET().AllCuMask(),
		GetNetInfo: () => {
			const netInfo: { GetNetCode(): number; GetNetname(): string }[] = [];
			for (const child of rootElement?.children ?? []) {
				if (child?.name === 'net') {
					const id = child.id ?? 0;
					const name = child.netName ?? '';
					netInfo.push({ GetNetCode: () => id, GetNetname: () => name });
				}
			}
			return netInfo;
		},
	};

	const connData = new CONNECTIVITY_DATA();
	connData.Build(localBoard);
	return connData;
}

/**
 * Converts the connectivity engine's dynamic (drag) lines into the
 * BoardRatsnestLine[] the renderer paints. Lines reference live pad
 * positions, so they stay glued to the moving items as the drag proceeds.
 */
export function flattenDynamicRatsnest(lines: RN_DYNAMIC_LINE[]): BoardRatsnestLine[] {
	return lines.map((line) => ({
		from: line.a,
		to: line.b,
		netId: line.netCode,
	}));
}
