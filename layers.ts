import { buildBoardRatsnest } from './paint/legacy/BoardRatsnest';
import { buildGreedyRatsnest } from './paint/legacy/BoardRatsnestPreview';
import { buildCopperGraph, type CopperGraph } from './paint/legacy/BoardCopperGraph';
import { buildLocalConnectivityForFootprints, flattenDynamicRatsnest } from './connectivity/KicadRatsnest';

/**
 * Recompute ratsnest airwires only for the nets of the given footprints and
 * splice those into `session.ratsnestLines`, leaving every other net's lines
 * untouched (the net-scoped incremental path — see KicadRenderSession's
 * refreshRatsnestForFootprints doc comment).
 *
 * `graph`, when given, is a prebuilt copper graph reused instead of rebuilding
 * one internally. It may be net-filtered (built with the same net set) or the
 * full-board graph — in both cases buildBoardRatsnest is handed the `netIds`
 * filter so only the moved nets' lines are regenerated. This lets a caller
 * build the (net-scoped) graph once and reuse it across refreshes rather than
 * re-running touching-copper detection every call.
 */
export function refreshRatsnestForFootprints(session: any, footprints: Iterable<any>, graph?: CopperGraph): void {
	if (!session.ratsnestVisible || !session.scene) {
		return;
	}
	const footprintIds = new Set<string>();
	for (const footprint of footprints) {
		const uuid = typeof footprint.getUuid === 'function' ? footprint.getUuid() : null;
		if (uuid) {
			footprintIds.add(uuid);
		}
	}
	if (footprintIds.size === 0) {
		return;
	}
	const netIds = new Set<number>();
	for (const item of session.scene.hitTestItems) {
		if (item.kind !== 'pad' || item.netId == null) {
			continue;
		}
		const ownerId = item.id.split(':')[0]!;
		if (footprintIds.has(ownerId)) {
			netIds.add(item.netId);
		}
	}
	if (netIds.size === 0) {
		return;
	}
	// Synchronous incremental build so UI updates immediately.
	const freshLines = buildBoardRatsnest(session.scene, netIds, graph);
	// Background recompute in a Worker to avoid blocking on dense nets.
	try {
		if (typeof Worker !== 'undefined') {
			const nodes = (graph ?? buildCopperGraph(session.scene)).nodes;
			const find = (graph ?? buildCopperGraph(session.scene)).find;
			const anchorsByNet: Record<string, { x: number; y: number; island: number }[]> = {};
			const netToNodeIndices = new Map<number, number[]>();
			for (let index = 0; index < nodes.length; index++) {
				const netId = nodes[index]!.netId;
				if (netId == null || netId <= 0) continue;
				if (!netIds.has(netId)) continue;
				const bucket = netToNodeIndices.get(netId) ?? [];
				bucket.push(index);
				netToNodeIndices.set(netId, bucket);
			}
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
				const anchors: { x: number; y: number; island: number }[] = [];
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
				anchorsByNet[String(netId)] = anchors;
			}
			const worker = new Worker(new URL('./paint/BoardRatsnestWorker.ts', import.meta.url), { type: 'module' });
			worker.postMessage({ anchorsByNet, bench: false });
			worker.onmessage = (ev: MessageEvent) => {
				if (ev.data?.lines) {
					session.ratsnestLines = [...session.ratsnestLines.filter((line: any) => !netIds.has(line.netId)), ...ev.data.lines.map((l: any) => ({ from: { x: l.from.x, y: l.from.y }, to: { x: l.to.x, y: l.to.y }, netId: l.netId }))];
					session.scheduleRender();
				} else if (ev.data?.error) {
					console.debug('ratsnest worker error', ev.data.error);
				}
				worker.terminate();
			};
		}
	} catch (err) {
		console.debug('ratsnest worker spawn failed', err);
	}
	session.ratsnestLines = [...session.ratsnestLines.filter((line: any) => !netIds.has(line.netId)), ...freshLines];
}

