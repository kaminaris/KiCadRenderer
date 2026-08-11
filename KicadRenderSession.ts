// Framework-agnostic render session — the reusable core extracted out of
// demo/main.ts so both the standalone demo AND the Angular viewer drive the
// exact same camera/scene/render-loop logic instead of maintaining two
// copies that could drift. Deliberately does NOT touch `document` or attach
// any DOM event listeners itself (that was main.ts's original sin — it ran
// canvas/DOM lookups at MODULE SCOPE, which is unsafe to import directly
// into a component/service file). The caller owns the canvas elements, the
// event wiring (pointer/wheel/click), and any UI (layer checklist, status
// text) — this class owns camera state, scene building, and painting.

import { KicadParser }                 from '@kicad-io/KicadParser';
import { KicadElementWire }            from '@kicad-io/KicadElementWire';
import { KicadElementBus, KicadElementBusEntry } from '@kicad-io/KicadElementBus';
import { KicadElementJunction }        from '@kicad-io/KicadElementJunction';
import { KicadElementNoConnect }       from '@kicad-io/KicadElementNoConnect';
import { KicadElementRectangle }       from '@kicad-io/KicadElementStartEnd';
import { KicadElementCircle }          from '@kicad-io/KicadElementCircle';
import { KicadElementArc }             from '@kicad-io/KicadElementArc';
import { KicadElementPolyline, KicadElementBezier } from '@kicad-io/KicadElementPolyline';
import { KicadElementAt }         from '@kicad-io/KicadElementAt';
import { KicadElementSize }       from '@kicad-io/KicadElementSize';
import { KicadElementTable, KicadElementTableCell } from '@kicad-io/KicadElementTable';
import { KicadElementRuleArea } from '@kicad-io/KicadElementRuleArea';
import { KicadElementGroup } from '@kicad-io/KicadElementGroup';
import { KicadElementData } from '@kicad-io/KicadElementData';
import { KicadElementImage } from '@kicad-io/KicadElementImage';
import { KicadElementText, KicadElementTextBox, KicadElementLabel } from '@kicad-io/KicadElementText';
import { KicadElementGlobalLabel, type KicadGlobalLabelShape } from '@kicad-io/KicadElementGlobalLabel';
import { KicadElementHierarchicalLabel, type KicadHierarchicalLabelShape } from '@kicad-io/KicadElementHierarchicalLabel';
import { KicadElementNetclassFlag, type KicadDirectiveLabelShape } from '@kicad-io/KicadElementNetclassFlag';
import { KicadElementSymbol }          from '@kicad-io/KicadElementSymbol';
import { KicadElementSheet }           from '@kicad-io/KicadElementSheet';
import { KicadElementPin }             from '@kicad-io/KicadElementPin';
import { KicadElementLibSymbols }      from '@kicad-io/KicadElementLibSymbols';
import { KicadElementLibId }           from '@kicad-io/KicadElementString';
import { SchematicConnectivityService, type SchematicConnectivitySummary } from '@kicad-layout/Connectivity';
import { KicadElementUnit }            from '@kicad-io/KicadElementNumeric';
import { KicadElementDnp }             from '@kicad-io/KicadElementBoolean';
import { buildPowerFlag, buildPowerGnd, buildPowerRail } from '@kicad-io/Builder/PassiveSymbolBuilder';
import { buildPowerSymbolInstance }    from '@kicad-io/Builder/PowerSymbolInstance';

export type { KicadGlobalLabelShape } from '@kicad-io/KicadElementGlobalLabel';
export type { KicadDirectiveLabelShape } from '@kicad-io/KicadElementNetclassFlag';
import { Vec2 }                        from './math/Vec2';
import { Matrix3 }                     from './math/Matrix3';
import { Camera2 }                     from './math/Camera2';
import { Renderer }                    from './render/Renderer';
import { Canvas2dRenderer }            from './render/Canvas2dRenderer';
import { WebGLRenderer }               from './render/WebGLRenderer';
import {
	BoardPainter, defaultLayerState,
	LayeredBoardScene, LayerVisibilityState
}                                      from './paint/BoardPainter';
import {
	SchematicPainter, defaultSchLayerState,
	SchematicScene, SchLayerVisibilityState, SchematicSheetRef, SchematicDocInfo, SchPaintedItem
}                                      from './paint/SchematicPainter';
import { boardBackgroundColor }      from './paint/LayerColors';
import { schematicBackgroundColor }  from './paint/SchematicColors';
import { hitTest }                     from './paint/HitTest';
import { distanceToSegment }           from './paint/PaintedShape';
import { computeStrokeTextGeometry, drawStrokeTextGeometry } from './paint/TextPaint';
import { registerDefaultKicadClasses } from './RegisterDefaultClasses';

export type RenderBackend = 'webgl' | 'canvas2d';
export type RenderDocumentType = 'board' | 'schematic';

export interface LoadResult {
	parseMs: number;
	buildMs: number;
	layersPresent: string[];
}

export interface HitResult {
	id: string;
	kind: string;
	layer: string;
	/** kind:'symbol' only — the placed instance's Reference designator (e.g. "CBST1"). */
	refDesignator?: string;
	/** kind:'label' — net/label text. */
	labelName?: string;
	labelKind?: string;
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'w' | 'center' | 'e' | 'sw' | 's' | 'se';

/** Real KiCad's eeschema has align (ACTIONS::alignLeft/Right/Top/Bottom/
 *  CenterX/CenterY, sch_align_tool.cpp) but NOT distribute — that action
 *  only exists in the PCB editor — so alignSelection() only covers these six. */
export type AlignAxis = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y';

/** The editable, axis-aligned bounds of a selected root-level rectangle or
 * text box. These are deliberately separate from general hit bounds: the
 * latter also cover symbols and every other painted item, none of which has
 * the nine-handle resize contract. */
export interface SelectionResizeBox {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CurveAnchor = 'circle-center' | 'circle-radius' | 'arc-start' | 'arc-mid' | 'arc-end' | 'arc-center'
	| 'bezier-start' | 'bezier-control-1' | 'bezier-control-2' | 'bezier-end'
	| `polygon-vertex-${number}`;

export interface SelectionCurveAnchors {
	id: string;
	kind: 'circle' | 'arc' | 'bezier' | 'polygon';
	anchors: { kind: CurveAnchor; x: number; y: number }[];
}

/**
 * Live, uncommitted state for the hand-drawn-editor's active tool — what's
 * been clicked so far plus the current cursor position. Drawn every frame by
 * drawEditPreview() directly (mirroring drawGrid()'s idiom), never part of
 * the persisted scene — nothing here is real document data until the tool
 * commits it via one of the add*() methods.
 */
export type EditPreviewState =
	| { kind: 'wire'; from: Vec2; cursor: Vec2 }
	| { kind: 'junction'; cursor: Vec2 }
	| { kind: 'no-connect'; cursor: Vec2 }
	| { kind: 'line' | 'rect' | 'circle'; anchor: Vec2 | null; cursor: Vec2 }
	/** points: [] before the start click, [start] before the end click,
	 *  [start, end] while dragging the mid-bulge (cursor = the mid point). */
	| { kind: 'arc'; points: Vec2[]; cursor: Vec2 }
	| { kind: 'bezier'; points: Vec2[]; cursor: Vec2 }
	| { kind: 'rule-area'; points: Vec2[]; cursor: Vec2 }
	| { kind: 'text'; anchor: Vec2; text: string }
	| { kind: 'text-box'; x: number; y: number; width: number; height: number; text: string }
	| { kind: 'label'; anchor: Vec2; text: string; rotation: number }
	| {
		kind: 'global-label' | 'hier-label'; anchor: Vec2; text: string;
		shape: KicadGlobalLabelShape; rotation: number
	}
	| {
		kind: 'directive-label'; anchor: Vec2; text: string;
		shape: KicadDirectiveLabelShape; rotation: number
	}
	/** Power symbols place in one click (like junction/no-connect) — no
	 *  glyph preview needed, just a cursor-follow marker. */
	| { kind: 'power'; cursor: Vec2 }
	/** Select tool's rectangle multi-select drag. `mode` is the contained
	 *  ('origin'→cursor drawn left-to-right) vs touching (right-to-left)
	 *  distinction; `selectMode` is what committing the box will do to the
	 *  existing selection, both driving live color feedback — see
	 *  SELECTION_BOX_* constants. Deliberately unsnapped (origin/cursor are
	 *  raw world coordinates), unlike every other preview kind above. */
	| { kind: 'selection-box'; origin: Vec2; cursor: Vec2; mode: 'contained' | 'touching'; selectMode: 'replace' | 'add' | 'subtract' };

/** Placed schematic symbol pose for edit/drag without a circuit recipe. */
export interface SymbolPoseInfo {
	ref: string;
	libId: string;
	x: number;
	y: number;
	rotation: number;
}

/**
 * Owns camera/scene/painter state for ONE canvas pair (a 2D canvas + a
 * WebGL canvas, absolutely stacked, only one visible at a time — same
 * layout the demo uses) and exposes methods to load a document, mutate
 * view/layer state, and render. Everything here is plain data/methods, no
 * DOM listeners — wire pointer/wheel/click events to these methods from
 * whatever owns the actual `<canvas>` elements (a component, or the demo's
 * own script).
 */
export class KicadRenderSession {
	readonly camera: Camera2;

	protected readonly painter = new BoardPainter();
	protected readonly schematicPainter = new SchematicPainter();
	protected readonly canvas2d: HTMLCanvasElement;
	protected readonly canvasGl: HTMLCanvasElement | null;
	protected readonly canvas2dRenderer: Canvas2dRenderer;
	protected readonly webglRenderer: WebGLRenderer | null;

	protected backend: RenderBackend;
	protected documentType: RenderDocumentType = 'board';
	protected scene: LayeredBoardScene | null = null;
	protected layerState: Map<string, LayerVisibilityState> = new Map();
	protected schScene: SchematicScene | null = null;
	protected schLayerState: Map<string, SchLayerVisibilityState> = new Map();
	/** Retained across loadSchematicText so moveSymbolByRef can mutate + rebuild the scene without re-parsing text. */
	protected schematicRoot: { rootElement: any } | null = null;
	protected schematicDocInfo: SchematicDocInfo | undefined = undefined;
	/** Multi-select-capable — see select()/selectMultiple()/selection/selectionIds. */
	protected selectedIds: Set<string> = new Set();
	/** Hover-driven net highlight IDs — painted in the same highlight color as selection. */
	protected highlightedNetIds: Set<string> = new Set();
	protected highlightedNetName: string | null = null;
	protected connectivityService = new SchematicConnectivityService();
	protected connectivityCacheText: string | null = null;
	protected connectivityCache: SchematicConnectivitySummary | null = null;
	/** Overrides drawGrid()'s default spacing — see setGridSpacing(). null
	 *  means "use the built-in default" (1.27mm schematic / 0.5mm board). */
	protected gridSpacingMm: number | null = null;
	/** Hand-drawn editor's in-progress tool state — see drawEditPreview(). */
	protected editPreview: EditPreviewState | null = null;
	/**
	 * Snapshot-based undo/redo: full schematic text before each mutation, not
	 * hand-written inverse commands. Chosen because rewireSchematic (circuit
	 * mode's auto-rewire) is a full regenerate with no clean inverse other than
	 * "the text before it ran" — since undo must cover that too, a command
	 * stack would need snapshotting for that case anyway, making two
	 * mechanisms strictly worse than one. One GLOBAL stack (not per-mode) —
	 * a document has one history regardless of which mode produced each
	 * change, matching how every real editor (including KiCad) behaves.
	 */
	protected undoStack: string[] = [];
	protected redoStack: string[] = [];
	protected undoLabels: string[] = [];
	protected redoLabels: string[] = [];
	protected static readonly maxUndoDepth = 100;
	protected frameScheduled = false;
	// See render()'s WebGL branch — only geometry-affecting changes (new
	// document, layer visibility/opacity, selection) need this; pure
	// pan/zoom/flip never do.
	protected geometryDirty = true;
	protected flipped = false;
	/**
	 * Items from a fitToItems() call that ran before the canvas had a real
	 * layout size (common: 0×N → 1×N). Fitting into that viewport yields a
	 * near-zero zoom that looks blank after a later resize. resize()
	 * retries with these items once the buffer is large enough.
	 */
	protected pendingFitItems: { bbox: { x: number; y: number; w: number; h: number } }[] | null = null;
	/** Below this buffer size (device px), defer camera fit. */
	protected static readonly minFitViewportPx = 32;
	/** Real KiCad's own click-tolerance radius, in SCREEN pixels — a constant
	 * regardless of zoom (eeschema/tools/sch_selection_tool.cpp's
	 * `HITTEST_THRESHOLD_PIXELS`, confirmed in the user's local checkout).
	 * hitTestToleranceWorld() converts this to world units at the current
	 * zoom before every hit-test call — see PaintedShape.ts's edgeTolerance
	 * doc comment for why a fixed world-space tolerance is wrong (too tight
	 * zoomed out, needlessly loose zoomed in). */
	protected static readonly hitTestPixelTolerance = 5;

	/** Called after render() actually paints a frame (or clears an empty
	 * one) — the caller can use this to update status/info text without
	 * this class needing to know anything about a DOM status element. */
	onRender: ((activeScene: LayeredBoardScene | SchematicScene | null) => void) | null = null;
	/** Called if a frame throws — a bad/corrupt scene shouldn't silently
	 * stop future rAF-scheduled frames from ever running again. */
	onError: ((err: unknown) => void) | null = null;

	/**
	 * @param canvas2d Required either way — also the automatic fallback
	 * target if `canvasGl` is null/omitted or WebGL context creation fails.
	 * @param canvasGl Pass a real, currently-unused canvas here for any
	 * production use — see Canvas2dRenderer's `@deprecated` note for why
	 * `null` should be reserved for cases that specifically need to force
	 * Canvas2D (a unit test, a tiny one-off preview render).
	 */
	constructor(canvas2d: HTMLCanvasElement, canvasGl: HTMLCanvasElement | null) {
		registerDefaultKicadClasses();

		this.canvas2d = canvas2d;
		this.canvasGl = canvasGl;
		this.camera = new Camera2(new Vec2(canvas2d.width, canvas2d.height), new Vec2(0, 0), 4);

		const ctx = canvas2d.getContext('2d');
		if (!ctx) {
			throw new Error('2D canvas context unavailable');
		}
		this.canvas2dRenderer = new Canvas2dRenderer(ctx);
		const redrawAfterImageLoad = () => {
			// WebGL keeps a static scene buffer, so a newly decoded texture needs
			// a rebuild; Canvas2D harmlessly redraws the same scene on demand.
			this.geometryDirty = true;
			this.scheduleRender();
		};
		this.canvas2dRenderer.setImageLoadHandler(redrawAfterImageLoad);

		let webglRenderer: WebGLRenderer | null = null;
		if (canvasGl) {
			try {
				webglRenderer = new WebGLRenderer(canvasGl);
			}
			catch (err) {
				// WebGL context creation can genuinely fail (disabled GPU,
				// headless CI, etc.) — fall back to Canvas2D rather than
				// throwing out of the constructor.
				console.error('WebGL unavailable, falling back to Canvas2D', err);
			}
		}
		this.webglRenderer = webglRenderer;
		this.webglRenderer?.setImageLoadHandler(redrawAfterImageLoad);
		this.backend = webglRenderer ? 'webgl' : 'canvas2d';
	}

	// ---- Read-only state ----

	get documentTypeLoaded(): RenderDocumentType {
		return this.documentType;
	}

	get activeScene(): LayeredBoardScene | SchematicScene | null {
		return this.documentType === 'schematic' ? this.schScene : this.scene;
	}

	get activeLayerState(): Map<string, LayerVisibilityState> | Map<string, SchLayerVisibilityState> {
		return this.documentType === 'schematic' ? this.schLayerState : this.layerState;
	}

	get currentBackend(): RenderBackend {
		return this.backend;
	}

	get hasWebGL(): boolean {
		return !!this.webglRenderer;
	}

	get isFlipped(): boolean {
		return this.flipped;
	}

	/** Single-item view: the one selected id, or null when 0 or 2+ are
	 *  selected. Single-item UI affordances (resize handles, curve anchors,
	 *  Rotate/Tidy/the property sidebar's per-kind panel) all key off this —
	 *  degrading to null for a real multi-selection is deliberate, not a
	 *  gap: none of those have well-defined multi-item behavior yet (see
	 *  [[kicad-viewer-edit-mode]]'s multi-select scope notes). Callers that
	 *  need to know "how many, which ones" want selectionIds instead. */
	get selection(): string | null {
		return this.selectedIds.size === 1 ? [...this.selectedIds][0]! : null;
	}

	get selectionIds(): ReadonlySet<string> {
		return this.selectedIds;
	}

	/**
	 * When true, board builds include pad-number overlays (PadNumbers layer).
	 * Must be set before loadBoardText(); changing it does not rebuild an
	 * already-loaded scene. Default false (board viewer stays clean).
	 */
	get showPadNumbers(): boolean {
		return !!this.painter.options.showPadNumbers;
	}

	set showPadNumbers(value: boolean) {
		this.painter.options.showPadNumbers = value;
	}

	/** Hierarchical sheet references in the currently-loaded schematic —
	 * empty when a board is loaded, or when the schematic has none. Lets a
	 * caller (the demo, the Angular viewer) implement "click a sheet to
	 * descend into it" navigation without walking the parsed element tree
	 * itself. */
	get currentSheets(): SchematicSheetRef[] {
		return this.documentType === 'schematic' ? (this.schScene?.sheets ?? []) : [];
	}

	// ---- Viewport ----

	resize(widthPx: number, heightPx: number): void {
		const w = Math.max(0, Math.floor(widthPx));
		const h = Math.max(0, Math.floor(heightPx));
		// Tab hide (display:none) or pre-layout often reports ~0. Stamping that
		// into the buffer yields a 1×N viewport; later CSS stretch looks blank.
		// Keep the previous buffer and wait for a real size.
		if (
			w < KicadRenderSession.minFitViewportPx
			|| h < KicadRenderSession.minFitViewportPx
		) {
			return;
		}
		this.canvas2d.width = w;
		this.canvas2d.height = h;
		if (this.canvasGl) {
			this.canvasGl.width = w;
			this.canvasGl.height = h;
		}
		this.camera.viewportSize.set(w, h);
		// Retry a fit that was deferred while the canvas was still ~0-wide.
		if (this.pendingFitItems) {
			this.fitToItems(this.pendingFitItems);
		}
		this.scheduleRender();
	}

	/** Pans by a SCREEN-space delta (device pixels), already flip-aware —
	 * mirrors demo/main.ts's mousemove handler exactly. */
	pan(deltaScreenX: number, deltaScreenY: number): void {
		const dx = this.flipped ? deltaScreenX : -deltaScreenX;
		this.camera.translate(new Vec2(dx / this.camera.zoom, -deltaScreenY / this.camera.zoom));
		this.scheduleRender();
	}

	zoomBy(factor: number): void {
		const next = this.camera.zoom * factor;
		// Never let wheel-zoom drive zoom to 0 / NaN (blank canvas after clear).
		if (!Number.isFinite(next) || next <= 1e-6) {
			return;
		}
		this.camera.zoom = Math.min(next, 1e6);
		this.scheduleRender();
	}

	setFlipped(flipped: boolean): void {
		this.flipped = flipped;
		this.scheduleRender();
	}

	/** Screen (device-pixel) coordinates -> world coordinates, undoing the
	 * flip mirror the same way computeViewMatrix() applies it. */
	screenToWorld(screenPos: Vec2): Vec2 {
		const worldPos = this.camera.screenToWorld(screenPos);
		if (this.flipped) {
			worldPos.x = 2 * this.camera.center.x - worldPos.x;
		}
		return worldPos;
	}

	/**
	 * Set (or clear, with null) the hand-drawn editor's live in-progress-tool
	 * state. Preview-only — nothing here touches the document/AST, so this
	 * schedules a repaint but never marks geometryDirty (no scene rebuild).
	 */
	setEditPreview(state: EditPreviewState | null): void {
		this.editPreview = state;
		this.scheduleRender();
	}

	/** Converts hitTestPixelTolerance to world units at the current zoom.
	 * zoom<=0/NaN falls back to 0 (exact-match) rather than propagating NaN
	 * into every subsequent comparison. */
	protected hitTestToleranceWorld(): number {
		const zoom = this.camera.zoom;
		return Number.isFinite(zoom) && zoom > 0 ? KicadRenderSession.hitTestPixelTolerance / zoom : 0;
	}

