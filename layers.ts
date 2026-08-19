import { buildBoardRatsnest } from './paint/BoardRatsnest';

export function refreshRatsnestForFootprints(session: any, footprints: Iterable<any>): void {
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
	const freshLines = buildBoardRatsnest(session.scene, netIds);
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
		session.geometryDirty = true;
		session.scheduleRender();
	}
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
	if (session.ratsnestVisible && session.dragPreviewRatsnestEdges.length > 0) {
		const padCenters = new Map<string, any>();
		for (const item of previewPadItems) {
			padCenters.set(item.id, { x: item.bbox.x + item.bbox.w / 2, y: item.bbox.y + item.bbox.h / 2 });
		}
		for (const edge of session.dragPreviewRatsnestEdges) {
			const center = padCenters.get(edge.padId);
			const line = session.ratsnestLines[edge.lineIndex];
			if (!center || !line) {
				continue;
			}
			if (edge.endpoint === 'from') {
				line.from = center;
			}
			else {
				line.to = center;
			}
		}
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
	for (const footprint of footprints) {
		session.painter.updateFootprintItems(session.scene, session.boardRoot, footprint);
	}
	refreshRatsnestForFootprints(session, footprints);
	session.geometryDirty = true;
	session.scheduleRender();
}