export function captureDragPreviewRatsnestEdges(session: any, footprint: any): void {
	if (!session.scene) {
		return;
	}
	const uuid = typeof footprint.getUuid === 'function' ? footprint.getUuid() : null;
	if (!uuid) {
		return;
	}
	const prefix = `${ uuid }:`;
	const EPS = 1e-4;
	for (const item of session.scene.hitTestItems) {
		if (item.kind !== 'pad' || item.netId == null) {
			continue;
		}
		if (item.id !== uuid && !item.id.startsWith(prefix)) {
			continue;
		}
		const cx = item.bbox.x + item.bbox.w / 2, cy = item.bbox.y + item.bbox.h / 2;
		for (let i = 0; i < session.ratsnestLines.length; i++) {
			const line = session.ratsnestLines[i]!;
			if (line.netId !== item.netId) {
				continue;
			}
			if (Math.hypot(line.from.x - cx, line.from.y - cy) <= EPS) {
				session.dragPreviewRatsnestEdges.push({ lineIndex: i, padId: item.id, endpoint: 'from' });
			}
			if (Math.hypot(line.to.x - cx, line.to.y - cy) <= EPS) {
				session.dragPreviewRatsnestEdges.push({ lineIndex: i, padId: item.id, endpoint: 'to' });
			}
		}
	}
}

export function beginBoardDragPreview(session: any, paintIds: Iterable<string>): void {
	if (session.documentType !== 'board' || !session.boardRoot || !session.scene) {
		return;
	}
	let changed = false;
	for (const paintId of paintIds) {
		// A footprint's own field (Reference/Value/custom) drags
		// independently of its footprint (see KicadRenderSession.
		// translateBoardSelection's identical carve-out) — pulling the
		// WHOLE footprint into drag-preview here just because a field's own
		// element.parent happens to be that footprint would be both wrong
		// (the footprint itself isn't moving) and wasteful (re-tessellating
		// every pad of a footprint to drag one small text label).
		const hitItem = session.scene.hitTestItems.find((item: any) => item.id === paintId);
		if (hitItem?.kind === 'footprint-ref') {
			continue;
		}
		const el = session.footprintOwnerOfHit(paintId);
		if (el && !session.dragPreviewFootprints.has(el)) {
			if (session.ratsnestVisible) {
				captureDragPreviewRatsnestEdges(session, el);
			}
			session.painter.removeFootprintItems(session.scene, el);
			// Seed with a real preview at the CURRENT (pre-drag) position
			// right away, not an empty list — otherwise a plain click that
			// never moves (mousedown+mouseup with no mousemove between)
			// could paint one frame with the footprint gone from both the
			// static scene AND the preview.
			session.dragPreviewFootprints.set(el, session.painter.buildFootprintPreviewItems(session.boardRoot, el));
			changed = true;
		}
	}
	if (changed) {
		// Set up the dynamic (moving-selection) connectivity used by the
		// ported ComputeLocalRatsnest drag path. Build it once over just the
		// moving footprints; positions are read live from the AST so each
		// frame's RecalculateRatsnest() picks up the new origins.
		if (session.boardConnectivity && session.ratsnestVisible) {
			try {
				const moving = facadeFootprintsFor(session, session.dragPreviewFootprints.keys());
				const dynamicData = buildLocalConnectivityForFootprints(
					session.boardRoot.rootElement,
					session.scene,
					moving.map((f: any) => f.Element?.() ?? f)
				);
				session.boardConnectivity.SetDynamicConnectivity(dynamicData);
			}
			catch (err) {
				console.info('beginBoardDragPreview: dynamic connectivity build failed', err);
				session.boardConnectivity.SetDynamicConnectivity(null);
			}
		}
		console.info('beginBoardDragPreview: seeded preview footprints=', session.dragPreviewFootprints ? session.dragPreviewFootprints.size : 0);
		session.geometryDirty = true;
		session.scheduleRender();
	}
}

/** Resolves moving AST footprint elements to their retained board-facade
 *  footprint adapters (stable AstAdapter instances whose cached pads match
 *  the static connectivity item map by reference). Falls back to a fresh
 *  facade footprint when the retained facade is unavailable. */