	/** Geometric hit-test (against source data, not pixels) at a screen
	 * position — returns the same shape the demo's click handler reports. */
	hitTestAtScreen(screenPos: Vec2): HitResult | null {
		const worldPos = this.screenToWorld(screenPos);
		const tolerance = this.hitTestToleranceWorld();
		// Branched (rather than reading a shared union-typed variable) so
		// each hitTest() call sees a concretely-typed array — a union of
		// two array types doesn't let TS infer hitTest<T>'s T cleanly.
		const hit = this.documentType === 'schematic'
			? (this.schScene ? hitTest(this.schScene.hitTestItems, worldPos.x, worldPos.y, tolerance) : null)
			: (this.scene ? hitTest(this.scene.hitTestItems, worldPos.x, worldPos.y, tolerance) : null);
		if (!hit) {
			return null;
		}
		// refDesignator only exists on SchPaintedItem (kind:'symbol'), not on
		// the board's PaintedItem — 'kind' in hit narrows which one we have.
		const refDesignator = 'refDesignator' in hit ? hit.refDesignator : undefined;
		const labelName = 'labelName' in hit ? hit.labelName : undefined;
		const labelKind = 'labelKind' in hit ? hit.labelKind : undefined;
		return { id: hit.id, kind: hit.kind, layer: hit.layer, refDesignator, labelName, labelKind };
	}

	/**
	 * Hit-test only kind:'symbol' paint items. Symbol bboxes live on the
	 * Graphics layer (below Wires/Pins in SCHEMATIC_LAYER_ORDER) so the
	 * general hitTestAtScreen() prefers overlapping wire stubs / pin
	 * segments — fine for net-trace UX, useless for click-to-select in a
	 * manual placement editor. This ignores those overlays and returns the
	 * topmost symbol under the cursor.
	 */
	hitTestSymbolAtScreen(screenPos: Vec2): HitResult | null {
		if (this.documentType !== 'schematic' || !this.schScene) {
			return null;
		}
		const worldPos = this.screenToWorld(screenPos);
		const symbols = this.schScene.hitTestItems.filter(item => item.kind === 'symbol');
		const hit = hitTest(symbols, worldPos.x, worldPos.y, this.hitTestToleranceWorld());
		if (!hit) {
			return null;
		}
		return {
			id: hit.id,
			kind: hit.kind,
			layer: hit.layer,
			refDesignator: hit.refDesignator
		};
	}

	/** Hit-test schematic labels (global / local) for drag editing. */
	hitTestLabelAtScreen(screenPos: Vec2): HitResult | null {
		if (this.documentType !== 'schematic' || !this.schScene) {
			return null;
		}
		const worldPos = this.screenToWorld(screenPos);
		const labels = this.schScene.hitTestItems.filter(item => item.kind === 'label');
		const hit = hitTest(labels, worldPos.x, worldPos.y, this.hitTestToleranceWorld());
		if (!hit) {
			return null;
		}
		return {
			id: hit.id,
			kind: hit.kind,
			layer: hit.layer,
			labelName: hit.labelName,
			labelKind: hit.labelKind,
		};
	}

	/**
	 * Rectangle multi-select hit-test: bbox-based containment ('contained')
	 * or intersection ('touching') against every hitTestable schematic item
	 * — same population point-click selection already considers selectable
	 * (schScene.hitTestItems is pre-filtered to hitTestable:true at build
	 * time). `worldOrigin`/`worldCursor` are the drag's two corners in
	 * either order; normalized here. Deliberately NOT shape-precise (no
	 * polygon/pin/field-expansion matching real KiCad's per-item HitTest) —
	 * a bbox approximation is intentional and sufficient at this app's
	 * scale, matching every other hit-test method in this file.
	 */
	hitTestRect(worldOrigin: Vec2, worldCursor: Vec2, mode: 'contained' | 'touching'): string[] {
		if (this.documentType !== 'schematic' || !this.schScene || !this.schematicRoot) {
			return [];
		}
		const minX = Math.min(worldOrigin.x, worldCursor.x);
		const maxX = Math.max(worldOrigin.x, worldCursor.x);
		const minY = Math.min(worldOrigin.y, worldCursor.y);
		const maxY = Math.max(worldOrigin.y, worldCursor.y);
		// Only items whose element is a direct, top-level child of the
		// schematic — a symbol's own pins and body graphics (kind 'pin' /
		// 'symbol-graphic') are ALSO hitTestable:true (so wire-endpoint
		// snapping and dangling-indicator checks can see them), but they
		// live nested inside the shared lib_symbols definition, in LIBRARY-
		// LOCAL coordinates, not the placed instance's own world position.
		// Selecting one directly here would be harmless on its own, but a
		// downstream move (translateSelection) would happily call setOrigin
		// on it as if the id/coords were world-space — silently corrupting
		// the shared symbol definition for every instance that uses it, not
		// just the one clicked. Point-click selection is naturally immune
		// (the symbol's own encompassing hitbox is built to win over its
		// nested sub-items), so this only needed fixing here.
		const rootChildren = new Set(this.schematicRoot.rootElement?.children ?? []);
		const result: string[] = [];
		for (const item of this.schScene.hitTestItems) {
			if (!rootChildren.has(item.element)) {
				continue;
			}
			const { x, y, w, h } = item.bbox;
			const matches = mode === 'contained'
				? (x >= minX && y >= minY && x + w <= maxX && y + h <= maxY)
				: (x <= maxX && x + w >= minX && y <= maxY && y + h >= minY);
			if (matches) {
				result.push(item.id);
			}
		}
		return result;
	}

	/** Which hierarchical sheet (if any) contains a screen position — plain
	 * point-in-bbox test against currentSheets, since sheet boxes are
	 * always axis-aligned rectangles and don't need the general hitTest()
	 * machinery. Returns the smallest-area match when boxes overlap
	 * (nested/adjacent sheets), matching how a human would expect a click
	 * on the visually "inner" box to resolve. */
	sheetAtScreen(screenPos: Vec2): SchematicSheetRef | null {
		const sheets = this.currentSheets;
		if (sheets.length === 0) {
			return null;
		}
		const worldPos = this.screenToWorld(screenPos);
		let best: SchematicSheetRef | null = null;
		let bestArea = Infinity;
		for (const sheet of sheets) {
			const { x, y, w, h } = sheet.bbox;
			if (worldPos.x >= x && worldPos.x <= x + w && worldPos.y >= y && worldPos.y <= y + h) {
				const area = w * h;
				if (area < bestArea) {
					best = sheet;
					bestArea = area;
				}
			}
		}
		return best;
	}

	/** Single-item select/replace — a thin convenience wrapper over
	 *  selectMultiple, kept because this exact signature is called directly
	 *  by consumers outside apps/kicad-viewer (the Angular CircuitDesign/
	 *  Viewer pages under web/src/app/Features) that only ever need
	 *  single-item selection and should not need to change. */
	select(id: string | null): void {
		this.selectMultiple(id ? [id] : [], 'replace');
	}

	/** Rectangle multi-select's mutator — also what select() delegates to.
	 *  'replace' clears and sets the given ids; 'add'/'subtract' merge them
	 *  into the current selection (a plain click with no modifier is
	 *  'replace' with 0-or-1 ids, same as select() always was). */
	selectMultiple(ids: string[], mode: 'replace' | 'add' | 'subtract'): void {
		if (mode === 'replace') {
			this.selectedIds = new Set(ids);
		}
		else if (mode === 'add') {
			for (const id of ids) this.selectedIds.add(id);
		}
		else {
			for (const id of ids) this.selectedIds.delete(id);
		}
		// Highlight color is baked per-vertex at build time on WebGL — see
		// setLayerVisible()'s comment.
		this.geometryDirty = true;
		this.scheduleRender();
	}

	clearNetHighlight(): void {
		if (!this.highlightedNetIds.size && this.highlightedNetName === null) {
			return;
		}
		this.highlightedNetName = null;
		this.highlightedNetIds.clear();
		this.scheduleRender();
	}

	highlightNetAtScreen(screenPos: Vec2): boolean {
		if (this.documentType !== 'schematic' || !this.schScene) {
			this.clearNetHighlight();
			return false;
		}
		const hit = this.hitTestAtScreen(screenPos);
		const item = hit ? this.schScene.hitTestItems.find(candidate => candidate.id === hit.id) : null;
		const netName = this.netNameForPaintItem(item);
		if (!netName) {
			this.clearNetHighlight();
			return false;
		}
		const ids = this.paintIdsForNet(netName);
		if (!ids.size) {
			this.clearNetHighlight();
			return false;
		}
		if (this.highlightedNetName === netName) {
			return true;
		}
		this.highlightedNetName = netName;
		this.highlightedNetIds = ids;
		this.scheduleRender();
		return true;
	}

	private getConnectivitySummary(): SchematicConnectivitySummary | null {
		const text = this.getSchematicText();
		if (!text) {
			this.connectivityCache = null;
			this.connectivityCacheText = null;
			return null;
		}
		if (this.connectivityCacheText === text && this.connectivityCache) {
			return this.connectivityCache;
		}
		try {
			const summary = this.connectivityService.buildFromSchematicText(text);
			this.connectivityCache = summary;
			this.connectivityCacheText = text;
			return summary;
		}
		catch {
			this.connectivityCache = null;
			this.connectivityCacheText = null;
			return null;
		}
	}

	private netNameForPaintItem(item: SchPaintedItem | null | undefined): string | null {
		if (!item) {
			return null;
		}
		if (item.kind === 'label' && item.labelKind !== 'symbol-field' && item.labelName) {
			return item.labelName;
		}
		if (item.kind === 'pin' && item.element instanceof KicadElementPin) {
			const ref = item.refDesignator;
			if (!ref) {
				return null;
			}
			const { number } = typeof item.element.getPin === 'function' ? item.element.getPin() : { number: '' };
			if (!number) {
				return null;
			}
			const summary = this.getConnectivitySummary();
			const component = summary?.components.find(c => c.ref === ref);
			const matchingPin = component?.pins.find(p => p.number === number);
			return matchingPin?.net ?? null;
		}
		if (item.kind === 'symbol' && item.refDesignator) {
			const summary = this.getConnectivitySummary();
			const component = summary?.components.find(c => c.ref === item.refDesignator);
			if (component) {
				const nets = [...new Set(component.pins.map(p => p.net).filter(Boolean) as string[])];
				// Power symbols (GND, VCC, …) have exactly one net — auto-resolve.
				if (nets.length === 1) {
					return nets[0]!;
				}
			}
		}
		return null;
	}

	private paintIdsForNet(netName: string): Set<string> {
		const ids = new Set<string>();
		if (!this.schScene) {
			return ids;
		}

		const seedPoints: { x: number; y: number }[] = [];
		const WIRE_SNAP = 0.12;
		const summary = this.getConnectivitySummary();

		// Helper: add all painted items belonging to a symbol instance with the given ref.
		// Used for power symbols (GND/VCC/…) so their body graphic also turns highlighted.
		const addSymbolBodyItems = (ref: string) => {
			const symbolHit = this.schScene!.hitTestItems.find(it => it.kind === 'symbol' && it.refDesignator === ref);
			if (!symbolHit) {
				return;
			}
			const instanceId = symbolHit.id.startsWith('symbol:') ? symbolHit.id.slice('symbol:'.length) : null;
			if (!instanceId) {
				return;
			}
			for (const bucket of this.schScene!.layerBuckets.values()) {
				for (const item of bucket) {
					if (item.id === `symbol:${ instanceId }` || item.id.startsWith(`${ instanceId }:`)) {
						ids.add(item.id);
					}
				}
			}
		};

		// Helper: when a label is found, add all its companion items (:text, :flag, etc.).
		// Global/hierarchical labels create multiple SchPaintedItems with the same base UUID.
		// Note: :text items have hitTestable: false, so they're not in hitTestItems — search layerBuckets.
		const addLabelAndCompanions = (labelItem: SchPaintedItem) => {
			ids.add(labelItem.id);
			const baseId = labelItem.id.replace(/:text$|:flag$/, '');
			if (baseId !== labelItem.id) {
				// This label has a suffix, so find and add companion items from all layers.
				for (const bucket of this.schScene!.layerBuckets.values()) {
					for (const item of bucket) {
						if ((item.id === `${ baseId }:text` || item.id === `${ baseId }:flag`) && !ids.has(item.id)) {
							ids.add(item.id);
						}
					}
				}
			}
		};

		// 1. Labels matching the net name.
		for (const item of this.schScene.hitTestItems) {
			if (item.kind === 'label' && item.labelKind !== 'symbol-field' && item.labelName === netName) {
				addLabelAndCompanions(item);
				const shape = item.shape as any;
				if (shape?.type === 'rect') {
					seedPoints.push({ x: shape.x, y: shape.y + shape.h / 2 });
					seedPoints.push({ x: shape.x + shape.w, y: shape.y + shape.h / 2 });
					seedPoints.push({ x: shape.x + shape.w / 2, y: shape.y });
					seedPoints.push({ x: shape.x + shape.w / 2, y: shape.y + shape.h });
				}
			}
		}

		// 2. Labels from the connectivity net's label list.
		const net = summary?.nets.find(n => n.name === netName);
		if (net?.labels) {
			for (const labelName of net.labels) {
				for (const item of this.schScene.hitTestItems) {
					if (item.kind === 'label' && item.labelKind !== 'symbol-field' && item.labelName === labelName) {
						addLabelAndCompanions(item);
						const shape = item.shape as any;
						if (shape?.type === 'rect') {
							seedPoints.push({ x: shape.x, y: shape.y + shape.h / 2 });
							seedPoints.push({ x: shape.x + shape.w, y: shape.y + shape.h / 2 });
						}
					}
				}
			}
		}

		// 3. Pins from the Pins layer (includes hidden pins such as GND/VCC power symbols).
		for (const pinItem of (this.schScene.layerBuckets.get('Pins') ?? [])) {
			if (pinItem.kind !== 'pin' || !(pinItem.element instanceof KicadElementPin)) {
				continue;
			}
			const pinNet = this.netNameForPaintItem(pinItem);
			if (pinNet !== netName) {
				continue;
			}
			if (pinItem.hitTestable) {
				ids.add(pinItem.id);
			}
			// x1/y1 is worldOuter — the wire connection endpoint.
			const shape = pinItem.shape as any;
			if (shape?.type === 'segment') {
				seedPoints.push({ x: shape.x1, y: shape.y1 });
			}
			// Power symbols (GND, VCC, …) — highlight the whole symbol body.
			if (pinItem.refDesignator) {
				const component = summary?.components.find(c => c.ref === pinItem.refDesignator);
				if (component?.isPower) {
					addSymbolBodyItems(pinItem.refDesignator);
				}
			}
		}

		// 4. Wire flood-fill BFS from seed points.
		const allWires = this.schScene.layerBuckets.get('Wires') ?? [];
		const visited = new Set<string>();
		const queue = [...seedPoints];

		while (queue.length > 0) {
			const current = queue.shift()!;
			for (const wire of allWires) {
				if (visited.has(wire.id)) {
					continue;
				}
				const wshape = wire.shape as any;
				if (wshape?.type !== 'segment') {
					continue;
				}
				const nearStart = Math.hypot(current.x - wshape.x1, current.y - wshape.y1) <= WIRE_SNAP;
				const nearEnd   = Math.hypot(current.x - wshape.x2, current.y - wshape.y2) <= WIRE_SNAP;
				if (nearStart || nearEnd) {
					visited.add(wire.id);
					ids.add(wire.id);
					queue.push(nearStart ? { x: wshape.x2, y: wshape.y2 } : { x: wshape.x1, y: wshape.y1 });
				}
			}
		}

		return ids;
	}

	/** Every KicadElementGroup currently in the document — cheap early-return
	 *  when none exist (every schematic that doesn't use groups, i.e. every
	 *  one today), so expandGroupSelection/selectionHasGroup cost nothing
	 *  for documents that never touch this feature. */
	private allGroups(): KicadElementGroup[] {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement) {
			return [];
		}
		return (this.schematicRoot.rootElement.children as any[]).filter(
			(c): c is KicadElementGroup => c instanceof KicadElementGroup
		);
	}

	/**
	 * Given a set of just-resolved paint ids (a click, a rect-select
	 * commit), expands any id that's a member of an existing
	 * KicadElementGroup into that WHOLE group's member set — so grouped
	 * items behave as one unit at the selection layer. Resolves group
	 * membership by the underlying ELEMENT's own uuid
	 * (item.element.getUuid()), never the paint id — paint ids diverge
	 * from the element uuid for some kinds (a symbol's is
	 * `symbol:${uuid}`, a global/hier label's is `${uuid}:flag`), while a
	 * group's (members ...) list always stores real element uuids. Not
	 * centralized inside selectMultiple() — callers with an explicit
	 * single-target contract (the double-click properties modal's
	 * s.select(id)) must NOT be silently upgraded to a whole group.
	 */
	expandGroupSelection(ids: string[]): string[] {
		const groups = this.allGroups();
		if (groups.length === 0 || !this.schScene) {
			return ids;
		}
		const hitItems = this.schScene.hitTestItems;
		const uuidToPaintId = new Map<string, string>();
		for (const item of hitItems) {
			const uuid = (item.element as any)?.getUuid?.();
			if (uuid) {
				uuidToPaintId.set(uuid, item.id);
			}
		}
		const result = new Set(ids);
		for (const id of ids) {
			const uuid = (hitItems.find(it => it.id === id)?.element as any)?.getUuid?.();
			if (!uuid) {
				continue;
			}
			for (const group of groups) {
				if (!group.getMemberUuids().includes(uuid)) {
					continue;
				}
				for (const memberUuid of group.getMemberUuids()) {
					const paintId = uuidToPaintId.get(memberUuid);
					if (paintId) {
						result.add(paintId);
					}
				}
			}
		}
		return [...result];
	}

	/** Read-only check for the Ungroup menu item's enabled state — true if
	 *  any of the given ids' underlying elements is a member of an
	 *  existing group. */
	selectionHasGroup(ids: string[]): boolean {
		const groups = this.allGroups();
		if (groups.length === 0 || !this.schScene) {
			return false;
		}
		const hitItems = this.schScene.hitTestItems;
		const uuids = new Set(
			ids.map(id => (hitItems.find(it => it.id === id)?.element as any)?.getUuid?.()).filter(Boolean)
		);
		return groups.some(group => group.getMemberUuids().some(u => uuids.has(u)));
	}

