import { buildBoardRatsnest } from './paint/BoardRatsnest';
import { defaultLayerState } from './paint/BoardPainter';
import { defaultSchLayerState } from './paint/SchematicPainter';
import { refreshRatsnestForFootprints } from './layers';

export function rebuildActiveScene(session: any): void {
	if (session.documentType === 'schematic') {
		rebuildSchScene(session);
	}
	else {
		session.boardStructureDirty = true;
		session.scheduleRender();
	}
}

export function scheduleFootprintRebuild(session: any, footprint: any): void {
	if (session.dragPreviewFootprints.has(footprint)) {
		return;
	}
	session.boardDirtyFootprints.add(footprint);
	session.scheduleRender();
}

export function rebuildAfterFootprintGeometryEdit(session: any, footprint: any): void {
	if (session.dragPreviewFootprints.has(footprint)) {
		session.dragPreviewFootprints.set(
			footprint, session.painter.buildFootprintPreviewItems(session.boardRoot, footprint));
		session.geometryDirty = true;
		session.scheduleRender();
		return;
	}
	scheduleFootprintRebuild(session, footprint);
}

export function rebuildSchScene(session: any): void {
	if (!session.schematicRoot) {
		return;
	}
	session.schScene = session.schematicPainter.build(session.schematicRoot, session.schematicDocInfo);
	session.schLayerState = defaultSchLayerState(session.schScene.layersPresent);
	session.geometryDirty = true;
	session.scheduleRender();
}

export function rebuildBoardSceneIfPending(session: any): void {
	if (!session.boardRoot) {
		session.boardStructureDirty = false;
		session.boardDirtyFootprints.clear();
		return;
	}
	if (session.boardStructureDirty) {
		session.boardStructureDirty = false;
		session.boardDirtyFootprints.clear();
		const previousLayerState = session.layerState;
		session.scene = session.painter.build(session.boardRoot);
		session.ratsnestLines = buildBoardRatsnest(session.scene);
		session.layerState = defaultLayerState(session.scene.layersPresent);
		for (const [layer, state] of session.layerState) {
			const previous = previousLayerState.get(layer);
			if (previous) {
				state.visible = previous.visible;
				state.opacity = previous.opacity;
			}
		}
		session.geometryDirty = true;
		return;
	}
	if (session.boardDirtyFootprints.size > 0 && session.scene) {
		for (const footprint of session.boardDirtyFootprints) {
			session.painter.updateFootprintItems(session.scene, session.boardRoot, footprint);
		}
		refreshRatsnestForFootprints(session, session.boardDirtyFootprints);
		session.boardDirtyFootprints.clear();
		session.geometryDirty = true;
	}
}