function facadeFootprintsFor(session: any, footprintEls: Iterable<any>): any[] {
	const result: any[] = [];
	const els = [...footprintEls];
	if (!session.boardFacade?.Footprints) {
		return els;
	}
	for (const fp of session.boardFacade.Footprints()) {
		if (els.includes(fp.Element?.())) {
			result.push(fp);
		}
	}
	return result;
}

export function updateBoardDragPreview(session: any): void {
	if (!session.boardRoot || session.dragPreviewFootprints.size === 0) {
		return;
	}
	const previewPadItems: any[] = [];
	for (const footprint of session.dragPreviewFootprints.keys()) {
		const items = session.painter.buildFootprintPreviewItems(session.boardRoot, footprint);
		session.dragPreviewFootprints.set(footprint, items);
		for (const item of items) {
			if (item.kind === 'pad' && item.netId != null) {
				previewPadItems.push(item);
			}
		}
	}
	if (session.ratsnestVisible && previewPadItems.length > 0) {
		let previewLines: any[] = [];
		try {
			const movingFootprints = facadeFootprintsFor(session, session.dragPreviewFootprints.keys());
			// Ported two-connectivity drag model (ComputeLocalRatsnest):
			// refresh the dynamic connectivity's ratsnest at the current
			// (post-translate) positions, then ask the static connectivity
			// for the dynamic (drag) lines between static and moving nets
			// and within the moving set itself.
			const bc = session.boardConnectivity;
			if (bc) {
				bc.SetDynamicConnectivity(
					buildLocalConnectivityForFootprints(
						session.boardRoot.rootElement,
						session.scene,
						movingFootprints.map((f: any) => f.Element?.() ?? f)
					)
				);
				const dynamicData = bc.GetDynamicConnectivity?.();
				if (dynamicData) {
					dynamicData.RecalculateRatsnest();
					bc.ComputeLocalRatsnest(movingFootprints);
					previewLines = flattenDynamicRatsnest(bc.GetLocalRatsnest());
				}
			} else {
				// Fallback: legacy greedy MST (no static connectivity built).
				const netIdsF = new Set<number>();
				for (const item of previewPadItems) {
					if (item.netId != null) netIdsF.add(item.netId);
				}
				previewLines = buildGreedyRatsnest(session.scene, netIdsF);
			}
			console.info('updateBoardDragPreview: preview lines=%d', previewLines.length);
		} catch (err) {
			previewLines = [];
			console.info('ComputeLocalRatsnest failed', err);
		}
		session.previewRatsnestLines = previewLines;
		const netIdsSet = new Set<number>();
		for (const item of previewPadItems) {
			if (item.netId != null) netIdsSet.add(item.netId);
		}
		session.previewRatsnestNetIds = netIdsSet;
	} else {
		session.previewRatsnestLines = [];
		session.previewRatsnestNetIds = new Set();
	}
	session.scheduleRender();
}

export function endBoardDragPreview(session: any): void {
	if (!session.boardRoot || !session.scene || session.dragPreviewFootprints.size === 0) {
		return;
	}
	const footprints = [...session.dragPreviewFootprints.keys()];
	session.dragPreviewFootprints.clear();
	session.dragPreviewRatsnestEdges = [];
	session.previewRatsnestLines = [];
	session.previewRatsnestNetIds = new Set();
	// Tear down the ported two-connectivity drag state: restore all anchors'
	// no-line flags and detach the dynamic data so the static connectivity
	// returns to its normal per-net ratsnest.
	if (session.boardConnectivity) {
		try {
			session.boardConnectivity.ClearLocalRatsnest();
		} catch (err) {
			console.info('ClearLocalRatsnest failed', err);
		}
		session.boardConnectivity.SetDynamicConnectivity(null);
	}
	for (const footprint of footprints) {
		session.painter.updateFootprintItems(session.scene, session.boardRoot, footprint);
	}
	refreshRatsnestForFootprints(session, footprints);
	session.geometryDirty = true;
	session.scheduleRender();
}