	/** Fits the camera to a set of items' combined bbox — same auto-fit-on-load
	 * behavior as demo/main.ts's fitCameraToItems(), exposed for callers that
	 * want to re-fit on demand (e.g. a "fit to view" button). */
	fitToItems(items: { bbox: { x: number; y: number; w: number; h: number } }[], padding = 0.85): void {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		let used = 0;
		for (const item of items) {
			const { x, y, w, h } = item.bbox;
			// Skip corrupt/empty bboxes — one NaN/Inf item would otherwise
			// collapse zoom to 0 and blank the next paint (clear runs, then
			// drawGrid throws on a singular camera matrix).
			if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) {
				continue;
			}
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x + w);
			maxY = Math.max(maxY, y + h);
			used++;
		}
		if (used === 0) {
			return;
		}
		const w = Math.max(maxX - minX, 1e-3);
		const h = Math.max(maxY - minY, 1e-3);
		this.camera.center.set((minX + maxX) / 2, (minY + maxY) / 2);
		// Canvas may still be 0×N (or 1×N after Math.max clamp) before CSS
		// layout. Fitting into that viewport makes zoom ≈ 0; a later resize
		// then keeps that zoom and the preview looks blank. Defer instead.
		const viewW = this.canvas2d.width;
		const viewH = this.canvas2d.height;
		if (
			viewW < KicadRenderSession.minFitViewportPx
			|| viewH < KicadRenderSession.minFitViewportPx
		) {
			this.pendingFitItems = items;
			if (!Number.isFinite(this.camera.zoom) || this.camera.zoom <= 0) {
				this.camera.zoom = 4;
			}
			return;
		}
		this.pendingFitItems = null;
		// Never allow zoom 0 — singularizes camera.matrix and makes drawGrid
		// throw after clear().
		const zoom = Math.min(viewW / w, viewH / h) * padding;
		this.camera.zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 4;
	}

	/**
	 * Fit to painted schematic content. Uses ALL layer items (body graphics,
	 * pin labels, properties, …), not just hitTestable pins — pin segments
	 * alone under-estimate body height (vertical margin) and crop Ref/Value.
	 * Excludes the drawing-sheet Frame so an optional page border never
	 * forces an A4 zoom when the caller only wants the symbol.
	 */
	fitSchematicContent(excludeLayers: readonly string[] = ['Frame']): void {
		if (!this.schScene) {
			return;
		}
		const skip = new Set(excludeLayers);
		const items: { bbox: { x: number; y: number; w: number; h: number } }[] = [];
		for (const [layer, bucket] of this.schScene.layerBuckets) {
			if (skip.has(layer)) {
				continue;
			}
			for (const item of bucket) {
				items.push(item);
			}
		}
		// Fall back to hit-testables if somehow nothing was painted.
		this.fitToItems(items.length > 0 ? items : this.schScene.hitTestItems);
	}

	/** Overrides drawGrid()'s visible dot spacing — null restores the
	 *  built-in default. Callers that also snap placement to a grid (e.g.
	 *  apps/kicad-viewer's own snap()) should pass the SAME value here, so
	 *  what's drawn matches what things actually snap to; this session has
	 *  no snap logic of its own to keep in sync automatically. */
	setGridSpacing(mm: number | null): void {
		this.gridSpacingMm = mm !== null && Number.isFinite(mm) && mm > 0 ? mm : null;
		this.scheduleRender();
	}

	// ---- Layers / backend ----

	setLayerVisible(layer: string, visible: boolean): void {
		const state = this.activeLayerState.get(layer);
		if (state) {
			state.visible = visible;
			// Visibility is baked into WHICH vertices got uploaded at all (an
			// invisible layer's items never get added to the static
			// buffer), so this needs a real rebuild, not just a redraw.
			this.geometryDirty = true;
			this.scheduleRender();
		}
	}

	setLayerOpacity(layer: string, opacity: number): void {
		const state = this.activeLayerState.get(layer);
		if (state) {
			state.opacity = opacity;
			// Opacity is baked into each vertex's own alpha at build time
			// (see WebGLRenderer's pushVertex), not a per-frame blend
			// state, so this also needs a rebuild.
			this.geometryDirty = true;
			this.scheduleRender();
		}
	}

	setBackend(backend: RenderBackend): void {
		if (backend === 'webgl' && !this.webglRenderer) {
			return;
		}
		this.backend = backend;
		// Switching TO WebGL needs its static buffers built at least once
		// (they're per-instance, not shared with Canvas2D) — always mark
		// dirty rather than tracking per-backend build state for what's an
		// infrequent action anyway.
		this.geometryDirty = true;
		this.scheduleRender();
	}

	// ---- Loading ----

	async loadBoardText(text: string): Promise<LoadResult> {
		this.documentType = 'board';
		const t0 = performance.now();
		const parser = new KicadParser();
		const rootElement = parser.parse(text);
		const parseMs = performance.now() - t0;
		const boardRoot = { rootElement };

		const t1 = performance.now();
		this.scene = this.painter.build(boardRoot);
		const buildMs = performance.now() - t1;
		this.layerState = defaultLayerState(this.scene.layersPresent);
		this.geometryDirty = true;
		this.selectedIds = new Set();

		this.fitToItems(this.scene.hitTestItems);
		this.scheduleRender();

		return { parseMs, buildMs, layersPresent: this.scene.layersPresent };
	}

	/**
	 * Serialize the currently loaded schematic AST (including any pose
	 * mutations from {@link moveSymbolByRef}). Empty string if none loaded.
	 */
	getSchematicText(): string {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement) {
			return '';
		}
		const root = this.schematicRoot.rootElement;
		if (typeof root.write === 'function') {
			return String(root.write());
		}
		return '';
	}

	/**
	 * Scope for this first pass (see SchematicPainter's own doc comment for
	 * the full list): a single .kicad_sch file's own content only — sheet
	 * elements render as boxes with their name/file text, but the child
	 * schematic file they reference isn't fetched/rendered.
	 */
	async loadSchematicText(text: string, docInfo?: SchematicDocInfo): Promise<LoadResult> {
		this.documentType = 'schematic';
		const t0 = performance.now();
		const parser = new KicadParser();
		const rootElement = parser.parse(text);
		const parseMs = performance.now() - t0;
		const schematicRoot = { rootElement };
		this.schematicRoot = schematicRoot;
		this.schematicDocInfo = docInfo;
		this.connectivityCache = null;
		this.connectivityCacheText = null;
		this.highlightedNetName = null;
		this.highlightedNetIds.clear();

		const t1 = performance.now();
		this.schScene = this.schematicPainter.build(schematicRoot, docInfo);
		const buildMs = performance.now() - t1;
		this.schLayerState = defaultSchLayerState(this.schScene.layersPresent);
		this.geometryDirty = true;
		this.selectedIds = new Set();

		if (!docInfo?.preserveView) {
			this.fitSchematicContent();
		}
		this.scheduleRender();

		return { parseMs, buildMs, layersPresent: this.schScene.layersPresent };
	}

	/**
	 * Common tail for every method that mutates the live schematic AST directly
	 * (as opposed to reloading text): rebuild the scene from the current tree,
	 * reset layer visibility state, and schedule a repaint. No re-parsing.
	 */
	/** >0 while a batch of mutations is in progress — see beginBatch(). */
	private batchDepth = 0;

	private commitAstMutation(): void {
		if (this.batchDepth > 0) {
			return;
		}
		this.rebuildSchScene();
	}

	private rebuildSchScene(): void {
		if (!this.schematicRoot) {
			return;
		}
		this.schScene = this.schematicPainter.build(this.schematicRoot, this.schematicDocInfo);
		this.schLayerState = defaultSchLayerState(this.schScene.layersPresent);
		this.geometryDirty = true;
		this.scheduleRender();
	}

	/** Defers commitAstMutation()'s scene rebuild (a full re-paint of every
	 *  item, confirmed non-trivial for anything but a tiny schematic) until
	 *  the matching endBatch() — wrap several mutation calls (e.g.
	 *  translateSelection's one-call-per-selected-item loop) to pay for
	 *  exactly one rebuild instead of one per call. Nests safely: only the
	 *  outermost endBatch triggers the rebuild. Every existing single-item
	 *  mutation method is completely unaffected when called outside a batch
	 *  (batchDepth stays 0, commitAstMutation behaves exactly as before). */
	private beginBatch(): void {
		this.batchDepth++;
	}

	private endBatch(): void {
		this.batchDepth = Math.max(0, this.batchDepth - 1);
		if (this.batchDepth === 0) {
			this.rebuildSchScene();
		}
	}

	/** Push the current schematic text onto the undo stack. Called internally
	 *  as the first line of every one-shot mutation (addWire, deleteElements,
	 *  …) — impossible to forget. Continuous drag methods (moveSymbolByRef,
	 *  translateElementById, …) do NOT call this themselves (would flood the
	 *  stack every mousemove) — the caller pushes once at gesture start. */
	pushUndoSnapshot(label = 'Edit'): void {
		const text = this.getSchematicText();
		if (!text || this.undoStack[this.undoStack.length - 1] === text) {
			return;
		}
		this.undoStack.push(text);
		this.undoLabels.push(label);
		if (this.undoStack.length > KicadRenderSession.maxUndoDepth) {
			this.undoStack.shift();
		}
		this.redoStack.length = 0;
		this.redoLabels.length = 0;
	}

	/** Clears both stacks — call on file load, never push (undo must not step
	 *  into an unrelated previously-opened file's content). */
	resetUndoHistory(): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.undoLabels.length = 0;
		this.redoLabels.length = 0;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** Compact history data for an editor/debug sidebar. */
	getUndoStackDebug(): { undoDepth: number; redoDepth: number; undo: { label: string; bytes: number }[] } {
		return {
			undoDepth: this.undoStack.length,
			redoDepth: this.redoStack.length,
			undo: this.undoStack.map((text, index) => ({
				label: this.undoLabels[index] ?? 'Edit',
				bytes: text.length,
			})),
		};
	}

	async undo(): Promise<boolean> {
		if (!this.undoStack.length) {
			return false;
		}
		const current = this.getSchematicText();
		const previous = this.undoStack.pop()!;
		const previousLabel = this.undoLabels.pop() ?? 'Edit';
		if (current) {
			this.redoStack.push(current);
			this.redoLabels.push(previousLabel);
		}
		await this.loadSchematicText(previous, { ...this.schematicDocInfo, preserveView: true });
		return true;
	}

	async redo(): Promise<boolean> {
		if (!this.redoStack.length) {
			return false;
		}
		const current = this.getSchematicText();
		const next = this.redoStack.pop()!;
		const nextLabel = this.redoLabels.pop() ?? 'Edit';
		if (current) {
			this.undoStack.push(current);
			this.undoLabels.push(nextLabel);
		}
		await this.loadSchematicText(next, { ...this.schematicDocInfo, preserveView: true });
		return true;
	}

	/**
	 * Apply one atomic edit to the currently-live placed symbol represented by
	 * a paint-item id. This is intentionally the property-inspector entry
	 * point: callers must not retain a paint item's element reference across a
	 * scene rebuild and mutate it later, because that makes undo state and the
	 * rendered scene drift apart.
	 */
	mutateSymbolByPaintId(paintId: string, mutate: (symbol: KicadElementSymbol) => void): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot || !this.schScene) {
			return false;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === paintId);
		const symbol = item?.element;
		if (!(symbol instanceof KicadElementSymbol) && symbol?.name !== 'symbol') {
			return false;
		}
		this.pushUndoSnapshot('Property edit');
		mutate(symbol as KicadElementSymbol);
		this.commitAstMutation();
		return true;
	}

	/**
	 * Pin number/name visibility and the pin-name offset are library-symbol-
	 * ONLY fields in real KiCad's own grammar — confirmed in the user's
	 * local checkout: `pin_names`/`pin_numbers` are only ever parsed inside
	 * SCH_IO_KICAD_SEXPR_PARSER::parseLibSymbol, never in the placed-
	 * instance parser. A placed `(symbol (lib_id …) (at …) …)` has no such
	 * child in real KiCad, and this app's own SchematicPainter.buildSymbol-
	 * Instance() already only ever reads these flags off the resolved
	 * LIBRARY definition (`libDef.arePinNumbersHidden()` etc.), never the
	 * instance — so writing them onto the instance (mutateSymbolByPaintId's
	 * usual target) is invisible by construction, not a renderer bug. This
	 * resolves the SAME paint id to the instance's OWN library definition
	 * instead, matching where the renderer actually looks and where real
	 * KiCad actually stores the field. Affects every OTHER placement of the
	 * same library symbol too — that's real KiCad's own behavior for this
	 * field, not a limitation of this method.
	 */
	mutateLibSymbolForInstance(paintId: string, mutate: (libSymbol: KicadElementSymbol) => void): boolean {
		const libDef = this.findLibSymbolForInstance(paintId);
		if (!libDef) {
			return false;
		}
		this.pushUndoSnapshot('Property edit');
		mutate(libDef);
		this.commitAstMutation();
		return true;
	}

	/** Read-only counterpart to mutateLibSymbolForInstance — for the
	 *  property panel's initial checkbox/field state, which must reflect
	 *  the SAME library definition the renderer and the mutator both read
	 *  from, not the placed instance (see mutateLibSymbolForInstance's doc
	 *  comment). Callers must not retain the returned reference past the
	 *  current render, same rule as every other paint-id lookup here. */
	findLibSymbolForInstance(paintId: string): KicadElementSymbol | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement || !this.schScene) {
			return null;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === paintId);
		const instance = item?.element;
		if (!(instance instanceof KicadElementSymbol)) {
			return null;
		}
		const libId = instance.getLibId?.();
		const libSymbols = this.schematicRoot.rootElement.findFirstChildByClass(KicadElementLibSymbols);
		return (libId && libSymbols ? libSymbols.findSymbolByName(libId) : null) ?? null;
	}

	/**
	 * Generic sibling of mutateSymbolByPaintId for every OTHER element kind
	 * (wires/shapes/text/labels/junctions/…) — same property-inspector entry
	 * point contract (find by paint id, push undo, mutate, commit; never
	 * retain the element reference past this call). No KicadElementSymbol-
	 * style type check here since the caller already knows what shape to
	 * expect from the paint item's own `kind`/`labelKind` before ever
	 * calling this — unlike symbols, there's no single common base class
	 * across wire/shape/text/label worth checking against.
	 */
	mutateElementByPaintId(paintId: string, mutate: (element: any) => void): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot || !this.schScene) {
			return false;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === paintId);
		if (!item?.element) {
			return false;
		}
		this.pushUndoSnapshot('Property edit');
		mutate(item.element);
		this.commitAstMutation();
		return true;
	}

	/**
	 * Batch sibling of mutateElementByPaintId for a multi-selection of
	 * same-kind items — shaped like deleteElements (one undo push, one
	 * commit), NOT like translateSelection's beginBatch/endBatch wrapper,
	 * because this never re-enters another self-committing method: it
	 * mutates each resolved element directly with the SAME callback, so
	 * there's nothing for a nested commitAstMutation() to short-circuit.
	 * Looping mutateElementByPaintId itself would push N undo snapshots and
	 * rebuild the scene N times for one logical edit — this pushes once and
	 * rebuilds once. Returns the count actually mutated (0 means the caller
	 * should not treat this as a real edit — e.g. skip the undo-adjacent
	 * UI refresh).
	 */
	mutateElementsByPaintIds(ids: string[], mutate: (element: any) => void): number {
		if (this.documentType !== 'schematic' || !this.schematicRoot || !this.schScene) {
			return 0;
		}
		const elements: any[] = [];
		for (const id of ids) {
			const el = this.schScene.hitTestItems.find(it => it.id === id)?.element;
			if (el) {
				elements.push(el);
			}
		}
		if (elements.length === 0) {
			return 0;
		}
		this.pushUndoSnapshot('Property edit');
		for (const el of elements) {
			mutate(el);
		}
		this.commitAstMutation();
		return elements.length;
	}

	/** Finds a placed symbol instance by its own paint-item id — unlike a
	 *  Reference designator, an id is always unique to one instance, even
	 *  when several units of one multi-unit part share a Reference (e.g.
	 *  five "U1" instances for a quad-gate-plus-power-unit part). Callers
	 *  that already have the id (e.g. from a hit-test at mousedown) should
	 *  prefer it over the Reference-keyed lookup below for exactly this
	 *  reason — see moveSymbolByRef/getSymbolPose/autoplaceSymbolFields'
	 *  optional `instanceId` parameter. */
	private findSymbolInstanceById(id: string): any | null {
		const item = this.schScene?.hitTestItems.find(it => it.kind === 'symbol' && it.id === id);
		return item?.element ?? null;
	}

	/**
	 * Move (and optionally rotate) a placed symbol instance by its Reference
	 * designator, then rebuild just the paint scene from the already-parsed
	 * document (no text re-parse) and re-render. This is what makes editor
	 * drag/rotate cheap enough to call on every frame — no server round trip,
	 * no re-parsing, just mutate the AST node and re-run the paint pass.
	 * Returns false if no symbol with that reference is in the loaded doc.
	 *
	 * Instance property fields (Reference/Value/…) are stored in absolute
	 * schematic coordinates in `.kicad_sch`, so they are translated (and
	 * rotated around the symbol origin when rotation changes) along with
	 * the body — matching KiCad's own move behavior.
	 */
	moveSymbolByRef(reference: string, x: number, y: number, rotation?: number, instanceId?: string): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const instance = instanceId
			? this.findSymbolInstanceById(instanceId)
			: this.schematicPainter.findSymbolInstanceByReference(this.schematicRoot, reference);
		if (!instance || typeof instance.setOrigin !== 'function') {
			return false;
		}
		const current = typeof instance.getOrigin === 'function'
			? instance.getOrigin()
			: { x: 0, y: 0, rotation: 0 };
		const oldX = Number(current.x ?? 0);
		const oldY = Number(current.y ?? 0);
		const oldRot = Number(current.rotation ?? 0);
		const newRot = rotation ?? oldRot;
		const dRot = ((newRot - oldRot) % 360 + 360) % 360;

		const props: any[] = typeof instance.getProperties === 'function'
			? instance.getProperties()
			: [];
		for (const prop of props) {
			if (!prop || typeof prop.getOrigin !== 'function' || typeof prop.setOrigin !== 'function') {
				continue;
			}
			const po = prop.getOrigin();
			const relX = Number(po.x ?? 0) - oldX;
			const relY = Number(po.y ?? 0) - oldY;
			let nx = relX;
			let ny = relY;
			if (dRot === 90) {
				nx = -relY;
				ny = relX;
			}
			else if (dRot === 180) {
				nx = -relX;
				ny = -relY;
			}
			else if (dRot === 270) {
				nx = relY;
				ny = -relX;
			}
			// Field text must stay READABLE: KiCad only ever draws Reference /
			// Value at 0° or 90°, never upside-down (180°) or mirrored (270°).
			// The position rotates with the symbol; the text angle is normalised.
			const propRot = Number(po.rotation ?? 0);
			const readableRot = (((propRot + dRot) % 360) + 360) % 360 % 180;
			prop.setOrigin(x + nx, y + ny, readableRot);
		}

		instance.setOrigin(x, y, newRot);

		this.commitAstMutation();
		return true;
	}

	/**
	 * Move a hierarchical sheet box by absolute position (mirrors
	 * moveSymbolByRef's shape, minus the rotation handling real KiCad has no
	 * equivalent of for sheets — see KicadElementSheet's doc comment).
	 * Sheet properties (Sheetname/Sheetfile/custom) AND sheet pins are both
	 * stored at ABSOLUTE coordinates in the file (confirmed via
	 * SchematicPainter.buildSheet's own read path, which uses each one's own
	 * `(at …)` directly as world position, never relative to the sheet's own
	 * `at`) — so both need shifting by the same delta the box itself moves
	 * by, or a drag would leave the name/file text and every pin arrow
	 * behind at their old position while just the box outline moved.
	 */
	moveSheetById(paintId: string, x: number, y: number): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot || !this.schScene) {
			return false;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === paintId);
		const sheet = item?.element;
		if (!(sheet instanceof KicadElementSheet)) {
			return false;
		}
		const { x: oldX, y: oldY } = sheet.getPosition();
		const dx = x - oldX, dy = y - oldY;
		if (dx !== 0 || dy !== 0) {
			sheet.setPosition(x, y);
			const props: any[] = typeof sheet.getProperties === 'function' ? sheet.getProperties() : [];
			for (const prop of props) {
				if (!prop || typeof prop.getOrigin !== 'function' || typeof prop.setOrigin !== 'function') {
					continue;
				}
				const po = prop.getOrigin();
				prop.setOrigin(Number(po.x ?? 0) + dx, Number(po.y ?? 0) + dy, po.rotation ?? 0);
			}
			for (const pin of sheet.findChildrenByClass(KicadElementPin)) {
				if (typeof pin.getOrigin !== 'function' || typeof pin.setOrigin !== 'function') {
					continue;
				}
				const po = pin.getOrigin();
				pin.setOrigin(Number(po.x ?? 0) + dx, Number(po.y ?? 0) + dy, po.rotation ?? 0);
			}
		}
		this.commitAstMutation();
		return true;
	}

	/**
	 * Move a single sheet pin, constrained to slide along whichever of the
	 * parent sheet's 4 edges is nearest the target point — ports real
	 * KiCad's SCH_SHEET_PIN::ConstrainOnEdge exactly (eeschema/
	 * sch_sheet_pin.cpp, confirmed in the user's local checkout, including
	 * `aAllowEdgeSwitch=true`, always used on its own drag path — a pin can
	 * jump to a different edge mid-drag, not just slide along its starting
	 * one).
	 *
	 * The stored rotation per edge comes directly from
	 * `getSheetPinAngle(SHEET_SIDE)` (eeschema/sch_io/kicad_sexpr/
	 * sch_io_kicad_sexpr_common.cpp — the dedicated sheet-pin serializer,
	 * confirmed in the user's local checkout): LEFT=180, RIGHT=0, TOP=90,
	 * BOTTOM=270. An earlier version of this derived the same table
	 * INDIRECTLY (SCH_SHEET_PIN::SetSide()'s per-edge SPIN_STYLE combined
	 * with the GENERIC label parser's separate rotation<->SPIN_STYLE map)
	 * and landed on every edge's opposite value (LEFT/RIGHT swapped,
	 * TOP/BOTTOM swapped) — sheet pins turn out to have their own dedicated
	 * write path entirely separate from SCH_IO_KICAD_SEXPR::saveText's
	 * generic label SPIN_STYLE handling, so reasoning by analogy from that
	 * path was the wrong source to begin with, not just a transcription
	 * slip.
	 *
	 * Fixing this table alone still rendered text on the wrong side (inside
	 * the sheet instead of outside), because buildSheet's render path
	 * ALSO applied a `(rotation+180)` flip plus an input/output shape swap
	 * before drawing — justified by a comment claiming a pin's stored
	 * orientation describes the signal as seen from inside the child sheet
	 * and needs flipping for the parent-box arrow. That claim traced back
	 * to kicanvas (a third-party reimplementation), not real KiCad. Real
	 * KiCad's own QA fixture (qa/data/eeschema/issue10926_1.kicad_sch) and
	 * its referenced subsheet (issue10926_1_subsheet_1.kicad_sch) disprove
	 * it directly: a sheet pin and the plain `hierarchical_label` for the
	 * SAME signal on the child side store the identical rotation and shape,
	 * no flip either way — consistent with SCH_SHEET_PIN extending
	 * SCH_HIERLABEL and sch_painter.cpp drawing both through one generic
	 * path with no special-casing. The flip/swap has been removed from
	 * buildSheet; both bugs (this file's table, and that file's flip) are
	 * now fixed together and verified against the same real fixture.
	 *
	 * `justify`, unlike rotation/shape, is NOT the same between a sheet pin
	 * and its matching hier label — it's the opposite (that same fixture:
	 * sheet pin "IN" has `justify left`, the subsheet's matching
	 * `hierarchical_label "IN"` has `justify right`, same rotation 180 —
	 * necessary because buildSheet's flip means the text sits on the
	 * opposite side, so it needs the opposite justify to still read
	 * correctly). `SCH_SHEET_PIN::SetSide()` (same file) sets rotation AND
	 * justify TOGETHER via `SetSpinStyle()` (sch_label.cpp) — confirmed
	 * exact mapping: LEFT->H_ALIGN_LEFT, RIGHT->H_ALIGN_RIGHT,
	 * TOP->H_ALIGN_RIGHT, BOTTOM->H_ALIGN_LEFT. `ConstrainOnEdge` calls
	 * `SetSide()` UNCONDITIONALLY on every drag (even via its
	 * `aAllowEdgeSwitch=false` branch, which re-asserts the CURRENT edge)
	 * — so justify is set fresh every drag, never left stale from a
	 * previous edge. This method does the same below: setJustify runs
	 * every call, not just when the edge actually changes, otherwise a
	 * pin dragged e.g. RIGHT-\>LEFT would keep its stale RIGHT-edge
	 * justify paired with its new LEFT-edge rotation, rendering text
	 * starting from outside the box again — the exact regression this
	 * paragraph exists to prevent a repeat of.
	 */
	moveSheetPinById(paintId: string, x: number, y: number): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot || !this.schScene) {
			return false;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === paintId);
		const pin = item?.element;
		if (!(pin instanceof KicadElementPin) || !(pin.parent instanceof KicadElementSheet) || typeof pin.setOrigin !== 'function') {
			return false;
		}
		const sheet = pin.parent;
		const { x: sx, y: sy } = sheet.getPosition();
		const { width: sw, height: sh } = sheet.getSize();
		const left = sx, right = sx + sw, top = sy, bottom = sy + sh;

		const edgeRotation = { left: 180, right: 0, top: 90, bottom: 270 } as const;
		const edgeJustify = { left: 'left', right: 'right', top: 'right', bottom: 'left' } as const;
		const edges: { side: keyof typeof edgeRotation; dist: number }[] = [
			{ side: 'top', dist: distanceToSegment(x, y, left, top, right, top) },
			{ side: 'right', dist: distanceToSegment(x, y, right, top, right, bottom) },
			{ side: 'bottom', dist: distanceToSegment(x, y, right, bottom, left, bottom) },
			{ side: 'left', dist: distanceToSegment(x, y, left, bottom, left, top) },
		];
		const nearest = edges.reduce((a, b) => (b.dist < a.dist ? b : a));

		let px: number, py: number;
		if (nearest.side === 'left' || nearest.side === 'right') {
			px = nearest.side === 'left' ? left : right;
			py = Math.max(top, Math.min(bottom, y));
		}
		else {
			py = nearest.side === 'top' ? top : bottom;
			px = Math.max(left, Math.min(right, x));
		}

		pin.setOrigin(px, py, edgeRotation[nearest.side]);
		pin.setJustify(edgeJustify[nearest.side], 'middle');
		this.commitAstMutation();
		return true;
	}

	/**
	 * Re-place a symbol's visible Reference/Value fields to computed anchors
	 * (from the layout lib's `symbolFieldLayout`), so a rotated/moved part's
	 * labels sit cleanly beside the body, upright, and clear of the wires.
	 */
	autoplaceSymbolFields(reference: string, layout: {
		refX: number;
		refY: number;
		valX: number;
		valY: number;
		fieldRot: number;
		justify: 'left' | 'middle';
	}, instanceId?: string): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const instance: any = instanceId
			? this.findSymbolInstanceById(instanceId)
			: this.schematicPainter.findSymbolInstanceByReference(this.schematicRoot, reference);
		if (!instance || typeof instance.getPropertyByName !== 'function') {
			return false;
		}
		const place = (name: string, fx: number, fy: number): void => {
			const prop = instance.getPropertyByName(name);
			if (!prop || typeof prop.setOrigin !== 'function') {
				return;
			}
			prop.setOrigin(fx, fy, layout.fieldRot);
			if (typeof prop.setJustify === 'function') {
				prop.setJustify(layout.justify);
			}
		};
		place('Reference', layout.refX, layout.refY);
		place('Value', layout.valX, layout.valY);

		this.commitAstMutation();
		return true;
	}

	/**
	 * Move a global/local/hierarchical label or a symbol instance field by paint-item id
	 * (e.g. `"uuid:flag"`, `"uuid"`, or `"sym:uuid:prop:Reference"`). Label net text is
	 * unchanged — only the attach point/field anchor moves.
	 */
	moveLabelById(paintId: string, x: number, y: number, rotation?: number): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const items = this.schScene?.hitTestItems ?? [];
		const item = items.find(it => it.id === paintId || it.id.startsWith(`${paintId}:`));
		const fieldName = item?.fieldName ?? paintId.match(/:prop:(.+)$/)?.[1] ?? null;
		if (fieldName) {
			const instance = item?.element;
			if (instance && typeof instance.getPropertyByName === 'function') {
				const prop = instance.getPropertyByName(fieldName);
				if (prop && typeof prop.getOrigin === 'function' && typeof prop.setOrigin === 'function') {
					const cur = prop.getOrigin?.() ?? { rotation: 0 };
					prop.setOrigin(x, y, rotation ?? cur.rotation ?? 0);
					this.commitAstMutation();
					return true;
				}
			}
		}
		const el = item?.element;
		if (!el || typeof el.setOrigin !== 'function') {
			// Fall back: search root children by uuid prefix in paint id.
			const uuid = paintId.replace(/:(flag|text)$/, '');
			const root = this.schematicRoot.rootElement;
			const kids: any[] = root?.children ?? [];
			for (const kid of kids) {
				if (
					(kid?.name === 'global_label' || kid?.name === 'hierarchical_label' || kid?.name === 'label')
					&& typeof kid.getUuid === 'function'
					&& String(kid.getUuid()) === uuid
					&& typeof kid.setOrigin === 'function'
				) {
					const cur = kid.getOrigin?.() ?? { rotation: 0 };
					kid.setOrigin(x, y, rotation ?? cur.rotation ?? 0);
					this.commitAstMutation();
					return true;
				}
			}
			return false;
		}
		const cur = typeof el.getOrigin === 'function' ? el.getOrigin() : { rotation: 0 };
		el.setOrigin(x, y, rotation ?? cur.rotation ?? 0);
		this.commitAstMutation();
		return true;
	}

	/**
	 * Direct children of the root schematic that are placed symbol instances
	 * (not library definitions). Used by circuit edit without a recipe seed.
	 */
	listSymbolPoses(): SymbolPoseInfo[] {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return [];
		}
		const out: SymbolPoseInfo[] = [];
		const root = this.schematicRoot.rootElement;
		const kids: any[] = root?.children ?? [];
		for (const instance of kids) {
			if (
				!instance
				|| instance.name !== 'symbol'
				|| typeof instance.getReference !== 'function'
				|| typeof instance.getOrigin !== 'function'
			) {
				continue;
			}
			const ref = String(instance.getReference() ?? '').trim();
			if (!ref) {
				continue;
			}
			const origin = instance.getOrigin();
			const libId = typeof instance.getLibId === 'function'
				? String(instance.getLibId() ?? '')
				: '';
			out.push({
				ref,
				libId,
				x: Number(origin?.x ?? 0),
				y: Number(origin?.y ?? 0),
				rotation: Number(origin?.rotation ?? 0),
			});
		}
		return out;
	}

	getSymbolPose(reference: string, instanceId?: string): SymbolPoseInfo | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return null;
		}
		const instance = instanceId
			? this.findSymbolInstanceById(instanceId)
			: this.schematicPainter.findSymbolInstanceByReference(this.schematicRoot, reference);
		if (!instance || typeof instance.getOrigin !== 'function') {
			return null;
		}
		const origin = instance.getOrigin();
		const libId = typeof instance.getLibId === 'function' ? String(instance.getLibId() ?? '') : '';
		const ref = typeof instance.getReference === 'function'
			? String(instance.getReference() ?? reference)
			: reference;
		return {
			ref,
			libId,
			x: Number(origin?.x ?? 0),
			y: Number(origin?.y ?? 0),
			rotation: Number(origin?.rotation ?? 0),
		};
	}

	// ---- Hand-drawn editing (wires/junctions/no-connects/graphics) ----
	//
	// Free-angle construct-and-attach, not text-templating: mirrors
	// moveSymbolByRef's pattern of mutating the live AST directly. Every
	// method here calls setUuid() itself — WithUUID only self-heals inside
	// setUuid()'s own default argument, never automatically at write() time,
	// so a freshly-constructed element with no explicit setUuid() call simply
	// has no uuid child (correct for symbol-library-style graphics, wrong for
	// anything meant to be individually selectable/deletable on a sheet).
	// Width 0 on every stroke matches this codebase's existing convention
	// (e.g. Router.ts's emitWireSexpr) — 0 means "KiCad's default rendered
	// width", not invisible.

	/** setUuid + addChild only — no undo push, no commit. Shared by
	 *  attachToSchematicRoot (one element, one undo step) and addWireLike
	 *  (wire + 0-2 auto-junctions, still one undo step). Just assigns
	 *  identity and delegates the actual splice to insertRootChild — split
	 *  out so a clone with no setUuid() of its own (a rule-area, whose uuid
	 *  lives on its nested polyline instead) can assign identity its own
	 *  way and still reuse the insertion step unchanged. */
	private attachElement(el: { setUuid(u?: string): void }): void {
		el.setUuid();
		this.insertRootChild(el);
	}

	/** Inserts just before the first trailing `sheet_instances`/
	 *  `embedded_files` element instead of unconditionally appending —
	 *  real KiCad always writes those last, and a naive append (this
	 *  method's original behavior) lands any newly-added element AFTER
	 *  them, producing a file real KiCad's own writer would never emit.
	 *  Confirmed via a live loaded-and-round-tripped file: children ended
	 *  up `[...,'wire','sheet_instances','symbol']` after a plain append.
	 *  Every element type reads its children via `findChildrenByClass`/
	 *  `findFirstChildByClass` (order-independent full scans), so this is
	 *  safe for every caller, not just symbols. */
	private insertRootChild(el: any): void {
		const root: any = this.schematicRoot!.rootElement;
		el.parent = root;
		el.rootLevel = (root.rootLevel ?? 0) + 1;
		const trailingIndex = root.children.findIndex((c: any) => c.name === 'sheet_instances' || c.name === 'embedded_files');
		if (trailingIndex === -1) {
			root.children.push(el);
		}
		else {
			root.children.splice(trailingIndex, 0, el);
		}
	}

	private attachToSchematicRoot(el: { setUuid(u?: string): void }): string | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement) {
			return null;
		}
		this.pushUndoSnapshot();
		this.attachElement(el);
		this.commitAstMutation();
		return (el as unknown as { getUuid(): string | undefined }).getUuid() ?? null;
	}

	/** One wire segment (2 points only — see buildWireLike, which reads just
	 *  points[0]/[1]). A multi-segment hand-drawn wire is one call per click. */
	addWire(x1: number, y1: number, x2: number, y2: number, strokeWidth = 0): string | null {
		return this.addWireLike(() => new KicadElementWire(), x1, y1, x2, y2, strokeWidth, 'wire');
	}

	/** Same shape as addWire — KicadElementBus/its rendering already existed
	 *  (this codebase already reads real bus wires), only creation was missing. */
	addBus(x1: number, y1: number, x2: number, y2: number, strokeWidth = 0): string | null {
		return this.addWireLike(() => new KicadElementBus(), x1, y1, x2, y2, strokeWidth, 'bus');
	}

	/** Shared addWire/addBus tail: commit the new segment, then check BOTH of
	 *  its own endpoints for a real KiCad-style auto-junction (see
	 *  junctionNeededAt's doc comment) and add one where needed — all under
	 *  the SAME undo snapshot as the wire itself, so one Ctrl+Z removes the
	 *  wire and any junction it triggered together, not as two separate
	 *  steps. Needs a commit BEFORE the junction check (not just the raw AST
	 *  child-add) because junctionNeededAt reads already-resolved pin
	 *  positions off schScene, which only exist post-build. */
	private addWireLike(
		makeEl: () => { setPoints(pts: { x: number; y: number }[]): void; setStroke(w: number, t: 'default'): void; setUuid(u?: string): void; getUuid(): string | undefined },
		x1: number, y1: number, x2: number, y2: number, strokeWidth: number, kind: 'wire' | 'bus'
	): string | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement) {
			return null;
		}
		this.pushUndoSnapshot();
		const el = makeEl();
		el.setPoints([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
		el.setStroke(strokeWidth, 'default');
		this.attachElement(el);
		this.commitAstMutation();

		let addedJunction = false;
		for (const [px, py] of [[x1, y1], [x2, y2]] as [number, number][]) {
			if (this.junctionNeededAt(px, py, kind)) {
				const junction = new KicadElementJunction();
				junction.setOrigin(px, py);
				junction.setDiameter(0);
				junction.setColor(0, 0, 0, 0);
				this.attachElement(junction);
				addedJunction = true;
			}
		}
		if (addedJunction) {
			this.commitAstMutation();
		}
		return el.getUuid() ?? null;
	}

	/**
	 * Ports eeschema/junction_helpers.cpp's JUNCTION_HELPERS::AnalyzePoint,
	 * confirmed in the user's local KiCad checkout: real KiCad's rule for
	 * whether a point NEEDS an automatically-placed junction is "3 or more
	 * distinct exit directions meet here" — NOT simply "2+ things touch this
	 * point" (a plain 2-wire corner/chain, or a wire continuing collinearly
	 * as two separate objects, is completely unambiguous without a dot).
	 * Wires and buses are counted as separate pools (never cross-trigger
	 * each other), matching real KiCad's WIRES/BUSES split.
	 *
	 * A wire/bus whose OWN endpoint sits at the point contributes ONE exit
	 * angle (the direction away from the point). A wire/bus that merely
	 * passes THROUGH the point (a mid-segment hit — the actual "T" case)
	 * contributes TWO — both directions along itself — modeling what an
	 * explicit split would look like without requiring one. Pins and labels
	 * sitting at the point (wires only — real KiCad doesn't count these for
	 * buses) each contribute one synthetic "this is a distinct thing" angle,
	 * same as real KiCad's uniqueAngle counter for non-line connectables.
	 * An already-junctioned point is never re-flagged.
	 */
	private junctionNeededAt(x: number, y: number, kind: 'wire' | 'bus'): boolean {
		if (!this.schScene) {
			return false;
		}
		const junctions = this.schScene.layerBuckets.get('Junctions') ?? [];
		if (junctions.some(j => j.shape.type === 'circle' && pointsNear(j.shape.cx, j.shape.cy, x, y))) {
			return false;
		}

		const angles = new Set<number>();
		const wireLike = (this.schScene.layerBuckets.get('Wires') ?? []).filter(it => it.kind === kind);
		for (const item of wireLike) {
			if (item.shape.type !== 'segment') {
				continue;
			}
			const { x1, y1, x2, y2 } = item.shape;
			if (pointsNear(x1, y1, x, y)) {
				angles.add(quantizedAngle(x, y, x2, y2));
			}
			else if (pointsNear(x2, y2, x, y)) {
				angles.add(quantizedAngle(x, y, x1, y1));
			}
			else if (pointLiesOnSegmentInterior(x, y, x1, y1, x2, y2)) {
				angles.add(quantizedAngle(x, y, x1, y1));
				angles.add(quantizedAngle(x, y, x2, y2));
			}
		}

		if (kind === 'wire') {
			let uniq = 0;
			const pins = this.schScene.layerBuckets.get('Pins') ?? [];
			for (const item of pins) {
				if (item.shape.type === 'segment' && pointsNear(item.shape.x1, item.shape.y1, x, y)) {
					angles.add(SYNTHETIC_ANGLE_BASE + uniq++);
				}
			}
			const labels = (this.schScene.layerBuckets.get('Labels') ?? []).filter(it => it.kind === 'label' && it.hitTestable);
			for (const item of labels) {
				const origin = typeof item.element?.getOrigin === 'function' ? item.element.getOrigin() : null;
				if (origin && pointsNear(origin.x, origin.y, x, y)) {
					angles.add(SYNTHETIC_ANGLE_BASE + uniq++);
				}
			}
		}

		return angles.size >= 3;
	}

	/** One-click placement like junction/no-connect. Fixed default 45° stub
	 *  direction (up-right) — v1 simplification, no direction-picker UI. */
	addBusEntry(x: number, y: number, dx = 2.54, dy = -2.54, strokeWidth = 0): string | null {
		const entry = new KicadElementBusEntry();
		entry.setOrigin(x, y);
		entry.setSize(dx, dy);
		entry.setStroke(strokeWidth, 'default');
		return this.attachToSchematicRoot(entry);
	}

	addJunction(x: number, y: number): string | null {
		const junction = new KicadElementJunction();
		junction.setOrigin(x, y);
		junction.setDiameter(0);
		junction.setColor(0, 0, 0, 0);
		return this.attachToSchematicRoot(junction);
	}

	addNoConnect(x: number, y: number): string | null {
		const nc = new KicadElementNoConnect();
		nc.setOrigin(x, y);
		return this.attachToSchematicRoot(nc);
	}

	/** No standalone "line" tag in the schematic grammar — a 2-point polyline. */
	addGraphicLine(x1: number, y1: number, x2: number, y2: number, strokeWidth = 0): string | null {
		const line = new KicadElementPolyline();
		line.setPoints([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
		line.setStroke(strokeWidth, 'default');
		return this.attachToSchematicRoot(line);
	}

	addGraphicRect(x1: number, y1: number, x2: number, y2: number, strokeWidth = 0): string | null {
		const rect = new KicadElementRectangle(x1, y1, x2, y2);
		rect.setStroke(strokeWidth, 'default');
		return this.attachToSchematicRoot(rect);
	}

	addGraphicCircle(cx: number, cy: number, radius: number, strokeWidth = 0): string | null {
		const circle = new KicadElementCircle(cx, cy, radius);
		circle.setStroke(strokeWidth, 'default');
		return this.attachToSchematicRoot(circle);
	}

	addGraphicArc(
		sx: number, sy: number, mx: number, my: number, ex: number, ey: number, strokeWidth = 0
	): string | null {
		const arc = new KicadElementArc();
		arc.setStartMidEnd(sx, sy, mx, my, ex, ey);
		arc.setStroke(strokeWidth, 'default');
		return this.attachToSchematicRoot(arc);
	}

	addGraphicBezier(points: { x: number; y: number }[], strokeWidth = 0): string | null {
		if (points.length !== 4) {
			return null;
		}
		const bezier = new KicadElementBezier();
		bezier.setPoints(points.map(point => ({ x: point.x, y: point.y })));
		bezier.setStroke(strokeWidth, 'default');
		return this.attachToSchematicRoot(bezier);
	}

	addGraphicTable(x: number, y: number, rows: number, columns: number, values: string[][]): string | null {
		if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) return null;
		const table = new KicadElementTable();
		const cells = new (class extends KicadElementTableCell { override name = 'cells'; })();
		// The `cells` container is a named wrapper, not a table_cell itself.
		(table as any).children.pop();
		cells.name = 'cells';
		table.addChild(cells);
		table.setSimpleChild('column_count', columns, 'numeric');
		const cellWidth = 25.4;
		const cellHeight = 12.7;
		for (let row = 0; row < rows; row++) {
			for (let column = 0; column < columns; column++) {
				const cell = new KicadElementTableCell();
				const value = values[row]?.[column] ?? '';
				cell.setAttribute({ value, format: 'quoted' }, 0);
				cell.value = value;
				cell.addChild(new KicadElementAt(x + column * cellWidth, y + row * cellHeight));
				cell.addChild(new KicadElementSize(cellWidth, cellHeight));
				cell.setSimpleChild('margins', 0.9525, 'numeric');
				const margins = cell.findFirstChildByName('margins')!;
				margins.setAttribute({ value: 0.9525, format: 'numeric' }, 1);
				margins.setAttribute({ value: 0.9525, format: 'numeric' }, 2);
				margins.setAttribute({ value: 0.9525, format: 'numeric' }, 3);
				cell.setSimpleChild('span', 1, 'numeric');
				cell.findFirstChildByName('span')!.setAttribute({ value: 1, format: 'numeric' }, 1);
				cells.addChild(cell);
			}
		}
		const stroke = table.findOrCreateChildByName('border');
		stroke.setSimpleChild('external', true, 'boolean');
		stroke.setSimpleChild('header', false, 'boolean');
		const strokeChild = stroke.findOrCreateChildByName('stroke');
		strokeChild.setSimpleChild('width', 0.15, 'numeric');
		strokeChild.setSimpleChild('type', 'solid', 'literal');
		const separators = table.findOrCreateChildByName('separators');
		separators.setSimpleChild('rows', true, 'boolean');
		separators.setSimpleChild('cols', true, 'boolean');
		const separatorStroke = separators.findOrCreateChildByName('stroke');
		separatorStroke.setSimpleChild('width', 0.15, 'numeric');
		separatorStroke.setSimpleChild('type', 'solid', 'literal');
		return this.attachToSchematicRoot(table);
	}

	addRuleArea(points: { x: number; y: number }[]): string | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement || points.length < 3) return null;
		this.pushUndoSnapshot();
		// Typed setters (not setSimpleChild's generic-KicadElement path) —
		// using the untyped path here left a rule area's 4 boolean flags as
		// plain KicadElement instances instead of KicadElementExcludeFromSim/
		// InBom/OnBoard/Dnp, so a later findOrCreateChildByClass() lookup
		// (e.g. the property panel's DNP checkbox) couldn't find the
		// existing one — it created a SECOND, differently-typed child with
		// the same tag name instead of updating this one, and both got
		// serialized (a real duplicate-(dnp ...)-tag bug, caught via the
		// property panel actually trying to toggle one).
		const area = new KicadElementRuleArea();
		area.setExcludedFromSim(false);
		area.setInBom(true);
		area.setOnBoard(true);
		area.setDnp(false);
		const polyline = new KicadElementPolyline();
		polyline.setPoints(points.map(point => ({ x: point.x, y: point.y })));
		polyline.setStroke(0, 'dash');
		polyline.setFill('none');
		polyline.setUuid();
		area.addChild(polyline);
		this.schematicRoot!.rootElement.addChild(area);
		this.commitAstMutation();
		return polyline.getUuid() ?? null;
	}

	addGraphicText(x: number, y: number, value: string, rotation = 0): string | null {
		const text = new KicadElementText(value);
		text.setOrigin(x, y, rotation);
		text.setFont(1.27, 1.27);
		return this.attachToSchematicRoot(text);
	}

	/**
	 * Embed a raster image in the schematic at its center point. The image
	 * payload is the binary string expected by KicadElementData (not base64):
	 * its writer performs the KiCad-specific base64 wrapping and 76-character
	 * line splitting when the schematic is serialized. Keeping that conversion
	 * here means file and clipboard insertion share exactly one AST path and
	 * one undo snapshot.
	 */
	addGraphicImage(x: number, y: number, data: string, mimeType: string, scale = 1): string | null {
		if (!data || !mimeType.startsWith('image/')) {
			return null;
		}
		const image = new KicadElementImage();
		image.setOrigin(x, y, 0);
		image.setScale(Number.isFinite(scale) && scale > 0 ? scale : 1);
		// Keep the canonical KiCad child order: at, scale, uuid, data.
		// attachToSchematicRoot() calls setUuid() again, which reuses this
		// existing UUID child rather than adding a duplicate.
		image.setUuid();
		const imageData = new KicadElementData();
		imageData.data = data;
		image.addChild(imageData);
		return this.attachToSchematicRoot(image);
	}

	getSelectionResizeBox(): SelectionResizeBox | null {
		const selectedId = this.selection;
		if (this.documentType !== 'schematic' || !selectedId || !this.schScene) {
			return null;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === selectedId);
		const el: any = item?.element;
		if (!item || !el || (el.name !== 'rectangle' && el.name !== 'text_box' && el.name !== 'image')
			|| item.shape.type !== 'rect') {
			return null;
		}
		const { x, y, w, h } = item.bbox;
		return w > 0 && h > 0 ? { id: item.id, x, y, width: w, height: h } : null;
	}

	getSelectionCurveAnchors(): SelectionCurveAnchors | null {
		const selectedId = this.selection;
		if (this.documentType !== 'schematic' || !selectedId || !this.schScene) {
			return null;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === selectedId);
		const el: any = item?.element;
		if (!item || !el) {
			return null;
		}
		if (el.name === 'circle' && typeof el.getCenter === 'function' && typeof el.getRadius === 'function') {
			const center = el.getCenter();
			const radius = el.getRadius();
			return {
				id: item.id, kind: 'circle', anchors: [
					{ kind: 'circle-center', x: center.x, y: center.y },
					{ kind: 'circle-radius', x: center.x + radius, y: center.y },
				],
			};
		}
		if (el.name === 'arc' && typeof el.getStartMidEnd === 'function'
			&& typeof el.getArcCenterRadiusAngles === 'function') {
			try {
				const { start, mid, end } = el.getStartMidEnd();
				const geometry = el.getArcCenterRadiusAngles(false);
				return {
					id: item.id, kind: 'arc', anchors: [
						{ kind: 'arc-start', x: start.x, y: start.y },
						{ kind: 'arc-mid', x: mid.x, y: mid.y },
						{ kind: 'arc-end', x: end.x, y: end.y },
						{ kind: 'arc-center', x: geometry.centerX, y: geometry.centerY },
					],
				};
			}
			catch {
				return null;
			}
		}
		if (el.name === 'bezier' && typeof el.getPoints === 'function') {
			const points = el.getPoints();
			if (!Array.isArray(points) || points.length !== 4) return null;
			const kinds: CurveAnchor[] = ['bezier-start', 'bezier-control-1', 'bezier-control-2', 'bezier-end'];
			return {
				id: item.id, kind: 'bezier',
				anchors: points.map((point: { x: number; y: number }, index: number) => ({
					kind: kinds[index]!, x: point.x, y: point.y,
				})),
			};
		}
		if (item.shape.type === 'polygon' && (el.name === 'polyline' || el.name === 'rule_area')) {
			const points = item.shape.points;
			return {
				id: item.id, kind: 'polygon',
				anchors: points.map((point, index) => ({
					kind: `polygon-vertex-${index}` as CurveAnchor, x: point.x, y: point.y,
				})),
			};
		}
		return null;
	}

	/** Creates a regular schematic `(text_box ...)` from two drag corners. */
	addGraphicTextBox(x1: number, y1: number, x2: number, y2: number, value: string): string | null {
		const width = Math.abs(x2 - x1);
		const height = Math.abs(y2 - y1);
		if (!(width > 0) || !(height > 0)) {
			return null;
		}
		const textBox = new KicadElementTextBox(value);
		textBox.setOrigin(Math.min(x1, x2), Math.min(y1, y2), 0);
		textBox.setSize(width, height);
		textBox.setFont(1.27, 1.27);
		textBox.setJustify('left', 'top');
		textBox.setStroke(0, 'solid');
		textBox.setFill('none');
		return this.attachToSchematicRoot(textBox);
	}

	/** Mirrors shared/kicad-layout/Place.ts's labelJustify(): 0 -> left, 180 ->
	 *  right, vertical stubs (90/270) keep left — KiCad draws label text beside
	 *  the wire regardless of stub direction. */
	private static labelJustifyFor(rotation: number): 'left' | 'right' {
		const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
		return r === 180 ? 'right' : 'left';
	}

	addLabel(x: number, y: number, value: string, rotation = 0): string | null {
		const label = new KicadElementLabel(value);
		label.setOrigin(x, y, rotation);
		label.setFont(1.27, 1.27);
		label.setJustify(KicadRenderSession.labelJustifyFor(rotation));
		return this.attachToSchematicRoot(label);
	}

	addGlobalLabel(x: number, y: number, value: string, shape: KicadGlobalLabelShape, rotation = 0): string | null {
		const label = new KicadElementGlobalLabel();
		label.setName(value);
		label.setShape(shape);
		label.setOrigin(x, y, rotation);
		label.setFont(1.27, 1.27);
		label.setJustify(KicadRenderSession.labelJustifyFor(rotation));
		return this.attachToSchematicRoot(label);
	}

	addHierLabel(x: number, y: number, value: string, shape: KicadHierarchicalLabelShape, rotation = 0): string | null {
		const label = new KicadElementHierarchicalLabel();
		label.setName(value);
		label.setShape(shape);
		label.setOrigin(x, y, rotation);
		label.setFont(1.27, 1.27);
		label.setJustify(KicadRenderSession.labelJustifyFor(rotation));
		return this.attachToSchematicRoot(label);
	}

	/** Directive Label ("netclass_flag" — see KicadElementNetclassFlag's doc
	 *  comment). Unlike the other 3 label kinds, the user-facing text lives
	 *  in a child "Netclass" property, not the element's own top-level
	 *  attribute (setName proxies to it — see that class). The property's
	 *  own position is a small fixed offset from the flag's anchor — a
	 *  reasonable default (same "good enough, user can drag it precisely
	 *  afterward" precedent as buildPowerSymbolInstance's Reference/Value
	 *  placement) rather than replicating real KiCad's AutoplaceFields
	 *  heuristic. */
	addDirectiveLabel(x: number, y: number, netclassName: string, shape: KicadDirectiveLabelShape = 'round', rotation = 0): string | null {
		const flag = new KicadElementNetclassFlag();
		flag.setOrigin(x, y, rotation);
		flag.setShape(shape);
		flag.setPinLength(2.54);
		flag.setFont(1.27, 1.27);
		flag.setJustify(KicadRenderSession.labelJustifyFor(rotation));
		flag.addChild(KicadElementSymbol.buildLibraryProperty('Netclass', netclassName, { x: x + 2.54, y: y - 1.27, rot: 0 }));
		return this.attachToSchematicRoot(flag);
	}

	/**
	 * Find (or build-and-insert) a power-symbol library definition in the
	 * schematic's lib_symbols block, keyed by libId. If lib_symbols itself is
	 * missing (rare — every file this app can open already has one, but don't
	 * assume it can't happen) a fresh one is unshifted to the FRONT of the
	 * root's children, not appended via addChild, matching real KiCad's
	 * convention of lib_symbols appearing near the top of the file rather than
	 * the end.
	 */
	private ensureLibSymbol(libId: string, build: () => KicadElementSymbol): void {
		if (!this.schematicRoot?.rootElement) {
			return;
		}
		const root = this.schematicRoot.rootElement;
		let libSymbols = root.findFirstChildByClass(KicadElementLibSymbols);
		if (!libSymbols) {
			libSymbols = new KicadElementLibSymbols();
			libSymbols.parent = root;
			libSymbols.rootLevel = root.rootLevel + 1;
			root.children.unshift(libSymbols);
		}
		if (!libSymbols.findSymbolByName(libId)) {
			libSymbols.addChild(build());
		}
	}

	/** How many placeable units `symbolName` has (1 for an ordinary
	 *  single-unit part). Resolves one level of `extends` first — a derived
	 *  symbol has no sub-units of its own, matching addLibrarySymbolFromText's
	 *  own base-resolution — so a derived part reports its base's count. */
	getLibrarySymbolUnitCount(sourceText: string, symbolName: string): number {
		const parsed = new KicadParser().parse(sourceText);
		const candidates = parsed.name === 'symbol'
			? [parsed as KicadElementSymbol]
			: parsed.children.filter(child => child instanceof KicadElementSymbol) as KicadElementSymbol[];
		const source = candidates.find(symbol => symbol.symbolName === symbolName)
			?? candidates.find(symbol => symbol.symbolName?.endsWith(`:${ symbolName }`));
		if (!source) {
			return 1;
		}
		let graphicsSource = source;
		if (source.isDerived() && source.getLayers().length === 0) {
			const base = candidates.find(symbol => symbol.symbolName === source.getExtends());
			if (base) graphicsSource = base;
		}
		return graphicsSource.getUnitCount();
	}

	/** Add a normal schematic symbol from a standalone .kicad_sym source.
	 * The library definition is copied into the document's lib_symbols block,
	 * while the placed instance contains only the lightweight sheet-level
	 * fields KiCad expects. Parsing the definition again is intentional: it
	 * detaches the object from the temporary library-file AST and gives every
	 * child the correct parent/root level when attached to this document.
	 *
	 * `unit` selects which sub-unit this instance represents (plain single-
	 * unit parts are always unit 1); `reuseReference` places this unit under
	 * an EXISTING reference designator instead of allocating a fresh one —
	 * multi-unit placement calls this once per unit, reusing unit 1's
	 * returned reference for units 2..N so every unit of one physical part
	 * shares the same designator, matching real KiCad's own model. */
	addLibrarySymbolFromText(sourceText: string, symbolName: string, x: number, y: number, libIdOverride?: string, unit = 1, reuseReference?: string): string | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement || !sourceText.trim()) {
			return null;
		}
		const parsed = new KicadParser().parse(sourceText);
		const candidates = parsed.name === 'symbol'
			? [parsed as KicadElementSymbol]
			: parsed.children.filter(child => child instanceof KicadElementSymbol) as KicadElementSymbol[];
		const source = candidates.find(symbol => symbol.symbolName === symbolName)
			?? candidates.find(symbol => symbol.symbolName?.endsWith(`:${ symbolName }`));
		if (!source) {
			return null;
		}

		const libId = libIdOverride ?? source.symbolName ?? symbolName;
		const sourceForClone = new KicadParser().parse(source.write()) as KicadElementSymbol;
		sourceForClone.symbolName = libId;
		const detached = new KicadParser().parse(sourceForClone.write()) as KicadElementSymbol;

		// A derived symbol (`(extends "Base")`) has no graphics/pins of its
		// own — real KiCad resolves them from the base transparently
		// everywhere. This app's renderer does the same (see
		// SchematicPainter.relevantSubUnits), but only within the SAME
		// lib_symbols block: the base must be embedded here too, not just
		// referenced. `source.getExtends()` is the base's bare name (no
		// library prefix — that's how it's written in the source file); the
		// detached copy's own extends value still says that bare name after
		// cloning, which would only resolve if a lib_symbols entry happened
		// to be keyed by the bare name too — instead, embed the base under
		// the SAME namespace prefix as this symbol's own libId, and rewrite
		// the detached copy's extends to match, so both entries resolve
		// consistently by look-up within this document's own lib_symbols.
		let detachedBase: KicadElementSymbol | null = null;
		let baseLibId: string | null = null;
		if (source.isDerived()) {
			const baseName = source.getExtends()!;
			const base = candidates.find(symbol => symbol.symbolName === baseName);
			if (base) {
				const prefix = libId.includes(':') ? libId.slice(0, libId.indexOf(':') + 1) : '';
				baseLibId = `${ prefix }${ baseName }`;
				const baseForClone = new KicadParser().parse(base.write()) as KicadElementSymbol;
				baseForClone.symbolName = baseLibId;
				detachedBase = new KicadParser().parse(baseForClone.write()) as KicadElementSymbol;
				detached.setExtends(baseLibId);
			}
		}

		this.pushUndoSnapshot('Place symbol');
		if (detachedBase && baseLibId) {
			this.ensureLibSymbol(baseLibId, () => detachedBase!);
		}
		this.ensureLibSymbol(libId, () => detached);

		const referenceBase = String(source.getAllProperties().Reference ?? 'U').replace(/^~|\?.*$/g, '').trim() || 'U';
		const reference = reuseReference ?? this.nextSymbolRef(referenceBase);
		const value = String(source.getAllProperties().Value ?? libId);
		const instance = new KicadElementSymbol();
		instance.addChild(new KicadElementLibId(libId));
		instance.setOrigin(x, y, 0);
		instance.setUuid();
		instance.findOrCreateChildByClass(KicadElementUnit).value = unit;
		instance.setExcludeFromSim(false).setInBom(true).setOnBoard(true);
		instance.findOrCreateChildByClass(KicadElementDnp).value = false;

		const propertyAt = (name: string, fallbackY: number) => {
			const property = source.getPropertyByName(name);
			const origin = property?.getOrigin?.();
			return {
				x: x + Number(origin?.x ?? 0),
				y: y + Number(origin?.y ?? fallbackY),
				rot: Number(origin?.rotation ?? 0),
				hide: property?.isHidden?.() ?? (name !== 'Reference' && name !== 'Value'),
			};
		};
		instance.addChild(KicadElementSymbol.buildLibraryProperty('Reference', reference, propertyAt('Reference', -2.54)));
		instance.addChild(KicadElementSymbol.buildLibraryProperty('Value', value, propertyAt('Value', 2.54)));
		instance.addChild(KicadElementSymbol.buildLibraryProperty('Footprint', '', propertyAt('Footprint', 0)));
		instance.addChild(KicadElementSymbol.buildLibraryProperty('Datasheet', '', propertyAt('Datasheet', 0)));
		this.attachElement(instance);
		this.commitAstMutation();
		return reference;
	}

	private nextSymbolRef(base: string): string {
		const prefix = base.replace(/[0-9?]+$/g, '') || 'U';
		let max = 0;
		for (const kid of this.schematicRoot?.rootElement?.children ?? []) {
			if (kid?.name !== 'symbol' || typeof (kid as any).getReference !== 'function') continue;
			const value = String((kid as any).getReference() ?? '');
			const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const match = new RegExp(`^${ escapedPrefix }(\\d+)$`).exec(value);
			if (match) max = Math.max(max, Number(match[1]));
		}
		return `${ prefix }${ max + 1 }`;
	}

	/**
	 * Next free `#PWR`/`#FLG` reference for a fresh power symbol placement —
	 * scans the live document (unlike shared/kicad-layout/Place.ts's recipe
	 * flow, which always regenerates every reference from 1 because it rebuilds
	 * the whole connectivity block at once; an incremental add to an
	 * already-edited document needs to know what's already on the sheet).
	 */
	private nextPowerRef(prefix: '#PWR' | '#FLG'): string {
		let max = 0;
		const kids: any[] = this.schematicRoot?.rootElement?.children ?? [];
		const re = new RegExp(`^${ prefix }(\\d+)$`);
		for (const kid of kids) {
			if (!kid || kid.name !== 'symbol' || typeof kid.getReference !== 'function') {
				continue;
			}
			const m = re.exec(String(kid.getReference() ?? '').trim());
			if (m) {
				max = Math.max(max, parseInt(m[1], 10));
			}
		}
		return prefix + String(max + 1).padStart(2, '0');
	}

	addPowerGnd(x: number, y: number, rotation = 0): string | null {
		this.ensureLibSymbol('power:GND', () => buildPowerGnd());
		const ref = this.nextPowerRef('#PWR');
		const instance = buildPowerSymbolInstance({
			libId: 'power:GND', x, y, rotation, ref, value: 'GND',
			refOffsetY: -6.35, valueOffsetY: -3.81, refHidden: true, valueHidden: true
		});
		return this.attachToSchematicRoot(instance);
	}

	addPowerFlag(x: number, y: number, rotation = 0): string | null {
		this.ensureLibSymbol('power:PWR_FLAG', () => buildPowerFlag());
		const ref = this.nextPowerRef('#FLG');
		const instance = buildPowerSymbolInstance({
			libId: 'power:PWR_FLAG', x, y, rotation, ref, value: 'PWR_FLAG',
			refOffsetY: 1.905, valueOffsetY: 3.81, refHidden: true, valueHidden: false
		});
		return this.attachToSchematicRoot(instance);
	}

	addPowerRail(x: number, y: number, name: string, rotation = 0): string | null {
		this.ensureLibSymbol(`power:${ name }`, () => buildPowerRail(name));
		const ref = this.nextPowerRef('#PWR');
		const instance = buildPowerSymbolInstance({
			libId: `power:${ name }`, x, y, rotation, ref, value: name,
			refOffsetY: -3.81, valueOffsetY: 3.556, refHidden: true, valueHidden: false
		});
		return this.attachToSchematicRoot(instance);
	}

	/**
	 * Serializes each resolved element to standalone KiCad text (element.
	 * write(), no undo push, no mutation) — the source format Duplicate/
	 * Paste's clone-and-reparse step (cloneAndPlace) consumes. Callers must
	 * not retain any LIVE element reference from this call past the current
	 * render (same rule every other paint-id lookup in this file follows) —
	 * only the returned text is safe to hold onto.
	 */
	copySelectionText(ids: string[]): { id: string; sourceText: string }[] {
		if (this.documentType !== 'schematic' || !this.schScene) {
			return [];
		}
		const result: { id: string; sourceText: string }[] = [];
		for (const id of ids) {
			const el: any = this.schScene.hitTestItems.find(it => it.id === id)?.element;
			if (el && typeof el.write === 'function') {
				result.push({ id, sourceText: el.write() });
			}
		}
		return result;
	}

	/**
	 * Clone-and-reparse (new KicadParser().parse(source.write()) — the same
	 * idiom addLibrarySymbolFromText already uses, generic across every
	 * registered element kind), fresh identity, offset by (dx, dy), inserted
	 * at the root — the shared tail for both duplicateSelection and
	 * pasteElements. Repositions the clone DIRECTLY via
	 * translateElementGeometry rather than translateElementById/
	 * moveSymbolByRef, because neither can find a just-created, not-yet-
	 * attached element — both resolve their target through a paint-id
	 * lookup against schScene, which isn't rebuilt until the caller's batch
	 * closes.
	 *
	 * Symbols get their own branch (matching moveItemBy's own symbol/
	 * generic split): a fresh Reference via nextSymbolRef (never keep the
	 * original's — two live instances sharing one Reference is invalid),
	 * and every property's own origin offset along with the body, so
	 * Reference/Value text moves with it instead of being left behind at
	 * the old field position. Everything else (including rule areas, via
	 * translateElementGeometry's own polyline delegation) is fully generic.
	 */
	private cloneAndPlace(sourceText: string, dx: number, dy: number): any | null {
		let clone: any;
		try {
			clone = new KicadParser().parse(sourceText);
		}
		catch {
			return null;
		}
		if (!clone || typeof clone.write !== 'function') {
			return null;
		}
		return this.placeClonedElement(clone, dx, dy);
	}

	/**
	 * The actual identity-reassignment + reposition + insert logic
	 * cloneAndPlace() delegates to once it has a parsed clone — split out so
	 * pasteSystemClipboardText() (whose elements are already parsed, as
	 * children of a synthetic wrapper — see its own doc comment) can place
	 * them directly without a redundant write()-then-reparse round trip.
	 * `el` must not already be attached to a document (no `.parent`).
	 */
	private placeClonedElement(el: any, dx: number, dy: number): any {
		if (el instanceof KicadElementSymbol) {
			const origin = el.getOrigin();
			el.setUuid();
			const oldRef = String(el.getReference() ?? 'U');
			// #PWR/#FLG references use their own zero-padded numbering
			// convention (nextPowerRef, already used for every OTHER power-
			// symbol placement path) — falling through to the generic
			// nextSymbolRef here would still produce a valid, unique
			// reference, just an inconsistently-formatted one (e.g. "#PWR3"
			// beside existing "#PWR01"/"#PWR02").
			const powerPrefix = oldRef.startsWith('#PWR') ? '#PWR' : oldRef.startsWith('#FLG') ? '#FLG' : null;
			el.setProperty('Reference', powerPrefix ? this.nextPowerRef(powerPrefix) : this.nextSymbolRef(oldRef));
			el.setOrigin(origin.x + dx, origin.y + dy, origin.rotation);
			for (const prop of el.getProperties()) {
				const propOrigin = prop.getOrigin();
				prop.setOrigin(propOrigin.x + dx, propOrigin.y + dy, propOrigin.rotation);
			}
		}
		else {
			if (typeof el.getPolyline === 'function') {
				el.getPolyline()?.setUuid();
			}
			else if (typeof el.setUuid === 'function') {
				el.setUuid();
			}
			this.translateElementGeometry(el, dx, dy);
		}
		this.insertRootChild(el);
		return el;
	}

	/** Reads a representative anchor point off an element without mutating
	 *  it — same capability order translateElementGeometry writes through,
	 *  used by pasteSystemClipboardText to compute a combined top-left for
	 *  content that isn't attached to any document yet (so its real bbox,
	 *  which for a symbol requires resolving the library transform, isn't
	 *  available the way it is for an already-painted item). An accepted
	 *  approximation for multi-item layout, not pixel-exact — same spirit
	 *  as hitTestRect's own bbox tradeoffs elsewhere in this file. */
	private originOf(el: any): { x: number; y: number } | null {
		if (typeof el?.getOrigin === 'function') {
			return el.getOrigin();
		}
		if (typeof el?.getPoints === 'function') {
			return el.getPoints()?.[0] ?? null;
		}
		if (typeof el?.getStartMidEnd === 'function') {
			return el.getStartMidEnd()?.start ?? null;
		}
		if (typeof el?.getStartEnd === 'function') {
			return el.getStartEnd()?.start ?? null;
		}
		if (typeof el?.getCenter === 'function') {
			return el.getCenter();
		}
		if (typeof el?.getPolyline === 'function') {
			return this.originOf(el.getPolyline());
		}
		return null;
	}

	/** element.name values this app's parser/painter can place as a
	 *  top-level schematic item — the allowlist pasteSystemClipboardText
	 *  filters incoming clipboard content against. Deliberately excludes
	 *  'sheet' (matches copyableIds' existing exclusion — out of this
	 *  app's single-file scope) and 'group' (grouping info from an
	 *  unrelated document's own uuid space is meaningless here). Anything
	 *  NOT in this set — including a generic/unrecognized fallback element
	 *  produced by pasting non-KiCad text — is silently dropped rather
	 *  than inserted, since this is the one paste path whose source isn't
	 *  guaranteed to be this app's own prior copy. */
	private static readonly PASTEABLE_ELEMENT_NAMES = new Set([
		'wire', 'bus', 'bus_entry', 'junction', 'no_connect',
		'symbol', 'rectangle', 'circle', 'arc', 'polyline', 'bezier', 'rule_area',
		'text', 'text_box', 'label', 'global_label', 'hierarchical_label', 'netclass_flag',
		'image', 'table',
	]);

	/**
	 * Builds a real-KiCad-compatible clipboard TEXT blob for the given
	 * selection — confirmed against real KiCad's own clipboard writer
	 * (eeschema/tools/sch_editor_control.cpp's SCH_EDITOR_CONTROL::doCopy,
	 * which calls SCH_IO_KICAD_SEXPR::Format() on the selection): an
	 * optional `(lib_symbols ...)` block first, containing only the
	 * definitions actually used by any copied symbol, followed by each
	 * copied element's own bare top-level s-expression, newline-joined.
	 * Deliberately no `(kicad_sch ...)` wrapper — real KiCad's own
	 * clipboard format doesn't have one either; SCH_EDITOR_CONTROL::Paste
	 * feeds the raw content straight into its file-content loader.
	 */
	copySelectionForSystemClipboard(ids: string[]): string {
		if (this.documentType !== 'schematic' || !this.schScene || !this.schematicRoot?.rootElement) {
			return '';
		}
		const elements: any[] = [];
		for (const id of ids) {
			const el = this.schScene.hitTestItems.find(it => it.id === id)?.element;
			if (el && typeof el.write === 'function') {
				elements.push(el);
			}
		}
		if (elements.length === 0) {
			return '';
		}
		const libIds = new Set<string>();
		for (const el of elements) {
			if (el instanceof KicadElementSymbol) {
				const libId = el.getLibId?.();
				if (libId) {
					libIds.add(libId);
				}
			}
		}
		const parts: string[] = [];
		if (libIds.size > 0) {
			const libSymbols = this.schematicRoot.rootElement.findFirstChildByClass(KicadElementLibSymbols);
			const defs: string[] = [];
			for (const libId of libIds) {
				const def = libSymbols?.findSymbolByName(libId);
				if (def) {
					defs.push(def.write());
				}
			}
			if (defs.length > 0) {
				parts.push(`(lib_symbols\n${defs.join('\n')}\n)`);
			}
		}
		for (const el of elements) {
			parts.push(el.write());
		}
		return parts.join('\n');
	}

	/**
	 * Cross-application counterpart to pasteElements — parses raw
	 * clipboard TEXT that may have come from real KiCad's own Copy (or
	 * this app's own copySelectionForSystemClipboard) and places it into
	 * the live document. Real KiCad's clipboard content is a BARE sequence
	 * of top-level s-expressions with no enclosing wrapper (see
	 * copySelectionForSystemClipboard's doc comment), so this wraps it in
	 * a synthetic `(kicad_sch ...)` and reuses the exact same parser
	 * loadSchematicText() itself uses for a whole file, reading just
	 * `.children` back out — no new parsing logic needed, and it's the
	 * same trick that makes the wrap-then-parse succeed even though
	 * 'kicad_sch' behaves as an ordinary container here, never treated as
	 * a real document (never assigned to schematicRoot, write() never
	 * called on it).
	 *
	 * Unlike every OTHER paste/duplicate path in this app (whose source is
	 * always this app's own prior copy, guaranteed well-formed), this is
	 * the one place genuinely external, unvalidated content reaches the
	 * live AST — filters the parsed top-level children against
	 * PASTEABLE_ELEMENT_NAMES before touching the document, so pasting
	 * unrelated non-KiCad text (or a parse that produces nothing
	 * recognizable) is a clean no-op, not a document full of orphaned
	 * generic elements. A `(lib_symbols ...)` block, if present, is merged
	 * into this document's OWN lib_symbols (via the same ensureLibSymbol
	 * used everywhere else a symbol gets placed) rather than treated as a
	 * placeable item itself.
	 */
	pasteSystemClipboardText(text: string, targetX: number, targetY: number): string[] {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement || !text.trim()) {
			return [];
		}
		let wrapper: any;
		try {
			wrapper = new KicadParser().parse(`(kicad_sch\n${text}\n)`);
		}
		catch {
			return [];
		}
		const children: any[] = wrapper?.children ?? [];
		const libSymbolsBlock = children.find(c => c?.name === 'lib_symbols');
		const items = children.filter(c => KicadRenderSession.PASTEABLE_ELEMENT_NAMES.has(c?.name));
		if (items.length === 0) {
			return [];
		}
		if (libSymbolsBlock) {
			for (const def of libSymbolsBlock.children ?? []) {
				if (def instanceof KicadElementSymbol && def.symbolName) {
					this.ensureLibSymbol(def.symbolName, () => def);
				}
			}
		}
		let minX = Infinity, minY = Infinity;
		for (const el of items) {
			const origin = this.originOf(el);
			if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
				minX = Math.min(minX, origin.x);
				minY = Math.min(minY, origin.y);
			}
		}
		const dx = Number.isFinite(minX) ? targetX - minX : 0;
		const dy = Number.isFinite(minY) ? targetY - minY : 0;

		this.pushUndoSnapshot('Paste');
		this.beginBatch();
		const placed: any[] = [];
		for (const el of items) {
			placed.push(this.placeClonedElement(el, dx, dy));
		}
		this.endBatch();
		if (!this.schScene) {
			return [];
		}
		return this.schScene.hitTestItems.filter(it => placed.includes(it.element)).map(it => it.id);
	}

	/**
	 * Batch-duplicates a selection in place, offset by a small fixed default
	 * (2.54mm/100mil both axes — a common "paste offset" convention) so the
	 * copies don't land exactly on top of the originals. One undo push, one
	 * scene rebuild for however many items are duplicated — same
	 * beginBatch/endBatch shape translateSelection uses. Returns the NEW
	 * items' paint ids, resolved post-rebuild by object identity (no paint
	 * id exists for a clone until the rebuild produces one) — valid because
	 * after endBatch()'s rebuild the painter reads the live AST (now
	 * including the clones) and its output items' `.element` is reference-
	 * equal to the exact clone objects already held here.
	 */
	duplicateSelection(ids: string[], dx = 2.54, dy = 2.54): string[] {
		if (this.documentType !== 'schematic' || !this.schScene || ids.length === 0) {
			return [];
		}
		const sources: string[] = [];
		for (const id of ids) {
			const el: any = this.schScene.hitTestItems.find(it => it.id === id)?.element;
			if (el && typeof el.write === 'function') {
				sources.push(el.write());
			}
		}
		if (sources.length === 0) {
			return [];
		}
		this.pushUndoSnapshot('Duplicate');
		this.beginBatch();
		const clones: any[] = [];
		for (const sourceText of sources) {
			const clone = this.cloneAndPlace(sourceText, dx, dy);
			if (clone) {
				clones.push(clone);
			}
		}
		this.endBatch();
		if (clones.length === 0) {
			return [];
		}
		return this.schScene!.hitTestItems.filter(it => clones.includes(it.element)).map(it => it.id);
	}

	/**
	 * Batch counterpart for Paste — each entry carries its own (dx, dy) so
	 * the caller (main.ts's in-memory clipboard) can position every pasted
	 * item relative to the current cursor while preserving the copied set's
	 * original relative layout. Same one-undo/one-batch/resolve-by-object-
	 * identity shape as duplicateSelection.
	 */
	pasteElements(items: { sourceText: string; dx: number; dy: number }[]): string[] {
		if (this.documentType !== 'schematic' || !this.schScene || items.length === 0) {
			return [];
		}
		this.pushUndoSnapshot('Paste');
		this.beginBatch();
		const clones: any[] = [];
		for (const { sourceText, dx, dy } of items) {
			const clone = this.cloneAndPlace(sourceText, dx, dy);
			if (clone) {
				clones.push(clone);
			}
		}
		this.endBatch();
		if (clones.length === 0) {
			return [];
		}
		return this.schScene!.hitTestItems.filter(it => clones.includes(it.element)).map(it => it.id);
	}

	/**
	 * Wraps the given selection into a new KicadElementGroup — no kind
	 * restriction (moveItemBy already knows how to move every kind, so
	 * there's no technical reason to exclude symbols/sheets/wires from
	 * being grouped together). Stores each member by its own ELEMENT uuid,
	 * never the paint id (see expandGroupSelection's doc comment). Returns
	 * the new group's own uuid, or null if fewer than 2 ids resolved to
	 * real elements.
	 */
	groupSelection(ids: string[]): string | null {
		if (this.documentType !== 'schematic' || !this.schScene) {
			return null;
		}
		const uuids: string[] = [];
		for (const id of ids) {
			const uuid = (this.schScene.hitTestItems.find(it => it.id === id)?.element as any)?.getUuid?.();
			if (uuid) {
				uuids.push(uuid);
			}
		}
		if (uuids.length < 2) {
			return null;
		}
		this.pushUndoSnapshot('Group');
		const group = new KicadElementGroup();
		this.attachElement(group);
		group.setMemberUuids(uuids);
		this.commitAstMutation();
		return group.getUuid() ?? null;
	}

	/**
	 * Removes every KicadElementGroup whose member set intersects the given
	 * selection — members themselves are untouched, only the wrapper
	 * element disappears. Returns how many group elements were removed.
	 */
	ungroupSelection(ids: string[]): number {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement || !this.schScene) {
			return 0;
		}
		const uuids = new Set(
			ids.map(id => (this.schScene!.hitTestItems.find(it => it.id === id)?.element as any)?.getUuid?.()).filter(Boolean)
		);
		if (uuids.size === 0) {
			return 0;
		}
		const groups = this.allGroups().filter(g => g.getMemberUuids().some(u => uuids.has(u)));
		if (groups.length === 0) {
			return 0;
		}
		this.pushUndoSnapshot('Ungroup');
		const children: any[] = this.schematicRoot.rootElement.children;
		for (const group of groups) {
			const idx = children.indexOf(group);
			if (idx >= 0) {
				children.splice(idx, 1);
			}
		}
		this.commitAstMutation();
		return groups.length;
	}

	/**
	 * Delete paint items by id (from hitTestAtScreen/hitTestItems) — wires,
	 * junctions, no-connects, graphics, text. NOT symbols (those stay owned by
	 * the circuit-layout flow) — callers should route kind:'symbol' hits
	 * elsewhere. Returns how many were actually found and removed.
	 */
	deleteElements(ids: string[]): number {
		if (this.documentType !== 'schematic' || !this.schematicRoot?.rootElement) {
			return 0;
		}
		this.pushUndoSnapshot();
		const idSet = new Set(ids);
		const children: any[] = this.schematicRoot.rootElement.children;
		let removed = 0;
		for (const id of idSet) {
			const item = this.schScene?.hitTestItems.find(it => it.id === id);
			const el = item?.element;
			if (!el) {
				continue;
			}
			const idx = children.indexOf(el);
			if (idx < 0) {
				continue;
			}
			children.splice(idx, 1);
			removed++;
			this.selectedIds.delete(id);
		}
		if (removed > 0) {
			this.commitAstMutation();
		}
		return removed;
	}

	/**
	 * Translate a non-symbol element (wire/bus/polyline, arc, rectangle,
	 * circle, junction/no-connect/text) by a screen-independent world delta.
	 * Dispatches on whichever geometry accessor the hit element actually has —
	 * the five cases below are mutually exclusive across every element kind
	 * this method needs to support. Symbols are NOT handled here — route
	 * kind:'symbol' hits through moveSymbolByRef instead (circuit mode's own
	 * convention, absolute position rather than a delta).
	 */
	translateElementById(id: string, dx: number, dy: number): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot || (dx === 0 && dy === 0)) {
			return false;
		}
		const el: any = this.schScene?.hitTestItems.find(it => it.id === id)?.element;
		if (!el || !this.translateElementGeometry(el, dx, dy)) {
			return false;
		}
		this.commitAstMutation();
		return true;
	}

	/** The per-shape geometry dispatch translateElementById() resolves an id
	 *  to before calling this — split out so callers that already hold a
	 *  live element reference can reposition it directly. Needed by
	 *  alignSelection (already has the item from its own bbox scan) and by
	 *  Duplicate/Paste's cloneAndPlace (the clone has no paint id yet — it
	 *  isn't in schScene until the batch's rebuild, so a by-id lookup
	 *  couldn't find it anyway). The five cases are mutually exclusive
	 *  across every non-symbol element kind this app supports. */
	private translateElementGeometry(el: any, dx: number, dy: number): boolean {
		// Rule areas store their geometry on a nested polyline, not on the
		// wrapper itself (see KicadElementRuleArea's doc comment) — none of
		// the five cases below match the wrapper directly, so without this
		// a rule area caught up in a group-drag/align/duplicate would
		// silently keep its old position while everything else in the same
		// gesture moved.
		if (typeof el.getPolyline === 'function') {
			const polyline = el.getPolyline();
			return polyline ? this.translateElementGeometry(polyline, dx, dy) : false;
		}
		if (typeof el.getPoints === 'function' && typeof el.setPoints === 'function') {
			el.setPoints(el.getPoints().map((p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy })));
		}
		else if (typeof el.getStartMidEnd === 'function' && typeof el.setStartMidEnd === 'function') {
			const { start, mid, end } = el.getStartMidEnd();
			el.setStartMidEnd(start.x + dx, start.y + dy, mid.x + dx, mid.y + dy, end.x + dx, end.y + dy);
		}
		else if (typeof el.getStartEnd === 'function' && typeof el.setStartEnd === 'function') {
			const { start, end } = el.getStartEnd();
			el.setStartEnd(start.x + dx, start.y + dy, end.x + dx, end.y + dy);
		}
		else if (typeof el.getCenter === 'function' && typeof el.setCenter === 'function') {
			const c = el.getCenter();
			el.setCenter(c.x + dx, c.y + dy);
		}
		else if (typeof el.getOrigin === 'function' && typeof el.setOrigin === 'function') {
			const o = el.getOrigin();
			el.setOrigin(o.x + dx, o.y + dy, o.rotation);
		}
		else {
			return false;
		}
		return true;
	}

	/**
	 * Group-drag primitive: moves every one of the given (already-selected)
	 * items by the same world-space delta, regardless of how many different
	 * element kinds are mixed into the selection — multi-select's analogue
	 * to deleteElements(ids) for movement. Dispatches per item exactly the
	 * way each kind's own single-item drag already does (moveSymbolByRef
	 * for symbols, moveSheetById for sheets, moveSheetPinById for sheet
	 * pins, translateElementById for everything else — labels included,
	 * since edit mode's labels are already delta-movable through their own
	 * getOrigin/setOrigin, unlike circuit mode's absolute-position label
	 * drag), calling the EXISTING public methods unchanged rather than
	 * duplicating their mutation logic. Only wrapped in beginBatch/endBatch
	 * so an N-item drag costs one scene rebuild per call instead of N.
	 */
	translateSelection(ids: string[], dx: number, dy: number): boolean {
		if (this.documentType !== 'schematic' || !this.schScene || (dx === 0 && dy === 0)) {
			return false;
		}
		const selectedSymbolOwners = new Set<string>();
		for (const id of ids) {
			const item = this.schScene.hitTestItems.find(it => it.id === id);
			if (!item) {
				continue;
			}
			if (item.kind === 'symbol') {
				selectedSymbolOwners.add(item.id.replace(/^symbol:/, ''));
			}
		}
		this.beginBatch();
		let mutated = false;
		for (const id of ids) {
			const item = this.schScene.hitTestItems.find(it => it.id === id);
			if (!item) {
				continue;
			}
			if (item.kind === 'label' && item.labelKind === 'symbol-field') {
				const owner = item.id.match(/^(.+):prop:/)?.[1];
				if (owner && selectedSymbolOwners.has(owner)) {
					continue;
				}
			}
			if (this.moveItemBy(item, dx, dy)) {
				mutated = true;
			}
		}
		this.endBatch();
		return mutated;
	}

	/** Per-item move dispatch shared by translateSelection (one shared delta
	 *  for the whole selection) and alignSelection (a different delta per
	 *  item). Symbols/sheets/sheet-pins need their own absolute-position
	 *  setters — same as each kind's own single-item drag already uses —
	 *  everything else goes through translateElementById's generic
	 *  geometry dispatch. */
	private moveItemBy(item: SchPaintedItem, dx: number, dy: number): boolean {
		const el: any = item.element;
		const origin = typeof el?.getOrigin === 'function' ? el.getOrigin() : null;
		if (item.kind === 'symbol' && origin) {
			return this.moveSymbolByRef(item.refDesignator ?? '', origin.x + dx, origin.y + dy, origin.rotation, item.id);
		}
		if (item.kind === 'sheet' && origin) {
			return this.moveSheetById(item.id, origin.x + dx, origin.y + dy);
		}
		if (item.kind === 'label' && item.labelKind === 'sheet-pin' && origin) {
			return this.moveSheetPinById(item.id, origin.x + dx, origin.y + dy);
		}
		if (item.kind === 'label' && item.labelKind === 'symbol-field') {
			const fieldName = item.fieldName ?? null;
			const instance = item.element;
			const prop = fieldName && typeof instance?.getPropertyByName === 'function'
				? instance.getPropertyByName(fieldName)
				: null;
			const current = prop && typeof prop.getOrigin === 'function'
				? prop.getOrigin()
				: (item.fieldOrigin ?? { x: 0, y: 0, rotation: 0 });
			return this.moveLabelById(item.id, Number(current.x ?? 0) + dx, Number(current.y ?? 0) + dy, current.rotation ?? 0);
		}
		return this.translateElementById(item.id, dx, dy);
	}

	/**
	 * Aligns every item in a multi-selection along one shared edge/center —
	 * unlike translateSelection (one shared delta for the whole selection),
	 * every item here moves by a DIFFERENT delta, computed from each item's
	 * own bbox against the selection's combined bbox (same min/max union
	 * fitToItems() computes, done locally here since fitToItems also moves
	 * the camera as a side effect, which align must not do). Still reuses
	 * moveItemBy per item — same per-kind symbol/sheet/sheet-pin/generic
	 * dispatch translateSelection uses — under one beginBatch/endBatch pair.
	 * Items whose computed delta is already ~0 are filtered out before
	 * pushing undo, so "Align Left" on an already-aligned selection doesn't
	 * add a no-op entry to the undo stack.
	 *
	 * Two accepted bbox fidelity limits, inherited unchanged from
	 * hitTestRect's own bbox-approximation precedent — not bugs to fix here:
	 * wire/bus bboxes are padded by strokeWidth/2 per side (PaintedShape.ts),
	 * so aligning differently-stroked wires by edge is off by the width
	 * delta; plain text bboxes are a fixed ±textSize heuristic
	 * (SchematicPainter.ts's buildSchText), not real glyph width, so right-
	 * edge alignment across differently-sized text isn't meaningful (left-
	 * edge/center-x is fine; text_box has a real stored size and doesn't
	 * have this caveat).
	 */
	alignSelection(ids: string[], axis: AlignAxis): boolean {
		if (this.documentType !== 'schematic' || !this.schScene || ids.length < 2) {
			return false;
		}
		const items: { item: SchPaintedItem; bbox: { x: number; y: number; w: number; h: number } }[] = [];
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const id of ids) {
			const item = this.schScene.hitTestItems.find(it => it.id === id);
			if (!item) continue;
			const { x, y, w, h } = item.bbox;
			if (![x, y, w, h].every(Number.isFinite) || w < 0 || h < 0) continue;
			items.push({ item, bbox: { x, y, w, h } });
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x + w);
			maxY = Math.max(maxY, y + h);
		}
		if (items.length < 2) {
			return false;
		}
		const centerX = (minX + maxX) / 2;
		const centerY = (minY + maxY) / 2;
		const moves: { item: SchPaintedItem; dx: number; dy: number }[] = [];
		for (const { item, bbox } of items) {
			let dx = 0, dy = 0;
			switch (axis) {
				case 'left': dx = minX - bbox.x; break;
				case 'right': dx = maxX - (bbox.x + bbox.w); break;
				case 'top': dy = minY - bbox.y; break;
				case 'bottom': dy = maxY - (bbox.y + bbox.h); break;
				case 'center-x': dx = centerX - (bbox.x + bbox.w / 2); break;
				case 'center-y': dy = centerY - (bbox.y + bbox.h / 2); break;
			}
			if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
				moves.push({ item, dx, dy });
			}
		}
		if (moves.length === 0) {
			return false;
		}
		this.pushUndoSnapshot('Align');
		this.beginBatch();
		let mutated = false;
		for (const { item, dx, dy } of moves) {
			if (this.moveItemBy(item, dx, dy)) {
				mutated = true;
			}
		}
		this.endBatch();
		return mutated;
	}

	/** Resize one root-level rectangle or text box to normalized world bounds.
	 * Like translateElementById(), this is a continuous-drag primitive: callers
	 * push a single undo snapshot before the gesture, not for every mousemove. */
	resizeElementBoundsById(id: string, x: number, y: number, width: number, height: number, handle?: ResizeHandle): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot || !(width > 0) || !(height > 0)) {
			return false;
		}
		const el: any = this.schScene?.hitTestItems.find(it => it.id === id)?.element;
		if (!el) {
			return false;
		}
		if (el.name === 'rectangle' && typeof el.setStartEnd === 'function') {
			el.setStartEnd(x, y, x + width, y + height);
		}
		else if (el.name === 'text_box' && typeof el.getOrigin === 'function'
			&& typeof el.setOrigin === 'function' && typeof el.setSize === 'function') {
			const origin = el.getOrigin();
			el.setOrigin(x, y, origin.rotation ?? 0);
			el.setSize(width, height);
		}
		else if (el.name === 'image' && typeof el.getOrigin === 'function'
			&& typeof el.setOrigin === 'function' && typeof el.getScale === 'function'
			&& typeof el.setScale === 'function') {
			const current = this.schScene?.hitTestItems.find(it => it.id === id);
			if (!current || current.shape.type !== 'rect' || !(current.shape.w > 0) || !(current.shape.h > 0)) {
				return false;
			}
			const currentScale = Number(el.getScale?.() ?? 1);
			const widthRatio = width / current.shape.w;
			const heightRatio = height / current.shape.h;
			// Image scale is uniform in KiCad. Select the dimension controlled by
			// the active handle, then derive the other dimension from that scale;
			// using the live bounds (rather than alternating width/height errors)
			// prevents the image from oscillating during a corner drag.
			const ratio = handle && !handle.includes('e') && !handle.includes('w') ? heightRatio : widthRatio;
			const nextWidth = current.shape.w * ratio;
			const nextHeight = current.shape.h * ratio;
			const fixedRight = x + width;
			const fixedBottom = y + height;
			const nextX = handle?.includes('w') ? fixedRight - nextWidth : x;
			const nextY = handle?.includes('n') ? fixedBottom - nextHeight : y;
			const origin = el.getOrigin();
			el.setScale(Math.max(1e-6, currentScale * ratio));
			el.setOrigin(nextX + nextWidth / 2, nextY + nextHeight / 2, origin.rotation ?? 0);
		}
		else {
			return false;
		}
		this.commitAstMutation();
		return true;
	}

	/** KiCad-style point-editor mutation for root circles/arcs. Arcs preserve
	 * the other two defining points when dragging start/mid/end; their center
	 * point translates the complete arc, matching KiCad's common arc-edit
	 * mode. */
	moveCurveAnchorById(id: string, anchor: CurveAnchor, x: number, y: number): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const el: any = this.schScene?.hitTestItems.find(it => it.id === id)?.element;
		if (!el) {
			return false;
		}
		if ((anchor === 'circle-center' || anchor === 'circle-radius') && el.name === 'circle') {
			const center = el.getCenter?.();
			if (!center) return false;
			if (anchor === 'circle-center' && typeof el.setCenter === 'function') {
				el.setCenter(x, y);
			}
			else if (anchor === 'circle-radius' && typeof el.setRadius === 'function') {
				el.setRadius(Math.max(0.001, Math.hypot(x - center.x, y - center.y)));
			}
			else return false;
		}
		else if (anchor.startsWith('arc-') && el.name === 'arc' && typeof el.getStartMidEnd === 'function'
			&& typeof el.setStartMidEnd === 'function') {
			const { start, mid, end } = el.getStartMidEnd();
			if (anchor === 'arc-start' || anchor === 'arc-mid' || anchor === 'arc-end') {
				// KiCad's default KEEP_CENTER_ADJUST_ANGLE_RADIUS mode keeps the
				// center.  Midpoint drags change only radius, while endpoint drags
				// also adopt the cursor's angle for the dragged endpoint; the other
				// endpoint is resized to the same radius.
				if (typeof el.getArcCenterRadiusAngles !== 'function') return false;
				let geometry: { centerX: number; centerY: number; radius: number };
				try { geometry = el.getArcCenterRadiusAngles(false); }
				catch { return false; }
				const radius = Math.max(0.0254, Math.hypot(x - geometry.centerX, y - geometry.centerY));
				const scale = radius / Math.max(geometry.radius, 1e-9);
				const resize = (point: { x: number; y: number }) => ({
					x: geometry.centerX + (point.x - geometry.centerX) * scale,
					y: geometry.centerY + (point.y - geometry.centerY) * scale,
				});
				const cursorVector = { x: x - geometry.centerX, y: y - geometry.centerY };
				const cursorLength = Math.hypot(cursorVector.x, cursorVector.y);
				const cursorPoint = cursorLength > 1e-9
					? { x: geometry.centerX + cursorVector.x * radius / cursorLength, y: geometry.centerY + cursorVector.y * radius / cursorLength }
					: resize(anchor === 'arc-end' ? end : start);
				const nextStart = anchor === 'arc-start' ? cursorPoint : resize(start);
				const nextMid = resize(mid);
				const nextEnd = anchor === 'arc-end' ? cursorPoint : resize(end);
				el.setStartMidEnd(nextStart.x, nextStart.y, nextMid.x, nextMid.y, nextEnd.x, nextEnd.y);
			}
			else if (anchor === 'arc-center' && typeof el.getArcCenterRadiusAngles === 'function') {
				let geometry: { centerX: number; centerY: number };
				try { geometry = el.getArcCenterRadiusAngles(false); }
				catch { return false; }
				const dx = x - geometry.centerX;
				const dy = y - geometry.centerY;
				el.setStartMidEnd(start.x + dx, start.y + dy, mid.x + dx, mid.y + dy, end.x + dx, end.y + dy);
			}
			else return false;
		}
		else if (anchor.startsWith('bezier-') && el.name === 'bezier'
			&& typeof el.getPoints === 'function' && typeof el.setPoints === 'function') {
			const points = el.getPoints();
			if (!Array.isArray(points) || points.length !== 4) return false;
			const index = anchor === 'bezier-start' ? 0
				: anchor === 'bezier-control-1' ? 1
					: anchor === 'bezier-control-2' ? 2 : anchor === 'bezier-end' ? 3 : -1;
			if (index < 0) return false;
			const next = points.map((point: { x: number; y: number }, pointIndex: number) =>
				pointIndex === index ? { x, y } : { x: point.x, y: point.y });
			el.setPoints(next);
		}
		else if (anchor.startsWith('polygon-vertex-')) {
			const index = Number(anchor.slice('polygon-vertex-'.length));
			const polyline = el.name === 'rule_area' && typeof el.getPolyline === 'function' ? el.getPolyline() : el;
			if (!polyline || typeof polyline.getPoints !== 'function' || typeof polyline.setPoints !== 'function'
				|| !Number.isInteger(index)) return false;
			const points = polyline.getPoints();
			if (!Array.isArray(points) || index < 0 || index >= points.length) return false;
			const closedDuplicate = points.length > 1
				&& points[0]!.x === points[points.length - 1]!.x
				&& points[0]!.y === points[points.length - 1]!.y;
			polyline.setPoints(points.map((point: { x: number; y: number }, pointIndex: number) =>
				(pointIndex === index || (closedDuplicate && (
					(index === 0 && pointIndex === points.length - 1)
					|| (index === points.length - 1 && pointIndex === 0)
				)))
					? { x, y } : { x: point.x, y: point.y }));
		}
		else {
			return false;
		}
		this.commitAstMutation();
		return true;
	}

	/**
	 * Rename an existing label's text in place — local labels/graphics text
	 * have a plain settable `.value` (KicadElementTextBase), global/hier
	 * labels expose `.setName()` instead; dispatch on whichever the element
	 * actually has, same idiom translateElementById uses for geometry.
	 * Eligibility is checked before pushUndoSnapshot() so a no-op call
	 * (wrong id, wrong element type) never wastes an undo entry.
	 */
	renameLabel(id: string, newText: string): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const el: any = this.schScene?.hitTestItems.find(it => it.id === id)?.element;
		if (!el || (typeof el.setName !== 'function' && !('value' in el))) {
			return false;
		}
		this.pushUndoSnapshot();
		if (typeof el.setName === 'function') {
			el.setName(newText);
		}
		else {
			el.value = newText;
		}
		this.commitAstMutation();
		return true;
	}

	/** Change an existing global/hier label's shape after placement — the
	 *  shape is otherwise only settable via Tab-cycling *before* the first
	 *  placement click. */
	/** Shape vocabulary is generic on purpose — the implementation only ever
	 *  checks `typeof el.setShape === 'function'` and passes the value
	 *  through untyped, so this already worked for any label kind; the
	 *  union just needs to cover directive labels' different shape words
	 *  (dot/round/diamond/rectangle vs input/output/bidirectional/…) too. */
	setLabelShape(id: string, shape: KicadGlobalLabelShape | KicadDirectiveLabelShape): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const el: any = this.schScene?.hitTestItems.find(it => it.id === id)?.element;
		if (!el || typeof el.setShape !== 'function') {
			return false;
		}
		this.pushUndoSnapshot();
		el.setShape(shape);
		this.commitAstMutation();
		return true;
	}

	// ---- Rendering ----

	scheduleRender(): void {
		if (this.frameScheduled) {
			return;
		}
		this.frameScheduled = true;
		requestAnimationFrame(() => this.render());
	}

	/**
	 * World-space transform for this frame: camera.matrix, plus the flip
	 * mirror (around the camera's current center X, not world x=0, so
	 * flipping doesn't also shove the board off-center) when flipped.
	 */
	protected computeViewMatrix(): Matrix3 {
		let m = this.camera.matrix;
		if (this.flipped) {
			const cx = this.camera.center.x;
			m = m.multiply(Matrix3.translation(cx, 0))
				.multiply(Matrix3.scaling(-1, 1))
				.multiply(Matrix3.translation(-cx, 0));
		}
		return m;
	}

	/**
	 * Canvas2D path: replays the already-built scene every frame (cheap —
	 * native canvas primitives, no CPU tessellation). WebGL path:
	 * re-tessellates into GPU buffers ONLY when geometryDirty — pure
	 * pan/zoom/flip just updates the view-matrix uniform and redraws
	 * already-uploaded buffers, the entire point of using the GPU here.
	 */
	render(): void {
		this.frameScheduled = false;
		const renderer: Renderer = this.backend === 'webgl' && this.webglRenderer ? this.webglRenderer :
			this.canvas2dRenderer;
		const canvas = this.backend === 'webgl' && this.webglRenderer ? this.canvasGl! : this.canvas2d;

		const activeScene = this.activeScene;
		const backgroundColor = this.documentType === 'schematic' ? schematicBackgroundColor : boardBackgroundColor;
		renderer.clear?.(backgroundColor);
		if (!activeScene) {
			this.onRender?.(null);
			return;
		}

		try {
			const worldMatrix = this.computeViewMatrix();
			// Canvas2D draws directly in screen pixels (ctx.setTransform expects
			// that); WebGL needs an extra screen-pixels -> clip-space step baked
			// into the same matrix. Same world-space item geometry either way —
			// only this final projection step differs per backend.
			const viewMatrix = renderer === this.webglRenderer
				? Matrix3.orthographic(canvas.width, canvas.height).multiply(worldMatrix)
				: worldMatrix;
			renderer.setViewMatrix?.(viewMatrix);

			const highlighted = new Set<string>();
			for (const selId of this.selectedIds) {
				highlighted.add(selId);
				// Symbol hit boxes use id `symbol:<instanceUuid>` with an empty
				// normal draw — also highlight that instance's body/pin/field
				// paint items so selection is obvious on passives and ICs.
				if (this.documentType === 'schematic' && this.schScene && selId.startsWith('symbol:')) {
					const instanceId = selId.slice('symbol:'.length);
					for (const bucket of this.schScene.layerBuckets.values()) {
						for (const item of bucket) {
							if (
								item.id === `symbol:${ instanceId }`
								|| item.id.startsWith(`${ instanceId }:`)
								|| item.id.includes(`:${ instanceId }:`)
								|| item.id.endsWith(`:${ instanceId }`)
							) {
								highlighted.add(item.id);
							}
						}
					}
				}
			}
			const paintActive = (viewBBox?: { x: number; y: number; w: number; h: number }) => {
				if (this.documentType === 'schematic') {
					this.schematicPainter.paint(
						this.schScene!, renderer, this.schLayerState, highlighted, this.highlightedNetIds, viewBBox);
				}
				else {
					this.painter.paint(this.scene!, renderer, this.layerState, highlighted, viewBBox);
				}
			};

			if (renderer.beginStaticBuild) {
				if (this.geometryDirty) {
					renderer.beginStaticBuild();
					// No viewBBox — this pass tessellates once into GPU buffers
					// that then persist across pans/zooms, so it must capture
					// everything, not just what's on-screen right now.
					paintActive();
					renderer.endStaticBuild!();
					this.geometryDirty = false;
				}
				renderer.beginDynamicFrame!();
				this.drawGrid(renderer);
			}
			else {
				this.drawGrid(renderer);
				// Canvas2D redraws the whole scene every frame (see this
				// method's doc comment) — cull to the current viewport, grown
				// 20% so items just outside the edge don't pop in/out on pan.
				const viewBBox = this.camera.bbox.grow(this.camera.bbox.w * 0.2, this.camera.bbox.h * 0.2);
				paintActive(viewBBox);
			}
			// Always last — the hand-drawn editor's in-progress tool state draws
			// on top of everything else, for both backends.
			this.drawEditPreview(renderer);
			this.drawSelectionResizeHandles(renderer);
			this.drawSelectionCurveAnchors(renderer);
			renderer.flush?.();

			this.onRender?.(activeScene);
		}
		catch (err) {
			console.error('KicadRenderSession.render() failed', err);
			this.onError?.(err);
		}
	}

	// Procedural — the grid is camera state, not document data, so it is
	// recomputed every frame from the visible world rectangle. Drawn through
	// Renderer rather than a raw Canvas context so Canvas2D and WebGL agree.
	//
	// This deliberately mirrors KiCad GAL's dot-grid rules (see
	// common/gal/{cairo,opengl}/*_gal.cpp): retain the active grid until its
	// screen pitch falls to 10 px, then show every tenth point; distinguish
	// every tenth X/Y coordinate with a 2 px dimension. The old implementation
	// used an arbitrary 200-column cap and ×2 steps, which made the grid change
	// at unlike zoom levels and lost KiCad's major-dot rhythm.
	protected drawGrid(renderer: Renderer): void {
		const zoom = this.camera.zoom;
		// zoom<=0 / NaN → singular view matrix → bbox is NaN and Vec2 throws.
		// That used to abort render() after clear(), leaving a blank canvas.
		if (!Number.isFinite(zoom) || zoom <= 0) {
			return;
		}
		let bbox;
		try {
			bbox = this.camera.bbox;
		}
		catch {
			return;
		}
		if (![bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite) || bbox.w <= 0 || bbox.h <= 0) {
			return;
		}
		// KiCad schematic's default grid is 50 mil / 1.27 mm. Pcbnew's
		// default visible grid is 0.5 mm. Keep this active grid at all useful
		// zoom levels; only the *visible representation* becomes coarser.
		// gridSpacingMm (set via setGridSpacing) overrides the default so the
		// dots drawn here always match whatever the caller's own snap-to-grid
		// actually snaps to — the two were previously independent values
		// that only ever agreed by coincidence.
		const schematic = this.documentType === 'schematic';
		let spacing = this.gridSpacingMm ?? (schematic ? 1.27 : 0.5);
		const gridTick = 10;
		const minGridScreenSpacingPx = 10;
		while (spacing * zoom <= minGridScreenSpacingPx) {
			spacing *= gridTick;
		}
		// KiCad grid points are rectangles, not circles. Keep a 2×2-device-px
		// minor mark (rather than literal 1×1): a one-pixel WebGL quad can land
		// between raster pixels and disappear entirely. This is the same
		// screen-constant minimum used by the previous visible grid. Major dots
		// double only along the corresponding major coordinate.
		const minorDotScreenPx = 2;
		const minorDotWorld = minorDotScreenPx / zoom;
		if (!Number.isFinite(minorDotWorld) || minorDotWorld <= 0) {
			return;
		}
		const startX = Math.round(bbox.x / spacing) - 1;
		const endX = Math.round(bbox.x2 / spacing) + 1;
		const startY = Math.round(bbox.y / spacing) - 1;
		const endY = Math.round(bbox.y2 / spacing) + 1;
		// WebGL uses premultiplied-alpha blending. The very low-opacity KiCad
		// theme color that looked fine in the desktop renderer became almost
		// indistinguishable from this viewer's dark background, so use a muted
		// blue-gray with enough alpha to remain legible on the GPU canvas.
		const gridColor = 'rgba(185, 198, 214, 0.30)';
		renderer.beginBatch?.();
		for (let ix = startX; ix <= endX; ix++) {
			const width = minorDotWorld * (ix % gridTick === 0 ? 2 : 1);
			const x = ix * spacing;
			for (let iy = startY; iy <= endY; iy++) {
				const height = minorDotWorld * (iy % gridTick === 0 ? 2 : 1);
				const y = iy * spacing;
				renderer.rect(new Vec2(x - width / 2, y - height / 2), width, height, { fillColor: gridColor });
			}
		}
		renderer.endBatch?.();
	}

	/**
	 * Direct-draw the hand-drawn editor's in-progress tool state — mirrors
	 * drawGrid()'s idiom (procedural, computed fresh every frame, never part
	 * of the persisted scene). Called last in render(), so it always draws on
	 * top of the real document — correct for an "in-progress action" cue.
	 * Geometry matches the corresponding COMMITTED paint item exactly
	 * (junction radius, no-connect X span, arc curvature) so there's no visual
	 * jump when the tool commits; only the color changes.
	 */
	protected drawEditPreview(renderer: Renderer): void {
		const p = this.editPreview;
		if (!p) {
			return;
		}
		const color = EDIT_PREVIEW_COLOR;
		switch (p.kind) {
			case 'wire':
			case 'line':
				renderer.line([p.kind === 'wire' ? p.from : (p.anchor ?? p.cursor), p.cursor], { strokeColor: color, strokeWidth: 0.15 });
				if (p.kind === 'line' && !p.anchor) {
					drawCrosshair(renderer, p.cursor, color);
				}
				break;
			case 'junction':
				renderer.circle(p.cursor, 0.4, { fillColor: color });
				break;
			case 'no-connect': {
				const half = 0.9;
				renderer.line([new Vec2(p.cursor.x - half, p.cursor.y - half), new Vec2(p.cursor.x + half, p.cursor.y + half)], { strokeColor: color, strokeWidth: 0.3 });
				renderer.line([new Vec2(p.cursor.x - half, p.cursor.y + half), new Vec2(p.cursor.x + half, p.cursor.y - half)], { strokeColor: color, strokeWidth: 0.3 });
				break;
			}
			case 'rect': {
				if (!p.anchor) {
					drawCrosshair(renderer, p.cursor, color);
					break;
				}
				const corners = [
					new Vec2(p.anchor.x, p.anchor.y), new Vec2(p.cursor.x, p.anchor.y),
					new Vec2(p.cursor.x, p.cursor.y), new Vec2(p.anchor.x, p.cursor.y),
				];
				renderer.line([...corners, corners[0]!], { strokeColor: color, strokeWidth: 0.15 });
				break;
			}
			case 'circle': {
				if (!p.anchor) {
					drawCrosshair(renderer, p.cursor, color);
					break;
				}
				const radius = Math.hypot(p.cursor.x - p.anchor.x, p.cursor.y - p.anchor.y);
				renderer.circle(p.anchor, radius, { strokeColor: color, strokeWidth: 0.15 });
				break;
			}
			case 'arc': {
				if (p.points.length < 2) {
					// 0 or 1 points placed: nothing curved to show yet — a straight
					// rubber-band from whatever's placed (or just the cursor).
					const from = p.points[0] ?? p.cursor;
					renderer.line([from, p.cursor], { strokeColor: color, strokeWidth: 0.15 });
					if (p.points.length === 0) {
						drawCrosshair(renderer, p.cursor, color);
					}
					break;
				}
				// 2 points placed (start, end) — cursor is the mid-bulge. Reuse the
				// EXACT math the committed arc paint item uses (buildSchArc), via a
				// throwaway element, so the preview curve matches post-commit.
				const [start, end] = p.points;
				const probe = new KicadElementArc();
				probe.setStartMidEnd(start!.x, start!.y, p.cursor.x, p.cursor.y, end!.x, end!.y);
				try {
					const local = probe.getArcCenterRadiusAngles(false);
					renderer.arc(new Vec2(local.centerX, local.centerY), local.radius, local.startAngle, local.endAngle, { strokeColor: color, strokeWidth: 0.15 });
				}
				catch {
					// Collinear (start/mid/end) — no arc yet; show what's known.
					renderer.line([start!, end!], { strokeColor: color, strokeWidth: 0.15 });
				}
				break;
			}
			case 'text': {
				if (!p.text) {
					drawCrosshair(renderer, p.anchor, color);
					break;
				}
				// Anchor {0.5,0.5} matches a freshly-committed KicadElementText's
				// own default (addGraphicText never calls setJustify) — no jump
				// between the live preview and the post-commit render.
				const geometry = computeStrokeTextGeometry(p.text, p.anchor, 1.27, 0, false, 0.15, { x: 0.5, y: 0.5 });
				drawStrokeTextGeometry(renderer, geometry, color);
				break;
			}
			case 'bezier': {
				const points = [...p.points, p.cursor];
				if (points.length >= 2) {
					renderer.line(points, { strokeColor: color, strokeWidth: 0.1 });
				}
				if (points.length >= 4) {
					const curve = cubicBezierToPolyline(points[0]!, points[1]!, points[2]!, points[3]!);
					renderer.line(curve, { strokeColor: color, strokeWidth: 0.15 });
				}
				if (points.length < 2) {
					drawCrosshair(renderer, p.cursor, color);
				}
				break;
			}
			case 'rule-area': {
				const points = [...p.points, p.cursor];
				if (points.length > 1) {
					renderer.line([...points, points[0]!], { strokeColor: color, strokeWidth: 0.15 });
				}
				else {
					drawCrosshair(renderer, p.cursor, color);
				}
				break;
			}
			case 'text-box': {
				renderer.rect(new Vec2(p.x, p.y), p.width, p.height, { strokeColor: color, strokeWidth: 0.15 });
				if (p.text) {
					const geometry = computeStrokeTextGeometry(
						p.text, new Vec2(p.x, p.y), 1.27, 0, false, 0.15, { x: 0, y: 0 }
					);
					drawStrokeTextGeometry(renderer, geometry, color);
				}
				break;
			}
			case 'label': {
				if (!p.text) {
					drawCrosshair(renderer, p.anchor, color);
					break;
				}
				// Anchor matches addLabel's own setJustify(labelJustifyFor(rotation))
				// call — left-justified text reads {x:0,...}, right-justified {x:1,...}.
				const justify = KicadRenderSession.labelJustifyFor(p.rotation);
				const anchor = { x: justify === 'right' ? 1 : 0, y: 0.5 };
				const textAngle = (p.rotation === 90 || p.rotation === 270) ? 90 : 0;
				const geometry = computeStrokeTextGeometry(p.text, p.anchor, 1.27, textAngle, false, 0.15, anchor);
				drawStrokeTextGeometry(renderer, geometry, color);
				break;
			}
			case 'global-label':
			case 'hier-label': {
				if (!p.text) {
					drawCrosshair(renderer, p.anchor, color);
					break;
				}
				drawLabelFlagPreview(renderer, p.kind, p.anchor, p.text, p.shape, p.rotation, color);
				break;
			}
			// Crosshair-only — no live pole+glyph ghost (v1 scope cut; the
			// shape only matters once committed, same as 'text').
			case 'directive-label':
				drawCrosshair(renderer, p.anchor, color);
				break;
			case 'power':
				renderer.circle(p.cursor, 0.6, { strokeColor: color, strokeWidth: 0.2 });
				drawCrosshair(renderer, p.cursor, color);
				break;
			case 'selection-box': {
				const x0 = Math.min(p.origin.x, p.cursor.x);
				const y0 = Math.min(p.origin.y, p.cursor.y);
				const w = Math.abs(p.cursor.x - p.origin.x);
				const h = Math.abs(p.cursor.y - p.origin.y);
				const fillColor = p.selectMode === 'add' ? SELECTION_BOX_FILL_ADD
					: p.selectMode === 'subtract' ? SELECTION_BOX_FILL_SUBTRACT
						: SELECTION_BOX_FILL_REPLACE;
				const strokeColor = p.mode === 'contained' ? SELECTION_BOX_OUTLINE_CONTAINED : SELECTION_BOX_OUTLINE_TOUCHING;
				renderer.rect(new Vec2(x0, y0), w, h, { fillColor, strokeColor, strokeWidth: 0.15 });
				break;
			}
		}
	}

	/** KiCad-style 3×3 resize affordance for the two selected root shapes that
	 * have an axis-aligned editable box. Kept in the dynamic pass so handle
	 * size remains constant in screen pixels while zooming. */
	protected drawSelectionResizeHandles(renderer: Renderer): void {
		const box = this.getSelectionResizeBox();
		if (!box || !Number.isFinite(this.camera.zoom) || this.camera.zoom <= 0) {
			return;
		}
		const x2 = box.x + box.width;
		const y2 = box.y + box.height;
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		const color = '#ffcc00';
		const deviceScale = window.devicePixelRatio || 1;
		const lineWidth = deviceScale / this.camera.zoom;
		const size = 7 * deviceScale / this.camera.zoom;
		renderer.line([
			new Vec2(box.x, box.y), new Vec2(x2, box.y), new Vec2(x2, y2), new Vec2(box.x, y2), new Vec2(box.x, box.y),
		], { strokeColor: color, strokeWidth: lineWidth });
		for (const point of [
			new Vec2(box.x, box.y), new Vec2(cx, box.y), new Vec2(x2, box.y),
			new Vec2(box.x, cy), new Vec2(cx, cy), new Vec2(x2, cy),
			new Vec2(box.x, y2), new Vec2(cx, y2), new Vec2(x2, y2),
		]) {
			renderer.rect(new Vec2(point.x - size / 2, point.y - size / 2), size, size, {
				fillColor: color,
				strokeColor: schematicBackgroundColor,
				strokeWidth: lineWidth,
			});
		}
	}

	/** Mirrors KiCad's EDA_CIRCLE_POINT_EDIT_BEHAVIOR (center + radius) and
	 * EDA_ARC_POINT_EDIT_BEHAVIOR (start/mid/end/center plus radial guides). */
	protected drawSelectionCurveAnchors(renderer: Renderer): void {
		const curve = this.getSelectionCurveAnchors();
		if (!curve || !Number.isFinite(this.camera.zoom) || this.camera.zoom <= 0) {
			return;
		}
		const color = '#ffcc00';
		const deviceScale = window.devicePixelRatio || 1;
		const lineWidth = deviceScale / this.camera.zoom;
		const size = 7 * deviceScale / this.camera.zoom;
		const byKind = new Map(curve.anchors.map(anchor => [anchor.kind, new Vec2(anchor.x, anchor.y)]));
		if (curve.kind === 'arc') {
			const center = byKind.get('arc-center')!;
			const start = byKind.get('arc-start')!;
			const end = byKind.get('arc-end')!;
			renderer.line([center, start], { strokeColor: color, strokeWidth: lineWidth });
			renderer.line([center, end], { strokeColor: color, strokeWidth: lineWidth });
		}
		else if (curve.kind === 'bezier') {
			const start = byKind.get('bezier-start')!;
			const control1 = byKind.get('bezier-control-1')!;
			const control2 = byKind.get('bezier-control-2')!;
			const end = byKind.get('bezier-end')!;
			renderer.line([start, control1], { strokeColor: color, strokeWidth: lineWidth });
			renderer.line([control2, end], { strokeColor: color, strokeWidth: lineWidth });
		}
		else if (curve.kind === 'polygon' && curve.anchors.length > 1) {
			const points = curve.anchors
				.slice()
				.sort((a, b) => Number(a.kind.slice('polygon-vertex-'.length)) - Number(b.kind.slice('polygon-vertex-'.length)))
				.map(anchor => new Vec2(anchor.x, anchor.y));
			renderer.line([...points, points[0]!], { strokeColor: color, strokeWidth: lineWidth });
		}
		for (const point of byKind.values()) {
			renderer.rect(new Vec2(point.x - size / 2, point.y - size / 2), size, size, {
				fillColor: color,
				strokeColor: schematicBackgroundColor,
				strokeWidth: lineWidth,
			});
		}
	}
}

