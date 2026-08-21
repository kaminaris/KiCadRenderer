/**
 * Public barrel for KiCadRenderer.
 *
 * Prefer deep imports (`@kicad-render/KicadRenderSession`, …) when you only
 * need one module; use this entry when you want a single import surface.
 *
 * Extension model: class members are `protected` (not `private` / `#field`)
 * so you can subclass `KicadRenderSession`, painters, and render backends
 * without fighting encapsulation barriers.
 */

// Session + hierarchy
export {
	KicadRenderSession,
} from './KicadRenderSession';
export type {
	RenderBackend,
	RenderDocumentType,
	LoadResult,
	HitResult,
} from './KicadRenderSession';

// Re-export internal types from the shared types module so consumers can import
// them from the package root (keeping docs and types colocated with the
// moved definitions in shared/kicad-render/types.ts).
export type {
	ZoneDraft,
	RuleAreaDraft,
	PolygonDraft,
	ResizeHandle,
	AlignAxis,
	CurveAnchor,
	SelectionCurveAnchors,
	SchLineMode,
	ZoneFillDesignSettings,
	SelectionResizeBox,
	EditPreviewState,
	ViaDragFix,
	SymbolPoseInfo,
} from './types';
export {
	buildSheetTree,
	findTreePath,
} from './SheetTree';
export type { SheetTreeNode } from './SheetTree';
export { registerDefaultKicadClasses, BoardPainter, SchematicPainter } from './RegisterDefaultClasses';
export type { BoardPaintOptions } from './RegisterDefaultClasses';
export {
	dirnameGeneric,
	basenameGeneric,
	joinPathGeneric,
} from './PathUtils';

// Board paint
export type {
	PaintedItem,
	LayeredBoardScene,
	LayerVisibilityState,
} from './paint/BoardPainter';
export {
	defaultLayerState,
	registerKicadIoClasses,
} from './paint/BoardPainter';

// Schematic paint
export type {
	SchPaintedItem,
	SchematicSheetRef,
	SchematicScene,
	SchLayerVisibilityState,
	SchematicDocInfo,
} from './paint/SchematicPainter';
export {
	defaultSchLayerState,
	registerSchematicIoClasses,
} from './paint/SchematicPainter';

// Colors / layers / shapes / hit-test / text
export {
	boardBackgroundColor,
	zoneFillAlpha,
	styleForLayer,
	colorForLayer,
	withAlpha,
} from './paint/LayerColors';
export type { LayerStyle } from './paint/LayerColors';
export {
	schematicBackgroundColor,
	schematicGridColor,
	schColors,
	setSchematicTheme,
	schematicLayerOrder,
} from './paint/SchematicColors';
export type { SchematicColorName, SchematicColorSet } from './paint/SchematicColors';
export { layerPaintOrder, layerPaintRank } from './paint/LayerOrder';
export type { PaintedShape } from './paint/PaintedShape';
export { shapeToBBox, shapeContainsPoint } from './paint/PaintedShape';
export { hitTest } from './paint/HitTest';
export type { Hittable } from './paint/HitTest';
export {
	measureStrokeTextSize,
	computeStrokeTextGeometry,
	drawStrokeTextGeometry,
	paintStrokeText,
} from './paint/TextPaint';
export type {
	StrokeTextGeometry,
	WeightedStroke,
	DotMark,
} from './paint/TextPaint';
export {
	strokeDashedPolyline,
	circleToRing,
	arcToPolyline,
} from './paint/StrokeDash';
export type { KicadStrokeLineType } from './paint/StrokeDash';
export { unescapeKicadString } from './paint/KicadStringEscapes';
export {
	defaultWksSetup,
	defaultWksItems,
	wksPaperSizes,
	resolveWksAnchor,
	withinWksMargin,
	expandTextVars,
} from './paint/DrawingSheet';
export type {
	WksAnchor,
	WksHAlign,
	WksVAlign,
	WksLineItem,
	WksRectItem,
	WksTextItem,
	WksItem,
	WksSetup,
} from './paint/DrawingSheet';

// Render backends
export type { Renderer, RenderStyle } from './render/Renderer';
export { Canvas2dRenderer } from './render/Canvas2dRenderer';
export type { FillBatch, StrokeBatch } from './render/Canvas2dRenderer';
export { WebGLRenderer } from './render/WebGLRenderer';
export type { CachedStencilJob, RawStencilJob } from './render/WebGLRenderer';

export { sceneToSvg } from './svgExporter';
export { computeWireBend } from './utils';
export { parseText, parseBoardText } from './parser';
export { pushUndoSnapshot, clearUndoRedo, canUndo, canRedo, undo, redo, cancelLatestUndoSnapshot, getUndoStackDebug, beginBatch, endBatch, commitAstMutation } from './state';

// Connectivity (ported from KiCad pcbnew/connectivity/connectivity_items.h/.cpp)
export {
	CN_ANCHOR,
	CN_ITEM,
	CN_ZONE_LAYER,
	CN_CLUSTER,
	CN_LIST,
	CN_TRI,
} from './connectivity/ConnectivityItems';
export type {
	CN_ITEM_PARENT,
	CN_SHAPE,
	KICAD_T_VALUE,
	PAD_ATTRIB_VALUE,
	PCB_LAYER_ID_VALUE,
	CN_LAYER,
} from './connectivity/ConnectivityItems';

// Math
export { Angle } from './math/Angle';
export type { AngleLike } from './math/Angle';
export { Vec2 } from './math/Vec2';
export type { Vec2Like } from './math/Vec2';
export { Matrix3 } from './math/Matrix3';
export { Camera2 } from './math/Camera2';
export { BBox } from './math/BBox';
export { isNumber } from './math/IsNumber';

// Text / fonts
export { StrokeFont } from './text/StrokeFont';
export type { TextStyle } from './text/StrokeFont';
export { Glyph } from './text/Glyph';
export { StrokeGlyph } from './text/StrokeGlyph';
