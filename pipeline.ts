import { buildBoardRatsnest } from './paint/legacy/BoardRatsnest';
import { buildCopperGraph } from './paint/legacy/BoardCopperGraph';
import { defaultLayerState } from './paint/BoardPainter';
import { defaultSchLayerState } from './paint/SchematicPainter';
import { refreshRatsnestForFootprints } from './layers';
import { parseSchematic } from '@kicad-model/src/schematic/sch_io';
import { parseBoard } from '@kicad-model/src/pcb/io';

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
			footprint, session.painter.buildFootprintPreviewItems(session.boardModel, footprint));
		session.geometryDirty = true;
		session.scheduleRender();
		return;
	}
	scheduleFootprintRebuild(session, footprint);
}

export function rebuildSchScene(session: any): void {
	if (!session.schematicModel && !session.schematicRoot) {
		return;
	}
	// The retained Schematic is canonical. Parse AST only to recover from a
	// legacy load whose initial model construction failed.
	try {
		if (!session.schematicModel) {
			const text = typeof session.schematicRoot?.rootElement?.write === 'function'
				? session.schematicRoot.rootElement.write() : null;
			if (!text) throw new Error('no schematic text');
			session.schematicModel = parseSchematic(text);
		}
		session.schScene = session.schematicPainter.buildSchematicFromModel(
			session.schematicModel, session.schematicDocInfo);
		session.schLayerState = defaultSchLayerState(session.schScene.layersPresent);
		session.geometryDirty = true;
		session.scheduleRender();
		return;
	}
	catch (e) {
		console.debug('[KiOnline] model-backed repaint failed, falling back to AST', e);
	}
	if (!session.schematicRoot) return;
	session.schScene = session.schematicPainter.build(session.schematicRoot, session.schematicDocInfo);
	session.schLayerState = defaultSchLayerState(session.schScene.layersPresent);
	session.geometryDirty = true;
	session.scheduleRender();
}

export function rebuildBoardSceneIfPending(session: any): void {
	if (!session.boardModel && !session.boardRoot) {
		session.boardStructureDirty = false;
		session.boardDirtyFootprints.clear();
		return;
	}
	if (session.boardStructureDirty) {
		session.boardStructureDirty = false;
		session.boardDirtyFootprints.clear();
		const previousLayerState = session.layerState;
		// The canonical Board is the working state. AST parsing remains only
		// a recovery path for a legacy load whose model construction failed.
		try {
			if (!session.boardModel) {
				const text = typeof session.boardRoot?.rootElement?.write === 'function'
					? session.boardRoot.rootElement.write() : null;
				if (!text) throw new Error('no board text');
				session.boardModel = parseBoard(text);
			}
			session.scene = session.painter.buildFromModel(session.boardModel);
		}
		catch (e) {
			console.debug('[KiOnline] model-backed board repaint failed, falling back to AST', e);
			if (!session.boardRoot) return;
			session.scene = session.painter.build(session.boardRoot);
		}
		const graph = buildCopperGraph(session.scene);
		session.copperGraphCache = { scene: session.scene, graph };
		session.ratsnestLines = buildBoardRatsnest(session.scene, undefined, graph);
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
		session.copperGraphCache = null;
		for (const footprint of session.boardDirtyFootprints) {
			session.painter.updateFootprintItems(session.scene, session.boardModel, footprint);
		}
		refreshRatsnestForFootprints(session, session.boardDirtyFootprints);
		session.boardDirtyFootprints.clear();
		session.geometryDirty = true;
	}
}
