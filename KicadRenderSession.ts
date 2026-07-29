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

	/** Geometric hit-test (against source data, not pixels) at a screen
	 * position — returns the same shape the demo's click handler reports. */
	hitTestAtScreen(screenPos: Vec2): HitResult | null {
		const worldPos = this.screenToWorld(screenPos);
		// Branched (rather than reading a shared union-typed variable) so
		// each hitTest() call sees a concretely-typed array — a union of
		// two array types doesn't let TS infer hitTest<T>'s T cleanly.
		const hit = this.documentType === 'schematic'
			? (this.schScene ? hitTest(this.schScene.hitTestItems, worldPos.x, worldPos.y) : null)
			: (this.scene ? hitTest(this.scene.hitTestItems, worldPos.x, worldPos.y) : null);
		if (!hit) {
			return null;
		}
		// refDesignator only exists on SchPaintedItem (kind:'symbol'), not on
		// the board's PaintedItem — 'kind' in hit narrows which one we have.
		const refDesignator = 'refDesignator' in hit ? hit.refDesignator : undefined;
		return { id: hit.id, kind: hit.kind, layer: hit.layer, refDesignator };
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
		const hit = hitTest(symbols, worldPos.x, worldPos.y);
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

		this.fitSchematicContent();
		this.scheduleRender();

		return { parseMs, buildMs, layersPresent: this.schScene.layersPresent };
	}

	/**
	 * Move (and optionally rotate) a placed symbol instance by its Reference
	 * designator, then rebuild just the paint scene from the already-parsed
	 * document (no text re-parse) and re-render. This is what makes editor
	 * drag/rotate cheap enough to call on every frame — no server round trip,
	 * no re-parsing, just mutate the AST node and re-run the paint pass.
	 * Returns false if no symbol with that reference is in the loaded doc.
	 */
	moveSymbolByRef(reference: string, x: number, y: number, rotation?: number): boolean {
		if (this.documentType !== 'schematic' || !this.schematicRoot) {
			return false;
		}
		const instance = this.schematicPainter.findSymbolInstanceByReference(this.schematicRoot, reference);
		if (!instance || typeof instance.setOrigin !== 'function') {
			return false;
		}
		const current = typeof instance.getOrigin === 'function' ? instance.getOrigin() : { rotation: 0 };
		instance.setOrigin(x, y, rotation ?? current.rotation ?? 0);

		this.schScene = this.schematicPainter.build(this.schematicRoot, this.schematicDocInfo);
		this.schLayerState = defaultSchLayerState(this.schScene.layersPresent);
		this.geometryDirty = true;
		this.scheduleRender();
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
			renderer.flush?.();

			this.onRender?.(activeScene);
		}
		catch (err) {
			console.error('KicadRenderSession.render() failed', err);
			this.onError?.(err);
		}
	}

	// Procedural — dots at a fixed world-space spacing across whatever the
	// camera currently sees. Not document data, so it's recomputed cheaply
	// every frame directly from the camera bbox rather than being part of
	// the scene. Drawn through the Renderer interface (not raw ctx) so it
	// works identically on both backends.
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
		// Coarsen spacing as you zoom out so the grid doesn't turn into
		// visual noise (and doesn't force thousands of dot draws) at low zoom.
		// Schematic: KiCad 50 mil (1.27 mm) — same as Circuit Design edit snap /
		// FINE_GRID_MM. Board keeps 1 mm with coarser *5 steps.
		const schematic = this.documentType === 'schematic';
		let spacing = schematic ? 1.27 : 1;
		const coarsen = schematic ? 2 : 5;
		let guard = 0;
		while ((bbox.w / spacing) > 200 && guard++ < 32) {
			spacing *= coarsen;
		}
		const r = 0.15 / zoom;
		if (!Number.isFinite(r) || r <= 0) {
			return;
		}
		const startX = Math.floor(bbox.x / spacing) * spacing;
		const startY = Math.floor(bbox.y / spacing) * spacing;
		renderer.beginBatch?.();
		// Squares, not circles: a grid dot is a handful of pixels on
		// screen, so a smooth circle is wasted precision — but more
		// importantly, this loop can run up to ~200x200=40,000 times, and
		// circle() tessellates a real N-gon (trig + several vertices) per
		// call on the WebGL backend. A rect() is 2 triangles with no trig
		// at all, and looks identical at this size.
		let dots = 0;
		const maxDots = 40_000;
		for (let x = startX; x <= bbox.x2 && dots < maxDots; x += spacing) {
			for (let y = startY; y <= bbox.y2 && dots < maxDots; y += spacing) {
				renderer.rect(new Vec2(x - r, y - r), r * 2, r * 2, { fillColor: 'rgba(233, 230, 222, 0.15)' });
				dots++;
			}
		}
		renderer.endBatch?.();
	}
}