// ---- Auto-junction geometry (junctionNeededAt) ----

/** 0.001mm — matches the precision real schematic coordinates actually
 *  carry; generous enough to absorb float noise, tight enough to never
 *  merge two genuinely distinct points. */
const JUNCTION_POINT_EPS = 1e-3;

/** Pins/labels contribute a "this is a distinct thing" exit angle that has
 *  no real geometric direction — offset far outside any real angle's range
 *  ([0, 2π)) so it can never collide with (and get de-duped against) an
 *  actual wire direction, mirroring real KiCad's own uniqueAngle counter. */
const SYNTHETIC_ANGLE_BASE = 1000;

function pointsNear(ax: number, ay: number, bx: number, by: number): boolean {
	return Math.abs(ax - bx) < JUNCTION_POINT_EPS && Math.abs(ay - by) < JUNCTION_POINT_EPS;
}

/** Quantized so two truly-collinear directions compare equal (Set dedup) —
 *  a straight 2-wire chain/extension must NOT look like 2 distinct exits. */
function quantizedAngle(fromX: number, fromY: number, toX: number, toY: number): number {
	const raw = Math.atan2(toY - fromY, toX - fromX);
	const normalized = ((raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
	return Math.round(normalized * 100000) / 100000;
}

/** True only for a STRICTLY interior point — an actual endpoint is handled
 *  separately by the caller (an "ender" contributes one exit angle, a
 *  mid-segment hit contributes two — see junctionNeededAt's doc comment). */
function pointLiesOnSegmentInterior(px: number, py: number, x1: number, y1: number, x2: number, y2: number): boolean {
	const dx = x2 - x1, dy = y2 - y1;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq < JUNCTION_POINT_EPS * JUNCTION_POINT_EPS) {
		return false;
	}
	const t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
	if (t <= JUNCTION_POINT_EPS || t >= 1 - JUNCTION_POINT_EPS) {
		return false;
	}
	const projX = x1 + t * dx, projY = y1 + t * dy;
	return Math.hypot(px - projX, py - projY) < JUNCTION_POINT_EPS;
}

/** Semi-transparent white reads as a "ghost" preview over any real element
 *  color underneath, without colliding with schColors' saturated palette. */
const EDIT_PREVIEW_COLOR = 'rgba(255, 255, 255, 0.6)';

/** Real KiCad's own drag-select box colors (dark color scheme), ported from
 *  common/preview_items/selection_area.cpp's 0-1 float RGB — confirmed
 *  against the user's local KiCad checkout, not guessed. Hardcoded UI-
 *  overlay colors like EDIT_PREVIEW_COLOR above, not a theme-file value, so
 *  these belong here rather than in SchematicColors.ts's schColors. Fills
 *  need rgba() rather than hex: the WebGL renderer's color parser gives hex
 *  strings no alpha channel (see WebGLRenderer's parseColorUncached), and
 *  these carry real KiCad's own 0.3 fill alpha. */
const SELECTION_BOX_FILL_REPLACE = 'rgba(77, 77, 179, 0.3)';   // rgb(0.3,0.3,0.7) - no modifier
const SELECTION_BOX_FILL_ADD = 'rgba(77, 179, 77, 0.3)';       // rgb(0.3,0.7,0.3) - shift and/or ctrl
const SELECTION_BOX_FILL_SUBTRACT = 'rgba(179, 77, 77, 0.3)';  // rgb(0.7,0.3,0.3) - ctrl+shift
const SELECTION_BOX_OUTLINE_CONTAINED = '#ffff66';             // rgb(1.0,1.0,0.4) - drag left-to-right
const SELECTION_BOX_OUTLINE_TOUCHING = '#6666ff';              // rgb(0.4,0.4,1.0) - drag right-to-left

function cubicBezierToPolyline(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, steps = 32): Vec2[] {
	const points: Vec2[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		points.push(new Vec2(
			u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
			u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
		));
	}
	return points;
}

function drawCrosshair(renderer: Renderer, at: Vec2, color: string): void {
	const s = 0.5;
	renderer.line([new Vec2(at.x - s, at.y), new Vec2(at.x + s, at.y)], { strokeColor: color, strokeWidth: 0.1 });
	renderer.line([new Vec2(at.x, at.y - s), new Vec2(at.x, at.y + s)], { strokeColor: color, strokeWidth: 0.1 });
}

function rotatePreviewPoint(p: { x: number; y: number }, rotationDeg: number): Vec2 {
	const rad = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(rad), sin = Math.sin(rad);
	return new Vec2(p.x * cos + p.y * sin, -p.x * sin + p.y * cos);
}

/**
 * Live preview for the global/hier label tools — flag/arrow outline (exact
 * same point arrays SchematicPainter's buildGlobalLabel/buildHierLabelShape
 * use for the committed render, since those are simple fixed-size polygons)
 * plus the typed text at a fixed, un-tuned offset. Deliberately NOT byte-
 * identical to the committed text placement (which uses an empirically-tuned
 * offset formula documented in SchematicPainter.ts) — a preview only needs
 * to convey shape/direction before commit, not pixel-perfect final position.
 */
function drawLabelFlagPreview(
	renderer: Renderer, kind: 'global-label' | 'hier-label', worldOrigin: Vec2, text: string,
	shape: KicadGlobalLabelShape, rotation: number, color: string
): void {
	const textSize = 1.27;
	const s = textSize;
	let pts: { x: number; y: number }[];
	let shapeRotation = rotation;
	if (kind === 'global-label') {
		const half = s / 2;
		const len = s * 2;
		pts = [{ x: 0, y: 0 }, { x: 0, y: -half }, { x: -len, y: -half }, { x: -len, y: half }, { x: 0, y: half }, { x: 0, y: 0 }];
		if (shape === 'input' || shape === 'bidirectional' || shape === 'tri_state') {
			pts[0]!.x += half; pts[5]!.x += half;
		}
		if (shape === 'output' || shape === 'bidirectional' || shape === 'tri_state') {
			pts[2]!.x -= half; pts[3]!.x -= half;
		}
		shapeRotation = rotation + 180;
	}
	else {
		switch (shape) {
			case 'output':
				pts = [{ x: 0, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 }, { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }];
				break;
			case 'input':
				pts = [{ x: s, y: s / 2 }, { x: s / 2, y: s / 2 }, { x: 0, y: 0 }, { x: s / 2, y: -s / 2 }, { x: s, y: -s / 2 }, { x: s, y: s / 2 }];
				break;
			case 'bidirectional':
			case 'tri_state':
				pts = [{ x: s / 2, y: s / 2 }, { x: s, y: 0 }, { x: s / 2, y: -s / 2 }, { x: 0, y: 0 }, { x: s / 2, y: s / 2 }];
				break;
			default: // passive
				pts = [{ x: 0, y: s / 2 }, { x: s, y: s / 2 }, { x: s, y: -s / 2 }, { x: 0, y: -s / 2 }, { x: 0, y: s / 2 }];
				break;
		}
	}
	const worldPts = pts.map((p) => {
		const rotated = rotatePreviewPoint(p, shapeRotation);
		return new Vec2(rotated.x + worldOrigin.x, rotated.y + worldOrigin.y);
	});
	renderer.line(worldPts, { strokeColor: color, strokeWidth: 0.15 });

	const dist = s * 2.5;
	let textOffset: Vec2;
	switch (rotation) {
		case 90: textOffset = new Vec2(0, -dist); break;
		case 180: textOffset = new Vec2(-dist, 0); break;
		case 270: textOffset = new Vec2(0, dist); break;
		default: textOffset = new Vec2(dist, 0); break;
	}
	const worldTextPos = new Vec2(worldOrigin.x + textOffset.x, worldOrigin.y + textOffset.y);
	const textAngle = (rotation === 90 || rotation === 270) ? 90 : 0;
	const hAlign = rotation === 180 ? 1 : 0;
	const geometry = computeStrokeTextGeometry(text, worldTextPos, textSize, textAngle, false, 0.15, { x: hAlign, y: 0.5 });
	drawStrokeTextGeometry(renderer, geometry, color);
}
