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
import { KicadElementText, KicadElementTextBox, KicadElementLabel } from '@kicad-io/KicadElementText';
import { KicadElementGlobalLabel, type KicadGlobalLabelShape } from '@kicad-io/KicadElementGlobalLabel';
import { KicadElementHierarchicalLabel, type KicadHierarchicalLabelShape } from '@kicad-io/KicadElementHierarchicalLabel';
import { KicadElementNetclassFlag, type KicadDirectiveLabelShape } from '@kicad-io/KicadElementNetclassFlag';
import { KicadElementSymbol }          from '@kicad-io/KicadElementSymbol';
import { KicadElementLibSymbols }      from '@kicad-io/KicadElementLibSymbols';
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
	SchematicScene, SchLayerVisibilityState, SchematicSheetRef, SchematicDocInfo
}                                      from './paint/SchematicPainter';
import { boardBackgroundColor }      from './paint/LayerColors';
import { schematicBackgroundColor }  from './paint/SchematicColors';
import { hitTest }                     from './paint/HitTest';
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
	| { kind: 'power'; cursor: Vec2 };

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
	protected selectedId: string | null = null;
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

	get selection(): string | null {
		return this.selectedId;
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

	select(id: string | null): void {
		this.selectedId = id;
		// Highlight color is baked per-vertex at build time on WebGL — see
		// setLayerVisible()'s comment.
		this.geometryDirty = true;
		this.scheduleRender();
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
		this.selectedId = null;

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

		const t1 = performance.now();
		this.schScene = this.schematicPainter.build(schematicRoot, docInfo);
		const buildMs = performance.now() - t1;
		this.schLayerState = defaultSchLayerState(this.schScene.layersPresent);
		this.geometryDirty = true;
		this.selectedId = null;

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
	private commitAstMutation(): void {
		if (!this.schematicRoot) {
			return;
		}
		this.schScene = this.schematicPainter.build(this.schematicRoot, this.schematicDocInfo);
		this.schLayerState = defaultSchLayerState(this.schScene.layersPresent);
		this.geometryDirty = true;
		this.scheduleRender();
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
	moveSymbolByRef(reference: string, x: number, y: number, rotation?: number): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const instance = this.schematicPainter.findSymbolInstanceByReference(this.schematicRoot, reference);
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
	}): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const instance: any = this.schematicPainter.findSymbolInstanceByReference(this.schematicRoot, reference);
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
	 * Move a global/local/hierarchical label by paint-item id (e.g. `"uuid:flag"` or
	 * `"uuid"`). Label net name is unchanged — only the attach point moves.
	 */
	moveLabelById(paintId: string, x: number, y: number, rotation?: number): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const items = this.schScene?.hitTestItems ?? [];
		const item = items.find(it => it.id === paintId || it.id.startsWith(`${paintId}:`));
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

	getSymbolPose(reference: string): SymbolPoseInfo | null {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return null;
		}
		const instance = this.schematicPainter.findSymbolInstanceByReference(this.schematicRoot, reference);
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
	 *  (wire + 0-2 auto-junctions, still one undo step). */
	private attachElement(el: { setUuid(u?: string): void }): void {
		el.setUuid();
		this.schematicRoot!.rootElement.addChild(el);
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

	getSelectionResizeBox(): SelectionResizeBox | null {
		if (this.documentType !== 'schematic' || !this.selectedId || !this.schScene) {
			return null;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === this.selectedId);
		const el: any = item?.element;
		if (!item || !el || (el.name !== 'rectangle' && el.name !== 'text_box' && el.name !== 'image')
			|| item.shape.type !== 'rect') {
			return null;
		}
		const { x, y, w, h } = item.bbox;
		return w > 0 && h > 0 ? { id: item.id, x, y, width: w, height: h } : null;
	}

	getSelectionCurveAnchors(): SelectionCurveAnchors | null {
		if (this.documentType !== 'schematic' || !this.selectedId || !this.schScene) {
			return null;
		}
		const item = this.schScene.hitTestItems.find(it => it.id === this.selectedId);
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
			if (this.selectedId === id) {
				this.selectedId = null;
			}
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
		if (!el) {
			return false;
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
		this.commitAstMutation();
		return true;
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
			if (this.selectedId) {
				highlighted.add(this.selectedId);
				// Symbol hit boxes use id `symbol:<instanceUuid>` with an empty
				// normal draw — also highlight that instance's body/pin/field
				// paint items so selection is obvious on passives and ICs.
				if (this.documentType === 'schematic' && this.schScene && this.selectedId.startsWith('symbol:')) {
					const instanceId = this.selectedId.slice('symbol:'.length);
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
			const paintActive = () => {
				if (this.documentType === 'schematic') {
					this.schematicPainter.paint(this.schScene!, renderer, this.schLayerState, highlighted);
				}
				else {
					this.painter.paint(this.scene!, renderer, this.layerState, highlighted);
				}
			};

			if (renderer.beginStaticBuild) {
				if (this.geometryDirty) {
					renderer.beginStaticBuild();
					paintActive();
					renderer.endStaticBuild!();
					this.geometryDirty = false;
				}
				renderer.beginDynamicFrame!();
				this.drawGrid(renderer);
			}
			else {
				this.drawGrid(renderer);
				paintActive();
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
		const schematic = this.documentType === 'schematic';
		let spacing = schematic ? 1.27 : 0.5;
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
